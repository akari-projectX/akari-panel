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

use axum::extract::{MatchedPath, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
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
    http_seconds: HistogramVec,
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
            login_attempts: cv(
                "akari_login_attempts_total",
                "Login attempts by rate-limit outcome (allowed, limited)",
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
        m.registry.register(Box::new(m.http_seconds.clone()))?;
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

/// An agent ack arrived (`ack.reason` is the proto enum value).
pub fn ack(reason: crate::gen::ack::Reason) {
    use crate::gen::ack::Reason;
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

pub fn login_attempt(allowed: bool) {
    if let Some(m) = m() {
        m.login_attempts
            .with_label_values(&[if allowed { "allowed" } else { "limited" }])
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
        ] {
            assert!(text.contains(name), "missing {name}\n{text}");
        }
        assert!(text.contains(&format!("git_sha=\"{GIT_SHA}\"")));
    }

    #[test]
    fn hooks_are_noops_before_init() {
        // Must not panic whether or not another test initialised METRICS.
        sync_sent("snapshot");
        ack(crate::gen::ack::Reason::Ok);
        flush_done(Duration::from_millis(1), false);
        billed(-5);
        enforcement_pass("limits", true);
        login_attempt(false);
    }

    #[test]
    fn http_labels_are_templates() {
        // Method labels are a closed set.
        assert_eq!(method_label(&axum::http::Method::GET), "GET");
        let weird = axum::http::Method::from_bytes(b"BREW").expect("method");
        assert_eq!(method_label(&weird), "OTHER");
    }
}
