//! Self-service account endpoints: TOTP enrollment and recovery codes
//! (M1-6), subscription token regeneration (M1-9).
//!
//! 2FA is optional for every account (R18). Enrollment endpoints take
//! `SessionUser`, the only extractor that also accepts an enrollment-only
//! session (with `auth.require_admin_2fa`: an admin without active TOTP
//! after the password step); everything else in the API requires `AuthUser`
//! (a full session).

use axum::extract::State;
use axum::Json;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{self, ApiError, AuthUser, SessionUser, Stage};
use crate::state::AppState;
use crate::totp;

/// GET /api/v1/me/totp (any session, including enrollment-only): the
/// session's stage and the account's 2FA state. Never returns the secret.
pub async fn totp_status(
    State(state): State<AppState>,
    user: SessionUser,
) -> Result<Json<Value>, ApiError> {
    let (enabled, pending, left): (bool, bool, i64) = sqlx::query_as(
        "SELECT COALESCE(bool_or(t.enabled_at IS NOT NULL), false), \
                COALESCE(bool_or(t.enabled_at IS NULL), false), \
                (SELECT count(*) FROM user_recovery_codes r WHERE r.user_id = $1 AND r.used_at IS NULL) \
         FROM user_totp t WHERE t.user_id = $1",
    )
    .bind(user.id)
    .fetch_one(state.pg())
    .await?;
    Ok(Json(json!({
        "id": user.id,
        "login": user.login,
        "role": user.role,
        "stage": user.stage.as_str(),
        "enabled": enabled,
        "pending": pending,
        // The console recommends 2FA to admins without it; with this set it
        // is mandatory for them.
        "admin_2fa_required": state.cfg().auth.require_admin_2fa,
        "recovery_codes_left": left,
    })))
}

/// POST /api/v1/me/totp/enroll (any session): start (or restart) an
/// enrollment. A fresh secret is stored encrypted as pending — replacing
/// any earlier pending one — and returned exactly this once, as base32 and
/// as an otpauth URI. 409 if 2FA is already active.
pub async fn totp_enroll(
    State(state): State<AppState>,
    user: SessionUser,
) -> Result<Json<Value>, ApiError> {
    let secret = totp::generate_secret();
    let sealed = state.totp().seal(user.id, &secret)?;
    let n = sqlx::query(
        "INSERT INTO user_totp (user_id, secret_enc) VALUES ($1, $2) \
         ON CONFLICT (user_id) DO UPDATE \
         SET secret_enc = EXCLUDED.secret_enc, created_at = now(), last_step = NULL \
         WHERE user_totp.enabled_at IS NULL",
    )
    .bind(user.id)
    .bind(&sealed)
    .execute(state.pg())
    .await?
    .rows_affected();
    if n == 0 {
        return Err(ApiError::conflict(
            "two-factor authentication is already enabled",
        ));
    }
    Ok(Json(json!({
        "secret": totp::base32(&secret),
        "otpauth_uri": totp::otpauth_uri(&user.login, &secret),
        "digits": 6,
        "period": totp::STEP_SECS,
        "algorithm": "SHA1",
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeReq {
    pub code: String,
}

/// Replace the account's recovery codes with ten fresh ones; returns the
/// plaintexts (shown once).
async fn new_recovery_codes(
    conn: &mut PgConnection,
    state: &AppState,
    user: Uuid,
) -> Result<Vec<String>, ApiError> {
    let codes = totp::generate_recovery_codes();
    let hashes: Vec<String> = codes
        .iter()
        .filter_map(|c| totp::normalize_recovery(c))
        .map(|n| state.totp().recovery_hash(user, &n))
        .collect();
    if hashes.len() != codes.len() {
        return Err(anyhow::anyhow!("generated recovery code failed to normalize").into());
    }
    sqlx::query("DELETE FROM user_recovery_codes WHERE user_id = $1")
        .bind(user)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO user_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])",
    )
    .bind(user)
    .bind(&hashes)
    .execute(&mut *conn)
    .await?;
    Ok(codes)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfirmReq {
    pub code: String,
}

/// POST /api/v1/me/totp/confirm {code} (any session): activate the pending
/// secret with a valid current code. (R18 removed the admins' one-time
/// enrollment code, M1c.) In one transaction: activate (the code's step is
/// recorded, so it cannot be replayed at login), issue ten recovery codes, bump
/// session_ver (every other session of the account, e.g. another
/// enrollment-only one, ends), audit. This session continues with a fresh
/// full cookie. Returns the recovery codes (shown once). Wrong codes are
/// one 400 "invalid code" and count against the login rate limit of the
/// account and the client address.
pub async fn totp_confirm(
    State(state): State<AppState>,
    user: SessionUser,
    jar: CookieJar,
    ApiJson(req): ApiJson<ConfirmReq>,
) -> Result<(CookieJar, Json<Value>), ApiError> {
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
    match confirm_inner(&state, &user, &req).await {
        Ok(Some((role, sv, codes))) => {
            attempt.release(&state).await;
            let token = auth::issue_token(&state, user.id, &role, sv, Stage::Full)?;
            Ok((
                jar.add(auth::session_cookie(&state, token, Stage::Full)),
                Json(json!({ "recovery_codes": codes, "stage": Stage::Full.as_str() })),
            ))
        }
        Ok(None) => {
            attempt.fail();
            Err(ApiError::bad_request("invalid code"))
        }
        Err(e) => {
            attempt.release(&state).await;
            Err(e)
        }
    }
}

/// None = a wrong code.
async fn confirm_inner(
    state: &AppState,
    user: &SessionUser,
    req: &ConfirmReq,
) -> Result<Option<(String, i64, Vec<String>)>, ApiError> {
    let mut tx = state.pg().begin().await?;
    // Lock order: users, then the account's 2FA rows.
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM users WHERE id = $1 FOR UPDATE")
            .bind(user.id)
            .fetch_optional(&mut *tx)
            .await?;
    if role.is_none() {
        return Err(ApiError::unauthorized());
    }
    let pending: Option<(Vec<u8>, bool, i64)> = sqlx::query_as(
        "SELECT secret_enc, enabled_at IS NOT NULL, EXTRACT(EPOCH FROM now())::bigint \
         FROM user_totp WHERE user_id = $1 FOR UPDATE",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((sealed, enabled, now)) = pending else {
        return Err(ApiError::conflict("no enrollment in progress"));
    };
    if enabled {
        return Err(ApiError::conflict(
            "two-factor authentication is already enabled",
        ));
    }
    let Some(secret) = state.totp().open(user.id, &sealed) else {
        tracing::error!(user = %user.id, "pending TOTP secret cannot be decrypted");
        return Err(ApiError::conflict(
            "enrollment is no longer valid; start again",
        ));
    };
    let step = totp::verify(&secret, req.code.trim(), totp::step_of(now), None);
    let Some(step) = step else {
        return Ok(None);
    };
    sqlx::query("UPDATE user_totp SET enabled_at = now(), last_step = $2 WHERE user_id = $1")
        .bind(user.id)
        .bind(step)
        .execute(&mut *tx)
        .await?;
    let codes = new_recovery_codes(&mut tx, state, user.id).await?;
    let (role, sv): (String, i64) = sqlx::query_as(
        "UPDATE users SET session_ver = session_ver + 1 WHERE id = $1 RETURNING role, session_ver",
    )
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;
    crate::audit::record(
        &mut tx,
        &Actor::account(user.id, &user.login, user.ip),
        "user.totp.enable",
        "user",
        Some(user.id.to_string()),
        Some(json!({ "totp": "none" })),
        Some(json!({ "totp": "active", "recovery_codes": codes.len() })),
    )
    .await?;
    tx.commit().await?;
    Ok(Some((role, sv, codes)))
}

/// POST /api/v1/me/totp/recovery-codes {code} (full session): replace the
/// recovery codes after proving possession of the authenticator (a current
/// TOTP code, replay-checked). Wrong codes count against the login rate
/// limit of the account and the client address.
pub async fn regenerate_recovery_codes(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CodeReq>,
) -> Result<Json<Value>, ApiError> {
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
    match regenerate_inner(&state, &user, &req.code).await {
        Ok(Some(codes)) => {
            attempt.release(&state).await;
            Ok(Json(json!({ "recovery_codes": codes })))
        }
        Ok(None) => {
            attempt.fail();
            Err(ApiError::bad_request("invalid code"))
        }
        Err(e) => {
            attempt.release(&state).await;
            Err(e)
        }
    }
}

async fn regenerate_inner(
    state: &AppState,
    user: &AuthUser,
    code: &str,
) -> Result<Option<Vec<String>>, ApiError> {
    let mut tx = state.pg().begin().await?;
    let locked: Option<i32> = sqlx::query_scalar("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if locked.is_none() {
        return Err(ApiError::unauthorized());
    }
    let active: Option<(Vec<u8>, Option<i64>, i64)> = sqlx::query_as(
        "SELECT secret_enc, last_step, EXTRACT(EPOCH FROM now())::bigint FROM user_totp \
         WHERE user_id = $1 AND enabled_at IS NOT NULL FOR UPDATE",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((sealed, last, now)) = active else {
        return Err(ApiError::conflict(
            "two-factor authentication is not enabled",
        ));
    };
    let secret = state.totp().open(user.id, &sealed);
    let Some(step) = secret.and_then(|s| totp::verify(&s, code.trim(), totp::step_of(now), last))
    else {
        return Ok(None);
    };
    sqlx::query("UPDATE user_totp SET last_step = $2 WHERE user_id = $1")
        .bind(user.id)
        .bind(step)
        .execute(&mut *tx)
        .await?;
    let codes = new_recovery_codes(&mut tx, state, user.id).await?;
    crate::audit::record(
        &mut tx,
        &Actor::of(user),
        "user.totp.recovery_codes",
        "user",
        Some(user.id.to_string()),
        None,
        Some(json!({ "recovery_codes": codes.len() })),
    )
    .await?;
    tx.commit().await?;
    Ok(Some(codes))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangePasswordReq {
    pub current_password: String,
    pub new_password: String,
}

/// POST /api/v1/me/password {current_password, new_password} (full
/// session, any role; renewal scope: also expired users, R21): change your own password. The current password is
/// required; a wrong one is 400 "invalid password" and counts against the
/// login rate limit of the account and the client address. In one
/// transaction: new hash (the 0009 trigger bumps session_ver, ending every
/// other session of the account), audit row. This session continues with
/// a fresh cookie.
pub async fn change_own_password(
    State(state): State<AppState>,
    auth::ShopUser { user, .. }: auth::ShopUser,
    jar: CookieJar,
    ApiJson(req): ApiJson<ChangePasswordReq>,
) -> Result<(CookieJar, axum::http::StatusCode), ApiError> {
    if req.new_password.len() < 8 {
        return Err(ApiError::bad_request(
            "password must be at least 8 characters",
        ));
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
    match change_password_inner(&state, &user, &req).await {
        Ok(Some((role, sv))) => {
            attempt.release(&state).await;
            let token = auth::issue_token(&state, user.id, &role, sv, Stage::Full)?;
            Ok((
                jar.add(auth::session_cookie(&state, token, Stage::Full)),
                axum::http::StatusCode::NO_CONTENT,
            ))
        }
        Ok(None) => {
            attempt.fail();
            Err(ApiError::bad_request("invalid password"))
        }
        Err(e) => {
            attempt.release(&state).await;
            Err(e)
        }
    }
}

/// None = wrong current password.
async fn change_password_inner(
    state: &AppState,
    user: &AuthUser,
    req: &ChangePasswordReq,
) -> Result<Option<(String, i64)>, ApiError> {
    let mut tx = state.pg().begin().await?;
    let hash: Option<Option<String>> =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1 FOR UPDATE")
            .bind(user.id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(hash) = hash else {
        return Err(ApiError::unauthorized());
    };
    if !auth::verify_password(&req.current_password, hash.as_deref().unwrap_or_default()) {
        return Ok(None);
    }
    let new_hash = auth::hash_password(&req.new_password)?;
    let (role, sv): (String, i64) = sqlx::query_as(
        "UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING role, session_ver",
    )
    .bind(user.id)
    .bind(&new_hash)
    .fetch_one(&mut *tx)
    .await?;
    crate::audit::record(
        &mut tx,
        &Actor::of(user),
        "user.password.change",
        "user",
        Some(user.id.to_string()),
        None,
        Some(json!({ "password": crate::audit::CHANGED, "self_service": true })),
    )
    .await?;
    tx.commit().await?;
    Ok(Some((role, sv)))
}

/// Self-service subscription token regenerations per account per hour.
pub const SUB_TOKEN_PER_HOUR: i64 = 5;

/// POST /api/v1/me/sub-token (full session, role=user): replace your own
/// subscription token; the old URL stops working at once. Rate limited
/// (SUB_TOKEN_PER_HOUR per account, Valkey, one key per account). Returns
/// the new token exactly once. Audited.
pub async fn regenerate_own_sub_token(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    if user.role != "user" {
        return Err(ApiError::forbidden());
    }
    let allowed = crate::rate::hit(
        &state,
        format!("akari:rl:subtoken:{}", user.id),
        SUB_TOKEN_PER_HOUR,
        3600,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "sub-token rate limit unavailable");
        ApiError::internal()
    })?;
    if !allowed {
        return Err(ApiError::too_many());
    }
    let mut tx = state.pg().begin().await?;
    let token = crate::sub::rotate_token(&mut tx, &Actor::of(&user), user.id)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    tx.commit().await?;
    Ok(Json(json!({ "sub_token": token })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::http::{rand_ip, Client};
    use crate::testdb::TestDb;
    use axum::http::StatusCode;
    use data_encoding::BASE32_NOPAD;
    use fred::prelude::KeysInterface;
    use serde_json::Value;

    const PW: &str = "correct-horse-battery";

    async fn account(db: &TestDb, role: &str) -> (Uuid, String) {
        let id = Uuid::new_v4();
        let login = format!("acct-{}", id.simple());
        sqlx::query("INSERT INTO users (id, login, password_hash, role) VALUES ($1, $2, $3, $4)")
            .bind(id)
            .bind(&login)
            .bind(auth::hash_password(PW).unwrap())
            .bind(role)
            .execute(&db.pool)
            .await
            .unwrap();
        (id, login)
    }

    async fn db_step(db: &TestDb) -> i64 {
        let now: i64 = sqlx::query_scalar("SELECT EXTRACT(EPOCH FROM now())::bigint")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        totp::step_of(now)
    }

    /// (action, after) of the account's audit rows, oldest first; waits a
    /// little for rows written off the request path.
    async fn audit_of(db: &TestDb, id: Uuid, want_at_least: usize) -> Vec<(String, Value)> {
        for _ in 0..50 {
            let rows: Vec<(String, Option<Value>)> = sqlx::query_as(
                "SELECT action, after FROM audit_log WHERE target_id = $1 ORDER BY id",
            )
            .bind(id.to_string())
            .fetch_all(&db.pool)
            .await
            .unwrap();
            if rows.len() >= want_at_least {
                return rows
                    .into_iter()
                    .map(|(a, v)| (a, v.unwrap_or(Value::Null)))
                    .collect();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("fewer than {want_at_least} audit rows for {id}");
    }

    async fn all_audit_text(db: &TestDb) -> String {
        sqlx::query_scalar(
            "SELECT COALESCE(string_agg(concat_ws(' ', before::text, after::text), ' '), '') \
             FROM audit_log",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap()
    }

    async fn clear_limits(state: &AppState, ips: &[std::net::IpAddr], login: &str) {
        let mut keys = Vec::new();
        for ip in ips {
            keys.extend(crate::login_limit::keys(
                &crate::client_ip::bucket(*ip),
                login,
            ));
        }
        let _: i64 = state.valkey().del(keys).await.unwrap();
    }

    fn other_code(good: &str) -> &'static str {
        if good == "000000" {
            "111111"
        } else {
            "000000"
        }
    }

    /// M1-6 / R18 end to end through the router: 2FA is optional, so an
    /// admin without TOTP logs in with the password alone (full session);
    /// enrolling needs only a valid current code (no enrollment code since
    /// R18); afterwards login needs password + code in one request, codes
    /// are single-use (replay), recovery codes work once, and wrong second
    /// factors are uniform 401s that count toward the login limit.
    #[tokio::test]
    async fn admin_totp_optional_enrollment_login_replay_and_recovery() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (id, login) = account(&db, "admin").await;
        let mut c = Client::new(&state, rand_ip());

        // A stray code is ignored for an account without 2FA.
        let r = c.login(&login, PW, Some("123456")).await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.json()["stage"], "full", "admin 2FA is optional");
        let cookie = r
            .headers
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            cookie.contains(&format!("Max-Age={}", auth::COOKIE_TTL_SECS)),
            "{cookie}"
        );
        assert_eq!(c.get("/test/api/v1/users").await.status, StatusCode::OK);
        let st = c.get("/test/api/v1/me/totp").await;
        assert_eq!(st.status, StatusCode::OK);
        assert_eq!(
            (
                st.json()["stage"].clone(),
                st.json()["enabled"].clone(),
                st.json()["admin_2fa_required"].clone()
            ),
            (json!("full"), json!(false), json!(false))
        );
        assert!(st.json().get("enroll_code_required").is_none());
        assert_eq!(
            c.post("/test/api/v1/me/totp/confirm", json!({"code": "123456"}))
                .await
                .status,
            StatusCode::CONFLICT,
            "nothing pending"
        );

        // Enroll twice: the second secret replaces the first.
        c.post("/test/api/v1/me/totp/enroll", json!({})).await;
        let e = c.post("/test/api/v1/me/totp/enroll", json!({})).await;
        assert_eq!(e.status, StatusCode::OK);
        let b32 = e.json()["secret"].as_str().unwrap().to_string();
        let secret = BASE32_NOPAD.decode(b32.as_bytes()).unwrap();
        assert_eq!(secret.len(), totp::SECRET_BYTES);
        assert!(e.json()["otpauth_uri"].as_str().unwrap().contains(&b32));
        let stored: Vec<u8> =
            sqlx::query_scalar("SELECT secret_enc FROM user_totp WHERE user_id = $1")
                .bind(id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(
            !stored.windows(secret.len()).any(|w| w == secret.as_slice()),
            "encrypted at rest"
        );

        let good = totp::code_at(&secret, db_step(&db).await);
        let r = c
            .post(
                "/test/api/v1/me/totp/confirm",
                json!({"code": other_code(&good)}),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        // The removed M1c field is an unknown field now.
        assert_eq!(
            c.post(
                "/test/api/v1/me/totp/confirm",
                json!({"code": good, "enrollment_code": "AAAA-BBBB"})
            )
            .await
            .status,
            StatusCode::BAD_REQUEST
        );
        let before_cookie = c.cookie.clone();
        let r = c
            .post("/test/api/v1/me/totp/confirm", json!({"code": good}))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
        let codes: Vec<String> =
            serde_json::from_value(r.json()["recovery_codes"].clone()).unwrap();
        assert_eq!(codes.len(), 10);
        c.cookie = r.session_cookie();
        assert_eq!(c.get("/test/api/v1/users").await.status, StatusCode::OK);
        let mut stale = Client::new(&state, rand_ip());
        stale.cookie = before_cookie;
        assert_eq!(
            stale.get("/test/api/v1/me/totp").await.status,
            StatusCode::UNAUTHORIZED,
            "activation ends the other sessions"
        );
        let st = c.get("/test/api/v1/me/totp").await;
        assert_eq!(st.json()["enabled"], true);
        assert_eq!(st.json()["recovery_codes_left"], 10);
        assert!(!String::from_utf8_lossy(&st.body).contains(&b32));
        assert_eq!(
            c.post("/test/api/v1/me/totp/enroll", json!({}))
                .await
                .status,
            StatusCode::CONFLICT,
            "the secret is never shown again"
        );

        // Login now needs the second factor; every failure is the same 401.
        let mut c2 = Client::new(&state, rand_ip());
        let unauthorized = |r: crate::testdb::http::Resp| {
            assert_eq!(r.status, StatusCode::UNAUTHORIZED);
            assert_eq!(r.json(), json!({"error": "unauthorized"}));
            assert!(r.session_cookie().is_none());
        };
        unauthorized(c2.login(&login, PW, None).await);
        unauthorized(c2.login(&login, PW, Some(other_code(&good))).await);
        unauthorized(c2.login(&login, PW, Some(&good)).await); // used by confirm
        unauthorized(c2.login(&login, "wrong-password", Some(&good)).await);
        unauthorized(c2.login("no-such-account", PW, Some(&good)).await);

        // A fresh step: rewind the replay marker instead of waiting 30 s.
        sqlx::query("UPDATE user_totp SET last_step = last_step - 3 WHERE user_id = $1")
            .bind(id)
            .execute(&db.pool)
            .await
            .unwrap();
        let code = totp::code_at(&secret, db_step(&db).await);
        let r = c2.login(&login, PW, Some(&code)).await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.json()["stage"], "full");
        assert_eq!(c2.get("/test/api/v1/users").await.status, StatusCode::OK);
        let mut c3 = Client::new(&state, rand_ip());
        unauthorized(c3.login(&login, PW, Some(&code)).await); // replay

        // Recovery codes: single use, typed loosely.
        assert_eq!(
            c3.login(&login, PW, Some(&codes[0])).await.status,
            StatusCode::OK
        );
        let mut c4 = Client::new(&state, rand_ip());
        unauthorized(c4.login(&login, PW, Some(&codes[0])).await);
        let loose = codes[1].to_uppercase().replace('-', " ");
        assert_eq!(
            c4.login(&login, PW, Some(&loose)).await.status,
            StatusCode::OK
        );
        let st = c4.get("/test/api/v1/me/totp").await;
        assert_eq!(st.json()["recovery_codes_left"], 8);

        // Wrong second factors count toward the login limit (name bucket:
        // 1 failed confirm on c (the unknown-field body is a parse error
        // before the limiter) + 4 on c2 + 1 on c3 + 1 on c4; the unknown
        // account has its own).
        let name_key = crate::login_limit::keys("x", &login)[1].clone();
        let n: i64 = state.valkey().get(&name_key).await.unwrap();
        assert_eq!(n, 7);

        let rows = audit_of(&db, id, 7).await;
        let actions: Vec<&str> = rows.iter().map(|(a, _)| a.as_str()).collect();
        assert!(actions.contains(&"user.totp.enable"), "{actions:?}");
        let methods: Vec<&str> = rows
            .iter()
            .filter(|(a, _)| a == "auth.login")
            .filter_map(|(_, v)| v["method"].as_str())
            .collect();
        assert_eq!(
            methods,
            ["password", "totp", "recovery_code", "recovery_code"]
        );
        assert!(rows
            .iter()
            .any(|(a, v)| a == "auth.login_failed" && v["reason"] == "second_factor"));
        let text = all_audit_text(&db).await;
        assert!(!text.contains(&b32) && !text.contains(&codes[2]) && !text.contains(&good));

        // Admin reset (here: by itself) ends the sessions; the next login
        // is password-only again.
        let r = c2
            .req(
                axum::http::Method::DELETE,
                &format!("/test/api/v1/users/{id}/totp"),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.json(), json!({"totp": "active"}));
        assert_eq!(
            c4.get("/test/api/v1/users").await.status,
            StatusCode::UNAUTHORIZED
        );
        let mut c5 = Client::new(&state, rand_ip());
        let r = c5.login(&login, PW, None).await;
        assert_eq!(r.json()["stage"], "full");
        clear_limits(&state, &[c.ip, c2.ip, c3.ip, c4.ip, c5.ip], &login).await;
        clear_limits(&state, &[c2.ip], "no-such-account").await;
        drop(state);
        db.drop().await;
    }

    /// `auth.require_admin_2fa = true` (opt-in, the pre-R18 policy minus
    /// the enrollment code): an admin without TOTP only gets a 15-minute
    /// enrollment session that reaches nothing else; a full session issued
    /// before the option was turned on stops working and reports as an
    /// enrollment session; activation yields a full session. Regular users
    /// are unaffected.
    #[tokio::test]
    async fn require_admin_2fa_confines_admins_without_totp() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let lax = AppState::for_test(db.pool.clone()).await;
        let strict =
            AppState::for_test_with(db.pool.clone(), |c| c.auth.require_admin_2fa = true).await;
        let (_, login) = account(&db, "admin").await;
        let (_, ulogin) = account(&db, "user").await;

        // Full session issued while 2FA was optional...
        let mut old = Client::new(&lax, rand_ip());
        assert_eq!(old.login(&login, PW, None).await.json()["stage"], "full");
        // ...is refused once the option is on (same JWT key, same DB).
        let mut old_strict = Client::new(&strict, old.ip);
        old_strict.cookie = old.cookie.clone();
        assert_eq!(
            old_strict.get("/test/api/v1/users").await.status,
            StatusCode::UNAUTHORIZED
        );
        let st = old_strict.get("/test/api/v1/me/totp").await;
        assert_eq!(st.status, StatusCode::OK);
        assert_eq!(st.json()["stage"], "enroll");
        assert_eq!(st.json()["admin_2fa_required"], true);

        let mut c = Client::new(&strict, rand_ip());
        let r = c.login(&login, PW, None).await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.json()["stage"], "enroll");
        let cookie = r
            .headers
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(cookie.contains("Max-Age=900"), "{cookie}");
        for path in [
            "/test/api/v1/users",
            "/test/api/v1/me",
            "/test/api/v1/nodes",
            "/test/api/v1/audit",
        ] {
            assert_eq!(c.get(path).await.status, StatusCode::UNAUTHORIZED, "{path}");
        }
        let e = c.post("/test/api/v1/me/totp/enroll", json!({})).await;
        assert_eq!(e.status, StatusCode::OK);
        let secret = BASE32_NOPAD
            .decode(e.json()["secret"].as_str().unwrap().as_bytes())
            .unwrap();
        let good = totp::code_at(&secret, db_step(&db).await);
        let r = c
            .post("/test/api/v1/me/totp/confirm", json!({"code": good}))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
        assert_eq!(r.json()["stage"], "full");
        c.cookie = r.session_cookie();
        assert_eq!(c.get("/test/api/v1/users").await.status, StatusCode::OK);

        // Users never need 2FA.
        let mut u = Client::new(&strict, rand_ip());
        assert_eq!(u.login(&ulogin, PW, None).await.json()["stage"], "full");
        assert_eq!(u.get("/test/api/v1/me").await.status, StatusCode::OK);

        clear_limits(&strict, &[old.ip, c.ip, u.ip], &login).await;
        clear_limits(&strict, &[u.ip], &ulogin).await;
        let uid: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE login = $1")
            .bind(&ulogin)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let _: i64 = strict
            .valkey()
            .del(format!("akari:audit:login_ok:{uid}"))
            .await
            .unwrap();
        drop(lax);
        drop(strict);
        db.drop().await;
    }

    /// The login body is parsed like every other API body (A5): malformed
    /// JSON, wrong types and unknown fields are 400s with a JSON error, not
    /// axum's plain-text 415/422; none of them counts as a login attempt.
    #[tokio::test]
    async fn login_body_is_strict_json() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (_, login) = account(&db, "user").await;
        let c = Client::new(&state, rand_ip());
        for body in [
            json!({"login": login, "password": PW, "extra": 1}),
            json!({"login": login, "password": 5}),
            json!({"login": login}),
            json!([]),
        ] {
            let r = c.post("/test/auth/login", body.clone()).await;
            assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
            assert!(r.json()["error"].is_string(), "{body}");
            assert!(r.session_cookie().is_none());
        }
        let n: Option<i64> = state
            .valkey()
            .get(&crate::login_limit::keys("x", &login)[1])
            .await
            .unwrap();
        assert_eq!(n.unwrap_or(0), 0, "parse errors are not attempts");
        drop(state);
        db.drop().await;
    }

    /// R21: an expired or quota-disabled user logs in with the renewal scope only (account,
    /// plan, own password; shop/orders use the same extractor); proxy
    /// access stays blocked (subscription, sub-token, 2FA endpoints). A
    /// disabled user cannot log in at all; admins are unaffected.
    #[tokio::test]
    async fn expired_user_gets_the_renewal_scope_only() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (id, login) = account(&db, "user").await;
        let mut c = Client::new(&state, rand_ip());
        assert_eq!(c.login(&login, PW, None).await.status, StatusCode::OK);
        let token = c.post("/test/api/v1/me/sub-token", json!({})).await.json()["sub_token"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            c.get(&format!("/test/sub/{token}")).await.status,
            StatusCode::OK
        );
        sqlx::query("UPDATE users SET expires_at = now() - interval '1 minute' WHERE id = $1")
            .bind(id)
            .execute(&db.pool)
            .await
            .unwrap();

        let mut e = Client::new(&state, rand_ip());
        let r = e.login(&login, PW, None).await;
        assert_eq!(r.status, StatusCode::OK, "expired users can log in");
        assert_eq!(r.json()["expired"], true);
        let me = e.get("/test/api/v1/me").await;
        assert_eq!(me.status, StatusCode::OK);
        assert_eq!(me.json()["expired"], true);
        assert_eq!(e.get("/test/api/v1/me/plan").await.status, StatusCode::OK);
        // Blocked: anything that serves or reveals proxy access.
        assert_eq!(
            e.post("/test/api/v1/me/sub-token", json!({})).await.status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            e.get("/test/api/v1/me/totp").await.status,
            StatusCode::UNAUTHORIZED
        );
        let junk = e.get("/test/definitely-not-here").await.fingerprint();
        assert_eq!(
            e.get(&format!("/test/sub/{token}")).await.fingerprint(),
            junk
        );
        // Allowed: change the own password (this session continues).
        let r = e
            .post(
                "/test/api/v1/me/password",
                json!({"current_password": PW, "new_password": "renewed-password-1"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
        e.cookie = r.session_cookie();
        assert_eq!(e.get("/test/api/v1/me").await.status, StatusCode::OK);

        // Quota-disabled (not expired): the same renewal scope.
        sqlx::query(
            "UPDATE users SET expires_at = NULL, enabled = false, disabled_reason = 'quota' \
             WHERE id = $1",
        )
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
        let mut q = Client::new(&state, rand_ip());
        let r = q.login(&login, "renewed-password-1", None).await;
        assert_eq!(r.status, StatusCode::OK, "quota-disabled users can log in");
        assert_eq!(
            (
                r.json()["expired"].clone(),
                r.json()["quota_exhausted"].clone()
            ),
            (json!(false), json!(true))
        );
        let me = q.get("/test/api/v1/me").await;
        assert_eq!(me.status, StatusCode::OK);
        assert_eq!(me.json()["quota_exhausted"], true);
        assert_eq!(q.get("/test/api/v1/me/plan").await.status, StatusCode::OK);
        assert_eq!(
            q.post("/test/api/v1/me/sub-token", json!({})).await.status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            q.get(&format!("/test/sub/{token}")).await.fingerprint(),
            junk
        );

        // Disabled by an admin: no login, no session.
        sqlx::query("UPDATE users SET disabled_reason = 'admin' WHERE id = $1")
            .bind(id)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            q.get("/test/api/v1/me").await.status,
            StatusCode::UNAUTHORIZED
        );
        let mut d = Client::new(&state, rand_ip());
        assert_eq!(
            d.login(&login, "renewed-password-1", None).await.status,
            StatusCode::UNAUTHORIZED
        );

        let _: i64 = state
            .valkey()
            .del(vec![
                format!("akari:rl:subtoken:{id}"),
                format!("akari:rl:sub:user:{id}"),
                format!("akari:rl:sub:ip:{}", crate::client_ip::bucket(c.ip)),
                format!("akari:rl:sub:ip:{}", crate::client_ip::bucket(e.ip)),
                format!("akari:audit:login_ok:{id}"),
            ])
            .await
            .unwrap();
        let _: i64 = state
            .valkey()
            .del(format!(
                "akari:rl:sub:ip:{}",
                crate::client_ip::bucket(q.ip)
            ))
            .await
            .unwrap();
        clear_limits(&state, &[c.ip, e.ip, q.ip, d.ip], &login).await;
        drop(state);
        db.drop().await;
    }

    /// Regular users: no 2FA = password only (a stray code is ignored, it
    /// must not reveal the 2FA state); optional TOTP works like the admin's;
    /// successful-login audit rows are throttled per account.
    #[tokio::test]
    async fn user_login_with_optional_totp_and_throttled_audit() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (id, login) = account(&db, "user").await;
        let mut c = Client::new(&state, rand_ip());
        for code in [None, Some("999999"), Some("garbage")] {
            let r = c.login(&login, PW, code).await;
            assert_eq!(r.status, StatusCode::OK);
            assert_eq!(r.json()["stage"], "full");
        }
        assert_eq!(c.get("/test/api/v1/me").await.status, StatusCode::OK);
        let logins = audit_of(&db, id, 1).await;
        assert_eq!(logins.len(), 1, "throttled: {logins:?}");
        // Opt in.
        let e = c.post("/test/api/v1/me/totp/enroll", json!({})).await;
        let secret = BASE32_NOPAD
            .decode(e.json()["secret"].as_str().unwrap().as_bytes())
            .unwrap();
        let good = totp::code_at(&secret, db_step(&db).await);
        let r = c
            .post("/test/api/v1/me/totp/confirm", json!({"code": good}))
            .await;
        assert_eq!(r.status, StatusCode::OK);
        let mut c2 = Client::new(&state, rand_ip());
        assert_eq!(
            c2.login(&login, PW, None).await.status,
            StatusCode::UNAUTHORIZED
        );
        let _: i64 = state
            .valkey()
            .del(format!("akari:audit:login_ok:{id}"))
            .await
            .unwrap();
        clear_limits(&state, &[c.ip, c2.ip], &login).await;
        drop(state);
        db.drop().await;
    }

    /// Recovery-code regeneration needs a current, unused TOTP code; wrong
    /// codes count toward the login limit.
    #[tokio::test]
    async fn recovery_codes_regeneration_requires_a_fresh_code() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (id, login) = account(&db, "user").await;
        let mut c = Client::new(&state, rand_ip());
        c.login(&login, PW, None).await;
        assert_eq!(
            c.post(
                "/test/api/v1/me/totp/recovery-codes",
                json!({"code": "123456"})
            )
            .await
            .status,
            StatusCode::CONFLICT,
            "2FA not enabled"
        );
        let e = c.post("/test/api/v1/me/totp/enroll", json!({})).await;
        let secret = BASE32_NOPAD
            .decode(e.json()["secret"].as_str().unwrap().as_bytes())
            .unwrap();
        let good = totp::code_at(&secret, db_step(&db).await);
        let r = c
            .post("/test/api/v1/me/totp/confirm", json!({"code": good}))
            .await;
        c.cookie = r.session_cookie();
        let first: Vec<String> =
            serde_json::from_value(r.json()["recovery_codes"].clone()).unwrap();
        // The confirm code is spent.
        let r = c
            .post("/test/api/v1/me/totp/recovery-codes", json!({"code": good}))
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        sqlx::query("UPDATE user_totp SET last_step = last_step - 3 WHERE user_id = $1")
            .bind(id)
            .execute(&db.pool)
            .await
            .unwrap();
        let code = totp::code_at(&secret, db_step(&db).await);
        let r = c
            .post("/test/api/v1/me/totp/recovery-codes", json!({"code": code}))
            .await;
        assert_eq!(r.status, StatusCode::OK);
        let second: Vec<String> =
            serde_json::from_value(r.json()["recovery_codes"].clone()).unwrap();
        assert_eq!(second.len(), 10);
        // Old codes are gone, new ones work.
        let mut c2 = Client::new(&state, rand_ip());
        assert_eq!(
            c2.login(&login, PW, Some(&first[0])).await.status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            c2.login(&login, PW, Some(&second[0])).await.status,
            StatusCode::OK
        );
        let n: i64 = state
            .valkey()
            .get(&crate::login_limit::keys("x", &login)[1])
            .await
            .unwrap();
        assert_eq!(n, 2, "the spent code and the old recovery code");
        assert!(audit_of(&db, id, 3)
            .await
            .iter()
            .any(|(a, _)| a == "user.totp.recovery_codes"));
        clear_limits(&state, &[c.ip, c2.ip], &login).await;
        drop(state);
        db.drop().await;
    }

    /// M1-9: a user regenerates their own subscription token: the old URL
    /// becomes the canonical rejection, the new one works; rate limited;
    /// admins have no subscription.
    #[tokio::test]
    async fn self_service_sub_token() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (id, login) = account(&db, "user").await;
        let mut c = Client::new(&state, rand_ip());
        c.login(&login, PW, None).await;
        let r = c.post("/test/api/v1/me/sub-token", json!({})).await;
        assert_eq!(r.status, StatusCode::OK);
        let t1 = r.json()["sub_token"].as_str().unwrap().to_string();
        assert_eq!(
            c.get(&format!("/test/sub/{t1}")).await.status,
            StatusCode::OK
        );
        let r = c.post("/test/api/v1/me/sub-token", json!({})).await;
        let t2 = r.json()["sub_token"].as_str().unwrap().to_string();
        let junk = c.get("/test/definitely-not-here").await.fingerprint();
        assert_eq!(c.get(&format!("/test/sub/{t1}")).await.fingerprint(), junk);
        assert_eq!(
            c.get(&format!("/test/sub/{t2}")).await.status,
            StatusCode::OK
        );
        for _ in 2..SUB_TOKEN_PER_HOUR {
            assert_eq!(
                c.post("/test/api/v1/me/sub-token", json!({})).await.status,
                StatusCode::OK
            );
        }
        assert_eq!(
            c.post("/test/api/v1/me/sub-token", json!({})).await.status,
            StatusCode::TOO_MANY_REQUESTS
        );
        let rows = audit_of(&db, id, 5).await;
        assert_eq!(
            rows.iter()
                .filter(|(a, _)| a == "user.sub_token.rotate")
                .count(),
            SUB_TOKEN_PER_HOUR as usize
        );
        let text = all_audit_text(&db).await;
        assert!(!text.contains(&t1) && !text.contains(&crate::sub::hash_token(&t1)));
        // Admins are not proxy users.
        let a = db.admin().await;
        let token = crate::auth::issue_token(&state, a, "admin", 0, Stage::Full).unwrap();
        let mut ac = Client::new(&state, rand_ip());
        ac.cookie = Some(token);
        assert_eq!(
            ac.post("/test/api/v1/me/sub-token", json!({})).await.status,
            StatusCode::FORBIDDEN
        );
        let _: i64 = state
            .valkey()
            .del(vec![
                format!("akari:rl:subtoken:{id}"),
                format!("akari:rl:sub:user:{id}"),
                format!("akari:rl:sub:ip:{}", crate::client_ip::bucket(c.ip)),
                format!("akari:audit:login_ok:{id}"),
            ])
            .await
            .unwrap();
        clear_limits(&state, &[c.ip], &login).await;
        drop(state);
        db.drop().await;
    }
}
