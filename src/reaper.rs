//! Phase 2 of node deletion (R12 D1). Runs on every panel instance; the
//! node row lock makes concurrent reapers safe (one deletes, the others
//! find nothing).
//!
//! A node marked deleting (phase 1, `api::apply_begin_delete_node`: disabled
//! and bumped, so its agent converges to the empty state while its final
//! counters are still billed) is deleted once
//!   - its agent acked the empty state (nodes.delete_acked_at) at least
//!     ACK_SETTLE ago — time for the instance holding the session to flush
//!     the final counters that arrived before the ack; or
//!   - no agent is online for it (nothing left to converge or bill); or
//!   - DELETE_TIMEOUT has passed since phase 1 (unreachable or stuck agent).
//!
//! Deleting = in one transaction: lock the row, re-check, tombstone the
//! certificate serial (revoked_certs), delete the row (node_users cascade;
//! traffic_counters are kept). The delete trigger notifies `del:<id>`; any
//! session still open for the node reads "gone" and retires (empty state,
//! close). The tombstoned certificate is served the empty state and closed
//! on every later connection.

use std::time::Duration;

use sqlx::PgConnection;
use uuid::Uuid;

use crate::state::AppState;

const EVERY: Duration = Duration::from_secs(5);
/// After the ack, wait this long (two flush intervals) before deleting.
const ACK_SETTLE_SECS: f64 = 10.0;
/// Phase 2 happens at the latest this long after phase 1.
const DELETE_TIMEOUT_SECS: f64 = 120.0;
/// A node counts as online if a session refreshed it this recently
/// (persist_online_loop refreshes every 30 s).
const ONLINE_FRESH_SECS: f64 = 90.0;

/// SQL predicate (alias `n`): phase 2 may run now.
const DUE: &str = "(n.deleting_at IS NOT NULL AND ( \
       n.delete_acked_at <= now() - make_interval(secs => $1) \
    OR n.deleting_at <= now() - make_interval(secs => $2) \
    OR NOT (n.status = 'online' AND n.last_seen_at > now() - make_interval(secs => $3))))";

pub async fn reap_loop(state: AppState) {
    let mut tick = tokio::time::interval(EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if let Err(e) = reap_once(&state).await {
            tracing::warn!(error = %e, "node reaper failed");
        }
    }
}

pub async fn reap_once(state: &AppState) -> anyhow::Result<Vec<Uuid>> {
    let due: Vec<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT n.id FROM nodes n WHERE {DUE} ORDER BY n.id"
    )))
    .bind(ACK_SETTLE_SECS)
    .bind(DELETE_TIMEOUT_SECS)
    .bind(ONLINE_FRESH_SECS)
    .fetch_all(state.pg())
    .await?;
    let mut done = Vec::new();
    for id in due {
        // Bill what this instance still buffers for the node first.
        if let Err(e) = crate::traffic::flush_node(state, id).await {
            tracing::warn!(node = %id, error = %e, "flush before node deletion failed");
        }
        let mut tx = state.pg().begin().await?;
        let serial = finalize_delete(&mut tx, id).await?;
        tx.commit().await?;
        if let Some(serial) = serial {
            tracing::info!(node = %id, serial = serial.as_deref().unwrap_or("-"),
                "node deleted, certificate revoked");
            crate::grpc::forget_node(state, id).await;
            done.push(id);
        }
    }
    Ok(done)
}

/// Lock, re-check that phase 2 is due, tombstone the serial, delete.
/// Returns Some(serial) if it deleted the node (serial None: the node never
/// had a certificate).
pub(crate) async fn finalize_delete(
    conn: &mut PgConnection,
    id: Uuid,
) -> sqlx::Result<Option<Option<String>>> {
    let row: Option<Option<String>> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT n.cert_serial FROM nodes n WHERE n.id = $4 AND {DUE} FOR UPDATE"
    )))
    .bind(ACK_SETTLE_SECS)
    .bind(DELETE_TIMEOUT_SECS)
    .bind(ONLINE_FRESH_SECS)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(serial) = row else {
        return Ok(None);
    };
    if let Some(serial) = &serial {
        sqlx::query(
            "INSERT INTO revoked_certs (cert_serial, node_id) VALUES ($1, $2) \
             ON CONFLICT (cert_serial) DO NOTHING",
        )
        .bind(serial)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    }
    sqlx::query("DELETE FROM nodes WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(Some(serial))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::TestDb;

    async fn due(db: &TestDb, n: Uuid) -> bool {
        let mut tx = db.pool.begin().await.unwrap();
        let r = finalize_delete(&mut tx, n).await.unwrap().is_some();
        tx.rollback().await.unwrap();
        r
    }

    /// Phase 2 waits for the ack (+ settle), a timeout, or an offline node;
    /// never for a node that is not being deleted.
    #[tokio::test]
    async fn phase_two_conditions() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        let set = |sql: &'static str| {
            let pool = db.pool.clone();
            async move {
                sqlx::query(sqlx::AssertSqlSafe(sql))
                    .bind(n)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        };
        set("UPDATE nodes SET status = 'online', last_seen_at = now() WHERE id = $1").await;
        assert!(!due(&db, n).await, "not deleting");
        let mut tx = db.pool.begin().await.unwrap();
        crate::api::apply_begin_delete_node(&mut tx, n)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!(!due(&db, n).await, "online, not acked, recent");
        set("UPDATE nodes SET delete_acked_at = now() WHERE id = $1").await;
        assert!(!due(&db, n).await, "acked, not settled");
        set("UPDATE nodes SET delete_acked_at = now() - interval '11 seconds' WHERE id = $1").await;
        assert!(due(&db, n).await, "acked and settled");
        set("UPDATE nodes SET delete_acked_at = NULL, deleting_at = now() - interval '3 minutes' WHERE id = $1").await;
        assert!(due(&db, n).await, "timed out");
        set("UPDATE nodes SET deleting_at = now(), last_seen_at = now() - interval '5 minutes' WHERE id = $1").await;
        assert!(due(&db, n).await, "stale online status = offline");
        set("UPDATE nodes SET last_seen_at = now(), status = 'offline' WHERE id = $1").await;
        assert!(due(&db, n).await, "offline");
        db.drop().await;
    }
}
