//! Periodic, restart-safe enforcement passes (run from the traffic flush
//! loop). Each pass flips its marker AND bumps the affected nodes' versions
//! in one transaction; the caller notifies only after commit and only if
//! something changed. Lock order as in api.rs: nodes -> users -> node_users.

use sqlx::PgConnection;
use uuid::Uuid;

/// THE expiry predicate (alias `u` = users), evaluated on the DB clock.
/// Expiry applies to role=user only; admins are exempt. Used by snapshots,
/// login, the session extractor, subscriptions and the enforcement pass —
/// never duplicate it with the application clock.
pub const EXPIRED: &str =
    "(u.role = 'user' AND u.expires_at IS NOT NULL AND u.expires_at <= now())";

/// Users over their traffic limit.
const OVER_LIMIT: &str = "(u.enabled AND u.traffic_limit_bytes IS NOT NULL \
     AND u.traffic_used_bytes > u.traffic_limit_bytes)";

async fn lock_nodes_of(conn: &mut PgConnection, user_pred: &str) -> sqlx::Result<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT n.id FROM nodes n WHERE n.id IN ( \
           SELECT nu.node_id FROM node_users nu JOIN users u ON u.id = nu.user_id \
           WHERE {user_pred}) \
         ORDER BY n.id FOR UPDATE"
    )))
    .execute(conn)
    .await?;
    Ok(())
}

async fn bump_nodes_of(conn: &mut PgConnection, users: &[Uuid]) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar(
        "UPDATE nodes SET user_version = user_version + 1 \
         WHERE id IN (SELECT node_id FROM node_users WHERE user_id = ANY($1)) RETURNING id",
    )
    .bind(users)
    .fetch_all(conn)
    .await
}

/// Disable users past their traffic limit and bump their nodes. Raising a
/// limit later does NOT re-enable them (an admin sets enabled=true).
/// Returns the bumped nodes.
pub async fn apply_traffic_limits(conn: &mut PgConnection) -> sqlx::Result<Vec<Uuid>> {
    lock_nodes_of(conn, OVER_LIMIT).await?;
    let users: Vec<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "UPDATE users u SET enabled = false WHERE {OVER_LIMIT} RETURNING u.id"
    )))
    .fetch_all(&mut *conn)
    .await?;
    if users.is_empty() {
        return Ok(Vec::new());
    }
    tracing::info!(users = users.len(), "disabled users over traffic limit");
    bump_nodes_of(conn, &users).await
}

/// Push the removal of users whose expiry has passed: mark them enforced
/// and bump their nodes (snapshots already exclude them by EXPIRED; the
/// bump makes connected agents actually converge). Idempotent via the
/// marker, which PATCHing expires_at resets. Returns the bumped nodes.
pub async fn apply_expiry(conn: &mut PgConnection) -> sqlx::Result<Vec<Uuid>> {
    let due = format!("({EXPIRED} AND NOT u.expiry_enforced)");
    lock_nodes_of(conn, &due).await?;
    let users: Vec<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "UPDATE users u SET expiry_enforced = true WHERE {due} RETURNING u.id"
    )))
    .fetch_all(&mut *conn)
    .await?;
    if users.is_empty() {
        return Ok(Vec::new());
    }
    tracing::info!(users = users.len(), "expired users removed from nodes");
    bump_nodes_of(conn, &users).await
}

pub async fn run_all(state: &crate::state::AppState) -> anyhow::Result<()> {
    let mut changed = false;
    for pass in [Pass::Limits, Pass::Expiry] {
        let mut tx = state.pg().begin().await?;
        let nodes = match pass {
            Pass::Limits => apply_traffic_limits(&mut tx).await?,
            Pass::Expiry => apply_expiry(&mut tx).await?,
        };
        tx.commit().await?;
        changed |= !nodes.is_empty();
    }
    if changed {
        state.notify_change();
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Pass {
    Limits,
    Expiry,
}
