//! Billing tests: a mock Alipay gateway (local axum server that verifies
//! the panel's request signatures and signs its answers with a throwaway
//! "Alipay" key), real-DB fulfilment/idempotency/expiry tests and the HTTP
//! surface including the notify endpoint's canonical rejections.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use axum::http::{Method, StatusCode};
use serde_json::{json, Value};
use uuid::Uuid;

use super::alipay::tests::{alipay_side_keys, panel_keys, sign_notify, signed_response};
use super::alipay::{self, Alipay};
use super::orders::{self, Paid, Pending, Via};
use crate::config::AlipayConfig;
use crate::state::AppState;
use crate::testdb::http::{rand_ip, Client};
use crate::testdb::TestDb;

const APP_ID: &str = "2021000000000001";
const SELLER_ID: &str = "2088000000000001";

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
            assert!(p.contains_key("notify_url"));
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

fn alipay_cfg(gateway: &str) -> AlipayConfig {
    AlipayConfig {
        enabled: true,
        app_id: APP_ID.into(),
        seller_id: SELLER_ID.into(),
        gateway_url: gateway.into(),
        notify_url: "https://panel.example/test/pay/alipay/notify".into(),
        order_timeout_minutes: 15,
        ..Default::default()
    }
}

async fn paid_state(db: &TestDb, mock: &Mock) -> AppState {
    let state = AppState::for_test(db.pool.clone()).await;
    state.set_alipay(Alipay::new(&alipay_cfg(&mock.url), panel_keys()));
    state
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
        },
    )
    .await
    .ok()
    .unwrap();
    super::api::apply_set_price(
        &mut tx,
        &actor,
        p,
        &super::api::SetPriceReq {
            price_cents: cents,
            period_days: days,
            purchasable: true,
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
         amount_cents, period_days, subject, expires_at) \
         VALUES ($1, $2, $3, 'u', $4, 'p', $5, $6, 's', now() + interval '15 minutes')",
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
    let mut req = axum::http::Request::builder()
        .method(Method::POST)
        .uri("/test/pay/alipay/notify")
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
    assert_eq!(shop["plans"][0]["price_cents"], 990);
    assert_eq!(shop["plans"][0]["action"], "new");

    // Client-side amounts do not exist: unknown fields are refused.
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "amount_cents": 1 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": Uuid::new_v4() }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    let r = c
        .post("/test/api/v1/me/orders", json!({ "plan_id": plan }))
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let o = r.json();
    let oid: Uuid = o["id"].as_str().unwrap().parse().unwrap();
    let otn = o["out_trade_no"].as_str().unwrap().to_string();
    assert_eq!(o["amount_cents"], 990);
    assert_eq!(o["status"], "pending");
    assert!(o["qr_code"]
        .as_str()
        .unwrap()
        .starts_with("https://qr.alipay.com/"));
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
    assert_eq!(r.json()["plans"][0]["action"], "renew");

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
    assert!(events
        .iter()
        .all(|e| e["params"]["sign"].is_null() || e["params"]["sign"] == "<redacted>"));
    // Users cannot reach admin endpoints.
    assert_eq!(
        c.get("/test/api/v1/orders").await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        a.post("/test/api/v1/me/orders", json!({ "plan_id": plan }))
            .await
            .status,
        StatusCode::BAD_REQUEST,
        "admins cannot buy"
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
    let canonical2 = Client::new(&state, rand_ip())
        .get("/test/pay/alipay/notify")
        .await
        .fingerprint();
    assert_eq!(canonical, canonical2, "GET on the notify route");

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
    let alipay = state.alipay().unwrap().clone();
    let body = form(&notify_params(&otn, "12.00", "TRADE_SUCCESS"));
    let pending = Pending {
        id: oid,
        out_trade_no: otn.clone(),
        amount_cents: 1200,
        expires_at: chrono::Utc::now(),
        due: false,
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
                super::api::handle_notify(&state, &alipay, None, &body)
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
    let pp = format!("/test/api/v1/plans/{plan}/price");
    for body in [
        json!({ "price_cents": 0, "period_days": 30, "purchasable": true }),
        json!({ "price_cents": 100, "period_days": 0, "purchasable": true }),
        json!({ "price_cents": 1.5, "period_days": 30, "purchasable": true }),
        json!({ "price_cents": 100, "period_days": 30 }),
    ] {
        let r = a.req(Method::PUT, &pp, Some(body.clone())).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
    }
    let r = a
        .req(
            Method::PUT,
            &pp,
            Some(json!({ "price_cents": 1, "period_days": 7, "purchasable": false })),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = a.get("/test/api/v1/plan-prices").await;
    assert_eq!(r.json()["payments_enabled"], true);
    assert_eq!(r.json()["prices"][0]["price_cents"], 1);
    assert_eq!(
        a.req(Method::DELETE, &pp, None).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        a.req(Method::DELETE, &pp, None).await.status,
        StatusCode::NOT_FOUND
    );
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
    let alipay = state.alipay().unwrap().clone();
    let (_, plan) = priced_plan(&db, "p", 300, 30).await;
    let u1 = db.user().await;
    let u2 = db.user().await;
    let u3 = db.user().await;
    let (expiring, otn1) = order_row(&db, u1, plan, 300, 30).await;
    let (late, otn2) = order_row(&db, u2, plan, 300, 30).await;
    let (fresh, otn3) = order_row(&db, u3, plan, 300, 30).await;
    for otn in [&otn1, &otn2, &otn3] {
        alipay.precreate(otn, 300, "s").await.unwrap();
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
    orders::reconcile_tick(&state, &alipay).await.ok().unwrap();
    for id in [expiring, late, fresh] {
        assert_eq!(order_status(&db, id).await.0, "pending");
    }
    mock.set_down(false);
    sqlx::query("UPDATE orders SET last_query_at = NULL")
        .execute(&db.pool)
        .await
        .unwrap();
    orders::reconcile_tick(&state, &alipay).await.ok().unwrap();
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
    orders::reconcile_tick(&state, &alipay).await.ok().unwrap();
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
    alipay.precreate(&otn4, 300, "s").await.unwrap();
    mock.pay(&otn4);
    mock.inner.lock().unwrap().total_override = Some("0.01".into());
    orders::poll(&state, &alipay, o4).await.ok().unwrap();
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
        .post("/test/api/v1/me/orders", json!({ "plan_id": plan }))
        .await
        .json();
    let r2 = c
        .post("/test/api/v1/me/orders", json!({ "plan_id": plan }))
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
        .post("/test/api/v1/me/orders", json!({ "plan_id": plan }))
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

#[test]
fn config_validation() {
    let mut c = crate::config::PanelConfig::default();
    assert!(c.validate().errors.is_empty(), "disabled by default");
    c.payments.alipay = AlipayConfig {
        enabled: true,
        app_id: APP_ID.into(),
        app_private_key_file: "/k".into(),
        alipay_public_key_file: "/p".into(),
        notify_url: "https://panel.example/abc/pay/alipay/notify".into(),
        ..Default::default()
    };
    assert!(c.validate().errors.is_empty(), "{:?}", c.validate().errors);
    for (mutate, want) in [
        (
            Box::new(|a: &mut AlipayConfig| a.app_id = "x1".into())
                as Box<dyn Fn(&mut AlipayConfig)>,
            "app_id",
        ),
        (
            Box::new(|a| a.gateway_url = "http://openapi.alipay.com/gateway.do".into()),
            "gateway_url",
        ),
        (
            Box::new(|a| a.notify_url = "https://h/abc/pay/alipay/notify?x=1".into()),
            "notify_url",
        ),
        (
            Box::new(|a| a.notify_url = "https://h/pay/alipay/notify".into()),
            "notify_url",
        ),
        (Box::new(|a| a.notify_url = String::new()), "notify_url"),
        (
            Box::new(|a| a.order_timeout_minutes = 1),
            "order_timeout_minutes",
        ),
        (Box::new(|a| a.seller_id = "abc".into()), "seller_id"),
        (
            Box::new(|a| a.app_private_key_file = "".into()),
            "app_private_key_file",
        ),
    ] {
        let mut c2 = c.clone();
        mutate(&mut c2.payments.alipay);
        let errs = c2.validate().errors;
        assert!(errs.iter().any(|e| e.contains(want)), "{want}: {errs:?}");
        assert!(
            errs.iter().all(|e| !e.contains("abc/pay")),
            "notify_url echoed: {errs:?}"
        );
    }
    let mut c2 = c.clone();
    c2.payments.alipay.gateway_url = "http://127.0.0.1:9/gateway.do".into();
    c2.payments.alipay.notify_url = "http://myapp.test:8080/abc/pay/alipay/notify".into();
    let r = c2.validate();
    assert!(r.errors.is_empty() && r.warnings.len() >= 2, "{r:?}");
    let t = c.effective_toml().unwrap();
    assert!(!t.contains("/abc/"), "notify_url (prefix) redacted: {t}");
    // The prefix must match the install's.
    assert!(super::check_notify_prefix(&c, "abc").is_ok());
    assert!(super::check_notify_prefix(&c, "other").is_err());
}

#[test]
fn key_file_mode_is_enforced() {
    let dir = std::env::temp_dir().join(format!("akari-billing-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let key = dir.join("app.pem");
    let public = dir.join("alipay.pem");
    std::fs::write(&key, super::alipay::tests::APP_KEY).unwrap();
    std::fs::write(&public, super::alipay::tests::ALIPAY_PUB).unwrap();
    let mut cfg = alipay_cfg("https://openapi.alipay.com/gateway.do");
    cfg.app_private_key_file = key.clone();
    cfg.alipay_public_key_file = public;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        let e = Alipay::from_config(&cfg).unwrap_err();
        assert!(e.contains("permissions"), "{e}");
        assert!(!e.contains("BEGIN"), "no key material in errors");
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let a = Alipay::from_config(&cfg).unwrap();
    assert!(!format!("{a:?}").contains("BEGIN"));
    std::fs::remove_dir_all(&dir).unwrap();
}
