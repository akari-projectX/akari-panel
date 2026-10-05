//! Periodic, restart-safe enforcement passes (run from the traffic flush
//! loop). Each pass flips its marker AND bumps the affected nodes' versions
//! in one transaction; the bump's trigger (migration 0007) notifies every
//! panel instance on commit. Lock order as in api.rs: nodes -> users -> node_users.

use sqlx::PgConnection;
use uuid::Uuid;

/// THE expiry predicate (alias `u` = users), evaluated on the DB clock.
/// Expiry applies to role=user only; admins are exempt. Used by snapshots,
/// login, the session extractor, subscriptions and the enforcement pass —
/// never duplicate it with the application clock.
pub const EXPIRED: &str =
    "(u.role = 'user' AND u.expires_at IS NOT NULL AND u.expires_at <= now())";

/// Users over their traffic limit. Admins are not proxy users and are never
/// disabled by it.
pub const OVER_LIMIT: &str = "(u.role = 'user' AND u.enabled AND u.traffic_limit_bytes IS NOT NULL \
     AND u.traffic_used_bytes > u.traffic_limit_bytes)";

/// Users a node serves: role=user, enabled, not expired (alias `u`).
/// Admin accounts are never proxy users.
pub const SERVED: &str = "(u.role = 'user' AND u.enabled AND NOT \
     (u.expires_at IS NOT NULL AND u.expires_at <= now()))";

async fn lock_nodes_of_ids(conn: &mut PgConnection, users: &[Uuid]) -> sqlx::Result<()> {
    sqlx::query(
        "SELECT id FROM nodes WHERE id IN (SELECT node_id FROM node_users WHERE user_id = ANY($1)) \
         ORDER BY id FOR UPDATE",
    )
    .bind(users)
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

/// One enforcement pass, in the global lock order (nodes before users):
///   1. plain SELECT of candidate user ids (no locks),
///   2. lock their nodes FOR UPDATE in id order,
///   3. UPDATE the users, re-checking the predicate (RETURNING the ones
///      actually changed),
///   4. bump the nodes of those users.
///
/// A node assigned to a candidate between 1 and 4 is locked by the bump
/// itself, out of order; a resulting deadlock aborts this tick's pass and
/// is retried on the next one (the pass is idempotent). Candidates that
/// appear after step 1 are handled next tick.
async fn apply_pass(conn: &mut PgConnection, pred: &str, set: &str) -> sqlx::Result<Vec<Uuid>> {
    let candidates: Vec<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT u.id FROM users u WHERE {pred} ORDER BY u.id"
    )))
    .fetch_all(&mut *conn)
    .await?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    lock_nodes_of_ids(conn, &candidates).await?;
    let users: Vec<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "UPDATE users u SET {set} WHERE {pred} AND u.id = ANY($1) RETURNING u.id"
    )))
    .bind(&candidates)
    .fetch_all(&mut *conn)
    .await?;
    if users.is_empty() {
        return Ok(Vec::new());
    }
    bump_nodes_of(conn, &users).await
}

/// Disable users past their traffic limit (`disabled_reason = 'quota'`)
/// and bump their nodes. Raising a limit by PATCH /users does NOT re-enable
/// them (an admin sets enabled=true); the plan period reset and plan
/// changes that admit them do (plans.rs).
/// Returns the bumped nodes.
pub async fn apply_traffic_limits(conn: &mut PgConnection) -> sqlx::Result<Vec<Uuid>> {
    let nodes = apply_pass(
        conn,
        OVER_LIMIT,
        "enabled = false, disabled_reason = 'quota'",
    )
    .await?;
    if !nodes.is_empty() {
        tracing::info!(nodes = nodes.len(), "disabled users over traffic limit");
    }
    Ok(nodes)
}

/// Push the removal of users whose expiry has passed: mark them enforced
/// and bump their nodes (snapshots already exclude them; the bump makes
/// connected agents actually converge). Idempotent via the marker, which
/// PATCHing expires_at resets. Returns the bumped nodes.
pub async fn apply_expiry(conn: &mut PgConnection) -> sqlx::Result<Vec<Uuid>> {
    let due = format!("({EXPIRED} AND NOT u.expiry_enforced)");
    let nodes = apply_pass(conn, &due, "expiry_enforced = true").await?;
    if !nodes.is_empty() {
        tracing::info!(nodes = nodes.len(), "expired users removed from nodes");
    }
    Ok(nodes)
}

pub async fn run_all(state: &crate::state::AppState) -> anyhow::Result<()> {
    // Plan passes first: a due reset re-enables before the limit pass
    // would look at the old usage.
    for pass in [
        Pass::PlanExpiry,
        Pass::Resets,
        Pass::Limits,
        Pass::Expiry,
        Pass::Commissions,
    ] {
        let name = match pass {
            Pass::PlanExpiry => "plan_expiry",
            Pass::Resets => "period_reset",
            Pass::Limits => "limits",
            Pass::Expiry => "expiry",
            Pass::Commissions => "commissions",
        };
        let r = run_pass(state, pass).await;
        crate::metrics::enforcement_pass(name, r.is_ok());
        r?;
    }
    Ok(())
}

async fn run_pass(state: &crate::state::AppState, pass: Pass) -> anyhow::Result<()> {
    let mut tx = state.pg().begin().await?;
    // The bump's trigger notifies every instance on commit.
    match pass {
        Pass::Limits => apply_traffic_limits(&mut tx).await?,
        Pass::Expiry => apply_expiry(&mut tx).await?,
        Pass::PlanExpiry => crate::plans::apply_plan_expiry(&mut tx)
            .await
            .map_err(|e| anyhow::anyhow!("plan expiry pass: {}", e.message()))?,
        Pass::Resets => crate::plans::apply_period_resets(&mut tx)
            .await
            .map_err(|e| anyhow::anyhow!("period reset pass: {}", e.message()))?,
        // W16: invite commissions past their hold become balance (ledger),
        // exactly once (SKIP LOCKED + conditional on pending).
        Pass::Commissions => {
            crate::billing::commission::credit_due(&mut tx)
                .await
                .map_err(|e| anyhow::anyhow!("commission pass: {}", e.message()))?;
            Vec::new()
        }
    };
    tx.commit().await?;
    Ok(())
}

#[derive(Clone, Copy)]
enum Pass {
    PlanExpiry,
    Resets,
    Limits,
    Expiry,
    Commissions,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::testdb::TestDb;

    async fn user_row(db: &TestDb, u: Uuid) -> (bool, Option<String>, bool) {
        sqlx::query_as("SELECT enabled, disabled_reason, expiry_enforced FROM users WHERE id = $1")
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    }

    async fn set(db: &TestDb, u: Uuid, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE users SET {sql} WHERE id = $1"
        )))
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    /// The flush loop's enforcement tick: over-limit users are disabled
    /// ('quota'), expired users marked enforced, admins exempt from both,
    /// every affected node bumped exactly once per change, and a second
    /// tick is a no-op (no bump: agents are not re-synced for nothing).
    #[tokio::test]
    async fn run_all_enforces_limits_and_expiry_idempotently() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (n_over, over) = db.member().await;
        let (n_exp, expired) = db.member().await;
        let (n_ok, fine) = db.member().await;
        let admin = db.admin().await;
        db.assign(n_ok, admin).await;
        set(
            &db,
            over,
            "traffic_limit_bytes = 100, traffic_used_bytes = 101",
        )
        .await;
        // Exactly at the limit is not over it.
        set(
            &db,
            fine,
            "traffic_limit_bytes = 100, traffic_used_bytes = 100",
        )
        .await;
        set(&db, expired, "expires_at = now() - interval '1 second'").await;
        set(
            &db,
            admin,
            "traffic_limit_bytes = 1, traffic_used_bytes = 5, expires_at = now() - interval '1 day'",
        )
        .await;
        let before = (
            db.versions(n_over).await,
            db.versions(n_exp).await,
            db.versions(n_ok).await,
        );

        run_all(&state).await.unwrap();

        assert_eq!(
            user_row(&db, over).await,
            (false, Some("quota".into()), false)
        );
        assert_eq!(user_row(&db, expired).await, (true, None, true));
        assert_eq!(user_row(&db, fine).await, (true, None, false));
        assert_eq!(user_row(&db, admin).await, (true, None, false));
        assert_eq!(db.versions(n_over).await.1, before.0.1 + 1);
        assert_eq!(db.versions(n_exp).await.1, before.1.1 + 1);
        assert_eq!(db.versions(n_ok).await, before.2, "untouched node bumped");
        // Config versions never move for user-set changes.
        assert_eq!(db.versions(n_over).await.0, before.0.0);

        let after = (db.versions(n_over).await, db.versions(n_exp).await);
        run_all(&state).await.unwrap();
        assert_eq!(
            (db.versions(n_over).await, db.versions(n_exp).await),
            after,
            "second tick bumped again"
        );
        db.drop().await;
    }

    /// A pass whose candidates have no node assignments changes the users
    /// but bumps nothing; a pass with no candidates touches nothing.
    #[tokio::test]
    async fn passes_without_nodes_or_candidates() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let lonely = db.user().await;
        set(
            &db,
            lonely,
            "traffic_limit_bytes = 0, traffic_used_bytes = 1",
        )
        .await;
        let mut tx = db.pool.begin().await.unwrap();
        assert!(apply_traffic_limits(&mut tx).await.unwrap().is_empty());
        assert!(apply_expiry(&mut tx).await.unwrap().is_empty());
        tx.commit().await.unwrap();
        assert!(!user_row(&db, lonely).await.0);
        let mut tx = db.pool.begin().await.unwrap();
        assert!(apply_traffic_limits(&mut tx).await.unwrap().is_empty());
        tx.commit().await.unwrap();
        db.drop().await;
    }

    /// A disabled user over its limit is not a candidate again (the
    /// predicate requires `enabled`), and re-enabling by hand while still
    /// over the limit is undone on the next tick.
    #[tokio::test]
    async fn manual_reenable_over_limit_is_reverted() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let (n, u) = db.member().await;
        set(&db, u, "traffic_limit_bytes = 10, traffic_used_bytes = 11").await;
        run_all(&state).await.unwrap();
        let v1 = db.versions(n).await;
        set(&db, u, "enabled = true, disabled_reason = NULL").await;
        run_all(&state).await.unwrap();
        assert_eq!(user_row(&db, u).await, (false, Some("quota".into()), false));
        assert_eq!(db.versions(n).await.1, v1.1 + 1);
        db.drop().await;
    }
}
