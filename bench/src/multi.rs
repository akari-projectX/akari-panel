//! `akari-bench multi`: cross-instance correctness checks for two panel
//! instances on one PostgreSQL/Valkey (M2-4). Run with both instances up
//! (bench/panel-bench-1.toml, -2.toml) after `swarm` enrolled the agents:
//!
//! 1. session revocation: a session logged in on A works on B; logout on
//!    A ends it on B at once;
//! 2. login limit: failed logins alternating A/B share one budget;
//! 3. supersede: the same agent identity on A, then on B: B serves it and
//!    A's stream is ended;
//! 4. node deletion: deleted through A's API while its agent streams to B:
//!    the agent gets the empty state, the reaper (any instance) deletes
//!    the node, the stream is closed, and the revoked certificate is
//!    served the empty state and closed on reconnect.

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::Streaming;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Identity};

use akari_panel::grpc::{NodeState, state_hash};
use akari_panel::pb::agent_channel_client::AgentChannelClient;
use akari_panel::pb::agent_up::Msg as UpMsg;
use akari_panel::pb::panel_down::Msg as DownMsg;
use akari_panel::pb::{Ack, AgentUp, ConfigSnapshot, Hello, PanelDown, ack};

use crate::common;

#[derive(clap::Args, Debug)]
pub struct MultiArgs {
    #[arg(long, env = "BENCH_DATABASE_URL", default_value = common::DEFAULT_DB)]
    pub database_url: String,
    #[arg(long, default_value = "bench/data")]
    pub data_dir: std::path::PathBuf,
    #[arg(long, default_value = "bench/data/swarm")]
    pub state_dir: std::path::PathBuf,
    /// Web base URLs of instance A and B.
    #[arg(long, default_value = "http://127.0.0.1:18080")]
    pub web_a: String,
    #[arg(long, default_value = "http://127.0.0.1:18081")]
    pub web_b: String,
    /// gRPC addresses of instance A and B.
    #[arg(long, default_value = "127.0.0.1:18443")]
    pub grpc_a: String,
    #[arg(long, default_value = "127.0.0.1:18444")]
    pub grpc_b: String,
    /// Agent used for the supersede check.
    #[arg(long, default_value_t = 0)]
    pub supersede_agent: usize,
    /// Agent whose node is DELETED (use one the swarm no longer needs).
    #[arg(long, default_value_t = 199)]
    pub delete_agent: usize,
}

#[derive(serde::Deserialize)]
struct Creds {
    cert: String,
    key: String,
    ca: String,
}

struct Probe {
    up: mpsc::Sender<AgentUp>,
    down: Streaming<PanelDown>,
}

impl Probe {
    async fn connect(addr: &str, c: &Creds) -> Result<Self> {
        let tls = ClientTlsConfig::new()
            .ca_certificate(Certificate::from_pem(&c.ca))
            .identity(Identity::from_pem(&c.cert, &c.key))
            .domain_name("localhost");
        let channel = Channel::from_shared(format!("https://{addr}"))?
            .tls_config(tls)?
            .connect()
            .await?;
        let (up, rx) = mpsc::channel(16);
        let down = AgentChannelClient::new(channel)
            .max_decoding_message_size(64 << 20)
            .open_channel(ReceiverStream::new(rx))
            .await?
            .into_inner();
        Ok(Self { up, down })
    }

    async fn send(&self, m: UpMsg) -> Result<()> {
        self.up
            .send(AgentUp { msg: Some(m) })
            .await
            .map_err(|_| anyhow::anyhow!("stream closed"))
    }

    async fn hello(&self, held: (u64, u64), hash: String) -> Result<()> {
        self.send(UpMsg::Hello(Hello {
            session_id: uuid::Uuid::new_v4().to_string(),
            config_version: held.0,
            user_version: held.1,
            protocol_version: 2,
            state_hash: hash,
            ..Default::default()
        }))
        .await
    }

    /// Next Snapshot/Delta (leases and noops skipped); Err = stream ended
    /// (with its status) or `wait` passed.
    async fn next(&mut self, wait: Duration) -> Result<DownMsg, String> {
        let deadline = Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, self.down.message()).await {
                Err(_) => return Err("timeout".into()),
                Ok(Err(st)) => return Err(format!("status {:?}", st.code())),
                Ok(Ok(None)) => return Err("closed".into()),
                Ok(Ok(Some(PanelDown {
                    msg: Some(m @ (DownMsg::Snapshot(_) | DownMsg::Delta(_))),
                }))) => return Ok(m),
                Ok(Ok(Some(_))) => continue,
            }
        }
    }

    async fn ack(&self, s: &ConfigSnapshot) -> Result<()> {
        let v = (s.config_version, s.user_version);
        self.send(UpMsg::Ack(Ack {
            config_version: v.0,
            user_version: v.1,
            ok: true,
            reason: ack::Reason::Ok as i32,
            held_config_version: v.0,
            held_user_version: v.1,
            state_hash: hash(s),
            error: String::new(),
        }))
        .await
    }
}

fn hash(s: &ConfigSnapshot) -> String {
    state_hash(
        s.config_version,
        &NodeState::of_snapshot(s.inbounds_json.clone(), &s.users),
    )
}

fn creds(dir: &std::path::Path, i: usize) -> Result<Creds> {
    let p = dir.join(format!("agent-{i:03}.json"));
    let s = std::fs::read_to_string(&p)
        .with_context(|| format!("{} (run `akari-bench swarm` first)", p.display()))?;
    Ok(serde_json::from_str(&s)?)
}

fn check(ok: bool, what: &str) -> Result<()> {
    println!("{} {what}", if ok { "PASS" } else { "FAIL" });
    if ok {
        Ok(())
    } else {
        bail!("multi-instance check failed: {what}")
    }
}

pub async fn run(a: MultiArgs) -> Result<()> {
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()?;
    let prefix = crate::load::route_prefix(&a.data_dir)?;
    let (pa, pb) = (
        format!("{}/{prefix}", a.web_a),
        format!("{}/{prefix}", a.web_b),
    );

    // 1. Session revocation across instances.
    let login = http
        .post(format!("{pa}/auth/login"))
        .json(&serde_json::json!({"email": common::LOGIN_USER, "password": common::LOGIN_PASSWORD}))
        .send()
        .await?;
    let cookie = login
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.starts_with(akari_panel::auth::COOKIE_NAME))
        .and_then(|v| v.split(';').next())
        .map(str::to_owned)
        .context("login on A set no session cookie")?;
    let me = |base: String| {
        let (http, cookie) = (http.clone(), cookie.clone());
        async move {
            http.get(format!("{base}/api/v1/me"))
                .header(reqwest::header::COOKIE, cookie)
                .send()
                .await
                .map(|r| r.status().as_u16())
        }
    };
    check(me(pb.clone()).await? == 200, "session from A accepted on B")?;
    let out = http
        .post(format!("{pa}/auth/logout"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await?;
    check(out.status().is_success(), "logout on A")?;
    check(
        me(pb.clone()).await? == 401,
        "logged-out session refused on B at once",
    )?;

    // 2. Login limit shared across instances (address bucket: 20 failed
    // attempts per window, then 429 on every instance).
    let mut statuses = Vec::new();
    for i in 0..24 {
        let base = if i % 2 == 0 { &pa } else { &pb };
        let r = http
            .post(format!("{base}/auth/login"))
            .json(&serde_json::json!({"email": common::LOGIN_USER, "password": "wrong"}))
            .send()
            .await?;
        statuses.push(r.status().as_u16());
    }
    let first_429 = statuses.iter().position(|s| *s == 429);
    println!("     failed-login statuses (A/B alternating): {statuses:?}");
    check(
        first_429 == Some(20) && statuses[20..].iter().all(|s| *s == 429),
        "20 failures across both instances, then 429 on both",
    )?;

    // 3. Supersede across instances.
    let c = creds(&a.state_dir, a.supersede_agent)?;
    let mut on_a = Probe::connect(&a.grpc_a, &c).await?;
    on_a.hello((0, 0), String::new()).await?;
    let snap = match on_a.next(Duration::from_secs(10)).await {
        Ok(DownMsg::Snapshot(s)) => s,
        other => bail!("A: expected a snapshot, got {:?}", other.map(|_| ())),
    };
    on_a.ack(&snap).await?;
    let mut on_b = Probe::connect(&a.grpc_b, &c).await?;
    on_b.hello((snap.config_version, snap.user_version), hash(&snap))
        .await?;
    let t = Instant::now();
    // B verified the Hello hash: nothing to send. A must end its stream
    // (it learns from the database on its next read: notify or the 60 s
    // reconcile tick).
    let ended = loop {
        match on_a.next(Duration::from_secs(75)).await {
            Ok(_) => continue,
            Err(e) => break e,
        }
    };
    println!("     A's stream ended after {:.1?}: {ended}", t.elapsed());
    check(
        ended != "timeout" && t.elapsed() < Duration::from_secs(75),
        "A's stream superseded by B's",
    )?;
    let b_alive = matches!(on_b.next(Duration::from_secs(2)).await, Err(e) if e == "timeout");
    check(b_alive, "B's stream still served")?;
    drop(on_b);

    // 4. Node deletion through A while the agent streams to B.
    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&a.database_url)
        .await?;
    let node: uuid::Uuid =
        sqlx::query_scalar("SELECT node_id FROM node_enrollments WHERE token_hash = $1")
            .bind(akari_panel::enroll::hash_token(&common::enroll_token(
                a.delete_agent,
            )))
            .fetch_one(&pg)
            .await
            .context("node of the delete agent")?;
    let c = creds(&a.state_dir, a.delete_agent)?;
    let mut ag = Probe::connect(&a.grpc_b, &c).await?;
    ag.hello((0, 0), String::new()).await?;
    let snap = match ag.next(Duration::from_secs(10)).await {
        Ok(DownMsg::Snapshot(s)) => s,
        other => bail!("expected a snapshot, got {:?}", other.map(|_| ())),
    };
    ag.ack(&snap).await?;
    let admin = crate::load::admin_cookie(&pg, &a.data_dir).await?;
    let t = Instant::now();
    let del = http
        .delete(format!("{pa}/api/v1/nodes/{node}"))
        .header(reqwest::header::COOKIE, &admin)
        .send()
        .await?;
    check(
        del.status().as_u16() == 202,
        "DELETE node on A accepted (202)",
    )?;
    let empty = match ag.next(Duration::from_secs(10)).await {
        Ok(DownMsg::Snapshot(s)) => s,
        other => bail!("expected the empty snapshot, got {:?}", other.map(|_| ())),
    };
    println!(
        "     empty state reached the agent on B after {:.1?}",
        t.elapsed()
    );
    check(
        empty.inbounds_json == "[]" && empty.users.is_empty(),
        "deleting node converges to the empty state",
    )?;
    ag.ack(&empty).await?;
    let closed = loop {
        match ag.next(Duration::from_secs(60)).await {
            Ok(_) => continue,
            Err(e) => break e,
        }
    };
    let gone: bool = sqlx::query_scalar("SELECT NOT EXISTS (SELECT 1 FROM nodes WHERE id = $1)")
        .bind(node)
        .fetch_one(&pg)
        .await?;
    println!(
        "     stream ended {:.1?} after DELETE: {closed}",
        t.elapsed()
    );
    check(
        gone && closed.contains("Unauthenticated"),
        "reaper deleted the node and the stream was closed",
    )?;
    let mut again = Probe::connect(&a.grpc_a, &c).await?;
    again.hello((0, 0), String::new()).await?;
    let first = again.next(Duration::from_secs(15)).await;
    let ok = match first {
        Ok(DownMsg::Snapshot(s)) if s.inbounds_json == "[]" && s.users.is_empty() => {
            again.ack(&s).await?;
            matches!(again.next(Duration::from_secs(20)).await, Err(e) if e.contains("Unauthenticated"))
        }
        Err(e) => e.contains("Unauthenticated"),
        _ => false,
    };
    check(ok, "revoked certificate: empty state, then closed")?;
    println!("all multi-instance checks passed");
    Ok(())
}
