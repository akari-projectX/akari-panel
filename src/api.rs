use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
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
        password_hash: Option<String>,
    }
    let row = sqlx::query_as::<_, Row>(
        "SELECT id, login, role, enabled, password_hash FROM users WHERE login = $1",
    )
    .bind(&req.login)
    .fetch_optional(state.pg())
    .await?;

    let Some(row) = row.filter(|r| r.enabled && r.password_hash.is_some()) else {
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
    Json(req): Json<CreateUserReq>,
) -> Result<(axum::http::StatusCode, Json<CreatedUser>), ApiError> {
    user.require_admin()?;
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

#[derive(Deserialize)]
pub struct UpdateUserReq {
    pub enabled: Option<bool>,
    pub password: Option<String>,
    pub role: Option<String>,
    pub traffic_limit_bytes: Option<i64>,
    pub expires_at: Option<DateTime<Utc>>,
}

/// Enables/disabling a user changes the desired user set on their nodes;
/// bump those node versions so connected agents converge immediately.
async fn bump_user_nodes(state: &AppState, user_id: Uuid) -> anyhow::Result<()> {
    let nodes: Vec<Uuid> =
        sqlx::query_scalar("SELECT DISTINCT node_id FROM node_users WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(state.pg())
            .await?;
    if nodes.is_empty() {
        return Ok(());
    }
    sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = ANY($1)")
        .bind(&nodes)
        .execute(state.pg())
        .await?;
    state.notify_change();
    Ok(())
}

// Dynamic SET clauses leave a trailing dead store in the comma counter;
// the lint fires on the assignment, not the binding, so it lives here.
#[allow(unused_assignments)]
pub async fn update_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    Json(req): Json<UpdateUserReq>,
) -> Result<Json<UserView>, ApiError> {
    user.require_admin()?;
    if let Some(role) = &req.role {
        if role != "user" && role != "admin" {
            return Err(ApiError::bad_request("role must be 'user' or 'admin'"));
        }
    }
    if let Some(pw) = &req.password {
        if pw.len() < 8 {
            return Err(ApiError::bad_request(
                "password must be at least 8 characters",
            ));
        }
    }

    let has_any = req.enabled.is_some()
        || req.password.is_some()
        || req.role.is_some()
        || req.traffic_limit_bytes.is_some()
        || req.expires_at.is_some();
    if !has_any {
        return Err(ApiError::bad_request("no fields to update"));
    }

    // Manual comma management: pushing a fragment and its bind must land as
    // ONE clause, so sqlx's Separated helper does not fit here.
    let mut qb = sqlx::QueryBuilder::new("UPDATE users SET ");
    let mut wrote = false;
    macro_rules! set_field {
        ($col:expr, $val:expr) => {{
            if wrote {
                qb.push(", ");
            }
            wrote = true;
            qb.push($col).push_bind($val);
        }};
    }
    if let Some(v) = req.enabled {
        set_field!("enabled = ", v);
    }
    if let Some(v) = &req.password {
        let hash = auth::hash_password(v)?;
        set_field!("password_hash = ", hash);
    }
    if let Some(v) = &req.role {
        set_field!("role = ", v.clone());
    }
    if let Some(v) = req.traffic_limit_bytes {
        set_field!("traffic_limit_bytes = ", v);
    }
    if let Some(v) = req.expires_at {
        set_field!("expires_at = ", v);
    }
    qb.push(" WHERE id = ").push_bind(id);
    let res = qb.build().execute(state.pg()).await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    if req.enabled.is_some() {
        bump_user_nodes(&state, id).await?;
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

pub async fn delete_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    bump_user_nodes(&state, id).await?;
    let res = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(state.pg())
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found());
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
    last_seen_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

pub async fn list_nodes(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<NodeView>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, NodeView>(
        "SELECT id, name, enabled, status, agent_version, core_version, config_version, \
         user_version, xray_inbounds, server_addr, last_seen_at, created_at \
         FROM nodes ORDER BY created_at",
    )
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct UpdateNodeReq {
    pub enabled: Option<bool>,
    pub name: Option<String>,
    pub server_addr: Option<String>,
}

#[allow(unused_assignments)]
pub async fn update_node(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    Json(req): Json<UpdateNodeReq>,
) -> Result<Json<NodeView>, ApiError> {
    user.require_admin()?;
    let mut qb = sqlx::QueryBuilder::new("UPDATE nodes SET ");
    let mut wrote = false;
    if let Some(v) = req.enabled {
        if wrote {
            qb.push(", ");
        }
        wrote = true;
        qb.push("enabled = ").push_bind(v);
    }
    if let Some(v) = &req.name {
        if wrote {
            qb.push(", ");
        }
        wrote = true;
        qb.push("name = ").push_bind(v.clone());
    }
    if let Some(v) = &req.server_addr {
        if wrote {
            qb.push(", ");
        }
        wrote = true;
        qb.push("server_addr = ").push_bind(v.clone());
    }
    qb.push(" WHERE id = ").push_bind(id);
    let res = qb.build().execute(state.pg()).await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    state.notify_change();
    let row = sqlx::query_as::<_, NodeView>(
        "SELECT id, name, enabled, status, agent_version, core_version, config_version, \
         user_version, xray_inbounds, server_addr, last_seen_at, created_at FROM nodes WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    Ok(Json(row))
}

#[derive(Deserialize)]
pub struct SetInboundsReq {
    /// Full xray "inbounds" array for this node.
    pub inbounds: serde_json::Value,
}

pub async fn set_inbounds(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    Json(req): Json<SetInboundsReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let Some(items) = req.inbounds.as_array() else {
        return Err(ApiError::bad_request("inbounds must be an array"));
    };
    for item in items {
        match item.get("tag").and_then(|t| t.as_str()) {
            Some(tag) if !tag.is_empty() => {}
            _ => return Err(ApiError::bad_request("every inbound needs a non-empty tag")),
        }
    }
    let res = sqlx::query(
        "UPDATE nodes SET xray_inbounds = $2, config_version = config_version + 1 WHERE id = $1",
    )
    .bind(id)
    .bind(&req.inbounds)
    .execute(state.pg())
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    state.notify_change();
    let version: i64 = sqlx::query_scalar("SELECT config_version FROM nodes WHERE id = $1")
        .bind(id)
        .fetch_one(state.pg())
        .await?;
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
pub struct AssignReq {
    pub inbound_tag: String,
    pub protocol: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
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

fn inbound_tags(inbounds: &serde_json::Value) -> Vec<String> {
    inbounds
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|i| i.get("tag").and_then(|t| t.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

pub async fn assign_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, user_id, node_id)): Path<(String, Uuid, Uuid)>,
    Json(req): Json<AssignReq>,
) -> Result<(axum::http::StatusCode, Response), ApiError> {
    user.require_admin()?;
    let account = generate_account(&req.protocol)?;

    let node: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT xray_inbounds FROM nodes WHERE id = $1")
            .bind(node_id)
            .fetch_optional(state.pg())
            .await?;
    let Some(inbounds) = node else {
        return Err(ApiError::not_found());
    };
    if !inbound_tags(&inbounds).contains(&req.inbound_tag) {
        return Err(ApiError::bad_request(format!(
            "inbound {:?} does not exist on this node",
            req.inbound_tag
        )));
    }

    let existing: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT credentials FROM node_users WHERE node_id = $1 AND user_id = $2",
    )
    .bind(node_id)
    .bind(user_id)
    .fetch_optional(state.pg())
    .await?;
    let mut creds: Vec<Credential> = existing
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| anyhow::anyhow!("corrupt credentials json: {e}"))?
        .unwrap_or_default();
    // One credential per inbound: re-assigning rotates the account.
    creds.retain(|c| c.inbound_tag != req.inbound_tag);
    let new_cred = Credential {
        inbound_tag: req.inbound_tag.clone(),
        protocol: req.protocol.clone(),
        account: account.clone(),
    };
    creds.push(new_cred);

    sqlx::query(
        "INSERT INTO node_users (node_id, user_id, credentials) VALUES ($1, $2, $3) \
         ON CONFLICT (node_id, user_id) DO UPDATE SET credentials = EXCLUDED.credentials",
    )
    .bind(node_id)
    .bind(user_id)
    .bind(serde_json::to_value(&creds)?)
    .execute(state.pg())
    .await?;
    sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = $1")
        .bind(node_id)
        .execute(state.pg())
        .await?;
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

pub async fn unassign_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, user_id, node_id)): Path<(String, Uuid, Uuid)>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    let res = sqlx::query("DELETE FROM node_users WHERE node_id = $1 AND user_id = $2")
        .bind(node_id)
        .bind(user_id)
        .execute(state.pg())
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = $1")
        .bind(node_id)
        .execute(state.pg())
        .await?;
    state.notify_change();
    Ok(axum::http::StatusCode::NO_CONTENT)
}
