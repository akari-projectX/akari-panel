use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;

use tokio::sync::mpsc;
use tokio_stream::{wrappers::ReceiverStream, Stream, StreamExt};
use tonic::transport::{Certificate, Identity, ServerTlsConfig};
use tonic::{Request, Response, Status, Streaming};
use uuid::Uuid;
use x509_parser::prelude::*;

use crate::gen::agent_channel_server::{AgentChannel, AgentChannelServer};
use crate::gen::panel_down::Msg as DownMsg;
use crate::gen::user_op::Op as UserOpKind;
use crate::gen::{AgentUp, ConfigSnapshot, Heartbeat, InboundUser, PanelDown, UserOp};
use crate::state::AppState;
use crate::valkey_util;

pub struct AgentChannelService {
    pub state: AppState,
}

type DownStream = Pin<Box<dyn Stream<Item = Result<PanelDown, Status>> + Send>>;

#[tonic::async_trait]
impl AgentChannel for AgentChannelService {
    type OpenChannelStream = DownStream;

    async fn open_channel(
        &self,
        request: Request<Streaming<AgentUp>>,
    ) -> Result<Response<DownStream>, Status> {
        let state = self.state.clone();

        // Identity comes exclusively from the mTLS client certificate;
        // there is no token or credential in the protocol itself.
        let node_id = identify_node(&state, &request).await?;

        let enabled: Option<bool> = sqlx::query_scalar("SELECT enabled FROM nodes WHERE id = $1")
            .bind(node_id)
            .fetch_optional(state.pg())
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        match enabled {
            Some(true) => {}
            Some(false) => return Err(Status::permission_denied("node disabled")),
            None => return Err(Status::unauthenticated("unknown node")),
        }

        let (tx, rx) = mpsc::channel::<Result<PanelDown, Status>>(64);
        tokio::spawn(session(state.clone(), node_id, request.into_inner(), tx));
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}

/// Maps the peer certificate serial to a registered node.
async fn identify_node(
    state: &AppState,
    req: &Request<Streaming<AgentUp>>,
) -> Result<Uuid, Status> {
    let certs = req
        .peer_certs()
        .ok_or_else(|| Status::unauthenticated("missing client certificate"))?;
    let der = certs
        .first()
        .ok_or_else(|| Status::unauthenticated("missing client certificate"))?;
    let (_, cert) = X509Certificate::from_der(der.as_ref())
        .map_err(|_| Status::unauthenticated("malformed certificate"))?;
    let serial = hex::encode(cert.serial.to_bytes_be());

    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM nodes WHERE cert_serial = $1")
        .bind(&serial)
        .fetch_optional(state.pg())
        .await
        .map_err(|e| Status::internal(e.to_string()))?;
    id.ok_or_else(|| Status::unauthenticated("unknown certificate"))
}

/// The agent's last-reported held versions (from Hello and Ack messages),
/// shared between the stream reader and the config-change watcher.
#[derive(Default)]
struct AgentVersions {
    config_version: Mutex<u64>,
    user_version: Mutex<u64>,
}

impl AgentVersions {
    fn set(&self, config_version: u64, user_version: u64) {
        *self.config_version.lock().unwrap() = config_version;
        *self.user_version.lock().unwrap() = user_version;
    }
    fn get(&self) -> (u64, u64) {
        (
            *self.config_version.lock().unwrap(),
            *self.user_version.lock().unwrap(),
        )
    }
}

async fn session(
    state: AppState,
    node_id: Uuid,
    mut inbound: Streaming<AgentUp>,
    tx: mpsc::Sender<Result<PanelDown, Status>>,
) {
    use crate::gen::agent_up::Msg as UpMsg;

    tracing::info!(node = %node_id, "agent connected");
    let gen = state.next_gen();
    state.agents().insert(node_id, gen);

    let versions = Arc::new(AgentVersions::default());

    // Push snapshots whenever panel-side configuration changes.
    let watcher_state = state.clone();
    let watcher_tx = tx.clone();
    let watcher_versions = versions.clone();
    let mut watch_rx = state.subscribe_changes();
    let watcher = tokio::spawn(async move {
        while watch_rx.changed().await.is_ok() {
            if let Err(e) =
                sync_if_stale(&watcher_state, node_id, &watcher_versions, &watcher_tx).await
            {
                tracing::warn!(node = %node_id, error = %e, "config push failed");
            }
        }
    });

    let result: Result<(), Status> = async {
        while let Some(msg) = inbound.next().await {
            let msg = msg?;
            match msg.msg {
                Some(UpMsg::Hello(hello)) => {
                    tracing::info!(node = %node_id, session = %hello.session_id, "agent hello");
                    versions.set(hello.config_version, hello.user_version);
                    mark_online(&state, node_id, &hello).await;
                    if let Err(e) = sync_if_stale(&state, node_id, &versions, &tx).await {
                        tracing::warn!(node = %node_id, error = %e, "failed to send snapshot");
                    }
                }
                Some(UpMsg::Heartbeat(hb)) => {
                    store_heartbeat(&state, node_id, &hb).await;
                }
                Some(UpMsg::Traffic(report)) => {
                    // Billed per the session the report carries; the agent
                    // reads it atomically with the counters (REVIEW P0 #2).
                    state.traffic().update(node_id, &report.session_id, &report);
                }
                Some(UpMsg::Ack(ack)) => {
                    tracing::debug!(
                        node = %node_id,
                        ok = ack.ok,
                        error = %ack.error,
                        config_version = ack.config_version,
                        user_version = ack.user_version,
                        "agent ack"
                    );
                    versions.set(ack.config_version, ack.user_version);
                    if !ack.ok {
                        tracing::warn!(
                            node = %node_id,
                            error = %ack.error,
                            "agent failed to apply update"
                        );
                    }
                }
                None => {}
            }
        }
        Ok(())
    }
    .await;

    watcher.abort();
    state
        .agents()
        .remove_if(&node_id, |_, &entry_gen| entry_gen == gen);
    let _ = sqlx::query("UPDATE nodes SET status = 'offline', last_seen_at = now() WHERE id = $1")
        .bind(node_id)
        .execute(state.pg())
        .await;
    if let Err(e) = result {
        tracing::warn!(node = %node_id, error = %e, "agent stream error");
    }
    tracing::info!(node = %node_id, "agent disconnected");
}

async fn mark_online(state: &AppState, node_id: Uuid, hello: &crate::gen::Hello) {
    valkey_util::set_online(state, node_id).await;
    let _ = sqlx::query(
        "UPDATE nodes SET status = 'online', agent_version = $1, core_version = $2 WHERE id = $3",
    )
    .bind(hello.info.as_ref().map(|i| i.agent_version.clone()))
    .bind(hello.info.as_ref().map(|i| i.core_version.clone()))
    .bind(node_id)
    .execute(state.pg())
    .await;
}

async fn store_heartbeat(state: &AppState, node_id: Uuid, hb: &Heartbeat) {
    let blob = serde_json::json!({
        "cpu_percent": hb.cpu_percent,
        "mem_used_bytes": hb.mem_used_bytes,
        "mem_total_bytes": hb.mem_total_bytes,
        "connections": hb.connections,
        "ts": chrono::Utc::now().to_rfc3339(),
    });
    valkey_util::set_with_ttl(
        state,
        format!("akari:node:hb:{node_id}"),
        blob.to_string(),
        600,
    )
    .await;
    // Keep the liveness key fresh for the whole duration of the connection.
    valkey_util::set_online(state, node_id).await;
}

#[derive(sqlx::FromRow)]
struct NodeRow {
    enabled: bool,
    xray_inbounds: serde_json::Value,
    config_version: i64,
    user_version: i64,
}

#[derive(sqlx::FromRow)]
struct NodeUserRow {
    user_id: Uuid,
    credentials: serde_json::Value,
}

#[derive(serde::Deserialize)]
struct Credential {
    inbound_tag: String,
    protocol: String,
    account: serde_json::Value,
}

/// Loads the desired node state and, if the agent's held versions differ,
/// sends a full snapshot containing the complete user set. The panel is the
/// source of truth; mismatches in either direction (to survive panel
/// rollbacks) trigger convergence.
async fn sync_if_stale(
    state: &AppState,
    node_id: Uuid,
    versions: &AgentVersions,
    tx: &mpsc::Sender<Result<PanelDown, Status>>,
) -> anyhow::Result<()> {
    let node = sqlx::query_as::<_, NodeRow>(
        "SELECT enabled, xray_inbounds, config_version, user_version FROM nodes WHERE id = $1",
    )
    .bind(node_id)
    .fetch_optional(state.pg())
    .await?;
    let Some(node) = node else {
        return Ok(());
    };
    if !node.enabled {
        return Ok(());
    }
    let (agent_cfg, agent_user) = versions.get();
    if node.config_version == agent_cfg as i64 && node.user_version == agent_user as i64 {
        return Ok(());
    }

    let rows = sqlx::query_as::<_, NodeUserRow>(
        r#"SELECT nu.user_id, nu.credentials
           FROM node_users nu
           JOIN users u ON u.id = nu.user_id
           WHERE nu.node_id = $1 AND u.enabled = true"#,
    )
    .bind(node_id)
    .fetch_all(state.pg())
    .await?;

    let mut users = Vec::with_capacity(rows.len());
    for r in rows {
        let creds: Vec<Credential> = serde_json::from_value(r.credentials).unwrap_or_default();
        users.push(UserOp {
            op: UserOpKind::Add as i32,
            user_id: r.user_id.to_string(),
            inbound_users: creds
                .into_iter()
                .map(|c| InboundUser {
                    inbound_tag: c.inbound_tag,
                    account_json: c.account.to_string(),
                    protocol: c.protocol,
                })
                .collect(),
        });
    }

    let snapshot = ConfigSnapshot {
        config_version: node.config_version as u64,
        inbounds_json: serde_json::to_string(&node.xray_inbounds)?,
        user_version: node.user_version as u64,
        users,
    };
    tracing::info!(
        node = %node_id,
        config_version = node.config_version,
        user_version = node.user_version,
        users = snapshot.users.len(),
        "sending snapshot"
    );
    tx.send(Ok(PanelDown {
        msg: Some(DownMsg::Snapshot(snapshot)),
    }))
    .await?;
    Ok(())
}

pub async fn serve(
    state: AppState,
    shutdown: tokio::sync::broadcast::Receiver<()>,
) -> anyhow::Result<()> {
    use tonic::transport::Server;

    let install = state.install();
    let tls = ServerTlsConfig::new()
        .identity(Identity::from_pem(
            &install.server_cert_pem,
            &install.server_key_pem,
        ))
        .client_ca_root(Certificate::from_pem(&install.ca_pem));

    let bind = state.cfg().grpc.bind;
    let mut shutdown = shutdown;
    Server::builder()
        .http2_keepalive_interval(Some(std::time::Duration::from_secs(30)))
        .http2_keepalive_timeout(Some(std::time::Duration::from_secs(60)))
        .tls_config(tls)?
        .add_service(AgentChannelServer::new(AgentChannelService { state }))
        .serve_with_shutdown(bind, async move {
            let _ = shutdown.recv().await;
        })
        .await?;
    Ok(())
}
