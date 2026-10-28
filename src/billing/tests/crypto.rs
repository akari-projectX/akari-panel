//! Crypto gateway tests: CoinPayments and Coinbase against in-process mock
//! gateways (axum; each mock checks the panel's request authentication —
//! HMAC headers / the bearer JWT — and records what the panel sent) and a
//! real database: the admin API (secrets sealed, never returned), the HTTP
//! purchase flow (create → signed webhook), every refusal canonical with its
//! event, settlement only on the terminal paid state with the exact amount,
//! query-based settlement when no webhook arrives, concurrent duplicates,
//! close on expiry (or not, when funds may be in flight) and the late payment
//! that still fulfils, isolation between methods.

use std::collections::HashMap;

use axum::extract::{OriginalUri, Path, Query as AxQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use serde_json::{Value, json};

use super::super::coinbase::{self, tests as cbt};
use super::super::coinpayments::{self, tests as cpt};
use super::super::crypto::utc_stamp;
use super::super::methods as pm;
use super::super::provider::NotifyRequest;
use super::*;

const BASE: &str = "/test/api/v1/settings/payments";

fn now() -> i64 {
    chrono::Utc::now().timestamp()
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

async fn last_event_params(db: &TestDb, otn: &str) -> Value {
    sqlx::query_scalar(
        "SELECT params FROM payment_events WHERE out_trade_no = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(otn)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

async fn expire_now(db: &TestDb, order: Uuid) {
    sqlx::query("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1")
        .bind(order)
        .execute(&db.pool)
        .await
        .unwrap();
}

async fn reset_query_clock(db: &TestDb, order: Uuid) {
    sqlx::query("UPDATE orders SET last_query_at = NULL WHERE id = $1")
        .bind(order)
        .execute(&db.pool)
        .await
        .unwrap();
}

async fn add_kind(state: &AppState, kind: &str, config: Value, name: &str) -> Uuid {
    let mut tx = state.pg().begin().await.unwrap();
    let row = pm::apply_create(
        &mut tx,
        state.master_key(),
        &crate::audit::Actor::test(),
        "payment_method.create",
        &pm::MethodReq {
            kind: Some(kind.into()),
            version: None,
            display_name: name.into(),
            icon: None,
            sort: 0,
            enabled: true,
            config,
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    crate::settings::reload(state).await.unwrap();
    row.id
}

async fn buy_with(c: &Client, plan: Uuid, method: Uuid) -> crate::testdb::http::Resp {
    c.post(
        "/test/api/v1/me/orders",
        json!({ "plan_id": plan, "period": "days", "method_id": method }),
    )
    .await
}

fn otn_of(r: &crate::testdb::http::Resp) -> String {
    r.json()["out_trade_no"].as_str().unwrap().to_string()
}

async fn poll(c: &Client, order: Uuid) -> Value {
    c.get(&format!("/test/api/v1/me/orders/{order}"))
        .await
        .json()
}

async fn post_webhook(
    state: &AppState,
    method: Uuid,
    headers: &HeaderMap,
    body: &str,
) -> crate::testdb::http::Resp {
    Client::new(state, rand_ip())
        .post_raw_with(
            &format!("/pay/{method}/notify"),
            "application/json",
            headers,
            body.as_bytes().to_vec(),
        )
        .await
}

fn json_response(status: StatusCode, v: Value) -> Response {
    (status, axum::Json(v)).into_response()
}

// ===========================================================================
// CoinPayments
// ===========================================================================

#[derive(Debug, Clone)]
struct CpInvoice {
    id: String,
    otn: String,
    status: String,
    total: String,
    currency: String,
    custom: Value,
    webhook: String,
}

#[derive(Debug, Default)]
struct CpInner {
    base: String,
    invoices: Vec<CpInvoice>,
    cancels: Vec<String>,
    requests: usize,
    down: bool,
}

#[derive(Clone)]
struct CpMock {
    inner: Arc<Mutex<CpInner>>,
    base: String,
}

fn cp_authentic(
    g: &CpInner,
    method: &str,
    uri: &axum::http::Uri,
    h: &HeaderMap,
    body: &str,
) -> bool {
    let get = |n: &str| {
        h.get(n)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string()
    };
    let url = format!(
        "{}{}",
        g.base,
        uri.path_and_query().map(|p| p.as_str()).unwrap_or_default()
    );
    get("x-coinpayments-client") == cpt::CLIENT
        && coinpayments::signature_valid(
            cpt::SECRET,
            &coinpayments::signing_message(
                method,
                &url,
                cpt::CLIENT,
                &get("x-coinpayments-timestamp"),
                body,
            ),
            &get("x-coinpayments-signature"),
        )
}

fn cp_view(i: &CpInvoice) -> Value {
    json!({
        "id": i.id, "invoiceId": i.otn, "status": i.status,
        "currency": {"id": i.currency, "symbol": "USD"},
        "amount": {"breakdown": {"subtotal": i.total}, "total": i.total},
        "customData": i.custom, "payments": [],
    })
}

impl CpMock {
    async fn start() -> Self {
        let inner = Arc::new(Mutex::new(CpInner::default()));
        let app = axum::Router::new()
            .route(
                "/api/v2/merchant/invoices",
                axum::routing::post(cp_create).get(cp_list),
            )
            .route("/api/v2/merchant/invoices/{id}", axum::routing::get(cp_get))
            .route(
                "/api/v1/merchant/invoices/{id}/cancel",
                axum::routing::post(cp_cancel),
            )
            .route("/api/v2/currencies/{id}", axum::routing::get(cp_currency))
            .with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        inner.lock().unwrap().base = base.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { inner, base }
    }
    fn invoice(&self, otn: &str) -> CpInvoice {
        self.inner
            .lock()
            .unwrap()
            .invoices
            .iter()
            .find(|i| i.otn == otn)
            .cloned()
            .unwrap()
    }
    fn edit(&self, otn: &str, f: impl FnOnce(&mut CpInvoice)) {
        let mut g = self.inner.lock().unwrap();
        f(g.invoices.iter_mut().find(|i| i.otn == otn).unwrap());
    }
    fn set_status(&self, otn: &str, status: &str) {
        self.edit(otn, |i| i.status = status.into());
    }
    fn requests(&self) -> usize {
        self.inner.lock().unwrap().requests
    }
}

async fn cp_create(
    State(inner): State<Arc<Mutex<CpInner>>>,
    OriginalUri(uri): OriginalUri,
    h: HeaderMap,
    body: String,
) -> Response {
    let mut g = inner.lock().unwrap();
    g.requests += 1;
    if g.down {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if !cp_authentic(&g, "POST", &uri, &h, &body) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let v: Value = serde_json::from_str(&body).unwrap();
    let id = format!("inv-{}", g.invoices.len() + 1);
    g.invoices.push(CpInvoice {
        id: id.clone(),
        otn: v["invoiceId"].as_str().unwrap().into(),
        status: "unpaid".into(),
        total: v["amount"]["total"].as_str().unwrap().into(),
        currency: v["currency"].as_str().unwrap().into(),
        custom: v["customData"].clone(),
        webhook: v["webhooks"][0]["notificationsUrl"]
            .as_str()
            .unwrap()
            .into(),
    });
    let base = g.base.clone();
    json_response(
        StatusCode::OK,
        json!({"invoices": [{"id": id, "link": format!("{base}/i/{id}"), "checkoutLink": format!("{base}/checkout/{id}")}]}),
    )
}

async fn cp_list(
    State(inner): State<Arc<Mutex<CpInner>>>,
    OriginalUri(uri): OriginalUri,
    h: HeaderMap,
    AxQuery(q): AxQuery<HashMap<String, String>>,
) -> Response {
    let mut g = inner.lock().unwrap();
    g.requests += 1;
    if g.down {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if !cp_authentic(&g, "GET", &uri, &h, "") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let needle = q.get("q").cloned().unwrap_or_default();
    let items: Vec<Value> = g
        .invoices
        .iter()
        .filter(|i| i.otn.contains(&needle))
        .map(|i| json!({"id": i.id, "invoiceId": i.otn, "status": i.status}))
        .collect();
    json_response(StatusCode::OK, json!({"items": items}))
}

async fn cp_get(
    State(inner): State<Arc<Mutex<CpInner>>>,
    OriginalUri(uri): OriginalUri,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let mut g = inner.lock().unwrap();
    g.requests += 1;
    if !cp_authentic(&g, "GET", &uri, &h, "") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match g.invoices.iter().find(|i| i.id == id) {
        Some(i) => json_response(StatusCode::OK, cp_view(i)),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn cp_cancel(
    State(inner): State<Arc<Mutex<CpInner>>>,
    OriginalUri(uri): OriginalUri,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let mut g = inner.lock().unwrap();
    if !cp_authentic(&g, "POST", &uri, &h, "") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    g.cancels.push(id.clone());
    if let Some(i) = g.invoices.iter_mut().find(|i| i.id == id) {
        i.status = "cancelled".into();
    }
    StatusCode::OK.into_response()
}

async fn cp_currency(Path(id): Path<String>) -> Response {
    if id == cpt::CURRENCY_ID {
        json_response(
            StatusCode::OK,
            json!({"id": id, "type": "fiat", "symbol": "USD"}),
        )
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

fn cp_config(base: &str) -> Value {
    json!({
        "instance": "a", "api_base": base, "client_id": cpt::CLIENT,
        "client_secret": cpt::SECRET, "currency": "USD",
        "currency_id": cpt::CURRENCY_ID, "rate_cents": 720, "order_timeout_minutes": 60,
    })
}

async fn cp_state(db: &TestDb, mock: &CpMock) -> (AppState, Uuid) {
    let state = AppState::for_test(db.pool.clone()).await;
    main_domain(db, &state).await;
    let m = add_kind(
        &state,
        coinpayments::KIND,
        cp_config(&mock.base),
        "CoinPayments",
    )
    .await;
    (state, m)
}

/// A webhook of `kind`/`state` for `otn`, signed as CoinPayments signs it
/// (this method's notify URL), at `ts` (unix).
#[expect(
    clippy::too_many_arguments,
    reason = "a flat test helper: the call sites read as a table"
)]
fn cp_webhook(
    state: &AppState,
    method: Uuid,
    otn: &str,
    kind: &str,
    st: &str,
    total: &str,
    cents: i64,
    ts: i64,
) -> (HeaderMap, String) {
    let url = pm::notify_url(state, method).unwrap();
    let body = cpt::payload(kind, st, otn, total, cents);
    (cpt::signed_headers(&body, &utc_stamp(ts), &url), body)
}

/// 系统设置 → 支付 with a CoinPayments method: coded validation, the client
/// secret sealed and never returned or audited, the crypto icon, 测试连接.
#[tokio::test]
async fn coinpayments_methods_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = CpMock::start().await;
    let state = AppState::for_test(db.pool.clone()).await;
    main_domain(&db, &state).await;
    let c = user_client(&state, db.owner().await).await;
    let kinds = c.get(BASE).await.json()["kinds"].clone();
    assert!(
        kinds
            .as_array()
            .unwrap()
            .iter()
            .any(|k| k["id"] == "coinpayments")
    );
    let body = |config: Value| json!({"kind": "coinpayments", "display_name": "加密货币", "enabled": true, "config": config});
    let mut bad = cp_config(&mock.base);
    bad["instance"] = json!("z");
    let r = c.post(BASE, body(bad)).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (
            StatusCode::BAD_REQUEST,
            json!("payments.coinpayments_instance_invalid")
        )
    );
    let mut no_rate = cp_config(&mock.base);
    no_rate.as_object_mut().unwrap().remove("rate_cents");
    assert_eq!(
        c.post(BASE, body(no_rate)).await.json()["code"],
        "payments.incomplete"
    );
    let mut no_secret = cp_config(&mock.base);
    no_secret.as_object_mut().unwrap().remove("client_secret");
    assert_eq!(
        c.post(BASE, body(no_secret)).await.json()["code"],
        "payments.incomplete"
    );
    let r = c.post(BASE, body(cp_config(&mock.base))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let v = r.json();
    let id: Uuid = v["id"].as_str().unwrap().parse().unwrap();
    assert!(
        !String::from_utf8_lossy(&r.body).contains(cpt::SECRET),
        "secret in the view"
    );
    assert_eq!(v["config"]["client_secret_set"], true);
    assert_eq!(v["config"]["rate_cents"], 720);
    assert_eq!(v["notify_url"], format!("{ORIGIN}/pay/{id}/notify"));
    assert_eq!(v["kind_label"], "CoinPayments");
    // Sealed at rest, audited as "changed" only.
    let enc: Vec<u8> = sqlx::query_scalar("SELECT secrets_enc FROM payment_methods WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(
        !enc.windows(cpt::SECRET.len())
            .any(|w| w == cpt::SECRET.as_bytes())
    );
    let audit: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'payment_method.create' AND target_id = $1",
    )
    .bind(id.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(!audit.to_string().contains(cpt::SECRET) && audit.to_string().contains("changed"));
    let shop = user_client(&state, db.user().await)
        .await
        .get("/test/api/v1/me/shop")
        .await
        .json();
    assert_eq!(
        (
            shop["methods"][0]["icon"].clone(),
            shop["methods"][0]["kind"].clone()
        ),
        (json!("crypto"), json!("coinpayments"))
    );
    // 测试连接: signed read + the currency lookup.
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(
        (t["ok"].clone(), t["result"].clone()),
        (json!(true), json!("keys_ok")),
        "{t}"
    );
    // A currency code that disagrees with the id; a wrong secret.
    let ver: i64 = sqlx::query_scalar("SELECT version FROM payment_methods WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let mut eur = cp_config(&mock.base);
    eur["currency"] = json!("EUR");
    eur.as_object_mut().unwrap().remove("client_secret");
    let r = c
        .put(
            &format!("{BASE}/{id}"),
            json!({"version": ver, "display_name": "加密货币", "enabled": true, "config": eur}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(t["result"], "currency_mismatch", "{t}");
    let mut wrong = cp_config(&mock.base);
    wrong["client_secret"] = json!("wrong-secret-0123456789");
    let r = c.put(&format!("{BASE}/{id}"), json!({"version": ver + 1, "display_name": "加密货币", "enabled": true, "config": wrong})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(
        (t["ok"].clone(), t["result"].clone()),
        (json!(false), json!("credentials_rejected"))
    );
    drop(state);
    db.drop().await;
}

/// The whole journey: order → signed create (fiat amount, our webhook URL,
/// the order's cents echoed) → hosted checkout link → every bad or
/// non-terminal webhook is acknowledged-or-canonical with its event and pays
/// nothing → the Completed webhook pays and fulfils → replays are no-ops.
#[tokio::test]
async fn coinpayments_purchase_flow() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = CpMock::start().await;
    let (state, method) = cp_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "cp", 990, 30).await;
    let user = db.user().await;
    let c = user_client(&state, user).await;
    let r = buy(&c, plan, "days").await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let order = order_id(&r);
    let otn = otn_of(&r);
    let inv = mock.invoice(&otn);
    assert_eq!(
        r.json()["pay_url"],
        format!("{}/checkout/{}", mock.base, inv.id)
    );
    assert_eq!(
        (inv.total.as_str(), inv.currency.as_str()),
        ("1.38", cpt::CURRENCY_ID)
    );
    assert_eq!(inv.custom["akari_cents"], "990");
    assert_eq!(inv.webhook, pm::notify_url(&state, method).unwrap());

    let canonical = c.get("/test/not/here").await.fingerprint();
    let t = now();
    let hook = |kind: &str, st: &str, total: &str, cents: i64, ts: i64| {
        cp_webhook(&state, method, &otn, kind, st, total, cents, ts)
    };
    // Bad signature (another secret), stale timestamp, other URL.
    let (_, body) = hook("InvoiceCompleted", "Completed", "1.38", 990, t);
    let forged = {
        let m = coinpayments::signing_message(
            "POST",
            &pm::notify_url(&state, method).unwrap(),
            cpt::CLIENT,
            &utc_stamp(t),
            &body,
        );
        let mut h = cpt::signed_headers(
            &body,
            &utc_stamp(t),
            &pm::notify_url(&state, method).unwrap(),
        );
        h.insert(
            "x-coinpayments-signature",
            coinpayments::signature("another-secret", &m)
                .parse()
                .unwrap(),
        );
        h
    };
    assert_eq!(
        post_webhook(&state, method, &forged, &body)
            .await
            .fingerprint(),
        canonical
    );
    let (h, b) = hook("InvoiceCompleted", "Completed", "1.38", 990, t - 3600);
    assert_eq!(
        post_webhook(&state, method, &h, &b).await.fingerprint(),
        canonical
    );
    let wrong_url = cpt::signed_headers(
        &body,
        &utc_stamp(t),
        "https://panel.example/pay/elsewhere/notify",
    );
    assert_eq!(
        post_webhook(&state, method, &wrong_url, &body)
            .await
            .fingerprint(),
        canonical
    );
    assert_eq!(
        post_webhook(&state, method, &HeaderMap::new(), &body)
            .await
            .fingerprint(),
        canonical
    );
    // Genuinely signed, wrong amount / currency / echoed cents.
    for (total, cents, outcome) in [
        ("0.01", 990, "amount_mismatch"),
        ("1.38", 100, "amount_mismatch"),
        ("138", 990, "amount_mismatch"),
    ] {
        let (h, b) = hook("InvoiceCompleted", "Completed", total, cents, t);
        assert_eq!(
            post_webhook(&state, method, &h, &b).await.fingerprint(),
            canonical,
            "{total}"
        );
        assert_eq!(last_outcome(&db, &otn).await, outcome);
    }
    // Unknown order.
    let (h, b) = cp_webhook(
        &state,
        method,
        "AKnope",
        "InvoiceCompleted",
        "Completed",
        "1.38",
        990,
        t,
    );
    assert_eq!(
        post_webhook(&state, method, &h, &b).await.fingerprint(),
        canonical
    );
    assert_eq!(last_outcome(&db, "AKnope").await, "unknown_order");
    assert_eq!(order_status(&db, order).await.0, "pending");
    // Non-terminal states are acknowledged and pay nothing; an underpaid
    // invoice stays Pending with its payment states on record.
    for (kind, st) in [
        ("InvoicePending", "Pending"),
        ("InvoicePaid", "Paid"),
        ("InvoiceCancelled", "Cancelled"),
        ("InvoiceTimedOut", "TimedOut"),
    ] {
        let (h, b) = hook(kind, st, "1.38", 990, t);
        let r = post_webhook(&state, method, &h, &b).await;
        assert_eq!(
            (r.status, r.body.as_slice()),
            (StatusCode::OK, &b"ok"[..]),
            "{kind}"
        );
        assert_eq!(last_outcome(&db, &otn).await, "ignored", "{kind}");
        assert_eq!(order_status(&db, order).await.0, "pending", "{kind}");
    }
    assert_eq!(last_event_params(&db, &otn).await["state"], "timedout");
    // Another method's order is an unknown order here.
    let m2 = add_kind(
        &state,
        coinpayments::KIND,
        cp_config(&mock.base),
        "CoinPayments 2",
    )
    .await;
    let other_user = user_client(&state, db.user().await).await;
    let r2 = buy_with(&other_user, plan, m2).await;
    assert_eq!(r2.status, StatusCode::CREATED, "{:?}", r2.json());
    let otn2 = otn_of(&r2);
    let (h, b) = cp_webhook(
        &state,
        method,
        &otn2,
        "InvoiceCompleted",
        "Completed",
        "1.38",
        990,
        t,
    );
    assert_eq!(
        post_webhook(&state, method, &h, &b).await.fingerprint(),
        canonical
    );
    assert_eq!(last_outcome(&db, &otn2).await, "unknown_order");
    assert_eq!(order_status(&db, order_id(&r2)).await.0, "pending");
    // The real one.
    let (h, b) = hook("InvoiceCompleted", "Completed", "1.38", 990, t);
    let r = post_webhook(&state, method, &h, &b).await;
    assert_eq!((r.status, r.body.as_slice()), (StatusCode::OK, &b"ok"[..]));
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
        ("notify", Some("inv-0001"))
    );
    // Replay.
    let r = post_webhook(&state, method, &h, &b).await;
    assert_eq!(r.body, b"ok");
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
    ] {
        assert_eq!(count(&db, sql, order).await, want, "{sql}");
    }
    // Neither the secret nor the signature reached the events.
    let leaked: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_events WHERE params::text LIKE $1 OR params::text LIKE '%signature%'")
        .bind(format!("%{}%", cpt::SECRET))
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(leaked, 0);
    drop(state);
    db.drop().await;
}

/// Webhooks lost: the reconciliation / polling query settles `completed`
/// with the exact amount and nothing else; a wrong amount, another currency
/// or `paid`/`pending` never pay.
#[tokio::test]
async fn coinpayments_query_settles_without_a_webhook() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = CpMock::start().await;
    let (state, _) = cp_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "cpq", 990, 30).await;
    let user = db.user().await;
    let c = user_client(&state, user).await;
    let r = buy(&c, plan, "days").await;
    let (order, otn) = (order_id(&r), otn_of(&r));
    let before = mock.requests();
    for st in ["unpaid", "pending", "paid", "timedOut"] {
        mock.set_status(&otn, st);
        reset_query_clock(&db, order).await;
        assert_eq!(poll(&c, order).await["status"], "pending", "{st}");
    }
    assert!(mock.requests() > before, "the gateway was queried");
    // Completed, but the gateway's numbers are not ours.
    mock.set_status(&otn, "completed");
    for edit in [
        (|i: &mut CpInvoice| i.total = "1.37".into()) as fn(&mut CpInvoice),
        |i| i.total = "138".into(),
        |i| i.currency = "5058".into(),
        |i| i.custom = json!({"akari_cents": "1000"}),
        |i| i.custom = json!({}),
    ] {
        let saved = mock.invoice(&otn);
        mock.edit(&otn, edit);
        reset_query_clock(&db, order).await;
        assert_eq!(poll(&c, order).await["status"], "pending");
        let ev: String = sqlx::query_scalar(
            "SELECT outcome FROM payment_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1",
        )
        .bind(order)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(ev, "amount_mismatch");
        mock.edit(&otn, |i| *i = saved);
    }
    // The exact completed invoice pays, through the query path.
    reset_query_clock(&db, order).await;
    assert_eq!(poll(&c, order).await["status"], "paid");
    let via: String = sqlx::query_scalar("SELECT paid_via FROM orders WHERE id = $1")
        .bind(order)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(via, "query");
    assert_eq!(active_plan(&db, user).await.map(|p| p.0), Some(plan));
    // The reconciliation loop (no payer polling) settles another order.
    let other = db.user().await;
    let oc = user_client(&state, other).await;
    let r = buy(&oc, plan, "days").await;
    let (o2, otn2) = (order_id(&r), otn_of(&r));
    mock.set_status(&otn2, "completed");
    orders::reconcile_tick(&state).await.ok().unwrap();
    assert_eq!(order_status(&db, o2).await.0, "paid");
    // A gateway outage is an error, not "unpaid" or "missing".
    mock.inner.lock().unwrap().down = true;
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
    drop(state);
    db.drop().await;
}

/// Concurrent duplicate webhooks and queries for one completed invoice
/// fulfil exactly once.
#[tokio::test]
async fn coinpayments_concurrent_notifies_fulfil_once() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = CpMock::start().await;
    let (state, method) = cp_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "cpc", 990, 30).await;
    let user = db.user().await;
    let c = user_client(&state, user).await;
    let r = buy(&c, plan, "days").await;
    let (oid, otn) = (order_id(&r), otn_of(&r));
    mock.set_status(&otn, "completed");
    let p = state.payments().provider(method).unwrap();
    let (h, b) = cp_webhook(
        &state,
        method,
        &otn,
        "InvoiceCompleted",
        "Completed",
        "1.38",
        990,
        now(),
    );
    let url = pm::notify_url(&state, method);
    let pending = Pending {
        id: oid,
        out_trade_no: otn.clone(),
        amount_cents: 990,
        expires_at: chrono::Utc::now(),
        due: false,
        payment_method_id: Some(method),
    };
    let mut tasks = Vec::new();
    for i in 0..12 {
        let (state, p, h, b, url, pending) = (
            state.clone(),
            p.clone(),
            h.clone(),
            b.clone(),
            url.clone(),
            pending.clone(),
        );
        tasks.push(tokio::spawn(async move {
            if i % 3 == 0 {
                let q = p.query(&pending.out_trade_no).await.unwrap();
                orders::apply_query_result(&state, &pending, &q, "query")
                    .await
                    .unwrap()
            } else {
                let req = NotifyRequest::new(b.as_bytes(), &h, url.as_deref());
                super::super::api::handle_notify(&state, &*p, method, None, &req)
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

/// Expiry: an unpaid invoice is cancelled; an invoice with funds in flight
/// is left alone (cancelling would start the gateway's refund flow) and the
/// late completion still fulfils the expired order.
#[tokio::test]
async fn coinpayments_expiry_close_and_late_payment() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = CpMock::start().await;
    let (state, method) = cp_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "cpe", 990, 30).await;
    let (u1, u2, u3) = (db.user().await, db.user().await, db.user().await);
    let mut orders_made = Vec::new();
    for u in [u1, u2, u3] {
        let r = buy(&user_client(&state, u).await, plan, "days").await;
        orders_made.push((order_id(&r), otn_of(&r)));
    }
    mock.set_status(&orders_made[1].1, "pending");
    // The third was never created at the gateway (e.g. lost): nothing to close.
    mock.inner
        .lock()
        .unwrap()
        .invoices
        .retain(|i| i.otn != orders_made[2].1);
    for (o, _) in &orders_made {
        expire_now(&db, *o).await;
    }
    orders::reconcile_tick(&state).await.ok().unwrap();
    let closes: Vec<(String, Option<String>)> = {
        let mut v = Vec::new();
        for (o, _) in &orders_made {
            v.push(
                sqlx::query_as("SELECT status, close_state FROM orders WHERE id = $1")
                    .bind(o)
                    .fetch_one(&db.pool)
                    .await
                    .unwrap(),
            );
        }
        v
    };
    assert_eq!(closes[0], ("expired".into(), Some("closed".into())));
    assert_eq!(closes[1], ("expired".into(), Some("not_closable".into())));
    assert_eq!(closes[2], ("expired".into(), Some("not_exist".into())));
    assert_eq!(mock.inner.lock().unwrap().cancels, ["inv-1"]);
    // The in-flight payment completes later: the expired order is paid.
    let (h, b) = cp_webhook(
        &state,
        method,
        &orders_made[1].1,
        "InvoiceCompleted",
        "Completed",
        "1.38",
        990,
        now(),
    );
    let r = post_webhook(&state, method, &h, &b).await;
    assert_eq!(r.body, b"ok");
    assert_eq!(
        order_status(&db, orders_made[1].0).await,
        ("paid".into(), true, None)
    );
    assert_eq!(active_plan(&db, u2).await.map(|p| p.0), Some(plan));
    drop(state);
    db.drop().await;
}

// ===========================================================================
// Coinbase
// ===========================================================================

#[derive(Debug, Clone)]
struct CbCheckout {
    id: String,
    status: String,
    amount: String,
    currency: String,
    description: String,
    metadata: Value,
    body: Value,
}

#[derive(Debug, Default)]
struct CbInner {
    base: String,
    public: Vec<u8>,
    checkouts: Vec<CbCheckout>,
    deactivated: Vec<String>,
    unauthorized: usize,
    down: bool,
}

#[derive(Clone)]
struct CbMock {
    inner: Arc<Mutex<CbInner>>,
    base: String,
    secret: String,
}

/// The bearer token is a valid, fresh JWT of the mock's public key for
/// exactly this request (`METHOD host/path`).
fn cb_authentic(g: &CbInner, method: &str, uri: &axum::http::Uri, h: &HeaderMap) -> bool {
    let Some(tok) = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return false;
    };
    let parts: Vec<&str> = tok.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    let dec = |s: &str| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(s)
            .ok()
    };
    let (Some(head), Some(claims), Some(sig)) = (dec(parts[0]), dec(parts[1]), dec(parts[2]))
    else {
        return false;
    };
    let (Ok(head), Ok(claims)) = (
        serde_json::from_slice::<Value>(&head),
        serde_json::from_slice::<Value>(&claims),
    ) else {
        return false;
    };
    let host = g.base.trim_start_matches("http://");
    let want_uri = format!("{method} {host}{}", uri.path());
    let t = now();
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &g.public)
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
        .is_ok()
        && head["alg"] == "EdDSA"
        && head["kid"] == cbt::KEY_ID
        && claims["uri"] == want_uri
        && claims["iss"] == "cdp"
        && claims["nbf"].as_i64().is_some_and(|n| n <= t + 5)
        && claims["exp"].as_i64().is_some_and(|e| e > t)
}

fn cb_view(c: &CbCheckout) -> Value {
    let mut v = c.body.clone();
    v["id"] = json!(c.id);
    v["status"] = json!(c.status);
    v["metadata"] = c.metadata.clone();
    v["description"] = json!(c.description);
    v["fiatAmount"] = json!(c.amount);
    v["fiatCurrency"] = json!(c.currency);
    v["amount"] = json!("1.91");
    v["currency"] = json!("USDC");
    v
}

impl CbMock {
    async fn start() -> Self {
        let (secret, public) = cbt::ed25519_secret();
        let inner = Arc::new(Mutex::new(CbInner {
            public,
            ..CbInner::default()
        }));
        let app = axum::Router::new()
            .route(
                "/api/v1/checkouts",
                axum::routing::post(cb_create).get(cb_list),
            )
            .route("/api/v1/checkouts/{id}", axum::routing::get(cb_get))
            .route(
                "/api/v1/checkouts/{id}/deactivate",
                axum::routing::post(cb_deactivate),
            )
            .with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        inner.lock().unwrap().base = base.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            inner,
            base,
            secret,
        }
    }
    fn by_order(&self, otn: &str) -> CbCheckout {
        self.inner
            .lock()
            .unwrap()
            .checkouts
            .iter()
            .find(|c| c.metadata["akari_order"] == otn)
            .cloned()
            .unwrap()
    }
    fn edit(&self, otn: &str, f: impl FnOnce(&mut CbCheckout)) {
        let mut g = self.inner.lock().unwrap();
        f(g.checkouts
            .iter_mut()
            .find(|c| c.metadata["akari_order"] == otn)
            .unwrap());
    }
    fn set_status(&self, otn: &str, st: &str) {
        self.edit(otn, |c| c.status = st.into());
    }
}

async fn cb_create(
    State(inner): State<Arc<Mutex<CbInner>>>,
    OriginalUri(uri): OriginalUri,
    h: HeaderMap,
    body: String,
) -> Response {
    let mut g = inner.lock().unwrap();
    if g.down {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if !cb_authentic(&g, "POST", &uri, &h) {
        g.unauthorized += 1;
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({"errorType": "unauthorized", "errorMessage": "SECRET-TEXT"}),
        );
    }
    let v: Value = serde_json::from_str(&body).unwrap();
    let id = format!("{:024x}", g.checkouts.len() + 1);
    g.checkouts.push(CbCheckout {
        id: id.clone(),
        status: "ACTIVE".into(),
        amount: v["amount"].as_str().unwrap().into(),
        currency: v["currency"].as_str().unwrap().into(),
        description: v["description"].as_str().unwrap().into(),
        metadata: v["metadata"].clone(),
        body: v.clone(),
    });
    json_response(
        StatusCode::CREATED,
        json!({"id": id, "url": format!("https://payments.coinbase.com/payment-links/pl_{id}"), "status": "ACTIVE"}),
    )
}

async fn cb_list(
    State(inner): State<Arc<Mutex<CbInner>>>,
    OriginalUri(uri): OriginalUri,
    h: HeaderMap,
    AxQuery(q): AxQuery<HashMap<String, String>>,
) -> Response {
    let mut g = inner.lock().unwrap();
    if g.down {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if !cb_authentic(&g, "GET", &uri, &h) {
        g.unauthorized += 1;
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let needle = q.get("descriptionQuery").cloned().unwrap_or_default();
    let items: Vec<Value> = g
        .checkouts
        .iter()
        .filter(|c| c.description.contains(&needle))
        .map(cb_view)
        .collect();
    json_response(StatusCode::OK, json!({"checkouts": items}))
}

async fn cb_get(
    State(inner): State<Arc<Mutex<CbInner>>>,
    OriginalUri(uri): OriginalUri,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let g = inner.lock().unwrap();
    if !cb_authentic(&g, "GET", &uri, &h) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match g.checkouts.iter().find(|c| c.id == id) {
        Some(c) => json_response(StatusCode::OK, cb_view(c)),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn cb_deactivate(
    State(inner): State<Arc<Mutex<CbInner>>>,
    OriginalUri(uri): OriginalUri,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let mut g = inner.lock().unwrap();
    if !cb_authentic(&g, "POST", &uri, &h) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    g.deactivated.push(id.clone());
    if let Some(c) = g.checkouts.iter_mut().find(|c| c.id == id) {
        c.status = "DEACTIVATED".into();
    }
    StatusCode::OK.into_response()
}

fn cb_config(mock: &CbMock) -> Value {
    json!({
        "api_base": mock.base, "key_id": cbt::KEY_ID, "api_secret": mock.secret,
        "webhook_secret": cbt::HOOK, "currency": "USD", "rate_cents": 720,
        "order_timeout_minutes": 60,
    })
}

async fn cb_state(db: &TestDb, mock: &CbMock) -> (AppState, Uuid) {
    let state = AppState::for_test(db.pool.clone()).await;
    main_domain(db, &state).await;
    let m = add_kind(&state, coinbase::KIND, cb_config(mock), "Coinbase").await;
    (state, m)
}

fn cb_webhook(
    otn: &str,
    event: &str,
    status: &str,
    fiat: &str,
    cents: i64,
    ts: i64,
) -> (HeaderMap, String) {
    let body = cbt::payload(event, status, otn, fiat, cents);
    (cbt::signed_headers(&body, ts, cbt::HOOK), body)
}

#[tokio::test]
async fn coinbase_methods_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = CbMock::start().await;
    let state = AppState::for_test(db.pool.clone()).await;
    main_domain(&db, &state).await;
    let c = user_client(&state, db.owner().await).await;
    let body = |config: Value| json!({"kind": "coinbase", "display_name": "Coinbase", "enabled": true, "config": config});
    let mut bad = cb_config(&mock);
    bad["api_secret"] = json!("not a key");
    let r = c.post(BASE, body(bad)).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (
            StatusCode::BAD_REQUEST,
            json!("payments.coinbase_secret_invalid")
        )
    );
    let mut no_hook = cb_config(&mock);
    no_hook.as_object_mut().unwrap().remove("webhook_secret");
    assert_eq!(
        c.post(BASE, body(no_hook)).await.json()["code"],
        "payments.incomplete"
    );
    let r = c.post(BASE, body(cb_config(&mock))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let v = r.json();
    let id: Uuid = v["id"].as_str().unwrap().parse().unwrap();
    let text = String::from_utf8_lossy(&r.body).to_string();
    assert!(
        !text.contains(&mock.secret) && !text.contains(cbt::HOOK),
        "secret in the view"
    );
    assert_eq!(
        (
            v["config"]["api_secret_set"].clone(),
            v["config"]["webhook_secret_set"].clone()
        ),
        (json!(true), json!(true))
    );
    let audit: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'payment_method.create' AND target_id = $1",
    )
    .bind(id.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(!audit.to_string().contains(&mock.secret) && !audit.to_string().contains(cbt::HOOK));
    let enc: Vec<u8> = sqlx::query_scalar("SELECT secrets_enc FROM payment_methods WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(
        !enc.windows(cbt::HOOK.len())
            .any(|w| w == cbt::HOOK.as_bytes())
    );
    let shop = user_client(&state, db.user().await)
        .await
        .get("/test/api/v1/me/shop")
        .await
        .json();
    assert_eq!(
        (
            shop["methods"][0]["icon"].clone(),
            shop["methods"][0]["kind"].clone()
        ),
        (json!("crypto"), json!("coinbase"))
    );
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(
        (t["ok"].clone(), t["result"].clone()),
        (json!(true), json!("keys_ok")),
        "{t}"
    );
    // Another key pair: the gateway refuses the JWT.
    let ver: i64 = sqlx::query_scalar("SELECT version FROM payment_methods WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let mut other = cb_config(&mock);
    other["api_secret"] = json!(cbt::ed25519_secret().0);
    let r = c
        .put(
            &format!("{BASE}/{id}"),
            json!({"version": ver, "display_name": "Coinbase", "enabled": true, "config": other}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(
        (t["ok"].clone(), t["result"].clone()),
        (json!(false), json!("credentials_rejected"))
    );
    drop(state);
    db.drop().await;
}

#[tokio::test]
async fn coinbase_purchase_flow() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = CbMock::start().await;
    let (state, method) = cb_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "cb", 990, 30).await;
    let user = db.user().await;
    let c = user_client(&state, user).await;
    let r = buy(&c, plan, "days").await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let (order, otn) = (order_id(&r), otn_of(&r));
    let co = mock.by_order(&otn);
    assert_eq!(
        r.json()["pay_url"],
        format!("https://payments.coinbase.com/payment-links/pl_{}", co.id)
    );
    assert_eq!((co.amount.as_str(), co.currency.as_str()), ("1.38", "USD"));
    assert_eq!(co.metadata["akari_cents"], "990");
    assert!(co.description.starts_with(&otn));
    assert_eq!(
        co.body["successRedirectUrl"],
        format!("{ORIGIN}/orders/{order}")
    );

    let canonical = c.get("/test/not/here").await.fingerprint();
    let t = now();
    // Forged / wrong secret / tampered / stale / unsigned.
    let (h, b) = cb_webhook(
        &otn,
        "checkout.payment.success",
        "COMPLETED",
        "1.38",
        990,
        t,
    );
    let forged = cbt::signed_headers(&b, t, "another-secret");
    assert_eq!(
        post_webhook(&state, method, &forged, &b)
            .await
            .fingerprint(),
        canonical
    );
    assert_eq!(
        post_webhook(&state, method, &h, &b.replace("1.38", "0.01"))
            .await
            .fingerprint(),
        canonical
    );
    let (hs, bs) = cb_webhook(
        &otn,
        "checkout.payment.success",
        "COMPLETED",
        "1.38",
        990,
        t - 3600,
    );
    assert_eq!(
        post_webhook(&state, method, &hs, &bs).await.fingerprint(),
        canonical
    );
    assert_eq!(
        post_webhook(&state, method, &HeaderMap::new(), &b)
            .await
            .fingerprint(),
        canonical
    );
    // Signed but wrong amount / echoed cents / unknown order.
    for (fiat, cents) in [("0.01", 990), ("1.38", 1000)] {
        let (h, b) = cb_webhook(
            &otn,
            "checkout.payment.success",
            "COMPLETED",
            fiat,
            cents,
            t,
        );
        assert_eq!(
            post_webhook(&state, method, &h, &b).await.fingerprint(),
            canonical
        );
        assert_eq!(last_outcome(&db, &otn).await, "amount_mismatch");
    }
    let (h2, b2) = cb_webhook(
        "AKnope",
        "checkout.payment.success",
        "COMPLETED",
        "1.38",
        990,
        t,
    );
    assert_eq!(
        post_webhook(&state, method, &h2, &b2).await.fingerprint(),
        canonical
    );
    assert_eq!(last_outcome(&db, "AKnope").await, "unknown_order");
    // Non-terminal / failed events are acknowledged and pay nothing.
    for (event, st) in [
        ("checkout.payment.failed", "FAILED"),
        ("checkout.payment.expired", "EXPIRED"),
        ("checkout.payment.success", "PROCESSING"),
    ] {
        let (h, b) = cb_webhook(&otn, event, st, "1.38", 990, t);
        let r = post_webhook(&state, method, &h, &b).await;
        assert_eq!(
            (r.status, r.body.as_slice()),
            (StatusCode::OK, &b"ok"[..]),
            "{event}"
        );
        assert_eq!(last_outcome(&db, &otn).await, "ignored");
        assert_eq!(order_status(&db, order).await.0, "pending");
    }
    // Another Coinbase method's order is an unknown order here.
    let m2 = add_kind(&state, coinbase::KIND, cb_config(&mock), "Coinbase 2").await;
    let r2 = buy_with(&user_client(&state, db.user().await).await, plan, m2).await;
    let otn2 = otn_of(&r2);
    let (h3, b3) = cb_webhook(
        &otn2,
        "checkout.payment.success",
        "COMPLETED",
        "1.38",
        990,
        t,
    );
    assert_eq!(
        post_webhook(&state, method, &h3, &b3).await.fingerprint(),
        canonical
    );
    assert_eq!(last_outcome(&db, &otn2).await, "unknown_order");
    // The real one, then replays.
    let r = post_webhook(&state, method, &h, &b).await;
    assert_eq!((r.status, r.body.as_slice()), (StatusCode::OK, &b"ok"[..]));
    assert_eq!(order_status(&db, order).await, ("paid".into(), true, None));
    assert_eq!(active_plan(&db, user).await.map(|p| p.0), Some(plan));
    let r = post_webhook(&state, method, &h, &b).await;
    assert_eq!(r.body, b"ok");
    assert_eq!(last_outcome(&db, &otn).await, "duplicate");
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM payment_events WHERE order_id = $1 AND outcome = 'paid'",
            order
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM audit_log WHERE action = 'order.paid' AND target_id = $1::text",
            order
        )
        .await,
        1
    );
    // A refused create (another key pair) cancels the new order; the
    // gateway's error text is never stored or shown.
    let mut wrong = cb_config(&mock);
    wrong["api_secret"] = json!(cbt::ed25519_secret().0);
    let m3 = add_kind(&state, coinbase::KIND, wrong, "Coinbase wrong key").await;
    let r = buy_with(&user_client(&state, db.user().await).await, plan, m3).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::BAD_GATEWAY, json!("order.gateway_unavailable"))
    );
    assert_eq!(mock.inner.lock().unwrap().unauthorized, 1);
    let stored: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_events WHERE params::text LIKE '%SECRET-TEXT%'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(stored, 0);
    assert!(!String::from_utf8_lossy(&r.body).contains("SECRET-TEXT"));
    drop(state);
    db.drop().await;
}

#[tokio::test]
async fn coinbase_query_close_and_late_payment() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = CbMock::start().await;
    let (state, method) = cb_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "cbq", 990, 30).await;
    let (u1, u2, u3) = (db.user().await, db.user().await, db.user().await);
    let c1 = user_client(&state, u1).await;
    let r1 = buy(&c1, plan, "days").await;
    let (o1, otn1) = (order_id(&r1), otn_of(&r1));
    // No webhook: only COMPLETED with the exact fiat amount pays.
    for st in ["ACTIVE", "PROCESSING", "EXPIRED", "FAILED", "REFUNDED"] {
        mock.set_status(&otn1, st);
        reset_query_clock(&db, o1).await;
        assert_eq!(poll(&c1, o1).await["status"], "pending", "{st}");
    }
    mock.set_status(&otn1, "COMPLETED");
    for edit in [
        (|c: &mut CbCheckout| c.amount = "1.37".into()) as fn(&mut CbCheckout),
        |c| c.currency = "EUR".into(),
        |c| c.metadata["akari_cents"] = json!("1000"),
    ] {
        let saved = mock.by_order(&otn1);
        mock.edit(&otn1, edit);
        reset_query_clock(&db, o1).await;
        assert_eq!(poll(&c1, o1).await["status"], "pending");
        let ev: String = sqlx::query_scalar(
            "SELECT outcome FROM payment_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1",
        )
        .bind(o1)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(ev, "amount_mismatch");
        mock.edit(&otn1, |c| *c = saved);
    }
    reset_query_clock(&db, o1).await;
    assert_eq!(poll(&c1, o1).await["status"], "paid");
    let via: String = sqlx::query_scalar("SELECT paid_via FROM orders WHERE id = $1")
        .bind(o1)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(via, "query");
    // Expiry: ACTIVE is deactivated, PROCESSING is left alone, a missing
    // checkout needs nothing.
    let mut made = Vec::new();
    for u in [u2, u3] {
        let r = buy(&user_client(&state, u).await, plan, "days").await;
        made.push((order_id(&r), otn_of(&r)));
    }
    let third = user_client(&state, db.user().await).await;
    let r3 = buy(&third, plan, "days").await;
    made.push((order_id(&r3), otn_of(&r3)));
    mock.set_status(&made[1].1, "PROCESSING");
    let gone = made[2].1.clone();
    mock.inner
        .lock()
        .unwrap()
        .checkouts
        .retain(|c| c.metadata["akari_order"] != gone.as_str());
    for (o, _) in &made {
        expire_now(&db, *o).await;
    }
    orders::reconcile_tick(&state).await.ok().unwrap();
    let mut states = Vec::new();
    for (o, _) in &made {
        states.push(
            sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT status, close_state FROM orders WHERE id = $1",
            )
            .bind(o)
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        );
    }
    assert_eq!(states[0], ("expired".into(), Some("closed".into())));
    assert_eq!(states[1], ("expired".into(), Some("not_closable".into())));
    assert_eq!(states[2], ("expired".into(), Some("not_exist".into())));
    assert_eq!(mock.inner.lock().unwrap().deactivated.len(), 1);
    // The processing payment completes: the signed success webhook pays the
    // expired order.
    let (h, b) = cb_webhook(
        &made[1].1,
        "checkout.payment.success",
        "COMPLETED",
        "1.38",
        990,
        now(),
    );
    assert_eq!(post_webhook(&state, method, &h, &b).await.body, b"ok");
    assert_eq!(
        order_status(&db, made[1].0).await,
        ("paid".into(), true, None)
    );
    assert_eq!(active_plan(&db, u3).await.map(|p| p.0), Some(plan));
    drop(state);
    db.drop().await;
}

/// Concurrent duplicate webhooks and queries for one completed checkout
/// fulfil exactly once.
#[tokio::test]
async fn coinbase_concurrent_notifies_fulfil_once() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = CbMock::start().await;
    let (state, method) = cb_state(&db, &mock).await;
    let (_, plan) = priced_plan(&db, "cbc", 990, 30).await;
    let user = db.user().await;
    let r = buy(&user_client(&state, user).await, plan, "days").await;
    let (oid, otn) = (order_id(&r), otn_of(&r));
    mock.set_status(&otn, "COMPLETED");
    let p = state.payments().provider(method).unwrap();
    let (h, b) = cb_webhook(
        &otn,
        "checkout.payment.success",
        "COMPLETED",
        "1.38",
        990,
        now(),
    );
    let url = pm::notify_url(&state, method);
    let pending = Pending {
        id: oid,
        out_trade_no: otn.clone(),
        amount_cents: 990,
        expires_at: chrono::Utc::now(),
        due: false,
        payment_method_id: Some(method),
    };
    let mut tasks = Vec::new();
    for i in 0..12 {
        let (state, p, h, b, url, pending) = (
            state.clone(),
            p.clone(),
            h.clone(),
            b.clone(),
            url.clone(),
            pending.clone(),
        );
        tasks.push(tokio::spawn(async move {
            if i % 3 == 0 {
                let q = p.query(&pending.out_trade_no).await.unwrap();
                orders::apply_query_result(&state, &pending, &q, "query")
                    .await
                    .unwrap()
            } else {
                let req = NotifyRequest::new(b.as_bytes(), &h, url.as_deref());
                super::super::api::handle_notify(&state, &*p, method, None, &req)
                    .await
                    .unwrap()
            }
        }));
    }
    for t in tasks {
        assert!(t.await.unwrap());
    }
    assert_eq!(order_status(&db, oid).await, ("paid".into(), true, None));
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
    drop(state);
    db.drop().await;
}

/// A CoinPayments method and a Coinbase method side by side: a valid
/// notify of one for the other's order is an unknown order, and both are
/// offered with the crypto icon.
#[tokio::test]
async fn crypto_methods_are_isolated() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (cp, cb) = (CpMock::start().await, CbMock::start().await);
    let state = AppState::for_test(db.pool.clone()).await;
    main_domain(&db, &state).await;
    let m_cp = add_kind(
        &state,
        coinpayments::KIND,
        cp_config(&cp.base),
        "CoinPayments",
    )
    .await;
    let m_cb = add_kind(&state, coinbase::KIND, cb_config(&cb), "Coinbase").await;
    let (_, plan) = priced_plan(&db, "iso", 990, 30).await;
    let c = user_client(&state, db.user().await).await;
    let shop = c.get("/test/api/v1/me/shop").await.json();
    assert_eq!(shop["methods"].as_array().unwrap().len(), 2);
    let r = buy_with(&c, plan, m_cp).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let (oid, otn) = (order_id(&r), otn_of(&r));
    let canonical = c.get("/test/not/here").await.fingerprint();
    // Coinbase's perfectly signed success for the CoinPayments order.
    let (h, b) = cb_webhook(
        &otn,
        "checkout.payment.success",
        "COMPLETED",
        "1.38",
        990,
        now(),
    );
    assert_eq!(
        post_webhook(&state, m_cb, &h, &b).await.fingerprint(),
        canonical
    );
    assert_eq!(last_outcome(&db, &otn).await, "unknown_order");
    assert_eq!(order_status(&db, oid).await.0, "pending");
    // And a GET is not a notify of either kind.
    assert_eq!(
        c.get(&format!("/pay/{m_cp}/notify")).await.fingerprint(),
        canonical
    );
    drop(state);
    db.drop().await;
}
