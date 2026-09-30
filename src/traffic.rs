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
}

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

/// One statement = one transaction. Only (node, user) pairs that are
/// actually assigned (node_users) are stored or billed — a node cannot bill
/// users it does not serve. Upsert the high-water marks and bill the
/// increase over what was stored before, clamped to `$7` bytes/s over the
/// time since the row was last written (+ PLAUSIBLE_SLACK_SECS), or since
/// first sighting (at least MIN_PLAUSIBLE_SECS) for a new row. Returns the
/// keys it refused (unassigned pairs) and the number of clamped rows. The full counter is stored even when the bill is
/// clamped, so clamping can only under-bill. Returns (dropped, clamped).
const FLUSH_SQL: &str = r#"
WITH input AS (
    SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::bigint[], $5::bigint[], $6::float8[])
        AS t(node_id, user_id, session_id, up, down, age_secs)
), member AS (
    SELECT i.* FROM input i
    WHERE EXISTS (SELECT 1 FROM node_users nu WHERE nu.node_id = i.node_id AND nu.user_id = i.user_id)
), upsert AS (
    INSERT INTO traffic_counters AS c (node_id, user_id, session_id, up_bytes, down_bytes, updated_at)
    SELECT node_id, user_id, session_id, up, down, now() FROM member
    ON CONFLICT (node_id, user_id, session_id) DO UPDATE
    SET up_bytes   = GREATEST(c.up_bytes, EXCLUDED.up_bytes),
        down_bytes = GREATEST(c.down_bytes, EXCLUDED.down_bytes),
        updated_at = EXCLUDED.updated_at
    RETURNING new.node_id, new.user_id, new.session_id,
              old.up_bytes AS old_up, old.down_bytes AS old_down, old.updated_at AS old_at,
              new.up_bytes AS new_up, new.down_bytes AS new_down
), per_row AS (
    SELECT u.user_id,
           GREATEST(u.new_up - COALESCE(u.old_up, 0), 0)::numeric
         + GREATEST(u.new_down - COALESCE(u.old_down, 0), 0)::numeric AS raw,
           $7::numeric * COALESCE(
               extract(epoch FROM now() - u.old_at) + $9::numeric,
               GREATEST(m.age_secs::numeric, $8::numeric)) AS cap
    FROM upsert u JOIN member m USING (node_id, user_id, session_id)
), per_user AS (
    SELECT user_id, sum(LEAST(raw, cap)) AS delta FROM per_row GROUP BY user_id
), billed AS (
    UPDATE users u
    SET traffic_used_bytes = LEAST(u.traffic_used_bytes::numeric + p.delta, 9223372036854775807)::bigint
    FROM per_user p
    WHERE u.id = p.user_id AND p.delta > 0
    RETURNING 1
)
SELECT coalesce(array_agg(i.node_id), '{}') AS dropped_nodes,
       coalesce(array_agg(i.user_id), '{}') AS dropped_users,
       coalesce(array_agg(i.session_id), '{}') AS dropped_sessions,
       (SELECT count(*) FROM per_row WHERE raw > cap) AS clamped
FROM input i
WHERE NOT EXISTS (SELECT 1 FROM member m
                  WHERE m.node_id = i.node_id AND m.user_id = i.user_id AND m.session_id = i.session_id)
"#;

/// Writes `rows`; returns the keys the database refused as unassigned.
async fn write_rows(
    pg: &sqlx::PgPool,
    rows: &[FlushRow],
    max_rate: i64,
) -> Result<Vec<Key>, sqlx::Error> {
    let nodes: Vec<Uuid> = rows.iter().map(|r| r.node_id).collect();
    let users: Vec<Uuid> = rows.iter().map(|r| r.user_id).collect();
    let sessions: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
    let ups: Vec<i64> = rows.iter().map(|r| r.up).collect();
    let downs: Vec<i64> = rows.iter().map(|r| r.down).collect();
    let ages: Vec<f64> = rows.iter().map(|r| r.age_secs).collect();
    let (dn, du, ds, clamped): (Vec<Uuid>, Vec<Uuid>, Vec<String>, i64) = sqlx::query_as(FLUSH_SQL)
        .bind(&nodes)
        .bind(&users)
        .bind(&sessions)
        .bind(&ups)
        .bind(&downs)
        .bind(&ages)
        .bind(max_rate)
        .bind(MIN_PLAUSIBLE_SECS)
        .bind(PLAUSIBLE_SLACK_SECS)
        .fetch_one(pg)
        .await?;
    if !dn.is_empty() {
        tracing::warn!(
            rows = dn.len(),
            "traffic for unassigned (node, user) pairs not billed"
        );
    }
    if clamped > 0 {
        tracing::warn!(
            rows = clamped,
            max_rate,
            "implausible traffic deltas clamped"
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
    max_rate: i64,
) -> anyhow::Result<usize> {
    let rows = buf.snapshot();
    if rows.is_empty() {
        return Ok(0);
    }
    match write_rows(pg, &rows, max_rate).await {
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
                match write_rows(pg, std::slice::from_ref(r), max_rate).await {
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

/// Load `node_id`'s assigned users into the buffer's membership cache.
pub async fn refresh_members(
    pg: &sqlx::PgPool,
    buf: &TrafficBuffer,
    node_id: Uuid,
) -> sqlx::Result<()> {
    let users: Vec<Uuid> = sqlx::query_scalar("SELECT user_id FROM node_users WHERE node_id = $1")
        .bind(node_id)
        .fetch_all(pg)
        .await?;
    buf.set_members(node_id, users.into_iter().collect());
    Ok(())
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

async fn flush_once(state: &AppState) -> anyhow::Result<()> {
    // Persist first so limit enforcement sees the freshest usage; a failure
    // of either step must not block the other.
    let flushed = flush_buffer(
        state.pg(),
        state.traffic(),
        state.cfg().traffic.max_rate_bytes_per_sec,
    )
    .await;
    state.traffic().prune(Instant::now());
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

    trait Flush {
        async fn flush(&self, b: &TrafficBuffer) -> usize;
    }

    impl Flush for TestDb {
        async fn flush(&self, b: &TrafficBuffer) -> usize {
            flush_buffer(&self.pool, b, RATE).await.unwrap()
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
        write_rows(&db.pool, &rows, RATE).await.unwrap();
        db.flush(&b).await;
        db.flush(&b).await;
        write_rows(&db.pool, &rows, RATE).await.unwrap();
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
                flush_buffer(&db.pool, &a, RATE),
                flush_buffer(&db.pool, &b, RATE)
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
            assert!(flush_buffer(&db.pool, &b, RATE).await.is_err());
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
        flush_buffer(&db.pool, &b, i64::MAX).await.unwrap();
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
}
