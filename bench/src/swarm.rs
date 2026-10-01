//! `akari-bench swarm`: N fake agents speaking the real control protocol
//! over mTLS (enrolled through AgentEnrollment with the seeded tokens) to
//! one or more panel instances. Each agent behaves like akari-agent at the
//! protocol level: Hello with its held versions and state hash, applies
//! Snapshot (new traffic session, counters restart) and UserDelta (REPLACE
//! semantics, BASE_MISMATCH when the base differs), Acks with the state
//! hash, reports cumulative traffic every `traffic_secs` and heartbeats.
//!
//! Measurements:
//! - convergence: time until every agent acked its first snapshot;
//! - change-to-agent latency: the admin API disables (then re-enables) a
//!   random served user; latency = PATCH sent -> the op naming that user
//!   reached each agent serving it (all agents run in this process, so one
//!   clock);
//! - billing: bytes reported (per-session cumulative, as an agent reports
//!   them) vs `users.traffic_used_bytes` growth after a final flush;
//! - final convergence: every agent's held versions and state hash equal
//!   the panel's desired state in the database.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use rand::Rng;
use sqlx::postgres::PgPoolOptions;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Identity};
use uuid::Uuid;

use akari_panel::gen::agent_channel_client::AgentChannelClient;
use akari_panel::gen::agent_enrollment_client::AgentEnrollmentClient;
use akari_panel::gen::agent_up::Msg as UpMsg;
use akari_panel::gen::panel_down::Msg as DownMsg;
use akari_panel::gen::{
    ack, user_op, Ack, AgentInfo, AgentUp, ConfigSnapshot, EnrollRequest, Heartbeat, Hello,
    TrafficReport, UserDelta, UserTraffic,
};
use akari_panel::grpc::{state_hash, user_set, NodeState, UserSet};

use crate::common;

#[derive(clap::Args, Debug, Clone)]
pub struct SwarmArgs {
    #[arg(long, env = "BENCH_DATABASE_URL", default_value = common::DEFAULT_DB)]
    pub database_url: String,
    /// The panel's data dir (CA, route prefix, jwt.key).
    #[arg(long, default_value = "bench/data")]
    pub data_dir: PathBuf,
    /// Where enrolled agent credentials are kept between runs.
    #[arg(long, default_value = "bench/data/swarm")]
    pub state_dir: PathBuf,
    /// Panel gRPC address(es); agent i dials grpc[i % len].
    #[arg(long, default_value = "127.0.0.1:18443")]
    pub grpc: Vec<String>,
    /// Panel web base URL(s) for the admin API changes (round-robin).
    #[arg(long, default_value = "http://127.0.0.1:18080")]
    pub url: Vec<String>,
    #[arg(long, default_value_t = 200)]
    pub agents: usize,
    /// Run time after convergence.
    #[arg(long, default_value_t = 60)]
    pub seconds: u64,
    /// User changes to time (each = one disable + one re-enable).
    #[arg(long, default_value_t = 20)]
    pub changes: usize,
    #[arg(long, default_value_t = 10)]
    pub traffic_secs: u64,
    #[arg(long, default_value_t = 15)]
    pub heartbeat_secs: u64,
    /// Fraction of an agent's users with new traffic per report.
    #[arg(long, default_value_t = 0.025)]
    pub active_frac: f64,
    /// Report every user of the session (an agent reports every user with
    /// nonzero counters; a long session approaches all of them).
    #[arg(long, default_value_t = true)]
    pub report_all: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Creds {
    cert: String,
    key: String,
    ca: String,
}

#[derive(Default)]
struct Stats {
    snapshots: AtomicU64,
    deltas: AtomicU64,
    base_mismatch: AtomicU64,
    reconnects: AtomicU64,
    reports: AtomicU64,
    report_rows: AtomicU64,
    /// Bytes handed to the stream in reports (cumulative per session).
    reported_bytes: AtomicU64,
    snapshot_bytes_max: AtomicU64,
}

struct Shared {
    /// The user whose arrival is being timed (None: nothing timed).
    watched: Mutex<Option<String>>,
    events: mpsc::UnboundedSender<(usize, bool, Instant)>,
    converged: AtomicUsize,
    stats: Stats,
    stop: tokio::sync::watch::Receiver<bool>,
    args: SwarmArgs,
    ca_pem: String,
}

/// Agent state that survives reconnects (like akari-agent's CoreManager).
struct AgentState {
    held: (u64, u64),
    inbounds: String,
    users: UserSet,
    session: String,
    /// user -> (cumulative up, cumulative down) in this session.
    counters: HashMap<String, (u64, u64)>,
    /// user -> cumulative total already handed to a report.
    reported: HashMap<String, u64>,
    acked_first: bool,
}

impl AgentState {
    fn hash(&self) -> String {
        if self.held == (0, 0) {
            return String::new();
        }
        state_hash(
            self.held.0,
            &NodeState {
                inbounds: self.inbounds.clone(),
                users: self.users.clone(),
            },
        )
    }
}

pub async fn run(args: SwarmArgs) -> Result<()> {
    let ca_pem = std::fs::read_to_string(args.data_dir.join("ca.pem")).with_context(|| {
        format!(
            "read {}/ca.pem (start the panel once)",
            args.data_dir.display()
        )
    })?;
    std::fs::create_dir_all(&args.state_dir)?;
    let pg = PgPoolOptions::new()
        .max_connections(4)
        .connect(&args.database_url)
        .await?;
    let node_of = node_ids(&pg, args.agents).await?;
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
    let shared = Arc::new(Shared {
        watched: Mutex::new(None),
        events: ev_tx,
        converged: AtomicUsize::new(0),
        stats: Stats::default(),
        stop: stop_rx,
        args: args.clone(),
        ca_pem,
    });

    // Enroll (first run) or load credentials; a few at a time.
    let t = Instant::now();
    let mut creds = Vec::with_capacity(args.agents);
    for i in 0..args.agents {
        creds.push(Arc::new(ensure_creds(&shared, i).await?));
    }
    println!(
        "credentials for {} agents ready in {:.1?}",
        args.agents,
        t.elapsed()
    );

    let before_billed = billed_sum(&pg).await?;
    let started = Instant::now();
    let states: Vec<Arc<tokio::sync::Mutex<AgentState>>> = (0..args.agents)
        .map(|_| {
            Arc::new(tokio::sync::Mutex::new(AgentState {
                held: (0, 0),
                inbounds: String::new(),
                users: UserSet::new(),
                session: Uuid::new_v4().to_string(),
                counters: HashMap::new(),
                reported: HashMap::new(),
                acked_first: false,
            }))
        })
        .collect();
    let mut tasks = Vec::new();
    for i in 0..args.agents {
        let (shared, creds, st) = (shared.clone(), creds[i].clone(), states[i].clone());
        tasks.push(tokio::spawn(agent_loop(shared, i, creds, st)));
    }

    // Initial convergence.
    let deadline = Instant::now() + Duration::from_secs(300);
    while shared.converged.load(Ordering::Relaxed) < args.agents {
        if Instant::now() > deadline {
            bail!(
                "only {}/{} agents converged in 300 s",
                shared.converged.load(Ordering::Relaxed),
                args.agents
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    println!(
        "converged: {} agents acked their first snapshot {:.2?} after start (max snapshot {} bytes)",
        args.agents,
        started.elapsed(),
        shared.stats.snapshot_bytes_max.load(Ordering::Relaxed)
    );

    // Change-to-agent latency.
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()?;
    let prefix = crate::load::route_prefix(&args.data_dir)?;
    let cookie = crate::load::admin_cookie(&pg, &args.data_dir).await?;
    let mut each = common::histogram()?;
    let mut all = common::histogram()?;
    let run_until = Instant::now() + Duration::from_secs(args.seconds);
    let gap = Duration::from_secs(args.seconds) / (args.changes.max(1) as u32 * 2 + 1);
    for c in 0..args.changes {
        let (user, holders) = pick_user(&states).await;
        let Some(user) = user else {
            bail!("no served user found");
        };
        for enable in [false, true] {
            tokio::time::sleep(gap).await;
            while ev_rx.try_recv().is_ok() {}
            if let Ok(mut w) = shared.watched.lock() {
                *w = Some(user.clone());
            }
            let base = &args.url[c % args.url.len()];
            let t0 = Instant::now();
            let r = http
                .patch(format!("{base}/{prefix}/api/v1/users/{user}"))
                .header(reqwest::header::COOKIE, &cookie)
                .json(&serde_json::json!({ "enabled": enable }))
                .send()
                .await?;
            if !r.status().is_success() {
                bail!("PATCH user: {}", r.status());
            }
            let mut got = 0;
            let mut last = Duration::ZERO;
            let wait_until = Instant::now() + Duration::from_secs(10);
            while got < holders {
                let left = wait_until.saturating_duration_since(Instant::now());
                match tokio::time::timeout(left, ev_rx.recv()).await {
                    Ok(Some((_agent, present, at))) if present == enable => {
                        let d = at.saturating_duration_since(t0);
                        common::record(&mut each, d);
                        last = last.max(d);
                        got += 1;
                    }
                    Ok(Some(_)) => {}
                    _ => break,
                }
            }
            if got < holders {
                println!(
                    "change {c} (enable={enable}): only {got}/{holders} agents saw it within 10 s"
                );
            }
            common::record(&mut all, last);
            if let Ok(mut w) = shared.watched.lock() {
                *w = None;
            }
        }
    }
    let rest = run_until.saturating_duration_since(Instant::now());
    tokio::time::sleep(rest).await;
    println!("change -> agent, per agent:     {}", common::summary(&each));
    println!("change -> agent, all holders:   {}", common::summary(&all));

    let _ = stop_tx.send(true);
    for t in tasks {
        let _ = t.await;
    }
    let s = &shared.stats;
    println!(
        "snapshots={} deltas={} base_mismatch={} reconnects={} reports={} rows={}",
        s.snapshots.load(Ordering::Relaxed),
        s.deltas.load(Ordering::Relaxed),
        s.base_mismatch.load(Ordering::Relaxed),
        s.reconnects.load(Ordering::Relaxed),
        s.reports.load(Ordering::Relaxed),
        s.report_rows.load(Ordering::Relaxed),
    );

    // Billing: wait for the panels' flush (5 s tick) to settle.
    let reported = s.reported_bytes.load(Ordering::Relaxed) as i128;
    let mut billed = 0i128;
    for _ in 0..12 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        billed = billed_sum(&pg).await? - before_billed;
        if billed >= reported {
            break;
        }
    }
    println!(
        "billing: reported={reported} billed={billed} ({})",
        match billed.cmp(&reported) {
            std::cmp::Ordering::Equal => "exact",
            std::cmp::Ordering::Less => "UNDER (allowed only if a stream broke)",
            std::cmp::Ordering::Greater => "OVER: INVARIANT VIOLATED",
        }
    );

    // Final convergence against the database.
    let mut diverged = 0;
    for (i, st) in states.iter().enumerate() {
        let st = st.lock().await;
        let Some(want) = akari_panel::grpc::desired_snapshot(&pg, node_of[i]).await? else {
            continue;
        };
        let want_hash = state_hash(
            want.config_version,
            &NodeState {
                inbounds: want.inbounds_json.clone(),
                users: user_set(&want.users),
            },
        );
        if st.held != (want.config_version, want.user_version) || st.hash() != want_hash {
            diverged += 1;
        }
    }
    println!(
        "final convergence: {}/{} agents match the desired state",
        states.len() - diverged,
        states.len()
    );
    if billed > reported || diverged > 0 {
        bail!("swarm checks failed");
    }
    Ok(())
}

async fn node_ids(pg: &sqlx::PgPool, n: usize) -> Result<Vec<Uuid>> {
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let id: Uuid =
            sqlx::query_scalar("SELECT node_id FROM node_enrollments WHERE token_hash = $1")
                .bind(akari_panel::enroll::hash_token(&common::enroll_token(i)))
                .fetch_optional(pg)
                .await?
                .with_context(|| format!("no seeded node for agent {i}"))?;
        out.push(id);
    }
    Ok(out)
}

async fn billed_sum(pg: &sqlx::PgPool) -> Result<i128> {
    let v: String =
        sqlx::query_scalar("SELECT coalesce(sum(traffic_used_bytes), 0)::numeric::text FROM users")
            .fetch_one(pg)
            .await?;
    Ok(v.parse::<i128>()?)
}

/// A random user served by agent 0, and how many agents serve it.
async fn pick_user(states: &[Arc<tokio::sync::Mutex<AgentState>>]) -> (Option<String>, usize) {
    let user = {
        let st = states[0].lock().await;
        let n = st.users.len();
        if n == 0 {
            return (None, 0);
        }
        let k = rand::rng().random_range(0..n);
        st.users.keys().nth(k).cloned()
    };
    let Some(user) = user else {
        return (None, 0);
    };
    let mut holders = 0;
    for s in states {
        if s.lock().await.users.contains_key(&user) {
            holders += 1;
        }
    }
    (Some(user), holders)
}

fn creds_path(dir: &Path, i: usize) -> PathBuf {
    dir.join(format!("agent-{i:03}.json"))
}

async fn ensure_creds(shared: &Shared, i: usize) -> Result<Creds> {
    let path = creds_path(&shared.args.state_dir, i);
    if let Ok(s) = std::fs::read_to_string(&path) {
        return Ok(serde_json::from_str(&s)?);
    }
    let key = rcgen::KeyPair::generate()?;
    let csr = rcgen::CertificateParams::default().serialize_request(&key)?;
    let addr = &shared.args.grpc[i % shared.args.grpc.len()];
    let tls = ClientTlsConfig::new()
        .ca_certificate(Certificate::from_pem(&shared.ca_pem))
        .domain_name("localhost");
    let channel = Channel::from_shared(format!("https://{addr}"))?
        .tls_config(tls)?
        .connect()
        .await?;
    let issued = AgentEnrollmentClient::new(channel)
        .enroll(EnrollRequest {
            token: common::enroll_token(i),
            csr_der: csr.der().to_vec(),
        })
        .await
        .with_context(|| format!("enroll agent {i} (reseed if the token was used)"))?
        .into_inner();
    let creds = Creds {
        cert: issued.cert_pem,
        key: key.serialize_pem(),
        ca: issued.ca_pem,
    };
    std::fs::write(&path, serde_json::to_vec(&creds)?)?;
    Ok(creds)
}

async fn agent_loop(
    shared: Arc<Shared>,
    i: usize,
    creds: Arc<Creds>,
    st: Arc<tokio::sync::Mutex<AgentState>>,
) {
    let mut stop = shared.stop.clone();
    loop {
        if *stop.borrow() {
            return;
        }
        if let Err(e) = session(&shared, i, &creds, &st).await {
            if *stop.borrow() {
                return;
            }
            shared.stats.reconnects.fetch_add(1, Ordering::Relaxed);
            eprintln!("agent {i}: {e:#}; reconnecting");
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                _ = stop.changed() => return,
            }
        } else {
            return;
        }
    }
}

async fn session(
    shared: &Shared,
    i: usize,
    creds: &Creds,
    st: &tokio::sync::Mutex<AgentState>,
) -> Result<()> {
    let args = &shared.args;
    let addr = &args.grpc[i % args.grpc.len()];
    let tls = ClientTlsConfig::new()
        .ca_certificate(Certificate::from_pem(&creds.ca))
        .identity(Identity::from_pem(&creds.cert, &creds.key))
        .domain_name("localhost");
    let channel = Channel::from_shared(format!("https://{addr}"))?
        .tls_config(tls)?
        .connect()
        .await?;
    let mut client = AgentChannelClient::new(channel)
        .max_decoding_message_size(64 << 20)
        .max_encoding_message_size(64 << 20);
    let (up, up_rx) = mpsc::channel::<AgentUp>(64);
    let mut down = client
        .open_channel(ReceiverStream::new(up_rx))
        .await?
        .into_inner();
    let send = |m: UpMsg| {
        let up = up.clone();
        async move {
            up.send(AgentUp { msg: Some(m) })
                .await
                .map_err(|_| anyhow::anyhow!("stream closed"))
        }
    };
    {
        let s = st.lock().await;
        send(UpMsg::Hello(Hello {
            session_id: s.session.clone(),
            config_version: s.held.0,
            user_version: s.held.1,
            info: Some(AgentInfo {
                agent_version: "bench-swarm".into(),
                core_version: "none".into(),
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
            }),
            protocol_version: 2,
            state_hash: s.hash(),
        }))
        .await?;
    }
    let started = Instant::now();
    let jitter =
        Duration::from_millis(rand::rng().random_range(0..args.traffic_secs.max(1) * 1000));
    let mut traffic = tokio::time::interval_at(
        tokio::time::Instant::now() + jitter,
        Duration::from_secs(args.traffic_secs.max(1)),
    );
    let mut hb = tokio::time::interval(Duration::from_secs(args.heartbeat_secs.max(1)));
    let mut stop = shared.stop.clone();
    loop {
        tokio::select! {
            m = down.message() => {
                let Some(m) = m? else { bail!("panel closed the stream") };
                match m.msg {
                    Some(DownMsg::Snapshot(s)) => {
                        let ack = on_snapshot(shared, i, st, s).await;
                        send(UpMsg::Ack(ack)).await?;
                    }
                    Some(DownMsg::Delta(d)) => {
                        let ack = on_delta(shared, i, st, d).await;
                        send(UpMsg::Ack(ack)).await?;
                    }
                    _ => {}
                }
            }
            _ = traffic.tick() => {
                if let Some(r) = report(shared, st).await {
                    send(UpMsg::Traffic(r)).await?;
                }
            }
            _ = hb.tick() => {
                send(UpMsg::Heartbeat(Heartbeat {
                    cpu_percent: 1.0,
                    mem_used_bytes: 1 << 28,
                    mem_total_bytes: 1 << 32,
                    connections: 100,
                    uptime_seconds: started.elapsed().as_secs(),
                    lease_remaining_seconds: None,
                })).await?;
            }
            _ = stop.changed() => return Ok(()),
        }
    }
}

fn watched(shared: &Shared) -> Option<String> {
    shared.watched.lock().ok().and_then(|w| w.clone())
}

async fn on_snapshot(
    shared: &Shared,
    i: usize,
    st: &tokio::sync::Mutex<AgentState>,
    s: ConfigSnapshot,
) -> Ack {
    let now = Instant::now();
    shared.stats.snapshots.fetch_add(1, Ordering::Relaxed);
    let size = prost::Message::encoded_len(&s) as u64;
    shared
        .stats
        .snapshot_bytes_max
        .fetch_max(size, Ordering::Relaxed);
    let mut a = st.lock().await;
    let users = user_set(&s.users);
    if let Some(w) = watched(shared) {
        let (was, is) = (a.users.contains_key(&w), users.contains_key(&w));
        if was != is {
            let _ = shared.events.send((i, is, now));
        }
    }
    // A Snapshot rebuilds xray: new traffic session, counters restart.
    a.users = users;
    a.inbounds = s.inbounds_json;
    a.held = (s.config_version, s.user_version);
    a.session = Uuid::new_v4().to_string();
    a.counters.clear();
    a.reported.clear();
    if !a.acked_first {
        a.acked_first = true;
        shared.converged.fetch_add(1, Ordering::Relaxed);
    }
    ok_ack(&a)
}

fn ok_ack(a: &AgentState) -> Ack {
    Ack {
        config_version: a.held.0,
        user_version: a.held.1,
        ok: true,
        reason: ack::Reason::Ok as i32,
        held_config_version: a.held.0,
        held_user_version: a.held.1,
        state_hash: a.hash(),
        error: String::new(),
    }
}

async fn on_delta(
    shared: &Shared,
    i: usize,
    st: &tokio::sync::Mutex<AgentState>,
    d: UserDelta,
) -> Ack {
    let now = Instant::now();
    shared.stats.deltas.fetch_add(1, Ordering::Relaxed);
    let mut a = st.lock().await;
    let target = (d.config_version, d.user_version);
    if a.held == target {
        return ok_ack(&a);
    }
    if a.held != (d.base_config_version, d.base_user_version)
        || d.config_version != d.base_config_version
    {
        shared.stats.base_mismatch.fetch_add(1, Ordering::Relaxed);
        return Ack {
            config_version: target.0,
            user_version: target.1,
            ok: false,
            reason: ack::Reason::BaseMismatch as i32,
            held_config_version: a.held.0,
            held_user_version: a.held.1,
            state_hash: a.hash(),
            error: "base mismatch".into(),
        };
    }
    let w = watched(shared);
    for op in &d.ops {
        let mut tags = BTreeMap::new();
        if op.op == user_op::Op::Add as i32 {
            for iu in &op.inbound_users {
                tags.insert(
                    iu.inbound_tag.clone(),
                    (iu.protocol.clone(), iu.account_json.clone()),
                );
            }
        }
        let was = a.users.contains_key(&op.user_id);
        if tags.is_empty() {
            a.users.remove(&op.user_id);
        } else {
            a.users.insert(op.user_id.clone(), tags);
        }
        if w.as_deref() == Some(op.user_id.as_str()) {
            let is = a.users.contains_key(&op.user_id);
            if was != is {
                let _ = shared.events.send((i, is, now));
            }
        }
    }
    a.held = target;
    ok_ack(&a)
}

/// Grow the counters of a random `active_frac` of the current users and
/// build the cumulative report for this session.
async fn report(shared: &Shared, st: &tokio::sync::Mutex<AgentState>) -> Option<TrafficReport> {
    let args = &shared.args;
    let mut a = st.lock().await;
    if a.held == (0, 0) || a.users.is_empty() {
        return None;
    }
    let n = a.users.len();
    let active = ((n as f64) * args.active_frac).ceil() as usize;
    let picks: Vec<String> = {
        let mut rng = rand::rng();
        let keys: Vec<&String> = a.users.keys().collect();
        (0..active)
            .map(|_| keys[rng.random_range(0..keys.len())].clone())
            .collect()
    };
    {
        let mut rng = rand::rng();
        for u in picks {
            let c = a.counters.entry(u).or_insert((0, 0));
            c.0 += rng.random_range(1_000..200_000);
            c.1 += rng.random_range(10_000..2_000_000);
        }
    }
    let mut rows = Vec::with_capacity(if args.report_all { n } else { a.counters.len() });
    let mut new_bytes = 0u64;
    let users: Vec<String> = if args.report_all {
        a.users
            .keys()
            .chain(a.counters.keys())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    } else {
        a.counters.keys().cloned().collect()
    };
    for u in users {
        let (up, down) = a.counters.get(&u).copied().unwrap_or((1, 1));
        if !a.counters.contains_key(&u) {
            // An idle user still has (tiny) nonzero counters in a long
            // session; seed them once so it is reported like one.
            a.counters.insert(u.clone(), (up, down));
        }
        let total = up + down;
        let prev = a.reported.insert(u.clone(), total).unwrap_or(0);
        new_bytes += total.saturating_sub(prev);
        rows.push(UserTraffic {
            user_id: u,
            up_bytes: up,
            down_bytes: down,
        });
    }
    shared.stats.reports.fetch_add(1, Ordering::Relaxed);
    shared
        .stats
        .report_rows
        .fetch_add(rows.len() as u64, Ordering::Relaxed);
    shared
        .stats
        .reported_bytes
        .fetch_add(new_bytes, Ordering::Relaxed);
    Some(TrafficReport {
        users: rows,
        monotonic_ms: 0,
        session_id: a.session.clone(),
    })
}
