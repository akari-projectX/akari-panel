//! Portal account settings (W15): set/change the account's email address
//! (verified by an emailed code) and the language of its mails.
//!
//! `POST /me/email/code {email, password}`: the current password is
//! required (a stolen session must not be able to move the address that
//! password resets go to); a wrong one is 400 "invalid password" and counts
//! against the login rate limit like `/me/password`. The answer is the same
//! whether or not the address belongs to another account (the code mail is
//! only queued when it does not, after the response).
//! `POST /me/email/verify {code}`: sets `email` + `email_verified_at`; an
//! account whose login was its old address (registered accounts, verified
//! or not — W24) moves its login along. Verifying the CURRENT unverified
//! address of an account registered without verification is the same flow
//! (request a code for that address). Both use the renewal scope (`ShopUser`, like `/me/password`).

use crate::auth::{bad_request, conflict};
use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use super::{email, CodeCheck};
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{self, ApiError, ShopUser};
use crate::mail::{Locale, Template};
use crate::state::AppState;

pub const PURPOSE: &str = "change_email";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmailCodeReq {
    pub email: String,
    pub password: String,
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
    let bucket = user
        .ip
        .map(crate::client_ip::bucket)
        .unwrap_or_else(|| "unknown".into());
    let attempt = crate::login_limit::Attempt::reserve(&state, &bucket, &user.login)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "login rate limit unavailable");
            ApiError::internal()
        })?
        .ok_or_else(ApiError::too_many)?;
    let hash: Option<Option<String>> =
        match sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_optional(state.pg())
            .await
        {
            Ok(h) => h,
            Err(e) => {
                attempt.release(&state).await;
                return Err(e.into());
            }
        };
    let Some(hash) = hash else {
        attempt.release(&state).await;
        return Err(ApiError::unauthorized());
    };
    if !auth::verify_password(&req.password, hash.as_deref().unwrap_or_default()) {
        attempt.fail();
        return Err(bad_request!("account.invalid_password", "invalid password"));
    }
    attempt.release(&state).await;
    super::limit_send(&state, &bucket, &addr).await?;
    let st = state.clone();
    let user_id = user.id;
    tokio::spawn(async move {
        let r = async {
            let mut tx = st.pg().begin().await?;
            apply_send_code(&mut tx, st.totp(), user_id, &addr).await?;
            tx.commit().await?;
            anyhow::Ok(())
        };
        if let Err(e) = r.await {
            tracing::warn!(error = %e, "email verification code not queued");
        }
    });
    Ok(Json(json!({ "ok": true })))
}

/// Issue and queue the code unless the address is another account's
/// (verified) address or login. Returns whether a mail was queued.
pub async fn apply_send_code(
    conn: &mut PgConnection,
    keys: &crate::totp::Keys,
    user: Uuid,
    addr: &str,
) -> anyhow::Result<bool> {
    let smtp = crate::mail::load(conn).await?;
    if !smtp.enabled {
        return Ok(false);
    }
    let row: Option<(String, bool)> = sqlx::query_as(
        "SELECT u.locale, EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND \
           (o.login = $2 OR (o.email = $2 AND o.email_verified_at IS NOT NULL))) \
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
/// counted attempt); a unique violation (the address/login was taken in
/// between) is the same 400 as a wrong code.
pub async fn apply_verify(
    conn: &mut PgConnection,
    keys: &crate::totp::Keys,
    actor: &Actor,
    user: Uuid,
    code: &str,
) -> Result<Option<String>, ApiError> {
    let CodeCheck::Ok { email: addr } =
        super::check_code(conn, keys, PURPOSE, &user.to_string(), code).await?
    else {
        return Ok(None);
    };
    // W24: no other account may log in with this address (a registration
    // without verification may have taken it as its login meanwhile).
    super::lock_address(conn, &addr).await?;
    let login_taken: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id <> $1 AND login = $2)")
            .bind(user)
            .bind(&addr)
            .fetch_one(&mut *conn)
            .await?;
    if login_taken {
        return Err(super::register::invalid_code());
    }
    let before: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user)
        .fetch_optional(&mut *conn)
        .await?
        .flatten();
    let mut sp = sqlx::Connection::begin(&mut *conn).await?;
    let r = sqlx::query(
        "UPDATE users SET email = $2, email_verified_at = now(), \
         login = CASE WHEN login = email THEN $2 ELSE login END \
         WHERE id = $1",
    )
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
        state.totp(),
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
/// vouches for it, like `POST /users` with `email`). In the caller's
/// transaction: address lock → no OTHER account may log in with the
/// address (409) → conditional UPDATE (a verified duplicate = 409
/// `user.email_exists`) → audit `user.email.verify`. Idempotent.
pub async fn apply_admin_verify(
    conn: &mut PgConnection,
    actor: &Actor,
    user: Uuid,
) -> Result<String, ApiError> {
    let email: Option<Option<String>> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(email) = email else {
        return Err(ApiError::not_found());
    };
    let Some(addr) = email else {
        return Err(conflict!(
            "user.no_email",
            "the account has no email address"
        ));
    };
    super::lock_address(conn, &addr).await?;
    let login_taken: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id <> $1 AND login = $2)")
            .bind(user)
            .bind(&addr)
            .fetch_one(&mut *conn)
            .await?;
    if login_taken {
        return Err(conflict!(
            "user.email_exists",
            "another account already uses this email address"
        ));
    }
    let mut sp = sqlx::Connection::begin(&mut *conn).await?;
    let r = sqlx::query(
        "UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL",
    )
    .bind(user)
    .execute(&mut *sp)
    .await;
    let changed = match r {
        Ok(r) => {
            sp.commit().await?;
            r.rows_affected() == 1
        }
        Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
            sp.rollback().await?;
            return Err(conflict!(
                "user.email_exists",
                "another account already uses this email address"
            ));
        }
        Err(e) => return Err(e.into()),
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
