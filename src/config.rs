//! `panel.toml` (R39/W25): only what the process needs to start — data
//! directory, database, Valkey, listeners. Everything an operator changes
//! at runtime lives in the database (系统设置, `settings.rs`); internal
//! tuning knobs are built-in constants (`Limits`). There is no file
//! fallback and no precedence merging.
//!
//! Keys of older releases are OBSOLETE, never an error: `load` takes them
//! out of the file before the strict parse (typos in the kept sections
//! still fail, `deny_unknown_fields`) and keeps them in `Legacy`, which
//! only the one-time import (`settings::import_legacy`, W24 pattern for
//! `[payments]`) and `config check` read.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PanelConfig {
    pub data_dir: PathBuf,
    pub database_url: String,
    pub valkey_url: String,
    pub web: WebConfig,
    pub grpc: GrpcConfig,
    pub metrics: MetricsConfig,
    pub tls_ask: TlsAskConfig,
    /// Built-in constants (never read from the file). Tests may tweak them;
    /// `AKARI_TEST_LIMITS` (test runs only, logged) shortens a few timers.
    #[serde(skip)]
    pub limits: Limits,
    /// Obsolete keys found in the file (import / warnings only).
    #[serde(skip)]
    pub legacy: Legacy,
}

/// Prometheus metrics (M1-4). Served on its OWN listener, never on the
/// public web port (a `/metrics` there would be a rejection-identity leak).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct MetricsConfig {
    /// Listen address of the metrics endpoint; unset = metrics disabled.
    /// Must be a loopback address unless `allow_non_loopback` is set.
    pub bind: Option<SocketAddr>,
    /// Permit a non-loopback `bind` (e.g. a private interface scraped by
    /// Prometheus). The endpoint has no authentication: firewall it.
    pub allow_non_loopback: bool,
}

/// Caddy on-demand TLS `ask` endpoint (R22): `GET /ask?domain=<name>`
/// answers 200 only for the configured main/subscription domains, so the
/// reverse proxy obtains certificates for them without Caddyfile edits.
/// Served on its OWN listener (never the public web port; like metrics).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct TlsAskConfig {
    /// Listen address; unset = disabled. Loopback unless
    /// `allow_non_loopback` (compose: Caddy reaches it on the private
    /// frontend network).
    pub bind: Option<SocketAddr>,
    pub allow_non_loopback: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct WebConfig {
    pub bind: SocketAddr,
    /// Reverse proxies in front of the panel (CIDRs or addresses). Only
    /// when the TCP peer is one of them is X-Forwarded-For consulted: the
    /// client is the rightmost hop that is not a trusted proxy. Default
    /// empty: the TCP peer is the client, headers are ignored.
    pub trusted_proxies: Vec<crate::client_ip::Cidr>,
    /// `Secure` attribute of the session cookie. Default true (browsers
    /// then only send it over HTTPS — put the panel behind a TLS proxy);
    /// set false only for plain-HTTP development.
    pub cookie_secure: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct GrpcConfig {
    /// Agents dial this directly with mTLS (public, not behind an HTTP
    /// proxy). The address agents dial is 系统设置 → 节点通信域名; a node
    /// domain without a port uses this port.
    pub bind: SocketAddr,
}

impl Default for PanelConfig {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("./data"),
            database_url: "postgres://akari:akari-dev@localhost:5432/akari".into(),
            valkey_url: "redis://127.0.0.1:6379".into(),
            web: WebConfig::default(),
            grpc: GrpcConfig::default(),
            metrics: MetricsConfig::default(),
            tls_ask: TlsAskConfig::default(),
            limits: Limits::default(),
            legacy: Legacy::default(),
        }
    }
}

impl Default for WebConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 8080)),
            trusted_proxies: Vec::new(),
            cookie_secure: true,
        }
    }
}

impl Default for GrpcConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 8443)),
        }
    }
}

impl PanelConfig {
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let mut cfg = match path {
            Some(p) => Self::parse(&std::fs::read_to_string(p)?)?,
            None => PanelConfig::default(),
        };
        // Environment wins over file for secrets/endpoints.
        if let Ok(v) = std::env::var("DATABASE_URL") {
            cfg.database_url = v;
        }
        if let Ok(v) = std::env::var("VALKEY_URL") {
            cfg.valkey_url = v;
        }
        if let Ok(v) = std::env::var(TEST_LIMITS_ENV) {
            cfg.limits.apply_test_overrides(&v)?;
        }
        Ok(cfg)
    }

    /// Parse a panel.toml: obsolete keys go to `legacy`, the rest is
    /// parsed strictly (unknown keys are errors).
    pub fn parse(text: &str) -> Result<Self> {
        let mut table: toml::Table = toml::from_str(text)?;
        let legacy = Legacy::extract(&mut table);
        let mut cfg: PanelConfig = toml::Value::Table(table).try_into()?;
        cfg.legacy = legacy;
        Ok(cfg)
    }
}

// ---------------------------------------------------------------------------
// Obsolete keys (W24/W25)
// ---------------------------------------------------------------------------

/// What became of an obsolete key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fate {
    /// Moved to 系统设置 (the page named): imported once, then ignored.
    Moved(&'static str),
    /// A built-in constant now: ignored.
    Constant,
    /// The feature itself is gone (why, shown to the operator): ignored.
    Removed(&'static str),
}

/// Every key earlier releases read from panel.toml and this one does not,
/// as "section.key" (a whole obsolete section: "section.*").
pub const OBSOLETE: &[(&str, Fate)] = &[
    ("web.advertised_names", Fate::Moved("节点通信 → 证书域名")),
    ("web.sub_domain", Fate::Moved("站点 → 订阅域名")),
    (
        "web.trust_cloudflare",
        Fate::Moved("站点 → 信任 Cloudflare"),
    ),
    (
        "web.cloudflare_ranges",
        Fate::Moved("安全 → Cloudflare 网段"),
    ),
    ("grpc.advertise", Fate::Moved("节点通信 → 节点通信域名")),
    ("grpc.server_name", Fate::Moved("节点通信 → 证书域名")),
    ("grpc.lease_seconds", Fate::Constant),
    ("install.public_url", Fate::Moved("站点 → 主域名")),
    (
        "install.tls_pin",
        Fate::Moved("节点通信 → 安装命令公钥钉扎"),
    ),
    (
        "install.fallback_binary_url",
        Fate::Moved("节点通信 → 备用下载地址"),
    ),
    ("install.token_ttl_secs", Fate::Constant),
    ("install.rate_per_ip", Fate::Constant),
    ("install.rate_window_secs", Fate::Constant),
    ("probe.interval_secs", Fate::Moved("测速 → 测速间隔")),
    ("probe.urls", Fate::Moved("测速 → 测速地址")),
    ("probe.panel_tcp", Fate::Moved("测速 → 面板 TCP 测速")),
    ("probe.timeout_ms", Fate::Constant),
    ("probe.attempts", Fate::Constant),
    ("probe.manual_cooldown_secs", Fate::Constant),
    ("acme.directory_url", Fate::Moved("节点通信 → ACME 目录")),
    ("acme.email", Fate::Moved("节点通信 → ACME 邮箱")),
    (
        "audit.retention_days",
        Fate::Moved("安全 → 审计日志保留天数"),
    ),
    (
        "traffic.daily_retention_days",
        Fate::Moved("安全 → 流量明细保留天数"),
    ),
    ("traffic.max_rate_bytes_per_sec", Fate::Constant),
    ("traffic.node_max_rate_bytes_per_sec", Fate::Constant),
    ("traffic.node_burst_secs", Fate::Constant),
    ("traffic.departed_grace_secs", Fate::Constant),
    (
        "auth.require_admin_2fa",
        Fate::Removed("two-factor authentication (TOTP) was removed in v0.4; use passkeys"),
    ),
    ("agent.remove_mode", Fate::Moved("节点通信 → 撤权方式")),
    ("agent.cert_validity_secs", Fate::Constant),
    ("agent.enroll_token_ttl_secs", Fate::Constant),
    ("agent.enroll_rate_per_ip", Fate::Constant),
    ("agent.enroll_rate_global", Fate::Constant),
    ("agent.enroll_rate_window_secs", Fate::Constant),
    ("sub.rate_per_ip", Fate::Constant),
    ("sub.rate_per_token", Fate::Constant),
    ("sub.rate_window_secs", Fate::Constant),
    (
        "updates.release_keys",
        Fate::Moved("安全 → 额外信任的发布公钥"),
    ),
    ("updates.max_concurrent_downloads", Fate::Constant),
    ("tls_ask.rate_per_sec", Fate::Constant),
    ("alerts.eval_interval_secs", Fate::Constant),
    (
        "alerts.telegram_api_url",
        Fate::Moved("告警 → Telegram API 地址"),
    ),
    ("payments.*", Fate::Moved("支付")),
];

/// The fate of an obsolete "section.key" (None = not obsolete).
pub fn fate(key: &str) -> Option<Fate> {
    let section = key.split_once('.').map(|(s, _)| s).unwrap_or(key);
    OBSOLETE
        .iter()
        .find_map(|(k, f)| (*k == key || k.strip_suffix(".*") == Some(section)).then_some(*f))
}

/// Obsolete keys found in a panel.toml, verbatim ("section.key" → value).
/// Read leniently: a value of the wrong type is reported and skipped, it
/// never stops the start.
#[derive(Debug, Clone, Default)]
pub struct Legacy {
    pub keys: BTreeMap<String, toml::Value>,
}

impl Legacy {
    /// Move every obsolete key out of `table`. Kept keys and unknown keys
    /// (typos) stay; an obsolete section left empty is removed.
    pub fn extract(table: &mut toml::Table) -> Self {
        let mut keys = BTreeMap::new();
        let sections: Vec<String> = table.keys().cloned().collect();
        for section in sections {
            let whole = OBSOLETE
                .iter()
                .any(|(k, _)| k.strip_suffix(".*") == Some(section.as_str()));
            let Some(toml::Value::Table(sub)) = table.get_mut(&section) else {
                continue;
            };
            if whole {
                if let Some(v) = table.remove(&section) {
                    keys.insert(format!("{section}.*"), v);
                }
                continue;
            }
            let names: Vec<String> = sub.keys().cloned().collect();
            for name in names {
                let dotted = format!("{section}.{name}");
                if fate(&dotted).is_some()
                    && let Some(v) = sub.remove(&name)
                {
                    keys.insert(dotted, v);
                }
            }
            // A section that only held obsolete keys (e.g. [probe]) and is
            // not part of the kept schema goes away entirely.
            if sub.is_empty() && !KEPT_SECTIONS.contains(&section.as_str()) {
                table.remove(&section);
            }
        }
        Self { keys }
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// The obsolete keys found (sorted). Keys of a known section that are
    /// neither kept nor obsolete stay in the file table: the strict parse
    /// rejects them as typos.
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.keys.keys().map(String::as_str)
    }

    /// A typed obsolete value; Err = present but unreadable.
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<Result<T, String>> {
        let v = self.keys.get(key)?;
        Some(
            v.clone()
                .try_into()
                .map_err(|e: toml::de::Error| e.message().to_string()),
        )
    }

    /// For tests: a config whose file held these obsolete keys.
    pub fn from_pairs(pairs: &[(&str, toml::Value)]) -> Self {
        Self {
            keys: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        }
    }
}

/// Sections of the kept schema (the strict parse knows them).
const KEPT_SECTIONS: &[&str] = &["web", "grpc", "metrics", "tls_ask"];

// ---------------------------------------------------------------------------
// Built-in constants (formerly panel.toml knobs; src/CLAUDE.md)
// ---------------------------------------------------------------------------

/// Fail-closed lease granted to agents after every successful read of their
/// desired state (agents clamp to >= 1 h): an agent that hears nothing for
/// this long stops xray.
pub const LEASE_SECONDS: u64 = 86_400;
/// Per (node, user, session) plausibility cap of billed bytes per second.
pub const TRAFFIC_MAX_RATE_BYTES_PER_SEC: i64 = 1_250_000_000;
/// Per-server aggregate cap of billed upload + download bytes per second
/// (10 Gbit/s; a server's `traffic_max_rate_bytes_per_sec` overrides it).
/// It is the sum of both directions: a full-duplex NIC of N moves up to 2N.
pub const TRAFFIC_NODE_MAX_RATE_BYTES_PER_SEC: i64 = 1_250_000_000;
/// Burst window of the billing caps (R13).
pub const DEFAULT_NODE_BURST_SECS: u64 = 120;
/// Validity of agent client certificates (M1-8; renewed at 1/3 left).
pub const DEFAULT_CERT_VALIDITY_SECS: u64 = 90 * 86_400;
/// Lifetime of a bootstrap enrollment token.
pub const ENROLL_TOKEN_TTL_SECS: u64 = 86_400;
/// Enrollment RPC rate limit per source (/64) and over all sources.
pub const ENROLL_RATE_PER_IP: i64 = 10;
pub const ENROLL_RATE_GLOBAL: i64 = 60;
pub const ENROLL_RATE_WINDOW_SECS: i64 = 600;
/// Lifetime of a one-line install link.
pub const INSTALL_TOKEN_TTL_SECS: u64 = 3600;
/// Install script / agent downloads per source (/64) per window.
pub const INSTALL_RATE_PER_IP: i64 = 20;
pub const INSTALL_RATE_WINDOW_SECS: i64 = 600;
/// Subscription fetches per source (/64) and per token per window.
pub const SUB_RATE_PER_IP: i64 = 120;
pub const SUB_RATE_PER_TOKEN: i64 = 30;
pub const SUB_RATE_WINDOW_SECS: i64 = 600;
/// Concurrent agent artifact downloads served by one instance.
pub const MAX_CONCURRENT_DOWNLOADS: usize = 8;
/// Caddy ask requests answered per second by one instance.
pub const TLS_ASK_RATE_PER_SEC: u32 = 20;
/// Alert evaluation / delivery cadence.
pub const ALERTS_EVAL_INTERVAL_SECS: u64 = 30;
/// Telegram Bot API origin when 告警 → Telegram API 地址 is empty.
pub const TELEGRAM_API_URL: &str = "https://api.telegram.org";
/// Latency tests: per-attempt timeout, attempts per URL/address, and the
/// "立即测速" cooldown per node.
pub const PROBE_TIMEOUT_MS: u32 = 5000;
pub const PROBE_ATTEMPTS: u32 = 3;
pub const PROBE_MANUAL_COOLDOWN_SECS: u64 = 30;
/// Cloudflare Turnstile server-side verification (v0.4 D1).
pub const TURNSTILE_VERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/// W28-a relay entrance health (`entrance_health.rs`): one TCP connect to
/// each relay's address this often (±10 %); this many consecutive failures
/// hide it from subscriptions (the first success shows it again).
pub const ENTRANCE_HEALTH_INTERVAL_SECS: u64 = 60;
pub const ENTRANCE_HEALTH_FAILURES: i32 = 3;
/// Where the install script downloads the agent when no complete signed
/// release was uploaded (系统设置 → 节点通信 → 备用下载地址 overrides it).
pub const DEFAULT_FALLBACK_BINARY_URL: &str = "https://github.com/akari-projectX/akari-agent/releases/latest/download/akari-agent-linux-{arch}";

/// Environment variable of the TEST-ONLY timer overrides (smoke/e2e):
/// "name=value,name=value" over `Limits::TEST_TUNABLE`. Logged at startup;
/// never set it in production.
pub const TEST_LIMITS_ENV: &str = "AKARI_TEST_LIMITS";

/// The built-in constants as one value (tests tweak a copy).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    pub lease_seconds: u64,
    pub traffic_max_rate_bytes_per_sec: i64,
    pub traffic_node_max_rate_bytes_per_sec: i64,
    pub traffic_node_burst_secs: u64,
    pub traffic_departed_grace_secs: u64,
    pub cert_validity_secs: u64,
    pub enroll_token_ttl_secs: u64,
    pub enroll_rate_per_ip: i64,
    pub enroll_rate_global: i64,
    pub enroll_rate_window_secs: i64,
    pub install_token_ttl_secs: u64,
    pub install_rate_per_ip: i64,
    pub install_rate_window_secs: i64,
    pub sub_rate_per_ip: i64,
    pub sub_rate_per_token: i64,
    pub sub_rate_window_secs: i64,
    pub max_concurrent_downloads: usize,
    pub tls_ask_rate_per_sec: u32,
    pub alerts_eval_interval_secs: u64,
    pub probe_timeout_ms: u32,
    pub probe_attempts: u32,
    pub probe_manual_cooldown_secs: u64,
    /// Cloudflare Turnstile siteverify endpoint (tests point it at a
    /// loopback mock; https or loopback http only).
    pub turnstile_verify_url: String,
    pub entrance_health_interval_secs: u64,
    /// Test overrides applied (logged at startup).
    pub test_overrides: Vec<String>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            lease_seconds: LEASE_SECONDS,
            traffic_max_rate_bytes_per_sec: TRAFFIC_MAX_RATE_BYTES_PER_SEC,
            traffic_node_max_rate_bytes_per_sec: TRAFFIC_NODE_MAX_RATE_BYTES_PER_SEC,
            traffic_node_burst_secs: DEFAULT_NODE_BURST_SECS,
            traffic_departed_grace_secs: crate::traffic::DEFAULT_DEPARTED_GRACE_SECS,
            cert_validity_secs: DEFAULT_CERT_VALIDITY_SECS,
            enroll_token_ttl_secs: ENROLL_TOKEN_TTL_SECS,
            enroll_rate_per_ip: ENROLL_RATE_PER_IP,
            enroll_rate_global: ENROLL_RATE_GLOBAL,
            enroll_rate_window_secs: ENROLL_RATE_WINDOW_SECS,
            install_token_ttl_secs: INSTALL_TOKEN_TTL_SECS,
            install_rate_per_ip: INSTALL_RATE_PER_IP,
            install_rate_window_secs: INSTALL_RATE_WINDOW_SECS,
            sub_rate_per_ip: SUB_RATE_PER_IP,
            sub_rate_per_token: SUB_RATE_PER_TOKEN,
            sub_rate_window_secs: SUB_RATE_WINDOW_SECS,
            max_concurrent_downloads: MAX_CONCURRENT_DOWNLOADS,
            tls_ask_rate_per_sec: TLS_ASK_RATE_PER_SEC,
            alerts_eval_interval_secs: ALERTS_EVAL_INTERVAL_SECS,
            probe_timeout_ms: PROBE_TIMEOUT_MS,
            probe_attempts: PROBE_ATTEMPTS,
            probe_manual_cooldown_secs: PROBE_MANUAL_COOLDOWN_SECS,
            turnstile_verify_url: TURNSTILE_VERIFY_URL.to_string(),
            entrance_health_interval_secs: ENTRANCE_HEALTH_INTERVAL_SECS,
            test_overrides: Vec::new(),
        }
    }
}

impl Limits {
    /// The timers a test run may shorten (`AKARI_TEST_LIMITS`), with their
    /// bounds. Nothing else is tunable.
    pub const TEST_TUNABLE: &'static [(&'static str, u64, u64)] = &[
        ("cert_validity_secs", 60, DEFAULT_CERT_VALIDITY_SECS),
        ("alerts_eval_interval_secs", 1, ALERTS_EVAL_INTERVAL_SECS),
        ("probe_manual_cooldown_secs", 0, PROBE_MANUAL_COOLDOWN_SECS),
        ("sub_rate_per_token", 1, SUB_RATE_PER_TOKEN as u64),
        (
            "entrance_health_interval_secs",
            1,
            ENTRANCE_HEALTH_INTERVAL_SECS,
        ),
    ];

    /// The fail-closed lease actually granted: [1h, 30d].
    pub fn lease_seconds(&self) -> u64 {
        self.lease_seconds.clamp(3600, 30 * 86_400)
    }

    /// Apply "name=value,…" (TEST ONLY). Unknown names or values outside
    /// the bounds are errors (the start stops: a typo must not silently
    /// run with production timers in a test, nor anything else anywhere).
    pub fn apply_test_overrides(&mut self, spec: &str) -> Result<()> {
        for part in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let (name, value) = part
                .split_once('=')
                .with_context(|| format!("{TEST_LIMITS_ENV}: {part:?} is not name=value"))?;
            let (name, value) = (name.trim(), value.trim());
            let Some(&(_, lo, hi)) = Self::TEST_TUNABLE.iter().find(|(n, _, _)| *n == name) else {
                anyhow::bail!("{TEST_LIMITS_ENV}: {name:?} cannot be overridden");
            };
            let v: u64 = value
                .parse()
                .ok()
                .filter(|v| (lo..=hi).contains(v))
                .with_context(|| format!("{TEST_LIMITS_ENV}: {name} must be {lo}..={hi}"))?;
            match name {
                "cert_validity_secs" => self.cert_validity_secs = v,
                "alerts_eval_interval_secs" => self.alerts_eval_interval_secs = v,
                "probe_manual_cooldown_secs" => self.probe_manual_cooldown_secs = v,
                "sub_rate_per_token" => self.sub_rate_per_token = v as i64,
                "entrance_health_interval_secs" => self.entrance_health_interval_secs = v,
                _ => anyhow::bail!("{TEST_LIMITS_ENV}: {name:?} cannot be overridden"),
            }
            self.test_overrides.push(format!("{name}={v}"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Value types of database settings
// ---------------------------------------------------------------------------

/// W11 latency tests (`nodestat.rs`): the effective test schedule and
/// targets (interval / URLs / panel TCP from 系统设置, the rest built in).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeConfig {
    /// Seconds between scheduled tests. Default 18000 (5 h); 600..=604800.
    pub interval_secs: u64,
    /// Test URLs (http/https, at most 4), primary first.
    pub urls: Vec<String>,
    /// Per-attempt timeout (ms).
    pub timeout_ms: u32,
    /// Attempts per URL / address; the result is their median.
    pub attempts: u32,
    /// The panel also measures TCP connect time to each inbound.
    pub panel_tcp: bool,
    /// "立即测速" at most once per node per this many seconds.
    pub manual_cooldown_secs: u64,
}

pub const DEFAULT_PROBE_INTERVAL_SECS: u64 = 5 * 3600;
pub const DEFAULT_PROBE_URLS: &[&str] = &[
    "https://www.gstatic.com/generate_204",
    "https://cp.cloudflare.com/generate_204",
];

impl Default for ProbeConfig {
    fn default() -> Self {
        Self {
            interval_secs: DEFAULT_PROBE_INTERVAL_SECS,
            urls: DEFAULT_PROBE_URLS.iter().map(|u| u.to_string()).collect(),
            timeout_ms: PROBE_TIMEOUT_MS,
            attempts: PROBE_ATTEMPTS,
            panel_tcp: true,
            manual_cooldown_secs: PROBE_MANUAL_COOLDOWN_SECS,
        }
    }
}

/// How agents apply user removals/rotations (R10 fallback switch, 系统设置
/// → 节点通信 → 撤权方式): "gate" (default) = in place via UserDelta, the
/// agent's gate dispatcher closes the user's live connections; "rebuild" =
/// every removal/rotation is a full Snapshot (xray rebuild, all connections
/// on the node drop). Pushed to agents on every LeaseGrant.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoveMode {
    #[default]
    Gate,
    Rebuild,
}

impl RemoveMode {
    pub fn proto(self) -> crate::pb::RemoveMode {
        match self {
            RemoveMode::Gate => crate::pb::RemoveMode::Gate,
            RemoveMode::Rebuild => crate::pb::RemoveMode::Rebuild,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            RemoveMode::Gate => "gate",
            RemoveMode::Rebuild => "rebuild",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "gate" => Some(Self::Gate),
            "rebuild" => Some(Self::Rebuild),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The minimal file parses; obsolete keys of every older release go to
    /// `legacy` instead of failing the start; typos still fail.
    #[test]
    fn obsolete_keys_are_extracted_typos_still_fail() {
        let old = r#"
data_dir = "/var/lib/akari"
[web]
bind = "127.0.0.1:8080"
advertised_names = ["panel.example.com"]
sub_domain = "sub.example.com"
cookie_secure = true
[grpc]
bind = "0.0.0.0:8443"
advertise = "panel.example.com:8443"
server_name = "panel.example.com"
lease_seconds = 7200
[probe]
urls = ["https://example.com/204"]
[updates]
release_keys = ["abc label"]
max_concurrent_downloads = 4
[payments.alipay]
app_id = "1"
[tls_ask]
bind = "127.0.0.1:8082"
rate_per_sec = 5
"#;
        let c = PanelConfig::parse(old).unwrap();
        assert_eq!(c.grpc.bind.port(), 8443);
        assert_eq!(c.tls_ask.bind.map(|b| b.port()), Some(8082));
        let names: Vec<&str> = c.legacy.names().collect();
        assert_eq!(
            names,
            [
                "grpc.advertise",
                "grpc.lease_seconds",
                "grpc.server_name",
                "payments.*",
                "probe.urls",
                "tls_ask.rate_per_sec",
                "updates.max_concurrent_downloads",
                "updates.release_keys",
                "web.advertised_names",
                "web.sub_domain",
            ]
        );
        assert_eq!(
            c.legacy.get::<Vec<String>>("web.advertised_names"),
            Some(Ok(vec!["panel.example.com".to_string()]))
        );
        assert_eq!(c.legacy.get::<u64>("grpc.lease_seconds"), Some(Ok(7200)));
        assert!(c.legacy.get::<u64>("web.sub_domain").unwrap().is_err());
        // Typos in a kept section, an unknown section and an unknown key
        // inside an obsolete section's neighbour all still fail.
        for bad in [
            "[web]\nbnd = \"127.0.0.1:1\"",
            "[nope]\nx = 1",
            "datadir = \"x\"",
            "[probe]\nurl = [\"https://x/\"]",
        ] {
            assert!(PanelConfig::parse(bad).is_err(), "{bad}");
        }
        // The minimal example parses with nothing obsolete.
        let minimal = PanelConfig::parse(include_str!("../deploy/panel.toml.example")).unwrap();
        assert!(minimal.legacy.is_empty(), "{:?}", minimal.legacy.keys);
        let compose =
            PanelConfig::parse(include_str!("../deploy/panel.toml.compose.example")).unwrap();
        assert!(compose.legacy.is_empty());
    }

    #[test]
    fn every_obsolete_key_has_one_fate() {
        for (k, _) in OBSOLETE {
            assert!(fate(k).is_some(), "{k}");
            assert_eq!(OBSOLETE.iter().filter(|(x, _)| x == k).count(), 1, "{k}");
        }
        assert_eq!(fate("payments.alipay"), Some(Fate::Moved("支付")));
        assert_eq!(fate("web.bind"), None);
        assert_eq!(fate("grpc.lease_seconds"), Some(Fate::Constant));
    }

    #[test]
    fn test_overrides_are_bounded() {
        let mut l = Limits::default();
        l.apply_test_overrides("cert_validity_secs=60, alerts_eval_interval_secs=5")
            .unwrap();
        assert_eq!(l.cert_validity_secs, 60);
        assert_eq!(l.alerts_eval_interval_secs, 5);
        assert_eq!(l.test_overrides.len(), 2);
        for bad in [
            "cert_validity_secs=59",
            "lease_seconds=5",
            "alerts_eval_interval_secs",
            "sub_rate_per_token=0",
            "probe_manual_cooldown_secs=x",
        ] {
            assert!(
                Limits::default().apply_test_overrides(bad).is_err(),
                "{bad}"
            );
        }
        assert_eq!(Limits::default().lease_seconds(), 86_400);
    }
}
