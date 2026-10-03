//! Ops tests: manual (admin-created) orders through the one pay path —
//! exactly once, revenue flagged manual, gifts not revenue, refusals leave
//! nothing behind, no amount accepted from the client — and batch coupons:
//! unique codes from the unambiguous alphabet, collisions re-drawn under the
//! database constraint, the W16 last-use race on a batch code, revoke and
//! the CSV export.

use axum::http::StatusCode;
use serde_json::{Value, json};
use uuid::Uuid;

use super::super::catalog::PeriodKind;
use super::super::coupon_batches as cb;
use super::super::manual::{self, ManualOrderReq};
use super::super::orders::{self, Paid, Via};
use super::*;

async fn admin(state: &AppState, db: &TestDb) -> Client {
    let a = db.admin().await;
    user_client(state, a).await
}

async fn count(db: &TestDb, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

fn req(user: Uuid, plan: Uuid, period: PeriodKind, gift: bool) -> ManualOrderReq {
    ManualOrderReq {
        user_id: user,
        plan_id: plan,
        period: PeriodKindText(period),
        gift,
        reason: "银行转账 #42".into(),
    }
}

async fn manual(db: &TestDb, r: &ManualOrderReq) -> Result<Uuid, crate::auth::ApiError> {
    let mut tx = db.pool.begin().await.unwrap();
    let out = manual::apply_create(&mut tx, &crate::audit::Actor::test(), r).await;
    if out.is_ok() {
        tx.commit().await.unwrap();
    }
    out
}

/// A paid manual order is revenue flagged manual; a gift is not revenue;
/// both grant the plan through apply_mark_paid with their audit rows.
#[tokio::test]
async fn manual_order_paid_once_and_flagged() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (_, plan) = catalog_plan(
        &db,
        "manual",
        &[
            (PeriodKind::Month, None, 3000),
            (PeriodKind::Reset, None, 500),
        ],
        |_| {},
    )
    .await;
    let u = db.user().await;
    let audit_before = count(&db, "SELECT count(*) FROM audit_log").await;
    let id = manual(&db, &req(u, plan, PeriodKind::Month, false))
        .await
        .unwrap();
    let (status, via, amount, gift, list, reason, fulfilled): (
        String,
        String,
        i64,
        i64,
        i64,
        String,
        bool,
    ) = sqlx::query_as(
        "SELECT status, paid_via, amount_cents, gift_cents, list_price_cents, manual_reason, \
         fulfilled_at IS NOT NULL FROM orders WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        (
            status.as_str(),
            via.as_str(),
            amount,
            gift,
            list,
            reason.as_str(),
            fulfilled
        ),
        ("paid", "manual", 3000, 0, 3000, "银行转账 #42", true)
    );
    let first_expiry = active_plan(&db, u).await.unwrap().1.unwrap();
    // order.create + order.paid + user.plan.set, all in one transaction.
    let actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM audit_log ORDER BY id OFFSET $1")
            .bind(audit_before)
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(actions, vec!["order.create", "user.plan.set", "order.paid"]);
    // Exactly once: the pay path refuses a second flip, the support action
    // has nothing left to do.
    let mut tx = db.pool.begin().await.unwrap();
    let again = orders::apply_mark_paid(
        &mut tx,
        &crate::audit::Actor::test(),
        id,
        Via::Manual,
        None,
        Some(3000),
        Some("again"),
    )
    .await
    .unwrap();
    assert_eq!(again, Paid::Already);
    let e = orders::apply_admin_fulfil(&mut tx, &crate::audit::Actor::test(), id, "x")
        .await
        .unwrap_err();
    assert_eq!(e.code(), "order_admin.already_fulfilled");
    tx.commit().await.unwrap();
    assert_eq!(active_plan(&db, u).await.unwrap().1.unwrap(), first_expiry);
    // A gift: list price forgiven, amount 0, renewal extends by one period.
    let g = manual(&db, &req(u, plan, PeriodKind::Month, true))
        .await
        .unwrap();
    let (amount, gift): (i64, i64) =
        sqlx::query_as("SELECT amount_cents, gift_cents FROM orders WHERE id = $1")
            .bind(g)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!((amount, gift), (0, 3000));
    assert!(active_plan(&db, u).await.unwrap().1.unwrap() > first_expiry);
    // Revenue: the paid one counts (and is flagged manual), the gift does
    // not; the gift is reported apart.
    let (d, _) = crate::dashboard::read(&db.pool).await.unwrap();
    assert_eq!(
        (
            d.today.revenue_cents,
            d.today.manual_cents,
            d.today.gift_cents,
            d.today.orders
        ),
        (3000, 3000, 3000, 2)
    );
    assert!(
        d.latest_orders
            .iter()
            .all(|o| o.paid_via.as_deref() == Some("manual"))
    );
    // A reset pack for the current holder works; the receipt is queued
    // like any payment (no SMTP here: nothing).
    manual(&db, &req(u, plan, PeriodKind::Reset, true))
        .await
        .unwrap();
    db.drop().await;
}

/// Refusals: unknown user, admin, no price for the period, a pending
/// order, and a fulfilment failure — none leaves an order, a payment or an
/// audit row behind.
#[tokio::test]
async fn manual_order_refusals_leave_nothing() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (_, plan) = catalog_plan(&db, "m2", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let (_, other) = catalog_plan(
        &db,
        "m3",
        &[
            (PeriodKind::Month, None, 900),
            (PeriodKind::Reset, None, 100),
        ],
        |_| {},
    )
    .await;
    let u = db.user().await;
    let a = db.admin().await;
    let before = count(&db, "SELECT count(*) FROM audit_log").await;
    let code = |r: Result<Uuid, crate::auth::ApiError>| r.unwrap_err().code();
    assert_eq!(
        manual(&db, &req(Uuid::new_v4(), plan, PeriodKind::Month, false))
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        code(manual(&db, &req(a, plan, PeriodKind::Month, false)).await),
        "user.admin_no_plan"
    );
    assert_eq!(
        code(manual(&db, &req(u, plan, PeriodKind::Year, false)).await),
        "order_admin.no_price"
    );
    // Reset pack of a plan the user does not hold: the grant fails, the
    // whole order is rolled back.
    let e = manual(&db, &req(u, other, PeriodKind::Reset, false))
        .await
        .unwrap_err();
    assert_eq!(e.code(), "order_admin.manual_not_fulfilled");
    assert!(e.message().contains("reset pack"), "{}", e.message());
    let mut r = req(u, plan, PeriodKind::Month, false);
    r.reason = "  ".into();
    assert_eq!(code(manual(&db, &r).await), "request.reason_length");
    // A pending customer order blocks it (one pending per user).
    order_row(&db, u, plan, 1000, 30).await;
    assert_eq!(
        code(manual(&db, &req(u, plan, PeriodKind::Month, false)).await),
        "order_admin.user_has_pending"
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM orders WHERE paid_via IS NOT NULL"
        )
        .await,
        0
    );
    assert_eq!(count(&db, "SELECT count(*) FROM user_plans").await, 0);
    assert_eq!(count(&db, "SELECT count(*) FROM audit_log").await, before);
    db.drop().await;
}

/// Concurrent manual renewals serialize on entitle::lock: N orders, N
/// periods, never one lost or doubled.
#[tokio::test]
async fn concurrent_manual_renewals_exactly_once_each() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (_, plan) = catalog_plan(&db, "conc", &[(PeriodKind::Days, Some(10), 100)], |_| {}).await;
    let u = db.user().await;
    manual(&db, &req(u, plan, PeriodKind::Days, true))
        .await
        .unwrap();
    let start = active_plan(&db, u).await.unwrap().1.unwrap();
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let pool = db.pool.clone();
        tasks.push(tokio::spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            manual::apply_create(
                &mut tx,
                &crate::audit::Actor::test(),
                &req(u, plan, PeriodKind::Days, false),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    let end = active_plan(&db, u).await.unwrap().1.unwrap();
    assert_eq!((end - start).num_days(), 60);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM orders WHERE status = 'paid' AND paid_via = 'manual'"
        )
        .await,
        7
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM audit_log WHERE action = 'order.paid'"
        )
        .await,
        7
    );
    db.drop().await;
}

/// HTTP: admin only, 201, the body carries no amount (unknown member = 400).
#[tokio::test]
async fn manual_order_http() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let (_, plan) = catalog_plan(&db, "h", &[(PeriodKind::Month, None, 990)], |_| {}).await;
    let u = db.user().await;
    let c = admin(&state, &db).await;
    let body = json!({"user_id": u, "plan_id": plan, "period": "month", "reason": "转账"});
    let mut with_amount = body.clone();
    with_amount["amount_cents"] = json!(1);
    let r = c.post("/test/api/v1/orders/manual", with_amount).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let uc = user_client(&state, u).await;
    let r = uc.post("/test/api/v1/orders/manual", body.clone()).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = c.post("/test/api/v1/orders/manual", body).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let id = r.json()["id"].as_str().unwrap().to_string();
    let r = c.get(&format!("/test/api/v1/orders/{id}")).await;
    let v: Value = r.json();
    assert_eq!(v["order"]["paid_via"], "manual");
    assert_eq!(v["order"]["amount_cents"], 990);
    assert_eq!(v["order"]["gift_cents"], 0);
    assert_eq!(v["events"][0]["outcome"], "manual_order");
    let r = c.get("/test/api/v1/orders?via=manual").await;
    assert_eq!(r.json().as_array().unwrap().len(), 1);
    let r = c.get("/test/api/v1/orders?via=cash").await;
    assert_eq!(r.json()["code"], "export.via_invalid");
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Batch coupons
// ---------------------------------------------------------------------------

fn batch_req(count: i32) -> cb::CreateBatchReq {
    serde_json::from_value(json!({
        "name": "双十一", "prefix": "SALE-", "count": count, "kind": "percent", "value": 20,
        "periods": ["month"]
    }))
    .unwrap()
}

async fn batch(
    db: &TestDb,
    r: &cb::CreateBatchReq,
) -> Result<(Uuid, Vec<String>), crate::auth::ApiError> {
    let mut tx = db.pool.begin().await.unwrap();
    let out = cb::apply_create(&mut tx, &crate::audit::Actor::test(), r).await;
    if out.is_ok() {
        tx.commit().await.unwrap();
    }
    out
}

#[test]
fn draw_and_shape() {
    let codes = cb::draw("P", 8, 2000).unwrap();
    let mut set = std::collections::HashSet::new();
    for c in &codes {
        assert_eq!(c.len(), 9);
        assert!(c.starts_with('P'));
        assert!(c[1..].bytes().all(|b| cb::ALPHABET.contains(&b)), "{c}");
        assert!(!c[1..].contains(['0', 'O', '1', 'I']), "{c}");
        assert!(set.insert(c.to_ascii_lowercase()));
    }
    assert_eq!(cb::ALPHABET.len(), 32);
    let distinct: std::collections::HashSet<_> = cb::ALPHABET.iter().collect();
    assert_eq!(distinct.len(), 32);
    let mut r = batch_req(1);
    r.prefix = Some("bad prefix".into());
    assert_eq!(
        cb::check_shape(&r).unwrap_err().code(),
        "coupon_batch.prefix_invalid"
    );
    let mut r = batch_req(0);
    assert_eq!(
        cb::check_shape(&r).unwrap_err().code(),
        "coupon_batch.count_range"
    );
    r.count = 5001;
    assert_eq!(
        cb::check_shape(&r).unwrap_err().code(),
        "coupon_batch.count_range"
    );
    let mut r = batch_req(1);
    r.length = Some(5);
    assert_eq!(
        cb::check_shape(&r).unwrap_err().code(),
        "coupon_batch.length_range"
    );
    // Per-code uses default to 1; null = unlimited.
    assert_eq!(cb::terms(&batch_req(1)).max_uses, Some(1));
    let r: cb::CreateBatchReq = serde_json::from_value(json!({
        "count": 1, "kind": "fixed", "value": 100, "max_uses": null
    }))
    .unwrap();
    assert_eq!(cb::terms(&r).max_uses, None);
    assert!(
        serde_json::from_value::<cb::CreateBatchReq>(json!({
            "count": 1, "kind": "fixed", "value": 100, "code": "X"
        }))
        .is_err()
    );
}

/// N unique codes, enforced by the database: an existing code (any case)
/// is skipped and drawn again, never duplicated; the template is shared;
/// the audit row has the template, not the codes; revoke disables all.
#[tokio::test]
async fn batch_codes_unique_revoke_and_export() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (id, codes) = batch(&db, &batch_req(500)).await.unwrap();
    assert_eq!(codes.len(), 500);
    assert_eq!(
        count(
            &db,
            "SELECT count(DISTINCT lower(code)) FROM coupons WHERE batch_id IS NOT NULL"
        )
        .await,
        500
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM coupons WHERE kind = 'percent' AND value = 20 \
             AND periods = ARRAY['month'] AND max_uses = 1 AND name = '双十一'"
        )
        .await,
        500
    );
    let audit: Value =
        sqlx::query_scalar("SELECT after FROM audit_log WHERE action = 'coupon.batch.create'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(audit["count"], 500);
    assert!(!audit.to_string().contains(&codes[0]), "codes not audited");
    // The database refuses a case-variant duplicate; insert_codes skips it.
    let mut tx = db.pool.begin().await.unwrap();
    let t = cb::terms(&batch_req(1));
    let dup = codes[0].to_lowercase();
    let fresh = "SALE-FRESHCODE".to_string();
    let got = cb::insert_codes(&mut tx, id, &t, &[dup.clone(), fresh.clone()])
        .await
        .unwrap();
    assert_eq!(got, vec![fresh]);
    let e = sqlx::query("INSERT INTO coupons (id, code, kind, value) VALUES ($1, $2, 'fixed', 1)")
        .bind(Uuid::new_v4())
        .bind(&dup)
        .execute(&mut *tx)
        .await
        .unwrap_err();
    assert!(matches!(e, sqlx::Error::Database(d) if d.is_unique_violation()));
    drop(tx);
    // The single-coupon list does not drown in batch codes.
    let state = AppState::for_test(db.pool.clone()).await;
    let c = admin(&state, &db).await;
    assert_eq!(
        c.get("/test/api/v1/coupons")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let r = c.get("/test/api/v1/coupon-batches").await;
    let v = r.json();
    assert_eq!(v[0]["codes"], 500);
    assert_eq!(v[0]["used"], 0);
    // Export: every code, formula-safe, audited.
    let r = c
        .get(&format!("/test/api/v1/coupon-batches/{id}/export.csv"))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let rows = crate::csvx::parse(&r.body).unwrap();
    assert_eq!(rows.len(), 501);
    assert_eq!(
        rows[0],
        vec!["code", "enabled", "used", "max_uses", "redeemed"]
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM audit_log WHERE action = 'export.coupon_batch'"
        )
        .await,
        1
    );
    // Revoke: all disabled, once.
    let r = c
        .post(
            &format!("/test/api/v1/coupon-batches/{id}/revoke"),
            json!({}),
        )
        .await;
    assert_eq!(r.json()["disabled"], 500);
    assert_eq!(
        count(&db, "SELECT count(*) FROM coupons WHERE enabled").await,
        0
    );
    let r = c
        .post(
            &format!("/test/api/v1/coupon-batches/{id}/revoke"),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "coupon_batch.revoked");
    let r = c
        .post(
            &format!("/test/api/v1/coupon-batches/{}/revoke", Uuid::new_v4()),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // Template validation is the coupons' own.
    let r = c
        .post(
            "/test/api/v1/coupon-batches",
            json!({"count": 2, "kind": "percent", "value": 101}),
        )
        .await;
    assert_eq!(r.json()["code"], "coupon_admin.percent_range");
    let r = c
        .post(
            "/test/api/v1/coupon-batches",
            json!({"count": 2, "kind": "fixed", "value": 100, "plan_ids": [Uuid::new_v4()]}),
        )
        .await;
    assert_eq!(r.json()["code"], "coupon_admin.unknown_plan");
    let r = c
        .post(
            "/test/api/v1/coupon-batches",
            json!({"count": 3, "kind": "fixed", "value": 100, "prefix": "VIP"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(r.json()["count"], 3);
    db.drop().await;
}

/// The W16 race on a batch code: one-use code, eight buyers, exactly one
/// reservation; a revoked batch's code is refused at order creation.
#[tokio::test]
async fn batch_code_redemption_race() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = catalog_plan(&db, "race", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let (bid, codes) = batch(&db, &batch_req(2)).await.unwrap();
    let code = codes[0].clone();
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let u = db.user().await;
        let state = state.clone();
        let code = code.to_lowercase();
        tasks.push(tokio::spawn(async move {
            let c = user_client(&state, u).await;
            c.post(
                "/test/api/v1/me/orders",
                json!({"plan_id": plan, "period": "month", "coupon": code}),
            )
            .await
            .status
        }));
    }
    let mut won = 0;
    for t in tasks {
        let s = t.await.unwrap();
        if s == StatusCode::CREATED {
            won += 1;
        } else {
            assert_eq!(s, StatusCode::CONFLICT);
        }
    }
    assert_eq!(won, 1);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM coupon_redemptions WHERE status = 'reserved'"
        )
        .await,
        1
    );
    let mut tx = db.pool.begin().await.unwrap();
    cb::apply_revoke(&mut tx, &crate::audit::Actor::test(), bid)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let c = user_client(&state, db.user().await).await;
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({"plan_id": plan, "period": "month", "coupon": codes[1]}),
        )
        .await;
    assert_eq!(r.json()["code"], "coupon.invalid");
    // The reservation made before the revoke stands.
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM coupon_redemptions WHERE status = 'reserved'"
        )
        .await,
        1
    );
    drop(state);
    db.drop().await;
}
