//! Registration (W15): `POST /auth/register/code` (send a code; same answer
//! for every address) and `POST /auth/register` (code + password → account
//! + session). Both are the canonical rejection while registration is off.
//!
//! W24, registration WITHOUT email verification (注册需要邮箱验证 off, the
//! default while SMTP sending is off): `GET /auth/register/challenge` (a
//! proof-of-work challenge, `pow.rs`) and `POST /auth/register` with
//! `{email, password, pow: {challenge, nonce}, invite_code?}` → account
//! with an UNVERIFIED address (login = the address) + session. The code
//! endpoint is the canonical rejection in that mode, the challenge endpoint
//! in the verified mode. Residual oracle (inherent: a registration that
//! succeeds creates a loginable account): an address already taken (any
//! account's login or verified address) gets the one generic
//! `signup.unavailable`; enumeration is bounded by the proof of work and
//! the per-client / per-address limits (`limit_register`).

use crate::auth::bad_request;
use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::json;
use sqlx::{Connection, PgConnection};
use uuid::Uuid;

use super::{email, invite, read_json, CodeCheck, SignupSettings};
use crate::audit::Actor;
use crate::auth::{self, ApiError};
use crate::mail::{Locale, Template};
use crate::state::AppState;
use sha2::Digest as _;

pub const PURPOSE: &str = "register";
/// The one answer to a wrong, expired, used or raced code.
#[cfg(test)]
pub const INVALID_CODE: &str = "invalid or expired code";

/// The one answer to every failed code check (no oracle).
pub fn invalid_code() -> crate::auth::ApiError {
    crate::auth::bad_request!("signup.invalid_code", "invalid or expired code")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeReq {
    pub email: String,
    #[serde(default)]
    pub invite_code: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PowReq {
    pub challenge: String,
    pub nonce: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterReq {
    pub email: String,
    /// Verified mode only.
    #[serde(default)]
    pub code: Option<String>,
    pub password: String,
    /// Unverified mode only.
    #[serde(default)]
    pub pow: Option<PowReq>,
    #[serde(default)]
    pub invite_code: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
}

/// Address + invite checks shared by both steps (they depend only on the
/// request and the settings, never on whether an account exists).
async fn admit(
    state: &AppState,
    s: &SignupSettings,
    raw_email: &str,
    invite_code: Option<&str>,
) -> Result<(String, Option<String>), ApiError> {
    let addr = email::parse(raw_email)
        .ok_or_else(|| bad_request!("signup.invalid_email", "invalid email address"))?;
    if !email::domain_allowed(&addr, &s.email_domains) {
        return Err(bad_request!(
            "signup.domain_not_allowed",
            "email domain not allowed"
        ));
    }
    let invite = invite_code
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_ascii_lowercase);
    match &invite {
        None if s.invite_required => {
            return Err(bad_request!(
                "signup.invite_required",
                "invite code required"
            ))
        }
        None => {}
        Some(c) => {
            let mut conn = state.pg().acquire().await?;
            if !invite::usable(&mut conn, c, s.invite_single_use).await? {
                return Err(bad_request!("signup.invalid_invite", "invalid invite code"));
            }
        }
    }
    Ok((addr, invite))
}

/// POST /{prefix}/auth/register/code {email, invite_code?, locale?}
pub async fn request_code(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let Some((s, _)) = super::settings_with_mail(&state)
        .await
        .filter(|(s, mail)| s.register_enabled && s.verification_required(*mail))
    else {
        return Ok(crate::reject::not_found());
    };
    let req: CodeReq = read_json(body).await?;
    let (addr, _) = admit(&state, &s, &req.email, req.invite_code.as_deref()).await?;
    let client = state.client_ip(peer.ip(), &headers);
    super::limit_send(&state, &crate::client_ip::bucket(client), &addr).await?;
    let locale = Locale::parse(req.locale.as_deref().unwrap_or("zh"));
    // Everything that depends on the address having an account happens
    // after the response (no timing oracle).
    let st = state.clone();
    tokio::spawn(async move {
        if let Err(e) = send_code(&st, &addr, locale, s.reset_enabled).await {
            tracing::warn!(error = %e, "registration code not queued");
        }
    });
    Ok(super::ok_json(json!({ "ok": true })))
}

async fn send_code(
    state: &AppState,
    addr: &str,
    locale: Locale,
    reset_enabled: bool,
) -> anyhow::Result<()> {
    let mut tx = state.pg().begin().await?;
    let smtp = crate::mail::load(&mut tx).await?;
    if !smtp.enabled {
        tracing::warn!("registration code requested while mail sending is disabled");
        return Ok(());
    }
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM users WHERE login = $1 \
         OR (email = $1 AND email_verified_at IS NOT NULL))",
    )
    .bind(addr)
    .fetch_one(&mut *tx)
    .await?;
    if taken {
        let t = Template::RegisterExists {
            reset_enabled,
            login_url: crate::mail::portal_url(state),
        };
        crate::mail::enqueue(
            &mut tx,
            &smtp,
            &t,
            locale,
            addr,
            None,
            Some(super::CODE_TTL_SECS),
        )
        .await?;
    } else {
        let code = super::issue_code(&mut tx, state.totp(), PURPOSE, addr, addr, None).await?;
        let t = Template::RegisterCode {
            code,
            minutes: super::CODE_TTL_SECS / 60,
        };
        crate::mail::enqueue(
            &mut tx,
            &smtp,
            &t,
            locale,
            addr,
            None,
            Some(super::CODE_TTL_SECS),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// One registration attempt (validated request).
#[derive(Clone, Copy)]
pub struct Registration<'a> {
    /// Normalised address (`email::parse`).
    pub addr: &'a str,
    pub code: &'a str,
    pub password_hash: &'a str,
    /// Lower-case invite code.
    pub invite_code: Option<&'a str>,
    pub locale: Locale,
    pub ip: Option<std::net::IpAddr>,
}

/// What a completed registration created.
#[derive(Debug)]
pub struct Registered {
    pub id: Uuid,
    pub login: String,
    pub session_ver: i64,
    pub inviter: Option<Uuid>,
    pub trial: Option<Uuid>,
}

/// The registration transaction body: check + consume the code, consume
/// the invite, create the account (login = address, verified), audit, then
/// the optional trial plan under a savepoint. `Ok(None)` = invalid code
/// (the caller commits so the wrong attempt counts). Errors roll back.
pub async fn apply_register(
    conn: &mut PgConnection,
    keys: &crate::totp::Keys,
    s: &SignupSettings,
    r: &Registration<'_>,
) -> Result<Option<Registered>, ApiError> {
    let Registration {
        addr,
        code,
        password_hash,
        invite_code,
        locale,
        ip,
    } = *r;
    if s.trial_plan_id.is_some() {
        // The trial grant takes the entitlement lock; take it before any
        // row lock (global order: entitle::lock first).
        crate::entitle::lock(conn).await?;
    }
    super::lock_address(conn, addr).await?;
    if super::check_code(conn, keys, PURPOSE, addr, code).await?
        != (CodeCheck::Ok {
            email: addr.to_string(),
        })
    {
        return Ok(None);
    }
    let inviter = match invite_code {
        None => None,
        Some(c) => Some(
            invite::consume(conn, c, s.invite_single_use)
                .await?
                .ok_or_else(|| bad_request!("signup.invalid_invite", "invalid invite code"))?,
        ),
    };
    let id = Uuid::new_v4();
    let mut sp = conn.begin().await?;
    let inserted = sqlx::query_scalar::<_, i64>(
        "INSERT INTO users (id, login, password_hash, role, email, email_verified_at, locale, \
         inviter_id) VALUES ($1, $2, $3, 'user', $2, now(), $4, $5) RETURNING session_ver",
    )
    .bind(id)
    .bind(addr)
    .bind(password_hash)
    .bind(locale.as_str())
    .bind(inviter)
    .fetch_one(&mut *sp)
    .await;
    let session_ver = match inserted {
        Ok(v) => {
            sp.commit().await?;
            v
        }
        // The address (or a login equal to it) was taken after the code
        // was sent: the same answer as a wrong code.
        Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
            sp.rollback().await?;
            return Err(invalid_code());
        }
        Err(e) => return Err(e.into()),
    };
    let actor = Actor::account(id, addr, ip);
    crate::audit::record(
        conn,
        &actor,
        "user.register",
        "user",
        Some(id.to_string()),
        None,
        Some(json!({
            "login": addr, "email": addr, "inviter_id": inviter,
            "invite_code": invite_code.is_some(), "password": crate::audit::CHANGED,
        })),
    )
    .await?;
    let trial = match s.trial_plan_id {
        Some(plan_id) => grant_trial(conn, &actor, id, plan_id, s.trial_days).await?,
        None => None,
    };
    // The trial's plan sync writes the row; read the final session_ver.
    let session_ver: i64 = if trial.is_some() {
        sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *conn)
            .await?
    } else {
        session_ver
    };
    Ok(Some(Registered {
        id,
        login: addr.to_string(),
        session_ver,
        inviter,
        trial,
    }))
}

/// Give the new account the trial plan for `days` (savepoint: a disabled
/// or deleted plan only skips the trial, never the registration).
async fn grant_trial(
    conn: &mut PgConnection,
    actor: &Actor,
    user: Uuid,
    plan_id: Uuid,
    days: i32,
) -> Result<Option<Uuid>, ApiError> {
    let mut sp = conn.begin().await?;
    let expires_at: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT now() + make_interval(days => $1)")
            .bind(days)
            .fetch_one(&mut *sp)
            .await?;
    let req = crate::plans::SetUserPlanReq {
        plan_id,
        expires_at: Some(expires_at),
        period_anchor: None,
        reset_traffic: None,
    };
    match crate::plans::apply_set_user_plan(&mut sp, actor, user, &req).await {
        Ok(_) => {
            sp.commit().await?;
            Ok(Some(plan_id))
        }
        Err(e) => {
            sp.rollback().await?;
            tracing::warn!(error = %e.message(), "trial plan not granted");
            Ok(None)
        }
    }
}

/// The one answer to an address that cannot be registered without
/// verification (taken by any account's login or verified address, or a
/// race lost): no detail.
pub fn unavailable() -> ApiError {
    bad_request!(
        "signup.unavailable",
        "this email address cannot be registered"
    )
}

/// GET /{prefix}/auth/register/challenge → `{challenge, bits}` (W24;
/// registration without verification only, else the canonical rejection).
pub async fn challenge(State(state): State<AppState>) -> Response {
    let open = super::settings_with_mail(&state)
        .await
        .is_some_and(|(s, mail)| s.register_enabled && !s.verification_required(mail));
    if !open {
        return crate::reject::not_found();
    }
    let c = super::pow::issue(state.totp(), chrono::Utc::now().timestamp());
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(json!({ "challenge": c, "bits": super::pow::BITS })),
    )
        .into_response()
}

/// Single use of a solved challenge (all instances; fail closed).
async fn spend_challenge(state: &AppState, challenge: &str) -> Result<bool, ApiError> {
    use fred::prelude::*;
    let key = format!(
        "akari:pow:{}",
        hex::encode(sha2::Sha256::digest(challenge.as_bytes()))
    );
    let r: Option<String> = state
        .valkey()
        .set(
            key,
            "1",
            Some(Expiration::EX(super::pow::TTL_SECS + 120)),
            Some(SetOptions::NX),
            false,
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "proof-of-work store unavailable");
            ApiError::internal()
        })?;
    Ok(r.is_some())
}

fn bad_pow() -> ApiError {
    bad_request!(
        "signup.challenge_invalid",
        "the anti-bot check failed or expired; try again"
    )
}

/// An unverified registration (validated request).
#[derive(Clone, Copy)]
pub struct Unverified<'a> {
    pub addr: &'a str,
    pub password_hash: &'a str,
    pub invite_code: Option<&'a str>,
    pub locale: Locale,
    pub ip: Option<std::net::IpAddr>,
}

/// W24: create an account with an UNVERIFIED address, in the caller's
/// transaction: (entitle::lock when a trial is granted) → address lock →
/// taken check (any account's login or verified address = the generic
/// `unavailable`) → invite → insert (login = address; a unique violation is
/// the same answer) → audit → optional trial.
pub async fn apply_register_unverified(
    conn: &mut PgConnection,
    s: &SignupSettings,
    r: &Unverified<'_>,
) -> Result<Registered, ApiError> {
    let Unverified {
        addr,
        password_hash,
        invite_code,
        locale,
        ip,
    } = *r;
    if s.trial_plan_id.is_some() {
        crate::entitle::lock(conn).await?;
    }
    super::lock_address(conn, addr).await?;
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM users WHERE login = $1 \
         OR (email = $1 AND email_verified_at IS NOT NULL))",
    )
    .bind(addr)
    .fetch_one(&mut *conn)
    .await?;
    if taken {
        return Err(unavailable());
    }
    let inviter = match invite_code {
        None => None,
        Some(c) => Some(
            invite::consume(conn, c, s.invite_single_use)
                .await?
                .ok_or_else(|| bad_request!("signup.invalid_invite", "invalid invite code"))?,
        ),
    };
    let id = Uuid::new_v4();
    let mut sp = conn.begin().await?;
    let inserted = sqlx::query_scalar::<_, i64>(
        "INSERT INTO users (id, login, password_hash, role, email, email_verified_at, locale, \
         inviter_id) VALUES ($1, $2, $3, 'user', $2, NULL, $4, $5) RETURNING session_ver",
    )
    .bind(id)
    .bind(addr)
    .bind(password_hash)
    .bind(locale.as_str())
    .bind(inviter)
    .fetch_one(&mut *sp)
    .await;
    let session_ver = match inserted {
        Ok(v) => {
            sp.commit().await?;
            v
        }
        Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
            sp.rollback().await?;
            return Err(unavailable());
        }
        Err(e) => return Err(e.into()),
    };
    let actor = Actor::account(id, addr, ip);
    crate::audit::record(
        conn,
        &actor,
        "user.register",
        "user",
        Some(id.to_string()),
        None,
        Some(json!({
            "login": addr, "email": addr, "email_verified": false, "inviter_id": inviter,
            "invite_code": invite_code.is_some(), "password": crate::audit::CHANGED,
        })),
    )
    .await?;
    let trial = match s.trial_plan_id {
        Some(plan_id) => grant_trial(conn, &actor, id, plan_id, s.trial_days).await?,
        None => None,
    };
    let session_ver: i64 = if trial.is_some() {
        sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *conn)
            .await?
    } else {
        session_ver
    };
    Ok(Registered {
        id,
        login: addr.to_string(),
        session_ver,
        inviter,
        trial,
    })
}

/// POST /{prefix}/auth/register
/// verified mode: {email, code, password, invite_code?, locale?};
/// unverified mode (W24): {email, password, pow, invite_code?, locale?}
/// → the new account's session (like a login).
pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    body: Body,
) -> Result<Response, ApiError> {
    let Some((s, mail)) = super::settings_with_mail(&state)
        .await
        .filter(|(s, _)| s.register_enabled)
    else {
        return Ok(crate::reject::not_found());
    };
    let req: RegisterReq = read_json(body).await?;
    super::check_password(&req.password)?;
    let client = state.client_ip(peer.ip(), &headers);
    let bucket = crate::client_ip::bucket(client);
    let verify = s.verification_required(mail);
    let locale = Locale::parse(req.locale.as_deref().unwrap_or("zh"));
    let r = if verify {
        super::limit_complete(&state, &bucket).await?;
        let (addr, invite) = admit(&state, &s, &req.email, req.invite_code.as_deref()).await?;
        let code = req.code.as_deref().unwrap_or_default().trim().to_string();
        let hash = auth::hash_password(&req.password)?;
        let mut tx = state.pg().begin().await?;
        let done = apply_register(
            &mut tx,
            state.totp(),
            &s,
            &Registration {
                addr: &addr,
                code: &code,
                password_hash: &hash,
                invite_code: invite.as_deref(),
                locale,
                ip: Some(client),
            },
        )
        .await?;
        let Some(r) = done else {
            // Keep the counted attempt.
            tx.commit().await?;
            return Err(invalid_code());
        };
        tx.commit().await?;
        r
    } else {
        // Request-only checks first (no account lookup before the proof of
        // work and the limits).
        let addr = email::parse(&req.email)
            .ok_or_else(|| bad_request!("signup.invalid_email", "invalid email address"))?;
        let Some(pow) = &req.pow else {
            return Err(bad_pow());
        };
        super::pow::check(
            state.totp(),
            &pow.challenge,
            &pow.nonce,
            chrono::Utc::now().timestamp(),
            super::pow::BITS,
        )
        .map_err(|_| bad_pow())?;
        super::limit_register(&state, &bucket, &addr).await?;
        if !spend_challenge(&state, &pow.challenge).await? {
            return Err(bad_pow());
        }
        let (addr, invite) = admit(&state, &s, &addr, req.invite_code.as_deref()).await?;
        let hash = auth::hash_password(&req.password)?;
        let mut tx = state.pg().begin().await?;
        let r = apply_register_unverified(
            &mut tx,
            &s,
            &Unverified {
                addr: &addr,
                password_hash: &hash,
                invite_code: invite.as_deref(),
                locale,
                ip: Some(client),
            },
        )
        .await?;
        tx.commit().await?;
        r
    };
    let token = auth::issue_token(&state, r.id, "user", r.session_ver, auth::Stage::Full)?;
    let jar = jar.add(auth::session_cookie(&state, token, auth::Stage::Full));
    Ok((
        jar,
        Json(json!({
            "id": r.id, "login": r.login, "role": "user", "stage": "full",
            "expired": false, "quota_exhausted": false, "trial": r.trial.is_some(),
            "invited": r.inviter.is_some(), "email_verified": verify,
        })),
    )
        .into_response())
}
