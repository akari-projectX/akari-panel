//! CoinPayments (API v2) as a payment provider kind (`coinpayments`): a
//! hosted crypto checkout. One method = one CoinPayments API integration
//! (client id + client secret) and one invoice currency.
//!
//! Official documentation (checked 2026-10-27, https://docs.coinpayments.net):
//! - request signing: /api/auth/generate-api-signature and
//!   /api/auth/request-headers — headers `X-CoinPayments-Client`,
//!   `X-CoinPayments-Timestamp` (UTC `YYYY-MM-DDTHH:mm:ss`),
//!   `X-CoinPayments-Signature` = Base64(HMAC-SHA256(client secret,
//!   "\u{feff}" + METHOD + full URL + client id + timestamp + raw body)).
//! - webhooks: /api/webhooks/authenticating-requests — the same three
//!   headers; the signed message is built from the HTTP method, the EXACT URL
//!   registered with CoinPayments, the client-id and timestamp headers
//!   verbatim and the raw body; timestamps more than about five minutes off
//!   are replays. /api/webhooks/clients (events), /api/webhooks/clients/payload
//!   (payload fields), /api/webhooks/clients/setup (a webhook URL can be given
//!   per invoice).
//! - invoices: /api/invoices/routes/postMerchantInvoicesV2 (create; the
//!   per-invoice `webhooks[]` = {notificationsUrl, notifications[]}, the
//!   external `invoiceId`, `customData` echoed in notifications),
//!   getMerchantInvoicesByIdV2, getMerchantInvoicesV2 (list; `q` search),
//!   postMerchantInvoicesCancelByIdV1 (cancel), /api/invoices/statuses,
//!   /api/invoices/payment-errors (under/overpayment).
//!
//! Flow. Create: POST `/api/v2/merchant/invoices` with our order number as
//! the external `invoiceId`, the amount in the configured fiat currency
//! (`crypto::Pricing`), our CNY cents in `customData` and this method's
//! notify URL as the invoice's own webhook (so nothing has to be configured
//! per URL in the CoinPayments dashboard); the payer is sent to
//! `checkoutLink`. Notify: POST to `/pay/{method}/notify`, verified on the
//! raw body. Query: find the invoice by our order number (list with `q`,
//! exact `invoiceId` match) and read it by id.
//!
//! WHICH STATUS PAYS. Only `completed` (webhook `InvoiceCompleted` with the
//! invoice state `Completed`): "funds are credited to the merchant balance —
//! the safe trigger to release goods". `paid` (chain-confirmed but not yet
//! credited), `pending`, `unpaid`, `cancelled`, `timedOut` never pay.
//! Underpayment leaves the invoice `pending`/partially paid (it completes
//! only when the merchant accepts the partial payment in the dashboard, which
//! is then the merchant's decision); overpayment completes at the requested
//! amount. The amount check is on the invoice's own total, not on what the
//! payer sent.
//!
//! AMOUNT. The invoice total and currency id the gateway reports must equal
//! what `Pricing` computes from the order cents we put in `customData`; the
//! amount string must carry a decimal point (the documentation does not pin
//! down whether v2 amounts are decimals or minor units, so an integer-looking
//! string is never trusted: it fails closed). Anything else reports no
//! amount and `handle_notify` / `apply_query_result` record
//! `amount_mismatch` without paying.
//!
//! No refund through the gateway (`refunds()` false). Close: only an unpaid
//! invoice is cancelled; once funds are detected (`pending`/`paid`/…) the
//! cancel call would start CoinPayments' automatic refund flow, so those
//! report `NotClosable` and a late completion still fulfils.
//!
//! Secrets: the client secret never leaves `CoinPayments` (no Debug); request
//! bodies, headers and URLs are not logged; gateway bodies are never echoed.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use hyper::body::Bytes;
use serde_json::{Value, json};

use super::crypto::{
    self, AmountFormat, MAX_SKEW_SECS, Pricing, link_ok, text_field, token_ok, utc_stamp,
};
use super::provider::{
    BoxFut, CallError, Checkout, Close, CreateReq, NotifyCheck, NotifyEvent, NotifyRequest,
    PaymentProvider, ProviderKind, Query, TestOutcome, Validated,
};
use crate::auth::{ApiError, bad_request, conflict};

/// Kind id.
pub const KIND: &str = "coinpayments";
/// The platform instances (credentials are not interchangeable).
const INSTANCES: [(&str, &str); 3] = [
    ("a", "https://a-api.coinpayments.net"),
    ("b", "https://b-api.coinpayments.net"),
    ("c", "https://c-api.coinpayments.net"),
];
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ID: usize = 128;
const MAX_NAME: usize = 100;
/// The events asked for per invoice. Only `invoiceCompleted` can pay; the
/// others are recorded for the admin.
const NOTIFICATIONS: [&str; 3] = ["invoiceCompleted", "invoiceCancelled", "invoiceTimedOut"];
/// The notify path of the signed message is the registered URL itself.
const NOTIFY_METHOD: &str = "POST";

fn official_bases() -> Vec<&'static str> {
    INSTANCES.iter().map(|(_, u)| *u).collect()
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/// The string both request signing and webhook verification cover.
pub fn signing_message(
    method: &str,
    url: &str,
    client_id: &str,
    timestamp: &str,
    body: &str,
) -> String {
    format!("\u{feff}{method}{url}{client_id}{timestamp}{body}")
}

/// Base64(HMAC-SHA256(secret, message)).
pub fn signature(secret: &str, message: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes());
    STANDARD.encode(ring::hmac::sign(&key, message.as_bytes()).as_ref())
}

/// `given` (Base64) is the signature of `message` under `secret`
/// (constant time).
pub fn signature_valid(secret: &str, message: &str, given: &str) -> bool {
    let Ok(tag) = STANDARD.decode(given.trim()) else {
        return false;
    };
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes());
    ring::hmac::verify(&key, message.as_bytes(), &tag).is_ok()
}

// ---------------------------------------------------------------------------
// Invoice facts (create answer, invoice by id, webhook payload)
// ---------------------------------------------------------------------------

/// What an invoice object says, whichever API shape it came in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    /// Our order number (the external `invoiceId`).
    pub out_trade_no: Option<String>,
    /// CoinPayments' invoice id.
    pub id: Option<String>,
    /// Lower-case status/state (`completed`, `timedout`, …).
    pub status: String,
    pub currency_id: Option<String>,
    /// Invoice total as the gateway wrote it.
    pub total: Option<String>,
    /// The order's CNY cents we put in `customData`.
    pub cents: Option<i64>,
    /// Per-payment states (visible to the admin: partial payments).
    pub payment_states: Vec<String>,
}

/// Read an invoice object: REST (`status`, `currency.id`) or webhook
/// (`state`, `amount.currencyId`) shape.
pub fn facts(inv: &Value) -> Facts {
    let status = inv
        .get("status")
        .or_else(|| inv.get("state"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let currency_id = crypto::id_text(inv.get("currency").and_then(|c| c.get("id")))
        .or_else(|| crypto::id_text(inv.get("amount").and_then(|a| a.get("currencyId"))));
    let total = inv
        .get("amount")
        .and_then(|a| a.get("total"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let cents = crypto::id_text(inv.get("customData").and_then(|c| c.get("akari_cents")))
        .and_then(|c| c.parse::<i64>().ok())
        .filter(|c| *c >= 1);
    let payment_states = inv
        .get("payments")
        .and_then(Value::as_array)
        .map(|ps| {
            ps.iter()
                .filter_map(|p| p.get("state").and_then(Value::as_str))
                .map(|s| s.chars().take(40).collect::<String>())
                .take(8)
                .collect()
        })
        .unwrap_or_default();
    Facts {
        out_trade_no: text_field(inv, "invoiceId"),
        id: text_field(inv, "id"),
        status,
        currency_id,
        total,
        cents,
        payment_states,
    }
}

/// An id usable in a request path.
fn path_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Parse a create answer: the hosted checkout link.
pub fn parse_create(body: &[u8]) -> Result<Checkout, CallError> {
    let v: Value = serde_json::from_slice(body).map_err(|_| CallError::Malformed("not JSON"))?;
    let inv = v
        .get("invoices")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or(CallError::Malformed("no invoice"))?;
    ["checkoutLink", "link"]
        .iter()
        .filter_map(|k| text_field(inv, k))
        .find(|u| link_ok(u))
        .map(Checkout::Redirect)
        .ok_or(CallError::Malformed("no usable link"))
}

/// The invoice of `out_trade_no` among list results (exact external id).
pub fn pick_invoice(body: &[u8], out_trade_no: &str) -> Result<Option<String>, CallError> {
    let v: Value = serde_json::from_slice(body).map_err(|_| CallError::Malformed("not JSON"))?;
    let items = v
        .get("items")
        .and_then(Value::as_array)
        .ok_or(CallError::Malformed("no items"))?;
    let mut ids = items
        .iter()
        .filter(|i| i.get("invoiceId").and_then(Value::as_str) == Some(out_trade_no))
        .filter_map(|i| text_field(i, "id"));
    let first = ids.next();
    if ids.any(|other| Some(&other) != first.as_ref()) {
        return Err(CallError::Malformed("ambiguous invoice"));
    }
    match first {
        Some(id) if path_id(&id) => Ok(Some(id)),
        Some(_) => Err(CallError::Malformed("bad invoice id")),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// The non-secret parameters of a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Params {
    /// API base without a trailing slash.
    pub base: String,
    pub client_id: String,
    /// CoinPayments currency id of the invoice currency (fiat).
    pub currency_id: String,
    pub pricing: Pricing,
    pub order_timeout_minutes: u32,
}

pub struct CoinPayments {
    pub params: Params,
    secret: String,
}

impl std::fmt::Debug for CoinPayments {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoinPayments")
            .field("client_id", &self.params.client_id)
            .field("currency", &self.params.pricing.currency)
            .finish_non_exhaustive()
    }
}

fn reject(
    verified: bool,
    reason: &'static str,
    otn: Option<String>,
    status: Option<String>,
    params: Option<Value>,
) -> NotifyCheck {
    NotifyCheck::Rejected {
        verified,
        reason,
        out_trade_no: otn,
        status,
        params,
    }
}

/// Interpret the 测试连接 results (pure; unit-tested).
pub fn judge_test(
    auth: &Result<(), CallError>,
    currency: Result<Option<String>, CallError>,
    want: &str,
) -> TestOutcome {
    let out = |ok, result, message: &str| TestOutcome {
        ok,
        result,
        message: message.to_string(),
        code: None,
        sub_code: None,
    };
    match auth {
        Err(CallError::Status(401 | 403)) => {
            return out(
                false,
                "credentials_rejected",
                "CoinPayments 拒绝了客户端 ID 或客户端密钥（或该集成无权访问发票，或平台实例选错：凭据不能跨实例通用）",
            );
        }
        Err(CallError::Transport(_)) => {
            return out(
                false,
                "unreachable",
                "无法连接 CoinPayments 接口（网络或 DNS 问题）",
            );
        }
        Err(CallError::Status(st)) => {
            return TestOutcome {
                message: format!("CoinPayments 接口返回 HTTP {st}"),
                ..out(false, "gateway_status", "")
            };
        }
        Err(_) => {
            return out(false, "malformed", "CoinPayments 接口的响应无法解析");
        }
        Ok(()) => {}
    }
    match currency {
        Ok(Some(symbol)) if symbol == want => out(
            true,
            "keys_ok",
            "连接正常：CoinPayments 接受了客户端凭据，发票币种 ID 与币种代码一致",
        ),
        Ok(Some(symbol)) => TestOutcome {
            message: format!("发票币种 ID 对应的是 {symbol}，与填写的币种 {want} 不一致"),
            ..out(false, "currency_mismatch", "")
        },
        Ok(None) | Err(CallError::Malformed(_)) => out(
            false,
            "currency_unknown",
            "CoinPayments 不认这个发票币种 ID（应为法币币种的数字 ID，可在公开接口 /api/v2/currencies?types=fiat 查到）",
        ),
        Err(_) => out(
            false,
            "unreachable",
            "凭据有效，但无法核对发票币种 ID（网络错误）",
        ),
    }
}

impl CoinPayments {
    pub fn new(params: Params, secret: String) -> Self {
        Self { params, secret }
    }

    /// One signed call. `path` includes the query string (the signed URL is
    /// the full URL as requested).
    async fn signed(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<(u16, Bytes), CallError> {
        let url = format!("{}{path}", self.params.base);
        let ts = utc_stamp(chrono::Utc::now().timestamp());
        let payload = body.unwrap_or_default();
        let message = signing_message(method, &url, &self.params.client_id, &ts, &payload);
        let headers = [
            ("X-CoinPayments-Client", self.params.client_id.clone()),
            ("X-CoinPayments-Timestamp", ts),
            (
                "X-CoinPayments-Signature",
                signature(&self.secret, &message),
            ),
        ];
        let r = if method == "GET" {
            super::http::get_with(&url, &headers, CALL_TIMEOUT).await
        } else {
            super::http::post(
                &url,
                "application/json",
                &headers,
                payload.into_bytes(),
                CALL_TIMEOUT,
            )
            .await
        };
        r.map_err(CallError::Transport)
    }

    async fn get_json(&self, path: &str) -> Result<Vec<u8>, CallError> {
        crypto::read_with_retries(|| async {
            match self.signed("GET", path, None).await? {
                (200, b) => Ok(b.to_vec()),
                (st, _) => Err(crypto::status_error(st)),
            }
        })
        .await
    }

    /// The create body: amounts in the invoice currency, our cents echoed in
    /// `customData`, this method's notify URL as the invoice webhook.
    pub fn create_body(&self, req: &CreateReq<'_>) -> Result<String, CallError> {
        let amount = self
            .params
            .pricing
            .text(req.amount_cents)
            .ok_or(CallError::Malformed("amount out of range"))?;
        let name: String = req
            .subject
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_NAME)
            .collect();
        let mut v = json!({
            "currency": self.params.currency_id,
            "invoiceId": req.out_trade_no,
            "description": name,
            "items": [{
                "name": name,
                "quantity": {"value": 1, "type": "quantity"},
                "amount": amount,
            }],
            "amount": {"breakdown": {"subtotal": amount}, "total": amount},
            "customData": {
                "akari_cents": req.amount_cents.to_string(),
                "akari_order": req.out_trade_no,
            },
            "webhooks": [{
                "notificationsUrl": req.notify_url,
                "notifications": NOTIFICATIONS,
            }],
        });
        if !req.return_url.is_empty() {
            v["successUrl"] = json!(req.return_url);
            v["cancelUrl"] = json!(req.return_url);
        }
        Ok(v.to_string())
    }

    pub async fn create(&self, req: &CreateReq<'_>) -> Result<Checkout, CallError> {
        let body = self.create_body(req)?;
        let (status, bytes) = self
            .signed("POST", "/api/v2/merchant/invoices", Some(body))
            .await?;
        if !(200..300).contains(&status) {
            return Err(crypto::status_error(status));
        }
        parse_create(&bytes)
    }

    /// Whether `f` is a paid invoice of this method and order, and the CNY
    /// cents it is worth when every number matches (see the module docs).
    pub fn judge(&self, f: &Facts) -> (bool, Option<i64>) {
        let cents = f.cents.filter(|c| {
            f.currency_id.as_deref() == Some(self.params.currency_id.as_str())
                && f.total
                    .as_deref()
                    .is_some_and(|t| self.params.pricing.matches(*c, t, AmountFormat::Dotted))
        });
        (f.status == "completed", cents)
    }

    /// The invoice of `out_trade_no` (list by `q`, exact external id, then
    /// the invoice by id), or None when CoinPayments has none.
    async fn find(&self, out_trade_no: &str) -> Result<Option<Facts>, CallError> {
        let q = form_urlencoded::Serializer::new(String::new())
            .append_pair("q", out_trade_no)
            .append_pair("limit", "10")
            .finish();
        let list = self
            .get_json(&format!("/api/v2/merchant/invoices?{q}"))
            .await?;
        let Some(id) = pick_invoice(&list, out_trade_no)? else {
            return Ok(None);
        };
        let body = self
            .get_json(&format!("/api/v2/merchant/invoices/{id}"))
            .await?;
        let v: Value =
            serde_json::from_slice(&body).map_err(|_| CallError::Malformed("not JSON"))?;
        let f = facts(&v);
        if f.out_trade_no.as_deref() != Some(out_trade_no) || f.id.as_deref() != Some(id.as_str()) {
            return Err(CallError::Malformed("invoice answered another order"));
        }
        Ok(Some(f))
    }

    pub async fn query(&self, out_trade_no: &str) -> Result<Query, CallError> {
        Ok(match self.find(out_trade_no).await? {
            None => Query::NotExist,
            Some(f) => {
                let (paid, total_cents) = self.judge(&f);
                Query::Trade {
                    status: f.status.clone(),
                    paid,
                    trade_no: f.id.unwrap_or_default(),
                    total_cents,
                }
            }
        })
    }

    pub async fn close(&self, out_trade_no: &str) -> Result<Close, CallError> {
        let Some(f) = self.find(out_trade_no).await? else {
            return Ok(Close::NotExist);
        };
        match f.status.as_str() {
            "cancelled" | "timedout" | "deleted" => Ok(Close::Closed),
            // Nothing was sent to the invoice yet: cancel it.
            "draft" | "scheduled" | "unpaid" => {
                let id = f.id.ok_or(CallError::Malformed("no invoice id"))?;
                if !path_id(&id) {
                    return Err(CallError::Malformed("bad invoice id"));
                }
                let path = format!("/api/v1/merchant/invoices/{id}/cancel");
                match self.signed("POST", &path, None).await? {
                    (200..=299, _) => Ok(Close::Closed),
                    (st, _) => Err(crypto::status_error(st)),
                }
            }
            // Funds may be on their way (cancelling starts the automatic
            // refund flow) or already credited: leave it, a late
            // completion still fulfils.
            _ => Ok(Close::NotClosable),
        }
    }

    /// Verify a webhook (see the module docs).
    pub fn check_notify(&self, req: &NotifyRequest<'_>) -> NotifyCheck {
        let header = |name: &str| {
            req.headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let (Some(client), Some(ts), Some(sig)) = (
            header("x-coinpayments-client"),
            header("x-coinpayments-timestamp"),
            header("x-coinpayments-signature"),
        ) else {
            return reject(false, "bad_signature", None, None, None);
        };
        if client != self.params.client_id {
            return reject(false, "bad_signature", None, None, None);
        }
        let Some(url) = req.url else {
            return reject(false, "no_notify_url", None, None, None);
        };
        let Ok(body) = std::str::from_utf8(req.body) else {
            return reject(false, "bad_signature", None, None, None);
        };
        let message = signing_message(NOTIFY_METHOD, url, &client, &ts, body);
        if !signature_valid(&self.secret, &message, &sig) {
            return reject(false, "bad_signature", None, None, None);
        }
        // Signed by the integration's secret from here on.
        let fresh =
            crypto::parse_utc_stamp(&ts).is_some_and(|t| (req.now_unix - t).abs() <= MAX_SKEW_SECS);
        if !fresh {
            return reject(true, "stale_timestamp", None, None, None);
        }
        let Ok(v) = serde_json::from_str::<Value>(body) else {
            return reject(true, "malformed", None, None, None);
        };
        let Some(inv) = v.get("invoice").filter(|i| i.is_object()) else {
            return reject(true, "malformed", None, None, None);
        };
        let f = facts(inv);
        let kind = v
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let params = json!({
            "type": kind,
            "invoice_id": f.out_trade_no,
            "cp_invoice_id": f.id,
            "state": f.status,
            "currency_id": f.currency_id,
            "total": f.total,
            "akari_cents": f.cents,
            "payment_states": f.payment_states,
        });
        let Some(out_trade_no) = f.out_trade_no.clone() else {
            return reject(true, "unknown_order", None, Some(kind), Some(params));
        };
        let (completed, verified_cents) = self.judge(&f);
        let paid = completed && kind == "invoicecompleted";
        NotifyCheck::Verified(NotifyEvent {
            out_trade_no,
            trade_no: f.id,
            status: if f.status.is_empty() { kind } else { f.status },
            paid,
            // Only a payment needs the verified amount; any other event just
            // names the order it is about (acknowledged, nothing settles).
            total_cents: if paid { verified_cents } else { f.cents },
            params,
        })
    }

    /// 测试连接: a signed read, then the (public) currency lookup.
    pub async fn test_connection(&self) -> TestOutcome {
        let auth = self
            .get_json("/api/v2/merchant/invoices?limit=1")
            .await
            .and_then(|b| {
                serde_json::from_slice::<Value>(&b)
                    .map(|_| ())
                    .map_err(|_| CallError::Malformed("not JSON"))
            });
        if let Err(e) = auth {
            return judge_test(&Err(e), Ok(None), &self.params.pricing.currency);
        }
        let url = format!(
            "{}/api/v2/currencies/{}",
            self.params.base, self.params.currency_id
        );
        let cur = match crypto::read_with_retries(|| async {
            match super::http::get(&url, CALL_TIMEOUT).await {
                Err(e) => Err(CallError::Transport(e)),
                Ok((200, b)) => Ok(b),
                Ok((st, _)) => Err(crypto::status_error(st)),
            }
        })
        .await
        {
            Ok(b) => serde_json::from_slice::<Value>(&b)
                .map_err(|_| CallError::Malformed("not JSON"))
                .map(|v| {
                    let fiat = v
                        .get("type")
                        .and_then(Value::as_str)
                        .is_none_or(|t| t == "fiat");
                    text_field(&v, "symbol").filter(|_| fiat)
                }),
            Err(CallError::Status(400 | 404)) => Ok(None),
            Err(e) => Err(e),
        };
        judge_test(&Ok(()), cur, &self.params.pricing.currency)
    }
}

impl PaymentProvider for CoinPayments {
    fn kind(&self) -> &'static str {
        KIND
    }
    fn order_timeout_minutes(&self) -> u32 {
        self.params.order_timeout_minutes
    }
    fn create<'a>(&'a self, req: CreateReq<'a>) -> BoxFut<'a, Result<Checkout, CallError>> {
        Box::pin(async move { CoinPayments::create(self, &req).await })
    }
    fn query<'a>(&'a self, otn: &'a str) -> BoxFut<'a, Result<Query, CallError>> {
        Box::pin(CoinPayments::query(self, otn))
    }
    fn close<'a>(&'a self, otn: &'a str) -> BoxFut<'a, Result<Close, CallError>> {
        Box::pin(CoinPayments::close(self, otn))
    }
    fn verify_notify(&self, req: &NotifyRequest<'_>) -> NotifyCheck {
        self.check_notify(req)
    }
    fn notify_ack(&self) -> &'static str {
        "ok"
    }
    fn test_connection(&self) -> BoxFut<'_, TestOutcome> {
        Box::pin(CoinPayments::test_connection(self))
    }
}

// ---------------------------------------------------------------------------
// Kind: configuration
// ---------------------------------------------------------------------------

/// The CoinPayments provider kind.
///
/// config (plain JSON): instance (a|b|c), api_base (tests: loopback http
/// only), client_id, currency_id, currency, rate_cents, order_timeout_minutes,
/// secret_fingerprint. secrets (sealed): client_secret.
pub struct CoinPaymentsKind;

const KNOWN: &[&str] = &[
    "instance",
    "api_base",
    "client_id",
    "client_secret",
    "currency_id",
    "currency",
    "rate_cents",
    "order_timeout_minutes",
];

fn fingerprint(secret: &str) -> String {
    crypto::fingerprint("akari/coinpayments-secret-fingerprint/v1", secret)
}

fn secret_of(secrets: &Value) -> Option<String> {
    text_field(secrets, "client_secret").filter(|s| token_ok(s, MAX_ID))
}

fn instance_base(instance: &str) -> Option<&'static str> {
    INSTANCES
        .iter()
        .find(|(k, _)| *k == instance)
        .map(|(_, u)| *u)
}

fn client_id_ok(v: &str) -> bool {
    (8..=MAX_ID).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn currency_id_ok(v: &str) -> bool {
    !v.is_empty() && v.len() <= 12 && v.bytes().all(|b| b.is_ascii_digit())
}

impl ProviderKind for CoinPaymentsKind {
    fn id(&self) -> &'static str {
        KIND
    }
    fn label(&self) -> &'static str {
        "CoinPayments"
    }
    fn schema(&self) -> Value {
        json!([
            {"name": "instance", "label": "平台实例（注册时所属的 CoinPayments 实例）", "type": "select", "required": true,
             "options": [{"value": "a", "label": "实例 A（a-api.coinpayments.net）"},
                         {"value": "b", "label": "实例 B（b-api.coinpayments.net）"},
                         {"value": "c", "label": "实例 C（c-api.coinpayments.net）"}]},
            {"name": "client_id", "label": "客户端 ID（API 集成的 clientId）", "type": "text", "required": true},
            {"name": "client_secret", "label": "客户端密钥（clientSecret，也用于验证回调签名）", "type": "text", "secret": true, "required": true},
            {"name": "currency", "label": "发票币种代码（ISO，如 USD；币种为 CNY 时无需汇率）", "type": "text", "required": true, "default": "USD"},
            {"name": "currency_id", "label": "发票币种 ID（该法币在 CoinPayments 的数字 ID）", "type": "text", "required": true},
            {"name": "rate_cents", "label": "汇率：1.00 发票币种 = 多少分人民币（如 USD 填 720；CNY 留空）", "type": "number"},
            {"name": "order_timeout_minutes", "label": "订单有效期（分钟，5–120）", "type": "number",
             "required": true, "default": 60}
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
        let instance = text_field(input, "instance").unwrap_or_else(|| "a".into());
        if instance_base(&instance).is_none() {
            return Err(bad_request!(
                "payments.coinpayments_instance_invalid",
                "instance must be a, b or c"
            ));
        }
        let api_base = match text_field(input, "api_base") {
            None => None,
            Some(u) => Some(crypto::api_base(&u, &official_bases()).ok_or_else(|| {
                bad_request!(
                    "payments.coinpayments_api_base_invalid",
                    "api_base must be a CoinPayments API host"
                )
            })?),
        };
        let client_id = text_field(input, "client_id");
        if client_id.as_deref().is_some_and(|v| !client_id_ok(v)) {
            return Err(bad_request!(
                "payments.coinpayments_client_id_invalid",
                "client_id must be 8-128 letters, digits or hyphens"
            ));
        }
        let new_secret = text_field(input, "client_secret");
        if new_secret.as_deref().is_some_and(|v| !token_ok(v, MAX_ID)) {
            return Err(bad_request!(
                "payments.coinpayments_secret_invalid",
                "client_secret must be 1-128 visible ASCII characters"
            ));
        }
        let currency_id = text_field(input, "currency_id");
        if currency_id.as_deref().is_some_and(|v| !currency_id_ok(v)) {
            return Err(bad_request!(
                "payments.coinpayments_currency_id_invalid",
                "currency_id must be the numeric id of a fiat currency"
            ));
        }
        let currency = text_field(input, "currency").unwrap_or_else(|| "USD".into());
        let rate = crypto::validate_pricing(&currency, crypto::rate_field(input)?, complete)?;
        let timeout = match input.get("order_timeout_minutes") {
            None | Some(Value::Null) => 60,
            Some(v) => v.as_i64().unwrap_or(-1),
        };
        if !(5..=120).contains(&timeout) {
            return Err(bad_request!(
                "payments.timeout_range",
                "order_timeout_minutes must be 5-120"
            ));
        }
        let prev_secrets = prev.map(|(_, s)| s);
        let secret = new_secret
            .clone()
            .or_else(|| prev_secrets.and_then(secret_of));
        if complete && (client_id.is_none() || secret.is_none() || currency_id.is_none()) {
            return Err(conflict!(
                "payments.incomplete",
                "enabling needs the client id, the client secret and the invoice currency id"
            ));
        }
        let config = json!({
            "instance": instance,
            "api_base": api_base,
            "client_id": client_id,
            "currency_id": currency_id,
            "currency": currency,
            "rate_cents": rate,
            "order_timeout_minutes": timeout,
            "client_secret_fingerprint": secret.as_deref().map(fingerprint),
        });
        let mut secrets = prev_secrets.cloned().unwrap_or_else(|| json!({}));
        let mut changed = Vec::new();
        if let Some(s) = new_secret {
            secrets["client_secret"] = Value::String(s);
            changed.push("client_secret");
        }
        Ok(Validated {
            config,
            secrets,
            changed_secrets: changed,
        })
    }

    fn build(&self, config: &Value, secrets: &Value) -> Result<Arc<dyn PaymentProvider>, String> {
        let base = match text_field(config, "api_base") {
            Some(u) => crypto::api_base(&u, &official_bases()).ok_or("bad api_base")?,
            None => text_field(config, "instance")
                .and_then(|i| instance_base(&i))
                .ok_or("bad instance")?
                .to_string(),
        };
        let client_id = text_field(config, "client_id")
            .filter(|c| client_id_ok(c))
            .ok_or("client_id missing")?;
        let currency_id = text_field(config, "currency_id")
            .filter(|c| currency_id_ok(c))
            .ok_or("currency_id missing")?;
        let secret = secret_of(secrets).ok_or("client_secret missing or unreadable")?;
        let currency = text_field(config, "currency").ok_or("currency missing")?;
        let pricing = Pricing::new(&currency, config.get("rate_cents").and_then(Value::as_i64))
            .ok_or("currency or rate invalid")?;
        let params = Params {
            base,
            client_id,
            currency_id,
            pricing,
            order_timeout_minutes: config
                .get("order_timeout_minutes")
                .and_then(Value::as_u64)
                .unwrap_or(60)
                .clamp(5, 120) as u32,
        };
        Ok(Arc::new(CoinPayments::new(params, secret)))
    }

    fn view(&self, config: &Value, secrets: Option<&Value>) -> Value {
        let mut v = json!({});
        for k in [
            "instance",
            "api_base",
            "client_id",
            "currency_id",
            "currency",
            "rate_cents",
            "order_timeout_minutes",
            "client_secret_fingerprint",
        ] {
            v[k] = config.get(k).cloned().unwrap_or(Value::Null);
        }
        v["client_secret_set"] =
            Value::Bool(secrets.is_some_and(|s| s.get("client_secret").is_some()));
        v["client_secret_readable"] = Value::Bool(secrets.and_then(secret_of).is_some());
        v
    }

    fn peek_out_trade_no(&self, _body: &[u8]) -> Option<String> {
        None
    }

    fn default_icon(&self, _config: &Value) -> Option<&'static str> {
        Some("crypto")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    pub const CLIENT: &str = "4f8b9d2e-1234-5678-9abc-def012345678";
    pub const SECRET: &str = "test-secret";
    pub const CURRENCY_ID: &str = "5057";
    pub const NOTIFY_URL: &str =
        "https://panel.example/pay/9b0e5f2a-0000-4000-8000-000000000001/notify";

    pub fn params(base: &str) -> Params {
        Params {
            base: base.into(),
            client_id: CLIENT.into(),
            currency_id: CURRENCY_ID.into(),
            pricing: Pricing::new("USD", Some(720)).unwrap(),
            order_timeout_minutes: 60,
        }
    }

    pub fn client() -> CoinPayments {
        CoinPayments::new(params("https://a-api.coinpayments.net"), SECRET.into())
    }

    /// A webhook payload as CoinPayments sends it (documented field names).
    pub fn payload(kind: &str, state: &str, otn: &str, total: &str, cents: i64) -> String {
        json!({
            "id": null,
            "type": kind,
            "timestamp": "2026-10-27T10:00:00Z",
            "invoice": {
                "invoiceId": otn,
                "id": "inv-0001",
                "amount": {"currencyId": 5057, "subtotal": total, "total": total},
                "customData": {"akari_cents": cents.to_string(), "akari_order": otn},
                "state": state,
                "payments": [{"id": "p1", "state": "Completed"}],
            }
        })
        .to_string()
    }

    /// Signed webhook headers for `body` at `ts` (the integration's secret).
    pub fn signed_headers(body: &str, ts: &str, url: &str) -> HeaderMap {
        let message = signing_message("POST", url, CLIENT, ts, body);
        let mut h = HeaderMap::new();
        h.insert("x-coinpayments-client", HeaderValue::from_static(CLIENT));
        h.insert(
            "x-coinpayments-timestamp",
            HeaderValue::from_str(ts).unwrap(),
        );
        h.insert(
            "x-coinpayments-signature",
            HeaderValue::from_str(&signature(SECRET, &message)).unwrap(),
        );
        h
    }

    pub const NOW: i64 = 1_792_000_000;

    fn check(
        c: &CoinPayments,
        body: &str,
        headers: &HeaderMap,
        url: Option<&str>,
        now: i64,
    ) -> NotifyCheck {
        c.check_notify(&NotifyRequest {
            body: body.as_bytes(),
            headers,
            url,
            now_unix: now,
        })
    }

    fn reason(r: NotifyCheck) -> (bool, &'static str) {
        match r {
            NotifyCheck::Rejected {
                verified, reason, ..
            } => (verified, reason),
            r => panic!("{r:?}"),
        }
    }

    #[test]
    fn signature_vectors() {
        // The documented construction (6 inputs, no separators, BOM first),
        // signed with an independent HMAC-SHA256 implementation (python
        // hmac): the docs publish no literal signature value.
        let body = r#"{"currency":"4","label":"Online Shop Wallet"}"#;
        let m = signing_message(
            "POST",
            "https://a-api.coinpayments.net/api/v2/merchant/wallets",
            "4f8b9d2e-1234-5678-9abc-def012345678",
            "2026-10-06T06:56:45",
            body,
        );
        assert!(m.starts_with("\u{feff}POSThttps://a-api"));
        assert!(m.ends_with(body));
        assert_eq!(
            signature("test-secret", &m),
            "6cMYhtzG5LLMq7/sil9qU6eNZQlo97krwolha77h60g="
        );
        assert!(signature_valid(
            "test-secret",
            &m,
            "6cMYhtzG5LLMq7/sil9qU6eNZQlo97krwolha77h60g="
        ));
        assert!(!signature_valid(
            "other",
            &m,
            "6cMYhtzG5LLMq7/sil9qU6eNZQlo97krwolha77h60g="
        ));
        assert!(!signature_valid("test-secret", &m, "not base64!"));
        assert!(!signature_valid("test-secret", &m, ""));
        assert!(!signature_valid(
            "test-secret",
            &format!("{m} "),
            "6cMYhtzG5LLMq7/sil9qU6eNZQlo97krwolha77h60g="
        ));
        // An empty body is just the missing last element (GET).
        assert_eq!(signing_message("GET", "u", "c", "t", ""), "\u{feff}GETuct");
    }

    #[test]
    fn completed_webhook_pays() {
        let c = client();
        // 990 CNY cents at 7.20 → 1.375 → 1.38 USD (rounded up).
        let body = payload("InvoiceCompleted", "Completed", "AK1", "1.38", 990);
        let h = signed_headers(&body, &utc_stamp(NOW), NOTIFY_URL);
        match check(&c, &body, &h, Some(NOTIFY_URL), NOW) {
            NotifyCheck::Verified(ev) => {
                assert_eq!(ev.out_trade_no, "AK1");
                assert_eq!(ev.trade_no.as_deref(), Some("inv-0001"));
                assert!(ev.paid);
                assert_eq!(ev.total_cents, Some(990));
                assert_eq!(ev.status, "completed");
                assert!(!ev.params.to_string().contains(SECRET));
            }
            r => panic!("{r:?}"),
        }
        // Event type matters as much as the state.
        for (kind, state) in [
            ("InvoicePaid", "Paid"),
            ("InvoicePending", "Pending"),
            ("InvoiceCompleted", "Pending"),
            ("InvoicePaid", "Completed"),
            ("InvoiceCancelled", "Cancelled"),
            ("InvoiceTimedOut", "TimedOut"),
            ("InvoiceCreated", "Unpaid"),
        ] {
            let body = payload(kind, state, "AK1", "1.38", 990);
            let h = signed_headers(&body, &utc_stamp(NOW), NOTIFY_URL);
            match check(&c, &body, &h, Some(NOTIFY_URL), NOW) {
                NotifyCheck::Verified(ev) => {
                    assert!(!ev.paid, "{kind}/{state}");
                    assert_eq!(ev.total_cents, Some(990), "{kind}/{state} names its order");
                }
                r => panic!("{r:?}"),
            }
        }
    }

    #[test]
    fn forged_stale_or_misdirected_webhooks_do_not_verify() {
        let c = client();
        let body = payload("InvoiceCompleted", "Completed", "AK1", "1.38", 990);
        let ts = utc_stamp(NOW);
        let good = signed_headers(&body, &ts, NOTIFY_URL);
        // Wrong secret, body, URL, timestamp, client.
        let other = CoinPayments::new(params("https://a-api.coinpayments.net"), "another".into());
        assert_eq!(
            reason(check(&other, &body, &good, Some(NOTIFY_URL), NOW)),
            (false, "bad_signature")
        );
        let tampered = body.replace("1.38", "0.01");
        assert_eq!(
            reason(check(&c, &tampered, &good, Some(NOTIFY_URL), NOW)),
            (false, "bad_signature")
        );
        assert_eq!(
            reason(check(
                &c,
                &body,
                &good,
                Some("https://panel.example/pay/other/notify"),
                NOW
            )),
            (false, "bad_signature")
        );
        assert_eq!(
            reason(check(&c, &body, &good, None, NOW)),
            (false, "no_notify_url")
        );
        let mut t = good.clone();
        t.insert(
            "x-coinpayments-timestamp",
            HeaderValue::from_static("2026-10-27T10:00:01"),
        );
        assert_eq!(
            reason(check(&c, &body, &t, Some(NOTIFY_URL), NOW)),
            (false, "bad_signature")
        );
        let mut t = good.clone();
        t.insert(
            "x-coinpayments-client",
            HeaderValue::from_static("someone-else-entirely"),
        );
        assert_eq!(
            reason(check(&c, &body, &t, Some(NOTIFY_URL), NOW)),
            (false, "bad_signature")
        );
        for missing in [
            "x-coinpayments-client",
            "x-coinpayments-timestamp",
            "x-coinpayments-signature",
        ] {
            let mut t = good.clone();
            t.remove(missing);
            assert_eq!(
                reason(check(&c, &body, &t, Some(NOTIFY_URL), NOW)),
                (false, "bad_signature"),
                "{missing}"
            );
        }
        assert_eq!(
            reason(check(&c, &body, &HeaderMap::new(), Some(NOTIFY_URL), NOW)),
            (false, "bad_signature")
        );
        // A genuine signature on an old (or future) timestamp is a replay.
        assert_eq!(
            reason(check(&c, &body, &good, Some(NOTIFY_URL), NOW + 301)),
            (true, "stale_timestamp")
        );
        assert_eq!(
            reason(check(&c, &body, &good, Some(NOTIFY_URL), NOW - 301)),
            (true, "stale_timestamp")
        );
        assert!(matches!(
            check(&c, &body, &good, Some(NOTIFY_URL), NOW + 300),
            NotifyCheck::Verified(_)
        ));
        // Signed but not an invoice event / not JSON.
        for junk in [
            "not json",
            "[]",
            r#"{"type":"InvoiceCompleted"}"#,
            r#"{"invoice":5}"#,
        ] {
            let h = signed_headers(junk, &ts, NOTIFY_URL);
            assert_eq!(
                reason(check(&c, junk, &h, Some(NOTIFY_URL), NOW)),
                (true, "malformed"),
                "{junk}"
            );
        }
        // No external invoice id = not one of our orders.
        let anon = r#"{"type":"InvoiceCompleted","invoice":{"id":"x","state":"Completed"}}"#;
        let h = signed_headers(anon, &ts, NOTIFY_URL);
        assert_eq!(
            reason(check(&c, anon, &h, Some(NOTIFY_URL), NOW)),
            (true, "unknown_order")
        );
    }

    #[test]
    fn amounts_and_currency_must_match_exactly() {
        let c = client();
        let verdict = |total: &str, cents: i64, currency: Value| {
            let mut v: Value = serde_json::from_str(&payload(
                "InvoiceCompleted",
                "Completed",
                "AK1",
                total,
                cents,
            ))
            .unwrap();
            v["invoice"]["amount"]["currencyId"] = currency;
            let body = v.to_string();
            let h = signed_headers(&body, &utc_stamp(NOW), NOTIFY_URL);
            match check(&c, &body, &h, Some(NOTIFY_URL), NOW) {
                NotifyCheck::Verified(ev) => (ev.paid, ev.total_cents),
                r => panic!("{r:?}"),
            }
        };
        assert_eq!(verdict("1.38", 990, json!(5057)), (true, Some(990)));
        assert_eq!(verdict("1.38", 990, json!("5057")), (true, Some(990)));
        // Underpaid invoice total, another amount, another currency, an
        // integer-looking amount, a missing/zero cents echo: never an amount.
        assert_eq!(verdict("1.37", 990, json!(5057)), (true, None));
        assert_eq!(verdict("13.80", 990, json!(5057)), (true, None));
        assert_eq!(verdict("1.38", 990, json!(5058)), (true, None));
        assert_eq!(verdict("138", 990, json!(5057)), (true, None));
        assert_eq!(verdict("1.38", 0, json!(5057)), (true, None));
        assert_eq!(verdict("1.38", 1000, json!(5057)), (true, None));
        let mut v: Value = serde_json::from_str(&payload(
            "InvoiceCompleted",
            "Completed",
            "AK1",
            "1.38",
            990,
        ))
        .unwrap();
        v["invoice"].as_object_mut().unwrap().remove("customData");
        let body = v.to_string();
        let h = signed_headers(&body, &utc_stamp(NOW), NOTIFY_URL);
        match check(&c, &body, &h, Some(NOTIFY_URL), NOW) {
            NotifyCheck::Verified(ev) => assert_eq!(ev.total_cents, None),
            r => panic!("{r:?}"),
        }
    }

    #[test]
    fn rest_invoice_shape() {
        let c = client();
        let inv = json!({
            "id": "inv-0001", "invoiceId": "AK1", "status": "completed",
            "currency": {"id": "5057", "symbol": "USD"},
            "amount": {"breakdown": {"subtotal": "1.38"}, "total": "1.38"},
            "customData": {"akari_cents": "990"},
            "payments": [{"state": "completed"}],
        });
        let f = facts(&inv);
        assert_eq!(c.judge(&f), (true, Some(990)));
        assert_eq!(f.payment_states, ["completed"]);
        for (status, paid) in [
            ("paid", false),
            ("pending", false),
            ("unpaid", false),
            ("timedOut", false),
            ("Completed", true),
        ] {
            let mut t = inv.clone();
            t["status"] = json!(status);
            assert_eq!(c.judge(&facts(&t)).0, paid, "{status}");
        }
    }

    #[test]
    fn create_and_list_answers() {
        assert_eq!(
            parse_create(br#"{"invoices":[{"id":"i1","link":"https://pay.example/l","checkoutLink":"https://pay.example/c"}]}"#).unwrap(),
            Checkout::Redirect("https://pay.example/c".into())
        );
        assert_eq!(
            parse_create(br#"{"invoices":[{"id":"i1","checkoutLink":"javascript:x","link":"https://pay.example/l"}]}"#).unwrap(),
            Checkout::Redirect("https://pay.example/l".into())
        );
        for bad in [
            &b"{}"[..],
            b"[]",
            b"nope",
            br#"{"invoices":[]}"#,
            br#"{"invoices":[{"link":"http://pay.example/x"}]}"#,
        ] {
            assert!(matches!(parse_create(bad), Err(CallError::Malformed(_))));
        }
        let list = br#"{"items":[{"id":"x1","invoiceId":"AK10"},{"id":"x2","invoiceId":"AK1"}]}"#;
        assert_eq!(pick_invoice(list, "AK1").unwrap().as_deref(), Some("x2"));
        assert_eq!(pick_invoice(list, "AK2").unwrap(), None);
        assert!(matches!(
            pick_invoice(
                br#"{"items":[{"id":"a","invoiceId":"AK1"},{"id":"b","invoiceId":"AK1"}]}"#,
                "AK1"
            ),
            Err(CallError::Malformed("ambiguous invoice"))
        ));
        assert!(matches!(
            pick_invoice(br#"{"items":[{"id":"../x","invoiceId":"AK1"}]}"#, "AK1"),
            Err(CallError::Malformed("bad invoice id"))
        ));
        assert!(pick_invoice(b"{}", "AK1").is_err());
    }

    #[test]
    fn create_body_is_priced_in_the_invoice_currency() {
        let c = client();
        let req = CreateReq {
            out_trade_no: "AK1",
            amount_cents: 990,
            subject: "Akari - 月付",
            notify_url: NOTIFY_URL,
            return_url: "https://panel.example/orders/1",
            client_ip: None,
        };
        let v: Value = serde_json::from_str(&c.create_body(&req).unwrap()).unwrap();
        assert_eq!(v["currency"], CURRENCY_ID);
        assert_eq!(v["invoiceId"], "AK1");
        assert_eq!(v["amount"]["total"], "1.38");
        assert_eq!(v["items"][0]["amount"], "1.38");
        assert_eq!(v["customData"]["akari_cents"], "990");
        assert_eq!(v["webhooks"][0]["notificationsUrl"], NOTIFY_URL);
        assert_eq!(v["webhooks"][0]["notifications"][0], "invoiceCompleted");
        assert!(v.get("payment").is_none());
        let none = CreateReq {
            return_url: "",
            ..req.clone()
        };
        let v: Value = serde_json::from_str(&c.create_body(&none).unwrap()).unwrap();
        assert!(v.get("successUrl").is_none());
        assert!(
            c.create_body(&CreateReq {
                amount_cents: 0,
                ..req
            })
            .is_err()
        );
    }

    #[test]
    fn test_connection_outcomes() {
        let ok = || Ok(());
        type Case = (
            Result<(), CallError>,
            Result<Option<String>, CallError>,
            bool,
            &'static str,
        );
        let cases: Vec<Case> = vec![
            (ok(), Ok(Some("USD".into())), true, "keys_ok"),
            (ok(), Ok(Some("EUR".into())), false, "currency_mismatch"),
            (ok(), Ok(None), false, "currency_unknown"),
            (
                ok(),
                Err(CallError::Malformed("x")),
                false,
                "currency_unknown",
            ),
            (
                ok(),
                Err(CallError::Transport("x".into())),
                false,
                "unreachable",
            ),
            (
                Err(CallError::Status(401)),
                Ok(None),
                false,
                "credentials_rejected",
            ),
            (
                Err(CallError::Status(403)),
                Ok(None),
                false,
                "credentials_rejected",
            ),
            (
                Err(CallError::Status(502)),
                Ok(None),
                false,
                "gateway_status",
            ),
            (
                Err(CallError::Transport("x".into())),
                Ok(None),
                false,
                "unreachable",
            ),
            (Err(CallError::Malformed("x")), Ok(None), false, "malformed"),
        ];
        for (auth, cur, want_ok, result) in cases {
            let o = judge_test(&auth, cur, "USD");
            assert_eq!((o.ok, o.result), (want_ok, result), "{}", o.message);
        }
    }

    #[test]
    fn kind_validation() {
        let k = CoinPaymentsKind;
        let good = json!({
            "instance": "b", "client_id": CLIENT, "client_secret": SECRET,
            "currency": "USD", "currency_id": CURRENCY_ID, "rate_cents": 720,
            "order_timeout_minutes": 30,
        });
        let v = k.validate(&good, None, true).ok().unwrap();
        assert_eq!(v.config["rate_cents"], 720);
        assert_eq!(v.secrets["client_secret"], SECRET);
        assert_eq!(v.changed_secrets, ["client_secret"]);
        assert!(!v.config.to_string().contains(SECRET));
        let view = k.view(&v.config, Some(&v.secrets));
        assert!(!view.to_string().contains(SECRET));
        assert_eq!(view["client_secret_set"], true);
        assert_eq!(view["client_secret_readable"], true);
        assert_eq!(k.default_icon(&v.config), Some("crypto"));
        let p = k.build(&v.config, &v.secrets).unwrap();
        assert_eq!((p.kind(), p.order_timeout_minutes()), (KIND, 30));
        assert!(!p.refunds() && !p.notify_get());
        assert!(!format!("{p:?}").contains(SECRET));
        // CNY needs no rate; the stored rate is dropped.
        let cny = json!({"client_id": CLIENT, "client_secret": SECRET, "currency": "CNY",
                         "currency_id": "5000", "rate_cents": 5});
        let v2 = k.validate(&cny, None, true).ok().unwrap();
        assert!(v2.config["rate_cents"].is_null());
        // Editing without the secret keeps it.
        let edit = json!({"client_id": CLIENT, "currency": "USD", "currency_id": CURRENCY_ID, "rate_cents": "700"});
        let v3 = k
            .validate(&edit, Some((&v.config, &v.secrets)), true)
            .ok()
            .unwrap();
        assert_eq!(v3.secrets["client_secret"], SECRET);
        assert!(v3.changed_secrets.is_empty());
        assert_eq!(v3.config["rate_cents"], 700);
        // Incomplete may be saved disabled, not enabled; a USD method needs
        // its rate.
        let partial = json!({"client_id": CLIENT});
        assert!(k.validate(&partial, None, false).is_ok());
        assert_eq!(
            k.validate(&partial, None, true).err().unwrap().code(),
            "payments.incomplete"
        );
        let no_rate = json!({"client_id": CLIENT, "client_secret": SECRET, "currency_id": CURRENCY_ID, "currency": "USD"});
        assert_eq!(
            k.validate(&no_rate, None, true).err().unwrap().code(),
            "payments.incomplete"
        );
        assert!(k.build(&json!({}), &json!({})).is_err());
        let codes = [
            (json!([]), "payments.config_invalid"),
            (json!({"x": 1}), "payments.config_unknown_field"),
            (
                json!({"instance": "z"}),
                "payments.coinpayments_instance_invalid",
            ),
            (
                json!({"api_base": "https://evil.example"}),
                "payments.coinpayments_api_base_invalid",
            ),
            (
                json!({"client_id": "short"}),
                "payments.coinpayments_client_id_invalid",
            ),
            (
                json!({"client_secret": "a b"}),
                "payments.coinpayments_secret_invalid",
            ),
            (
                json!({"currency_id": "USD"}),
                "payments.coinpayments_currency_id_invalid",
            ),
            (json!({"currency": "usd"}), "payments.currency_invalid"),
            (json!({"rate_cents": 0}), "payments.rate_invalid"),
            (json!({"rate_cents": "x"}), "payments.rate_invalid"),
            (
                json!({"order_timeout_minutes": 4}),
                "payments.timeout_range",
            ),
        ];
        for (input, code) in codes {
            assert_eq!(
                k.validate(&input, None, false).err().unwrap().code(),
                code,
                "{input}"
            );
        }
        // Mock gateways only on loopback http.
        let local = json!({"api_base": "http://127.0.0.1:9"});
        assert_eq!(
            k.validate(&local, None, false).ok().unwrap().config["api_base"],
            "http://127.0.0.1:9"
        );
        // A stored secret that no longer opens: the view says so.
        let view = k.view(&v.config, Some(&json!({"client_secret": "bad secret"})));
        assert_eq!(
            (&view["client_secret_set"], &view["client_secret_readable"]),
            (&Value::Bool(true), &Value::Bool(false))
        );
        assert_eq!(k.view(&v.config, None)["client_secret_set"], false);
        assert!(k.schema().as_array().is_some_and(|a| a.len() == 7));
        assert_eq!(k.label(), "CoinPayments");
        assert_eq!(k.peek_out_trade_no(b"x"), None);
    }
}
