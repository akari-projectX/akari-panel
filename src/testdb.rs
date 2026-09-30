//! Real-PostgreSQL test harness: each test gets a throwaway schema with all
//! migrations applied. Needs the dev database (`make dev-up`; DATABASE_URL
//! or the config default). AKARI_SKIP_DB_TESTS=1 skips DB tests.

use std::str::FromStr;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use uuid::Uuid;

pub mod fake_agent;

/// Payloads received until the channel stays quiet for `quiet`.
pub async fn drain(l: &mut sqlx::postgres::PgListener, quiet: std::time::Duration) -> Vec<String> {
    let mut got = Vec::new();
    while let Ok(Ok(n)) = tokio::time::timeout(quiet, l.recv()).await {
        got.push(n.payload().to_string());
    }
    got
}

pub struct TestDb {
    pub admin: PgPool,
    pub pool: PgPool,
    pub schema: String,
}

impl TestDb {
    pub async fn new() -> Option<Self> {
        Self::with_options(&[]).await
    }

    pub async fn with_options(extra: &[(&str, &str)]) -> Option<Self> {
        if std::env::var("AKARI_SKIP_DB_TESTS").is_ok_and(|v| v == "1") {
            eprintln!("AKARI_SKIP_DB_TESTS=1: skipping");
            return None;
        }
        let url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://akari:akari-dev@localhost:5432/akari".into());
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .expect("test database unreachable (make dev-up, or AKARI_SKIP_DB_TESTS=1)");
        let schema = format!("test_akari_{}", Uuid::new_v4().simple());
        // schema is our own "test_akari_<hex uuid>": no injection surface.
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
            .execute(&admin)
            .await
            .unwrap();
        let base = PgConnectOptions::from_str(&url)
            .unwrap()
            .options([("search_path", schema.as_str())]);
        // Migrate without `extra`: the migrator's advisory lock is shared by
        // concurrently running tests and must not hit e.g. a tiny
        // lock_timeout.
        let migrator = PgPoolOptions::new()
            .max_connections(1)
            .connect_with(base.clone())
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&migrator).await.unwrap();
        migrator.close().await;
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect_with(base.options(extra.iter().copied()))
            .await
            .unwrap();
        Some(Self {
            admin,
            pool,
            schema,
        })
    }

    /// A plain enabled role=user account.
    pub async fn user(&self) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, login) VALUES ($1, $2)")
            .bind(id)
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .unwrap();
        id
    }

    /// An enabled node with one vless inbound tagged "in-vless".
    pub async fn node(&self) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO nodes (id, name, xray_inbounds) VALUES ($1, $2, \
             '[{\"tag\":\"in-vless\",\"protocol\":\"vless\",\"port\":1}]'::jsonb)",
        )
        .bind(id)
        .bind(id.to_string())
        .execute(&self.pool)
        .await
        .unwrap();
        id
    }

    pub async fn assign(&self, node: Uuid, user: Uuid) {
        sqlx::query(
            "INSERT INTO node_users (node_id, user_id, credentials) VALUES ($1, $2, \
             '[{\"inbound_tag\":\"in-vless\",\"protocol\":\"vless\",\"account\":{\"id\":\"x\"}}]'::jsonb)",
        )
        .bind(node)
        .bind(user)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    /// A node and a user assigned to it.
    pub async fn member(&self) -> (Uuid, Uuid) {
        let (n, u) = (self.node().await, self.user().await);
        self.assign(n, u).await;
        (n, u)
    }

    pub async fn used(&self, user: Uuid) -> i64 {
        sqlx::query_scalar("SELECT traffic_used_bytes FROM users WHERE id = $1")
            .bind(user)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// (config_version, user_version)
    pub async fn versions(&self, node: Uuid) -> (i64, i64) {
        sqlx::query_as("SELECT config_version, user_version FROM nodes WHERE id = $1")
            .bind(node)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// A LISTEN on the change channel (see notify.rs). Channels are
    /// database-wide: callers must filter by their own node ids.
    pub async fn listener(&self) -> sqlx::postgres::PgListener {
        let mut l = sqlx::postgres::PgListener::connect_with(&self.pool)
            .await
            .unwrap();
        l.listen(crate::notify::CHANNEL).await.unwrap();
        l
    }

    pub async fn drop(self) {
        self.pool.close().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA {} CASCADE",
            self.schema
        )))
        .execute(&self.admin)
        .await
        .unwrap();
    }
}
