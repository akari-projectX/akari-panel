//! Real-PostgreSQL test harness: each test gets a throwaway schema with all
//! migrations applied. Needs the dev database (`make dev-up`; DATABASE_URL
//! or the config default). AKARI_SKIP_DB_TESTS=1 skips DB tests.

use std::str::FromStr;

use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

pub mod fake_agent;
pub mod http;

/// Payloads received until the channel stays quiet for `quiet`.
pub async fn drain(l: &mut sqlx::postgres::PgListener, quiet: std::time::Duration) -> Vec<String> {
    let mut got = Vec::new();
    while let Ok(Ok(n)) = tokio::time::timeout(quiet, l.recv()).await {
        got.push(n.payload().to_string());
    }
    got
}

/// The address `TestDb::user`/`admin` give an account (D1: every account
/// has a unique email).
pub fn test_email(id: Uuid) -> String {
    format!("{}@test.invalid", id.simple())
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
        // W25: a node domain, like the grpc.advertise every test relied on
        // before it moved to 系统设置 (tokens need one). Tests of the unset
        // case clear it.
        sqlx::query(
            "INSERT INTO site_domains (kind, domain, host, preferred) \
             VALUES ('node', '127.0.0.1:8443', '127.0.0.1', true)",
        )
        .execute(&migrator)
        .await
        .unwrap();
        // v0.4: the minimum submit time is on by default; tests post forms
        // without a form token unless they test the bot protection
        // (`botguard::tests` turns it back on).
        sqlx::query("UPDATE auth_settings SET min_submit_secs = 0")
            .execute(&migrator)
            .await
            .unwrap();
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

    /// W25: write 系统设置 columns directly (`assignments` is SQL such as
    /// "main_domain = 'x.example'") and reload `state`'s view of them.
    pub async fn settings(&self, state: &crate::state::AppState, assignments: &str) {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE panel_settings SET {assignments}, version = version + 1 WHERE id = 1"
        )))
        .execute(&self.pool)
        .await
        .unwrap();
        crate::settings::reload(state).await.unwrap();
    }

    /// D8: `kind`'s domain list = `domains` (preferred first; [] = none),
    /// written directly, and `state`'s view reloaded.
    pub async fn domains(&self, state: &crate::state::AppState, kind: &str, domains: &[&str]) {
        sqlx::query("DELETE FROM site_domains WHERE kind = $1")
            .bind(kind)
            .execute(&self.pool)
            .await
            .unwrap();
        for (i, d) in domains.iter().enumerate() {
            let host = crate::settings::Domain::parse(d).unwrap().host;
            sqlx::query(
                "INSERT INTO site_domains (kind, domain, host, preferred) VALUES ($1, $2, $3, $4)",
            )
            .bind(kind)
            .bind(d)
            .bind(crate::settings::request_host(&host))
            .bind(i == 0)
            .execute(&self.pool)
            .await
            .unwrap();
        }
        crate::settings::reload(state).await.unwrap();
    }

    /// A plain enabled role=user account (email `<id>@test.invalid`).
    pub async fn user(&self) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, email) VALUES ($1, $2)")
            .bind(id)
            .bind(test_email(id))
            .execute(&self.pool)
            .await
            .unwrap();
        id
    }

    /// An enabled admin account (email `<id>@test.invalid`).
    pub async fn admin(&self) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, email, role) VALUES ($1, $2, 'admin')")
            .bind(id)
            .bind(test_email(id))
            .execute(&self.pool)
            .await
            .unwrap();
        id
    }

    /// R47: the owner (an enabled admin with `is_owner`).
    pub async fn owner(&self) -> Uuid {
        let id = self.admin().await;
        sqlx::query("UPDATE users SET is_owner = true WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .unwrap();
        id
    }

    /// A server (an agent identity, pending: no certificate) without nodes.
    pub async fn server(&self) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO servers (id, name) VALUES ($1, $2)")
            .bind(id)
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .unwrap();
        id
    }

    /// An enabled node with one vless inbound (and, like every node, its
    /// direct entrance) on a server of its own that shares the node's id —
    /// the shape of a node migrated by 1036, so a test may use the id as
    /// either. Tests of servers with several nodes use `node_on`.
    pub async fn node(&self) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO servers (id, name) VALUES ($1, $2)")
            .bind(id)
            .bind(id.to_string())
            .execute(&self.pool)
            .await
            .unwrap();
        self.insert_node(id, id, 1).await;
        id
    }

    /// Another enabled vless node on `server` (its own id; inbound port
    /// `port`, which must not clash on the server).
    pub async fn node_on(&self, server: Uuid, port: u16) -> Uuid {
        let id = Uuid::new_v4();
        self.insert_node(id, server, port).await;
        id
    }

    async fn insert_node(&self, id: Uuid, server: Uuid, port: u16) {
        sqlx::query(
            "INSERT INTO nodes (id, server_id, name, inbound) VALUES ($1, $2, $3, \
             jsonb_build_object('protocol', 'vless', 'port', $4::int))",
        )
        .bind(id)
        .bind(server)
        .bind(id.to_string())
        .bind(i32::from(port))
        .execute(&self.pool)
        .await
        .unwrap();
    }

    /// The server a node runs on.
    pub async fn server_of(&self, node: Uuid) -> Uuid {
        sqlx::query_scalar("SELECT server_id FROM nodes WHERE id = $1")
            .bind(node)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// The node's direct entrance.
    pub async fn direct(&self, node: Uuid) -> Uuid {
        sqlx::query_scalar("SELECT id FROM entrances WHERE node_id = $1 AND kind = 'direct'")
            .bind(node)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// A raw credential for `user` on the node's direct entrance (bypasses
    /// the plan reconcile; for tests of what a node serves and bills).
    pub async fn assign(&self, node: Uuid, user: Uuid) {
        sqlx::query(
            "INSERT INTO entrance_users (entrance_id, user_id, protocol, account) \
             SELECT id, $2, 'vless', '{\"id\":\"x\"}'::jsonb FROM entrances \
             WHERE node_id = $1 AND kind = 'direct'",
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

    /// (config_version, user_version) of a server, or of a node's server.
    pub async fn versions(&self, node: Uuid) -> (i64, i64) {
        sqlx::query_as(
            "SELECT config_version, user_version FROM servers \
             WHERE id = $1 OR id = (SELECT server_id FROM nodes WHERE id = $1)",
        )
        .bind(node)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    /// A LISTEN on the change channel (see notify.rs). Channels are
    /// database-wide: callers must filter by their own server ids.
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
