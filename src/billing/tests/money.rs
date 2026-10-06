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
            json!({"reason": "r", "keep_plan": true, "external_cents": 1000}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(credit(&cv).await, 1000, "capped at the unrefunded order");
    drop(state);
    db.drop().await;
}

async fn balance_of(db: &TestDb, user: Uuid) -> i64 {
    let mut c = db.pool.acquire().await.unwrap();
    super::super::ledger::balance(&mut c, user).await.unwrap()
}

async fn withdrawable_of(db: &TestDb, user: Uuid) -> i64 {
    let mut c = db.pool.acquire().await.unwrap();
    super::super::ledger::withdrawable(&mut c, user)
        .await
        .unwrap()
}

/// Credit every due commission now (time travel past the hold).
async fn credit_now(db: &TestDb) {
    sqlx::query(
        "UPDATE commissions SET available_at = now() - interval '1 second' \
                 WHERE status = 'pending'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let mut c = db.pool.acquire().await.unwrap();
    super::super::commission::credit_due(&mut c)
        .await
        .ok()
        .unwrap();
}

/// 中-4: a refund claws back a commission already credited and withdrawn:
/// what the balance holds is taken now, the rest is owed — kept out of
/// withdrawals and paid first by the next commission. Ledger = balance.
#[tokio::test]
async fn commission_clawback_after_the_hold() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let (_, plan) = catalog_plan(&db, "m4", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let put = admin
        .req(
            axum::http::Method::PUT,
            "/test/api/v1/commission-settings",
            Some(
                json!({"enabled": true, "rate_percent": 10, "first_order_only": false,
                        "hold_days": 7, "min_withdrawal_cents": 50}),
            ),
        )
        .await;
    assert_eq!(put.status, StatusCode::OK);
    let (inviter, invitee) = (db.user().await, db.user().await);
    sqlx::query("UPDATE users SET inviter_id = $1 WHERE id = $2")
        .bind(inviter)
        .bind(invitee)
        .execute(&db.pool)
        .await
        .unwrap();
    let ic = user_client(&state, inviter).await;
    let ec = user_client(&state, invitee).await;
    let first = bought(&db, &ec, plan, "month", json!({})).await;
    credit_now(&db).await;
    assert_eq!(balance_of(&db, inviter).await, 100);
    // Withdrawn and paid out.
    let r = ic
        .post(
            "/test/api/v1/me/withdrawals",
            json!({"amount_cents": 100, "method": "alipay", "account": "a"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let wd = r.json()["id"].as_str().unwrap().to_string();
    let r = admin
        .post(
            &format!("/test/api/v1/withdrawals/{wd}/approve"),
            json!({"payout_reference": "p"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    // The preview says what will happen to the commission.
    let p = admin
        .get(&format!("/test/api/v1/orders/{first}/refund-preview"))
        .await
        .json();
    assert_eq!(
        p["commission"],
        json!({"status": "credited", "amount_cents": 100, "action": "claw_back",
               "recoverable_now_cents": 0})
    );
    let r = admin
        .post(
            &format!("/test/api/v1/orders/{first}/refund"),
            json!({"reason": "r", "external_cents": 1000}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["commission"], "clawed_back");
    assert_eq!(
        r.json()["commission_clawback"],
        json!({"amount_cents": 100, "recovered_cents": 0, "outstanding_cents": 100})
    );
    assert_eq!(withdrawable_of(&db, inviter).await, 0);
    // The next commission (150 on 1500) pays the debt first.
    let (_, big) = catalog_plan(&db, "m4-big", &[(PeriodKind::Month, None, 1500)], |_| {}).await;
    bought(&db, &ec, big, "month", json!({})).await;
    credit_now(&db).await;
    assert_eq!(balance_of(&db, inviter).await, 50);
    assert_eq!(withdrawable_of(&db, inviter).await, 50);
    let (owed, recovered): (i64, i64) = sqlx::query_as(
        "SELECT clawback_cents, clawback_recovered_cents FROM commissions c \
         JOIN orders o ON o.id = c.order_id WHERE o.id = $1",
    )
    .bind(first)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!((owed, recovered), (100, 100));
    // Ledger = balance, and the clawback rows are audited.
    let mismatch: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users u LEFT JOIN user_balances b ON b.user_id = u.id \
         WHERE COALESCE(b.balance_cents, 0) <> \
               COALESCE((SELECT sum(amount_cents) FROM balance_ledger l WHERE l.user_id = u.id), 0)",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(mismatch, 0);
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM balance_ledger WHERE kind = 'commission_clawback'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'balance.commission_clawback'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!((rows, audits), (1, 1));
    let inv = ic.get("/test/api/v1/me/invite").await.json();
    assert_eq!(inv["commissions"][1]["clawback_cents"], 100);
    drop(state);
    db.drop().await;
}

/// 低-2: a refund gives the coupon use back (to the coupon's cap and the
/// buyer's own count), and a refunded order is not a purchase: a
/// new-customer coupon applies again, the next order is the first order
/// for the invite commission.
#[tokio::test]
async fn refund_releases_the_coupon_and_is_no_purchase() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let (_, plan) = catalog_plan(&db, "lo2", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    for body in [
        json!({"code": "ONCE", "kind": "fixed", "value": 100, "max_uses": 1, "per_user_limit": 1}),
        json!({"code": "NEWBIE", "kind": "fixed", "value": 100, "new_users_only": true}),
    ] {
        let r = admin.post("/test/api/v1/coupons", body).await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    }
    let put = admin
        .req(
            axum::http::Method::PUT,
            "/test/api/v1/commission-settings",
            Some(
                json!({"enabled": true, "rate_percent": 10, "first_order_only": true,
                        "hold_days": 7, "min_withdrawal_cents": 50}),
            ),
        )
        .await;
    assert_eq!(put.status, StatusCode::OK);
    let (inviter, u) = (db.user().await, db.user().await);
    sqlx::query("UPDATE users SET inviter_id = $1 WHERE id = $2")
        .bind(inviter)
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    let c = user_client(&state, u).await;
    let first = bought(&db, &c, plan, "month", json!({"coupon": "ONCE"})).await;
    let used = || async {
        sqlx::query_scalar::<_, i32>("SELECT used FROM coupons WHERE code = 'ONCE'")
            .fetch_one(&db.pool)
            .await
            .unwrap()
    };
    assert_eq!(used().await, 1);
    let p = admin
        .get(&format!("/test/api/v1/orders/{first}/refund-preview"))
        .await
        .json();
    assert_eq!(p["coupon_released"], "ONCE");
    let r = admin
        .post(
            &format!("/test/api/v1/orders/{first}/refund"),
            json!({"reason": "r", "to_balance": true}),
        )
        .await;
    assert_eq!(r.json()["coupon_released"], true, "{:?}", r.json());
    assert_eq!(used().await, 0);
    // The buyer may use it again (per-user limit 1), and the new-customer
    // coupon applies: the refunded order was no purchase.
    let shop = c.get("/test/api/v1/me/shop?coupon=ONCE").await.json();
    assert_eq!(shop["coupon"]["refusal"], Value::Null, "{shop}");
    let shop = c.get("/test/api/v1/me/shop?coupon=NEWBIE").await.json();
    assert_eq!(shop["coupon"]["refusal"], Value::Null, "{shop}");
    // First-order commission: the next paid order is the first one.
    let second = bought(&db, &c, plan, "month", json!({})).await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM commissions WHERE order_id = $1")
        .bind(second)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    drop(state);
    db.drop().await;
}
