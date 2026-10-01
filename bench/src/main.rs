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
    }
}
