//! W15 tests: registration, reset, email change, invites, settings — unit,
//! real-DB and HTTP (through `web::router`).

use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::*;
use crate::mail::Locale;
use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, rand_ip};

const ORIGIN: &str = "https://panel.example";

async fn state(db: &TestDb) -> AppState {
    let st = AppState::for_test(db.pool.clone()).await;
    let host = ORIGIN.trim_start_matches("https://");
    db.settings(&st, &format!("main_domain = '{host}'")).await;
    st
}

async fn enable_mail(db: &TestDb) {
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', port = 1025, \
         security = 'none', from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
}

async fn set_signup(db: &TestDb, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE signup_settings SET {sql} WHERE id = 1"
    )))
    .execute(&db.pool)
    .await
    .unwrap();
}

fn addr() -> String {
    format!(
        "u{}@example.com",
        &Uuid::new_v4().simple().to_string()[..12]
    )
}

/// The newest outbox row of `kind` to `to` (the spawned work may lag).
async fn wait_mail(db: &TestDb, kind: &str, to: &str) -> (i64, String) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let r: Option<(i64, String)> = sqlx::query_as(
            "SELECT id, body_text FROM mail_outbox WHERE kind = $1 AND to_addr = $2 \
             ORDER BY id DESC LIMIT 1",
        )
        .bind(kind)
        .bind(to)
        .fetch_optional(&db.pool)
        .await
        .unwrap();
        if let Some(r) = r {
            return r;
        }
        assert!(Instant::now() < deadline, "no {kind} mail to {to}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn mail_count(db: &TestDb, to: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM mail_outbox WHERE to_addr = $1")
        .bind(to)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

/// Let spawned request work settle before asserting that nothing was sent.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(300)).await;
}

fn code_in(body: &str) -> String {
    let b = body.as_bytes();
    for i in 0..b.len().saturating_sub(5) {
        let w = &b[i..i + 6];
        let edge_ok = (i == 0 || !b[i - 1].is_ascii_digit())
            && (i + 6 == b.len() || !b[i + 6].is_ascii_digit());
        if edge_ok && w.iter().all(u8::is_ascii_digit) {
            return String::from_utf8(w.to_vec()).unwrap();
        }
    }
    panic!("no code in {body}");
}

fn token_in(body: &str) -> String {
    let i = body.find("#token=").expect("link") + 7;
    body[i..i + 43].to_string()
}

async fn register_via_api(c: &mut Client, db: &TestDb, email: &str, password: &str) -> Value {
    let r = c
        .post(
            "/test/auth/register/code",
            json!({ "email": email, "locale": "en" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let (_, body) = wait_mail(db, "register_code", &email.to_lowercase()).await;
    let r = c
        .post(
            "/test/auth/register",
            json!({ "email": email, "code": code_in(&body), "password": password, "locale": "en" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    c.cookie = r.session_cookie();
    r.json()
}

async fn user_id(db: &TestDb, email: &str) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(email)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn with_password(db: &TestDb, password: &str) -> Uuid {
    let id = db.user().await;
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(id)
        .bind(crate::auth::hash_password(password).unwrap())
        .execute(&db.pool)
        .await
        .unwrap();
    id
}

async fn verified(db: &TestDb, id: Uuid, email: &str) {
    sqlx::query("UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1")
        .bind(id)
        .bind(email)
        .execute(&db.pool)
        .await
        .unwrap();
}

async fn email_of(db: &TestDb, id: Uuid) -> String {
    sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

#[test]
fn codes_and_tokens() {
    for _ in 0..500 {
        let c = new_code();
        assert!(plausible_code(&c), "{c}");
    }
    assert!(!plausible_code("12345"));
    assert!(!plausible_code("1234567"));
    assert!(!plausible_code("12a456"));
    assert!(!plausible_code("١٢٣٤٥٦"), "non-ASCII digits");
    let t = reset::new_token();
    assert!(reset::plausible_token(&t), "{t}");
    assert!(!reset::plausible_token(&t[..42]));
    assert!(!reset::plausible_token(&format!("{}=", &t[..42])));
    assert_ne!(reset::new_token(), t);
    assert_eq!(reset::token_hash(&t).len(), 32);
}

#[test]
fn code_hash_binds_purpose_subject_and_address() {
    let k = crate::masterkey::Keys::from_material(&[9u8; 32]).unwrap();
    let h = k.mail_code_hash("register", "a@x.cc", "a@x.cc", "123456");
    assert_eq!(
        h,
        k.mail_code_hash("register", "a@x.cc", "a@x.cc", "123456")
    );
    assert_ne!(
        h,
        k.mail_code_hash("change_email", "a@x.cc", "a@x.cc", "123456")
    );
    assert_ne!(
        h,
        k.mail_code_hash("register", "b@x.cc", "a@x.cc", "123456")
    );
    assert_ne!(
        h,
        k.mail_code_hash("register", "a@x.cc", "b@x.cc", "123456")
    );
    assert_ne!(
        h,
        k.mail_code_hash("register", "a@x.cc", "a@x.cc", "123457")
    );
    // Length-prefixed: shifting bytes between parts changes the MAC.
    assert_ne!(
        k.mail_code_hash("ab", "c", "", ""),
        k.mail_code_hash("a", "bc", "", "")
    );
    let other = crate::masterkey::Keys::from_material(&[8u8; 32]).unwrap();
    assert_ne!(
        h,
        other.mail_code_hash("register", "a@x.cc", "a@x.cc", "123456")
    );
    assert!(!h.contains("123456"));
}

fn req(domains: &[&str]) -> SignupReq {
    SignupReq {
        version: 0,
        register_enabled: true,
        invite_required: false,
        invite_single_use: false,
        invite_codes_per_user: 5,
        email_domains: domains.iter().map(|s| s.to_string()).collect(),
        trial_plan_id: None,
        trial_days: 3,
        reset_enabled: false,
        email_verify: false,
    }
}

#[test]
fn signup_values_normalise_and_bound() {
    let v = signup_values(&req(&[
        "Example.COM",
        "@qq.com",
        "example.com",
        "bücher.example",
    ]))
    .unwrap();
    assert_eq!(
        v.email_domains,
        ["example.com", "qq.com", "xn--bcher-kva.example"]
    );
    assert!(signup_values(&req(&["not a domain"])).is_err());
    assert!(signup_values(&req(&["localhost"])).is_err());
    let many: Vec<String> = (0..101).map(|i| format!("d{i}.com")).collect();
    let refs: Vec<&str> = many.iter().map(String::as_str).collect();
    assert!(signup_values(&req(&refs)).is_err());
    let mut r = req(&[]);
    r.trial_days = 0;
    assert!(signup_values(&r).is_err());
    let mut r = req(&[]);
    r.invite_codes_per_user = 101;
    assert!(signup_values(&r).is_err());
    assert!(check_password("1234567").is_err());
    assert!(check_password(&"x".repeat(257)).is_err());
    assert!(check_password("12345678").is_ok());
}

// ---------------------------------------------------------------------------
// HTTP: disabled = canonical rejection
// ---------------------------------------------------------------------------

async fn check_rejected(c: &Client, paths: &[&str], canonical: &crate::testdb::http::Fingerprint) {
    for &p in paths {
        let bodies = [
            json!({ "email": "a@example.com" }),
            json!({ "email": "a@example.com", "code": "123456", "password": "password1" }),
            json!({ "token": "x", "password": "password1" }),
            json!({ "unknown": 1 }),
        ];
        for b in bodies {
            assert_eq!(&c.post(p, b).await.fingerprint(), canonical, "POST {p}");
        }
        assert_eq!(
            &c.post_raw(p, "application/json", b"{not json".to_vec())
                .await
                .fingerprint(),
            canonical,
            "malformed {p}"
        );
        assert_eq!(
            &c.post_raw(p, "text/plain", vec![b'a'; 64 * 1024])
                .await
                .fingerprint(),
            canonical,
            "oversized {p}"
        );
        for m in [Method::GET, Method::PUT, Method::DELETE] {
            assert_eq!(
                &c.req(m.clone(), p, None).await.fingerprint(),
                canonical,
                "{m} {p}"
            );
        }
    }
}

/// While registration / reset are off, their endpoints are byte-identical
/// to a junk path for every method and body (valid, malformed, oversized,
/// wrong content type), and the options endpoint says so.
#[tokio::test]
async fn disabled_endpoints_are_the_canonical_rejection() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    let c = Client::new(&st, rand_ip());
    let canonical = c.get("/test/definitely/not/here").await.fingerprint();
    assert_eq!(canonical.0, StatusCode::NOT_FOUND);
    let paths = [
        "/test/auth/register/code",
        "/test/auth/register",
        "/test/auth/password-reset/request",
        "/test/auth/password-reset",
    ];
    check_rejected(&c, &paths, &canonical).await;
    check_rejected(&c, &["/test/auth/register/challenge"], &canonical).await;
    let o = c.get("/test/auth/options").await;
    assert_eq!(o.status, StatusCode::OK);
    let mut v = o.json();
    // Ops: the public branding (no image set: no URLs).
    let branding = v.as_object_mut().unwrap().remove("branding").unwrap();
    // v0.4: the bot-protection parameters (botguard::tests).
    assert!(
        v.as_object_mut()
            .unwrap()
            .remove("guard")
            .unwrap()
            .is_object()
    );
    // W27: passkeys (the main domain here is an https name).
    assert_eq!(
        v.as_object_mut().unwrap().remove("passkey"),
        Some(json!(true))
    );
    assert!(branding["logo_url"].is_null() && branding["footer_links"] == json!([]));
    assert_eq!(
        v,
        json!({ "register": false, "invite_required": false, "email_domains": [], "reset": false,
                "email_verify": false, "site_name": "Akari" })
    );

    // Enabled for one feature only: the other stays rejected.
    enable_mail(&db).await;
    set_signup(&db, "register_enabled = true, email_verify = true").await;
    for p in &paths[2..] {
        assert_eq!(
            c.post(p, json!({ "email": "a@example.com" }))
                .await
                .fingerprint(),
            canonical,
            "{p} with only registration on"
        );
    }
    let r = c
        .post_raw(paths[0], "application/json", b"{not json".to_vec())
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "enabled: a real 400");
    // W24: verified mode (mail on) → no challenge endpoint.
    check_rejected(&c, &["/test/auth/register/challenge"], &canonical).await;
    set_signup(&db, "register_enabled = false, reset_enabled = true").await;
    for p in &paths[..2] {
        assert_eq!(
            c.post(p, json!({ "email": "a@example.com" }))
                .await
                .fingerprint(),
            canonical,
            "{p} with only reset on"
        );
    }
    // Mail sending switched off later does not open the endpoints either
    // way (only the settings flag matters for the gate).
    set_signup(&db, "reset_enabled = false").await;
    check_rejected(&c, &paths, &canonical).await;
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn registration_flow_and_login_by_email() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    enable_mail(&db).await;
    set_signup(&db, "register_enabled = true, email_verify = true").await;
    let mut c = Client::new(&st, rand_ip());
    let o = c.get("/test/auth/options").await.json();
    assert_eq!(o["register"], true);
    assert_eq!(o["reset"], false);

    let email = addr();
    let upper = email.to_uppercase();
    let r = register_via_api(&mut c, &db, &upper, "correct horse").await;
    assert_eq!(r["email"], email);
    assert!(r.get("login").is_none(), "D1: no login name");
    assert_eq!(r["role"], "user");
    assert_eq!(r["trial"], false);
    let me = c.get("/test/api/v1/me").await;
    assert_eq!(me.status, StatusCode::OK);
    let me = me.json();
    assert_eq!(me["email"], email);
    assert_eq!(me["email_verified"], true);
    assert_eq!(me["locale"], "en");
    // The code mail is in English and its body holds no other secret.
    let (_, body) = wait_mail(&db, "register_code", &email).await;
    assert!(body.contains("valid for 10 minutes"), "{body}");
    let audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'user.register' AND target_id = $1",
    )
    .bind(me["id"].as_str().unwrap())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audit, 1);

    // Log in by the (verified) address in any case.
    let mut c2 = Client::new(&st, rand_ip());
    assert_eq!(
        c2.login(&upper, "correct horse").await.status,
        StatusCode::OK
    );
    let mut c3 = Client::new(&st, rand_ip());
    assert_eq!(
        c3.login(&email, "wrong password").await.status,
        StatusCode::UNAUTHORIZED
    );

    // D1: an unverified address is still the login name.
    let other = with_password(&db, "pw-of-other").await;
    let unverified = addr();
    sqlx::query("UPDATE users SET email = $2 WHERE id = $1")
        .bind(other)
        .bind(&unverified)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut c4 = Client::new(&st, rand_ip());
    assert_eq!(
        c4.login(&unverified, "pw-of-other").await.status,
        StatusCode::OK
    );

    // The code is single use: registering again with it fails.
    let (_, body) = wait_mail(&db, "register_code", &email).await;
    let r = c
        .post(
            "/test/auth/register",
            json!({ "email": email, "code": code_in(&body), "password": "another one" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["error"], register::INVALID_CODE);

    // Validation that does not depend on accounts.
    for (b, msg) in [
        (json!({ "email": "nope" }), "invalid email address"),
        (json!({ "email": "a@example.com", "x": 1 }), ""),
    ] {
        let r = c.post("/test/auth/register/code", b).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        if !msg.is_empty() {
            assert_eq!(r.json()["error"], msg);
        }
    }
    let r = c
        .post(
            "/test/auth/register",
            json!({ "email": addr(), "code": "123456", "password": "short" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    db.drop().await;
}

/// No account-existence oracle: the code request for a registered address
/// and for a fresh one answer byte-identically within the same time class
/// (account-dependent work runs after the response); the registered one
/// gets an "already registered" mail instead of a code.
#[tokio::test]
async fn code_request_has_no_existence_oracle() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    enable_mail(&db).await;
    set_signup(
        &db,
        "register_enabled = true, email_verify = true, reset_enabled = true",
    )
    .await;
    let existing = addr();
    let id = with_password(&db, "pw").await;
    verified(&db, id, &existing).await;
    let fresh = addr();

    let mut prints = Vec::new();
    let mut times = Vec::new();
    for (path, e) in [
        ("/test/auth/register/code", &existing),
        ("/test/auth/register/code", &fresh),
        ("/test/auth/password-reset/request", &existing),
        ("/test/auth/password-reset/request", &fresh),
    ] {
        let c = Client::new(&st, rand_ip());
        let t = Instant::now();
        let r = c.post(path, json!({ "email": e })).await;
        times.push(t.elapsed());
        assert_eq!(r.status, StatusCode::OK, "{path} {e}");
        prints.push((path, r.fingerprint()));
    }
    // Everything but the per-request id.
    let strip = |f: &crate::testdb::http::Fingerprint| {
        let mut f = f.clone();
        f.1.retain(|(k, _)| k != "x-request-id");
        f
    };
    assert_eq!(
        strip(&prints[0].1),
        strip(&prints[1].1),
        "register: identical responses"
    );
    assert_eq!(
        strip(&prints[2].1),
        strip(&prints[3].1),
        "reset: identical responses"
    );
    assert_eq!(prints[0].1.2, br#"{"ok":true}"#.to_vec());
    // Same time class: no request waits for a lookup/insert/mail.
    for t in &times {
        assert!(*t < Duration::from_millis(1500), "{times:?}");
    }

    let (_, body) = wait_mail(&db, "register_exists", &existing).await;
    assert!(
        body.contains("忘记密码"),
        "zh by default, reset hint: {body}"
    );
    wait_mail(&db, "register_code", &fresh).await;
    wait_mail(&db, "password_reset", &existing).await;
    settle().await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM email_codes WHERE subject = $1")
        .bind(&existing)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "no code is ever issued for a registered address");
    assert_eq!(
        mail_count(&db, &fresh).await,
        1,
        "no reset mail for an unknown address"
    );
    db.drop().await;
}

#[tokio::test]
async fn codes_burn_after_five_wrong_attempts_and_expire() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    let s = load_settings(&mut db.pool.acquire().await.unwrap())
        .await
        .unwrap();
    let email = addr();
    let mut tx = db.pool.begin().await.unwrap();
    let code = issue_code(&mut tx, st.master_key(), "register", &email, &email, None)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let wrong = if code == "000000" { "000001" } else { "000000" };
    let hash = crate::auth::hash_password("password1").unwrap();
    let attempt = |code: String| {
        let (st, s, email, hash) = (st.clone(), s.clone(), email.clone(), hash.clone());
        let pool = db.pool.clone();
        async move {
            let mut tx = pool.begin().await.unwrap();
            let r = register::apply_register(
                &mut tx,
                st.master_key(),
                &s,
                &register::Registration {
                    addr: &email,
                    code: &code,
                    password_hash: &hash,
                    invite_code: None,
                    locale: Locale::Zh,
                    ip: None,
                },
            )
            .await
            .ok()
            .unwrap();
            tx.commit().await.unwrap();
            r.is_some()
        }
    };
    for _ in 0..CODE_MAX_ATTEMPTS {
        assert!(!attempt(wrong.into()).await);
    }
    assert!(!attempt(code.clone()).await, "burnt after 5 wrong attempts");

    // A fresh code works; an expired one does not.
    let mut tx = db.pool.begin().await.unwrap();
    let code = issue_code(&mut tx, st.master_key(), "register", &email, &email, None)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE email_codes SET expires_at = now() - interval '1 second' WHERE subject = $1",
    )
    .bind(&email)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert!(!attempt(code).await, "expired");
    let mut tx = db.pool.begin().await.unwrap();
    let code = issue_code(&mut tx, st.master_key(), "register", &email, &email, None)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(attempt(code.clone()).await);
    assert!(!attempt(code).await, "single use");
    db.drop().await;
}

/// Two registrations of the same address racing with the same code: one
/// account, the other gets the invalid-code answer; a racing direct insert
/// of the address is the same answer (unique index), never a 500.
#[tokio::test]
async fn racing_registrations_of_one_address() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    let s = load_settings(&mut db.pool.acquire().await.unwrap())
        .await
        .unwrap();
    let hash = crate::auth::hash_password("password1").unwrap();
    for _round in 0..5 {
        let email = addr();
        let mut tx = db.pool.begin().await.unwrap();
        let code = issue_code(&mut tx, st.master_key(), "register", &email, &email, None)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let (st, s, email, hash, code) = (
                st.clone(),
                s.clone(),
                email.clone(),
                hash.clone(),
                code.clone(),
            );
            let pool = db.pool.clone();
            tasks.push(tokio::spawn(async move {
                let mut tx = pool.begin().await.unwrap();
                let r = register::apply_register(
                    &mut tx,
                    st.master_key(),
                    &s,
                    &register::Registration {
                        addr: &email,
                        code: &code,
                        password_hash: &hash,
                        invite_code: None,
                        locale: Locale::Zh,
                        ip: None,
                    },
                )
                .await;
                match r {
                    Ok(Some(_)) => {
                        tx.commit().await.unwrap();
                        true
                    }
                    Ok(None) => {
                        tx.commit().await.unwrap();
                        false
                    }
                    Err(e) => {
                        assert_eq!(e.message(), register::INVALID_CODE);
                        false
                    }
                }
            }));
        }
        let mut wins = 0;
        for t in tasks {
            wins += t.await.unwrap() as i32;
        }
        assert_eq!(wins, 1, "exactly one registration wins");
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email = $1")
            .bind(&email)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    // The address got verified elsewhere after the code was sent.
    let email = addr();
    let mut tx = db.pool.begin().await.unwrap();
    let code = issue_code(&mut tx, st.master_key(), "register", &email, &email, None)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let other = db.user().await;
    verified(&db, other, &email).await;
    let mut tx = db.pool.begin().await.unwrap();
    let r = register::apply_register(
        &mut tx,
        st.master_key(),
        &s,
        &register::Registration {
            addr: &email,
            code: &code,
            password_hash: &hash,
            invite_code: None,
            locale: Locale::Zh,
            ip: None,
        },
    )
    .await;
    assert_eq!(
        r.err().map(|e| e.message().to_string()).as_deref(),
        Some(register::INVALID_CODE)
    );
    drop(tx);
    db.drop().await;
}

#[tokio::test]
async fn invites_domains_and_trial() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    enable_mail(&db).await;
    set_signup(
        &db,
        "register_enabled = true, email_verify = true, invite_required = true, invite_single_use = true, \
         invite_codes_per_user = 2, email_domains = '{example.com}'",
    )
    .await;
    let c = Client::new(&st, rand_ip());
    let o = c.get("/test/auth/options").await.json();
    assert_eq!(o["invite_required"], true);
    assert_eq!(o["email_domains"], json!(["example.com"]));

    // Domain allow-list and invite presence/validity are request checks.
    let r = c
        .post(
            "/test/auth/register/code",
            json!({ "email": "a@gmail.com", "invite_code": "abcdefgh" }),
        )
        .await;
    assert_eq!(r.json()["error"], "email domain not allowed");
    let r = c
        .post("/test/auth/register/code", json!({ "email": addr() }))
        .await;
    assert_eq!(r.json()["error"], "invite code required");
    let r = c
        .post(
            "/test/auth/register/code",
            json!({ "email": addr(), "invite_code": "zzzzzzzz" }),
        )
        .await;
    assert_eq!(r.json()["error"], "invalid invite code");

    // An inviter creates codes (limit 2); admins have none.
    let inviter = with_password(&db, "inviter-pw").await;
    let inviter_email = email_of(&db, inviter).await;
    let mut ic = Client::new(&st, rand_ip());
    assert_eq!(
        ic.login(&inviter_email, "inviter-pw").await.status,
        StatusCode::OK
    );
    let code1 = ic.post("/test/api/v1/me/invite-codes", json!({})).await;
    assert_eq!(code1.status, StatusCode::CREATED);
    let code1 = code1.json()["code"].as_str().unwrap().to_string();
    let code2 = ic
        .post("/test/api/v1/me/invite-codes", json!({}))
        .await
        .json()["code"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        ic.post("/test/api/v1/me/invite-codes", json!({}))
            .await
            .status,
        StatusCode::CONFLICT
    );
    let list = ic.get("/test/api/v1/me/invite-codes").await.json();
    assert_eq!(list["codes"].as_array().unwrap().len(), 2);
    assert_eq!(list["limit"], 2);
    assert_eq!(list["single_use"], true);
    assert_eq!(
        list["link_base"],
        format!("{ORIGIN}/test/app/register?invite=")
    );
    let admin = db.admin().await;
    let mut ac = Client::new(&st, rand_ip());
    ac.cookie = Some(crate::auth::issue_token(&st, admin, "admin", 0).unwrap());
    assert_eq!(
        ac.get("/test/api/v1/me/invite-codes").await.status,
        StatusCode::FORBIDDEN
    );

    // Register with code1 (upper case accepted): attributed to the inviter.
    let email = addr();
    let r = c
        .post(
            "/test/auth/register/code",
            json!({ "email": email, "invite_code": code1.to_uppercase() }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let (_, body) = wait_mail(&db, "register_code", &email).await;
    let r = c
        .post(
            "/test/auth/register",
            json!({ "email": email, "code": code_in(&body), "password": "password1",
                    "invite_code": code1 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["invited"], true);
    let (inv, uses): (Option<Uuid>, i32) = sqlx::query_as(
        "SELECT u.inviter_id, c.uses FROM users u, invite_codes c WHERE u.email = $1 AND c.code = $2",
    )
    .bind(&email)
    .bind(&code1)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!((inv, uses), (Some(inviter), 1));
    assert_eq!(
        ic.get("/test/api/v1/me/invite-codes").await.json()["invited"],
        1
    );

    // Single use: code1 is spent (pre-check and the consuming UPDATE).
    let email2 = addr();
    let r = c
        .post(
            "/test/auth/register/code",
            json!({ "email": email2, "invite_code": code1 }),
        )
        .await;
    assert_eq!(r.json()["error"], "invalid invite code");
    // Spent between code request and completion: the whole registration
    // rolls back (the email code stays usable with another invite).
    let r = c
        .post(
            "/test/auth/register/code",
            json!({ "email": email2, "invite_code": code2 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let (_, body) = wait_mail(&db, "register_code", &email2).await;
    sqlx::query("UPDATE invite_codes SET uses = 1 WHERE code = $1")
        .bind(&code2)
        .execute(&db.pool)
        .await
        .unwrap();
    let reg = |code: String, invite: String| {
        let c = &c;
        let email2 = email2.clone();
        async move {
            c.post(
                "/test/auth/register",
                json!({ "email": email2, "code": code, "password": "password1",
                        "invite_code": invite }),
            )
            .await
        }
    };
    let r = reg(code_in(&body), code2.clone()).await;
    assert_eq!(r.json()["error"], "invalid invite code");
    // Deleting a code; a fresh one admits the registration with the same
    // (still unused) email code.
    assert_eq!(
        ic.req(
            Method::DELETE,
            &format!("/test/api/v1/me/invite-codes/{code2}"),
            None
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    let code3 = ic
        .post("/test/api/v1/me/invite-codes", json!({}))
        .await
        .json()["code"]
        .as_str()
        .unwrap()
        .to_string();
    let r = reg(code_in(&body), code3).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());

    // Trial plan: new accounts get it for N days (disabled plan: skipped).
    let plan = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO plans (id, name, traffic_quota_bytes, reset_period) \
         VALUES ($1, 'trial', 1073741824, 'none')",
    )
    .bind(plan)
    .execute(&db.pool)
    .await
    .unwrap();
    set_signup(
        &db,
        &format!(
            "invite_required = false, trial_plan_id = '{plan}', trial_days = 3, email_domains = '{{}}'"
        ),
    )
    .await;
    let mut tc = Client::new(&st, rand_ip());
    let email3 = addr();
    let r = register_via_api(&mut tc, &db, &email3, "password1").await;
    assert_eq!(r["trial"], true);
    assert_eq!(
        tc.get("/test/api/v1/me").await.status,
        StatusCode::OK,
        "session survives the trial sync"
    );
    let days: f64 = sqlx::query_scalar(
        "SELECT (extract(epoch FROM up.expires_at - now()) / 86400)::float8 FROM user_plans up \
         JOIN users u ON u.id = up.user_id WHERE u.email = $1 AND up.status = 'active'",
    )
    .bind(&email3)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!((2.99..=3.0).contains(&days), "{days}");
    sqlx::query("UPDATE plans SET enabled = false WHERE id = $1")
        .bind(plan)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut tc = Client::new(&st, rand_ip());
    let r = register_via_api(&mut tc, &db, &addr(), "password1").await;
    assert_eq!(
        r["trial"], false,
        "disabled trial plan: registration still succeeds"
    );
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reset_flow_invalidates_sessions() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    enable_mail(&db).await;
    set_signup(&db, "reset_enabled = true").await;
    let id = with_password(&db, "old password").await;
    let email = addr();
    verified(&db, id, &email).await;
    let mut s1 = Client::new(&st, rand_ip());
    assert_eq!(
        s1.login(&email.to_uppercase(), "old password").await.status,
        StatusCode::OK
    );
    let mut s2 = Client::new(&st, rand_ip());
    assert_eq!(
        s2.login(&email, "old password").await.status,
        StatusCode::OK
    );

    let anon = Client::new(&st, rand_ip());
    let r = anon
        .post(
            "/test/auth/password-reset/request",
            json!({ "email": email.to_uppercase() }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let (_, body) = wait_mail(&db, "password_reset", &email).await;
    assert!(
        body.contains(&format!("{ORIGIN}/test/app/reset#token=")),
        "{body}"
    );
    let token = token_in(&body);
    // A second request replaces the first link.
    anon.post(
        "/test/auth/password-reset/request",
        json!({ "email": email }),
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    let token2 = loop {
        let (_, b) = wait_mail(&db, "password_reset", &email).await;
        let t = token_in(&b);
        if t != token {
            break t;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let r = anon
        .post(
            "/test/auth/password-reset",
            json!({ "token": token, "password": "new password" }),
        )
        .await;
    assert_eq!(r.json()["error"], reset::INVALID_LINK, "replaced link");
    let r = anon
        .post(
            "/test/auth/password-reset",
            json!({ "token": token2, "password": "short" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = anon
        .post(
            "/test/auth/password-reset",
            json!({ "token": token2, "password": "new password" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    // Every session ended; the new password works, the old does not.
    assert_eq!(
        s1.get("/test/api/v1/me").await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        s2.get("/test/api/v1/me").await.status,
        StatusCode::UNAUTHORIZED
    );
    let mut c = Client::new(&st, rand_ip());
    assert_eq!(
        c.login(&email, "old password").await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(c.login(&email, "new password").await.status, StatusCode::OK);
    // Single use.
    let r = anon
        .post(
            "/test/auth/password-reset",
            json!({ "token": token2, "password": "third password" }),
        )
        .await;
    assert_eq!(r.json()["error"], reset::INVALID_LINK);
    let audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'user.password.reset' AND target_id = $1",
    )
    .bind(id.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audit, 1);

    // Expired link; link bound to the address it was sent to.
    let mut tx = db.pool.begin().await.unwrap();
    assert!(reset::apply_send_link(&mut tx, &st, &email).await.unwrap());
    tx.commit().await.unwrap();
    let (_, b) = wait_mail(&db, "password_reset", &email).await;
    let t3 = token_in(&b);
    sqlx::query("UPDATE password_resets SET expires_at = now() - interval '1 second'")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = anon
        .post(
            "/test/auth/password-reset",
            json!({ "token": t3, "password": "new password 2" }),
        )
        .await;
    assert_eq!(r.json()["error"], reset::INVALID_LINK, "expired");
    let mut tx = db.pool.begin().await.unwrap();
    assert!(reset::apply_send_link(&mut tx, &st, &email).await.unwrap());
    tx.commit().await.unwrap();
    let (_, b) = wait_mail(&db, "password_reset", &email).await;
    let t4 = token_in(&b);
    let moved = addr();
    verified(&db, id, &moved).await;
    let r = anon
        .post(
            "/test/auth/password-reset",
            json!({ "token": t4, "password": "new password 2" }),
        )
        .await;
    assert_eq!(
        r.json()["error"],
        reset::INVALID_LINK,
        "address changed since"
    );

    // No link for: unverified addresses, admin-disabled accounts, no main
    // domain configured.
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("UPDATE users SET email_verified_at = NULL WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(!reset::apply_send_link(&mut tx, &st, &moved).await.unwrap());
    sqlx::query("UPDATE users SET email_verified_at = now(), enabled = false WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(!reset::apply_send_link(&mut tx, &st, &moved).await.unwrap());
    sqlx::query("UPDATE users SET enabled = true WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let bare = AppState::for_test(db.pool.clone()).await;
    assert!(
        !reset::apply_send_link(&mut tx, &bare, &moved)
            .await
            .unwrap()
    );
    assert!(reset::apply_send_link(&mut tx, &st, &moved).await.unwrap());
    tx.rollback().await.unwrap();
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Email change, locale
// ---------------------------------------------------------------------------

#[tokio::test]
async fn email_change_needs_password_and_code() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    let mut c = Client::new(&st, rand_ip());
    // A registered account.
    enable_mail(&db).await;
    set_signup(&db, "register_enabled = true, email_verify = true").await;
    let first = addr();
    register_via_api(&mut c, &db, &first, "password1").await;
    let id = user_id(&db, &first).await;

    let new = addr();
    let r = c
        .post(
            "/test/api/v1/me/email/code",
            json!({ "email": new, "password": "wrong" }),
        )
        .await;
    assert_eq!(r.json()["error"], "invalid password");
    let r = c
        .post(
            "/test/api/v1/me/email/code",
            json!({ "email": "bad", "password": "password1" }),
        )
        .await;
    assert_eq!(r.json()["error"], "invalid email address");
    let r = c
        .post(
            "/test/api/v1/me/email/code",
            json!({ "email": new, "password": "password1" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let (_, body) = wait_mail(&db, "email_code", &new).await;
    assert!(body.contains("confirm this address"), "en account: {body}");
    let code = code_in(&body);
    let wrong = if code == "999999" { "999998" } else { "999999" };
    let r = c
        .post("/test/api/v1/me/email/verify", json!({ "code": wrong }))
        .await;
    assert_eq!(r.json()["error"], register::INVALID_CODE);
    let r = c
        .post("/test/api/v1/me/email/verify", json!({ "code": code }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["email"], new);
    assert_eq!(email_of(&db, id).await, new, "the login is the new address");
    let mut nc = Client::new(&st, rand_ip());
    assert_eq!(nc.login(&new, "password1").await.status, StatusCode::OK);
    assert_eq!(
        nc.login(&first, "password1").await.status,
        StatusCode::UNAUTHORIZED,
        "the old address is no login any more"
    );
    let me = c.get("/test/api/v1/me").await.json();
    assert_eq!(
        (me["email"].clone(), me["email_verified"].clone()),
        (json!(new), json!(true))
    );
    let r = c
        .post("/test/api/v1/me/email/verify", json!({ "code": code }))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "single use");

    // An admin-created account changes its address the same way.
    let other = with_password(&db, "other-pw").await;
    let other_email = email_of(&db, other).await;
    let mut oc = Client::new(&st, rand_ip());
    assert_eq!(
        oc.login(&other_email, "other-pw").await.status,
        StatusCode::OK
    );
    let mine = addr();
    oc.post(
        "/test/api/v1/me/email/code",
        json!({ "email": mine, "password": "other-pw" }),
    )
    .await;
    let (_, body) = wait_mail(&db, "email_code", &mine).await;
    let r = oc
        .post(
            "/test/api/v1/me/email/verify",
            json!({ "code": code_in(&body) }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(email_of(&db, other).await, mine);

    // Another account's address: same answer, no mail, no code.
    let before = mail_count(&db, &new).await;
    let r = oc
        .post(
            "/test/api/v1/me/email/code",
            json!({ "email": new, "password": "other-pw" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    settle().await;
    assert_eq!(mail_count(&db, &new).await, before);

    // Locale.
    assert_eq!(
        c.req(
            Method::PUT,
            "/test/api/v1/me/locale",
            Some(json!({ "locale": "en" }))
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(c.get("/test/api/v1/me").await.json()["locale"], "en");
    assert_eq!(
        c.req(
            Method::PUT,
            "/test/api/v1/me/locale",
            Some(json!({ "locale": "fr" }))
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );

    // Mail sending off: a clear 409, not a silent success.
    sqlx::query("UPDATE mail_settings SET enabled = false")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c
        .post(
            "/test/api/v1/me/email/code",
            json!({ "email": addr(), "password": "password1" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Settings API
// ---------------------------------------------------------------------------

#[tokio::test]
async fn settings_api_validates_seals_and_audits() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    let admin = db.admin().await;
    let mut c = Client::new(&st, rand_ip());
    c.cookie = Some(crate::auth::issue_token(&st, admin, "admin", 0).unwrap());
    let s = c.get("/test/api/v1/settings/signup").await.json();
    assert_eq!(s["register_enabled"], false);
    assert_eq!(s["public_origin"], ORIGIN);
    let put = |v: i64, extra: Value| {
        let mut b = json!({
            "version": v, "register_enabled": true, "invite_required": false,
            "invite_single_use": false, "invite_codes_per_user": 5, "email_domains": [],
            "trial_plan_id": null, "trial_days": 7, "reset_enabled": true,
            "email_verify": false,
        });
        for (k, val) in extra.as_object().unwrap() {
            b[k] = val.clone();
        }
        b
    };
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/settings/signup",
            Some(put(0, json!({}))),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT, "mail must be enabled first");

    let mail = |v: i64, extra: Value| {
        let mut b = json!({
            "version": v, "enabled": true, "host": "smtp.example.com", "port": 465,
            "security": "tls", "username": "mailer", "password": "s3cret-pw",
            "from_addr": "No-Reply@Example.com", "from_name": "Akari 测试",
            "notify_order_paid": true, "notify_expiry_days": 3, "notify_expired": true,
            "notify_quota": true,
        });
        for (k, val) in extra.as_object().unwrap() {
            b[k] = val.clone();
        }
        b
    };
    for (bad, why) in [
        (json!({ "security": "none" }), "credentials over plain text"),
        (json!({ "host": "bad host" }), "host"),
        (json!({ "port": 0 }), "port"),
        (json!({ "from_addr": "nope" }), "from"),
        (json!({ "from_addr": null }), "enabled without sender"),
        (json!({ "notify_expiry_days": 31 }), "days"),
        (json!({ "from_name": "x".repeat(65) }), "name"),
        (json!({ "extra": 1 }), "unknown field"),
    ] {
        let r = c
            .req(
                Method::PUT,
                "/test/api/v1/settings/mail",
                Some(mail(0, bad)),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{why}");
    }
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/settings/mail",
            Some(mail(0, json!({}))),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let v = r.json();
    assert_eq!(v["password_set"], true);
    assert_eq!(v["from_addr"], "no-reply@example.com");
    assert!(v.get("password").is_none() && !r.body.windows(9).any(|w| w == b"s3cret-pw"));
    let sealed: Vec<u8> = sqlx::query_scalar("SELECT password_enc FROM mail_settings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(!sealed.windows(9).any(|w| w == b"s3cret-pw"));
    assert_eq!(
        st.master_key()
            .open(crate::mail::SMTP_AAD, &sealed)
            .as_deref(),
        Some(&b"s3cret-pw"[..])
    );
    // Stale version; keep password when absent; audit never holds it.
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/settings/mail",
            Some(mail(0, json!({}))),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let mut keep = mail(1, json!({ "port": 587, "security": "starttls" }));
    keep.as_object_mut().unwrap().remove("password");
    let r = c
        .req(Method::PUT, "/test/api/v1/settings/mail", Some(keep))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let still: Vec<u8> = sqlx::query_scalar("SELECT password_enc FROM mail_settings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        st.master_key()
            .open(crate::mail::SMTP_AAD, &still)
            .as_deref(),
        Some(&b"s3cret-pw"[..])
    );
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT coalesce(before::text, '') || coalesce(after::text, '') FROM audit_log \
         WHERE action LIKE 'settings.%'",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(audit.len(), 2);
    assert!(audit.iter().all(|a| !a.contains("s3cret")), "{audit:?}");
    // Clearing the username drops the password.
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/settings/mail",
            Some(mail(
                2,
                json!({ "username": null, "security": "none", "port": 1025 }),
            )),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["password_set"], false);
    assert!(r.json()["warnings"].as_array().unwrap().len() == 1);

    // Now registration/reset can be enabled; domains are normalised.
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/settings/signup",
            Some(put(
                0,
                json!({ "email_domains": ["Example.com", "@qq.com"] }),
            )),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["email_domains"], json!(["example.com", "qq.com"]));
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/settings/signup",
            Some(put(1, json!({ "trial_plan_id": Uuid::new_v4() }))),
        )
        .await;
    assert_eq!(r.json()["error"], "unknown trial plan");
    // Reset needs a main domain.
    let bare = AppState::for_test(db.pool.clone()).await;
    let mut bc = Client::new(&bare, rand_ip());
    bc.cookie = c.cookie.clone();
    sqlx::query("UPDATE signup_settings SET reset_enabled = false")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = bc
        .req(
            Method::PUT,
            "/test/api/v1/settings/signup",
            Some(put(1, json!({}))),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{:?}", r.json());
    // Non-admins get 403.
    let u = with_password(&db, "pw").await;
    let mut uc = Client::new(&st, rand_ip());
    let sv: i64 = sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    uc.cookie = Some(crate::auth::issue_token(&st, u, "user", sv).unwrap());
    for p in [
        "/test/api/v1/settings/signup",
        "/test/api/v1/settings/mail",
        "/test/api/v1/mail/outbox",
    ] {
        assert_eq!(uc.get(p).await.status, StatusCode::FORBIDDEN, "{p}");
    }
    db.drop().await;
}

/// Mail send rate limits: per destination address, across client
/// addresses; refused requests are 429 for every address alike.
#[tokio::test]
async fn send_rate_limits() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    enable_mail(&db).await;
    set_signup(&db, "register_enabled = true, email_verify = true").await;
    let email = addr();
    for i in 0..SEND_PER_ADDR_HOUR {
        let c = Client::new(&st, rand_ip());
        let r = c
            .post("/test/auth/register/code", json!({ "email": email }))
            .await;
        assert_eq!(r.status, StatusCode::OK, "#{i}");
    }
    let c = Client::new(&st, rand_ip());
    let r = c
        .post("/test/auth/register/code", json!({ "email": email }))
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // Per client address.
    let c = Client::new(&st, rand_ip());
    for _ in 0..SEND_PER_IP_HOUR {
        assert_eq!(
            c.post("/test/auth/register/code", json!({ "email": addr() }))
                .await
                .status,
            StatusCode::OK
        );
    }
    assert_eq!(
        c.post("/test/auth/register/code", json!({ "email": addr() }))
            .await
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    db.drop().await;
}

// ---------------------------------------------------------------------------
// W24: registration without email verification
// ---------------------------------------------------------------------------

/// A solved proof-of-work for the next unverified registration.
async fn pow(c: &Client) -> Value {
    let r = c.get("/test/auth/register/challenge").await;
    assert_eq!(r.status, StatusCode::OK, "challenge");
    assert_eq!(r.headers["cache-control"], "no-store");
    let ch = r.json()["challenge"].as_str().unwrap().to_string();
    assert_eq!(r.json()["bits"], pow::BITS);
    let nonce = pow::solve(&ch, pow::BITS);
    json!({ "challenge": ch, "nonce": nonce })
}

async fn register_unverified(
    c: &mut Client,
    email: &str,
    password: &str,
) -> crate::testdb::http::Resp {
    let p = pow(c).await;
    c.post(
        "/test/auth/register",
        json!({ "email": email, "password": password, "pow": p }),
    )
    .await
}

#[tokio::test]
async fn registration_without_verification() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    // No SMTP at all: registration can still be switched on (no verification).
    let admin = db.admin().await;
    let ca = crate::testdb::http::client_for(&st, admin).await;
    let mut r = req(&[]);
    r.trial_days = 1;
    let r = ca
        .req(
            Method::PUT,
            "/test/api/v1/settings/signup",
            Some(serde_json::to_value(SignupReqJson::from(&r)).unwrap()),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["email_verify"], false);
    assert!(r.json()["warnings"].to_string().contains("注册不验证邮箱"));

    let mut c = Client::new(&st, rand_ip());
    let canonical = c.get("/test/definitely/not/here").await.fingerprint();
    let o = c.get("/test/auth/options").await.json();
    assert_eq!(
        (o["register"].clone(), o["email_verify"].clone()),
        (json!(true), json!(false))
    );
    // The code step does not exist in this mode.
    check_rejected(&c, &["/test/auth/register/code"], &canonical).await;

    let email = addr();
    let upper = email.to_uppercase();
    let r = register_unverified(&mut c, &upper, "correct horse").await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["email"], email);
    assert_eq!(r.json()["email_verified"], false);
    c.cookie = r.session_cookie();
    let me = c.get("/test/api/v1/me").await.json();
    assert_eq!(me["email"], email);
    assert_eq!(me["email_verified"], false);
    let id = user_id(&db, &email).await;
    let audit: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'user.register' AND target_id = $1",
    )
    .bind(id.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audit["email_verified"], false);
    assert_eq!(audit["password"], "changed");
    assert_eq!(mail_count(&db, &email).await, 0, "nothing is mailed");

    // Logs in with the address, any case.
    for l in [&email, &upper] {
        let mut c2 = Client::new(&st, rand_ip());
        assert_eq!(
            c2.login(l, "correct horse").await.status,
            StatusCode::OK,
            "{l}"
        );
    }

    // The same address again (any case) or another account's address,
    // verified or not (D1: every address is a login name): one generic
    // answer.
    let other = with_password(&db, "pw-of-other").await;
    let taken_verified = addr();
    verified(&db, other, &taken_verified).await;
    let taken_unverified = addr();
    sqlx::query("UPDATE users SET email = $2 WHERE id = $1")
        .bind(db.user().await)
        .bind(&taken_unverified)
        .execute(&db.pool)
        .await
        .unwrap();
    for a in [&email, &upper, &taken_verified, &taken_unverified] {
        let r = register_unverified(&mut Client::new(&st, rand_ip()), a, "whatever pw").await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{a}");
        assert_eq!(r.json()["code"], "signup.unavailable", "{a}");
        assert!(r.session_cookie().is_none());
    }

    // Proof of work: missing, wrong, replayed, forged.
    let c3 = Client::new(&st, rand_ip());
    let r = c3
        .post(
            "/test/auth/register",
            json!({ "email": addr(), "password": "long enough" }),
        )
        .await;
    assert_eq!(r.json()["code"], "signup.challenge_invalid");
    let p = pow(&c3).await;
    // A nonce that misses the difficulty: a fixed one meets it for about one
    // challenge in 2^BITS (2^10 under test), so pick one that provably fails.
    let ch = p["challenge"].as_str().unwrap();
    let wrong = (0u32..)
        .map(|n| format!("wrong{n}"))
        .find(|n| {
            pow::leading_zero_bits(&Sha256::digest(format!("{ch}:{n}").as_bytes())) < pow::BITS
        })
        .unwrap();
    let r = c3
        .post(
            "/test/auth/register",
            json!({ "email": addr(), "password": "long enough",
                    "pow": { "challenge": p["challenge"], "nonce": wrong } }),
        )
        .await;
    assert_eq!(r.json()["code"], "signup.challenge_invalid");
    let r = c3
        .post(
            "/test/auth/register",
            json!({ "email": addr(), "password": "long enough", "pow": p }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let r = c3
        .post(
            "/test/auth/register",
            json!({ "email": addr(), "password": "long enough", "pow": p }),
        )
        .await;
    assert_eq!(r.json()["code"], "signup.challenge_invalid", "single use");
    let forged = crate::masterkey::Keys::from_material(&[9; 32]).unwrap();
    let ch = pow::issue(&forged, chrono::Utc::now().timestamp());
    let r = c3
        .post(
            "/test/auth/register",
            json!({ "email": addr(), "password": "long enough",
                    "pow": { "challenge": ch, "nonce": pow::solve(&ch, pow::BITS) } }),
        )
        .await;
    assert_eq!(r.json()["code"], "signup.challenge_invalid", "foreign key");
    // Request validation (no account involved).
    let r = register_unverified(&mut Client::new(&st, rand_ip()), "nope", "long enough").await;
    assert_eq!(r.json()["code"], "signup.invalid_email");
    let r = register_unverified(&mut Client::new(&st, rand_ip()), &addr(), "short").await;
    assert_eq!(r.json()["code"], "account.password_too_short");

    // Invite required + domain allow-list keep working.
    set_signup(
        &db,
        "invite_required = true, email_domains = '{allowed.example}'",
    )
    .await;
    let r = register_unverified(&mut Client::new(&st, rand_ip()), &addr(), "long enough").await;
    assert_eq!(r.json()["code"], "signup.domain_not_allowed");
    // Fresh addresses every run: the per-address limits live in the shared
    // (dev) Valkey, not in this test's schema.
    let allowed = |n: u8| format!("x{n}-{}@allowed.example", Uuid::new_v4().simple());
    let r = register_unverified(&mut Client::new(&st, rand_ip()), &allowed(1), "long enough").await;
    assert_eq!(r.json()["code"], "signup.invite_required");
    sqlx::query("INSERT INTO invite_codes (code, user_id) VALUES ('w24invite', $1)")
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut c4 = Client::new(&st, rand_ip());
    let p = pow(&c4).await;
    let x2 = allowed(2);
    let r = c4
        .post(
            "/test/auth/register",
            json!({ "email": x2, "password": "long enough", "pow": p,
                    "invite_code": "W24INVITE" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["invited"], true);
    c4.cookie = r.session_cookie();
    let inviter: Option<Uuid> = sqlx::query_scalar("SELECT inviter_id FROM users WHERE email = $1")
        .bind(&x2)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(inviter, Some(id));

    // Explicit verification ON without SMTP: refused (409 mail_off).
    let mut v = req(&[]);
    v.version = sqlx::query_scalar("SELECT version FROM signup_settings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    v.email_verify = true;
    let r = ca
        .req(
            Method::PUT,
            "/test/api/v1/settings/signup",
            Some(serde_json::to_value(SignupReqJson::from(&v)).unwrap()),
        )
        .await;
    assert_eq!(r.json()["code"], "signup_admin.mail_off");
    // With SMTP on it is accepted: the challenge endpoint closes, the code
    // endpoint opens. SMTP alone does not switch verification on (v0.4:
    // an explicit switch).
    enable_mail(&db).await;
    assert_eq!(
        c.get("/test/auth/options").await.json()["email_verify"],
        false
    );
    let r = ca
        .req(
            Method::PUT,
            "/test/api/v1/settings/signup",
            Some(serde_json::to_value(SignupReqJson::from(&v)).unwrap()),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    check_rejected(&c, &["/test/auth/register/challenge"], &canonical).await;
    assert_eq!(
        c.get("/test/auth/options").await.json()["email_verify"],
        true
    );
    // Explicitly OFF with SMTP on: back to this mode.
    set_signup(&db, "email_verify = false").await;
    assert_eq!(
        c.get("/test/auth/options").await.json()["email_verify"],
        false
    );
    db.drop().await;
}

/// The settings request as JSON (SignupReq is Deserialize only).
#[derive(serde::Serialize)]
struct SignupReqJson {
    version: i64,
    register_enabled: bool,
    invite_required: bool,
    invite_single_use: bool,
    invite_codes_per_user: i32,
    email_domains: Vec<String>,
    trial_plan_id: Option<Uuid>,
    trial_days: i32,
    reset_enabled: bool,
    email_verify: bool,
}

impl From<&SignupReq> for SignupReqJson {
    fn from(r: &SignupReq) -> Self {
        Self {
            version: r.version,
            register_enabled: r.register_enabled,
            invite_required: r.invite_required,
            invite_single_use: r.invite_single_use,
            invite_codes_per_user: r.invite_codes_per_user,
            email_domains: r.email_domains.clone(),
            trial_plan_id: r.trial_plan_id,
            trial_days: r.trial_days,
            reset_enabled: r.reset_enabled,
            email_verify: r.email_verify,
        }
    }
}

/// Concurrent unverified registrations of one address (any case): exactly
/// one account, every other attempt the generic answer.
#[tokio::test]
async fn racing_unverified_registrations() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    set_signup(&db, "register_enabled = true").await;
    let s = load_settings(&mut db.pool.acquire().await.unwrap())
        .await
        .unwrap();
    let email = addr();
    let hash = crate::auth::hash_password("long enough").unwrap();
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let (st, s, email, hash) = (st.clone(), s.clone(), email.clone(), hash.clone());
        tasks.push(tokio::spawn(async move {
            let mut tx = st.pg().begin().await.unwrap();
            let r = register::apply_register_unverified(
                &mut tx,
                &s,
                &register::Unverified {
                    addr: &email,
                    password_hash: &hash,
                    invite_code: None,
                    locale: Locale::Zh,
                    ip: None,
                },
            )
            .await;
            match r {
                Ok(_) => {
                    tx.commit().await.unwrap();
                    Ok(())
                }
                Err(e) => Err(e.code().to_string()),
            }
        }));
    }
    let mut ok = 0;
    for t in tasks {
        match t.await.unwrap() {
            Ok(()) => ok += 1,
            Err(code) => assert_eq!(code, "signup.unavailable"),
        }
    }
    assert_eq!(ok, 1);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email = $1")
        .bind(&email)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    // D1: another account's address, even unverified, is taken; the admin
    // can still vouch for it on the account that holds it.
    let other = with_password(&db, "pw").await;
    let addr2 = addr();
    sqlx::query("UPDATE users SET email = $2 WHERE id = $1")
        .bind(other)
        .bind(&addr2)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut tx = st.pg().begin().await.unwrap();
    let e = register::apply_register_unverified(
        &mut tx,
        &s,
        &register::Unverified {
            addr: &addr2,
            password_hash: &hash,
            invite_code: None,
            locale: Locale::Zh,
            ip: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.code(), "signup.unavailable");
    drop(tx);
    let mut tx = st.pg().begin().await.unwrap();
    let got = profile::apply_admin_verify(&mut tx, &crate::audit::Actor::test(), other)
        .await
        .unwrap();
    assert_eq!(got, addr2);
    tx.commit().await.unwrap();
    db.drop().await;
}

/// Per-address and per-client limits of unverified registration.
#[tokio::test]
async fn unverified_registration_rate_limits() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    set_signup(&db, "register_enabled = true").await;
    // Per client: 5 attempts per hour, successful or not.
    let ip = rand_ip();
    for i in 0..REGISTER_PER_IP_HOUR {
        let r = register_unverified(&mut Client::new(&st, ip), &addr(), "long enough").await;
        assert_eq!(r.status, StatusCode::OK, "attempt {i}: {:?}", r.json());
    }
    let r = register_unverified(&mut Client::new(&st, ip), &addr(), "long enough").await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // Per address: 5 attempts per hour from anywhere.
    let a = addr();
    let first = register_unverified(&mut Client::new(&st, rand_ip()), &a, "long enough").await;
    assert_eq!(first.status, StatusCode::OK);
    for _ in 1..REGISTER_PER_ADDR_HOUR {
        let r = register_unverified(&mut Client::new(&st, rand_ip()), &a, "long enough").await;
        assert_eq!(r.json()["code"], "signup.unavailable");
    }
    let r = register_unverified(&mut Client::new(&st, rand_ip()), &a, "long enough").await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    db.drop().await;
}

/// An account registered without verification verifies its address later
/// (once SMTP is on) through the portal's email flow; reset needs it; an
/// admin can also mark it verified.
#[tokio::test]
async fn unverified_account_verifies_later() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state(&db).await;
    set_signup(&db, "register_enabled = true, email_verify = false").await;
    let email = addr();
    let mut c = Client::new(&st, rand_ip());
    let r = register_unverified(&mut c, &email, "correct horse").await;
    assert_eq!(r.status, StatusCode::OK);
    c.cookie = r.session_cookie();
    // No mail yet: the portal's verification answers "mail off".
    let r = c
        .post(
            "/test/api/v1/me/email/code",
            json!({ "email": email, "password": "correct horse" }),
        )
        .await;
    assert_eq!(r.json()["code"], "account.mail_off");
    // Reset is not for unverified addresses (no mail is queued).
    enable_mail(&db).await;
    set_signup(&db, "reset_enabled = true").await;
    let r = c
        .post(
            "/test/auth/password-reset/request",
            json!({ "email": email }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    settle().await;
    assert_eq!(mail_count(&db, &email).await, 0);
    // Verify the same address: code → verified, address unchanged.
    let r = c
        .post(
            "/test/api/v1/me/email/code",
            json!({ "email": email, "password": "correct horse" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let (_, body) = wait_mail(&db, "email_code", &email).await;
    let r = c
        .post(
            "/test/api/v1/me/email/verify",
            json!({ "code": code_in(&body) }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let id = user_id(&db, &email).await;
    assert_eq!(email_of(&db, id).await, email);
    assert_eq!(
        c.get("/test/api/v1/me").await.json()["email_verified"],
        true
    );
    // Admin: mark another unverified account verified (idempotent, audited).
    let email2 = addr();
    let r = register_unverified(&mut Client::new(&st, rand_ip()), &email2, "long enough").await;
    assert_eq!(r.status, StatusCode::OK);
    let id2 = user_id(&db, &email2).await;
    let admin = db.admin().await;
    let ca = crate::testdb::http::client_for(&st, admin).await;
    for _ in 0..2 {
        let r = ca
            .post(&format!("/test/api/v1/users/{id2}/email/verify"), json!({}))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
        assert_eq!(r.json()["email_verified"], true);
    }
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'user.email.verify' AND target_id = $1",
    )
    .bind(id2.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(n, 1);
    let r = ca
        .post(
            &format!("/test/api/v1/users/{}/email/verify", Uuid::new_v4()),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let cu = crate::testdb::http::client_for(&st, id).await;
    let r = cu
        .post(&format!("/test/api/v1/users/{id2}/email/verify"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    db.drop().await;
}
