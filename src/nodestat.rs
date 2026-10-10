//! W11: server (machine) status (heartbeat metrics), its history, and latency
//! tests.
//!
//! - **Latest values**: the heartbeat blob in Valkey (`akari:server:hb:<id>`,
//!   written by `grpc::store_heartbeat` with `heartbeat_blob`), so any
//!   instance serves them. Offline = the existing server status (the
//!   `online_sql` predicate: status 'online' refreshed within 90 s).
//! - **History**: `server_metrics_1m` (one row per server and minute; the
//!   instance holding the server's stream upserts each heartbeat into the
//!   current minute, adding to sums, at most one write per server per
//!   `MIN_SAMPLE_GAP`) rolled up into `server_metrics_1h` by
//!   `rollup_and_prune` (reaper loop, every 10 min, one instance at a time
//!   via an advisory try-lock). Retention: minutes 48 h, hours 90 days.
//!   Sized for 200 nodes: <= 576k minute rows and 432k hour rows.
//! - **Latency**: the agents' url-test (`LatencyReport`, capability
//!   "latency"; the panel sends `LatencyProbeConfig` from `[probe]` with the
//!   系统设置 overrides applied, W12 `settings::Effective::probe`) and the
//!   panel's own TCP connect test to every inbound's client-facing
//!   address (`panel_probe_loop`, any instance, rows claimed with a
//!   conditional UPDATE). Results replace the previous set per (server,
//!   source) in `server_latency`. "立即测速" = `apply_request_probe`.
//! - **Prometheus**: fleet aggregates of the nodes connected to THIS
//!   instance (`Local::fleet`; sum over instances in PromQL). No per-server
//!   labels: server ids/names are unbounded label values (src/CLAUDE.md
//!   metrics rule); per-server history is the API's job.

use crate::auth::bad_request;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::pb::{Heartbeat, LatencyProbeConfig, LatencyReport};
use crate::state::AppState;

/// SQL predicate over server alias `a`: the server is online — the same rule
/// the reaper uses (a session marks it online and refreshes last_seen_at
/// every 30 s).
pub fn online_sql(a: &str) -> String {
    format!("({a}.status = 'online' AND {a}.last_seen_at > now() - interval '90 seconds')")
}

/// At most one history write per server per this long (a heartbeat flood
/// from a misbehaving agent cannot turn into a write flood).
const MIN_SAMPLE_GAP: Duration = Duration::from_secs(5);
/// Concurrent history writes per instance; a sample that finds none free
/// is skipped (the database is slow; the next heartbeat tries again).
const WRITE_PERMITS: usize = 8;
/// Fleet gauges ignore samples older than this (stream gone quiet).
const FLEET_FRESH: Duration = Duration::from_secs(60);

pub const MINUTE_RETENTION_HOURS: i64 = 48;
pub const HOUR_RETENTION_DAYS: i64 = 90;
const PRUNE_BATCH: i64 = 10_000;

/// Absolute http(s) URL without credentials, whitespace or control
/// characters, <= 512 bytes (`[probe].urls`; the agent applies the same
/// rule and drops what fails it).
pub fn valid_probe_url(s: &str) -> bool {
    if s.is_empty() || s.len() > 512 || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let rest = match s.split_once("://") {
        Some(("http" | "https", rest)) => rest,
        _ => return false,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    !authority.is_empty() && !authority.contains('@')
}

// ---------------------------------------------------------------------------
// Heartbeat ingest
// ---------------------------------------------------------------------------

/// One heartbeat, sanitized (agent input: finite, bounded). W23: None =
/// the agent could not read the value (unknown, shown as "—", stored as
/// NULL), never 0.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    pub cpu: Option<f64>,
    pub load1: Option<f64>,
    pub mem_used: Option<i64>,
    pub mem_total: Option<i64>,
    pub swap_used: Option<i64>,
    pub swap_total: Option<i64>,
    pub disk_used: Option<i64>,
    pub disk_total: Option<i64>,
    pub rx_bps: Option<i64>,
    pub tx_bps: Option<i64>,
    pub tcp: Option<i64>,
    pub udp: Option<i64>,
    pub conns: i64,
    pub users: i64,
}

/// A finite value clamped to 0..=max; NaN/infinite = unknown.
fn finite(v: Option<f64>, max: f64) -> Option<f64> {
    v.filter(|v| v.is_finite()).map(|v| v.clamp(0.0, max))
}

fn int(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

/// W23: agents without the "metrics-presence" capability send a value
/// they could not read as 0 and every 0 as unset (implicit presence): for
/// them unset means 0, as before. Applied at ingest (grpc.rs), so
/// everything downstream reads None as "unknown".
pub fn legacy_presence(hb: &mut Heartbeat) {
    let z = |v: &mut Option<u64>| {
        v.get_or_insert(0);
    };
    hb.cpu_percent.get_or_insert(0.0);
    z(&mut hb.mem_used_bytes);
    z(&mut hb.mem_total_bytes);
    if let Some(m) = &mut hb.metrics {
        for v in [&mut m.load1, &mut m.load5, &mut m.load15] {
            v.get_or_insert(0.0);
        }
        m.cpu_count.get_or_insert(0);
        for v in [
            &mut m.swap_used_bytes,
            &mut m.swap_total_bytes,
            &mut m.disk_used_bytes,
            &mut m.disk_total_bytes,
            &mut m.net_rx_bytes_per_sec,
            &mut m.net_tx_bytes_per_sec,
            &mut m.net_rx_bytes_total,
            &mut m.net_tx_bytes_total,
            &mut m.process_rss_bytes,
        ] {
            z(v);
        }
        m.tcp_sockets.get_or_insert(0);
        m.udp_sockets.get_or_insert(0);
    }
    // A W11 agent sent "total 0" for a total it could not read.
    if hb.mem_total_bytes == Some(0) {
        hb.mem_total_bytes = None;
        hb.mem_used_bytes = None;
    }
}

impl Sample {
    pub fn from_heartbeat(hb: &Heartbeat) -> Self {
        let m = hb.metrics.clone().unwrap_or_default();
        Self {
            cpu: finite(hb.cpu_percent, 100.0),
            load1: finite(m.load1, 1e6),
            mem_used: hb.mem_used_bytes.map(int),
            mem_total: hb.mem_total_bytes.map(int),
            swap_used: m.swap_used_bytes.map(int),
            swap_total: m.swap_total_bytes.map(int),
            disk_used: m.disk_used_bytes.map(int),
            disk_total: m.disk_total_bytes.map(int),
            rx_bps: m.net_rx_bytes_per_sec.map(int),
            tx_bps: m.net_tx_bytes_per_sec.map(int),
            tcp: m.tcp_sockets.map(i64::from),
            udp: m.udp_sockets.map(i64::from),
            conns: int(hb.connections),
            users: i64::from(m.online_users),
        }
    }
}

/// Short, display-safe text from the agent (interface name, versions).
pub(crate) fn agent_text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// The Valkey heartbeat blob (latest values; any instance serves it).
pub fn heartbeat_blob(hb: &Heartbeat) -> Value {
    // W23: null = the agent could not read it (the console shows "—").
    let mut blob = json!({
        "cpu_percent": finite(hb.cpu_percent, 100.0),
        "mem_used_bytes": hb.mem_used_bytes,
        "mem_total_bytes": hb.mem_total_bytes,
        "connections": hb.connections,
        "uptime_seconds": hb.uptime_seconds,
        "lease_remaining_seconds": hb.lease_remaining_seconds,
        "ts": Utc::now().to_rfc3339(),
    });
    if let Some(m) = &hb.metrics {
        blob["metrics"] = json!({
            "load1": finite(m.load1, 1e6),
            "load5": finite(m.load5, 1e6),
            "load15": finite(m.load15, 1e6),
            "cpu_count": m.cpu_count,
            "swap_used_bytes": m.swap_used_bytes,
            "swap_total_bytes": m.swap_total_bytes,
            "disk_used_bytes": m.disk_used_bytes,
            "disk_total_bytes": m.disk_total_bytes,
            "net_interface": agent_text(&m.net_interface, 32),
            "net_rx_bytes_per_sec": m.net_rx_bytes_per_sec,
            "net_tx_bytes_per_sec": m.net_tx_bytes_per_sec,
            "net_rx_bytes_total": m.net_rx_bytes_total,
            "net_tx_bytes_total": m.net_tx_bytes_total,
            "tcp_sockets": m.tcp_sockets,
            "udp_sockets": m.udp_sockets,
            "online_users": m.online_users,
            "process_rss_bytes": m.process_rss_bytes,
            "xray_version": agent_text(&m.xray_version, 64),
        });
    }
    blob
}

#[derive(Clone, Copy)]
struct Seen {
    at: Instant,
    written: Option<Instant>,
    sample: Sample,
}

/// Per-instance state: the latest sample of each server whose stream this
/// instance holds (fleet gauges; dropped when the stream ends) and the
/// history write throttle.
pub struct Local {
    seen: Mutex<HashMap<Uuid, Seen>>,
    permits: std::sync::Arc<tokio::sync::Semaphore>,
}

impl Default for Local {
    fn default() -> Self {
        Self {
            seen: Mutex::new(HashMap::new()),
            permits: std::sync::Arc::new(tokio::sync::Semaphore::new(WRITE_PERMITS)),
        }
    }
}

/// Sums over the fresh samples of this instance's nodes.
#[derive(Debug, Default, PartialEq)]
pub struct Fleet {
    pub nodes: i64,
    pub online_users: i64,
    pub connections: i64,
    pub rx_bps: i64,
    pub tx_bps: i64,
    pub cpu_max: f64,
}

impl Local {
    /// Record a heartbeat; true when it is due for a history write.
    fn observe(&self, server: Uuid, s: Sample, now: Instant) -> bool {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        let e = seen.entry(server).or_insert(Seen {
            at: now,
            written: None,
            sample: s,
        });
        e.at = now;
        e.sample = s;
        let due = e
            .written
            .is_none_or(|w| now.duration_since(w) >= MIN_SAMPLE_GAP);
        if due {
            e.written = Some(now);
        }
        due
    }

    /// The server's stream on this instance ended.
    pub fn forget(&self, server: Uuid) {
        self.seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&server);
    }

    pub fn fleet(&self) -> Fleet {
        let now = Instant::now();
        let seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        let mut f = Fleet::default();
        for s in seen
            .values()
            .filter(|s| now.duration_since(s.at) < FLEET_FRESH)
        {
            f.nodes += 1;
            f.online_users = f.online_users.saturating_add(s.sample.users);
            f.connections = f.connections.saturating_add(s.sample.conns);
            // Unknown values (W23) count for nothing.
            f.rx_bps = f.rx_bps.saturating_add(s.sample.rx_bps.unwrap_or(0));
            f.tx_bps = f.tx_bps.saturating_add(s.sample.tx_bps.unwrap_or(0));
            f.cpu_max = f.cpu_max.max(s.sample.cpu.unwrap_or(0.0));
        }
        f
    }
}

/// Upsert one sample into the server's current minute (sums + maxima; the
/// totals keep the latest value). W23: unknown values are NULL; a NULL sum
/// stays NULL for the minute (`+` propagates it: an average over partly
/// unknown samples would be wrong), maxima keep the known values
/// (GREATEST ignores NULL), the totals keep the latest known value.
pub const SAMPLE_SQL: &str = "\
INSERT INTO server_metrics_1m AS m (server_id, bucket, samples, cpu_sum, cpu_max, load1_sum, \
    mem_used_sum, mem_total, swap_used_sum, swap_total, disk_used, disk_total, rx_bps_sum, \
    tx_bps_sum, rx_bps_max, tx_bps_max, tcp_sum, udp_sum, conns_sum, conns_max, users_sum, users_max) \
VALUES ($1, date_trunc('minute', now()), 1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, $11, \
    $12, $13, $14, $14, $15, $15) \
ON CONFLICT (server_id, bucket) DO UPDATE SET \
    samples = m.samples + 1, \
    cpu_sum = m.cpu_sum + EXCLUDED.cpu_sum, cpu_max = GREATEST(m.cpu_max, EXCLUDED.cpu_max), \
    load1_sum = m.load1_sum + EXCLUDED.load1_sum, \
    mem_used_sum = m.mem_used_sum + EXCLUDED.mem_used_sum, \
    mem_total = coalesce(EXCLUDED.mem_total, m.mem_total), \
    swap_used_sum = m.swap_used_sum + EXCLUDED.swap_used_sum, \
    swap_total = coalesce(EXCLUDED.swap_total, m.swap_total), \
    disk_used = coalesce(EXCLUDED.disk_used, m.disk_used), \
    disk_total = coalesce(EXCLUDED.disk_total, m.disk_total), \
    rx_bps_sum = m.rx_bps_sum + EXCLUDED.rx_bps_sum, tx_bps_sum = m.tx_bps_sum + EXCLUDED.tx_bps_sum, \
    rx_bps_max = GREATEST(m.rx_bps_max, EXCLUDED.rx_bps_max), \
    tx_bps_max = GREATEST(m.tx_bps_max, EXCLUDED.tx_bps_max), \
    tcp_sum = m.tcp_sum + EXCLUDED.tcp_sum, udp_sum = m.udp_sum + EXCLUDED.udp_sum, \
    conns_sum = m.conns_sum + EXCLUDED.conns_sum, conns_max = GREATEST(m.conns_max, EXCLUDED.conns_max), \
    users_sum = m.users_sum + EXCLUDED.users_sum, users_max = GREATEST(m.users_max, EXCLUDED.users_max)";

pub async fn write_sample(pg: &PgPool, server: Uuid, s: &Sample) -> sqlx::Result<()> {
    sqlx::query(SAMPLE_SQL)
        .bind(server)
        .bind(s.cpu)
        .bind(s.load1)
        .bind(s.mem_used.map(|v| v as f64))
        .bind(s.mem_total)
        .bind(s.swap_used.map(|v| v as f64))
        .bind(s.swap_total)
        .bind(s.disk_used)
        .bind(s.disk_total)
        .bind(s.rx_bps)
        .bind(s.tx_bps)
        .bind(s.tcp.map(|v| v as f64))
        .bind(s.udp.map(|v| v as f64))
        .bind(s.conns)
        .bind(s.users)
        .execute(pg)
        .await?;
    Ok(())
}

/// D5: the interface counters of a heartbeat (both totals known and an
/// interface named; otherwise the quota counters are left alone).
#[derive(Debug, Clone, PartialEq)]
pub struct Nic {
    pub name: String,
    pub rx: i64,
    pub tx: i64,
}

impl Nic {
    pub fn from_heartbeat(hb: &Heartbeat) -> Option<Self> {
        let m = hb.metrics.as_ref()?;
        let name = agent_text(&m.net_interface, 32);
        if name.is_empty() {
            return None;
        }
        Some(Self {
            name,
            rx: int(m.net_rx_bytes_total?),
            tx: int(m.net_tx_bytes_total?),
        })
    }
}

/// D5: add what the interface moved since the baseline to the period's
/// counters (`akari_nic_delta`: a first sample or a new interface only sets
/// the baseline, a counter that went down counts from 0, steps are capped)
/// and keep the new baseline. The trigger `servers_traffic_quota` stops the
/// server when the quota is used up. Heartbeats skipped here lose nothing
/// (the counters are cumulative).
pub const NIC_SQL: &str = "\
UPDATE servers SET \
    traffic_quota_rx_bytes = LEAST(traffic_quota_rx_bytes::numeric \
        + akari_nic_delta(nic_name = $2, nic_rx_last, $3, nic_at), 9223372036854775807)::bigint, \
    traffic_quota_tx_bytes = LEAST(traffic_quota_tx_bytes::numeric \
        + akari_nic_delta(nic_name = $2, nic_tx_last, $4, nic_at), 9223372036854775807)::bigint, \
    nic_name = $2, nic_rx_last = $3, nic_tx_last = $4, nic_at = now() \
WHERE id = $1";

pub async fn write_nic(pg: &PgPool, server: Uuid, nic: &Nic) -> sqlx::Result<()> {
    sqlx::query(NIC_SQL)
        .bind(server)
        .bind(&nic.name)
        .bind(nic.rx)
        .bind(nic.tx)
        .execute(pg)
        .await?;
    Ok(())
}

/// Heartbeat hook (grpc.rs, after the Valkey write): fleet gauges and, at
/// most every MIN_SAMPLE_GAP, the interface counters (D5) and a history
/// write in the background (never delays the stream; skipped when
/// WRITE_PERMITS are all busy).
pub fn on_heartbeat(state: &AppState, server: Uuid, hb: &Heartbeat) {
    let s = Sample::from_heartbeat(hb);
    if !state.nodestat().observe(server, s, Instant::now()) {
        return;
    }
    let Ok(permit) = state.nodestat().permits.clone().try_acquire_owned() else {
        tracing::debug!(server = %server, "metrics history write skipped (database busy)");
        return;
    };
    let nic = Nic::from_heartbeat(hb);
    let pg = state.pg().clone();
    tokio::spawn(async move {
        if let Some(nic) = &nic
            && let Err(e) = write_nic(&pg, server, nic).await
        {
            tracing::warn!(server = %server, error = %e, "interface counters write failed");
        }
        if let Err(e) = write_sample(&pg, server, &s).await {
            // A server deleted meanwhile (foreign key) is not worth a warning.
            tracing::debug!(server = %server, error = %e, "metrics history write failed");
        }
        drop(permit);
    });
}

// ---------------------------------------------------------------------------
// Rollup and retention (reaper loop)
// ---------------------------------------------------------------------------

/// The averaged (sum) columns: a sample without the value makes its
/// minute's sum NULL (W23).
const SUM_COLS: [&str; 9] = [
    "cpu_sum",
    "load1_sum",
    "mem_used_sum",
    "swap_used_sum",
    "rx_bps_sum",
    "tx_bps_sum",
    "tcp_sum",
    "udp_sum",
    "conns_sum",
];

/// `sum(col) / samples of the rows that have it` (NULL when none has).
fn avg_sql(col: &str) -> String {
    format!("(sum({col}) / nullif(sum(samples) FILTER (WHERE {col} IS NOT NULL), 0))::float8")
}

/// The hour rows from the minute rows. A sum column is rescaled to the
/// hour's sample count (`sum(col) * samples / samples with it`), so that
/// `sum / samples` stays the average over the minutes that had the value
/// (NULL when none had).
fn rollup_sql() -> String {
    let sums = SUM_COLS
        .iter()
        .map(|c| {
            format!(
                "sum({c}) * sum(samples) / nullif(sum(samples) FILTER (WHERE {c} IS NOT NULL), 0)"
            )
        })
        .collect::<Vec<_>>();
    format!(
        "INSERT INTO server_metrics_1h AS h (server_id, bucket, samples, cpu_sum, cpu_max, load1_sum, \
    mem_used_sum, mem_total, swap_used_sum, swap_total, disk_used, disk_total, rx_bps_sum, \
    tx_bps_sum, rx_bps_max, tx_bps_max, tcp_sum, udp_sum, conns_sum, conns_max, users_sum, users_max) \
SELECT server_id, date_trunc('hour', bucket), sum(samples), {cpu}, max(cpu_max), {load1}, \
    {mem}, max(mem_total), {swap}, max(swap_total), max(disk_used), \
    max(disk_total), {rx}, {tx}, max(rx_bps_max), max(tx_bps_max), \
    {tcp}, {udp}, {conns}, max(conns_max), sum(users_sum), max(users_max) \
FROM server_metrics_1m \
WHERE bucket >= date_trunc('hour', now()) - interval '2 hours' \
GROUP BY 1, 2 ORDER BY 1, 2 \
ON CONFLICT (server_id, bucket) DO UPDATE SET \
    samples = EXCLUDED.samples, cpu_sum = EXCLUDED.cpu_sum, cpu_max = EXCLUDED.cpu_max, \
    load1_sum = EXCLUDED.load1_sum, mem_used_sum = EXCLUDED.mem_used_sum, \
    mem_total = EXCLUDED.mem_total, swap_used_sum = EXCLUDED.swap_used_sum, \
    swap_total = EXCLUDED.swap_total, disk_used = EXCLUDED.disk_used, \
    disk_total = EXCLUDED.disk_total, rx_bps_sum = EXCLUDED.rx_bps_sum, \
    tx_bps_sum = EXCLUDED.tx_bps_sum, rx_bps_max = EXCLUDED.rx_bps_max, \
    tx_bps_max = EXCLUDED.tx_bps_max, tcp_sum = EXCLUDED.tcp_sum, udp_sum = EXCLUDED.udp_sum, \
    conns_sum = EXCLUDED.conns_sum, conns_max = EXCLUDED.conns_max, \
    users_sum = EXCLUDED.users_sum, users_max = EXCLUDED.users_max",
        cpu = sums[0],
        load1 = sums[1],
        mem = sums[2],
        swap = sums[3],
        rx = sums[4],
        tx = sums[5],
        tcp = sums[6],
        udp = sums[7],
        conns = sums[8],
    )
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Rollup {
    pub hours_written: u64,
    pub minutes_pruned: u64,
    pub hours_pruned: u64,
}

/// Recompute the hour buckets of the last ~3 hours from the minute rows
/// (idempotent: a bucket is replaced by the sum of its minutes, which are
/// kept 48 h), then delete expired rows in batches. One instance at a time
/// (advisory try-lock; the others skip this round).
pub async fn rollup_and_prune(pg: &PgPool) -> sqlx::Result<Option<Rollup>> {
    let mut tx = pg.begin().await?;
    let got: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext('akari.nodestat'))")
            .fetch_one(&mut *tx)
            .await?;
    if !got {
        return Ok(None);
    }
    let mut r = Rollup {
        hours_written: sqlx::query(sqlx::AssertSqlSafe(rollup_sql()))
            .execute(&mut *tx)
            .await?
            .rows_affected(),
        ..Default::default()
    };
    r.minutes_pruned = prune(
        &mut tx,
        "server_metrics_1m",
        &format!("now() - interval '{MINUTE_RETENTION_HOURS} hours'"),
    )
    .await?;
    r.hours_pruned = prune(
        &mut tx,
        "server_metrics_1h",
        &format!("now() - interval '{HOUR_RETENTION_DAYS} days'"),
    )
    .await?;
    tx.commit().await?;
    Ok(Some(r))
}

async fn prune(conn: &mut PgConnection, table: &str, cutoff: &str) -> sqlx::Result<u64> {
    let mut total = 0;
    loop {
        let n = sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM {table} \
             WHERE bucket < {cutoff} LIMIT {PRUNE_BATCH}))"
        )))
        .execute(&mut *conn)
        .await?
        .rows_affected();
        total += n;
        if n < PRUNE_BATCH as u64 {
            return Ok(total);
        }
    }
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

/// The agent's test settings from `[probe]`; run_token = the server's latest
/// "立即测速" request (epoch microseconds; 0 = none).
pub fn probe_config(
    cfg: &crate::config::ProbeConfig,
    requested: Option<DateTime<Utc>>,
) -> LatencyProbeConfig {
    LatencyProbeConfig {
        interval_seconds: u32::try_from(cfg.interval_secs).unwrap_or(u32::MAX),
        urls: cfg.urls.clone(),
        timeout_ms: cfg.timeout_ms,
        attempts: cfg.attempts,
        run_token: requested
            .map(|t| u64::try_from(t.timestamp_micros()).unwrap_or(0))
            .unwrap_or(0),
    }
}

/// At most this many URLs of an agent report are kept.
const MAX_AGENT_RESULTS: usize = 4;

/// Store an agent's LatencyReport: replaces the server's agent results unless
/// a newer set is already stored (a re-sent old report after a newer one).
/// Agent input is bounded: <= 4 results, URLs <= 512 bytes without control
/// characters, errors <= 200 characters, timestamps clamped to
/// [now - 7 d, now].
pub async fn store_agent_latency(
    pg: &PgPool,
    server: Uuid,
    rep: &LatencyReport,
) -> sqlx::Result<()> {
    let now = Utc::now();
    let at = DateTime::<Utc>::from_timestamp(rep.measured_at_unix, 0)
        .unwrap_or(now)
        .clamp(now - chrono::Duration::days(7), now);
    let mut targets = Vec::new();
    let mut delays: Vec<Option<i32>> = Vec::new();
    let mut errors: Vec<Option<String>> = Vec::new();
    for r in rep.results.iter().take(MAX_AGENT_RESULTS) {
        if r.url.is_empty()
            || r.url.len() > 512
            || r.url.chars().any(char::is_control)
            || targets.contains(&r.url)
        {
            continue;
        }
        targets.push(r.url.clone());
        delays.push(r.ok.then(|| i32::try_from(r.delay_ms).unwrap_or(i32::MAX)));
        errors.push((!r.ok).then(|| {
            let e = agent_text(&r.error, 200);
            if e.is_empty() { "failed".into() } else { e }
        }));
    }
    replace_latency(pg, server, "agent", at, &targets, &delays, &errors).await
}

async fn replace_latency(
    pg: &PgPool,
    server: Uuid,
    source: &str,
    at: DateTime<Utc>,
    targets: &[String],
    delays: &[Option<i32>],
    errors: &[Option<String>],
) -> sqlx::Result<()> {
    let mut tx = pg.begin().await?;
    let newest: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT max(measured_at) FROM server_latency WHERE server_id = $1 AND source = $2",
    )
    .bind(server)
    .bind(source)
    .fetch_one(&mut *tx)
    .await?;
    if newest.is_some_and(|n| n > at) {
        return Ok(());
    }
    sqlx::query("DELETE FROM server_latency WHERE server_id = $1 AND source = $2")
        .bind(server)
        .bind(source)
        .execute(&mut *tx)
        .await?;
    let ords: Vec<i16> = (0..targets.len() as i16).collect();
    let r = sqlx::query(
        "INSERT INTO server_latency (server_id, source, target, delay_ms, error, ord, measured_at) \
         SELECT $1, $2, t, d, e, o, $7 \
         FROM unnest($3::text[], $4::int[], $5::text[], $6::smallint[]) AS x(t, d, e, o) \
         WHERE EXISTS (SELECT 1 FROM servers WHERE id = $1)",
    )
    .bind(server)
    .bind(source)
    .bind(targets)
    .bind(delays)
    .bind(errors)
    .bind(&ords)
    .bind(at)
    .execute(&mut *tx)
    .await;
    match r {
        // The server was deleted meanwhile: nothing to keep.
        Err(sqlx::Error::Database(db)) if db.is_foreign_key_violation() => return Ok(()),
        r => r?,
    };
    tx.commit().await
}

/// "立即测速" (POST /nodes/{id}/probe): record the request (the agent's
/// session sends the new run_token on its next wake — this transaction
/// notifies it — and the panel's TCP test is due at once). At most once
/// per server per `[probe].manual_cooldown_secs` (409 otherwise; DB clock,
/// so every instance agrees). Audited.
pub async fn apply_request_probe(
    conn: &mut PgConnection,
    actor: &Actor,
    server: Uuid,
    cooldown_secs: u64,
) -> Result<DateTime<Utc>, ApiError> {
    let row: Option<(DateTime<Utc>,)> = sqlx::query_as(
        "UPDATE servers SET probe_requested_at = now(), panel_probe_next_at = NULL \
         WHERE id = $1 AND deleting_at IS NULL \
           AND (probe_requested_at IS NULL OR probe_requested_at <= now() - make_interval(secs => $2)) \
         RETURNING probe_requested_at",
    )
    .bind(server)
    .bind(cooldown_secs as f64)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((at,)) = row else {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM servers WHERE id = $1 AND deleting_at IS NULL)",
        )
        .bind(server)
        .fetch_one(&mut *conn)
        .await?;
        return Err(if exists {
            crate::auth::api_error!(
                TOO_MANY_REQUESTS,
                "node.probe_cooldown",
                "a latency test was requested moments ago"
            )
        } else {
            ApiError::not_found()
        });
    };
    // Wake the server's session wherever it is (no version change: the
    // trigger stays quiet).
    sqlx::query("SELECT pg_notify('akari_change', $1)")
        .bind(server.to_string())
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "server.probe",
        "server",
        Some(server.to_string()),
        None,
        None,
    )
    .await?;
    Ok(at)
}

/// The probe request a session should forward (`grpc::maybe_send_probe`).
pub async fn requested_at(pg: &PgPool, server: Uuid) -> sqlx::Result<Option<DateTime<Utc>>> {
    Ok(sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
        "SELECT probe_requested_at FROM servers WHERE id = $1",
    )
    .bind(server)
    .fetch_optional(pg)
    .await?
    .flatten())
}

/// What the panel dials for one entrance: the client-facing host/port
/// (the entrance's, else the server's TLS domain and the inbound's port) and
/// whether TCP can measure it.
#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    /// The entrance's name (`server_latency.target`).
    pub name: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub udp_only: bool,
}

/// An enabled entrance's client-facing address as stored.
#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
pub struct EntranceAddr {
    pub name: String,
    pub connect_host: Option<String>,
    pub connect_port: Option<i32>,
}

/// One target per entrance, in the given order; none without an inbound.
pub fn targets(
    inbound: Option<&Value>,
    tls_domain: Option<&str>,
    entrances: &[EntranceAddr],
) -> Vec<Target> {
    let Some(ib) = inbound else {
        return Vec::new();
    };
    let inbound_port = ib
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok());
    let (tcp, _) = crate::protocols::l4(ib);
    entrances
        .iter()
        .map(|e| Target {
            name: e.name.clone(),
            host: e
                .connect_host
                .clone()
                .or_else(|| tls_domain.map(str::to_string))
                .filter(|h| !h.is_empty()),
            port: e
                .connect_port
                .and_then(|p| u16::try_from(p).ok())
                .or(inbound_port),
            udp_only: !tcp,
        })
        .collect()
}

/// TCP connect time (DNS excluded: resolved once, first address), median
/// of `attempts` with a failure counting as the timeout; Err when every
/// attempt failed.
pub async fn tcp_latency(
    host: &str,
    port: u16,
    attempts: u32,
    timeout: Duration,
) -> Result<u32, String> {
    let addr = match tokio::time::timeout(timeout, tokio::net::lookup_host((host, port))).await {
        Ok(Ok(mut a)) => match a.next() {
            Some(a) => a,
            None => return Err("no address".into()),
        },
        Ok(Err(_)) => return Err("dns".into()),
        Err(_) => return Err("timeout".into()),
    };
    let mut vals = Vec::new();
    let mut ok = false;
    let mut last_err = String::new();
    for _ in 0..attempts.max(1) {
        let start = Instant::now();
        match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
            Ok(Ok(_s)) => {
                ok = true;
                vals.push(start.elapsed());
            }
            Ok(Err(e)) => {
                last_err = match e.kind() {
                    std::io::ErrorKind::ConnectionRefused => "refused".into(),
                    _ => "unreachable".into(),
                };
                vals.push(timeout);
            }
            Err(_) => {
                last_err = "timeout".into();
                vals.push(timeout);
            }
        }
    }
    if !ok {
        return Err(last_err);
    }
    vals.sort();
    let mid = if vals.len() % 2 == 1 {
        vals[vals.len() / 2]
    } else {
        (vals[vals.len() / 2 - 1] + vals[vals.len() / 2]) / 2
    };
    Ok(u32::try_from(mid.as_millis().max(1)).unwrap_or(u32::MAX))
}

/// Servers claimed per round by one instance.
const CLAIM_BATCH: i64 = 8;
const PANEL_PROBE_TICK: Duration = Duration::from_secs(15);
/// Targets tested per server and round.
const MAX_TARGETS: usize = 32;

#[derive(sqlx::FromRow)]
struct Due {
    id: Uuid,
    tls_domain: Option<String>,
    /// `[DueNode]`: the server's enabled nodes with an inbound.
    nodes: Value,
}

/// One node of a claimed server and its enabled entrances.
#[derive(Deserialize)]
struct DueNode {
    name: String,
    inbound: Value,
    entrances: Vec<EntranceAddr>,
}

/// The latency target name of an entrance: unique on its server (entrance
/// names are unique per node).
pub fn target_name(node: &str, entrance: &str) -> String {
    format!("{node} / {entrance}")
}

/// The panel's TCP test (any instance): every PANEL_PROBE_TICK claim up to
/// CLAIM_BATCH servers whose test is due (next time = now + interval
/// +-10%, set in the claiming UPDATE, so instances never test the same
/// server twice) and test their nodes' entrances concurrently.
pub async fn panel_probe_loop(state: AppState) {
    let mut tick = tokio::time::interval(PANEL_PROBE_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        // W12: the effective settings (系统设置 over panel.toml), per round.
        let cfg = state.settings().get().probe.clone();
        if !cfg.panel_tcp {
            continue;
        }
        let timeout = Duration::from_millis(u64::from(cfg.timeout_ms));
        if let Err(e) =
            panel_probe_round(state.pg(), cfg.interval_secs, cfg.attempts, timeout).await
        {
            tracing::warn!(error = %e, "panel latency test round failed");
        }
    }
}

pub async fn panel_probe_round(
    pg: &PgPool,
    interval_secs: u64,
    attempts: u32,
    timeout: Duration,
) -> sqlx::Result<usize> {
    let due: Vec<Due> = sqlx::query_as(
        "UPDATE servers s SET panel_probe_next_at = now() + make_interval(secs => $1 * (0.9 + 0.2 * random())) \
         WHERE s.id IN (SELECT id FROM servers WHERE deleting_at IS NULL \
             AND (panel_probe_next_at IS NULL OR panel_probe_next_at <= now()) \
             AND EXISTS (SELECT 1 FROM nodes n WHERE n.server_id = servers.id AND n.enabled) \
             ORDER BY panel_probe_next_at NULLS FIRST, id LIMIT $2 FOR UPDATE SKIP LOCKED) \
         RETURNING s.id, s.tls_domain, \
             coalesce((SELECT jsonb_agg(jsonb_build_object('name', n.name, 'inbound', n.inbound, \
                 'entrances', coalesce((SELECT jsonb_agg(jsonb_build_object('name', e.name, \
                     'connect_host', e.connect_host, 'connect_port', e.connect_port) \
                     ORDER BY e.kind <> 'direct', e.sort, e.created_at, e.id) \
                     FROM entrances e WHERE e.node_id = n.id AND e.enabled), '[]'::jsonb)) \
                 ORDER BY n.sort, n.name, n.id) \
                 FROM nodes n WHERE n.server_id = s.id AND n.enabled AND n.inbound IS NOT NULL), \
                 '[]'::jsonb) AS nodes",
    )
    .bind(interval_secs as f64)
    .bind(CLAIM_BATCH)
    .fetch_all(pg)
    .await?;
    let n = due.len();
    let mut set = tokio::task::JoinSet::new();
    for d in due {
        let pg = pg.clone();
        set.spawn(async move {
            let nodes: Vec<DueNode> = serde_json::from_value(d.nodes).unwrap_or_default();
            let ts: Vec<Target> = nodes
                .iter()
                .flat_map(|n| {
                    targets(Some(&n.inbound), d.tls_domain.as_deref(), &n.entrances)
                        .into_iter()
                        .map(|t| Target {
                            name: target_name(&n.name, &t.name),
                            ..t
                        })
                })
                .collect();
            let mut tags = Vec::new();
            let mut delays = Vec::new();
            let mut errors = Vec::new();
            for t in ts.iter().take(MAX_TARGETS) {
                let r = match (&t.host, t.port, t.udp_only) {
                    (_, _, true) => Err("udp".to_string()),
                    (Some(h), Some(p), false) => tcp_latency(h, p, attempts, timeout).await,
                    _ => Err("no address".to_string()),
                };
                tags.push(t.name.clone());
                match r {
                    Ok(ms) => {
                        delays.push(Some(i32::try_from(ms).unwrap_or(i32::MAX)));
                        errors.push(None);
                    }
                    Err(e) => {
                        delays.push(None);
                        errors.push(Some(e));
                    }
                }
            }
            if let Err(e) =
                replace_latency(&pg, d.id, "panel", Utc::now(), &tags, &delays, &errors).await
            {
                tracing::warn!(server = %d.id, error = %e, "failed to store panel latency");
            }
        });
    }
    while set.join_next().await.is_some() {}
    Ok(n)
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct LatencyRow {
    pub source: String,
    pub target: String,
    pub delay_ms: Option<i32>,
    pub error: Option<String>,
    pub measured_at: DateTime<Utc>,
}

/// JSON array of a node's latency rows (server alias `a`), for NodeView.
pub fn latency_json_sql(a: &str) -> String {
    format!(
        "(SELECT coalesce(jsonb_agg(jsonb_build_object(\
         'source', l.source, 'target', l.target, 'delay_ms', l.delay_ms, 'error', l.error, \
         'measured_at', l.measured_at) ORDER BY l.source, l.ord), '[]'::jsonb) \
         FROM server_latency l WHERE l.server_id = {a}.id)"
    )
}

/// GET /servers/{id}/status (admin): the latest heartbeat (Valkey), online
/// state, latency results and traffic totals (over its nodes) of one
/// server.
pub async fn server_status(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    #[derive(sqlx::FromRow)]
    struct Row {
        status: String,
        online: bool,
        last_seen_at: Option<DateTime<Utc>>,
        latency: Value,
        traffic_raw_bytes: i64,
        traffic_billed_bytes: i64,
        probe_requested_at: Option<DateTime<Utc>>,
    }
    let row: Row = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT s.status, {} AS online, s.last_seen_at, {} AS latency, \
         coalesce((SELECT sum(n.traffic_raw_bytes) FROM nodes n WHERE n.server_id = s.id), 0)::int8 \
             AS traffic_raw_bytes, \
         coalesce((SELECT sum(n.traffic_billed_bytes) FROM nodes n WHERE n.server_id = s.id), 0)::int8 \
             AS traffic_billed_bytes, \
         s.probe_requested_at \
         FROM servers s WHERE s.id = $1",
        online_sql("s"),
        latency_json_sql("s")
    )))
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    let hb = heartbeat(&state, id).await;
    Ok(Json(json!({
        "id": id,
        "status": row.status,
        "online": row.online,
        "last_seen_at": row.last_seen_at,
        "heartbeat": hb,
        "latency": row.latency,
        "traffic_raw_bytes": row.traffic_raw_bytes,
        "traffic_billed_bytes": row.traffic_billed_bytes,
        "probe_requested_at": row.probe_requested_at,
    })))
}

async fn heartbeat(state: &AppState, id: Uuid) -> Option<Value> {
    use fred::prelude::KeysInterface;
    match state
        .valkey()
        .get::<Option<String>, _>(format!("akari:server:hb:{id}"))
        .await
    {
        Ok(b) => b.and_then(|b| serde_json::from_str(&b).ok()),
        Err(e) => {
            tracing::warn!(error = %e, "heartbeat lookup failed");
            None
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetricsQuery {
    #[serde(default)]
    pub range: Option<String>,
}

/// A history range: its length, the table it reads and the point width
/// (<= ~360 points).
#[derive(Debug, PartialEq, Eq)]
pub struct RangeSpec {
    pub secs: i64,
    pub hourly: bool,
    pub step_secs: i64,
}

pub fn range_spec(r: &str) -> Option<RangeSpec> {
    let (secs, hourly, step_secs) = match r {
        "1h" => (3600, false, 60),
        "6h" => (6 * 3600, false, 60),
        "24h" => (86_400, false, 300),
        "48h" => (2 * 86_400, false, 600),
        "7d" => (7 * 86_400, true, 3600),
        "30d" => (30 * 86_400, true, 2 * 3600),
        "90d" => (90 * 86_400, true, 6 * 3600),
        _ => return None,
    };
    Some(RangeSpec {
        secs,
        hourly,
        step_secs,
    })
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Point {
    pub t: DateTime<Utc>,
    pub samples: i64,
    // W23: null = unknown in that interval.
    pub cpu: Option<f64>,
    pub cpu_max: Option<f64>,
    pub load1: Option<f64>,
    pub mem_used: Option<f64>,
    pub mem_total: Option<i64>,
    pub swap_used: Option<f64>,
    pub swap_total: Option<i64>,
    pub disk_used: Option<i64>,
    pub disk_total: Option<i64>,
    pub rx_bps: Option<f64>,
    pub tx_bps: Option<f64>,
    pub rx_bps_max: Option<i64>,
    pub tx_bps_max: Option<i64>,
    pub tcp: Option<f64>,
    pub udp: Option<f64>,
    pub conns: Option<f64>,
    pub conns_max: i64,
    pub users: f64,
    pub users_max: i64,
}

pub async fn history(pg: &PgPool, server: Uuid, spec: &RangeSpec) -> sqlx::Result<Vec<Point>> {
    let table = if spec.hourly {
        "server_metrics_1h"
    } else {
        "server_metrics_1m"
    };
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT to_timestamp(floor(extract(epoch FROM bucket) / $3) * $3) AS t, \
         sum(samples)::bigint AS samples, \
         {cpu} AS cpu, max(cpu_max)::float8 AS cpu_max, {load1} AS load1, \
         {mem} AS mem_used, max(mem_total) AS mem_total, \
         {swap} AS swap_used, max(swap_total) AS swap_total, \
         max(disk_used) AS disk_used, max(disk_total) AS disk_total, \
         {rx} AS rx_bps, {tx} AS tx_bps, \
         max(rx_bps_max) AS rx_bps_max, max(tx_bps_max) AS tx_bps_max, \
         {tcp} AS tcp, {udp} AS udp, \
         {conns} AS conns, max(conns_max) AS conns_max, \
         (sum(users_sum) / sum(samples))::float8 AS users, max(users_max) AS users_max \
         FROM {table} WHERE server_id = $1 AND bucket >= now() - make_interval(secs => $2) \
         GROUP BY 1 ORDER BY 1",
        cpu = avg_sql("cpu_sum"),
        load1 = avg_sql("load1_sum"),
        mem = avg_sql("mem_used_sum"),
        swap = avg_sql("swap_used_sum"),
        rx = avg_sql("rx_bps_sum"),
        tx = avg_sql("tx_bps_sum"),
        tcp = avg_sql("tcp_sum"),
        udp = avg_sql("udp_sum"),
        conns = avg_sql("conns_sum"),
    )))
    .bind(server)
    .bind(spec.secs as f64)
    .bind(spec.step_secs as f64)
    .fetch_all(pg)
    .await
}

/// GET /servers/{id}/metrics?range=1h|6h|24h|48h|7d|30d|90d (admin;
/// default 24h): averaged points (and maxima) of the server's history.
pub async fn server_metrics(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    Query(q): Query<MetricsQuery>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let range = q.range.unwrap_or_else(|| "24h".into());
    let spec = range_spec(&range).ok_or_else(|| {
        bad_request!(
            "node.range_invalid",
            "range must be one of 1h, 6h, 24h, 48h, 7d, 30d, 90d"
        )
    })?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM servers WHERE id = $1)")
        .bind(id)
        .fetch_one(state.pg())
        .await?;
    if !exists {
        return Err(ApiError::not_found());
    }
    let points = history(state.pg(), id, &spec).await?;
    Ok(Json(json!({
        "range": range,
        "step_secs": spec.step_secs,
        "points": points,
    })))
}

/// POST /servers/{id}/probe (admin): "立即测速". 202 with the request time;
/// results arrive in GET /servers/{id}/status (agent: seconds; panel TCP:
/// within ~15 s).
pub async fn request_probe(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<(axum::http::StatusCode, Json<Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let at = apply_request_probe(
        &mut tx,
        &Actor::of(&user),
        id,
        state.settings().get().probe.manual_cooldown_secs,
    )
    .await?;
    tx.commit().await?;
    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(json!({ "requested_at": at })),
    ))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MyNodeStatus {
    /// The node's user-facing name and the entrance's (W28-a: one row per
    /// usable entrance, "香港 01" + "直连").
    pub name: String,
    pub entrance: String,
    pub region: Option<String>,
    pub tags: Vec<String>,
    /// Traffic multiplier (1.0 = billed as used).
    pub rate: f64,
    pub online: bool,
    /// The agent's latest url-test result: delay of the first URL that
    /// answered, null when none did or no test ran yet.
    pub latency_ms: Option<i32>,
    /// ok | timeout | unknown
    pub latency_status: String,
    pub latency_measured_at: Option<DateTime<Utc>>,
}

/// GET /me/nodes (user portal): the entrances the caller can use on nodes
/// shown to users — node and entrance name, region, tags, the entrance's
/// multiplier, online, latency (the node's server's). No ids, addresses,
/// inbounds or machine metrics.
pub async fn my_nodes(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<MyNodeStatus>>, ApiError> {
    let rows = sqlx::query_as::<_, MyNodeStatus>(sqlx::AssertSqlSafe(format!(
        "SELECT coalesce(n.display_name, n.name) AS name, e.name AS entrance, n.region, e.tags, \
         (akari_entrance_rate(e.id, statement_timestamp()) / 1000.0)::float8 AS rate, \
         {} AS online, \
         l.delay_ms AS latency_ms, \
         CASE WHEN l.delay_ms IS NOT NULL THEN 'ok' WHEN lf.server_id IS NOT NULL THEN 'timeout' \
              ELSE 'unknown' END AS latency_status, \
         coalesce(l.measured_at, lf.measured_at) AS latency_measured_at \
         FROM entrance_users eu JOIN entrances e ON e.id = eu.entrance_id \
         JOIN nodes n ON n.id = e.node_id \
         JOIN servers s ON s.id = n.server_id \
         LEFT JOIN LATERAL (SELECT delay_ms, measured_at FROM server_latency \
             WHERE server_id = s.id AND source = 'agent' AND delay_ms IS NOT NULL \
             ORDER BY ord LIMIT 1) l ON true \
         LEFT JOIN LATERAL (SELECT server_id, measured_at FROM server_latency \
             WHERE server_id = s.id AND source = 'agent' ORDER BY ord LIMIT 1) lf ON true \
         WHERE eu.user_id = $1 AND n.enabled AND n.visible AND {serves} \
         AND n.inbound IS NOT NULL AND e.enabled AND e.hidden_since IS NULL \
         ORDER BY n.sort, coalesce(n.display_name, n.name), e.kind <> 'direct', e.sort, e.name",
        online_sql("s"),
        serves = crate::grpc::SERVER_SERVES
    )))
    .bind(user.id)
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests;
