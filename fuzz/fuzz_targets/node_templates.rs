//! Node inbound templates (`nodetpl`): the admin's template request
//! (serde, deny_unknown_fields) rendered into xray inbounds.
//!
//! Invariants: no panic; what the templates render is always accepted by
//! `validate_inbounds` (the panel never produces a configuration it would
//! refuse) and every rendered managed inbound is issuable.
#![no_main]

use akari_panel::fuzzing::validate_inbounds;
use akari_panel::nodetpl::{RenderReq, needs_certificate, node_tls_domain, render};
use akari_panel::protocols;
use libfuzzer_sys::fuzz_target;
use serde_json::Value;

fuzz_target!(|data: &[u8]| {
    let Ok(req) = serde_json::from_slice::<RenderReq>(data) else {
        return;
    };
    let domain = match req.tls_domain.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => match node_tls_domain(d) {
            Ok(d) => Some(d),
            Err(_) => return,
        },
        _ => None,
    };
    let Ok(inbounds) = render(&req.templates, &req.taken_ports, domain.as_deref()) else {
        return;
    };
    for p in &req.taken_ports {
        assert!(
            !inbounds.iter().any(
                |i| i.get("port").and_then(Value::as_u64) == Some(u64::from(*p))
                    && protocols::l4(i).0
            ),
            "rendered TCP inbound on a taken port {p}"
        );
    }
    let arr = Value::Array(inbounds.clone());
    if let Err(e) = validate_inbounds(&arr) {
        panic!("rendered templates refused: {e}\n{arr:#}");
    }
    let _ = needs_certificate(&arr);
    for i in &inbounds {
        if protocols::MANAGED.contains(&protocols::protocol(i)) {
            assert!(protocols::issuable(i), "rendered inbound not issuable: {i}");
        }
    }
});
