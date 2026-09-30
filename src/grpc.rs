use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

        // Disabled nodes are NOT rejected: a rejected agent would keep its
        // last xray config running forever. They are accepted and converge
        // to the disabled desired state (no inbounds, no users).
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

/// Per-session convergence state, shared by the stream reader and the
/// watcher. Pure logic; see `decide`.
#[derive(Debug, Default)]
struct SyncState {
    /// Versions the agent actually runs (Hello, or an ok Ack). A failed
    /// apply does not change them (the agent keeps its previous versions).
    held: (u64, u64),
    /// Snapshot sent and not yet acked: never resend the same versions
    /// while one is in flight (rebuild storms).
    pending: Option<((u64, u64), Instant)>,
    /// Versions whose apply failed in this session (also persisted, but
    /// kept here so a failed DB write cannot skip the backoff).
    failed: Option<(u64, u64)>,
    /// Consecutive retries of failed versions, and when the next is allowed.
    attempts: u32,
    next_retry: Option<Instant>,
    /// Read tickets: a desired state read before the last sent one (older
    /// ticket) that is not newer must never overwrite it.
    tickets: u64,
    last_sent: Option<(u64, (u64, u64))>,
}

/// An unacked snapshot older than this is treated as a failed apply.
const PENDING_TIMEOUT: Duration = Duration::from_secs(120);
/// Reconcile tick: self-heals missed notifies and transient DB errors.
const RECONCILE_EVERY: Duration = Duration::from_secs(60);

fn retry_backoff(attempts: u32) -> Duration {
    Duration::from_secs((30u64 << attempts.min(5)).min(600))
}

fn covers(v: (u64, u64), of: (u64, u64)) -> bool {
    v.0 >= of.0 && v.1 >= of.1
}

impl SyncState {
    /// Take a ticket BEFORE reading the desired state from the DB.
    fn ticket(&mut self) -> u64 {
        self.tickets += 1;
        self.tickets
    }

    fn fail(&mut self, v: (u64, u64), now: Instant) {
        self.failed = Some(v);
        self.next_retry = Some(now + retry_backoff(self.attempts));
    }

    /// Should the snapshot for `desired` (read under `ticket`) be sent now?
    /// `db_failed` is the node's persisted failed versions. Marks it pending
    /// and sent when returning true.
    fn decide(
        &mut self,
        ticket: u64,
        desired: (u64, u64),
        db_failed: Option<(u64, u64)>,
        now: Instant,
    ) -> bool {
        if let Some((t, v)) = self.last_sent {
            // An older read that isn't newer than what went out is stale:
            // sending it would roll the agent back (access leak).
            if ticket < t && !covers(desired, v) {
                return false;
            }
        }
        if let Some((v, at)) = self.pending {
            if now.duration_since(at) < PENDING_TIMEOUT {
                if v == desired {
                    return false;
                }
            } else {
                // Lost ack: treat as a failed apply (backoff, no storm).
                self.pending = None;
                self.fail(v, now);
            }
        }
        if self.held == desired {
            return false;
        }
        if self.failed == Some(desired) || db_failed == Some(desired) {
            // Already failed: only retry on backoff, until desired changes.
            match self.next_retry {
                None => {
                    self.next_retry = Some(now + retry_backoff(self.attempts));
                    return false;
                }
                Some(t) if now < t => return false,
                Some(_) => {
                    self.attempts += 1;
                    self.next_retry = Some(now + retry_backoff(self.attempts));
                }
            }
        }
        self.pending = Some((desired, now));
        self.last_sent = Some((ticket, desired));
        true
    }

    fn on_hello(&mut self, held: (u64, u64)) {
        self.held = held;
    }

    fn on_ack(&mut self, ok: bool, versions: (u64, u64), now: Instant) {
        // Only the ack for the in-flight snapshot ends it; an older ack
        // must not let the newer one be resent.
        if self.pending.is_some_and(|(v, _)| v == versions) {
            self.pending = None;
        }
        if ok {
            self.held = versions;
            if self.failed.is_some_and(|f| covers(versions, f)) {
                self.failed = None;
                self.attempts = 0;
                self.next_retry = None;
            }
        } else {
            self.fail(versions, now);
        }
    }
}

type SharedSync = Arc<Mutex<SyncState>>;

async fn session(
    state: AppState,
    node_id: Uuid,
    mut inbound: Streaming<AgentUp>,
    tx: mpsc::Sender<Result<PanelDown, Status>>,
) {
    use crate::gen::agent_up::Msg as UpMsg;

    tracing::info!(node = %node_id, "agent connected");
    // Owner token for nodes.status across panel instances: only the session
    // that last marked the node online may refresh it or mark it offline.
    let online_session = Uuid::new_v4();
    let gen = state.next_gen();
    state.agents().insert(node_id, (gen, online_session));

    let sync: SharedSync = Arc::default();
    // Traffic is only accepted for assigned users; load them before the
    // first report can arrive.
    refresh_members(&state, node_id).await;

    // Push snapshots on panel-side changes, and reconcile periodically.
    let watcher_state = state.clone();
    let watcher_tx = tx.clone();
    let watcher_sync = sync.clone();
    let mut watch_rx = state.subscribe_changes();
    let watcher = tokio::spawn(async move {
        let mut tick = tokio::time::interval(RECONCILE_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await; // the first tick is immediate; Hello covers it
        loop {
            tokio::select! {
                r = watch_rx.changed() => if r.is_err() { break },
                _ = tick.tick() => {}
            }
            refresh_members(&watcher_state, node_id).await;
            if let Err(e) = sync_if_stale(&watcher_state, node_id, &watcher_sync, &watcher_tx).await
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
                    sync.lock()
                        .unwrap()
                        .on_hello((hello.config_version, hello.user_version));
                    mark_online(&state, node_id, online_session, &hello).await;
                    // The agent only claims versions it applied cleanly.
                    record_converged(
                        state.pg(),
                        node_id,
                        (hello.config_version, hello.user_version),
                    )
                    .await;
                    if let Err(e) = sync_if_stale(&state, node_id, &sync, &tx).await {
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
                    sync.lock().unwrap().on_ack(
                        ack.ok,
                        (ack.config_version, ack.user_version),
                        Instant::now(),
                    );
                    record_ack(&state, node_id, &ack).await;
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
        .remove_if(&node_id, |_, &(entry_gen, _)| entry_gen == gen);
    // A snapshot still unacked when the stream dies counts as a failed
    // apply, so a crash-looping agent gets backoff instead of resends.
    let lost = sync.lock().unwrap().pending.map(|(v, _)| v);
    if let Some(v) = lost {
        record_failure(state.pg(), node_id, v, "no ack before the stream closed").await;
    }
    let _ = mark_offline(state.pg(), node_id, online_session).await;
    if let Err(e) = result {
        tracing::warn!(node = %node_id, error = %e, "agent stream error");
    }
    tracing::info!(node = %node_id, "agent disconnected");
}

/// Clear the recorded failure if `versions` (now running on the agent, per
/// an ok Ack or a Hello) cover the failed ones. A stale report for older
/// versions must not launder a newer failure.
async fn record_converged(pg: &sqlx::PgPool, node_id: Uuid, versions: (u64, u64)) {
    let res = sqlx::query(
        "UPDATE nodes SET last_error = NULL, last_error_at = NULL, \
             failed_config_version = NULL, failed_user_version = NULL \
         WHERE id = $1 AND last_error IS NOT NULL \
           AND $2 >= COALESCE(failed_config_version, 0) \
           AND $3 >= COALESCE(failed_user_version, 0)",
    )
    .bind(node_id)
    .bind(versions.0 as i64)
    .bind(versions.1 as i64)
    .execute(pg)
    .await;
    if let Err(e) = res {
        tracing::warn!(node = %node_id, error = %e, "failed to clear node error");
    }
}

/// Persist a failed apply: the error and the ATTEMPTED versions.
async fn record_failure(pg: &sqlx::PgPool, node_id: Uuid, versions: (u64, u64), error: &str) {
    tracing::warn!(node = %node_id, error = %error, "agent failed to apply update");
    let msg: String = if error.is_empty() {
        "agent reported failure without detail".into()
    } else {
        error.chars().take(2000).collect()
    };
    let res = sqlx::query(
        "UPDATE nodes SET last_error = $2, last_error_at = now(), \
             failed_config_version = $3, failed_user_version = $4 WHERE id = $1",
    )
    .bind(node_id)
    .bind(msg)
    .bind(versions.0 as i64)
    .bind(versions.1 as i64)
    .execute(pg)
    .await;
    if let Err(e) = res {
        tracing::warn!(node = %node_id, error = %e, "failed to record node error");
    }
}

async fn record_ack(state: &AppState, node_id: Uuid, ack: &crate::gen::Ack) {
    let v = (ack.config_version, ack.user_version);
    if ack.ok {
        record_converged(state.pg(), node_id, v).await;
    } else {
        record_failure(state.pg(), node_id, v, &ack.error).await;
    }
}

async fn mark_online(
    state: &AppState,
    node_id: Uuid,
    online_session: Uuid,
    hello: &crate::gen::Hello,
) {
    valkey_util::set_online(state, node_id).await;
    let info = hello.info.as_ref();
    let _ = set_online_row(
        state.pg(),
        node_id,
        online_session,
        info.map(|i| i.agent_version.as_str()),
        info.map(|i| i.core_version.as_str()),
    )
    .await;
}

async fn set_online_row(
    pg: &sqlx::PgPool,
    node_id: Uuid,
    online_session: Uuid,
    agent_version: Option<&str>,
    core_version: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE nodes SET status = 'online', agent_version = $1, core_version = $2, \
         online_session = $4 WHERE id = $3",
    )
    .bind(agent_version)
    .bind(core_version)
    .bind(node_id)
    .bind(online_session)
    .execute(pg)
    .await?;
    Ok(())
}

/// Only the session that last marked the node online may mark it offline.
async fn mark_offline(pg: &sqlx::PgPool, node_id: Uuid, online_session: Uuid) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE nodes SET status = 'offline', last_seen_at = now() \
         WHERE id = $1 AND online_session = $2",
    )
    .bind(node_id)
    .bind(online_session)
    .execute(pg)
    .await?;
    Ok(())
}

async fn refresh_members(state: &AppState, node_id: Uuid) {
    if let Err(e) = crate::traffic::refresh_members(state.pg(), state.traffic(), node_id).await {
        tracing::warn!(node = %node_id, error = %e, "failed to load node membership");
    }
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
    failed_config_version: Option<i64>,
    failed_user_version: Option<i64>,
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

/// What the node must run right now, plus its recorded apply error.
struct Desired {
    snapshot: ConfigSnapshot,
    /// Versions whose apply failed (persisted), if any.
    failed: Option<(u64, u64)>,
}

/// The desired state of a node. A disabled node runs nothing (no inbounds,
/// no users). Users are served only if enabled and, for role=user, not
/// expired. The expiry filter uses the DB clock at read time, so any
/// snapshot built after the expiry excludes the user even before the
/// periodic enforcement pass bumps the version.
async fn desired_state(pg: &sqlx::PgPool, node_id: Uuid) -> anyhow::Result<Option<Desired>> {
    let node = sqlx::query_as::<_, NodeRow>(
        "SELECT enabled, xray_inbounds, config_version, user_version, \
         failed_config_version, failed_user_version FROM nodes WHERE id = $1",
    )
    .bind(node_id)
    .fetch_optional(pg)
    .await?;
    let Some(node) = node else {
        return Ok(None);
    };

    let mut users = Vec::new();
    let inbounds_json = if node.enabled {
        let rows = sqlx::query_as::<_, NodeUserRow>(sqlx::AssertSqlSafe(format!(
            "SELECT nu.user_id, nu.credentials \
             FROM node_users nu JOIN users u ON u.id = nu.user_id \
             WHERE nu.node_id = $1 AND {} \
             ORDER BY nu.user_id",
            crate::enforce::SERVED
        )))
        .bind(node_id)
        .fetch_all(pg)
        .await?;
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
        serde_json::to_string(&node.xray_inbounds)?
    } else {
        "[]".to_string()
    };

    Ok(Some(Desired {
        snapshot: ConfigSnapshot {
            config_version: node.config_version as u64,
            inbounds_json,
            user_version: node.user_version as u64,
            users,
        },
        failed: node
            .failed_config_version
            .zip(node.failed_user_version)
            .map(|(c, u)| (c as u64, u as u64)),
    }))
}

/// Sends a full snapshot if the agent does not run the desired versions
/// (either direction, to survive panel rollbacks), subject to SyncState's
/// pending/backoff rules.
async fn sync_if_stale(
    state: &AppState,
    node_id: Uuid,
    sync: &SharedSync,
    tx: &mpsc::Sender<Result<PanelDown, Status>>,
) -> anyhow::Result<()> {
    let ticket = sync.lock().unwrap().ticket(); // BEFORE the read
    let Some(desired) = desired_state(state.pg(), node_id).await? else {
        return Ok(());
    };
    let snap = desired.snapshot;
    let want = (snap.config_version, snap.user_version);
    if !sync
        .lock()
        .unwrap()
        .decide(ticket, want, desired.failed, Instant::now())
    {
        return Ok(());
    }
    tracing::info!(
        node = %node_id,
        config_version = snap.config_version,
        user_version = snap.user_version,
        users = snap.users.len(),
        inbounds_json_len = snap.inbounds_json.len(),
        "sending snapshot"
    );
    if let Err(e) = tx
        .send(Ok(PanelDown {
            msg: Some(DownMsg::Snapshot(snap)),
        }))
        .await
    {
        sync.lock().unwrap().pending = None;
        return Err(e.into());
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::TestDb;

    /// decide() with a fresh ticket taken now (the common case).
    fn d(s: &mut SyncState, want: (u64, u64), failed: Option<(u64, u64)>, now: Instant) -> bool {
        let t = s.ticket();
        s.decide(t, want, failed, now)
    }

    #[test]
    fn sync_sends_once_until_acked() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        s.on_hello((1, 1));
        assert!(!d(&mut s, (1, 1), None, t0), "converged");
        assert!(d(&mut s, (2, 1), None, t0));
        assert!(!d(&mut s, (2, 1), None, t0), "pending: no resend storm");
        assert!(
            d(&mut s, (3, 1), None, t0),
            "new desired state goes out at once"
        );
        s.on_ack(true, (3, 1), t0);
        assert!(!d(&mut s, (3, 1), None, t0));
    }

    /// L3: a lost ack (pending timeout) is a failure -> backoff, not resend.
    #[test]
    fn pending_timeout_counts_as_failure() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        s.on_hello((1, 1));
        assert!(d(&mut s, (2, 1), None, t0));
        let t1 = t0 + PENDING_TIMEOUT;
        assert!(
            !d(&mut s, (2, 1), None, t1),
            "no immediate resend after a lost ack"
        );
        assert!(d(&mut s, (2, 1), None, t1 + retry_backoff(0)));
    }

    #[test]
    fn failed_versions_retry_only_on_backoff_or_change() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        s.on_hello((1, 1));
        assert!(d(&mut s, (2, 1), None, t0));
        // Agent fails: keeps (1,1), Ack reports the attempted (2,1).
        s.on_ack(false, (2, 1), t0);
        s.on_hello((1, 1));
        // L2: no DB record needed (db_failed = None) to honour the backoff.
        assert!(!d(&mut s, (2, 1), None, t0), "no immediate retry");
        assert!(!d(&mut s, (2, 1), None, t0 + Duration::from_secs(29)));
        let t1 = t0 + Duration::from_secs(30);
        assert!(d(&mut s, (2, 1), None, t1), "retry after backoff");
        s.on_ack(false, (2, 1), t1);
        assert!(
            d(&mut s, (3, 1), None, t1),
            "a changed desired state is sent at once"
        );
        assert_eq!(
            retry_backoff(100),
            Duration::from_secs(600),
            "capped at 10 min"
        );
    }

    #[test]
    fn new_session_waits_for_backoff_on_known_failure() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        s.on_hello((1, 1));
        assert!(!d(&mut s, (2, 1), Some((2, 1)), t0));
        assert!(d(&mut s, (2, 1), Some((2, 1)), t0 + retry_backoff(0)));
    }

    /// Red team M1: the Hello path read v5 before a commit, the watcher
    /// read v6 after it and sent first; the late v5 must not go out.
    #[test]
    fn stale_desired_after_newer_is_sent() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        s.on_hello((4, 4));
        let hello_ticket = s.ticket(); // Hello path reads (5,5) ...
        let watch_ticket = s.ticket(); // ... watcher reads (6,6) later
        assert!(s.decide(watch_ticket, (6, 6), None, t0));
        assert!(
            !s.decide(hello_ticket, (5, 5), None, t0),
            "stale v5 after v6"
        );
        // An older ticket that nevertheless read newer data still counts.
        let mut s = SyncState::default();
        let t_old = s.ticket();
        let t_new = s.ticket();
        assert!(s.decide(t_new, (6, 6), None, t0));
        assert!(s.decide(t_old, (7, 7), None, t0));
    }

    /// Red team L1: the ack of an older snapshot must not clear the pending
    /// newer one (which would then be resent while in flight).
    #[test]
    fn older_ack_does_not_clear_newer_pending() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        s.on_hello((4, 4));
        assert!(d(&mut s, (5, 5), None, t0));
        assert!(d(&mut s, (6, 6), None, t0));
        s.on_ack(true, (5, 5), t0);
        assert!(!d(&mut s, (6, 6), None, t0), "v6 resent while in flight");
    }

    /// S2-7: only the session that last marked the node online may mark
    /// it offline — cleanup of an older session running last is a no-op.
    #[tokio::test]
    async fn online_session_ownership() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let status = || async {
            sqlx::query_scalar::<_, String>("SELECT status FROM nodes WHERE id = $1")
                .bind(n)
                .fetch_one(&db.pool)
                .await
                .unwrap()
        };
        set_online_row(&db.pool, n, a, None, None).await.unwrap();
        set_online_row(&db.pool, n, b, None, None).await.unwrap();
        mark_offline(&db.pool, n, a).await.unwrap(); // old session ends late
        assert_eq!(status().await, "online");
        mark_offline(&db.pool, n, b).await.unwrap();
        assert_eq!(status().await, "offline");
        db.drop().await;
    }

    #[tokio::test]
    async fn desired_state_disabled_node_expired_and_disabled_users() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, active) = db.member().await;
        let (expired, admin_past, disabled) = (db.user().await, db.user().await, db.user().await);
        for u in [expired, admin_past, disabled] {
            db.assign(n, u).await;
        }
        sqlx::query("UPDATE users SET expires_at = now() - interval '1 minute' WHERE id = ANY($1)")
            .bind(vec![expired, admin_past])
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE users SET role = 'admin' WHERE id = $1")
            .bind(admin_past)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE users SET enabled = false WHERE id = $1")
            .bind(disabled)
            .execute(&db.pool)
            .await
            .unwrap();
        let d = desired_state(&db.pool, n).await.unwrap().unwrap();
        let mut got: Vec<String> = d.snapshot.users.iter().map(|u| u.user_id.clone()).collect();
        got.sort();
        // Admins are not proxy users (R6 L6), expired/disabled users are out.
        let mut want = vec![active.to_string()];
        want.sort();
        assert_eq!(got, want);
        assert_ne!(d.snapshot.inbounds_json, "[]");

        sqlx::query("UPDATE nodes SET enabled = false WHERE id = $1")
            .bind(n)
            .execute(&db.pool)
            .await
            .unwrap();
        let d = desired_state(&db.pool, n).await.unwrap().unwrap();
        assert_eq!(d.snapshot.inbounds_json, "[]");
        assert!(d.snapshot.users.is_empty());
        assert!(desired_state(&db.pool, Uuid::new_v4())
            .await
            .unwrap()
            .is_none());
        db.drop().await;
    }
}
