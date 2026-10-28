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
