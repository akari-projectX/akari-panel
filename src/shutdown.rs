//! Graceful shutdown (S4-3) on SIGTERM or SIGINT:
//!
//! 1. mark the instance shutting down and stop both listeners (no new web
//!    requests or agent streams);
//! 2. end every local agent stream with UNAVAILABLE ("panel shutting
//!    down"; agents reconnect with backoff) and wait, bounded, for the
//!    sessions to finish their cleanup (offline marking);
//! 3. stop the background loops, then run a final traffic flush with a
//!    deadline, so the last reports received are billed;
//! 4. give the servers a moment to finish in-flight requests, then exit.
//!
//! The whole sequence stays under `docker stop`'s default 10 s grace. A
//! final flush that fails or times out loses nothing that the agents cannot
//! re-report: counters are cumulative and the next report of the same
//! session (to any instance) bills the difference, within the caps.

use std::time::Duration;

use crate::state::AppState;

/// How long the agent sessions get to end.
pub const SESSION_DRAIN: Duration = Duration::from_secs(3);
/// Deadline of the final traffic flush.
pub const FINAL_FLUSH: Duration = Duration::from_secs(5);
/// How long the servers get to finish in-flight requests.
pub const SERVER_DRAIN: Duration = Duration::from_secs(1);

/// Resolves on the first SIGTERM or SIGINT.
pub async fn signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = term.recv() => tracing::info!("SIGTERM received"),
            _ = tokio::signal::ctrl_c() => tracing::info!("SIGINT received"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// End every local agent session (UNAVAILABLE) and wait, at most
/// `within`, until every session task — cleanup included — has finished.
/// Returns whether they all did.
pub async fn end_sessions(state: &AppState, within: Duration) -> bool {
    let n = state.live_sessions();
    state.begin_shutdown();
    let deadline = tokio::time::Instant::now() + within;
    while state.live_sessions() > 0 {
        if tokio::time::Instant::now() >= deadline {
            tracing::warn!(
                left = state.live_sessions(),
                "agent sessions did not end in time"
            );
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tracing::info!(sessions = n, "agent sessions ended");
    true
}

/// The last flush of this instance's buffered traffic, bounded by `within`.
/// Returns whether it completed.
pub async fn final_flush(state: &AppState, within: Duration) -> bool {
    match tokio::time::timeout(within, crate::traffic::flush_all(state)).await {
        Ok(Ok(rows)) => {
            tracing::info!(rows, "final traffic flush done");
            true
        }
        Ok(Err(e)) => {
            tracing::error!(error = %e, "final traffic flush failed; agents re-report cumulative counters on reconnect");
            false
        }
        Err(_) => {
            tracing::error!(
                "final traffic flush timed out; agents re-report cumulative counters on reconnect"
            );
            false
        }
    }
}
