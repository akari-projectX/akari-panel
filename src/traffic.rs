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
//! within one session are monotonic. A lower value is therefore stale or a
//! bug: it is logged and bills nothing.

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

/// (node, user, agent session id)
type Key = (Uuid, Uuid, String);

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    /// Highest cumulative counters seen in this session.
    up: i64,
    down: i64,
    /// What was last durably written to `traffic_counters` (None = never).
    flushed: Option<(i64, i64)>,
    touched: Instant,
    failures: u32,
}

impl Entry {
    fn new(now: Instant) -> Self {
        Self {
            up: 0,
            down: 0,
            flushed: None,
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

/// The session a report's counters belong to: the report's own (current
/// agents), else the stream's Hello session (agents predating
/// `TrafficReport.session_id`, which may be stale after a rebuild).
pub fn report_session<'a>(report: &'a TrafficReport, hello_session: &'a str) -> &'a str {
    if report.session_id.is_empty() {
        hello_session
    } else {
        &report.session_id
    }
}

#[derive(Default)]
pub struct TrafficBuffer {
    entries: DashMap<Key, Entry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FlushRow {
    node_id: Uuid,
    user_id: Uuid,
    session_id: String,
    up: i64,
    down: i64,
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
            let mut e = self
                .entries
                .entry((node_id, user_id, session_id.to_string()))
                .or_insert_with(|| Entry::new(now));
            if e.observe(up, down, now) {
                tracing::warn!(node = %node_id, user = %user_id, session = %session_id,
                    "traffic counters went backwards within a session; ignored");
            }
        }
    }

    /// Everything not yet durably persisted. Nothing is cleared here.
    fn snapshot(&self) -> Vec<FlushRow> {
        self.entries
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
                }
            })
            .collect()
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

/// One statement = one transaction: upsert the high-water marks and bill
/// exactly the increase over what was stored before.
const FLUSH_SQL: &str = r#"
WITH input AS (
    SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::bigint[], $5::bigint[])
        AS t(node_id, user_id, session_id, up, down)
), upsert AS (
    INSERT INTO traffic_counters AS c (node_id, user_id, session_id, up_bytes, down_bytes, updated_at)
    SELECT node_id, user_id, session_id, up, down, now() FROM input
    ON CONFLICT (node_id, user_id, session_id) DO UPDATE
    SET up_bytes   = GREATEST(c.up_bytes, EXCLUDED.up_bytes),
        down_bytes = GREATEST(c.down_bytes, EXCLUDED.down_bytes),
        updated_at = EXCLUDED.updated_at
    RETURNING new.user_id,
              GREATEST(new.up_bytes - COALESCE(old.up_bytes, 0), 0)::numeric
            + GREATEST(new.down_bytes - COALESCE(old.down_bytes, 0), 0)::numeric AS delta
), per_user AS (
    SELECT user_id, sum(delta) AS delta FROM upsert GROUP BY user_id
)
UPDATE users u
SET traffic_used_bytes = LEAST(u.traffic_used_bytes::numeric + p.delta, 9223372036854775807)::bigint
FROM per_user p
WHERE u.id = p.user_id AND p.delta > 0
"#;

async fn write_rows(pg: &sqlx::PgPool, rows: &[FlushRow]) -> Result<(), sqlx::Error> {
    let nodes: Vec<Uuid> = rows.iter().map(|r| r.node_id).collect();
    let users: Vec<Uuid> = rows.iter().map(|r| r.user_id).collect();
    let sessions: Vec<&str> = rows.iter().map(|r| r.session_id.as_str()).collect();
    let ups: Vec<i64> = rows.iter().map(|r| r.up).collect();
    let downs: Vec<i64> = rows.iter().map(|r| r.down).collect();
    sqlx::query(FLUSH_SQL)
        .bind(&nodes)
        .bind(&users)
        .bind(&sessions)
        .bind(&ups)
        .bind(&downs)
        .execute(pg)
        .await?;
    Ok(())
}

/// Persist `buf`'s dirty rows. A data error on the batch falls back to
/// per-row writes so one bad row cannot poison the rest; connectivity
/// errors keep everything for the next tick (retry is idempotent).
async fn flush_buffer(pg: &sqlx::PgPool, buf: &TrafficBuffer) -> anyhow::Result<usize> {
    let rows = buf.snapshot();
    if rows.is_empty() {
        return Ok(0);
    }
    match write_rows(pg, &rows).await {
        Ok(()) => {
            buf.mark_flushed(&rows);
            Ok(rows.len())
        }
        Err(sqlx::Error::Database(e)) => {
            tracing::warn!(error = %e, rows = rows.len(), "traffic batch rejected; retrying row by row");
            let mut written = 0;
            for r in &rows {
                match write_rows(pg, std::slice::from_ref(r)).await {
                    Ok(()) => {
                        buf.mark_flushed(std::slice::from_ref(r));
                        written += 1;
                    }
                    Err(sqlx::Error::Database(e)) => {
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
    let flushed = flush_buffer(state.pg(), state.traffic()).await;
    state.traffic().prune(Instant::now());
    let enforced = enforce_limits(state).await;
    let n = flushed?;
    if n > 0 {
        tracing::debug!(rows = n, "traffic flushed");
    }
    enforced
}

async fn enforce_limits(state: &AppState) -> anyhow::Result<()> {
    // Traffic-limit enforcement: disable users past their limit, bump the
    // user_version on their nodes and wake connected agents so the removal
    // propagates without waiting for a reconnect.
    let disabled: Vec<Uuid> = sqlx::query_scalar(
        r#"UPDATE users SET enabled = false
           WHERE enabled = true AND traffic_limit_bytes IS NOT NULL
             AND traffic_used_bytes > traffic_limit_bytes
           RETURNING id"#,
    )
    .fetch_all(state.pg())
    .await?;
    if !disabled.is_empty() {
        let node_ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT DISTINCT node_id FROM node_users WHERE user_id = ANY($1)")
                .bind(&disabled)
                .fetch_all(state.pg())
                .await?;
        sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = ANY($1)")
            .bind(&node_ids)
            .execute(state.pg())
            .await?;
        // One bump wakes every connected agent's session; each session
        // re-reads its own node state and converges independently.
        state.notify_change();
        tracing::info!(
            nodes = node_ids.len(),
            users = disabled.len(),
            "disabled users over traffic limit"
        );
    }

    Ok(())
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
    fn report_session_prefers_report_then_hello() {
        let mut r = report(&[]);
        assert_eq!(report_session(&r, "hello"), "hello");
        r.session_id = "from-report".into();
        assert_eq!(report_session(&r, "hello"), "from-report");
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

/// Real-PostgreSQL tests of the flush statement. They need the dev database
/// (`make dev-up`; DATABASE_URL or the config default) and run each test in a
/// throwaway schema. Set AKARI_SKIP_DB_TESTS=1 to skip on machines without it.
#[cfg(test)]
mod db_tests {
    use super::*;
    use crate::gen::UserTraffic;
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
    use sqlx::PgPool;
    use std::str::FromStr;

    struct TestDb {
        admin: PgPool,
        pool: PgPool,
        schema: String,
    }

    impl TestDb {
        async fn new() -> Option<Self> {
            if std::env::var("AKARI_SKIP_DB_TESTS").is_ok_and(|v| v == "1") {
                eprintln!("AKARI_SKIP_DB_TESTS=1: skipping");
                return None;
            }
            let url = std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://akari:akari-dev@localhost:5432/akari".into());
            let admin = PgPoolOptions::new()
                .max_connections(1)
                .connect(&url)
                .await
                .expect("test database unreachable (make dev-up, or AKARI_SKIP_DB_TESTS=1)");
            let schema = format!("test_traffic_{}", Uuid::new_v4().simple());
            // schema is our own "test_traffic_<hex uuid>": no injection surface.
            sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
                .execute(&admin)
                .await
                .unwrap();
            let opts = PgConnectOptions::from_str(&url)
                .unwrap()
                .options([("search_path", schema.as_str())]);
            let pool = PgPoolOptions::new()
                .max_connections(2)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::migrate!("./migrations").run(&pool).await.unwrap();
            Some(Self {
                admin,
                pool,
                schema,
            })
        }

        async fn user(&self) -> Uuid {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO users (id, login) VALUES ($1, $2)")
                .bind(id)
                .bind(id.to_string())
                .execute(&self.pool)
                .await
                .unwrap();
            id
        }

        async fn used(&self, user: Uuid) -> i64 {
            sqlx::query_scalar("SELECT traffic_used_bytes FROM users WHERE id = $1")
                .bind(user)
                .fetch_one(&self.pool)
                .await
                .unwrap()
        }

        async fn flush(&self, b: &TrafficBuffer) -> usize {
            flush_buffer(&self.pool, b).await.unwrap()
        }

        async fn drop(self) {
            self.pool.close().await;
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "DROP SCHEMA {} CASCADE",
                self.schema
            )))
            .execute(&self.admin)
            .await
            .unwrap();
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
        let (n, u) = (Uuid::new_v4(), db.user().await);
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
        let (n, u) = (Uuid::new_v4(), db.user().await);
        let b = TrafficBuffer::new();
        b.update(n, "s1", &report(u, 100, 200));
        let rows = b.snapshot();
        // Ambiguous commit: written, but the panel thinks it failed.
        write_rows(&db.pool, &rows).await.unwrap();
        db.flush(&b).await;
        db.flush(&b).await;
        write_rows(&db.pool, &rows).await.unwrap();
        assert_eq!(db.used(u).await, 300);
        db.drop().await;
    }

    #[tokio::test]
    async fn failed_flush_is_fully_recovered_by_next_report() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, u) = (Uuid::new_v4(), db.user().await);
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
        let (n, u) = (Uuid::new_v4(), db.user().await);
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
        let (n, u) = (Uuid::new_v4(), db.user().await);
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
        let (n, u) = (Uuid::new_v4(), db.user().await);
        let rep = |s: &str, up| {
            let mut r = report(u, up, 0);
            r.session_id = s.into();
            r
        };
        let feed = |b: &TrafficBuffer, hello: &str, r: TrafficReport| {
            b.update(n, report_session(&r, hello), &r);
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

    #[tokio::test]
    async fn one_bad_row_does_not_poison_the_batch() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n, good, bad) = (Uuid::new_v4(), db.user().await, db.user().await);
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
        let (n, u) = (Uuid::new_v4(), db.user().await);
        let b = TrafficBuffer::new();
        let max = i64::MAX as u64;
        b.update(n, "s1", &report(u, max, max));
        db.flush(&b).await;
        assert_eq!(db.used(u).await, i64::MAX);
        db.drop().await;
    }
}
