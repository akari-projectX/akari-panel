//! Node inbound templates (`nodetpl`): the admin's template request
//! (serde, deny_unknown_fields) rendered into an xray inbound (D2: one per
//! node).
//!
//! Invariants: no panic; a rendered inbound never uses a taken port; what
//! the template renders is always accepted by `normalize_inbound` (the
//! panel never produces a configuration it would refuse) unchanged (no
//! tag to drop), and a rendered managed inbound is issuable.
#![no_main]

use akari_panel::fuzzing::normalize_inbound;
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
    let Ok(inbound) = render(&req.template, &req.taken_ports, domain.as_deref()) else {
        return;
    };
    let port = inbound.get("port").and_then(Value::as_u64);
    assert!(
        !req.taken_ports.iter().any(|p| Some(u64::from(*p)) == port),
        "rendered inbound on a taken port"
    );
    match normalize_inbound(&inbound) {
        Ok(stored) => assert_eq!(stored, inbound, "a rendered inbound is stored as is"),
        Err(e) => panic!("rendered template refused: {e}\n{inbound:#}"),
    }
    let _ = needs_certificate(&Value::Array(vec![inbound.clone()]));
    if protocols::MANAGED.contains(&protocols::protocol(&inbound)) {
        assert!(
            protocols::issuable(&inbound),
            "rendered inbound not issuable: {inbound}"
        );
    }
});
