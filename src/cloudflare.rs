//! Cloudflare edge address ranges (R22).
//!
//! Used for two things: "trust Cloudflare" (system settings) adds them to
//! the proxies whose forwarding headers count (`client_ip.rs`), and the
//! domain DNS check tells whether a name is orange-clouded (resolves into
//! these ranges).
//!
//! The list ships in the binary (`cloudflare_ips.txt`, from
//! https://www.cloudflare.com/ips-v4 and /ips-v6). 系统设置 → 安全 →
//! Cloudflare 网段 replaces it without a rebuild; the update procedure is in
//! docs/DEPLOY.md ("Cloudflare"). Cloudflare announces range changes well
//! in advance and has changed them rarely; a stale list fails safe for
//! client addresses (a new edge range is treated as an untrusted peer: the
//! request is attributed to the edge, i.e. rate limits are coarser, nothing
//! is spoofable).

use std::net::IpAddr;

use crate::client_ip::Cidr;

const SHIPPED: &str = include_str!("cloudflare_ips.txt");

/// The shipped ranges. `#` starts a comment; blank lines are ignored.
pub fn shipped() -> Result<Vec<Cidr>, String> {
    parse_list(SHIPPED)
}

pub fn parse_list(text: &str) -> Result<Vec<Cidr>, String> {
    text.lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| !l.is_empty())
        .map(Cidr::parse)
        .collect()
}

/// The shipped ranges (系统设置 → 安全 may override them, see
/// `settings::Effective::cloudflare`).
pub fn shipped_or_empty() -> Vec<Cidr> {
    match shipped() {
        Ok(v) => v,
        Err(e) => {
            // Unreachable for a released binary (unit-tested); never panic.
            tracing::error!(error = %e, "shipped Cloudflare range list does not parse");
            Vec::new()
        }
    }
}

pub fn contains(ranges: &[Cidr], ip: IpAddr) -> bool {
    ranges.iter().any(|c| c.contains(ip))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn shipped_list_parses_and_matches_v4_v6() {
        let r = shipped().unwrap();
        assert!(r.len() >= 20, "{}", r.len());
        for yes in [
            "104.16.0.1",
            "172.67.1.1",
            "162.159.200.1",
            "::ffff:104.16.0.1", // mapped v4 peer
            "2606:4700::6810:84e5",
            "2a06:98c7:ffff::1", // inside /29
            "2c0f:f248::1",
        ] {
            assert!(contains(&r, ip(yes)), "{yes}");
        }
        for no in [
            "1.1.1.1", // Cloudflare's resolver is not an edge range
            "8.8.8.8",
            "127.0.0.1",
            "10.0.0.1",
            "2606:4701::1",
            "2a06:98c8::1", // just past the /29
            "::1",
        ] {
            assert!(!contains(&r, ip(no)), "{no}");
        }
    }

    #[test]
    fn list_syntax() {
        let r = parse_list("# c\n\n 10.0.0.0/8 # trailing\n2001:db8::/32\n").unwrap();
        assert_eq!(r.len(), 2);
        assert!(parse_list("10.0.0.1/8\n").is_err(), "host bits");
        assert!(parse_list("nope\n").is_err());
    }
}
