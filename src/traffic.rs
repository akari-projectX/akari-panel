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

use std::collections::HashSet;
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

#[derive(Default)]
pub struct TrafficBuffer {
    entries: DashMap<Key, Entry>,
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
        for u in &report.users {
            let Ok(user_id) = Uuid::parse_str(&u.user_id) else {
                tracing::warn!(node = %node_id, user = %u.user_id, "traffic report for unparseable user id");
                continue;
            };
            let (Ok(up), Ok(down)) = (i64::try_from(u.up_bytes), i64::try_from(u.down_bytes))
            else {
                tracing::warn!(node = %node_id, user = %user_id, up = u.up_bytes, down = u.down_bytes,
                    "traffic counters exceed i64::MAX; row dropped");
                continue;
            };
            let key = (node_id, user_id, session_id.to_string());
            if !self.entries.contains_key(&key)
                && !self.session_known(node_id, session_id)
                && self.dirty_sessions(node_id) >= MAX_DIRTY_SESSIONS_PER_NODE
            {
                tracing::warn!(node = %node_id, session = %session_id,
                    "too many unpersisted sessions on node; report for new session dropped");
                return;
            }
            let mut e = self.entries.entry(key).or_insert_with(|| Entry::new(now));
            if e.observe(up, down, now) {
                tracing::warn!(node = %node_id, user = %user_id, session = %session_id,
                    "traffic counters went backwards within a session; ignored");
            }
        }
    }

    fn session_known(&self, node_id: Uuid, session_id: &str) -> bool {
        self.entries
            .iter()
            .any(|e| e.key().0 == node_id && e.key().2 == session_id)
    }

    /// Distinct sessions of `node_id` with at least one unpersisted value.
    fn dirty_sessions(&self, node_id: Uuid) -> usize {
        let mut seen = HashSet::new();
        for e in self.entries.iter() {
            if e.key().0 == node_id && e.value().dirty() {
                seen.insert(e.key().2.clone());
            }
        }
        seen.len()
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
                e.flushed = Some((r.up, r.down));
                e.failures = 0;
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
            self.entries.remove(&r.key());
            tracing::error!(node = %r.node_id, user = %r.user_id, session = %r.session_id,
                up = r.up, down = r.down, "traffic row repeatedly rejected by database; dropped");
        }
    }

    /// Evict fully persisted, idle entries.
    fn prune(&self, now: Instant) {
        self.entries
            .retain(|_, e| e.dirty() || now.duration_since(e.touched) < PRUNE_IDLE);
    }
}

/// One statement = one transaction. Only (node, user) pairs that are
/// actually assigned (node_users) are stored or billed — a node cannot bill
/// users it does not serve. Upsert the high-water marks and bill the
/// increase over what was stored before, clamped to `$7` bytes/s over the
/// time since the row was last written (+ PLAUSIBLE_SLACK_SECS), or since
/// first sighting (at least MIN_PLAUSIBLE_SECS) for a new row. The full counter is stored even when the bill is
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
SELECT (SELECT count(*) FROM input) - (SELECT count(*) FROM member) AS dropped,
       (SELECT count(*) FROM per_row WHERE raw > cap) AS clamped
"#;

async fn write_rows(
    pg: &sqlx::PgPool,
    rows: &[FlushRow],
    max_rate: i64,
) -> Result<(), sqlx::Error> {
    let nodes: Vec<Uuid> = rows.iter().map(|r| r.node_id).collect();
    let users: Vec<Uuid> = rows.iter().map(|r| r.user_id).collect();
    let sessions: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
    let ups: Vec<i64> = rows.iter().map(|r| r.up).collect();
    let downs: Vec<i64> = rows.iter().map(|r| r.down).collect();
    let ages: Vec<f64> = rows.iter().map(|r| r.age_secs).collect();
    let (dropped, clamped): (i64, i64) = sqlx::query_as(FLUSH_SQL)
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
    if dropped > 0 {
        tracing::warn!(
            rows = dropped,
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
    Ok(())
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
        Ok(()) => {
            buf.mark_flushed(&rows);
            Ok(rows.len())
        }
        Err(e) if is_row_poison(&e) => {
            tracing::warn!(error = %e, rows = rows.len(), "traffic batch rejected; retrying row by row");
            let mut written = 0;
            for r in &rows {
                match write_rows(pg, std::slice::from_ref(r), max_rate).await {
                    Ok(()) => {
                        buf.mark_flushed(std::slice::from_ref(r));
                        written += 1;
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
        (TrafficBuffer::new(), Uuid::new_v4(), Uuid::new_v4())
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
        let mut r = report(&[(u, u64::MAX, 7), (Uuid::new_v4(), 3, 4)]);
        r.users.push(UserTraffic {
            user_id: "not-a-uuid".into(),
            up_bytes: 9,
            down_bytes: 9,
        });
        b.update(n, "s1", &r);
        assert_eq!(b.entries.len(), 1, "only the valid row is kept");
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
        let before = TrafficBuffer::new();
        before.update(n, "s1", &report(u, 1000, 5000));
        db.flush(&before).await;
        // Reported but never flushed: the panel dies here.
        before.update(n, "s1", &report(u, 1200, 5500));
        drop(before);

        let after = TrafficBuffer::new();
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
        let b = TrafficBuffer::new();
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
        let b = TrafficBuffer::new();
        b.update(n, "s1", &report(u, 100, 100));
        db.flush(&b).await;
        b.update(n, "s1", &report(u, 400, 100));
        let _lost = b.snapshot(); // transaction failed
                                  // Even if memory were wiped (eviction/restart), the next cumulative
                                  // report carries the missed delta.
        let fresh = TrafficBuffer::new();
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
        let b = TrafficBuffer::new();
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
        let b = TrafficBuffer::new();
        b.update(n, "s1", &report(u, 200, 0));
        b.update(n, "s1", &report(u, 150, 0)); // stale, out of order
        b.update(n, "s1", &report(u, 300, 0));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, 300);
        // A second panel instance (fresh memory) replaying the stale value.
        let other = TrafficBuffer::new();
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
        let panel = TrafficBuffer::new();
        feed(&panel, "s0", rep("s1", 1000));
        db.flush(&panel).await;
        feed(&panel, "s1", rep("s1", 1500)); // reconnected
        db.flush(&panel).await;
        let panel = TrafficBuffer::new(); // panel restart
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
        let b = TrafficBuffer::new();
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
            let b = TrafficBuffer::new();
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
            let (a, b) = (TrafficBuffer::new(), TrafficBuffer::new());
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
        let b = TrafficBuffer::new();
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
        let b = TrafficBuffer::new();
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
        let b = TrafficBuffer::new();
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
        let b = TrafficBuffer::new();
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
        let b = TrafficBuffer::new();
        for i in 0..1000 {
            b.update(n, &format!("mint-{i}"), &report(victim, 1_000_000_000, 0));
        }
        assert_eq!(b.entries.len(), MAX_DIRTY_SESSIONS_PER_NODE);
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
        let b = TrafficBuffer::new();
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
        let b = TrafficBuffer::new();
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
        for i in 0..MAX_DIRTY_SESSIONS_PER_NODE {
            b.update(n, &format!("s{i}"), &report(u, 1, 1));
        }
        b.update(n, "one-too-many", &report(u, 1, 1));
        assert_eq!(b.entries.len(), MAX_DIRTY_SESSIONS_PER_NODE);
        // A known session (e.g. the final report of a rebuilt instance) and
        // a new user in a known session are always accepted.
        b.update(n, "s0", &report(u, 9, 9));
        b.update(n, "s0", &report(Uuid::new_v4(), 1, 1));
        assert_eq!(b.entries.len(), MAX_DIRTY_SESSIONS_PER_NODE + 1);
        // Other nodes are unaffected.
        b.update(Uuid::new_v4(), "x", &report(u, 1, 1));
        // Once persisted, sessions stop counting.
        b.mark_flushed(&b.snapshot());
        b.update(n, "one-too-many", &report(u, 1, 1));
        assert!(b.entries.contains_key(&(n, u, "one-too-many".into())));
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
        let b = TrafficBuffer::new();
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
