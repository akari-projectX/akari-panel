//! An admin-supplied node inbound (`api::normalize_inbound`, D2: one object
//! per node; the W8 protocol matrix in `protocols.rs`) and what the panel
//! derives from an accepted one: an account and the three subscription
//! formats (`sub::render`).
//!
//! Invariants: no panic; an accepted inbound has no tag (the panel names
//! inbounds), passes `check_inbound` and has no object (at any depth) with
//! two keys equal under Go's case folding (xray decodes keys
//! case-insensitively, W14); normalizing is idempotent; a freshly generated
//! account needs no refit; subscriptions render, the sing-box one is valid
//! JSON, and validation is deterministic (re-validating the re-serialized
//! value gives the same verdict).
#![no_main]

use akari_panel::fuzzing::normalize_inbound;
use akari_panel::protocols;
use akari_panel::sub::{NodeRow, render};
use libfuzzer_sys::fuzz_target;
use serde_json::Value;

fuzz_target!(|data: &[u8]| {
    let Ok(v) = serde_json::from_slice::<Value>(data) else {
        return;
    };
    let verdict = normalize_inbound(&v);
    let again: Value = serde_json::from_str(&v.to_string()).expect("re-parse");
    assert_eq!(normalize_inbound(&again).is_ok(), verdict.is_ok());
    let Ok(ib) = verdict else {
        // Still must not panic on rejected shapes.
        if let Some(items) = v.as_array() {
            let _ = protocols::port_clash(items);
        }
        let _ = protocols::check_inbound(&v);
        let _ = protocols::issuable(&v);
        let _ = protocols::l4(&v);
        return;
    };
    assert!(ib.get("tag").is_none(), "stored with a tag");
    assert_eq!(normalize_inbound(&ib).as_ref(), Ok(&ib), "not idempotent");
    protocols::check_inbound(&ib).expect("accepted inbound re-checks");
    assert_eq!(
        protocols::case_fold_duplicate(&ib),
        None,
        "accepted inbound has keys that alias in xray"
    );
    if !protocols::issuable(&ib) {
        return;
    }
    let account = protocols::generate_account(&ib).expect("issuable inbound gets an account");
    assert_eq!(
        protocols::refit_account(&ib, &account),
        None,
        "fresh account does not fit its inbound"
    );
    let rows = [NodeRow {
        name: "fuzz".into(),
        display_name: None,
        tags: vec!["t".into()],
        entrance: "直连".into(),
        protocol: protocols::protocol(&ib).to_string(),
        inbound: ib,
        server: Some("node.example.com".into()),
        port: None,
        account,
    }];
    let (_, sing) = render("sing-box 1.12", &rows);
    serde_json::from_str::<Value>(sing.trim()).expect("sing-box subscription is JSON");
    let _ = render("clash-verge/mihomo", &rows);
    let _ = render("v2rayN", &rows);
});
