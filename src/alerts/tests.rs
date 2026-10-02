//! W17 alert tests: the pure rules (`evaluate`, `plan`), validators, the
//! webhook signature (fixed vector), and real-database rounds: fire →
//! notify → resolve, dedupe, cooldown, muted nodes, one leader among two
//! instances, delivery through a mock webhook receiver and a mock Telegram
//! Bot API (HMAC verified, retries, dead letters, exclusive claims), the
//! settings API (optimistic concurrency, sealed secrets never returned or
//! audited) and per-node rules.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, Method, StatusCode};
use chrono::{Duration, TimeZone};
use serde_json::json;

use super::channels::{self, Message};
use super::eval::{self, evaluate, plan, Facts, Firing, Observed, Rules, Step, Verdict};
use super::*;
use crate::testdb::http::{rand_ip, Client};
use crate::testdb::TestDb;

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 2, 12, 0, 0).unwrap()
}

fn all_rules() -> Rules {
    Rules {
        offline_secs: Some(300),
        cpu: Some((90.0, 3)),
        mem: Some((80.0, 2)),
        disk: Some(90.0),
        cert_days: Some(14),
        latency: true,
        last_error: true,
    }
}

fn kinds(v: &Verdict) -> Vec<&'static str> {
    v.firing.iter().map(|o| o.kind).collect()
}

fn online() -> Facts {
    Facts {
        online: true,
        seen_age_secs: Some(5),
        heartbeat: true,
        ..Default::default()
    }
}

#[test]
fn offline_rule_and_stale_live_kinds() {
    let r = all_rules();
    let f = Facts {
        online: false,
        seen_age_secs: Some(299),
        ..Default::default()
    };
    let v = evaluate(&f, &r, now());
    assert!(v.firing.is_empty());
    assert_eq!(v.unknown, LIVE_KINDS.to_vec());
    let f = Facts {
        seen_age_secs: Some(3700),
        ..f
    };
    let v = evaluate(&f, &r, now());
    assert_eq!(kinds(&v), vec!["offline"]);
    assert_eq!(v.firing[0].value, "离线 1 小时 1 分");
    // Never seen: not "offline" (a node that never connected is pending).
    let f = Facts {
        seen_age_secs: None,
        ..f
    };
    assert!(evaluate(&f, &r, now()).firing.is_empty());
    // Rule off.
    let f = Facts {
        seen_age_secs: Some(10_000),
        ..Default::default()
    };
    let r = Rules {
        offline_secs: None,
        ..all_rules()
    };
    assert!(evaluate(&f, &r, now()).firing.is_empty());
}

#[test]
fn cpu_and_memory_windows_have_hysteresis() {
    let r = all_rules();
    let mut f = online();
    // Rising but not yet 3 minutes: undecided (state kept).
    f.cpu = vec![(1, 95.0), (2, 97.0), (3, 50.0)];
    let v = evaluate(&f, &r, now());
    assert!(v.firing.is_empty() && v.unknown.contains(&"cpu"));
    // Three complete minutes above: fires with the lowest of them.
    f.cpu = vec![(1, 95.0), (2, 97.0), (3, 92.4)];
    let v = evaluate(&f, &r, now());
    assert_eq!(kinds(&v), vec!["cpu"]);
    assert_eq!(v.firing[0].value, "CPU 92%");
    // The last minute dropped: clear (resolves).
    f.cpu = vec![(1, 90.0), (2, 97.0), (3, 92.0)];
    let v = evaluate(&f, &r, now());
    assert!(v.firing.is_empty() && !v.unknown.contains(&"cpu"));
    // A gap in the window: undecided; no last minute: undecided.
    f.cpu = vec![(1, 95.0), (3, 97.0)];
    assert!(evaluate(&f, &r, now()).unknown.contains(&"cpu"));
    f.cpu = vec![(2, 95.0), (3, 97.0)];
    assert!(evaluate(&f, &r, now()).unknown.contains(&"cpu"));
    f.cpu = vec![];
    f.mem = vec![(1, 81.0), (2, 85.0)];
    let v = evaluate(&f, &r, now());
    assert_eq!(kinds(&v), vec!["memory"]);
}

#[test]
fn disk_latency_certificates_last_error() {
    let r = all_rules();
    let mut f = online();
    f.disk = Some((95 << 30, 100 << 30));
    f.latency = vec![
        ("agent".into(), 2, 1, "x".into()),
        ("panel".into(), 3, 3, "in-vless: refused".into()),
    ];
    f.tls_domain = Some("n1.example.com".into());
    f.cert = Some(("failed".into(), Some(now() + Duration::days(3))));
    f.agent_cert_not_after = Some(now() - Duration::hours(1));
    f.last_error = Some("xray: bad inbound\n".into());
    let v = evaluate(&f, &r, now());
    assert_eq!(
        kinds(&v),
        vec!["disk", "latency", "cert", "agent_cert", "last_error"]
    );
    assert_eq!(v.firing[0].value, "磁盘 95%");
    assert!(v.firing[1].detail.contains("in-vless: refused"));
    assert!(v.firing[2].value.contains("剩余 3 天"));
    assert!(v.firing[3].value.contains("已于"));
    assert_eq!(v.firing[4].detail, "xray: bad inbound");
    // Healthy values clear; no heartbeat: disk and cert undecided.
    f.disk = Some((10, 100));
    f.latency = vec![
        ("panel".into(), 3, 2, "x".into()),
        ("agent".into(), 0, 0, String::new()),
    ];
    f.cert = Some(("valid".into(), Some(now() + Duration::days(60))));
    f.agent_cert_not_after = Some(now() + Duration::days(60));
    f.last_error = None;
    // (No minute history: CPU and memory are undecided.)
    let v = evaluate(&f, &r, now());
    assert!(v.firing.is_empty(), "{v:?}");
    assert_eq!(v.unknown, vec!["cpu", "memory"]);
    f.heartbeat = false;
    f.disk = None;
    f.cert = None;
    let v = evaluate(&f, &r, now());
    assert_eq!(v.unknown, vec!["cpu", "memory", "disk", "cert"]);
    // Every rule off: nothing.
    let mut f = online();
    f.last_error = Some("e".into());
    f.disk = Some((99, 100));
    assert!(evaluate(&f, &Rules::default(), now()).firing.is_empty());
}

fn firing(id: i64, node: Uuid, kind: &str, notified: bool) -> Firing {
    Firing {
        id,
        node_id: node,
        kind: kind.into(),
        value: "v".into(),
        detail: "d".into(),
        notified,
        fired_at: now(),
        node_name: "n".into(),
    }
}

fn obs(kind: &'static str, value: &str) -> Observed {
    Observed {
        kind,
        value: value.into(),
        detail: "d".into(),
    }
}

#[test]
fn plan_transitions() {
    let (a, b, gone) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let stored = vec![
        firing(1, a, "offline", true),
        firing(2, a, "cpu", true),
        firing(3, a, "disk", false),
        firing(4, b, "memory", true),
        firing(5, gone, "offline", true),
    ];
    let mut verdicts = HashMap::new();
    verdicts.insert(
        a,
        Verdict {
            firing: vec![obs("offline", "v"), obs("last_error", "e")],
            unknown: vec!["cpu"],
        },
    );
    verdicts.insert(
        b,
        Verdict {
            firing: vec![obs("memory", "changed")],
            unknown: vec![],
        },
    );
    let steps = plan(&stored, &verdicts);
    assert_eq!(
        steps,
        vec![
            // cpu unknown: kept; disk cleared, never notified: silent.
            Step::Resolve {
                id: 3,
                notify: false
            },
            Step::Update {
                id: 4,
                value: "changed".into(),
                detail: "d".into()
            },
            // The node left monitoring: silent.
            Step::Resolve {
                id: 5,
                notify: false
            },
            Step::Fire {
                node: a,
                obs: obs("last_error", "e")
            },
        ]
    );
    // Cleared after a notified firing: the resolution is notified.
    let only_a = HashMap::from([(a, Verdict::default())]);
    let steps = plan(&stored[..1], &only_a);
    assert_eq!(
        steps,
        vec![Step::Resolve {
            id: 1,
            notify: true
        }]
    );
}

#[test]
fn validators() {
    for ok in ["123456789", "-1001234567890", "@akari_ops"] {
        assert!(valid_chat_id(ok), "{ok}");
    }
    for bad in ["", "-", "12a", "@abc", "@bad-name", &"9".repeat(21)] {
        assert!(!valid_chat_id(bad), "{bad}");
    }
    assert!(valid_bot_token(
        "123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123"
    ));
    for bad in [
        "123:short",
        "abc:AAHabcdefghijklmnopqrstuvwxyz01234",
        "123456789",
    ] {
        assert!(!valid_bot_token(bad), "{bad}");
    }
    assert!(check_webhook_url("https://hooks.example.com/akari?x=1").is_ok());
    assert!(check_webhook_url("http://127.0.0.1:9000/hook").is_ok());
    for bad in [
        "http://hooks.example.com/x",
        "https://user:pw@hooks.example.com/",
        "ftp://x",
        "https://exa mple.com",
        "/relative",
    ] {
        assert!(check_webhook_url(bad).is_err(), "{bad}");
    }
    assert!(valid_webhook_secret("0123456789abcdef"));
    assert!(!valid_webhook_secret("short"));
    assert!(!valid_webhook_secret("0123456789abcdef with space"));
    assert!(valid_email("ops@example.com"));
    for bad in ["ops", "a@b", "a b@c.com", "a@c.com,b@d.com", "@c.com"] {
        assert!(!valid_email(bad), "{bad}");
    }
    let mut n = NodeRules {
        disabled: vec!["cpu".into()],
        ..Default::default()
    };
    assert!(n.check().is_ok());
    n.disabled.push("nope".into());
    assert!(n.check().is_err());
    let n = NodeRules {
        cpu_minutes: Some(61),
        ..Default::default()
    };
    assert!(n.check().is_err());
}

/// Fixed vector (Python: hmac.new(secret, b"1700000000." + body, sha256)).
#[test]
fn webhook_signature_vector() {
    let sig = channels::signature(b"s3cr3t-s3cr3t-s3cr3t", 1_700_000_000, br#"{"a":1}"#);
    assert_eq!(
        sig,
        "sha256=8f47f8e3fd89f18a426def015cd88dadc6155d9d735057c6f8a91ed73f321873"
    );
    assert!(channels::verify_signature(
        b"s3cr3t-s3cr3t-s3cr3t",
        1_700_000_000,
        br#"{"a":1}"#,
        &sig
    ));
    assert!(!channels::verify_signature(
        b"s3cr3t-s3cr3t-s3cr3t",
        1_700_000_001,
        br#"{"a":1}"#,
        &sig
    ));
    assert!(!channels::verify_signature(
        b"other-other-other",
        1_700_000_000,
        br#"{"a":1}"#,
        &sig
    ));
    assert!(!channels::verify_signature(b"k", 1, b"", "md5=00"));
    assert_eq!(channels::backoff_secs(1), 30);
    assert_eq!(channels::backoff_secs(2), 60);
    assert_eq!(channels::backoff_secs(8), 3600);
}

#[test]
fn messages() {
    let node = Uuid::new_v4();
    let m = Message::alert(
        "firing",
        7,
        node,
        "hk-1",
        "offline",
        "离线 5 分钟",
        "详情",
        now(),
        None,
    );
    assert_eq!(m.title(), "[告警] hk-1：节点离线");
    assert!(m.text().contains("2026-10-02 12:00:00 UTC"));
    assert_eq!(m.payload["alert"]["id"], 7);
    let m = Message::alert(
        "resolved",
        7,
        node,
        "hk-1",
        "cpu",
        "CPU 95%",
        "",
        now(),
        Some(now() + Duration::minutes(3)),
    );
    assert_eq!(m.title(), "[恢复] hk-1：CPU 过高");
    assert_eq!(m.event(), "resolved");
    assert_eq!(Message::test("root").event(), "test");
}

// ---------------------------------------------------------------------------
// Real database
// ---------------------------------------------------------------------------

/// One request a mock received: (path, headers, body).
type Request = (String, HeaderMap, Vec<u8>);

/// A mock HTTP receiver: records (path, headers, body); answers `status`.
#[derive(Clone, Default)]
struct Mock {
    got: Arc<Mutex<Vec<Request>>>,
    status: Arc<Mutex<u16>>,
    body: Arc<Mutex<String>>,
}

impl Mock {
    async fn start(status: u16, body: &str) -> (Self, String) {
        let m = Mock::default();
        *m.status.lock().unwrap() = status;
        *m.body.lock().unwrap() = body.to_string();
        let mm = m.clone();
        let app = axum::Router::new().fallback(
            move |uri: axum::http::Uri, headers: HeaderMap, body: axum::body::Bytes| {
                let mm = mm.clone();
                async move {
                    mm.got
                        .lock()
                        .unwrap()
                        .push((uri.path().to_string(), headers, body.to_vec()));
                    let s = *mm.status.lock().unwrap();
                    let b = mm.body.lock().unwrap().clone();
                    (StatusCode::from_u16(s).unwrap(), b)
                }
            },
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(l, app).await;
        });
        (m, format!("http://{addr}"))
    }
    fn set(&self, status: u16, body: &str) {
        *self.status.lock().unwrap() = status;
        *self.body.lock().unwrap() = body.to_string();
    }
    fn count(&self) -> usize {
        self.got.lock().unwrap().len()
    }
}

async fn token(state: &AppState, id: Uuid) -> String {
    let (role, sv): (String, i64) =
        sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
            .bind(id)
            .fetch_one(state.pg())
            .await
            .unwrap();
    crate::auth::issue_token(state, id, &role, sv, crate::auth::Stage::Full).unwrap()
}

const SECRET: &str = "webhook-secret-0123456789";
const BOT: &str = "123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123";

fn put(version: i64) -> PutSettings {
    PutSettings {
        version,
        enabled: true,
        offline_secs: Some(60),
        cpu_percent: Some(90),
        cpu_minutes: 5,
        mem_percent: Some(90),
        mem_minutes: 5,
        disk_percent: Some(90),
        cert_days: Some(14),
        latency_failures: true,
        last_error: true,
        cooldown_minutes: 30,
        notify_resolved: true,
        telegram_enabled: false,
        telegram_chat_id: None,
        telegram_token: None,
        webhook_enabled: false,
        webhook_url: None,
        webhook_secret: None,
        email_enabled: false,
        email_to: vec![],
    }
}

async fn save(state: &AppState, req: PutSettings) -> Result<Settings, ApiError> {
    let mut tx = state.pg().begin().await.unwrap();
    let r = apply_update_settings(&mut tx, &Actor::test(), state.totp(), &req).await;
    if r.is_ok() {
        tx.commit().await.unwrap();
    }
    r
}

async fn version(state: &AppState) -> i64 {
    let mut c = state.pg().acquire().await.unwrap();
    load(&mut c).await.unwrap().version
}

/// An enrolled node that has been offline for `secs`.
async fn offline_node(db: &TestDb, secs: i64) -> Uuid {
    let n = db.node().await;
    sqlx::query(
        "UPDATE nodes SET cert_serial = $2, status = 'offline', \
         last_seen_at = now() - make_interval(secs => $3) WHERE id = $1",
    )
    .bind(n)
    .bind(format!("4{}", &Uuid::new_v4().simple().to_string()[..15]))
    .bind(secs as f64)
    .execute(&db.pool)
    .await
    .unwrap();
    n
}

async fn set_online(db: &TestDb, n: Uuid) {
    sqlx::query("UPDATE nodes SET status = 'online', last_seen_at = now() WHERE id = $1")
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
}

async fn alerts_of(db: &TestDb, n: Uuid) -> Vec<(String, String, bool)> {
    sqlx::query_as("SELECT kind, status, notified FROM node_alerts WHERE node_id = $1 ORDER BY id")
        .bind(n)
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

async fn notifications(db: &TestDb) -> Vec<(String, String, String)> {
    sqlx::query_as("SELECT channel, event, status FROM alert_notifications ORDER BY id")
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

/// Fire → webhook (signed) → resolve → resolved notification; dedupe;
/// cooldown; muted; disabled kinds.
#[tokio::test]
async fn round_fires_notifies_and_resolves() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let (hook, base) = Mock::start(200, "ok").await;
    let mut req = put(version(&state).await);
    req.webhook_enabled = true;
    req.webhook_url = Some(format!("{base}/hook"));
    req.webhook_secret = Some(Some(SECRET.into()));
    save(&state, req).await.unwrap();

    let n = offline_node(&db, 120).await;
    let healthy = db.node().await; // pending (never enrolled): not monitored
    let s = eval::round(&state).await.unwrap().unwrap();
    assert_eq!((s.fired, s.notifications), (1, 1));
    assert_eq!(
        alerts_of(&db, n).await,
        vec![("offline".into(), "firing".into(), true)]
    );
    assert!(alerts_of(&db, healthy).await.is_empty());
    // Dedupe: another round changes nothing.
    let s = eval::round(&state).await.unwrap().unwrap();
    assert_eq!((s.fired, s.resolved, s.notifications), (0, 0, 0));
    assert_eq!(alerts_of(&db, n).await.len(), 1);

    // Delivery: signed JSON, settled sent.
    assert_eq!(channels::deliver_due(&state).await.unwrap(), 1);
    {
        let got = hook.got.lock().unwrap();
        let (path, h, body) = &got[0];
        assert_eq!(path, "/hook");
        let ts: i64 = h["x-akari-timestamp"].to_str().unwrap().parse().unwrap();
        assert!(channels::verify_signature(
            SECRET.as_bytes(),
            ts,
            body,
            h["x-akari-signature"].to_str().unwrap()
        ));
        assert_eq!(h["x-akari-event"], "firing");
        let v: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(v["alert"]["kind"], "offline");
        assert_eq!(v["alert"]["node_id"], n.to_string());
        assert!(!String::from_utf8_lossy(body).contains(SECRET));
    }
    assert_eq!(
        notifications(&db).await,
        vec![("webhook".into(), "firing".into(), "sent".into())]
    );

    // Back online: resolved + resolved notification.
    set_online(&db, n).await;
    let s = eval::round(&state).await.unwrap().unwrap();
    assert_eq!((s.resolved, s.notifications), (1, 1));
    channels::deliver_due(&state).await.unwrap();
    assert_eq!(hook.count(), 2);
    assert_eq!(hook.got.lock().unwrap()[1].1["x-akari-event"], "resolved");

    // Flap within the cooldown: recorded, not notified; nor its resolution.
    sqlx::query("UPDATE nodes SET status = 'offline', last_seen_at = now() - interval '2 minutes' WHERE id = $1")
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
    let s = eval::round(&state).await.unwrap().unwrap();
    assert_eq!((s.fired, s.notifications), (1, 0));
    set_online(&db, n).await;
    let s = eval::round(&state).await.unwrap().unwrap();
    assert_eq!((s.resolved, s.notifications), (1, 0));
    assert_eq!(
        alerts_of(&db, n).await,
        vec![
            ("offline".into(), "resolved".into(), true),
            ("offline".into(), "resolved".into(), false)
        ]
    );

    // Muted node: recorded, never notified. Disabled kind: never fires.
    let m = offline_node(&db, 600).await;
    let d = offline_node(&db, 600).await;
    for (node, rules) in [
        (
            m,
            NodeRules {
                muted: true,
                ..Default::default()
            },
        ),
        (
            d,
            NodeRules {
                disabled: vec!["offline".into()],
                ..Default::default()
            },
        ),
    ] {
        let mut tx = db.pool.begin().await.unwrap();
        apply_set_node_rules(&mut tx, &Actor::test(), node, &rules)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    let s = eval::round(&state).await.unwrap().unwrap();
    assert_eq!((s.fired, s.notifications), (1, 0));
    assert_eq!(
        alerts_of(&db, m).await,
        vec![("offline".into(), "firing".into(), false)]
    );
    assert!(alerts_of(&db, d).await.is_empty());
    // A per-node threshold above the outage: resolves silently.
    let mut tx = db.pool.begin().await.unwrap();
    apply_set_node_rules(
        &mut tx,
        &Actor::test(),
        m,
        &NodeRules {
            muted: true,
            offline_secs: Some(3600),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let s = eval::round(&state).await.unwrap().unwrap();
    assert_eq!((s.resolved, s.notifications), (1, 0));

    // Alerts off: everything firing resolves silently.
    let _ = offline_node(&db, 600).await;
    eval::round(&state).await.unwrap().unwrap();
    let mut req = put(version(&state).await);
    req.enabled = false;
    save(&state, req).await.unwrap();
    let s = eval::round(&state).await.unwrap().unwrap();
    assert_eq!((s.resolved, s.notifications, s.monitored), (1, 0, 0));
    let firing: i64 =
        sqlx::query_scalar("SELECT count(*) FROM node_alerts WHERE status = 'firing'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(firing, 0);
    drop(state);
    db.drop().await;
}

/// Two panel instances: only the lock holder evaluates; concurrent rounds
/// fire and notify exactly once.
#[tokio::test]
async fn one_leader_among_two_instances() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let a = AppState::for_test(db.pool.clone()).await;
    let b = AppState::for_test(db.pool.clone()).await;
    let (_hook, base) = Mock::start(200, "ok").await;
    let mut req = put(version(&a).await);
    req.webhook_enabled = true;
    req.webhook_url = Some(format!("{base}/hook"));
    req.webhook_secret = Some(Some(SECRET.into()));
    req.telegram_enabled = true;
    req.telegram_chat_id = Some("-100123".into());
    req.telegram_token = Some(Some(BOT.into()));
    save(&a, req).await.unwrap();
    for _ in 0..3 {
        offline_node(&db, 600).await;
    }
    // Another instance holds the round: this one skips.
    let mut holder = db.pool.begin().await.unwrap();
    let got: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('akari.alerts.' || current_schema(), 0))",
    )
    .fetch_one(&mut *holder)
    .await
    .unwrap();
    assert!(got);
    assert!(eval::round(&b).await.unwrap().is_none());
    holder.rollback().await.unwrap();
    // Both race: three alerts, two channels each, exactly once.
    for _ in 0..5 {
        let (ra, rb) = tokio::join!(eval::round(&a), eval::round(&b));
        let (ra, rb) = (ra.unwrap(), rb.unwrap());
        assert!(ra.is_some() || rb.is_some());
    }
    let alerts: i64 = sqlx::query_scalar("SELECT count(*) FROM node_alerts")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(alerts, 3);
    assert_eq!(notifications(&db).await.len(), 6);
    drop((a, b));
    db.drop().await;
}

/// Delivery: Telegram through a mock Bot API, transient failures retried
/// with backoff, permanent ones dead, concurrent deliverers never send the
/// same notification twice, dead letters can be retried.
#[tokio::test]
async fn delivery_telegram_retry_dead_exclusive() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (tg, tg_base) = Mock::start(200, r#"{"ok":true,"result":{}}"#).await;
    let state = AppState::for_test_with(db.pool.clone(), |c| {
        c.alerts.telegram_api_url = tg_base.clone();
    })
    .await;
    let other = AppState::for_test_with(db.pool.clone(), |c| {
        c.alerts.telegram_api_url = tg_base.clone();
    })
    .await;
    let mut req = put(version(&state).await);
    req.telegram_enabled = true;
    req.telegram_chat_id = Some("@akari_ops".into());
    req.telegram_token = Some(Some(BOT.into()));
    save(&state, req).await.unwrap();
    // The token is sealed: not in the row in clear.
    let raw: Vec<u8> = sqlx::query_scalar("SELECT telegram_token_enc FROM alert_settings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(!raw.windows(BOT.len()).any(|w| w == BOT.as_bytes()));

    for _ in 0..6 {
        offline_node(&db, 600).await;
    }
    eval::round(&state).await.unwrap().unwrap();
    let (x, y) = tokio::join!(channels::deliver_due(&state), channels::deliver_due(&other));
    assert_eq!(x.unwrap() + y.unwrap(), 6);
    assert_eq!(tg.count(), 6);
    {
        let got = tg.got.lock().unwrap();
        assert_eq!(got[0].0, format!("/bot{BOT}/sendMessage"));
        let v: Value = serde_json::from_slice(&got[0].2).unwrap();
        assert_eq!(v["chat_id"], "@akari_ops");
        assert!(v["text"].as_str().unwrap().starts_with("[告警] "));
    }

    // Transient: 502 -> pending, attempts 1, next attempt in ~30 s.
    sqlx::query("UPDATE nodes SET status = 'online', last_seen_at = now()")
        .execute(&db.pool)
        .await
        .unwrap();
    eval::round(&state).await.unwrap().unwrap();
    tg.set(502, r#"{"ok":false,"description":"Bad Gateway"}"#);
    assert_eq!(channels::deliver_due(&state).await.unwrap(), 0);
    let (pending, delay): (i64, f64) = sqlx::query_as(
        "SELECT count(*), min(EXTRACT(EPOCH FROM next_attempt_at - now()))::float8 \
         FROM alert_notifications WHERE status = 'pending' AND attempts = 1",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(pending, 6);
    assert!((20.0..=31.0).contains(&delay), "{delay}");
    // Not due yet: nothing claimed.
    assert_eq!(channels::deliver_due(&state).await.unwrap(), 0);
    // Permanent: 401 -> dead with the API's description.
    sqlx::query("UPDATE alert_notifications SET next_attempt_at = now()")
        .execute(&db.pool)
        .await
        .unwrap();
    tg.set(401, r#"{"ok":false,"description":"Unauthorized"}"#);
    channels::deliver_due(&state).await.unwrap();
    let dead: Vec<(String,)> =
        sqlx::query_as("SELECT last_error FROM alert_notifications WHERE status = 'dead'")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(dead.len(), 6);
    assert_eq!(dead[0].0, "telegram: HTTP 401 Unauthorized");
    assert!(!dead[0].0.contains(BOT));
    // The admin retries one dead letter; it is delivered.
    let mut admin = Client::new(&state, rand_ip());
    admin.cookie = Some(token(&state, db.admin().await).await);
    let id: i64 =
        sqlx::query_scalar("SELECT min(id) FROM alert_notifications WHERE status = 'dead'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let r = admin
        .req(
            Method::POST,
            &format!("/test/api/v1/alerts/notifications/{id}/retry"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = admin
        .req(
            Method::POST,
            &format!("/test/api/v1/alerts/notifications/{id}/retry"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    tg.set(200, r#"{"ok":true}"#);
    assert_eq!(channels::deliver_due(&state).await.unwrap(), 1);
    let list = admin.get("/test/api/v1/alerts/notifications").await.json();
    assert_eq!(list.as_array().unwrap().len(), 12);
    drop((state, other));
    db.drop().await;
}

/// Settings and the alert center over HTTP: secrets never returned or
/// audited in clear, optimistic concurrency, validation, the test button,
/// per-node rules, ack, list filters, metrics counts.
#[tokio::test]
async fn settings_and_alert_center_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let (hook, base) = Mock::start(204, "").await;
    let admin_id = db.admin().await;
    let mut c = Client::new(&state, rand_ip());
    c.cookie = Some(token(&state, admin_id).await);
    let s = c.get("/test/api/v1/alerts/settings").await;
    assert_eq!(s.status, StatusCode::OK);
    let s = s.json();
    assert_eq!(s["offline_secs"], 300);
    assert_eq!(s["email_available"], false);
    let mut body = s.clone();
    for k in [
        "telegram_token_set",
        "webhook_secret_set",
        "email_available",
        "eval_interval_secs",
    ] {
        body.as_object_mut().unwrap().remove(k);
    }
    body["webhook_enabled"] = json!(true);
    body["webhook_url"] = json!(format!("{base}/h"));
    body["webhook_secret"] = json!(SECRET);
    body["cpu_percent"] = json!(null);
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/alerts/settings",
            Some(body.clone()),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let v = r.json();
    assert_eq!(v["webhook_secret_set"], true);
    assert_eq!(v["cpu_percent"], Value::Null);
    assert!(!r.body.windows(SECRET.len()).any(|w| w == SECRET.as_bytes()));
    // Same version again: someone saved meanwhile -> 409.
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/alerts/settings",
            Some(body.clone()),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    // Keep the secret (absent), bad values refused.
    let mut keep = body.clone();
    keep["version"] = v["version"].clone();
    keep.as_object_mut().unwrap().remove("webhook_secret");
    for (k, bad) in [
        ("offline_secs", json!(5)),
        ("cooldown_minutes", json!(-1)),
        ("webhook_url", json!("http://example.com/h")),
        ("telegram_chat_id", json!("not a chat")),
        ("email_to", json!(["nope"])),
        ("zz_unknown", json!(1)),
    ] {
        let mut b = keep.clone();
        b[k] = bad;
        let r = c
            .req(Method::PUT, "/test/api/v1/alerts/settings", Some(b))
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{k}");
    }
    let mut b = keep.clone();
    b["email_enabled"] = json!(true);
    b["email_to"] = json!(["ops@example.com"]);
    let r = c
        .req(Method::PUT, "/test/api/v1/alerts/settings", Some(b))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "email needs W15");
    let mut b = keep.clone();
    b["telegram_enabled"] = json!(true);
    b["telegram_chat_id"] = json!("12345");
    let r = c
        .req(Method::PUT, "/test/api/v1/alerts/settings", Some(b))
        .await;
    assert_eq!(
        r.status,
        StatusCode::BAD_REQUEST,
        "telegram without a token"
    );
    let r = c
        .req(Method::PUT, "/test/api/v1/alerts/settings", Some(keep))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["webhook_secret_set"], true);
    // The audit log says "changed", never the secret.
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT after::text FROM audit_log WHERE action = 'alerts.settings.update' ORDER BY id",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(audit.len(), 2);
    assert!(
        audit[0].contains(r#""webhook_secret": "changed""#),
        "{}",
        audit[0]
    );
    assert!(!audit.iter().any(|a| a.contains(SECRET)));

    // The test button sends through the saved webhook now.
    let r = c
        .post("/test/api/v1/alerts/test", json!({"channel": "webhook"}))
        .await;
    assert_eq!(r.json(), json!({"ok": true}));
    assert_eq!(hook.got.lock().unwrap()[0].1["x-akari-event"], "test");
    let r = c
        .post("/test/api/v1/alerts/test", json!({"channel": "email"}))
        .await;
    assert_eq!(r.json()["ok"], false);
    let r = c
        .post("/test/api/v1/alerts/test", json!({"channel": "sms"}))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // Per-node rules.
    let n = offline_node(&db, 900).await;
    let r = c.get(&format!("/test/api/v1/nodes/{n}/alert-rules")).await;
    assert_eq!(r.json(), json!(NodeRules::default()));
    let r = c
        .req(
            Method::PUT,
            &format!("/test/api/v1/nodes/{n}/alert-rules"),
            Some(json!({"disabled": ["latency", "cpu", "cpu"], "offline_secs": 600})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["disabled"], json!(["cpu", "latency"]));
    let r = c
        .req(
            Method::PUT,
            &format!("/test/api/v1/nodes/{n}/alert-rules"),
            Some(json!({"disabled": ["nope"]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = c
        .req(
            Method::PUT,
            &format!("/test/api/v1/nodes/{}/alert-rules", Uuid::new_v4()),
            Some(json!({})),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // Alert center: list, badge, ack (once), filters.
    eval::round(&state).await.unwrap().unwrap();
    let l = c.get("/test/api/v1/alerts?status=firing").await.json();
    assert_eq!(l["firing"], 1);
    assert_eq!(l["firing_by_kind"]["offline"], 1);
    let a = &l["alerts"][0];
    assert_eq!(a["node_id"], n.to_string());
    assert_eq!(a["kind"], "offline");
    let id = a["id"].as_i64().unwrap();
    assert_eq!(
        c.get("/test/api/v1/admin-badges").await.json()["alerts_firing"],
        1
    );
    for _ in 0..2 {
        let r = c
            .req(Method::POST, &format!("/test/api/v1/alerts/{id}/ack"), None)
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
    }
    let acks: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'alerts.ack'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(acks, 1);
    let l = c.get("/test/api/v1/alerts?kind=cpu").await.json();
    assert_eq!(l["alerts"], json!([]));
    assert_eq!(
        c.get("/test/api/v1/alerts?kind=x").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        c.get(&format!("/test/api/v1/alerts?before={id}"))
            .await
            .json()["alerts"],
        json!([])
    );
    let counts = firing_counts(&db.pool).await.unwrap();
    assert_eq!(counts, vec![("offline".to_string(), 1)]);
    // Customers: none of it.
    let u = db.user().await;
    let mut cu = Client::new(&state, rand_ip());
    cu.cookie = Some(token(&state, u).await);
    for p in [
        "/test/api/v1/alerts",
        "/test/api/v1/alerts/settings",
        "/test/api/v1/admin-badges",
    ] {
        assert_eq!(cu.get(p).await.status, StatusCode::FORBIDDEN, "{p}");
    }
    drop(state);
    db.drop().await;
}
