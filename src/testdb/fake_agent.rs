//! Wire-level fake agent (Sprint 4a, S4-5): a real tonic client speaking the
//! control protocol over mutual TLS to a real panel gRPC server on an
//! ephemeral port, using a certificate issued by a throwaway CA exactly like
//! `akari node add` does.
//!
//! Complements the in-process `FakeAgent` in grpc.rs tests (which drives
//! `session()` directly, no TLS/transport): this one exercises the TLS
//! handshake, serial -> node identification and the real stream plumbing.
//!
//! Seam note: `grpc::serve` binds `cfg.grpc.bind` and cannot report the bound
//! port, so `PanelHarness` reimplements its ~10 lines on a pre-bound
//! ephemeral listener (same `AgentChannelService`, same TLS config). If
//! `serve` is ever changed, keep `PanelHarness::start` in sync (or make
//! `serve` accept a listener).

use std::time::Duration;

use tokio::sync::mpsc;
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Identity, Server, ServerTlsConfig};
use tonic::{Status, Streaming};
use uuid::Uuid;

use crate::gen::agent_channel_client::AgentChannelClient;
use crate::gen::agent_channel_server::AgentChannelServer;
use crate::gen::agent_up::Msg as UpMsg;
use crate::gen::panel_down::Msg as DownMsg;
use crate::gen::{ack, Ack, AgentUp, ConfigSnapshot, Hello, PanelDown, TrafficReport, UserTraffic};
use crate::grpc::{state_hash, user_set, AgentChannelService, NodeState, MIN_AGENT_PROTOCOL};
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
        // Process-wide, idempotent (main() does the same at startup).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let data_dir = std::env::temp_dir().join(format!("akari-fake-agent-{}", Uuid::new_v4()));
        let cfg = crate::config::PanelConfig {
            data_dir: data_dir.clone(),
            ..Default::default()
        };
        let install = crate::install::ensure(&cfg).expect("issue CA + server cert");
        let (ca_pem, ca_key_pem) = (install.ca_pem.clone(), install.ca_key_pem.clone());
        let mut cfg = cfg;
        if let Ok(v) = std::env::var("VALKEY_URL") {
            cfg.valkey_url = v;
        }
        let valkey = crate::state::connect_valkey(&cfg)
            .await
            .expect("dev valkey (make dev-up)");
        let tls = ServerTlsConfig::new()
            .identity(Identity::from_pem(
                &install.server_cert_pem,
                &install.server_key_pem,
            ))
            .client_ca_root(Certificate::from_pem(&install.ca_pem));
        let state = AppState::new(cfg, install, db.pool.clone(), valkey);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let svc = AgentChannelService {
            state: state.clone(),
        };
        let server = tokio::spawn(async move {
            Server::builder()
                .tls_config(tls)
                .unwrap()
                .add_service(AgentChannelServer::new(svc))
                .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
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

    /// Mint an agent certificate and register its serial on `node`
    /// (what `akari node add` does).
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

    /// Dial the panel as an agent with `creds` and open the channel. Errors
    /// (TLS refusal, unauthenticated) come back as a `Status`.
    pub async fn connect(&self, creds: &AgentCreds) -> Result<WireAgent, Status> {
        let tls = ClientTlsConfig::new()
            .ca_certificate(Certificate::from_pem(&creds.ca))
            .identity(Identity::from_pem(&creds.cert, &creds.key))
            .domain_name("localhost");
        let channel = Channel::from_shared(format!("https://{}", self.addr))
            .unwrap()
            .tls_config(tls)
            .map_err(|e| Status::unavailable(e.to_string()))?
            .connect()
            .await
            .map_err(|e| Status::unavailable(e.to_string()))?;
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
        self.send(UpMsg::Hello(Hello {
            session_id: self.session_id.clone(),
            config_version: held.0,
            user_version: held.1,
            protocol_version: MIN_AGENT_PROTOCOL,
            state_hash: hash,
            ..Default::default()
        }))
        .await;
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
