//! C2 tests: USDT on-chain payments against a local mock JSON-RPC node
//! (axum: eth_chainId / blockNumber / call (decimals) / getLogs (with an
//! optional range limit) / getTransactionReceipt / getBlockByNumber; a
//! test drives the head, adds transfers, re-orgs blocks, fails the node)
//! and a real database: the admin API (RPC URLs sealed, receiver fixed and
//! unique, 测试连接), unique amounts, the watcher (recording, confirmation
//! depth, receipt + block re-check, crediting exactly once, replays,
//! wrong amounts, duplicates, reorgs, failed and vanished transactions,
//! late payments, reservation windows, two methods isolated, cursor
//! resume, RPC outage and range halving), the admin assign / ignore of
//! unmatched transfers, and amount exhaustion.

use std::collections::HashMap;

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::super::chain::rpc::fixtures::log_json;
use super::super::chain::{self, watch};
use super::super::methods as pm;
use super::*;

const BASE: &str = "/test/api/v1/settings/payments";
const TRANSFERS: &str = "/test/api/v1/payments/chain-transfers";
/// EIP-55 test vectors (receiving addresses).
const ADDR: &str = "0x52908400098527886E0F7030069857D2E4169EE7";
const ADDR2: &str = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
const PAYER: &str = "0x3333333333333333333333333333333333333333";

// ---------------------------------------------------------------------------
// Mock JSON-RPC node
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct MLog {
    token: String,
    to: String,
    value: u128,
    block: u64,
    tx: String,
    index: u32,
    reverted: bool,
}

#[derive(Debug)]
struct NodeState {
    chain_id: u64,
    head: u64,
    logs: Vec<MLog>,
    /// Re-org salt per block (changes its hash).
    salt: HashMap<u64, u8>,
    down: bool,
    /// Refuse eth_getLogs wider than this.
    max_range: Option<u64>,
    calls: HashMap<String, usize>,
    /// Unix time of block 0.
    t0: i64,
    decimals: u64,
    next_tx: u64,
    /// eth_getBlockByNumber: answer null / another hash.
    block_null: bool,
    block_forked: bool,
}

impl NodeState {
    fn hash(&self, n: u64) -> String {
        format!(
            "0x{:064x}",
            (u128::from(n) << 8) | u128::from(*self.salt.get(&n).unwrap_or(&0))
        )
    }
    fn log(&self, l: &MLog) -> Value {
        log_json(
            &l.token,
            PAYER,
            &l.to,
            l.value,
            l.block,
            &self.hash(l.block),
            &l.tx,
            l.index,
        )
    }
}

#[derive(Clone)]
struct Node {
    inner: Arc<Mutex<NodeState>>,
    url: String,
}

impl Node {
    async fn start(chain_id: u64) -> Self {
        let inner = Arc::new(Mutex::new(NodeState {
            chain_id,
            head: 1000,
            logs: Vec::new(),
            salt: HashMap::new(),
            down: false,
            max_range: None,
            calls: HashMap::new(),
            t0: chrono::Utc::now().timestamp() - 1000,
            decimals: 6,
            next_tx: 1,
            block_null: false,
            block_forked: false,
        }));
        let app = axum::Router::new()
            .route("/", axum::routing::post(rpc))
            .with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            inner,
            url: format!("http://{addr}/"),
        }
    }
    fn g(&self) -> std::sync::MutexGuard<'_, NodeState> {
        self.inner.lock().unwrap()
    }
    fn head(&self) -> u64 {
        self.g().head
    }
    /// Mine `n` blocks.
    fn mine(&self, n: u64) {
        self.g().head += n;
    }
    /// A transfer of `units` of `token` to `to` in the next block (mined);
    /// returns the tx hash.
    fn pay_token(&self, token: &str, to: &str, units: u128) -> String {
        let mut g = self.g();
        g.head += 1;
        let tx = format!("0x{:032x}{:032x}", g.chain_id, g.next_tx);
        g.next_tx += 1;
        let block = g.head;
        g.logs.push(MLog {
            token: token.to_ascii_lowercase(),
            to: to.to_ascii_lowercase(),
            value: units,
            block,
            tx: tx.clone(),
            index: 7,
            reverted: false,
        });
        tx
    }
    fn calls(&self, m: &str) -> usize {
        *self.g().calls.get(m).unwrap_or(&0)
    }
}

async fn rpc(
    axum::extract::State(inner): axum::extract::State<Arc<Mutex<NodeState>>>,
    axum::Json(req): axum::Json<Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let mut g = inner.lock().unwrap();
    let method = req["method"].as_str().unwrap().to_string();
    *g.calls.entry(method.clone()).or_default() += 1;
    if g.down {
        return (StatusCode::SERVICE_UNAVAILABLE, "down").into_response();
    }
    let id = req["id"].clone();
    let p = &req["params"];
    let q =
        |v: &Value| u64::from_str_radix(v.as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
    let result = match method.as_str() {
        "eth_chainId" => json!(format!("0x{:x}", g.chain_id)),
        "eth_blockNumber" => json!(format!("0x{:x}", g.head)),
        "eth_call" => json!(format!("0x{:064x}", g.decimals)),
        "eth_getLogs" => {
            let f = &p[0];
            let (from, to) = (q(&f["fromBlock"]), q(&f["toBlock"]));
            if g.max_range.is_some_and(|m| to - from + 1 > m) {
                return axum::Json(json!({"jsonrpc": "2.0", "id": id,
                    "error": {"code": -32005, "message": "query returned more than 10000 results"}}))
                .into_response();
            }
            let token = f["address"].as_str().unwrap().to_ascii_lowercase();
            let topic = f["topics"][2].as_str().unwrap().to_string();
            json!(
                g.logs
                    .iter()
                    .filter(|l| l.block >= from && l.block <= to && l.block <= g.head)
                    .filter(|l| l.token == token && chain::rpc::address_topic(&l.to) == topic)
                    .map(|l| g.log(l))
                    .collect::<Vec<_>>()
            )
        }
        "eth_getTransactionReceipt" => {
            let tx = p[0].as_str().unwrap();
            let mine: Vec<&MLog> = g
                .logs
                .iter()
                .filter(|l| l.tx == tx && l.block <= g.head)
                .collect();
            match mine.first() {
                None => Value::Null,
                Some(l) => json!({
                    "status": if l.reverted { "0x0" } else { "0x1" },
                    "blockNumber": format!("0x{:x}", l.block),
                    "blockHash": g.hash(l.block),
                    "logs": mine.iter().filter(|l| !l.reverted).map(|l| g.log(l)).collect::<Vec<_>>(),
                }),
            }
        }
        "eth_getBlockByNumber" => {
            let n = q(&p[0]);
            if n > g.head || g.block_null {
                Value::Null
            } else {
                let hash = if g.block_forked {
                    format!("0x{}", "f".repeat(64))
                } else {
                    g.hash(n)
                };
                json!({"number": format!("0x{n:x}"), "hash": hash,
                       "timestamp": format!("0x{:x}", g.t0 + n as i64)})
            }
        }
        _ => {
            return axum::Json(json!({"jsonrpc": "2.0", "id": id,
                "error": {"code": -32601, "message": "method not found"}}))
            .into_response();
        }
    };
    axum::Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response()
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn usdt(c: &str) -> &'static str {
    chain::chain(c).unwrap().usdt
}

fn chain_config(rpc: &str, c: &str, addr: &str, confirmations: u32) -> Value {
    json!({
        "chain": c, "address": addr, "rpc_urls": rpc, "rate_cents": 720,
        "confirmations": confirmations, "order_timeout_minutes": 30, "grace_hours": 24,
        "log_range": 500,
    })
}

async fn add_chain(state: &AppState, config: Value, name: &str) -> Uuid {
    let mut tx = state.pg().begin().await.unwrap();
    let row = pm::apply_create(
        &mut tx,
        state.master_key(),
        &crate::audit::Actor::test(),
        "payment_method.create",
        &pm::MethodReq {
            kind: Some(chain::KIND.into()),
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

async fn loopback_state(db: &TestDb) -> AppState {
    let state =
        AppState::for_test_with(db.pool.clone(), |c| c.limits.chain_rpc_loopback = true).await;
    main_domain(db, &state).await;
    state
}

/// A panel with one Polygon method on `node` (3 confirmations).
async fn chain_state(db: &TestDb, node: &Node) -> (AppState, Uuid) {
    let state = loopback_state(db).await;
    let m = add_chain(
        &state,
        chain_config(&node.url, "polygon", ADDR, 3),
        "USDT（Polygon）",
    )
    .await;
    (state, m)
}

async fn round(state: &AppState) -> watch::Round {
    watch::round(state).await.unwrap().unwrap()
}

async fn order_with(c: &Client, plan: Uuid, method: Option<Uuid>) -> crate::testdb::http::Resp {
    let mut body = json!({ "plan_id": plan, "period": "days" });
    if let Some(m) = method {
        body["method_id"] = json!(m);
    }
    c.post("/test/api/v1/me/orders", body).await
}

/// (status, reason, order) of the transfer of `tx`.
async fn transfer(db: &TestDb, tx: &str) -> (String, Option<String>, Option<Uuid>) {
    sqlx::query_as("SELECT status, reason, order_id FROM chain_transfers WHERE tx_hash = $1")
        .bind(tx)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn transfer_id(db: &TestDb, tx: &str) -> i64 {
    sqlx::query_scalar("SELECT id FROM chain_transfers WHERE tx_hash = $1")
        .bind(tx)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

fn units(r: &crate::testdb::http::Resp) -> u128 {
    r.json()["chain"]["amount_units"].as_u64().unwrap().into()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// 系统设置 → 支付 with an on-chain method: coded validation, the RPC URLs
/// sealed and never returned or audited, the receiver fixed and unique
/// per chain, 测试连接 against the node, deletion refused once money came.
#[tokio::test]
async fn chain_methods_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = Node::start(137).await;
    let state = loopback_state(&db).await;
    let c = user_client(&state, db.owner().await).await;
    let kinds = c.get(BASE).await.json()["kinds"].clone();
    assert!(
        kinds
            .as_array()
            .unwrap()
            .iter()
            .any(|k| k["id"] == "usdt_chain")
    );
    let body = |config: Value| json!({"kind": "usdt_chain", "display_name": "USDT（Polygon）", "enabled": true, "config": config});
    let r = c
        .post(BASE, body(json!({"chain": "polygon", "address": ADDR})))
        .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::CONFLICT, json!("payments.incomplete"))
    );
    let mut bad = chain_config(&node.url, "polygon", ADDR, 3);
    bad["address"] = json!(ADDR.replace('E', "e"));
    assert_eq!(
        c.post(BASE, body(bad)).await.json()["code"],
        "payments.chain_address_invalid"
    );
    let r = c
        .post(
            BASE,
            body(chain_config(&node.url, "polygon", &ADDR.to_lowercase(), 3)),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let v = r.json();
    let id: Uuid = v["id"].as_str().unwrap().parse().unwrap();
    let raw = String::from_utf8_lossy(&r.body).to_string();
    assert!(!raw.contains(&node.url), "RPC URL in the view");
    assert_eq!(v["config"]["address"], ADDR, "checksummed");
    assert_eq!(v["config"]["rpc_urls_set"], true);
    assert_eq!(v["config"]["token_effective"], usdt("polygon"));
    assert_eq!(v["config"]["confirmations_effective"], 3);
    assert_eq!(v["kind_label"], "USDT 链上收款");
    assert!(v["active"].as_bool().unwrap());
    let enc: Vec<u8> = sqlx::query_scalar("SELECT secrets_enc FROM payment_methods WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(
        !enc.windows(node.url.len())
            .any(|w| w == node.url.as_bytes())
    );
    let audit: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'payment_method.create' AND target_id = $1",
    )
    .bind(id.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(!audit.to_string().contains(&node.url));
    assert_eq!(audit["secrets"]["rpc_urls"], "changed");
    // The portal lists it with the kind's icon.
    let shop = user_client(&state, db.user().await)
        .await
        .get("/test/api/v1/me/shop")
        .await
        .json();
    assert_eq!(shop["methods"][0]["icon"], "usdt");
    // 测试连接: chain id, head, the token's decimals.
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(
        (t["ok"].clone(), t["result"].clone()),
        (json!(true), json!("rpc_ok")),
        "{t}"
    );
    node.g().decimals = 18;
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(t["result"], "token_invalid");
    node.g().chain_id = 1;
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(t["result"], "chain_mismatch");
    node.g().down = true;
    let t = c.post(&format!("{BASE}/{id}/test"), json!({})).await.json();
    assert_eq!(t["result"], "rpc_unreachable");
    assert!(!t.to_string().contains(&node.url));
    node.g().down = false;
    // Another method on the same address and chain: refused.
    let r = c
        .post(BASE, body(chain_config(&node.url, "polygon", ADDR, 3)))
        .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::CONFLICT, json!("payments.chain_address_in_use"))
    );
    // The same address on the other chain is another receiver.
    let r = c
        .post(BASE, body(chain_config(&node.url, "plasma", ADDR, 3)))
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    // Editing: the receiver is fixed; the RPC URLs kept when omitted.
    let mut cfg = chain_config(&node.url, "polygon", ADDR, 5);
    cfg.as_object_mut().unwrap().remove("rpc_urls");
    let r = c
        .put(
            &format!("{BASE}/{id}"),
            json!({"version": 1, "display_name": "USDT", "enabled": true, "config": cfg.clone()}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["config"]["confirmations_effective"], 5);
    assert!(r.json()["active"].as_bool().unwrap());
    cfg["address"] = json!(ADDR2);
    let r = c
        .put(
            &format!("{BASE}/{id}"),
            json!({"version": 2, "display_name": "USDT", "enabled": true, "config": cfg}),
        )
        .await;
    assert_eq!(r.json()["code"], "payments.chain_fixed");
    // A transfer received (no orders): the method cannot be deleted.
    sqlx::query(
        "INSERT INTO chain_transfers (method_id, chain, tx_hash, log_index, block_number, \
         block_hash, from_address, amount_units, status, reason, confirmed_at) \
         VALUES ($1, 'polygon', $2, 0, 1, $2, $3, 1000000, 'unmatched', 'no_order', now())",
    )
    .bind(id)
    .bind(format!("0x{}", "e".repeat(64)))
    .bind(PAYER)
    .execute(&db.pool)
    .await
    .unwrap();
    let r = c
        .req(axum::http::Method::DELETE, &format!("{BASE}/{id}"), None)
        .await;
    assert_eq!(r.json()["code"], "payments.method_in_use");
    drop(state);
    db.drop().await;
}

/// The journey: order → unique exact amount on the shared address → the
/// payer's page shows it → the transfer is seen (pending, confirmations
/// counting) → credited at the depth (paid_via chain, trade number = tx
/// hash, fulfilled, receipt event) → replays and more rounds change
/// nothing; a second order of the same price gets another amount.
#[tokio::test]
async fn chain_purchase_flow() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = Node::start(137).await;
    let (state, method) = chain_state(&db, &node).await;
    let (_, plan) = priced_plan(&db, "chain", 3000, 30).await;
    let user = db.user().await;
    let c = user_client(&state, user).await;
    let r = order_with(&c, plan, None).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let order = order_id(&r);
    let v = r.json();
    // ¥30 at ¥7.20 = 4.17 USDT + a suffix of 1..9999 units.
    let u = units(&r);
    assert!((4_170_001..=4_179_999).contains(&u), "{u}");
    assert_eq!(v["chain"]["amount"], chain::format_units(u as i64));
    assert_eq!(v["chain"]["address"], ADDR);
    assert_eq!(v["chain"]["token"], usdt("polygon"));
    assert_eq!(v["chain"]["chain"], "polygon");
    assert_eq!(v["chain"]["confirmations_required"], 3);
    assert_eq!(v["chain"]["rate_cents"], 720);
    assert!(v["chain"]["transfer"].is_null());
    assert_eq!(v["qr_code"], ADDR);
    assert!(v["pay_url"].is_null());
    let expires: chrono::DateTime<chrono::Utc> =
        serde_json::from_value(v["expires_at"].clone()).unwrap();
    let held: chrono::DateTime<chrono::Utc> =
        serde_json::from_value(v["chain"]["reserved_until"].clone()).unwrap();
    assert_eq!((held - expires).num_hours(), 24);
    assert!((expires - chrono::Utc::now()).num_minutes() >= 29);
    // Another buyer, same plan: a different exact amount.
    let c2 = user_client(&state, db.user().await).await;
    let r2 = order_with(&c2, plan, None).await;
    assert_ne!(units(&r2), u);

    // First round: the cursor starts an hour back, nothing to see.
    let first = round(&state).await;
    assert_eq!((first.methods, first.recorded), (1, 0));
    let tx = node.pay_token(usdt("polygon"), ADDR, u);
    let r = round(&state).await;
    assert_eq!((r.recorded, r.credited), (1, 0));
    assert_eq!(
        transfer(&db, &tx).await,
        ("pending".into(), None, Some(order))
    );
    let view = c
        .get(&format!("/test/api/v1/me/orders/{order}"))
        .await
        .json();
    assert_eq!(view["status"], "pending");
    assert_eq!(view["chain"]["transfer"]["status"], "pending");
    assert_eq!(view["chain"]["transfer"]["confirmations"], 1);
    assert_eq!(view["chain"]["transfer"]["tx_hash"], tx);
    node.mine(1);
    assert_eq!(round(&state).await.credited, 0, "2 of 3 confirmations");
    node.mine(1);
    let r = round(&state).await;
    assert_eq!((r.recorded, r.credited), (0, 1));
    assert_eq!(order_status(&db, order).await, ("paid".into(), true, None));
    assert_eq!(active_plan(&db, user).await.map(|p| p.0), Some(plan));
    let (via, trade, paid): (String, Option<String>, Option<i64>) =
        sqlx::query_as("SELECT paid_via, trade_no, paid_amount_cents FROM orders WHERE id = $1")
            .bind(order)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        (via.as_str(), trade.as_deref(), paid),
        ("chain", Some(tx.as_str()), Some(3000))
    );
    assert_eq!(
        transfer(&db, &tx).await,
        ("credited".into(), None, Some(order))
    );
    let view = c
        .get(&format!("/test/api/v1/me/orders/{order}"))
        .await
        .json();
    assert_eq!(view["chain"]["transfer"]["status"], "credited");
    assert!(view["qr_code"].is_null());
    // Replays: more rounds (the tail is read again), nothing changes.
    node.mine(5);
    for _ in 0..2 {
        let r = round(&state).await;
        assert_eq!((r.recorded, r.credited, r.unmatched), (0, 0, 0));
    }
    for (sql, want) in [
        (
            "SELECT count(*) FROM audit_log WHERE action = 'order.paid' AND target_id = $1::text",
            1,
        ),
        (
            "SELECT count(*) FROM payment_events WHERE order_id = $1 AND source = 'chain' AND outcome = 'paid'",
            1,
        ),
        (
            "SELECT count(*) FROM chain_transfers WHERE order_id = $1",
            1,
        ),
        (
            "SELECT count(*) FROM mail_outbox WHERE kind = 'order_paid' AND user_id = (SELECT user_id FROM orders WHERE id = $1)",
            0,
        ),
    ] {
        assert_eq!(count(&db, sql, order).await, want, "{sql}");
    }
    let actor: String = sqlx::query_scalar(
        "SELECT actor_label FROM audit_log WHERE action = 'order.paid' AND target_id = $1",
    )
    .bind(order.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(actor, "chain");
    // The admin order view carries the chain part too; paid_via filter.
    let admin = user_client(&state, db.owner().await).await;
    let o = admin
        .get(&format!("/test/api/v1/orders/{order}"))
        .await
        .json();
    assert_eq!(o["order"]["chain"]["amount_units"].as_u64(), Some(u as u64));
    let l = admin.get("/test/api/v1/orders?via=chain").await;
    assert_eq!(l.status, StatusCode::OK);
    assert_eq!(
        admin.get("/test/api/v1/orders?via=bogus").await.json()["code"],
        "export.via_invalid"
    );
    // The cursor stops at the safe height (head − depth + 1).
    let next: i64 = sqlx::query_scalar("SELECT next_block FROM chain_cursors WHERE method_id = $1")
        .bind(method)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(next as u64, node.head() + 1 - 3 + 1);
    drop(state);
    db.drop().await;
}

/// Money that pays nothing is kept for the admin: a wrong amount, a second
/// payment of a paid order, dust (not recorded), another token (ignored);
/// the admin assigns (same method, unpaid order) or ignores, audited.
#[tokio::test]
async fn unmatched_transfers_and_admin_resolution() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = Node::start(137).await;
    let (state, method) = chain_state(&db, &node).await;
    let (_, plan) = priced_plan(&db, "chain", 3000, 30).await;
    let user = db.user().await;
    let c = user_client(&state, user).await;
    let r = order_with(&c, plan, None).await;
    let order = order_id(&r);
    let u = units(&r);
    round(&state).await;
    // The payer forgot the suffix; then pays exactly; then pays again.
    let wrong = node.pay_token(usdt("polygon"), ADDR, 4_170_000);
    let good = node.pay_token(usdt("polygon"), ADDR, u);
    let again = node.pay_token(usdt("polygon"), ADDR, u);
    let dust = node.pay_token(usdt("polygon"), ADDR, 9_999);
    let fake = node.pay_token(PAYER, ADDR, u);
    let other = node.pay_token(usdt("polygon"), ADDR2, u);
    node.mine(3);
    let r = round(&state).await;
    assert_eq!((r.recorded, r.credited, r.unmatched), (3, 1, 2), "{r:?}");
    assert_eq!(
        transfer(&db, &good).await,
        ("credited".into(), None, Some(order))
    );
    assert_eq!(
        transfer(&db, &wrong).await,
        ("unmatched".into(), Some("no_order".into()), None)
    );
    assert_eq!(
        transfer(&db, &again).await,
        ("unmatched".into(), Some("order_paid".into()), Some(order))
    );
    for tx in [&dust, &fake, &other] {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM chain_transfers WHERE tx_hash = $1")
            .bind(tx)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{tx} must not be recorded");
    }
    assert_eq!(
        count(&db, "SELECT count(*) FROM audit_log WHERE action = 'chain_transfer.unmatched' AND $1::uuid IS NOT NULL", order).await,
        2
    );
    // The admin's list: unmatched only, with the watcher state.
    let admin = user_client(&state, db.owner().await).await;
    let l = admin.get(&format!("{TRANSFERS}?status=unmatched")).await;
    assert_eq!(l.status, StatusCode::OK);
    let l = l.json();
    assert_eq!(l["transfers"].as_array().unwrap().len(), 2);
    assert_eq!(l["transfers"][0]["amount"], chain::format_units(u as i64));
    assert_eq!(l["transfers"][1]["amount"], "4.170000");
    assert_eq!(l["watchers"][0]["method_id"], method.to_string());
    assert_eq!(l["watchers"][0]["unmatched"], 2);
    assert!(l["watchers"][0]["last_error"].is_null());
    assert_eq!(
        admin.get(&format!("{TRANSFERS}?status=bogus")).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        admin.get(&format!("{TRANSFERS}?nope=1")).await.status,
        StatusCode::BAD_REQUEST
    );
    let page = admin
        .get(&format!(
            "{TRANSFERS}?method_id={method}&limit=1&before={}",
            transfer_id(&db, &again).await
        ))
        .await
        .json();
    assert_eq!(page["transfers"][0]["tx_hash"], good);
    assert_eq!(
        user_client(&state, user).await.get(TRANSFERS).await.status,
        StatusCode::FORBIDDEN
    );
    // Assign the suffix-less payment to the buyer's next (unpaid) order.
    let r2 = order_with(&c, plan, None).await;
    let order2 = order_id(&r2);
    let wid = transfer_id(&db, &wrong).await;
    let assign = |id: i64, order: Uuid, reason: &str| {
        let admin = &admin;
        let body = json!({"order_id": order, "reason": reason});
        async move { admin.post(&format!("{TRANSFERS}/{id}/assign"), body).await }
    };
    assert_eq!(
        assign(wid, order2, " ").await.json()["code"],
        "request.reason_length"
    );
    assert_eq!(
        assign(wid, order, "x").await.json()["code"],
        "chain.order_paid"
    );
    assert_eq!(
        assign(wid, Uuid::new_v4(), "x").await.json()["code"],
        "chain.order_unknown"
    );
    assert_eq!(
        assign(9_999_999, order2, "x").await.status,
        StatusCode::NOT_FOUND
    );
    let gid = transfer_id(&db, &good).await;
    assert_eq!(
        assign(gid, order2, "x").await.json()["code"],
        "chain.transfer_not_open"
    );
    let r = assign(wid, order2, "用户少付了尾数，工单 #12 核实").await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["fulfilled"], true);
    assert_eq!(order_status(&db, order2).await.0, "paid");
    let (via, reason): (String, Option<String>) =
        sqlx::query_as("SELECT paid_via, manual_reason FROM orders WHERE id = $1")
            .bind(order2)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        (via.as_str(), reason.as_deref()),
        ("chain", Some("用户少付了尾数，工单 #12 核实"))
    );
    assert_eq!(
        transfer(&db, &wrong).await,
        ("assigned".into(), Some("no_order".into()), Some(order2))
    );
    let a: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'chain_transfer.assign' AND target_id = $1",
    )
    .bind(wid.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(a["order_id"], order2.to_string());
    // Ignore the duplicate payment (refunded by hand).
    let aid = transfer_id(&db, &again).await;
    let r = admin
        .post(
            &format!("{TRANSFERS}/{aid}/ignore"),
            json!({"reason": "已线下退回"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(transfer(&db, &again).await.0, "ignored");
    let r = admin
        .post(
            &format!("{TRANSFERS}/{aid}/ignore"),
            json!({"reason": "again"}),
        )
        .await;
    assert_eq!(r.json()["code"], "chain.transfer_not_open");
    let resolved: Option<String> = sqlx::query_scalar(
        "SELECT resolved_by_email FROM (SELECT u.email AS resolved_by_email FROM chain_transfers t \
         JOIN users u ON u.id = t.resolved_by WHERE t.id = $1) x",
    )
    .bind(aid)
    .fetch_optional(&db.pool)
    .await
    .unwrap();
    assert!(resolved.is_some());
    assert_eq!(
        count(&db, "SELECT count(*) FROM audit_log WHERE action = 'chain_transfer.ignore' AND $1::uuid IS NOT NULL", order).await,
        1
    );
    // A transfer of another method cannot be assigned to this order.
    let node2 = Node::start(9745).await;
    let m2 = add_chain(
        &state,
        chain_config(&node2.url, "plasma", ADDR2, 1),
        "USDT（Plasma）",
    )
    .await;
    round(&state).await;
    let stray = node2.pay_token(usdt("plasma"), ADDR2, 1_000_000);
    round(&state).await;
    assert_eq!(transfer(&db, &stray).await.1.as_deref(), Some("no_order"));
    let r3 = order_with(&c, plan, Some(method)).await;
    let r = assign(transfer_id(&db, &stray).await, order_id(&r3), "x").await;
    assert_eq!(r.json()["code"], "chain.order_mismatch");
    let _ = m2;
    drop(state);
    db.drop().await;
}

/// Reorgs: a transfer moved to another block follows it and waits for the
/// depth again; one that left the chain is dropped after a while (never
/// credited); a reverted transaction is dropped.
#[tokio::test]
async fn reorgs_and_failed_transactions() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = Node::start(137).await;
    let (state, _) = chain_state(&db, &node).await;
    let (_, plan) = priced_plan(&db, "chain", 3000, 30).await;
    let c = user_client(&state, db.user().await).await;
    let r = order_with(&c, plan, None).await;
    let order = order_id(&r);
    let u = units(&r);
    round(&state).await;
    // Seen in block B (1 confirmation), then the tail is re-organised: B
    // gets another hash and the transaction lands two blocks later.
    let tx = node.pay_token(usdt("polygon"), ADDR, u);
    let b = node.head();
    round(&state).await;
    {
        let mut g = node.g();
        g.salt.insert(b, 1);
        g.head += 2;
        g.logs.iter_mut().find(|l| l.tx == tx).unwrap().block = b + 2;
    }
    let r = round(&state).await;
    assert_eq!(r.credited, 0, "only 1 confirmation in the new block");
    let (bn, bh): (i64, String) =
        sqlx::query_as("SELECT block_number, block_hash FROM chain_transfers WHERE tx_hash = $1")
            .bind(&tx)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(bn as u64, b + 2);
    assert_eq!(bh, node.g().hash(b + 2));
    node.mine(2);
    assert_eq!(round(&state).await.credited, 1);
    assert_eq!(order_status(&db, order).await.0, "paid");

    // Reorg below the depth before the re-check: the receipt points at a
    // block the row does not know → follow it, credit later.
    let c2 = user_client(&state, db.user().await).await;
    let r2 = order_with(&c2, plan, None).await;
    let order2 = order_id(&r2);
    let tx2 = node.pay_token(usdt("polygon"), ADDR, units(&r2));
    let b2 = node.head();
    node.mine(1);
    round(&state).await; // recorded at b2 (2 confirmations)
    {
        let mut g = node.g();
        g.salt.insert(b2, 9);
        g.head += 1;
    }
    // Now at the depth, but the block hash moved: no credit this round.
    sqlx::query("UPDATE chain_cursors SET next_block = next_block + 10")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(round(&state).await.credited, 0);
    assert_eq!(transfer(&db, &tx2).await.0, "pending");
    assert_eq!(round(&state).await.credited, 1);
    assert_eq!(order_status(&db, order2).await.0, "paid");
    sqlx::query("UPDATE chain_cursors SET next_block = next_block - 10")
        .execute(&db.pool)
        .await
        .unwrap();

    // Gone from the chain (no receipt): pending until stale, then dropped.
    let c3 = user_client(&state, db.user().await).await;
    let r3 = order_with(&c3, plan, None).await;
    let order3 = order_id(&r3);
    let gone = node.pay_token(usdt("polygon"), ADDR, units(&r3));
    round(&state).await;
    node.g().logs.retain(|l| l.tx != gone);
    node.mine(5);
    let r = round(&state).await;
    assert_eq!((r.credited, r.dropped), (0, 0));
    sqlx::query(
        "UPDATE chain_transfers SET seen_at = now() - interval '1 hour' WHERE tx_hash = $1",
    )
    .bind(&gone)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(round(&state).await.dropped, 1);
    assert_eq!(
        transfer(&db, &gone).await,
        ("dropped".into(), Some("missing".into()), None)
    );
    assert_eq!(order_status(&db, order3).await.0, "pending");
    // A reverted transaction (the log was seen, the receipt failed).
    let bad = node.pay_token(usdt("polygon"), ADDR, units(&r3));
    round(&state).await;
    node.g()
        .logs
        .iter_mut()
        .find(|l| l.tx == bad)
        .unwrap()
        .reverted = true;
    node.mine(3);
    assert_eq!(round(&state).await.dropped, 1);
    assert_eq!(transfer(&db, &bad).await.1.as_deref(), Some("reverted"));
    assert_eq!(order_status(&db, order3).await.0, "pending");
    drop(state);
    db.drop().await;
}

/// Late payment: an expired order (ended by the reconcile, nothing to
/// close) is still paid by its amount within the reservation window; a
/// transfer from before an order existed never pays it (the amount came
/// back after the window); an outdated one is unmatched.
#[tokio::test]
async fn late_payments_and_reservation_windows() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = Node::start(137).await;
    let (state, method) = chain_state(&db, &node).await;
    let (_, plan) = priced_plan(&db, "chain", 3000, 30).await;
    let user = db.user().await;
    let c = user_client(&state, user).await;
    let r = order_with(&c, plan, None).await;
    let order = order_id(&r);
    let u = units(&r);
    round(&state).await;
    sqlx::query("UPDATE orders SET expires_at = now() - interval '1 minute', last_query_at = NULL WHERE id = $1")
        .bind(order)
        .execute(&db.pool)
        .await
        .unwrap();
    orders::reconcile_tick(&state).await.unwrap();
    let (status, close): (String, Option<String>) =
        sqlx::query_as("SELECT status, close_state FROM orders WHERE id = $1")
            .bind(order)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        (status.as_str(), close.as_deref()),
        ("expired", Some("not_closable"))
    );
    let tx = node.pay_token(usdt("polygon"), ADDR, u);
    node.mine(3);
    assert_eq!(round(&state).await.credited, 1);
    assert_eq!(order_status(&db, order).await, ("paid".into(), true, None));
    assert_eq!(transfer(&db, &tx).await.0, "credited");

    // The window ended: the reservation gives its amount back; a new
    // order may draw it; a payment dated before the new order was created
    // does not pay it.
    sqlx::query(
        "UPDATE chain_payments SET created_at = now() - interval '3 days', \
         reserved_until = now() - interval '1 day' WHERE order_id = $1",
    )
    .bind(order)
    .execute(&db.pool)
    .await
    .unwrap();
    let old = node.pay_token(usdt("polygon"), ADDR, u);
    {
        // Back-date the block before the old order existed.
        let mut g = node.g();
        g.t0 -= 4 * 86_400;
    }
    node.mine(3);
    assert_eq!(round(&state).await.unmatched, 1);
    assert_eq!(transfer(&db, &old).await.1.as_deref(), Some("no_order"));
    node.g().t0 += 4 * 86_400;
    // reserve() frees expired amounts first: force the same amount.
    let c2 = user_client(&state, db.user().await).await;
    let r2 = order_with(&c2, plan, None).await;
    let order2 = order_id(&r2);
    sqlx::query("UPDATE chain_payments SET amount_units = $2 WHERE order_id = $1")
        .bind(order2)
        .bind(u as i64)
        .execute(&db.pool)
        .await
        .unwrap();
    let active: Vec<bool> = sqlx::query_scalar(
        "SELECT active FROM chain_payments WHERE method_id = $1 AND amount_units = $2 ORDER BY created_at",
    )
    .bind(method)
    .bind(u as i64)
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        active,
        vec![false, true],
        "the old reservation stopped reserving"
    );
    // A transfer dated before the new order existed: not its payment.
    let before = node.pay_token(usdt("polygon"), ADDR, u);
    node.g().t0 -= 3600;
    node.mine(3);
    assert_eq!(round(&state).await.unmatched, 1);
    assert_eq!(transfer(&db, &before).await.1.as_deref(), Some("no_order"));
    node.g().t0 += 3600;
    assert_eq!(order_status(&db, order2).await.0, "pending");
    drop(state);
    db.drop().await;
}

/// Two on-chain methods (two chains, two nodes) are independent: the
/// same amount on one chain never pays the other method's order; a
/// method only watches its own address.
#[tokio::test]
async fn two_methods_are_isolated() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let polygon = Node::start(137).await;
    let plasma = Node::start(9745).await;
    let (state, m1) = chain_state(&db, &polygon).await;
    let m2 = add_chain(
        &state,
        chain_config(&plasma.url, "plasma", ADDR2, 2),
        "USDT（Plasma）",
    )
    .await;
    let (_, plan) = priced_plan(&db, "chain", 3000, 30).await;
    let ca = user_client(&state, db.user().await).await;
    let cb = user_client(&state, db.user().await).await;
    let ra = order_with(&ca, plan, Some(m1)).await;
    let rb = order_with(&cb, plan, Some(m2)).await;
    assert_eq!(
        order_with(&cb, plan, None).await.json()["code"],
        "order.method_required"
    );
    let (oa, ob) = (order_id(&ra), order_id(&rb));
    assert_eq!(rb.json()["chain"]["chain"], "plasma");
    assert_eq!(rb.json()["chain"]["token"], usdt("plasma"));
    // Force the same exact amount on both methods (independent spaces).
    sqlx::query("UPDATE chain_payments SET amount_units = $2 WHERE order_id = $1")
        .bind(ob)
        .bind(units(&ra) as i64)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(round(&state).await.methods, 2);
    // Paid on Plasma only — to the Polygon address too (wrong network).
    let wrong_net = plasma.pay_token(usdt("plasma"), ADDR, units(&ra));
    let tx = plasma.pay_token(usdt("plasma"), ADDR2, units(&ra));
    plasma.mine(2);
    let r = round(&state).await;
    assert_eq!((r.credited, r.recorded), (1, 1), "{r:?}");
    assert_eq!(order_status(&db, ob).await.0, "paid");
    assert_eq!(order_status(&db, oa).await.0, "pending");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM chain_transfers WHERE tx_hash = $1")
        .bind(&wrong_net)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let (m, _): (Uuid, String) =
        sqlx::query_as("SELECT method_id, status FROM chain_transfers WHERE tx_hash = $1")
            .bind(&tx)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(m, m2);
    // A disabled method with a live reservation is still watched.
    let mut tx_ = state.pg().begin().await.unwrap();
    let row: (i64, Value) =
        sqlx::query_as("SELECT version, config FROM payment_methods WHERE id = $1")
            .bind(m1)
            .fetch_one(&mut *tx_)
            .await
            .unwrap();
    let mut cfg = row.1.clone();
    cfg.as_object_mut()
        .unwrap()
        .retain(|k, _| !["rpc_count"].contains(&k.as_str()));
    pm::apply_update(
        &mut tx_,
        state.master_key(),
        &crate::audit::Actor::test(),
        m1,
        &pm::MethodReq {
            kind: None,
            version: Some(row.0),
            display_name: "USDT（Polygon）".into(),
            icon: None,
            sort: 0,
            enabled: false,
            config: cfg,
        },
    )
    .await
    .ok()
    .unwrap();
    tx_.commit().await.unwrap();
    crate::settings::reload(&state).await.unwrap();
    polygon.pay_token(usdt("polygon"), ADDR, units(&ra));
    polygon.mine(3);
    assert_eq!(round(&state).await.credited, 1);
    assert_eq!(order_status(&db, oa).await.0, "paid");
    drop(state);
    db.drop().await;
}

/// The cursor survives restarts (a new panel resumes where the last one
/// stopped); an RPC outage keeps it and records the error (no URL); a
/// node with a strict range limit gets halved ranges; catch-up after a
/// long outage spreads over rounds; the advisory lock lets one instance
/// run a round.
#[tokio::test]
async fn cursor_resume_outage_and_ranges() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = Node::start(137).await;
    let (state, method) = chain_state(&db, &node).await;
    let (_, plan) = priced_plan(&db, "chain", 3000, 30).await;
    let c = user_client(&state, db.user().await).await;
    let r = order_with(&c, plan, None).await;
    let order = order_id(&r);
    round(&state).await;
    let cursor = || async {
        sqlx::query_as::<_, (Option<i64>, Option<String>, bool)>(
            "SELECT next_block, last_error, failing_since IS NOT NULL FROM chain_cursors WHERE method_id = $1",
        )
        .bind(method)
        .fetch_one(&db.pool)
        .await
        .unwrap()
    };
    let (start, err, failing) = cursor().await;
    assert_eq!((err, failing), (None, false));
    // Outage: the round reports the method failed, the cursor stays.
    node.g().down = true;
    node.mine(50);
    let r = round(&state).await;
    assert_eq!((r.methods, r.failed), (1, 1));
    let (next, err, failing) = cursor().await;
    assert_eq!(next, start);
    assert!(failing);
    let err = err.unwrap();
    assert!(err.contains("HTTP 503"), "{err}");
    assert!(!err.contains("127.0.0.1"), "{err}");
    let l = user_client(&state, db.owner().await)
        .await
        .get(TRANSFERS)
        .await
        .json();
    assert!(l["watchers"][0]["failing_since"].is_string());
    // Back, with a strict range limit and a long gap; a new panel
    // instance resumes from the stored cursor.
    {
        let mut g = node.g();
        g.down = false;
        g.max_range = Some(8);
        g.head += 5_000;
    }
    let tx = node.pay_token(usdt("polygon"), ADDR, amount_of(&db, order).await);
    node.mine(3);
    let state2 =
        AppState::for_test_with(db.pool.clone(), |c| c.limits.chain_rpc_loopback = true).await;
    crate::settings::reload(&state2).await.unwrap();
    let mut credited = 0;
    let mut rounds = 0;
    while credited == 0 && rounds < 200 {
        credited += round(&state2).await.credited;
        rounds += 1;
    }
    assert_eq!(credited, 1, "caught up through halved ranges");
    assert!(rounds > 1, "catch-up spread over rounds");
    assert!(node.calls("eth_getLogs") > rounds);
    assert_eq!(order_status(&db, order).await.0, "paid");
    assert_eq!(transfer(&db, &tx).await.0, "credited");
    let (_, err, failing) = cursor().await;
    assert_eq!((err, failing), (None, false));
    // One instance per round: a held lock skips.
    let mut lock = db.pool.begin().await.unwrap();
    let won: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('akari.chain_watch.' || current_schema(), 0))",
    )
    .fetch_one(&mut *lock)
    .await
    .unwrap();
    assert!(won);
    assert!(watch::round(&state).await.unwrap().is_none());
    lock.rollback().await.unwrap();
    // A method whose RPC fails long enough turns the job red.
    node.g().down = true;
    round(&state).await;
    sqlx::query("UPDATE chain_cursors SET failing_since = now() - interval '1 hour'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(round(&state).await.failing_long, 1);
    drop(state2);
    drop(state);
    db.drop().await;
}

/// The exact amount reserved for an order.
async fn amount_of(db: &TestDb, order: Uuid) -> u128 {
    let u: i64 = sqlx::query_scalar("SELECT amount_units FROM chain_payments WHERE order_id = $1")
        .bind(order)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    u as u128
}

/// Every suffix of a base amount taken by live reservations: the order is
/// refused (503 order.chain_busy) and nothing is kept — no order row, no
/// reservation, the coupon/balance holds rolled back with it.
#[tokio::test]
async fn amounts_exhausted() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = Node::start(137).await;
    let (state, method) = chain_state(&db, &node).await;
    let (_, plan) = priced_plan(&db, "chain", 3000, 30).await;
    let c = user_client(&state, db.user().await).await;
    let r = order_with(&c, plan, None).await;
    let seed = order_id(&r);
    // 9999 more orders (copies of the first, ended) holding every suffix.
    sqlx::query(
        "INSERT INTO orders SELECT (jsonb_populate_record(o, jsonb_build_object(\
           'id', gen_random_uuid(), 'out_trade_no', 'AKX' || g, 'status', 'expired', \
           'ended_at', now(), 'last_query_at', now()))).* \
         FROM orders o, generate_series(1, 9999) g WHERE o.id = $1",
    )
    .bind(seed)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM chain_payments WHERE order_id = $1")
        .bind(seed)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO chain_payments (order_id, method_id, chain, token, address, amount_units, \
         rate_cents, confirmations, reserved_until) \
         SELECT o.id, $1, 'polygon', $2, $3, 4170000 + substr(o.out_trade_no, 4)::int, 720, 3, \
         now() + interval '1 day' FROM orders o WHERE o.out_trade_no LIKE 'AKX%'",
    )
    .bind(method)
    .bind(usdt("polygon"))
    .bind(ADDR)
    .execute(&db.pool)
    .await
    .unwrap();
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM orders")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let c2 = user_client(&state, db.user().await).await;
    let r = order_with(&c2, plan, None).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::SERVICE_UNAVAILABLE, json!("order.chain_busy"))
    );
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM orders")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(after, before);
    // A cheaper plan's base amount is free.
    let (_, cheap) = priced_plan(&db, "cheap", 720, 30).await;
    let r = order_with(&c2, cheap, None).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert!((1_000_001..=1_009_999).contains(&units(&r)));
    drop(state);
    db.drop().await;
}

/// The node's view moving under the re-check (block unknown, or another
/// hash than the receipt's) only delays; a settled transfer is not
/// settled again; two reservations whose windows hold the block time =
/// ambiguous (the admin decides); an incomplete method is reported, not
/// watched; a node refusing even one-block ranges fails the round; the
/// loop records the job on 系统状态.
#[tokio::test]
async fn delays_ambiguity_and_the_loop() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = Node::start(137).await;
    let (state, method) = chain_state(&db, &node).await;
    let (_, plan) = priced_plan(&db, "chain", 3000, 30).await;
    let c = user_client(&state, db.user().await).await;
    let r = order_with(&c, plan, None).await;
    let order = order_id(&r);
    round(&state).await;
    let tx = node.pay_token(usdt("polygon"), ADDR, units(&r));
    node.mine(3);
    node.g().block_null = true;
    assert_eq!(round(&state).await.credited, 0);
    {
        let mut g = node.g();
        g.block_null = false;
        g.block_forked = true;
    }
    assert_eq!(round(&state).await.credited, 0);
    node.g().block_forked = false;
    assert_eq!(round(&state).await.credited, 1);
    assert_eq!(order_status(&db, order).await.0, "paid");
    let id = transfer_id(&db, &tx).await;
    assert_eq!(
        watch::settle(&state, method, id, chrono::Utc::now())
            .await
            .ok(),
        Some(watch::Settled::Gone)
    );
    // Two windows hold the block time: the old (ended) reservation's
    // window still covers now and a new order has the same amount.
    let c2 = user_client(&state, db.user().await).await;
    let r2 = order_with(&c2, plan, None).await;
    sqlx::query("UPDATE chain_payments SET active = false WHERE order_id = $1")
        .bind(order)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE chain_payments SET amount_units = $2 WHERE order_id = $1")
        .bind(order_id(&r2))
        .bind(units(&r) as i64)
        .execute(&db.pool)
        .await
        .unwrap();
    let both = node.pay_token(usdt("polygon"), ADDR, units(&r));
    node.mine(3);
    assert_eq!(round(&state).await.unmatched, 1);
    assert_eq!(
        transfer(&db, &both).await,
        ("unmatched".into(), Some("ambiguous".into()), None)
    );
    assert_eq!(order_status(&db, order_id(&r2)).await.0, "pending");
    // A node that refuses every range fails the method's round.
    node.g().max_range = Some(0);
    node.mine(1);
    assert_eq!(round(&state).await.failed, 1);
    node.g().max_range = None;
    // An enabled method whose stored configuration lost a field.
    sqlx::query("UPDATE payment_methods SET config = config - 'rate_cents' WHERE id = $1")
        .bind(method)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(round(&state).await.methods, 0);
    let err: Option<String> =
        sqlx::query_scalar("SELECT last_error FROM chain_cursors WHERE method_id = $1")
            .bind(method)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(err.unwrap().contains("配置不完整"));
    // The loop: first tick at once, the job recorded (red: failing).
    sqlx::query("UPDATE chain_cursors SET failing_since = now() - interval '1 hour'")
        .execute(&db.pool)
        .await
        .unwrap();
    let task = tokio::spawn(watch::run(state.clone()));
    let mut seen = false;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if state
            .sysstatus()
            .jobs()
            .contains_key(&crate::sysstatus::Job::ChainPayments)
        {
            seen = true;
            break;
        }
    }
    task.abort();
    assert!(seen, "the loop recorded its round");
    drop(state);
    db.drop().await;
}
