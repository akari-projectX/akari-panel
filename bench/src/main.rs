//! akari-bench: M2 benchmark and load tooling for akari-panel (see
//! docs/PERF.md). Not shipped; bench data and secrets only.

use anyhow::Result;
use clap::{Parser, Subcommand};

mod common;
mod explain;
mod lb;
mod load;
mod seed;
mod swarm;

#[derive(Parser)]
#[command(name = "akari-bench")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create the scale data set in its own database
    Seed(seed::SeedArgs),
    /// EXPLAIN (ANALYZE, BUFFERS) every hot query on the seeded data
    Explain(explain::ExplainArgs),
    /// HTTP latency of the admin API, subscription and login
    Http(load::HttpArgs),
    /// Fake-agent swarm: convergence, change-to-agent latency, billing
    Swarm(swarm::SwarmArgs),
    /// TCP round-robin balancer (multi-instance test)
    Lb(lb::LbArgs),
    /// Run one traffic_counters retention pass (M2-5) and time it
    Retention(RetentionArgs),
}

#[derive(clap::Args, Debug)]
struct RetentionArgs {
    #[arg(long, env = "BENCH_DATABASE_URL", default_value = common::DEFAULT_DB)]
    database_url: String,
    /// Drain-proof age required (the panel uses 3600 s).
    #[arg(long, default_value_t = akari_panel::traffic::RETENTION_MARGIN_SECS)]
    margin_secs: u64,
}

async fn retention(a: RetentionArgs) -> Result<()> {
    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&a.database_url)
        .await?;
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM traffic_counters")
        .fetch_one(&pg)
        .await?;
    let t = std::time::Instant::now();
    let r = akari_panel::traffic::retention_pass(&pg, a.margin_secs).await?;
    let took = t.elapsed();
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM traffic_counters")
        .fetch_one(&pg)
        .await?;
    println!("retention: {r:?} in {took:.2?}; traffic_counters {before} -> {after} rows");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Same provider choice as the panel (both backends are in the graph).
    let _ = rustls::crypto::ring::default_provider().install_default();
    match Cli::parse().cmd {
        Cmd::Seed(a) => seed::run(a).await,
        Cmd::Explain(a) => explain::run(a).await,
        Cmd::Http(a) => load::run(a).await,
        Cmd::Swarm(a) => swarm::run(a).await,
        Cmd::Lb(a) => lb::run(a).await,
        Cmd::Retention(a) => retention(a).await,
    }
}
