//! Remote rule-sets (routing PR 2): `sub::rulesets::parse` reads lists
//! downloaded from operator-supplied links (any bytes a remote host
//! serves), and the SSRF guard's address classifier and URL policy.
//!
//! Invariants: no panic; the counts add up (kept = rules, total = kept +
//! unsupported, at most 16 unsupported type names); no duplicate rules;
//! every kept value is non-empty ASCII without whitespace, commas or
//! quotes, domains are lowercase, networks are already normalized (re-parse
//! to themselves); the sing-box source rule-set is version 3 and carries
//! exactly the kept rules; an accepted list has a rule and no more junk
//! than rules. An IPv4 address and its IPv4-mapped IPv6 form are
//! classified alike; a URL the policy accepts is https.
#![no_main]

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr};

use akari_panel::outbound::public_address;
use akari_panel::sub::rulesets::parse::{RuleKind, check, cidr, parse, source_json};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if data.len() >= 4 {
        let v4 = Ipv4Addr::new(data[0], data[1], data[2], data[3]);
        assert_eq!(
            public_address(IpAddr::V4(v4)),
            public_address(IpAddr::V6(v4.to_ipv6_mapped())),
            "{v4}"
        );
    }
    if data.len() >= 16 {
        let mut b = [0u8; 16];
        b.copy_from_slice(&data[..16]);
        let _ = public_address(IpAddr::from(b));
    }
    let text = String::from_utf8_lossy(data);
    if akari_panel::fuzzing::rule_set_target_ok(&text) {
        assert!(
            text.get(..8)
                .is_some_and(|s| s.eq_ignore_ascii_case("https://")),
            "{text}"
        );
    }
    let p = parse(&text);
    let c = &p.counts;
    assert_eq!(c.kept(), p.rules.len());
    assert_eq!(c.total, c.kept() + c.unsupported);
    assert!(c.unsupported_types.len() <= 16);
    assert!(c.unsupported_types.values().sum::<usize>() <= c.unsupported);
    let mut seen = HashSet::new();
    for r in &p.rules {
        assert!(seen.insert((r.kind, r.value.clone())), "duplicate {r:?}");
        let v = r.value.as_str();
        assert!(!v.is_empty() && v.is_ascii(), "{r:?}");
        assert!(
            !v.chars()
                .any(|ch| ch.is_whitespace() || matches!(ch, ',' | '"' | '\'' | '#')),
            "{r:?}"
        );
        match r.kind {
            RuleKind::IpCidr => assert_eq!(cidr(v).as_deref(), Some(v), "not normalized"),
            _ => assert_eq!(v, v.to_ascii_lowercase()),
        }
    }
    let sj = source_json(&p.rules);
    assert_eq!(sj["version"], 3);
    let carried: usize = sj["rules"]
        .as_array()
        .expect("rules array")
        .iter()
        .flat_map(|r| r.as_object().expect("rule object").values())
        .map(|v| v.as_array().expect("value list").len())
        .sum();
    assert_eq!(carried, p.rules.len());
    if check(&p).is_ok() {
        assert!(c.total > 0 && c.invalid <= c.total);
    }
});
