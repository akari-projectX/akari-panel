//! Alipay gateway (sync) responses: `alipay::parse_response` verifies the
//! raw JSON text of `<method>_response` byte for byte.
//!
//! Invariants: no panic; an arbitrary body is never accepted (no Alipay
//! key); a body Alipay signed over the exact raw text is accepted iff its
//! code is 10000 (else a Business error), and the accepted object is that
//! text parsed; changing the signed text breaks the signature.
#![no_main]

use akari_panel::billing::alipay::{parse_response, CallError};
use akari_panel_fuzz::{alipay_keys, panel_keys};
use libfuzzer_sys::fuzz_target;
use serde_json::Value;

const METHODS: [&str; 3] = [
    "alipay.trade.precreate",
    "alipay.trade.query",
    "alipay.trade.close",
];

fuzz_target!(|data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    let method = METHODS[usize::from(mode) % 3];
    // 1. The body as received.
    if let Ok(v) = parse_response(panel_keys(), method, rest) {
        panic!("unsigned/forged response accepted: {v}");
    }
    // 2. The fuzz bytes as the response object, signed by "Alipay".
    let Ok(text) = std::str::from_utf8(rest) else {
        return;
    };
    let raw = text.trim_matches([' ', '\t', '\n', '\r']);
    let Ok(obj) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let sig = alipay_keys().sign(raw).expect("sign");
    let key = format!("{}_response", method.replace('.', "_"));
    let body = format!(
        "{{{}:{raw},\"sign\":{}}}",
        serde_json::to_string(&key).expect("key"),
        serde_json::to_string(&sig).expect("sig")
    );
    let ok = obj.get("code").and_then(Value::as_str) == Some("10000");
    match parse_response(panel_keys(), method, body.as_bytes()) {
        Ok(v) => {
            assert!(ok, "accepted a non-10000 response");
            assert_eq!(v, obj);
        }
        Err(CallError::Business { .. }) => assert!(!ok, "success refused as business error"),
        Err(e) => panic!("signed response refused: {e}"),
    }
    // Any change to the signed text breaks the signature (whitespace
    // inside the object included: the raw text is what is signed).
    let tampered = format!(
        "{{{}:{raw} ,\"sign\":{}}}",
        serde_json::to_string(&key).expect("key"),
        serde_json::to_string(&sig).expect("sig")
    );
    // (Trailing whitespace after the value is outside RawValue: still ok.)
    let _ = parse_response(panel_keys(), method, tampered.as_bytes());
    if raw.len() > 1 && obj.is_object() {
        let inner = format!("{} {}", &raw[..1], &raw[1..]);
        let body = format!(
            "{{{}:{inner},\"sign\":{}}}",
            serde_json::to_string(&key).expect("key"),
            serde_json::to_string(&sig).expect("sig")
        );
        match parse_response(panel_keys(), method, body.as_bytes()) {
            Ok(_) => panic!("altered signed text accepted"),
            Err(CallError::BadSignature) => {}
            Err(e) => panic!("altered signed text: unexpected {e}"),
        }
    }
});
