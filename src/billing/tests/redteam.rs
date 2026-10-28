//! Red team 2026-10 (area B, money): regression tests of the findings.

use axum::http::StatusCode;
use serde_json::json;

use super::super::catalog::PeriodKind;
use super::super::provider::ProviderKind;
use super::*;

async fn admin_client(state: &AppState, db: &TestDb) -> Client {
    let a = db.admin().await;
    user_client(state, a).await
}

/// Buy (plan, period) over HTTP and pay it; returns the order.
async fn bought(db: &TestDb, c: &Client, plan: Uuid, period: &str) -> Uuid {
    let r = buy(c, plan, period).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let o = order_id(&r);
    pay(db, o).await;
    assert!(order_status(db, o).await.1, "order {o} not fulfilled");
    o
}

/// A notify body above the framework's body limit is a refusal like any
/// other: the canonical rejection (404, empty), not a 413 that names the
/// route.
#[tokio::test]
async fn oversized_notify_is_the_canonical_rejection() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let baseline = post_notify(&state, rand_ip(), b"x=1".to_vec()).await;
    assert_eq!(baseline.status, StatusCode::NOT_FOUND);
    for size in [20_000usize, 3 << 20] {
        let r = post_notify(&state, rand_ip(), vec![b'a'; size]).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{size} bytes");
        assert!(r.body.is_empty(), "{size} bytes");
        let names = |h: &axum::http::HeaderMap| {
            let mut v: Vec<String> = h.keys().map(|k| k.as_str().to_string()).collect();
            v.retain(|k| k != "date");
            v.sort();
            v
        };
        assert_eq!(names(&r.headers), names(&baseline.headers), "{size} bytes");
    }
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_events WHERE outcome = 'oversized' AND NOT verified",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(n, 2, "both oversized notifies leave an event");
    drop(state);
    db.drop().await;
}

/// The HMAC secrets that gate a webhook (Coinbase's subscription secret,
/// CoinPayments' client secret) must not be guessable: a short one is
/// refused. (The setup guide used to say "fill in anything for now".)
#[test]
fn webhook_secrets_must_be_long_enough() {
    use super::super::coinbase::{CoinbaseKind, tests as cbt};
    use super::super::coinpayments::{CoinPaymentsKind, tests as cpt};
    let (api, _) = cbt::ed25519_secret();
    for weak in ["x", "test", "123456", "0123456789abcde"] {
        let r = CoinbaseKind.validate(
            &json!({"key_id": cbt::KEY_ID, "api_secret": api, "webhook_secret": weak,
                    "currency": "CNY"}),
            None,
            true,
        );
        assert_eq!(
            r.err().map(|e| e.code().to_string()).as_deref(),
            Some("payments.coinbase_webhook_secret_invalid"),
            "{weak}"
        );
        let r = CoinPaymentsKind.validate(
            &json!({"client_id": cpt::CLIENT, "client_secret": weak, "currency_id": cpt::CURRENCY_ID,
                    "currency": "CNY"}),
            None,
            true,
        );
        assert_eq!(
            r.err().map(|e| e.code().to_string()).as_deref(),
            Some("payments.coinpayments_secret_invalid"),
            "{weak}"
        );
    }
    assert!(
        CoinbaseKind
            .validate(
                &json!({"key_id": cbt::KEY_ID, "api_secret": api,
                        "webhook_secret": "0123456789abcdef", "currency": "CNY"}),
                None,
                true,
            )
            .is_ok()
    );
    assert!(
        CoinPaymentsKind
            .validate(
                &json!({"client_id": cpt::CLIENT, "client_secret": "0123456789abcdef",
                        "currency_id": cpt::CURRENCY_ID, "currency": "CNY"}),
                None,
                true,
            )
            .is_ok()
    );
}

/// Refunding the order that created a subscription, after a switch replaced
/// it, is money only; refunding the switch afterwards must not bring that
/// refunded subscription back (the customer would keep the plan they got
/// their money back for).
#[tokio::test]
async fn refunding_the_switch_does_not_resurrect_a_refunded_plan() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin_client(&state, &db).await;
    let (_, a) = catalog_plan(&db, "rt-a", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let (_, b) = catalog_plan(&db, "rt-b", &[(PeriodKind::Month, None, 3000)], |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    let first = bought(&db, &c, a, "month").await;
    let switch = bought(&db, &c, b, "month").await;
    let r = admin
        .post(
            &format!("/test/api/v1/orders/{first}/refund"),
            json!({"reason": "r", "to_balance": true}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["effect"]["kind"], "none", "{:?}", r.json());
    let r = admin
        .post(
            &format!("/test/api/v1/orders/{switch}/refund"),
            json!({"reason": "r", "to_balance": true}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["effect"]["kind"], "cancel", "{:?}", r.json());
    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(u)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        active, 0,
        "both orders are refunded: no subscription is left"
    );
    drop(state);
    db.drop().await;
}

async fn active_expiry(db: &TestDb, user: Uuid) -> (Uuid, Option<chrono::DateTime<chrono::Utc>>) {
    active_plan(db, user).await.expect("an active plan")
}

async fn refund_all(admin: &Client, order: Uuid) -> serde_json::Value {
    let r = admin
        .post(
            &format!("/test/api/v1/orders/{order}/refund"),
            json!({"reason": "r", "to_balance": true}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    r.json()
}

/// The renewal variant: the renewal of plan A was refunded (money only: the
/// switch had replaced A), then the switch is refunded. A comes back with
/// the term it had before the refunded renewal added its time.
#[tokio::test]
async fn restored_plan_loses_the_term_of_a_refunded_renewal() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin_client(&state, &db).await;
    let (_, a) = catalog_plan(&db, "rt-ra", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let (_, b) = catalog_plan(&db, "rt-rb", &[(PeriodKind::Month, None, 3000)], |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    bought(&db, &c, a, "month").await;
    let (sub_a, exp_first) = active_expiry(&db, u).await;
    let renewal = bought(&db, &c, a, "month").await;
    assert!(active_expiry(&db, u).await.1 > exp_first);
    let switch = bought(&db, &c, b, "month").await;
    assert_eq!(refund_all(&admin, renewal).await["effect"]["kind"], "none");
    assert_eq!(
        refund_all(&admin, switch).await["effect"]["kind"],
        "restore"
    );
    assert_eq!(active_expiry(&db, u).await, (sub_a, exp_first));
    drop(state);
    db.drop().await;
}

/// Refunding the order whose value a later switch used as credit says so:
/// the preview lists the later order and the credit it took.
#[tokio::test]
async fn refund_preview_warns_when_a_later_switch_used_the_credit() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let admin = admin_client(&state, &db).await;
    let (_, a) = catalog_plan(&db, "rt-pa", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let (_, b) = catalog_plan(&db, "rt-pb", &[(PeriodKind::Month, None, 3000)], |_| {}).await;
    let u = db.user().await;
    let c = user_client(&state, u).await;
    let first = bought(&db, &c, a, "month").await;
    let p = admin
        .get(&format!("/test/api/v1/orders/{first}/refund-preview"))
        .await
        .json();
    assert_eq!(p["credit_used_by"], json!([]), "{p}");
    let switch = bought(&db, &c, b, "month").await;
    let otn: String = sqlx::query_scalar("SELECT out_trade_no FROM orders WHERE id = $1")
        .bind(switch)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let p = admin
        .get(&format!("/test/api/v1/orders/{first}/refund-preview"))
        .await
        .json();
    assert_eq!(p["credit_used_by"][0]["out_trade_no"], otn, "{p}");
    assert!(p["credit_used_by"][0]["credit_cents"].as_i64().unwrap() > 0);
    drop(state);
    db.drop().await;
}

/// A switch order that ended unpaid and is paid late: while the credit it
/// carries still holds it is fulfilled; when the subscription it came from
/// lost its value meanwhile, the payment goes to the balance and the plan
/// stays as it is.
#[tokio::test]
async fn late_payment_on_a_stale_switch_credit_goes_to_the_balance() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, a) = catalog_plan(&db, "rt-la", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let (_, b) = catalog_plan(&db, "rt-lb", &[(PeriodKind::Month, None, 3000)], |_| {}).await;
    let mut late = Vec::new();
    for _ in 0..2 {
        let u = db.user().await;
        let c = user_client(&state, u).await;
        bought(&db, &c, a, "month").await;
        let r = buy(&c, b, "month").await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
        let o = order_id(&r);
        let r = c
            .post(&format!("/test/api/v1/me/orders/{o}/cancel"), json!({}))
            .await;
        assert_eq!(r.json()["status"], "cancelled");
        late.push((u, o));
    }
    // User 1 pays at once: the credit still holds.
    let (u1, o1) = late[0];
    pay(&db, o1).await;
    assert_eq!(order_status(&db, o1).await, ("paid".into(), true, None));
    assert_eq!(active_plan(&db, u1).await.unwrap().0, b);
    // User 2's subscription is nearly used up before the payment arrives.
    let (u2, o2) = late[1];
    sqlx::query(
        "UPDATE user_plans SET expires_at = now() + interval '1 day' \
         WHERE user_id = $1 AND status = 'active'",
    )
    .bind(u2)
    .execute(&db.pool)
    .await
    .unwrap();
    pay(&db, o2).await;
    let (status, fulfilled, err) = order_status(&db, o2).await;
    assert_eq!((status.as_str(), fulfilled), ("paid", false));
    assert!(err.is_some());
    assert_eq!(active_plan(&db, u2).await.unwrap().0, a);
    let (refunded, balance): (bool, i64) = sqlx::query_as(
        "SELECT refunded_at IS NOT NULL, \
                (SELECT balance_cents FROM user_balances WHERE user_id = $2) \
         FROM orders WHERE id = $1",
    )
    .bind(o2)
    .bind(u2)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(refunded);
    assert!(balance > 0);
    drop(state);
    db.drop().await;
}

/// An admin-recorded payment (a manual order, "mark paid") brought no money
/// through a gateway: it creates no invite commission, a gateway payment of
/// the same invitee does.
#[tokio::test]
async fn manual_payments_earn_no_invite_commission() {
    use super::super::commission;
    use super::super::manual::{self, ManualOrderReq};
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = catalog_plan(&db, "rt-m", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let mut tx = db.pool.begin().await.unwrap();
    commission::apply_update_settings(
        &mut tx,
        &crate::audit::Actor::test(),
        &commission::Settings {
            enabled: true,
            rate_percent: 10,
            first_order_only: false,
            hold_days: 0,
            min_withdrawal_cents: 50,
            usdt_chains: super::super::usdt::default_chains(),
            usdt_rate_cents: None,
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    let inviter = db.user().await;
    let invitee = db.user().await;
    sqlx::query("UPDATE users SET inviter_id = $1 WHERE id = $2")
        .bind(inviter)
        .bind(invitee)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    manual::apply_create(
        &mut tx,
        &crate::audit::Actor::test(),
        &ManualOrderReq {
            user_id: invitee,
            plan_id: plan,
            period: super::super::catalog::PeriodKindText(PeriodKind::Month),
            gift: false,
            reason: "转账".into(),
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    let n = |db: &TestDb| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM commissions")
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    assert_eq!(n(&db).await, 0, "a manual order earns no commission");
    let c = user_client(&state, invitee).await;
    bought(&db, &c, plan, "month").await;
    assert_eq!(n(&db).await, 1, "a gateway payment does");
    drop(state);
    db.drop().await;
}
