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
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::Value;

use crate::config::AlipayConfig;

/// The Alipay "success" result code.
const CODE_OK: &str = "10000";
/// Gateway call timeout (connect + TLS + request + response).
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

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
    let mut f: i64 = if frac.is_empty() { 0 } else { frac.parse().ok()? };
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

/// The panel's app key pair and Alipay's public key.
pub struct Keys {
    signer: RsaKeyPair,
    /// Alipay public key modulus / exponent (big-endian, no leading zeros).
    alipay_n: Vec<u8>,
    alipay_e: Vec<u8>,
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
        let der = key_der(app_private).map_err(|e| format!("app private key: {e}"))?;
        let signer = RsaKeyPair::from_pkcs8(&der)
            .or_else(|_| RsaKeyPair::from_der(&der))
            .map_err(|e| format!("app private key: not a usable RSA key ({e})"))?;
        if signer.public().modulus_len() < 256 {
            return Err("app private key: RSA2 needs at least 2048 bits".into());
        }
        let der = key_der(alipay_public).map_err(|e| format!("alipay public key: {e}"))?;
        let (n, e) = rsa_public_components(&der)
            .ok_or_else(|| "alipay public key: not an RSA public key".to_string())?;
        if n.len() < 256 {
            return Err("alipay public key: RSA2 needs at least 2048 bits".into());
        }
        Ok(Self {
            signer,
            alipay_n: n,
            alipay_e: e,
            rng: SystemRandom::new(),
        })
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

    /// Verify an Alipay signature (base64) over `content`.
    pub fn verify(&self, content: &[u8], sig_b64: &str) -> bool {
        let Ok(sig) = base64::engine::general_purpose::STANDARD.decode(sig_b64.trim()) else {
            return false;
        };
        let key = signature::RsaPublicKeyComponents {
            n: &self.alipay_n,
            e: &self.alipay_e,
        };
        key.verify(&signature::RSA_PKCS1_2048_8192_SHA256, content, &sig)
            .is_ok()
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

/// A failed gateway call. Messages carry no secrets (Alipay's own codes and
/// messages only).
#[derive(Debug, thiserror::Error)]
pub enum CallError {
    #[error("gateway unreachable: {0}")]
    Transport(String),
    #[error("gateway answered HTTP {0}")]
    Status(u16),
    #[error("malformed gateway response: {0}")]
    Malformed(&'static str),
    #[error("gateway response signature invalid")]
    BadSignature,
    #[error("alipay error {code} {sub_code}: {sub_msg}")]
    Business {
        code: String,
        sub_code: String,
        sub_msg: String,
    },
}

/// What a trade query found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Query {
    /// No trade yet (the QR was not scanned).
    NotExist,
    Trade {
        /// WAIT_BUYER_PAY | TRADE_CLOSED | TRADE_SUCCESS | TRADE_FINISHED
        status: String,
        trade_no: String,
        total_cents: Option<i64>,
    },
}

/// What a close found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Close {
    Closed,
    /// Nothing to close (never scanned).
    NotExist,
}

pub struct Alipay {
    pub app_id: String,
    pub seller_id: Option<String>,
    gateway: String,
    notify_url: String,
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

/// A private key file must not be readable by group/other.
#[cfg(unix)]
fn check_private_mode(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.permissions().mode() & 0o077 != 0 {
        return Err(format!(
            "{}: permissions too open (chmod 600)",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_private_mode(_: &std::path::Path) -> Result<(), String> {
    Ok(())
}

impl Alipay {
    /// Load and check the key files of an enabled `[payments.alipay]`.
    pub fn from_config(cfg: &AlipayConfig) -> Result<Self, String> {
        check_private_mode(&cfg.app_private_key_file)
            .map_err(|e| format!("payments.alipay.app_private_key_file: {e}"))?;
        let private = std::fs::read_to_string(&cfg.app_private_key_file).map_err(|e| {
            format!(
                "payments.alipay.app_private_key_file: {}: {e}",
                cfg.app_private_key_file.display()
            )
        })?;
        let public = std::fs::read_to_string(&cfg.alipay_public_key_file).map_err(|e| {
            format!(
                "payments.alipay.alipay_public_key_file: {}: {e}",
                cfg.alipay_public_key_file.display()
            )
        })?;
        let keys = Keys::from_texts(&private, &public).map_err(|e| format!("payments.alipay: {e}"))?;
        Ok(Self::new(cfg, keys))
    }

    pub fn new(cfg: &AlipayConfig, keys: Keys) -> Self {
        Self {
            app_id: cfg.app_id.clone(),
            seller_id: (!cfg.seller_id.is_empty()).then(|| cfg.seller_id.clone()),
            gateway: cfg.gateway_url.clone(),
            notify_url: cfg.notify_url.clone(),
            order_timeout_minutes: cfg.order_timeout_minutes,
            keys,
        }
    }

    pub fn keys(&self) -> &Keys {
        &self.keys
    }

    /// The signed form body of one call.
    pub fn request_body(
        &self,
        method: &str,
        biz: &Value,
        with_notify: bool,
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
        if with_notify {
            p.insert("notify_url".to_string(), self.notify_url.clone());
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
    async fn call(&self, method: &str, biz: Value, with_notify: bool) -> Result<Value, CallError> {
        let body = self
            .request_body(method, &biz, with_notify, Utc::now())
            .map_err(|_| CallError::Malformed("could not sign the request"))?;
        let (status, bytes) = super::http::post_form(&self.gateway, body, CALL_TIMEOUT)
            .await
            .map_err(CallError::Transport)?;
        if status != 200 {
            return Err(CallError::Status(status));
        }
        parse_response(&self.keys, method, &bytes)
    }

    /// alipay.trade.precreate → the QR payload.
    pub async fn precreate(
        &self,
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
        let r = self.call("alipay.trade.precreate", biz, true).await?;
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
        match self.call("alipay.trade.query", biz, false).await {
            Ok(r) => {
                if r.get("out_trade_no").and_then(Value::as_str) != Some(out_trade_no) {
                    return Err(CallError::Malformed("query answered another order"));
                }
                let status = r
                    .get("trade_status")
                    .and_then(Value::as_str)
                    .ok_or(CallError::Malformed("query without trade_status"))?;
                Ok(Query::Trade {
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
        match self.call("alipay.trade.close", biz, false).await {
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
    #[derive(Deserialize)]
    struct Envelope<'a> {
        #[serde(borrow, flatten)]
        fields: BTreeMap<String, &'a RawValue>,
    }
    let env: Envelope =
        serde_json::from_slice(body).map_err(|_| CallError::Malformed("not JSON"))?;
    let key = format!("{}_response", method.replace('.', "_"));
    // An unknown method/app answers `error_response` (never signed).
    let raw = env
        .fields
        .get(&key)
        .or_else(|| env.fields.get("error_response"))
        .ok_or(CallError::Malformed("no response object"))?;
    let obj: Value =
        serde_json::from_str(raw.get()).map_err(|_| CallError::Malformed("bad response object"))?;
    let sig: Option<String> = env
        .fields
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
        });
    }
    if !verified {
        return Err(CallError::BadSignature);
    }
    Ok(obj)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const APP_KEY: &str = include_str!("testdata/app-key.pem");
    pub const APP_PUB: &str = include_str!("testdata/app-pub.pem");
    pub const ALIPAY_KEY: &str = include_str!("testdata/alipay-key.pem");
    pub const ALIPAY_PUB: &str = include_str!("testdata/alipay-pub.pem");

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
        assert_eq!(notify_sign_content(&p, true), "a=1&b=2&biz_content={\"x\":\"y z\"}&empty=");
        assert_eq!(notify_sign_content(&p, false), "a=1&b=2&biz_content={\"x\":\"y z\"}");
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
            ("fund_bill_list", "[{\"amount\":\"9.90\",\"fundChannel\":\"ALIPAYACCOUNT\"}]"),
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
            Err(CallError::Business { sub_code, .. }) => assert_eq!(sub_code, "ACQ.TRADE_NOT_EXIST"),
            other => panic!("{other:?}"),
        }
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
        let cfg = AlipayConfig {
            enabled: true,
            app_id: "2021000000000001".into(),
            notify_url: "https://panel.example/PREFIX/pay/alipay/notify".into(),
            ..Default::default()
        };
        let a = Alipay::new(&cfg, panel_keys());
        let now = DateTime::parse_from_rfc3339("2026-10-02T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let body = a
            .request_body(
                "alipay.trade.precreate",
                &serde_json::json!({"out_trade_no":"AK1","total_amount":"1.00","subject":"中文 & x"}),
                true,
                now,
            )
            .unwrap();
        let p: BTreeMap<String, String> = form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();
        assert_eq!(p["timestamp"], "2026-10-02 08:00:00", "Beijing time");
        assert_eq!(p["sign_type"], "RSA2");
        assert_eq!(p["charset"], "utf-8");
        assert_eq!(p["notify_url"], cfg.notify_url);
        assert!(p["biz_content"].contains("中文 & x"));
        assert!(alipay_side_keys().verify(request_sign_content(&p).as_bytes(), &p["sign"]));
        let a2 = a.request_body("alipay.trade.query", &serde_json::json!({}), false, now).unwrap();
        assert!(!a2.contains("notify_url"));
    }
}
