//! Coinbase (Business Checkouts API) as a payment provider kind
//! (`coinbase`): a hosted, single-use crypto checkout per order.
//!
//! DECISION: the Checkouts API, not Commerce charges. The Checkouts API can
//! create a checkout from the server (`POST /api/v1/checkouts`), read it back
//! (`GET /api/v1/checkouts/{id}`, list with a description filter) and
//! deactivate it, and it delivers signed webhooks — everything the flow needs,
//! so the legacy Commerce API is not used.
//!
//! Official documentation (checked 2026-10-27, https://docs.cdp.coinbase.com):
//! - /coinbase-business/checkout-apis (overview; fulfil on the payment-success
//!   webhook or poll Get Checkout to a terminal status, never on the redirect),
//! - /coinbase-business/checkout-apis/webhooks (events; the
//!   `X-Webhook-Signature` header `t=<unix seconds>,h=<header names>,v1=<hex>`;
//!   signed payload `"{t}.{h}.{header values joined by '.'}.{raw body}"`,
//!   HMAC-SHA256 with the subscription secret, hex; reject timestamps more than
//!   five minutes old),
//! - /api-reference/business-api/rest-api/checkouts-spec.yaml (OpenAPI: create,
//!   list, get, deactivate; statuses ACTIVE / PROCESSING / DEACTIVATED /
//!   EXPIRED / COMPLETED / FAILED / REFUNDED / PARTIALLY_REFUNDED; amounts are
//!   decimal strings with at most two places; a fiat `currency` is converted to
//!   USDC at creation and the original is echoed as `fiatAmount` /
//!   `fiatCurrency`),
//! - /coinbase-business/authentication-authorization/api-key-authentication and
//!   /api-reference/v2/authentication (a JWT signed with the CDP API key, valid
//!   two minutes, claim `uri` = "METHOD host/path"; Ed25519 keys sign EdDSA,
//!   ECDSA keys ES256).
//!
//! WHICH STATUS PAYS. Only `COMPLETED` ("the payable endpoint has been
//! successfully paid"), as the webhook `checkout.payment.success` or as the
//! checkout read back by the reconciliation. `PROCESSING`, `ACTIVE`,
//! `EXPIRED`, `DEACTIVATED`, `FAILED` and the refund states never pay.
//!
//! AMOUNT. The checkout is created in the configured fiat currency
//! (`crypto::Pricing`; USDC is also accepted: "amount is used directly"); the
//! gateway converts to USDC and carries the rate risk. The webhook / read-back
//! must echo that fiat amount and currency (`fiatAmount`/`fiatCurrency`, or
//! `amount`/`currency` for a USDC checkout) equal to what `Pricing` computes
//! from the order cents we store in `metadata`; anything else reports no
//! amount, so `handle_notify` records `amount_mismatch` and nothing is paid.
//!
//! WEBHOOK SETUP IS PER ACCOUNT, not per checkout: the operator creates one
//! subscription per payment method (target = the method's notify URL, event
//! types `checkout.payment.*`) and pastes its secret here. A subscription
//! delivers events of every checkout of the account; events of checkouts that
//! are not this method's orders are refused as unknown orders.
//!
//! No refund through the gateway (`refunds()` false: the refund endpoint takes
//! USDC/fiat amounts without our idempotent request-number scheme).
//!
//! Secrets: the API secret and the webhook secret never leave `Coinbase` (no
//! Debug); bearer tokens, bodies and URLs are not logged; gateway bodies are
//! never echoed.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use hyper::body::Bytes;
use serde_json::{Value, json};

use super::crypto::{
    self, AmountFormat, MAX_SKEW_SECS, Pricing, host_of, link_ok, text_field, token_ok,
};
use super::provider::{
    BoxFut, CallError, Checkout, Close, CreateReq, NotifyCheck, NotifyEvent, NotifyRequest,
    PaymentProvider, ProviderKind, Query, TestOutcome, Validated,
};
use crate::auth::{ApiError, bad_request, conflict};

/// Kind id.
pub const KIND: &str = "coinbase";
const OFFICIAL: &str = "https://business.coinbase.com";
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// A JWT is valid two minutes (the documented value).
const JWT_TTL_SECS: i64 = 120;
const MAX_DESCRIPTION: usize = 500;
const MAX_KEY_ID: usize = 200;
const MAX_WEBHOOK_SECRET: usize = 512;
const MAX_SECRET: usize = 8192;
/// The webhook event that can pay.
const PAID_EVENT: &str = "checkout.payment.success";

// ---------------------------------------------------------------------------
// API authentication (JWT)
// ---------------------------------------------------------------------------

/// The CDP API key: an Ed25519 key (base64 of seed ‖ public key, EdDSA) or an
/// ECDSA P-256 PEM key (ES256).
pub enum Signer {
    Ed25519(ring::signature::Ed25519KeyPair),
    Es256(ring::signature::EcdsaKeyPair),
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Ed25519(_) => "Signer::Ed25519",
            Self::Es256(_) => "Signer::Es256",
        })
    }
}

impl Signer {
    /// Parse the secret as the key page shows it: a PEM (`EC PRIVATE KEY` or
    /// PKCS#8, `\n` escapes accepted) or the base64 Ed25519 secret.
    pub fn parse(secret: &str) -> Result<Self, &'static str> {
        let s = secret.trim().replace("\\n", "\n");
        if s.starts_with("-----BEGIN") {
            let key = openssl::pkey::PKey::private_key_from_pem(s.as_bytes())
                .map_err(|_| "unreadable PEM key")?;
            let ec = key.ec_key().map_err(|_| "not an EC key")?;
            if ec.group().curve_name() != Some(openssl::nid::Nid::X9_62_PRIME256V1) {
                return Err("not a P-256 key");
            }
            let der = key.private_key_to_pkcs8().map_err(|_| "unreadable key")?;
            let rng = ring::rand::SystemRandom::new();
            return ring::signature::EcdsaKeyPair::from_pkcs8(
                &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
                &der,
                &rng,
            )
            .map(Self::Es256)
            .map_err(|_| "unusable P-256 key");
        }
        let raw = STANDARD
            .decode(&s)
            .or_else(|_| STANDARD_NO_PAD.decode(&s))
            .map_err(|_| "neither a PEM nor a base64 Ed25519 key")?;
        if raw.len() != 64 {
            return Err("an Ed25519 secret is 64 bytes (seed and public key)");
        }
        ring::signature::Ed25519KeyPair::from_seed_and_public_key(&raw[..32], &raw[32..])
            .map(Self::Ed25519)
            .map_err(|_| "inconsistent Ed25519 key")
    }

    /// The bearer token of one request (`uri` = "METHOD host/path").
    pub fn bearer(&self, key_id: &str, uri: &str, now: i64, nonce: &str) -> String {
        let (alg, aud) = match self {
            Self::Ed25519(_) => ("EdDSA", true),
            Self::Es256(_) => ("ES256", false),
        };
        let header = json!({"alg": alg, "typ": "JWT", "kid": key_id, "nonce": nonce});
        let mut claims = json!({
            "sub": key_id, "iss": "cdp", "nbf": now, "exp": now + JWT_TTL_SECS, "uri": uri,
        });
        if aud {
            claims["aud"] = json!(["cdp_service"]);
        }
        let signing = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let sig = match self {
            Self::Ed25519(k) => k.sign(signing.as_bytes()).as_ref().to_vec(),
            Self::Es256(k) => k
                .sign(&ring::rand::SystemRandom::new(), signing.as_bytes())
                .map(|s| s.as_ref().to_vec())
                .unwrap_or_default(),
        };
        format!("{signing}.{}", URL_SAFE_NO_PAD.encode(sig))
    }
}

// ---------------------------------------------------------------------------
// Webhook signature
// ---------------------------------------------------------------------------

/// The parts of `X-Webhook-Signature`: (timestamp, header names, v1 hex).
pub fn parse_signature_header(h: &str) -> Option<(&str, &str, &str)> {
    let (mut t, mut names, mut v1) = (None, None, None);
    for part in h.split(',') {
        let (k, v) = part.split_once('=')?;
        let slot = match k.trim() {
            "t" => &mut t,
            "h" => &mut names,
            "v1" => &mut v1,
            _ => continue,
        };
        if slot.replace(v.trim()).is_some() {
            return None;
        }
    }
    Some((t?, names?, v1?))
}

/// The signed payload: `t.h.<values of the named headers>.body`.
pub fn signed_payload(t: &str, names: &str, values: &[String], body: &str) -> String {
    format!("{t}.{names}.{}.{body}", values.join("."))
}

/// HMAC-SHA256 hex of the payload under the subscription secret.
pub fn webhook_signature(secret: &str, payload: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes());
    hex::encode(ring::hmac::sign(&key, payload.as_bytes()).as_ref())
}

fn webhook_valid(secret: &str, payload: &str, v1: &str) -> bool {
    let Ok(tag) = hex::decode(v1) else {
        return false;
    };
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes());
    ring::hmac::verify(&key, payload.as_bytes(), &tag).is_ok()
}

// ---------------------------------------------------------------------------
// Checkout facts (create answer, checkout by id, webhook payload)
// ---------------------------------------------------------------------------

/// What a checkout object says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    pub id: Option<String>,
    /// Upper-case status.
    pub status: String,
    /// Our order number (`metadata.akari_order`).
    pub order: Option<String>,
    /// The order's CNY cents (`metadata.akari_cents`).
    pub cents: Option<i64>,
    pub amount: Option<String>,
    pub currency: Option<String>,
    pub fiat_amount: Option<String>,
    pub fiat_currency: Option<String>,
}

pub fn facts(v: &Value) -> Facts {
    let meta = v.get("metadata");
    let meta_text = |k: &str| {
        meta.and_then(|m| m.get(k))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    Facts {
        id: text_field(v, "id"),
        status: v
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_uppercase(),
        order: meta_text("akari_order").filter(|o| !o.is_empty()),
        cents: meta_text("akari_cents")
            .and_then(|c| c.parse::<i64>().ok())
            .filter(|c| *c >= 1),
        amount: text_field(v, "amount"),
        currency: text_field(v, "currency"),
        fiat_amount: text_field(v, "fiatAmount"),
        fiat_currency: text_field(v, "fiatCurrency"),
    }
}

/// A checkout id as the OpenAPI pattern: 24 lower-case hex digits.
fn checkout_id_ok(id: &str) -> bool {
    id.len() == 24 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The checkout of `out_trade_no` among list results (`metadata.akari_order`).
pub fn pick_checkout(body: &[u8], out_trade_no: &str) -> Result<Option<String>, CallError> {
    let v: Value = serde_json::from_slice(body).map_err(|_| CallError::Malformed("not JSON"))?;
    let items = v
        .get("checkouts")
        .and_then(Value::as_array)
        .ok_or(CallError::Malformed("no checkouts"))?;
    let mut ids = items
        .iter()
        .filter(|c| facts(c).order.as_deref() == Some(out_trade_no))
        .filter_map(|c| text_field(c, "id"));
    let first = ids.next();
    if ids.any(|other| Some(&other) != first.as_ref()) {
        return Err(CallError::Malformed("ambiguous checkout"));
    }
    match first {
        Some(id) if checkout_id_ok(&id) => Ok(Some(id)),
        Some(_) => Err(CallError::Malformed("bad checkout id")),
        None => Ok(None),
    }
}

/// Parse a create answer: the hosted checkout URL.
pub fn parse_create(body: &[u8]) -> Result<Checkout, CallError> {
    let v: Value = serde_json::from_slice(body).map_err(|_| CallError::Malformed("not JSON"))?;
    text_field(&v, "url")
        .filter(|u| link_ok(u))
        .map(Checkout::Redirect)
        .ok_or(CallError::Malformed("no usable link"))
}

/// Our classification of an error body (`errorType`): a fixed word, never the
/// gateway's text.
pub fn error_class(body: &[u8]) -> &'static str {
    const KNOWN: &[&str] = &[
        "already_exists",
        "bad_gateway",
        "forbidden",
        "idempotency_error",
        "internal_server_error",
        "invalid_request",
        "not_found",
        "rate_limit_exceeded",
        "request_canceled",
        "service_unavailable",
        "timed_out",
        "unauthorized",
    ];
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| text_field(&v, "errorType"))
        .and_then(|t| KNOWN.iter().find(|k| **k == t).copied())
        .unwrap_or("unknown")
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// The non-secret parameters of a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Params {
    /// API base without a trailing slash.
    pub base: String,
    /// CDP API key name / id (JWT `kid` and `sub`).
    pub key_id: String,
    pub pricing: Pricing,
    pub order_timeout_minutes: u32,
}

pub struct Coinbase {
    pub params: Params,
    signer: Signer,
    webhook_secret: String,
}

impl std::fmt::Debug for Coinbase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Coinbase")
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

/// Interpret the 测试连接 read (pure; unit-tested).
pub fn judge_test(r: &Result<(), CallError>) -> TestOutcome {
    let out = |ok, result, message: String| TestOutcome {
        ok,
        result,
        message,
        code: None,
        sub_code: None,
    };
    match r {
        Ok(()) => out(
            true,
            "keys_ok",
            "连接正常：Coinbase 接受了 API 密钥（可读取收款链接）。回调签名密钥需要用一笔真实订单验证".into(),
        ),
        Err(CallError::Status(401)) => out(
            false,
            "credentials_rejected",
            "Coinbase 拒绝了 API 密钥（密钥 ID 或私钥不对，或 IP 白名单不含本面板）".into(),
        ),
        Err(CallError::Status(403)) => out(
            false,
            "forbidden",
            "API 密钥没有权限访问 Checkout 接口（需要 View 权限）".into(),
        ),
        Err(CallError::Transport(_)) => out(
            false,
            "unreachable",
            "无法连接 Coinbase 接口（网络或 DNS 问题）".into(),
        ),
        Err(CallError::Status(st)) => out(
            false,
            "gateway_status",
            format!("Coinbase 接口返回 HTTP {st}"),
        ),
        Err(_) => out(
            false,
            "malformed",
            "Coinbase 接口的响应无法解析".into(),
        ),
    }
}

impl Coinbase {
    pub fn new(params: Params, signer: Signer, webhook_secret: String) -> Self {
        Self {
            params,
            signer,
            webhook_secret,
        }
    }

    /// One authenticated call. `path` may carry a query string; the signed
    /// `uri` claim is `METHOD host/path` without it.
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<(u16, Bytes), CallError> {
        let host = host_of(&self.params.base).ok_or(CallError::Malformed("bad base"))?;
        let bare = path.split_once('?').map_or(path, |(p, _)| p);
        let nonce = hex::encode(rand::random::<[u8; 16]>());
        let token = self.signer.bearer(
            &self.params.key_id,
            &format!("{method} {host}{bare}"),
            chrono::Utc::now().timestamp(),
            &nonce,
        );
        let headers = [("Authorization", format!("Bearer {token}"))];
        let url = format!("{}{path}", self.params.base);
        let r = if method == "GET" {
            super::http::get_with(&url, &headers, CALL_TIMEOUT).await
        } else {
            super::http::post(
                &url,
                "application/json",
                &headers,
                body.unwrap_or_default().into_bytes(),
                CALL_TIMEOUT,
            )
            .await
        };
        r.map_err(CallError::Transport)
    }

    async fn get_json(&self, path: &str) -> Result<Vec<u8>, CallError> {
        crypto::read_with_retries(|| async {
            match self.call("GET", path, None).await? {
                (200, b) => Ok(b.to_vec()),
                (st, _) => Err(crypto::status_error(st)),
            }
        })
        .await
    }

    /// The create body (see the module docs).
    pub fn create_body(&self, req: &CreateReq<'_>, now: i64) -> Result<String, CallError> {
        let amount = self
            .params
            .pricing
            .text(req.amount_cents)
            .ok_or(CallError::Malformed("amount out of range"))?;
        let subject: String = req.subject.chars().filter(|c| !c.is_control()).collect();
        let description: String = format!("{} {subject}", req.out_trade_no)
            .chars()
            .take(MAX_DESCRIPTION)
            .collect();
        let expires = chrono::DateTime::from_timestamp(
            now + i64::from(self.params.order_timeout_minutes) * 60,
            0,
        )
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
        let mut v = json!({
            "amount": amount,
            "currency": self.params.pricing.currency,
            "description": description,
            "metadata": {
                "akari_order": req.out_trade_no,
                "akari_cents": req.amount_cents.to_string(),
            },
            "expiresAt": expires,
        });
        if req.return_url.starts_with("https://") && req.return_url.len() <= crypto::MAX_LINK {
            v["successRedirectUrl"] = json!(req.return_url);
            v["failRedirectUrl"] = json!(req.return_url);
        }
        Ok(v.to_string())
    }

    pub async fn create(&self, req: &CreateReq<'_>) -> Result<Checkout, CallError> {
        let body = self.create_body(req, chrono::Utc::now().timestamp())?;
        let (status, bytes) = self.call("POST", "/api/v1/checkouts", Some(body)).await?;
        if !matches!(status, 200 | 201) {
            tracing::warn!(
                status,
                class = error_class(&bytes),
                "coinbase create refused"
            );
            return Err(crypto::status_error(status));
        }
        parse_create(&bytes)
    }

    /// Whether `f` is a completed checkout, and the CNY cents it is worth when
    /// every number matches (see the module docs).
    pub fn judge(&self, f: &Facts) -> (bool, Option<i64>) {
        let (amount, currency) = if self.params.pricing.currency == "USDC" {
            (f.amount.as_deref(), f.currency.as_deref())
        } else {
            (f.fiat_amount.as_deref(), f.fiat_currency.as_deref())
        };
        let cents = f.cents.filter(|c| {
            currency == Some(self.params.pricing.currency.as_str())
                && amount.is_some_and(|a| self.params.pricing.matches(*c, a, AmountFormat::Plain))
        });
        (f.status == "COMPLETED", cents)
    }

    /// The checkout of `out_trade_no` (list by description, exact metadata
    /// match, then the checkout by id), or None when Coinbase has none.
    async fn find(&self, out_trade_no: &str) -> Result<Option<Facts>, CallError> {
        let q = form_urlencoded::Serializer::new(String::new())
            .append_pair("descriptionQuery", out_trade_no)
            .append_pair("pageSize", "10")
            .finish();
        let list = self.get_json(&format!("/api/v1/checkouts?{q}")).await?;
        let Some(id) = pick_checkout(&list, out_trade_no)? else {
            return Ok(None);
        };
        let body = self.get_json(&format!("/api/v1/checkouts/{id}")).await?;
        let v: Value =
            serde_json::from_slice(&body).map_err(|_| CallError::Malformed("not JSON"))?;
        let f = facts(&v);
        if f.order.as_deref() != Some(out_trade_no) || f.id.as_deref() != Some(id.as_str()) {
            return Err(CallError::Malformed("checkout answered another order"));
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
            "EXPIRED" | "DEACTIVATED" | "FAILED" => Ok(Close::Closed),
            "ACTIVE" => {
                let id = f.id.ok_or(CallError::Malformed("no checkout id"))?;
                if !checkout_id_ok(&id) {
                    return Err(CallError::Malformed("bad checkout id"));
                }
                match self
                    .call("POST", &format!("/api/v1/checkouts/{id}/deactivate"), None)
                    .await?
                {
                    (200, _) => Ok(Close::Closed),
                    (st, _) => Err(crypto::status_error(st)),
                }
            }
            // Processing or already paid: only a deactivation of an ACTIVE
            // checkout is possible, a late completion still fulfils.
            _ => Ok(Close::NotClosable),
        }
    }

    /// Verify a webhook (see the module docs).
    pub fn check_notify(&self, req: &NotifyRequest<'_>) -> NotifyCheck {
        let header = |name: &str| {
            let all: Vec<&str> = req
                .headers
                .get_all(name)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .collect();
            (!all.is_empty()).then(|| all.join(", "))
        };
        let Some(sig_header) = header("x-webhook-signature") else {
            return reject(false, "bad_signature", None, None, None);
        };
        let Some((t, names, v1)) = parse_signature_header(&sig_header) else {
            return reject(false, "bad_signature", None, None, None);
        };
        let listed: Vec<&str> = names.split(' ').collect();
        if names.len() > 1024
            || listed.len() > 32
            || listed
                .iter()
                .any(|n| n.len() > 64 || n.bytes().any(|b| !b.is_ascii_graphic()) && !n.is_empty())
        {
            return reject(false, "bad_signature", None, None, None);
        }
        let Ok(body) = std::str::from_utf8(req.body) else {
            return reject(false, "bad_signature", None, None, None);
        };
        let values: Vec<String> = listed
            .iter()
            .map(|n| header(&n.to_ascii_lowercase()).unwrap_or_default())
            .collect();
        if !webhook_valid(
            &self.webhook_secret,
            &signed_payload(t, names, &values, body),
            v1,
        ) {
            return reject(false, "bad_signature", None, None, None);
        }
        // Signed by the subscription secret from here on.
        let fresh = t
            .parse::<i64>()
            .is_ok_and(|t| (req.now_unix - t).abs() <= MAX_SKEW_SECS);
        if !fresh {
            return reject(true, "stale_timestamp", None, None, None);
        }
        let Ok(v) = serde_json::from_str::<Value>(body) else {
            return reject(true, "malformed", None, None, None);
        };
        if !v.is_object() {
            return reject(true, "malformed", None, None, None);
        }
        let event = text_field(&v, "eventType").unwrap_or_default();
        let f = facts(&v);
        let params = json!({
            "event": event,
            "checkout_id": f.id,
            "order": f.order,
            "status": f.status,
            "akari_cents": f.cents,
            "amount": f.amount,
            "currency": f.currency,
            "fiat_amount": f.fiat_amount,
            "fiat_currency": f.fiat_currency,
        });
        let Some(out_trade_no) = f.order.clone() else {
            return reject(true, "unknown_order", None, Some(event), Some(params));
        };
        let (completed, verified_cents) = self.judge(&f);
        let paid = completed && event == PAID_EVENT;
        NotifyCheck::Verified(NotifyEvent {
            out_trade_no,
            trade_no: f.id,
            status: if f.status.is_empty() { event } else { f.status },
            paid,
            // Only a payment needs the verified amount; any other event just
            // names the order it is about (acknowledged, nothing settles).
            total_cents: if paid { verified_cents } else { f.cents },
            params,
        })
    }

    /// 测试连接: a signed read of the checkout list.
    pub async fn test_connection(&self) -> TestOutcome {
        let r = self
            .get_json("/api/v1/checkouts?pageSize=1")
            .await
            .and_then(|b| {
                serde_json::from_slice::<Value>(&b)
                    .map(|_| ())
                    .map_err(|_| CallError::Malformed("not JSON"))
            });
        judge_test(&r)
    }
}

impl PaymentProvider for Coinbase {
    fn kind(&self) -> &'static str {
        KIND
    }
    fn order_timeout_minutes(&self) -> u32 {
        self.params.order_timeout_minutes
    }
    fn create<'a>(&'a self, req: CreateReq<'a>) -> BoxFut<'a, Result<Checkout, CallError>> {
        Box::pin(async move { Coinbase::create(self, &req).await })
    }
    fn query<'a>(&'a self, otn: &'a str) -> BoxFut<'a, Result<Query, CallError>> {
        Box::pin(Coinbase::query(self, otn))
    }
    fn close<'a>(&'a self, otn: &'a str) -> BoxFut<'a, Result<Close, CallError>> {
        Box::pin(Coinbase::close(self, otn))
    }
    fn verify_notify(&self, req: &NotifyRequest<'_>) -> NotifyCheck {
        self.check_notify(req)
    }
    fn notify_ack(&self) -> &'static str {
        "ok"
    }
    fn test_connection(&self) -> BoxFut<'_, TestOutcome> {
        Box::pin(Coinbase::test_connection(self))
    }
}

// ---------------------------------------------------------------------------
// Kind: configuration
// ---------------------------------------------------------------------------

/// The Coinbase provider kind.
///
/// config (plain JSON): api_base (tests: loopback http only), key_id,
/// currency, rate_cents, order_timeout_minutes, api_secret_fingerprint,
/// webhook_secret_fingerprint. secrets (sealed): api_secret, webhook_secret.
pub struct CoinbaseKind;

const KNOWN: &[&str] = &[
    "api_base",
    "key_id",
    "api_secret",
    "webhook_secret",
    "currency",
    "rate_cents",
    "order_timeout_minutes",
];

fn fingerprint(domain: &str, secret: &str) -> String {
    crypto::fingerprint(domain, secret)
}

const API_FP: &str = "akari/coinbase-api-secret-fingerprint/v1";
const HOOK_FP: &str = "akari/coinbase-webhook-secret-fingerprint/v1";

fn api_secret_of(secrets: &Value) -> Option<String> {
    text_field(secrets, "api_secret").filter(|s| Signer::parse(s).is_ok())
}

fn webhook_secret_of(secrets: &Value) -> Option<String> {
    text_field(secrets, "webhook_secret").filter(|s| token_ok(s, MAX_WEBHOOK_SECRET))
}

impl ProviderKind for CoinbaseKind {
    fn id(&self) -> &'static str {
        KIND
    }
    fn label(&self) -> &'static str {
        "Coinbase"
    }
    fn schema(&self) -> Value {
        json!([
            {"name": "key_id", "label": "API 密钥名称（CDP API key 的 ID / name）", "type": "text", "required": true},
            {"name": "api_secret", "label": "API 私钥（Ed25519 的 base64 密钥，或 ECDSA 的 PEM）", "type": "key", "secret": true, "required": true},
            {"name": "webhook_secret", "label": "Webhook 签名密钥（创建订阅时返回的 secret）", "type": "text", "secret": true, "required": true},
            {"name": "currency", "label": "收款币种代码（ISO 法币如 USD / CNY，或 USDC；币种为 CNY 时无需汇率）", "type": "text", "required": true, "default": "USD"},
            {"name": "rate_cents", "label": "汇率：1.00 收款币种 = 多少分人民币（如 USD 填 720；CNY 留空）", "type": "number"},
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
        let api_base = match text_field(input, "api_base") {
            None => None,
            Some(u) => Some(crypto::api_base(&u, &[OFFICIAL]).ok_or_else(|| {
                bad_request!(
                    "payments.coinbase_api_base_invalid",
                    "api_base must be the Coinbase Business API host"
                )
            })?),
        };
        let key_id = text_field(input, "key_id");
        if key_id.as_deref().is_some_and(|v| !token_ok(v, MAX_KEY_ID)) {
            return Err(bad_request!(
                "payments.coinbase_key_id_invalid",
                "key_id must be 1-200 visible ASCII characters"
            ));
        }
        let new_api = text_field(input, "api_secret");
        if new_api
            .as_deref()
            .is_some_and(|s| s.len() > MAX_SECRET || Signer::parse(s).is_err())
        {
            return Err(bad_request!(
                "payments.coinbase_secret_invalid",
                "api_secret must be an Ed25519 base64 secret or an ECDSA P-256 PEM key"
            ));
        }
        let new_hook = text_field(input, "webhook_secret");
        if new_hook
            .as_deref()
            .is_some_and(|s| !token_ok(s, MAX_WEBHOOK_SECRET))
        {
            return Err(bad_request!(
                "payments.coinbase_webhook_secret_invalid",
                "webhook_secret must be visible ASCII without spaces"
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
        let api = new_api
            .clone()
            .or_else(|| prev_secrets.and_then(api_secret_of));
        let hook = new_hook
            .clone()
            .or_else(|| prev_secrets.and_then(webhook_secret_of));
        if complete && (key_id.is_none() || api.is_none() || hook.is_none()) {
            return Err(conflict!(
                "payments.incomplete",
                "enabling needs the API key name, the API private key and the webhook secret"
            ));
        }
        let config = json!({
            "api_base": api_base,
            "key_id": key_id,
            "currency": currency,
            "rate_cents": rate,
            "order_timeout_minutes": timeout,
            "api_secret_fingerprint": api.as_deref().map(|s| fingerprint(API_FP, s)),
            "webhook_secret_fingerprint": hook.as_deref().map(|s| fingerprint(HOOK_FP, s)),
        });
        let mut secrets = prev_secrets.cloned().unwrap_or_else(|| json!({}));
        let mut changed = Vec::new();
        if let Some(s) = new_api {
            secrets["api_secret"] = Value::String(s);
            changed.push("api_secret");
        }
        if let Some(s) = new_hook {
            secrets["webhook_secret"] = Value::String(s);
            changed.push("webhook_secret");
        }
        Ok(Validated {
            config,
            secrets,
            changed_secrets: changed,
        })
    }

    fn build(&self, config: &Value, secrets: &Value) -> Result<Arc<dyn PaymentProvider>, String> {
        let base = match text_field(config, "api_base") {
            Some(u) => crypto::api_base(&u, &[OFFICIAL]).ok_or("bad api_base")?,
            None => OFFICIAL.to_string(),
        };
        let key_id = text_field(config, "key_id")
            .filter(|k| token_ok(k, MAX_KEY_ID))
            .ok_or("key_id missing")?;
        let signer = text_field(secrets, "api_secret")
            .ok_or("api_secret missing")
            .and_then(|s| Signer::parse(&s).map_err(|_| "api_secret unreadable"))?;
        let hook = webhook_secret_of(secrets).ok_or("webhook_secret missing or unreadable")?;
        let currency = text_field(config, "currency").ok_or("currency missing")?;
        let pricing = Pricing::new(&currency, config.get("rate_cents").and_then(Value::as_i64))
            .ok_or("currency or rate invalid")?;
        let params = Params {
            base,
            key_id,
            pricing,
            order_timeout_minutes: config
                .get("order_timeout_minutes")
                .and_then(Value::as_u64)
                .unwrap_or(60)
                .clamp(5, 120) as u32,
        };
        Ok(Arc::new(Coinbase::new(params, signer, hook)))
    }

    fn view(&self, config: &Value, secrets: Option<&Value>) -> Value {
        let mut v = json!({});
        for k in [
            "api_base",
            "key_id",
            "currency",
            "rate_cents",
            "order_timeout_minutes",
            "api_secret_fingerprint",
            "webhook_secret_fingerprint",
        ] {
            v[k] = config.get(k).cloned().unwrap_or(Value::Null);
        }
        for (name, ok) in [
            ("api_secret", secrets.and_then(api_secret_of).is_some()),
            (
                "webhook_secret",
                secrets.and_then(webhook_secret_of).is_some(),
            ),
        ] {
            v[format!("{name}_set")] = Value::Bool(secrets.is_some_and(|s| s.get(name).is_some()));
            v[format!("{name}_readable")] = Value::Bool(ok);
        }
        v
    }

    fn default_icon(&self, _config: &Value) -> Option<&'static str> {
        Some("crypto")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    pub const KEY_ID: &str = "organizations/o1/apiKeys/k1";
    pub const HOOK: &str = "whsec-test-0123456789";
    pub const NOW: i64 = 1_792_000_000;
    pub const NOTIFY_URL: &str =
        "https://panel.example/pay/9b0e5f2a-0000-4000-8000-000000000002/notify";
    pub const CHECKOUT: &str = "69163c762331ed43dc64a6ef";

    /// A throwaway Ed25519 secret in the CDP format: base64(seed ‖ public).
    pub fn ed25519_secret() -> (String, Vec<u8>) {
        let seed: [u8; 32] = rand::random();
        let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
        use ring::signature::KeyPair as _;
        let public = pair.public_key().as_ref().to_vec();
        let mut raw = seed.to_vec();
        raw.extend_from_slice(&public);
        (STANDARD.encode(raw), public)
    }

    pub fn client(base: &str) -> Coinbase {
        let (secret, _) = ed25519_secret();
        Coinbase::new(
            Params {
                base: base.into(),
                key_id: KEY_ID.into(),
                pricing: Pricing::new("USD", Some(720)).unwrap(),
                order_timeout_minutes: 60,
            },
            Signer::parse(&secret).unwrap(),
            HOOK.into(),
        )
    }

    /// A webhook body as Coinbase sends it (documented fields).
    pub fn payload(event: &str, status: &str, otn: &str, fiat: &str, cents: i64) -> String {
        json!({
            "id": CHECKOUT,
            "url": "https://payments.coinbase.com/payment-links/pl_01",
            "amount": "1.91",
            "currency": "USDC",
            "fiatAmount": fiat,
            "fiatCurrency": "USD",
            "network": "base",
            "eventType": event,
            "status": status,
            "metadata": {"akari_order": otn, "akari_cents": cents.to_string()},
            "transactionHash": "0xabc",
            "createdAt": "2026-10-27T10:00:00.000Z",
            "updatedAt": "2026-10-27T10:01:00.000Z",
        })
        .to_string()
    }

    /// Webhook headers signing `body` the documented way (extra header named
    /// in `h`).
    pub fn signed_headers(body: &str, t: i64, secret: &str) -> HeaderMap {
        let names = "content-type";
        let ct = "application/json";
        let payload = signed_payload(&t.to_string(), names, &[ct.to_string()], body);
        let mut h = HeaderMap::new();
        h.insert("content-type", HeaderValue::from_static(ct));
        h.insert(
            "x-webhook-signature",
            HeaderValue::from_str(&format!(
                "t={t},h={names},v1={}",
                webhook_signature(secret, &payload)
            ))
            .unwrap(),
        );
        h
    }

    fn check(c: &Coinbase, body: &str, h: &HeaderMap, now: i64) -> NotifyCheck {
        c.check_notify(&NotifyRequest {
            body: body.as_bytes(),
            headers: h,
            url: Some(NOTIFY_URL),
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
    fn webhook_signature_follows_the_documented_construction() {
        // Independent computation (python hmac) of the documented payload
        // "{t}.{h}.{values}.{body}" for a one-header list.
        let p = signed_payload(
            "1700000000",
            "content-type",
            &["application/json".into()],
            r#"{"a":1}"#,
        );
        assert_eq!(p, r#"1700000000.content-type.application/json.{"a":1}"#);
        assert_eq!(
            webhook_signature("secret", &p),
            "aa68a14679b72bc50bd281a33df34044d257d41f62f0e81633ec093069a1bf2a"
        );
        assert_eq!(
            parse_signature_header("t=1,h=a b,v1=ff"),
            Some(("1", "a b", "ff"))
        );
        assert_eq!(parse_signature_header("t=1,h=a,v1=ff,t=2"), None);
        assert_eq!(parse_signature_header("t=1,v1=ff"), None);
        assert_eq!(parse_signature_header("garbage"), None);
    }

    #[test]
    fn completed_webhook_pays() {
        let c = client(OFFICIAL);
        // 990 CNY cents at 7.20 → 1.375 → 1.38 USD.
        let body = payload(PAID_EVENT, "COMPLETED", "AK1", "1.38", 990);
        let h = signed_headers(&body, NOW, HOOK);
        match check(&c, &body, &h, NOW) {
            NotifyCheck::Verified(ev) => {
                assert_eq!(ev.out_trade_no, "AK1");
                assert_eq!(ev.trade_no.as_deref(), Some(CHECKOUT));
                assert!(ev.paid);
                assert_eq!(ev.total_cents, Some(990));
                assert_eq!(ev.status, "COMPLETED");
                assert!(!ev.params.to_string().contains(HOOK));
            }
            r => panic!("{r:?}"),
        }
        for (event, status) in [
            ("checkout.payment.failed", "FAILED"),
            ("checkout.payment.expired", "EXPIRED"),
            ("checkout.refund.success", "REFUNDED"),
            ("checkout.refund.failed", "COMPLETED"),
            (PAID_EVENT, "PROCESSING"),
            (PAID_EVENT, "ACTIVE"),
            (PAID_EVENT, "PARTIALLY_REFUNDED"),
            ("checkout.payment.other", "COMPLETED"),
        ] {
            let body = payload(event, status, "AK1", "1.38", 990);
            let h = signed_headers(&body, NOW, HOOK);
            match check(&c, &body, &h, NOW) {
                NotifyCheck::Verified(ev) => {
                    assert!(!ev.paid, "{event}/{status}");
                    assert_eq!(
                        ev.total_cents,
                        Some(990),
                        "{event}/{status} names its order"
                    );
                }
                r => panic!("{r:?}"),
            }
        }
    }

    #[test]
    fn forged_stale_or_unsigned_webhooks_do_not_verify() {
        let c = client(OFFICIAL);
        let body = payload(PAID_EVENT, "COMPLETED", "AK1", "1.38", 990);
        let good = signed_headers(&body, NOW, HOOK);
        let other = signed_headers(&body, NOW, "another-secret");
        assert_eq!(
            reason(check(&c, &body, &other, NOW)),
            (false, "bad_signature")
        );
        assert_eq!(
            reason(check(&c, &body.replace("1.38", "0.01"), &good, NOW)),
            (false, "bad_signature")
        );
        assert_eq!(
            reason(check(&c, &body, &HeaderMap::new(), NOW)),
            (false, "bad_signature")
        );
        // The named header's value is part of the signature.
        let mut t = good.clone();
        t.insert("content-type", HeaderValue::from_static("text/plain"));
        assert_eq!(reason(check(&c, &body, &t, NOW)), (false, "bad_signature"));
        for broken in ["", "t=1", "v1=zz", "t=x,h=a,v1=nothex", "t=1,h=a,v1=00"] {
            let mut t = good.clone();
            t.insert(
                "x-webhook-signature",
                HeaderValue::from_str(broken).unwrap(),
            );
            assert_eq!(
                reason(check(&c, &body, &t, NOW)),
                (false, "bad_signature"),
                "{broken:?}"
            );
        }
        // Genuine signature, wrong age: a replay.
        assert_eq!(
            reason(check(&c, &body, &good, NOW + 301)),
            (true, "stale_timestamp")
        );
        assert_eq!(
            reason(check(&c, &body, &good, NOW - 301)),
            (true, "stale_timestamp")
        );
        assert!(matches!(
            check(&c, &body, &good, NOW + 300),
            NotifyCheck::Verified(_)
        ));
        // Signed junk.
        for junk in ["nope", "[]", "5"] {
            let h = signed_headers(junk, NOW, HOOK);
            assert_eq!(
                reason(check(&c, junk, &h, NOW)),
                (true, "malformed"),
                "{junk}"
            );
        }
        // Someone else's checkout of the same account: not one of our orders.
        let foreign = json!({"id": CHECKOUT, "eventType": PAID_EVENT, "status": "COMPLETED",
                             "amount": "1.00", "currency": "USDC"})
        .to_string();
        let h = signed_headers(&foreign, NOW, HOOK);
        assert_eq!(
            reason(check(&c, &foreign, &h, NOW)),
            (true, "unknown_order")
        );
    }

    #[test]
    fn amounts_and_currency_must_match_exactly() {
        let c = client(OFFICIAL);
        let verdict = |fiat: &str, cents: i64, fiat_currency: &str| {
            let mut v: Value =
                serde_json::from_str(&payload(PAID_EVENT, "COMPLETED", "AK1", fiat, cents))
                    .unwrap();
            v["fiatCurrency"] = json!(fiat_currency);
            let body = v.to_string();
            let h = signed_headers(&body, NOW, HOOK);
            match check(&c, &body, &h, NOW) {
                NotifyCheck::Verified(ev) => ev.total_cents,
                r => panic!("{r:?}"),
            }
        };
        assert_eq!(verdict("1.38", 990, "USD"), Some(990));
        assert_eq!(verdict("1.38", 1000, "USD"), None, "cents echo differs");
        assert_eq!(verdict("1.37", 990, "USD"), None);
        assert_eq!(verdict("1.38", 990, "EUR"), None);
        assert_eq!(verdict("1.3", 990, "USD"), None);
        assert_eq!(verdict("1.380", 990, "USD"), Some(990));
        // A checkout without the fiat echo (created in USDC) is not accepted
        // by a USD method: the USDC amount is never compared with fiat.
        let mut v: Value =
            serde_json::from_str(&payload(PAID_EVENT, "COMPLETED", "AK1", "1.38", 990)).unwrap();
        v.as_object_mut().unwrap().remove("fiatAmount");
        let body = v.to_string();
        let h = signed_headers(&body, NOW, HOOK);
        match check(&c, &body, &h, NOW) {
            NotifyCheck::Verified(ev) => assert_eq!(ev.total_cents, None),
            r => panic!("{r:?}"),
        }
        // A USDC method compares the checkout's own amount and currency.
        let usdc = Coinbase::new(
            Params {
                pricing: Pricing::new("USDC", Some(700)).unwrap(),
                ..c.params.clone()
            },
            Signer::parse(&ed25519_secret().0).unwrap(),
            HOOK.into(),
        );
        let mut v: Value =
            serde_json::from_str(&payload(PAID_EVENT, "COMPLETED", "AK1", "x", 700)).unwrap();
        v["amount"] = json!("1.00");
        let body = v.to_string();
        let h = signed_headers(&body, NOW, HOOK);
        match check(&usdc, &body, &h, NOW) {
            NotifyCheck::Verified(ev) => assert_eq!(ev.total_cents, Some(700)),
            r => panic!("{r:?}"),
        }
    }

    #[test]
    fn checkout_reads() {
        let c = client(OFFICIAL);
        let v = json!({"id": CHECKOUT, "status": "COMPLETED", "amount": "1.91", "currency": "USDC",
                       "fiatAmount": "1.38", "fiatCurrency": "USD",
                       "metadata": {"akari_order": "AK1", "akari_cents": "990"}});
        assert_eq!(c.judge(&facts(&v)), (true, Some(990)));
        for status in [
            "ACTIVE",
            "PROCESSING",
            "EXPIRED",
            "DEACTIVATED",
            "FAILED",
            "REFUNDED",
        ] {
            let mut t = v.clone();
            t["status"] = json!(status);
            assert!(!c.judge(&facts(&t)).0, "{status}");
        }
        let list = json!({"checkouts": [
            {"id": "aaaaaaaaaaaaaaaaaaaaaaaa", "metadata": {"akari_order": "AK10"}},
            {"id": CHECKOUT, "metadata": {"akari_order": "AK1"}},
            {"id": "bbbbbbbbbbbbbbbbbbbbbbbb"},
        ]})
        .to_string();
        assert_eq!(
            pick_checkout(list.as_bytes(), "AK1").unwrap().as_deref(),
            Some(CHECKOUT)
        );
        assert_eq!(pick_checkout(list.as_bytes(), "AK2").unwrap(), None);
        let dup = json!({"checkouts": [
            {"id": CHECKOUT, "metadata": {"akari_order": "AK1"}},
            {"id": "bbbbbbbbbbbbbbbbbbbbbbbb", "metadata": {"akari_order": "AK1"}},
        ]})
        .to_string();
        assert!(matches!(
            pick_checkout(dup.as_bytes(), "AK1"),
            Err(CallError::Malformed("ambiguous checkout"))
        ));
        let bad =
            json!({"checkouts": [{"id": "../x", "metadata": {"akari_order": "AK1"}}]}).to_string();
        assert!(matches!(
            pick_checkout(bad.as_bytes(), "AK1"),
            Err(CallError::Malformed("bad checkout id"))
        ));
        assert!(pick_checkout(b"{}", "AK1").is_err());
        assert_eq!(
            parse_create(br#"{"id":"x","url":"https://payments.coinbase.com/payment-links/pl_1"}"#)
                .unwrap(),
            Checkout::Redirect("https://payments.coinbase.com/payment-links/pl_1".into())
        );
        for bad in [
            &b"{}"[..],
            b"nope",
            br#"{"url":"http://evil.example/x"}"#,
            br#"{"url":"javascript:1"}"#,
        ] {
            assert!(parse_create(bad).is_err());
        }
        assert_eq!(
            error_class(br#"{"errorType":"unauthorized","errorMessage":"secret text"}"#),
            "unauthorized"
        );
        assert_eq!(error_class(br#"{"errorType":"made up"}"#), "unknown");
        assert_eq!(error_class(b"<html>"), "unknown");
    }

    #[test]
    fn create_body_is_priced_in_the_chosen_currency() {
        let c = client(OFFICIAL);
        let req = CreateReq {
            out_trade_no: "AK1",
            amount_cents: 990,
            subject: "Akari - 月付",
            notify_url: NOTIFY_URL,
            return_url: "https://panel.example/orders/1",
            client_ip: None,
        };
        let v: Value = serde_json::from_str(&c.create_body(&req, NOW).unwrap()).unwrap();
        assert_eq!(v["amount"], "1.38");
        assert_eq!(v["currency"], "USD");
        assert_eq!(v["metadata"]["akari_order"], "AK1");
        assert_eq!(v["metadata"]["akari_cents"], "990");
        assert!(v["description"].as_str().unwrap().starts_with("AK1 "));
        let want = chrono::DateTime::from_timestamp(NOW + 3600, 0).unwrap();
        assert_eq!(
            v["expiresAt"],
            want.format("%Y-%m-%dT%H:%M:%SZ").to_string()
        );
        assert_eq!(v["successRedirectUrl"], "https://panel.example/orders/1");
        let http = CreateReq {
            return_url: "http://x/y",
            ..req.clone()
        };
        let v: Value = serde_json::from_str(&c.create_body(&http, NOW).unwrap()).unwrap();
        assert!(v.get("successRedirectUrl").is_none());
        assert!(
            c.create_body(
                &CreateReq {
                    amount_cents: 0,
                    ..req
                },
                NOW
            )
            .is_err()
        );
    }

    #[test]
    fn bearer_tokens_verify_under_their_public_key() {
        use ring::signature::{ECDSA_P256_SHA256_FIXED, ED25519, UnparsedPublicKey};
        let split = |t: &str| {
            let p: Vec<&str> = t.split('.').collect();
            assert_eq!(p.len(), 3);
            (
                format!("{}.{}", p[0], p[1]),
                URL_SAFE_NO_PAD.decode(p[2]).unwrap(),
                serde_json::from_slice::<Value>(&URL_SAFE_NO_PAD.decode(p[0]).unwrap()).unwrap(),
                serde_json::from_slice::<Value>(&URL_SAFE_NO_PAD.decode(p[1]).unwrap()).unwrap(),
            )
        };
        // Ed25519 (EdDSA, with the audience).
        let (secret, public) = ed25519_secret();
        let s = Signer::parse(&secret).unwrap();
        let nonce = hex::encode(rand::random::<[u8; 8]>());
        let tok = s.bearer(
            KEY_ID,
            "GET business.coinbase.com/api/v1/checkouts",
            NOW,
            &nonce,
        );
        let (signing, sig, head, claims) = split(&tok);
        UnparsedPublicKey::new(&ED25519, &public)
            .verify(signing.as_bytes(), &sig)
            .unwrap();
        assert_eq!(
            (
                head["alg"].as_str(),
                head["kid"].as_str(),
                head["nonce"].as_str()
            ),
            (Some("EdDSA"), Some(KEY_ID), Some(nonce.as_str()))
        );
        assert_eq!(claims["uri"], "GET business.coinbase.com/api/v1/checkouts");
        assert_eq!(
            (claims["iss"].as_str(), claims["sub"].as_str()),
            (Some("cdp"), Some(KEY_ID))
        );
        assert_eq!(
            (claims["nbf"].as_i64(), claims["exp"].as_i64()),
            (Some(NOW), Some(NOW + 120))
        );
        assert_eq!(claims["aud"][0], "cdp_service");
        // ECDSA P-256 as a SEC1 "EC PRIVATE KEY" PEM and as PKCS#8 (ES256).
        let group =
            openssl::ec::EcGroup::from_curve_name(openssl::nid::Nid::X9_62_PRIME256V1).unwrap();
        let ec = openssl::ec::EcKey::generate(&group).unwrap();
        let mut ctx = openssl::bn::BigNumContext::new().unwrap();
        let public = ec
            .public_key()
            .to_bytes(
                &group,
                openssl::ec::PointConversionForm::UNCOMPRESSED,
                &mut ctx,
            )
            .unwrap();
        let sec1 = String::from_utf8(ec.private_key_to_pem().unwrap()).unwrap();
        assert!(sec1.contains("BEGIN EC PRIVATE KEY"));
        let pkcs8 = String::from_utf8(
            openssl::pkey::PKey::from_ec_key(ec)
                .unwrap()
                .private_key_to_pem_pkcs8()
                .unwrap(),
        )
        .unwrap();
        for pem in [sec1.clone(), pkcs8, sec1.replace('\n', "\\n")] {
            let s = Signer::parse(&pem).unwrap();
            let nonce = hex::encode(rand::random::<[u8; 8]>());
            let tok = s.bearer(
                KEY_ID,
                "POST business.coinbase.com/api/v1/checkouts",
                NOW,
                &nonce,
            );
            let (signing, sig, head, claims) = split(&tok);
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &public)
                .verify(signing.as_bytes(), &sig)
                .unwrap();
            assert_eq!(head["alg"], "ES256");
            assert!(claims.get("aud").is_none());
        }
        // Unusable secrets.
        let p384 = openssl::ec::EcKey::generate(
            &openssl::ec::EcGroup::from_curve_name(openssl::nid::Nid::SECP384R1).unwrap(),
        )
        .unwrap();
        let p384 = String::from_utf8(p384.private_key_to_pem().unwrap()).unwrap();
        for bad in [
            "",
            "not a key",
            "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----",
            &p384,
            &STANDARD.encode([0u8; 63]),
            &STANDARD.encode([0u8; 64]),
        ] {
            assert!(Signer::parse(bad).is_err(), "{bad:?}");
        }
        assert!(format!("{s:?}").starts_with("Signer"));
    }

    #[test]
    fn test_connection_outcomes() {
        for (r, ok, result) in [
            (Ok(()), true, "keys_ok"),
            (Err(CallError::Status(401)), false, "credentials_rejected"),
            (Err(CallError::Status(403)), false, "forbidden"),
            (Err(CallError::Status(500)), false, "gateway_status"),
            (Err(CallError::Transport("x".into())), false, "unreachable"),
            (Err(CallError::Malformed("x")), false, "malformed"),
        ] {
            let o = judge_test(&r);
            assert_eq!((o.ok, o.result), (ok, result), "{}", o.message);
        }
    }

    #[test]
    fn kind_validation() {
        let k = CoinbaseKind;
        let (secret, _) = ed25519_secret();
        let good = json!({
            "key_id": KEY_ID, "api_secret": secret, "webhook_secret": HOOK,
            "currency": "USD", "rate_cents": 720, "order_timeout_minutes": 30,
        });
        let v = k.validate(&good, None, true).ok().unwrap();
        assert_eq!(v.changed_secrets, ["api_secret", "webhook_secret"]);
        assert!(!v.config.to_string().contains(&secret) && !v.config.to_string().contains(HOOK));
        let view = k.view(&v.config, Some(&v.secrets));
        assert!(!view.to_string().contains(&secret) && !view.to_string().contains(HOOK));
        for f in [
            "api_secret_set",
            "api_secret_readable",
            "webhook_secret_set",
            "webhook_secret_readable",
        ] {
            assert_eq!(view[f], true, "{f}");
        }
        assert_eq!(k.default_icon(&v.config), Some("crypto"));
        let p = k.build(&v.config, &v.secrets).unwrap();
        assert_eq!((p.kind(), p.order_timeout_minutes()), (KIND, 30));
        assert!(!p.refunds() && !p.notify_get());
        assert!(!format!("{p:?}").contains(HOOK));
        // Editing without secrets keeps them.
        let edit = json!({"key_id": KEY_ID, "currency": "USD", "rate_cents": 700});
        let v2 = k
            .validate(&edit, Some((&v.config, &v.secrets)), true)
            .ok()
            .unwrap();
        assert!(v2.changed_secrets.is_empty());
        assert_eq!(v2.secrets, v.secrets);
        // Incomplete saves disabled only; USD needs a rate; CNY does not.
        let partial = json!({"key_id": KEY_ID});
        assert!(k.validate(&partial, None, false).is_ok());
        assert_eq!(
            k.validate(&partial, None, true).err().unwrap().code(),
            "payments.incomplete"
        );
        let no_rate = json!({"key_id": KEY_ID, "api_secret": secret, "webhook_secret": HOOK});
        assert_eq!(
            k.validate(&no_rate, None, true).err().unwrap().code(),
            "payments.incomplete"
        );
        let cny = json!({"key_id": KEY_ID, "api_secret": secret, "webhook_secret": HOOK, "currency": "CNY"});
        assert!(k.validate(&cny, None, true).is_ok());
        assert!(k.build(&json!({}), &json!({})).is_err());
        let codes = [
            (json!([]), "payments.config_invalid"),
            (json!({"x": 1}), "payments.config_unknown_field"),
            (
                json!({"api_base": "https://evil.example"}),
                "payments.coinbase_api_base_invalid",
            ),
            (json!({"key_id": "a b"}), "payments.coinbase_key_id_invalid"),
            (
                json!({"api_secret": "nope"}),
                "payments.coinbase_secret_invalid",
            ),
            (
                json!({"webhook_secret": "a b"}),
                "payments.coinbase_webhook_secret_invalid",
            ),
            (json!({"currency": "usd"}), "payments.currency_invalid"),
            (json!({"rate_cents": 0}), "payments.rate_invalid"),
            (
                json!({"order_timeout_minutes": 121}),
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
        let local = json!({"api_base": "http://127.0.0.1:9"});
        assert_eq!(
            k.validate(&local, None, false).ok().unwrap().config["api_base"],
            "http://127.0.0.1:9"
        );
        let view = k.view(
            &v.config,
            Some(&json!({"api_secret": "bad", "webhook_secret": "bad secret"})),
        );
        assert_eq!(
            (&view["api_secret_set"], &view["api_secret_readable"]),
            (&Value::Bool(true), &Value::Bool(false))
        );
        assert_eq!(k.view(&v.config, None)["webhook_secret_set"], false);
        assert!(k.schema().as_array().is_some_and(|a| a.len() == 6));
        assert_eq!(k.label(), "Coinbase");
    }
}
