//! Client address behind reverse proxies (S4-1).
//!
//! `web.trusted_proxies` lists the CIDRs of the proxies in front of the
//! panel (default: none). X-Forwarded-For is only consulted when the TCP
//! peer itself is a trusted proxy; the client is then the rightmost hop that
//! is not a trusted proxy (everything left of it was written by the client
//! and is ignored). A request from an untrusted peer is always attributed to
//! the peer, whatever headers it carries.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use axum::http::HeaderMap;
use serde::{Deserialize, Deserializer};

/// An address block, e.g. `10.0.0.0/8`, `fd00::/8`, or a bare address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    net: IpAddr,
    prefix: u8,
}

impl Cidr {
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let (addr, prefix) = match s.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (s, None),
        };
        let net: IpAddr = addr
            .parse()
            .map_err(|_| format!("invalid address in trusted_proxies: {s:?}"))?;
        // An IPv4-mapped IPv6 block is matched as the IPv4 block it maps.
        let (net, max, shift) = match net {
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => (IpAddr::V4(v4), 32, 96),
                None => (net, 128, 0),
            },
            IpAddr::V4(_) => (net, 32, 0),
        };
        let prefix = match prefix {
            None => max,
            Some(p) => {
                let p: u8 = p
                    .parse()
                    .map_err(|_| format!("invalid prefix length in trusted_proxies: {s:?}"))?;
                let p = p.checked_sub(shift).filter(|p| *p <= max).ok_or_else(|| {
                    format!("prefix length out of range in trusted_proxies: {s:?}")
                })?;
                p
            }
        };
        if mask(net, prefix) != net {
            return Err(format!(
                "trusted_proxies entry {s:?} has host bits set (did you mean {}/{prefix}?)",
                mask(net, prefix)
            ));
        }
        Ok(Self { net, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        match (self.net, ip) {
            (IpAddr::V4(_), IpAddr::V4(_)) | (IpAddr::V6(_), IpAddr::V6(_)) => {
                mask(ip, self.prefix) == self.net
            }
            _ => false,
        }
    }
}

impl<'de> Deserialize<'de> for Cidr {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Cidr::parse(&s).map_err(serde::de::Error::custom)
    }
}

fn mask(ip: IpAddr, prefix: u8) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => {
            let bits = u32::from(v4);
            let m = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            IpAddr::V4(Ipv4Addr::from(bits & m))
        }
        IpAddr::V6(v6) => {
            let bits = u128::from(v6);
            let m = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            IpAddr::V6(Ipv6Addr::from(bits & m))
        }
    }
}

/// IPv4-mapped IPv6 (a dual-stack socket's view of an IPv4 peer) as IPv4.
pub fn canonical(ip: IpAddr) -> IpAddr {
    ip.to_canonical()
}

/// Parse one X-Forwarded-For element: a bare IPv4/IPv6 address, `[v6]`,
/// `[v6]:port` or `v4:port` (some proxies append the port).
fn parse_hop(s: &str) -> Option<IpAddr> {
    let s = s.trim();
    if let Ok(ip) = s.parse::<IpAddr>() {
        return Some(canonical(ip));
    }
    if let Ok(sa) = s.parse::<SocketAddr>() {
        return Some(canonical(sa.ip()));
    }
    let inner = s.strip_prefix('[')?.strip_suffix(']')?;
    inner
        .parse::<Ipv6Addr>()
        .ok()
        .map(|v6| canonical(IpAddr::V6(v6)))
}

/// Hops examined at most (right to left) before giving up on a chain.
const MAX_HOPS: usize = 32;

/// The client address of a request whose TCP peer is `peer`.
pub fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &[Cidr]) -> IpAddr {
    let peer = canonical(peer);
    let is_trusted = |ip: IpAddr| trusted.iter().any(|c| c.contains(ip));
    if !is_trusted(peer) {
        return peer;
    }
    // Several X-Forwarded-For header lines are one list, in order.
    let mut hops: Vec<&str> = Vec::new();
    for v in headers.get_all("x-forwarded-for") {
        let Ok(v) = v.to_str() else {
            // Not visible ASCII: the chain cannot be trusted past here;
            // the peer (a trusted proxy) is the best we know.
            return peer;
        };
        hops.extend(v.split(','));
    }
    // Walking right to left, `last` is the nearest address known to be
    // genuine: the peer, then each trusted proxy that forwarded to it.
    let mut last = peer;
    for hop in hops.iter().rev().take(MAX_HOPS) {
        match parse_hop(hop) {
            Some(ip) if is_trusted(ip) => last = ip,
            Some(ip) => return ip,
            // Garbage where an address must be: whoever wrote it is not a
            // proxy we trust; attribute to the last genuine hop.
            None => return last,
        }
    }
    last
}

/// Rate-limit identity of a client address: IPv4 as is, IPv6 by its /64
/// (one subscriber usually holds a whole /64, so per-address keys would be
/// free to multiply).
pub fn bucket(ip: IpAddr) -> String {
    match canonical(ip) {
        IpAddr::V4(v4) => v4.to_string(),
        v6 @ IpAddr::V6(_) => format!("{}/64", mask(v6, 64)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn cidrs(v: &[&str]) -> Vec<Cidr> {
        v.iter().map(|s| Cidr::parse(s).unwrap()).collect()
    }

    fn hdrs(xff: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for v in xff {
            h.append("x-forwarded-for", HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn cidr_parsing() {
        for bad in [
            "",
            "10.0.0.0/33",
            "10.0.0.1/8",
            "::/129",
            "nope",
            "10.0.0.0/x",
            "fd00::1/8",
            "::ffff:10.0.0.0/95",
        ] {
            assert!(Cidr::parse(bad).is_err(), "{bad:?}");
        }
        let c = Cidr::parse("10.0.0.0/8").unwrap();
        assert!(c.contains(ip("10.1.2.3")));
        assert!(c.contains(ip("::ffff:10.1.2.3")), "mapped peer");
        assert!(!c.contains(ip("11.0.0.1")));
        assert!(!c.contains(ip("::a00:1")), "v6 is not v4");
        let c = Cidr::parse("::ffff:10.0.0.0/104").unwrap();
        assert!(c.contains(ip("10.9.9.9")));
        let c = Cidr::parse("fd00::/8").unwrap();
        assert!(c.contains(ip("fd12::1")) && !c.contains(ip("fe80::1")));
        let c = Cidr::parse("192.0.2.7").unwrap();
        assert!(c.contains(ip("192.0.2.7")) && !c.contains(ip("192.0.2.8")));
        let c = Cidr::parse("0.0.0.0/0").unwrap();
        assert!(c.contains(ip("8.8.8.8")) && !c.contains(ip("::1")));
    }

    #[test]
    fn xff_table() {
        let t = cidrs(&["10.0.0.0/8", "fd00::/8"]);
        let cases: &[(&str, &[&str], &str, &str)] = &[
            // (peer, XFF lines, expected client, why)
            ("203.0.113.9", &[], "203.0.113.9", "no header"),
            (
                "203.0.113.9",
                &["1.2.3.4"],
                "203.0.113.9",
                "untrusted peer: XFF ignored",
            ),
            (
                "203.0.113.9",
                &["10.0.0.1"],
                "203.0.113.9",
                "untrusted peer claiming a trusted hop",
            ),
            ("10.0.0.2", &[], "10.0.0.2", "trusted peer, no header"),
            ("10.0.0.2", &["198.51.100.1"], "198.51.100.1", "one proxy"),
            (
                "10.0.0.2",
                &["6.6.6.6, 198.51.100.1"],
                "198.51.100.1",
                "client-forged left part ignored",
            ),
            (
                "10.0.0.2",
                &["6.6.6.6, 198.51.100.1, 10.0.0.3"],
                "198.51.100.1",
                "two proxies",
            ),
            (
                "10.0.0.2",
                &["6.6.6.6", "198.51.100.1, 10.0.0.3"],
                "198.51.100.1",
                "split over header lines",
            ),
            (
                "10.0.0.2",
                &["10.0.0.7, 10.0.0.3"],
                "10.0.0.7",
                "all hops trusted: leftmost",
            ),
            (
                "10.0.0.2",
                &["garbage, 10.0.0.3"],
                "10.0.0.3",
                "garbage: last genuine hop",
            ),
            (
                "10.0.0.2",
                &["198.51.100.1, garbage"],
                "10.0.0.2",
                "garbage appended: the peer",
            ),
            ("10.0.0.2", &[""], "10.0.0.2", "empty header"),
            (
                "10.0.0.2",
                &["198.51.100.1:4711"],
                "198.51.100.1",
                "v4 with port",
            ),
            ("10.0.0.2", &["2001:db8::1"], "2001:db8::1", "v6"),
            (
                "10.0.0.2",
                &["[2001:db8::1]:443"],
                "2001:db8::1",
                "bracketed v6 with port",
            ),
            (
                "10.0.0.2",
                &["[2001:db8::1]"],
                "2001:db8::1",
                "bracketed v6",
            ),
            (
                "10.0.0.2",
                &["::ffff:198.51.100.1"],
                "198.51.100.1",
                "mapped v4 hop",
            ),
            (
                "::ffff:10.0.0.2",
                &["198.51.100.1"],
                "198.51.100.1",
                "mapped trusted peer",
            ),
            (
                "fd00::2",
                &["2001:db8::1, fd00::3"],
                "2001:db8::1",
                "v6 proxies",
            ),
            (
                "2001:db8::66",
                &["2001:db8::1"],
                "2001:db8::66",
                "untrusted v6 peer",
            ),
            ("10.0.0.2", &["unknown"], "10.0.0.2", "nginx 'unknown'"),
        ];
        for (peer, xff, want, why) in cases {
            assert_eq!(client_ip(ip(peer), &hdrs(xff), &t), ip(want), "{why}");
        }
        // Nothing trusted (the default): XFF never matters.
        assert_eq!(
            client_ip(ip("127.0.0.1"), &hdrs(&["1.2.3.4"]), &[]),
            ip("127.0.0.1")
        );
        // A non-ASCII header value from a trusted proxy: the peer.
        let mut h = HeaderMap::new();
        h.append(
            "x-forwarded-for",
            HeaderValue::from_bytes(b"1.2.3.4\xff").unwrap(),
        );
        assert_eq!(client_ip(ip("10.0.0.2"), &h, &t), ip("10.0.0.2"));
        // A very long all-trusted chain is cut off at MAX_HOPS.
        let long = vec!["10.0.0.9"; 1000].join(",");
        assert_eq!(
            client_ip(ip("10.0.0.2"), &hdrs(&[&long]), &t),
            ip("10.0.0.9")
        );
    }

    #[test]
    fn buckets_group_v6_by_64() {
        assert_eq!(bucket(ip("198.51.100.1")), "198.51.100.1");
        assert_eq!(bucket(ip("::ffff:198.51.100.1")), "198.51.100.1");
        assert_eq!(bucket(ip("2001:db8:1:2:aaaa::1")), "2001:db8:1:2::/64");
        assert_eq!(
            bucket(ip("2001:db8:1:2:ffff::9")),
            bucket(ip("2001:db8:1:2::1"))
        );
        assert_ne!(bucket(ip("2001:db8:1:3::1")), bucket(ip("2001:db8:1:2::1")));
    }
}
