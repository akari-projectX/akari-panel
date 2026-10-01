//! Traffic accounting: agents report cumulative per-user counters; the panel
//! turns them into usage.
//!
//! Model (REVIEW P0 #2 / P1 #10): memory holds only the highest cumulative
//! value seen per (node, user, session) — no pending deltas. The delta is
//! computed by PostgreSQL at flush time against the persisted
//! `traffic_counters` row, in a single statement:
//!
//! ```text
//! upsert counters := GREATEST(stored, reported) ... RETURNING old, new
//! users.traffic_used_bytes += Σ max(new - coalesce(old, 0), 0)
//! ```
//!
//! Replaying a value (panel restart, flush retry, ambiguous commit, duplicate
//! or reordered reports) therefore never bills twice, and a failed flush
//! loses nothing: the next write of the same or a later cumulative value
//! recovers the delta.
//!
//! The session comes from `TrafficReport.session_id`, which the agent reads
//! atomically with the counters of the xray instance it names, so counters
//! within one session are monotonic. A lower value is therefore stale (e.g.
//! a report buffered in an old stream, processed after a newer one) or a
//! bug: it is logged and bills nothing. Reports without a session id
//! (pre-2026-10 agents) are rejected; agent and panel ship together.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use uuid::Uuid;

use crate::gen::TrafficReport;
use crate::state::AppState;

/// Clean (fully persisted) entries idle this long are evicted. Evicting is
/// always safe for billing: a later report for the same key is compared
/// against the persisted row, not against memory.
const PRUNE_IDLE: Duration = Duration::from_secs(600);

/// A row rejected by the database (data error, not connectivity) this many
/// flushes in a row is dropped so it cannot block the rest forever.
const MAX_ROW_FAILURES: u32 = 12;

/// Session ids are agent-chosen UUIDs. Bound them so a buggy agent cannot
/// inflate memory or feed PostgreSQL an invalid TEXT value (NUL).
const MAX_SESSION_LEN: usize = 128;

/// A node may have at most this many sessions with unpersisted values. A
/// report opening one more is dropped (warn). Reports for sessions already
/// in memory are always accepted (e.g. the final report of a rebuilt
/// instance). With a 5 s flush this admits ~3 new sessions/s per node, far
/// above legitimate rebuild rates, while bounding what a compromised node
/// can make the panel store and bill (REVIEW Phase C F1).
const MAX_DIRTY_SESSIONS_PER_NODE: usize = 16;

/// Absolute bound on rows per report (larger reports are dropped whole).
/// Non-member rows inside an admissible report are dropped one by one, so a
/// mass unassignment never loses the remaining users' final counters.
const MAX_REPORT_ROWS: usize = 65_536;

/// A key seen for the first time is assumed to have been counting for at
/// least this long when applying the plausibility cap.
const MIN_PLAUSIBLE_SECS: i64 = 60;

/// Added to the time since a row was last written: its previous value may
/// have been persisted up to a flush interval after the agent read it.
const PLAUSIBLE_SLACK_SECS: i64 = 15;

/// (node, user, agent session id)
type Key = (Uuid, Uuid, String);

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    /// Highest cumulative counters seen in this session.
    up: i64,
    down: i64,
    /// What was last durably written to `traffic_counters` (None = never).
    flushed: Option<(i64, i64)>,
    first_seen: Instant,
    touched: Instant,
    failures: u32,
}

impl Entry {
    fn new(now: Instant) -> Self {
        Self {
            up: 0,
            down: 0,
            flushed: None,
            first_seen: now,
            touched: now,
            failures: 0,
        }
    }

    /// Record a cumulative report, keeping the per-column high-water mark
    /// (what the database does too). Returns true if the report was lower.
    fn observe(&mut self, up: i64, down: i64, now: Instant) -> bool {
        let regressed = up < self.up || down < self.down;
        self.up = self.up.max(up);
        self.down = self.down.max(down);
        self.touched = now;
        regressed
    }

    fn dirty(&self) -> bool {
        self.flushed != Some((self.up, self.down))
    }
}

fn valid_session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_SESSION_LEN && !s.contains('\0')
}

#[derive(Default, Debug)]
struct NodeIndex {
    entries: usize,
    sessions: HashMap<String, SessionIndex>,
}

#[derive(Default, Debug)]
struct SessionIndex {
    users: HashSet<Uuid>,
    /// Entries of this session with unpersisted values.
    dirty: usize,
    touched: Option<Instant>,
}

#[derive(Default)]
pub struct TrafficBuffer {
    entries: DashMap<Key, Entry>,
    /// Per-node index of `entries` (counts, per-session users, dirtiness,
    /// recency), so admission, the dirty-session cap and eviction never scan
    /// `entries` (REVIEW Phase C N1).
    index: DashMap<Uuid, NodeIndex>,
    /// node -> users assigned to it (node_users). Loaded when an agent
    /// session starts and refreshed on every notify/reconcile. Reports for
    /// nodes without a loaded set, and rows for users outside it, are
    /// dropped before they touch memory (REVIEW Phase B H1).
    members: DashMap<Uuid, Arc<HashSet<Uuid>>>,
    /// Grace (seconds) during which a departed pair (node_users_departed)
    /// is still billed; 0 = DEFAULT_DEPARTED_GRACE_SECS.
    departed_grace: std::sync::atomic::AtomicU64,
    /// This instance's own flush health (R14 N1).
    health: std::sync::Mutex<FlushHealth>,
}

/// R14 N1: while this instance cannot flush (database down, failover),
/// its agents stay connected — no reconnect credit — and their backlog
/// would be cut to one burst window by the caps. So the instance remembers
/// when its last full flush succeeded; the first flush after failures
/// credits the nodes it writes back to that time (see `write_rows`). Only
/// this process's own failed flushes set `failing`: no agent input can.
struct FlushHealth {
    /// When the last successful full flush took its snapshot.
    last_ok: Instant,
    /// The last full flush failed.
    failing: bool,
    /// Tests: pretend `last_ok` was this much earlier.
    #[cfg(test)]
    backdate: Duration,
}

impl Default for FlushHealth {
    fn default() -> Self {
        Self {
            last_ok: Instant::now(),
            failing: false,
            #[cfg(test)]
            backdate: Duration::ZERO,
        }
    }
}

/// Default for `traffic.departed_grace_secs`: an unassigned user's final
/// counters (reported after the REMOVE delta) are still billed this long.
pub const DEFAULT_DEPARTED_GRACE_SECS: u64 = 900;

#[derive(Clone, Debug, PartialEq)]
struct FlushRow {
    node_id: Uuid,
    user_id: Uuid,
    session_id: String,
    up: i64,
    down: i64,
    /// Seconds since this key was first seen (plausibility cap when the DB
    /// has no row yet).
    age_secs: f64,
}

impl FlushRow {
    fn key(&self) -> Key {
        (self.node_id, self.user_id, self.session_id.clone())
    }
}

impl TrafficBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_departed_grace(&self, secs: u64) {
        self.departed_grace
            .store(secs, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn departed_grace_secs(&self) -> u64 {
        match self
            .departed_grace
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            0 => DEFAULT_DEPARTED_GRACE_SECS,
            s => s,
        }
    }

    /// Seconds since the last successful full flush, if the last full
    /// flush failed (this instance's own outage), else None.
    fn outage_secs(&self) -> Option<f64> {
        let h = self.health.lock().unwrap();
        #[cfg(test)]
        let elapsed = h.last_ok.elapsed() + h.backdate;
        #[cfg(not(test))]
        let elapsed = h.last_ok.elapsed();
        h.failing.then_some(elapsed.as_secs_f64())
    }

    fn flush_succeeded(&self, snapshot_at: Instant) {
        let mut h = self.health.lock().unwrap();
        h.failing = false;
        h.last_ok = snapshot_at;
        #[cfg(test)]
        {
            h.backdate = Duration::ZERO;
        }
    }

    fn flush_failed(&self) {
        self.health.lock().unwrap().failing = true;
    }

    /// Tests: pretend the last successful flush was `ago` ago (does NOT
    /// mark the instance failing; only a failed flush does).
    #[cfg(test)]
    pub fn backdate_last_ok(&self, ago: Duration) {
        let mut h = self.health.lock().unwrap();
        h.last_ok = Instant::now();
        h.backdate = ago;
    }

    #[cfg(test)]
    pub fn failing(&self) -> bool {
        self.health.lock().unwrap().failing
    }

    /// Record a report whose counters belong to `session_id`.
    pub fn update(&self, node_id: Uuid, session_id: &str, report: &TrafficReport) {
        self.update_at(node_id, session_id, report, Instant::now());
    }

    fn update_at(&self, node_id: Uuid, session_id: &str, report: &TrafficReport, now: Instant) {
        if session_id.is_empty() {
            tracing::warn!(node = %node_id, "traffic report without session_id dropped (agent predates the field; upgrade it)");
            return;
        }
        if !valid_session_id(session_id) {
            tracing::warn!(node = %node_id, len = session_id.len(), "traffic report with invalid session id dropped");
            return;
        }
        let Some(members) = self.members.get(&node_id).map(|m| m.clone()) else {
            tracing::warn!(node = %node_id, "traffic report before node membership was loaded; dropped");
            return;
        };
        if report.users.len() > MAX_REPORT_ROWS {
            tracing::warn!(node = %node_id, rows = report.users.len(), "oversized traffic report dropped");
            return;
        }
        // Hard bound on memory per node: every assigned user in every
        // admissible session.
        let max_entries = members.len().max(1) * MAX_DIRTY_SESSIONS_PER_NODE;
        let session = session_id.to_string();
        for u in &report.users {
            let Ok(user_id) = Uuid::parse_str(&u.user_id) else {
                tracing::warn!(node = %node_id, user = %u.user_id, "traffic report for unparseable user id");
                continue;
            };
            if !members.contains(&user_id) {
                tracing::debug!(node = %node_id, user = %user_id, "traffic for unassigned user dropped");
                continue;
            }
            let (Ok(up), Ok(down)) = (i64::try_from(u.up_bytes), i64::try_from(u.down_bytes))
            else {
                tracing::warn!(node = %node_id, user = %user_id, up = u.up_bytes, down = u.down_bytes,
                    "traffic counters exceed i64::MAX; row dropped");
                continue;
            };
            let key = (node_id, user_id, session.clone());
            if !self.entries.contains_key(&key) {
                if !self.session_known(node_id, session_id)
                    && self.dirty_sessions(node_id) >= MAX_DIRTY_SESSIONS_PER_NODE
                {
                    tracing::warn!(node = %node_id, session = %session_id,
                        "too many unpersisted sessions on node; report for new session dropped");
                    return;
                }
                if self.node_entry_count(node_id) >= max_entries
                    && !self.evict_oldest_clean_session(node_id, session_id)
                {
                    tracing::warn!(node = %node_id, "traffic entry cap reached for node; row dropped");
                    continue;
                }
            }
            let mut inserted = false;
            let mut e = self.entries.entry(key).or_insert_with(|| {
                inserted = true;
                Entry::new(now)
            });
            let was_dirty = !inserted && e.dirty();
            if e.observe(up, down, now) {
                tracing::warn!(node = %node_id, user = %user_id, session = %session_id,
                    "traffic counters went backwards within a session; ignored");
            }
            let dirty = e.dirty();
            // Index updated while the entry guard is held (lock order:
            // entries -> index), so no other writer can interleave.
            let mut idx = self.index.entry(node_id).or_default();
            if inserted {
                idx.entries += 1;
            }
            let sess = idx.sessions.entry(session.clone()).or_default();
            if inserted {
                sess.users.insert(user_id);
            }
            sess.dirty = (sess.dirty + usize::from(dirty)).saturating_sub(usize::from(was_dirty));
            sess.touched = Some(now);
            drop(idx);
            drop(e);
        }
    }

    /// Test helper: add users to a node's assigned set.
    #[cfg(test)]
    fn permit(&self, node_id: Uuid, users: &[Uuid]) {
        let mut set: HashSet<Uuid> = self
            .members
            .get(&node_id)
            .map(|m| (**m).clone())
            .unwrap_or_default();
        set.extend(users.iter().copied());
        self.set_members(node_id, set);
    }

    /// Replace the assigned-user set of a node.
    pub fn set_members(&self, node_id: Uuid, users: HashSet<Uuid>) {
        self.members.insert(node_id, Arc::new(users));
    }

    /// Index bookkeeping for a removed entry.
    fn forget(&self, key: &Key, was_dirty: bool) {
        let Some(mut idx) = self.index.get_mut(&key.0) else {
            return;
        };
        idx.entries = idx.entries.saturating_sub(1);
        if let Some(sess) = idx.sessions.get_mut(&key.2) {
            sess.users.remove(&key.1);
            if was_dirty {
                sess.dirty = sess.dirty.saturating_sub(1);
            }
            if sess.users.is_empty() {
                idx.sessions.remove(&key.2);
            }
        }
        let empty = idx.entries == 0;
        drop(idx);
        if empty {
            self.index.remove_if(&key.0, |_, i| i.entries == 0);
        }
    }

    /// Remove an entry; index bookkeeping happens inside the entry's shard
    /// lock (entries -> index), never after the entry left the map.
    fn remove(&self, key: &Key) {
        self.entries.remove_if(key, |k, e| {
            self.forget(k, e.dirty());
            true
        });
    }

    fn node_entry_count(&self, node_id: Uuid) -> usize {
        self.index.get(&node_id).map_or(0, |i| i.entries)
    }

    /// At the per-node cap: evict the node's least recently touched session
    /// with no unpersisted values, whole (always safe: billing compares
    /// against the DB row). Cost is proportional to the evicted session,
    /// not to the buffer. Never evicts `keep` (the session being written).
    fn evict_oldest_clean_session(&self, node_id: Uuid, keep: &str) -> bool {
        let victim = {
            let Some(idx) = self.index.get(&node_id) else {
                return false;
            };
            idx.sessions
                .iter()
                .filter(|(s, i)| i.dirty == 0 && s.as_str() != keep)
                .min_by_key(|(_, i)| i.touched)
                .map(|(s, i)| (s.clone(), i.users.iter().copied().collect::<Vec<_>>()))
        };
        let Some((session, users)) = victim else {
            return false;
        };
        let mut freed = false;
        for u in users {
            let key = (node_id, u, session.clone());
            // Skip anything that became dirty meanwhile.
            let removed = self.entries.remove_if(&key, |k, e| {
                let clean = !e.dirty();
                if clean {
                    self.forget(k, false);
                }
                clean
            });
            freed |= removed.is_some();
        }
        freed
    }

    fn session_known(&self, node_id: Uuid, session_id: &str) -> bool {
        self.index
            .get(&node_id)
            .is_some_and(|i| i.sessions.contains_key(session_id))
    }

    /// Distinct sessions of `node_id` with at least one unpersisted value.
    fn dirty_sessions(&self, node_id: Uuid) -> usize {
        self.index
            .get(&node_id)
            .map_or(0, |i| i.sessions.values().filter(|s| s.dirty > 0).count())
    }

    /// Everything not yet durably persisted, in a stable (user, node,
    /// session) order so concurrent flushers (e.g. two panel instances) lock
    /// `traffic_counters`/`users` rows in the same order and cannot
    /// deadlock. Nothing is cleared here.
    fn snapshot(&self) -> Vec<FlushRow> {
        let now = Instant::now();
        let mut rows: Vec<FlushRow> = self
            .entries
            .iter()
            .filter(|e| e.value().dirty())
            .map(|e| {
                let (node_id, user_id, session_id) = e.key().clone();
                FlushRow {
                    node_id,
                    user_id,
                    session_id,
                    up: e.value().up,
                    down: e.value().down,
                    age_secs: now.duration_since(e.value().first_seen).as_secs_f64(),
                }
            })
            .collect();
        rows.sort_by(|a, b| {
            (a.user_id, a.node_id, &a.session_id).cmp(&(b.user_id, b.node_id, &b.session_id))
        });
        rows
    }

    /// `rows` are durably written. Newer values that arrived meanwhile keep
    /// their entry dirty.
    fn mark_flushed(&self, rows: &[FlushRow]) {
        for r in rows {
            if let Some(mut e) = self.entries.get_mut(&r.key()) {
                let before = e.dirty();
                e.flushed = Some((r.up, r.down));
                e.failures = 0;
                if before && !e.dirty() {
                    // Still under the entry guard (entries -> index).
                    if let Some(mut idx) = self.index.get_mut(&r.node_id) {
                        if let Some(sess) = idx.sessions.get_mut(&r.session_id) {
                            sess.dirty = sess.dirty.saturating_sub(1);
                        }
                    }
                }
            }
        }
    }

    /// The database rejected this row on its own (not a connectivity
    /// error). After MAX_ROW_FAILURES consecutive rejections the entry is
    /// dropped so it cannot block the rest forever.
    fn mark_failed(&self, r: &FlushRow) {
        let give_up = match self.entries.get_mut(&r.key()) {
            Some(mut e) => {
                e.failures += 1;
                e.failures >= MAX_ROW_FAILURES
            }
            None => false,
        };
        if give_up {
            self.remove(&r.key());
            tracing::error!(node = %r.node_id, user = %r.user_id, session = %r.session_id,
                up = r.up, down = r.down, "traffic row repeatedly rejected by database; dropped");
        }
    }

    /// Evict fully persisted, idle entries.
    /// Evict fully persisted, idle entries, then rebuild the per-node index
    /// from `entries` (self-heal: whatever drift a bug could introduce
    /// lives at most one tick). Operations racing with the rebuild may be
    /// off by one until the next tick; they cannot corrupt `entries`.
    fn prune(&self, now: Instant) {
        self.entries.retain(|k, e| {
            let keep = e.dirty() || now.duration_since(e.touched) < PRUNE_IDLE;
            if !keep {
                self.forget(k, false);
            }
            keep
        });
        self.rebuild_index();
    }

    /// The node's last local session ended: drop its membership cache
    /// (reloaded when a session starts). Buffered entries stay until
    /// flushed.
    pub fn drop_members(&self, node_id: Uuid) {
        self.members.remove(&node_id);
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Drop everything held for a deleted node: its membership cache, its
    /// buffered entries (they can no longer be billed: its node_users rows
    /// are gone) and its index. Rare (node deletion), so a full scan is
    /// acceptable here — never on the report path.
    pub fn forget_node(&self, node_id: Uuid) {
        self.members.remove(&node_id);
        self.entries.retain(|k, e| {
            let keep = k.0 != node_id;
            if !keep {
                self.forget(k, e.dirty());
            }
            keep
        });
        self.index.remove(&node_id);
    }

    fn rebuild_index(&self) {
        let mut fresh: HashMap<Uuid, NodeIndex> = HashMap::new();
        for e in self.entries.iter() {
            let (node, user, session) = e.key();
            let idx = fresh.entry(*node).or_default();
            idx.entries += 1;
            let sess = idx.sessions.entry(session.clone()).or_default();
            sess.users.insert(*user);
            sess.dirty += usize::from(e.value().dirty());
            sess.touched = sess.touched.max(Some(e.value().touched));
        }
        self.index.retain(|n, _| fresh.contains_key(n));
        for (n, idx) in fresh {
            self.index.insert(n, idx);
        }
    }
}

/// One statement, run in `write_rows`' transaction after the input's node
/// rows are locked. Parameters: $1..$6 the rows, $7 per-key rate, $8
/// MIN_PLAUSIBLE_SECS, $9 PLAUSIBLE_SLACK_SECS, $10 departed grace, $11
/// default node rate, $12 burst window, $13 DEPARTED_SLACK_SECS. All times
/// are statement_timestamp() (never a transaction start that may precede a
/// concurrent flusher's writes).
///
/// Admission: only (node, user) pairs that are assigned (node_users) — or
/// were until less than $10 s ago (node_users_departed: the final counters
/// of an unassigned user arrive after the REMOVE) — are stored or billed: a
/// node cannot bill users it does not serve.
///
/// Credit window (R13): every cap counts time only back to the node's
/// floor = now − $12 (the burst window), or further back to
/// nodes.traffic_credit_floor while a reconnect credit is valid
/// (traffic_credit_until > now; granted once per real disconnection by
/// `grpc::set_online_row`, min(disconnected time, lease)). So an idle or
/// under-using node never accumulates more than a burst window, and only a
/// recorded connectivity gap lets delayed traffic bill in full.
///
/// Every cap only ever under-bills (the full counter is always stored):
/// 1. per row, assigned pair: the increase over the stored value, clamped
///    to $7 × (now − max(row last written, floor) + $9 s), or for a new row
///    × (time since first seen, at least $8 s, at most now − floor);
/// 2. per row, departed pair (R12 D6): $7 × max(0, departed_at + $13 −
///    start), start = max(row last written or first seen, floor); then per
///    departed PAIR the sum is clamped to $7 × max(0, departed_at + $13 −
///    earliest start) minus what the pair was already billed since the
///    departure (node_users_departed.billed_bytes, R13: cumulative across
///    flushes);
/// 3. per node (GCRA): tat = max(traffic_tat (NULL: now − 60 s), floor); the
///    node's sum is clamped to node_rate × max(0, now − tat), rows scaled
///    and floored (Σ ≤ allowance; no division when nothing was billed);
///    traffic_tat := tat + billed / node_rate (monotonic).
///
/// Returns the refused keys, the rows clamped by (1)/(2) and the nodes
/// clamped by (3).
const FLUSH_SQL: &str = r#"
WITH input AS (
    SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::bigint[], $5::bigint[], $6::float8[])
        AS t(node_id, user_id, session_id, up, down, age_secs)
), nf AS (
    SELECT n.id AS node_id,
           COALESCE(n.traffic_max_rate_bytes_per_sec, $11)::numeric AS rate,
           n.traffic_tat,
           CASE WHEN n.traffic_credit_until > statement_timestamp()
                THEN LEAST(statement_timestamp() - make_interval(secs => $12),
                           COALESCE(n.traffic_credit_floor, 'infinity'::timestamptz))
                ELSE statement_timestamp() - make_interval(secs => $12) END AS floor
    FROM nodes n WHERE n.id IN (SELECT DISTINCT node_id FROM input)
), member AS (
    SELECT i.*, CASE WHEN a.assigned THEN NULL ELSE d.departed_at END AS departed_at
    FROM input i
    CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM node_users nu
                                       WHERE nu.node_id = i.node_id AND nu.user_id = i.user_id)
                        AS assigned) a
    LEFT JOIN node_users_departed d
           ON d.node_id = i.node_id AND d.user_id = i.user_id
          AND d.departed_at > statement_timestamp() - make_interval(secs => $10)
    WHERE a.assigned OR d.departed_at IS NOT NULL
), upsert AS (
    INSERT INTO traffic_counters AS c
        (node_id, user_id, session_id, up_bytes, down_bytes, updated_at, first_seen_at)
    SELECT node_id, user_id, session_id, up, down, statement_timestamp(), statement_timestamp()
    FROM member
    ON CONFLICT (node_id, user_id, session_id) DO UPDATE
    SET up_bytes   = GREATEST(c.up_bytes, EXCLUDED.up_bytes),
        down_bytes = GREATEST(c.down_bytes, EXCLUDED.down_bytes),
        updated_at = GREATEST(c.updated_at, EXCLUDED.updated_at)
    RETURNING new.node_id, new.user_id, new.session_id,
              old.up_bytes AS old_up, old.down_bytes AS old_down, old.updated_at AS old_at,
              COALESCE(old.first_seen_at, old.updated_at) AS old_first,
              new.up_bytes AS new_up, new.down_bytes AS new_down
), rows AS (
    SELECT u.node_id, u.user_id, u.old_at, m.age_secs, m.departed_at, f.floor,
           GREATEST(u.new_up - COALESCE(u.old_up, 0), 0)::numeric
         + GREATEST(u.new_down - COALESCE(u.old_down, 0), 0)::numeric AS raw,
           GREATEST(COALESCE(GREATEST(u.old_at, u.old_first),
                             statement_timestamp() - make_interval(secs => m.age_secs)),
                    f.floor) AS start
    FROM upsert u JOIN member m USING (node_id, user_id, session_id)
    JOIN nf f USING (node_id)
), per_row AS (
    SELECT node_id, user_id, departed_at, start, raw,
           CASE WHEN departed_at IS NULL THEN
               $7::numeric * COALESCE(
                   GREATEST(extract(epoch FROM statement_timestamp() - GREATEST(old_at, floor)), 0)
                     + $9::numeric,
                   LEAST(GREATEST(age_secs::numeric, $8::numeric),
                         GREATEST(extract(epoch FROM statement_timestamp() - floor), 0)))
           ELSE
               $7::numeric * GREATEST(extract(epoch FROM
                   departed_at + make_interval(secs => $13) - start), 0)
           END AS cap
    FROM rows
), capped AS (
    SELECT node_id, user_id, departed_at, start, raw, cap, LEAST(raw, cap) AS amount FROM per_row
), pair AS (
    SELECT c.node_id, c.user_id, sum(c.amount) AS total,
           GREATEST($7::numeric * GREATEST(extract(epoch FROM
               min(c.departed_at) + make_interval(secs => $13) - min(c.start)), 0)
             - min(d.billed_bytes)::numeric, 0) AS allowance
    FROM capped c
    JOIN node_users_departed d ON d.node_id = c.node_id AND d.user_id = c.user_id
    WHERE c.departed_at IS NOT NULL
    GROUP BY c.node_id, c.user_id
), row2 AS (
    SELECT c.node_id, c.user_id, c.departed_at IS NOT NULL AS departed,
           CASE WHEN p.total > p.allowance THEN floor(c.amount * p.allowance / p.total)
                ELSE c.amount END AS amount
    FROM capped c LEFT JOIN pair p USING (node_id, user_id)
), node_cap AS (
    SELECT f.node_id, f.rate, g.tat, t.total,
           f.rate * GREATEST(extract(epoch FROM statement_timestamp() - g.tat), 0) AS allowance
    FROM nf f
    JOIN (SELECT node_id, sum(amount) AS total FROM row2 GROUP BY node_id) t USING (node_id)
    CROSS JOIN LATERAL (SELECT GREATEST(
        COALESCE(f.traffic_tat, statement_timestamp() - interval '60 seconds'), f.floor) AS tat) g
), scaled AS (
    SELECT r.node_id, r.user_id, r.departed,
           CASE WHEN nc.total > nc.allowance THEN floor(r.amount * nc.allowance / nc.total)
                ELSE r.amount END AS billed
    FROM row2 r JOIN node_cap nc USING (node_id)
), per_user AS (
    SELECT user_id, sum(billed) AS delta FROM scaled GROUP BY user_id
), billed AS (
    UPDATE users u
    SET traffic_used_bytes = LEAST(u.traffic_used_bytes::numeric + p.delta, 9223372036854775807)::bigint
    FROM per_user p
    WHERE u.id = p.user_id AND p.delta > 0
    RETURNING 1
), departed_billed AS (
    UPDATE node_users_departed d
    SET billed_bytes = LEAST(d.billed_bytes::numeric + b.billed, 9223372036854775807)::bigint
    FROM (SELECT node_id, user_id, sum(billed) AS billed FROM scaled
          WHERE departed GROUP BY node_id, user_id) b
    WHERE d.node_id = b.node_id AND d.user_id = b.user_id AND b.billed > 0
    RETURNING 1
), advanced AS (
    UPDATE nodes n
    SET traffic_tat = GREATEST(
            COALESCE(n.traffic_tat, '-infinity'::timestamptz),
            nc.tat + make_interval(secs => (b.billed / nc.rate)::float8))
    FROM node_cap nc
    JOIN (SELECT node_id, sum(billed) AS billed FROM scaled GROUP BY node_id) b USING (node_id)
    WHERE n.id = nc.node_id
    RETURNING 1
)
SELECT coalesce(array_agg(i.node_id), '{}') AS dropped_nodes,
       coalesce(array_agg(i.user_id), '{}') AS dropped_users,
       coalesce(array_agg(i.session_id), '{}') AS dropped_sessions,
       (SELECT count(*) FROM per_row WHERE raw > cap) AS clamped,
       (SELECT count(*) FROM node_cap WHERE total > allowance) AS nodes_clamped,
       (SELECT LEAST(coalesce(sum(delta) FILTER (WHERE delta > 0), 0),
                     9223372036854775807)::bigint FROM per_user) AS billed_total
FROM input i
WHERE NOT EXISTS (SELECT 1 FROM member m
                  WHERE m.node_id = i.node_id AND m.user_id = i.user_id AND m.session_id = i.session_id)
"#;

/// Departed pairs (R12 D6): traffic up to this long after departed_at is
/// still plausible (≈ 2 report intervals + a flush).
const DEPARTED_SLACK_SECS: i64 = 30;

/// Rate limits for `write_rows`.
#[derive(Clone, Copy, Debug)]
pub struct Rates {
    /// traffic.max_rate_bytes_per_sec (per key).
    pub key: i64,
    /// traffic.node_max_rate_bytes_per_sec (per node, unless overridden).
    pub node: i64,
    /// Burst window: the longest period any cap credits, except for a
    /// recorded reconnect gap or flush outage (traffic.node_burst_secs).
    pub burst_secs: i64,
    /// Upper bound of any credit (grpc.lease_seconds, clamped).
    pub lease_secs: i64,
}

impl Rates {
    pub fn from_cfg(cfg: &crate::config::PanelConfig) -> Self {
        Self {
            key: cfg.traffic.max_rate_bytes_per_sec.max(1),
            node: cfg.traffic.node_max_rate_bytes_per_sec.max(1),
            burst_secs: cfg.traffic.node_burst_secs.max(1) as i64,
            lease_secs: cfg.grpc.lease_seconds() as i64,
        }
    }
}

/// R14 N1: credit this instance's own flush outage (`outage_secs` since its
/// last successful flush, at most the lease) to `nodes` — the nodes whose
/// backlog is being written now, rows already locked. Same one-time
/// semantics as the reconnect credit (grpc::set_online_row): a credit is
/// valid for one burst window from the grant and never extended; a valid
/// credit's floor is only lowered (LEAST), never raised. An outage no
/// longer than the burst window is covered by the window itself. Runs in
/// the flush transaction, so it exists only if that flush commits.
const OUTAGE_CREDIT_SQL: &str = "\
UPDATE nodes SET
    traffic_credit_floor = CASE WHEN traffic_credit_until > statement_timestamp()
        THEN LEAST(traffic_credit_floor, statement_timestamp() - make_interval(secs => $2))
        ELSE statement_timestamp() - make_interval(secs => $2) END,
    traffic_credit_until = CASE WHEN traffic_credit_until > statement_timestamp()
        THEN traffic_credit_until
        ELSE statement_timestamp() + make_interval(secs => $3) END
WHERE id IN (SELECT DISTINCT unnest($1::uuid[]))";

/// Writes `rows` in one transaction: lock the rows' nodes (id order, the
/// global lock order: nodes before users), then FLUSH_SQL. The node locks
/// serialize concurrent flushers of the same node (e.g. two panel
/// instances), so each reads the traffic_flushed_at the other advanced.
/// Returns the keys the database refused as unassigned.
async fn write_rows(
    pg: &sqlx::PgPool,
    rows: &[FlushRow],
    rates: Rates,
    grace_secs: u64,
    outage_secs: Option<f64>,
) -> Result<Vec<Key>, sqlx::Error> {
    let nodes: Vec<Uuid> = rows.iter().map(|r| r.node_id).collect();
    let users: Vec<Uuid> = rows.iter().map(|r| r.user_id).collect();
    let sessions: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
    let ups: Vec<i64> = rows.iter().map(|r| r.up).collect();
    let downs: Vec<i64> = rows.iter().map(|r| r.down).collect();
    let ages: Vec<f64> = rows.iter().map(|r| r.age_secs).collect();
    let mut tx = pg.begin().await?;
    sqlx::query(
        "SELECT 1 FROM nodes WHERE id IN (SELECT DISTINCT unnest($1::uuid[])) \
         ORDER BY id FOR NO KEY UPDATE",
    )
    .bind(&nodes)
    .execute(&mut *tx)
    .await?;
    if let Some(secs) = outage_secs.filter(|s| *s > rates.burst_secs as f64) {
        let n = sqlx::query(OUTAGE_CREDIT_SQL)
            .bind(&nodes)
            .bind(secs.min(rates.lease_secs as f64))
            .bind(rates.burst_secs as f64)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        tracing::info!(
            nodes = n,
            outage_secs = secs as u64,
            "crediting this instance's flush outage to its nodes' billing caps"
        );
    }
    let (dn, du, ds, clamped, nodes_clamped, billed_total): (
        Vec<Uuid>,
        Vec<Uuid>,
        Vec<String>,
        i64,
        i64,
        i64,
    ) = sqlx::query_as(FLUSH_SQL)
        .bind(&nodes)
        .bind(&users)
        .bind(&sessions)
        .bind(&ups)
        .bind(&downs)
        .bind(&ages)
        .bind(rates.key)
        .bind(MIN_PLAUSIBLE_SECS)
        .bind(PLAUSIBLE_SLACK_SECS)
        .bind(grace_secs as f64)
        .bind(rates.node)
        .bind(rates.burst_secs)
        .bind(DEPARTED_SLACK_SECS)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::metrics::billed(billed_total);
    if !dn.is_empty() {
        tracing::warn!(
            rows = dn.len(),
            "traffic for unassigned (node, user) pairs not billed"
        );
    }
    if clamped > 0 {
        tracing::warn!(
            rows = clamped,
            max_rate = rates.key,
            "implausible traffic deltas clamped"
        );
    }
    if nodes_clamped > 0 {
        tracing::warn!(
            nodes = nodes_clamped,
            default_node_rate = rates.node,
            "implausible per-node traffic clamped (scaled proportionally)"
        );
    }
    Ok(dn
        .into_iter()
        .zip(du)
        .zip(ds)
        .map(|((n, u), s)| (n, u, s))
        .collect())
}

/// Only data/integrity errors (SQLSTATE class 22/23) are properties of the
/// row itself. Everything else (serialization/deadlock 40xxx, lock timeout
/// 55P03, statement timeout 57014, connection loss, ...) is transient: the
/// write is idempotent, so it is simply retried next tick.
fn is_row_poison(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Database(d) => d
            .code()
            .is_some_and(|c| c.starts_with("22") || c.starts_with("23")),
        _ => false,
    }
}

/// Persist `buf`'s dirty rows. A data error on the batch falls back to
/// per-row writes so one bad row cannot poison the rest; transient errors
/// keep everything for the next tick (retry is idempotent).
async fn flush_buffer(
    pg: &sqlx::PgPool,
    buf: &TrafficBuffer,
    rates: Rates,
    only_node: Option<Uuid>,
) -> anyhow::Result<usize> {
    let snapshot_at = Instant::now();
    let outage = buf.outage_secs();
    let r = flush_rows(pg, buf, rates, only_node, outage).await;
    // Only a full flush says anything about this instance's health.
    if only_node.is_none() {
        crate::metrics::flush_done(snapshot_at.elapsed(), r.is_ok());
        match &r {
            Ok(_) => buf.flush_succeeded(snapshot_at),
            Err(_) => buf.flush_failed(),
        }
    }
    r
}

async fn flush_rows(
    pg: &sqlx::PgPool,
    buf: &TrafficBuffer,
    rates: Rates,
    only_node: Option<Uuid>,
    outage: Option<f64>,
) -> anyhow::Result<usize> {
    let mut rows = buf.snapshot();
    if let Some(n) = only_node {
        rows.retain(|r| r.node_id == n);
    }
    if rows.is_empty() {
        // Nothing buffered: nothing of this instance's is unbilled.
        return Ok(0);
    }
    let grace = buf.departed_grace_secs();
    match write_rows(pg, &rows, rates, grace, outage).await {
        Ok(dropped) => {
            buf.mark_flushed(&rows);
            // Refused rows are removed, not kept as "flushed": they must
            // not occupy memory or admission slots.
            for k in &dropped {
                buf.remove(k);
            }
            Ok(rows.len() - dropped.len())
        }
        Err(e) if is_row_poison(&e) => {
            tracing::warn!(error = %e, rows = rows.len(), "traffic batch rejected; retrying row by row");
            let mut written = 0;
            for r in &rows {
                match write_rows(pg, std::slice::from_ref(r), rates, grace, outage).await {
                    Ok(dropped) => {
                        if dropped.is_empty() {
                            buf.mark_flushed(std::slice::from_ref(r));
                            written += 1;
                        } else {
                            buf.remove(&r.key());
                        }
                    }
                    Err(e) if is_row_poison(&e) => {
                        tracing::warn!(error = %e, node = %r.node_id, user = %r.user_id, "traffic row rejected");
                        buf.mark_failed(r);
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            Ok(written)
        }
        Err(e) => Err(e.into()),
    }
}

/// Load `node_id`'s assigned users — plus users unassigned less than the
/// departed grace ago (their final counters are still billable) — into the
/// buffer's membership cache.
pub async fn refresh_members(
    pg: &sqlx::PgPool,
    buf: &TrafficBuffer,
    node_id: Uuid,
) -> sqlx::Result<()> {
    let users: Vec<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM node_users WHERE node_id = $1 \
         UNION SELECT user_id FROM node_users_departed \
         WHERE node_id = $1 AND departed_at > now() - make_interval(secs => $2)",
    )
    .bind(node_id)
    .bind(buf.departed_grace_secs() as f64)
    .fetch_all(pg)
    .await?;
    buf.set_members(node_id, users.into_iter().collect());
    Ok(())
}

/// Departed pairs past the grace can no longer be billed: drop them.
async fn prune_departed(pg: &sqlx::PgPool, grace_secs: u64) {
    if let Err(e) = sqlx::query(
        "DELETE FROM node_users_departed WHERE departed_at <= now() - make_interval(secs => $1)",
    )
    .bind(grace_secs as f64)
    .execute(pg)
    .await
    {
        tracing::warn!(error = %e, "failed to prune departed node users");
    }
}

pub async fn flush_loop(state: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if let Err(e) = flush_once(&state).await {
            tracing::warn!(error = %e, "traffic flush failed");
        }
    }
}

#[cfg(test)]
pub async fn flush_for_test(pg: &sqlx::PgPool, buf: &TrafficBuffer) {
    let rates = Rates::from_cfg(&crate::config::PanelConfig::default());
    flush_buffer(pg, buf, rates, None).await.unwrap();
}

/// Persist (and bill) everything this instance buffered (the shutdown's
/// final flush). Counts toward the instance's flush health like the loop.
pub async fn flush_all(state: &AppState) -> anyhow::Result<usize> {
    flush_buffer(
        state.pg(),
        state.traffic(),
        Rates::from_cfg(state.cfg()),
        None,
    )
    .await
}

/// Persist (and bill) what this instance buffered for `node_id` now — used
/// right before the node is deleted, so its last window is billed.
pub async fn flush_node(state: &AppState, node_id: Uuid) -> anyhow::Result<usize> {
    flush_buffer(
        state.pg(),
        state.traffic(),
        Rates::from_cfg(state.cfg()),
        Some(node_id),
    )
    .await
}

async fn flush_once(state: &AppState) -> anyhow::Result<()> {
    // Persist first so limit enforcement sees the freshest usage; a failure
    // of either step must not block the other.
    let flushed = flush_buffer(
        state.pg(),
        state.traffic(),
        Rates::from_cfg(state.cfg()),
        None,
    )
    .await;
    state.traffic().prune(Instant::now());
    prune_departed(state.pg(), state.traffic().departed_grace_secs()).await;
    let enforced = crate::enforce::run_all(state).await;
    let n = flushed?;
    if n > 0 {
        tracing::debug!(rows = n, "traffic flushed");
    }
    enforced
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gen::UserTraffic;

    fn report(users: &[(Uuid, u64, u64)]) -> TrafficReport {
        TrafficReport {
            users: users
                .iter()
                .map(|&(u, up, down)| UserTraffic {
                    user_id: u.to_string(),
                    up_bytes: up,
                    down_bytes: down,
                })
                .collect(),
            ..Default::default()
        }
    }

    fn ids() -> (TrafficBuffer, Uuid, Uuid) {
        let (b, n, u) = (TrafficBuffer::new(), Uuid::new_v4(), Uuid::new_v4());
        b.permit(n, &[u]);
        (b, n, u)
    }

    fn rows(b: &TrafficBuffer) -> Vec<(String, i64, i64)> {
        let mut v: Vec<_> = b
            .snapshot()
            .into_iter()
            .map(|r| (r.session_id, r.up, r.down))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn memory_keeps_latest_cumulative_not_deltas() {
        let (b, n, u) = ids();
        b.update(n, "s1", &report(&[(u, 100, 1000)]));
        b.update(n, "s1", &report(&[(u, 150, 1600)]));
        assert_eq!(rows(&b), vec![("s1".into(), 150, 1600)]);
    }

    #[test]
    fn sessions_are_independent_keys() {
        let (b, n, u) = ids();
        b.update(n, "sa", &report(&[(u, 500, 500)]));
        b.update(n, "sb", &report(&[(u, 10, 20)]));
        b.update(n, "sa", &report(&[(u, 600, 600)]));
        assert_eq!(
            rows(&b),
            vec![("sa".into(), 600, 600), ("sb".into(), 10, 20)]
        );
    }

    #[test]
    fn regression_is_ignored_per_column() {
        let (b, n, u) = ids();
        b.update(n, "s1", &report(&[(u, 1000, 10)]));
        b.update(n, "s1", &report(&[(u, 50, 60)]));
        assert_eq!(rows(&b), vec![("s1".into(), 1000, 60)]);
    }

    #[test]
    fn failed_flush_leaves_everything_for_retry() {
        let (b, n, u) = ids();
        b.update(n, "s1", &report(&[(u, 100, 200)]));
        let failed = b.snapshot(); // write fails: no mark_flushed
        b.update(n, "s1", &report(&[(u, 150, 260)]));
        assert_eq!(failed.len(), 1);
        assert_eq!(rows(&b), vec![("s1".into(), 150, 260)]);
    }

    #[test]
    fn value_arriving_during_flush_stays_dirty() {
        let (b, n, u) = ids();
        b.update(n, "s1", &report(&[(u, 100, 100)]));
        let snap = b.snapshot();
        b.update(n, "s1", &report(&[(u, 130, 190)]));
        b.mark_flushed(&snap);
        assert_eq!(rows(&b), vec![("s1".into(), 130, 190)]);
        b.mark_flushed(&b.snapshot());
        assert!(b.snapshot().is_empty());
    }

    #[test]
    fn repeatedly_rejected_row_is_dropped_others_unaffected() {
        let (b, n, u) = ids();
        let u2 = Uuid::new_v4();
        b.permit(n, &[u2]);
        b.update(n, "s1", &report(&[(u, 1, 1), (u2, 2, 2)]));
        let bad = b.snapshot().into_iter().find(|r| r.user_id == u).unwrap();
        for _ in 0..MAX_ROW_FAILURES - 1 {
            b.mark_failed(&bad);
            assert_eq!(b.snapshot().len(), 2);
        }
        b.mark_failed(&bad);
        let left = b.snapshot();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].user_id, u2);
    }

    #[test]
    fn prune_only_evicts_clean_idle_entries() {
        let (b, n, u) = ids();
        let t0 = Instant::now();
        b.update_at(n, "clean", &report(&[(u, 1, 1)]), t0);
        b.mark_flushed(&b.snapshot());
        b.update_at(n, "dirty", &report(&[(u, 2, 2)]), t0);
        b.prune(t0 + Duration::from_secs(1));
        assert_eq!(b.entries.len(), 2, "recent entries kept");
        b.prune(t0 + PRUNE_IDLE + Duration::from_secs(1));
        assert!(!b.entries.contains_key(&(n, u, "clean".into())));
        assert!(b.entries.contains_key(&(n, u, "dirty".into())));
    }

    #[test]
    fn invalid_input_is_dropped() {
        let (b, n, u) = ids();
        b.update(n, "", &report(&[(u, 1, 1)]));
        b.update(n, "a\0b", &report(&[(u, 1, 1)]));
        b.update(n, &"x".repeat(MAX_SESSION_LEN + 1), &report(&[(u, 1, 1)]));
        assert!(b.entries.is_empty());
        let v = Uuid::new_v4();
        b.permit(n, &[v]);
        let mut r = report(&[(u, u64::MAX, 7), (v, 3, 4), (Uuid::new_v4(), 5, 5)]);
        r.users.push(UserTraffic {
            user_id: "not-a-uuid".into(),
            up_bytes: 9,
            down_bytes: 9,
        });
        b.update(n, "s1", &r);
        assert_eq!(b.entries.len(), 1, "only the valid, assigned row is kept");
        assert!(!b.entries.contains_key(&(n, u, "s1".into())));
        let max = i64::MAX as u64;
        b.update(n, "s1", &report(&[(u, max, max)]));
        assert!(b.entries.contains_key(&(n, u, "s1".into())));
    }
}

/// Real-PostgreSQL tests of the flush statement (see testdb.rs).
#[cfg(test)]
mod db_tests {
    use super::*;
    use crate::gen::UserTraffic;
    use crate::testdb::TestDb;

    /// A buffer whose membership cache holds every current assignment.
    async fn buf(db: &TestDb) -> TrafficBuffer {
        let b = TrafficBuffer::new();
        let nodes: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM nodes")
            .fetch_all(&db.pool)
            .await
            .unwrap();
        for n in nodes {
            refresh_members(&db.pool, &b, n).await.unwrap();
        }
        b
    }

    /// Default plausibility cap (10 Gbit/s).
    const RATE: i64 = 1_250_000_000;
    /// Default rates (per key and per node) and burst window.
    const RATES: Rates = Rates {
        key: RATE,
        node: RATE,
        burst_secs: crate::config::DEFAULT_NODE_BURST_SECS as i64,
        lease_secs: 86400,
    };

    trait Flush {
        async fn flush(&self, b: &TrafficBuffer) -> usize;
    }

    impl Flush for TestDb {
        async fn flush(&self, b: &TrafficBuffer) -> usize {
            flush_buffer(&self.pool, b, RATES, None).await.unwrap()
        }
    }

    fn report(u: Uuid, up: u64, down: u64) -> TrafficReport {
        TrafficReport {
            users: vec![UserTraffic {
                user_id: u.to_string(),
                up_bytes: up,
                down_bytes: down,
            }],
            ..Default::default()
        }
    }

    /// R10 F1: the agent reports an unassigned user's final counters after
    /// the REMOVE (and after the watcher refreshed membership). Within the
    /// departed grace they are billed; 20 min later the same pair is not.
    #[tokio::test]
    async fn departed_user_final_counters_billed_within_grace_only() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        b.update(n, "s1", &report(u, 100, 0));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 100);

        let mut tx = db.pool.begin().await.unwrap();
        crate::api::apply_unassign(&mut tx, u, n).await.unwrap();
        tx.commit().await.unwrap();
        refresh_members(&db.pool, &b, n).await.unwrap(); // watcher, before the final report
        b.update(n, "s1", &report(u, 250, 0));
        db.flush(&b).await;
        assert_eq!(
            db.used(u).await,
            250,
            "final counters after unassign are billed"
        );

        sqlx::query("UPDATE node_users_departed SET departed_at = now() - interval '20 minutes'")
            .execute(&db.pool)
            .await
            .unwrap();
        // SQL gate (a cache that still admits the pair must not matter).
        let row = FlushRow {
            node_id: n,
            user_id: u,
            session_id: "s1".into(),
            up: 400,
            down: 0,
            age_secs: 60.0,
        };
        let dropped = write_rows(&db.pool, &[row], RATES, DEFAULT_DEPARTED_GRACE_SECS, None)
            .await
            .unwrap();
        assert_eq!(dropped.len(), 1);
        assert_eq!(db.used(u).await, 250, "past the grace: not billed");
        // Memory gate: after the next refresh the pair is gone.
        refresh_members(&db.pool, &b, n).await.unwrap();
        b.update(n, "s1", &report(u, 500, 0));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 250);
        prune_departed(&db.pool, DEFAULT_DEPARTED_GRACE_SECS).await;
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM node_users_departed")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(left, 0, "expired departed rows are pruned");
        db.drop().await;
    }

    #[tokio::test]
    async fn panel_restart_between_reports_bills_only_the_increase() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let before = buf(&db).await;
        before.update(n, "s1", &report(u, 1000, 5000));
        db.flush(&before).await;
        // Reported but never flushed: the panel dies here.
        before.update(n, "s1", &report(u, 1200, 5500));
        drop(before);

        let after = buf(&db).await;
        after.update(n, "s1", &report(u, 1300, 6000));
        db.flush(&after).await;
        assert_eq!(db.used(u).await, 1300 + 6000);
        db.drop().await;
    }

    #[tokio::test]
    async fn replayed_flush_is_idempotent() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        b.update(n, "s1", &report(u, 100, 200));
        let rows = b.snapshot();
        // Ambiguous commit: written, but the panel thinks it failed.
        write_rows(&db.pool, &rows, RATES, DEFAULT_DEPARTED_GRACE_SECS, None)
            .await
            .unwrap();
        db.flush(&b).await;
        db.flush(&b).await;
        write_rows(&db.pool, &rows, RATES, DEFAULT_DEPARTED_GRACE_SECS, None)
            .await
            .unwrap();
        assert_eq!(db.used(u).await, 300);
        db.drop().await;
    }

    #[tokio::test]
    async fn failed_flush_is_fully_recovered_by_next_report() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        b.update(n, "s1", &report(u, 100, 100));
        db.flush(&b).await;
        b.update(n, "s1", &report(u, 400, 100));
        let _lost = b.snapshot(); // transaction failed
                                  // Even if memory were wiped (eviction/restart), the next cumulative
                                  // report carries the missed delta.
        let fresh = buf(&db).await;
        fresh.update(n, "s1", &report(u, 450, 150));
        db.flush(&fresh).await;
        assert_eq!(db.used(u).await, 450 + 150);
        db.drop().await;
    }

    #[tokio::test]
    async fn alternating_sessions_do_not_overcount() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        for i in 1..=5u64 {
            b.update(n, "sa", &report(u, 100 * i, 0));
            db.flush(&b).await;
            b.update(n, "sb", &report(u, 10 * i, 0));
            // Same value re-sent (duplicate stream / retry): bills nothing.
            b.update(n, "sa", &report(u, 100 * i, 0));
            db.flush(&b).await;
        }
        assert_eq!(db.used(u).await, 500 + 50);
        db.drop().await;
    }

    #[tokio::test]
    async fn stale_or_regressed_values_bill_nothing() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        b.update(n, "s1", &report(u, 200, 0));
        b.update(n, "s1", &report(u, 150, 0)); // stale, out of order
        b.update(n, "s1", &report(u, 300, 0));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 300);
        // A second panel instance (fresh memory) replaying the stale value.
        let other = buf(&db).await;
        other.update(n, "s1", &report(u, 150, 0));
        db.flush(&other).await;
        assert_eq!(db.used(u).await, 300);
        db.drop().await;
    }

    /// The agent-fixed main path (REVIEW P0 #2 / red team): the first
    /// Snapshot rebuilds xray under a new session S1 that the stream's Hello
    /// (S0) does not name; reports carry S1. Then the stream reconnects
    /// (Hello S1), the panel restarts, and another rebuild starts S2. Only
    /// increases are ever billed.
    #[tokio::test]
    async fn rebuild_then_reconnect_then_restart_bills_only_increase() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let rep = |s: &str, up| {
            let mut r = report(u, up, 0);
            r.session_id = s.into();
            r
        };
        // The Hello session (2nd arg) is deliberately ignored: only the
        // report's own session_id counts.
        let feed = |b: &TrafficBuffer, _hello: &str, r: TrafficReport| {
            b.update(n, &r.session_id, &r);
        };
        let panel = buf(&db).await;
        feed(&panel, "s0", rep("s1", 1000));
        db.flush(&panel).await;
        feed(&panel, "s1", rep("s1", 1500)); // reconnected
        db.flush(&panel).await;
        let panel = buf(&db).await; // panel restart
        feed(&panel, "s1", rep("s1", 1600));
        db.flush(&panel).await;
        feed(&panel, "s1", rep("s1", 1700)); // final report before rebuild
        feed(&panel, "s1", rep("s2", 40)); // new instance, Hello not yet seen
        db.flush(&panel).await;
        assert_eq!(db.used(u).await, 1700 + 40);
        db.drop().await;
    }

    /// Red team RT1: one late (stale) report per flip, e.g. buffered in an
    /// old stream task after reconnect. Must never over-bill.
    #[tokio::test]
    async fn rt1_stale_reorder_never_overbills() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        let mut truth = 0;
        for k in 1..=10u64 {
            truth = 1000 * k;
            b.update(n, "s1", &report(u, truth, 0));
            db.flush(&b).await;
            b.update(n, "s1", &report(u, truth - 100, 0));
            db.flush(&b).await;
        }
        b.update(n, "s1", &report(u, truth, 0));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, truth as i64);
        db.drop().await;
    }

    /// Red team RT1b: every report through fresh memory (restarts between
    /// each), interleaving stale values: GREATEST alone keeps it exact.
    #[tokio::test]
    async fn rt1b_reorder_across_restarts_is_exact() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        for v in [1000u64, 900, 2000, 1900, 3000] {
            let b = buf(&db).await;
            b.update(n, "s1", &report(u, v, 0));
            db.flush(&b).await;
        }
        assert_eq!(db.used(u).await, 3000);
        db.drop().await;
    }

    /// Red team RT2: two flushers (e.g. two panel instances) writing
    /// overlapping keys concurrently. Errors (if any) are transient and the
    /// retry is idempotent: final billing equals the high-water mark.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn rt2_concurrent_flushers_bill_exactly() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        let mut us = vec![];
        for _ in 0..40 {
            let u = db.user().await;
            db.assign(n, u).await;
            us.push(u);
        }
        let mut errors = 0;
        for round in 1..=30u64 {
            let (a, b) = (buf(&db).await, buf(&db).await);
            for (i, &u) in us.iter().enumerate() {
                a.update(n, "s1", &report(u, round * 100 + i as u64, 0));
            }
            for (i, &u) in us.iter().enumerate().rev() {
                b.update(n, "s1", &report(u, round * 100 + i as u64 + 50, 0));
            }
            let (ra, rb) = tokio::join!(
                flush_buffer(&db.pool, &a, RATES, None),
                flush_buffer(&db.pool, &b, RATES, None)
            );
            errors += ra.is_err() as u32 + rb.is_err() as u32;
            db.flush(&a).await;
            db.flush(&b).await;
        }
        for (i, &u) in us.iter().enumerate() {
            assert_eq!(db.used(u).await, 30 * 100 + i as i64 + 50, "user {i}");
        }
        eprintln!("rt2: transient errors retried: {errors}");
        db.drop().await;
    }

    /// Red team RT3: transient errors (here lock_timeout, SQLSTATE 55P03)
    /// must not count toward MAX_ROW_FAILURES and must not drop anything.
    #[tokio::test]
    async fn rt3_transient_errors_never_drop_rows() {
        let Some(db) = TestDb::with_options(&[("lock_timeout", "50ms")]).await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        b.update(n, "s1", &report(u, 1000, 0));
        db.flush(&b).await;
        b.update(n, "s1", &report(u, 1500, 0));
        let mut tx = db.admin.begin().await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT 1 FROM {}.users WHERE id = $1 FOR UPDATE",
            db.schema
        )))
        .bind(u)
        .execute(&mut *tx)
        .await
        .unwrap();
        for _ in 0..MAX_ROW_FAILURES + 2 {
            assert!(flush_buffer(&db.pool, &b, RATES, None).await.is_err());
        }
        tx.rollback().await.unwrap();
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 1500);
        db.drop().await;
    }

    #[tokio::test]
    async fn one_bad_row_does_not_poison_the_batch() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, good, bad) = (db.node().await, db.user().await, db.user().await);
        db.assign(n, good).await;
        db.assign(n, bad).await;
        let b = buf(&db).await;
        b.update(n, "s1", &report(good, 10, 10));
        // Bypass validation to plant a row PostgreSQL rejects (NUL in TEXT).
        b.entries
            .entry((n, bad, "bad\0session".into()))
            .or_insert_with(|| Entry::new(Instant::now()))
            .observe(5, 5, Instant::now());
        assert_eq!(db.flush(&b).await, 1);
        assert_eq!(db.used(good).await, 20);
        for _ in 1..MAX_ROW_FAILURES {
            db.flush(&b).await;
        }
        assert!(
            b.snapshot().is_empty(),
            "bad row given up after MAX_ROW_FAILURES"
        );
        assert_eq!(db.used(good).await, 20);
        assert_eq!(db.used(bad).await, 0);
        db.drop().await;
    }

    #[tokio::test]
    async fn usage_saturates_instead_of_overflowing() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        let max = i64::MAX as u64;
        b.update(n, "s1", &report(u, max, max));
        let unlimited = Rates {
            key: i64::MAX,
            node: i64::MAX,
            burst_secs: RATES.burst_secs,
            lease_secs: RATES.lease_secs,
        };
        flush_buffer(&db.pool, &b, unlimited, None).await.unwrap();
        assert_eq!(db.used(u).await, i64::MAX);
        db.drop().await;
    }

    /// Red team C-RT7: a node cannot bill a user it does not serve.
    #[tokio::test]
    async fn c_rt7_unassigned_user_is_not_billed() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = (db.node().await, db.user().await);
        let b = buf(&db).await;
        b.update(n, "s1", &report(u, 5, 5));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 0);
        assert!(
            b.snapshot().is_empty(),
            "dropped rows must not retry forever"
        );
        db.drop().await;
    }

    /// Red team C-RT6: minting 1000 sessions for an unassigned victim bills
    /// nothing and stores at most MAX_DIRTY_SESSIONS_PER_NODE sessions.
    #[tokio::test]
    async fn c_rt6_session_minting_is_bounded_and_unbilled() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, victim) = (db.node().await, db.user().await);
        let b = buf(&db).await;
        for i in 0..1000 {
            b.update(n, &format!("mint-{i}"), &report(victim, 1_000_000_000, 0));
        }
        assert_eq!(b.entries.len(), 0, "unassigned victim never enters memory");
        db.flush(&b).await;
        assert_eq!(db.used(victim).await, 0);
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM traffic_counters")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(rows, 0);
        db.drop().await;
    }

    /// Minting against an ASSIGNED user: bounded by the dirty-session cap
    /// and the plausibility clamp per session.
    #[tokio::test]
    async fn minting_for_assigned_user_is_clamped() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        for i in 0..100 {
            b.update(n, &format!("mint-{i}"), &report(u, 1 << 50, 0));
        }
        db.flush(&b).await;
        let cap = RATE as i128 * MIN_PLAUSIBLE_SECS as i128;
        let billed = db.used(u).await as i128;
        // A second flush a moment later is capped by the real elapsed time.
        for i in 0..100 {
            b.update(n, &format!("mint-{i}"), &report(u, 1 << 51, 0));
        }
        db.flush(&b).await;
        let second = db.used(u).await as i128 - billed;
        let slack = RATE as i128 * (PLAUSIBLE_SLACK_SECS as i128 + 2);
        assert!(
            second <= MAX_DIRTY_SESSIONS_PER_NODE as i128 * slack,
            "{second}"
        );
        assert!(
            billed <= MAX_DIRTY_SESSIONS_PER_NODE as i128 * (cap + RATE as i128),
            "{billed}"
        );
        db.drop().await;
    }

    /// Legit rebuild storm: 60 new sessions in 60 s (flush every 5 s) bill
    /// exactly — the dirty cap must not drop real sessions.
    #[tokio::test]
    async fn sixty_rebuilds_in_sixty_seconds_bill_exactly() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        for i in 0..60u64 {
            let s = format!("s{i}");
            b.update(n, &s, &report(u, 400, 0));
            b.update(n, &s, &report(u, 1000, 0)); // final report
            if i % 5 == 4 {
                db.flush(&b).await;
            }
        }
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 60 * 1000);
        db.drop().await;
    }

    #[test]
    fn dirty_cap_admits_known_sessions_and_frees_after_flush() {
        let (b, n, u) = (TrafficBuffer::new(), Uuid::new_v4(), Uuid::new_v4());
        let (u2, other) = (Uuid::new_v4(), Uuid::new_v4());
        b.permit(n, &[u, u2]);
        b.permit(other, &[u]);
        for i in 0..MAX_DIRTY_SESSIONS_PER_NODE {
            b.update(n, &format!("s{i}"), &report(u, 1, 1));
        }
        b.update(n, "one-too-many", &report(u, 1, 1));
        assert_eq!(b.entries.len(), MAX_DIRTY_SESSIONS_PER_NODE);
        // A known session (e.g. the final report of a rebuilt instance) and
        // another assigned user in a known session are always accepted.
        b.update(n, "s0", &report(u, 9, 9));
        b.update(n, "s0", &report(u2, 1, 1));
        assert_eq!(b.entries.len(), MAX_DIRTY_SESSIONS_PER_NODE + 1);
        // Other nodes are unaffected.
        b.update(other, "x", &report(u, 1, 1));
        assert_eq!(b.entries.len(), MAX_DIRTY_SESSIONS_PER_NODE + 2);
        // Once persisted, sessions stop counting.
        b.mark_flushed(&b.snapshot());
        b.update(n, "one-too-many", &report(u, 1, 1));
        assert!(b.entries.contains_key(&(n, u, "one-too-many".into())));
    }

    /// Red team Phase B H1: a known session used to accept unlimited fake
    /// user ids (1M entries / 380 MB in < 1 s). Non-members never enter
    /// memory, oversized reports are dropped whole, and a node's entries
    /// are bounded by assigned users x MAX_DIRTY_SESSIONS_PER_NODE.
    #[test]
    fn known_session_accepts_unbounded_fake_users() {
        let (b, node, real) = (TrafficBuffer::new(), Uuid::new_v4(), Uuid::new_v4());
        b.permit(node, &[real]);
        b.update(node, "one", &report(real, 1, 1));
        let t = Instant::now();
        for _ in 0..20 {
            let r = TrafficReport {
                users: (0..50_000)
                    .map(|_| UserTraffic {
                        user_id: Uuid::new_v4().to_string(),
                        up_bytes: 1,
                        down_bytes: 1,
                    })
                    .collect(),
                session_id: "one".into(),
                ..Default::default()
            };
            b.update(node, "one", &r);
        }
        // Fake reports are filtered per row.
        for _ in 0..1000 {
            b.update(node, "one", &report(Uuid::new_v4(), 1, 1));
        }
        assert_eq!(b.entries.len(), 1);
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        // Many sessions of the one real user stay within the per-node bound.
        for i in 0..1000 {
            b.update(node, &format!("s{i}"), &report(real, 1, 1));
        }
        assert!(b.entries.len() <= MAX_DIRTY_SESSIONS_PER_NODE);
        assert_eq!(b.node_entry_count(node), b.entries.len());
    }

    fn rep_users(users: &[Uuid], v: u64, session: &str) -> TrafficReport {
        TrafficReport {
            users: users
                .iter()
                .map(|u| UserTraffic {
                    user_id: u.to_string(),
                    up_bytes: v,
                    down_bytes: v,
                })
                .collect(),
            session_id: session.into(),
            ..Default::default()
        }
    }

    /// Red team Phase C N1: at the per-node cap, eviction used to scan the
    /// whole buffer per inserted row (1000-user report: 4.9 s on a tokio
    /// worker). It now evicts the oldest clean session whole via the index.
    #[test]
    fn eviction_scan_cost_at_cap() {
        let b = TrafficBuffer::new();
        // Background: 100 other nodes x 2000 clean entries.
        for _ in 0..100 {
            let n = Uuid::new_v4();
            let us: Vec<Uuid> = (0..2000).map(|_| Uuid::new_v4()).collect();
            b.set_members(n, us.iter().copied().collect());
            b.update(n, "s", &rep_users(&us, 1, "s"));
        }
        let n = Uuid::new_v4();
        let us: Vec<Uuid> = (0..1000).map(|_| Uuid::new_v4()).collect();
        b.set_members(n, us.iter().copied().collect());
        for s in 0..MAX_DIRTY_SESSIONS_PER_NODE {
            b.update(n, &format!("s{s}"), &rep_users(&us, 1, &format!("s{s}")));
        }
        b.mark_flushed(&b.snapshot());
        assert_eq!(b.node_entry_count(n), 1000 * MAX_DIRTY_SESSIONS_PER_NODE);
        let t = Instant::now();
        b.update(n, "s16", &rep_users(&us, 1, "s16"));
        let took = t.elapsed();
        eprintln!("report at cap: {took:?}");
        // Measured: ~4 ms debug, <1 ms release (the old scan: ~4.9 s).
        assert!(
            took < Duration::from_millis(250),
            "report at cap took {took:?}"
        );
        assert_eq!(b.node_entry_count(n), 1000 * MAX_DIRTY_SESSIONS_PER_NODE);
        assert!(
            !b.session_known(n, "s0"),
            "oldest clean session evicted whole"
        );
        assert!(b.entries.contains_key(&(n, us[999], "s16".into())));
        assert_eq!(
            b.node_entry_count(n),
            b.entries.iter().filter(|e| e.key().0 == n).count()
        );
    }

    /// Red team Phase C N2: a mass unassignment shrinks the cache before the
    /// agent rebuilds; the old instance's final report still carries every
    /// old user. The remaining users' rows must be kept.
    #[test]
    fn mass_unassign_drops_remaining_users_report() {
        let (b, n) = (TrafficBuffer::new(), Uuid::new_v4());
        let us: Vec<Uuid> = (0..1000).map(|_| Uuid::new_v4()).collect();
        b.set_members(n, us.iter().copied().collect());
        b.update(n, "s", &rep_users(&us, 100, "s"));
        b.mark_flushed(&b.snapshot());
        b.set_members(n, us[..10].iter().copied().collect());
        b.update(n, "s", &rep_users(&us, 200, "s"));
        let kept = b
            .entries
            .get(&(n, us[0], "s".into()))
            .map(|e| e.up)
            .unwrap();
        assert_eq!(kept, 200);
        assert_eq!(
            b.snapshot().len(),
            10,
            "only the still-assigned users are dirty"
        );
    }

    #[test]
    fn index_counts_stay_consistent() {
        let (b, n) = (TrafficBuffer::new(), Uuid::new_v4());
        let us: Vec<Uuid> = (0..5).map(|_| Uuid::new_v4()).collect();
        b.set_members(n, us.iter().copied().collect());
        b.update(n, "a", &rep_users(&us, 1, "a"));
        b.update(n, "b", &rep_users(&us[..2], 1, "b"));
        assert_eq!(b.dirty_sessions(n), 2);
        b.mark_flushed(&b.snapshot());
        assert_eq!(b.dirty_sessions(n), 0);
        b.update(n, "b", &rep_users(&us[..1], 2, "b"));
        assert_eq!(b.dirty_sessions(n), 1);
        b.remove(&(n, us[0], "b".into()));
        assert_eq!(b.dirty_sessions(n), 0);
        assert_eq!(b.node_entry_count(n), 6);
        b.prune(Instant::now() + PRUNE_IDLE + Duration::from_secs(1));
        assert_eq!(b.node_entry_count(n), 0);
        assert!(b.index.is_empty());
    }

    fn index_matches_entries(b: &TrafficBuffer, n: Uuid) {
        let actual: Vec<(Key, bool)> = b
            .entries
            .iter()
            .filter(|e| e.key().0 == n)
            .map(|e| (e.key().clone(), e.value().dirty()))
            .collect();
        let (ie, idirty, iusers) = b
            .index
            .get(&n)
            .map(|i| {
                (
                    i.entries,
                    i.sessions.values().map(|s| s.dirty).sum::<usize>(),
                    i.sessions.values().map(|s| s.users.len()).sum::<usize>(),
                )
            })
            .unwrap_or((0, 0, 0));
        let ad = actual.iter().filter(|x| x.1).count();
        assert_eq!(
            (actual.len(), actual.len(), ad),
            (ie, iusers, idirty),
            "index drifted from entries"
        );
    }

    /// Red team R7: concurrent writers vs a flusher that marks flushed and
    /// removes ("SQL refused") rows. The index must match `entries` exactly
    /// without relying on prune's rebuild. Repeated to make it meaningful.
    #[test]
    fn index_drift_under_concurrency() {
        for _ in 0..REPEAT_STRESS {
            let b = Arc::new(TrafficBuffer::new());
            let n = Uuid::new_v4();
            let us: Vec<Uuid> = (0..4000).map(|_| Uuid::new_v4()).collect();
            b.set_members(n, us.iter().copied().collect());
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let fl = {
                let (b, stop) = (b.clone(), stop.clone());
                std::thread::spawn(move || {
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        let s = b.snapshot();
                        for (i, r) in s.iter().enumerate() {
                            if i % 7 == 0 {
                                b.remove(&r.key());
                            }
                        }
                        b.mark_flushed(&s);
                    }
                })
            };
            let mut hs = vec![];
            for t in 0..4 {
                let (b, us) = (b.clone(), us.clone());
                hs.push(std::thread::spawn(move || {
                    for round in 0..60u64 {
                        let s = format!("t{t}r{}", round % 12);
                        for c in us.chunks(50) {
                            b.update(n, &s, &rep_users(c, round + 1, &s));
                        }
                    }
                }));
            }
            for h in hs {
                h.join().unwrap();
            }
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            fl.join().unwrap();
            index_matches_entries(&b, n);
        }
    }

    /// Stress iterations per test run.
    const REPEAT_STRESS: usize = 5;

    #[test]
    fn prune_rebuilds_a_corrupted_index() {
        let (b, n) = (TrafficBuffer::new(), Uuid::new_v4());
        let us: Vec<Uuid> = (0..10).map(|_| Uuid::new_v4()).collect();
        b.set_members(n, us.iter().copied().collect());
        b.update(n, "s", &rep_users(&us, 1, "s"));
        // Simulate drift: phantom dirty session and wrong counts.
        {
            let mut idx = b.index.get_mut(&n).unwrap();
            idx.entries = 999;
            idx.sessions.entry("phantom".into()).or_default().dirty = 3;
        }
        assert_eq!(b.dirty_sessions(n), 2);
        b.prune(Instant::now());
        index_matches_entries(&b, n);
        assert_eq!(b.dirty_sessions(n), 1);
    }

    /// No membership loaded for the node (session not started): nothing
    /// is accepted.
    #[test]
    fn reports_before_membership_load_are_dropped() {
        let (b, n, u) = (TrafficBuffer::new(), Uuid::new_v4(), Uuid::new_v4());
        b.update(n, "s1", &report(u, 1, 1));
        assert!(b.entries.is_empty());
    }

    /// Rows the SQL refused (unassigned after the cache was loaded) are
    /// removed from memory and the counters, not kept as "flushed".
    #[tokio::test]
    async fn sql_refused_rows_are_removed() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let b = buf(&db).await;
        sqlx::query("DELETE FROM node_users")
            .execute(&db.pool)
            .await
            .unwrap();
        b.update(n, "s1", &report(u, 5, 5));
        assert_eq!(b.entries.len(), 1, "cache still says assigned");
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 0);
        assert!(b.entries.is_empty());
        assert_eq!(b.node_entry_count(n), 0);
        assert!(!b.session_known(n, "s1"));
        db.drop().await;
    }

    /// Plausibility: elapsed is measured from the row's updated_at.
    #[tokio::test]
    async fn plausibility_clamp_uses_db_elapsed_time() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let (n2, u2) = db.member().await;
        for (node, user, ago) in [(n, u, "2 hours"), (n2, u2, "1 second")] {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO traffic_counters (node_id, user_id, session_id, up_bytes, down_bytes, updated_at) \
                 VALUES ($1, $2, 's1', 0, 0, now() - interval '{ago}')"
            )))
            .bind(node)
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        }
        // A 2 h outage: the node was last seen 2 h ago and was last billed
        // then; its agent reconnects (R13 reconnect credit).
        sqlx::query(
            "UPDATE nodes SET traffic_tat = now() - interval '2 hours', status = 'offline', \
             last_seen_at = now() - interval '2 hours' WHERE id = $1",
        )
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
        crate::grpc::reconnect_for_test(&db.pool, n).await;
        let big: u64 = 8_000_000_000_000; // 8 TB < 10 Gbit/s * 2 h = 9 TB
        let b = buf(&db).await;
        b.update(n, "s1", &report(u, big, 0));
        b.update(n2, "s1", &report(u2, big, 0));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, big as i64, "2 h gap bills in full");
        let clamped = db.used(u2).await;
        assert!(
            clamped <= RATE * 62,
            "1 s gap clamps to ~60 s worth: {clamped}"
        );
        // The full counter is stored anyway: nothing re-bills later.
        let stored: i64 = sqlx::query_scalar(
            "SELECT up_bytes FROM traffic_counters WHERE node_id = $1 AND user_id = $2",
        )
        .bind(n2)
        .bind(u2)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(stored, big as i64);
        db.drop().await;
    }

    // ---------------------------------------------------------------------
    // R12 D4: per-node GCRA cap; R12 D6: departed time window.
    // ---------------------------------------------------------------------

    const TB: i64 = 1_000_000_000_000;

    /// A persisted counter row written `ago` seconds ago.
    async fn seed(db: &TestDb, n: Uuid, u: Uuid, session: &str, up: i64, ago: f64) {
        sqlx::query(
            "INSERT INTO traffic_counters \
             (node_id, user_id, session_id, up_bytes, down_bytes, updated_at, first_seen_at) \
             VALUES ($1, $2, $3, $4, 0, now() - make_interval(secs => $5), \
                     now() - make_interval(secs => $5))",
        )
        .bind(n)
        .bind(u)
        .bind(session)
        .bind(up)
        .bind(ago)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    /// traffic_tat = now - ago (None = NULL).
    async fn set_tat(db: &TestDb, n: Uuid, ago: Option<f64>) {
        sqlx::query(
            "UPDATE nodes SET traffic_tat = now() - make_interval(secs => $2) WHERE id = $1",
        )
        .bind(n)
        .bind(ago)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    /// Seconds from now to traffic_tat (negative = in the past).
    async fn tat_from_now(db: &TestDb, n: Uuid) -> f64 {
        sqlx::query_scalar(
            "SELECT extract(epoch FROM traffic_tat - now())::float8 FROM nodes WHERE id = $1",
        )
        .bind(n)
        .fetch_one(&db.pool)
        .await
        .unwrap()
    }

    fn row(n: Uuid, u: Uuid, session: &str, up: i64, age: f64) -> FlushRow {
        FlushRow {
            node_id: n,
            user_id: u,
            session_id: session.into(),
            up,
            down: 0,
            age_secs: age,
        }
    }

    async fn write(db: &TestDb, rows: &[FlushRow]) {
        write_rows(&db.pool, rows, RATES, DEFAULT_DEPARTED_GRACE_SECS, None)
            .await
            .unwrap();
    }

    /// Time travel: move everything the caps measure `secs` into the past,
    /// as if `secs` had elapsed.
    async fn elapse(db: &TestDb, secs: f64) {
        for sql in [
            "UPDATE nodes SET traffic_tat = traffic_tat - make_interval(secs => $1)",
            "UPDATE traffic_counters SET updated_at = updated_at - make_interval(secs => $1), \
             first_seen_at = first_seen_at - make_interval(secs => $1)",
            "UPDATE node_users_departed SET departed_at = departed_at - make_interval(secs => $1)",
        ] {
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(secs)
                .execute(&db.pool)
                .await
                .unwrap();
        }
    }

    /// 3 users x 1 TB on a node whose allowance started 10 s ago: the node
    /// bills ~10 s worth in total, split exactly proportionally (floored),
    /// and the allowance is used up. Unequal deltas keep their ratio.
    #[tokio::test]
    async fn node_cap_clamps_and_splits_proportionally() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        let us = [db.user().await, db.user().await, db.user().await];
        for u in us {
            db.assign(n, u).await;
            seed(&db, n, u, "s1", 0, 86_000.0).await; // per-row cap: no limit
        }
        set_tat(&db, n, Some(10.0)).await;
        let rows: Vec<FlushRow> = us.iter().map(|&u| row(n, u, "s1", TB, 1.0)).collect();
        write(&db, &rows).await;
        let billed: Vec<i64> = futures_join(&db, &us).await;
        let total: i64 = billed.iter().sum();
        assert!(
            billed.iter().all(|&b| b == billed[0]),
            "equal split: {billed:?}"
        );
        assert!(total <= RATE * 11, "{total}");
        assert!(total >= RATE * 10 - 3, "{total}");
        let tat = tat_from_now(&db, n).await;
        assert!((-1.0..=0.0).contains(&tat), "allowance used up: tat {tat}");

        // Unequal: 1:2:3 x 20 GB on a second node (below the per-row cap of
        // a burst window, so only the node cap scales them).
        let n2 = db.node().await;
        for (i, &u) in us.iter().enumerate() {
            db.assign(n2, u).await;
            seed(&db, n2, u, "s2", 0, 86_000.0).await;
            let _ = i;
        }
        set_tat(&db, n2, Some(10.0)).await;
        let before = futures_join(&db, &us).await;
        let rows: Vec<FlushRow> = us
            .iter()
            .enumerate()
            .map(|(i, &u)| row(n2, u, "s2", (i as i64 + 1) * 20_000_000_000, 1.0))
            .collect();
        write(&db, &rows).await;
        let after = futures_join(&db, &us).await;
        let d: Vec<i64> = after.iter().zip(&before).map(|(a, b)| a - b).collect();
        assert!((d[1] - 2 * d[0]).abs() <= 2, "{d:?}");
        assert!((d[2] - 3 * d[0]).abs() <= 3, "{d:?}");
        assert!(d.iter().sum::<i64>() <= RATE * 11);
        db.drop().await;
    }

    async fn futures_join(db: &TestDb, us: &[Uuid]) -> Vec<i64> {
        let mut v = vec![];
        for &u in us {
            v.push(db.used(u).await);
        }
        v
    }

    /// A restarted panel (fresh buffer, new sessions) right after the node
    /// used its allowance gets nothing extra: the clock is in the DB.
    #[tokio::test]
    async fn restart_grants_no_extra_node_allowance() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        seed(&db, n, u, "s1", 0, 86_000.0).await;
        set_tat(&db, n, Some(10.0)).await;
        write(&db, &[row(n, u, "s1", TB, 1.0)]).await;
        let first = db.used(u).await;
        assert!(first <= RATE * 11);
        // "Restart": new buffer, new sessions (a minute old, per-row cap
        // would allow 75 GB each).
        let fresh = TrafficBuffer::new();
        refresh_members(&db.pool, &fresh, n).await.unwrap();
        let rows: Vec<FlushRow> = (0..5)
            .map(|i| row(n, u, &format!("new-{i}"), TB, 60.0))
            .collect();
        write(&db, &rows).await;
        let extra = db.used(u).await - first;
        assert!(extra <= RATE, "restart granted {extra} bytes");
        db.drop().await;
    }

    /// NULL traffic_tat = 60 s of allowance, never unlimited; a tat in the
    /// future (clock skew) bills nothing and never goes negative; nothing
    /// to bill (Σ = 0) is no division and no error.
    #[tokio::test]
    async fn node_cap_edges_null_future_and_zero() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        seed(&db, n, u, "s1", 0, 86_000.0).await;
        write(&db, &[row(n, u, "s1", TB, 1.0)]).await; // tat NULL
        let billed = db.used(u).await;
        assert!((RATE * 59..=RATE * 61).contains(&billed), "{billed}");

        let (n2, u2) = db.member().await;
        seed(&db, n2, u2, "s1", 0, 86_000.0).await;
        set_tat(&db, n2, Some(-3600.0)).await; // an hour in the future
        write(&db, &[row(n2, u2, "s1", TB, 1.0)]).await;
        assert_eq!(db.used(u2).await, 0);
        assert!(tat_from_now(&db, n2).await > 3500.0, "tat never moves back");

        let (n3, u3) = db.member().await;
        seed(&db, n3, u3, "s1", 7, 30.0).await;
        seed(&db, n3, u3, "s2", 9, 30.0).await;
        write(&db, &[row(n3, u3, "s1", 7, 1.0), row(n3, u3, "s2", 9, 1.0)]).await;
        assert_eq!(db.used(u3).await, 0);
        db.drop().await;
    }

    /// Two panel instances flushing the same node at the same time share
    /// one allowance (the node row lock serializes them).
    #[tokio::test]
    async fn concurrent_instances_share_the_node_allowance() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let u2 = db.user().await;
        db.assign(n, u2).await;
        seed(&db, n, u, "a", 0, 86_000.0).await;
        seed(&db, n, u2, "b", 0, 86_000.0).await;
        set_tat(&db, n, Some(10.0)).await;
        let (ra, rb) = ([row(n, u, "a", TB, 1.0)], [row(n, u2, "b", TB, 1.0)]);
        let (x, y) = tokio::join!(
            write_rows(&db.pool, &ra, RATES, DEFAULT_DEPARTED_GRACE_SECS, None),
            write_rows(&db.pool, &rb, RATES, DEFAULT_DEPARTED_GRACE_SECS, None),
        );
        x.unwrap();
        y.unwrap();
        let total = db.used(u).await + db.used(u2).await;
        assert!(total <= RATE * 11, "two instances billed {total}");
        db.drop().await;
    }

    /// An honest node at 0.9 x the node rate — 10 s reports with ±2 s
    /// jitter, 5 s flushes, 10 minutes — is billed (almost) in full.
    #[tokio::test]
    async fn honest_cadence_near_the_rate_bills_in_full() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let rate = 0.9 * RATE as f64;
        // Deterministic jitter in [-2, 2] s.
        let jitter = |k: u64| ((k * 7919 % 41) as f64 / 10.0) - 2.0;
        let reports: Vec<f64> = (1..=60).map(|k| 10.0 * k as f64 + jitter(k)).collect();
        let first_seen = reports[0];
        let mut last_flush = 0.0;
        let mut sent = 0i64;
        let mut flush_at = 5.0;
        while flush_at <= 605.0 {
            let latest = reports.iter().rev().find(|&&r| r <= flush_at).copied();
            elapse(&db, flush_at - last_flush).await;
            last_flush = flush_at;
            if let Some(r) = latest {
                let cum = (rate * r) as i64;
                if cum > sent {
                    sent = cum;
                    write(&db, &[row(n, u, "s1", cum, flush_at - first_seen)]).await;
                }
            }
            flush_at += 5.0;
        }
        let billed = db.used(u).await;
        assert!(
            billed as f64 >= 0.99 * sent as f64,
            "billed {billed} of {sent} ({:.4})",
            billed as f64 / sent as f64
        );
        assert!(billed <= sent);
        db.drop().await;
    }

    async fn unassign(db: &TestDb, n: Uuid, u: Uuid, ago: f64) {
        let mut tx = db.pool.begin().await.unwrap();
        crate::api::apply_unassign(&mut tx, u, n).await.unwrap();
        tx.commit().await.unwrap();
        sqlx::query(
            "UPDATE node_users_departed SET departed_at = now() - make_interval(secs => $3) \
             WHERE node_id = $1 AND user_id = $2",
        )
        .bind(n)
        .bind(u)
        .bind(ago)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    /// R12 D6: after an unassignment only traffic plausibly carried before
    /// it (+30 s) is billed: a session first seen after the window bills
    /// nothing; the known session's final counters are billed; a pre-seeded
    /// 0/0 session cannot pump beyond its window; the window is per user,
    /// not per session; a fresh buffer still admits the known DB row.
    #[tokio::test]
    async fn departed_pairs_bill_only_their_window() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        // Node allowance out of the way (a day's worth).
        let window = |secs: i64| RATE * secs;

        // Known session: last written 20 s before now, departed 10 s ago.
        let (n, u) = db.member().await;
        set_tat(&db, n, Some(86_000.0)).await;
        seed(&db, n, u, "s1", 1000, 20.0).await;
        unassign(&db, n, u, 10.0).await;
        let fresh = TrafficBuffer::new(); // e.g. after a panel restart
        refresh_members(&db.pool, &fresh, n).await.unwrap();
        fresh.update(n, "s1", &report(u, 5000, 0));
        db.flush(&fresh).await;
        assert_eq!(
            db.used(u).await,
            4000,
            "final counters of the known session"
        );

        // A session first seen after the window (departed 60 s ago, first
        // seen 10 s ago): nothing, however large.
        let (n4, u4) = db.member().await;
        set_tat(&db, n4, Some(86_000.0)).await;
        unassign(&db, n4, u4, 60.0).await;
        write(&db, &[row(n4, u4, "minted", TB, 10.0)]).await;
        assert_eq!(db.used(u4).await, 0, "new session after the window");

        // Pre-seeded 0/0 row 100 s old, departed 50 s ago: <= 80 s worth.
        let (n2, u2) = db.member().await;
        set_tat(&db, n2, Some(86_000.0)).await;
        seed(&db, n2, u2, "old", 0, 100.0).await;
        unassign(&db, n2, u2, 50.0).await;
        write(&db, &[row(n2, u2, "old", 1 << 55, 100.0)]).await;
        let pumped = db.used(u2).await;
        assert!(pumped <= window(81) && pumped >= window(79), "{pumped}");

        // 16 such sessions share ONE window (per user, not per session).
        let (n3, u3) = db.member().await;
        set_tat(&db, n3, Some(86_000.0)).await;
        for i in 0..16 {
            seed(&db, n3, u3, &format!("s{i}"), 0, 100.0).await;
        }
        unassign(&db, n3, u3, 50.0).await;
        let rows: Vec<FlushRow> = (0..16)
            .map(|i| row(n3, u3, &format!("s{i}"), 1 << 55, 100.0))
            .collect();
        write(&db, &rows).await;
        let many = db.used(u3).await;
        assert!(many <= window(81), "16 sessions billed {many}");
        db.drop().await;
    }

    /// RT3b-1: the D6 per-pair window is per flush statement: sessions
    /// flushed in separate flushes each get the full window.
    #[tokio::test]
    async fn rt_departed_window_multiplies_across_flushes() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n3, u3) = db.member().await;
        set_tat(&db, n3, Some(86_000.0)).await;
        for i in 0..16 {
            seed(&db, n3, u3, &format!("s{i}"), 0, 100.0).await;
        }
        unassign(&db, n3, u3, 50.0).await;
        for i in 0..16 {
            write(&db, &[row(n3, u3, &format!("s{i}"), 1 << 55, 100.0)]).await;
        }
        let many = db.used(u3).await;
        eprintln!(
            "RT3b-1 billed {many} = {:.1} s of rate (window 80 s)",
            many as f64 / RATE as f64
        );
        assert!(
            many <= RATE * 81,
            "16 sessions across 16 flushes billed {many}"
        );
        db.drop().await;
    }

    /// RT3b-2: an honest node running below its cap drifts its GCRA tat
    /// back to the window floor, so a burst of (window) x rate is always
    /// available: the node cap bounds only the long-run average.
    #[tokio::test]
    async fn rt_gcra_honest_drift_gives_full_burst() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let victim = db.user().await;
        db.assign(n, victim).await;
        // pre-seeded idle session of the victim
        seed(&db, n, victim, "idle", 0, 0.0).await;
        let mut cum = 0i64;
        let mut first = true;
        for k in 0..720 {
            elapse(&db, 5.0).await;
            cum += RATE / 10 * 5; // 10% of the node rate
            let age = if first { 5.0 } else { 5.0 * k as f64 };
            first = false;
            write(&db, &[row(n, u, "s1", cum, age)]).await;
        }
        let tat = tat_from_now(&db, n).await;
        eprintln!("RT3b-2 after 1h at 10%: tat {tat:.0}s from now");
        write(&db, &[row(n, victim, "idle", 1 << 55, 3600.0)]).await;
        let dumped = db.used(victim).await;
        eprintln!(
            "RT3b-2 one flush billed victim {dumped} = {:.0} s of node rate",
            dumped as f64 / RATE as f64
        );
        assert!(
            dumped <= RATE * 120,
            "one flush billed {} s worth",
            dumped / RATE
        );
        db.drop().await;
    }

    /// R13: the reconnect credit equals the real disconnected time, is
    /// granted once, and repeated reconnects do not mint more.
    #[tokio::test]
    async fn reconnect_credit_is_the_real_gap_and_not_repeatable() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        seed(&db, n, u, "s1", 0, 86_000.0).await;
        sqlx::query(
            "UPDATE nodes SET status = 'offline', last_seen_at = now() - interval '600 seconds', \
             traffic_tat = now() - interval '1 day' WHERE id = $1",
        )
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
        for _ in 0..20 {
            crate::grpc::reconnect_for_test(&db.pool, n).await; // flapping
        }
        write(&db, &[row(n, u, "s1", TB, 1.0)]).await;
        let billed = db.used(u).await;
        assert!(
            billed <= RATE * 601,
            "credit beyond the 600 s gap: {billed}"
        );
        assert!(billed >= RATE * 599, "the gap is credited: {billed}");
        // Credit used up; after it expires, more reconnects mint (almost)
        // nothing: the node is back to the burst window from its tat.
        sqlx::query(
            "UPDATE nodes SET traffic_credit_until = now() - interval '1 second' WHERE id = $1",
        )
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
        for _ in 0..20 {
            crate::grpc::reconnect_for_test(&db.pool, n).await;
        }
        write(&db, &[row(n, u, "s1", 2 * TB, 1.0)]).await;
        let more = db.used(u).await - billed;
        assert!(more <= RATE, "reconnects minted {more}");
        db.drop().await;
    }

    // ----- R14 N1: this instance's own flush outage -------------------

    /// A node with its own rate cap `r` that was last billed (tat, counter
    /// row s1 = 0) `ago` seconds ago, and a buffer holding `cum` bytes of
    /// cumulative traffic for it.
    async fn outage_setup(db: &TestDb, r: i64, ago: f64, cum: u64) -> (Uuid, Uuid, TrafficBuffer) {
        let (n, u) = db.member().await;
        seed(db, n, u, "s1", 0, ago).await;
        sqlx::query(
            "UPDATE nodes SET traffic_max_rate_bytes_per_sec = $2, \
             traffic_tat = now() - make_interval(secs => $3) WHERE id = $1",
        )
        .bind(n)
        .bind(r)
        .bind(ago)
        .execute(&db.pool)
        .await
        .unwrap();
        let b = buf(db).await;
        b.update(n, "s1", &report(u, cum, 0));
        (n, u, b)
    }

    /// Make one real flush attempt fail (the pool is closed): the only
    /// way the instance enters the failing state.
    async fn failing_flush(db: &TestDb, b: &TrafficBuffer) {
        let dead = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect_with((*db.pool.connect_options()).clone())
            .await
            .unwrap();
        dead.close().await;
        assert!(flush_buffer(&dead, b, RATES, None).await.is_err());
        assert!(b.failing());
    }

    /// Red team RTC-1: a 1 h flush outage at 10 % of the node rate. The
    /// agents stayed connected (no reconnect credit); the first flush after
    /// the outage must bill ~100 % of the backlog, not one burst window
    /// (33 %).
    #[tokio::test]
    async fn rtc1_flush_outage_backlog_is_billed_in_full() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        const R: i64 = 1_000_000;
        let cum = (R / 10 * 3600) as u64; // 10 % of R for 1 h
        let (n, u, b) = outage_setup(&db, R, 3600.0, cum).await;
        failing_flush(&db, &b).await;
        b.backdate_last_ok(Duration::from_secs(3600));
        flush_buffer(&db.pool, &b, RATES, None).await.unwrap();
        let billed = db.used(u).await;
        assert!(
            billed as f64 >= cum as f64 * 0.99,
            "outage backlog under-billed: {billed} of {cum}"
        );
        assert!(billed as u64 <= cum, "over-billed: {billed} > {cum}");
        assert!(!b.failing(), "recovered");
        // One-time: the credit is valid for one burst window and is not
        // renewed by later (healthy) flushes.
        let (floor_age, until_left): (f64, f64) = sqlx::query_as(
            "SELECT extract(epoch FROM now() - traffic_credit_floor)::float8, \
                    extract(epoch FROM traffic_credit_until - now())::float8 \
             FROM nodes WHERE id = $1",
        )
        .bind(n)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!((3590.0..3700.0).contains(&floor_age), "floor {floor_age}");
        assert!(until_left <= RATES.burst_secs as f64, "until {until_left}");
        db.drop().await;
    }

    /// The same backlog without a real outage (only elapsed time, no failed
    /// flush) gets no credit: one burst window of the node rate.
    #[tokio::test]
    async fn no_outage_credit_without_a_failed_flush() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        const R: i64 = 1_000_000;
        let cum = (R / 10 * 3600) as u64;
        let (n, u, b) = outage_setup(&db, R, 3600.0, cum).await;
        b.backdate_last_ok(Duration::from_secs(3600));
        flush_buffer(&db.pool, &b, RATES, None).await.unwrap();
        let billed = db.used(u).await;
        let burst = R * RATES.burst_secs;
        assert!(
            billed <= burst + R,
            "credit without an outage: {billed} > {burst}"
        );
        assert!(billed >= burst - R, "burst window billed: {billed}");
        let floor: Option<chrono::DateTime<chrono::Utc>> =
            sqlx::query_scalar("SELECT traffic_credit_floor FROM nodes WHERE id = $1")
                .bind(n)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(floor.is_none(), "no credit granted");
        // A node's own input cannot make the flush fail: reports the
        // database refuses (unassigned user) still leave the instance
        // healthy.
        let stranger = db.user().await;
        b.update(n, "s1", &report(stranger, 1 << 40, 0));
        flush_buffer(&db.pool, &b, RATES, None).await.unwrap();
        assert!(!b.failing());
        db.drop().await;
    }

    /// A short outage (within the burst window) grants nothing (the window
    /// covers it and the credit slot is not consumed); a long one is capped
    /// at the lease.
    #[tokio::test]
    async fn outage_credit_bounds() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        const R: i64 = 1_000_000;
        // Short: 60 s < burst.
        let (n, _u, b) = outage_setup(&db, R, 60.0, 1).await;
        failing_flush(&db, &b).await;
        b.backdate_last_ok(Duration::from_secs(60));
        flush_buffer(&db.pool, &b, RATES, None).await.unwrap();
        let floor: Option<chrono::DateTime<chrono::Utc>> =
            sqlx::query_scalar("SELECT traffic_credit_floor FROM nodes WHERE id = $1")
                .bind(n)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(floor.is_none(), "short outage consumed the credit slot");
        // Long: 3 days of outage, full-rate claim; lease = 1 day.
        let days3 = 3.0 * 86400.0;
        let (_n, u, b) = outage_setup(&db, R, days3, (R as u64) * 300_000).await;
        failing_flush(&db, &b).await;
        b.backdate_last_ok(Duration::from_secs_f64(days3));
        flush_buffer(&db.pool, &b, RATES, None).await.unwrap();
        let billed = db.used(u).await;
        let lease = R * RATES.lease_secs;
        assert!(billed <= lease + R, "beyond the lease: {billed} > {lease}");
        assert!(billed >= lease - R, "lease credited: {billed}");
        db.drop().await;
    }

    /// A per-node flush (the reaper's, before a delete) neither clears nor
    /// sets the instance's failing state, but credits the outage too.
    #[tokio::test]
    async fn node_flush_keeps_the_outage_state() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        const R: i64 = 1_000_000;
        let cum = (R / 10 * 3600) as u64;
        let (n, u, b) = outage_setup(&db, R, 3600.0, cum).await;
        failing_flush(&db, &b).await;
        b.backdate_last_ok(Duration::from_secs(3600));
        flush_buffer(&db.pool, &b, RATES, Some(n)).await.unwrap();
        assert!(b.failing(), "a partial flush does not end the outage");
        assert!(db.used(u).await as f64 >= cum as f64 * 0.99);
        db.drop().await;
    }
}
