//! Q1 (PLAN-v0.4 D2, research/db-schema-review.md §D2 方案 A): servers.
//!
//! A server is one machine = one agent identity (migration 1036): its
//! enrolment and certificates, the agent's Hello/heartbeat state, the
//! desired-state versions and lease, apply failures, two-phase deletion,
//! the billing GCRA, the latency probe, the TLS domain (one ACME
//! certificate per agent), its metrics, alerts and rollouts. Nodes (one
//! inbound each, D2; `nodes.rs`) belong to a server, and one agent serves
//! every node of its server in one Snapshot (`grpc::desired_state`).
//!
//! Admin API: `GET /servers` (grouped: server -> nodes -> entrances, ETag),
//! `POST /servers` (pending server + one-time enrollment token / install
//! link), `GET/PATCH/DELETE /servers/{id}`, `POST /servers/{id}/enroll-token`.
//! Machine endpoints elsewhere: `/servers/{id}/install` (`nodeinstall`),
//! `/status`, `/metrics`, `/probe` (`nodestat`), `/alert-rules` (`alerts`).
//!
//! Lock order: servers (`ORDER BY id FOR UPDATE`) -> nodes -> users ->
//! entrance_users; a node mutation locks its server first (`lock_server_of`).

use crate::auth::{bad_request, conflict};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::{ApiJson, double_option, non_null};
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/// Lock a server row (FOR UPDATE): 404 unknown, 409 `server.deleting`.
pub async fn lock_server(conn: &mut PgConnection, id: Uuid) -> Result<(), ApiError> {
    let deleting: Option<bool> =
        sqlx::query_scalar("SELECT deleting_at IS NOT NULL FROM servers WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    match deleting {
        None => Err(ApiError::not_found()),
        Some(true) => Err(conflict!("server.deleting", "server is being deleted")),
        Some(false) => Ok(()),
    }
}

/// Lock `node`'s server (FOR UPDATE; the global order puts servers before
/// nodes): its id. 404 unknown node, 409 `server.deleting`.
pub async fn lock_server_of(conn: &mut PgConnection, node: Uuid) -> Result<Uuid, ApiError> {
    let row: Option<(Uuid, bool)> = sqlx::query_as(
        "SELECT s.id, s.deleting_at IS NOT NULL FROM servers s \
         WHERE s.id = (SELECT server_id FROM nodes WHERE id = $1) FOR UPDATE",
    )
    .bind(node)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        None => Err(ApiError::not_found()),
        Some((_, true)) => Err(conflict!("server.deleting", "server is being deleted")),
        Some((id, false)) => Ok(id),
    }
}

/// `lock_server_of` for callers that treat a missing node and a server
/// being deleted alike (None).
pub async fn lock_live_server_of(
    conn: &mut PgConnection,
    node: Uuid,
) -> sqlx::Result<Option<Uuid>> {
    sqlx::query_scalar(
        "SELECT s.id FROM servers s WHERE s.id = (SELECT server_id FROM nodes WHERE id = $1) \
         AND s.deleting_at IS NULL FOR UPDATE",
    )
    .bind(node)
    .fetch_optional(conn)
    .await
}

/// Bump the server's config_version (its inbound set or served state
/// changes: the agent gets a Snapshot).
pub async fn bump_config(conn: &mut PgConnection, server: Uuid) -> sqlx::Result<()> {
    sqlx::query("UPDATE servers SET config_version = config_version + 1 WHERE id = $1")
        .bind(server)
        .execute(conn)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Warnings (machine level; NodeView shows its server's too)
// ---------------------------------------------------------------------------

/// What the warnings of a server are computed from (columns of
/// `server_warn_cols`).
#[derive(sqlx::FromRow, Serialize, Debug, Default)]
pub struct WarnFacts {
    /// W10: the server's TLS domain (automatic certificate; null = the
    /// certificate files installed by hand).
    pub tls_domain: Option<String>,
    /// Hello.protocol_version / Hello.capabilities of the last connected
    /// agent (null before any Hello).
    pub agent_protocol: Option<i32>,
    pub agent_capabilities: Option<Vec<String>>,
    /// M1-8: when the newest agent certificate expires.
    pub cert_not_after: Option<DateTime<Utc>>,
    /// W7: the server serves a speed-limited user but its agent predates
    /// speed limits (protocol < 4).
    #[serde(skip)]
    pub unenforced_speed_limits: bool,
    /// The inbounds of the server's nodes (array).
    #[serde(skip)]
    pub inbounds: Value,
    /// Enabled relay entrances / enabled entrances on the server.
    #[serde(skip)]
    pub relays: i64,
    #[serde(skip)]
    pub entrances_enabled: i64,
}

/// The `WarnFacts` columns for a server aliased `s`.
pub fn server_warn_cols() -> String {
    "s.tls_domain, s.agent_protocol, s.agent_capabilities, s.cert_not_after, \
     CASE WHEN s.agent_protocol < 4 THEN EXISTS (\
        SELECT 1 FROM entrance_users eu JOIN entrances e ON e.id = eu.entrance_id \
        JOIN user_plans up ON up.user_id = eu.user_id AND up.status = 'active' \
        WHERE e.server_id = s.id AND up.speed_limit_mbps IS NOT NULL) \
     ELSE false END AS unenforced_speed_limits, \
     coalesce((SELECT jsonb_agg(n.inbound ORDER BY n.id) FROM nodes n \
        WHERE n.server_id = s.id AND n.inbound IS NOT NULL), '[]'::jsonb) AS inbounds, \
     (SELECT count(*) FROM entrances e WHERE e.server_id = s.id AND e.kind = 'relay' \
        AND e.enabled) AS relays, \
     (SELECT count(*) FROM entrances e WHERE e.server_id = s.id AND e.enabled) \
        AS entrances_enabled"
        .to_string()
}

/// A certificate expiring within this many days is flagged (agents of
/// protocol >= 2 renew with a third of the validity left, i.e. 30 days at
/// the default 90; protocol 1 agents never renew).
const CERT_WARN_DAYS: i64 = 14;

impl WarnFacts {
    /// The machine-level warnings (Chinese, shown as they are).
    pub fn warnings(&self) -> Vec<String> {
        let mut w = entrance_warnings(
            self.relays,
            self.entrances_enabled,
            self.agent_protocol,
            self.agent_capabilities.as_deref(),
        );
        w.extend(tls_domain_warnings(
            self.tls_domain.as_deref(),
            &self.inbounds,
            self.agent_protocol,
        ));
        if let Some(c) = cert_warning(self.cert_not_after, self.agent_protocol, Utc::now()) {
            w.push(c);
        }
        if let Some(u) = updater_warning(self.agent_protocol, self.agent_capabilities.as_deref()) {
            w.push(u);
        }
        if let Some(u) = stale_units_warning(self.agent_capabilities.as_deref()) {
            w.push(u);
        }
        if self.unenforced_speed_limits {
            w.push(format!(
                "agent 版本过旧，不支持限速（协议 < {}）：升级 agent 之前，套餐限速在此服务器上不生效",
                crate::grpc::SPEED_LIMIT_PROTOCOL
            ));
        }
        w
    }
}

/// W28-a / Q1: relay entrances the agent cannot filter by source address
/// (capability "source-filter"), and several entrances on an agent that
/// shares limits per entrance rather than per user (protocol < 7: every
/// entrance but the first direct one is keyed `<user>#<n>`).
fn entrance_warnings(
    relays: i64,
    entrances: i64,
    agent_protocol: Option<i32>,
    agent_capabilities: Option<&[String]>,
) -> Vec<String> {
    let Some(protocol) = agent_protocol else {
        return Vec::new();
    };
    let mut w = Vec::new();
    if relays > 0 && !agent_capabilities.is_some_and(|c| c.iter().any(|c| c == "source-filter")) {
        w.push(
            "agent 不支持来源 IP 过滤：中转入口目前只靠独立凭据隔离（升级 agent 后由内核按中转出口 IP 过滤）"
                .to_string(),
        );
    }
    if entrances > 1 && protocol < crate::grpc::ACCOUNT_KEY_PROTOCOL {
        w.push(format!(
            "agent 版本过旧（协议 < {}）：同一用户在多个入口上的限速与在线人数分别计算，升级 agent 后按用户合并",
            crate::grpc::ACCOUNT_KEY_PROTOCOL
        ));
    }
    w
}

/// W28-a: the agent reports that it could not install the source
/// allowlists of the server's relay entrances (heartbeat blob).
pub fn source_filter_warning(blob: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Blob {
        source_filter: Option<Status>,
    }
    #[derive(Deserialize)]
    struct Status {
        applied: bool,
        #[serde(default)]
        error: Option<String>,
    }
    let f = serde_json::from_str::<Blob>(blob).ok()?.source_filter?;
    // R44: the agent's root updater applies them within seconds; the agent
    // says "pending: …" until then (and reports a missing updater after a
    // minute).
    let pending = f
        .error
        .as_deref()
        .is_some_and(|e| e.starts_with("pending:"));
    (!f.applied && !pending).then(|| {
        format!(
            "来源 IP 过滤未生效（{}）：中转入口目前只靠独立凭据隔离",
            f.error.as_deref().unwrap_or("原因未知")
        )
    })
}

/// W18: agents that can be offered updates (protocol >= 3) but predate the
/// privileged updater try to execute the update from their state
/// directory, which systemd >= 256 mounts noexec ("permission denied").
/// One run of the install command (重装命令) installs the updater units and
/// the current agent.
fn updater_warning(protocol: Option<i32>, caps: Option<&[String]>) -> Option<String> {
    let p = protocol?;
    if p < 3 || caps.is_some_and(|c| c.iter().any(|c| c == "updater")) {
        return None;
    }
    Some(
        "agent 不支持新的自更新方式：在 systemd 257 及以上（如 Debian 13）的服务器上自更新会失败\
         （permission denied）。请在服务器上重新运行一次安装命令（重装命令），它会安装更新服务\
         akari-agent-update 并升级 agent"
            .to_string(),
    )
}

/// W23: the agent reports ("stale-units") that the installed systemd units
/// are not the ones its release carries: they were installed by an
/// installer or updater that predates unit refresh (or edited by hand).
/// Updates refresh them only once the updater's own unit allows it, i.e.
/// after one reinstall.
fn stale_units_warning(caps: Option<&[String]>) -> Option<String> {
    caps?.iter().any(|c| c == "stale-units").then(|| {
        "服务器上的 systemd 单元文件（akari-agent.service / akari-agent-update.*）不是当前 agent \
         版本自带的版本（由旧版安装命令或旧版更新服务安装，或被手工修改），例如机器状态可能读不到。\
         请在服务器上重新运行一次安装命令（重装命令），之后的自更新会一并更新单元文件；\
         自定义设置请用 drop-in（/etc/systemd/system/akari-agent.service.d/）"
            .to_string()
    })
}

/// W18: a certificate the agent must obtain itself (the TLS domain + an
/// inbound reading the certificate files) for an agent too old to do it
/// (protocol 1..6): such an agent ignores ConfigSnapshot.acme and fails the
/// WHOLE snapshot when the files are missing. Refused at write time.
fn acme_needs_newer_agent(
    domain: Option<&str>,
    inbounds: &Value,
    protocol: Option<i32>,
) -> Option<i32> {
    let p = protocol.filter(|p| (1..crate::grpc::ACME_PROTOCOL).contains(p))?;
    (domain.is_some() && crate::nodetpl::needs_certificate(inbounds)).then_some(p)
}

/// Refuse (400) a TLS domain + certificate-reading inbound on a server
/// whose agent cannot obtain the certificate (`acme_needs_newer_agent`),
/// as stored now (call after the write, in its transaction).
pub async fn refuse_acme_for_old_agent(
    conn: &mut PgConnection,
    server: Uuid,
) -> Result<(), ApiError> {
    let row: Option<(Option<String>, Value, Option<i32>)> = sqlx::query_as(
        "SELECT s.tls_domain, coalesce((SELECT jsonb_agg(n.inbound) FROM nodes n \
            WHERE n.server_id = s.id AND n.inbound IS NOT NULL), '[]'::jsonb), \
         s.agent_protocol FROM servers s WHERE s.id = $1",
    )
    .bind(server)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((domain, inbounds, protocol)) = row else {
        return Ok(());
    };
    if let Some(p) = acme_needs_newer_agent(domain.as_deref(), &inbounds, protocol) {
        return Err(bad_request!(
            "node.acme_agent_too_old",
            "该服务器的 agent 版本过旧（协议 {p} < {need}），不支持自动证书：它会忽略服务器域名，并因缺少证书文件\
             导致整份配置下发失败。请先升级 agent（升级发布，或在服务器上重新运行一次安装命令），\
             或清空服务器域名并手动放置证书",
            p = p,
            need = crate::grpc::ACME_PROTOCOL
        ));
    }
    Ok(())
}

/// W10: what keeps the automatic certificate from working.
fn tls_domain_warnings(
    domain: Option<&str>,
    inbounds: &Value,
    protocol: Option<i32>,
) -> Vec<String> {
    let Some(domain) = domain else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if !crate::nodetpl::needs_certificate(inbounds) {
        return out;
    }
    if protocol.is_some_and(|p| p < crate::grpc::ACME_PROTOCOL) {
        out.push(format!(
            "agent 版本过旧（协议 < {}）：不会自动申请 {domain} 的证书，且在缺少证书文件时整份配置下发失败。\
             请先升级 agent（升级发布，或在服务器上重新运行一次安装命令），或手动放置 {domain} 的证书",
            crate::grpc::ACME_PROTOCOL
        ));
    }
    for i in inbounds.as_array().into_iter().flatten() {
        let uses_server_cert = i
            .pointer("/streamSettings/tlsSettings/certificates")
            .and_then(Value::as_array)
            .is_some_and(|c| {
                c.iter().any(|c| {
                    c.get("certificateFile").and_then(Value::as_str)
                        == Some(crate::nodetpl::TLS_CERT_FILE)
                })
            });
        let sni = i
            .pointer("/streamSettings/tlsSettings/serverName")
            .and_then(Value::as_str);
        if uses_server_cert && sni.is_some_and(|s| !s.eq_ignore_ascii_case(domain)) {
            out.push(format!(
                "入站的 serverName {:?} 不是服务器域名 {domain}，自动证书只覆盖 {domain}",
                sni.unwrap_or_default()
            ));
        }
    }
    out
}

fn cert_warning(
    not_after: Option<DateTime<Utc>>,
    protocol: Option<i32>,
    now: DateTime<Utc>,
) -> Option<String> {
    let left = not_after? - now;
    if left > chrono::Duration::days(CERT_WARN_DAYS) {
        return None;
    }
    let why = if protocol.unwrap_or(0) < 2 {
        "agent 版本过旧，不能续期（协议 < 2）：请升级 agent，或重新生成安装命令"
    } else {
        "agent 没有按时续期：请查看服务器上的 agent 日志"
    };
    let at = crate::api::beijing_time(not_after?);
    Some(if left <= chrono::Duration::zero() {
        format!("agent 证书已于 {at}（北京时间）过期；{why}")
    } else {
        format!(
            "agent 证书将在 {} 天后（{at}，北京时间）过期；{why}",
            left.num_days()
        )
    })
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// The per-server extras joined into server and node views (alias `s` =
/// the server): the live enrollment token (`enr`), the latency results
/// (`lat`), firing alerts (`al`) and the latest rollout entry (`ro`) — one
/// pass over each table instead of a probe per row (W14).
pub const SERVER_EXTRAS_FROM: &str = "\
     LEFT JOIN server_enrollments enr ON enr.server_id = s.id \
        AND enr.used_at IS NULL AND enr.expires_at > now() \
     LEFT JOIN (SELECT server_id, jsonb_agg(jsonb_build_object('source', l.source, \
        'target', l.target, 'delay_ms', l.delay_ms, 'error', l.error, \
        'measured_at', l.measured_at) ORDER BY l.source, l.ord) AS latency \
        FROM server_latency l GROUP BY server_id) lat ON lat.server_id = s.id \
     LEFT JOIN (SELECT server_id, count(*) AS n FROM server_alerts WHERE status = 'firing' \
        GROUP BY server_id) al ON al.server_id = s.id \
     LEFT JOIN (SELECT DISTINCT ON (rn.server_id) rn.server_id, jsonb_build_object( \
        'rollout_id', r.id, 'version', r.version, 'rollout_status', r.status, \
        'status', rn.status, 'detail', rn.detail, \
        'superseded', r.status NOT IN ('running','paused','halted') \
            AND coalesce(en.enrolled_at > greatest(r.created_at, rn.offered_at, \
                rn.finished_at), false)) AS update_status \
        FROM rollout_servers rn JOIN rollouts r ON r.id = rn.rollout_id \
        JOIN servers en ON en.id = rn.server_id \
        ORDER BY rn.server_id, r.created_at DESC) ro ON ro.server_id = s.id";

/// The machine columns of the server aliased `s`, as `ServerView` and
/// `nodes::NodeView` carry them (names prefixed as in the views).
pub fn server_cols() -> String {
    format!(
        "s.status, {online} AS online, s.agent_version, s.core_version, s.agent_os, \
         s.agent_arch, ro.update_status, s.config_version, s.user_version, \
         host(s.agent_addr) AS agent_addr, s.last_error, s.last_error_at, \
         s.failed_config_version, s.failed_user_version, s.lease_expires_at, \
         GREATEST(0, EXTRACT(EPOCH FROM s.lease_expires_at - now()))::bigint \
            AS lease_remaining_seconds, \
         s.traffic_max_rate_bytes_per_sec, s.deleting_at, s.last_seen_at, \
         s.cert_serial IS NOT NULL AS enrolled, enr.expires_at AS enroll_token_expires_at, \
         coalesce(lat.latency, '[]'::jsonb) AS latency, s.probe_requested_at, \
         coalesce(al.n, 0) AS alerts_firing, {warn}",
        online = crate::nodestat::online_sql("s"),
        warn = server_warn_cols(),
    )
}

/// The agent/machine state of a server (also embedded in every node view).
#[derive(sqlx::FromRow, Serialize)]
pub struct MachineView {
    pub status: String,
    /// W11: online by the reaper's rule (status online, refreshed within
    /// 90 s).
    pub online: bool,
    pub agent_version: Option<String>,
    pub core_version: Option<String>,
    /// M6: platform of the connected agent and its latest rollout entry
    /// ({rollout_id, version, rollout_status, status, detail, superseded};
    /// W23: superseded = the rollout is over and the server enrolled again
    /// after its last step there (a reinstall): history, not its state).
    pub agent_os: Option<String>,
    pub agent_arch: Option<String>,
    pub update_status: Option<Value>,
    pub config_version: i64,
    pub user_version: i64,
    /// W10: the agent's source address as the panel saw it.
    pub agent_addr: Option<String>,
    /// The agent's last failed apply (e.g. xray rejected the inbounds) and
    /// the versions it was attempting; null once an update applies cleanly.
    pub last_error: Option<String>,
    pub last_error_at: Option<DateTime<Utc>>,
    pub failed_config_version: Option<i64>,
    pub failed_user_version: Option<i64>,
    /// When the agent's fail-closed lease runs out (renewed while the panel
    /// can read the desired state), and the seconds left.
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub lease_remaining_seconds: Option<i64>,
    /// Billing plausibility cap override (bytes/s); null = global default.
    pub traffic_max_rate_bytes_per_sec: Option<i64>,
    /// Set while the server is being deleted (it disappears once done).
    pub deleting_at: Option<DateTime<Utc>>,
    pub last_seen_at: Option<DateTime<Utc>>,
    /// M1-8: whether the agent holds a certificate (enrolled) and the
    /// expiry of a live (unused) enrollment token.
    pub enrolled: bool,
    pub enroll_token_expires_at: Option<DateTime<Utc>>,
    /// W11 (`nodestat.rs`): latest latency results, last "立即测速".
    pub latency: Value,
    pub probe_requested_at: Option<DateTime<Utc>>,
    /// W17: alerts firing on this server.
    pub alerts_firing: i64,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub facts: WarnFacts,
}

/// One server as the admin API returns it: the machine state plus its
/// nodes (each with its entrances, `entrances::EntranceView` shape).
#[derive(sqlx::FromRow, Serialize)]
pub struct ServerView {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub machine: MachineView,
    /// The server's nodes: {id, name, display_name, enabled, visible, sort,
    /// region, tags, protocol, port, block_rules_enabled, entrances}.
    pub nodes: Value,
    /// Last heartbeat (Valkey, ~15 s cadence, 10 min TTL), passed through
    /// as stored.
    #[sqlx(skip)]
    pub heartbeat: Option<Box<serde_json::value::RawValue>>,
    /// Problems the admin must fix. Computed, not stored.
    #[sqlx(skip)]
    pub warnings: Vec<String>,
}

/// The server's nodes as JSON (alias `s` = the server; inner alias `nodes`
/// is what `entrances::ENTRANCES_JSON_SQL` expects).
fn nodes_json_sql() -> String {
    format!(
        "coalesce((SELECT jsonb_agg(jsonb_build_object('id', nodes.id, 'name', nodes.name, \
         'display_name', nodes.display_name, 'enabled', nodes.enabled, \
         'visible', nodes.visible, 'sort', nodes.sort, 'region', nodes.region, \
         'tags', nodes.tags, 'protocol', nodes.inbound->>'protocol', \
         'port', nodes.inbound->'port', 'block_rules_enabled', nodes.block_rules_enabled, \
         'entrances', {}) ORDER BY nodes.sort, nodes.created_at, nodes.id) \
         FROM nodes WHERE nodes.server_id = s.id), '[]'::jsonb)",
        crate::entrances::ENTRANCES_JSON_SQL
    )
}

fn server_view_sql(filter: &str) -> String {
    format!(
        "SELECT s.id, s.name, s.created_at, {}, {} AS nodes FROM servers s {SERVER_EXTRAS_FROM} \
         {filter} ORDER BY s.name, s.id",
        server_cols(),
        nodes_json_sql()
    )
}

/// Attach the last heartbeat of each server (one MGET; best effort) and
/// the warnings.
async fn finish(state: &AppState, mut views: Vec<ServerView>) -> Vec<ServerView> {
    use fred::prelude::KeysInterface;
    for v in &mut views {
        v.warnings = v.machine.facts.warnings();
    }
    if views.is_empty() {
        return views;
    }
    let keys: Vec<String> = views
        .iter()
        .map(|v| format!("akari:server:hb:{}", v.id))
        .collect();
    match state.valkey().mget::<Vec<Option<String>>, _>(keys).await {
        Ok(blobs) => {
            for (v, b) in views.iter_mut().zip(blobs) {
                v.warnings
                    .extend(b.as_deref().and_then(source_filter_warning));
                v.heartbeat = b.and_then(|b| serde_json::value::RawValue::from_string(b).ok());
            }
        }
        Err(e) => tracing::warn!(error = %e, "heartbeat lookup failed"),
    }
    views
}

/// GET /servers (admin): every server with its nodes and their entrances
/// (the grouped list: server -> nodes -> entrances), with an ETag (304 on
/// a match).
pub async fn list_servers(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, ServerView>(sqlx::AssertSqlSafe(server_view_sql("")))
        .fetch_all(state.pg())
        .await?;
    let body = serde_json::to_vec(&finish(&state, rows).await)?;
    Ok(crate::api::json_with_etag(&headers, body))
}

/// GET /servers/{id} (admin).
pub async fn get_server(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<ServerView>, ApiError> {
    user.require_admin()?;
    let row =
        sqlx::query_as::<_, ServerView>(sqlx::AssertSqlSafe(server_view_sql("WHERE s.id = $1")))
            .bind(id)
            .fetch_optional(state.pg())
            .await?
            .ok_or_else(ApiError::not_found)?;
    finish(&state, vec![row])
        .await
        .pop()
        .map(Json)
        .ok_or_else(ApiError::not_found)
}

// ---------------------------------------------------------------------------
// Create, enrollment
// ---------------------------------------------------------------------------

/// The one-time enrollment material returned by create / enroll-token: the
/// token and the complete bootstrap file (shown once; only the token's
/// SHA-256 is stored).
#[derive(Serialize)]
pub struct EnrollmentView {
    pub id: Uuid,
    pub name: String,
    pub enrollment_token: String,
    pub expires_at: DateTime<Utc>,
    pub bootstrap: String,
    /// The one-line install command (R18-2), when requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install: Option<crate::nodeinstall::InstallView>,
}

pub fn enrollment_view(
    state: &AppState,
    id: Uuid,
    name: String,
    token: String,
    expires_at: DateTime<Utc>,
    endpoint: &crate::settings::NodeEndpoint,
) -> EnrollmentView {
    let bootstrap = crate::enroll::bootstrap_toml(
        &name,
        &endpoint.panel_addr,
        &endpoint.server_name,
        &state.install().ca_pem,
        &token,
        expires_at,
    );
    EnrollmentView {
        id,
        name,
        enrollment_token: token,
        expires_at,
        bootstrap,
        install: None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateServerReq {
    pub name: String,
    /// W10: the server's TLS domain: the agent obtains its certificate
    /// automatically; TLS templates default to it.
    #[serde(default)]
    pub tls_domain: Option<String>,
    /// Issue an install link (one-line installer) instead of a 24 h
    /// bootstrap token; same token either way.
    #[serde(default)]
    pub install: Option<crate::nodeinstall::InstallReq>,
}

/// What `create_with_enrollment` needs from a create request.
pub struct NewServer<'a> {
    pub name: &'a str,
    pub tls_domain: Option<&'a str>,
}

/// A pending server with its first enrollment token (and install link) in
/// the caller's transaction: (id, token, expires, the endpoint, the
/// prepared install link). Audited `server.create` (+ `server.update` for
/// the TLS domain) + `server.enroll_token`.
pub async fn create_with_enrollment(
    conn: &mut PgConnection,
    state: &AppState,
    actor: &Actor,
    req: &NewServer<'_>,
    prepared: Option<&crate::nodeinstall::Prepared>,
) -> Result<(Uuid, String, DateTime<Utc>, crate::settings::NodeEndpoint), ApiError> {
    let tls_domain = match req.tls_domain.map(str::trim) {
        Some(d) if !d.is_empty() => Some(crate::nodetpl::node_tls_domain(d)?),
        _ => None,
    };
    let (ttl, link) = match prepared {
        Some(p) => (state.cfg().limits.install_token_ttl_secs, Some(p.link())),
        None => (state.cfg().limits.enroll_token_ttl_secs, None),
    };
    let endpoint = crate::settings::node_endpoint(conn, state.cfg()).await?;
    let (id, token, expires) =
        crate::enroll::apply_create_server(conn, actor, req.name, ttl, link, &endpoint).await?;
    if tls_domain.is_some() {
        apply_update(
            conn,
            actor,
            id,
            &UpdateServerReq {
                tls_domain: Some(tls_domain),
                ..Default::default()
            },
        )
        .await?;
    }
    Ok((id, token, expires, endpoint))
}

/// POST /servers (admin): a server (pending) with a one-time enrollment
/// token (M1-8) or install link (`install`), in one transaction. 201 with
/// the token, bootstrap file and install command (shown once). Nodes are
/// added with POST /nodes {server_id, ...}.
pub async fn create_server(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateServerReq>,
) -> Result<(StatusCode, Json<EnrollmentView>), ApiError> {
    user.require_admin()?;
    let prepared = match &req.install {
        Some(r) => Some(crate::nodeinstall::prepare(&state, r).await?),
        None => None,
    };
    let mut tx = state.pg().begin().await?;
    let (id, token, expires, endpoint) = create_with_enrollment(
        &mut tx,
        &state,
        &Actor::of(&user),
        &NewServer {
            name: &req.name,
            tls_domain: req.tls_domain.as_deref(),
        },
        prepared.as_ref(),
    )
    .await?;
    tx.commit().await?;
    let mut view = enrollment_view(
        &state,
        id,
        req.name.trim().to_string(),
        token.clone(),
        expires,
        &endpoint,
    );
    if let Some(p) = prepared {
        view.install = Some(crate::nodeinstall::view(&state, p, &token, expires).await?);
    }
    Ok((StatusCode::CREATED, Json(view)))
}

/// POST /servers/{id}/enroll-token (admin): a new one-time enrollment
/// token (replaces any unused one). Once the agent enrolls with it, the
/// server's previous certificates are revoked. 409 while deleting.
pub async fn issue_enroll_token(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<EnrollmentView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let endpoint = crate::settings::node_endpoint(&mut tx, state.cfg()).await?;
    let (token, expires) = crate::enroll::apply_issue_token(
        &mut tx,
        &Actor::of(&user),
        id,
        state.cfg().limits.enroll_token_ttl_secs,
        None,
        &endpoint,
    )
    .await?;
    let name: String = sqlx::query_scalar("SELECT name FROM servers WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(enrollment_view(
        &state, id, name, token, expires, &endpoint,
    )))
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
pub struct UpdateServerReq {
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    /// W10: the server's TLS domain (automatic certificate); null (or "")
    /// clears it (back to certificate files installed by hand). A change
    /// bumps config_version (the agent gets it with a Snapshot).
    #[serde(default, deserialize_with = "double_option")]
    pub tls_domain: Option<Option<String>>,
    /// Aggregate billing plausibility cap (bytes/s, > 0); null falls back
    /// to the built-in default.
    #[serde(default, deserialize_with = "double_option")]
    pub traffic_max_rate_bytes_per_sec: Option<Option<i64>>,
}

impl UpdateServerReq {
    fn has_fields(&self) -> bool {
        self.name.is_some()
            || self.tls_domain.is_some()
            || self.traffic_max_rate_bytes_per_sec.is_some()
    }
}

/// A server name: trimmed, 1..=64 characters without control characters.
pub fn clean_name(name: &str) -> Result<String, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(bad_request!(
            "server.name_invalid",
            "name must be 1-64 characters without control characters"
        ));
    }
    Ok(name.to_string())
}

/// PATCH /servers/{id} in the caller's transaction: lock the server, update,
/// bump config_version when the TLS domain changes, audit `server.update`.
/// Returns whether it bumped.
pub async fn apply_update(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &UpdateServerReq,
) -> Result<bool, ApiError> {
    if !req.has_fields() {
        return Err(bad_request!("request.no_fields", "no fields to update"));
    }
    let name = non_null("name", &req.name)?
        .map(|n| clean_name(&n))
        .transpose()?;
    let tls_domain: Option<Option<String>> = match &req.tls_domain {
        None => None,
        Some(d) => Some(match d.as_deref().map(str::trim) {
            Some(d) if !d.is_empty() => Some(crate::nodetpl::node_tls_domain(d)?),
            _ => None,
        }),
    };
    if let Some(Some(r)) = req.traffic_max_rate_bytes_per_sec
        && r <= 0
    {
        return Err(bad_request!(
            "node.max_rate_invalid",
            "traffic_max_rate_bytes_per_sec must be > 0"
        ));
    }
    lock_server(conn, id).await?;
    let mut qb = sqlx::QueryBuilder::new("UPDATE servers SET ");
    let mut set = qb.separated(", ");
    set.push("updated_at = now()");
    if let Some(v) = &tls_domain {
        set.push("tls_domain = ").push_bind_unseparated(v.clone());
        // The agent learns the domain from a Snapshot (ConfigSnapshot.acme).
        set.push(
            "config_version = config_version + \
             CASE WHEN tls_domain IS DISTINCT FROM ",
        )
        .push_bind_unseparated(v.clone())
        .push_unseparated(" THEN 1 ELSE 0 END");
    }
    if let Some(v) = name {
        set.push("name = ").push_bind_unseparated(v);
    }
    if let Some(v) = req.traffic_max_rate_bytes_per_sec {
        set.push("traffic_max_rate_bytes_per_sec = ")
            .push_bind_unseparated(v);
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.push(format!(
        " RETURNING {}, {}, old.config_version <> new.config_version",
        crate::audit::server_snapshot_sql("old"),
        crate::audit::server_snapshot_sql("new")
    ));
    let (before, after, bumped) = match qb
        .build_query_as::<(Value, Value, bool)>()
        .fetch_one(&mut *conn)
        .await
    {
        Ok(r) => r,
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            return Err(conflict!(
                "server.name_exists",
                "a server with this name exists"
            ));
        }
        Err(e) => return Err(e.into()),
    };
    if bumped {
        refuse_acme_for_old_agent(conn, id).await?;
    }
    crate::audit::record(
        conn,
        actor,
        "server.update",
        "server",
        Some(id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(bumped)
}

/// PATCH /servers/{id} (admin).
pub async fn update_server(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<UpdateServerReq>,
) -> Result<Json<ServerView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_update(&mut tx, &Actor::of(&user), id, &req).await?;
    tx.commit().await?;
    get_server(State(state), user, Path((String::new(), id))).await
}

// ---------------------------------------------------------------------------
// Delete (two phases, R12 D1)
// ---------------------------------------------------------------------------

/// Phase 1 of a server deletion, in the caller's transaction: lock the
/// server, mark it deleting (it then serves the empty state: every node of
/// it) and bump config_version, so the agent (wherever it is connected)
/// converges to the empty state and acks it; its final counters are still
/// billed (entrance_users is untouched). Phase 2 (`crate::reaper`) revokes
/// the certificates and deletes the row with its nodes. Idempotent.
/// Returns whether this call started the deletion.
pub async fn apply_begin_delete(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<bool, ApiError> {
    let deleting: Option<bool> =
        sqlx::query_scalar("SELECT deleting_at IS NOT NULL FROM servers WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    match deleting {
        None => Err(ApiError::not_found()),
        Some(true) => Ok(false),
        Some(false) => {
            let before: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "UPDATE servers SET deleting_at = now(), delete_acked_at = NULL, \
                 config_version = config_version + 1, updated_at = now() WHERE id = $1 \
                 RETURNING {}",
                crate::audit::server_snapshot_sql("old")
            )))
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;
            crate::audit::record(
                conn,
                actor,
                "server.delete",
                "server",
                Some(id.to_string()),
                Some(before),
                Some(json!({ "phase": "deleting" })),
            )
            .await?;
            Ok(true)
        }
    }
}

/// DELETE /servers/{id}: phase 1 (`apply_begin_delete`). 202: the server
/// and its nodes disappear once the agent acked the empty state (or after
/// a timeout, or at once if no agent is online), on any panel instance.
pub async fn delete_server(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let started = apply_begin_delete(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    if started {
        tracing::info!(server = %id, "server deletion started");
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "id": id, "deleting": true })),
    ))
}

#[cfg(test)]
mod tests;
