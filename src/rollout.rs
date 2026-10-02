//! M6 staged rollout of agent releases.
//!
//! A rollout targets one version and a fixed node selection, chosen at
//! creation: all enrolled nodes not being deleted, or an explicit list, cut
//! to `percentage` and split into cumulative `waves`, both in a
//! deterministic order (SHA-256 of the rollout's seed and the node id, see
//! `assign_waves`). Rows live in `rollout_nodes` (migration 0021).
//!
//! Node states: pending -> offered (an UpdateOffer went out on its stream)
//! -> updating (Hello with the target version) -> healthy (an ok Ack on that
//! stream: `on_converged`). failed: the agent reported REJECTED / FAILED /
//! ROLLED_BACK, or no health within `health_timeout_secs` of the first
//! offer. skipped: never offerable (agent protocol < 3, no artifact for its
//! platform, offline for the whole timeout after its wave started, node
//! being deleted). A node already at/above the target is healthy at once.
//!
//! Rollout states: running -> paused (admin; no new offers) -> running;
//! running -> halted (system: failed / (healthy + failed) > ratio) ->
//! aborted (admin); running -> completed (system: all waves terminal). The
//! next wave starts once every node of the current one is terminal. At most
//! one open (running/paused/halted) rollout exists (unique index).
//!
//! Every transition is audited in its own transaction: admin actions with
//! the admin, tick transitions (wave, halt, complete) with actor `system`.
//! `tick` runs in the reaper loop on every instance; the advisory lock
//! `akari.rollout` serializes it with the admin actions.

use crate::auth::{bad_request, conflict};
use std::cmp::Ordering;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;
use crate::updates::{compare_versions, parse_version, MIN_UPDATE_PROTOCOL};

pub const DEFAULT_HEALTH_TIMEOUT_SECS: i32 = 600;
pub const DEFAULT_MAX_FAILURE_RATIO: f64 = 0.2;
const OPEN: &str = "('running','paused','halted')";

/// Serializes rollout state changes (admin actions, ticks, release
/// deletion) across instances. Transaction-scoped.
pub async fn lock(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('akari.rollout', 0))")
        .execute(conn)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Wave selection (pure)
// ---------------------------------------------------------------------------

/// Validates cumulative wave percentages: 1..=10 entries, strictly
/// ascending in 1..=100, ending at 100.
pub fn check_waves(waves: &[i32]) -> Result<(), String> {
    if waves.is_empty() || waves.len() > 10 {
        return Err("waves: 1 to 10 entries".into());
    }
    let mut prev = 0;
    for &w in waves {
        if w <= prev || w > 100 {
            return Err("waves: cumulative percentages, strictly ascending, 1..=100".into());
        }
        prev = w;
    }
    if prev != 100 {
        return Err("waves: the last wave must be 100".into());
    }
    Ok(())
}

fn ceil_pct(n: usize, pct: i32) -> usize {
    (n * pct.clamp(0, 100) as usize).div_ceil(100)
}

/// Deterministic selection: nodes ordered by SHA-256(seed BE ‖ node id),
/// the first `percentage`% (rounded up, at least one) kept, each assigned
/// to the first wave whose cumulative share (rounded up) covers its
/// position. Returns (node, wave, position) in order.
pub fn assign_waves(
    seed: i64,
    nodes: &[Uuid],
    percentage: i32,
    waves: &[i32],
) -> Vec<(Uuid, i32, i32)> {
    let mut keyed: Vec<([u8; 32], Uuid)> = nodes
        .iter()
        .map(|n| {
            let mut h = Sha256::new();
            h.update(seed.to_be_bytes());
            h.update(n.as_bytes());
            (h.finalize().into(), *n)
        })
        .collect();
    keyed.sort();
    keyed.dedup_by(|a, b| a.1 == b.1);
    if keyed.is_empty() {
        return Vec::new();
    }
    let target = ceil_pct(keyed.len(), percentage).max(1);
    let bounds: Vec<usize> = waves.iter().map(|w| ceil_pct(target, *w)).collect();
    keyed
        .into_iter()
        .take(target)
        .enumerate()
        .map(|(pos, (_, n))| {
            let wave = bounds
                .iter()
                .position(|b| pos < *b)
                .unwrap_or(bounds.len() - 1);
            (n, wave as i32, pos as i32)
        })
        .collect()
}

/// Halt rule: some failure and failed / (healthy + failed) > ratio.
pub fn should_halt(healthy: i64, failed: i64, ratio: f64) -> bool {
    failed > 0 && (failed as f64) / ((healthy + failed) as f64) > ratio
}

/// Whether an agent running `running` needs the `target` release: a newer
/// version; for an explicitly signed rollback release any other version.
/// Never for a build without a release version (the agent would refuse).
pub fn update_due(running: &str, target: &str, rollback: bool) -> bool {
    match compare_versions(running, target) {
        Some(Ordering::Less) => true,
        Some(Ordering::Greater) => rollback,
        _ => false,
    }
}

/// What a pending node of an active wave becomes now (None = stays
/// pending until it is offered).
#[derive(Debug, PartialEq, Eq)]
pub enum PendingOutcome {
    Healthy(String),
    Skipped(String),
}

pub struct PendingNode<'a> {
    pub online: bool,
    pub deleting: bool,
    pub protocol: Option<i32>,
    pub agent_version: Option<&'a str>,
    pub platform: Option<(&'a str, &'a str)>,
    pub has_artifact: bool,
    /// The target release is a signed rollback target.
    pub rollback: bool,
    /// The node's wave started more than the health timeout ago.
    pub wave_timed_out: bool,
}

pub fn classify_pending(target: &str, n: &PendingNode) -> Option<PendingOutcome> {
    if n.deleting {
        return Some(PendingOutcome::Skipped("node being deleted".into()));
    }
    if let Some(v) = n.agent_version {
        if !update_due(v, target, n.rollback) && parse_version(v).is_some() {
            return Some(PendingOutcome::Healthy(format!("already at {v}")));
        }
    }
    if n.online {
        if let Some(p) = n.protocol.filter(|p| *p < MIN_UPDATE_PROTOCOL as i32) {
            return Some(PendingOutcome::Skipped(format!(
                "agent protocol {p} < {MIN_UPDATE_PROTOCOL}: update this node by hand"
            )));
        }
        if let Some(v) = n.agent_version.filter(|v| parse_version(v).is_none()) {
            return Some(PendingOutcome::Skipped(format!(
                "agent version {v:?} is not a release version (development build)"
            )));
        }
        if let Some((os, arch)) = n.platform {
            if !n.has_artifact {
                return Some(PendingOutcome::Skipped(format!("no {os}/{arch} artifact")));
            }
        }
    }
    if n.wave_timed_out && !n.online {
        return Some(PendingOutcome::Skipped(
            "offline for the whole health timeout".into(),
        ));
    }
    None
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRolloutReq {
    pub version: String,
    /// Share of the selection to update (1..=100). Default 100.
    pub percentage: Option<i32>,
    /// Explicit node selection (default: every enrolled node).
    pub node_ids: Option<Vec<Uuid>>,
    /// Cumulative wave percentages. Default [100].
    pub waves: Option<Vec<i32>>,
    pub health_timeout_secs: Option<i32>,
    pub max_failure_ratio: Option<f64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct RolloutView {
    id: Uuid,
    version: String,
    status: String,
    waves: Vec<i32>,
    percentage: i32,
    explicit_nodes: bool,
    current_wave: i32,
    wave_started_at: DateTime<Utc>,
    health_timeout_secs: i32,
    max_failure_ratio: f64,
    halted_reason: Option<String>,
    created_by: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    /// Node count per status.
    counts: serde_json::Value,
}

const ROLLOUT_VIEW_SQL: &str = "SELECT r.id, r.version, r.status, r.waves, r.percentage, \
     r.explicit_nodes, r.current_wave, r.wave_started_at, r.health_timeout_secs, \
     r.max_failure_ratio, r.halted_reason, r.created_by, r.created_at, r.updated_at, \
     r.finished_at, COALESCE((SELECT jsonb_object_agg(s, c) FROM (SELECT status AS s, \
     count(*) AS c FROM rollout_nodes WHERE rollout_id = r.id GROUP BY status) x), '{}') AS counts \
     FROM rollouts r";

#[derive(Serialize, sqlx::FromRow)]
pub struct RolloutNodeView {
    node_id: Uuid,
    name: String,
    wave: i32,
    position: i32,
    status: String,
    from_version: Option<String>,
    agent_version: Option<String>,
    offered_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    detail: Option<String>,
}

#[derive(Serialize)]
pub struct RolloutDetail {
    #[serde(flatten)]
    rollout: RolloutView,
    nodes: Vec<RolloutNodeView>,
}

async fn rollout_view(conn: &mut PgConnection, id: Uuid) -> Result<RolloutView, ApiError> {
    sqlx::query_as::<_, RolloutView>(sqlx::AssertSqlSafe(format!(
        "{ROLLOUT_VIEW_SQL} WHERE r.id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or_else(ApiError::not_found)
}

pub async fn list_rollouts(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<RolloutView>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, RolloutView>(sqlx::AssertSqlSafe(format!(
        "{ROLLOUT_VIEW_SQL} ORDER BY r.created_at DESC LIMIT 100"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

pub async fn get_rollout(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<RolloutDetail>, ApiError> {
    user.require_admin()?;
    let mut conn = state.pg().acquire().await?;
    let rollout = rollout_view(&mut conn, id).await?;
    let nodes = sqlx::query_as::<_, RolloutNodeView>(
        "SELECT rn.node_id, n.name, rn.wave, rn.position, rn.status, rn.from_version, \
         n.agent_version, rn.offered_at, rn.finished_at, rn.detail \
         FROM rollout_nodes rn JOIN nodes n ON n.id = rn.node_id \
         WHERE rn.rollout_id = $1 ORDER BY rn.position",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Json(RolloutDetail { rollout, nodes }))
}

/// POST /rollouts.
pub async fn apply_create_rollout(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &CreateRolloutReq,
) -> Result<Uuid, ApiError> {
    if crate::updates::parse_version(&req.version).is_none() {
        return Err(bad_request!(
            "rollout.version_invalid",
            "version: vMAJOR.MINOR.PATCH[-pre]"
        ));
    }
    let percentage = req.percentage.unwrap_or(100);
    if !(1..=100).contains(&percentage) {
        return Err(bad_request!(
            "rollout.percentage_range",
            "percentage: 1..=100"
        ));
    }
    let waves = req.waves.clone().unwrap_or_else(|| vec![100]);
    check_waves(&waves)
        .map_err(|e| bad_request!("rollout.waves_invalid", "{detail}", detail = e))?;
    let timeout = req
        .health_timeout_secs
        .unwrap_or(DEFAULT_HEALTH_TIMEOUT_SECS);
    if !(30..=86400).contains(&timeout) {
        return Err(bad_request!(
            "rollout.timeout_range",
            "health_timeout_secs: 30..=86400"
        ));
    }
    let ratio = req.max_failure_ratio.unwrap_or(DEFAULT_MAX_FAILURE_RATIO);
    if !(0.0..=1.0).contains(&ratio) {
        return Err(bad_request!(
            "rollout.failure_ratio_range",
            "max_failure_ratio: 0..=1"
        ));
    }
    lock(conn).await?;
    let have: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_releases WHERE version = $1 AND complete_at IS NOT NULL",
    )
    .bind(&req.version)
    .fetch_one(&mut *conn)
    .await?;
    if have == 0 {
        return Err(bad_request!(
            "rollout.no_release",
            "no uploaded release with this version (POST /agent-releases, then PUT its binary)"
        ));
    }
    let open: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT EXISTS (SELECT 1 FROM rollouts WHERE status IN {OPEN})"
    )))
    .fetch_one(&mut *conn)
    .await?;
    if open {
        return Err(conflict!(
            "rollout.another_open",
            "another rollout is open: finish or abort it first"
        ));
    }
    let eligible: Vec<Uuid> = match &req.node_ids {
        Some(ids) => {
            let mut ids = ids.clone();
            ids.sort();
            ids.dedup();
            let found: Vec<Uuid> = sqlx::query_scalar(
                "SELECT id FROM nodes WHERE id = ANY($1) AND deleting_at IS NULL \
                 AND cert_serial IS NOT NULL ORDER BY id",
            )
            .bind(&ids)
            .fetch_all(&mut *conn)
            .await?;
            if found.len() != ids.len() {
                return Err(bad_request!(
                    "rollout.bad_node",
                    "node_ids: unknown, unenrolled or deleting node"
                ));
            }
            found
        }
        None => {
            sqlx::query_scalar(
                "SELECT id FROM nodes WHERE deleting_at IS NULL AND cert_serial IS NOT NULL \
                 ORDER BY id",
            )
            .fetch_all(&mut *conn)
            .await?
        }
    };
    if eligible.is_empty() {
        return Err(bad_request!(
            "rollout.no_nodes",
            "no enrolled node to update"
        ));
    }
    let id = Uuid::new_v4();
    let seed: i64 = rand::random();
    let plan = assign_waves(seed, &eligible, percentage, &waves);
    sqlx::query(
        "INSERT INTO rollouts (id, version, status, waves, percentage, explicit_nodes, \
         health_timeout_secs, max_failure_ratio, seed, created_by) \
         VALUES ($1, $2, 'running', $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(id)
    .bind(&req.version)
    .bind(&waves)
    .bind(percentage)
    .bind(req.node_ids.is_some())
    .bind(timeout)
    .bind(ratio)
    .bind(seed)
    .bind(&actor.login)
    .execute(&mut *conn)
    .await?;
    let (nodes, wv, pos): (Vec<Uuid>, Vec<i32>, Vec<i32>) = plan.iter().fold(
        (Vec::new(), Vec::new(), Vec::new()),
        |(mut a, mut b, mut c), (n, w, p)| {
            a.push(*n);
            b.push(*w);
            c.push(*p);
            (a, b, c)
        },
    );
    sqlx::query(
        "INSERT INTO rollout_nodes (rollout_id, node_id, wave, position, from_version) \
         SELECT $1, x.n, x.w, x.p, nd.agent_version \
         FROM unnest($2::uuid[], $3::int[], $4::int[]) AS x(n, w, p) JOIN nodes nd ON nd.id = x.n",
    )
    .bind(id)
    .bind(&nodes)
    .bind(&wv)
    .bind(&pos)
    .execute(&mut *conn)
    .await?;
    wake_wave(conn, id, 0).await?;
    crate::audit::record(
        conn,
        actor,
        "rollout.create",
        "rollout",
        Some(id.to_string()),
        None,
        Some(json!({
            "version": req.version, "percentage": percentage, "waves": waves,
            "explicit_nodes": req.node_ids.is_some(), "nodes": nodes.len(),
            "health_timeout_secs": timeout, "max_failure_ratio": ratio,
        })),
    )
    .await?;
    Ok(id)
}

/// Wakes the sessions of a wave's pending nodes (on every instance) so they
/// get their offer now rather than at their next reconcile tick.
async fn wake_wave(conn: &mut PgConnection, id: Uuid, wave: i32) -> sqlx::Result<()> {
    sqlx::query(
        "SELECT pg_notify('akari_change', node_id::text) FROM rollout_nodes \
         WHERE rollout_id = $1 AND wave <= $2 AND status IN ('pending','offered')",
    )
    .bind(id)
    .bind(wave)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn create_rollout(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateRolloutReq>,
) -> Result<(StatusCode, Json<RolloutView>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let id = apply_create_rollout(&mut tx, &Actor::of(&user), &req).await?;
    let view = rollout_view(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(view)))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Pause,
    Resume,
    Abort,
}

impl Action {
    fn name(self) -> &'static str {
        match self {
            Action::Pause => "pause",
            Action::Resume => "resume",
            Action::Abort => "abort",
        }
    }
}

/// Admin transition: pause (running), resume (paused), abort (any open).
pub async fn apply_action(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    action: Action,
) -> Result<(), ApiError> {
    lock(conn).await?;
    let status: Option<(String, i32)> =
        sqlx::query_as("SELECT status, current_wave FROM rollouts WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((status, wave)) = status else {
        return Err(ApiError::not_found());
    };
    let next = match (action, status.as_str()) {
        (Action::Pause, "running") => "paused",
        (Action::Resume, "paused") => "running",
        (Action::Abort, "running" | "paused" | "halted") => "aborted",
        _ => {
            return Err(conflict!(
                "rollout.bad_transition",
                "cannot {action} a {status} rollout",
                action = action.name(),
                status = status.clone()
            ))
        }
    };
    sqlx::query(
        "UPDATE rollouts SET status = $2, updated_at = now(), \
         finished_at = CASE WHEN $2 = 'aborted' THEN now() ELSE finished_at END WHERE id = $1",
    )
    .bind(id)
    .bind(next)
    .execute(&mut *conn)
    .await?;
    if next == "running" {
        wake_wave(conn, id, wave).await?;
    }
    crate::audit::record(
        conn,
        actor,
        &format!("rollout.{}", action.name()),
        "rollout",
        Some(id.to_string()),
        Some(json!({ "status": status })),
        Some(json!({ "status": next })),
    )
    .await?;
    Ok(())
}

async fn action(
    state: AppState,
    user: AuthUser,
    id: Uuid,
    a: Action,
) -> Result<Json<RolloutView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_action(&mut tx, &Actor::of(&user), id, a).await?;
    let view = rollout_view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(view))
}

pub async fn pause_rollout(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<RolloutView>, ApiError> {
    action(state, user, id, Action::Pause).await
}

pub async fn resume_rollout(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<RolloutView>, ApiError> {
    action(state, user, id, Action::Resume).await
}

pub async fn abort_rollout(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<RolloutView>, ApiError> {
    action(state, user, id, Action::Abort).await
}

// ---------------------------------------------------------------------------
// Tick (reaper loop, any instance)
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct PendingRow {
    node_id: Uuid,
    online: bool,
    deleting: bool,
    agent_protocol: Option<i32>,
    agent_version: Option<String>,
    agent_os: Option<String>,
    agent_arch: Option<String>,
    has_artifact: bool,
    rollback: bool,
    wave_timed_out: bool,
}

/// A node counts as online if a session refreshed it this recently.
const ONLINE_FRESH_SECS: f64 = 90.0;

/// Advances every running rollout one step. Each rollout in its own
/// transaction.
pub async fn tick(pg: &sqlx::PgPool) -> anyhow::Result<()> {
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM rollouts WHERE status = 'running'")
        .fetch_all(pg)
        .await?;
    for id in ids {
        let mut tx = pg.begin().await?;
        tick_one(&mut tx, id).await?;
        tx.commit().await?;
    }
    Ok(())
}

pub async fn tick_one(conn: &mut PgConnection, id: Uuid) -> anyhow::Result<()> {
    lock(conn).await?;
    type R = (String, String, Vec<i32>, i32, i32, f64);
    let row: Option<R> = sqlx::query_as(
        "SELECT status, version, waves, current_wave, health_timeout_secs, max_failure_ratio \
         FROM rollouts WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((status, version, waves, wave, timeout, ratio)) = row else {
        return Ok(());
    };
    if status != "running" {
        return Ok(());
    }
    // 1. Offered nodes past the health timeout fail.
    sqlx::query(
        "UPDATE rollout_nodes SET status = 'failed', finished_at = now(), \
         detail = 'no healthy reconnect with the new version within ' || $2 || ' s' \
         WHERE rollout_id = $1 AND status IN ('offered','updating') \
         AND offered_at < now() - make_interval(secs => $2)",
    )
    .bind(id)
    .bind(timeout as f64)
    .execute(&mut *conn)
    .await?;
    // 2. Pending nodes of active waves that can be settled without an offer.
    let pending: Vec<PendingRow> = sqlx::query_as(
        "SELECT rn.node_id, \
           (n.status = 'online' AND n.last_seen_at > now() - make_interval(secs => $4)) AS online, \
           n.deleting_at IS NOT NULL AS deleting, n.agent_protocol, n.agent_version, \
           n.agent_os, n.agent_arch, \
           EXISTS (SELECT 1 FROM agent_releases a WHERE a.version = $2 AND a.os = n.agent_os \
                   AND a.arch = n.agent_arch AND a.complete_at IS NOT NULL) AS has_artifact, \
           EXISTS (SELECT 1 FROM agent_releases a WHERE a.version = $2 AND a.rollback) AS rollback, \
           (SELECT wave_started_at FROM rollouts WHERE id = $1) < now() - make_interval(secs => $3) \
             AS wave_timed_out \
         FROM rollout_nodes rn JOIN nodes n ON n.id = rn.node_id \
         WHERE rn.rollout_id = $1 AND rn.status = 'pending' AND rn.wave <= $5",
    )
    .bind(id)
    .bind(&version)
    .bind(timeout as f64)
    .bind(ONLINE_FRESH_SECS)
    .bind(wave)
    .fetch_all(&mut *conn)
    .await?;
    for p in &pending {
        let platform = p.agent_os.as_deref().zip(p.agent_arch.as_deref());
        let out = classify_pending(
            &version,
            &PendingNode {
                online: p.online,
                deleting: p.deleting,
                protocol: p.agent_protocol,
                agent_version: p.agent_version.as_deref(),
                platform,
                has_artifact: p.has_artifact,
                rollback: p.rollback,
                wave_timed_out: p.wave_timed_out,
            },
        );
        let (st, detail) = match out {
            None => continue,
            Some(PendingOutcome::Healthy(d)) => ("healthy", d),
            Some(PendingOutcome::Skipped(d)) => ("skipped", d),
        };
        sqlx::query(
            "UPDATE rollout_nodes SET status = $3, detail = $4, finished_at = now() \
             WHERE rollout_id = $1 AND node_id = $2 AND status = 'pending'",
        )
        .bind(id)
        .bind(p.node_id)
        .bind(st)
        .bind(detail)
        .execute(&mut *conn)
        .await?;
    }
    // 3. Halt on too many failures.
    let (healthy, failed, open_in_wave): (i64, i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE status = 'healthy'), \
                count(*) FILTER (WHERE status = 'failed'), \
                count(*) FILTER (WHERE wave <= $2 AND status IN ('pending','offered','updating')) \
         FROM rollout_nodes WHERE rollout_id = $1",
    )
    .bind(id)
    .bind(wave)
    .fetch_one(&mut *conn)
    .await?;
    let system = Actor::system();
    if should_halt(healthy, failed, ratio) {
        let reason = format!(
            "{failed} failed / {} finished > max_failure_ratio {ratio}",
            healthy + failed
        );
        sqlx::query(
            "UPDATE rollouts SET status = 'halted', halted_reason = $2, updated_at = now() \
             WHERE id = $1",
        )
        .bind(id)
        .bind(&reason)
        .execute(&mut *conn)
        .await?;
        tracing::warn!(rollout = %id, %reason, "rollout halted");
        crate::audit::record(
            conn,
            &system,
            "rollout.halt",
            "rollout",
            Some(id.to_string()),
            Some(json!({ "status": "running" })),
            Some(json!({ "status": "halted", "reason": reason })),
        )
        .await?;
        return Ok(());
    }
    // 4. Next wave / completion.
    if open_in_wave > 0 {
        return Ok(());
    }
    if (wave as usize) + 1 < waves.len() {
        sqlx::query(
            "UPDATE rollouts SET current_wave = current_wave + 1, wave_started_at = now(), \
             updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .execute(&mut *conn)
        .await?;
        wake_wave(conn, id, wave + 1).await?;
        tracing::info!(rollout = %id, wave = wave + 1, "rollout wave started");
        crate::audit::record(
            conn,
            &system,
            "rollout.wave",
            "rollout",
            Some(id.to_string()),
            Some(json!({ "wave": wave })),
            Some(json!({ "wave": wave + 1, "healthy": healthy, "failed": failed })),
        )
        .await?;
    } else {
        sqlx::query(
            "UPDATE rollouts SET status = 'completed', finished_at = now(), updated_at = now() \
             WHERE id = $1",
        )
        .bind(id)
        .execute(&mut *conn)
        .await?;
        tracing::info!(rollout = %id, healthy, failed, "rollout completed");
        crate::audit::record(
            conn,
            &system,
            "rollout.complete",
            "rollout",
            Some(id.to_string()),
            Some(json!({ "status": "running" })),
            Some(json!({ "status": "completed", "healthy": healthy, "failed": failed })),
        )
        .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Session hooks (grpc.rs)
// ---------------------------------------------------------------------------

/// The offer for this node, if its wave of a running rollout is active, it
/// is pending/offered, its agent speaks protocol >= 3 and runs an older
/// version, and a complete release exists for its platform. Marks the row
/// offered (the health timeout runs from the FIRST offer).
pub async fn offer_for(
    pg: &sqlx::PgPool,
    node: Uuid,
    protocol: u32,
    agent_version: &str,
    platform: (&str, &str),
) -> sqlx::Result<Option<crate::pb::UpdateOffer>> {
    if protocol < MIN_UPDATE_PROTOCOL {
        return Ok(None);
    }
    type R = (Uuid, String, Vec<u8>, serde_json::Value, bool);
    let row: Option<R> = sqlx::query_as(
        "SELECT r.id, r.version, a.manifest, a.signatures, a.rollback \
         FROM rollout_nodes rn JOIN rollouts r ON r.id = rn.rollout_id \
         JOIN agent_releases a ON a.version = r.version AND a.os = $2 AND a.arch = $3 \
              AND a.complete_at IS NOT NULL \
         WHERE rn.node_id = $1 AND r.status = 'running' AND rn.wave <= r.current_wave \
           AND rn.status IN ('pending','offered')",
    )
    .bind(node)
    .bind(platform.0)
    .bind(platform.1)
    .fetch_optional(pg)
    .await?;
    let Some((rollout, version, manifest, sigs, rollback)) = row else {
        return Ok(None);
    };
    if !update_due(agent_version, &version, rollback) {
        // Already there (or unversioned build): the tick settles it.
        return Ok(None);
    }
    let sigs: Vec<crate::updates::Signature> = serde_json::from_value(sigs).unwrap_or_default();
    sqlx::query(
        "UPDATE rollout_nodes SET status = 'offered', offered_at = COALESCE(offered_at, now()), \
         detail = 'offered' WHERE rollout_id = $1 AND node_id = $2 AND status IN ('pending','offered')",
    )
    .bind(rollout)
    .bind(node)
    .execute(pg)
    .await?;
    Ok(Some(crate::updates::offer(rollout, manifest, &sigs)))
}

/// Hello with `version`: an offered node of an open rollout targeting it is
/// now updating. Returns whether this stream should report health
/// (`on_converged`).
pub async fn on_hello(pg: &sqlx::PgPool, node: Uuid, version: &str) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "WITH u AS (UPDATE rollout_nodes rn SET status = 'updating', \
           detail = 'reconnected with ' || $2 \
         FROM rollouts r WHERE r.id = rn.rollout_id AND r.status IN {OPEN} \
           AND rn.node_id = $1 AND r.version = $2 AND rn.status IN ('offered','updating') \
         RETURNING 1) SELECT count(*) FROM u"
    )))
    .bind(node)
    .bind(version)
    .fetch_one(pg)
    .await?;
    Ok(n > 0)
}

/// An ok Ack on a stream whose Hello carried `version`: healthy.
pub async fn on_converged(pg: &sqlx::PgPool, node: Uuid, version: &str) -> sqlx::Result<bool> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE rollout_nodes rn SET status = 'healthy', finished_at = now(), \
           detail = 'healthy on ' || $2 \
         FROM rollouts r WHERE r.id = rn.rollout_id AND r.status IN {OPEN} \
           AND rn.node_id = $1 AND r.version = $2 AND rn.status IN ('offered','updating')"
    )))
    .bind(node)
    .bind(version)
    .execute(pg)
    .await?;
    Ok(r.rows_affected() > 0)
}

/// An UpdateStatus from the agent.
pub async fn on_status(
    pg: &sqlx::PgPool,
    node: Uuid,
    s: &crate::pb::UpdateStatus,
) -> sqlx::Result<()> {
    use crate::pb::update_status::State;
    let Ok(rollout) = Uuid::parse_str(&s.rollout_id) else {
        return Ok(());
    };
    let state = State::try_from(s.state).unwrap_or(State::Unspecified);
    let err: String = s.error.chars().take(512).collect();
    let (terminal, label, from): (bool, &str, &str) = match state {
        State::Rejected => (true, "rejected", "('pending','offered','updating')"),
        State::Failed => (true, "failed", "('pending','offered','updating')"),
        // The node really runs the old binary again, whatever we concluded.
        State::RolledBack => (
            true,
            "rolled back",
            "('pending','offered','updating','healthy')",
        ),
        State::Downloading => (false, "downloading", "('offered')"),
        State::Restarting => (false, "restarting into the new version", "('offered')"),
        State::Confirmed => (false, "self-check passed", "('updating','healthy')"),
        State::Unspecified => return Ok(()),
    };
    let detail = if err.is_empty() {
        format!("{label} ({})", s.version)
    } else {
        format!("{label} ({}): {err}{}", s.version, failure_hint(&err))
    };
    let set = if terminal {
        "status = 'failed', finished_at = now(), "
    } else {
        ""
    };
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE rollout_nodes rn SET {set} detail = $3 FROM rollouts r \
         WHERE r.id = rn.rollout_id AND rn.rollout_id = $1 AND rn.node_id = $2 \
           AND r.version = $4 AND r.status IN {OPEN} AND rn.status IN {from}"
    )))
    .bind(rollout)
    .bind(node)
    .bind(detail)
    .bind(&s.version)
    .execute(pg)
    .await?;
    if terminal {
        tracing::warn!(node = %node, rollout = %rollout, version = %s.version, state = label, error = %err, "agent update failed");
    }
    Ok(())
}

/// W18: what the admin can do about a failed update (shown in the rollout
/// and node views).
pub(crate) fn failure_hint(err: &str) -> &'static str {
    if err.contains("updater unit missing") || err.contains("did not pick up the request") {
        " — 节点缺少更新服务（akari-agent-update）：请在节点上重新运行一次安装命令（重装命令）"
    } else if err.contains("permission denied") && err.contains("switch to") {
        " — 旧版 agent 无法在 systemd 257 及以上（如 Debian 13）执行暂存的新版本：请在节点上重新运行一次安装命令（重装命令），之后即可自动更新"
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// W18: failures the admin fixes with one reinstall say so.
    #[test]
    fn failure_hints_name_the_reinstall() {
        for e in [
            "updater unit missing (akari-agent-update.path): run the panel's install command (重装命令) once on this node",
            "switch to v0.4.0: the updater did not pick up the request (is akari-agent-update.path enabled? ...)",
            "switch to v0.4.0: permission denied",
        ] {
            assert!(failure_hint(e).contains("重装命令"), "{e}");
        }
        assert_eq!(failure_hint("download: sha256 mismatch"), "");
        assert_eq!(failure_hint("open x: permission denied"), "");
    }

    fn ids(n: usize) -> Vec<Uuid> {
        (0..n).map(|i| Uuid::from_u128(i as u128 + 1)).collect()
    }

    #[test]
    fn waves_are_deterministic_and_cumulative() {
        let nodes = ids(100);
        let a = assign_waves(42, &nodes, 100, &[10, 50, 100]);
        let mut shuffled = nodes.clone();
        shuffled.reverse();
        assert_eq!(
            a,
            assign_waves(42, &shuffled, 100, &[10, 50, 100]),
            "input order matters"
        );
        assert_ne!(
            a.iter().map(|x| x.0).collect::<Vec<_>>(),
            assign_waves(43, &nodes, 100, &[10, 50, 100])
                .iter()
                .map(|x| x.0)
                .collect::<Vec<_>>(),
            "seed ignored"
        );
        let per_wave = |w: i32| a.iter().filter(|x| x.1 == w).count();
        assert_eq!((per_wave(0), per_wave(1), per_wave(2)), (10, 40, 50));
        // Waves are prefixes of the order.
        assert!(a
            .windows(2)
            .all(|p| p[0].1 <= p[1].1 && p[0].2 + 1 == p[1].2));
        // Percentage: a prefix of the same order.
        let p30 = assign_waves(42, &nodes, 30, &[100]);
        assert_eq!(p30.len(), 30);
        assert!(p30.iter().zip(&a).all(|(x, y)| x.0 == y.0));
        // Rounding up: 3 nodes at 10% -> one node, first wave non-empty.
        let small = assign_waves(7, &ids(3), 10, &[50, 100]);
        assert_eq!(small.len(), 1);
        assert_eq!(small[0].1, 0);
        assert!(assign_waves(1, &[], 100, &[100]).is_empty());
    }

    #[test]
    fn wave_validation() {
        assert!(check_waves(&[100]).is_ok());
        assert!(check_waves(&[1, 10, 100]).is_ok());
        for bad in [
            &[][..],
            &[50],
            &[50, 50, 100],
            &[60, 40, 100],
            &[0, 100],
            &[100, 101],
        ] {
            assert!(check_waves(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn halt_rule() {
        assert!(!should_halt(10, 0, 0.0));
        assert!(should_halt(10, 1, 0.0));
        assert!(!should_halt(8, 2, 0.2));
        assert!(should_halt(7, 3, 0.2));
        assert!(should_halt(0, 1, 0.99));
        assert!(!should_halt(0, 1, 1.0));
    }

    #[test]
    fn pending_classification() {
        let base = PendingNode {
            online: true,
            deleting: false,
            protocol: Some(3),
            agent_version: Some("v1.0.0"),
            platform: Some(("linux", "amd64")),
            has_artifact: true,
            rollback: false,
            wave_timed_out: false,
        };
        assert!(update_due("v1.0.0", "v1.1.0", false));
        assert!(!update_due("v1.2.0", "v1.1.0", false));
        assert!(update_due("v1.2.0", "v1.1.0", true));
        assert!(!update_due("v1.1.0", "v1.1.0", true));
        assert!(!update_due("dev", "v1.1.0", false));
        let newer = PendingNode {
            agent_version: Some("v1.2.0"),
            rollback: true,
            ..base
        };
        assert_eq!(
            classify_pending("v1.1.0", &newer),
            None,
            "rollback target is due"
        );
        let dev = PendingNode {
            agent_version: Some("dev"),
            ..base
        };
        assert!(matches!(
            classify_pending("v1.1.0", &dev),
            Some(PendingOutcome::Skipped(_))
        ));
        assert_eq!(classify_pending("v1.1.0", &base), None);
        let at = PendingNode {
            agent_version: Some("v1.1.0"),
            ..base
        };
        assert!(matches!(
            classify_pending("v1.1.0", &at),
            Some(PendingOutcome::Healthy(_))
        ));
        let old = PendingNode {
            protocol: Some(2),
            agent_version: Some("v1.0.0"),
            ..at
        };
        assert!(
            matches!(classify_pending("v1.1.0", &old), Some(PendingOutcome::Skipped(d)) if d.contains("protocol 2"))
        );
        let noart = PendingNode {
            protocol: Some(3),
            has_artifact: false,
            ..old
        };
        assert!(matches!(
            classify_pending("v1.1.0", &noart),
            Some(PendingOutcome::Skipped(_))
        ));
        let off = PendingNode {
            online: false,
            has_artifact: true,
            ..noart
        };
        assert_eq!(classify_pending("v1.1.0", &off), None);
        let off_long = PendingNode {
            wave_timed_out: true,
            ..off
        };
        assert!(matches!(
            classify_pending("v1.1.0", &off_long),
            Some(PendingOutcome::Skipped(_))
        ));
        let del = PendingNode {
            deleting: true,
            ..base
        };
        assert!(matches!(
            classify_pending("v1.1.0", &del),
            Some(PendingOutcome::Skipped(_))
        ));
    }
}

#[cfg(test)]
mod db_tests {
    use super::*;
    use crate::pb::update_status::State as UState;
    use crate::state::AppState;
    use crate::testdb::http::{rand_ip, Client};
    use crate::testdb::TestDb;
    use crate::updates::testkit::Signer;

    async fn admin_client(state: &AppState, db: &TestDb) -> Client {
        let id = db.admin().await;
        let (role, sv): (String, i64) =
            sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
                .bind(id)
                .fetch_one(state.pg())
                .await
                .unwrap();
        let mut c = Client::new(state, rand_ip());
        c.cookie =
            Some(crate::auth::issue_token(state, id, &role, sv, crate::auth::Stage::Full).unwrap());
        c
    }

    /// An enrolled, online node running `version` at `protocol`.
    async fn agent_node(db: &TestDb, version: &str, protocol: i32) -> Uuid {
        let id = db.node().await;
        sqlx::query(
            "UPDATE nodes SET cert_serial = $2, status = 'online', last_seen_at = now(), \
             agent_version = $3, agent_protocol = $4, agent_os = 'linux', agent_arch = 'amd64' \
             WHERE id = $1",
        )
        .bind(id)
        .bind(format!("{:x}", id.as_u128()))
        .bind(version)
        .bind(protocol)
        .execute(&db.pool)
        .await
        .unwrap();
        id
    }

    /// Registers + uploads a release through the HTTP API.
    async fn upload(c: &Client, p: &str, signer: &Signer, version: &str, bin: &[u8]) -> Uuid {
        let req = signer.release(version, bin);
        let r = c
            .post(
                &format!("/{p}/api/v1/agent-releases"),
                json!({ "manifest": req.manifest, "sig": req.sig }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
        let id: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
        let r = c
            .put_raw(
                &format!("/{p}/api/v1/agent-releases/{id}/binary"),
                bin.to_vec(),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
        assert_eq!(r.json()["complete"], true);
        id
    }

    async fn create(db: &TestDb, req: CreateRolloutReq) -> Result<Uuid, ApiError> {
        let mut tx = db.pool.begin().await.unwrap();
        let r = apply_create_rollout(&mut tx, &Actor::test(), &req).await;
        if r.is_ok() {
            tx.commit().await.unwrap();
        }
        r
    }

    fn req(version: &str) -> CreateRolloutReq {
        CreateRolloutReq {
            version: version.into(),
            percentage: None,
            node_ids: None,
            waves: None,
            health_timeout_secs: None,
            max_failure_ratio: None,
        }
    }

    async fn tick_db(db: &TestDb, id: Uuid) {
        let mut tx = db.pool.begin().await.unwrap();
        tick_one(&mut tx, id).await.unwrap();
        tx.commit().await.unwrap();
    }

    async fn node_status(db: &TestDb, id: Uuid, node: Uuid) -> String {
        sqlx::query_scalar(
            "SELECT status FROM rollout_nodes WHERE rollout_id = $1 AND node_id = $2",
        )
        .bind(id)
        .bind(node)
        .fetch_one(&db.pool)
        .await
        .unwrap()
    }

    async fn status(db: &TestDb, id: Uuid) -> String {
        sqlx::query_scalar("SELECT status FROM rollouts WHERE id = $1")
            .bind(id)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    }

    async fn audits(db: &TestDb, action: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = $1")
            .bind(action)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    }

    fn ustatus(rollout: Uuid, version: &str, s: UState) -> crate::pb::UpdateStatus {
        crate::pb::UpdateStatus {
            rollout_id: rollout.to_string(),
            version: version.into(),
            state: s as i32,
            error: "boom".into(),
        }
    }

    /// Upload (verified, audited) -> rollout -> offer -> updating ->
    /// healthy -> completed; protocol < 3 never offered; downloads refused
    /// for wrong digests.
    #[tokio::test]
    async fn release_rollout_happy_path() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let signer = Signer::new();
        let line = signer.config_line();
        let state =
            AppState::for_test_with(db.pool.clone(), |c| c.updates.release_keys = vec![line]).await;
        let c = admin_client(&state, &db).await;
        let bin = vec![7u8; crate::updates::CHUNK + 100]; // two chunks
                                                          // Unsigned / wrongly signed / mismatching binary refused.
        let other = Signer::new();
        let bad = other.release("v1.1.0", &bin);
        let r = c
            .post(
                "/test/api/v1/agent-releases",
                json!({ "manifest": bad.manifest, "sig": bad.sig }),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        let good = signer.release("v1.1.0", &bin);
        let r = c
            .post(
                "/test/api/v1/agent-releases",
                json!({ "manifest": good.manifest, "sig": good.sig }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED);
        let rel: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
        let mut wrong = bin.clone();
        wrong[5] ^= 1;
        let r = c
            .put_raw(&format!("/test/api/v1/agent-releases/{rel}/binary"), wrong)
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{:?}", r.json());
        let chunks: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_release_chunks")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(chunks, 0, "a refused upload left chunks");
        // A rollout needs a complete release.
        assert_eq!(
            create(&db, req("v1.1.0")).await.unwrap_err().status(),
            StatusCode::BAD_REQUEST
        );
        let r = c
            .put_raw(
                &format!("/test/api/v1/agent-releases/{rel}/binary"),
                bin.clone(),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
        assert_eq!(audits(&db, "agent_release.create").await, 1);
        assert_eq!(audits(&db, "agent_release.upload").await, 1);

        let n3 = agent_node(&db, "v1.0.0", 3).await;
        let n2 = agent_node(&db, "v1.0.0", 2).await;
        let r = c
            .post(
                "/test/api/v1/rollouts",
                json!({ "version": "v1.1.0", "health_timeout_secs": 60 }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
        let id: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
        // One open rollout at a time.
        assert_eq!(
            create(&db, req("v1.1.0")).await.unwrap_err().status(),
            StatusCode::CONFLICT
        );
        // The release cannot go while the rollout is open.
        let r = c
            .req(
                axum::http::Method::DELETE,
                &format!("/test/api/v1/agent-releases/{rel}"),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::CONFLICT);

        // protocol 2: never offered, skipped by the tick.
        assert!(offer_for(&db.pool, n2, 2, "v1.0.0", ("linux", "amd64"))
            .await
            .unwrap()
            .is_none());
        // Wrong platform: no artifact, no offer.
        assert!(offer_for(&db.pool, n3, 3, "v1.0.0", ("linux", "arm64"))
            .await
            .unwrap()
            .is_none());
        let o = offer_for(&db.pool, n3, 3, "v1.0.0", ("linux", "amd64"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(o.rollout_id, id.to_string());
        assert_eq!(o.panel_protocol, crate::updates::PANEL_PROTOCOL);
        let m = crate::updates::parse_manifest(&o.manifest).unwrap();
        assert_eq!(m.version, "v1.1.0");
        assert_eq!(node_status(&db, id, n3).await, "offered");
        tick_db(&db, id).await;
        assert_eq!(node_status(&db, id, n2).await, "skipped");
        assert_eq!(status(&db, id).await, "running");

        // Comes back with the new version, acks: healthy.
        assert!(on_hello(&db.pool, n3, "v1.1.0").await.unwrap());
        assert_eq!(node_status(&db, id, n3).await, "updating");
        assert!(on_converged(&db.pool, n3, "v1.1.0").await.unwrap());
        assert_eq!(node_status(&db, id, n3).await, "healthy");
        tick_db(&db, id).await;
        assert_eq!(status(&db, id).await, "completed");
        assert_eq!(audits(&db, "rollout.create").await, 1);
        assert_eq!(audits(&db, "rollout.complete").await, 1);
        // Completed: no more offers; the node view shows the outcome.
        assert!(offer_for(&db.pool, n3, 3, "v1.0.0", ("linux", "amd64"))
            .await
            .unwrap()
            .is_none());
        let nodes = c.get("/test/api/v1/nodes").await.json();
        let v = nodes
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == n3.to_string())
            .unwrap();
        assert_eq!(v["update_status"]["status"], "healthy");
        assert_eq!(v["agent_arch"], "amd64");
        let detail = c.get(&format!("/test/api/v1/rollouts/{id}")).await.json();
        assert_eq!(detail["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(detail["counts"]["healthy"], 1);
        db.drop().await;
    }

    /// W23: after a reinstall (a new enrollment), the node's entry in a
    /// finished rollout is history (`superseded`), not its current state;
    /// an open rollout's entry never is.
    #[tokio::test]
    async fn update_status_superseded_by_reinstall() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let c = admin_client(&state, &db).await;
        let n = agent_node(&db, "v1.0.0", 6).await;
        let r = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO rollouts (id, version, status, waves, percentage, explicit_nodes, \
               health_timeout_secs, max_failure_ratio, seed, created_by, created_at) \
             VALUES ($1, 'v1.1.0', 'halted', '{100}', 100, false, 600, 0, 1, 'test', \
               now() - interval '2 hours')",
        )
        .bind(r)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO rollout_nodes (rollout_id, node_id, wave, position, status, offered_at, \
               finished_at, detail) \
             VALUES ($1, $2, 0, 0, 'failed', now() - interval '2 hours', \
               now() - interval '2 hours', 'failed (v1.1.0): switch to v1.1.0: permission denied')",
        )
        .bind(r)
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
        async fn view(c: &Client, n: Uuid) -> serde_json::Value {
            let pick = |all: serde_json::Value| {
                all.as_array()
                    .unwrap()
                    .iter()
                    .find(|x| x["id"] == n.to_string())
                    .unwrap()["update_status"]
                    .clone()
            };
            let full = pick(c.get("/test/api/v1/nodes").await.json());
            let summary = pick(c.get("/test/api/v1/nodes?view=summary").await.json());
            assert_eq!(full, summary);
            full
        }
        let v = view(&c, n).await;
        assert_eq!(
            (v["status"].as_str(), v["superseded"].as_bool()),
            (Some("failed"), Some(false))
        );
        // Reinstalled while the rollout is still open: still its state.
        sqlx::query("UPDATE nodes SET enrolled_at = now() - interval '1 hour' WHERE id = $1")
            .bind(n)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(view(&c, n).await["superseded"], false);
        // The rollout is aborted: the failure predates the reinstall.
        sqlx::query("UPDATE rollouts SET status = 'aborted', finished_at = now() WHERE id = $1")
            .bind(r)
            .execute(&db.pool)
            .await
            .unwrap();
        let v = view(&c, n).await;
        assert_eq!(
            (v["status"].as_str(), v["superseded"].as_bool()),
            (Some("failed"), Some(true))
        );
        // An entry newer than the enrollment is the node's state.
        sqlx::query(
            "UPDATE rollout_nodes SET finished_at = now() - interval '1 minute' WHERE node_id = $1",
        )
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
        assert_eq!(view(&c, n).await["superseded"], false);
        db.drop().await;
    }

    /// The download RPC over real mTLS: whole, resumed, wrong digest, no
    /// certificate.
    #[tokio::test]
    async fn fetch_artifact_over_mtls() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let signer = Signer::new();
        let line = signer.config_line();
        let h = crate::testdb::fake_agent::PanelHarness::start_with(&db, |c| {
            c.updates.release_keys = vec![line]
        })
        .await;
        let c = admin_client(&h.state, &db).await;
        let bin: Vec<u8> = (0..(2 * crate::updates::CHUNK + 17))
            .map(|i| (i % 251) as u8)
            .collect();
        upload(&c, h.state.route_prefix(), &signer, "v2.0.0", &bin).await;
        let sha = hex::encode(Sha256::digest(&bin));
        let node = db.node().await;
        let creds = h.register(&db, node).await;
        assert_eq!(h.fetch(Some(&creds), &sha, 0).await.unwrap(), bin);
        let off = crate::updates::CHUNK as u64 + 5;
        assert_eq!(
            h.fetch(Some(&creds), &sha, off).await.unwrap(),
            bin[off as usize..]
        );
        let missing = hex::encode(Sha256::digest(b"nope"));
        assert_eq!(
            h.fetch(Some(&creds), &missing, 0).await.unwrap_err().code(),
            tonic::Code::NotFound
        );
        assert_eq!(
            h.fetch(Some(&creds), &sha, bin.len() as u64 + 1)
                .await
                .unwrap_err()
                .code(),
            tonic::Code::InvalidArgument
        );
        assert_eq!(
            h.fetch(None, &sha, 0).await.unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
        h.stop().await;
        db.drop().await;
    }

    /// The session sends the offer to a protocol-3 agent (and not to a
    /// protocol-2 one), the reconnect with the new version + ok Ack makes
    /// it healthy — over the real gRPC stream.
    #[tokio::test]
    async fn session_offers_and_health_gate() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let signer = Signer::new();
        let line = signer.config_line();
        let h = crate::testdb::fake_agent::PanelHarness::start_with(&db, |c| {
            c.updates.release_keys = vec![line]
        })
        .await;
        let listener = crate::notify::start(h.state.clone()).await;
        let c = admin_client(&h.state, &db).await;
        upload(&c, h.state.route_prefix(), &signer, "v1.1.0", b"new agent").await;
        let node = db.node().await;
        let creds = h.register(&db, node).await;
        let mut a = h.connect(&creds).await.unwrap();
        a.hello_as((0, 0), String::new(), 3, "v1.0.0").await;
        let snap = a.snapshot().await;
        a.ack_snapshot(&snap).await;
        // The rollout starts while the agent is connected: the wake brings
        // the offer without waiting for the reconcile tick.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let id = create(&db, req("v1.1.0")).await.unwrap();
        let offer = match a.next().await {
            Some(Ok(crate::pb::panel_down::Msg::UpdateOffer(o))) => o,
            other => panic!("expected an update offer, got {other:?}"),
        };
        assert_eq!(offer.rollout_id, id.to_string());
        assert_eq!(offer.signatures.len(), 1);
        a.update_status(ustatus(id, "v1.1.0", UState::Restarting))
            .await;
        drop(a);
        // The new binary connects.
        let mut b = h.connect(&creds).await.unwrap();
        b.hello_as((0, 0), String::new(), 3, "v1.1.0").await;
        let snap = b.snapshot().await;
        b.ack_snapshot(&snap).await;
        let mut healthy = false;
        for _ in 0..50 {
            if node_status(&db, id, node).await == "healthy" {
                healthy = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            healthy,
            "node not healthy: {}",
            node_status(&db, id, node).await
        );
        drop(b);
        listener.abort();
        let _ = listener.await;
        h.stop().await;
        db.drop().await;
    }

    /// Waves advance only when the current one is terminal; a rollback
    /// report fails the node, the ratio halts the rollout (audited, system
    /// actor), the next wave is never offered; halted can only be aborted.
    #[tokio::test]
    async fn waves_halt_pause_abort_timeout() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let signer = Signer::new();
        let line = signer.config_line();
        let state =
            AppState::for_test_with(db.pool.clone(), |c| c.updates.release_keys = vec![line]).await;
        let c = admin_client(&state, &db).await;
        upload(&c, "test", &signer, "v1.1.0", b"agent").await;
        let mut nodes = Vec::new();
        for _ in 0..4 {
            nodes.push(agent_node(&db, "v1.0.0", 3).await);
        }
        let id = create(
            &db,
            CreateRolloutReq {
                waves: Some(vec![25, 100]),
                max_failure_ratio: Some(0.5),
                ..req("v1.1.0")
            },
        )
        .await
        .unwrap();
        let wave_of = |n: Uuid| {
            let pool = db.pool.clone();
            async move {
                sqlx::query_scalar::<_, i32>(
                    "SELECT wave FROM rollout_nodes WHERE rollout_id = $1 AND node_id = $2",
                )
                .bind(id)
                .bind(n)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        let mut first = Vec::new();
        let mut rest = Vec::new();
        for n in &nodes {
            if wave_of(*n).await == 0 {
                first.push(*n)
            } else {
                rest.push(*n)
            }
        }
        assert_eq!((first.len(), rest.len()), (1, 3));
        // Wave 1 is not offered yet.
        assert!(
            offer_for(&db.pool, rest[0], 3, "v1.0.0", ("linux", "amd64"))
                .await
                .unwrap()
                .is_none()
        );
        // Pause: no offers; resume: offers again.
        let mut tx = db.pool.begin().await.unwrap();
        apply_action(&mut tx, &Actor::test(), id, Action::Pause)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!(
            offer_for(&db.pool, first[0], 3, "v1.0.0", ("linux", "amd64"))
                .await
                .unwrap()
                .is_none()
        );
        let mut tx = db.pool.begin().await.unwrap();
        assert_eq!(
            apply_action(&mut tx, &Actor::test(), id, Action::Pause)
                .await
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
        drop(tx);
        let mut tx = db.pool.begin().await.unwrap();
        apply_action(&mut tx, &Actor::test(), id, Action::Resume)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!(
            offer_for(&db.pool, first[0], 3, "v1.0.0", ("linux", "amd64"))
                .await
                .unwrap()
                .is_some()
        );
        // Healthy -> wave 1 starts (audited).
        on_hello(&db.pool, first[0], "v1.1.0").await.unwrap();
        on_converged(&db.pool, first[0], "v1.1.0").await.unwrap();
        tick_db(&db, id).await;
        assert_eq!(audits(&db, "rollout.wave").await, 1);
        // Wave 1: one times out, one rolls back -> 2 failed / 3 > 0.5: halt.
        for n in &rest {
            assert!(offer_for(&db.pool, *n, 3, "v1.0.0", ("linux", "amd64"))
                .await
                .unwrap()
                .is_some());
        }
        on_status(
            &db.pool,
            rest[0],
            &ustatus(id, "v1.1.0", UState::RolledBack),
        )
        .await
        .unwrap();
        assert_eq!(node_status(&db, id, rest[0]).await, "failed");
        tick_db(&db, id).await;
        assert_eq!(
            status(&db, id).await,
            "running",
            "1 failed / 2 finished is not > 0.5"
        );
        sqlx::query(
            "UPDATE rollout_nodes SET offered_at = now() - interval '1 hour' WHERE node_id = $1",
        )
        .bind(rest[1])
        .execute(&db.pool)
        .await
        .unwrap();
        tick_db(&db, id).await;
        assert_eq!(node_status(&db, id, rest[1]).await, "failed");
        assert_eq!(status(&db, id).await, "halted");
        let actor: String =
            sqlx::query_scalar("SELECT actor_login FROM audit_log WHERE action = 'rollout.halt'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(actor, crate::audit::SYSTEM);
        // Halted: no offers; resume refused; abort works.
        assert!(
            offer_for(&db.pool, rest[2], 3, "v1.0.0", ("linux", "amd64"))
                .await
                .unwrap()
                .is_none()
        );
        let mut tx = db.pool.begin().await.unwrap();
        assert_eq!(
            apply_action(&mut tx, &Actor::test(), id, Action::Resume)
                .await
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
        drop(tx);
        let r = c
            .post(&format!("/test/api/v1/rollouts/{id}/abort"), json!({}))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
        assert_eq!(status(&db, id).await, "aborted");
        assert_eq!(audits(&db, "rollout.abort").await, 1);
        // A late report of an aborted rollout changes nothing.
        on_status(&db.pool, rest[2], &ustatus(id, "v1.1.0", UState::Failed))
            .await
            .unwrap();
        assert_eq!(node_status(&db, id, rest[2]).await, "offered");
        db.drop().await;
    }
}
