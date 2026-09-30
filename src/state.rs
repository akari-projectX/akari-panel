use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use sqlx::PgPool;
use tokio::sync::watch;
use uuid::Uuid;

use crate::config::PanelConfig;
use crate::install::Install;
use crate::traffic::TrafficBuffer;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

struct Inner {
    cfg: PanelConfig,
    route_prefix: String,
    jwt_secret: String,
    install: Install,
    pg: PgPool,
    valkey: fred::clients::Pool,
    /// Connected node id -> connection generation, so a stale session's
    /// cleanup can never evict a newer connection's registration.
    agents: DashMap<Uuid, (u64, Uuid)>,
    gen: AtomicU64,
    /// Bumped whenever node/user configuration changes; gRPC sessions watch
    /// it to push fresh snapshots to connected agents.
    changes: watch::Sender<u64>,
    traffic: TrafficBuffer,
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
        let (changes, _) = watch::channel(0);
        Self(Arc::new(Inner {
            cfg,
            route_prefix,
            jwt_secret,
            install,
            pg,
            valkey,
            agents: DashMap::new(),
            gen: AtomicU64::new(1),
            changes,
            traffic: TrafficBuffer::new(),
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
    pub fn pg(&self) -> &PgPool {
        &self.0.pg
    }
    pub fn valkey(&self) -> &fred::clients::Pool {
        &self.0.valkey
    }
    /// node -> (connection generation, online_session)
    pub fn agents(&self) -> &DashMap<Uuid, (u64, Uuid)> {
        &self.0.agents
    }
    pub fn traffic(&self) -> &TrafficBuffer {
        &self.0.traffic
    }
    pub fn next_gen(&self) -> u64 {
        self.0.gen.fetch_add(1, Ordering::Relaxed)
    }
    pub fn notify_change(&self) {
        self.0.changes.send_modify(|v| *v += 1);
    }
    pub fn subscribe_changes(&self) -> watch::Receiver<u64> {
        self.0.changes.subscribe()
    }

    /// Periodically persists online status for connected agents.
    /// Live status is in Valkey (TTL keys); this only feeds the DB table.
    pub async fn persist_online_loop(self) {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            tick.tick().await;
            let (ids, sessions): (Vec<Uuid>, Vec<Uuid>) = self
                .agents()
                .iter()
                .map(|e| (*e.key(), e.value().1))
                .unzip();
            if ids.is_empty() {
                continue;
            }
            // Only refresh rows this instance's sessions still own.
            if let Err(e) = sqlx::query(
                "UPDATE nodes n SET status = 'online', last_seen_at = now() \
                 FROM unnest($1::uuid[], $2::uuid[]) AS s(id, sess) \
                 WHERE n.id = s.id AND n.online_session = s.sess",
            )
            .bind(&ids)
            .bind(&sessions)
            .execute(self.pg())
            .await
            {
                tracing::warn!(error = %e, "persist online status failed");
            }
        }
    }
}

pub async fn connect_valkey(cfg: &PanelConfig) -> anyhow::Result<fred::clients::Pool> {
    use fred::prelude::*;
    let config = Config::from_url(&cfg.valkey_url)?;
    let pool = Builder::from_config(config).build_pool(4)?;
    pool.init().await?;
    Ok(pool)
}
