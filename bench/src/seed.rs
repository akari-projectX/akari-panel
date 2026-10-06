//! `akari-bench seed`: the M2 scale data set (default 200 nodes, 50k users,
//! 10k users per node) in its own database. Deterministic secrets (see
//! common.rs) let the load tools re-derive subscription and enrollment
//! tokens. Writes straight to the tables (a fresh install with no agent
//! connected: there is nothing to converge, so bypassing `apply_*` is
//! fine here and only here).

use std::time::Instant;

use anyhow::{Context, Result, bail};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool};
use uuid::Uuid;

use crate::common;

#[derive(clap::Args, Debug)]
pub struct SeedArgs {
    #[arg(long, env = "BENCH_DATABASE_URL", default_value = common::DEFAULT_DB)]
    pub database_url: String,
    #[arg(long, default_value_t = 200)]
    pub nodes: usize,
    #[arg(long, default_value_t = 50_000)]
    pub users: usize,
    /// Users assigned to each node (users are split into users/per_node
    /// groups; group g is assigned to every node n with n % groups == g).
    #[arg(long, default_value_t = 10_000)]
    pub per_node: usize,
    /// Audit rows (pagination at scale).
    #[arg(long, default_value_t = 200_000)]
    pub audit: usize,
    /// One old traffic_counters session row per assignment (the billing
    /// baseline a long-running install accumulates).
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    pub counters: bool,
    /// W22: days of per-day traffic history (traffic_daily, ending today
    /// in the site time zone) to seed; 0 = none.
    #[arg(long, default_value_t = 30)]
    pub history_days: u32,
    /// W22: nodes each user had traffic on per day (of its per-group nodes).
    #[arg(long, default_value_t = 2)]
    pub history_nodes_per_user: u32,
    /// Drop and recreate the bench database first.
    #[arg(long)]
    pub reset: bool,
}

/// Create the bench database if it does not exist (connects to the
/// server's `postgres` database for that).
pub async fn ensure_database(url: &str, reset: bool) -> Result<()> {
    let (base, name) = url
        .rsplit_once('/')
        .context("database url without a database name")?;
    let name = name.split('?').next().unwrap_or(name);
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        bail!("bench database name must be [A-Za-z0-9_]+, got {name:?}");
    }
    if name == "akari" {
        bail!("refusing to seed the dev/smoke database `akari`; use e.g. .../akari_bench");
    }
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&format!("{base}/postgres"))
        .await
        .context("connect to the server's postgres database")?;
    if reset {
        // name validated above: no injection surface.
        admin
            .execute(sqlx::AssertSqlSafe(format!(
                "DROP DATABASE IF EXISTS {name} WITH (FORCE)"
            )))
            .await?;
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)")
            .bind(name)
            .fetch_one(&admin)
            .await?;
    if !exists {
        admin
            .execute(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .await?;
    }
    admin.close().await;
    Ok(())
}

fn inbound(i: usize) -> serde_json::Value {
    serde_json::json!({
        "protocol": "vless",
        "port": 443,
        "settings": {"decryption": "none", "flow": "xtls-rprx-vision"},
        "streamSettings": {
            "network": "tcp",
            "security": "reality",
            "realitySettings": {
                "serverNames": [format!("n{i}.example.com")],
                "publicKey": "Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw",
                "shortId": "6ba85179e30d4fc2",
                "privateKey": "redacted-bench"
            }
        }
    })
}

pub async fn run(args: SeedArgs) -> Result<()> {
    if args.per_node == 0
        || args.users == 0
        || args.nodes == 0
        || !args.users.is_multiple_of(args.per_node)
    {
        bail!("users must be a positive multiple of per_node");
    }
    let groups = (args.users / args.per_node) as i64;
    ensure_database(&args.database_url, args.reset).await?;
    let pg = PgPoolOptions::new()
        .max_connections(4)
        .connect(&args.database_url)
        .await?;
    akari_panel::db::migrate(&pg).await?;
    let existing: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pg)
        .await?;
    if existing > 0 {
        bail!("bench database already holds {existing} users; pass --reset to start over");
    }
    let t0 = Instant::now();
    seed_nodes(&pg, args.nodes).await?;
    seed_users(&pg, args.users).await?;
    seed_accounts(&pg).await?;
    let t = Instant::now();
    // Every user of group g on the direct entrance of every node of group
    // g (both numbered by name order), one vless credential per pair.
    let assigned = sqlx::query(
        "WITH n AS (SELECT id, (row_number() OVER (ORDER BY name) - 1) % $1 AS g FROM nodes), \
              u AS (SELECT id, (row_number() OVER (ORDER BY email) - 1) % $1 AS g FROM users \
                    WHERE email LIKE 'bench-user-%') \
         INSERT INTO entrance_users (entrance_id, user_id, protocol, account) \
         SELECT e.id, u.id, 'vless', \
             jsonb_build_object('id', gen_random_uuid()::text, 'flow', 'xtls-rprx-vision') \
         FROM n JOIN u USING (g) JOIN entrances e ON e.node_id = n.id AND e.kind = 'direct'",
    )
    .bind(groups)
    .execute(&pg)
    .await?
    .rows_affected();
    println!("entrance_users: {assigned} rows in {:.1?}", t.elapsed());
    if args.counters {
        let t = Instant::now();
        let n = sqlx::query(
            "INSERT INTO traffic_counters (server_id, entrance_id, user_id, session_id, up_bytes, \
             down_bytes, updated_at, first_seen_at) \
             SELECT e.server_id, eu.entrance_id, eu.user_id, 'bench-old-session', 1000000, 5000000, \
                    now() - interval '3 days', now() - interval '10 days' \
             FROM entrance_users eu JOIN entrances e ON e.id = eu.entrance_id",
        )
        .execute(&pg)
        .await?
        .rows_affected();
        println!("traffic_counters: {n} rows in {:.1?}", t.elapsed());
    }
    if args.history_days > 0 && args.history_nodes_per_user > 0 {
        seed_history(&pg, &args, groups).await?;
    }
    if args.audit > 0 {
        let t = Instant::now();
        let n = sqlx::query(
            "INSERT INTO audit_log (at, actor_label, ip, action, target_type, target_id, before, after) \
             SELECT now() - make_interval(secs => ($1 - g)), \
                    CASE WHEN g % 10 = 0 THEN 'cli' ELSE 'bench-admin' END, '127.0.0.1', \
                    (ARRAY['user.update','user.create','node.update','user.assign','auth.login_failed'])[1 + g % 5], \
                    'user', gen_random_uuid()::text, '{\"enabled\": true}', '{\"enabled\": false}' \
             FROM generate_series(1, $1) g",
        )
        .bind(args.audit as i64)
        .execute(&pg)
        .await?
        .rows_affected();
        println!("audit_log: {n} rows in {:.1?}", t.elapsed());
    }
    pg.execute("VACUUM ANALYZE").await?;
    println!(
        "seeded {} nodes / {} users ({} per node) in {:.1?}",
        args.nodes,
        args.users,
        args.per_node,
        t0.elapsed()
    );
    Ok(())
}

/// W22: traffic history at scale: every user has traffic on
/// `history_nodes_per_user` distinct nodes of its group every day for
/// `history_days` days (deterministic per user and day), plus the matching
/// per-node daily rows.
async fn seed_history(pg: &PgPool, args: &SeedArgs, groups: i64) -> Result<()> {
    let per_group = (args.nodes as i64 / groups).max(1);
    let k = (args.history_nodes_per_user as i64).min(per_group);
    let t = Instant::now();
    let n = sqlx::query(
        "WITH n AS (SELECT id, (row_number() OVER (ORDER BY name) - 1) % $1 AS g,                            (row_number() OVER (ORDER BY name) - 1) / $1 AS r FROM nodes),               u AS (SELECT id, (row_number() OVER (ORDER BY email) - 1) % $1 AS g FROM users                     WHERE email LIKE 'bench-user-%'),               p AS (SELECT u.id AS user_id, u.g,                            akari_site_day(now()) - d AS day,                            abs(hashtextextended(u.id::text, d)) AS h                     FROM u CROSS JOIN generate_series(0, $3 - 1) d)          INSERT INTO traffic_daily (user_id, day, entrance_id, node_id, up_bytes, down_bytes, billed_bytes)          SELECT p.user_id, p.day, e.id, n.id, p.h % 50000000, (p.h % 50000000) * 4, (p.h % 50000000) * 5          FROM p CROSS JOIN LATERAL generate_series(0, $4 - 1) i          JOIN n ON n.g = p.g AND n.r = (p.h + i) % $2          JOIN entrances e ON e.node_id = n.id AND e.kind = 'direct'",
    )
    .bind(groups)
    .bind(per_group)
    .bind(args.history_days as i32)
    .bind(k)
    .execute(pg)
    .await?
    .rows_affected();
    let m = sqlx::query(
        "INSERT INTO traffic_entrance_daily (entrance_id, day, node_id, up_bytes, down_bytes, billed_bytes, users)          SELECT entrance_id, day, node_id, sum(up_bytes), sum(down_bytes), sum(billed_bytes), count(*)          FROM traffic_daily GROUP BY 1, 2, 3",
    )
    .execute(pg)
    .await?
    .rows_affected();
    println!(
        "traffic history: {n} daily rows, {m} entrance-day rows in {:.1?}",
        t.elapsed()
    );
    Ok(())
}

async fn seed_nodes(pg: &PgPool, count: usize) -> Result<()> {
    let ids: Vec<Uuid> = (0..count).map(|_| Uuid::new_v4()).collect();
    let names: Vec<String> = (0..count).map(common::node_name).collect();
    let inb: Vec<serde_json::Value> = (0..count).map(inbound).collect();
    let addrs: Vec<String> = (0..count)
        .map(|i| format!("198.51.{}.{}", i / 250, 1 + i % 250))
        .collect();
    let mut tx = pg.begin().await?;
    // Q1: one server per node, sharing its id (one agent per node).
    sqlx::query("INSERT INTO servers (id, name) SELECT * FROM unnest($1::uuid[], $2::text[])")
        .bind(&ids)
        .bind(&names)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO nodes (id, server_id, name, inbound) \
         SELECT t.id, t.id, t.name, t.inbound \
         FROM unnest($1::uuid[], $2::text[], $3::jsonb[]) AS t(id, name, inbound)",
    )
    .bind(&ids)
    .bind(&names)
    .bind(&inb)
    .execute(&mut *tx)
    .await?;
    // The direct entrances (created with the nodes) carry the address.
    sqlx::query(
        "UPDATE entrances e SET connect_host = t.a \
         FROM unnest($1::uuid[], $2::text[]) AS t(id, a) WHERE e.node_id = t.id",
    )
    .bind(&ids)
    .bind(&addrs)
    .execute(&mut *tx)
    .await?;
    let hashes: Vec<Vec<u8>> = (0..count)
        .map(|i| akari_panel::enroll::hash_token(&common::enroll_token(i)))
        .collect();
    sqlx::query(
        "INSERT INTO server_enrollments (server_id, token_hash, expires_at) \
         SELECT id, h, now() + interval '30 days' FROM unnest($1::uuid[], $2::bytea[]) AS t(id, h)",
    )
    .bind(&ids)
    .bind(&hashes)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn seed_users(pg: &PgPool, count: usize) -> Result<()> {
    let t = Instant::now();
    let ids: Vec<Uuid> = (0..count).map(|_| Uuid::new_v4()).collect();
    let emails: Vec<String> = (0..count).map(common::user_email).collect();
    let hashes: Vec<String> = (0..count)
        .map(|i| akari_panel::sub::hash_token(&common::sub_token(i)))
        .collect();
    // A fifth of the users have a traffic limit, a fifth an expiry in the
    // future (the enforcement predicates scan for both).
    let limits: Vec<Option<i64>> = (0..count)
        .map(|i| (i % 5 == 1).then_some(1 << 40))
        .collect();
    let expiry: Vec<Option<chrono::DateTime<chrono::Utc>>> = (0..count)
        .map(|i| (i % 5 == 2).then(|| chrono::Utc::now() + chrono::Duration::days(30)))
        .collect();
    sqlx::query(
        "INSERT INTO users (id, email, sub_token_hash, traffic_limit_bytes, expires_at, created_at) \
         SELECT id, email, h, l, e, now() - make_interval(secs => ord) \
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::bigint[], $5::timestamptz[]) \
              WITH ORDINALITY AS t(id, email, h, l, e, ord)",
    )
    .bind(&ids)
    .bind(&emails)
    .bind(&hashes)
    .bind(&limits)
    .bind(&expiry)
    .execute(pg)
    .await?;
    println!("users: {count} rows in {:.1?}", t.elapsed());
    Ok(())
}

/// The admin the load tool acts as and the user that exercises the login
/// path.
async fn seed_accounts(pg: &PgPool) -> Result<()> {
    sqlx::query("INSERT INTO users (id, email, role) VALUES ($1, $2, 'admin')")
        .bind(Uuid::new_v4())
        .bind(common::ADMIN_EMAIL)
        .execute(pg)
        .await?;
    let hash = akari_panel::auth::hash_password(common::LOGIN_PASSWORD)?;
    sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)")
        .bind(Uuid::new_v4())
        .bind(common::LOGIN_USER)
        .bind(hash)
        .execute(pg)
        .await?;
    // The tools post logins straight from code: no form token / minimum
    // submit time (the settings row is still read per login, as in
    // production).
    sqlx::query("UPDATE auth_settings SET honeypot = false, min_submit_secs = 0")
        .execute(pg)
        .await?;
    Ok(())
}
