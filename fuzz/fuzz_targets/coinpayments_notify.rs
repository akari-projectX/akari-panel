//! CoinPayments — the webhook through `CoinPayments::check_notify` and the
//! gateway answers (`parse_create`, `pick_invoice`, `facts`) on attacker bytes.
//!
//! Input: first byte = mode; the rest is the body.
//!
//! Invariants: no panic; nothing verifies without the client secret (no
//! headers, a signature of another secret, a body changed after signing, an
//! old timestamp); a genuinely signed fresh body is never refused as a bad
//! signature; a verified event is `paid` only for an `InvoiceCompleted` event
//! of an invoice in state `Completed`, and carries an amount only when the
//! invoice's currency id and total equal what the pricing computes from the
//! order cents it echoes, read as an integer (other events only name the
//! order); a create answer's link is http(s) and fits the order
//! column; an invoice id picked from a list is safe in a request path.
#![no_main]

use akari_panel::billing::coinpayments::{
    CoinPayments, Params, facts, parse_create, pick_invoice, signature, signing_message,
};
use akari_panel::billing::crypto::{AmountFormat, MAX_LINK, Pricing, utc_stamp};
use akari_panel::billing::provider::{Checkout, NotifyCheck, NotifyRequest};
use http::{HeaderMap, HeaderValue};
use libfuzzer_sys::fuzz_target;
use serde_json::Value;

const CLIENT: &str = "4f8b9d2e-1234-5678-9abc-def012345678";
const SECRET: &str = "fuzz-client-secret";
const URL: &str = "https://panel.example/pay/9b0e5f2a-0000-4000-8000-000000000001/notify";
const NOW: i64 = 1_792_000_000;
const CURRENCY_ID: &str = "5057";

fn pricing() -> Pricing {
    Pricing::new("USD", Some(720)).expect("a valid static pricing")
}

fn client() -> CoinPayments {
    CoinPayments::new(
        Params {
            base: "https://a-api.coinpayments.net".into(),
            client_id: CLIENT.into(),
            currency_id: CURRENCY_ID.into(),
            pricing: pricing(),
            order_timeout_minutes: 60,
        },
        SECRET.into(),
    )
}

fn headers(body: &str, ts: i64, secret: &str) -> HeaderMap {
    let stamp = utc_stamp(ts);
    let message = signing_message("POST", URL, CLIENT, &stamp, body);
    let mut h = HeaderMap::new();
    h.insert("x-coinpayments-client", HeaderValue::from_static(CLIENT));
    h.insert(
        "x-coinpayments-timestamp",
        HeaderValue::from_str(&stamp).expect("a plain timestamp"),
    );
    h.insert(
        "x-coinpayments-signature",
        HeaderValue::from_str(&signature(secret, &message)).expect("base64"),
    );
    h
}

fn check(c: &CoinPayments, body: &[u8], h: &HeaderMap) -> NotifyCheck {
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
    let c = client();
    // Gateway answers.
    if let Ok(Checkout::Redirect(u)) = parse_create(body) {
        let l = u.to_ascii_lowercase();
        assert!(l.starts_with("https://") || l.starts_with("http://"), "{u}");
        assert!(u.len() <= MAX_LINK);
    }
    if let Ok(Some(id)) = pick_invoice(body, "AK1") {
        assert!(
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "{id}"
        );
    }
    if let Ok(v) = serde_json::from_slice::<Value>(body) {
        let _ = facts(&v);
    }
    // Nothing verifies without the secret.
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
    // Signed with the real secret, fresh: never a bad signature.
    let good = headers(text, NOW, SECRET);
    match check(&c, body, &good) {
        NotifyCheck::Verified(ev) => {
            let v: Value = serde_json::from_str(text).expect("verified bodies are JSON");
            let kind = v["type"].as_str().unwrap_or_default().to_ascii_lowercase();
            let inv = &v["invoice"];
            let state = inv["status"]
                .as_str()
                .or_else(|| inv["state"].as_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if ev.paid {
                assert_eq!(kind, "invoicecompleted");
                assert_eq!(state, "completed");
            }
            if let Some(cents) = ev.total_cents {
                // Every event names its order's cents as echoed; a payment
                // additionally needs the exact invoice currency and total.
                let echoed = &inv["customData"]["akari_cents"];
                assert_eq!(
                    echoed
                        .as_str()
                        .and_then(|c| c.parse::<i64>().ok())
                        .or_else(|| echoed.as_i64()),
                    Some(cents)
                );
                if ev.paid {
                    let total = inv["amount"]["total"].as_str().expect("an amount");
                    assert!(pricing().matches(cents, total, AmountFormat::Dotted));
                    assert!(total.contains('.'), "an integer-looking amount was trusted");
                    let id = &inv["amount"]["currencyId"];
                    assert!(
                        id.as_i64().map(|n| n.to_string()).as_deref() == Some(CURRENCY_ID)
                            || id.as_str() == Some(CURRENCY_ID)
                    );
                }
            }
        }
        NotifyCheck::Rejected {
            verified, reason, ..
        } => {
            assert!(verified, "a genuine webhook refused as {reason}");
        }
    }
    // An old timestamp is a replay even with a genuine signature.
    let old = headers(text, NOW - 3600, SECRET);
    assert!(matches!(
        check(&c, body, &old),
        NotifyCheck::Rejected {
            reason: "stale_timestamp",
            ..
        }
    ));
    // One changed byte after signing breaks it.
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
