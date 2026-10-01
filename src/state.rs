use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::PanelConfig;
use crate::install::Install;
use crate::traffic::TrafficBuffer;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

/// A live agent session on this instance.
#[derive(Clone)]
pub struct AgentEntry {
    pub gen: u64,
    pub online_session: Uuid,
    /// Ends this session with the given status (a newer stream of the node
    /// replaced it, or the panel shuts down).
    pub close: Arc<dyn Fn(tonic::Status) + Send + Sync>,
}

/// Concurrent desired-state reads per instance (the pool has 16).
const READ_PERMITS: usize = 8;

struct Inner {
    cfg: PanelConfig,
    route_prefix: String,
    jwt_secret: String,
    install: Install,
    pg: PgPool,
    valkey: fred::clients::Pool,
    /// Connected node id -> its (single) live session on this instance.
    /// The generation keeps a stale session's cleanup from evicting a newer
    /// registration; a newer session supersedes (terminates) the older.
    agents: DashMap<Uuid, AgentEntry>,
    /// Bounds concurrent desired-state reads by agent sessions (a wake-all
    /// after a listener gap, or a mass reconnect, must not drain the pool).
    read_permits: tokio::sync::Semaphore,
    /// Bounds concurrent artifact downloads (M6, `updates::fetch_artifact`).
    fetch_permits: Arc<tokio::sync::Semaphore>,
    gen: AtomicU64,
    /// Per-node wakeups for this instance's agent sessions, fed by the
    /// PostgreSQL LISTEN task (`crate::notify`). There is no in-process
    /// shortcut: every committed change reaches every instance the same way.
    wakeups: crate::notify::Wakeups,
    traffic: TrafficBuffer,
    /// Flips to true once, when the shutdown sequence starts (S4-3); every
    /// agent session ends on it.
    shutdown: tokio::sync::watch::Sender<bool>,
    /// Agent session tasks still running on this instance (including
    /// revoked/retiring ones and their cleanup).
    live_sessions: std::sync::atomic::AtomicUsize,
}

/// Counts a running agent session task (see `AppState::live_sessions`).
pub struct LiveSession(AppState);

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.0 .0.live_sessions.fetch_sub(1, Ordering::SeqCst);
    }
}

impl AppState {
    pub fn new(
        cfg: PanelConfig,
        install: Install,
        pg: PgPool,
        valkey: fred::clients::Pool,
    ) -> Self {
        let route_prefix = install.route_prefix.clone();
        let jwt_secret = install.jwt_secret.clone();
        let fetch_permits = cfg.updates.max_concurrent_downloads.max(1);
        let traffic = TrafficBuffer::new();
        traffic.set_departed_grace(cfg.traffic.departed_grace_secs);
        Self(Arc::new(Inner {
            cfg,
            route_prefix,
            jwt_secret,
            install,
            pg,
            valkey,
            agents: DashMap::new(),
            read_permits: tokio::sync::Semaphore::new(READ_PERMITS),
            fetch_permits: Arc::new(tokio::sync::Semaphore::new(fetch_permits)),
            gen: AtomicU64::new(1),
            wakeups: crate::notify::Wakeups::default(),
            traffic,
            shutdown: tokio::sync::watch::channel(false).0,
            live_sessions: std::sync::atomic::AtomicUsize::new(0),
        }))
    }

    pub fn cfg(&self) -> &PanelConfig {
        &self.0.cfg
    }
    pub fn route_prefix(&self) -> &str {
        &self.0.route_prefix
    }
    pub fn jwt_secret(&self) -> &str {
        &self.0.jwt_secret
    }
    pub fn install(&self) -> &Install {
        &self.0.install
    }
    pub fn totp(&self) -> &crate::totp::Keys {
        &self.0.install.totp
    }
    pub fn pg(&self) -> &PgPool {
        &self.0.pg
    }
    pub fn valkey(&self) -> &fred::clients::Pool {
        &self.0.valkey
    }
    pub fn agents(&self) -> &DashMap<Uuid, AgentEntry> {
        &self.0.agents
    }
    pub fn fetch_permits(&self) -> &Arc<tokio::sync::Semaphore> {
        &self.0.fetch_permits
    }
    pub fn read_permits(&self) -> &tokio::sync::Semaphore {
        &self.0.read_permits
    }
    pub fn traffic(&self) -> &TrafficBuffer {
        &self.0.traffic
    }
    pub fn next_gen(&self) -> u64 {
        self.0.gen.fetch_add(1, Ordering::Relaxed)
    }
    pub fn wakeups(&self) -> &crate::notify::Wakeups {
        &self.0.wakeups
    }
    /// Start the shutdown: every agent session (current or starting) ends.
    pub fn begin_shutdown(&self) {
        self.0.shutdown.send_replace(true);
    }
    /// Resolves once the shutdown has begun.
    pub async fn shutdown_begun(&self) {
        let mut rx = self.0.shutdown.subscribe();
        let _ = rx.wait_for(|v| *v).await;
    }
    pub fn session_started(&self) -> LiveSession {
        self.0.live_sessions.fetch_add(1, Ordering::SeqCst);
        LiveSession(self.clone())
    }
    pub fn live_sessions(&self) -> usize {
        self.0.live_sessions.load(Ordering::SeqCst)
    }

    /// Periodically persists online status for connected agents.
    /// Live status is in Valkey (TTL keys); this only feeds the DB table.
    pub async fn persist_online_loop(self) {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            tick.tick().await;
            let mut rows: Vec<(Uuid, Uuid)> = self
                .agents()
                .iter()
                .map(|e| (*e.key(), e.value().online_session))
                .collect();
            if rows.is_empty() {
                continue;
            }
            rows.sort();
            let (ids, sessions): (Vec<Uuid>, Vec<Uuid>) = rows.into_iter().unzip();
            if let Err(e) = self.persist_online(&ids, &sessions).await {
                tracing::warn!(error = %e, "persist online status failed");
            }
        }
    }
}

impl AppState {
    /// Refresh the rows this instance's sessions still own, locking them in
    /// id order first (global lock order; flushes lock nodes too).
    pub(crate) async fn persist_online(&self, ids: &[Uuid], sessions: &[Uuid]) -> sqlx::Result<()> {
        let mut tx = self.pg().begin().await?;
        sqlx::query("SELECT 1 FROM nodes WHERE id = ANY($1) ORDER BY id FOR NO KEY UPDATE")
            .bind(ids)
            .execute(&mut *tx)
            .await?;
        // M2-5 drain proof: this instance's stream that owns the node has
        // been up >= DRAIN_PROOF_SECS since its latest Hello, so the agent
        // has sent (and confirmed) every final report it queued before that
        // Hello. traffic::retention_pass retires sessions superseded before
        // finals_drained_at.
        sqlx::query(
            "UPDATE nodes n SET status = 'online', last_seen_at = now(), \
             finals_drained_session = CASE WHEN n.agent_session_at <= now() - make_interval(secs => $3) \
                 THEN n.agent_session ELSE n.finals_drained_session END, \
             finals_drained_at = CASE WHEN n.agent_session_at <= now() - make_interval(secs => $3) \
                 THEN n.agent_session_at ELSE n.finals_drained_at END \
             FROM unnest($1::uuid[], $2::uuid[]) AS s(id, sess) \
             WHERE n.id = s.id AND n.online_session = s.sess",
        )
        .bind(ids)
        .bind(sessions)
        .bind(crate::traffic::DRAIN_PROOF_SECS as f64)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }

    /// Test instance on a test database: default config, dummy install, the
    /// dev Valkey (VALKEY_URL or the default).
    #[cfg(test)]
    pub async fn for_test(pg: PgPool) -> Self {
        Self::for_test_with(pg, |_| {}).await
    }

    /// `for_test` with a config tweak.
    #[cfg(test)]
    pub async fn for_test_with(pg: PgPool, tweak: impl FnOnce(&mut PanelConfig)) -> Self {
        let mut cfg = PanelConfig::default();
        tweak(&mut cfg);
        if let Ok(v) = std::env::var("VALKEY_URL") {
            cfg.valkey_url = v;
        }
        let valkey = connect_valkey(&cfg)
            .await
            .expect("dev valkey (make dev-up)");
        let install = Install {
            route_prefix: "test".into(),
            ca_pem: String::new(),
            ca_key_pem: String::new(),
            server_cert_pem: String::new(),
            server_key_pem: String::new(),
            jwt_secret: "test".into(),
            totp: crate::totp::Keys::from_material(&[0x42; 32]).expect("test totp keys"),
        };
        Self::new(cfg, install, pg, valkey)
    }
}

pub async fn connect_valkey(cfg: &PanelConfig) -> anyhow::Result<fred::clients::Pool> {
    use fred::prelude::*;
    let config = Config::from_url(&cfg.valkey_url)?;
    let pool = Builder::from_config(config).build_pool(4)?;
    pool.init().await?;
    Ok(pool)
}
