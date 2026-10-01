use std::path::PathBuf;

/// mimalloc instead of the platform allocator (M2, docs/PERF.md): the
/// release binary is static musl, whose allocator serializes this
/// allocation-heavy multithreaded workload; glibc's per-thread arenas keep
/// RSS at the transient peak.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use anyhow::Result;
use clap::{Parser, Subcommand};

use akari_panel::config::PanelConfig;
use akari_panel::{
    config_check, grpc, install, metrics, nodeops, notify, reaper, shutdown, state, traffic, web,
};

#[derive(Parser)]
#[command(
    name = "akari",
    about = "Akari control panel",
    version = concat!(env!("CARGO_PKG_VERSION"), " (", env!("AKARI_GIT_SHA"), ")")
)]
struct Cli {
    /// Path to panel.toml (defaults are used when omitted). Also read from
    /// AKARI_CONFIG, which survives `docker compose run/exec` (they replace
    /// the service's `command:`)
    #[arg(short, long, global = true, env = "AKARI_CONFIG")]
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
    /// Configuration tools
    Config {
        #[command(subcommand)]
        action: ConfigCmd,
    },
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
    /// Secret rotation (audited)
    Secrets {
        #[command(subcommand)]
        action: SecretsCmd,
    },
}

#[derive(Subcommand)]
enum SecretsCmd {
    /// New random route prefix in data/state.json. Restart every panel
    /// instance to apply; the old prefix (and every subscription URL built
    /// on it) stops working then.
    RotatePrefix,
    /// New data/jwt.key and every session revoked at once (restart every
    /// panel instance to sign with the new key).
    RotateJwt,
}

#[derive(Subcommand)]
enum ConfigCmd {
    /// Load and validate the configuration, print the effective values
    /// (credentials redacted). Exit status 1 when it is invalid.
    Check,
}

#[derive(Subcommand)]
enum NodeCmd {
    /// Register a node and write an agent bootstrap file (one-time
    /// enrollment token, no private key)
    Add {
        name: String,
        /// Where to write the agent bootstrap file (default:
        /// ./<name>-bootstrap.toml); `-` writes it to stdout
        /// (progress goes to stderr)
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// Issue a new one-time enrollment token for an existing node (expired
    /// token, lost agent state) and write its bootstrap file. The node's
    /// current certificates are revoked once the agent enrolls with it.
    EnrollToken {
        id: uuid::Uuid,
        /// Where to write the bootstrap file (default:
        /// ./<name>-bootstrap.toml); `-` writes it to stdout
        /// (progress goes to stderr)
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
    /// Remove an account's two-factor authentication (lost authenticator
    /// and recovery codes) and end its sessions; the account then logs in
    /// with its password (and may set 2FA up again).
    #[command(name = "reset-2fa")]
    Reset2fa { login: String },
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
        Cmd::Config { action } => match action {
            ConfigCmd::Check => config_check(cfg),
        },
        Cmd::Node { action } => match action {
            NodeCmd::Add { name, out } => nodeops::node_add(cfg, name, out).await,
            NodeCmd::EnrollToken { id, out } => nodeops::node_enroll_token(cfg, id, out).await,
            NodeCmd::List => nodeops::node_list(cfg).await,
            NodeCmd::Delete { id } => nodeops::node_delete(cfg, id).await,
        },
        Cmd::Admin { action } => match action {
            AdminCmd::Add { login, role } => nodeops::admin_add(cfg, login, role).await,
            AdminCmd::Passwd { login } => nodeops::admin_passwd(cfg, login).await,
            AdminCmd::Reset2fa { login } => nodeops::admin_reset_2fa(cfg, login).await,
        },
        Cmd::Secrets { action } => match action {
            SecretsCmd::RotatePrefix => nodeops::secrets_rotate_prefix(cfg).await,
            SecretsCmd::RotateJwt => nodeops::secrets_rotate_jwt(cfg).await,
        },
    }
}

/// Validate `cfg` completely (pure rules + data_dir probe). Warnings are
/// returned for the caller to show; any error is one readable message.
fn validate_startup(cfg: &PanelConfig) -> Result<Vec<String>> {
    let mut report = cfg.validate();
    if let Err(e) = config_check::check_data_dir(&cfg.data_dir) {
        report.errors.push(e);
    }
    // R18-3: key files (presence, mode 0600, parse) when payments are on.
    if let Err(e) = akari_panel::billing::load(cfg) {
        report.errors.push(e);
    }
    report.into_result()
}

fn config_check(cfg: PanelConfig) -> Result<()> {
    let warnings = validate_startup(&cfg)?;
    print!("{}", cfg.effective_toml()?);
    for w in &warnings {
        eprintln!("warning: {w}");
    }
    eprintln!(
        "configuration OK ({} warning{})",
        warnings.len(),
        if warnings.len() == 1 { "" } else { "s" }
    );
    Ok(())
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

    let warnings = validate_startup(&cfg)?;
    for w in &warnings {
        tracing::warn!("config: {w}");
    }
    metrics::init()?;
    tracing::info!(
        version = metrics::VERSION,
        git_sha = metrics::GIT_SHA,
        "akari starting"
    );
    let install = install::ensure(&cfg)?;
    akari_panel::billing::check_notify_prefix(&cfg, &install.route_prefix)
        .map_err(anyhow::Error::msg)?;
    let alipay = akari_panel::billing::load(&cfg).map_err(anyhow::Error::msg)?;

    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(16)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&cfg.database_url)
        .await?;
    akari_panel::db::migrate(&pg).await?;

    let valkey = state::connect_valkey(&cfg).await?;
    let state = state::AppState::new(cfg.clone(), install, pg, valkey);
    if let Some(a) = alipay {
        state.set_alipay(a);
    }

    // LISTEN must be in place before any agent session can start.
    let listener = notify::start(state.clone()).await;
    let background = [
        listener,
        tokio::spawn(notify::queue_monitor(state.clone())),
        tokio::spawn(traffic::flush_loop(state.clone())),
        tokio::spawn(reaper::reap_loop(state.clone())),
        tokio::spawn(state.clone().persist_online_loop()),
        tokio::spawn(akari_panel::billing::reconcile_loop(state.clone())),
    ];

    // Metrics have their own listener (never the public web port). Bound
    // before serving so a bad/busy address stops the start with a message.
    let metrics_task = match cfg.metrics.bind {
        Some(bind) => Some(metrics::serve(state.clone(), bind).await?),
        None => None,
    };

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
    if let Some(t) = metrics_task {
        t.abort();
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// `docker compose run/exec` replace the service `command:` (which
    /// carried `-c`), so the config path must also come from AKARI_CONFIG.
    #[test]
    fn config_path_is_read_from_akari_config() {
        let arg_env = Cli::command()
            .get_arguments()
            .find(|a| a.get_id() == "config")
            .and_then(|a| a.get_env().map(|e| e.to_os_string()));
        assert_eq!(arg_env.as_deref(), Some("AKARI_CONFIG".as_ref()));

        std::env::set_var("AKARI_CONFIG", "/etc/akari/panel.toml");
        let from_env = Cli::try_parse_from(["akari", "info"]).map(|c| c.config);
        let explicit = Cli::try_parse_from(["akari", "-c", "/x.toml", "info"]).map(|c| c.config);
        std::env::remove_var("AKARI_CONFIG");
        assert_eq!(
            from_env.ok().flatten(),
            Some(PathBuf::from("/etc/akari/panel.toml"))
        );
        assert_eq!(explicit.ok().flatten(), Some(PathBuf::from("/x.toml")));
    }
}
