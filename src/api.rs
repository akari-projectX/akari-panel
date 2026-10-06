use crate::auth::{api_error, bad_request, conflict};
use std::collections::HashMap;
use std::net::SocketAddr;

use axum::Json;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::cookie::CookieJar;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::audit::Actor;
use crate::auth::{self, ApiError, AuthUser, COOKIE_NAME, PortalUser};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginReq {
    /// D1: the account's email address (any case; stored lower-case).
    pub email: String,
    pub password: String,
    /// v0.4: honeypot / form token / Turnstile (`botguard`).
    #[serde(default)]
    pub guard: Option<crate::botguard::Guard>,
}

/// POST /auth/login {email, password}. Failed attempts are rate limited per
/// client address (behind trusted proxies: the X-Forwarded-For client, see
/// client_ip.rs) and per address (login_limit.rs). Every credential failure
/// — unknown account, wrong password, disabled account — is the same 401
/// after the same work (one query, one argon2), so the response says
/// nothing about which part was wrong or whether the account exists.
///
/// D1: everyone (admins too) logs in with the email address, verified or
/// not (with "registration requires email verification" off, the address a
/// user registered with is still their login; only a verified address gets
/// mail). D7: no second factor (TOTP was removed; passkeys replace it).
///
/// The body goes through `ApiJson` like every other endpoint: malformed
/// JSON, a wrong type or an unknown field is a 400 with the parser's
/// message (it carries no credential information).
pub async fn login(
    State(state): State<AppState>,
    entry: crate::access::Entry,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    ApiJson(req): ApiJson<LoginReq>,
) -> Result<Response, ApiError> {
    if req.email.is_empty() || req.password.is_empty() {
        return Err(bad_request!(
            "auth.credentials_required",
            "email and password are required"
        ));
    }
    let client = state.client_ip(addr.ip(), &headers);
    // Addresses are case-insensitive: one rate-limit bucket per address.
    let email = req.email.trim().to_lowercase();
    let attempt =
        crate::login_limit::Attempt::reserve(&state, &crate::client_ip::bucket(client), &email)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "login rate limit unavailable");
                ApiError::internal()
            })?
            .ok_or_else(ApiError::too_many)?;

    // v0.4 bot protection: a trapped attempt is answered exactly like a
    // wrong password (same work: one argon2), and counts like one; a
    // Turnstile refusal is its own error (the reservation is released).
    match crate::botguard::check_form(
        &state,
        crate::botguard::Form::Login,
        req.guard.as_ref(),
        client,
    )
    .await
    {
        Ok(crate::botguard::Verdict::Pass) => {}
        Ok(crate::botguard::Verdict::Trap) => {
            auth::scrub_password_async(&req.password).await;
            attempt.fail();
            return Err(ApiError::unauthorized());
        }
        Err(e) => {
            attempt.release(&state).await;
            return Err(e);
        }
    }
    match check_credentials(&state, &email, &req.password).await {
        Ok(Checked::Ok(row)) => {
            // The password was right: whatever follows is not a credential
            // failure.
            attempt.release(&state).await;
            // D4: admins sign in under the admin prefix; on the portal the
            // answer is the wrong password's.
            if entry.refuses(&row.role) {
                return Err(ApiError::unauthorized());
            }
            // W27: an account with a passkey may be passkey-only (its own
            // choice or the role's policy); only the holder of the
            // password learns that.
            let policy = crate::passkey::login_policy(&state, row.id, &row.role).await?;
            if policy.password_refused {
                return Err(api_error!(
                    FORBIDDEN,
                    "auth.passkey_required",
                    "this account signs in with a passkey"
                ));
            }
            finish_login(&state, &row, client, "password").await?;
            login_response(&state, jar, &row, policy.prompt)
        }
        Ok(Checked::Failed(account)) => {
            let n = attempt.name_count;
            attempt.fail();
            if let Some(id) = account
                && (n == 1 || n == crate::login_limit::PER_LOGIN)
            {
                audit_login_failure(&state, id, client, n);
            }
            Err(ApiError::unauthorized())
        }
        Err(e) => {
            // Not a credential failure (e.g. the database is down).
            attempt.release(&state).await;
            Err(e)
        }
    }
}

#[derive(sqlx::FromRow)]
pub(crate) struct LoginRow {
    pub id: Uuid,
    pub email: String,
    pub role: String,
    pub enabled: bool,
    pub expired: bool,
    /// role=user disabled for quota: may log in to renew (R21).
    pub quota_disabled: bool,
    /// role=user banned by an admin: may log in to the portal scope only
    /// (the ban reason and tickets, W28-c).
    pub banned: bool,
    pub password_hash: Option<String>,
    pub session_ver: i64,
}

/// The columns of `LoginRow` (alias `u`).
pub(crate) fn login_row_cols() -> String {
    format!(
        "u.id, u.email, u.role, u.enabled, u.password_hash, u.session_ver, {} AS expired, \
         (u.role = 'user' AND NOT u.enabled AND u.disabled_reason = 'quota') AS quota_disabled, \
         (u.role = 'user' AND NOT u.enabled AND u.disabled_reason = 'admin' \
          AND u.erased_at IS NULL) AS banned",
        crate::enforce::EXPIRED
    )
}

/// Whether the account may sign in at all (R21: an expired or
/// quota-disabled role=user account still may — its sessions only reach the
/// renewal scope; a banned one (W28-c) signs in to the portal scope;
/// disabled admins may not).
pub(crate) fn may_sign_in(r: &LoginRow) -> bool {
    r.enabled || r.quota_disabled || r.banned
}

/// The session cookie + the login answer (password and passkey logins).
pub(crate) fn login_response(
    state: &AppState,
    jar: CookieJar,
    row: &LoginRow,
    passkey_prompt: bool,
) -> Result<Response, ApiError> {
    let token = auth::issue_token(state, row.id, &row.role, row.session_ver)?;
    Ok((
        jar.add(auth::session_cookie(state, token)),
        Json(json!({
            "id": row.id, "email": row.email, "role": row.role,
            "expired": row.expired, "quota_exhausted": row.quota_disabled,
            "banned": row.banned, "passkey_prompt": passkey_prompt,
        })),
    )
        .into_response())
}

enum Checked {
    Ok(LoginRow),
    /// The existing account the attempt named, if any (for the audit log
    /// only).
    Failed(Option<Uuid>),
}

/// Verify the password with the same work for every kind of failure.
/// `email` is already lower-cased (addresses are stored lower-case).
async fn check_credentials(
    state: &AppState,
    email: &str,
    password: &str,
) -> Result<Checked, ApiError> {
    // Expiry applies to role=user only (an admin must never lock themselves
    // out by a date).
    let row = sqlx::query_as::<_, LoginRow>(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM users u WHERE u.email = $1",
        login_row_cols()
    )))
    .bind(email)
    .fetch_optional(state.pg())
    .await?;
    let account = row.as_ref().map(|r| r.id);

    // R21: an expired or quota-disabled (role=user) account still logs in —
    // its sessions only reach the renewal scope (`auth::ShopUser`); a
    // banned role=user account logs in to the portal scope
    // (`auth::PortalUser`: ban reason and tickets, W28-c). Disabled admins
    // do not log in at all.
    let Some(row) = row.filter(|r| may_sign_in(r) && r.password_hash.is_some()) else {
        auth::scrub_password_async(password).await;
        return Ok(Checked::Failed(account));
    };
    if !auth::verify_password_async(password, row.password_hash.as_deref().unwrap_or_default())
        .await
    {
        return Ok(Checked::Failed(account));
    }
    Ok(Checked::Ok(row))
}

/// Seconds between recorded successful logins of one regular user (admins:
/// every login).
const LOGIN_OK_THROTTLE_SECS: i64 = 600;

/// Record a successful login (audit row; regular users throttled).
/// `method`: "password" | "passkey".
pub(crate) async fn finish_login(
    state: &AppState,
    row: &LoginRow,
    ip: std::net::IpAddr,
    method: &str,
) -> Result<(), ApiError> {
    // D10: a sign-in is activity, and keeps an account the cleanup warned.
    sqlx::query("UPDATE users SET last_login_at = now(), cleanup_warned_at = NULL WHERE id = $1")
        .bind(row.id)
        .execute(state.pg())
        .await?;
    if row.role == "admin" || login_ok_due(state, row.id).await {
        let mut c = state.pg().acquire().await?;
        crate::audit::record(
            &mut c,
            &Actor::account(row.id, Some(ip)),
            "auth.login",
            "user",
            Some(row.id.to_string()),
            None,
            Some(json!({ "method": method })),
        )
        .await?;
    }
    Ok(())
}

/// Throttle for regular users' login audit rows (one per account per
/// LOGIN_OK_THROTTLE_SECS); records when Valkey cannot say.
async fn login_ok_due(state: &AppState, user: Uuid) -> bool {
    use fred::prelude::*;
    let r: Result<Option<String>, _> = state
        .valkey()
        .set(
            format!("akari:audit:login_ok:{user}"),
            "1",
            Some(Expiration::EX(LOGIN_OK_THROTTLE_SECS)),
            Some(SetOptions::NX),
            false,
        )
        .await;
    match r {
        Ok(v) => v.is_some(),
        Err(e) => {
            tracing::warn!(error = %e, "login audit throttle unavailable");
            true
        }
    }
}

/// Record a failed login of an existing account, off the request path (its
/// cost must not tell an attacker that the account exists).
fn audit_login_failure(state: &AppState, id: Uuid, ip: std::net::IpAddr, failures_in_window: i64) {
    let state = state.clone();
    tokio::spawn(async move {
        let r = async {
            let mut c = state.pg().acquire().await?;
            crate::audit::record(
                &mut c,
                &Actor::anonymous(Some(ip)),
                "auth.login_failed",
                "user",
                Some(id.to_string()),
                None,
                Some(json!({
                    "reason": "credentials",
                    "failures_in_window": failures_in_window,
                    "window_limit": crate::login_limit::PER_LOGIN,
                })),
            )
            .await
        };
        if let Err(e) = r.await {
            tracing::warn!(error = %e, "login failure audit failed");
        }
    });
}

/// POST /auth/logout. Always clears the cookie; a live session also bumps
/// the account's session_ver, which ends every session of the account (a
/// copied cookie dies with the logout).
pub async fn logout(State(state): State<AppState>, jar: CookieJar) -> Response {
    let cleared = jar.clone().add(auth::cleared_cookie(&state));
    let claims = jar
        .get(COOKIE_NAME)
        .and_then(|c| auth::decode_token(&state, c.value()));
    if let Some(c) = claims {
        // Only a token that is still live may end the sessions (a stale
        // token is dead already).
        if let Err(e) = sqlx::query(
            "UPDATE users SET session_ver = session_ver + 1 WHERE id = $1 AND session_ver = $2",
        )
        .bind(c.sub)
        .bind(c.sv)
        .execute(state.pg())
        .await
        {
            // Visible failure (R1): the cookie is cleared, but other
            // copies of it may still be live.
            return (cleared, ApiError::from(e)).into_response();
        }
    }
    (cleared, Json(json!({ "ok": true }))).into_response()
}

/// POST /api/v1/users/{id}/revoke-sessions (admin): log the account out
/// everywhere. Revoking your own sessions ends this one too.
pub async fn revoke_sessions(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    crate::owner::guard_target(&mut tx, &Actor::of(&user), id).await?;
    let n = sqlx::query("UPDATE users SET session_ver = session_ver + 1 WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(ApiError::not_found());
    }
    crate::audit::record(
        &mut tx,
        &Actor::of(&user),
        "user.revoke_sessions",
        "user",
        Some(id.to_string()),
        None,
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Self
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct MeRow {
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
    email: String,
    email_verified: bool,
    locale: String,
    disabled_note: Option<String>,
    disabled_at: Option<DateTime<Utc>>,
    is_owner: bool,
}

#[derive(Serialize)]
pub struct MeView {
    id: Uuid,
    role: String,
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
    /// R21: past expiry (role=user): the session has the renewal scope only.
    expired: bool,
    /// R21: disabled for exceeding the traffic limit: renewal scope only.
    quota_exhausted: bool,
    /// W28-c: banned by an admin: the portal shows `ban_reason` (written
    /// for the user) and tickets; everything else answers 403
    /// `account.banned`.
    banned: bool,
    ban_reason: Option<String>,
    banned_at: Option<DateTime<Utc>>,
    /// D1: the account's address (its login name) and whether it is
    /// verified (only a verified address gets mail and resets the password).
    email: String,
    email_verified: bool,
    /// W15: language of the account's mails.
    locale: String,
    /// W20 (B1): the subscription token and URL (D11: root-relative
    /// `/<sub_path>/<token>` when no subscription/main domain is
    /// configured: the portal prefixes its own origin). Both null for
    /// admins, for the renewal scope (the subscription refuses those
    /// accounts), and for `sub_legacy`.
    sub_token: Option<String>,
    sub_url: Option<String>,
    /// W20: a link from before 0120 works but cannot be shown (hash only);
    /// resetting it gives a showable one. Never rotated implicitly.
    sub_legacy: bool,
    /// PR ② section 5: the subscription formats that are on (the portal's
    /// format selector) and the one-click import buttons to show.
    sub_formats: Vec<String>,
    sub_import_clients: Vec<String>,
    /// W20 (Minor 1): the effective latency-test interval (系统设置 >
    /// panel.toml), for the portal's node list.
    probe_interval_secs: u64,
    /// R47: the account is the owner (admin accounts only).
    is_owner: bool,
}

/// GET /api/v1/me (portal scope: also for expired and quota-disabled users,
/// R21, and banned ones, W28-c).
///
/// W20: carries the subscription link for role=user accounts in good
/// standing (`sub::ensure_token`: decrypted from `users.sub_token_enc`; an
/// account without any token gets one here, audited `user.sub_token.issue`).
/// The response holds a credential: `Cache-Control: no-store`.
pub async fn me(
    State(state): State<AppState>,
    PortalUser {
        user,
        expired,
        quota_exhausted,
        banned,
    }: PortalUser,
) -> Result<Response, ApiError> {
    let mut tx = state.pg().begin().await?;
    let row = sqlx::query_as::<_, MeRow>(
        "SELECT traffic_used_bytes, traffic_limit_bytes, expires_at, email, \
         email_verified_at IS NOT NULL AS email_verified, locale, disabled_note, disabled_at, \
         is_owner FROM users WHERE id = $1",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    let stored = if user.role == "user" && !expired && !quota_exhausted && !banned {
        crate::sub::ensure_token(&mut tx, state.master_key(), &Actor::of(&user), user.id).await?
    } else {
        None
    };
    tx.commit().await?;
    let (sub_token, sub_legacy) = match stored {
        Some(crate::sub::Stored::Ready(t)) => (Some(t), false),
        Some(crate::sub::Stored::Legacy) => (None, true),
        None => (None, false),
    };
    let settings = state.settings().get();
    let sub_url = sub_token.as_deref().map(|t| state.sub_link(user.id, t));
    let view = MeView {
        id: user.id,
        role: user.role,
        traffic_used_bytes: row.traffic_used_bytes,
        traffic_limit_bytes: row.traffic_limit_bytes,
        expires_at: row.expires_at,
        expired,
        quota_exhausted,
        banned,
        ban_reason: if banned { row.disabled_note } else { None },
        banned_at: if banned { row.disabled_at } else { None },
        email: row.email,
        email_verified: row.email_verified,
        locale: row.locale,
        sub_token,
        sub_url,
        sub_legacy,
        sub_formats: settings.sub_formats.clone(),
        sub_import_clients: settings.sub_import_clients.clone(),
        probe_interval_secs: settings.probe.interval_secs,
        is_owner: row.is_owner,
    };
    Ok(no_store(Json(view)))
}

/// A response that carries a credential (subscription link): never cached.
pub fn no_store(body: impl IntoResponse) -> Response {
    (
        [(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        )],
        body,
    )
        .into_response()
}

/// GET /api/v1/users/{id}/subscription (admin; W20 "复制订阅链接"): the
/// user's subscription token and URL. Reading another account's credential
/// is audited (`user.sub_token.read`, no token material) in the same
/// transaction; an account without any token gets one first (audited
/// `user.sub_token.issue`). `legacy: true` = a pre-0120 link that works but
/// cannot be shown (regenerate to get a showable one). Admin accounts have
/// no subscription (400).
pub async fn user_subscription(
    State(state): State<AppState>,
    admin: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Response, ApiError> {
    admin.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    match role.as_deref() {
        None => return Err(ApiError::not_found()),
        Some("user") => {}
        Some(_) => {
            return Err(bad_request!(
                "user.admin_no_subscription",
                "admin accounts have no subscription"
            ));
        }
    }
    let actor = Actor::of(&admin);
    let stored = crate::sub::ensure_token(&mut tx, state.master_key(), &actor, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let token = match stored {
        crate::sub::Stored::Ready(t) => Some(t),
        crate::sub::Stored::Legacy => None,
    };
    crate::audit::record(
        &mut tx,
        &actor,
        "user.sub_token.read",
        "user",
        Some(id.to_string()),
        None,
        Some(json!({ "legacy": token.is_none() })),
    )
    .await?;
    tx.commit().await?;
    let sub_url = token.as_deref().map(|t| state.sub_link(id, t));
    Ok(no_store(Json(json!({
        "legacy": token.is_none(),
        "sub_token": token,
        "sub_url": sub_url,
    }))))
}

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow, Serialize)]
pub struct UserView {
    id: Uuid,
    role: String,
    enabled: bool,
    traffic_limit_bytes: Option<i64>,
    traffic_used_bytes: i64,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    /// Why the account is disabled: admin (banned) | quota (null = enabled).
    disabled_reason: Option<String>,
    /// M3: the active plan (null = none) and the next traffic reset.
    plan_id: Option<Uuid>,
    plan_name: Option<String>,
    next_reset_at: Option<DateTime<Utc>>,
    /// D1: the account's address (its login name) and whether it is
    /// verified.
    email: String,
    email_verified: bool,
    /// R47: the owner.
    is_owner: bool,
    /// Deleted and kept anonymized (finance records; erase.rs).
    erased: bool,
}

/// UserView columns (alias `users` table as itself).
pub const USER_VIEW_COLS: &str = "id, role, enabled, traffic_limit_bytes, traffic_used_bytes, expires_at, created_at, \
     disabled_reason, \
     (SELECT up.plan_id FROM user_plans up WHERE up.user_id = users.id AND up.status = 'active') \
     AS plan_id, \
     (SELECT p.name FROM user_plans up JOIN plans p ON p.id = up.plan_id \
      WHERE up.user_id = users.id AND up.status = 'active') AS plan_name, \
     (SELECT up.next_reset_at FROM user_plans up \
      WHERE up.user_id = users.id AND up.status = 'active') AS next_reset_at, \
     email, email_verified_at IS NOT NULL AS email_verified, is_owner, \
     erased_at IS NOT NULL AS erased";

/// `GET /users` query (W21, M3): page, search, filters and order.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct UserListQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// Prefix of the email address (case-insensitive), or of the id.
    pub q: Option<String>,
    /// A plan id, or `none` (no active plan).
    pub plan_id: Option<String>,
    /// Derived status (the console's badge): active | expired | quota | banned.
    pub status: Option<String>,
    /// user | admin.
    pub role: Option<String>,
    /// created (default) | -created | email | -traffic | expires.
    pub sort: Option<String>,
    /// D10: `true` = never used (`cleanup::NEVER_USED`).
    pub never_used: Option<bool>,
    /// D10: registered before this site-time-zone day (`YYYY-MM-DD`).
    pub registered_before: Option<String>,
    /// D10: last signed in before this day, or never.
    pub last_login_before: Option<String>,
}

/// One page of users and the number matching the filters.
#[derive(Serialize)]
pub struct UserPage {
    pub users: Vec<UserView>,
    pub total: i64,
}

/// The longest accepted search text.
const MAX_USER_QUERY: usize = 64;

/// SQL predicates (over alias `u`) of the derived statuses; mutually
/// exclusive, in the badge's precedence: erased (an anonymized account,
/// erase.rs) > banned > over quota > expired (users only,
/// `enforce::EXPIRED`) > active.
pub const STATUS_ERASED: &str = "(u.erased_at IS NOT NULL)";
pub const STATUS_BANNED: &str =
    "(NOT u.enabled AND u.disabled_reason = 'admin' AND u.erased_at IS NULL)";
pub const STATUS_QUOTA: &str = "(NOT u.enabled AND u.disabled_reason = 'quota')";
pub const STATUS_EXPIRED: &str =
    "(u.enabled AND u.role = 'user' AND u.expires_at IS NOT NULL AND u.expires_at <= now())";
pub const STATUS_ACTIVE: &str = "(u.enabled AND NOT (u.role = 'user' AND u.expires_at IS NOT NULL \
     AND u.expires_at <= now()))";

/// `s` with LIKE metacharacters escaped (backslash is the default escape).
fn like_prefix(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 1);
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// A `YYYY-MM-DD` day filter (None = absent or blank).
fn day_filter(field: &str, v: Option<&str>) -> Result<Option<chrono::NaiveDate>, ApiError> {
    match v.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) => chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d")
            .ok()
            .filter(|d| (2000..3000).contains(&chrono::Datelike::year(d)))
            .map(Some)
            .ok_or_else(|| {
                bad_request!(
                    "user.date_filter_invalid",
                    "{field} must be a day YYYY-MM-DD",
                    field = field.to_string()
                )
            }),
    }
}

pub(crate) fn push_user_filters(
    qb: &mut sqlx::QueryBuilder<sqlx::Postgres>,
    q: &UserListQuery,
) -> Result<(), ApiError> {
    qb.push(" WHERE true");
    if let Some(text) = q.q.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        if text.chars().count() > MAX_USER_QUERY {
            return Err(bad_request!(
                "user.query_too_long",
                "q is longer than {max} characters",
                max = MAX_USER_QUERY
            ));
        }
        let pat = like_prefix(&text.to_lowercase());
        qb.push(" AND (u.email LIKE ").push_bind(pat.clone());
        // Ids only for a hex-ish prefix (no index on id::text: keep the
        // scan out of the common email search).
        if text.len() >= 4 && text.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            qb.push(" OR u.id::text LIKE ").push_bind(pat);
        }
        qb.push(")");
    }
    match q.plan_id.as_deref() {
        None | Some("") => {}
        Some("none") => {
            qb.push(
                " AND NOT EXISTS (SELECT 1 FROM user_plans up WHERE up.user_id = u.id \
                 AND up.status = 'active')",
            );
        }
        Some(id) => {
            let id = Uuid::parse_str(id).map_err(|_| {
                bad_request!(
                    "user.plan_filter_invalid",
                    "plan_id must be a plan id or none"
                )
            })?;
            qb.push(
                " AND EXISTS (SELECT 1 FROM user_plans up WHERE up.user_id = u.id \
                 AND up.status = 'active' AND up.plan_id = ",
            )
            .push_bind(id)
            .push(")");
        }
    }
    match q.status.as_deref() {
        None | Some("") => {}
        Some("active") => {
            qb.push(" AND ").push(STATUS_ACTIVE);
        }
        Some("expired") => {
            qb.push(" AND ").push(STATUS_EXPIRED);
        }
        Some("quota") => {
            qb.push(" AND ").push(STATUS_QUOTA);
        }
        Some("banned") => {
            qb.push(" AND ").push(STATUS_BANNED);
        }
        Some("erased") => {
            qb.push(" AND ").push(STATUS_ERASED);
        }
        Some(_) => {
            return Err(bad_request!(
                "user.status_filter_invalid",
                "status must be active, expired, quota, banned or erased"
            ));
        }
    }
    if q.never_used == Some(true) {
        qb.push(" AND ").push(crate::cleanup::NEVER_USED);
    }
    if let Some(day) = day_filter("registered_before", q.registered_before.as_deref())? {
        qb.push(" AND u.created_at < (")
            .push_bind(day)
            .push("::date)::timestamp AT TIME ZONE akari_site_tz()");
    }
    if let Some(day) = day_filter("last_login_before", q.last_login_before.as_deref())? {
        qb.push(" AND (u.last_login_at IS NULL OR u.last_login_at < (")
            .push_bind(day)
            .push("::date)::timestamp AT TIME ZONE akari_site_tz())");
    }
    match q.role.as_deref() {
        None | Some("") => {}
        Some(r @ ("user" | "admin")) => {
            qb.push(" AND u.role = ").push_bind(r.to_string());
        }
        Some(_) => {
            return Err(bad_request!(
                "user.role_invalid",
                "role must be 'user' or 'admin'"
            ));
        }
    }
    Ok(())
}

/// ORDER BY of a sort key (every order ends in the id: a total order, so
/// pages neither repeat nor skip rows).
pub(crate) fn user_order(sort: Option<&str>) -> Result<&'static str, ApiError> {
    Ok(match sort.unwrap_or("created") {
        "" | "created" => "u.created_at, u.id",
        "-created" => "u.created_at DESC, u.id DESC",
        "email" => "u.email, u.id",
        "-traffic" => "u.traffic_used_bytes DESC, u.id",
        "expires" => "u.expires_at NULLS LAST, u.id",
        _ => {
            return Err(bad_request!(
                "user.sort_invalid",
                "sort must be created, -created, email, -traffic or expires"
            ));
        }
    })
}

pub async fn list_users(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<UserListQuery>,
) -> Result<Json<UserPage>, ApiError> {
    user.require_admin()?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let order = user_order(q.sort.as_deref())?;
    // Deferred join (M2-2): the offset walks ids only; the view columns
    // (and their subqueries) are computed for the page's rows alone.
    let mut page = sqlx::QueryBuilder::new("SELECT id FROM users u");
    push_user_filters(&mut page, &q)?;
    page.push(format!(" ORDER BY {order} LIMIT "))
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);
    let mut tx = state.pg().begin().await?;
    // One snapshot for the page and the count.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let ids: Vec<Uuid> = page.build_query_scalar().fetch_all(&mut *tx).await?;
    let mut users = sqlx::query_as::<_, UserView>(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_VIEW_COLS} FROM users WHERE id = ANY($1)"
    )))
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
    let rank: HashMap<Uuid, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    users.sort_by_key(|u| rank.get(&u.id).copied().unwrap_or(usize::MAX));
    let mut count = sqlx::QueryBuilder::new("SELECT count(*) FROM users u");
    push_user_filters(&mut count, &q)?;
    let total: i64 = count.build_query_scalar().fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(UserPage { users, total }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateUserReq {
    /// D1: the login name. Set as verified (the admin vouches for it: the
    /// user gets mail and can reset the password with it).
    pub email: String,
    pub password: String,
    pub role: Option<String>,
    /// D12: the plan and term to start with (role=user only); the traffic
    /// limit and expiry come from it, never from the request.
    pub plan: Option<crate::plans::AssignPlanReq>,
}

pub async fn create_user(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateUserReq>,
) -> Result<(axum::http::StatusCode, Json<CreatedUser>), ApiError> {
    user.require_admin()?;
    let email = crate::signup::email::parse(req.email.trim())
        .ok_or_else(|| bad_request!("signup.invalid_email", "invalid email address"))?;
    if req.password.len() < 8 {
        return Err(bad_request!(
            "account.password_too_short",
            "password must be at least 8 characters"
        ));
    }
    let role = req.role.as_deref().unwrap_or("user");
    if role != "user" && role != "admin" {
        return Err(bad_request!(
            "user.role_invalid",
            "role must be 'user' or 'admin'"
        ));
    }
    let assign = req
        .plan
        .as_ref()
        .map(crate::plans::AssignPlanReq::assignment)
        .transpose()?;
    let hash = auth::hash_password_async(&req.password).await?;
    let id = Uuid::new_v4();
    // Mint the subscription token now (W20: stored encrypted as well, so
    // the user and admins can see the link again).
    let sub_token = crate::sub::generate_token();
    let sub_enc = state.master_key().seal_sub_token(id, &sub_token)?;
    let actor = Actor::of(&user);
    let mut tx = state.pg().begin().await?;
    // R47: only the owner makes admins.
    if role == "admin" {
        crate::owner::require(&mut tx, &actor).await?;
    }
    // A plan is assigned in the same transaction (its entitlement lock is
    // taken first: lock order entitle -> servers -> users).
    if assign.is_some() {
        crate::entitle::lock(&mut tx).await?;
    }
    match sqlx::query_as::<_, UserView>(
        "INSERT INTO users (id, email, email_verified_at, password_hash, role, \
         sub_token_hash, sub_token_enc) \
         VALUES ($1, $2, now(), $3, $4, $5, $6) \
         RETURNING id, role, enabled, traffic_limit_bytes, traffic_used_bytes, expires_at, \
         created_at, disabled_reason, \
         NULL::uuid AS plan_id, NULL::text AS plan_name, NULL::timestamptz AS next_reset_at, \
         email, email_verified_at IS NOT NULL AS email_verified, is_owner, false AS erased",
    )
    .bind(id)
    .bind(&email)
    .bind(&hash)
    .bind(role)
    .bind(crate::sub::hash_token(&sub_token))
    .bind(&sub_enc)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(view) => {
            let after = json!({
                "role": view.role, "enabled": view.enabled,
                "email": view.email,
                "password": crate::audit::CHANGED, "sub_token": crate::audit::CHANGED,
            });
            crate::audit::record(
                &mut tx,
                &actor,
                "user.create",
                "user",
                Some(view.id.to_string()),
                None,
                Some(after),
            )
            .await?;
            let view = match assign {
                None => view,
                Some(a) => {
                    crate::plans::apply_set_user_plan(&mut tx, &actor, id, &a).await?;
                    sqlx::query_as::<_, UserView>(sqlx::AssertSqlSafe(format!(
                        "SELECT {USER_VIEW_COLS} FROM users WHERE id = $1"
                    )))
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?
                }
            };
            tx.commit().await?;
            Ok((
                axum::http::StatusCode::CREATED,
                Json(CreatedUser {
                    user: view,
                    sub_url: Some(state.sub_link(id, &sub_token)),
                    sub_token,
                }),
            ))
        }
        Err(sqlx::Error::Database(db))
            if db.is_unique_violation() && db.constraint() == Some(USERS_EMAIL_KEY) =>
        {
            Err(conflict!(
                "user.email_exists",
                "another account already uses this email address"
            ))
        }
        Err(e) => {
            tracing::error!(error = %e, "create user failed");
            Err(ApiError::internal())
        }
    }
}

/// The unique constraint on `users.email` (D1, migration 1010): the one
/// constraint name the code branches on.
pub const USERS_EMAIL_KEY: &str = "users_email_key";

#[derive(Serialize)]
pub struct CreatedUser {
    #[serde(flatten)]
    user: UserView,
    /// Also readable later (W20: `GET /users/{id}/subscription`, audited).
    sub_token: String,
    /// R22: the subscription URL on the subscription domain (null = not
    /// configured: the client builds it from its own origin).
    sub_url: Option<String>,
}

// ---------------------------------------------------------------------------
// Desired-state mutations.
//
// Every mutation that changes what a node must run is an `apply_*` function
// taking the open transaction: it writes the change AND bumps the affected
// nodes' versions in that transaction (REVIEW P0-3). The version bump itself
// raises the per-node NOTIFY (trigger, migration 0007), delivered to every
// panel instance on commit — handlers do nothing after committing. Global
// lock order, to stay
// deadlock-free: nodes (ORDER BY id, FOR UPDATE) -> users -> entrance_users.
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
            Err(e) => Err(bad_request!(
                "request.invalid_body",
                "{detail}",
                detail = e.body_text()
            )),
        }
    }
}

/// PATCH field that distinguishes "absent" (None) from "null" (Some(None)).
pub(crate) fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// A PATCH field that may not be null.
pub(crate) fn non_null<T: Clone>(
    field: &str,
    v: &Option<Option<T>>,
) -> Result<Option<T>, ApiError> {
    match v {
        None => Ok(None),
        Some(None) => Err(bad_request!(
            "request.field_not_null",
            "{field} cannot be null",
            field = field
        )),
        Some(Some(v)) => Ok(Some(v.clone())),
    }
}

/// Locks (in id order) and returns the nodes the user holds credentials on.
async fn lock_user_servers(conn: &mut PgConnection, user_id: Uuid) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT id FROM servers WHERE id IN ({}) ORDER BY id FOR UPDATE",
        crate::entitle::SERVERS_OF_USERS
    )))
    .bind([user_id])
    .fetch_all(conn)
    .await
}

/// Bumps user_version on every node the user holds credentials on, as
/// visible now (after the user row is locked, so concurrent reconciles are
/// either visible here or serialized after us). Returns the bumped node ids.
async fn bump_user_servers(conn: &mut PgConnection, user_id: Uuid) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "UPDATE servers SET user_version = user_version + 1 WHERE id IN ({}) RETURNING id",
        crate::entitle::SERVERS_OF_USERS
    )))
    .bind([user_id])
    .fetch_all(conn)
    .await
}

/// PATCH /users/{id}. D12: the traffic limit and expiry are not editable
/// (they come from the plan: `PUT`/`PATCH /users/{id}/plan`); W28-c:
/// disabling is a ban with a reason (`POST /users/{id}/ban`).
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct UpdateUserReq {
    #[serde(default, deserialize_with = "double_option")]
    pub password: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub role: Option<Option<String>>,
}

/// PATCH /users/{id}. Returns the nodes whose versions were bumped.
/// Audited ("user.update", exact before/after via RETURNING old/new).
pub(crate) async fn apply_update_user(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &UpdateUserReq,
) -> Result<Vec<Uuid>, ApiError> {
    let password = non_null("password", &req.password)?;
    let role = non_null("role", &req.role)?;
    if password.is_none() && role.is_none() {
        return Err(bad_request!("request.no_fields", "no fields to update"));
    }
    if let Some(role) = &role
        && role != "user"
        && role != "admin"
    {
        return Err(bad_request!(
            "user.role_invalid",
            "role must be 'user' or 'admin'"
        ));
    }
    if let Some(pw) = &password
        && pw.len() < 8
    {
        return Err(bad_request!(
            "account.password_too_short",
            "password must be at least 8 characters"
        ));
    }
    // Hashed before any lock is taken (and off the async workers).
    let password_hash = match &password {
        Some(v) => Some(auth::hash_password_async(v).await?),
        None => None,
    };
    // The role changes what nodes serve (admins are not proxy users).
    let affects_nodes = role.is_some();

    // R47: another admin's account (or making one) is the owner's; the
    // owner is never demoted.
    crate::owner::guard_target(conn, actor, id).await?;
    refuse_erased(conn, id).await?;
    let current: Option<(String, bool)> = sqlx::query_as(
        "SELECT role, NOT enabled AND disabled_reason = 'admin' FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((current_role, banned)) = current else {
        return Err(ApiError::not_found());
    };
    let promote = role.as_deref() == Some("admin") && current_role != "admin";
    if promote {
        crate::owner::require(conn, actor).await?;
        // A banned account is unbanned first (an admin that cannot sign in
        // would look like one in the list).
        if banned {
            return Err(conflict!(
                "user.promote_banned",
                "the account is banned; unban it before making it an admin"
            ));
        }
    } else if role.as_deref() == Some("user") {
        crate::owner::protect(conn, id).await?;
    }

    // M3: a user with an active plan must stay a proxy user. Checked under
    // the entitlement lock, which every plan assignment takes, so the check
    // cannot race one.
    if role.as_deref().is_some_and(|r| r != "user") {
        crate::entitle::lock(conn).await?;
        let has_plan: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM user_plans WHERE user_id = $1 AND status = 'active')",
        )
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
        if has_plan {
            return Err(conflict!(
                "user.has_plan",
                "the user has an active plan; cancel it before making the account an admin"
            ));
        }
    }

    if affects_nodes {
        lock_user_servers(conn, id).await?;
    }
    let mut qb = sqlx::QueryBuilder::new("UPDATE users SET ");
    let mut set = qb.separated(", ");
    if let Some(v) = password_hash {
        set.push("password_hash = ").push_bind_unseparated(v);
    }
    if let Some(v) = role {
        set.push("role = ").push_bind_unseparated(v);
    }
    // Admins have no traffic quota: a promotion lifts a quota disable
    // (the user's report behind R47: an admin promoted while over quota
    // stayed disabled and did not count as one).
    if promote {
        set.push("enabled = enabled OR disabled_reason = 'quota'");
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.push(format!(
        " RETURNING {}, {}",
        crate::audit::user_snapshot_sql("old"),
        crate::audit::user_snapshot_sql("new")
    ));
    let Some((before, mut after)) = qb
        .build_query_as::<(serde_json::Value, serde_json::Value)>()
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Err(ApiError::not_found());
    };
    if password.is_some() {
        after["password"] = json!(crate::audit::CHANGED);
    }
    crate::audit::record(
        conn,
        actor,
        "user.update",
        "user",
        Some(id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    if !affects_nodes {
        return Ok(Vec::new());
    }
    Ok(bump_user_servers(conn, id).await?)
}

/// An erased (anonymized) account is never changed again (erase.rs).
async fn refuse_erased(conn: &mut PgConnection, id: Uuid) -> Result<(), ApiError> {
    let erased: Option<bool> =
        sqlx::query_scalar("SELECT erased_at IS NOT NULL FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(conn)
            .await?;
    if erased == Some(true) {
        return Err(conflict!("user.erased", "the account was deleted"));
    }
    Ok(())
}

/// Longest ban reason (characters; the portal shows it to the user).
pub const MAX_BAN_REASON: usize = 500;

/// `POST /users/{id}/ban`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BanReq {
    /// Shown to the user in the portal: write it for them.
    pub reason: String,
}

/// The reason as stored: trimmed, control characters other than newlines
/// removed, 1..=MAX_BAN_REASON characters.
pub(crate) fn clean_ban_reason(raw: &str) -> Result<String, ApiError> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect();
    let n = cleaned.chars().count();
    if n == 0 {
        return Err(bad_request!(
            "user.ban_reason_required",
            "a ban needs a reason (it is shown to the user)"
        ));
    }
    if n > MAX_BAN_REASON {
        return Err(bad_request!(
            "user.ban_reason_too_long",
            "the reason is longer than {max} characters",
            max = MAX_BAN_REASON
        ));
    }
    Ok(cleaned)
}

/// W28-c admin ban: disable the account (`disabled_reason = 'admin'`) with
/// a reason the user sees in the portal. Same transaction: the user's nodes
/// are locked first (servers -> users) and bumped, so every agent drops the
/// user and cuts their live connections (the existing revocation path);
/// the `users` trigger bumps `session_ver` when the account was enabled
/// (every session ends; a new login only reaches the portal scope: ban
/// reason and tickets). Banning again replaces the reason. Your own
/// account cannot be banned (400); the last enabled admin neither (409,
/// AK001). Audited `user.ban`. Returns the bumped nodes.
pub(crate) async fn apply_ban_user(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    reason: &str,
) -> Result<Vec<Uuid>, ApiError> {
    let reason = clean_ban_reason(reason)?;
    if actor.id == Some(id) {
        return Err(bad_request!(
            "user.ban_self",
            "you cannot ban your own account"
        ));
    }
    crate::owner::guard_target(conn, actor, id).await?;
    crate::owner::protect(conn, id).await?;
    refuse_erased(conn, id).await?;
    lock_user_servers(conn, id).await?;
    let row: Option<(serde_json::Value, serde_json::Value, Option<String>)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "UPDATE users SET enabled = false, disabled_reason = 'admin', disabled_note = $2, \
             disabled_by = (SELECT a.id FROM users a WHERE a.id = $3), disabled_at = now() \
             WHERE id = $1 \
             RETURNING {}, {}, old.disabled_note",
            crate::audit::user_snapshot_sql("old"),
            crate::audit::user_snapshot_sql("new")
        )))
        .bind(id)
        .bind(&reason)
        .bind(actor.id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((mut before, mut after, old_reason)) = row else {
        return Err(ApiError::not_found());
    };
    before["reason"] = json!(old_reason);
    after["reason"] = json!(reason);
    crate::audit::record(
        conn,
        actor,
        "user.ban",
        "user",
        Some(id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(bump_user_servers(conn, id).await?)
}

/// W28-c: lift a ban (409 `user.not_banned` unless the account is banned).
/// The account is enabled again (the traffic-limit pass re-disables it for
/// quota on its next tick if it is still over); nodes bumped in the same
/// transaction. Audited `user.unban`. Returns the bumped nodes.
pub(crate) async fn apply_unban_user(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    crate::owner::guard_target(conn, actor, id).await?;
    refuse_erased(conn, id).await?;
    lock_user_servers(conn, id).await?;
    let row: Option<(bool, serde_json::Value, serde_json::Value, Option<String>)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "UPDATE users u SET enabled = (u.disabled_reason = 'admin') OR u.enabled \
             WHERE id = $1 RETURNING old.disabled_reason IS NOT DISTINCT FROM 'admin', {}, {}, \
             old.disabled_note",
            crate::audit::user_snapshot_sql("old"),
            crate::audit::user_snapshot_sql("new")
        )))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((was_banned, mut before, after, reason)) = row else {
        return Err(ApiError::not_found());
    };
    if !was_banned {
        return Err(conflict!("user.not_banned", "the account is not banned"));
    }
    before["reason"] = json!(reason);
    crate::audit::record(
        conn,
        actor,
        "user.unban",
        "user",
        Some(id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(bump_user_servers(conn, id).await?)
}

/// POST /users/{id}/ban `{reason}` (admin). Returns the user's detail.
pub async fn ban_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<BanReq>,
) -> Result<Json<UserDetail>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_ban_user(&mut tx, &Actor::of(&user), id, &req.reason).await?;
    let view = user_detail_in(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(view))
}

/// POST /users/{id}/unban (admin). Returns the user's detail.
pub async fn unban_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<UserDetail>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_unban_user(&mut tx, &Actor::of(&user), id).await?;
    let view = user_detail_in(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(view))
}

/// The ban of a banned account (W28-c), for the console.
#[derive(Serialize, sqlx::FromRow)]
pub struct BanView {
    /// As shown to the user.
    pub reason: Option<String>,
    pub banned_at: Option<DateTime<Utc>>,
    /// The admin who banned (null = deleted since, or CLI/SQL).
    pub banned_by_id: Option<Uuid>,
    pub banned_by_email: Option<String>,
}

/// `GET /users/{id}`: the list row plus the D12 current subscription and
/// the ban (null when not banned).
#[derive(Serialize)]
pub struct UserDetail {
    #[serde(flatten)]
    pub user: UserView,
    pub subscription: Option<crate::plans::SubscriptionView>,
    pub ban: Option<BanView>,
}

async fn user_detail_in(conn: &mut PgConnection, id: Uuid) -> Result<UserDetail, ApiError> {
    let user = sqlx::query_as::<_, UserView>(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_VIEW_COLS} FROM users WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(ApiError::not_found)?;
    let ban = sqlx::query_as::<_, BanView>(
        "SELECT u.disabled_note AS reason, u.disabled_at AS banned_at, \
         u.disabled_by AS banned_by_id, b.email AS banned_by_email \
         FROM users u LEFT JOIN users b ON b.id = u.disabled_by \
         WHERE u.id = $1 AND NOT u.enabled AND u.disabled_reason = 'admin' \
         AND u.erased_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let subscription = crate::plans::subscription(conn, id).await?;
    Ok(UserDetail {
        user,
        subscription,
        ban,
    })
}

/// GET /users/{id} (admin): the user, the D12 current subscription (plan,
/// term, expiry, used/total traffic, last/next reset, status) and the ban.
pub async fn user_detail(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<UserDetail>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    Ok(Json(user_detail_in(&mut c, id).await?))
}

pub async fn update_user(
    State(state): State<AppState>,
    user: AuthUser,
    jar: CookieJar,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<UpdateUserReq>,
) -> Result<(CookieJar, Json<UserView>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_update_user(&mut tx, &Actor::of(&user), id, &req).await?;
    // An admin changing their own password (or role) revokes their own
    // sessions too; this one carries on with a fresh token. Read in the
    // same transaction, so the token matches exactly what was committed.
    let own: Option<(String, bool, i64)> = if id == user.id {
        sqlx::query_as("SELECT role, enabled, session_ver FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
    } else {
        None
    };
    tx.commit().await?;
    let jar = match own {
        Some((role, true, sv)) => jar.add(auth::session_cookie(
            &state,
            auth::issue_token(&state, id, &role, sv)?,
        )),
        _ => jar,
    };
    let row = sqlx::query_as::<_, UserView>(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_VIEW_COLS} FROM users WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    Ok((jar, Json(row)))
}

/// Lock the user's nodes, then the user; remove the assignments, bump
/// exactly those nodes, delete the user — one transaction, so an agent
/// woken by the bump can never read "new version + old user set".
pub(crate) async fn apply_delete_user(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    // R47: admins are the owner's to delete; never the owner.
    crate::owner::guard_target(conn, actor, id).await?;
    crate::owner::protect(conn, id).await?;
    // Global lock order: entitlement lock first (a concurrent reconcile
    // holds it while locking servers), then servers, then the user row.
    crate::entitle::lock(conn).await?;
    lock_user_servers(conn, id).await?;
    let before: Option<serde_json::Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM users u WHERE id = $1 FOR UPDATE",
        crate::audit::user_snapshot_sql("u")
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(before) = before else {
        return Err(ApiError::not_found());
    };
    let servers: Vec<Uuid> = sqlx::query_scalar(
        "WITH d AS (DELETE FROM entrance_users eu USING entrances e \
         WHERE eu.user_id = $1 AND e.id = eu.entrance_id RETURNING e.server_id) \
         SELECT DISTINCT server_id FROM d ORDER BY server_id",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    sqlx::query("UPDATE servers SET user_version = user_version + 1 WHERE id = ANY($1)")
        .bind(&servers)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "user.delete",
        "user",
        Some(id.to_string()),
        Some(before),
        Some(json!({ "unassigned_servers": servers })),
    )
    .await?;
    Ok(servers)
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct DeleteUserQuery {
    /// 中-7: the admin saw the impact summary and confirmed.
    #[serde(default)]
    pub confirm: bool,
}

/// DELETE /users/{id}?confirm=true (中-7: the console shows
/// `GET /users/{id}/delete-impact` first; without `confirm=true` 400
/// `user.delete_confirm_required`, nothing deleted).
pub async fn delete_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    Query(q): Query<DeleteUserQuery>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    if !q.confirm {
        return Err(bad_request!(
            "user.delete_confirm_required",
            "deleting a user needs confirm=true (see GET /users/{{id}}/delete-impact)"
        ));
    }
    let mut tx = state.pg().begin().await?;
    apply_delete_user(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// GET /users/{id}/delete-impact (运营审查中-7): what deleting the account
/// loses — its balance (and how much of it is withdrawable commission),
/// pending withdrawals (already debited: only approvable afterwards),
/// pending orders (a payment arriving after the deletion cannot be
/// refunded to a balance), paid orders not fulfilled, and the active
/// subscription. Reads only. Admin.
pub async fn user_delete_impact(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    crate::erase::impact(&mut c, id)
        .await?
        .map(Json)
        .ok_or_else(ApiError::not_found)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// A JSON body with a strong ETag (SHA-256 of the bytes, 128 bits): a
/// matching `If-None-Match` gets 304 without a body. `private, no-cache`:
/// the browser keeps the copy and revalidates every time (the console's
/// 5 s polling then costs a 304 while nothing changed).
pub fn json_with_etag(req: &HeaderMap, body: Vec<u8>) -> Response {
    use axum::http::{HeaderValue, StatusCode, header};
    use sha2::Digest;
    let tag = format!("\"{}\"", hex::encode(&sha2::Sha256::digest(&body)[..16]));
    let matched = req
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .any(|t| t == "*" || t.strip_prefix("W/").unwrap_or(t) == tag);
    let mut res = if matched {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        (
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            )],
            body,
        )
            .into_response()
    };
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&tag) {
        h.insert(header::ETAG, v);
    }
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    h.insert(header::VARY, HeaderValue::from_static("Cookie"));
    res
}

/// `YYYY-MM-DD HH:MM` in Beijing time (UTC+8, no DST): the console's
/// time zone (W21, M7), for server-written Chinese texts.
pub(crate) fn beijing_time(t: DateTime<Utc>) -> String {
    match chrono::FixedOffset::east_opt(8 * 3600) {
        Some(tz) => t.with_timezone(&tz).format("%Y-%m-%d %H:%M").to_string(),
        None => t.to_rfc3339(),
    }
}

// ---------------------------------------------------------------------------
// Inbounds (node inbound validation, D2)
// ---------------------------------------------------------------------------

/// D2: the stored form of an admin-supplied inbound: a JSON object, its tag
/// removed (the panel names the inbounds it renders), checked like every
/// stored inbound (`validate_inbound`).
pub(crate) fn normalize_inbound(raw: &serde_json::Value) -> Result<serde_json::Value, ApiError> {
    let Some(obj) = raw.as_object() else {
        return Err(bad_request!(
            "inbound.not_object",
            "inbound must be a JSON object"
        ));
    };
    let mut obj = obj.clone();
    obj.retain(|k, _| crate::protocols::fold_json_key(k) != "tag");
    let inbound = serde_json::Value::Object(obj);
    validate_inbound(&inbound)?;
    Ok(inbound)
}

/// A stored inbound needs a protocol and must pass the protocol/transport
/// rules (W8, `protocols::check_inbound`) and the agent's FakeDNS rule.
pub(crate) fn validate_inbound(inbound: &serde_json::Value) -> Result<(), ApiError> {
    match inbound.get("protocol").and_then(|p| p.as_str()) {
        Some(p) if !p.is_empty() => {}
        _ => {
            return Err(bad_request!(
                "inbound.protocol_missing",
                "the inbound needs a protocol"
            ));
        }
    }
    // The agent's gate dispatcher wraps a DefaultDispatcher without a
    // FakeDNS engine (R10 F4): fakedns sniffing would silently misroute.
    if mentions_fakedns(inbound) {
        return Err(bad_request!(
            "inbound.fakedns",
            "fakedns is not supported by the agent"
        ));
    }
    // W8: protocol/transport matrix (protocols.rs). gRPC is allowed again
    // since R26 (agent grpc-go pinned past GO-2026-6443).
    if let Err(e) = crate::protocols::check_inbound(inbound) {
        return Err(bad_request!("inbound.invalid", "{detail}", detail = e));
    }
    Ok(())
}

/// Key comparison as Go's encoding/json does it (xray parses the inbounds
/// with it): case-insensitive, including the two non-ASCII runes that fold
/// onto ASCII letters (U+017F long s, U+212A Kelvin sign).
fn json_key_eq(key: &str, want: &str) -> bool {
    crate::protocols::fold_json_key(key) == want
}

/// Values of `obj`'s keys matching `name` the Go-json way (every duplicate
/// or case variant: which one Go picks must not matter).
fn json_fields<'a>(
    obj: &'a serde_json::Map<String, serde_json::Value>,
    name: &'a str,
) -> impl Iterator<Item = &'a serde_json::Value> + 'a {
    obj.iter()
        .filter(move |(k, _)| json_key_eq(k, name))
        .map(|(_, v)| v)
}

/// Does this inbound turn on FakeDNS (R11 L1: only
/// `sniffing.destOverride` containing "fakedns" / "fakedns+others", as
/// xray's SniffingConfig reads it: an array or a comma-separated string,
/// lowercased)? Tags, paths, server names etc. that merely contain the
/// substring are fine. The agent re-checks after xray's own parse.
fn mentions_fakedns(inbound: &serde_json::Value) -> bool {
    let is_fakedns = |s: &str| {
        s.split(',').any(|p| {
            let p = p.trim().to_lowercase();
            p == "fakedns" || p == "fakedns+others"
        })
    };
    let Some(obj) = inbound.as_object() else {
        return false;
    };
    if json_fields(obj, "protocol").any(|p| p.as_str().is_some_and(is_fakedns)) {
        return true;
    }
    json_fields(obj, "sniffing")
        .filter_map(|s| s.as_object())
        .flat_map(|s| json_fields(s, "destoverride"))
        .any(|d| match d {
            serde_json::Value::String(s) => is_fakedns(s),
            serde_json::Value::Array(a) => a.iter().any(|v| v.as_str().is_some_and(is_fakedns)),
            _ => false,
        })
}

/// Warning for a stored inbound (NodeView): a configuration accepted
/// before a check existed stays as it is until an admin changes it; if it
/// would now be refused, the reason.
pub(crate) fn inbound_warning(inbound: &serde_json::Value) -> Option<String> {
    crate::protocols::check_inbound(inbound)
        .err()
        .map(|e| format!("入站：{e}"))
}

/// A new account for `inbound` (protocols.rs: the inbound's protocol and
/// settings decide its shape).
pub(crate) fn generate_account(inbound: &serde_json::Value) -> Result<serde_json::Value, ApiError> {
    crate::protocols::generate_account(inbound)
        .map_err(|e| bad_request!("inbound.account_invalid", "{detail}", detail = e))
}

// ---------------------------------------------------------------------------
// Subscription token
// ---------------------------------------------------------------------------

/// Resets a user's subscription (高-3): a new token (the old link stops
/// working; W20: stored encrypted, readable again via
/// `GET /users/{id}/subscription`) and new credentials on every entrance
/// (imported clients are disconnected and refused; `sub::apply_reset`).
pub async fn regenerate_sub_token(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let (token, outcome) =
        crate::sub::apply_reset(&mut tx, state.master_key(), &Actor::of(&user), id)
            .await?
            .ok_or_else(ApiError::not_found)?;
    tx.commit().await?;
    let sub_url = state.sub_link(id, &token);
    Ok(Json(json!({
        "sub_token": token,
        "sub_url": sub_url,
        "credentials_rotated": outcome.updated,
    })))
}

/// Test hooks for other modules' tests (plans.rs).
#[cfg(test)]
pub(crate) async fn apply_update_user_for_test(
    conn: &mut PgConnection,
    user: Uuid,
    req: &UpdateUserReq,
) -> Result<Vec<Uuid>, ApiError> {
    apply_update_user(conn, &Actor::test(), user, req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nodes::{UpdateNodeReq, apply_set_inbound, apply_update_node};
    use crate::testdb::TestDb;
    use axum::extract::FromRequest;
    use axum::http::StatusCode;
    use std::collections::HashSet;

    /// D2: one inbound object per node; its tag (any case variant, the
    /// way xray reads keys) is the panel's business and dropped.
    #[test]
    fn inbound_validation() {
        let ok = normalize_inbound(&json!({"tag": "a", "TAG": "b", "protocol": "vless"})).unwrap();
        assert_eq!(ok, json!({"protocol": "vless"}));
        assert!(validate_inbound(&json!({"protocol": "vmess"})).is_ok());
        for bad in [
            json!([]),
            json!([{"protocol": "vless"}]),
            json!("vless"),
            json!({}),
            json!({"protocol": ""}),
            json!({"tag": "a"}),
        ] {
            let e = normalize_inbound(&bad).unwrap_err();
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
        assert!(r.enabled.is_none() && r.region.is_none());
        let r: UpdateNodeReq = parse(r#"{"region": null}"#).await.ok().unwrap();
        assert_eq!(r.region, Some(None));
        let r: UpdateUserReq = parse(r#"{"password": null}"#).await.ok().unwrap();
        assert_eq!(r.password, Some(None));
        for bad in [
            r#"{"rol": "user"}"#,
            // D12: limit and expiry come from the plan; W28-c: disabling is
            // a ban with a reason.
            r#"{"expires_at": null}"#,
            r#"{"traffic_limit_bytes": 1}"#,
            r#"{"enabled": false}"#,
            r#"{"role": 1}"#,
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
        // u starts with raw credentials on n1 and n2 (as a pre-plan row
        // would be): the user cases below need an account without a plan
        // (role changes); the first reconcile that looks at them revokes
        // them (D3: plans are the only source).
        let (n1, u) = db.member().await;
        let n2 = db.node().await;
        db.assign(n2, u).await;
        let other = db.node().await;
        let doomed = db.node().await;
        let ours = [n1, n2, other, doomed];
        let (e1, eo, ed) = (
            db.direct(n1).await,
            db.direct(other).await,
            db.direct(doomed).await,
        );
        // M3: an (initially empty) group granted by a plan.
        let (group, plan) = {
            let mut tx = db.pool.begin().await.unwrap();
            let actor = crate::audit::Actor::test();
            let g = crate::plans::apply_create_group(
                &mut tx,
                &actor,
                &crate::plans::CreateGroupReq {
                    name: "g".into(),
                    description: None,
                    entrance_ids: None,
                },
            )
            .await
            .ok()
            .unwrap();
            let p = crate::plans::apply_create_plan(
                &mut tx,
                &actor,
                &crate::plans::CreatePlanReq {
                    name: "p".into(),
                    traffic_quota_bytes: None,
                    period: "monthly".into(),
                    speed_limit_mbps: None,
                    device_seats: None,
                    sort: None,
                    enabled: None,
                    group_ids: Some(vec![g]),
                    ..Default::default()
                },
            )
            .await
            .ok()
            .unwrap();
            tx.commit().await.unwrap();
            (g, p)
        };
        let group_entrances = move |entrances: Vec<Uuid>| -> Op {
            let entrances = std::sync::Arc::new(entrances);
            Box::new(move |c| {
                let entrances = entrances.clone();
                Box::pin(async move {
                    crate::plans::apply_update_group(
                        c,
                        &crate::audit::Actor::test(),
                        group,
                        &crate::plans::UpdateGroupReq {
                            entrance_ids: Some(Some(entrances.to_vec())),
                            ..Default::default()
                        },
                    )
                    .await
                    .map(|_| ())
                })
            })
        };
        let plan_groups = move |groups: Vec<Uuid>| -> Op {
            let groups = std::sync::Arc::new(groups);
            Box::new(move |c| {
                let groups = groups.clone();
                Box::pin(async move {
                    crate::plans::apply_update_plan(
                        c,
                        &crate::audit::Actor::test(),
                        plan,
                        &crate::plans::UpdatePlanReq {
                            group_ids: Some(Some(groups.to_vec())),
                            apply_to_existing: true,
                            ..Default::default()
                        },
                    )
                    .await
                    .map(|_| ())
                })
            })
        };
        let plan_groups_for_new = move |groups: Vec<Uuid>| -> Op {
            let groups = std::sync::Arc::new(groups);
            Box::new(move |c| {
                let groups = groups.clone();
                Box::pin(async move {
                    crate::plans::apply_update_plan(
                        c,
                        &crate::audit::Actor::test(),
                        plan,
                        &crate::plans::UpdatePlanReq {
                            group_ids: Some(Some(groups.to_vec())),
                            ..Default::default()
                        },
                    )
                    .await
                    .map(|_| ())
                })
            })
        };
        let entrance = move |id: Uuid, req: crate::entrances::EntranceReq| -> Op {
            let req = std::sync::Arc::new(req);
            Box::new(move |c| {
                let req = req.clone();
                Box::pin(async move {
                    crate::entrances::apply_update(c, &crate::audit::Actor::test(), id, &req)
                        .await
                        .map(|_| ())
                })
            })
        };
        let set_plan = move || -> Op {
            Box::new(move |c| {
                Box::pin(async move {
                    crate::plans::apply_set_user_plan(
                        c,
                        &crate::audit::Actor::test(),
                        u,
                        &crate::plans::SetUserPlanReq {
                            plan_id: plan,
                            term: crate::plans::Term::new(
                                crate::billing::catalog::PeriodKind::Month,
                                None,
                            )?,
                        },
                    )
                    .await
                    .map(|_| ())
                })
            })
        };
        let node = move |id: Uuid, req: UpdateNodeReq| -> Op {
            let req = std::sync::Arc::new(req);
            Box::new(move |c| {
                let req = req.clone();
                Box::pin(async move {
                    apply_update_node(c, &crate::audit::Actor::test(), id, &req)
                        .await
                        .map(|_| ())
                })
            })
        };
        let server = move |id: Uuid, req: crate::servers::UpdateServerReq| -> Op {
            let req = std::sync::Arc::new(req);
            Box::new(move |c| {
                let req = req.clone();
                Box::pin(async move {
                    crate::servers::apply_update(c, &crate::audit::Actor::test(), id, &req)
                        .await
                        .map(|_| ())
                })
            })
        };
        // u is promoted and demoted below; another admin stays (0009 guard).
        db.admin().await;
        // R12 D3: the bump itself notifies (trigger), once per node.
        let mut listener = db.listener().await;

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
                Box::pin(async move {
                    apply_update_user(c, &crate::audit::Actor::test(), u, &req)
                        .await
                        .map(|_| ())
                })
            })
        };
        // An op on the node's (only) relay entrance, looked up when it runs.
        type RelayFn = for<'c> fn(
            &'c mut PgConnection,
            Uuid,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), ApiError>> + Send + 'c>,
        >;
        let relay_op = |node: Uuid, f: RelayFn| -> Op {
            Box::new(move |c| {
                Box::pin(async move {
                    let id: Uuid = sqlx::query_scalar(
                        "SELECT id FROM entrances WHERE node_id = $1 AND kind = 'relay'",
                    )
                    .bind(node)
                    .fetch_one(&mut *c)
                    .await?;
                    f(c, id).await
                })
            })
        };
        let cases: Vec<(&str, Op, Vec<Uuid>, bool)> = vec![
            (
                "ban user (W28-c)",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_ban_user(c, &crate::audit::Actor::test(), u, "abuse")
                            .await
                            .map(|_| ())
                    })
                }),
                vec![n1, n2],
                true,
            ),
            (
                "unban user (W28-c)",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_unban_user(c, &crate::audit::Actor::test(), u)
                            .await
                            .map(|_| ())
                    })
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
                "password only",
                upd(UpdateUserReq {
                    password: Some(Some("longenough1".into())),
                    ..Default::default()
                }),
                vec![n1, n2],
                false,
            ),
            (
                "disable node",
                node(
                    n1,
                    UpdateNodeReq {
                        enabled: Some(Some(false)),
                        ..Default::default()
                    },
                ),
                vec![n1],
                true,
            ),
            (
                "enable node",
                node(
                    n1,
                    UpdateNodeReq {
                        enabled: Some(Some(true)),
                        ..Default::default()
                    },
                ),
                vec![n1],
                true,
            ),
            (
                "enable node again (no-op)",
                node(
                    n1,
                    UpdateNodeReq {
                        enabled: Some(Some(true)),
                        ..Default::default()
                    },
                ),
                vec![n1],
                false,
            ),
            (
                "tls domain (W10: the agent gets it with a Snapshot)",
                server(
                    n1,
                    crate::servers::UpdateServerReq {
                        tls_domain: Some(Some("N1.Example.com".into())),
                        ..Default::default()
                    },
                ),
                vec![n1],
                true,
            ),
            (
                "same tls domain (no-op)",
                server(
                    n1,
                    crate::servers::UpdateServerReq {
                        tls_domain: Some(Some("n1.example.com".into())),
                        ..Default::default()
                    },
                ),
                vec![n1],
                false,
            ),
            (
                "clear tls domain",
                server(
                    n1,
                    crate::servers::UpdateServerReq {
                        tls_domain: Some(None),
                        ..Default::default()
                    },
                ),
                vec![n1],
                true,
            ),
            (
                "node display fields (W11, no access change)",
                node(
                    n1,
                    UpdateNodeReq {
                        display_name: Some(Some("香港 01".into())),
                        sort: Some(Some(3)),
                        visible: Some(Some(false)),
                        tags: Some(Some(vec!["IPLC".into()])),
                        ..Default::default()
                    },
                ),
                vec![n1],
                false,
            ),
            (
                "entrance address, multiplier, name (W28-a: subscription and billing only)",
                entrance(
                    e1,
                    crate::entrances::EntranceReq {
                        name: Some(Some("直连 2".into())),
                        connect_host: Some(Some("relay.example.com".into())),
                        connect_port: Some(Some(30443)),
                        rate: Some(Some(0.5)),
                        sort: Some(Some(2)),
                        ..Default::default()
                    },
                ),
                vec![n1],
                false,
            ),
            (
                "disable the direct entrance (its inbound goes away)",
                entrance(
                    e1,
                    crate::entrances::EntranceReq {
                        enabled: Some(Some(false)),
                        ..Default::default()
                    },
                ),
                vec![n1],
                true,
            ),
            (
                "enable it again",
                entrance(
                    e1,
                    crate::entrances::EntranceReq {
                        enabled: Some(Some(true)),
                        ..Default::default()
                    },
                ),
                vec![n1],
                true,
            ),
            (
                "create a relay entrance (a new inbound)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::entrances::apply_create_relay(
                            c,
                            &crate::audit::Actor::test(),
                            n1,
                            &crate::entrances::CreateRelayReq {
                                name: "IPLC".into(),
                                connect_host: "relay.example.net".into(),
                                connect_port: 30443,
                                listen_port: 20443,
                                source_cidrs: vec!["203.0.113.7".into()],
                                rate: Some(2.0),
                                enabled: None,
                                sort: None,
                                group_ids: None,
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
                "relay listen port and sources (its inbound and filter change)",
                relay_op(n1, |c, id| {
                    Box::pin(async move {
                        crate::entrances::apply_update(
                            c,
                            &crate::audit::Actor::test(),
                            id,
                            &crate::entrances::EntranceReq {
                                listen_port: Some(Some(20444)),
                                source_cidrs: Some(Some(vec!["198.51.100.0/24".into()])),
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
                "relay multiplier and address (subscription and billing only)",
                relay_op(n1, |c, id| {
                    Box::pin(async move {
                        crate::entrances::apply_update(
                            c,
                            &crate::audit::Actor::test(),
                            id,
                            &crate::entrances::EntranceReq {
                                rate: Some(Some(1.5)),
                                connect_port: Some(Some(30444)),
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
                "delete the relay (its inbound goes away)",
                relay_op(n1, |c, id| {
                    Box::pin(async move {
                        crate::entrances::apply_delete(c, &crate::audit::Actor::test(), id).await
                    })
                }),
                vec![n1],
                true,
            ),
            (
                "set inbound (the reconcile revokes the plan-less row)",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_set_inbound(
                            c,
                            &crate::audit::Actor::test(),
                            n1,
                            Some(&json!({"protocol": "vless", "port": 2})),
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1],
                true,
            ),
            (
                "set user plan (empty group; revokes the other plan-less row)",
                set_plan(),
                vec![n2],
                true,
            ),
            (
                "set user plan again (nothing to change)",
                set_plan(),
                vec![n1, n2, other],
                false,
            ),
            (
                "group gains an entrance",
                group_entrances(vec![eo]),
                vec![other],
                true,
            ),
            (
                "group gains another",
                group_entrances(vec![eo, e1]),
                vec![n1],
                true,
            ),
            (
                "plan drops group",
                plan_groups(vec![]),
                vec![other, n1],
                true,
            ),
            (
                "plan regains group",
                plan_groups(vec![group]),
                vec![other, n1],
                true,
            ),
            (
                "entrance form: joins a granted group",
                entrance(
                    ed,
                    crate::entrances::EntranceReq {
                        group_ids: Some(Some(vec![group])),
                        ..Default::default()
                    },
                ),
                vec![doomed],
                true,
            ),
            (
                "entrance form: same groups again (no-op)",
                entrance(
                    ed,
                    crate::entrances::EntranceReq {
                        group_ids: Some(Some(vec![group])),
                        ..Default::default()
                    },
                ),
                vec![doomed],
                false,
            ),
            (
                "entrance form: leaves the group",
                entrance(
                    ed,
                    crate::entrances::EntranceReq {
                        group_ids: Some(Some(vec![])),
                        ..Default::default()
                    },
                ),
                vec![doomed],
                true,
            ),
            (
                "node alert rules (W17, nothing the agent runs)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::alerts::apply_set_server_rules(
                            c,
                            &crate::audit::Actor::test(),
                            n1,
                            &crate::alerts::ServerRules {
                                muted: true,
                                cpu_percent: Some(95),
                                ..Default::default()
                            },
                        )
                        .await
                    })
                }),
                vec![n1],
                false,
            ),
            (
                // 中-5: an edit not applied to existing subscribers changes
                // nothing they are served.
                "plan quota edit for new purchases only",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::plans::apply_update_plan(
                            c,
                            &crate::audit::Actor::test(),
                            plan,
                            &crate::plans::UpdatePlanReq {
                                traffic_quota_bytes: Some(Some(1 << 40)),
                                group_ids: Some(Some(vec![])),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1, other],
                false,
            ),
            (
                "plan groups back (new purchases only)",
                plan_groups_for_new(vec![group]),
                vec![n1, other],
                false,
            ),
            (
                "plan speed limit (W7: travels in every user op)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::plans::apply_update_plan(
                            c,
                            &crate::audit::Actor::test(),
                            plan,
                            &crate::plans::UpdatePlanReq {
                                speed_limit_mbps: Some(Some(50)),
                                apply_to_existing: true,
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1, other],
                true,
            ),
            (
                "plan capacity/description only",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::plans::apply_update_plan(
                            c,
                            &crate::audit::Actor::test(),
                            plan,
                            &crate::plans::UpdatePlanReq {
                                capacity: Some(Some(5)),
                                description: Some(Some("d".into())),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1, other],
                false,
            ),
            (
                "reset pack, user enabled (served state unchanged)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::plans::apply_reset_traffic(c, &crate::audit::Actor::test(), u, plan)
                            .await
                            .map(|_| ())
                    })
                }),
                vec![n1, other],
                false,
            ),
            (
                // Ops batch "重置已用流量": an enabled user's usage is
                // zeroed; what the nodes serve does not change.
                "admin traffic reset, user enabled (no access change)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::plans::apply_admin_reset_traffic(c, &crate::audit::Actor::test(), u)
                            .await
                            .map(|_| ())
                    })
                }),
                vec![n1, other],
                false,
            ),
            (
                // ...a quota-disabled one comes back into service: every
                // node of the user resends it.
                "admin traffic reset re-enables a quota-disabled user",
                Box::new(move |c| {
                    Box::pin(async move {
                        sqlx::query(
                            "UPDATE users SET enabled = false, disabled_reason = 'quota' \
                             WHERE id = $1",
                        )
                        .bind(u)
                        .execute(&mut *c)
                        .await?;
                        crate::plans::apply_admin_reset_traffic(c, &crate::audit::Actor::test(), u)
                            .await
                            .map(|_| ())
                    })
                }),
                vec![n1, other],
                true,
            ),
            (
                "extend user plan by N days (D12)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::plans::apply_renew_user_plan(
                            c,
                            &crate::audit::Actor::test(),
                            u,
                            crate::plans::Renewal::ExtendDays(30),
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1, other],
                true,
            ),
            (
                // 高-3: "重置订阅" = a new token (user.sub_token.rotate)
                // and new credentials on every entrance
                // (user.credentials.rotate): both nodes resend the user.
                "reset subscription (High-3)",
                Box::new(move |c| {
                    Box::pin(async move {
                        let keys = crate::masterkey::Keys::from_material(&[7u8; 32])?;
                        crate::sub::apply_reset(c, &keys, &crate::audit::Actor::test(), u)
                            .await
                            .map(|_| ())
                    })
                }),
                vec![n1, other],
                true,
            ),
            (
                "refund: roll a renewal back (P1)",
                Box::new(move |c| {
                    Box::pin(async move {
                        let up: Uuid = sqlx::query_scalar(
                            "SELECT id FROM user_plans WHERE user_id = $1 AND status = 'active'",
                        )
                        .bind(u)
                        .fetch_one(&mut *c)
                        .await?;
                        let to: chrono::DateTime<chrono::Utc> =
                            sqlx::query_scalar("SELECT now() + interval '10 days'")
                                .fetch_one(&mut *c)
                                .await?;
                        crate::plans::apply_refund_revoke(
                            c,
                            &crate::audit::Actor::test(),
                            u,
                            Uuid::new_v4(),
                            crate::plans::Revoke::Rollback {
                                user_plan_id: up,
                                to,
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1, other],
                true,
            ),
            (
                "cancel user plan",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::plans::apply_cancel_user_plan(c, &crate::audit::Actor::test(), u)
                            .await
                            .map(|_| ())
                    })
                }),
                vec![n1, other],
                true,
            ),
            (
                "group change without subscribers",
                group_entrances(vec![]),
                vec![other, n1],
                false,
            ),
            (
                "the plan again (its group is empty now)",
                set_plan(),
                vec![other, n1],
                false,
            ),
            (
                "group back (the user regains both)",
                group_entrances(vec![eo, e1]),
                vec![other, n1],
                true,
            ),
            (
                "refund: end the subscription (P1)",
                Box::new(move |c| {
                    Box::pin(async move {
                        let up: Uuid = sqlx::query_scalar(
                            "SELECT id FROM user_plans WHERE user_id = $1 AND status = 'active'",
                        )
                        .bind(u)
                        .fetch_one(&mut *c)
                        .await?;
                        crate::plans::apply_refund_revoke(
                            c,
                            &crate::audit::Actor::test(),
                            u,
                            Uuid::new_v4(),
                            crate::plans::Revoke::End { user_plan_id: up },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![other, n1],
                true,
            ),
            (
                "the plan again after the refund",
                set_plan(),
                vec![other, n1],
                true,
            ),
            (
                // W16: money moves, access does not (one ledger row, one
                // audit row, no bump); the user's deletion below then
                // keeps the ledger row (user_id -> NULL).
                "balance adjustment",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::billing::ledger::apply_adjust(
                            c,
                            &crate::audit::Actor::test(),
                            u,
                            &crate::billing::ledger::AdjustReq {
                                amount_cents: 100,
                                reason: "goodwill".into(),
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1, other],
                false,
            ),
            (
                "delete user",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_delete_user(c, &crate::audit::Actor::test(), u)
                            .await
                            .map(|_| ())
                    })
                }),
                vec![n1, other],
                true,
            ),
            (
                "begin node deletion",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::servers::apply_begin_delete(c, &crate::audit::Actor::test(), doomed)
                            .await
                            .map(|_| ())
                    })
                }),
                vec![doomed],
                true,
            ),
            (
                "begin node deletion again (no-op)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::servers::apply_begin_delete(c, &crate::audit::Actor::test(), doomed)
                            .await
                            .map(|_| ())
                    })
                }),
                vec![doomed],
                false,
            ),
        ];
        let ours_notified = |payloads: Vec<String>| -> Vec<String> {
            let mut v: Vec<String> = payloads
                .into_iter()
                .filter(|p| ours.iter().any(|n| p.ends_with(&n.to_string())))
                .collect();
            v.sort();
            v
        };
        let quiet = std::time::Duration::from_millis(150);
        for (name, op, nodes, bumps) in cases {
            crate::testdb::drain(&mut listener, std::time::Duration::from_millis(20)).await;
            let mut before = vec![];
            for n in &nodes {
                before.push(db.versions(*n).await);
            }
            let audit_before = audit_count(&db.pool).await;
            let mut tx = db.pool.begin().await.unwrap();
            op(&mut tx)
                .await
                .unwrap_or_else(|e| panic!("{name}: {}", e.status()));
            tx.commit().await.unwrap();
            // M1-7: every mutation writes exactly one audit row (an
            // idempotent repeat of a node deletion changes nothing).
            let want_rows = match name {
                "begin node deletion again (no-op)" => 0,
                "reset subscription (High-3)" => 2,
                _ => 1,
            };
            assert_eq!(
                audit_count(&db.pool).await - audit_before,
                want_rows,
                "{name}: audit rows"
            );
            for (n, b) in nodes.iter().zip(before) {
                let after = db.versions(*n).await;
                assert_eq!(after != b, bumps, "{name}: node {n} {b:?} -> {after:?}");
            }
            let got = ours_notified(crate::testdb::drain(&mut listener, quiet).await);
            let mut want: Vec<String> = if bumps {
                nodes.iter().map(|n| n.to_string()).collect()
            } else {
                vec![]
            };
            want.sort();
            assert_eq!(
                got, want,
                "{name}: exactly one notification per bumped node"
            );
        }
        // Phase 2 of the deletion: the delete trigger says 'del:<id>'.
        sqlx::query(
            "UPDATE servers SET delete_acked_at = now() - interval '1 minute' WHERE id = $1",
        )
        .bind(doomed)
        .execute(&db.pool)
        .await
        .unwrap();
        crate::testdb::drain(&mut listener, std::time::Duration::from_millis(20)).await;
        let mut tx = db.pool.begin().await.unwrap();
        assert!(
            crate::reaper::finalize_delete(&mut tx, doomed)
                .await
                .unwrap()
                .is_some()
        );
        tx.commit().await.unwrap();
        assert_eq!(
            ours_notified(crate::testdb::drain(&mut listener, quiet).await),
            vec![format!("del:{doomed}")]
        );
        drop(listener); // holds a pool connection: close() would wait on it
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM entrance_users")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(left, 0, "delete_user removed the credentials");
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
        // Extended into the future (what a plan renewal writes: the marker
        // is reset with the expiry); not due yet.
        sqlx::query(
            "UPDATE users SET expires_at = now() + interval '300 milliseconds', \
             expiry_enforced = false WHERE id = $1",
        )
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
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
        let upd_node = |req: UpdateNodeReq| {
            let pool = db.pool.clone();
            async move {
                let mut tx = pool.begin().await.unwrap();
                let r = apply_update_node(&mut tx, &crate::audit::Actor::test(), n, &req).await;
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
            region: Some(Some("  ".into())),
            ..Default::default()
        })
        .await
        .ok()
        .unwrap();
        let region: Option<String> = sqlx::query_scalar("SELECT region FROM nodes WHERE id = $1")
            .bind(n)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(region, None, "blank region clears it");
        let set_inbound = |node: Uuid, inbound: serde_json::Value| {
            let pool = db.pool.clone();
            async move {
                let mut tx = pool.begin().await.unwrap();
                apply_set_inbound(&mut tx, &crate::audit::Actor::test(), node, Some(&inbound)).await
            }
        };
        assert_eq!(
            err_status(set_inbound(n, json!([{"protocol": "vless"}])).await),
            StatusCode::BAD_REQUEST,
            "D2: one object, not an array"
        );
        assert_eq!(
            err_status(set_inbound(Uuid::new_v4(), json!({"protocol": "vless"})).await),
            StatusCode::NOT_FOUND
        );

        let mut tx = db.pool.begin().await.unwrap();
        assert_eq!(
            err_status(
                apply_update_user(
                    &mut tx,
                    &crate::audit::Actor::test(),
                    u,
                    &UpdateUserReq::default()
                )
                .await
            ),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            err_status(
                apply_update_user(
                    &mut tx,
                    &crate::audit::Actor::test(),
                    u,
                    &UpdateUserReq {
                        password: Some(Some("short".into())),
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
                    &crate::audit::Actor::test(),
                    Uuid::new_v4(),
                    &UpdateUserReq {
                        role: Some(Some("user".into())),
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

    /// A group with the direct entrances of `nodes`, a plan granting it and
    /// that plan for `users` (committed). Returns (group, plan).
    async fn grant(db: &TestDb, nodes: &[Uuid], users: &[Uuid]) -> (Uuid, Uuid) {
        let mut entrances = Vec::new();
        for n in nodes {
            entrances.push(db.direct(*n).await);
        }
        let actor = crate::audit::Actor::test();
        let mut tx = db.pool.begin().await.unwrap();
        let g = crate::plans::apply_create_group(
            &mut tx,
            &actor,
            &crate::plans::CreateGroupReq {
                name: format!("g-{}", Uuid::new_v4()),
                description: None,
                entrance_ids: Some(entrances),
            },
        )
        .await
        .ok()
        .unwrap();
        let p = crate::plans::apply_create_plan(
            &mut tx,
            &actor,
            &crate::plans::CreatePlanReq {
                name: format!("p-{}", Uuid::new_v4()),
                traffic_quota_bytes: None,
                period: "monthly".into(),
                group_ids: Some(vec![g]),
                ..Default::default()
            },
        )
        .await
        .ok()
        .unwrap();
        for u in users {
            crate::plans::apply_set_user_plan(
                &mut tx,
                &actor,
                *u,
                &crate::plans::SetUserPlanReq {
                    plan_id: p,
                    term: crate::plans::Term {
                        kind: crate::billing::catalog::PeriodKind::Onetime,
                        days: None,
                    },
                },
            )
            .await
            .ok()
            .unwrap();
        }
        tx.commit().await.unwrap();
        (g, p)
    }

    async fn account_of(db: &TestDb, n: Uuid, u: Uuid) -> Option<(String, serde_json::Value)> {
        sqlx::query_as(
            "SELECT eu.protocol, eu.account FROM entrance_users eu \
             JOIN entrances e ON e.id = eu.entrance_id WHERE e.node_id = $1 AND eu.user_id = $2",
        )
        .bind(n)
        .bind(u)
        .fetch_optional(&db.pool)
        .await
        .unwrap()
    }

    /// D2: replacing the inbound keeps an account of the same protocol
    /// (refit), reissues one of another protocol, and an inbound the panel
    /// issues nothing for revokes every row (departed) — all in the same
    /// transaction as the inbound change.
    #[tokio::test]
    async fn set_inbound_keeps_refits_or_reissues_credentials() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        let u = db.user().await;
        grant(&db, &[n], &[u]).await;
        let (proto, first) = account_of(&db, n, u).await.unwrap();
        assert_eq!(proto, "vless");
        assert_eq!(first["flow"], "");
        let set = |inbound: serde_json::Value| {
            let pool = db.pool.clone();
            async move {
                let mut tx = pool.begin().await.unwrap();
                apply_set_inbound(&mut tx, &crate::audit::Actor::test(), n, Some(&inbound))
                    .await
                    .ok()
                    .unwrap();
                tx.commit().await.unwrap();
            }
        };
        // Same protocol: the id is kept, the flow follows the inbound.
        set(json!({"protocol": "vless", "port": 443, "settings": {"flow": "xtls-rprx-vision"},
            "streamSettings": {"network": "tcp", "security": "reality",
                "realitySettings": {"dest": "www.apple.com:443", "serverNames": ["www.apple.com"],
                    "privateKey": "aGVsbG8taGVsbG8taGVsbG8taGVsbG8taGVsbG8taGU", "shortIds": ["ab"]}}}))
        .await;
        let (_, kept) = account_of(&db, n, u).await.unwrap();
        assert_eq!(kept["id"], first["id"]);
        assert_eq!(kept["flow"], "xtls-rprx-vision");
        // Another protocol: a new account of that protocol.
        set(json!({"protocol": "trojan", "port": 443})).await;
        let (proto, trojan) = account_of(&db, n, u).await.unwrap();
        assert_eq!(proto, "trojan");
        assert!(trojan.get("password").is_some());
        let departed = || async {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM entrance_users_departed WHERE user_id = $1",
            )
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap()
        };
        assert_eq!(departed().await, 0);
        // Nothing to issue for: revoked, departed (final counters billed).
        set(json!({"protocol": "dokodemo-door", "port": 443})).await;
        assert!(account_of(&db, n, u).await.is_none());
        assert_eq!(departed().await, 1);
        // And no inbound at all.
        set(json!({"protocol": "vless", "port": 443})).await;
        assert!(account_of(&db, n, u).await.is_some());
        assert_eq!(departed().await, 0, "granted again: no longer departed");
        let mut tx = db.pool.begin().await.unwrap();
        apply_set_inbound(&mut tx, &crate::audit::Actor::test(), n, None)
            .await
            .ok()
            .unwrap();
        tx.commit().await.unwrap();
        assert!(account_of(&db, n, u).await.is_none());
        db.drop().await;
    }

    /// Twenty concurrent plan assignments on one node serialize on the
    /// entitlement lock: one credential each, one bump each.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn twenty_concurrent_grants_serialize() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        let (_, plan) = grant(&db, &[n], &[]).await;
        let (c0, u0) = db.versions(n).await;
        let mut tasks = vec![];
        for _ in 0..20 {
            let u = db.user().await;
            let pool = db.pool.clone();
            tasks.push(tokio::spawn(async move {
                let mut tx = pool.begin().await.unwrap();
                crate::plans::apply_set_user_plan(
                    &mut tx,
                    &crate::audit::Actor::test(),
                    u,
                    &crate::plans::SetUserPlanReq {
                        plan_id: plan,
                        term: crate::plans::Term {
                            kind: crate::billing::catalog::PeriodKind::Onetime,
                            days: None,
                        },
                    },
                )
                .await
                .ok()
                .unwrap();
                tx.commit().await.unwrap();
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        let (c1, u1) = db.versions(n).await;
        assert_eq!((c1, u1), (c0, u0 + 20));
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT eu.account->>'id' FROM entrance_users eu JOIN entrances e \
             ON e.id = eu.entrance_id WHERE e.node_id = $1",
        )
        .bind(n)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert_eq!(ids.len(), 20);
        let distinct: HashSet<&String> = ids.iter().collect();
        assert_eq!(distinct.len(), 20, "no lost/duplicate creds");
        db.drop().await;
    }

    /// R10 F1: losing a credential while the user exists leaves a departed
    /// marker (plan cancelled, inbound without credentials); regaining it
    /// clears the marker.
    #[tokio::test]
    async fn departed_marker_written_and_cleared() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let departed = |u: Uuid| {
            let pool = db.pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM entrance_users_departed WHERE user_id = $1",
                )
                .bind(u)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        let n = db.node().await;
        let u = db.user().await;
        let (_, plan) = grant(&db, &[n], &[u]).await;
        let mut tx = db.pool.begin().await.unwrap();
        crate::plans::apply_cancel_user_plan(&mut tx, &crate::audit::Actor::test(), u)
            .await
            .ok()
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(departed(u).await, 1);
        let mut tx = db.pool.begin().await.unwrap();
        crate::plans::apply_set_user_plan(
            &mut tx,
            &crate::audit::Actor::test(),
            u,
            &crate::plans::SetUserPlanReq {
                plan_id: plan,
                term: crate::plans::Term {
                    kind: crate::billing::catalog::PeriodKind::Onetime,
                    days: None,
                },
            },
        )
        .await
        .ok()
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(departed(u).await, 0, "granted again clears it");
        let mut tx = db.pool.begin().await.unwrap();
        apply_set_inbound(
            &mut tx,
            &crate::audit::Actor::test(),
            n,
            Some(&json!({"protocol": "dokodemo-door", "port": 1})),
        )
        .await
        .ok()
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(departed(u).await, 1, "nothing issuable = departed");
        db.drop().await;
    }

    /// While its server is being deleted, node and entrance mutations are
    /// 409; the per-server rate override is validated.
    #[tokio::test]
    async fn deleting_server_refuses_mutations_and_rate_override_validated() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        let e = db.direct(n).await;
        let mut tx = db.pool.begin().await.unwrap();
        let bad = crate::servers::apply_update(
            &mut tx,
            &crate::audit::Actor::test(),
            n,
            &crate::servers::UpdateServerReq {
                traffic_max_rate_bytes_per_sec: Some(Some(0)),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(err_status(bad), StatusCode::BAD_REQUEST);
        tx.rollback().await.unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        crate::servers::apply_update(
            &mut tx,
            &crate::audit::Actor::test(),
            n,
            &crate::servers::UpdateServerReq {
                traffic_max_rate_bytes_per_sec: Some(Some(1000)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(
            crate::servers::apply_begin_delete(&mut tx, &crate::audit::Actor::test(), n)
                .await
                .unwrap()
        );
        tx.commit().await.unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        let r = apply_update_node(
            &mut tx,
            &crate::audit::Actor::test(),
            n,
            &UpdateNodeReq {
                enabled: Some(Some(true)),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(err_status(r), StatusCode::CONFLICT);
        tx.rollback().await.unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        let r = apply_set_inbound(
            &mut tx,
            &crate::audit::Actor::test(),
            n,
            Some(&json!({"protocol": "vless"})),
        )
        .await;
        assert_eq!(err_status(r), StatusCode::CONFLICT);
        tx.rollback().await.unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        let r = crate::entrances::apply_update(
            &mut tx,
            &crate::audit::Actor::test(),
            e,
            &crate::entrances::EntranceReq {
                enabled: Some(Some(false)),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(err_status(r), StatusCode::CONFLICT);
        tx.rollback().await.unwrap();
        // Q1: the server serves nothing while it is being deleted; its
        // nodes keep their own switch (they go away with it).
        let (enabled, rate): (bool, Option<i64>) = sqlx::query_as(
            "SELECT n.enabled, s.traffic_max_rate_bytes_per_sec FROM nodes n \
             JOIN servers s ON s.id = n.server_id WHERE n.id = $1",
        )
        .bind(n)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!((enabled, rate), (true, Some(1000)));
        let mut tx = db.pool.begin().await.unwrap();
        assert_eq!(
            err_status(
                crate::servers::apply_begin_delete(
                    &mut tx,
                    &crate::audit::Actor::test(),
                    Uuid::new_v4()
                )
                .await
            ),
            StatusCode::NOT_FOUND
        );
        tx.rollback().await.unwrap();
        db.drop().await;
    }

    #[test]
    fn fakedns_inbounds_rejected() {
        for bad in [
            json!({"protocol": "vless",
                "sniffing": {"enabled": true, "destOverride": ["http", "fakedns+others"]}}),
            json!({"protocol": "vless", "sniffing": {"destOverride": ["FakeDNS"]}}),
            json!({"protocol": "vless", "sniffing": {"destOverride": "http, fakedns"}}),
            json!({"protocol": "vless", "Sniffing": {"DESTOVERRIDE": ["fakedns"]}}),
            // Go's json folds U+017F onto 's', xray lowercases U+212A to 'k'.
            json!({"protocol": "vless", "\u{17f}niffing": {"de\u{17f}tOverride": ["fa\u{212a}edns"]}}),
            // Duplicate keys by case: whichever Go picks must be safe.
            json!({"protocol": "vless", "sniffing": {"destOverride": ["http"]},
                "SNIFFING": {"destOverride": ["fakedns"]}}),
            json!({"protocol": "fakedns"}),
        ] {
            assert!(validate_inbound(&bad).is_err(), "{bad}");
        }
        for ok in [
            json!({"protocol": "vless",
                "sniffing": {"enabled": true, "destOverride": ["http", "tls"]}}),
            json!({"protocol": "vless", "streamSettings": {"network": "ws",
                "wsSettings": {"path": "/fakedns"}, "tlsSettings": {"serverName": "fakedns.example"}}}),
            json!({"protocol": "vless", "settings": {"fakedns": true},
                "sniffing": {"destOverride": ["fakednsx", "notfakedns"]}}),
        ] {
            assert!(validate_inbound(&ok).is_ok(), "{ok}");
        }
    }

    /// R26: the gRPC transport is accepted again (the agent pins a grpc-go
    /// past GO-2026-6443); W8: a stored inbound that the protocol matrix
    /// would now refuse is surfaced as a NodeView warning.
    #[test]
    fn grpc_transport_accepted_and_stored_problems_warned() {
        for ok in [
            json!({"protocol": "vless", "streamSettings": {"network": "grpc",
                "grpcSettings": {"serviceName": "svc"}}}),
            json!({"protocol": "trojan", "streamSettings": {"network": "grpc", "security": "tls"}}),
            json!({"protocol": "vless", "streamSettings": {"network": "grpc", "security": "reality"}}),
        ] {
            assert!(validate_inbound(&ok).is_ok(), "{ok}");
        }
        let e = validate_inbound(
            &json!({"protocol": "vless", "settings": {"flow": "xtls-rprx-vision"},
            "streamSettings": {"network": "grpc", "security": "tls"}}),
        )
        .expect_err("vision over grpc");
        assert!(e.message().contains("xtls-rprx-vision"), "{}", e.message());
        let w = inbound_warning(
            &json!({"protocol": "vless", "port": 444, "streamSettings": {"network": "kcp"}}),
        )
        .unwrap();
        assert!(w.contains("kcp"), "{w}");
        assert!(inbound_warning(&json!({"protocol": "vless", "port": 443})).is_none());
    }

    // ----- S4-2: session revocation and the last-admin guard ----------

    async fn token_for(state: &AppState, id: Uuid) -> String {
        let (role, sv): (String, i64) =
            sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
                .bind(id)
                .fetch_one(state.pg())
                .await
                .unwrap();
        auth::issue_token(state, id, &role, sv).unwrap()
    }

    /// Does the extractor accept this session token?
    async fn live(state: &AppState, token: &str) -> bool {
        use axum::extract::FromRequestParts;
        let (mut parts, _) = axum::http::Request::builder()
            .header(axum::http::header::COOKIE, format!("{COOKIE_NAME}={token}"))
            .body(())
            .unwrap()
            .into_parts();
        AuthUser::from_request_parts(&mut parts, state)
            .await
            .is_ok()
    }

    async fn update(db: &TestDb, id: Uuid, req: UpdateUserReq) -> Result<(), ApiError> {
        let mut tx = db.pool.begin().await.unwrap();
        apply_update_user(&mut tx, &crate::audit::Actor::test(), id, &req).await?;
        tx.commit().await.map_err(ApiError::from)
    }

    fn admin_user(id: Uuid) -> AuthUser {
        AuthUser {
            id,
            email: "a@example.com".into(),
            role: "admin".into(),
            ip: None,
        }
    }

    /// Every revocation trigger kills the tokens issued before it — whatever
    /// path writes the row — and changes that must not revoke do not.
    #[tokio::test]
    async fn session_revocation_on_every_trigger() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let admin = db.admin().await;
        let u = db.user().await;
        let state = AppState::for_test(db.pool.clone()).await;
        type Step<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>>;
        let sql = |q: &'static str| -> Step<'_> {
            let db = &db;
            Box::pin(async move {
                sqlx::query(sqlx::AssertSqlSafe(q))
                    .bind(u)
                    .execute(&db.pool)
                    .await
                    .unwrap();
            })
        };
        let upd = |req: UpdateUserReq| -> Step<'_> {
            let db = &db;
            Box::pin(async move { update(db, u, req).await.unwrap() })
        };
        let cases: Vec<(&str, Step<'_>, bool)> = vec![
            (
                "traffic limit change",
                sql("UPDATE users SET traffic_limit_bytes = 1099511627776 WHERE id = $1"),
                false,
            ),
            (
                "expiry change",
                sql("UPDATE users SET expires_at = now() + interval '30 days' WHERE id = $1"),
                false,
            ),
            (
                "billing update",
                sql("UPDATE users SET traffic_used_bytes = traffic_used_bytes + 1 WHERE id = $1"),
                false,
            ),
            (
                "enable (already enabled)",
                sql("UPDATE users SET enabled = true WHERE id = $1"),
                false,
            ),
            (
                "API password change",
                upd(UpdateUserReq {
                    password: Some(Some("another-password".into())),
                    ..Default::default()
                }),
                true,
            ),
            // Unbanning must not revive the sessions the ban ended.
            (
                "API ban, then unban",
                Box::pin(async {
                    let mut tx = db.pool.begin().await.unwrap();
                    apply_ban_user(&mut tx, &crate::audit::Actor::test(), u, "r")
                        .await
                        .ok()
                        .unwrap();
                    apply_unban_user(&mut tx, &crate::audit::Actor::test(), u)
                        .await
                        .ok()
                        .unwrap();
                    tx.commit().await.unwrap();
                }),
                true,
            ),
            (
                "API role change",
                upd(UpdateUserReq {
                    role: Some(Some("admin".into())),
                    ..Default::default()
                }),
                true,
            ),
            (
                "API role back",
                upd(UpdateUserReq {
                    role: Some(Some("user".into())),
                    ..Default::default()
                }),
                true,
            ),
            (
                "CLI password reset (admin passwd)",
                sql("UPDATE users SET password_hash = 'x' WHERE id = $1"),
                true,
            ),
            (
                "traffic-limit enforcement",
                Box::pin(async {
                    sqlx::query("UPDATE users SET traffic_limit_bytes = 1, traffic_used_bytes = 5 WHERE id = $1")
                    .bind(u).execute(&db.pool).await.unwrap();
                    let mut tx = db.pool.begin().await.unwrap();
                    crate::enforce::apply_traffic_limits(&mut tx).await.unwrap();
                    tx.commit().await.unwrap();
                    sqlx::query(
                        "UPDATE users SET enabled = true, traffic_limit_bytes = NULL WHERE id = $1",
                    )
                    .bind(u)
                    .execute(&db.pool)
                    .await
                    .unwrap();
                }),
                true,
            ),
            (
                "expiry enforcement",
                Box::pin(async {
                    sqlx::query(
                        "UPDATE users SET expires_at = now() - interval '1 hour' WHERE id = $1",
                    )
                    .bind(u)
                    .execute(&db.pool)
                    .await
                    .unwrap();
                    let mut tx = db.pool.begin().await.unwrap();
                    crate::enforce::apply_expiry(&mut tx).await.unwrap();
                    tx.commit().await.unwrap();
                    sqlx::query("UPDATE users SET expires_at = NULL WHERE id = $1")
                        .bind(u)
                        .execute(&db.pool)
                        .await
                        .unwrap();
                }),
                true,
            ),
            (
                "admin revoke-sessions",
                Box::pin(async {
                    revoke_sessions(
                        State(state.clone()),
                        admin_user(admin),
                        Path(("p".into(), u)),
                    )
                    .await
                    .unwrap();
                }),
                true,
            ),
        ];
        for (name, step, revokes) in cases {
            let before = token_for(&state, u).await;
            assert!(live(&state, &before).await, "{name}: fresh token live");
            step.await;
            assert_eq!(!live(&state, &before).await, revokes, "{name}");
            assert!(
                live(&state, &token_for(&state, u).await).await,
                "{name}: new login works"
            );
        }
        // Unknown account.
        let e = revoke_sessions(
            State(state.clone()),
            admin_user(admin),
            Path(("p".into(), Uuid::new_v4())),
        )
        .await
        .unwrap_err();
        assert_eq!(e.status(), StatusCode::NOT_FOUND);
        // Non-admins cannot revoke.
        let e = revoke_sessions(
            State(state.clone()),
            AuthUser {
                id: u,
                email: "u@example.com".into(),
                role: "user".into(),
                ip: None,
            },
            Path(("p".into(), admin)),
        )
        .await
        .unwrap_err();
        assert_eq!(e.status(), StatusCode::FORBIDDEN);
        // A token without `sv` (issued before 0009) is refused.
        let legacy = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            &json!({"sub": u, "role": "user", "iat": 0, "exp": 4_000_000_000u64}),
            &jsonwebtoken::EncodingKey::from_secret(state.jwt_secret().as_bytes()),
        )
        .unwrap();
        assert!(!live(&state, &legacy).await);
        drop(state);
        db.drop().await;
    }

    /// Logout kills the presented session — and every other session of the
    /// account (a stolen copy of the cookie dies with it); a stale or
    /// garbage cookie just gets cleared.
    #[tokio::test]
    async fn logout_revokes_copies_of_the_cookie() {
        use axum_extra::extract::cookie::Cookie;
        let Some(db) = TestDb::new().await else {
            return;
        };
        let u = db.user().await;
        let state = AppState::for_test(db.pool.clone()).await;
        let mine = token_for(&state, u).await;
        let stolen = mine.clone();
        let other_device = token_for(&state, u).await;
        let jar = CookieJar::new().add(Cookie::new(COOKIE_NAME, mine.clone()));
        let res = logout(State(state.clone()), jar).await;
        assert_eq!(res.status(), StatusCode::OK);
        let set = res
            .headers()
            .get(axum::http::header::SET_COOKIE)
            .expect("removal cookie")
            .to_str()
            .unwrap();
        let c = Cookie::parse(set.to_string()).unwrap();
        assert_eq!((c.name(), c.value()), (COOKIE_NAME, ""));
        assert_eq!(c.max_age(), Some(time::Duration::ZERO));
        assert!(!live(&state, &stolen).await, "copied cookie dead");
        assert!(!live(&state, &other_device).await, "logged out everywhere");
        let sv: i64 = sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        // Logging out again with the dead cookie bumps nothing.
        for garbage in [mine.as_str(), "not-a-jwt"] {
            let jar = CookieJar::new().add(Cookie::new(COOKIE_NAME, garbage.to_string()));
            let res = logout(State(state.clone()), jar).await;
            assert_eq!(res.status(), StatusCode::OK);
        }
        let res = logout(State(state.clone()), CookieJar::new()).await;
        assert_eq!(res.status(), StatusCode::OK);
        let sv2: i64 = sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(sv, sv2);
        drop(state);
        db.drop().await;
    }

    /// An admin changing their own password keeps working (fresh cookie);
    /// their other sessions die.
    #[tokio::test]
    async fn own_password_change_reissues_the_cookie() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let a = db.admin().await;
        let state = AppState::for_test(db.pool.clone()).await;
        let old = token_for(&state, a).await;
        let (jar, _) = update_user(
            State(state.clone()),
            admin_user(a),
            CookieJar::new(),
            Path(("p".into(), a)),
            ApiJson(UpdateUserReq {
                password: Some(Some("brand-new-password".into())),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        assert!(!live(&state, &old).await);
        let fresh = jar.get(COOKIE_NAME).expect("reissued cookie");
        assert!(live(&state, fresh.value()).await);
        assert_eq!(fresh.secure(), Some(true), "cookie_secure defaults to true");
        drop(state);
        db.drop().await;
    }

    // ----- S4-1: login rate limit behind proxies ----------------------

    async fn account(db: &TestDb, password: &str) -> String {
        let login = format!("acct-{}@example.com", Uuid::new_v4().simple());
        sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)")
            .bind(Uuid::new_v4())
            .bind(&login)
            .bind(auth::hash_password(password).unwrap())
            .execute(&db.pool)
            .await
            .unwrap();
        login
    }

    /// A random public-looking IPv4 address (tests must not share Valkey
    /// buckets across runs or with each other).
    fn rand_v4() -> std::net::IpAddr {
        let x: u32 = rand::random();
        std::net::IpAddr::V4(std::net::Ipv4Addr::from(0x2d00_0000 | (x & 0x00ff_ffff)))
    }

    async fn try_login(
        state: &AppState,
        peer: std::net::IpAddr,
        xff: Option<&str>,
        login: &str,
        password: &str,
    ) -> StatusCode {
        let mut headers = HeaderMap::new();
        if let Some(x) = xff {
            headers.insert("x-forwarded-for", x.parse().unwrap());
        }
        let r = super::login(
            State(state.clone()),
            crate::access::Entry(Some(crate::access::Via::Admin)),
            ConnectInfo(SocketAddr::new(peer, 40000)),
            headers,
            CookieJar::new(),
            ApiJson(LoginReq {
                email: login.into(),
                password: password.into(),
                guard: None,
            }),
        )
        .await;
        match r {
            Ok(_) => StatusCode::OK,
            Err(e) => e.status(),
        }
    }

    async fn clear_rl(state: &AppState, ips: &[std::net::IpAddr], logins: &[&str]) {
        use fred::prelude::*;
        let mut keys = Vec::new();
        for ip in ips {
            for l in logins {
                keys.extend(crate::login_limit::keys(&crate::client_ip::bucket(*ip), l));
            }
        }
        let _: i64 = state.valkey().del(keys).await.unwrap();
    }

    /// Without trusted proxies X-Forwarded-For is ignored: rotating it does
    /// not escape the peer's bucket. Successful logins never count; every
    /// failure is the same 401.
    #[tokio::test]
    async fn login_limit_ignores_xff_from_untrusted_peers() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let login = account(&db, "right-password").await;
        let peer = rand_v4();
        for _ in 0..30 {
            assert_eq!(
                try_login(&state, peer, None, &login, "right-password").await,
                StatusCode::OK
            );
        }
        let mut junk = Vec::new();
        for i in 0..crate::login_limit::PER_IP {
            let xff = format!("198.51.100.{i}");
            // Wrong password and unknown account: the same 401.
            let (l, p) = if i % 2 == 0 {
                (login.as_str(), "wrong")
            } else {
                ("no-such-user", "x")
            };
            assert_eq!(
                try_login(&state, peer, Some(&xff), l, p).await,
                StatusCode::UNAUTHORIZED
            );
            junk.push(xff);
        }
        assert_eq!(
            try_login(&state, peer, Some("203.0.113.99"), &login, "right-password").await,
            StatusCode::TOO_MANY_REQUESTS,
            "a forged header does not open a new bucket"
        );
        // Another address is unaffected.
        let other = rand_v4();
        assert_eq!(
            try_login(&state, other, None, &login, "right-password").await,
            StatusCode::OK
        );
        clear_rl(&state, &[peer, other], &[&login, "no-such-user"]).await;
        drop(state);
        db.drop().await;
    }

    /// Behind a trusted proxy each forwarded client has its own bucket, a
    /// spoofed left-hand XFF entry does not help, and the per-login bucket
    /// still caps a distributed guesser.
    #[tokio::test]
    async fn login_limit_per_client_behind_trusted_proxy() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let proxy = rand_v4();
        let state = AppState::for_test_with(db.pool.clone(), |c| {
            c.web.trusted_proxies =
                vec![crate::client_ip::Cidr::parse(&proxy.to_string()).unwrap()];
        })
        .await;
        let login = account(&db, "right-password").await;
        let (c1, c2) = (rand_v4(), rand_v4());
        for _ in 0..crate::login_limit::PER_IP {
            assert_eq!(
                try_login(&state, proxy, Some(&c1.to_string()), &login, "wrong").await,
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            try_login(
                &state,
                proxy,
                Some(&c1.to_string()),
                &login,
                "right-password"
            )
            .await,
            StatusCode::TOO_MANY_REQUESTS
        );
        // The client prepends a forged hop: the proxy's appended entry wins.
        assert_eq!(
            try_login(
                &state,
                proxy,
                Some(&format!("{c2}, {c1}")),
                &login,
                "right-password"
            )
            .await,
            StatusCode::TOO_MANY_REQUESTS
        );
        // Another client behind the same proxy is not locked out.
        assert_eq!(
            try_login(
                &state,
                proxy,
                Some(&c2.to_string()),
                &login,
                "right-password"
            )
            .await,
            StatusCode::OK
        );
        // Per-login bucket: failures from many clients add up.
        let victim = account(&db, "victim-password").await;
        let mut ips = vec![proxy, c1, c2];
        for _ in 0..crate::login_limit::PER_LOGIN {
            let c = rand_v4();
            assert_eq!(
                try_login(&state, proxy, Some(&c.to_string()), &victim, "guess").await,
                StatusCode::UNAUTHORIZED
            );
            ips.push(c);
        }
        let fresh = rand_v4();
        ips.push(fresh);
        assert_eq!(
            try_login(
                &state,
                proxy,
                Some(&fresh.to_string()),
                &victim,
                "victim-password"
            )
            .await,
            StatusCode::TOO_MANY_REQUESTS
        );
        clear_rl(&state, &ips, &[&login, &victim]).await;
        drop(state);
        db.drop().await;
    }

    // ----- M1-7: audit log ------------------------------------------------

    async fn audit_count(pool: &sqlx::PgPool) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM audit_log")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// The audit row lives and dies with its mutation's transaction.
    #[tokio::test]
    async fn audit_row_shares_the_mutation_transaction() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let actor = Actor {
            // R47: the owner (it makes an admin below).
            id: Some(db.owner().await),
            label: "boss".into(),
            ip: Some("2001:db8::7".parse().unwrap()),
        };
        let mut tx = db.pool.begin().await.unwrap();
        apply_ban_user(&mut tx, &actor, u, "reason").await.unwrap();
        let inside: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(inside, 1);
        assert_eq!(audit_count(&db.pool).await, 0, "not visible before commit");
        tx.rollback().await.unwrap();
        assert_eq!(audit_count(&db.pool).await, 0, "rollback = no audit row");
        let enabled: bool = sqlx::query_scalar("SELECT enabled FROM users WHERE id = $1")
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(enabled);
        // A failing mutation leaves nothing either (deleting node: 409).
        let mut tx = db.pool.begin().await.unwrap();
        crate::servers::apply_begin_delete(&mut tx, &actor, n)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        let r = apply_set_inbound(&mut tx, &actor, n, Some(&json!({"protocol": "vless"}))).await;
        assert_eq!(err_status(r), StatusCode::CONFLICT);
        drop(tx);
        // Committed: who, from where, what, before/after.
        let mut tx = db.pool.begin().await.unwrap();
        apply_update_user(
            &mut tx,
            &actor,
            u,
            &UpdateUserReq {
                role: Some(Some("admin".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let row: (
            Option<Uuid>,
            String,
            Option<String>,
            String,
            String,
            serde_json::Value,
            serde_json::Value,
        ) = sqlx::query_as(
            "SELECT actor_id, actor_label, ip, action, target_id, before, after FROM audit_log \
                 WHERE action = 'user.update'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(row.0, actor.id);
        assert_eq!(row.1, "boss");
        assert_eq!(row.2.as_deref(), Some("2001:db8::7"));
        assert_eq!(row.4, u.to_string());
        assert_eq!(row.5["role"], "user");
        assert_eq!(row.6["role"], "admin");
        assert_eq!(audit_count(&db.pool).await, 2, "node.delete + user.update");
        db.drop().await;
    }

    /// No secret ever reaches the audit log: password hashes, generated
    /// proxy credentials, inbound keys, subscription tokens.
    #[tokio::test]
    async fn audit_rows_are_redacted() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let a = db.admin().await;
        let state = AppState::for_test(db.pool.clone()).await;
        let admin = admin_user(a);
        let (_, Json(created)) = create_user(
            State(state.clone()),
            admin_user(a),
            ApiJson(CreateUserReq {
                email: "redact-me@example.com".into(),
                password: "first-password-123".into(),
                role: None,
                plan: None,
            }),
        )
        .await
        .unwrap();
        let u = created.user.id;
        let mut secrets = vec![
            "first-password-123".to_string(),
            created.sub_token.clone(),
            crate::sub::hash_token(&created.sub_token),
        ];
        let n = db.node().await;
        grant(&db, &[n], &[u]).await;
        let mut tx = db.pool.begin().await.unwrap();
        apply_set_inbound(
            &mut tx,
            &Actor::of(&admin),
            n,
            Some(&json!({"protocol": "vless", "port": 443,
                "streamSettings": {"network": "tcp", "security": "reality",
                    "realitySettings": {"privateKey": "REALITY-PRIVATE-KEY", "shortIds": ["5eed"]}}})),
        )
        .await
        .unwrap();
        let (_, account) = account_of(&db, n, u).await.unwrap();
        secrets.push(account["id"].as_str().unwrap().to_string());
        secrets.push("REALITY-PRIVATE-KEY".into());
        apply_update_user(
            &mut tx,
            &Actor::of(&admin),
            u,
            &UpdateUserReq {
                password: Some(Some("second-password-456".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        secrets.push("second-password-456".into());
        let token = crate::sub::rotate_token(&mut tx, state.master_key(), &Actor::of(&admin), u)
            .await
            .unwrap()
            .unwrap();
        secrets.push(token.clone());
        secrets.push(crate::sub::hash_token(&token));
        tx.commit().await.unwrap();
        let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        secrets.push(hash);
        secrets.push("$argon2".into());
        // W20: the stored ciphertext never reaches the audit log either.
        let enc: Vec<u8> = sqlx::query_scalar("SELECT sub_token_enc FROM users WHERE id = $1")
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        secrets.push(hex::encode(&enc));
        let text: String = sqlx::query_scalar(
            "SELECT string_agg(concat_ws(' ', actor_label, action, target_id, before::text, after::text), ' ') \
             FROM audit_log",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        for s in &secrets {
            assert!(
                !text.contains(s.as_str()),
                "{s} leaked into the audit log: {text}"
            );
        }
        for want in [
            "user.create",
            "node.set_inbound",
            "user.plan.set",
            "user.update",
            "user.sub_token.rotate",
        ] {
            assert!(text.contains(want), "{want} missing");
        }
        let marker: serde_json::Value =
            sqlx::query_scalar("SELECT after FROM audit_log WHERE action = 'user.update'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(marker["password"], "changed");
        drop(state);
        db.drop().await;
    }

    /// W17: `GET /nodes?view=summary` carries only the list's columns (no
    /// inbounds JSON, a slim heartbeat, the best agent latency), answers
    /// `If-None-Match` with 304, and the full view and `GET /nodes/{id}`
    /// still carry everything.
    #[tokio::test]
    async fn node_summary_view_and_etag() {
        use crate::testdb::http::{Client, rand_ip};
        use axum::http::header;
        use fred::prelude::KeysInterface;
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let admin = db.admin().await;
        let sv: i64 = sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
            .bind(admin)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let mut c = Client::new(&state, rand_ip());
        c.cookie = Some(auth::issue_token(&state, admin, "admin", sv).unwrap());
        let n1 = db.node().await;
        let n2 = db.node().await;
        sqlx::query(
            "INSERT INTO server_latency (server_id, source, target, delay_ms, error, ord, measured_at) \
             VALUES ($1, 'agent', 'https://a/204', NULL, 'timeout', 0, now()), \
                    ($1, 'agent', 'https://b/204', 87, NULL, 1, now()), \
                    ($1, 'panel', 'in-vless', 12, NULL, 0, now())",
        )
        .bind(n1)
        .execute(&db.pool)
        .await
        .unwrap();
        let blob = json!({
            "cpu_percent": 12.5, "mem_used_bytes": 100, "mem_total_bytes": 400,
            "connections": 7, "uptime_seconds": 3600, "lease_remaining_seconds": 86000,
            "ts": "2026-10-02T12:00:00Z",
            "metrics": {"load1": 0.5, "net_rx_bytes_per_sec": 10, "net_tx_bytes_per_sec": 20,
                        "online_users": 3, "disk_used_bytes": 1, "xray_version": "26.1"},
            "cert": {"state": "valid"},
        });
        let key = format!("akari:server:hb:{n1}");
        let _: () = state
            .valkey()
            .set(
                &key,
                blob.to_string(),
                Some(fred::types::Expiration::EX(60)),
                None,
                false,
            )
            .await
            .unwrap();

        let r = c.get("/test/api/v1/nodes?view=summary").await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.headers[header::CACHE_CONTROL], "private, no-cache");
        let etag = r.headers[header::ETAG].to_str().unwrap().to_string();
        assert!(etag.starts_with('"') && etag.len() == 34, "{etag}");
        let v = r.json();
        let row = v
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == n1.to_string())
            .unwrap();
        for absent in ["inbound", "lease_remaining_seconds"] {
            assert!(row.get(absent).is_none(), "{absent}");
        }
        assert_eq!(row["latency"]["delay_ms"], 87);
        assert_eq!(row["alerts_firing"], 0);
        assert_eq!(row["needs_certificate"], false);
        // W28-a: the built-in direct entrance, multiplier 1.
        assert_eq!(row["entrances"].as_array().map(Vec::len), Some(1));
        assert_eq!(row["entrances"][0]["kind"], "direct");
        assert_eq!(row["entrances"][0]["rate"], 1.0);
        assert_eq!(
            row["heartbeat"],
            json!({"cpu_percent": 12.5, "mem_used_bytes": 100, "mem_total_bytes": 400,
                   "connections": 7, "uptime_seconds": 3600, "ts": "2026-10-02T12:00:00Z",
                   "metrics": {"net_rx_bytes_per_sec": 10, "net_tx_bytes_per_sec": 20,
                               "online_users": 3}})
        );
        let other = v
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == n2.to_string())
            .unwrap();
        assert_eq!(other["heartbeat"], serde_json::Value::Null);
        assert_eq!(other["latency"], serde_json::Value::Null);

        // Revalidation: 304 with the same tag, no body; weak form too.
        for inm in [
            etag.clone(),
            format!("W/{etag}"),
            format!("\"x\", {etag}"),
            "*".into(),
        ] {
            c.headers = vec![("if-none-match".into(), inm.clone())];
            let r = c.get("/test/api/v1/nodes?view=summary").await;
            assert_eq!(r.status, StatusCode::NOT_MODIFIED, "{inm}");
            assert!(r.body.is_empty());
            assert_eq!(r.headers[header::ETAG], etag.as_str());
        }
        c.headers = vec![("if-none-match".into(), "\"stale\"".into())];
        assert_eq!(
            c.get("/test/api/v1/nodes?view=summary").await.status,
            StatusCode::OK
        );
        // A change -> a new tag.
        c.headers.clear();
        let r = c
            .req(
                axum::http::Method::PATCH,
                &format!("/test/api/v1/nodes/{n2}"),
                Some(json!({"display_name": "新名字"})),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
        let r = c.get("/test/api/v1/nodes?view=summary").await;
        assert_ne!(r.headers[header::ETAG].to_str().unwrap(), etag);

        // The full list (default) and one node keep every field.
        let full = c.get("/test/api/v1/nodes").await;
        assert!(full.headers.contains_key(header::ETAG));
        assert!(full.json()[0].get("inbound").is_some());
        assert!(full.body.len() > r.body.len());
        let one = c.get(&format!("/test/api/v1/nodes/{n1}")).await;
        assert_eq!(one.status, StatusCode::OK);
        let one = one.json();
        assert_eq!(one["heartbeat"]["metrics"]["xray_version"], "26.1");
        assert_eq!(one["latency"].as_array().unwrap().len(), 3);
        assert_eq!(one["inbound"]["protocol"], "vless");
        assert_eq!(one["entrances"][0]["group_ids"], json!([]));
        assert_eq!(
            c.get(&format!("/test/api/v1/nodes/{}", Uuid::new_v4()))
                .await
                .status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            c.get("/test/api/v1/nodes?view=x").await.status,
            StatusCode::BAD_REQUEST
        );
        // Customers: not theirs.
        let u = db.user().await;
        let mut cu = Client::new(&state, rand_ip());
        cu.cookie = Some({
            let sv: i64 = sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
                .bind(u)
                .fetch_one(&db.pool)
                .await
                .unwrap();
            auth::issue_token(&state, u, "user", sv).unwrap()
        });
        assert_eq!(
            cu.get("/test/api/v1/nodes?view=summary").await.status,
            StatusCode::FORBIDDEN
        );
        let _: i64 = state.valkey().del(&key).await.unwrap();
        drop(state);
        db.drop().await;
    }
}
