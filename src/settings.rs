//! System settings (R22, admin "系统设置"): the three domains and "trust
//! Cloudflare".
//!
//! * **Main domain** (`main_domain`): admin console, user portal, install
//!   links (`nodeinstall::prepare`) and the base of payment notify URLs
//!   (`Effective::public_origin`). Once set, the host gate is on: requests
//!   whose Host is a DNS name other than the configured main/subscription
//!   domains get the canonical rejection (IP-literal hosts stay allowed, so
//!   a mistyped domain never locks the admin out of http(s)://<ip>).
//! * **Subscription domain** (`sub_domain`): host of every subscription URL
//!   the panel hands out (`Effective::sub_url`), typically orange-clouded
//!   behind Cloudflare. Falls back to the main domain.
//! * **Node communication domain** (`node_domain`, grey cloud): panel_addr
//!   and server_name written into NEW bootstrap files / install scripts
//!   (fixed per token in `node_enrollments.panel_addr/server_name`). The
//!   gRPC server certificate covers every name in `grpc_server_names` (plus
//!   `web.advertised_names`): saving a node domain adds it, issuing any
//!   token adds the name written into that bootstrap, and only
//!   `apply_remove_server_name` (explicit admin action, shows the nodes
//!   still using it) removes one. Enrolled agents keep their bootstrap's
//!   server_name forever, so the list never shrinks implicitly
//!   (`sans_never_shrink`).
//! * **trust Cloudflare**: Cloudflare's edge ranges join the trusted proxies
//!   (`client_ip.rs`).
//! * **Latency tests** (W12, 0091): `[probe]` interval, test URLs and the
//!   panel's TCP test (`Effective::probe`). Agents with the `latency`
//!   capability get the effective values in `LatencyProbeConfig`: a change
//!   wakes every local session on every instance (`reload` →
//!   `Wakeups::wake_all`), each re-sends the config when it differs from
//!   what it last sent; the panel TCP test loop reads them every round. A
//!   shorter interval pulls far-off scheduled panel tests forward in the
//!   saving transaction (`apply_update_probe`).
//!
//! Precedence: a database value (non-NULL column) wins; NULL = panel.toml
//! (`install.public_url`, `web.sub_domain`, `grpc.advertise` /
//! `grpc.server_name`, `web.trust_cloudflare`, `[probe] interval_secs` /
//! `urls` / `panel_tcp`). `akari config check` shows
//! both; `akari settings show|unset` reads/clears the database side (e.g.
//! after a mistyped main domain).
//!
//! Writes: `apply_update` / `apply_remove_server_name` in the caller's
//! transaction, audited in the same transaction, `version` bumped. The 0060
//! triggers NOTIFY `akari_change` 'settings' in that transaction; every
//! instance (`notify.rs`) then runs `reload`, which reads the row and the
//! name list, recomputes `Effective` and — when the name set changed —
//! issues a new gRPC server certificate and swaps it into the live TLS
//! acceptor (`tlsserver::CertResolver`): no restart. Reloads are
//! serialized per instance and always read fresh, so an older read never
//! overwrites a newer one; every (re)established LISTEN reloads too.

use std::collections::{BTreeSet, HashSet};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::client_ip::{Cidr, Trust};
use crate::config::{PanelConfig, ProbeConfig};
use crate::install::Install;
use crate::nodeinstall::Origin;
use crate::state::AppState;
use crate::tlsserver::CertResolver;

// ---------------------------------------------------------------------------
// Domain values
// ---------------------------------------------------------------------------

/// A validated domain setting: an ASCII host (IDN as punycode, lowercase,
/// no trailing dot) or an IP literal, and an optional port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Domain {
    /// DNS name or IP literal (IPv6 without brackets).
    pub host: String,
    pub port: Option<u16>,
}

impl Domain {
    /// Parse what an admin typed: `example.com`, `例子.中国`, `a.b:8443`,
    /// `203.0.113.7`, `[2001:db8::1]:443`. No scheme, path, user info,
    /// query, whitespace or wildcard. Error texts are shown in the
    /// (Chinese-only) admin console.
    pub fn parse(input: &str) -> Result<Self, String> {
        let s = input.trim();
        if s.is_empty() {
            return Err("不能为空".into());
        }
        // Only a bound on the work: the ASCII form is held to 253 bytes
        // below. The Unicode form of a valid IDN can be far longer than
        // its punycode (a 63-byte label holds up to ~59 CJK characters,
        // 3 bytes each), and the console sends back the Unicode `display`
        // it shows, so it must parse (fuzz: domain).
        if s.len() > 1024 {
            return Err("太长".into());
        }
        if s.contains("://") {
            return Err("只填写域名，不要带 http:// 或 https://".into());
        }
        if s.chars().any(|c| {
            matches!(c, '/' | '\\' | '?' | '#' | '@' | '*' | '"' | '\'')
                || c.is_whitespace()
                || c.is_control()
        }) {
            return Err("只填写域名（可带 :端口），不要带路径、通配符、空格或其他符号".into());
        }
        let (host, port) = if let Some(r) = s.strip_prefix('[') {
            let (h, after) = r.split_once(']').ok_or("IPv6 地址格式错误")?;
            if h.parse::<std::net::Ipv6Addr>().is_err() {
                return Err("IPv6 地址格式错误".into());
            }
            let port = match after {
                "" => None,
                p => Some(p.strip_prefix(':').ok_or("端口格式错误")?),
            };
            (h, port)
        } else if s.matches(':').count() > 1 {
            // A bare IPv6 literal (no port possible without brackets).
            (s, None)
        } else {
            match s.rsplit_once(':') {
                Some((h, p)) => (h, Some(p)),
                None => (s, None),
            }
        };
        let port = match port {
            None => None,
            Some(p) => Some(
                p.parse::<u16>()
                    .ok()
                    .filter(|p| *p > 0)
                    .ok_or("端口必须是 1–65535")?,
            ),
        };
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(Self {
                host: ip.to_canonical().to_string(),
                port,
            });
        }
        let host = host.trim_end_matches('.');
        let ascii = idna::domain_to_ascii_strict(host).map_err(|_| "不是有效的域名")?;
        let labels: Vec<&str> = ascii.split('.').collect();
        let ok = !ascii.is_empty()
            && ascii.len() <= 253
            && labels.len() >= 2
            && labels.iter().all(|l| {
                !l.is_empty()
                    && l.len() <= 63
                    && !l.starts_with('-')
                    && !l.ends_with('-')
                    && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
            && labels
                .last()
                .is_some_and(|tld| !tld.bytes().all(|b| b.is_ascii_digit()));
        if !ok {
            return Err("不是有效的域名（需要形如 panel.example.com）".into());
        }
        Ok(Self { host: ascii, port })
    }

    pub fn is_ip(&self) -> bool {
        self.host.parse::<IpAddr>().is_ok()
    }

    fn bracketed_host(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        }
    }

    /// `host[:port]` as stored (IPv6 bracketed).
    pub fn authority(&self) -> String {
        match self.port {
            Some(p) => format!("{}:{p}", self.bracketed_host()),
            None => self.bracketed_host(),
        }
    }

    /// The host as people read it (IDN in Unicode).
    pub fn display(&self) -> String {
        let (u, _) = idna::domain_to_unicode(&self.host);
        match self.port {
            Some(p) if self.host.contains(':') => format!("[{u}]:{p}"),
            Some(p) => format!("{u}:{p}"),
            None => u,
        }
    }

    pub fn https_origin(&self) -> Origin {
        Origin {
            https: true,
            host: self.bracketed_host(),
            port: self.port,
        }
    }
}

/// A Host header (or request authority) reduced to its host: port and
/// trailing dot stripped, lowercase, IPv6 without brackets.
pub fn request_host(raw: &str) -> String {
    let raw = raw.trim();
    let host = if let Some(r) = raw.strip_prefix('[') {
        r.split_once(']').map(|(h, _)| h).unwrap_or(r)
    } else if raw.matches(':').count() == 1 {
        raw.rsplit_once(':').map(|(h, _)| h).unwrap_or(raw)
    } else {
        raw
    };
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// The host a request was sent to (Host header, else the URI authority).
pub fn host_of(headers: &HeaderMap, uri: &axum::http::Uri) -> Option<String> {
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(request_host)
        .or_else(|| uri.authority().map(|a| request_host(a.as_str())))
}

// ---------------------------------------------------------------------------
// Stored row and effective values
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct Stored {
    pub version: i64,
    pub main_domain: Option<String>,
    pub sub_domain: Option<String>,
    pub node_domain: Option<String>,
    pub trust_cloudflare: Option<bool>,
    /// W12: latency tests (NULL = panel.toml `[probe]`).
    pub probe_interval_secs: Option<i32>,
    pub probe_urls: Option<Vec<String>>,
    pub probe_panel_tcp: Option<bool>,
    #[serde(skip)]
    pub updated_at: Option<DateTime<Utc>>,
}

const STORED_COLS: &str = "version, main_domain, sub_domain, node_domain, trust_cloudflare, \
     probe_interval_secs, probe_urls, probe_panel_tcp, updated_at";
const SELECT_STORED: &str = "SELECT version, main_domain, sub_domain, node_domain, \
     trust_cloudflare, probe_interval_secs, probe_urls, probe_panel_tcp, updated_at \
     FROM panel_settings WHERE id = 1";
const LOCK_STORED: &str = "SELECT version, main_domain, sub_domain, node_domain, \
     trust_cloudflare, probe_interval_secs, probe_urls, probe_panel_tcp, updated_at \
     FROM panel_settings WHERE id = 1 FOR UPDATE";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct ServerName {
    pub name: String,
    pub source: String,
    pub first_used_at: DateTime<Utc>,
}

/// Where an effective value comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// The database (admin "系统设置").
    Settings,
    /// panel.toml.
    Config,
    /// The subscription domain follows the main domain.
    Main,
    /// Nothing configured: the admin's browser origin is used.
    Browser,
}

/// What a bootstrap file / install script tells an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NodeEndpoint {
    /// host:port the agent dials.
    pub panel_addr: String,
    /// TLS server name the agent verifies.
    pub server_name: String,
}

#[derive(Debug, Clone)]
pub struct Effective {
    pub stored: Stored,
    pub server_names: Vec<ServerName>,
    pub main: Option<Origin>,
    pub main_source: Source,
    pub sub: Option<Origin>,
    pub sub_source: Source,
    pub node: NodeEndpoint,
    pub node_source: Source,
    pub trust_cloudflare: bool,
    pub trust_source: Source,
    pub trust: Trust,
    /// W12: the effective latency-test settings (`[probe]` with the stored
    /// interval / URLs / panel TCP switch applied) and where each comes from.
    pub probe: ProbeConfig,
    pub probe_sources: ProbeSources,
    /// Some = the host gate is on (main domain set in the database): DNS
    /// names allowed as Host.
    host_gate: Option<HashSet<String>>,
    /// Names Caddy may obtain certificates for (ask endpoint).
    ask_hosts: HashSet<String>,
    /// Names the gRPC server certificate must cover (sorted).
    pub sans: Vec<String>,
}

/// Where each editable latency-test value comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ProbeSources {
    pub interval_secs: Source,
    pub urls: Source,
    pub panel_tcp: Source,
}

/// Bounds of the editable latency-test values (= `config_check`'s).
pub const PROBE_INTERVAL_SECS: std::ops::RangeInclusive<u64> = 600..=604_800;
pub const PROBE_MAX_URLS: usize = 4;

/// Pure: `[probe]` with the stored values applied. A stored value outside
/// the bounds (impossible through the API and the 0091 CHECKs) is ignored
/// with an error log.
fn effective_probe(cfg: &PanelConfig, stored: &Stored) -> (ProbeConfig, ProbeSources) {
    let mut p = cfg.probe.clone();
    let mut src = ProbeSources {
        interval_secs: Source::Config,
        urls: Source::Config,
        panel_tcp: Source::Config,
    };
    if let Some(v) = stored.probe_interval_secs {
        match u64::try_from(v) {
            Ok(v) if PROBE_INTERVAL_SECS.contains(&v) => {
                p.interval_secs = v;
                src.interval_secs = Source::Settings;
            }
            _ => tracing::error!(value = v, "stored probe interval out of range; ignored"),
        }
    }
    if let Some(urls) = &stored.probe_urls {
        if valid_probe_urls(urls) {
            p.urls = urls.clone();
            src.urls = Source::Settings;
        } else {
            tracing::error!("stored probe URLs invalid; ignored");
        }
    }
    if let Some(b) = stored.probe_panel_tcp {
        p.panel_tcp = b;
        src.panel_tcp = Source::Settings;
    }
    (p, src)
}

fn valid_probe_urls(urls: &[String]) -> bool {
    !urls.is_empty()
        && urls.len() <= PROBE_MAX_URLS
        && urls.iter().all(|u| crate::nodestat::valid_probe_url(u))
        && urls.iter().collect::<HashSet<_>>().len() == urls.len()
}

fn origin_host(o: &Origin) -> String {
    o.host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

/// Port of `grpc.advertise` (validated at startup; 8443 if unparsable).
fn advertise_port(cfg: &PanelConfig) -> u16 {
    cfg.grpc
        .advertise
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse().ok())
        .unwrap_or(8443)
}

/// Pure: the effective settings from panel.toml, the stored row and the
/// name history. A stored value that no longer parses (cannot happen
/// through the API) is ignored with an error log, as if unset.
pub fn compute(
    cfg: &PanelConfig,
    stored: Stored,
    server_names: Vec<ServerName>,
    cloudflare: &[Cidr],
) -> Effective {
    let parsed = |field: &str, v: &Option<String>| -> Option<Domain> {
        let v = v.as_deref()?;
        match Domain::parse(v) {
            Ok(d) => Some(d),
            Err(e) => {
                tracing::error!(field, error = %e, "stored setting does not parse; ignored");
                None
            }
        }
    };
    let config_main = Some(cfg.install.public_url.as_str())
        .filter(|u| !u.is_empty())
        .and_then(|u| crate::nodeinstall::parse_origin(u).ok());
    let (main, main_source) = match parsed("main_domain", &stored.main_domain) {
        Some(d) => (Some(d.https_origin()), Source::Settings),
        None => match &config_main {
            Some(o) => (Some(o.clone()), Source::Config),
            None => (None, Source::Browser),
        },
    };
    let config_sub = Some(cfg.web.sub_domain.as_str())
        .filter(|s| !s.is_empty())
        .and_then(|s| Domain::parse(s).ok());
    let (sub, sub_source) = match parsed("sub_domain", &stored.sub_domain) {
        Some(d) => (Some(d.https_origin()), Source::Settings),
        None => match config_sub {
            Some(d) => (Some(d.https_origin()), Source::Config),
            None => (
                main.clone(),
                if main.is_some() {
                    Source::Main
                } else {
                    Source::Browser
                },
            ),
        },
    };
    let (node, node_source) = match parsed("node_domain", &stored.node_domain) {
        Some(d) => (
            NodeEndpoint {
                panel_addr: Domain {
                    host: d.host.clone(),
                    port: Some(d.port.unwrap_or_else(|| advertise_port(cfg))),
                }
                .authority(),
                server_name: d.host,
            },
            Source::Settings,
        ),
        None => (
            NodeEndpoint {
                panel_addr: cfg.grpc.advertise.clone(),
                server_name: cfg.grpc.server_name.clone(),
            },
            Source::Config,
        ),
    };
    let (trust_cloudflare, trust_source) = match stored.trust_cloudflare {
        Some(v) => (v, Source::Settings),
        None => (cfg.web.trust_cloudflare, Source::Config),
    };
    let trust = Trust {
        proxies: cfg.web.trusted_proxies.clone(),
        cloudflare: if trust_cloudflare {
            cloudflare.to_vec()
        } else {
            Vec::new()
        },
    };
    let mut ask_hosts = HashSet::new();
    for o in [&main, &sub].into_iter().flatten() {
        let h = origin_host(o);
        if h.parse::<IpAddr>().is_err() {
            ask_hosts.insert(h);
        }
    }
    // An explicit payment notify URL on its own host: Alipay must reach it
    // (certificate and host gate), whatever the main domain is.
    if let Some(h) = crate::billing::explicit_notify_host(cfg) {
        if h.parse::<IpAddr>().is_err() {
            ask_hosts.insert(h);
        }
    }
    let host_gate = (main_source == Source::Settings).then(|| {
        let mut allowed = ask_hosts.clone();
        if let Some(o) = &config_main {
            allowed.insert(origin_host(o));
        }
        allowed
    });
    let sans = sans(cfg, &server_names, &node.server_name);
    let (probe, probe_sources) = effective_probe(cfg, &stored);
    Effective {
        probe,
        probe_sources,
        stored,
        server_names,
        main,
        main_source,
        sub,
        sub_source,
        node,
        node_source,
        trust_cloudflare,
        trust_source,
        trust,
        host_gate,
        ask_hosts,
        sans,
    }
}

/// The gRPC server certificate's names: panel.toml's advertised_names, every
/// recorded server name, and the current node server name. Grows with the
/// history; nothing here can drop a recorded name.
pub fn sans(cfg: &PanelConfig, history: &[ServerName], node_server_name: &str) -> Vec<String> {
    let mut set: BTreeSet<String> = cfg.web.advertised_names.iter().cloned().collect();
    set.extend(history.iter().map(|n| n.name.clone()));
    if !node_server_name.is_empty() {
        set.insert(node_server_name.to_string());
    }
    set.into_iter().collect()
}

impl Effective {
    /// Host gate: may a request addressed to `host` (see `request_host`)
    /// be served? IP literals always; DNS names only the configured ones
    /// once the main domain is set in the settings.
    pub fn host_allowed(&self, host: Option<&str>) -> bool {
        let Some(gate) = &self.host_gate else {
            return true;
        };
        match host {
            Some(h) => h.parse::<IpAddr>().is_ok() || gate.contains(h),
            None => false,
        }
    }

    pub fn host_gate_on(&self) -> bool {
        self.host_gate.is_some()
    }

    /// Caddy on-demand TLS: may a certificate be obtained for `domain`?
    pub fn ask_allowed(&self, domain: &str) -> bool {
        let d = domain.trim().trim_end_matches('.').to_ascii_lowercase();
        !d.is_empty() && self.ask_hosts.contains(&d)
    }

    /// Origin of install links: the main domain (settings, else
    /// install.public_url); None = the admin's browser origin.
    pub fn install_origin(&self) -> Option<String> {
        self.main.as_ref().map(Origin::as_string)
    }

    /// Public origin of the panel (main domain) for links handed to third
    /// parties, e.g. payment notify URLs: `<origin>/<prefix>/...`. None =
    /// not configured (callers fall back to their own configuration).
    pub fn public_origin(&self) -> Option<String> {
        self.install_origin()
    }

    /// Lower-case host of the main domain (None = browser origin).
    pub fn main_host(&self) -> Option<String> {
        self.main.as_ref().map(origin_host)
    }

    /// Advisory notes that hold while the configuration stays as it is
    /// (shown by 系统设置 and `config check`).
    pub fn standing_warnings(&self, cfg: &PanelConfig) -> Vec<String> {
        let mut w = Vec::new();
        let main = self.main_host();
        if let Some(n) = crate::billing::notify_host_mismatch(cfg, main.as_deref()) {
            w.push(format!(
                "支付宝通知地址（payments.alipay.notify_url）指向 {n}，不是主域名 {}：支付宝的异步通知发往 {n}（面板继续接受该域名）。\
                 留空 notify_url 即随主域名生成",
                main.as_deref().unwrap_or_default()
            ));
        }
        if cfg.payments.alipay.enabled
            && cfg.payments.alipay.notify_url.is_empty()
            && self.main.is_none()
        {
            w.push(
                "支付已启用但没有主域名：支付宝异步通知地址由主域名生成，设置主域名之前无法创建订单"
                    .into(),
            );
        }
        w
    }

    /// Subscription URL for a token (subscription domain, else the main
    /// domain); None = not configured (the SPA uses its own origin).
    pub fn sub_url(&self, prefix: &str, token: &str) -> Option<String> {
        self.sub
            .as_ref()
            .map(|o| format!("{}/{prefix}/sub/{token}", o.as_string()))
    }
}

// ---------------------------------------------------------------------------
// Live state (per instance)
// ---------------------------------------------------------------------------

/// Per-instance view of the settings, kept current by `reload`.
pub struct Live {
    current: ArcSwap<Effective>,
    certs: Arc<CertResolver>,
    reload_lock: tokio::sync::Mutex<()>,
    cloudflare: Vec<Cidr>,
    /// Ask endpoint CPU guard: (window start, answered in window).
    ask_window: Mutex<(Instant, u32)>,
}

impl Live {
    /// From panel.toml alone (the database is read by `init`). Serves the
    /// boot certificate of `install` (web.advertised_names) until then.
    pub fn new(cfg: &PanelConfig, install: &Install) -> Self {
        let cloudflare = crate::cloudflare::ranges(cfg);
        let eff = compute(cfg, Stored::default(), Vec::new(), &cloudflare);
        let certs = Arc::new(CertResolver::default());
        if !install.server_cert_pem.is_empty() {
            let names: Vec<String> = cfg
                .web
                .advertised_names
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            if let Err(e) = certs.set(&install.server_cert_pem, &install.server_key_pem, names) {
                tracing::error!(error = %e, "boot server certificate unusable");
            }
        }
        Self {
            current: ArcSwap::from_pointee(eff),
            certs,
            reload_lock: tokio::sync::Mutex::new(()),
            cloudflare,
            ask_window: Mutex::new((Instant::now(), 0)),
        }
    }

    pub fn get(&self) -> Arc<Effective> {
        self.current.load_full()
    }

    pub fn certs(&self) -> &Arc<CertResolver> {
        &self.certs
    }

    pub fn cloudflare(&self) -> &[Cidr] {
        &self.cloudflare
    }

    /// Fixed one-second window; true = answer this ask request.
    fn ask_permit(&self, per_sec: u32) -> bool {
        let mut w = self.ask_window.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        if now.duration_since(w.0) >= Duration::from_secs(1) {
            *w = (now, 0);
        }
        if w.1 >= per_sec {
            return false;
        }
        w.1 += 1;
        true
    }
}

async fn load(conn: &mut PgConnection) -> sqlx::Result<(Stored, Vec<ServerName>)> {
    let stored: Stored = sqlx::query_as(SELECT_STORED).fetch_one(&mut *conn).await?;
    let names: Vec<ServerName> = sqlx::query_as(
        "SELECT name, source, first_used_at FROM grpc_server_names ORDER BY first_used_at, name",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok((stored, names))
}

/// Re-read the settings and apply them on this instance: effective values
/// and, when the name set changed, a new gRPC server certificate.
pub async fn reload(state: &AppState) -> anyhow::Result<()> {
    let live = state.settings();
    let _serial = live.reload_lock.lock().await;
    let mut tx = state.pg().begin().await?;
    // One snapshot for the row and the list.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let (stored, names) = load(&mut tx).await?;
    tx.commit().await?;
    let eff = compute(state.cfg(), stored, names, live.cloudflare());
    let inst = state.install();
    if eff.sans != live.certs.names() && !inst.ca_pem.is_empty() {
        let (cert, key) =
            crate::install::issue_server_cert(&inst.ca_pem, &inst.ca_key_pem, &eff.sans)?;
        live.certs.set(&cert, &key, eff.sans.clone())?;
        tracing::info!(names = ?eff.sans, "gRPC server certificate re-issued");
    }
    let probe_changed = probe_wire(&live.get().probe) != probe_wire(&eff.probe);
    live.current.store(Arc::new(eff));
    if probe_changed {
        // Every local session re-reads and re-sends LatencyProbeConfig when
        // it differs from what it sent (jittered wake-all; settings changes
        // are rare admin actions).
        tracing::info!("latency test settings changed; waking agent sessions");
        state.wakeups().wake_all();
    }
    Ok(())
}

/// The latency-test values agents receive (what a change must re-send).
fn probe_wire(p: &ProbeConfig) -> (u64, &[String], u32, u32) {
    (p.interval_secs, &p.urls, p.timeout_ms, p.attempts)
}

/// Startup: record panel.toml's grpc.server_name (agents enrolled before
/// 0060 verify it), then load.
pub async fn init(state: &AppState) -> anyhow::Result<()> {
    let mut conn = state.pg().acquire().await?;
    record_server_name(&mut conn, &state.cfg().grpc.server_name, "config").await?;
    drop(conn);
    reload(state).await
}

async fn reload_logged(state: &AppState) {
    if let Err(e) = reload(state).await {
        tracing::warn!(error = %e, "settings reload failed");
    }
}

/// Background reload (notify path): errors are logged; the next
/// notification or LISTEN reconnect retries.
pub fn spawn_reload(state: &AppState) {
    let st = state.clone();
    tokio::spawn(async move {
        if let Err(e) = reload(&st).await {
            tracing::warn!(error = %e, "settings reload failed");
        }
    });
}

/// Remember a gRPC server name (no-op if known).
pub async fn record_server_name(
    conn: &mut PgConnection,
    name: &str,
    source: &str,
) -> sqlx::Result<()> {
    if name.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO grpc_server_names (name, source) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
    )
    .bind(name)
    .bind(source)
    .execute(conn)
    .await?;
    Ok(())
}

/// The endpoint for a bootstrap issued in the caller's transaction (read
/// from the database, not this instance's cache).
pub async fn node_endpoint(
    conn: &mut PgConnection,
    cfg: &PanelConfig,
) -> sqlx::Result<NodeEndpoint> {
    let stored: Stored = sqlx::query_as(SELECT_STORED).fetch_one(&mut *conn).await?;
    Ok(compute(cfg, stored, Vec::new(), &[]).node)
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/// New values (already validated/normalized; None = unset → panel.toml).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Values {
    pub main_domain: Option<String>,
    pub sub_domain: Option<String>,
    pub node_domain: Option<String>,
    pub trust_cloudflare: Option<bool>,
}

impl Values {
    fn of(s: &Stored) -> Self {
        Self {
            main_domain: s.main_domain.clone(),
            sub_domain: s.sub_domain.clone(),
            node_domain: s.node_domain.clone(),
            trust_cloudflare: s.trust_cloudflare,
        }
    }
    fn audit(&self) -> serde_json::Value {
        json!({
            "main_domain": self.main_domain,
            "sub_domain": self.sub_domain,
            "node_domain": self.node_domain,
            "trust_cloudflare": self.trust_cloudflare,
        })
    }
}

/// Write the settings (optimistic: `expected_version` must be current, else
/// 409). A node domain is added to the gRPC server names. Audited as
/// `settings.update`. Returns the new row (unchanged values: no write).
pub async fn apply_update(
    conn: &mut PgConnection,
    actor: &Actor,
    expected_version: i64,
    new: &Values,
) -> Result<Stored, ApiError> {
    let cur: Stored = sqlx::query_as(LOCK_STORED).fetch_one(&mut *conn).await?;
    if cur.version != expected_version {
        return Err(ApiError::conflict(
            "设置已被修改（可能是其他管理员），请刷新后重试",
        ));
    }
    let before = Values::of(&cur);
    if &before == new {
        return Ok(cur);
    }
    let row: Stored = sqlx::query_as(
        "UPDATE panel_settings SET main_domain = $1, sub_domain = $2, node_domain = $3, \
             trust_cloudflare = $4, version = version + 1, updated_at = now() \
         WHERE id = 1 \
         RETURNING version, main_domain, sub_domain, node_domain, trust_cloudflare, \
             probe_interval_secs, probe_urls, probe_panel_tcp, updated_at",
    )
    .bind(&new.main_domain)
    .bind(&new.sub_domain)
    .bind(&new.node_domain)
    .bind(new.trust_cloudflare)
    .fetch_one(&mut *conn)
    .await?;
    if new.node_domain != before.node_domain {
        if let Some(d) = new
            .node_domain
            .as_deref()
            .and_then(|d| Domain::parse(d).ok())
        {
            record_server_name(conn, &d.host, "settings").await?;
        }
    }
    crate::audit::record(
        conn,
        actor,
        "settings.update",
        "settings",
        None,
        Some(before.audit()),
        Some(new.audit()),
    )
    .await?;
    Ok(row)
}

/// W12: new latency-test values (validated; None = unset → panel.toml).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeValues {
    pub interval_secs: Option<i32>,
    pub urls: Option<Vec<String>>,
    pub panel_tcp: Option<bool>,
}

impl ProbeValues {
    fn of(s: &Stored) -> Self {
        Self {
            interval_secs: s.probe_interval_secs,
            urls: s.probe_urls.clone(),
            panel_tcp: s.probe_panel_tcp,
        }
    }
    fn audit(&self) -> serde_json::Value {
        json!({
            "probe_interval_secs": self.interval_secs,
            "probe_urls": self.urls,
            "probe_panel_tcp": self.panel_tcp,
        })
    }
}

/// Write the latency-test settings (same row and `version` as the domains:
/// 409 on a stale form). Audited as `settings.probe.update`. When the
/// effective interval got shorter, panel TCP tests scheduled beyond the new
/// interval are re-spread over it (otherwise a 5 h → 10 min change would
/// wait up to 5 h). Agents follow through the reload's session wake-up.
pub async fn apply_update_probe(
    conn: &mut PgConnection,
    actor: &Actor,
    cfg: &PanelConfig,
    expected_version: i64,
    new: &ProbeValues,
) -> Result<Stored, ApiError> {
    let cur: Stored = sqlx::query_as(LOCK_STORED).fetch_one(&mut *conn).await?;
    if cur.version != expected_version {
        return Err(ApiError::conflict(
            "设置已被修改（可能是其他管理员），请刷新后重试",
        ));
    }
    let before = ProbeValues::of(&cur);
    if &before == new {
        return Ok(cur);
    }
    let row: Stored = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE panel_settings SET probe_interval_secs = $1, probe_urls = $2, \
             probe_panel_tcp = $3, version = version + 1, updated_at = now() \
         WHERE id = 1 RETURNING {STORED_COLS}"
    )))
    .bind(new.interval_secs)
    .bind(&new.urls)
    .bind(new.panel_tcp)
    .fetch_one(&mut *conn)
    .await?;
    let old_iv = effective_probe(cfg, &cur).0.interval_secs;
    let new_iv = effective_probe(cfg, &row).0.interval_secs;
    if new_iv < old_iv {
        sqlx::query(
            "UPDATE nodes SET panel_probe_next_at = now() + make_interval(secs => $1 * random()) \
             WHERE panel_probe_next_at > now() + make_interval(secs => $1)",
        )
        .bind(new_iv as f64)
        .execute(&mut *conn)
        .await?;
    }
    crate::audit::record(
        conn,
        actor,
        "settings.probe.update",
        "settings",
        None,
        Some(before.audit()),
        Some(new.audit()),
    )
    .await?;
    Ok(row)
}

/// A node that may still verify a server name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct AffectedNode {
    pub id: Uuid,
    pub name: String,
    /// "enrolled" (its agent uses the name), "pending" (an unused token's
    /// bootstrap carries it) or "unknown" (enrolled before 0060: the name
    /// was not recorded).
    pub reason: String,
}

/// Nodes still using `name` (enrolled with it, or holding a live token
/// for it). Nodes enrolled before 0060 are listed by `legacy_nodes`.
pub async fn nodes_using(conn: &mut PgConnection, name: &str) -> sqlx::Result<Vec<AffectedNode>> {
    sqlx::query_as(
        "SELECT id, name, 'enrolled' AS reason FROM nodes \
         WHERE deleting_at IS NULL AND cert_serial IS NOT NULL AND server_name = $1 \
         UNION \
         SELECT n.id, n.name, 'pending' AS reason FROM node_enrollments e JOIN nodes n ON n.id = e.node_id \
         WHERE e.server_name = $1 AND e.used_at IS NULL AND e.expires_at > now() \
           AND n.deleting_at IS NULL \
         ORDER BY name, reason",
    )
    .bind(name)
    .fetch_all(conn)
    .await
}

/// Enrolled nodes whose server name is unknown (enrolled before 0060).
pub async fn legacy_nodes(conn: &mut PgConnection) -> sqlx::Result<Vec<AffectedNode>> {
    sqlx::query_as(
        "SELECT id, name, 'unknown' AS reason FROM nodes \
         WHERE deleting_at IS NULL AND cert_serial IS NOT NULL AND server_name IS NULL \
         ORDER BY name",
    )
    .fetch_all(conn)
    .await
}

/// Why a recorded name cannot be removed (None = removable).
fn removal_blocker(cfg: &PanelConfig, eff_node: &NodeEndpoint, name: &str) -> Option<&'static str> {
    if eff_node.server_name.eq_ignore_ascii_case(name) {
        return Some("这是当前的节点通信域名，不能移除");
    }
    if cfg.grpc.server_name.eq_ignore_ascii_case(name)
        || cfg
            .web
            .advertised_names
            .iter()
            .any(|n| n.eq_ignore_ascii_case(name))
    {
        return Some("这个名称来自 panel.toml（grpc.server_name / web.advertised_names），请在配置文件中修改");
    }
    None
}

/// Explicit removal of a gRPC server name (the next certificate no longer
/// covers it: agents verifying it fail their next handshake). Audited as
/// `settings.server_name.remove` with the nodes that still used it.
pub async fn apply_remove_server_name(
    conn: &mut PgConnection,
    actor: &Actor,
    cfg: &PanelConfig,
    name: &str,
) -> Result<Vec<AffectedNode>, ApiError> {
    let cur: Stored = sqlx::query_as(LOCK_STORED).fetch_one(&mut *conn).await?;
    let eff = compute(cfg, cur, Vec::new(), &[]);
    if let Some(why) = removal_blocker(cfg, &eff.node, name) {
        return Err(ApiError::bad_request(why));
    }
    let source: Option<String> =
        sqlx::query_scalar("DELETE FROM grpc_server_names WHERE name = $1 RETURNING source")
            .bind(name)
            .fetch_optional(&mut *conn)
            .await?;
    let Some(source) = source else {
        return Err(ApiError::not_found());
    };
    let affected = nodes_using(conn, name).await?;
    sqlx::query("UPDATE panel_settings SET version = version + 1, updated_at = now() WHERE id = 1")
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.server_name.remove",
        "settings",
        Some(name.to_string()),
        Some(json!({ "name": name, "source": source })),
        Some(json!({
            "affected_nodes": affected.iter().map(|n| n.id).collect::<Vec<_>>(),
        })),
    )
    .await?;
    Ok(affected)
}

// ---------------------------------------------------------------------------
// DNS check
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Main,
    Sub,
    Node,
}

#[derive(Debug, Clone, Serialize)]
pub struct AddrView {
    pub ip: IpAddr,
    pub cloudflare: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DnsCheck {
    pub domain: String,
    pub addresses: Vec<AddrView>,
    /// "ok" | "warn" | "block" (block = saving needs the override).
    pub level: &'static str,
    pub message: String,
}

const DNS_TIMEOUT: Duration = Duration::from_secs(5);

/// A/AAAA of `host` as this panel sees them (an IP literal is itself).
pub async fn resolve(host: &str) -> Result<Vec<IpAddr>, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![ip.to_canonical()]);
    }
    let found = tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((host, 443)))
        .await
        .map_err(|_| "DNS 查询超时".to_string())?
        .map_err(|e| format!("DNS 查询失败：{e}"))?;
    let set: BTreeSet<IpAddr> = found.map(|sa| sa.ip().to_canonical()).collect();
    if set.is_empty() {
        return Err("没有 A/AAAA 记录".into());
    }
    Ok(set.into_iter().collect())
}

/// Pure verdict on resolved addresses.
pub fn judge(kind: Kind, domain: &Domain, addrs: &[IpAddr], cloudflare: &[Cidr]) -> DnsCheck {
    let addresses: Vec<AddrView> = addrs
        .iter()
        .map(|ip| AddrView {
            ip: *ip,
            cloudflare: crate::cloudflare::contains(cloudflare, *ip),
        })
        .collect();
    let any_cf = addresses.iter().any(|a| a.cloudflare);
    let all_cf = !addresses.is_empty() && addresses.iter().all(|a| a.cloudflare);
    let list = addresses
        .iter()
        .map(|a| a.ip.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let (level, message) = match kind {
        Kind::Node if any_cf => (
            "block",
            format!(
                "{} 解析到 Cloudflare 的地址（{list}），说明开启了橙色云朵（代理）。节点 agent 与面板之间是 \
                 gRPC + 双向 TLS 直连，经过 Cloudflare 代理会被它终止 TLS，agent 将无法连接。请在 \
                 Cloudflare 把这条记录改为灰色云朵（仅 DNS），或换一个不经过代理的域名。",
                domain.display()
            ),
        ),
        Kind::Node => (
            "ok",
            format!("{} 解析到 {list}，未经过 Cloudflare 代理（灰色云朵），可以用于节点通信。", domain.display()),
        ),
        Kind::Sub if all_cf => (
            "ok",
            format!("{} 解析到 Cloudflare（{list}），已经过橙色云朵代理。", domain.display()),
        ),
        Kind::Sub => (
            "warn",
            format!(
                "{} 解析到 {list}，看起来没有经过 Cloudflare 代理（橙色云朵）。如果你打算用 Cloudflare \
                 保护订阅域名，请在 Cloudflare 开启代理；不使用 Cloudflare 可以忽略此提示。",
                domain.display()
            ),
        ),
        Kind::Main => (
            "ok",
            format!(
                "{} 解析到 {list}{}。",
                domain.display(),
                if any_cf { "（经过 Cloudflare 代理）" } else { "" }
            ),
        ),
    };
    DnsCheck {
        domain: domain.authority(),
        addresses,
        level,
        message,
    }
}

async fn check(kind: Kind, domain: &Domain, cloudflare: &[Cidr]) -> DnsCheck {
    match resolve(&domain.host).await {
        Ok(addrs) => judge(kind, domain, &addrs, cloudflare),
        Err(e) => DnsCheck {
            domain: domain.authority(),
            addresses: Vec::new(),
            level: "warn",
            message: format!(
                "{}：{e}。如果刚添加 DNS 记录，可能还没生效；保存不受影响。",
                domain.display()
            ),
        },
    }
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct DomainView {
    /// Stored value (None = not set in the settings).
    pub value: Option<String>,
    /// Stored value as people read it (IDN in Unicode).
    pub display: Option<String>,
    /// Effective origin ("https://host[:port]"), None = browser origin.
    pub effective: Option<String>,
    pub source: Source,
    /// The panel.toml value (for comparison).
    pub config: Option<String>,
}

#[derive(Serialize)]
pub struct NodeDomainView {
    pub value: Option<String>,
    pub display: Option<String>,
    pub panel_addr: String,
    pub server_name: String,
    pub source: Source,
    pub config_addr: String,
    pub config_server_name: String,
}

#[derive(Serialize)]
pub struct TrustView {
    pub value: Option<bool>,
    pub effective: bool,
    pub source: Source,
    pub config: bool,
}

#[derive(Serialize)]
pub struct ServerNameView {
    pub name: String,
    pub display: String,
    pub source: String,
    pub first_used_at: DateTime<Utc>,
    /// The current node communication server name.
    pub current: bool,
    /// Why it cannot be removed (None = removable with confirmation).
    pub locked: Option<&'static str>,
    pub nodes: Vec<AffectedNode>,
}

#[derive(Serialize)]
pub struct SettingsView {
    pub version: i64,
    pub updated_at: Option<DateTime<Utc>>,
    pub main: DomainView,
    pub sub: DomainView,
    pub node: NodeDomainView,
    pub trust_cloudflare: TrustView,
    pub server_names: Vec<ServerNameView>,
    /// Enrolled before server names were recorded (they most likely use
    /// panel.toml's grpc.server_name).
    pub legacy_nodes: Vec<AffectedNode>,
    /// Names the gRPC certificate served by THIS instance covers.
    pub certificate_names: Vec<String>,
    /// Certificate changes apply without a restart.
    pub hot_reload: bool,
    pub host_gate: bool,
    /// The Caddy ask endpoint is enabled on this instance.
    pub ask_enabled: bool,
    pub cloudflare_ranges: usize,
    /// W12: latency tests (agents' url-test + the panel's TCP test).
    pub probe: ProbeView,
    /// Advisory notes from the last save (DNS checks).
    pub warnings: Vec<String>,
}

/// One editable latency-test value: stored (null = panel.toml), effective,
/// panel.toml's, and where the effective one comes from.
#[derive(Serialize)]
pub struct ProbeField<T> {
    pub value: Option<T>,
    pub effective: T,
    pub config: T,
    pub source: Source,
}

#[derive(Serialize)]
pub struct ProbeView {
    pub interval_secs: ProbeField<u64>,
    pub urls: ProbeField<Vec<String>>,
    pub panel_tcp: ProbeField<bool>,
    /// panel.toml only (not editable here).
    pub timeout_ms: u32,
    pub attempts: u32,
    pub manual_cooldown_secs: u64,
}

fn probe_view(cfg: &PanelConfig, eff: &Effective) -> ProbeView {
    let s = &eff.stored;
    let (p, src, c) = (&eff.probe, &eff.probe_sources, &cfg.probe);
    ProbeView {
        interval_secs: ProbeField {
            value: s.probe_interval_secs.and_then(|v| u64::try_from(v).ok()),
            effective: p.interval_secs,
            config: c.interval_secs,
            source: src.interval_secs,
        },
        urls: ProbeField {
            value: s.probe_urls.clone(),
            effective: p.urls.clone(),
            config: c.urls.clone(),
            source: src.urls,
        },
        panel_tcp: ProbeField {
            value: s.probe_panel_tcp,
            effective: p.panel_tcp,
            config: c.panel_tcp,
            source: src.panel_tcp,
        },
        timeout_ms: p.timeout_ms,
        attempts: p.attempts,
        manual_cooldown_secs: p.manual_cooldown_secs,
    }
}

fn display_of(v: &Option<String>) -> Option<String> {
    v.as_deref().map(|s| {
        Domain::parse(s)
            .map(|d| d.display())
            .unwrap_or_else(|_| s.to_string())
    })
}

pub async fn view(state: &AppState, mut warnings: Vec<String>) -> Result<SettingsView, ApiError> {
    let cfg = state.cfg();
    let mut conn = state.pg().acquire().await?;
    let (stored, names) = load(&mut conn).await?;
    let live = state.settings();
    let eff = compute(cfg, stored, names, live.cloudflare());
    warnings.extend(eff.standing_warnings(cfg));
    let mut server_names = Vec::new();
    for n in &eff.server_names {
        server_names.push(ServerNameView {
            display: idna::domain_to_unicode(&n.name).0,
            name: n.name.clone(),
            source: n.source.clone(),
            first_used_at: n.first_used_at,
            current: eff.node.server_name.eq_ignore_ascii_case(&n.name),
            locked: removal_blocker(cfg, &eff.node, &n.name),
            nodes: nodes_using(&mut conn, &n.name).await?,
        });
    }
    let legacy = legacy_nodes(&mut conn).await?;
    let probe = probe_view(cfg, &eff);
    let s = &eff.stored;
    Ok(SettingsView {
        version: s.version,
        updated_at: s.updated_at,
        main: DomainView {
            value: s.main_domain.clone(),
            display: display_of(&s.main_domain),
            effective: eff.main.as_ref().map(Origin::as_string),
            source: eff.main_source,
            config: Some(cfg.install.public_url.clone()).filter(|u| !u.is_empty()),
        },
        sub: DomainView {
            value: s.sub_domain.clone(),
            display: display_of(&s.sub_domain),
            effective: eff.sub.as_ref().map(Origin::as_string),
            source: eff.sub_source,
            config: Some(cfg.web.sub_domain.clone()).filter(|u| !u.is_empty()),
        },
        node: NodeDomainView {
            value: s.node_domain.clone(),
            display: display_of(&s.node_domain),
            panel_addr: eff.node.panel_addr.clone(),
            server_name: eff.node.server_name.clone(),
            source: eff.node_source,
            config_addr: cfg.grpc.advertise.clone(),
            config_server_name: cfg.grpc.server_name.clone(),
        },
        trust_cloudflare: TrustView {
            value: s.trust_cloudflare,
            effective: eff.trust_cloudflare,
            source: eff.trust_source,
            config: cfg.web.trust_cloudflare,
        },
        server_names,
        legacy_nodes: legacy,
        certificate_names: live.certs().names(),
        hot_reload: true,
        host_gate: eff.host_gate_on(),
        ask_enabled: cfg.tls_ask.bind.is_some(),
        cloudflare_ranges: live.cloudflare().len(),
        probe,
        warnings,
    })
}

/// GET /api/v1/settings (admin).
pub async fn get_settings(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<SettingsView>, ApiError> {
    user.require_admin()?;
    Ok(Json(view(&state, Vec::new()).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateReq {
    /// The version the form was loaded at (409 if someone saved since).
    pub version: i64,
    /// PUT replaces all four: null or "" = not set (panel.toml applies).
    pub main_domain: Option<String>,
    pub sub_domain: Option<String>,
    pub node_domain: Option<String>,
    pub trust_cloudflare: Option<bool>,
    /// Save a node domain that resolves to Cloudflare anyway.
    #[serde(default)]
    pub force_node_cloudflare: bool,
    /// Save a main domain although the current address will be refused.
    #[serde(default)]
    pub confirm_host_change: bool,
}

fn norm(field: &str, v: &Option<String>) -> Result<Option<Domain>, ApiError> {
    match v.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) => Domain::parse(s)
            .map(Some)
            .map_err(|e| ApiError::bad_request(format!("{field}：{e}"))),
    }
}

/// PUT /api/v1/settings (admin).
pub async fn put_settings(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    uri: axum::http::Uri,
    ApiJson(req): ApiJson<UpdateReq>,
) -> Result<Json<SettingsView>, ApiError> {
    user.require_admin()?;
    let main = norm("主域名", &req.main_domain)?;
    let sub = norm("订阅域名", &req.sub_domain)?;
    let node = norm("节点通信域名", &req.node_domain)?;
    if let Some(d) = &node {
        if d.host.parse::<IpAddr>().is_ok_and(|ip| ip.is_unspecified()) {
            return Err(ApiError::bad_request("节点通信域名：不能是 0.0.0.0 / ::"));
        }
    }
    let new = Values {
        main_domain: main.as_ref().map(Domain::authority),
        sub_domain: sub.as_ref().map(Domain::authority),
        node_domain: node.as_ref().map(Domain::authority),
        trust_cloudflare: req.trust_cloudflare,
    };
    let live = state.settings();
    let current = live.get();
    let mut warnings = Vec::new();
    // DNS (network I/O) before the transaction, only for changed values.
    if let Some(d) = &node {
        if current.stored.node_domain.as_deref() != Some(d.authority().as_str()) {
            let c = check(Kind::Node, d, live.cloudflare()).await;
            match c.level {
                "block" if !req.force_node_cloudflare => {
                    return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, c.message));
                }
                "ok" => {}
                _ => warnings.push(c.message),
            }
        }
    }
    if let Some(d) = &sub {
        if current.stored.sub_domain.as_deref() != Some(d.authority().as_str()) {
            let c = check(Kind::Sub, d, live.cloudflare()).await;
            if c.level != "ok" {
                warnings.push(c.message);
            }
        }
    }
    // Host gate: would the address this admin uses right now be refused?
    if main.is_some() && !req.confirm_host_change {
        let stored = Stored {
            main_domain: new.main_domain.clone(),
            sub_domain: new.sub_domain.clone(),
            ..Stored::default()
        };
        let next = compute(state.cfg(), stored, Vec::new(), &[]);
        let host = host_of(&headers, &uri);
        if !next.host_allowed(host.as_deref()) {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!(
                    "保存后面板只接受主域名/订阅域名（以及 IP 地址）的访问，当前访问地址 {} 将被拒绝。\
                     请确认主域名已解析并能打开，再勾选确认后保存。",
                    host.unwrap_or_default()
                ),
            ));
        }
    }
    let mut tx = state.pg().begin().await?;
    apply_update(&mut tx, &Actor::of(&user), req.version, &new).await?;
    tx.commit().await?;
    // The trigger notified every instance (this one included); reload here
    // as well so the response shows the new state. Committed either way: a
    // failure here is retried by the notification path.
    reload_logged(&state).await;
    Ok(Json(view(&state, warnings).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProbeReq {
    /// The version the form was loaded at (409 if someone saved since).
    pub version: i64,
    /// PUT replaces all three: null = not set (panel.toml `[probe]` applies).
    pub interval_secs: Option<u64>,
    /// 1..=4 http(s) URLs, primary first; null or [] = panel.toml.
    pub urls: Option<Vec<String>>,
    pub panel_tcp: Option<bool>,
}

/// Validate a latency-test form (pure; Chinese messages for the console).
pub fn probe_values(req: &ProbeReq) -> Result<ProbeValues, ApiError> {
    let interval_secs = match req.interval_secs {
        None => None,
        Some(v) if PROBE_INTERVAL_SECS.contains(&v) => Some(v as i32),
        Some(_) => {
            return Err(ApiError::bad_request(
                "测速间隔：须在 600 秒（10 分钟）到 604800 秒（7 天）之间",
            ))
        }
    };
    let urls = match req.urls.as_deref() {
        None | Some([]) => None,
        Some(list) => {
            let list: Vec<String> = list.iter().map(|u| u.trim().to_string()).collect();
            if list.len() > PROBE_MAX_URLS {
                return Err(ApiError::bad_request("测速地址：最多 4 个"));
            }
            if let Some(bad) = list.iter().find(|u| !crate::nodestat::valid_probe_url(u)) {
                return Err(ApiError::bad_request(format!(
                    "测速地址：{bad:?} 不是有效的 http(s) 地址（不能含空白或用户名）"
                )));
            }
            if !valid_probe_urls(&list) {
                return Err(ApiError::bad_request("测速地址：不能重复"));
            }
            Some(list)
        }
    };
    Ok(ProbeValues {
        interval_secs,
        urls,
        panel_tcp: req.panel_tcp,
    })
}

/// PUT /api/v1/settings/probe (admin): latency-test settings.
pub async fn put_probe(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<ProbeReq>,
) -> Result<Json<SettingsView>, ApiError> {
    user.require_admin()?;
    let new = probe_values(&req)?;
    let mut tx = state.pg().begin().await?;
    apply_update_probe(&mut tx, &Actor::of(&user), state.cfg(), req.version, &new).await?;
    tx.commit().await?;
    reload_logged(&state).await;
    Ok(Json(view(&state, Vec::new()).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DnsReq {
    pub kind: Kind,
    pub domain: String,
}

/// POST /api/v1/settings/dns-check (admin): resolve from the panel.
pub async fn dns_check(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<DnsReq>,
) -> Result<Json<DnsCheck>, ApiError> {
    user.require_admin()?;
    let d = Domain::parse(&req.domain).map_err(ApiError::bad_request)?;
    Ok(Json(
        check(req.kind, &d, state.settings().cloudflare()).await,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoveReq {
    pub name: String,
    /// Must be true: the admin saw the affected nodes.
    pub confirm: bool,
}

/// POST /api/v1/settings/server-names/remove (admin).
pub async fn remove_server_name(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<RemoveReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    if !req.confirm {
        return Err(ApiError::bad_request("需要确认（confirm: true）"));
    }
    let mut tx = state.pg().begin().await?;
    let affected =
        apply_remove_server_name(&mut tx, &Actor::of(&user), state.cfg(), &req.name).await?;
    tx.commit().await?;
    reload_logged(&state).await;
    Ok(Json(
        json!({ "removed": req.name, "affected_nodes": affected }),
    ))
}

// ---------------------------------------------------------------------------
// Caddy on-demand TLS ask endpoint (own listener)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AskQuery {
    domain: Option<String>,
}

async fn ask(State(state): State<AppState>, Query(q): Query<AskQuery>) -> Response {
    if !state
        .settings()
        .ask_permit(state.cfg().tls_ask.rate_per_sec.max(1))
    {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    match q.domain {
        Some(d) if d.len() <= 253 && state.settings().get().ask_allowed(&d) => {
            StatusCode::OK.into_response()
        }
        _ => crate::reject::not_found(),
    }
}

pub fn ask_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/ask", axum::routing::get(ask))
        .fallback(|| async { crate::reject::not_found() })
        .with_state(state)
}

/// Bind and serve the ask endpoint (bound before returning, so a bad
/// address stops the start with a message).
pub async fn serve_ask(
    state: AppState,
    bind: std::net::SocketAddr,
) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, "caddy ask endpoint listening");
    Ok(tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, ask_router(state)).await {
            tracing::error!(error = %e, "ask endpoint stopped");
        }
    }))
}

// ---------------------------------------------------------------------------
// CLI: `akari settings show|unset`
// ---------------------------------------------------------------------------

pub async fn cli_show(cfg: &PanelConfig, pg: &sqlx::PgPool) -> anyhow::Result<()> {
    let mut conn = pg.acquire().await?;
    let (stored, names) = load(&mut conn).await?;
    let eff = compute(cfg, stored.clone(), names, &crate::cloudflare::ranges(cfg));
    let show = |v: &Option<String>| v.clone().unwrap_or_else(|| "(not set)".into());
    println!("settings version: {}", stored.version);
    println!(
        "main domain:      {}  -> {} [{:?}]",
        show(&stored.main_domain),
        eff.main
            .as_ref()
            .map(Origin::as_string)
            .unwrap_or_else(|| "(browser origin)".into()),
        eff.main_source
    );
    println!(
        "sub domain:       {}  -> {} [{:?}]",
        show(&stored.sub_domain),
        eff.sub
            .as_ref()
            .map(Origin::as_string)
            .unwrap_or_else(|| "(browser origin)".into()),
        eff.sub_source
    );
    println!(
        "node domain:      {}  -> {} / {} [{:?}]",
        show(&stored.node_domain),
        eff.node.panel_addr,
        eff.node.server_name,
        eff.node_source
    );
    println!(
        "trust cloudflare: {}  -> {} [{:?}]",
        stored
            .trust_cloudflare
            .map(|b| b.to_string())
            .unwrap_or_else(|| "(not set)".into()),
        eff.trust_cloudflare,
        eff.trust_source
    );
    println!(
        "probe interval:   {}  -> {}s [{:?}]",
        stored
            .probe_interval_secs
            .map(|v| format!("{v}s"))
            .unwrap_or_else(|| "(not set)".into()),
        eff.probe.interval_secs,
        eff.probe_sources.interval_secs
    );
    println!(
        "probe urls:       {}  -> {} [{:?}]",
        stored
            .probe_urls
            .as_ref()
            .map(|u| u.join(" "))
            .unwrap_or_else(|| "(not set)".into()),
        eff.probe.urls.join(" "),
        eff.probe_sources.urls
    );
    println!(
        "probe panel tcp:  {}  -> {} [{:?}]",
        stored
            .probe_panel_tcp
            .map(|b| b.to_string())
            .unwrap_or_else(|| "(not set)".into()),
        eff.probe.panel_tcp,
        eff.probe_sources.panel_tcp
    );
    println!("host gate:        {}", eff.host_gate_on());
    println!("gRPC certificate names: {}", eff.sans.join(", "));
    for w in eff.standing_warnings(cfg) {
        println!("warning: {w}");
    }
    Ok(())
}

/// `akari config check`: the database side of the settings, when the
/// database is reachable (short timeout; never an error — the check is
/// about panel.toml). Lines are TOML comments.
pub async fn describe_db(cfg: &PanelConfig) -> String {
    let attempt = async {
        let pg = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(3))
            .connect(&cfg.database_url)
            .await?;
        let mut conn = pg.acquire().await?;
        let stored: Stored = sqlx::query_as(SELECT_STORED).fetch_one(&mut *conn).await?;
        Ok::<_, sqlx::Error>(stored)
    };
    match tokio::time::timeout(Duration::from_secs(5), attempt).await {
        Ok(Ok(s)) => {
            let e = compute(cfg, s.clone(), Vec::new(), &[]);
            let show = |v: &Option<String>| v.clone().unwrap_or_else(|| "(not set)".into());
            format!(
                "\n# --- 系统设置 in the database (they WIN over the values above) ---\n\
                 # main_domain      = {}  -> {} [{:?}]\n\
                 # sub_domain       = {}  -> {} [{:?}]\n\
                 # node_domain      = {}  -> {} / {} [{:?}]\n\
                 # trust_cloudflare = {}  -> {} [{:?}]\n\
                 # probe.interval_secs = {}  -> {} [{:?}]\n\
                 # probe.urls          = {}  -> {} [{:?}]\n\
                 # probe.panel_tcp     = {}  -> {} [{:?}]\n",
                show(&s.main_domain),
                e.main.as_ref().map(Origin::as_string).unwrap_or_else(|| "(browser origin)".into()),
                e.main_source,
                show(&s.sub_domain),
                e.sub.as_ref().map(Origin::as_string).unwrap_or_else(|| "(browser origin)".into()),
                e.sub_source,
                show(&s.node_domain),
                e.node.panel_addr,
                e.node.server_name,
                e.node_source,
                s.trust_cloudflare.map(|b| b.to_string()).unwrap_or_else(|| "(not set)".into()),
                e.trust_cloudflare,
                e.trust_source,
                s.probe_interval_secs.map(|v| v.to_string()).unwrap_or_else(|| "(not set)".into()),
                e.probe.interval_secs,
                e.probe_sources.interval_secs,
                s.probe_urls.as_ref().map(|u| u.join(" ")).unwrap_or_else(|| "(not set)".into()),
                e.probe.urls.join(" "),
                e.probe_sources.urls,
                s.probe_panel_tcp.map(|b| b.to_string()).unwrap_or_else(|| "(not set)".into()),
                e.probe.panel_tcp,
                e.probe_sources.panel_tcp,
            ) + &e
                .standing_warnings(cfg)
                .iter()
                .map(|w| format!("# WARNING: {w}\n"))
                .collect::<String>()
        }
        Ok(Err(e)) => format!(
            "\n# 系统设置: database not readable ({e}); database values, once set, win over the values above\n"
        ),
        Err(_) => "\n# 系统设置: database not reachable; database values, once set, win over the values above\n".into(),
    }
}

/// `akari settings unset <field>`: back to panel.toml (audited, actor cli).
pub async fn cli_unset(cfg: &PanelConfig, pg: &sqlx::PgPool, field: &str) -> anyhow::Result<()> {
    let mut tx = pg.begin().await?;
    let cur: Stored = sqlx::query_as(SELECT_STORED).fetch_one(&mut *tx).await?;
    if field == "probe" || field == "all" {
        // W12: the latency-test values (own audit action).
        apply_update_probe(
            &mut tx,
            &Actor::cli(),
            cfg,
            cur.version,
            &ProbeValues::default(),
        )
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message()))?;
        if field == "probe" {
            tx.commit().await?;
            println!("probe: unset (panel.toml applies); running panels pick it up at once");
            return Ok(());
        }
    }
    let cur: Stored = sqlx::query_as(SELECT_STORED).fetch_one(&mut *tx).await?;
    let mut new = Values::of(&cur);
    match field {
        "main" => new.main_domain = None,
        "sub" => new.sub_domain = None,
        "node" => new.node_domain = None,
        "trust-cloudflare" => new.trust_cloudflare = None,
        "all" => new = Values::default(),
        _ => anyhow::bail!("field must be main, sub, node, trust-cloudflare, probe or all"),
    }
    apply_update(&mut tx, &Actor::cli(), cur.version, &new)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message()))?;
    tx.commit().await?;
    println!("{field}: unset (panel.toml applies); running panels pick it up at once");
    Ok(())
}

#[cfg(test)]
mod tests;
