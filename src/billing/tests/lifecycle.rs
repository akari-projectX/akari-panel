//! Phase A PR ① plan lifecycle (research/ops-logic-review.md batch B, the
//! lead's defaults): the switch credit counts the traffic left, renewing a
//! one-time / no-reset plan starts a fresh quota, capacity is reserved by
//! pending orders (an oversold payment goes to the balance), plan terms
//! are snapshotted at purchase, an off-sale plan stays renewable for its
//! holders, a late payment never silently replaces a newer plan.

use axum::http::StatusCode;
use uuid::Uuid;

use super::super::catalog::PeriodKind;
use super::*;

/// Buy and pay (orders fully covered at creation are paid already).
async fn bought(db: &TestDb, c: &Client, plan: Uuid, period: &str) -> Uuid {
    let r = buy(c, plan, period).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let o = order_id(&r);
    pay(db, o).await;
    assert!(order_status(db, o).await.1, "order {o} not fulfilled");
    o
}

async fn set_used(db: &TestDb, user: Uuid, bytes: i64) {
    sqlx::query("UPDATE users SET traffic_used_bytes = $2 WHERE id = $1")
        .bind(user)
        .bind(bytes)
        .execute(&db.pool)
        .await
        .unwrap();
}

async fn credit(c: &Client) -> i64 {
    c.get("/test/api/v1/me/shop").await.json()["credit_cents"]
        .as_i64()
        .unwrap()
}

/// High-1: credit = paid × min(time left, traffic left); a used-up
/// subscription is worth nothing; unlimited traffic counts time only.
#[tokio::test]
async fn switch_credit_counts_the_traffic_left() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, a) = catalog_plan(&db, "hi1-a", &[(PeriodKind::Month, None, 3000)], |_| {}).await;
    let (_, _b) = catalog_plan(&db, "hi1-b", &[(PeriodKind::Month, None, 3000)], |_| {}).await;
    let (_, unlimited) = catalog_plan(&db, "hi1-u", &[(PeriodKind::Month, None, 3000)], |r| {
        r.traffic_quota_bytes = None
    })
    .await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    bought(&db, &c, a, "month").await;
    let full = credit(&c).await;
    assert!(full >= 2800, "fresh month: {full}");
    // A quarter of the 1 GiB quota left: a quarter of what was paid.
    set_used(&db, u, 3 << 28).await;
    assert_eq!(credit(&c).await, 750);
    set_used(&db, u, 2 << 30).await;
    assert_eq!(credit(&c).await, 0, "used up: nothing to carry over");
    // Unlimited traffic: time only.
    let v = db.user().await;
    let cv = user_client(&state, v).await;
    bought(&db, &cv, unlimited, "month").await;
    set_used(&db, v, 5 << 30).await;
    assert!(credit(&cv).await >= 2800);
    drop(state);
    db.drop().await;
}
