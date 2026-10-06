//! W27 D4/D11: the URL layout — pure dispatch, then the whole router on a
//! real database (portal at `/`, admin prefix rotation and allowlist,
//! subscription path change with the users' mail).

use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

fn layout() -> Access {
    Access {
        admin_prefix: "secretprefix".into(),
        sub_path: "s3cr3tsub".into(),
        ..Access::boot("x")
    }
}

fn inner(path: &str, via: Via) -> Route {
    Route::Inner {
        path: path.into(),
        via,
    }
}

#[test]
fn dispatch_table() {
    let a = layout();
    for (path, get, want) in [
        // Admin prefix: everything below it; bare = rejection.
        (
            "/secretprefix/api/v1/users",
            false,
            Route::Admin {
                path: "/_/api/v1/users".into(),
            },
        ),
        (
            "/secretprefix/admin/nodes",
            true,
            Route::Admin {
                path: "/_/admin/nodes".into(),
            },
        ),
        ("/secretprefix", true, Route::Reject),
        // Public paths never work under the prefix (a link handed out
        // never carries it).
        ("/secretprefix/sub/TOKEN", true, Route::Reject),
        ("/secretprefix/install/TOKEN", true, Route::Reject),
        ("/secretprefix/pay/x/notify", false, Route::Reject),
        (
            "/secretprefix/app",
            true,
            Route::Admin {
                path: "/_/app".into(),
            },
        ),
        ("/secretprefix/", true, Route::Reject),
        ("/secretprefi/api/v1/users", false, Route::Reject),
        // Subscription: exactly one token segment.
        ("/s3cr3tsub/TOKEN", true, inner("/_/sub/TOKEN", Via::Sub)),
        ("/s3cr3tsub/TOKEN/x", true, Route::Reject),
        ("/s3cr3tsub", true, Route::Reject),
        ("/s3cr3tsub/", true, Route::Reject),
        // Fixed public paths.
        (
            "/install/TOKEN",
            true,
            inner("/_/install/TOKEN", Via::Public),
        ),
        (
            "/install/TOKEN/agent/ab",
            true,
            inner("/_/install/TOKEN/agent/ab", Via::Public),
        ),
        (
            "/pay/123/notify",
            false,
            inner("/_/pay/123/notify", Via::Public),
        ),
        ("/install", true, Route::Reject),
        // Portal: API, auth, branding, assets, health, pages (GET only).
        ("/api/v1/me", true, inner("/_/api/v1/me", Via::Portal)),
        ("/auth/login", false, inner("/_/auth/login", Via::Portal)),
        ("/brand/logo", true, inner("/_/brand/logo", Via::Portal)),
        (
            "/assets/index-1.js",
            true,
            inner("/_/assets/index-1.js", Via::Portal),
        ),
        ("/healthz", true, inner("/_/healthz", Via::Portal)),
        ("/api", true, Route::Reject),
        ("/", true, inner("/_/app", Via::Portal)),
        ("/shop", true, inner("/_/app/shop", Via::Portal)),
        (
            "/tickets/abc",
            true,
            inner("/_/app/tickets/abc", Via::Portal),
        ),
        ("/shop", false, Route::Reject),
        ("/", false, Route::Reject),
        // Internal and legacy names never resolve from outside.
        ("/_/api/v1/users", true, Route::Reject),
        ("/app", true, Route::Reject),
        ("/admin", true, Route::Reject),
        ("/admin/users", true, Route::Reject),
        ("/sub/TOKEN", true, Route::Reject),
        ("", true, Route::Reject),
    ] {
        assert_eq!(route(&a, path, get), want, "{path} (get={get})");
    }
}

#[test]
fn segments_and_allowlists() {
    assert!(check_segment("abcd", 4).is_ok());
    assert!(check_segment("A-b_9xyz", 8).is_ok());
    for bad in ["abc", "has space", "slash/x", "ünï", &"a".repeat(65)] {
        assert!(check_segment(bad, 4).is_err(), "{bad}");
    }
    for reserved in ["api", "Assets", "shop", "install", "sub"] {
        assert_eq!(
            check_segment(reserved, 3).unwrap_err().code(),
            if reserved.len() < 3 {
                "settings.path_invalid"
            } else {
                "settings.path_reserved"
            },
            "{reserved}"
        );
    }
    assert_eq!(
        allow_values(&[
            "10.0.0.0/8".into(),
            " ".into(),
            "10.0.0.0/8".into(),
            "2001:db8::1".into()
        ])
        .unwrap(),
        vec!["10.0.0.0/8".to_string(), "2001:db8::1".to_string()]
    );
    assert_eq!(
        allow_values(&["10.0.0.1/8".into()]).unwrap_err().code(),
        "settings.allowlist_invalid"
    );
    assert_eq!(
        allow_values(&vec!["10.0.0.1".into(); 65])
            .unwrap_err()
            .code(),
        "settings.allowlist_too_long"
    );
    let mut a = layout();
    assert!(a.admin_allowed("203.0.113.9".parse().unwrap()));
    a.admin_allow = vec![Cidr::parse("10.0.0.0/8").unwrap()];
    assert!(a.admin_allowed("10.1.2.3".parse().unwrap()));
    assert!(!a.admin_allowed("203.0.113.9".parse().unwrap()));
    a.admin_locked = true;
    assert!(!a.admin_allowed("10.1.2.3".parse().unwrap()));
}

// ---------------------------------------------------------------------------
// Real database + router
// ---------------------------------------------------------------------------

async fn account(db: &TestDb, role: &str, pw: &str) -> (Uuid, String) {
    let id = if role == "admin" {
        db.admin().await
    } else {
        db.user().await
    };
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(id)
        .bind(crate::auth::hash_password(pw).unwrap())
        .execute(&db.pool)
        .await
        .unwrap();
    (id, crate::testdb::test_email(id))
}

fn seen(r: &crate::testdb::http::Resp) -> crate::testdb::http::Fingerprint {
    let (st, h, b) = r.fingerprint();
    (
        st,
        h.into_iter().filter(|(k, _)| k != "x-request-id").collect(),
        b,
    )
}

/// The portal at `/`: pages, API and login; admin sessions and admin
/// sign-ins do not exist there; the admin prefix serves everything.
#[tokio::test]
async fn portal_at_the_root() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    let c = Client::new(&st, rand_ip());
    let canonical = c.get("/_/healthz").await;
    assert_eq!(canonical.fingerprint(), c.get("/admin").await.fingerprint());

    // The page and its assets base.
    for p in ["/", "/shop", "/tickets/x"] {
        let r = c.get(p).await;
        assert_eq!(r.status, StatusCode::OK, "{p}");
        assert!(
            !String::from_utf8_lossy(&r.body).contains("/test/"),
            "{p}: no prefix in the page"
        );
    }
    assert_eq!(c.get("/healthz").await.status, StatusCode::OK);
    assert_eq!(
        c.req(Method::POST, "/shop", None).await.fingerprint(),
        canonical.fingerprint()
    );

    // A user signs in and works at the root.
    let (_, uemail) = account(&db, "user", "user-password-1").await;
    let mut u = Client::new(&st, rand_ip());
    let r = u
        .post(
            "/auth/login",
            json!({ "email": uemail, "password": "user-password-1" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    u.cookie = r.session_cookie();
    assert_eq!(u.get("/api/v1/me").await.json()["email"], uemail);

    // An admin: the right password at the root = the wrong password's answer.
    let (aid, aemail) = account(&db, "admin", "admin-password-1").await;
    let p = Client::new(&st, rand_ip());
    let wrong = p
        .post(
            "/auth/login",
            json!({ "email": aemail, "password": "nope-nope-1" }),
        )
        .await;
    let right = p
        .post(
            "/auth/login",
            json!({ "email": aemail, "password": "admin-password-1" }),
        )
        .await;
    assert_eq!(seen(&right), seen(&wrong));
    assert!(right.session_cookie().is_none());
    // Under the admin prefix it works; that session is invisible at the root.
    let r = p
        .post(
            "/test/auth/login",
            json!({ "email": aemail, "password": "admin-password-1" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let admin = client_for(&st, aid).await;
    assert_eq!(admin.get("/test/api/v1/users").await.status, StatusCode::OK);
    for path in ["/api/v1/me", "/api/v1/users", "/api/v1/settings/access"] {
        assert_eq!(
            admin.get(path).await.fingerprint(),
            canonical.fingerprint(),
            "{path}"
        );
    }
    // Users' sessions also work under the prefix (it serves every route).
    assert_eq!(u.get("/test/api/v1/me").await.status, StatusCode::OK);
    db.drop().await;
}

/// First start: the prefix is imported from data/state.json and the
/// subscription path drawn, once each, audited.
#[tokio::test]
async fn first_start_imports_once() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    ensure(&st).await.unwrap();
    ensure(&st).await.unwrap();
    let (p, s) = cli_read(&db.pool).await.unwrap();
    assert_eq!(p.as_deref(), Some("test"));
    let s = s.unwrap();
    assert_eq!(s.len(), 16);
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action IN \
         ('settings.access.import', 'settings.sub_path.generate') AND actor_label = 'system'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(n, 2);
    crate::settings::reload(&st).await.unwrap();
    assert_eq!(st.settings().access().sub_path, s);
    db.drop().await;
}

/// Rotation (confirm, audited without the value, old prefix dead at once)
/// and the allowlist (never shuts out the caller; others get the 404).
#[tokio::test]
async fn admin_prefix_rotation_and_allowlist() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    let me: std::net::IpAddr = "198.51.100.7".parse().unwrap();
    // R47: the prefix and the allowlist are the owner's.
    let other = client_for(&st, db.admin().await).await;
    let v = other.get("/test/api/v1/settings/access").await.json();
    let r = other
        .post(
            "/test/api/v1/settings/access/admin-prefix",
            json!({ "version": v["version"], "confirm": true }),
        )
        .await;
    assert_eq!(r.json()["code"], "user.owner_only");
    let r = other
        .put(
            "/test/api/v1/settings/access/admin-allow",
            json!({ "version": v["version"], "admin_allow_cidrs": [] }),
        )
        .await;
    assert_eq!(r.json()["code"], "user.owner_only");
    let mut admin = client_for(&st, db.owner().await).await;
    admin.ip = me;
    let v = admin.get("/test/api/v1/settings/access").await.json();
    assert_eq!(
        (v["admin_prefix"].clone(), v["your_ip"].clone()),
        (json!("test"), json!("198.51.100.7"))
    );
    let r = admin
        .post(
            "/test/api/v1/settings/access/admin-prefix",
            json!({ "version": v["version"] }),
        )
        .await;
    assert_eq!(r.json()["code"], "settings.confirm_required");
    let r = admin
        .post(
            "/test/api/v1/settings/access/admin-prefix",
            json!({ "version": v["version"], "confirm": true, "admin_prefix": "api" }),
        )
        .await;
    assert_eq!(r.json()["code"], "settings.path_invalid");
    let r = admin
        .post(
            "/test/api/v1/settings/access/admin-prefix",
            json!({ "version": v["version"], "confirm": true, "admin_prefix": "Admin-Door-2026" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let canonical = admin.get("/_/healthz").await;
    assert_eq!(
        admin
            .get("/test/api/v1/settings/access")
            .await
            .fingerprint(),
        canonical.fingerprint()
    );
    let v = admin
        .get("/Admin-Door-2026/api/v1/settings/access")
        .await
        .json();
    assert_eq!(v["admin_prefix"], "Admin-Door-2026");
    let audit: String = sqlx::query_scalar(
        "SELECT after::text FROM audit_log WHERE action = 'settings.admin_prefix.rotate'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(!audit.contains("Admin-Door"), "{audit}");

    // Allowlist.
    let base = "/Admin-Door-2026/api/v1/settings/access/admin-allow";
    let r = admin
        .put(
            base,
            json!({ "version": v["version"], "admin_allow_cidrs": ["10.0.0.0/8"] }),
        )
        .await;
    assert_eq!(r.json()["code"], "settings.allowlist_excludes_you");
    let r = admin
        .put(
            base,
            json!({ "version": v["version"], "admin_allow_cidrs": ["198.51.100.0/24", "bogus"] }),
        )
        .await;
    assert_eq!(r.json()["code"], "settings.allowlist_invalid");
    let r = admin
        .put(
            base,
            json!({ "version": v["version"], "admin_allow_cidrs": ["198.51.100.0/24"] }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    // Another address: the prefix does not exist (the portal still does).
    let mut outsider = Client::new(&st, "203.0.113.5".parse().unwrap());
    outsider.cookie = admin.cookie.clone();
    assert_eq!(
        outsider
            .get("/Admin-Door-2026/api/v1/settings/access")
            .await
            .fingerprint(),
        canonical.fingerprint()
    );
    assert_eq!(outsider.get("/").await.status, StatusCode::OK);
    assert_eq!(
        admin
            .get("/Admin-Door-2026/api/v1/settings/access")
            .await
            .status,
        StatusCode::OK
    );
    // CLI: rotate + reopen.
    let p = cli_rotate_prefix(&db.pool).await.unwrap();
    cli_clear_allowlist(&db.pool).await.unwrap();
    crate::settings::reload(&st).await.unwrap();
    assert_eq!(
        outsider
            .get(&format!("/{p}/api/v1/settings/access"))
            .await
            .status,
        StatusCode::OK
    );
    let actors: Vec<(String, String)> = sqlx::query_as(
        "SELECT action, actor_label FROM audit_log WHERE action LIKE 'settings.admin%' ORDER BY id",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        actors.iter().filter(|(_, a)| a == "cli").count(),
        2,
        "{actors:?}"
    );
    db.drop().await;
}

/// A new subscription path: the old one dies at once, the new one serves;
/// every user (verified address) gets a mail with their own new link;
/// the audit keeps the template, not the links.
#[tokio::test]
async fn subscription_path_change_mails_the_users() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    db.domains(&st, "main", &["panel.example"]).await;
    db.domains(&st, "sub", &["sub.example"]).await;
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', port = 1025, \
         security = 'none', from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let (uid, uemail) = account(&db, "user", "user-password-1").await;
    sqlx::query("UPDATE users SET email_verified_at = now() WHERE id = $1")
        .bind(uid)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    let token =
        crate::sub::rotate_token(&mut tx, st.master_key(), &crate::audit::Actor::test(), uid)
            .await
            .unwrap()
            .unwrap();
    tx.commit().await.unwrap();
    let c = Client::new(&st, rand_ip());
    let canonical = c.get("/_/healthz").await;
    let old = format!("/sub/{token}");
    assert_ne!(c.get(&old).await.fingerprint(), canonical.fingerprint());

    let admin = client_for(&st, db.admin().await).await;
    let v = admin.get("/test/api/v1/settings/access").await.json();
    let put = |body: Value| {
        let admin = &admin;
        async move {
            admin
                .put("/test/api/v1/settings/access/sub-path", body)
                .await
        }
    };
    assert_eq!(
        put(json!({ "version": v["version"], "sub_path": "feed2026" }))
            .await
            .json()["code"],
        "settings.confirm_required"
    );
    assert_eq!(
        put(json!({ "version": v["version"], "sub_path": "shop", "confirm": true }))
            .await
            .json()["code"],
        "settings.path_reserved"
    );
    let r = put(json!({ "version": v["version"], "sub_path": "feed2026", "confirm": true })).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert!(r.json()["notify_job"]["id"].is_string());
    assert_eq!(
        c.get(&old).await.fingerprint(),
        canonical.fingerprint(),
        "old path dead"
    );
    assert_eq!(
        c.get(&format!("/feed2026/{token}")).await.status,
        StatusCode::OK
    );
    // Wait for the batch mail.
    let deadline = Instant::now() + Duration::from_secs(10);
    let body = loop {
        let b: Option<String> = sqlx::query_scalar(
            "SELECT body_text FROM mail_outbox WHERE to_addr = $1 AND kind = 'admin_notice'",
        )
        .bind(&uemail)
        .fetch_optional(&db.pool)
        .await
        .unwrap();
        if let Some(b) = b {
            break b;
        }
        assert!(Instant::now() < deadline, "no mail");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(
        body.contains(&format!("https://sub.example/feed2026/{token}")),
        "{body}"
    );
    let audits: String =
        sqlx::query_scalar("SELECT string_agg(coalesce(after::text, ''), ' ') FROM audit_log")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(!audits.contains(&token), "a link reached the audit log");
    assert!(audits.contains("feed2026"));
    // Unchanged path: no job.
    let v = admin.get("/test/api/v1/settings/access").await.json();
    let r = put(json!({ "version": v["version"], "sub_path": "feed2026", "confirm": true })).await;
    assert!(r.json()["notify_job"].is_null());
    db.drop().await;
}
