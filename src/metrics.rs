//! Prometheus metrics (M1-4) on a SEPARATE listener (`metrics.bind`).
//!
//! The public web port never serves metrics: a `/metrics` route there would
//! be an unauthenticated, prefix-less 200 and break the rejection identity.
//!
//! Collectors live in a process-wide `OnceLock` set by `init()` at startup.
//! Hooks in the hot paths are free functions that do nothing until then (and
//! in unit tests), so instrumented code never needs a handle and can never
//! fail because of metrics. Labels are bounded enums or route *templates*
//! (`/{prefix}/api/v1/users/{id}`): the secret prefix and ids never appear.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{MatchedPath, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use prometheus::{
    Encoder, Histogram, HistogramOpts, HistogramVec, IntCounter, IntCounterVec, IntGauge,
    IntGaugeVec, Opts, Registry, TextEncoder,
};

use crate::state::AppState;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GIT_SHA: &str = env!("AKARI_GIT_SHA");

struct Metrics {
    registry: Registry,
    agents_connected: IntGauge,
    sessions: IntGaugeVec,
    syncs_sent: IntCounterVec,
    acks: IntCounterVec,
    flush_seconds: Histogram,
    flush_failures: IntCounter,
    billed_bytes: IntCounter,
    enforcement: IntCounterVec,
    listener_connects: IntCounter,
    listener_connected: IntGauge,
    queue_usage: prometheus::Gauge,
    login_attempts: IntCounterVec,
    mail: IntCounterVec,
    enrollments: IntCounterVec,
    http_seconds: HistogramVec,
    retention: IntCounterVec,
    fleet: IntGaugeVec,
    fleet_cpu_max: prometheus::Gauge,
    alerts_firing: IntGaugeVec,
    alert_notifications: IntCounterVec,
    alert_rounds: IntCounterVec,
    sync_bytes: HistogramVec,
    handshakes_dropped: IntCounter,
    local_limits: IntCounterVec,
    bot_traps: IntCounterVec,
    turnstile_verify: IntCounterVec,
}

static METRICS: OnceLock<Metrics> = OnceLock::new();

impl Metrics {
    fn new() -> prometheus::Result<Self> {
        let registry = Registry::new();
        let g = |name: &str, help: &str| IntGauge::with_opts(Opts::new(name, help));
        let c = |name: &str, help: &str| IntCounter::with_opts(Opts::new(name, help));
        let cv = |name: &str, help: &str, l: &[&str]| IntCounterVec::new(Opts::new(name, help), l);
        let m = Self {
            agents_connected: g(
                "akari_agents_connected",
                "Agents with a live stream on this instance",
            )?,
            sessions: IntGaugeVec::new(
                Opts::new(
                    "akari_agent_sessions",
                    "Agent session tasks on this instance by state (active = registered, \
                     closing = superseded/retiring/cleaning up)",
                ),
                &["state"],
            )?,
            syncs_sent: cv(
                "akari_sync_sent_total",
                "Desired-state messages sent to agents by kind (snapshot, delta, empty_snapshot)",
                &["kind"],
            )?,
            acks: cv(
                "akari_acks_total",
                "Agent acks by reason (ok, base_mismatch, apply_failed, unspecified)",
                &["reason"],
            )?,
            flush_seconds: Histogram::with_opts(
                HistogramOpts::new(
                    "akari_traffic_flush_duration_seconds",
                    "Duration of full traffic flushes (buffer to PostgreSQL)",
                )
                .buckets(vec![
                    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
                ]),
            )?,
            flush_failures: c(
                "akari_traffic_flush_failures_total",
                "Full traffic flushes that failed (retried next tick)",
            )?,
            billed_bytes: c(
                "akari_billed_bytes_total",
                "Bytes added to users' usage by traffic flushes",
            )?,
            enforcement: cv(
                "akari_enforcement_passes_total",
                "Limit/expiry enforcement passes by pass and result",
                &["pass", "result"],
            )?,
            listener_connects: c(
                "akari_notify_listener_connects_total",
                "LISTEN connections established (reconnects = this minus 1)",
            )?,
            listener_connected: g(
                "akari_notify_listener_connected",
                "1 while the change listener is connected",
            )?,
            queue_usage: prometheus::Gauge::with_opts(Opts::new(
                "akari_notify_queue_usage_ratio",
                "pg_notification_queue_usage() (0..1)",
            ))?,
            bot_traps: cv(
                "akari_bot_trap_total",
                "Public form submissions refused by the honeypot / minimum submit time \
                 (answered like an ordinary failure), by form and reason",
                &["form", "reason"],
            )?,
            turnstile_verify: cv(
                "akari_turnstile_verify_total",
                "Turnstile checks of the public forms by result (ok, no_token, rejected = the \
                 visitor's; misconfigured = the site's secret or request, see the ERROR log; \
                 unavailable = Cloudflare unreachable or failing)",
                &["result"],
            )?,
            login_attempts: cv(
                "akari_login_attempts_total",
                "Login attempts by rate-limit outcome (allowed, limited)",
                &["result"],
            )?,
            mail: cv(
                "akari_mail_deliveries_total",
                "Outbox delivery attempts by mail kind and result (sent, failed)",
                &["kind", "result"],
            )?,
            enrollments: cv(
                "akari_agent_enrollments_total",
                "Agent enrollment / renewal RPC outcomes (ok, refused, bad_csr, rate_limited, \
                 renewed)",
                &["result"],
            )?,
            http_seconds: HistogramVec::new(
                HistogramOpts::new(
                    "akari_http_request_duration_seconds",
                    "Web request latency by method, route template and status",
                )
                .buckets(vec![
                    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
                ]),
                &["method", "route", "status"],
            )?,
            retention: cv(
                "akari_traffic_retention_total",
                "traffic_counters retention: sessions retired (kind=session_retired) and rows \
                 deleted by reason (kind=rows_retired_session, rows_deleted_node)",
                &["kind"],
            )?,
            // W11: fleet aggregates over the nodes whose stream this
            // instance holds (sum the series over instances); no per-node
            // labels (node ids/names would be unbounded label values).
            fleet: IntGaugeVec::new(
                Opts::new(
                    "akari_fleet",
                    "W11 heartbeat aggregates over nodes connected to this instance (fresh within \
                     60 s): kind=nodes_reporting, online_users, connections, rx_bytes_per_second, \
                     tx_bytes_per_second",
                ),
                &["kind"],
            )?,
            fleet_cpu_max: prometheus::Gauge::with_opts(Opts::new(
                "akari_fleet_cpu_percent_max",
                "W11 highest CPU % among nodes connected to this instance",
            ))?,
            // W17: node alerts (bounded labels: kinds, channels, results).
            alerts_firing: IntGaugeVec::new(
                Opts::new(
                    "akari_node_alerts_firing",
                    "W17 node alerts firing now, by kind (read from the database at scrape: \
                     every instance reports the same value; aggregate with max)",
                ),
                &["kind"],
            )?,
            alert_notifications: cv(
                "akari_alert_notifications_total",
                "W17 alert notification deliveries by this instance (result=sent|retry|dead)",
                &["channel", "result"],
            )?,
            alert_rounds: cv(
                "akari_alert_rounds_total",
                "W17 alert evaluation rounds on this instance (result=leader|skipped|error)",
                &["result"],
            )?,
            // Review 2026-10-02 C3: encoded size of desired-state messages
            // against the gRPC message limit (grpc::MAX_MESSAGE_BYTES).
            sync_bytes: HistogramVec::new(
                HistogramOpts::new(
                    "akari_sync_message_bytes",
                    "Encoded size of desired-state messages sent to agents by kind (snapshot, \
                     delta); the gRPC message limit is 64 MiB",
                )
                .buckets(prometheus::exponential_buckets(1024.0, 4.0, 10)?),
                &["kind"],
            )?,
            // C4: TCP connections dropped because MAX_HANDSHAKES were in progress.
            handshakes_dropped: c(
                "akari_grpc_handshakes_dropped_total",
                "gRPC connections dropped before the TLS handshake because the in-progress \
                 handshake limit was reached",
            )?,
            // W9: decisions made by the in-process fallback limiter while
            // Valkey was unreachable (limiter=enroll|sub, result=allowed|limited).
            local_limits: cv(
                "akari_rate_limit_local_fallback_total",
                "Rate-limit decisions taken by the in-process fallback while Valkey was \
                 unavailable, by limiter (enroll, sub) and result (allowed, limited)",
                &["limiter", "result"],
            )?,
            registry,
        };
        let build = IntGaugeVec::new(
            Opts::new("akari_build_info", "Build information (value is always 1)"),
            &["version", "git_sha"],
        )?;
        build.with_label_values(&[VERSION, GIT_SHA]).set(1);
        m.registry.register(Box::new(build))?;
        m.registry.register(Box::new(m.agents_connected.clone()))?;
        m.registry.register(Box::new(m.sessions.clone()))?;
        m.registry.register(Box::new(m.syncs_sent.clone()))?;
        m.registry.register(Box::new(m.acks.clone()))?;
        m.registry.register(Box::new(m.flush_seconds.clone()))?;
        m.registry.register(Box::new(m.flush_failures.clone()))?;
        m.registry.register(Box::new(m.billed_bytes.clone()))?;
        m.registry.register(Box::new(m.enforcement.clone()))?;
        m.registry.register(Box::new(m.listener_connects.clone()))?;
        m.registry
            .register(Box::new(m.listener_connected.clone()))?;
        m.registry.register(Box::new(m.queue_usage.clone()))?;
        m.registry.register(Box::new(m.login_attempts.clone()))?;
        m.registry.register(Box::new(m.mail.clone()))?;
        m.registry.register(Box::new(m.enrollments.clone()))?;
        m.registry.register(Box::new(m.http_seconds.clone()))?;
        m.registry.register(Box::new(m.retention.clone()))?;
        m.registry.register(Box::new(m.fleet.clone()))?;
        m.registry.register(Box::new(m.fleet_cpu_max.clone()))?;
        m.registry.register(Box::new(m.alerts_firing.clone()))?;
        m.registry
            .register(Box::new(m.alert_notifications.clone()))?;
        m.registry.register(Box::new(m.alert_rounds.clone()))?;
        m.registry.register(Box::new(m.sync_bytes.clone()))?;
        m.registry
            .register(Box::new(m.handshakes_dropped.clone()))?;
        m.registry.register(Box::new(m.local_limits.clone()))?;
        m.registry.register(Box::new(m.bot_traps.clone()))?;
        for f in crate::botguard::FORMS {
            for r in crate::botguard::TRAP_REASONS {
                m.bot_traps.with_label_values(&[f, r]);
            }
        }
        m.registry.register(Box::new(m.turnstile_verify.clone()))?;
        for r in crate::botguard::Outcome::LABELS {
            m.turnstile_verify.with_label_values(&[r]);
        }
        for l in ["enroll", "sub"] {
            for r in ["allowed", "limited"] {
                m.local_limits.with_label_values(&[l, r]);
            }
        }
        for k in crate::alerts::KINDS {
            m.alerts_firing.with_label_values(&[k]);
        }
        for c in ["telegram", "webhook", "email"] {
            for r in ["sent", "retry", "dead"] {
                m.alert_notifications.with_label_values(&[c, r]);
            }
        }
        for r in ["leader", "skipped", "error"] {
            m.alert_rounds.with_label_values(&[r]);
        }
        for k in FLEET_KINDS {
            m.fleet.with_label_values(&[k]);
        }
        // Series that should read 0, not "absent", before the first event.
        for k in ["snapshot", "delta", "empty_snapshot"] {
            m.syncs_sent.with_label_values(&[k]);
        }
        for r in ["ok", "base_mismatch", "apply_failed", "unspecified"] {
            m.acks.with_label_values(&[r]);
        }
        for r in ["allowed", "limited"] {
            m.login_attempts.with_label_values(&[r]);
        }
        for r in ENROLL_RESULTS {
            m.enrollments.with_label_values(&[r]);
        }
        for s in ["active", "closing"] {
            m.sessions.with_label_values(&[s]);
        }
        Ok(m)
    }
}

/// Create the collectors (startup; idempotent).
pub fn init() -> anyhow::Result<()> {
    if METRICS.get().is_none() {
        let m = Metrics::new()?;
        // A concurrent init is harmless: the first one wins.
        let _ = METRICS.set(m);
    }
    Ok(())
}

const FLEET_KINDS: [&str; 5] = [
    "nodes_reporting",
    "online_users",
    "connections",
    "rx_bytes_per_second",
    "tx_bytes_per_second",
];

fn m() -> Option<&'static Metrics> {
    METRICS.get()
}

// --- hooks -----------------------------------------------------------------

/// A desired-state message was sent. `kind`: snapshot | delta | empty_snapshot.
pub fn sync_sent(kind: &'static str) {
    if let Some(m) = m() {
        m.syncs_sent.with_label_values(&[kind]).inc();
    }
}

/// Encoded size of a desired-state message (`kind`: snapshot | delta).
pub fn sync_bytes(kind: &'static str, bytes: usize) {
    if let Some(m) = m() {
        m.sync_bytes
            .with_label_values(&[kind])
            .observe(bytes as f64);
    }
}

/// A gRPC connection was dropped at the in-progress handshake limit.
pub fn handshake_dropped() {
    if let Some(m) = m() {
        m.handshakes_dropped.inc();
    }
}

/// The in-process fallback limiter decided (Valkey unavailable).
/// `limiter`: enroll | sub.
pub fn local_limit(limiter: &'static str, allowed: bool) {
    if let Some(m) = m() {
        let r = if allowed { "allowed" } else { "limited" };
        m.local_limits.with_label_values(&[limiter, r]).inc();
    }
}

const ENROLL_RESULTS: [&str; 5] = ["ok", "refused", "bad_csr", "rate_limited", "renewed"];

/// An enrollment/renewal RPC finished. `result` is one of ENROLL_RESULTS.
pub fn enroll(result: &'static str) {
    debug_assert!(ENROLL_RESULTS.contains(&result));
    if let Some(m) = m() {
        m.enrollments.with_label_values(&[result]).inc();
    }
}

/// An agent ack arrived (`ack.reason` is the proto enum value).
pub fn ack(reason: crate::pb::ack::Reason) {
    use crate::pb::ack::Reason;
    let label = match reason {
        Reason::Ok => "ok",
        Reason::BaseMismatch => "base_mismatch",
        Reason::ApplyFailed => "apply_failed",
        _ => "unspecified",
    };
    if let Some(m) = m() {
        m.acks.with_label_values(&[label]).inc();
    }
}

pub fn flush_done(took: Duration, ok: bool) {
    if let Some(m) = m() {
        m.flush_seconds.observe(took.as_secs_f64());
        if !ok {
            m.flush_failures.inc();
        }
    }
}

pub fn billed(bytes: i64) {
    if let (Some(m), Ok(b)) = (m(), u64::try_from(bytes)) {
        m.billed_bytes.inc_by(b);
    }
}

pub fn retention(kind: &'static str, n: u64) {
    if let Some(m) = m() {
        m.retention.with_label_values(&[kind]).inc_by(n);
    }
}

pub fn enforcement_pass(pass: &'static str, ok: bool) {
    if let Some(m) = m() {
        m.enforcement
            .with_label_values(&[pass, if ok { "ok" } else { "error" }])
            .inc();
    }
}

pub fn listener_connected() {
    if let Some(m) = m() {
        m.listener_connects.inc();
    }
}

pub fn queue_usage(ratio: f64) {
    if let Some(m) = m() {
        m.queue_usage.set(ratio);
    }
}

/// W17: one alert evaluation round (`leader` | `skipped` | `error`).
pub fn alert_round(result: &'static str) {
    if let Some(m) = m() {
        m.alert_rounds.with_label_values(&[result]).inc();
    }
}

/// W17: one alert notification settled (`sent` | `retry` | `dead`).
pub fn alert_notification(channel: &str, result: &'static str) {
    let channel = match channel {
        "telegram" => "telegram",
        "webhook" => "webhook",
        _ => "email",
    };
    if let Some(m) = m() {
        m.alert_notifications
            .with_label_values(&[channel, result])
            .inc();
    }
}

/// v0.4 D1: a public form submission caught by the honeypot or the
/// minimum submit time (`form`/`reason` are fixed enums).
pub fn bot_trap(form: &'static str, reason: &'static str) {
    if let Some(m) = m() {
        m.bot_traps.with_label_values(&[form, reason]).inc();
    }
}

/// A Turnstile check of a public form (`result`: `botguard::Outcome::LABELS`).
pub fn turnstile_verify(result: &'static str) {
    if let Some(m) = m() {
        m.turnstile_verify.with_label_values(&[result]).inc();
    }
}

/// The current `akari_turnstile_verify_total{result}` (tests).
#[cfg(test)]
pub fn turnstile_verify_count(result: &str) -> u64 {
    m().map_or(0, |m| m.turnstile_verify.with_label_values(&[result]).get())
}

pub fn login_attempt(allowed: bool) {
    if let Some(m) = m() {
        m.login_attempts
            .with_label_values(&[if allowed { "allowed" } else { "limited" }])
            .inc();
    }
}

/// W15: one outbox delivery attempt (`kind` is the fixed mail_outbox.kind
/// enum).
pub fn mail_sent(kind: &str, ok: bool) {
    if let Some(m) = m() {
        m.mail
            .with_label_values(&[kind, if ok { "sent" } else { "failed" }])
            .inc();
    }
}

// --- HTTP latency ----------------------------------------------------------

/// Times every web request into the latency histogram. Observation only: the
/// response is returned untouched (rejections stay byte-identical). The route
/// label is the matched template, never the concrete path (no prefix, no
/// ids); requests that match no route (every rejection) share `unmatched`.
pub async fn track_http(req: Request, next: Next) -> Response {
    let start = Instant::now();
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned());
    let method = method_label(req.method());
    let res = next.run(req).await;
    if let Some(m) = m() {
        let status = res.status().as_u16().to_string();
        m.http_seconds
            .with_label_values(&[method, route.as_deref().unwrap_or("unmatched"), &status])
            .observe(start.elapsed().as_secs_f64());
    }
    res
}

fn method_label(m: &axum::http::Method) -> &'static str {
    use axum::http::Method;
    match *m {
        Method::GET => "GET",
        Method::POST => "POST",
        Method::PUT => "PUT",
        Method::PATCH => "PATCH",
        Method::DELETE => "DELETE",
        Method::HEAD => "HEAD",
        Method::OPTIONS => "OPTIONS",
        _ => "OTHER",
    }
}

// --- exposition ------------------------------------------------------------

/// Router of the metrics listener: `GET /metrics` only.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/metrics", get(scrape))
        .with_state(state)
}

async fn scrape(State(state): State<AppState>) -> Response {
    let Some(m) = m() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let active = i64::try_from(state.agents().len()).unwrap_or(i64::MAX);
    let live = i64::try_from(state.live_sessions()).unwrap_or(i64::MAX);
    m.agents_connected.set(active);
    m.sessions.with_label_values(&["active"]).set(active);
    m.sessions
        .with_label_values(&["closing"])
        .set((live - active).max(0));
    m.listener_connected
        .set(i64::from(state.wakeups().connected()));
    let f = state.nodestat().fleet();
    for (k, v) in
        FLEET_KINDS
            .iter()
            .zip([f.nodes, f.online_users, f.connections, f.rx_bps, f.tx_bps])
    {
        m.fleet.with_label_values(&[k]).set(v);
    }
    m.fleet_cpu_max.set(f.cpu_max);
    // W17: firing alerts from the database (shared state: the same value on
    // every instance). Bounded wait; on failure the last value stays.
    if let Ok(Ok(rows)) = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        crate::alerts::firing_counts(state.pg()),
    )
    .await
    {
        for k in crate::alerts::KINDS {
            let n = rows.iter().find(|r| r.0 == k).map_or(0, |r| r.1);
            m.alerts_firing.with_label_values(&[k]).set(n);
        }
    }
    let mut buf = Vec::new();
    if let Err(e) = TextEncoder::new().encode(&m.registry.gather(), &mut buf) {
        tracing::error!(error = %e, "metrics encoding failed");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], buf).into_response()
}

/// Bind the metrics listener (startup: a bad address or a busy port is a
/// fatal, readable error) and serve until aborted.
pub async fn serve(
    state: AppState,
    bind: std::net::SocketAddr,
) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    use anyhow::Context;
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("metrics.bind {bind}: cannot listen"))?;
    tracing::info!(%bind, "metrics listener up (GET /metrics)");
    Ok(tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router(state)).await {
            tracing::error!(error = %e, "metrics server stopped");
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_builds_and_exposes_expected_families() {
        let m = Metrics::new().expect("collectors register");
        let mut buf = Vec::new();
        TextEncoder::new()
            .encode(&m.registry.gather(), &mut buf)
            .expect("encode");
        let text = String::from_utf8(buf).expect("utf8");
        for name in [
            "akari_build_info",
            "akari_agents_connected",
            "akari_agent_sessions",
            "akari_sync_sent_total",
            "akari_acks_total",
            "akari_traffic_flush_failures_total",
            "akari_billed_bytes_total",
            "akari_notify_listener_connects_total",
            "akari_notify_queue_usage_ratio",
            "akari_login_attempts_total",
            "akari_turnstile_verify_total",
            "akari_fleet",
            "akari_fleet_cpu_percent_max",
            "akari_grpc_handshakes_dropped_total",
            "akari_rate_limit_local_fallback_total",
        ] {
            assert!(text.contains(name), "missing {name}\n{text}");
        }
        assert!(text.contains(&format!("git_sha=\"{GIT_SHA}\"")));
    }

    #[test]
    fn hooks_are_noops_before_init() {
        // Must not panic whether or not another test initialised METRICS.
        sync_sent("snapshot");
        ack(crate::pb::ack::Reason::Ok);
        flush_done(Duration::from_millis(1), false);
        billed(-5);
        enforcement_pass("limits", true);
        login_attempt(false);
        turnstile_verify("ok");
    }

    #[test]
    fn http_labels_are_templates() {
        // Method labels are a closed set.
        assert_eq!(method_label(&axum::http::Method::GET), "GET");
        let weird = axum::http::Method::from_bytes(b"BREW").expect("method");
        assert_eq!(method_label(&weird), "OTHER");
    }
}
