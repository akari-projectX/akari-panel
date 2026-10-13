//! C2: USDT on-chain payments (Polygon PoS, Plasma), provider kind
//! `usdt_chain`.
//!
//! One payment method = one chain + one receiving address (EIP-55) + the
//! chain's USDT token contract + the operator's JSON-RPC endpoints (sealed
//! like a key: an RPC URL often embeds an API key) + a CNY rate. The
//! panel holds no private key: it only watches the address.
//!
//! - **Unique amount** (`reserve`, in the order-creation transaction):
//!   CNY cents → USDT at the method's rate (`rate_cents` = CNY fen per
//!   USDT) rounded UP to 0.01 USDT, plus a random suffix of 1–9999 base
//!   units (USDT has 6 decimals: the last four digits), so the exact
//!   amount is unique among this method's live reservations
//!   (`chain_payments_amount`, a partial unique index on active rows). A
//!   reservation lives until the order's expiry plus the method's grace
//!   (default 24 h): a late payment is still recognised and no new order
//!   gets the amount meanwhile.
//! - **Watcher** (`watch.rs`, one instance per round): `eth_getLogs` for
//!   the token's `Transfer` to the address, credited after the
//!   confirmation depth and a receipt + block re-check; the ONLY payment
//!   path stays `orders::apply_mark_paid` (paid_via `chain`).
//! - **Unmatched** transfers (no order, already paid, ambiguous) are kept
//!   for the admin to assign (audited) or ignore (`admin.rs`); never
//!   credited automatically.
//! - No notify, no close (`Close::NotClosable`), no refunds through the
//!   provider (refund to the balance or by hand).

pub mod admin;
pub mod rpc;
pub mod watch;

use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use super::provider::{
    BoxFut, CallError, Checkout, Close, CreateReq, NotifyCheck, PaymentProvider, ProviderKind,
    Query, TestOutcome, Validated,
};
use super::usdt::{eip55, evm_ok};
use crate::auth::{ApiError, api_error, bad_request, conflict};

pub const KIND: &str = "usdt_chain";
/// USDT (and USDT0) decimals on both chains (测试连接 checks the token).
pub const DECIMALS: u32 = 6;
/// Base units per 0.01 USDT: the suffix lives below this.
pub const CENT_UNITS: i64 = 10_000;
/// Transfers below 0.01 USDT are not recorded (dust / address poisoning).
pub const MIN_UNITS: i64 = CENT_UNITS;
/// Random suffixes tried before an order is refused (`order.chain_busy`).
const RESERVE_TRIES: usize = 32;
/// The most RPC endpoints of one method.
pub const MAX_RPC_URLS: usize = 4;

/// A supported chain: its id, chain id, canonical USDT contract and the
/// watcher's defaults.
#[derive(Debug, PartialEq, Eq)]
pub struct Chain {
    pub id: &'static str,
    pub label: &'static str,
    /// EIP-155 chain id (`eth_chainId`, checked by 测试连接).
    pub chain_id: u64,
    /// The canonical USDT token (EIP-55). Sources: docs.usdt0.to
    /// "Deployments" (Polygon PoS: "Token" 0xc2132D05…; Plasma: "Token"
    /// 0xB8CE59FC…, USDT0); see docs/PAYMENTS.md.
    pub usdt: &'static str,
    /// Default confirmations before crediting.
    pub confirmations: u32,
    /// Blocks read back when a method is watched for the first time
    /// (about an hour).
    pub lookback: u64,
}

pub static CHAINS: &[Chain] = &[
    Chain {
        id: "polygon",
        label: "Polygon PoS",
        chain_id: 137,
        usdt: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        // ~2 s blocks: about a minute, well past milestone finality.
        confirmations: 32,
        lookback: 1800,
    },
    Chain {
        id: "plasma",
        label: "Plasma",
        chain_id: 9745,
        usdt: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
        // ~1 s blocks, PlasmaBFT deterministic finality.
        confirmations: 10,
        lookback: 3600,
    },
];

pub fn chain(id: &str) -> Option<&'static Chain> {
    CHAINS.iter().find(|c| c.id == id)
}

/// A method's working configuration (non-secret parts + the RPC URLs).
#[derive(Clone)]
pub struct Params {
    pub chain: &'static Chain,
    /// Receiving address, EIP-55.
    pub address: String,
    /// Token contract, EIP-55 (the chain's USDT unless overridden).
    pub token: String,
    pub rpc_urls: Vec<String>,
    /// CNY fen per 1 USDT.
    pub rate_cents: i64,
    pub confirmations: u32,
    pub order_timeout_minutes: u32,
    pub grace_hours: u32,
    /// Blocks per `eth_getLogs` call.
    pub log_range: u64,
}

impl std::fmt::Debug for Params {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Params")
            .field("chain", &self.chain.id)
            .field("address", &self.address)
            .field("token", &self.token)
            .field("rpc_urls", &self.rpc_urls.len())
            .field("rate_cents", &self.rate_cents)
            .field("confirmations", &self.confirmations)
            .finish()
    }
}

impl Params {
    /// Lowercase forms (log matching).
    pub fn address_lc(&self) -> String {
        self.address.to_ascii_lowercase()
    }
    pub fn token_lc(&self) -> String {
        self.token.to_ascii_lowercase()
    }
    pub fn rpc(&self) -> rpc::Rpc {
        rpc::Rpc::new(self.rpc_urls.clone(), crate::outbound::chain_rpc_policy())
    }
}

/// `amount_units` as a decimal USDT string ("4.170123").
pub fn format_units(units: i64) -> String {
    let d = 10i64.pow(DECIMALS);
    format!("{}.{:06}", units / d, units % d)
}

/// The base amount (no suffix) of `amount_cents` CNY at `rate_cents` per
/// USDT, in base units: rounded UP to 0.01 USDT. None on overflow.
pub fn base_units(amount_cents: i64, rate_cents: i64) -> Option<i64> {
    if amount_cents <= 0 || rate_cents <= 0 {
        return None;
    }
    let usdt_cents = amount_cents.checked_mul(100)?.checked_add(rate_cents - 1)? / rate_cents;
    usdt_cents.checked_mul(CENT_UNITS)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct UsdtChain {
    params: Params,
}

impl UsdtChain {
    pub fn new(params: Params) -> Self {
        Self { params }
    }
}

/// 测试连接's verdict from what the RPC answered (pure).
pub fn judge_test(
    c: &Chain,
    chain_id: Result<u64, rpc::RpcError>,
    head: Result<u64, rpc::RpcError>,
    decimals: Result<u64, rpc::RpcError>,
) -> TestOutcome {
    // What was read, for the console (each null when unknown).
    let details = json!({
        "expected_chain_id": c.chain_id,
        "chain_id": chain_id.as_ref().ok(),
        "head": head.as_ref().ok(),
        "decimals": decimals.as_ref().ok(),
    });
    let out = |ok: bool, result: &'static str, message: String| TestOutcome {
        ok,
        result,
        message,
        code: None,
        sub_code: None,
        details: Some(details.clone()),
    };
    let id = match chain_id {
        Ok(id) => id,
        Err(e) => return out(false, "rpc_unreachable", format!("RPC 端点不可用：{e}")),
    };
    if id != c.chain_id {
        return out(
            false,
            "chain_mismatch",
            format!(
                "RPC 端点的链 ID 是 {id}，不是 {}（{}）：请填写该链的 RPC",
                c.chain_id, c.label
            ),
        );
    }
    let head = match head {
        Ok(h) => h,
        Err(e) => return out(false, "rpc_unreachable", format!("读取最新区块失败：{e}")),
    };
    match decimals {
        Ok(d) if d == u64::from(DECIMALS) => out(
            true,
            "rpc_ok",
            format!(
                "连接正常：{}（链 ID {id}），最新区块 {head}，代币合约为 {DECIMALS} 位小数",
                c.label
            ),
        ),
        Ok(d) => out(
            false,
            "token_invalid",
            format!("代币合约的小数位是 {d}，不是 USDT 的 {DECIMALS} 位：请检查合约地址"),
        ),
        Err(e) => out(
            false,
            "token_invalid",
            format!("读取代币合约失败（地址不是该链上的代币合约？）：{e}"),
        ),
    }
}

impl PaymentProvider for UsdtChain {
    fn kind(&self) -> &'static str {
        KIND
    }
    fn order_timeout_minutes(&self) -> u32 {
        self.params.order_timeout_minutes
    }
    /// The amount was reserved with the order (`reserve`); the payer is
    /// shown the address (the QR payload) and the exact amount.
    fn create<'a>(&'a self, _req: CreateReq<'a>) -> BoxFut<'a, Result<Checkout, CallError>> {
        Box::pin(async move { Ok(Checkout::Qr(self.params.address.clone())) })
    }
    /// The watcher is the only source of truth; polling has nothing to ask.
    fn query<'a>(&'a self, _otn: &'a str) -> BoxFut<'a, Result<Query, CallError>> {
        Box::pin(async { Ok(Query::NotExist) })
    }
    fn close<'a>(&'a self, _otn: &'a str) -> BoxFut<'a, Result<Close, CallError>> {
        Box::pin(async { Ok(Close::NotClosable) })
    }
    fn verify_notify(&self, _body: &[u8]) -> NotifyCheck {
        NotifyCheck::Rejected {
            verified: false,
            reason: "not_supported",
            out_trade_no: None,
            status: None,
            params: None,
        }
    }
    fn notify_ack(&self) -> &'static str {
        ""
    }
    fn chain(&self) -> Option<&Params> {
        Some(&self.params)
    }
    fn test_connection(&self) -> BoxFut<'_, TestOutcome> {
        Box::pin(async move {
            let rpc = self.params.rpc();
            let id = rpc.chain_id().await;
            let head = rpc.block_number().await;
            let dec = rpc.decimals(&self.params.token).await;
            judge_test(self.params.chain, id, head, dec)
        })
    }
}

// ---------------------------------------------------------------------------
// Kind (configuration)
// ---------------------------------------------------------------------------

pub struct UsdtChainKind;

const KNOWN: &[&str] = &[
    "chain",
    "address",
    "token_contract",
    "rpc_urls",
    "rate_cents",
    "confirmations",
    "order_timeout_minutes",
    "grace_hours",
    "log_range",
];

fn text_field(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// An optional integer field: absent/null = `default`; else within range.
fn int_field(
    v: &Value,
    k: &str,
    default: Option<i64>,
    range: std::ops::RangeInclusive<i64>,
) -> Result<Option<i64>, ()> {
    match v.get(k) {
        None | Some(Value::Null) => Ok(default),
        Some(x) => match x.as_i64() {
            Some(n) if range.contains(&n) => Ok(Some(n)),
            _ => Err(()),
        },
    }
}

/// The RPC URLs of a form value (whitespace, comma or newline separated):
/// 1..=MAX_RPC_URLS, each an allowed outbound target (https; the loopback
/// http form is accepted here and refused at call time unless the test
/// switch is on).
pub fn parse_rpc_urls(raw: &str) -> Option<Vec<String>> {
    let urls: Vec<String> = raw
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let loopback = crate::outbound::Policy {
        loopback_http: true,
    };
    let ok = !urls.is_empty()
        && urls.len() <= MAX_RPC_URLS
        && urls
            .iter()
            .all(|u| u.len() <= 512 && crate::outbound::target(u, loopback).is_ok());
    ok.then_some(urls)
}

fn rpc_urls_of(secrets: &Value) -> Option<Vec<String>> {
    let urls: Vec<String> = secrets
        .get("rpc_urls")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    (!urls.is_empty()).then_some(urls)
}

fn fixed() -> ApiError {
    conflict!(
        "payments.chain_fixed",
        "the chain, receiving address and token of a method cannot change once set; add a new method"
    )
}

/// The working parameters of a stored (config, secrets) pair.
pub fn params_of(config: &Value, secrets: &Value) -> Result<Params, String> {
    let chain = text_field(config, "chain")
        .and_then(|c| chain(&c))
        .ok_or("chain missing")?;
    let address = text_field(config, "address")
        .and_then(|a| eip55(&a))
        .ok_or("receiving address missing")?;
    let token = match text_field(config, "token_contract") {
        Some(t) => eip55(&t).ok_or("bad token contract")?,
        None => chain.usdt.to_string(),
    };
    let rate_cents = config
        .get("rate_cents")
        .and_then(Value::as_i64)
        .filter(|r| (1..=100_000).contains(r))
        .ok_or("rate missing")?;
    let rpc_urls = rpc_urls_of(secrets).ok_or("RPC endpoints missing")?;
    let int = |k: &str, d: u64| config.get(k).and_then(Value::as_u64).unwrap_or(d);
    Ok(Params {
        chain,
        address,
        token,
        rpc_urls,
        rate_cents,
        confirmations: int("confirmations", u64::from(chain.confirmations)).clamp(1, 1000) as u32,
        order_timeout_minutes: int("order_timeout_minutes", 30).clamp(10, 180) as u32,
        grace_hours: int("grace_hours", 24).clamp(1, 168) as u32,
        log_range: int("log_range", 500).clamp(1, 10_000),
    })
}

impl ProviderKind for UsdtChainKind {
    fn id(&self) -> &'static str {
        KIND
    }
    fn label(&self) -> &'static str {
        "USDT 链上收款"
    }
    fn schema(&self) -> Value {
        json!([
            {"name": "chain", "label": "网络", "type": "select", "required": true,
             "options": [{"value": "polygon", "label": "Polygon PoS（USDT）"},
                         {"value": "plasma", "label": "Plasma（USDT0）"}]},
            {"name": "address", "label": "收款地址（0x…，保存后不可修改）", "type": "text", "required": true},
            {"name": "token_contract", "label": "代币合约（留空 = 该网络的官方 USDT 合约）", "type": "text"},
            {"name": "rpc_urls", "label": "RPC 端点（https，最多 4 个，用空格或逗号分隔）", "type": "text",
             "secret": true, "required": true},
            {"name": "rate_cents", "label": "汇率（1 USDT = 多少分人民币，如 720 = ¥7.20）", "type": "number",
             "required": true},
            {"name": "confirmations", "label": "确认数（留空 = 默认：Polygon 32、Plasma 10）", "type": "number"},
            {"name": "order_timeout_minutes", "label": "订单有效期（分钟，10–180）", "type": "number",
             "required": true, "default": 30},
            {"name": "grace_hours", "label": "金额保留时长（订单结束后，小时，1–168）", "type": "number",
             "required": true, "default": 24},
            {"name": "log_range", "label": "每次查询的区块数（1–10000，RPC 限制较严时调小）", "type": "number",
             "required": true, "default": 500}
        ])
    }

    fn validate(
        &self,
        input: &Value,
        prev: Option<(&Value, &Value)>,
        complete: bool,
    ) -> Result<Validated, ApiError> {
        let Some(obj) = input.as_object() else {
            return Err(bad_request!(
                "payments.config_invalid",
                "config must be an object"
            ));
        };
        if let Some(k) = obj.keys().find(|k| !KNOWN.contains(&k.as_str())) {
            return Err(bad_request!(
                "payments.config_unknown_field",
                "unknown config field: {field}",
                field = k.chars().take(64).collect::<String>()
            ));
        }
        let chain_id = text_field(input, "chain").unwrap_or_else(|| "polygon".into());
        let c = chain(&chain_id).ok_or_else(|| {
            bad_request!("payments.chain_invalid", "chain must be polygon or plasma")
        })?;
        let address = match text_field(input, "address") {
            None => None,
            Some(a) => Some(
                eip55(&a)
                    .filter(|_| evm_ok(&a))
                    .filter(|a| a != "0x0000000000000000000000000000000000000000")
                    .ok_or_else(|| {
                        bad_request!(
                            "payments.chain_address_invalid",
                            "the receiving address is not a valid EVM address (0x + 40 hex, EIP-55 checksum when mixed case)"
                        )
                    })?,
            ),
        };
        let token = match text_field(input, "token_contract") {
            None => None,
            Some(t) => Some(eip55(&t).filter(|_| evm_ok(&t)).ok_or_else(|| {
                bad_request!(
                    "payments.chain_token_invalid",
                    "the token contract is not a valid EVM address"
                )
            })?),
        };
        let effective_token = token.clone().unwrap_or_else(|| c.usdt.to_string());
        // The receiver of a method never changes once saved (its orders
        // and transfers belong to it).
        if let Some((pc, _)) = prev
            && let Some(prev_addr) = text_field(pc, "address")
        {
            let prev_chain = text_field(pc, "chain").unwrap_or_default();
            let prev_token = text_field(pc, "token_contract")
                .or_else(|| chain(&prev_chain).map(|c| c.usdt.to_string()))
                .unwrap_or_default();
            let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
            if prev_chain != c.id
                || !address.as_deref().is_some_and(|a| same(a, &prev_addr))
                || !same(&prev_token, &effective_token)
            {
                return Err(fixed());
            }
        }
        let new_urls = match text_field(input, "rpc_urls") {
            None => None,
            Some(raw) => Some(parse_rpc_urls(&raw).ok_or_else(|| {
                bad_request!(
                    "payments.chain_rpc_invalid",
                    "RPC endpoints must be 1-{max} https URLs (no user info)",
                    max = MAX_RPC_URLS
                )
            })?),
        };
        let range_err = |field: &'static str| {
            bad_request!(
                "payments.chain_number_invalid",
                "{field} is out of range",
                field = field
            )
        };
        let rate = int_field(input, "rate_cents", None, 1..=100_000)
            .map_err(|_| range_err("rate_cents"))?;
        let confirmations = int_field(input, "confirmations", None, 1..=1000)
            .map_err(|_| range_err("confirmations"))?;
        let timeout = int_field(input, "order_timeout_minutes", Some(30), 10..=180)
            .map_err(|_| range_err("order_timeout_minutes"))?;
        let grace = int_field(input, "grace_hours", Some(24), 1..=168)
            .map_err(|_| range_err("grace_hours"))?;
        let log_range = int_field(input, "log_range", Some(500), 1..=10_000)
            .map_err(|_| range_err("log_range"))?;
        let prev_secrets = prev.map(|(_, s)| s);
        let urls = new_urls
            .clone()
            .or_else(|| prev_secrets.and_then(rpc_urls_of));
        if complete && (address.is_none() || urls.is_none() || rate.is_none()) {
            return Err(conflict!(
                "payments.incomplete",
                "enabling needs the receiving address, the RPC endpoints and the rate"
            ));
        }
        let config = json!({
            "chain": c.id,
            "address": address,
            "token_contract": token,
            "rate_cents": rate,
            "confirmations": confirmations,
            "order_timeout_minutes": timeout,
            "grace_hours": grace,
            "log_range": log_range,
            "rpc_count": urls.as_ref().map(Vec::len),
        });
        let mut secrets = prev_secrets.cloned().unwrap_or_else(|| json!({}));
        let mut changed = Vec::new();
        if let Some(u) = new_urls {
            secrets["rpc_urls"] = json!(u);
            changed.push("rpc_urls");
        }
        Ok(Validated {
            config,
            secrets,
            changed_secrets: changed,
        })
    }

    fn build(&self, config: &Value, secrets: &Value) -> Result<Arc<dyn PaymentProvider>, String> {
        Ok(Arc::new(UsdtChain::new(params_of(config, secrets)?)))
    }

    fn view(&self, config: &Value, secrets: Option<&Value>) -> Value {
        let c = text_field(config, "chain").and_then(|c| chain(&c));
        let mut v = json!({});
        for k in [
            "chain",
            "address",
            "token_contract",
            "rate_cents",
            "confirmations",
            "order_timeout_minutes",
            "grace_hours",
            "log_range",
            "rpc_count",
        ] {
            v[k] = config.get(k).cloned().unwrap_or(Value::Null);
        }
        if let Some(c) = c {
            v["chain_label"] = json!(c.label);
            v["chain_id"] = json!(c.chain_id);
            v["token_default"] = json!(c.usdt);
            v["confirmations_default"] = json!(c.confirmations);
            v["token_effective"] =
                json!(text_field(config, "token_contract").unwrap_or_else(|| c.usdt.to_string()));
            v["confirmations_effective"] = json!(
                config
                    .get("confirmations")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::from(c.confirmations))
            );
        }
        v["rpc_urls_set"] = Value::Bool(secrets.is_some_and(|s| s.get("rpc_urls").is_some()));
        v["rpc_urls_readable"] = Value::Bool(secrets.and_then(rpc_urls_of).is_some());
        v
    }

    fn peek_out_trade_no(&self, _body: &[u8]) -> Option<String> {
        None
    }

    fn default_icon(&self, _config: &Value) -> Option<&'static str> {
        Some("usdt")
    }
}

// ---------------------------------------------------------------------------
// Amount reservation (order creation)
// ---------------------------------------------------------------------------

/// Reserve a unique exact amount for `order_id` (pending, its row already
/// inserted in this transaction) on `method_id`. Returns the base units.
/// The caller holds `entitle::lock` (order creation); the partial unique
/// index is the guarantee either way.
pub async fn reserve(
    conn: &mut PgConnection,
    method_id: Uuid,
    order_id: Uuid,
    amount_cents: i64,
    p: &Params,
) -> Result<i64, ApiError> {
    let base = base_units(amount_cents, p.rate_cents)
        .ok_or_else(|| anyhow::anyhow!("chain amount out of range"))?;
    // Reservations past their window give their amounts back.
    sqlx::query(
        "UPDATE chain_payments SET active = false \
         WHERE method_id = $1 AND active AND reserved_until <= now()",
    )
    .bind(method_id)
    .execute(&mut *conn)
    .await?;
    for _ in 0..RESERVE_TRIES {
        let units = base + rand::random_range(1..CENT_UNITS);
        let got: Option<i64> = sqlx::query_scalar(
            "INSERT INTO chain_payments (order_id, method_id, chain, token, address, \
             amount_units, rate_cents, confirmations, reserved_until) \
             SELECT $1, $2, $3, $4, $5, $6, $7, $8, o.expires_at + make_interval(hours => $9) \
             FROM orders o WHERE o.id = $1 \
             ON CONFLICT (method_id, amount_units) WHERE active DO NOTHING \
             RETURNING amount_units",
        )
        .bind(order_id)
        .bind(method_id)
        .bind(p.chain.id)
        .bind(&p.token)
        .bind(&p.address)
        .bind(units)
        .bind(p.rate_cents as i32)
        .bind(p.confirmations as i32)
        .bind(p.grace_hours as i32)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(u) = got {
            return Ok(u);
        }
    }
    Err(api_error!(
        SERVICE_UNAVAILABLE,
        "order.chain_busy",
        "no unique payment amount is free right now, try again later"
    ))
}

/// SQL (in a query `FROM orders`): the on-chain payment of the order as
/// JSON (null for other orders): what the payer must send, where, and the
/// latest transfer seen for it with its confirmations. A macro so the
/// order views can `concat!` it into their constant SQL.
macro_rules! order_chain_sql {
    () => {
        "(SELECT jsonb_build_object(\
     'chain', cp.chain, 'token', cp.token, 'address', cp.address, \
     'amount_units', cp.amount_units, \
     'amount', (cp.amount_units / 1000000)::text || '.' || lpad((cp.amount_units % 1000000)::text, 6, '0'), \
     'rate_cents', cp.rate_cents, 'confirmations_required', cp.confirmations, \
     'reserved_until', cp.reserved_until, \
     'transfer', (SELECT jsonb_build_object('tx_hash', t.tx_hash, 'status', t.status, \
         'block_number', t.block_number, \
         'confirmations', GREATEST(0, LEAST(COALESCE(c.head - t.block_number + 1, 0), 1000000))) \
       FROM chain_transfers t LEFT JOIN chain_cursors c ON c.method_id = t.method_id \
       WHERE t.order_id = cp.order_id AND t.status IN ('pending', 'credited', 'assigned') \
       ORDER BY t.id DESC LIMIT 1)) \
     FROM chain_payments cp WHERE cp.order_id = orders.id)"
    };
}
pub(crate) use order_chain_sql;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_contracts_are_checksummed() {
        for c in CHAINS {
            assert_eq!(eip55(c.usdt).as_deref(), Some(c.usdt), "{}", c.id);
            assert!(evm_ok(c.usdt));
        }
        assert_eq!(chain("polygon").map(|c| c.chain_id), Some(137));
        assert_eq!(chain("plasma").map(|c| c.chain_id), Some(9745));
        assert!(chain("tron").is_none());
    }

    #[test]
    fn amounts_round_up_to_the_cent_and_format() {
        // ¥30.00 at ¥7.20 = 4.1666… → 4.17 USDT.
        assert_eq!(base_units(3000, 720), Some(4_170_000));
        // Exact: ¥7.20 at ¥7.20 = 1.00.
        assert_eq!(base_units(720, 720), Some(1_000_000));
        // One fen = 0.0013… → 0.01.
        assert_eq!(base_units(1, 720), Some(10_000));
        assert_eq!(base_units(0, 720), None);
        assert_eq!(base_units(100, 0), None);
        assert_eq!(base_units(i64::MAX, 1), None);
        assert_eq!(format_units(4_170_123), "4.170123");
        assert_eq!(format_units(10_000), "0.010000");
        assert_eq!(format_units(12_000_000_001), "12000.000001");
    }

    #[test]
    fn rpc_url_lists() {
        assert_eq!(
            parse_rpc_urls("https://a.example/rpc, https://b.example/key/x\nhttps://c.example"),
            Some(vec![
                "https://a.example/rpc".into(),
                "https://b.example/key/x".into(),
                "https://c.example".into()
            ])
        );
        assert!(parse_rpc_urls("http://127.0.0.1:8545/").is_some());
        for bad in [
            "",
            "http://rpc.example/",
            "https://u:p@rpc.example/",
            "ftp://rpc.example/",
            "https://a.example https://b.example https://c.example https://d.example https://e.example",
        ] {
            assert!(parse_rpc_urls(bad).is_none(), "{bad}");
        }
        let long = format!("https://a.example/{}", "x".repeat(600));
        assert!(parse_rpc_urls(&long).is_none());
    }

    fn ok_test(c: &Chain, id: u64, dec: Result<u64, rpc::RpcError>) -> TestOutcome {
        judge_test(c, Ok(id), Ok(100), dec)
    }

    #[test]
    fn connection_verdicts() {
        let p = chain("polygon").unwrap();
        assert_eq!(ok_test(p, 137, Ok(6)).result, "rpc_ok");
        assert_eq!(
            ok_test(p, 137, Ok(6)).details,
            Some(json!({"expected_chain_id": 137, "chain_id": 137, "head": 100, "decimals": 6}))
        );
        assert_eq!(
            ok_test(p, 9745, Ok(6)).details.unwrap()["chain_id"],
            json!(9745)
        );
        assert!(ok_test(p, 137, Ok(6)).ok);
        assert_eq!(ok_test(p, 9745, Ok(6)).result, "chain_mismatch");
        assert_eq!(ok_test(p, 137, Ok(18)).result, "token_invalid");
        assert_eq!(
            ok_test(p, 137, Err(rpc::RpcError::Malformed("decimals"))).result,
            "token_invalid"
        );
        let down = || Err(rpc::RpcError::Transport("timed out".into()));
        assert_eq!(
            judge_test(p, down(), down(), down()).result,
            "rpc_unreachable"
        );
        assert_eq!(
            judge_test(p, Ok(137), down(), Ok(6)).result,
            "rpc_unreachable"
        );
    }

    #[test]
    fn config_validation() {
        let k = UsdtChainKind;
        let addr = "0x52908400098527886E0F7030069857D2E4169EE7"; // EIP-55 vector
        let ok = json!({"chain": "plasma", "address": addr.to_lowercase(),
                        "rpc_urls": "https://rpc.example/k1", "rate_cents": 720});
        let v = k.validate(&ok, None, true).unwrap();
        assert_eq!(v.config["address"], addr, "stored checksummed");
        assert_eq!(v.config["token_contract"], Value::Null);
        assert_eq!(v.config["rpc_count"], 1);
        assert_eq!(v.config["order_timeout_minutes"], 30);
        assert_eq!(v.secrets["rpc_urls"], json!(["https://rpc.example/k1"]));
        assert_eq!(v.changed_secrets, vec!["rpc_urls"]);
        assert!(!v.config.to_string().contains("rpc.example"));
        let p = params_of(&v.config, &v.secrets).unwrap();
        assert_eq!(
            (p.chain.id, p.confirmations, p.token.as_str()),
            ("plasma", 10, chain("plasma").unwrap().usdt)
        );
        assert_eq!(p.grace_hours, 24);
        assert!(format!("{p:?}").contains("rpc_urls: 1"));
        assert!(!format!("{p:?}").contains("rpc.example"));
        let view = k.view(&v.config, Some(&v.secrets));
        assert_eq!(view["rpc_urls_set"], true);
        assert_eq!(view["chain_id"], 9745);
        assert_eq!(view["confirmations_effective"], 10);
        assert!(!view.to_string().contains("rpc.example"));
        assert_eq!(k.default_icon(&v.config), Some("usdt"));
        assert_eq!(k.peek_out_trade_no(b"x"), None);
        // Editing keeps the secret, refuses another receiver.
        let mut edit = ok.clone();
        edit.as_object_mut().unwrap().remove("rpc_urls");
        edit["confirmations"] = json!(20);
        let e = k
            .validate(&edit, Some((&v.config, &v.secrets)), true)
            .unwrap();
        assert_eq!(e.secrets["rpc_urls"], json!(["https://rpc.example/k1"]));
        assert!(e.changed_secrets.is_empty());
        for (field, value) in [
            (
                "address",
                json!("0x1111111111111111111111111111111111111111"),
            ),
            ("chain", json!("polygon")),
            (
                "token_contract",
                json!("0x1111111111111111111111111111111111111111"),
            ),
        ] {
            let mut x = edit.clone();
            x[field] = value;
            let err = k
                .validate(&x, Some((&v.config, &v.secrets)), true)
                .unwrap_err();
            assert_eq!(err.code(), "payments.chain_fixed", "{field}");
        }
        // Naming the default contract explicitly is the same token.
        let mut same = edit.clone();
        same["token_contract"] = json!(chain("plasma").unwrap().usdt.to_lowercase());
        assert!(
            k.validate(&same, Some((&v.config, &v.secrets)), true)
                .is_ok()
        );
        // A draft without an address may still choose its chain.
        let draft = k
            .validate(&json!({"chain": "polygon"}), None, false)
            .unwrap();
        let mut later = ok.clone();
        later["chain"] = json!("plasma");
        assert!(
            k.validate(&later, Some((&draft.config, &draft.secrets)), true)
                .is_ok()
        );
        let codes = |cfg: Value, complete: bool| {
            k.validate(&cfg, None, complete)
                .unwrap_err()
                .code()
                .to_string()
        };
        assert_eq!(codes(json!([]), false), "payments.config_invalid");
        assert_eq!(
            codes(json!({"x": 1}), false),
            "payments.config_unknown_field"
        );
        assert_eq!(
            codes(json!({"chain": "tron"}), false),
            "payments.chain_invalid"
        );
        // Wrong checksum (one letter's case flipped), zero address, junk.
        for a in [
            "0x52908400098527886E0F7030069857D2E4169Ee7",
            "0x0000000000000000000000000000000000000000",
            "0x123",
        ] {
            assert_eq!(
                codes(json!({"address": a}), false),
                "payments.chain_address_invalid",
                "{a}"
            );
        }
        assert_eq!(
            codes(json!({"token_contract": "0xzz"}), false),
            "payments.chain_token_invalid"
        );
        assert_eq!(
            codes(json!({"rpc_urls": "http://x.example"}), false),
            "payments.chain_rpc_invalid"
        );
        for (f, v) in [
            ("rate_cents", json!(0)),
            ("rate_cents", json!("720")),
            ("confirmations", json!(1001)),
            ("order_timeout_minutes", json!(5)),
            ("grace_hours", json!(169)),
            ("log_range", json!(0)),
        ] {
            assert_eq!(
                codes(json!({ f: v }), false),
                "payments.chain_number_invalid",
                "{f}"
            );
        }
        assert_eq!(codes(json!({"address": addr}), true), "payments.incomplete");
        assert!(params_of(&json!({}), &json!({})).is_err());
        assert!(k.build(&v.config, &json!({})).is_err());
        assert!(k.view(&json!({}), None)["chain_label"].is_null());
    }

    #[tokio::test]
    async fn provider_surface() {
        let k = UsdtChainKind;
        let v = k
            .validate(
                &json!({"chain": "polygon", "address": "0x52908400098527886E0F7030069857D2E4169EE7",
                        "rpc_urls": "https://127.0.0.1/never", "rate_cents": 700, "order_timeout_minutes": 45}),
                None,
                true,
            )
            .unwrap();
        let p = k.build(&v.config, &v.secrets).unwrap();
        assert_eq!((p.kind(), p.order_timeout_minutes()), (KIND, 45));
        assert_eq!(p.query("AK1").await.unwrap(), Query::NotExist);
        assert_eq!(p.close("AK1").await.unwrap(), Close::NotClosable);
        assert!(matches!(
            p.verify_notify(b"x"),
            NotifyCheck::Rejected { .. }
        ));
        assert_eq!(p.notify_ack(), "");
        assert!(!p.refunds());
        assert_eq!(p.chain().map(|c| c.rate_cents), Some(700));
        let c = p
            .create(CreateReq {
                out_trade_no: "AK1",
                amount_cents: 100,
                subject: "s",
                notify_url: "",
                return_url: "",
                client_ip: None,
            })
            .await
            .unwrap();
        assert_eq!(
            c,
            Checkout::Qr("0x52908400098527886E0F7030069857D2E4169EE7".into())
        );
        // The endpoint is not public: 测试连接 says so, without the URL.
        let t = p.test_connection().await;
        assert_eq!((t.ok, t.result), (false, "rpc_unreachable"));
        assert!(!t.message.contains("127.0.0.1/never"));
    }
}
