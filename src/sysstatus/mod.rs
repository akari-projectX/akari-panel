//! 系统状态 (W31): `GET /api/v1/system/status` (admin) — the panel's own
//! health at a glance: every panel instance (host CPU/memory/load/disk,
//! process RSS, version, agent sessions), PostgreSQL, Valkey, the reverse
//! proxy in front (Caddy) and the background jobs (settlement,
//! reconciliation, mail queue, alerts: last run, duration, lag, errors).
//!
//! **Multi-instance**: every instance publishes a heartbeat every
//! `BEAT_EVERY` into the Valkey hash `akari:status:instances` (field =
//! instance id, value = JSON with its host metrics and job stats; the hash
//! expires `FORGET_AFTER` after the last beat). Any instance answers the
//! endpoint from that hash, so the page shows the whole fleet; an instance
//! whose last beat is older than `ALIVE_SECS` is shown as exited. Every
//! restart or upgrade is a new instance id, so exited instances are dropped
//! as soon as a live instance on the same host replaced them, and anyway
//! after `FORGET_AFTER` (`prune`). No table (schema review §W31).
//!
//! **Cost**: the answer is built at most once per `CACHE_FOR` per instance
//! (a cached copy is served meanwhile, single flight); every check has a
//! short timeout and runs concurrently; the database checks are a handful
//! of catalog/index lookups. Nothing here touches agent paths.
//!
//! Job stats are recorded in memory by the loops themselves (`record*`,
//! no I/O on the hot path) and reach Valkey with the next heartbeat.

pub mod host;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use chrono::{DateTime, Utc};
use fred::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

const INSTANCES_KEY: &str = "akari:status:instances";
/// Heartbeat cadence.
pub const BEAT_EVERY: Duration = Duration::from_secs(10);
/// A heartbeat older than this = instance offline.
pub const ALIVE_SECS: i64 = 30;
/// Exited instances are listed this long (unless replaced sooner by a live
/// instance on the same host), then forgotten.
const FORGET_AFTER: i64 = 10 * 60;
/// The status answer is reused this long.
pub const CACHE_FOR: Duration = Duration::from_secs(5);
/// Timeout of each check (database, Valkey, proxy).
const CHECK_TIMEOUT: Duration = Duration::from_secs(3);

/// A tracked background job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Job {
    /// Traffic flush + billing + limit enforcement (every 5 s, every instance).
    Settlement,
    /// Payment order reconciliation (every 10 s, every instance).
    Reconciliation,
    /// Mail outbox sender (every 2 s, every instance).
    Mail,
    /// Alert evaluation (every 30 s, one instance wins the round) + delivery.
    Alerts,
}

impl Job {
    pub const ALL: [Job; 4] = [Job::Settlement, Job::Reconciliation, Job::Mail, Job::Alerts];

    /// Normal period; a job without a success for 6 periods is `stale`.
    fn period_secs(self) -> i64 {
        match self {
            Job::Settlement => 5,
            Job::Reconciliation => 10,
            Job::Mail => 2,
            Job::Alerts => 30,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Ok,
    /// Nothing to do on this instance (mail disabled, another instance
    /// evaluated the alerts).
    Skipped,
    Error,
}

/// One job's stats on one instance.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct JobStat {
    pub runs: u64,
    pub failures: u64,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_duration_ms: Option<u64>,
    pub last_outcome: Option<Outcome>,
    pub last_ok_at: Option<DateTime<Utc>>,
    pub last_error_at: Option<DateTime<Utc>>,
    /// The last error (≤300 characters, addresses redacted).
    pub last_error: Option<String>,
}

/// This instance's identity, sampler, job stats and status cache.
pub struct Local {
    pub id: Uuid,
    pub started_at: DateTime<Utc>,
    sampler: host::Sampler,
    jobs: Mutex<HashMap<Job, JobStat>>,
    cache: tokio::sync::Mutex<Option<(Instant, serde_json::Value)>>,
}

impl Default for Local {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4(),
            started_at: Utc::now(),
            sampler: host::Sampler::default(),
            jobs: Mutex::new(HashMap::new()),
            cache: tokio::sync::Mutex::new(None),
        }
    }
}

/// Error text safe to publish: one line, ≤300 characters, no addresses.
fn clean_error(e: &str) -> String {
    crate::mail::sender::redact_addresses(&crate::mail::diagnose::clip(e))
}

impl Local {
    /// Record one run of `job` that started at `started`.
    pub fn record(&self, job: Job, started: Instant, outcome: Outcome, error: Option<&str>) {
        let now = Utc::now();
        let Ok(mut jobs) = self.jobs.lock() else {
            return;
        };
        let s = jobs.entry(job).or_default();
        s.runs = s.runs.saturating_add(1);
        s.last_run_at = Some(now);
        s.last_duration_ms = Some(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX));
        s.last_outcome = Some(outcome);
        match outcome {
            Outcome::Ok => s.last_ok_at = Some(now),
            Outcome::Skipped => {}
            Outcome::Error => {
                s.failures = s.failures.saturating_add(1);
                s.last_error_at = Some(now);
                s.last_error = error.map(clean_error);
            }
        }
    }

    /// Record a run from its result (Ok = ok, Err = error with its text).
    pub fn record_result<T, E: std::fmt::Display>(
        &self,
        job: Job,
        started: Instant,
        res: &Result<T, E>,
    ) {
        match res {
            Ok(_) => self.record(job, started, Outcome::Ok, None),
            Err(e) => self.record(job, started, Outcome::Error, Some(&e.to_string())),
        }
    }

    fn jobs(&self) -> HashMap<Job, JobStat> {
        self.jobs.lock().map(|j| j.clone()).unwrap_or_default()
    }
}

/// One instance's heartbeat (the JSON in the Valkey hash).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Beat {
    pub id: Uuid,
    pub version: String,
    pub git_sha: String,
    pub started_at: DateTime<Utc>,
    pub beat_at: DateTime<Utc>,
    pub host: host::Host,
    /// Agent streams held by this instance.
    pub agent_sessions: usize,
    /// Database pool: open / idle connections.
    pub db_pool_size: u32,
    pub db_pool_idle: usize,
    pub jobs: HashMap<Job, JobStat>,
}

fn beat(state: &AppState) -> Beat {
    let l = state.sysstatus();
    Beat {
        id: l.id,
        version: crate::metrics::VERSION.to_string(),
        git_sha: crate::metrics::GIT_SHA.to_string(),
        started_at: l.started_at,
        beat_at: Utc::now(),
        host: l.sampler.sample(&state.cfg().data_dir),
        agent_sessions: state.live_sessions(),
        db_pool_size: state.pg().size(),
        db_pool_idle: state.pg().num_idle(),
        jobs: l.jobs(),
    }
}

/// Publish this instance's heartbeat (best effort, logged).
pub async fn publish(state: &AppState) {
    let b = beat(state);
    let Ok(json) = serde_json::to_string(&b) else {
        return;
    };
    let pipeline = state.valkey().next().pipeline();
    let res: Result<(), fred::error::Error> = async {
        let () = pipeline
            .hset(INSTANCES_KEY, (b.id.to_string(), json))
            .await?;
        let () = pipeline.expire(INSTANCES_KEY, FORGET_AFTER, None).await?;
        pipeline.all::<()>().await
    }
    .await;
    if let Err(e) = res {
        tracing::warn!(error = %e, "status heartbeat write failed");
    }
}

/// The heartbeat loop (every instance). Never returns.
pub async fn heartbeat_loop(state: AppState) {
    let mut tick = tokio::time::interval(BEAT_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        publish(&state).await;
    }
}

/// Split heartbeats into those to list and the ids to forget: unreadable
/// ones, those past `FORGET_AFTER`, and exited ones replaced by a live
/// instance on the same host that started after them (a restart or an
/// upgrade gets a new id; the old one must not linger as "lost" with
/// stale numbers).
pub fn prune(all: Vec<(String, String)>, now: DateTime<Utc>) -> (Vec<Beat>, Vec<String>) {
    let mut beats = Vec::new();
    let mut forget = Vec::new();
    for (field, v) in all {
        match serde_json::from_str::<Beat>(&v) {
            Ok(b) if (now - b.beat_at).num_seconds() <= FORGET_AFTER => beats.push(b),
            _ => forget.push(field),
        }
    }
    let alive = |b: &Beat| (now - b.beat_at).num_seconds() <= ALIVE_SECS;
    let replaced: Vec<Uuid> = beats
        .iter()
        .filter(|old| {
            !alive(old)
                && old.host.hostname.is_some()
                && beats.iter().any(|new| {
                    alive(new)
                        && new.id != old.id
                        && new.host.hostname == old.host.hostname
                        && new.started_at >= old.started_at
                })
        })
        .map(|b| b.id)
        .collect();
    beats.retain(|b| {
        let gone = replaced.contains(&b.id);
        if gone {
            forget.push(b.id.to_string());
        }
        !gone
    });
    beats.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.id.cmp(&b.id)));
    (beats, forget)
}

/// Every instance heartbeat worth listing (forgetting the rest, `prune`).
async fn instances(state: &AppState) -> Result<Vec<Beat>, String> {
    let all: HashMap<String, String> =
        tokio::time::timeout(CHECK_TIMEOUT, state.valkey().hgetall(INSTANCES_KEY))
            .await
            .map_err(|_| "timed out".to_string())?
            .map_err(|e| e.to_string())?;
    let (beats, forget) = prune(all.into_iter().collect(), Utc::now());
    if !forget.is_empty()
        && let Err(e) = state.valkey().hdel::<(), _, _>(INSTANCES_KEY, forget).await
    {
        tracing::warn!(error = %e, "status: forgetting old instances failed");
    }
    Ok(beats)
}

#[derive(Debug, Serialize)]
pub struct InstanceView {
    pub id: Uuid,
    /// The instance answering this request.
    pub this: bool,
    pub alive: bool,
    pub version: String,
    pub git_sha: String,
    pub started_at: DateTime<Utc>,
    pub beat_at: DateTime<Utc>,
    pub host: host::Host,
    pub agent_sessions: usize,
    pub db_pool_size: u32,
    pub db_pool_idle: usize,
}

#[derive(Debug, Serialize, Default)]
pub struct PostgresView {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub version: Option<String>,
    pub in_recovery: Option<bool>,
    pub connections: Option<i64>,
    pub max_connections: Option<i64>,
    pub database_bytes: Option<i64>,
    pub error: Option<String>,
}

#[derive(sqlx::FromRow)]
struct PgFacts {
    version: String,
    in_recovery: bool,
    connections: i64,
    max_connections: i64,
    database_bytes: i64,
}

async fn postgres(state: &AppState) -> PostgresView {
    let t = Instant::now();
    let q = sqlx::query_as::<_, PgFacts>(
        "SELECT current_setting('server_version') AS version, pg_is_in_recovery() AS in_recovery, \
         (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS connections, \
         current_setting('max_connections')::bigint AS max_connections, \
         pg_database_size(current_database()) AS database_bytes",
    )
    .fetch_one(state.pg());
    match tokio::time::timeout(CHECK_TIMEOUT, q).await {
        Ok(Ok(f)) => PostgresView {
            ok: true,
            latency_ms: Some(ms(t)),
            version: Some(f.version),
            in_recovery: Some(f.in_recovery),
            connections: Some(f.connections),
            max_connections: Some(f.max_connections),
            database_bytes: Some(f.database_bytes),
            error: None,
        },
        Ok(Err(e)) => PostgresView {
            error: Some(clean_error(&e.to_string())),
            ..Default::default()
        },
        Err(_) => PostgresView {
            error: Some("timed out".into()),
            ..Default::default()
        },
    }
}

#[derive(Debug, Serialize, Default)]
pub struct ValkeyView {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub version: Option<String>,
    pub used_memory_bytes: Option<u64>,
    pub max_memory_bytes: Option<u64>,
    pub connected_clients: Option<u64>,
    pub uptime_secs: Option<u64>,
    pub error: Option<String>,
}

/// `INFO` text → field value.
fn info_field<'a>(info: &'a str, name: &str) -> Option<&'a str> {
    info.lines().find_map(|l| {
        l.strip_prefix(name)
            .and_then(|r| r.strip_prefix(':'))
            .map(str::trim)
    })
}

/// The Valkey/Redis server version from `INFO` (Valkey reports both).
pub fn info_view(info: &str) -> ValkeyView {
    let num = |n| info_field(info, n).and_then(|v| v.parse::<u64>().ok());
    ValkeyView {
        ok: true,
        latency_ms: None,
        version: info_field(info, "valkey_version")
            .or_else(|| info_field(info, "redis_version"))
            .map(String::from),
        used_memory_bytes: num("used_memory"),
        max_memory_bytes: num("maxmemory").filter(|m| *m > 0),
        connected_clients: num("connected_clients"),
        uptime_secs: num("uptime_in_seconds"),
        error: None,
    }
}

async fn valkey(state: &AppState) -> ValkeyView {
    let t = Instant::now();
    let client = state.valkey().next();
    let res = tokio::time::timeout(CHECK_TIMEOUT, async {
        let () = client.ping::<()>(None).await?;
        let latency = ms(t);
        let info: String = client.info(None).await?;
        Ok::<_, fred::error::Error>((latency, info))
    })
    .await;
    match res {
        Ok(Ok((latency, info))) => ValkeyView {
            latency_ms: Some(latency),
            ..info_view(&info)
        },
        Ok(Err(e)) => ValkeyView {
            error: Some(clean_error(&e.to_string())),
            ..Default::default()
        },
        Err(_) => ValkeyView {
            error: Some("timed out".into()),
            ..Default::default()
        },
    }
}

#[derive(Debug, Serialize, Default)]
pub struct ProxyView {
    /// A main domain is set (系统设置); without one there is nothing to probe.
    pub configured: bool,
    pub ok: bool,
    /// The main domain's host (never a path: the prefix is secret).
    pub host: Option<String>,
    pub latency_ms: Option<u64>,
    /// The HTTP status of `HEAD /` (any answer = the proxy is up).
    pub http_status: Option<u16>,
    pub cert_expires_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
}

/// Probe the reverse proxy (Caddy) through the main domain: TCP, TLS (the
/// served certificate's expiry) and one `HEAD /` request.
async fn proxy(state: &AppState) -> ProxyView {
    let Some(origin) = state.settings().get().public_origin() else {
        return ProxyView::default();
    };
    let Ok(uri) = origin.parse::<hyper::Uri>() else {
        return ProxyView {
            configured: true,
            error: Some("invalid main domain".into()),
            ..Default::default()
        };
    };
    let host = uri
        .host()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let tls = uri.scheme_str() != Some("http");
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let t = Instant::now();
    let res = tokio::time::timeout(CHECK_TIMEOUT, probe(&host, port, tls)).await;
    let mut v = ProxyView {
        configured: true,
        host: Some(host),
        ..Default::default()
    };
    match res {
        Ok(Ok((status, expires))) => {
            v.ok = true;
            v.latency_ms = Some(ms(t));
            v.http_status = Some(status);
            v.cert_expires_at = expires;
        }
        Ok(Err(e)) => v.error = Some(clean_error(&e)),
        Err(_) => v.error = Some("timed out".into()),
    }
    v
}

/// `HEAD /` → (status, certificate not-after).
async fn probe(host: &str, port: u16, tls: bool) -> Result<(u16, Option<DateTime<Utc>>), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let tcp = tokio::net::TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("connect: {}", e.kind()))?;
    let req = format!(
        "HEAD / HTTP/1.1\r\nHost: {host}\r\nUser-Agent: akari-panel\r\nConnection: close\r\n\r\n"
    );
    let mut buf = vec![0u8; 512];
    let (n, expires) = if tls {
        let name = rustls::pki_types::ServerName::try_from(host.to_string())
            .map_err(|_| "invalid host name".to_string())?;
        let mut s = tokio_rustls::TlsConnector::from(crate::billing::http::tls_config()?)
            .connect(name, tcp)
            .await
            .map_err(|e| format!("tls: {e}"))?;
        let expires = s
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|c| c.first())
            .and_then(|c| x509_parser::parse_x509_certificate(c.as_ref()).ok())
            .and_then(|(_, c)| DateTime::from_timestamp(c.validity().not_after.timestamp(), 0));
        s.write_all(req.as_bytes())
            .await
            .map_err(|e| format!("write: {}", e.kind()))?;
        let n = s
            .read(&mut buf)
            .await
            .map_err(|e| format!("read: {}", e.kind()))?;
        (n, expires)
    } else {
        let mut s = tcp;
        s.write_all(req.as_bytes())
            .await
            .map_err(|e| format!("write: {}", e.kind()))?;
        let n = s
            .read(&mut buf)
            .await
            .map_err(|e| format!("read: {}", e.kind()))?;
        (n, None)
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    let status = head
        .strip_prefix("HTTP/1.")
        .and_then(|r| r.get(2..5))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| "not an HTTP answer".to_string())?;
    Ok((status, expires))
}

#[derive(Debug, Serialize)]
pub struct JobView {
    pub job: Job,
    /// Latest run on any instance.
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_ok_at: Option<DateTime<Utc>>,
    /// Seconds since the latest success on any live instance (None = never).
    pub lag_secs: Option<i64>,
    /// No success for 6 normal periods.
    pub stale: bool,
    pub last_error: Option<String>,
    pub last_error_at: Option<DateTime<Utc>>,
    /// Job-specific backlog (mail queue, pending orders, alert deliveries).
    pub backlog: serde_json::Value,
    pub instances: Vec<JobInstance>,
}

#[derive(Debug, Serialize)]
pub struct JobInstance {
    pub instance: Uuid,
    #[serde(flatten)]
    pub stat: JobStat,
}

/// Pure aggregation of the per-instance stats of `job`.
pub fn job_view(
    job: Job,
    beats: &[Beat],
    now: DateTime<Utc>,
    backlog: serde_json::Value,
) -> JobView {
    let live: Vec<&Beat> = beats
        .iter()
        .filter(|b| (now - b.beat_at).num_seconds() <= ALIVE_SECS)
        .collect();
    let stats: Vec<(Uuid, &JobStat)> = live
        .iter()
        .filter_map(|b| b.jobs.get(&job).map(|s| (b.id, s)))
        .collect();
    let last_run_at = stats.iter().filter_map(|(_, s)| s.last_run_at).max();
    let last_ok_at = stats.iter().filter_map(|(_, s)| s.last_ok_at).max();
    let latest_error = stats
        .iter()
        .filter(|(_, s)| s.last_error_at.is_some())
        .max_by_key(|(_, s)| s.last_error_at);
    let lag_secs = last_ok_at.map(|t| (now - t).num_seconds().max(0));
    let stale = !live.is_empty() && lag_secs.is_none_or(|l| l > job.period_secs() * 6);
    JobView {
        job,
        last_run_at,
        last_ok_at,
        lag_secs,
        stale,
        last_error: latest_error.and_then(|(_, s)| s.last_error.clone()),
        last_error_at: latest_error.and_then(|(_, s)| s.last_error_at),
        backlog,
        instances: stats
            .into_iter()
            .map(|(instance, s)| JobInstance {
                instance,
                stat: s.clone(),
            })
            .collect(),
    }
}

#[derive(sqlx::FromRow)]
struct Backlog {
    mail_pending: i64,
    mail_due: i64,
    mail_oldest_due_secs: Option<i64>,
    mail_dead: i64,
    orders_pending: i64,
    alert_deliveries_pending: i64,
}

/// Queue depths (index-backed counts).
async fn backlog(state: &AppState) -> Option<Backlog> {
    let q = sqlx::query_as::<_, Backlog>(
        "SELECT \
           (SELECT count(*) FROM mail_outbox WHERE status = 'pending') AS mail_pending, \
           (SELECT count(*) FROM mail_outbox WHERE status = 'pending' AND next_attempt_at <= now()) AS mail_due, \
           (SELECT floor(extract(epoch FROM now() - min(next_attempt_at)))::bigint FROM mail_outbox \
             WHERE status = 'pending' AND next_attempt_at <= now()) AS mail_oldest_due_secs, \
           (SELECT count(*) FROM mail_outbox WHERE status = 'dead') AS mail_dead, \
           (SELECT count(*) FROM orders WHERE status = 'pending') AS orders_pending, \
           (SELECT count(*) FROM alert_notifications WHERE status = 'pending') AS alert_deliveries_pending",
    )
    .fetch_one(state.pg());
    match tokio::time::timeout(CHECK_TIMEOUT, q).await {
        Ok(Ok(b)) => Some(b),
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "status: backlog query failed");
            None
        }
        Err(_) => None,
    }
}

fn ms(t: Instant) -> u64 {
    u64::try_from(t.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[derive(Debug, Serialize)]
pub struct StatusView {
    pub generated_at: DateTime<Utc>,
    /// The instance that built this answer.
    pub instance: Uuid,
    pub instances: Vec<InstanceView>,
    /// Valkey could not be read: `instances`/`jobs` cover this instance only.
    pub instances_error: Option<String>,
    pub postgres: PostgresView,
    pub valkey: ValkeyView,
    pub caddy: ProxyView,
    pub jobs: Vec<JobView>,
}

async fn build(state: &AppState) -> StatusView {
    publish(state).await;
    let (beats, postgres, valkey, caddy, backlog) = tokio::join!(
        instances(state),
        postgres(state),
        valkey(state),
        proxy(state),
        backlog(state),
    );
    let (beats, instances_error) = match beats {
        Ok(b) if b.iter().any(|x| x.id == state.sysstatus().id) => (b, None),
        Ok(mut b) => {
            b.push(beat(state));
            (b, None)
        }
        Err(e) => (vec![beat(state)], Some(clean_error(&e))),
    };
    let now = Utc::now();
    let this = state.sysstatus().id;
    let jobs = Job::ALL
        .into_iter()
        .map(|j| {
            let b = match (&backlog, j) {
                (Some(b), Job::Mail) => serde_json::json!({
                    "pending": b.mail_pending, "due": b.mail_due,
                    "oldest_due_secs": b.mail_oldest_due_secs, "dead": b.mail_dead,
                }),
                (Some(b), Job::Reconciliation) => {
                    serde_json::json!({ "pending_orders": b.orders_pending })
                }
                (Some(b), Job::Alerts) => {
                    serde_json::json!({ "pending_deliveries": b.alert_deliveries_pending })
                }
                _ => serde_json::Value::Null,
            };
            job_view(j, &beats, now, b)
        })
        .collect();
    StatusView {
        generated_at: now,
        instance: this,
        instances: beats
            .into_iter()
            .map(|b| InstanceView {
                this: b.id == this,
                alive: (now - b.beat_at).num_seconds() <= ALIVE_SECS,
                id: b.id,
                version: b.version,
                git_sha: b.git_sha,
                started_at: b.started_at,
                beat_at: b.beat_at,
                host: b.host,
                agent_sessions: b.agent_sessions,
                db_pool_size: b.db_pool_size,
                db_pool_idle: b.db_pool_idle,
            })
            .collect(),
        instances_error,
        postgres,
        valkey,
        caddy,
        jobs,
    }
}

/// GET /api/v1/system/status (admin). Built at most once per `CACHE_FOR`
/// per instance (concurrent requests wait for the one build).
pub async fn get_status(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let mut cache = state.sysstatus().cache.lock().await;
    if let Some((at, v)) = cache.as_ref()
        && at.elapsed() < CACHE_FOR
    {
        return Ok(Json(v.clone()));
    }
    let v = serde_json::to_value(build(&state).await).map_err(anyhow::Error::from)?;
    *cache = Some((Instant::now(), v.clone()));
    Ok(Json(v))
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new().route(
        "/{prefix}/api/v1/system/status",
        axum::routing::get(get_status),
    )
}

#[cfg(test)]
mod tests;
