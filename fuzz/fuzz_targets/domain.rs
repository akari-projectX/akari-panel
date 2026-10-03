//! Domain settings (R22): `settings::Domain::parse` (admin input, IDN),
//! `settings::request_host` (attacker Host headers, the host gate) and the
//! Cloudflare range list parser.
//!
//! Invariants: no panic; an accepted domain is ASCII (punycode), lowercase,
//! <= 253 bytes, without trailing dot, and parses back to itself from its
//! stored authority; the Host header a client would send for it reduces
//! (request_host) to exactly the stored host, so the host gate admits it.
#![no_main]

use akari_panel::cloudflare::parse_list;
use akari_panel::settings::{Domain, request_host};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let s = String::from_utf8_lossy(data);
    let _ = request_host(&s);
    let _ = parse_list(&s);
    let Ok(d) = Domain::parse(&s) else {
        return;
    };
    assert!(d.host.is_ascii(), "{:?}", d.host);
    assert!(!d.host.ends_with('.'));
    assert!(d.host.len() <= 253);
    if !d.is_ip() {
        assert_eq!(d.host, d.host.to_ascii_lowercase());
    }
    assert_ne!(d.port, Some(0));
    let back = Domain::parse(&d.authority()).expect("stored authority re-parses");
    assert_eq!(back, d, "authority round trip");
    assert_eq!(request_host(&d.authority()), d.host, "host gate mismatch");
    // What people read (IDN in Unicode) means the same domain.
    let shown = Domain::parse(&d.display()).expect("display re-parses");
    assert_eq!(shown, d, "display round trip");
    let _ = d.https_origin();
});
