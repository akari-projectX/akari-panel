use dashmap::DashMap;
use uuid::Uuid;

use crate::gen::TrafficReport;
use crate::state::AppState;

/// Per (node, user): latest cumulative counters reported by the agent,
/// plus deltas not yet applied to the database.
#[derive(Clone)]
struct Entry {
    session_id: String,
    reported_up: i64,
    reported_down: i64,
    pending_up: i64,
    pending_down: i64,
}

#[derive(Default)]
pub struct TrafficBuffer {
    entries: DashMap<(Uuid, Uuid), Entry>,
}

impl TrafficBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Agents report cumulative per-user counters within a session.
    /// A session id change means the agent rebuilt its xray instance and
    /// counters restarted, so the baseline resets.
    pub fn update(&self, node_id: Uuid, session_id: &str, report: &TrafficReport) {
        for u in &report.users {
            let Ok(user_id) = Uuid::parse_str(&u.user_id) else {
                tracing::warn!(node = %node_id, user = %u.user_id, "traffic report for unparseable user id");
                continue;
            };
            let mut e = self
                .entries
                .entry((node_id, user_id))
                .or_insert_with(|| Entry {
                    session_id: session_id.to_string(),
                    reported_up: 0,
                    reported_down: 0,
                    pending_up: 0,
                    pending_down: 0,
                });
            if e.session_id != session_id {
                *e = Entry {
                    session_id: session_id.to_string(),
                    reported_up: 0,
                    reported_down: 0,
                    pending_up: 0,
                    pending_down: 0,
                };
            }
            let up = u.up_bytes as i64;
            let down = u.down_bytes as i64;
            if up >= e.reported_up && down >= e.reported_down {
                e.pending_up += up - e.reported_up;
                e.pending_down += down - e.reported_down;
            } else {
                // Unexpected regression within a session: treat the new
                // counters as a fresh baseline.
                e.pending_up += up;
                e.pending_down += down;
            }
            e.reported_up = up;
            e.reported_down = down;
        }
    }

    fn drain(&self) -> Vec<FlushRow> {
        let mut out = Vec::new();
        for mut e in self.entries.iter_mut() {
            let key = *e.key();
            let v = &mut *e;
            if v.pending_up == 0 && v.pending_down == 0 {
                continue;
            }
            out.push(FlushRow {
                node_id: key.0,
                user_id: key.1,
                session_id: v.session_id.clone(),
                up: v.reported_up,
                down: v.reported_down,
                d_up: v.pending_up,
                d_down: v.pending_down,
            });
            v.pending_up = 0;
            v.pending_down = 0;
        }
        out
    }
}

struct FlushRow {
    node_id: Uuid,
    user_id: Uuid,
    session_id: String,
    up: i64,
    down: i64,
    d_up: i64,
    d_down: i64,
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

    let rows = state.traffic().drain();
    if rows.is_empty() {
        return Ok(());
    }

    let mut nodes = Vec::with_capacity(rows.len());
    let mut users = Vec::with_capacity(rows.len());
    let mut sessions = Vec::with_capacity(rows.len());
    let mut ups = Vec::with_capacity(rows.len());
    let mut downs = Vec::with_capacity(rows.len());
    let mut delta_users = Vec::with_capacity(rows.len());
    let mut delta_totals = Vec::with_capacity(rows.len());

    for r in &rows {
        nodes.push(r.node_id);
        users.push(r.user_id);
        sessions.push(r.session_id.clone());
        ups.push(r.up);
        downs.push(r.down);
        delta_users.push(r.user_id);
        delta_totals.push(r.d_up + r.d_down);
    }

    let mut tx = state.pg().begin().await?;

    sqlx::query(
        r#"INSERT INTO traffic_counters (node_id, user_id, session_id, up_bytes, down_bytes, updated_at)
           SELECT unnest($1::uuid[]), unnest($2::uuid[]), unnest($3::text[]),
                  unnest($4::bigint[]), unnest($5::bigint[]), now()
           ON CONFLICT (node_id, user_id, session_id) DO UPDATE
           SET up_bytes = EXCLUDED.up_bytes,
               down_bytes = EXCLUDED.down_bytes,
               updated_at = EXCLUDED.updated_at"#,
    )
    .bind(&nodes)
    .bind(&users)
    .bind(&sessions)
    .bind(&ups)
    .bind(&downs)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"WITH d(user_id, delta) AS (
               SELECT unnest($1::uuid[]), unnest($2::bigint[]))
           UPDATE users u
           SET traffic_used_bytes = u.traffic_used_bytes + s.delta
           FROM (SELECT user_id, sum(delta) AS delta FROM d GROUP BY user_id) s
           WHERE u.id = s.user_id"#,
    )
    .bind(&delta_users)
    .bind(&delta_totals)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    tracing::debug!(rows = rows.len(), "traffic flushed");
    Ok(())
}
