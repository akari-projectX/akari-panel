//! W26: the kernel-neutral inbound model and the xray adapter
//! (`protocols::xray::{parse, parse_as, render, check, explain}`) on
//! arbitrary inbound JSON (admin-supplied or stored).
//!
//! Invariants: no panic; every fault has a non-empty explanation; one
//! render normalizes: render(parse(render(parse(x)))) == render(parse(x));
//! reading an inbound as any managed protocol renders; an inbound the
//! adapter accepts gets an account that needs no refit when its protocol
//! issues credentials, and its normalized form is accepted too.
#![no_main]

use akari_panel::protocols::{self, manifest, xray};
use libfuzzer_sys::fuzz_target;
use serde_json::Value;

fuzz_target!(|data: &[u8]| {
    let Ok(v) = serde_json::from_slice::<Value>(data) else {
        return;
    };
    let model = xray::parse(&v);
    let once = xray::render(&model);
    let twice = xray::render(&xray::parse(&once));
    assert_eq!(once, twice, "render(parse(..)) is not a normal form");
    for p in &manifest::get().protocol {
        let _ = xray::render(&xray::parse_as(&v, &p.wire));
    }
    match xray::check(&v) {
        Err(f) => assert!(!xray::explain(&f).is_empty()),
        Ok(()) => {
            if protocols::issuable(&v) {
                let acc = protocols::generate_account(&v).expect("account for an accepted inbound");
                assert_eq!(protocols::refit_account(&v, &acc), None);
            }
            if model.protocol.is_managed() {
                assert_eq!(
                    xray::check(&once),
                    Ok(()),
                    "normalized form refused: {once}"
                );
            }
        }
    }
});
