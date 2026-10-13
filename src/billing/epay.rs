//! C1: 易支付 (EPay) as a payment provider kind (`epay`): the widely
//! deployed 彩虹易支付-style merchant interface, version 1 (MD5 signature).
//! One method = one merchant (`pid` + key) and one channel (`type`:
//! alipay / wxpay / qqpay); an operator adds one method per channel (and
//! per merchant), so the portal's method picker is the only choice the
//! payer makes and every order is settled by exactly one channel.
//!
//! Calls (`<api>` = the configured interface address, ending in `/`):
//! - create, API mode (default): POST `<api>mapi.php` (form) → JSON
//!   `{"code": 1, "trade_no", "payurl" | "qrcode" | "urlscheme"}`:
//!   `payurl` → the payer is sent there, `qrcode` → the portal shows it.
//!   A business refusal (`code` ≠ 1) or an answer without a usable link
//!   falls back to the page mode for that order (some merchants have the
//!   API mode disabled); transport / HTTP / parse failures do not.
//! - create, page mode: the signed `<api>submit.php?…` URL itself (no
//!   call: the payer's browser goes there).
//! - query: GET `<api>api.php?act=order&pid=…&key=…&out_trade_no=…` →
//!   `{"code": 1, "status": 1 | 0, "money", "trade_no", …}`; a refusal
//!   whose message says the order does not exist = no trade. The interface
//!   takes the merchant key as a query parameter (that is the EPay API), so
//!   the URL is never logged and the transport is https (loopback http only
//!   for tests).
//! - notify: GET (query string, the common case) or POST (form) to the
//!   method's notify URL with `pid, trade_no, out_trade_no, type, name,
//!   money, trade_status, sign, sign_type`; answered `success`.
//! - no close call (`Close::NotClosable`) and no refund through EPay
//!   (`refunds()` = false): EPay's optional `act=refund` has no request
//!   number and no refund query, so a retry after a lost answer could
//!   refund twice — refunds go to the balance or are made by hand.
//!
//! Signature (MD5): every parameter except `sign`, `sign_type` and empty
//! values, sorted by name (byte order), joined as `k=v` with `&` (raw
//! values, not URL-encoded), the merchant key appended directly (no
//! separator), MD5, lower-case hex: `sign = md5("a=1&b=2" + KEY)`.
//!
//! Secrets: the key never leaves `Epay` (no Debug); request URLs and
//! bodies (they carry the key or the notify URL) are never logged.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use md5::Digest as _;
use serde_json::Value;
use subtle::ConstantTimeEq as _;

use super::alipay::{format_cents, gateway_ok, parse_amount};
use super::provider::{
    BoxFut, CallError, Checkout, Close, CreateReq, NotifyCheck, NotifyEvent, PaymentProvider,
    ProviderKind, Query, TestOutcome, Validated,
};
use crate::auth::{ApiError, bad_request, conflict};

/// Kind id of EPay.
pub const KIND: &str = "epay";
/// Gateway call timeout (connect + TLS + request + response).
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// Attempts per query (transport errors / non-200 only; a query is
/// harmless to repeat, a create is not retried).
const QUERY_ATTEMPTS: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_millis(300);
/// Longest payment link stored (`orders.pay_url` CHECK).
pub const MAX_LINK: usize = 2048;
/// Longest QR payload accepted from the gateway.
pub const MAX_QR: usize = 1024;
/// Longest product name sent (`name`).
pub const MAX_NAME: usize = 64;
/// Longest merchant key accepted.
pub const MAX_KEY: usize = 128;

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/// The string the MD5 covers (without the key): every parameter except
/// `sign`, `sign_type` and empty values, sorted, `k=v` joined with `&`.
pub fn sign_content(params: &BTreeMap<String, String>) -> String {
    params
        .iter()
        .filter(|(k, v)| k.as_str() != "sign" && k.as_str() != "sign_type" && !v.is_empty())
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// `md5(sign_content + key)`, lower-case hex.
pub fn sign(params: &BTreeMap<String, String>, key: &str) -> String {
    let mut h = md5::Md5::new();
    h.update(sign_content(params).as_bytes());
    h.update(key.as_bytes());
    hex::encode(h.finalize())
}

/// The parameters carry a valid MD5 signature under `key` (`sign_type`
/// MD5; the hex digest compared in constant time, either case).
pub fn verify(params: &BTreeMap<String, String>, key: &str) -> bool {
    if params.get("sign_type").map(String::as_str) != Some("MD5") {
        return false;
    }
    let Some(given) = params.get("sign") else {
        return false;
    };
    let want = sign(params, key);
    let given = given.to_ascii_lowercase();
    given.len() == want.len() && bool::from(given.as_bytes().ct_eq(want.as_bytes()))
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// The channel (`type`) of a method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Alipay,
    Wxpay,
    Qqpay,
}

impl Channel {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "alipay" => Some(Self::Alipay),
            "wxpay" => Some(Self::Wxpay),
            "qqpay" => Some(Self::Qqpay),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Alipay => "alipay",
            Self::Wxpay => "wxpay",
            Self::Qqpay => "qqpay",
        }
    }
    /// The portal icon name of the channel.
    pub fn icon(self) -> &'static str {
        match self {
            Self::Alipay => "alipay",
            Self::Wxpay => "wechat",
            Self::Qqpay => "qq",
        }
    }
}

/// How a trade is created.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// `mapi.php` (falls back to the page for a refused trade).
    Api,
    /// `submit.php` (the payer's browser is sent to the signed URL).
    Page,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "mapi" => Some(Self::Api),
            "submit" => Some(Self::Page),
            _ => None,
        }
    }
}

/// The non-secret parameters of a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Params {
    /// The interface address, ending in `/`.
    pub api_url: String,
    pub pid: String,
    pub channel: Channel,
    pub mode: Mode,
    /// Sent as `name` instead of the order subject.
    pub product_name: Option<String>,
    pub order_timeout_minutes: u32,
}

pub struct Epay {
    pub params: Params,
    key: String,
}

impl std::fmt::Debug for Epay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Epay")
            .field("pid", &self.params.pid)
            .field("channel", &self.params.channel)
            .finish_non_exhaustive()
    }
}

/// An integer code of a gateway answer (`1` or `"1"`).
fn int_of(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// A text field of a gateway answer (strings, or numbers as text).
fn text_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// A gateway message for logs and the admin (capped, no control chars).
fn message_of(obj: &Value) -> String {
    text_of(obj.get("msg"))
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect()
}

/// A refusal of a gateway answer.
fn refusal(obj: &Value) -> CallError {
    CallError::Business {
        code: text_of(obj.get("code")).unwrap_or_default(),
        sub_code: String::new(),
        sub_msg: message_of(obj),
        verified: false,
    }
}

/// The message of a query refusal says the order does not exist (and not
/// that the merchant does not).
fn says_no_order(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    let no_such = msg.contains("不存在") || m.contains("not exist") || m.contains("not found");
    no_such && !msg.contains("商户") && !m.contains("merchant") && !m.contains("pid")
}

/// Parse a query answer (`api.php?act=order`) for `out_trade_no` of
/// merchant `pid` (pure).
pub fn parse_query(body: &[u8], pid: &str, out_trade_no: &str) -> Result<Query, CallError> {
    let obj: Value = serde_json::from_slice(body).map_err(|_| CallError::Malformed("not JSON"))?;
    if !obj.is_object() {
        return Err(CallError::Malformed("not an object"));
    }
    if int_of(obj.get("code")) != Some(1) {
        if says_no_order(&message_of(&obj)) {
            return Ok(Query::NotExist);
        }
        return Err(refusal(&obj));
    }
    if text_of(obj.get("out_trade_no")).is_some_and(|o| o != out_trade_no) {
        return Err(CallError::Malformed("query answered another order"));
    }
    if text_of(obj.get("pid")).is_some_and(|p| p != pid) {
        return Err(CallError::Malformed("query answered another merchant"));
    }
    let paid = int_of(obj.get("status")) == Some(1);
    Ok(Query::Trade {
        status: if paid { "TRADE_SUCCESS" } else { "NOTPAY" }.to_string(),
        paid,
        trade_no: text_of(obj.get("trade_no")).unwrap_or_default(),
        total_cents: text_of(obj.get("money")).and_then(|m| parse_amount(&m)),
    })
}

/// A payment link of a create answer: http(s), bounded, no whitespace.
fn link_ok(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && url.len() <= MAX_LINK
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Parse a `mapi.php` answer (pure): Ok(Some) = how to pay; Ok(None) =
/// the gateway refused this trade in API mode or gave no usable link
/// (fall back to the page); Err = the gateway is not answering sensibly.
pub fn parse_create(body: &[u8]) -> Result<Option<Checkout>, CallError> {
    let obj: Value = serde_json::from_slice(body).map_err(|_| CallError::Malformed("not JSON"))?;
    if !obj.is_object() {
        return Err(CallError::Malformed("not an object"));
    }
    if int_of(obj.get("code")) != Some(1) {
        tracing::warn!(
            message = %message_of(&obj),
            "epay api mode refused the trade; using the payment page"
        );
        return Ok(None);
    }
    if let Some(u) = text_of(obj.get("payurl")).filter(|u| link_ok(u)) {
        return Ok(Some(Checkout::Redirect(u)));
    }
    if let Some(q) = text_of(obj.get("qrcode"))
        .filter(|q| !q.is_empty() && q.len() <= MAX_QR && !q.chars().any(char::is_control))
    {
        return Ok(Some(Checkout::Qr(q)));
    }
    Ok(None)
}

/// Interpret the 测试连接 query (pure; unit-tested).
pub fn judge_test(r: Result<Query, CallError>) -> TestOutcome {
    let out = |ok, result, message: String, code: Option<String>| TestOutcome {
        ok,
        result,
        message,
        code,
        sub_code: None,
        details: None,
    };
    match r {
        Ok(_) => out(
            true,
            "keys_ok",
            "连接正常：易支付接受了商户 ID 与密钥（订单查询接口可用）".into(),
            None,
        ),
        Err(CallError::Business { code, sub_msg, .. }) => {
            let lower = sub_msg.to_ascii_lowercase();
            let c = Some(code.clone()).filter(|c| !c.is_empty());
            if lower.contains("key") || sub_msg.contains("密钥") || sub_msg.contains("签名") {
                out(
                    false,
                    "key_rejected",
                    format!("易支付拒绝了商户密钥，请核对密钥：{sub_msg}"),
                    c,
                )
            } else if sub_msg.contains("商户")
                || lower.contains("pid")
                || lower.contains("merchant")
            {
                out(
                    false,
                    "pid_invalid",
                    format!("易支付不认这个商户 ID，请核对商户 ID：{sub_msg}"),
                    c,
                )
            } else {
                out(
                    false,
                    "other",
                    format!("易支付返回错误 {code}：{sub_msg}"),
                    c,
                )
            }
        }
        Err(CallError::Transport(_)) => out(
            false,
            "unreachable",
            "无法连接易支付接口（网络或 DNS 问题，或接口地址有误）".into(),
            None,
        ),
        Err(CallError::Status(st)) => out(
            false,
            "gateway_status",
            format!("易支付接口返回 HTTP {st}：请检查接口地址"),
            None,
        ),
        Err(CallError::Malformed(_)) => out(
            false,
            "malformed",
            "易支付接口的响应无法解析（接口地址是否正确？）".into(),
            None,
        ),
        Err(CallError::BadSignature | CallError::Unsupported) => {
            out(false, "other", "不支持的操作".into(), None)
        }
    }
}

impl Epay {
    pub fn new(params: Params, key: String) -> Self {
        Self { params, key }
    }

    /// The signed parameters of a trade (`clientip` only in API mode).
    pub fn create_params(&self, req: &CreateReq<'_>, api: bool) -> BTreeMap<String, String> {
        let name: String = self
            .params
            .product_name
            .as_deref()
            .unwrap_or(req.subject)
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_NAME)
            .collect();
        let mut p = BTreeMap::new();
        p.insert("pid".to_string(), self.params.pid.clone());
        p.insert("type".to_string(), self.params.channel.as_str().to_string());
        p.insert("out_trade_no".to_string(), req.out_trade_no.to_string());
        p.insert("notify_url".to_string(), req.notify_url.to_string());
        p.insert("return_url".to_string(), req.return_url.to_string());
        p.insert("name".to_string(), name);
        p.insert("money".to_string(), format_cents(req.amount_cents));
        if api && let Some(ip) = req.client_ip {
            p.insert("clientip".to_string(), ip.to_string());
        }
        let s = sign(&p, &self.key);
        p.insert("sign".to_string(), s);
        p.insert("sign_type".to_string(), "MD5".to_string());
        p
    }

    fn encode(p: &BTreeMap<String, String>) -> String {
        let mut ser = form_urlencoded::Serializer::new(String::new());
        for (k, v) in p {
            ser.append_pair(k, v);
        }
        ser.finish()
    }

    /// The page-mode payment link: `<api>submit.php?<signed params>`.
    pub fn submit_url(&self, req: &CreateReq<'_>) -> Result<String, CallError> {
        let url = format!(
            "{}submit.php?{}",
            self.params.api_url,
            Self::encode(&self.create_params(req, false))
        );
        if url.len() > MAX_LINK {
            return Err(CallError::Malformed("payment link too long"));
        }
        Ok(url)
    }

    /// Create a trade (see the module docs for the modes).
    pub async fn create(&self, req: &CreateReq<'_>) -> Result<Checkout, CallError> {
        if self.params.mode == Mode::Api {
            let body = Self::encode(&self.create_params(req, true));
            let url = format!("{}mapi.php", self.params.api_url);
            let (status, bytes) = super::http::post_form(&url, body, CALL_TIMEOUT)
                .await
                .map_err(CallError::Transport)?;
            if status != 200 {
                return Err(CallError::Status(status));
            }
            if let Some(c) = parse_create(&bytes)? {
                return Ok(c);
            }
        }
        self.submit_url(req).map(Checkout::Redirect)
    }

    /// The query URL of a trade (carries the key: never log it).
    pub fn query_url(&self, out_trade_no: &str) -> String {
        let mut ser = form_urlencoded::Serializer::new(String::new());
        ser.append_pair("act", "order")
            .append_pair("pid", &self.params.pid)
            .append_pair("key", &self.key)
            .append_pair("out_trade_no", out_trade_no);
        format!("{}api.php?{}", self.params.api_url, ser.finish())
    }

    /// Query a trade by our out_trade_no.
    pub async fn query(&self, out_trade_no: &str) -> Result<Query, CallError> {
        let url = self.query_url(out_trade_no);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let r = match super::http::get(&url, CALL_TIMEOUT).await {
                Err(e) => Err(CallError::Transport(e)),
                Ok((200, bytes)) => parse_query(&bytes, &self.params.pid, out_trade_no),
                Ok((status, _)) => Err(CallError::Status(status)),
            };
            match r {
                Err(CallError::Transport(_) | CallError::Status(_)) if attempt < QUERY_ATTEMPTS => {
                    tokio::time::sleep(RETRY_DELAY).await;
                }
                r => return r,
            }
        }
    }

    /// Verify a notify (GET query string or POST form): form decode (no
    /// duplicates), MD5 signature, this method's pid.
    pub fn check_notify(&self, body: &[u8]) -> NotifyCheck {
        let Some(p) = super::api::parse_form(body) else {
            return NotifyCheck::Rejected {
                verified: false,
                reason: "malformed",
                out_trade_no: None,
                status: None,
                params: None,
            };
        };
        let otn = p.get("out_trade_no").cloned();
        let status = p.get("trade_status").cloned();
        let params = super::api::redacted_params(&p);
        let reject = |verified, reason| NotifyCheck::Rejected {
            verified,
            reason,
            out_trade_no: otn.clone(),
            status: status.clone(),
            params: Some(params.clone()),
        };
        if !verify(&p, &self.key) {
            return reject(false, "bad_signature");
        }
        if p.get("pid") != Some(&self.params.pid) {
            return reject(true, "pid_mismatch");
        }
        let Some(out_trade_no) = otn.clone().filter(|o| !o.is_empty()) else {
            return reject(true, "unknown_order");
        };
        let st = status.clone().unwrap_or_default();
        NotifyCheck::Verified(NotifyEvent {
            out_trade_no,
            trade_no: p.get("trade_no").cloned().filter(|t| !t.is_empty()),
            paid: st == "TRADE_SUCCESS",
            status: st,
            total_cents: p.get("money").and_then(|m| parse_amount(m)),
            params,
        })
    }

    /// 测试连接: the query of a random out_trade_no that cannot exist.
    /// EPay checks the merchant and its key before looking the order up,
    /// so "no such order" proves both (and that the query API works).
    pub async fn test_connection(&self) -> TestOutcome {
        let otn = format!("AKTEST{}", hex::encode(rand::random::<[u8; 10]>()));
        judge_test(self.query(&otn).await)
    }
}

impl PaymentProvider for Epay {
    fn kind(&self) -> &'static str {
        KIND
    }
    fn order_timeout_minutes(&self) -> u32 {
        self.params.order_timeout_minutes
    }
    fn create<'a>(&'a self, req: CreateReq<'a>) -> BoxFut<'a, Result<Checkout, CallError>> {
        Box::pin(async move { Epay::create(self, &req).await })
    }
    fn query<'a>(&'a self, otn: &'a str) -> BoxFut<'a, Result<Query, CallError>> {
        Box::pin(Epay::query(self, otn))
    }
    fn close<'a>(&'a self, _otn: &'a str) -> BoxFut<'a, Result<Close, CallError>> {
        Box::pin(async { Ok(Close::NotClosable) })
    }
    fn verify_notify(&self, body: &[u8]) -> NotifyCheck {
        self.check_notify(body)
    }
    fn notify_ack(&self) -> &'static str {
        "success"
    }
    fn notify_get(&self) -> bool {
        true
    }
    fn test_connection(&self) -> BoxFut<'_, TestOutcome> {
        Box::pin(Epay::test_connection(self))
    }
}

// ---------------------------------------------------------------------------
// Kind: configuration
// ---------------------------------------------------------------------------

/// The EPay provider kind.
///
/// config (plain JSON): api_url (normalized, ends in `/`), pid, channel
/// (alipay|wxpay|qqpay), api_mode (mapi|submit), product_name,
/// order_timeout_minutes, key_fingerprint. secrets (sealed): key.
pub struct EpayKind;

/// The interface address as stored: https (http only to loopback), no
/// query or fragment, not a script path (`…/submit.php`), ending in `/`.
pub fn api_base(url: &str) -> Option<String> {
    if !gateway_ok(url) || url.contains('?') {
        return None;
    }
    let uri: axum::http::Uri = url.parse().ok()?;
    if uri.path().to_ascii_lowercase().ends_with(".php") {
        return None;
    }
    Some(if url.ends_with('/') {
        url.to_string()
    } else {
        format!("{url}/")
    })
}

fn pid_ok(v: &str) -> bool {
    !v.is_empty() && v.len() <= 32 && v.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn key_ok(v: &str) -> bool {
    !v.is_empty() && v.len() <= MAX_KEY && v.bytes().all(|b| b.is_ascii_graphic())
}

/// Identifies the stored key in views (domain-separated SHA-256, 16 hex):
/// enough to tell keys apart, not to test guesses against cheaply in bulk.
pub fn key_fingerprint(key: &str) -> String {
    use sha2::Digest as _;
    let mut h = sha2::Sha256::new();
    h.update(b"akari/epay-key-fingerprint/v1\0");
    h.update(key.as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

fn text_field(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn key_of(secrets: &Value) -> Option<String> {
    text_field(secrets, "key").filter(|k| key_ok(k))
}

const KNOWN: &[&str] = &[
    "api_url",
    "pid",
    "key",
    "channel",
    "api_mode",
    "product_name",
    "order_timeout_minutes",
];

impl ProviderKind for EpayKind {
    fn id(&self) -> &'static str {
        KIND
    }
    fn label(&self) -> &'static str {
        "易支付"
    }
    fn schema(&self) -> Value {
        serde_json::json!([
            {"name": "api_url", "label": "接口地址（如 https://pay.example.com/）", "type": "text", "required": true},
            {"name": "pid", "label": "商户 ID（pid）", "type": "text", "required": true},
            {"name": "key", "label": "商户密钥（key）", "type": "text", "secret": true, "required": true},
            {"name": "channel", "label": "支付渠道", "type": "select", "required": true,
             "options": [{"value": "alipay", "label": "支付宝"}, {"value": "wxpay", "label": "微信支付"},
                         {"value": "qqpay", "label": "QQ 钱包"}]},
            {"name": "api_mode", "label": "下单方式", "type": "select", "required": true,
             "options": [{"value": "mapi", "label": "接口下单（mapi.php，被拒时改用页面跳转）"},
                         {"value": "submit", "label": "页面跳转（submit.php）"}]},
            {"name": "product_name", "label": "商品名称（可选，默认「Akari - 套餐名」）", "type": "text"},
            {"name": "order_timeout_minutes", "label": "订单有效期（分钟，5–120）", "type": "number",
             "required": true, "default": 15}
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
        let api_url = match text_field(input, "api_url") {
            None => None,
            Some(u) => Some(api_base(&u).ok_or_else(|| {
                bad_request!(
                    "payments.epay_url_invalid",
                    "api_url must be the https address of the EPay interface (not a .php page)"
                )
            })?),
        };
        let pid = text_field(input, "pid");
        if pid.as_deref().is_some_and(|v| !pid_ok(v)) {
            return Err(bad_request!(
                "payments.epay_pid_invalid",
                "pid must be 1-32 letters or digits"
            ));
        }
        let new_key = text_field(input, "key");
        if new_key.as_deref().is_some_and(|v| !key_ok(v)) {
            return Err(bad_request!(
                "payments.epay_key_invalid",
                "key must be 1-128 visible ASCII characters"
            ));
        }
        let channel = text_field(input, "channel").unwrap_or_else(|| "alipay".into());
        if Channel::parse(&channel).is_none() {
            return Err(bad_request!(
                "payments.epay_channel_invalid",
                "channel must be alipay, wxpay or qqpay"
            ));
        }
        let mode = text_field(input, "api_mode").unwrap_or_else(|| "mapi".into());
        if Mode::parse(&mode).is_none() {
            return Err(bad_request!(
                "payments.epay_mode_invalid",
                "api_mode must be mapi or submit"
            ));
        }
        let product_name = text_field(input, "product_name");
        if product_name
            .as_deref()
            .is_some_and(|n| n.chars().count() > MAX_NAME || n.chars().any(char::is_control))
        {
            return Err(bad_request!(
                "payments.epay_product_name_invalid",
                "product_name must be at most 64 characters without control characters"
            ));
        }
        let timeout = match input.get("order_timeout_minutes") {
            None | Some(Value::Null) => 15,
            Some(v) => v.as_i64().unwrap_or(-1),
        };
        if !(5..=120).contains(&timeout) {
            return Err(bad_request!(
                "payments.timeout_range",
                "order_timeout_minutes must be 5-120"
            ));
        }
        let prev_secrets = prev.map(|(_, s)| s);
        let key = new_key.clone().or_else(|| prev_secrets.and_then(key_of));
        if complete && (api_url.is_none() || pid.is_none() || key.is_none()) {
            return Err(conflict!(
                "payments.incomplete",
                "enabling needs the interface address, the merchant id and the key"
            ));
        }
        let config = serde_json::json!({
            "api_url": api_url,
            "pid": pid,
            "channel": channel,
            "api_mode": mode,
            "product_name": product_name,
            "order_timeout_minutes": timeout,
            "key_fingerprint": key.as_deref().map(key_fingerprint),
        });
        let mut secrets = prev_secrets
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let mut changed = Vec::new();
        if let Some(k) = new_key {
            secrets["key"] = Value::String(k);
            changed.push("key");
        }
        Ok(Validated {
            config,
            secrets,
            changed_secrets: changed,
        })
    }

    fn build(&self, config: &Value, secrets: &Value) -> Result<Arc<dyn PaymentProvider>, String> {
        let api_url = text_field(config, "api_url")
            .and_then(|u| api_base(&u))
            .ok_or("api_url missing or invalid")?;
        let pid = text_field(config, "pid")
            .filter(|p| pid_ok(p))
            .ok_or("pid missing")?;
        let key = key_of(secrets).ok_or("key missing or unreadable")?;
        let channel = text_field(config, "channel")
            .and_then(|c| Channel::parse(&c))
            .ok_or("bad channel")?;
        let mode = text_field(config, "api_mode")
            .and_then(|m| Mode::parse(&m))
            .ok_or("bad api_mode")?;
        let params = Params {
            api_url,
            pid,
            channel,
            mode,
            product_name: text_field(config, "product_name"),
            order_timeout_minutes: config
                .get("order_timeout_minutes")
                .and_then(Value::as_u64)
                .unwrap_or(15)
                .clamp(5, 120) as u32,
        };
        Ok(Arc::new(Epay::new(params, key)))
    }

    fn view(&self, config: &Value, secrets: Option<&Value>) -> Value {
        let mut v = serde_json::json!({});
        for k in [
            "api_url",
            "pid",
            "channel",
            "api_mode",
            "product_name",
            "order_timeout_minutes",
            "key_fingerprint",
        ] {
            v[k] = config.get(k).cloned().unwrap_or(Value::Null);
        }
        v["key_set"] = Value::Bool(secrets.is_some_and(|s| s.get("key").is_some()));
        v["key_readable"] = Value::Bool(secrets.and_then(key_of).is_some());
        v
    }

    fn peek_out_trade_no(&self, body: &[u8]) -> Option<String> {
        super::api::parse_form(body)?.remove("out_trade_no")
    }

    fn default_icon(&self, config: &Value) -> Option<&'static str> {
        text_field(config, "channel")
            .and_then(|c| Channel::parse(&c))
            .map(Channel::icon)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const PID: &str = "1001";
    pub const KEY: &str = "89unJUB8HZ54Hj7x4nUj56HN4nUzUJ8i";

    pub fn test_params(api: &str) -> Params {
        Params {
            api_url: api.into(),
            pid: PID.into(),
            channel: Channel::Alipay,
            mode: Mode::Api,
            product_name: None,
            order_timeout_minutes: 15,
        }
    }

    pub fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// A notify as EPay sends it (signed with KEY).
    pub fn signed_notify(otn: &str, money: &str, status: &str) -> BTreeMap<String, String> {
        let mut p = map(&[
            ("pid", PID),
            ("trade_no", "2026101312000012345"),
            ("out_trade_no", otn),
            ("type", "alipay"),
            ("name", "Akari - 月付 & co"),
            ("money", money),
            ("trade_status", status),
            ("param", ""),
        ]);
        let s = sign(&p, KEY);
        p.insert("sign".into(), s);
        p.insert("sign_type".into(), "MD5".into());
        p
    }

    pub fn query_string(p: &BTreeMap<String, String>) -> String {
        Epay::encode(p)
    }

    #[test]
    fn signature_vectors() {
        // The documented example of the common EPay spec: sorted, empty
        // values / sign / sign_type left out, raw values, key appended.
        let p = map(&[
            ("pid", "1001"),
            ("type", "alipay"),
            ("out_trade_no", "20160806151343349"),
            ("notify_url", "http://www.pay.com/notify_url.php"),
            ("return_url", "http://www.pay.com/return_url.php"),
            ("name", "VIP会员"),
            ("money", "1.00"),
            ("param", ""),
            ("sign_type", "MD5"),
            ("sign", "whatever"),
        ]);
        assert_eq!(
            sign_content(&p),
            "money=1.00&name=VIP会员&notify_url=http://www.pay.com/notify_url.php\
             &out_trade_no=20160806151343349&pid=1001\
             &return_url=http://www.pay.com/return_url.php&type=alipay"
        );
        // md5("money=1.00&…&type=alipay" + KEY), computed independently:
        // `printf '%s' "<content><KEY>" | md5sum`.
        assert_eq!(sign(&p, KEY), "427724b6656aa612cfdbe7a2262036a3");
        // RFC 1321 vectors through the same path (empty map = the key only).
        assert_eq!(
            sign(&BTreeMap::new(), ""),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
        assert_eq!(
            sign(&BTreeMap::new(), "abc"),
            "900150983cd24fb0d6963f7d28e17f72"
        );
        assert_eq!(
            sign(&map(&[("a", "1")]), ""),
            hex::encode(md5::Md5::digest(b"a=1"))
        );
    }

    #[test]
    fn verification() {
        let p = signed_notify("AK1", "9.90", "TRADE_SUCCESS");
        assert!(verify(&p, KEY));
        assert!(!verify(&p, "other-key"));
        // Upper-case hex is the same digest.
        let mut up = p.clone();
        up.insert("sign".into(), p["sign"].to_ascii_uppercase());
        assert!(verify(&up, KEY));
        // Every signed value matters; empty values and sign_type do not
        // enter the digest, but sign_type must say MD5.
        for k in [
            "pid",
            "trade_no",
            "out_trade_no",
            "type",
            "name",
            "money",
            "trade_status",
        ] {
            let mut t = p.clone();
            t.get_mut(k).unwrap().push('0');
            assert!(!verify(&t, KEY), "{k}");
        }
        let mut t = p.clone();
        t.insert("param".into(), "x".into());
        assert!(!verify(&t, KEY), "a new non-empty value");
        let mut t = p.clone();
        t.insert("extra".into(), String::new());
        assert!(verify(&t, KEY), "a new empty value is not signed");
        for st in [None, Some("RSA"), Some("md5")] {
            let mut t = p.clone();
            match st {
                Some(s) => t.insert("sign_type".into(), s.into()),
                None => t.remove("sign_type"),
            };
            assert!(!verify(&t, KEY), "{st:?}");
        }
        let mut t = p.clone();
        t.remove("sign");
        assert!(!verify(&t, KEY));
        let mut t = p;
        t.insert("sign".into(), "abc".into());
        assert!(!verify(&t, KEY), "short signature");
    }

    #[test]
    fn notify_checks() {
        let e = Epay::new(test_params("https://pay.example/"), KEY.into());
        let ok = |p: &BTreeMap<String, String>| e.check_notify(query_string(p).as_bytes());
        match ok(&signed_notify("AK1", "9.90", "TRADE_SUCCESS")) {
            NotifyCheck::Verified(ev) => {
                assert_eq!(ev.out_trade_no, "AK1");
                assert_eq!(ev.total_cents, Some(990));
                assert!(ev.paid);
                assert_eq!(ev.trade_no.as_deref(), Some("2026101312000012345"));
                assert_eq!(ev.params["sign"], "<redacted>");
            }
            r => panic!("{r:?}"),
        }
        match ok(&signed_notify("AK1", "9.90", "WAIT")) {
            NotifyCheck::Verified(ev) => assert!(!ev.paid),
            r => panic!("{r:?}"),
        }
        let reason = |r: NotifyCheck| match r {
            NotifyCheck::Rejected {
                verified, reason, ..
            } => (verified, reason),
            r => panic!("{r:?}"),
        };
        let mut t = signed_notify("AK1", "9.90", "TRADE_SUCCESS");
        t.insert("money".into(), "0.01".into());
        assert_eq!(reason(ok(&t)), (false, "bad_signature"));
        let other = Epay::new(
            Params {
                pid: "1002".into(),
                ..test_params("https://pay.example/")
            },
            KEY.into(),
        );
        let body = query_string(&signed_notify("AK1", "9.90", "TRADE_SUCCESS"));
        assert_eq!(
            reason(other.check_notify(body.as_bytes())),
            (true, "pid_mismatch")
        );
        let mut t = signed_notify("", "9.90", "TRADE_SUCCESS");
        t.remove("out_trade_no");
        let s = sign(&t, KEY);
        t.insert("sign".into(), s);
        assert_eq!(reason(ok(&t)), (true, "unknown_order"));
        assert_eq!(reason(e.check_notify(b"a=1&a=2")), (false, "malformed"));
        assert_eq!(reason(e.check_notify(&[0xff, 0xfe])), (false, "malformed"));
        assert_eq!(reason(e.check_notify(b"")), (false, "bad_signature"));
        assert_eq!(
            EpayKind.peek_out_trade_no(body.as_bytes()).as_deref(),
            Some("AK1")
        );
    }

    #[test]
    fn create_params_and_links() {
        let mut e = Epay::new(test_params("https://pay.example/"), KEY.into());
        let ip: std::net::IpAddr = "203.0.113.9".parse().unwrap();
        let req = CreateReq {
            out_trade_no: "AK1",
            amount_cents: 12345,
            subject: "Akari - 月付",
            notify_url: "https://panel.example/pay/x/notify",
            return_url: "https://panel.example/orders/1",
            client_ip: Some(ip),
        };
        let p = e.create_params(&req, true);
        assert_eq!(p["money"], "123.45");
        assert_eq!(p["type"], "alipay");
        assert_eq!(p["name"], "Akari - 月付");
        assert_eq!(p["clientip"], "203.0.113.9");
        assert_eq!(p["sign_type"], "MD5");
        assert!(verify(&p, KEY));
        assert!(!e.create_params(&req, false).contains_key("clientip"));
        let url = e.submit_url(&req).unwrap();
        assert!(url.starts_with("https://pay.example/submit.php?"), "{url}");
        let q: BTreeMap<String, String> =
            form_urlencoded::parse(url.split_once('?').unwrap().1.as_bytes())
                .into_owned()
                .collect();
        assert!(verify(&q, KEY));
        assert_eq!(q["return_url"], "https://panel.example/orders/1");
        // The operator's product name replaces the subject (capped).
        e.params.product_name = Some("x".repeat(100));
        e.params.channel = Channel::Wxpay;
        let p = e.create_params(&req, false);
        assert_eq!(p["name"], "x".repeat(MAX_NAME));
        assert_eq!(p["type"], "wxpay");
        // A link longer than the order column holds is refused.
        let long = "y".repeat(MAX_LINK);
        let r = e.submit_url(&CreateReq {
            notify_url: &long,
            ..req.clone()
        });
        assert!(matches!(r, Err(CallError::Malformed(_))));
        let q = e.query_url("AK 1");
        assert_eq!(
            q,
            format!("https://pay.example/api.php?act=order&pid=1001&key={KEY}&out_trade_no=AK+1")
        );
    }

    #[test]
    fn create_answers() {
        assert_eq!(
            parse_create(br#"{"code":1,"trade_no":"T1","payurl":"https://pay.example/pay/T1"}"#)
                .unwrap(),
            Some(Checkout::Redirect("https://pay.example/pay/T1".into()))
        );
        assert_eq!(
            parse_create(br#"{"code":"1","qrcode":"weixin://wxpay/bizpayurl?pr=x"}"#).unwrap(),
            Some(Checkout::Qr("weixin://wxpay/bizpayurl?pr=x".into()))
        );
        // A bad payurl is skipped for the QR.
        assert_eq!(
            parse_create(
                br#"{"code":1,"payurl":"javascript:alert(1)","qrcode":"https://qr.alipay.com/x"}"#
            )
            .unwrap(),
            Some(Checkout::Qr("https://qr.alipay.com/x".into()))
        );
        for fallback in [
            r#"{"code":-1,"msg":"API接口未开启"}"#,
            r#"{"code":1,"urlscheme":"weixin://dl/business/?t=x"}"#,
            r#"{"code":1,"payurl":"https://a b"}"#,
            r#"{"code":1,"qrcode":""}"#,
        ] {
            assert_eq!(parse_create(fallback.as_bytes()).unwrap(), None);
        }
        for bad in [&b"<html>"[..], b"[1]", b""] {
            assert!(matches!(parse_create(bad), Err(CallError::Malformed(_))));
        }
    }

    #[test]
    fn query_answers() {
        let q = |b: &str| parse_query(b.as_bytes(), PID, "AK1");
        assert_eq!(
            q(r#"{"code":1,"msg":"查询订单号成功！","trade_no":"T1","out_trade_no":"AK1","type":"alipay","pid":1001,"money":"9.90","status":1}"#)
                .unwrap(),
            Query::Trade {
                status: "TRADE_SUCCESS".into(),
                paid: true,
                trade_no: "T1".into(),
                total_cents: Some(990),
            }
        );
        assert_eq!(
            q(r#"{"code":"1","out_trade_no":"AK1","money":9.9,"status":"0"}"#).unwrap(),
            Query::Trade {
                status: "NOTPAY".into(),
                paid: false,
                trade_no: String::new(),
                total_cents: Some(990),
            }
        );
        assert_eq!(
            q(r#"{"code":-1,"msg":"订单编号不存在"}"#).unwrap(),
            Query::NotExist
        );
        assert_eq!(
            q(r#"{"code":-1,"msg":"order not exist"}"#).unwrap(),
            Query::NotExist
        );
        for (body, msg) in [
            (r#"{"code":-3,"msg":"KEY校验失败"}"#, "KEY校验失败"),
            (r#"{"code":-3,"msg":"商户ID不存在"}"#, "商户ID不存在"),
        ] {
            match q(body) {
                Err(CallError::Business { code, sub_msg, .. }) => {
                    assert_eq!((code.as_str(), sub_msg.as_str()), ("-3", msg));
                }
                r => panic!("{r:?}"),
            }
        }
        assert!(matches!(
            q(r#"{"code":1,"out_trade_no":"AK2","status":1}"#),
            Err(CallError::Malformed("query answered another order"))
        ));
        assert!(matches!(
            q(r#"{"code":1,"pid":"9","status":1}"#),
            Err(CallError::Malformed("query answered another merchant"))
        ));
        assert!(matches!(q("nope"), Err(CallError::Malformed(_))));
        assert!(matches!(q("1"), Err(CallError::Malformed(_))));
    }

    #[test]
    fn test_connection_outcomes() {
        let biz = |msg: &str| {
            Err(CallError::Business {
                code: "-3".into(),
                sub_code: String::new(),
                sub_msg: msg.into(),
                verified: false,
            })
        };
        let cases: Vec<(Result<Query, CallError>, bool, &str)> = vec![
            (Ok(Query::NotExist), true, "keys_ok"),
            (biz("KEY校验失败"), false, "key_rejected"),
            (biz("商户不存在"), false, "pid_invalid"),
            (biz("系统维护"), false, "other"),
            (Err(CallError::Transport("x".into())), false, "unreachable"),
            (Err(CallError::Status(502)), false, "gateway_status"),
            (Err(CallError::Malformed("x")), false, "malformed"),
            (Err(CallError::Unsupported), false, "other"),
        ];
        for (r, ok, result) in cases {
            let o = judge_test(r);
            assert_eq!((o.ok, o.result), (ok, result), "{}", o.message);
        }
    }

    #[test]
    fn kind_validation() {
        let k = EpayKind;
        let good = serde_json::json!({
            "api_url": "https://pay.example.com", "pid": PID, "key": KEY,
            "channel": "wxpay", "api_mode": "submit", "order_timeout_minutes": 30,
        });
        let v = k.validate(&good, None, true).ok().unwrap();
        assert_eq!(v.config["api_url"], "https://pay.example.com/");
        assert_eq!(v.config["key_fingerprint"], key_fingerprint(KEY));
        assert_eq!(v.secrets["key"], KEY);
        assert_eq!(v.changed_secrets, ["key"]);
        assert!(!v.config.to_string().contains(KEY));
        let view = k.view(&v.config, Some(&v.secrets));
        assert!(!view.to_string().contains(KEY));
        assert_eq!(
            (&view["key_set"], &view["key_readable"]),
            (&Value::Bool(true), &Value::Bool(true))
        );
        assert_eq!(k.default_icon(&v.config), Some("wechat"));
        let p = k.build(&v.config, &v.secrets).unwrap();
        assert_eq!((p.kind(), p.order_timeout_minutes()), (KIND, 30));
        assert!(p.notify_get() && !p.refunds());
        assert!(format!("{p:?}").contains("1001") && !format!("{p:?}").contains(KEY));
        // Edit without the key keeps it; defaults fill channel and mode.
        let edit = serde_json::json!({ "api_url": "https://pay.example.com/x/", "pid": "2002" });
        let v2 = k
            .validate(&edit, Some((&v.config, &v.secrets)), true)
            .ok()
            .unwrap();
        assert_eq!(v2.secrets["key"], KEY);
        assert!(v2.changed_secrets.is_empty());
        assert_eq!(
            (&v2.config["channel"], &v2.config["api_mode"]),
            (&serde_json::json!("alipay"), &serde_json::json!("mapi"))
        );
        assert_eq!(v2.config["order_timeout_minutes"], 15);
        // Incomplete: may be saved disabled, not enabled.
        let partial = serde_json::json!({ "pid": PID });
        assert!(k.validate(&partial, None, false).is_ok());
        let e = k.validate(&partial, None, true).err().unwrap();
        assert_eq!(e.code(), "payments.incomplete");
        assert!(
            k.build(&serde_json::json!({}), &serde_json::json!({}))
                .is_err()
        );
        let codes = [
            (serde_json::json!([]), "payments.config_invalid"),
            (serde_json::json!({"x": 1}), "payments.config_unknown_field"),
            (
                serde_json::json!({"api_url": "http://pay.example.com/"}),
                "payments.epay_url_invalid",
            ),
            (
                serde_json::json!({"api_url": "https://pay.example.com/submit.php"}),
                "payments.epay_url_invalid",
            ),
            (
                serde_json::json!({"api_url": "https://pay.example.com/?a=1"}),
                "payments.epay_url_invalid",
            ),
            (
                serde_json::json!({"api_url": "ftp://pay.example.com/"}),
                "payments.epay_url_invalid",
            ),
            (
                serde_json::json!({"pid": "10 01"}),
                "payments.epay_pid_invalid",
            ),
            (
                serde_json::json!({"key": "a b"}),
                "payments.epay_key_invalid",
            ),
            (
                serde_json::json!({"key": "k".repeat(129)}),
                "payments.epay_key_invalid",
            ),
            (
                serde_json::json!({"channel": "paypal"}),
                "payments.epay_channel_invalid",
            ),
            (
                serde_json::json!({"api_mode": "v2"}),
                "payments.epay_mode_invalid",
            ),
            (
                serde_json::json!({"product_name": "n".repeat(65)}),
                "payments.epay_product_name_invalid",
            ),
            (
                serde_json::json!({"product_name": "a\u{7}"}),
                "payments.epay_product_name_invalid",
            ),
            (
                serde_json::json!({"order_timeout_minutes": 4}),
                "payments.timeout_range",
            ),
            (
                serde_json::json!({"order_timeout_minutes": "x"}),
                "payments.timeout_range",
            ),
        ];
        for (input, code) in codes {
            let e = k.validate(&input, None, false).err().unwrap();
            assert_eq!(e.code(), code, "{input}");
        }
        // Loopback http (tests, local mock gateways) is accepted.
        assert_eq!(
            api_base("http://127.0.0.1:9/epay").as_deref(),
            Some("http://127.0.0.1:9/epay/")
        );
        // A stored key that no longer opens: the view says so.
        let view = k.view(&v.config, Some(&serde_json::json!({ "key": "bad key" })));
        assert_eq!(
            (&view["key_set"], &view["key_readable"]),
            (&Value::Bool(true), &Value::Bool(false))
        );
        assert_eq!(k.view(&v.config, None)["key_set"], false);
        assert_eq!(
            k.default_icon(&serde_json::json!({"channel": "qqpay"})),
            Some("qq")
        );
        assert_eq!(k.default_icon(&serde_json::json!({})), None);
        assert!(k.schema().as_array().is_some_and(|a| a.len() == 7));
        assert_eq!(k.label(), "易支付");
    }
}
