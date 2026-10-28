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

/// Pool options of every pool that serves or tests the panel.
///
/// Every connection runs with `jit = off`. PostgreSQL's JIT compiles any
/// statement whose estimated cost exceeds 100000, and the admin list queries
/// (node list with its correlated subqueries, filtered user lists) do,
/// although they run in milliseconds: compiling cost 80-100 ms per request
/// and CPU on the database host (docs/PERF.md, panel load test 2026-10).
/// Nothing here runs long enough to profit from compiled expressions.
///
/// An idle connection is handed out only if it is outside any transaction.
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
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET jit = off").execute(conn).await?;
                Ok(())
            })
        })
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

/// Version gate + migrations. Every entry point that migrates goes through
/// here.
pub async fn migrate(pg: &PgPool) -> Result<()> {
    require_supported_server(pg).await?;
    sqlx::migrate!("./migrations").run(pg).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serving_pool_connections_have_jit_off() {
        use std::str::FromStr;
        let url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://akari:akari-dev@localhost:5432/akari".into());
        let Ok(opts) = sqlx::postgres::PgConnectOptions::from_str(&url) else {
            return;
        };
        let Ok(pool) = pool_options().max_connections(2).connect_with(opts).await else {
            return;
        };
        let jit: String = sqlx::query_scalar("SHOW jit")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(jit, "off");
    }

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
        assert_eq!(versions.first(), Some(&1), "the baseline is version 1");
        // Seeded singletons are there.
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM panel_settings WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 1);
        // Restart: an already-migrated database migrates again as a no-op.
        migrate(&pool).await.unwrap();
        cleanup(t, pool, schema).await;
    }

    /// How long the statement that keeps the server busy runs.
    const SERVER_BUSY: &str = "SELECT pg_sleep(1)";

    /// Start `begin` on `conn` and drop it before the server's answer is
    /// read. A bare "poll once, then drop" is not that on a loaded machine:
    /// the client can be descheduled between its write and its read, the
    /// server answers meanwhile, and the same poll then reads the answer and
    /// completes the `BEGIN` (nothing is cancelled, and the connection is
    /// rightly reused). So the server is kept busy first: a statement that
    /// runs for a second is on the wire when the `BEGIN` is queued behind
    /// it, and the `BEGIN`'s answer cannot be read by the first poll.
    async fn begin_and_cancel(
        admin: &PgPool,
        conn: &mut sqlx::PgConnection,
        begin: Option<&'static str>,
    ) {
        use sqlx::SqlSafeStr;
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        poll_until_server_is_busy(admin, conn, pid).await;
        let mut begin = std::pin::pin!(sqlx::Transaction::<sqlx::Postgres>::begin(
            &mut *conn,
            begin.map(SqlSafeStr::into_sql_str),
        ));
        std::future::poll_fn(|cx| {
            assert!(
                begin.as_mut().poll(cx).is_pending(),
                "the BEGIN completed behind a one-second statement"
            );
            std::task::Poll::Ready(())
        })
        .await;
    }

    /// Send [`SERVER_BUSY`] on `conn` and drop it as soon as the server
    /// reports the statement running (`pid`'s session is `active`). The
    /// future is polled again only while the server has not started: a
    /// poll that returned before writing anything.
    async fn poll_until_server_is_busy(admin: &PgPool, conn: &mut sqlx::PgConnection, pid: i32) {
        let mut busy = std::pin::pin!(sqlx::raw_sql(SERVER_BUSY).execute(&mut *conn));
        for _ in 0..50 {
            std::future::poll_fn(|cx| {
                assert!(
                    busy.as_mut().poll(cx).is_pending(),
                    "a one-second statement finished in one poll"
                );
                std::task::Poll::Ready(())
            })
            .await;
            for _ in 0..20 {
                let state: Option<String> =
                    sqlx::query_scalar("SELECT state FROM pg_stat_activity WHERE pid = $1")
                        .bind(pid)
                        .fetch_optional(admin)
                        .await
                        .unwrap();
                if state.as_deref() == Some("active") {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
        panic!("the server never started {SERVER_BUSY:?}");
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

    /// A test database, its one-connection pool and that connection's
    /// backend pid (to tell a reused connection from a replaced one).
    async fn single_with_pid() -> Option<(crate::testdb::TestDb, PgPool, i32)> {
        let t = crate::testdb::TestDb::new().await?;
        let pool = single(&t).await;
        let pid = backend_pid(&pool).await;
        Some((t, pool, pid))
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
        let Some((t, pool, before)) = single_with_pid().await else {
            return;
        };
        for begin in [
            Some("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY"),
            Some("BEGIN"),
            None,
        ] {
            let mut conn = pool.acquire().await.unwrap();
            begin_and_cancel(&t.admin, &mut conn, begin).await;
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
        let Some((t, pool, before)) = single_with_pid().await else {
            return;
        };
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
        let Some((t, pool, before)) = single_with_pid().await else {
            return;
        };
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

/// `term` with the LIKE metacharacters (`\`, `%`, `_`) taken literally,
/// without wildcards around it (backslash is the default escape).
fn like_escaped(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 2);
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `%term%` for `LIKE`/`ILIKE`: a substring match on `term` taken literally.
pub fn like_contains(term: &str) -> String {
    format!("%{}%", like_escaped(term))
}

/// `term%` for `LIKE`/`ILIKE`: a prefix match on `term` taken literally.
pub fn like_prefix(term: &str) -> String {
    format!("{}%", like_escaped(term))
}

#[cfg(test)]
mod like_tests {
    use super::*;

    #[test]
    fn metacharacters_are_literal() {
        assert_eq!(like_contains("50%_\\"), "%50\\%\\_\\\\%");
        assert_eq!(like_prefix("a_b"), "a\\_b%");
        assert_eq!(like_contains(""), "%%");
    }
}
