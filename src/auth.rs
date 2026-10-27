use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::{Json, http::StatusCode};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
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
    /// The database failed in a way that says nothing about the request
    /// (see [`is_transient`]); only `From<sqlx::Error>` sets it.
    transient: bool,
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
            transient: false,
        }
    }
    /// Whether the failure was a transient database error (serialization
    /// failure, deadlock, lock/statement timeout, connection loss): retrying
    /// the same work can succeed, so it must not be recorded as a verdict on
    /// the request (a paid order's fulfilment, for one).
    pub fn is_transient(&self) -> bool {
        self.transient
    }
    /// The canonical rejection (`reject::not_found`) as an error: an empty
    /// 404 without security headers (D4: an admin session on the portal).
    pub fn rejected() -> Self {
        Self::coded(
            StatusCode::NOT_FOUND,
            "",
            String::new(),
            serde_json::Map::new(),
        )
    }
    pub fn is_rejected(&self) -> bool {
        self.code.is_empty()
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
        if self.is_rejected() {
            return crate::reject::not_found();
        }
        (
            self.status,
            Json(json!({ "error": self.message, "code": self.code, "params": self.params })),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        if let Some(busy) = e.downcast_ref::<Argon2Busy>() {
            return (*busy).into();
        }
        tracing::error!(error = %e, "api internal error");
        ApiError::internal()
    }
}

/// SQLSTATE raised by the owner guard: deleting the
/// owner, or ending the ownership without a transfer.
pub const OWNER_SQLSTATE: &str = "AK001";
/// CHECK constraint: the owner is an enabled admin.
pub const OWNER_CHECK: &str = "users_owner_enabled_admin";
/// SQLSTATE of the inviter guard: self-referral or cycle.
pub const INVITER_SQLSTATE: &str = "AK002";
/// SQLSTATE of the balance ledger: the entry would make
/// the balance negative.
pub const BALANCE_SQLSTATE: &str = "AK003";

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(d) = &e {
            if d.code().as_deref() == Some(OWNER_SQLSTATE) || d.constraint() == Some(OWNER_CHECK) {
                return crate::owner::protected();
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
        let mut err = ApiError::internal();
        err.transient = is_transient(&e);
        err
    }
}

/// A database error that is not a property of the statement or its data:
/// SQLSTATE class 40 (serialization failure, deadlock), 55P03 (lock
/// timeout), 57014 (statement timeout/cancel), class 08 (connection
/// exception), or a pool/IO/TLS failure. Data and integrity errors (class
/// 22/23, the `AK*` guards) are deterministic and are not transient.
pub fn is_transient(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Database(d) => d.code().is_some_and(|c| {
            c.starts_with("40") || c.starts_with("08") || c == "55P03" || c == "57014"
        }),
        sqlx::Error::Io(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::PoolTimedOut
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed => true,
        _ => false,
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
// threads x 19 MiB).
//
// Audit batch 2 (P2-3): the queue for a permit is bounded too. An unbounded
// queue let a flood of unauthenticated logins / sign-ups / reset attempts
// hold a task (and its request) each for as long as the backlog took to
// drain, which starved every other password check. Now at most
// `argon2_queue_max()` requests wait, none longer than `ARGON2_WAIT`; the
// rest are answered 503 `request.busy` at once (retry shortly). Verify, hash
// and scrub take the same path (same queue, same work), so the login's
// equal-work property (no account-existence oracle) is unchanged — and so is
// the busy answer: it depends on load, never on the account.

/// Concurrent argon2 runs per process: half the CPUs, at least 2. Leaves
/// the other half of the machine to the runtime workers while still letting
/// logins proceed in parallel.
pub fn argon2_permits() -> usize {
    let cores = std::thread::available_parallelism().map_or(2, |n| n.get());
    (cores / 2).max(2)
}

/// Requests that may wait for a permit (16 per permit: at ~50 ms a run the
/// last in line waits well under `ARGON2_WAIT`).
pub fn argon2_queue_max() -> usize {
    argon2_permits() * 16
}

/// The longest a request waits for a permit.
pub const ARGON2_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The password-hash queue is full (or the wait ran out): ask the client to
/// retry. Converts to 503 `request.busy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Busy;

impl std::fmt::Display for Argon2Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("password hashing is busy")
    }
}

impl std::error::Error for Argon2Busy {}

impl From<Argon2Busy> for ApiError {
    fn from(_: Argon2Busy) -> Self {
        api_error!(
            SERVICE_UNAVAILABLE,
            "request.busy",
            "the server is busy, try again shortly"
        )
    }
}

/// Permits plus a bounded waiting line.
struct Argon2Gate {
    permits: Arc<tokio::sync::Semaphore>,
    waiting: std::sync::atomic::AtomicUsize,
    queue_max: usize,
    wait: std::time::Duration,
}

/// Leaves the line when dropped (the wait ended, however it ended).
struct InLine<'a>(&'a std::sync::atomic::AtomicUsize);

impl Drop for InLine<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Argon2Gate {
    fn new(permits: usize, queue_max: usize, wait: std::time::Duration) -> Self {
        Self {
            permits: Arc::new(tokio::sync::Semaphore::new(permits)),
            waiting: std::sync::atomic::AtomicUsize::new(0),
            queue_max,
            wait,
        }
    }

    /// No permit free and the line full: the next request is answered busy.
    fn is_full(&self) -> bool {
        self.permits.available_permits() == 0
            && self.waiting.load(std::sync::atomic::Ordering::SeqCst) >= self.queue_max
    }

    /// A permit now, or after a bounded wait in a bounded line.
    async fn acquire(&self) -> Result<tokio::sync::OwnedSemaphorePermit, Argon2Busy> {
        use std::sync::atomic::Ordering;
        if let Ok(p) = self.permits.clone().try_acquire_owned() {
            return Ok(p);
        }
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= self.queue_max {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return Err(Argon2Busy);
        }
        let _line = InLine(&self.waiting);
        match tokio::time::timeout(self.wait, self.permits.clone().acquire_owned()).await {
            Ok(Ok(p)) => Ok(p),
            // Timed out (the semaphore is never closed).
            _ => Err(Argon2Busy),
        }
    }

    /// Runs `f` on the blocking pool under a permit. The permit moves into
    /// the blocking closure: a request that is cancelled while hashing (the
    /// client went away) still holds its permit until the CPU work ends, so
    /// cancellations cannot exceed the bound. A panicked task counts as
    /// busy (nothing was computed).
    async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, Argon2Busy> {
        let permit = self.acquire().await?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            f()
        })
        .await
        .map_err(|_| Argon2Busy)
    }
}

fn argon2_gate() -> &'static Argon2Gate {
    #[cfg(test)]
    if let Some(g) = TEST_GATE.with(|g| g.get()) {
        return g;
    }
    static GATE: OnceLock<Argon2Gate> = OnceLock::new();
    GATE.get_or_init(|| {
        // Unit tests run hundreds of debug-build hashes at once on a few
        // cores: no test may see a busy answer unless it asks for one.
        #[cfg(test)]
        return Argon2Gate::new(
            argon2_permits(),
            1 << 20,
            std::time::Duration::from_secs(900),
        );
        #[cfg(not(test))]
        Argon2Gate::new(argon2_permits(), argon2_queue_max(), ARGON2_WAIT)
    })
}

#[cfg(test)]
thread_local! {
    /// A test's own gate for the requests served on this thread.
    static TEST_GATE: std::cell::Cell<Option<&'static Argon2Gate>> =
        const { std::cell::Cell::new(None) };
}

/// Tests: a gate with no permits and no line on this thread until the guard
/// drops — every password hash / check answers `Argon2Busy` at once, so a
/// route-level test sees what a saturated server answers (and which steps
/// come before the hash).
#[cfg(test)]
pub(crate) fn saturate_argon2_for_test() -> impl Drop {
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_GATE.with(|g| g.set(None));
        }
    }
    let gate: &'static Argon2Gate = Box::leak(Box::new(Argon2Gate::new(0, 0, ARGON2_WAIT)));
    TEST_GATE.with(|g| g.set(Some(gate)));
    Restore
}

/// The password-hash line is full, so a request that needs a hash would be
/// answered 503 `request.busy` at the gate. Callers that would spend
/// database connections and Valkey round trips before reaching the hash
/// (the login) ask first and answer busy at once: under a flood the
/// refused requests then cost no pool connection, so the admin API
/// sharing the pool keeps its latency. Load-dependent only, never
/// account-dependent.
pub fn argon2_line_full() -> bool {
    argon2_gate().is_full()
}

async fn argon2_blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Argon2Busy> {
    argon2_gate().run(f).await
}

/// `hash_password` off the async workers (see above). A saturated queue is
/// an `Argon2Busy` inside the error (`ApiError::from` makes it a 503).
pub async fn hash_password_async(password: &str) -> anyhow::Result<String> {
    let password = password.to_owned();
    match argon2_blocking(move || hash_password(&password)).await {
        Ok(r) => r,
        Err(busy) => Err(busy.into()),
    }
}

/// `verify_password` off the async workers (see above).
pub async fn verify_password_async(password: &str, hash: &str) -> Result<bool, Argon2Busy> {
    let (password, hash) = (password.to_owned(), hash.to_owned());
    argon2_blocking(move || verify_password(&password, &hash)).await
}

/// `scrub_password` off the async workers (see above): the same queue and
/// the same work as a real verification.
pub async fn scrub_password_async(password: &str) -> Result<(), Argon2Busy> {
    let password = password.to_owned();
    argon2_blocking(move || scrub_password(&password)).await
}

#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub role: String,
    /// users.session_ver at issue time (S4-2). A token whose sv differs
    /// from the row is dead: password change, disable, role change, expiry
    /// enforcement, logout, "revoke sessions" and JWT key rotation all bump
    /// it. Required: pre-0009 tokens (no sv) fail to decode.
    pub sv: i64,
    pub iat: u64,
    pub exp: u64,
}

pub fn issue_token(
    state: &AppState,
    user_id: Uuid,
    role: &str,
    session_ver: i64,
) -> anyhow::Result<String> {
    let now = chrono::Utc::now().timestamp() as u64;
    let claims = Claims {
        sub: user_id,
        role: role.to_owned(),
        sv: session_ver,
        iat: now,
        exp: now + COOKIE_TTL_SECS as u64,
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
pub fn session_cookie(state: &AppState, token: String) -> Cookie<'static> {
    Cookie::build((COOKIE_NAME, token))
        .http_only(true)
        .same_site(SameSite::Strict)
        .path("/")
        .secure(state.cfg().web.cookie_secure)
        .max_age(time::Duration::seconds(COOKIE_TTL_SECS))
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

/// A live session of an enabled account in good standing (not expired, not
/// quota-disabled: those get the renewal scope `ShopUser` only).
pub struct AuthUser {
    pub id: Uuid,
    /// The account's email address (D1: the login name).
    pub email: String,
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
    email: String,
    role: String,
    enabled: bool,
    /// role=user past expires_at (DB clock; `enforce::EXPIRED`).
    expired: bool,
    /// role=user disabled by the traffic-limit pass (disabled_reason
    /// 'quota'): renewal scope only (R21).
    quota_disabled: bool,
    /// role=user banned by an admin (disabled_reason 'admin'): the portal
    /// scope only (`PortalUser`: the account, the ban reason, tickets).
    banned: bool,
    /// Registered with a passkey and no address bound yet: the binding
    /// endpoints only (`PendingUser`); every other extractor refuses.
    email_pending: bool,
    session_ver: i64,
}

async fn session(parts: &mut Parts, state: &AppState) -> Result<SessionRow, ApiError> {
    let jar = CookieJar::from_request_parts(parts, state)
        .await
        .unwrap_or_default();
    let token = jar
        .get(COOKIE_NAME)
        .map(|c| c.value())
        .ok_or_else(ApiError::unauthorized)?;

    let claims = decode_token(state, token).ok_or_else(ApiError::unauthorized)?;

    // Disabled accounts lose existing sessions (quota-disabled users keep
    // the renewal scope, banned users the portal scope); so does every
    // token issued before the last session_ver bump (a ban bumps it: the
    // banned user logs in again into the portal scope). Expired or
    // quota-disabled role=user accounts keep only the renewal scope
    // (`ShopUser`, R21): `restricted()` callers refuse.
    let row = sqlx::query_as::<_, SessionRow>(sqlx::AssertSqlSafe(format!(
        "SELECT u.id, u.email, u.role, u.enabled, {} AS expired, \
         (u.role = 'user' AND NOT u.enabled AND u.disabled_reason = 'quota') AS quota_disabled, \
         (u.role = 'user' AND NOT u.enabled AND u.disabled_reason = 'admin' \
          AND u.erased_at IS NULL) AS banned, \
         u.email_pending, u.session_ver FROM users u WHERE u.id = $1",
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

    if (!row.enabled && !row.quota_disabled && !row.banned) || row.session_ver != claims.sv {
        return Err(ApiError::unauthorized());
    }
    // D4: admin sessions work under the admin prefix only; on the portal
    // they do not exist (the canonical rejection, not a 401).
    if row.role == "admin" && portal(parts) {
        return Err(ApiError::rejected());
    }
    Ok(row)
}

/// Whether the request came in through the portal (`access::Via`).
pub fn portal(parts: &Parts) -> bool {
    parts.extensions.get::<crate::access::Via>() == Some(&crate::access::Via::Portal)
}

impl SessionRow {
    /// Renewal scope only (R21): `AuthUser` refuses it.
    fn restricted(&self) -> bool {
        self.expired || !self.enabled
    }

    /// A passkey registration whose address is not bound yet reaches only
    /// `PendingUser` (and `GET /me`, `PortalUser`).
    fn refuse_pending(&self) -> Result<(), ApiError> {
        if self.email_pending {
            return Err(api_error!(
                FORBIDDEN,
                "account.email_required",
                "bind your email address first"
            ));
        }
        Ok(())
    }

    /// W28-c: a banned account's session reaches only `PortalUser`
    /// endpoints; everything else answers this (the portal shows the ban).
    fn refuse_banned(&self) -> Result<(), ApiError> {
        if self.banned {
            return Err(api_error!(
                FORBIDDEN,
                "account.banned",
                "the account is banned"
            ));
        }
        Ok(())
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let row = session(parts, state).await?;
        row.refuse_banned()?;
        row.refuse_pending()?;
        if row.restricted() {
            return Err(ApiError::unauthorized());
        }
        Ok(AuthUser {
            id: row.id,
            email: row.email,
            role: row.role,
            ip: request_ip(parts, state),
        })
    }
}

/// The renewal scope (R21, xboard parity): a full session that may also
/// belong to an EXPIRED or QUOTA-DISABLED (disabled_reason 'quota') role=user
/// account, so it can still see its account and plan, change its password
/// and buy/renew (shop, orders). Everything that serves or reveals proxy
/// access (subscription, sub-token, nodes) keeps `AuthUser`, which
/// refuses both. A banned account (W28-c) gets 403 `account.banned` (it
/// only reaches `PortalUser`); accounts disabled for any other reason are
/// refused exactly as in `AuthUser`; admins are never expired, banned into
/// the portal scope or quota-disabled (role=user only).
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
        let p = PortalUser::from_request_parts(parts, state).await?;
        if p.email_pending {
            return Err(api_error!(
                FORBIDDEN,
                "account.email_required",
                "bind your email address first"
            ));
        }
        if p.banned {
            return Err(api_error!(
                FORBIDDEN,
                "account.banned",
                "the account is banned"
            ));
        }
        Ok(ShopUser {
            user: p.user,
            expired: p.expired,
            quota_exhausted: p.quota_exhausted,
        })
    }
}

/// The portal scope (W28-c, user ruling 2026-10-05): the renewal scope plus
/// accounts BANNED by an admin (role=user, disabled_reason 'admin'), which
/// may still sign in to read the ban reason (`GET /me`) and use tickets —
/// nothing else (subscription, nodes, shop and orders refuse them
/// server-side). Only those endpoints take it.
pub struct PortalUser {
    pub user: AuthUser,
    pub expired: bool,
    pub quota_exhausted: bool,
    pub banned: bool,
    /// The address is not bound yet (passkey registration): `GET /me` only.
    pub email_pending: bool,
}

impl FromRequestParts<AppState> for PortalUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let row = session(parts, state).await?;
        Ok(PortalUser {
            expired: row.expired,
            quota_exhausted: row.quota_disabled,
            banned: row.banned,
            email_pending: row.email_pending,
            user: AuthUser {
                id: row.id,
                email: row.email,
                role: row.role,
                ip: request_ip(parts, state),
            },
        })
    }
}

/// The session of an account that registered with a passkey and has not
/// bound an address yet (`users.email_pending`): the only extractor of the
/// binding endpoints. Any other account is 409 `account.email_bound`.
pub struct PendingUser {
    pub user: AuthUser,
}

impl FromRequestParts<AppState> for PendingUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let row = session(parts, state).await?;
        if !row.email_pending {
            return Err(api_error!(
                CONFLICT,
                "account.email_bound",
                "the account already has an email address"
            ));
        }
        Ok(PendingUser {
            user: AuthUser {
                id: row.id,
                email: row.email,
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
        let name = "x\"y".to_string();
        let e = bad_request!("entrance.name_invalid", "bad name {name:?}", name = name);
        assert_eq!(e.message(), r#"bad name "x\"y""#);
        assert_eq!(e.params()["name"], json!("x\"y"));
    }
}

#[cfg(test)]
mod argon2_tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// A password nobody typed (tests must not carry password literals).
    fn random_pw() -> String {
        format!("pw-{}", Uuid::new_v4().simple())
    }

    /// Review 2026-10-02 C1: a burst of logins must not starve the runtime.
    /// Two workers, many password checks in flight: a ticker on the same
    /// runtime keeps firing on time (with argon2 on the workers it stalled
    /// for whole hash durations), and every check still answers correctly.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn runtime_stays_responsive_during_a_login_burst() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (good, bad, unknown) = (random_pw(), random_pw(), random_pw());
        let hash = hash_password(&good).unwrap();
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
            let (good, bad, unknown) = (good.clone(), bad.clone(), unknown.clone());
            checks.spawn(async move {
                match i % 3 {
                    0 => verify_password_async(&good, &hash).await.unwrap(),
                    1 => !verify_password_async(&bad, &hash).await.unwrap(),
                    _ => {
                        scrub_password_async(&unknown).await.unwrap();
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

    /// Audit batch 2, P2-3: the line for a permit is bounded. With one
    /// permit and room for two waiters, a fourth request is refused at once;
    /// a waiter that is not served within the wait is refused too; once the
    /// backlog drains the gate serves again.
    #[tokio::test]
    async fn the_queue_is_bounded_and_answers_busy() {
        let gate = Arc::new(Argon2Gate::new(1, 2, Duration::from_millis(150)));
        let slow = |gate: Arc<Argon2Gate>| {
            tokio::spawn(async move {
                gate.run(|| std::thread::sleep(Duration::from_millis(400)))
                    .await
            })
        };
        let running = slow(gate.clone());
        tokio::time::sleep(Duration::from_millis(30)).await;
        // Two wait in line ...
        let w1 = slow(gate.clone());
        let w2 = slow(gate.clone());
        tokio::time::sleep(Duration::from_millis(30)).await;
        // ... the third finds the line full.
        let t = Instant::now();
        assert_eq!(gate.run(|| ()).await, Err(Argon2Busy));
        assert!(t.elapsed() < Duration::from_millis(100), "refused at once");
        // The waiters give up after the wait: nobody holds a request for
        // the whole backlog.
        assert_eq!(w1.await.unwrap(), Err(Argon2Busy));
        assert_eq!(w2.await.unwrap(), Err(Argon2Busy));
        assert_eq!(running.await.unwrap(), Ok(()));
        assert_eq!(gate.waiting.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(gate.run(|| 7).await, Ok(7), "served again");
    }

    /// `is_full` is true exactly when a request would be refused at the
    /// gate without waiting: no free permit and a full line.
    #[tokio::test]
    async fn is_full_matches_the_gate_refusing_at_once() {
        let gate = Arc::new(Argon2Gate::new(1, 1, Duration::from_millis(500)));
        assert!(!gate.is_full());
        let slow = |gate: Arc<Argon2Gate>| {
            tokio::spawn(async move {
                gate.run(|| std::thread::sleep(Duration::from_millis(200)))
                    .await
            })
        };
        let running = slow(gate.clone());
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!gate.is_full(), "a place in line is still free");
        let waiter = slow(gate.clone());
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(gate.is_full());
        assert_eq!(gate.run(|| ()).await, Err(Argon2Busy));
        assert_eq!(running.await.unwrap(), Ok(()));
        assert_eq!(waiter.await.unwrap(), Ok(()));
        assert!(!gate.is_full());
    }

    #[test]
    fn busy_is_a_503_with_its_own_code() {
        let e: ApiError = Argon2Busy.into();
        assert_eq!(
            (e.status(), e.code()),
            (StatusCode::SERVICE_UNAVAILABLE, "request.busy")
        );
        // Through anyhow (hash_password_async's error) too.
        let e: ApiError = anyhow::Error::from(Argon2Busy).into();
        assert_eq!(e.code(), "request.busy");
    }
}
