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

use crate::auth::bad_request;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::Json;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::ApiJson;
use crate::auth::{ApiError, AuthUser};
use crate::protocols::model::{Inbound, Protocol, Security, Transport, TransportKind, Users};
use crate::protocols::{security, transport};

/// Hysteria 2's declared protocol/transport version.
const HYSTERIA_VERSION: i64 = 2;

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
pub use crate::protocols::xray::{TLS_CERT_FILE, TLS_KEY_FILE};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "template", rename_all = "snake_case", deny_unknown_fields)]
pub enum InboundSpec {
    /// VLESS over REALITY on raw TCP (recommended: no certificate, no
    /// domain), with the Vision flow unless `vision: false`.
    VlessReality {
        port: u16,
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
        /// Certificate domain (= SNI); default the node's TLS domain.
        #[serde(default)]
        domain: Option<String>,
    },
    /// VLESS over WebSocket with TLS (certificate on the node).
    VlessWsTls {
        port: u16,
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
        path: Option<String>,
        #[serde(default)]
        tls_domain: Option<String>,
        #[serde(default)]
        tls: Option<bool>,
    },
    /// VMess over raw TCP (no TLS; alterId 0, security auto).
    VmessTcp { port: u16 },
    /// Trojan over TLS (certificate on the node).
    TrojanTls {
        port: u16,
        #[serde(default)]
        domain: Option<String>,
    },
    /// Any of vless/vmess/trojan over an HTTP-family transport (ws,
    /// httpupgrade, xhttp, grpc), TLS when `tls_domain` is set or `tls` is
    /// true (domain default the node's TLS domain; required for trojan and
    /// for grpc).
    Transport {
        port: u16,
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
        /// 2022-blake3-aes-128-gcm (default) | 2022-blake3-aes-256-gcm
        #[serde(default)]
        method: Option<String>,
    },
    /// Hysteria 2 over QUIC (UDP), node certificate.
    Hysteria2 {
        port: u16,
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

    pub(crate) fn needs_certificate(&self) -> bool {
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
        return Err(bad_request!(
            "node.tls_domain_invalid",
            "tls_domain must be a domain name like node1.example.com (no IP, no wildcard)"
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
                return Err(bad_request!(
                    "template.domain_mismatch",
                    "{what} {d} differs from the node's TLS domain {n}: the automatic certificate \
                     covers only {n} (leave {what} empty to use it)",
                    what = what,
                    d = d,
                    n = n
                ));
            }
            Ok(d)
        }
        None => node.map(str::to_string).ok_or_else(|| {
            bad_request!(
                "template.domain_missing",
                "{what}: set the node's TLS domain (节点域名) or a domain for this inbound",
                what = what
            )
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
    crate::entropy::fill(&mut secret);
    reality_keys_from(secret)
}

fn new_short_id() -> String {
    hex::encode(crate::entropy::bytes(8))
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
                .ok_or_else(|| bad_request!("template.dest_port", "dest port must be 1-65535"))?,
        ),
        None => (dest.clone(), 443),
    };
    if !valid_hostname(&host) {
        return Err(bad_request!(
            "template.dest_invalid",
            "dest must be a domain name (optionally :port)"
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
        return Err(bad_request!(
            "template.path_invalid",
            "path must start with / and use only letters, digits and /-_.~ (<= 128)"
        ));
    }
    Ok(p.to_string())
}

fn domain(d: &str, what: &str) -> Result<String, ApiError> {
    let d = d.trim().to_ascii_lowercase();
    if !valid_hostname(&d) {
        return Err(bad_request!(
            "template.domain_invalid",
            "{what} must be the domain name of the node's certificate",
            what = what
        ));
    }
    Ok(d)
}

/// REALITY (fresh keys + short id) for `dest`/`server_name`/`fingerprint`
/// (shared by the REALITY templates).
fn reality_settings(
    dest: &Option<String>,
    server_name: &Option<String>,
    fingerprint: &Option<String>,
) -> Result<Security, ApiError> {
    let (host, dport) = parse_dest(dest.as_deref().unwrap_or(REALITY_DESTS[0]))?;
    let sni = match server_name.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => domain(s, "server_name")?,
        _ => host.clone(),
    };
    let fp = fingerprint
        .as_deref()
        .unwrap_or_else(|| security::default_fingerprint());
    if !security::FINGERPRINTS.contains(&fp) {
        return Err(bad_request!(
            "template.fingerprint_invalid",
            "fingerprint must be one of {allowed}",
            allowed = security::FINGERPRINTS.join(", ")
        ));
    }
    let keys = new_reality_keys();
    let sid = new_short_id();
    Ok(security::reality(
        format!("{host}:{dport}"),
        sni,
        keys.private_key,
        keys.public_key,
        sid,
        fp,
    ))
}

fn xhttp_mode(mode: &Option<String>) -> Result<String, ApiError> {
    let m = mode.as_deref().map(str::trim).unwrap_or("");
    let m = if m.is_empty() { "auto" } else { m };
    if !crate::protocols::XHTTP_MODES.contains(&m) {
        return Err(bad_request!(
            "template.mode_invalid",
            "mode must be one of {allowed}",
            allowed = crate::protocols::XHTTP_MODES.join(", ")
        ));
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
        return Err(bad_request!(
            "template.service_name_invalid",
            "service_name: letters, digits and -_. only (<= 64)"
        ));
    }
    Ok(n.to_string())
}

/// The kernel-neutral inbound of one template (protocol, transport and
/// security modules composed). `node_domain`: the node's TLS domain (W10),
/// the default certificate domain. The order of checks and random draws is
/// part of the output (W26 golden snapshots).
pub fn build_one(spec: &InboundSpec, node_domain: Option<&str>) -> Result<Inbound, ApiError> {
    let port = spec.port();
    if port == 0 {
        return Err(bad_request!("request.port_range", "port must be 1-65535"));
    }
    let tls = |domain: &str, transport: &TransportKind| -> Security {
        security::tls(domain, transport::alpn(transport))
    };
    // No tag: the panel names the inbounds it renders for the agent (D2).
    let inbound = |protocol: Protocol, transport: Transport, security: Security| Inbound {
        tag: None,
        port: Some(Some(u64::from(port))),
        protocol,
        transport,
        security,
    };
    let vless = |flow: Option<&str>| Protocol::Vless {
        flow: flow.map(String::from),
        encryption: Some(Some("none".into())),
    };
    Ok(match spec {
        InboundSpec::VlessReality {
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
            let reality = reality_settings(dest, server_name, fingerprint)?;
            inbound(vless(Some(flow)), transport::tcp(), reality)
        }
        InboundSpec::VlessRealityXhttp {
            dest,
            server_name,
            fingerprint,
            path,
            mode,
            ..
        } => {
            let xhttp = transport::xhttp(&ws_path(path)?, &xhttp_mode(mode)?, None);
            let reality = reality_settings(dest, server_name, fingerprint)?;
            inbound(vless(None), xhttp, reality)
        }
        InboundSpec::VlessTlsVision { domain: d, .. } => {
            let d = cert_domain(d, node_domain, "domain")?;
            let tcp = transport::tcp();
            let sec = tls(&d, &tcp.kind);
            inbound(vless(Some(crate::protocols::VISION)), tcp, sec)
        }
        InboundSpec::VmessTcp { .. } => inbound(Protocol::Vmess, transport::tcp(), Security::None),
        InboundSpec::Transport {
            protocol,
            network,
            path,
            host,
            mode,
            service_name,
            tls_domain,
            tls: want_tls,
            ..
        } => {
            let proto = protocol.trim().to_ascii_lowercase();
            if !["vless", "vmess", "trojan"].contains(&proto.as_str()) {
                return Err(bad_request!(
                    "template.protocol_invalid",
                    "protocol must be vless, vmess or trojan"
                ));
            }
            let net = network.trim().to_ascii_lowercase();
            if *want_tls == Some(false) && wants_tls(tls_domain, None) {
                return Err(bad_request!(
                    "template.tls_domain_without_tls",
                    "tls is false but tls_domain is set"
                ));
            }
            let tls_name = if wants_tls(tls_domain, *want_tls) {
                Some(cert_domain(tls_domain, node_domain, "tls_domain")?)
            } else {
                None
            };
            let m = crate::protocols::manifest::get();
            let requires_tls = m.protocol(&proto).is_some_and(|p| p.template_requires_tls)
                || m.violated_template_rule(&proto, &net, "none", &Default::default())
                    .is_some();
            if tls_name.is_none() && requires_tls {
                return Err(bad_request!(
                    "template.needs_tls",
                    "trojan and grpc need TLS (tls: true with the node's TLS domain, or tls_domain)"
                ));
            }
            let host = match host.as_deref().map(str::trim) {
                Some(h) if !h.is_empty() => Some(domain(h, "host")?),
                _ => None,
            };
            let t = match net.as_str() {
                "ws" => transport::ws(&ws_path(path)?, host.as_deref()),
                "httpupgrade" => transport::httpupgrade(&ws_path(path)?, host.as_deref()),
                "xhttp" => transport::xhttp(&ws_path(path)?, &xhttp_mode(mode)?, host.as_deref()),
                "grpc" => transport::grpc(&grpc_service_name(service_name)?),
                _ => {
                    return Err(bad_request!(
                        "template.network_invalid",
                        "network must be ws, httpupgrade, xhttp or grpc"
                    ));
                }
            };
            let sec = match &tls_name {
                Some(d) => tls(d, &t.kind),
                None => Security::None,
            };
            let p = match proto.as_str() {
                "vless" => vless(None),
                "vmess" => Protocol::Vmess,
                _ => Protocol::Trojan,
            };
            inbound(p, t, sec)
        }
        InboundSpec::Shadowsocks2022 { method, .. } => {
            let m = method
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .unwrap_or(crate::protocols::SS_METHODS[0].0);
            let psk = crate::protocols::new_ss_key(m).ok_or_else(|| {
                bad_request!(
                    "template.method_invalid",
                    "method must be one of {allowed}",
                    allowed = crate::protocols::SS_METHODS.map(|(m, _)| m).join(", ")
                )
            })?;
            inbound(
                Protocol::Ss2022 {
                    method: Some(m.to_string()),
                    psk: Some(psk),
                    l4: Some(Some("tcp,udp".into())),
                    users: Users::Empty,
                },
                transport::native(None),
                Security::None,
            )
        }
        InboundSpec::Hysteria2 { domain: d, .. } => {
            let d = cert_domain(d, node_domain, "domain")?;
            let alpn = crate::protocols::manifest::get()
                .protocol("hysteria2")
                .map(|p| p.alpn.clone())
                .unwrap_or_default();
            inbound(
                Protocol::Hysteria2 {
                    version: Some(HYSTERIA_VERSION),
                },
                transport::native(Some(HYSTERIA_VERSION)),
                security::tls(&d, alpn),
            )
        }
        InboundSpec::VlessWsTls {
            domain: d, path, ..
        } => {
            let d = cert_domain(d, node_domain, "domain")?;
            let ws = transport::ws(&ws_path(path)?, None);
            let sec = tls(&d, &ws.kind);
            inbound(vless(None), ws, sec)
        }
        InboundSpec::VmessWs {
            path,
            tls_domain,
            tls: want_tls,
            ..
        } => {
            let ws = transport::ws(&ws_path(path)?, None);
            if *want_tls == Some(false) && wants_tls(tls_domain, None) {
                return Err(bad_request!(
                    "template.tls_domain_without_tls",
                    "tls is false but tls_domain is set"
                ));
            }
            let sec = if wants_tls(tls_domain, *want_tls) {
                let d = cert_domain(tls_domain, node_domain, "tls_domain")?;
                tls(&d, &ws.kind)
            } else {
                Security::None
            };
            inbound(Protocol::Vmess, ws, sec)
        }
        InboundSpec::TrojanTls { domain: d, .. } => {
            let d = cert_domain(d, node_domain, "domain")?;
            let tcp = transport::tcp();
            let sec = tls(&d, &tcp.kind);
            inbound(Protocol::Trojan, tcp, sec)
        }
    })
}

/// Render one template into an xray inbound (`build_one` + the xray
/// adapter).
pub fn render_one(spec: &InboundSpec, node_domain: Option<&str>) -> Result<Value, ApiError> {
    Ok(crate::protocols::xray::render(&build_one(
        spec,
        node_domain,
    )?))
}

/// Render a template, refusing a port another inbound of the agent
/// already uses (`taken`: treated as TCP+UDP, their inbounds are not known
/// here; the template's own L4 lets a UDP Hysteria 2 share a TCP port only
/// with inbounds the panel knows). `node_domain`: the node's TLS domain
/// (default certificate domain). The result passes the same checks as a
/// saved inbound.
pub fn render(
    spec: &InboundSpec,
    taken: &[u16],
    node_domain: Option<&str>,
) -> Result<Value, ApiError> {
    let p = spec.port();
    if taken.contains(&p) {
        return Err(bad_request!(
            "template.port_clash",
            "port {p} is used by more than one inbound",
            p = p
        ));
    }
    let out = render_one(spec, node_domain)?;
    crate::api::validate_inbound(&out)?;
    Ok(out)
}

/// Does any inbound read the node's TLS certificate files?
pub use crate::protocols::xray::needs_certificate;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderReq {
    pub template: InboundSpec,
    /// Ports already used by other inbounds of the agent.
    #[serde(default)]
    pub taken_ports: Vec<u16>,
    /// The node's TLS domain (W10): default certificate domain of the
    /// TLS templates.
    #[serde(default)]
    pub tls_domain: Option<String>,
}

#[derive(Serialize)]
pub struct RenderView {
    inbound: Value,
    /// The inbound needs the node's certificate files.
    needs_certificate: bool,
}

/// POST /inbound-templates/render (admin): a template → inbound JSON
/// (fresh REALITY keys). Nothing is stored; the UI saves the result with
/// PUT /nodes/{id}/inbound.
pub async fn render_templates(
    user: AuthUser,
    ApiJson(req): ApiJson<RenderReq>,
) -> Result<Json<RenderView>, ApiError> {
    user.require_admin()?;
    let node_domain = match req.tls_domain.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => Some(node_tls_domain(d)?),
        _ => None,
    };
    let inbound = render(&req.template, &req.taken_ports, node_domain.as_deref())?;
    Ok(Json(RenderView {
        needs_certificate: req.template.needs_certificate(),
        inbound,
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
        fingerprints: &security::FINGERPRINTS,
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
    /// Existing node: compare with its agent's address and its direct
    /// entrance's address.
    #[serde(default)]
    pub node_id: Option<uuid::Uuid>,
    /// New node (wizard): the direct entrance's address typed in the form.
    #[serde(default)]
    pub connect_host: Option<String>,
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
    let mut connect_host = req
        .connect_host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    if let Some(id) = req.node_id {
        let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT host(s.agent_addr), e.connect_host FROM nodes n \
                 JOIN servers s ON s.id = n.server_id \
                 LEFT JOIN entrances e ON e.node_id = n.id AND e.kind = 'direct' WHERE n.id = $1",
        )
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
        if connect_host.is_none() {
            connect_host = server;
        }
    }
    if let Some(sa) = connect_host.as_deref() {
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
            let cf = state.settings().get().cloudflare.clone();
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
    if addrs.is_empty() {
        return Err("the name resolves to no public address".into());
    }
    if addrs.iter().any(|a| forbidden_target(a.ip())) {
        return Err("the name resolves to a private address".into());
    }
    let probe = crate::nodeinstall::tls_probe_any(&addrs, host, &[b"h2".to_vec()]).await?;
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
    use serde_json::json;

    /// Each template on its own (D2: one inbound per node), `taken` ports
    /// refused, with the node's TLS domain `d`.
    fn render_in(
        specs: &[InboundSpec],
        taken: &[u16],
        d: Option<&str>,
    ) -> Result<Vec<Value>, ApiError> {
        specs.iter().map(|s| super::render(s, taken, d)).collect()
    }

    /// Templates without a node TLS domain (the pre-W10 behaviour).
    fn render(specs: &[InboundSpec], taken: &[u16]) -> Result<Vec<Value>, ApiError> {
        render_in(specs, taken, None)
    }

    /// D2: the panel names the inbounds it renders for the agent; a
    /// template takes no tag (an unknown field) and renders none.
    #[test]
    fn templates_take_no_tag() {
        assert!(
            serde_json::from_value::<InboundSpec>(
                json!({"template": "vmess_tcp", "port": 443, "tag": "x"})
            )
            .is_err()
        );
        let v = render(&[spec(json!({"template": "vmess_tcp", "port": 443}))], &[]).unwrap();
        assert!(v[0].get("tag").is_none(), "{}", v[0]);
    }

    #[test]
    fn node_tls_domain_is_the_default_and_the_only_certificate_domain() {
        let d = Some("node1.example.com");
        let v = render_in(
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
        let e = render_in(
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
        assert!(render_in(&[spec(json!({"template": "vmess_ws", "port": 80, "tls": false, "tls_domain": "node1.example.com"}))], &[], d).is_err());
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
        crate::api::validate_inbound(i).unwrap();
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
            &[spec(json!({"template": "vless_reality", "port": 8443,
                "dest": "dl.google.com:443", "server_name": "dl.google.com", "fingerprint": "firefox"}))],
            &[],
        )
        .unwrap();
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
        assert!(
            serde_json::from_value::<InboundSpec>(
                json!({"template": "vless_reality", "port": 1, "junk": 1})
            )
            .is_err()
        );
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
        for i in &v {
            crate::api::validate_inbound(i).unwrap();
        }
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
            json!({"template": "hysteria2", "port": 443, "domain": "n.example.com"}),
        ];
        let v = render(&specs.map(spec), &[]).unwrap();
        for i in &v {
            crate::api::validate_inbound(i).unwrap();
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
    }

    /// A port another inbound of the agent uses is refused.
    #[test]
    fn taken_ports_refused() {
        let a = spec(json!({"template": "vmess_ws", "port": 80}));
        let e = render(std::slice::from_ref(&a), &[80]).unwrap_err();
        assert_eq!(e.code(), "template.port_clash");
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
