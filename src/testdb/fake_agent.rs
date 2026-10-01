//! Wire-level fake agent (Sprint 4a, S4-5): a real tonic client speaking the
//! control protocol over mutual TLS to a real panel gRPC server on an
//! ephemeral port, using a certificate issued by a throwaway CA exactly like
//! `akari node add` does.
//!
//! Complements the in-process `FakeAgent` in grpc.rs tests (which drives
//! `session()` directly, no TLS/transport): this one exercises the TLS
//! handshake, serial -> node identification and the real stream plumbing.
//!
//! The harness serves through `grpc::serve_on` (the production server on a
//! pre-bound ephemeral listener, same TLS acceptor and certificate
//! resolver).

use std::time::Duration;

use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Identity};
use tonic::{Status, Streaming};
use uuid::Uuid;

use crate::gen::agent_channel_client::AgentChannelClient;
use crate::gen::agent_enrollment_client::AgentEnrollmentClient;
use crate::gen::agent_up::Msg as UpMsg;
use crate::gen::panel_down::Msg as DownMsg;
use crate::gen::{
    ack, Ack, AgentUp, ConfigSnapshot, EnrollRequest, Hello, PanelDown, RenewRequest,
    TrafficReport, UserTraffic,
};
use crate::grpc::{state_hash, user_set, NodeState, MIN_AGENT_PROTOCOL};
use crate::state::AppState;
use crate::testdb::TestDb;

/// A running panel gRPC server (real TLS, real CA) plus the CA material
/// needed to mint agent certificates.
pub struct PanelHarness {
    pub state: AppState,
    pub addr: std::net::SocketAddr,
    ca_pem: String,
    ca_key_pem: String,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    server: tokio::task::JoinHandle<()>,
    data_dir: std::path::PathBuf,
}

impl PanelHarness {
    pub async fn start(db: &TestDb) -> Self {
        Self::start_with(db, |_| {}).await
    }

    /// With a config tweak. Enrollment rate limits are lifted (their Valkey
    /// keys are shared by concurrently running tests; enroll.rs tests the
    /// limit with private addresses).
    pub async fn start_with(
        db: &TestDb,
        tweak: impl FnOnce(&mut crate::config::PanelConfig),
    ) -> Self {
        // Process-wide, idempotent (main() does the same at startup).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let data_dir = std::env::temp_dir().join(format!("akari-fake-agent-{}", Uuid::new_v4()));
        let mut cfg = crate::config::PanelConfig {
            data_dir: data_dir.clone(),
            ..Default::default()
        };
        cfg.agent.enroll_rate_per_ip = 1_000_000;
        cfg.agent.enroll_rate_global = 1_000_000;
        tweak(&mut cfg);
        let install = crate::install::ensure(&cfg).expect("issue CA + server cert");
        let (ca_pem, ca_key_pem) = (install.ca_pem.clone(), install.ca_key_pem.clone());
        if let Ok(v) = std::env::var("VALKEY_URL") {
            cfg.valkey_url = v;
        }
        let valkey = crate::state::connect_valkey(&cfg)
            .await
            .expect("dev valkey (make dev-up)");
        let state = AppState::new(cfg, install, db.pool.clone(), valkey);
        // R22: the database settings (server name history) and the
        // hot-swappable certificate, as `serve` does at startup.
        crate::settings::init(&state).await.expect("settings init");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let st = state.clone();
        let server = tokio::spawn(async move {
            crate::grpc::serve_on(st, listener, async {
                let _ = rx.await;
            })
            .await
            .unwrap();
        });
        Self {
            state,
            addr,
            ca_pem,
            ca_key_pem,
            shutdown: Some(tx),
            server,
            data_dir,
        }
    }

    /// Mint an agent certificate and register its serial on `node` (what a
    /// v1 `akari node add` did: panel-generated key; still supported).
    pub async fn register(&self, db: &TestDb, node: Uuid) -> AgentCreds {
        let (cert, key, serial) =
            crate::install::issue_agent_cert(&self.ca_pem, &self.ca_key_pem, &node.to_string())
                .unwrap();
        sqlx::query("UPDATE nodes SET cert_serial = $2 WHERE id = $1")
            .bind(node)
            .bind(&serial)
            .execute(&db.pool)
            .await
            .unwrap();
        AgentCreds {
            cert,
            key,
            ca: self.ca_pem.clone(),
        }
    }

    /// A TLS channel to the panel, with `creds` as client certificate or
    /// none (verifying the panel's certificate either way).
    pub async fn channel(&self, creds: Option<&AgentCreds>) -> Result<Channel, Status> {
        self.channel_named(creds, "localhost").await
    }

    /// `channel`, verifying the panel certificate against `server_name`
    /// (what a bootstrap file's server_name makes an agent do).
    pub async fn channel_named(
        &self,
        creds: Option<&AgentCreds>,
        server_name: &str,
    ) -> Result<Channel, Status> {
        let mut tls = ClientTlsConfig::new()
            .ca_certificate(Certificate::from_pem(&self.ca_pem))
            .domain_name(server_name);
        if let Some(c) = creds {
            tls = tls
                .ca_certificate(Certificate::from_pem(&c.ca))
                .identity(Identity::from_pem(&c.cert, &c.key));
        }
        Channel::from_shared(format!("https://{}", self.addr))
            .unwrap()
            .tls_config(tls)
            .map_err(|e| Status::unavailable(e.to_string()))?
            .connect()
            .await
            .map_err(|e| Status::unavailable(e.to_string()))
    }

    /// AgentEnrollment.Enroll without a client certificate, for a fresh
    /// P-256 key; returns the credentials an agent would store.
    pub async fn enroll(&self, token: &str) -> Result<AgentCreds, Status> {
        let key = rcgen::KeyPair::generate().unwrap();
        let csr = rcgen::CertificateParams::default()
            .serialize_request(&key)
            .unwrap();
        let mut client = AgentEnrollmentClient::new(self.channel(None).await?);
        let issued = client
            .enroll(EnrollRequest {
                token: token.into(),
                csr_der: csr.der().to_vec(),
            })
            .await?
            .into_inner();
        Ok(AgentCreds {
            cert: issued.cert_pem,
            key: key.serialize_pem(),
            ca: issued.ca_pem,
        })
    }

    /// AgentChannel.Renew with `creds` (None: no client certificate) for a
    /// fresh key.
    pub async fn renew(&self, creds: Option<&AgentCreds>) -> Result<AgentCreds, Status> {
        let key = rcgen::KeyPair::generate().unwrap();
        let csr = rcgen::CertificateParams::default()
            .serialize_request(&key)
            .unwrap();
        let mut client = AgentChannelClient::new(self.channel(creds).await?);
        let issued = client
            .renew(RenewRequest {
                csr_der: csr.der().to_vec(),
            })
            .await?
            .into_inner();
        Ok(AgentCreds {
            cert: issued.cert_pem,
            key: key.serialize_pem(),
            ca: issued.ca_pem,
        })
    }

    /// Open the channel without a client certificate (must be refused).
    pub async fn connect_anonymous(&self) -> Result<WireAgent, Status> {
        self.open(self.channel(None).await?).await
    }

    /// Dial the panel as an agent with `creds` and open the channel. Errors
    /// (TLS refusal, unauthenticated) come back as a `Status`.
    pub async fn connect(&self, creds: &AgentCreds) -> Result<WireAgent, Status> {
        self.connect_named(creds, "localhost").await
    }

    /// `connect`, verifying the panel certificate against `server_name`.
    pub async fn connect_named(
        &self,
        creds: &AgentCreds,
        server_name: &str,
    ) -> Result<WireAgent, Status> {
        let tls = ClientTlsConfig::new()
            .ca_certificate(Certificate::from_pem(&creds.ca))
            .identity(Identity::from_pem(&creds.cert, &creds.key))
            .domain_name(server_name);
        let channel = Channel::from_shared(format!("https://{}", self.addr))
            .unwrap()
            .tls_config(tls)
            .map_err(|e| Status::unavailable(e.to_string()))?
            .connect()
            .await
            .map_err(|e| Status::unavailable(e.to_string()))?;
        self.open(channel).await
    }

    async fn open(&self, channel: Channel) -> Result<WireAgent, Status> {
        let mut client = AgentChannelClient::new(channel);
        let (up, up_rx) = mpsc::channel(64);
        let down = client
            .open_channel(ReceiverStream::new(up_rx))
            .await?
            .into_inner();
        Ok(WireAgent {
            up,
            down,
            session_id: "s1".into(),
        })
    }

    /// AgentChannel.FetchArtifact (M6): the whole stream's bytes.
    pub async fn fetch(
        &self,
        creds: Option<&AgentCreds>,
        sha256: &str,
        offset: u64,
    ) -> Result<Vec<u8>, Status> {
        let mut client = AgentChannelClient::new(self.channel(creds).await?);
        let mut stream = client
            .fetch_artifact(crate::gen::FetchArtifactRequest {
                sha256: sha256.into(),
                offset,
            })
            .await?
            .into_inner();
        let mut out = Vec::new();
        while let Some(c) = stream.message().await? {
            out.extend_from_slice(&c.data);
        }
        Ok(out)
    }

    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        // Graceful shutdown waits for open streams; don't.
        self.server.abort();
        let _ = (&mut self.server).await;
        std::fs::remove_dir_all(&self.data_dir).ok();
    }
}

pub struct AgentCreds {
    pub cert: String,
    pub key: String,
    pub ca: String,
}

impl std::fmt::Debug for AgentCreds {
    // Never print key material, even in tests.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AgentCreds { .. }")
    }
}

/// Scriptable agent end of the stream. Methods mirror what a real agent
/// sends; nothing is automatic, so tests control ordering precisely.
pub struct WireAgent {
    up: mpsc::Sender<AgentUp>,
    down: Streaming<PanelDown>,
    pub session_id: String,
}

impl WireAgent {
    async fn send(&self, m: UpMsg) {
        self.up.send(AgentUp { msg: Some(m) }).await.unwrap();
    }

    pub async fn hello(&self, held: (u64, u64), hash: String) {
        self.hello_v(held, hash, MIN_AGENT_PROTOCOL).await
    }

    pub async fn hello_v(&self, held: (u64, u64), hash: String, protocol: u32) {
        self.send(UpMsg::Hello(Hello {
            session_id: self.session_id.clone(),
            config_version: held.0,
            user_version: held.1,
            protocol_version: protocol,
            state_hash: hash,
            ..Default::default()
        }))
        .await;
    }

    /// Hello with agent info (M6: version and platform drive updates).
    pub async fn hello_as(&self, held: (u64, u64), hash: String, protocol: u32, version: &str) {
        self.send(UpMsg::Hello(Hello {
            session_id: self.session_id.clone(),
            config_version: held.0,
            user_version: held.1,
            protocol_version: protocol,
            state_hash: hash,
            info: Some(crate::gen::AgentInfo {
                agent_version: version.into(),
                core_version: "test".into(),
                os: "linux".into(),
                arch: "amd64".into(),
            }),
        }))
        .await;
    }

    pub async fn update_status(&self, s: crate::gen::UpdateStatus) {
        self.send(UpMsg::UpdateStatus(s)).await;
    }

    /// Ack the snapshot as successfully applied, with the correct state hash.
    pub async fn ack_snapshot(&self, s: &ConfigSnapshot) {
        let v = (s.config_version, s.user_version);
        self.send(UpMsg::Ack(Ack {
            config_version: v.0,
            user_version: v.1,
            ok: true,
            reason: ack::Reason::Ok as i32,
            held_config_version: v.0,
            held_user_version: v.1,
            state_hash: snapshot_hash(s),
            error: String::new(),
        }))
        .await;
    }

    /// Cumulative counters for `user` in this session.
    pub async fn traffic(&self, user: Uuid, up: u64, down: u64) {
        self.send(UpMsg::Traffic(TrafficReport {
            users: vec![UserTraffic {
                user_id: user.to_string(),
                up_bytes: up,
                down_bytes: down,
            }],
            session_id: self.session_id.clone(),
            ..Default::default()
        }))
        .await;
    }

    /// Next panel message that is not a LeaseGrant; `None` when the stream
    /// ended cleanly, `Err` when it ended with a status.
    pub async fn next(&mut self) -> Option<Result<DownMsg, Status>> {
        loop {
            let m = tokio::time::timeout(Duration::from_secs(15), self.down.message())
                .await
                .expect("panel went silent");
            match m {
                Err(st) => return Some(Err(st)),
                Ok(None) => return None,
                Ok(Some(PanelDown {
                    msg: Some(DownMsg::Lease(_)),
                })) => continue,
                Ok(Some(PanelDown { msg: Some(m) })) => return Some(Ok(m)),
                Ok(Some(PanelDown { msg: None })) => continue,
            }
        }
    }

    pub async fn snapshot(&mut self) -> ConfigSnapshot {
        match self.next().await {
            Some(Ok(DownMsg::Snapshot(s))) => s,
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }
}

pub fn snapshot_hash(s: &ConfigSnapshot) -> String {
    state_hash(
        s.config_version,
        &NodeState {
            inbounds: s.inbounds_json.clone(),
            users: user_set(&s.users),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// connect -> Hello -> Snapshot -> Ack -> Traffic -> billed, over real
    /// mTLS on an ephemeral port.
    #[tokio::test]
    async fn connect_snapshot_ack_traffic_billed() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let panel = PanelHarness::start(&db).await;
        let creds = panel.register(&db, n).await;

        let mut agent = panel.connect(&creds).await.expect("mTLS handshake");
        agent.hello((0, 0), String::new()).await;
        let snap = agent.snapshot().await;
        assert_eq!(snap.users.len(), 1);
        assert_eq!(snap.users[0].user_id, u.to_string());
        agent.ack_snapshot(&snap).await;
        agent.traffic(u, 100, 50).await;

        // Reports are buffered, then persisted by the flusher; flush now.
        let mut billed = 0;
        for _ in 0..100 {
            crate::traffic::flush_node(&panel.state, n).await.unwrap();
            billed = db.used(u).await;
            if billed > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(billed, 150);
        panel.stop().await;
        db.drop().await;
    }

    /// A certificate from another CA, or an unregistered serial, never gets
    /// a working channel.
    #[tokio::test]
    async fn foreign_and_unregistered_certs_are_refused() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, _u) = db.member().await;
        let panel = PanelHarness::start(&db).await;
        let good = panel.register(&db, n).await;
        // Positive control: the same setup serves a registered cert, so the
        // refusals below are about the certificates, not the harness.
        let mut ok = panel
            .connect(&good)
            .await
            .expect("registered cert connects");
        ok.hello((0, 0), String::new()).await;
        ok.snapshot().await;

        // Valid CA, serial registered nowhere.
        let (cert, key, _serial) =
            crate::install::issue_agent_cert(&panel.ca_pem, &panel.ca_key_pem, "ghost").unwrap();
        let ghost = AgentCreds {
            cert,
            key,
            ca: good.ca.clone(),
        };
        let refused = match panel.connect(&ghost).await {
            Err(st) => st.code() == tonic::Code::Unauthenticated,
            Ok(mut a) => {
                a.hello((0, 0), String::new()).await;
                matches!(a.next().await, Some(Err(st)) if st.code() == tonic::Code::Unauthenticated)
            }
        };
        assert!(refused, "unknown serial must be Unauthenticated");

        // Different CA altogether: the TLS handshake fails.
        let other = PanelHarness::start(&db).await;
        let foreign = other.register(&db, n).await;
        let refused = match panel.connect(&foreign).await {
            Err(_) => true,
            Ok(mut a) => {
                a.hello((0, 0), String::new()).await;
                matches!(a.next().await, Some(Err(_)))
            }
        };
        assert!(refused, "foreign CA must not be served");
        other.stop().await;
        panel.stop().await;
        db.drop().await;
    }
}
