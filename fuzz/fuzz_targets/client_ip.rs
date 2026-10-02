//! Client address behind proxies (`client_ip`): Host-independent parsing
//! of X-Forwarded-For / CF-Connecting-IP from attacker-controlled headers,
//! trusted-proxy CIDRs (`Cidr::parse`) and the Cloudflare range list.
//!
//! Input: peer address, trusted CIDRs, Cloudflare CIDRs, then header lines
//! (`name: value`), separated by 0xFF.
//!
//! Invariants: no panic; an untrusted peer is always the answer; the answer
//! is the peer, one of the X-Forwarded-For hops, or CF-Connecting-IP — and
//! CF-Connecting-IP only when "trust Cloudflare" ranges are set; a parsed
//! CIDR round-trips through Display and contains its own network address.
#![no_main]

use std::net::IpAddr;

use akari_panel::client_ip::{bucket, canonical, resolve, Cidr, Trust};
use akari_panel_fuzz::fields;
use http::{HeaderMap, HeaderName, HeaderValue};
use libfuzzer_sys::fuzz_target;

fn cidrs(s: &str) -> Vec<Cidr> {
    let mut out = Vec::new();
    for part in s.split(',').take(8) {
        if let Ok(c) = Cidr::parse(part) {
            let again = Cidr::parse(&c.to_string()).expect("Display re-parses");
            assert_eq!(again, c);
            let net: IpAddr = c
                .to_string()
                .split('/')
                .next()
                .and_then(|a| a.parse().ok())
                .expect("network address");
            assert!(c.contains(net), "{c} does not contain its network");
            out.push(c);
        }
    }
    out
}

fuzz_target!(|data: &[u8]| {
    let f = fields(data, 4);
    let peer: IpAddr = match f.first().map(|s| s.trim().parse()) {
        Some(Ok(ip)) => ip,
        _ => "10.0.0.1".parse().expect("ip"),
    };
    let proxies = f.get(1).map(|s| cidrs(s)).unwrap_or_default();
    let cloudflare = f.get(2).map(|s| cidrs(s)).unwrap_or_default();
    let mut headers = HeaderMap::new();
    let mut candidates = vec![canonical(peer)];
    for line in f
        .get(3)
        .map(String::as_str)
        .unwrap_or("")
        .split('\n')
        .take(16)
    {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let (Ok(n), Ok(v)) = (
            HeaderName::from_bytes(name.trim().as_bytes()),
            HeaderValue::from_str(value.trim()),
        ) else {
            continue;
        };
        if let Ok(text) = v.to_str()
            && (n == "x-forwarded-for" || n == "cf-connecting-ip")
        {
            // Anything an address can be parsed from in this value.
            for hop in text.split(',') {
                let hop = hop.trim();
                let bare = hop.trim_start_matches('[');
                for cand in [hop, bare.split(']').next().unwrap_or("")] {
                    if let Ok(ip) = cand.parse::<IpAddr>() {
                        candidates.push(canonical(ip));
                    }
                    if let Ok(sa) = cand.parse::<std::net::SocketAddr>() {
                        candidates.push(canonical(sa.ip()));
                    }
                }
            }
        }
        headers.append(n, v);
    }
    let trust = Trust {
        proxies: proxies.clone(),
        cloudflare: cloudflare.clone(),
    };
    let got = resolve(peer, &headers, &trust);
    let trusted = |ip: IpAddr| proxies.iter().chain(&cloudflare).any(|c| c.contains(ip));
    if !trusted(peer) {
        assert_eq!(
            got,
            canonical(peer),
            "untrusted peer's headers were believed"
        );
    }
    assert!(candidates.contains(&got), "{got} came from nowhere");
    assert_eq!(got, canonical(got));
    // Without Cloudflare trust, CF-Connecting-IP is never the source
    // (unless the same address is also the peer or an XFF hop).
    let plain = resolve(
        peer,
        &headers,
        &Trust {
            proxies,
            cloudflare: Vec::new(),
        },
    );
    let mut no_cf = headers.clone();
    no_cf.remove("cf-connecting-ip");
    assert_eq!(
        plain,
        resolve(
            peer,
            &no_cf,
            &Trust {
                proxies: trust.proxies.clone(),
                cloudflare: Vec::new(),
            }
        ),
        "CF-Connecting-IP used without Cloudflare trust"
    );
    let b = bucket(got);
    if got.is_ipv6() {
        assert!(b.ends_with("/64"));
    }
});
