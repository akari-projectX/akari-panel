//! Alipay async notify: the form decoder (`billing::api::parse_form`) and
//! signature verification (`alipay::verify_notify`) on attacker bodies.
//!
//! Invariants: no panic; at most MAX params, no duplicates (a decoded map
//! re-encodes to a body that decodes to the same map); nothing verifies
//! without Alipay's key; a map Alipay signed (either SDK convention for
//! empty values) verifies after the wire round trip, and changing any
//! non-empty signed value afterwards breaks it.
#![no_main]

use std::collections::BTreeMap;

use akari_panel::billing::alipay::{notify_sign_content, verify_notify};
use akari_panel::fuzzing::{alipay_parse_form, ALIPAY_MAX_NOTIFY_PARAMS};
use akari_panel_fuzz::{alipay_keys, panel_keys};
use libfuzzer_sys::fuzz_target;

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
    let Some(p) = alipay_parse_form(body) else {
        return;
    };
    assert!(p.len() <= ALIPAY_MAX_NOTIFY_PARAMS);
    let again = alipay_parse_form(encode(&p).as_bytes()).expect("re-encoded form decodes");
    assert_eq!(again, p, "decode is canonical");
    // Without Alipay's private key nothing verifies.
    assert!(!verify_notify(panel_keys(), &p), "forged notify verified");
    if mode & 1 == 0 {
        return;
    }
    // Alipay-signed: sign what the fuzzer decoded, send it over the wire.
    let keep_empty = mode & 2 == 0;
    let mut q = p;
    q.remove("sign");
    q.insert("sign_type".into(), "RSA2".into());
    let sig = alipay_keys()
        .sign(&notify_sign_content(&q, keep_empty))
        .expect("sign");
    q.insert("sign".into(), sig);
    if q.len() > ALIPAY_MAX_NOTIFY_PARAMS {
        return;
    }
    let wire = alipay_parse_form(encode(&q).as_bytes()).expect("signed form decodes");
    assert!(verify_notify(panel_keys(), &wire), "genuine notify refused");
    // Tamper with one signed, non-empty value: must no longer verify.
    let victim = wire
        .iter()
        .filter(|(k, v)| k.as_str() != "sign" && k.as_str() != "sign_type" && !v.is_empty())
        .map(|(k, _)| k.clone())
        .nth(usize::from(mode >> 2));
    if let Some(k) = victim {
        let mut t = wire.clone();
        t.get_mut(&k).expect("key").push('0');
        assert!(
            !verify_notify(panel_keys(), &t),
            "tampered notify verified ({k})"
        );
    }
    // A different sign_type is refused even with a valid signature.
    let mut t = wire;
    t.insert("sign_type".into(), "RSA".into());
    assert!(!verify_notify(panel_keys(), &t));
});
