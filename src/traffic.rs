//! Traffic accounting: agents report cumulative per-user counters; the panel
//! turns them into usage.
//!
//! Model (REVIEW P0 #2 / P1 #10): memory holds only the latest cumulative
//! value per (node, user, session) — no pending deltas. The delta is computed
//! by PostgreSQL at flush time against the persisted `traffic_counters` row,
//! in a single statement:
//!
//! ```text
//! upsert counters := GREATEST(stored, reported) ... RETURNING old, new
//! users.traffic_used_bytes += Σ max(new - coalesce(old, baseline), 0)
//! ```
//!
//! Replaying a value (panel restart, flush retry, ambiguous commit, duplicate
//! stream) therefore never bills twice, and a failed flush loses nothing: the
//! next write of the same or a later cumulative value recovers the delta.
//! A counter regression inside one session starts a new "epoch" key whose
//! first value is a baseline (billed 0); see [`Epoch`].

use std::time::{Duration, Instant};

use dashmap::DashMap;
use uuid::Uuid;

use crate::gen::TrafficReport;
use crate::state::AppState;

/// Clean (fully persisted) entries idle this long are evicted. Evicting is
/// always safe for billing: a later report for the same key is compared
/// against the persisted row, not against memory.
const PRUNE_IDLE: Duration = Duration::from_secs(600);

/// A row rejected by the database (data error, not connectivity) this many
/// flushes in a row is dropped so it cannot block the rest forever.
const MAX_ROW_FAILURES: u32 = 12;

const MAX_SESSION_LEN: usize = 128;

/// (node, user, agent session id)
type Key = (Uuid, Uuid, String);

/// One monotonic run of counters. Epoch 0 is the session itself; a counter
/// regression within a session (agent rebuilt xray without announcing a new
/// session) starts epoch n+1, persisted under `"{session}#{n}"`, whose
/// baseline is the first post-regression value (billed 0).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Epoch {
    n: u32,
    /// Values at epoch start; only used if the DB has no row yet.
    base_up: i64,
    base_down: i64,
    /// Highest cumulative counters seen in this epoch.
    up: i64,
    down: i64,
    /// What was last durably written to `traffic_counters` (None = never).
    flushed: Option<(i64, i64)>,
    failures: u32,
}

impl Epoch {
    fn new(n: u32, base_up: i64, base_down: i64) -> Self {
        Self {
            n,
            base_up,
            base_down,
            up: base_up,
            down: base_down,
            flushed: None,
            failures: 0,
        }
    }

    fn dirty(&self) -> bool {
        self.flushed != Some((self.up, self.down))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    current: Epoch,
    /// Superseded epochs whose final values are not persisted yet.
    retired: Vec<Epoch>,
    touched: Instant,
}

impl Entry {
    fn new(now: Instant) -> Self {
        Self {
            current: Epoch::new(0, 0, 0),
            retired: Vec::new(),
            touched: now,
        }
    }

    /// Record a cumulative report. Returns true if it regressed, in which
    /// case the report becomes a new baseline and bills nothing.
    fn observe(&mut self, up: i64, down: i64, now: Instant) -> bool {
        self.touched = now;
        let c = &mut self.current;
        if up < c.up || down < c.down {
            let next = Epoch::new(c.n.saturating_add(1), up, down);
            let old = std::mem::replace(c, next);
            if old.dirty() {
                self.retired.push(old);
            }
            return true;
        }
        c.up = up;
        c.down = down;
        false
    }

    fn dirty(&self) -> bool {
        self.current.dirty() || !self.retired.is_empty()
    }

    fn epoch_mut(&mut self, n: u32) -> Option<&mut Epoch> {
        if self.current.n == n {
            Some(&mut self.current)
        } else {
            self.retired.iter_mut().find(|e| e.n == n)
        }
    }
}

/// Session ids are agent-chosen UUIDs. Bound them so a buggy agent cannot
/// inflate memory, collide with epoch keys (`#`) or feed PostgreSQL an
/// invalid TEXT value (NUL).
fn valid_session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_SESSION_LEN && !s.contains(['\0', '#'])
}

fn db_session_key(session: &str, epoch: u32) -> String {
    if epoch == 0 {
        session.to_string()
    } else {
        format!("{session}#{epoch}")
    }
}

#[derive(Default)]
pub struct TrafficBuffer {
    entries: DashMap<Key, Entry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FlushRow {
    node_id: Uuid,
    user_id: Uuid,
    session_id: String,
    epoch: u32,
    up: i64,
    down: i64,
    base_up: i64,
    base_down: i64,
}

impl FlushRow {
    fn new(key: &Key, e: &Epoch) -> Self {
        Self {
            node_id: key.0,
            user_id: key.1,
            session_id: key.2.clone(),
            epoch: e.n,
            up: e.up,
            down: e.down,
            base_up: e.base_up,
            base_down: e.base_down,
        }
    }

    fn key(&self) -> Key {
        (self.node_id, self.user_id, self.session_id.clone())
    }
}

impl TrafficBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a report whose counters belong to `session_id`.
    pub fn update(&self, node_id: Uuid, session_id: &str, report: &TrafficReport) {
        self.update_at(node_id, session_id, report, Instant::now());
    }

    fn update_at(&self, node_id: Uuid, session_id: &str, report: &TrafficReport, now: Instant) {
        if !valid_session_id(session_id) {
            tracing::warn!(node = %node_id, len = session_id.len(), "traffic report with invalid session id dropped");
            return;
        }
        for u in &report.users {
            let Ok(user_id) = Uuid::parse_str(&u.user_id) else {
                tracing::warn!(node = %node_id, user = %u.user_id, "traffic report for unparseable user id");
                continue;
            };
            let (Ok(up), Ok(down)) = (i64::try_from(u.up_bytes), i64::try_from(u.down_bytes))
            else {
                tracing::warn!(node = %node_id, user = %user_id, up = u.up_bytes, down = u.down_bytes,
                    "traffic counters exceed i64::MAX; row dropped");
                continue;
            };
            let mut e = self
                .entries
                .entry((node_id, user_id, session_id.to_string()))
                .or_insert_with(|| Entry::new(now));
            if e.observe(up, down, now) {
                tracing::warn!(node = %node_id, user = %user_id, session = %session_id, epoch = e.current.n,
                    "traffic counters went backwards within a session; new baseline, not billed");
            }
        }
    }

    /// Everything not yet durably persisted. Nothing is cleared here.
    fn snapshot(&self) -> Vec<FlushRow> {
        let mut out = Vec::new();
        for e in self.entries.iter() {
            let v = e.value();
            out.extend(v.retired.iter().map(|r| FlushRow::new(e.key(), r)));
            if v.current.dirty() {
                out.push(FlushRow::new(e.key(), &v.current));
            }
        }
        out
    }

    /// `rows` are durably written. Newer values that arrived meanwhile keep
    /// their epoch dirty; persisted retired epochs are forgotten.
    fn mark_flushed(&self, rows: &[FlushRow]) {
        for r in rows {
            let Some(mut e) = self.entries.get_mut(&r.key()) else {
                continue;
            };
            if let Some(ep) = e.epoch_mut(r.epoch) {
                ep.flushed = Some((r.up, r.down));
                ep.failures = 0;
            }
            e.retired.retain(|x| x.dirty());
        }
    }

    /// The database rejected this row on its own (not a connectivity
    /// error). After MAX_ROW_FAILURES consecutive rejections the row is
    /// given up on so it cannot block the rest forever.
    fn mark_failed(&self, r: &FlushRow) {
        let Some(mut e) = self.entries.get_mut(&r.key()) else {
            return;
        };
        let Some(ep) = e.epoch_mut(r.epoch) else {
            return;
        };
        ep.failures += 1;
        if ep.failures < MAX_ROW_FAILURES {
            return;
        }
        ep.flushed = Some((r.up, r.down));
        ep.failures = 0;
        e.retired.retain(|x| x.dirty());
        tracing::error!(node = %r.node_id, user = %r.user_id, session = %r.session_id,
            up = r.up, down = r.down, "traffic row repeatedly rejected by database; dropped");
    }

    /// Evict fully persisted, idle entries. Always safe for billing: the
    /// delta is computed against `traffic_counters`, not against memory.
    fn prune(&self, now: Instant) {
        self.entries
            .retain(|_, e| e.dirty() || now.duration_since(e.touched) < PRUNE_IDLE);
    }
}

/// One statement = one transaction: upsert the high-water marks and bill
/// exactly the increase over what was stored before (or over the epoch
/// baseline for a key seen for the first time).
const FLUSH_SQL: &str = r#"
WITH input AS (
    SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::bigint[], $5::bigint[],
                         $6::bigint[], $7::bigint[])
        AS t(node_id, user_id, session_id, up, down, base_up, base_down)
), upsert AS (
    INSERT INTO traffic_counters AS c (node_id, user_id, session_id, up_bytes, down_bytes, updated_at)
    SELECT node_id, user_id, session_id, up, down, now() FROM input
    ON CONFLICT (node_id, user_id, session_id) DO UPDATE
    SET up_bytes   = GREATEST(c.up_bytes, EXCLUDED.up_bytes),
        down_bytes = GREATEST(c.down_bytes, EXCLUDED.down_bytes),
        updated_at = EXCLUDED.updated_at
    RETURNING new.node_id, new.user_id, new.session_id,
              old.up_bytes AS old_up, old.down_bytes AS old_down,
              new.up_bytes AS new_up, new.down_bytes AS new_down
), per_user AS (
    SELECT u.user_id,
           sum(GREATEST(u.new_up - COALESCE(u.old_up, i.base_up), 0)::numeric
             + GREATEST(u.new_down - COALESCE(u.old_down, i.base_down), 0)::numeric) AS delta
    FROM upsert u JOIN input i USING (node_id, user_id, session_id)
    GROUP BY u.user_id
)
UPDATE users u
SET traffic_used_bytes = LEAST(u.traffic_used_bytes::numeric + p.delta, 9223372036854775807)::bigint
FROM per_user p
WHERE u.id = p.user_id AND p.delta > 0
"#;

async fn write_rows(pg: &sqlx::PgPool, rows: &[FlushRow]) -> Result<(), sqlx::Error> {
    let nodes: Vec<Uuid> = rows.iter().map(|r| r.node_id).collect();
    let users: Vec<Uuid> = rows.iter().map(|r| r.user_id).collect();
    let sessions: Vec<String> = rows
        .iter()
        .map(|r| db_session_key(&r.session_id, r.epoch))
        .collect();
    let ups: Vec<i64> = rows.iter().map(|r| r.up).collect();
    let downs: Vec<i64> = rows.iter().map(|r| r.down).collect();
    let base_ups: Vec<i64> = rows.iter().map(|r| r.base_up).collect();
    let base_downs: Vec<i64> = rows.iter().map(|r| r.base_down).collect();
    sqlx::query(FLUSH_SQL)
        .bind(&nodes)
        .bind(&users)
        .bind(&sessions)
        .bind(&ups)
        .bind(&downs)
        .bind(&base_ups)
        .bind(&base_downs)
        .execute(pg)
        .await?;
    Ok(())
}

/// Persist `buf`'s dirty rows. A data error on the batch falls back to
/// per-row writes so one bad row cannot poison the rest; connectivity
/// errors keep everything for the next tick (retry is idempotent).
async fn flush_buffer(pg: &sqlx::PgPool, buf: &TrafficBuffer) -> anyhow::Result<usize> {
    let rows = buf.snapshot();
    if rows.is_empty() {
        return Ok(0);
    }
    match write_rows(pg, &rows).await {
        Ok(()) => {
            buf.mark_flushed(&rows);
            Ok(rows.len())
        }
        Err(sqlx::Error::Database(e)) => {
            tracing::warn!(error = %e, rows = rows.len(), "traffic batch rejected; retrying row by row");
            let mut written = 0;
            for r in &rows {
                match write_rows(pg, std::slice::from_ref(r)).await {
                    Ok(()) => {
                        buf.mark_flushed(std::slice::from_ref(r));
                        written += 1;
                    }
                    Err(sqlx::Error::Database(e)) => {
                        tracing::warn!(error = %e, node = %r.node_id, user = %r.user_id, "traffic row rejected");
                        buf.mark_failed(r);
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            Ok(written)
        }
        Err(e) => Err(e.into()),
    }
}

pub async fn flush_loop(state: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if let Err(e) = flush_once(&state).await {
            tracing::warn!(error = %e, "traffic flush failed");
        }
    }
}

async fn flush_once(state: &AppState) -> anyhow::Result<()> {
    // Persist first so limit enforcement sees the freshest usage; a failure
    // of either step must not block the other.
    let flushed = flush_buffer(state.pg(), state.traffic()).await;
    state.traffic().prune(Instant::now());
    let enforced = enforce_limits(state).await;
    let n = flushed?;
    if n > 0 {
        tracing::debug!(rows = n, "traffic flushed");
    }
    enforced
}

async fn enforce_limits(state: &AppState) -> anyhow::Result<()> {
    // Traffic-limit enforcement: disable users past their limit, bump the
    // user_version on their nodes and wake connected agents so the removal
    // propagates without waiting for a reconnect.
    let disabled: Vec<Uuid> = sqlx::query_scalar(
        r#"UPDATE users SET enabled = false
           WHERE enabled = true AND traffic_limit_bytes IS NOT NULL
             AND traffic_used_bytes > traffic_limit_bytes
           RETURNING id"#,
    )
    .fetch_all(state.pg())
    .await?;
    if !disabled.is_empty() {
        let node_ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT DISTINCT node_id FROM node_users WHERE user_id = ANY($1)")
                .bind(&disabled)
                .fetch_all(state.pg())
                .await?;
        sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = ANY($1)")
            .bind(&node_ids)
            .execute(state.pg())
            .await?;
        // One bump wakes every connected agent's session; each session
        // re-reads its own node state and converges independently.
        state.notify_change();
        tracing::info!(
            nodes = node_ids.len(),
            users = disabled.len(),
            "disabled users over traffic limit"
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gen::UserTraffic;

    fn report(users: &[(Uuid, u64, u64)]) -> TrafficReport {
        TrafficReport {
            users: users
                .iter()
                .map(|&(u, up, down)| UserTraffic {
                    user_id: u.to_string(),
                    up_bytes: up,
                    down_bytes: down,
                })
                .collect(),
            ..Default::default()
        }
    }

    fn ids() -> (TrafficBuffer, Uuid, Uuid) {
        (TrafficBuffer::new(), Uuid::new_v4(), Uuid::new_v4())
    }

    fn rows(b: &TrafficBuffer) -> Vec<(String, u32, i64, i64, i64, i64)> {
        let mut v: Vec<_> = b
            .snapshot()
            .into_iter()
            .map(|r| (r.session_id, r.epoch, r.up, r.down, r.base_up, r.base_down))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn memory_keeps_latest_cumulative_not_deltas() {
        let (b, n, u) = ids();
        b.update(n, "s1", &report(&[(u, 100, 1000)]));
        b.update(n, "s1", &report(&[(u, 150, 1600)]));
        assert_eq!(rows(&b), vec![("s1".into(), 0, 150, 1600, 0, 0)]);
    }

    #[test]
    fn sessions_are_independent_keys() {
        let (b, n, u) = ids();
        b.update(n, "sa", &report(&[(u, 500, 500)]));
        b.update(n, "sb", &report(&[(u, 10, 20)]));
        b.update(n, "sa", &report(&[(u, 600, 600)]));
        assert_eq!(
            rows(&b),
            vec![
                ("sa".into(), 0, 600, 600, 0, 0),
                ("sb".into(), 0, 10, 20, 0, 0)
            ]
        );
    }

    #[test]
    fn regression_starts_new_epoch_with_zero_billed_baseline() {
        let (b, n, u) = ids();
        b.update(n, "s1", &report(&[(u, 1000, 1000)]));
        b.update(n, "s1", &report(&[(u, 50, 60)]));
        // Old epoch's final value still pending; new epoch's base == value.
        assert_eq!(
            rows(&b),
            vec![
                ("s1".into(), 0, 1000, 1000, 0, 0),
                ("s1".into(), 1, 50, 60, 50, 60)
            ]
        );
        b.update(n, "s1", &report(&[(u, 80, 60)]));
        assert_eq!(rows(&b)[1], ("s1".into(), 1, 80, 60, 50, 60));
    }

    #[test]
    fn regression_of_a_single_column_also_rebaselines() {
        let (b, n, u) = ids();
        b.update(n, "s1", &report(&[(u, 1000, 10)]));
        b.update(n, "s1", &report(&[(u, 2000, 5)]));
        assert_eq!(rows(&b)[1], ("s1".into(), 1, 2000, 5, 2000, 5));
    }

    #[test]
    fn flushed_retired_epoch_is_forgotten_current_stays_until_clean() {
        let (b, n, u) = ids();
        b.update(n, "s1", &report(&[(u, 1000, 1000)]));
        b.update(n, "s1", &report(&[(u, 50, 60)]));
        let snap = b.snapshot();
        b.mark_flushed(&snap);
        assert!(b.snapshot().is_empty());
        let e = b.entries.get(&(n, u, "s1".into())).unwrap();
        assert!(e.retired.is_empty());
        assert_eq!(e.current.n, 1);
    }

    #[test]
    fn failed_flush_leaves_everything_for_retry() {
        let (b, n, u) = ids();
        b.update(n, "s1", &report(&[(u, 100, 200)]));
        let failed = b.snapshot(); // write fails: no mark_flushed
        b.update(n, "s1", &report(&[(u, 150, 260)]));
        assert_eq!(failed.len(), 1);
        assert_eq!(rows(&b), vec![("s1".into(), 0, 150, 260, 0, 0)]);
    }

    #[test]
    fn value_arriving_during_flush_stays_dirty() {
        let (b, n, u) = ids();
        b.update(n, "s1", &report(&[(u, 100, 100)]));
        let snap = b.snapshot();
        b.update(n, "s1", &report(&[(u, 130, 190)]));
        b.mark_flushed(&snap);
        assert_eq!(rows(&b), vec![("s1".into(), 0, 130, 190, 0, 0)]);
        b.mark_flushed(&b.snapshot());
        assert!(b.snapshot().is_empty());
    }

    #[test]
    fn repeatedly_rejected_row_is_dropped_others_unaffected() {
        let (b, n, u) = ids();
        let u2 = Uuid::new_v4();
        b.update(n, "s1", &report(&[(u, 1, 1), (u2, 2, 2)]));
        let bad = b.snapshot().into_iter().find(|r| r.user_id == u).unwrap();
        for _ in 0..MAX_ROW_FAILURES - 1 {
            b.mark_failed(&bad);
            assert_eq!(b.snapshot().len(), 2);
        }
        b.mark_failed(&bad);
        let left = b.snapshot();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].user_id, u2);
    }

    #[test]
    fn prune_only_evicts_clean_idle_entries() {
        let (b, n, u) = ids();
        let t0 = Instant::now();
        b.update_at(n, "clean", &report(&[(u, 1, 1)]), t0);
        b.mark_flushed(&b.snapshot());
        b.update_at(n, "dirty", &report(&[(u, 2, 2)]), t0);
        b.prune(t0 + Duration::from_secs(1));
        assert_eq!(b.entries.len(), 2, "recent entries kept");
        b.prune(t0 + PRUNE_IDLE + Duration::from_secs(1));
        assert!(!b.entries.contains_key(&(n, u, "clean".into())));
        assert!(b.entries.contains_key(&(n, u, "dirty".into())));
    }

    #[test]
    fn invalid_input_is_dropped() {
        let (b, n, u) = ids();
        b.update(n, "", &report(&[(u, 1, 1)]));
        b.update(n, "a\0b", &report(&[(u, 1, 1)]));
        b.update(n, "s#1", &report(&[(u, 1, 1)]));
        b.update(n, &"x".repeat(MAX_SESSION_LEN + 1), &report(&[(u, 1, 1)]));
        assert!(b.entries.is_empty());
        let mut r = report(&[(u, u64::MAX, 7), (Uuid::new_v4(), 3, 4)]);
        r.users.push(UserTraffic {
            user_id: "not-a-uuid".into(),
            up_bytes: 9,
            down_bytes: 9,
        });
        b.update(n, "s1", &r);
        assert_eq!(b.entries.len(), 1, "only the valid row is kept");
        assert!(!b.entries.contains_key(&(n, u, "s1".into())));
        let max = i64::MAX as u64;
        b.update(n, "s1", &report(&[(u, max, max)]));
        assert!(b.entries.contains_key(&(n, u, "s1".into())));
    }

    #[test]
    fn epoch_keys_never_collide_with_real_sessions() {
        assert_eq!(db_session_key("s", 0), "s");
        assert_eq!(db_session_key("s", 2), "s#2");
        assert!(!valid_session_id("s#2"));
    }
}

/// Real-PostgreSQL tests of the flush statement. They need the dev database
/// (`make dev-up`; DATABASE_URL or the config default) and run each test in a
/// throwaway schema. Set AKARI_SKIP_DB_TESTS=1 to skip on machines without it.
#[cfg(test)]
mod db_tests {
    use super::*;
    use crate::gen::UserTraffic;
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
    use sqlx::PgPool;
    use std::str::FromStr;

    struct TestDb {
        admin: PgPool,
        pool: PgPool,
        schema: String,
    }

    impl TestDb {
        async fn new() -> Option<Self> {
            if std::env::var("AKARI_SKIP_DB_TESTS").is_ok_and(|v| v == "1") {
                eprintln!("AKARI_SKIP_DB_TESTS=1: skipping");
                return None;
            }
            let url = std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://akari:akari-dev@localhost:5432/akari".into());
            let admin = PgPoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .expect("test database unreachable (make dev-up, or AKARI_SKIP_DB_TESTS=1)");
            let schema = format!("test_traffic_{}", Uuid::new_v4().simple());
            // schema is our own "test_traffic_<hex uuid>": no injection surface.
            sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
                .execute(&admin)
                .await
                .unwrap();
            let opts = PgConnectOptions::from_str(&url)
                .unwrap()
                .options([("search_path", schema.as_str())]);
            let pool = PgPoolOptions::new()
                .max_connections(2)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::migrate!("./migrations").run(&pool).await.unwrap();
            Some(Self {
                admin,
                pool,
                schema,
            })
        }

        async fn user(&self) -> Uuid {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO users (id, login) VALUES ($1, $2)")
                .bind(id)
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .unwrap();
            id
        }

        async fn used(&self, user: Uuid) -> i64 {
            sqlx::query_scalar("SELECT traffic_used_bytes FROM users WHERE id = $1")
                .bind(user)
                .fetch_one(&self.pool)
                .await
                .unwrap()
        }

        async fn flush(&self, b: &TrafficBuffer) -> usize {
            flush_buffer(&self.pool, b).await.unwrap()
        }

        async fn drop(self) {
            self.pool.close().await;
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "DROP SCHEMA {} CASCADE",
                self.schema
            )))
            .execute(&self.admin)
            .await
            .unwrap();
        }
    }

    fn report(u: Uuid, up: u64, down: u64) -> TrafficReport {
        TrafficReport {
            users: vec![UserTraffic {
                user_id: u.to_string(),
                up_bytes: up,
                down_bytes: down,
            }],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn panel_restart_between_reports_bills_only_the_increase() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = (Uuid::new_v4(), db.user().await);
        let before = TrafficBuffer::new();
        before.update(n, "s1", &report(u, 1000, 5000));
        db.flush(&before).await;
        // Reported but never flushed: the panel dies here.
        before.update(n, "s1", &report(u, 1200, 5500));
        drop(before);

        let after = TrafficBuffer::new();
        after.update(n, "s1", &report(u, 1300, 6000));
        db.flush(&after).await;
        assert_eq!(db.used(u).await, 1300 + 6000);
        db.drop().await;
    }

    #[tokio::test]
    async fn replayed_flush_is_idempotent() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = (Uuid::new_v4(), db.user().await);
        let b = TrafficBuffer::new();
        b.update(n, "s1", &report(u, 100, 200));
        let rows = b.snapshot();
        // Ambiguous commit: written, but the panel thinks it failed.
        write_rows(&db.pool, &rows).await.unwrap();
        db.flush(&b).await;
        db.flush(&b).await;
        write_rows(&db.pool, &rows).await.unwrap();
        assert_eq!(db.used(u).await, 300);
        db.drop().await;
    }

    #[tokio::test]
    async fn failed_flush_is_fully_recovered_by_next_report() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = (Uuid::new_v4(), db.user().await);
        let b = TrafficBuffer::new();
        b.update(n, "s1", &report(u, 100, 100));
        db.flush(&b).await;
        b.update(n, "s1", &report(u, 400, 100));
        let _lost = b.snapshot(); // transaction failed
                                  // Even if memory were wiped (eviction/restart), the next cumulative
                                  // report carries the missed delta.
        let fresh = TrafficBuffer::new();
        fresh.update(n, "s1", &report(u, 450, 150));
        db.flush(&fresh).await;
        assert_eq!(db.used(u).await, 450 + 150);
        db.drop().await;
    }

    #[tokio::test]
    async fn alternating_sessions_do_not_overcount() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = (Uuid::new_v4(), db.user().await);
        let b = TrafficBuffer::new();
        for i in 1..=5u64 {
            b.update(n, "sa", &report(u, 100 * i, 0));
            db.flush(&b).await;
            b.update(n, "sb", &report(u, 10 * i, 0));
            // Same value re-sent (duplicate stream / retry): bills nothing.
            b.update(n, "sa", &report(u, 100 * i, 0));
            db.flush(&b).await;
        }
        assert_eq!(db.used(u).await, 500 + 50);
        db.drop().await;
    }

    /// Documents the price of the "regression = new baseline" rule: a stale
    /// (older, lower) value arriving AFTER a newer one is indistinguishable
    /// from a counter reset, so the next real value over-bills by
    /// (newest - stale). Within one gRPC stream order is preserved, so this
    /// needs two concurrent streams of one agent interleaving by >= 10 s.
    #[tokio::test]
    async fn known_limitation_out_of_order_stale_value_overbills() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = (Uuid::new_v4(), db.user().await);
        let b = TrafficBuffer::new();
        b.update(n, "s1", &report(u, 200, 0));
        b.update(n, "s1", &report(u, 150, 0)); // stale, out of order
        b.update(n, "s1", &report(u, 300, 0));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 200 + (300 - 150)); // truth: 300
        db.drop().await;
    }

    #[tokio::test]
    async fn regression_rebaselines_then_bills_growth() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = (Uuid::new_v4(), db.user().await);
        let b = TrafficBuffer::new();
        b.update(n, "s1", &report(u, 1000, 0));
        db.flush(&b).await;
        b.update(n, "s1", &report(u, 40, 0)); // baseline, billed 0
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 1000);
        b.update(n, "s1", &report(u, 100, 0));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 1060);
        db.drop().await;
    }

    #[tokio::test]
    async fn one_bad_row_does_not_poison_the_batch() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, good, bad) = (Uuid::new_v4(), db.user().await, db.user().await);
        let b = TrafficBuffer::new();
        b.update(n, "s1", &report(good, 10, 10));
        // Bypass validation to plant a row PostgreSQL rejects (NUL in TEXT).
        b.entries
            .entry((n, bad, "bad\0session".into()))
            .or_insert_with(|| Entry::new(Instant::now()))
            .observe(5, 5, Instant::now());
        assert_eq!(db.flush(&b).await, 1);
        assert_eq!(db.used(good).await, 20);
        for _ in 1..MAX_ROW_FAILURES {
            db.flush(&b).await;
        }
        assert!(
            b.snapshot().is_empty(),
            "bad row given up after MAX_ROW_FAILURES"
        );
        assert_eq!(db.used(good).await, 20);
        assert_eq!(db.used(bad).await, 0);
        db.drop().await;
    }

    #[tokio::test]
    async fn usage_saturates_instead_of_overflowing() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = (Uuid::new_v4(), db.user().await);
        let b = TrafficBuffer::new();
        let max = i64::MAX as u64;
        b.update(n, "s1", &report(u, max, max));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, i64::MAX);
        db.drop().await;
    }
}
