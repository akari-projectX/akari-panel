use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

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
    /// Delete a node and revoke its certificate. Marks it deleting and
    /// disables it; a running panel finishes the deletion once the agent
    /// runs the empty state (or after a timeout / at once if offline).
    Delete { id: uuid::Uuid },
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
    /// Set an account's password (prompts unless AKARI_ADMIN_PASSWORD is
    /// set). Ends all of the account's sessions.
    Passwd { login: String },
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
            NodeCmd::Delete { id } => nodeops::node_delete(cfg, id).await,
        },
        Cmd::Admin { action } => match action {
            AdminCmd::Add { login, role } => nodeops::admin_add(cfg, login, role).await,
            AdminCmd::Passwd { login } => nodeops::admin_passwd(cfg, login).await,
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

    // LISTEN must be in place before any agent session can start.
    let listener = notify::start(state.clone()).await;
    let background = [
        listener,
        tokio::spawn(notify::queue_monitor(state.clone())),
        tokio::spawn(traffic::flush_loop(state.clone())),
        tokio::spawn(reaper::reap_loop(state.clone())),
        tokio::spawn(state.clone().persist_online_loop()),
    ];

    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
    let mut shutdown_rx_web = shutdown_tx.subscribe();
    let shutdown_rx_grpc = shutdown_tx.subscribe();

    let web_state = state.clone();
    let web_bind = state.cfg().web.bind;
    let mut web_task = tokio::spawn(async move {
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

    let grpc_state = state.clone();
    let mut grpc_task = tokio::spawn(async move {
        if let Err(e) = grpc::serve(grpc_state, shutdown_rx_grpc).await {
            tracing::error!(error = %e, "grpc server failed");
        }
    });

    let (mut web_done, mut grpc_done) = (false, false);
    tokio::select! {
        _ = shutdown::signal() => {}
        r = &mut web_task => {
            web_done = true;
            tracing::error!(result = ?r.map(|r| r.map_err(|e| e.to_string())), "web server stopped");
        }
        _ = &mut grpc_task => {
            grpc_done = true;
            tracing::error!("grpc server stopped");
        }
    }
    tracing::info!("shutting down");
    // Stop accepting (web + gRPC), then end the agent streams: the gRPC
    // server's graceful shutdown waits for them.
    state.begin_shutdown();
    let _ = shutdown_tx.send(());
    shutdown::end_sessions(&state, shutdown::SESSION_DRAIN).await;
    // No loop may run concurrently with (or after) the final flush.
    for t in &background {
        t.abort();
    }
    for t in background {
        let _ = t.await;
    }
    shutdown::final_flush(&state, shutdown::FINAL_FLUSH).await;
    // In-flight requests had the whole sequence to finish; then stop.
    if !web_done
        && tokio::time::timeout(shutdown::SERVER_DRAIN, &mut web_task)
            .await
            .is_err()
    {
        web_task.abort();
    }
    if !grpc_done
        && tokio::time::timeout(shutdown::SERVER_DRAIN, &mut grpc_task)
            .await
            .is_err()
    {
        grpc_task.abort();
    }
    tracing::info!("shutdown complete");
    Ok(())
}

mod api;
mod auth;
mod client_ip;
mod config;
mod db;
mod enforce;
mod gen;
mod grpc;
mod install;
mod login_limit;
mod nodeops;
mod notify;
mod reaper;
mod reject;
mod shutdown;
mod spa;
mod state;
mod sub;
#[cfg(test)]
mod testdb;
mod traffic;
mod valkey_util;
mod web;
