//! The user's proxies as the structural templates' documents: one Clash
//! proxy mapping or sing-box outbound per neutral proxy (`sub::proxy`).

use super::doc::Doc;
use crate::sub::proxy::{Proxy, log_omitted};

/// The proxies a format can carry, in order (the others are logged).
pub(crate) fn kept<'a>(proxies: &'a [Proxy], format: &str) -> Vec<&'a Proxy> {
    proxies
        .iter()
        .filter(|p| match p.omitted_from(format) {
            Some(why) => {
                log_omitted(p, format, why);
                false
            }
            None => true,
        })
        .collect()
}

pub(crate) fn clash(p: &Proxy) -> Doc {
    let kind = match p.protocol {
        "ss2022" => "ss",
        other => other,
    };
    let mut m = Doc::map()
        .with("name", p.name.as_str())
        .with("type", kind)
        .with("server", p.server.as_str())
        .with("port", p.net.port);
    match p.protocol {
        "vless" => {
            m.set("uuid", p.id_or_password.as_str());
            if !p.flow.is_empty() {
                m.set("flow", p.flow.as_str());
            }
        }
        "vmess" => {
            m.set("uuid", p.id_or_password.as_str());
            m.set("alterId", 0u64);
            m.set("cipher", "auto");
        }
        "trojan" => m.set("password", p.id_or_password.as_str()),
        "ss2022" => {
            m.set("cipher", p.method.as_str());
            m.set("password", p.id_or_password.as_str());
            m.set("udp", p.udp);
            return m;
        }
        "hysteria2" => {
            m.set("password", p.id_or_password.as_str());
            if !p.net.sni.is_empty() {
                m.set("sni", p.net.sni.as_str());
            }
            m.set("alpn", Doc::seq_of_strs(["h3".to_string()]));
            return m;
        }
        _ => {}
    }
    // HTTPUpgrade is mihomo's websocket with v2ray-http-upgrade.
    let network = match p.net.network() {
        "httpupgrade" => "ws",
        n => n,
    };
    m.set("network", network);
    if p.net.security == "tls" || p.net.security == "reality" {
        m.set("tls", true);
        if !p.net.sni.is_empty() {
            // mihomo reads the SNI of trojan from `sni` (vless/vmess:
            // `servername`); a wrong key silently falls back to the server
            // address and verification fails (W10 smoke).
            let key = if p.protocol == "trojan" {
                "sni"
            } else {
                "servername"
            };
            m.set(key, p.net.sni.as_str());
        }
    }
    if !p.net.fingerprint.is_empty() {
        m.set("client-fingerprint", p.net.fingerprint.as_str());
    }
    if p.net.security == "reality" {
        let mut r = Doc::map().with("public-key", p.net.public_key.as_str());
        if !p.net.short_id.is_empty() {
            r.set("short-id", p.net.short_id.as_str());
        }
        m.set("reality-opts", r);
    }
    match p.net.network() {
        "ws" | "httpupgrade" => {
            let mut o = Doc::map().with("path", p.net.path.as_str());
            if !p.net.host.is_empty() {
                o.set("headers", Doc::map().with("Host", p.net.host.as_str()));
            }
            if p.net.network() == "httpupgrade" {
                o.set("v2ray-http-upgrade", true);
            }
            m.set("ws-opts", o);
        }
        "xhttp" => {
            let mut o = Doc::map().with("path", p.net.path.as_str());
            if !p.net.host.is_empty() {
                o.set("host", p.net.host.as_str());
            }
            if !p.net.mode.is_empty() {
                o.set("mode", p.net.mode.as_str());
            }
            m.set("xhttp-opts", o);
        }
        "grpc" => m.set(
            "grpc-opts",
            Doc::map().with("grpc-service-name", p.net.service_name.as_str()),
        ),
        _ => {}
    }
    m
}

pub(crate) fn sing_box(p: &Proxy) -> Doc {
    let kind = match p.protocol {
        "ss2022" => "shadowsocks",
        other => other,
    };
    let mut o = Doc::map()
        .with("tag", p.name.as_str())
        .with("type", kind)
        .with("server", p.server.as_str())
        .with("server_port", p.net.port);
    match p.protocol {
        "vless" | "vmess" => {
            o.set("uuid", p.id_or_password.as_str());
            if p.protocol == "vless" && !p.flow.is_empty() {
                o.set("flow", p.flow.as_str());
            }
        }
        "trojan" => o.set("password", p.id_or_password.as_str()),
        "ss2022" => {
            o.set("method", p.method.as_str());
            o.set("password", p.id_or_password.as_str());
            return o;
        }
        "hysteria2" => {
            o.set("password", p.id_or_password.as_str());
            let mut tls = Doc::map()
                .with("enabled", true)
                .with("alpn", Doc::seq_of_strs(["h3".to_string()]));
            if !p.net.sni.is_empty() {
                tls.set("server_name", p.net.sni.as_str());
            }
            o.set("tls", tls);
            return o;
        }
        _ => {}
    }
    if p.net.security == "tls" || p.net.security == "reality" {
        let mut tls = Doc::map().with("enabled", true);
        if !p.net.sni.is_empty() {
            tls.set("server_name", p.net.sni.as_str());
        }
        if p.net.security == "reality" {
            tls.set(
                "utls",
                Doc::map()
                    .with("enabled", true)
                    .with("fingerprint", p.net.fingerprint.as_str()),
            );
            tls.set(
                "reality",
                Doc::map()
                    .with("enabled", true)
                    .with("public_key", p.net.public_key.as_str())
                    .with("short_id", p.net.short_id.as_str()),
            );
        }
        o.set("tls", tls);
    }
    match p.net.network() {
        "ws" => {
            let mut t = Doc::map()
                .with("type", "ws")
                .with("path", p.net.path.as_str());
            if !p.net.host.is_empty() {
                t.set("headers", Doc::map().with("Host", p.net.host.as_str()));
            }
            o.set("transport", t);
        }
        "httpupgrade" => {
            let mut t = Doc::map()
                .with("type", "httpupgrade")
                .with("path", p.net.path.as_str());
            if !p.net.host.is_empty() {
                t.set("host", p.net.host.as_str());
            }
            o.set("transport", t);
        }
        "grpc" => o.set(
            "transport",
            Doc::map()
                .with("type", "grpc")
                .with("service_name", p.net.service_name.as_str()),
        ),
        _ => {}
    }
    o
}
