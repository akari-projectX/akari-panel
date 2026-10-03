//! W16 tests: coupons (rules, preview, rounding, the last-use race,
//! per-user limits, release and late payments), the balance ledger
//! (invariants under concurrency, full and partial payment, refunds),
//! invite commissions (lifecycle, exactly once under duplicate payment
//! reports and several instances), withdrawals, and the rule that every
//! money movement writes exactly one ledger row + one audit row.

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

use super::super::catalog::PeriodKind;
use super::super::coupons::mirror;
use super::super::ledger::{self, AdjustReq, Entry, Kind};
use super::super::{commission, orders};
use super::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn admin_client(state: &AppState, db: &TestDb) -> Client {
    let a = db.admin().await;
    user_client(state, a).await
}

async fn adjust(db: &TestDb, user: Uuid, cents: i64) -> Result<i64, crate::auth::ApiError> {
    let mut tx = db.pool.begin().await.unwrap();
    let r = ledger::apply_adjust(
        &mut tx,
        &crate::audit::Actor::test(),
        user,
        &AdjustReq {
            amount_cents: cents,
            reason: "test".into(),
        },
    )
    .await;
    if r.is_ok() {
        tx.commit().await.unwrap();
    }
    r
}

async fn balance(db: &TestDb, user: Uuid) -> i64 {
    let mut c = db.pool.acquire().await.unwrap();
    ledger::balance(&mut c, user).await.unwrap()
}

/// balance = sum(ledger) >= 0 for every user.
async fn assert_ledger_consistent(db: &TestDb) {
    let bad: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM (SELECT u.id, COALESCE(b.balance_cents, 0) AS bal, \
           COALESCE((SELECT sum(amount_cents) FROM balance_ledger l WHERE l.user_id = u.id), 0) AS s \
         FROM users u LEFT JOIN user_balances b ON b.user_id = u.id) x \
         WHERE x.bal <> x.s OR x.bal < 0",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(bad, 0, "balance != sum(ledger)");
}

async fn scalar_i64(db: &TestDb, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn set_commission(db: &TestDb, enabled: bool, rate: i32, first_only: bool, hold: i32) {
    let mut tx = db.pool.begin().await.unwrap();
    commission::apply_update_settings(
        &mut tx,
        &crate::audit::Actor::test(),
        &commission::Settings {
            enabled,
            rate_percent: rate,
            first_order_only: first_only,
            hold_days: hold,
            min_withdrawal_cents: 50,
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
}

async fn invite(db: &TestDb, inviter: Uuid, invitee: Uuid) {
    sqlx::query("UPDATE users SET inviter_id = $1 WHERE id = $2")
        .bind(inviter)
        .bind(invitee)
        .execute(&db.pool)
        .await
        .unwrap();
}

/// Poll an order until it is no longer pending (the mock trade is paid).
async fn poll_until_paid(db: &TestDb, c: &Client, order: Uuid) -> Value {
    for _ in 0..20 {
        sqlx::query("UPDATE orders SET last_query_at = NULL WHERE id = $1")
            .bind(order)
            .execute(&db.pool)
            .await
            .unwrap();
        let r = c.get(&format!("/test/api/v1/me/orders/{order}")).await;
        assert_eq!(r.status, StatusCode::OK);
        if r.json()["status"] == "paid" {
            return r.json();
        }
    }
    panic!("order {order} not paid");
}

async fn buy_with(c: &Client, plan: Uuid, period: &str, extra: Value) -> crate::testdb::http::Resp {
    let mut body = json!({ "plan_id": plan, "period": period });
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    c.post("/test/api/v1/me/orders", body).await
}

async fn create_coupon(admin: &Client, body: Value) -> Uuid {
    let r = admin.post("/test/api/v1/coupons", body.clone()).await;
    assert_eq!(r.status, StatusCode::CREATED, "{body} {:?}", r.json());
    r.json()["id"].as_str().unwrap().parse().unwrap()
}

fn offer<'a>(shop: &'a Value, plan: Uuid, period: &str) -> &'a Value {
    let p = shop["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["plan_id"] == json!(plan))
        .unwrap_or_else(|| panic!("plan {plan} not in {shop}"));
    p["offers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["period"] == period)
        .unwrap()
}

async fn coupon_used(db: &TestDb, code: &str) -> i32 {
    sqlx::query_scalar("SELECT used FROM coupons WHERE lower(code) = lower($1)")
        .bind(code)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn redemption(db: &TestDb, order: Uuid) -> Option<(String, bool)> {
    sqlx::query_as("SELECT status, over_limit FROM coupon_redemptions WHERE order_id = $1")
        .bind(order)
        .fetch_optional(&db.pool)
        .await
        .unwrap()
}

fn otn_of(r: &crate::testdb::http::Resp) -> String {
    r.json()["out_trade_no"].as_str().unwrap().to_string()
}

// ---------------------------------------------------------------------------
// SQL money functions vs the mirrors
// ---------------------------------------------------------------------------

#[tokio::test]
async fn money_sql_matches_the_mirrors() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let lists = [
        1i64,
        2,
        3,
        50,
        99,
        100,
        101,
        333,
        999,
        1000,
        4999,
        100_000_000,
    ];
    for &list in &lists {
        for (percent, value) in [
            (true, 1i64),
            (true, 15),
            (true, 20),
            (true, 33),
            (true, 50),
            (true, 99),
            (true, 100),
            (false, 1),
            (false, 50),
            (false, 999),
            (false, 100_000_000),
        ] {
            let kind = if percent { "percent" } else { "fixed" };
            let sql: i64 = sqlx::query_scalar("SELECT akari_coupon_discount($1, $2, $3)")
                .bind(list)
                .bind(kind)
                .bind(value)
                .fetch_one(&db.pool)
                .await
                .unwrap();
            let want = mirror::discount(list, percent, value);
            assert_eq!(sql, want, "{list} {kind} {value}");
            assert!((0..=list).contains(&sql));
            if percent {
                // Floors: never more than the stated percentage.
                assert!(sql * 100 <= list * value);
            }
        }
        for (d, c, b) in [
            (0i64, 0i64, 0i64),
            (list / 3, list / 3, list / 3),
            (list, 5, 5),
            (0, list * 2, 0),
            (0, 0, list * 2),
            (-5, -5, -5),
            (list / 2, list, list),
        ] {
            let got: (i64, i64, i64, i64) = sqlx::query_as(
                "SELECT discount_cents, credit_cents, balance_cents, amount_cents \
                 FROM akari_split($1, $2, $3, $4)",
            )
            .bind(list)
            .bind(d)
            .bind(c)
            .bind(b)
            .fetch_one(&db.pool)
            .await
            .unwrap();
            assert_eq!(got, mirror::split(list, d, c, b), "{list} {d} {c} {b}");
            assert!(got.3 >= 0 && got.0 + got.1 + got.2 + got.3 == list);
        }
    }
    let mut c = db.pool.acquire().await.unwrap();
    assert!(
        super::super::catalog::splits(&mut c, &[])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        sqlx::query("SELECT * FROM akari_split(0, 0, 0, 0)")
            .execute(&mut *c)
            .await
            .is_err()
    );
    drop(c);
    db.drop().await;
}

#[test]
fn coupon_codes() {
    use super::super::coupons::{Refusal, normalize_code};
    assert_eq!(normalize_code(" Save-20_x "), Some("Save-20_x".into()));
    for bad in ["", "ab", "a b c", "abc!", "ünï", &"x".repeat(33)] {
        assert_eq!(normalize_code(bad), None, "{bad:?}");
    }
    assert_eq!(normalize_code(&"x".repeat(32)).map(|s| s.len()), Some(32));
    for r in [
        "invalid",
        "not_started",
        "expired",
        "used_up",
        "user_limit",
        "new_users_only",
        "plan",
        "period",
        "below_minimum",
    ] {
        let p = Refusal::parse(r).unwrap();
        assert_eq!(serde_json::to_value(p).unwrap(), json!(r));
        let e = p.error();
        assert!(
            e.status() == StatusCode::CONFLICT || e.status() == StatusCode::BAD_REQUEST,
            "{r}"
        );
    }
    assert_eq!(Refusal::parse("nope"), None);
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

#[tokio::test]
async fn coupon_rules_preview_and_admin_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, a) = catalog_plan(
        &db,
        "A",
        &[
            (PeriodKind::Month, None, 1000),
            (PeriodKind::Year, None, 9999),
        ],
        |_| {},
    )
    .await;
    let (_, b) = catalog_plan(&db, "B", &[(PeriodKind::Month, None, 999)], |_| {}).await;
    let admin = admin_client(&state, &db).await;

    // Validation.
    for (body, want) in [
        (
            json!({"code": "a!", "kind": "percent", "value": 10}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "ZERO", "kind": "percent", "value": 0}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "OVER", "kind": "percent", "value": 101}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "FIX0", "kind": "fixed", "value": 0}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "FIXB", "kind": "fixed", "value": 100_000_001}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "UNK", "kind": "fixed", "value": 1, "plan_ids": [Uuid::new_v4()]}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "EMPTY", "kind": "fixed", "value": 1, "plan_ids": []}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "EMPTYP", "kind": "fixed", "value": 1, "periods": []}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "BADP", "kind": "fixed", "value": 1, "periods": ["weekly"]}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "MINB", "kind": "fixed", "value": 1, "min_amount_cents": -1}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "LIM0", "kind": "fixed", "value": 1, "max_uses": 0}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "LIMU", "kind": "fixed", "value": 1, "per_user_limit": 0}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "NAME", "kind": "fixed", "value": 1, "name": "x".repeat(101)}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "DATES", "kind": "fixed", "value": 1,
                "starts_at": "2026-10-02T00:00:00Z", "ends_at": "2026-10-01T00:00:00Z"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "UNKF", "kind": "fixed", "value": 1, "amount": 1}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"code": "KIND", "kind": "gift", "value": 1}),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let r = admin.post("/test/api/v1/coupons", body.clone()).await;
        assert_eq!(r.status, want, "{body}");
    }
    let user = db.user().await;
    let uc = user_client(&state, user).await;
    assert_eq!(
        uc.post(
            "/test/api/v1/coupons",
            json!({"code": "USER", "kind": "fixed", "value": 1})
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );

    let save20 = create_coupon(
        &admin,
        json!({"code": "SAVE20", "name": "二成", "kind": "percent", "value": 20}),
    )
    .await;
    let r = admin
        .post(
            "/test/api/v1/coupons",
            json!({"code": "save20", "kind": "percent", "value": 5}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    create_coupon(
        &admin,
        json!({"code": "ONLYA", "kind": "fixed", "value": 300, "plan_ids": [a, a],
               "periods": ["month"], "min_amount_cents": 500}),
    )
    .await;
    create_coupon(
        &admin,
        json!({"code": "R33", "kind": "percent", "value": 33}),
    )
    .await;
    create_coupon(
        &admin,
        json!({"code": "MIN1000", "kind": "fixed", "value": 100, "min_amount_cents": 1000}),
    )
    .await;
    create_coupon(
        &admin,
        json!({"code": "OLD", "kind": "percent", "value": 10,
                                 "ends_at": "2020-01-01T00:00:00Z"}),
    )
    .await;
    create_coupon(
        &admin,
        json!({"code": "SOON", "kind": "percent", "value": 10,
                                 "starts_at": "2099-01-01T00:00:00Z"}),
    )
    .await;
    let off = create_coupon(
        &admin,
        json!({"code": "OFF", "kind": "percent", "value": 10, "enabled": false}),
    )
    .await;
    create_coupon(
        &admin,
        json!({"code": "NEWBIE", "kind": "percent", "value": 50, "new_users_only": true}),
    )
    .await;
    create_coupon(
        &admin,
        json!({"code": "BIG", "kind": "fixed", "value": 5000}),
    )
    .await;

    let shop = |code: &str| {
        let uc = &uc;
        let path = format!("/test/api/v1/me/shop?coupon={code}");
        async move {
            let r = uc.get(&path).await;
            assert_eq!(r.status, StatusCode::OK);
            r.json()
        }
    };
    // Case-insensitive; percent of each list price, floored.
    let s = shop("save20").await;
    assert_eq!(s["coupon"], json!({"code": "SAVE20", "refusal": null}));
    let o = offer(&s, a, "month");
    assert_eq!(
        (
            o["discount_cents"].clone(),
            o["amount_cents"].clone(),
            o["coupon_refusal"].clone()
        ),
        (json!(200), json!(800), Value::Null)
    );
    // 999 x 20% = 199.8 -> 199.
    assert_eq!(offer(&s, b, "month")["discount_cents"], 199);
    assert_eq!(offer(&s, b, "month")["amount_cents"], 800);
    let s = shop("R33").await;
    assert_eq!(offer(&s, a, "month")["discount_cents"], 330);
    assert_eq!(offer(&s, b, "month")["discount_cents"], 329);
    assert_eq!(offer(&s, a, "year")["discount_cents"], 3299);
    // Scope: plan, period, minimum.
    let s = shop("onlya").await;
    assert_eq!(s["coupon"]["refusal"], Value::Null);
    assert_eq!(offer(&s, a, "month")["discount_cents"], 300);
    assert_eq!(offer(&s, a, "year")["coupon_refusal"], "period");
    assert_eq!(offer(&s, a, "year")["discount_cents"], 0);
    assert_eq!(offer(&s, b, "month")["coupon_refusal"], "plan");
    assert_eq!(offer(&s, b, "month")["amount_cents"], 999);
    let s = shop("MIN1000").await;
    assert_eq!(offer(&s, b, "month")["coupon_refusal"], "below_minimum");
    assert_eq!(offer(&s, a, "month")["discount_cents"], 100);
    // Whole-code refusals.
    for (code, want) in [
        ("NOPE", "invalid"),
        ("a!", "invalid"),
        ("OLD", "expired"),
        ("SOON", "not_started"),
        ("OFF", "invalid"),
    ] {
        let s = shop(code).await;
        assert_eq!(s["coupon"]["refusal"], want, "{code}");
        assert_eq!(offer(&s, a, "month")["amount_cents"], 1000, "{code}");
    }
    // Fixed above the list price: the order costs nothing.
    let s = shop("BIG").await;
    assert_eq!(offer(&s, a, "month")["discount_cents"], 1000);
    assert_eq!(offer(&s, a, "month")["amount_cents"], 0);
    // No coupon: the plain prices.
    let s = uc.get("/test/api/v1/me/shop").await.json();
    assert_eq!(s["coupon"], Value::Null);
    assert_eq!(offer(&s, a, "month")["discount_cents"], 0);
    assert_eq!(
        uc.get("/test/api/v1/me/shop?amount=1").await.status,
        StatusCode::BAD_REQUEST
    );

    // An order with a coupon: priced by the server, reserved.
    let r = buy_with(&uc, a, "month", json!({"coupon": "save20"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let o1 = order_id(&r);
    let j = r.json();
    assert_eq!(
        (
            j["amount_cents"].clone(),
            j["discount_cents"].clone(),
            j["coupon_code"].clone()
        ),
        (json!(800), json!(200), json!("SAVE20"))
    );
    assert_eq!(mock.inner.lock().unwrap().trades[&otn_of(&r)].total, "8.00");
    assert_eq!(coupon_used(&db, "SAVE20").await, 1);
    assert_eq!(redemption(&db, o1).await, Some(("reserved".into(), false)));
    // Cancel: the reservation is released.
    let r = uc
        .post(&format!("/test/api/v1/me/orders/{o1}/cancel"), json!({}))
        .await;
    assert_eq!(r.json()["status"], "cancelled");
    assert_eq!(coupon_used(&db, "SAVE20").await, 0);
    assert_eq!(redemption(&db, o1).await, Some(("released".into(), false)));

    // Refusals at creation.
    for (code, status) in [
        ("NOPE", StatusCode::BAD_REQUEST),
        ("bad code!", StatusCode::BAD_REQUEST),
        ("OLD", StatusCode::CONFLICT),
        ("SOON", StatusCode::CONFLICT),
        ("ONLYA", StatusCode::CONFLICT),
    ] {
        let r = buy_with(&uc, b, "month", json!({"coupon": code})).await;
        assert_eq!(r.status, status, "{code}");
    }
    // A coupon worth the whole price: paid at creation, never at Alipay.
    let precreates = mock.calls("alipay.trade.precreate");
    let r = buy_with(&uc, a, "month", json!({"coupon": "BIG"})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let big = order_id(&r);
    assert_eq!(
        (
            r.json()["status"].clone(),
            r.json()["fulfilled"].clone(),
            r.json()["amount_cents"].clone()
        ),
        (json!("paid"), json!(true), json!(0))
    );
    assert_eq!(mock.calls("alipay.trade.precreate"), precreates);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT paid_via FROM orders WHERE id = $1")
            .bind(big)
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "coupon"
    );
    assert_eq!(redemption(&db, big).await, Some(("redeemed".into(), false)));
    // New customers only: this user has paid now.
    let r = buy_with(&uc, a, "month", json!({"coupon": "NEWBIE"})).await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (
            StatusCode::CONFLICT,
            json!("coupon is for new customers only")
        )
    );
    let fresh = user_client(&state, db.user().await).await;
    let s = fresh.get("/test/api/v1/me/shop?coupon=newbie").await.json();
    assert_eq!(offer(&s, a, "month")["discount_cents"], 500);
    // A 1% coupon on a 1-fen... a coupon discounting nothing is not used.
    let (_, tiny) = catalog_plan(&db, "tiny", &[(PeriodKind::Month, None, 50)], |_| {}).await;
    create_coupon(
        &admin,
        json!({"code": "ONEPCT", "kind": "percent", "value": 1}),
    )
    .await;
    let r = buy_with(&fresh, tiny, "month", json!({"coupon": "ONEPCT"})).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(
        (
            r.json()["discount_cents"].clone(),
            r.json()["coupon_code"].clone()
        ),
        (json!(0), Value::Null)
    );
    assert_eq!(coupon_used(&db, "ONEPCT").await, 0);

    // Admin: list, detail with redemptions, update, delete.
    let list = admin.get("/test/api/v1/coupons").await;
    assert_eq!(list.status, StatusCode::OK);
    assert!(list.json().as_array().unwrap().len() >= 10);
    let d = admin
        .get(&format!("/test/api/v1/coupons/{save20}"))
        .await
        .json();
    assert_eq!(d["coupon"]["code"], "SAVE20");
    assert_eq!(d["redemptions"][0]["status"], "released");
    assert_eq!(
        admin
            .get(&format!("/test/api/v1/coupons/{}", Uuid::new_v4()))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let patch = |id: Uuid, body: Value| {
        let admin = &admin;
        async move {
            admin
                .req(
                    Method::PATCH,
                    &format!("/test/api/v1/coupons/{id}"),
                    Some(body),
                )
                .await
                .status
        }
    };
    assert_eq!(
        patch(
            save20,
            json!({"name": "改名", "max_uses": 5, "plan_ids": [a],
                                     "periods": ["month", "year"], "ends_at": null})
        )
        .await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        patch(save20, json!({"value": 0})).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        patch(save20, json!({"plan_ids": [Uuid::new_v4()]})).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        patch(save20, json!({"code": "X"})).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        patch(Uuid::new_v4(), json!({"name": "x"})).await,
        StatusCode::NOT_FOUND
    );
    let big_id: Uuid = sqlx::query_scalar("SELECT id FROM coupons WHERE code = 'BIG'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    // 1 use counted: max_uses may not go below it.
    assert_eq!(
        patch(
            big_id,
            json!({"max_uses": 1, "kind": "percent", "value": 100})
        )
        .await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        patch(big_id, json!({"max_uses": null})).await,
        StatusCode::NO_CONTENT
    );
    sqlx::query("UPDATE coupons SET used = 2 WHERE id = $1")
        .bind(big_id)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        patch(big_id, json!({"max_uses": 1})).await,
        StatusCode::CONFLICT
    );
    let del = |id: Uuid| {
        let admin = &admin;
        async move {
            admin
                .req(Method::DELETE, &format!("/test/api/v1/coupons/{id}"), None)
                .await
                .status
        }
    };
    assert_eq!(del(big_id).await, StatusCode::CONFLICT);
    assert_eq!(del(off).await, StatusCode::NO_CONTENT);
    assert_eq!(del(off).await, StatusCode::NOT_FOUND);
    for action in ["coupon.create", "coupon.update", "coupon.delete"] {
        assert!(
            scalar_i64(
                &db,
                &format!("SELECT count(*) FROM audit_log WHERE action = '{action}'")
            )
            .await
                >= 1,
            "{action}"
        );
    }
    drop(state);
    db.drop().await;
}

/// N buyers race for a coupon's last use: exactly one gets it. One buyer
/// racing herself past the per-user limit: once.
#[tokio::test]
async fn coupon_last_use_race_and_per_user_limit() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = catalog_plan(&db, "race", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let admin = admin_client(&state, &db).await;
    create_coupon(
        &admin,
        json!({"code": "LAST", "kind": "percent", "value": 10, "max_uses": 1}),
    )
    .await;
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let u = db.user().await;
        let state = state.clone();
        tasks.push(tokio::spawn(async move {
            let c = user_client(&state, u).await;
            buy_with(&c, plan, "month", json!({"coupon": "LAST"})).await
        }));
    }
    let mut results = Vec::new();
    for t in tasks {
        results.push(t.await.unwrap());
    }
    let won = results
        .iter()
        .filter(|r| r.status == StatusCode::CREATED)
        .count();
    assert_eq!(
        won,
        1,
        "{:?}",
        results.iter().map(|r| r.status).collect::<Vec<_>>()
    );
    for r in results.iter().filter(|r| r.status != StatusCode::CREATED) {
        assert_eq!(
            (r.status, r.json()["error"].clone()),
            (StatusCode::CONFLICT, json!("coupon has been used up"))
        );
    }
    assert_eq!(coupon_used(&db, "LAST").await, 1);
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT count(*) FROM coupon_redemptions WHERE status = 'reserved'"
        )
        .await,
        1
    );

    // Per user: one use; the same buyer racing two fully covered orders.
    create_coupon(
        &admin,
        json!({"code": "ONCE", "kind": "percent", "value": 100, "per_user_limit": 1}),
    )
    .await;
    let me = user_client(&state, db.user().await).await;
    let (r1, r2) = tokio::join!(
        buy_with(&me, plan, "month", json!({"coupon": "ONCE"})),
        buy_with(&me, plan, "month", json!({"coupon": "ONCE"})),
    );
    let mut st = vec![r1.status, r2.status];
    st.sort();
    assert_eq!(st, vec![StatusCode::CREATED, StatusCode::CONFLICT]);
    assert_eq!(coupon_used(&db, "ONCE").await, 1);
    let r = buy_with(&me, plan, "month", json!({"coupon": "once"})).await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (
            StatusCode::CONFLICT,
            json!("you have already used this coupon")
        )
    );
    // A pending order counts too; a new order ends it and so releases it.
    create_coupon(
        &admin,
        json!({"code": "PEND", "kind": "percent", "value": 10, "per_user_limit": 1}),
    )
    .await;
    let other = user_client(&state, db.user().await).await;
    let p1 = order_id(&buy_with(&other, plan, "month", json!({"coupon": "PEND"})).await);
    let r = buy_with(&other, plan, "month", json!({"coupon": "PEND"})).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(redemption(&db, p1).await, Some(("released".into(), false)));
    assert_eq!(coupon_used(&db, "PEND").await, 1);
    drop(state);
    db.drop().await;
}

/// Expiry releases the reservation; a late payment of the expired order
/// re-reserves it, or is honoured over the limit when it is used up.
#[tokio::test]
async fn coupon_release_on_expiry_and_late_payment() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = catalog_plan(&db, "late", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let admin = admin_client(&state, &db).await;
    create_coupon(
        &admin,
        json!({"code": "ONE", "kind": "fixed", "value": 100, "max_uses": 1}),
    )
    .await;
    let u1 = user_client(&state, db.user().await).await;
    let u2 = user_client(&state, db.user().await).await;
    let r = buy_with(&u1, plan, "month", json!({"coupon": "ONE"})).await;
    let (o1, otn1) = (order_id(&r), otn_of(&r));
    sqlx::query("UPDATE orders SET expires_at = now() - interval '1 minute', last_query_at = NULL WHERE id = $1")
        .bind(o1)
        .execute(&db.pool)
        .await
        .unwrap();
    orders::reconcile_tick(&state).await.ok().unwrap();
    assert_eq!(order_status(&db, o1).await.0, "expired");
    assert_eq!(coupon_used(&db, "ONE").await, 0);
    let r = buy_with(&u2, plan, "month", json!({"coupon": "ONE"})).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(coupon_used(&db, "ONE").await, 1);
    // u1 pays the expired order after all (9.00, the discounted amount).
    let r = post_notify(
        &state,
        rand_ip(),
        form(&notify_params(&otn1, "9.00", "TRADE_SUCCESS")),
    )
    .await;
    assert_eq!(r.body, b"success");
    assert_eq!(order_status(&db, o1).await, ("paid".into(), true, None));
    assert_eq!(redemption(&db, o1).await, Some(("redeemed".into(), true)));
    assert_eq!(coupon_used(&db, "ONE").await, 1);
    let after: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'order.paid' AND target_id = $1::text",
    )
    .bind(o1)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(after["coupon"]["over_limit"], true);
    // A late payment while a use is free re-reserves it (counted).
    create_coupon(
        &admin,
        json!({"code": "TWO", "kind": "fixed", "value": 100, "max_uses": 2}),
    )
    .await;
    let u3 = user_client(&state, db.user().await).await;
    let r = buy_with(&u3, plan, "month", json!({"coupon": "TWO"})).await;
    let (o3, otn3) = (order_id(&r), otn_of(&r));
    let r = u3
        .post(&format!("/test/api/v1/me/orders/{o3}/cancel"), json!({}))
        .await;
    assert_eq!(r.json()["status"], "cancelled");
    assert_eq!(coupon_used(&db, "TWO").await, 0);
    let r = post_notify(
        &state,
        rand_ip(),
        form(&notify_params(&otn3, "9.00", "TRADE_SUCCESS")),
    )
    .await;
    assert_eq!(r.body, b"success");
    assert_eq!(redemption(&db, o3).await, Some(("redeemed".into(), false)));
    assert_eq!(coupon_used(&db, "TWO").await, 1);
    // Idempotent: releasing/redeeming again changes nothing.
    let mut c = db.pool.acquire().await.unwrap();
    assert!(!super::super::coupons::release(&mut c, o3).await.unwrap());
    assert_eq!(
        super::super::coupons::redeem(&mut c, o3).await.unwrap(),
        Some(
            json!({"coupon_id": super::super::coupons::lock(&mut c, "TWO").await.unwrap().unwrap(), "over_limit": false})
        )
    );
    drop(c);
    drop(state);
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

#[tokio::test]
async fn balance_ledger_invariants() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let u = db.user().await;
    assert_eq!(balance(&db, u).await, 0);
    assert_eq!(adjust(&db, u, 1000).await.ok(), Some(1000));
    assert_eq!(adjust(&db, u, -300).await.ok(), Some(700));
    let e = adjust(&db, u, -800).await.err().unwrap();
    assert_eq!(
        (e.status(), e.message()),
        (StatusCode::CONFLICT, "insufficient balance")
    );
    assert_eq!(
        adjust(&db, u, 0).await.err().unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        adjust(&db, u, ledger::MAX_ADJUST_CENTS + 1)
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        adjust(&db, Uuid::new_v4(), 1).await.err().unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let a = db.admin().await;
    assert_eq!(
        adjust(&db, a, 1).await.err().unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let mut tx = db.pool.begin().await.unwrap();
    let r = ledger::apply_adjust(
        &mut tx,
        &crate::audit::Actor::test(),
        u,
        &AdjustReq {
            amount_cents: 5,
            reason: "  ".into(),
        },
    )
    .await;
    assert_eq!(r.err().unwrap().status(), StatusCode::BAD_REQUEST);
    drop(tx);
    // Nothing but the ledger moves a balance, and the ledger is append-only.
    for sql in [
        "UPDATE user_balances SET balance_cents = 5",
        "UPDATE user_balances SET balance_cents = balance_cents + 1",
        "UPDATE balance_ledger SET amount_cents = 1",
        "UPDATE balance_ledger SET reason = 'x'",
        "DELETE FROM balance_ledger",
    ] {
        assert!(
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&db.pool)
                .await
                .is_err(),
            "{sql}"
        );
    }
    let v = db.user().await;
    assert!(
        sqlx::query("INSERT INTO user_balances (user_id, balance_cents) VALUES ($1, 5)")
            .bind(v)
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert!(sqlx::query(
        "INSERT INTO balance_ledger (user_id, user_login, kind, amount_cents, reason, actor_login) \
         VALUES (NULL, 'x', 'admin_adjust', 5, 'r', 'x')"
    )
    .execute(&db.pool)
    .await
    .is_err());
    // A row created at 0 is fine (the lock helper).
    let mut c = db.pool.acquire().await.unwrap();
    assert_eq!(ledger::lock_balance(&mut c, v).await.unwrap(), 0);
    // The entry helper refuses a vanished user.
    let e = ledger::apply_entry(
        &mut c,
        &crate::audit::Actor::test(),
        &Entry::new(Uuid::new_v4(), Kind::AdminAdjust, 1),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(e.status(), StatusCode::CONFLICT);
    drop(c);

    // Concurrent spends never overdraw: 700 / 300 each -> two succeed.
    let mut tasks = Vec::new();
    for _ in 0..10 {
        let pool = db.pool.clone();
        tasks.push(tokio::spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            let mut e = Entry::new(u, Kind::AdminAdjust, -300);
            e.reason = Some("race");
            let r = ledger::apply_entry(&mut tx, &crate::audit::Actor::test(), &e).await;
            if r.is_ok() {
                tx.commit().await.unwrap();
            }
            r.is_ok()
        }));
    }
    let mut ok = 0;
    for t in tasks {
        ok += usize::from(t.await.unwrap());
    }
    assert_eq!(ok, 2);
    assert_eq!(balance(&db, u).await, 100);
    assert_ledger_consistent(&db).await;
    // Every movement: exactly one balance.* audit row.
    assert_eq!(
        scalar_i64(&db, "SELECT count(*) FROM balance_ledger").await,
        scalar_i64(
            &db,
            "SELECT count(*) FROM audit_log WHERE action LIKE 'balance.%'"
        )
        .await
    );
    // Deleting the user keeps the ledger (user_id -> NULL).
    let n = scalar_i64(&db, "SELECT count(*) FROM balance_ledger").await;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT count(*) FROM balance_ledger WHERE user_id IS NULL"
        )
        .await,
        n
    );
    db.drop().await;
}

#[tokio::test]
async fn balance_http_endpoints() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin_client(&state, &db).await;
    let u = db.user().await;
    let uc = user_client(&state, u).await;
    let login: String = sqlx::query_scalar("SELECT login FROM users WHERE id = $1")
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let path = format!("/test/api/v1/users/{u}/balance");
    let r = admin
        .post(&path, json!({"amount_cents": 1234, "reason": "补偿"}))
        .await;
    assert_eq!(
        (r.status, r.json()["balance_cents"].clone()),
        (StatusCode::OK, json!(1234))
    );
    assert_eq!(
        admin
            .post(&path, json!({"amount_cents": -5000, "reason": "x"}))
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        admin
            .post(&path, json!({"amount_cents": 1, "reason": "x", "x": 1}))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        uc.post(&path, json!({"amount_cents": 1, "reason": "x"}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let r = admin.get(&path).await;
    assert_eq!(r.status, StatusCode::OK);
    let j = r.json();
    assert_eq!(
        (j["balance_cents"].clone(), j["withdrawable_cents"].clone()),
        (json!(1234), json!(0))
    );
    assert_eq!(j["entries"][0]["kind"], "admin_adjust");
    assert_eq!(j["entries"][0]["reason"], "补偿");
    assert_eq!(
        j["entries"][0]["actor_login"],
        json!(
            sqlx::query_scalar::<_, String>("SELECT actor_login FROM balance_ledger LIMIT 1")
                .fetch_one(&db.pool)
                .await
                .unwrap()
        )
    );
    assert_eq!(
        admin
            .get(&format!("/test/api/v1/users/{}/balance", Uuid::new_v4()))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(uc.get(&path).await.status, StatusCode::FORBIDDEN);
    let r = admin
        .get(&format!("/test/api/v1/balances?login={login}"))
        .await;
    assert_eq!(r.json()[0]["balance_cents"], 1234);
    assert_eq!(
        admin
            .get("/test/api/v1/balances")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        uc.get("/test/api/v1/balances").await.status,
        StatusCode::FORBIDDEN
    );
    // A customer without a balance row is found by login (balance 0).
    let v = db.user().await;
    let r = admin.get(&format!("/test/api/v1/balances?login={v}")).await;
    assert_eq!(
        (
            r.json()[0]["user_id"].clone(),
            r.json()[0]["balance_cents"].clone()
        ),
        (json!(v), json!(0))
    );
    let r = uc.get("/test/api/v1/me/balance").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["balance_cents"], 1234);
    assert_eq!(r.json()["entries"].as_array().unwrap().len(), 1);
    assert!(r.json()["entries"][0].get("actor_login").is_none());
    let first = r.json()["entries"][0]["id"].as_i64().unwrap();
    let r = uc
        .get(&format!("/test/api/v1/me/balance?before={first}"))
        .await;
    assert_eq!(r.json()["entries"].as_array().unwrap().len(), 0);
    assert_eq!(
        uc.get("/test/api/v1/me/balance?nope=1").await.status,
        StatusCode::BAD_REQUEST
    );
    drop(state);
    db.drop().await;
}

/// Full and partial payment by balance, refund of the balance part when
/// the order ends unpaid, re-taking it on a late payment, and the late
/// payment that finds the balance spent.
#[tokio::test]
async fn balance_payments_partial_and_late() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = catalog_plan(&db, "bal", &[(PeriodKind::Month, None, 1000)], |_| {}).await;

    // Full: paid at creation, never at Alipay.
    let u = db.user().await;
    adjust(&db, u, 1500).await.ok().unwrap();
    let uc = user_client(&state, u).await;
    let s = uc.get("/test/api/v1/me/shop?use_balance=true").await.json();
    assert_eq!(s["balance_cents"], 1500);
    assert_eq!(
        (
            offer(&s, plan, "month")["balance_cents"].clone(),
            offer(&s, plan, "month")["amount_cents"].clone()
        ),
        (json!(1000), json!(0))
    );
    let pre = mock.calls("alipay.trade.precreate");
    let r = buy_with(&uc, plan, "month", json!({"use_balance": true})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let full = order_id(&r);
    assert_eq!(
        (
            r.json()["status"].clone(),
            r.json()["balance_cents"].clone(),
            r.json()["amount_cents"].clone()
        ),
        (json!("paid"), json!(1000), json!(0))
    );
    assert_eq!(mock.calls("alipay.trade.precreate"), pre);
    assert_eq!(balance(&db, u).await, 500);
    assert!(active_plan(&db, u).await.is_some());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT paid_via FROM orders WHERE id = $1")
            .bind(full)
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "balance"
    );

    // Partial: Alipay is asked for the rest only; cancel gives it back.
    let u2 = db.user().await;
    adjust(&db, u2, 300).await.ok().unwrap();
    let c2 = user_client(&state, u2).await;
    let r = buy_with(&c2, plan, "month", json!({"use_balance": true})).await;
    let o = order_id(&r);
    assert_eq!(
        (
            r.json()["status"].clone(),
            r.json()["balance_cents"].clone(),
            r.json()["amount_cents"].clone()
        ),
        (json!("pending"), json!(300), json!(700))
    );
    assert_eq!(mock.inner.lock().unwrap().trades[&otn_of(&r)].total, "7.00");
    assert_eq!(balance(&db, u2).await, 0);
    let r = c2
        .post(&format!("/test/api/v1/me/orders/{o}/cancel"), json!({}))
        .await;
    assert_eq!(r.json()["status"], "cancelled");
    assert_eq!(balance(&db, u2).await, 300);
    // Again, paid this time: the balance part stays spent.
    let r = buy_with(&c2, plan, "month", json!({"use_balance": true})).await;
    let (o, otn) = (order_id(&r), otn_of(&r));
    mock.pay(&otn);
    let j = poll_until_paid(&db, &c2, o).await;
    assert_eq!(j["fulfilled"], true);
    assert_eq!(balance(&db, u2).await, 0);
    // A new order ending the pending one returns its balance part too.
    let u5 = db.user().await;
    adjust(&db, u5, 200).await.ok().unwrap();
    let c5 = user_client(&state, u5).await;
    let p = order_id(&buy_with(&c5, plan, "month", json!({"use_balance": true})).await);
    assert_eq!(balance(&db, u5).await, 0);
    let r = buy_with(&c5, plan, "month", json!({})).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(order_status(&db, p).await.0, "cancelled");
    assert_eq!(balance(&db, u5).await, 200);

    // Expired with a balance part, then paid late: re-taken.
    let u3 = db.user().await;
    adjust(&db, u3, 300).await.ok().unwrap();
    let c3 = user_client(&state, u3).await;
    let r = buy_with(&c3, plan, "month", json!({"use_balance": true})).await;
    let (o3, otn3) = (order_id(&r), otn_of(&r));
    sqlx::query("UPDATE orders SET expires_at = now() - interval '1 minute', last_query_at = NULL WHERE id = $1")
        .bind(o3)
        .execute(&db.pool)
        .await
        .unwrap();
    orders::reconcile_tick(&state).await.ok().unwrap();
    assert_eq!(order_status(&db, o3).await.0, "expired");
    assert_eq!(balance(&db, u3).await, 300);
    let r = post_notify(
        &state,
        rand_ip(),
        form(&notify_params(&otn3, "7.00", "TRADE_SUCCESS")),
    )
    .await;
    assert_eq!(r.body, b"success");
    assert_eq!(order_status(&db, o3).await, ("paid".into(), true, None));
    assert_eq!(balance(&db, u3).await, 0);

    // Same, but the balance was spent meanwhile: paid, not fulfilled, no
    // negative balance; the admin tops up and retries.
    let u4 = db.user().await;
    adjust(&db, u4, 300).await.ok().unwrap();
    let c4 = user_client(&state, u4).await;
    let r = buy_with(&c4, plan, "month", json!({"use_balance": true})).await;
    let (o4, otn4) = (order_id(&r), otn_of(&r));
    let r = c4
        .post(&format!("/test/api/v1/me/orders/{o4}/cancel"), json!({}))
        .await;
    assert_eq!(r.json()["status"], "cancelled");
    adjust(&db, u4, -250).await.ok().unwrap();
    let r = post_notify(
        &state,
        rand_ip(),
        form(&notify_params(&otn4, "7.00", "TRADE_SUCCESS")),
    )
    .await;
    assert_eq!(r.body, b"success");
    assert_eq!(
        order_status(&db, o4).await,
        ("paid".into(), false, Some("insufficient balance".into()))
    );
    assert_eq!(balance(&db, u4).await, 50);
    adjust(&db, u4, 250).await.ok().unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    let r = orders::apply_admin_fulfil(&mut tx, &crate::audit::Actor::test(), o4, "topped up")
        .await
        .ok()
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(r, Paid::Now { fulfilled: true });
    assert_eq!(balance(&db, u4).await, 0);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM balance_ledger WHERE order_id = $1",
            o4
        )
        .await,
        3
    );
    assert_ledger_consistent(&db).await;
    // The order views carry the split.
    let admin = admin_client(&state, &db).await;
    let d = admin.get(&format!("/test/api/v1/orders/{o4}")).await.json();
    assert_eq!(
        (
            d["order"]["balance_cents"].clone(),
            d["order"]["balance_state"].clone()
        ),
        (json!(300), json!("held"))
    );
    drop(state);
    db.drop().await;
}

/// Admin refund of a paid order: the balance part always comes back,
/// the Alipay part only with to_balance; once; a pending commission is
/// reversed; a refunded order is not fulfilled again.
#[tokio::test]
async fn refunds() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = catalog_plan(&db, "ref", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let admin = admin_client(&state, &db).await;
    let u = db.user().await;
    adjust(&db, u, 300).await.ok().unwrap();
    let uc = user_client(&state, u).await;
    let r = buy_with(&uc, plan, "month", json!({"use_balance": true})).await;
    let (o, otn) = (order_id(&r), otn_of(&r));
    let refund = |id: Uuid, body: Value| {
        let admin = &admin;
        async move {
            admin
                .post(&format!("/test/api/v1/orders/{id}/refund"), body)
                .await
        }
    };
    // Only a paid order.
    assert_eq!(
        refund(o, json!({"reason": "x"})).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        refund(Uuid::new_v4(), json!({"reason": "x"})).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        refund(o, json!({"reason": " "})).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        uc.post(
            &format!("/test/api/v1/orders/{o}/refund"),
            json!({"reason": "x"})
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    mock.pay(&otn);
    poll_until_paid(&db, &uc, o).await;
    assert_eq!(balance(&db, u).await, 0);
    let r = refund(o, json!({"reason": "用户申请", "to_balance": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(
        (
            r.json()["refund_cents"].clone(),
            r.json()["balance_part_cents"].clone(),
            r.json()["cash_part_cents"].clone()
        ),
        (json!(1000), json!(300), json!(700))
    );
    assert_eq!(balance(&db, u).await, 1000);
    assert_eq!(
        refund(o, json!({"reason": "again"})).await.status,
        StatusCode::CONFLICT
    );
    let mut tx = db.pool.begin().await.unwrap();
    let e = orders::apply_admin_fulfil(&mut tx, &crate::audit::Actor::test(), o, "x")
        .await
        .err()
        .unwrap();
    assert_eq!(e.status(), StatusCode::CONFLICT);
    drop(tx);
    // Out of band: only the balance part (none here) comes back.
    let r = buy_with(&uc, plan, "month", json!({})).await;
    let (o2, otn2) = (order_id(&r), otn_of(&r));
    mock.pay(&otn2);
    poll_until_paid(&db, &uc, o2).await;
    let r = refund(o2, json!({"reason": "支付宝后台已退"})).await;
    assert_eq!(r.json()["refund_cents"], 0);
    assert_eq!(balance(&db, u).await, 1000);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM balance_ledger WHERE order_id = $1",
            o2
        )
        .await,
        0
    );
    assert_eq!(
        scalar_i64(
            &db,
            "SELECT count(*) FROM audit_log WHERE action = 'order.refund'"
        )
        .await,
        2
    );
    let mine = uc.get(&format!("/test/api/v1/me/orders/{o2}")).await.json();
    assert!(mine["refunded_at"].is_string());
    assert_ledger_consistent(&db).await;
    drop(state);
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Commissions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn commission_lifecycle() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = catalog_plan(&db, "inv", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let admin = admin_client(&state, &db).await;
    // Settings over HTTP (validated, audited).
    for bad in [
        json!({"enabled": true, "rate_percent": 101, "first_order_only": true, "hold_days": 7, "min_withdrawal_cents": 1}),
        json!({"enabled": true, "rate_percent": 10, "first_order_only": true, "hold_days": 366, "min_withdrawal_cents": 1}),
        json!({"enabled": true, "rate_percent": 10, "first_order_only": true, "hold_days": 7, "min_withdrawal_cents": 0}),
        json!({"enabled": true, "rate_percent": 10, "first_order_only": true, "hold_days": 7}),
    ] {
        let r = admin
            .req(
                Method::PUT,
                "/test/api/v1/commission-settings",
                Some(bad.clone()),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let good = json!({"enabled": true, "rate_percent": 10, "first_order_only": true, "hold_days": 7, "min_withdrawal_cents": 50});
    let r = admin
        .req(
            Method::PUT,
            "/test/api/v1/commission-settings",
            Some(good.clone()),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        admin.get("/test/api/v1/commission-settings").await.json(),
        good
    );
    let inviter = db.user().await;
    let ic = user_client(&state, inviter).await;
    assert_eq!(
        ic.get("/test/api/v1/commission-settings").await.status,
        StatusCode::FORBIDDEN
    );
    let invitee = db.user().await;
    invite(&db, inviter, invitee).await;
    let ec = user_client(&state, invitee).await;

    // Paid through Alipay: a pending commission of 10%.
    let r = buy_with(&ec, plan, "month", json!({})).await;
    let (o1, otn1) = (order_id(&r), otn_of(&r));
    mock.pay(&otn1);
    poll_until_paid(&db, &ec, o1).await;
    let (cid, amount, status): (Uuid, i64, String) =
        sqlx::query_as("SELECT id, amount_cents, status FROM commissions WHERE order_id = $1")
            .bind(o1)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!((amount, status.as_str()), (100, "pending"));
    // W15's invite codes appear in the programme view.
    sqlx::query("INSERT INTO invite_codes (code, user_id) VALUES ('wsixcode22', $1)")
        .bind(inviter)
        .execute(&db.pool)
        .await
        .unwrap();
    let inv = ic.get("/test/api/v1/me/invite").await.json();
    assert_eq!(
        (
            inv["invited_count"].clone(),
            inv["pending_cents"].clone(),
            inv["credited_cents"].clone(),
            inv["invite_codes"].clone()
        ),
        (json!(1), json!(100), json!(0), json!(["wsixcode22"]))
    );
    // Not before the hold.
    let mut c = db.pool.acquire().await.unwrap();
    assert_eq!(commission::credit_due(&mut c).await.ok().unwrap(), 0);
    // Time travel past the hold: credited once, through the enforce pass.
    sqlx::query("UPDATE commissions SET available_at = now() - interval '1 second'")
        .execute(&db.pool)
        .await
        .unwrap();
    crate::enforce::run_all(&state).await.unwrap();
    assert_eq!(balance(&db, inviter).await, 100);
    assert_eq!(commission::credit_due(&mut c).await.ok().unwrap(), 0);
    assert_eq!(balance(&db, inviter).await, 100);
    let (st, ledger_id): (String, Option<i64>) =
        sqlx::query_as("SELECT status, ledger_id FROM commissions WHERE id = $1")
            .bind(cid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(st, "credited");
    assert!(ledger_id.is_some());

    // First order only: a renewal earns nothing.
    let r = buy_with(&ec, plan, "month", json!({})).await;
    let (o2, otn2) = (order_id(&r), otn_of(&r));
    mock.pay(&otn2);
    poll_until_paid(&db, &ec, o2).await;
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM commissions WHERE order_id = $1",
            o2
        )
        .await,
        0
    );
    // Every order: earns; refunded within the hold: reversed, never credited.
    set_commission(&db, true, 10, false, 7).await;
    let r = buy_with(&ec, plan, "month", json!({})).await;
    let (o3, otn3) = (order_id(&r), otn_of(&r));
    mock.pay(&otn3);
    poll_until_paid(&db, &ec, o3).await;
    let r = admin
        .post(
            &format!("/test/api/v1/orders/{o3}/refund"),
            json!({"reason": "退款"}),
        )
        .await;
    assert_eq!(r.json()["commission"], "reversed");
    sqlx::query("UPDATE commissions SET available_at = now() - interval '1 second'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(commission::credit_due(&mut c).await.ok().unwrap(), 0);
    assert_eq!(balance(&db, inviter).await, 100);
    // A refund after the credit leaves it (the hold is the window).
    let r = admin
        .post(
            &format!("/test/api/v1/orders/{o1}/refund"),
            json!({"reason": "late"}),
        )
        .await;
    assert_eq!(r.json()["commission"], "credited");
    // Coupon part earns nothing: 50% off 1000 -> commission on 500.
    create_coupon(
        &admin,
        json!({"code": "HALF", "kind": "percent", "value": 50}),
    )
    .await;
    let r = buy_with(&ec, plan, "month", json!({"coupon": "HALF"})).await;
    let (o4, otn4) = (order_id(&r), otn_of(&r));
    mock.pay(&otn4);
    poll_until_paid(&db, &ec, o4).await;
    assert_eq!(
        count(
            &db,
            "SELECT amount_cents FROM commissions WHERE order_id = $1",
            o4
        )
        .await,
        50
    );
    // Paid fully by balance: nothing (amount 0).
    adjust(&db, invitee, 1000).await.ok().unwrap();
    let r = buy_with(&ec, plan, "month", json!({"use_balance": true})).await;
    let o5 = order_id(&r);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM commissions WHERE order_id = $1",
            o5
        )
        .await,
        0
    );
    // Disabled programme: nothing.
    set_commission(&db, false, 10, false, 7).await;
    let r = buy_with(&ec, plan, "month", json!({})).await;
    let (o6, otn6) = (order_id(&r), otn_of(&r));
    mock.pay(&otn6);
    poll_until_paid(&db, &ec, o6).await;
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM commissions WHERE order_id = $1",
            o6
        )
        .await,
        0
    );
    // An admin inviter earns nothing.
    set_commission(&db, true, 10, false, 0).await;
    let adm = db.admin().await;
    let e2 = db.user().await;
    invite(&db, adm, e2).await;
    let c2 = user_client(&state, e2).await;
    let r = buy_with(&c2, plan, "month", json!({})).await;
    let (o7, otn7) = (order_id(&r), otn_of(&r));
    mock.pay(&otn7);
    poll_until_paid(&db, &c2, o7).await;
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM commissions WHERE order_id = $1",
            o7
        )
        .await,
        0
    );
    // The inviter is deleted before the credit: reversed by the pass.
    let gone = db.user().await;
    let e3 = db.user().await;
    invite(&db, gone, e3).await;
    let c3 = user_client(&state, e3).await;
    sqlx::query("UPDATE commission_settings SET hold_days = 3")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = buy_with(&c3, plan, "month", json!({})).await;
    let (o8, otn8) = (order_id(&r), otn_of(&r));
    mock.pay(&otn8);
    poll_until_paid(&db, &c3, o8).await;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(gone)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE commissions SET available_at = now() - interval '1 second' WHERE order_id = $1",
    )
    .bind(o8)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(commission::credit_due(&mut c).await.ok().unwrap(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM commissions WHERE order_id = $1")
            .bind(o8)
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "reversed"
    );
    drop(c);
    // Admin lists.
    let r = admin.get("/test/api/v1/commissions?status=reversed").await;
    assert_eq!(r.json().as_array().unwrap().len(), 2);
    assert_eq!(
        admin
            .get("/test/api/v1/commissions?status=nope")
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        ec.get("/test/api/v1/commissions").await.status,
        StatusCode::FORBIDDEN
    );
    for action in [
        "commission.create",
        "commission.reverse",
        "balance.commission",
        "commission.settings.update",
    ] {
        assert!(
            scalar_i64(
                &db,
                &format!("SELECT count(*) FROM audit_log WHERE action = '{action}'")
            )
            .await
                >= 1,
            "{action}"
        );
    }
    assert_ledger_consistent(&db).await;
    drop(state);
    db.drop().await;
}

#[tokio::test]
async fn inviter_guard() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let a = db.user().await;
    let b = db.user().await;
    let c = db.user().await;
    invite(&db, a, b).await;
    invite(&db, b, c).await;
    for (inviter, invitee) in [(a, a), (c, a), (b, b)] {
        let e = sqlx::query("UPDATE users SET inviter_id = $1 WHERE id = $2")
            .bind(inviter)
            .bind(invitee)
            .execute(&db.pool)
            .await
            .err()
            .unwrap();
        let api: crate::auth::ApiError = e.into();
        assert_eq!(api.status(), StatusCode::CONFLICT, "{inviter} -> {invitee}");
    }
    // A fresh insert with a valid inviter works; with itself it does not.
    let d = Uuid::new_v4();
    assert!(
        sqlx::query("INSERT INTO users (id, login, inviter_id) VALUES ($1, 'd', $1)")
            .bind(d)
            .execute(&db.pool)
            .await
            .is_err()
    );
    sqlx::query("INSERT INTO users (id, login, inviter_id) VALUES ($1, 'd', $2)")
        .bind(d)
        .bind(c)
        .execute(&db.pool)
        .await
        .unwrap();
    // Clearing is always allowed.
    sqlx::query("UPDATE users SET inviter_id = NULL WHERE id = $1")
        .bind(b)
        .execute(&db.pool)
        .await
        .unwrap();
    db.drop().await;
}

/// Replayed and concurrent payment reports (notify + query) of an invited
/// user's order create one commission; concurrent credit passes (several
/// instances) credit it once.
#[tokio::test]
async fn commission_exactly_once_under_duplicates() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    set_commission(&db, true, 15, true, 0).await;
    let (_, plan) = priced_plan(&db, "p", 1200, 30).await;
    let inviter = db.user().await;
    let user = db.user().await;
    invite(&db, inviter, user).await;
    let (oid, otn) = order_row(&db, user, plan, 1200, 30).await;
    mock.inner.lock().unwrap().trades.insert(
        otn.clone(),
        Trade {
            total: "12.00".into(),
            status: Some("TRADE_SUCCESS".into()),
        },
    );
    let (method, alipay) = method_of(&state);
    let body = form(&notify_params(&otn, "12.00", "TRADE_SUCCESS"));
    let pending = Pending {
        id: oid,
        out_trade_no: otn.clone(),
        amount_cents: 1200,
        expires_at: chrono::Utc::now(),
        due: false,
        payment_method_id: Some(method),
    };
    let mut tasks = Vec::new();
    for i in 0..12 {
        let state = state.clone();
        let alipay = alipay.clone();
        let body = body.clone();
        let pending = pending.clone();
        tasks.push(tokio::spawn(async move {
            if i % 3 == 0 {
                let q = alipay.query(&pending.out_trade_no).await.unwrap();
                orders::apply_query_result(&state, &pending, &q, "query")
                    .await
                    .unwrap()
            } else {
                super::super::api::handle_notify(&state, &*alipay, method, None, &body)
                    .await
                    .unwrap()
            }
        }));
    }
    for t in tasks {
        assert!(t.await.unwrap());
    }
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM commissions WHERE order_id = $1",
            oid
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT amount_cents FROM commissions WHERE order_id = $1",
            oid
        )
        .await,
        180
    );
    assert_eq!(
        count(&db, "SELECT count(*) FROM audit_log WHERE action = 'commission.create' AND after->>'order_id' = $1::text", oid).await,
        1
    );
    // Several instances run the credit pass at once.
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let pool = db.pool.clone();
        tasks.push(tokio::spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            let n = commission::credit_due(&mut tx).await.ok().unwrap();
            tx.commit().await.unwrap();
            n
        }));
    }
    let mut total = 0;
    for t in tasks {
        total += t.await.unwrap();
    }
    assert_eq!(total, 1);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM balance_ledger WHERE user_id = $1",
            inviter
        )
        .await,
        1
    );
    assert_eq!(balance(&db, inviter).await, 180);
    assert_ledger_consistent(&db).await;
    drop(state);
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

#[tokio::test]
async fn withdrawals() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    set_commission(&db, true, 10, true, 0).await;
    let (_, plan) = catalog_plan(&db, "w", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let admin = admin_client(&state, &db).await;
    let inviter = db.user().await;
    let ic = user_client(&state, inviter).await;
    // Two invitees pay 1000 each -> 200 credited.
    for _ in 0..2 {
        let e = db.user().await;
        invite(&db, inviter, e).await;
        let ec = user_client(&state, e).await;
        let r = buy_with(&ec, plan, "month", json!({})).await;
        let (o, otn) = (order_id(&r), otn_of(&r));
        mock.pay(&otn);
        poll_until_paid(&db, &ec, o).await;
    }
    crate::enforce::run_all(&state).await.unwrap();
    assert_eq!(balance(&db, inviter).await, 200);
    // Admin credits are spendable, not withdrawable.
    adjust(&db, inviter, 1000).await.ok().unwrap();
    let me = ic.get("/test/api/v1/me/balance").await.json();
    assert_eq!(
        (
            me["balance_cents"].clone(),
            me["withdrawable_cents"].clone()
        ),
        (json!(1200), json!(200))
    );
    let req = |body: Value| {
        let ic = &ic;
        async move { ic.post("/test/api/v1/me/withdrawals", body).await }
    };
    for (body, want) in [
        (
            json!({"amount_cents": 300, "method": "alipay", "account": "a@b"}),
            StatusCode::CONFLICT,
        ),
        (
            json!({"amount_cents": 10, "method": "alipay", "account": "a@b"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"amount_cents": 100, "method": "paypal", "account": "a@b"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"amount_cents": 100, "method": "alipay", "account": " "}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"amount_cents": 0, "method": "alipay", "account": "a"}),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        assert_eq!(req(body.clone()).await.status, want, "{body}");
    }
    let r = req(json!({"amount_cents": 150, "method": "alipay", "account": "张三 a@b"})).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let w1: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(balance(&db, inviter).await, 1050);
    assert_eq!(
        req(json!({"amount_cents": 50, "method": "bank", "account": "x"}))
            .await
            .status,
        StatusCode::CONFLICT
    );
    // Someone else cannot cancel it; the owner can (funds back).
    let other = user_client(&state, db.user().await).await;
    assert_eq!(
        other
            .post(
                &format!("/test/api/v1/me/withdrawals/{w1}/cancel"),
                json!({})
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        ic.post(
            &format!("/test/api/v1/me/withdrawals/{w1}/cancel"),
            json!({})
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(balance(&db, inviter).await, 1200);
    assert_eq!(
        ic.post(
            &format!("/test/api/v1/me/withdrawals/{w1}/cancel"),
            json!({})
        )
        .await
        .status,
        StatusCode::CONFLICT
    );
    // Rejected by the admin: funds back.
    let w2: Uuid = req(json!({"amount_cents": 100, "method": "wechat", "account": "wx"}))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        admin
            .post(
                &format!("/test/api/v1/withdrawals/{w2}/reject"),
                json!({"reason": " "})
            )
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        admin
            .post(
                &format!("/test/api/v1/withdrawals/{w2}/reject"),
                json!({"reason": "账号有误"})
            )
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(balance(&db, inviter).await, 1200);
    // Approved with the payout reference: money gone.
    let w3: Uuid = req(json!({"amount_cents": 200, "method": "alipay", "account": "a@b"}))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let approve = |id: Uuid, body: Value| {
        let admin = &admin;
        async move {
            admin
                .post(&format!("/test/api/v1/withdrawals/{id}/approve"), body)
                .await
                .status
        }
    };
    assert_eq!(
        approve(w3, json!({"payout_reference": ""})).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        approve(w3, json!({"payout_reference": "x".repeat(201)})).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        ic.post(
            &format!("/test/api/v1/withdrawals/{w3}/approve"),
            json!({"payout_reference": "x"})
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        approve(
            w3,
            json!({"payout_reference": "2026100222001", "note": "已转账"})
        )
        .await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        approve(w3, json!({"payout_reference": "again"})).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        approve(Uuid::new_v4(), json!({"payout_reference": "x"})).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(balance(&db, inviter).await, 1000);
    let me = ic.get("/test/api/v1/me/balance").await.json();
    assert_eq!(me["withdrawable_cents"], 0);
    // Views.
    let mine = ic.get("/test/api/v1/me/withdrawals").await.json();
    assert_eq!(mine.as_array().unwrap().len(), 3);
    let all = admin
        .get("/test/api/v1/withdrawals?status=approved")
        .await
        .json();
    assert_eq!(all[0]["payout_reference"], "2026100222001");
    assert_eq!(
        admin.get("/test/api/v1/withdrawals?status=x").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        ic.get("/test/api/v1/withdrawals").await.status,
        StatusCode::FORBIDDEN
    );
    // An admin account has nothing to withdraw.
    assert_eq!(
        admin
            .post(
                "/test/api/v1/me/withdrawals",
                json!({"amount_cents": 100, "method": "alipay", "account": "a"})
            )
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    // Nothing withdrawable left.
    assert_eq!(
        req(json!({"amount_cents": 50, "method": "other", "account": "x"}))
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_ledger_consistent(&db).await;
    for action in [
        "withdrawal.cancelled",
        "withdrawal.rejected",
        "withdrawal.approved",
        "balance.withdrawal",
        "balance.withdrawal_reversal",
    ] {
        assert!(
            scalar_i64(
                &db,
                &format!("SELECT count(*) FROM audit_log WHERE action = '{action}'")
            )
            .await
                >= 1,
            "{action}"
        );
    }
    drop(state);
    db.drop().await;
}

/// The money rule, table-driven: every operation that moves money writes
/// exactly one ledger row and exactly one `balance.*` audit row, in the
/// same transaction as its cause, and balance = sum(ledger) afterwards.
#[tokio::test]
async fn every_money_movement_writes_one_ledger_row_and_audit() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    set_commission(&db, true, 10, false, 0).await;
    let (_, plan) = catalog_plan(&db, "t", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let inviter = db.user().await;
    let u = db.user().await;
    invite(&db, inviter, u).await;
    let uc = user_client(&state, u).await;
    let ic = user_client(&state, inviter).await;
    let admin = admin_client(&state, &db).await;
    let counts = || async {
        (
            scalar_i64(&db, "SELECT count(*) FROM balance_ledger").await,
            scalar_i64(
                &db,
                "SELECT count(*) FROM audit_log WHERE action LIKE 'balance.%'",
            )
            .await,
        )
    };
    let mut steps: Vec<(&str, i64)> = Vec::new();
    macro_rules! step {
        ($name:expr, $ledger:expr, $body:expr) => {{
            let before = counts().await;
            $body;
            let after = counts().await;
            assert_eq!(after.0 - before.0, $ledger, "{}: ledger rows", $name);
            assert_eq!(after.1 - before.1, $ledger, "{}: balance audit rows", $name);
            assert_ledger_consistent(&db).await;
            steps.push(($name, $ledger));
        }};
    }
    step!("admin adjust", 1, adjust(&db, u, 1500).await.ok().unwrap());
    step!("order fully paid by balance", 1, {
        let r = buy_with(&uc, plan, "month", json!({"use_balance": true})).await;
        assert_eq!(r.json()["status"], "paid");
    });
    let pending = std::cell::Cell::new(Uuid::nil());
    step!("partial order (balance held)", 1, {
        let r = buy_with(&uc, plan, "month", json!({"use_balance": true})).await;
        assert_eq!(r.json()["status"], "pending");
        pending.set(order_id(&r));
    });
    step!("cancel partial order (refund to balance)", 1, {
        let r = uc
            .post(
                &format!("/test/api/v1/me/orders/{}/cancel", pending.get()),
                json!({}),
            )
            .await;
        assert_eq!(r.json()["status"], "cancelled");
    });
    let paid = std::cell::Cell::new(Uuid::nil());
    step!("Alipay order paid (no balance part)", 0, {
        let r = buy_with(&uc, plan, "month", json!({})).await;
        let (o, otn) = (order_id(&r), otn_of(&r));
        mock.pay(&otn);
        poll_until_paid(&db, &uc, o).await;
        paid.set(o);
    });
    step!("commission credited", 1, {
        let mut c = db.pool.acquire().await.unwrap();
        assert!(commission::credit_due(&mut c).await.ok().unwrap() >= 1);
    });
    step!("refund to balance", 1, {
        let r = admin
            .post(
                &format!("/test/api/v1/orders/{}/refund", paid.get()),
                json!({"reason": "r", "to_balance": true}),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
    });
    let w = std::cell::Cell::new(Uuid::nil());
    step!("withdrawal request", 1, {
        let r = ic
            .post(
                "/test/api/v1/me/withdrawals",
                json!({"amount_cents": 50, "method": "alipay", "account": "a"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
        w.set(r.json()["id"].as_str().unwrap().parse().unwrap());
    });
    step!("withdrawal rejected", 1, {
        let r = admin
            .post(
                &format!("/test/api/v1/withdrawals/{}/reject", w.get()),
                json!({"reason": "r"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
    });
    step!("withdrawal approved (funds already held)", 1, {
        let r = ic
            .post(
                "/test/api/v1/me/withdrawals",
                json!({"amount_cents": 50, "method": "alipay", "account": "a"}),
            )
            .await;
        let id: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
        let r = admin
            .post(
                &format!("/test/api/v1/withdrawals/{id}/approve"),
                json!({"payout_reference": "x"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
    });
    assert_eq!(steps.len(), 10);
    drop(state);
    db.drop().await;
}
