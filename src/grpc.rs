use std::collections::{BTreeMap, VecDeque};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, Notify};
use tokio_stream::{wrappers::ReceiverStream, Stream, StreamExt};
use tonic::{Request, Response, Status, Streaming};
use uuid::Uuid;

use crate::gen::agent_channel_server::{AgentChannel, AgentChannelServer};
use crate::gen::agent_enrollment_server::AgentEnrollmentServer;
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
    type FetchArtifactStream = crate::updates::ChunkStream;

    async fn fetch_artifact(
        &self,
        request: Request<crate::gen::FetchArtifactRequest>,
    ) -> Result<Response<Self::FetchArtifactStream>, Status> {
        // Same identity rules as the channel: a verified certificate of a
        // live node (a deleted node's tombstoned one gets nothing).
        let (serial, _) = crate::enroll::peer_cert(&request)?;
        let ip = request.remote_addr().map(|a| a.ip());
        let node = match node_for_serial_from(self.state.pg(), &serial, ip).await? {
            AgentIdentity::Node(n) => n,
            AgentIdentity::Revoked(_) => {
                return Err(Status::unauthenticated("certificate revoked"))
            }
        };
        crate::updates::fetch_artifact(&self.state, node, request.into_inner())
            .await
            .map(Response::new)
    }

    async fn open_channel(
        &self,
        request: Request<Streaming<AgentUp>>,
    ) -> Result<Response<DownStream>, Status> {
        let state = self.state.clone();

        // Identity comes exclusively from the mTLS client certificate;
        // there is no token or credential in the protocol itself.
        let identity = identify_node(&state, &request).await?;
        if let (AgentIdentity::Node(node), Some(peer)) =
            (identity, request.remote_addr().map(|a| a.ip()))
        {
            record_agent_addr(&state, node, peer).await;
        }

        // Disabled nodes are NOT rejected: a rejected agent would keep its
        // last xray config running forever. They are accepted and converge
        // to the disabled desired state (no inbounds, no users). For the
        // same reason a revoked (deleted node's) certificate is accepted,
        // served the empty state and closed (R12 D2).
        let (tx, rx) = mpsc::channel::<Result<PanelDown, Status>>(64);
        tokio::spawn(session(state.clone(), identity, request.into_inner(), tx));
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }

    async fn renew(
        &self,
        request: Request<crate::gen::RenewRequest>,
    ) -> Result<Response<crate::gen::IssuedCertificate>, Status> {
        // Identity from the verified client certificate only (enroll.rs).
        crate::enroll::renew(&self.state, request)
            .await
            .map(Response::new)
    }
}

/// W10: the agent's source address (gRPC peer) for the node page and the
/// TLS domain check. Best effort.
async fn record_agent_addr(state: &AppState, node: Uuid, peer: std::net::IpAddr) {
    let peer = crate::client_ip::canonical(peer).to_string();
    if let Err(e) = sqlx::query(
        "UPDATE nodes SET agent_addr = $2::inet WHERE id = $1 AND agent_addr IS DISTINCT FROM $2::inet",
    )
    .bind(node)
    .bind(peer)
    .execute(state.pg())
    .await
    {
        tracing::warn!(node = %node, error = %e, "failed to record the agent address");
    }
}

/// Maps the peer certificate to a registered node. TLS client auth is
/// optional at the handshake (for AgentEnrollment.Enroll); here a verified
/// client certificate is mandatory, so a client without one never reaches
/// session code.
async fn identify_node(
    state: &AppState,
    req: &Request<Streaming<AgentUp>>,
) -> Result<AgentIdentity, Status> {
    let (serial, not_after) = crate::enroll::peer_cert(req)?;
    let ip = req.remote_addr().map(|a| a.ip());
    let who = node_for_serial_from(state.pg(), &serial, ip).await?;
    if let AgentIdentity::Node(node) = who {
        crate::enroll::note_legacy_expiry(state.pg(), node, &serial, not_after).await;
    }
    Ok(who)
}

/// Who a certificate serial belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentIdentity {
    Node(Uuid),
    /// A deleted node's tombstoned certificate: served the empty state,
    /// never trusted with traffic, then closed.
    Revoked(Uuid),
}

#[cfg(test)]
pub(crate) async fn node_for_serial(
    pg: &sqlx::PgPool,
    serial: &str,
) -> Result<AgentIdentity, Status> {
    node_for_serial_from(pg, serial, None).await
}

/// The node a certificate serial belongs to. The revocation tombstones are
/// consulted FIRST: a revoked serial stays revoked even if some node row
/// carried it again (the DB also refuses that, migrations 0007/0011). A
/// 'deleted' tombstone is accepted as `Revoked` (empty state, then closed);
/// a 'rotated' one (superseded by a renewal, M1-8) is refused like an
/// unknown serial — the node lives on and its agent must use its newer
/// certificate. Otherwise the serial is the node's newest certificate
/// (cert_serial; the first sight while an older one is still accepted
/// tombstones that one) or the one it renewed from (prev_cert_serial, still
/// valid until the newer one is seen).
async fn node_for_serial_from(
    pg: &sqlx::PgPool,
    serial: &str,
    ip: Option<std::net::IpAddr>,
) -> Result<AgentIdentity, Status> {
    type Row = (
        Option<Uuid>,
        Option<String>,
        Option<Uuid>,
        Option<bool>,
        Option<Uuid>,
    );
    let (revoked, reason, current, has_prev, prev): Row = sqlx::query_as(
        "SELECT r.node_id, r.reason, c.id, c.prev_cert_serial IS NOT NULL, p.id \
         FROM (SELECT 1) one \
         LEFT JOIN revoked_certs r ON r.cert_serial = $1 \
         LEFT JOIN nodes c ON c.cert_serial = $1 \
         LEFT JOIN nodes p ON p.prev_cert_serial = $1",
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
        if reason.as_deref() == Some("deleted") {
            return Ok(AgentIdentity::Revoked(node));
        }
        return Err(Status::unauthenticated("unknown certificate"));
    }
    if let Some(node) = current {
        if has_prev == Some(true) {
            if let Err(e) = crate::enroll::promote_on_first_sight(pg, node, serial, ip).await {
                // The older certificate just stays accepted a bit longer.
                tracing::warn!(node = %node, error = %e, "failed to retire the renewed-from certificate");
            }
        }
        return Ok(AgentIdentity::Node(node));
    }
    prev.map(AgentIdentity::Node)
        .ok_or_else(|| Status::unauthenticated("unknown certificate"))
}

/// Lowest `Hello.protocol_version` the panel converges. Older agents are
/// served the empty desired state (no inbounds, no users) and their
/// Hello/Ack are never trusted for convergence (N5). Rollout: agents first.
pub const MIN_AGENT_PROTOCOL: u32 = 1;

/// Agents from this protocol on enforce `UserOp.speed_limit_bytes_per_sec`
/// (older ones ignore the field: NodeView warns).
pub const SPEED_LIMIT_PROTOCOL: u32 = 4;

/// W9: agents from this protocol on remove Shadowsocks 2022 users in place
/// (the credential stays in xray's table as a gate-refused tombstone), so a
/// removal on a Shadowsocks node is a delta. A rotation still needs a
/// Snapshot (xray's table holds one entry per user), and the agent answers
/// BASE_MISMATCH for what it cannot apply in place (a re-add with a new key
/// over a tombstone, too many tombstones): the panel then sends a Snapshot,
/// which also compacts. Older agents get a Snapshot for any removal there.
pub const SS_TOMBSTONE_PROTOCOL: u32 = 5;

/// W10: agents from this protocol on obtain and renew the node certificate
/// for `nodes.tls_domain` themselves (ConfigSnapshot.acme) and report it
/// (Heartbeat.cert). Older ones ignore both and keep reading the files the
/// admin installs (NodeView warns).
pub const ACME_PROTOCOL: i32 = 6;

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

/// Per-user speed limits (bytes/s, `UserOp.speed_limit_bytes_per_sec`) of
/// the users in a `UserSet`; only non-zero limits are present.
pub type UserLimits = BTreeMap<String, u64>;

/// `user_limits` with the same collapsing rules as `user_set` (a later op
/// for the same user replaces the earlier one; users without any inbound,
/// and REMOVEs, have no limit).
pub fn user_limits(ops: &[UserOp]) -> UserLimits {
    let mut limits = UserLimits::new();
    for op in ops {
        if op.op == UserOpKind::Add as i32
            && !op.inbound_users.is_empty()
            && op.speed_limit_bytes_per_sec > 0
        {
            limits.insert(op.user_id.clone(), op.speed_limit_bytes_per_sec);
        } else {
            limits.remove(&op.user_id);
        }
    }
    limits
}

/// What the agent must run: the inbounds JSON exactly as sent in the
/// Snapshot, the user set and the users' speed limits. The limits are not
/// part of the state hash (agent.proto: a held version carries its limits);
/// they are part of the per-user digests, so a limit change is a delta.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NodeState {
    pub inbounds: String,
    pub users: UserSet,
    pub limits: UserLimits,
}

impl NodeState {
    /// The state a Snapshot with these inbounds and ops describes.
    pub fn of_snapshot(inbounds: String, ops: &[UserOp]) -> Self {
        NodeState {
            inbounds,
            users: user_set(ops),
            limits: user_limits(ops),
        }
    }
}

/// The UserOp ADD (REPLACE: the complete list) for one user of a state.
fn add_op(user: &str, tags: &BTreeMap<String, (String, String)>, limit: u64) -> UserOp {
    UserOp {
        op: UserOpKind::Add as i32,
        user_id: user.to_string(),
        inbound_users: tags
            .iter()
            .map(|(tag, (protocol, account))| InboundUser {
                inbound_tag: tag.clone(),
                account_json: account.clone(),
                protocol: protocol.clone(),
            })
            .collect(),
        speed_limit_bytes_per_sec: limit,
    }
}

fn remove_op(user: String) -> UserOp {
    UserOp {
        op: UserOpKind::Remove as i32,
        user_id: user,
        inbound_users: vec![],
        speed_limit_bytes_per_sec: 0,
    }
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
/// user is re-sent with its complete inbound list and limit). Sessions use
/// `diff_from_digest`; this full-set form is the reference it is tested
/// against (and the benchmarks' baseline).
pub fn diff_user_sets(base: &NodeState, want: &NodeState) -> Vec<UserOp> {
    let mut ops = Vec::new();
    for (user, tags) in &want.users {
        let limit = want.limits.get(user).copied().unwrap_or(0);
        if base.users.get(user) != Some(tags)
            || base.limits.get(user).copied().unwrap_or(0) != limit
        {
            ops.push(add_op(user, tags, limit));
        }
    }
    for user in base.users.keys() {
        if !want.users.contains_key(user) {
            ops.push(remove_op(user.clone()));
        }
    }
    ops
}

/// A user id inside a `SetDigest`: a canonical (lowercase, hyphenated)
/// UUID — every id the panel generates — packed into 16 bytes; anything
/// else kept verbatim (so the id can always be given back for a REMOVE).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum UserKey {
    Uuid(Uuid),
    Other(Box<str>),
}

impl UserKey {
    fn of(id: &str) -> Self {
        if let Ok(u) = Uuid::parse_str(id) {
            let mut buf = Uuid::encode_buffer();
            if u.hyphenated().encode_lower(&mut buf) == id {
                return UserKey::Uuid(u);
            }
        }
        UserKey::Other(id.into())
    }

    fn id(&self) -> String {
        match self {
            UserKey::Uuid(u) => u.to_string(),
            UserKey::Other(s) => s.to_string(),
        }
    }
}

/// 128-bit digest of one user's inbound credentials (tag, protocol,
/// account_json per tag, length-prefixed, in tag order). Speed limits are
/// kept beside it (`SetDigest.limits`), so a limit-only change never looks
/// like a dropped/rotated credential (remove_mode=rebuild, Shadowsocks).
fn user_digest(tags: &BTreeMap<String, (String, String)>) -> [u8; 16] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for (tag, (protocol, account)) in tags {
        for f in [tag.as_bytes(), protocol.as_bytes(), account.as_bytes()] {
            h.update((f.len() as u32).to_be_bytes());
            h.update(f);
        }
    }
    let d = h.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&d[..16]);
    out
}

/// What a session remembers about a state it sent or verified (M2): the
/// state hash at its config version, the inbounds' SHA-256 and a 128-bit
/// digest per user — about 40 bytes per user instead of the ~1.3 KB a full
/// `NodeState` costs (200 sessions x 10k users each made full sets the
/// panel's dominant memory use). Enough to interpret Acks and Hellos (the
/// hash), decide whether a delta applies (inbounds) and compute it against
/// the freshly read full set (`diff_from_digest`). A digest collision can
/// only make a delta miss a changed user; the agent's acked state hash then
/// disagrees with `hash` (computed from the full set) and the session
/// repairs with a Snapshot.
#[derive(Debug, PartialEq, Eq)]
pub struct SetDigest {
    hash: String,
    inbounds: [u8; 32],
    users: BTreeMap<UserKey, [u8; 16]>,
    /// W7: non-zero speed limits (bytes/s) of the users, by user.
    limits: BTreeMap<UserKey, u64>,
    /// W8: the inbounds include a Shadowsocks one. The agent refuses
    /// deltas that rotate users there (xray's multi-user SS2022 inbound
    /// cannot safely shrink while running; akari-agent `shrinkUnsafe`) —
    /// and, below `SS_TOMBSTONE_PROTOCOL`, removals too — so such changes
    /// go out as a Snapshot right away instead of a delta the agent
    /// answers BASE_MISMATCH.
    shrink_unsafe: bool,
}

impl SetDigest {
    pub fn of(config_version: u64, state: &NodeState) -> Self {
        use sha2::{Digest, Sha256};
        SetDigest {
            hash: state_hash(config_version, state),
            inbounds: Sha256::digest(state.inbounds.as_bytes()).into(),
            shrink_unsafe: has_shadowsocks(&state.inbounds),
            users: state
                .users
                .iter()
                .map(|(id, tags)| (UserKey::of(id), user_digest(tags)))
                .collect(),
            limits: state
                .limits
                .iter()
                .map(|(id, l)| (UserKey::of(id), *l))
                .collect(),
        }
    }

    pub fn hash(&self) -> &str {
        &self.hash
    }

    /// No inbounds, no users (what a disabled/deleted node runs).
    fn is_empty_state(&self) -> bool {
        use sha2::{Digest, Sha256};
        self.users.is_empty() && self.inbounds == <[u8; 32]>::from(Sha256::digest(b"[]"))
    }
}

/// `diff_user_sets` against a remembered base: the same ops (REPLACE
/// semantics; ADDs carry the user's complete list and limit from `want`).
pub fn diff_from_digest(base: &SetDigest, want: &NodeState) -> Vec<UserOp> {
    let mut ops = Vec::new();
    let mut wanted = std::collections::HashSet::with_capacity(want.users.len());
    for (user, tags) in &want.users {
        let key = UserKey::of(user);
        let limit = want.limits.get(user).copied().unwrap_or(0);
        if base.users.get(&key) != Some(&user_digest(tags))
            || base.limits.get(&key).copied().unwrap_or(0) != limit
        {
            ops.push(add_op(user, tags, limit));
        }
        wanted.insert(key);
    }
    for key in base.users.keys() {
        if !wanted.contains(key) {
            ops.push(remove_op(key.id()));
        }
    }
    ops
}

/// Does this inbounds JSON hold a shadowsocks inbound? Cheap substring
/// test first (the digest is computed for every desired-state read).
fn has_shadowsocks(inbounds: &str) -> bool {
    inbounds.to_ascii_lowercase().contains("shadowsocks")
        && serde_json::from_str::<serde_json::Value>(inbounds)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .is_some_and(|a| {
                a.iter().any(|i| {
                    i.get("protocol")
                        .and_then(|p| p.as_str())
                        .is_some_and(|p| p.eq_ignore_ascii_case("shadowsocks"))
                })
            })
}

/// `drops_credential` on digests, conservatively: any base user whose
/// credentials changed at all (or who is gone) counts, so a user that only
/// GAINS an inbound also counts. Only consulted with remove_mode=rebuild,
/// where it can only turn a delta into a Snapshot (always correct).
fn drops_credential_digest(base: &SetDigest, want: &SetDigest) -> bool {
    base.users
        .iter()
        .any(|(user, d)| want.users.get(user) != Some(d))
}

/// Like `drops_credential_digest`, but only users that stay with changed
/// credentials count (a user that is gone does not): on a Shadowsocks node
/// of a protocol >= `SS_TOMBSTONE_PROTOCOL` agent, removals are deltas and
/// rotations Snapshots. Conservative: any change of a staying user's
/// credentials counts, on any inbound.
fn rotates_credential_digest(base: &SetDigest, want: &SetDigest) -> bool {
    base.users
        .iter()
        .any(|(user, d)| want.users.get(user).is_some_and(|w| w != d))
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
        base_set: Arc<SetDigest>,
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
    acked: Option<((u64, u64), Arc<SetDigest>)>,
    /// Sets sent this session and not yet answered, by versions, in send
    /// order (bounded), to know what an ok Ack means. An Ack also drops
    /// every entry sent before the one it answers (acks arrive in order).
    sent: VecDeque<((u64, u64), Arc<SetDigest>)>,
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
/// Reconcile tick: self-heals missed notifies and transient DB errors
/// (per session, phase randomised so sessions do not tick together).
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

    fn sent_set(&self, v: (u64, u64)) -> Option<Arc<SetDigest>> {
        self.sent
            .iter()
            .rev()
            .find(|(sv, _)| *sv == v)
            .map(|(_, s)| s.clone())
    }

    fn remember(&mut self, v: (u64, u64), set: Arc<SetDigest>) {
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
        want: &SetDigest,
        can_delta: bool,
    ) -> Option<((u64, u64), Arc<SetDigest>)> {
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
        if self.remove_rebuild && drops_credential_digest(&bset, want) {
            return None;
        }
        if bset.shrink_unsafe {
            let unsafe_change = if self.protocol >= SS_TOMBSTONE_PROTOCOL {
                rotates_credential_digest(&bset, want)
            } else {
                drops_credential_digest(&bset, want)
            };
            if unsafe_change {
                return None;
            }
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
        // The compact record of `set` at the desired versions, built once
        // and only when needed (verification or a send).
        let mut digest: Option<Arc<SetDigest>> = None;
        let mut digest_of = |d: (u64, u64)| -> Arc<SetDigest> {
            digest
                .get_or_insert_with(|| Arc::new(SetDigest::of(d.0, set)))
                .clone()
        };
        if !old && self.held == desired {
            if let Some(h) = self.hello_hash.take() {
                let dg = digest_of(desired);
                if h == dg.hash {
                    self.acked = Some((desired, dg));
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
        } else if let Some((base, base_set)) =
            self.delta_base(desired, &digest_of(desired), can_delta)
        {
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
            self.remember(desired, digest_of(desired));
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
                    ..Default::default()
                },
            )
        };
        if let Some((v, set)) = &self.acked {
            if *v == self.held && set.is_empty_state() {
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
        // Acks come in send order: whatever was sent before the answered
        // message can no longer be acked (bounded memory, M2).
        if let Some(pos) = self.sent.iter().position(|(v, _)| *v == versions) {
            self.sent.drain(..pos);
        }
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
                if let Some((_, set)) = &self.acked {
                    if !ack.state_hash.is_empty() && set.hash != ack.state_hash {
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
    /// M6: what the latest Hello said (agent version, protocol, platform),
    /// rollouts already offered on this stream, and whether an ok Ack must
    /// be reported to the rollout health gate.
    agent: Mutex<HelloInfo>,
    offered: Mutex<Vec<Uuid>>,
    update_watch: AtomicBool,
    /// Hello / ack of the empty state, while retiring.
    hello: Notify,
    retire_ack: Notify,
    /// W11: the agent listed the "latency" capability in its Hello.
    latency_capable: AtomicBool,
    /// W23: the agent listed "metrics-presence": an unset heartbeat value
    /// means unknown (else it means 0, `nodestat::legacy_presence`).
    metrics_presence: AtomicBool,
    /// The LatencyProbeConfig last sent on this stream (None = none sent
    /// yet; re-sent when the token or, W12, the 系统设置 values change).
    probe_sent: Mutex<Option<crate::gen::LatencyProbeConfig>>,
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
            agent: Mutex::default(),
            offered: Mutex::default(),
            update_watch: AtomicBool::new(false),
            online_session: Uuid::new_v4(),
            gone: Notify::new(),
            closed: tokio::sync::watch::channel(false).0,
            hello: Notify::new(),
            retire_ack: Notify::new(),
            latency_capable: AtomicBool::new(false),
            metrics_presence: AtomicBool::new(false),
            probe_sent: Mutex::new(None),
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
        // The first tick at a random point of the period (Hello covers the
        // start): agents that connect together (every agent after a panel
        // restart) would otherwise reconcile in lockstep, ~200 full reads
        // queued on the read permits once a minute, and a user change landing
        // in that burst waited behind them (W14: change-to-agent max 2.0 s).
        let first = rand::random_range(0..RECONCILE_EVERY.as_millis() as u64);
        let mut tick = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_millis(first),
            RECONCILE_EVERY,
        );
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
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
                Ok(Synced::Current) => {
                    maybe_offer_update(&sess).await;
                    maybe_send_probe(&sess).await;
                }
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

    // A Hello whose online row write failed (DB blip): retried on each
    // heartbeat until it lands (B1), so the node is never left 'offline'
    // with a stale online_session for the whole stream.
    let mut online_retry: Option<crate::gen::Hello> = None;
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
                    online_retry = None;
                    if mark_online(&state, node_id, sess.online_session, &hello).await {
                        sess.marked_online.store(true, Ordering::SeqCst);
                    } else {
                        tracing::warn!(node = %node_id, "failed to mark node online; retrying on heartbeat");
                        online_retry = Some(hello.clone());
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
                    on_hello_update(&sess, &hello).await;
                    sess.metrics_presence.store(
                        hello.capabilities.iter().any(|c| c == "metrics-presence"),
                        Ordering::SeqCst,
                    );
                    // W11: latency tests for agents that support them.
                    let capable = hello.capabilities.iter().any(|c| c == "latency");
                    if sess.latency_capable.swap(capable, Ordering::SeqCst) != capable || !capable {
                        *lock_or_recover(&sess.probe_sent) = None;
                    }
                    maybe_send_probe(&sess).await;
                }
                Some(UpMsg::Latency(rep)) => {
                    // W11: like traffic, nothing before the Hello.
                    if sess.sync.lock().unwrap().hello_seen {
                        if let Err(e) =
                            crate::nodestat::store_agent_latency(state.pg(), node_id, &rep).await
                        {
                            tracing::warn!(node = %node_id, error = %e, "failed to store latency result");
                        }
                    }
                }
                Some(UpMsg::UpdateStatus(us)) => {
                    if let Err(e) = crate::rollout::on_status(state.pg(), node_id, &us).await {
                        tracing::warn!(node = %node_id, error = %e, "failed to record update status");
                    }
                }
                Some(UpMsg::Heartbeat(mut hb)) => {
                    if !sess.metrics_presence.load(Ordering::SeqCst) {
                        crate::nodestat::legacy_presence(&mut hb);
                    }
                    store_heartbeat(&state, node_id, &hb).await;
                    if let Some(h) = online_retry.take() {
                        if mark_online(&state, node_id, sess.online_session, &h).await {
                            sess.marked_online.store(true, Ordering::SeqCst);
                        } else {
                            online_retry = Some(h);
                        }
                    }
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
                            note_update_health(&sess).await;
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
    if !state.agents().contains_key(&node_id) {
        // W11: no local stream for the node any more (fleet gauges).
        state.nodestat().forget(node_id);
    }
    if retired {
        if !revoked {
            forget_node(&state, node_id).await;
        }
    } else {
        if let Err(e) = mark_offline(state.pg(), node_id, sess.online_session).await {
            tracing::warn!(node = %node_id, error = %e, "failed to mark node offline");
        }
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
            acme: None,
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
/// The agent fields of a Hello the update code needs.
#[derive(Default, Clone)]
struct HelloInfo {
    version: String,
    protocol: u32,
    os: String,
    arch: String,
}

fn lock_or_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// M6: after a Hello: remember the agent's version/platform, move a node
/// that came back with a rollout's target version to `updating` (its next
/// ok Ack makes it healthy), and offer an update if one is due.
async fn on_hello_update(sess: &Session, hello: &crate::gen::Hello) {
    let info = hello.info.clone().unwrap_or_default();
    *lock_or_recover(&sess.agent) = HelloInfo {
        version: info.agent_version.clone(),
        protocol: hello.protocol_version,
        os: info.os,
        arch: info.arch,
    };
    if hello.protocol_version >= crate::updates::MIN_UPDATE_PROTOCOL
        && !info.agent_version.is_empty()
    {
        match crate::rollout::on_hello(sess.state.pg(), sess.node_id, &info.agent_version).await {
            Ok(true) => sess.update_watch.store(true, Ordering::SeqCst),
            Ok(false) => {}
            Err(e) => tracing::warn!(node = %sess.node_id, error = %e, "rollout hello hook failed"),
        }
    }
    maybe_offer_update(sess).await;
}

/// An ok Ack on a stream that came back with a rollout's target version:
/// the node passed the health gate.
async fn note_update_health(sess: &Session) {
    if !sess.update_watch.load(Ordering::SeqCst) {
        return;
    }
    let version = lock_or_recover(&sess.agent).version.clone();
    match crate::rollout::on_converged(sess.state.pg(), sess.node_id, &version).await {
        Ok(_) => sess.update_watch.store(false, Ordering::SeqCst),
        Err(e) => tracing::warn!(node = %sess.node_id, error = %e, "rollout health hook failed"),
    }
}

/// Sends the node's due UpdateOffer (protocol >= 3 only), at most once per
/// stream and rollout.
async fn maybe_offer_update(sess: &Session) {
    let info = lock_or_recover(&sess.agent).clone();
    if info.protocol < crate::updates::MIN_UPDATE_PROTOCOL || sess.retiring() || sess.terminated() {
        return;
    }
    let offer = match crate::rollout::offer_for(
        sess.state.pg(),
        sess.node_id,
        info.protocol,
        &info.version,
        (&info.os, &info.arch),
    )
    .await
    {
        Ok(Some(o)) => o,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(node = %sess.node_id, error = %e, "update offer lookup failed");
            return;
        }
    };
    let Ok(rollout) = Uuid::parse_str(&offer.rollout_id) else {
        return;
    };
    {
        let mut offered = lock_or_recover(&sess.offered);
        if offered.contains(&rollout) {
            return;
        }
        offered.push(rollout);
    }
    let Some(guard) = sess.lock().await else {
        return;
    };
    tracing::info!(node = %sess.node_id, rollout = %rollout, "sending update offer");
    if let Err(e) = sess.send(&guard, DownMsg::UpdateOffer(offer)).await {
        tracing::warn!(node = %sess.node_id, error = %e, "update offer send failed");
    }
}

/// W11: send the latency test settings (and the latest "立即测速" token)
/// to an agent with the "latency" capability: once per stream, and again
/// whenever the token or the effective settings (W12: 系统设置, reload
/// wakes every session) changed. Read on every wake/tick (one indexed row).
async fn maybe_send_probe(sess: &Session) {
    if !sess.latency_capable.load(Ordering::SeqCst) || sess.retiring() || sess.terminated() {
        return;
    }
    let requested = match crate::nodestat::requested_at(sess.state.pg(), sess.node_id).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(node = %sess.node_id, error = %e, "probe request lookup failed");
            return;
        }
    };
    let cfg = crate::nodestat::probe_config(&sess.state.settings().get().probe, requested);
    if lock_or_recover(&sess.probe_sent).as_ref() == Some(&cfg) {
        return;
    }
    let Some(guard) = sess.lock().await else {
        return;
    };
    match sess.send(&guard, DownMsg::LatencyProbe(cfg.clone())).await {
        Ok(true) => *lock_or_recover(&sess.probe_sent) = Some(cfg),
        Ok(false) => {}
        Err(e) => tracing::warn!(node = %sess.node_id, error = %e, "latency config send failed"),
    }
}

/// W12: the capabilities to record from a Hello (agent input: at most 16
/// names of at most 32 characters, sorted, deduplicated).
fn hello_capabilities(hello: &crate::gen::Hello) -> Vec<String> {
    let mut caps: Vec<String> = hello
        .capabilities
        .iter()
        .filter(|c| !c.is_empty() && c.len() <= 32)
        .take(16)
        .cloned()
        .collect();
    caps.sort();
    caps.dedup();
    caps
}

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
    if let Err(e) = sqlx::query(
        "UPDATE nodes SET agent_protocol = $2, agent_os = $3, agent_arch = $4, \
             agent_capabilities = $5 WHERE id = $1",
    )
    .bind(node_id)
    .bind(hello.protocol_version as i32)
    .bind(info.map(|i| i.os.as_str()).filter(|s| !s.is_empty()))
    .bind(info.map(|i| i.arch.as_str()).filter(|s| !s.is_empty()))
    .bind(hello_capabilities(hello))
    .execute(state.pg())
    .await
    {
        tracing::warn!(node = %node_id, error = %e, "failed to record agent platform");
    }
    if owned {
        // M2-5: the agent's current traffic session, as of this Hello on
        // the stream that owns the node (traffic::retention_pass; the drain
        // proof is written by `AppState::persist_online`).
        // Losing this write stops retention_pass from ever retiring the
        // node's superseded sessions (M2-5 drain proof): say so.
        if let Err(e) = sqlx::query(
            "UPDATE nodes SET agent_session = $2, agent_session_at = now() \
             WHERE id = $1 AND online_session = $3",
        )
        .bind(node_id)
        .bind(Some(hello.session_id.as_str()).filter(|s| !s.is_empty()))
        .bind(online_session)
        .execute(state.pg())
        .await
        {
            tracing::warn!(node = %node_id, error = %e, "failed to record agent traffic session");
        }
    }
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

/// Heartbeat.cert (agent protocol 6) as the node page reads it: enums as
/// lowercase names, times as RFC 3339 (null when unset), every agent
/// string through `nodestat::agent_text` (control characters dropped,
/// length capped: the domain at 253, the error at 512 — the agent caps it
/// too —, the challenge name at 32). A compromised node must not be able
/// to park megabytes of arbitrary text in the shared Valkey blob (fuzz:
/// agent_messages).
pub(crate) fn cert_status_json(c: &crate::gen::CertStatus) -> serde_json::Value {
    use crate::gen::cert_status::{ErrorKind, State};
    let ts = |secs: i64| {
        (secs > 0)
            .then(|| chrono::DateTime::from_timestamp(secs, 0))
            .flatten()
            .map(|t| t.to_rfc3339())
    };
    let state = match State::try_from(c.state) {
        Ok(State::Pending) => "pending",
        Ok(State::Valid) => "valid",
        Ok(State::Failed) => "failed",
        _ => "unknown",
    };
    let kind = match ErrorKind::try_from(c.error_kind) {
        Ok(ErrorKind::ErrorNone) => None,
        Ok(ErrorKind::ErrorDns) => Some("dns"),
        Ok(ErrorKind::ErrorConnection) => Some("connection"),
        Ok(ErrorKind::ErrorRateLimited) => Some("rate_limited"),
        Ok(ErrorKind::ErrorPortBusy) => Some("port_busy"),
        Ok(ErrorKind::ErrorCaa) => Some("caa"),
        Ok(ErrorKind::ErrorRejected) => Some("rejected"),
        Ok(ErrorKind::ErrorCaUnreachable) => Some("ca_unreachable"),
        _ => Some("other"),
    };
    let text = crate::nodestat::agent_text;
    let err = text(&c.last_error, 512);
    let challenge = text(&c.challenge, 32);
    serde_json::json!({
        "domain": text(&c.domain, 253),
        "state": state,
        "not_after": ts(c.not_after),
        "next_attempt": ts(c.next_attempt),
        "last_error": (!err.is_empty()).then_some(err),
        "error_kind": kind,
        "last_error_at": ts(c.last_error_at),
        "challenge": (!challenge.is_empty()).then_some(challenge),
        "failures": c.failures,
    })
}

async fn store_heartbeat(state: &AppState, node_id: Uuid, hb: &Heartbeat) {
    // W11: the blob carries the machine status too (nodestat.rs), and the
    // sample feeds the history and the fleet gauges.
    let mut blob = crate::nodestat::heartbeat_blob(hb);
    // W10: the automatic certificate (agent protocol 6).
    if let Some(c) = &hb.cert {
        blob["cert"] = cert_status_json(c);
    }
    crate::nodestat::on_heartbeat(state, node_id, hb);
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
    tls_domain: Option<String>,
}

#[derive(sqlx::FromRow)]
struct NodeUserRow {
    user_id: Uuid,
    credentials: serde_json::Value,
    /// The user's active plan's speed limit (Mbps), if any.
    speed_limit_mbps: Option<i32>,
}

/// Mbps (decimal, as plans state it) -> bytes per second; None/<=0 = 0
/// (unlimited).
pub fn mbps_to_bytes_per_sec(mbps: Option<i32>) -> u64 {
    match mbps {
        Some(m) if m > 0 => m as u64 * 125_000,
        _ => 0,
    }
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
         deleting_at IS NOT NULL AS deleting, tls_domain FROM nodes WHERE id = $1",
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
            "SELECT nu.user_id, nu.credentials, p.speed_limit_mbps \
             FROM node_users nu JOIN users u ON u.id = nu.user_id \
             LEFT JOIN user_plans up ON up.user_id = nu.user_id AND up.status = 'active' \
             LEFT JOIN plans p ON p.id = up.plan_id \
             WHERE nu.node_id = $1 AND {} \
             ORDER BY nu.user_id",
            crate::enforce::SERVED
        )))
        .bind(node_id)
        .fetch_all(&mut *tx)
        .await?;
        for r in rows {
            // Corrupt credentials: log and leave the user out of the snapshot
            // (the REST paths answer 500 for the same data); never silently
            // serve an empty inbound set as if it were valid.
            let creds: Vec<Credential> = match serde_json::from_value(r.credentials) {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!(%node_id, user_id = %r.user_id, error = %e,
                        "node_users.credentials is not a valid credential list; user skipped in snapshot");
                    continue;
                }
            };
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
                speed_limit_bytes_per_sec: mbps_to_bytes_per_sec(r.speed_limit_mbps),
            });
        }
        serde_json::to_string(&node.xray_inbounds)?
    } else {
        "[]".to_string()
    };
    tx.commit().await?;
    // W10: an automatic certificate only where an inbound reads the node
    // certificate files (a REALITY-only node never orders one).
    // directory_url/email come from the panel config (sync_if_stale).
    let acme = node
        .tls_domain
        .filter(|_| serve && crate::nodetpl::needs_certificate(&node.xray_inbounds))
        .map(|domain| crate::gen::AcmeConfig {
            domain,
            ..Default::default()
        });

    Ok(Some(Desired {
        snapshot: ConfigSnapshot {
            config_version: node.config_version as u64,
            inbounds_json,
            user_version: node.user_version as u64,
            users,
            acme,
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

/// The snapshot `desired_state` would send `node_id` now (benchmarks and
/// load tooling; sessions use `desired_state` itself). None: no such node.
pub async fn desired_snapshot(
    pg: &sqlx::PgPool,
    node_id: Uuid,
) -> anyhow::Result<Option<ConfigSnapshot>> {
    Ok(desired_state(pg, node_id).await?.map(|d| d.snapshot))
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
                                                     // The permit bounds concurrent reads AND the full in-memory sets built
                                                     // from them (~1.3 KB per user): it is held until the message is built
                                                     // (M2: 200 sessions waking at once must not hold 200 full sets).
    let permit = state.read_permits().acquire().await?;
    let desired = desired_state(state.pg(), node_id).await?;
    let Some(mut desired) = desired else {
        // Deleted (maybe while its notification was missed): the caller
        // retires the session. No lease for a node that does not exist.
        return Ok(Synced::Gone);
    };
    sess.deleting.store(desired.deleting, Ordering::SeqCst);
    if let Some(a) = desired.snapshot.acme.as_mut() {
        a.directory_url = state.cfg().acme.directory_url.clone();
        a.email = state.cfg().acme.email.clone();
    }
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
    let set = Arc::new(NodeState::of_snapshot(
        snap.inbounds_json.clone(),
        &snap.users,
    ));
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
    // Build the message while the permit is held, then drop the full set
    // and the permit before any send (a slow agent must not pin them).
    let out = plan.map(|plan| {
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
                    acme: None,
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
                let ops = diff_from_digest(&base_set, &set);
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
        (sent_kind, msg)
    });
    drop(set);
    drop(permit);
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
            if let Err(e) = sqlx::query(
                "UPDATE nodes SET lease_expires_at = now() + make_interval(secs => $2) \
                 WHERE id = $1",
            )
            .bind(node_id)
            .bind(secs as f64)
            .execute(state.pg())
            .await
            {
                tracing::warn!(node = %node_id, error = %e, "failed to persist lease expiry");
            }
        }
    }
    let Some((sent_kind, msg)) = out else {
        return Ok(Synced::Current);
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

/// The gRPC server's TLS (tlsserver.rs): the panel's server certificate,
/// hot-swapped when the gRPC server names change (R22); client
/// certificates OPTIONAL at the handshake (a presented one must verify
/// against the panel CA, including expiry and ClientAuth) so a fresh agent
/// can call AgentEnrollment.Enroll. Every AgentChannel method requires one
/// (`enroll::peer_cert`).
pub fn server_tls(state: &AppState) -> anyhow::Result<Arc<rustls::ServerConfig>> {
    crate::tlsserver::server_config(&state.install().ca_pem, state.settings().certs().clone())
}

/// Serve AgentChannel + AgentEnrollment on an already bound listener until
/// `shutdown` resolves (serve and the test harness share it).
pub async fn serve_on(
    state: AppState,
    listener: tokio::net::TcpListener,
    shutdown: impl std::future::Future<Output = ()>,
) -> anyhow::Result<()> {
    use tonic::transport::Server;

    let (incoming, accept_task) = crate::tlsserver::incoming(listener, server_tls(&state)?);
    let result = Server::builder()
        .http2_keepalive_interval(Some(std::time::Duration::from_secs(30)))
        .http2_keepalive_timeout(Some(std::time::Duration::from_secs(60)))
        .add_service(AgentChannelServer::new(AgentChannelService {
            state: state.clone(),
        }))
        .add_service(AgentEnrollmentServer::new(
            crate::enroll::AgentEnrollmentService { state },
        ))
        .serve_with_incoming_shutdown(incoming, shutdown)
        .await;
    accept_task.abort();
    result?;
    Ok(())
}

pub async fn serve(
    state: AppState,
    shutdown: tokio::sync::broadcast::Receiver<()>,
) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(state.cfg().grpc.bind).await?;
    let mut shutdown = shutdown;
    serve_on(state, listener, async move {
        let _ = shutdown.recv().await;
    })
    .await
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
            speed_limit_bytes_per_sec: 0,
        }
    }

    fn set_of(ops: &[UserOp]) -> Arc<NodeState> {
        Arc::new(NodeState::of_snapshot("[]".into(), ops))
    }

    /// A state with no inbounds and no limits.
    fn st(users: &UserSet) -> NodeState {
        NodeState {
            inbounds: "[]".into(),
            users: users.clone(),
            ..Default::default()
        }
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
                    // Limits are not part of the hash (agent.proto).
                    speed_limit_bytes_per_sec: 12_500_000,
                })
                .collect();
            assert_eq!(
                state_hash(
                    c.config_version,
                    &NodeState::of_snapshot(c.inbounds_json, &ops)
                ),
                c.hash,
                "{}",
                c.name
            );
        }
    }

    /// The digest diff (what sessions use) yields exactly the full-set
    /// diff: canonical UUID ids, other ids, rotations, tag gains/losses,
    /// additions and removals.
    #[test]
    fn digest_diff_equals_full_diff() {
        let u = |n: u128| Uuid::from_u128(n).to_string();
        let base = user_set(&[
            op(&u(1), &[("t1", "{\"id\":\"1\"}")]),
            op(&u(2), &[("t1", "{\"id\":\"2\"}"), ("t2", "{\"id\":\"2\"}")]),
            op(&u(3), &[("t1", "{\"id\":\"3\"}")]),
            op("not-a-uuid", &[("t1", "{\"id\":\"x\"}")]),
            op("8C2D9B1E-0000-4000-8000-000000000001", &[("t1", "{}")]), // non-canonical
            op(&u(5), &[("t1", "{\"id\":\"5\"}")]),
        ]);
        let want = user_set(&[
            op(&u(1), &[("t1", "{\"id\":\"1\"}")]),        // unchanged
            op(&u(2), &[("t1", "{\"id\":\"2b\"}")]),       // rotated, lost t2
            op(&u(4), &[("t2", "{\"id\":\"4\"}")]),        // added
            op("not-a-uuid", &[("t1", "{\"id\":\"x\"}")]), // unchanged
            op(&u(5), &[("t1", "{\"id\":\"5\"}"), ("t2", "{\"id\":\"5\"}")]), // gained t2
        ]);
        let norm = |mut ops: Vec<UserOp>| {
            ops.sort_by(|a, b| (a.op, &a.user_id).cmp(&(b.op, &b.user_id)));
            ops
        };
        let full = norm(diff_user_sets(&st(&base), &st(&want)));
        let base_state = st(&base);
        let dg = SetDigest::of(3, &base_state);
        assert_eq!(dg.hash(), state_hash(3, &base_state));
        assert_eq!(norm(diff_from_digest(&dg, &st(&want))), full);
        assert!(diff_from_digest(&dg, &st(&base)).is_empty(), "no-op");
        // Removed ids come back verbatim, canonical UUID or not.
        let removed: Vec<String> = full
            .iter()
            .filter(|o| o.op == UserOpKind::Remove as i32)
            .map(|o| o.user_id.clone())
            .collect();
        assert_eq!(
            removed,
            vec![u(3), "8C2D9B1E-0000-4000-8000-000000000001".to_string()]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        );
        // Conservative drop check: rotation and removal count; so does a
        // pure tag gain (u5), which only costs a Snapshot in rebuild mode.
        let want_state = st(&want);
        assert!(drops_credential_digest(&dg, &SetDigest::of(3, &want_state)));
        assert!(!drops_credential_digest(&dg, &dg));
        let only_add = st(&{
            let mut b = base.clone();
            b.extend(user_set(&[op(&u(9), &[("t1", "{}")])]));
            b
        });
        assert!(!drops_credential_digest(&dg, &SetDigest::of(3, &only_add)));
        assert!(SetDigest::of(1, &st(&UserSet::new())).is_empty_state());
        assert!(!dg.is_empty_state());
    }

    /// A session keeps only what an Ack can still refer to: acking a
    /// message drops everything sent before it.
    #[test]
    fn acks_release_older_sent_sets() {
        let t0 = Instant::now();
        let mut s = SyncState::default();
        s.on_hello((0, 0), MIN_AGENT_PROTOCOL, "");
        let sets: Vec<Arc<NodeState>> = (0..5)
            .map(|i| set_of(&[op(&format!("u{i}"), &[("t1", "{}")])]))
            .collect();
        for (i, set) in sets.iter().enumerate() {
            let tk = s.ticket();
            // Config changes each time: every one is a Snapshot in flight.
            assert!(s
                .decide(tk, (i as u64 + 1, 1), set, true, None, t0)
                .is_some());
        }
        assert_eq!(s.sent.len(), 5);
        let v = (4u64, 1u64);
        let ack = crate::gen::Ack {
            config_version: v.0,
            user_version: v.1,
            ok: true,
            reason: crate::gen::ack::Reason::Ok as i32,
            held_config_version: v.0,
            held_user_version: v.1,
            state_hash: state_hash(v.0, &sets[3]),
            error: String::new(),
        };
        assert_eq!(s.on_ack(&ack, t0), AckOutcome::Converged);
        let left: Vec<(u64, u64)> = s.sent.iter().map(|(v, _)| *v).collect();
        assert_eq!(left, vec![(4, 1), (5, 1)]);
        assert!(s.acked.as_ref().is_some_and(|(av, _)| *av == v));
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
        let ops = diff_user_sets(&st(&base), &st(&want));
        let by: BTreeMap<&str, &UserOp> = ops.iter().map(|o| (o.user_id.as_str(), o)).collect();
        assert_eq!(ops.len(), 3, "{ops:?}");
        assert!(!by.contains_key("a"), "unchanged user is not sent");
        let b = by["b"];
        assert_eq!(b.op, UserOpKind::Add as i32);
        assert_eq!(b.inbound_users.len(), 1, "REPLACE carries the full list");
        assert_eq!(b.inbound_users[0].account_json, "{\"id\":\"b2\"}");
        assert_eq!(by["c"].op, UserOpKind::Remove as i32);
        assert_eq!(by["d"].op, UserOpKind::Add as i32);
        assert!(diff_user_sets(&st(&want), &st(&want)).is_empty(), "no-op");
        // Applying the ops (REPLACE semantics) to base yields want.
        let mut applied = base.clone();
        for o in &ops {
            applied.remove(&o.user_id);
            applied.extend(user_set(std::slice::from_ref(o)));
        }
        assert_eq!(applied, want);
    }

    /// W7: speed limits ride in the user ops. A limit change alone is a
    /// delta (ADD with the unchanged credentials + the new limit), never
    /// part of the state hash, never a dropped credential (so it stays a
    /// delta on Shadowsocks nodes and in remove_mode=rebuild); REMOVE and
    /// empty users carry no limit.
    #[test]
    fn speed_limits_in_deltas_not_in_hash() {
        let mut a = op("a", &[("t1", "{\"id\":\"a\"}")]);
        let b = op("b", &[("t1", "{\"id\":\"b\"}")]);
        let base = NodeState::of_snapshot("[]".into(), &[a.clone(), b.clone()]);
        a.speed_limit_bytes_per_sec = 12_500_000;
        let want = NodeState::of_snapshot("[]".into(), &[a.clone(), b.clone()]);
        assert_eq!(want.limits.get("a"), Some(&12_500_000));
        assert!(!want.limits.contains_key("b"), "0 = unlimited, not stored");
        assert_eq!(state_hash(7, &base), state_hash(7, &want));
        let dg = SetDigest::of(7, &base);
        let ops = diff_from_digest(&dg, &want);
        assert_eq!(ops, vec![a.clone()], "limit-only change = one ADD");
        assert!(!drops_credential_digest(&dg, &SetDigest::of(7, &want)));
        assert_eq!(diff_user_sets(&base, &want), ops);
        assert!(diff_from_digest(&SetDigest::of(7, &want), &want).is_empty());
        // Back to unlimited is a change too.
        let back = diff_from_digest(&SetDigest::of(7, &want), &base);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].speed_limit_bytes_per_sec, 0);
        // Collapsing: a later REMOVE or ADD without inbounds drops it.
        let gone = user_limits(&[
            a.clone(),
            UserOp {
                op: UserOpKind::Remove as i32,
                user_id: "a".into(),
                inbound_users: vec![],
                speed_limit_bytes_per_sec: 9,
            },
        ]);
        assert!(gone.is_empty());
        assert_eq!(mbps_to_bytes_per_sec(Some(100)), 12_500_000);
        assert_eq!(mbps_to_bytes_per_sec(Some(0)), 0);
        assert_eq!(mbps_to_bytes_per_sec(None), 0);
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
                assert_eq!(*base_set, SetDigest::of(base.0, &s1));
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
                assert_eq!(*base_set, SetDigest::of(base.0, &s2));
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

    /// W8: on a node with a Shadowsocks inbound, removals/rotations are
    /// Snapshots whatever the remove mode (the agent would refuse the
    /// delta); additions stay deltas. W9: from SS_TOMBSTONE_PROTOCOL on,
    /// removals (and re-adds) are deltas too; rotations stay Snapshots, as
    /// does everything that drops a credential in remove_mode=rebuild.
    #[test]
    fn shadowsocks_node_shrinks_by_snapshot() {
        let t0 = Instant::now();
        let ss = r#"[{"tag":"t","protocol":"shadowsocks"}]"#;
        let with = |ops: &[UserOp]| Arc::new(NodeState::of_snapshot(ss.into(), ops));
        let s1 = with(&[op("a", &[("t", "1")]), op("b", &[("t", "2")])]);
        let add = with(&[
            op("a", &[("t", "1")]),
            op("b", &[("t", "2")]),
            op("c", &[("t", "3")]),
        ]);
        let remove = with(&[op("a", &[("t", "1")])]);
        let rotate = with(&[op("a", &[("t", "1")]), op("b", &[("t", "9")])]);
        let readd = s1.clone();
        for (protocol, rebuild, from, want, delta) in [
            (MIN_AGENT_PROTOCOL, false, &s1, &add, true),
            (MIN_AGENT_PROTOCOL, false, &s1, &remove, false),
            (MIN_AGENT_PROTOCOL, false, &s1, &rotate, false),
            (SS_TOMBSTONE_PROTOCOL - 1, false, &s1, &remove, false),
            (SS_TOMBSTONE_PROTOCOL, false, &s1, &add, true),
            (SS_TOMBSTONE_PROTOCOL, false, &s1, &remove, true),
            (SS_TOMBSTONE_PROTOCOL, false, &remove, &readd, true),
            (SS_TOMBSTONE_PROTOCOL, false, &s1, &rotate, false),
            (SS_TOMBSTONE_PROTOCOL, true, &s1, &remove, false),
            (SS_TOMBSTONE_PROTOCOL, true, &s1, &rotate, false),
        ] {
            let mut s = SyncState {
                remove_rebuild: rebuild,
                ..Default::default()
            };
            s.on_hello((0, 0), protocol, "");
            converge(&mut s, (2, 5), from, t0);
            let plan = d_set(&mut s, (2, 6), want);
            assert_eq!(
                matches!(plan, Some(Plan::Delta { .. })),
                delta,
                "protocol={protocol} rebuild={rebuild} {plan:?}"
            );
        }
        assert!(has_shadowsocks(r#"[{"protocol":"Shadowsocks"}]"#));
        assert!(!has_shadowsocks(
            r#"[{"tag":"shadowsocks","protocol":"vless"}]"#
        ));
        assert!(!has_shadowsocks("not json shadowsocks"));
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
            ..Default::default()
        };
        assert_eq!(state_hash(1, &st).len(), 64);
        db.drop().await;
    }

    /// W10: a node with a TLS domain and an inbound reading the node
    /// certificate files gets ConfigSnapshot.acme; REALITY-only nodes and
    /// disabled nodes do not.
    #[tokio::test]
    async fn desired_state_carries_acme_only_where_a_certificate_is_read() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, _) = db.member().await;
        let d = desired_state(&db.pool, n).await.unwrap().unwrap();
        assert!(d.snapshot.acme.is_none());
        sqlx::query("UPDATE nodes SET tls_domain = 'n1.example.com' WHERE id = $1")
            .bind(n)
            .execute(&db.pool)
            .await
            .unwrap();
        let d = desired_state(&db.pool, n).await.unwrap().unwrap();
        assert!(
            d.snapshot.acme.is_none(),
            "no inbound reads the node certificate"
        );
        let tls = serde_json::json!([{
            "tag": "in-vless", "port": 443, "protocol": "vless",
            "settings": {"clients": [], "decryption": "none"},
            "streamSettings": {"network": "ws", "security": "tls", "tlsSettings": {
                "serverName": "n1.example.com",
                "certificates": [{"certificateFile": crate::nodetpl::TLS_CERT_FILE, "keyFile": crate::nodetpl::TLS_KEY_FILE}]}}
        }]);
        sqlx::query("UPDATE nodes SET xray_inbounds = $2 WHERE id = $1")
            .bind(n)
            .bind(&tls)
            .execute(&db.pool)
            .await
            .unwrap();
        let d = desired_state(&db.pool, n).await.unwrap().unwrap();
        assert_eq!(
            d.snapshot.acme.as_ref().map(|a| a.domain.as_str()),
            Some("n1.example.com")
        );
        sqlx::query("UPDATE nodes SET enabled = false WHERE id = $1")
            .bind(n)
            .execute(&db.pool)
            .await
            .unwrap();
        let d = desired_state(&db.pool, n).await.unwrap().unwrap();
        assert!(d.snapshot.acme.is_none(), "a disabled node orders nothing");
        // The column refuses what the API refuses.
        for bad in ["1.2.3.4", "*.example.com", "Upper.example.com", "nodot"] {
            assert!(
                sqlx::query("UPDATE nodes SET tls_domain = $2 WHERE id = $1")
                    .bind(n)
                    .bind(bad)
                    .execute(&db.pool)
                    .await
                    .is_err(),
                "{bad}"
            );
        }
        db.drop().await;
    }

    #[test]
    fn cert_status_json_names() {
        use crate::gen::cert_status::{ErrorKind, State};
        let v = cert_status_json(&crate::gen::CertStatus {
            domain: "n1.example.com".into(),
            state: State::Failed as i32,
            not_after: 1_800_000_000,
            next_attempt: 0,
            last_error: "x".repeat(600),
            error_kind: ErrorKind::ErrorPortBusy as i32,
            last_error_at: 1_790_000_000,
            challenge: "http-01".into(),
            failures: 3,
        });
        assert_eq!(v["state"], "failed");
        assert_eq!(v["error_kind"], "port_busy");
        assert_eq!(v["next_attempt"], serde_json::Value::Null);
        assert_eq!(v["not_after"], "2027-01-15T08:00:00+00:00");
        assert_eq!(v["last_error"].as_str().unwrap().len(), 512);
        assert_eq!(v["failures"], 3);
        let ok = cert_status_json(&crate::gen::CertStatus {
            state: State::Valid as i32,
            ..Default::default()
        });
        assert_eq!(ok["state"], "valid");
        assert_eq!(ok["error_kind"], serde_json::Value::Null);
        assert_eq!(ok["last_error"], serde_json::Value::Null);
        // Fuzz (agent_messages) regression: agent text is bounded and free
        // of control characters in every field, not only the error.
        let hostile = cert_status_json(&crate::gen::CertStatus {
            domain: format!("node.e\0\0\0!le.com{}", "d".repeat(4096)),
            last_error: "line1\nline2\u{1b}[31m".into(),
            challenge: format!("http-01\r\n{}", "c".repeat(100)),
            ..Default::default()
        });
        let domain = hostile["domain"].as_str().unwrap();
        assert!(domain.starts_with("node.e!le.com") && domain.chars().count() == 253);
        assert_eq!(hostile["last_error"], "line1line2[31m");
        assert_eq!(hostile["challenge"].as_str().unwrap().len(), 32);
        assert!(!hostile.to_string().contains("\\u0000"));
    }

    /// B2: corrupt credentials are logged and the user is left out of the
    /// snapshot instead of being served as a valid empty inbound set; the
    /// healthy users are unaffected. (The 0050 CHECK already keeps non-array
    /// JSON out; a wrongly shaped array is what reaches this path.)
    #[tokio::test]
    async fn desired_state_skips_corrupt_credentials() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        sqlx::query(
            "UPDATE node_users SET credentials = '[{\"nope\": 1}]'::jsonb WHERE user_id = $1",
        )
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
        let d = desired_state(&db.pool, n).await.unwrap().unwrap();
        assert!(d.snapshot.users.is_empty());
        db.drop().await;
    }

    /// B7 (0050): the database refuses nonsense the app never writes.
    #[tokio::test]
    async fn check_constraints_reject_nonsense() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        for (sql, id) in [
            ("UPDATE users SET role = 'root' WHERE id = $1", u),
            ("UPDATE users SET traffic_used_bytes = -1 WHERE id = $1", u),
            ("UPDATE nodes SET status = 'zombie' WHERE id = $1", n),
            (
                "UPDATE node_users SET credentials = '{}'::jsonb WHERE user_id = $1",
                u,
            ),
        ] {
            let r = sqlx::query(sql).bind(id).execute(&db.pool).await;
            assert!(r.is_err(), "accepted: {sql}");
        }
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
            &NodeState::of_snapshot(s.inbounds_json.clone(), &s.users),
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
        assert!(
            crate::api::apply_begin_delete_node(&mut tx, &crate::audit::Actor::test(), n)
                .await
                .unwrap()
        );
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
        crate::api::apply_begin_delete_node(&mut tx, &crate::audit::Actor::test(), n)
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
