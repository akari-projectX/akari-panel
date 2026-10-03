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

    #[test]
    fn version_gate() {
        assert!(check_version("180000").is_ok());
        assert!(check_version("180006\n").is_ok());
        assert!(check_version("190001").is_ok());
        assert!(check_version("170005").is_err());
        assert!(check_version("junk").is_err());
    }
}
