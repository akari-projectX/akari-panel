use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct PanelConfig {
    pub data_dir: PathBuf,
    pub database_url: String,
    pub valkey_url: String,
    pub web: WebConfig,
    pub grpc: GrpcConfig,
    pub traffic: TrafficConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct TrafficConfig {
    /// Plausibility cap: the most a single (node, user, session) may be
    /// billed per second since its counters were last persisted. Excess is
    /// not billed (the counter is still stored). Default 10 Gbit/s.
    pub max_rate_bytes_per_sec: i64,
}

impl Default for TrafficConfig {
    fn default() -> Self {
        Self {
            max_rate_bytes_per_sec: 1_250_000_000,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct WebConfig {
    pub bind: SocketAddr,
    /// DNS names / IPs the auto-issued TLS certificate is valid for.
    /// Must include the name agents use to reach the gRPC endpoint.
    pub advertised_names: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct GrpcConfig {
    pub bind: SocketAddr,
    /// host:port agents dial (written into bootstrap files).
    pub advertise: String,
    /// TLS server name agents verify on the gRPC connection.
    pub server_name: String,
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
        }
    }
}

impl Default for WebConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8080".parse().unwrap(),
            advertised_names: vec!["localhost".into(), "127.0.0.1".into()],
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
