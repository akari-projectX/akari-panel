//! W20 real-database HTTP tests: the subscription link stored encrypted at
//! rest (B1), the two-step login (M9) and the automatic first invite code
//! (Minor 6).

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use fred::prelude::KeysInterface;
use serde_json::json;
use uuid::Uuid;

use crate::auth;
use crate::state::AppState;
use crate::sub::{hash_token, Stored};
use crate::testdb::http::{rand_ip, Client};
use crate::testdb::TestDb;
use crate::totp;

const PW: &str = "w20-password-123";

async fn user_with_password(db: &TestDb) -> (Uuid, String) {
    let id = db.user().await;
    let login: String =
        sqlx::query_scalar("UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING login")
            .bind(id)
            .bind(auth::hash_password(PW).unwrap())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    (id, login)
}

async fn signed_in(state: &AppState, login: &str) -> Client {
    let mut c = Client::new(state, rand_ip());
    let r = c.login(login, PW, None).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    c
}

async fn stored(db: &TestDb, id: Uuid) -> (Option<String>, Option<Vec<u8>>) {
    sqlx::query_as("SELECT sub_token_hash, sub_token_enc FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn audit_actions(db: &TestDb, target: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE target_id = $1 AND action <> 'auth.login' ORDER BY id",
    )
    .bind(target.to_string())
    .fetch_all(&db.pool)
    .await
    .unwrap()
}

/// A tracing subscriber writing every event (all levels) to a buffer.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Captured {
    type Writer = Captured;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// B1 end to end: a user without a token gets one on the first /me
/// (issued once, audited, stored encrypted + hashed); /me keeps returning
/// the same working link; rotation replaces both columns and the old link
/// stops working; admins read it (audited); nothing logs the token.
#[tokio::test]
async fn subscription_link_is_stored_encrypted_and_retrievable() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let logs = Captured::default();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(logs.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let state = AppState::for_test_with(db.pool.clone(), |c| {
        c.web.sub_domain = "sub.example".into();
    })
    .await;
    let (id, login) = user_with_password(&db).await;
    let c = signed_in(&state, &login).await;
    assert_eq!(stored(&db, id).await, (None, None));

    let me = c.get("/test/api/v1/me").await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(
        me.headers.get("cache-control").unwrap(),
        "no-store",
        "a credential is never cached"
    );
    let me = me.json();
    let token = me["sub_token"].as_str().unwrap().to_string();
    assert_eq!(me["sub_legacy"], false);
    assert_eq!(
        me["sub_url"],
        format!("https://sub.example/test/sub/{token}")
    );
    assert!(me["probe_interval_secs"].as_u64().unwrap() >= 600);
    let (hash, enc) = stored(&db, id).await;
    assert_eq!(hash.as_deref(), Some(hash_token(&token).as_str()));
    let enc = enc.expect("ciphertext stored");
    assert!(
        !enc.windows(token.len()).any(|w| w == token.as_bytes()),
        "not plaintext at rest"
    );
    assert_eq!(
        state.totp().open_sub_token(id, &enc).as_deref(),
        Some(token.as_str())
    );
    // The same link on every read: no implicit rotation.
    for _ in 0..2 {
        assert_eq!(c.get("/test/api/v1/me").await.json()["sub_token"], token);
    }
    assert_eq!(
        audit_actions(&db, id).await,
        ["user.sub_token.issue"],
        "issued exactly once"
    );
    // Lookup is by hash: the link works.
    let anon = Client::new(&state, rand_ip());
    let sub = anon.get(&format!("/test/sub/{token}")).await;
    assert_eq!(sub.status, StatusCode::OK);
    assert!(sub.headers.get("subscription-userinfo").is_some());
    // ?format= picks the format explicitly.
    let clash = anon.get(&format!("/test/sub/{token}?format=clash")).await;
    assert_eq!(
        clash.headers.get("content-type").unwrap(),
        "text/yaml; charset=utf-8"
    );

    // Rotation (self-service): both columns replaced, old link dead, new
    // link shown by /me from now on.
    let r = c.post("/test/api/v1/me/sub-token", json!({})).await;
    assert_eq!(r.status, StatusCode::OK);
    let t2 = r.json()["sub_token"].as_str().unwrap().to_string();
    assert_ne!(t2, token);
    assert_eq!(c.get("/test/api/v1/me").await.json()["sub_token"], t2);
    assert_eq!(
        anon.get(&format!("/test/sub/{token}")).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        anon.get(&format!("/test/sub/{t2}")).await.status,
        StatusCode::OK
    );
    let (hash2, enc2) = stored(&db, id).await;
    assert_eq!(hash2.as_deref(), Some(hash_token(&t2).as_str()));
    assert_ne!(enc2.as_deref(), Some(enc.as_slice()));

    // Admin read: same token, audited without token material; a user
    // cannot use the admin endpoint; admins have no subscription.
    let admin = db.admin().await;
    let mut ac = Client::new(&state, rand_ip());
    ac.cookie = Some(auth::issue_token(&state, admin, "admin", 0, auth::Stage::Full).unwrap());
    let r = ac
        .get(&format!("/test/api/v1/users/{id}/subscription"))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers.get("cache-control").unwrap(), "no-store");
    assert_eq!(r.json()["sub_token"], t2);
    assert_eq!(r.json()["legacy"], false);
    assert_eq!(
        r.json()["sub_url"],
        format!("https://sub.example/test/sub/{t2}")
    );
    assert_eq!(
        ac.get(&format!("/test/api/v1/users/{admin}/subscription"))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        ac.get(&format!(
            "/test/api/v1/users/{}/subscription",
            Uuid::new_v4()
        ))
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        c.get(&format!("/test/api/v1/users/{id}/subscription"))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let read: Vec<(Option<Uuid>, serde_json::Value)> = sqlx::query_as(
        "SELECT actor_id, after FROM audit_log WHERE action = 'user.sub_token.read' AND target_id = $1",
    )
    .bind(id.to_string())
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(read, [(Some(admin), json!({"legacy": false}))]);
    // Admin regeneration also stores the ciphertext.
    let r = ac
        .post(&format!("/test/api/v1/users/{id}/sub-token"), json!({}))
        .await;
    let t3 = r.json()["sub_token"].as_str().unwrap().to_string();
    assert_eq!(c.get("/test/api/v1/me").await.json()["sub_token"], t3);

    // No token (or its ciphertext) in the audit log or any log line.
    let audit: String = sqlx::query_scalar(
        "SELECT coalesce(string_agg(concat_ws(' ', action, before::text, after::text), ' '), '') \
         FROM audit_log",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let logged = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    for secret in [&token, &t2, &t3, &hex::encode(&enc)] {
        assert!(!audit.contains(secret.as_str()), "audit leaks {secret}");
        assert!(!logged.contains(secret.as_str()), "log leaks {secret}");
    }
    drop(state);
    db.drop().await;
}

/// Pre-0120 accounts (hash only) keep their working link and are never
/// rotated implicitly: /me says `sub_legacy` until the user resets. The
/// renewal scope gets no link. A hash rewritten by hand drops the stale
/// ciphertext (0120 trigger); a ciphertext without a hash is refused.
#[tokio::test]
async fn legacy_tokens_are_kept_and_guarded() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let (id, login) = user_with_password(&db).await;
    let legacy = crate::sub::generate_token();
    sqlx::query("UPDATE users SET sub_token_hash = $2 WHERE id = $1")
        .bind(id)
        .bind(hash_token(&legacy))
        .execute(&db.pool)
        .await
        .unwrap();
    let c = signed_in(&state, &login).await;
    let me = c.get("/test/api/v1/me").await.json();
    assert_eq!(me["sub_legacy"], true);
    assert!(me["sub_token"].is_null() && me["sub_url"].is_null());
    assert_eq!(
        stored(&db, id).await.0,
        Some(hash_token(&legacy)),
        "not rotated"
    );
    let anon = Client::new(&state, rand_ip());
    assert_eq!(
        anon.get(&format!("/test/sub/{legacy}")).await.status,
        StatusCode::OK
    );
    assert!(audit_actions(&db, id).await.is_empty());
    // Reset → a showable link.
    let t = c.post("/test/api/v1/me/sub-token", json!({})).await.json()["sub_token"]
        .as_str()
        .unwrap()
        .to_string();
    let me = c.get("/test/api/v1/me").await.json();
    assert_eq!(me["sub_legacy"], false);
    assert_eq!(me["sub_token"], t);
    assert!(
        me["sub_url"].is_null(),
        "no subscription domain: the SPA builds it"
    );

    // A ciphertext from another key file (or row) opens to nothing: legacy.
    let mut conn = db.pool.acquire().await.unwrap();
    let other = totp::Keys::from_material(&[9u8; 32]).unwrap();
    sqlx::query("UPDATE users SET sub_token_enc = $2 WHERE id = $1")
        .bind(id)
        .bind(other.seal_sub_token(id, &t).unwrap())
        .execute(&mut *conn)
        .await
        .unwrap();
    let actor = crate::audit::Actor::cli();
    assert_eq!(
        crate::sub::ensure_token(&mut conn, state.totp(), &actor, id)
            .await
            .unwrap(),
        Some(Stored::Legacy)
    );
    // The trigger: a hand-written hash change drops the ciphertext.
    sqlx::query("UPDATE users SET sub_token_enc = $2 WHERE id = $1")
        .bind(id)
        .bind(state.totp().seal_sub_token(id, &t).unwrap())
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET sub_token_hash = 'x' WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(stored(&db, id).await, (Some("x".into()), None));
    let err = sqlx::query(
        "UPDATE users SET sub_token_hash = NULL, sub_token_enc = '\\x01' WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *conn)
    .await
    .unwrap_err();
    assert!(
        err.to_string().contains("users_sub_token_enc_has_hash"),
        "{err}"
    );
    // A ciphertext whose plaintext does not match the lookup hash is legacy.
    let u = crate::sub::generate_token();
    sqlx::query("UPDATE users SET sub_token_hash = $2, sub_token_enc = $3 WHERE id = $1")
        .bind(id)
        .bind(hash_token(&u))
        .bind(state.totp().seal_sub_token(id, &t).unwrap())
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(
        crate::sub::ensure_token(&mut conn, state.totp(), &actor, id)
            .await
            .unwrap(),
        Some(Stored::Legacy)
    );
    drop(conn);

    // Renewal scope (expired): no link, nothing issued.
    let (id2, login2) = user_with_password(&db).await;
    sqlx::query("UPDATE users SET expires_at = now() - interval '1 day' WHERE id = $1")
        .bind(id2)
        .execute(&db.pool)
        .await
        .unwrap();
    let c2 = signed_in(&state, &login2).await;
    let me = c2.get("/test/api/v1/me").await.json();
    assert_eq!(me["expired"], true);
    assert!(me["sub_token"].is_null());
    assert_eq!(me["sub_legacy"], false);
    assert_eq!(stored(&db, id2).await, (None, None));
    drop(state);
    db.drop().await;
}

/// M9: two-step login. Password only for a 2FA account: the distinct
/// `totp_required` 401 — only after the password verified; a wrong
/// password, unknown or disabled account stays the uniform 401. The
/// totp-required answer does not consume a login-limit slot; wrong
/// passwords and wrong codes do, as before.
#[tokio::test]
async fn login_two_step_without_oracle() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let (id, login) = user_with_password(&db).await;
    // Enroll TOTP through the API.
    let c = signed_in(&state, &login).await;
    let e = c
        .post("/test/api/v1/me/totp/enroll", json!({}))
        .await
        .json();
    let secret = data_encoding::BASE32_NOPAD
        .decode(e["secret"].as_str().unwrap().as_bytes())
        .unwrap();
    let step = |db_now: i64| totp::step_of(db_now);
    let now: i64 = sqlx::query_scalar("SELECT EXTRACT(EPOCH FROM now())::bigint")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let r = c
        .post(
            "/test/api/v1/me/totp/confirm",
            json!({"code": totp::code_at(&secret, step(now))}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);

    let ip = rand_ip();
    let uniform = |r: &crate::testdb::http::Resp| {
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            r.json(),
            json!({"error": "unauthorized", "code": "auth.unauthorized", "params": {}})
        );
    };
    let mut a = Client::new(&state, ip);
    // Password right, no code (absent / blank): totp_required.
    for code in [None, Some(""), Some("  ")] {
        let r = a.login(&login, PW, code).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            r.json(),
            json!({"error": "totp required", "totp_required": true})
        );
        assert!(r.session_cookie().is_none());
    }
    // Wrong password (with or without code), unknown account: uniform.
    uniform(&a.login(&login, "wrong-password", None).await);
    uniform(&a.login(&login, "wrong-password", Some("123456")).await);
    uniform(&a.login("nobody-here", PW, None).await);
    // Right password, wrong code: uniform.
    let now: i64 = sqlx::query_scalar("SELECT EXTRACT(EPOCH FROM now())::bigint")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let good = totp::code_at(&secret, step(now) + 1);
    let bad = if good == "000000" { "111111" } else { "000000" };
    uniform(&a.login(&login, PW, Some(bad)).await);
    // Disabled by an admin: uniform even with the right password.
    sqlx::query("UPDATE users SET enabled = false WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
    uniform(&a.login(&login, PW, None).await);
    sqlx::query("UPDATE users SET enabled = true WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
    // Step two: password + code.
    let r = a.login(&login, PW, Some(&good)).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());

    // The limiter: only the 3 wrong passwords and the wrong code counted
    // (+ the unknown account's own name bucket), the 3 totp-required
    // answers did not.
    let keys = crate::login_limit::keys(&crate::client_ip::bucket(ip), &login);
    let ip_count: Option<i64> = state.valkey().get(&keys[0]).await.unwrap();
    // wrong pw ×2, unknown ×1, wrong code ×1, disabled ×1 = 5
    assert_eq!(ip_count, Some(5));
    // A user without 2FA: password alone logs in (no second step).
    let (_, plain) = user_with_password(&db).await;
    let r = Client::new(&state, rand_ip()).login(&plain, PW, None).await;
    assert_eq!(r.status, StatusCode::OK);

    let _: i64 = state.valkey().del(keys).await.unwrap();
    drop(state);
    db.drop().await;
}

/// Minor 6: the first invite code appears on its own, once per account.
#[tokio::test]
async fn first_invite_code_is_created_once() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let (id, login) = user_with_password(&db).await;
    let c = signed_in(&state, &login).await;
    // Registration closed: nothing created.
    let r = c.get("/test/api/v1/me/invite-codes").await.json();
    assert_eq!(r["codes"].as_array().unwrap().len(), 0);
    sqlx::query("UPDATE signup_settings SET register_enabled = true")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c.get("/test/api/v1/me/invite-codes").await.json();
    let codes = r["codes"].as_array().unwrap();
    assert_eq!(codes.len(), 1);
    let code = codes[0]["code"].as_str().unwrap().to_string();
    assert_eq!(
        c.get("/test/api/v1/me/invite-codes").await.json()["codes"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "idempotent"
    );
    assert_eq!(audit_actions(&db, id).await, ["invite.create"]);
    // Deleted on purpose: not recreated.
    let r = c
        .req(
            axum::http::Method::DELETE,
            &format!("/test/api/v1/me/invite-codes/{code}"),
            None,
        )
        .await;
    assert!(r.status.is_success(), "{:?}", r.status);
    assert_eq!(
        c.get("/test/api/v1/me/invite-codes").await.json()["codes"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    drop(state);
    db.drop().await;
}
