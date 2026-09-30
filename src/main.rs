use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tokio::signal;

use crate::config::PanelConfig;

#[derive(Parser)]
#[command(name = "akari", about = "Akari control panel")]
struct Cli {
    /// Path to panel.toml (defaults are used when omitted)
    #[arg(short, long, global = true)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the panel (web + gRPC)
    Serve,
    /// Show install info: route prefix, listen addresses
    Info,
    /// Node management
    Node {
        #[command(subcommand)]
        action: NodeCmd,
    },
    /// Admin account management
    Admin {
        #[command(subcommand)]
        action: AdminCmd,
    },
}

#[derive(Subcommand)]
enum NodeCmd {
    /// Register a node and write an agent bootstrap file
    Add {
        name: String,
        /// Where to write the agent bootstrap file (default: ./<name>-bootstrap.toml)
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// List nodes
    List,
}

#[derive(Subcommand)]
enum AdminCmd {
    /// Create an admin/user account (prompts for a password unless
    /// AKARI_ADMIN_PASSWORD is set)
    Add {
        login: String,
        #[arg(long, default_value = "admin")]
        role: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    // The dependency graph enables both rustls crypto backends (ring via
    // tonic/rcgen, aws-lc-rs via other crates); pick one explicitly.
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls ring crypto provider");

    let cli = Cli::parse();
    let cfg = PanelConfig::load(cli.config.as_deref())?;
    match cli.cmd {
        Cmd::Serve => serve(cfg).await,
        Cmd::Info => info(cfg),
        Cmd::Node { action } => match action {
            NodeCmd::Add { name, out } => nodeops::node_add(cfg, name, out).await,
            NodeCmd::List => nodeops::node_list(cfg).await,
        },
        Cmd::Admin { action } => match action {
            AdminCmd::Add { login, role } => nodeops::admin_add(cfg, login, role).await,
        },
    }
}

fn info(cfg: PanelConfig) -> Result<()> {
    let install = install::ensure(&cfg)?;
    println!("data dir:       {}", cfg.data_dir.display());
    println!("web bind:       {}", cfg.web.bind);
    println!("grpc bind:      {}", cfg.grpc.bind);
    println!("grpc advertise: {}", cfg.grpc.advertise);
    println!("route prefix:   /{}", install.route_prefix);
    Ok(())
}

async fn serve(cfg: PanelConfig) -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let install = install::ensure(&cfg)?;

    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(16)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&cfg.database_url)
        .await?;
    crate::db::migrate(&pg).await?;

    let valkey = state::connect_valkey(&cfg).await?;
    let state = state::AppState::new(cfg.clone(), install, pg, valkey);

    tokio::spawn(traffic::flush_loop(state.clone()));
    tokio::spawn(state.clone().persist_online_loop());

    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
    let mut shutdown_rx_web = shutdown_tx.subscribe();
    let shutdown_rx_grpc = shutdown_tx.subscribe();

    let web_state = state.clone();
    let web_bind = state.cfg().web.bind;
    let web_task = tokio::spawn(async move {
        let listener = tokio::net::TcpListener::bind(web_bind).await?;
        axum::serve(
            listener,
            web::router(web_state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx_web.recv().await;
        })
        .await
    });

    let grpc_task = tokio::spawn(async move {
        if let Err(e) = grpc::serve(state, shutdown_rx_grpc).await {
            tracing::error!(error = %e, "grpc server failed");
        }
    });

    signal::ctrl_c().await?;
    tracing::info!("shutting down");
    let _ = shutdown_tx.send(());
    let _ = web_task.await;
    grpc_task.abort();
    let _ = grpc_task.await;
    Ok(())
}

mod api;
mod auth;
mod config;
mod db;
mod decoy;
mod gen;
mod grpc;
mod install;
mod nodeops;
mod spa;
mod state;
mod sub;
mod traffic;
mod valkey_util;
mod web;
