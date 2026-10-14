//! Registration with a passkey (needs `signup_settings.passkey_register`
//! and working passkeys; both steps are the canonical rejection otherwise).
//!
//! The account is created before its address is known:
//! 1. `POST /auth/register/passkey/options {pow, invite_code?, locale?,
//!    guard?}`: honeypot / Turnstile (`botguard`, the registration form's),
//!    the same proof of work and per-client limits as registration without
//!    verification, the invite code (required while 必须邀请码 is on), then
//!    a WebAuthn registration challenge for a fresh account id. Nothing is
//!    stored but the ceremony state (Valkey, single use).
//! 2. `POST /auth/register/passkey {state, credential, name?}`: verify the
//!    credential, then in one transaction create the account in the
//!    *pending* state (`users.email_pending`: the placeholder address
//!    `pending-<id>@pending.invalid`, no password, role user), store the
//!    passkey, consume the invite, optional trial, audit `user.register`
//!    (`signup_method: "passkey"`). The answer carries the session.
//!
//! A pending session reaches `GET /me` and the binding endpoints
//! (`profile::bind_*`, `auth::PendingUser`) only; everything else is 403
//! `account.email_required`. Binding the address ends the state (D1 holds:
//! the address stays unique and is the login name). Accounts still pending
//! after `PENDING_HOURS` are deleted (`super::purge_pending`).

use std::net::SocketAddr;

use axum::Json;
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::cookie::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;
use webauthn_rs::prelude::{PasskeyRegistration, RegisterPublicKeyCredential};

use super::register::{PowReq, bad_pow, grant_trial, spend_challenge, unavailable};
use super::{SignupSettings, invite, read_json};
use crate::audit::Actor;
use crate::auth::{self, ApiError, bad_request};
use crate::mail::Locale;
use crate::passkey::{Rp, put_state, take_state};
use crate::state::AppState;

/// A pending account is deleted after this long without a bound address.
pub const PENDING_HOURS: i64 = 24;

/// The placeholder address of a pending account (never a real mailbox:
/// `.invalid` is reserved; it is unverified, so nothing is ever mailed to
/// it, and the account id in it makes it unguessable).
pub fn pending_email(id: Uuid) -> String {
    format!("pending-{id}@pending.invalid")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptionsReq {
    pub pow: PowReq,
    #[serde(default)]
    pub invite_code: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    /// Honeypot / form token / Turnstile (`botguard`).
    #[serde(default)]
    pub guard: Option<crate::botguard::Guard>,
}

#[derive(Serialize, Deserialize)]
struct RegState {
    id: Uuid,
    rp_id: String,
    invite: Option<String>,
    locale: String,
    reg: PasskeyRegistration,
}

/// The settings when the feature is on (else the caller answers with the
/// canonical rejection).
async fn open(state: &AppState) -> Option<(SignupSettings, Rp)> {
    let s = super::settings_or_none(state)
        .await
        .filter(|s| s.register_enabled && s.passkey_register)?;
    Some((s, Rp::current(state)?))
}

/// POST /{prefix}/auth/register/passkey/options
pub async fn options(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let Some((s, rp)) = open(&state).await else {
        return Ok(crate::reject::not_found());
    };
    let req: OptionsReq = read_json(body).await?;
    let client = state.client_ip(peer.ip(), &headers);
    let bucket = crate::client_ip::bucket(client);
    // A trapped request gets the generic refusal.
    if crate::botguard::check_form(
        &state,
        crate::botguard::Form::Register,
        req.guard.as_ref(),
        client,
    )
    .await?
        == crate::botguard::Verdict::Trap
    {
        return Err(unavailable());
    }
    // Request-only checks first: proof of work, then the limits.
    super::pow::check(
        state.master_key(),
        &req.pow.challenge,
        &req.pow.nonce,
        chrono::Utc::now().timestamp(),
        super::pow::BITS,
    )
    .map_err(|_| bad_pow())?;
    super::limit_register_client(&state, &bucket).await?;
    if !spend_challenge(&state, &req.pow.challenge).await? {
        return Err(bad_pow());
    }
    let invite = admit_invite(&state, &s, req.invite_code.as_deref()).await?;
    let id = Uuid::new_v4();
    let label = format!("{}-{}", rp.name, &id.simple().to_string()[..8]);
    let (ccr, reg) = rp
        .webauthn()?
        .start_passkey_registration(id, &label, &label, None)
        .map_err(|e| {
            tracing::error!(error = %e, "passkey registration challenge");
            ApiError::internal()
        })?;
    let token = put_state(
        &state,
        "signup",
        &RegState {
            id,
            rp_id: rp.id.clone(),
            invite,
            locale: Locale::parse(req.locale.as_deref().unwrap_or("zh"))
                .as_str()
                .to_string(),
            reg,
        },
    )
    .await?;
    let mut options = serde_json::to_value(&ccr)?;
    crate::passkey::discoverable(&mut options);
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(json!({ "state": token, "options": options })),
    )
        .into_response())
}

/// The invite code of the request (lower case), checked against the
/// settings: required while 必须邀请码 is on, usable when given.
async fn admit_invite(
    state: &AppState,
    s: &SignupSettings,
    raw: Option<&str>,
) -> Result<Option<String>, ApiError> {
    let code = raw
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_ascii_lowercase);
    match &code {
        None if s.invite_required => Err(bad_request!(
            "signup.invite_required",
            "invite code required"
        )),
        None => Ok(None),
        Some(c) => {
            let mut conn = state.pg().acquire().await?;
            if !invite::usable(&mut conn, c, s).await? {
                return Err(bad_request!("signup.invalid_invite", "invalid invite code"));
            }
            Ok(code)
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinishReq {
    pub state: String,
    pub credential: RegisterPublicKeyCredential,
    #[serde(default)]
    pub name: Option<String>,
}

fn failed() -> ApiError {
    bad_request!(
        "account.passkey_failed",
        "the passkey could not be verified; try again"
    )
}

/// POST /{prefix}/auth/register/passkey {state, credential, name?} → the
/// new (pending) account's session.
pub async fn finish(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    body: Body,
) -> Result<Response, ApiError> {
    let Some((s, rp)) = open(&state).await else {
        return Ok(crate::reject::not_found());
    };
    let req: FinishReq = read_json(body).await?;
    let client = state.client_ip(peer.ip(), &headers);
    super::limit_complete(&state, &crate::client_ip::bucket(client)).await?;
    let st = take_state::<RegState>(&state, "signup", &req.state)
        .await?
        .filter(|st| st.rp_id == rp.id)
        .ok_or_else(failed)?;
    let passkey = rp
        .webauthn()?
        .finish_passkey_registration(&req.credential, &st.reg)
        .map_err(|e| {
            tracing::info!(error = %e, "passkey signup refused");
            failed()
        })?;
    let name = match req.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => crate::passkey::clean_name(n)?,
        None => "Passkey".to_string(),
    };
    let mut tx = state.pg().begin().await?;
    let r = apply_register_pending(&mut tx, &s, &rp, &st, &passkey, &name, client).await?;
    tx.commit().await?;
    let token = auth::issue_token(&state, r.id, "user", r.session_ver)?;
    let jar = jar.add(auth::session_cookie(&state, token));
    Ok((
        jar,
        Json(json!({
            "id": r.id, "role": "user", "expired": false, "quota_exhausted": false,
            "email_pending": true, "trial": r.trial.is_some(), "invited": r.inviter.is_some(),
        })),
    )
        .into_response())
}

struct Created {
    id: Uuid,
    session_ver: i64,
    inviter: Option<Uuid>,
    trial: Option<Uuid>,
}

/// The registration transaction body: (entitle::lock when a trial is
/// granted) → invite → the pending account → its passkey → audit → trial.
async fn apply_register_pending(
    conn: &mut sqlx::PgConnection,
    s: &SignupSettings,
    rp: &Rp,
    st: &RegState,
    passkey: &webauthn_rs::prelude::Passkey,
    name: &str,
    ip: std::net::IpAddr,
) -> Result<Created, ApiError> {
    if s.trial_plan_id.is_some() {
        crate::entitle::lock(conn).await?;
    }
    let inviter = match st.invite.as_deref() {
        None => None,
        Some(c) => Some(
            invite::consume(conn, c, s)
                .await?
                .ok_or_else(|| bad_request!("signup.invalid_invite", "invalid invite code"))?,
        ),
    };
    let id = st.id;
    let session_ver: i64 = sqlx::query_scalar(
        "INSERT INTO users (id, email, role, locale, inviter_id, signup_method, email_pending) \
         VALUES ($1, $2, 'user', $3, $4, 'passkey', true) RETURNING session_ver",
    )
    .bind(id)
    .bind(pending_email(id))
    .bind(&st.locale)
    .bind(inviter)
    .fetch_one(&mut *conn)
    .await?;
    let actor = Actor::account(id, Some(ip));
    crate::passkey::apply_add(conn, &actor, id, rp, passkey, name, false).await?;
    crate::audit::record(
        conn,
        &actor,
        "user.register",
        "user",
        Some(id.to_string()),
        None,
        Some(json!({
            "signup_method": "passkey", "email_pending": true, "inviter_id": inviter,
            "invite_code": st.invite.is_some(),
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
    Ok(Created {
        id,
        session_ver,
        inviter,
        trial,
    })
}

/// Delete the pending accounts older than `PENDING_HOURS` (any instance,
/// idempotent: the mail sender's housekeeping). Each in its own
/// transaction through the ordinary delete (`api::apply_delete_user`,
/// audited with actor `system`); one failing account does not stop the
/// rest.
pub async fn purge_pending(pg: &sqlx::PgPool) -> sqlx::Result<u64> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM users WHERE email_pending \
         AND created_at < now() - make_interval(hours => $1::int) ORDER BY created_at LIMIT 200",
    )
    .bind(PENDING_HOURS as i32)
    .fetch_all(pg)
    .await?;
    let mut n = 0;
    for id in ids {
        let mut tx = pg.begin().await?;
        match crate::api::apply_delete_user(&mut tx, &Actor::system(), id).await {
            Ok(_) => {
                tx.commit().await?;
                n += 1;
            }
            Err(e) => {
                tx.rollback().await?;
                tracing::warn!(user = %id, error = %e.message(), "pending account not purged");
            }
        }
    }
    Ok(n)
}
