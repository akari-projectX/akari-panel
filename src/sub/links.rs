//! Links format (v2rayN/Shadowrocket): one share link per proxy, the list
//! base64-encoded. Renders the neutral client proxies (`proxy.rs`).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;

use super::proxy::{Proxy, encode_fragment};

fn query_params(p: &Proxy, include_flow: bool) -> String {
    let mut params = vec![format!("type={}", p.net.network())];
    if p.net.security != "none" {
        params.push(format!("security={}", p.net.security));
    }
    if include_flow && !p.flow.is_empty() {
        params.push(format!("flow={}", p.flow));
    }
    if !p.net.sni.is_empty() {
        params.push(format!("sni={}", p.net.sni));
    }
    if !p.net.public_key.is_empty() {
        params.push(format!("pbk={}", p.net.public_key));
    }
    if !p.net.short_id.is_empty() {
        params.push(format!("sid={}", p.net.short_id));
    }
    if !p.net.fingerprint.is_empty() {
        params.push(format!("fp={}", p.net.fingerprint));
    }
    match p.net.network() {
        "ws" | "httpupgrade" | "xhttp" => {
            params.push(format!("path={}", encode_fragment(&p.net.path)));
            if !p.net.host.is_empty() {
                params.push(format!("host={}", p.net.host));
            }
            if p.net.network() == "xhttp" {
                let mode = if p.net.mode.is_empty() {
                    "auto"
                } else {
                    &p.net.mode
                };
                params.push(format!("mode={mode}"));
            }
        }
        "grpc" => {
            params.push(format!(
                "serviceName={}",
                encode_fragment(&p.net.service_name)
            ));
            params.push("mode=gun".into());
        }
        _ => {}
    }
    params.join("&")
}

pub(crate) fn render_links(proxies: &[Proxy]) -> String {
    let mut lines = Vec::new();
    for p in proxies {
        let frag = encode_fragment(&p.name);
        match p.protocol {
            "vless" => lines.push(format!(
                "vless://{}@{}:{}?{}#{}",
                p.id_or_password,
                p.server,
                p.net.port,
                query_params(p, true),
                frag
            )),
            "trojan" => lines.push(format!(
                "trojan://{}@{}:{}?{}#{}",
                p.id_or_password,
                p.server,
                p.net.port,
                query_params(p, false),
                frag
            )),
            "vmess" => {
                let (path, kind) = match p.net.network() {
                    "grpc" => (p.net.service_name.as_str(), "gun"),
                    "xhttp" => (
                        p.net.path.as_str(),
                        if p.net.mode.is_empty() {
                            "auto"
                        } else {
                            p.net.mode.as_str()
                        },
                    ),
                    _ => (p.net.path.as_str(), "none"),
                };
                let payload = json!({
                    "v": "2",
                    "ps": p.name,
                    "add": p.server,
                    "port": p.net.port.to_string(),
                    "id": p.id_or_password,
                    "aid": "0",
                    "scy": "auto",
                    "net": p.net.network(),
                    "type": kind,
                    "host": p.net.host,
                    "path": path,
                    "tls": if p.net.security == "tls" { "tls" } else { "" },
                    "sni": p.net.sni,
                });
                lines.push(format!(
                    "vmess://{}",
                    STANDARD.encode(payload.to_string().as_bytes())
                ));
            }
            // SIP002 with an AEAD-2022 method: userinfo is not base64 but
            // "method:password" percent-encoded (the password itself is
            // "psk:key" and holds base64 '+', '/', '=').
            "ss2022" => lines.push(format!(
                "ss://{}:{}@{}:{}#{}",
                p.method,
                encode_fragment(&p.id_or_password),
                p.server,
                p.net.port,
                frag
            )),
            "hysteria2" => lines.push(format!(
                "hysteria2://{}@{}:{}/?sni={}#{}",
                encode_fragment(&p.id_or_password),
                p.server,
                p.net.port,
                p.net.sni,
                frag
            )),
            _ => {}
        }
    }
    // V2ray-family clients expect the link list itself to be base64.
    STANDARD.encode(lines.join("\n"))
}
