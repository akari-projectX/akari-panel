//! System settings (R22, admin "系统设置"): the three domains, "trust
//! Cloudflare" and (W25/R39) everything else an operator changes: latency
//! tests, Cloudflare ranges, install-command pin and download fallback,
//! ACME, retention, remove mode, extra release keys.
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
//!   (fixed per token in `node_enrollments.panel_addr/server_name`). Unset
//!   = no token can be issued (`settings.node_domain_unset`). The gRPC
//!   server certificate covers every name in `grpc_server_names` (plus
//!   `BOOT_NAMES`): saving a node domain adds it, issuing any
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
//! W25 (R39): the database is the ONLY source. NULL = the built-in default
//! (`Effective`), never a panel.toml value. Keys of older panel.toml files
//! are imported once (`import_legacy`, actor `system`, audited
//! `settings.import`) and then ignored with a warning.
//! `akari settings show|set|unset` reads/changes the row from the CLI (e.g.
//! after a mistyped main domain, or to set the node domain before the first
//! login).
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

use crate::auth::{bad_request, conflict};
use std::collections::{BTreeSet, HashSet};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::client_ip::{Cidr, Trust};
use crate::config::{PanelConfig, ProbeConfig, RemoveMode};
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
    /// W12: latency tests (NULL = built-in default).
    pub probe_interval_secs: Option<i32>,
    pub probe_urls: Option<Vec<String>>,
    pub probe_panel_tcp: Option<bool>,
    /// W21: 站点名称 (browser titles, mail headers; NULL = "Akari").
    pub site_name: Option<String>,
    /// W25: Cloudflare edge ranges (NULL = the shipped list).
    pub cloudflare_ranges: Option<Vec<String>>,
    /// W25: install command pin (NULL = probed) and agent download
    /// fallback (NULL = the official release; "" = none).
    pub install_tls_pin: Option<String>,
    pub install_fallback_url: Option<String>,
    /// W25: ACME directory (NULL = Let's Encrypt) and contact e-mail.
    pub acme_directory_url: Option<String>,
    pub acme_email: Option<String>,
    /// W25: retention (NULL = 365 / 400 days).
    pub audit_retention_days: Option<i32>,
    pub traffic_daily_retention_days: Option<i32>,
    /// W25: "gate" | "rebuild" (NULL = gate).
    pub remove_mode: Option<String>,
    /// W25: release keys trusted besides the official ones.
    pub extra_release_keys: Option<Vec<String>>,
    #[serde(skip)]
    pub updated_at: Option<DateTime<Utc>>,
}

const STORED_COLS: &str = "version, main_domain, sub_domain, node_domain, trust_cloudflare, \
     probe_interval_secs, probe_urls, probe_panel_tcp, site_name, cloudflare_ranges, \
     install_tls_pin, install_fallback_url, acme_directory_url, acme_email, \
     audit_retention_days, traffic_daily_retention_days, remove_mode, \
     extra_release_keys, updated_at";

fn select_stored(lock: bool) -> sqlx::AssertSqlSafe<String> {
    sqlx::AssertSqlSafe(format!(
        "SELECT {STORED_COLS} FROM panel_settings WHERE id = 1{}",
        if lock { " FOR UPDATE" } else { "" }
    ))
}

async fn read_stored(conn: &mut PgConnection, lock: bool) -> sqlx::Result<Stored> {
    sqlx::query_as(select_stored(lock)).fetch_one(conn).await
}

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
    /// Not set: the built-in default.
    Default,
    /// The subscription domain follows the main domain.
    Main,
    /// Nothing configured: the admin's browser origin is used.
    Browser,
    /// Not set and no default: the feature is unavailable (node domain:
    /// no enrollment token can be issued).
    Unset,
}

/// What a bootstrap file / install script tells an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NodeEndpoint {
    /// host:port the agent dials.
    pub panel_addr: String,
    /// TLS server name the agent verifies.
    pub server_name: String,
}

/// Names the gRPC server certificate always covers (the boot certificate
/// before the database is read; loopback agents in development).
pub const BOOT_NAMES: &[&str] = &["127.0.0.1", "localhost"];

/// W25: built-in defaults of the database settings.
pub const DEFAULT_AUDIT_RETENTION_DAYS: u32 = 365;

#[derive(Debug, Clone)]
pub struct Effective {
    pub stored: Stored,
    pub server_names: Vec<ServerName>,
    pub main: Option<Origin>,
    pub main_source: Source,
    pub sub: Option<Origin>,
    pub sub_source: Source,
    /// None = no node domain set: tokens cannot be issued.
    pub node: Option<NodeEndpoint>,
    pub node_source: Source,
    pub trust_cloudflare: bool,
    pub trust_source: Source,
    pub trust: Trust,
    /// The Cloudflare edge ranges (stored override, else shipped).
    pub cloudflare: Vec<Cidr>,
    pub cloudflare_source: Source,
    /// W12: the effective latency-test settings (stored interval / URLs /
    /// panel TCP switch over the built-in defaults) and where each comes
    /// from.
    pub probe: ProbeConfig,
    pub probe_sources: ProbeSources,
    /// W25: install command pin (None = probe when issuing).
    pub install_tls_pin: Option<String>,
    /// W25: agent download fallback (None = none).
    pub install_fallback_url: Option<String>,
    /// W25: ACME directory ("" = Let's Encrypt) and contact e-mail.
    pub acme_directory_url: String,
    pub acme_email: String,
    /// W25: days (0 = forever).
    pub audit_retention_days: u32,
    pub traffic_daily_retention_days: u32,
    pub remove_mode: RemoveMode,
    /// W25: every trusted release key: the official ones compiled in, then
    /// the extra ones from the settings.
    pub release_keys: Vec<crate::updates::ReleaseKey>,
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

/// Bounds of the editable latency-test values.
pub const PROBE_INTERVAL_SECS: std::ops::RangeInclusive<u64> = 600..=604_800;
pub const PROBE_MAX_URLS: usize = 4;

/// Pure: the built-in latency-test settings with the stored values
/// applied. A stored value outside the bounds (impossible through the API
/// and the 0091 CHECKs) is ignored with an error log.
fn effective_probe(cfg: &PanelConfig, stored: &Stored) -> (ProbeConfig, ProbeSources) {
    let l = &cfg.limits;
    let mut p = ProbeConfig {
        timeout_ms: l.probe_timeout_ms,
        attempts: l.probe_attempts,
        manual_cooldown_secs: l.probe_manual_cooldown_secs,
        ..ProbeConfig::default()
    };
    let mut src = ProbeSources {
        interval_secs: Source::Default,
        urls: Source::Default,
        panel_tcp: Source::Default,
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

/// Pure: the Cloudflare ranges (stored override, else shipped).
fn effective_cloudflare(stored: &Stored) -> (Vec<Cidr>, Source) {
    if let Some(list) = &stored.cloudflare_ranges {
        match list
            .iter()
            .map(|c| Cidr::parse(c))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(v) if !v.is_empty() => return (v, Source::Settings),
            _ => tracing::error!("stored Cloudflare ranges invalid; the shipped list applies"),
        }
    }
    (crate::cloudflare::shipped_or_empty(), Source::Default)
}

/// Pure: the official release keys plus the stored extra ones (a stored
/// list that does not parse is ignored with an error log).
fn effective_release_keys(stored: &Stored) -> Vec<crate::updates::ReleaseKey> {
    let mut keys = crate::updates::official_release_keys();
    if let Some(extra) = &stored.extra_release_keys {
        match crate::updates::parse_release_keys(extra) {
            Ok(v) => {
                for k in v {
                    if !keys.iter().any(|o| o.id == k.id) {
                        keys.push(k);
                    }
                }
            }
            Err(e) => tracing::error!(error = %e, "stored extra release keys invalid; ignored"),
        }
    }
    keys
}

/// Pure: the effective settings from the stored row and the name history
/// (`cfg` only supplies the listeners, trusted proxies and constants). A
/// stored value that no longer parses (cannot happen through the API) is
/// ignored with an error log, as if unset.
pub fn compute(cfg: &PanelConfig, stored: Stored, server_names: Vec<ServerName>) -> Effective {
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
    let (main, main_source) = match parsed("main_domain", &stored.main_domain) {
        Some(d) => (Some(d.https_origin()), Source::Settings),
        None => (None, Source::Browser),
    };
    let (sub, sub_source) = match parsed("sub_domain", &stored.sub_domain) {
        Some(d) => (Some(d.https_origin()), Source::Settings),
        None => (
            main.clone(),
            if main.is_some() {
                Source::Main
            } else {
                Source::Browser
            },
        ),
    };
    let (node, node_source) = match parsed("node_domain", &stored.node_domain) {
        Some(d) => (
            Some(NodeEndpoint {
                panel_addr: Domain {
                    host: d.host.clone(),
                    port: Some(d.port.unwrap_or(cfg.grpc.bind.port())),
                }
                .authority(),
                server_name: d.host,
            }),
            Source::Settings,
        ),
        None => (None, Source::Unset),
    };
    let (trust_cloudflare, trust_source) = match stored.trust_cloudflare {
        Some(v) => (v, Source::Settings),
        None => (false, Source::Default),
    };
    let (cloudflare, cloudflare_source) = effective_cloudflare(&stored);
    let trust = Trust {
        proxies: cfg.web.trusted_proxies.clone(),
        cloudflare: if trust_cloudflare {
            cloudflare.clone()
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
    let host_gate = (main_source == Source::Settings).then(|| ask_hosts.clone());
    let sans = sans(
        &server_names,
        node.as_ref().map(|n| n.server_name.as_str()).unwrap_or(""),
    );
    let (probe, probe_sources) = effective_probe(cfg, &stored);
    let days =
        |v: Option<i32>, default: u32| v.and_then(|v| u32::try_from(v).ok()).unwrap_or(default);
    let fallback = match stored.install_fallback_url.as_deref() {
        None => Some(crate::config::DEFAULT_FALLBACK_BINARY_URL.to_string()),
        Some("") => None,
        Some(u) => Some(u.to_string()),
    };
    Effective {
        probe,
        probe_sources,
        install_tls_pin: stored.install_tls_pin.clone(),
        install_fallback_url: fallback,
        acme_directory_url: stored.acme_directory_url.clone().unwrap_or_default(),
        acme_email: stored.acme_email.clone().unwrap_or_default(),
        audit_retention_days: days(stored.audit_retention_days, DEFAULT_AUDIT_RETENTION_DAYS),
        traffic_daily_retention_days: days(
            stored.traffic_daily_retention_days,
            crate::traffic::DEFAULT_DAILY_RETENTION_DAYS,
        ),
        remove_mode: stored
            .remove_mode
            .as_deref()
            .and_then(RemoveMode::parse)
            .unwrap_or_default(),
        release_keys: effective_release_keys(&stored),
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
        cloudflare,
        cloudflare_source,
        host_gate,
        ask_hosts,
        sans,
    }
}

/// The gRPC server certificate's names: `BOOT_NAMES`, every recorded
/// server name, and the current node server name. Grows with the history;
/// nothing here can drop a recorded name.
pub fn sans(history: &[ServerName], node_server_name: &str) -> Vec<String> {
    let mut set: BTreeSet<String> = BOOT_NAMES.iter().map(|n| n.to_string()).collect();
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
    /// `payments_enabled`: 系统设置 → 支付 is on (W24, database).
    pub fn standing_warnings(&self, payments_enabled: bool) -> Vec<String> {
        let mut w = Vec::new();
        if payments_enabled && self.main.is_none() {
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
    /// Ask endpoint CPU guard: (window start, answered in window).
    ask_window: Mutex<(Instant, u32)>,
}

impl Live {
    /// Built-in defaults only (the database is read by `init`). Serves the
    /// boot certificate of `install` (`BOOT_NAMES`) until then.
    pub fn new(cfg: &PanelConfig, install: &Install) -> Self {
        let eff = compute(cfg, Stored::default(), Vec::new());
        let certs = Arc::new(CertResolver::default());
        if !install.server_cert_pem.is_empty() {
            let names: Vec<String> = sans(&[], "");
            if let Err(e) = certs.set(&install.server_cert_pem, &install.server_key_pem, names) {
                tracing::error!(error = %e, "boot server certificate unusable");
            }
        }
        Self {
            current: ArcSwap::from_pointee(eff),
            certs,
            reload_lock: tokio::sync::Mutex::new(()),
            ask_window: Mutex::new((Instant::now(), 0)),
        }
    }

    pub fn get(&self) -> Arc<Effective> {
        self.current.load_full()
    }

    pub fn certs(&self) -> &Arc<CertResolver> {
        &self.certs
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
    let stored = read_stored(&mut *conn, false).await?;
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
    let eff = compute(state.cfg(), stored, names);
    let inst = state.install();
    if eff.sans != live.certs.names() && !inst.ca_pem.is_empty() {
        let (cert, key) =
            crate::install::issue_server_cert(&inst.ca_pem, &inst.ca_key_pem, &eff.sans)?;
        live.certs.set(&cert, &key, eff.sans.clone())?;
        tracing::info!(names = ?eff.sans, "gRPC server certificate re-issued");
    }
    let prev = live.get();
    let probe_changed = probe_wire(&prev.probe) != probe_wire(&eff.probe);
    // LeaseGrant carries the remove mode and Snapshots the ACME settings:
    // sessions re-read and re-send when these change.
    let agents_changed = probe_changed
        || prev.remove_mode != eff.remove_mode
        || prev.acme_directory_url != eff.acme_directory_url
        || prev.acme_email != eff.acme_email;
    live.current.store(Arc::new(eff));
    // W24: 系统设置 → 支付 shares the notification and this serialization.
    crate::billing::methods::reload(state).await?;
    if agents_changed {
        // Every local session re-reads (jittered wake-all; settings changes
        // are rare admin actions): it re-sends LatencyProbeConfig when it
        // differs from what it sent, grants the lease with the current
        // remove mode.
        tracing::info!("agent-facing settings changed; waking agent sessions");
        state.wakeups().wake_all();
    }
    Ok(())
}

/// The latency-test values agents receive (what a change must re-send).
fn probe_wire(p: &ProbeConfig) -> (u64, &[String], u32, u32) {
    (p.interval_secs, &p.urls, p.timeout_ms, p.attempts)
}

/// Startup: load the settings (obsolete panel.toml keys were imported by
/// `import_legacy` before).
pub async fn init(state: &AppState) -> anyhow::Result<()> {
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
/// from the database, not this instance's cache). Unset node domain = a
/// coded 400 (`settings.node_domain_unset`): no token without an address.
pub async fn node_endpoint(
    conn: &mut PgConnection,
    cfg: &PanelConfig,
) -> Result<NodeEndpoint, ApiError> {
    let stored = read_stored(conn, false).await?;
    compute(cfg, stored, Vec::new()).node.ok_or_else(|| {
        bad_request!(
            "settings.node_domain_unset",
            "节点通信域名未设置：请先在 系统设置 → 节点通信 中填写节点连接面板所用的域名或 IP（agent 用它连接 gRPC 端口）"
        )
    })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/// New values (already validated/normalized; None = unset).
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
    let cur = read_stored(&mut *conn, true).await?;
    if cur.version != expected_version {
        return Err(conflict!(
            "settings.version_conflict",
            "设置已被修改（可能是其他管理员），请刷新后重试"
        ));
    }
    let before = Values::of(&cur);
    if &before == new {
        return Ok(cur);
    }
    let row: Stored = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE panel_settings SET main_domain = $1, sub_domain = $2, node_domain = $3, \
             trust_cloudflare = $4, version = version + 1, updated_at = now() \
         WHERE id = 1 RETURNING {STORED_COLS}"
    )))
    .bind(&new.main_domain)
    .bind(&new.sub_domain)
    .bind(&new.node_domain)
    .bind(new.trust_cloudflare)
    .fetch_one(&mut *conn)
    .await?;
    if new.node_domain != before.node_domain
        && let Some(d) = new
            .node_domain
            .as_deref()
            .and_then(|d| Domain::parse(d).ok())
    {
        record_server_name(conn, &d.host, "settings").await?;
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

/// W12: new latency-test values (validated; None = unset → default).
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
    let cur = read_stored(&mut *conn, true).await?;
    if cur.version != expected_version {
        return Err(conflict!(
            "settings.version_conflict",
            "设置已被修改（可能是其他管理员），请刷新后重试"
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

/// The longest site name (characters).
pub const MAX_SITE_NAME: usize = 64;

/// The default site name.
pub const DEFAULT_SITE_NAME: &str = "Akari";

/// W21: a site name from the form: trimmed; empty = unset (default);
/// 1–64 characters without control characters.
pub fn site_name_value(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(v) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if v.chars().count() > MAX_SITE_NAME || v.chars().any(char::is_control) {
        return Err(bad_request!(
            "settings.site_name_invalid",
            "site name must be 1-{max} characters without control characters",
            max = MAX_SITE_NAME
        ));
    }
    Ok(Some(v.to_string()))
}

/// W21: write the site name (same row and `version` as the domains: 409 on
/// a stale form). Audited as `settings.site.update`.
pub async fn apply_update_site(
    conn: &mut PgConnection,
    actor: &Actor,
    expected_version: i64,
    site_name: Option<String>,
) -> Result<Stored, ApiError> {
    let cur = read_stored(&mut *conn, true).await?;
    if cur.version != expected_version {
        return Err(conflict!(
            "settings.version_conflict",
            "设置已被修改（可能是其他管理员），请刷新后重试"
        ));
    }
    if cur.site_name == site_name {
        return Ok(cur);
    }
    let row: Stored = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE panel_settings SET site_name = $1, version = version + 1, updated_at = now() \
         WHERE id = 1 RETURNING {STORED_COLS}"
    )))
    .bind(&site_name)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.site.update",
        "settings",
        None,
        Some(json!({ "site_name": cur.site_name })),
        Some(json!({ "site_name": site_name })),
    )
    .await?;
    Ok(row)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteReq {
    pub version: i64,
    /// null or "" = the default ("Akari").
    pub site_name: Option<String>,
}

/// PUT /api/v1/settings/site (admin): 站点名称.
pub async fn put_site(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<SiteReq>,
) -> Result<Json<SettingsView>, ApiError> {
    user.require_admin()?;
    let name = site_name_value(req.site_name.as_deref())?;
    let mut tx = state.pg().begin().await?;
    apply_update_site(&mut tx, &Actor::of(&user), req.version, name).await?;
    tx.commit().await?;
    reload_logged(&state).await;
    Ok(Json(view(&state, Vec::new()).await?))
}

// ---------------------------------------------------------------------------
// W25: node-facing settings (节点通信) and security/retention (安全)
// ---------------------------------------------------------------------------

/// 节点通信 extras (validated; None = built-in default).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NodeOpsValues {
    pub install_tls_pin: Option<String>,
    /// Some("") = no download fallback.
    pub install_fallback_url: Option<String>,
    pub acme_directory_url: Option<String>,
    pub acme_email: Option<String>,
    pub remove_mode: Option<String>,
}

impl NodeOpsValues {
    fn of(s: &Stored) -> Self {
        Self {
            install_tls_pin: s.install_tls_pin.clone(),
            install_fallback_url: s.install_fallback_url.clone(),
            acme_directory_url: s.acme_directory_url.clone(),
            acme_email: s.acme_email.clone(),
            remove_mode: s.remove_mode.clone(),
        }
    }
    fn audit(&self) -> serde_json::Value {
        json!({
            "install_tls_pin": self.install_tls_pin,
            "install_fallback_url": self.install_fallback_url,
            "acme_directory_url": self.acme_directory_url,
            "acme_email": self.acme_email,
            "remove_mode": self.remove_mode,
        })
    }
}

/// 安全 (validated; None = built-in default).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SecurityValues {
    pub audit_retention_days: Option<i32>,
    pub traffic_daily_retention_days: Option<i32>,
    pub cloudflare_ranges: Option<Vec<String>>,
    pub extra_release_keys: Option<Vec<String>>,
}

impl SecurityValues {
    fn of(s: &Stored) -> Self {
        Self {
            audit_retention_days: s.audit_retention_days,
            traffic_daily_retention_days: s.traffic_daily_retention_days,
            cloudflare_ranges: s.cloudflare_ranges.clone(),
            extra_release_keys: s.extra_release_keys.clone(),
        }
    }
    fn audit(&self) -> serde_json::Value {
        json!({
            "audit_retention_days": self.audit_retention_days,
            "traffic_daily_retention_days": self.traffic_daily_retention_days,
            "cloudflare_ranges": self.cloudflare_ranges.as_ref().map(Vec::len),
            "extra_release_keys": self.extra_release_keys,
        })
    }
}

fn check_version(cur: &Stored, expected: i64) -> Result<(), ApiError> {
    if cur.version != expected {
        return Err(conflict!(
            "settings.version_conflict",
            "设置已被修改（可能是其他管理员），请刷新后重试"
        ));
    }
    Ok(())
}

/// Write the 节点通信 extras (same row and `version`: 409 on a stale
/// form). Audited as `settings.nodes.update`. Agents follow through the
/// reload (remove mode on the next LeaseGrant, ACME on the next Snapshot).
pub async fn apply_update_node_ops(
    conn: &mut PgConnection,
    actor: &Actor,
    expected_version: i64,
    new: &NodeOpsValues,
) -> Result<Stored, ApiError> {
    let cur = read_stored(&mut *conn, true).await?;
    check_version(&cur, expected_version)?;
    let before = NodeOpsValues::of(&cur);
    if &before == new {
        return Ok(cur);
    }
    let row: Stored = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE panel_settings SET install_tls_pin = $1, install_fallback_url = $2, \
             acme_directory_url = $3, acme_email = $4, remove_mode = $5, \
             version = version + 1, updated_at = now() \
         WHERE id = 1 RETURNING {STORED_COLS}"
    )))
    .bind(&new.install_tls_pin)
    .bind(&new.install_fallback_url)
    .bind(&new.acme_directory_url)
    .bind(&new.acme_email)
    .bind(&new.remove_mode)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.nodes.update",
        "settings",
        None,
        Some(before.audit()),
        Some(new.audit()),
    )
    .await?;
    Ok(row)
}

/// Write the 安全 settings (same row and `version`). Audited as
/// `settings.security.update` (the Cloudflare list as its length).
pub async fn apply_update_security(
    conn: &mut PgConnection,
    actor: &Actor,
    expected_version: i64,
    new: &SecurityValues,
) -> Result<Stored, ApiError> {
    let cur = read_stored(&mut *conn, true).await?;
    check_version(&cur, expected_version)?;
    let before = SecurityValues::of(&cur);
    if &before == new {
        return Ok(cur);
    }
    let row: Stored = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE panel_settings SET audit_retention_days = $1, \
             traffic_daily_retention_days = $2, cloudflare_ranges = $3, \
             extra_release_keys = $4, version = version + 1, updated_at = now() \
         WHERE id = 1 RETURNING {STORED_COLS}"
    )))
    .bind(new.audit_retention_days)
    .bind(new.traffic_daily_retention_days)
    .bind(&new.cloudflare_ranges)
    .bind(&new.extra_release_keys)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.security.update",
        "settings",
        None,
        Some(before.audit()),
        Some(new.audit()),
    )
    .await?;
    Ok(row)
}

/// Blank / missing = None.
fn opt_trim(v: &Option<String>) -> Option<String> {
    v.as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeOpsReq {
    pub version: i64,
    /// null/"" = probe when a command is issued.
    pub install_tls_pin: Option<String>,
    /// null = the official release; "" with `install_fallback_disabled`
    /// would be ambiguous, so "no fallback" is its own switch.
    pub install_fallback_url: Option<String>,
    #[serde(default)]
    pub install_fallback_disabled: bool,
    /// null/"" = Let's Encrypt.
    pub acme_directory_url: Option<String>,
    pub acme_email: Option<String>,
    /// "gate" | "rebuild"; null = gate.
    pub remove_mode: Option<RemoveMode>,
}

/// Validate a 节点通信 form (pure; Chinese messages for the console).
pub fn node_ops_values(req: &NodeOpsReq) -> Result<NodeOpsValues, ApiError> {
    let pin = opt_trim(&req.install_tls_pin);
    if let Some(p) = &pin
        && !crate::nodeinstall::valid_pin(p)
    {
        return Err(bad_request!(
            "settings.tls_pin_invalid",
            "安装命令公钥钉扎：格式应为 sha256//<SPKI 的 SHA-256 的 base64>（留空 = 自动探测）"
        ));
    }
    let fallback = if req.install_fallback_disabled {
        Some(String::new())
    } else {
        let u = opt_trim(&req.install_fallback_url);
        if let Some(u) = &u
            && !crate::nodeinstall::fallback_url_ok(u)
        {
            return Err(bad_request!(
                "settings.fallback_url_invalid",
                "备用下载地址：必须是含 {{arch}} 的 https:// 地址，不能有引号、空格或 shell 特殊字符"
            ));
        }
        u.filter(|u| u != crate::config::DEFAULT_FALLBACK_BINARY_URL)
    };
    let dir = opt_trim(&req.acme_directory_url);
    if let Some(d) = &dir
        && !acme_url_ok(d)
    {
        return Err(bad_request!(
            "settings.acme_url_invalid",
            "ACME 目录：必须是 https:// 地址（留空 = Let's Encrypt）"
        ));
    }
    let email = opt_trim(&req.acme_email);
    if let Some(e) = &email
        && !acme_email_ok(e)
    {
        return Err(bad_request!(
            "settings.acme_email_invalid",
            "ACME 邮箱：不是有效的邮箱地址（可留空）"
        ));
    }
    Ok(NodeOpsValues {
        install_tls_pin: pin,
        install_fallback_url: fallback,
        acme_directory_url: dir,
        acme_email: email,
        remove_mode: req
            .remove_mode
            .filter(|m| *m != RemoveMode::Gate)
            .map(|m| m.as_str().to_string()),
    })
}

/// An https URL with a host (no credentials), at most 2048 bytes.
pub fn acme_url_ok(u: &str) -> bool {
    u.len() <= 2048
        && !u.contains('@')
        && !u.chars().any(|c| c.is_whitespace() || c.is_control())
        && u.parse::<axum::http::Uri>().is_ok_and(|u| {
            u.scheme_str() == Some("https") && u.host().is_some_and(|h| !h.is_empty())
        })
}

pub fn acme_email_ok(e: &str) -> bool {
    e.len() <= 254
        && !e.chars().any(|c| c.is_whitespace() || c.is_control())
        && e.split_once('@')
            .is_some_and(|(l, d)| !l.is_empty() && d.contains('.') && !d.starts_with('.'))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecurityReq {
    pub version: i64,
    /// null = 365; 0 = keep forever.
    pub audit_retention_days: Option<u32>,
    /// null = 400; 0 = keep forever; else 32..=36500.
    pub traffic_daily_retention_days: Option<u32>,
    /// null or [] = the shipped list.
    pub cloudflare_ranges: Option<Vec<String>>,
    /// null or [] = none ("<base64> [label]" each).
    pub extra_release_keys: Option<Vec<String>>,
}

pub const MAX_CLOUDFLARE_RANGES: usize = 256;
pub const MAX_EXTRA_RELEASE_KEYS: usize = 16;

/// Validate a 安全 form (pure).
pub fn security_values(req: &SecurityReq) -> Result<SecurityValues, ApiError> {
    if let Some(d) = req.audit_retention_days
        && d > 36_500
    {
        return Err(bad_request!(
            "settings.audit_retention_invalid",
            "审计日志保留天数：0（永久）到 36500"
        ));
    }
    if let Some(d) = req.traffic_daily_retention_days
        && d != 0
        && !(32..=36_500).contains(&d)
    {
        return Err(bad_request!(
            "settings.traffic_retention_invalid",
            "流量明细保留天数：0（永久）或 32 到 36500"
        ));
    }
    let ranges = match req.cloudflare_ranges.as_deref() {
        None | Some([]) => None,
        Some(list) => {
            if list.len() > MAX_CLOUDFLARE_RANGES {
                return Err(bad_request!(
                    "settings.cloudflare_ranges_too_many",
                    "Cloudflare 网段：最多 {max} 条",
                    max = MAX_CLOUDFLARE_RANGES
                ));
            }
            let mut out = Vec::new();
            for c in list.iter().map(|c| c.trim()).filter(|c| !c.is_empty()) {
                let parsed = Cidr::parse(c).map_err(|_| {
                    bad_request!(
                        "settings.cloudflare_range_invalid",
                        "Cloudflare 网段：{range:?} 不是有效的 CIDR",
                        range = c
                    )
                })?;
                let canon = parsed.to_string();
                if !out.contains(&canon) {
                    out.push(canon);
                }
            }
            Some(out).filter(|v| !v.is_empty())
        }
    };
    let keys = match req.extra_release_keys.as_deref() {
        None | Some([]) => None,
        Some(list) => {
            let list: Vec<String> = list
                .iter()
                .map(|k| k.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|k| !k.is_empty())
                .collect();
            if list.len() > MAX_EXTRA_RELEASE_KEYS {
                return Err(bad_request!(
                    "settings.release_keys_too_many",
                    "额外信任的发布公钥：最多 {max} 个",
                    max = MAX_EXTRA_RELEASE_KEYS
                ));
            }
            if let Err(e) = crate::updates::parse_release_keys(&list) {
                return Err(bad_request!(
                    "settings.release_key_invalid",
                    "额外信任的发布公钥：{detail}（每行一个 \"<base64 公钥> [标签]\"）",
                    detail = e
                ));
            }
            Some(list).filter(|v| !v.is_empty())
        }
    };
    Ok(SecurityValues {
        audit_retention_days: req
            .audit_retention_days
            .filter(|d| *d != DEFAULT_AUDIT_RETENTION_DAYS)
            .map(|d| d as i32),
        traffic_daily_retention_days: req
            .traffic_daily_retention_days
            .filter(|d| *d != crate::traffic::DEFAULT_DAILY_RETENTION_DAYS)
            .map(|d| d as i32),
        cloudflare_ranges: ranges,
        extra_release_keys: keys,
    })
}

/// PUT /api/v1/settings/nodes (admin): 节点通信 extras.
pub async fn put_node_ops(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<NodeOpsReq>,
) -> Result<Json<SettingsView>, ApiError> {
    user.require_admin()?;
    let new = node_ops_values(&req)?;
    let mut tx = state.pg().begin().await?;
    apply_update_node_ops(&mut tx, &Actor::of(&user), req.version, &new).await?;
    tx.commit().await?;
    reload_logged(&state).await;
    Ok(Json(view(&state, Vec::new()).await?))
}

/// PUT /api/v1/settings/security (admin): 安全.
pub async fn put_security(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<SecurityReq>,
) -> Result<Json<SettingsView>, ApiError> {
    user.require_admin()?;
    let new = security_values(&req)?;
    let mut tx = state.pg().begin().await?;
    apply_update_security(&mut tx, &Actor::of(&user), req.version, &new).await?;
    tx.commit().await?;
    reload_logged(&state).await;
    Ok(Json(view(&state, Vec::new()).await?))
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
/// `legacy_nodes`: nodes enrolled before 0060 exist (their server name is
/// unknown: most likely one that came from panel.toml).
fn removal_blocker(
    eff_node: Option<&NodeEndpoint>,
    source: &str,
    name: &str,
    legacy_nodes: bool,
) -> Option<&'static str> {
    if eff_node.is_some_and(|n| n.server_name.eq_ignore_ascii_case(name)) {
        return Some("这是当前的节点通信域名，不能移除");
    }
    if BOOT_NAMES.iter().any(|n| n.eq_ignore_ascii_case(name)) {
        return Some("这是内置的本机名称，证书始终包含它");
    }
    if source == "config" && legacy_nodes {
        return Some(
            "这个名称来自旧版 panel.toml，而仍有在记录服务器名称之前注册的节点（可能在用它）：\
             先为这些节点重新签发注册令牌再移除",
        );
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
    let cur = read_stored(&mut *conn, true).await?;
    let eff = compute(cfg, cur, Vec::new());
    let source: Option<String> =
        sqlx::query_scalar("SELECT source FROM grpc_server_names WHERE name = $1")
            .bind(name)
            .fetch_optional(&mut *conn)
            .await?;
    let legacy = !legacy_nodes(conn).await?.is_empty();
    if let Some(why) = removal_blocker(
        eff.node.as_ref(),
        source.as_deref().unwrap_or(""),
        name,
        legacy,
    ) {
        return Err(bad_request!(
            "settings.server_name_locked",
            "{detail}",
            detail = why
        ));
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
            format!(
                "{} 解析到 {list}，未经过 Cloudflare 代理（灰色云朵），可以用于节点通信。",
                domain.display()
            ),
        ),
        Kind::Sub if all_cf => (
            "ok",
            format!(
                "{} 解析到 Cloudflare（{list}），已经过橙色云朵代理。",
                domain.display()
            ),
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
                if any_cf {
                    "（经过 Cloudflare 代理）"
                } else {
                    ""
                }
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
}

#[derive(Serialize)]
pub struct NodeDomainView {
    pub value: Option<String>,
    pub display: Option<String>,
    /// None = not set: no enrollment token can be issued.
    pub panel_addr: Option<String>,
    pub server_name: Option<String>,
    pub source: Source,
    /// The port a node domain without one gets (grpc.bind).
    pub default_port: u16,
}

#[derive(Serialize)]
pub struct TrustView {
    pub value: Option<bool>,
    pub effective: bool,
    pub source: Source,
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
    /// an old panel.toml grpc.server_name).
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
    /// W25: 节点通信 extras.
    pub node_ops: NodeOpsView,
    /// W25: 安全.
    pub security: SecurityView,
    /// W21: 站点名称 (null = default "Akari").
    pub site_name: Option<String>,
    /// W25: obsolete keys in THIS instance's panel.toml (delete them).
    pub obsolete_config_keys: Vec<String>,
    /// Advisory notes from the last save (DNS checks).
    pub warnings: Vec<String>,
}

/// One editable value: stored (null = not set), effective, the built-in
/// default, and where the effective one comes from.
#[derive(Serialize)]
pub struct Field<T> {
    pub value: Option<T>,
    pub effective: T,
    pub default: T,
    pub source: Source,
}

impl<T: Clone> Field<T> {
    fn of(value: Option<T>, default: T) -> Self {
        Self {
            effective: value.clone().unwrap_or_else(|| default.clone()),
            source: if value.is_some() {
                Source::Settings
            } else {
                Source::Default
            },
            value,
            default,
        }
    }
}

#[derive(Serialize)]
pub struct ProbeView {
    pub interval_secs: Field<u64>,
    pub urls: Field<Vec<String>>,
    pub panel_tcp: Field<bool>,
    /// Built in (not editable).
    pub timeout_ms: u32,
    pub attempts: u32,
    pub manual_cooldown_secs: u64,
}

#[derive(Serialize)]
pub struct NodeOpsView {
    /// null = probed when a command is issued.
    pub install_tls_pin: Option<String>,
    /// Stored value: null = official release, "" = no fallback.
    pub install_fallback_url: Option<String>,
    pub install_fallback_effective: Option<String>,
    pub install_fallback_default: &'static str,
    pub acme_directory_url: Option<String>,
    pub acme_email: Option<String>,
    pub remove_mode: Field<RemoveMode>,
}

#[derive(Serialize)]
pub struct ReleaseKeyView {
    pub id: String,
    pub label: String,
    /// Compiled into this panel (not editable).
    pub official: bool,
}

#[derive(Serialize)]
pub struct SecurityView {
    pub audit_retention_days: Field<u32>,
    pub traffic_daily_retention_days: Field<u32>,
    /// Stored override (null = the shipped list).
    pub cloudflare_ranges: Option<Vec<String>>,
    pub cloudflare_ranges_shipped: usize,
    pub extra_release_keys: Option<Vec<String>>,
    /// Every trusted key (official first).
    pub release_keys: Vec<ReleaseKeyView>,
}

fn probe_view(eff: &Effective) -> ProbeView {
    let s = &eff.stored;
    let p = &eff.probe;
    let d = ProbeConfig::default();
    ProbeView {
        interval_secs: Field::of(
            s.probe_interval_secs.and_then(|v| u64::try_from(v).ok()),
            d.interval_secs,
        ),
        urls: Field::of(s.probe_urls.clone(), d.urls),
        panel_tcp: Field::of(s.probe_panel_tcp, d.panel_tcp),
        timeout_ms: p.timeout_ms,
        attempts: p.attempts,
        manual_cooldown_secs: p.manual_cooldown_secs,
    }
}

fn node_ops_view(eff: &Effective) -> NodeOpsView {
    let s = &eff.stored;
    NodeOpsView {
        install_tls_pin: s.install_tls_pin.clone(),
        install_fallback_url: s.install_fallback_url.clone(),
        install_fallback_effective: eff.install_fallback_url.clone(),
        install_fallback_default: crate::config::DEFAULT_FALLBACK_BINARY_URL,
        acme_directory_url: s.acme_directory_url.clone(),
        acme_email: s.acme_email.clone(),
        remove_mode: Field::of(
            s.remove_mode.as_deref().and_then(RemoveMode::parse),
            RemoveMode::Gate,
        ),
    }
}

fn security_view(eff: &Effective) -> SecurityView {
    let s = &eff.stored;
    let official = crate::updates::official_release_keys();
    SecurityView {
        audit_retention_days: Field::of(
            s.audit_retention_days.and_then(|v| u32::try_from(v).ok()),
            DEFAULT_AUDIT_RETENTION_DAYS,
        ),
        traffic_daily_retention_days: Field::of(
            s.traffic_daily_retention_days
                .and_then(|v| u32::try_from(v).ok()),
            crate::traffic::DEFAULT_DAILY_RETENTION_DAYS,
        ),
        cloudflare_ranges: s.cloudflare_ranges.clone(),
        cloudflare_ranges_shipped: crate::cloudflare::shipped_or_empty().len(),
        extra_release_keys: s.extra_release_keys.clone(),
        release_keys: eff
            .release_keys
            .iter()
            .map(|k| ReleaseKeyView {
                id: k.id.clone(),
                label: k.label.clone(),
                official: official.iter().any(|o| o.id == k.id),
            })
            .collect(),
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
    let eff = compute(cfg, stored, names);
    warnings.extend(eff.standing_warnings(state.payments().any_usable()));
    let legacy = legacy_nodes(&mut conn).await?;
    let mut server_names = Vec::new();
    for n in &eff.server_names {
        server_names.push(ServerNameView {
            display: idna::domain_to_unicode(&n.name).0,
            name: n.name.clone(),
            source: n.source.clone(),
            first_used_at: n.first_used_at,
            current: eff
                .node
                .as_ref()
                .is_some_and(|e| e.server_name.eq_ignore_ascii_case(&n.name)),
            locked: removal_blocker(eff.node.as_ref(), &n.source, &n.name, !legacy.is_empty()),
            nodes: nodes_using(&mut conn, &n.name).await?,
        });
    }
    let s = &eff.stored;
    Ok(SettingsView {
        site_name: s.site_name.clone(),
        version: s.version,
        updated_at: s.updated_at,
        main: DomainView {
            value: s.main_domain.clone(),
            display: display_of(&s.main_domain),
            effective: eff.main.as_ref().map(Origin::as_string),
            source: eff.main_source,
        },
        sub: DomainView {
            value: s.sub_domain.clone(),
            display: display_of(&s.sub_domain),
            effective: eff.sub.as_ref().map(Origin::as_string),
            source: eff.sub_source,
        },
        node: NodeDomainView {
            value: s.node_domain.clone(),
            display: display_of(&s.node_domain),
            panel_addr: eff.node.as_ref().map(|n| n.panel_addr.clone()),
            server_name: eff.node.as_ref().map(|n| n.server_name.clone()),
            source: eff.node_source,
            default_port: cfg.grpc.bind.port(),
        },
        trust_cloudflare: TrustView {
            value: s.trust_cloudflare,
            effective: eff.trust_cloudflare,
            source: eff.trust_source,
        },
        server_names,
        legacy_nodes: legacy,
        certificate_names: live.certs().names(),
        hot_reload: true,
        host_gate: eff.host_gate_on(),
        ask_enabled: cfg.tls_ask.bind.is_some(),
        cloudflare_ranges: eff.cloudflare.len(),
        probe: probe_view(&eff),
        node_ops: node_ops_view(&eff),
        security: security_view(&eff),
        obsolete_config_keys: cfg.legacy.names().map(str::to_string).collect(),
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
    /// PUT replaces all four: null or "" = not set (built-in behaviour).
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
        Some(s) => Domain::parse(s).map(Some).map_err(|e| {
            bad_request!(
                "settings.domain_invalid",
                "{field}：{e}",
                field = field,
                e = e
            )
        }),
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
    if let Some(d) = &node
        && d.host.parse::<IpAddr>().is_ok_and(|ip| ip.is_unspecified())
    {
        return Err(bad_request!(
            "settings.node_domain_unspecified",
            "节点通信域名：不能是 0.0.0.0 / ::"
        ));
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
    if let Some(d) = &node
        && current.stored.node_domain.as_deref() != Some(d.authority().as_str())
    {
        let c = check(Kind::Node, d, &current.cloudflare).await;
        match c.level {
            "block" if !req.force_node_cloudflare => {
                return Err(crate::auth::api_error!(
                    UNPROCESSABLE_ENTITY,
                    "settings.node_domain_cloudflare",
                    "{detail}",
                    detail = c.message
                ));
            }
            "ok" => {}
            _ => warnings.push(c.message),
        }
    }
    if let Some(d) = &sub
        && current.stored.sub_domain.as_deref() != Some(d.authority().as_str())
    {
        let c = check(Kind::Sub, d, &current.cloudflare).await;
        if c.level != "ok" {
            warnings.push(c.message);
        }
    }
    // Host gate: would the address this admin uses right now be refused?
    if main.is_some() && !req.confirm_host_change {
        let stored = Stored {
            main_domain: new.main_domain.clone(),
            sub_domain: new.sub_domain.clone(),
            ..Stored::default()
        };
        let next = compute(state.cfg(), stored, Vec::new());
        let host = host_of(&headers, &uri);
        if !next.host_allowed(host.as_deref()) {
            return Err(crate::auth::api_error!(
                UNPROCESSABLE_ENTITY,
                "settings.host_gate",
                "保存后面板只接受主域名/订阅域名（以及 IP 地址）的访问，当前访问地址 {host} 将被拒绝。\
                 请确认主域名已解析并能打开，再勾选确认后保存。",
                host = host.unwrap_or_default()
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
    /// PUT replaces all three: null = not set (built-in default).
    pub interval_secs: Option<u64>,
    /// 1..=4 http(s) URLs, primary first; null or [] = built-in default.
    pub urls: Option<Vec<String>>,
    pub panel_tcp: Option<bool>,
}

/// Validate a latency-test form (pure; Chinese messages for the console).
pub fn probe_values(req: &ProbeReq) -> Result<ProbeValues, ApiError> {
    let interval_secs = match req.interval_secs {
        None => None,
        Some(v) if PROBE_INTERVAL_SECS.contains(&v) => Some(v as i32),
        Some(_) => {
            return Err(bad_request!(
                "settings.probe_interval_range",
                "测速间隔：须在 600 秒（10 分钟）到 604800 秒（7 天）之间"
            ));
        }
    };
    let urls = match req.urls.as_deref() {
        None | Some([]) => None,
        Some(list) => {
            let list: Vec<String> = list.iter().map(|u| u.trim().to_string()).collect();
            if list.len() > PROBE_MAX_URLS {
                return Err(bad_request!(
                    "settings.probe_urls_too_many",
                    "测速地址：最多 4 个"
                ));
            }
            if let Some(bad) = list.iter().find(|u| !crate::nodestat::valid_probe_url(u)) {
                return Err(bad_request!(
                    "settings.probe_url_invalid",
                    "测速地址：{bad:?} 不是有效的 http(s) 地址（不能含空白或用户名）",
                    bad = bad
                ));
            }
            if !valid_probe_urls(&list) {
                return Err(bad_request!(
                    "settings.probe_url_duplicate",
                    "测速地址：不能重复"
                ));
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
    let d = Domain::parse(&req.domain).map_err(|e| {
        bad_request!(
            "settings.domain_invalid",
            "{field}：{e}",
            field = "域名",
            e = e
        )
    })?;
    Ok(Json(
        check(req.kind, &d, &state.settings().get().cloudflare).await,
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
        return Err(bad_request!(
            "settings.confirm_required",
            "需要确认（confirm: true）"
        ));
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
        .ask_permit(state.cfg().limits.tls_ask_rate_per_sec.max(1))
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
// CLI: `akari settings show|set|unset`
// ---------------------------------------------------------------------------

/// The settings as text lines (`settings show`, and as TOML comments in
/// `config check`).
fn describe_lines(eff: &Effective) -> Vec<String> {
    let s = &eff.stored;
    let show = |v: &Option<String>| v.clone().unwrap_or_else(|| "(not set)".into());
    let origin = |o: &Option<Origin>| {
        o.as_ref()
            .map(Origin::as_string)
            .unwrap_or_else(|| "(browser origin)".into())
    };
    let mut l = vec![
        format!("settings version: {}", s.version),
        format!(
            "main domain:      {}  -> {} [{:?}]",
            show(&s.main_domain),
            origin(&eff.main),
            eff.main_source
        ),
        format!(
            "sub domain:       {}  -> {} [{:?}]",
            show(&s.sub_domain),
            origin(&eff.sub),
            eff.sub_source
        ),
        match &eff.node {
            Some(n) => format!(
                "node domain:      {}  -> {} / {} [{:?}]",
                show(&s.node_domain),
                n.panel_addr,
                n.server_name,
                eff.node_source
            ),
            None => "node domain:      (not set)  -> no enrollment tokens until it is set \
                     (akari settings set node <host[:port]>)"
                .into(),
        },
        format!(
            "trust cloudflare: {} [{:?}]; {} ranges [{:?}]",
            eff.trust_cloudflare,
            eff.trust_source,
            eff.cloudflare.len(),
            eff.cloudflare_source
        ),
        format!(
            "probe interval:   {}s [{:?}]",
            eff.probe.interval_secs, eff.probe_sources.interval_secs
        ),
        format!(
            "probe urls:       {} [{:?}]",
            eff.probe.urls.join(" "),
            eff.probe_sources.urls
        ),
        format!(
            "probe panel tcp:  {} [{:?}]",
            eff.probe.panel_tcp, eff.probe_sources.panel_tcp
        ),
        format!(
            "install pin:      {}",
            s.install_tls_pin.as_deref().unwrap_or("(probed)")
        ),
        format!(
            "install fallback: {}",
            eff.install_fallback_url.as_deref().unwrap_or("(none)")
        ),
        format!(
            "acme:             {} {}",
            if eff.acme_directory_url.is_empty() {
                "(Let's Encrypt)"
            } else {
                &eff.acme_directory_url
            },
            eff.acme_email
        ),
        format!(
            "retention:        audit {} days, traffic history {} days (0 = forever)",
            eff.audit_retention_days, eff.traffic_daily_retention_days
        ),
        format!("remove mode:      {}", eff.remove_mode.as_str()),
        format!(
            "release keys:     {}",
            eff.release_keys
                .iter()
                .map(|k| k.id.clone())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        format!("host gate:        {}", eff.host_gate_on()),
        format!("gRPC certificate names: {}", eff.sans.join(", ")),
    ];
    l.retain(|x| !x.is_empty());
    l
}

pub async fn cli_show(cfg: &PanelConfig, pg: &sqlx::PgPool) -> anyhow::Result<()> {
    let mut conn = pg.acquire().await?;
    let (stored, names) = load(&mut conn).await?;
    let eff = compute(cfg, stored, names);
    for line in describe_lines(&eff) {
        println!("{line}");
    }
    let payments: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM payment_methods WHERE enabled)")
            .fetch_one(&mut *conn)
            .await?;
    for w in eff.standing_warnings(payments) {
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
        let (stored, names) = load(&mut conn).await?;
        let pay = crate::billing::methods::describe(&mut conn).await?;
        Ok::<_, sqlx::Error>((stored, names, pay))
    };
    match tokio::time::timeout(Duration::from_secs(5), attempt).await {
        Ok(Ok((s, names, pay))) => {
            let e = compute(cfg, s, names);
            let mut out =
                String::from("\n# --- 系统设置 (database; the only source of these values) ---\n");
            for line in describe_lines(&e) {
                out.push_str(&format!("# {line}\n"));
            }
            out + &pay.text
                + &e.standing_warnings(pay.enabled)
                    .iter()
                    .map(|w| format!("# WARNING: {w}\n"))
                    .collect::<String>()
        }
        Ok(Err(e)) => format!("\n# 系统设置: database not readable ({e})\n"),
        Err(_) => "\n# 系统设置: database not reachable\n".into(),
    }
}

/// `akari settings unset <field>`: back to the built-in default (audited,
/// actor cli).
pub async fn cli_unset(cfg: &PanelConfig, pg: &sqlx::PgPool, field: &str) -> anyhow::Result<()> {
    let msg = |e: ApiError| anyhow::anyhow!("{}", e.message());
    let mut tx = pg.begin().await?;
    if field == "probe" || field == "all" {
        // W12: the latency-test values (own audit action).
        let cur = read_stored(&mut tx, false).await?;
        apply_update_probe(
            &mut tx,
            &Actor::cli(),
            cfg,
            cur.version,
            &ProbeValues::default(),
        )
        .await
        .map_err(msg)?;
    }
    if field == "all" {
        let cur = read_stored(&mut tx, false).await?;
        apply_update_node_ops(
            &mut tx,
            &Actor::cli(),
            cur.version,
            &NodeOpsValues::default(),
        )
        .await
        .map_err(msg)?;
        let cur = read_stored(&mut tx, false).await?;
        apply_update_security(
            &mut tx,
            &Actor::cli(),
            cur.version,
            &SecurityValues::default(),
        )
        .await
        .map_err(msg)?;
    }
    if field != "probe" {
        let cur = read_stored(&mut tx, false).await?;
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
            .map_err(msg)?;
    }
    tx.commit().await?;
    println!("{field}: unset (built-in default); running panels pick it up at once");
    Ok(())
}

/// `akari settings set <main|sub|node|trust-cloudflare> <value>` (audited,
/// actor cli): headless setup, e.g. the node domain before the first
/// login. No DNS check here (the console does it).
pub async fn cli_set(
    _cfg: &PanelConfig,
    pg: &sqlx::PgPool,
    field: &str,
    value: &str,
) -> anyhow::Result<()> {
    let mut tx = pg.begin().await?;
    let cur = read_stored(&mut tx, false).await?;
    let mut new = Values::of(&cur);
    let domain = || {
        Domain::parse(value)
            .map(|d| d.authority())
            .map_err(|e| anyhow::anyhow!("{field}: {e}"))
    };
    match field {
        "main" => new.main_domain = Some(domain()?),
        "sub" => new.sub_domain = Some(domain()?),
        "node" => {
            let d = Domain::parse(value).map_err(|e| anyhow::anyhow!("node: {e}"))?;
            if d.host.parse::<IpAddr>().is_ok_and(|ip| ip.is_unspecified()) {
                anyhow::bail!("node: 0.0.0.0 / :: is not an address agents can dial");
            }
            new.node_domain = Some(d.authority());
        }
        "trust-cloudflare" => {
            new.trust_cloudflare = Some(
                value
                    .parse()
                    .map_err(|_| anyhow::anyhow!("trust-cloudflare: true or false"))?,
            )
        }
        _ => anyhow::bail!("field must be main, sub, node or trust-cloudflare"),
    }
    apply_update(&mut tx, &Actor::cli(), cur.version, &new)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message()))?;
    tx.commit().await?;
    println!("{field}: set; running panels pick it up at once");
    Ok(())
}

// ---------------------------------------------------------------------------
// W25: one-time import of obsolete panel.toml keys
// ---------------------------------------------------------------------------

/// What happened to one obsolete key on this start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Imported {
    /// Written into the database now.
    Now,
    /// The database already had a value; the file value was not used.
    Kept,
    /// Handled on an earlier start: ignored.
    Before,
    /// Unreadable or invalid: ignored (reason).
    Unusable(String),
    /// A built-in constant now: ignored.
    Constant,
    /// The feature is gone: ignored.
    Removed,
}

/// The one-time import's report (logged at startup; tests read it).
#[derive(Debug, Default)]
pub struct ImportReport {
    pub keys: Vec<(String, Imported)>,
    /// The import turned the host gate on (main domain from the file).
    pub host_gate_on: bool,
}

impl ImportReport {
    pub fn get(&self, key: &str) -> Option<&Imported> {
        self.keys.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

/// The new value of one setting from an obsolete key (Err = unusable).
fn legacy_value(
    legacy: &crate::config::Legacy,
    key: &str,
    new: &mut Stored,
    names: &mut Vec<String>,
) -> Result<bool, String> {
    // Returns Ok(true) when the database had no value (written), Ok(false)
    // when it had one (kept).
    macro_rules! get {
        ($t:ty) => {
            match legacy.get::<$t>(key) {
                Some(Ok(v)) => v,
                Some(Err(e)) => return Err(e),
                None => return Err("missing".into()),
            }
        };
    }
    fn put<T>(slot: &mut Option<T>, v: T) -> bool {
        if slot.is_some() {
            return false;
        }
        *slot = Some(v);
        true
    }
    let domain = |v: &str| Domain::parse(v).map(|d| d.authority());
    Ok(match key {
        "web.sub_domain" => put(&mut new.sub_domain, domain(&get!(String))?),
        "web.trust_cloudflare" => put(&mut new.trust_cloudflare, get!(bool)),
        "web.cloudflare_ranges" => {
            let list: Vec<String> = get!(Vec<String>);
            let req = SecurityReq {
                version: 0,
                audit_retention_days: None,
                traffic_daily_retention_days: None,
                cloudflare_ranges: Some(list),
                extra_release_keys: None,
            };
            match security_values(&req)
                .map_err(|e| e.message().to_string())?
                .cloudflare_ranges
            {
                Some(v) => put(&mut new.cloudflare_ranges, v),
                None => return Err("empty (the shipped list applies)".into()),
            }
        }
        "web.advertised_names" | "grpc.server_name" => {
            let list: Vec<String> = if key == "grpc.server_name" {
                vec![get!(String)]
            } else {
                get!(Vec<String>)
            };
            let list: Vec<String> = list
                .into_iter()
                .map(|n| n.trim().trim_end_matches('.').to_ascii_lowercase())
                .filter(|n| {
                    !n.is_empty() && !n.chars().any(|c| c.is_whitespace() || c.is_control())
                })
                .collect();
            if list.is_empty() {
                return Err("empty".into());
            }
            names.extend(list);
            true
        }
        "grpc.advertise" => {
            let v = domain(&get!(String))?;
            if Domain::parse(&v)
                .ok()
                .and_then(|d| d.host.parse::<IpAddr>().ok())
                .is_some_and(|ip| ip.is_unspecified())
            {
                return Err("0.0.0.0 / :: is not an address agents can dial".into());
            }
            put(&mut new.node_domain, v)
        }
        "install.public_url" => {
            let o = crate::nodeinstall::parse_origin(&get!(String))?;
            if !o.https {
                return Err("not an https origin".into());
            }
            let auth = match o.port {
                Some(p) if p != 443 => format!("{}:{p}", o.host),
                _ => o.host.clone(),
            };
            put(&mut new.main_domain, domain(&auth)?)
        }
        "install.tls_pin" => {
            let v = get!(String);
            if v.trim().is_empty() {
                return Err("empty (probed)".into());
            }
            if !crate::nodeinstall::valid_pin(v.trim()) {
                return Err("not a sha256// pin".into());
            }
            put(&mut new.install_tls_pin, v.trim().to_string())
        }
        "install.fallback_binary_url" => {
            let v = get!(String);
            let v = v.trim();
            if !v.is_empty() && !crate::nodeinstall::fallback_url_ok(v) {
                return Err("not an https URL with {arch}".into());
            }
            if v == crate::config::DEFAULT_FALLBACK_BINARY_URL {
                return Err("the built-in default".into());
            }
            put(&mut new.install_fallback_url, v.to_string())
        }
        "probe.interval_secs" => {
            let v: u64 = get!(u64);
            if !PROBE_INTERVAL_SECS.contains(&v) {
                return Err("outside 600..=604800".into());
            }
            put(&mut new.probe_interval_secs, v as i32)
        }
        "probe.urls" => {
            let v: Vec<String> = get!(Vec<String>);
            if !valid_probe_urls(&v) {
                return Err("1-4 distinct http(s) URLs required".into());
            }
            put(&mut new.probe_urls, v)
        }
        "probe.panel_tcp" => put(&mut new.probe_panel_tcp, get!(bool)),
        "acme.directory_url" => {
            let v = get!(String);
            if v.trim().is_empty() {
                return Err("empty (Let's Encrypt)".into());
            }
            if !acme_url_ok(v.trim()) {
                return Err("not an https URL".into());
            }
            put(&mut new.acme_directory_url, v.trim().to_string())
        }
        "acme.email" => {
            let v = get!(String);
            if v.trim().is_empty() {
                return Err("empty".into());
            }
            if !acme_email_ok(v.trim()) {
                return Err("not an e-mail address".into());
            }
            put(&mut new.acme_email, v.trim().to_string())
        }
        "audit.retention_days" => {
            let v: u32 = get!(u32);
            if v > 36_500 {
                return Err("above 36500".into());
            }
            put(&mut new.audit_retention_days, v as i32)
        }
        "traffic.daily_retention_days" => {
            let v: u32 = get!(u32);
            if v != 0 && !(32..=36_500).contains(&v) {
                return Err("must be 0 or 32..=36500".into());
            }
            put(&mut new.traffic_daily_retention_days, v as i32)
        }
        "agent.remove_mode" => {
            let v = get!(String);
            let m = RemoveMode::parse(v.trim()).ok_or("must be gate or rebuild")?;
            put(&mut new.remove_mode, m.as_str().to_string())
        }
        "updates.release_keys" => {
            let v: Vec<String> = get!(Vec<String>);
            let keys = crate::updates::parse_release_keys(&v)?;
            let official = crate::updates::official_release_keys();
            let extra: Vec<String> = v
                .iter()
                .zip(&keys)
                .filter(|(_, k)| !official.iter().any(|o| o.id == k.id))
                .map(|(line, _)| line.split_whitespace().collect::<Vec<_>>().join(" "))
                .collect();
            if extra.is_empty() {
                return Err("only official keys (built in)".into());
            }
            if extra.len() > MAX_EXTRA_RELEASE_KEYS {
                return Err("more than 16 keys".into());
            }
            put(&mut new.extra_release_keys, extra)
        }
        _ => return Err("not importable".into()),
    })
}

/// `alerts.telegram_api_url` → `alert_settings.telegram_api_url` (告警 →
/// Telegram API 地址). The built-in origin itself is not imported.
fn legacy_telegram(
    legacy: &crate::config::Legacy,
    cur: &Option<String>,
    new: &mut Option<String>,
) -> Result<bool, String> {
    let key = "alerts.telegram_api_url";
    let v: String = match legacy.get::<String>(key) {
        Some(Ok(v)) => v,
        Some(Err(e)) => return Err(e),
        None => return Err("missing".into()),
    };
    let v = v.trim().trim_end_matches('/').to_string();
    if !crate::alerts::valid_telegram_api_url(&v) {
        return Err("not an https origin".into());
    }
    if v == crate::config::TELEGRAM_API_URL {
        return Err("the built-in origin".into());
    }
    if cur.is_some() {
        return Ok(false);
    }
    *new = Some(v);
    Ok(true)
}

/// Startup (before `init`): obsolete keys of an older panel.toml. Each key
/// that moved to 系统设置 is imported ONCE — when the database has no
/// value and no earlier start handled the key — in one transaction under
/// the settings row lock (concurrent instances import once), audited
/// `settings.import` as actor `system`; server names (`web.advertised_names`,
/// `grpc.server_name`) join `grpc_server_names` (source `config`) so the
/// gRPC certificate keeps covering them. Every key is then ignored with a
/// warning; keys that became built-in constants are only warned about.
/// `[payments]` is W24's (`billing::methods::import_legacy`). Never fails
/// the start.
pub async fn import_legacy(state: &AppState) -> ImportReport {
    let legacy = &state.cfg().legacy;
    let mut report = ImportReport::default();
    if legacy.is_empty() {
        return report;
    }
    match import_tx(state.pg(), legacy).await {
        Ok(r) => report = r,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "obsolete panel.toml keys could not be imported; they are ignored: set them in \
                 系统设置 and delete them from panel.toml"
            );
            return report;
        }
    }
    for (key, what) in &report.keys {
        let place = match crate::config::fate(key) {
            Some(crate::config::Fate::Moved(p)) => p,
            _ => "",
        };
        match what {
            Imported::Now => tracing::warn!(
                key,
                "panel.toml {key} imported into 系统设置 → {place}; it is obsolete and now \
                 ignored: delete it from panel.toml"
            ),
            Imported::Kept => tracing::warn!(
                key,
                "panel.toml {key} is obsolete and ignored (系统设置 → {place} already has a \
                 value): delete it from panel.toml"
            ),
            Imported::Before => tracing::warn!(
                key,
                "panel.toml {key} is obsolete and ignored (系统设置 → {place} is the only \
                 source): delete it from panel.toml"
            ),
            Imported::Unusable(why) => tracing::warn!(
                key,
                reason = %why,
                "panel.toml {key} is obsolete and was not imported ({why}): set 系统设置 → \
                 {place} if needed, then delete it from panel.toml"
            ),
            Imported::Constant => tracing::warn!(
                key,
                "panel.toml {key} is obsolete: the value is built in now; delete it from \
                 panel.toml"
            ),
            Imported::Removed => tracing::warn!(
                key,
                "panel.toml {key} is obsolete: the feature was removed; delete it from \
                 panel.toml"
            ),
        }
    }
    if report.host_gate_on {
        tracing::warn!(
            "install.public_url became the main domain: the host gate is on (requests for other \
             DNS names are refused; IP addresses stay allowed). Check 系统设置 → 站点; \
             `akari settings unset main` turns it off"
        );
    }
    report
}

async fn import_tx(
    pg: &sqlx::PgPool,
    legacy: &crate::config::Legacy,
) -> anyhow::Result<ImportReport> {
    let mut tx = pg.begin().await?;
    let cur = read_stored(&mut tx, true).await?;
    let handled: Vec<String> = sqlx::query_scalar("SELECT key FROM legacy_config_imports")
        .fetch_all(&mut *tx)
        .await?;
    let mut new = cur.clone();
    let cur_tg: Option<String> =
        sqlx::query_scalar("SELECT telegram_api_url FROM alert_settings WHERE id = 1 FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    let mut new_tg = cur_tg.clone();
    let mut names: Vec<String> = Vec::new();
    let mut report = ImportReport::default();
    let mut marks: Vec<(String, &'static str)> = Vec::new();
    for key in legacy.names() {
        match crate::config::fate(key) {
            None => continue,
            Some(crate::config::Fate::Constant) => {
                report.keys.push((key.to_string(), Imported::Constant));
                continue;
            }
            Some(crate::config::Fate::Removed(_)) => {
                report.keys.push((key.to_string(), Imported::Removed));
                continue;
            }
            Some(crate::config::Fate::Moved(_)) if key == "payments.*" => continue,
            Some(crate::config::Fate::Moved(_)) => {}
        }
        if handled.iter().any(|h| h == key) {
            report.keys.push((key.to_string(), Imported::Before));
            continue;
        }
        let res = if key == "alerts.telegram_api_url" {
            legacy_telegram(legacy, &cur_tg, &mut new_tg)
        } else {
            legacy_value(legacy, key, &mut new, &mut names)
        };
        let outcome = match res {
            Ok(true) => Imported::Now,
            Ok(false) => Imported::Kept,
            Err(why) => Imported::Unusable(why),
        };
        marks.push((
            key.to_string(),
            match outcome {
                Imported::Now => "imported",
                Imported::Kept => "kept",
                _ => "unusable",
            },
        ));
        report.keys.push((key.to_string(), outcome));
    }
    for n in &names {
        record_server_name(&mut tx, n, "config").await?;
    }
    if new != cur {
        report.host_gate_on = cur.main_domain.is_none() && new.main_domain.is_some();
        sqlx::query(
            "UPDATE panel_settings SET main_domain = $1, sub_domain = $2, node_domain = $3, \
                 trust_cloudflare = $4, probe_interval_secs = $5, probe_urls = $6, \
                 probe_panel_tcp = $7, cloudflare_ranges = $8, install_tls_pin = $9, \
                 install_fallback_url = $10, acme_directory_url = $11, acme_email = $12, \
                 audit_retention_days = $13, traffic_daily_retention_days = $14, \
                 remove_mode = $15, extra_release_keys = $16, \
                 version = version + 1, updated_at = now() \
             WHERE id = 1",
        )
        .bind(&new.main_domain)
        .bind(&new.sub_domain)
        .bind(&new.node_domain)
        .bind(new.trust_cloudflare)
        .bind(new.probe_interval_secs)
        .bind(&new.probe_urls)
        .bind(new.probe_panel_tcp)
        .bind(&new.cloudflare_ranges)
        .bind(&new.install_tls_pin)
        .bind(&new.install_fallback_url)
        .bind(&new.acme_directory_url)
        .bind(&new.acme_email)
        .bind(new.audit_retention_days)
        .bind(new.traffic_daily_retention_days)
        .bind(&new.remove_mode)
        .bind(&new.extra_release_keys)
        .execute(&mut *tx)
        .await?;
    }
    if new_tg != cur_tg {
        sqlx::query(
            "UPDATE alert_settings SET telegram_api_url = $1, version = version + 1, \
                 updated_at = now() WHERE id = 1",
        )
        .bind(&new_tg)
        .execute(&mut *tx)
        .await?;
    }
    if !marks.is_empty() {
        let (keys, outcomes): (Vec<String>, Vec<&str>) = marks.into_iter().unzip();
        sqlx::query(
            "INSERT INTO legacy_config_imports (key, outcome) \
             SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (key) DO NOTHING",
        )
        .bind(&keys)
        .bind(&outcomes)
        .execute(&mut *tx)
        .await?;
        let imported: Vec<&str> = report
            .keys
            .iter()
            .filter(|(_, o)| *o == Imported::Now)
            .map(|(k, _)| k.as_str())
            .collect();
        if !imported.is_empty() {
            let diff = |s: &Stored, tg: &Option<String>| {
                let mut v = serde_json::to_value(s).unwrap_or_default();
                if let Some(o) = v.as_object_mut() {
                    o.remove("version");
                    o.retain(|k, _| legacy_column_changed(k, &cur, &new));
                    if new_tg != cur_tg {
                        o.insert("alerts.telegram_api_url".into(), json!(tg));
                    }
                }
                v
            };
            crate::audit::record(
                &mut tx,
                &Actor::system(),
                "settings.import",
                "settings",
                None,
                Some(diff(&cur, &cur_tg)),
                Some(json!({
                    "values": diff(&new, &new_tg),
                    "keys": imported,
                    "server_names": names,
                })),
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(report)
}

/// Did the import change this `Stored` column?
fn legacy_column_changed(col: &str, a: &Stored, b: &Stored) -> bool {
    let (a, b) = (serde_json::to_value(a), serde_json::to_value(b));
    match (a, b) {
        (Ok(a), Ok(b)) => a.get(col) != b.get(col),
        _ => true,
    }
}

#[cfg(test)]
mod tests;
