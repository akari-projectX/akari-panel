//! Nodes (admin API): one inbound (protocol) on a server (D2, Q1).
//!
//! A node carries its inbound (`nodes.inbound`), its display fields
//! (region, display name, sort, visibility, tags; W11 `nodemeta.rs`), its
//! enable switch and its entrances (`entrances.rs`); the machine — agent,
//! certificate, versions, metrics, TLS domain — is its server
//! (`servers.rs`). Node views embed their server's machine state, so a
//! node page shows whether its agent is online.
//!
//! What changes the agent's desired state bumps the node's SERVER in the
//! same transaction: enabling/disabling a node, its inbound, creating or
//! deleting it. Lock order: entitlement lock (when access changes) ->
//! the server (`servers::lock_server_of`) -> the node -> users ->
//! entrance_users.

use crate::auth::{bad_request, conflict};

use axum::Json;
use axum::extract::{Path, Query, State};
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
use crate::servers::{MachineView, SERVER_EXTRAS_FROM};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// One node as the admin API returns it, with its server's machine state.
#[derive(sqlx::FromRow, Serialize)]
pub struct NodeView {
    id: Uuid,
    /// Q1: the server (machine, agent) the node runs on.
    server_id: Uuid,
    server_name: String,
    name: String,
    enabled: bool,
    /// W28-a (D2): the node's one inbound (xray inbound object without a
    /// tag); null = not configured yet.
    inbound: Option<Value>,
    /// W28-a: how clients reach the node (`entrances::EntranceView` shape;
    /// the built-in direct entrance first).
    entrances: Value,
    /// M3: free-text region shown to users (portal node list).
    region: Option<String>,
    /// W11 (xboard-style form, `nodemeta.rs`): user-facing name (null =
    /// `name`), display order, shown to users. `tags`: legacy node-level
    /// labels, shown nowhere since tags moved to entrances (1104).
    display_name: Option<String>,
    sort: i32,
    visible: bool,
    tags: Vec<String>,
    /// W29: block rules on for this node's inbound.
    block_rules_enabled: bool,
    /// W11: bytes accepted on this node (before the multipliers) and billed
    /// to users (after them).
    traffic_raw_bytes: i64,
    traffic_billed_bytes: i64,
    created_at: DateTime<Utc>,
    #[sqlx(flatten)]
    #[serde(flatten)]
    machine: MachineView,
    /// The server's last heartbeat (Valkey, ~15 s cadence, 10 min TTL),
    /// passed through as stored (validated JSON, W14).
    #[sqlx(skip)]
    heartbeat: Option<Box<serde_json::value::RawValue>>,
    /// Problems with the stored configuration the admin must fix (the
    /// node's inbound and its server's). Computed, not stored.
    #[sqlx(skip)]
    warnings: Vec<String>,
}

impl NodeView {
    fn with_warnings(mut self) -> Self {
        self.warnings = self
            .inbound
            .as_ref()
            .and_then(crate::api::inbound_warning)
            .into_iter()
            .collect();
        self.warnings.extend(self.machine.facts.warnings());
        self
    }
}

/// `SELECT {node_view_cols} {NODE_VIEW_FROM} ...`.
fn node_view_cols() -> String {
    format!(
        "nodes.id, nodes.server_id, s.name AS server_name, nodes.name, nodes.enabled, \
         nodes.inbound, {} AS entrances, nodes.region, nodes.display_name, nodes.sort, \
         nodes.visible, nodes.tags, nodes.block_rules_enabled, nodes.traffic_raw_bytes, \
         nodes.traffic_billed_bytes, nodes.created_at, {}",
        crate::entrances::ENTRANCES_JSON_SQL,
        crate::servers::server_cols(),
    )
}

/// The FROM clause that goes with `node_view_cols` (filters on `nodes.`).
fn node_view_from() -> String {
    format!("FROM nodes JOIN servers s ON s.id = nodes.server_id {SERVER_EXTRAS_FROM}")
}

/// The full list query (also `akari-bench explain`).
pub fn node_list_sql() -> String {
    format!(
        "SELECT {} {} ORDER BY nodes.sort, nodes.created_at, nodes.id",
        node_view_cols(),
        node_view_from()
    )
}

/// Attach the server heartbeats (one MGET; best effort).
async fn with_heartbeats(state: &AppState, mut views: Vec<NodeView>) -> Vec<NodeView> {
    use fred::prelude::KeysInterface;
    if views.is_empty() {
        return views;
    }
    let keys: Vec<String> = views
        .iter()
        .map(|v| format!("akari:server:hb:{}", v.server_id))
        .collect();
    match state.valkey().mget::<Vec<Option<String>>, _>(keys).await {
        Ok(blobs) => {
            for (v, b) in views.iter_mut().zip(blobs) {
                v.warnings
                    .extend(b.as_deref().and_then(crate::servers::source_filter_warning));
                v.heartbeat = b.and_then(|b| serde_json::value::RawValue::from_string(b).ok());
            }
        }
        Err(e) => tracing::warn!(error = %e, "heartbeat lookup failed"),
    }
    views
}

/// W17: one row of `GET /nodes?view=summary` — only what the node list
/// shows: no inbound JSON, no full latency set, a slim heartbeat. Fields
/// that tick every second (lease remaining) are left to the client
/// (`lease_expires_at`), so the ETag stays put between heartbeats.
#[derive(sqlx::FromRow, Serialize)]
pub struct NodeSummary {
    id: Uuid,
    server_id: Uuid,
    server_name: String,
    name: String,
    display_name: Option<String>,
    enabled: bool,
    status: String,
    online: bool,
    deleting_at: Option<DateTime<Utc>>,
    region: Option<String>,
    agent_version: Option<String>,
    agent_os: Option<String>,
    agent_arch: Option<String>,
    update_status: Option<Value>,
    lease_expires_at: Option<DateTime<Utc>>,
    enrolled: bool,
    enroll_token_expires_at: Option<DateTime<Utc>>,
    last_seen_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
    sort: i32,
    visible: bool,
    tags: Vec<String>,
    /// W28-a: the node's entrances (as in NodeView).
    entrances: Value,
    /// The agent's best url-test result (first success in order, else the
    /// first result), as the list's latency badge shows it.
    latency: Option<Value>,
    /// W17: alerts firing on the node's server.
    alerts_firing: i64,
    #[sqlx(flatten)]
    #[serde(flatten)]
    facts: crate::servers::WarnFacts,
    #[sqlx(skip)]
    warnings: Vec<String>,
    /// Some inbound needs the server's TLS certificate (install card hint).
    #[sqlx(skip)]
    needs_certificate: bool,
    #[sqlx(skip)]
    heartbeat: Option<HeartbeatSummary>,
    #[serde(skip)]
    inbound: Option<Value>,
}

/// The heartbeat fields the list shows.
#[derive(Deserialize, Serialize, Debug, PartialEq)]
pub struct HeartbeatSummary {
    // W23: null = the agent could not read it.
    #[serde(default)]
    cpu_percent: Option<f64>,
    #[serde(default)]
    mem_used_bytes: Option<u64>,
    #[serde(default)]
    mem_total_bytes: Option<u64>,
    connections: u64,
    #[serde(default)]
    uptime_seconds: Option<u64>,
    ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metrics: Option<HeartbeatMetricsSummary>,
}

#[derive(Deserialize, Serialize, Debug, PartialEq)]
pub struct HeartbeatMetricsSummary {
    #[serde(default)]
    net_rx_bytes_per_sec: Option<u64>,
    #[serde(default)]
    net_tx_bytes_per_sec: Option<u64>,
    online_users: u64,
}

/// The summary list query (also `akari-bench explain`).
pub fn node_summary_sql() -> String {
    format!(
        "SELECT nodes.id, nodes.server_id, s.name AS server_name, nodes.name, \
         nodes.display_name, nodes.enabled, s.status, {online} AS online, s.deleting_at, \
         nodes.region, s.agent_version, s.agent_os, s.agent_arch, ro.update_status, \
         s.lease_expires_at, s.cert_serial IS NOT NULL AS enrolled, \
         enr.expires_at AS enroll_token_expires_at, s.last_seen_at, s.last_error, nodes.sort, \
         nodes.visible, nodes.tags, {entrances} AS entrances, lb.latency, \
         coalesce(al.n, 0) AS alerts_firing, nodes.inbound, {warn} \
         FROM nodes JOIN servers s ON s.id = nodes.server_id {SERVER_EXTRAS_FROM} \
         LEFT JOIN (SELECT DISTINCT ON (l.server_id) l.server_id, jsonb_build_object( \
            'source', l.source, 'target', l.target, 'delay_ms', l.delay_ms, \
            'error', l.error, 'measured_at', l.measured_at) AS latency \
            FROM server_latency l WHERE l.source = 'agent' \
            ORDER BY l.server_id, (l.delay_ms IS NULL), l.ord) lb ON lb.server_id = s.id \
         ORDER BY nodes.sort, nodes.created_at, nodes.id",
        online = crate::nodestat::online_sql("s"),
        entrances = crate::entrances::ENTRANCES_JSON_SQL,
        warn = crate::servers::server_warn_cols(),
    )
}

impl NodeSummary {
    fn finish(mut self, blob: Option<String>) -> Self {
        self.warnings = self
            .inbound
            .as_ref()
            .and_then(crate::api::inbound_warning)
            .into_iter()
            .collect();
        self.warnings.extend(self.facts.warnings());
        self.warnings.extend(
            blob.as_deref()
                .and_then(crate::servers::source_filter_warning),
        );
        self.needs_certificate =
            crate::nodetpl::needs_certificate(&inbounds_of(self.inbound.as_ref()));
        self.heartbeat = blob.and_then(|b| serde_json::from_str(&b).ok());
        self
    }
}

/// The node's inbound as an inbounds array (`[]` without one), for the
/// helpers that look at every inbound an agent runs.
pub(crate) fn inbounds_of(inbound: Option<&Value>) -> Value {
    Value::Array(inbound.into_iter().cloned().collect())
}

/// The summary rows with their slim heartbeats (one MGET; best effort).
pub async fn node_summaries(state: &AppState) -> Result<Vec<NodeSummary>, ApiError> {
    use fred::prelude::KeysInterface;
    let rows = sqlx::query_as::<_, NodeSummary>(sqlx::AssertSqlSafe(node_summary_sql()))
        .fetch_all(state.pg())
        .await?;
    if rows.is_empty() {
        return Ok(rows);
    }
    let keys: Vec<String> = rows
        .iter()
        .map(|v| format!("akari:server:hb:{}", v.server_id))
        .collect();
    let blobs = match state.valkey().mget::<Vec<Option<String>>, _>(keys).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, "heartbeat lookup failed");
            Vec::new()
        }
    };
    let mut blobs = blobs.into_iter();
    Ok(rows
        .into_iter()
        .map(|r| r.finish(blobs.next().flatten()))
        .collect())
}

#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct NodeListQuery {
    /// `summary` (W17: the list's columns only) or `full` (default).
    #[serde(default)]
    pub view: Option<String>,
}

/// GET /nodes[?view=summary|full] (admin), with an ETag (304 on a match).
pub async fn list_nodes(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<NodeListQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    user.require_admin()?;
    let body = match q.view.as_deref() {
        None | Some("full") => {
            let rows = sqlx::query_as::<_, NodeView>(sqlx::AssertSqlSafe(node_list_sql()))
                .fetch_all(state.pg())
                .await?;
            let views = rows.into_iter().map(NodeView::with_warnings).collect();
            serde_json::to_vec(&with_heartbeats(&state, views).await)?
        }
        Some("summary") => serde_json::to_vec(&node_summaries(&state).await?)?,
        Some(_) => {
            return Err(bad_request!(
                "node.view_invalid",
                "view must be summary or full"
            ));
        }
    };
    Ok(crate::api::json_with_etag(&headers, body))
}

async fn node_view(state: &AppState, id: Uuid) -> Result<NodeView, ApiError> {
    let row = sqlx::query_as::<_, NodeView>(sqlx::AssertSqlSafe(format!(
        "SELECT {} {} WHERE nodes.id = $1",
        node_view_cols(),
        node_view_from()
    )))
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    with_heartbeats(state, vec![row.with_warnings()])
        .await
        .pop()
        .ok_or_else(ApiError::not_found)
}

/// GET /nodes/{id} (admin): one node, full view (the node page).
pub async fn get_node(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<NodeView>, ApiError> {
    user.require_admin()?;
    Ok(Json(node_view(&state, id).await?))
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateNodeReq {
    /// Q1: the server to add the node to (it shares the server's agent,
    /// TLS domain and ports). Absent = a new server named like the node,
    /// with its first enrollment token (or install link) — one protocol
    /// per machine in one step.
    #[serde(default)]
    pub server_id: Option<Uuid>,
    pub name: String,
    #[serde(default)]
    pub region: Option<String>,
    /// New server only: its TLS domain (automatic certificate; TLS
    /// templates default to it) ...
    #[serde(default)]
    pub tls_domain: Option<String>,
    /// ... and an install link (one-line installer) instead of a 24 h
    /// bootstrap token.
    #[serde(default)]
    pub install: Option<crate::nodeinstall::InstallReq>,
    /// W28-a (D2): the node's one inbound, from a template
    /// (`nodetpl::InboundSpec`) ...
    #[serde(default)]
    pub template: Option<crate::nodetpl::InboundSpec>,
    /// ... or as a raw xray inbound object (not both).
    #[serde(default)]
    pub inbound: Option<Value>,
    /// W11 form fields (see UpdateNodeReq).
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub sort: Option<i32>,
    #[serde(default)]
    pub visible: Option<bool>,
    /// Legacy node-level labels (shown nowhere; 1104 moved tags to
    /// entrances: `direct.tags`).
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// W28-a: settings of the built-in direct entrance (address, port,
    /// multiplier, groups; as PATCH /entrances/{id}).
    #[serde(default)]
    pub direct: Option<crate::entrances::EntranceReq>,
}

/// What POST /nodes returns: the node and its server, plus — when the call
/// created the server — the one-time enrollment material (shown once).
#[derive(Serialize)]
pub struct CreatedNode {
    id: Uuid,
    server_id: Uuid,
    name: String,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    enrollment: Option<Enrollment>,
}

#[derive(Serialize)]
struct Enrollment {
    enrollment_token: String,
    expires_at: DateTime<Utc>,
    bootstrap: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    install: Option<crate::nodeinstall::InstallView>,
}

/// Ports the server already serves (node inbounds and relay listen ports),
/// for template rendering (`nodetpl::render`'s `taken`).
async fn taken_ports(conn: &mut PgConnection, server: Uuid) -> sqlx::Result<Vec<u16>> {
    let ports: Vec<i32> = sqlx::query_scalar(
        "SELECT (inbound->>'port')::int FROM nodes WHERE server_id = $1 \
           AND jsonb_typeof(inbound->'port') = 'number' \
         UNION SELECT listen_port FROM entrances WHERE server_id = $1 AND listen_port IS NOT NULL",
    )
    .bind(server)
    .fetch_all(conn)
    .await?;
    Ok(ports
        .into_iter()
        .filter_map(|p| u16::try_from(p).ok())
        .collect())
}

/// Insert a node on a locked server (its direct entrance follows from the
/// trigger), audited `node.create`.
async fn insert_node(
    conn: &mut PgConnection,
    actor: &Actor,
    server: Uuid,
    name: &str,
) -> Result<Uuid, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(bad_request!(
            "node.name_invalid",
            "name must be 1-64 characters without control characters"
        ));
    }
    let id = Uuid::new_v4();
    let inserted = sqlx::query(
        "INSERT INTO nodes (id, server_id, name) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING",
    )
    .bind(id)
    .bind(server)
    .bind(name)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Err(conflict!(
            "node.name_exists",
            "a node with this name exists"
        ));
    }
    crate::audit::record(
        conn,
        actor,
        "node.create",
        "node",
        Some(id.to_string()),
        None,
        Some(json!({ "name": name, "server_id": server })),
    )
    .await?;
    Ok(id)
}

/// POST /nodes (admin): a node — on an existing server (`server_id`) or
/// with a new server of the same name and its one-time enrollment token /
/// install link (R18-2: `install`) — with optional region, its inbound (a
/// template rendered server-side, or raw JSON — same validation as PUT
/// inbound), the direct entrance's settings (W28-a), all in one
/// transaction. 201.
pub async fn create_node(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateNodeReq>,
) -> Result<(StatusCode, Json<CreatedNode>), ApiError> {
    user.require_admin()?;
    if req.server_id.is_some() && (req.tls_domain.is_some() || req.install.is_some()) {
        return Err(bad_request!(
            "node.server_fields",
            "tls_domain and install belong to the server (PATCH /servers/{{id}}, POST /servers/{{id}}/install)"
        ));
    }
    if req.template.is_some() && req.inbound.is_some() {
        return Err(bad_request!(
            "node.template_and_inbound",
            "give either template or inbound, not both"
        ));
    }
    let prepared = match &req.install {
        Some(r) => Some(crate::nodeinstall::prepare(&state, r).await?),
        None => None,
    };
    let actor = Actor::of(&user);
    let mut tx = state.pg().begin().await?;
    let direct = req.direct.as_ref().filter(|d| !d.is_empty());
    if req.template.is_some()
        || req.inbound.is_some()
        || direct.is_some_and(|d| d.group_ids.is_some())
    {
        // Lock order: the entitlement lock before any row (set_inbound and
        // the entrance update take it again; advisory xact locks nest).
        crate::entitle::lock(&mut tx).await?;
    }
    let (server, enrollment) = match req.server_id {
        Some(s) => {
            crate::servers::lock_server(&mut tx, s).await?;
            (s, None)
        }
        None => {
            let (s, token, expires, endpoint) = crate::servers::create_with_enrollment(
                &mut tx,
                &state,
                &actor,
                &crate::servers::NewServer {
                    name: &req.name,
                    tls_domain: req.tls_domain.as_deref(),
                },
                prepared.as_ref(),
            )
            .await?;
            (s, Some((token, expires, endpoint)))
        }
    };
    let id = insert_node(&mut tx, &actor, server, &req.name).await?;
    let w11 = UpdateNodeReq {
        region: req.region.clone().map(Some),
        display_name: req.display_name.clone().map(Some),
        sort: req.sort.map(Some),
        visible: req.visible.map(Some),
        tags: req.tags.clone().map(Some),
        ..Default::default()
    };
    if w11.has_fields() {
        apply_update_node(&mut tx, &actor, id, &w11).await?;
    }
    if let Some(d) = direct {
        let entrance = crate::entrances::direct_of(&mut tx, id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("node {id} has no direct entrance"))?;
        crate::entrances::apply_update(&mut tx, &actor, entrance, d).await?;
    }
    let inbound = match (&req.template, &req.inbound) {
        (Some(t), _) => {
            let domain: Option<String> =
                sqlx::query_scalar("SELECT tls_domain FROM servers WHERE id = $1")
                    .bind(server)
                    .fetch_one(&mut *tx)
                    .await?;
            let taken = taken_ports(&mut tx, server).await?;
            Some(crate::nodetpl::render(t, &taken, domain.as_deref())?)
        }
        (None, Some(raw)) => Some(raw.clone()),
        (None, None) => None,
    };
    if let Some(i) = &inbound {
        apply_set_inbound(&mut tx, &actor, id, Some(i)).await?;
    }
    tx.commit().await?;
    let name = req.name.trim().to_string();
    let enrollment = match enrollment {
        None => None,
        Some((token, expires, endpoint)) => {
            let v = crate::servers::enrollment_view(
                &state,
                server,
                name.clone(),
                token.clone(),
                expires,
                &endpoint,
            );
            let install = match prepared {
                Some(p) => Some(crate::nodeinstall::view(&state, p, &token, expires).await?),
                None => None,
            };
            Some(Enrollment {
                enrollment_token: v.enrollment_token,
                expires_at: v.expires_at,
                bootstrap: v.bootstrap,
                install,
            })
        }
    };
    Ok((
        StatusCode::CREATED,
        Json(CreatedNode {
            id,
            server_id: server,
            name,
            enrollment,
        }),
    ))
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct UpdateNodeReq {
    #[serde(default, deserialize_with = "double_option")]
    pub enabled: Option<Option<bool>>,
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    /// M3: region shown to users; null (or "") clears it. <= 64 chars.
    #[serde(default, deserialize_with = "double_option")]
    pub region: Option<Option<String>>,
    /// W11 (`nodemeta.rs`): user-facing name; null (or "") = `name`.
    #[serde(default, deserialize_with = "double_option")]
    pub display_name: Option<Option<String>>,
    /// Display order (ascending).
    #[serde(default, deserialize_with = "double_option")]
    pub sort: Option<Option<i32>>,
    /// Shown to users (portal, subscription); hidden nodes keep serving.
    #[serde(default, deserialize_with = "double_option")]
    pub visible: Option<Option<bool>>,
    /// Legacy node-level labels ([] clears; shown nowhere since 1104:
    /// tags are per entrance).
    #[serde(default, deserialize_with = "double_option")]
    pub tags: Option<Option<Vec<String>>>,
}

impl UpdateNodeReq {
    fn has_fields(&self) -> bool {
        self.enabled.is_some()
            || self.name.is_some()
            || self.region.is_some()
            || self.display_name.is_some()
            || self.sort.is_some()
            || self.visible.is_some()
            || self.tags.is_some()
    }
}

/// PATCH /nodes/{id} in the caller's transaction: lock the server, then
/// the node; disabling AND enabling bump the server's config_version (a
/// disabled node contributes no inbound and no users), so the agent
/// converges either way; display fields do not bump. Audited
/// `node.update`. Returns whether it bumped.
pub(crate) async fn apply_update_node(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &UpdateNodeReq,
) -> Result<bool, ApiError> {
    let enabled = non_null("enabled", &req.enabled)?;
    let name = non_null("name", &req.name)?;
    if !req.has_fields() {
        return Err(bad_request!("request.no_fields", "no fields to update"));
    }
    // W11 fields (validated before any row is touched).
    let display_name = req
        .display_name
        .as_ref()
        .map(|d| crate::nodemeta::display_name(d.as_deref()))
        .transpose()?;
    let sort = non_null("sort", &req.sort)?
        .map(crate::nodemeta::sort)
        .transpose()?;
    let visible = non_null("visible", &req.visible)?;
    let tags = non_null("tags", &req.tags)?
        .map(|t| crate::nodemeta::tags(&t))
        .transpose()?;
    let name = match name {
        Some(n) if n.trim().is_empty() => {
            return Err(bad_request!("node.name_empty", "name must not be empty"));
        }
        n => n.map(|n| n.trim().to_string()),
    };
    let region: Option<Option<String>> = req.region.as_ref().map(|r| {
        r.as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(String::from)
    });
    if region
        .as_ref()
        .is_some_and(|r| r.as_ref().is_some_and(|r| r.chars().count() > 64))
    {
        return Err(bad_request!(
            "node.region_long",
            "region must be at most 64 characters"
        ));
    }
    let server = crate::servers::lock_server_of(conn, id).await?;
    let mut qb = sqlx::QueryBuilder::new("UPDATE nodes SET ");
    let mut set = qb.separated(", ");
    set.push("updated_at = now()");
    if let Some(v) = enabled {
        set.push("enabled = ").push_bind_unseparated(v);
    }
    if let Some(v) = name {
        set.push("name = ").push_bind_unseparated(v);
    }
    if let Some(v) = region {
        set.push("region = ").push_bind_unseparated(v);
    }
    if let Some(v) = display_name {
        set.push("display_name = ").push_bind_unseparated(v);
    }
    if let Some(v) = sort {
        set.push("sort = ").push_bind_unseparated(v);
    }
    if let Some(v) = visible {
        set.push("visible = ").push_bind_unseparated(v);
    }
    if let Some(v) = tags {
        set.push("tags = ").push_bind_unseparated(v);
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.push(format!(
        " RETURNING {}, {}, old.enabled <> new.enabled",
        crate::audit::node_snapshot_sql("old"),
        crate::audit::node_snapshot_sql("new")
    ));
    let (before, after, toggled) = match qb
        .build_query_as::<(Value, Value, bool)>()
        .fetch_one(&mut *conn)
        .await
    {
        Ok(r) => r,
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            return Err(conflict!("node.name_exists", "node name already exists"));
        }
        Err(e) => return Err(e.into()),
    };
    if toggled {
        crate::servers::bump_config(conn, server).await?;
    }
    crate::audit::record(
        conn,
        actor,
        "node.update",
        "node",
        Some(id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(toggled)
}

pub async fn update_node(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<UpdateNodeReq>,
) -> Result<Json<NodeView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_update_node(&mut tx, &Actor::of(&user), id, &req).await?;
    tx.commit().await?;
    Ok(Json(node_view(&state, id).await?))
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/// Delete a node in the caller's transaction (its server stays): the
/// entitlement lock, the server row, then the node — its entrances, their
/// credentials and group memberships cascade — and the server's
/// config_version is bumped (the agent drops the node's inbounds and their
/// users with the next Snapshot). Counters the agent reports for those
/// entrances after this commit are not billed (their rows are gone: at
/// most one report interval per user, never over-billing). 409 while the
/// server is being deleted (it goes away with it). Audited `node.delete`.
pub(crate) async fn apply_delete_node(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<(), ApiError> {
    crate::entitle::lock(conn).await?;
    let server = crate::servers::lock_server_of(conn, id).await?;
    let before: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "DELETE FROM nodes WHERE id = $1 RETURNING {}",
        crate::audit::node_snapshot_sql("nodes")
    )))
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    crate::servers::bump_config(conn, server).await?;
    crate::audit::record(
        conn,
        actor,
        "node.delete",
        "node",
        Some(id.to_string()),
        Some(before),
        None,
    )
    .await?;
    Ok(())
}

/// DELETE /nodes/{id} (admin): 204.
pub async fn delete_node(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_delete_node(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetInboundReq {
    /// The node's xray inbound (an object; its tag, if any, is dropped:
    /// the panel names the inbounds it renders); null removes it.
    pub inbound: Option<Value>,
}

/// Replace a node's inbound (None removes it) and, in the same
/// transaction, reconcile its entrances' credentials: accounts of the same
/// protocol are kept (refit: a VLESS flow follows the inbound, a
/// Shadowsocks key of the wrong length is reissued), others are reissued,
/// and without an issuable inbound every row goes (departed). The port must
/// not clash with anything on the server (every node's inbound and relay
/// port). Bumps the server's config_version (the agent gets the new
/// inbound with a Snapshot). Returns the server's new config_version.
pub(crate) async fn apply_set_inbound(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    inbound: Option<&Value>,
) -> Result<i64, ApiError> {
    let inbound = inbound.map(crate::api::normalize_inbound).transpose()?;
    crate::entitle::lock(conn).await?;
    let server = crate::servers::lock_server_of(conn, id).await?;
    // W28-a: the relay entrances' derived inbounds take this inbound's
    // protocol on their own ports.
    if let Some(ib) = &inbound {
        crate::entrances::port_clash(conn, server, Some(id), ib, None).await?;
    }
    let old: Option<Value> = sqlx::query_scalar(
        "UPDATE nodes SET inbound = $2, updated_at = now() WHERE id = $1 RETURNING old.inbound",
    )
    .bind(id)
    .bind(&inbound)
    .fetch_one(&mut *conn)
    .await?;
    let version: i64 = sqlx::query_scalar(
        "UPDATE servers SET config_version = config_version + 1 WHERE id = $1 \
         RETURNING config_version",
    )
    .bind(server)
    .fetch_one(&mut *conn)
    .await?;
    crate::servers::refuse_acme_for_old_agent(conn, server).await?;
    let plan = crate::entitle::apply_reconcile(conn, crate::entitle::Scope::Nodes(&[id])).await?;
    let mut after = json!({ "inbound": crate::audit::inbound_summary(inbound.as_ref()) });
    after["entitlement"] = plan.summary();
    crate::audit::record(
        conn,
        actor,
        "node.set_inbound",
        "node",
        Some(id.to_string()),
        Some(json!({ "inbound": crate::audit::inbound_summary(old.as_ref()) })),
        Some(after),
    )
    .await?;
    Ok(version)
}

/// PUT /nodes/{id}/inbound (admin).
pub async fn set_inbound(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<SetInboundReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let version = apply_set_inbound(&mut tx, &Actor::of(&user), id, req.inbound.as_ref()).await?;
    tx.commit().await?;
    Ok(Json(json!({ "config_version": version })))
}
