//! W27 (v0.4 D7): passkeys (WebAuthn, kanidm `webauthn-rs`).
//!
//! - **Relying party** = the main domain (`Rp::current`): RP ID = its host,
//!   the only accepted origin = its origin. Without a main domain that is a
//!   DNS name over https (or `localhost`) passkeys are unavailable: the
//!   public endpoints are the canonical rejection and no policy can refuse a
//!   password.
//! - **Login** is discoverable ("usernameless"): `/auth/passkey/options`
//!   hands out a challenge, the browser picks a passkey, `/auth/passkey/login`
//!   finds it by (RP ID, credential id) and the user handle (= the account
//!   id). No address is sent, so there is no account oracle; every failure
//!   is the uniform 401.
//! - **Ceremony state** (webauthn-rs' registration / authentication state)
//!   lives in Valkey under a 256-bit random key for 5 minutes and is taken
//!   exactly once (GETDEL): any instance can finish what another started.
//! - **Passkey-only**: password login is refused (403
//!   `auth.passkey_required`, only after the right password) when the
//!   account has a *current* passkey (one for today's RP ID) and either the
//!   account chose it (`users.password_login_disabled_at`) or its role's
//!   policy says so (`auth_settings.passkey_only_*`). Without a current
//!   passkey the password works — a domain change or deleting the last
//!   passkey never locks anyone out. Lost passkey: `akari admin
//!   reset-login <email>` (or 用户 → 重置登录方式) deletes the account's
//!   passkeys and re-enables its password, audited.
//! - Every change is audited in its transaction (`user.passkey.add/
//!   rename/delete`, `user.password_login.set`, `user.login_method.reset`);
//!   no key material ever reaches the audit log or the API.

use std::net::SocketAddr;

use axum::Json;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::CookieJar;
use fred::prelude::*;
use rand::RngCore;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;
use webauthn_rs::prelude::{
    DiscoverableAuthentication, DiscoverableKey, Passkey, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Url, Webauthn, WebauthnBuilder,
};

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, ShopUser, bad_request, conflict};
use crate::state::AppState;

/// Ceremony state lifetime (also the browser timeout).
pub const STATE_TTL_SECS: i64 = 300;
/// Passkeys per account (current RP ID).
pub const MAX_PER_USER: i64 = 10;
const NAME_MAX: usize = 64;
/// Login challenges per client address per minute.
const OPTIONS_PER_MINUTE: i64 = 30;
/// Registration ceremonies per account per hour.
const REGISTER_PER_HOUR: i64 = 20;

// ---------------------------------------------------------------------------
// Relying party
// ---------------------------------------------------------------------------

/// The relying party passkeys are bound to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rp {
    /// The main domain's host (lower case, no port).
    pub id: String,
    pub origin: Url,
    pub name: String,
}

impl Rp {
    /// From the effective settings; None = passkeys unavailable.
    pub fn current(state: &AppState) -> Option<Rp> {
        let eff = state.settings().get();
        let main = eff.main.as_ref()?;
        let name = eff
            .stored
            .site_name
            .clone()
            .unwrap_or_else(|| "Akari".into());
        Self::of(&main.as_string(), name)
    }

    /// Pure: the RP for a main-domain origin (`https://host[:port]`).
    pub fn of(origin: &str, name: String) -> Option<Rp> {
        let origin = Url::parse(origin).ok()?;
        let host = origin.host_str()?.to_ascii_lowercase();
        // An RP ID is a registrable domain name: never an IP literal.
        if host.parse::<std::net::IpAddr>().is_ok()
            || host.starts_with('[')
            || !host.contains('.') && host != "localhost"
        {
            return None;
        }
        // WebAuthn needs a secure context (https, or http on localhost).
        if origin.scheme() != "https" && host != "localhost" {
            return None;
        }
        Some(Rp {
            id: host,
            origin,
            name,
        })
    }

    fn webauthn(&self) -> Result<Webauthn, ApiError> {
        WebauthnBuilder::new(&self.id, &self.origin)
            .and_then(|b| {
                b.rp_name(&self.name)
                    .timeout(std::time::Duration::from_secs(STATE_TTL_SECS as u64))
                    .build()
            })
            .map_err(|e| {
                tracing::error!(error = %e, "passkey relying party not usable");
                ApiError::internal()
            })
    }
}

fn unavailable() -> ApiError {
    conflict!(
        "account.passkey_unavailable",
        "passkeys need the main domain (a DNS name over https)"
    )
}

// ---------------------------------------------------------------------------
// Ceremony state (Valkey, single use)
// ---------------------------------------------------------------------------

fn state_key(kind: &str, token: &str) -> String {
    format!("akari:passkey:{kind}:{token}")
}

async fn put_state<T: Serialize>(state: &AppState, kind: &str, v: &T) -> Result<String, ApiError> {
    let mut b = [0u8; 32];
    rand::rng().fill_bytes(&mut b);
    let token = hex::encode(b);
    let body = serde_json::to_string(v)?;
    let r: Result<(), _> = state
        .valkey()
        .set(
            state_key(kind, &token),
            body,
            Some(Expiration::EX(STATE_TTL_SECS)),
            None,
            false,
        )
        .await;
    r.map_err(|e| {
        tracing::error!(error = %e, "passkey state not stored");
        ApiError::internal()
    })?;
    Ok(token)
}

/// Take (and delete) a stored ceremony state. None = unknown/expired/used.
async fn take_state<T: DeserializeOwned>(
    state: &AppState,
    kind: &str,
    token: &str,
) -> Result<Option<T>, ApiError> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let r: Result<Option<String>, _> = state.valkey().getdel(state_key(kind, token)).await;
    let raw = r.map_err(|e| {
        tracing::error!(error = %e, "passkey state unavailable");
        ApiError::internal()
    })?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/// What a password login of an account may do (`api::login`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoginPolicy {
    /// Passkey-only: the right password is still refused.
    pub password_refused: bool,
    /// Offer binding a passkey (the account has none, the policy asks).
    pub prompt: bool,
}

/// Pure: the policy for an account (`has_current` = it has a passkey for
/// today's RP ID; `available` = passkeys work at all).
pub fn decide(
    s: &crate::botguard::Settings,
    role: &str,
    self_disabled: bool,
    has_current: bool,
    available: bool,
) -> LoginPolicy {
    if !available {
        return LoginPolicy {
            password_refused: false,
            prompt: false,
        };
    }
    let role_only = match role {
        "admin" => s.passkey_only_admins,
        _ => s.passkey_only_users,
    };
    LoginPolicy {
        password_refused: has_current && (self_disabled || role_only),
        prompt: !has_current && s.passkey_prompt,
    }
}

pub async fn login_policy(
    state: &AppState,
    user: Uuid,
    role: &str,
) -> Result<LoginPolicy, ApiError> {
    let Some(rp) = Rp::current(state) else {
        return Ok(decide(&settings_placeholder(), role, false, false, false));
    };
    let mut c = state.pg().acquire().await?;
    let s = crate::botguard::load(&mut c).await?;
    let (self_disabled, has_current): (bool, bool) = sqlx::query_as(
        "SELECT u.password_login_disabled_at IS NOT NULL, \
         EXISTS (SELECT 1 FROM webauthn_credentials w WHERE w.user_id = u.id AND w.rp_id = $2) \
         FROM users u WHERE u.id = $1",
    )
    .bind(user)
    .bind(&rp.id)
    .fetch_one(&mut *c)
    .await?;
    Ok(decide(&s, role, self_disabled, has_current, true))
}

/// Settings whose policies are all off (passkeys unavailable).
fn settings_placeholder() -> crate::botguard::Settings {
    crate::botguard::Settings {
        version: 0,
        turnstile_site_key: None,
        turnstile_secret_enc: None,
        turnstile_login: false,
        turnstile_register: false,
        turnstile_reset: false,
        honeypot: false,
        min_submit_secs: 0,
        passkey_only_admins: false,
        passkey_only_users: false,
        passkey_prompt: false,
    }
}

/// Risk notes for 系统设置 → 登录 (the ruling: an admin needs no second
/// passkey, but is warned).
pub async fn policy_warnings(
    state: &AppState,
    conn: &mut PgConnection,
    s: &crate::botguard::Settings,
) -> Result<Vec<String>, ApiError> {
    let any = s.passkey_only_admins || s.passkey_only_users || s.passkey_prompt;
    if !any {
        return Ok(Vec::new());
    }
    let Some(rp) = Rp::current(state) else {
        return Ok(vec![
            "通行密钥需要主域名（https 域名）：在设置主域名之前这些策略不生效，所有账户继续用密码登录"
                .into(),
        ]);
    };
    let mut w = Vec::new();
    if s.passkey_only_admins {
        let (none, one): (i64, i64) = sqlx::query_as(
            "SELECT count(*) FILTER (WHERE n = 0), count(*) FILTER (WHERE n = 1) FROM ( \
               SELECT (SELECT count(*) FROM webauthn_credentials w \
                       WHERE w.user_id = u.id AND w.rp_id = $1) AS n \
               FROM users u WHERE u.role = 'admin' AND u.enabled) t",
        )
        .bind(&rp.id)
        .fetch_one(&mut *conn)
        .await?;
        if one > 0 {
            w.push(format!(
                "{one} 个管理员只有一个通行密钥：丢失后只能在服务器上运行 `akari admin reset-login <邮箱>` 恢复（建议每人绑定两个）"
            ));
        }
        if none > 0 {
            w.push(format!(
                "{none} 个管理员还没有通行密钥：绑定之前他们仍用密码登录"
            ));
        }
    }
    Ok(w)
}

// ---------------------------------------------------------------------------
// Login (public)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct LoginState {
    rp_id: String,
    auth: DiscoverableAuthentication,
}

/// POST /{prefix}/auth/passkey/options: a discoverable-login challenge.
pub async fn login_options(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let Some(rp) = Rp::current(&state) else {
        return Ok(crate::reject::not_found());
    };
    let client = state.client_ip(peer.ip(), &headers);
    let key = format!("akari:rl:passkey:{}", crate::client_ip::bucket(client));
    if !crate::rate::hit(&state, key, OPTIONS_PER_MINUTE, 60)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "passkey rate limit unavailable");
            ApiError::internal()
        })?
    {
        return Err(ApiError::too_many());
    }
    let (rcr, auth) = rp
        .webauthn()?
        .start_discoverable_authentication()
        .map_err(|e| {
            tracing::error!(error = %e, "passkey challenge");
            ApiError::internal()
        })?;
    let token = put_state(
        &state,
        "login",
        &LoginState {
            rp_id: rp.id.clone(),
            auth,
        },
    )
    .await?;
    let mut options = serde_json::to_value(&rcr)?;
    // The page decides how to ask (a button: modal; autofill: conditional).
    if let Some(o) = options.as_object_mut() {
        o.remove("mediation");
    }
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(json!({ "state": token, "options": options })),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginReq {
    pub state: String,
    pub credential: PublicKeyCredential,
}

#[derive(sqlx::FromRow)]
struct CredRow {
    id: Uuid,
    passkey: sqlx::types::Json<Passkey>,
}

/// POST /{prefix}/auth/passkey/login {state, credential}: session cookie +
/// the password login's answer. Every failure: the uniform 401.
pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    body: axum::body::Body,
) -> Result<Response, ApiError> {
    // Unavailable: the canonical rejection before the body is read.
    let Some(rp) = Rp::current(&state) else {
        return Ok(crate::reject::not_found());
    };
    let req: LoginReq = crate::signup::read_json(body).await?;
    let client = state.client_ip(peer.ip(), &headers);
    let Some(st) = take_state::<LoginState>(&state, "login", &req.state).await? else {
        return Err(ApiError::unauthorized());
    };
    // A challenge issued for another main domain is void.
    if st.rp_id != rp.id {
        return Err(ApiError::unauthorized());
    }
    let wa = rp.webauthn()?;
    let Ok((user_id, cred_id)) = wa.identify_discoverable_authentication(&req.credential) else {
        return Err(ApiError::unauthorized());
    };
    let mut tx = state.pg().begin().await?;
    let cred: Option<CredRow> = sqlx::query_as(
        "SELECT id, passkey FROM webauthn_credentials \
         WHERE rp_id = $1 AND cred_id = $2 AND user_id = $3 FOR UPDATE",
    )
    .bind(&rp.id)
    .bind(cred_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(mut cred) = cred else {
        return Err(ApiError::unauthorized());
    };
    let row: Option<crate::api::LoginRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM users u WHERE u.id = $1",
        crate::api::login_row_cols()
    )))
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row.filter(crate::api::may_sign_in) else {
        return Err(ApiError::unauthorized());
    };
    let key = DiscoverableKey::from(&cred.passkey.0);
    let Ok(result) = wa.finish_discoverable_authentication(&req.credential, st.auth, &[key]) else {
        return Err(ApiError::unauthorized());
    };
    // Counter / backup state: stored when they moved (a cloned
    // authenticator's stale counter is refused by webauthn-rs above).
    cred.passkey.0.update_credential(&result);
    sqlx::query("UPDATE webauthn_credentials SET passkey = $2, last_used_at = now() WHERE id = $1")
        .bind(cred.id)
        .bind(&cred.passkey)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::api::finish_login(&state, &row, client, "passkey").await?;
    crate::api::login_response(&state, jar, &row, false)
}

// ---------------------------------------------------------------------------
// The account's passkeys (/me)
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct PasskeyView {
    pub id: Uuid,
    pub name: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_used_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Bound to today's main domain (a browser offers it here).
    pub current: bool,
}

async fn list_for(
    conn: &mut PgConnection,
    user: Uuid,
    rp: Option<&Rp>,
) -> sqlx::Result<Vec<PasskeyView>> {
    sqlx::query_as(
        "SELECT id, name, created_at, last_used_at, rp_id = $2 AS current \
         FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at, id",
    )
    .bind(user)
    .bind(rp.map(|r| r.id.as_str()).unwrap_or(""))
    .fetch_all(conn)
    .await
}

/// The account's login methods (the account page; admins see the same per
/// user).
async fn methods_view(state: &AppState, user: Uuid) -> Result<Value, ApiError> {
    let rp = Rp::current(state);
    let mut c = state.pg().acquire().await?;
    let (role, self_disabled, has_password): (String, bool, bool) = sqlx::query_as(
        "SELECT role, password_login_disabled_at IS NOT NULL, password_hash IS NOT NULL \
         FROM users WHERE id = $1",
    )
    .bind(user)
    .fetch_one(&mut *c)
    .await?;
    let passkeys = list_for(&mut c, user, rp.as_ref()).await?;
    let s = crate::botguard::load(&mut c).await?;
    let has_current = passkeys.iter().any(|p| p.current);
    let policy = decide(&s, &role, self_disabled, has_current, rp.is_some());
    Ok(json!({
        "available": rp.is_some(),
        "rp_id": rp.map(|r| r.id),
        "passkeys": passkeys,
        "password_set": has_password,
        "password_login_disabled": self_disabled,
        "password_login": has_password && !policy.password_refused,
        "max": MAX_PER_USER,
    }))
}

/// GET /api/v1/me/passkeys
pub async fn my_passkeys(
    State(state): State<AppState>,
    user: ShopUser,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(methods_view(&state, user.user.id).await?))
}

#[derive(Serialize, Deserialize)]
struct RegState {
    user: Uuid,
    rp_id: String,
    reg: PasskeyRegistration,
}

/// POST /api/v1/me/passkeys/options: a registration challenge.
pub async fn register_options(
    State(state): State<AppState>,
    user: ShopUser,
) -> Result<Response, ApiError> {
    let me = user.user;
    let rp = Rp::current(&state).ok_or_else(unavailable)?;
    if !crate::rate::hit(
        &state,
        format!("akari:rl:passkey-reg:{}", me.id),
        REGISTER_PER_HOUR,
        3600,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "passkey rate limit unavailable");
        ApiError::internal()
    })? {
        return Err(ApiError::too_many());
    }
    let mut c = state.pg().acquire().await?;
    let existing: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT cred_id FROM webauthn_credentials WHERE user_id = $1 AND rp_id = $2",
    )
    .bind(me.id)
    .bind(&rp.id)
    .fetch_all(&mut *c)
    .await?;
    if existing.len() as i64 >= MAX_PER_USER {
        return Err(limit_reached());
    }
    let exclude = existing.into_iter().map(Into::into).collect::<Vec<_>>();
    let (ccr, reg) = rp
        .webauthn()?
        .start_passkey_registration(me.id, &me.email, &me.email, Some(exclude))
        .map_err(|e| {
            tracing::error!(error = %e, "passkey registration challenge");
            ApiError::internal()
        })?;
    let token = put_state(
        &state,
        "register",
        &RegState {
            user: me.id,
            rp_id: rp.id.clone(),
            reg,
        },
    )
    .await?;
    let mut options = serde_json::to_value(&ccr)?;
    // Passkeys are discoverable (the login sends no address).
    if let Some(sel) = options
        .pointer_mut("/publicKey/authenticatorSelection")
        .and_then(Value::as_object_mut)
    {
        sel.insert("residentKey".into(), json!("required"));
        sel.insert("requireResidentKey".into(), json!(true));
    }
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(json!({ "state": token, "options": options })),
    )
        .into_response())
}

fn limit_reached() -> ApiError {
    conflict!(
        "account.passkey_limit",
        "at most {max} passkeys per account",
        max = MAX_PER_USER
    )
}

fn invalid_name() -> ApiError {
    bad_request!(
        "account.passkey_name_invalid",
        "the name must be 1-{max} characters without control characters",
        max = NAME_MAX
    )
}

fn clean_name(raw: &str) -> Result<String, ApiError> {
    let n = raw.trim();
    if n.is_empty() || n.chars().count() > NAME_MAX || n.chars().any(char::is_control) {
        return Err(invalid_name());
    }
    Ok(n.to_string())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterReq {
    pub state: String,
    pub credential: RegisterPublicKeyCredential,
    pub name: String,
    /// From the login prompt: password login off once this passkey is
    /// stored.
    #[serde(default)]
    pub disable_password: bool,
}

/// POST /api/v1/me/passkeys {state, credential, name, disable_password?}
pub async fn register(
    State(state): State<AppState>,
    user: ShopUser,
    ApiJson(req): ApiJson<RegisterReq>,
) -> Result<(axum::http::StatusCode, Json<Value>), ApiError> {
    let me = user.user;
    let name = clean_name(&req.name)?;
    let rp = Rp::current(&state).ok_or_else(unavailable)?;
    let failed = || {
        bad_request!(
            "account.passkey_failed",
            "the passkey could not be verified; try again"
        )
    };
    let st = take_state::<RegState>(&state, "register", &req.state)
        .await?
        .filter(|s| s.user == me.id && s.rp_id == rp.id)
        .ok_or_else(failed)?;
    let passkey = rp
        .webauthn()?
        .finish_passkey_registration(&req.credential, &st.reg)
        .map_err(|e| {
            tracing::info!(error = %e, "passkey registration refused");
            failed()
        })?;
    let mut tx = state.pg().begin().await?;
    let id = apply_add(
        &mut tx,
        &Actor::of(&me),
        me.id,
        &rp,
        &passkey,
        &name,
        req.disable_password,
    )
    .await?;
    tx.commit().await?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "id": id, "name": name })),
    ))
}

/// Store a verified passkey (+ optionally switch the password login off),
/// audited `user.passkey.add`. Locks the account row (the per-account
/// limit holds under concurrency).
pub async fn apply_add(
    conn: &mut PgConnection,
    actor: &Actor,
    user: Uuid,
    rp: &Rp,
    passkey: &Passkey,
    name: &str,
    disable_password: bool,
) -> Result<Uuid, ApiError> {
    sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(user)
        .execute(&mut *conn)
        .await?;
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM webauthn_credentials WHERE user_id = $1 AND rp_id = $2",
    )
    .bind(user)
    .bind(&rp.id)
    .fetch_one(&mut *conn)
    .await?;
    if n >= MAX_PER_USER {
        return Err(limit_reached());
    }
    let cred_id: &[u8] = passkey.cred_id().as_ref();
    let id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO webauthn_credentials (user_id, rp_id, cred_id, passkey, name) \
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (rp_id, cred_id) DO NOTHING RETURNING id",
    )
    .bind(user)
    .bind(&rp.id)
    .bind(cred_id)
    .bind(sqlx::types::Json(passkey))
    .bind(name)
    .fetch_optional(&mut *conn)
    .await?;
    let id = id.ok_or_else(|| {
        conflict!(
            "account.passkey_exists",
            "this passkey is already registered"
        )
    })?;
    if disable_password {
        sqlx::query(
            "UPDATE users SET password_login_disabled_at = now() \
             WHERE id = $1 AND password_login_disabled_at IS NULL",
        )
        .bind(user)
        .execute(&mut *conn)
        .await?;
    }
    crate::audit::record(
        conn,
        actor,
        "user.passkey.add",
        "user",
        Some(user.to_string()),
        None,
        Some(json!({
            "passkey": id, "name": name, "rp_id": rp.id,
            "password_login_disabled": disable_password,
        })),
    )
    .await?;
    Ok(id)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameReq {
    pub name: String,
}

/// PATCH /api/v1/me/passkeys/{id} {name}
pub async fn rename(
    State(state): State<AppState>,
    user: ShopUser,
    Path((_, id)): Path<(String, String)>,
    ApiJson(req): ApiJson<RenameReq>,
) -> Result<Response, ApiError> {
    let me = user.user;
    let Ok(id) = Uuid::parse_str(&id) else {
        return Ok(crate::reject::not_found());
    };
    let name = clean_name(&req.name)?;
    let mut tx = state.pg().begin().await?;
    let old: Option<String> = sqlx::query_scalar(
        "UPDATE webauthn_credentials w SET name = $3 FROM webauthn_credentials o \
         WHERE w.id = $1 AND w.user_id = $2 AND o.id = w.id RETURNING o.name",
    )
    .bind(id)
    .bind(me.id)
    .bind(&name)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(old) = old else {
        return Ok(crate::reject::not_found());
    };
    crate::audit::record(
        &mut tx,
        &Actor::of(&me),
        "user.passkey.rename",
        "user",
        Some(me.id.to_string()),
        Some(json!({ "passkey": id, "name": old })),
        Some(json!({ "passkey": id, "name": name })),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "name": name })).into_response())
}

/// DELETE /api/v1/me/passkeys/{id}. Deleting the last current passkey
/// makes the password work again (the rule needs a current passkey).
pub async fn delete(
    State(state): State<AppState>,
    user: ShopUser,
    Path((_, id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let me = user.user;
    let Ok(id) = Uuid::parse_str(&id) else {
        return Ok(crate::reject::not_found());
    };
    let mut tx = state.pg().begin().await?;
    let gone: Option<String> = sqlx::query_scalar(
        "DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 RETURNING name",
    )
    .bind(id)
    .bind(me.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(name) = gone else {
        return Ok(crate::reject::not_found());
    };
    crate::audit::record(
        &mut tx,
        &Actor::of(&me),
        "user.passkey.delete",
        "user",
        Some(me.id.to_string()),
        Some(json!({ "passkey": id, "name": name })),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasswordLoginReq {
    pub enabled: bool,
}

/// PUT /api/v1/me/password-login {enabled}: the account's own
/// "passkey only". Switching the password off needs a current passkey.
pub async fn set_password_login(
    State(state): State<AppState>,
    user: ShopUser,
    ApiJson(req): ApiJson<PasswordLoginReq>,
) -> Result<Json<Value>, ApiError> {
    let me = user.user;
    let rp = Rp::current(&state);
    let mut tx = state.pg().begin().await?;
    sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(me.id)
        .execute(&mut *tx)
        .await?;
    if !req.enabled {
        let has_current: bool = match &rp {
            Some(rp) => {
                sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM webauthn_credentials \
                     WHERE user_id = $1 AND rp_id = $2)",
                )
                .bind(me.id)
                .bind(&rp.id)
                .fetch_one(&mut *tx)
                .await?
            }
            None => false,
        };
        if !has_current {
            return Err(conflict!(
                "account.passkey_required",
                "add a passkey before switching the password login off"
            ));
        }
    }
    let changed: bool = sqlx::query_scalar(
        "WITH o AS (SELECT password_login_disabled_at IS NULL AS was FROM users WHERE id = $1) \
         UPDATE users SET password_login_disabled_at = CASE WHEN $2 THEN NULL \
           ELSE COALESCE(password_login_disabled_at, now()) END \
         WHERE id = $1 RETURNING (SELECT was FROM o) <> $2",
    )
    .bind(me.id)
    .bind(req.enabled)
    .fetch_one(&mut *tx)
    .await?;
    if changed {
        crate::audit::record(
            &mut tx,
            &Actor::of(&me),
            "user.password_login.set",
            "user",
            Some(me.id.to_string()),
            Some(json!({ "password_login": !req.enabled })),
            Some(json!({ "password_login": req.enabled })),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(methods_view(&state, me.id).await?))
}

// ---------------------------------------------------------------------------
// Admin + CLI: reset the login method
// ---------------------------------------------------------------------------

/// Delete every passkey of the account and switch its password login back
/// on (a lost passkey), audited `user.login_method.reset`. Returns the
/// number of passkeys deleted; None = no such account.
pub async fn apply_reset_login(
    conn: &mut PgConnection,
    actor: &Actor,
    user: Uuid,
) -> Result<Option<i64>, ApiError> {
    let was: Option<bool> = sqlx::query_scalar(
        "SELECT password_login_disabled_at IS NOT NULL FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(user)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(was_disabled) = was else {
        return Ok(None);
    };
    let n = sqlx::query("DELETE FROM webauthn_credentials WHERE user_id = $1")
        .bind(user)
        .execute(&mut *conn)
        .await?
        .rows_affected() as i64;
    sqlx::query("UPDATE users SET password_login_disabled_at = NULL WHERE id = $1")
        .bind(user)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "user.login_method.reset",
        "user",
        Some(user.to_string()),
        Some(json!({ "passkeys": n, "password_login_disabled": was_disabled })),
        Some(json!({ "passkeys": 0, "password_login_disabled": false })),
    )
    .await?;
    Ok(Some(n))
}

/// GET /api/v1/users/{id}/passkeys (admin): the account's login methods.
pub async fn admin_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    user.require_admin()?;
    let Ok(id) = Uuid::parse_str(&id) else {
        return Ok(crate::reject::not_found());
    };
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
        .bind(id)
        .fetch_one(state.pg())
        .await?;
    if !exists {
        return Ok(crate::reject::not_found());
    }
    Ok(Json(methods_view(&state, id).await?).into_response())
}

/// POST /api/v1/users/{id}/login-method/reset (admin).
pub async fn admin_reset(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    user.require_admin()?;
    let Ok(id) = Uuid::parse_str(&id) else {
        return Ok(crate::reject::not_found());
    };
    let mut tx = state.pg().begin().await?;
    let Some(n) = apply_reset_login(&mut tx, &Actor::of(&user), id).await? else {
        return Ok(crate::reject::not_found());
    };
    tx.commit().await?;
    Ok(Json(json!({ "deleted_passkeys": n })).into_response())
}

/// `akari admin reset-login <email>` (actor cli).
pub async fn cli_reset_login(pg: &sqlx::PgPool, email: &str) -> anyhow::Result<i64> {
    let email = email.trim().to_lowercase();
    let mut tx = pg.begin().await?;
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(id) = id else {
        anyhow::bail!("no account with the address {email}");
    };
    let n = apply_reset_login(&mut tx, &Actor::cli(), id)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message()))?
        .unwrap_or(0);
    tx.commit().await?;
    Ok(n)
}

/// Whether passkeys work (for `/auth/options`).
pub fn public_view(state: &AppState) -> Value {
    json!(Rp::current(state).is_some())
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, patch, post, put};
    axum::Router::new()
        .route("/{prefix}/auth/passkey/options", post(login_options))
        .route("/{prefix}/auth/passkey/login", post(login))
        .route(
            "/{prefix}/api/v1/me/passkeys",
            get(my_passkeys).post(register),
        )
        .route(
            "/{prefix}/api/v1/me/passkeys/options",
            post(register_options),
        )
        .route(
            "/{prefix}/api/v1/me/passkeys/{id}",
            patch(rename).delete(delete),
        )
        .route(
            "/{prefix}/api/v1/me/password-login",
            put(set_password_login),
        )
        .route("/{prefix}/api/v1/users/{id}/passkeys", get(admin_list))
        .route(
            "/{prefix}/api/v1/users/{id}/login-method/reset",
            post(admin_reset),
        )
}

#[cfg(test)]
mod tests;
