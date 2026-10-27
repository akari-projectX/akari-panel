//! Shared pieces of the hosted crypto gateways, CoinPayments
//! (`coinpayments.rs`) and Coinbase (`coinbase.rs`).
//!
//! Both gateways price an invoice in a fiat currency (or a dollar stablecoin)
//! and carry the exchange-rate risk to the crypto the payer sends. Orders
//! stay in integer CNY cents, so the invoice currency is the operator's
//! choice (`currency`, ISO code): CNY when the gateway prices in CNY, else a
//! currency the gateway supports plus an explicit fixed rate (`rate_cents` =
//! CNY cents per 1.00 of that currency, like `usdt_rate_cents`). The invoice
//! amount is `ceil(order cents × 100 / rate_cents)` in the invoice currency's
//! cents (rounding in the merchant's favour), computed here and nowhere else.
//!
//! Settlement compares amounts exactly: the order's CNY cents are echoed by
//! the gateway (we put them in the invoice's custom data / metadata), the
//! gateway's own invoice amount and currency must equal what this module
//! computes from those cents under the CURRENT configuration, and only then
//! does the provider report `total_cents = Some(order cents)`; any doubt
//! (another currency, another amount, an amount in an unexpected format, a
//! changed rate) reports `None`, which `api::handle_notify` /
//! `orders::apply_query_result` turn into an `amount_mismatch` event and no
//! payment.

use std::time::Duration;

use axum::http::Uri;
use serde_json::Value;

use super::provider::CallError;
use crate::auth::{ApiError, bad_request};

/// The panel's own currency: no conversion.
pub const HOME_CURRENCY: &str = "CNY";
/// Longest hosted-checkout link stored (`orders.pay_url` CHECK).
pub const MAX_LINK: usize = 2048;
/// Attempts of an idempotent read (transport errors, 429, 5xx).
const READ_ATTEMPTS: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_millis(300);
/// A signed notify older (or newer) than this is a replay or a bad clock.
pub const MAX_SKEW_SECS: i64 = 300;

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/// How an order's CNY cents become the gateway invoice's amount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pricing {
    /// ISO code of the invoice currency (`CNY`, `USD`, `USDC`, …).
    pub currency: String,
    /// CNY cents per 1.00 of `currency` (100 for CNY).
    pub rate_cents: i64,
}

/// An invoice currency code: 3–10 ASCII capital letters.
pub fn currency_ok(c: &str) -> bool {
    (3..=10).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_uppercase())
}

/// The rate bounds (CNY cents per unit): 0.01 .. 10 000 CNY.
const RATE_RANGE: std::ops::RangeInclusive<i64> = 1..=1_000_000;

impl Pricing {
    /// From a validated currency and the optional rate; CNY ignores the rate.
    pub fn new(currency: &str, rate_cents: Option<i64>) -> Option<Self> {
        if !currency_ok(currency) {
            return None;
        }
        let rate_cents = if currency == HOME_CURRENCY {
            100
        } else {
            rate_cents.filter(|r| RATE_RANGE.contains(r))?
        };
        Some(Self {
            currency: currency.to_string(),
            rate_cents,
        })
    }

    /// The invoice amount in the currency's cents for an order of
    /// `cny_cents` (≥ 1): rounded up.
    pub fn minor(&self, cny_cents: i64) -> Option<i64> {
        if cny_cents < 1 || self.rate_cents < 1 {
            return None;
        }
        let num = cny_cents.checked_mul(100)?;
        num.checked_add(self.rate_cents - 1)?
            .checked_div(self.rate_cents)
    }

    /// The same as the decimal text gateways take ("9.90").
    pub fn text(&self, cny_cents: i64) -> Option<String> {
        self.minor(cny_cents).map(format_minor)
    }

    /// The gateway's amount `text` is exactly this order's invoice amount.
    /// `format`: whether an integer-looking text is accepted (CoinPayments'
    /// amount strings could be minor units in a format the documentation
    /// does not pin down; an integer-looking string is therefore never
    /// trusted there).
    pub fn matches(&self, cny_cents: i64, text: &str, format: AmountFormat) -> bool {
        match (self.minor(cny_cents), parse_decimal(text, format)) {
            (Some(want), Some(got)) => want == got,
            _ => false,
        }
    }
}

/// How strictly an amount text must look like a decimal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmountFormat {
    /// "12", "12.3", "12.34": major units, the point is optional.
    Plain,
    /// The decimal point is mandatory ("12.00"): an integer-looking text is
    /// ambiguous (major or minor units) and never trusted.
    Dotted,
}

/// Integer minor units as "d.dd".
pub fn format_minor(minor: i64) -> String {
    format!("{}.{:02}", minor / 100, minor % 100)
}

/// Strict decimal → minor units (2 places): digits, optional '.', at most 8
/// decimals of which everything past the second must be '0'; no sign, no
/// exponent, no spaces. `Dotted` = the '.' is mandatory.
pub fn parse_decimal(s: &str, format: AmountFormat) -> Option<i64> {
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) if !f.is_empty() => (i, f),
        Some(_) => return None,
        None if format == AmountFormat::Dotted => return None,
        None => (s, ""),
    };
    if int.is_empty()
        || int.len() > 12
        || !int.bytes().all(|b| b.is_ascii_digit())
        || frac.len() > 8
        || !frac.bytes().all(|b| b.is_ascii_digit())
        || frac.bytes().skip(2).any(|b| b != b'0')
    {
        return None;
    }
    let whole: i64 = int.parse().ok()?;
    let mut cents: i64 = frac
        .bytes()
        .take(2)
        .fold(0, |a, b| a * 10 + i64::from(b - b'0'));
    if frac.len() == 1 {
        cents *= 10;
    }
    whole.checked_mul(100)?.checked_add(cents)
}

/// Validate the `currency` / `rate_cents` pair of a form. `currency` absent =
/// the default is chosen by the caller. Returns the stored rate (None for CNY
/// and for an absent rate).
pub fn validate_pricing(
    currency: &str,
    rate: Option<i64>,
    complete: bool,
) -> Result<Option<i64>, ApiError> {
    if !currency_ok(currency) {
        return Err(bad_request!(
            "payments.currency_invalid",
            "currency must be an ISO code in capital letters (3-10 letters)"
        ));
    }
    if currency == HOME_CURRENCY {
        return Ok(None);
    }
    match rate {
        Some(r) if RATE_RANGE.contains(&r) => Ok(Some(r)),
        Some(_) => Err(bad_request!(
            "payments.rate_invalid",
            "rate_cents must be 1-1000000 (CNY cents per 1.00 of the invoice currency)"
        )),
        None if complete => Err(crate::auth::conflict!(
            "payments.incomplete",
            "enabling needs the exchange rate of a non-CNY invoice currency"
        )),
        None => Ok(None),
    }
}

/// The `rate_cents` field of a form: absent/null = None, an integer, or
/// `Err` for anything else.
pub fn rate_field(input: &Value) -> Result<Option<i64>, ApiError> {
    match input.get("rate_cents") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => s.trim().parse::<i64>().map(Some).map_err(|_| rate_error()),
        Some(v) => v.as_i64().map(Some).ok_or_else(rate_error),
    }
}

fn rate_error() -> ApiError {
    bad_request!(
        "payments.rate_invalid",
        "rate_cents must be 1-1000000 (CNY cents per 1.00 of the invoice currency)"
    )
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/// A trimmed, non-empty string member of a JSON object.
pub fn text_field(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A string or an integer member as text (gateways send ids both ways).
pub fn id_text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        _ => None,
    }
}

/// A visible-ASCII token (ids, key names, secrets without whitespace).
pub fn token_ok(v: &str, max: usize) -> bool {
    !v.is_empty() && v.len() <= max && v.bytes().all(|b| b.is_ascii_graphic())
}

/// A domain-separated fingerprint of a secret (SHA-256, 16 hex): enough to
/// tell two secrets apart, not to test guesses cheaply in bulk.
pub fn fingerprint(domain: &str, secret: &str) -> String {
    use sha2::Digest as _;
    let mut h = sha2::Sha256::new();
    h.update(domain.as_bytes());
    h.update([0]);
    h.update(secret.as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

/// The API base of a method: the gateway's own HTTPS host, or — for mock
/// gateways in tests — a loopback `http://` address. No path, query or
/// credentials; returned without a trailing slash.
pub fn api_base(url: &str, official: &[&str]) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    if official.contains(&url) {
        return Some(url.to_string());
    }
    let uri: Uri = url.parse().ok()?;
    let auth = uri.authority()?;
    let loopback = uri.scheme_str() == Some("http")
        && super::http::is_loopback_host(auth.host())
        && auth.as_str().bytes().all(|b| b.is_ascii_graphic())
        && !auth.as_str().contains('@');
    (loopback && uri.path() == "/" && !url.contains('?') && !url.contains('#'))
        .then(|| url.to_string())
}

/// The `host[:port]` of an API base (Coinbase signs `METHOD host/path`).
pub fn host_of(base: &str) -> Option<String> {
    base.parse::<Uri>()
        .ok()
        .and_then(|u| u.authority().map(|a| a.as_str().to_string()))
}

/// A hosted-checkout link from a gateway answer: https (http only to
/// loopback, mock gateways), bounded, no userinfo, whitespace or controls.
pub fn link_ok(url: &str) -> bool {
    if url.len() > MAX_LINK || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Ok(uri) = url.parse::<Uri>() else {
        return false;
    };
    let (Some(scheme), Some(auth)) = (uri.scheme_str(), uri.authority()) else {
        return false;
    };
    if auth.as_str().contains('@') {
        return false;
    }
    match scheme {
        "https" => true,
        "http" => super::http::is_loopback_host(auth.host()),
        _ => false,
    }
}

/// Run an idempotent read, retrying transport errors, 429 and 5xx.
pub async fn read_with_retries<T, F, Fut>(mut call: F) -> Result<T, CallError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, CallError>>,
{
    let mut attempt = 0;
    loop {
        attempt += 1;
        match call().await {
            Err(CallError::Transport(_)) if attempt < READ_ATTEMPTS => {}
            Err(CallError::Status(st)) if (st == 429 || st >= 500) && attempt < READ_ATTEMPTS => {}
            r => return r,
        }
        tokio::time::sleep(RETRY_DELAY).await;
    }
}

/// A gateway answer whose HTTP status is not 2xx: our classification only,
/// never the body.
pub fn status_error(status: u16) -> CallError {
    CallError::Status(status)
}

/// A unix-seconds clock reading as `YYYY-MM-DDTHH:MM:SS` UTC (CoinPayments'
/// timestamp format).
pub fn utc_stamp(unix: i64) -> String {
    chrono::DateTime::from_timestamp(unix, 0)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string()
}

/// Parse that format (no zone suffix) back to unix seconds.
pub fn parse_utc_stamp(s: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
        .ok()
        .map(|t| t.and_utc().timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pricing_rounds_up_and_matches_exactly() {
        let usd = Pricing::new("USD", Some(720)).unwrap();
        assert_eq!(usd.minor(720), Some(100));
        assert_eq!(usd.text(990), Some("1.38".into()));
        // 7.21 CNY at 7.20 → 1.0014 USD → 1.01 (up).
        assert_eq!(usd.minor(721), Some(101));
        assert_eq!(usd.minor(1), Some(1));
        assert_eq!(usd.minor(0), None);
        assert_eq!(usd.minor(-5), None);
        assert!(usd.matches(990, "1.38", AmountFormat::Dotted));
        assert!(usd.matches(990, "1.380", AmountFormat::Dotted));
        assert!(usd.matches(990, "1.38000000", AmountFormat::Dotted));
        assert!(!usd.matches(990, "1.37", AmountFormat::Dotted));
        assert!(!usd.matches(990, "1.39", AmountFormat::Dotted));
        // An integer-looking amount is ambiguous for CoinPayments.
        let one = Pricing::new("USD", Some(100)).unwrap();
        assert!(one.matches(1000, "10.00", AmountFormat::Dotted));
        assert!(!one.matches(1000, "10", AmountFormat::Dotted));
        assert!(one.matches(1000, "10", AmountFormat::Plain));
        assert!(!one.matches(1000, "1000", AmountFormat::Plain));
        let cny = Pricing::new("CNY", Some(3)).unwrap();
        assert_eq!(cny.rate_cents, 100, "CNY ignores the rate");
        assert_eq!(cny.text(990).as_deref(), Some("9.90"));
        assert!(Pricing::new("USD", None).is_none());
        assert!(Pricing::new("USD", Some(0)).is_none());
        assert!(Pricing::new("USD", Some(1_000_001)).is_none());
        assert!(Pricing::new("usd", Some(720)).is_none());
        assert!(Pricing::new("US", Some(720)).is_none());
        // No overflow on absurd cents.
        assert_eq!(usd.minor(i64::MAX), None);
    }

    #[test]
    fn decimals_are_strict() {
        use AmountFormat::{Dotted, Plain};
        for (s, format, want) in [
            ("9.90", Dotted, Some(990)),
            ("9.9", Dotted, Some(990)),
            ("0.01", Dotted, Some(1)),
            ("12", Plain, Some(1200)),
            ("12", Dotted, None),
            ("9.900", Dotted, Some(990)),
            ("9.905", Dotted, None),
            ("9.", Dotted, None),
            (".5", Dotted, None),
            ("", Dotted, None),
            ("-1.00", Dotted, None),
            ("+1.00", Dotted, None),
            ("1e2", Plain, None),
            ("1,00", Dotted, None),
            (" 1.00", Dotted, None),
            ("1.000000000", Dotted, None),
            ("1234567890123.00", Dotted, None),
        ] {
            assert_eq!(parse_decimal(s, format), want, "{s:?} {format:?}");
        }
        assert_eq!(format_minor(5), "0.05");
        assert_eq!(format_minor(123456), "1234.56");
    }

    #[test]
    fn pricing_validation() {
        assert_eq!(validate_pricing("CNY", Some(5), true).ok(), Some(None));
        assert_eq!(
            validate_pricing("USD", Some(720), true).ok(),
            Some(Some(720))
        );
        assert_eq!(validate_pricing("USD", None, false).ok(), Some(None));
        let code = |r: Result<Option<i64>, ApiError>| r.err().map(|e| e.code().to_string());
        assert_eq!(
            code(validate_pricing("USD", None, true)).as_deref(),
            Some("payments.incomplete")
        );
        assert_eq!(
            code(validate_pricing("USD", Some(0), false)).as_deref(),
            Some("payments.rate_invalid")
        );
        assert_eq!(
            code(validate_pricing("usd", Some(720), false)).as_deref(),
            Some("payments.currency_invalid")
        );
        assert_eq!(rate_field(&serde_json::json!({})).ok(), Some(None));
        assert_eq!(
            rate_field(&serde_json::json!({"rate_cents": "720"})).ok(),
            Some(Some(720))
        );
        assert_eq!(
            rate_field(&serde_json::json!({"rate_cents": 720})).ok(),
            Some(Some(720))
        );
        assert_eq!(
            rate_field(&serde_json::json!({"rate_cents": ""})).ok(),
            Some(None)
        );
        assert!(rate_field(&serde_json::json!({"rate_cents": "x"})).is_err());
        assert!(rate_field(&serde_json::json!({"rate_cents": 7.5})).is_err());
    }

    #[test]
    fn bases_links_and_stamps() {
        let off = ["https://a-api.coinpayments.net"];
        assert_eq!(
            api_base("https://a-api.coinpayments.net/", &off).as_deref(),
            Some("https://a-api.coinpayments.net")
        );
        assert_eq!(
            api_base("http://127.0.0.1:8080/", &off).as_deref(),
            Some("http://127.0.0.1:8080")
        );
        for bad in [
            "https://evil.example",
            "http://example.com",
            "http://127.0.0.1:8080/x",
            "http://user@127.0.0.1:8080",
            "https://a-api.coinpayments.net/api",
            "ftp://127.0.0.1",
            "",
        ] {
            assert_eq!(api_base(bad, &off), None, "{bad}");
        }
        assert_eq!(
            host_of("http://127.0.0.1:81").as_deref(),
            Some("127.0.0.1:81")
        );
        assert!(link_ok("https://checkout.example/pay/1"));
        assert!(link_ok("http://127.0.0.1:9/x"));
        for bad in [
            "http://pay.example/x",
            "javascript:alert(1)",
            "https://a b/",
            "https://u:p@pay.example/",
            "/relative",
            &format!("https://pay.example/{}", "a".repeat(MAX_LINK)),
        ] {
            assert!(!link_ok(bad), "{bad}");
        }
        assert_eq!(utc_stamp(1_772_332_200), "2026-03-01T02:30:00");
        assert_eq!(parse_utc_stamp("2026-03-01T02:30:00"), Some(1_772_332_200));
        assert_eq!(parse_utc_stamp("2026-03-01T02:30:00Z"), None);
        assert_eq!(parse_utc_stamp("2026-03-01 02:30:00"), None);
        assert_eq!(fingerprint("d", "s").len(), 16);
        assert_ne!(fingerprint("d", "s"), fingerprint("d2", "s"));
        assert!(token_ok("abc-123", 16) && !token_ok("a b", 16) && !token_ok("", 16));
        assert_eq!(
            id_text(Some(&serde_json::json!(5057))).as_deref(),
            Some("5057")
        );
        assert_eq!(
            id_text(Some(&serde_json::json!("5057"))).as_deref(),
            Some("5057")
        );
        assert_eq!(id_text(Some(&serde_json::json!(5.5))), None);
    }

    #[tokio::test]
    async fn reads_retry_transient_failures_only() {
        let calls = std::sync::atomic::AtomicU32::new(0);
        let r: Result<u32, CallError> = read_with_retries(|| async {
            let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n < 2 {
                Err(CallError::Status(503))
            } else {
                Ok(n)
            }
        })
        .await;
        assert_eq!(r.ok(), Some(2));
        let calls = std::sync::atomic::AtomicU32::new(0);
        let r: Result<u32, CallError> = read_with_retries(|| async {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(CallError::Status(401))
        })
        .await;
        assert!(matches!(r, Err(CallError::Status(401))));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
