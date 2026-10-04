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
}
