//! Inbound templates for the node form (R18-2).
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
//! other way. ACME inside the agent is out of scope; a WS inbound behind
//! the node's own reverse proxy needs hand-written JSON (subscriptions
//! would otherwise advertise the inbound's local port).

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
    /// VLESS over REALITY (recommended: no certificate, no domain).
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
    },
    /// VLESS over WebSocket with TLS (certificate on the node).
    VlessWsTls {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        /// Domain of the node's certificate (= SNI).
        domain: String,
        #[serde(default)]
        path: Option<String>,
    },
    /// VMess over WebSocket; TLS when `tls_domain` is set (certificate on
    /// the node), plain otherwise.
    VmessWs {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        tls_domain: Option<String>,
    },
    /// Trojan over TLS (certificate on the node).
    TrojanTls {
        port: u16,
        #[serde(default)]
        tag: Option<String>,
        domain: String,
    },
}

impl InboundSpec {
    fn port(&self) -> u16 {
        match self {
            InboundSpec::VlessReality { port, .. }
            | InboundSpec::VlessWsTls { port, .. }
            | InboundSpec::VmessWs { port, .. }
            | InboundSpec::TrojanTls { port, .. } => *port,
        }
    }

    fn needs_certificate(&self) -> bool {
        match self {
            InboundSpec::VlessReality { .. } => false,
            InboundSpec::VmessWs { tls_domain, .. } => tls_domain.is_some(),
            InboundSpec::VlessWsTls { .. } | InboundSpec::TrojanTls { .. } => true,
        }
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

/// Render one template into an xray inbound.
pub fn render_one(spec: &InboundSpec) -> Result<Value, ApiError> {
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
            ..
        } => {
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
            json!({
                "tag": tag_or(tag, format!("vless-reality-{port}")),
                "port": port,
                "protocol": "vless",
                "settings": { "clients": [], "decryption": "none" },
                "streamSettings": {
                    "network": "tcp",
                    "security": "reality",
                    "realitySettings": {
                        "dest": format!("{host}:{dport}"),
                        "serverNames": [sni],
                        "privateKey": keys.private_key,
                        "shortIds": [sid],
                        // Panel-only (subscriptions): ignored by xray.
                        "publicKey": keys.public_key,
                        "shortId": sid,
                        "fingerprint": fp,
                    },
                },
            })
        }
        InboundSpec::VlessWsTls {
            tag,
            domain: d,
            path,
            ..
        } => {
            let d = domain(d, "domain")?;
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
            ..
        } => {
            let mut ss = json!({
                "network": "ws",
                "wsSettings": { "path": ws_path(path)? },
            });
            if let Some(d) = tls_domain.as_deref().filter(|d| !d.trim().is_empty()) {
                let d = domain(d, "tls_domain")?;
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
            let d = domain(d, "domain")?;
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
pub fn render(specs: &[InboundSpec], taken: &[u16]) -> Result<Vec<Value>, ApiError> {
    if specs.len() > 16 {
        return Err(ApiError::bad_request("at most 16 templates at once"));
    }
    let mut ports: Vec<u16> = taken.to_vec();
    let mut out = Vec::with_capacity(specs.len());
    for s in specs {
        let p = s.port();
        if ports.contains(&p) {
            return Err(ApiError::bad_request(format!(
                "port {p} is used by more than one inbound"
            )));
        }
        ports.push(p);
        out.push(render_one(s)?);
    }
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
    let inbounds = render(&req.templates, &req.taken_ports)?;
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
}

/// GET /inbound-templates (admin): the choices the form offers.
pub async fn catalog(user: AuthUser) -> Result<Json<TemplateCatalog>, ApiError> {
    user.require_admin()?;
    Ok(Json(TemplateCatalog {
        reality_dests: REALITY_DESTS,
        fingerprints: crate::sub::FINGERPRINTS,
        tls_cert_dir: "/etc/akari-agent/tls",
    }))
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
