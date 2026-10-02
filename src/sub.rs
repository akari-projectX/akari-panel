use std::collections::HashSet;

use axum::extract::{Path, RawQuery, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::MaybeClientIp;
use crate::{reject, state::AppState};

// ---------------------------------------------------------------------------
// Token management. The subscription URL credential is a 256-bit random; the
// database stores only its SHA-256, so a database leak does not leak live
// subscription URLs.
// ---------------------------------------------------------------------------

pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Length of a generated token (32 bytes, base64url without padding).
const TOKEN_LEN: usize = 43;

/// Could this path segment be a token we issued? Anything else is
/// rejected before any hashing or database work.
pub(crate) fn plausible_token(token: &str) -> bool {
    token.len() == TOKEN_LEN
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

// ---------------------------------------------------------------------------
// Subscription rendering
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Format {
    SingBox,
    Clash,
    Links,
}

/// W20: `?format=clash|sing-box|links` on the subscription URL picks the
/// format explicitly (the portal's format selector and one-click import
/// links); anything else — no query, other keys, unknown values — falls
/// back to User-Agent detection. Never a rejection: the token alone decides
/// whether the request is answered.
fn requested_format(query: Option<&str>) -> Option<Format> {
    query?.split('&').find_map(|pair| match pair {
        "format=clash" => Some(Format::Clash),
        "format=sing-box" | "format=singbox" => Some(Format::SingBox),
        "format=links" | "format=base64" => Some(Format::Links),
        _ => None,
    })
}

fn detect_format(user_agent: &str) -> Format {
    let ua = user_agent.to_ascii_lowercase();
    if ua.contains("sing-box") {
        Format::SingBox
    } else if ua.contains("clash") || ua.contains("mihomo") || ua.contains("stash") {
        Format::Clash
    } else {
        Format::Links
    }
}

#[derive(FromRow)]
struct SubUser {
    id: Uuid,
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
}

/// One assignment of the subscribing user: the node's public data and the
/// user's credentials on it (input of `render`).
#[derive(FromRow)]
pub struct NodeRow {
    pub name: String,
    pub xray_inbounds: Value,
    pub server_addr: Option<String>,
    pub credentials: Value,
    /// W11 (`nodemeta.rs`): user-facing name and tags (proxy names), and
    /// per-inbound client-facing host/port overrides.
    #[sqlx(default)]
    pub display_name: Option<String>,
    #[sqlx(default)]
    pub tags: Vec<String>,
    #[sqlx(default)]
    pub connect_overrides: Value,
}

#[derive(serde::Deserialize)]
struct Credential {
    inbound_tag: String,
    protocol: String,
    account: Value,
}

/// uTLS fingerprints a client library accepts for REALITY.
pub(crate) const FINGERPRINTS: &[&str] = &[
    "chrome",
    "firefox",
    "safari",
    "ios",
    "android",
    "edge",
    "360",
    "qq",
    "random",
    "randomized",
];
const DEFAULT_FINGERPRINT: &str = "chrome";

/// The admin's `realitySettings.fingerprint` hint when it is on the
/// allow-list, else the default. Most clients refuse REALITY without one.
fn reality_fingerprint(reality: Option<&Value>) -> String {
    reality
        .and_then(|t| t.get("fingerprint"))
        .and_then(|v| v.as_str())
        .filter(|f| FINGERPRINTS.contains(f))
        .unwrap_or(DEFAULT_FINGERPRINT)
        .to_string()
}

/// Which client formats a proxy can be expressed in (W8 matrix,
/// docs/DEPLOY.md §3c). A proxy a format cannot express is left out of that
/// format (logged) rather than rendered as a config the client rejects.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Omit {
    Clash,
    SingBox,
}

struct Net {
    port: u16,
    /// tcp | ws | httpupgrade | xhttp | grpc | hysteria (protocols::network)
    network: String,
    security: String, // none | tls | reality
    sni: String,
    public_key: String,
    short_id: String,
    /// uTLS client fingerprint (REALITY only; empty otherwise).
    fingerprint: String,
    /// ws / httpupgrade / xhttp path and Host.
    path: String,
    host: String,
    /// xhttp mode ("" = auto).
    mode: String,
    /// grpc serviceName.
    service_name: String,
}

fn net_from_inbound(inbound: &Value) -> Option<Net> {
    let port = u16::try_from(inbound.get("port")?.as_u64()?).ok()?;
    let ss = inbound.get("streamSettings");
    let get = |key: &str| ss.and_then(|s| s.get(key));
    let s = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_string();
    let network = crate::protocols::network(inbound);
    let security = crate::protocols::security(inbound);
    let sni = match security.as_str() {
        "tls" => s(get("tlsSettings").and_then(|t| t.get("serverName"))),
        "reality" => s(get("realitySettings")
            .and_then(|t| t.get("serverNames"))
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())),
        _ => String::new(),
    };
    let reality = get("realitySettings");
    let (public_key, short_id, fingerprint) = if security == "reality" {
        (
            s(reality.and_then(|t| t.get("publicKey"))),
            s(reality.and_then(|t| t.get("shortId"))),
            reality_fingerprint(reality),
        )
    } else {
        (String::new(), String::new(), String::new())
    };
    let ts = match network.as_str() {
        "ws" => get("wsSettings"),
        "httpupgrade" => get("httpupgradeSettings"),
        "xhttp" => get("xhttpSettings").or_else(|| get("splithttpSettings")),
        "grpc" => get("grpcSettings"),
        _ => None,
    };
    let (path, host, mode, service_name) = match network.as_str() {
        "ws" | "httpupgrade" | "xhttp" => {
            let p = s(ts.and_then(|w| w.get("path")));
            (
                if p.is_empty() { "/".into() } else { p },
                s(ts.and_then(|w| w.get("host")).or_else(|| {
                    ts.and_then(|w| w.get("headers"))
                        .and_then(|h| h.get("Host"))
                })),
                if network == "xhttp" {
                    s(ts.and_then(|w| w.get("mode")))
                } else {
                    String::new()
                },
                String::new(),
            )
        }
        "grpc" => (
            String::new(),
            String::new(),
            String::new(),
            s(ts.and_then(|g| g.get("serviceName"))),
        ),
        _ => (String::new(), String::new(), String::new(), String::new()),
    };
    Some(Net {
        port,
        network,
        security,
        sni,
        public_key,
        short_id,
        fingerprint,
        path,
        host,
        mode,
        service_name,
    })
}

struct Proxy {
    name: String,
    protocol: String,
    /// vless/vmess uuid, trojan password, shadowsocks "server_psk:user_key",
    /// hysteria auth.
    id_or_password: String,
    flow: String,
    /// shadowsocks method.
    method: String,
    /// shadowsocks: the inbound also serves UDP.
    udp: bool,
    server: String,
    net: Net,
}

impl Proxy {
    /// Why a format cannot carry this proxy, if it cannot.
    fn omitted_from(&self, f: Omit) -> Option<&'static str> {
        match (f, self.net.network.as_str(), self.protocol.as_str()) {
            (Omit::SingBox, "xhttp", _) => Some("sing-box has no xhttp transport"),
            (Omit::Clash, "xhttp", "vless") => None,
            (Omit::Clash, "xhttp", _) => Some("mihomo supports xhttp only for vless"),
            _ => None,
        }
    }
}

fn collect_proxies(rows: &[NodeRow]) -> Vec<Proxy> {
    let mut proxies: Vec<Proxy> = Vec::new();
    let mut names = HashSet::new();
    for row in rows {
        let node_server = row.server_addr.as_deref().filter(|s| !s.is_empty());
        let credentials: Vec<Credential> = match serde_json::from_value(row.credentials.clone()) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(node = %row.name, error = %e,
                    "node_users.credentials is not a valid credential list; node skipped in subscription");
                continue;
            }
        };
        let credentials_len = credentials.len();
        for cred in credentials {
            let Some(inbound) = row
                .xray_inbounds
                .as_array()
                .and_then(|arr| {
                    arr.iter()
                        .find(|i| i.get("tag").and_then(|t| t.as_str()) == Some(&cred.inbound_tag))
                })
                .cloned()
            else {
                continue;
            };
            let Some(mut net) = net_from_inbound(&inbound) else {
                continue;
            };
            // W11 连接地址/连接端口: what clients dial may differ from what
            // the inbound listens on (NAT, port forwarding, relays).
            let ov = crate::nodemeta::connect_for(&row.connect_overrides, &cred.inbound_tag);
            let Some(server) = ov.host.as_deref().or(node_server) else {
                continue; // admin has not set a public address yet
            };
            if let Some(p) = ov.port {
                net.port = p;
            }
            let acc = |k: &str| cred.account.get(k).and_then(|v| v.as_str());
            let mut method = String::new();
            let id_or_password = match cred.protocol.as_str() {
                "vless" | "vmess" => acc("id").map(String::from),
                "trojan" => acc("password").map(String::from),
                "hysteria" => acc("auth").map(String::from),
                "shadowsocks" => {
                    // SIP022 multi-user: "<server PSK>:<user key>".
                    method = inbound
                        .pointer("/settings/method")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let psk = inbound
                        .pointer("/settings/password")
                        .and_then(Value::as_str);
                    match (psk, acc("password")) {
                        (Some(psk), Some(user)) if !method.is_empty() => {
                            Some(format!("{psk}:{user}"))
                        }
                        _ => None,
                    }
                }
                _ => None,
            };
            let Some(id_or_password) = id_or_password else {
                continue;
            };
            // Vision only exists on raw TCP with TLS/REALITY; a stale flow
            // on any other transport would make clients fail.
            let flow = match acc("flow") {
                Some(f)
                    if net.network == "tcp"
                        && matches!(net.security.as_str(), "tls" | "reality") =>
                {
                    f
                }
                _ => "",
            };
            // W11: display name and tags when set ("香港 01 | IPLC"), the
            // inbound tag only when the node has several; names stay unique
            // across the subscription (clients key proxies by name).
            let name = if row.display_name.is_none() && row.tags.is_empty() {
                format!("{} · {}", row.name, cred.inbound_tag)
            } else {
                let base =
                    crate::nodemeta::public_name(&row.name, row.display_name.as_deref(), &row.tags);
                if credentials_len > 1 {
                    format!("{base} · {}", cred.inbound_tag)
                } else {
                    base
                }
            };
            let name = unique_name(&mut names, name);
            proxies.push(Proxy {
                name,
                protocol: cred.protocol.clone(),
                id_or_password,
                flow: flow.to_string(),
                method,
                udp: crate::protocols::l4(&inbound).1,
                server: server.to_string(),
                net,
            });
        }
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
fn encode_fragment(s: &str) -> String {
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

fn query_params(p: &Proxy, include_flow: bool) -> String {
    let mut params = vec![format!("type={}", p.net.network)];
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
    match p.net.network.as_str() {
        "ws" | "httpupgrade" | "xhttp" => {
            params.push(format!("path={}", encode_fragment(&p.net.path)));
            if !p.net.host.is_empty() {
                params.push(format!("host={}", p.net.host));
            }
            if p.net.network == "xhttp" {
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

fn render_links(proxies: &[Proxy]) -> String {
    let mut lines = Vec::new();
    for p in proxies {
        let frag = encode_fragment(&p.name);
        match p.protocol.as_str() {
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
                let (path, kind) = match p.net.network.as_str() {
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
                    "net": p.net.network,
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
            "shadowsocks" => lines.push(format!(
                "ss://{}:{}@{}:{}#{}",
                p.method,
                encode_fragment(&p.id_or_password),
                p.server,
                p.net.port,
                frag
            )),
            "hysteria" => lines.push(format!(
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

/// A YAML scalar: plain when it is a safe token, JSON-quoted otherwise
/// (a JSON string is a valid YAML double-quoted scalar).
fn yaml(s: &str) -> String {
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

fn log_omitted(p: &Proxy, format: &str, why: &str) {
    tracing::info!(proxy = %p.name, format, reason = why, "proxy left out of subscription format");
}

fn render_clash(proxies: &[Proxy]) -> String {
    let mut out = String::from("proxies:\n");
    let mut names = Vec::new();
    for p in proxies {
        if let Some(why) = p.omitted_from(Omit::Clash) {
            log_omitted(p, "clash", why);
            continue;
        }
        let kind = match p.protocol.as_str() {
            "shadowsocks" => "ss",
            "hysteria" => "hysteria2",
            other => other,
        };
        names.push(serde_json::to_string(&p.name).unwrap_or_else(|_| "\"proxy\"".into()));
        out.push_str("  - name: ");
        out.push_str(&serde_json::to_string(&p.name).unwrap_or_else(|_| "\"proxy\"".into()));
        out.push('\n');
        out.push_str(&format!("    type: {kind}\n"));
        out.push_str(&format!("    server: {}\n", p.server));
        out.push_str(&format!("    port: {}\n", p.net.port));
        match p.protocol.as_str() {
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
            "shadowsocks" => {
                out.push_str(&format!("    cipher: {}\n", p.method));
                out.push_str(&format!("    password: {}\n", yaml(&p.id_or_password)));
                out.push_str(&format!("    udp: {}\n", p.udp));
                continue;
            }
            "hysteria" => {
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
        let network = match p.net.network.as_str() {
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
        match p.net.network.as_str() {
            "ws" | "httpupgrade" => {
                out.push_str("    ws-opts:\n");
                out.push_str(&format!("      path: {}\n", yaml(&p.net.path)));
                if !p.net.host.is_empty() {
                    out.push_str("      headers:\n");
                    out.push_str(&format!("        Host: {}\n", p.net.host));
                }
                if p.net.network == "httpupgrade" {
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
    out.push_str("rules:\n  - MATCH,PROXY\n");
    out
}

fn render_sing_box(proxies: &[Proxy]) -> Value {
    let outbounds: Vec<Value> = proxies
        .iter()
        .filter(|p| match p.omitted_from(Omit::SingBox) {
            Some(why) => {
                log_omitted(p, "sing-box", why);
                false
            }
            None => true,
        })
        .map(|p| {
            let kind = match p.protocol.as_str() {
                "hysteria" => "hysteria2",
                other => other,
            };
            let mut obj = serde_json::Map::new();
            obj.insert("tag".into(), json!(p.name));
            obj.insert("type".into(), json!(kind));
            obj.insert("server".into(), json!(p.server));
            obj.insert("server_port".into(), json!(p.net.port));
            match p.protocol.as_str() {
                "vless" | "vmess" => {
                    obj.insert("uuid".into(), json!(p.id_or_password));
                    if p.protocol == "vless" && !p.flow.is_empty() {
                        obj.insert("flow".into(), json!(p.flow));
                    }
                }
                "trojan" => {
                    obj.insert("password".into(), json!(p.id_or_password));
                }
                "shadowsocks" => {
                    obj.insert("method".into(), json!(p.method));
                    obj.insert("password".into(), json!(p.id_or_password));
                    return Value::Object(obj);
                }
                "hysteria" => {
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
            match p.net.network.as_str() {
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

/// Round the response body up to fixed-size buckets so subscription size
/// does not reveal node/user counts.
fn pad(body: String) -> String {
    let target = (body.len().div_ceil(4096) * 4096).max(8192);
    let mut body = body;
    while body.len() < target {
        body.push('\n');
    }
    body
}

/// The subscription body for `user_agent` (format by UA) and its content
/// type, padded (`pad`). Pure: the request path and the benchmarks share it.
pub fn render(user_agent: &str, rows: &[NodeRow]) -> (&'static str, String) {
    render_for(None, user_agent, rows)
}

/// `render` with the URL's query string (`requested_format`) taking
/// precedence over the User-Agent.
pub fn render_for(
    query: Option<&str>,
    user_agent: &str,
    rows: &[NodeRow],
) -> (&'static str, String) {
    let format = requested_format(query).unwrap_or_else(|| detect_format(user_agent));
    let proxies = collect_proxies(rows);
    let body = match format {
        Format::SingBox => render_sing_box(&proxies).to_string(),
        Format::Clash => render_clash(&proxies),
        Format::Links => render_links(&proxies),
    };
    let content_type = match format {
        Format::SingBox => "application/json; charset=utf-8",
        Format::Clash => "text/yaml; charset=utf-8",
        Format::Links => "text/plain; charset=utf-8",
    };
    (content_type, pad(body))
}

/// GET /{prefix}/sub/{token} — the client-facing subscription. The token is
/// the credential; no cookie or other auth applies. Any failure (unknown
/// token, disabled or expired user, rate limit) returns the same empty 404
/// rejection as everything else, and success headers are only sent on
/// success.
///
/// Rate limit (M1-10, `[sub]` config): per client address (IPv6 per /64)
/// checked first, then per token — the per-token counter is only created
/// for tokens that belong to a served user, so junk tokens cannot multiply
/// Valkey keys (per-address keys are bounded by the distinct addresses
/// seen in a window). Over a limit = the canonical rejection, never 429.
/// If Valkey is unreachable the limit fails open (subscriptions keep
/// working; logged).
///
/// The token never reaches a log line: nothing here logs it, and request
/// paths that are logged anywhere must go through `web::redacted_path`.
pub async fn subscription(
    State(state): State<AppState>,
    MaybeClientIp(client): MaybeClientIp,
    Path((_, token)): Path<(String, String)>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    let limits = &state.cfg().sub;
    if let Some(ip) = client {
        let key = format!("akari:rl:sub:ip:{}", crate::client_ip::bucket(ip));
        if !within_limit(&state, key, limits.rate_per_ip, limits.rate_window_secs).await {
            return reject::not_found();
        }
    }
    if !plausible_token(&token) {
        return reject::not_found();
    }
    let hash = hash_token(&token);

    // Only served users (role=user, enabled, not expired; enforce::SERVED).
    let user = match sqlx::query_as::<_, SubUser>(sqlx::AssertSqlSafe(format!(
        "SELECT u.id, u.traffic_used_bytes, u.traffic_limit_bytes, u.expires_at \
         FROM users u WHERE u.sub_token_hash = $1 AND {}",
        crate::enforce::SERVED
    )))
    .bind(&hash)
    .fetch_optional(state.pg())
    .await
    {
        Ok(Some(user)) => user,
        Ok(None) => return reject::not_found(),
        Err(e) => {
            tracing::error!(error = %e, "subscription db error");
            return reject::not_found();
        }
    };
    // Keyed by user id (bounded by the number of users; a rotated token
    // does not reset the user's window).
    let key = format!("akari:rl:sub:user:{}", user.id);
    if !within_limit(&state, key, limits.rate_per_token, limits.rate_window_secs).await {
        return reject::not_found();
    }
    let rows = match sqlx::query_as::<_, NodeRow>(
        "SELECT n.name, n.xray_inbounds, \
         COALESCE(NULLIF(n.server_addr, ''), n.tls_domain) AS server_addr, nu.credentials, \
         n.display_name, n.tags, n.connect_overrides \
         FROM node_users nu \
         JOIN nodes n ON n.id = nu.node_id AND n.enabled = true AND n.visible \
         JOIN users u ON u.id = nu.user_id AND u.enabled = true \
         WHERE nu.user_id = $1 \
         ORDER BY n.sort, coalesce(n.display_name, n.name), n.id",
    )
    .bind(user.id)
    .fetch_all(state.pg())
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(error = %e, "subscription db error");
            return reject::not_found();
        }
    };

    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let (content_type, body) = render_for(query.as_deref(), user_agent, &rows);

    // Quota header only after every failure path is cleared.
    let expire = user
        .expires_at
        .map(|t| format!("expire={}", t.timestamp()))
        .unwrap_or_else(|| "expire=0".into());
    let userinfo = format!(
        "upload=0; download={}; total={}; {expire}",
        user.traffic_used_bytes,
        user.traffic_limit_bytes.unwrap_or(0)
    );

    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (
                header::HeaderName::from_static("subscription-userinfo"),
                HeaderValue::from_str(&userinfo)
                    .unwrap_or_else(|_| HeaderValue::from_static("upload=0; download=0; total=0")),
            ),
            (
                header::HeaderName::from_static("profile-update-interval"),
                HeaderValue::from_static("24"),
            ),
            (
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"akari\""),
            ),
        ],
        body,
    )
        .into_response()
}

async fn within_limit(state: &AppState, key: String, limit: i64, window: i64) -> bool {
    match crate::rate::hit(state, key, limit, window).await {
        Ok(ok) => ok,
        Err(e) => {
            tracing::warn!(error = %e, "subscription rate limit unavailable (failing open)");
            true
        }
    }
}

/// Mint a new subscription token for a user (the old one stops working at
/// commit), in the caller's transaction, audited ("user.sub_token.rotate"
/// with no token material). The database keeps its SHA-256 (lookup) and,
/// W20, its ciphertext (`users.sub_token_enc`, `totp::Keys::seal_sub_token`)
/// so the owner can see the link again. `None` if the user does not exist.
pub async fn rotate_token(
    conn: &mut sqlx::PgConnection,
    keys: &crate::totp::Keys,
    actor: &crate::audit::Actor,
    user_id: Uuid,
) -> anyhow::Result<Option<String>> {
    let token = generate_token();
    let enc = keys.seal_sub_token(user_id, &token)?;
    let n = sqlx::query("UPDATE users SET sub_token_hash = $2, sub_token_enc = $3 WHERE id = $1")
        .bind(user_id)
        .bind(hash_token(&token))
        .bind(&enc)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if n == 0 {
        return Ok(None);
    }
    crate::audit::record(
        conn,
        actor,
        "user.sub_token.rotate",
        "user",
        Some(user_id.to_string()),
        None,
        Some(json!({ "sub_token": crate::audit::CHANGED })),
    )
    .await?;
    Ok(Some(token))
}

/// W20: what the panel can show about an account's subscription link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stored {
    /// The working token (decrypted, and its hash matches the lookup hash).
    Ready(String),
    /// A token works but cannot be shown: issued before 0120 (hash only),
    /// or the ciphertext does not open (data/totp.key changed). Only a
    /// reset gives a showable link; it is never rotated implicitly.
    Legacy,
}

#[derive(FromRow)]
struct StoredRow {
    sub_token_hash: Option<String>,
    sub_token_enc: Option<Vec<u8>>,
}

/// W20: the account's subscription token, issuing one if the account has
/// none at all (no working link exists, so nothing is disrupted: audited
/// "user.sub_token.issue" by `actor`). An existing token is never replaced
/// here. `None` if the user does not exist. Runs in the caller's
/// transaction; the conditional UPDATE (`sub_token_hash IS NULL`) makes
/// concurrent first reads issue exactly one token.
pub async fn ensure_token(
    conn: &mut sqlx::PgConnection,
    keys: &crate::totp::Keys,
    actor: &crate::audit::Actor,
    user_id: Uuid,
) -> anyhow::Result<Option<Stored>> {
    for _ in 0..2 {
        let Some(row) = sqlx::query_as::<_, StoredRow>(
            "SELECT sub_token_hash, sub_token_enc FROM users WHERE id = $1",
        )
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?
        else {
            return Ok(None);
        };
        match (row.sub_token_hash, row.sub_token_enc) {
            (Some(hash), Some(enc)) => {
                return Ok(Some(match keys.open_sub_token(user_id, &enc) {
                    Some(t) if hash_token(&t) == hash => Stored::Ready(t),
                    _ => {
                        tracing::error!(user = %user_id,
                            "stored subscription token does not open (data/totp.key changed?); \
                             the user must reset the link to see it");
                        Stored::Legacy
                    }
                }));
            }
            (Some(_), None) => return Ok(Some(Stored::Legacy)),
            (None, _) => {
                let token = generate_token();
                let enc = keys.seal_sub_token(user_id, &token)?;
                let n = sqlx::query(
                    "UPDATE users SET sub_token_hash = $2, sub_token_enc = $3 \
                     WHERE id = $1 AND sub_token_hash IS NULL",
                )
                .bind(user_id)
                .bind(hash_token(&token))
                .bind(&enc)
                .execute(&mut *conn)
                .await?
                .rows_affected();
                if n == 1 {
                    crate::audit::record(
                        conn,
                        actor,
                        "user.sub_token.issue",
                        "user",
                        Some(user_id.to_string()),
                        None,
                        Some(json!({ "sub_token": crate::audit::CHANGED })),
                    )
                    .await?;
                    return Ok(Some(Stored::Ready(token)));
                }
                // Issued concurrently: read what the other request stored.
            }
        }
    }
    Ok(Some(Stored::Legacy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::http::{rand_ip, Client};
    use crate::testdb::TestDb;
    use axum::http::StatusCode;
    use fred::prelude::KeysInterface;

    fn reality_proxy(inbound_fp: Option<&str>) -> Proxy {
        let mut rs = json!({
            "serverNames": ["www.apple.com"],
            "publicKey": "PUB",
            "shortId": "ab12",
        });
        if let Some(f) = inbound_fp {
            rs["fingerprint"] = json!(f);
        }
        let inbound = json!({
            "port": 443,
            "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": rs},
        });
        Proxy {
            name: "n".into(),
            protocol: "vless".into(),
            id_or_password: "u".into(),
            flow: "xtls-rprx-vision".into(),
            method: String::new(),
            udp: false,
            server: "s.example".into(),
            net: net_from_inbound(&inbound).unwrap(),
        }
    }

    #[test]
    fn reality_renders_utls_fingerprint_in_all_formats() {
        for (hint, want) in [
            (None, "chrome"),
            (Some("firefox"), "firefox"),
            (Some("bogus"), "chrome"),
            (Some(""), "chrome"),
        ] {
            let p = [reality_proxy(hint)];
            let links = String::from_utf8(STANDARD.decode(render_links(&p)).unwrap()).unwrap();
            assert!(links.contains(&format!("&fp={want}")), "{links}");
            assert!(render_clash(&p).contains(&format!("    client-fingerprint: {want}\n")));
            let sb = render_sing_box(&p);
            assert_eq!(sb["outbounds"][0]["tls"]["utls"]["fingerprint"], want);
            assert_eq!(sb["outbounds"][0]["tls"]["utls"]["enabled"], true);
        }
    }

    #[test]
    fn non_reality_has_no_fingerprint() {
        let inbound = json!({"port": 1, "streamSettings": {"network": "tcp"}});
        let p = [Proxy {
            name: "n".into(),
            protocol: "vless".into(),
            id_or_password: "u".into(),
            flow: String::new(),
            method: String::new(),
            udp: false,
            server: "s".into(),
            net: net_from_inbound(&inbound).unwrap(),
        }];
        let links = String::from_utf8(STANDARD.decode(render_links(&p)).unwrap()).unwrap();
        assert!(!links.contains("fp="));
        assert!(!render_clash(&p).contains("client-fingerprint"));
        assert!(render_sing_box(&p)["outbounds"][0].get("tls").is_none());
    }

    /// A user on one node with a REALITY vless, a websocket vmess and a TLS
    /// trojan inbound (every protocol and transport the renderers branch on).
    fn snapshot_rows() -> Vec<NodeRow> {
        let inbounds = json!([
            {"tag": "in-vless", "protocol": "vless", "port": 443, "streamSettings": {
                "network": "tcp", "security": "reality",
                "realitySettings": {"serverNames": ["www.apple.com"], "publicKey": "PUBKEY",
                                    "shortId": "ab12", "fingerprint": "firefox"}}},
            {"tag": "in-vmess", "protocol": "vmess", "port": 8443, "streamSettings": {
                "network": "ws", "security": "none",
                "wsSettings": {"path": "/ws", "headers": {"Host": "cdn.example.com"}}}},
            {"tag": "in-trojan", "protocol": "trojan", "port": 9443, "streamSettings": {
                "network": "tcp", "security": "tls",
                "tlsSettings": {"serverName": "t.example.com"}}},
        ]);
        let creds = json!([
            {"inbound_tag": "in-vless", "protocol": "vless", "account":
                {"id": "11111111-1111-1111-1111-111111111111", "flow": "xtls-rprx-vision"}},
            {"inbound_tag": "in-vmess", "protocol": "vmess", "account":
                {"id": "22222222-2222-2222-2222-222222222222"}},
            {"inbound_tag": "in-trojan", "protocol": "trojan", "account": {"password": "pw"}},
        ]);
        vec![NodeRow {
            name: "HK 1".into(),
            xray_inbounds: inbounds,
            server_addr: Some("hk.example.com".into()),
            credentials: creds,
            display_name: None,
            tags: vec![],
            connect_overrides: Value::Null,
        }]
    }

    /// A10: the three renderers' exact output (any change to a client-facing
    /// format must be deliberate), plus UA routing, content types and the
    /// padding bucket.
    #[test]
    fn three_formats_snapshot() {
        let rows = snapshot_rows();

        let (ct, body) = render("Shadowrocket/2.2", &rows);
        assert_eq!(ct, "text/plain; charset=utf-8");
        assert_eq!(body.len(), 8192, "padded to the 8 KiB minimum bucket");
        let links = String::from_utf8(STANDARD.decode(body.trim_end()).unwrap()).unwrap();
        let lines: Vec<&str> = links.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(
            lines[0],
            "vless://11111111-1111-1111-1111-111111111111@hk.example.com:443?type=tcp&security=reality\
             &flow=xtls-rprx-vision&sni=www.apple.com&pbk=PUBKEY&sid=ab12&fp=firefox#HK%201%20%C2%B7%20in-vless"
        );
        let vmess: Value = serde_json::from_slice(
            &STANDARD
                .decode(lines[1].strip_prefix("vmess://").unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            vmess,
            json!({"add": "hk.example.com", "aid": "0", "host": "cdn.example.com",
                   "id": "22222222-2222-2222-2222-222222222222", "net": "ws", "path": "/ws",
                   "port": "8443", "ps": "HK 1 · in-vmess", "scy": "auto", "sni": "", "tls": "",
                   "type": "none", "v": "2"})
        );
        assert_eq!(
            lines[2],
            "trojan://pw@hk.example.com:9443?type=tcp&security=tls&sni=t.example.com#HK%201%20%C2%B7%20in-trojan"
        );

        let (ct, body) = render("clash.meta", &rows);
        assert_eq!(ct, "text/yaml; charset=utf-8");
        assert_eq!(
            body.trim_end(),
            r#"proxies:
  - name: "HK 1 · in-vless"
    type: vless
    server: hk.example.com
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    flow: xtls-rprx-vision
    network: tcp
    tls: true
    servername: www.apple.com
    client-fingerprint: firefox
    reality-opts:
      public-key: PUBKEY
      short-id: ab12
  - name: "HK 1 · in-vmess"
    type: vmess
    server: hk.example.com
    port: 8443
    uuid: 22222222-2222-2222-2222-222222222222
    alterId: 0
    cipher: auto
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: cdn.example.com
  - name: "HK 1 · in-trojan"
    type: trojan
    server: hk.example.com
    port: 9443
    password: pw
    network: tcp
    tls: true
    sni: t.example.com
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - "HK 1 · in-vless"
      - "HK 1 · in-vmess"
      - "HK 1 · in-trojan"
rules:
  - MATCH,PROXY"#
        );

        let (ct, body) = render("sing-box 1.12", &rows);
        assert_eq!(ct, "application/json; charset=utf-8");
        let want = json!({"outbounds": [
            {"flow": "xtls-rprx-vision", "server": "hk.example.com", "server_port": 443,
             "tag": "HK 1 · in-vless",
             "tls": {"enabled": true, "reality": {"enabled": true, "public_key": "PUBKEY", "short_id": "ab12"},
                     "server_name": "www.apple.com", "utls": {"enabled": true, "fingerprint": "firefox"}},
             "type": "vless", "uuid": "11111111-1111-1111-1111-111111111111"},
            {"server": "hk.example.com", "server_port": 8443, "tag": "HK 1 · in-vmess",
             "transport": {"headers": {"Host": "cdn.example.com"}, "path": "/ws", "type": "ws"},
             "type": "vmess", "uuid": "22222222-2222-2222-2222-222222222222"},
            {"password": "pw", "server": "hk.example.com", "server_port": 9443, "tag": "HK 1 · in-trojan",
             "tls": {"enabled": true, "server_name": "t.example.com"}, "type": "trojan"},
            {"tag": "direct", "type": "direct"}]});
        assert_eq!(
            serde_json::from_str::<Value>(body.trim_end()).unwrap(),
            want
        );
    }

    /// W8 matrix rows: every new protocol/transport the renderers branch on.
    fn matrix_rows() -> Vec<NodeRow> {
        let inbounds = json!([
            {"tag": "rx", "protocol": "vless", "port": 443, "streamSettings": {
                "network": "xhttp", "security": "reality", "xhttpSettings": {"path": "/xh", "mode": "stream-one"},
                "realitySettings": {"serverNames": ["www.apple.com"], "publicKey": "PUB", "shortId": "ab"}}},
            {"tag": "hu", "protocol": "vless", "port": 2083, "streamSettings": {
                "network": "httpupgrade", "security": "tls", "httpupgradeSettings": {"path": "/up", "host": "n.example.com"},
                "tlsSettings": {"serverName": "n.example.com"}}},
            {"tag": "gr", "protocol": "trojan", "port": 2087, "streamSettings": {
                "network": "grpc", "security": "tls", "grpcSettings": {"serviceName": "svc"},
                "tlsSettings": {"serverName": "n.example.com"}}},
            {"tag": "vg", "protocol": "vmess", "port": 2096, "streamSettings": {
                "network": "grpc", "grpcSettings": {"serviceName": "vs"}}},
            {"tag": "vx", "protocol": "vmess", "port": 8080, "streamSettings": {
                "network": "xhttp", "xhttpSettings": {"path": "/vx"}}},
            {"tag": "ss", "protocol": "shadowsocks", "port": 8388, "settings": {
                "method": "2022-blake3-aes-128-gcm", "password": "+/+/+/+/+/+/+/+/+/+/+w==", "clients": [], "network": "tcp,udp"}},
            {"tag": "hy", "protocol": "hysteria", "port": 443, "settings": {"version": 2},
             "streamSettings": {"network": "hysteria", "security": "tls", "tlsSettings": {"serverName": "n.example.com"},
                                "hysteriaSettings": {"version": 2}}},
            {"tag": "ws", "protocol": "vless", "port": 8443, "streamSettings": {"network": "ws", "wsSettings": {"path": "/w"}}},
        ]);
        let creds = json!([
            {"inbound_tag": "rx", "protocol": "vless", "account": {"id": "11111111-1111-1111-1111-111111111111", "flow": ""}},
            {"inbound_tag": "hu", "protocol": "vless", "account": {"id": "22222222-2222-2222-2222-222222222222", "flow": ""}},
            {"inbound_tag": "gr", "protocol": "trojan", "account": {"password": "tp"}},
            {"inbound_tag": "vg", "protocol": "vmess", "account": {"id": "33333333-3333-3333-3333-333333333333"}},
            {"inbound_tag": "vx", "protocol": "vmess", "account": {"id": "44444444-4444-4444-4444-444444444444"}},
            {"inbound_tag": "ss", "protocol": "shadowsocks", "account": {"password": "dXNlcmtleXVzZXJrZXkxMg=="}},
            {"inbound_tag": "hy", "protocol": "hysteria", "account": {"auth": "a1b2"}},
            // A stale Vision flow on a ws inbound is never rendered.
            {"inbound_tag": "ws", "protocol": "vless", "account": {"id": "55555555-5555-5555-5555-555555555555", "flow": "xtls-rprx-vision"}},
        ]);
        vec![NodeRow {
            name: "N".into(),
            xray_inbounds: inbounds,
            server_addr: Some("n.example.com".into()),
            credentials: creds,
            display_name: None,
            tags: vec![],
            connect_overrides: Value::Null,
        }]
    }

    #[test]
    fn w8_matrix_links() {
        let (_, body) = render("v2rayN/7", &matrix_rows());
        let links = String::from_utf8(STANDARD.decode(body.trim_end()).unwrap()).unwrap();
        let l: Vec<&str> = links.lines().collect();
        assert_eq!(l.len(), 8);
        assert_eq!(l[0], "vless://11111111-1111-1111-1111-111111111111@n.example.com:443?type=xhttp&security=reality\
            &sni=www.apple.com&pbk=PUB&sid=ab&fp=chrome&path=%2Fxh&mode=stream-one#N%20%C2%B7%20rx");
        assert_eq!(l[1], "vless://22222222-2222-2222-2222-222222222222@n.example.com:2083?type=httpupgrade&security=tls\
            &sni=n.example.com&path=%2Fup&host=n.example.com#N%20%C2%B7%20hu");
        assert_eq!(
            l[2],
            "trojan://tp@n.example.com:2087?type=grpc&security=tls&sni=n.example.com\
            &serviceName=svc&mode=gun#N%20%C2%B7%20gr"
        );
        let vm = |s: &str| -> Value {
            serde_json::from_slice(
                &STANDARD
                    .decode(s.strip_prefix("vmess://").unwrap())
                    .unwrap(),
            )
            .unwrap()
        };
        let g = vm(l[3]);
        assert_eq!(
            (g["net"].as_str(), g["path"].as_str(), g["type"].as_str()),
            (Some("grpc"), Some("vs"), Some("gun"))
        );
        let x = vm(l[4]);
        assert_eq!(
            (x["net"].as_str(), x["path"].as_str(), x["type"].as_str()),
            (Some("xhttp"), Some("/vx"), Some("auto"))
        );
        assert_eq!(l[5], "ss://2022-blake3-aes-128-gcm:%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2Bw%3D%3D%3AdXNlcmtleXVzZXJrZXkxMg%3D%3D\
            @n.example.com:8388#N%20%C2%B7%20ss");
        assert_eq!(
            l[6],
            "hysteria2://a1b2@n.example.com:443/?sni=n.example.com#N%20%C2%B7%20hy"
        );
        assert_eq!(l[7], "vless://55555555-5555-5555-5555-555555555555@n.example.com:8443?type=ws&path=%2Fw#N%20%C2%B7%20ws");
    }

    #[test]
    fn w8_matrix_clash() {
        let (_, body) = render("mihomo/1.19", &matrix_rows());
        let y = body.trim_end();
        // vmess+xhttp has no mihomo equivalent: left out (and out of the group).
        assert!(!y.contains("N · vx"), "{y}");
        for want in [
            "  - name: \"N · rx\"\n    type: vless\n    server: n.example.com\n    port: 443\n    uuid: 11111111-1111-1111-1111-111111111111\n    network: xhttp\n    tls: true\n    servername: www.apple.com\n    client-fingerprint: chrome\n    reality-opts:\n      public-key: PUB\n      short-id: ab\n    xhttp-opts:\n      path: /xh\n      mode: stream-one\n",
            "    network: ws\n    tls: true\n    servername: n.example.com\n    ws-opts:\n      path: /up\n      headers:\n        Host: n.example.com\n      v2ray-http-upgrade: true\n",
            "    type: trojan\n    server: n.example.com\n    port: 2087\n    password: tp\n    network: grpc\n    tls: true\n    sni: n.example.com\n    grpc-opts:\n      grpc-service-name: svc\n",
            "    type: vmess\n    server: n.example.com\n    port: 2096\n    uuid: 33333333-3333-3333-3333-333333333333\n    alterId: 0\n    cipher: auto\n    network: grpc\n    grpc-opts:\n      grpc-service-name: vs\n",
            "  - name: \"N · ss\"\n    type: ss\n    server: n.example.com\n    port: 8388\n    cipher: 2022-blake3-aes-128-gcm\n    password: \"+/+/+/+/+/+/+/+/+/+/+w==:dXNlcmtleXVzZXJrZXkxMg==\"\n    udp: true\n",
            "  - name: \"N · hy\"\n    type: hysteria2\n    server: n.example.com\n    port: 443\n    password: a1b2\n    sni: n.example.com\n    alpn:\n      - h3\n",
            "    uuid: 55555555-5555-5555-5555-555555555555\n    network: ws\n    ws-opts:\n      path: /w\n",
        ] {
            assert!(y.contains(want), "missing:\n{want}\nin:\n{y}");
        }
        assert!(!y.contains("flow:"), "stale vision flow rendered: {y}");
        // 7 proxies (+ the PROXY group's own "- name:"), all in the group.
        assert_eq!(y.matches("  - name: ").count(), 8);
        assert_eq!(y.matches("      - \"N · ").count(), 7);
    }

    #[test]
    fn w8_matrix_sing_box() {
        let (_, body) = render("sing-box/1.12", &matrix_rows());
        let v: Value = serde_json::from_str(body.trim_end()).unwrap();
        let ob = v["outbounds"].as_array().unwrap();
        let tags: Vec<&str> = ob.iter().filter_map(|o| o["tag"].as_str()).collect();
        // Both xhttp proxies are left out (sing-box has no xhttp).
        assert_eq!(
            tags,
            ["N · hu", "N · gr", "N · vg", "N · ss", "N · hy", "N · ws", "direct"]
        );
        assert_eq!(
            ob[0]["transport"],
            json!({"type": "httpupgrade", "path": "/up", "host": "n.example.com"})
        );
        assert_eq!(
            ob[1]["transport"],
            json!({"type": "grpc", "service_name": "svc"})
        );
        assert_eq!(
            ob[2]["transport"],
            json!({"type": "grpc", "service_name": "vs"})
        );
        assert_eq!(
            ob[3],
            json!({"tag": "N · ss", "type": "shadowsocks", "server": "n.example.com", "server_port": 8388,
            "method": "2022-blake3-aes-128-gcm", "password": "+/+/+/+/+/+/+/+/+/+/+w==:dXNlcmtleXVzZXJrZXkxMg=="})
        );
        assert_eq!(
            ob[4],
            json!({"tag": "N · hy", "type": "hysteria2", "server": "n.example.com", "server_port": 443,
            "password": "a1b2", "tls": {"enabled": true, "server_name": "n.example.com", "alpn": ["h3"]}})
        );
        assert!(ob[5].get("flow").is_none());
    }

    /// W11: display name + tags name the proxies (the inbound tag only on
    /// multi-inbound nodes), connect overrides set the dialed host/port in
    /// all three formats, a node with only an override host is served, and
    /// equal names stay unique.
    #[test]
    fn w11_names_and_connect_overrides() {
        let mut rows = snapshot_rows();
        rows[0].display_name = Some("香港 01".into());
        rows[0].tags = vec!["IPLC".into(), "0.5x".into()];
        rows[0].connect_overrides =
            json!({"in-trojan": {"host": "relay.example.net", "port": 30443}});
        let single = |name: &str, server: Option<&str>| NodeRow {
            name: name.into(),
            xray_inbounds: json!([{"tag": "t", "protocol": "trojan", "port": 443,
                "streamSettings": {"network": "tcp", "security": "tls",
                    "tlsSettings": {"serverName": "x.example.com"}}}]),
            server_addr: server.map(String::from),
            credentials: json!([{"inbound_tag": "t", "protocol": "trojan",
                "account": {"password": "p"}}]),
            display_name: Some("东京".into()),
            tags: vec![],
            connect_overrides: if server.is_none() {
                json!({"t": {"host": "nat.example.org"}})
            } else {
                Value::Null
            },
        };
        rows.push(single("jp-1", Some("jp1.example.com")));
        rows.push(single("jp-2", None));
        let proxies = collect_proxies(&rows);
        let names: Vec<&str> = proxies.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "香港 01 | IPLC | 0.5x · in-vless",
                "香港 01 | IPLC | 0.5x · in-vmess",
                "香港 01 | IPLC | 0.5x · in-trojan",
                "东京",
                "东京 #2",
            ]
        );
        let trojan = &proxies[2];
        assert_eq!(
            (trojan.server.as_str(), trojan.net.port),
            ("relay.example.net", 30443)
        );
        assert_eq!(
            (proxies[0].server.as_str(), proxies[0].net.port),
            ("hk.example.com", 443)
        );
        assert_eq!(proxies[4].server, "nat.example.org");
        assert_eq!(proxies[4].net.port, 443);

        let (_, clash) = render("clash.meta", &rows);
        assert!(
            clash.contains("server: relay.example.net\n    port: 30443\n"),
            "{clash}"
        );
        let (_, links) = render("v2rayN", &rows);
        let links = String::from_utf8(STANDARD.decode(links.trim_end()).unwrap_or_default())
            .unwrap_or(links);
        assert!(links.contains("@relay.example.net:30443"), "{links}");
        let (_, sb) = render("sing-box", &rows);
        assert!(sb.contains("\"server\":\"relay.example.net\""), "{sb}");
        assert!(sb.contains("\"server_port\":30443"), "{sb}");
    }

    #[test]
    fn yaml_scalars() {
        assert_eq!(yaml("/ws"), "/ws");
        assert_eq!(yaml("svc"), "svc");
        assert_eq!(yaml("123"), "\"123\"");
        assert_eq!(yaml("true"), "\"true\"");
        assert_eq!(yaml("a:b"), "\"a:b\"");
        assert_eq!(yaml("-x"), "\"-x\"");
        assert_eq!(yaml(""), "\"\"");
        assert_eq!(yaml("1e5"), "\"1e5\"");
    }

    #[test]
    fn ua_routing_and_padding_buckets() {
        for (ua, ct) in [
            ("sing-box/1.9", "application/json; charset=utf-8"),
            ("Stash/2.0", "text/yaml; charset=utf-8"),
            ("mihomo", "text/yaml; charset=utf-8"),
            ("ClashX", "text/yaml; charset=utf-8"),
            ("curl/8", "text/plain; charset=utf-8"),
            ("", "text/plain; charset=utf-8"),
        ] {
            assert_eq!(render(ua, &snapshot_rows()).0, ct, "{ua}");
        }
        assert_eq!(pad("x".into()).len(), 8192);
        assert_eq!(pad("x".repeat(8192)).len(), 8192);
        assert_eq!(pad("x".repeat(8193)).len(), 12288);
    }

    /// W20: `?format=` beats the User-Agent; anything unrecognised falls
    /// back to UA detection (never a rejection).
    #[test]
    fn query_format_overrides_user_agent() {
        let rows = snapshot_rows();
        for (q, ua, ct) in [
            (Some("format=clash"), "curl/8", "text/yaml; charset=utf-8"),
            (Some("format=sing-box"), "clash.meta", "application/json; charset=utf-8"),
            (Some("format=singbox"), "", "application/json; charset=utf-8"),
            (Some("x=1&format=links"), "mihomo", "text/plain; charset=utf-8"),
            (Some("format=base64"), "sing-box", "text/plain; charset=utf-8"),
            (Some("format=CLASH"), "sing-box", "application/json; charset=utf-8"),
            (Some("format=yaml"), "", "text/plain; charset=utf-8"),
            (Some(""), "mihomo", "text/yaml; charset=utf-8"),
            (None, "mihomo", "text/yaml; charset=utf-8"),
        ] {
            assert_eq!(render_for(q, ua, &rows).0, ct, "{q:?} {ua}");
        }
        assert_eq!(
            render_for(Some("format=clash"), "", &rows).1,
            render("clash.meta", &rows).1
        );
    }

    async fn user_with_token(db: &TestDb) -> (Uuid, String) {
        let u = db.user().await;
        let token = generate_token();
        sqlx::query("UPDATE users SET sub_token_hash = $2 WHERE id = $1")
            .bind(u)
            .bind(hash_token(&token))
            .execute(&db.pool)
            .await
            .unwrap();
        (u, token)
    }

    /// M1-10: over either limit the subscription answers the canonical
    /// rejection — the same bytes as a junk URL or an unknown token, no
    /// 429, no quota headers — while other clients/tokens are unaffected.
    #[tokio::test]
    async fn over_limit_is_byte_identical_to_junk() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test_with(db.pool.clone(), |c| {
            c.sub.rate_per_token = 3;
            c.sub.rate_per_ip = 5;
        })
        .await;
        let (u, token) = user_with_token(&db).await;
        let (u2, token2) = user_with_token(&db).await;
        let a = Client::new(&state, rand_ip());
        let b = Client::new(&state, rand_ip());
        let junk = a.get("/test/definitely-not-here").await.fingerprint();
        assert_eq!(junk.0, StatusCode::NOT_FOUND);
        assert!(junk.1.is_empty() && junk.2.is_empty(), "{junk:?}");
        let unknown = format!("/test/sub/{}", generate_token());
        assert_eq!(b.get(&unknown).await.fingerprint(), junk);
        // Per token (any address): 3 fetches, then the rejection.
        for c in [&a, &b, &a] {
            let r = c.get(&format!("/test/sub/{token}")).await;
            assert_eq!(r.status, StatusCode::OK);
            assert!(r.headers.contains_key("subscription-userinfo"));
        }
        assert_eq!(
            b.get(&format!("/test/sub/{token}")).await.fingerprint(),
            junk
        );
        assert_eq!(
            b.get(&format!("/test/sub/{token2}")).await.status,
            StatusCode::OK
        );
        // Per address: a has made 1 junk + 2 token + ... requests; exhaust it.
        let mut n = 0;
        while a.get(&unknown).await.fingerprint() == junk {
            n += 1;
            if n > 10 {
                break;
            }
            // Keep going until a valid token is refused for this address.
            let r = a.get(&format!("/test/sub/{token2}")).await;
            if r.status != StatusCode::OK {
                assert_eq!(r.fingerprint(), junk);
                break;
            }
        }
        assert_eq!(
            a.get(&format!("/test/sub/{token2}")).await.fingerprint(),
            junk
        );
        // Another address still gets token2.
        let c = Client::new(&state, rand_ip());
        assert_eq!(
            c.get(&format!("/test/sub/{token2}")).await.status,
            StatusCode::OK
        );
        // Implausible tokens never touch Valkey or the database.
        assert_eq!(c.get("/test/sub/short").await.fingerprint(), junk);
        let mut keys = vec![
            format!("akari:rl:sub:user:{u}"),
            format!("akari:rl:sub:user:{u2}"),
        ];
        for cl in [&a, &b, &c] {
            keys.push(format!(
                "akari:rl:sub:ip:{}",
                crate::client_ip::bucket(cl.ip)
            ));
        }
        let _: i64 = state.valkey().del(keys).await.unwrap();
        drop(state);
        db.drop().await;
    }
}
