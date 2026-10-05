//! W28-a: relay entrance health. Any panel instance TCP-connects to every
//! enabled relay entrance's address (the relay clients dial) every
//! `entrance_health_interval_secs` (±10 %, rows claimed with
//! `entrances.health_next_at` + SKIP LOCKED, like the panel latency test).
//! After `ENTRANCE_HEALTH_FAILURES` consecutive failures the entrance is
//! hidden (`hidden_since`): left out of subscriptions and the portal, and
//! the node's `entrance_down` alert fires (alerts/eval.rs). The first
//! success shows it again and the alert resolves. The node keeps serving
//! the relay's derived inbound throughout (clients connected through it
//! are not cut); nothing here bumps the agent's config.
//!
//! Follows 系统设置 → 测速 → 面板 TCP 测速: when the panel must not dial
//! out, no entrance is probed and none is hidden by it. Relays of a
//! UDP-only inbound (Hysteria 2) cannot be TCP-tested and are never hidden.

use std::time::Duration;

use sqlx::PgPool;
use uuid::Uuid;

use crate::state::AppState;

/// How often each instance looks for due entrances.
const TICK: Duration = Duration::from_secs(5);
/// Entrances claimed per round and instance.
const CLAIM_BATCH: i64 = 64;
/// Longest error text stored (column CHECK 200).
const MAX_ERROR: usize = 200;

#[derive(sqlx::FromRow)]
struct Due {
    id: Uuid,
    host: Option<String>,
    port: Option<i32>,
    inbound: Option<serde_json::Value>,
}

/// The loop (main.rs spawns one per instance).
pub async fn health_loop(state: AppState) {
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let probe = state.settings().get().probe.clone();
        if !probe.panel_tcp {
            continue;
        }
        let interval = state.cfg().limits.entrance_health_interval_secs;
        let timeout = Duration::from_millis(u64::from(probe.timeout_ms));
        if let Err(e) = health_round(state.pg(), interval, timeout).await {
            tracing::warn!(error = %e, "entrance health round failed");
        }
    }
}

/// One round: claim the due relays, test them concurrently, record the
/// outcomes. Returns how many were tested.
pub async fn health_round(
    pg: &PgPool,
    interval_secs: u64,
    timeout: Duration,
) -> sqlx::Result<usize> {
    let due: Vec<Due> = sqlx::query_as(
        "UPDATE entrances e SET health_next_at = now() + make_interval(secs => $1 * (0.9 + 0.2 * random())) \
         FROM nodes n WHERE n.id = e.node_id AND e.id IN (SELECT e2.id FROM entrances e2 \
             JOIN nodes n2 ON n2.id = e2.node_id \
             WHERE e2.kind = 'relay' AND e2.enabled AND n2.enabled AND n2.deleting_at IS NULL \
             AND n2.inbound IS NOT NULL \
             AND (e2.health_next_at IS NULL OR e2.health_next_at <= now()) \
             ORDER BY e2.health_next_at NULLS FIRST, e2.id LIMIT $2 FOR UPDATE OF e2 SKIP LOCKED) \
         RETURNING e.id, e.connect_host AS host, e.connect_port AS port, n.inbound",
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
            let tcp = d
                .inbound
                .as_ref()
                .is_some_and(|ib| crate::protocols::l4(ib).0);
            let outcome = match (d.host, d.port.and_then(|p| u16::try_from(p).ok())) {
                _ if !tcp => return,
                (Some(h), Some(p)) => crate::nodestat::tcp_latency(&h, p, 1, timeout)
                    .await
                    .map(|_| ()),
                _ => Err("no address".to_string()),
            };
            if let Err(e) = record(&pg, d.id, outcome).await {
                tracing::warn!(entrance = %d.id, error = %e, "failed to store entrance health");
            }
        });
    }
    while set.join_next().await.is_some() {}
    Ok(n)
}

/// Store one test result; hides the entrance after the configured number of
/// consecutive failures, shows it again on success. Logs the transitions.
pub async fn record(pg: &PgPool, id: Uuid, outcome: Result<(), String>) -> sqlx::Result<()> {
    let ok = outcome.is_ok();
    let error = outcome.err().map(|e| {
        e.chars()
            .filter(|c| !c.is_control())
            .take(MAX_ERROR)
            .collect::<String>()
    });
    let changed: Option<(Option<chrono::DateTime<chrono::Utc>>, String)> = sqlx::query_as(
        "UPDATE entrances SET health_at = now(), health_ok = $2, health_error = $3, \
         health_failures = CASE WHEN $2 THEN 0 ELSE health_failures + 1 END, \
         hidden_since = CASE WHEN $2 THEN NULL \
             WHEN health_failures + 1 >= $4 THEN coalesce(hidden_since, now()) \
             ELSE hidden_since END \
         WHERE id = $1 AND kind = 'relay' \
         RETURNING new.hidden_since, new.name",
    )
    .bind(id)
    .bind(ok)
    .bind(&error)
    .bind(crate::config::ENTRANCE_HEALTH_FAILURES)
    .fetch_optional(pg)
    .await?;
    if let Some((hidden, name)) = changed {
        match (hidden, ok) {
            (Some(_), false) => {
                tracing::warn!(entrance = %id, %name, error = ?error, "relay entrance unreachable")
            }
            (None, true) => tracing::debug!(entrance = %id, %name, "relay entrance reachable"),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
