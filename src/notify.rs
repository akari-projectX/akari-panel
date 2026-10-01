//! Targeted, multi-instance change notification (S3-2, R12 D3).
//!
//! Every committed change of a node's desired-state versions, and every node
//! deletion, raises `NOTIFY akari_change` from a trigger on `nodes`
//! (migration 0007) inside the writing transaction; PostgreSQL delivers it
//! on commit to every listening panel instance. Payload: the node id, or
//! `del:<node id>` for a deletion. Writes that do not change the versions
//! (flush, lease, online status, failures) never notify.
//!
//! Each instance runs one listener on a DEDICATED connection (its own
//! single-connection pool, never the app pool) and dispatches to per-node
//! wakeups; agent sessions subscribe for their own node only. Wakeups carry
//! no content: a session re-reads its node from the DB, so deletion is
//! always derived from the DB (`del:` is only a hint). Delivery is not
//! guaranteed across a lost listener connection, so on ANY listener error
//! the connection is dropped and re-created, LISTEN re-issued, and THEN all
//! local sessions are woken; every session also reconciles every 60 s.
//! A half-open connection is detected end to end: the instance NOTIFYs a
//! ping to itself every PING_EVERY and reconnects if it does not come back.
//!
//! LISTEN needs a direct session to PostgreSQL: a PgBouncer in transaction
//! (or statement) pooling mode silently drops notifications.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use sqlx::postgres::{PgListener, PgPoolOptions};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use crate::state::AppState;

pub const CHANNEL: &str = "akari_change";

/// A parsed notification payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Changed(Uuid),
    Deleted(Uuid),
    /// Liveness probe of some panel instance (see PING_EVERY).
    Ping(Uuid),
    /// Not ours or malformed: wake everyone (cheap insurance; a session
    /// only re-reads its node).
    Unknown,
}

pub fn parse(payload: &str) -> Event {
    let (kind, id) = match payload.split_once(':') {
        Some((k, id)) => (k, id),
        None => ("", payload),
    };
    // Only the canonical hyphenated form our trigger emits.
    let id = match Uuid::try_parse(id) {
        Ok(u) if u.hyphenated().to_string() == id => u,
        _ => return Event::Unknown,
    };
    match kind {
        "" => Event::Changed(id),
        "del" => Event::Deleted(id),
        "ping" => Event::Ping(id),
        _ => Event::Unknown,
    }
}

/// Added to a node's counter by `wake_all` (targeted wakes add 1), so a
/// session can tell a mass wakeup and spread its re-read (jitter).
pub const WAKE_ALL: u64 = 1 << 32;

/// Did the counter move from `old` to `new` by a wake-all?
pub fn is_wake_all(old: u64, new: u64) -> bool {
    old >> 32 != new >> 32
}

/// node -> wakeup counter shared by this instance's sessions of that node.
#[derive(Default)]
pub struct Wakeups {
    nodes: DashMap<Uuid, watch::Sender<u64>>,
    connected: AtomicBool,
    /// Backend pid of the current listener connection (0 = none); lets
    /// tests (and operators) find it in pg_stat_activity.
    listener_pid: AtomicI32,
    /// Identity of the current listener backend (for the guarded
    /// server-side termination).
    listener_backend: std::sync::Mutex<Option<ListenerBackend>>,
    /// Completed (re)connects, for tests and logs.
    connects: AtomicU64,
    /// This instance's ping id.
    instance: std::sync::OnceLock<Uuid>,
    /// Tests: keep the listener disconnected (a deterministic gap).
    #[cfg(test)]
    pub hold_reconnect: AtomicBool,
}

impl Wakeups {
    /// Subscribe to `node`'s wakeups. Get-or-insert and subscribe happen
    /// under the map's shard lock, so `release` can never drop a channel
    /// between creation and subscription.
    pub fn subscribe(&self, node: Uuid) -> watch::Receiver<u64> {
        self.nodes
            .entry(node)
            .or_insert_with(|| watch::channel(0).0)
            .subscribe()
    }

    /// Drop `node`'s channel once no session holds a receiver (call after
    /// dropping yours). Checked under the same shard lock.
    pub fn release(&self, node: Uuid) {
        self.nodes
            .remove_if(&node, |_, tx| tx.receiver_count() == 0);
    }

    /// Wake `node`'s sessions on this instance. Never creates an entry.
    pub fn wake(&self, node: Uuid) {
        if let Some(tx) = self.nodes.get(&node) {
            tx.send_modify(|v| *v += 1);
        }
    }

    /// Wake every local session (after a listener gap: notifications may
    /// have been missed). Sessions bound their concurrent DB reads
    /// (AppState::read_permits), so this is no thundering herd on the pool.
    pub fn wake_all(&self) {
        for tx in self.nodes.iter() {
            tx.send_modify(|v| *v += WAKE_ALL);
        }
    }

    pub fn dispatch(&self, ev: Event) {
        match ev {
            Event::Changed(n) | Event::Deleted(n) => self.wake(n),
            Event::Ping(_) => {}
            Event::Unknown => self.wake_all(),
        }
    }

    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    pub fn listener_pid(&self) -> i32 {
        self.listener_pid.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub fn connects(&self) -> u64 {
        self.connects.load(Ordering::SeqCst)
    }

    fn instance(&self) -> Uuid {
        *self.instance.get_or_init(Uuid::new_v4)
    }

    #[cfg(test)]
    pub fn has(&self, node: Uuid) -> bool {
        self.nodes.contains_key(&node)
    }
}

/// Reconnect delay after the listener connection fails.
const RECONNECT_MIN: Duration = Duration::from_millis(500);
const RECONNECT_MAX: Duration = Duration::from_secs(10);
/// Self-ping cadence and how long a ping may take to come back.
const PING_EVERY: Duration = Duration::from_secs(30);
const PING_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the notification queue fill level is checked.
const QUEUE_CHECK_EVERY: Duration = Duration::from_secs(60);
/// pg_notification_queue_usage() above this is logged as a warning: some
/// listener (maybe another instance) is not consuming, and once the queue
/// is full every NOTIFY — i.e. every mutation — fails.
const QUEUE_WARN: f64 = 0.1;

async fn connect(state: &AppState) -> sqlx::Result<PgListener> {
    // Own single-connection pool with the main pool's connect options (same
    // server, TLS, search_path): never a connection borrowed from the pool.
    let w = state.wakeups();
    // A per-connection application_name marks the backend as this
    // instance's listener (see `terminate_listener`).
    let app_name = format!(
        "akari-listener-{}-{}",
        w.instance().simple(),
        w.connects.load(Ordering::SeqCst)
    );
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .idle_timeout(None)
        .max_lifetime(None)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(
            (*state.pg().connect_options())
                .clone()
                .application_name(&app_name),
        )
        .await?;
    let mut l = PgListener::connect_with(&pool).await?;
    // Reconnects are handled by the supervisor (to wake everyone), never
    // silently inside sqlx.
    l.eager_reconnect(false);
    l.ignore_pool_close_event(true);
    let (pid, started): (i32, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT pid, backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()",
    )
    .fetch_one(&mut l)
    .await?;
    // LISTEN last: it stays the backend's reported query.
    l.listen(CHANNEL).await?;
    *w.listener_backend.lock().unwrap() = Some(ListenerBackend {
        pid,
        started,
        app_name,
    });
    w.listener_pid.store(pid, Ordering::SeqCst);
    Ok(l)
}

/// Identity of a listener backend, captured when it connected: a pid alone
/// may have been reused by an unrelated backend by the time the old
/// connection is judged dead.
#[derive(Clone, Debug)]
pub struct ListenerBackend {
    pub pid: i32,
    pub started: chrono::DateTime<chrono::Utc>,
    pub app_name: String,
}

/// R14 N2: terminate `b` server-side only if that pid is still the same
/// backend (same backend_start), still ours (application_name, database,
/// role) and still a LISTEN session. Returns whether it was terminated.
pub async fn terminate_listener(pg: &sqlx::PgPool, b: &ListenerBackend) -> sqlx::Result<bool> {
    let hit: Option<bool> = sqlx::query_scalar(
        "SELECT pg_terminate_backend(a.pid) FROM pg_stat_activity a \
         WHERE a.pid = $1 AND a.backend_start = $2 AND a.application_name = $3 \
           AND a.datname = current_database() AND a.usename = current_user \
           AND a.backend_type = 'client backend' \
           AND a.query ILIKE 'LISTEN %'",
    )
    .bind(b.pid)
    .bind(b.started)
    .bind(&b.app_name)
    .fetch_optional(pg)
    .await?;
    Ok(hit.unwrap_or(false))
}

/// Connect with backoff until LISTEN is established.
async fn connect_retrying(state: &AppState) -> PgListener {
    let mut delay = RECONNECT_MIN;
    loop {
        match connect(state).await {
            Ok(l) => return l,
            Err(e) => {
                tracing::warn!(error = %e, retry_in = ?delay, "change listener: connect failed");
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(RECONNECT_MAX);
            }
        }
    }
}

/// Establish LISTEN (retrying), then run the listener for the process
/// lifetime in the background. Returns once the first LISTEN is in place:
/// the gRPC server must not accept sessions before (R12 D3).
pub async fn start(state: AppState) -> tokio::task::JoinHandle<()> {
    let first = connect_retrying(&state).await;
    tokio::spawn(supervise(state, first))
}

async fn supervise(state: AppState, first: PgListener) {
    let w = state.wakeups();
    let mut next = Some(first);
    loop {
        let listener = match next.take() {
            Some(l) => l,
            None => {
                #[cfg(test)]
                while w.hold_reconnect.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                connect_retrying(&state).await
            }
        };
        w.connected.store(true, Ordering::SeqCst);
        w.connects.fetch_add(1, Ordering::SeqCst);
        crate::metrics::listener_connected();
        tracing::info!(pid = w.listener_pid(), "change listener: listening");
        // LISTEN is in place; anything committed before it may be missed.
        w.wake_all();
        let err = run(&state, listener).await;
        w.connected.store(false, Ordering::SeqCst);
        w.listener_pid.store(0, Ordering::SeqCst);
        *w.listener_backend.lock().unwrap() = None;
        tracing::warn!(error = %err, "change listener: disconnected; reconnecting");
        tokio::time::sleep(RECONNECT_MIN).await;
    }
}

/// Pump one listener connection until it fails or stops answering pings.
/// The listener lives in its own task (try_recv is not cancel-safe), which
/// is aborted — dropping the connection — when the connection is judged
/// dead.
async fn run(state: &AppState, mut listener: PgListener) -> String {
    let backend = state.wakeups().listener_backend.lock().unwrap().clone();
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<Result<Event, String>>();
    let reader = tokio::spawn(async move {
        loop {
            let r = match listener.try_recv().await {
                Ok(Some(n)) => Ok(parse(n.payload())),
                Ok(None) => Err("connection lost".to_string()),
                Err(e) => Err(e.to_string()),
            };
            let stop = r.is_err();
            if ev_tx.send(r).is_err() || stop {
                return;
            }
        }
    });
    let w = state.wakeups();
    let me = w.instance();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
    let mut awaiting: Option<tokio::time::Instant> = None;
    let err = loop {
        let deadline = awaiting.map(|t| t + PING_TIMEOUT);
        tokio::select! {
            ev = ev_rx.recv() => match ev {
                Some(Ok(Event::Ping(id))) if id == me => awaiting = None,
                Some(Ok(ev)) => {
                    if let Event::Deleted(n) = ev {
                        // Hint only (sessions re-read the DB); drop what
                        // this instance buffered for the node — off the
                        // listener task (a full buffer scan).
                        let st = state.clone();
                        tokio::spawn(async move { st.traffic().forget_node(n) });
                    }
                    w.dispatch(ev)
                }
                Some(Err(e)) => break e,
                None => break "listener task ended".to_string(),
            },
            _ = ping.tick(), if awaiting.is_none() => {
                let sent = sqlx::query("SELECT pg_notify($1, $2)")
                    .bind(CHANNEL)
                    .bind(format!("ping:{me}"))
                    .execute(state.pg())
                    .await;
                // If the DB is unreachable for the pool too, the listener
                // notices on its own; only judge a ping that was sent.
                if sent.is_ok() {
                    awaiting = Some(tokio::time::Instant::now());
                }
            }
            _ = sleep_until(deadline) => {
                break "self-ping not delivered (half-open connection?)".to_string()
            }
        }
    };
    // Hard-close the old backend server-side (bounded), so a half-open
    // connection does not keep a LISTEN session (and its queue position)
    // alive on the server. Dropping the PgListener spawns sqlx's UNLISTEN
    // task, which on a half-open socket ends only when the kernel gives up
    // on the connection; that leaks one idle task per such incident.
    if let Some(b) = backend {
        match tokio::time::timeout(Duration::from_secs(5), terminate_listener(state.pg(), &b)).await
        {
            Ok(Ok(true)) => tracing::info!(pid = b.pid, "change listener: old backend terminated"),
            Ok(Ok(false)) => {}
            Ok(Err(e)) => tracing::debug!(error = %e, "change listener: terminate failed"),
            Err(_) => tracing::debug!("change listener: terminate timed out"),
        }
    }
    reader.abort();
    let _ = reader.await;
    err
}

async fn sleep_until(t: Option<tokio::time::Instant>) {
    match t {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending().await,
    }
}

/// Warns when the notification queue fills up (runs for the process
/// lifetime).
pub async fn queue_monitor(state: AppState) {
    let mut tick = tokio::time::interval(QUEUE_CHECK_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        match sqlx::query_scalar::<_, f64>("SELECT pg_notification_queue_usage()")
            .fetch_one(state.pg())
            .await
        {
            Ok(u) => {
                crate::metrics::queue_usage(u);
                if u > QUEUE_WARN {
                    tracing::warn!(
                        usage = u,
                        "PostgreSQL notification queue over 10% full: some LISTEN session is not \
                         consuming; when it fills, every mutation fails"
                    );
                }
            }
            Err(e) => tracing::debug!(error = %e, "notification queue check failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads() {
        let n = Uuid::new_v4();
        assert_eq!(parse(&n.to_string()), Event::Changed(n));
        assert_eq!(parse(&format!("del:{n}")), Event::Deleted(n));
        assert_eq!(parse(&format!("ping:{n}")), Event::Ping(n));
        for bad in [
            String::new(),
            "del:".into(),
            "del:nope".into(),
            "x".into(),
            format!("del:del:{n}"),
            format!("zap:{n}"),
            n.simple().to_string(),
            n.to_string().to_uppercase(),
            format!("{{{n}}}"),
        ] {
            assert_eq!(parse(&bad), Event::Unknown, "{bad:?}");
        }
    }

    #[tokio::test]
    async fn dispatch_is_per_node_and_release_drops_idle_channels() {
        let w = Wakeups::default();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut ra = w.subscribe(a);
        let mut ra2 = w.subscribe(a);
        let mut rb = w.subscribe(b);
        w.dispatch(Event::Changed(a));
        assert!(ra.has_changed().unwrap() && ra2.has_changed().unwrap());
        assert!(!rb.has_changed().unwrap());
        ra.borrow_and_update();
        ra2.borrow_and_update();
        w.dispatch(Event::Deleted(b));
        assert!(rb.has_changed().unwrap());
        rb.borrow_and_update();
        assert!(!ra.has_changed().unwrap());
        w.dispatch(Event::Ping(a));
        assert!(!ra.has_changed().unwrap());
        w.dispatch(Event::Unknown);
        assert!(ra.has_changed().unwrap() && rb.has_changed().unwrap());
        // A payload for a node without local sessions creates nothing.
        w.dispatch(Event::Changed(Uuid::new_v4()));
        assert_eq!(w.nodes.len(), 2);
        w.release(a);
        assert!(w.has(a), "still subscribed");
        drop(ra);
        drop(ra2);
        w.release(a);
        assert!(!w.has(a));
    }

    async fn changed_within(rx: &mut watch::Receiver<u64>, secs: u64) -> bool {
        tokio::time::timeout(Duration::from_secs(secs), rx.changed())
            .await
            .is_ok_and(|r| r.is_ok())
    }

    async fn bump(pool: &sqlx::PgPool, node: Uuid) {
        sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = $1")
            .bind(node)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Two panel instances on one database: a change committed through A
    /// wakes B's session of that node (and only that node). Then B's
    /// listener is killed; a change committed during the gap is not
    /// delivered, but B wakes all its sessions right after re-LISTEN —
    /// convergence in about the reconnect time, not the 60 s reconcile.
    #[tokio::test]
    async fn cross_instance_wakeups_and_listener_gap() {
        let Some(db) = crate::testdb::TestDb::new().await else {
            return;
        };
        let (n, other) = (db.node().await, db.node().await);
        let a = AppState::for_test(db.pool.clone()).await;
        let b = AppState::for_test(db.pool.clone()).await;
        let la = start(a.clone()).await;
        let lb = start(b.clone()).await;
        let mut rx = b.wakeups().subscribe(n);
        let mut rx_other = b.wakeups().subscribe(other);
        // Past the initial wake-all.
        tokio::time::sleep(Duration::from_millis(100)).await;
        rx.borrow_and_update();
        rx_other.borrow_and_update();

        let mut tx = a.pg().begin().await.unwrap();
        crate::api::apply_begin_delete_node(&mut tx, &crate::audit::Actor::test(), n)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!(
            changed_within(&mut rx, 5).await,
            "A's commit wakes B's session"
        );
        assert!(
            !rx_other.has_changed().unwrap(),
            "other nodes are not woken"
        );

        // Kill B's listener and hold it down: a deterministic gap.
        b.wakeups().hold_reconnect.store(true, Ordering::SeqCst);
        let pid = b.wakeups().listener_pid();
        assert!(pid > 0);
        sqlx::query("SELECT pg_terminate_backend($1)")
            .bind(pid)
            .execute(&db.pool)
            .await
            .unwrap();
        for _ in 0..100 {
            if !b.wakeups().connected() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!b.wakeups().connected(), "listener noticed its death");
        let connects = b.wakeups().connects();
        rx.borrow_and_update();
        bump(a.pg(), n).await; // committed while B does not listen
        assert!(!changed_within(&mut rx, 1).await, "missed during the gap");
        let t = std::time::Instant::now();
        b.wakeups().hold_reconnect.store(false, Ordering::SeqCst);
        assert!(changed_within(&mut rx, 10).await, "woken after re-LISTEN");
        assert!(
            t.elapsed() < Duration::from_secs(10),
            "well under the 60 s tick"
        );
        assert!(b.wakeups().connects() > connects);
        assert!(b.wakeups().connected());
        // And delivery works again afterwards.
        rx.borrow_and_update();
        bump(a.pg(), n).await;
        assert!(changed_within(&mut rx, 5).await);

        la.abort();
        lb.abort();
        let _ = la.await;
        let _ = lb.await;
        drop((a, b));
        db.drop().await;
    }

    /// R12 D3: writes that do not change the versions never notify
    /// (flush, lease, online status, failure records, traffic).
    #[tokio::test]
    async fn non_version_writes_do_not_notify() {
        let Some(db) = crate::testdb::TestDb::new().await else {
            return;
        };
        let (n, u) = db.member().await;
        let mut l = db.listener().await;
        for sql in [
            "UPDATE nodes SET lease_expires_at = now() WHERE id = $1",
            "UPDATE nodes SET status = 'online', last_seen_at = now(), online_session = gen_random_uuid() WHERE id = $1",
            "UPDATE nodes SET status = 'offline' WHERE id = $1",
            "UPDATE nodes SET last_error = 'x', failed_config_version = 1 WHERE id = $1",
            "UPDATE nodes SET traffic_tat = now(), agent_protocol = 1 WHERE id = $1",
            "UPDATE nodes SET name = name || '-x', server_addr = 'h' WHERE id = $1",
        ] {
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(n)
                .execute(&db.pool)
                .await
                .unwrap();
        }
        let b = crate::traffic::TrafficBuffer::new();
        crate::traffic::refresh_members(&db.pool, &b, n)
            .await
            .unwrap();
        b.update(
            n,
            "s1",
            &crate::gen::TrafficReport {
                users: vec![crate::gen::UserTraffic {
                    user_id: u.to_string(),
                    up_bytes: 5,
                    down_bytes: 5,
                }],
                ..Default::default()
            },
        );
        crate::traffic::flush_for_test(&db.pool, &b).await;
        assert_eq!(db.used(u).await, 10);
        let got: Vec<String> = crate::testdb::drain(&mut l, Duration::from_millis(300))
            .await
            .into_iter()
            .filter(|p| p.contains(&n.to_string()))
            .collect();
        assert!(got.is_empty(), "{got:?}");
        drop(l);
        db.drop().await;
    }

    /// R14 N2: the dead-listener cleanup terminates a backend only if it is
    /// still the very listener session we connected (same pid AND
    /// backend_start, our application_name, a LISTEN session) — never a
    /// reused pid.
    #[tokio::test]
    async fn listener_termination_is_guarded_by_backend_identity() {
        let Some(db) = crate::testdb::TestDb::new().await else {
            return;
        };
        let a = AppState::for_test(db.pool.clone()).await;
        let la = start(a.clone()).await;
        let real = a
            .wakeups()
            .listener_backend
            .lock()
            .unwrap()
            .clone()
            .expect("listener connected");
        assert!(real.app_name.starts_with("akari-listener-"));

        // An unrelated live backend of the same role (a pool connection):
        // stands in for "the pid was reused".
        let mut other = db.pool.acquire().await.unwrap();
        let (opid, ostart): (i32, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
            "SELECT pid, backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        )
        .fetch_one(&mut *other)
        .await
        .unwrap();
        for spoof in [
            // reused pid, our recorded start time and name
            ListenerBackend {
                pid: opid,
                ..real.clone()
            },
            // right pid and start, but not our name
            ListenerBackend {
                pid: opid,
                started: ostart,
                app_name: "x".into(),
            },
            // right pid and name, different start (the old backend died)
            ListenerBackend {
                started: real.started - chrono::Duration::seconds(1),
                ..real.clone()
            },
        ] {
            assert!(
                !terminate_listener(&db.pool, &spoof).await.unwrap(),
                "{spoof:?}"
            );
        }
        // The pool connection is alive and well.
        let one: i32 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&mut *other)
            .await
            .unwrap();
        assert_eq!(one, 1);
        // Even a correct identity of a backend that is not LISTENing is
        // refused (e.g. our pool connection with a matching name).
        sqlx::query("SET application_name = 'akari-listener-fake'")
            .execute(&mut *other)
            .await
            .unwrap();
        let not_listening = ListenerBackend {
            pid: opid,
            started: ostart,
            app_name: "akari-listener-fake".into(),
        };
        assert!(!terminate_listener(&db.pool, &not_listening).await.unwrap());
        drop(other);

        // The genuine listener is terminated (and the supervisor reconnects).
        let connects = a.wakeups().connects();
        assert!(terminate_listener(&db.pool, &real).await.unwrap());
        for _ in 0..250 {
            if a.wakeups().connects() > connects && a.wakeups().connected() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(a.wakeups().connects() > connects, "reconnected");
        la.abort();
        let _ = la.await;
        drop(a);
        db.drop().await;
    }
}
