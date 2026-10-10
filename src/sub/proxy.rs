//! W26: what a subscription hands out, per credential: a client proxy
//! built from the kernel-neutral model (`protocols::xray::parse_as` reads
//! the stored inbound as the credential's protocol), and what each format
//! can carry (the manifest's `[[format.unsupported]]`). The format
//! renderers (`links`, `clash`, `singbox`) never see kernel JSON.

use std::collections::HashSet;

use super::NodeRow;
use crate::protocols::manifest;
use crate::protocols::model::{self, Inbound, Protocol, Security, TransportKind};

/// Where and how a client connects (the model's transport and security as
/// clients need them).
pub(crate) struct Net {
    pub port: u16,
    pub transport: TransportKind,
    /// Manifest security id (or the stored name of an unknown one).
    pub security: String,
    pub sni: String,
    pub public_key: String,
    pub short_id: String,
    /// uTLS client fingerprint (REALITY only; empty otherwise).
    pub fingerprint: String,
    /// ws / httpupgrade / xhttp path and Host.
    pub path: String,
    pub host: String,
    /// xhttp mode ("" = auto).
    pub mode: String,
    /// grpc service name.
    pub service_name: String,
}

impl Net {
    /// Manifest transport id (or the stored name of an unknown one).
    pub fn network(&self) -> &str {
        self.transport.id()
    }
}

pub(crate) fn net_of(ib: &Inbound) -> Option<Net> {
    let port = u16::try_from((*ib.port.as_ref()?)?).ok()?;
    let f = ib.transport.fields.clone().unwrap_or_default();
    let (path, host, mode, service_name) = match ib.transport.kind {
        TransportKind::Ws | TransportKind::HttpUpgrade | TransportKind::Xhttp => {
            let p = model::text(&f.path);
            (
                if p.is_empty() { "/" } else { p }.to_string(),
                model::text(&f.host).to_string(),
                if ib.transport.kind == TransportKind::Xhttp {
                    model::text(&f.mode).to_string()
                } else {
                    String::new()
                },
                String::new(),
            )
        }
        TransportKind::Grpc => (
            String::new(),
            String::new(),
            String::new(),
            model::text(&f.service_name).to_string(),
        ),
        _ => Default::default(),
    };
    let (public_key, short_id, fingerprint) = match &ib.security {
        Security::Reality(r) => (
            r.public_key.clone().unwrap_or_default(),
            r.short_id.clone().unwrap_or_default(),
            crate::protocols::security::client_fingerprint(r.fingerprint.as_deref()).to_string(),
        ),
        _ => Default::default(),
    };
    Some(Net {
        port,
        transport: ib.transport.kind.clone(),
        security: ib.security.id().to_string(),
        sni: ib.security.sni().to_string(),
        public_key,
        short_id,
        fingerprint,
        path,
        host,
        mode,
        service_name,
    })
}

pub(crate) struct Proxy {
    pub name: String,
    /// Manifest protocol id.
    pub protocol: &'static str,
    /// vless/vmess uuid, trojan password, shadowsocks "server_psk:user_key",
    /// hysteria auth.
    pub id_or_password: String,
    pub flow: String,
    /// shadowsocks method.
    pub method: String,
    /// shadowsocks: the inbound also serves UDP.
    pub udp: bool,
    pub server: String,
    pub net: Net,
}

impl Proxy {
    /// Why `format` (manifest format id) cannot carry this proxy, if it
    /// cannot.
    pub fn omitted_from(&self, format: &str) -> Option<&'static str> {
        manifest::get().unsupported_in(
            format,
            self.protocol,
            self.net.network(),
            &self.net.security,
        )
    }
}

pub(crate) fn log_omitted(p: &Proxy, format: &str, why: &str) {
    tracing::info!(proxy = %p.name, format, reason = why, "proxy left out of subscription format");
}

/// Is a flow expressible here? The manifest's flow rules require their
/// transport/security (Vision: raw TCP with TLS/REALITY); a stale flow on
/// any other transport would make clients fail.
fn flow_applies(protocol: &str, net: &Net) -> bool {
    let none = Default::default();
    manifest::get()
        .rule
        .iter()
        .filter(|r| r.when.keys().any(|k| k == "option.flow"))
        .all(|r| {
            crate::protocols::manifest_def::selects(
                &r.require,
                protocol,
                net.network(),
                &net.security,
                &none,
            )
        })
}

pub(crate) fn collect_proxies(rows: &[NodeRow]) -> Vec<Proxy> {
    let m = manifest::get();
    let mut proxies: Vec<Proxy> = Vec::new();
    let mut names = HashSet::new();
    for row in rows {
        let ib = crate::protocols::xray::parse_as(&row.inbound, &row.protocol);
        let Some(mut net) = net_of(&ib) else {
            continue;
        };
        // What clients dial may differ from what the inbound listens on
        // (NAT, port forwarding, relays): the entrance's address.
        let Some(server) = row.server.as_deref().filter(|s| !s.is_empty()) else {
            continue; // no client-facing address yet
        };
        if let Some(p) = row.port.and_then(|p| u16::try_from(p).ok()) {
            net.port = p;
        }
        let Some(spec) = m.protocol_by_wire(&row.protocol) else {
            continue;
        };
        let acc = |k: &str| row.account.get(k).and_then(|v| v.as_str());
        let mut method = String::new();
        let id_or_password = match &ib.protocol {
            Protocol::Vless { .. } | Protocol::Vmess => acc("id").map(String::from),
            Protocol::Trojan => acc("password").map(String::from),
            Protocol::Hysteria2 { .. } => acc("auth").map(String::from),
            Protocol::Ss2022 { method: m, psk, .. } => {
                // SIP022 multi-user: "<server PSK>:<user key>".
                method = m.clone().unwrap_or_default();
                match (psk, acc("password")) {
                    (Some(psk), Some(user)) if !method.is_empty() => Some(format!("{psk}:{user}")),
                    _ => None,
                }
            }
            Protocol::Unmanaged { .. } => None,
        };
        let Some(id_or_password) = id_or_password else {
            continue;
        };
        let flow = match acc("flow") {
            Some(f) if flow_applies(&spec.id, &net) => f,
            _ => "",
        };
        // W11 display name, the entrance's tags (1104), then the entrance ("香港 01 | IPLC
        // 直连"), and only with the operator switch its base multiplier
        // when not 1x ("香港 01 IPLC 2.0x"); names stay unique across the
        // subscription and stable across rate changes and time windows
        // (clients key proxies, and the user's selection, by name).
        let base = crate::nodemeta::public_name(&row.name, row.display_name.as_deref(), &row.tags);
        let mut name = format!("{base} {}", row.entrance);
        if let Some(rate) = row.name_rate_permille.filter(|r| *r != 1000) {
            name.push(' ');
            name.push_str(&rate_label(rate));
        }
        let name = unique_name(&mut names, name);
        proxies.push(Proxy {
            name,
            protocol: spec.id.as_str(),
            id_or_password,
            flow: flow.to_string(),
            method,
            udp: crate::protocols::l4(&row.inbound).1,
            server: server.to_string(),
            net,
        });
    }
    proxies
}

/// `name`, or `name #2`, `name #3`, ... if already taken.
fn unique_name(taken: &mut HashSet<String>, name: String) -> String {
    if taken.insert(name.clone()) {
        return name;
    }
    let mut i = 2;
    loop {
        let n = format!("{name} #{i}");
        if taken.insert(n.clone()) {
            return n;
        }
        i += 1;
    }
}

/// Percent-encode a link fragment (node names may hold spaces/unicode).
pub(crate) fn encode_fragment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A YAML scalar: plain when it is a safe token, JSON-quoted otherwise
/// (a JSON string is a valid YAML double-quoted scalar).
pub(crate) fn yaml(s: &str) -> String {
    const RESERVED: [&str; 11] = [
        "true", "false", "null", "yes", "no", "on", "off", "y", "n", "nan", "inf",
    ];
    let safe = !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-_.~".contains(&b))
        && !s.starts_with(['-', '.', '~'])
        && (s.starts_with('/')
            || (s.bytes().any(|b| b.is_ascii_alphabetic())
                && !RESERVED.contains(&s.to_ascii_lowercase().as_str())
                && s.parse::<f64>().is_err()));
    if safe {
        s.to_string()
    } else {
        serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
    }
}

/// The inbound of a test proxy (unit tests of the renderers).
#[cfg(test)]
pub(crate) fn net_from_inbound(inbound: &serde_json::Value) -> Option<Net> {
    net_of(&crate::protocols::xray::parse(inbound))
}

/// A multiplier as subscriptions show it: "2.0x", "0.5x", "1.25x", "0.125x".
pub(crate) fn rate_label(permille: i32) -> String {
    let r = f64::from(permille) / 1000.0;
    if permille % 100 == 0 {
        format!("{r:.1}x")
    } else if permille % 10 == 0 {
        format!("{r:.2}x")
    } else {
        format!("{r:.3}x")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn rate_labels() {
        assert_eq!(super::rate_label(2000), "2.0x");
        assert_eq!(super::rate_label(500), "0.5x");
        assert_eq!(super::rate_label(1250), "1.25x");
        assert_eq!(super::rate_label(125), "0.125x");
        assert_eq!(super::rate_label(0), "0.0x");
    }
}
