use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PanelConfig {
    pub data_dir: PathBuf,
    pub database_url: String,
    pub valkey_url: String,
    pub web: WebConfig,
    pub grpc: GrpcConfig,
    pub traffic: TrafficConfig,
    pub agent: AgentConfig,
    pub metrics: MetricsConfig,
    pub audit: AuditConfig,
    pub sub: SubConfig,
    pub updates: UpdatesConfig,
    pub install: InstallConfig,
    /// OBSOLETE (W24): `[payments.alipay]` moved to 系统设置 → 支付 (database
    /// only). Kept as an opaque value so an old panel.toml still starts:
    /// imported once into an empty database configuration
    /// (`billing::settings::import_legacy`), otherwise ignored with a
    /// warning. Never serialized (`config check` reports it as obsolete).
    #[serde(skip_serializing)]
    pub payments: Option<toml::Value>,
    pub auth: AuthConfig,
    pub tls_ask: TlsAskConfig,
    pub probe: ProbeConfig,
    pub acme: AcmeConfig,
    pub alerts: AlertsConfig,
}

/// W17 node alerts (`alerts/`): the evaluator/delivery cadence and the
/// Telegram Bot API base. Thresholds and channels are 告警设置 in the
/// database (`alert_settings`), not here.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AlertsConfig {
    /// Seconds between evaluation rounds (one instance at a time) and
    /// notification deliveries (every instance). Default 30; 5..=600.
    pub eval_interval_secs: u64,
    /// Telegram Bot API base URL (https; http only to loopback, tests).
    /// Default "https://api.telegram.org".
    pub telegram_api_url: String,
}

impl Default for AlertsConfig {
    fn default() -> Self {
        Self {
            eval_interval_secs: 30,
            telegram_api_url: "https://api.telegram.org".into(),
        }
    }
}

/// Automatic node certificates (W10, agent protocol 6): what the panel
/// tells agents of nodes with a TLS domain (ConfigSnapshot.acme). The agent
/// does the ACME work itself.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AcmeConfig {
    /// ACME directory URL; empty = Let's Encrypt production. Staging:
    /// "https://acme-staging-v02.api.letsencrypt.org/directory". Takes
    /// effect on each node's next Snapshot.
    pub directory_url: String,
    /// Optional contact e-mail of the agents' ACME accounts (expiry notices
    /// from the CA).
    pub email: String,
}

/// W11 latency tests (`nodestat.rs`): the agents' url-test from their own
/// egress (sent to agents with capability "latency") and the panel's TCP
/// connect test to every inbound's client-facing address, both on this
/// schedule (+-10% jitter).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProbeConfig {
    /// Seconds between scheduled tests. Default 18000 (5 h); 600..=604800.
    pub interval_secs: u64,
    /// Test URLs (http/https, at most 4), primary first; later ones are
    /// fallbacks when the earlier fail.
    pub urls: Vec<String>,
    /// Per-attempt timeout. Default 5000 ms; 1000..=30000.
    pub timeout_ms: u32,
    /// Attempts per URL / address; the result is their median. Default 3; 1..=5.
    pub attempts: u32,
    /// The panel also measures TCP connect time to each inbound. Default true.
    pub panel_tcp: bool,
    /// "立即测速" at most once per node per this many seconds. Default 30.
    pub manual_cooldown_secs: u64,
}

impl Default for ProbeConfig {
    fn default() -> Self {
        Self {
            interval_secs: 5 * 3600,
            urls: vec![
                "https://www.gstatic.com/generate_204".into(),
                "https://cp.cloudflare.com/generate_204".into(),
            ],
            timeout_ms: 5000,
            attempts: 3,
            panel_tcp: true,
            manual_cooldown_secs: 30,
        }
    }
}

/// Caddy on-demand TLS `ask` endpoint (R22): `GET /ask?domain=<name>`
/// answers 200 only for the configured main/subscription domains, so the
/// reverse proxy obtains certificates for them without Caddyfile edits.
/// Served on its OWN listener (never the public web port; like metrics).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct TlsAskConfig {
    /// Listen address; unset = disabled. Loopback unless
    /// `allow_non_loopback` (compose: Caddy reaches it on the private
    /// frontend network).
    pub bind: Option<SocketAddr>,
    pub allow_non_loopback: bool,
    /// Requests answered per second by this instance (CPU guard; more get
    /// a refusal, which Caddy treats as "no certificate"). Default 20.
    pub rate_per_sec: u32,
}

impl Default for TlsAskConfig {
    fn default() -> Self {
        Self {
            bind: None,
            allow_non_loopback: false,
            rate_per_sec: 20,
        }
    }
}

/// One-line node installer (R18-2, `nodeinstall.rs`).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct InstallConfig {
    /// Public origin of the panel's web endpoint as nodes reach it
    /// ("https://panel.example.com" or "https://203.0.113.7", no path; the
    /// route prefix is appended). Empty = the origin of the admin's browser
    /// (sent by the UI when it asks for an install command).
    pub public_url: String,
    /// SPKI pin of the web endpoint's TLS certificate for the install
    /// command ("sha256//<base64>", curl --pinnedpubkey). Empty = automatic:
    /// the panel connects to the public origin when it issues a command; a
    /// certificate public CAs vouch for needs no pin, any other one (IP-only
    /// panel with Caddy's internal CA) is pinned as served.
    pub tls_pin: String,
    /// Lifetime of an install link (its enrollment token). Default 1 h;
    /// 5 min to 7 days.
    pub token_ttl_secs: u64,
    /// Install-script and agent-binary downloads per source address (IPv6
    /// per /64) per window. Defaults 20 per 600 s.
    pub rate_per_ip: i64,
    pub rate_window_secs: i64,
    /// Where the script downloads the agent when no complete signed
    /// release for the node's architecture was uploaded to the panel
    /// (Updates view). `{arch}` = amd64 | arm64; `SHA256SUMS` next to it
    /// (same directory) is checked. Empty = no fallback (the script stops
    /// with a clear error).
    pub fallback_binary_url: String,
}

pub const DEFAULT_FALLBACK_BINARY_URL: &str =
    "https://github.com/akari-projectX/akari-agent/releases/latest/download/akari-agent-linux-{arch}";

impl Default for InstallConfig {
    fn default() -> Self {
        Self {
            public_url: String::new(),
            tls_pin: String::new(),
            token_ttl_secs: 3600,
            rate_per_ip: 20,
            rate_window_secs: 600,
            fallback_binary_url: DEFAULT_FALLBACK_BINARY_URL.into(),
        }
    }
}

/// Login policy (R18).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AuthConfig {
    /// Admins without an active TOTP only get an enrollment-only session
    /// (15 min, reaches nothing but the /me/totp endpoints) until they set
    /// one up. Default false: 2FA is optional (recommended in the console)
    /// for every account.
    pub require_admin_2fa: bool,
}

/// Agent self-update (M6). The panel only relays signed releases; agents
/// verify them under keys compiled into the agent. The panel checks the
/// same signatures (keys below) before it stores or offers a release, so a
/// mistaken upload is refused early.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct UpdatesConfig {
    /// Ed25519 release public keys, "<base64> [label]" (the lines of the
    /// agent's release-keys.txt). Empty = uploads refused (feature off).
    pub release_keys: Vec<String>,
    /// Concurrent artifact downloads (AgentChannel.FetchArtifact) served by
    /// this instance; more get RESOURCE_EXHAUSTED and retry. Default 8.
    pub max_concurrent_downloads: usize,
}

impl Default for UpdatesConfig {
    fn default() -> Self {
        Self {
            release_keys: Vec::new(),
            max_concurrent_downloads: 8,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AuditConfig {
    /// Audit rows older than this are pruned (hourly). 0 = keep forever.
    /// Default 365.
    pub retention_days: u32,
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            retention_days: 365,
        }
    }
}

/// Subscription endpoint rate limit (M1-10). Over a limit the endpoint
/// answers the canonical rejection (indistinguishable from a bad token).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SubConfig {
    /// Requests per client address (IPv6 per /64) per window. Default 120.
    pub rate_per_ip: i64,
    /// Requests per (valid) token per window. Default 30.
    pub rate_per_token: i64,
    /// Fixed window length. Default 600 s.
    pub rate_window_secs: i64,
}

impl Default for SubConfig {
    fn default() -> Self {
        Self {
            rate_per_ip: 120,
            rate_per_token: 30,
            rate_window_secs: 600,
        }
    }
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AgentConfig {
    /// How agents apply user removals/rotations (R10 fallback switch):
    /// "gate" (default) = in place via UserDelta, the agent's gate
    /// dispatcher closes the user's live connections; "rebuild" = every
    /// removal/rotation is a full Snapshot (xray rebuild, all connections on
    /// the node drop). Pushed to agents on every LeaseGrant.
    pub remove_mode: RemoveMode,
    /// Validity of agent client certificates (M1-8). Protocol >= 2 agents
    /// renew when less than a third is left. Default 90 days; 60 s to 825
    /// days.
    pub cert_validity_secs: u64,
    /// Lifetime of a node enrollment token. Default 24 h; 5 min to 7 days.
    pub enroll_token_ttl_secs: u64,
    /// Enrollment RPC rate limit (Valkey fixed windows): calls per source
    /// address (IPv6 per /64) and over all sources, per window. Defaults
    /// 10 and 60 per 600 s.
    pub enroll_rate_per_ip: i64,
    pub enroll_rate_global: i64,
    pub enroll_rate_window_secs: i64,
}

pub const DEFAULT_CERT_VALIDITY_SECS: u64 = 90 * 86400;

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            remove_mode: RemoveMode::default(),
            cert_validity_secs: DEFAULT_CERT_VALIDITY_SECS,
            enroll_token_ttl_secs: 86400,
            enroll_rate_per_ip: 10,
            enroll_rate_global: 60,
            enroll_rate_window_secs: 600,
        }
    }
}

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
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct TrafficConfig {
    /// Plausibility cap: the most a single (node, user, session) may be
    /// billed per second since its counters were last persisted. Excess is
    /// not billed (the counter is still stored). Default 10 Gbit/s.
    pub max_rate_bytes_per_sec: i64,
    /// Per-node aggregate plausibility cap: the most one node may bill per
    /// second, summed over all its users and sessions, measured against
    /// nodes.traffic_flushed_at (DB). A node's
    /// traffic_max_rate_bytes_per_sec overrides it. Default 10 Gbit/s.
    pub node_max_rate_bytes_per_sec: i64,
    /// Burst window of the billing caps (R13): a node (or row) is credited
    /// at most this much elapsed time, except for a recorded reconnect gap
    /// (then up to the lease, once). Default 120 s.
    pub node_burst_secs: u64,
    /// How long after an unassignment the user's final counters from that
    /// node are still billed (node_users_departed). Default 15 min.
    pub departed_grace_secs: u64,
    /// W22: days of per-day traffic history (traffic_daily) kept before the
    /// retention pass rolls them up into months (traffic_monthly). 0 = keep
    /// days forever. Default 400; otherwise at least 32.
    pub daily_retention_days: u32,
}

pub const DEFAULT_NODE_BURST_SECS: u64 = 120;

impl Default for TrafficConfig {
    fn default() -> Self {
        Self {
            max_rate_bytes_per_sec: 1_250_000_000,
            node_max_rate_bytes_per_sec: 1_250_000_000,
            node_burst_secs: DEFAULT_NODE_BURST_SECS,
            departed_grace_secs: crate::traffic::DEFAULT_DEPARTED_GRACE_SECS,
            daily_retention_days: crate::traffic::DEFAULT_DAILY_RETENTION_DAYS,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct WebConfig {
    pub bind: SocketAddr,
    /// DNS names / IPs the auto-issued TLS certificate is valid for.
    /// Must include the name agents use to reach the gRPC endpoint.
    pub advertised_names: Vec<String>,
    /// Reverse proxies in front of the panel (CIDRs or addresses). Only
    /// when the TCP peer is one of them is X-Forwarded-For consulted: the
    /// client is the rightmost hop that is not a trusted proxy. Default
    /// empty: the TCP peer is the client, headers are ignored.
    pub trusted_proxies: Vec<crate::client_ip::Cidr>,
    /// `Secure` attribute of the session cookie. Default true (browsers
    /// then only send it over HTTPS — put the panel behind a TLS proxy);
    /// set false only for plain-HTTP development.
    pub cookie_secure: bool,
    /// R22: initial subscription domain (host[:port]) shown in
    /// subscription links; the admin "系统设置" value (database) wins once
    /// set. Empty = the main domain.
    pub sub_domain: String,
    /// R22: initial "trust Cloudflare" (Cloudflare's edge ranges count as
    /// trusted proxies, CF-Connecting-IP is honoured behind them); the
    /// database setting wins once set. Default false.
    pub trust_cloudflare: bool,
    /// Cloudflare edge ranges; empty = the list shipped in the binary
    /// (src/cloudflare_ips.txt). Set to follow a Cloudflare change without
    /// a new release (docs/DEPLOY.md "Cloudflare").
    pub cloudflare_ranges: Vec<crate::client_ip::Cidr>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct GrpcConfig {
    pub bind: SocketAddr,
    /// host:port agents dial (written into bootstrap files).
    pub advertise: String,
    /// TLS server name agents verify on the gRPC connection.
    pub server_name: String,
    /// Fail-closed lease granted to agents after every successful read of
    /// their desired state (default 24h; agents clamp to >= 1h). An agent
    /// that hears nothing for this long stops xray.
    pub lease_seconds: u64,
}

impl GrpcConfig {
    /// The lease actually granted: [1h, 30d].
    pub fn lease_seconds(&self) -> u64 {
        self.lease_seconds.clamp(3600, 30 * 86400)
    }
}

impl Default for PanelConfig {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("./data"),
            database_url: "postgres://akari:akari-dev@localhost:5432/akari".into(),
            valkey_url: "redis://127.0.0.1:6379".into(),
            web: WebConfig::default(),
            grpc: GrpcConfig::default(),
            traffic: TrafficConfig::default(),
            agent: AgentConfig::default(),
            metrics: MetricsConfig::default(),
            audit: AuditConfig::default(),
            sub: SubConfig::default(),
            updates: UpdatesConfig::default(),
            install: InstallConfig::default(),
            payments: None,
            auth: AuthConfig::default(),
            tls_ask: TlsAskConfig::default(),
            probe: ProbeConfig::default(),
            acme: AcmeConfig::default(),
            alerts: AlertsConfig::default(),
        }
    }
}

impl Default for WebConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8080".parse().unwrap(),
            advertised_names: vec!["localhost".into(), "127.0.0.1".into()],
            trusted_proxies: Vec::new(),
            cookie_secure: true,
            sub_domain: String::new(),
            trust_cloudflare: false,
            cloudflare_ranges: Vec::new(),
        }
    }
}

impl Default for GrpcConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8443".parse().unwrap(),
            // Explicit IP: "localhost" resolves to ::1 on many systems while
            // the default bind is IPv4, which silently refuses connections.
            advertise: "127.0.0.1:8443".into(),
            server_name: "localhost".into(),
            lease_seconds: 86400,
        }
    }
}

impl PanelConfig {
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let mut cfg = match path {
            Some(p) => toml::from_str(&std::fs::read_to_string(p)?)?,
            None => PanelConfig::default(),
        };
        // Environment wins over file for secrets/endpoints.
        if let Ok(v) = std::env::var("DATABASE_URL") {
            cfg.database_url = v;
        }
        if let Ok(v) = std::env::var("VALKEY_URL") {
            cfg.valkey_url = v;
        }
        Ok(cfg)
    }
}
