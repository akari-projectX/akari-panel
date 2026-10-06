//! Phase A PR ① money rules (research/ops-logic-review.md batch A): the
//! switch credit is worth what was paid, refunds are recorded with their
//! real amounts, commissions are clawed back, a refund gives the coupon
//! use back and does not count as a purchase.

use axum::http::StatusCode;
use serde_json::{Value, json};
use uuid::Uuid;

use super::super::catalog::PeriodKind;
use super::*;

async fn admin(state: &AppState, db: &TestDb) -> Client {
    let a = db.admin().await;
    user_client(state, a).await
}

/// Buy and pay (orders fully covered at creation are paid already).
async fn bought(db: &TestDb, c: &Client, plan: Uuid, period: &str, extra: Value) -> Uuid {
    let mut body = json!({ "plan_id": plan, "period": period });
    for (k, v) in extra.as_object().into_iter().flatten() {
        body[k] = v.clone();
    }
    let r = c.post("/test/api/v1/me/orders", body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let o = order_id(&r);
    pay(db, o).await;
    assert!(order_status(db, o).await.1, "order {o} not fulfilled");
    o
}

async fn credit(c: &Client) -> i64 {
    c.get("/test/api/v1/me/shop").await.json()["credit_cents"]
        .as_i64()
        .unwrap()
}

/// High-2: the switch credit is worth what was paid — a coupon's discount
/// and a gift are not credit, a refunded order counts for nothing.
#[tokio::test]
async fn switch_credit_is_what_was_paid() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let (_, a) = catalog_plan(&db, "hi2-a", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let (_, _b) = catalog_plan(&db, "hi2-b", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    // A 50% coupon valid for plan A only.
    let r = admin
        .post(
            "/test/api/v1/coupons",
            json!({"code": "HALFA", "kind": "percent", "value": 50, "plan_ids": [a]}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let u = db.user().await;
    let c = user_client(&state, u).await;
    bought(&db, &c, a, "month", json!({"coupon": "HALFA"})).await;
    let cr = credit(&c).await;
    assert!((450..=500).contains(&cr), "coupon credit {cr}");
    // An admin gift is not credit.
    let g = db.user().await;
    let r = admin
        .post(
            "/test/api/v1/orders/manual",
            json!({"user_id": g, "plan_id": a, "period": "month", "gift": true, "reason": "gift"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(credit(&user_client(&state, g).await).await, 0);
    // A refunded renewal (plan kept) is no longer value.
    let v = db.user().await;
    let cv = user_client(&state, v).await;
    bought(&db, &cv, a, "month", json!({})).await;
    let renewal = bought(&db, &cv, a, "month", json!({})).await;
    let before = credit(&cv).await;
    assert!(before > 1500, "two paid months: {before}");
    let r = admin
        .post(
            &format!("/test/api/v1/orders/{renewal}/refund"),
            json!({"reason": "r", "keep_plan": true}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(credit(&cv).await, 1000, "capped at the unrefunded order");
    drop(state);
    db.drop().await;
}
