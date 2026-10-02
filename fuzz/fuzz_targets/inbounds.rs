//! Admin-supplied inbounds JSON (`api::validate_inbounds`, the W8
//! protocol matrix in `protocols.rs`) and what the panel derives from an
//! accepted configuration: per-protocol accounts and the three
//! subscription formats (`sub::render`).
//!
//! Invariants: no panic; every inbound of an accepted array passes
//! `check_inbound` and has no port clash; a freshly generated account
//! needs no refit; subscriptions render, the sing-box one is valid JSON,
//! and validation is deterministic (re-validating the re-serialized
//! value gives the same verdict).
#![no_main]

use akari_panel::fuzzing::validate_inbounds;
use akari_panel::protocols;
use akari_panel::sub::{render, NodeRow};
use libfuzzer_sys::fuzz_target;
use serde_json::{json, Value};

fuzz_target!(|data: &[u8]| {
    let Ok(v) = serde_json::from_slice::<Value>(data) else {
        return;
    };
    let verdict = validate_inbounds(&v);
    let again: Value = serde_json::from_str(&v.to_string()).expect("re-parse");
    assert_eq!(validate_inbounds(&again).is_ok(), verdict.is_ok());
    if verdict.is_err() {
        // Still must not panic on rejected shapes.
        if let Some(items) = v.as_array() {
            let _ = protocols::port_clash(items);
            for i in items {
                let _ = protocols::check_inbound(i);
                let _ = protocols::issuable(i);
                let _ = protocols::l4(i);
            }
        }
        return;
    }
    let items = v.as_array().expect("accepted inbounds are an array");
    assert!(protocols::port_clash(items).is_none());
    let mut creds = Vec::new();
    for i in items {
        protocols::check_inbound(i).expect("accepted inbound re-checks");
        if !protocols::issuable(i) {
            continue;
        }
        let account = protocols::generate_account(i).expect("issuable inbound gets an account");
        assert_eq!(
            protocols::refit_account(i, &account),
            None,
            "fresh account does not fit its inbound"
        );
        creds.push(json!({
            "inbound_tag": i.get("tag").and_then(Value::as_str).expect("tag"),
            "protocol": protocols::protocol(i),
            "account": account,
        }));
    }
    let row = NodeRow {
        name: "fuzz".into(),
        xray_inbounds: v.clone(),
        server_addr: Some("node.example.com".into()),
        credentials: Value::Array(creds),
        display_name: None,
        tags: vec!["t".into()],
        connect_overrides: json!({}),
    };
    let rows = [row];
    let (_, sing) = render("sing-box 1.12", &rows);
    serde_json::from_str::<Value>(sing.trim()).expect("sing-box subscription is JSON");
    let _ = render("clash-verge/mihomo", &rows);
    let _ = render("v2rayN", &rows);
});
