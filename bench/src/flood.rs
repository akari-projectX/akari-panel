//! `akari-bench flood`: login flood against a running panel (audit batch 2
//! P2-3: the argon2 queue is bounded, a flood is answered 503
//! `request.busy` instead of piling up) while probes measure whether the
//! rest of the panel stays responsive.
//!
//! The flood workers send a mix of wrong-password attempts (a fresh
//! non-existent address each, so no rate-limit bucket fills: the work is
//! still one argon2 run) and right-password logins of the seeded login
//! account. Every request carries a random `X-Forwarded-For`; the panel
//! must trust the loopback peer (`web.trusted_proxies`, as in
//! `bench/panel-bench-1.toml`) or all of them would share one
//! per-address bucket and hit 429 after twenty failures.
//!
//! Probes run at a fixed 20 Hz beside the flood: an admin API read (the
//! `AuthUser` path: JWT + one DB lookup), `/healthz`, and a subscription
//! fetch. Their latency under flood vs the idle baseline is the result.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::Result;
use hdrhistogram::Histogram;
use rand::RngExt;
use sqlx::postgres::PgPoolOptions;

use crate::common;
use crate::load;

#[derive(clap::Args, Debug, Clone)]
pub struct FloodArgs {
    #[arg(long, env = "BENCH_DATABASE_URL", default_value = common::DEFAULT_DB)]
    pub database_url: String,
    #[arg(long, default_value = "bench/data")]
    pub data_dir: PathBuf,
    #[arg(long, default_value = "http://127.0.0.1:18080")]
    pub url: String,
    /// Concurrent login requests (closed loop).
    #[arg(long, default_value_t = 256)]
    pub concurrency: usize,
    #[arg(long, default_value_t = 20)]
    pub seconds: u64,
    /// Percentage of the flood that logs in with the right password.
    #[arg(long, default_value_t = 20)]
    pub right_pct: u32,
    /// Seeded user count (the subscription probe derives tokens from it).
    #[arg(long, default_value_t = 50_000)]
    pub users: usize,
}

type Hist = Histogram<u64>;

struct Probe {
    name: &'static str,
    hist: Hist,
    errors: u64,
}

pub async fn run(a: FloodArgs) -> Result<()> {
    let (prefix, sub_path) = load::layout(&a.database_url).await?;
    let pg = PgPoolOptions::new()
        .max_connections(1)
        .connect(&a.database_url)
        .await?;
    let cookie = load::admin_cookie(&pg, &a.data_dir).await?;
    pg.close().await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(a.concurrency + 8)
        .timeout(Duration::from_secs(30))
        .build()?;
    let base = format!("{}/{prefix}", a.url);
    let sub = format!("{}/{sub_path}", a.url);

    println!("-- idle baseline (probes only, {PROBE_BASE}s)");
    let idle = probes(&cookie, &client, &base, &sub, PROBE_BASE).await;
    print_probes(&idle);

    println!(
        "-- flood: {} workers, {}% right password, {}s",
        a.concurrency, a.right_pct, a.seconds
    );
    let deadline = Instant::now() + Duration::from_secs(a.seconds);
    let mut workers = Vec::new();
    for _ in 0..a.concurrency {
        let client = client.clone();
        let base = base.clone();
        let right_pct = a.right_pct;
        workers.push(tokio::spawn(async move {
            let mut by: BTreeMap<(bool, String), Hist> = BTreeMap::new();
            while Instant::now() < deadline {
                let (right, xff, email) = {
                    let mut rng = rand::rng();
                    let right = rng.random_range(0..100) < right_pct;
                    let xff = common::random_ip(&mut rng);
                    let email = if right {
                        common::LOGIN_USER.to_string()
                    } else {
                        format!("nobody-{}@bench.invalid", rng.random::<u64>())
                    };
                    (right, xff, email)
                };
                let pw = if right {
                    common::LOGIN_PASSWORD
                } else {
                    "wrong-password"
                };
                let t = Instant::now();
                let status = match client
                    .post(format!("{base}/auth/login"))
                    .header("x-forwarded-for", xff)
                    .json(&serde_json::json!({ "email": email, "password": pw }))
                    .send()
                    .await
                {
                    Ok(r) => {
                        let s = r.status().as_u16().to_string();
                        let _ = r.bytes().await;
                        s
                    }
                    Err(_) => "err".to_string(),
                };
                let h = match by.entry((right, status)) {
                    std::collections::btree_map::Entry::Occupied(o) => o.into_mut(),
                    std::collections::btree_map::Entry::Vacant(v) => v.insert(new_hist()),
                };
                common::record(h, t.elapsed());
            }
            by
        }));
    }
    let probe_task = {
        let (client, base) = (client.clone(), base.clone());
        let secs = a.seconds;
        tokio::spawn(async move { probes(&cookie, &client, &base, &sub, secs).await })
    };
    let start = Instant::now();
    let mut merged: BTreeMap<(bool, String), Hist> = BTreeMap::new();
    for w in workers {
        for (k, h) in w.await? {
            match merged.entry(k) {
                std::collections::btree_map::Entry::Occupied(mut o) => o.get_mut().add(&h)?,
                std::collections::btree_map::Entry::Vacant(v) => {
                    v.insert(h);
                }
            }
        }
    }
    let elapsed = start.elapsed().as_secs_f64();
    let total: u64 = merged.values().map(Hist::len).sum();
    println!(
        "flood: {total} requests, {:.0} req/s",
        total as f64 / elapsed
    );
    for ((right, status), h) in &merged {
        println!(
            "  {:<5} {:<4} {:>8.0} req/s  {}",
            if *right { "right" } else { "wrong" },
            status,
            h.len() as f64 / elapsed,
            common::summary(h)
        );
    }
    println!("-- probes during the flood");
    print_probes(&probe_task.await?);
    Ok(())
}

const PROBE_BASE: u64 = 8;

/// A spread of seeded users for the subscription probe (the per-token
/// limit is 30 per 10 minutes).
fn users_of(i: usize) -> usize {
    i * 7919 % 50_000
}

/// Three probe requests every 50 ms for `secs`: an admin read, `/healthz`
/// and a subscription fetch.
async fn probes(
    cookie: &str,
    client: &reqwest::Client,
    base: &str,
    sub: &str,
    secs: u64,
) -> [Probe; 3] {
    let one = |name: &'static str| Probe {
        name,
        hist: new_hist(),
        errors: 0,
    };
    let mut set = [one("admin_me"), one("healthz"), one("sub_clash")];
    let root = base.rsplit_once('/').map_or(base, |p| p.0);
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut i = 0usize;
    while Instant::now() < deadline {
        tick.tick().await;
        i += 1;
        let reqs = [
            client
                .get(format!("{base}/api/v1/me"))
                .header(reqwest::header::COOKIE, cookie),
            client.get(format!("{root}/healthz")),
            client
                .get(format!("{sub}/{}", common::sub_token(users_of(i))))
                .header(reqwest::header::USER_AGENT, "clash-verge/v2")
                .header("x-forwarded-for", common::random_ip(&mut rand::rng())),
        ];
        for (p, r) in set.iter_mut().zip(reqs) {
            let t = Instant::now();
            let ok = match r.send().await {
                Ok(resp) => {
                    let ok = resp.status().is_success();
                    let _ = resp.bytes().await;
                    ok
                }
                Err(_) => false,
            };
            common::record(&mut p.hist, t.elapsed());
            if !ok {
                p.errors += 1;
            }
        }
    }
    set
}

fn print_probes(set: &[Probe; 3]) {
    for p in set {
        println!(
            "  {:<10} errors={:<4} {}",
            p.name,
            p.errors,
            common::summary(&p.hist)
        );
    }
}

fn new_hist() -> Hist {
    common::histogram().expect("histogram bounds are constants")
}
