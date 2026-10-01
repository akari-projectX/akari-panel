//! `akari-bench seed`: the M2 scale data set (default 200 nodes, 50k users,
//! 10k users per node) in its own database. Deterministic secrets (see
//! common.rs) let the load tools re-derive subscription and enrollment
//! tokens. Writes straight to the tables (a fresh install with no agent
//! connected: there is nothing to converge, so bypassing `apply_*` is
//! fine here and only here).

use std::time::Instant;

use anyhow::{bail, Context, Result};
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
    #[arg(long, default_value_t = true)]
    pub counters: bool,
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

fn inbounds(i: usize) -> serde_json::Value {
    serde_json::json!([
        {
            "tag": "in-vless",
            "protocol": "vless",
            "port": 443,
            "settings": {"decryption": "none"},
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
        },
        {
            "tag": "in-trojan",
            "protocol": "trojan",
            "port": 8443,
            "streamSettings": {
                "network": "ws",
                "security": "tls",
                "tlsSettings": {"serverName": format!("n{i}.example.com")},
                "wsSettings": {"path": "/t", "headers": {"Host": format!("n{i}.example.com")}}
            }
        }
    ])
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
    // Every user of group g on every node of group g (both numbered by
    // name order), one vless + one trojan credential per pair.
    let assigned = sqlx::query(
        "WITH n AS (SELECT id, (row_number() OVER (ORDER BY name) - 1) % $1 AS g FROM nodes), \
              u AS (SELECT id, (row_number() OVER (ORDER BY login) - 1) % $1 AS g FROM users \
                    WHERE login LIKE 'bench-user-%') \
         INSERT INTO node_users (node_id, user_id, credentials) \
         SELECT n.id, u.id, jsonb_build_array( \
             jsonb_build_object('inbound_tag', 'in-vless', 'protocol', 'vless', \
                 'account', jsonb_build_object('id', gen_random_uuid()::text, 'flow', 'xtls-rprx-vision')), \
             jsonb_build_object('inbound_tag', 'in-trojan', 'protocol', 'trojan', \
                 'account', jsonb_build_object('password', encode(gen_random_bytes(32), 'hex')))) \
         FROM n JOIN u USING (g)",
    )
    .bind(groups)
    .execute(&pg)
    .await?
    .rows_affected();
    println!("node_users: {assigned} rows in {:.1?}", t.elapsed());
    if args.counters {
        let t = Instant::now();
        let n = sqlx::query(
            "INSERT INTO traffic_counters (node_id, user_id, session_id, up_bytes, down_bytes, \
             updated_at, first_seen_at) \
             SELECT node_id, user_id, 'bench-old-session', 1000000, 5000000, \
                    now() - interval '3 days', now() - interval '10 days' FROM node_users",
        )
        .execute(&pg)
        .await?
        .rows_affected();
        println!("traffic_counters: {n} rows in {:.1?}", t.elapsed());
    }
    if args.audit > 0 {
        let t = Instant::now();
        let n = sqlx::query(
            "INSERT INTO audit_log (at, actor_login, ip, action, target_type, target_id, before, after) \
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

async fn seed_nodes(pg: &PgPool, count: usize) -> Result<()> {
    let ids: Vec<Uuid> = (0..count).map(|_| Uuid::new_v4()).collect();
    let names: Vec<String> = (0..count).map(common::node_name).collect();
    let inb: Vec<serde_json::Value> = (0..count).map(inbounds).collect();
    let addrs: Vec<String> = (0..count)
        .map(|i| format!("198.51.{}.{}", i / 250, 1 + i % 250))
        .collect();
    let mut tx = pg.begin().await?;
    sqlx::query(
        "INSERT INTO nodes (id, name, xray_inbounds, server_addr) \
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::jsonb[], $4::text[])",
    )
    .bind(&ids)
    .bind(&names)
    .bind(&inb)
    .bind(&addrs)
    .execute(&mut *tx)
    .await?;
    let hashes: Vec<Vec<u8>> = (0..count)
        .map(|i| akari_panel::enroll::hash_token(&common::enroll_token(i)))
        .collect();
    sqlx::query(
        "INSERT INTO node_enrollments (node_id, token_hash, expires_at) \
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
    let logins: Vec<String> = (0..count).map(common::user_login).collect();
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
        "INSERT INTO users (id, login, sub_token_hash, traffic_limit_bytes, expires_at, created_at) \
         SELECT id, login, h, l, e, now() - make_interval(secs => ord) \
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::bigint[], $5::timestamptz[]) \
              WITH ORDINALITY AS t(id, login, h, l, e, ord)",
    )
    .bind(&ids)
    .bind(&logins)
    .bind(&hashes)
    .bind(&limits)
    .bind(&expiry)
    .execute(pg)
    .await?;
    println!("users: {count} rows in {:.1?}", t.elapsed());
    Ok(())
}

/// The admin the load tool acts as (active placeholder TOTP, so its full
/// sessions are accepted) and the user that exercises the login path.
async fn seed_accounts(pg: &PgPool) -> Result<()> {
    let admin = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, login, role) VALUES ($1, $2, 'admin')")
        .bind(admin)
        .bind(common::ADMIN_LOGIN)
        .execute(pg)
        .await?;
    sqlx::query(
        "INSERT INTO user_totp (user_id, secret_enc, enabled_at) VALUES ($1, '\\x00', now())",
    )
    .bind(admin)
    .execute(pg)
    .await?;
    let hash = akari_panel::auth::hash_password(common::LOGIN_PASSWORD)?;
    sqlx::query("INSERT INTO users (id, login, password_hash) VALUES ($1, $2, $3)")
        .bind(Uuid::new_v4())
        .bind(common::LOGIN_USER)
        .bind(hash)
        .execute(pg)
        .await?;
    Ok(())
}
