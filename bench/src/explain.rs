//! `akari-bench explain`: EXPLAIN (ANALYZE, BUFFERS) of every hot query on
//! the seeded data set (M2-2). Everything runs in one transaction that is
//! rolled back, so data-modifying statements (the flush) leave no trace.
//! Shared SQL fragments come from the panel crate itself (FLUSH_SQL, view
//! columns, predicates); the short inline queries are copied verbatim from
//! the module named in each label — keep them in sync.

use anyhow::{Context, Result};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use akari_panel::{api, enforce, traffic};

use crate::common;

#[derive(clap::Args, Debug)]
pub struct ExplainArgs {
    #[arg(long, env = "BENCH_DATABASE_URL", default_value = common::DEFAULT_DB)]
    pub database_url: String,
    /// Print full plans (default: one summary line per query).
    #[arg(long)]
    pub plans: bool,
    /// Rows in the explained flush batch (default: one production chunk;
    /// a 50k-row single statement is planned differently and is not what
    /// the panel runs).
    #[arg(long, default_value_t = akari_panel::traffic::FLUSH_CHUNK_ROWS)]
    pub flush_rows: usize,
}

struct Ids {
    node: Uuid,
    user: Uuid,
    sub_hash: String,
    flush: Vec<(Uuid, Uuid)>,
}

async fn explain<'q>(
    tx: &mut Transaction<'static, Postgres>,
    plans: bool,
    label: &str,
    q: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
) -> Result<()> {
    let rows: Vec<String> = q
        .try_map(|r: sqlx::postgres::PgRow| {
            use sqlx::Row;
            r.try_get::<String, _>(0)
        })
        .fetch_all(&mut **tx)
        .await
        .with_context(|| format!("explain {label}"))?;
    let exec = rows
        .iter()
        .find(|l| l.trim_start().starts_with("Execution Time"))
        .map(|l| l.trim().to_string())
        .unwrap_or_default();
    let top = rows
        .first()
        .map(|l| l.trim().to_string())
        .unwrap_or_default();
    let seq = rows.iter().filter(|l| l.contains("Seq Scan")).count();
    println!(
        "{label:<34} {exec:<28} seq_scans={seq}  top: {}",
        truncate(&top, 90)
    );
    if plans {
        for l in &rows {
            println!("    {l}");
        }
    }
    Ok(())
}

fn truncate(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

pub async fn run(args: ExplainArgs) -> Result<()> {
    let pg = PgPoolOptions::new()
        .max_connections(1)
        .connect(&args.database_url)
        .await?;
    let ids = ids(&pg, args.flush_rows).await?;
    let mut tx = pg.begin().await?;
    let p = args.plans;
    const E: &str = "EXPLAIN (ANALYZE, BUFFERS) ";
    macro_rules! q {
        ($sql:expr) => {
            sqlx::query(sqlx::AssertSqlSafe(format!("{E}{}", $sql)))
        };
    }

    explain(
        &mut tx,
        p,
        "grpc::desired_state node",
        q!(
            "SELECT enabled, xray_inbounds, config_version, user_version, \
            failed_config_version, failed_user_version, failed_held_config_version, \
            failed_held_user_version, failed_reason, online_session, \
            deleting_at IS NOT NULL AS deleting FROM nodes WHERE id = $1"
        )
        .bind(ids.node),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "grpc::desired_state users",
        q!(format!(
            "SELECT nu.user_id, nu.credentials \
             FROM node_users nu JOIN users u ON u.id = nu.user_id \
             WHERE nu.node_id = $1 AND {} ORDER BY nu.user_id",
            enforce::SERVED
        ))
        .bind(ids.node),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "traffic::refresh_members",
        q!("SELECT user_id FROM node_users WHERE node_id = $1 \
            UNION SELECT user_id FROM node_users_departed \
            WHERE node_id = $1 AND departed_at > now() - make_interval(secs => $2)")
        .bind(ids.node)
        .bind(900f64),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "enforce over-limit candidates",
        q!(format!(
            "SELECT u.id FROM users u WHERE {} ORDER BY u.id",
            enforce::OVER_LIMIT
        )),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "enforce expiry candidates",
        q!(format!(
            "SELECT u.id FROM users u WHERE ({} AND NOT u.expiry_enforced) ORDER BY u.id",
            enforce::EXPIRED
        )),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "enforce lock_nodes_of_ids (1 user)",
        q!("SELECT id FROM nodes WHERE id IN (SELECT node_id FROM node_users WHERE user_id = ANY($1)) \
            ORDER BY id FOR UPDATE")
        .bind(vec![ids.user]),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "api::list_users page 1",
        q!(format!(
            "SELECT {} FROM users WHERE id IN (SELECT id FROM users \
             ORDER BY created_at, id LIMIT $1 OFFSET $2) ORDER BY created_at, id",
            api::USER_VIEW_COLS
        ))
        .bind(50i64)
        .bind(0i64),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "api::list_users offset 49000",
        q!(format!(
            "SELECT {} FROM users WHERE id IN (SELECT id FROM users \
             ORDER BY created_at, id LIMIT $1 OFFSET $2) ORDER BY created_at, id",
            api::USER_VIEW_COLS
        ))
        .bind(50i64)
        .bind(49_000i64),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "api::get_user",
        q!(format!(
            "SELECT {} FROM users WHERE id = $1",
            api::USER_VIEW_COLS
        ))
        .bind(ids.user),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "api::list_nodes",
        q!(format!(
            "SELECT {} {} ORDER BY sort, nodes.created_at, nodes.id",
            api::NODE_VIEW_COLS,
            api::NODE_VIEW_FROM
        )),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "api::list_nodes (view=summary, W17)",
        q!(format!(
            "SELECT {} {} ORDER BY sort, nodes.created_at, nodes.id",
            api::NODE_SUMMARY_COLS,
            api::NODE_SUMMARY_FROM
        )),
    )
    .await?;
    let audit = "SELECT id, at, actor_id, actor_login, ip, action, target_type, target_id, before, after \
                 FROM audit_log WHERE true";
    explain(
        &mut tx,
        p,
        "audit::list page 1",
        q!(format!("{audit} ORDER BY id DESC LIMIT $1")).bind(51i64),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "audit::list before (deep)",
        q!(format!("{audit} AND id < $1 ORDER BY id DESC LIMIT $2"))
            .bind(1000i64)
            .bind(51i64),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "audit::list action prefix",
        q!(format!(
            "WITH RECURSIVE acts AS ( \
               (SELECT action FROM audit_log ORDER BY action LIMIT 1) \
               UNION ALL \
               SELECT (SELECT a.action FROM audit_log a WHERE a.action > acts.action \
                       ORDER BY a.action LIMIT 1) \
               FROM acts WHERE acts.action IS NOT NULL) \
             SELECT e.* FROM (SELECT action FROM acts WHERE action IS NOT NULL \
                              AND left(action, $1) = $2) m \
             CROSS JOIN LATERAL ({audit} AND action >= m.action AND action <= m.action \
                                 ORDER BY action DESC, id DESC LIMIT $3) e \
             ORDER BY e.id DESC LIMIT $3"
        ))
        .bind(5i32)
        .bind("node.")
        .bind(51i64),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "audit::list actor",
        q!(format!(
            "{audit} AND actor_login >= $1 AND actor_login <= $1 \
             ORDER BY actor_login DESC, id DESC LIMIT $2"
        ))
        .bind("cli")
        .bind(51i64),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "sub::subscription user",
        q!(format!(
            "SELECT u.id, u.traffic_used_bytes, u.traffic_limit_bytes, u.expires_at \
             FROM users u WHERE u.sub_token_hash = $1 AND {}",
            enforce::SERVED
        ))
        .bind(&ids.sub_hash),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "sub::subscription nodes",
        q!(
            "SELECT n.name, n.xray_inbounds, n.server_addr, nu.credentials \
            FROM node_users nu \
            JOIN nodes n ON n.id = nu.node_id AND n.enabled = true \
            JOIN users u ON u.id = nu.user_id AND u.enabled = true \
            WHERE nu.user_id = $1"
        )
        .bind(ids.user),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "api::login",
        q!(format!(
            "SELECT u.id, u.login, u.role, u.enabled, u.password_hash, u.session_ver, {} AS expired, \
             t.secret_enc, t.last_step, \
             ARRAY(SELECT r.code_hash FROM user_recovery_codes r \
                   WHERE r.user_id = u.id AND r.used_at IS NULL ORDER BY r.code_hash) AS recovery, \
             EXTRACT(EPOCH FROM now())::bigint AS db_now \
             FROM users u LEFT JOIN user_totp t ON t.user_id = u.id AND t.enabled_at IS NOT NULL \
             WHERE u.login = $1",
            enforce::EXPIRED
        ))
        .bind(common::LOGIN_USER),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "auth::session (AuthUser)",
        q!(format!(
            "SELECT u.id, u.login, u.role, (u.enabled AND NOT {}) AS enabled, u.session_ver, \
             EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id AND t.enabled_at IS NOT NULL) \
             AS totp_active FROM users u WHERE u.id = $1",
            enforce::EXPIRED
        ))
        .bind(ids.user),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "traffic::RETIRE_SQL (1 node)",
        q!(traffic::RETIRE_SQL)
            .bind(ids.node)
            .bind(traffic::RETENTION_MARGIN_SECS as f64),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "traffic::DEAD_NODES_SQL",
        q!(traffic::DEAD_NODES_SQL),
    )
    .await?;

    // The flush: `flush_rows` (node, user) pairs of a new session.
    let n = ids.flush.len();
    let nodes: Vec<Uuid> = ids.flush.iter().map(|r| r.0).collect();
    let users: Vec<Uuid> = ids.flush.iter().map(|r| r.1).collect();
    let sessions: Vec<String> = (0..n).map(|i| format!("explain-{}", i % 7)).collect();
    let ups: Vec<i64> = vec![123_456; n];
    let downs: Vec<i64> = vec![654_321; n];
    let ages: Vec<f64> = vec![10.0; n];
    sqlx::query(
        "SELECT 1 FROM nodes WHERE id IN (SELECT DISTINCT unnest($1::uuid[])) \
         ORDER BY id FOR NO KEY UPDATE",
    )
    .bind(&nodes)
    .execute(&mut *tx)
    .await?;
    explain(
        &mut tx,
        p,
        &format!("traffic::FLUSH_SQL ({n} new rows)"),
        q!(traffic::FLUSH_SQL)
            .bind(&nodes)
            .bind(&users)
            .bind(&sessions)
            .bind(&ups)
            .bind(&downs)
            .bind(&ages)
            .bind(1_250_000_000i64)
            .bind(traffic::MIN_PLAUSIBLE_SECS)
            .bind(traffic::PLAUSIBLE_SLACK_SECS)
            .bind(900f64)
            .bind(1_250_000_000i64)
            .bind(120i64)
            .bind(traffic::DEPARTED_SLACK_SECS),
    )
    .await?;
    let ups2: Vec<i64> = vec![223_456; n];
    explain(
        &mut tx,
        p,
        &format!("traffic::FLUSH_SQL ({n} updates)"),
        q!(traffic::FLUSH_SQL)
            .bind(&nodes)
            .bind(&users)
            .bind(&sessions)
            .bind(&ups2)
            .bind(&downs)
            .bind(&ages)
            .bind(1_250_000_000i64)
            .bind(traffic::MIN_PLAUSIBLE_SECS)
            .bind(traffic::PLAUSIBLE_SLACK_SECS)
            .bind(900f64)
            .bind(1_250_000_000i64)
            .bind(120i64)
            .bind(traffic::DEPARTED_SLACK_SECS),
    )
    .await?;
    // W22: fold what the two flushes above staged into the daily tables,
    // then the retention rollup (nothing that old in a fresh seed: the
    // plan, not the volume).
    explain(
        &mut tx,
        p,
        &format!("traffic::COMPACT_SQL ({} staged rows)", 2 * n),
        q!(traffic::COMPACT_SQL).bind(50_000i64),
    )
    .await?;
    explain(
        &mut tx,
        p,
        "traffic::ROLLUP_SQL",
        q!(traffic::ROLLUP_SQL).bind(400i32).bind(10_000i64),
    )
    .await?;
    tx.rollback().await?;
    Ok(())
}

async fn ids(pg: &sqlx::PgPool, flush_rows: usize) -> Result<Ids> {
    let node: Uuid = sqlx::query_scalar("SELECT id FROM nodes ORDER BY name LIMIT 1")
        .fetch_one(pg)
        .await
        .context("no nodes: run akari-bench seed")?;
    let user: Uuid =
        sqlx::query_scalar("SELECT user_id FROM node_users WHERE node_id = $1 LIMIT 1")
            .bind(node)
            .fetch_one(pg)
            .await?;
    let flush: Vec<(Uuid, Uuid)> =
        sqlx::query_as("SELECT node_id, user_id FROM node_users ORDER BY random() LIMIT $1")
            .bind(flush_rows as i64)
            .fetch_all(pg)
            .await?;
    Ok(Ids {
        node,
        user,
        sub_hash: akari_panel::sub::hash_token(&common::sub_token(1)),
        flush,
    })
}
