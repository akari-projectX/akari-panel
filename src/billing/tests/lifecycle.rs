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

async fn quota_disabled(db: &TestDb, user: Uuid, used: i64) {
    sqlx::query(
        "UPDATE users SET traffic_used_bytes = $2, enabled = false, disabled_reason = 'quota' \
         WHERE id = $1",
    )
    .bind(user)
    .bind(used)
    .execute(&db.pool)
    .await
    .unwrap();
}

async fn served(db: &TestDb, user: Uuid) -> (i64, bool) {
    sqlx::query_as("SELECT traffic_used_bytes, enabled FROM users WHERE id = $1")
        .bind(user)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

/// 中-1: a renewal of a plan without periodic resets, or of a one-time
/// purchase, starts a fresh quota (a quota-disabled user is back); a
/// renewal of a monthly-reset plan keeps the usage (the reset handles it).
#[tokio::test]
async fn renewal_of_a_no_reset_plan_starts_a_fresh_quota() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let prices = [
        (PeriodKind::Month, None, 1000),
        (PeriodKind::Onetime, Some(30), 900),
    ];
    let (_, flat) = catalog_plan(&db, "mi1-none", &prices, |r| r.period = "none".into()).await;
    let (_, monthly) = catalog_plan(&db, "mi1-monthly", &prices, |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    bought(&db, &c, flat, "month").await;
    quota_disabled(&db, u, 2 << 30).await;
    // (Disabling ends the session: sign in again, renewal scope.)
    let c = user_client(&state, u).await;
    bought(&db, &c, flat, "month").await;
    assert_eq!(
        served(&db, u).await,
        (0, true),
        "fresh quota, back in service"
    );
    let last: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT last_reset_at FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(u)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(last.is_some());
    // Monthly resets: a renewal keeps the usage; a one-time term does not.
    let v = db.user().await;
    let cv = user_client(&state, v).await;
    bought(&db, &cv, monthly, "month").await;
    sqlx::query("UPDATE users SET traffic_used_bytes = 500 WHERE id = $1")
        .bind(v)
        .execute(&db.pool)
        .await
        .unwrap();
    bought(&db, &cv, monthly, "month").await;
    assert_eq!(served(&db, v).await, (500, true));
    bought(&db, &cv, monthly, "onetime").await;
    assert_eq!(served(&db, v).await, (0, true));
    drop(state);
    db.drop().await;
}
