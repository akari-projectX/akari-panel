//! Subscription DNS (2026-10-13): what the `dns:` block of a Clash profile
//! and the `dns` of a sing-box profile say, by the routing's DNS setting.
//!
//! - recommended (default): built-in domestic (`DEFAULT_CN`) and foreign
//!   (`DEFAULT_INTL`) DoH, fake-ip on;
//! - client: nothing (Clash: no `dns:` block; sing-box: the system
//!   resolver);
//! - custom: the operator's servers and fake-ip switch.
//!
//! Domestic servers resolve domestic destinations and the lines' own
//! addresses (Clash `proxy-server-nameserver`, sing-box
//! `route.default_domain_resolver`): they must work without the proxy.
//! Foreign servers resolve everything else through the proxy (Clash
//! `respect-rules`, sing-box `detour`). A server is an IP (plain UDP) or a
//! `udp://IP[:port]`, `tls://host[:port]` or `https://host[:port][/path]`
//! URL.

use std::net::IpAddr;

use serde_json::{Value, json};

use super::routing::{Dns, DnsMode};
use crate::auth::{ApiError, bad_request};

pub const DEFAULT_CN: [&str; 2] = ["https://223.5.5.5/dns-query", "https://doh.pub/dns-query"];
pub const DEFAULT_INTL: [&str; 2] = ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"];
/// Bootstrap resolvers when the domestic list has no IP literal.
const FALLBACK_BOOTSTRAP: [&str; 2] = ["223.5.5.5", "119.29.29.29"];
pub const MAX_SERVERS: usize = 8;
const MAX_SERVER_CHARS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scheme {
    Udp,
    Tls,
    Https,
}

/// A parsed DNS server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Server {
    pub scheme: Scheme,
    /// IP literal (no brackets) or host name.
    pub host: String,
    pub port: Option<u16>,
    /// https only ("" = the default `/dns-query`).
    pub path: String,
}

impl Server {
    pub fn ip(&self) -> Option<IpAddr> {
        self.host.parse().ok()
    }
}

/// Parse one server (normalized: scheme and host lowercased).
pub(crate) fn server(v: &str) -> Option<Server> {
    let v = v.trim();
    if v.is_empty()
        || v.len() > MAX_SERVER_CHARS
        || v.chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '\\' | ','))
    {
        return None;
    }
    if let Ok(ip) = v.parse::<IpAddr>() {
        return Some(Server {
            scheme: Scheme::Udp,
            host: ip.to_string(),
            port: None,
            path: String::new(),
        });
    }
    let (scheme, rest) = v.split_once("://")?;
    let scheme = match scheme.to_ascii_lowercase().as_str() {
        "udp" => Scheme::Udp,
        "tls" => Scheme::Tls,
        "https" => Scheme::Https,
        _ => return None,
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if !path.is_empty()
        && (scheme != Scheme::Https
            || !path
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/-_.~".contains(&b)))
    {
        return None;
    }
    let (host, port) = if let Some(r) = authority.strip_prefix('[') {
        let (h, after) = r.split_once(']')?;
        let port = match after {
            "" => None,
            p => Some(p.strip_prefix(':')?.parse::<u16>().ok()?),
        };
        (h.parse::<std::net::Ipv6Addr>().ok()?.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p.parse::<u16>().ok()?)),
            None => (authority.to_string(), None),
        }
    };
    if port == Some(0) {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let is_ip = host.parse::<IpAddr>().is_ok();
    if !is_ip && (scheme == Scheme::Udp || !crate::entrances::valid_host(&host)) {
        return None; // plain UDP needs an address; names must be valid
    }
    Some(Server {
        scheme,
        host,
        port,
        path: if path == "/dns-query" {
            String::new()
        } else {
            path.to_string()
        },
    })
}

fn list(v: Vec<String>, required: bool) -> Result<Vec<String>, ApiError> {
    if v.len() > MAX_SERVERS || (required && v.is_empty()) {
        return Err(bad_request!(
            "settings.sub_dns_servers_count",
            "each DNS list holds 1 to {max} servers",
            max = MAX_SERVERS
        ));
    }
    let mut out: Vec<String> = Vec::new();
    for s in v {
        let t = s.trim().to_string();
        if server(&t).is_none() {
            return Err(bad_request!(
                "settings.sub_dns_server_invalid",
                "{value} is not a DNS server (an IP, or a udp://, tls:// or https:// URL)",
                value = t.chars().take(64).collect::<String>()
            ));
        }
        if !out.contains(&t) {
            out.push(t);
        }
    }
    Ok(out)
}

/// Validate the DNS setting (custom: both lists 1-8 servers; otherwise
/// the lists are kept as the next custom starting point, still checked).
pub(crate) fn parse(d: Dns) -> Result<Dns, ApiError> {
    let custom = d.mode == DnsMode::Custom;
    Ok(Dns {
        mode: d.mode,
        fakeip: d.fakeip,
        cn: list(d.cn, custom)?,
        intl: list(d.intl, custom)?,
    })
}

fn servers(v: &[String]) -> Vec<Server> {
    v.iter().filter_map(|s| server(s)).collect()
}

/// The bootstrap resolvers (`default-nameserver`): the domestic list's IP
/// literals, else the built-in ones.
pub(crate) fn bootstrap(d: &Dns) -> Vec<String> {
    let ips: Vec<String> = servers(&d.cn)
        .iter()
        .filter_map(|s| s.ip().map(|ip| ip.to_string()))
        .collect();
    if ips.is_empty() {
        FALLBACK_BOOTSTRAP.iter().map(|s| s.to_string()).collect()
    } else {
        ips
    }
}

/// A sing-box (1.12+) DNS server object with `tag`. A host name needs a
/// resolver of its own (`domain_resolver`).
pub(crate) fn sing_box_server(s: &Server, tag: &str, resolver: &str) -> Value {
    let kind = match s.scheme {
        Scheme::Udp => "udp",
        Scheme::Tls => "tls",
        Scheme::Https => "https",
    };
    let mut o = json!({"type": kind, "tag": tag, "server": s.host});
    if let Some(p) = s.port {
        o["server_port"] = json!(p);
    }
    if !s.path.is_empty() {
        o["path"] = json!(s.path);
    }
    if s.ip().is_none() {
        o["domain_resolver"] = json!(resolver);
    }
    o
}

/// The first parseable server of a list.
pub(crate) fn first(v: &[String]) -> Option<Server> {
    servers(v).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn servers_parse() {
        let s = server("https://223.5.5.5/dns-query").unwrap();
        assert_eq!(
            (s.scheme, s.host.as_str(), s.port, s.path.as_str()),
            (Scheme::Https, "223.5.5.5", None, "")
        );
        let s = server("HTTPS://DoH.pub:8443/q").unwrap();
        assert_eq!(
            (s.host.as_str(), s.port, s.path.as_str()),
            ("doh.pub", Some(8443), "/q")
        );
        assert_eq!(server("1.1.1.1").unwrap().scheme, Scheme::Udp);
        assert_eq!(server("udp://8.8.8.8:53").unwrap().port, Some(53));
        assert_eq!(server("tls://dns.google").unwrap().scheme, Scheme::Tls);
        let v6 = server("https://[2606:4700::1111]/dns-query").unwrap();
        assert_eq!(v6.host, "2606:4700::1111");
        assert_eq!(server("2606:4700::1111").unwrap().host, "2606:4700::1111");
        for bad in [
            "",
            "udp://dns.google",
            "quic://1.1.1.1",
            "https://",
            "https://a b/x",
            "https://x.com/a,b",
            "https://1.1.1.1:0/",
            "https://1.1.1.1:99999/",
            "tls://1.1.1.1/path",
            "https://-bad-.com/",
            "https://x.com/\"",
        ] {
            assert!(server(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn validation_and_bootstrap() {
        let d = parse(Dns {
            mode: DnsMode::Custom,
            fakeip: false,
            cn: vec![
                " https://doh.pub/dns-query ".into(),
                "tls://1.12.12.12".into(),
            ],
            intl: vec!["8.8.8.8".into(), "8.8.8.8".into()],
        })
        .unwrap();
        assert_eq!(d.cn[0], "https://doh.pub/dns-query");
        assert_eq!(d.intl, ["8.8.8.8"]);
        assert_eq!(bootstrap(&d), ["1.12.12.12"]);
        let e = parse(Dns {
            mode: DnsMode::Custom,
            fakeip: true,
            cn: vec![],
            intl: vec!["8.8.8.8".into()],
        })
        .unwrap_err();
        assert_eq!(e.code(), "settings.sub_dns_servers_count");
        let e = parse(Dns {
            mode: DnsMode::Client,
            fakeip: true,
            cn: vec!["nope".into()],
            intl: vec![],
        })
        .unwrap_err();
        assert_eq!(e.code(), "settings.sub_dns_server_invalid");
        let only_names = Dns {
            cn: vec!["https://doh.pub/dns-query".into()],
            ..Dns::default()
        };
        assert_eq!(bootstrap(&only_names), FALLBACK_BOOTSTRAP);
        assert_eq!(Dns::default().effective(), Dns::default());
        let client = Dns {
            mode: DnsMode::Custom,
            cn: vec!["1.2.3.4".into()],
            ..Dns::default()
        };
        assert_eq!(client.effective().cn, ["1.2.3.4"]);
        let rec = Dns {
            mode: DnsMode::Recommended,
            fakeip: false,
            ..client
        };
        assert_eq!(rec.effective(), Dns::default(), "recommended ignores edits");
    }

    #[test]
    fn sing_box_servers() {
        let s = server("https://doh.pub:8443/q").unwrap();
        assert_eq!(
            sing_box_server(&s, "local", "bootstrap"),
            json!({"type": "https", "tag": "local", "server": "doh.pub", "server_port": 8443,
                   "path": "/q", "domain_resolver": "bootstrap"})
        );
        let s = server("223.5.5.5").unwrap();
        assert_eq!(
            sing_box_server(&s, "local", "bootstrap"),
            json!({"type": "udp", "tag": "local", "server": "223.5.5.5"})
        );
    }
}
