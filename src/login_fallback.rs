//! Passkey-only fallback sign-in: password + a one-time code emailed to the
//! account's VERIFIED address, for an account whose password sign-in is
//! refused (`auth.passkey_required`) when passkeys are truly unusable (a
//! browser without related-origin support, the passkey centre unreachable).
//!
//! The server cannot verify "unsupported", so the client's word is not
//! enough: the code proves control of the verified mailbox on top of the
//! password.
//!
//! - `POST /auth/login/fallback/code {email, password}` (the login body):
//!   wrong credentials are the login's 401 (counted by the login rate
//!   limit, same work); only a correct password gets any other answer. A
//!   passkey-only account with a verified address and working mail gets a
//!   code (`email_codes` purpose `login_fallback`, HMAC-stored, 10 minutes,
//!   single use, 5 wrong tries, mail only through the outbox, per-client and
//!   per-address send limits); an account whose password still works is
//!   `auth.fallback_unneeded`; one without a verified address or with mail
//!   off is `auth.fallback_unavailable` (`akari admin reset-login` is the
//!   operator's way).
//! - `POST /auth/login {…, fallback_code}` (`api::login`): the sign-in
//!   itself. A wrong or used code is the login's 401 and counts as a failed
//!   attempt. A success writes the audit row `user.login.passkey_fallback`
//!   and queues a `security_notice` mail in the same transaction.

use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use uuid::Uuid;

use crate::api::{ApiJson, Checked, LoginReq, LoginRow};
use crate::audit::Actor;
use crate::auth::{ApiError, api_error, bad_request, conflict};
use crate::mail::templates::SecurityEvent;
use crate::mail::{Locale, Template};
use crate::signup::{self, CodeCheck};
use crate::state::AppState;

/// `email_codes.purpose` of the fallback codes.
pub const PURPOSE: &str = "login_fallback";

/// The account's verified sign-in address (a passkey registration's
/// placeholder is not one).
async fn verified_address(
    state: &AppState,
    user: Uuid,
) -> Result<Option<(String, String)>, ApiError> {
    Ok(sqlx::query_as(
        "SELECT email, locale FROM users \
         WHERE id = $1 AND email_verified_at IS NOT NULL AND NOT email_pending",
    )
    .bind(user)
    .fetch_optional(state.pg())
    .await?)
}

/// POST /auth/login/fallback/code
pub async fn request_code(
    State(state): State<AppState>,
    entry: crate::access::Entry,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ApiJson(req): ApiJson<LoginReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if req.email.is_empty() || req.password.is_empty() {
        return Err(bad_request!(
            "auth.credentials_required",
            "email and password are required"
        ));
    }
    let client = state.client_ip(addr.ip(), &headers);
    let email = req.email.trim().to_lowercase();
    let attempt = crate::login_limit::Attempt::reserve(&state, Some(client), &email)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "login rate limit unavailable");
            ApiError::internal()
        })?
        .ok_or_else(ApiError::too_many)?;
    // The sign-in's bot protection: this endpoint answers differently for a
    // right password, so unguarded it would test passwords.
    let attempt =
        crate::api::guard_password_form(&state, req.guard.as_ref(), &req.password, client, attempt)
            .await?;
    let row = match crate::api::check_credentials(&state, &email, &req.password).await {
        Ok(Checked::Ok(row)) => {
            // An admin's password at the root costs a slot like a wrong one
            // (see `api::login`).
            if entry.refuses(&row.role) {
                attempt.fail();
                return Err(ApiError::unauthorized());
            }
            attempt.release(&state).await;
            row
        }
        Ok(Checked::Failed(account)) => {
            crate::api::note_failed_login(&state, account, client, &attempt);
            attempt.fail();
            return Err(ApiError::unauthorized());
        }
        Err(e) => {
            attempt.release(&state).await;
            return Err(e);
        }
    };
    let policy = crate::passkey::login_policy(&state, row.id, &row.role).await?;
    if !policy.password_refused {
        return Err(bad_request!(
            "auth.fallback_unneeded",
            "this account can sign in with its password"
        ));
    }
    let unavailable = || {
        conflict!(
            "auth.fallback_unavailable",
            "this account has no verified email address (or mail sending is off): ask the site owner to reset its login method (akari admin reset-login)"
        )
    };
    let Some((address, locale)) = verified_address(&state, row.id).await? else {
        return Err(unavailable());
    };
    let mut tx = state.pg().begin().await?;
    let smtp = crate::mail::load(&mut tx).await?;
    if !smtp.enabled {
        return Err(unavailable());
    }
    signup::limit_send(&state, &crate::client_ip::bucket(client), &address).await?;
    let code = signup::issue_code(
        &mut tx,
        state.master_key(),
        PURPOSE,
        &row.id.to_string(),
        &address,
        Some(row.id),
    )
    .await?;
    crate::mail::enqueue(
        &mut tx,
        &smtp,
        &Template::LoginCode {
            code,
            minutes: signup::CODE_TTL_SECS / 60,
        },
        Locale::parse(&locale),
        &address,
        Some(row.id),
        Some(signup::CODE_TTL_SECS),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

/// Check and consume the fallback code of a passkey-only account whose
/// password was right. `Ok(true)` = the code was right: the audit row and
/// the notice mail are committed. `Ok(false)` = wrong, used, expired or
/// issued for another address (the failed try is committed, so five wrong
/// tries burn the code).
pub(crate) async fn consume(
    state: &AppState,
    row: &LoginRow,
    code: &str,
    client: IpAddr,
) -> Result<bool, ApiError> {
    let mut tx = state.pg().begin().await?;
    let checked = signup::check_code(
        &mut tx,
        state.master_key(),
        PURPOSE,
        &row.id.to_string(),
        code.trim(),
    )
    .await?;
    let verified: Option<String> = sqlx::query_scalar(
        "SELECT email FROM users \
         WHERE id = $1 AND email_verified_at IS NOT NULL AND NOT email_pending",
    )
    .bind(row.id)
    .fetch_optional(&mut *tx)
    .await?;
    let CodeCheck::Ok { email } = checked else {
        tx.commit().await?;
        return Ok(false);
    };
    if verified.as_deref() != Some(email.as_str()) {
        tx.commit().await?;
        return Ok(false);
    }
    crate::audit::record(
        &mut tx,
        &Actor::account(row.id, Some(client)),
        "user.login.passkey_fallback",
        "user",
        Some(row.id.to_string()),
        None,
        Some(json!({ "method": "password_email_code" })),
    )
    .await?;
    let portal = crate::mail::portal_url(state);
    crate::mailhook::security_notice(
        &mut tx,
        row.id,
        SecurityEvent::PasskeyFallbackLogin,
        Some(client),
        portal.as_deref(),
        None,
    )
    .await;
    tx.commit().await?;
    Ok(true)
}

/// The refusal an unconfirmed fallback attempt gets (the login's own 403).
pub fn passkey_required() -> ApiError {
    api_error!(
        FORBIDDEN,
        "auth.passkey_required",
        "this account signs in with a passkey"
    )
}
