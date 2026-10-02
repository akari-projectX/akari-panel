use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use serde_json::json;
use uuid::Uuid;

use super::*;
use crate::pb::agent_up::Msg as UpMsg;
use crate::pb::panel_down::Msg as DownMsg;
use crate::pb::{NodeMetrics, UrlLatency};
use crate::testdb::http::{rand_ip, Client};
use crate::testdb::TestDb;

#[test]
fn probe_urls() {
    for ok in [
        "https://www.gstatic.com/generate_204",
        "http://cp.cloudflare.com/generate_204",
        "https://[2001:db8::1]:8443/x?y#z",
    ] {
        assert!(valid_probe_url(ok), "{ok}");
    }
    for bad in [
        "",
        "ftp://x/",
        "https://",
        "https:///path",
        "https://user:pw@x/",
        "https://x/a b",
        "//x/",
        "https://x/\n",
    ] {
        assert!(!valid_probe_url(bad), "{bad:?}");
    }
    assert!(!valid_probe_url(&format!("https://x/{}", "a".repeat(600))));
}

#[test]
fn ranges() {
    assert_eq!(
        range_spec("1h"),
        Some(RangeSpec {
            secs: 3600,
            hourly: false,
            step_secs: 60
        })
    );
    assert!(range_spec("7d").unwrap().hourly);
    assert!(range_spec("2h").is_none());
    for r in ["1h", "6h", "24h", "48h", "7d", "30d", "90d"] {
        let s = range_spec(r).unwrap();
        assert!(s.secs / s.step_secs <= 360, "{r}: too many points");
        // Minute data only within its retention.
        assert!(s.hourly || s.secs <= MINUTE_RETENTION_HOURS * 3600, "{r}");
        assert!(s.secs <= HOUR_RETENTION_DAYS * 86_400, "{r}");
    }
}

#[test]
fn targets_use_overrides_and_flag_udp() {
    let inbounds = json!([
        {"tag": "r", "protocol": "vless", "port": 443},
        {"tag": "hy", "protocol": "hysteria", "port": 8443,
         "streamSettings": {"network": "hysteria"}},
        {"tag": "nat", "protocol": "trojan", "port": 2083},
        {"protocol": "socks", "port": 1080}
    ]);
    let ov = json!({"nat": {"host": "relay.example.com", "port": 30083}});
    let t = targets(Some("1.2.3.4"), &inbounds, &ov);
    assert_eq!(t.len(), 3, "untagged inbounds are skipped");
    assert_eq!(
        t[0],
        Target {
            tag: "r".into(),
            host: Some("1.2.3.4".into()),
            port: Some(443),
            udp_only: false
        }
    );
    assert!(t[1].udp_only, "Hysteria 2 is UDP only: {:?}", t[1]);
    assert_eq!(t[2].host.as_deref(), Some("relay.example.com"));
    assert_eq!(t[2].port, Some(30083));
    assert!(targets(None, &inbounds, &json!({}))[0].host.is_none());
}

#[test]
fn heartbeat_sanitized() {
    let hb = Heartbeat {
        cpu_percent: Some(f64::NAN),
        mem_used_bytes: Some(u64::MAX),
        connections: 3,
        metrics: Some(NodeMetrics {
            load1: Some(-1.0),
            online_users: 2,
            net_rx_bytes_per_sec: Some(10),
            net_interface: "eth0\u{7}\u{0}".into(),
            ..Default::default()
        }),
        ..Default::default()
    };
    let s = Sample::from_heartbeat(&hb);
    assert_eq!(s.cpu, None, "NaN is no reading");
    assert_eq!(s.load1, Some(0.0));
    assert_eq!(s.mem_used, Some(i64::MAX));
    assert_eq!((s.conns, s.users, s.rx_bps), (3, 2, Some(10)));
    assert_eq!((s.tcp, s.disk_total), (None, None), "unset = unknown");
    let blob = heartbeat_blob(&hb);
    assert_eq!(blob["metrics"]["net_interface"], "eth0");
    assert_eq!(blob["cpu_percent"], Value::Null);
    assert_eq!(blob["metrics"]["load1"], 0.0);
    assert_eq!(blob["metrics"]["tcp_sockets"], Value::Null);
    assert_eq!(blob["metrics"]["net_rx_bytes_per_sec"], 10);
    // An old agent: no metrics object.
    assert!(heartbeat_blob(&Heartbeat::default())
        .get("metrics")
        .is_none());
}

/// W23: agents without "metrics-presence" send unread values as 0 and
/// every 0 unset: for them unset is 0 (a zero memory total = unknown, as in
/// W11). Agents with it keep unset = unknown.
#[test]
fn legacy_presence_means_zero() {
    let mut hb = Heartbeat {
        mem_total_bytes: Some(4096),
        metrics: Some(NodeMetrics {
            load5: Some(0.5),
            ..Default::default()
        }),
        ..Default::default()
    };
    legacy_presence(&mut hb);
    let m = hb.metrics.as_ref().unwrap();
    assert_eq!(
        (hb.cpu_percent, hb.mem_used_bytes, hb.mem_total_bytes),
        (Some(0.0), Some(0), Some(4096))
    );
    assert_eq!(
        (m.load1, m.load5, m.tcp_sockets),
        (Some(0.0), Some(0.5), Some(0))
    );
    assert_eq!(
        (m.disk_total_bytes, m.process_rss_bytes),
        (Some(0), Some(0))
    );
    let s = Sample::from_heartbeat(&hb);
    assert_eq!((s.cpu, s.rx_bps), (Some(0.0), Some(0)));

    let mut old = Heartbeat::default();
    legacy_presence(&mut old);
    assert_eq!(
        (old.mem_used_bytes, old.mem_total_bytes),
        (None, None),
        "total 0 = unknown"
    );
    assert!(old.metrics.is_none());
}

#[test]
fn local_throttles_writes_and_sums_the_fleet() {
    let l = Local::default();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    let t0 = Instant::now();
    let s = |users, cpu| Sample {
        users,
        cpu: Some(cpu),
        conns: 5,
        rx_bps: Some(100),
        ..Default::default()
    };
    assert!(l.observe(a, s(2, 10.0), t0));
    assert!(
        !l.observe(a, s(3, 20.0), t0 + Duration::from_secs(2)),
        "throttled"
    );
    assert!(l.observe(a, s(3, 20.0), t0 + MIN_SAMPLE_GAP), "due again");
    assert!(l.observe(b, s(4, 50.0), t0));
    let f = l.fleet();
    assert_eq!(
        (f.nodes, f.online_users, f.connections, f.rx_bps),
        (2, 7, 10, 200)
    );
    assert_eq!(f.cpu_max, 50.0);
    l.forget(b);
    assert_eq!(l.fleet().nodes, 1);
}

#[test]
fn probe_config_token() {
    let cfg = crate::config::ProbeConfig::default();
    let c = probe_config(&cfg, None);
    assert_eq!(c.interval_seconds, 18_000);
    assert_eq!(c.run_token, 0);
    assert_eq!(c.urls[0], "https://www.gstatic.com/generate_204");
    let t = Utc::now();
    assert_eq!(
        probe_config(&cfg, Some(t)).run_token,
        t.timestamp_micros() as u64
    );
}

async fn admin_client(state: &AppState, db: &TestDb) -> (Client, Uuid) {
    let admin = db.admin().await;
    let (role, sv): (String, i64) =
        sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
            .bind(admin)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let mut c = Client::new(state, rand_ip());
    c.cookie =
        Some(crate::auth::issue_token(state, admin, &role, sv, crate::auth::Stage::Full).unwrap());
    (c, admin)
}

async fn user_client(state: &AppState, user: Uuid) -> Client {
    let mut c = Client::new(state, rand_ip());
    c.cookie =
        Some(crate::auth::issue_token(state, user, "user", 0, crate::auth::Stage::Full).unwrap());
    c
}

/// W23: unknown values are stored as NULL and stay unknown: a minute with
/// an unknown sample has no average for that metric (its maximum keeps the
/// known values); averages only count minutes that have the value, in the
/// minute view and after the hour rollup alike.
#[tokio::test]
async fn history_unknown_values() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let n = db.node().await;
    let known = Sample {
        cpu: Some(40.0),
        load1: Some(1.0),
        users: 1,
        ..Default::default()
    };
    write_sample(&db.pool, n, &known).await.unwrap();
    let unknown = Sample {
        load1: Some(3.0),
        users: 1,
        ..Default::default()
    };
    write_sample(&db.pool, n, &unknown).await.unwrap();
    let pts = history(&db.pool, n, &range_spec("1h").unwrap())
        .await
        .unwrap();
    let p = &pts[0];
    assert_eq!((p.samples, p.cpu, p.cpu_max), (2, None, Some(40.0)));
    assert_eq!((p.load1, p.mem_used, p.mem_total), (Some(2.0), None, None));

    // Hour rollup over a known and an unknown minute: the average is that
    // of the known minute.
    sqlx::query("DELETE FROM node_metrics_1m WHERE node_id = $1")
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO node_metrics_1m (node_id, bucket, samples, cpu_sum, mem_used_sum, mem_total) \
         VALUES ($1, date_trunc('hour', now()), 2, 20, NULL, NULL), \
                ($1, date_trunc('hour', now()) + interval '1 minute', 3, NULL, 300, 1000)",
    )
    .bind(n)
    .execute(&db.pool)
    .await
    .unwrap();
    rollup_and_prune(&db.pool).await.unwrap();
    let pts = history(&db.pool, n, &range_spec("7d").unwrap())
        .await
        .unwrap();
    assert_eq!(pts.len(), 1);
    let p = &pts[0];
    assert_eq!(p.samples, 5);
    assert!((p.cpu.unwrap() - 10.0).abs() < 1e-9, "{:?}", p.cpu);
    assert!(
        (p.mem_used.unwrap() - 100.0).abs() < 1e-9,
        "{:?}",
        p.mem_used
    );
    assert_eq!((p.mem_total, p.swap_used, p.tcp), (Some(1000), None, None));
    db.drop().await;
}

/// History: samples of one minute merge exactly (sums), the API averages
/// them; the rollup builds hour rows and retention drops expired rows.
#[tokio::test]
async fn history_merge_rollup_and_retention() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let n = db.node().await;
    let s = |cpu, users| Sample {
        cpu: Some(cpu),
        mem_used: Some(1000),
        mem_total: Some(4000),
        rx_bps: Some(100),
        users,
        conns: users * 2,
        ..Default::default()
    };
    write_sample(&db.pool, n, &s(10.0, 4)).await.unwrap();
    write_sample(&db.pool, n, &s(30.0, 8)).await.unwrap();
    let pts = history(&db.pool, n, &range_spec("1h").unwrap())
        .await
        .unwrap();
    assert_eq!(pts.len(), 1);
    let p = &pts[0];
    assert_eq!(p.samples, 2);
    assert!((p.cpu.unwrap() - 20.0).abs() < 1e-9 && (p.cpu_max.unwrap() - 30.0).abs() < 1e-6);
    assert_eq!((p.users, p.users_max, p.conns_max), (6.0, 8, 16));
    assert_eq!(
        (p.mem_used, p.mem_total, p.rx_bps),
        (Some(1000.0), Some(4000), Some(100.0))
    );
    assert_eq!((p.tcp, p.disk_total), (None, None), "never reported");

    // Expired rows on both resolutions, and an old-but-kept hour.
    sqlx::query(
        "INSERT INTO node_metrics_1m (node_id, bucket, samples, cpu_sum) VALUES \
         ($1, date_trunc('minute', now()) - interval '49 hours', 1, 5), \
         ($1, date_trunc('minute', now()) - interval '47 hours', 1, 5)",
    )
    .bind(n)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO node_metrics_1h (node_id, bucket, samples, cpu_sum) VALUES \
         ($1, date_trunc('hour', now()) - interval '91 days', 1, 5), \
         ($1, date_trunc('hour', now()) - interval '30 days', 1, 5)",
    )
    .bind(n)
    .execute(&db.pool)
    .await
    .unwrap();
    let r = rollup_and_prune(&db.pool)
        .await
        .unwrap()
        .expect("lock taken");
    assert_eq!((r.minutes_pruned, r.hours_pruned), (1, 1));
    assert!(r.hours_written >= 1);
    // The current hour mirrors its minutes; rerunning is idempotent.
    let hour: (i32, f64) = sqlx::query_as(
        "SELECT samples, cpu_sum FROM node_metrics_1h WHERE node_id = $1 \
         AND bucket = date_trunc('hour', now())",
    )
    .bind(n)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(hour, (2, 40.0));
    rollup_and_prune(&db.pool).await.unwrap();
    let again: (i32, f64) = sqlx::query_as(
        "SELECT samples, cpu_sum FROM node_metrics_1h WHERE node_id = $1 \
         AND bucket = date_trunc('hour', now())",
    )
    .bind(n)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(again, hour);
    let pts = history(&db.pool, n, &range_spec("90d").unwrap())
        .await
        .unwrap();
    assert_eq!(pts.len(), 2, "30-day-old hour + this hour");
    // Deleting the node removes its history.
    sqlx::query("DELETE FROM nodes WHERE id = $1")
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM node_metrics_1m) + (SELECT count(*) FROM node_metrics_1h)",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(left, 0);
    db.drop().await;
}

/// Agent results replace the set, an older re-sent report never overwrites
/// a newer one, input is bounded.
#[tokio::test]
async fn agent_latency_store() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let n = db.node().await;
    let now = Utc::now().timestamp();
    let rep = |at: i64, results: Vec<UrlLatency>| LatencyReport {
        results,
        measured_at_unix: at,
        run_token: 0,
    };
    let ok = |u: &str, ms| UrlLatency {
        url: u.into(),
        ok: true,
        delay_ms: ms,
        ..Default::default()
    };
    let bad = |u: &str| UrlLatency {
        url: u.into(),
        ok: false,
        error: "timeout".into(),
        ..Default::default()
    };
    store_agent_latency(
        &db.pool,
        n,
        &rep(now - 10, vec![bad("https://a/"), ok("https://b/", 120)]),
    )
    .await
    .unwrap();
    let rows = |db: &TestDb| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_as::<_, (String, Option<i32>, Option<String>)>(
                "SELECT target, delay_ms, error FROM node_latency WHERE node_id = $1 ORDER BY ord",
            )
            .bind(n)
            .fetch_all(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(
        rows(&db).await,
        vec![
            ("https://a/".into(), None, Some("timeout".into())),
            ("https://b/".into(), Some(120), None)
        ]
    );
    // Older: ignored.
    store_agent_latency(&db.pool, n, &rep(now - 100, vec![ok("https://old/", 1)]))
        .await
        .unwrap();
    assert_eq!(rows(&db).await.len(), 2);
    // Newer: replaces; > 4 results and a future timestamp are bounded.
    let many: Vec<UrlLatency> = (0..9).map(|i| ok(&format!("https://h{i}/"), 10)).collect();
    store_agent_latency(&db.pool, n, &rep(now + 86_400, many))
        .await
        .unwrap();
    let r = rows(&db).await;
    assert_eq!(r.len(), 4);
    assert_eq!(r[0].0, "https://h0/");
    let future: bool = sqlx::query_scalar(
        "SELECT bool_or(measured_at > now() + interval '1 minute') FROM node_latency WHERE node_id = $1",
    )
    .bind(n)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(!future, "agent clock clamped to now");
    // URLs with control characters are dropped, the rest kept.
    store_agent_latency(
        &db.pool,
        n,
        &rep(
            now + 86_400,
            vec![ok("https://x/\n\u{1b}[31m", 1), ok("https://y/", 2)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(rows(&db).await, vec![("https://y/".into(), Some(2), None)]);
    // A deleted node: storing is a no-op, not an error.
    sqlx::query("DELETE FROM nodes WHERE id = $1")
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
    store_agent_latency(&db.pool, n, &rep(now, vec![ok("https://a/", 5)]))
        .await
        .unwrap();
    db.drop().await;
}

/// The panel's TCP test: a listening inbound gets a delay, a closed port
/// an error, a Hysteria 2 inbound "udp"; claiming is exclusive (a second
/// round finds nothing due).
#[tokio::test]
async fn panel_tcp_probe_round() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let open = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let open_port = open.local_addr().unwrap().port();
    let closed_port = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };
    tokio::spawn(async move {
        loop {
            let _ = open.accept().await;
        }
    });
    let n = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO nodes (id, name, server_addr, xray_inbounds, connect_overrides) VALUES ($1, 'p', '127.0.0.1', $2, $3)",
    )
    .bind(n)
    .bind(json!([
        {"tag": "a", "protocol": "vless", "port": 1},
        {"tag": "b", "protocol": "vless", "port": closed_port},
        {"tag": "hy", "protocol": "hysteria", "port": 443, "streamSettings": {"network": "hysteria"}}
    ]))
    .bind(json!({"a": {"port": open_port}}))
    .execute(&db.pool)
    .await
    .unwrap();
    // Other nodes in this schema-less database are other tests': count ours.
    panel_probe_round(&db.pool, 3600, 2, Duration::from_secs(2))
        .await
        .unwrap();
    let rows: Vec<(String, Option<i32>, Option<String>)> = sqlx::query_as(
        "SELECT target, delay_ms, error FROM node_latency WHERE node_id = $1 AND source = 'panel' ORDER BY ord",
    )
    .bind(n)
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert_eq!(rows[0].0, "a");
    assert!(rows[0].1.is_some(), "{rows:?}");
    assert_eq!(rows[1].2.as_deref(), Some("refused"));
    assert_eq!(rows[2].2.as_deref(), Some("udp"));
    let next: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT panel_probe_next_at FROM nodes WHERE id = $1")
            .bind(n)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let left = next.unwrap() - Utc::now();
    assert!(left > chrono::Duration::seconds(3000) && left < chrono::Duration::seconds(4000));
    assert_eq!(
        panel_probe_round(&db.pool, 3600, 2, Duration::from_secs(2))
            .await
            .unwrap(),
        0
    );
    db.drop().await;
}

/// Admin endpoints (status, metrics, probe with cooldown + audit + notify)
/// and the user's /me/nodes visibility rules.
#[tokio::test]
async fn api_status_metrics_probe_and_portal_visibility() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let (admin, _) = admin_client(&state, &db).await;
    let (shown, u) = db.member().await;
    let hidden = db.node().await;
    let disabled = db.node().await;
    let unassigned = db.node().await;
    db.assign(hidden, u).await;
    db.assign(disabled, u).await;
    sqlx::query(
        "UPDATE nodes SET display_name = '香港 01', tags = '{IPLC,0.5x}', traffic_rate_permille = 500, \
         status = 'online', last_seen_at = now(), sort = 2 WHERE id = $1",
    )
    .bind(shown)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE nodes SET visible = false WHERE id = $1")
        .bind(hidden)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE nodes SET enabled = false WHERE id = $1")
        .bind(disabled)
        .execute(&db.pool)
        .await
        .unwrap();
    store_agent_latency(
        &db.pool,
        shown,
        &LatencyReport {
            results: vec![
                UrlLatency {
                    url: "https://a/".into(),
                    ok: false,
                    error: "timeout".into(),
                    ..Default::default()
                },
                UrlLatency {
                    url: "https://b/".into(),
                    ok: true,
                    delay_ms: 88,
                    ..Default::default()
                },
            ],
            measured_at_unix: Utc::now().timestamp(),
            run_token: 0,
        },
    )
    .await
    .unwrap();
    write_sample(
        &db.pool,
        shown,
        &Sample {
            cpu: Some(12.0),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // Portal.
    let me = user_client(&state, u).await;
    let r = me.get("/test/api/v1/me/nodes").await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    let list = v.as_array().unwrap();
    assert_eq!(
        list.len(),
        1,
        "hidden, disabled and unassigned nodes are not listed: {v}"
    );
    let n = &list[0];
    assert_eq!(n["name"], "香港 01");
    assert_eq!(n["tags"], json!(["IPLC", "0.5x"]));
    assert_eq!(n["rate"], 0.5);
    assert_eq!(n["online"], true);
    assert_eq!(n["latency_ms"], 88);
    assert_eq!(n["latency_status"], "ok");
    for leak in [
        "id",
        "server_addr",
        "xray_inbounds",
        "heartbeat",
        "cpu_percent",
    ] {
        assert!(n.get(leak).is_none(), "{leak} leaked to users");
    }
    let _ = unassigned;
    // Users cannot use the admin endpoints.
    for path in [
        format!("/test/api/v1/nodes/{shown}/status"),
        format!("/test/api/v1/nodes/{shown}/metrics"),
    ] {
        assert_eq!(me.get(&path).await.status, StatusCode::FORBIDDEN, "{path}");
    }
    assert_eq!(
        me.post(&format!("/test/api/v1/nodes/{shown}/probe"), json!({}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );

    // Admin: status + metrics.
    let r = admin
        .get(&format!("/test/api/v1/nodes/{shown}/status"))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["online"], true);
    assert_eq!(v["traffic_rate"], 0.5);
    assert_eq!(v["latency"].as_array().unwrap().len(), 2);
    let r = admin
        .get(&format!("/test/api/v1/nodes/{shown}/metrics?range=1h"))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["points"][0]["cpu"], 12.0);
    assert_eq!(
        admin
            .get(&format!("/test/api/v1/nodes/{shown}/metrics?range=1y"))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        admin
            .get(&format!("/test/api/v1/nodes/{}/status", Uuid::new_v4()))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // The node list carries the W11 columns.
    let r = admin.get("/test/api/v1/nodes").await;
    let nodes = r.json();
    let row = nodes
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == shown.to_string())
        .unwrap();
    assert_eq!(row["display_name"], "香港 01");
    assert_eq!(row["traffic_rate"], 0.5);
    assert_eq!(row["online"], true);
    assert_eq!(row["latency"].as_array().unwrap().len(), 2);

    // 立即测速: notify + audit, then the cooldown.
    let mut listener = db.listener().await;
    crate::testdb::drain(&mut listener, Duration::from_millis(20)).await;
    let audits = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit_log WHERE action = 'node.probe'")
            .fetch_one(&db.pool)
            .await
            .unwrap()
    };
    let r = admin
        .post(&format!("/test/api/v1/nodes/{shown}/probe"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::ACCEPTED);
    let got = crate::testdb::drain(&mut listener, Duration::from_millis(200)).await;
    assert!(got.contains(&shown.to_string()), "session woken: {got:?}");
    assert_eq!(audits().await, 1);
    let r = admin
        .post(&format!("/test/api/v1/nodes/{shown}/probe"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(audits().await, 1);
    assert_eq!(
        admin
            .req(
                Method::POST,
                &format!("/test/api/v1/nodes/{}/probe", Uuid::new_v4()),
                None
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    drop(listener);
    db.drop().await;
}

/// End to end over the real gRPC server: a capable agent gets the probe
/// config (and a fresh token after "立即测速"); its LatencyReport is
/// stored; its heartbeat metrics reach Valkey and the history.
#[tokio::test]
async fn session_probe_config_report_and_heartbeat() {
    use crate::testdb::fake_agent::PanelHarness;
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (n, _u) = db.member().await;
    let panel = PanelHarness::start(&db).await;
    let creds = panel.register(&db, n).await;
    let mut agent = panel.connect(&creds).await.unwrap();
    agent
        .hello_caps((0, 0), String::new(), &["metrics", "latency"])
        .await;
    let mut got_config = None;
    let mut snap = None;
    while got_config.is_none() || snap.is_none() {
        match agent.next().await {
            Some(Ok(DownMsg::Snapshot(s))) => snap = Some(s),
            Some(Ok(DownMsg::LatencyProbe(c))) => got_config = Some(c),
            Some(Ok(_)) => {}
            other => panic!("{other:?}"),
        }
    }
    let cfg = got_config.unwrap();
    assert_eq!(cfg.interval_seconds, 18_000);
    assert_eq!(cfg.run_token, 0);
    agent.ack_snapshot(&snap.unwrap()).await;

    // 立即测速 -> a new token reaches the agent.
    let mut tx = db.pool.begin().await.unwrap();
    let at = apply_request_probe(&mut tx, &Actor::test(), n, 30)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    // The harness runs no LISTEN task: deliver the notify by hand (the
    // api test above asserts the pg_notify itself).
    panel.state.wakeups().wake(n);
    loop {
        match agent.next().await {
            Some(Ok(DownMsg::LatencyProbe(c))) => {
                assert_eq!(c.run_token, at.timestamp_micros() as u64);
                break;
            }
            Some(Ok(_)) => {}
            other => panic!("{other:?}"),
        }
    }

    agent
        .send_up(UpMsg::Latency(LatencyReport {
            results: vec![UrlLatency {
                url: "https://www.gstatic.com/generate_204".into(),
                ok: true,
                delay_ms: 42,
                attempts_ms: vec![40, 42, 50],
                error: String::new(),
            }],
            measured_at_unix: Utc::now().timestamp(),
            run_token: at.timestamp_micros() as u64,
        }))
        .await;
    agent
        .send_up(UpMsg::Heartbeat(Heartbeat {
            cpu_percent: Some(33.0),
            connections: 4,
            metrics: Some(NodeMetrics {
                online_users: 2,
                net_interface: "eth0".into(),
                ..Default::default()
            }),
            ..Default::default()
        }))
        .await;
    let mut ok = false;
    for _ in 0..100 {
        let lat: Option<i32> = sqlx::query_scalar(
            "SELECT delay_ms FROM node_latency WHERE node_id = $1 AND source = 'agent'",
        )
        .bind(n)
        .fetch_optional(&db.pool)
        .await
        .unwrap()
        .flatten();
        let samples: Option<i32> =
            sqlx::query_scalar("SELECT samples FROM node_metrics_1m WHERE node_id = $1")
                .bind(n)
                .fetch_optional(&db.pool)
                .await
                .unwrap();
        if lat == Some(42) && samples == Some(1) {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ok, "latency result and metrics sample stored");
    let hb = heartbeat(&panel.state, n)
        .await
        .expect("heartbeat blob in valkey");
    assert_eq!(hb["metrics"]["online_users"], 2);
    // W23: no "metrics-presence": unset values are 0, as before.
    assert_eq!(hb["cpu_percent"], 33.0);
    assert_eq!(hb["metrics"]["tcp_sockets"], 0);
    assert_eq!(panel.state.nodestat().fleet().online_users, 2);
    panel.stop().await;
    db.drop().await;
}

/// W23 over the real gRPC server: an agent with "metrics-presence" leaves
/// what it could not read unset, and the node page gets null (shown as
/// "—"), not 0; the history stores NULL.
#[tokio::test]
async fn session_heartbeat_unknown_values() {
    use crate::testdb::fake_agent::PanelHarness;
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (n, _u) = db.member().await;
    let panel = PanelHarness::start(&db).await;
    let creds = panel.register(&db, n).await;
    let mut agent = panel.connect(&creds).await.unwrap();
    agent
        .hello_caps((0, 0), String::new(), &["metrics", "metrics-presence"])
        .await;
    loop {
        match agent.next().await {
            Some(Ok(DownMsg::Snapshot(_))) => break,
            Some(Ok(_)) => {}
            other => panic!("{other:?}"),
        }
    }
    agent
        .send_up(UpMsg::Heartbeat(Heartbeat {
            connections: 1,
            metrics: Some(NodeMetrics {
                disk_used_bytes: Some(10),
                disk_total_bytes: Some(100),
                tcp_sockets: Some(0),
                online_users: 1,
                ..Default::default()
            }),
            ..Default::default()
        }))
        .await;
    let mut blob = None;
    for _ in 0..100 {
        let have: Option<Option<f64>> =
            sqlx::query_scalar("SELECT cpu_sum FROM node_metrics_1m WHERE node_id = $1")
                .bind(n)
                .fetch_optional(&db.pool)
                .await
                .unwrap();
        if let (Some(cpu), Some(hb)) = (have, heartbeat(&panel.state, n).await) {
            assert_eq!(cpu, None, "unknown CPU stored as NULL");
            blob = Some(hb);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let hb = blob.expect("heartbeat stored");
    assert_eq!(hb["cpu_percent"], Value::Null);
    assert_eq!(hb["mem_total_bytes"], Value::Null);
    assert_eq!(hb["metrics"]["load1"], Value::Null);
    assert_eq!(hb["metrics"]["tcp_sockets"], 0, "a read 0 stays 0");
    assert_eq!(hb["metrics"]["disk_total_bytes"], 100);
    panel.stop().await;
    db.drop().await;
}
