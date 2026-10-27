//! Surge and Surfboard proxy lines (`Name = type, host, port, key=value…`).
//! Surfboard follows Surge's profile format, so one renderer serves both;
//! what differs is which combinations each client documents:
//!
//! - Surge: `ss` (incl. 2022 and the multi-user `serverKey:userKey`
//!   password), `vmess` (tcp / ws, optional TLS), `trojan` (tcp / ws),
//!   `hysteria2`. https://manual.nssurge.com/policies/shadowsocks.html,
//!   /vmess.html, /trojan.html, /hysteria2.html, /tls.html
//! - Surfboard: `ss` (2022 methods need a plain base64 key: the multi-user
//!   form is not documented, so it is left out), `vmess`, `trojan`,
//!   `hysteria2`. https://getsurfboard.com/docs/profile-format/proxy/
//!   external-proxy/{shadowsocks,vmess,trojan,hysteria2}/
//!
//! Neither documents VLESS, REALITY, xhttp, httpupgrade or gRPC: those
//! proxies are left out (the caller logs `Err(reason)`), never written as
//! a line the client would reject.

use super::proxy::Proxy;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Dialect {
    Surge,
    Surfboard,
}

/// A name that is safe as the left side of `Name = …` and as a group
/// member: no control characters, no `,` or `=` (full-width forms instead),
/// no leading comment or section character.
pub(crate) fn safe_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            ',' => '，',
            '=' => '＝',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string();
    if out.is_empty() || out.starts_with(['#', ';', '/', '[', '$']) {
        out.insert(0, '_');
    }
    out
}

/// A parameter value: plain when it holds nothing the line syntax reads,
/// else double-quoted; `None` when it cannot be written at all.
fn value(v: &str) -> Option<String> {
    if v.chars().any(char::is_control) || v.contains('"') {
        return None;
    }
    if v.is_empty() || v.contains([',', '=', ' ', '|']) || v.starts_with('$') {
        return Some(format!("\"{v}\""));
    }
    Some(v.to_string())
}

/// The proxy line named `name`, or why this client cannot carry the proxy.
pub(crate) fn line(p: &Proxy, name: &str, d: Dialect) -> Result<String, &'static str> {
    let bad = "a value the profile syntax cannot carry";
    let net = &p.net;
    let host = value(&p.server).ok_or(bad)?;
    let mut parts: Vec<String> = Vec::new();
    let kind = match p.protocol {
        "ss2022" => {
            if d == Dialect::Surfboard {
                return Err("Surfboard documents no multi-user Shadowsocks 2022 password");
            }
            parts.push(format!("encrypt-method={}", value(&p.method).ok_or(bad)?));
            parts.push(format!("password={}", value(&p.id_or_password).ok_or(bad)?));
            if p.udp {
                parts.push("udp-relay=true".into());
            }
            "ss"
        }
        "vmess" | "trojan" => {
            if !matches!(net.network(), "tcp" | "raw" | "ws") {
                return Err("only tcp and websocket transports are documented");
            }
            let tls = net.security == "tls";
            match (p.protocol, net.security.as_str()) {
                (_, "reality") => return Err("REALITY is not supported"),
                ("trojan", s) if s != "tls" => return Err("Trojan needs TLS"),
                (_, "none" | "") | (_, "tls") => {}
                _ => return Err("security layer not supported"),
            }
            if p.protocol == "vmess" {
                parts.push(format!("username={}", value(&p.id_or_password).ok_or(bad)?));
                if d == Dialect::Surge {
                    parts.push("vmess-aead=true".into());
                } else {
                    parts.push("udp-relay=true".into());
                }
                if tls {
                    parts.push("tls=true".into());
                }
            } else {
                parts.push(format!("password={}", value(&p.id_or_password).ok_or(bad)?));
                if d == Dialect::Surfboard {
                    parts.push("udp-relay=true".into());
                }
            }
            if tls && !net.sni.is_empty() {
                parts.push(format!("sni={}", value(&net.sni).ok_or(bad)?));
            }
            if net.network() == "ws" {
                parts.push("ws=true".into());
                parts.push(format!("ws-path={}", value(&net.path).ok_or(bad)?));
                if !net.host.is_empty() {
                    if net.host.contains(['|', '"']) {
                        return Err(bad);
                    }
                    parts.push(format!(
                        "ws-headers={}",
                        value(&format!("Host:{}", net.host)).ok_or(bad)?
                    ));
                }
            }
            p.protocol
        }
        "hysteria2" => {
            parts.push(format!("password={}", value(&p.id_or_password).ok_or(bad)?));
            if !net.sni.is_empty() {
                parts.push(format!("sni={}", value(&net.sni).ok_or(bad)?));
            }
            "hysteria2"
        }
        _ => return Err("this protocol is not documented for the client"),
    };
    Ok(format!(
        "{name} = {kind}, {host}, {}, {}",
        net.port,
        parts.join(", ")
    ))
}
