//! Clash (mihomo, Clash Verge, Stash) format: a YAML proxy list, a PROXY
//! select group, the routing template's rule-providers and rules (W30,
//! `routing.rs`) ending with MATCH,PROXY. Renders the neutral client
//! proxies (`proxy.rs`).

use super::proxy::{Proxy, log_omitted, yaml};
use super::routing::Routing;

pub(crate) fn render_clash(proxies: &[Proxy], routing: &Routing) -> String {
    let mut out = String::from("proxies:\n");
    let mut names = Vec::new();
    for p in proxies {
        if let Some(why) = p.omitted_from("clash") {
            log_omitted(p, "clash", why);
            continue;
        }
        let kind = match p.protocol {
            "ss2022" => "ss",
            other => other,
        };
        names.push(serde_json::to_string(&p.name).unwrap_or_else(|_| "\"proxy\"".into()));
        out.push_str("  - name: ");
        out.push_str(&serde_json::to_string(&p.name).unwrap_or_else(|_| "\"proxy\"".into()));
        out.push('\n');
        out.push_str(&format!("    type: {kind}\n"));
        out.push_str(&format!("    server: {}\n", p.server));
        out.push_str(&format!("    port: {}\n", p.net.port));
        match p.protocol {
            "vless" => {
                out.push_str(&format!("    uuid: {}\n", p.id_or_password));
                if !p.flow.is_empty() {
                    out.push_str(&format!("    flow: {}\n", p.flow));
                }
            }
            "vmess" => {
                out.push_str(&format!("    uuid: {}\n", p.id_or_password));
                out.push_str("    alterId: 0\n    cipher: auto\n");
            }
            "trojan" => {
                out.push_str(&format!("    password: {}\n", yaml(&p.id_or_password)));
            }
            "ss2022" => {
                out.push_str(&format!("    cipher: {}\n", p.method));
                out.push_str(&format!("    password: {}\n", yaml(&p.id_or_password)));
                out.push_str(&format!("    udp: {}\n", p.udp));
                continue;
            }
            "hysteria2" => {
                out.push_str(&format!("    password: {}\n", yaml(&p.id_or_password)));
                if !p.net.sni.is_empty() {
                    out.push_str(&format!("    sni: {}\n", p.net.sni));
                }
                out.push_str("    alpn:\n      - h3\n");
                continue;
            }
            _ => {}
        }
        // HTTPUpgrade is mihomo's websocket with v2ray-http-upgrade.
        let network = match p.net.network() {
            "httpupgrade" => "ws",
            n => n,
        };
        out.push_str(&format!("    network: {network}\n"));
        if p.net.security == "tls" || p.net.security == "reality" {
            out.push_str("    tls: true\n");
            if !p.net.sni.is_empty() {
                // mihomo reads the SNI of trojan from `sni` (vless/vmess:
                // `servername`); a wrong key silently falls back to the
                // server address, and verification fails (W10 smoke).
                let key = if p.protocol == "trojan" {
                    "sni"
                } else {
                    "servername"
                };
                out.push_str(&format!("    {key}: {}\n", p.net.sni));
            }
        }
        if !p.net.fingerprint.is_empty() {
            out.push_str(&format!("    client-fingerprint: {}\n", p.net.fingerprint));
        }
        if p.net.security == "reality" {
            out.push_str("    reality-opts:\n");
            out.push_str(&format!("      public-key: {}\n", p.net.public_key));
            if !p.net.short_id.is_empty() {
                out.push_str(&format!("      short-id: {}\n", p.net.short_id));
            }
        }
        match p.net.network() {
            "ws" | "httpupgrade" => {
                out.push_str("    ws-opts:\n");
                out.push_str(&format!("      path: {}\n", yaml(&p.net.path)));
                if !p.net.host.is_empty() {
                    out.push_str("      headers:\n");
                    out.push_str(&format!("        Host: {}\n", p.net.host));
                }
                if p.net.network() == "httpupgrade" {
                    out.push_str("      v2ray-http-upgrade: true\n");
                }
            }
            "xhttp" => {
                out.push_str("    xhttp-opts:\n");
                out.push_str(&format!("      path: {}\n", yaml(&p.net.path)));
                if !p.net.host.is_empty() {
                    out.push_str(&format!("      host: {}\n", p.net.host));
                }
                if !p.net.mode.is_empty() {
                    out.push_str(&format!("      mode: {}\n", p.net.mode));
                }
            }
            "grpc" => {
                out.push_str("    grpc-opts:\n");
                out.push_str(&format!(
                    "      grpc-service-name: {}\n",
                    yaml(&p.net.service_name)
                ));
            }
            _ => {}
        }
    }
    out.push_str("proxy-groups:\n  - name: PROXY\n    type: select\n    proxies:\n");
    if names.is_empty() {
        out.push_str("      - DIRECT\n");
    }
    for name in &names {
        out.push_str(&format!("      - {name}\n"));
    }
    let (providers, rules) = routing.clash("PROXY");
    out.push_str(&providers);
    out.push_str(&rules);
    out
}
