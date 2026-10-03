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
use std::sync::{Arc, OnceLock};
use uuid::Uuid;

use crate::state::AppState;

pub const COOKIE_NAME: &str = "sid";
/// Session lifetime, shared by the JWT exp and the cookie Max-Age.
pub const COOKIE_TTL_SECS: i64 = 12 * 3600;

// ---------------------------------------------------------------------------
// API error type: every failure is a small JSON body, never a stack trace.
//
// W21 (M6): every error carries a stable machine code and its parameters:
//   {"error": "<English message>", "code": "plan.speed_limit_range", "params": {"max": 100000}}
// The SPA maps the code to Chinese (admin) / zh+en (portal) and falls back to
// the message. Codes are API: never rename or reuse one (the SPA mapping and
// `scripts/check-error-codes.mjs` key on them). Build errors with the
// `bad_request!` / `conflict!` / `api_error!` macros below: the format
// string's named arguments are both interpolated into the message and sent
// as `params`, so the two cannot drift.
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
    code: &'static str,
    params: serde_json::Map<String, serde_json::Value>,
}

/// Whether `code` is a valid error code: two or more dot-separated
/// segments of `[a-z0-9_]` (checked at compile time by the macros).
pub const fn valid_code(code: &str) -> bool {
    let b = code.as_bytes();
    if b.is_empty() || b[0] == b'.' || b[b.len() - 1] == b'.' {
        return false;
    }
    let mut dots = 0;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'.' {
            if b[i - 1] == b'.' {
                return false;
            }
            dots += 1;
        } else if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_') {
            return false;
        }
        i += 1;
    }
    dots >= 1
}

/// `api_error!(STATUS, "ns.code", "message {name}", name = expr, ...)`:
/// an `ApiError` whose message interpolates the named arguments and whose
/// `params` carry them (JSON).
macro_rules! api_error {
    ($status:ident, $code:literal, $fmt:literal $(, $k:ident = $v:expr)* $(,)?) => {{
        const _: () = assert!($crate::auth::valid_code($code), "invalid error code");
        $( #[allow(clippy::redundant_locals)] let $k = $v; )*
        #[allow(unused_mut)]
        let mut params = ::serde_json::Map::new();
        $( params.insert(
            stringify!($k).to_string(),
            ::serde_json::to_value(&$k).unwrap_or(::serde_json::Value::Null),
        ); )*
        $crate::auth::ApiError::coded(
            ::axum::http::StatusCode::$status,
            $code,
            format!($fmt),
            params,
        )
    }};
}
pub(crate) use api_error;

/// 400 with a code (see `api_error!`).
macro_rules! bad_request {
    ($code:literal, $fmt:literal $(, $k:ident = $v:expr)* $(,)?) => {
        $crate::auth::api_error!(BAD_REQUEST, $code, $fmt $(, $k = $v)*)
    };
}
pub(crate) use bad_request;

/// 409 with a code (see `api_error!`).
macro_rules! conflict {
    ($code:literal, $fmt:literal $(, $k:ident = $v:expr)* $(,)?) => {
        $crate::auth::api_error!(CONFLICT, $code, $fmt $(, $k = $v)*)
    };
}
pub(crate) use conflict;

impl ApiError {
    pub fn status(&self) -> StatusCode {
        self.status
    }
    pub fn message(&self) -> &str {
        &self.message
    }
    /// The stable machine code (`"plan.name_exists"`).
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn params(&self) -> &serde_json::Map<String, serde_json::Value> {
        &self.params
    }
    /// Use the macros; this is their target.
    pub fn coded(
        status: StatusCode,
        code: &'static str,
        message: String,
        params: serde_json::Map<String, serde_json::Value>,
    ) -> Self {
        Self {
            status,
            message,
            code,
            params,
        }
    }
    fn plain(status: StatusCode, code: &'static str, message: &str) -> Self {
        Self::coded(status, code, message.to_string(), serde_json::Map::new())
    }
    pub fn unauthorized() -> Self {
        Self::plain(
            StatusCode::UNAUTHORIZED,
            "auth.unauthorized",
            "unauthorized",
        )
    }
    pub fn forbidden() -> Self {
        Self::plain(StatusCode::FORBIDDEN, "auth.forbidden", "forbidden")
    }
    pub fn not_found() -> Self {
        Self::plain(StatusCode::NOT_FOUND, "request.not_found", "not found")
    }
    pub fn too_many() -> Self {
        Self::plain(
            StatusCode::TOO_MANY_REQUESTS,
            "request.rate_limited",
            "too many requests",
        )
    }
    pub fn internal() -> Self {
        Self::plain(
            StatusCode::INTERNAL_SERVER_ERROR,
            "request.internal",
            "internal error",
        )
    }
    /// The same error with another status (rare: 422/502/503 answers).
    pub fn with_status(mut self, status: StatusCode) -> Self {
        self.status = status;
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": self.message, "code": self.code, "params": self.params })),
        )
            .into_response()
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
                return conflict!("user.last_admin", "cannot remove the last enabled admin");
            }
            if d.code().as_deref() == Some(INVITER_SQLSTATE) {
                return conflict!(
                    "invite.invalid_inviter",
                    "invalid inviter (self-referral or a cycle)"
                );
            }
            if d.code().as_deref() == Some(BALANCE_SQLSTATE) {
                return conflict!("balance.insufficient", "insufficient balance");
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

// Request paths never call the three functions above directly (review
// 2026-10-02 C1): one argon2 run is ~19 MiB and 40-80 ms of CPU, and the web
// server, the agent gRPC sessions, the traffic flush and LISTEN share one
// Tokio runtime. On a worker thread a login flood starves everything else
// (agents miss their keepalive PINGs and the whole fleet drops at once). The
// async wrappers run the hash on the blocking pool, and at most
// `argon2_permits()` at a time: the blocking pool alone is no bound (512
// threads x 19 MiB). Excess requests queue for a permit instead of failing.
// Verify, hash and scrub take the same path (same queue, same work), so the
// login's equal-work property (no account-existence oracle) is unchanged.

/// Concurrent argon2 runs per process: half the CPUs, at least 2. Leaves
/// the other half of the machine to the runtime workers while still letting
/// logins proceed in parallel.
pub fn argon2_permits() -> usize {
    let cores = std::thread::available_parallelism().map_or(2, |n| n.get());
    (cores / 2).max(2)
}

fn argon2_gate() -> &'static Arc<tokio::sync::Semaphore> {
    static GATE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(argon2_permits())))
}

/// Runs `f` on the blocking pool under an argon2 permit. The permit moves
/// into the blocking closure: a request that is cancelled while hashing (the
/// client went away) still holds its permit until the CPU work ends, so
/// cancellations cannot exceed the bound. `None` only if the task panicked.
async fn argon2_blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    // The semaphore is never closed; acquire cannot fail.
    let permit = argon2_gate().clone().acquire_owned().await.ok()?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        f()
    })
    .await
    .ok()
}

/// `hash_password` off the async workers (see above).
pub async fn hash_password_async(password: &str) -> anyhow::Result<String> {
    let password = password.to_owned();
    argon2_blocking(move || hash_password(&password))
        .await
        .unwrap_or_else(|| Err(anyhow::anyhow!("password hashing task failed")))
}

/// `verify_password` off the async workers (see above).
pub async fn verify_password_async(password: &str, hash: &str) -> bool {
    let (password, hash) = (password.to_owned(), hash.to_owned());
    argon2_blocking(move || verify_password(&password, &hash))
        .await
        .unwrap_or(false)
}

/// `scrub_password` off the async workers (see above): the same queue and
/// the same work as a real verification.
pub async fn scrub_password_async(password: &str) {
    let password = password.to_owned();
    argon2_blocking(move || scrub_password(&password)).await;
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
    state.settings().get().require_admin_2fa && role == "admin" && !totp_active
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

#[cfg(test)]
mod error_code_tests {
    use super::*;

    /// Codes used in the source: the literal after `bad_request!(`,
    /// `conflict!(`, `api_error!(STATUS,` and `Self::plain(STATUS,`.
    fn source_codes() -> std::collections::BTreeSet<String> {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        let mut files = Vec::new();
        walk(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let mut codes = std::collections::BTreeSet::new();
        for f in files {
            let s = std::fs::read_to_string(&f).unwrap();
            for marker in ["bad_request!(", "conflict!(", "api_error!(", "Self::plain("] {
                for (i, _) in s.match_indices(marker) {
                    let mut rest = s[i + marker.len()..].trim_start();
                    // Optional status argument.
                    if let Some(comma) = rest.find(',') {
                        let head = rest[..comma].trim();
                        if !head.starts_with('"')
                            && head
                                .trim_start_matches("StatusCode::")
                                .chars()
                                .all(|c| c.is_ascii_uppercase() || c == '_')
                        {
                            rest = rest[comma + 1..].trim_start();
                        }
                    }
                    let Some(lit) = rest.strip_prefix('"') else {
                        continue; // the macro definitions themselves
                    };
                    let code = &lit[..lit.find('"').unwrap()];
                    // The macros reject an invalid code at compile time,
                    // so anything else is not a code (e.g. this test).
                    if code != "ns.code" && valid_code(code) {
                        codes.insert(code.to_string());
                    }
                }
            }
        }
        codes
    }

    #[test]
    fn error_codes_are_registered() {
        let registry: std::collections::BTreeSet<String> = include_str!("error_codes.txt")
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_string)
            .collect();
        let used = source_codes();
        let missing: Vec<_> = used.difference(&registry).collect();
        let gone: Vec<_> = registry.difference(&used).collect();
        assert!(
            missing.is_empty(),
            "codes not in src/error_codes.txt (add them, and a SPA mapping): {missing:?}"
        );
        assert!(
            gone.is_empty(),
            "registered codes no longer used (codes are API: keep them stable): {gone:?}"
        );
        for c in &registry {
            assert!(valid_code(c), "{c}");
        }
    }

    #[test]
    fn code_syntax() {
        for ok in ["a.b", "plan.speed_limit_range", "x1.y_2.z"] {
            assert!(valid_code(ok), "{ok}");
        }
        for bad in ["", "a", ".a", "a.", "a..b", "A.b", "a.b-c", "a b.c"] {
            assert!(!valid_code(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn body_carries_message_code_and_params() {
        let e = bad_request!(
            "plan.speed_limit_range",
            "speed_limit_mbps must be 1..={max}",
            max = 100_000
        );
        assert_eq!(e.message(), "speed_limit_mbps must be 1..=100000");
        assert_eq!(e.code(), "plan.speed_limit_range");
        let resp = e.into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(resp.into_body(), 1 << 16)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            v,
            json!({
                "error": "speed_limit_mbps must be 1..=100000",
                "code": "plan.speed_limit_range",
                "params": { "max": 100_000 },
            })
        );
        let v = ApiError::unauthorized();
        assert_eq!(
            (v.code(), v.message()),
            ("auth.unauthorized", "unauthorized")
        );
        assert!(v.params().is_empty());
        // Debug formatting of a parameter stays in the message only.
        let tag = "x\"y".to_string();
        let e = bad_request!(
            "inbound.tag_duplicate",
            "duplicate inbound tag {tag:?}",
            tag = tag
        );
        assert_eq!(e.message(), r#"duplicate inbound tag "x\"y""#);
        assert_eq!(e.params()["tag"], json!("x\"y"));
    }
}

#[cfg(test)]
mod argon2_tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Review 2026-10-02 C1: a burst of logins must not starve the runtime.
    /// Two workers, many password checks in flight: a ticker on the same
    /// runtime keeps firing on time (with argon2 on the workers it stalled
    /// for whole hash durations), and every check still answers correctly.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn runtime_stays_responsive_during_a_login_burst() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let hash = hash_password("correct horse").unwrap();
        let burst = argon2_permits() * 4;
        let done = Arc::new(AtomicBool::new(false));
        let ticker = tokio::spawn({
            let done = done.clone();
            async move {
                let (mut worst, mut ticks) = (Duration::ZERO, 0u32);
                let mut last = Instant::now();
                while !done.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    let now = Instant::now();
                    worst = worst.max(now - last);
                    last = now;
                    ticks += 1;
                }
                (worst, ticks)
            }
        });
        let mut checks = tokio::task::JoinSet::new();
        for i in 0..burst {
            let hash = hash.clone();
            checks.spawn(async move {
                match i % 3 {
                    0 => verify_password_async("correct horse", &hash).await,
                    1 => !verify_password_async("wrong horse", &hash).await,
                    _ => {
                        scrub_password_async("unknown account").await;
                        true
                    }
                }
            });
        }
        while let Some(ok) = checks.join_next().await {
            assert!(ok.unwrap(), "a password check answered wrongly");
        }
        done.store(true, Ordering::SeqCst);
        let (worst, ticks) = ticker.await.unwrap();
        // The burst outlasted many ticks (each argon2 run is tens of ms or
        // more), and none of them was late by more than scheduling noise.
        assert!(
            worst < Duration::from_millis(250),
            "runtime stalled for {worst:?} while {burst} argon2 runs were in flight"
        );
        assert!(
            ticks >= 10,
            "burst finished too fast to measure ({ticks} ticks)"
        );
    }

    /// The permit bound holds, including for cancelled requests: at most
    /// `argon2_permits()` hashes ever run at once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_runs_never_exceed_the_permits() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static RUNNING: AtomicUsize = AtomicUsize::new(0);
        static PEAK: AtomicUsize = AtomicUsize::new(0);
        let mut tasks = Vec::new();
        for _ in 0..argon2_permits() * 4 {
            tasks.push(tokio::spawn(argon2_blocking(|| {
                let now = RUNNING.fetch_add(1, Ordering::SeqCst) + 1;
                PEAK.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(20));
                RUNNING.fetch_sub(1, Ordering::SeqCst);
            })));
        }
        // Cancel half of them mid-flight: their work still holds a permit.
        tokio::time::sleep(Duration::from_millis(5)).await;
        for t in tasks.iter().step_by(2) {
            t.abort();
        }
        for t in tasks {
            let _ = t.await;
        }
        while RUNNING.load(Ordering::SeqCst) > 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(PEAK.load(Ordering::SeqCst) <= argon2_permits());
    }
}
