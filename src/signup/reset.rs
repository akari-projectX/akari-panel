//! Password reset by email link (W15): `POST /auth/password-reset/request`
//! (same answer for every address; the link — in the account's language —
//! is mailed only to a VERIFIED
//! address of an account that may log in) and `POST /auth/password-reset`
//! (token + new password). Both are the canonical rejection while reset is
//! off.
//!
//! The link is `<main domain>/<prefix>/app/reset#token=<token>`: the main
//! domain from 系统设置 (never the request's Host — that would let anyone
//! mail a victim a link to their own server), the token in the fragment so
//! no proxy or access log ever sees it. Token: 256 random bits, SHA-256
//! stored, 30 minutes, single use, bound to the address it was mailed to
//! (an address change in between kills it); a new request replaces the
//! account's older links.

use crate::auth::bad_request;
use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use uuid::Uuid;

use super::{email, read_json};
use crate::audit::Actor;
use crate::auth::{self, ApiError};
use crate::mail::{Locale, Template};
use crate::state::AppState;

#[cfg(test)]
pub const INVALID_LINK: &str = "invalid or expired link";

/// The one answer to every failed reset link (no oracle).
pub fn invalid_link() -> crate::auth::ApiError {
    crate::auth::bad_request!("signup.invalid_link", "invalid or expired link")
}
const TOKEN_LEN: usize = 43;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestReq {
    pub email: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetReq {
    pub token: String,
    pub password: String,
}

pub fn new_token() -> String {
    let mut b = [0u8; 32];
    rand::rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

pub fn plausible_token(t: &str) -> bool {
    t.len() == TOKEN_LEN
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn token_hash(t: &str) -> Vec<u8> {
    Sha256::digest(t.as_bytes()).to_vec()
}

/// POST /{prefix}/auth/password-reset/request {email, locale?}
pub async fn request_reset(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    if !super::settings_or_none(&state)
        .await
        .is_some_and(|s| s.reset_enabled)
    {
        return Ok(crate::reject::not_found());
    }
    let req: RequestReq = read_json(body).await?;
    let addr = email::parse(&req.email)
        .ok_or_else(|| bad_request!("signup.invalid_email", "invalid email address"))?;
    let client = state.client_ip(peer.ip(), &headers);
    super::limit_send(&state, &crate::client_ip::bucket(client), &addr).await?;
    let st = state.clone();
    tokio::spawn(async move {
        if let Err(e) = send_link(&st, &addr).await {
            tracing::warn!(error = %e, "password reset link not queued");
        }
    });
    Ok(super::ok_json(json!({ "ok": true })))
}

/// Accounts that may reset (alias `u`): enabled, or only quota-disabled
/// (they may log in to renew, R21).
const MAY_RESET: &str =
    "u.email_verified_at IS NOT NULL AND (u.enabled OR u.disabled_reason = 'quota')";

/// Issue a link for the account holding `addr` (verified) and queue it.
/// Returns whether a mail was queued.
pub async fn apply_send_link(
    conn: &mut PgConnection,
    state: &AppState,
    addr: &str,
) -> anyhow::Result<bool> {
    let smtp = crate::mail::load(conn).await?;
    if !smtp.enabled {
        tracing::warn!("password reset requested while mail sending is disabled");
        return Ok(false);
    }
    let Some(portal) = crate::mail::portal_url(state) else {
        tracing::error!("password reset requested but no main domain is set (系统设置)");
        return Ok(false);
    };
    let row: Option<(Uuid, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT u.id, u.locale FROM users u WHERE u.email = $1 AND {MAY_RESET}"
    )))
    .bind(addr)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((user, locale)) = row else {
        return Ok(false);
    };
    let token = new_token();
    sqlx::query("DELETE FROM password_resets WHERE user_id = $1")
        .bind(user)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO password_resets (token_hash, user_id, email, expires_at) \
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
    )
    .bind(token_hash(&token))
    .bind(user)
    .bind(addr)
    .bind(super::RESET_TTL_SECS as f64)
    .execute(&mut *conn)
    .await?;
    let t = Template::PasswordReset {
        link: format!("{portal}/reset#token={token}"),
        minutes: super::RESET_TTL_SECS / 60,
    };
    crate::mail::enqueue(
        conn,
        &smtp,
        &t,
        Locale::parse(&locale),
        addr,
        Some(user),
        Some(super::RESET_TTL_SECS),
    )
    .await?;
    Ok(true)
}

async fn send_link(state: &AppState, addr: &str) -> anyhow::Result<()> {
    let mut tx = state.pg().begin().await?;
    apply_send_link(&mut tx, state, addr).await?;
    tx.commit().await?;
    Ok(())
}

/// Consume `token` and set the new password hash, in the caller's
/// transaction. The 0009 trigger bumps session_ver (every session ends).
/// None = invalid/expired/used token.
pub async fn apply_reset(
    conn: &mut PgConnection,
    token: &str,
    password_hash: &str,
    ip: Option<std::net::IpAddr>,
) -> Result<Option<Uuid>, ApiError> {
    if !plausible_token(token) {
        return Ok(None);
    }
    let row: Option<(Uuid, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE password_resets r SET used_at = now() FROM users u \
         WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() \
         AND u.id = r.user_id AND u.email = r.email AND {MAY_RESET} \
         RETURNING r.user_id, u.login"
    )))
    .bind(token_hash(token))
    .fetch_optional(&mut *conn)
    .await?;
    let Some((user, login)) = row else {
        return Ok(None);
    };
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(user)
        .bind(password_hash)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL")
        .bind(user)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        &Actor::account(user, &login, ip),
        "user.password.reset",
        "user",
        Some(user.to_string()),
        None,
        Some(json!({ "password": crate::audit::CHANGED, "via": "email_link" })),
    )
    .await?;
    Ok(Some(user))
}

/// POST /{prefix}/auth/password-reset {token, password}
pub async fn reset_password(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    if !super::settings_or_none(&state)
        .await
        .is_some_and(|s| s.reset_enabled)
    {
        return Ok(crate::reject::not_found());
    }
    let req: ResetReq = read_json(body).await?;
    super::check_password(&req.password)?;
    let client = state.client_ip(peer.ip(), &headers);
    super::limit_complete(&state, &crate::client_ip::bucket(client)).await?;
    if !plausible_token(&req.token) {
        return Err(invalid_link());
    }
    let hash = auth::hash_password_async(&req.password).await?;
    let mut tx = state.pg().begin().await?;
    if apply_reset(&mut tx, &req.token, &hash, Some(client))
        .await?
        .is_none()
    {
        return Err(invalid_link());
    }
    tx.commit().await?;
    Ok(super::ok_json(json!({ "ok": true })))
}
