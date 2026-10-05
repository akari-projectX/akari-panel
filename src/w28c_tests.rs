//! W28-c route-level tests: D12 (users are managed only through plans:
//! plan + term on creation and assignment, renew / extend N days, the
//! current-subscription view, the confirmed traffic reset) and the admin
//! ban (reason shown in the portal, revocation, portal scope).

use axum::http::{Method, StatusCode};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

async fn setup() -> Option<(TestDb, AppState, Uuid, Client)> {
    let db = TestDb::new().await?;
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = db.admin().await;
    let c = client_for(&state, admin).await;
    Some((db, state, admin, c))
}

/// A plan (quota 1000 bytes, monthly reset) granting a group that holds
/// `entrance` (W28-a: groups hold entrances).
async fn plan(c: &Client, name: &str, entrance: Uuid) -> Uuid {
    let g = c
        .post(
            "/test/api/v1/node-groups",
            json!({ "name": format!("g-{name}"), "entrance_ids": [entrance] }),
        )
        .await;
    assert_eq!(g.status, StatusCode::CREATED, "{:?}", g.json());
    let p = c
        .post(
            "/test/api/v1/plans",
            json!({ "name": name, "traffic_quota_bytes": 1000, "period": "monthly",
                    "group_ids": [g.json()["id"]] }),
        )
        .await;
    assert_eq!(p.status, StatusCode::CREATED, "{:?}", p.json());
    p.json()["id"].as_str().unwrap().parse().unwrap()
}

fn ts(v: &Value) -> DateTime<Utc> {
    v.as_str().unwrap().parse().unwrap()
}

async fn audits(db: &TestDb, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = $1")
        .bind(action)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

/// D12: a new user gets a plan + term (never a limit or expiry); the
/// detail view shows the current subscription; refusals are coded.
#[tokio::test]
async fn create_with_plan_and_subscription_view() {
    let Some((db, state, _, c)) = setup().await else {
        return;
    };
    let node = db.node().await;
    let p = plan(&c, "gold", db.direct(node).await).await;
    // The old direct fields are gone.
    for body in [
        json!({ "email": "xx1@w28c.test", "password": "password-123", "traffic_limit_bytes": 5 }),
        json!({ "email": "xx1@w28c.test", "password": "password-123",
                "expires_at": "2099-01-01T00:00:00Z" }),
    ] {
        let r = c.post("/test/api/v1/users", body).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        assert_eq!(r.json()["code"], "request.invalid_body");
    }
    // The term is validated before anything is written.
    let r = c
        .post(
            "/test/api/v1/users",
            json!({ "email": "xx2@w28c.test", "password": "password-123",
                    "plan": { "plan_id": p, "period": "reset" } }),
        )
        .await;
    assert_eq!(r.json()["code"], "user_plan.term_reset");
    let r = c
        .post(
            "/test/api/v1/users",
            json!({ "email": "xx2@w28c.test", "password": "password-123",
                    "plan": { "plan_id": p, "period": "days" } }),
        )
        .await;
    assert_eq!(r.json()["code"], "user_plan.term_days_missing");
    // An admin cannot hold a plan: nothing is created (one transaction).
    let r = c
        .post(
            "/test/api/v1/users",
            json!({ "email": "xx3@w28c.test", "password": "password-123", "role": "admin",
                    "plan": { "plan_id": p, "period": "month" } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "user.admin_no_plan");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email = 'xx3@w28c.test'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);

    let r = c
        .post(
            "/test/api/v1/users",
            json!({ "email": "d12@w28c.test", "password": "password-123",
                    "plan": { "plan_id": p, "period": "days", "days": 30 } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let v = r.json();
    let u: Uuid = v["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(v["plan_name"], "gold");
    assert_eq!(v["traffic_limit_bytes"], 1000, "the limit is the plan's");
    let left = ts(&v["expires_at"]) - Utc::now();
    assert!((left.num_seconds() - 30 * 86400).abs() < 60, "{left}");
    assert!(v["sub_token"].is_string());
    assert_eq!(audits(&db, "user.create").await, 1);
    assert_eq!(audits(&db, "user.plan.set").await, 1);
    let nodes: i64 = sqlx::query_scalar("SELECT count(*) FROM entrance_users WHERE user_id = $1")
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(nodes, 1, "plan access granted in the same transaction");

    sqlx::query("UPDATE users SET traffic_used_bytes = 400 WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c.get(&format!("/test/api/v1/users/{u}")).await;
    assert_eq!(r.status, StatusCode::OK);
    let d = r.json();
    assert_eq!(d["email"], "d12@w28c.test");
    assert!(d["ban"].is_null());
    let s = &d["subscription"];
    assert_eq!(s["plan_id"], json!(p));
    assert_eq!(s["plan_name"], "gold");
    assert_eq!(s["period"], "days");
    assert_eq!(s["period_days"], 30);
    assert_eq!(s["traffic_used_bytes"], 400);
    assert_eq!(s["traffic_total_bytes"], 1000);
    assert_eq!(s["reset_period"], "monthly");
    assert!(s["next_reset_at"].is_string());
    assert!(s["last_reset_at"].is_null());
    assert_eq!(s["status"], "active");
    assert_eq!(s["expires_at"], v["expires_at"]);
    // Statuses follow the badge's precedence.
    sqlx::query("UPDATE users SET enabled = false, disabled_reason = 'quota' WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c.get(&format!("/test/api/v1/users/{u}")).await;
    assert_eq!(r.json()["subscription"]["status"], "over_quota");
    for q in [
        "UPDATE users SET enabled = true",
        "UPDATE user_plans SET expires_at = now() - interval '1 minute'",
    ] {
        sqlx::query(q).execute(&db.pool).await.unwrap();
    }
    let r = c.get(&format!("/test/api/v1/users/{u}")).await;
    assert_eq!(r.json()["subscription"]["status"], "expired");

    // No plan: null subscription. Unknown: 404. Not an admin: 403.
    let plain = db.user().await;
    let r = c.get(&format!("/test/api/v1/users/{plain}")).await;
    assert!(r.json()["subscription"].is_null());
    let r = c
        .get(&format!("/test/api/v1/users/{}", Uuid::new_v4()))
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let uc = client_for(&state, plain).await;
    let r = uc.get(&format!("/test/api/v1/users/{u}")).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // GET /users/{id}/nodes is gone (D12): the canonical rejection.
    let r = c.get(&format!("/test/api/v1/users/{u}/nodes")).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert!(r.body.is_empty());
    db.drop().await;
}

/// D12 renewals: one more term or N more days from max(expiry, now); N
/// days refused for one-time purchases (ruling ④); no expiry = nothing to
/// renew; assignment replaces and zeroes the usage.
#[tokio::test]
async fn renew_extend_and_one_time_rules() {
    let Some((db, _state, _, c)) = setup().await else {
        return;
    };
    let node = db.node().await;
    let p = plan(&c, "silver", db.direct(node).await).await;
    let u = db.user().await;
    let url = format!("/test/api/v1/users/{u}/plan");
    // Without a plan: 409; unknown user: 404.
    let r = c
        .req(Method::PATCH, &url, Some(json!({ "extend_days": 3 })))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "user_plan.none");
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/users/{}/plan", Uuid::new_v4()),
            Some(json!({ "extend_days": 3 })),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    sqlx::query("UPDATE users SET traffic_used_bytes = 77 WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c
        .put(&url, json!({ "plan_id": p, "period": "month" }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let e0 = ts(&r.json()["active"]["expires_at"]);
    assert_eq!(db.used(u).await, 0, "a new subscription starts empty");

    for (body, code) in [
        (json!({}), "user_plan.renew_mode"),
        (
            json!({ "period": "month", "extend_days": 3 }),
            "user_plan.renew_mode",
        ),
        (
            json!({ "extend_days": 3, "days": 3 }),
            "user_plan.renew_mode",
        ),
        (json!({ "extend_days": 0 }), "user_plan.extend_days_range"),
        (json!({ "period": "reset" }), "user_plan.term_reset"),
    ] {
        let r = c.req(Method::PATCH, &url, Some(body.clone())).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(r.json()["code"], code, "{body}");
    }
    let r = c
        .req(Method::PATCH, &url, Some(json!({ "extend_days": 5 })))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let e1 = ts(&r.json()["active"]["expires_at"]);
    assert_eq!((e1 - e0).num_seconds(), 5 * 86400);
    assert_eq!(
        r.json()["active"]["period"],
        "month",
        "N days keep the term"
    );
    let r = c
        .req(Method::PATCH, &url, Some(json!({ "period": "quarter" })))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let e2 = ts(&r.json()["active"]["expires_at"]);
    let quarter: bool = sqlx::query_scalar(
        "SELECT ($1 AT TIME ZONE 'UTC') + interval '3 months' = ($2 AT TIME ZONE 'UTC')",
    )
    .bind(e1)
    .bind(e2)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(quarter, "one calendar quarter later: {e1} -> {e2}");
    assert_eq!(r.json()["active"]["period"], "quarter");
    let user_exp: DateTime<Utc> = sqlx::query_scalar("SELECT expires_at FROM users WHERE id = $1")
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(user_exp, e2, "the enforced expiry follows the plan");
    assert_eq!(audits(&db, "user.plan.renew").await, 2);

    // A one-time purchase cannot be extended by days, but can be renewed.
    let r = c
        .put(
            &url,
            json!({ "plan_id": p, "period": "onetime", "days": 30 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let r = c
        .req(Method::PATCH, &url, Some(json!({ "extend_days": 5 })))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "user_plan.extend_onetime");
    let r = c
        .req(Method::PATCH, &url, Some(json!({ "period": "onetime" })))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json()["active"]["expires_at"].is_null(), "now permanent");
    let r = c
        .req(Method::PATCH, &url, Some(json!({ "period": "month" })))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "user_plan.no_expiry");
    let history = c.get(&url).await.json()["history"].clone();
    assert_eq!(history.as_array().map(Vec::len), Some(2));
    db.drop().await;
}

/// D12 "重置套餐流量": confirmed, audited, re-enables a quota-disabled
/// account (never a banned one), keeps the reset schedule.
#[tokio::test]
async fn reset_traffic_is_confirmed_and_reenables_quota() {
    let Some((db, _state, _, c)) = setup().await else {
        return;
    };
    let node = db.node().await;
    let p = plan(&c, "bronze", db.direct(node).await).await;
    let u = db.user().await;
    let url = format!("/test/api/v1/users/{u}/plan/reset-traffic");
    let r = c.post(&url, json!({ "confirm": true })).await;
    assert_eq!(r.json()["code"], "user_plan.none");
    c.put(
        &format!("/test/api/v1/users/{u}/plan"),
        json!({ "plan_id": p, "period": "month" }),
    )
    .await;
    sqlx::query(
        "UPDATE users SET traffic_used_bytes = 5000, enabled = false, \
         disabled_reason = 'quota' WHERE id = $1",
    )
    .bind(u)
    .execute(&db.pool)
    .await
    .unwrap();
    let next: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT next_reset_at FROM user_plans WHERE user_id = $1")
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let r = c.post(&url, json!({})).await;
    assert_eq!(r.json()["code"], "request.invalid_body");
    let r = c.post(&url, json!({ "confirm": false })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "user_plan.confirm_required");
    assert_eq!(db.used(u).await, 5000, "nothing without confirmation");
    let v0 = db.versions(node).await;
    let r = c.post(&url, json!({ "confirm": true })).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let s = &r.json()["subscription"];
    assert_eq!(s["traffic_used_bytes"], 0);
    assert_eq!(s["status"], "active", "quota-disabled account re-enabled");
    assert!(s["last_reset_at"].is_string());
    assert_eq!(s["next_reset_at"], json!(next), "schedule unchanged");
    assert_ne!(db.versions(node).await, v0, "back in service: bumped");
    assert_eq!(audits(&db, "user.traffic.reset").await, 1);

    // A banned account stays banned.
    c.post(
        &format!("/test/api/v1/users/{u}/ban"),
        json!({ "reason": "abuse" }),
    )
    .await;
    sqlx::query("UPDATE users SET traffic_used_bytes = 9 WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c.post(&url, json!({ "confirm": true })).await;
    assert_eq!(r.json()["subscription"]["status"], "banned");
    assert_eq!(db.used(u).await, 0);
    db.drop().await;
}

/// W28-c ban: reason required and shown to the user, nodes revoke the user
/// (bump) and every session ends; the banned user signs in to the portal
/// scope only (ban reason + tickets); the subscription is the canonical
/// rejection; unban restores everything; all audited.
#[tokio::test]
async fn ban_revokes_and_confines_to_the_portal() {
    let Some((db, state, admin, c)) = setup().await else {
        return;
    };
    let node = db.node().await;
    let p = plan(&c, "ban-plan", db.direct(node).await).await;
    let r = c
        .post(
            "/test/api/v1/users",
            json!({ "email": "victim@w28c.test", "password": "password-123",
                    "plan": { "plan_id": p, "period": "month" } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let u: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
    let token = r.json()["sub_token"].as_str().unwrap().to_string();
    let anon = Client::new(&state, rand_ip());
    let sub = format!("/test/sub/{token}");
    assert_eq!(anon.get(&sub).await.status, StatusCode::OK);
    let mut uc = Client::new(&state, rand_ip());
    assert_eq!(
        uc.login("victim@w28c.test", "password-123").await.status,
        StatusCode::OK
    );
    assert_eq!(uc.get("/test/api/v1/me/plan").await.status, StatusCode::OK);

    let url = format!("/test/api/v1/users/{u}/ban");
    for (body, code) in [
        (json!({ "reason": "  " }), "user.ban_reason_required"),
        (
            json!({ "reason": "x".repeat(501) }),
            "user.ban_reason_too_long",
        ),
    ] {
        let r = c.post(&url, body).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        assert_eq!(r.json()["code"], code);
    }
    let r = c
        .post(
            &format!("/test/api/v1/users/{admin}/ban"),
            json!({ "reason": "me" }),
        )
        .await;
    assert_eq!(r.json()["code"], "user.ban_self");
    let r = c
        .post(&format!("/test/api/v1/users/{u}/unban"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "user.not_banned");

    let v0 = db.versions(node).await;
    let r = c
        .post(&url, json!({ "reason": " 共享账号给多人使用\u{0007} " }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let d = r.json();
    assert_eq!(d["enabled"], false);
    assert_eq!(d["disabled_reason"], "admin");
    assert_eq!(d["ban"]["reason"], "共享账号给多人使用");
    assert_eq!(d["ban"]["banned_by_id"], json!(admin));
    assert!(d["ban"]["banned_at"].is_string());
    assert_eq!(d["subscription"]["status"], "banned");
    assert_ne!(db.versions(node).await, v0, "nodes revoke the user");
    assert_eq!(audits(&db, "user.ban").await, 1);
    // Every session ended; the subscription is the canonical rejection.
    assert_eq!(
        uc.get("/test/api/v1/me").await.status,
        StatusCode::UNAUTHORIZED
    );
    let gone = anon.get(&sub).await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
    assert!(gone.body.is_empty());
    // The user signs in again: portal scope only.
    let r = uc.login("victim@w28c.test", "password-123").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["banned"], true);
    let me = uc.get("/test/api/v1/me").await;
    assert_eq!(me.status, StatusCode::OK);
    let me = me.json();
    assert_eq!(me["banned"], true);
    assert_eq!(me["ban_reason"], "共享账号给多人使用");
    assert!(me["sub_token"].is_null() && me["sub_url"].is_null());
    for path in [
        "/test/api/v1/me/plan",
        "/test/api/v1/me/shop",
        "/test/api/v1/me/orders",
        "/test/api/v1/me/nodes",
        "/test/api/v1/me/traffic",
        "/test/api/v1/me/announcements",
    ] {
        let r = uc.get(path).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(r.json()["code"], "account.banned", "{path}");
    }
    let r = uc.post("/test/api/v1/me/sub-token", json!({})).await;
    assert_eq!(r.json()["code"], "account.banned");
    // Tickets work (to ask about the ban).
    assert_eq!(
        uc.get("/test/api/v1/me/tickets").await.status,
        StatusCode::OK
    );
    let r = uc
        .post(
            "/test/api/v1/me/tickets",
            json!({ "subject": "ban", "category": "account", "priority": "normal",
                    "message": "why?" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());

    // Unban: back in service, the reason is gone, audited.
    let v1 = db.versions(node).await;
    let r = c
        .post(&format!("/test/api/v1/users/{u}/unban"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json()["ban"].is_null());
    assert_eq!(r.json()["subscription"]["status"], "active");
    assert_ne!(db.versions(node).await, v1);
    assert_eq!(audits(&db, "user.unban").await, 1);
    let note: Option<String> = sqlx::query_scalar("SELECT disabled_note FROM users WHERE id = $1")
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(note, None);
    assert_eq!(anon.get(&sub).await.status, StatusCode::OK);
    assert_eq!(uc.get("/test/api/v1/me/plan").await.status, StatusCode::OK);
    assert_eq!(uc.get("/test/api/v1/me").await.json()["banned"], false);

    // A banned admin does not sign in at all.
    let other = db.admin().await;
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(other)
        .bind(crate::auth::hash_password("admin-password-1").unwrap())
        .execute(&db.pool)
        .await
        .unwrap();
    c.post(
        &format!("/test/api/v1/users/{other}/ban"),
        json!({ "reason": "left" }),
    )
    .await;
    let mut ac = Client::new(&state, rand_ip());
    let r = ac
        .login(&crate::testdb::test_email(other), "admin-password-1")
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    db.drop().await;
}

/// The schema keeps ban fields consistent on every write path.
#[tokio::test]
async fn ban_columns_follow_the_trigger() {
    let Some((db, _state, _, _c)) = setup().await else {
        return;
    };
    let u = db.user().await;
    let row = |db: &TestDb| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_as::<_, (Option<String>, Option<String>, bool)>(
                "SELECT disabled_reason, disabled_note, disabled_at IS NOT NULL FROM users \
                 WHERE id = $1",
            )
            .bind(u)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    sqlx::query(
        "UPDATE users SET enabled = false, disabled_reason = 'admin', disabled_note = 'n' \
         WHERE id = $1",
    )
    .bind(u)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        row(&db).await,
        (Some("admin".into()), Some("n".into()), true)
    );
    // Turning it into a quota disable drops the note.
    sqlx::query("UPDATE users SET disabled_reason = 'quota' WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(row(&db).await, (Some("quota".into()), None, true));
    // Enabling clears everything.
    sqlx::query("UPDATE users SET enabled = true WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(row(&db).await, (None, None, false));
    // A note on an enabled account is dropped; an empty note or an unknown
    // reason is refused.
    sqlx::query("UPDATE users SET disabled_note = 'x' WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(row(&db).await, (None, None, false));
    for bad in [
        "UPDATE users SET enabled = false, disabled_note = '' WHERE id = $1",
        "UPDATE users SET enabled = false, disabled_reason = 'expiry' WHERE id = $1",
    ] {
        assert!(
            sqlx::query(sqlx::AssertSqlSafe(bad))
                .bind(u)
                .execute(&db.pool)
                .await
                .is_err(),
            "{bad}"
        );
    }
    db.drop().await;
}
