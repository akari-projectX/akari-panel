//! W11: node machine status (heartbeat metrics), its history, and latency
//! tests.
//!
//! - **Latest values**: the heartbeat blob in Valkey (`akari:node:hb:<id>`,
//!   written by `grpc::store_heartbeat` with `heartbeat_blob`), so any
//!   instance serves them. Offline = the existing node status (the
//!   `online_sql` predicate: status 'online' refreshed within 90 s).
//! - **History**: `node_metrics_1m` (one row per node and minute; the
//!   instance holding the node's stream upserts each heartbeat into the
//!   current minute, adding to sums, at most one write per node per
//!   `MIN_SAMPLE_GAP`) rolled up into `node_metrics_1h` by
//!   `rollup_and_prune` (reaper loop, every 10 min, one instance at a time
//!   via an advisory try-lock). Retention: minutes 48 h, hours 90 days.
//!   Sized for 200 nodes: <= 576k minute rows and 432k hour rows.
//! - **Latency**: the agents' url-test (`LatencyReport`, capability
//!   "latency"; the panel sends `LatencyProbeConfig` from `[probe]`) and the
//!   panel's own TCP connect test to every inbound's client-facing
//!   address (`panel_probe_loop`, any instance, rows claimed with a
//!   conditional UPDATE). Results replace the previous set per (node,
//!   source) in `node_latency`. "立即测速" = `apply_request_probe`.
//! - **Prometheus**: fleet aggregates of the nodes connected to THIS
//!   instance (`Local::fleet`; sum over instances in PromQL). No per-node
//!   labels: node ids/names are unbounded label values (src/CLAUDE.md
//!   metrics rule); per-node history is the API's job.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::gen::{Heartbeat, LatencyProbeConfig, LatencyReport};
use crate::state::AppState;

/// SQL predicate over node alias `a`: the node is online — the same rule
/// the reaper uses (a session marks it online and refreshes last_seen_at
/// every 30 s).
pub fn online_sql(a: &str) -> String {
    format!("({a}.status = 'online' AND {a}.last_seen_at > now() - interval '90 seconds')")
}

/// At most one history write per node per this long (a heartbeat flood
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

/// One heartbeat, sanitized (agent input: finite, bounded).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    pub cpu: f64,
    pub load1: f64,
    pub mem_used: i64,
    pub mem_total: i64,
    pub swap_used: i64,
    pub swap_total: i64,
    pub disk_used: i64,
    pub disk_total: i64,
    pub rx_bps: i64,
    pub tx_bps: i64,
    pub tcp: i64,
    pub udp: i64,
    pub conns: i64,
    pub users: i64,
}

fn finite(v: f64, max: f64) -> f64 {
    if v.is_finite() {
        v.clamp(0.0, max)
    } else {
        0.0
    }
}

fn int(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

impl Sample {
    pub fn from_heartbeat(hb: &Heartbeat) -> Self {
        let m = hb.metrics.clone().unwrap_or_default();
        Self {
            cpu: finite(hb.cpu_percent, 100.0),
            load1: finite(m.load1, 1e6),
            mem_used: int(hb.mem_used_bytes),
            mem_total: int(hb.mem_total_bytes),
            swap_used: int(m.swap_used_bytes),
            swap_total: int(m.swap_total_bytes),
            disk_used: int(m.disk_used_bytes),
            disk_total: int(m.disk_total_bytes),
            rx_bps: int(m.net_rx_bytes_per_sec),
            tx_bps: int(m.net_tx_bytes_per_sec),
            tcp: i64::from(m.tcp_sockets),
            udp: i64::from(m.udp_sockets),
            conns: int(hb.connections),
            users: i64::from(m.online_users),
        }
    }
}

/// Short, display-safe text from the agent (interface name, versions).
fn agent_text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// The Valkey heartbeat blob (latest values; any instance serves it).
pub fn heartbeat_blob(hb: &Heartbeat) -> Value {
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

/// Per-instance state: the latest sample of each node whose stream this
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
    fn observe(&self, node: Uuid, s: Sample, now: Instant) -> bool {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        let e = seen.entry(node).or_insert(Seen {
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

    /// The node's stream on this instance ended.
    pub fn forget(&self, node: Uuid) {
        self.seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&node);
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
            f.rx_bps = f.rx_bps.saturating_add(s.sample.rx_bps);
            f.tx_bps = f.tx_bps.saturating_add(s.sample.tx_bps);
            f.cpu_max = f.cpu_max.max(s.sample.cpu);
        }
        f
    }
}

/// Upsert one sample into the node's current minute (sums + maxima; the
/// totals keep the latest value).
pub const SAMPLE_SQL: &str = "\
INSERT INTO node_metrics_1m AS m (node_id, bucket, samples, cpu_sum, cpu_max, load1_sum, \
    mem_used_sum, mem_total, swap_used_sum, swap_total, disk_used, disk_total, rx_bps_sum, \
    tx_bps_sum, rx_bps_max, tx_bps_max, tcp_sum, udp_sum, conns_sum, conns_max, users_sum, users_max) \
VALUES ($1, date_trunc('minute', now()), 1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, $11, \
    $12, $13, $14, $14, $15, $15) \
ON CONFLICT (node_id, bucket) DO UPDATE SET \
    samples = m.samples + 1, \
    cpu_sum = m.cpu_sum + EXCLUDED.cpu_sum, cpu_max = GREATEST(m.cpu_max, EXCLUDED.cpu_max), \
    load1_sum = m.load1_sum + EXCLUDED.load1_sum, \
    mem_used_sum = m.mem_used_sum + EXCLUDED.mem_used_sum, mem_total = EXCLUDED.mem_total, \
    swap_used_sum = m.swap_used_sum + EXCLUDED.swap_used_sum, swap_total = EXCLUDED.swap_total, \
    disk_used = EXCLUDED.disk_used, disk_total = EXCLUDED.disk_total, \
    rx_bps_sum = m.rx_bps_sum + EXCLUDED.rx_bps_sum, tx_bps_sum = m.tx_bps_sum + EXCLUDED.tx_bps_sum, \
    rx_bps_max = GREATEST(m.rx_bps_max, EXCLUDED.rx_bps_max), \
    tx_bps_max = GREATEST(m.tx_bps_max, EXCLUDED.tx_bps_max), \
    tcp_sum = m.tcp_sum + EXCLUDED.tcp_sum, udp_sum = m.udp_sum + EXCLUDED.udp_sum, \
    conns_sum = m.conns_sum + EXCLUDED.conns_sum, conns_max = GREATEST(m.conns_max, EXCLUDED.conns_max), \
    users_sum = m.users_sum + EXCLUDED.users_sum, users_max = GREATEST(m.users_max, EXCLUDED.users_max)";

pub async fn write_sample(pg: &PgPool, node: Uuid, s: &Sample) -> sqlx::Result<()> {
    sqlx::query(SAMPLE_SQL)
        .bind(node)
        .bind(s.cpu)
        .bind(s.load1)
        .bind(s.mem_used as f64)
        .bind(s.mem_total)
        .bind(s.swap_used as f64)
        .bind(s.swap_total)
        .bind(s.disk_used)
        .bind(s.disk_total)
        .bind(s.rx_bps)
        .bind(s.tx_bps)
        .bind(s.tcp as f64)
        .bind(s.udp as f64)
        .bind(s.conns)
        .bind(s.users)
        .execute(pg)
        .await?;
    Ok(())
}

/// Heartbeat hook (grpc.rs, after the Valkey write): fleet gauges and, at
/// most every MIN_SAMPLE_GAP, a history write in the background (never
/// delays the stream; skipped when WRITE_PERMITS are all busy).
pub fn on_heartbeat(state: &AppState, node: Uuid, hb: &Heartbeat) {
    let s = Sample::from_heartbeat(hb);
    if !state.nodestat().observe(node, s, Instant::now()) {
        return;
    }
    let Ok(permit) = state.nodestat().permits.clone().try_acquire_owned() else {
        tracing::debug!(node = %node, "metrics history write skipped (database busy)");
        return;
    };
    let pg = state.pg().clone();
    tokio::spawn(async move {
        if let Err(e) = write_sample(&pg, node, &s).await {
            // A node deleted meanwhile (foreign key) is not worth a warning.
            tracing::debug!(node = %node, error = %e, "metrics history write failed");
        }
        drop(permit);
    });
}

// ---------------------------------------------------------------------------
// Rollup and retention (reaper loop)
// ---------------------------------------------------------------------------

const ROLLUP_SQL: &str = "\
INSERT INTO node_metrics_1h AS h (node_id, bucket, samples, cpu_sum, cpu_max, load1_sum, \
    mem_used_sum, mem_total, swap_used_sum, swap_total, disk_used, disk_total, rx_bps_sum, \
    tx_bps_sum, rx_bps_max, tx_bps_max, tcp_sum, udp_sum, conns_sum, conns_max, users_sum, users_max) \
SELECT node_id, date_trunc('hour', bucket), sum(samples), sum(cpu_sum), max(cpu_max), sum(load1_sum), \
    sum(mem_used_sum), max(mem_total), sum(swap_used_sum), max(swap_total), max(disk_used), \
    max(disk_total), sum(rx_bps_sum), sum(tx_bps_sum), max(rx_bps_max), max(tx_bps_max), \
    sum(tcp_sum), sum(udp_sum), sum(conns_sum), max(conns_max), sum(users_sum), max(users_max) \
FROM node_metrics_1m \
WHERE bucket >= date_trunc('hour', now()) - interval '2 hours' \
GROUP BY 1, 2 ORDER BY 1, 2 \
ON CONFLICT (node_id, bucket) DO UPDATE SET \
    samples = EXCLUDED.samples, cpu_sum = EXCLUDED.cpu_sum, cpu_max = EXCLUDED.cpu_max, \
    load1_sum = EXCLUDED.load1_sum, mem_used_sum = EXCLUDED.mem_used_sum, \
    mem_total = EXCLUDED.mem_total, swap_used_sum = EXCLUDED.swap_used_sum, \
    swap_total = EXCLUDED.swap_total, disk_used = EXCLUDED.disk_used, \
    disk_total = EXCLUDED.disk_total, rx_bps_sum = EXCLUDED.rx_bps_sum, \
    tx_bps_sum = EXCLUDED.tx_bps_sum, rx_bps_max = EXCLUDED.rx_bps_max, \
    tx_bps_max = EXCLUDED.tx_bps_max, tcp_sum = EXCLUDED.tcp_sum, udp_sum = EXCLUDED.udp_sum, \
    conns_sum = EXCLUDED.conns_sum, conns_max = EXCLUDED.conns_max, \
    users_sum = EXCLUDED.users_sum, users_max = EXCLUDED.users_max";

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
        hours_written: sqlx::query(ROLLUP_SQL)
            .execute(&mut *tx)
            .await?
            .rows_affected(),
        ..Default::default()
    };
    r.minutes_pruned = prune(
        &mut tx,
        "node_metrics_1m",
        &format!("now() - interval '{MINUTE_RETENTION_HOURS} hours'"),
    )
    .await?;
    r.hours_pruned = prune(
        &mut tx,
        "node_metrics_1h",
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

/// The agent's test settings from `[probe]`; run_token = the node's latest
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

/// Store an agent's LatencyReport: replaces the node's agent results unless
/// a newer set is already stored (a re-sent old report after a newer one).
/// Agent input is bounded: <= 4 results, URLs <= 512 bytes, errors <= 200
/// characters, timestamps clamped to [now - 7 d, now].
pub async fn store_agent_latency(pg: &PgPool, node: Uuid, rep: &LatencyReport) -> sqlx::Result<()> {
    let now = Utc::now();
    let at = DateTime::<Utc>::from_timestamp(rep.measured_at_unix, 0)
        .unwrap_or(now)
        .clamp(now - chrono::Duration::days(7), now);
    let mut targets = Vec::new();
    let mut delays: Vec<Option<i32>> = Vec::new();
    let mut errors: Vec<Option<String>> = Vec::new();
    for r in rep.results.iter().take(MAX_AGENT_RESULTS) {
        if r.url.is_empty() || r.url.len() > 512 || targets.contains(&r.url) {
            continue;
        }
        targets.push(r.url.clone());
        delays.push(r.ok.then(|| i32::try_from(r.delay_ms).unwrap_or(i32::MAX)));
        errors.push((!r.ok).then(|| {
            let e = agent_text(&r.error, 200);
            if e.is_empty() {
                "failed".into()
            } else {
                e
            }
        }));
    }
    replace_latency(pg, node, "agent", at, &targets, &delays, &errors).await
}

async fn replace_latency(
    pg: &PgPool,
    node: Uuid,
    source: &str,
    at: DateTime<Utc>,
    targets: &[String],
    delays: &[Option<i32>],
    errors: &[Option<String>],
) -> sqlx::Result<()> {
    let mut tx = pg.begin().await?;
    let newest: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT max(measured_at) FROM node_latency WHERE node_id = $1 AND source = $2",
    )
    .bind(node)
    .bind(source)
    .fetch_one(&mut *tx)
    .await?;
    if newest.is_some_and(|n| n > at) {
        return Ok(());
    }
    sqlx::query("DELETE FROM node_latency WHERE node_id = $1 AND source = $2")
        .bind(node)
        .bind(source)
        .execute(&mut *tx)
        .await?;
    let ords: Vec<i16> = (0..targets.len() as i16).collect();
    let r = sqlx::query(
        "INSERT INTO node_latency (node_id, source, target, delay_ms, error, ord, measured_at) \
         SELECT $1, $2, t, d, e, o, $7 \
         FROM unnest($3::text[], $4::int[], $5::text[], $6::smallint[]) AS x(t, d, e, o) \
         WHERE EXISTS (SELECT 1 FROM nodes WHERE id = $1)",
    )
    .bind(node)
    .bind(source)
    .bind(targets)
    .bind(delays)
    .bind(errors)
    .bind(&ords)
    .bind(at)
    .execute(&mut *tx)
    .await;
    match r {
        // The node was deleted meanwhile: nothing to keep.
        Err(sqlx::Error::Database(db)) if db.is_foreign_key_violation() => return Ok(()),
        r => r?,
    };
    tx.commit().await
}

/// "立即测速" (POST /nodes/{id}/probe): record the request (the agent's
/// session sends the new run_token on its next wake — this transaction
/// notifies it — and the panel's TCP test is due at once). At most once
/// per node per `[probe].manual_cooldown_secs` (409 otherwise; DB clock,
/// so every instance agrees). Audited.
pub async fn apply_request_probe(
    conn: &mut PgConnection,
    actor: &Actor,
    node: Uuid,
    cooldown_secs: u64,
) -> Result<DateTime<Utc>, ApiError> {
    let row: Option<(DateTime<Utc>,)> = sqlx::query_as(
        "UPDATE nodes SET probe_requested_at = now(), panel_probe_next_at = NULL \
         WHERE id = $1 AND deleting_at IS NULL \
           AND (probe_requested_at IS NULL OR probe_requested_at <= now() - make_interval(secs => $2)) \
         RETURNING probe_requested_at",
    )
    .bind(node)
    .bind(cooldown_secs as f64)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((at,)) = row else {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM nodes WHERE id = $1 AND deleting_at IS NULL)",
        )
        .bind(node)
        .fetch_one(&mut *conn)
        .await?;
        return Err(if exists {
            ApiError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                "a latency test was requested moments ago",
            )
        } else {
            ApiError::not_found()
        });
    };
    // Wake the node's session wherever it is (no version change: the
    // trigger stays quiet).
    sqlx::query("SELECT pg_notify('akari_change', $1)")
        .bind(node.to_string())
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "node.probe",
        "node",
        Some(node.to_string()),
        None,
        None,
    )
    .await?;
    Ok(at)
}

/// The probe request a session should forward (`grpc::maybe_send_probe`).
pub async fn requested_at(pg: &PgPool, node: Uuid) -> sqlx::Result<Option<DateTime<Utc>>> {
    Ok(sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
        "SELECT probe_requested_at FROM nodes WHERE id = $1",
    )
    .bind(node)
    .fetch_optional(pg)
    .await?
    .flatten())
}

/// What the panel dials for one inbound: the client-facing host/port
/// (connect override, else the node address and the inbound port) and
/// whether TCP can measure it.
#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    pub tag: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub udp_only: bool,
}

/// One target per tagged inbound, in inbound order.
pub fn targets(server_addr: Option<&str>, inbounds: &Value, overrides: &Value) -> Vec<Target> {
    let mut out = Vec::new();
    for ib in inbounds.as_array().into_iter().flatten() {
        let Some(tag) = ib.get("tag").and_then(Value::as_str) else {
            continue;
        };
        let ov = crate::nodemeta::connect_for(overrides, tag);
        let host = ov
            .host
            .or_else(|| server_addr.map(str::to_string))
            .filter(|h| !h.is_empty());
        let port = ov.port.or_else(|| {
            ib.get("port")
                .and_then(Value::as_u64)
                .and_then(|p| u16::try_from(p).ok())
        });
        let (tcp, _) = crate::protocols::l4(ib);
        out.push(Target {
            tag: tag.to_string(),
            host,
            port,
            udp_only: !tcp,
        });
    }
    out
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

/// Nodes claimed per round by one instance.
const CLAIM_BATCH: i64 = 8;
const PANEL_PROBE_TICK: Duration = Duration::from_secs(15);

#[derive(sqlx::FromRow)]
struct Due {
    id: Uuid,
    server_addr: Option<String>,
    xray_inbounds: Value,
    connect_overrides: Value,
}

/// The panel's TCP test (any instance): every PANEL_PROBE_TICK claim up to
/// CLAIM_BATCH enabled nodes whose test is due (next time = now + interval
/// +-10%, set in the claiming UPDATE, so instances never test the same node
/// twice) and test their inbounds concurrently.
pub async fn panel_probe_loop(state: AppState) {
    let cfg = state.cfg().probe.clone();
    if !cfg.panel_tcp {
        return;
    }
    let timeout = Duration::from_millis(u64::from(cfg.timeout_ms));
    let mut tick = tokio::time::interval(PANEL_PROBE_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
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
        "UPDATE nodes n SET panel_probe_next_at = now() + make_interval(secs => $1 * (0.9 + 0.2 * random())) \
         WHERE n.id IN (SELECT id FROM nodes WHERE enabled AND deleting_at IS NULL \
             AND (panel_probe_next_at IS NULL OR panel_probe_next_at <= now()) \
             ORDER BY panel_probe_next_at NULLS FIRST, id LIMIT $2 FOR UPDATE SKIP LOCKED) \
         RETURNING n.id, n.server_addr, n.xray_inbounds, n.connect_overrides",
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
            let ts = targets(
                d.server_addr.as_deref(),
                &d.xray_inbounds,
                &d.connect_overrides,
            );
            let mut tags = Vec::new();
            let mut delays = Vec::new();
            let mut errors = Vec::new();
            for t in ts.iter().take(32) {
                let r = match (&t.host, t.port, t.udp_only) {
                    (_, _, true) => Err("udp".to_string()),
                    (Some(h), Some(p), false) => tcp_latency(h, p, attempts, timeout).await,
                    _ => Err("no address".to_string()),
                };
                tags.push(t.tag.clone());
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
                tracing::warn!(node = %d.id, error = %e, "failed to store panel latency");
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

/// JSON array of a node's latency rows (node alias `a`), for NodeView.
pub fn latency_json_sql(a: &str) -> String {
    format!(
        "(SELECT coalesce(jsonb_agg(jsonb_build_object(\
         'source', l.source, 'target', l.target, 'delay_ms', l.delay_ms, 'error', l.error, \
         'measured_at', l.measured_at) ORDER BY l.source, l.ord), '[]'::jsonb) \
         FROM node_latency l WHERE l.node_id = {a}.id)"
    )
}

/// GET /nodes/{id}/status (admin): the latest heartbeat (Valkey), online
/// state, latency results and traffic totals of one node.
pub async fn node_status(
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
        traffic_rate_permille: i32,
        probe_requested_at: Option<DateTime<Utc>>,
    }
    let row: Row = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT n.status, {} AS online, n.last_seen_at, {} AS latency, \
         n.traffic_raw_bytes, n.traffic_billed_bytes, n.traffic_rate_permille, n.probe_requested_at \
         FROM nodes n WHERE n.id = $1",
        online_sql("n"),
        latency_json_sql("n")
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
        "traffic_rate": f64::from(row.traffic_rate_permille) / 1000.0,
        "probe_requested_at": row.probe_requested_at,
    })))
}

async fn heartbeat(state: &AppState, id: Uuid) -> Option<Value> {
    use fred::prelude::KeysInterface;
    match state
        .valkey()
        .get::<Option<String>, _>(format!("akari:node:hb:{id}"))
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
    pub cpu: f64,
    pub cpu_max: f64,
    pub load1: f64,
    pub mem_used: f64,
    pub mem_total: i64,
    pub swap_used: f64,
    pub swap_total: i64,
    pub disk_used: i64,
    pub disk_total: i64,
    pub rx_bps: f64,
    pub tx_bps: f64,
    pub rx_bps_max: i64,
    pub tx_bps_max: i64,
    pub tcp: f64,
    pub udp: f64,
    pub conns: f64,
    pub conns_max: i64,
    pub users: f64,
    pub users_max: i64,
}

pub async fn history(pg: &PgPool, node: Uuid, spec: &RangeSpec) -> sqlx::Result<Vec<Point>> {
    let table = if spec.hourly {
        "node_metrics_1h"
    } else {
        "node_metrics_1m"
    };
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT to_timestamp(floor(extract(epoch FROM bucket) / $3) * $3) AS t, \
         sum(samples)::bigint AS samples, \
         (sum(cpu_sum) / sum(samples))::float8 AS cpu, max(cpu_max)::float8 AS cpu_max, \
         (sum(load1_sum) / sum(samples))::float8 AS load1, \
         (sum(mem_used_sum) / sum(samples))::float8 AS mem_used, max(mem_total) AS mem_total, \
         (sum(swap_used_sum) / sum(samples))::float8 AS swap_used, max(swap_total) AS swap_total, \
         max(disk_used) AS disk_used, max(disk_total) AS disk_total, \
         (sum(rx_bps_sum) / sum(samples))::float8 AS rx_bps, (sum(tx_bps_sum) / sum(samples))::float8 AS tx_bps, \
         max(rx_bps_max) AS rx_bps_max, max(tx_bps_max) AS tx_bps_max, \
         (sum(tcp_sum) / sum(samples))::float8 AS tcp, (sum(udp_sum) / sum(samples))::float8 AS udp, \
         (sum(conns_sum) / sum(samples))::float8 AS conns, max(conns_max) AS conns_max, \
         (sum(users_sum) / sum(samples))::float8 AS users, max(users_max) AS users_max \
         FROM {table} WHERE node_id = $1 AND bucket >= now() - make_interval(secs => $2) \
         GROUP BY 1 ORDER BY 1"
    )))
    .bind(node)
    .bind(spec.secs as f64)
    .bind(spec.step_secs as f64)
    .fetch_all(pg)
    .await
}

/// GET /nodes/{id}/metrics?range=1h|6h|24h|48h|7d|30d|90d (admin; default
/// 24h): averaged points (and maxima) of the node's history.
pub async fn node_metrics(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    Query(q): Query<MetricsQuery>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let range = q.range.unwrap_or_else(|| "24h".into());
    let spec = range_spec(&range).ok_or_else(|| {
        ApiError::bad_request("range must be one of 1h, 6h, 24h, 48h, 7d, 30d, 90d")
    })?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM nodes WHERE id = $1)")
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

/// POST /nodes/{id}/probe (admin): "立即测速". 202 with the request time;
/// results arrive in GET /nodes/{id}/status (agent: seconds; panel TCP:
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
        state.cfg().probe.manual_cooldown_secs,
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
    pub name: String,
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

/// GET /me/nodes (user portal): the nodes the caller can use and that are
/// shown to users — name, region, tags, multiplier, online, latency. No
/// ids, addresses, inbounds or machine metrics.
pub async fn my_nodes(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<MyNodeStatus>>, ApiError> {
    let rows = sqlx::query_as::<_, MyNodeStatus>(sqlx::AssertSqlSafe(format!(
        "SELECT coalesce(n.display_name, n.name) AS name, n.region, n.tags, \
         (n.traffic_rate_permille / 1000.0)::float8 AS rate, {} AS online, \
         l.delay_ms AS latency_ms, \
         CASE WHEN l.delay_ms IS NOT NULL THEN 'ok' WHEN lf.node_id IS NOT NULL THEN 'timeout' \
              ELSE 'unknown' END AS latency_status, \
         coalesce(l.measured_at, lf.measured_at) AS latency_measured_at \
         FROM node_users nu JOIN nodes n ON n.id = nu.node_id \
         LEFT JOIN LATERAL (SELECT delay_ms, measured_at FROM node_latency \
             WHERE node_id = n.id AND source = 'agent' AND delay_ms IS NOT NULL \
             ORDER BY ord LIMIT 1) l ON true \
         LEFT JOIN LATERAL (SELECT node_id, measured_at FROM node_latency \
             WHERE node_id = n.id AND source = 'agent' ORDER BY ord LIMIT 1) lf ON true \
         WHERE nu.user_id = $1 AND n.enabled AND n.visible AND n.deleting_at IS NULL \
         ORDER BY n.sort, coalesce(n.display_name, n.name)",
        online_sql("n")
    )))
    .bind(user.id)
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests;
