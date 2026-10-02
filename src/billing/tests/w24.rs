//! W24 / R40 tests: payment methods (系统设置 → 支付, database only):
//! API validation with coded errors, secrets sealed at rest (AAD = method
//! id) and never returned or audited, optimistic concurrency, 测试连接,
//! orders and notifies through DB-configured methods, method selection,
//! cross-method notify isolation, the legacy notify path, Alipay public
//! key rotation with a grace window, disabling and deleting, reload on
//! another instance, and the one-time import of the obsolete panel.toml
//! section. Plus the opt-in REAL sandbox check (ignored).

use std::time::Duration;

use axum::http::{Method, StatusCode};
use serde_json::{json, Value};

use super::super::alipay::tests::{ALIPAY_KEY, ALIPAY_PUB, APP_KEY, APP_PUB, SHORT_KEY, SHORT_PUB};
use super::super::alipay::{self as ali, AlipayKind};
use super::super::methods as pm;
use super::super::provider::ProviderKind;
use super::*;

const OTHER_PUB: &str = include_str!("../testdata/other-pub.pem");
const BASE: &str = "/test/api/v1/settings/payments";

/// A panel WITHOUT methods, main domain ORIGIN.
async fn db_state(db: &TestDb) -> AppState {
    let st =
        AppState::for_test_with(db.pool.clone(), |c| c.install.public_url = ORIGIN.into()).await;
    crate::settings::init(&st).await.unwrap();
    st
}

fn config(gateway: &str) -> Value {
    json!({
        "environment": "custom",
        "gateway_url": gateway,
        "app_id": APP_ID,
        "seller_id": SELLER_ID,
        "app_private_key": APP_KEY,
        "alipay_public_key": ALIPAY_PUB,
        "order_timeout_minutes": 15,
    })
}

fn create_body(gateway: &str) -> Value {
    json!({ "kind": "alipay_f2f", "display_name": "支付宝", "enabled": true,
            "config": config(gateway) })
}

fn bare(pem: &str) -> String {
    pem.lines().filter(|l| !l.starts_with("-----")).collect()
}

async fn version(db: &TestDb, id: &str) -> i64 {
    sqlx::query_scalar("SELECT version FROM payment_methods WHERE id = $1::uuid")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

/// POST a notify body to a path through the full router.
async fn post_notify_to(state: &AppState, path: &str, body: Vec<u8>) -> crate::testdb::http::Resp {
    Client::new(state, rand_ip())
        .post_raw(
            path,
            "application/x-www-form-urlencoded; charset=utf-8",
            body,
        )
        .await
}

#[tokio::test]
async fn payment_methods_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = db_state(&db).await;
    assert!(!state.payments().any_usable(), "none by default");
    let admin = db.admin().await;
    let c = user_client(&state, admin).await;

    // Non-admins get nothing.
    let cu = user_client(&state, db.user().await).await;
    assert_eq!(cu.get(BASE).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        cu.post(BASE, create_body(&mock.url)).await.status,
        StatusCode::FORBIDDEN
    );

    let v = c.get(BASE).await.json();
    assert_eq!(v["methods"], json!([]));
    assert_eq!(v["kinds"][0]["id"], "alipay_f2f");
    assert!(v["kinds"][0]["schema"].as_array().unwrap().len() >= 6);

    // Coded validation errors (nothing written).
    type Case = (Box<dyn Fn(&mut Value)>, &'static str);
    let cases: Vec<Case> = vec![
        (
            Box::new(|b| b["kind"] = json!("paypal")),
            "payments.kind_unknown",
        ),
        (
            Box::new(|b| b["display_name"] = json!("  ")),
            "payments.name_invalid",
        ),
        (
            Box::new(|b| b["icon"] = json!("Bad Icon")),
            "payments.icon_invalid",
        ),
        (
            Box::new(|b| b["sort"] = json!(2_000_000)),
            "payments.sort_range",
        ),
        (
            Box::new(|b| b["config"] = json!([])),
            "payments.config_invalid",
        ),
        (
            Box::new(|b| b["config"]["x"] = json!(1)),
            "payments.config_unknown_field",
        ),
        (
            Box::new(|b| b["config"]["environment"] = json!("dev")),
            "payments.environment_invalid",
        ),
        (
            Box::new(|b| {
                b["config"]["gateway_url"] = json!("http://openapi.alipay.com/gateway.do")
            }),
            "payments.gateway_invalid",
        ),
        (
            Box::new(|b| b["config"]["environment"] = json!("production")),
            "payments.gateway_unexpected",
        ),
        (
            Box::new(|b| b["config"]["app_id"] = json!("20x1")),
            "payments.app_id_invalid",
        ),
        (
            Box::new(|b| b["config"]["seller_id"] = json!("abc")),
            "payments.seller_id_invalid",
        ),
        (
            Box::new(|b| b["config"]["order_timeout_minutes"] = json!(1)),
            "payments.timeout_range",
        ),
        (
            Box::new(|b| b["config"]["app_private_key"] = json!("nope")),
            "payments.private_key_invalid",
        ),
        (
            Box::new(|b| b["config"]["app_private_key"] = json!(ALIPAY_PUB)),
            "payments.private_key_invalid",
        ),
        (
            Box::new(|b| b["config"]["app_private_key"] = json!(SHORT_KEY)),
            "payments.private_key_too_short",
        ),
        (
            Box::new(|b| b["config"]["alipay_public_key"] = json!("AAAA")),
            "payments.public_key_invalid",
        ),
        (
            Box::new(|b| b["config"]["alipay_public_key"] = json!(SHORT_PUB)),
            "payments.public_key_too_short",
        ),
        (
            Box::new(|b| b["config"]["alipay_public_key"] = json!(ALIPAY_KEY)),
            "payments.public_key_is_private",
        ),
        (
            Box::new(|b| b["config"]["alipay_public_key"] = json!(bare(ALIPAY_KEY))),
            "payments.public_key_is_private",
        ),
        (
            Box::new(|b| b["config"]["alipay_public_key"] = json!(APP_PUB)),
            "payments.public_key_is_app_key",
        ),
        (
            Box::new(|b| b["config"]["app_private_key"] = Value::Null),
            "payments.incomplete",
        ),
        (
            Box::new(|b| b["config"]["app_private_key"] = json!("x".repeat(20_000))),
            "payments.private_key_invalid",
        ),
    ];
    for (mutate, code) in cases {
        let mut b = create_body(&mock.url);
        mutate(&mut b);
        let r = c.post(BASE, b).await;
        assert!(
            r.status == StatusCode::BAD_REQUEST || r.status == StatusCode::CONFLICT,
            "{code}: {:?}",
            r.json()
        );
        assert_eq!(r.json()["code"], code, "{:?}", r.json());
        let text = String::from_utf8_lossy(&r.body).to_string();
        assert!(!text.contains("PRIVATE KEY"), "no key echoed: {text}");
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_methods")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "nothing written");
    assert_eq!(
        c.post(
            BASE,
            json!({ "kind": "alipay_f2f", "display_name": "x", "zz": 1 })
        )
        .await
        .status,
        StatusCode::BAD_REQUEST,
        "unknown fields"
    );

    // Create (bare base64 private key, as Alipay's key tool writes it).
    let mut b = create_body(&mock.url);
    b["config"]["app_private_key"] = json!(bare(APP_KEY));
    b["icon"] = json!("alipay");
    let r = c.post(BASE, b).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let v = r.json();
    let id = v["id"].as_str().unwrap().to_string();
    let mid: Uuid = id.parse().unwrap();
    let text = String::from_utf8_lossy(&r.body).to_string();
    assert!(
        !text.contains("PRIVATE") && !text.contains(&bare(APP_KEY)[..40]),
        "{text}"
    );
    assert_eq!(v["config"]["app_private_key_set"], true);
    assert!(v["config"].get("app_private_key").is_none());
    assert_eq!(v["active"], true, "this instance reloaded at once");
    assert_eq!(v["version"], 1);
    assert_eq!(v["kind_label"], "支付宝当面付");
    assert_eq!(v["notify_url"], format!("{ORIGIN}/test/pay/{id}/notify"));
    let app = ali::AppKey::parse(APP_KEY).unwrap();
    assert_eq!(v["config"]["app_key_fingerprint"], app.fingerprint());
    assert_eq!(
        v["config"]["app_public_key"],
        bare(APP_PUB),
        "the 应用公钥 to upload"
    );
    // At rest: sealed (no base64 of the DER), AAD = the method id.
    let enc: Vec<u8> = sqlx::query_scalar("SELECT secrets_enc FROM payment_methods")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, app.der());
    assert!(!String::from_utf8_lossy(&enc).contains(&b64[..32]));
    let plain = state.totp().open_payment_secrets(mid, &enc).unwrap();
    assert!(String::from_utf8(plain).unwrap().contains(&b64));
    assert!(
        state
            .totp()
            .open_payment_secrets(Uuid::new_v4(), &enc)
            .is_none(),
        "AAD = id"
    );
    // Audit: one row, the key only as "changed".
    let audit: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('b', before, 'a', after) FROM audit_log \
         WHERE action = 'payment_method.create'",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0]["a"]["secrets"]["app_private_key"], "changed");
    assert_eq!(audit[0]["a"]["config"]["app_id"], APP_ID);
    let atext = audit[0].to_string();
    assert!(
        !atext.contains("PRIVATE") && !atext.contains(&b64[..40]),
        "{atext}"
    );

    // Stale form → 409; kind cannot change.
    let path = format!("{BASE}/{id}");
    let mut b = create_body(&mock.url);
    b.as_object_mut().unwrap().remove("kind");
    b["version"] = json!(0);
    let r = c.req(Method::PUT, &path, Some(b.clone())).await;
    assert_eq!(r.json()["code"], "settings.version_conflict");
    let mut k = b.clone();
    k["kind"] = json!("alipay_f2f");
    assert_eq!(
        c.req(Method::PUT, &path, Some(k)).await.json()["code"],
        "payments.kind_immutable"
    );

    // 测试连接: the mock's signed "trade does not exist".
    let test_path = format!("{BASE}/{id}/test");
    let r = c.req(Method::POST, &test_path, None).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["ok"], true, "{:?}", r.json());
    assert_eq!(r.json()["result"], "keys_ok");
    assert_eq!(r.json()["sub_code"], "ACQ.TRADE_NOT_EXIST");

    // One method: the shop lists it; an order needs no method_id.
    let (_, plan) = priced_plan(&db, "w24", 990, 30).await;
    let buyer = db.user().await;
    let cb = user_client(&state, buyer).await;
    let shop = cb.get("/test/api/v1/me/shop").await.json();
    assert_eq!(shop["enabled"], true);
    assert_eq!(shop["methods"].as_array().unwrap().len(), 1);
    assert_eq!(shop["methods"][0]["display_name"], "支付宝");
    let r = cb
        .post(
            "/test/api/v1/me/orders",
            json!({ "plan_id": plan, "period": "days" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(r.json()["payment_method_id"], id);
    assert_eq!(r.json()["payment_method_name"], "支付宝");
    assert!(r.json()["qr_code"].is_string());
    let otn = r.json()["out_trade_no"].as_str().unwrap().to_string();
    assert_eq!(
        mock.notify_urls(),
        [format!("{ORIGIN}/test/pay/{id}/notify")]
    );

    // Rotate Alipay's public key, keeping the private key (field omitted):
    // a notify signed with the OLD key (in flight) is still accepted.
    let mut b = create_body(&mock.url);
    b.as_object_mut().unwrap().remove("kind");
    b["version"] = json!(version(&db, &id).await);
    b["config"]
        .as_object_mut()
        .unwrap()
        .remove("app_private_key");
    b["config"]["alipay_public_key"] = json!(OTHER_PUB);
    let r = c.req(Method::PUT, &path, Some(b)).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert!(r.json()["config"]["alipay_public_key_prev_until"].is_string());
    assert_eq!(
        r.json()["config"]["app_key_fingerprint"],
        app.fingerprint(),
        "key kept"
    );
    let after: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'payment_method.update' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(
        after.get("secrets").is_none(),
        "unchanged secrets not reported: {after}"
    );
    let notify_path = format!("/test/pay/{id}/notify");
    let body = form(&notify_params(&otn, "9.90", "TRADE_SUCCESS"));
    let r = post_notify_to(&state, &notify_path, body).await;
    assert_eq!(
        (r.status, r.body.as_slice()),
        (StatusCode::OK, &b"success"[..])
    );
    assert_eq!(
        c.req(Method::POST, &test_path, None).await.json()["result"],
        "keys_ok",
        "grace: the old key still verifies"
    );
    // Grace over: old-key signatures are refused.
    sqlx::query(
        "UPDATE payment_methods SET config = jsonb_set(config, '{alipay_public_key_prev_until}', \
         to_jsonb(to_char(now() - interval '1 minute', 'YYYY-MM-DD\"T\"HH24:MI:SSOF:00'))), \
         version = version + 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    crate::settings::reload(&state).await.unwrap();
    let (oid, otn2) = order_row(&db, db.user().await, plan, 990, 30).await;
    let r = post_notify_to(
        &state,
        &notify_path,
        form(&notify_params(&otn2, "9.90", "TRADE_SUCCESS")),
    )
    .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "old key after the grace");
    assert_eq!(order_status(&db, oid).await.0, "pending");
    let r = c.req(Method::POST, &test_path, None).await.json();
    assert_eq!(
        (r["ok"].clone(), r["result"].clone()),
        (json!(false), json!("alipay_key_wrong"))
    );

    // Disable: not served, notify = canonical rejection, shop says off.
    let mut b = create_body(&mock.url);
    b.as_object_mut().unwrap().remove("kind");
    b["version"] = json!(version(&db, &id).await);
    b["enabled"] = json!(false);
    b["config"]
        .as_object_mut()
        .unwrap()
        .remove("app_private_key");
    b["config"]["alipay_public_key"] = Value::Null;
    let r = c.req(Method::PUT, &path, Some(b)).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(
        r.json()["config"]["app_private_key_set"],
        true,
        "kept while off"
    );
    assert!(!state.payments().any_usable());
    let shop = cb.get("/test/api/v1/me/shop").await.json();
    assert_eq!(
        (shop["enabled"].clone(), shop["methods"].clone()),
        (json!(false), json!([]))
    );
    let canonical = c.get("/test/not/here").await.fingerprint();
    let r = post_notify_to(
        &state,
        &notify_path,
        form(&notify_params(&otn2, "9.90", "TRADE_SUCCESS")),
    )
    .await;
    assert_eq!(r.fingerprint(), canonical);
    // 测试连接 still works on the saved (disabled) configuration.
    assert_eq!(
        c.req(Method::POST, &test_path, None).await.status,
        StatusCode::OK
    );
    // In use → cannot be deleted; an unused draft can.
    let r = c.req(Method::DELETE, &path, None).await;
    assert_eq!(r.json()["code"], "payments.method_in_use");
    let mut b = create_body(&mock.url);
    b["enabled"] = json!(false);
    b["config"] = json!({ "environment": "sandbox" });
    let r = c.post(BASE, b).await;
    assert_eq!(r.status, StatusCode::CREATED, "a draft: {:?}", r.json());
    let draft = r.json()["id"].as_str().unwrap().to_string();
    assert_eq!(
        c.req(Method::POST, &format!("{BASE}/{draft}/test"), None)
            .await
            .json()["code"],
        "payments.not_configured"
    );
    let r = c
        .req(Method::DELETE, &format!("{BASE}/{draft}"), None)
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(
        c.req(Method::DELETE, &format!("{BASE}/{draft}"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action LIKE 'payment_method.%'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(n, 5, "create, update ×2, create, delete");
    drop((state, mock));
    db.drop().await;
}

/// Two methods (two merchants on two gateways): the payer chooses; a
/// verified notify routed to method A never settles an order of method B;
/// the legacy Alipay path settles by the order's own method; reconcile
/// asks each order's own method only.
#[tokio::test]
async fn two_methods_are_isolated() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (ma, mb) = (Mock::start().await, Mock::start().await);
    let state = db_state(&db).await;
    let a = add_method(&state, &ma.url, "支付宝 A").await;
    let b = add_method(&state, &mb.url, "支付宝 B").await;
    let (_, plan) = priced_plan(&db, "two", 500, 30).await;
    let buyer = db.user().await;
    let cb = user_client(&state, buyer).await;
    let shop = cb.get("/test/api/v1/me/shop").await.json();
    assert_eq!(shop["methods"].as_array().unwrap().len(), 2);
    let order = |m: Value| {
        let cb = &cb;
        async move {
            let mut body = json!({ "plan_id": plan, "period": "days" });
            if !m.is_null() {
                body["method_id"] = m;
            }
            cb.post("/test/api/v1/me/orders", body).await
        }
    };
    assert_eq!(
        order(Value::Null).await.json()["code"],
        "order.method_required"
    );
    assert_eq!(
        order(json!(Uuid::new_v4())).await.json()["code"],
        "order.method_unavailable"
    );
    let r = order(json!(b)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let otn = r.json()["out_trade_no"].as_str().unwrap().to_string();
    let oid: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(ma.calls("alipay.trade.precreate"), 0);
    assert_eq!(mb.notify_urls(), [format!("{ORIGIN}/test/pay/{b}/notify")]);
    // A validly signed notify for B's order on A's route: unknown order.
    let body = form(&notify_params(&otn, "5.00", "TRADE_SUCCESS"));
    let r = post_notify_to(&state, &format!("/test/pay/{a}/notify"), body.clone()).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(order_status(&db, oid).await.0, "pending");
    let ev: String = sqlx::query_scalar(
        "SELECT outcome FROM payment_events WHERE out_trade_no = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(&otn)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(ev, "unknown_order");
    // Junk method ids: canonical rejection.
    let canonical = cb.get("/test/not/here").await.fingerprint();
    for p in [
        "/test/pay/nope/notify".to_string(),
        format!("/test/pay/{}/notify", Uuid::new_v4()),
    ] {
        assert_eq!(
            post_notify_to(&state, &p, body.clone()).await.fingerprint(),
            canonical,
            "{p}"
        );
    }
    // The legacy path finds B through the order.
    let r = post_notify_to(&state, "/test/pay/alipay/notify", body).await;
    assert_eq!(
        (r.status, r.body.as_slice()),
        (StatusCode::OK, &b"success"[..])
    );
    assert_eq!(order_status(&db, oid).await, ("paid".into(), true, None));
    let m: Option<Uuid> = sqlx::query_scalar(
        "SELECT payment_method_id FROM payment_events WHERE order_id = $1 AND outcome = 'paid'",
    )
    .bind(oid)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(m, Some(b));
    // A legacy notify for an order without a method: rejected.
    let (o2, otn2) = order_row(&db, db.user().await, plan, 500, 30).await;
    sqlx::query("UPDATE orders SET payment_method_id = NULL WHERE id = $1")
        .bind(o2)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = post_notify_to(
        &state,
        "/test/pay/alipay/notify",
        form(&notify_params(&otn2, "5.00", "TRADE_SUCCESS")),
    )
    .await;
    assert_eq!(r.fingerprint(), canonical);
    // Reconcile queries each order at ITS method only.
    let (o3, otn3) = order_row(&db, db.user().await, plan, 500, 30).await;
    sqlx::query("UPDATE orders SET payment_method_id = $2 WHERE id = $1")
        .bind(o3)
        .bind(b)
        .execute(&db.pool)
        .await
        .unwrap();
    precreate(&*state.payments().provider(b).unwrap(), &otn3, 500).await;
    mb.pay(&otn3);
    let before_a = ma.calls("alipay.trade.query");
    orders::reconcile_tick(&state).await.ok().unwrap();
    assert_eq!(order_status(&db, o3).await.0, "paid");
    assert_eq!(
        ma.calls("alipay.trade.query"),
        before_a,
        "A never asked about B's orders"
    );
    drop((state, ma, mb));
    db.drop().await;
}

/// Secrets that no longer open (another method's blob: AAD = id) → the
/// method is not served, 测试连接 is a coded 409, the view warns, and an
/// edit that keeps the (unreadable) key cannot enable it.
#[tokio::test]
async fn unreadable_secrets() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = db_state(&db).await;
    let admin = db.admin().await;
    let c = user_client(&state, admin).await;
    let a = add_method(&state, &mock.url, "A").await;
    let b = add_method(&state, &mock.url, "B").await;
    sqlx::query(
        "UPDATE payment_methods SET secrets_enc = (SELECT secrets_enc FROM payment_methods \
         WHERE id = $2), version = version + 1 WHERE id = $1",
    )
    .bind(a)
    .bind(b)
    .execute(&db.pool)
    .await
    .unwrap();
    crate::settings::reload(&state).await.unwrap();
    assert!(
        state.payments().provider(a).is_none(),
        "unusable = not served"
    );
    assert!(state.payments().provider(b).is_some());
    let r = c.req(Method::POST, &format!("{BASE}/{a}/test"), None).await;
    assert_eq!(r.json()["code"], "payments.stored_key_unreadable");
    let list = c.get(BASE).await.json();
    let va = list["methods"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == json!(a))
        .unwrap()
        .clone();
    assert!(va["warnings"].to_string().contains("无法解密"));
    assert_eq!(va["config"]["app_public_key"], Value::Null);
    let mut body = create_body(&mock.url);
    body.as_object_mut().unwrap().remove("kind");
    body["version"] = json!(version(&db, &a.to_string()).await);
    body["config"]
        .as_object_mut()
        .unwrap()
        .remove("app_private_key");
    let r = c.req(Method::PUT, &format!("{BASE}/{a}"), Some(body)).await;
    assert_eq!(r.json()["code"], "payments.incomplete", "{:?}", r.json());
    drop((state, mock));
    db.drop().await;
}

/// A change saved on instance A reaches instance B (LISTEN/NOTIFY): B's
/// client appears, changes and disappears without a restart; a holder of
/// the old client keeps it (atomic swap).
#[tokio::test]
async fn payments_reload_on_another_instance() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let a = db_state(&db).await;
    let b = db_state(&db).await;
    let la = crate::notify::start(a.clone()).await;
    let lb = crate::notify::start(b.clone()).await;
    let id = add_method(&a, &mock.url, "支付宝").await;
    let wait = |want: Option<u32>| {
        let b = b.clone();
        async move {
            for _ in 0..100 {
                if b.payments().provider(id).map(|p| p.order_timeout_minutes()) == want {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            false
        }
    };
    assert!(wait(Some(15)).await, "B built the client");
    let before = b.payments().provider(id).unwrap();
    let save = |enabled: bool, timeout: i64| {
        let a = a.clone();
        let url = mock.url.clone();
        async move {
            let mut tx = a.pg().begin().await.unwrap();
            let v: i64 = sqlx::query_scalar("SELECT version FROM payment_methods WHERE id = $1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            let mut req = alipay_method_req(&url, "支付宝");
            req.kind = None;
            req.version = Some(v);
            req.enabled = enabled;
            req.config["order_timeout_minutes"] = json!(timeout);
            pm::apply_update(&mut tx, a.totp(), &crate::audit::Actor::test(), id, &req)
                .await
                .ok()
                .unwrap();
            tx.commit().await.unwrap();
        }
    };
    save(true, 25).await;
    assert!(wait(Some(25)).await, "B swapped it");
    assert_eq!(
        before.order_timeout_minutes(),
        15,
        "the old client still works"
    );
    save(false, 25).await;
    assert!(wait(None).await, "B dropped it");
    la.abort();
    lb.abort();
    let _ = la.await;
    let _ = lb.await;
    drop((a, b, mock));
    db.drop().await;
}

/// The obsolete panel.toml section is imported once into an Alipay method
/// (actor system, secrets sealed) which takes over the pre-0140 orders;
/// ignored afterwards; unreadable key files import nothing.
#[tokio::test]
async fn legacy_section_is_imported_once() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let dir = std::env::temp_dir().join(format!("akari-w24-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let key = dir.join("app.pem");
    let public = dir.join("alipay.pem");
    std::fs::write(&key, APP_KEY).unwrap();
    std::fs::write(&public, ALIPAY_PUB).unwrap();
    let text = format!(
        "[payments.alipay]\nenabled = true\napp_id = \"{APP_ID}\"\nseller_id = \"{SELLER_ID}\"\n\
         app_private_key_file = \"{}\"\nalipay_public_key_file = \"{}\"\n\
         gateway_url = \"https://openapi-sandbox.dl.alipaydev.com/gateway.do\"\n\
         notify_url = \"https://x/abc/pay/alipay/notify\"\norder_timeout_minutes = 30\n",
        key.display(),
        public.display()
    );
    let parsed: crate::config::PanelConfig = toml::from_str(&text).unwrap();
    // A pre-0140 order (no method).
    let (_, plan) = priced_plan(&db, "legacy", 500, 30).await;
    let (old, _) = order_row(&db, db.user().await, plan, 500, 30).await;
    let st = AppState::for_test_with(db.pool.clone(), |c| {
        c.payments = parsed.payments.clone();
        c.install.public_url = ORIGIN.into();
    })
    .await;
    pm::import_legacy(&st).await;
    crate::settings::init(&st).await.unwrap();
    let mut c = db.pool.acquire().await.unwrap();
    let rows = pm::load_all(&mut c).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].kind.as_str(), rows[0].enabled),
        ("alipay_f2f", true)
    );
    assert_eq!(rows[0].config["environment"], "sandbox");
    assert_eq!(rows[0].config["app_id"], APP_ID);
    assert_eq!(rows[0].config["order_timeout_minutes"], 30);
    assert!(st.payments().provider(rows[0].id).is_some());
    let m: Option<Uuid> = sqlx::query_scalar("SELECT payment_method_id FROM orders WHERE id = $1")
        .bind(old)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(
        m,
        Some(rows[0].id),
        "pre-0140 orders belong to the imported method"
    );
    let audit: Vec<(String, String)> = sqlx::query_as(
        "SELECT action, actor_login FROM audit_log WHERE action LIKE 'payment_method.%'",
    )
    .fetch_all(&mut *c)
    .await
    .unwrap();
    assert_eq!(
        audit,
        [("payment_method.import".to_string(), "system".to_string())]
    );
    // Second start: nothing imported again.
    pm::import_legacy(&st).await;
    assert_eq!(pm::load_all(&mut c).await.unwrap().len(), 1);
    // Unreadable key files: warned, nothing written.
    let db2 = TestDb::new().await.unwrap();
    std::fs::remove_file(&key).unwrap();
    let st2 =
        AppState::for_test_with(db2.pool.clone(), |c| c.payments = parsed.payments.clone()).await;
    pm::import_legacy(&st2).await;
    let mut c2 = db2.pool.acquire().await.unwrap();
    assert!(pm::load_all(&mut c2).await.unwrap().is_empty());
    let l = pm::LegacyAlipay {
        app_id: APP_ID.into(),
        gateway_url: "ftp://x".into(),
        ..Default::default()
    };
    assert!(pm::legacy_request(&l).unwrap_err().contains("gateway"));
    drop((c, c2, st, st2));
    std::fs::remove_dir_all(&dir).unwrap();
    db.drop().await;
    db2.drop().await;
}

#[test]
fn gateways_and_kind_validation() {
    assert!(ali::gateway_ok("https://openapi.alipay.com/gateway.do"));
    assert!(ali::gateway_ok("http://127.0.0.1:18089/gateway.do"));
    assert!(ali::gateway_ok("http://[::1]:1/g"));
    for bad in [
        "http://example.com/g",
        "ftp://127.0.0.1/g",
        "https://u@h/g",
        "https://h/g#x",
        "nonsense",
        "",
    ] {
        assert!(!ali::gateway_ok(bad), "{bad}");
    }
    assert!(!ali::gateway_ok(&format!("https://h/{}", "a".repeat(600))));
    assert_eq!(
        ali::gateway_of("sandbox", None).as_deref(),
        Some(ali::GATEWAY_SANDBOX)
    );
    assert_eq!(ali::gateway_of("custom", None), None);
    assert_eq!(ali::gateway_of("x", None), None);
    // A draft: everything optional while disabled.
    let k = AlipayKind;
    let v = k
        .validate(&json!({ "app_id": " 2021 ", "seller_id": "" }), None, false)
        .ok()
        .unwrap();
    assert_eq!(v.config["app_id"], "2021");
    assert_eq!(v.config["seller_id"], Value::Null);
    assert!(v.changed_secrets.is_empty());
    assert!(
        k.build(&v.config, &v.secrets).is_err(),
        "incomplete does not build"
    );
    // Complete → builds; the view never holds the secret.
    let v = k
        .validate(&config("http://127.0.0.1:1/g"), None, true)
        .ok()
        .unwrap();
    assert_eq!(v.changed_secrets, ["app_private_key"]);
    assert!(k.build(&v.config, &v.secrets).is_ok());
    let view = k.view(&v.config, Some(&v.secrets)).to_string();
    assert!(
        !view.contains("PRIVATE") && view.contains("app_public_key"),
        "{view}"
    );
    assert_eq!(
        k.peek_out_trade_no(b"a=1&out_trade_no=AK9"),
        Some("AK9".into())
    );
    assert_eq!(k.peek_out_trade_no(b"a=1&a=2"), None);
}

/// Opt-in: the REAL Alipay sandbox configured THROUGH THE API as a payment
/// method (database, sealed key), then 测试连接 and a precreate with that
/// client. Reads ~/secrets by path only; skipped when the files are absent;
/// never in CI (ignored).
/// `cargo test --lib live_sandbox_db_configured -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn live_sandbox_db_configured() {
    use super::super::alipay::live::{env_value, sandbox_files};
    let Some((env, key, public)) = sandbox_files() else {
        println!("SKIP: sandbox credential files absent");
        return;
    };
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = db_state(&db).await;
    let admin = db.admin().await;
    let c = user_client(&state, admin).await;
    let r = c
        .post(
            BASE,
            json!({
                "kind": "alipay_f2f", "display_name": "沙箱", "enabled": true,
                "config": {
                    "environment": "sandbox",
                    "app_id": env_value(&env, "ALIPAY_SANDBOX_APP_ID"),
                    "seller_id": env_value(&env, "ALIPAY_SANDBOX_SELLER_ID"),
                    "app_private_key": key, "alipay_public_key": public,
                    "order_timeout_minutes": 15,
                },
            }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "code {:?}", r.json()["code"]);
    let id = r.json()["id"].as_str().unwrap().to_string();
    let t = c
        .req(Method::POST, &format!("{BASE}/{id}/test"), None)
        .await
        .json();
    println!("测试连接: {} {}", t["result"], t["message"]);
    assert_eq!(t["ok"], true);
    let p = state
        .payments()
        .provider(id.parse().unwrap())
        .expect("client from the database");
    let otn = format!("AKLIVE{}", hex::encode(rand::random::<[u8; 8]>()));
    let notify = format!("{ORIGIN}/test/pay/{id}/notify");
    let r = p
        .create(super::super::provider::CreateReq {
            out_trade_no: &otn,
            amount_cents: 1,
            subject: "Akari W24 sandbox",
            notify_url: &notify,
        })
        .await;
    println!("precreate: ok={}", r.is_ok());
    assert!(r.is_ok(), "precreate failed: {:?}", r.err());
    let _ = p.close(&otn).await;
    drop(state);
    db.drop().await;
}
