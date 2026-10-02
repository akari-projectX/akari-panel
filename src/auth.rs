use argon2::{
    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},
    Argon2,
};
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::{http::StatusCode, Json};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use uuid::Uuid;

use crate::state::AppState;

pub const COOKIE_NAME: &str = "sid";
/// Session lifetime, shared by the JWT exp and the cookie Max-Age.
pub const COOKIE_TTL_SECS: i64 = 12 * 3600;

// ---------------------------------------------------------------------------
// API error type: every failure is a small JSON body, never a stack trace.
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    #[cfg(test)]
    pub fn status(&self) -> StatusCode {
        self.status
    }
    pub fn message(&self) -> &str {
        &self.message
    }
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized")
    }
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden")
    }
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not found")
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, msg)
    }
    pub fn too_many() -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "too many requests")
    }
    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "api internal error");
        ApiError::internal()
    }
}

/// SQLSTATE raised by the last-admin guard (migration 0009).
pub const LAST_ADMIN_SQLSTATE: &str = "AK001";
/// SQLSTATE of the inviter guard (migration 0105): self-referral or cycle.
pub const INVITER_SQLSTATE: &str = "AK002";
/// SQLSTATE of the balance ledger (migration 0106): the entry would make
/// the balance negative.
pub const BALANCE_SQLSTATE: &str = "AK003";

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(d) = &e {
            if d.code().as_deref() == Some(LAST_ADMIN_SQLSTATE) {
                return ApiError::conflict("cannot remove the last enabled admin");
            }
            if d.code().as_deref() == Some(INVITER_SQLSTATE) {
                return ApiError::conflict("invalid inviter (self-referral or a cycle)");
            }
            if d.code().as_deref() == Some(BALANCE_SQLSTATE) {
                return ApiError::conflict("insufficient balance");
            }
        }
        tracing::error!(error = %e, "api db error");
        ApiError::internal()
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        tracing::error!(error = %e, "api serialization error");
        ApiError::internal()
    }
}

// ---------------------------------------------------------------------------
// Passwords (argon2id) and session tokens (HS256 JWT in an HttpOnly cookie).
// ---------------------------------------------------------------------------

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    // Argon2id v19 with OWASP-default params; the salt is generated inside.
    Ok(Argon2::default()
        .hash_password(password.as_bytes())?
        .to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Burn equivalent CPU when the login cannot succeed, so response timing
/// does not reveal whether an account exists.
pub fn scrub_password(password: &str) {
    let _ = Argon2::default().hash_password(password.as_bytes());
}

/// What a session may do (M1-6). Required claim: tokens issued before it
/// existed fail to decode (everyone logs in again after the upgrade).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// Fully authenticated (password, plus the second factor when the
    /// account has one).
    Full,
    /// Only with `auth.require_admin_2fa`: an admin that passed the
    /// password but has no active TOTP yet. Only the enrollment endpoints
    /// accept it (`SessionUser`), never `AuthUser`.
    Enroll,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Full => "full",
            Stage::Enroll => "enroll",
        }
    }
    /// Session (JWT exp and cookie Max-Age) lifetime.
    pub fn ttl_secs(self) -> i64 {
        match self {
            Stage::Full => COOKIE_TTL_SECS,
            Stage::Enroll => ENROLL_TTL_SECS,
        }
    }
}

/// Lifetime of an enrollment-only session.
pub const ENROLL_TTL_SECS: i64 = 15 * 60;

#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub role: String,
    /// users.session_ver at issue time (S4-2). A token whose sv differs
    /// from the row is dead: password change, disable, role change, expiry
    /// enforcement, logout, "revoke sessions", 2FA activation/reset and JWT
    /// key rotation all bump it. Required: pre-0009 tokens (no sv) fail to
    /// decode.
    pub sv: i64,
    pub st: Stage,
    pub iat: u64,
    pub exp: u64,
}

pub fn issue_token(
    state: &AppState,
    user_id: Uuid,
    role: &str,
    session_ver: i64,
    stage: Stage,
) -> anyhow::Result<String> {
    let now = chrono::Utc::now().timestamp() as u64;
    let claims = Claims {
        sub: user_id,
        role: role.to_owned(),
        sv: session_ver,
        st: stage,
        iat: now,
        exp: now + stage.ttl_secs() as u64,
    };
    Ok(encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret().as_bytes()),
    )?)
}

/// A valid (signature, expiry) token's claims; says nothing about whether
/// the session is still live (see AuthUser).
pub fn decode_token(state: &AppState, token: &str) -> Option<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.jwt_secret().as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .ok()
    .map(|t| t.claims)
}

/// The session cookie carrying `token` (web.cookie_secure decides Secure).
pub fn session_cookie(state: &AppState, token: String, stage: Stage) -> Cookie<'static> {
    Cookie::build((COOKIE_NAME, token))
        .http_only(true)
        .same_site(SameSite::Strict)
        .path("/")
        .secure(state.cfg().web.cookie_secure)
        .max_age(time::Duration::seconds(stage.ttl_secs()))
        .build()
}

/// A cookie that deletes the session cookie in the browser.
pub fn cleared_cookie(state: &AppState) -> Cookie<'static> {
    Cookie::build((COOKIE_NAME, ""))
        .http_only(true)
        .same_site(SameSite::Strict)
        .path("/")
        .secure(state.cfg().web.cookie_secure)
        .max_age(time::Duration::ZERO)
        .build()
}

// ---------------------------------------------------------------------------
// Session extractors. Both bind the session to a live, enabled user on every
// request (no stale-role or stale-enabled states from old tokens).
// ---------------------------------------------------------------------------

/// A fully authenticated session (stage Full). With
/// `auth.require_admin_2fa` an admin session is only accepted while the
/// admin has an active TOTP (defense in depth: every path that removes it
/// also bumps session_ver; turning the option on ends the full sessions of
/// admins without 2FA at their next request).
pub struct AuthUser {
    pub id: Uuid,
    pub login: String,
    pub role: String,
    /// Client address (behind trusted proxies: the forwarded client);
    /// None only where no connection info exists (tests).
    pub ip: Option<IpAddr>,
}

impl AuthUser {
    pub fn require_admin(&self) -> Result<(), ApiError> {
        if self.role == "admin" {
            Ok(())
        } else {
            Err(ApiError::forbidden())
        }
    }
}

/// Any live session, including an enrollment-only one. Only the 2FA
/// enrollment endpoints take this.
pub struct SessionUser {
    pub id: Uuid,
    pub login: String,
    pub role: String,
    pub stage: Stage,
    pub ip: Option<IpAddr>,
}

/// The request's client address (see client_ip.rs), if the connection info
/// is present.
pub fn request_ip(parts: &Parts, state: &AppState) -> Option<IpAddr> {
    parts
        .extensions
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .map(|ci| state.client_ip(ci.0.ip(), &parts.headers))
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: Uuid,
    login: String,
    role: String,
    enabled: bool,
    /// role=user past expires_at (DB clock; `enforce::EXPIRED`).
    expired: bool,
    /// role=user disabled by the traffic-limit pass (disabled_reason
    /// 'quota'): renewal scope only (R21).
    quota_disabled: bool,
    session_ver: i64,
    totp_active: bool,
}

async fn session(parts: &mut Parts, state: &AppState) -> Result<(Claims, SessionRow), ApiError> {
    let jar = CookieJar::from_request_parts(parts, state)
        .await
        .unwrap_or_default();
    let token = jar
        .get(COOKIE_NAME)
        .map(|c| c.value())
        .ok_or_else(ApiError::unauthorized)?;

    let claims = decode_token(state, token).ok_or_else(ApiError::unauthorized)?;

    // Disabled accounts lose existing sessions (quota-disabled users keep
    // the renewal scope); so does every token issued before the last
    // session_ver bump. Expired or quota-disabled role=user accounts keep
    // only the renewal scope (`ShopUser`, R21): `restricted()` callers refuse.
    let row = sqlx::query_as::<_, SessionRow>(sqlx::AssertSqlSafe(format!(
        "SELECT u.id, u.login, u.role, u.enabled, {} AS expired, \
         (u.role = 'user' AND NOT u.enabled AND u.disabled_reason = 'quota') AS quota_disabled, \
         u.session_ver, \
         EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id AND t.enabled_at IS NOT NULL) \
         AS totp_active FROM users u WHERE u.id = $1",
        crate::enforce::EXPIRED
    )))
    .bind(claims.sub)
    .fetch_optional(state.pg())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "auth db error");
        ApiError::internal()
    })?
    .ok_or_else(ApiError::unauthorized)?;

    if (!row.enabled && !row.quota_disabled) || row.session_ver != claims.sv {
        return Err(ApiError::unauthorized());
    }
    Ok((claims, row))
}

impl SessionRow {
    /// Renewal scope only (R21): `AuthUser`/`SessionUser` refuse it.
    fn restricted(&self) -> bool {
        self.expired || !self.enabled
    }
}

/// Whether this account may only hold an enrollment-only session: an
/// admin without active TOTP while `auth.require_admin_2fa` is on (R18:
/// otherwise 2FA is optional for everyone).
pub fn needs_enrollment(state: &AppState, role: &str, totp_active: bool) -> bool {
    state.cfg().auth.require_admin_2fa && role == "admin" && !totp_active
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let (claims, row) = session(parts, state).await?;
        if row.restricted()
            || claims.st != Stage::Full
            || needs_enrollment(state, &row.role, row.totp_active)
        {
            return Err(ApiError::unauthorized());
        }
        Ok(AuthUser {
            id: row.id,
            login: row.login,
            role: row.role,
            ip: request_ip(parts, state),
        })
    }
}

impl FromRequestParts<AppState> for SessionUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let (claims, row) = session(parts, state).await?;
        if row.restricted() {
            return Err(ApiError::unauthorized());
        }
        // A full token of an admin the policy now confines to enrollment
        // (the option was turned on later) reports as an enrollment
        // session, so the console shows the enrollment page.
        let stage = if needs_enrollment(state, &row.role, row.totp_active) {
            Stage::Enroll
        } else {
            claims.st
        };
        Ok(SessionUser {
            id: row.id,
            login: row.login,
            role: row.role,
            stage,
            ip: request_ip(parts, state),
        })
    }
}

/// The renewal scope (R21, xboard parity): a full session that may also
/// belong to an EXPIRED or QUOTA-DISABLED (disabled_reason 'quota') role=user
/// account, so it can still see its account and plan, change its password
/// and buy/renew (shop, orders). Everything that serves or reveals proxy
/// access (subscription, sub-token, nodes, 2FA) keeps `AuthUser`, which
/// refuses both. Accounts disabled for any other reason are refused here
/// exactly as in `AuthUser`; admins are never expired or quota-disabled
/// (role=user only) and get the same checks.
pub struct ShopUser {
    pub user: AuthUser,
    /// The account is past its expiry (role=user).
    pub expired: bool,
    /// The account was disabled for exceeding its traffic limit.
    pub quota_exhausted: bool,
}

impl FromRequestParts<AppState> for ShopUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let (claims, row) = session(parts, state).await?;
        if claims.st != Stage::Full || needs_enrollment(state, &row.role, row.totp_active) {
            return Err(ApiError::unauthorized());
        }
        Ok(ShopUser {
            expired: row.expired,
            quota_exhausted: row.quota_disabled,
            user: AuthUser {
                id: row.id,
                login: row.login,
                role: row.role,
                ip: request_ip(parts, state),
            },
        })
    }
}

/// The request's client address, if connection info is present (always in
/// production). Never rejects, so it is safe on endpoints whose every
/// failure must be the canonical rejection (the subscription).
pub struct MaybeClientIp(pub Option<IpAddr>);

impl FromRequestParts<AppState> for MaybeClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(MaybeClientIp(request_ip(parts, state)))
    }
}
