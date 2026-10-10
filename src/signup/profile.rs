//! Portal account settings (W15): set/change the account's email address
//! (verified by an emailed code) and the language of its mails.
//!
//! `POST /me/email/code {email, password? | passkey?}`: moving to another
//! address needs the holder's confirmation (`passkey::confirm_holder`: the
//! current password, or a passkey; a passkey-only account must use a
//! passkey) — a stolen session must not be able to move the address that
//! password resets go to; a wrong password is 400 "invalid password" and
//! counts against the login rate limit like `/me/password`. Verifying the
//! account's own current (unverified) address needs no confirmation (it
//! moves nothing; already verified = 400 `account.email_unchanged`). The answer is the same
//! whether or not the address belongs to another account (the code mail is
//! only queued when it does not, after the response).
//! `POST /me/email/verify {code}`: sets `email` + `email_verified_at` (D1:
//! the address is the login name, so the account now logs in with the new
//! address). Verifying the CURRENT unverified
//! address of an account registered without verification is the same flow
//! (request a code for that address; the portal's verify dialog). Both use the renewal scope (`ShopUser`, like `/me/password`).

use crate::auth::{bad_request, conflict};
use axum::Json;
use axum::extract::State;
use serde::Deserialize;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use super::{CodeCheck, email};
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, ShopUser};
use crate::mail::{Locale, Template};
use crate::state::AppState;

pub const PURPOSE: &str = "change_email";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmailCodeReq {
    pub email: String,
    /// Moving to another address: the current password, unless a passkey
    /// confirms the holder.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub passkey: Option<crate::passkey::PasskeyProof>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyReq {
    pub code: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocaleReq {
    pub locale: String,
}

/// POST /api/v1/me/email/code
pub async fn request_email_change(
    State(state): State<AppState>,
    ShopUser { user, .. }: ShopUser,
    ApiJson(req): ApiJson<EmailCodeReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let addr = email::parse(&req.email)
        .ok_or_else(|| bad_request!("signup.invalid_email", "invalid email address"))?;
    {
        let mut c = state.pg().acquire().await?;
        if !crate::mail::load(&mut c).await?.enabled {
            return Err(conflict!("account.mail_off", "mail sending is not enabled"));
        }
    }
    // The current address (verifying it moves nothing): no confirmation.
    // Another address: the holder confirms (password or passkey).
    if addr == user.email {
        let verified: Option<bool> =
            sqlx::query_scalar("SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1")
                .bind(user.id)
                .fetch_optional(state.pg())
                .await?;
        if verified.ok_or_else(ApiError::unauthorized)? {
            return Err(bad_request!(
                "account.email_unchanged",
                "this is already the account's verified address"
            ));
        }
    } else {
        crate::passkey::confirm_holder(
            &state,
            &user,
            req.password.as_deref(),
            req.passkey.as_ref(),
        )
        .await?;
    }
    let bucket = user
        .ip
        .map(crate::client_ip::bucket)
        .unwrap_or_else(|| "unknown".into());
    super::limit_send(&state, &bucket, &addr).await?;
    let st = state.clone();
    let user_id = user.id;
    tokio::spawn(async move {
        let r = async {
            let mut tx = st.pg().begin().await?;
            apply_send_code(&mut tx, st.master_key(), user_id, &addr).await?;
            tx.commit().await?;
            anyhow::Ok(())
        };
        if let Err(e) = r.await {
            tracing::warn!(error = %e, "email verification code not queued");
        }
    });
    Ok(Json(json!({ "ok": true })))
}

/// Issue and queue the code unless the address is another account's.
/// Returns whether a mail was queued.
pub async fn apply_send_code(
    conn: &mut PgConnection,
    keys: &crate::masterkey::Keys,
    user: Uuid,
    addr: &str,
) -> anyhow::Result<bool> {
    let smtp = crate::mail::load(conn).await?;
    if !smtp.enabled {
        return Ok(false);
    }
    let row: Option<(String, bool)> = sqlx::query_as(
        "SELECT u.locale, EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND o.email = $2) \
         FROM users u WHERE u.id = $1",
    )
    .bind(user)
    .bind(addr)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((locale, taken)) = row else {
        return Ok(false);
    };
    if taken {
        return Ok(false);
    }
    let code = super::issue_code(conn, keys, PURPOSE, &user.to_string(), addr, Some(user)).await?;
    let t = Template::EmailCode {
        code,
        minutes: super::CODE_TTL_SECS / 60,
    };
    crate::mail::enqueue(
        conn,
        &smtp,
        &t,
        Locale::parse(&locale),
        addr,
        Some(user),
        Some(super::CODE_TTL_SECS),
    )
    .await?;
    Ok(true)
}

/// Check the code and move the account to the verified address, in the
/// caller's transaction. `Ok(None)` = invalid code (commit to keep the
/// counted attempt); an address another account took in between is the
/// same 400 as a wrong code.
pub async fn apply_verify(
    conn: &mut PgConnection,
    keys: &crate::masterkey::Keys,
    actor: &Actor,
    user: Uuid,
    code: &str,
) -> Result<Option<String>, ApiError> {
    let CodeCheck::Ok { email: addr } =
        super::check_code(conn, keys, PURPOSE, &user.to_string(), code).await?
    else {
        return Ok(None);
    };
    // Serialize with registrations of the same address (a registration
    // without verification may take it meanwhile: the unique violation
    // below is then the answer).
    super::lock_address(conn, &addr).await?;
    let before: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user)
        .fetch_optional(&mut *conn)
        .await?;
    let mut sp = sqlx::Connection::begin(&mut *conn).await?;
    let r = sqlx::query("UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1")
        .bind(user)
        .bind(&addr)
        .execute(&mut *sp)
        .await;
    match r {
        Ok(_) => sp.commit().await?,
        Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
            sp.rollback().await?;
            return Err(super::register::invalid_code());
        }
        Err(e) => return Err(e.into()),
    }
    sqlx::query("DELETE FROM password_resets WHERE user_id = $1")
        .bind(user)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "user.email.change",
        "user",
        Some(user.to_string()),
        Some(json!({ "email": before })),
        Some(json!({ "email": addr, "verified": true })),
    )
    .await?;
    Ok(Some(addr))
}

/// POST /api/v1/me/email/verify
pub async fn verify_email_change(
    State(state): State<AppState>,
    ShopUser { user, .. }: ShopUser,
    ApiJson(req): ApiJson<VerifyReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let bucket = user
        .ip
        .map(crate::client_ip::bucket)
        .unwrap_or_else(|| "unknown".into());
    super::limit_complete(&state, &bucket).await?;
    let mut tx = state.pg().begin().await?;
    let done = apply_verify(
        &mut tx,
        state.master_key(),
        &Actor::of(&user),
        user.id,
        req.code.trim(),
    )
    .await?;
    tx.commit().await?;
    match done {
        Some(addr) => Ok(Json(json!({ "email": addr, "email_verified": true }))),
        None => Err(super::register::invalid_code()),
    }
}

/// PUT /api/v1/me/locale {locale: "zh"|"en"}: the language of the
/// account's mails (the portal sends it when the visitor switches).
pub async fn set_locale(
    State(state): State<AppState>,
    ShopUser { user, .. }: ShopUser,
    ApiJson(req): ApiJson<LocaleReq>,
) -> Result<axum::http::StatusCode, ApiError> {
    if req.locale != "zh" && req.locale != "en" {
        return Err(bad_request!(
            "account.locale_invalid",
            "locale must be zh or en"
        ));
    }
    sqlx::query("UPDATE users SET locale = $2 WHERE id = $1 AND locale <> $2")
        .bind(user.id)
        .bind(&req.locale)
        .execute(state.pg())
        .await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// W24: an admin marks the account's current address verified (the admin
/// vouches for it, like `POST /users`). In the caller's transaction:
/// conditional UPDATE → audit `user.email.verify`. Idempotent. (D1: the
/// address is unique for every account, verified or not.)
pub async fn apply_admin_verify(
    conn: &mut PgConnection,
    actor: &Actor,
    user: Uuid,
) -> Result<String, ApiError> {
    crate::owner::guard_target(conn, actor, user).await?;
    let row: Option<(String, bool)> = sqlx::query_as(
        "UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) \
         WHERE id = $1 RETURNING new.email, old.email_verified_at IS NULL",
    )
    .bind(user)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((addr, changed)) = row else {
        return Err(ApiError::not_found());
    };
    if changed {
        crate::audit::record(
            conn,
            actor,
            "user.email.verify",
            "user",
            Some(user.to_string()),
            Some(json!({ "email": addr, "verified": false })),
            Some(json!({ "email": addr, "verified": true })),
        )
        .await?;
    }
    Ok(addr)
}

/// POST /api/v1/users/{id}/email/verify (admin): mark the address verified.
pub async fn admin_verify_email(
    State(state): State<AppState>,
    user: crate::auth::AuthUser,
    axum::extract::Path((_, id)): axum::extract::Path<(String, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let addr = apply_admin_verify(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(Json(json!({ "email": addr, "email_verified": true })))
}
