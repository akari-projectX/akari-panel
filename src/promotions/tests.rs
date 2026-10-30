//! Promotion tests (real database): field rules, what each user sees (one
//! promotion: window, audience, sort, the coupon code only while usable;
//! banned accounts get the ban answer), and the admin CRUD with version
//! checks and audit rows.

use axum::http::{Method, StatusCode};
use chrono::Duration;
use serde_json::{Value, json};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for};

fn body(title: &str, extra: &Value) -> Value {
    let now = Utc::now();
    let mut v = json!({
        "title_zh": title,
        "line_zh": "续费同样适用",
        "starts_at": now - Duration::hours(1),
        "ends_at": now + Duration::days(2),
    });
    for (k, val) in extra.as_object().cloned().unwrap_or_default() {
        v[k] = val;
    }
    v
}

async fn create(c: &Client, v: Value) -> Uuid {
    let r = c.post("/test/api/v1/promotions", v).await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    r.json()["id"].as_str().unwrap().parse().unwrap()
}

async fn coupon(db: &TestDb, code: &str, enabled: bool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO coupons (id, code, kind, value, enabled) VALUES ($1, $2, 'percent', 20, $3)",
    )
    .bind(id)
    .bind(code)
    .bind(enabled)
    .execute(&db.pool)
    .await
    .unwrap();
    id
}

async fn give_plan(db: &TestDb, user: Uuid) {
    let plan = Uuid::new_v4();
    sqlx::query("INSERT INTO plans (id, name, reset_period) VALUES ($1, $2, 'none')")
        .bind(plan)
        .bind(plan.to_string())
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO user_plans (id, user_id, plan_id, status, period_anchor, term_kind) \
         VALUES ($1, $2, $3, 'active', now(), 'onetime')",
    )
    .bind(Uuid::new_v4())
    .bind(user)
    .bind(plan)
    .execute(&db.pool)
    .await
    .unwrap();
}

async fn mine(c: &Client) -> Value {
    let r = c.get("/test/api/v1/me/promotion").await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    r.json()
}

fn err_code(r: &crate::testdb::http::Resp) -> String {
    r.json()["code"].as_str().unwrap_or_default().to_string()
}

#[test]
fn field_rules() {
    let now = Utc::now();
    let req = |v: Value| -> PromotionReq { serde_json::from_value(v).unwrap() };
    let base = body("双十一", &json!({}));
    assert!(check(&req(base.clone())).is_ok());
    let bad = |extra: Value, code: &str| {
        let mut v = base.clone();
        for (k, val) in extra.as_object().cloned().unwrap() {
            v[k] = val;
        }
        let e = check(&req(v)).unwrap_err();
        assert_eq!(e.code(), code, "{extra}");
    };
    bad(json!({ "title_zh": "  " }), "promotion.text_required");
    bad(json!({ "title_zh": "a\nb" }), "promotion.text_multiline");
    bad(
        json!({ "title_zh": "长".repeat(41) }),
        "promotion.text_long",
    );
    bad(json!({ "badge": "123456789" }), "promotion.text_long");
    bad(json!({ "audience": "vip" }), "promotion.audience_invalid");
    bad(
        json!({ "starts_at": now, "ends_at": now }),
        "promotion.window_invalid",
    );
    bad(json!({ "sort": 2_000_000 }), "promotion.sort_invalid");
    bad(
        json!({ "cta_url": "javascript:alert(1)" }),
        "promotion.cta_url_invalid",
    );
    bad(
        json!({ "cta_url": "mailto:a@b.c" }),
        "promotion.cta_url_invalid",
    );
    // Empty optional fields are absent; links may be same-origin.
    let c = check(&req({
        let mut v = base.clone();
        v["title_en"] = json!(" ");
        v["cta_url"] = json!("/shop?plan=x");
        v
    }))
    .unwrap();
    assert_eq!(c.title_en, None);
    assert_eq!(c.cta_url.as_deref(), Some("/shop?plan=x"));
}

#[tokio::test]
async fn users_see_the_best_visible_one() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let free = client_for(&state, db.user().await).await;
    let paying_id = db.user().await;
    give_plan(&db, paying_id).await;
    let paying = client_for(&state, paying_id).await;
    let now = Utc::now();

    // Nothing yet: null, with the server clock.
    let v = mine(&free).await;
    assert!(v["promotion"].is_null());
    assert!(v["now"].is_string());

    coupon(&db, "AKARI1111", true).await;
    coupon(&db, "OFF", false).await;
    let a = create(
        &admin,
        body(
            "A 所有人",
            &json!({ "title_en": "A all", "badge": "8折", "coupon_code": "akari1111" }),
        ),
    )
    .await;
    create(
        &admin,
        body("B 停用", &json!({ "enabled": false, "sort": 100 })),
    )
    .await;
    create(
        &admin,
        body(
            "C 未来",
            &json!({ "sort": 100, "starts_at": now + Duration::hours(1), "ends_at": now + Duration::hours(2) }),
        ),
    )
    .await;
    create(
        &admin,
        body(
            "D 过去",
            &json!({ "sort": 100, "starts_at": now - Duration::hours(2), "ends_at": now - Duration::hours(1) }),
        ),
    )
    .await;
    let e = create(
        &admin,
        body(
            "E 有套餐",
            &json!({ "audience": "with_plan", "sort": 10, "coupon_code": "OFF" }),
        ),
    )
    .await;

    let v = mine(&free).await;
    let p = &v["promotion"];
    assert_eq!(p["id"], a.to_string());
    assert_eq!(p["title_en"], "A all");
    assert_eq!(p["badge"], "8折");
    assert_eq!(p["code"], "AKARI1111");
    assert_eq!(p["cta_url"], DEFAULT_CTA_URL);

    // The paying user's best is E (higher sort); its coupon is disabled, so
    // no code is shown.
    let v = mine(&paying).await;
    assert_eq!(v["promotion"]["id"], e.to_string());
    assert!(v["promotion"]["code"].is_null());

    // Same sort: the one ending sooner wins.
    let soon = create(
        &admin,
        body("F 快结束", &json!({ "ends_at": now + Duration::hours(3) })),
    )
    .await;
    assert_eq!(mine(&free).await["promotion"]["id"], soon.to_string());

    // A coupon that is used up hides its code.
    sqlx::query("UPDATE coupons SET max_uses = 1, used = 1 WHERE code = 'AKARI1111'")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM promotions WHERE id = $1")
        .bind(soon)
        .execute(&db.pool)
        .await
        .unwrap();
    let v = mine(&free).await;
    assert_eq!(v["promotion"]["id"], a.to_string());
    assert!(v["promotion"]["code"].is_null());

    // Deleting the coupon keeps the promotion, without a code.
    sqlx::query("DELETE FROM coupons WHERE code = 'AKARI1111'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(mine(&free).await["promotion"]["id"], a.to_string());

    // Banned accounts get the ban answer; admins are not customers.
    let banned = db.user().await;
    sqlx::query(
        "UPDATE users SET enabled = false, disabled_reason = 'admin', disabled_note = 'x' WHERE id = $1",
    )
    .bind(banned)
    .execute(&db.pool)
    .await
    .unwrap();
    let r = client_for(&state, banned)
        .await
        .get("/test/api/v1/me/promotion")
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(err_code(&r), "account.banned");
    // Customers never reach the admin API.
    let r = free.get("/test/api/v1/promotions").await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn admin_crud_version_and_audit() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    coupon(&db, "SPRING", true).await;

    let r = admin
        .post(
            "/test/api/v1/promotions",
            body("x", &json!({ "coupon_code": "NOPE" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(err_code(&r), "promotion.coupon_unknown");

    let id = create(&admin, body("春季", &json!({ "coupon_code": "spring" }))).await;
    let list = admin.get("/test/api/v1/promotions").await.json();
    let row = &list.as_array().unwrap()[0];
    assert_eq!(row["id"], id.to_string());
    assert_eq!(row["coupon_code"], "SPRING");
    assert_eq!(row["coupon_usable"], true);
    assert_eq!(row["active"], true);
    assert_eq!(row["version"], 1);

    // PUT needs the version; a stale one is refused and changes nothing.
    let path = format!("/test/api/v1/promotions/{id}");
    let r = admin.put(&path, body("春季 2", &json!({}))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(err_code(&r), "promotion.version_required");
    let r = admin
        .put(
            &path,
            body("春季 2", &json!({ "version": 1, "badge": "−20%" })),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::NO_CONTENT,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let r = admin
        .put(&path, body("春季 3", &json!({ "version": 1 })))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(err_code(&r), "promotion.version_conflict");
    let row = admin.get("/test/api/v1/promotions").await.json()[0].clone();
    assert_eq!(row["title_zh"], "春季 2");
    assert_eq!(row["badge"], "−20%");
    assert_eq!(row["version"], 2);
    assert!(row["coupon_code"].is_null(), "the PUT dropped the coupon");

    let unknown = format!("/test/api/v1/promotions/{}", Uuid::new_v4());
    let r = admin
        .put(&unknown, body("x", &json!({ "version": 1 })))
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = admin.req(Method::DELETE, &path, None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = admin.req(Method::DELETE, &path, None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    let actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id")
            .bind(id.to_string())
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        actions,
        ["promotion.create", "promotion.update", "promotion.delete"]
    );
}
