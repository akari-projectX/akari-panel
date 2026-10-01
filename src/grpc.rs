use std::collections::{BTreeMap, VecDeque};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, Notify};
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
        let identity = identify_node(&state, &request).await?;

        // Disabled nodes are NOT rejected: a rejected agent would keep its
        // last xray config running forever. They are accepted and converge
        // to the disabled desired state (no inbounds, no users). For the
        // same reason a revoked (deleted node's) certificate is accepted,
        // served the empty state and closed (R12 D2).
        let (tx, rx) = mpsc::channel::<Result<PanelDown, Status>>(64);
        tokio::spawn(session(state.clone(), identity, request.into_inner(), tx));
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}

/// Maps the peer certificate serial to a registered node.
async fn identify_node(
    state: &AppState,
    req: &Request<Streaming<AgentUp>>,
) -> Result<AgentIdentity, Status> {
    let certs = req
        .peer_certs()
        .ok_or_else(|| Status::unauthenticated("missing client certificate"))?;
    let der = certs
        .first()
        .ok_or_else(|| Status::unauthenticated("missing client certificate"))?;
    let (_, cert) = X509Certificate::from_der(der.as_ref())
        .map_err(|_| Status::unauthenticated("malformed certificate"))?;
    let serial = crate::install::normalize_serial(cert.raw_serial());
    node_for_serial(state.pg(), &serial).await
}

/// Who a certificate serial belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentIdentity {
    Node(Uuid),
    /// A deleted node's tombstoned certificate: served the empty state,
    /// never trusted with traffic, then closed.
    Revoked(Uuid),
}

/// The node a certificate serial belongs to. The revocation tombstones are
/// consulted FIRST: a revoked serial stays revoked even if some node row
/// carried it again (the DB also refuses that, migration 0007). Only
/// serials that are neither registered nor tombstoned are refused.
pub(crate) async fn node_for_serial(
    pg: &sqlx::PgPool,
    serial: &str,
) -> Result<AgentIdentity, Status> {
    let (revoked, id): (Option<Uuid>, Option<Uuid>) = sqlx::query_as(
        "SELECT (SELECT node_id FROM revoked_certs WHERE cert_serial = $1), \
                (SELECT id FROM nodes WHERE cert_serial = $1)",
    )
    .bind(serial)
    .fetch_one(pg)
    .await
    .map_err(|e| {
        // Details stay in the log; the agent learns nothing about the DB.
        tracing::error!(serial, error = %e, "certificate lookup failed");
        Status::unavailable("temporarily unavailable")
    })?;
    if let Some(node) = revoked {
        return Ok(AgentIdentity::Revoked(node));
    }
    id.map(AgentIdentity::Node)
        .ok_or_else(|| Status::unauthenticated("unknown certificate"))
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
    /// The last Hello's claim (versions, hash), kept for `runs_empty`.
    hello_claim: Option<((u64, u64), String)>,
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
        self.hello_claim = (!self.too_old()).then(|| (held, hash.to_string()));
    }

    /// Does the agent verifiably run the empty state (no inbounds, no
    /// users) right now? Either acked in this session, or its Hello's hash
    /// is the empty state's at the versions it still holds. A too-old
    /// agent's claims are never trusted.
    fn runs_empty(&self) -> bool {
        if self.too_old() {
            return false;
        }
        let empty = |v: u64| {
            state_hash(
                v,
                &NodeState {
                    inbounds: "[]".into(),
                    users: UserSet::new(),
                },
            )
        };
        if let Some((v, set)) = &self.acked {
            if *v == self.held && set.inbounds == "[]" && set.users.is_empty() {
                return true;
            }
        }
        matches!(&self.hello_claim, Some((v, h)) if *v == self.held && *h == empty(v.0))
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

/// One agent stream. Shared by the stream reader and the watcher task.
struct Session {
    state: AppState,
    node_id: Uuid,
    tx: mpsc::Sender<Result<PanelDown, Status>>,
    sync: Mutex<SyncState>,
    /// R12 P1: held across a whole `sync_if_stale` (ticket → DB read →
    /// decide → LeaseGrant/Snapshot/Delta sends) and around every other
    /// send, so what is decided later is never sent earlier.
    send_lock: tokio::sync::Mutex<()>,
    /// Sticky: nothing is sent after it. Set by `terminate`, which never
    /// needs `send_lock` (R13: a wedged peer cannot keep a superseded,
    /// deleted or timed-out session alive).
    terminated: AtomicBool,
    /// Flips to true on termination; every lock wait, send and the reader
    /// race it.
    closed: tokio::sync::watch::Sender<bool>,
    /// The node is gone or the certificate revoked: only the empty state
    /// and the close are sent; traffic reports are ignored.
    retiring: AtomicBool,
    /// Last desired-state read said the node is being deleted (phase 1).
    deleting: AtomicBool,
    /// This session marked the node online (nodes.online_session).
    marked_online: AtomicBool,
    /// A pre-Hello traffic report was dropped (logged once per session).
    pre_hello_warned: AtomicBool,
    online_session: Uuid,
    /// A reader-side read found the node gone: the watcher retires.
    gone: Notify,
    /// Hello / ack of the empty state, while retiring.
    hello: Notify,
    retire_ack: Notify,
}

impl Session {
    fn new(
        state: AppState,
        node_id: Uuid,
        tx: mpsc::Sender<Result<PanelDown, Status>>,
        revoked: bool,
    ) -> Arc<Self> {
        let sess = Arc::new(Session {
            node_id,
            tx,
            sync: Mutex::default(),
            send_lock: tokio::sync::Mutex::new(()),
            terminated: AtomicBool::new(false),
            retiring: AtomicBool::new(revoked),
            deleting: AtomicBool::new(false),
            marked_online: AtomicBool::new(false),
            pre_hello_warned: AtomicBool::new(false),
            online_session: Uuid::new_v4(),
            gone: Notify::new(),
            closed: tokio::sync::watch::channel(false).0,
            hello: Notify::new(),
            retire_ack: Notify::new(),
            state,
        });
        sess.sync.lock().unwrap().remove_rebuild =
            sess.state.cfg().agent.remove_mode == crate::config::RemoveMode::Rebuild;
        sess
    }

    fn terminated(&self) -> bool {
        self.terminated.load(Ordering::SeqCst)
    }
    fn retiring(&self) -> bool {
        self.retiring.load(Ordering::SeqCst)
    }

    /// Resolves once the session is terminated.
    async fn cancelled(&self) {
        let mut rx = self.closed.subscribe();
        let _ = rx.wait_for(|c| *c).await;
    }

    /// The send lock, unless the session terminates first.
    async fn lock(&self) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        tokio::select! {
            g = self.send_lock.lock() => (!self.terminated()).then_some(g),
            _ = self.cancelled() => None,
        }
    }

    /// Send under the send lock unless the session is terminated. Returns
    /// whether it was sent. A peer that does not take the message within
    /// SEND_TIMEOUT (stopped reading) gets the session terminated.
    async fn send(
        &self,
        _guard: &tokio::sync::MutexGuard<'_, ()>,
        msg: DownMsg,
    ) -> anyhow::Result<bool> {
        if self.terminated() {
            return Ok(false);
        }
        tokio::select! {
            r = self.tx.send(Ok(PanelDown { msg: Some(msg) })) => {
                r?;
                Ok(true)
            }
            _ = self.cancelled() => Ok(false),
            _ = tokio::time::sleep(SEND_TIMEOUT) => {
                tracing::warn!(node = %self.node_id, "agent stopped reading its stream; closing it");
                self.terminate(Status::deadline_exceeded("agent not reading its stream"));
                Ok(false)
            }
        }
    }

    /// End the stream with `status` (once; sticky) and stop the reader and
    /// the watcher. Needs no lock and never waits: if the peer's buffer is
    /// full the status is dropped and the stream just ends.
    fn terminate(&self, status: Status) {
        if !self.terminated.swap(true, Ordering::SeqCst) {
            let _ = self.tx.try_send(Err(status));
        }
        self.closed.send_replace(true);
    }
}

/// Status message of streams ended by a panel shutdown (S4-3); agents
/// reconnect (to this instance once it is back, or another one).
pub const SHUTDOWN_MESSAGE: &str = "panel shutting down";

/// Upper bound of the random delay before re-reading after a wake-all.
const WAKE_ALL_JITTER_MS: u64 = 2000;

/// A send the peer does not accept within this long ends the session.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a retiring agent gets for its Hello and for acking the empty
/// state before its stream is closed anyway.
const RETIRE_WAIT: Duration = Duration::from_secs(10);

/// The versions of the empty state pushed to a retiring agent.
const RETIRED_VERSIONS: (u64, u64) = (0, 0);

async fn session<S>(
    state: AppState,
    identity: AgentIdentity,
    mut inbound: S,
    tx: mpsc::Sender<Result<PanelDown, Status>>,
) where
    S: Stream<Item = Result<AgentUp, Status>> + Unpin + Send + 'static,
{
    use crate::gen::agent_up::Msg as UpMsg;

    let _live = state.session_started();
    let (node_id, revoked) = match identity {
        AgentIdentity::Node(n) => (n, false),
        AgentIdentity::Revoked(n) => (n, true),
    };
    tracing::info!(node = %node_id, revoked, "agent connected");
    // Subscribe BEFORE the membership load and the first read of the
    // desired state, so no committed change can fall between them.
    let mut wake_rx = state.wakeups().subscribe(node_id);
    let sess = Session::new(state.clone(), node_id, tx, revoked);
    let gen = state.next_gen();
    if !revoked {
        // One live stream per node on this instance: the newest wins.
        let entry = crate::state::AgentEntry {
            gen,
            online_session: sess.online_session,
            close: {
                let weak = Arc::downgrade(&sess);
                Arc::new(move |status: Status| {
                    if let Some(s) = weak.upgrade() {
                        s.terminate(status);
                    }
                })
            },
        };
        if let Some(old) = state.agents().insert(node_id, entry) {
            (old.close)(Status::aborted("superseded by a newer stream"));
        }
        // Traffic is only accepted for assigned users; load them before the
        // first report can arrive.
        refresh_members(&state, node_id).await;
    }

    // Push state on this node's wakeups (pg_notify, see notify.rs), and
    // reconcile periodically. A node found gone (or a revoked certificate)
    // is retired: empty state, then the stream is closed.
    let w = sess.clone();
    let watcher = tokio::spawn(async move {
        let sess = w;
        if revoked {
            retire(&sess, "certificate revoked").await;
            return;
        }
        let mut tick = tokio::time::interval(RECONCILE_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await; // the first tick is immediate; Hello covers it
        let mut seen = *wake_rx.borrow_and_update();
        loop {
            tokio::select! {
                r = wake_rx.changed() => {
                    if r.is_err() { break }
                    let now = *wake_rx.borrow_and_update();
                    if crate::notify::is_wake_all(seen, now) {
                        // Every local session was woken at once: spread
                        // the re-reads (the read permits bound them too).
                        let ms = rand::random_range(0..WAKE_ALL_JITTER_MS);
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                            _ = sess.cancelled() => break,
                        }
                    }
                    seen = now;
                },
                _ = tick.tick() => {}
                _ = sess.gone.notified() => {
                    retire(&sess, "node deleted").await;
                    break;
                }
                _ = sess.cancelled() => break,
            }
            refresh_members(&sess.state, node_id).await;
            match sync_if_stale(&sess).await {
                Ok(Synced::Current) => {}
                Ok(Synced::Gone) => {
                    retire(&sess, "node deleted").await;
                    break;
                }
                Ok(Synced::Superseded) => {
                    sess.terminate(Status::aborted("superseded by a newer stream"));
                    break;
                }
                Err(e) => tracing::warn!(node = %node_id, error = %e, "config push failed"),
            }
        }
    });

    let result: Result<(), Status> = async {
        loop {
            let msg = tokio::select! {
                m = inbound.next() => match m {
                    Some(m) => m?,
                    None => break,
                },
                _ = sess.cancelled() => break,
                // S4-3: also a session that started after the shutdown
                // began (the value is sticky).
                _ = state.shutdown_begun() => {
                    sess.terminate(Status::unavailable(SHUTDOWN_MESSAGE));
                    break;
                }
            };
            if sess.retiring() {
                // Only the agent's state and the ack of the empty state
                // matter; traffic is never accepted (R12 D2).
                match &msg.msg {
                    Some(UpMsg::Hello(h)) => {
                        sess.sync.lock().unwrap().on_hello(
                            (h.config_version, h.user_version),
                            h.protocol_version,
                            &h.state_hash,
                        );
                        sess.hello.notify_one();
                    }
                    Some(UpMsg::Ack(a))
                        if (a.config_version, a.user_version) == RETIRED_VERSIONS =>
                    {
                        sess.retire_ack.notify_one();
                    }
                    _ => {}
                }
                continue;
            }
            match msg.msg {
                Some(UpMsg::Hello(hello)) => {
                    tracing::info!(
                        node = %node_id,
                        session = %hello.session_id,
                        protocol = hello.protocol_version,
                        "agent hello"
                    );
                    let held = (hello.config_version, hello.user_version);
                    sess.sync.lock().unwrap().on_hello(
                        held,
                        hello.protocol_version,
                        &hello.state_hash,
                    );
                    sess.hello.notify_one();
                    if mark_online(&state, node_id, sess.online_session, &hello).await {
                        sess.marked_online.store(true, Ordering::SeqCst);
                    }
                    if hello.protocol_version < MIN_AGENT_PROTOCOL {
                        // Never trusted for convergence; say why it runs
                        // nothing.
                        record_too_old(state.pg(), node_id, hello.protocol_version).await;
                    } else {
                        // The agent only claims versions it applied cleanly.
                        record_converged(state.pg(), node_id, held).await;
                    }
                    after_sync(
                        &sess,
                        sync_if_stale(&sess).await,
                        "failed to sync after hello",
                    );
                }
                Some(UpMsg::Heartbeat(hb)) => {
                    store_heartbeat(&state, node_id, &hb).await;
                }
                Some(UpMsg::Traffic(report)) => {
                    // R14 N3: nothing is accepted from a stream before its
                    // Hello (the agent always says Hello first).
                    if !sess.sync.lock().unwrap().hello_seen {
                        if !sess.pre_hello_warned.swap(true, Ordering::Relaxed) {
                            tracing::warn!(node = %node_id, "traffic report before hello dropped");
                        }
                        continue;
                    }
                    // Billed per the session the report carries; the agent
                    // reads it atomically with the counters (REVIEW P0 #2).
                    state.traffic().update(node_id, &report.session_id, &report);
                }
                Some(UpMsg::Ack(ack)) => {
                    crate::metrics::ack(
                        crate::gen::ack::Reason::try_from(ack.reason)
                            .unwrap_or(crate::gen::ack::Reason::Unspecified),
                    );
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
                        let mut st = sess.sync.lock().unwrap();
                        let held = st.held;
                        (held, st.on_ack(&ack, Instant::now()))
                    };
                    let v = (ack.config_version, ack.user_version);
                    match outcome {
                        AckOutcome::Converged => {
                            record_converged(state.pg(), node_id, v).await;
                            if sess.deleting.load(Ordering::SeqCst) {
                                mark_delete_acked(state.pg(), node_id, v).await;
                            }
                        }
                        AckOutcome::Failed(msg) => {
                            let f = DbFailure {
                                versions: v,
                                held: held_before,
                                no_ack: false,
                            };
                            record_failure(state.pg(), node_id, f, &msg).await;
                        }
                        AckOutcome::Resync => {
                            after_sync(&sess, sync_if_stale(&sess).await, "failed to resync")
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
    let _ = watcher.await; // drops its wakeup receiver
    state.wakeups().release(node_id);
    let retired = sess.retiring();
    let superseded = !retired && sess.terminated();
    if !revoked {
        state.agents().remove_if(&node_id, |_, e| e.gen == gen);
    }
    // A snapshot still unacked when the stream dies counts as a failed
    // apply, so a crash-looping agent gets backoff instead of resends.
    let lost = {
        let st = sess.sync.lock().unwrap();
        // A too-old agent's answers are not trusted either way; a retired
        // or superseded session's in-flight state is moot.
        st.pending
            .filter(|_| !st.too_old() && !retired && !superseded)
            .map(|p| DbFailure {
                versions: p.versions,
                held: st.held,
                no_ack: true,
            })
    };
    if let Some(f) = lost {
        record_failure(state.pg(), node_id, f, "no ack before the stream closed").await;
    }
    if retired {
        if !revoked {
            forget_node(&state, node_id).await;
        }
    } else {
        let _ = mark_offline(state.pg(), node_id, sess.online_session).await;
        if !state.agents().contains_key(&node_id) {
            // Last local session of the node: its membership cache goes
            // (buffered entries stay until flushed).
            state.traffic().drop_members(node_id);
        }
    }
    if let Err(e) = result {
        tracing::warn!(node = %node_id, error = %e, "agent stream error");
    }
    tracing::info!(node = %node_id, retired, superseded, "agent disconnected");
}

/// Route a reader-side sync result: a gone/superseded node is handled by
/// the watcher (which may wait on the reader).
fn after_sync(sess: &Session, r: anyhow::Result<Synced>, what: &str) {
    match r {
        Ok(Synced::Current) => {}
        Ok(Synced::Gone) => sess.gone.notify_one(),
        Ok(Synced::Superseded) => sess.terminate(Status::aborted("superseded by a newer stream")),
        Err(e) => tracing::warn!(node = %sess.node_id, error = %e, "{what}"),
    }
}

/// The node is gone (deleted) or the certificate revoked: make sure the
/// agent runs the empty state (no inbounds, no users) — pushed at versions
/// (0,0) unless it verifiably runs it already — give it RETIRE_WAIT to ack,
/// then end the stream with UNAUTHENTICATED. A refused agent would keep its
/// last config (R3), hence push-then-close rather than reject.
async fn retire(sess: &Session, why: &'static str) {
    {
        let Some(_g) = sess.lock().await else {
            return;
        };
        sess.retiring.store(true, Ordering::SeqCst);
    }
    let node_id = sess.node_id;
    tracing::info!(node = %node_id, why, "retiring agent session");
    let hello_seen = sess.sync.lock().unwrap().hello_seen;
    if !hello_seen {
        tokio::select! {
            _ = tokio::time::timeout(RETIRE_WAIT, sess.hello.notified()) => {}
            _ = sess.cancelled() => return,
        }
    }
    let empty_already = sess.sync.lock().unwrap().runs_empty();
    if !empty_already {
        let empty = DownMsg::Snapshot(ConfigSnapshot {
            config_version: RETIRED_VERSIONS.0,
            inbounds_json: "[]".into(),
            user_version: RETIRED_VERSIONS.1,
            users: vec![],
        });
        let sent = match sess.lock().await {
            Some(g) => sess.send(&g, empty).await.unwrap_or(false),
            None => return,
        };
        if sent {
            tokio::select! {
                r = tokio::time::timeout(RETIRE_WAIT, sess.retire_ack.notified()) => if r.is_err() {
                    tracing::warn!(node = %node_id, "retiring agent did not ack the empty state; closing anyway");
                },
                _ = sess.cancelled() => return,
            }
        }
    }
    sess.terminate(Status::unauthenticated(why));
}

/// A deleted node's leftovers on this instance: live-status keys and the
/// in-memory traffic state (membership, buffered entries, index).
pub(crate) async fn forget_node(state: &AppState, node_id: Uuid) {
    state.traffic().forget_node(node_id);
    valkey_util::del(
        state,
        vec![
            format!("akari:node:online:{node_id}"),
            format!("akari:node:hb:{node_id}"),
        ],
    )
    .await;
}

/// Phase 1 of a deletion is converged: the agent acked the (empty) state
/// at the node's current versions. Lets phase 2 (reaper) proceed early.
async fn mark_delete_acked(pg: &sqlx::PgPool, node_id: Uuid, versions: (u64, u64)) {
    let res = sqlx::query(
        "UPDATE nodes SET delete_acked_at = now() \
         WHERE id = $1 AND deleting_at IS NOT NULL AND delete_acked_at IS NULL \
           AND NOT enabled AND config_version = $2 AND user_version = $3",
    )
    .bind(node_id)
    .bind(versions.0 as i64)
    .bind(versions.1 as i64)
    .execute(pg)
    .await;
    if let Err(e) = res {
        tracing::warn!(node = %node_id, error = %e, "failed to record the deletion ack");
    }
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

/// Returns whether the node row now names this session as its owner.
async fn mark_online(
    state: &AppState,
    node_id: Uuid,
    online_session: Uuid,
    hello: &crate::gen::Hello,
) -> bool {
    valkey_util::set_online(state, node_id).await;
    let info = hello.info.as_ref();
    let owned = set_online_row(
        state.pg(),
        node_id,
        online_session,
        info.map(|i| i.agent_version.as_str()),
        info.map(|i| i.core_version.as_str()),
        CreditWindow::from_cfg(state.cfg()),
    )
    .await
    .is_ok();
    let _ = sqlx::query("UPDATE nodes SET agent_protocol = $2 WHERE id = $1")
        .bind(node_id)
        .bind(hello.protocol_version as i32)
        .execute(state.pg())
        .await;
    owned
}

/// Mark the node online for this session. Also grants the billing
/// reconnect credit (R13): the time since the node was last seen (min
/// lease) — traffic the agent carried while the panel could not hear it —
/// becomes the caps' credit floor for one burst window. A credit still
/// valid is neither replaced nor extended, and last_seen_at moves to now,
/// so each disconnection can be claimed once.
async fn set_online_row(
    pg: &sqlx::PgPool,
    node_id: Uuid,
    online_session: Uuid,
    agent_version: Option<&str>,
    core_version: Option<&str>,
    credit: CreditWindow,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE nodes SET status = 'online', agent_version = $1, core_version = $2, \
         online_session = $4, last_seen_at = now(), \
         traffic_credit_floor = CASE WHEN traffic_credit_until > now() THEN traffic_credit_floor \
             ELSE now() - make_interval(secs => LEAST(GREATEST(COALESCE( \
                 extract(epoch FROM now() - last_seen_at)::float8, 0), 0), $5)) END, \
         traffic_credit_until = CASE WHEN traffic_credit_until > now() THEN traffic_credit_until \
             ELSE now() + make_interval(secs => $6) END \
         WHERE id = $3",
    )
    .bind(agent_version)
    .bind(core_version)
    .bind(node_id)
    .bind(online_session)
    .bind(credit.lease_secs as f64)
    .bind(credit.burst_secs as f64)
    .execute(pg)
    .await?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn reconnect_for_test(pg: &sqlx::PgPool, node: Uuid) {
    let cw = CreditWindow::from_cfg(&crate::config::PanelConfig::default());
    set_online_row(pg, node, Uuid::new_v4(), None, None, cw)
        .await
        .unwrap();
}

/// Bounds of the reconnect credit.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CreditWindow {
    pub lease_secs: u64,
    pub burst_secs: u64,
}

impl CreditWindow {
    pub(crate) fn from_cfg(cfg: &crate::config::PanelConfig) -> Self {
        Self {
            lease_secs: cfg.grpc.lease_seconds(),
            burst_secs: cfg.traffic.node_burst_secs.max(1),
        }
    }
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
    let Ok(_permit) = state.read_permits().acquire().await else {
        return;
    };
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
    online_session: Option<Uuid>,
    deleting: bool,
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
    /// The session that last marked the node online (any instance).
    online_session: Option<Uuid>,
    /// Phase 1 of a deletion: served like a disabled node.
    deleting: bool,
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
         failed_held_user_version, failed_reason, online_session, \
         deleting_at IS NOT NULL AS deleting FROM nodes WHERE id = $1",
    )
    .bind(node_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(node) = node else {
        return Ok(None);
    };

    let mut users = Vec::new();
    // A node being deleted is served like a disabled one (it is disabled
    // in the same transaction; this is belt and braces).
    let serve = node.enabled && !node.deleting;
    let inbounds_json = if serve {
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
        enabled: serve,
        online_session: node.online_session,
        deleting: node.deleting,
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
async fn sync_if_stale(sess: &Session) -> anyhow::Result<Synced> {
    let (state, node_id) = (&sess.state, sess.node_id);
    // R12 P1: the whole ticket → read → decide → send sequence runs under
    // the session's send lock, so a later decision is never sent first.
    let Some(guard) = sess.lock().await else {
        return Ok(Synced::Current);
    };
    if sess.retiring() {
        return Ok(Synced::Current);
    }
    let ticket = sess.sync.lock().unwrap().ticket(); // BEFORE the read
    let desired = {
        let _permit = state.read_permits().acquire().await?;
        desired_state(state.pg(), node_id).await?
    };
    let Some(desired) = desired else {
        // Deleted (maybe while its notification was missed): the caller
        // retires the session. No lease for a node that does not exist.
        return Ok(Synced::Gone);
    };
    sess.deleting.store(desired.deleting, Ordering::SeqCst);
    if sess.marked_online.load(Ordering::SeqCst)
        && desired
            .online_session
            .is_some_and(|o| o != sess.online_session)
    {
        // A newer stream of this node (on some instance) took over.
        return Ok(Synced::Superseded);
    }
    let now = Instant::now();
    let snap = desired.snapshot;
    let want = (snap.config_version, snap.user_version);
    let set = Arc::new(NodeState {
        inbounds: snap.inbounds_json.clone(),
        users: user_set(&snap.users),
    });
    let (plan, grant, write_lease, converged) = {
        let mut st = sess.sync.lock().unwrap();
        let grant = st.hello_seen && !st.too_old();
        let write_lease = grant
            && st
                .lease_written
                .is_none_or(|t| now.duration_since(t) >= LEASE_WRITE_EVERY);
        if write_lease {
            st.lease_written = Some(now);
        }
        let plan = st.decide(ticket, want, &set, desired.enabled, desired.failed, now);
        let converged =
            plan.is_none() && st.held == want && st.acked.as_ref().is_some_and(|(v, _)| *v == want);
        (plan, grant, write_lease, converged)
    };
    if desired.deleting && converged {
        // Reconnected agent already runs the deleting node's empty state.
        mark_delete_acked(state.pg(), node_id, want).await;
    }
    if grant {
        let secs = state.cfg().grpc.lease_seconds();
        sess.send(
            &guard,
            DownMsg::Lease(LeaseGrant {
                duration_seconds: secs,
                remove_mode: state.cfg().agent.remove_mode.proto() as i32,
            }),
        )
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
        return Ok(Synced::Current);
    };
    let sent_kind = match &plan {
        Plan::Snapshot { empty: true } => "empty_snapshot",
        Plan::Snapshot { empty: false } => "snapshot",
        Plan::Delta { .. } => "delta",
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
    match sess.send(&guard, msg).await {
        Ok(true) => {
            crate::metrics::sync_sent(sent_kind);
            Ok(Synced::Current)
        }
        Ok(false) => {
            sess.sync.lock().unwrap().pending = None;
            Ok(Synced::Current)
        }
        Err(e) => {
            sess.sync.lock().unwrap().pending = None;
            Err(e)
        }
    }
}

/// What `sync_if_stale` found.
#[derive(Debug, PartialEq, Eq)]
enum Synced {
    /// The node exists; whatever it needed was sent.
    Current,
    /// The node no longer exists.
    Gone,
    /// Another (newer) stream of the node owns it now.
    Superseded,
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
        let cw = CreditWindow::from_cfg(&crate::config::PanelConfig::default());
        set_online_row(&db.pool, n, a, None, None, cw)
            .await
            .unwrap();
        set_online_row(&db.pool, n, b, None, None, cw)
            .await
            .unwrap();
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

    // ---------------------------------------------------------------------
    // Whole-session tests with a fake agent stream (real DB, real listener).
    // ---------------------------------------------------------------------

    use crate::gen::agent_up::Msg as UpMsg;

    struct FakeAgent {
        up: mpsc::Sender<Result<AgentUp, Status>>,
        down: mpsc::Receiver<Result<PanelDown, Status>>,
        task: tokio::task::JoinHandle<()>,
    }

    fn spawn_agent(state: &AppState, who: AgentIdentity) -> FakeAgent {
        let (up, up_rx) = mpsc::channel(64);
        let (down_tx, down) = mpsc::channel(64);
        let task = tokio::spawn(session(
            state.clone(),
            who,
            ReceiverStream::new(up_rx),
            down_tx,
        ));
        FakeAgent { up, down, task }
    }

    impl FakeAgent {
        async fn send(&self, m: UpMsg) {
            self.up.send(Ok(AgentUp { msg: Some(m) })).await.unwrap();
        }
        async fn hello(&self, held: (u64, u64), hash: String) {
            self.send(UpMsg::Hello(crate::gen::Hello {
                session_id: "s1".into(),
                config_version: held.0,
                user_version: held.1,
                protocol_version: MIN_AGENT_PROTOCOL,
                state_hash: hash,
                ..Default::default()
            }))
            .await;
        }
        async fn ack(&self, v: (u64, u64), hash: String) {
            self.send(UpMsg::Ack(ack_v1(v, crate::gen::ack::Reason::Ok, v, hash)))
                .await;
        }
        async fn traffic(&self, user: Uuid, up: u64) {
            self.send(UpMsg::Traffic(crate::gen::TrafficReport {
                users: vec![crate::gen::UserTraffic {
                    user_id: user.to_string(),
                    up_bytes: up,
                    down_bytes: 0,
                }],
                session_id: "s1".into(),
                ..Default::default()
            }))
            .await;
        }
        /// Next message that is not a LeaseGrant.
        async fn next(&mut self) -> Option<Result<DownMsg, Status>> {
            loop {
                let m = tokio::time::timeout(Duration::from_secs(15), self.down.recv())
                    .await
                    .expect("panel went silent");
                match m {
                    None => return None,
                    Some(Err(st)) => return Some(Err(st)),
                    Some(Ok(PanelDown {
                        msg: Some(DownMsg::Lease(_)),
                    })) => continue,
                    Some(Ok(PanelDown { msg: Some(m) })) => return Some(Ok(m)),
                    Some(Ok(PanelDown { msg: None })) => continue,
                }
            }
        }
        async fn snapshot(&mut self) -> ConfigSnapshot {
            match self.next().await {
                Some(Ok(DownMsg::Snapshot(s))) => s,
                other => panic!("expected a snapshot, got {other:?}"),
            }
        }
        /// The stream ends with `code` and then closes.
        async fn closed_with(&mut self, code: tonic::Code) {
            match self.next().await {
                Some(Err(st)) => assert_eq!(st.code(), code, "{st:?}"),
                other => panic!("expected {code:?}, got {other:?}"),
            }
            assert!(self.next().await.is_none(), "stream closed");
        }
    }

    fn hash_of(s: &ConfigSnapshot) -> String {
        state_hash(
            s.config_version,
            &NodeState {
                inbounds: s.inbounds_json.clone(),
                users: user_set(&s.users),
            },
        )
    }

    async fn delete_acked(db: &TestDb, n: Uuid) -> bool {
        sqlx::query_scalar("SELECT delete_acked_at IS NOT NULL FROM nodes WHERE id = $1")
            .bind(n)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    }

    /// S3-3 / R12 D1+D2 end to end: DELETE while the agent is connected.
    /// Phase 1 pushes the empty state (the node is disabled) and the final
    /// counters reported before the ack are billed; phase 2 revokes and
    /// deletes; the stream closes UNAUTHENTICATED. A reconnect with the same
    /// certificate is served the empty state (if needed) and closed; its
    /// traffic is never accepted; unknown serials are refused.
    #[tokio::test]
    async fn delete_while_connected_then_revoked_reconnect() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        sqlx::query("UPDATE nodes SET cert_serial = 'abc123' WHERE id = $1")
            .bind(n)
            .execute(&db.pool)
            .await
            .unwrap();
        let state = AppState::for_test(db.pool.clone()).await;
        let listener = crate::notify::start(state.clone()).await;
        assert_eq!(
            node_for_serial(&db.pool, "abc123").await.unwrap(),
            AgentIdentity::Node(n)
        );

        let mut agent = spawn_agent(&state, AgentIdentity::Node(n));
        agent.hello((0, 0), String::new()).await;
        let s1 = agent.snapshot().await;
        assert_eq!(s1.users.len(), 1);
        agent
            .ack((s1.config_version, s1.user_version), hash_of(&s1))
            .await;
        agent.traffic(u, 100).await;

        let mut tx = db.pool.begin().await.unwrap();
        assert!(crate::api::apply_begin_delete_node(&mut tx, n)
            .await
            .unwrap());
        tx.commit().await.unwrap();
        let s2 = agent.snapshot().await;
        assert_eq!((s2.inbounds_json.as_str(), s2.users.len()), ("[]", 0));
        agent.traffic(u, 300).await; // final counters, before the ack
        agent
            .ack((s2.config_version, s2.user_version), hash_of(&s2))
            .await;
        for _ in 0..100 {
            if delete_acked(&db, n).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            delete_acked(&db, n).await,
            "the ack of the empty state is recorded"
        );
        // Not yet: the ack must settle (the session's instance flushes).
        assert!(crate::reaper::reap_once(&state).await.unwrap().is_empty());
        sqlx::query("UPDATE nodes SET delete_acked_at = now() - interval '1 minute'")
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(crate::reaper::reap_once(&state).await.unwrap(), vec![n]);
        // Already running the empty state: no second push, just the close.
        agent.closed_with(tonic::Code::Unauthenticated).await;
        agent.task.await.unwrap();
        assert_eq!(
            db.used(u).await,
            300,
            "final counters billed before deletion"
        );
        let kept: i64 =
            sqlx::query_scalar("SELECT count(*) FROM traffic_counters WHERE node_id = $1")
                .bind(n)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(kept, 1, "billing rows are kept");
        assert!(!state.agents().contains_key(&n));
        assert!(state.traffic().is_empty());

        // Same certificate again: tombstoned, served, closed.
        assert_eq!(
            node_for_serial(&db.pool, "abc123").await.unwrap(),
            AgentIdentity::Revoked(n)
        );
        let mut again = spawn_agent(&state, AgentIdentity::Revoked(n));
        again
            .hello(
                (s2.config_version, s2.user_version),
                hash_of(&s2), // it runs the empty state already
            )
            .await;
        again.closed_with(tonic::Code::Unauthenticated).await;

        let mut stale = spawn_agent(&state, AgentIdentity::Revoked(n));
        stale
            .hello((s1.config_version, s1.user_version), hash_of(&s1))
            .await;
        let empty = stale.snapshot().await;
        assert_eq!(
            (
                empty.config_version,
                empty.user_version,
                empty.inbounds_json.as_str()
            ),
            (0, 0, "[]")
        );
        assert!(empty.users.is_empty());
        stale.traffic(u, 10_000).await;
        stale.ack((0, 0), hash_of(&empty)).await;
        stale.closed_with(tonic::Code::Unauthenticated).await;
        assert!(state.traffic().is_empty(), "revoked traffic never buffered");
        assert_eq!(db.used(u).await, 300);

        let unknown = node_for_serial(&db.pool, "not-a-serial").await.unwrap_err();
        assert_eq!(unknown.code(), tonic::Code::Unauthenticated);
        // A revoked serial can never be registered again.
        let err = sqlx::query(
            "INSERT INTO nodes (id, name, cert_serial) VALUES (gen_random_uuid(), 'again', 'abc123')",
        )
        .execute(&db.pool)
        .await
        .unwrap_err();
        assert!(err.to_string().contains("revoked"), "{err}");

        listener.abort();
        let _ = listener.await;
        drop(state);
        db.drop().await;
    }

    /// Deletion is derived from the DB, not from the notification: a node
    /// deleted while this instance heard nothing is found gone on the next
    /// read, and an agent still running users gets the empty state pushed
    /// before the close.
    #[tokio::test]
    async fn gone_without_notification_pushes_empty_then_closes() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, _u) = db.member().await;
        let state = AppState::for_test(db.pool.clone()).await; // no listener
        let mut agent = spawn_agent(&state, AgentIdentity::Node(n));
        agent.hello((0, 0), String::new()).await;
        let s1 = agent.snapshot().await;
        let v1 = (s1.config_version, s1.user_version);
        agent.ack(v1, hash_of(&s1)).await;
        sqlx::query("DELETE FROM nodes WHERE id = $1")
            .bind(n)
            .execute(&db.pool)
            .await
            .unwrap();
        agent.hello(v1, hash_of(&s1)).await; // any read finds it gone
        let empty = agent.snapshot().await;
        assert_eq!((empty.config_version, empty.users.len()), (0, 0));
        agent.ack((0, 0), hash_of(&empty)).await;
        agent.closed_with(tonic::Code::Unauthenticated).await;
        drop(state);
        db.drop().await;
    }

    /// One live stream per node: a newer stream supersedes the older one.
    #[tokio::test]
    async fn newer_stream_supersedes_older() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, _u) = db.member().await;
        let state = AppState::for_test(db.pool.clone()).await;
        let mut old = spawn_agent(&state, AgentIdentity::Node(n));
        old.hello((0, 0), String::new()).await;
        let s = old.snapshot().await;
        let mut new = spawn_agent(&state, AgentIdentity::Node(n));
        old.closed_with(tonic::Code::Aborted).await;
        new.hello((0, 0), String::new()).await;
        assert_eq!(new.snapshot().await.config_version, s.config_version);
        assert_eq!(state.agents().len(), 1);
        drop(new);
        drop(state);
        db.drop().await;
    }

    /// R12 P1: the whole sync (ticket, read, decide, send) runs under the
    /// session's send lock — a sync cannot even take its read ticket while
    /// another send is in progress — and nothing is sent once terminated.
    #[tokio::test]
    async fn sync_is_serialized_and_terminated_is_sticky() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, _u) = db.member().await;
        let state = AppState::for_test(db.pool.clone()).await;
        let (tx, mut rx) = mpsc::channel(64);
        let sess = Session::new(state.clone(), n, tx, false);
        sess.sync
            .lock()
            .unwrap()
            .on_hello((0, 0), MIN_AGENT_PROTOCOL, "");

        let gate = sess.send_lock.lock().await; // an in-progress send
        let s2 = sess.clone();
        let pending = tokio::spawn(async move { sync_if_stale(&s2).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(sess.sync.lock().unwrap().tickets, 0, "no ticket taken");
        assert!(rx.try_recv().is_err(), "nothing sent");
        drop(gate);
        assert_eq!(pending.await.unwrap().unwrap(), Synced::Current);
        assert!(matches!(
            rx.recv().await,
            Some(Ok(PanelDown {
                msg: Some(DownMsg::Lease(_))
            }))
        ));
        assert!(matches!(
            rx.recv().await,
            Some(Ok(PanelDown {
                msg: Some(DownMsg::Snapshot(_))
            }))
        ));

        sess.terminate(Status::aborted("test"));
        assert!(matches!(rx.recv().await, Some(Err(_))));
        sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = $1")
            .bind(n)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(sync_if_stale(&sess).await.unwrap(), Synced::Current);
        assert!(
            rx.try_recv().is_err(),
            "no lease, no state after termination"
        );
        drop(sess);
        drop(state);
        db.drop().await;
    }

    /// RT3b-3: a peer that stops reading its downstream wedges the session:
    /// the watcher blocks in tx.send while holding send_lock, so neither a
    /// supersede nor a deletion can ever terminate it.
    #[tokio::test]
    async fn rt_wedged_peer_blocks_supersede_and_retire() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let state = AppState::for_test(db.pool.clone()).await;
        let _l = crate::notify::start(state.clone()).await;
        let mut a = spawn_agent(&state, AgentIdentity::Node(n));
        a.hello((0, 0), String::new()).await;
        let s1 = a.snapshot().await;
        a.ack((s1.config_version, s1.user_version), hash_of(&s1))
            .await;
        let _ = u;
        // Stop reading `a.down`; the panel keeps getting wakeups.
        for _ in 0..80 {
            sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = $1")
                .bind(n)
                .execute(&db.pool)
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        // Delete it (phase 1 + forced phase 2) and supersede it.
        let mut tx = db.pool.begin().await.unwrap();
        crate::api::apply_begin_delete_node(&mut tx, n)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let _b = spawn_agent(&state, AgentIdentity::Node(n));
        let r = tokio::time::timeout(Duration::from_secs(30), &mut a.task).await;
        eprintln!("RT3b-3 old session ended: {}", r.is_ok());
        assert!(r.is_ok(), "wedged session never terminates");
        db.drop().await;
    }

    /// Wait until `cond` holds (bounded).
    async fn until(what: &str, mut cond: impl FnMut() -> bool) {
        for _ in 0..250 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out waiting for {what}");
    }

    /// R14 N3: traffic reports before the stream's Hello are dropped.
    #[tokio::test]
    async fn traffic_before_hello_is_dropped() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let state = AppState::for_test(db.pool.clone()).await;
        let mut a = spawn_agent(&state, AgentIdentity::Node(n));
        a.traffic(u, 5_000_000).await; // before Hello: must not count
        a.hello((0, 0), String::new()).await;
        let _ = a.snapshot().await;
        crate::traffic::flush_for_test(&db.pool, state.traffic()).await;
        assert_eq!(db.used(u).await, 0, "pre-Hello report billed");
        a.traffic(u, 100).await;
        let st = state.clone();
        until("post-Hello report buffered", || !st.traffic().is_empty()).await;
        crate::traffic::flush_for_test(&db.pool, state.traffic()).await;
        assert_eq!(db.used(u).await, 100);
        drop(a);
        drop(state);
        db.drop().await;
    }

    /// S4-3: shutdown ends every stream with UNAVAILABLE (also one that
    /// starts afterwards), waits for the sessions' cleanup, and the final
    /// flush bills what was buffered last.
    #[tokio::test]
    async fn shutdown_ends_streams_and_final_flush_bills_last_batch() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let state = AppState::for_test(db.pool.clone()).await;
        let mut a = spawn_agent(&state, AgentIdentity::Node(n));
        a.hello((0, 0), String::new()).await;
        let _ = a.snapshot().await;
        a.traffic(u, 777).await;
        let st = state.clone();
        until("report buffered", || !st.traffic().is_empty()).await;
        assert_eq!(db.used(u).await, 0, "nothing flushed yet");
        assert_eq!(state.live_sessions(), 1);

        assert!(crate::shutdown::end_sessions(&state, crate::shutdown::SESSION_DRAIN).await);
        a.closed_with(tonic::Code::Unavailable).await;
        assert_eq!(state.live_sessions(), 0);
        assert!(state.agents().is_empty());
        let status: String = sqlx::query_scalar("SELECT status FROM nodes WHERE id = $1")
            .bind(n)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(status, "offline", "session cleanup ran before the flush");
        // A no-ack failure is not recorded for a shutdown.
        let failed: Option<i64> =
            sqlx::query_scalar("SELECT failed_config_version FROM nodes WHERE id = $1")
                .bind(n)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(failed, None);

        // A stream arriving during the shutdown is ended at once.
        let mut late = spawn_agent(&state, AgentIdentity::Node(n));
        late.closed_with(tonic::Code::Unavailable).await;

        assert!(crate::shutdown::final_flush(&state, crate::shutdown::FINAL_FLUSH).await);
        assert_eq!(db.used(u).await, 777, "last batch billed");
        drop((a, late));
        drop(state);
        db.drop().await;
    }
}
