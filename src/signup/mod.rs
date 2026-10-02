//! Self-service accounts (W15, M7): registration with an emailed code,
//! password reset by emailed link, email (re)verification in the portal,
//! per-user invite codes, and the 系统设置 → 注册 settings.
//!
//! Rules (T1):
//! - **Off by default.** While registration (or reset) is disabled its
//!   public endpoints answer `reject::not_found()` — byte-identical to any
//!   junk path — before reading the body (`Body`, not a rejecting
//!   extractor). Settings are read per request (no cache): every instance
//!   sees a change at once.
//! - **No account-existence oracle.** The code / reset-link requests answer
//!   the same `{"ok":true}` after the same synchronous work (validation of
//!   the request itself, rate limits) whether or not the address has an
//!   account; the account-dependent work (lookup, code, outbox insert) runs
//!   after the response in a spawned task. An address that already has an
//!   account gets a "this address is registered" mail instead of a code.
//!   Completing with a wrong/expired/used code (or racing another
//!   registration of the address) is one "invalid or expired code".
//! - **Codes**: 6 digits, 10 minutes, single use, at most 5 wrong attempts,
//!   one live code per (purpose, subject); stored as an HMAC
//!   (`totp::Keys::mail_code_hash`). **Reset links**: 256-bit token in the
//!   URL fragment (never sent to a server log), SHA-256 stored, 30 minutes,
//!   single use, bound to the verified address it was sent to; using it
//!   changes the password, which bumps `session_ver` (0009 trigger: every
//!   session ends).
//! - **Rate limits** in Valkey (all instances; fail closed): mail sends per
//!   client address and per destination address (hour and day windows);
//!   completions per client address.
//! - **Invites**: `users.inviter_id` is set once, by the registration
//!   transaction, from the invite code's owner (`invite.rs`). W16 builds
//!   commission on that column.

pub mod email;
pub mod invite;
pub(crate) mod profile;
pub(crate) mod register;
pub(crate) mod reset;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

pub use profile::{request_email_change, set_locale, verify_email_change};

/// Verification code lifetime.
pub const CODE_TTL_SECS: i64 = 600;
/// Wrong attempts that burn a code.
pub const CODE_MAX_ATTEMPTS: i32 = 5;
/// Reset link lifetime.
pub const RESET_TTL_SECS: i64 = 1800;
/// Password length bounds (bytes; argon2 cost must stay bounded).
pub const PASSWORD_MIN: usize = 8;
pub const PASSWORD_MAX: usize = 256;
/// Largest accepted JSON body of the public endpoints.
const MAX_BODY: usize = 16 * 1024;

/// Mail sends per client address (/64 for IPv6) per hour.
pub const SEND_PER_IP_HOUR: i64 = 10;
/// Mail sends per destination address per hour / per day.
pub const SEND_PER_ADDR_HOUR: i64 = 5;
pub const SEND_PER_ADDR_DAY: i64 = 20;
/// Code / token completions per client address per 15 minutes.
pub const COMPLETE_PER_IP: i64 = 30;

// ---------------------------------------------------------------------------
// Settings (系统设置 → 注册)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SignupSettings {
    pub version: i64,
    pub register_enabled: bool,
    pub invite_required: bool,
    pub invite_single_use: bool,
    pub invite_codes_per_user: i32,
    pub email_domains: Vec<String>,
    pub trial_plan_id: Option<Uuid>,
    pub trial_days: i32,
    pub reset_enabled: bool,
}

const SETTINGS_COLS: &str = "version, register_enabled, invite_required, invite_single_use, \
     invite_codes_per_user, email_domains, trial_plan_id, trial_days, reset_enabled";

pub async fn load_settings(conn: &mut PgConnection) -> sqlx::Result<SignupSettings> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SETTINGS_COLS} FROM signup_settings WHERE id = 1"
    )))
    .fetch_one(conn)
    .await
}

/// The settings, or None when they cannot be read (callers that must stay
/// indistinguishable from a junk path treat that as "disabled").
async fn settings_or_none(state: &AppState) -> Option<SignupSettings> {
    let mut c = match state.pg().acquire().await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "signup settings: no database connection");
            return None;
        }
    };
    match load_settings(&mut c).await {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::error!(error = %e, "signup settings unavailable");
            None
        }
    }
}

#[derive(Serialize)]
pub struct SignupView {
    version: i64,
    register_enabled: bool,
    invite_required: bool,
    invite_single_use: bool,
    invite_codes_per_user: i32,
    email_domains: Vec<String>,
    trial_plan_id: Option<Uuid>,
    trial_days: i32,
    reset_enabled: bool,
    /// SMTP sending is enabled (registration and reset need it).
    mail_enabled: bool,
    /// A main domain is configured (reset links need it).
    public_origin: Option<String>,
    warnings: Vec<String>,
}

async fn view(state: &AppState, conn: &mut PgConnection) -> Result<SignupView, ApiError> {
    let s = load_settings(conn).await?;
    let smtp = crate::mail::load(conn).await?;
    let origin = state.settings().get().public_origin();
    let mut warnings = Vec::new();
    if (s.register_enabled || s.reset_enabled) && !smtp.enabled {
        warnings.push("邮件发送未启用：验证码与重置链接无法送达".into());
    }
    if s.reset_enabled && origin.is_none() {
        warnings.push("未设置主域名：找回密码的重置链接无法生成".into());
    }
    if let Some(p) = s.trial_plan_id {
        let enabled: Option<bool> = sqlx::query_scalar("SELECT enabled FROM plans WHERE id = $1")
            .bind(p)
            .fetch_optional(&mut *conn)
            .await?;
        if enabled != Some(true) {
            warnings.push("试用套餐已停用：新用户不会获得试用".into());
        }
    }
    Ok(SignupView {
        version: s.version,
        register_enabled: s.register_enabled,
        invite_required: s.invite_required,
        invite_single_use: s.invite_single_use,
        invite_codes_per_user: s.invite_codes_per_user,
        email_domains: s.email_domains,
        trial_plan_id: s.trial_plan_id,
        trial_days: s.trial_days,
        reset_enabled: s.reset_enabled,
        mail_enabled: smtp.enabled,
        public_origin: origin,
        warnings,
    })
}

/// GET /api/v1/settings/signup (admin).
pub async fn get_signup_settings(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<SignupView>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    Ok(Json(view(&state, &mut c).await?))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignupReq {
    pub version: i64,
    pub register_enabled: bool,
    pub invite_required: bool,
    pub invite_single_use: bool,
    pub invite_codes_per_user: i32,
    pub email_domains: Vec<String>,
    pub trial_plan_id: Option<Uuid>,
    pub trial_days: i32,
    pub reset_enabled: bool,
}

/// Validate and normalise a settings request (domains → punycode, deduped).
pub fn signup_values(req: &SignupReq) -> Result<SignupReq, ApiError> {
    if !(0..=100).contains(&req.invite_codes_per_user) {
        return Err(ApiError::bad_request("invite_codes_per_user must be 0-100"));
    }
    if !(1..=3650).contains(&req.trial_days) {
        return Err(ApiError::bad_request("trial_days must be 1-3650"));
    }
    if req.email_domains.len() > 100 {
        return Err(ApiError::bad_request("at most 100 email domains"));
    }
    let mut domains: Vec<String> = Vec::new();
    for d in &req.email_domains {
        let n = email::parse_domain(d.trim_start_matches('@'))
            .ok_or_else(|| ApiError::bad_request(format!("invalid email domain: {d}")))?;
        if !domains.contains(&n) {
            domains.push(n);
        }
    }
    Ok(SignupReq {
        email_domains: domains,
        ..req.clone()
    })
}

/// Write the registration settings (optimistic concurrency) + audit, in
/// the caller's transaction. Enabling registration or reset needs SMTP
/// sending; reset also needs a main domain (the link's origin).
pub async fn apply_update_settings(
    conn: &mut PgConnection,
    actor: &Actor,
    has_origin: bool,
    v: &SignupReq,
) -> Result<(), ApiError> {
    let cur: SignupSettings = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SETTINGS_COLS} FROM signup_settings WHERE id = 1 FOR UPDATE"
    )))
    .fetch_one(&mut *conn)
    .await?;
    if cur.version != v.version {
        return Err(ApiError::conflict(
            "settings changed meanwhile; reload and retry",
        ));
    }
    let smtp = crate::mail::load(conn).await?;
    if (v.register_enabled && !cur.register_enabled || v.reset_enabled && !cur.reset_enabled)
        && !smtp.enabled
    {
        return Err(ApiError::conflict(
            "enable mail sending (系统设置 → 邮件) first",
        ));
    }
    if v.reset_enabled && !cur.reset_enabled && !has_origin {
        return Err(ApiError::conflict(
            "set the main domain first: reset links need it",
        ));
    }
    if let Some(p) = v.trial_plan_id {
        let exists: Option<bool> = sqlx::query_scalar("SELECT enabled FROM plans WHERE id = $1")
            .bind(p)
            .fetch_optional(&mut *conn)
            .await?;
        if exists.is_none() {
            return Err(ApiError::bad_request("unknown trial plan"));
        }
    }
    sqlx::query(
        "UPDATE signup_settings SET version = version + 1, register_enabled = $1, \
         invite_required = $2, invite_single_use = $3, invite_codes_per_user = $4, \
         email_domains = $5, trial_plan_id = $6, trial_days = $7, reset_enabled = $8, \
         updated_at = now() WHERE id = 1",
    )
    .bind(v.register_enabled)
    .bind(v.invite_required)
    .bind(v.invite_single_use)
    .bind(v.invite_codes_per_user)
    .bind(&v.email_domains)
    .bind(v.trial_plan_id)
    .bind(v.trial_days)
    .bind(v.reset_enabled)
    .execute(&mut *conn)
    .await?;
    let snap =
        |r: bool, ir: bool, su: bool, n: i32, d: &[String], p: Option<Uuid>, td: i32, re: bool| {
            json!({
                "register_enabled": r, "invite_required": ir, "invite_single_use": su,
                "invite_codes_per_user": n, "email_domains": d, "trial_plan_id": p,
                "trial_days": td, "reset_enabled": re,
            })
        };
    crate::audit::record(
        conn,
        actor,
        "settings.signup.update",
        "settings",
        Some("signup".into()),
        Some(snap(
            cur.register_enabled,
            cur.invite_required,
            cur.invite_single_use,
            cur.invite_codes_per_user,
            &cur.email_domains,
            cur.trial_plan_id,
            cur.trial_days,
            cur.reset_enabled,
        )),
        Some(snap(
            v.register_enabled,
            v.invite_required,
            v.invite_single_use,
            v.invite_codes_per_user,
            &v.email_domains,
            v.trial_plan_id,
            v.trial_days,
            v.reset_enabled,
        )),
    )
    .await?;
    Ok(())
}

/// PUT /api/v1/settings/signup (admin).
pub async fn put_signup_settings(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<SignupReq>,
) -> Result<Json<SignupView>, ApiError> {
    user.require_admin()?;
    let v = signup_values(&req)?;
    let has_origin = state.settings().get().public_origin().is_some();
    let mut tx = state.pg().begin().await?;
    apply_update_settings(&mut tx, &Actor::of(&user), has_origin, &v).await?;
    let out = view(&state, &mut tx).await?;
    tx.commit().await?;
    Ok(Json(out))
}

/// GET /{prefix}/auth/options (public): what the login page offers.
pub async fn options(State(state): State<AppState>) -> Json<serde_json::Value> {
    let s = settings_or_none(&state).await;
    Json(match s {
        Some(s) => json!({
            "register": s.register_enabled,
            "invite_required": s.register_enabled && s.invite_required,
            "email_domains": if s.register_enabled { s.email_domains } else { Vec::new() },
            "reset": s.reset_enabled,
        }),
        None => {
            json!({ "register": false, "invite_required": false, "email_domains": [], "reset": false })
        }
    })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Read a public endpoint's JSON body (after the enabled check, so a
/// disabled endpoint never reveals itself through a body error).
pub(crate) async fn read_json<T: serde::de::DeserializeOwned>(
    body: axum::body::Body,
) -> Result<T, ApiError> {
    let bytes = axum::body::to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| ApiError::bad_request("request body too large"))?;
    serde_json::from_slice(&bytes).map_err(|e| ApiError::bad_request(e.to_string()))
}

pub(crate) fn check_password(p: &str) -> Result<(), ApiError> {
    if p.len() < PASSWORD_MIN {
        return Err(ApiError::bad_request(
            "password must be at least 8 characters",
        ));
    }
    if p.len() > PASSWORD_MAX {
        return Err(ApiError::bad_request("password is too long"));
    }
    Ok(())
}

fn valkey_err(e: fred::error::Error) -> ApiError {
    tracing::error!(error = %e, "signup rate limit unavailable");
    ApiError::internal()
}

fn addr_key(email: &str) -> String {
    hex::encode(Sha256::digest(email.as_bytes()))
}

/// Count one outgoing mail against the client address and the destination
/// address; Err(429) over any limit (every window is counted).
pub(crate) async fn limit_send(
    state: &AppState,
    client_bucket: &str,
    email: &str,
) -> Result<(), ApiError> {
    let a = addr_key(email);
    let ip = crate::rate::hit(
        state,
        format!("akari:rl:mail:ip:{client_bucket}"),
        SEND_PER_IP_HOUR,
        3600,
    )
    .await
    .map_err(valkey_err)?;
    let h = crate::rate::hit(
        state,
        format!("akari:rl:mail:to:h:{a}"),
        SEND_PER_ADDR_HOUR,
        3600,
    )
    .await
    .map_err(valkey_err)?;
    let d = crate::rate::hit(
        state,
        format!("akari:rl:mail:to:d:{a}"),
        SEND_PER_ADDR_DAY,
        86_400,
    )
    .await
    .map_err(valkey_err)?;
    if ip && h && d {
        Ok(())
    } else {
        Err(ApiError::too_many())
    }
}

/// Count one completion attempt (code / token) of the client address.
pub(crate) async fn limit_complete(state: &AppState, client_bucket: &str) -> Result<(), ApiError> {
    let ok = crate::rate::hit(
        state,
        format!("akari:rl:signup:done:{client_bucket}"),
        COMPLETE_PER_IP,
        900,
    )
    .await
    .map_err(valkey_err)?;
    if ok {
        Ok(())
    } else {
        Err(ApiError::too_many())
    }
}

/// A fresh 6-digit code (uniform, leading zeros kept).
pub fn new_code() -> String {
    format!("{:06}", rand::rng().random_range(0..1_000_000u32))
}

/// Six ASCII digits.
pub fn plausible_code(c: &str) -> bool {
    c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit())
}

/// Store a new code for (purpose, subject), replacing any previous one.
pub async fn issue_code(
    conn: &mut PgConnection,
    keys: &crate::totp::Keys,
    purpose: &str,
    subject: &str,
    email: &str,
    user_id: Option<Uuid>,
) -> sqlx::Result<String> {
    let code = new_code();
    let hash = keys.mail_code_hash(purpose, subject, email, &code);
    sqlx::query(
        "INSERT INTO email_codes (purpose, subject, email, user_id, code_hash, expires_at) \
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) \
         ON CONFLICT (purpose, subject) DO UPDATE SET email = EXCLUDED.email, \
         user_id = EXCLUDED.user_id, code_hash = EXCLUDED.code_hash, attempts = 0, \
         created_at = now(), expires_at = EXCLUDED.expires_at, used_at = NULL",
    )
    .bind(purpose)
    .bind(subject)
    .bind(email)
    .bind(user_id)
    .bind(&hash)
    .bind(CODE_TTL_SECS as f64)
    .execute(conn)
    .await?;
    Ok(code)
}

#[derive(Debug, PartialEq, Eq)]
pub enum CodeCheck {
    /// Consumed (single use): the address it was issued for.
    Ok { email: String },
    /// Unknown, expired, used, burnt or wrong (a wrong one counts an
    /// attempt — the caller must COMMIT to keep that count).
    Invalid,
}

#[derive(sqlx::FromRow)]
struct CodeRow {
    email: String,
    code_hash: String,
    attempts: i32,
    live: bool,
}

/// Check and consume the code of (purpose, subject), locking its row.
pub async fn check_code(
    conn: &mut PgConnection,
    keys: &crate::totp::Keys,
    purpose: &str,
    subject: &str,
    code: &str,
) -> sqlx::Result<CodeCheck> {
    let row: Option<CodeRow> = sqlx::query_as(
        "SELECT email, code_hash, attempts, (used_at IS NULL AND expires_at > now()) AS live \
         FROM email_codes WHERE purpose = $1 AND subject = $2 FOR UPDATE",
    )
    .bind(purpose)
    .bind(subject)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        // Same HMAC work as a real check.
        let _ = keys.mail_code_hash(purpose, subject, "", code);
        return Ok(CodeCheck::Invalid);
    };
    let want = keys.mail_code_hash(purpose, subject, &row.email, code);
    let matches =
        plausible_code(code) && bool::from(want.as_bytes().ct_eq(row.code_hash.as_bytes()));
    if !row.live || row.attempts >= CODE_MAX_ATTEMPTS {
        return Ok(CodeCheck::Invalid);
    }
    if !matches {
        sqlx::query(
            "UPDATE email_codes SET attempts = attempts + 1 WHERE purpose = $1 AND subject = $2",
        )
        .bind(purpose)
        .bind(subject)
        .execute(&mut *conn)
        .await?;
        return Ok(CodeCheck::Invalid);
    }
    sqlx::query("UPDATE email_codes SET used_at = now() WHERE purpose = $1 AND subject = $2")
        .bind(purpose)
        .bind(subject)
        .execute(&mut *conn)
        .await?;
    Ok(CodeCheck::Ok { email: row.email })
}

/// Drop expired codes and reset links a day after expiry (mail sender's
/// housekeeping).
pub async fn prune(pg: &PgPool) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM email_codes WHERE expires_at < now() - interval '1 day'")
        .execute(pg)
        .await?;
    sqlx::query("DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'")
        .execute(pg)
        .await?;
    Ok(())
}

/// The handler result type of the public endpoints: the canonical
/// rejection while disabled, else JSON or an API error.
pub(crate) fn ok_json(v: serde_json::Value) -> Response {
    Json(v).into_response()
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{delete, get, post, put};
    axum::Router::new()
        .route("/{prefix}/auth/options", get(options))
        .route("/{prefix}/auth/register/code", post(register::request_code))
        .route("/{prefix}/auth/register", post(register::register))
        .route(
            "/{prefix}/auth/password-reset/request",
            post(reset::request_reset),
        )
        .route("/{prefix}/auth/password-reset", post(reset::reset_password))
        .route(
            "/{prefix}/api/v1/settings/signup",
            get(get_signup_settings).put(put_signup_settings),
        )
        .route("/{prefix}/api/v1/me/email/code", post(request_email_change))
        .route(
            "/{prefix}/api/v1/me/email/verify",
            post(verify_email_change),
        )
        .route("/{prefix}/api/v1/me/locale", put(set_locale))
        .route(
            "/{prefix}/api/v1/me/invite-codes",
            get(invite::list_codes).post(invite::create_code),
        )
        .route(
            "/{prefix}/api/v1/me/invite-codes/{code}",
            delete(invite::delete_code),
        )
}

#[cfg(test)]
mod tests;
