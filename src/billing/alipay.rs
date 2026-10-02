//! Alipay OpenAPI, public-key mode, RSA2 (SHA256withRSA, PKCS#1 v1.5):
//! request signing, response and async-notify verification, and the three
//! Face-to-Face calls the panel makes (precreate, query, close).
//!
//! Signing rules (Alipay "自行实现签名" / "自行实现验签"):
//! - Request: every parameter except `sign` with a non-empty value, sorted
//!   by key (byte order), joined as `k=v` with `&`, raw (not URL-encoded)
//!   values; `sign_type` IS included.
//! - Sync response: the raw JSON text of `<method with . -> _>_response`,
//!   byte for byte as received (serde_json `RawValue`; never re-serialized).
//! - Async notify: every parameter except `sign` and `sign_type`, URL-decoded,
//!   sorted, `k=v` joined with `&`. Alipay's SDKs disagree on empty values
//!   (Java/Python keep them, others drop them); both forms are under
//!   Alipay's signature, so we accept either (`verify_notify`).
//!
//! Secrets: the app private key never leaves `Keys` (no Debug/Display);
//! request bodies (which carry `notify_url`, i.e. the route prefix) and
//! signatures are never logged.

use std::collections::BTreeMap;
use std::time::Duration;

use base64::Engine as _;
use chrono::{DateTime, FixedOffset, Utc};
use ring::rand::SystemRandom;
use ring::signature::{self, RsaKeyPair};
use serde_json::value::RawValue;
use serde_json::Value;
use sha2::Digest as _;

/// The Alipay "success" result code.
const CODE_OK: &str = "10000";
/// Gateway call timeout (connect + TLS + request + response).
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// Attempts per gateway call (transport errors / non-200 only).
const CALL_ATTEMPTS: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_millis(300);

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/// Integer cents as Alipay's `total_amount` ("12.34", "0.01").
pub fn format_cents(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

/// Strict parse of an Alipay amount ("12", "12.3", "12.34") into cents.
/// Anything else (sign, exponent, spaces, >2 decimals, huge) is None.
pub fn parse_amount(s: &str) -> Option<i64> {
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, f),
        None => (s, ""),
    };
    if int.is_empty()
        || int.len() > 12
        || !int.bytes().all(|b| b.is_ascii_digit())
        || frac.len() > 2
        || (s.contains('.') && frac.is_empty())
        || !frac.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let whole: i64 = int.parse().ok()?;
    let mut f: i64 = if frac.is_empty() {
        0
    } else {
        frac.parse().ok()?
    };
    if frac.len() == 1 {
        f *= 10;
    }
    whole.checked_mul(100)?.checked_add(f)
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// Key text as Alipay's key tool writes it (bare base64) or PEM.
fn key_der(text: &str) -> Result<Vec<u8>, String> {
    let b64: String = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .concat();
    let b64: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
    if b64.is_empty() {
        return Err("empty key".into());
    }
    base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|_| "not base64/PEM".to_string())
}

fn strip_zeros(b: &[u8]) -> Vec<u8> {
    let i = b.iter().position(|&x| x != 0).unwrap_or(b.len());
    b[i..].to_vec()
}

/// Why a key text was refused (API: coded errors in billing::settings).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyError {
    /// Not PEM / base64 at all.
    NotPem,
    /// Base64/PEM, but not an RSA key of the expected kind.
    NotRsa,
    /// RSA, but under 2048 bits (RSA2 needs ≥ 2048).
    TooShort,
    /// A private key pasted where Alipay's public key belongs.
    PrivateInPublic,
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            KeyError::NotPem => "not base64/PEM",
            KeyError::NotRsa => "not a usable RSA key",
            KeyError::TooShort => "RSA2 needs at least 2048 bits",
            KeyError::PrivateInPublic => "a private key, not a public key",
        })
    }
}

/// A parsed app private key: its DER (PKCS#8 or PKCS#1, as given) and the
/// signer.
pub struct AppKey {
    der: Vec<u8>,
    signer: RsaKeyPair,
}

impl std::fmt::Debug for AppKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AppKey(<redacted>)")
    }
}

impl AppKey {
    /// From the private key text (PKCS#8 or PKCS#1, PEM or bare base64).
    pub fn parse(text: &str) -> Result<Self, KeyError> {
        let der = key_der(text).map_err(|_| KeyError::NotPem)?;
        Self::from_der(der)
    }

    /// From a stored DER (PKCS#8 or PKCS#1).
    pub fn from_der(der: Vec<u8>) -> Result<Self, KeyError> {
        let signer = RsaKeyPair::from_pkcs8(&der)
            .or_else(|_| RsaKeyPair::from_der(&der))
            .map_err(|_| {
                // ring refuses < 2048-bit keys outright: say why.
                if private_modulus_len(&der).is_some_and(|n| n < 256) {
                    KeyError::TooShort
                } else {
                    KeyError::NotRsa
                }
            })?;
        if signer.public().modulus_len() < 256 {
            return Err(KeyError::TooShort);
        }
        Ok(Self { der, signer })
    }

    /// The DER to store (sealed).
    pub fn der(&self) -> &[u8] {
        &self.der
    }

    /// The app public key (PKCS#1 DER).
    fn public_pkcs1(&self) -> &[u8] {
        self.signer.public().as_ref()
    }

    /// SHA-256 of the app public key (PKCS#1 DER), lower-case hex.
    pub fn fingerprint(&self) -> String {
        hex::encode(sha2::Sha256::digest(self.public_pkcs1()))
    }

    /// The app public key as Alipay's console wants it (SubjectPublicKeyInfo,
    /// bare base64, one line): what the admin uploads as 应用公钥.
    pub fn public_spki_b64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(spki_of_pkcs1(self.public_pkcs1()))
    }

    /// (modulus, exponent) of the app public key.
    fn public_components(&self) -> Option<(Vec<u8>, Vec<u8>)> {
        rsa_public_components(self.public_pkcs1())
    }
}

/// One DER TLV: (tag, body, rest).
fn der_read(b: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, b) = b.split_first()?;
    let (&l0, mut b) = b.split_first()?;
    let len = if l0 < 0x80 {
        usize::from(l0)
    } else {
        let n = usize::from(l0 & 0x7f);
        if n == 0 || n > 4 || b.len() < n {
            return None;
        }
        let mut len = 0usize;
        for &x in &b[..n] {
            len = (len << 8) | usize::from(x);
        }
        b = &b[n..];
        len
    };
    (b.len() >= len).then(|| (tag, &b[..len], &b[len..]))
}

/// Modulus length (bytes) of a PKCS#1 or PKCS#8 RSA private key DER, for
/// the "too short" message only (ring does the real parsing).
fn private_modulus_len(der: &[u8]) -> Option<usize> {
    let (0x30, body, _) = der_read(der)? else {
        return None;
    };
    // version 0 (two-prime) in both forms; a PKCS#1 PUBLIC key starts
    // with the modulus instead, never a lone zero.
    let (0x02, [0], rest) = der_read(body)? else {
        return None;
    };
    let (tag, next, rest2) = der_read(rest)?;
    let modulus = match tag {
        // PKCS#1: the modulus follows the version.
        0x02 => next,
        // PKCS#8: AlgorithmIdentifier, then OCTET STRING { RSAPrivateKey }.
        0x30 => {
            let (0x04, inner, _) = der_read(rest2)? else {
                return None;
            };
            return private_modulus_len(inner);
        }
        _ => return None,
    };
    Some(strip_zeros(modulus).len())
}

/// DER length octets.
fn der_len(n: usize, out: &mut Vec<u8>) {
    if n < 0x80 {
        out.push(n as u8);
    } else {
        let bytes = n.to_be_bytes();
        let i = bytes
            .iter()
            .position(|&b| b != 0)
            .unwrap_or(bytes.len() - 1);
        out.push(0x80 | (bytes.len() - i) as u8);
        out.extend_from_slice(&bytes[i..]);
    }
}

fn der_tlv(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    der_len(body.len(), &mut out);
    out.extend_from_slice(body);
    out
}

/// SubjectPublicKeyInfo { rsaEncryption, NULL } around a PKCS#1 key.
fn spki_of_pkcs1(pkcs1: &[u8]) -> Vec<u8> {
    // OID 1.2.840.113549.1.1.1 + NULL
    const ALG: &[u8] = &[
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
    ];
    let mut bits = vec![0u8];
    bits.extend_from_slice(pkcs1);
    let mut body = ALG.to_vec();
    body.extend(der_tlv(0x03, &bits));
    der_tlv(0x30, &body)
}

/// A parsed Alipay public key (modulus, exponent).
#[derive(Clone, PartialEq, Eq)]
pub struct PublicKey {
    n: Vec<u8>,
    e: Vec<u8>,
}

impl std::fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PublicKey({})", self.fingerprint())
    }
}

impl PublicKey {
    /// From Alipay's public key text (SubjectPublicKeyInfo or PKCS#1, PEM
    /// or bare base64).
    pub fn parse(text: &str) -> Result<Self, KeyError> {
        if text.contains("PRIVATE KEY") {
            return Err(KeyError::PrivateInPublic);
        }
        let der = key_der(text).map_err(|_| KeyError::NotPem)?;
        // A bare-base64 private key (its leading SEQUENCE of INTEGERs would
        // otherwise half-parse as a public key).
        if private_modulus_len(&der).is_some() {
            return Err(KeyError::PrivateInPublic);
        }
        let (n, e) = rsa_public_components(&der).ok_or(KeyError::NotRsa)?;
        if n.len() < 256 {
            return Err(KeyError::TooShort);
        }
        Ok(Self { n, e })
    }

    /// SHA-256 over modulus ‖ exponent (hex): identifies the key in views.
    pub fn fingerprint(&self) -> String {
        let mut h = sha2::Sha256::new();
        h.update(&self.n);
        h.update(&self.e);
        hex::encode(h.finalize())
    }

    fn verify(&self, content: &[u8], sig: &[u8]) -> bool {
        signature::RsaPublicKeyComponents {
            n: &self.n,
            e: &self.e,
        }
        .verify(&signature::RSA_PKCS1_2048_8192_SHA256, content, sig)
        .is_ok()
    }
}

/// True when `public` is the app's own public key (the common mistake of
/// pasting 应用公钥 where 支付宝公钥 belongs: every Alipay signature would
/// then fail).
pub fn is_app_public_key(app: &AppKey, public: &PublicKey) -> bool {
    app.public_components()
        .is_some_and(|(n, e)| n == public.n && e == public.e)
}

/// The panel's app key pair and Alipay's public key (plus, during a
/// rotation, Alipay's previous public key until a deadline).
pub struct Keys {
    signer: RsaKeyPair,
    alipay: PublicKey,
    /// Previous Alipay public key, accepted until the instant (notifies
    /// signed before the rotation are retried by Alipay for ~25 h).
    prev: Option<(PublicKey, DateTime<Utc>)>,
    rng: SystemRandom,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Keys(<redacted>)")
    }
}

impl Keys {
    /// From key texts: the app private key (PKCS#8 or PKCS#1, PEM or bare
    /// base64) and Alipay's public key (SubjectPublicKeyInfo or PKCS#1).
    pub fn from_texts(app_private: &str, alipay_public: &str) -> Result<Self, String> {
        let app = AppKey::parse(app_private).map_err(|e| format!("app private key: {e}"))?;
        let public =
            PublicKey::parse(alipay_public).map_err(|e| format!("alipay public key: {e}"))?;
        Ok(Self::new(app, public, None))
    }

    pub fn new(app: AppKey, alipay: PublicKey, prev: Option<(PublicKey, DateTime<Utc>)>) -> Self {
        Self {
            signer: app.signer,
            alipay,
            prev,
            rng: SystemRandom::new(),
        }
    }

    /// Base64 SHA256withRSA signature of `content` under the app key.
    pub fn sign(&self, content: &str) -> Result<String, String> {
        let mut sig = vec![0u8; self.signer.public().modulus_len()];
        self.signer
            .sign(
                &signature::RSA_PKCS1_SHA256,
                &self.rng,
                content.as_bytes(),
                &mut sig,
            )
            .map_err(|_| "signing failed".to_string())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(sig))
    }

    /// Verify an Alipay signature (base64) over `content`: the current
    /// Alipay public key, or the previous one while its grace lasts.
    pub fn verify(&self, content: &[u8], sig_b64: &str) -> bool {
        self.verify_at(content, sig_b64, Utc::now())
    }

    pub fn verify_at(&self, content: &[u8], sig_b64: &str, now: DateTime<Utc>) -> bool {
        let Ok(sig) = base64::engine::general_purpose::STANDARD.decode(sig_b64.trim()) else {
            return false;
        };
        if self.alipay.verify(content, &sig) {
            return true;
        }
        self.prev
            .as_ref()
            .is_some_and(|(k, until)| now < *until && k.verify(content, &sig))
    }
}

fn rsa_public_components(der: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    use x509_parser::prelude::FromDer;
    use x509_parser::public_key::{PublicKey, RSAPublicKey};
    use x509_parser::x509::SubjectPublicKeyInfo;
    if let Ok((rest, spki)) = SubjectPublicKeyInfo::from_der(der) {
        if !rest.is_empty() {
            return None;
        }
        return match spki.parsed() {
            Ok(PublicKey::RSA(k)) => Some((strip_zeros(k.modulus), strip_zeros(k.exponent))),
            _ => None,
        };
    }
    let (rest, k) = RSAPublicKey::from_der(der).ok()?;
    rest.is_empty()
        .then(|| (strip_zeros(k.modulus), strip_zeros(k.exponent)))
}

// ---------------------------------------------------------------------------
// Canonical strings
// ---------------------------------------------------------------------------

/// Request signing content: all params but `sign`, non-empty, sorted.
pub fn request_sign_content(params: &BTreeMap<String, String>) -> String {
    params
        .iter()
        .filter(|(k, v)| k.as_str() != "sign" && !v.is_empty())
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// Notify verification content: all params but `sign`/`sign_type`, sorted;
/// empty values kept or dropped.
pub fn notify_sign_content(params: &BTreeMap<String, String>, keep_empty: bool) -> String {
    params
        .iter()
        .filter(|(k, v)| {
            k.as_str() != "sign" && k.as_str() != "sign_type" && (keep_empty || !v.is_empty())
        })
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// Verify an async notify's signature (decoded params, duplicates already
/// refused by the caller). Only `sign_type=RSA2` is accepted.
pub fn verify_notify(keys: &Keys, params: &BTreeMap<String, String>) -> bool {
    let (Some(sig), Some("RSA2")) = (
        params.get("sign"),
        params.get("sign_type").map(String::as_str),
    ) else {
        return false;
    };
    if keys.verify(notify_sign_content(params, true).as_bytes(), sig) {
        return true;
    }
    params.values().any(String::is_empty)
        && keys.verify(notify_sign_content(params, false).as_bytes(), sig)
}

// ---------------------------------------------------------------------------
// Gateway calls
// ---------------------------------------------------------------------------

pub use super::provider::{CallError, Close, Query, TestOutcome};

/// Gateway of the Alipay production environment.
pub const GATEWAY_PRODUCTION: &str = "https://openapi.alipay.com/gateway.do";
/// Gateway of the Alipay sandbox.
pub const GATEWAY_SANDBOX: &str = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";

/// The non-secret parameters of a gateway client (系统设置 → 支付).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Params {
    pub app_id: String,
    pub seller_id: Option<String>,
    pub gateway_url: String,
    pub order_timeout_minutes: u32,
}

pub struct Alipay {
    pub app_id: String,
    pub seller_id: Option<String>,
    gateway: String,
    pub order_timeout_minutes: u32,
    keys: Keys,
}

impl std::fmt::Debug for Alipay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Alipay")
            .field("app_id", &self.app_id)
            .finish_non_exhaustive()
    }
}

impl Alipay {
    pub fn new(p: &Params, keys: Keys) -> Self {
        Self {
            app_id: p.app_id.clone(),
            seller_id: p.seller_id.clone().filter(|s| !s.is_empty()),
            gateway: p.gateway_url.clone(),
            order_timeout_minutes: p.order_timeout_minutes,
            keys,
        }
    }

    /// 测试连接: alipay.trade.query of a random out_trade_no that cannot
    /// exist. Harmless (no trade is created). Alipay answers
    /// ACQ.TRADE_NOT_EXIST only after checking the app_id and OUR request
    /// signature (the app private key matches the 应用公钥 registered at
    /// Alipay), and signs that answer with ITS key — which verifies only
    /// with the configured 支付宝公钥. So one call proves all three.
    pub async fn test_connection(&self) -> TestOutcome {
        let otn = format!("AKTEST{}", hex::encode(rand::random::<[u8; 10]>()));
        let biz = serde_json::json!({ "out_trade_no": otn });
        let r = self.call("alipay.trade.query", biz, None).await;
        judge_test(r)
    }

    pub fn keys(&self) -> &Keys {
        &self.keys
    }

    /// The signed form body of one call.
    pub fn request_body(
        &self,
        method: &str,
        biz: &Value,
        notify_url: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<String, String> {
        let beijing = FixedOffset::east_opt(8 * 3600).ok_or("offset")?;
        let mut p = BTreeMap::new();
        p.insert("app_id".to_string(), self.app_id.clone());
        p.insert("method".to_string(), method.to_string());
        p.insert("format".to_string(), "JSON".to_string());
        p.insert("charset".to_string(), "utf-8".to_string());
        p.insert("sign_type".to_string(), "RSA2".to_string());
        p.insert(
            "timestamp".to_string(),
            now.with_timezone(&beijing)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
        );
        p.insert("version".to_string(), "1.0".to_string());
        if let Some(n) = notify_url {
            p.insert("notify_url".to_string(), n.to_string());
        }
        p.insert("biz_content".to_string(), biz.to_string());
        let sign = self.keys.sign(&request_sign_content(&p))?;
        p.insert("sign".to_string(), sign);
        let mut ser = form_urlencoded::Serializer::new(String::new());
        for (k, v) in &p {
            ser.append_pair(k, v);
        }
        Ok(ser.finish())
    }

    /// One signed call; returns the verified `<method>_response` object
    /// with code 10000. A success without a valid signature is an error.
    async fn call(
        &self,
        method: &str,
        biz: Value,
        notify_url: Option<&str>,
    ) -> Result<Value, CallError> {
        // All three calls are idempotent per out_trade_no (a repeated
        // precreate returns the same QR), so a transport failure or a
        // non-200 answer is retried once: the sandbox gateway answers a
        // sizeable share of requests with HTTP 404 HTML.
        let mut attempt = 0;
        loop {
            attempt += 1;
            match self.call_once(method, &biz, notify_url).await {
                Err(CallError::Transport(_) | CallError::Status(_)) if attempt < CALL_ATTEMPTS => {
                    tokio::time::sleep(RETRY_DELAY).await;
                }
                r => return r,
            }
        }
    }

    async fn call_once(
        &self,
        method: &str,
        biz: &Value,
        notify_url: Option<&str>,
    ) -> Result<Value, CallError> {
        let body = self
            .request_body(method, biz, notify_url, Utc::now())
            .map_err(|_| CallError::Malformed("could not sign the request"))?;
        let (status, bytes) = super::http::post_form(&self.gateway, body, CALL_TIMEOUT)
            .await
            .map_err(CallError::Transport)?;
        if status != 200 {
            return Err(CallError::Status(status));
        }
        parse_response(&self.keys, method, &bytes)
    }

    /// alipay.trade.precreate → the QR payload. `notify_url`: see
    /// `billing::notify_url`.
    pub async fn precreate(
        &self,
        notify_url: &str,
        out_trade_no: &str,
        amount_cents: i64,
        subject: &str,
    ) -> Result<String, CallError> {
        let biz = serde_json::json!({
            "out_trade_no": out_trade_no,
            "total_amount": format_cents(amount_cents),
            "subject": subject,
            "timeout_express": format!("{}m", self.order_timeout_minutes),
        });
        let r = self
            .call("alipay.trade.precreate", biz, Some(notify_url))
            .await?;
        if r.get("out_trade_no").and_then(Value::as_str) != Some(out_trade_no) {
            return Err(CallError::Malformed("precreate answered another order"));
        }
        r.get("qr_code")
            .and_then(Value::as_str)
            .filter(|q| !q.is_empty() && q.len() <= 512)
            .map(str::to_string)
            .ok_or(CallError::Malformed("precreate without qr_code"))
    }

    /// alipay.trade.query by out_trade_no.
    pub async fn query(&self, out_trade_no: &str) -> Result<Query, CallError> {
        let biz = serde_json::json!({ "out_trade_no": out_trade_no });
        match self.call("alipay.trade.query", biz, None).await {
            Ok(r) => {
                if r.get("out_trade_no").and_then(Value::as_str) != Some(out_trade_no) {
                    return Err(CallError::Malformed("query answered another order"));
                }
                let status = r
                    .get("trade_status")
                    .and_then(Value::as_str)
                    .ok_or(CallError::Malformed("query without trade_status"))?;
                Ok(Query::Trade {
                    paid: matches!(status, "TRADE_SUCCESS" | "TRADE_FINISHED"),
                    status: status.to_string(),
                    trade_no: r
                        .get("trade_no")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    total_cents: r
                        .get("total_amount")
                        .and_then(Value::as_str)
                        .and_then(parse_amount),
                })
            }
            Err(CallError::Business { sub_code, .. }) if sub_code == "ACQ.TRADE_NOT_EXIST" => {
                Ok(Query::NotExist)
            }
            Err(e) => Err(e),
        }
    }

    /// alipay.trade.close by out_trade_no (best effort by the caller).
    pub async fn close(&self, out_trade_no: &str) -> Result<Close, CallError> {
        let biz = serde_json::json!({ "out_trade_no": out_trade_no });
        match self.call("alipay.trade.close", biz, None).await {
            Ok(_) => Ok(Close::Closed),
            Err(CallError::Business { sub_code, .. }) if sub_code == "ACQ.TRADE_NOT_EXIST" => {
                Ok(Close::NotExist)
            }
            Err(e) => Err(e),
        }
    }
}

/// Parse and verify a gateway response body for `method`.
pub fn parse_response(keys: &Keys, method: &str, body: &[u8]) -> Result<Value, CallError> {
    let fields: BTreeMap<String, &RawValue> =
        serde_json::from_slice(body).map_err(|_| CallError::Malformed("not JSON"))?;
    let key = format!("{}_response", method.replace('.', "_"));
    // An unknown method/app answers `error_response` (never signed).
    let raw = fields
        .get(&key)
        .or_else(|| fields.get("error_response"))
        .ok_or(CallError::Malformed("no response object"))?;
    let obj: Value =
        serde_json::from_str(raw.get()).map_err(|_| CallError::Malformed("bad response object"))?;
    let sig: Option<String> = fields
        .get("sign")
        .and_then(|s| serde_json::from_str::<String>(s.get()).ok());
    let verified = sig
        .as_deref()
        .is_some_and(|s| keys.verify(raw.get().as_bytes(), s));
    if sig.is_some() && !verified {
        return Err(CallError::BadSignature);
    }
    let code = obj.get("code").and_then(Value::as_str).unwrap_or_default();
    if code != CODE_OK {
        let s = |k: &str| {
            obj.get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect::<String>()
        };
        return Err(CallError::Business {
            code: s("code"),
            sub_code: s("sub_code"),
            sub_msg: s("sub_msg"),
            verified,
        });
    }
    if !verified {
        return Err(CallError::BadSignature);
    }
    Ok(obj)
}

/// Interpret the 测试连接 query (pure; unit-tested).
pub fn judge_test(r: Result<Value, CallError>) -> TestOutcome {
    let out = |ok, result, message: &str, code: Option<String>, sub: Option<String>| TestOutcome {
        ok,
        result,
        message: message.to_string(),
        code,
        sub_code: sub,
    };
    match r {
        Ok(_) => out(
            true,
            "keys_ok",
            "连接正常：支付宝接受了应用签名，响应用支付宝公钥验签通过",
            None,
            None,
        ),
        Err(CallError::Business {
            code,
            sub_code,
            sub_msg,
            verified,
        }) => {
            let c = Some(code.clone());
            let sc = Some(sub_code.clone());
            if sub_code == "ACQ.TRADE_NOT_EXIST" && verified {
                out(
                    true,
                    "keys_ok",
                    "连接正常：支付宝验证了应用私钥签名（APPID 与应用公钥匹配），其响应用已配置的支付宝公钥验签通过",
                    c,
                    sc,
                )
            } else if sub_code == "ACQ.TRADE_NOT_EXIST" {
                out(
                    false,
                    "unsigned",
                    "应用私钥有效，但支付宝的响应未签名，无法确认支付宝公钥是否正确",
                    c,
                    sc,
                )
            } else if sub_code.contains("invalid-signature") || sub_code.contains("signature") {
                out(
                    false,
                    "app_key_rejected",
                    "支付宝拒绝了请求签名：应用私钥与支付宝开放平台上登记的应用公钥不一致（请上传本页显示的应用公钥）",
                    c,
                    sc,
                )
            } else if sub_code.contains("app-id") || sub_code.contains("app_id") {
                out(
                    false,
                    "app_id_invalid",
                    "APPID 无效：请检查 APPID，以及沙箱/正式环境是否选对",
                    c,
                    sc,
                )
            } else {
                let m = format!("支付宝返回错误 {code} {sub_code}：{sub_msg}");
                out(false, "other", &m, c, sc)
            }
        }
        Err(CallError::BadSignature) => out(
            false,
            "alipay_key_wrong",
            "支付宝响应验签失败：支付宝公钥不正确（注意填写的是“支付宝公钥”，不是应用公钥）",
            None,
            None,
        ),
        Err(CallError::Transport(_)) => out(
            false,
            "unreachable",
            "无法连接支付宝网关（网络或 DNS 问题）",
            None,
            None,
        ),
        Err(CallError::Status(st)) => out(
            false,
            "gateway_status",
            &format!("支付宝网关返回 HTTP {st}，请稍后重试"),
            None,
            None,
        ),
        Err(CallError::Malformed(_)) => out(
            false,
            "malformed",
            "支付宝网关的响应无法解析（网关地址是否正确？）",
            None,
            None,
        ),
        Err(CallError::Unsupported) => out(false, "other", "不支持的操作", None, None),
    }
}

// ---------------------------------------------------------------------------
// R40: Alipay F2F as a payment provider (kind `alipay_f2f`)
// ---------------------------------------------------------------------------

/// Kind id of Alipay Face-to-Face.
pub const KIND: &str = "alipay_f2f";
/// How long a replaced Alipay public key still verifies (notifies are
/// retried by Alipay for ~25 h).
pub const PREV_KEY_GRACE_HOURS: i64 = 48;
/// Largest key text accepted (a 4096-bit PEM private key is ~3.3 KiB).
pub const MAX_KEY_TEXT: usize = 16 * 1024;

impl Alipay {
    /// Verify an async notify body: form decode (no duplicates), RSA2
    /// signature (current Alipay key, or the previous one in its grace),
    /// then this method's app_id / seller_id.
    pub fn check_notify(&self, body: &[u8]) -> super::provider::NotifyCheck {
        use super::provider::{NotifyCheck, NotifyEvent};
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
        if !verify_notify(&self.keys, &p) {
            return reject(false, "bad_signature");
        }
        if p.get("app_id") != Some(&self.app_id) {
            return reject(true, "app_id_mismatch");
        }
        if self
            .seller_id
            .as_ref()
            .is_some_and(|s| p.get("seller_id") != Some(s))
        {
            return reject(true, "seller_id_mismatch");
        }
        let Some(out_trade_no) = otn.clone() else {
            return reject(true, "unknown_order");
        };
        let st = status.clone().unwrap_or_default();
        NotifyCheck::Verified(NotifyEvent {
            out_trade_no,
            trade_no: p.get("trade_no").cloned(),
            paid: matches!(st.as_str(), "TRADE_SUCCESS" | "TRADE_FINISHED"),
            status: st,
            total_cents: p.get("total_amount").and_then(|a| parse_amount(a)),
            params,
        })
    }
}

impl super::provider::PaymentProvider for Alipay {
    fn kind(&self) -> &'static str {
        KIND
    }
    fn order_timeout_minutes(&self) -> u32 {
        self.order_timeout_minutes
    }
    fn create<'a>(
        &'a self,
        req: super::provider::CreateReq<'a>,
    ) -> super::provider::BoxFut<'a, Result<super::provider::Checkout, CallError>> {
        Box::pin(async move {
            Alipay::precreate(
                self,
                req.notify_url,
                req.out_trade_no,
                req.amount_cents,
                req.subject,
            )
            .await
            .map(super::provider::Checkout::Qr)
        })
    }
    fn query<'a>(&'a self, otn: &'a str) -> super::provider::BoxFut<'a, Result<Query, CallError>> {
        Box::pin(Alipay::query(self, otn))
    }
    fn close<'a>(&'a self, otn: &'a str) -> super::provider::BoxFut<'a, Result<Close, CallError>> {
        Box::pin(Alipay::close(self, otn))
    }
    fn verify_notify(&self, body: &[u8]) -> super::provider::NotifyCheck {
        self.check_notify(body)
    }
    fn notify_ack(&self) -> &'static str {
        "success"
    }
    fn test_connection(&self) -> super::provider::BoxFut<'_, TestOutcome> {
        Box::pin(Alipay::test_connection(self))
    }
}

/// The Alipay F2F provider kind: configuration schema, validation (keys
/// parsed on save, coded errors), client construction.
///
/// config (plain JSON): environment (sandbox|production|custom),
/// gateway_url (custom only), app_id, seller_id, order_timeout_minutes,
/// alipay_public_key (PEM), alipay_public_key_prev +
/// alipay_public_key_prev_until (rotation grace), app_key_fingerprint.
/// secrets (sealed): app_private_key (base64 of the DER as given).
pub struct AlipayKind;

/// Gateway of an environment.
pub fn gateway_of(environment: &str, custom: Option<&str>) -> Option<String> {
    match environment {
        "production" => Some(GATEWAY_PRODUCTION.into()),
        "sandbox" => Some(GATEWAY_SANDBOX.into()),
        "custom" => custom.map(str::to_string),
        _ => None,
    }
}

/// A custom gateway: https, or http to a loopback host (mock gateways).
pub fn gateway_ok(url: &str) -> bool {
    if url.len() > 512 {
        return false;
    }
    let Ok(uri) = url.parse::<axum::http::Uri>() else {
        return false;
    };
    let (Some(scheme), Some(auth)) = (uri.scheme_str(), uri.authority()) else {
        return false;
    };
    if auth.as_str().contains('@') || url.contains('#') {
        return false;
    }
    match scheme {
        "https" => true,
        "http" => super::http::is_loopback_host(auth.host()),
        _ => false,
    }
}

fn digits(v: &str) -> bool {
    !v.is_empty() && v.len() <= 32 && v.bytes().all(|b| b.is_ascii_digit())
}

fn private_key_error(e: KeyError) -> crate::auth::ApiError {
    match e {
        KeyError::TooShort => crate::auth::bad_request!(
            "payments.private_key_too_short",
            "app private key: RSA2 needs at least 2048 bits"
        ),
        _ => crate::auth::bad_request!(
            "payments.private_key_invalid",
            "app private key: not an RSA private key in PEM or base64"
        ),
    }
}

fn public_key_error(e: KeyError) -> crate::auth::ApiError {
    match e {
        KeyError::TooShort => crate::auth::bad_request!(
            "payments.public_key_too_short",
            "alipay public key: RSA2 needs at least 2048 bits"
        ),
        KeyError::PrivateInPublic => crate::auth::bad_request!(
            "payments.public_key_is_private",
            "alipay public key: this is a private key"
        ),
        _ => crate::auth::bad_request!(
            "payments.public_key_invalid",
            "alipay public key: not an RSA public key in PEM or base64"
        ),
    }
}

/// Normalized PEM of a public key text (bare base64 gets the headers).
fn public_pem(text: &str) -> String {
    let t = text.trim();
    if t.starts_with("-----") {
        t.lines().map(str::trim).collect::<Vec<_>>().join("\n") + "\n"
    } else {
        let b64: String = t.chars().filter(|c| !c.is_whitespace()).collect();
        let body = b64
            .as_bytes()
            .chunks(64)
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect::<Vec<_>>()
            .join("\n");
        format!("-----BEGIN PUBLIC KEY-----\n{body}\n-----END PUBLIC KEY-----\n")
    }
}

fn text_field(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn app_key_of(secrets: &Value) -> Option<AppKey> {
    let b64 = secrets.get("app_private_key")?.as_str()?;
    let der = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    AppKey::from_der(der).ok()
}

impl super::provider::ProviderKind for AlipayKind {
    fn id(&self) -> &'static str {
        KIND
    }
    fn label(&self) -> &'static str {
        "支付宝当面付"
    }
    fn schema(&self) -> Value {
        serde_json::json!([
            {"name": "environment", "label": "环境", "type": "select", "required": true,
             "options": [{"value": "production", "label": "正式"}, {"value": "sandbox", "label": "沙箱"},
                         {"value": "custom", "label": "自定义网关"}]},
            {"name": "gateway_url", "label": "网关地址（仅自定义）", "type": "text"},
            {"name": "app_id", "label": "APPID", "type": "text", "required": true},
            {"name": "seller_id", "label": "商户 PID（可选，2088…）", "type": "text"},
            {"name": "app_private_key", "label": "应用私钥", "type": "key", "secret": true, "required": true},
            {"name": "alipay_public_key", "label": "支付宝公钥", "type": "key", "required": true},
            {"name": "order_timeout_minutes", "label": "订单有效期（分钟，5–120）", "type": "number",
             "required": true, "default": 15}
        ])
    }

    fn validate(
        &self,
        input: &Value,
        prev: Option<(&Value, &Value)>,
        complete: bool,
    ) -> Result<super::provider::Validated, crate::auth::ApiError> {
        use crate::auth::{bad_request, conflict};
        let Some(obj) = input.as_object() else {
            return Err(bad_request!(
                "payments.config_invalid",
                "config must be an object"
            ));
        };
        const KNOWN: &[&str] = &[
            "environment",
            "gateway_url",
            "app_id",
            "seller_id",
            "app_private_key",
            "alipay_public_key",
            "order_timeout_minutes",
        ];
        if let Some(k) = obj.keys().find(|k| !KNOWN.contains(&k.as_str())) {
            return Err(bad_request!(
                "payments.config_unknown_field",
                "unknown config field: {field}",
                field = k.chars().take(64).collect::<String>()
            ));
        }
        let environment = text_field(input, "environment").unwrap_or_else(|| "production".into());
        if !matches!(environment.as_str(), "sandbox" | "production" | "custom") {
            return Err(bad_request!(
                "payments.environment_invalid",
                "environment must be sandbox, production or custom"
            ));
        }
        let gateway_url = text_field(input, "gateway_url");
        match (&gateway_url, environment.as_str()) {
            (Some(g), "custom") if gateway_ok(g) => {}
            (_, "custom") => {
                return Err(bad_request!(
                    "payments.gateway_invalid",
                    "custom gateway must be an https URL (http only on loopback)"
                ))
            }
            (Some(_), _) => {
                return Err(bad_request!(
                    "payments.gateway_unexpected",
                    "gateway_url is only for the custom environment"
                ))
            }
            _ => {}
        }
        let app_id = text_field(input, "app_id");
        if app_id.as_deref().is_some_and(|v| !digits(v)) {
            return Err(bad_request!(
                "payments.app_id_invalid",
                "app_id must be 1-32 digits"
            ));
        }
        let seller_id = text_field(input, "seller_id");
        if seller_id.as_deref().is_some_and(|v| !digits(v)) {
            return Err(bad_request!(
                "payments.seller_id_invalid",
                "seller_id must be 1-32 digits (2088...)"
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
        let too_long = |t: &str| t.len() > MAX_KEY_TEXT;
        let new_app = match text_field(input, "app_private_key") {
            None => None,
            Some(t) if too_long(&t) => return Err(private_key_error(KeyError::NotPem)),
            Some(t) => Some(AppKey::parse(&t).map_err(private_key_error)?),
        };
        let new_public = match text_field(input, "alipay_public_key") {
            None => None,
            Some(t) if too_long(&t) => return Err(public_key_error(KeyError::NotPem)),
            Some(t) => Some((
                public_pem(&t),
                PublicKey::parse(&t).map_err(public_key_error)?,
            )),
        };
        let (prev_config, prev_secrets) = match prev {
            Some((c, s)) => (Some(c), Some(s)),
            None => (None, None),
        };
        // The private key in force after this change.
        let kept_app = match (&new_app, prev_secrets) {
            (None, Some(s)) if s.get("app_private_key").is_some() => Some(app_key_of(s).ok_or_else(
                || {
                    conflict!(
                        "payments.stored_key_unreadable",
                        "the stored app private key cannot be opened (data/totp.key changed); paste it again"
                    )
                },
            )?),
            _ => None,
        };
        let app = new_app.as_ref().or(kept_app.as_ref());
        let prev_public = prev_config.and_then(|c| text_field(c, "alipay_public_key"));
        let public_after = new_public
            .as_ref()
            .map(|(pem, _)| pem.clone())
            .or_else(|| prev_public.clone());
        if let (Some(app), Some(pem)) = (app, &public_after)
            && PublicKey::parse(pem).is_ok_and(|k| is_app_public_key(app, &k))
        {
            return Err(bad_request!(
                "payments.public_key_is_app_key",
                "the Alipay public key is the app's own public key; paste 支付宝公钥"
            ));
        }
        if complete && (app_id.is_none() || app.is_none() || public_after.is_none()) {
            return Err(conflict!(
                "payments.incomplete",
                "enabling needs the app_id, the app private key and the Alipay public key"
            ));
        }
        // Rotation: a replaced Alipay public key stays valid for a while.
        let (mut prev_key, mut prev_until) = (
            prev_config.and_then(|c| text_field(c, "alipay_public_key_prev")),
            prev_config.and_then(|c| text_field(c, "alipay_public_key_prev_until")),
        );
        if let (Some((_, new)), Some(old)) = (&new_public, &prev_public)
            && PublicKey::parse(old).is_ok_and(|o| &o != new)
        {
            prev_key = Some(old.clone());
            prev_until =
                Some((Utc::now() + chrono::Duration::hours(PREV_KEY_GRACE_HOURS)).to_rfc3339());
        }
        let config = serde_json::json!({
            "environment": environment,
            "gateway_url": gateway_url.filter(|_| environment == "custom"),
            "app_id": app_id,
            "seller_id": seller_id,
            "order_timeout_minutes": timeout,
            "alipay_public_key": public_after,
            "alipay_public_key_prev": prev_key,
            "alipay_public_key_prev_until": prev_until,
            "app_key_fingerprint": app.map(AppKey::fingerprint),
        });
        let mut secrets = prev_secrets
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let mut changed = Vec::new();
        if let Some(k) = &new_app {
            secrets["app_private_key"] =
                Value::String(base64::engine::general_purpose::STANDARD.encode(k.der()));
            changed.push("app_private_key");
        }
        Ok(super::provider::Validated {
            config,
            secrets,
            changed_secrets: changed,
        })
    }

    fn build(
        &self,
        config: &Value,
        secrets: &Value,
    ) -> Result<std::sync::Arc<dyn super::provider::PaymentProvider>, String> {
        let app_id = text_field(config, "app_id").ok_or("app_id missing")?;
        let app = app_key_of(secrets).ok_or("app private key missing or unreadable")?;
        let public = text_field(config, "alipay_public_key").ok_or("alipay public key missing")?;
        let public = PublicKey::parse(&public).map_err(|e| format!("alipay public key: {e}"))?;
        let prev = match (
            text_field(config, "alipay_public_key_prev"),
            text_field(config, "alipay_public_key_prev_until")
                .and_then(|u| DateTime::parse_from_rfc3339(&u).ok()),
        ) {
            (Some(p), Some(until)) => PublicKey::parse(&p)
                .ok()
                .map(|k| (k, until.with_timezone(&Utc))),
            _ => None,
        };
        let env = text_field(config, "environment").unwrap_or_else(|| "production".into());
        let gateway = gateway_of(&env, text_field(config, "gateway_url").as_deref())
            .ok_or("bad environment")?;
        let params = Params {
            app_id,
            seller_id: text_field(config, "seller_id"),
            gateway_url: gateway,
            order_timeout_minutes: config
                .get("order_timeout_minutes")
                .and_then(Value::as_u64)
                .unwrap_or(15)
                .clamp(5, 120) as u32,
        };
        Ok(std::sync::Arc::new(Alipay::new(
            &params,
            Keys::new(app, public, prev),
        )))
    }

    fn view(&self, config: &Value, secrets: Option<&Value>) -> Value {
        let mut v = serde_json::json!({});
        for k in [
            "environment",
            "gateway_url",
            "app_id",
            "seller_id",
            "order_timeout_minutes",
            "alipay_public_key",
            "app_key_fingerprint",
        ] {
            v[k] = config.get(k).cloned().unwrap_or(Value::Null);
        }
        let app = secrets.and_then(app_key_of);
        v["app_private_key_set"] =
            Value::Bool(secrets.is_some_and(|s| s.get("app_private_key").is_some()));
        v["app_private_key_readable"] = Value::Bool(app.is_some());
        v["app_public_key"] = app
            .map(|a| Value::String(a.public_spki_b64()))
            .unwrap_or(Value::Null);
        v["alipay_public_key_fingerprint"] = text_field(config, "alipay_public_key")
            .and_then(|p| PublicKey::parse(&p).ok())
            .map(|k| Value::String(k.fingerprint()))
            .unwrap_or(Value::Null);
        v["alipay_public_key_prev_until"] = text_field(config, "alipay_public_key_prev_until")
            .filter(|u| {
                DateTime::parse_from_rfc3339(u).is_ok_and(|t| t.with_timezone(&Utc) > Utc::now())
            })
            .map(Value::String)
            .unwrap_or(Value::Null);
        v
    }

    fn peek_out_trade_no(&self, body: &[u8]) -> Option<String> {
        super::api::parse_form(body)?.remove("out_trade_no")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const APP_KEY: &str = include_str!("testdata/app-key.pem");
    pub const APP_PUB: &str = include_str!("testdata/app-pub.pem");
    pub const ALIPAY_KEY: &str = include_str!("testdata/alipay-key.pem");
    pub const ALIPAY_PUB: &str = include_str!("testdata/alipay-pub.pem");

    /// Gateway parameters for tests.
    pub fn test_params(gateway: &str) -> Params {
        Params {
            app_id: "2021000000000001".into(),
            seller_id: Some("2088000000000001".into()),
            gateway_url: gateway.into(),
            order_timeout_minutes: 15,
        }
    }

    #[test]
    fn key_parsing_and_errors() {
        let app = AppKey::parse(APP_KEY).unwrap();
        let alipay = PublicKey::parse(ALIPAY_PUB).unwrap();
        // The derived 应用公钥 (SPKI base64) is the app public key.
        let spki = app.public_spki_b64();
        // A PKCS#1 public key is a public key (not mistaken for a private one).
        let pkcs1 = base64::engine::general_purpose::STANDARD.encode(app.public_pkcs1());
        assert_eq!(
            PublicKey::parse(&pkcs1).unwrap(),
            PublicKey::parse(APP_PUB).unwrap()
        );
        assert_eq!(
            PublicKey::parse(&spki).unwrap(),
            PublicKey::parse(APP_PUB).unwrap()
        );
        assert!(is_app_public_key(&app, &PublicKey::parse(APP_PUB).unwrap()));
        assert!(!is_app_public_key(&app, &alipay));
        assert_eq!(app.fingerprint().len(), 64);
        assert_eq!(
            AppKey::from_der(app.der().to_vec()).unwrap().fingerprint(),
            app.fingerprint()
        );
        assert_eq!(format!("{app:?}"), "AppKey(<redacted>)");
        // Errors.
        assert_eq!(AppKey::parse("").unwrap_err(), KeyError::NotPem);
        assert_eq!(AppKey::parse("!!!").unwrap_err(), KeyError::NotPem);
        assert_eq!(AppKey::parse(ALIPAY_PUB).unwrap_err(), KeyError::NotRsa);
        assert_eq!(
            PublicKey::parse(APP_KEY).unwrap_err(),
            KeyError::PrivateInPublic
        );
        let bare: String = APP_KEY
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect();
        assert_eq!(
            PublicKey::parse(&bare).unwrap_err(),
            KeyError::PrivateInPublic
        );
        assert_eq!(PublicKey::parse("AAAA").unwrap_err(), KeyError::NotRsa);
        // A 1024-bit key is too short for RSA2.
        assert_eq!(AppKey::parse(SHORT_KEY).unwrap_err(), KeyError::TooShort);
        assert_eq!(PublicKey::parse(SHORT_PUB).unwrap_err(), KeyError::TooShort);
        // SPKI DER length encodings (short and long form).
        let mut v = Vec::new();
        der_len(5, &mut v);
        der_len(0x1234, &mut v);
        assert_eq!(v, [5, 0x82, 0x12, 0x34]);
    }

    pub const SHORT_KEY: &str = include_str!("testdata/short-key.pem");
    pub const SHORT_PUB: &str = include_str!("testdata/short-pub.pem");

    #[test]
    fn previous_alipay_key_is_accepted_until_its_deadline() {
        let old = PublicKey::parse(ALIPAY_PUB).unwrap();
        // "New" Alipay key = some other key (the app's public key here).
        let new = PublicKey::parse(APP_PUB).unwrap();
        let now = Utc::now();
        let until = now + chrono::Duration::hours(48);
        let keys = Keys::new(AppKey::parse(APP_KEY).unwrap(), new, Some((old, until)));
        let sig = alipay_side_keys().sign("x=1").unwrap();
        assert!(keys.verify_at(b"x=1", &sig, now));
        assert!(!keys.verify_at(b"x=1", &sig, until));
        assert!(!keys.verify_at(b"x=2", &sig, now));
        // The current key always verifies.
        let cur = Keys::from_texts(APP_KEY, APP_PUB).unwrap();
        let own = cur.sign("y").unwrap();
        assert!(keys.verify_at(b"y", &own, until + chrono::Duration::days(1)));
    }

    #[test]
    fn test_connection_outcomes() {
        let biz = |sub: &str, verified| {
            Err(CallError::Business {
                code: "40004".into(),
                sub_code: sub.into(),
                sub_msg: "m".into(),
                verified,
            })
        };
        let j = judge_test(biz("ACQ.TRADE_NOT_EXIST", true));
        assert!(j.ok);
        assert_eq!(j.result, "keys_ok");
        assert_eq!(
            judge_test(biz("ACQ.TRADE_NOT_EXIST", false)).result,
            "unsigned"
        );
        assert_eq!(
            judge_test(biz("isv.invalid-signature", false)).result,
            "app_key_rejected"
        );
        assert_eq!(
            judge_test(biz("isv.invalid-app-id", false)).result,
            "app_id_invalid"
        );
        assert_eq!(judge_test(biz("ACQ.SYSTEM_ERROR", true)).result, "other");
        assert_eq!(
            judge_test(Err(CallError::BadSignature)).result,
            "alipay_key_wrong"
        );
        assert_eq!(
            judge_test(Err(CallError::Transport("x".into()))).result,
            "unreachable"
        );
        assert_eq!(
            judge_test(Err(CallError::Status(404))).result,
            "gateway_status"
        );
        assert_eq!(
            judge_test(Err(CallError::Malformed("x"))).result,
            "malformed"
        );
        assert!(judge_test(Ok(serde_json::json!({}))).ok);
        for r in [
            biz("ACQ.TRADE_NOT_EXIST", false),
            Err(CallError::BadSignature),
        ] {
            assert!(!judge_test(r).ok);
        }
    }

    /// The panel's keys (app key + "Alipay" test public key).
    pub fn panel_keys() -> Keys {
        Keys::from_texts(APP_KEY, ALIPAY_PUB).unwrap()
    }

    /// The mock Alipay's keys: signs with the "Alipay" key, verifies the
    /// panel's app signature.
    pub fn alipay_side_keys() -> Keys {
        Keys::from_texts(ALIPAY_KEY, APP_PUB).unwrap()
    }

    #[test]
    fn amounts() {
        assert_eq!(format_cents(1), "0.01");
        assert_eq!(format_cents(1234), "12.34");
        assert_eq!(format_cents(100), "1.00");
        assert_eq!(format_cents(100000000), "1000000.00");
        for (s, want) in [
            ("0.01", Some(1)),
            ("12.34", Some(1234)),
            ("12.3", Some(1230)),
            ("12", Some(1200)),
            ("1000000.00", Some(100000000)),
            ("", None),
            (".5", None),
            ("1.", None),
            ("1.234", None),
            ("-1.00", None),
            ("+1.00", None),
            ("1e2", None),
            (" 1.00", None),
            ("1,00", None),
            ("9999999999999.00", None),
        ] {
            assert_eq!(parse_amount(s), want, "{s:?}");
        }
        for c in [1, 9, 10, 99, 100, 101, 1234, 99999] {
            assert_eq!(parse_amount(&format_cents(c)), Some(c));
        }
    }

    #[test]
    fn signature_matches_openssl_vector() {
        // testdata/app-sig-vector.txt = `openssl dgst -sha256 -sign
        // app-key.pem` over these bytes (PKCS#1 v1.5 is deterministic).
        let want = include_str!("testdata/app-sig-vector.txt").trim();
        let got = panel_keys().sign("a=1&b=中文&c=x y").unwrap();
        assert_eq!(got, want);
        // And the other side verifies it with the public key.
        assert!(alipay_side_keys().verify("a=1&b=中文&c=x y".as_bytes(), &got));
        assert!(!alipay_side_keys().verify("a=1&b=中文&c=x z".as_bytes(), &got));
    }

    #[test]
    fn keys_accept_pkcs1_pkcs8_pem_and_bare_base64() {
        // PKCS#1 PEM (app) and PKCS#8 PEM (alipay) private keys.
        assert!(Keys::from_texts(APP_KEY, ALIPAY_PUB).is_ok());
        assert!(Keys::from_texts(ALIPAY_KEY, APP_PUB).is_ok());
        // Bare base64 as Alipay's key tool writes it.
        let bare = |pem: &str| -> String {
            pem.lines()
                .filter(|l| !l.starts_with("-----"))
                .collect::<Vec<_>>()
                .concat()
        };
        let k = Keys::from_texts(&bare(APP_KEY), &bare(ALIPAY_PUB)).unwrap();
        let s = k.sign("x").unwrap();
        assert!(alipay_side_keys().verify(b"x", &s));
        // Garbage and swapped keys are refused.
        assert!(Keys::from_texts("nope", ALIPAY_PUB).is_err());
        assert!(Keys::from_texts(APP_KEY, "AAAA").is_err());
        assert!(Keys::from_texts(ALIPAY_PUB, APP_KEY).is_err());
        assert_eq!(format!("{k:?}"), "Keys(<redacted>)");
    }

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn canonical_strings() {
        let p = map(&[
            ("sign", "S"),
            ("sign_type", "RSA2"),
            ("b", "2"),
            ("a", "1"),
            ("empty", ""),
            ("biz_content", "{\"x\":\"y z\"}"),
        ]);
        assert_eq!(
            request_sign_content(&p),
            "a=1&b=2&biz_content={\"x\":\"y z\"}&sign_type=RSA2"
        );
        assert_eq!(
            notify_sign_content(&p, true),
            "a=1&b=2&biz_content={\"x\":\"y z\"}&empty="
        );
        assert_eq!(
            notify_sign_content(&p, false),
            "a=1&b=2&biz_content={\"x\":\"y z\"}"
        );
        // Byte order: upper case before lower case, '_' between.
        let p = map(&[("a_b", "1"), ("aB", "2"), ("ab", "3")]);
        assert_eq!(request_sign_content(&p), "aB=2&a_b=1&ab=3");
    }

    /// Sign notify params the way Alipay does (test side).
    pub fn sign_notify(params: &mut BTreeMap<String, String>) {
        params.insert("sign_type".into(), "RSA2".into());
        let s = alipay_side_keys()
            .sign(&notify_sign_content(params, true))
            .unwrap();
        params.insert("sign".into(), s);
    }

    #[test]
    fn notify_verification() {
        let keys = panel_keys();
        let mut p = map(&[
            ("app_id", "2021000000000001"),
            ("out_trade_no", "AK1"),
            ("total_amount", "9.90"),
            ("trade_status", "TRADE_SUCCESS"),
            ("subject", "Akari 月付 & more"),
            (
                "fund_bill_list",
                "[{\"amount\":\"9.90\",\"fundChannel\":\"ALIPAYACCOUNT\"}]",
            ),
        ]);
        sign_notify(&mut p);
        assert!(verify_notify(&keys, &p));
        // Any tampered value, extra non-empty param or missing sign fails.
        let mut t = p.clone();
        t.insert("total_amount".into(), "0.01".into());
        assert!(!verify_notify(&keys, &t));
        let mut t = p.clone();
        t.insert("seller_id".into(), "x".into());
        assert!(!verify_notify(&keys, &t));
        let mut t = p.clone();
        t.remove("sign");
        assert!(!verify_notify(&keys, &t));
        let mut t = p.clone();
        t.insert("sign_type".into(), "RSA".into());
        assert!(!verify_notify(&keys, &t));
        // Signed by the app key (not Alipay's): refused.
        let mut t = p.clone();
        let s = keys.sign(&notify_sign_content(&t, true)).unwrap();
        t.insert("sign".into(), s);
        assert!(!verify_notify(&keys, &t));
        // An empty param under a signature that dropped empties.
        let mut t = map(&[("a", "1"), ("b", ""), ("sign_type", "RSA2")]);
        let s = alipay_side_keys()
            .sign(&notify_sign_content(&t, false))
            .unwrap();
        t.insert("sign".into(), s);
        assert!(verify_notify(&keys, &t));
    }

    /// A gateway response body signed by the test "Alipay" key.
    pub fn signed_response(method: &str, obj: &Value) -> String {
        let raw = obj.to_string();
        let sig = alipay_side_keys().sign(&raw).unwrap();
        format!(
            "{{\"{}_response\":{raw},\"sign\":\"{sig}\"}}",
            method.replace('.', "_")
        )
    }

    #[test]
    fn response_verification() {
        let keys = panel_keys();
        let m = "alipay.trade.precreate";
        let ok = serde_json::json!({"code":"10000","msg":"Success","out_trade_no":"AK1","qr_code":"https://qr.alipay.com/x"});
        let body = signed_response(m, &ok);
        assert_eq!(parse_response(&keys, m, body.as_bytes()).unwrap(), ok);
        // Raw bytes are verified, not a re-serialization: Alipay escapes
        // '/' as "\/" and orders keys its own way.
        let raw = r#"{"code":"10000","msg":"Success","qr_code":"https:\/\/qr.alipay.com\/x","out_trade_no":"AK1"}"#;
        let sig = alipay_side_keys().sign(raw).unwrap();
        let body = format!(r#"{{"alipay_trade_precreate_response":{raw},"sign":"{sig}"}}"#);
        let v = parse_response(&keys, m, body.as_bytes()).unwrap();
        assert_eq!(v["qr_code"], "https://qr.alipay.com/x");
        // Tampered / unsigned success / wrong method.
        let tampered = body.replace("AK1", "AK2");
        assert!(matches!(
            parse_response(&keys, m, tampered.as_bytes()),
            Err(CallError::BadSignature)
        ));
        let unsigned = format!(r#"{{"alipay_trade_precreate_response":{raw}}}"#);
        assert!(matches!(
            parse_response(&keys, m, unsigned.as_bytes()),
            Err(CallError::BadSignature)
        ));
        assert!(matches!(
            parse_response(&keys, "alipay.trade.query", body.as_bytes()),
            Err(CallError::Malformed(_))
        ));
        // Unsigned business errors are reported as such.
        let err = r#"{"alipay_trade_query_response":{"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_NOT_EXIST","sub_msg":"交易不存在"}}"#;
        match parse_response(&keys, "alipay.trade.query", err.as_bytes()) {
            Err(CallError::Business {
                sub_code, verified, ..
            }) => {
                assert_eq!(sub_code, "ACQ.TRADE_NOT_EXIST");
                assert!(!verified);
            }
            other => panic!("{other:?}"),
        }
        // A signed business error verifies (测试连接 relies on it).
        let obj = serde_json::json!({"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_NOT_EXIST","sub_msg":"x"});
        let body = signed_response("alipay.trade.query", &obj);
        assert!(matches!(
            parse_response(&keys, "alipay.trade.query", body.as_bytes()),
            Err(CallError::Business { verified: true, .. })
        ));
        let err = r#"{"error_response":{"code":"40002","msg":"Invalid Arguments","sub_code":"isv.invalid-app-id","sub_msg":"x"}}"#;
        assert!(matches!(
            parse_response(&keys, m, err.as_bytes()),
            Err(CallError::Business { .. })
        ));
        assert!(matches!(
            parse_response(&keys, m, b"<html>"),
            Err(CallError::Malformed(_))
        ));
    }

    #[test]
    fn request_body_is_signed_and_complete() {
        let cfg = test_params("http://127.0.0.1:9/gateway.do");
        let notify_url = "https://panel.example/PREFIX/pay/alipay/notify";
        let a = Alipay::new(&cfg, panel_keys());
        let now = DateTime::parse_from_rfc3339("2026-10-02T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let body = a
            .request_body(
                "alipay.trade.precreate",
                &serde_json::json!({"out_trade_no":"AK1","total_amount":"1.00","subject":"中文 & x"}),
                Some(notify_url),
                now,
            )
            .unwrap();
        let p: BTreeMap<String, String> = form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();
        assert_eq!(p["timestamp"], "2026-10-02 08:00:00", "Beijing time");
        assert_eq!(p["sign_type"], "RSA2");
        assert_eq!(p["charset"], "utf-8");
        assert_eq!(p["notify_url"], notify_url);
        assert!(p["biz_content"].contains("中文 & x"));
        assert!(alipay_side_keys().verify(request_sign_content(&p).as_bytes(), &p["sign"]));
        let a2 = a
            .request_body("alipay.trade.query", &serde_json::json!({}), None, now)
            .unwrap();
        assert!(!a2.contains("notify_url"));
    }
}

/// Opt-in check against the REAL Alipay sandbox (ignored; needs network
/// and the operator's sandbox credentials, never committed). Reads the
/// files by path only and prints outcomes only (no keys, no signatures):
///   cargo test --lib live_sandbox -- --ignored --nocapture
/// Defaults to ~/secrets/alipay-sandbox{.env,-app-private.pem,
/// -alipay-public.pem}; AKARI_ALIPAY_LIVE_{ENV,KEY,PUB} override. Skips
/// (passes) when the files are absent. The database-configured variant
/// (系统设置 → 支付 through the API) is `billing::settings::tests::
/// live_sandbox_db_configured`.
#[cfg(test)]
pub(crate) mod live {
    use super::*;

    pub fn env_value(text: &str, key: &str) -> String {
        text.lines()
            .filter_map(|l| l.trim().split_once('='))
            .find(|(k, _)| k.trim() == key)
            .map(|(_, v)| v.trim().trim_matches('"').to_string())
            .unwrap_or_default()
    }

    /// (env text, private key text, Alipay public key text), or None when
    /// any file is missing.
    pub fn sandbox_files() -> Option<(String, String, String)> {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = |var: &str, name: &str| {
            std::env::var(var).unwrap_or_else(|_| format!("{home}/secrets/{name}"))
        };
        let env =
            std::fs::read_to_string(path("AKARI_ALIPAY_LIVE_ENV", "alipay-sandbox.env")).ok()?;
        let key = std::fs::read_to_string(path(
            "AKARI_ALIPAY_LIVE_KEY",
            "alipay-sandbox-app-private.pem",
        ))
        .ok()?;
        let public = std::fs::read_to_string(path(
            "AKARI_ALIPAY_LIVE_PUB",
            "alipay-sandbox-alipay-public.pem",
        ))
        .ok()?;
        Some((env, key, public))
    }

    #[tokio::test]
    #[ignore]
    async fn live_sandbox() {
        let Some((env, key, public)) = sandbox_files() else {
            println!("SKIP: sandbox credential files absent");
            return;
        };
        let params = Params {
            app_id: env_value(&env, "ALIPAY_SANDBOX_APP_ID"),
            seller_id: Some(env_value(&env, "ALIPAY_SANDBOX_SELLER_ID")),
            gateway_url: GATEWAY_SANDBOX.into(),
            order_timeout_minutes: 15,
        };
        let a = Alipay::new(
            &params,
            Keys::from_texts(&key, &public).expect("sandbox keys load"),
        );
        let t = a.test_connection().await;
        println!("test connection: {} {}", t.result, t.message);
        let notify = "http://myapp.test:8080/PREFIX/pay/alipay/notify";
        let otn = format!("AKLIVE{}", hex::encode(rand::random::<[u8; 8]>()));
        let qr = a.precreate(notify, &otn, 1, "Akari sandbox check").await;
        println!(
            "precreate: {:?}",
            qr.as_ref()
                .map(|q| q.split('/').take(3).collect::<Vec<_>>().join("/"))
        );
        assert!(qr.is_ok(), "precreate failed: {:?}", qr.err());
        let q = a.query(&otn).await;
        println!("query after precreate: {q:?}");
        assert!(!matches!(q, Err(CallError::BadSignature)));
        let c = a.close(&otn).await;
        println!("close: {c:?}");
        // The wrong Alipay public key must fail verification of a real
        // response.
        let wrong = Alipay::new(&params, tests::panel_keys());
        let r = wrong.query(&otn).await;
        println!("query with the wrong alipay public key: {r:?}");
        assert!(matches!(
            r,
            Err(CallError::BadSignature) | Err(CallError::Status(_))
        ));
    }
}
