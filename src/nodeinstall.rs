//! One-line node installer (R18-2).
//!
//! `POST /api/v1/nodes` (with `install`) and `POST /nodes/{id}/install`
//! issue an **install link**: the node's one-time enrollment token
//! (`enroll::apply_issue_token` with an `InstallLink`, TTL
//! `install.token_ttl_secs`, default 1 h; only its SHA-256 is stored, it
//! replaces any earlier token of the node). The admin runs
//!
//! ```text
//! curl -fsSL https://<panel>/<prefix>/install/<token> | sh -c '[ "$(id -u)" = 0 ] || exec sudo sh; exec sh'
//! ```
//!
//! (`AS_ROOT`: as root the script runs directly, otherwise through sudo,
//! so the same line works on root-only images without sudo and for sudo
//! users; it only needs some shell that runs `sh -c '…'`.)
//!
//! on the node. `GET /{prefix}/install/{token}` serves a POSIX sh script
//! with the bootstrap file inside (panel address, server name, CA, the same
//! token) and `GET .../install/{token}/agent/{sha256}` the binary of the
//! newest complete signed linux/<arch> release (`agent_release_chunks`; the
//! script checks its SHA-256; without a release it falls back to
//! `install.fallback_binary_url` + `SHA256SUMS`). Both answer only while the
//! token is live: once the agent enrolls (burning the token) or the link
//! expires, every request is the canonical `reject::not_found()`, as are
//! unknown tokens, CLI/bootstrap tokens (install_origin NULL), deleting
//! nodes and rate-limited sources (`install.rate_per_ip` per
//! `install.rate_window_secs`, per address / IPv6 /64, Valkey; fails open
//! like enrollment — tokens are 256-bit, the limit protects CPU/DB).
//!
//! TLS of the download: the origin comes from `install.public_url`, else
//! from the admin's browser (validated `https://host[:port]`; plain http
//! only for loopback / `.test` / `.localhost` development hosts). When the
//! origin's certificate is not publicly trusted (IP-only panel behind
//! Caddy's internal CA) the command pins the served leaf key
//! (`curl -k --pinnedpubkey sha256//…`: curl checks the pin before it sends
//! the request, so -k never runs unpinned); `install.tls_pin` overrides the
//! probe. The pin is stored with the link and reused by the script.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::{DateTime, Utc};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, MaybeClientIp};
use crate::enroll::InstallLink;
use crate::state::AppState;

const SCRIPT: &str = include_str!("nodeinstall.sh");
const UNINSTALL_FN: &str = include_str!("nodeinstall-uninstall.sh");
const UNIT: &str = include_str!("../deploy/systemd/akari-agent.service");
/// W18: the agent's privileged updater (its state directory is noexec).
const UNIT_UPDATE_SERVICE: &str = include_str!("../deploy/systemd/akari-agent-update.service");
const UNIT_UPDATE_PATH: &str = include_str!("../deploy/systemd/akari-agent-update.path");

/// Architectures the installer knows (agent release names).
pub const ARCHES: [&str; 2] = ["amd64", "arm64"];

// ---------------------------------------------------------------------------
// Origins, pins, URLs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub https: bool,
    /// DNS name, IPv4 literal or bracketed IPv6 literal.
    pub host: String,
    pub port: Option<u16>,
}

impl Origin {
    pub fn as_string(&self) -> String {
        let scheme = if self.https { "https" } else { "http" };
        match self.port {
            Some(p) => format!("{scheme}://{}:{p}", self.host),
            None => format!("{scheme}://{}", self.host),
        }
    }

    fn port_or_default(&self) -> u16 {
        self.port.unwrap_or(if self.https { 443 } else { 80 })
    }

    fn ip(&self) -> Option<IpAddr> {
        self.host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse()
            .ok()
    }
}

/// Development hosts that may use plain http (never public names).
fn dev_host(o: &Origin) -> bool {
    match o.ip() {
        Some(ip) => ip.is_loopback(),
        None => {
            o.host == "localhost" || o.host.ends_with(".localhost") || o.host.ends_with(".test")
        }
    }
}

/// "https://host[:port]" with nothing else (no path, user, query); hosts
/// are DNS names or IP literals, so the value is safe inside the script's
/// single quotes.
pub fn parse_origin(s: &str) -> Result<Origin, String> {
    let s = s.trim().trim_end_matches('/');
    let (https, rest) = if let Some(r) = s.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = s.strip_prefix("http://") {
        (false, r)
    } else {
        return Err("must start with https://".into());
    };
    let (host, port) = if let Some(r) = rest.strip_prefix('[') {
        let (h, after) = r.split_once(']').ok_or("bad IPv6 literal")?;
        h.parse::<std::net::Ipv6Addr>()
            .map_err(|_| "bad IPv6 literal")?;
        let port = match after {
            "" => None,
            p => Some(p.strip_prefix(':').ok_or("bad port")?),
        };
        (format!("[{h}]"), port)
    } else {
        match rest.rsplit_once(':') {
            Some((h, p)) => (h.to_ascii_lowercase(), Some(p)),
            None => (rest.to_ascii_lowercase(), None),
        }
    };
    let port = match port {
        None => None,
        Some(p) => Some(p.parse::<u16>().ok().filter(|p| *p > 0).ok_or("bad port")?),
    };
    let is_ip = host.starts_with('[') || host.parse::<std::net::Ipv4Addr>().is_ok();
    if !is_ip && !crate::nodetpl::valid_hostname(&host) {
        return Err("host must be a domain name or an IP address (no path)".into());
    }
    let o = Origin { https, host, port };
    if !o.https && !dev_host(&o) {
        return Err("must use https:// (plain http only for localhost / *.test)".into());
    }
    Ok(o)
}

/// "sha256//<base64 of 32 bytes>".
pub fn valid_pin(p: &str) -> bool {
    p.strip_prefix("sha256//")
        .and_then(|b| STANDARD.decode(b).ok())
        .is_some_and(|b| b.len() == 32)
}

/// https URL containing "{arch}", only URL characters that mean nothing to
/// a shell or a curl config line.
pub fn fallback_url_ok(u: &str) -> bool {
    u.starts_with("https://")
        && u.contains("{arch}")
        && u.len() <= 512
        && u.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~:/?#[]@+,=%{}".contains(&b))
}

/// The SPKI pin of a DER certificate (curl --pinnedpubkey format).
pub fn spki_pin(cert_der: &[u8]) -> Option<String> {
    use x509_parser::prelude::{FromDer, X509Certificate};
    let (_, cert) = X509Certificate::from_der(cert_der).ok()?;
    let spki = cert.tbs_certificate.subject_pki.raw;
    Some(format!("sha256//{}", STANDARD.encode(Sha256::digest(spki))))
}

// ---------------------------------------------------------------------------
// TLS probe (also used by the REALITY dest check)
// ---------------------------------------------------------------------------

/// Delegates every check to the webpki verifier but only records its
/// verdict on the chain: the probe wants to see what is served even when
/// no public CA vouches for it. Handshake signatures are still verified
/// (the pin must belong to a key the server holds).
#[derive(Debug)]
struct Recorder {
    inner: Arc<rustls::client::WebPkiServerVerifier>,
    seen: Mutex<Option<(Vec<u8>, bool)>>,
}

impl ServerCertVerifier for Recorder {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let trusted = self
            .inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
            .is_ok();
        if let Ok(mut s) = self.seen.lock() {
            *s = Some((end_entity.to_vec(), trusted));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

pub struct Probe {
    pub version: Option<rustls::ProtocolVersion>,
    pub alpn: Option<Vec<u8>>,
    /// A public CA vouches for the certificate and the name.
    pub trusted: bool,
    pub pin: Option<String>,
}

/// TLS handshake with `addr` (SNI `host` unless it is an IP literal); no
/// application data is sent. 5 s timeout.
pub async fn tls_probe(addr: SocketAddr, host: &str, alpn: &[Vec<u8>]) -> Result<Probe, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = Arc::new(rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    });
    let inner =
        rustls::client::WebPkiServerVerifier::builder_with_provider(roots, provider.clone())
            .build()
            .map_err(|e| format!("verifier: {e}"))?;
    let rec = Arc::new(Recorder {
        inner,
        seen: Mutex::new(None),
    });
    let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("tls config: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(rec.clone())
        .with_no_client_auth();
    cfg.alpn_protocols = alpn.to_vec();
    let name = host.trim_start_matches('[').trim_end_matches(']');
    let server_name = ServerName::try_from(name.to_string()).map_err(|_| "bad server name")?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
    let fut = async {
        let tcp = tokio::net::TcpStream::connect(addr)
            .await
            .map_err(|e| format!("connect {addr}: {e}"))?;
        connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| format!("TLS handshake: {e}"))
    };
    let tls = tokio::time::timeout(Duration::from_secs(5), fut)
        .await
        .map_err(|_| "timed out".to_string())??;
    let (_, conn) = tls.get_ref();
    let version = conn.protocol_version();
    let alpn = conn.alpn_protocol().map(<[u8]>::to_vec);
    let seen = rec.seen.lock().ok().and_then(|s| s.clone());
    let (trusted, pin) = match seen {
        Some((der, trusted)) => (trusted, spki_pin(&der)),
        None => (false, None),
    };
    Ok(Probe {
        version,
        alpn,
        trusted,
        pin,
    })
}

/// Pin for an origin: None = publicly trusted (or plain-http dev origin).
async fn probe_origin(o: &Origin) -> Result<Option<String>, String> {
    if !o.https {
        return Ok(None);
    }
    let host = o.host.trim_start_matches('[').trim_end_matches(']');
    let addr = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, o.port_or_default())),
    )
    .await
    .map_err(|_| "DNS lookup timed out".to_string())?
    .map_err(|e| format!("DNS lookup: {e}"))?
    .next()
    .ok_or("the name has no address")?;
    let p = tls_probe(addr, &o.host, &[]).await?;
    if p.trusted && o.ip().is_none() {
        return Ok(None);
    }
    p.pin.map(Some).ok_or_else(|| "no certificate seen".into())
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseRef {
    pub version: String,
    pub sha256: String,
}

/// The newest complete (non-rollback) linux release per architecture.
async fn latest_releases(pg: &sqlx::PgPool) -> sqlx::Result<HashMap<String, ReleaseRef>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT arch, version, sha256 FROM agent_releases \
         WHERE os = 'linux' AND complete_at IS NOT NULL AND NOT rollback",
    )
    .fetch_all(pg)
    .await?;
    let mut best: HashMap<String, ReleaseRef> = HashMap::new();
    for (arch, version, sha256) in rows {
        if !ARCHES.contains(&arch.as_str()) {
            continue;
        }
        let newer = match best.get(&arch) {
            None => true,
            Some(cur) => {
                crate::updates::compare_versions(&version, &cur.version)
                    == Some(std::cmp::Ordering::Greater)
            }
        };
        if newer {
            best.insert(arch, ReleaseRef { version, sha256 });
        }
    }
    Ok(best)
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct InstallReq {
    /// The admin's browser origin (`location.origin`); ignored when
    /// install.public_url is set.
    #[serde(default)]
    pub origin: Option<String>,
}

#[derive(Serialize)]
pub struct InstallView {
    /// The link (contains the token; shown once).
    pub url: String,
    pub command: String,
    /// Only without a pin (wget cannot pin).
    pub command_wget: Option<String>,
    pub uninstall_command: String,
    pub expires_at: DateTime<Utc>,
    pub pin: Option<String>,
    /// arch → panel release; missing arch = fallback URL (or none).
    pub releases: HashMap<String, ReleaseRef>,
    pub fallback_binary_url: Option<String>,
    /// Problems the admin should know before running it.
    pub warnings: Vec<String>,
}

/// Everything needed before the transaction (network I/O stays outside).
pub struct Prepared {
    origin: String,
    pin: Option<String>,
    warnings: Vec<String>,
}

pub async fn prepare(state: &AppState, req: &InstallReq) -> Result<Prepared, ApiError> {
    let cfg = &state.cfg().install;
    // R22: the main domain (system settings, else install.public_url),
    // else the admin's browser origin.
    let raw = match state.settings().get().install_origin() {
        Some(o) => o,
        None => req.origin.clone().ok_or_else(|| {
            ApiError::bad_request("origin is required (or set the main domain in 系统设置)")
        })?,
    };
    let origin = parse_origin(&raw).map_err(|e| ApiError::bad_request(format!("origin: {e}")))?;
    let mut warnings = Vec::new();
    let pin = if !cfg.tls_pin.is_empty() {
        Some(cfg.tls_pin.clone())
    } else {
        match probe_origin(&origin).await {
            Ok(p) => p,
            Err(e) => {
                warnings.push(format!(
                    "could not check the TLS certificate of {} ({e}); the command assumes a \
                     publicly trusted certificate (set install.tls_pin for a self-signed one)",
                    origin.as_string()
                ));
                None
            }
        }
    };
    Ok(Prepared {
        origin: origin.as_string(),
        pin,
        warnings,
    })
}

impl Prepared {
    pub fn link(&self) -> InstallLink<'_> {
        InstallLink {
            origin: &self.origin,
            pin: self.pin.as_deref(),
        }
    }
}

/// Issue the link in the caller's transaction (replaces the node's token;
/// audited as `node.enroll_token` with `install_link: true`).
pub async fn apply_issue(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    actor: &Actor,
    node: Uuid,
    p: &Prepared,
) -> Result<(String, DateTime<Utc>), ApiError> {
    let endpoint = crate::settings::node_endpoint(conn, state.cfg()).await?;
    crate::enroll::apply_issue_token(
        conn,
        actor,
        node,
        state.cfg().install.token_ttl_secs,
        Some(p.link()),
        &endpoint,
    )
    .await
}

/// The end of every install command: run the script as root, directly
/// when already root (images without sudo), else through sudo. stdin (the
/// script) passes through `sh -c` untouched to the shell that runs it; a
/// missing sudo fails (exec) instead of running the script unprivileged.
pub const AS_ROOT: &str = r#"sh -c '[ "$(id -u)" = 0 ] || exec sudo sh; exec sh'"#;

pub async fn view(
    state: &AppState,
    p: Prepared,
    token: &str,
    expires_at: DateTime<Utc>,
) -> Result<InstallView, ApiError> {
    let url = format!("{}/{}/install/{token}", p.origin, state.route_prefix());
    let (command, command_wget) = match &p.pin {
        Some(pin) => (
            format!("curl -fsSL --proto '=https' -k --pinnedpubkey '{pin}' '{url}' | {AS_ROOT}"),
            None,
        ),
        None => (
            format!("curl -fsSL '{url}' | {AS_ROOT}"),
            Some(format!("wget -qO- '{url}' | {AS_ROOT}")),
        ),
    };
    let releases = latest_releases(state.pg()).await?;
    let fallback = Some(state.cfg().install.fallback_binary_url.clone()).filter(|u| !u.is_empty());
    let mut warnings = p.warnings;
    for a in ARCHES {
        if !releases.contains_key(a) && fallback.is_none() {
            warnings.push(format!(
                "no agent binary for linux/{a}: upload a release (Updates) or set \
                 install.fallback_binary_url"
            ));
        }
    }
    Ok(InstallView {
        uninstall_command: "sudo akari-agent-uninstall".into(),
        url,
        command,
        command_wget,
        expires_at,
        pin: p.pin,
        releases,
        fallback_binary_url: fallback,
        warnings,
    })
}

/// POST /nodes/{id}/install {origin?} (admin): a new install link for an
/// existing node (re-install; replaces any unused token). Once the agent
/// enrolls with it, the node's previous certificates are revoked.
pub async fn issue_install(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<InstallReq>,
) -> Result<Json<InstallView>, ApiError> {
    user.require_admin()?;
    let p = prepare(&state, &req).await?;
    let mut tx = state.pg().begin().await?;
    let (token, expires) = apply_issue(&mut tx, &state, &Actor::of(&user), id, &p).await?;
    tx.commit().await?;
    Ok(Json(view(&state, p, &token, expires).await?))
}

// ---------------------------------------------------------------------------
// Public endpoints (token-gated, uniform rejection)
// ---------------------------------------------------------------------------

struct Link {
    node: Uuid,
    name: String,
    origin: String,
    pin: Option<String>,
    expires_at: DateTime<Utc>,
    inbounds: serde_json::Value,
    /// R22: endpoint fixed when the link was issued (NULL for links issued
    /// before 0060: the current node endpoint).
    panel_addr: Option<String>,
    server_name: Option<String>,
    /// W10: the node's TLS domain (automatic certificate).
    tls_domain: Option<String>,
}

/// Rate limit, token shape, then one lookup that only matches a live
/// install link of a node that is not being deleted. None = reject.
async fn live_link(state: &AppState, ip: Option<IpAddr>, token: &str) -> Option<Link> {
    let cfg = &state.cfg().install;
    let bucket = ip
        .map(crate::client_ip::bucket)
        .unwrap_or_else(|| "unknown".into());
    match crate::rate::hit(
        state,
        format!("akari:rl:install:ip:{bucket}"),
        cfg.rate_per_ip,
        cfg.rate_window_secs,
    )
    .await
    {
        Ok(true) => {}
        Ok(false) => return None,
        Err(e) => tracing::warn!(error = %e, "install rate limit unavailable (failing open)"),
    }
    if !crate::enroll::plausible_token(token) {
        return None;
    }
    let hash = crate::enroll::hash_token(token);
    type Row = (
        Uuid,
        Vec<u8>,
        String,
        Option<String>,
        DateTime<Utc>,
        String,
        serde_json::Value,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<Row> = match sqlx::query_as(
        "SELECT e.node_id, e.token_hash, e.install_origin, e.install_pin, e.expires_at, \
                n.name, n.xray_inbounds, e.panel_addr, e.server_name, n.tls_domain \
         FROM node_enrollments e JOIN nodes n ON n.id = e.node_id \
         WHERE e.token_hash = $1 AND e.used_at IS NULL AND e.expires_at > now() \
           AND e.install_origin IS NOT NULL AND n.deleting_at IS NULL",
    )
    .bind(&hash)
    .fetch_optional(state.pg())
    .await
    {
        Ok(r) => r,
        Err(e) => {
            // Same answer as a bad token: nothing observable leaks.
            tracing::error!(error = %e, "install link lookup failed");
            return None;
        }
    };
    let (
        node,
        stored,
        origin,
        pin,
        expires_at,
        name,
        inbounds,
        panel_addr,
        server_name,
        tls_domain,
    ) = row?;
    if !bool::from(subtle::ConstantTimeEq::ct_eq(
        stored.as_slice(),
        hash.as_slice(),
    )) {
        return None;
    }
    Some(Link {
        node,
        name,
        origin,
        pin,
        expires_at,
        inbounds,
        panel_addr,
        server_name,
        tls_domain,
    })
}

/// A value for the script's single quotes: refuse anything that could end
/// them or a line (all inputs are validated already; belt and braces).
fn sq(v: &str) -> anyhow::Result<&str> {
    if v.chars().any(|c| c == '\'' || c == '\\' || c.is_control()) {
        anyhow::bail!("value not safe for the install script");
    }
    Ok(v)
}

/// Node names may hold anything but control characters; the script shows
/// a tame version in a comment.
fn tame(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || " ._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn render_script(
    state: &AppState,
    link: &Link,
    token: &str,
    releases: &HashMap<String, ReleaseRef>,
) -> anyhow::Result<String> {
    let current = state.settings().get();
    let panel_addr = link
        .panel_addr
        .as_deref()
        .unwrap_or(&current.node.panel_addr);
    let server_name = link
        .server_name
        .as_deref()
        .unwrap_or(&current.node.server_name);
    let bootstrap = crate::enroll::bootstrap_toml(
        &tame(&link.name),
        sq(panel_addr)?,
        sq(server_name)?,
        &state.install().ca_pem,
        token,
        link.expires_at,
    );
    for (body, delim) in [
        (bootstrap.as_str(), "AKARI_BOOTSTRAP_EOF"),
        (UNIT, "AKARI_UNIT_EOF"),
        (UNIT_UPDATE_SERVICE, "AKARI_UPDATE_SERVICE_EOF"),
        (UNIT_UPDATE_PATH, "AKARI_UPDATE_PATH_EOF"),
    ] {
        if body.lines().any(|l| l.trim() == delim) {
            anyhow::bail!("heredoc delimiter inside the payload");
        }
    }
    let rel = |arch: &str, f: fn(&ReleaseRef) -> &str| {
        releases.get(arch).map(f).unwrap_or("").to_string()
    };
    let fallback = &state.cfg().install.fallback_binary_url;
    let needs_cert = crate::nodetpl::needs_certificate(&link.inbounds);
    // W10: the agent obtains the certificate itself (only where an inbound
    // needs one, like ConfigSnapshot.acme).
    let acme_domain = link
        .tls_domain
        .as_deref()
        .filter(|_| needs_cert)
        .unwrap_or("");
    let vars: [(&str, String); 18] = [
        ("@@UNINSTALL_FN@@", UNINSTALL_FN.trim_end().to_string()),
        ("@@NODE_NAME@@", tame(&link.name)),
        ("@@EXPIRES@@", link.expires_at.to_rfc3339()),
        ("@@ORIGIN@@", sq(&link.origin)?.to_string()),
        ("@@PREFIX@@", sq(state.route_prefix())?.to_string()),
        ("@@TOKEN@@", sq(token)?.to_string()),
        (
            "@@PIN@@",
            sq(link.pin.as_deref().unwrap_or(""))?.to_string(),
        ),
        ("@@NEEDS_CERT@@", if needs_cert { "1" } else { "0" }.into()),
        ("@@TLS_DOMAIN@@", sq(acme_domain)?.to_string()),
        ("@@FALLBACK_URL@@", sq(fallback)?.to_string()),
        ("@@SHA_AMD64@@", rel("amd64", |r| &r.sha256)),
        ("@@SHA_ARM64@@", rel("arm64", |r| &r.sha256)),
        (
            "@@VER_AMD64@@",
            sq(&rel("amd64", |r| &r.version))?.to_string(),
        ),
        (
            "@@VER_ARM64@@",
            sq(&rel("arm64", |r| &r.version))?.to_string(),
        ),
        ("@@BOOTSTRAP@@", bootstrap.trim_end().to_string()),
        ("@@UNIT@@", UNIT.trim_end().to_string()),
        (
            "@@UNIT_UPDATE_SERVICE@@",
            UNIT_UPDATE_SERVICE.trim_end().to_string(),
        ),
        (
            "@@UNIT_UPDATE_PATH@@",
            UNIT_UPDATE_PATH.trim_end().to_string(),
        ),
    ];
    let mut out = SCRIPT.to_string();
    for (k, v) in vars {
        out = out.replace(k, &v);
    }
    Ok(out)
}

/// GET /{prefix}/install/{token}: the install script.
pub async fn script(
    State(state): State<AppState>,
    MaybeClientIp(ip): MaybeClientIp,
    Path((_, token)): Path<(String, String)>,
) -> Response {
    let Some(link) = live_link(&state, ip, &token).await else {
        return crate::reject::not_found();
    };
    let releases = match latest_releases(state.pg()).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "release lookup failed");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    match render_script(&state, &link, &token, &releases) {
        Ok(body) => {
            tracing::info!(node = %link.node, "install script served");
            (
                [
                    (
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/plain; charset=utf-8"),
                    ),
                    (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
                ],
                body,
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(node = %link.node, error = %e, "install script not rendered");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// GET /{prefix}/install/{token}/agent/{sha256}: the complete linux
/// release with that digest — the one the script was rendered with, so a
/// release uploaded in between cannot make the check fail (the script still
/// verifies the SHA-256). Downloads share the per-instance limit of
/// FetchArtifact (`updates.max_concurrent_downloads`).
pub async fn binary(
    State(state): State<AppState>,
    MaybeClientIp(ip): MaybeClientIp,
    Path((_, token, sha)): Path<(String, String, String)>,
) -> Response {
    let Some(link) = live_link(&state, ip, &token).await else {
        return crate::reject::not_found();
    };
    if sha.len() != 64 || !sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return crate::reject::not_found();
    }
    let rel: Option<(Uuid, i64)> = match sqlx::query_as(
        "SELECT id, size FROM agent_releases \
         WHERE sha256 = $1 AND os = 'linux' AND complete_at IS NOT NULL",
    )
    .bind(&sha)
    .fetch_optional(state.pg())
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "release lookup failed");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    let Some((rel_id, rel_size)) = rel else {
        return crate::reject::not_found();
    };
    let Ok(permit) = state.fetch_permits().clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, HeaderValue::from_static("5"))],
        )
            .into_response();
    };
    tracing::info!(node = %link.node, release = %rel_id, "install binary download");
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(2);
    let pg = state.pg().clone();
    tokio::spawn(async move {
        let _permit = permit;
        let mut idx: i32 = 0;
        loop {
            let data: Result<Option<Vec<u8>>, sqlx::Error> = sqlx::query_scalar(
                "SELECT data FROM agent_release_chunks WHERE release_id = $1 AND idx = $2",
            )
            .bind(rel_id)
            .bind(idx)
            .fetch_optional(&pg)
            .await;
            let msg = match data {
                Ok(Some(d)) => Ok(d),
                Ok(None) => return,
                Err(e) => {
                    tracing::warn!(release = %rel_id, idx, error = %e, "install chunk read failed");
                    Err(std::io::Error::other("chunk read failed"))
                }
            };
            let failed = msg.is_err();
            match tokio::time::timeout(Duration::from_secs(60), tx.send(msg)).await {
                Ok(Ok(())) if !failed => {}
                _ => return,
            }
            idx += 1;
        }
    });
    let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        [(header::CONTENT_LENGTH, rel_size.to_string())],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests;
