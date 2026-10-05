//! Bot protection of the public forms (v0.4 D1): login, registration (code
//! request and completion) and the password-reset request.
//!
//! Two independent layers, both configured in 系统设置 → 登录与注册
//! (`auth_settings`, single row, read per request like the signup
//! settings — every instance sees a change at once):
//!
//! - **Honeypot + minimum submit time** (default on). `/auth/options` hands
//!   out a stateless form token (`issue_token`: issue time + nonce, MAC'd
//!   with a master-key-derived key); a submission must carry it, be at
//!   least `min_submit_secs` younger than now and at most a day old, and
//!   leave the hidden `website` field empty. A caught submission gets
//!   **exactly the answer of an ordinary failure** of that form (the
//!   caller decides which: the uniform 401 of the login, `{"ok":true}` of
//!   the mail requests, the generic refusal of a registration) and costs
//!   one Prometheus increment (`akari_bot_trap_total{form,reason}`) —
//!   nothing is logged per request. This only stops naive bots (a token
//!   may be reused within its day); the real barrier is Turnstile.
//! - **Cloudflare Turnstile**, switchable per form (login, registration,
//!   reset). The browser widget's token is verified server-side
//!   (siteverify, with the client address); the secret is sealed with the
//!   master key (`TURNSTILE_AAD`). Fail closed: a switched-on form refuses
//!   a missing or rejected token (400 `auth.captcha_failed`) and an
//!   unreachable or unreadable verifier (503 `auth.captcha_unavailable`).
//!
//! The trap is checked before Turnstile, so a bot never costs a siteverify
//! call.

use std::net::IpAddr;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, api_error, bad_request, conflict};
use crate::state::AppState;

/// The forms (metric label values).
pub const FORMS: [&str; 4] = ["login", "register", "register_code", "reset"];
/// Why a submission was trapped (metric label values).
pub const TRAP_REASONS: [&str; 3] = ["honeypot", "too_fast", "bad_token"];
/// AAD of the sealed Turnstile secret (`totp::Keys::seal`).
pub const TURNSTILE_AAD: Uuid = Uuid::from_u128(0x616b_6172_692d_7473_2d73_6563_7265_7431);
/// A form token older than this is refused (a page left open for a day
/// fetches a new one; the portal refreshes it after each failure).
pub const FORM_TOKEN_MAX_AGE_MS: i64 = 24 * 3600 * 1000;
/// Siteverify timeout.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound of a submitted Turnstile token (Cloudflare's are ~2 KiB).
const MAX_TURNSTILE_TOKEN: usize = 4096;
/// Form token: 8 bytes issue time (ms) + 8 bytes nonce + 16 bytes MAC.
const TOKEN_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Form {
    Login,
    Register,
    RegisterCode,
    Reset,
}

impl Form {
    pub fn as_str(self) -> &'static str {
        match self {
            Form::Login => "login",
            Form::Register => "register",
            Form::RegisterCode => "register_code",
            Form::Reset => "reset",
        }
    }

    /// Whether Turnstile protects this form (registration covers both its
    /// steps).
    fn turnstile(self, s: &Settings) -> bool {
        match self {
            Form::Login => s.turnstile_login,
            Form::Register | Form::RegisterCode => s.turnstile_register,
            Form::Reset => s.turnstile_reset,
        }
    }
}

/// The bot-protection part of a public form's body (`"guard": {…}`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Guard {
    /// From `/auth/options` (honeypot / minimum submit time).
    #[serde(default)]
    pub form_token: Option<String>,
    /// The honeypot: a field humans never see; must stay empty.
    #[serde(default)]
    pub website: Option<String>,
    /// The Turnstile widget's response token.
    #[serde(default)]
    pub turnstile: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Settings {
    pub version: i64,
    pub turnstile_site_key: Option<String>,
    pub turnstile_secret_enc: Option<Vec<u8>>,
    pub turnstile_login: bool,
    pub turnstile_register: bool,
    pub turnstile_reset: bool,
    pub honeypot: bool,
    pub min_submit_secs: i32,
}

const COLS: &str = "version, turnstile_site_key, turnstile_secret_enc, turnstile_login, \
     turnstile_register, turnstile_reset, honeypot, min_submit_secs";

pub async fn load(conn: &mut PgConnection) -> sqlx::Result<Settings> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM auth_settings WHERE id = 1"
    )))
    .fetch_one(conn)
    .await
}

// ---------------------------------------------------------------------------
// Form tokens
// ---------------------------------------------------------------------------

/// A fresh form token issued at `now_ms` (unix milliseconds).
pub fn issue_token(keys: &crate::totp::Keys, now_ms: i64) -> String {
    let mut buf = [0u8; TOKEN_LEN];
    buf[..8].copy_from_slice(&now_ms.to_be_bytes());
    rand::rng().fill_bytes(&mut buf[8..16]);
    let mac = keys.form_mac(&buf[..16]);
    buf[16..].copy_from_slice(&mac[..16]);
    URL_SAFE_NO_PAD.encode(buf)
}

/// The age (ms) of an authentic token; None for anything else.
fn token_age_ms(keys: &crate::totp::Keys, token: &str, now_ms: i64) -> Option<i64> {
    if token.len() > 64 {
        return None;
    }
    let raw = URL_SAFE_NO_PAD.decode(token).ok()?;
    if raw.len() != TOKEN_LEN {
        return None;
    }
    let mac = keys.form_mac(&raw[..16]);
    if !bool::from(mac[..16].ct_eq(&raw[16..])) {
        return None;
    }
    let issued = i64::from_be_bytes(raw[..8].try_into().ok()?);
    Some(now_ms.saturating_sub(issued))
}

/// Why a submission is a trap, if it is (pure: request + settings + clock).
pub fn trap_reason(
    keys: &crate::totp::Keys,
    s: &Settings,
    guard: Option<&Guard>,
    now_ms: i64,
) -> Option<&'static str> {
    let g = guard.cloned().unwrap_or_default();
    if s.honeypot && g.website.as_deref().is_some_and(|w| !w.is_empty()) {
        return Some("honeypot");
    }
    if s.min_submit_secs > 0 {
        let age = g
            .form_token
            .as_deref()
            .and_then(|t| token_age_ms(keys, t, now_ms));
        match age {
            None => return Some("bad_token"),
            Some(a) if !(0..=FORM_TOKEN_MAX_AGE_MS).contains(&a) => return Some("bad_token"),
            Some(a) if a < i64::from(s.min_submit_secs) * 1000 => return Some("too_fast"),
            Some(_) => {}
        }
    }
    None
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/// The outcome for a submission that passed every switched-on layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    /// Answer it like an ordinary failure of the form.
    Trap,
}

/// Run the form's checks. `Ok(Trap)` = the caller answers exactly like an
/// ordinary failure; `Err` = Turnstile refused (fail closed).
pub async fn check(
    state: &AppState,
    s: &Settings,
    form: Form,
    guard: Option<&Guard>,
    client: IpAddr,
) -> Result<Verdict, ApiError> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    if let Some(reason) = trap_reason(state.totp(), s, guard, now_ms) {
        crate::metrics::bot_trap(form.as_str(), reason);
        return Ok(Verdict::Trap);
    }
    if form.turnstile(s) {
        let token = guard
            .and_then(|g| g.turnstile.as_deref())
            .map(str::trim)
            .filter(|t| !t.is_empty() && t.len() <= MAX_TURNSTILE_TOKEN)
            .ok_or_else(captcha_failed)?;
        let secret = s
            .turnstile_secret_enc
            .as_deref()
            .and_then(|b| state.totp().open(TURNSTILE_AAD, b))
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or_else(|| {
                tracing::error!(
                    "the Turnstile secret cannot be opened (data/master.key changed?): \
                     enter it again under 系统设置"
                );
                captcha_unavailable()
            })?;
        if !siteverify(
            &state.cfg().limits.turnstile_verify_url,
            &secret,
            token,
            client,
        )
        .await?
        {
            return Err(captcha_failed());
        }
    }
    Ok(Verdict::Pass)
}

/// `check` with the settings read now (per request: every instance sees a
/// change at once).
pub async fn check_form(
    state: &AppState,
    form: Form,
    guard: Option<&Guard>,
    client: IpAddr,
) -> Result<Verdict, ApiError> {
    let s = {
        let mut c = state.pg().acquire().await?;
        load(&mut c).await?
    };
    check(state, &s, form, guard, client).await
}

fn captcha_failed() -> ApiError {
    bad_request!(
        "auth.captcha_failed",
        "the human verification failed; try again"
    )
}

fn captcha_unavailable() -> ApiError {
    api_error!(
        SERVICE_UNAVAILABLE,
        "auth.captcha_unavailable",
        "the human verification is unavailable; try again later"
    )
}

/// One siteverify call: Ok(true) = a valid token. Errors (network, a
/// non-200 or unreadable answer) are 503s: fail closed.
async fn siteverify(url: &str, secret: &str, token: &str, ip: IpAddr) -> Result<bool, ApiError> {
    let body = form_urlencoded::Serializer::new(String::new())
        .append_pair("secret", secret)
        .append_pair("response", token)
        .append_pair("remoteip", &crate::client_ip::canonical(ip).to_string())
        .finish();
    let (status, bytes) = crate::billing::http::post_form(url, body, VERIFY_TIMEOUT)
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "turnstile siteverify unreachable");
            captcha_unavailable()
        })?;
    if status != 200 {
        tracing::warn!(status, "turnstile siteverify answered an error");
        return Err(captcha_unavailable());
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| captcha_unavailable())?;
    Ok(v.get("success").and_then(Value::as_bool) == Some(true))
}

// ---------------------------------------------------------------------------
// Public part of /auth/options
// ---------------------------------------------------------------------------

/// What the public pages need: a fresh form token (when the minimum submit
/// time is on), the honeypot switch and the Turnstile site key + forms.
pub fn public_view(state: &AppState, s: &Settings) -> Value {
    let turnstile = s.turnstile_site_key.as_ref().map(|k| {
        json!({
            "site_key": k,
            "login": s.turnstile_login,
            "register": s.turnstile_register,
            "reset": s.turnstile_reset,
        })
    });
    let token = (s.min_submit_secs > 0)
        .then(|| issue_token(state.totp(), chrono::Utc::now().timestamp_millis()));
    json!({
        "form_token": token,
        "form_min_secs": s.min_submit_secs,
        "honeypot": s.honeypot,
        "turnstile": turnstile,
    })
}

// ---------------------------------------------------------------------------
// 系统设置 → 登录与注册 (admin)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SettingsView {
    version: i64,
    turnstile_site_key: Option<String>,
    /// Write-only secret: only whether one is stored.
    turnstile_secret_set: bool,
    turnstile_login: bool,
    turnstile_register: bool,
    turnstile_reset: bool,
    honeypot: bool,
    min_submit_secs: i32,
}

impl SettingsView {
    fn of(s: &Settings) -> Self {
        Self {
            version: s.version,
            turnstile_site_key: s.turnstile_site_key.clone(),
            turnstile_secret_set: s.turnstile_secret_enc.is_some(),
            turnstile_login: s.turnstile_login,
            turnstile_register: s.turnstile_register,
            turnstile_reset: s.turnstile_reset,
            honeypot: s.honeypot,
            min_submit_secs: s.min_submit_secs,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsReq {
    pub version: i64,
    /// null = none.
    pub turnstile_site_key: Option<String>,
    /// Absent = keep the stored secret; "" = remove it; else replace it.
    #[serde(default)]
    pub turnstile_secret: Option<String>,
    pub turnstile_login: bool,
    pub turnstile_register: bool,
    pub turnstile_reset: bool,
    pub honeypot: bool,
    pub min_submit_secs: i32,
}

fn valid_key(k: &str) -> bool {
    (1..=128).contains(&k.len())
        && k.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Write the settings (optimistic `version`) + audit
/// `settings.auth.update` (the secret only as "changed"), in the caller's
/// transaction.
pub async fn apply_update(
    conn: &mut PgConnection,
    keys: &crate::totp::Keys,
    actor: &Actor,
    req: &SettingsReq,
) -> Result<Settings, ApiError> {
    if !(0..=60).contains(&req.min_submit_secs) {
        return Err(bad_request!(
            "auth_admin.min_submit_range",
            "min_submit_secs must be 0-60"
        ));
    }
    let site_key = req
        .turnstile_site_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty());
    if site_key.is_some_and(|k| !valid_key(k)) {
        return Err(bad_request!(
            "auth_admin.turnstile_key_invalid",
            "the Turnstile site key must be 1-128 characters of [A-Za-z0-9_-]"
        ));
    }
    let cur: Settings = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM auth_settings WHERE id = 1 FOR UPDATE"
    )))
    .fetch_one(&mut *conn)
    .await?;
    if cur.version != req.version {
        return Err(conflict!(
            "settings.version_conflict",
            "settings changed meanwhile; reload and retry"
        ));
    }
    let secret_enc = match req.turnstile_secret.as_deref().map(str::trim) {
        None => cur.turnstile_secret_enc.clone(),
        Some("") => None,
        Some(s) if s.len() > 256 || s.chars().any(char::is_control) => {
            return Err(bad_request!(
                "auth_admin.turnstile_secret_invalid",
                "the Turnstile secret is not a valid key"
            ));
        }
        Some(s) => Some(keys.seal(TURNSTILE_AAD, s.as_bytes())?),
    };
    let any = req.turnstile_login || req.turnstile_register || req.turnstile_reset;
    if any && (site_key.is_none() || secret_enc.is_none()) {
        return Err(bad_request!(
            "auth_admin.turnstile_incomplete",
            "Turnstile needs both the site key and the secret before a form can use it"
        ));
    }
    let row: Settings = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE auth_settings SET version = version + 1, turnstile_site_key = $1, \
         turnstile_secret_enc = $2, turnstile_login = $3, turnstile_register = $4, \
         turnstile_reset = $5, honeypot = $6, min_submit_secs = $7, updated_at = now() \
         WHERE id = 1 RETURNING {COLS}"
    )))
    .bind(site_key)
    .bind(&secret_enc)
    .bind(req.turnstile_login)
    .bind(req.turnstile_register)
    .bind(req.turnstile_reset)
    .bind(req.honeypot)
    .bind(req.min_submit_secs)
    .fetch_one(&mut *conn)
    .await?;
    let snap = |s: &Settings, secret_changed: bool| {
        json!({
            "turnstile_site_key": s.turnstile_site_key,
            "turnstile_secret": if secret_changed { json!(crate::audit::CHANGED) }
                else { json!(s.turnstile_secret_enc.is_some()) },
            "turnstile_login": s.turnstile_login,
            "turnstile_register": s.turnstile_register,
            "turnstile_reset": s.turnstile_reset,
            "honeypot": s.honeypot,
            "min_submit_secs": s.min_submit_secs,
        })
    };
    let secret_changed = req.turnstile_secret.is_some();
    crate::audit::record(
        conn,
        actor,
        "settings.auth.update",
        "settings",
        Some("auth".into()),
        Some(snap(&cur, false)),
        Some(snap(&row, secret_changed)),
    )
    .await?;
    Ok(row)
}

/// `akari settings unset turnstile`: switch Turnstile off on every form
/// (keys kept) — the way back in when a misconfigured site key or secret
/// locks the login out. Audited like a console change.
pub async fn apply_turnstile_off(conn: &mut PgConnection, actor: &Actor) -> Result<(), ApiError> {
    let cur = load(conn).await?;
    let req = SettingsReq {
        version: cur.version,
        turnstile_site_key: cur.turnstile_site_key.clone(),
        turnstile_secret: None,
        turnstile_login: false,
        turnstile_register: false,
        turnstile_reset: false,
        honeypot: cur.honeypot,
        min_submit_secs: cur.min_submit_secs,
    };
    // No secret is sealed (absent = keep): any key set serves.
    let keys = crate::totp::Keys::from_material(&[0u8; 32])?;
    apply_update(conn, &keys, actor, &req).await.map(|_| ())
}

/// GET /api/v1/settings/auth (admin).
pub async fn get_settings(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<SettingsView>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    Ok(Json(SettingsView::of(&load(&mut c).await?)))
}

/// PUT /api/v1/settings/auth (admin).
pub async fn put_settings(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<SettingsReq>,
) -> Result<Json<SettingsView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let row = apply_update(&mut tx, state.totp(), &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok(Json(SettingsView::of(&row)))
}

#[cfg(test)]
mod tests;
