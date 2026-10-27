//! `panel.toml` (R39/W25): only what the process needs to start — data
//! directory, database, Valkey, listeners. Everything an operator changes
//! at runtime lives in the database (系统设置, `settings.rs`); internal
//! tuning knobs are built-in constants (`Limits`). There is no file
//! fallback and no precedence merging. The parse is strict
//! (`deny_unknown_fields`): any other key is an error.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

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

    /// Parse a panel.toml strictly (unknown keys are errors).
    pub fn parse(text: &str) -> Result<Self> {
        Ok(toml::from_str(text)?)
    }
}

// ---------------------------------------------------------------------------
// Built-in constants (src/CLAUDE.md)
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

/// The Cloudflare API root every DNS call goes to (`dns::cloudflare`).
pub const CLOUDFLARE_API_BASE: &str = "https://api.cloudflare.com/client/v4";

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
    /// Remote rule-sets may be downloaded over plain http from 127.0.0.1
    /// (smoke's fixture server; `sub::rulesets::fetch`). Never in
    /// production: the SSRF guard refuses loopback otherwise.
    pub rule_set_fetch_loopback: bool,
    /// The Cloudflare API root (`dns::cloudflare`). Tests point it at a
    /// loopback mock through `cloudflare_mock_port`; production never
    /// leaves the default.
    pub cloudflare_api_base: String,
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
            rule_set_fetch_loopback: false,
            cloudflare_api_base: CLOUDFLARE_API_BASE.to_string(),
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
        ("rule_set_fetch_loopback", 0, 1),
        // 0 = off; otherwise the Cloudflare API is the mock on
        // http://127.0.0.1:<port> (`dns::cloudflare`).
        ("cloudflare_mock_port", 0, 65_535),
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
                "rule_set_fetch_loopback" => self.rule_set_fetch_loopback = v == 1,
                "cloudflare_mock_port" if v > 0 => {
                    self.cloudflare_api_base = format!("http://127.0.0.1:{v}/client/v4");
                }
                "cloudflare_mock_port" => {}
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

    /// The shipped examples parse; any other key (a typo, a key that moved
    /// to 系统设置) fails the start.
    #[test]
    fn unknown_keys_fail() {
        PanelConfig::parse(include_str!("../deploy/panel.toml.example")).unwrap();
        PanelConfig::parse(include_str!("../deploy/panel.toml.compose.example")).unwrap();
        for bad in [
            "[web]\nbnd = \"127.0.0.1:1\"",
            "[nope]\nx = 1",
            "datadir = \"x\"",
            "[grpc]\nadvertise = \"panel.example.com:8443\"",
            "[probe]\nurls = [\"https://x/\"]",
            "[payments.alipay]\napp_id = \"1\"",
        ] {
            assert!(PanelConfig::parse(bad).is_err(), "{bad}");
        }
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
