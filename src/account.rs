//! Self-service account endpoints: own password, subscription token
//! regeneration (M1-9).

use crate::auth::bad_request;
use axum::Json;
use axum::extract::State;
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{self, ApiError, AuthUser};
use crate::state::AppState;

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
        return Err(bad_request!(
            "account.password_too_short",
            "password must be at least 8 characters"
        ));
    }
    let bucket = user
        .ip
        .map(crate::client_ip::bucket)
        .unwrap_or_else(|| "unknown".into());
    let attempt = crate::login_limit::Attempt::reserve(&state, &bucket, &user.email)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "login rate limit unavailable");
            ApiError::internal()
        })?
        .ok_or_else(ApiError::too_many)?;
    match change_password_inner(&state, &user, &req).await {
        Ok(Some((role, sv))) => {
            attempt.release(&state).await;
            let token = auth::issue_token(&state, user.id, &role, sv)?;
            Ok((
                jar.add(auth::session_cookie(&state, token)),
                axum::http::StatusCode::NO_CONTENT,
            ))
        }
        Ok(None) => {
            attempt.fail();
            Err(bad_request!("account.invalid_password", "invalid password"))
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
    if !auth::verify_password_async(&req.current_password, hash.as_deref().unwrap_or_default())
        .await
    {
        return Ok(None);
    }
    let new_hash = auth::hash_password_async(&req.new_password).await?;
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
/// the new token (W20: it stays visible in `/me`, stored encrypted).
/// Audited.
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
    let (token, outcome) =
        crate::sub::apply_reset(&mut tx, state.master_key(), &Actor::of(&user), user.id)
            .await?
            .ok_or_else(ApiError::unauthorized)?;
    tx.commit().await?;
    let sub_url = state.settings().get().sub_url(state.route_prefix(), &token);
    Ok(Json(json!({
        "sub_token": token,
        "sub_url": sub_url,
        "credentials_rotated": outcome.updated,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::TestDb;
    use crate::testdb::http::{Client, rand_ip};
    use axum::http::StatusCode;
    use fred::prelude::KeysInterface;
    use serde_json::Value;
    use uuid::Uuid;

    const PW: &str = "correct-horse-battery";

    /// An account with password PW; returns (id, email).
    async fn account(db: &TestDb, role: &str) -> (Uuid, String) {
        let id = Uuid::new_v4();
        let email = format!("acct-{}@example.com", id.simple());
        sqlx::query("INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)")
            .bind(id)
            .bind(&email)
            .bind(auth::hash_password(PW).unwrap())
            .bind(role)
            .execute(&db.pool)
            .await
            .unwrap();
        (id, email)
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

    async fn clear_limits(state: &AppState, ips: &[std::net::IpAddr], email: &str) {
        let mut keys = Vec::new();
        for ip in ips {
            keys.extend(crate::login_limit::keys(
                &crate::client_ip::bucket(*ip),
                email,
            ));
        }
        let _: i64 = state.valkey().del(keys).await.unwrap();
    }

    /// D1/D7 end to end through the router: everyone logs in with the email
    /// address (any case) and the password alone; every failure (unknown
    /// address, wrong password, disabled account) is the same 401 without a
    /// cookie and counts toward the address's login limit; the session is a
    /// 12-hour cookie; successful logins are audited (admins always,
    /// regular users throttled) under the account's non-personal label.
    #[tokio::test]
    async fn email_login_uniform_failures_and_audit() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (aid, admin) = account(&db, "admin").await;
        let (uid, user) = account(&db, "user").await;
        let mut c = Client::new(&state, rand_ip());

        let r = c.login(&admin.to_uppercase(), PW).await;
        assert_eq!(r.status, StatusCode::OK, "case-insensitive address");
        assert_eq!(r.json()["email"], admin);
        assert_eq!(r.json()["role"], "admin");
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
        let me = c.get("/test/api/v1/me").await.json();
        assert_eq!(me["email"], admin);
        assert!(me.get("login").is_none(), "D1: no login name");

        let unauthorized = |r: crate::testdb::http::Resp| {
            assert_eq!(r.status, StatusCode::UNAUTHORIZED);
            assert_eq!(
                r.json(),
                json!({"error": "unauthorized", "code": "auth.unauthorized", "params": {}})
            );
            assert!(r.session_cookie().is_none());
        };
        let mut c2 = Client::new(&state, rand_ip());
        unauthorized(c2.login(&user, "wrong-password").await);
        unauthorized(c2.login("no-such-account@example.com", PW).await);
        // A disabled admin account (a banned role=user one signs in to the
        // portal scope, W28-c).
        sqlx::query("UPDATE users SET role = 'admin', enabled = false WHERE id = $1")
            .bind(uid)
            .execute(&db.pool)
            .await
            .unwrap();
        unauthorized(c2.login(&user, PW).await);
        let n: i64 = state
            .valkey()
            .get(&crate::login_limit::keys("x", &user)[1])
            .await
            .unwrap();
        assert_eq!(n, 2, "wrong password + disabled account");
        sqlx::query("UPDATE users SET role = 'user', enabled = true WHERE id = $1")
            .bind(uid)
            .execute(&db.pool)
            .await
            .unwrap();
        for _ in 0..2 {
            assert_eq!(c2.login(&user, PW).await.status, StatusCode::OK);
        }
        assert_eq!(c2.get("/test/api/v1/me").await.status, StatusCode::OK);
        let user_logins = audit_of(&db, uid, 1)
            .await
            .into_iter()
            .filter(|(a, _)| a == "auth.login")
            .count();
        assert_eq!(user_logins, 1, "regular users' logins are throttled");
        let admin_rows = audit_of(&db, aid, 1).await;
        assert_eq!(admin_rows[0].0, "auth.login");
        assert_eq!(admin_rows[0].1, json!({"method": "password"}));
        let (label, actor): (String, Option<Uuid>) = sqlx::query_as(
            "SELECT actor_label, actor_id FROM audit_log WHERE target_id = $1 \
             AND action = 'auth.login'",
        )
        .bind(aid.to_string())
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(label, crate::audit::user_label(aid));
        assert_eq!(actor, Some(aid));
        assert!(!label.contains('@'), "Q4: no address in the label");
        let failed: Vec<(String, Option<Uuid>)> = sqlx::query_as(
            "SELECT actor_label, actor_id FROM audit_log WHERE target_id = $1 \
             AND action = 'auth.login_failed'",
        )
        .bind(uid.to_string())
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert!(
            failed
                .iter()
                .all(|(l, id)| l == "anonymous" && id.is_none()),
            "{failed:?}"
        );
        let _: i64 = state
            .valkey()
            .del(vec![
                format!("akari:audit:login_ok:{uid}"),
                format!("akari:audit:login_ok:{aid}"),
            ])
            .await
            .unwrap();
        clear_limits(&state, &[c.ip, c2.ip], &admin).await;
        clear_limits(&state, &[c2.ip], &user).await;
        clear_limits(&state, &[c2.ip], "no-such-account@example.com").await;
        drop(state);
        db.drop().await;
    }

    /// D7: the TOTP endpoints and the login `code` field are gone.
    #[tokio::test]
    async fn totp_is_gone() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (id, email) = account(&db, "admin").await;
        let mut c = Client::new(&state, rand_ip());
        let r = c
            .post(
                "/test/auth/login",
                json!({"email": email, "password": PW, "code": "123456"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "unknown field");
        assert_eq!(c.login(&email, PW).await.status, StatusCode::OK);
        let canonical = c.get("/test/definitely-not-here").await.fingerprint();
        for path in [
            "/test/api/v1/me/totp",
            "/test/api/v1/me/totp/enroll",
            "/test/api/v1/me/totp/confirm",
            "/test/api/v1/me/totp/recovery-codes",
        ] {
            assert_eq!(c.get(path).await.fingerprint(), canonical, "{path}");
            assert_eq!(
                c.post(path, json!({})).await.fingerprint(),
                canonical,
                "{path}"
            );
        }
        let r = c
            .req(
                axum::http::Method::DELETE,
                &format!("/test/api/v1/users/{id}/totp"),
                None,
            )
            .await;
        assert_eq!(r.fingerprint(), canonical);
        let _: i64 = state
            .valkey()
            .del(format!("akari:audit:login_ok:{id}"))
            .await
            .unwrap();
        clear_limits(&state, &[c.ip], &email).await;
        drop(state);
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
            json!({"email": login, "password": PW, "extra": 1}),
            json!({"email": login, "password": 5}),
            json!({"email": login}),
            json!({"login": login, "password": PW}),
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
    /// access stays blocked (subscription, sub-token). A
    /// disabled user cannot log in at all; admins are unaffected.
    #[tokio::test]
    async fn expired_user_gets_the_renewal_scope_only() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (id, login) = account(&db, "user").await;
        let mut c = Client::new(&state, rand_ip());
        assert_eq!(c.login(&login, PW).await.status, StatusCode::OK);
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
        let r = e.login(&login, PW).await;
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
        let r = q.login(&login, "renewed-password-1").await;
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

        // Banned by an admin (W28-c): the portal scope only — the account
        // with the ban reason, nothing of the renewal scope.
        sqlx::query(
            "UPDATE users SET disabled_reason = 'admin', disabled_note = 'abuse' WHERE id = $1",
        )
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
        let me = q.get("/test/api/v1/me").await;
        assert_eq!(me.status, StatusCode::OK);
        assert_eq!(
            (me.json()["banned"].clone(), me.json()["ban_reason"].clone()),
            (json!(true), json!("abuse"))
        );
        let plan = q.get("/test/api/v1/me/plan").await;
        assert_eq!(plan.status, StatusCode::FORBIDDEN);
        assert_eq!(plan.json()["code"], "account.banned");
        let mut d = Client::new(&state, rand_ip());
        let r = d.login(&login, "renewed-password-1").await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.json()["banned"], true);

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
        c.login(&login, PW).await;
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
        let token = crate::auth::issue_token(&state, a, "admin", 0).unwrap();
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
