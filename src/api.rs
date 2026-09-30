use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::auth::{self, ApiError, AuthUser, COOKIE_NAME};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginReq {
    pub login: String,
    pub password: String,
}

const LOGIN_RATE_LIMIT: i64 = 20;
const LOGIN_RATE_WINDOW_SECS: i64 = 900;

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    jar: CookieJar,
    Json(req): Json<LoginReq>,
) -> Result<(CookieJar, Json<serde_json::Value>), ApiError> {
    // Fixed-window per-IP limit; failures and successes both count.
    let key = format!("akari:rl:login:{}", addr.ip());
    use fred::prelude::*;
    let count: i64 = state.valkey().incr(key.clone()).await.map_err(|e| {
        tracing::error!(error = %e, "valkey incr failed");
        ApiError::internal()
    })?;
    if count == 1 {
        let _: i64 = state
            .valkey()
            .expire(key, LOGIN_RATE_WINDOW_SECS, None)
            .await
            .unwrap_or(0);
    }
    if count > LOGIN_RATE_LIMIT {
        return Err(ApiError::too_many());
    }
    if req.login.is_empty() || req.password.is_empty() {
        return Err(ApiError::bad_request("login and password are required"));
    }

    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        login: String,
        role: String,
        enabled: bool,
        expired: bool,
        password_hash: Option<String>,
    }
    // Expiry applies to role=user only (an admin must never lock themselves
    // out by a date).
    let row = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(format!(
        "SELECT u.id, u.login, u.role, u.enabled, u.password_hash, {} AS expired \
             FROM users u WHERE u.login = $1",
        crate::enforce::EXPIRED
    )))
    .bind(&req.login)
    .fetch_optional(state.pg())
    .await?;

    let Some(row) = row.filter(|r| r.enabled && !r.expired && r.password_hash.is_some()) else {
        auth::scrub_password(&req.password);
        return Err(ApiError::unauthorized());
    };
    let hash = row.password_hash.unwrap_or_default();
    if !auth::verify_password(&req.password, &hash) {
        return Err(ApiError::unauthorized());
    }

    let token = auth::issue_token(&state, row.id, &row.role)?;
    // Secure cookies everywhere except loopback binds (development).
    let secure = !state.cfg().web.bind.ip().is_loopback();
    let cookie = Cookie::build((COOKIE_NAME, token))
        .http_only(true)
        .same_site(SameSite::Strict)
        .path("/")
        .secure(secure)
        .max_age(time::Duration::seconds(auth::COOKIE_TTL_SECS))
        .build();
    Ok((
        jar.add(cookie),
        Json(json!({ "id": row.id, "login": row.login, "role": row.role })),
    ))
}

pub async fn logout(jar: CookieJar) -> (CookieJar, Json<serde_json::Value>) {
    let expired = Cookie::build(COOKIE_NAME)
        .path("/")
        .max_age(time::Duration::ZERO);
    (jar.add(expired.build()), Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Self
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct MeRow {
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct MeView {
    id: Uuid,
    login: String,
    role: String,
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
}

pub async fn me(State(state): State<AppState>, user: AuthUser) -> Result<Json<MeView>, ApiError> {
    let row = sqlx::query_as::<_, MeRow>(
        "SELECT traffic_used_bytes, traffic_limit_bytes, expires_at FROM users WHERE id = $1",
    )
    .bind(user.id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    Ok(Json(MeView {
        id: user.id,
        login: user.login,
        role: user.role,
        traffic_used_bytes: row.traffic_used_bytes,
        traffic_limit_bytes: row.traffic_limit_bytes,
        expires_at: row.expires_at,
    }))
}

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow, Serialize)]
pub struct UserView {
    id: Uuid,
    login: String,
    role: String,
    enabled: bool,
    traffic_limit_bytes: Option<i64>,
    traffic_used_bytes: i64,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct Pagination {
    limit: Option<i64>,
    offset: Option<i64>,
}

pub async fn list_users(
    State(state): State<AppState>,
    user: AuthUser,
    Query(p): Query<Pagination>,
) -> Result<Json<Vec<UserView>>, ApiError> {
    user.require_admin()?;
    let limit = p.limit.unwrap_or(50).clamp(1, 200);
    let offset = p.offset.unwrap_or(0).max(0);
    let rows = sqlx::query_as::<_, UserView>(
        "SELECT id, login, role, enabled, traffic_limit_bytes, traffic_used_bytes, expires_at, created_at \
         FROM users ORDER BY created_at LIMIT $1 OFFSET $2",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateUserReq {
    pub login: String,
    pub password: String,
    pub role: Option<String>,
    pub traffic_limit_bytes: Option<i64>,
    pub expires_at: Option<DateTime<Utc>>,
}

fn valid_login(login: &str) -> bool {
    (3..=64).contains(&login.len())
        && login
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

pub async fn create_user(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateUserReq>,
) -> Result<(axum::http::StatusCode, Json<CreatedUser>), ApiError> {
    user.require_admin()?;
    if req.traffic_limit_bytes.is_some_and(|l| l < 0) {
        return Err(ApiError::bad_request("traffic_limit_bytes must be >= 0"));
    }
    if !valid_login(&req.login) {
        return Err(ApiError::bad_request(
            "login must be 3-64 chars of [a-zA-Z0-9_.-]",
        ));
    }
    if req.password.len() < 8 {
        return Err(ApiError::bad_request(
            "password must be at least 8 characters",
        ));
    }
    let role = req.role.as_deref().unwrap_or("user");
    if role != "user" && role != "admin" {
        return Err(ApiError::bad_request("role must be 'user' or 'admin'"));
    }
    let hash = auth::hash_password(&req.password)?;
    let id = Uuid::new_v4();
    // Mint the subscription token now; its plaintext is returned exactly once.
    let sub_token = crate::sub::generate_token();
    match sqlx::query_as::<_, UserView>(
        "INSERT INTO users (id, login, password_hash, role, traffic_limit_bytes, expires_at, sub_token_hash) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         RETURNING id, login, role, enabled, traffic_limit_bytes, traffic_used_bytes, expires_at, created_at",
    )
    .bind(id)
    .bind(&req.login)
    .bind(&hash)
    .bind(role)
    .bind(req.traffic_limit_bytes)
    .bind(req.expires_at)
    .bind(crate::sub::hash_token(&sub_token))
    .fetch_one(state.pg())
    .await
    {
        Ok(view) => Ok((
            axum::http::StatusCode::CREATED,
            Json(CreatedUser {
                user: view,
                sub_token,
            })),
        ),
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            Err(ApiError::conflict("login already exists"))
        }
        Err(e) => {
            tracing::error!(error = %e, "create user failed");
            Err(ApiError::internal())
        }
    }
}

#[derive(Serialize)]
pub struct CreatedUser {
    #[serde(flatten)]
    user: UserView,
    /// Only ever visible in this create response (and after regeneration).
    sub_token: String,
}

// ---------------------------------------------------------------------------
// Desired-state mutations.
//
// Every mutation that changes what a node must run is an `apply_*` function
// taking the open transaction: it writes the change AND bumps the affected
// nodes' versions in that transaction; the handler commits and only then
// calls notify_change() (REVIEW P0-3). Global lock order, to stay
// deadlock-free: nodes (ORDER BY id, FOR UPDATE) -> users -> node_users.
// ---------------------------------------------------------------------------

/// JSON body extractor whose every rejection (syntax, unknown field, wrong
/// type, date-only timestamp, ...) is a 400 with the parser's message.
pub struct ApiJson<T>(pub T);

impl<S, T> axum::extract::FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: serde::de::DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: axum::extract::Request, state: &S) -> Result<Self, ApiError> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(v)) => Ok(ApiJson(v)),
            Err(e) => Err(ApiError::bad_request(e.body_text())),
        }
    }
}

/// PATCH field that distinguishes "absent" (None) from "null" (Some(None)).
fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// A PATCH field that may not be null.
fn non_null<T: Clone>(field: &str, v: &Option<Option<T>>) -> Result<Option<T>, ApiError> {
    match v {
        None => Ok(None),
        Some(None) => Err(ApiError::bad_request(format!("{field} cannot be null"))),
        Some(Some(v)) => Ok(Some(v.clone())),
    }
}

/// Locks (in id order) and returns the nodes the user is assigned to.
async fn lock_user_nodes(conn: &mut PgConnection, user_id: Uuid) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar(
        "SELECT id FROM nodes WHERE id IN (SELECT node_id FROM node_users WHERE user_id = $1) \
         ORDER BY id FOR UPDATE",
    )
    .bind(user_id)
    .fetch_all(conn)
    .await
}

/// Bumps user_version on every node the user is assigned to, as visible
/// now (after the user row is locked, so concurrent assigns are either
/// visible here or serialized after us). Returns the bumped node ids.
async fn bump_user_nodes(conn: &mut PgConnection, user_id: Uuid) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar(
        "UPDATE nodes SET user_version = user_version + 1 \
         WHERE id IN (SELECT node_id FROM node_users WHERE user_id = $1) RETURNING id",
    )
    .bind(user_id)
    .fetch_all(conn)
    .await
}

async fn bump_node_users(conn: &mut PgConnection, node_id: Uuid) -> sqlx::Result<()> {
    sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = $1")
        .bind(node_id)
        .execute(conn)
        .await?;
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct UpdateUserReq {
    #[serde(default, deserialize_with = "double_option")]
    pub enabled: Option<Option<bool>>,
    #[serde(default, deserialize_with = "double_option")]
    pub password: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub role: Option<Option<String>>,
    /// null clears the limit. Raising a limit does NOT re-enable a user the
    /// traffic-limit pass disabled; send `enabled: true` explicitly.
    #[serde(default, deserialize_with = "double_option")]
    pub traffic_limit_bytes: Option<Option<i64>>,
    /// null clears the expiry. Any change resets the expiry marker.
    #[serde(default, deserialize_with = "double_option")]
    pub expires_at: Option<Option<DateTime<Utc>>>,
}

/// PATCH /users/{id}. Returns the nodes whose versions were bumped.
async fn apply_update_user(
    conn: &mut PgConnection,
    id: Uuid,
    req: &UpdateUserReq,
) -> Result<Vec<Uuid>, ApiError> {
    let enabled = non_null("enabled", &req.enabled)?;
    let password = non_null("password", &req.password)?;
    let role = non_null("role", &req.role)?;
    if enabled.is_none()
        && password.is_none()
        && role.is_none()
        && req.traffic_limit_bytes.is_none()
        && req.expires_at.is_none()
    {
        return Err(ApiError::bad_request("no fields to update"));
    }
    if let Some(role) = &role {
        if role != "user" && role != "admin" {
            return Err(ApiError::bad_request("role must be 'user' or 'admin'"));
        }
    }
    if let Some(pw) = &password {
        if pw.len() < 8 {
            return Err(ApiError::bad_request(
                "password must be at least 8 characters",
            ));
        }
    }
    if let Some(Some(limit)) = req.traffic_limit_bytes {
        if limit < 0 {
            return Err(ApiError::bad_request("traffic_limit_bytes must be >= 0"));
        }
    }
    // Enabled, role (expiry only applies to role=user) and expiry change
    // what nodes serve.
    let affects_nodes = enabled.is_some() || role.is_some() || req.expires_at.is_some();

    if affects_nodes {
        lock_user_nodes(conn, id).await?;
    }
    let mut qb = sqlx::QueryBuilder::new("UPDATE users SET ");
    let mut set = qb.separated(", ");
    if let Some(v) = enabled {
        set.push("enabled = ").push_bind_unseparated(v);
    }
    if let Some(v) = &password {
        set.push("password_hash = ")
            .push_bind_unseparated(auth::hash_password(v)?);
    }
    if let Some(v) = role {
        set.push("role = ").push_bind_unseparated(v);
    }
    if let Some(v) = req.traffic_limit_bytes {
        set.push("traffic_limit_bytes = ").push_bind_unseparated(v);
    }
    if let Some(v) = req.expires_at {
        set.push("expires_at = ").push_bind_unseparated(v);
        set.push("expiry_enforced = false");
    }
    qb.push(" WHERE id = ").push_bind(id);
    if qb.build().execute(&mut *conn).await?.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    if !affects_nodes {
        return Ok(Vec::new());
    }
    Ok(bump_user_nodes(conn, id).await?)
}

pub async fn update_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<UpdateUserReq>,
) -> Result<Json<UserView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let bumped = apply_update_user(&mut tx, id, &req).await?;
    tx.commit().await?;
    if !bumped.is_empty() {
        state.notify_change();
    }
    let row = sqlx::query_as::<_, UserView>(
        "SELECT id, login, role, enabled, traffic_limit_bytes, traffic_used_bytes, expires_at, created_at \
         FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    Ok(Json(row))
}

/// Lock the user's nodes, then the user; remove the assignments, bump
/// exactly those nodes, delete the user — one transaction, so an agent
/// woken by the bump can never read "new version + old user set".
async fn apply_delete_user(conn: &mut PgConnection, id: Uuid) -> Result<Vec<Uuid>, ApiError> {
    lock_user_nodes(conn, id).await?;
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found());
    }
    let nodes: Vec<Uuid> =
        sqlx::query_scalar("DELETE FROM node_users WHERE user_id = $1 RETURNING node_id")
            .bind(id)
            .fetch_all(&mut *conn)
            .await?;
    sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = ANY($1)")
        .bind(&nodes)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(nodes)
}

pub async fn delete_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let bumped = apply_delete_user(&mut tx, id).await?;
    tx.commit().await?;
    if !bumped.is_empty() {
        state.notify_change();
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Nodes (admin)
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow, Serialize)]
pub struct NodeView {
    id: Uuid,
    name: String,
    enabled: bool,
    status: String,
    agent_version: Option<String>,
    core_version: Option<String>,
    config_version: i64,
    user_version: i64,
    xray_inbounds: serde_json::Value,
    /// Public hostname/IP clients dial for this node's inbounds; null until
    /// the admin sets it. Subscriptions skip accounts on such nodes.
    server_addr: Option<String>,
    /// The agent's last failed apply (e.g. xray rejected the inbounds) and
    /// the versions it was attempting; null once an update applies cleanly.
    last_error: Option<String>,
    last_error_at: Option<DateTime<Utc>>,
    failed_config_version: Option<i64>,
    failed_user_version: Option<i64>,
    /// Hello.protocol_version of the last connected agent; below the
    /// panel's minimum the node runs the empty state (see last_error).
    agent_protocol: Option<i32>,
    /// When the agent's fail-closed lease runs out (renewed while the panel
    /// can read the node's desired state), and the seconds left.
    lease_expires_at: Option<DateTime<Utc>>,
    lease_remaining_seconds: Option<i64>,
    last_seen_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

const NODE_VIEW_COLS: &str =
    "id, name, enabled, status, agent_version, core_version, config_version, \
     user_version, xray_inbounds, server_addr, last_error, last_error_at, failed_config_version, \
     failed_user_version, agent_protocol, lease_expires_at, \
     GREATEST(0, EXTRACT(EPOCH FROM lease_expires_at - now()))::bigint AS lease_remaining_seconds, \
     last_seen_at, created_at";

pub async fn list_nodes(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<NodeView>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, NodeView>(sqlx::AssertSqlSafe(format!(
        "SELECT {NODE_VIEW_COLS} FROM nodes ORDER BY created_at"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct UpdateNodeReq {
    #[serde(default, deserialize_with = "double_option")]
    pub enabled: Option<Option<bool>>,
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    /// null (or "") clears it.
    #[serde(default, deserialize_with = "double_option")]
    pub server_addr: Option<Option<String>>,
}

/// PATCH /nodes/{id}. Disabling AND enabling bump config_version (the
/// desired state of a disabled node is "no inbounds, no users"), so the
/// agent converges either way. Returns whether it bumped.
async fn apply_update_node(
    conn: &mut PgConnection,
    id: Uuid,
    req: &UpdateNodeReq,
) -> Result<bool, ApiError> {
    let enabled = non_null("enabled", &req.enabled)?;
    let name = non_null("name", &req.name)?;
    if enabled.is_none() && name.is_none() && req.server_addr.is_none() {
        return Err(ApiError::bad_request("no fields to update"));
    }
    let name = match name {
        Some(n) if n.trim().is_empty() => {
            return Err(ApiError::bad_request("name must not be empty"))
        }
        n => n.map(|n| n.trim().to_string()),
    };
    // "" and whitespace normalize to null (cleared).
    let server_addr: Option<Option<String>> = req.server_addr.as_ref().map(|a| {
        a.as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(String::from)
    });

    let current: Option<bool> =
        sqlx::query_scalar("SELECT enabled FROM nodes WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some(was_enabled) = current else {
        return Err(ApiError::not_found());
    };
    let toggles = enabled.is_some_and(|e| e != was_enabled);

    let mut qb = sqlx::QueryBuilder::new("UPDATE nodes SET ");
    let mut set = qb.separated(", ");
    set.push("updated_at = now()");
    if let Some(v) = enabled {
        set.push("enabled = ").push_bind_unseparated(v);
    }
    if toggles {
        set.push("config_version = config_version + 1");
    }
    if let Some(v) = name {
        set.push("name = ").push_bind_unseparated(v);
    }
    if let Some(v) = server_addr {
        set.push("server_addr = ").push_bind_unseparated(v);
    }
    qb.push(" WHERE id = ").push_bind(id);
    match qb.build().execute(&mut *conn).await {
        Ok(_) => Ok(toggles),
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            Err(ApiError::conflict("node name already exists"))
        }
        Err(e) => Err(e.into()),
    }
}

pub async fn update_node(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<UpdateNodeReq>,
) -> Result<Json<NodeView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let bumped = apply_update_node(&mut tx, id, &req).await?;
    tx.commit().await?;
    if bumped {
        state.notify_change();
    }
    let row = sqlx::query_as::<_, NodeView>(sqlx::AssertSqlSafe(format!(
        "SELECT {NODE_VIEW_COLS} FROM nodes WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    Ok(Json(row))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetInboundsReq {
    /// Full xray "inbounds" array for this node.
    pub inbounds: serde_json::Value,
}

/// tag -> protocol of a node's inbounds.
fn inbound_protocols(inbounds: &serde_json::Value) -> HashMap<String, String> {
    inbounds
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|i| {
                    let tag = i.get("tag")?.as_str()?;
                    let proto = i.get("protocol")?.as_str()?;
                    Some((tag.to_string(), proto.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Tags the agent may use for its own inbounds (xray API, future
/// internals); panel-managed inbounds must not collide with them.
fn reserved_tag(tag: &str) -> bool {
    tag == "api" || tag.starts_with("akari-") || tag.starts_with("_")
}

/// Every inbound needs a unique, non-reserved, non-empty tag and a protocol.
fn validate_inbounds(inbounds: &serde_json::Value) -> Result<(), ApiError> {
    let Some(items) = inbounds.as_array() else {
        return Err(ApiError::bad_request("inbounds must be an array"));
    };
    let mut seen = HashSet::new();
    for item in items {
        let tag = match item.get("tag").and_then(|t| t.as_str()) {
            Some(tag) if !tag.is_empty() => tag,
            _ => return Err(ApiError::bad_request("every inbound needs a non-empty tag")),
        };
        if reserved_tag(tag) {
            return Err(ApiError::bad_request(format!(
                "inbound tag {tag:?} is reserved (api, akari-*, _*)"
            )));
        }
        if !seen.insert(tag) {
            return Err(ApiError::bad_request(format!(
                "duplicate inbound tag {tag:?}"
            )));
        }
        match item.get("protocol").and_then(|p| p.as_str()) {
            Some(p) if !p.is_empty() => {}
            _ => {
                return Err(ApiError::bad_request(format!(
                    "inbound {tag:?} needs a protocol"
                )))
            }
        }
        // The agent's gate dispatcher wraps a DefaultDispatcher without a
        // FakeDNS engine (R10 F4): fakedns sniffing would silently misroute.
        if mentions_fakedns(item) {
            return Err(ApiError::bad_request(format!(
                "inbound {tag:?}: fakedns is not supported by the agent"
            )));
        }
    }
    Ok(())
}

fn mentions_fakedns(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::String(s) => s.to_ascii_lowercase().contains("fakedns"),
        serde_json::Value::Array(a) => a.iter().any(mentions_fakedns),
        serde_json::Value::Object(o) => o
            .iter()
            .any(|(k, v)| k.to_ascii_lowercase().contains("fakedns") || mentions_fakedns(v)),
        _ => false,
    }
}

/// Keep only credentials whose inbound still exists with the same protocol.
fn prune_credentials(
    creds: Vec<Credential>,
    inbounds: &HashMap<String, String>,
) -> Vec<Credential> {
    creds
        .into_iter()
        .filter(|c| inbounds.get(&c.inbound_tag) == Some(&c.protocol))
        .collect()
}

/// Replace a node's inbounds and, in the same transaction, drop credentials
/// that point at removed or re-protocoled inbounds (otherwise the agent's
/// AddUser fails on them); rows left empty are deleted. Returns the new
/// config_version (the snapshot it triggers carries the pruned users).
async fn apply_set_inbounds(
    conn: &mut PgConnection,
    id: Uuid,
    inbounds: &serde_json::Value,
) -> Result<i64, ApiError> {
    validate_inbounds(inbounds)?;
    let protocols = inbound_protocols(inbounds);

    let version: Option<i64> = sqlx::query_scalar(
        "UPDATE nodes SET xray_inbounds = $2, config_version = config_version + 1, updated_at = now() \
         WHERE id = $1 RETURNING config_version",
    )
    .bind(id)
    .bind(inbounds)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(version) = version else {
        return Err(ApiError::not_found());
    };

    let rows: Vec<(Uuid, serde_json::Value)> = sqlx::query_as(
        "SELECT user_id, credentials FROM node_users WHERE node_id = $1 ORDER BY user_id FOR UPDATE",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    for (user_id, raw) in rows {
        let creds: Vec<Credential> = serde_json::from_value(raw)
            .map_err(|e| anyhow::anyhow!("corrupt credentials json: {e}"))?;
        let before = creds.len();
        let kept = prune_credentials(creds, &protocols);
        if kept.len() == before {
            continue;
        }
        if kept.is_empty() {
            sqlx::query("DELETE FROM node_users WHERE node_id = $1 AND user_id = $2")
                .bind(id)
                .bind(user_id)
                .execute(&mut *conn)
                .await?;
            record_departed(conn, id, user_id).await?;
        } else {
            sqlx::query(
                "UPDATE node_users SET credentials = $3 WHERE node_id = $1 AND user_id = $2",
            )
            .bind(id)
            .bind(user_id)
            .bind(serde_json::to_value(&kept)?)
            .execute(&mut *conn)
            .await?;
        }
    }
    Ok(version)
}

pub async fn set_inbounds(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<SetInboundsReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let version = apply_set_inbounds(&mut tx, id, &req.inbounds).await?;
    tx.commit().await?;
    state.notify_change();
    Ok(Json(json!({ "config_version": version })))
}

// ---------------------------------------------------------------------------
// Account assignment: the panel generates and stores per-inbound credentials.
// ---------------------------------------------------------------------------

/// Regenerates a user's subscription token, invalidating the old one.
/// Plaintext is shown exactly once.
pub async fn regenerate_sub_token(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let token = crate::sub::issue_token_for(&state, id).await.map_err(|e| {
        tracing::error!(error = %e, "sub token issue failed");
        ApiError::internal()
    })?;
    Ok(Json(json!({ "sub_token": token })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssignReq {
    pub inbound_tag: String,
    pub protocol: String,
}

#[derive(serde::Deserialize, serde::Serialize, Debug, PartialEq, Clone)]
struct Credential {
    inbound_tag: String,
    protocol: String,
    account: serde_json::Value,
}

fn generate_account(protocol: &str) -> Result<serde_json::Value, ApiError> {
    match protocol {
        "vless" => Ok(json!({ "id": Uuid::new_v4().to_string(), "flow": "" })),
        "vmess" => Ok(json!({ "id": Uuid::new_v4().to_string() })),
        "trojan" => {
            let mut pw = [0u8; 32];
            rand::rng().fill_bytes(&mut pw);
            Ok(json!({ "password": hex::encode(pw) }))
        }
        other => Err(ApiError::bad_request(format!(
            "unsupported protocol {other:?} (vless, vmess, trojan)"
        ))),
    }
}

fn is_fk_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.code().as_deref() == Some("23503"))
}

/// Read-modify-write of the user's credentials on one node. The node row
/// lock serializes all assignments on that node (including first-time ones,
/// where there is no node_users row to lock) and the inbound protocol is
/// read under it. Returns the generated account.
async fn apply_assign(
    conn: &mut PgConnection,
    user_id: Uuid,
    node_id: Uuid,
    req: &AssignReq,
) -> Result<serde_json::Value, ApiError> {
    let account = generate_account(&req.protocol)?;
    let inbounds: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT xray_inbounds FROM nodes WHERE id = $1 FOR UPDATE")
            .bind(node_id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some(inbounds) = inbounds else {
        return Err(ApiError::not_found());
    };
    // FOR SHARE conflicts with the user-row locks of update/delete_user, so
    // a concurrent user change is ordered strictly before or after us.
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE id = $1 FOR SHARE")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    match role.as_deref() {
        None => return Err(ApiError::not_found()),
        Some("user") => {}
        Some(_) => {
            return Err(ApiError::bad_request(
                "admin accounts are not proxy users and cannot be assigned to nodes",
            ))
        }
    }
    match inbound_protocols(&inbounds).get(&req.inbound_tag) {
        None => {
            return Err(ApiError::bad_request(format!(
                "inbound {:?} does not exist on this node",
                req.inbound_tag
            )))
        }
        Some(p) if *p != req.protocol => {
            return Err(ApiError::bad_request(format!(
                "inbound {:?} is {p}, not {}",
                req.inbound_tag, req.protocol
            )))
        }
        Some(_) => {}
    }

    let existing: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT credentials FROM node_users WHERE node_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(node_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let mut creds: Vec<Credential> = existing
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| anyhow::anyhow!("corrupt credentials json: {e}"))?
        .unwrap_or_default();
    // One credential per inbound: re-assigning rotates the account.
    creds.retain(|c| c.inbound_tag != req.inbound_tag);
    creds.push(Credential {
        inbound_tag: req.inbound_tag.clone(),
        protocol: req.protocol.clone(),
        account: account.clone(),
    });

    let res = sqlx::query(
        "INSERT INTO node_users (node_id, user_id, credentials) VALUES ($1, $2, $3) \
         ON CONFLICT (node_id, user_id) DO UPDATE SET credentials = EXCLUDED.credentials",
    )
    .bind(node_id)
    .bind(user_id)
    .bind(serde_json::to_value(&creds)?)
    .execute(&mut *conn)
    .await;
    match res {
        Ok(_) => {}
        Err(e) if is_fk_violation(&e) => return Err(ApiError::not_found()),
        Err(e) => return Err(e.into()),
    }
    // Assigned again: no longer a departed pair.
    sqlx::query("DELETE FROM node_users_departed WHERE node_id = $1 AND user_id = $2")
        .bind(node_id)
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    bump_node_users(conn, node_id).await?;
    Ok(account)
}

pub async fn assign_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, user_id, node_id)): Path<(String, Uuid, Uuid)>,
    ApiJson(req): ApiJson<AssignReq>,
) -> Result<(axum::http::StatusCode, Response), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let account = apply_assign(&mut tx, user_id, node_id, &req).await?;
    tx.commit().await?;
    state.notify_change();
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({
            "inbound_tag": req.inbound_tag,
            "protocol": req.protocol,
            "account": account,
        }))
        .into_response(),
    ))
}

pub(crate) async fn apply_unassign(
    conn: &mut PgConnection,
    user_id: Uuid,
    node_id: Uuid,
) -> Result<(), ApiError> {
    let node: Option<i32> = sqlx::query_scalar("SELECT 1 FROM nodes WHERE id = $1 FOR UPDATE")
        .bind(node_id)
        .fetch_optional(&mut *conn)
        .await?;
    if node.is_none() {
        return Err(ApiError::not_found());
    }
    let res = sqlx::query("DELETE FROM node_users WHERE node_id = $1 AND user_id = $2")
        .bind(node_id)
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    record_departed(conn, node_id, user_id).await?;
    bump_node_users(conn, node_id).await?;
    Ok(())
}

/// The user still exists but no longer has this node: its final counters
/// (reported by the agent after the REMOVE) stay billable for the departed
/// grace (traffic::FLUSH_SQL). Not used for user deletion (nothing left to
/// bill; the row cascades away).
async fn record_departed(
    conn: &mut PgConnection,
    node_id: Uuid,
    user_id: Uuid,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO node_users_departed (node_id, user_id, departed_at) VALUES ($1, $2, now()) \
         ON CONFLICT (node_id, user_id) DO UPDATE SET departed_at = now()",
    )
    .bind(node_id)
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn unassign_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, user_id, node_id)): Path<(String, Uuid, Uuid)>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_unassign(&mut tx, user_id, node_id).await?;
    tx.commit().await?;
    state.notify_change();
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::TestDb;
    use axum::extract::FromRequest;
    use axum::http::StatusCode;

    fn cred(tag: &str, proto: &str) -> Credential {
        Credential {
            inbound_tag: tag.into(),
            protocol: proto.into(),
            account: json!({}),
        }
    }

    #[test]
    fn prune_keeps_only_matching_tag_and_protocol() {
        let inb = inbound_protocols(&json!([
            {"tag": "a", "protocol": "vless"},
            {"tag": "b", "protocol": "trojan"},
        ]));
        let kept = prune_credentials(
            vec![
                cred("a", "vless"),
                cred("b", "vmess"),
                cred("gone", "vless"),
            ],
            &inb,
        );
        assert_eq!(kept, vec![cred("a", "vless")]);
    }

    #[test]
    fn inbound_validation() {
        let ok = json!([{"tag": "a", "protocol": "vless"}, {"tag": "b", "protocol": "vmess"}]);
        assert!(validate_inbounds(&ok).is_ok());
        for bad in [
            json!({}),
            json!([{"tag": "", "protocol": "vless"}]),
            json!([{"protocol": "vless"}]),
            json!([{"tag": "a", "protocol": "vless"}, {"tag": "a", "protocol": "vmess"}]),
            json!([{"tag": "a"}]),
            json!([{"tag": "api", "protocol": "vless"}]),
            json!([{"tag": "akari-x", "protocol": "vless"}]),
            json!([{"tag": "_x", "protocol": "vless"}]),
        ] {
            let e = validate_inbounds(&bad).unwrap_err();
            assert_eq!(e.status(), StatusCode::BAD_REQUEST, "{bad}");
        }
    }

    async fn parse<T: serde::de::DeserializeOwned>(body: &str) -> Result<T, ApiError> {
        let req = axum::http::Request::builder()
            .method("PATCH")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        ApiJson::<T>::from_request(req, &())
            .await
            .map(|ApiJson(v)| v)
    }

    #[tokio::test]
    async fn patch_bodies_absent_null_and_bad_input() {
        let r: UpdateNodeReq = parse("{}").await.unwrap_or_else(|_| panic!());
        assert!(r.enabled.is_none() && r.server_addr.is_none());
        let r: UpdateNodeReq = parse(r#"{"server_addr": null}"#).await.ok().unwrap();
        assert_eq!(r.server_addr, Some(None));
        let r: UpdateUserReq = parse(r#"{"expires_at": null}"#).await.ok().unwrap();
        assert_eq!(r.expires_at, Some(None));
        for bad in [
            r#"{"enabeld": false}"#,
            r#"{"expires_at": "2026-10-01"}"#,
            r#"{"enabled": "yes"}"#,
            r#"not json"#,
        ] {
            let e = parse::<UpdateUserReq>(bad).await.err().unwrap();
            assert_eq!(e.status(), StatusCode::BAD_REQUEST, "{bad}");
        }
    }

    // ----- real-DB tests -------------------------------------------------

    fn err_status<T>(r: Result<T, ApiError>) -> StatusCode {
        r.err().expect("expected an error").status()
    }

    /// Table-driven: every mutation that changes access changes the
    /// (config_version, user_version) of every affected node, in the same
    /// transaction; mutations that don't change access don't.
    #[tokio::test]
    async fn every_access_change_bumps_affected_nodes() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n1, u) = db.member().await;
        let n2 = db.node().await;
        db.assign(n2, u).await;
        let other = db.node().await;

        type Op = Box<
            dyn for<'c> Fn(
                &'c mut PgConnection,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<(), ApiError>> + Send + 'c>,
            >,
        >;
        let upd = |req: UpdateUserReq| -> Op {
            let req = std::sync::Arc::new(req);
            Box::new(move |c| {
                let req = req.clone();
                Box::pin(async move { apply_update_user(c, u, &req).await.map(|_| ()) })
            })
        };
        let cases: Vec<(&str, Op, Vec<Uuid>, bool)> = vec![
            (
                "disable user",
                upd(UpdateUserReq {
                    enabled: Some(Some(false)),
                    ..Default::default()
                }),
                vec![n1, n2],
                true,
            ),
            (
                "enable user",
                upd(UpdateUserReq {
                    enabled: Some(Some(true)),
                    ..Default::default()
                }),
                vec![n1, n2],
                true,
            ),
            (
                "role change",
                upd(UpdateUserReq {
                    role: Some(Some("admin".into())),
                    ..Default::default()
                }),
                vec![n1, n2],
                true,
            ),
            (
                "role back",
                upd(UpdateUserReq {
                    role: Some(Some("user".into())),
                    ..Default::default()
                }),
                vec![n1, n2],
                true,
            ),
            (
                "expiry set",
                upd(UpdateUserReq {
                    expires_at: Some(Some(Utc::now())),
                    ..Default::default()
                }),
                vec![n1, n2],
                true,
            ),
            (
                "expiry cleared",
                upd(UpdateUserReq {
                    expires_at: Some(None),
                    ..Default::default()
                }),
                vec![n1, n2],
                true,
            ),
            (
                "password only",
                upd(UpdateUserReq {
                    password: Some(Some("longenough1".into())),
                    ..Default::default()
                }),
                vec![n1, n2],
                false,
            ),
            (
                "limit only",
                upd(UpdateUserReq {
                    traffic_limit_bytes: Some(Some(5)),
                    ..Default::default()
                }),
                vec![n1, n2],
                false,
            ),
            (
                "disable node",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_update_node(
                            c,
                            n1,
                            &UpdateNodeReq {
                                enabled: Some(Some(false)),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1],
                true,
            ),
            (
                "enable node",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_update_node(
                            c,
                            n1,
                            &UpdateNodeReq {
                                enabled: Some(Some(true)),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1],
                true,
            ),
            (
                "enable node again (no-op)",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_update_node(
                            c,
                            n1,
                            &UpdateNodeReq {
                                enabled: Some(Some(true)),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1],
                false,
            ),
            (
                "server_addr",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_update_node(
                            c,
                            n1,
                            &UpdateNodeReq {
                                server_addr: Some(Some("h".into())),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1],
                false,
            ),
            (
                "set inbounds",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_set_inbounds(
                            c,
                            n1,
                            &json!([{"tag": "in-vless", "protocol": "vless"}]),
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1],
                true,
            ),
            (
                "assign",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_assign(
                            c,
                            u,
                            other,
                            &AssignReq {
                                inbound_tag: "in-vless".into(),
                                protocol: "vless".into(),
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![other],
                true,
            ),
            (
                "unassign",
                Box::new(move |c| Box::pin(async move { apply_unassign(c, u, other).await })),
                vec![other],
                true,
            ),
            (
                "delete user",
                Box::new(move |c| {
                    Box::pin(async move { apply_delete_user(c, u).await.map(|_| ()) })
                }),
                vec![n1, n2],
                true,
            ),
        ];
        for (name, op, nodes, bumps) in cases {
            let mut before = vec![];
            for n in &nodes {
                before.push(db.versions(*n).await);
            }
            let mut tx = db.pool.begin().await.unwrap();
            op(&mut tx)
                .await
                .unwrap_or_else(|e| panic!("{name}: {}", e.status()));
            tx.commit().await.unwrap();
            for (n, b) in nodes.iter().zip(before) {
                let after = db.versions(*n).await;
                assert_eq!(after != b, bumps, "{name}: node {n} {b:?} -> {after:?}");
            }
        }
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM node_users")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(left, 0, "delete_user removed the assignments");
        db.drop().await;
    }

    #[tokio::test]
    async fn enforcement_passes_bump_once_and_rearm_on_extension() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let (n2, over) = db.member().await;
        sqlx::query(
            "UPDATE users SET traffic_limit_bytes = 10, traffic_used_bytes = 11 WHERE id = $1",
        )
        .bind(over)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query("UPDATE users SET expires_at = now() - interval '1 second' WHERE id = $1")
            .bind(u)
            .execute(&db.pool)
            .await
            .unwrap();
        let run = |which: u8| {
            let pool = db.pool.clone();
            async move {
                let mut tx = pool.begin().await.unwrap();
                let r = if which == 0 {
                    crate::enforce::apply_traffic_limits(&mut tx).await
                } else {
                    crate::enforce::apply_expiry(&mut tx).await
                }
                .unwrap();
                tx.commit().await.unwrap();
                r
            }
        };
        assert_eq!(run(0).await, vec![n2]);
        assert!(run(0).await.is_empty(), "idempotent");
        let enabled: bool = sqlx::query_scalar("SELECT enabled FROM users WHERE id = $1")
            .bind(over)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(!enabled);

        assert_eq!(run(1).await, vec![n]);
        assert!(run(1).await.is_empty(), "marker makes it idempotent");
        // Extend into the future: marker reset + bump; not due yet.
        let mut tx = db.pool.begin().await.unwrap();
        let req = UpdateUserReq {
            expires_at: Some(Some(Utc::now() + chrono::Duration::milliseconds(300))),
            ..Default::default()
        };
        assert_eq!(
            apply_update_user(&mut tx, u, &req).await.ok().unwrap(),
            vec![n]
        );
        tx.commit().await.unwrap();
        assert!(run(1).await.is_empty());
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert_eq!(run(1).await, vec![n], "re-expiry is enforced again");
        // Admins are exempt from expiry.
        let admin = db.user().await;
        db.assign(n2, admin).await;
        sqlx::query(
            "UPDATE users SET role = 'admin', expires_at = now() - interval '1 day' WHERE id = $1",
        )
        .bind(admin)
        .execute(&db.pool)
        .await
        .unwrap();
        assert!(run(1).await.is_empty());
        // ... and from the traffic-limit disable.
        sqlx::query(
            "UPDATE users SET traffic_limit_bytes = 1, traffic_used_bytes = 5 WHERE id = $1",
        )
        .bind(admin)
        .execute(&db.pool)
        .await
        .unwrap();
        assert!(run(0).await.is_empty());
        db.drop().await;
    }

    #[tokio::test]
    async fn validation_and_not_found_paths() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let assign = |user: Uuid, node: Uuid, tag: &str, proto: &str| {
            let req = AssignReq {
                inbound_tag: tag.into(),
                protocol: proto.into(),
            };
            let pool = db.pool.clone();
            async move {
                let mut tx = pool.begin().await.unwrap();
                let r = apply_assign(&mut tx, user, node, &req).await;
                if r.is_ok() {
                    tx.commit().await.unwrap();
                }
                r
            }
        };
        assert_eq!(
            err_status(assign(u, n, "in-vless", "vmess").await),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            err_status(assign(u, n, "nope", "vless").await),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            err_status(assign(Uuid::new_v4(), n, "in-vless", "vless").await),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            err_status(assign(u, Uuid::new_v4(), "in-vless", "vless").await),
            StatusCode::NOT_FOUND
        );
        // Admin accounts are not proxy users (R6 L6).
        let admin = db.user().await;
        sqlx::query("UPDATE users SET role = 'admin' WHERE id = $1")
            .bind(admin)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            err_status(assign(admin, n, "in-vless", "vless").await),
            StatusCode::BAD_REQUEST
        );

        let upd_node = |req: UpdateNodeReq| {
            let pool = db.pool.clone();
            async move {
                let mut tx = pool.begin().await.unwrap();
                let r = apply_update_node(&mut tx, n, &req).await;
                tx.commit().await.unwrap();
                r
            }
        };
        assert_eq!(
            err_status(upd_node(UpdateNodeReq::default()).await),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            err_status(
                upd_node(UpdateNodeReq {
                    enabled: Some(None),
                    ..Default::default()
                })
                .await
            ),
            StatusCode::BAD_REQUEST
        );
        upd_node(UpdateNodeReq {
            server_addr: Some(Some("h.example".into())),
            ..Default::default()
        })
        .await
        .ok()
        .unwrap();
        upd_node(UpdateNodeReq {
            server_addr: Some(Some("  ".into())),
            ..Default::default()
        })
        .await
        .ok()
        .unwrap();
        let addr: Option<String> =
            sqlx::query_scalar("SELECT server_addr FROM nodes WHERE id = $1")
                .bind(n)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(addr, None, "blank server_addr clears it");

        let mut tx = db.pool.begin().await.unwrap();
        assert_eq!(
            err_status(apply_update_user(&mut tx, u, &UpdateUserReq::default()).await),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            err_status(
                apply_update_user(
                    &mut tx,
                    u,
                    &UpdateUserReq {
                        traffic_limit_bytes: Some(Some(-1)),
                        ..Default::default()
                    }
                )
                .await
            ),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            err_status(
                apply_update_user(
                    &mut tx,
                    Uuid::new_v4(),
                    &UpdateUserReq {
                        enabled: Some(Some(true)),
                        ..Default::default()
                    }
                )
                .await
            ),
            StatusCode::NOT_FOUND
        );
        drop(tx);
        db.drop().await;
    }

    #[tokio::test]
    async fn set_inbounds_prunes_credentials_in_same_tx() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let u2 = db.user().await;
        sqlx::query("INSERT INTO node_users (node_id, user_id, credentials) VALUES ($1, $2, $3)")
            .bind(n)
            .bind(u2)
            .bind(json!([
                {"inbound_tag": "in-vless", "protocol": "vless", "account": {}},
                {"inbound_tag": "in-t", "protocol": "trojan", "account": {}},
            ]))
            .execute(&db.pool)
            .await
            .unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        // in-vless becomes vmess (protocol change) and in-t stays.
        apply_set_inbounds(
            &mut tx,
            n,
            &json!([{"tag": "in-vless", "protocol": "vmess"}, {"tag": "in-t", "protocol": "trojan"}]),
        )
        .await
        .ok()
        .unwrap();
        tx.commit().await.unwrap();
        let rows: Vec<(Uuid, serde_json::Value)> =
            sqlx::query_as("SELECT user_id, credentials FROM node_users WHERE node_id = $1")
                .bind(n)
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(
            rows.len(),
            1,
            "u's only credential was pruned -> row deleted"
        );
        assert_eq!(rows[0].0, u2);
        assert_eq!(rows[0].1.as_array().unwrap().len(), 1);
        let _ = u;
        db.drop().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn twenty_concurrent_assigns_serialize() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        let (c0, u0) = db.versions(n).await;
        let mut users = vec![];
        for _ in 0..20 {
            users.push(db.user().await);
        }
        let shared = users[0];
        let mut tasks = vec![];
        for (i, &u) in users.iter().enumerate() {
            // Half assign distinct users, half re-assign the same user.
            let who = if i % 2 == 0 { u } else { shared };
            let pool = db.pool.clone();
            tasks.push(tokio::spawn(async move {
                let mut tx = pool.begin().await.unwrap();
                let req = AssignReq {
                    inbound_tag: "in-vless".into(),
                    protocol: "vless".into(),
                };
                apply_assign(&mut tx, who, n, &req).await.ok().unwrap();
                tx.commit().await.unwrap();
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        let (c1, u1) = db.versions(n).await;
        assert_eq!((c1, u1), (c0, u0 + 20));
        let rows: Vec<serde_json::Value> =
            sqlx::query_scalar("SELECT credentials FROM node_users WHERE node_id = $1")
                .bind(n)
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(rows.len(), 10);
        assert!(
            rows.iter().all(|c| c.as_array().unwrap().len() == 1),
            "no lost/duplicate creds"
        );
        db.drop().await;
    }

    /// R10 F1: removing a node_users row of a still-existing user leaves a
    /// departed marker (unassign, set_inbounds pruning to nothing);
    /// re-assigning clears it.
    #[tokio::test]
    async fn departed_marker_written_and_cleared() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let departed = |n: Uuid, u: Uuid| {
            let pool = db.pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM node_users_departed WHERE node_id = $1 AND user_id = $2",
                )
                .bind(n)
                .bind(u)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        let (n, u) = db.member().await;
        let mut tx = db.pool.begin().await.unwrap();
        apply_unassign(&mut tx, u, n).await.ok().unwrap();
        tx.commit().await.unwrap();
        assert_eq!(departed(n, u).await, 1);
        let req = AssignReq {
            inbound_tag: "in-vless".into(),
            protocol: "vless".into(),
        };
        let mut tx = db.pool.begin().await.unwrap();
        apply_assign(&mut tx, u, n, &req).await.ok().unwrap();
        tx.commit().await.unwrap();
        assert_eq!(departed(n, u).await, 0, "re-assign clears it");
        let mut tx = db.pool.begin().await.unwrap();
        apply_set_inbounds(&mut tx, n, &json!([{"tag": "other", "protocol": "trojan"}]))
            .await
            .ok()
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(departed(n, u).await, 1, "pruned to nothing = departed");
        db.drop().await;
    }

    #[test]
    fn fakedns_inbounds_rejected() {
        let bad = json!([{"tag": "a", "protocol": "vless",
            "sniffing": {"enabled": true, "destOverride": ["http", "fakedns+others"]}}]);
        assert!(validate_inbounds(&bad).is_err());
        let ok = json!([{"tag": "a", "protocol": "vless",
            "sniffing": {"enabled": true, "destOverride": ["http", "tls"]}}]);
        assert!(validate_inbounds(&ok).is_ok());
    }
}
