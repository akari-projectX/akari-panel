//! W31 系统状态: parsers, job aggregation, the endpoint (real PG + Valkey).

use std::collections::HashMap;
use std::time::Instant;

use axum::http::StatusCode;
use chrono::{Duration as ChronoDuration, Utc};
use uuid::Uuid;

use super::host::*;
use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, rand_ip};

#[test]
fn proc_parsers() {
    let stat = "cpu  100 5 50 800 20 0 5 0 0 0\ncpu0 1 2 3 4\n";
    assert_eq!(parse_cpu(stat), Some((980, 820)));
    assert_eq!(parse_cpu("cpu0 1 2 3 4\n"), None);
    assert_eq!(parse_cpu("cpu  1 x 3 4\n"), None);
    assert_eq!(cpu_percent((980, 820), (1980, 1320)), Some(50.0));
    assert_eq!(cpu_percent((980, 820), (980, 820)), None, "no time passed");
    assert_eq!(cpu_percent((980, 820), (900, 800)), None, "counter reset");
    let mem = "MemTotal:       16000 kB\nMemFree: 1 kB\nMemAvailable:    4000 kB\n";
    assert_eq!(parse_meminfo(mem), Some((16000 * 1024, 4000 * 1024)));
    assert_eq!(parse_meminfo("MemTotal: 10 kB\n"), None);
    assert_eq!(
        parse_meminfo("MemTotal: 10 kB\nMemAvailable: 20 kB\n"),
        None,
        "available > total"
    );
    assert_eq!(
        parse_loadavg("0.50 1.25 2.00 3/400 1234\n"),
        Some([0.5, 1.25, 2.0])
    );
    assert_eq!(parse_loadavg("nan 1 2"), None);
    assert_eq!(parse_loadavg("-1 1 2"), None);
    assert_eq!(parse_loadavg("1 2"), None);
    assert_eq!(
        parse_rss("Name:\takari\nVmRSS:\t   2048 kB\n"),
        Some(2048 * 1024)
    );
    assert_eq!(parse_rss("VmRSS: lots"), None);
}

#[test]
fn sampler_reads_this_host() {
    let s = Sampler::default();
    let first = s.sample(&std::env::temp_dir());
    let second = s.sample(&std::env::temp_dir());
    if cfg!(target_os = "linux") {
        assert!(first.cpu_percent.is_none(), "first reading has no delta");
        assert!(second.mem_total_bytes.is_some_and(|t| t > 0));
        assert!(second.mem_used_bytes <= second.mem_total_bytes);
        assert!(second.disk_total_bytes.is_some_and(|t| t > 0));
        assert!(second.rss_bytes.is_some_and(|r| r > 0));
        assert!(second.load.is_some());
    }
    assert!(second.cores.is_some_and(|c| c > 0));
}

#[test]
fn valkey_info_is_parsed() {
    let info = "# Server\r\nredis_version:7.2.4\r\nvalkey_version:9.0.1\r\nuptime_in_seconds:42\r\n\
                # Clients\r\nconnected_clients:7\r\n# Memory\r\nused_memory:1048576\r\nmaxmemory:0\r\n";
    let v = info_view(info);
    assert_eq!(v.version.as_deref(), Some("9.0.1"), "valkey version wins");
    assert_eq!(v.used_memory_bytes, Some(1_048_576));
    assert_eq!(v.max_memory_bytes, None, "0 = no limit");
    assert_eq!(v.connected_clients, Some(7));
    assert_eq!(v.uptime_secs, Some(42));
    assert_eq!(
        info_view("redis_version:7.0.0\n").version.as_deref(),
        Some("7.0.0")
    );
}

fn beat_with(id: Uuid, age_secs: i64, jobs: HashMap<Job, JobStat>) -> Beat {
    let now = Utc::now();
    Beat {
        id,
        version: "0".into(),
        git_sha: "x".into(),
        started_at: now - ChronoDuration::hours(1),
        beat_at: now - ChronoDuration::seconds(age_secs),
        host: Host::default(),
        agent_sessions: 0,
        db_pool_size: 0,
        db_pool_idle: 0,
        jobs,
    }
}

#[test]
fn job_aggregation_across_instances() {
    let now = Utc::now();
    let ok = |secs: i64| JobStat {
        runs: 10,
        last_run_at: Some(now - ChronoDuration::seconds(secs)),
        last_ok_at: Some(now - ChronoDuration::seconds(secs)),
        last_outcome: Some(Outcome::Ok),
        ..Default::default()
    };
    let failing = JobStat {
        runs: 3,
        failures: 3,
        last_run_at: Some(now - ChronoDuration::seconds(1)),
        last_outcome: Some(Outcome::Error),
        last_error_at: Some(now - ChronoDuration::seconds(1)),
        last_error: Some("db down".into()),
        ..Default::default()
    };
    let (a, b, dead) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let beats = vec![
        beat_with(a, 2, HashMap::from([(Job::Settlement, ok(4))])),
        beat_with(b, 3, HashMap::from([(Job::Settlement, failing.clone())])),
        // An offline instance's stats do not count.
        beat_with(dead, 600, HashMap::from([(Job::Settlement, ok(0))])),
    ];
    let v = job_view(Job::Settlement, &beats, now, serde_json::Value::Null);
    assert_eq!(v.lag_secs, Some(4));
    assert!(!v.stale);
    assert_eq!(v.last_error.as_deref(), Some("db down"));
    assert_eq!(v.instances.len(), 2);
    // Every live instance failing for long: stale.
    let beats = vec![beat_with(b, 3, HashMap::from([(Job::Settlement, failing)]))];
    let v = job_view(Job::Settlement, &beats, now, serde_json::Value::Null);
    assert_eq!(v.lag_secs, None);
    assert!(v.stale);
    let beats = vec![beat_with(a, 2, HashMap::from([(Job::Alerts, ok(170))]))];
    assert!(!job_view(Job::Alerts, &beats, now, serde_json::Value::Null).stale);
    let beats = vec![beat_with(a, 2, HashMap::from([(Job::Alerts, ok(190))]))];
    assert!(job_view(Job::Alerts, &beats, now, serde_json::Value::Null).stale);
    // No live instance at all: nothing to judge.
    assert!(!job_view(Job::Mail, &[], now, serde_json::Value::Null).stale);
}

#[test]
fn record_keeps_counts_and_redacts_errors() {
    let l = Local::default();
    let t = Instant::now();
    l.record(Job::Mail, t, Outcome::Skipped, None);
    l.record_result::<(), _>(
        Job::Mail,
        t,
        &Err("550 <bob@example.org>: no such user\nmore"),
    );
    l.record_result::<_, String>(Job::Mail, t, &Ok(()));
    let s = &l.jobs()[&Job::Mail];
    assert_eq!((s.runs, s.failures), (3, 1));
    assert_eq!(s.last_outcome, Some(Outcome::Ok));
    assert!(s.last_ok_at.is_some() && s.last_error_at.is_some());
    assert_eq!(
        s.last_error.as_deref(),
        Some("550 <address>: no such user more")
    );
}

async fn admin(state: &AppState, db: &TestDb) -> Client {
    let id = db.admin().await;
    let mut c = Client::new(state, rand_ip());
    c.cookie = Some(crate::auth::issue_token(state, id, "admin", 0).unwrap());
    c
}

#[tokio::test]
async fn status_endpoint_reports_the_fleet() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    // Another (fake) instance, alive, and one long gone.
    let other = beat_with(
        Uuid::new_v4(),
        1,
        HashMap::from([(
            Job::Alerts,
            JobStat {
                runs: 1,
                last_run_at: Some(Utc::now()),
                last_ok_at: Some(Utc::now()),
                last_outcome: Some(Outcome::Ok),
                ..Default::default()
            },
        )]),
    );
    let gone = beat_with(Uuid::new_v4(), FORGET_AFTER + 60, HashMap::new());
    for b in [&other, &gone] {
        let () = state
            .valkey()
            .hset(
                INSTANCES_KEY,
                (b.id.to_string(), serde_json::to_string(b).unwrap()),
            )
            .await
            .unwrap();
    }
    state
        .sysstatus()
        .record(Job::Settlement, Instant::now(), Outcome::Ok, None);
    sqlx::query(
        "INSERT INTO mail_outbox (kind, to_addr, subject, body_text, body_html, next_attempt_at) \
         VALUES ('test', 'a@example.com', 's', 't', 'h', now() - interval '90 seconds')",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let c = admin(&state, &db).await;
    let r = c.get("/test/api/v1/system/status").await;
    assert_eq!(r.status, StatusCode::OK);
    let j = r.json();
    assert_eq!(j["postgres"]["ok"], true, "{j}");
    assert!(j["postgres"]["version"].as_str().unwrap().starts_with("18"));
    assert!(j["postgres"]["max_connections"].as_i64().unwrap() > 0);
    assert_eq!(j["valkey"]["ok"], true, "{j}");
    assert!(j["valkey"]["version"].is_string());
    // No main domain in tests: the proxy is "not configured", not "down".
    assert_eq!(j["caddy"]["configured"], false);
    let me = state.sysstatus().id.to_string();
    let inst = j["instances"].as_array().unwrap();
    let mine = inst.iter().find(|i| i["id"] == me.as_str()).unwrap();
    assert_eq!(mine["this"], true);
    assert_eq!(mine["alive"], true);
    assert!(
        inst.iter()
            .any(|i| i["id"] == other.id.to_string().as_str() && i["this"] == false)
    );
    assert!(
        !inst.iter().any(|i| i["id"] == gone.id.to_string().as_str()),
        "forgotten"
    );
    let remaining: HashMap<String, String> = state.valkey().hgetall(INSTANCES_KEY).await.unwrap();
    assert!(!remaining.contains_key(&gone.id.to_string()));
    let jobs = j["jobs"].as_array().unwrap();
    assert_eq!(
        jobs.iter()
            .map(|x| x["job"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["settlement", "reconciliation", "mail", "alerts"]
    );
    let settle = &jobs[0];
    assert_eq!(settle["lag_secs"], 0);
    assert_eq!(settle["stale"], false);
    let mail = &jobs[2];
    assert!(mail["backlog"]["due"].as_i64().unwrap() >= 1);
    assert!(mail["backlog"]["oldest_due_secs"].as_i64().unwrap() >= 89);
    assert!(
        jobs[3]["instances"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["instance"] == other.id.to_string().as_str())
    );
    // Cached briefly: the same answer within CACHE_FOR.
    let again = c.get("/test/api/v1/system/status").await.json();
    assert_eq!(again["generated_at"], j["generated_at"]);
    // Admins only.
    let user = db.user().await;
    let mut u = Client::new(&state, rand_ip());
    u.cookie = Some(crate::auth::issue_token(&state, user, "user", 0).unwrap());
    assert_eq!(
        u.get("/test/api/v1/system/status").await.status,
        StatusCode::FORBIDDEN
    );
    let anon = Client::new(&state, rand_ip());
    assert_eq!(
        anon.get("/test/api/v1/system/status").await.status,
        StatusCode::UNAUTHORIZED
    );
    let () = state
        .valkey()
        .hdel(INSTANCES_KEY, vec![other.id.to_string(), me])
        .await
        .unwrap();
    db.drop().await;
}

/// The heartbeat publishes this instance (host metrics, job stats) with
/// the hash's day-long expiry.
#[tokio::test]
async fn heartbeat_publishes_this_instance() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    state
        .sysstatus()
        .record(Job::Mail, Instant::now(), Outcome::Skipped, None);
    publish(&state).await;
    let id = state.sysstatus().id.to_string();
    let raw: Option<String> = state.valkey().hget(INSTANCES_KEY, &id).await.unwrap();
    let b: Beat = serde_json::from_str(&raw.unwrap()).unwrap();
    assert_eq!(b.id, state.sysstatus().id);
    assert_eq!(b.version, crate::metrics::VERSION);
    assert_eq!(b.jobs[&Job::Mail].last_outcome, Some(Outcome::Skipped));
    let ttl: i64 = state.valkey().ttl(INSTANCES_KEY).await.unwrap();
    assert!(ttl > FORGET_AFTER - 60, "{ttl}");
    let () = state.valkey().hdel(INSTANCES_KEY, id).await.unwrap();
    db.drop().await;
}

/// The proxy probe: any HTTP answer = up (the status line is read), a
/// closed port = down with the reason.
#[tokio::test]
async fn proxy_probe_reads_the_status_line() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut b = [0u8; 512];
        let n = s.read(&mut b).await.unwrap();
        assert!(
            String::from_utf8_lossy(&b[..n]).starts_with("HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\n")
        );
        s.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n")
            .await
            .unwrap();
    });
    assert_eq!(probe("127.0.0.1", port, false).await, Ok((404, None)));
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let e = probe("127.0.0.1", closed, false).await.unwrap_err();
    assert!(e.starts_with("connect:"), "{e}");
}
