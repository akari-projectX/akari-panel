//! `akari-bench http`: closed-loop HTTP load against a running panel on
//! the seeded data set. Each scenario runs `concurrency` workers for
//! `duration` and reports latency percentiles (client side, loopback).
//!
//! The admin session is minted directly with data/jwt.key for the seeded
//! admin (its TOTP is a placeholder, so it cannot log in): the extractor
//! path (`AuthUser`: JWT + one DB lookup) is exactly what a logged-in
//! admin's requests run.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use hdrhistogram::Histogram;
use rand::Rng;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

use crate::common;

#[derive(clap::Args, Debug, Clone)]
pub struct HttpArgs {
    #[arg(long, env = "BENCH_DATABASE_URL", default_value = common::DEFAULT_DB)]
    pub database_url: String,
    /// The panel's data dir (route prefix, jwt.key).
    #[arg(long, default_value = "bench/data")]
    pub data_dir: PathBuf,
    /// Panel web base URL(s); several = round-robin per request.
    #[arg(long, default_value = "http://127.0.0.1:18080")]
    pub url: Vec<String>,
    #[arg(long, default_value_t = 16)]
    pub concurrency: usize,
    #[arg(long, default_value_t = 15)]
    pub seconds: u64,
    /// Scenarios to run (default: all but login).
    #[arg(long, value_delimiter = ',')]
    pub only: Vec<String>,
    /// Seeded user count (subscription tokens are derived from 0..users).
    #[arg(long, default_value_t = 50_000)]
    pub users: usize,
}

#[derive(Clone, Copy, Debug)]
enum Scenario {
    Healthz,
    Me,
    UsersFirstPage,
    UsersDeepPage,
    UserPatch,
    Nodes,
    NodesSummary,
    NodesEtag,
    AuditFirstPage,
    AuditDeepPage,
    AuditActionPrefix,
    SubClash,
    SubLinks,
    Login,
    // W22 traffic history (30 days by default).
    TrafficUser,
    TrafficUserNodes,
    TrafficNode,
    TrafficSummary,
    TrafficMe,
}

impl Scenario {
    const ALL: [Scenario; 19] = [
        Scenario::Healthz,
        Scenario::Me,
        Scenario::UsersFirstPage,
        Scenario::UsersDeepPage,
        Scenario::UserPatch,
        Scenario::Nodes,
        Scenario::NodesSummary,
        Scenario::NodesEtag,
        Scenario::AuditFirstPage,
        Scenario::AuditDeepPage,
        Scenario::AuditActionPrefix,
        Scenario::SubClash,
        Scenario::SubLinks,
        Scenario::Login,
        Scenario::TrafficUser,
        Scenario::TrafficUserNodes,
        Scenario::TrafficNode,
        Scenario::TrafficSummary,
        Scenario::TrafficMe,
    ];

    fn name(self) -> &'static str {
        match self {
            Scenario::Healthz => "healthz",
            Scenario::Me => "me",
            Scenario::UsersFirstPage => "users_page1",
            Scenario::UsersDeepPage => "users_deep",
            Scenario::UserPatch => "user_patch",
            Scenario::Nodes => "nodes",
            // W17: the console's list (summary view), cold and revalidated
            // (If-None-Match with the last ETag, as the browser does).
            Scenario::NodesSummary => "nodes_summary",
            Scenario::NodesEtag => "nodes_etag",
            Scenario::AuditFirstPage => "audit_page1",
            Scenario::AuditDeepPage => "audit_deep",
            Scenario::AuditActionPrefix => "audit_prefix",
            Scenario::SubClash => "sub_clash",
            Scenario::SubLinks => "sub_links",
            Scenario::Login => "login",
            Scenario::TrafficUser => "traffic_user",
            Scenario::TrafficUserNodes => "traffic_user_nodes",
            Scenario::TrafficNode => "traffic_node",
            Scenario::TrafficSummary => "traffic_summary",
            Scenario::TrafficMe => "traffic_me",
        }
    }
}

struct Ctx {
    client: reqwest::Client,
    urls: Vec<String>,
    prefix: String,
    cookie: String,
    users: usize,
    user_ids: Vec<Uuid>,
    max_audit_id: i64,
    /// W17: the last ETag of the summary list (nodes_etag).
    etag: std::sync::Mutex<String>,
    /// W22: node ids and user session cookies (traffic_node / traffic_me).
    node_ids: Vec<Uuid>,
    user_cookies: Vec<String>,
}

impl Ctx {
    fn base(&self, i: usize) -> String {
        format!("{}/{}", self.urls[i % self.urls.len()], self.prefix)
    }
}

/// A full-stage session cookie for the seeded admin, signed with jwt.key.
pub async fn admin_cookie(pg: &sqlx::PgPool, data_dir: &std::path::Path) -> Result<String> {
    let secret = std::fs::read_to_string(data_dir.join("jwt.key"))
        .with_context(|| format!("read {}/jwt.key (start the panel once)", data_dir.display()))?;
    let (id, sv): (Uuid, i64) =
        sqlx::query_as("SELECT id, session_ver FROM users WHERE login = $1")
            .bind(common::ADMIN_LOGIN)
            .fetch_one(pg)
            .await
            .context("seeded admin missing (akari-bench seed)")?;
    session_cookie(&secret, id, "admin", sv)
}

/// A full-stage session cookie for any account, signed with jwt.key.
pub fn session_cookie(secret: &str, id: Uuid, role: &str, sv: i64) -> Result<String> {
    let now = chrono::Utc::now().timestamp() as u64;
    let claims = akari_panel::auth::Claims {
        sub: id,
        role: role.into(),
        sv,
        st: akari_panel::auth::Stage::Full,
        iat: now,
        exp: now + 3600,
    };
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.trim().as_bytes()),
    )?;
    Ok(format!("{}={token}", akari_panel::auth::COOKIE_NAME))
}

pub fn route_prefix(data_dir: &std::path::Path) -> Result<String> {
    let s = std::fs::read_to_string(data_dir.join("state.json"))
        .with_context(|| format!("read {}/state.json", data_dir.display()))?;
    let v: serde_json::Value = serde_json::from_str(&s)?;
    v.get("route_prefix")
        .and_then(|p| p.as_str())
        .map(str::to_owned)
        .context("state.json without route_prefix")
}

pub async fn run(args: HttpArgs) -> Result<()> {
    let pg = PgPoolOptions::new()
        .max_connections(2)
        .connect(&args.database_url)
        .await?;
    let user_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE login LIKE 'bench-user-%' LIMIT 5000")
            .fetch_all(&pg)
            .await?;
    let max_audit_id: i64 = sqlx::query_scalar("SELECT coalesce(max(id), 0) FROM audit_log")
        .fetch_one(&pg)
        .await?;
    let node_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM nodes")
        .fetch_all(&pg)
        .await?;
    let secret = std::fs::read_to_string(args.data_dir.join("jwt.key"))
        .with_context(|| format!("read {}/jwt.key", args.data_dir.display()))?;
    let sessions: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT id, session_ver FROM users WHERE login LIKE 'bench-user-%' ORDER BY random() LIMIT 500",
    )
    .fetch_all(&pg)
    .await?;
    let user_cookies = sessions
        .into_iter()
        .map(|(id, sv)| session_cookie(&secret, id, "user", sv))
        .collect::<Result<Vec<_>>>()?;
    let ctx = Arc::new(Ctx {
        client: reqwest::Client::builder()
            .no_proxy()
            .pool_max_idle_per_host(args.concurrency * 2)
            .timeout(Duration::from_secs(30))
            .build()?,
        urls: args.url.clone(),
        prefix: route_prefix(&args.data_dir)?,
        cookie: admin_cookie(&pg, &args.data_dir).await?,
        users: args.users,
        user_ids,
        max_audit_id,
        etag: std::sync::Mutex::new(String::new()),
        node_ids,
        user_cookies,
    });
    pg.close().await;
    let selected: Vec<Scenario> = if args.only.is_empty() {
        Scenario::ALL
            .into_iter()
            .filter(|s| !matches!(s, Scenario::Login))
            .collect()
    } else {
        let mut v = Vec::new();
        for name in &args.only {
            match Scenario::ALL.into_iter().find(|s| s.name() == name) {
                Some(s) => v.push(s),
                None => bail!("unknown scenario {name:?}"),
            }
        }
        v
    };
    println!(
        "http load: {} worker(s) x {}s per scenario against {:?}",
        args.concurrency, args.seconds, args.url
    );
    for s in selected {
        // Login is argon2-bound by design: fewer workers.
        let conc = if matches!(s, Scenario::Login) {
            args.concurrency.min(4)
        } else {
            args.concurrency
        };
        let (h, errors, elapsed) =
            scenario(ctx.clone(), s, conc, Duration::from_secs(args.seconds)).await?;
        println!(
            "{:<13} {:>8.0} req/s  errors={errors}  {}",
            s.name(),
            h.len() as f64 / elapsed.as_secs_f64(),
            common::summary(&h)
        );
    }
    Ok(())
}

async fn scenario(
    ctx: Arc<Ctx>,
    s: Scenario,
    concurrency: usize,
    duration: Duration,
) -> Result<(Histogram<u64>, u64, Duration)> {
    // Warm up connections and caches.
    for i in 0..concurrency.max(4) {
        let _ = request(&ctx, s, i).await;
    }
    let start = Instant::now();
    let deadline = start + duration;
    let mut tasks = Vec::new();
    for w in 0..concurrency {
        let ctx = ctx.clone();
        tasks.push(tokio::spawn(async move {
            let mut h = common::histogram()?;
            let mut errors = 0u64;
            let mut i = w;
            while Instant::now() < deadline {
                let t = Instant::now();
                let ok = request(&ctx, s, i).await;
                common::record(&mut h, t.elapsed());
                if !ok {
                    errors += 1;
                }
                i += concurrency;
            }
            anyhow::Ok((h, errors))
        }));
    }
    let mut all = common::histogram()?;
    let mut errors = 0;
    for t in tasks {
        let (h, e) = t.await??;
        all.add(&h)?;
        errors += e;
    }
    Ok((all, errors, start.elapsed()))
}

/// One request; true on the expected status.
async fn request(ctx: &Ctx, s: Scenario, i: usize) -> bool {
    let base = ctx.base(i);
    let admin = |path: String| {
        ctx.client
            .get(format!("{base}/api/v1/{path}"))
            .header(reqwest::header::COOKIE, &ctx.cookie)
    };
    // ThreadRng is !Send: confine it to this synchronous block.
    let req = {
        let mut rng = rand::rng();
        match s {
            // No auth, no database: the HTTP stack's floor.
            Scenario::Healthz => ctx.client.get(format!("{base}/healthz")),
            Scenario::Me => admin("me".into()),
            Scenario::UsersFirstPage => admin("users?limit=50".into()),
            Scenario::UsersDeepPage => admin(format!(
                "users?limit=50&offset={}",
                rng.random_range(0..ctx.users.max(1))
            )),
            Scenario::UserPatch => {
                // A write: apply_update_user + audit row in one transaction.
                let Some(id) = ctx
                    .user_ids
                    .get(rng.random_range(0..ctx.user_ids.len().max(1)))
                else {
                    return false;
                };
                ctx.client
                    .patch(format!("{base}/api/v1/users/{id}"))
                    .header(reqwest::header::COOKIE, &ctx.cookie)
                    .json(&serde_json::json!({
                        "traffic_limit_bytes": rng.random_range(1i64 << 40..1i64 << 41)
                    }))
            }
            Scenario::Nodes => admin("nodes".into()),
            Scenario::NodesSummary => admin("nodes?view=summary".into()),
            Scenario::NodesEtag => {
                let tag = ctx.etag.lock().map(|t| t.clone()).unwrap_or_default();
                admin("nodes?view=summary".into()).header(reqwest::header::IF_NONE_MATCH, tag)
            }
            Scenario::AuditFirstPage => admin("audit?limit=50".into()),
            Scenario::AuditDeepPage => admin(format!(
                "audit?limit=50&before={}",
                rng.random_range(1..ctx.max_audit_id.max(2))
            )),
            Scenario::AuditActionPrefix => admin("audit?limit=50&action=node.".into()),
            Scenario::SubClash | Scenario::SubLinks => {
                let ua = if matches!(s, Scenario::SubClash) {
                    "clash-verge/v2"
                } else {
                    "v2rayN/7"
                };
                ctx.client
                    .get(format!(
                        "{base}/sub/{}",
                        common::sub_token(rng.random_range(0..ctx.users.max(1)))
                    ))
                    .header(reqwest::header::USER_AGENT, ua)
            }
            Scenario::TrafficUser | Scenario::TrafficUserNodes => {
                let Some(id) = ctx
                    .user_ids
                    .get(rng.random_range(0..ctx.user_ids.len().max(1)))
                else {
                    return false;
                };
                let group = if matches!(s, Scenario::TrafficUser) {
                    "day"
                } else {
                    "node"
                };
                admin(format!("users/{id}/traffic?group={group}"))
            }
            Scenario::TrafficNode => {
                let Some(id) = ctx
                    .node_ids
                    .get(rng.random_range(0..ctx.node_ids.len().max(1)))
                else {
                    return false;
                };
                admin(format!("nodes/{id}/traffic"))
            }
            Scenario::TrafficSummary => admin("traffic/summary".into()),
            Scenario::TrafficMe => {
                let Some(c) = ctx
                    .user_cookies
                    .get(rng.random_range(0..ctx.user_cookies.len().max(1)))
                else {
                    return false;
                };
                ctx.client
                    .get(format!("{base}/api/v1/me/traffic"))
                    .header(reqwest::header::COOKIE, c)
            }
            Scenario::Login => {
                ctx.client
                    .post(format!("{base}/auth/login"))
                    .json(&serde_json::json!({
                        "login": common::LOGIN_USER,
                        "password": common::LOGIN_PASSWORD,
                    }))
            }
        }
    };
    match req.send().await {
        Ok(r) => {
            if matches!(s, Scenario::NodesEtag) {
                if let Some(t) = r.headers().get(reqwest::header::ETAG) {
                    if let (Ok(mut slot), Ok(t)) = (ctx.etag.lock(), t.to_str()) {
                        *slot = t.to_string();
                    }
                }
                let ok = r.status().is_success() || r.status() == reqwest::StatusCode::NOT_MODIFIED;
                let _ = r.bytes().await;
                return ok;
            }
            let ok = r.status().is_success();
            // Read the body: the latency includes the full response.
            let _ = r.bytes().await;
            ok
        }
        Err(_) => false,
    }
}
