//! W26: the protocol capability manifest parser (`proto/protocols.toml`,
//! `protocols::manifest_def`, also run by build.rs) and the generators fed
//! by what it accepts.
//!
//! Invariants: no panic; parsing is deterministic; an accepted manifest
//! passes `validate` again, every scenario it lists is a legal combination
//! (no rule broken, transport/security accepted by its protocol), and the
//! generated docs matrix renders and names every protocol.
#![no_main]

use akari_panel::protocols::generate::deploy_matrix;
use akari_panel::protocols::manifest_def::{parse, validate, violated_rule};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(src) = std::str::from_utf8(data) else {
        return;
    };
    let verdict = parse(src);
    assert_eq!(
        parse(src).is_ok(),
        verdict.is_ok(),
        "parse is deterministic"
    );
    let Ok(m) = verdict else {
        return;
    };
    validate(&m).expect("an accepted manifest validates again");
    for s in &m.scenario {
        let p = m
            .protocol
            .iter()
            .find(|p| p.id == s.protocol)
            .expect("scenario protocol");
        assert!(p.transports.contains(&s.transport) && p.security.contains(&s.security));
        assert!(
            violated_rule(&m, &s.protocol, &s.transport, &s.security, &s.options, true).is_none()
        );
    }
    let doc = deploy_matrix(&m);
    for p in &m.protocol {
        assert!(doc.contains(&p.label), "docs name every protocol");
    }
});
