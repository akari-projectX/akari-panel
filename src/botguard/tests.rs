//! v0.4 bot protection: form tokens, honeypot, minimum submit time and
//! Turnstile — unit, real-DB and HTTP (through `web::router`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{Value, json};
use uuid::Uuid;

use super::*;
use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

fn keys() -> crate::masterkey::Keys {
    crate::masterkey::Keys::from_material(&[3u8; 32]).unwrap()
}

fn settings(honeypot: bool, min: i32) -> Settings {
    Settings {
        version: 0,
        turnstile_site_key: None,
        turnstile_secret_enc: None,
        turnstile_login: false,
        turnstile_register: false,
        turnstile_reset: false,
        honeypot,
        min_submit_secs: min,
        passkey_only_admins: false,
        passkey_only_users: false,
        passkey_prompt: false,
    }
}

fn guard(token: Option<String>, website: Option<&str>) -> Guard {
    Guard {
        form_token: token,
        website: website.map(String::from),
        turnstile: None,
    }
}

#[test]
fn form_tokens_carry_their_age_and_resist_tampering() {
    let k = keys();
    let now = 1_800_000_000_000i64;
    let t = issue_token(&k, now - 5_000);
    assert_eq!(token_age_ms(&k, &t, now), Some(5_000));
    assert_ne!(issue_token(&k, now), issue_token(&k, now), "fresh nonce");
    // Another master key, a flipped byte, junk: not tokens.
    assert_eq!(
        token_age_ms(
            &crate::masterkey::Keys::from_material(&[4u8; 32]).unwrap(),
            &t,
            now
        ),
        None
    );
    let mut raw = URL_SAFE_NO_PAD.decode(&t).unwrap();
    raw[3] ^= 1; // the issue time: the MAC no longer matches
    assert_eq!(token_age_ms(&k, &URL_SAFE_NO_PAD.encode(&raw), now), None);
    for junk in ["", "x", &"A".repeat(43), &"A".repeat(200)] {
        assert_eq!(token_age_ms(&k, junk, now), None, "{junk}");
    }
}

#[test]
fn trap_reasons() {
    let k = keys();
    let now = 1_800_000_000_000i64;
    let old = issue_token(&k, now - 3_000);
    let fresh = issue_token(&k, now - 500);
    let stale = issue_token(&k, now - FORM_TOKEN_MAX_AGE_MS - 1);
    let future = issue_token(&k, now + 60_000);
    let on = settings(true, 2);
    assert_eq!(
        trap_reason(&k, &on, Some(&guard(Some(old.clone()), None)), now),
        None
    );
    assert_eq!(
        trap_reason(&k, &on, Some(&guard(Some(old.clone()), Some(""))), now),
        None,
        "empty honeypot"
    );
    assert_eq!(
        trap_reason(
            &k,
            &on,
            Some(&guard(Some(old.clone()), Some("http://spam"))),
            now
        ),
        Some("honeypot")
    );
    assert_eq!(
        trap_reason(&k, &on, Some(&guard(Some(fresh), None)), now),
        Some("too_fast")
    );
    assert_eq!(
        trap_reason(&k, &on, Some(&guard(Some(stale), None)), now),
        Some("bad_token")
    );
    assert_eq!(
        trap_reason(&k, &on, Some(&guard(Some(future), None)), now),
        Some("bad_token")
    );
    assert_eq!(
        trap_reason(&k, &on, Some(&guard(None, None)), now),
        Some("bad_token")
    );
    assert_eq!(
        trap_reason(&k, &on, None, now),
        Some("bad_token"),
        "no guard at all"
    );
    // Switched off: nothing is required.
    let off = settings(false, 0);
    assert_eq!(trap_reason(&k, &off, None, now), None);
    assert_eq!(
        trap_reason(&k, &off, Some(&guard(None, Some("bot"))), now),
        None
    );
    // Honeypot only.
    assert_eq!(trap_reason(&k, &settings(true, 0), None, now), None);
    assert_eq!(
        trap_reason(&k, &settings(true, 0), Some(&guard(None, Some("x"))), now),
        Some("honeypot")
    );
}

// ---------------------------------------------------------------------------
// Real database + HTTP
// ---------------------------------------------------------------------------

/// A siteverify mock: answers `{"success": <token == "good-token">}` with
/// `status`, recording the form bodies it received.
#[derive(Clone, Default)]
struct Verifier {
    got: Arc<Mutex<Vec<String>>>,
    status: Arc<Mutex<u16>>,
}

impl Verifier {
    async fn start() -> (Self, String) {
        let v = Verifier::default();
        *v.status.lock().unwrap() = 200;
        let vv = v.clone();
        let app = axum::Router::new().fallback(move |body: String| {
            let vv = vv.clone();
            async move {
                let response = form_urlencoded::parse(body.as_bytes())
                    .find(|(k, _)| k == "response")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                vv.got.lock().unwrap().push(body);
                let s = *vv.status.lock().unwrap();
                // "codes:a,b" = a refusal carrying Cloudflare's error codes.
                let answer = match response.strip_prefix("codes:") {
                    Some(c) => {
                        json!({ "success": false, "error-codes": c.split(',').collect::<Vec<_>>() })
                    }
                    None => json!({ "success": response == "good-token" }),
                };
                (StatusCode::from_u16(s).unwrap(), answer.to_string())
            }
        });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(l, app).await;
        });
        (v, format!("http://{addr}/siteverify"))
    }
}

async fn account(db: &TestDb, pw: &str) -> (Uuid, String) {
    let id = db.user().await;
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(id)
        .bind(crate::auth::hash_password(pw).unwrap())
        .execute(&db.pool)
        .await
        .unwrap();
    (id, crate::testdb::test_email(id))
}

async fn set(db: &TestDb, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE auth_settings SET {sql} WHERE id = 1"
    )))
    .execute(&db.pool)
    .await
    .unwrap();
}

/// What a client observes, minus the per-request id.
fn seen(r: &crate::testdb::http::Resp) -> crate::testdb::http::Fingerprint {
    let (st, h, b) = r.fingerprint();
    (
        st,
        h.into_iter().filter(|(k, _)| k != "x-request-id").collect(),
        b,
    )
}

fn login_body(email: &str, pw: &str, guard: Value) -> Value {
    json!({ "email": email, "password": pw, "guard": guard })
}

/// The default (honeypot + 2 s) end to end: `/auth/options` hands out a
/// token; a trapped login — honeypot filled, token too fresh, missing or
/// forged — is byte-identical to a wrong password and counts like one;
/// an aged token logs in. Trapped mail requests answer `{"ok":true}` and
/// send nothing; a trapped registration gets the generic refusal.
#[tokio::test]
async fn honeypot_and_minimum_submit_time() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    set(&db, "min_submit_secs = 2, honeypot = true").await;
    let (_, email) = account(&db, "right-password").await;
    let c = Client::new(&st, rand_ip());

    let o = c.get("/test/auth/options").await;
    assert_eq!(o.headers["cache-control"], "no-store");
    let g = o.json()["guard"].clone();
    assert_eq!(
        (g["form_min_secs"].clone(), g["honeypot"].clone()),
        (json!(2), json!(true))
    );
    assert!(g["turnstile"].is_null());
    let issued = g["form_token"].as_str().unwrap().to_string();
    assert!(
        token_age_ms(
            st.master_key(),
            &issued,
            chrono::Utc::now().timestamp_millis()
        )
        .is_some()
    );

    let wrong = c
        .post(
            "/test/auth/login",
            login_body(&email, "wrong-password", json!({})),
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let aged = issue_token(
        st.master_key(),
        chrono::Utc::now().timestamp_millis() - 3_000,
    );
    let forged = URL_SAFE_NO_PAD.encode([0u8; TOKEN_LEN]);
    for (what, gd) in [
        (
            "honeypot",
            json!({ "form_token": aged, "website": "http://spam.example" }),
        ),
        // Issued just before its post (a slow, instrumented run must not
        // age it past the minimum).
        ("too fast", Value::Null),
        ("no token", json!({})),
        ("forged", json!({ "form_token": forged })),
    ] {
        let gd = if gd.is_null() {
            json!({ "form_token": issue_token(st.master_key(), chrono::Utc::now().timestamp_millis()) })
        } else {
            gd
        };
        let r = c
            .post("/test/auth/login", login_body(&email, "right-password", gd))
            .await;
        assert_eq!(seen(&r), seen(&wrong), "{what}");
    }
    let r = c
        .post(
            "/test/auth/login",
            json!({ "email": email, "password": "right-password" }),
        )
        .await;
    assert_eq!(seen(&r), seen(&wrong), "no guard object");
    // Each trap counted like a wrong password (5 traps + 1 wrong).
    let n: i64 =
        fred::prelude::KeysInterface::get(st.valkey(), &crate::login_limit::keys("x", &email)[1])
            .await
            .unwrap();
    assert_eq!(n, 6);
    let ok = c
        .post(
            "/test/auth/login",
            login_body(
                &email,
                "right-password",
                json!({ "form_token": aged, "website": "" }),
            ),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{:?}", ok.json());
    assert!(ok.session_cookie().is_some());

    // Registration (unverified mode) and reset: the ordinary answers.
    sqlx::query(
        "UPDATE signup_settings SET register_enabled = true, reset_enabled = true WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let r = c
        .post(
            "/test/auth/register",
            json!({ "email": "bot@example.com", "password": "long enough",
                    "pow": { "challenge": "x", "nonce": "y" }, "guard": { "website": "x" } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "signup.unavailable");
    let r = c
        .post(
            "/test/auth/password-reset/request",
            json!({ "email": email, "guard": { "form_token": issue_token(st.master_key(), 0) } }),
        )
        .await;
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::OK, json!({ "ok": true }))
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mails: i64 = sqlx::query_scalar("SELECT count(*) FROM mail_outbox")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(mails, 0, "a trapped request sends nothing");
    let _: i64 = fred::prelude::KeysInterface::del(
        st.valkey(),
        crate::login_limit::keys(&crate::client_ip::bucket(c.ip), &email).to_vec(),
    )
    .await
    .unwrap();
    db.drop().await;
}

/// Turnstile: settings (secret sealed, write-only, audited as "changed";
/// a form switch needs both keys), the public site key, and the login fail
/// closed — missing / rejected token = 400, verifier down = 503, a good
/// token logs in; the verifier gets secret, token and client address.
#[tokio::test]
async fn turnstile_settings_and_login() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (verifier, url) = Verifier::start().await;
    let st =
        AppState::for_test_with(db.pool.clone(), |c| c.limits.turnstile_verify_url = url).await;
    let admin = client_for(&st, db.admin().await).await;
    let (_, email) = account(&db, "right-password").await;

    let v = admin.get("/test/api/v1/settings/auth").await.json();
    assert_eq!(
        v,
        json!({ "version": 0, "turnstile_site_key": null, "turnstile_secret_set": false,
                "turnstile_login": false, "turnstile_register": false, "turnstile_reset": false,
                "honeypot": true, "min_submit_secs": 0, "passkey_only_admins": false,
                "passkey_only_users": false, "passkey_prompt": false, "warnings": [] })
    );
    let put = |body: Value| {
        let admin = &admin;
        async move { admin.put("/test/api/v1/settings/auth", body).await }
    };
    let base = json!({ "version": 0, "turnstile_site_key": "0x4AAAAAAA-site_key",
        "turnstile_login": true, "turnstile_register": false, "turnstile_reset": false,
        "honeypot": true, "min_submit_secs": 0, "passkey_only_admins": false,
        "passkey_only_users": false, "passkey_prompt": false });
    let r = put(base.clone()).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (
            StatusCode::BAD_REQUEST,
            json!("auth_admin.turnstile_incomplete")
        )
    );
    let mut b = base.clone();
    b["turnstile_site_key"] = json!("bad key!");
    assert_eq!(
        put(b).await.json()["code"],
        "auth_admin.turnstile_key_invalid"
    );
    let mut b = base.clone();
    b["min_submit_secs"] = json!(61);
    assert_eq!(put(b).await.json()["code"], "auth_admin.min_submit_range");
    let mut b = base.clone();
    b["turnstile_secret"] = json!("0x4AAAAAAA-secret");
    let r = put(b).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["turnstile_secret_set"], true);
    assert!(!String::from_utf8_lossy(&r.body).contains("0x4AAAAAAA-secret"));
    let mut b = base.clone();
    b["version"] = json!(0);
    assert_eq!(put(b).await.json()["code"], "settings.version_conflict");
    // Secret at rest: sealed; audit: only "changed".
    let enc: Vec<u8> = sqlx::query_scalar("SELECT turnstile_secret_enc FROM auth_settings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(!enc.windows(8).any(|w| w == b"0x4AAAAA"));
    let audit: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'settings.auth.update' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audit["turnstile_secret"], "changed");
    assert!(!audit.to_string().contains("0x4AAAAAAA-secret"));
    // Public view: the site key and the forms, never the secret.
    let c = Client::new(&st, rand_ip());
    let o = c.get("/test/auth/options").await;
    assert_eq!(
        o.json()["guard"]["turnstile"],
        json!({ "site_key": "0x4AAAAAAA-site_key", "login": true, "register": false, "reset": false })
    );
    assert!(!String::from_utf8_lossy(&o.body).contains("secret"));

    let login = |t: Option<&str>| {
        let c = &c;
        let email = email.clone();
        let body = match t {
            Some(t) => login_body(&email, "right-password", json!({ "turnstile": t })),
            None => login_body(&email, "right-password", json!({})),
        };
        async move { c.post("/test/auth/login", body).await }
    };
    let r = login(None).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("auth.captcha_failed"))
    );
    let r = login(Some("bad-token")).await;
    assert_eq!(r.json()["code"], "auth.captcha_failed");
    let r = login(Some("good-token")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let sent = verifier.got.lock().unwrap().clone();
    assert_eq!(sent.len(), 2, "no call without a token");
    let form: Vec<(String, String)> = form_urlencoded::parse(sent[1].as_bytes())
        .into_owned()
        .collect();
    assert!(form.contains(&("secret".into(), "0x4AAAAAAA-secret".into())));
    assert!(form.contains(&("response".into(), "good-token".into())));
    assert!(form.contains(&("remoteip".into(), c.ip.to_string())));
    *verifier.status.lock().unwrap() = 500;
    let r = login(Some("good-token")).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!("auth.captcha_unavailable")
        )
    );
    // Captcha refusals are not credential failures: no login-limit slot.
    let n: Option<i64> =
        fred::prelude::KeysInterface::get(st.valkey(), &crate::login_limit::keys("x", &email)[1])
            .await
            .unwrap();
    assert_eq!(n.unwrap_or(0), 0);

    // Removing the secret while a form uses it is refused; switching the
    // forms off and removing it works.
    let mut b = base.clone();
    b["version"] = json!(1);
    b["turnstile_secret"] = json!("");
    assert_eq!(
        put(b.clone()).await.json()["code"],
        "auth_admin.turnstile_incomplete"
    );
    b["turnstile_login"] = json!(false);
    let r = put(b).await;
    assert_eq!(r.json()["turnstile_secret_set"], false);
    // Non-admins: forbidden.
    let u = client_for(&st, db.user().await).await;
    assert_eq!(
        u.get("/test/api/v1/settings/auth").await.status,
        StatusCode::FORBIDDEN
    );
    db.drop().await;
}

/// Turnstile on registration and reset; fail closed when the verifier is
/// unreachable or the stored secret cannot be opened; a bad secret is
/// refused at save time.
#[tokio::test]
async fn turnstile_other_forms_fail_closed() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (_verifier, url) = Verifier::start().await;
    let st =
        AppState::for_test_with(db.pool.clone(), |c| c.limits.turnstile_verify_url = url).await;
    let enc = st
        .master_key()
        .seal(TURNSTILE_AAD, b"0x4AAAAAAA-secret")
        .unwrap();
    sqlx::query(
        "UPDATE auth_settings SET turnstile_site_key = 'site', turnstile_secret_enc = $1, \
         turnstile_register = true, turnstile_reset = true WHERE id = 1",
    )
    .bind(&enc)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE signup_settings SET register_enabled = true, reset_enabled = true WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let c = Client::new(&st, rand_ip());
    // Per-address mail limits live in the shared Valkey: a fresh address.
    let addr = format!(
        "r{}@example.com",
        &Uuid::new_v4().simple().to_string()[..10]
    );
    let reg = |t: &str| {
        json!({ "email": format!("u{}@example.com", &Uuid::new_v4().simple().to_string()[..10]),
                "password": "long enough password", "pow": { "challenge": "x", "nonce": "y" },
                "guard": { "turnstile": t } })
    };
    let r = c.post("/test/auth/register", reg("")).await;
    assert_eq!(r.json()["code"], "auth.captcha_failed");
    let r = c.post("/test/auth/register", reg("bad-token")).await;
    assert_eq!(r.json()["code"], "auth.captcha_failed");
    // A good token passes the captcha; the (fake) proof of work fails next.
    let r = c.post("/test/auth/register", reg("good-token")).await;
    assert_ne!(r.json()["code"], "auth.captcha_failed");
    let r = c
        .post(
            "/test/auth/password-reset/request",
            json!({ "email": addr.as_str() }),
        )
        .await;
    assert_eq!(r.json()["code"], "auth.captcha_failed");
    let r = c
        .post(
            "/test/auth/password-reset/request",
            json!({ "email": addr.as_str(), "guard": { "turnstile": "good-token" } }),
        )
        .await;
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::OK, json!({ "ok": true }))
    );
    // Login is not switched on: no token needed.
    let (_, email) = account(&db, "right-password").await;
    let r = c
        .post(
            "/test/auth/login",
            json!({ "email": email, "password": "right-password" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);

    // Unreachable verifier: 503.
    let down = AppState::for_test_with(db.pool.clone(), |c| {
        c.limits.turnstile_verify_url = "http://127.0.0.1:9/siteverify".into()
    })
    .await;
    let cd = Client::new(&down, rand_ip());
    let r = cd
        .post(
            "/test/auth/password-reset/request",
            json!({ "email": addr.as_str(), "guard": { "turnstile": "good-token" } }),
        )
        .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!("auth.captcha_unavailable")
        )
    );
    // A secret the master key cannot open: 503, no call.
    sqlx::query("UPDATE auth_settings SET turnstile_secret_enc = '\\x0100' WHERE id = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c
        .post(
            "/test/auth/password-reset/request",
            json!({ "email": addr.as_str(), "guard": { "turnstile": "good-token" } }),
        )
        .await;
    assert_eq!(r.json()["code"], "auth.captcha_unavailable");
    // Saving a malformed secret is refused.
    let admin = client_for(&st, db.admin().await).await;
    let v = admin.get("/test/api/v1/settings/auth").await.json();
    let r = admin
        .put(
            "/test/api/v1/settings/auth",
            json!({ "version": v["version"], "turnstile_site_key": "site",
                    "turnstile_secret": "bad\nsecret", "turnstile_login": false,
                    "turnstile_register": true, "turnstile_reset": true,
                    "honeypot": true, "min_submit_secs": 0, "passkey_only_admins": false,
                    "passkey_only_users": false, "passkey_prompt": false }),
        )
        .await;
    assert_eq!(r.json()["code"], "auth_admin.turnstile_secret_invalid");
    // The CLI way back in: every form off, keys kept, audited (actor cli).
    let mut conn = db.pool.acquire().await.unwrap();
    apply_turnstile_off(&mut conn, &crate::audit::Actor::cli())
        .await
        .unwrap();
    let s = load(&mut conn).await.unwrap();
    assert!(!(s.turnstile_login || s.turnstile_register || s.turnstile_reset));
    assert!(s.turnstile_site_key.is_some() && s.turnstile_secret_enc.is_some());
    let who: String = sqlx::query_scalar(
        "SELECT actor_label FROM audit_log WHERE action = 'settings.auth.update' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    drop(conn);
    assert_eq!(who, "cli");
    db.drop().await;
}

/// Cloudflare's answers: only visitor-side error codes are the visitor's
/// failure; a refused secret / request or an unknown code is the site's
/// (503 + ERROR log), Cloudflare's own error is "unavailable".
#[test]
fn siteverify_answers_are_classified() {
    let c = |v: Value| classify(&v).0;
    assert_eq!(
        c(json!({ "success": true, "error-codes": [] })),
        Outcome::Ok
    );
    assert_eq!(c(json!({ "success": false })), Outcome::Rejected);
    for code in USER_ERRORS {
        assert_eq!(
            c(json!({ "success": false, "error-codes": [code] })),
            Outcome::Rejected,
            "{code}"
        );
    }
    assert_eq!(
        c(
            json!({ "success": false, "error-codes": ["invalid-input-response", "timeout-or-duplicate"] })
        ),
        Outcome::Rejected
    );
    for code in [
        "missing-input-secret",
        "invalid-input-secret",
        "invalid-parsed-secret",
        "invalid-widget-id",
        "bad-request",
        "something-new",
    ] {
        assert_eq!(
            c(json!({ "success": false, "error-codes": [code] })),
            Outcome::Misconfigured,
            "{code}"
        );
    }
    // A misconfiguration wins over a visitor-side code in the same answer.
    assert_eq!(
        c(
            json!({ "success": false, "error-codes": ["invalid-input-response", "invalid-input-secret"] })
        ),
        Outcome::Misconfigured
    );
    assert_eq!(
        c(json!({ "success": false, "error-codes": ["internal-error"] })),
        Outcome::Unavailable
    );
    // Codes are sanitised for the log: no foreign text, bounded.
    let (_, codes) = classify(&json!({ "success": false,
        "error-codes": ["Invalid Secret <script>", "x".repeat(41), "bad-request", 7] }));
    assert_eq!(codes, ["(unrecognised)", "(unrecognised)", "bad-request"]);
    let many: Vec<String> = (0..20).map(|i| format!("c{i}")).collect();
    assert_eq!(
        classify(&json!({ "success": false, "error-codes": many }))
            .1
            .len(),
        8
    );
    // Metric label values are a closed set.
    let all = [
        Outcome::Ok,
        Outcome::NoToken,
        Outcome::Rejected,
        Outcome::Misconfigured,
        Outcome::Unavailable,
    ];
    assert_eq!(all.map(Outcome::label), Outcome::LABELS);
}

/// Through the login route: a wrong secret (Cloudflare's
/// `invalid-input-secret`) is 503 `auth.captcha_unavailable`, not the
/// visitor's `auth.captcha_failed`; a replayed token stays 400; neither
/// takes a login-limit slot; every check counts in
/// `akari_turnstile_verify_total{result}`.
#[tokio::test]
async fn turnstile_misconfiguration_is_not_the_visitors_failure() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    crate::metrics::init().unwrap();
    let (_verifier, url) = Verifier::start().await;
    let st =
        AppState::for_test_with(db.pool.clone(), |c| c.limits.turnstile_verify_url = url).await;
    let enc = st
        .master_key()
        .seal(TURNSTILE_AAD, b"0x4AAAAAAA-secret")
        .unwrap();
    sqlx::query(
        "UPDATE auth_settings SET turnstile_site_key = 'site', turnstile_secret_enc = $1, \
         turnstile_login = true WHERE id = 1",
    )
    .bind(&enc)
    .execute(&db.pool)
    .await
    .unwrap();
    // Generated: test credentials are not constants.
    let pw = format!("pw-{}", Uuid::new_v4().simple());
    let (_, email) = account(&db, &pw).await;
    let c = Client::new(&st, rand_ip());
    let count = crate::metrics::turnstile_verify_count;
    let before: Vec<u64> = Outcome::LABELS.iter().map(|l| count(l)).collect();
    let login = |t: &str| {
        c.post(
            "/test/auth/login",
            login_body(&email, &pw, json!({ "turnstile": t })),
        )
    };

    let r = login("codes:invalid-input-secret").await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!("auth.captcha_unavailable")
        )
    );
    let r = login("codes:missing-input-secret").await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    let r = login("codes:internal-error").await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    let r = login("codes:timeout-or-duplicate").await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("auth.captcha_failed"))
    );
    let r = c
        .post("/test/auth/login", login_body(&email, &pw, json!({})))
        .await;
    assert_eq!(r.json()["code"], "auth.captcha_failed");
    let r = login("good-token").await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    // A secret that cannot be opened (master.key changed): the site's too.
    sqlx::query("UPDATE auth_settings SET turnstile_secret_enc = '\\x00' WHERE id = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = login("good-token").await;
    assert_eq!(r.json()["code"], "auth.captcha_unavailable");

    // Counters are process-wide (tests run in parallel): at least ours.
    let after: Vec<u64> = Outcome::LABELS.iter().map(|l| count(l)).collect();
    let grew = |label: &str| {
        let i = Outcome::LABELS.iter().position(|l| *l == label).unwrap();
        after[i] - before[i]
    };
    assert!(grew("misconfigured") >= 3, "{before:?} {after:?}");
    assert!(grew("unavailable") >= 1);
    assert!(grew("rejected") >= 1);
    assert!(grew("no_token") >= 1);
    assert!(grew("ok") >= 1);
    // Captcha refusals are not credential failures: no login-limit slot.
    let n: Option<i64> =
        fred::prelude::KeysInterface::get(st.valkey(), &crate::login_limit::keys("x", &email)[1])
            .await
            .unwrap();
    assert_eq!(n.unwrap_or(0), 0);
    db.drop().await;
}
