//! P1 (SPRINT 问题记录 P1): an admin refund undoes what the order did to the
//! subscription — a new one ends, a renewal's term is taken back, a switch
//! restores the replaced plan, a reset pack is money only — unless the
//! admin keeps the plan; the preview shows the same effect beforehand.

use axum::http::StatusCode;
use serde_json::{Value, json};
use uuid::Uuid;

use super::super::catalog::PeriodKind;
use super::*;

async fn admin(state: &AppState, db: &TestDb) -> Client {
    let a = db.admin().await;
    user_client(state, a).await
}

/// Buy (plan, period) and pay it; returns the order.
async fn bought(db: &TestDb, c: &Client, plan: Uuid, period: &str) -> Uuid {
    let r = buy(c, plan, period).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let o = order_id(&r);
    // Fully covered orders (credit, balance) are paid at creation.
    pay(db, o).await;
    assert!(order_status(db, o).await.1, "order {o} not fulfilled");
    o
}

async fn refund(admin: &Client, order: Uuid, body: Value) -> crate::testdb::http::Resp {
    admin
        .post(&format!("/test/api/v1/orders/{order}/refund"), body)
        .await
}

async fn preview(admin: &Client, order: Uuid) -> crate::testdb::http::Resp {
    admin
        .get(&format!("/test/api/v1/orders/{order}/refund-preview"))
        .await
}

/// (user plan id, plan, status, expiry) of the user's newest-first plans.
async fn plans_of(
    db: &TestDb,
    user: Uuid,
) -> Vec<(Uuid, Uuid, String, Option<chrono::DateTime<chrono::Utc>>)> {
    sqlx::query_as(
        "SELECT id, plan_id, status::text, expires_at FROM user_plans WHERE user_id = $1 \
         ORDER BY created_at DESC, id",
    )
    .bind(user)
    .fetch_all(&db.pool)
    .await
    .unwrap()
}

async fn credentials(db: &TestDb, user: Uuid, node: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM entrance_users eu JOIN entrances e ON e.id = eu.entrance_id \
         WHERE eu.user_id = $1 AND e.node_id = $2",
    )
    .bind(user)
    .bind(node)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

async fn user_version(db: &TestDb, node: Uuid) -> i64 {
    sqlx::query_scalar("SELECT user_version FROM nodes WHERE id = $1")
        .bind(node)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn used(db: &TestDb, user: Uuid) -> i64 {
    sqlx::query_scalar("SELECT traffic_used_bytes FROM users WHERE id = $1")
        .bind(user)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn set_used(db: &TestDb, user: Uuid, bytes: i64) {
    sqlx::query("UPDATE users SET traffic_used_bytes = $2 WHERE id = $1")
        .bind(user)
        .bind(bytes)
        .execute(&db.pool)
        .await
        .unwrap();
}

/// A new subscription ends: cancelled, credentials revoked (departed rows
/// for the final counters), its nodes bumped; the preview said so first,
/// the order records the effect, both audit rows are written.
#[tokio::test]
async fn refund_cancels_a_new_subscription() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let (node, plan) =
        catalog_plan(&db, "p1-new", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    let o = bought(&db, &c, plan, "month").await;
    assert_eq!(credentials(&db, u, node).await, 1);
    let p = preview(&admin, o).await;
    assert_eq!(p.status, StatusCode::OK, "{:?}", p.json());
    assert_eq!(p.json()["effect"]["kind"], "cancel");
    assert_eq!(p.json()["effect"]["plan_name"], "p1-new");
    assert_eq!(p.json()["amount_cents"], 1000);
    let v0 = user_version(&db, node).await;
    let r = refund(&admin, o, json!({"reason": "用户申请", "to_balance": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["effect"], p.json()["effect"]);
    let plans = plans_of(&db, u).await;
    assert_eq!(plans[0].2, "cancelled");
    assert_eq!(credentials(&db, u, node).await, 0);
    assert!(user_version(&db, node).await > v0, "node not bumped");
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM entrance_users_departed WHERE user_id = $1",
            u
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM audit_log WHERE action = 'user.plan.refund' \
             AND target_id = $1::text",
            u
        )
        .await,
        1
    );
    let stored: Value = sqlx::query_scalar("SELECT refund_effect FROM orders WHERE id = $1")
        .bind(o)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(stored["kind"], "cancel");
    // Refunded: no second refund, no preview.
    assert_eq!(preview(&admin, o).await.status, StatusCode::CONFLICT);
    assert_eq!(
        preview(&admin, Uuid::new_v4()).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(preview(&c, o).await.status, StatusCode::FORBIDDEN);
    drop(state);
    db.drop().await;
}

/// A renewal's term is taken back exactly (the expiry before it); a
/// renewal whose term reaches back past now ends the subscription.
#[tokio::test]
async fn refund_rolls_a_renewal_back() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let (node, plan) =
        catalog_plan(&db, "p1-renew", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    bought(&db, &c, plan, "month").await;
    let e1 = expiry(&db, u).await.unwrap();
    let renewal = bought(&db, &c, plan, "month").await;
    let e2 = expiry(&db, u).await.unwrap();
    assert!(e2 > e1);
    let p = preview(&admin, renewal).await.json();
    assert_eq!(p["effect"]["kind"], "rollback", "{p}");
    let r = refund(&admin, renewal, json!({"reason": "r", "to_balance": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(expiry(&db, u).await, Some(e1));
    let users_expiry: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT expires_at FROM users WHERE id = $1")
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(users_expiry, Some(e1));
    assert_eq!(credentials(&db, u, node).await, 1, "access kept");
    // A renewal whose term would end before now: the subscription ends.
    let late = bought(&db, &c, plan, "month").await;
    sqlx::query(
        "UPDATE user_plans SET expires_at = now() + interval '1 day' \
         WHERE user_id = $1 AND status = 'active'",
    )
    .bind(u)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        preview(&admin, late).await.json()["effect"]["kind"],
        "cancel"
    );
    let r = refund(&admin, late, json!({"reason": "r", "to_balance": true})).await;
    assert_eq!(r.json()["effect"]["kind"], "cancel");
    assert_eq!(plans_of(&db, u).await[0].2, "cancelled");
    assert_eq!(credentials(&db, u, node).await, 0);
    drop(state);
    db.drop().await;
}

/// A switch is undone: the replaced subscription (same row, same expiry)
/// is active again with the traffic used before the switch added to the
/// usage since; the new plan's access goes, the old plan's comes back.
/// When the replaced one has expired meanwhile, the subscription ends.
#[tokio::test]
async fn refund_restores_the_plan_before_a_switch() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let (node_a, a) = catalog_plan(&db, "p1-a", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let (node_b, b) = catalog_plan(&db, "p1-b", &[(PeriodKind::Month, None, 3000)], |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    bought(&db, &c, a, "month").await;
    let (sub_a, _, _, exp_a) = plans_of(&db, u).await[0];
    set_used(&db, u, 5000).await;
    let switch = bought(&db, &c, b, "month").await;
    assert_eq!(used(&db, u).await, 0);
    set_used(&db, u, 700).await;
    let p = preview(&admin, switch).await.json();
    assert_eq!(p["effect"]["kind"], "restore", "{p}");
    assert_eq!(p["effect"]["plan_name"], "p1-a");
    assert_eq!(p["effect"]["prior_used_bytes"], 5000);
    let r = refund(&admin, switch, json!({"reason": "r", "to_balance": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let plans = plans_of(&db, u).await;
    let active: Vec<_> = plans.iter().filter(|p| p.2 == "active").collect();
    assert_eq!(active.len(), 1);
    assert_eq!((active[0].0, active[0].1, active[0].3), (sub_a, a, exp_a));
    assert_eq!(used(&db, u).await, 5700);
    assert_eq!(credentials(&db, u, node_a).await, 1);
    assert_eq!(credentials(&db, u, node_b).await, 0);
    let limit: Option<i64> =
        sqlx::query_scalar("SELECT traffic_limit_bytes FROM users WHERE id = $1")
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(limit, Some(1 << 30));
    // The replaced subscription expired meanwhile: nothing to restore.
    let switch2 = bought(&db, &c, b, "month").await;
    sqlx::query("UPDATE user_plans SET expires_at = now() - interval '1 hour' WHERE id = $1")
        .bind(sub_a)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = refund(&admin, switch2, json!({"reason": "r", "to_balance": true})).await;
    assert_eq!(r.json()["effect"]["kind"], "cancel", "{:?}", r.json());
    assert!(plans_of(&db, u).await.iter().all(|p| p.2 != "active"));
    assert_eq!(credentials(&db, u, node_b).await, 0);
    drop(state);
    db.drop().await;
}

/// Money only: a reset pack, `keep_plan`, a subscription that is no longer
/// the active one, an unfulfilled order.
#[tokio::test]
async fn refund_money_only() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let prices = [
        (PeriodKind::Month, None, 1000),
        (PeriodKind::Reset, None, 300),
    ];
    let (node, a) = catalog_plan(&db, "p1-money-a", &prices, |_| {}).await;
    let (_, b) = catalog_plan(
        &db,
        "p1-money-b",
        &[(PeriodKind::Month, None, 1000)],
        |_| {},
    )
    .await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    let first = bought(&db, &c, a, "month").await;
    let pack = bought(&db, &c, a, "reset").await;
    let r = refund(&admin, pack, json!({"reason": "r", "to_balance": true})).await;
    assert_eq!(
        r.json()["effect"],
        json!({"kind": "none", "why": "reset_pack"})
    );
    let r = refund(
        &admin,
        first,
        json!({"reason": "r", "keep_plan": true, "external_cents": 1000}),
    )
    .await;
    assert_eq!(
        r.json()["effect"],
        json!({"kind": "none", "why": "keep_plan"})
    );
    assert_eq!(plans_of(&db, u).await[0].2, "active");
    assert_eq!(credentials(&db, u, node).await, 1);
    // Renewed, then switched away: the renewal's subscription is gone.
    let renewal = bought(&db, &c, a, "month").await;
    bought(&db, &c, b, "month").await;
    let r = refund(&admin, renewal, json!({"reason": "r", "to_balance": true})).await;
    assert_eq!(
        r.json()["effect"],
        json!({"kind": "none", "why": "not_active"})
    );
    assert_eq!(active_plan(&db, u).await.map(|p| p.0), Some(b));
    // Paid but never fulfilled (the plan filled up meanwhile).
    let v = db.user().await;
    let cv = user_client(&state, v).await;
    let o = order_id(&buy(&cv, a, "month").await);
    sqlx::query("UPDATE plans SET capacity = 0 WHERE id = $1")
        .bind(a)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(pay(&db, o).await, Paid::Now { fulfilled: false });
    let r = refund(&admin, o, json!({"reason": "r", "to_balance": true})).await;
    assert_eq!(
        r.json()["effect"],
        json!({"kind": "none", "why": "not_fulfilled"})
    );
    drop(state);
    db.drop().await;
}

/// The customer is told: one `refund` mail per refund (in the refund's
/// transaction), with the amounts and what happened to the plan; none
/// with the switch off or to an unverified address.
#[tokio::test]
async fn refund_notice_mail() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let (_, plan) = catalog_plan(&db, "p1-mail", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', security = 'none', \
         from_addr = 'noreply@example.com'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let u = db.user().await;
    let email = format!("r{}@example.com", &u.simple().to_string()[..10]);
    sqlx::query("UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1")
        .bind(u)
        .bind(&email)
        .execute(&db.pool)
        .await
        .unwrap();
    let mails = || async {
        sqlx::query_as::<_, (String, String)>(
            "SELECT subject, body_text FROM mail_outbox WHERE kind = 'refund' AND to_addr = $1 \
             ORDER BY id",
        )
        .bind(&email)
        .fetch_all(&db.pool)
        .await
        .unwrap()
    };
    let c = user_client(&state, u).await;
    let o = bought(&db, &c, plan, "month").await;
    let r = refund(&admin, o, json!({"reason": "r", "external_cents": 600})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let m = mails().await;
    assert_eq!(m.len(), 1);
    assert!(m[0].0.contains("订单已退款"), "{:?}", m[0]);
    for want in ["¥6.00", "原路退回", "已取消", "/test/app"] {
        assert!(m[0].1.contains(want), "{want}: {}", m[0].1);
    }
    // Switched off: no mail; on again, but the address is unverified.
    sqlx::query("UPDATE mail_settings SET notify_refund = false")
        .execute(&db.pool)
        .await
        .unwrap();
    let o2 = bought(&db, &c, plan, "month").await;
    refund(&admin, o2, json!({"reason": "r", "to_balance": true})).await;
    sqlx::query("UPDATE mail_settings SET notify_refund = true")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET email_verified_at = NULL WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    let o3 = bought(&db, &c, plan, "month").await;
    refund(&admin, o3, json!({"reason": "r", "to_balance": true})).await;
    assert_eq!(mails().await.len(), 1);
    drop(state);
    db.drop().await;
}
