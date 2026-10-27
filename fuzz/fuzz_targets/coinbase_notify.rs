//! Coinbase — the webhook through `Coinbase::check_notify`, the signature
//! header parser, the API key parser and the gateway answers (`parse_create`,
//! `pick_checkout`, `facts`, `error_class`) on attacker bytes.
//!
//! Input: first byte = mode; the rest is the body.
//!
//! Invariants: no panic; nothing verifies without the webhook secret (no
//! headers, a signature of another secret, a body changed after signing, an
//! old timestamp); a genuinely signed fresh body is never refused as a bad
//! signature; a verified event is `paid` only for a `checkout.payment.success`
//! event of a COMPLETED checkout whose echoed fiat currency and amount equal
//! what the pricing computes from the order cents in the metadata (other
//! events only name the order); a checkout id picked from a list is 24 hex digits;
//! an error body is classified by a fixed word.
#![no_main]

use akari_panel::billing::coinbase::{
    Coinbase, Params, Signer, error_class, facts, parse_create, parse_signature_header,
    pick_checkout, signed_payload, webhook_signature,
};
use akari_panel::billing::crypto::{AmountFormat, MAX_LINK, Pricing};
use akari_panel::billing::provider::{Checkout, NotifyCheck, NotifyRequest};
use http::{HeaderMap, HeaderValue};
use libfuzzer_sys::fuzz_target;
use serde_json::Value;

const SECRET: &str = "fuzz-webhook-secret";
const URL: &str = "https://panel.example/pay/9b0e5f2a-0000-4000-8000-000000000002/notify";
const NOW: i64 = 1_792_000_000;

/// A fixed Ed25519 secret in the CDP format, base64(seed ‖ public key); only
/// the API client's construction needs it.
fn ed25519_secret() -> String {
    use base64::Engine as _;
    use ring::signature::KeyPair as _;
    let seed = [1u8; 32];
    let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&seed).expect("a 32-byte seed");
    let mut raw = seed.to_vec();
    raw.extend_from_slice(pair.public_key().as_ref());
    base64::engine::general_purpose::STANDARD.encode(raw)
}

fn pricing() -> Pricing {
    Pricing::new("USD", Some(720)).expect("a valid static pricing")
}

fn client() -> Option<Coinbase> {
    Some(Coinbase::new(
        Params {
            base: "https://business.coinbase.com".into(),
            key_id: "key".into(),
            pricing: pricing(),
            order_timeout_minutes: 60,
        },
        Signer::parse(&ed25519_secret()).ok()?,
        SECRET.into(),
    ))
}

fn headers(body: &str, t: i64, secret: &str) -> HeaderMap {
    let payload = signed_payload(
        &t.to_string(),
        "content-type",
        &["application/json".into()],
        body,
    );
    let mut h = HeaderMap::new();
    h.insert("content-type", HeaderValue::from_static("application/json"));
    h.insert(
        "x-webhook-signature",
        HeaderValue::from_str(&format!(
            "t={t},h=content-type,v1={}",
            webhook_signature(secret, &payload)
        ))
        .expect("an ASCII header"),
    );
    h
}

fn check(c: &Coinbase, body: &[u8], h: &HeaderMap) -> NotifyCheck {
    c.check_notify(&NotifyRequest {
        body,
        headers: h,
        url: Some(URL),
        now_unix: NOW,
    })
}

fuzz_target!(|data: &[u8]| {
    let Some((&mode, body)) = data.split_first() else {
        return;
    };
    // Parsers of attacker or operator text: no panic, slices of the input.
    if let Ok(s) = std::str::from_utf8(body) {
        if let Some((t, h, v1)) = parse_signature_header(s) {
            assert!(s.contains(t) && s.contains(h) && s.contains(v1));
        }
        if s.len() < 8192 {
            let _ = Signer::parse(s);
        }
    }
    if let Ok(Checkout::Redirect(u)) = parse_create(body) {
        let l = u.to_ascii_lowercase();
        assert!(l.starts_with("https://") || l.starts_with("http://"), "{u}");
        assert!(u.len() <= MAX_LINK);
    }
    if let Ok(Some(id)) = pick_checkout(body, "AK1") {
        assert!(id.len() == 24 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    }
    if let Ok(v) = serde_json::from_slice::<Value>(body) {
        let _ = facts(&v);
    }
    assert!(!error_class(body).is_empty());
    let Some(c) = client() else {
        return;
    };
    let text = String::from_utf8_lossy(body).into_owned();
    for h in [HeaderMap::new(), headers(&text, NOW, "another secret")] {
        assert!(
            matches!(check(&c, body, &h), NotifyCheck::Rejected { .. }),
            "forged webhook verified"
        );
    }
    let Ok(text) = std::str::from_utf8(body) else {
        return;
    };
    if mode & 1 == 0 {
        return;
    }
    let good = headers(text, NOW, SECRET);
    match check(&c, body, &good) {
        NotifyCheck::Verified(ev) => {
            let v: Value = serde_json::from_str(text).expect("verified bodies are JSON");
            if ev.paid {
                assert_eq!(v["eventType"].as_str(), Some("checkout.payment.success"));
                assert_eq!(
                    v["status"].as_str().map(str::to_ascii_uppercase).as_deref(),
                    Some("COMPLETED")
                );
            }
            if let Some(cents) = ev.total_cents {
                assert_eq!(
                    v["metadata"]["akari_cents"].as_str(),
                    Some(cents.to_string()).as_deref()
                );
                if ev.paid {
                    assert_eq!(v["fiatCurrency"].as_str(), Some("USD"));
                    assert!(pricing().matches(
                        cents,
                        v["fiatAmount"].as_str().expect("an amount"),
                        AmountFormat::Plain
                    ));
                }
            }
        }
        NotifyCheck::Rejected {
            verified, reason, ..
        } => {
            assert!(verified, "a genuine webhook refused as {reason}");
        }
    }
    let old = headers(text, NOW - 3600, SECRET);
    assert!(matches!(
        check(&c, body, &old),
        NotifyCheck::Rejected {
            reason: "stale_timestamp",
            ..
        }
    ));
    if mode & 2 != 0 && !body.is_empty() {
        let mut t = body.to_vec();
        let i = usize::from(mode >> 2) % t.len();
        t[i] ^= 0x01;
        if std::str::from_utf8(&t).is_ok() {
            assert!(
                matches!(
                    check(&c, &t, &good),
                    NotifyCheck::Rejected {
                        verified: false,
                        ..
                    }
                ),
                "a changed body verified"
            );
        }
    }
});
