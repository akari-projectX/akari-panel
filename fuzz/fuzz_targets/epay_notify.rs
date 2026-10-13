//! C1: 易支付 (EPay) — the notify (GET query string or POST form) through
//! `Epay::check_notify`, and the gateway answers (`parse_create`,
//! `parse_query`) on attacker bytes.
//!
//! Input: first byte = mode; the rest is the body.
//!
//! Invariants: no panic; nothing verifies without the merchant key; a map
//! the merchant key signed verifies after the wire round trip (and is
//! Verified when it carries our pid and an out_trade_no, with exactly the
//! amount `money` says); changing any signed non-empty value afterwards, or
//! `sign_type` ≠ MD5, breaks it; a payment link taken from a create answer
//! is http(s) and fits the order column; a query answer is never "paid"
//! unless it says code 1 and status 1.
#![no_main]

use std::collections::BTreeMap;

use akari_panel::billing::alipay::parse_amount;
use akari_panel::billing::epay::{
    Channel, Epay, MAX_LINK, Mode, Params, parse_create, parse_query, sign, verify,
};
use akari_panel::billing::provider::{Checkout, NotifyCheck, Query};
use akari_panel::fuzzing::{ALIPAY_MAX_NOTIFY_PARAMS, alipay_parse_form};
use libfuzzer_sys::fuzz_target;

const PID: &str = "1001";
const KEY: &str = "89unJUB8HZ54Hj7x4nUj56HN4nUzUJ8i";

fn client() -> Epay {
    Epay::new(
        Params {
            api_url: "https://pay.example/".into(),
            pid: PID.into(),
            channel: Channel::Alipay,
            mode: Mode::Api,
            product_name: None,
            order_timeout_minutes: 15,
        },
        KEY.into(),
    )
}

fn encode(p: &BTreeMap<String, String>) -> String {
    let mut s = form_urlencoded::Serializer::new(String::new());
    for (k, v) in p {
        s.append_pair(k, v);
    }
    s.finish()
}

fuzz_target!(|data: &[u8]| {
    let Some((&mode, body)) = data.split_first() else {
        return;
    };
    let e = client();
    // Gateway answers: no panic, links bounded, "paid" only when said.
    if let Ok(Some(Checkout::Redirect(u))) = parse_create(body) {
        let l = u.to_ascii_lowercase();
        assert!(l.starts_with("https://") || l.starts_with("http://"), "{u}");
        assert!(u.len() <= MAX_LINK);
    }
    if let Ok(Query::Trade { paid: true, .. }) = parse_query(body, PID, "AK1") {
        let v: serde_json::Value = serde_json::from_slice(body).expect("parsed JSON");
        let one = |k: &str| match &v[k] {
            serde_json::Value::Number(n) => n.as_i64() == Some(1),
            serde_json::Value::String(s) => s.trim().parse::<i64>().ok() == Some(1),
            _ => false,
        };
        assert!(
            one("code") && one("status"),
            "paid without code 1 / status 1"
        );
    }
    // A forged notify never verifies.
    let verdict = e.check_notify(body);
    if let NotifyCheck::Verified(_) = verdict {
        panic!("forged notify verified");
    }
    let Some(p) = alipay_parse_form(body) else {
        return;
    };
    assert!(p.len() <= ALIPAY_MAX_NOTIFY_PARAMS);
    assert!(!verify(&p, "another key"), "verified under a guessed key");
    if mode & 1 == 0 {
        return;
    }
    // Merchant-signed: sign what the fuzzer decoded, send it over the wire.
    let mut q = p;
    q.remove("sign");
    if mode & 2 != 0 {
        q.insert("pid".into(), PID.into());
    }
    q.insert("sign_type".into(), "MD5".into());
    let s = sign(&q, KEY);
    q.insert("sign".into(), s);
    if q.len() > ALIPAY_MAX_NOTIFY_PARAMS {
        return;
    }
    let wire = encode(&q);
    let back = alipay_parse_form(wire.as_bytes()).expect("signed form decodes");
    assert!(verify(&back, KEY), "genuine notify refused");
    match e.check_notify(wire.as_bytes()) {
        NotifyCheck::Verified(ev) => {
            assert_eq!(back.get("pid").map(String::as_str), Some(PID));
            assert_eq!(Some(&ev.out_trade_no), back.get("out_trade_no"));
            assert_eq!(
                ev.total_cents,
                back.get("money").and_then(|m| parse_amount(m))
            );
            assert_eq!(
                ev.paid,
                back.get("trade_status").map(String::as_str) == Some("TRADE_SUCCESS")
            );
        }
        NotifyCheck::Rejected {
            verified, reason, ..
        } => {
            assert!(verified, "genuine notify refused as {reason}");
        }
    }
    // Tamper with one signed, non-empty value: must no longer verify.
    let victim = back
        .iter()
        .filter(|(k, v)| k.as_str() != "sign" && k.as_str() != "sign_type" && !v.is_empty())
        .map(|(k, _)| k.clone())
        .nth(usize::from(mode >> 2));
    if let Some(k) = victim {
        let mut t = back.clone();
        t.get_mut(&k).expect("key").push('0');
        assert!(!verify(&t, KEY), "tampered notify verified ({k})");
    }
    let mut t = back;
    t.insert("sign_type".into(), "RSA".into());
    assert!(!verify(&t, KEY));
});
