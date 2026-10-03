//! Billing tests: a mock Alipay gateway (local axum server that verifies
//! the panel's request signatures and signs its answers with a throwaway
//! "Alipay" key), real-DB fulfilment/idempotency/expiry tests and the HTTP
//! surface including the notify endpoint's canonical rejections.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

use super::alipay;
use super::alipay::tests::{alipay_side_keys, panel_keys, sign_notify, signed_response};
use super::orders::{self, Paid, Pending, Via};
use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, rand_ip};

const APP_ID: &str = "2021000000000001";
const SELLER_ID: &str = "2088000000000001";
/// The main domain of the paid test panels (notify URLs derive from it).
const ORIGIN: &str = "https://panel.example";
/// Any notify URL (direct gateway calls in tests).
const NOTIFY: &str = "https://panel.example/test/pay/x/notify";

// ---------------------------------------------------------------------------
// Mock gateway
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Trade {
    total: String,
    /// None = not scanned (TRADE_NOT_EXIST).
    status: Option<String>,
}

#[derive(Default)]
struct MockInner {
    trades: HashMap<String, Trade>,
    calls: Vec<String>,
    /// notify_url of every precreate.
    notify_urls: Vec<String>,
    /// Answer every call with HTTP 503.
    down: bool,
    /// Report this total instead of the order's (tampering).
    total_override: Option<String>,
}

#[derive(Clone)]
struct Mock {
    inner: Arc<Mutex<MockInner>>,
    url: String,
}

impl Mock {
    async fn start() -> Self {
        let inner = Arc::new(Mutex::new(MockInner::default()));
        let app = axum::Router::new()
            .route("/gateway.do", axum::routing::post(mock_gateway))
            .with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            inner,
            url: format!("http://{addr}/gateway.do"),
        }
    }
    fn pay(&self, otn: &str) {
        let mut g = self.inner.lock().unwrap();
        let t = g.trades.get_mut(otn).unwrap();
        t.status = Some("TRADE_SUCCESS".into());
    }
    fn status(&self, otn: &str) -> Option<String> {
        self.inner.lock().unwrap().trades[otn].status.clone()
    }
    fn calls(&self, method: &str) -> usize {
        self.inner
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|m| m.as_str() == method)
            .count()
    }
    fn notify_urls(&self) -> Vec<String> {
        self.inner.lock().unwrap().notify_urls.clone()
    }
    fn set_down(&self, down: bool) {
        self.inner.lock().unwrap().down = down;
    }
}

async fn mock_gateway(
    axum::extract::State(inner): axum::extract::State<Arc<Mutex<MockInner>>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let p: BTreeMap<String, String> = form_urlencoded::parse(&body).into_owned().collect();
    // The panel's request must be correctly signed with its app key.
    assert!(
        alipay_side_keys().verify(alipay::request_sign_content(&p).as_bytes(), &p["sign"]),
        "panel request signature"
    );
    assert_eq!(p["app_id"], APP_ID);
    let method = p["method"].clone();
    let biz: Value = serde_json::from_str(&p["biz_content"]).unwrap();
    let otn = biz["out_trade_no"].as_str().unwrap().to_string();
    let mut g = inner.lock().unwrap();
    g.calls.push(method.clone());
    if g.down {
        return (StatusCode::SERVICE_UNAVAILABLE, "down").into_response();
    }
    let not_exist = json!({"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_NOT_EXIST","sub_msg":"交易不存在","out_trade_no": otn});
    let obj = match method.as_str() {
        "alipay.trade.precreate" => {
            g.notify_urls.push(p["notify_url"].clone());
            g.trades.insert(
                otn.clone(),
                Trade {
                    total: biz["total_amount"].as_str().unwrap().to_string(),
                    status: None,
                },
            );
            json!({"code":"10000","msg":"Success","out_trade_no": otn,
                   "qr_code": format!("https://qr.alipay.com/mock{}", &otn[otn.len()-6..])})
        }
        "alipay.trade.query" => match g.trades.get(&otn).cloned() {
            Some(Trade {
                total,
                status: Some(s),
            }) => {
                let total = g.total_override.clone().unwrap_or(total);
                json!({"code":"10000","msg":"Success","out_trade_no": otn,
                       "trade_no": format!("2026{otn}"), "trade_status": s,
                       "total_amount": total, "buyer_logon_id": "abc***@sandbox.com"})
            }
            _ => not_exist,
        },
        "alipay.trade.close" => match g.trades.get_mut(&otn) {
            Some(Trade {
                status: Some(s), ..
            }) if s == "WAIT_BUYER_PAY" => {
                *s = "TRADE_CLOSED".into();
                json!({"code":"10000","msg":"Success","out_trade_no": otn})
            }
            Some(Trade {
                status: Some(_), ..
            }) => {
                json!({"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_STATUS_ERROR","sub_msg":"x"})
            }
            _ => not_exist,
        },
        _ => json!({"code":"40004","sub_code":"isv.invalid-method"}),
    };
    signed_response(&method, &obj).into_response()
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// The method form of an Alipay method on the mock gateway.
fn alipay_method_req(gateway: &str, name: &str) -> super::methods::MethodReq {
    super::methods::MethodReq {
        kind: Some(super::alipay::KIND.into()),
        version: None,
        display_name: name.into(),
        icon: None,
        sort: 0,
        enabled: true,
        config: json!({
            "environment": "custom",
            "gateway_url": gateway,
            "app_id": APP_ID,
            "seller_id": SELLER_ID,
            "app_private_key": super::alipay::tests::APP_KEY,
            "alipay_public_key": super::alipay::tests::ALIPAY_PUB,
            "order_timeout_minutes": 15,
        }),
    }
}

/// Add an enabled Alipay method on `gateway` (DB + this instance reload).
async fn add_method(state: &AppState, gateway: &str, name: &str) -> Uuid {
    let mut tx = state.pg().begin().await.unwrap();
    let row = super::methods::apply_create(
        &mut tx,
        state.totp(),
        &crate::audit::Actor::test(),
        "payment_method.create",
        &alipay_method_req(gateway, name),
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    crate::settings::reload(state).await.unwrap();
    row.id
}

/// The first usable method of a panel and its client.
fn method_of(state: &AppState) -> (Uuid, std::sync::Arc<dyn super::provider::PaymentProvider>) {
    let live = state.payments();
    let m = live.usable().next().expect("a usable payment method");
    (m.id, m.provider.clone().unwrap())
}

/// Create a trade at the gateway through a provider (tests).
async fn precreate(p: &dyn super::provider::PaymentProvider, otn: &str, cents: i64) {
    p.create(super::provider::CreateReq {
        out_trade_no: otn,
        amount_cents: cents,
        subject: "s",
        notify_url: NOTIFY,
    })
    .await
    .unwrap();
}

/// A panel with payments on (one Alipay method on the mock gateway) and
/// the main domain ORIGIN (系统设置: notify URLs derive from it).
async fn paid_state(db: &TestDb, mock: &Mock) -> AppState {
    let state = AppState::for_test(db.pool.clone()).await;
    main_domain(db, &state).await;
    add_method(&state, &mock.url, "支付宝").await;
    state
}

/// 系统设置 main domain = ORIGIN's host, reloaded into `state`.
pub(crate) async fn main_domain(db: &TestDb, state: &AppState) {
    let host = ORIGIN.trim_start_matches("https://");
    db.settings(state, &format!("main_domain = '{host}'")).await;
}

async fn token(state: &AppState, id: Uuid) -> String {
    let (role, sv): (String, i64) =
        sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
            .bind(id)
            .fetch_one(state.pg())
            .await
            .unwrap();
    crate::auth::issue_token(state, id, &role, sv, crate::auth::Stage::Full).unwrap()
}

/// A group with one node, a plan granting it, priced; returns (node, plan).
async fn priced_plan(db: &TestDb, name: &str, cents: i64, days: i32) -> (Uuid, Uuid) {
    let node = db.node().await;
    let actor = crate::audit::Actor::test();
    let mut tx = db.pool.begin().await.unwrap();
    let g = crate::plans::apply_create_group(
        &mut tx,
        &actor,
        &crate::plans::CreateGroupReq {
            name: format!("g-{name}"),
            description: None,
            node_ids: Some(vec![node]),
        },
    )
    .await
    .ok()
    .unwrap();
    let p = crate::plans::apply_create_plan(
        &mut tx,
        &actor,
        &crate::plans::CreatePlanReq {
            name: name.into(),
            traffic_quota_bytes: Some(1 << 30),
            period: "monthly".into(),
            speed_limit_mbps: None,
            device_seats: None,
            sort: None,
            enabled: None,
            group_ids: Some(vec![g]),
            ..Default::default()
        },
    )
    .await
    .ok()
    .unwrap();
    super::catalog::apply_set_prices(
        &mut tx,
        &actor,
        p,
        &super::catalog::SetPricesReq {
            on_sale: true,
            prices: vec![super::catalog::Price {
                period: super::catalog::PeriodKindText(super::catalog::PeriodKind::Days),
                days: Some(days),
                price_cents: cents,
            }],
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    (node, p)
}

/// A pending order row (as create_order writes it), returns (id, otn).
async fn order_row(db: &TestDb, user: Uuid, plan: Uuid, cents: i64, days: i32) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let otn = format!("AKT{}", hex::encode(rand::random::<[u8; 12]>()));
    sqlx::query(
        "INSERT INTO orders (id, out_trade_no, user_id, user_login, plan_id, plan_name, \
         amount_cents, list_price_cents, period, period_days, subject, expires_at, \
         payment_method_id) \
         VALUES ($1, $2, $3, 'u', $4, 'p', $5, $5, 'days', $6, 's', \
                 now() + interval '15 minutes', \
                 (SELECT id FROM payment_methods ORDER BY created_at, id LIMIT 1))",
    )
    .bind(id)
    .bind(&otn)
    .bind(user)
    .bind(plan)
    .bind(cents)
    .bind(days)
    .execute(&db.pool)
    .await
    .unwrap();
    (id, otn)
}

fn notify_params(otn: &str, total: &str, status: &str) -> BTreeMap<String, String> {
    let mut p: BTreeMap<String, String> = [
        ("app_id", APP_ID),
        ("seller_id", SELLER_ID),
        ("out_trade_no", otn),
        ("total_amount", total),
        ("receipt_amount", total),
        ("trade_status", status),
        ("trade_no", "2026100222001400000000000001"),
        ("notify_type", "trade_status_sync"),
        ("notify_id", "2026100200222000000000000000000000"),
        ("notify_time", "2026-10-02 12:00:00"),
        ("charset", "utf-8"),
        ("version", "1.0"),
        ("subject", "Akari - 月付 & co"),
        ("buyer_logon_id", "abc***@sandbox.com"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    sign_notify(&mut p);
    p
}

fn form(p: &BTreeMap<String, String>) -> Vec<u8> {
    let mut s = form_urlencoded::Serializer::new(String::new());
    for (k, v) in p {
        s.append_pair(k, v);
    }
    s.finish().into_bytes()
}

async fn count(db: &TestDb, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn order_status(db: &TestDb, id: Uuid) -> (String, bool, Option<String>) {
    sqlx::query_as(
        "SELECT status, fulfilled_at IS NOT NULL, fulfil_error FROM orders WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

async fn active_plan(
    db: &TestDb,
    user: Uuid,
) -> Option<(Uuid, Option<chrono::DateTime<chrono::Utc>>)> {
    sqlx::query_as(
        "SELECT plan_id, expires_at FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(user)
    .fetch_optional(&db.pool)
    .await
    .unwrap()
}

/// POST raw form to the notify endpoint through the full router.
async fn post_notify(
    state: &AppState,
    ip: std::net::IpAddr,
    body: Vec<u8>,
) -> crate::testdb::http::Resp {
    use axum::body::Body;
    use tower::ServiceExt;
    // R40: the per-method route of the panel's first method (the legacy
    // `/pay/alipay/notify` has its own tests in tests/w24.rs).
    let uri = match state.payments().methods.first() {
        Some(m) => format!("/test/pay/{}/notify", m.id),
        None => "/test/pay/alipay/notify".to_string(),
    };
    let mut req = axum::http::Request::builder()
        .method(Method::POST)
        .uri(uri)
        // Alipay posts to the main domain (W25: set in 系统设置, so the
        // host gate is on).
        .header("host", ORIGIN.trim_start_matches("https://"))
        .header(
            "content-type",
            "application/x-www-form-urlencoded; charset=utf-8",
        )
        .body(Body::from(body))
        .unwrap();
    req.extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::new(
            ip, 40000,
        )));
    let res = crate::web::router(state.clone())
        .oneshot(req)
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap()
        .to_vec();
    crate::testdb::http::Resp {
        status,
        headers,
        body,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The whole user journey over HTTP: shop → order (precreate at the mock)
/// → poll (pending) → payment → poll fulfils via the active query → plan
/// and node access → replayed notify is a no-op → bad notifies are the
/// canonical rejection.
#[tokio::test]
async fn http_purchase_flow() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (node, plan) = priced_plan(&db, "monthly", 990, 30).await;
    let user = db.user().await;
    let mut c = Client::new(&state, rand_ip());
    c.cookie = Some(token(&state, user).await);

    let r = c.get("/test/api/v1/me/shop").await;
    assert_eq!(r.status, StatusCode::OK);
    let shop = r.json();
    assert_eq!(shop["enabled"], true);
    assert_eq!(shop["plans"][0]["offers"][0]["price_cents"], 990);
    assert_eq!(shop["plans"][0]["offers"][0]["amount_cents"], 990);
    assert_eq!(shop["plans"][0]["offers"][0]["period"], "days");
    assert_eq!(shop["plans"][0]["offers"][0]["action"], "new");

    // Client-side amounts do not exist: unknown fields are refused.
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days", "amount_cents": 1 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": Uuid::new_v4(), "period": "days" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let o = r.json();
    let oid: Uuid = o["id"].as_str().unwrap().parse().unwrap();
    let otn = o["out_trade_no"].as_str().unwrap().to_string();
    assert_eq!(o["amount_cents"], 990);
    assert_eq!(o["status"], "pending");
    assert!(
        o["qr_code"]
            .as_str()
            .unwrap()
            .starts_with("https://qr.alipay.com/")
    );
    assert!(otn.starts_with("AK") && otn.len() == 34, "{otn}");

    // Pending: polling queries (TRADE_NOT_EXIST) and stays pending.
    let r = c.get(&format!("/test/api/v1/me/orders/{oid}")).await;
    assert_eq!(r.json()["status"], "pending");
    assert_eq!(mock.calls("alipay.trade.query"), 1);
    // Throttled: an immediate second poll does not query again.
    c.get(&format!("/test/api/v1/me/orders/{oid}")).await;
    assert_eq!(mock.calls("alipay.trade.query"), 1);

    // Another user cannot see it.
    let other = db.user().await;
    let mut c2 = Client::new(&state, rand_ip());
    c2.cookie = Some(token(&state, other).await);
    assert_eq!(
        c2.get(&format!("/test/api/v1/me/orders/{oid}"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // Paid at Alipay; no notify can reach us: the poll fulfils.
    mock.pay(&otn);
    sqlx::query("UPDATE orders SET last_query_at = now() - interval '1 minute' WHERE id = $1")
        .bind(oid)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c.get(&format!("/test/api/v1/me/orders/{oid}")).await;
    assert_eq!(r.json()["status"], "paid", "{:?}", r.json());
    assert_eq!(r.json()["fulfilled"], true);
    assert!(r.json()["qr_code"].is_null());
    let (p, exp) = active_plan(&db, user).await.unwrap();
    assert_eq!(p, plan);
    let days = (exp.unwrap() - chrono::Utc::now()).num_hours();
    assert!((29 * 24..=30 * 24).contains(&days), "{days}");
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM node_users WHERE user_id = $1 AND NOT manual",
            user
        )
        .await,
        1,
        "plan access to the node"
    );
    let _ = node;

    // The (late) notify for the same payment: acknowledged, no effect.
    let ip = rand_ip();
    let r = post_notify(
        &state,
        ip,
        form(&notify_params(&otn, "9.90", "TRADE_SUCCESS")),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body, b"success");
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM audit_log WHERE action = 'order.paid' AND target_id = $1::text",
            oid
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM user_plans WHERE user_id = $1",
            user
        )
        .await,
        1
    );
    let dup: String = sqlx::query_scalar(
        "SELECT outcome FROM payment_events WHERE order_id = $1 AND source = 'notify'",
    )
    .bind(oid)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(dup, "duplicate");

    // My orders list, shop now offers renewal.
    let r = c.get("/test/api/v1/me/orders").await;
    assert_eq!(r.json().as_array().unwrap().len(), 1);
    let r = c.get("/test/api/v1/me/shop").await;
    assert_eq!(r.json()["plans"][0]["offers"][0]["action"], "renew");

    // Admin views.
    let admin = db.admin().await;
    let mut a = Client::new(&state, rand_ip());
    a.cookie = Some(token(&state, admin).await);
    let r = a.get("/test/api/v1/orders?status=paid").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()[0]["paid_via"], "query");
    let r = a.get(&format!("/test/api/v1/orders/{oid}")).await;
    let events = r.json()["events"].as_array().unwrap().clone();
    assert!(events.iter().any(|e| e["source"] == "precreate"));
    assert!(
        events
            .iter()
            .all(|e| e["params"]["sign"].is_null() || e["params"]["sign"] == "<redacted>")
    );
    // Users cannot reach admin endpoints.
    assert_eq!(
        c.get("/test/api/v1/orders").await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        a.post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days" })
        )
        .await
        .status,
        StatusCode::BAD_REQUEST,
        "admins cannot buy"
    );
    drop(state);
    db.drop().await;
}

/// R21: expired and quota-disabled users (renewal scope, `auth::ShopUser`)
/// can list the shop, create an order, poll it and cancel it; a user
/// disabled by an admin cannot reach any of it.
#[tokio::test]
async fn renewal_scope_users_can_shop() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "renew", 500, 30).await;

    let expired = db.user().await;
    sqlx::query("UPDATE users SET expires_at = now() - interval '1 minute' WHERE id = $1")
        .bind(expired)
        .execute(&db.pool)
        .await
        .unwrap();
    let quota = db.user().await;
    sqlx::query("UPDATE users SET enabled = false, disabled_reason = 'quota' WHERE id = $1")
        .bind(quota)
        .execute(&db.pool)
        .await
        .unwrap();
    for (who, user) in [("expired", expired), ("quota", quota)] {
        let mut c = Client::new(&state, rand_ip());
        // Issued before the state change would be revoked (session_ver):
        // a fresh token is what a renewal-scope login hands out.
        c.cookie = Some(token(&state, user).await);
        // Proxy access stays blocked for this session.
        assert_eq!(
            c.post("/test/api/v1/me/sub-token", json!({})).await.status,
            StatusCode::UNAUTHORIZED,
            "{who}"
        );
        let r = c.get("/test/api/v1/me/shop").await;
        assert_eq!(r.status, StatusCode::OK, "{who}");
        assert_eq!(r.json()["enabled"], true, "{who}");
        assert_eq!(r.json()["plans"][0]["offers"][0]["action"], "new", "{who}");
        let r = c
            .post(
                "/test/api/v1/me/orders",
                json!({ "plan_id": plan, "period": "days" }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{who}: {:?}", r.json());
        let oid = r.json()["id"].as_str().unwrap().to_string();
        let r = c.get(&format!("/test/api/v1/me/orders/{oid}")).await;
        assert_eq!(r.status, StatusCode::OK, "{who}");
        assert_eq!(r.json()["status"], "pending", "{who}");
        let r = c.get("/test/api/v1/me/orders").await;
        assert_eq!(r.status, StatusCode::OK, "{who}");
        assert_eq!(r.json().as_array().map(Vec::len), Some(1), "{who}");
        let r = c
            .post(&format!("/test/api/v1/me/orders/{oid}/cancel"), json!({}))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{who}: {:?}", r.json());
        assert_eq!(r.json()["status"], "cancelled", "{who}");
    }

    // Disabled by an admin: no renewal scope.
    let banned = db.user().await;
    sqlx::query("UPDATE users SET enabled = false, disabled_reason = 'admin' WHERE id = $1")
        .bind(banned)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut c = Client::new(&state, rand_ip());
    c.cookie = Some(token(&state, banned).await);
    assert_eq!(
        c.get("/test/api/v1/me/shop").await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        c.get("/test/api/v1/me/orders").await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        c.post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days" })
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM orders WHERE user_id = $1",
            banned
        )
        .await,
        0
    );
    drop(state);
    db.drop().await;
}

/// Every notify refusal is byte-identical to the canonical rejection, and
/// leaves an event row; nothing is fulfilled.
#[tokio::test]
async fn notify_rejections_are_canonical() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "p", 500, 30).await;
    let user = db.user().await;
    let (oid, otn) = order_row(&db, user, plan, 500, 30).await;
    let canonical = Client::new(&state, rand_ip()).get("/").await.fingerprint();
    let (method, _) = method_of(&state);
    for path in [
        "/test/pay/alipay/notify".to_string(),
        format!("/test/pay/{method}/notify"),
    ] {
        let canonical2 = Client::new(&state, rand_ip())
            .get(&path)
            .await
            .fingerprint();
        assert_eq!(canonical, canonical2, "GET on the notify route");
    }

    let good = notify_params(&otn, "5.00", "TRADE_SUCCESS");
    let mut bad_sig = good.clone();
    bad_sig.insert("total_amount".into(), "0.01".into());
    let mut foreign_app = good.clone();
    foreign_app.insert("app_id".into(), "2021999999999999".into());
    sign_notify(&mut foreign_app);
    let mut foreign_seller = good.clone();
    foreign_seller.insert("seller_id".into(), "2088999999999999".into());
    sign_notify(&mut foreign_seller);
    let wrong_amount = notify_params(&otn, "0.01", "TRADE_SUCCESS");
    let unknown = notify_params("AKNOPE", "5.00", "TRADE_SUCCESS");
    let mut app_signed = good.clone();
    let s = panel_keys()
        .sign(&alipay::notify_sign_content(&app_signed, true))
        .unwrap();
    app_signed.insert("sign".into(), s);
    let mut dup_body = form(&good);
    dup_body.extend_from_slice(b"&trade_status=TRADE_SUCCESS");
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("bad signature", form(&bad_sig)),
        ("signed by the app key", form(&app_signed)),
        ("foreign app_id", form(&foreign_app)),
        ("foreign seller_id", form(&foreign_seller)),
        ("amount mismatch", form(&wrong_amount)),
        ("unknown order", form(&unknown)),
        ("duplicate parameter", dup_body),
        ("empty", Vec::new()),
        ("not utf-8", vec![0xff, 0xfe, b'=', b'1']),
        ("oversized", vec![b'a'; 20_000]),
    ];
    for (name, body) in cases {
        let r = post_notify(&state, rand_ip(), body).await;
        assert_eq!(r.fingerprint(), canonical, "{name}");
    }
    let (status, _, _) = order_status(&db, oid).await;
    assert_eq!(status, "pending");
    let events: Vec<(bool, String)> =
        sqlx::query_as("SELECT verified, outcome FROM payment_events ORDER BY id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    let outcomes: Vec<&str> = events.iter().map(|e| e.1.as_str()).collect();
    assert_eq!(
        outcomes,
        [
            "bad_signature",
            "bad_signature",
            "app_id_mismatch",
            "seller_id_mismatch",
            "amount_mismatch",
            "unknown_order",
            "malformed",
            "bad_signature",
            "malformed",
            "oversized"
        ]
    );
    // Verified-but-wrong notifies for a real order are audited.
    assert_eq!(
        count(&db, "SELECT count(*) FROM audit_log WHERE action = 'order.payment.rejected' AND target_id = $1::text", oid).await,
        3
    );
    // The signature never lands in the event log.
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_events WHERE params->>'sign' IS NOT NULL \
         AND params->>'sign' <> '<redacted>'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(leaked, 0);

    // WAIT_BUYER_PAY is acknowledged without effect; then the real one.
    let r = post_notify(
        &state,
        rand_ip(),
        form(&notify_params(&otn, "5.00", "WAIT_BUYER_PAY")),
    )
    .await;
    assert_eq!(r.body, b"success");
    assert_eq!(order_status(&db, oid).await.0, "pending");
    let r = post_notify(&state, rand_ip(), form(&good)).await;
    assert_eq!(
        (r.status, r.body.as_slice()),
        (StatusCode::OK, &b"success"[..])
    );
    assert_eq!(order_status(&db, oid).await, ("paid".into(), true, None));

    // Payments disabled: the notify route is just a rejection.
    let off = AppState::for_test(db.pool.clone()).await;
    let r = post_notify(&off, rand_ip(), form(&good)).await;
    assert_eq!(r.fingerprint(), canonical);
    drop(off);
    drop(state);
    db.drop().await;
}

/// Concurrent duplicate notifies plus concurrent queries for one payment
/// fulfil exactly once.
#[tokio::test]
async fn concurrent_duplicates_fulfil_once() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "p", 1200, 30).await;
    let user = db.user().await;
    let (oid, otn) = order_row(&db, user, plan, 1200, 30).await;
    // Make the mock know the trade as paid (for the query path).
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
                super::api::handle_notify(&state, &*alipay, method, None, &body)
                    .await
                    .unwrap()
            }
        }));
    }
    for t in tasks {
        assert!(t.await.unwrap());
    }
    assert_eq!(order_status(&db, oid).await, ("paid".into(), true, None));
    for (sql, want) in [
        (
            "SELECT count(*) FROM audit_log WHERE action = 'order.paid' AND target_id = $1::text",
            1,
        ),
        (
            "SELECT count(*) FROM payment_events WHERE order_id = $1 AND outcome = 'paid'",
            1,
        ),
    ] {
        assert_eq!(count(&db, sql, oid).await, want, "{sql}");
    }
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM user_plans WHERE user_id = $1",
            user
        )
        .await,
        1
    );
    assert_eq!(
        count(&db, "SELECT count(*) FROM audit_log WHERE action = 'user.plan.set' AND target_id = $1::text", user).await,
        1
    );
    drop(state);
    db.drop().await;
}

/// Renewal extends the same plan by its period from the current expiry;
/// a different plan replaces it (usage reset); exactly the plan's nodes
/// are bumped, once each, and the order + plan change write one audit row
/// each (the billing analogue of every_access_change_bumps_affected_nodes).
#[tokio::test]
async fn renew_replace_and_bumps() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (n1, p1) = priced_plan(&db, "a", 1000, 30).await;
    let (n2, p2) = priced_plan(&db, "b", 3000, 90).await;
    let user = db.user().await;
    let actor = orders::payment_actor(None);
    let mut listener = db.listener().await;
    let quiet = std::time::Duration::from_millis(150);
    let audit = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit_log")
            .fetch_one(&db.pool)
            .await
            .unwrap()
    };
    let notified = |v: Vec<String>| -> Vec<String> {
        let mut v: Vec<String> = v
            .into_iter()
            .filter(|p| p == &n1.to_string() || p == &n2.to_string())
            .collect();
        v.sort();
        v
    };

    // New purchase of plan a.
    let (o1, _) = order_row(&db, user, p1, 1000, 30).await;
    crate::testdb::drain(&mut listener, std::time::Duration::from_millis(20)).await;
    let before = (db.versions(n1).await, db.versions(n2).await, audit().await);
    let mut tx = db.pool.begin().await.unwrap();
    let r = orders::apply_mark_paid(
        &mut tx,
        &actor,
        o1,
        Via::Notify,
        Some("T1"),
        Some(1000),
        None,
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(r, Paid::Now { fulfilled: true });
    assert_ne!(db.versions(n1).await, before.0, "plan node bumped");
    assert_eq!(db.versions(n2).await, before.1, "other node untouched");
    assert_eq!(audit().await - before.2, 2, "order.paid + user.plan.set");
    assert_eq!(
        notified(crate::testdb::drain(&mut listener, quiet).await),
        vec![n1.to_string()]
    );
    let (_, exp1) = active_plan(&db, user).await.unwrap();
    let exp1 = exp1.unwrap();

    // Renewal: +30 days from the current expiry; no access change.
    sqlx::query("UPDATE users SET traffic_used_bytes = 777 WHERE id = $1")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    let (o2, _) = order_row(&db, user, p1, 1000, 30).await;
    let mut tx = db.pool.begin().await.unwrap();
    orders::apply_mark_paid(
        &mut tx,
        &actor,
        o2,
        Via::Query,
        Some("T2"),
        Some(1000),
        None,
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    let (p, exp2) = active_plan(&db, user).await.unwrap();
    assert_eq!(p, p1);
    assert_eq!((exp2.unwrap() - exp1).num_days(), 30);
    assert_eq!(db.used(user).await, 777, "renewal keeps usage");
    let res: Value = sqlx::query_scalar("SELECT fulfil_result FROM orders WHERE id = $1")
        .bind(o2)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(res["kind"], "renew");

    // Different plan: replaces, resets usage, moves access n1 -> n2.
    let (o3, _) = order_row(&db, user, p2, 3000, 90).await;
    crate::testdb::drain(&mut listener, std::time::Duration::from_millis(20)).await;
    let mut tx = db.pool.begin().await.unwrap();
    orders::apply_mark_paid(
        &mut tx,
        &actor,
        o3,
        Via::Notify,
        Some("T3"),
        Some(3000),
        None,
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    let (p, exp3) = active_plan(&db, user).await.unwrap();
    assert_eq!(p, p2);
    let d = (exp3.unwrap() - chrono::Utc::now()).num_hours();
    assert!((89 * 24..=90 * 24).contains(&d), "{d}");
    assert_eq!(db.used(user).await, 0, "replace resets usage");
    let mut want = vec![n1.to_string(), n2.to_string()];
    want.sort();
    assert_eq!(
        notified(crate::testdb::drain(&mut listener, quiet).await),
        want
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM node_users_departed WHERE user_id = $1",
            user
        )
        .await,
        1,
        "the revoked node keeps tail billing"
    );
    drop(listener);
    db.drop().await;
}

/// Fulfilment failures keep the payment (paid + fulfil_error) and an admin
/// can retry; manual mark-paid is audited with its reason.
#[tokio::test]
async fn failed_fulfilment_and_admin_actions() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "p", 800, 30).await;
    let user = db.user().await;
    let (oid, otn) = order_row(&db, user, plan, 800, 30).await;
    sqlx::query("UPDATE plans SET enabled = false WHERE id = $1")
        .bind(plan)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = post_notify(
        &state,
        rand_ip(),
        form(&notify_params(&otn, "8.00", "TRADE_SUCCESS")),
    )
    .await;
    assert_eq!(r.body, b"success", "the money is acknowledged");
    let (st, fulfilled, err) = order_status(&db, oid).await;
    assert_eq!((st.as_str(), fulfilled), ("paid", false));
    assert!(err.unwrap().contains("disabled"));
    assert!(
        active_plan(&db, user).await.is_none(),
        "plan change rolled back"
    );

    let admin = db.admin().await;
    let mut a = Client::new(&state, rand_ip());
    a.cookie = Some(token(&state, admin).await);
    let r = a.get("/test/api/v1/orders?unfulfilled=true").await;
    assert_eq!(r.json().as_array().unwrap().len(), 1);
    let path = format!("/test/api/v1/orders/{oid}/fulfil");
    assert_eq!(
        a.post(&path, json!({ "reason": "" })).await.status,
        StatusCode::BAD_REQUEST
    );
    sqlx::query("UPDATE plans SET enabled = true WHERE id = $1")
        .bind(plan)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = a.post(&path, json!({ "reason": "plan re-enabled" })).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["fulfilled"], true);
    assert_eq!(order_status(&db, oid).await, ("paid".into(), true, None));
    assert_eq!(
        a.post(&path, json!({ "reason": "again" })).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        count(&db, "SELECT count(*) FROM audit_log WHERE action = 'order.fulfil.retry' AND target_id = $1::text", oid).await,
        1
    );

    // Manual mark-paid of a pending order (support case).
    let u2 = db.user().await;
    let (o2, _) = order_row(&db, u2, plan, 800, 30).await;
    let r = a
        .post(
            &format!("/test/api/v1/orders/{o2}/fulfil"),
            json!({ "reason": "paid by bank transfer #42" }),
        )
        .await;
    assert_eq!(r.json()["fulfilled"], true);
    let (via, reason): (String, String) =
        sqlx::query_as("SELECT paid_via, manual_reason FROM orders WHERE id = $1")
            .bind(o2)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        (via.as_str(), reason.as_str()),
        ("manual", "paid by bank transfer #42")
    );
    let audit: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'order.paid' AND target_id = $1::text",
    )
    .bind(o2.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audit["reason"], "paid by bank transfer #42");
    assert_eq!(active_plan(&db, u2).await.unwrap().0, plan);

    // Prices: validation and audit.
    let pp = format!("/test/api/v1/plans/{plan}/prices");
    for body in [
        json!({ "on_sale": true, "prices": [{ "period": "month", "price_cents": 0 }] }),
        json!({ "on_sale": true, "prices": [{ "period": "days", "price_cents": 100 }] }),
        json!({ "on_sale": true, "prices": [{ "period": "month", "price_cents": 1.5 }] }),
        json!({ "on_sale": true, "prices": [{ "period": "weekly", "price_cents": 100 }] }),
        json!({ "on_sale": true, "prices": [{ "period": "month", "days": 3, "price_cents": 1 }] }),
        json!({ "on_sale": true, "prices": [{ "period": "reset", "price_cents": 100 }] }),
        json!({ "on_sale": true, "prices": [{ "period": "month", "price_cents": 1, "x": 1 }] }),
        json!({ "prices": [] }),
    ] {
        let r = a.req(Method::PUT, &pp, Some(body.clone())).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
    }
    let r = a
        .req(
            Method::PUT,
            &pp,
            Some(json!({ "on_sale": false, "prices": [
                { "period": "year", "price_cents": 10000 },
                { "period": "month", "price_cents": 1 },
                { "period": "reset", "price_cents": 300 },
            ] })),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = a.get("/test/api/v1/plan-prices").await;
    assert_eq!(r.json()["payments_enabled"], true);
    let row = r.json()["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["plan_id"] == json!(plan))
        .cloned()
        .unwrap();
    assert_eq!(row["on_sale"], false);
    assert_eq!(row["prices"].as_array().unwrap().len(), 3);
    let r = a.get("/test/api/v1/plans").await;
    let pv = r.json()[0].clone();
    assert_eq!(
        pv["prices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["period"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["month", "year", "reset"],
        "period order"
    );
    assert_eq!(
        a.req(
            Method::PUT,
            "/test/api/v1/plans/00000000-0000-0000-0000-000000000000/prices",
            Some(json!({ "on_sale": false, "prices": [] }))
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'plan.price.set' AND target_id = $1::text",
    )
    .bind(plan.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audits, 2, "creation + this update");
    drop(state);
    db.drop().await;
}

/// The reconcile: past-expiry pending orders are queried, closed and
/// expired; a late payment found by the query is fulfilled instead; a
/// gateway outage leaves the order pending (retried) until the grace.
#[tokio::test]
async fn reconcile_expires_and_catches_late_payments() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, alipay) = method_of(&state);
    let (_, plan) = priced_plan(&db, "p", 300, 30).await;
    let u1 = db.user().await;
    let u2 = db.user().await;
    let u3 = db.user().await;
    let (expiring, otn1) = order_row(&db, u1, plan, 300, 30).await;
    let (late, otn2) = order_row(&db, u2, plan, 300, 30).await;
    let (fresh, otn3) = order_row(&db, u3, plan, 300, 30).await;
    for otn in [&otn1, &otn2, &otn3] {
        precreate(&*alipay, otn, 300).await;
    }
    mock.inner
        .lock()
        .unwrap()
        .trades
        .get_mut(&otn1)
        .unwrap()
        .status = Some("WAIT_BUYER_PAY".into());
    mock.pay(&otn2);
    sqlx::query("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ANY($1)")
        .bind(vec![expiring, late])
        .execute(&db.pool)
        .await
        .unwrap();

    // Outage: nothing changes.
    mock.set_down(true);
    orders::reconcile_tick(&state).await.ok().unwrap();
    for id in [expiring, late, fresh] {
        assert_eq!(order_status(&db, id).await.0, "pending");
    }
    mock.set_down(false);
    sqlx::query("UPDATE orders SET last_query_at = NULL")
        .execute(&db.pool)
        .await
        .unwrap();
    orders::reconcile_tick(&state).await.ok().unwrap();
    assert_eq!(order_status(&db, expiring).await.0, "expired");
    assert_eq!(mock.status(&otn1).as_deref(), Some("TRADE_CLOSED"));
    assert_eq!(order_status(&db, late).await, ("paid".into(), true, None));
    assert_eq!(order_status(&db, fresh).await.0, "pending");
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM audit_log WHERE action = 'order.expire' AND target_id = $1::text",
            expiring
        )
        .await,
        1
    );
    // A second tick right away: claims prevent re-querying.
    let q = mock.calls("alipay.trade.query");
    orders::reconcile_tick(&state).await.ok().unwrap();
    assert_eq!(mock.calls("alipay.trade.query"), q);

    // A notify for the expired order (paid after all): still fulfilled.
    let r = post_notify(
        &state,
        rand_ip(),
        form(&notify_params(&otn1, "3.00", "TRADE_SUCCESS")),
    )
    .await;
    assert_eq!(r.body, b"success");
    assert_eq!(
        order_status(&db, expiring).await,
        ("paid".into(), true, None)
    );

    // Amount tampering in a query answer is refused and audited.
    let u4 = db.user().await;
    let (o4, otn4) = order_row(&db, u4, plan, 300, 30).await;
    precreate(&*alipay, &otn4, 300).await;
    mock.pay(&otn4);
    mock.inner.lock().unwrap().total_override = Some("0.01".into());
    orders::poll(&state, o4).await.ok().unwrap();
    assert_eq!(order_status(&db, o4).await.0, "pending");
    assert_eq!(
        count(&db, "SELECT count(*) FROM audit_log WHERE action = 'order.payment.rejected' AND target_id = $1::text", o4).await,
        1
    );
    drop(state);
    db.drop().await;
}

/// A new order cancels the user's previous pending one (closing it at
/// Alipay); explicit cancel; precreate failure cancels the new order.
#[tokio::test]
async fn one_open_order_per_user() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "p", 300, 30).await;
    let user = db.user().await;
    let mut c = Client::new(&state, rand_ip());
    c.cookie = Some(token(&state, user).await);
    let r1 = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days" }),
        )
        .await
        .json();
    let r2 = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days" }),
        )
        .await
        .json();
    let id1: Uuid = r1["id"].as_str().unwrap().parse().unwrap();
    let id2: Uuid = r2["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(order_status(&db, id1).await.0, "cancelled");
    assert_eq!(order_status(&db, id2).await.0, "pending");
    let r = c
        .post(&format!("/test/api/v1/me/orders/{id2}/cancel"), json!({}))
        .await;
    assert_eq!(r.json()["status"], "cancelled");
    let r = c
        .post(&format!("/test/api/v1/me/orders/{id2}/cancel"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    mock.set_down(true);
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_GATEWAY);
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM orders WHERE user_id = $1 AND close_state = 'precreate_failed' \
         AND status = 'cancelled'",
    )
    .bind(user)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(n, 1);
    drop(state);
    db.drop().await;
}

/// W24: `[payments]` in panel.toml is obsolete: never an error (old files
/// keep starting), always a warning, and never printed by `config check`.
#[test]
fn obsolete_payments_section_is_a_warning() {
    let c = crate::config::PanelConfig::default();
    assert!(c.validate().errors.is_empty() && c.validate().warnings.is_empty());
    let text = r#"
[payments.alipay]
enabled = true
app_id = "2021000000000001"
notify_url = "https://panel.example/abc/pay/alipay/notify"
whatever_unknown = 1
"#;
    let c = crate::config::PanelConfig::parse(text).unwrap();
    let r = c.validate();
    assert!(r.errors.is_empty(), "{r:?}");
    let w = c.obsolete_warnings();
    assert!(
        w.iter().any(|w| w.contains("[payments] is obsolete")),
        "{w:?}"
    );
    let t = c.effective_toml().unwrap();
    assert!(!t.contains("payments") && !t.contains("/abc/"), "{t}");
}

/// R22/W24: the notify URL handed to Alipay follows the main domain of the
/// system settings (current prefix); without one, no order is created.
#[tokio::test]
async fn notify_url_follows_the_main_domain() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let (_, plan) = priced_plan(&db, "nu", 500, 30).await;

    let derived = AppState::for_test(db.pool.clone()).await;
    let method = add_method(&derived, &mock.url, "支付宝").await;
    let user = db.user().await;
    let mut c = Client::new(&derived, rand_ip());
    c.cookie = Some(token(&derived, user).await);
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{:?}", r.json());
    assert_eq!(r.json()["error"], "payments are not enabled");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM orders WHERE user_id = $1")
        .bind(user)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "no order without a notify URL");
    assert_eq!(mock.calls("alipay.trade.precreate"), 0);

    let mut tx = db.pool.begin().await.unwrap();
    crate::settings::apply_update(
        &mut tx,
        &crate::audit::Actor::test(),
        0,
        &crate::settings::Values {
            main_domain: Some("pay.example.com".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    crate::settings::reload(&derived).await.unwrap();
    // The host gate is on now: address the main domain.
    c.headers = vec![("host".into(), "pay.example.com".into())];
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(
        mock.inner.lock().unwrap().notify_urls,
        [format!("https://pay.example.com/test/pay/{method}/notify")]
    );

    drop(derived);
    db.drop().await;
}

// ---------------------------------------------------------------------------
// W7: plan catalogue — periods, reset packs, switching with proration,
// capacity, renewal-only, switch rules, speed limits
// ---------------------------------------------------------------------------

use super::catalog::{PeriodKind, PeriodKindText, Price, SetPricesReq};

/// A plan granting one new node, with these prices, on sale; `tweak`
/// adjusts the creation request. Returns (node, plan).
async fn catalog_plan(
    db: &TestDb,
    name: &str,
    prices: &[(PeriodKind, Option<i32>, i64)],
    tweak: impl FnOnce(&mut crate::plans::CreatePlanReq),
) -> (Uuid, Uuid) {
    let node = db.node().await;
    let actor = crate::audit::Actor::test();
    let mut tx = db.pool.begin().await.unwrap();
    let g = crate::plans::apply_create_group(
        &mut tx,
        &actor,
        &crate::plans::CreateGroupReq {
            name: format!("g-{name}"),
            description: None,
            node_ids: Some(vec![node]),
        },
    )
    .await
    .ok()
    .unwrap();
    let mut req = crate::plans::CreatePlanReq {
        name: name.into(),
        traffic_quota_bytes: Some(1 << 30),
        period: "monthly".into(),
        group_ids: Some(vec![g]),
        ..Default::default()
    };
    tweak(&mut req);
    let p = crate::plans::apply_create_plan(&mut tx, &actor, &req)
        .await
        .ok()
        .unwrap();
    super::catalog::apply_set_prices(
        &mut tx,
        &actor,
        p,
        &SetPricesReq {
            on_sale: true,
            prices: prices
                .iter()
                .map(|(k, d, c)| Price {
                    period: PeriodKindText(*k),
                    days: *d,
                    price_cents: *c,
                })
                .collect(),
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    (node, p)
}

/// Pay an order through the one pay path (as a verified notify would).
async fn pay(db: &TestDb, order: Uuid) -> Paid {
    let mut tx = db.pool.begin().await.unwrap();
    let r = orders::apply_mark_paid(
        &mut tx,
        &orders::payment_actor(None),
        order,
        Via::Notify,
        Some("T"),
        None,
        None,
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    r
}

async fn buy(c: &Client, plan: Uuid, period: &str) -> crate::testdb::http::Resp {
    c.post(
        "/test/api/v1/me/orders",
        json!({ "plan_id": plan, "period": period }),
    )
    .await
}

fn order_id(r: &crate::testdb::http::Resp) -> Uuid {
    r.json()["id"].as_str().unwrap().parse().unwrap()
}

async fn user_client(state: &AppState, user: Uuid) -> Client {
    let mut c = Client::new(state, rand_ip());
    c.cookie = Some(token(state, user).await);
    c
}

async fn expiry(db: &TestDb, user: Uuid) -> Option<chrono::DateTime<chrono::Utc>> {
    active_plan(db, user).await.and_then(|p| p.1)
}

/// The SQL period arithmetic and proration (the only place money and time
/// are combined): calendar months clamp to the month's end in UTC, days are
/// exact, permanent one-time has no end; the credit floors to the fen, is
/// capped and never negative.
#[tokio::test]
async fn period_and_proration_sql() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let end = |base: &str, period: &str, days: Option<i32>| {
        let pool = db.pool.clone();
        let (base, period) = (base.to_string(), period.to_string());
        async move {
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT to_char(akari_period_end($1::timestamptz, $2, $3) AT TIME ZONE 'UTC', \
                 'YYYY-MM-DD HH24:MI:SS')",
            )
            .bind(base)
            .bind(period)
            .bind(days)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    for (base, period, days, want) in [
        (
            "2026-01-31T10:00:00Z",
            "month",
            None,
            Some("2026-02-28 10:00:00"),
        ),
        (
            "2028-01-31T10:00:00Z",
            "month",
            None,
            Some("2028-02-29 10:00:00"),
        ),
        (
            "2026-03-31T23:30:00Z",
            "quarter",
            None,
            Some("2026-06-30 23:30:00"),
        ),
        (
            "2026-08-31T00:00:00Z",
            "half_year",
            None,
            Some("2027-02-28 00:00:00"),
        ),
        (
            "2028-02-29T12:00:00Z",
            "year",
            None,
            Some("2029-02-28 12:00:00"),
        ),
        (
            "2026-10-02T08:00:00Z",
            "two_year",
            None,
            Some("2028-10-02 08:00:00"),
        ),
        (
            "2026-10-02T08:00:00Z",
            "three_year",
            None,
            Some("2029-10-02 08:00:00"),
        ),
        (
            "2026-10-02T08:00:00Z",
            "days",
            Some(30),
            Some("2026-11-01 08:00:00"),
        ),
        (
            "2026-10-02T08:00:00Z",
            "onetime",
            Some(7),
            Some("2026-10-09 08:00:00"),
        ),
        ("2026-10-02T08:00:00Z", "onetime", None, None),
    ] {
        assert_eq!(
            end(base, period, days).await.as_deref(),
            want,
            "{base} + {period} {days:?}"
        );
    }
    for (period, days) in [
        ("reset", None),
        ("days", None),
        ("days", Some(0)),
        ("weekly", None),
    ] {
        let r = sqlx::query("SELECT akari_period_end(now(), $1, $2)")
            .bind(period)
            .bind(days)
            .execute(&db.pool)
            .await;
        assert!(r.is_err(), "{period} {days:?} accepted");
    }
    let prorate = |v: Option<i64>, nd: Option<i32>, secs: Option<f64>, cap: i64| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT akari_prorate($1, $2, $3::numeric, $4)")
                .bind(v)
                .bind(nd)
                .bind(secs)
                .bind(cap)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    let day = 86400.0;
    // 15 of 30 days of 30.00 = 15.00; one second less floors to 14.99.
    assert_eq!(
        prorate(Some(3000), Some(30), Some(15.0 * day), 3000).await,
        1500
    );
    assert_eq!(
        prorate(Some(3000), Some(30), Some(15.0 * day - 1.0), 3000).await,
        1499
    );
    // 1 fen per 864 s at 30.00/30d: 863 s are worth nothing yet.
    assert_eq!(prorate(Some(3000), Some(30), Some(863.0), 3000).await, 0);
    assert_eq!(prorate(Some(3000), Some(30), Some(864.0), 3000).await, 1);
    // Odd prices floor: 9.99 for 7 of 30 days = 233.1 -> 233.
    assert_eq!(
        prorate(Some(999), Some(30), Some(7.0 * day), 999).await,
        233
    );
    // Capped by what was paid (stacked/extended expiries).
    assert_eq!(
        prorate(Some(3000), Some(30), Some(365.0 * day), 9000).await,
        9000
    );
    // Never negative, nothing for unknowns.
    assert_eq!(
        prorate(Some(3000), Some(30), Some(-5.0 * day), 3000).await,
        0
    );
    assert_eq!(prorate(Some(3000), None, Some(day), 3000).await, 0);
    assert_eq!(prorate(None, Some(30), Some(day), 3000).await, 0);
    assert_eq!(prorate(Some(3000), Some(30), None, 3000).await, 0);
    assert_eq!(prorate(Some(3000), Some(30), Some(day), 0).await, 0);
    // Largest price, longest remaining: no overflow.
    assert_eq!(
        prorate(Some(100_000_000), Some(30), Some(3650.0 * day), i64::MAX).await,
        12_166_666_666
    );
    let nominal: Vec<Option<i32>> = sqlx::query_scalar(
        "SELECT akari_period_nominal_days(k, d) FROM (VALUES ('month', NULL::int), \
         ('quarter', NULL), ('half_year', NULL), ('year', NULL), ('two_year', NULL), \
         ('three_year', NULL), ('days', 45), ('onetime', 10), ('onetime', NULL), \
         ('reset', NULL)) AS v(k, d)",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        nominal,
        vec![
            Some(30),
            Some(90),
            Some(180),
            Some(365),
            Some(730),
            Some(1095),
            Some(45),
            Some(10),
            None,
            None
        ]
    );
    db.drop().await;
}

/// Every period kind through the real order path: a new purchase, then
/// renewals of each length stacking from the current expiry, a permanent
/// one-time purchase, after which renewals are refused and the reset pack
/// still works.
#[tokio::test]
async fn every_period_kind() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let all = [
        (PeriodKind::Month, None, 1000),
        (PeriodKind::Quarter, None, 2700),
        (PeriodKind::HalfYear, None, 5000),
        (PeriodKind::Year, None, 9000),
        (PeriodKind::TwoYear, None, 17000),
        (PeriodKind::ThreeYear, None, 24000),
        (PeriodKind::Days, Some(10), 400),
        (PeriodKind::Onetime, Some(5), 300),
        (PeriodKind::Reset, None, 200),
    ];
    let (_, plan) = catalog_plan(&db, "all", &all, |_| {}).await;
    let user = db.user().await;
    let c = user_client(&state, user).await;

    // The shop offers every period but the reset pack to a newcomer.
    let shop = c.get("/test/api/v1/me/shop").await.json();
    let offers: Vec<&str> = shop["plans"][0]["offers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["period"].as_str().unwrap())
        .collect();
    assert_eq!(
        offers,
        vec![
            "month",
            "quarter",
            "half_year",
            "year",
            "two_year",
            "three_year",
            "days",
            "onetime"
        ]
    );
    let r = buy(&c, plan, "reset").await;
    assert_eq!(
        r.status,
        StatusCode::CONFLICT,
        "reset pack without the plan"
    );

    let r = buy(&c, plan, "month").await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(r.json()["amount_cents"], 1000);
    assert_eq!(r.json()["period"], "month");
    let o = order_id(&r);
    assert_eq!(pay(&db, o).await, Paid::Now { fulfilled: true });
    let mut exp = expiry(&db, user).await.unwrap();
    let want: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "SELECT akari_period_end(paid_at, 'month', NULL) FROM orders WHERE id = $1",
    )
    .bind(o)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(exp, want, "new: one calendar month from payment");

    for (period, days, cents) in all.iter().skip(1).filter(|p| p.0 != PeriodKind::Reset) {
        let r = buy(&c, plan, period.as_str()).await;
        assert_eq!(r.status, StatusCode::CREATED, "{period:?}");
        assert_eq!(r.json()["amount_cents"], *cents);
        assert_eq!(r.json()["credit_cents"], 0, "renewals earn no credit");
        assert_eq!(pay(&db, order_id(&r)).await, Paid::Now { fulfilled: true });
        let want: Option<chrono::DateTime<chrono::Utc>> =
            sqlx::query_scalar("SELECT akari_period_end($1, $2, $3)")
                .bind(exp)
                .bind(period.as_str())
                .bind(*days)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        let now = expiry(&db, user).await.unwrap();
        assert_eq!(
            Some(now),
            want,
            "{period:?} extends from the current expiry"
        );
        exp = now;
    }
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM user_plans WHERE user_id = $1",
            user
        )
        .await,
        1,
        "renewals never replace the subscription"
    );

    // Reset pack: usage to 0, quota-disabled user served again, nothing
    // else moves.
    sqlx::query(
        "UPDATE users SET traffic_used_bytes = 5000, enabled = false, disabled_reason = 'quota' \
         WHERE id = $1",
    )
    .bind(user)
    .execute(&db.pool)
    .await
    .unwrap();
    let marker: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT next_reset_at FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(user)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    // Disabling bumped session_ver: log in again (the R21 renewal scope).
    let c = user_client(&state, user).await;
    let shop = c.get("/test/api/v1/me/shop").await.json();
    let reset = shop["plans"][0]["offers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["period"] == "reset")
        .cloned()
        .unwrap();
    assert_eq!(
        (reset["action"].clone(), reset["amount_cents"].clone()),
        (json!("reset"), json!(200))
    );
    let r = buy(&c, plan, "reset").await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "quota-disabled users buy reset packs (R21)"
    );
    assert_eq!(pay(&db, order_id(&r)).await, Paid::Now { fulfilled: true });
    let (used, enabled): (i64, bool) =
        sqlx::query_as("SELECT traffic_used_bytes, enabled FROM users WHERE id = $1")
            .bind(user)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!((used, enabled), (0, true));
    assert_eq!(expiry(&db, user).await.unwrap(), exp, "no period change");
    let marker2: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT next_reset_at FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(user)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(marker, marker2, "the period reset schedule is untouched");
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM audit_log WHERE action = 'user.traffic.reset' \
                    AND target_id = $1::text AND after->>'source' = 'reset_pack'",
            user
        )
        .await,
        1
    );

    // Permanent one-time: no expiry; renewing is then refused, the reset
    // pack is still offered.
    sqlx::query(
        "UPDATE plan_period_prices SET days = NULL WHERE plan_id = $1 AND period = 'onetime'",
    )
    .bind(plan)
    .execute(&db.pool)
    .await
    .unwrap();
    let r = buy(&c, plan, "onetime").await;
    assert_eq!(r.json()["period_days"], Value::Null);
    assert_eq!(pay(&db, order_id(&r)).await, Paid::Now { fulfilled: true });
    assert_eq!(active_plan(&db, user).await.unwrap().1, None, "permanent");
    let r = buy(&c, plan, "month").await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(
        r.json()["error"],
        "your current plan does not expire; nothing to renew"
    );
    let r = buy(&c, plan, "reset").await;
    assert_eq!(r.status, StatusCode::CREATED);
    // Unknown kinds and unpriced periods.
    assert_eq!(
        buy(&c, plan, "weekly").await.status,
        StatusCode::BAD_REQUEST
    );
    sqlx::query("DELETE FROM plan_period_prices WHERE plan_id = $1 AND period = 'year'")
        .bind(plan)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = buy(&c, plan, "year").await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (StatusCode::BAD_REQUEST, json!("plan is not for sale"))
    );
    drop(state);
    db.drop().await;
}

/// A reset pack paid after the user lost the plan is kept as paid with a
/// fulfil_error (the admin resolves it), and nothing is reset.
#[tokio::test]
async fn reset_pack_without_the_plan_at_fulfilment() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = catalog_plan(
        &db,
        "r",
        &[
            (PeriodKind::Month, None, 1000),
            (PeriodKind::Reset, None, 200),
        ],
        |_| {},
    )
    .await;
    let user = db.user().await;
    let c = user_client(&state, user).await;
    let r = buy(&c, plan, "month").await;
    pay(&db, order_id(&r)).await;
    let r = buy(&c, plan, "reset").await;
    let reset = order_id(&r);
    let mut tx = db.pool.begin().await.unwrap();
    crate::plans::apply_cancel_user_plan(&mut tx, &crate::audit::Actor::test(), user)
        .await
        .ok()
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("UPDATE users SET traffic_used_bytes = 77 WHERE id = $1")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(pay(&db, reset).await, Paid::Now { fulfilled: false });
    let (st, fulfilled, err) = order_status(&db, reset).await;
    assert_eq!((st.as_str(), fulfilled), ("paid", false));
    assert!(err.unwrap().contains("reset pack"));
    assert_eq!(db.used(user).await, 77);
    drop(state);
    db.drop().await;
}

/// Switching plans: full price of the new period minus the pro-rata value
/// left on the current subscription's latest paid order; shown in the shop
/// before buying, recomputed at order creation, recorded on the order;
/// a credit covering the whole price pays the order at creation (amount 0,
/// paid_via credit, never sent to Alipay) and the excess is forfeited.
#[tokio::test]
async fn switching_plans_with_proration() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, a) = catalog_plan(&db, "a", &[(PeriodKind::Month, None, 3000)], |_| {}).await;
    let (_, b) = catalog_plan(&db, "b", &[(PeriodKind::Month, None, 5000)], |_| {}).await;
    let (_, cheap) = catalog_plan(&db, "c", &[(PeriodKind::Month, None, 1000)], |_| {}).await;
    let user = db.user().await;
    let c = user_client(&state, user).await;
    let r = buy(&c, a, "month").await;
    let first = order_id(&r);
    pay(&db, first).await;
    // Half of A's month is left (+60 s of margin: 1 fen = 864 s here).
    sqlx::query(
        "UPDATE user_plans SET expires_at = now() + interval '15 days 60 seconds' \
         WHERE user_id = $1 AND status = 'active'",
    )
    .bind(user)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE users SET expires_at = now() + interval '15 days 60 seconds' WHERE id = $1",
    )
    .bind(user)
    .execute(&db.pool)
    .await
    .unwrap();

    let shop = c.get("/test/api/v1/me/shop").await.json();
    assert_eq!(shop["credit_cents"], 1500);
    let offer = |name: &str| {
        shop["plans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name)
            .unwrap()["offers"][0]
            .clone()
    };
    let ob = offer("b");
    assert_eq!(
        (
            ob["action"].clone(),
            ob["price_cents"].clone(),
            ob["credit_cents"].clone(),
            ob["amount_cents"].clone()
        ),
        (json!("switch"), json!(5000), json!(1500), json!(3500))
    );
    let oa = offer("a");
    assert_eq!(
        (oa["action"].clone(), oa["amount_cents"].clone()),
        (json!("renew"), json!(3000))
    );

    let r = buy(&c, b, "month").await;
    assert_eq!(r.status, StatusCode::CREATED);
    let o = r.json();
    assert_eq!(
        (
            o["list_price_cents"].clone(),
            o["credit_cents"].clone(),
            o["amount_cents"].clone()
        ),
        (json!(5000), json!(1500), json!(3500))
    );
    let ob_id = order_id(&r);
    let src: Option<Uuid> = sqlx::query_scalar("SELECT credit_order_id FROM orders WHERE id = $1")
        .bind(ob_id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(src, Some(first));
    // Alipay is asked for the amount after credit.
    let otn = o["out_trade_no"].as_str().unwrap().to_string();
    assert_eq!(mock.inner.lock().unwrap().trades[&otn].total, "35.00");
    assert_eq!(pay(&db, ob_id).await, Paid::Now { fulfilled: true });
    assert_eq!(active_plan(&db, user).await.unwrap().0, b);
    let res: Value = sqlx::query_scalar("SELECT fulfil_result FROM orders WHERE id = $1")
        .bind(ob_id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(res["kind"], "switch");
    assert_eq!(res["credit_cents"], 1500);
    assert_eq!(res["credit_source_changed"], false);

    // B's fresh month is worth its full list price (5000, credit included):
    // downgrading to C (10.00) is paid by the credit; 40.00+ forfeited.
    let shop = c.get("/test/api/v1/me/shop").await.json();
    let credit = shop["credit_cents"].as_i64().unwrap();
    assert!((4900..=5000).contains(&credit), "{credit}");
    let oc = shop["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "c")
        .unwrap()["offers"][0]
        .clone();
    assert_eq!(
        (oc["amount_cents"].clone(), oc["credit_cents"].clone()),
        (json!(0), json!(1000))
    );
    assert_eq!(oc["forfeited_cents"], credit - 1000);
    let precreates = mock.calls("alipay.trade.precreate");
    let r = buy(&c, cheap, "month").await;
    assert_eq!(r.status, StatusCode::CREATED);
    let o = r.json();
    assert_eq!(
        (
            o["status"].clone(),
            o["amount_cents"].clone(),
            o["credit_cents"].clone(),
            o["fulfilled"].clone()
        ),
        (json!("paid"), json!(0), json!(1000), json!(true))
    );
    assert_eq!(
        mock.calls("alipay.trade.precreate"),
        precreates,
        "never sent to Alipay"
    );
    let via: String = sqlx::query_scalar("SELECT paid_via FROM orders WHERE id = $1")
        .bind(order_id(&r))
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(via, "credit");
    assert_eq!(active_plan(&db, user).await.unwrap().0, cheap);

    // An admin-assigned subscription (no paid order) earns no credit.
    let u2 = db.user().await;
    let mut tx = db.pool.begin().await.unwrap();
    crate::plans::apply_set_user_plan(
        &mut tx,
        &crate::audit::Actor::test(),
        u2,
        &crate::plans::SetUserPlanReq {
            plan_id: a,
            expires_at: Some(chrono::Utc::now() + chrono::Duration::days(20)),
            period_anchor: None,
            reset_traffic: None,
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    let c2 = user_client(&state, u2).await;
    let shop = c2.get("/test/api/v1/me/shop").await.json();
    assert_eq!(shop["credit_cents"], 0);
    let r = buy(&c2, b, "month").await;
    assert_eq!(
        (
            r.json()["amount_cents"].clone(),
            r.json()["credit_cents"].clone()
        ),
        (json!(5000), json!(0))
    );
    // Expired subscriptions are worth nothing either.
    sqlx::query(
        "UPDATE user_plans SET expires_at = now() - interval '1 minute' WHERE user_id = $1",
    )
    .bind(user)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        c.get("/test/api/v1/me/shop").await.json()["credit_cents"],
        0
    );
    drop(state);
    db.drop().await;
}

/// Capacity: two buyers race for the last slot. Both may create orders
/// (pending orders reserve nothing) and both pay; fulfilment re-checks
/// under entitle::lock, so exactly one gets the plan and the other stays
/// paid with fulfil_error (money kept, admin resolves). The shop then shows
/// the plan sold out and new orders are refused; renewals still work.
#[tokio::test]
async fn capacity_race_for_the_last_slot() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, plan) = catalog_plan(&db, "cap", &[(PeriodKind::Month, None, 1000)], |r| {
        r.capacity = Some(1)
    })
    .await;
    let (u1, u2, u3) = (db.user().await, db.user().await, db.user().await);
    let (c1, c2, c3) = (
        user_client(&state, u1).await,
        user_client(&state, u2).await,
        user_client(&state, u3).await,
    );
    let shop = c1.get("/test/api/v1/me/shop").await.json();
    assert_eq!(
        (
            shop["plans"][0]["remaining"].clone(),
            shop["plans"][0]["sold_out"].clone()
        ),
        (json!(1), json!(false))
    );
    let o1 = order_id(&buy(&c1, plan, "month").await);
    let o2 = order_id(&buy(&c2, plan, "month").await);
    let (r1, r2) = tokio::join!(pay(&db, o1), pay(&db, o2));
    let mut results = vec![r1, r2];
    results.sort_by_key(|r| format!("{r:?}"));
    assert_eq!(
        results,
        vec![
            Paid::Now { fulfilled: false },
            Paid::Now { fulfilled: true }
        ]
    );
    let s1 = order_status(&db, o1).await;
    let s2 = order_status(&db, o2).await;
    let first_won = s1.1;
    let (won, lost) = if first_won { (s1, s2) } else { (s2, s1) };
    assert_eq!((won.0.as_str(), won.1), ("paid", true));
    assert_eq!((lost.0.as_str(), lost.1), ("paid", false));
    assert_eq!(lost.2.as_deref(), Some("plan is sold out"));
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM user_plans WHERE plan_id = $1 AND status = 'active'",
            plan
        )
        .await,
        1
    );
    let shop = c3.get("/test/api/v1/me/shop").await.json();
    assert_eq!(
        (
            shop["plans"][0]["remaining"].clone(),
            shop["plans"][0]["sold_out"].clone()
        ),
        (json!(0), json!(true))
    );
    assert_eq!(shop["plans"][0]["offers"][0]["refusal"], "sold_out");
    let r = buy(&c3, plan, "month").await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (StatusCode::CONFLICT, json!("plan is sold out"))
    );
    // The holder renews a full plan.
    let holder = if first_won { &c1 } else { &c2 };
    assert_eq!(buy(holder, plan, "month").await.status, StatusCode::CREATED);
    // The admin resolves the loser by raising the capacity and retrying.
    sqlx::query("UPDATE plans SET capacity = 2 WHERE id = $1")
        .bind(plan)
        .execute(&db.pool)
        .await
        .unwrap();
    let lost_id = if first_won { o2 } else { o1 };
    let mut tx = db.pool.begin().await.unwrap();
    let r = orders::apply_admin_fulfil(
        &mut tx,
        &crate::audit::Actor::test(),
        lost_id,
        "capacity raised",
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(r, Paid::Now { fulfilled: true });
    drop(state);
    db.drop().await;
}

/// Renewal-only plans are invisible and closed to newcomers but renewable
/// by their holders; allow_switch_in=false closes a plan to holders of
/// another plan but not to newcomers.
#[tokio::test]
async fn renewal_only_and_switch_rules() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (_, legacy) = catalog_plan(&db, "legacy", &[(PeriodKind::Month, None, 1000)], |r| {
        r.renewal_only = Some(true)
    })
    .await;
    let (_, closed) = catalog_plan(&db, "closed", &[(PeriodKind::Month, None, 2000)], |r| {
        r.allow_switch_in = Some(false)
    })
    .await;
    let newcomer = db.user().await;
    let cn = user_client(&state, newcomer).await;
    let shop = cn.get("/test/api/v1/me/shop").await.json();
    let names: Vec<&str> = shop["plans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["closed"],
        "renewal-only plans are hidden from newcomers"
    );
    let r = buy(&cn, legacy, "month").await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (
            StatusCode::CONFLICT,
            json!("plan is only available to its current subscribers")
        )
    );

    let holder = db.user().await;
    let mut tx = db.pool.begin().await.unwrap();
    crate::plans::apply_set_user_plan(
        &mut tx,
        &crate::audit::Actor::test(),
        holder,
        &crate::plans::SetUserPlanReq {
            plan_id: legacy,
            expires_at: Some(chrono::Utc::now() + chrono::Duration::days(3)),
            period_anchor: None,
            reset_traffic: None,
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    let ch = user_client(&state, holder).await;
    let shop = ch.get("/test/api/v1/me/shop").await.json();
    let lp = shop["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "legacy")
        .unwrap()
        .clone();
    assert_eq!(
        (lp["current"].clone(), lp["offers"][0]["action"].clone()),
        (json!(true), json!("renew"))
    );
    let cp = shop["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "closed")
        .unwrap()
        .clone();
    assert_eq!(cp["offers"][0]["refusal"], "no_switch");
    let r = buy(&ch, closed, "month").await;
    assert_eq!(
        (r.status, r.json()["error"].clone()),
        (
            StatusCode::CONFLICT,
            json!("switching to this plan from another plan is not allowed")
        )
    );
    let r = buy(&ch, legacy, "month").await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(pay(&db, order_id(&r)).await, Paid::Now { fulfilled: true });
    // Newcomers may still buy the switch-closed plan.
    assert_eq!(buy(&cn, closed, "month").await.status, StatusCode::CREATED);
    drop(state);
    db.drop().await;
}

/// Plan speed limits reach the agent in every user op (protocol 4) and a
/// change of a user's effective limit bumps the user's nodes.
#[tokio::test]
async fn speed_limits_reach_the_desired_state() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (node, fast) = catalog_plan(&db, "fast", &[(PeriodKind::Month, None, 100)], |r| {
        r.speed_limit_mbps = Some(100)
    })
    .await;
    let user = db.user().await;
    let limit_of = |node: Uuid| {
        let pool = db.pool.clone();
        async move {
            crate::grpc::desired_snapshot(&pool, node)
                .await
                .unwrap()
                .unwrap()
                .users
                .iter()
                .find(|o| o.user_id == user.to_string())
                .map(|o| o.speed_limit_bytes_per_sec)
        }
    };
    let actor = crate::audit::Actor::test();
    let mut tx = db.pool.begin().await.unwrap();
    crate::plans::apply_set_user_plan(
        &mut tx,
        &actor,
        user,
        &crate::plans::SetUserPlanReq {
            plan_id: fast,
            expires_at: None,
            period_anchor: None,
            reset_traffic: None,
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(limit_of(node).await, Some(12_500_000));
    // A manual assignment elsewhere carries the user's plan limit too.
    let other = db.node().await;
    db.assign(other, user).await;
    assert_eq!(limit_of(other).await, Some(12_500_000));

    // Editing the plan's limit bumps every node of its users.
    let before = (db.versions(node).await, db.versions(other).await);
    let mut tx = db.pool.begin().await.unwrap();
    crate::plans::apply_update_plan(
        &mut tx,
        &actor,
        fast,
        &crate::plans::UpdatePlanReq {
            speed_limit_mbps: Some(Some(8)),
            ..Default::default()
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    assert_ne!(db.versions(node).await, before.0);
    assert_ne!(db.versions(other).await, before.1);
    assert_eq!(limit_of(node).await, Some(1_000_000));
    // A name-only edit bumps nothing.
    let before = db.versions(other).await;
    let mut tx = db.pool.begin().await.unwrap();
    crate::plans::apply_update_plan(
        &mut tx,
        &actor,
        fast,
        &crate::plans::UpdatePlanReq {
            name: Some(Some("fast2".into())),
            ..Default::default()
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(db.versions(other).await, before);

    // Cancelling the plan: the manual node now serves the user unlimited.
    let before = db.versions(other).await;
    let mut tx = db.pool.begin().await.unwrap();
    crate::plans::apply_cancel_user_plan(&mut tx, &actor, user)
        .await
        .ok()
        .unwrap();
    tx.commit().await.unwrap();
    assert_ne!(db.versions(other).await, before, "manual node bumped");
    assert_eq!(limit_of(other).await, Some(0));
    assert_eq!(limit_of(node).await, None, "plan access gone");

    // Switching between plans whose limits differ bumps shared nodes.
    let (_, slow) = catalog_plan(&db, "slow", &[(PeriodKind::Month, None, 100)], |r| {
        r.speed_limit_mbps = Some(2)
    })
    .await;
    let mut tx = db.pool.begin().await.unwrap();
    crate::plans::apply_set_user_plan(
        &mut tx,
        &actor,
        user,
        &crate::plans::SetUserPlanReq {
            plan_id: slow,
            expires_at: None,
            period_anchor: None,
            reset_traffic: None,
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(limit_of(other).await, Some(250_000));
    db.drop().await;
}

/// Admin plan API: catalogue fields round-trip, validation, PATCH null.
#[tokio::test]
async fn plan_catalogue_admin_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = db.admin().await;
    let a = user_client(&state, admin).await;
    let r = a
        .post(
            "/test/api/v1/plans",
            json!({ "name": "Pro", "period": "monthly", "description": "Fast\n- 100 Mbps\n- 5 devices",
                    "capacity": 10, "renewal_only": true, "allow_switch_in": false,
                    "speed_limit_mbps": 100 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let p = r.json();
    assert_eq!(p["description"], "Fast\n- 100 Mbps\n- 5 devices");
    assert_eq!(
        (
            p["capacity"].clone(),
            p["renewal_only"].clone(),
            p["allow_switch_in"].clone()
        ),
        (json!(10), json!(true), json!(false))
    );
    assert_eq!(
        (p["on_sale"].clone(), p["prices"].clone()),
        (json!(false), json!([]))
    );
    let id = p["id"].as_str().unwrap().to_string();
    let r = a
        .req(
            Method::PATCH,
            &format!("/test/api/v1/plans/{id}"),
            Some(json!({ "capacity": null, "renewal_only": false, "description": "x\r\ny" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        (
            r.json()["capacity"].clone(),
            r.json()["renewal_only"].clone(),
            r.json()["description"].clone()
        ),
        (Value::Null, json!(false), json!("x\ny"))
    );
    for bad in [
        json!({ "capacity": -1 }),
        json!({ "renewal_only": null }),
        json!({ "description": "bell\u{7}" }),
        json!({ "description": "x".repeat(4001) }),
        json!({ "speed_limit_mbps": 0 }),
        json!({ "speed_limit_mbps": 100001 }),
    ] {
        let r = a
            .req(
                Method::PATCH,
                &format!("/test/api/v1/plans/{id}"),
                Some(bad.clone()),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    drop(state);
    db.drop().await;
}

/// `end_order` (cancel / expiry) under gateway trouble: an unreachable
/// gateway leaves the order pending unless the close grace is exceeded
/// (force), where it ends with close_state "failed"; a close Alipay
/// refuses is retried later (not forced); an order another instance ended
/// meanwhile is reported as it is now, without a second event.
#[tokio::test]
async fn end_order_outages_and_races() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let (method, alipay) = method_of(&state);
    let (_, plan) = priced_plan(&db, "e", 300, 30).await;
    let actor = crate::audit::Actor::test();
    let pending = |id: Uuid, otn: &str| Pending {
        id,
        out_trade_no: otn.to_string(),
        amount_cents: 300,
        expires_at: chrono::Utc::now(),
        due: true,
        payment_method_id: Some(method),
    };
    let events = |id: Uuid| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM payment_events WHERE order_id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };

    // Gateway down: not forced -> still pending, nothing recorded.
    let (o1, otn1) = order_row(&db, db.user().await, plan, 300, 30).await;
    precreate(&*alipay, &otn1, 300).await;
    mock.set_down(true);
    let st = orders::end_order(
        &state,
        Some(&*alipay),
        &pending(o1, &otn1),
        "expired",
        &actor,
        false,
    )
    .await
    .unwrap();
    assert_eq!(st, "pending");
    assert_eq!(order_status(&db, o1).await.0, "pending");
    assert_eq!(events(o1).await, 0);
    // Forced (close grace exceeded): ends although the close failed.
    let st = orders::end_order(
        &state,
        Some(&*alipay),
        &pending(o1, &otn1),
        "expired",
        &actor,
        true,
    )
    .await
    .unwrap();
    assert_eq!(st, "expired");
    let cs: Option<String> = sqlx::query_scalar("SELECT close_state FROM orders WHERE id = $1")
        .bind(o1)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(cs.as_deref(), Some("failed"));
    assert_eq!(events(o1).await, 1);
    mock.set_down(false);

    // Alipay refuses the close (trade no longer closable, not paid): the
    // order stays pending for the next attempt.
    let (o2, otn2) = order_row(&db, db.user().await, plan, 300, 30).await;
    precreate(&*alipay, &otn2, 300).await;
    mock.inner
        .lock()
        .unwrap()
        .trades
        .get_mut(&otn2)
        .unwrap()
        .status = Some("TRADE_CLOSED".into());
    let st = orders::end_order(
        &state,
        Some(&*alipay),
        &pending(o2, &otn2),
        "cancelled",
        &actor,
        false,
    )
    .await
    .unwrap();
    assert_eq!(st, "pending");
    assert_eq!(order_status(&db, o2).await.0, "pending");

    // Ended by someone else between our query/close and the UPDATE.
    let (o3, otn3) = order_row(&db, db.user().await, plan, 300, 30).await;
    precreate(&*alipay, &otn3, 300).await;
    sqlx::query("UPDATE orders SET status = 'cancelled', ended_at = now() WHERE id = $1")
        .bind(o3)
        .execute(&db.pool)
        .await
        .unwrap();
    let st = orders::end_order(
        &state,
        Some(&*alipay),
        &pending(o3, &otn3),
        "expired",
        &actor,
        false,
    )
    .await
    .unwrap();
    assert_eq!(st, "cancelled");
    assert_eq!(events(o3).await, 0, "no event for an order we did not end");
    db.drop().await;
}

/// Junk notify events (unverified) older than the audit retention are
/// pruned; verified events are money records and stay; retention 0 keeps
/// everything.
#[tokio::test]
async fn prune_events_keeps_money_records() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let mut c = db.pool.acquire().await.unwrap();
    for (verified, outcome) in [(false, "old_junk"), (true, "old_paid"), (false, "new_junk")] {
        orders::record_event(
            &mut c,
            None,
            Some("x"),
            "notify",
            verified,
            outcome,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    }
    sqlx::query(
        "UPDATE payment_events SET created_at = now() - interval '400 days' \
         WHERE outcome IN ('old_junk', 'old_paid')",
    )
    .execute(&mut *c)
    .await
    .unwrap();
    drop(c);
    // A second instance with "keep forever" (only its own view reloads).
    let keep = AppState::for_test(db.pool.clone()).await;
    db.settings(&keep, "audit_retention_days = 0").await;
    db.settings(&state, "audit_retention_days = NULL").await;
    assert_eq!(orders::prune_events(&keep).await.unwrap(), 0);
    assert_eq!(orders::prune_events(&state).await.unwrap(), 1);
    let left: Vec<String> =
        sqlx::query_scalar("SELECT outcome FROM payment_events ORDER BY outcome")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(left, vec!["new_junk".to_string(), "old_paid".to_string()]);
    db.drop().await;
}

/// `PeriodKind::months` mirrors SQL `akari_period_end` (UTC calendar
/// months, month end clamped) for every calendar kind; days/onetime are
/// N x 24 h; the reset pack has no period end; a period kind outside the
/// catalog read back from TEXT is an error, not a default.
#[tokio::test]
async fn period_months_mirror_sql() {
    use super::catalog::{PeriodKind, PeriodKindText};
    use chrono::{DateTime, Months, TimeZone, Utc};
    let Some(db) = TestDb::new().await else {
        return;
    };
    let base = Utc.with_ymd_and_hms(2026, 1, 31, 12, 0, 0).unwrap();
    for k in PeriodKind::ALL {
        let days = (k.months().is_none() && k != PeriodKind::Reset).then_some(30);
        let end: Result<Option<DateTime<Utc>>, _> =
            sqlx::query_scalar("SELECT akari_period_end($1, $2, $3)")
                .bind(base)
                .bind(k.as_str())
                .bind(days)
                .fetch_one(&db.pool)
                .await;
        match (k, k.months()) {
            (_, Some(m)) => assert_eq!(
                end.unwrap(),
                base.checked_add_months(Months::new(m as u32)),
                "{k:?}"
            ),
            (PeriodKind::Reset, None) => assert!(end.is_err(), "reset has no period end"),
            (_, None) => assert_eq!(
                end.unwrap(),
                Some(base + chrono::Duration::days(30)),
                "{k:?}"
            ),
        }
        assert_eq!(PeriodKind::parse(k.as_str()), Some(k));
    }
    // 31 Jan + 1 month clamps to 28 Feb (2026 is not a leap year).
    assert_eq!(
        base.checked_add_months(Months::new(1)).unwrap(),
        Utc.with_ymd_and_hms(2026, 2, 28, 12, 0, 0).unwrap()
    );
    let e = PeriodKindText::try_from("fortnight".to_string()).unwrap_err();
    assert!(e.contains("fortnight"), "{e}");
    assert_eq!(
        PeriodKindText::try_from("year".to_string()).unwrap(),
        PeriodKindText(PeriodKind::Year)
    );
    db.drop().await;
}
mod ops;
mod w16;
mod w24;

/// W15: a paid order queues exactly one receipt (in the payment's
/// transaction; replays and concurrent duplicates add none), only to a
/// verified address and only while mail sending + receipts are enabled.
#[tokio::test]
async fn paid_order_queues_one_receipt() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (_, plan) = priced_plan(&db, "receipt", 990, 30).await;
    let user = db.user().await;
    let email = format!("r{}@example.com", &user.simple().to_string()[..10]);
    sqlx::query(
        "UPDATE users SET email = $2, email_verified_at = now(), locale = 'en' WHERE id = $1",
    )
    .bind(user)
    .bind(&email)
    .execute(&db.pool)
    .await
    .unwrap();
    let receipts = |db: &TestDb| {
        let pool = db.pool.clone();
        let email = email.clone();
        async move {
            sqlx::query_as::<_, (String, String)>(
                "SELECT subject, body_text FROM mail_outbox WHERE kind = 'order_paid' AND to_addr = $1",
            )
            .bind(&email)
            .fetch_all(&pool)
            .await
            .unwrap()
        }
    };
    // Mail off: paid, no receipt.
    let (o1, _) = order_row(&db, user, plan, 990, 30).await;
    assert!(matches!(pay(&db, o1).await, Paid::Now { fulfilled: true }));
    assert!(receipts(&db).await.is_empty());

    sqlx::query(
        "UPDATE smtp_settings SET enabled = true, host = '127.0.0.1', security = 'none', \
         from_addr = 'noreply@example.com'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let (o2, otn2) = order_row(&db, user, plan, 990, 30).await;
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let pool = db.pool.clone();
        tasks.push(tokio::spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            let r = orders::apply_mark_paid(
                &mut tx,
                &orders::payment_actor(None),
                o2,
                Via::Notify,
                Some("T"),
                None,
                None,
            )
            .await
            .ok()
            .unwrap();
            tx.commit().await.unwrap();
            matches!(r, Paid::Now { .. })
        }));
    }
    let mut now = 0;
    for t in tasks {
        now += t.await.unwrap() as i32;
    }
    assert_eq!(now, 1);
    let r = receipts(&db).await;
    assert_eq!(r.len(), 1, "exactly one receipt");
    assert!(r[0].0.contains("payment received"), "{:?}", r[0]);
    assert!(
        r[0].1.contains(&otn2) && r[0].1.contains("CNY 9.90"),
        "{}",
        r[0].1
    );

    // Receipts toggled off, or an unverified address: none.
    sqlx::query("UPDATE smtp_settings SET notify_order_paid = false")
        .execute(&db.pool)
        .await
        .unwrap();
    let (o3, _) = order_row(&db, user, plan, 990, 30).await;
    pay(&db, o3).await;
    sqlx::query("UPDATE smtp_settings SET notify_order_paid = true")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET email_verified_at = NULL WHERE id = $1")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    let (o4, _) = order_row(&db, user, plan, 990, 30).await;
    assert!(matches!(pay(&db, o4).await, Paid::Now { .. }));
    assert_eq!(receipts(&db).await.len(), 1);
    db.drop().await;
}
