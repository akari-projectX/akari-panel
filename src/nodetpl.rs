//! Inbound templates for the node form (R18-2; W8 protocol matrix, see
//! protocols.rs and docs/DEPLOY.md §3d).
//!
//! The admin picks protocol templates and ports; the panel renders the
//! xray inbounds JSON server-side (REALITY key pairs and short ids are
//! generated here), and the result goes through the same validation and
//! the same `apply_set_inbounds` as hand-written JSON. Templates only
//! produce JSON: nothing about a node remembers which template made it.
//!
//! TLS (not REALITY) templates read the certificate the admin puts on the
//! node: `/etc/akari-agent/tls/{fullchain,privkey}.pem`, handed to the
//! agent as systemd credentials by the installer's drop-in
//! (`LoadCredential=tls:/etc/akari-agent/tls` → files appear as
//! `$CREDENTIALS_DIRECTORY/tls_<file>`). The agent runs as a dynamic user
//! under ProtectSystem=strict and cannot read root-owned key files any
//! other way. W10: when the node has a TLS domain (`nodes.tls_domain`,
//! "节点域名") the agent (protocol 6) obtains and renews the certificate for
//! it over ACME and serves it to exactly these entries (the JSON stays the
//! same; ConfigSnapshot.acme); templates then default their domain to it
//! and refuse another one (the certificate covers only that name). A WS
//! inbound behind the node's own reverse proxy needs hand-written JSON
//! (subscriptions would otherwise advertise the inbound's local port).

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::ApiJson;
use crate::auth::{ApiError, AuthUser};

/// REALITY targets known to work with the agent's xray (v26.3.27),
/// checked 2026-10-01 (docs/DEPLOY.md §3b). The first is the default.
/// Re-check after xray upgrades.
pub const REALITY_DESTS: &[&str] = &[
    "www.apple.com",
    "dl.google.com",
    "www.cloudflare.com",
    "addons.mozilla.org",
];

/// Where the agent finds the node's TLS certificate (see module doc).
pub const TLS_CERT_FILE: &str = "/run/credentials/akari-agent.service/tls_fullchain.pem";
pub const TLS_KEY_FILE: &str = "/run/credentials/akari-agent.service/tls_privkey.pem";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "template", rename_all = "snake_case", deny_unknown_fields)]
pub enum InboundSpec {
    /// VLESS over REALITY on raw TCP (recommended: no certificate, no
    /// domain), with the Vision flow unless `vision: false`.
    VlessReality {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        /// Target site (host, optionally host:port; default port 443).
        /// Default: the first of `REALITY_DESTS`.
        #[serde(default)]
        dest: Option<String>,
        /// SNI clients send; default the dest host.
        #[serde(default)]
        server_name: Option<String>,
        /// uTLS fingerprint for subscriptions (sub::FINGERPRINTS); default chrome.
        #[serde(default)]
        fingerprint: Option<String>,
        /// xtls-rprx-vision (default true).
        #[serde(default)]
        vision: Option<bool>,
    },
    /// VLESS over REALITY with the XHTTP transport (no Vision: XHTTP is
    /// not raw TCP).
    VlessRealityXhttp {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        #[serde(default)]
        dest: Option<String>,
        #[serde(default)]
        server_name: Option<String>,
        #[serde(default)]
        fingerprint: Option<String>,
        #[serde(default)]
        path: Option<String>,
        /// auto (default) | packet-up | stream-up | stream-one
        #[serde(default)]
        mode: Option<String>,
    },
    /// VLESS over raw TCP + TLS (node certificate) with Vision.
    VlessTlsVision {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        /// Certificate domain (= SNI); default the node's TLS domain.
        #[serde(default)]
        domain: Option<String>,
    },
    /// VLESS over WebSocket with TLS (certificate on the node).
    VlessWsTls {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        /// Domain of the node's certificate (= SNI); default the node's
        /// TLS domain.
        #[serde(default)]
        domain: Option<String>,
        #[serde(default)]
        path: Option<String>,
    },
    /// VMess over WebSocket; TLS when `tls_domain` is set or `tls` is
    /// true (certificate on the node; domain default the node's TLS
    /// domain), plain otherwise.
    VmessWs {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        tls_domain: Option<String>,
        #[serde(default)]
        tls: Option<bool>,
    },
    /// VMess over raw TCP (no TLS; alterId 0, security auto).
    VmessTcp {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
    },
    /// Trojan over TLS (certificate on the node).
    TrojanTls {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        #[serde(default)]
        domain: Option<String>,
    },
    /// Any of vless/vmess/trojan over an HTTP-family transport (ws,
    /// httpupgrade, xhttp, grpc), TLS when `tls_domain` is set or `tls` is
    /// true (domain default the node's TLS domain; required for trojan and
    /// for grpc).
    Transport {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        protocol: String,
        network: String,
        #[serde(default)]
        path: Option<String>,
        /// Host header (ws/httpupgrade/xhttp) clients send; optional.
        #[serde(default)]
        host: Option<String>,
        /// xhttp mode.
        #[serde(default)]
        mode: Option<String>,
        /// grpc serviceName (default random).
        #[serde(default)]
        service_name: Option<String>,
        #[serde(default)]
        tls_domain: Option<String>,
        #[serde(default)]
        tls: Option<bool>,
    },
    /// Shadowsocks 2022, multi-user (server PSK generated here; one key
    /// per user). TCP and UDP.
    #[serde(rename = "shadowsocks_2022")]
    Shadowsocks2022 {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        /// 2022-blake3-aes-128-gcm (default) | 2022-blake3-aes-256-gcm
        #[serde(default)]
        method: Option<String>,
    },
    /// Hysteria 2 over QUIC (UDP), node certificate.
    Hysteria2 {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        #[serde(default)]
        domain: Option<String>,
    },
}

impl InboundSpec {
    fn port(&self) -> u16 {
        match self {
            InboundSpec::VlessReality { port, .. }
            | InboundSpec::VlessRealityXhttp { port, .. }
            | InboundSpec::VlessTlsVision { port, .. }
            | InboundSpec::VlessWsTls { port, .. }
            | InboundSpec::VmessWs { port, .. }
            | InboundSpec::VmessTcp { port, .. }
            | InboundSpec::TrojanTls { port, .. }
            | InboundSpec::Transport { port, .. }
            | InboundSpec::Shadowsocks2022 { port, .. }
            | InboundSpec::Hysteria2 { port, .. } => *port,
        }
    }

    /// (tcp, udp) the rendered inbound listens on.
    fn l4(&self) -> (bool, bool) {
        match self {
            InboundSpec::Shadowsocks2022 { .. } => (true, true),
            InboundSpec::Hysteria2 { .. } => (false, true),
            _ => (true, false),
        }
    }

    fn needs_certificate(&self) -> bool {
        match self {
            InboundSpec::VlessReality { .. }
            | InboundSpec::VlessRealityXhttp { .. }
            | InboundSpec::VmessTcp { .. }
            | InboundSpec::Shadowsocks2022 { .. } => false,
            InboundSpec::VmessWs {
                tls_domain, tls, ..
            }
            | InboundSpec::Transport {
                tls_domain, tls, ..
            } => wants_tls(tls_domain, *tls),
            InboundSpec::VlessTlsVision { .. }
            | InboundSpec::VlessWsTls { .. }
            | InboundSpec::TrojanTls { .. }
            | InboundSpec::Hysteria2 { .. } => true,
        }
    }
}

fn wants_tls(tls_domain: &Option<String>, tls: Option<bool>) -> bool {
    tls.unwrap_or(false) || tls_domain.as_deref().is_some_and(|d| !d.trim().is_empty())
}

/// The node's TLS domain ("节点域名", W10) as stored: lowercase DNS name with
/// at least two labels, no trailing dot, no wildcard, no IP literal (the
/// CHECK of migration 0080 is the same rule).
pub fn node_tls_domain(d: &str) -> Result<String, ApiError> {
    let d = d.trim().trim_end_matches('.').to_ascii_lowercase();
    if !valid_hostname(&d) || !d.contains('.') || d.bytes().all(|b| b.is_ascii_digit() || b == b'.')
    {
        return Err(ApiError::bad_request(
            "tls_domain must be a domain name like node1.example.com (no IP, no wildcard)",
        ));
    }
    Ok(d)
}

/// The certificate domain of a TLS template: its own `explicit` value, or
/// the node's TLS domain. With a node TLS domain (automatic certificate)
/// another name is refused: the certificate covers only the node's.
fn cert_domain(
    explicit: &Option<String>,
    node: Option<&str>,
    what: &str,
) -> Result<String, ApiError> {
    match explicit.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => {
            let d = domain(d, what)?;
            if let Some(n) = node.filter(|n| *n != d) {
                return Err(ApiError::bad_request(format!(
                    "{what} {d} differs from the node's TLS domain {n}: the automatic certificate \
                     covers only {n} (leave {what} empty to use it)"
                )));
            }
            Ok(d)
        }
        None => node.map(str::to_string).ok_or_else(|| {
            ApiError::bad_request(format!(
                "{what}: set the node's TLS domain (节点域名) or a domain for this inbound"
            ))
        }),
    }
}

/// An X25519 key pair in xray's encoding (base64url, no padding; the
/// private scalar clamped like `xray x25519` does).
pub struct RealityKeys {
    pub private_key: String,
    pub public_key: String,
}

pub fn reality_keys_from(mut secret: [u8; 32]) -> RealityKeys {
    secret[0] &= 248;
    secret[31] &= 127;
    secret[31] |= 64;
    let sk = x25519_dalek::StaticSecret::from(secret);
    let pk = x25519_dalek::PublicKey::from(&sk);
    RealityKeys {
        private_key: URL_SAFE_NO_PAD.encode(sk.to_bytes()),
        public_key: URL_SAFE_NO_PAD.encode(pk.as_bytes()),
    }
}

pub fn new_reality_keys() -> RealityKeys {
    let mut secret = [0u8; 32];
    rand::rng().fill_bytes(&mut secret);
    reality_keys_from(secret)
}

fn new_short_id() -> String {
    let mut b = [0u8; 8];
    rand::rng().fill_bytes(&mut b);
    hex::encode(b)
}

/// A DNS name (no IP literal, no port): letters, digits, '-', '.', 1..=253.
pub fn valid_hostname(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.parse::<IpAddr>().is_err()
        && h.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// "host" or "host:port" → (host, port), host a DNS name.
pub fn parse_dest(dest: &str) -> Result<(String, u16), ApiError> {
    let dest = dest.trim().to_ascii_lowercase();
    let (host, port) = match dest.rsplit_once(':') {
        Some((h, p)) => (
            h.to_string(),
            p.parse::<u16>()
                .ok()
                .filter(|p| *p > 0)
                .ok_or_else(|| ApiError::bad_request("dest port must be 1-65535"))?,
        ),
        None => (dest.clone(), 443),
    };
    if !valid_hostname(&host) {
        return Err(ApiError::bad_request(
            "dest must be a domain name (optionally :port)",
        ));
    }
    Ok((host, port))
}

fn ws_path(path: &Option<String>) -> Result<String, ApiError> {
    let p = path.as_deref().map(str::trim).unwrap_or("");
    if p.is_empty() {
        // Unguessable by default: scanners probing "/" get nothing.
        return Ok(format!("/{}", new_short_id()));
    }
    if !p.starts_with('/')
        || p.len() > 128
        || !p
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-_.~".contains(&b))
    {
        return Err(ApiError::bad_request(
            "path must start with / and use only letters, digits and /-_.~ (<= 128)",
        ));
    }
    Ok(p.to_string())
}

fn domain(d: &str, what: &str) -> Result<String, ApiError> {
    let d = d.trim().to_ascii_lowercase();
    if !valid_hostname(&d) {
        return Err(ApiError::bad_request(format!(
            "{what} must be the domain name of the node's certificate"
        )));
    }
    Ok(d)
}

fn tls_settings(domain: &str, alpn: &[&str]) -> Value {
    json!({
        "serverName": domain,
        "alpn": alpn,
        "certificates": [{ "certificateFile": TLS_CERT_FILE, "keyFile": TLS_KEY_FILE }],
    })
}

/// REALITY settings (fresh keys + short id) for `dest`/`server_name`/
/// `fingerprint` (shared by the REALITY templates).
fn reality_settings(
    dest: &Option<String>,
    server_name: &Option<String>,
    fingerprint: &Option<String>,
) -> Result<Value, ApiError> {
    let (host, dport) = parse_dest(dest.as_deref().unwrap_or(REALITY_DESTS[0]))?;
    let sni = match server_name.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => domain(s, "server_name")?,
        _ => host.clone(),
    };
    let fp = fingerprint.as_deref().unwrap_or("chrome");
    if !crate::sub::FINGERPRINTS.contains(&fp) {
        return Err(ApiError::bad_request(format!(
            "fingerprint must be one of {}",
            crate::sub::FINGERPRINTS.join(", ")
        )));
    }
    let keys = new_reality_keys();
    let sid = new_short_id();
    Ok(json!({
        "dest": format!("{host}:{dport}"),
        "serverNames": [sni],
        "privateKey": keys.private_key,
        "shortIds": [sid],
        // Panel-only (subscriptions): ignored by xray.
        "publicKey": keys.public_key,
        "shortId": sid,
        "fingerprint": fp,
    }))
}

fn xhttp_mode(mode: &Option<String>) -> Result<String, ApiError> {
    let m = mode.as_deref().map(str::trim).unwrap_or("");
    let m = if m.is_empty() { "auto" } else { m };
    if !crate::protocols::XHTTP_MODES.contains(&m) {
        return Err(ApiError::bad_request(format!(
            "mode must be one of {}",
            crate::protocols::XHTTP_MODES.join(", ")
        )));
    }
    Ok(m.to_string())
}

fn grpc_service_name(name: &Option<String>) -> Result<String, ApiError> {
    let n = name.as_deref().map(str::trim).unwrap_or("");
    if n.is_empty() {
        return Ok(new_short_id());
    }
    if n.len() > 64
        || !n
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(ApiError::bad_request(
            "service_name: letters, digits and -_. only (<= 64)",
        ));
    }
    Ok(n.to_string())
}

/// Render one template into an xray inbound. `node_domain`: the node's
/// TLS domain (W10), the default certificate domain.
pub fn render_one(spec: &InboundSpec, node_domain: Option<&str>) -> Result<Value, ApiError> {
    let port = spec.port();
    if port == 0 {
        return Err(ApiError::bad_request("port must be 1-65535"));
    }
    let tag_or = |tag: &Option<String>, default: String| -> String {
        tag.as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(String::from)
            .unwrap_or(default)
    };
    Ok(match spec {
        InboundSpec::VlessReality {
            tag,
            dest,
            server_name,
            fingerprint,
            vision,
            ..
        } => {
            let flow = if vision.unwrap_or(true) {
                crate::protocols::VISION
            } else {
                ""
            };
            json!({
                "tag": tag_or(tag, format!("vless-reality-{port}")),
                "port": port,
                "protocol": "vless",
                "settings": { "clients": [], "decryption": "none", "flow": flow },
                "streamSettings": {
                    "network": "tcp",
                    "security": "reality",
                    "realitySettings": reality_settings(dest, server_name, fingerprint)?,
                },
            })
        }
        InboundSpec::VlessRealityXhttp {
            tag,
            dest,
            server_name,
            fingerprint,
            path,
            mode,
            ..
        } => json!({
            "tag": tag_or(tag, format!("vless-xhttp-{port}")),
            "port": port,
            "protocol": "vless",
            "settings": { "clients": [], "decryption": "none" },
            "streamSettings": {
                "network": "xhttp",
                "security": "reality",
                "xhttpSettings": { "path": ws_path(path)?, "mode": xhttp_mode(mode)? },
                "realitySettings": reality_settings(dest, server_name, fingerprint)?,
            },
        }),
        InboundSpec::VlessTlsVision { tag, domain: d, .. } => {
            let d = cert_domain(d, node_domain, "domain")?;
            json!({
                "tag": tag_or(tag, format!("vless-vision-{port}")),
                "port": port,
                "protocol": "vless",
                "settings": { "clients": [], "decryption": "none", "flow": crate::protocols::VISION },
                "streamSettings": {
                    "network": "tcp",
                    "security": "tls",
                    "tlsSettings": tls_settings(&d, &["h2", "http/1.1"]),
                },
            })
        }
        InboundSpec::VmessTcp { tag, .. } => json!({
            "tag": tag_or(tag, format!("vmess-tcp-{port}")),
            "port": port,
            "protocol": "vmess",
            "settings": { "clients": [] },
            "streamSettings": { "network": "tcp" },
        }),
        InboundSpec::Transport {
            tag,
            protocol,
            network,
            path,
            host,
            mode,
            service_name,
            tls_domain,
            tls,
            ..
        } => {
            let proto = protocol.trim().to_ascii_lowercase();
            if !["vless", "vmess", "trojan"].contains(&proto.as_str()) {
                return Err(ApiError::bad_request(
                    "protocol must be vless, vmess or trojan",
                ));
            }
            let net = network.trim().to_ascii_lowercase();
            if *tls == Some(false) && wants_tls(tls_domain, None) {
                return Err(ApiError::bad_request("tls is false but tls_domain is set"));
            }
            let tls = if wants_tls(tls_domain, *tls) {
                Some(cert_domain(tls_domain, node_domain, "tls_domain")?)
            } else {
                None
            };
            if tls.is_none() && (proto == "trojan" || net == "grpc") {
                return Err(ApiError::bad_request(
                    "trojan and grpc need TLS (tls: true with the node's TLS domain, or tls_domain)",
                ));
            }
            let host = match host.as_deref().map(str::trim) {
                Some(h) if !h.is_empty() => Some(domain(h, "host")?),
                _ => None,
            };
            let (settings_key, ts, alpn): (&str, Value, &[&str]) = match net.as_str() {
                "ws" => {
                    let mut w = json!({ "path": ws_path(path)? });
                    if let Some(h) = &host {
                        w["headers"] = json!({ "Host": h });
                    }
                    ("wsSettings", w, &["http/1.1"])
                }
                "httpupgrade" => {
                    let mut w = json!({ "path": ws_path(path)? });
                    if let Some(h) = &host {
                        w["host"] = json!(h);
                    }
                    ("httpupgradeSettings", w, &["http/1.1"])
                }
                "xhttp" => {
                    let mut w = json!({ "path": ws_path(path)?, "mode": xhttp_mode(mode)? });
                    if let Some(h) = &host {
                        w["host"] = json!(h);
                    }
                    ("xhttpSettings", w, &["h2", "http/1.1"])
                }
                "grpc" => (
                    "grpcSettings",
                    json!({ "serviceName": grpc_service_name(service_name)? }),
                    &["h2"],
                ),
                _ => {
                    return Err(ApiError::bad_request(
                        "network must be ws, httpupgrade, xhttp or grpc",
                    ))
                }
            };
            let mut ss = json!({ "network": net });
            ss[settings_key] = ts;
            if let Some(d) = &tls {
                ss["security"] = json!("tls");
                ss["tlsSettings"] = tls_settings(d, alpn);
            }
            let settings = if proto == "vless" {
                json!({ "clients": [], "decryption": "none" })
            } else {
                json!({ "clients": [] })
            };
            json!({
                "tag": tag_or(tag, format!("{proto}-{net}-{port}")),
                "port": port,
                "protocol": proto,
                "settings": settings,
                "streamSettings": ss,
            })
        }
        InboundSpec::Shadowsocks2022 { tag, method, .. } => {
            let m = method
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .unwrap_or(crate::protocols::SS_METHODS[0].0);
            let psk = crate::protocols::new_ss_key(m).ok_or_else(|| {
                ApiError::bad_request(format!(
                    "method must be one of {}",
                    crate::protocols::SS_METHODS.map(|(m, _)| m).join(", ")
                ))
            })?;
            json!({
                "tag": tag_or(tag, format!("ss2022-{port}")),
                "port": port,
                "protocol": "shadowsocks",
                "settings": { "method": m, "password": psk, "clients": [], "network": "tcp,udp" },
            })
        }
        InboundSpec::Hysteria2 { tag, domain: d, .. } => {
            let d = cert_domain(d, node_domain, "domain")?;
            json!({
                "tag": tag_or(tag, format!("hysteria2-{port}")),
                "port": port,
                "protocol": "hysteria",
                "settings": { "version": 2, "clients": [] },
                "streamSettings": {
                    "network": "hysteria",
                    "security": "tls",
                    "tlsSettings": tls_settings(&d, &["h3"]),
                    "hysteriaSettings": { "version": 2 },
                },
            })
        }
        InboundSpec::VlessWsTls {
            tag,
            domain: d,
            path,
            ..
        } => {
            let d = cert_domain(d, node_domain, "domain")?;
            json!({
                "tag": tag_or(tag, format!("vless-ws-{port}")),
                "port": port,
                "protocol": "vless",
                "settings": { "clients": [], "decryption": "none" },
                "streamSettings": {
                    "network": "ws",
                    "security": "tls",
                    "tlsSettings": tls_settings(&d, &["http/1.1"]),
                    "wsSettings": { "path": ws_path(path)? },
                },
            })
        }
        InboundSpec::VmessWs {
            tag,
            path,
            tls_domain,
            tls,
            ..
        } => {
            let mut ss = json!({
                "network": "ws",
                "wsSettings": { "path": ws_path(path)? },
            });
            if *tls == Some(false) && wants_tls(tls_domain, None) {
                return Err(ApiError::bad_request("tls is false but tls_domain is set"));
            }
            if wants_tls(tls_domain, *tls) {
                let d = cert_domain(tls_domain, node_domain, "tls_domain")?;
                ss["security"] = json!("tls");
                ss["tlsSettings"] = tls_settings(&d, &["http/1.1"]);
            }
            json!({
                "tag": tag_or(tag, format!("vmess-ws-{port}")),
                "port": port,
                "protocol": "vmess",
                "settings": { "clients": [] },
                "streamSettings": ss,
            })
        }
        InboundSpec::TrojanTls { tag, domain: d, .. } => {
            let d = cert_domain(d, node_domain, "domain")?;
            json!({
                "tag": tag_or(tag, format!("trojan-{port}")),
                "port": port,
                "protocol": "trojan",
                "settings": { "clients": [] },
                "streamSettings": {
                    "network": "tcp",
                    "security": "tls",
                    "tlsSettings": tls_settings(&d, &["h2", "http/1.1"]),
                },
            })
        }
    })
}

/// Render a list of templates, refusing duplicate ports (also against
/// `taken`, the ports of inbounds kept from the node's current config).
/// `node_domain`: the node's TLS domain (default certificate domain).
pub fn render(
    specs: &[InboundSpec],
    taken: &[u16],
    node_domain: Option<&str>,
) -> Result<Vec<Value>, ApiError> {
    if specs.len() > 16 {
        return Err(ApiError::bad_request("at most 16 templates at once"));
    }
    // `taken` ports are treated as TCP+UDP (their inbounds are not known
    // here); the templates' own L4 lets a UDP Hysteria 2 share a TCP port.
    let mut ports: Vec<(u16, bool, bool)> = taken.iter().map(|p| (*p, true, true)).collect();
    let mut out = Vec::with_capacity(specs.len());
    for s in specs {
        let p = s.port();
        let (t, u) = s.l4();
        if ports
            .iter()
            .any(|(q, qt, qu)| *q == p && ((t && *qt) || (u && *qu)))
        {
            return Err(ApiError::bad_request(format!(
                "port {p} is used by more than one inbound"
            )));
        }
        ports.push((p, t, u));
        out.push(render_one(s, node_domain)?);
    }
    // What the templates produce must be what saving accepts: an
    // admin-chosen tag can be reserved ("_x", "akari-*", "api") or repeat
    // another template's (fuzz: node_templates). Same 400 as the save.
    crate::api::validate_inbounds(&Value::Array(out.clone()))?;
    Ok(out)
}

/// Does any inbound read the node's TLS certificate files?
pub fn needs_certificate(inbounds: &Value) -> bool {
    inbounds.as_array().is_some_and(|a| {
        a.iter().any(|i| {
            i.pointer("/streamSettings/tlsSettings/certificates")
                .and_then(Value::as_array)
                .is_some_and(|c| {
                    c.iter().any(|c| {
                        c.get("certificateFile").and_then(Value::as_str) == Some(TLS_CERT_FILE)
                    })
                })
        })
    })
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderReq {
    pub templates: Vec<InboundSpec>,
    /// Ports already used by the inbounds the new ones are added to.
    #[serde(default)]
    pub taken_ports: Vec<u16>,
    /// The node's TLS domain (W10): default certificate domain of the
    /// TLS templates.
    #[serde(default)]
    pub tls_domain: Option<String>,
}

#[derive(Serialize)]
pub struct RenderView {
    inbounds: Vec<Value>,
    /// Some template needs the node's certificate files.
    needs_certificate: bool,
}

/// POST /inbound-templates/render (admin): templates → inbounds JSON
/// (fresh REALITY keys). Nothing is stored; the UI merges the result into
/// the node's inbounds and saves them with PUT /nodes/{id}/inbounds.
pub async fn render_templates(
    user: AuthUser,
    ApiJson(req): ApiJson<RenderReq>,
) -> Result<Json<RenderView>, ApiError> {
    user.require_admin()?;
    let node_domain = match req.tls_domain.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => Some(node_tls_domain(d)?),
        _ => None,
    };
    let inbounds = render(&req.templates, &req.taken_ports, node_domain.as_deref())?;
    Ok(Json(RenderView {
        needs_certificate: req.templates.iter().any(InboundSpec::needs_certificate),
        inbounds,
    }))
}

#[derive(Serialize)]
pub struct TemplateCatalog {
    reality_dests: &'static [&'static str],
    fingerprints: &'static [&'static str],
    tls_cert_dir: &'static str,
    ss_methods: Vec<&'static str>,
    xhttp_modes: &'static [&'static str],
}

/// GET /inbound-templates (admin): the choices the form offers.
pub async fn catalog(user: AuthUser) -> Result<Json<TemplateCatalog>, ApiError> {
    user.require_admin()?;
    Ok(Json(TemplateCatalog {
        reality_dests: REALITY_DESTS,
        fingerprints: crate::sub::FINGERPRINTS,
        tls_cert_dir: "/etc/akari-agent/tls",
        ss_methods: crate::protocols::SS_METHODS
            .iter()
            .map(|(m, _)| *m)
            .collect(),
        xhttp_modes: &crate::protocols::XHTTP_MODES,
    }))
}

// ---------------------------------------------------------------------------
// W10: TLS domain pre-flight (warn only)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckDomainReq {
    pub domain: String,
    /// Existing node: compare with its agent's address and public address.
    #[serde(default)]
    pub node_id: Option<uuid::Uuid>,
    /// New node (wizard): the public address typed in the form.
    #[serde(default)]
    pub server_addr: Option<String>,
}

#[derive(Serialize, Default, Debug)]
pub struct CheckDomainView {
    domain: String,
    /// What the domain resolves to (from the panel).
    addresses: Vec<String>,
    /// Addresses the node is known by: its agent's source address and its
    /// public address (resolved when a name). Empty = unknown yet (a new
    /// node before install): nothing to compare.
    expected: Vec<String>,
    /// null when nothing could be compared.
    matches: Option<bool>,
    /// Some resolved address is a Cloudflare edge (orange cloud): the CA
    /// and TLS clients would reach Cloudflare, not the node.
    cloudflare: bool,
    /// Resolution failure (NXDOMAIN, timeout).
    error: Option<String>,
}

async fn resolve(host: &str) -> Result<Vec<IpAddr>, String> {
    let addrs = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host, 0)))
        .await
        .map_err(|_| "DNS lookup timed out".to_string())?
        .map_err(|e| format!("DNS lookup failed: {e}"))?;
    let mut ips: Vec<IpAddr> = addrs.map(|a| a.ip().to_canonical()).collect();
    ips.sort();
    ips.dedup();
    Ok(ips)
}

/// POST /inbound-templates/check-domain (admin): does the node's TLS domain
/// resolve to the node? Only a warning in the UI: the node's address may be
/// unknown before the agent connects, and the panel's resolver may differ
/// from the CA's.
pub async fn check_domain(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CheckDomainReq>,
) -> Result<Json<CheckDomainView>, ApiError> {
    user.require_admin()?;
    let domain = node_tls_domain(&req.domain)?;
    let mut expected: Vec<IpAddr> = Vec::new();
    let mut server_addr = req
        .server_addr
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    if let Some(id) = req.node_id {
        let row: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT host(agent_addr), server_addr FROM nodes WHERE id = $1")
                .bind(id)
                .fetch_optional(state.pg())
                .await?;
        let (agent, server) = row.ok_or_else(ApiError::not_found)?;
        if let Some(ip) = agent
            .as_deref()
            .and_then(|a| a.split('/').next()?.parse::<IpAddr>().ok())
        {
            expected.push(ip.to_canonical());
        }
        if server_addr.is_none() {
            server_addr = server;
        }
    }
    if let Some(sa) = server_addr.as_deref() {
        let host = sa.trim_start_matches('[').trim_end_matches(']');
        match host.parse::<IpAddr>() {
            Ok(ip) => expected.push(ip.to_canonical()),
            Err(_) if valid_hostname(host) && !host.eq_ignore_ascii_case(&domain) => {
                if let Ok(ips) = resolve(host).await {
                    expected.extend(ips);
                }
            }
            Err(_) => {}
        }
    }
    expected.sort();
    expected.dedup();
    let mut view = CheckDomainView {
        domain: domain.clone(),
        expected: expected.iter().map(ToString::to_string).collect(),
        ..Default::default()
    };
    match resolve(&domain).await {
        Ok(ips) if ips.is_empty() => view.error = Some("the domain has no A/AAAA record".into()),
        Ok(ips) => {
            let cf = crate::cloudflare::ranges(state.cfg());
            view.cloudflare = ips.iter().any(|ip| crate::cloudflare::contains(&cf, *ip));
            if !expected.is_empty() {
                view.matches = Some(ips.iter().any(|ip| expected.contains(ip)));
            }
            view.addresses = ips.iter().map(ToString::to_string).collect();
        }
        Err(e) => view.error = Some(e),
    }
    Ok(Json(view))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckDestReq {
    pub dest: String,
}

#[derive(Serialize, Default)]
pub struct CheckDestView {
    ok: bool,
    tls13: bool,
    h2: bool,
    /// Publicly trusted certificate for the name.
    trusted: bool,
    error: Option<String>,
}

/// Addresses a dest check must never reach (the panel's own network).
fn forbidden_target(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64 // CGNAT
                || v4.octets()[0] == 0
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return forbidden_target(IpAddr::V4(v4));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local
        }
    }
}

/// POST /inbound-templates/check-dest {dest} (admin): from the panel, a
/// TLS 1.3 handshake offering h2 to the dest (what REALITY needs from its
/// target). Only public addresses (no SSRF into the panel's network).
/// The node's own network path may differ: this is a first check.
pub async fn check_dest(
    user: AuthUser,
    ApiJson(req): ApiJson<CheckDestReq>,
) -> Result<Json<CheckDestView>, ApiError> {
    user.require_admin()?;
    let (host, port) = parse_dest(&req.dest)?;
    Ok(Json(match probe_dest(&host, port).await {
        Ok(v) => v,
        Err(e) => CheckDestView {
            error: Some(e),
            ..Default::default()
        },
    }))
}

async fn probe_dest(host: &str, port: u16) -> Result<CheckDestView, String> {
    let addrs: Vec<SocketAddr> = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| "DNS lookup timed out".to_string())?
    .map_err(|e| format!("DNS lookup failed: {e}"))?
    .collect();
    let addr = addrs
        .iter()
        .find(|a| !forbidden_target(a.ip()))
        .copied()
        .ok_or_else(|| "the name resolves to no public address".to_string())?;
    if addrs.iter().any(|a| forbidden_target(a.ip())) {
        return Err("the name resolves to a private address".into());
    }
    let probe = crate::nodeinstall::tls_probe(addr, host, &[b"h2".to_vec()]).await?;
    let tls13 = probe.version == Some(tokio_rustls::rustls::ProtocolVersion::TLSv1_3);
    let h2 = probe.alpn.as_deref() == Some(b"h2".as_slice());
    let error = match (tls13, h2) {
        (true, true) => None,
        (false, _) => Some("TLS 1.3 was not negotiated".into()),
        (true, false) => Some("the site does not offer HTTP/2 (h2)".into()),
    };
    Ok(CheckDestView {
        ok: tls13 && h2,
        tls13,
        h2,
        trusted: probe.trusted,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as STANDARD_B64;

    /// Templates without a node TLS domain (the pre-W10 behaviour).
    fn render(specs: &[InboundSpec], taken: &[u16]) -> Result<Vec<Value>, ApiError> {
        super::render(specs, taken, None)
    }

    /// Fuzz (node_templates) regression: a template tag the save would
    /// refuse (reserved, or repeated across templates) is refused by the
    /// render already, with the save's message.
    #[test]
    fn render_refuses_tags_the_save_would_refuse() {
        let spec = |tag: &str, port: u16| -> InboundSpec {
            serde_json::from_value(serde_json::json!({
                "template": "vmess_tcp", "port": port, "tag": tag
            }))
            .unwrap()
        };
        for bad in ["_:443", "akari-x", "api"] {
            let e = render(&[spec(bad, 443)], &[]).unwrap_err();
            assert!(e.message().contains("reserved"), "{bad}: {}", e.message());
        }
        let e = render(&[spec("same", 443), spec("same", 444)], &[]).unwrap_err();
        assert!(e.message().contains("duplicate"), "{}", e.message());
        assert!(render(&[spec("a", 443), spec("b", 444)], &[]).is_ok());
    }

    #[test]
    fn node_tls_domain_is_the_default_and_the_only_certificate_domain() {
        let d = Some("node1.example.com");
        let v = super::render(
            &[
                spec(json!({"template": "vless_ws_tls", "port": 443})),
                spec(json!({"template": "trojan_tls", "port": 8443, "domain": "NODE1.example.com"})),
                spec(json!({"template": "hysteria2", "port": 443})),
                spec(json!({"template": "vless_tls_vision", "port": 2083})),
                spec(json!({"template": "transport", "port": 2096, "protocol": "vmess", "network": "grpc", "tls": true})),
                spec(json!({"template": "vmess_ws", "port": 8080, "tls": true})),
                spec(json!({"template": "vmess_ws", "port": 8081})),
            ],
            &[],
            d,
        )
        .unwrap();
        for i in &v[..6] {
            assert_eq!(
                i["streamSettings"]["tlsSettings"]["serverName"], "node1.example.com",
                "{i}"
            );
            assert_eq!(
                i["streamSettings"]["tlsSettings"]["certificates"][0]["certificateFile"],
                TLS_CERT_FILE
            );
        }
        assert!(
            v[6]["streamSettings"].get("security").is_none(),
            "plain ws stays plain"
        );
        assert!(needs_certificate(&Value::Array(v)));
        // Another name than the node's is refused (the certificate covers
        // only the node's TLS domain); without one a TLS template needs a
        // domain.
        let e = super::render(
            &[spec(
                json!({"template": "trojan_tls", "port": 443, "domain": "other.example.com"}),
            )],
            &[],
            d,
        )
        .unwrap_err();
        assert!(e.message().contains("node1.example.com"), "{e:?}");
        assert!(render(&[spec(json!({"template": "trojan_tls", "port": 443}))], &[]).is_err());
        assert!(render(&[spec(json!({"template": "transport", "port": 443, "protocol": "trojan", "network": "ws", "tls": true}))], &[]).is_err());
        assert!(super::render(&[spec(json!({"template": "vmess_ws", "port": 80, "tls": false, "tls_domain": "node1.example.com"}))], &[], d).is_err());
        // Without a node domain the explicit domain still works (manual
        // certificate files).
        let v = render(
            &[spec(
                json!({"template": "trojan_tls", "port": 443, "domain": "own.example.com"}),
            )],
            &[],
        )
        .unwrap();
        assert_eq!(
            v[0]["streamSettings"]["tlsSettings"]["serverName"],
            "own.example.com"
        );
    }

    #[test]
    fn node_tls_domain_rules() {
        assert_eq!(
            node_tls_domain(" Node1.Example.COM. ").unwrap(),
            "node1.example.com"
        );
        for bad in [
            "",
            "localhost",
            "1.2.3.4",
            "*.example.com",
            "a..b",
            "-a.example.com",
            "a_b.example.com",
            "exa mple.com",
        ] {
            assert!(node_tls_domain(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn x25519_rfc7748_vector() {
        // RFC 7748 §6.1, Alice.
        let sk: [u8; 32] =
            hex::decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
                .unwrap()
                .try_into()
                .unwrap();
        let keys = reality_keys_from(sk);
        let pk = URL_SAFE_NO_PAD.decode(&keys.public_key).unwrap();
        assert_eq!(
            hex::encode(pk),
            "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"
        );
        // Stored clamped (xray x25519 form); same public key.
        let stored = URL_SAFE_NO_PAD.decode(&keys.private_key).unwrap();
        assert_eq!(stored[0] & 7, 0);
        assert_eq!(stored[31] & 0xc0, 0x40);
    }

    #[test]
    fn fresh_reality_pair_is_consistent() {
        for _ in 0..8 {
            let k = new_reality_keys();
            assert_eq!(k.private_key.len(), 43);
            assert_eq!(k.public_key.len(), 43);
            let sk: [u8; 32] = URL_SAFE_NO_PAD
                .decode(&k.private_key)
                .unwrap()
                .try_into()
                .unwrap();
            let again = reality_keys_from(sk);
            assert_eq!(again.public_key, k.public_key);
            assert_eq!(again.private_key, k.private_key);
        }
    }

    fn spec(v: Value) -> InboundSpec {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn reality_template_renders_valid_inbound() {
        let v = render(
            &[spec(json!({"template": "vless_reality", "port": 443}))],
            &[],
        )
        .unwrap();
        let i = &v[0];
        assert_eq!(i["tag"], "vless-reality-443");
        assert_eq!(i["protocol"], "vless");
        assert_eq!(i["settings"]["decryption"], "none");
        let rs = &i["streamSettings"]["realitySettings"];
        assert_eq!(i["streamSettings"]["security"], "reality");
        assert_eq!(rs["dest"], "www.apple.com:443");
        assert_eq!(rs["serverNames"], json!(["www.apple.com"]));
        assert_eq!(rs["shortIds"][0], rs["shortId"]);
        assert_eq!(rs["shortId"].as_str().unwrap().len(), 16);
        assert_eq!(rs["fingerprint"], "chrome");
        // publicKey derives from privateKey.
        let sk: [u8; 32] = URL_SAFE_NO_PAD
            .decode(rs["privateKey"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(reality_keys_from(sk).public_key, rs["publicKey"]);
        // Same validation as hand-written JSON.
        crate::api::validate_inbounds(&Value::Array(v.clone())).unwrap();
        assert!(!needs_certificate(&Value::Array(v.clone())));
        // Two renders never share keys.
        let w = render(
            &[spec(json!({"template": "vless_reality", "port": 443}))],
            &[],
        )
        .unwrap();
        assert_ne!(
            w[0]["streamSettings"]["realitySettings"]["privateKey"],
            rs["privateKey"]
        );
    }

    #[test]
    fn reality_options_validated() {
        let ok = render(
            &[spec(json!({"template": "vless_reality", "port": 8443, "tag": "r1",
                "dest": "dl.google.com:443", "server_name": "dl.google.com", "fingerprint": "firefox"}))],
            &[],
        )
        .unwrap();
        assert_eq!(ok[0]["tag"], "r1");
        assert_eq!(
            ok[0]["streamSettings"]["realitySettings"]["fingerprint"],
            "firefox"
        );
        for bad in [
            json!({"template": "vless_reality", "port": 443, "dest": "1.2.3.4:443"}),
            json!({"template": "vless_reality", "port": 443, "dest": "a b"}),
            json!({"template": "vless_reality", "port": 443, "dest": "x.com:0"}),
            json!({"template": "vless_reality", "port": 443, "fingerprint": "netscape"}),
            json!({"template": "vless_reality", "port": 0}),
        ] {
            assert!(render(&[spec(bad.clone())], &[]).is_err(), "{bad}");
        }
        // Unknown fields and templates are refused.
        assert!(serde_json::from_value::<InboundSpec>(
            json!({"template": "vless_reality", "port": 1, "junk": 1})
        )
        .is_err());
        assert!(
            serde_json::from_value::<InboundSpec>(json!({"template": "grpc", "port": 1})).is_err()
        );
    }

    #[test]
    fn tls_templates_use_node_certificate_files() {
        let v = render(
            &[
                spec(json!({"template": "vless_ws_tls", "port": 443, "domain": "n1.example.com", "path": "/ws"})),
                spec(json!({"template": "trojan_tls", "port": 8443, "domain": "N1.example.com"})),
                spec(json!({"template": "vmess_ws", "port": 8080})),
                spec(json!({"template": "vmess_ws", "port": 2053, "tls_domain": "n1.example.com"})),
            ],
            &[],
        )
        .unwrap();
        crate::api::validate_inbounds(&Value::Array(v.clone())).unwrap();
        assert!(needs_certificate(&Value::Array(v.clone())));
        assert_eq!(v[0]["streamSettings"]["wsSettings"]["path"], "/ws");
        assert_eq!(
            v[0]["streamSettings"]["tlsSettings"]["serverName"],
            "n1.example.com"
        );
        assert_eq!(
            v[1]["streamSettings"]["tlsSettings"]["certificates"][0]["keyFile"],
            TLS_KEY_FILE
        );
        assert_eq!(
            v[1]["streamSettings"]["tlsSettings"]["serverName"],
            "n1.example.com"
        );
        assert!(v[2]["streamSettings"].get("security").is_none());
        let p = v[2]["streamSettings"]["wsSettings"]["path"]
            .as_str()
            .unwrap();
        assert!(p.starts_with('/') && p.len() == 17, "random default path");
        assert_eq!(v[3]["streamSettings"]["security"], "tls");
        assert!(!needs_certificate(&Value::Array(vec![v[2].clone()])));
        for bad in [
            json!({"template": "trojan_tls", "port": 1, "domain": "1.2.3.4"}),
            json!({"template": "vless_ws_tls", "port": 1, "domain": "x.com", "path": "ws"}),
            json!({"template": "vless_ws_tls", "port": 1, "domain": "x.com", "path": "/a'b"}),
        ] {
            assert!(render(&[spec(bad.clone())], &[]).is_err(), "{bad}");
        }
    }

    /// W8: every template renders an inbound that passes the same
    /// validation as hand-written JSON, gets credentials of the right
    /// shape, and carries what the subscriptions need.
    #[test]
    fn w8_templates_render_valid_inbounds() {
        let specs = [
            json!({"template": "vless_reality", "port": 443}),
            json!({"template": "vless_reality", "port": 444, "vision": false}),
            json!({"template": "vless_reality_xhttp", "port": 445, "path": "/x", "mode": "stream-one"}),
            json!({"template": "vless_tls_vision", "port": 446, "domain": "n.example.com"}),
            json!({"template": "vmess_tcp", "port": 447}),
            json!({"template": "transport", "port": 448, "protocol": "vless", "network": "httpupgrade", "host": "cdn.example.com"}),
            json!({"template": "transport", "port": 449, "protocol": "vless", "network": "xhttp", "tls_domain": "n.example.com"}),
            json!({"template": "transport", "port": 450, "protocol": "trojan", "network": "ws", "tls_domain": "n.example.com"}),
            json!({"template": "transport", "port": 451, "protocol": "vless", "network": "grpc", "tls_domain": "n.example.com", "service_name": "svc"}),
            json!({"template": "transport", "port": 452, "protocol": "vmess", "network": "xhttp"}),
            json!({"template": "shadowsocks_2022", "port": 8388}),
            json!({"template": "shadowsocks_2022", "port": 8389, "method": "2022-blake3-aes-256-gcm"}),
            // UDP: may share 443/TCP with the REALITY inbound.
            json!({"template": "hysteria2", "port": 443, "domain": "n.example.com"}),
        ];
        let v = render(&specs.map(spec), &[]).unwrap();
        crate::api::validate_inbounds(&Value::Array(v.clone())).unwrap();
        for i in &v {
            assert!(crate::protocols::issuable(i), "{i}");
            crate::protocols::generate_account(i).unwrap();
        }
        assert_eq!(v[0]["settings"]["flow"], crate::protocols::VISION);
        assert_eq!(v[1]["settings"]["flow"], "");
        assert_eq!(
            v[2]["streamSettings"]["xhttpSettings"],
            json!({"path": "/x", "mode": "stream-one"})
        );
        assert_eq!(v[2]["streamSettings"]["security"], "reality");
        assert!(v[2]["settings"].get("flow").is_none());
        assert_eq!(v[3]["settings"]["flow"], crate::protocols::VISION);
        assert_eq!(
            v[3]["streamSettings"]["tlsSettings"]["certificates"][0]["certificateFile"],
            TLS_CERT_FILE
        );
        assert_eq!(
            v[5]["streamSettings"]["httpupgradeSettings"]["host"],
            "cdn.example.com"
        );
        assert_eq!(v[6]["streamSettings"]["xhttpSettings"]["mode"], "auto");
        assert_eq!(
            v[6]["streamSettings"]["tlsSettings"]["alpn"],
            json!(["h2", "http/1.1"])
        );
        assert_eq!(v[8]["streamSettings"]["grpcSettings"]["serviceName"], "svc");
        assert_eq!(v[8]["streamSettings"]["tlsSettings"]["alpn"], json!(["h2"]));
        assert!(v[9]["streamSettings"].get("security").is_none());
        let a = crate::protocols::generate_account(&v[11]).unwrap();
        assert_eq!(
            STANDARD_B64
                .decode(a["password"].as_str().unwrap())
                .unwrap()
                .len(),
            32
        );
        assert_eq!(
            STANDARD_B64
                .decode(v[11]["settings"]["password"].as_str().unwrap())
                .unwrap()
                .len(),
            32
        );
        assert_eq!(
            STANDARD_B64
                .decode(v[10]["settings"]["password"].as_str().unwrap())
                .unwrap()
                .len(),
            16
        );
        assert_eq!(
            v[12]["streamSettings"]["tlsSettings"]["alpn"],
            json!(["h3"])
        );
        assert!(needs_certificate(&Value::Array(vec![v[12].clone()])));
        assert!(!needs_certificate(&Value::Array(vec![
            v[10].clone(),
            v[2].clone()
        ])));
        for bad in [
            json!({"template": "transport", "port": 1, "protocol": "trojan", "network": "ws"}),
            json!({"template": "transport", "port": 1, "protocol": "vless", "network": "grpc"}),
            json!({"template": "transport", "port": 1, "protocol": "vless", "network": "kcp"}),
            json!({"template": "transport", "port": 1, "protocol": "socks", "network": "ws"}),
            json!({"template": "transport", "port": 1, "protocol": "vless", "network": "xhttp", "mode": "fast"}),
            json!({"template": "transport", "port": 1, "protocol": "vless", "network": "ws", "host": "a b"}),
            json!({"template": "transport", "port": 1, "protocol": "vless", "network": "grpc", "tls_domain": "x.com", "service_name": "a/b"}),
            json!({"template": "shadowsocks_2022", "port": 1, "method": "2022-blake3-chacha20-poly1305"}),
            json!({"template": "hysteria2", "port": 1, "domain": "1.2.3.4"}),
        ] {
            assert!(render(&[spec(bad.clone())], &[]).is_err(), "{bad}");
        }
        // SS (TCP+UDP) clashes with both TCP and UDP inbounds.
        let ss = spec(json!({"template": "shadowsocks_2022", "port": 9000}));
        let hy = spec(json!({"template": "hysteria2", "port": 9000, "domain": "n.example.com"}));
        assert!(render(&[ss, hy], &[]).is_err());
    }

    #[test]
    fn duplicate_ports_refused() {
        let a = spec(json!({"template": "vmess_ws", "port": 80}));
        let b = spec(json!({"template": "trojan_tls", "port": 80, "domain": "x.com"}));
        assert!(render(&[a.clone(), b], &[]).is_err());
        assert!(render(std::slice::from_ref(&a), &[80]).is_err());
        assert!(render(&[a], &[443]).is_ok());
    }

    #[test]
    fn private_targets_forbidden() {
        for ip in [
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fd00::1",
            "::ffff:192.168.1.1",
            "0.1.2.3",
        ] {
            assert!(forbidden_target(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["17.253.144.10", "2606:4700::1111"] {
            assert!(!forbidden_target(ip.parse().unwrap()), "{ip}");
        }
    }
}
