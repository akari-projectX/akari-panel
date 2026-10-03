//! sing-box format: outbounds (+ direct). Renders the neutral client
//! proxies (`proxy.rs`).

use serde_json::{Value, json};

use super::proxy::{Proxy, log_omitted};

pub(crate) fn render_sing_box(proxies: &[Proxy]) -> Value {
    let outbounds: Vec<Value> = proxies
        .iter()
        .filter(|p| match p.omitted_from("sing-box") {
            Some(why) => {
                log_omitted(p, "sing-box", why);
                false
            }
            None => true,
        })
        .map(|p| {
            let kind = match p.protocol {
                "ss2022" => "shadowsocks",
                other => other,
            };
            let mut obj = serde_json::Map::new();
            obj.insert("tag".into(), json!(p.name));
            obj.insert("type".into(), json!(kind));
            obj.insert("server".into(), json!(p.server));
            obj.insert("server_port".into(), json!(p.net.port));
            match p.protocol {
                "vless" | "vmess" => {
                    obj.insert("uuid".into(), json!(p.id_or_password));
                    if p.protocol == "vless" && !p.flow.is_empty() {
                        obj.insert("flow".into(), json!(p.flow));
                    }
                }
                "trojan" => {
                    obj.insert("password".into(), json!(p.id_or_password));
                }
                "ss2022" => {
                    obj.insert("method".into(), json!(p.method));
                    obj.insert("password".into(), json!(p.id_or_password));
                    return Value::Object(obj);
                }
                "hysteria2" => {
                    obj.insert("password".into(), json!(p.id_or_password));
                    let mut tls = json!({"enabled": true, "alpn": ["h3"]});
                    if !p.net.sni.is_empty() {
                        tls["server_name"] = json!(p.net.sni);
                    }
                    obj.insert("tls".into(), tls);
                    return Value::Object(obj);
                }
                _ => {}
            }
            if p.net.security == "tls" || p.net.security == "reality" {
                let mut tls = json!({"enabled": true});
                if !p.net.sni.is_empty() {
                    tls["server_name"] = json!(p.net.sni);
                }
                if p.net.security == "reality" {
                    tls["utls"] = json!({
                        "enabled": true,
                        "fingerprint": p.net.fingerprint,
                    });
                    tls["reality"] = json!({
                        "enabled": true,
                        "public_key": p.net.public_key,
                        "short_id": p.net.short_id,
                    });
                }
                obj.insert("tls".into(), tls);
            }
            match p.net.network() {
                "ws" => {
                    let mut transport = json!({"type": "ws", "path": p.net.path});
                    if !p.net.host.is_empty() {
                        transport["headers"] = json!({"Host": p.net.host});
                    }
                    obj.insert("transport".into(), transport);
                }
                "httpupgrade" => {
                    let mut transport = json!({"type": "httpupgrade", "path": p.net.path});
                    if !p.net.host.is_empty() {
                        transport["host"] = json!(p.net.host);
                    }
                    obj.insert("transport".into(), transport);
                }
                "grpc" => {
                    obj.insert(
                        "transport".into(),
                        json!({"type": "grpc", "service_name": p.net.service_name}),
                    );
                }
                _ => {}
            }
            Value::Object(obj)
        })
        .collect();
    json!({
        "outbounds": outbounds
            .into_iter()
            .chain(std::iter::once(json!({"type": "direct", "tag": "direct"})))
            .collect::<Vec<Value>>(),
    })
}
