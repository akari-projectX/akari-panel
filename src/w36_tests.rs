//! W36-b (new portal) route-level tests: the site time zone on `/me` and
//! `/auth/options`, and the portal page's Content-Security-Policy, which
//! allows Cloudflare Turnstile only while a form uses it.

use axum::http::{StatusCode, header};
use serde_json::json;

use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

fn csp(r: &crate::testdb::http::Resp) -> &str {
    r.headers
        .get(header::CONTENT_SECURITY_POLICY)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

#[tokio::test]
async fn timezone_on_me_and_auth_options() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    crate::settings::init(&state).await.unwrap();
    let anon = Client::new(&state, rand_ip());
    let user = client_for(&state, db.user().await).await;
    assert_eq!(
        anon.get("/test/auth/options").await.json()["timezone"],
        "Asia/Shanghai"
    );
    assert_eq!(
        user.get("/test/api/v1/me").await.json()["timezone"],
        "Asia/Shanghai"
    );

    let admin = client_for(&state, db.admin().await).await;
    let version = admin.get("/test/api/v1/settings").await.json()["version"]
        .as_i64()
        .unwrap();
    let r = admin
        .req(
            axum::http::Method::PUT,
            "/test/api/v1/settings/site",
            Some(json!({ "version": version, "timezone": "Europe/Berlin" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    crate::settings::reload(&state).await.unwrap();
    assert_eq!(
        anon.get("/test/auth/options").await.json()["timezone"],
        "Europe/Berlin"
    );
    assert_eq!(
        user.get("/test/api/v1/me").await.json()["timezone"],
        "Europe/Berlin"
    );
    db.drop().await;
}

/// The portal page (`/` and every client-side route) carries the strict
/// policy, plus exactly challenges.cloudflare.com for scripts and frames
/// while Turnstile protects a form; API answers never get the exception.
#[tokio::test]
async fn portal_csp_allows_turnstile_only_while_enabled() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let anon = Client::new(&state, rand_ip());
    for p in ["/", "/login", "/shop"] {
        let r = anon.get(p).await;
        assert_eq!(r.status, StatusCode::OK, "{p}");
        assert_eq!(csp(&r), crate::web::CSP, "{p}");
    }

    let enc = state
        .master_key()
        .seal(crate::botguard::TURNSTILE_AAD, b"secret")
        .unwrap();
    // A site key alone (every form switch off) is no reason to relax.
    sqlx::query(
        "UPDATE auth_settings SET turnstile_site_key = 'site', turnstile_secret_enc = $1 \
         WHERE id = 1",
    )
    .bind(&enc)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(csp(&anon.get("/").await), crate::web::CSP);

    sqlx::query("UPDATE auth_settings SET turnstile_reset = true WHERE id = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    for p in ["/", "/forgot", "/orders/x"] {
        let r = anon.get(p).await;
        assert_eq!(csp(&r), crate::web::CSP_TURNSTILE, "{p}");
    }
    let policy = crate::web::CSP_TURNSTILE;
    assert!(policy.contains("script-src 'self' https://challenges.cloudflare.com"));
    assert!(policy.contains("frame-src https://challenges.cloudflare.com"));
    assert_eq!(policy.matches("https://").count(), 2, "{policy}");
    // Not on the API.
    assert_eq!(csp(&anon.get("/test/auth/options").await), crate::web::CSP);
    db.drop().await;
}
