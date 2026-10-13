//! C1 tests: 易支付 (EPay) against a local mock gateway (axum: `mapi.php`
//! checks the panel's MD5 signature and records the trade, `api.php`
//! answers order queries after checking the key) and a real database:
//! the admin API (secrets sealed, never returned), the HTTP purchase flow
//! (API mode → payment link, notify by GET and POST, replay, every refusal
//! canonical with its event), concurrency (notifies and queries fulfil
//! exactly once), the page-mode fallback, QR answers, polling through the
//! query, expiry without a close call and the late notify that still
//! fulfils, 测试连接, isolation from an Alipay method on the same panel.

use std::collections::{BTreeMap, HashMap};

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::super::epay::tests::{KEY, PID, query_string, signed_notify};
use super::super::epay::{self, sign};
use super::super::methods as pm;
use super::*;

const BASE: &str = "/test/api/v1/settings/payments";

// ---------------------------------------------------------------------------
// Mock EPay gateway
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Answer {
    PayUrl,
    Qr,
    Refuse,
    Down,
}

#[derive(Debug)]
struct EInner {
    /// out_trade_no → (money, paid).
    trades: HashMap<String, (String, bool)>,
    /// Every mapi.php request (decoded).
    mapi: Vec<BTreeMap<String, String>>,
    queries: usize,
    answer: Answer,
    /// Report this money instead of the trade's (tampering).
    money_override: Option<String>,
}

#[derive(Clone)]
struct EMock {
    inner: Arc<Mutex<EInner>>,
    /// The interface address (`…/`).
    url: String,
}

impl EMock {
    async fn start() -> Self {
        let inner = Arc::new(Mutex::new(EInner {
            trades: HashMap::new(),
            mapi: Vec::new(),
            queries: 0,
            answer: Answer::PayUrl,
            money_override: None,
        }));
        let app = axum::Router::new()
            .route("/epay/mapi.php", axum::routing::post(mapi))
            .route("/epay/api.php", axum::routing::get(api))
            .with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            inner,
            url: format!("http://{addr}/epay/"),
        }
    }
    fn pay(&self, otn: &str) {
        self.inner.lock().unwrap().trades.get_mut(otn).unwrap().1 = true;
    }
    fn answer(&self, a: Answer) {
        self.inner.lock().unwrap().answer = a;
    }
    fn mapi(&self) -> Vec<BTreeMap<String, String>> {
        self.inner.lock().unwrap().mapi.clone()
    }
    fn queries(&self) -> usize {
        self.inner.lock().unwrap().queries
    }
}

async fn mapi(
    axum::extract::State(inner): axum::extract::State<Arc<Mutex<EInner>>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let p: BTreeMap<String, String> = form_urlencoded::parse(&body).into_owned().collect();
    // The panel's request is signed with the merchant key.
    assert!(epay::verify(&p, KEY), "panel request signature: {p:?}");
    assert_eq!(p["pid"], PID);
    let mut g = inner.lock().unwrap();
    g.mapi.push(p.clone());
    let otn = p["out_trade_no"].clone();
    match g.answer {
        Answer::Down => return (StatusCode::SERVICE_UNAVAILABLE, "down").into_response(),
        Answer::Refuse => {
            return axum::Json(json!({"code": -1, "msg": "API接口未开启"})).into_response();
        }
        _ => {}
    }
    g.trades.insert(otn.clone(), (p["money"].clone(), false));
    let link = if g.answer == Answer::Qr {
        json!({"code": 1, "trade_no": format!("T{otn}"), "qrcode": format!("https://qr.alipay.com/{otn}")})
    } else {
        json!({"code": 1, "trade_no": format!("T{otn}"), "payurl": format!("https://pay.example/cashier/{otn}")})
    };
    axum::Json(link).into_response()
}

async fn api(
    axum::extract::State(inner): axum::extract::State<Arc<Mutex<EInner>>>,
    axum::extract::Query(q): axum::extract::Query<BTreeMap<String, String>>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let mut g = inner.lock().unwrap();
    g.queries += 1;
    if g.answer == Answer::Down {
        return (StatusCode::SERVICE_UNAVAILABLE, "down").into_response();
    }
    assert_eq!(q.get("act").map(String::as_str), Some("order"));
    if q.get("pid").map(String::as_str) != Some(PID) {
        return axum::Json(json!({"code": -3, "msg": "商户ID不存在"})).into_response();
    }
    if q.get("key").map(String::as_str) != Some(KEY) {
        return axum::Json(json!({"code": -3, "msg": "KEY校验失败"})).into_response();
    }
    let otn = q["out_trade_no"].clone();
    match g.trades.get(&otn) {
        None => axum::Json(json!({"code": -1, "msg": "订单编号不存在"})).into_response(),
        Some((money, paid)) => axum::Json(json!({
            "code": 1, "msg": "查询订单号成功！", "trade_no": format!("T{otn}"),
            "out_trade_no": otn, "type": "alipay", "pid": PID.parse::<i64>().unwrap(),
            "money": g.money_override.clone().unwrap_or_else(|| money.clone()),
            "status": i32::from(*paid),
        }))
        .into_response(),
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn epay_config(api_url: &str, mode: &str) -> Value {
    json!({
        "api_url": api_url, "pid": PID, "key": KEY, "channel": "alipay",
        "api_mode": mode, "order_timeout_minutes": 15,
    })
}

/// Add an enabled EPay method (DB + this instance reload).
async fn add_epay(state: &AppState, api_url: &str, mode: &str, name: &str) -> Uuid {
    let mut tx = state.pg().begin().await.unwrap();
    let row = pm::apply_create(
        &mut tx,
        state.master_key(),
        &crate::audit::Actor::test(),
        "payment_method.create",
        &pm::MethodReq {
            kind: Some(epay::KIND.into()),
            version: None,
            display_name: name.into(),
            icon: None,
            sort: 0,
            enabled: true,
            config: epay_config(api_url, mode),
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    crate::settings::reload(state).await.unwrap();
    row.id
}

/// A panel with the main domain ORIGIN and one EPay method.
async fn epay_state(db: &TestDb, mock: &EMock, mode: &str) -> (AppState, Uuid) {
    let state = AppState::for_test(db.pool.clone()).await;
    main_domain(db, &state).await;
    let m = add_epay(&state, &mock.url, mode, "支付宝（易支付）").await;
    (state, m)
}

/// A GET notify (query string) through the full router.
async fn get_notify(state: &AppState, method: Uuid, query: &str) -> crate::testdb::http::Resp {
    let path = if query.is_empty() {
        format!("/pay/{method}/notify")
    } else {
        format!("/pay/{method}/notify?{query}")
    };
    Client::new(state, rand_ip()).get(&path).await
}

/// The newest notify event's outcome for an out_trade_no.
async fn last_outcome(db: &TestDb, otn: &str) -> String {
    sqlx::query_scalar(
        "SELECT outcome FROM payment_events WHERE out_trade_no = $1 AND source = 'notify' \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(otn)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

/// A notify signed with another merchant's pid (same key).
fn notify_of_pid(pid: &str, otn: &str, money: &str) -> BTreeMap<String, String> {
    let mut p = signed_notify(otn, money, "TRADE_SUCCESS");
    p.insert("pid".into(), pid.into());
    p.remove("sign");
    let s = sign(&p, KEY);
    p.insert("sign".into(), s);
    p
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// 系统设置 → 支付 with an EPay method: coded validation, the key sealed and
/// never returned or audited, the portal's icon from the channel, 测试连接.
#[tokio::test]
async fn epay_methods_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = EMock::start().await;
    let state = AppState::for_test(db.pool.clone()).await;
    main_domain(&db, &state).await;
    let c = user_client(&state, db.owner().await).await;
    let kinds = c.get(BASE).await.json()["kinds"].clone();
    assert!(kinds.as_array().unwrap().iter().any(|k| k["id"] == "epay"));
    let body = |config: Value| json!({"kind": "epay", "display_name": "微信支付（易支付）", "enabled": true, "config": config});
    let r = c
        .post(
            BASE,
            body(json!({"api_url": "http://pay.example.com/", "pid": PID, "key": KEY})),
        )
        .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("payments.epay_url_invalid"))
    );
    let r = c
        .post(BASE, body(json!({"api_url": mock.url, "pid": PID})))
        .await;
    assert_eq!(r.json()["code"], "payments.incomplete");
    let mut cfg = epay_config(&mock.url, "mapi");
    cfg["channel"] = json!("wxpay");
    let r = c.post(BASE, body(cfg)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let v = r.json();
    let id: Uuid = v["id"].as_str().unwrap().parse().unwrap();
    assert!(
        !String::from_utf8_lossy(&r.body).contains(KEY),
        "key in the view"
    );
    assert_eq!(v["config"]["key_set"], true);
    assert_eq!(v["config"]["key_fingerprint"], epay::key_fingerprint(KEY));
    assert_eq!(v["notify_url"], format!("{ORIGIN}/pay/{id}/notify"));
    assert_eq!(v["kind_label"], "易支付");
    assert!(v["active"].as_bool().unwrap());
    // Sealed at rest (AAD = id), audited as "changed" only.
    let enc: Vec<u8> = sqlx::query_scalar("SELECT secrets_enc FROM payment_methods WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(!enc.windows(KEY.len()).any(|w| w == KEY.as_bytes()));
    let audit: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'payment_method.create' AND target_id = $1",
    )
    .bind(id.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(!audit.to_string().contains(KEY));
    assert!(audit.to_string().contains("changed"));
    // The portal shows the channel's icon.
    let shop = user_client(&state, db.user().await)
        .await
        .get("/test/api/v1/me/shop")
        .await
        .json();
    assert_eq!(shop["methods"][0]["icon"], "wechat");
    assert_eq!(shop["methods"][0]["kind"], "epay");
    // 测试连接: the query of an order that cannot exist proves pid + key.
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(
        (t["ok"].clone(), t["result"].clone()),
        (json!(true), json!("keys_ok"))
    );
    // Edit without the key keeps it; a wrong key fails the test.
    let ver: i64 = sqlx::query_scalar("SELECT version FROM payment_methods WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let mut cfg = epay_config(&mock.url, "submit");
    cfg["key"] = json!("wrong-key-0000");
    let r = c
        .put(
            &format!("{BASE}/{id}"),
            json!({"version": ver, "display_name": "易支付", "enabled": true, "config": cfg}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["config"]["api_mode"], "submit");
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(
        (t["ok"].clone(), t["result"].clone()),
        (json!(false), json!("key_rejected"))
    );
    drop(state);
    db.drop().await;
}

/// The whole journey over HTTP in API mode: order → mapi (signed, client
/// address, return and notify URLs) → payment link → every bad notify is
/// the canonical rejection with its event → a GET notify pays and fulfils
/// → replays (GET and POST) are no-ops.
#[tokio::test]
async fn epay_purchase_flow() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = EMock::start().await;
    let (state, method) = epay_state(&db, &mock, "mapi").await;
    let (_, plan) = priced_plan(&db, "epay", 990, 30).await;
    let user = db.user().await;
    let c = user_client(&state, user).await;
    let r = buy(&c, plan, "days").await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let order = order_id(&r);
    let otn = r.json()["out_trade_no"].as_str().unwrap().to_string();
    assert_eq!(
        r.json()["pay_url"],
        format!("https://pay.example/cashier/{otn}")
    );
    assert!(r.json()["qr_code"].is_null());
    let sent = mock.mapi().pop().unwrap();
    assert_eq!(sent["money"], "9.90");
    assert_eq!(sent["type"], "alipay");
    assert_eq!(sent["clientip"], c.ip.to_string());
    assert_eq!(sent["notify_url"], format!("{ORIGIN}/pay/{method}/notify"));
    assert_eq!(sent["return_url"], format!("{ORIGIN}/orders/{order}"));
    assert_eq!(sent["name"], "Akari - epay");

    let canonical = c.get("/test/not/here").await.fingerprint();
    // Tampered amount (signature broken).
    let mut t = signed_notify(&otn, "9.90", "TRADE_SUCCESS");
    t.insert("money".into(), "0.01".into());
    assert_eq!(
        get_notify(&state, method, &query_string(&t))
            .await
            .fingerprint(),
        canonical
    );
    assert_eq!(last_outcome(&db, &otn).await, "bad_signature");
    // Validly signed, wrong amount.
    let q = query_string(&signed_notify(&otn, "0.01", "TRADE_SUCCESS"));
    assert_eq!(
        get_notify(&state, method, &q).await.fingerprint(),
        canonical
    );
    assert_eq!(last_outcome(&db, &otn).await, "amount_mismatch");
    // Another merchant (same key, different pid).
    let q = query_string(&notify_of_pid("2002", &otn, "9.90"));
    assert_eq!(
        get_notify(&state, method, &q).await.fingerprint(),
        canonical
    );
    assert_eq!(last_outcome(&db, &otn).await, "pid_mismatch");
    // Unknown order; empty query; junk method ids.
    let q = query_string(&signed_notify("AKnope", "9.90", "TRADE_SUCCESS"));
    assert_eq!(
        get_notify(&state, method, &q).await.fingerprint(),
        canonical
    );
    assert_eq!(last_outcome(&db, "AKnope").await, "unknown_order");
    assert_eq!(
        get_notify(&state, method, "").await.fingerprint(),
        canonical
    );
    let good = query_string(&signed_notify(&otn, "9.90", "TRADE_SUCCESS"));
    for p in [
        format!("/pay/nope/notify?{good}"),
        format!("/pay/{}/notify?{good}", Uuid::new_v4()),
    ] {
        assert_eq!(c.get(&p).await.fingerprint(), canonical, "{p}");
    }
    // The audit records the refusals of a known order.
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM audit_log WHERE action = 'order.payment.rejected' AND target_id = $1::text",
            order
        )
        .await,
        2
    );
    assert_eq!(order_status(&db, order).await.0, "pending");
    // A pending notify is acknowledged and ignored.
    let q = query_string(&signed_notify(&otn, "9.90", "WAIT_BUYER_PAY"));
    let r = get_notify(&state, method, &q).await;
    assert_eq!(
        (r.status, r.body.as_slice()),
        (StatusCode::OK, &b"success"[..])
    );
    assert_eq!(last_outcome(&db, &otn).await, "ignored");
    assert_eq!(order_status(&db, order).await.0, "pending");
    // The real one.
    let r = get_notify(&state, method, &good).await;
    assert_eq!(
        (r.status, r.body.as_slice()),
        (StatusCode::OK, &b"success"[..])
    );
    assert_eq!(order_status(&db, order).await, ("paid".into(), true, None));
    assert_eq!(active_plan(&db, user).await.map(|p| p.0), Some(plan));
    let (via, trade): (String, Option<String>) =
        sqlx::query_as("SELECT paid_via, trade_no FROM orders WHERE id = $1")
            .bind(order)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        (via.as_str(), trade.as_deref()),
        ("notify", Some("2026101312000012345"))
    );
    // Replays: GET and the POST form EPay variants use.
    let r = get_notify(&state, method, &good).await;
    assert_eq!(r.body, b"success");
    let r = Client::new(&state, rand_ip())
        .post_raw(
            &format!("/pay/{method}/notify"),
            "application/x-www-form-urlencoded",
            good.clone().into_bytes(),
        )
        .await;
    assert_eq!(r.body, b"success");
    assert_eq!(last_outcome(&db, &otn).await, "duplicate");
    for (sql, want) in [
        (
            "SELECT count(*) FROM audit_log WHERE action = 'order.paid' AND target_id = $1::text",
            1,
        ),
        (
            "SELECT count(*) FROM payment_events WHERE order_id = $1 AND outcome = 'paid'",
            1,
        ),
        (
            "SELECT count(*) FROM payment_events WHERE order_id = $1 \
             AND params->>'sign' IS NOT NULL AND params->>'sign' <> '<redacted>'",
            0,
        ),
    ] {
        assert_eq!(count(&db, sql, order).await, want, "{sql}");
    }
    drop(state);
    db.drop().await;
}

/// Concurrent duplicate notifies (GET bodies) plus concurrent queries for
/// one payment fulfil exactly once.
#[tokio::test]
async fn epay_concurrent_notifies_fulfil_once() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = EMock::start().await;
    let (state, method) = epay_state(&db, &mock, "mapi").await;
    let (_, plan) = priced_plan(&db, "p", 1200, 30).await;
    let user = db.user().await;
    let (oid, otn) = order_row(&db, user, plan, 1200, 30).await;
    mock.inner
        .lock()
        .unwrap()
        .trades
        .insert(otn.clone(), ("12.00".into(), true));
    let p = state.payments().provider(method).unwrap();
    let body = query_string(&signed_notify(&otn, "12.00", "TRADE_SUCCESS"));
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
        let (state, p, body, pending) = (state.clone(), p.clone(), body.clone(), pending.clone());
        tasks.push(tokio::spawn(async move {
            if i % 3 == 0 {
                let q = p.query(&pending.out_trade_no).await.unwrap();
                orders::apply_query_result(&state, &pending, &q, "query")
                    .await
                    .unwrap()
            } else {
                super::super::api::handle_notify(&state, &*p, method, None, body.as_bytes())
                    .await
                    .unwrap()
            }
        }));
    }
    for t in tasks {
        assert!(t.await.unwrap());
    }
    assert_eq!(order_status(&db, oid).await, ("paid".into(), true, None));
    for sql in [
        "SELECT count(*) FROM audit_log WHERE action = 'order.paid' AND target_id = $1::text",
        "SELECT count(*) FROM payment_events WHERE order_id = $1 AND outcome = 'paid'",
    ] {
        assert_eq!(count(&db, sql, oid).await, 1, "{sql}");
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
    drop(state);
    db.drop().await;
}

/// The page mode and the API mode's fallbacks; a QR answer; the active
/// query (polling) pays only the exact amount; a gateway that is down
/// cancels the new order.
#[tokio::test]
async fn epay_modes_query_and_outages() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = EMock::start().await;
    let (state, _) = epay_state(&db, &mock, "mapi").await;
    let (_, plan) = priced_plan(&db, "m", 500, 30).await;
    let buyer = db.user().await;
    let c = user_client(&state, buyer).await;
    // Refused in API mode → the signed submit.php link.
    mock.answer(Answer::Refuse);
    let r = buy(&c, plan, "days").await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let link = r.json()["pay_url"].as_str().unwrap().to_string();
    let prefix = format!("{}submit.php?", mock.url);
    let params: BTreeMap<String, String> = form_urlencoded::parse(
        link.strip_prefix(&prefix)
            .unwrap_or_else(|| panic!("{link}"))
            .as_bytes(),
    )
    .into_owned()
    .collect();
    assert!(epay::verify(&params, KEY));
    assert_eq!(params["money"], "5.00");
    assert!(!params.contains_key("clientip"));
    // A QR answer (the next order ends the open one: query → not paid →
    // nothing to close → cancelled).
    mock.answer(Answer::Qr);
    let r = buy(&c, plan, "days").await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let (o2, otn2) = (
        order_id(&r),
        r.json()["out_trade_no"].as_str().unwrap().to_string(),
    );
    assert_eq!(r.json()["qr_code"], format!("https://qr.alipay.com/{otn2}"));
    let closes: Vec<String> = sqlx::query_scalar(
        "SELECT close_state FROM orders WHERE status = 'cancelled' AND close_state IS NOT NULL",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(closes, ["not_closable"]);
    // Polling: a different amount is refused; the exact amount pays.
    mock.pay(&otn2);
    mock.inner.lock().unwrap().money_override = Some("0.50".into());
    let before = mock.queries();
    c.get(&format!("/test/api/v1/me/orders/{o2}")).await;
    assert!(mock.queries() > before);
    assert_eq!(order_status(&db, o2).await.0, "pending");
    let ev: String = sqlx::query_scalar(
        "SELECT outcome FROM payment_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(o2)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(ev, "amount_mismatch");
    mock.inner.lock().unwrap().money_override = None;
    sqlx::query("UPDATE orders SET last_query_at = NULL WHERE id = $1")
        .bind(o2)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c.get(&format!("/test/api/v1/me/orders/{o2}")).await;
    assert_eq!(r.json()["status"], "paid", "{:?}", r.json());
    let via: String = sqlx::query_scalar("SELECT paid_via FROM orders WHERE id = $1")
        .bind(o2)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(via, "query");
    // The gateway down: no order is left pending, the payer gets a 502 (order.gateway_unavailable).
    mock.answer(Answer::Down);
    let r = buy(&c, plan, "days").await;
    assert_eq!(r.status, StatusCode::BAD_GATEWAY, "{:?}", r.json());
    assert_eq!(r.json()["code"], "order.gateway_unavailable");
    // A query retries a failing gateway (3 attempts), then reports it.
    let before = mock.queries();
    let p = state
        .payments()
        .usable()
        .next()
        .unwrap()
        .provider
        .clone()
        .unwrap();
    assert!(matches!(
        p.query("AKx").await,
        Err(super::super::provider::CallError::Status(503))
    ));
    assert_eq!(mock.queries(), before + 3);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM orders WHERE user_id = $1 AND close_state = 'precreate_failed'",
            buyer
        )
        .await,
        1
    );
    // Page mode never calls mapi.php.
    let calls = mock.mapi().len();
    let page = add_epay(&state, &mock.url, "submit", "易支付页面").await;
    let other = user_client(&state, db.user().await).await;
    let r = other
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days", "method_id": page }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert!(r.json()["pay_url"].as_str().unwrap().starts_with(&prefix));
    assert_eq!(mock.mapi().len(), calls);
    drop(state);
    db.drop().await;
}

/// Expiry without a close call (`not_closable`), then a late notify: the
/// expired order is still paid and fulfilled (money is never lost).
#[tokio::test]
async fn epay_late_notify_after_expiry_fulfils() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = EMock::start().await;
    let (state, method) = epay_state(&db, &mock, "mapi").await;
    let (_, plan) = priced_plan(&db, "late", 700, 30).await;
    let user = db.user().await;
    let (oid, otn) = order_row(&db, user, plan, 700, 30).await;
    mock.inner
        .lock()
        .unwrap()
        .trades
        .insert(otn.clone(), ("7.00".into(), false));
    sqlx::query("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1")
        .bind(oid)
        .execute(&db.pool)
        .await
        .unwrap();
    orders::reconcile_tick(&state).await.ok().unwrap();
    let (status, close): (String, Option<String>) =
        sqlx::query_as("SELECT status, close_state FROM orders WHERE id = $1")
            .bind(oid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        (status.as_str(), close.as_deref()),
        ("expired", Some("not_closable"))
    );
    let q = query_string(&signed_notify(&otn, "7.00", "TRADE_SUCCESS"));
    let r = get_notify(&state, method, &q).await;
    assert_eq!(r.body, b"success");
    assert_eq!(order_status(&db, oid).await, ("paid".into(), true, None));
    assert_eq!(active_plan(&db, user).await.map(|p| p.0), Some(plan));
    drop(state);
    db.drop().await;
}

/// An EPay method next to an Alipay method: a GET notify is refused for
/// Alipay, EPay's notify for the Alipay order is an unknown order, and
/// both methods are offered.
#[tokio::test]
async fn epay_and_alipay_are_isolated() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (mock, ali) = (EMock::start().await, Mock::start().await);
    let (state, method) = epay_state(&db, &mock, "mapi").await;
    let alipay = add_method(&state, &ali.url, "支付宝").await;
    let (_, plan) = priced_plan(&db, "iso", 500, 30).await;
    let c = user_client(&state, db.user().await).await;
    assert_eq!(
        c.get("/test/api/v1/me/shop").await.json()["methods"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let r = c
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days", "method_id": alipay }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let (oid, otn) = (
        order_id(&r),
        r.json()["out_trade_no"].as_str().unwrap().to_string(),
    );
    let canonical = c.get("/test/not/here").await.fingerprint();
    // EPay's (valid) notify for the Alipay order.
    let q = query_string(&signed_notify(&otn, "5.00", "TRADE_SUCCESS"));
    assert_eq!(
        get_notify(&state, method, &q).await.fingerprint(),
        canonical
    );
    assert_eq!(last_outcome(&db, &otn).await, "unknown_order");
    // A GET on the Alipay method's route: refused before any processing.
    let ali_q = String::from_utf8(form(&notify_params(&otn, "5.00", "TRADE_SUCCESS"))).unwrap();
    assert_eq!(
        get_notify(&state, alipay, &ali_q).await.fingerprint(),
        canonical
    );
    assert_eq!(order_status(&db, oid).await.0, "pending");
    // The Alipay notify by POST still works.
    let r = post_notify_to_method(&state, alipay, ali_q.into_bytes()).await;
    assert_eq!(r.body, b"success");
    assert_eq!(order_status(&db, oid).await.0, "paid");
    drop(state);
    db.drop().await;
}

async fn post_notify_to_method(
    state: &AppState,
    method: Uuid,
    body: Vec<u8>,
) -> crate::testdb::http::Resp {
    Client::new(state, rand_ip())
        .post_raw(
            &format!("/pay/{method}/notify"),
            "application/x-www-form-urlencoded; charset=utf-8",
            body,
        )
        .await
}
