use crate::auth::{bad_request, conflict};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::audit::Actor;
use crate::auth::{self, ApiError, AuthUser, ShopUser, COOKIE_NAME};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginReq {
    pub login: String,
    pub password: String,
    /// Second factor (M1-6): a 6-digit TOTP code or an unused recovery
    /// code. Required by accounts with active 2FA, ignored by others.
    #[serde(default)]
    pub code: Option<String>,
}

/// Longest accepted `code` (a recovery code with separators is 14).
const MAX_CODE_LEN: usize = 64;

/// POST /auth/login. Failed attempts are rate limited per client address
/// (behind trusted proxies: the X-Forwarded-For client, see client_ip.rs)
/// and per login name (login_limit.rs). Every credential failure — unknown
/// account, wrong password, missing/wrong/replayed second factor — is the
/// same 401 after the same work (one query, one argon2, the TOTP/recovery
/// computations), so the response says nothing about which part was wrong
/// or whether the account has 2FA.
///
/// Password and code arrive in the same request: there is no
/// half-authenticated state or step token to store, bind, expire or replay.
/// W20 (M9) two-step UI on top of that: a request WITHOUT a code (absent or
/// blank) whose password is right for an account with active 2FA gets a
/// distinct 401 `{"error": "totp required", "totp_required": true}`; the
/// form then shows the code field and re-sends password + code. That answer
/// exists only after the password verified (same query, same argon2, same
/// TOTP computation as every other outcome), so a wrong password, an
/// unknown account and a disabled one still get the uniform 401 after the
/// same work. It does reveal "this password is right and the account has
/// 2FA" — the second factor is what protects such accounts — and it does
/// not speed up password guessing: every wrong password still consumes a
/// login-limit slot exactly as before; only the totp-required answer
/// releases its slot (it is not a credential failure, and a correct
/// password cannot be "guessed" twice). Wrong/replayed codes count as
/// failures as before.
///
/// 2FA is optional (R18): an account without active TOTP logs in with the
/// password alone. Only with `auth.require_admin_2fa` does an admin without
/// TOTP get an enrollment-only session (stage "enroll", 15 min) that
/// reaches nothing but the enrollment endpoints.
///
/// The body goes through `ApiJson` like every other endpoint: malformed
/// JSON, a wrong type or an unknown field is a 400 with the parser's
/// message (it carries no credential information).
pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    ApiJson(req): ApiJson<LoginReq>,
) -> Result<Response, ApiError> {
    if req.login.is_empty() || req.password.is_empty() {
        return Err(bad_request!(
            "auth.credentials_required",
            "login and password are required"
        ));
    }
    if req.code.as_deref().is_some_and(|c| c.len() > MAX_CODE_LEN) {
        return Err(bad_request!("auth.code_too_long", "code is too long"));
    }
    let client = state.client_ip(addr.ip(), &headers);
    // W15: an address logs in case-insensitively, so its per-name bucket
    // must not split by case (admin-made logins never contain '@').
    let limit_name = if req.login.contains('@') {
        req.login.to_lowercase()
    } else {
        req.login.clone()
    };
    let attempt = crate::login_limit::Attempt::reserve(
        &state,
        &crate::client_ip::bucket(client),
        &limit_name,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "login rate limit unavailable");
        ApiError::internal()
    })?
    .ok_or_else(ApiError::too_many)?;

    let failed =
        |attempt: crate::login_limit::Attempt, account: Option<(Uuid, String)>, second: bool| {
            let n = attempt.name_count;
            attempt.fail();
            if let Some((id, login)) = account {
                if second || n == 1 || n == crate::login_limit::PER_LOGIN {
                    audit_login_failure(&state, id, login, client, second, n);
                }
            }
            Err(ApiError::unauthorized())
        };

    match check_credentials(&state, &req).await {
        Ok(Checked::Ok { row, stage, proof }) => {
            match finish_login(&state, &row, stage, proof.as_ref(), client).await {
                Ok(true) => {
                    attempt.release(&state).await;
                    let token =
                        auth::issue_token(&state, row.id, &row.role, row.session_ver, stage)?;
                    Ok((
                        jar.add(auth::session_cookie(&state, token, stage)),
                        Json(json!({
                            "id": row.id, "login": row.login, "role": row.role,
                            "stage": stage.as_str(), "expired": row.expired,
                            "quota_exhausted": row.quota_disabled,
                        })),
                    )
                        .into_response())
                }
                // Lost a race for the same TOTP step / recovery code.
                Ok(false) => failed(attempt, Some((row.id, row.login)), true),
                Err(e) => {
                    attempt.release(&state).await;
                    Err(e)
                }
            }
        }
        Ok(Checked::Failed { account, second }) => failed(attempt, account, second),
        Ok(Checked::TotpRequired) => {
            // Right password, no code yet (W20 two-step form): not a
            // credential failure, so the reservation is released.
            attempt.release(&state).await;
            Ok((
                axum::http::StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "totp required", "totp_required": true })),
            )
                .into_response())
        }
        Err(e) => {
            // Not a credential failure (e.g. the database is down).
            attempt.release(&state).await;
            Err(e)
        }
    }
}

#[derive(sqlx::FromRow)]
struct LoginRow {
    id: Uuid,
    login: String,
    role: String,
    enabled: bool,
    expired: bool,
    /// role=user disabled for quota: may log in to renew (R21).
    quota_disabled: bool,
    password_hash: Option<String>,
    session_ver: i64,
    /// Active TOTP only (enabled_at set); pending enrollments do not count.
    totp_secret: Option<Vec<u8>>,
    totp_last_step: Option<i64>,
    recovery: Vec<String>,
    db_now: i64,
}

enum Checked {
    Ok {
        row: LoginRow,
        stage: auth::Stage,
        proof: Option<crate::totp::Proof>,
    },
    /// `account`: the existing account the attempt named (for the audit
    /// log only); `second`: the password was right, the second factor not.
    Failed {
        account: Option<(Uuid, String)>,
        second: bool,
    },
    /// W20: the password is right, the account has active 2FA and the
    /// request carried no code (absent or blank).
    TotpRequired,
}

/// Verify password and second factor with the same work for every kind of
/// failure. The login name may also be the account's VERIFIED email
/// address (W15; case-insensitive); an exact login match wins.
async fn check_credentials(state: &AppState, req: &LoginReq) -> Result<Checked, ApiError> {
    // Expiry applies to role=user only (an admin must never lock themselves
    // out by a date). TOTP state and unused recovery codes come in the same
    // query, so failures cost the same whatever the account's 2FA state.
    let row = sqlx::query_as::<_, LoginRow>(sqlx::AssertSqlSafe(format!(
        "SELECT u.id, u.login, u.role, u.enabled, u.password_hash, u.session_ver, {} AS expired, \
         (u.role = 'user' AND NOT u.enabled AND u.disabled_reason = 'quota') AS quota_disabled, \
         t.secret_enc AS totp_secret, t.last_step AS totp_last_step, \
         ARRAY(SELECT r.code_hash FROM user_recovery_codes r \
               WHERE r.user_id = u.id AND r.used_at IS NULL ORDER BY r.code_hash) AS recovery, \
         EXTRACT(EPOCH FROM now())::bigint AS db_now \
         FROM users u LEFT JOIN user_totp t ON t.user_id = u.id AND t.enabled_at IS NOT NULL \
         WHERE u.login = $1 OR (u.email = lower($1) AND u.email_verified_at IS NOT NULL) \
         ORDER BY (u.login = $1) DESC LIMIT 1",
        crate::enforce::EXPIRED
    )))
    .bind(&req.login)
    .fetch_optional(state.pg())
    .await?;

    let code = req.code.as_deref().unwrap_or("");
    let account = row.as_ref().map(|r| (r.id, r.login.clone()));
    // Always run the second-factor computation (dummy key without a row).
    let proof = match &row {
        Some(r) => crate::totp::check(
            state.totp(),
            r.id,
            r.totp_secret.as_deref(),
            r.totp_last_step,
            &r.recovery,
            code,
            crate::totp::step_of(r.db_now),
        ),
        None => crate::totp::check(state.totp(), Uuid::nil(), None, None, &[], code, 0),
    };

    // R21: an expired or quota-disabled (role=user) account still logs in —
    // its sessions only reach the renewal scope (`auth::ShopUser`).
    // Accounts disabled for any other reason do not.
    let Some(row) = row.filter(|r| (r.enabled || r.quota_disabled) && r.password_hash.is_some())
    else {
        auth::scrub_password(&req.password);
        return Ok(Checked::Failed {
            account,
            second: false,
        });
    };
    if !auth::verify_password(
        &req.password,
        row.password_hash.as_deref().unwrap_or_default(),
    ) {
        return Ok(Checked::Failed {
            account,
            second: false,
        });
    }
    if let Some(secret) = row.totp_secret.as_deref() {
        if proof.is_none() && code.trim().is_empty() {
            return Ok(Checked::TotpRequired);
        }
        if proof.is_none() {
            if state.totp().open(row.id, secret).is_none() {
                tracing::error!(user = %row.id,
                    "TOTP secret cannot be decrypted (data/totp.key changed?); \
                     recover the account with `akari admin reset-2fa`");
            }
            return Ok(Checked::Failed {
                account,
                second: true,
            });
        }
        return Ok(Checked::Ok {
            row,
            stage: auth::Stage::Full,
            proof,
        });
    }
    let stage = if auth::needs_enrollment(state, &row.role, false) {
        auth::Stage::Enroll
    } else {
        auth::Stage::Full
    };
    Ok(Checked::Ok {
        row,
        stage,
        proof: None,
    })
}

/// Seconds between recorded successful logins of one regular user (admins:
/// every login).
const LOGIN_OK_THROTTLE_SECS: i64 = 600;

/// Commit a successful login: consume the second factor (replay-checked,
/// multi-instance safe) and write the audit row, in one transaction.
/// `Ok(false)`: the TOTP step or recovery code was used concurrently.
async fn finish_login(
    state: &AppState,
    row: &LoginRow,
    stage: auth::Stage,
    proof: Option<&crate::totp::Proof>,
    ip: std::net::IpAddr,
) -> Result<bool, ApiError> {
    use crate::totp::Proof;
    let mut tx = state.pg().begin().await?;
    let consumed = match proof {
        Some(Proof::Totp(step)) => sqlx::query(
            "UPDATE user_totp SET last_step = $2 WHERE user_id = $1 \
             AND enabled_at IS NOT NULL AND (last_step IS NULL OR last_step < $2)",
        )
        .bind(row.id)
        .bind(step)
        .execute(&mut *tx)
        .await?
        .rows_affected(),
        Some(Proof::Recovery(hash)) => sqlx::query(
            "UPDATE user_recovery_codes SET used_at = now() \
             WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL",
        )
        .bind(row.id)
        .bind(hash)
        .execute(&mut *tx)
        .await?
        .rows_affected(),
        None => 1,
    };
    if consumed != 1 {
        return Ok(false);
    }
    if row.role == "admin" || login_ok_due(state, row.id).await {
        let mut after = json!({
            "stage": stage.as_str(),
            "method": proof.map_or("password", |p| p.method()),
        });
        if let Some(Proof::Recovery(_)) = proof {
            after["recovery_codes_left"] = json!(row.recovery.len().saturating_sub(1));
        }
        crate::audit::record(
            &mut tx,
            &Actor::account(row.id, &row.login, Some(ip)),
            "auth.login",
            "user",
            Some(row.id.to_string()),
            None,
            Some(after),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(true)
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
fn audit_login_failure(
    state: &AppState,
    id: Uuid,
    login: String,
    ip: std::net::IpAddr,
    second_factor: bool,
    failures_in_window: i64,
) {
    let state = state.clone();
    tokio::spawn(async move {
        let r = async {
            let mut c = state.pg().acquire().await?;
            crate::audit::record(
                &mut c,
                &Actor {
                    id: None,
                    login,
                    ip: Some(ip),
                },
                "auth.login_failed",
                "user",
                Some(id.to_string()),
                None,
                Some(json!({
                    "reason": if second_factor { "second_factor" } else { "credentials" },
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

#[derive(sqlx::FromRow, Serialize)]
pub struct UserNodeView {
    node_id: Uuid,
    name: String,
    region: Option<String>,
    enabled: bool,
    status: String,
    deleting: bool,
    /// true = an admin assignment (override), false = granted by the plan.
    manual: bool,
    /// `[{tag, protocol}]` of the credentials (never the accounts).
    inbounds: serde_json::Value,
}

/// GET /api/v1/users/{id}/nodes (admin): the nodes the account can use
/// (its node_users rows) with the inbounds it has credentials for and
/// whether each row is a manual assignment or plan-granted. Read-only; the
/// credentials themselves (UUIDs, passwords) are not returned. 404 for an
/// unknown user.
pub async fn user_nodes(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<Vec<UserNodeView>>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found());
    }
    let rows = sqlx::query_as::<_, UserNodeView>(
        "SELECT n.id AS node_id, n.name, n.region, n.enabled, n.status, \
         n.deleting_at IS NOT NULL AS deleting, nu.manual, \
         COALESCE((SELECT jsonb_agg(jsonb_build_object( \
             'tag', c->>'inbound_tag', 'protocol', c->>'protocol') ORDER BY c->>'inbound_tag') \
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(nu.credentials) = 'array' \
                THEN nu.credentials ELSE '[]'::jsonb END) c), '[]'::jsonb) AS inbounds \
         FROM node_users nu JOIN nodes n ON n.id = nu.node_id \
         WHERE nu.user_id = $1 ORDER BY n.name, n.id",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

// ---------------------------------------------------------------------------
// Self
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct MeRow {
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
    email: Option<String>,
    email_verified: bool,
    locale: String,
}

#[derive(Serialize)]
pub struct MeView {
    id: Uuid,
    login: String,
    role: String,
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
    /// R21: past expiry (role=user): the session has the renewal scope only.
    expired: bool,
    /// R21: disabled for exceeding the traffic limit: renewal scope only.
    quota_exhausted: bool,
    /// W15: the account's address (null = none) and whether it is verified
    /// (only a verified address gets mail and resets the password).
    email: Option<String>,
    email_verified: bool,
    /// W15: language of the account's mails.
    locale: String,
    /// W20 (B1): the subscription token and URL (the URL is null when no
    /// subscription/main domain is configured: the portal builds it from
    /// its own origin). Both null for admins, for the renewal scope (the
    /// subscription refuses those accounts), and for `sub_legacy`.
    sub_token: Option<String>,
    sub_url: Option<String>,
    /// W20: a link from before 0120 works but cannot be shown (hash only);
    /// resetting it gives a showable one. Never rotated implicitly.
    sub_legacy: bool,
    /// W20 (Minor 1): the effective latency-test interval (系统设置 >
    /// panel.toml), for the portal's node list.
    probe_interval_secs: u64,
}

/// GET /api/v1/me (renewal scope: also for expired users, R21).
///
/// W20: carries the subscription link for role=user accounts in good
/// standing (`sub::ensure_token`: decrypted from `users.sub_token_enc`; an
/// account without any token gets one here, audited `user.sub_token.issue`).
/// The response holds a credential: `Cache-Control: no-store`.
pub async fn me(
    State(state): State<AppState>,
    ShopUser {
        user,
        expired,
        quota_exhausted,
    }: ShopUser,
) -> Result<Response, ApiError> {
    let mut tx = state.pg().begin().await?;
    let row = sqlx::query_as::<_, MeRow>(
        "SELECT traffic_used_bytes, traffic_limit_bytes, expires_at, email, \
         email_verified_at IS NOT NULL AS email_verified, locale FROM users WHERE id = $1",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    let stored = if user.role == "user" && !expired && !quota_exhausted {
        crate::sub::ensure_token(&mut tx, state.totp(), &Actor::of(&user), user.id).await?
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
    let sub_url = sub_token
        .as_deref()
        .and_then(|t| settings.sub_url(state.route_prefix(), t));
    let view = MeView {
        id: user.id,
        login: user.login,
        role: user.role,
        traffic_used_bytes: row.traffic_used_bytes,
        traffic_limit_bytes: row.traffic_limit_bytes,
        expires_at: row.expires_at,
        expired,
        quota_exhausted,
        email: row.email,
        email_verified: row.email_verified,
        locale: row.locale,
        sub_token,
        sub_url,
        sub_legacy,
        probe_interval_secs: settings.probe.interval_secs,
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
            ))
        }
    }
    let actor = Actor::of(&admin);
    let stored = crate::sub::ensure_token(&mut tx, state.totp(), &actor, id)
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
    let sub_url = token
        .as_deref()
        .and_then(|t| state.settings().get().sub_url(state.route_prefix(), t));
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
    login: String,
    role: String,
    enabled: bool,
    traffic_limit_bytes: Option<i64>,
    traffic_used_bytes: i64,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    /// Active TOTP second factor (mandatory for admins).
    totp_enabled: bool,
    /// Why the account is disabled: admin | quota | expiry (null = enabled).
    disabled_reason: Option<String>,
    /// M3: the active plan (null = none) and the next traffic reset.
    plan_id: Option<Uuid>,
    plan_name: Option<String>,
    next_reset_at: Option<DateTime<Utc>>,
    /// W15: the account's address and whether it is verified.
    email: Option<String>,
    email_verified: bool,
}

/// UserView columns (alias `users` table as itself).
pub const USER_VIEW_COLS: &str =
    "id, login, role, enabled, traffic_limit_bytes, traffic_used_bytes, expires_at, created_at, \
     EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = users.id AND t.enabled_at IS NOT NULL) \
     AS totp_enabled, disabled_reason::text AS disabled_reason, \
     (SELECT up.plan_id FROM user_plans up WHERE up.user_id = users.id AND up.status = 'active') \
     AS plan_id, \
     (SELECT p.name FROM user_plans up JOIN plans p ON p.id = up.plan_id \
      WHERE up.user_id = users.id AND up.status = 'active') AS plan_name, \
     (SELECT up.next_reset_at FROM user_plans up \
      WHERE up.user_id = users.id AND up.status = 'active') AS next_reset_at, \
     email, email_verified_at IS NOT NULL AS email_verified";

/// `GET /users` query (W21, M3): page, search, filters and order.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct UserListQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// Prefix of the login or email (case-insensitive), or of the id.
    pub q: Option<String>,
    /// A plan id, or `none` (no active plan).
    pub plan_id: Option<String>,
    /// Derived status (the console's badge): active | expired | quota | disabled.
    pub status: Option<String>,
    /// user | admin.
    pub role: Option<String>,
    /// created (default) | -created | login | -traffic | expires.
    pub sort: Option<String>,
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
/// exclusive, in the badge's precedence: disabled (any reason but quota) >
/// over quota > expired (users only, `enforce::EXPIRED`) > active.
pub const STATUS_DISABLED: &str = "(NOT u.enabled AND u.disabled_reason IS DISTINCT FROM 'quota')";
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

fn push_user_filters(
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
        qb.push(" AND (lower(u.login) LIKE ")
            .push_bind(pat.clone())
            .push(" OR u.email LIKE ")
            .push_bind(pat.clone());
        // Ids only for a hex-ish prefix (no index on id::text: keep the
        // scan out of the common login/email search).
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
        Some("disabled") => {
            qb.push(" AND ").push(STATUS_DISABLED);
        }
        Some(_) => {
            return Err(bad_request!(
                "user.status_filter_invalid",
                "status must be active, expired, quota or disabled"
            ))
        }
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
            ))
        }
    }
    Ok(())
}

/// ORDER BY of a sort key (every order ends in the id: a total order, so
/// pages neither repeat nor skip rows).
fn user_order(sort: Option<&str>) -> Result<&'static str, ApiError> {
    Ok(match sort.unwrap_or("created") {
        "" | "created" => "u.created_at, u.id",
        "-created" => "u.created_at DESC, u.id DESC",
        "login" => "lower(u.login), u.id",
        "-traffic" => "u.traffic_used_bytes DESC, u.id",
        "expires" => "u.expires_at NULLS LAST, u.id",
        _ => {
            return Err(bad_request!(
                "user.sort_invalid",
                "sort must be created, -created, login, -traffic or expires"
            ))
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
    pub login: String,
    pub password: String,
    pub role: Option<String>,
    pub traffic_limit_bytes: Option<i64>,
    pub expires_at: Option<DateTime<Utc>>,
    /// W21: the account's email address, set as verified (the admin vouches
    /// for it: the user gets mail and can reset the password with it).
    pub email: Option<String>,
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
        return Err(bad_request!(
            "user.limit_negative",
            "traffic_limit_bytes must be >= 0"
        ));
    }
    if !valid_login(&req.login) {
        return Err(bad_request!(
            "user.login_invalid",
            "login must be 3-64 chars of [a-zA-Z0-9_.-]"
        ));
    }
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
    let email = match req
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        None => None,
        Some(e) => Some(
            crate::signup::email::parse(e)
                .ok_or_else(|| bad_request!("signup.invalid_email", "invalid email address"))?,
        ),
    };
    let hash = auth::hash_password(&req.password)?;
    let id = Uuid::new_v4();
    // Mint the subscription token now (W20: stored encrypted as well, so
    // the user and admins can see the link again).
    let sub_token = crate::sub::generate_token();
    let sub_enc = state.totp().seal_sub_token(id, &sub_token)?;
    let mut tx = state.pg().begin().await?;
    match sqlx::query_as::<_, UserView>(
        "INSERT INTO users (id, login, password_hash, role, traffic_limit_bytes, expires_at, \
         sub_token_hash, sub_token_enc, email, email_verified_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END) \
         RETURNING id, login, role, enabled, traffic_limit_bytes, traffic_used_bytes, expires_at, \
         created_at, false AS totp_enabled, disabled_reason::text AS disabled_reason, \
         NULL::uuid AS plan_id, NULL::text AS plan_name, NULL::timestamptz AS next_reset_at, \
         email, email_verified_at IS NOT NULL AS email_verified",
    )
    .bind(id)
    .bind(&req.login)
    .bind(&hash)
    .bind(role)
    .bind(req.traffic_limit_bytes)
    .bind(req.expires_at)
    .bind(crate::sub::hash_token(&sub_token))
    .bind(&sub_enc)
    .bind(&email)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(view) => {
            let after = json!({
                "login": view.login, "role": view.role, "enabled": view.enabled,
                "traffic_limit_bytes": view.traffic_limit_bytes, "expires_at": view.expires_at,
                "email": view.email,
                "password": crate::audit::CHANGED, "sub_token": crate::audit::CHANGED,
            });
            crate::audit::record(
                &mut tx,
                &Actor::of(&user),
                "user.create",
                "user",
                Some(view.id.to_string()),
                None,
                Some(after),
            )
            .await?;
            tx.commit().await?;
            Ok((
                axum::http::StatusCode::CREATED,
                Json(CreatedUser {
                    user: view,
                    sub_url: state
                        .settings()
                        .get()
                        .sub_url(state.route_prefix(), &sub_token),
                    sub_token,
                }),
            ))
        }
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            if db.constraint() == Some("users_email_verified") {
                Err(conflict!(
                    "user.email_exists",
                    "another account already uses this email address"
                ))
            } else {
                Err(conflict!("user.login_exists", "login already exists"))
            }
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
/// Audited ("user.update", exact before/after via RETURNING old/new).
async fn apply_update_user(
    conn: &mut PgConnection,
    actor: &Actor,
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
        return Err(bad_request!("request.no_fields", "no fields to update"));
    }
    if let Some(role) = &role {
        if role != "user" && role != "admin" {
            return Err(bad_request!(
                "user.role_invalid",
                "role must be 'user' or 'admin'"
            ));
        }
    }
    if let Some(pw) = &password {
        if pw.len() < 8 {
            return Err(bad_request!(
                "account.password_too_short",
                "password must be at least 8 characters"
            ));
        }
    }
    if let Some(Some(limit)) = req.traffic_limit_bytes {
        if limit < 0 {
            return Err(bad_request!(
                "user.limit_negative",
                "traffic_limit_bytes must be >= 0"
            ));
        }
    }
    // Enabled, role (expiry only applies to role=user) and expiry change
    // what nodes serve.
    let affects_nodes = enabled.is_some() || role.is_some() || req.expires_at.is_some();

    // M3: with an active plan, the traffic limit and expiry are the plan's
    // (written on every plan change; edit the user's plan instead), and the
    // account must stay a proxy user. Checked under the entitlement lock,
    // which every plan assignment takes, so the check cannot race one.
    let plan_managed = req.traffic_limit_bytes.is_some() || req.expires_at.is_some();
    if plan_managed || role.as_deref().is_some_and(|r| r != "user") {
        crate::entitle::lock(conn).await?;
        let has_plan: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM user_plans WHERE user_id = $1 AND status = 'active')",
        )
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
        if has_plan && plan_managed {
            return Err(conflict!(
                "user.plan_managed",
                "traffic_limit_bytes and expires_at are managed by the user's plan; \
                 change the plan (PUT/PATCH /users/{{id}}/plan) or cancel it first"
            ));
        }
        if has_plan {
            return Err(conflict!(
                "user.has_plan",
                "the user has an active plan; cancel it before making the account an admin"
            ));
        }
    }

    if affects_nodes {
        lock_user_nodes(conn, id).await?;
    }
    let mut qb = sqlx::QueryBuilder::new("UPDATE users SET ");
    let mut set = qb.separated(", ");
    if let Some(v) = enabled {
        set.push("enabled = ").push_bind_unseparated(v);
        // An explicit disable is an admin decision, even over a quota
        // disable (only 'quota' is ever re-enabled automatically).
        if !v {
            set.push("disabled_reason = 'admin'");
        }
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
    Ok(bump_user_nodes(conn, id).await?)
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
            auth::issue_token(&state, id, &role, sv, auth::Stage::Full)?,
            auth::Stage::Full,
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
async fn apply_delete_user(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<Vec<Uuid>, ApiError> {
    // Global lock order: entitlement lock first (a concurrent reconcile
    // holds it while locking nodes), then nodes, then the user row.
    crate::entitle::lock(conn).await?;
    lock_user_nodes(conn, id).await?;
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
    crate::audit::record(
        conn,
        actor,
        "user.delete",
        "user",
        Some(id.to_string()),
        Some(before),
        Some(json!({ "unassigned_nodes": nodes })),
    )
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
    apply_delete_user(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
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
    /// M6: platform of the connected agent and its latest rollout entry
    /// ({rollout_id, version, rollout_status, status, detail, superseded};
    /// W23: superseded = the rollout is over and the node enrolled again
    /// after its last step there (a reinstall): history, not its state).
    agent_os: Option<String>,
    agent_arch: Option<String>,
    update_status: Option<serde_json::Value>,
    config_version: i64,
    user_version: i64,
    xray_inbounds: serde_json::Value,
    /// Public hostname/IP clients dial for this node's inbounds; null until
    /// the admin sets it. Subscriptions skip accounts on such nodes.
    server_addr: Option<String>,
    /// M3: free-text region shown to users (portal node list).
    region: Option<String>,
    /// W10: the node's TLS domain (automatic certificate; null = the
    /// certificate files installed by hand), and the agent's source address
    /// as the panel saw it (the certificate status compares the domain's
    /// DNS with it). The certificate state itself is `heartbeat.cert`.
    tls_domain: Option<String>,
    agent_addr: Option<String>,
    /// The agent's last failed apply (e.g. xray rejected the inbounds) and
    /// the versions it was attempting; null once an update applies cleanly.
    last_error: Option<String>,
    last_error_at: Option<DateTime<Utc>>,
    failed_config_version: Option<i64>,
    failed_user_version: Option<i64>,
    /// Hello.protocol_version of the last connected agent; below the
    /// panel's minimum the node runs the empty state (see last_error).
    agent_protocol: Option<i32>,
    /// W12: Hello.capabilities of the last connected agent (sorted; null
    /// before any Hello recorded them).
    agent_capabilities: Option<Vec<String>>,
    /// When the agent's fail-closed lease runs out (renewed while the panel
    /// can read the node's desired state), and the seconds left.
    lease_expires_at: Option<DateTime<Utc>>,
    lease_remaining_seconds: Option<i64>,
    /// Per-node billing cap override (bytes/s); null = global default.
    traffic_max_rate_bytes_per_sec: Option<i64>,
    /// Set while the node is being deleted (it disappears once done).
    deleting_at: Option<DateTime<Utc>>,
    last_seen_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    /// M1-8: whether the agent holds a certificate (enrolled), when the
    /// newest one expires (null for a pre-M1c certificate until its agent
    /// next connects), and the expiry of a live (unused) enrollment token.
    enrolled: bool,
    cert_not_after: Option<DateTime<Utc>>,
    enroll_token_expires_at: Option<DateTime<Utc>>,
    /// Last heartbeat (Valkey, ~15 s cadence, 10 min TTL): cpu/mem,
    /// connections, uptime_seconds, lease_remaining_seconds, ts.
    /// Passed through as stored (validated JSON, not re-parsed into a
    /// `Value`: 200 blobs per node-list request, W14).
    #[sqlx(skip)]
    heartbeat: Option<Box<serde_json::value::RawValue>>,
    /// Problems with the stored configuration the admin must fix (e.g. an
    /// inbound using a transport the agent refuses for security reasons,
    /// stored before the check existed). Computed, not stored.
    #[sqlx(skip)]
    warnings: Vec<String>,
    /// W7: the node serves speed-limited users but its agent predates
    /// speed limits (protocol < 4): they run unthrottled. Only computed
    /// for such agents.
    #[serde(skip)]
    unenforced_speed_limits: bool,
    /// W11 (xboard-style form, `nodemeta.rs`): user-facing name (null =
    /// `name`), display order, shown to users, tags, multiplier (permille
    /// and as a number), per-inbound client-facing address/port, groups.
    display_name: Option<String>,
    sort: i32,
    visible: bool,
    tags: Vec<String>,
    traffic_rate_permille: i32,
    #[sqlx(skip)]
    traffic_rate: f64,
    connect_overrides: serde_json::Value,
    group_ids: Vec<Uuid>,
    /// W11: bytes accepted on this node (before the multiplier) and billed
    /// to users (after it), since the columns exist.
    traffic_raw_bytes: i64,
    traffic_billed_bytes: i64,
    /// W11 (`nodestat.rs`): online by the reaper's rule (status online,
    /// refreshed within 90 s), latest latency results, last "立即测速".
    online: bool,
    latency: serde_json::Value,
    probe_requested_at: Option<DateTime<Utc>>,
}

/// A certificate expiring within this many days is flagged (agents of
/// protocol >= 2 renew with a third of the validity left, i.e. 30 days at
/// the default 90; protocol 1 agents never renew).
const CERT_WARN_DAYS: i64 = 14;

impl NodeView {
    fn with_warnings(mut self) -> Self {
        self.traffic_rate = f64::from(self.traffic_rate_permille) / 1000.0;
        self.warnings = node_warnings(
            &self.xray_inbounds,
            self.tls_domain.as_deref(),
            self.agent_protocol,
            self.cert_not_after,
            self.unenforced_speed_limits,
            self.agent_capabilities.as_deref(),
        );
        self
    }
}

/// The node's `warnings` (full view and summary alike).
fn node_warnings(
    inbounds: &serde_json::Value,
    tls_domain: Option<&str>,
    agent_protocol: Option<i32>,
    cert_not_after: Option<DateTime<Utc>>,
    unenforced_speed_limits: bool,
    agent_capabilities: Option<&[String]>,
) -> Vec<String> {
    let mut w = inbound_warnings(inbounds);
    w.extend(tls_domain_warnings(tls_domain, inbounds, agent_protocol));
    if let Some(c) = cert_warning(cert_not_after, agent_protocol, Utc::now()) {
        w.push(c);
    }
    if let Some(u) = updater_warning(agent_protocol, agent_capabilities) {
        w.push(u);
    }
    if let Some(u) = stale_units_warning(agent_capabilities) {
        w.push(u);
    }
    if unenforced_speed_limits {
        w.push(format!(
            "agent 版本过旧，不支持限速（协议 < {}）：升级 agent 之前，套餐限速在此节点不生效",
            crate::grpc::SPEED_LIMIT_PROTOCOL
        ));
    }
    w
}

/// W17: one row of `GET /nodes?view=summary` — only what the node list
/// shows: no inbounds JSON, no full latency set, a slim heartbeat (the W14
/// list was 480 KB for 200 nodes). Fields that tick every second (lease
/// remaining) are left to the client (`lease_expires_at`), so the ETag
/// stays put between heartbeats.
#[derive(sqlx::FromRow, Serialize)]
pub struct NodeSummary {
    id: Uuid,
    name: String,
    display_name: Option<String>,
    enabled: bool,
    status: String,
    online: bool,
    deleting_at: Option<DateTime<Utc>>,
    region: Option<String>,
    server_addr: Option<String>,
    agent_version: Option<String>,
    agent_os: Option<String>,
    agent_arch: Option<String>,
    agent_protocol: Option<i32>,
    update_status: Option<serde_json::Value>,
    lease_expires_at: Option<DateTime<Utc>>,
    enrolled: bool,
    cert_not_after: Option<DateTime<Utc>>,
    enroll_token_expires_at: Option<DateTime<Utc>>,
    last_seen_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
    sort: i32,
    visible: bool,
    tags: Vec<String>,
    #[serde(skip)]
    traffic_rate_permille: i32,
    #[sqlx(skip)]
    traffic_rate: f64,
    /// The agent's best url-test result (first success in order, else the
    /// first result), as the list's latency badge shows it.
    latency: Option<serde_json::Value>,
    /// W17: alerts firing on this node.
    alerts_firing: i64,
    #[sqlx(skip)]
    warnings: Vec<String>,
    /// Some inbound needs the node's TLS certificate (install card hint).
    #[sqlx(skip)]
    needs_certificate: bool,
    #[sqlx(skip)]
    heartbeat: Option<HeartbeatSummary>,
    #[serde(skip)]
    xray_inbounds: serde_json::Value,
    #[serde(skip)]
    tls_domain: Option<String>,
    #[serde(skip)]
    unenforced_speed_limits: bool,
    /// W18: for the updater warning only.
    #[serde(skip)]
    agent_capabilities: Option<Vec<String>>,
}

/// The heartbeat fields the list shows.
#[derive(Deserialize, Serialize, Debug, PartialEq)]
pub struct HeartbeatSummary {
    // W23: null = the agent could not read it.
    #[serde(default)]
    cpu_percent: Option<f64>,
    #[serde(default)]
    mem_used_bytes: Option<u64>,
    #[serde(default)]
    mem_total_bytes: Option<u64>,
    connections: u64,
    #[serde(default)]
    uptime_seconds: Option<u64>,
    ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metrics: Option<HeartbeatMetricsSummary>,
}

#[derive(Deserialize, Serialize, Debug, PartialEq)]
pub struct HeartbeatMetricsSummary {
    #[serde(default)]
    net_rx_bytes_per_sec: Option<u64>,
    #[serde(default)]
    net_tx_bytes_per_sec: Option<u64>,
    online_users: u64,
}

pub const NODE_SUMMARY_COLS: &str = "nodes.id, name, display_name, enabled, status, \
     (nodes.status = 'online' AND nodes.last_seen_at > now() - interval '90 seconds') AS online, \
     deleting_at, region, server_addr, agent_version, agent_os, agent_arch, agent_protocol, \
     ro.update_status, lease_expires_at, cert_serial IS NOT NULL AS enrolled, cert_not_after, \
     enr.expires_at AS enroll_token_expires_at, last_seen_at, last_error, sort, visible, tags, \
     traffic_rate_permille, lb.latency, coalesce(al.n, 0) AS alerts_firing, xray_inbounds, \
     tls_domain, agent_capabilities, \
     CASE WHEN agent_protocol < 4 THEN EXISTS (SELECT 1 FROM node_users nu \
        JOIN user_plans up ON up.user_id = nu.user_id AND up.status = 'active' \
        JOIN plans p ON p.id = up.plan_id \
        WHERE nu.node_id = nodes.id AND p.speed_limit_mbps IS NOT NULL) \
        ELSE false END AS unenforced_speed_limits";

pub const NODE_SUMMARY_FROM: &str = "FROM nodes \
     LEFT JOIN node_enrollments enr ON enr.node_id = nodes.id \
        AND enr.used_at IS NULL AND enr.expires_at > now() \
     LEFT JOIN (SELECT DISTINCT ON (l.node_id) l.node_id, jsonb_build_object('source', l.source, \
        'target', l.target, 'delay_ms', l.delay_ms, 'error', l.error, \
        'measured_at', l.measured_at) AS latency \
        FROM node_latency l WHERE l.source = 'agent' \
        ORDER BY l.node_id, (l.delay_ms IS NULL), l.ord) lb ON lb.node_id = nodes.id \
     LEFT JOIN (SELECT node_id, count(*) AS n FROM node_alerts WHERE status = 'firing' \
        GROUP BY node_id) al ON al.node_id = nodes.id \
     LEFT JOIN (SELECT DISTINCT ON (rn.node_id) rn.node_id, jsonb_build_object( \
        'rollout_id', r.id, 'version', r.version, 'rollout_status', r.status, \
        'status', rn.status, 'detail', rn.detail, \
        'superseded', r.status NOT IN ('running','paused','halted') \
            AND coalesce(en.enrolled_at > greatest(r.created_at, rn.offered_at, \
                rn.finished_at), false)) AS update_status \
        FROM rollout_nodes rn JOIN rollouts r ON r.id = rn.rollout_id \
        JOIN nodes en ON en.id = rn.node_id \
        ORDER BY rn.node_id, r.created_at DESC) ro ON ro.node_id = nodes.id";

impl NodeSummary {
    fn finish(mut self, blob: Option<String>) -> Self {
        self.traffic_rate = f64::from(self.traffic_rate_permille) / 1000.0;
        self.warnings = node_warnings(
            &self.xray_inbounds,
            self.tls_domain.as_deref(),
            self.agent_protocol,
            self.cert_not_after,
            self.unenforced_speed_limits,
            self.agent_capabilities.as_deref(),
        );
        self.needs_certificate = crate::nodetpl::needs_certificate(&self.xray_inbounds);
        self.heartbeat = blob.and_then(|b| serde_json::from_str(&b).ok());
        self
    }
}

/// The summary rows with their slim heartbeats (one MGET; best effort).
pub async fn node_summaries(state: &AppState) -> Result<Vec<NodeSummary>, ApiError> {
    use fred::prelude::KeysInterface;
    let rows = sqlx::query_as::<_, NodeSummary>(sqlx::AssertSqlSafe(format!(
        "SELECT {NODE_SUMMARY_COLS} {NODE_SUMMARY_FROM} ORDER BY sort, nodes.created_at, nodes.id"
    )))
    .fetch_all(state.pg())
    .await?;
    if rows.is_empty() {
        return Ok(rows);
    }
    let keys: Vec<String> = rows
        .iter()
        .map(|v| format!("akari:node:hb:{}", v.id))
        .collect();
    let blobs = match state.valkey().mget::<Vec<Option<String>>, _>(keys).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, "heartbeat lookup failed");
            Vec::new()
        }
    };
    let mut blobs = blobs.into_iter();
    Ok(rows
        .into_iter()
        .map(|r| r.finish(blobs.next().flatten()))
        .collect())
}

/// A JSON body with a strong ETag (SHA-256 of the bytes, 128 bits): a
/// matching `If-None-Match` gets 304 without a body. `private, no-cache`:
/// the browser keeps the copy and revalidates every time (the console's
/// 5 s polling then costs a 304 while nothing changed).
pub fn json_with_etag(req: &HeaderMap, body: Vec<u8>) -> Response {
    use axum::http::{header, HeaderValue, StatusCode};
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

/// W18: agents that can be offered updates (protocol >= 3) but predate the
/// privileged updater try to execute the update from their state
/// directory, which systemd >= 256 mounts noexec ("permission denied").
/// One run of the install command (重装命令) installs the updater units and
/// the current agent.
fn updater_warning(protocol: Option<i32>, caps: Option<&[String]>) -> Option<String> {
    let p = protocol?;
    if p < 3 || caps.is_some_and(|c| c.iter().any(|c| c == "updater")) {
        return None;
    }
    Some(
        "agent 不支持新的自更新方式：在 systemd 257 及以上（如 Debian 13）的节点上自更新会失败\
         （permission denied）。请在节点上重新运行一次安装命令（重装命令），它会安装更新服务\
         akari-agent-update 并升级 agent"
            .to_string(),
    )
}

/// W23: the agent reports ("stale-units") that the node's installed
/// systemd units are not the ones its release carries: they were installed
/// by an installer or updater that predates unit refresh (or edited by
/// hand). Updates refresh them only once the updater's own unit allows it,
/// i.e. after one reinstall.
fn stale_units_warning(caps: Option<&[String]>) -> Option<String> {
    caps?.iter().any(|c| c == "stale-units").then(|| {
        "节点上的 systemd 单元文件（akari-agent.service / akari-agent-update.*）不是当前 agent \
         版本自带的版本（由旧版安装命令或旧版更新服务安装，或被手工修改），例如机器状态可能读不到。\
         请在节点上重新运行一次安装命令（重装命令），之后的自更新会一并更新单元文件；\
         自定义设置请用 drop-in（/etc/systemd/system/akari-agent.service.d/）"
            .to_string()
    })
}

/// W18: a node certificate the agent must obtain itself (节点域名 + an
/// inbound reading the certificate files) for an agent too old to do it
/// (protocol 1..6): such an agent ignores ConfigSnapshot.acme and fails the
/// WHOLE snapshot when the files are missing. Refused at write time.
fn acme_needs_newer_agent(
    domain: Option<&str>,
    inbounds: &serde_json::Value,
    protocol: Option<i32>,
) -> Option<i32> {
    let p = protocol.filter(|p| (1..crate::grpc::ACME_PROTOCOL).contains(p))?;
    (domain.is_some() && crate::nodetpl::needs_certificate(inbounds)).then_some(p)
}

async fn refuse_acme_for_old_agent(conn: &mut PgConnection, id: Uuid) -> Result<(), ApiError> {
    let row: Option<(Option<String>, serde_json::Value, Option<i32>)> =
        sqlx::query_as("SELECT tls_domain, xray_inbounds, agent_protocol FROM nodes WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((domain, inbounds, protocol)) = row else {
        return Ok(());
    };
    if let Some(p) = acme_needs_newer_agent(domain.as_deref(), &inbounds, protocol) {
        return Err(bad_request!(
            "node.acme_agent_too_old",
            "该节点的 agent 版本过旧（协议 {p} < {need}），不支持节点域名自动证书：它会忽略节点域名，并因缺少证书文件\
             导致整份配置下发失败。请先升级 agent（升级发布，或在节点上重新运行一次安装命令），\
             或清空节点域名并手动放置证书",
            p = p,
            need = crate::grpc::ACME_PROTOCOL
        ));
    }
    Ok(())
}

/// W10: what keeps the automatic certificate from working.
fn tls_domain_warnings(
    domain: Option<&str>,
    inbounds: &serde_json::Value,
    protocol: Option<i32>,
) -> Vec<String> {
    let Some(domain) = domain else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if !crate::nodetpl::needs_certificate(inbounds) {
        return out;
    }
    if protocol.is_some_and(|p| p < crate::grpc::ACME_PROTOCOL) {
        out.push(format!(
            "agent 版本过旧（协议 < {}）：不会自动申请 {domain} 的证书，且在缺少证书文件时整份配置下发失败。\
             请先升级 agent（升级发布，或在节点上重新运行一次安装命令），或手动放置 {domain} 的证书",
            crate::grpc::ACME_PROTOCOL
        ));
    }
    for i in inbounds.as_array().into_iter().flatten() {
        let uses_node_cert = i
            .pointer("/streamSettings/tlsSettings/certificates")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|c| {
                c.iter().any(|c| {
                    c.get("certificateFile").and_then(serde_json::Value::as_str)
                        == Some(crate::nodetpl::TLS_CERT_FILE)
                })
            });
        let sni = i
            .pointer("/streamSettings/tlsSettings/serverName")
            .and_then(serde_json::Value::as_str);
        if uses_node_cert && sni.is_some_and(|s| !s.eq_ignore_ascii_case(domain)) {
            out.push(format!(
                "入站 {:?}：serverName {:?} 不是节点域名 {domain}，自动证书只覆盖 {domain}",
                i.get("tag")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("?"),
                sni.unwrap_or_default()
            ));
        }
    }
    out
}

/// `YYYY-MM-DD HH:MM` in Beijing time (UTC+8, no DST): the console's
/// time zone (W21, M7), for server-written Chinese texts.
pub(crate) fn beijing_time(t: DateTime<Utc>) -> String {
    match chrono::FixedOffset::east_opt(8 * 3600) {
        Some(tz) => t.with_timezone(&tz).format("%Y-%m-%d %H:%M").to_string(),
        None => t.to_rfc3339(),
    }
}

fn cert_warning(
    not_after: Option<DateTime<Utc>>,
    protocol: Option<i32>,
    now: DateTime<Utc>,
) -> Option<String> {
    let left = not_after? - now;
    if left > chrono::Duration::days(CERT_WARN_DAYS) {
        return None;
    }
    let why = if protocol.unwrap_or(0) < 2 {
        "agent 版本过旧，不能续期（协议 < 2）：请升级 agent，或重新生成安装命令"
    } else {
        "agent 没有按时续期：请查看节点上的 agent 日志"
    };
    let at = beijing_time(not_after?);
    Some(if left <= chrono::Duration::zero() {
        format!("agent 证书已于 {at}（北京时间）过期；{why}")
    } else {
        format!(
            "agent 证书将在 {} 天后（{at}，北京时间）过期；{why}",
            left.num_days()
        )
    })
}

/// Attach the last heartbeat of each node (one MGET; best effort).
async fn with_heartbeats(state: &AppState, mut views: Vec<NodeView>) -> Vec<NodeView> {
    use fred::prelude::KeysInterface;
    if views.is_empty() {
        return views;
    }
    let keys: Vec<String> = views
        .iter()
        .map(|v| format!("akari:node:hb:{}", v.id))
        .collect();
    match state.valkey().mget::<Vec<Option<String>>, _>(keys).await {
        Ok(blobs) => {
            for (v, b) in views.iter_mut().zip(blobs) {
                v.heartbeat = b.and_then(|b| serde_json::value::RawValue::from_string(b).ok());
            }
        }
        Err(e) => tracing::warn!(error = %e, "heartbeat lookup failed"),
    }
    views
}

/// `SELECT {NODE_VIEW_COLS} {NODE_VIEW_FROM} ...`: the per-node extras
/// (enrollment, groups, latency, rollout) are joined from aggregates, not
/// correlated subqueries: for the 200-node list that is one pass over each
/// table instead of 200 probes per table (W14: 4.4 -> 2.6 ms, the list was
/// the slowest admin read under agent load).
pub const NODE_VIEW_COLS: &str =
    "nodes.id, name, enabled, status, agent_version, core_version, agent_os, agent_arch, \
     ro.update_status, config_version, \
     user_version, xray_inbounds, server_addr, region, tls_domain, host(agent_addr) AS agent_addr, last_error, last_error_at, failed_config_version, \
     failed_user_version, agent_protocol, agent_capabilities, lease_expires_at, \
     GREATEST(0, EXTRACT(EPOCH FROM lease_expires_at - now()))::bigint AS lease_remaining_seconds, \
     traffic_max_rate_bytes_per_sec, deleting_at, last_seen_at, nodes.created_at, \
     cert_serial IS NOT NULL AS enrolled, cert_not_after, \
     enr.expires_at AS enroll_token_expires_at, \
     CASE WHEN agent_protocol < 4 THEN EXISTS (SELECT 1 FROM node_users nu \
        JOIN user_plans up ON up.user_id = nu.user_id AND up.status = 'active' \
        JOIN plans p ON p.id = up.plan_id \
        WHERE nu.node_id = nodes.id AND p.speed_limit_mbps IS NOT NULL) \
        ELSE false END AS unenforced_speed_limits, \
     display_name, sort, visible, tags, traffic_rate_permille, connect_overrides, \
     coalesce(grp.group_ids, '{}') AS group_ids, traffic_raw_bytes, traffic_billed_bytes, \
     (nodes.status = 'online' AND nodes.last_seen_at > now() - interval '90 seconds') AS online, \
     coalesce(lat.latency, '[]'::jsonb) AS latency, probe_requested_at";

/// The FROM clause that goes with `NODE_VIEW_COLS` (filters on `nodes.`).
pub const NODE_VIEW_FROM: &str = "FROM nodes \
     LEFT JOIN node_enrollments enr ON enr.node_id = nodes.id \
        AND enr.used_at IS NULL AND enr.expires_at > now() \
     LEFT JOIN (SELECT node_id, array_agg(group_id ORDER BY group_id) AS group_ids \
        FROM node_group_members GROUP BY node_id) grp ON grp.node_id = nodes.id \
     LEFT JOIN (SELECT node_id, jsonb_agg(jsonb_build_object('source', l.source, \
        'target', l.target, 'delay_ms', l.delay_ms, 'error', l.error, \
        'measured_at', l.measured_at) ORDER BY l.source, l.ord) AS latency \
        FROM node_latency l GROUP BY node_id) lat ON lat.node_id = nodes.id \
     LEFT JOIN (SELECT DISTINCT ON (rn.node_id) rn.node_id, jsonb_build_object( \
        'rollout_id', r.id, 'version', r.version, 'rollout_status', r.status, \
        'status', rn.status, 'detail', rn.detail, \
        'superseded', r.status NOT IN ('running','paused','halted') \
            AND coalesce(en.enrolled_at > greatest(r.created_at, rn.offered_at, \
                rn.finished_at), false)) AS update_status \
        FROM rollout_nodes rn JOIN rollouts r ON r.id = rn.rollout_id \
        JOIN nodes en ON en.id = rn.node_id \
        ORDER BY rn.node_id, r.created_at DESC) ro ON ro.node_id = nodes.id";

#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct NodeListQuery {
    /// `summary` (W17: the list's columns only) or `full` (default).
    #[serde(default)]
    pub view: Option<String>,
}

/// GET /nodes[?view=summary|full] (admin), with an ETag (304 on a match).
pub async fn list_nodes(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<NodeListQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    user.require_admin()?;
    let body = match q.view.as_deref() {
        None | Some("full") => {
            let rows = sqlx::query_as::<_, NodeView>(sqlx::AssertSqlSafe(format!(
                "SELECT {NODE_VIEW_COLS} {NODE_VIEW_FROM} ORDER BY sort, nodes.created_at, nodes.id"
            )))
            .fetch_all(state.pg())
            .await?;
            let views = rows.into_iter().map(NodeView::with_warnings).collect();
            serde_json::to_vec(&with_heartbeats(&state, views).await)?
        }
        Some("summary") => serde_json::to_vec(&node_summaries(&state).await?)?,
        Some(_) => {
            return Err(bad_request!(
                "node.view_invalid",
                "view must be summary or full"
            ))
        }
    };
    Ok(json_with_etag(&headers, body))
}

/// GET /nodes/{id} (admin): one node, full view (the node page).
pub async fn get_node(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<NodeView>, ApiError> {
    user.require_admin()?;
    let row = sqlx::query_as::<_, NodeView>(sqlx::AssertSqlSafe(format!(
        "SELECT {NODE_VIEW_COLS} {NODE_VIEW_FROM} WHERE nodes.id = $1"
    )))
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    let mut views = with_heartbeats(&state, vec![row.with_warnings()]).await;
    views.pop().map(Json).ok_or_else(ApiError::not_found)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateNodeReq {
    pub name: String,
    /// R18-2 form fields (all optional; the CLI path sends only `name`).
    #[serde(default)]
    pub region: Option<String>,
    /// Public address clients dial (IP or domain).
    #[serde(default)]
    pub server_addr: Option<String>,
    /// W10: the node's TLS domain ("节点域名"): the agent obtains its
    /// certificate automatically; TLS templates default to it.
    #[serde(default)]
    pub tls_domain: Option<String>,
    /// Inbounds from templates (`nodetpl::InboundSpec`) ...
    #[serde(default)]
    pub templates: Option<Vec<crate::nodetpl::InboundSpec>>,
    /// ... or a raw xray inbounds array (not both).
    #[serde(default)]
    pub inbounds: Option<serde_json::Value>,
    /// Issue an install link (one-line installer) instead of a 24 h
    /// bootstrap token; same token either way.
    #[serde(default)]
    pub install: Option<crate::nodeinstall::InstallReq>,
    /// W11 form fields (see UpdateNodeReq).
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub sort: Option<i32>,
    #[serde(default)]
    pub visible: Option<bool>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub traffic_rate: Option<f64>,
    #[serde(default)]
    pub connect_overrides: Option<serde_json::Value>,
    #[serde(default)]
    pub group_ids: Option<Vec<Uuid>>,
}

/// The one-time enrollment material returned by create / enroll-token: the
/// token and the complete bootstrap file (shown once; only the token's
/// SHA-256 is stored).
#[derive(Serialize)]
pub struct EnrollmentView {
    id: Uuid,
    name: String,
    enrollment_token: String,
    expires_at: DateTime<Utc>,
    bootstrap: String,
    /// The one-line install command (R18-2), when requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    install: Option<crate::nodeinstall::InstallView>,
}

fn enrollment_view(
    state: &AppState,
    id: Uuid,
    name: String,
    token: String,
    expires_at: DateTime<Utc>,
    endpoint: &crate::settings::NodeEndpoint,
) -> EnrollmentView {
    let bootstrap = crate::enroll::bootstrap_toml(
        &name,
        &endpoint.panel_addr,
        &endpoint.server_name,
        &state.install().ca_pem,
        &token,
        expires_at,
    );
    EnrollmentView {
        id,
        name,
        enrollment_token: token,
        expires_at,
        bootstrap,
        install: None,
    }
}

/// POST /nodes (admin): create a node (pending) with a one-time enrollment
/// token (M1-8). R18-2: optionally region, public address and inbounds
/// (templates rendered server-side, or raw JSON — same validation as PUT
/// inbounds) in the same transaction, and an install link (`install`).
/// 201 with the token, bootstrap file and install command.
pub async fn create_node(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateNodeReq>,
) -> Result<(axum::http::StatusCode, Json<EnrollmentView>), ApiError> {
    user.require_admin()?;
    let tls_domain = match req.tls_domain.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => Some(crate::nodetpl::node_tls_domain(d)?),
        _ => None,
    };
    let inbounds = match (&req.templates, &req.inbounds) {
        (Some(_), Some(_)) => {
            return Err(bad_request!(
                "node.templates_and_inbounds",
                "give either templates or inbounds, not both"
            ))
        }
        (Some(t), None) => Some(serde_json::Value::Array(crate::nodetpl::render(
            t,
            &[],
            tls_domain.as_deref(),
        )?)),
        (None, Some(raw)) => Some(raw.clone()),
        (None, None) => None,
    };
    if let Some(i) = &inbounds {
        validate_inbounds(i)?;
    }
    let prepared = match &req.install {
        Some(r) => Some(crate::nodeinstall::prepare(&state, r).await?),
        None => None,
    };
    let actor = Actor::of(&user);
    let mut tx = state.pg().begin().await?;
    if inbounds.is_some() || req.group_ids.is_some() {
        // Lock order: the entitlement lock before any row (set_inbounds
        // and set_node_groups take it again; advisory xact locks nest).
        crate::entitle::lock(&mut tx).await?;
    }
    let (ttl, link) = match &prepared {
        Some(p) => (state.cfg().install.token_ttl_secs, Some(p.link())),
        None => (state.cfg().agent.enroll_token_ttl_secs, None),
    };
    let endpoint = crate::settings::node_endpoint(&mut tx, state.cfg()).await?;
    let (id, token, expires) =
        crate::enroll::apply_create_node(&mut tx, &actor, &req.name, ttl, link, &endpoint).await?;
    if let Some(i) = &inbounds {
        apply_set_inbounds(&mut tx, &actor, id, i).await?;
    }
    // The form fields in one update, after the inbounds (W11 connect
    // overrides name inbound tags).
    let w11 = UpdateNodeReq {
        server_addr: req.server_addr.clone().map(Some),
        region: req.region.clone().map(Some),
        display_name: req.display_name.clone().map(Some),
        sort: req.sort.map(Some),
        visible: req.visible.map(Some),
        tags: req.tags.clone().map(Some),
        traffic_rate: req.traffic_rate.map(Some),
        connect_overrides: req.connect_overrides.clone().map(Some),
        tls_domain: tls_domain.clone().map(Some),
        ..Default::default()
    };
    if w11.has_node_fields() {
        apply_update_node(&mut tx, &actor, id, &w11).await?;
    }
    if let Some(g) = &req.group_ids {
        crate::nodemeta::apply_set_node_groups(&mut tx, &actor, id, g).await?;
    }
    tx.commit().await?;
    let mut view = enrollment_view(
        &state,
        id,
        req.name.trim().to_string(),
        token.clone(),
        expires,
        &endpoint,
    );
    if let Some(p) = prepared {
        view.install = Some(crate::nodeinstall::view(&state, p, &token, expires).await?);
    }
    Ok((axum::http::StatusCode::CREATED, Json(view)))
}

/// POST /nodes/{id}/enroll-token (admin): a new one-time enrollment token
/// (replaces any unused one). Once the agent enrolls with it, the node's
/// previous certificates are revoked. 409 for a deleting node.
pub async fn issue_enroll_token(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<EnrollmentView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let endpoint = crate::settings::node_endpoint(&mut tx, state.cfg()).await?;
    let (token, expires) = crate::enroll::apply_issue_token(
        &mut tx,
        &Actor::of(&user),
        id,
        state.cfg().agent.enroll_token_ttl_secs,
        None,
        &endpoint,
    )
    .await?;
    let name: String = sqlx::query_scalar("SELECT name FROM nodes WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(enrollment_view(
        &state, id, name, token, expires, &endpoint,
    )))
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
    /// Per-node aggregate billing plausibility cap (bytes/s, > 0); null
    /// falls back to traffic.node_max_rate_bytes_per_sec.
    #[serde(default, deserialize_with = "double_option")]
    pub traffic_max_rate_bytes_per_sec: Option<Option<i64>>,
    /// M3: region shown to users; null (or "") clears it. <= 64 chars.
    #[serde(default, deserialize_with = "double_option")]
    pub region: Option<Option<String>>,
    /// W11 (`nodemeta.rs`): user-facing name; null (or "") = `name`.
    #[serde(default, deserialize_with = "double_option")]
    pub display_name: Option<Option<String>>,
    /// Display order (ascending).
    #[serde(default, deserialize_with = "double_option")]
    pub sort: Option<Option<i32>>,
    /// Shown to users (portal, subscription); hidden nodes keep serving.
    #[serde(default, deserialize_with = "double_option")]
    pub visible: Option<Option<bool>>,
    /// Labels ([] clears).
    #[serde(default, deserialize_with = "double_option")]
    pub tags: Option<Option<Vec<String>>>,
    /// Traffic multiplier 0..=100, at most 3 decimals (stored as permille).
    #[serde(default, deserialize_with = "double_option")]
    pub traffic_rate: Option<Option<f64>>,
    /// {"<inbound tag>": {"host", "port"}}; null or {} clears.
    #[serde(default, deserialize_with = "double_option")]
    pub connect_overrides: Option<Option<serde_json::Value>>,
    /// Node groups (the complete list; [] = none). Handled by
    /// `nodemeta::apply_set_node_groups`, not `apply_update_node`.
    #[serde(default, deserialize_with = "double_option")]
    pub group_ids: Option<Option<Vec<Uuid>>>,
    /// W10: the node's TLS domain (automatic certificate); null (or "")
    /// clears it (back to certificate files installed by hand). A change
    /// bumps config_version (the agent gets it with a Snapshot).
    #[serde(default, deserialize_with = "double_option")]
    pub tls_domain: Option<Option<String>>,
}

impl UpdateNodeReq {
    /// Any field `apply_update_node` writes (everything but group_ids).
    fn has_node_fields(&self) -> bool {
        self.enabled.is_some()
            || self.name.is_some()
            || self.server_addr.is_some()
            || self.traffic_max_rate_bytes_per_sec.is_some()
            || self.region.is_some()
            || self.display_name.is_some()
            || self.sort.is_some()
            || self.visible.is_some()
            || self.tags.is_some()
            || self.traffic_rate.is_some()
            || self.connect_overrides.is_some()
            || self.tls_domain.is_some()
    }
}

/// PATCH /nodes/{id}. Disabling AND enabling bump config_version (the
/// desired state of a disabled node is "no inbounds, no users"), so the
/// agent converges either way. Returns whether it bumped.
async fn apply_update_node(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &UpdateNodeReq,
) -> Result<bool, ApiError> {
    let enabled = non_null("enabled", &req.enabled)?;
    let name = non_null("name", &req.name)?;
    if !req.has_node_fields() {
        return Err(bad_request!("request.no_fields", "no fields to update"));
    }
    // W11 fields (validated before any row is touched).
    let display_name = req
        .display_name
        .as_ref()
        .map(|d| crate::nodemeta::display_name(d.as_deref()))
        .transpose()?;
    let sort = non_null("sort", &req.sort)?
        .map(crate::nodemeta::sort)
        .transpose()?;
    let visible = non_null("visible", &req.visible)?;
    let tags = non_null("tags", &req.tags)?
        .map(|t| crate::nodemeta::tags(&t))
        .transpose()?;
    let rate = non_null("traffic_rate", &req.traffic_rate)?
        .map(crate::nodemeta::rate_permille)
        .transpose()?;
    let tls_domain: Option<Option<String>> = match &req.tls_domain {
        None => None,
        Some(d) => Some(match d.as_deref().map(str::trim) {
            Some(d) if !d.is_empty() => Some(crate::nodetpl::node_tls_domain(d)?),
            _ => None,
        }),
    };
    if let Some(Some(r)) = req.traffic_max_rate_bytes_per_sec {
        if r <= 0 {
            return Err(bad_request!(
                "node.max_rate_invalid",
                "traffic_max_rate_bytes_per_sec must be > 0"
            ));
        }
    }
    let name = match name {
        Some(n) if n.trim().is_empty() => {
            return Err(bad_request!("node.name_empty", "name must not be empty"))
        }
        n => n.map(|n| n.trim().to_string()),
    };
    let region: Option<Option<String>> = req.region.as_ref().map(|r| {
        r.as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(String::from)
    });
    if region
        .as_ref()
        .is_some_and(|r| r.as_ref().is_some_and(|r| r.chars().count() > 64))
    {
        return Err(bad_request!(
            "node.region_long",
            "region must be at most 64 characters"
        ));
    }
    // "" and whitespace normalize to null (cleared).
    let server_addr: Option<Option<String>> = req.server_addr.as_ref().map(|a| {
        a.as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(String::from)
    });

    refuse_if_deleting(conn, id).await?;
    let (was_enabled, inbounds, was_domain): (bool, serde_json::Value, Option<String>) =
        sqlx::query_as("SELECT enabled, xray_inbounds, tls_domain FROM nodes WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;
    let overrides = match &req.connect_overrides {
        None => None,
        Some(None) => Some(json!({})),
        Some(Some(v)) => Some(crate::nodemeta::connect_overrides(v, &inbounds)?),
    };
    let toggles = enabled.is_some_and(|e| e != was_enabled);
    // The agent learns the domain from a Snapshot (ConfigSnapshot.acme).
    let domain_changes = tls_domain.as_ref().is_some_and(|d| *d != was_domain);

    let mut qb = sqlx::QueryBuilder::new("UPDATE nodes SET ");
    let mut set = qb.separated(", ");
    set.push("updated_at = now()");
    if let Some(v) = enabled {
        set.push("enabled = ").push_bind_unseparated(v);
    }
    if toggles || domain_changes {
        set.push("config_version = config_version + 1");
    }
    if let Some(v) = tls_domain {
        set.push("tls_domain = ").push_bind_unseparated(v);
    }
    if let Some(v) = name {
        set.push("name = ").push_bind_unseparated(v);
    }
    if let Some(v) = server_addr {
        set.push("server_addr = ").push_bind_unseparated(v);
    }
    if let Some(v) = req.traffic_max_rate_bytes_per_sec {
        set.push("traffic_max_rate_bytes_per_sec = ")
            .push_bind_unseparated(v);
    }
    if let Some(v) = region {
        set.push("region = ").push_bind_unseparated(v);
    }
    if let Some(v) = display_name {
        set.push("display_name = ").push_bind_unseparated(v);
    }
    if let Some(v) = sort {
        set.push("sort = ").push_bind_unseparated(v);
    }
    if let Some(v) = visible {
        set.push("visible = ").push_bind_unseparated(v);
    }
    if let Some(v) = tags {
        set.push("tags = ").push_bind_unseparated(v);
    }
    if let Some(v) = rate {
        set.push("traffic_rate_permille = ")
            .push_bind_unseparated(v);
    }
    if let Some(v) = overrides {
        set.push("connect_overrides = ").push_bind_unseparated(v);
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.push(format!(
        " RETURNING {}, {}",
        crate::audit::node_snapshot_sql("old"),
        crate::audit::node_snapshot_sql("new")
    ));
    let (before, after) = match qb
        .build_query_as::<(serde_json::Value, serde_json::Value)>()
        .fetch_one(&mut *conn)
        .await
    {
        Ok(r) => r,
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            return Err(conflict!("node.name_exists", "node name already exists"))
        }
        Err(e) => return Err(e.into()),
    };
    if domain_changes {
        refuse_acme_for_old_agent(conn, id).await?;
    }
    crate::audit::record(
        conn,
        actor,
        "node.update",
        "node",
        Some(id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(toggles || domain_changes)
}

pub async fn update_node(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<UpdateNodeReq>,
) -> Result<Json<NodeView>, ApiError> {
    user.require_admin()?;
    let actor = Actor::of(&user);
    let mut tx = state.pg().begin().await?;
    let groups = non_null("group_ids", &req.group_ids)?;
    if groups.is_some() {
        // Lock order: the entitlement lock before the node row.
        crate::entitle::lock(&mut tx).await?;
    } else if !req.has_node_fields() {
        return Err(bad_request!("request.no_fields", "no fields to update"));
    }
    if req.has_node_fields() {
        apply_update_node(&mut tx, &actor, id, &req).await?;
    }
    if let Some(g) = groups {
        crate::nodemeta::apply_set_node_groups(&mut tx, &actor, id, &g).await?;
    }
    tx.commit().await?;
    let row = sqlx::query_as::<_, NodeView>(sqlx::AssertSqlSafe(format!(
        "SELECT {NODE_VIEW_COLS} {NODE_VIEW_FROM} WHERE nodes.id = $1"
    )))
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    Ok(Json(row.with_warnings()))
}

/// Phase 1 of a node deletion (R12 D1), in the caller's transaction: lock
/// the node, mark it deleting and disable it. The first call bumps
/// config_version, so the agent (wherever it is connected) converges to
/// the empty state and acks it; its final counters are still billed
/// (node_users is untouched). Phase 2 (`crate::reaper`) revokes the
/// certificate and deletes the row. Idempotent. Returns whether this call
/// started the deletion.
pub(crate) async fn apply_begin_delete_node(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<bool, ApiError> {
    let deleting: Option<bool> =
        sqlx::query_scalar("SELECT deleting_at IS NOT NULL FROM nodes WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    match deleting {
        None => Err(ApiError::not_found()),
        Some(true) => Ok(false),
        Some(false) => {
            let before: serde_json::Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "UPDATE nodes SET deleting_at = now(), delete_acked_at = NULL, enabled = false, \
                 config_version = config_version + 1, updated_at = now() WHERE id = $1 \
                 RETURNING {}",
                crate::audit::node_snapshot_sql("old")
            )))
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;
            crate::audit::record(
                conn,
                actor,
                "node.delete",
                "node",
                Some(id.to_string()),
                Some(before),
                Some(json!({ "phase": "deleting" })),
            )
            .await?;
            Ok(true)
        }
    }
}

/// Mutations other than deletion are refused on a node being deleted (it
/// must stay disabled until phase 2 removes it). Locks the node row.
async fn refuse_if_deleting(conn: &mut PgConnection, id: Uuid) -> Result<(), ApiError> {
    let deleting: Option<bool> =
        sqlx::query_scalar("SELECT deleting_at IS NOT NULL FROM nodes WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    match deleting {
        None => Err(ApiError::not_found()),
        Some(true) => Err(conflict!("node.deleting", "node is being deleted")),
        Some(false) => Ok(()),
    }
}

/// DELETE /nodes/{id}: phase 1 (see `apply_begin_delete_node`). 202: the
/// row disappears once the agent acked the empty state (or after a
/// timeout, or at once if no agent is online), on any panel instance.
pub async fn delete_node(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let started = apply_begin_delete_node(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    if started {
        tracing::info!(node = %id, "node deletion started");
    }
    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(json!({ "id": id, "deleting": true })),
    ))
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
pub(crate) fn validate_inbounds(inbounds: &serde_json::Value) -> Result<(), ApiError> {
    let Some(items) = inbounds.as_array() else {
        return Err(bad_request!(
            "inbound.not_array",
            "inbounds must be an array"
        ));
    };
    let mut seen = HashSet::new();
    for item in items {
        let tag = match item.get("tag").and_then(|t| t.as_str()) {
            Some(tag) if !tag.is_empty() => tag,
            _ => {
                return Err(bad_request!(
                    "inbound.tag_missing",
                    "every inbound needs a non-empty tag"
                ))
            }
        };
        if reserved_tag(tag) {
            return Err(bad_request!(
                "inbound.tag_reserved",
                "inbound tag {tag:?} is reserved (api, akari-*, _*)",
                tag = tag
            ));
        }
        if !seen.insert(tag) {
            return Err(bad_request!(
                "inbound.tag_duplicate",
                "duplicate inbound tag {tag:?}",
                tag = tag
            ));
        }
        match item.get("protocol").and_then(|p| p.as_str()) {
            Some(p) if !p.is_empty() => {}
            _ => {
                return Err(bad_request!(
                    "inbound.protocol_missing",
                    "inbound {tag:?} needs a protocol",
                    tag = tag
                ))
            }
        }
        // The agent's gate dispatcher wraps a DefaultDispatcher without a
        // FakeDNS engine (R10 F4): fakedns sniffing would silently misroute.
        if mentions_fakedns(item) {
            return Err(bad_request!(
                "inbound.fakedns",
                "inbound {tag:?}: fakedns is not supported by the agent",
                tag = tag
            ));
        }
        // W8: protocol/transport matrix (protocols.rs). gRPC is allowed
        // again since R26 (agent grpc-go pinned past GO-2026-6443).
        if let Err(e) = crate::protocols::check_inbound(item) {
            return Err(bad_request!(
                "inbound.invalid",
                "inbound {tag:?}: {e}",
                tag = tag,
                e = e
            ));
        }
    }
    if let Some(e) = crate::protocols::port_clash(items) {
        return Err(bad_request!("inbound.port_clash", "{detail}", detail = e));
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

/// Warnings for stored inbounds (NodeView): configurations accepted before
/// a check existed stay as they are until an admin changes them; each
/// inbound that would now be refused is listed with the reason.
fn inbound_warnings(inbounds: &serde_json::Value) -> Vec<String> {
    let Some(items) = inbounds.as_array() else {
        return Vec::new();
    };
    let mut out: Vec<String> = items
        .iter()
        .filter_map(|i| {
            let tag = i.get("tag").and_then(|t| t.as_str()).unwrap_or("?");
            crate::protocols::check_inbound(i)
                .err()
                .map(|e| format!("入站 {tag:?}：{e}"))
        })
        .collect();
    out.extend(crate::protocols::port_clash(items));
    out
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

/// Accounts adjusted to their (current) inbounds (protocols::refit_account:
/// VLESS flow follows the inbound, a Shadowsocks key of the wrong length
/// is reissued).
pub(crate) fn refit_credentials(
    creds: Vec<Credential>,
    inbounds: &serde_json::Value,
) -> Vec<Credential> {
    creds
        .into_iter()
        .map(|mut c| {
            if let Some(a) = inbound_by_tag(inbounds, &c.inbound_tag)
                .and_then(|i| crate::protocols::refit_account(i, &c.account))
            {
                c.account = a;
            }
            c
        })
        .collect()
}

/// Replace a node's inbounds and, in the same transaction, drop credentials
/// that point at removed or re-protocoled inbounds (otherwise the agent's
/// AddUser fails on them); rows left empty are deleted. Returns the new
/// config_version (the snapshot it triggers carries the pruned users).
async fn apply_set_inbounds(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    inbounds: &serde_json::Value,
) -> Result<i64, ApiError> {
    validate_inbounds(inbounds)?;
    let protocols = inbound_protocols(inbounds);
    crate::entitle::lock(conn).await?;
    refuse_if_deleting(conn, id).await?;

    let updated: Option<(i64, serde_json::Value)> = sqlx::query_as(
        "UPDATE nodes SET xray_inbounds = $2, config_version = config_version + 1, updated_at = now(), \
         connect_overrides = (SELECT coalesce(jsonb_object_agg(o.key, o.value), '{}'::jsonb) \
             FROM jsonb_each(nodes.connect_overrides) o \
             WHERE o.key IN (SELECT i->>'tag' FROM jsonb_array_elements($2) i)) \
         WHERE id = $1 RETURNING new.config_version, old.xray_inbounds",
    )
    .bind(id)
    .bind(inbounds)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((version, old_inbounds)) = updated else {
        return Err(ApiError::not_found());
    };
    let mut pruned = Vec::new();

    // Manual rows are pruned here; plan rows by the reconcile below (which
    // also issues credentials for new eligible inbounds).
    let rows: Vec<(Uuid, serde_json::Value)> = sqlx::query_as(
        "SELECT user_id, credentials FROM node_users WHERE node_id = $1 AND manual \
         ORDER BY user_id FOR UPDATE",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    for (user_id, raw) in rows {
        let creds: Vec<Credential> = serde_json::from_value(raw)
            .map_err(|e| anyhow::anyhow!("corrupt credentials json: {e}"))?;
        let before = creds.clone();
        let kept = refit_credentials(prune_credentials(creds, &protocols), inbounds);
        if kept == before {
            continue;
        }
        pruned.push(user_id);
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
    refuse_acme_for_old_agent(conn, id).await?;
    let plan = crate::entitle::apply_reconcile(conn, crate::entitle::Scope::Nodes(&[id])).await?;
    let mut after = crate::audit::inbounds_summary(inbounds);
    after["pruned_credentials_of"] = json!(pruned);
    after["entitlement"] = plan.summary();
    crate::audit::record(
        conn,
        actor,
        "node.set_inbounds",
        "node",
        Some(id.to_string()),
        Some(crate::audit::inbounds_summary(&old_inbounds)),
        Some(after),
    )
    .await?;
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
    let version = apply_set_inbounds(&mut tx, &Actor::of(&user), id, &req.inbounds).await?;
    tx.commit().await?;
    Ok(Json(json!({ "config_version": version })))
}

// ---------------------------------------------------------------------------
// Account assignment: the panel generates and stores per-inbound credentials.
// ---------------------------------------------------------------------------

/// Regenerates a user's subscription token, invalidating the old one.
/// W20: stored encrypted as well (readable again via `GET /users/{id}/subscription`).
pub async fn regenerate_sub_token(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let token = crate::sub::rotate_token(&mut tx, state.totp(), &Actor::of(&user), id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    tx.commit().await?;
    let sub_url = state.settings().get().sub_url(state.route_prefix(), &token);
    Ok(Json(json!({ "sub_token": token, "sub_url": sub_url })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssignReq {
    pub inbound_tag: String,
    pub protocol: String,
}

#[derive(serde::Deserialize, serde::Serialize, Debug, PartialEq, Clone)]
pub(crate) struct Credential {
    pub(crate) inbound_tag: String,
    pub(crate) protocol: String,
    pub(crate) account: serde_json::Value,
}

/// A new account for `inbound` (protocols.rs: the inbound's protocol and
/// settings decide its shape).
pub(crate) fn generate_account(inbound: &serde_json::Value) -> Result<serde_json::Value, ApiError> {
    crate::protocols::generate_account(inbound)
        .map_err(|e| bad_request!("inbound.account_invalid", "{detail}", detail = e))
}

/// The inbound of `inbounds` tagged `tag`.
pub(crate) fn inbound_by_tag<'a>(
    inbounds: &'a serde_json::Value,
    tag: &str,
) -> Option<&'a serde_json::Value> {
    inbounds
        .as_array()?
        .iter()
        .find(|i| i.get("tag").and_then(|t| t.as_str()) == Some(tag))
}

fn is_fk_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.code().as_deref() == Some("23503"))
}

/// Read-modify-write of the user's credentials on one node; the row
/// becomes a manual override (M3: the plan reconcile never touches it, and
/// its plan-issued credentials for other inbounds are kept as they are).
/// The node row
/// lock serializes all assignments on that node (including first-time ones,
/// where there is no node_users row to lock) and the inbound protocol is
/// read under it. Returns the generated account.
async fn apply_assign(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
    node_id: Uuid,
    req: &AssignReq,
) -> Result<serde_json::Value, ApiError> {
    if !crate::protocols::MANAGED.contains(&req.protocol.as_str()) {
        return Err(bad_request!(
            "user.assign_protocol_invalid",
            "unsupported protocol {protocol:?} ({allowed})",
            protocol = req.protocol.clone(),
            allowed = crate::protocols::MANAGED.join(", ")
        ));
    }
    // M3: assignments take the entitlement lock like every node_users
    // writer that interacts with the reconcile (entitle.rs), before rows.
    crate::entitle::lock(conn).await?;
    refuse_if_deleting(conn, node_id).await?;
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
            return Err(bad_request!(
                "user.admin_not_assignable",
                "admin accounts are not proxy users and cannot be assigned to nodes"
            ))
        }
    }
    match inbound_protocols(&inbounds).get(&req.inbound_tag) {
        None => {
            return Err(bad_request!(
                "user.assign_inbound_missing",
                "inbound {tag:?} does not exist on this node",
                tag = req.inbound_tag.clone()
            ))
        }
        Some(p) if *p != req.protocol => {
            return Err(bad_request!(
                "user.assign_protocol_mismatch",
                "inbound {tag:?} is {actual}, not {protocol}",
                tag = req.inbound_tag.clone(),
                actual = p.clone(),
                protocol = req.protocol.clone()
            ))
        }
        Some(_) => {}
    }
    let account = generate_account(
        inbound_by_tag(&inbounds, &req.inbound_tag).unwrap_or(&serde_json::Value::Null),
    )?;

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
        "INSERT INTO node_users (node_id, user_id, credentials, manual) VALUES ($1, $2, $3, true) \
         ON CONFLICT (node_id, user_id) DO UPDATE SET credentials = EXCLUDED.credentials, manual = true",
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
    crate::audit::record(
        conn,
        actor,
        "node.assign",
        "assignment",
        Some(format!("{user_id}@{node_id}")),
        None,
        Some(json!({
            "user_id": user_id, "node_id": node_id, "inbound_tag": req.inbound_tag,
            "protocol": req.protocol, "account": crate::audit::CHANGED,
        })),
    )
    .await?;
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
    let account = apply_assign(&mut tx, &Actor::of(&user), user_id, node_id, &req).await?;
    tx.commit().await?;
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

/// Remove a manual assignment. M3: if the user's plan grants the node, the
/// pair is handed back to the plan instead (row kept, `manual = false`,
/// credentials normalized by the reconcile: those of still eligible
/// inbounds are kept, so clients keep working); otherwise the row is
/// deleted (departed). Plan-managed rows cannot be unassigned (409: change
/// the plan or its groups).
pub(crate) async fn apply_unassign(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
    node_id: Uuid,
) -> Result<(), ApiError> {
    crate::entitle::lock(conn).await?;
    let node: Option<i32> = sqlx::query_scalar("SELECT 1 FROM nodes WHERE id = $1 FOR UPDATE")
        .bind(node_id)
        .fetch_optional(&mut *conn)
        .await?;
    if node.is_none() {
        return Err(ApiError::not_found());
    }
    let manual: Option<bool> = sqlx::query_scalar(
        "SELECT manual FROM node_users WHERE node_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(node_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    match manual {
        None => return Err(ApiError::not_found()),
        Some(false) => {
            return Err(conflict!(
                "user.access_from_plan",
                "this access is granted by the user's plan; change the plan or its node groups"
            ))
        }
        Some(true) => {}
    }
    let to_plan = crate::entitle::is_granted(conn, user_id, node_id).await?;
    if to_plan {
        sqlx::query("UPDATE node_users SET manual = false WHERE node_id = $1 AND user_id = $2")
            .bind(node_id)
            .bind(user_id)
            .execute(&mut *conn)
            .await?;
        crate::entitle::apply_reconcile(
            conn,
            crate::entitle::Scope::Pairs {
                users: &[user_id],
                nodes: &[node_id],
            },
        )
        .await?;
    } else {
        sqlx::query("DELETE FROM node_users WHERE node_id = $1 AND user_id = $2")
            .bind(node_id)
            .bind(user_id)
            .execute(&mut *conn)
            .await?;
        record_departed(conn, node_id, user_id).await?;
    }
    // Always bump: either the row went away or (reconciled) its
    // credentials may have changed; a bump with an unchanged set is a
    // no-op delta.
    bump_node_users(conn, node_id).await?;
    crate::audit::record(
        conn,
        actor,
        "node.unassign",
        "assignment",
        Some(format!("{user_id}@{node_id}")),
        Some(json!({ "user_id": user_id, "node_id": node_id, "manual": true })),
        to_plan.then(|| json!({ "user_id": user_id, "node_id": node_id, "manual": false })),
    )
    .await?;
    Ok(())
}

/// The user still exists but no longer has this node: its final counters
/// (reported by the agent after the REMOVE) stay billable for the departed
/// grace (traffic::FLUSH_SQL). Not used for user deletion (nothing left to
/// bill; the row cascades away).
pub(crate) async fn record_departed(
    conn: &mut PgConnection,
    node_id: Uuid,
    user_id: Uuid,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO node_users_departed (node_id, user_id, departed_at) VALUES ($1, $2, now()) \
         ON CONFLICT (node_id, user_id) DO UPDATE SET departed_at = now(), billed_bytes = 0",
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
    apply_unassign(&mut tx, &Actor::of(&user), user_id, node_id).await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Second factor: admin reset (also `akari admin reset-2fa`).
// ---------------------------------------------------------------------------

/// Remove an account's TOTP (active or pending) and recovery codes and end
/// all its sessions, in the caller's transaction; audited
/// ("user.totp.reset"). The account then logs in with the password alone
/// (R18; with `auth.require_admin_2fa` an admin gets an enrollment-only
/// session). Returns what was removed ("active", "pending", "none").
pub(crate) async fn apply_reset_totp(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
) -> Result<&'static str, ApiError> {
    let found: Option<i32> = sqlx::query_scalar("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    if found.is_none() {
        return Err(ApiError::not_found());
    }
    let removed: Option<bool> = sqlx::query_scalar(
        "DELETE FROM user_totp WHERE user_id = $1 RETURNING enabled_at IS NOT NULL",
    )
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let codes = sqlx::query("DELETE FROM user_recovery_codes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    sqlx::query("UPDATE users SET session_ver = session_ver + 1 WHERE id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    let was = match removed {
        Some(true) => "active",
        Some(false) => "pending",
        None => "none",
    };
    let after = json!({ "totp": "none", "recovery_codes": 0 });
    crate::audit::record(
        conn,
        actor,
        "user.totp.reset",
        "user",
        Some(user_id.to_string()),
        Some(json!({ "totp": was, "recovery_codes": codes })),
        Some(after),
    )
    .await?;
    Ok(was)
}

/// DELETE /api/v1/users/{id}/totp (admin): reset the account's 2FA and end
/// its sessions (resetting your own ends this session too). 200 with
/// `{"totp": <what was removed: "active" | "pending" | "none">}`.
pub async fn reset_totp(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let was = apply_reset_totp(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(Json(json!({ "totp": was })))
}

/// Test hooks for other modules' tests (plans.rs).
#[cfg(test)]
pub(crate) async fn apply_assign_for_test(conn: &mut PgConnection, user: Uuid, node: Uuid) {
    apply_assign(
        conn,
        &Actor::test(),
        user,
        node,
        &AssignReq {
            inbound_tag: "in-vless".into(),
            protocol: "vless".into(),
        },
    )
    .await
    .unwrap_or_else(|e| panic!("assign: {}", e.message()));
}

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

    /// M1-8: a certificate within 14 days of expiry (or expired) is flagged,
    /// with the likely cause by agent protocol.
    #[test]
    fn cert_expiry_warning() {
        let now = Utc::now();
        let d = chrono::Duration::days;
        assert_eq!(cert_warning(None, Some(2), now), None, "unknown expiry");
        assert_eq!(cert_warning(Some(now + d(15)), Some(1), now), None);
        let w = cert_warning(Some(now + d(10)), Some(1), now).unwrap();
        assert!(
            w.contains("将在 9 天后") || w.contains("将在 10 天后"),
            "{w}"
        );
        assert!(w.contains("不能续期"), "{w}");
        let w = cert_warning(Some(now + d(3)), Some(2), now).unwrap();
        assert!(w.contains("没有按时续期"), "{w}");
        let w = cert_warning(Some(now - d(1)), None, now).unwrap();
        assert!(w.contains("已于") && w.contains("过期"), "{w}");
    }

    /// W10: an old agent or an inbound naming another SNI keeps the
    /// automatic certificate from working; said on the node.
    #[test]
    fn tls_domain_warnings_flag_old_agents_and_other_names() {
        let tls = |sni: &str| {
            json!([{"tag": "t", "streamSettings": {"security": "tls", "tlsSettings": {
                "serverName": sni,
                "certificates": [{"certificateFile": crate::nodetpl::TLS_CERT_FILE, "keyFile": crate::nodetpl::TLS_KEY_FILE}]}}}])
        };
        let d = Some("n1.example.com");
        assert!(tls_domain_warnings(None, &tls("x.example.com"), Some(5)).is_empty());
        assert!(tls_domain_warnings(d, &tls("n1.example.com"), Some(6)).is_empty());
        assert!(
            tls_domain_warnings(d, &tls("N1.example.com"), None).is_empty(),
            "not connected yet"
        );
        assert!(
            tls_domain_warnings(d, &json!([]), Some(1)).is_empty(),
            "no certificate needed"
        );
        let w = tls_domain_warnings(d, &tls("n1.example.com"), Some(5));
        assert!(w.len() == 1 && w[0].contains("版本过旧"), "{w:?}");
        let w = tls_domain_warnings(d, &tls("other.example.com"), Some(6));
        assert!(w.len() == 1 && w[0].contains("other.example.com"), "{w:?}");
    }

    /// W18: a node certificate the agent must obtain itself is refused for
    /// agents of protocol 1..6 (they would fail the whole snapshot); not
    /// connected yet (None) and protocol-0 agents (served the empty state)
    /// pass, as does a node without a TLS domain (certificates by hand).
    #[test]
    fn acme_inbounds_need_an_acme_agent() {
        let tls = json!([{"tag": "t", "streamSettings": {"security": "tls", "tlsSettings": {
            "certificates": [{"certificateFile": crate::nodetpl::TLS_CERT_FILE, "keyFile": crate::nodetpl::TLS_KEY_FILE}]}}}]);
        let d = Some("n1.example.com");
        assert_eq!(acme_needs_newer_agent(d, &tls, Some(5)), Some(5));
        assert_eq!(acme_needs_newer_agent(d, &tls, Some(1)), Some(1));
        assert_eq!(acme_needs_newer_agent(d, &tls, Some(6)), None);
        assert_eq!(acme_needs_newer_agent(d, &tls, None), None);
        assert_eq!(acme_needs_newer_agent(d, &tls, Some(0)), None);
        assert_eq!(acme_needs_newer_agent(None, &tls, Some(5)), None);
        assert_eq!(acme_needs_newer_agent(d, &json!([]), Some(5)), None);
    }

    /// W18: self-updatable agents without the "updater" capability fail on
    /// systemd >= 256 (noexec state directory): told on the node.
    #[test]
    fn updater_warning_for_pre_updater_agents() {
        let caps = |c: &[&str]| c.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let w = updater_warning(Some(6), Some(&caps(&["metrics", "latency"]))).unwrap();
        assert!(
            w.contains("重装命令") && w.contains("akari-agent-update"),
            "{w}"
        );
        assert!(
            updater_warning(Some(3), None).is_some(),
            "protocol 3, no capabilities"
        );
        assert!(updater_warning(Some(6), Some(&caps(&["metrics", "updater"]))).is_none());
        assert!(
            updater_warning(Some(2), None).is_none(),
            "never offered updates"
        );
        assert!(updater_warning(None, None).is_none(), "not connected yet");
    }

    /// W23: the agent says its node's systemd units are not its own.
    #[test]
    fn stale_units_warning_names_the_reinstall() {
        let caps = |c: &[&str]| c.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let w = stale_units_warning(Some(&caps(&["metrics", "stale-units"]))).unwrap();
        assert!(w.contains("重装命令") && w.contains("drop-in"), "{w}");
        assert!(stale_units_warning(Some(&caps(&["metrics", "updater"]))).is_none());
        assert!(stale_units_warning(None).is_none());
        let all = node_warnings(
            &serde_json::json!([]),
            None,
            Some(6),
            None,
            false,
            Some(&caps(&["updater", "stale-units"])),
        );
        assert_eq!(all.len(), 1, "{all:?}");
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
        let doomed = db.node().await;
        let ours = [n1, n2, other, doomed];
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
                    node_ids: None,
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
        let group_nodes = move |nodes: Vec<Uuid>| -> Op {
            let nodes = std::sync::Arc::new(nodes);
            Box::new(move |c| {
                let nodes = nodes.clone();
                Box::pin(async move {
                    crate::plans::apply_update_group(
                        c,
                        &crate::audit::Actor::test(),
                        group,
                        &crate::plans::UpdateGroupReq {
                            node_ids: Some(Some(nodes.to_vec())),
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
                            ..Default::default()
                        },
                    )
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
                            &crate::audit::Actor::test(),
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
                            &crate::audit::Actor::test(),
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
                            &crate::audit::Actor::test(),
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
                            &crate::audit::Actor::test(),
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
                "tls domain (W10: the agent gets it with a Snapshot)",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_update_node(
                            c,
                            &crate::audit::Actor::test(),
                            n1,
                            &UpdateNodeReq {
                                tls_domain: Some(Some("N1.Example.com".into())),
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
                "same tls domain (no-op)",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_update_node(
                            c,
                            &crate::audit::Actor::test(),
                            n1,
                            &UpdateNodeReq {
                                tls_domain: Some(Some("n1.example.com".into())),
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
                "clear tls domain",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_update_node(
                            c,
                            &crate::audit::Actor::test(),
                            n1,
                            &UpdateNodeReq {
                                tls_domain: Some(None),
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
                "set inbounds",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_set_inbounds(
                            c,
                            &crate::audit::Actor::test(),
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
                            &crate::audit::Actor::test(),
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
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_unassign(c, &crate::audit::Actor::test(), u, other).await
                    })
                }),
                vec![other],
                true,
            ),
            (
                "set user plan (empty group)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::plans::apply_set_user_plan(
                            c,
                            &crate::audit::Actor::test(),
                            u,
                            &crate::plans::SetUserPlanReq {
                                plan_id: plan,
                                expires_at: None,
                                period_anchor: None,
                                reset_traffic: None,
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1, n2, other],
                false,
            ),
            (
                "group gains node",
                group_nodes(vec![other]),
                vec![other],
                true,
            ),
            (
                "group gains a manually assigned node",
                group_nodes(vec![other, n1]),
                vec![n1],
                false,
            ),
            ("plan drops group", plan_groups(vec![]), vec![other], true),
            (
                "plan regains group",
                plan_groups(vec![group]),
                vec![other],
                true,
            ),
            (
                "node form: node joins a granted group (W11)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::nodemeta::apply_set_node_groups(
                            c,
                            &crate::audit::Actor::test(),
                            doomed,
                            &[group],
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![doomed],
                true,
            ),
            (
                "node form: same groups again (no-op)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::nodemeta::apply_set_node_groups(
                            c,
                            &crate::audit::Actor::test(),
                            doomed,
                            &[group],
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![doomed],
                false,
            ),
            (
                "node form: node leaves the group (W11)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::nodemeta::apply_set_node_groups(
                            c,
                            &crate::audit::Actor::test(),
                            doomed,
                            &[],
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![doomed],
                true,
            ),
            (
                "node display fields and multiplier (W11, no access change)",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_update_node(
                            c,
                            &crate::audit::Actor::test(),
                            n1,
                            &UpdateNodeReq {
                                display_name: Some(Some("香港 01".into())),
                                sort: Some(Some(3)),
                                visible: Some(Some(false)),
                                tags: Some(Some(vec!["IPLC".into()])),
                                traffic_rate: Some(Some(0.5)),
                                connect_overrides: Some(Some(
                                    json!({"in-vless": {"host": "relay.example.com", "port": 30443}}),
                                )),
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
                "node alert rules (W17, nothing the agent runs)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::alerts::apply_set_node_rules(
                            c,
                            &crate::audit::Actor::test(),
                            n1,
                            &crate::alerts::NodeRules {
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
                "plan speed limit (W7: travels in every user op)",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::plans::apply_update_plan(
                            c,
                            &crate::audit::Actor::test(),
                            plan,
                            &crate::plans::UpdatePlanReq {
                                speed_limit_mbps: Some(Some(50)),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1, n2, other],
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
                vec![n1, n2, other],
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
                vec![n1, n2, other],
                false,
            ),
            (
                "user plan expiry",
                Box::new(move |c| {
                    Box::pin(async move {
                        crate::plans::apply_update_user_plan(
                            c,
                            &crate::audit::Actor::test(),
                            u,
                            &crate::plans::UpdateUserPlanReq {
                                expires_at: Some(Some(Utc::now() + chrono::Duration::days(30))),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
                vec![n1, n2, other],
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
                // W7: the plan had a speed limit; the manual nodes n1/n2
                // now serve the user unlimited.
                vec![n1, n2, other],
                true,
            ),
            (
                "group change without subscribers",
                group_nodes(vec![]),
                vec![other, n1],
                false,
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
                vec![n1, n2, other],
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
                vec![n1, n2],
                true,
            ),
            (
                "begin node deletion",
                Box::new(move |c| {
                    Box::pin(async move {
                        apply_begin_delete_node(c, &crate::audit::Actor::test(), doomed)
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
                        apply_begin_delete_node(c, &crate::audit::Actor::test(), doomed)
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
            let want_rows = i64::from(name != "begin node deletion again (no-op)");
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
        sqlx::query("UPDATE nodes SET delete_acked_at = now() - interval '1 minute' WHERE id = $1")
            .bind(doomed)
            .execute(&db.pool)
            .await
            .unwrap();
        crate::testdb::drain(&mut listener, std::time::Duration::from_millis(20)).await;
        let mut tx = db.pool.begin().await.unwrap();
        assert!(crate::reaper::finalize_delete(&mut tx, doomed)
            .await
            .unwrap()
            .is_some());
        tx.commit().await.unwrap();
        assert_eq!(
            ours_notified(crate::testdb::drain(&mut listener, quiet).await),
            vec![format!("del:{doomed}")]
        );
        drop(listener); // holds a pool connection: close() would wait on it
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
            apply_update_user(&mut tx, &crate::audit::Actor::test(), u, &req)
                .await
                .ok()
                .unwrap(),
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
                let r = apply_assign(&mut tx, &crate::audit::Actor::test(), user, node, &req).await;
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
                    &crate::audit::Actor::test(),
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
            &mut tx, &crate::audit::Actor::test(),
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
                apply_assign(&mut tx, &crate::audit::Actor::test(), who, n, &req)
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
        apply_unassign(&mut tx, &crate::audit::Actor::test(), u, n)
            .await
            .ok()
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(departed(n, u).await, 1);
        let req = AssignReq {
            inbound_tag: "in-vless".into(),
            protocol: "vless".into(),
        };
        let mut tx = db.pool.begin().await.unwrap();
        apply_assign(&mut tx, &crate::audit::Actor::test(), u, n, &req)
            .await
            .ok()
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(departed(n, u).await, 0, "re-assign clears it");
        let mut tx = db.pool.begin().await.unwrap();
        apply_set_inbounds(
            &mut tx,
            &crate::audit::Actor::test(),
            n,
            &json!([{"tag": "other", "protocol": "trojan"}]),
        )
        .await
        .ok()
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(departed(n, u).await, 1, "pruned to nothing = departed");
        db.drop().await;
    }

    /// A node being deleted stays disabled: other node mutations are 409;
    /// the per-node rate override is validated.
    #[tokio::test]
    async fn deleting_node_refuses_mutations_and_rate_override_validated() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let mut tx = db.pool.begin().await.unwrap();
        let bad = apply_update_node(
            &mut tx,
            &crate::audit::Actor::test(),
            n,
            &UpdateNodeReq {
                traffic_max_rate_bytes_per_sec: Some(Some(0)),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(err_status(bad), StatusCode::BAD_REQUEST);
        tx.rollback().await.unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        apply_update_node(
            &mut tx,
            &crate::audit::Actor::test(),
            n,
            &UpdateNodeReq {
                traffic_max_rate_bytes_per_sec: Some(Some(1000)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(
            apply_begin_delete_node(&mut tx, &crate::audit::Actor::test(), n)
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
        let r = apply_set_inbounds(
            &mut tx,
            &crate::audit::Actor::test(),
            n,
            &json!([{"tag": "x", "protocol": "vless"}]),
        )
        .await;
        assert_eq!(err_status(r), StatusCode::CONFLICT);
        tx.rollback().await.unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        let req = AssignReq {
            inbound_tag: "in-vless".into(),
            protocol: "vless".into(),
        };
        assert_eq!(
            err_status(apply_assign(&mut tx, &crate::audit::Actor::test(), u, n, &req).await),
            StatusCode::CONFLICT
        );
        tx.rollback().await.unwrap();
        let (enabled, rate): (bool, Option<i64>) = sqlx::query_as(
            "SELECT enabled, traffic_max_rate_bytes_per_sec FROM nodes WHERE id = $1",
        )
        .bind(n)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!((enabled, rate), (false, Some(1000)));
        let mut tx = db.pool.begin().await.unwrap();
        assert_eq!(
            err_status(
                apply_begin_delete_node(&mut tx, &crate::audit::Actor::test(), Uuid::new_v4())
                    .await
            ),
            StatusCode::NOT_FOUND
        );
        tx.rollback().await.unwrap();
        db.drop().await;
    }

    #[test]
    fn fakedns_inbounds_rejected() {
        let one = |inb: serde_json::Value| validate_inbounds(&json!([inb]));
        for bad in [
            json!({"tag": "a", "protocol": "vless",
                "sniffing": {"enabled": true, "destOverride": ["http", "fakedns+others"]}}),
            json!({"tag": "a", "protocol": "vless", "sniffing": {"destOverride": ["FakeDNS"]}}),
            json!({"tag": "a", "protocol": "vless", "sniffing": {"destOverride": "http, fakedns"}}),
            json!({"tag": "a", "protocol": "vless", "Sniffing": {"DESTOVERRIDE": ["fakedns"]}}),
            // Go's json folds U+017F onto 's', xray lowercases U+212A to 'k'.
            json!({"tag": "a", "protocol": "vless", "\u{17f}niffing": {"de\u{17f}tOverride": ["fa\u{212a}edns"]}}),
            // Duplicate keys by case: whichever Go picks must be safe.
            json!({"tag": "a", "protocol": "vless", "sniffing": {"destOverride": ["http"]},
                "SNIFFING": {"destOverride": ["fakedns"]}}),
            json!({"tag": "a", "protocol": "fakedns"}),
        ] {
            assert!(one(bad.clone()).is_err(), "{bad}");
        }
        for ok in [
            json!({"tag": "a", "protocol": "vless",
                "sniffing": {"enabled": true, "destOverride": ["http", "tls"]}}),
            json!({"tag": "fakedns-in", "protocol": "vless"}),
            json!({"tag": "a", "protocol": "vless", "streamSettings": {"network": "ws",
                "wsSettings": {"path": "/fakedns"}, "tlsSettings": {"serverName": "fakedns.example"}}}),
            json!({"tag": "a", "protocol": "vless", "settings": {"fakedns": true},
                "sniffing": {"destOverride": ["fakednsx", "notfakedns"]}}),
        ] {
            assert!(one(ok.clone()).is_ok(), "{ok}");
        }
    }

    /// R26: the gRPC transport is accepted again (the agent pins a grpc-go
    /// past GO-2026-6443); W8: stored inbounds that the protocol matrix
    /// would now refuse are surfaced as NodeView warnings.
    #[test]
    fn grpc_transport_accepted_and_stored_problems_warned() {
        let one = |inb: serde_json::Value| validate_inbounds(&json!([inb]));
        for ok in [
            json!({"tag": "a", "protocol": "vless", "streamSettings": {"network": "grpc",
                "grpcSettings": {"serviceName": "svc"}}}),
            json!({"tag": "a", "protocol": "trojan", "streamSettings": {"network": "grpc", "security": "tls"}}),
            json!({"tag": "a", "protocol": "vless", "streamSettings": {"network": "grpc", "security": "reality"}}),
        ] {
            assert!(one(ok.clone()).is_ok(), "{ok}");
        }
        let e = one(
            json!({"tag": "a", "protocol": "vless", "settings": {"flow": "xtls-rprx-vision"},
            "streamSettings": {"network": "grpc", "security": "tls"}}),
        )
        .expect_err("vision over grpc");
        assert!(e.message().contains("inbound \"a\"") && e.message().contains("xtls-rprx-vision"));
        let stored = json!([
            {"tag": "ok", "protocol": "vless", "port": 443},
            {"tag": "old-kcp", "protocol": "vless", "port": 444, "streamSettings": {"network": "kcp"}},
            {"tag": "dup", "protocol": "vmess", "port": 443},
        ]);
        let w = inbound_warnings(&stored);
        assert_eq!(w.len(), 2, "{w:?}");
        assert!(w[0].contains("old-kcp") && w[0].contains("kcp"));
        assert!(w[1].contains("port 443"));
        assert!(inbound_warnings(&json!([{"tag": "a"}])).is_empty());
        assert!(inbound_warnings(&json!({"not": "an array"})).is_empty());
    }

    // ----- S4-2: session revocation and the last-admin guard ----------

    async fn token_for(state: &AppState, id: Uuid) -> String {
        let (role, sv): (String, i64) =
            sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
                .bind(id)
                .fetch_one(state.pg())
                .await
                .unwrap();
        auth::issue_token(state, id, &role, sv, auth::Stage::Full).unwrap()
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
            login: "a".into(),
            role: "admin".into(),
            ip: None,
        }
    }

    fn plain_user(id: Uuid) -> AuthUser {
        AuthUser {
            id,
            login: "u".into(),
            role: "user".into(),
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
        // u is promoted below: an admin's full session needs active 2FA.
        db.totp_active(u).await;
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
                upd(UpdateUserReq {
                    traffic_limit_bytes: Some(Some(1 << 40)),
                    ..Default::default()
                }),
                false,
            ),
            (
                "expiry change",
                upd(UpdateUserReq {
                    expires_at: Some(Some(Utc::now() + chrono::Duration::days(30))),
                    ..Default::default()
                }),
                false,
            ),
            (
                "billing update",
                sql("UPDATE users SET traffic_used_bytes = traffic_used_bytes + 1 WHERE id = $1"),
                false,
            ),
            (
                "enable (already enabled)",
                upd(UpdateUserReq {
                    enabled: Some(Some(true)),
                    ..Default::default()
                }),
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
            // Re-enabling must not revive the sessions the disable ended.
            (
                "API disable, then re-enable",
                Box::pin(async {
                    update(
                        &db,
                        u,
                        UpdateUserReq {
                            enabled: Some(Some(false)),
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap();
                    update(
                        &db,
                        u,
                        UpdateUserReq {
                            enabled: Some(Some(true)),
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap();
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
                login: "u".into(),
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

    /// GET /users/{id}/nodes: the account's node rows with inbound tags
    /// and manual/plan origin; never the credentials; 404 for no user.
    #[tokio::test]
    async fn user_nodes_lists_access_without_secrets() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let a = db.admin().await;
        let (n, u) = db.member().await;
        let state = AppState::for_test(db.pool.clone()).await;
        let Json(rows) = user_nodes(State(state.clone()), admin_user(a), Path(("p".into(), u)))
            .await
            .unwrap_or_else(|e| panic!("{}", e.message()));
        let v = serde_json::to_value(&rows).unwrap();
        assert_eq!(v.as_array().map(Vec::len), Some(1));
        assert_eq!(v[0]["node_id"], json!(n));
        assert_eq!(v[0]["manual"], true);
        assert_eq!(v[0]["deleting"], false);
        assert_eq!(
            v[0]["inbounds"],
            json!([{"tag": "in-vless", "protocol": "vless"}])
        );
        assert!(!v.to_string().contains("account"), "{v}");
        let e = user_nodes(
            State(state.clone()),
            admin_user(a),
            Path(("p".into(), Uuid::new_v4())),
        )
        .await
        .err()
        .map(|e| e.status());
        assert_eq!(e, Some(StatusCode::NOT_FOUND));
        let e = user_nodes(State(state.clone()), plain_user(u), Path(("p".into(), u)))
            .await
            .err()
            .map(|e| e.status());
        assert_eq!(e, Some(StatusCode::FORBIDDEN));
        drop(state);
        db.drop().await;
    }

    #[tokio::test]
    async fn last_enabled_admin_cannot_be_removed() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let a = db.admin().await;
        let conflict = |r: Result<(), ApiError>| {
            let e = r.expect_err("expected 409");
            assert_eq!(e.status(), StatusCode::CONFLICT);
            assert_eq!(e.message(), "cannot remove the last enabled admin");
        };
        conflict(
            update(
                &db,
                a,
                UpdateUserReq {
                    enabled: Some(Some(false)),
                    ..Default::default()
                },
            )
            .await,
        );
        conflict(
            update(
                &db,
                a,
                UpdateUserReq {
                    role: Some(Some("user".into())),
                    ..Default::default()
                },
            )
            .await,
        );
        let mut tx = db.pool.begin().await.unwrap();
        conflict(
            apply_delete_user(&mut tx, &crate::audit::Actor::test(), a)
                .await
                .map(|_| ()),
        );
        drop(tx);
        // Harmless changes to the last admin still work.
        update(
            &db,
            a,
            UpdateUserReq {
                password: Some(Some("new-password-1".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        update(
            &db,
            a,
            UpdateUserReq {
                enabled: Some(Some(true)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // With a second enabled admin either may go, but not both.
        let b = db.admin().await;
        update(
            &db,
            a,
            UpdateUserReq {
                enabled: Some(Some(false)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        conflict(
            update(
                &db,
                b,
                UpdateUserReq {
                    role: Some(Some("user".into())),
                    ..Default::default()
                },
            )
            .await,
        );
        // A disabled admin does not count and may be deleted.
        let mut tx = db.pool.begin().await.unwrap();
        apply_delete_user(&mut tx, &crate::audit::Actor::test(), a)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        // A newly promoted user makes room.
        let u = db.user().await;
        update(
            &db,
            u,
            UpdateUserReq {
                role: Some(Some("admin".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        apply_delete_user(&mut tx, &crate::audit::Actor::test(), b)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        // Direct SQL is guarded too (the trigger, not the handler).
        let e = sqlx::query("UPDATE users SET enabled = false WHERE role = 'admin'")
            .execute(&db.pool)
            .await
            .unwrap_err();
        assert_eq!(ApiError::from(e).status(), StatusCode::CONFLICT);
        let e = sqlx::query("DELETE FROM users")
            .execute(&db.pool)
            .await
            .unwrap_err();
        assert_eq!(ApiError::from(e).status(), StatusCode::CONFLICT);
        db.drop().await;
    }

    /// Two admins demoting each other at the same time: exactly one wins.
    #[tokio::test]
    async fn concurrent_mutual_demotion_leaves_one_admin() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        // Deterministic interleaving: T1 demotes b and holds its tx open;
        // T2 (demote a) must wait for it and then fail.
        let (a, b) = (db.admin().await, db.admin().await);
        let demote = UpdateUserReq {
            role: Some(Some("user".into())),
            ..Default::default()
        };
        let mut t1 = db.pool.begin().await.unwrap();
        apply_update_user(&mut t1, &crate::audit::Actor::test(), b, &demote)
            .await
            .unwrap();
        let pool = db.pool.clone();
        let t2 = tokio::spawn(async move {
            let mut t2 = pool.begin().await.unwrap();
            let r = apply_update_user(
                &mut t2,
                &crate::audit::Actor::test(),
                a,
                &UpdateUserReq {
                    role: Some(Some("user".into())),
                    ..Default::default()
                },
            )
            .await;
            match r {
                Ok(_) => t2.commit().await.map_err(ApiError::from),
                Err(e) => Err(e),
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!t2.is_finished(), "T2 must wait for T1's guard lock");
        t1.commit().await.unwrap();
        let e = t2.await.unwrap().expect_err("second demotion must fail");
        assert_eq!(e.status(), StatusCode::CONFLICT);

        // Free-running races, disable vs demote vs delete.
        for round in 0..15 {
            let (x, y) = (db.admin().await, db.admin().await);
            // Everyone else stops being an enabled admin (never the last:
            // x and y remain).
            sqlx::query("UPDATE users SET enabled = false WHERE role = 'admin' AND id <> ALL($1)")
                .bind(vec![x, y])
                .execute(&db.pool)
                .await
                .unwrap();
            let go = |id: Uuid, kind: usize| {
                let pool = db.pool.clone();
                tokio::spawn(async move {
                    let mut tx = pool.begin().await.unwrap();
                    let r = match kind % 3 {
                        0 => apply_update_user(
                            &mut tx,
                            &crate::audit::Actor::test(),
                            id,
                            &UpdateUserReq {
                                enabled: Some(Some(false)),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ()),
                        1 => apply_update_user(
                            &mut tx,
                            &crate::audit::Actor::test(),
                            id,
                            &UpdateUserReq {
                                role: Some(Some("user".into())),
                                ..Default::default()
                            },
                        )
                        .await
                        .map(|_| ()),
                        _ => apply_delete_user(&mut tx, &crate::audit::Actor::test(), id)
                            .await
                            .map(|_| ()),
                    };
                    match r {
                        Ok(()) => tx.commit().await.map_err(ApiError::from),
                        Err(e) => Err(e),
                    }
                })
            };
            let (r1, r2) = tokio::join!(go(x, round), go(y, round + 1));
            let (r1, r2) = (r1.unwrap(), r2.unwrap());
            assert!(r1.is_ok() != r2.is_ok(), "round {round}: exactly one wins");
            let left: i64 =
                sqlx::query_scalar("SELECT count(*) FROM users WHERE role = 'admin' AND enabled")
                    .fetch_one(&db.pool)
                    .await
                    .unwrap();
            assert_eq!(left, 1, "round {round}");
        }
        db.drop().await;
    }

    // ----- S4-1: login rate limit behind proxies ----------------------

    async fn account(db: &TestDb, password: &str) -> String {
        let login = format!("acct-{}", Uuid::new_v4().simple());
        sqlx::query("INSERT INTO users (id, login, password_hash) VALUES ($1, $2, $3)")
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
            ConnectInfo(SocketAddr::new(peer, 40000)),
            headers,
            CookieJar::new(),
            ApiJson(LoginReq {
                login: login.into(),
                password: password.into(),
                code: None,
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
            id: Some(Uuid::new_v4()),
            login: "boss".into(),
            ip: Some("2001:db8::7".parse().unwrap()),
        };
        let mut tx = db.pool.begin().await.unwrap();
        apply_update_user(
            &mut tx,
            &actor,
            u,
            &UpdateUserReq {
                enabled: Some(Some(false)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
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
        apply_begin_delete_node(&mut tx, &actor, n).await.unwrap();
        tx.commit().await.unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        let r = apply_set_inbounds(
            &mut tx,
            &actor,
            n,
            &json!([{"tag": "x", "protocol": "vless"}]),
        )
        .await;
        assert_eq!(err_status(r), StatusCode::CONFLICT);
        drop(tx);
        // Committed: who, from where, what, before/after.
        let mut tx = db.pool.begin().await.unwrap();
        apply_update_user(
            &mut tx,
            &actor,
            u,
            &UpdateUserReq {
                traffic_limit_bytes: Some(Some(42)),
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
            "SELECT actor_id, actor_login, ip, action, target_id, before, after FROM audit_log \
                 WHERE action = 'user.update'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(row.0, actor.id);
        assert_eq!(row.1, "boss");
        assert_eq!(row.2.as_deref(), Some("2001:db8::7"));
        assert_eq!(row.4, u.to_string());
        assert_eq!(row.5["traffic_limit_bytes"], serde_json::Value::Null);
        assert_eq!(row.6["traffic_limit_bytes"], 42);
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
                login: "redact-me".into(),
                password: "first-password-123".into(),
                role: None,
                traffic_limit_bytes: None,
                expires_at: None,
                email: None,
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
        let mut tx = db.pool.begin().await.unwrap();
        apply_set_inbounds(
            &mut tx,
            &Actor::of(&admin),
            n,
            &json!([{"tag": "in-vless", "protocol": "vless", "port": 443,
                "streamSettings": {"network": "tcp", "security": "reality",
                    "realitySettings": {"privateKey": "REALITY-PRIVATE-KEY", "shortIds": ["5eed"]}}}]),
        )
        .await
        .unwrap();
        let account = apply_assign(
            &mut tx,
            &Actor::of(&admin),
            u,
            n,
            &AssignReq {
                inbound_tag: "in-vless".into(),
                protocol: "vless".into(),
            },
        )
        .await
        .unwrap();
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
        let token = crate::sub::rotate_token(&mut tx, state.totp(), &Actor::of(&admin), u)
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
            "SELECT string_agg(concat_ws(' ', actor_login, action, target_id, before::text, after::text), ' ') \
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
            "node.set_inbounds",
            "node.assign",
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
        use crate::testdb::http::{rand_ip, Client};
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
        c.cookie = Some(auth::issue_token(&state, admin, "admin", sv, auth::Stage::Full).unwrap());
        let n1 = db.node().await;
        let n2 = db.node().await;
        sqlx::query(
            "INSERT INTO node_latency (node_id, source, target, delay_ms, error, ord, measured_at) \
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
        let key = format!("akari:node:hb:{n1}");
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
        for absent in [
            "xray_inbounds",
            "connect_overrides",
            "lease_remaining_seconds",
            "group_ids",
        ] {
            assert!(row.get(absent).is_none(), "{absent}");
        }
        assert_eq!(row["latency"]["delay_ms"], 87);
        assert_eq!(row["alerts_firing"], 0);
        assert_eq!(row["needs_certificate"], false);
        assert_eq!(row["traffic_rate"], 1.0);
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
        assert!(full.json()[0].get("xray_inbounds").is_some());
        assert!(full.body.len() > r.body.len());
        let one = c.get(&format!("/test/api/v1/nodes/{n1}")).await;
        assert_eq!(one.status, StatusCode::OK);
        let one = one.json();
        assert_eq!(one["heartbeat"]["metrics"]["xray_version"], "26.1");
        assert_eq!(one["latency"].as_array().unwrap().len(), 3);
        assert!(one.get("xray_inbounds").is_some());
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
            auth::issue_token(&state, u, "user", sv, auth::Stage::Full).unwrap()
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
