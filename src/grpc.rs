use std::collections::{BTreeMap, VecDeque};
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
use crate::gen::{
    AgentUp, ConfigSnapshot, Heartbeat, InboundUser, LeaseGrant, PanelDown, UserDelta, UserOp,
};
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

/// Lowest `Hello.protocol_version` the panel converges. Older agents are
/// served the empty desired state (no inbounds, no users) and their
/// Hello/Ack are never trusted for convergence (N5). Rollout: agents first.
pub const MIN_AGENT_PROTOCOL: u32 = 1;

/// A node's user set as the agent must run it: user id -> inbound tag ->
/// (protocol, account_json). Users without any inbound are absent. Built
/// with the proto's collapsing rules (a later InboundUser for the same tag,
/// or a later op for the same user, replaces the earlier one).
pub type UserSet = BTreeMap<String, BTreeMap<String, (String, String)>>;

pub fn user_set(ops: &[UserOp]) -> UserSet {
    let mut set = UserSet::new();
    for op in ops {
        let mut tags = BTreeMap::new();
        if op.op == UserOpKind::Add as i32 {
            for iu in &op.inbound_users {
                tags.insert(
                    iu.inbound_tag.clone(),
                    (iu.protocol.clone(), iu.account_json.clone()),
                );
            }
        }
        if tags.is_empty() {
            set.remove(&op.user_id);
        } else {
            set.insert(op.user_id.clone(), tags);
        }
    }
    set
}

/// What the agent must run: the inbounds JSON exactly as sent in the
/// Snapshot and the user set.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NodeState {
    pub inbounds: String,
    pub users: UserSet,
}

/// agent.proto "State hash" (v2): lowercase hex SHA-256 over
/// "akari-state-v2\n", u64be(config_version), then per (user_id,
/// inbound_tag) in bytewise order the u32be-length-prefixed user_id,
/// inbound_tag, protocol, account_json, then u32be(32) ||
/// SHA-256(inbounds_json). BTreeMap<String, _> iterates in bytewise order,
/// which is exactly the required order.
pub fn state_hash(config_version: u64, state: &NodeState) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"akari-state-v2\n");
    h.update(config_version.to_be_bytes());
    let mut field = |b: &[u8]| {
        h.update((b.len() as u32).to_be_bytes());
        h.update(b);
    };
    for (user, tags) in &state.users {
        for (tag, (protocol, account)) in tags {
            field(user.as_bytes());
            field(tag.as_bytes());
            field(protocol.as_bytes());
            field(account.as_bytes());
        }
    }
    let inbounds = Sha256::digest(state.inbounds.as_bytes());
    field(&inbounds);
    hex::encode(h.finalize())
}

/// Does going from `base` to `want` drop or change any live credential
/// (a removal or rotation, as opposed to pure additions)?
pub fn drops_credential(base: &UserSet, want: &UserSet) -> bool {
    base.iter().any(|(user, tags)| {
        tags.iter()
            .any(|(tag, cred)| want.get(user).and_then(|w| w.get(tag)) != Some(cred))
    })
}

/// UserDelta ops turning `base` into `want` (REPLACE semantics: a changed
/// user is re-sent with its complete inbound list).
pub fn diff_user_sets(base: &UserSet, want: &UserSet) -> Vec<UserOp> {
    let mut ops = Vec::new();
    for (user, tags) in want {
        if base.get(user) != Some(tags) {
            ops.push(UserOp {
                op: UserOpKind::Add as i32,
                user_id: user.clone(),
                inbound_users: tags
                    .iter()
                    .map(|(tag, (protocol, account))| InboundUser {
                        inbound_tag: tag.clone(),
                        account_json: account.clone(),
                        protocol: protocol.clone(),
                    })
                    .collect(),
            });
        }
    }
    for user in base.keys() {
        if !want.contains_key(user) {
            ops.push(UserOp {
                op: UserOpKind::Remove as i32,
                user_id: user.clone(),
                inbound_users: vec![],
            });
        }
    }
    ops
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Snapshot,
    Delta,
}

/// What `decide` wants sent for the desired versions it was given.
#[derive(Debug)]
enum Plan {
    /// Full snapshot; `empty` = the too-old-agent state at versions (0,0).
    Snapshot { empty: bool },
    /// Delta from `base` (a state the agent holds or is about to hold).
    Delta {
        base: (u64, u64),
        base_set: Arc<NodeState>,
    },
}

#[derive(Debug, Clone, Copy)]
struct Pending {
    versions: (u64, u64),
    at: Instant,
    kind: Kind,
}

/// What the session must do after an Ack.
#[derive(Debug, PartialEq, Eq)]
enum AckOutcome {
    /// Clean apply: clear a covered persisted failure.
    Converged,
    /// Record a failed apply (message) — backoff applies.
    Failed(String),
    /// Send the right thing now (BASE_MISMATCH / divergence): no failure.
    Resync,
    /// Untrusted (too-old agent) or nothing to do.
    Ignore,
}

/// Per-session convergence state, shared by the stream reader and the
/// watcher. Pure logic; see `decide`.
#[derive(Debug, Default)]
struct SyncState {
    /// Versions the agent actually runs (Hello, or an Ack's held versions).
    /// A failed apply does not change them (the agent keeps its previous
    /// versions).
    held: (u64, u64),
    /// Sent and not yet acked: never resend the same versions while one is
    /// in flight (rebuild storms).
    pending: Option<Pending>,
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
    /// A new session may send once immediately for a persisted no-ack
    /// failure (the previous stream may just have flapped).
    no_ack_grace_used: bool,
    /// Nothing is sent before the agent's Hello (its protocol is unknown).
    hello_seen: bool,
    protocol: u32,
    /// Hello's state hash, verified against the desired set once the held
    /// versions equal the desired ones (then the set becomes `acked`).
    hello_hash: Option<String>,
    /// The user set the agent verifiably runs at `held` in THIS session
    /// (acked by us, or hash-verified from its Hello). Deltas are only
    /// computed from it (or from the in-flight state).
    acked: Option<((u64, u64), Arc<NodeState>)>,
    /// Sets sent this session, by versions (bounded), to know what an ok
    /// Ack means.
    sent: VecDeque<((u64, u64), Arc<NodeState>)>,
    /// The agent's state hash disagrees with what it should run at its
    /// versions: repair with a Snapshot even though the versions match.
    diverged: bool,
    /// Too-old agent: the empty state is pushed once per session no matter
    /// what its Hello claims.
    old_pushed: bool,
    /// Last time this session persisted `nodes.lease_expires_at`.
    lease_written: Option<Instant>,
    /// agent.remove_mode = "rebuild": a removal/rotation is never a delta.
    remove_rebuild: bool,
}

/// A failed apply as persisted on the node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DbFailure {
    /// The attempted versions.
    versions: (u64, u64),
    /// What the agent held when the failure was recorded.
    held: (u64, u64),
    /// The agent never answered (stream closed / ack timeout), as opposed
    /// to an explicit Ack ok=false.
    no_ack: bool,
}

/// An unacked snapshot older than this is treated as a failed apply.
const PENDING_TIMEOUT: Duration = Duration::from_secs(120);
/// Reconcile tick: self-heals missed notifies and transient DB errors.
const RECONCILE_EVERY: Duration = Duration::from_secs(60);
/// How many sent sets a session remembers (for Acks that arrive late).
const SENT_MEMORY: usize = 16;

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

    fn too_old(&self) -> bool {
        self.protocol < MIN_AGENT_PROTOCOL
    }

    fn fail(&mut self, v: (u64, u64), now: Instant) {
        self.failed = Some(v);
        self.next_retry = Some(now + retry_backoff(self.attempts));
    }

    fn sent_set(&self, v: (u64, u64)) -> Option<Arc<NodeState>> {
        self.sent
            .iter()
            .rev()
            .find(|(sv, _)| *sv == v)
            .map(|(_, s)| s.clone())
    }

    fn remember(&mut self, v: (u64, u64), set: Arc<NodeState>) {
        self.sent.retain(|(sv, _)| *sv != v);
        self.sent.push_back((v, set));
        while self.sent.len() > SENT_MEMORY {
            self.sent.pop_front();
        }
    }

    /// The state a delta to `desired` can start from, if any: the in-flight
    /// state (chained; if it fails the agent answers BASE_MISMATCH) or the
    /// verified acked state. Inbound (config) changes always need a
    /// Snapshot, as do failed versions and divergence.
    fn delta_base(
        &self,
        desired: (u64, u64),
        want: &NodeState,
        can_delta: bool,
    ) -> Option<((u64, u64), Arc<NodeState>)> {
        if !can_delta || self.diverged || self.failed == Some(desired) {
            return None;
        }
        let (bv, bset) = match self.pending {
            Some(p) => (p.versions, self.sent_set(p.versions)?),
            None => {
                let (v, s) = self.acked.as_ref()?;
                if *v != self.held {
                    return None;
                }
                (*v, s.clone())
            }
        };
        if bv.0 != desired.0 || bv == desired || bset.inbounds != want.inbounds {
            return None;
        }
        if self.remove_rebuild && drops_credential(&bset.users, &want.users) {
            return None;
        }
        Some((bv, bset))
    }

    /// What to send for `desired` (versions + user set, read under
    /// `ticket`) now, if anything. `db_failed` is the node's persisted
    /// failure; `can_delta` = node enabled. Marks it pending and sent.
    fn decide(
        &mut self,
        ticket: u64,
        desired: (u64, u64),
        set: &Arc<NodeState>,
        can_delta: bool,
        db_failed: Option<DbFailure>,
        now: Instant,
    ) -> Option<Plan> {
        if !self.hello_seen {
            return None;
        }
        let old = self.too_old();
        let desired = if old { (0, 0) } else { desired };
        if let Some((t, v)) = self.last_sent {
            // An older read that isn't newer than what went out is stale:
            // sending it would roll the agent back (access leak).
            if ticket < t && !covers(desired, v) {
                return None;
            }
        }
        if let Some(p) = self.pending {
            if now.duration_since(p.at) < PENDING_TIMEOUT {
                if p.versions == desired {
                    return None;
                }
            } else {
                // Lost ack: treat as a failed apply (backoff, no storm).
                self.pending = None;
                self.fail(p.versions, now);
            }
        }
        if !old && self.held == desired {
            if let Some(h) = self.hello_hash.take() {
                if h == state_hash(desired.0, set) {
                    self.acked = Some((desired, set.clone()));
                    self.diverged = false;
                } else {
                    self.acked = None;
                    self.diverged = true;
                }
            }
        }
        let force_old = old && !self.old_pushed;
        if self.held == desired && !self.diverged && !force_old {
            return None;
        }
        // A failure persisted by an earlier session only backs this one off
        // if nothing has changed since: same agent state, and the agent
        // actually answered (a no-ack failure gets one immediate retry per
        // session; an agent restart reports held (0,0)).
        let db_repeat = !old
            && db_failed.is_some_and(|f| {
                if f.versions != desired || self.held == (0, 0) || self.held != f.held {
                    return false;
                }
                if f.no_ack && !self.no_ack_grace_used {
                    self.no_ack_grace_used = true;
                    return false;
                }
                true
            });
        if !force_old && (self.failed == Some(desired) || db_repeat) {
            // Already failed: only retry on backoff, until desired changes.
            match self.next_retry {
                None => {
                    self.next_retry = Some(now + retry_backoff(self.attempts));
                    return None;
                }
                Some(t) if now < t => return None,
                Some(_) => {
                    self.attempts += 1;
                    self.next_retry = Some(now + retry_backoff(self.attempts));
                }
            }
        }
        let plan = if old {
            self.old_pushed = true;
            Plan::Snapshot { empty: true }
        } else if let Some((base, base_set)) = self.delta_base(desired, set, can_delta) {
            Plan::Delta { base, base_set }
        } else {
            Plan::Snapshot { empty: false }
        };
        let kind = match plan {
            Plan::Delta { .. } => Kind::Delta,
            Plan::Snapshot { .. } => Kind::Snapshot,
        };
        self.pending = Some(Pending {
            versions: desired,
            at: now,
            kind,
        });
        self.last_sent = Some((ticket, desired));
        if !old {
            self.remember(desired, set.clone());
        }
        Some(plan)
    }

    fn on_hello(&mut self, held: (u64, u64), protocol: u32, hash: &str) {
        self.hello_seen = true;
        self.held = held;
        self.protocol = protocol;
        // What the agent runs must be (re)verified: it may have restarted,
        // torn down on lease expiry, or rebuilt.
        self.acked = None;
        self.diverged = false;
        self.hello_hash = (!self.too_old() && !hash.is_empty()).then(|| hash.to_string());
    }

    fn on_ack(&mut self, ack: &crate::gen::Ack, now: Instant) -> AckOutcome {
        use crate::gen::ack::Reason;
        let versions = (ack.config_version, ack.user_version);
        let old = self.too_old();
        let reason = match Reason::try_from(ack.reason).unwrap_or(Reason::Unspecified) {
            Reason::Unspecified if ack.ok => Reason::Ok,
            Reason::Unspecified => Reason::ApplyFailed,
            r => r,
        };
        // Only the ack for the in-flight message ends it; an older ack
        // must not let the newer one be resent.
        let kind = match self.pending {
            Some(p) if p.versions == versions => {
                self.pending = None;
                Some(p.kind)
            }
            _ => None,
        };
        let reports_held = !old && ack.reason != Reason::Unspecified as i32;
        self.held = if reports_held {
            (ack.held_config_version, ack.held_user_version)
        } else if reason == Reason::Ok {
            versions
        } else {
            self.held
        };
        match reason {
            Reason::Ok => {
                if old {
                    return AckOutcome::Ignore;
                }
                self.acked = self
                    .sent_set(versions)
                    .filter(|_| self.held == versions)
                    .map(|s| (versions, s));
                if let Some((v, set)) = &self.acked {
                    if !ack.state_hash.is_empty() && state_hash(v.0, set) != ack.state_hash {
                        self.acked = None;
                        self.diverged = true;
                        if kind == Some(Kind::Snapshot) {
                            // A fresh full apply already disagrees: not a
                            // transient — back off like any failed apply.
                            self.fail(versions, now);
                            return AckOutcome::Failed(
                                "agent state hash does not match the snapshot it acked".into(),
                            );
                        }
                        return AckOutcome::Resync;
                    }
                    self.diverged = false;
                }
                if self.failed.is_some_and(|f| covers(versions, f)) {
                    self.failed = None;
                    self.attempts = 0;
                    self.next_retry = None;
                }
                AckOutcome::Converged
            }
            Reason::BaseMismatch => {
                // Not a failure: the agent changed nothing; send what it
                // needs (a Snapshot, since nothing verified is left).
                self.acked = None;
                if old {
                    AckOutcome::Ignore
                } else {
                    AckOutcome::Resync
                }
            }
            _ => {
                self.fail(versions, now);
                self.acked = None;
                if old {
                    AckOutcome::Ignore
                } else {
                    AckOutcome::Failed(if ack.error.is_empty() {
                        String::new()
                    } else {
                        ack.error.clone()
                    })
                }
            }
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
    sync.lock().unwrap().remove_rebuild =
        state.cfg().agent.remove_mode == crate::config::RemoveMode::Rebuild;
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
                    tracing::info!(
                        node = %node_id,
                        session = %hello.session_id,
                        protocol = hello.protocol_version,
                        "agent hello"
                    );
                    let held = (hello.config_version, hello.user_version);
                    sync.lock()
                        .unwrap()
                        .on_hello(held, hello.protocol_version, &hello.state_hash);
                    mark_online(&state, node_id, online_session, &hello).await;
                    if hello.protocol_version < MIN_AGENT_PROTOCOL {
                        // Never trusted for convergence; say why it runs
                        // nothing.
                        record_too_old(state.pg(), node_id, hello.protocol_version).await;
                    } else {
                        // The agent only claims versions it applied cleanly.
                        record_converged(state.pg(), node_id, held).await;
                    }
                    if let Err(e) = sync_if_stale(&state, node_id, &sync, &tx).await {
                        tracing::warn!(node = %node_id, error = %e, "failed to sync after hello");
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
                        reason = ack.reason,
                        error = %ack.error,
                        config_version = ack.config_version,
                        user_version = ack.user_version,
                        "agent ack"
                    );
                    let (held_before, outcome) = {
                        let mut st = sync.lock().unwrap();
                        let held = st.held;
                        (held, st.on_ack(&ack, Instant::now()))
                    };
                    let v = (ack.config_version, ack.user_version);
                    match outcome {
                        AckOutcome::Converged => record_converged(state.pg(), node_id, v).await,
                        AckOutcome::Failed(msg) => {
                            let f = DbFailure {
                                versions: v,
                                held: held_before,
                                no_ack: false,
                            };
                            record_failure(state.pg(), node_id, f, &msg).await;
                        }
                        AckOutcome::Resync => {
                            if let Err(e) = sync_if_stale(&state, node_id, &sync, &tx).await {
                                tracing::warn!(node = %node_id, error = %e, "failed to resync");
                            }
                        }
                        AckOutcome::Ignore => {}
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
        .remove_if(&node_id, |_, &(entry_gen, _)| entry_gen == gen);
    // A snapshot still unacked when the stream dies counts as a failed
    // apply, so a crash-looping agent gets backoff instead of resends.
    let lost = {
        let st = sync.lock().unwrap();
        // A too-old agent's answers are not trusted either way.
        st.pending.filter(|_| !st.too_old()).map(|p| DbFailure {
            versions: p.versions,
            held: st.held,
            no_ack: true,
        })
    };
    if let Some(f) = lost {
        record_failure(state.pg(), node_id, f, "no ack before the stream closed").await;
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
             failed_config_version = NULL, failed_user_version = NULL, \
             failed_held_config_version = NULL, failed_held_user_version = NULL, \
             failed_reason = NULL \
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

/// Persist a failed apply: the error, the ATTEMPTED versions, what the agent
/// held at the time and whether it answered at all.
async fn record_failure(pg: &sqlx::PgPool, node_id: Uuid, failure: DbFailure, error: &str) {
    tracing::warn!(node = %node_id, error = %error, no_ack = failure.no_ack, "agent failed to apply update");
    let msg: String = if error.is_empty() {
        "agent reported failure without detail".into()
    } else {
        error.chars().take(2000).collect()
    };
    let res = sqlx::query(
        "UPDATE nodes SET last_error = $2, last_error_at = now(), \
             failed_config_version = $3, failed_user_version = $4, \
             failed_held_config_version = $5, failed_held_user_version = $6, \
             failed_reason = $7 WHERE id = $1",
    )
    .bind(node_id)
    .bind(msg)
    .bind(failure.versions.0 as i64)
    .bind(failure.versions.1 as i64)
    .bind(failure.held.0 as i64)
    .bind(failure.held.1 as i64)
    .bind(if failure.no_ack { "no_ack" } else { "nack" })
    .execute(pg)
    .await;
    if let Err(e) = res {
        tracing::warn!(node = %node_id, error = %e, "failed to record node error");
    }
}

/// A too-old agent (N5) runs the empty state; say so on the node. Clears
/// failure context (the empty state is not a retried apply). Cleared by the
/// next protocol-current agent's Hello (record_converged).
async fn record_too_old(pg: &sqlx::PgPool, node_id: Uuid, protocol: u32) {
    let msg = format!(
        "agent too old: protocol_version {protocol} < {MIN_AGENT_PROTOCOL}; serving it the empty \
         state (no inbounds, no users) until the agent is upgraded"
    );
    tracing::warn!(node = %node_id, protocol, "{msg}");
    let res = sqlx::query(
        "UPDATE nodes SET last_error = $2, last_error_at = now(), \
             failed_config_version = NULL, failed_user_version = NULL, \
             failed_held_config_version = NULL, failed_held_user_version = NULL, \
             failed_reason = NULL WHERE id = $1",
    )
    .bind(node_id)
    .bind(msg)
    .execute(pg)
    .await;
    if let Err(e) = res {
        tracing::warn!(node = %node_id, error = %e, "failed to record too-old agent");
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
    let _ = sqlx::query("UPDATE nodes SET agent_protocol = $2 WHERE id = $1")
        .bind(node_id)
        .bind(hello.protocol_version as i32)
        .execute(state.pg())
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
        "lease_remaining_seconds": hb.lease_remaining_seconds,
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
    failed_held_config_version: Option<i64>,
    failed_held_user_version: Option<i64>,
    failed_reason: Option<String>,
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
    enabled: bool,
    /// The persisted failed apply, if any.
    failed: Option<DbFailure>,
}

/// The desired state of a node. A disabled node runs nothing (no inbounds,
/// no users). Users are served only if enabled and, for role=user, not
/// expired. The expiry filter uses the DB clock at read time, so any
/// snapshot built after the expiry excludes the user even before the
/// periodic enforcement pass bumps the version. Versions and user set are
/// read in ONE repeatable-read snapshot, so a version always labels the
/// set it was committed with (deltas and state hashes rely on it).
async fn desired_state(pg: &sqlx::PgPool, node_id: Uuid) -> anyhow::Result<Option<Desired>> {
    let mut tx = pg.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let node = sqlx::query_as::<_, NodeRow>(
        "SELECT enabled, xray_inbounds, config_version, user_version, \
         failed_config_version, failed_user_version, failed_held_config_version, \
         failed_held_user_version, failed_reason FROM nodes WHERE id = $1",
    )
    .bind(node_id)
    .fetch_optional(&mut *tx)
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
        .fetch_all(&mut *tx)
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
                        // serde_json (no preserve_order): compact, keys
                        // sorted — the canonical form the state hash uses.
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
    tx.commit().await?;

    Ok(Some(Desired {
        snapshot: ConfigSnapshot {
            config_version: node.config_version as u64,
            inbounds_json,
            user_version: node.user_version as u64,
            users,
        },
        enabled: node.enabled,
        failed: node
            .failed_config_version
            .zip(node.failed_user_version)
            .map(|(c, u)| DbFailure {
                versions: (c as u64, u as u64),
                held: (
                    node.failed_held_config_version.unwrap_or(0) as u64,
                    node.failed_held_user_version.unwrap_or(0) as u64,
                ),
                no_ack: node.failed_reason.as_deref() == Some("no_ack"),
            }),
    }))
}

/// Persist how long the node's current lease runs (NodeView), at most
/// every 30 s per session.
const LEASE_WRITE_EVERY: Duration = Duration::from_secs(30);

/// Brings the agent to the desired state if it does not run it (either
/// direction, to survive panel rollbacks): a UserDelta when only the user
/// set changed since a state the agent verifiably runs, otherwise a full
/// Snapshot — subject to SyncState's pending/backoff rules. Every successful
/// read of the desired state renews the agent's fail-closed lease (sent
/// BEFORE any snapshot, so an agent whose lease ran out keeps what it
/// rebuilds); a failed read grants nothing.
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
    let now = Instant::now();
    let snap = desired.snapshot;
    let want = (snap.config_version, snap.user_version);
    let set = Arc::new(NodeState {
        inbounds: snap.inbounds_json.clone(),
        users: user_set(&snap.users),
    });
    let (plan, grant, write_lease) = {
        let mut st = sync.lock().unwrap();
        let grant = st.hello_seen && !st.too_old();
        let write_lease = grant
            && st
                .lease_written
                .is_none_or(|t| now.duration_since(t) >= LEASE_WRITE_EVERY);
        if write_lease {
            st.lease_written = Some(now);
        }
        let plan = st.decide(ticket, want, &set, desired.enabled, desired.failed, now);
        (plan, grant, write_lease)
    };
    if grant {
        let secs = state.cfg().grpc.lease_seconds();
        tx.send(Ok(PanelDown {
            msg: Some(DownMsg::Lease(LeaseGrant {
                duration_seconds: secs,
                remove_mode: state.cfg().agent.remove_mode.proto() as i32,
            })),
        }))
        .await?;
        if write_lease {
            let _ = sqlx::query(
                "UPDATE nodes SET lease_expires_at = now() + make_interval(secs => $2) \
                 WHERE id = $1",
            )
            .bind(node_id)
            .bind(secs as f64)
            .execute(state.pg())
            .await;
        }
    }
    let Some(plan) = plan else {
        return Ok(());
    };
    let msg = match plan {
        Plan::Snapshot { empty: true } => {
            tracing::info!(node = %node_id, "sending the empty state to a too-old agent");
            DownMsg::Snapshot(ConfigSnapshot {
                config_version: 0,
                inbounds_json: "[]".into(),
                user_version: 0,
                users: vec![],
            })
        }
        Plan::Snapshot { empty: false } => {
            tracing::info!(
                node = %node_id,
                config_version = snap.config_version,
                user_version = snap.user_version,
                users = snap.users.len(),
                inbounds_json_len = snap.inbounds_json.len(),
                "sending snapshot"
            );
            DownMsg::Snapshot(snap)
        }
        Plan::Delta { base, base_set } => {
            let ops = diff_user_sets(&base_set.users, &set.users);
            tracing::info!(
                node = %node_id,
                base_config_version = base.0,
                base_user_version = base.1,
                user_version = want.1,
                ops = ops.len(),
                "sending user delta"
            );
            DownMsg::Delta(UserDelta {
                user_version: want.1,
                ops,
                base_config_version: base.0,
                base_user_version: base.1,
                config_version: want.0,
            })
        }
    };
    if let Err(e) = tx.send(Ok(PanelDown { msg: Some(msg) })).await {
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

    fn empty() -> Arc<NodeState> {
        Arc::new(NodeState::default())
    }

    /// decide() with a fresh ticket taken now (the common case), no user
    /// set and deltas disabled: "was anything sent?".
    fn d(s: &mut SyncState, want: (u64, u64), failed: Option<DbFailure>, now: Instant) -> bool {
        let t = s.ticket();
        s.decide(t, want, &empty(), false, failed, now).is_some()
    }

    /// A protocol-current Hello without a state hash.
    fn hello(s: &mut SyncState, held: (u64, u64)) {
        s.on_hello(held, MIN_AGENT_PROTOCOL, "");
    }

    /// A protocol-0 style Ack (no reason / held fields).
    fn ack(s: &mut SyncState, ok: bool, v: (u64, u64), now: Instant) -> AckOutcome {
        s.on_ack(
            &crate::gen::Ack {
                config_version: v.0,
                user_version: v.1,
                ok,
                ..Default::default()
            },
            now,
        )
    }

    #[test]
    fn sync_sends_once_until_acked() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        hello(&mut s, (1, 1));
        assert!(!d(&mut s, (1, 1), None, t0), "converged");
        assert!(d(&mut s, (2, 1), None, t0));
        assert!(!d(&mut s, (2, 1), None, t0), "pending: no resend storm");
        assert!(
            d(&mut s, (3, 1), None, t0),
            "new desired state goes out at once"
        );
        ack(&mut s, true, (3, 1), t0);
        assert!(!d(&mut s, (3, 1), None, t0));
    }

    /// L3: a lost ack (pending timeout) is a failure -> backoff, not resend.
    #[test]
    fn pending_timeout_counts_as_failure() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        hello(&mut s, (1, 1));
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
        hello(&mut s, (1, 1));
        assert!(d(&mut s, (2, 1), None, t0));
        // Agent fails: keeps (1,1), Ack reports the attempted (2,1).
        ack(&mut s, false, (2, 1), t0);
        hello(&mut s, (1, 1));
        // L2: no DB record needed (db_failed = None) to honour the backoff.
        assert!(!d(&mut s, (2, 1), None, t0), "no immediate retry");
        assert!(!d(&mut s, (2, 1), None, t0 + Duration::from_secs(29)));
        let t1 = t0 + Duration::from_secs(30);
        assert!(d(&mut s, (2, 1), None, t1), "retry after backoff");
        ack(&mut s, false, (2, 1), t1);
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

    fn nack(v: (u64, u64), held: (u64, u64)) -> Option<DbFailure> {
        Some(DbFailure {
            versions: v,
            held,
            no_ack: false,
        })
    }

    #[test]
    fn new_session_waits_for_backoff_on_known_failure() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        hello(&mut s, (1, 1));
        let f = nack((2, 1), (1, 1));
        assert!(!d(&mut s, (2, 1), f, t0));
        assert!(d(&mut s, (2, 1), f, t0 + retry_backoff(0)));
    }

    /// N3: the stream flapped while the disable snapshot was in flight
    /// (no-ack failure). The next session sends it immediately once —
    /// no >= 30 s access leak — then backs off if it fails again.
    #[test]
    fn no_ack_failure_gets_one_immediate_send_per_session() {
        let t0 = Instant::now();
        let f = Some(DbFailure {
            versions: (2, 1),
            held: (1, 1),
            no_ack: true,
        });
        let mut s = SyncState::default();
        hello(&mut s, (1, 1));
        assert!(d(&mut s, (2, 1), f, t0), "immediate send after a flap");
        ack(&mut s, false, (2, 1), t0);
        assert!(!d(&mut s, (2, 1), f, t0), "a real failure then backs off");
        // Lost again (still no ack): the next session gets its one try too.
        let mut s2 = SyncState::default();
        hello(&mut s2, (1, 1));
        assert!(d(&mut s2, (2, 1), f, t0));
        s2.pending = None;
        assert!(!d(&mut s2, (2, 1), f, t0), "only once per session");
    }

    /// N3: the agent restarted mid-apply (Hello (0,0)) or otherwise holds
    /// different versions than when it failed: no backoff.
    #[test]
    fn changed_agent_state_skips_backoff() {
        let t0 = Instant::now();
        let f = nack((2, 1), (1, 1));
        let mut s = SyncState::default();
        hello(&mut s, (0, 0));
        assert!(d(&mut s, (2, 1), f, t0), "restarted agent");
        let mut s = SyncState::default();
        hello(&mut s, (1, 0));
        assert!(d(&mut s, (2, 1), f, t0), "held differs from failure time");
    }

    /// Red team M1: the Hello path read v5 before a commit, the watcher
    /// read v6 after it and sent first; the late v5 must not go out.
    #[test]
    fn stale_desired_after_newer_is_sent() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        hello(&mut s, (4, 4));
        let hello_ticket = s.ticket(); // Hello path reads (5,5) ...
        let watch_ticket = s.ticket(); // ... watcher reads (6,6) later
        assert!(s
            .decide(watch_ticket, (6, 6), &empty(), false, None, t0)
            .is_some());
        assert!(
            s.decide(hello_ticket, (5, 5), &empty(), false, None, t0)
                .is_none(),
            "stale v5 after v6"
        );
        // An older ticket that nevertheless read newer data still counts.
        let mut s = SyncState::default();
        hello(&mut s, (0, 0));
        let t_old = s.ticket();
        let t_new = s.ticket();
        assert!(s.decide(t_new, (6, 6), &empty(), false, None, t0).is_some());
        assert!(s.decide(t_old, (7, 7), &empty(), false, None, t0).is_some());
    }

    /// Red team L1: the ack of an older snapshot must not clear the pending
    /// newer one (which would then be resent while in flight).
    #[test]
    fn older_ack_does_not_clear_newer_pending() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        hello(&mut s, (4, 4));
        assert!(d(&mut s, (5, 5), None, t0));
        assert!(d(&mut s, (6, 6), None, t0));
        ack(&mut s, true, (5, 5), t0);
        assert!(!d(&mut s, (6, 6), None, t0), "v6 resent while in flight");
    }

    fn op(user: &str, creds: &[(&str, &str)]) -> UserOp {
        UserOp {
            op: UserOpKind::Add as i32,
            user_id: user.into(),
            inbound_users: creds
                .iter()
                .map(|(tag, acct)| InboundUser {
                    inbound_tag: (*tag).into(),
                    account_json: (*acct).into(),
                    protocol: "vless".into(),
                })
                .collect(),
        }
    }

    fn set_of(ops: &[UserOp]) -> Arc<NodeState> {
        Arc::new(NodeState {
            inbounds: "[]".into(),
            users: user_set(ops),
        })
    }

    /// A protocol-current Ack as the new agent sends it.
    fn ack_v1(
        v: (u64, u64),
        reason: crate::gen::ack::Reason,
        held: (u64, u64),
        hash: String,
    ) -> crate::gen::Ack {
        crate::gen::Ack {
            config_version: v.0,
            user_version: v.1,
            ok: reason == crate::gen::ack::Reason::Ok,
            reason: reason as i32,
            held_config_version: held.0,
            held_user_version: held.1,
            state_hash: hash,
            error: String::new(),
        }
    }

    /// Shared vectors with the agent (proto/state_hash_vectors.json).
    #[test]
    fn state_hash_matches_shared_vectors() {
        #[derive(serde::Deserialize)]
        struct Iu {
            inbound_tag: String,
            protocol: String,
            account_json: String,
        }
        #[derive(serde::Deserialize)]
        struct U {
            user_id: String,
            inbound_users: Vec<Iu>,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            config_version: u64,
            inbounds_json: String,
            users: Vec<U>,
            hash: String,
        }
        #[derive(serde::Deserialize)]
        struct F {
            cases: Vec<Case>,
        }
        let f: F = serde_json::from_str(include_str!("../proto/state_hash_vectors.json")).unwrap();
        assert!(f.cases.len() >= 10);
        for c in f.cases {
            let ops: Vec<UserOp> = c
                .users
                .into_iter()
                .map(|u| UserOp {
                    op: UserOpKind::Add as i32,
                    user_id: u.user_id,
                    inbound_users: u
                        .inbound_users
                        .into_iter()
                        .map(|i| InboundUser {
                            inbound_tag: i.inbound_tag,
                            account_json: i.account_json,
                            protocol: i.protocol,
                        })
                        .collect(),
                })
                .collect();
            assert_eq!(
                state_hash(
                    c.config_version,
                    &NodeState {
                        inbounds: c.inbounds_json,
                        users: user_set(&ops)
                    }
                ),
                c.hash,
                "{}",
                c.name
            );
        }
    }

    #[test]
    fn delta_diff_add_remove_replace_noop() {
        let base = user_set(&[
            op("a", &[("t1", "{\"id\":\"a\"}")]),
            op("b", &[("t1", "{\"id\":\"b\"}"), ("t2", "{\"id\":\"b\"}")]),
            op("c", &[("t1", "{\"id\":\"c\"}")]),
        ]);
        let want = user_set(&[
            op("a", &[("t1", "{\"id\":\"a\"}")]),  // unchanged
            op("b", &[("t1", "{\"id\":\"b2\"}")]), // rotated + dropped t2
            op("d", &[("t2", "{\"id\":\"d\"}")]),  // added
                                                   // c removed
        ]);
        let ops = diff_user_sets(&base, &want);
        let by: BTreeMap<&str, &UserOp> = ops.iter().map(|o| (o.user_id.as_str(), o)).collect();
        assert_eq!(ops.len(), 3, "{ops:?}");
        assert!(!by.contains_key("a"), "unchanged user is not sent");
        let b = by["b"];
        assert_eq!(b.op, UserOpKind::Add as i32);
        assert_eq!(b.inbound_users.len(), 1, "REPLACE carries the full list");
        assert_eq!(b.inbound_users[0].account_json, "{\"id\":\"b2\"}");
        assert_eq!(by["c"].op, UserOpKind::Remove as i32);
        assert_eq!(by["d"].op, UserOpKind::Add as i32);
        assert!(diff_user_sets(&want, &want).is_empty(), "no-op");
        // Applying the ops (REPLACE semantics) to base yields want.
        let mut applied = base.clone();
        for o in &ops {
            applied.remove(&o.user_id);
            applied.extend(user_set(std::slice::from_ref(o)));
        }
        assert_eq!(applied, want);
    }

    /// Convergence to (c,u) with set `set` acked by a v1 agent.
    fn converge(s: &mut SyncState, v: (u64, u64), set: &Arc<NodeState>, t: Instant) {
        let tk = s.ticket();
        assert!(matches!(
            s.decide(tk, v, set, true, None, t),
            Some(Plan::Snapshot { empty: false })
        ));
        let h = state_hash(v.0, set);
        assert_eq!(
            s.on_ack(&ack_v1(v, crate::gen::ack::Reason::Ok, v, h), t),
            AckOutcome::Converged
        );
    }

    #[test]
    fn user_only_change_sends_a_delta_inbound_change_a_snapshot() {
        let t0 = Instant::now();
        let s1 = set_of(&[op("a", &[("t", "1")])]);
        let s2 = set_of(&[op("a", &[("t", "1")]), op("b", &[("t", "2")])]);
        let mut s = SyncState::default();
        s.on_hello(
            (0, 0),
            MIN_AGENT_PROTOCOL,
            &state_hash(0, &NodeState::default()),
        );
        converge(&mut s, (2, 5), &s1, t0);

        let tk = s.ticket();
        match s.decide(tk, (2, 6), &s2, true, None, t0) {
            Some(Plan::Delta { base, base_set }) => {
                assert_eq!(base, (2, 5));
                assert_eq!(*base_set, *s1);
            }
            p => panic!("want delta, got {p:?}"),
        }
        let h = state_hash(2, &s2);
        assert_eq!(
            s.on_ack(&ack_v1((2, 6), crate::gen::ack::Reason::Ok, (2, 6), h), t0),
            AckOutcome::Converged
        );
        // Inbound change: snapshot.
        let tk = s.ticket();
        assert!(matches!(
            s.decide(tk, (3, 6), &s2, true, None, t0),
            Some(Plan::Snapshot { empty: false })
        ));
        // Disabled node (can_delta = false): snapshot even for a user change.
        let mut s = SyncState::default();
        s.on_hello((0, 0), MIN_AGENT_PROTOCOL, "");
        converge(&mut s, (2, 5), &s1, t0);
        let tk = s.ticket();
        assert!(matches!(
            s.decide(tk, (2, 6), &s2, false, None, t0),
            Some(Plan::Snapshot { .. })
        ));
    }

    /// A new session only deltas from a state it verified: a Hello whose
    /// hash matches the desired set at the held versions counts; no hash
    /// or a mismatch means Snapshot (the latter even at equal versions).
    #[test]
    fn new_session_verifies_before_delta() {
        let t0 = Instant::now();
        let s1 = set_of(&[op("a", &[("t", "1")])]);
        let s2 = set_of(&[op("b", &[("t", "2")])]);

        let mut s = SyncState::default();
        s.on_hello((2, 5), MIN_AGENT_PROTOCOL, &state_hash(2, &s1));
        assert!(d_set(&mut s, (2, 5), &s1).is_none(), "verified, converged");
        assert!(matches!(
            d_set(&mut s, (2, 6), &s2),
            Some(Plan::Delta { .. })
        ));

        let mut s = SyncState::default();
        s.on_hello((2, 5), MIN_AGENT_PROTOCOL, "");
        assert!(d_set(&mut s, (2, 5), &s1).is_none());
        assert!(matches!(
            d_set(&mut s, (2, 6), &s2),
            Some(Plan::Snapshot { empty: false })
        ));

        let mut s = SyncState::default();
        s.on_hello((2, 5), MIN_AGENT_PROTOCOL, &state_hash(2, &s2));
        assert!(
            matches!(
                d_set(&mut s, (2, 5), &s1),
                Some(Plan::Snapshot { empty: false })
            ),
            "divergence at equal versions is repaired by a snapshot"
        );
    }

    fn d_set(s: &mut SyncState, v: (u64, u64), set: &Arc<NodeState>) -> Option<Plan> {
        let tk = s.ticket();
        s.decide(tk, v, set, true, None, Instant::now())
    }

    #[test]
    fn base_mismatch_resnapshots_without_backoff() {
        use crate::gen::ack::Reason;
        let t0 = Instant::now();
        let s1 = set_of(&[op("a", &[("t", "1")])]);
        let s2 = set_of(&[op("b", &[("t", "2")])]);
        let mut s = SyncState::default();
        s.on_hello((0, 0), MIN_AGENT_PROTOCOL, "");
        converge(&mut s, (2, 5), &s1, t0);
        assert!(matches!(
            d_set(&mut s, (2, 6), &s2),
            Some(Plan::Delta { .. })
        ));
        // The agent actually holds something else.
        let out = s.on_ack(
            &ack_v1((2, 6), Reason::BaseMismatch, (2, 4), String::new()),
            t0,
        );
        assert_eq!(out, AckOutcome::Resync);
        assert_eq!(s.held, (2, 4));
        assert!(s.failed.is_none(), "not a failure");
        assert!(
            matches!(
                d_set(&mut s, (2, 6), &s2),
                Some(Plan::Snapshot { empty: false })
            ),
            "immediate snapshot"
        );
    }

    #[test]
    fn failed_delta_falls_back_to_snapshot_under_backoff() {
        use crate::gen::ack::Reason;
        let t0 = Instant::now();
        let s1 = set_of(&[op("a", &[("t", "1")])]);
        let s2 = set_of(&[op("b", &[("t", "2")])]);
        let mut s = SyncState::default();
        s.on_hello((0, 0), MIN_AGENT_PROTOCOL, "");
        converge(&mut s, (2, 5), &s1, t0);
        assert!(matches!(
            d_set(&mut s, (2, 6), &s2),
            Some(Plan::Delta { .. })
        ));
        let mut a = ack_v1((2, 6), Reason::ApplyFailed, (2, 5), String::new());
        a.error = "boom".into();
        assert_eq!(s.on_ack(&a, t0), AckOutcome::Failed("boom".into()));
        let tk = s.ticket();
        assert!(
            s.decide(tk, (2, 6), &s2, true, None, t0).is_none(),
            "backoff"
        );
        let tk = s.ticket();
        assert!(matches!(
            s.decide(tk, (2, 6), &s2, true, None, t0 + retry_backoff(0)),
            Some(Plan::Snapshot { empty: false })
        ));
    }

    #[test]
    fn hash_mismatch_triggers_snapshot_and_repeated_mismatch_backs_off() {
        use crate::gen::ack::Reason;
        let t0 = Instant::now();
        let s1 = set_of(&[op("a", &[("t", "1")])]);
        let s2 = set_of(&[op("b", &[("t", "2")])]);
        let mut s = SyncState::default();
        s.on_hello((0, 0), MIN_AGENT_PROTOCOL, "");
        converge(&mut s, (2, 5), &s1, t0);
        assert!(matches!(
            d_set(&mut s, (2, 6), &s2),
            Some(Plan::Delta { .. })
        ));
        // Delta acked ok, but the agent's state is not what it should be.
        let bogus = state_hash(2, &s1);
        assert_eq!(
            s.on_ack(&ack_v1((2, 6), Reason::Ok, (2, 6), bogus.clone()), t0),
            AckOutcome::Resync
        );
        assert!(
            matches!(
                d_set(&mut s, (2, 6), &s2),
                Some(Plan::Snapshot { empty: false })
            ),
            "repair snapshot at equal versions"
        );
        // Even the snapshot's ack disagrees: a failure, backoff (no storm).
        assert!(matches!(
            s.on_ack(&ack_v1((2, 6), Reason::Ok, (2, 6), bogus), t0),
            AckOutcome::Failed(_)
        ));
        assert!(d_set(&mut s, (2, 6), &s2).is_none());
        let tk = s.ticket();
        assert!(s
            .decide(tk, (2, 6), &s2, true, None, t0 + retry_backoff(0))
            .is_some());
    }

    /// Chained deltas: a change while a delta is in flight builds on it.
    #[test]
    fn delta_chains_on_in_flight_state() {
        let t0 = Instant::now();
        let s1 = set_of(&[op("a", &[("t", "1")])]);
        let s2 = set_of(&[op("b", &[("t", "2")])]);
        let s3 = set_of(&[op("c", &[("t", "3")])]);
        let mut s = SyncState::default();
        s.on_hello((0, 0), MIN_AGENT_PROTOCOL, "");
        converge(&mut s, (2, 5), &s1, t0);
        assert!(matches!(
            d_set(&mut s, (2, 6), &s2),
            Some(Plan::Delta { .. })
        ));
        match d_set(&mut s, (2, 7), &s3) {
            Some(Plan::Delta { base, base_set }) => {
                assert_eq!(base, (2, 6));
                assert_eq!(*base_set, *s2);
            }
            p => panic!("{p:?}"),
        }
    }

    /// N5: a protocol-0 agent gets the empty state once per session whatever
    /// it claims, its acks are ignored, and it never gets deltas.
    #[test]
    fn old_protocol_agent_gets_empty_state_once() {
        let t0 = Instant::now();
        let s1 = set_of(&[op("a", &[("t", "1")])]);
        let mut s = SyncState::default();
        s.on_hello((0, 0), 0, "ignored");
        assert!(s.too_old());
        assert!(matches!(
            d_set(&mut s, (2, 5), &s1),
            Some(Plan::Snapshot { empty: true })
        ));
        assert_eq!(s.pending.unwrap().versions, (0, 0));
        assert!(d_set(&mut s, (2, 5), &s1).is_none(), "in flight");
        assert_eq!(ack(&mut s, true, (0, 0), t0), AckOutcome::Ignore);
        assert!(
            d_set(&mut s, (2, 6), &s1).is_none(),
            "done for this session"
        );
        // Claims to run something: pushed again.
        s.on_hello((2, 5), 0, "");
        assert!(matches!(
            d_set(&mut s, (2, 6), &s1),
            Some(Plan::Snapshot { empty: true })
        ));
        assert!(matches!(ack(&mut s, false, (0, 0), t0), AckOutcome::Ignore));
    }

    /// Lease expiry on the agent: it tears down and says Hello (0,0) with an
    /// empty hash. Whatever was verified before, the next sync is a
    /// Snapshot, with no backoff from an old failure.
    #[test]
    fn teardown_hello_forces_snapshot() {
        let t0 = Instant::now();
        let s1 = set_of(&[op("a", &[("t", "1")])]);
        let mut s = SyncState::default();
        s.on_hello((0, 0), MIN_AGENT_PROTOCOL, "");
        converge(&mut s, (2, 5), &s1, t0);
        s.on_hello(
            (0, 0),
            MIN_AGENT_PROTOCOL,
            &state_hash(0, &NodeState::default()),
        );
        let f = nack((2, 5), (2, 4));
        let tk = s.ticket();
        assert!(matches!(
            s.decide(tk, (2, 5), &s1, true, f, t0),
            Some(Plan::Snapshot { empty: false })
        ));
    }

    /// R10 fallback switch: in rebuild mode a removal or rotation is a
    /// Snapshot, a pure addition still a delta; gate mode deltas both.
    #[test]
    fn remove_mode_gate_vs_rebuild() {
        let t0 = Instant::now();
        let s1 = set_of(&[op("a", &[("t", "1")]), op("b", &[("t", "2")])]);
        let add = set_of(&[
            op("a", &[("t", "1")]),
            op("b", &[("t", "2")]),
            op("c", &[("t", "3")]),
        ]);
        let remove = set_of(&[op("a", &[("t", "1")])]);
        let rotate = set_of(&[op("a", &[("t", "1")]), op("b", &[("t", "9")])]);
        assert!(!drops_credential(&s1.users, &add.users));
        assert!(drops_credential(&s1.users, &remove.users));
        assert!(drops_credential(&s1.users, &rotate.users));
        for (rebuild, want, delta) in [
            (false, &add, true),
            (false, &remove, true),
            (false, &rotate, true),
            (true, &add, true),
            (true, &remove, false),
            (true, &rotate, false),
        ] {
            let mut s = SyncState {
                remove_rebuild: rebuild,
                ..Default::default()
            };
            s.on_hello((0, 0), MIN_AGENT_PROTOCOL, "");
            converge(&mut s, (2, 5), &s1, t0);
            let plan = d_set(&mut s, (2, 6), want);
            assert_eq!(
                matches!(plan, Some(Plan::Delta { .. })),
                delta,
                "rebuild={rebuild} plan={plan:?}"
            );
        }
    }

    #[test]
    fn nothing_is_sent_before_hello() {
        let mut s = SyncState::default();
        assert!(d_set(&mut s, (2, 5), &empty()).is_none());
    }

    /// N5 status: a too-old agent is surfaced in last_error; the next
    /// protocol-current Hello clears it.
    #[tokio::test]
    async fn too_old_agent_status_recorded_and_cleared() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        record_too_old(&db.pool, n, 0).await;
        let err: Option<String> = sqlx::query_scalar("SELECT last_error FROM nodes WHERE id = $1")
            .bind(n)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(err.unwrap().contains("agent too old"));
        record_converged(&db.pool, n, (0, 0)).await;
        let err: Option<String> = sqlx::query_scalar("SELECT last_error FROM nodes WHERE id = $1")
            .bind(n)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(err.is_none());
        db.drop().await;
    }

    /// The desired state is read in one snapshot and hashes like the agent
    /// would hash what it applied from it.
    #[tokio::test]
    async fn desired_state_set_and_hash() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let d = desired_state(&db.pool, n).await.unwrap().unwrap();
        assert!(d.enabled);
        let set = user_set(&d.snapshot.users);
        assert_eq!(
            set[&u.to_string()]["in-vless"],
            ("vless".to_string(), "{\"id\":\"x\"}".to_string())
        );
        let st = NodeState {
            inbounds: d.snapshot.inbounds_json.clone(),
            users: set,
        };
        assert_eq!(state_hash(1, &st).len(), 64);
        db.drop().await;
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
