//! Phase A PR ① plan lifecycle (research/ops-logic-review.md batch B, the
//! lead's defaults): the switch credit counts the traffic left, renewing a
//! one-time / no-reset plan starts a fresh quota, capacity is reserved by
//! pending orders (an oversold payment goes to the balance), plan terms
//! are snapshotted at purchase, an off-sale plan stays renewable for its
//! holders, a late payment never silently replaces a newer plan.

use axum::http::StatusCode;
use serde_json::{Value, json};
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

/// With a periodic reset the quota is per period: only the current period
/// is limited by the traffic left, the time after the next reset keeps its
/// full value (a quarter on a monthly-reset plan with this month used up
/// still carries about two months over).
#[tokio::test]
async fn switch_credit_limits_only_the_current_period() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, a) = catalog_plan(&db, "cp-a", &[(PeriodKind::Quarter, None, 9000)], |_| {}).await;
    let (_, _b) = catalog_plan(&db, "cp-b", &[(PeriodKind::Quarter, None, 9000)], |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    bought(&db, &c, a, "quarter").await;
    assert_eq!(credit(&c).await, 9000, "fresh quarter");
    // This month used up: the two months after the next reset remain
    // (9000 × 59..62 days / 90).
    set_used(&db, u, 1 << 30).await;
    let after_reset = credit(&c).await;
    assert!(
        (5800..=6300).contains(&after_reset),
        "used up this month: {after_reset}"
    );
    // A quarter of this month's quota left: plus a quarter of this month's
    // value (9000 − the part after the reset).
    set_used(&db, u, 3 << 28).await;
    let partial = credit(&c).await;
    let month = 9000 - after_reset;
    assert!(
        (partial - after_reset - month / 4).abs() <= 1,
        "quarter of this month left: {partial} (after reset {after_reset})"
    );
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

async fn admin(state: &AppState, db: &TestDb) -> Client {
    let a = db.admin().await;
    user_client(state, a).await
}

async fn limit(db: &TestDb, user: Uuid) -> Option<i64> {
    sqlx::query_scalar("SELECT traffic_limit_bytes FROM users WHERE id = $1")
        .bind(user)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn on_node(db: &TestDb, user: Uuid, node: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM entrance_users eu JOIN entrances e \
         ON e.id = eu.entrance_id WHERE eu.user_id = $1 AND e.node_id = $2)",
    )
    .bind(user)
    .bind(node)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

/// 中-5: a subscription keeps the terms it was bought with (quota, groups,
/// speed, reset policy) — a plan edit changes new purchases (and the plan's
/// renewals keep the old terms) unless the admin applies it to existing
/// subscribers, after an impact preview.
#[tokio::test]
async fn plan_terms_are_snapshotted_at_purchase() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let (n1, plan) = catalog_plan(&db, "mi5", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let n2 = db.node().await;
    let r = admin
        .post(
            "/test/api/v1/node-groups",
            json!({"name": "mi5-g2", "entrance_ids": [db.direct(n2).await]}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let g2 = r.json()["id"].clone();
    let old = db.user().await;
    let c = user_client(&state, old).await;
    bought(&db, &c, plan, "month").await;
    sqlx::query("UPDATE users SET traffic_used_bytes = 500 WHERE id = $1")
        .bind(old)
        .execute(&db.pool)
        .await
        .unwrap();
    // The edit: twice the quota, another group, a speed limit.
    let edit = json!({"traffic_quota_bytes": 2147483648_i64, "group_ids": [g2],
                      "speed_limit_mbps": 10});
    let r = admin
        .req(
            axum::http::Method::PATCH,
            &format!("/test/api/v1/plans/{plan}"),
            Some(edit),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    // The existing subscriber keeps what was bought — also across a renewal.
    bought(&db, &c, plan, "month").await;
    assert_eq!(limit(&db, old).await, Some(1 << 30));
    assert!(on_node(&db, old, n1).await && !on_node(&db, old, n2).await);
    // A new buyer gets the new terms.
    let new = db.user().await;
    bought(&db, &user_client(&state, new).await, plan, "month").await;
    assert_eq!(limit(&db, new).await, Some(2 << 30));
    assert!(on_node(&db, new, n2).await && !on_node(&db, new, n1).await);
    let speed: Option<i32> = sqlx::query_scalar(
        "SELECT speed_limit_mbps FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(new)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(speed, Some(10));
    // The impact preview: 2 subscribers; with a 100-byte quota the one who
    // used 500 bytes would be paused at once.
    let r = admin
        .post(
            &format!("/test/api/v1/plans/{plan}/impact"),
            json!({"traffic_quota_bytes": 100}),
        )
        .await;
    assert_eq!(r.json(), json!({"subscribers": 2, "over_quota": 1}));
    assert_eq!(
        admin
            .post(
                &format!("/test/api/v1/plans/{}/impact", Uuid::new_v4()),
                json!({})
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // Applied to existing subscribers: the old one takes the plan's terms.
    let r = admin
        .req(
            axum::http::Method::PATCH,
            &format!("/test/api/v1/plans/{plan}"),
            Some(json!({"apply_to_existing": true})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(limit(&db, old).await, Some(2 << 30));
    assert!(on_node(&db, old, n2).await && !on_node(&db, old, n1).await);
    let applied: Value = sqlx::query_scalar(
        "SELECT after->'applied_to_existing' FROM audit_log WHERE action = 'plan.update' \
         ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(applied, json!(2));
    drop(state);
    db.drop().await;
}

/// 中-6: a plan taken off sale stops new purchases only — its subscribers
/// still renew it and buy its reset pack (`renew_off_sale`, default on);
/// switched off, or the plan disabled, nobody can buy it.
#[tokio::test]
async fn off_sale_plans_stay_renewable_for_their_subscribers() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let prices = [
        (PeriodKind::Month, None, 1000),
        (PeriodKind::Reset, None, 200),
    ];
    let (_, plan) = catalog_plan(&db, "mi6", &prices, |_| {}).await;
    let (holder, other) = (db.user().await, db.user().await);
    let (hc, oc) = (
        user_client(&state, holder).await,
        user_client(&state, other).await,
    );
    bought(&db, &hc, plan, "month").await;
    let r = admin
        .req(
            axum::http::Method::PUT,
            &format!("/test/api/v1/plans/{plan}/prices"),
            Some(json!({"on_sale": false, "prices": [
                {"period": "month", "price_cents": 1000},
                {"period": "reset", "price_cents": 200}]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let in_shop = |shop: &Value| {
        shop["plans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["plan_id"] == json!(plan))
    };
    assert!(!in_shop(&oc.get("/test/api/v1/me/shop").await.json()));
    let r = buy(&oc, plan, "month").await;
    assert_eq!(r.json()["code"], "shop.not_for_sale");
    let shop = hc.get("/test/api/v1/me/shop").await.json();
    assert!(in_shop(&shop), "{shop}");
    bought(&db, &hc, plan, "month").await;
    bought(&db, &hc, plan, "reset").await;
    // Switched off: the subscriber cannot renew either.
    let r = admin
        .req(
            axum::http::Method::PATCH,
            &format!("/test/api/v1/plans/{plan}"),
            Some(json!({"renew_off_sale": false})),
        )
        .await;
    assert_eq!(r.json()["renew_off_sale"], false);
    assert_eq!(
        buy(&hc, plan, "month").await.json()["code"],
        "shop.not_for_sale"
    );
    // On again, but the plan disabled: not sold at all.
    for body in [json!({"renew_off_sale": true}), json!({"enabled": false})] {
        let r = admin
            .req(
                axum::http::Method::PATCH,
                &format!("/test/api/v1/plans/{plan}"),
                Some(body),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
    }
    assert_eq!(
        buy(&hc, plan, "month").await.json()["code"],
        "shop.not_for_sale"
    );
    drop(state);
    db.drop().await;
}

/// 低-4: a late payment of an old order never silently replaces a plan the
/// buyer got since — it goes to the balance; a late renewal of a plan that
/// expired meanwhile still grants it.
#[tokio::test]
async fn late_payment_never_replaces_a_newer_plan() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, a) = catalog_plan(&db, "lo4-a", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let (_, b) = catalog_plan(&db, "lo4-b", &[(PeriodKind::Month, None, 3000)], |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    // An order for B, left unpaid; the buyer then bought A instead.
    let r = buy(&c, b, "month").await;
    let old_b = order_id(&r);
    sqlx::query("UPDATE orders SET status = 'expired', ended_at = now() WHERE id = $1")
        .bind(old_b)
        .execute(&db.pool)
        .await
        .unwrap();
    bought(&db, &c, a, "month").await;
    // The old B order is paid late: A stays, the money goes to the balance.
    assert_eq!(pay(&db, old_b).await, Paid::Now { fulfilled: false });
    assert_eq!(active_plan(&db, u).await.map(|p| p.0), Some(a));
    let (err, refunded): (Option<String>, Option<i64>) =
        sqlx::query_as("SELECT fulfil_error, refund_balance_cents FROM orders WHERE id = $1")
            .bind(old_b)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(err.unwrap().contains("not replaced"));
    assert_eq!(refunded, Some(3000));
    // A renewal of A whose subscription expired before the payment: granted.
    let r = buy(&c, a, "month").await;
    let renewal = order_id(&r);
    sqlx::query(
        "UPDATE user_plans SET status = 'expired', ended_at = now() \
         WHERE user_id = $1 AND status = 'active'",
    )
    .bind(u)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(pay(&db, renewal).await, Paid::Now { fulfilled: true });
    assert_eq!(active_plan(&db, u).await.map(|p| p.0), Some(a));
    drop(state);
    db.drop().await;
}

/// PR #132 follow-up: the "推荐" flag (default off) is set through the plan
/// update path (audited like every plan field), shown to the shop, and
/// changes nothing about what can be bought.
#[tokio::test]
async fn recommended_flag_reaches_the_shop() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin(&state, &db).await;
    let (_, plan) = catalog_plan(&db, "rec", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    let shown = |shop: &Value| {
        shop["plans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["plan_id"] == json!(plan))
            .map(|p| p["recommended"].clone())
    };
    assert_eq!(
        shown(&c.get("/test/api/v1/me/shop").await.json()),
        Some(json!(false))
    );
    let path = format!("/test/api/v1/plans/{plan}");
    let r = admin
        .req(
            axum::http::Method::PATCH,
            &path,
            Some(json!({"recommended": null})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = admin
        .req(
            axum::http::Method::PATCH,
            &path,
            Some(json!({"recommended": true})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["recommended"], true);
    let (before, after): (Value, Value) = sqlx::query_as(
        "SELECT before->'recommended', after->'recommended' FROM audit_log \
         WHERE action = 'plan.update' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!((before, after), (json!(false), json!(true)));
    assert_eq!(
        shown(&c.get("/test/api/v1/me/shop").await.json()),
        Some(json!(true))
    );
    let listed = admin.get("/test/api/v1/plans").await.json();
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == json!(plan) && p["recommended"] == true),
        "{listed}"
    );
    bought(&db, &c, plan, "month").await;
    drop(state);
    db.drop().await;
}

/// 低-3: switching out of a permanent plan forfeits what is left of it: the
/// shop says so (`forfeits_permanent`), the order is refused without
/// `accept_forfeit` (nothing is created), and goes through with it.
#[tokio::test]
async fn leaving_a_permanent_plan_needs_the_confirmation() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, forever) = catalog_plan(
        &db,
        "l3-forever",
        &[(PeriodKind::Onetime, None, 5000)],
        |_| {},
    )
    .await;
    let (_, other) =
        catalog_plan(&db, "l3-other", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    bought(&db, &c, forever, "onetime").await;
    assert_eq!(expiry(&db, u).await, None, "permanent");
    let shop = c.get("/test/api/v1/me/shop").await.json();
    let offer = shop["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["plan_id"] == json!(other))
        .unwrap()["offers"][0]
        .clone();
    assert_eq!(offer["action"], "switch");
    assert_eq!(offer["forfeits_permanent"], true, "{offer}");
    assert_eq!(offer["credit_cents"], 0);
    let r = buy(&c, other, "month").await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{:?}", r.json());
    assert_eq!(r.json()["code"], "order.forfeit_unconfirmed");
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM orders WHERE user_id = $1 AND plan_id = $2")
            .bind(u)
            .bind(other)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(n, 0, "no order without the confirmation");
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": other, "period": "month", "accept_forfeit": true }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    // An expiring plan needs no confirmation (and says nothing).
    let v = db.user().await;
    let cv = user_client(&state, v).await;
    bought(&db, &cv, other, "month").await;
    let shop = cv.get("/test/api/v1/me/shop").await.json();
    assert!(shop["plans"].as_array().unwrap().iter().all(|p| {
        p["offers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|o| o["forfeits_permanent"] == json!(false))
    }));
    drop(state);
    db.drop().await;
}

/// 低-8: without a usable payment method the shop stays open and an order
/// the balance covers entirely is placed (and paid); one that still needs
/// the gateway is refused (503, no order).
#[tokio::test]
async fn orders_the_balance_covers_need_no_payment_method() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let (_, cheap) =
        catalog_plan(&db, "l8-cheap", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let (_, dear) = catalog_plan(&db, "l8-dear", &[(PeriodKind::Month, None, 90000)], |_| {}).await;
    let u = db.user().await;
    let mut tx = db.pool.begin().await.unwrap();
    super::super::ledger::apply_adjust(
        &mut tx,
        &crate::audit::Actor::test(),
        u,
        &super::super::ledger::AdjustReq {
            amount_cents: 5000,
            reason: "test".into(),
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    let c = user_client(&state, u).await;
    let shop = c.get("/test/api/v1/me/shop").await.json();
    assert_eq!(shop["enabled"], true);
    assert_eq!(shop["payments_available"], false);
    let find = |shop: &Value, plan: Uuid| {
        shop["plans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["plan_id"] == json!(plan))
            .unwrap()["offers"][0]
            .clone()
    };
    let (a, b) = (find(&shop, cheap), find(&shop, dear));
    assert_eq!(
        (a["payable"].clone(), a["balance_only"].clone()),
        (json!(true), json!(true))
    );
    assert_eq!(
        (b["payable"].clone(), b["balance_only"].clone()),
        (json!(false), json!(false))
    );
    // Asked with the balance applied, the cheap one needs nothing more.
    let with = c.get("/test/api/v1/me/shop?use_balance=true").await.json();
    let a = find(&with, cheap);
    assert_eq!(
        (a["amount_cents"].clone(), a["balance_only"].clone()),
        (json!(0), json!(true))
    );
    // The dear one, or the cheap one without the balance: no method, 503.
    for (plan, extra) in [(dear, json!({ "use_balance": true })), (cheap, json!({}))] {
        let mut body = json!({ "plan_id": plan, "period": "month" });
        body["use_balance"] = extra.get("use_balance").cloned().unwrap_or(json!(false));
        let r = c.post("/test/api/v1/me/orders", body).await;
        assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{:?}", r.json());
        assert_eq!(r.json()["code"], "order.payments_off");
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM orders WHERE user_id = $1")
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "refused orders leave nothing");
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": cheap, "period": "month", "use_balance": true }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(r.json()["status"], "paid");
    assert_eq!(r.json()["amount_cents"], 0);
    assert!(active_plan(&db, u).await.is_some());
    drop(state);
    db.drop().await;
}
