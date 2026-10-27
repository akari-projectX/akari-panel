use anyhow::{Context, Result, bail};
use sqlx::PgPool;

/// Billing (`traffic.rs`) relies on `INSERT ... ON CONFLICT ... RETURNING
/// old.*, new.*`, which only exists from PostgreSQL 18. On older servers it
/// would not fail loudly everywhere, so refuse to run instead.
pub const MIN_SERVER_VERSION_NUM: i64 = 180_000;

fn check_version(server_version_num: &str) -> Result<()> {
    let v: i64 = server_version_num
        .trim()
        .parse()
        .with_context(|| format!("unparseable server_version_num {server_version_num:?}"))?;
    if v < MIN_SERVER_VERSION_NUM {
        bail!(
            "PostgreSQL {v} is too old: akari requires PostgreSQL >= 18 \
             (server_version_num >= {MIN_SERVER_VERSION_NUM}) for traffic billing"
        );
    }
    Ok(())
}

pub async fn require_supported_server(pg: &PgPool) -> Result<()> {
    let v: String = sqlx::query_scalar("SHOW server_version_num")
        .fetch_one(pg)
        .await
        .context("query server_version_num")?;
    check_version(&v)
}

/// v0.4 squashed migrations 0001-0168 into `1000_baseline.sql`. A database
/// whose history holds any older version was created by panel v0.3.x and
/// cannot be upgraded in place (sqlx would only report an opaque
/// `VersionMissing`).
pub const BASELINE_VERSION: i64 = 1000;

pub const PRE_BASELINE_ERROR: &str =
    "database from v0.3.x — fresh install required; see docs/DEPLOY.md";

/// Refuses a database migrated by the pre-baseline chain. Runs before any
/// migration, so such a database is left untouched. Resolves
/// `_sqlx_migrations` through the connection's search_path, like sqlx.
pub async fn refuse_pre_baseline(pg: &PgPool) -> Result<()> {
    let has_history: bool =
        sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations') IS NOT NULL")
            .fetch_one(pg)
            .await
            .context("look up migration history")?;
    if !has_history {
        return Ok(());
    }
    let oldest: Option<i64> = sqlx::query_scalar("SELECT min(version) FROM _sqlx_migrations")
        .fetch_one(pg)
        .await
        .context("read migration history")?;
    match oldest {
        Some(v) if v < BASELINE_VERSION => {
            bail!("{PRE_BASELINE_ERROR} (migration history starts at version {v})")
        }
        _ => Ok(()),
    }
}

/// Pool options of every pool that serves or tests the panel: an idle
/// connection is handed out only if it is outside any transaction.
///
/// sqlx 0.9 returns a connection to the pool after draining it and queueing
/// a `ROLLBACK` for a dropped [`sqlx::Transaction`], which covers a request
/// cancelled between two statements. It does not cover a cancellation while
/// the `BEGIN` itself is in flight (the future is dropped: a gRPC stream
/// ends and aborts the task reading the desired state, an HTTP client hangs
/// up, a timeout fires): the transaction depth is still 0 then, so no
/// rollback is queued, the server runs the `BEGIN`, and the connection goes
/// back to the pool inside a transaction (sqlx-postgres `transaction.rs`,
/// `PgTransactionManager::begin` / `start_rollback`). The next caller's
/// autocommit statements then run inside that transaction: reads keep one
/// old snapshot, writes in a `READ ONLY` one fail, writes in a read-write
/// one are neither visible to other sessions nor durable until a `COMMIT`
/// that may never come (the connection's lifetime ends first: rolled back).
///
/// The check replaces sqlx's own liveness ping on acquire (one round trip
/// either way, so no extra cost; a broken connection fails it the same
/// way). Its statement drains whatever is still queued on the connection
/// first, so it sees the final state. A connection that was cancelled in
/// its `BEGIN` has run no other statement, so it holds no snapshot and no
/// lock while it waits in the pool.
pub fn pool_options() -> sqlx::postgres::PgPoolOptions {
    sqlx::postgres::PgPoolOptions::new()
        .test_before_acquire(false)
        .before_acquire(|conn, _| {
            Box::pin(async move {
                let idle = is_idle(conn).await?;
                if !idle {
                    tracing::warn!("idle database connection is inside a transaction; closing it");
                    crate::metrics::db_connection_discarded();
                }
                Ok(idle)
            })
        })
}

/// Whether the connection is outside any transaction, read from the
/// `ReadyForQuery` status that sqlx tracks: asking sqlx to begin a
/// transaction with a statement that does not start one fails with
/// [`sqlx::Error::BeginFailed`] exactly when the server says the session is
/// idle. If it is in a transaction instead, the "begin" succeeds (and its
/// drop queues the rollback). The statement is the empty query: the server
/// answers it without parsing or running anything, so this costs the same
/// round trip as the ping it replaces (an empty `SELECT` measured ~7% slower in
/// a loop of trivial queries). A session in the aborted-transaction
/// state is not told apart (status `E` counts as not in a transaction); only
/// a hand-written `BEGIN` can leave one, and the next statement on it
/// fails loudly.
async fn is_idle(conn: &mut sqlx::PgConnection) -> sqlx::Result<bool> {
    use sqlx::SqlSafeStr;
    match sqlx::Transaction::<sqlx::Postgres>::begin(conn, Some("".into_sql_str())).await {
        Err(sqlx::Error::BeginFailed) => Ok(true),
        Ok(_still_open) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Version gate + pre-baseline guard + migrations. Every entry point that
/// migrates goes through here.
pub async fn migrate(pg: &PgPool) -> Result<()> {
    require_supported_server(pg).await?;
    refuse_pre_baseline(pg).await?;
    sqlx::migrate!("./migrations").run(pg).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_gate() {
        assert!(check_version("180000").is_ok());
        assert!(check_version("180006\n").is_ok());
        assert!(check_version("190001").is_ok());
        assert!(check_version("170005").is_err());
        assert!(check_version("junk").is_err());
    }

    /// A pool on a new, empty schema (dropped by the caller via `admin`).
    async fn empty_schema() -> Option<(crate::testdb::TestDb, PgPool, String)> {
        use std::str::FromStr;
        let t = crate::testdb::TestDb::new().await?;
        let schema = format!("{}_guard", t.schema);
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
            .execute(&t.admin)
            .await
            .unwrap();
        let url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://akari:akari-dev@localhost:5432/akari".into());
        let opts = sqlx::postgres::PgConnectOptions::from_str(&url)
            .unwrap()
            .options([("search_path", schema.as_str())]);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        Some((t, pool, schema))
    }

    async fn cleanup(t: crate::testdb::TestDb, pool: PgPool, schema: String) {
        pool.close().await;
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
            .execute(&t.admin)
            .await
            .unwrap();
        t.drop().await;
    }

    async fn tables(pool: &PgPool) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT table_name::text FROM information_schema.tables \
             WHERE table_schema = current_schema() ORDER BY 1",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn fresh_database_migrates_and_remigrates() {
        let Some((t, pool, schema)) = empty_schema().await else {
            return;
        };
        migrate(&pool).await.unwrap();
        let versions: Vec<i64> =
            sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(versions.first(), Some(&BASELINE_VERSION));
        assert!(versions.iter().all(|v| *v >= BASELINE_VERSION));
        // Seeded singletons are there.
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM panel_settings WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 1);
        // Restart: already-migrated v0.4 database passes the guard.
        migrate(&pool).await.unwrap();
        cleanup(t, pool, schema).await;
    }

    #[tokio::test]
    async fn v03_database_is_refused_untouched() {
        let Some((t, pool, schema)) = empty_schema().await else {
            return;
        };
        // What a v0.3.x panel leaves behind: sqlx's history table with the
        // old chain's versions (here just two of them) plus its tables.
        sqlx::raw_sql(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, \
             description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), \
             success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL); \
             INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
             VALUES (1, 'init', true, '\\x00', 1), (168, 'mail admin notice', true, '\\x00', 1); \
             CREATE TABLE users (id uuid PRIMARY KEY);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let before = tables(&pool).await;
        let err = migrate(&pool).await.unwrap_err().to_string();
        assert!(err.contains(PRE_BASELINE_ERROR), "{err}");
        assert!(err.contains("version 1"), "{err}");
        assert_eq!(
            tables(&pool).await,
            before,
            "guard must not touch the database"
        );
        let max: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(max, 168);
        cleanup(t, pool, schema).await;
    }

    /// Poll `fut` once, then drop it: the request is cancelled with its first
    /// statement on the wire (the socket write completes on the first poll,
    /// the server's answer never does).
    async fn poll_once_and_drop<F: std::future::Future>(fut: F) {
        let mut fut = std::pin::pin!(fut);
        std::future::poll_fn(|cx| {
            let _ = fut.as_mut().poll(cx);
            std::task::Poll::Ready(())
        })
        .await;
    }

    /// A one-connection pool on the test schema (so a leaked transaction is
    /// the next caller's), and a table to write to.
    async fn single(t: &crate::testdb::TestDb) -> PgPool {
        sqlx::query("CREATE TABLE pool_probe (n int)")
            .execute(&t.pool)
            .await
            .unwrap();
        t.single_connection().await
    }

    /// The write of an autocommit statement must be visible to another
    /// session as soon as it returns.
    async fn assert_write_is_durable(t: &crate::testdb::TestDb, pool: &PgPool, total: i64) {
        sqlx::query("INSERT INTO pool_probe VALUES (1)")
            .execute(pool)
            .await
            .expect("an autocommit write on a pooled connection");
        let seen: i64 = sqlx::query_scalar("SELECT count(*) FROM pool_probe")
            .fetch_one(&t.pool)
            .await
            .unwrap();
        assert_eq!(seen, total, "the write is not visible to other sessions");
    }

    async fn backend_pid(pool: &PgPool) -> i32 {
        sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// A `BEGIN` cancelled while it is on the wire used to hand the next
    /// caller a connection inside the transaction (a `READ ONLY` one for
    /// `desired_state`: "cannot execute INSERT in a read-only transaction";
    /// a plain one: a write that nothing ever commits).
    #[tokio::test]
    async fn interrupted_begin_does_not_poison_the_pool() {
        use sqlx::SqlSafeStr;
        let Some(t) = crate::testdb::TestDb::new().await else {
            return;
        };
        let pool = single(&t).await;
        let before = backend_pid(&pool).await;
        for begin in [
            Some("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY"),
            Some("BEGIN"),
            None,
        ] {
            let mut conn = pool.acquire().await.unwrap();
            poll_once_and_drop(sqlx::Transaction::<sqlx::Postgres>::begin(
                &mut *conn,
                begin.map(SqlSafeStr::into_sql_str),
            ))
            .await;
            drop(conn);
            assert_write_is_durable(&t, &pool, 1).await;
            sqlx::query("DELETE FROM pool_probe")
                .execute(&pool)
                .await
                .unwrap();
        }
        assert_ne!(
            backend_pid(&pool).await,
            before,
            "the connection that was inside a transaction must have been replaced"
        );
        pool.close().await;
        t.drop().await;
    }

    /// The same through the pool's own `begin_with` (what `desired_state`
    /// calls) with the cancellation at every microsecond offset around the
    /// round trip: whichever statement is on the wire, the next caller gets
    /// an idle connection.
    #[tokio::test]
    async fn cancelling_begin_with_at_any_point_leaves_an_idle_connection() {
        let Some(t) = crate::testdb::TestDb::new().await else {
            return;
        };
        let pool = single(&t).await;
        for micros in (0..400).step_by(7) {
            let cancelled = tokio::time::timeout(std::time::Duration::from_micros(micros), async {
                let mut tx = pool
                    .begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                    .await?;
                sqlx::query("SELECT pg_sleep(0.01)")
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await
            })
            .await;
            let _ = cancelled;
            sqlx::query("INSERT INTO pool_probe VALUES (1)")
                .execute(&pool)
                .await
                .unwrap_or_else(|e| panic!("write after a cancel at {micros} us: {e}"));
        }
        let seen: i64 = sqlx::query_scalar("SELECT count(*) FROM pool_probe")
            .fetch_one(&t.pool)
            .await
            .unwrap();
        assert_eq!(seen, 58, "every autocommit write must be durable");
        pool.close().await;
        t.drop().await;
    }

    /// A statement cancelled inside a transaction: sqlx queues the rollback
    /// and the next caller starts clean (and keeps the same backend: a
    /// healthy release is not a reconnect).
    #[tokio::test]
    async fn cancelled_statement_in_a_transaction_is_rolled_back() {
        let Some(t) = crate::testdb::TestDb::new().await else {
            return;
        };
        let pool = single(&t).await;
        let before = backend_pid(&pool).await;
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("INSERT INTO pool_probe VALUES (7)")
            .execute(&mut *tx)
            .await
            .unwrap();
        let slow = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            sqlx::query("SELECT pg_sleep(5)").execute(&mut *tx),
        )
        .await;
        assert!(slow.is_err(), "the statement must time out");
        drop(tx);
        assert_write_is_durable(&t, &pool, 1).await;
        assert_eq!(backend_pid(&pool).await, before);
        pool.close().await;
        t.drop().await;
    }

    /// A transaction opened by hand (raw `BEGIN` on a pooled connection,
    /// which sqlx does not track) is never handed to the next caller, and a
    /// healthy connection is not replaced.
    #[tokio::test]
    async fn untracked_transaction_is_discarded_before_reuse() {
        let Some(t) = crate::testdb::TestDb::new().await else {
            return;
        };
        let pool = single(&t).await;
        let before = backend_pid(&pool).await;
        let mut conn = pool.acquire().await.unwrap();
        sqlx::raw_sql("BEGIN").execute(&mut *conn).await.unwrap();
        drop(conn);
        assert_write_is_durable(&t, &pool, 1).await;
        let after = backend_pid(&pool).await;
        assert_ne!(after, before);
        for _ in 0..20 {
            assert_eq!(
                backend_pid(&pool).await,
                after,
                "a healthy idle connection is reused"
            );
        }
        pool.close().await;
        t.drop().await;
    }
}
