use std::net::IpAddr;
use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::fake_agent::PanelHarness;
use crate::testdb::http::{Client, rand_ip};

fn cfg() -> PanelConfig {
    PanelConfig::default()
}

fn stored(main: Option<&str>, sub: Option<&str>, node: Option<&str>) -> Stored {
    Stored {
        main_domain: main.map(String::from),
        sub_domain: sub.map(String::from),
        node_domain: node.map(String::from),
        ..Stored::default()
    }
}

fn name(n: &str) -> ServerName {
    ServerName {
        name: n.into(),
        source: "settings".into(),
        first_used_at: Utc::now(),
    }
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/// Fuzz (domain) regression: a long IDN whose punycode fits 253 bytes but
/// whose Unicode form (what the console shows and sends back) is longer
/// than the old 300-byte input cap must round-trip through `display`.
#[test]
fn long_idn_display_round_trips() {
    let label = "测".repeat(19); // 57 bytes UTF-8, short punycode
    let unicode = [label.as_str(); 6].join(".") + ".中国";
    assert!(unicode.len() > 300, "{}", unicode.len());
    let d = Domain::parse(&unicode).expect("long IDN");
    assert!(d.host.len() <= 253 && d.host.is_ascii());
    let shown = d.display();
    assert_eq!(Domain::parse(&shown).expect("display re-parses"), d);
    assert_eq!(Domain::parse(&d.authority()).expect("authority"), d);
    // The work bound still holds.
    assert!(Domain::parse(&"a".repeat(1025)).is_err());
}

#[test]
fn domain_parsing() {
    for (raw, host, port, authority) in [
        (
            "panel.example.com",
            "panel.example.com",
            None,
            "panel.example.com",
        ),
        (
            " Panel.Example.COM. ",
            "panel.example.com",
            None,
            "panel.example.com",
        ),
        (
            "sub.example.com:8443",
            "sub.example.com",
            Some(8443),
            "sub.example.com:8443",
        ),
        (
            "例子.中国",
            "xn--fsqu00a.xn--fiqs8s",
            None,
            "xn--fsqu00a.xn--fiqs8s",
        ),
        (
            "bücher.example",
            "xn--bcher-kva.example",
            None,
            "xn--bcher-kva.example",
        ),
        ("203.0.113.7", "203.0.113.7", None, "203.0.113.7"),
        (
            "203.0.113.7:8443",
            "203.0.113.7",
            Some(8443),
            "203.0.113.7:8443",
        ),
        ("2001:db8::1", "2001:db8::1", None, "[2001:db8::1]"),
        (
            "[2001:DB8::1]:443",
            "2001:db8::1",
            Some(443),
            "[2001:db8::1]:443",
        ),
        ("::ffff:203.0.113.7", "203.0.113.7", None, "203.0.113.7"),
        ("a-b.c-d.test", "a-b.c-d.test", None, "a-b.c-d.test"),
    ] {
        let d = Domain::parse(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
        assert_eq!((d.host.as_str(), d.port), (host, port), "{raw}");
        assert_eq!(d.authority(), authority, "{raw}");
        // Stored form round-trips.
        assert_eq!(Domain::parse(&d.authority()).unwrap(), d, "{raw}");
    }
    assert_eq!(Domain::parse("例子.中国").unwrap().display(), "例子.中国");
    for bad in [
        "",
        "   ",
        "https://panel.example.com",
        "http://x.com",
        "panel.example.com/sub",
        "panel.example.com?x",
        "user@panel.example.com",
        "*.example.com",
        "localhost",
        "panel",
        "panel..example.com",
        "-panel.example.com",
        "panel-.example.com",
        "pa nel.example.com",
        "panel.example.com:0",
        "panel.example.com:65536",
        "panel.example.com:x",
        "1.2.3",
        "[2001:db8::1",
        "[nope]:443",
        "a_b.example.com",
        "p'x.example.com",
        &format!("{}.com", "a".repeat(64)),
    ] {
        assert!(Domain::parse(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn request_hosts() {
    for (raw, want) in [
        ("Panel.Example.com", "panel.example.com"),
        ("panel.example.com:443", "panel.example.com"),
        ("panel.example.com.", "panel.example.com"),
        ("203.0.113.7:8080", "203.0.113.7"),
        ("[2001:db8::1]:443", "2001:db8::1"),
        ("[2001:db8::1]", "2001:db8::1"),
    ] {
        assert_eq!(request_host(raw), want, "{raw}");
    }
}

/// W25 (R39): the database is the only source. Nothing stored = built-in
/// behaviour (browser origin, no node endpoint, defaults); no panel.toml
/// value takes part.
#[test]
fn database_only_no_file_fallback() {
    let c = cfg();
    // Nothing stored: browser origin, no node endpoint (tokens refused).
    let e = compute(&c, Stored::default(), vec![]);
    assert_eq!((e.main.is_none(), e.main_source), (true, Source::Browser));
    assert_eq!((e.sub.is_none(), e.sub_source), (true, Source::Browser));
    assert_eq!((e.node.is_none(), e.node_source), (true, Source::Unset));
    assert!(!e.trust_cloudflare && e.trust_source == Source::Default);
    assert!(!e.host_gate_on());
    assert_eq!(e.sub_url("p", "t"), None);
    assert_eq!(e.cloudflare_source, Source::Default);
    assert!(!e.cloudflare.is_empty(), "the shipped list");
    assert_eq!(e.audit_retention_days, 365);
    assert_eq!(e.traffic_daily_retention_days, 400);
    assert!(!e.require_admin_2fa);
    assert_eq!(e.remove_mode, RemoveMode::Gate);
    assert_eq!(e.acme_directory_url, "");
    assert_eq!(
        e.install_fallback_url.as_deref(),
        Some(crate::config::DEFAULT_FALLBACK_BINARY_URL)
    );
    assert!(e.install_tls_pin.is_none());
    assert_eq!(
        e.release_keys
            .iter()
            .map(|k| k.id.as_str())
            .collect::<Vec<_>>(),
        ["f2ad18a8bb718a1a"],
        "the official key, compiled in"
    );
    assert_eq!(e.sans, ["127.0.0.1", "localhost"]);

    // Stored values.
    let mut s = stored(
        Some("m.example.org:8443"),
        Some("sub.example.org"),
        Some("node.example.org"),
    );
    s.trust_cloudflare = Some(true);
    s.cloudflare_ranges = Some(vec!["198.51.100.0/24".into()]);
    s.audit_retention_days = Some(0);
    s.traffic_daily_retention_days = Some(40);
    s.require_admin_2fa = Some(true);
    s.remove_mode = Some("rebuild".into());
    s.install_fallback_url = Some(String::new());
    s.acme_directory_url = Some("https://ca.example/dir".into());
    let e = compute(&c, s, vec![]);
    assert_eq!(
        e.install_origin().as_deref(),
        Some("https://m.example.org:8443")
    );
    assert_eq!(e.public_origin(), e.install_origin());
    assert_eq!(
        e.sub_url("pfx", "tok").as_deref(),
        Some("https://sub.example.org/pfx/sub/tok")
    );
    assert_eq!(e.main_source, Source::Settings);
    assert_eq!(e.sub_source, Source::Settings);
    // Node domain without a port: grpc.bind's port.
    let node = e.node.clone().unwrap();
    assert_eq!(node.panel_addr, "node.example.org:8443");
    assert_eq!(node.server_name, "node.example.org");
    assert!(e.trust_cloudflare && e.trust_source == Source::Settings);
    assert_eq!(e.trust.cloudflare.len(), 1, "the stored ranges are trusted");
    assert_eq!(e.cloudflare_source, Source::Settings);
    assert_eq!(
        (e.audit_retention_days, e.traffic_daily_retention_days),
        (0, 40)
    );
    assert!(e.require_admin_2fa);
    assert_eq!(e.remove_mode, RemoveMode::Rebuild);
    assert_eq!(e.install_fallback_url, None, "\"\" = no fallback");
    assert_eq!(e.acme_directory_url, "https://ca.example/dir");

    let e = compute(&c, stored(None, Some("s.example.com"), None), vec![]);
    assert_eq!(
        (e.main_source, e.sub_source),
        (Source::Browser, Source::Settings)
    );
    let e = compute(&c, stored(None, None, Some("[2001:db8::7]:9443")), vec![]);
    let node = e.node.unwrap();
    assert_eq!(node.panel_addr, "[2001:db8::7]:9443");
    assert_eq!(node.server_name, "2001:db8::7");
    // The default port follows grpc.bind.
    let mut c2 = cfg();
    c2.grpc.bind = "0.0.0.0:9555".parse().unwrap();
    let e = compute(&c2, stored(None, None, Some("203.0.113.9")), vec![]);
    assert_eq!(e.node.unwrap().panel_addr, "203.0.113.9:9555");
    // Unparsable stored values fall back to the default, never panic.
    let s = Stored {
        cloudflare_ranges: Some(vec!["nope".into()]),
        extra_release_keys: Some(vec!["nope".into()]),
        remove_mode: Some("weird".into()),
        ..Stored::default()
    };
    let e = compute(&c, s, vec![]);
    assert_eq!(e.cloudflare_source, Source::Default);
    assert_eq!(e.release_keys.len(), 1);
    assert_eq!(e.remove_mode, RemoveMode::Gate);
}

#[test]
fn host_gate_and_ask() {
    let c = cfg();
    let e = compute(
        &c,
        stored(Some("panel.example.com"), Some("sub.example.net"), None),
        vec![],
    );
    assert!(e.host_gate_on());
    for ok in [
        "panel.example.com",
        "sub.example.net",
        "203.0.113.7",
        "2001:db8::1",
        "127.0.0.1",
    ] {
        assert!(e.host_allowed(Some(ok)), "{ok}");
    }
    for no in [
        "evil.example.com",
        "old.example.com",
        "example.com",
        "localhost",
        "x.panel.example.com",
    ] {
        assert!(!e.host_allowed(Some(no)), "{no}");
    }
    assert!(!e.host_allowed(None), "no Host at all");

    assert!(e.ask_allowed("panel.example.com"));
    assert!(e.ask_allowed("SUB.example.net."));
    assert!(!e.ask_allowed("evil.example.com"));
    assert!(!e.ask_allowed(""));
    // IP main domain: never an ask host.
    let e = compute(&c, stored(Some("203.0.113.7"), None, None), vec![]);
    assert!(!e.ask_allowed("203.0.113.7"));
}

/// W24 × payments: the notify URL is always derived from the main domain
/// (no explicit notify URL any more): payments on without any main domain
/// is warned; the notify host is no special case of the host gate.
#[test]
fn payment_notify_host() {
    let c = cfg();
    let e = compute(&c, stored(Some("panel.example.com"), None, None), vec![]);
    assert!(!e.host_allowed(Some("pay.example.org")) && !e.ask_allowed("pay.example.org"));
    assert!(e.standing_warnings(true).is_empty());
    let none = compute(&c, Stored::default(), vec![]);
    assert_eq!(none.standing_warnings(true).len(), 1);
    assert!(none.standing_warnings(false).is_empty());
    assert_eq!(none.public_origin(), None);
    assert_eq!(
        e.public_origin().as_deref(),
        Some("https://panel.example.com")
    );
}

/// The certificate names are a superset of the built-in names + history +
/// current node name, for any sequence of saves: changing the node domain
/// never drops a name (only apply_remove_server_name deletes history rows).
#[test]
fn sans_never_shrink() {
    let c = cfg();
    let mut history: Vec<ServerName> = vec![name("panel.example.com")];
    let mut prev: Vec<String> = sans(&history, "");
    assert!(prev.contains(&"localhost".to_string()));
    let domains = [
        "a.example.com",
        "b.example.com",
        "a.example.com",
        "203.0.113.9",
        "c.example.com",
    ];
    for (i, d) in domains.iter().enumerate() {
        // What apply_update records for a saved node domain.
        let host = Domain::parse(d).unwrap().host;
        if !history.iter().any(|n| n.name == host) {
            history.push(name(&host));
        }
        // Tokens issued in between record their name too (no-op here).
        let e = compute(&c, stored(None, None, Some(d)), history.clone());
        assert_eq!(e.node.as_ref().unwrap().server_name, host);
        for p in &prev {
            assert!(e.sans.contains(p), "step {i}: {p} dropped");
        }
        for n in &history {
            assert!(e.sans.contains(&n.name));
        }
        assert!(e.sans.contains(&"127.0.0.1".to_string()));
        // Unsetting the node domain keeps them too.
        let back = compute(&c, Stored::default(), history.clone());
        for p in &e.sans {
            assert!(back.sans.contains(p), "unset dropped {p}");
        }
        prev = e.sans;
    }
}

#[test]
fn dns_verdicts() {
    let cf = crate::cloudflare::shipped().unwrap();
    let d = Domain::parse("x.example.com").unwrap();
    let ips = |v: &[&str]| {
        v.iter()
            .map(|s| s.parse::<IpAddr>().unwrap())
            .collect::<Vec<_>>()
    };
    let node_cf = judge(
        Kind::Node,
        &d,
        &ips(&["104.21.3.4", "2606:4700:3030::6815:304"]),
        &cf,
    );
    assert_eq!(node_cf.level, "block");
    assert!(node_cf.message.contains("灰色云朵"));
    assert!(node_cf.addresses.iter().all(|a| a.cloudflare));
    let node_mixed = judge(Kind::Node, &d, &ips(&["203.0.113.9", "2606:4700::1"]), &cf);
    assert_eq!(node_mixed.level, "block", "any CF address blocks");
    assert_eq!(
        judge(Kind::Node, &d, &ips(&["203.0.113.9", "2001:db8::9"]), &cf).level,
        "ok"
    );
    assert_eq!(
        judge(Kind::Sub, &d, &ips(&["172.67.1.1", "2a06:98c1::1"]), &cf).level,
        "ok"
    );
    let sub_direct = judge(Kind::Sub, &d, &ips(&["203.0.113.9"]), &cf);
    assert_eq!(sub_direct.level, "warn");
    assert!(sub_direct.message.contains("橙色云朵"));
    assert_eq!(
        judge(Kind::Main, &d, &ips(&["104.16.0.1"]), &cf).level,
        "ok"
    );
}

// ---------------------------------------------------------------------------
// Real database
// ---------------------------------------------------------------------------

async fn admin_client(state: &AppState, db: &TestDb) -> Client {
    let id = db.admin().await;
    let (role, sv): (String, i64) =
        sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
            .bind(id)
            .fetch_one(state.pg())
            .await
            .unwrap();
    let mut c = Client::new(state, rand_ip());
    c.cookie =
        Some(crate::auth::issue_token(state, id, &role, sv, crate::auth::Stage::Full).unwrap());
    c
}

async fn audit_rows(db: &TestDb, action: &str) -> Vec<(Option<Value>, Option<Value>)> {
    sqlx::query_as("SELECT before, after FROM audit_log WHERE action = $1 ORDER BY id")
        .bind(action)
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

async fn set(db: &TestDb, version: i64, v: Values) -> Result<Stored, ApiError> {
    let mut tx = db.pool.begin().await.unwrap();
    let r = apply_update(&mut tx, &Actor::test(), version, &v).await;
    if r.is_ok() {
        tx.commit().await.unwrap();
    }
    r
}

/// Writes are versioned, audited in the same transaction, a node domain is
/// recorded as a gRPC server name, and a stale version is refused.
#[tokio::test]
async fn update_is_versioned_and_audited() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let v = Values {
        main_domain: Some("panel.example.com".into()),
        sub_domain: Some("sub.example.com".into()),
        node_domain: Some("grpc.example.com:9443".into()),
        trust_cloudflare: Some(true),
    };
    let s = set(&db, 0, v.clone()).await.unwrap();
    assert_eq!(s.version, 1);
    // Same values again: no write, no audit row.
    assert_eq!(set(&db, 1, v.clone()).await.unwrap().version, 1);
    let err = set(&db, 0, Values::default()).await.unwrap_err();
    assert_eq!(err.status(), StatusCode::CONFLICT, "stale form");
    let rows = audit_rows(&db, "settings.update").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].1.as_ref().unwrap()["node_domain"],
        "grpc.example.com:9443"
    );
    assert_eq!(rows[0].0.as_ref().unwrap()["main_domain"], Value::Null);
    let names: Vec<String> = sqlx::query_scalar("SELECT name FROM grpc_server_names ORDER BY name")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        names,
        vec!["grpc.example.com".to_string()],
        "host only, no port"
    );
    // A failed update leaves neither a row change nor an audit row.
    let mut tx = db.pool.begin().await.unwrap();
    assert!(
        apply_update(&mut tx, &Actor::test(), 7, &Values::default())
            .await
            .is_err()
    );
    drop(tx);
    assert_eq!(audit_rows(&db, "settings.update").await.len(), 1);
    db.drop().await;
}

/// A committed change reaches another instance through LISTEN/NOTIFY.
#[tokio::test]
async fn change_propagates_to_another_instance() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let a = AppState::for_test(db.pool.clone()).await;
    let b = AppState::for_test(db.pool.clone()).await;
    let la = crate::notify::start(a.clone()).await;
    let lb = crate::notify::start(b.clone()).await;
    assert!(b.settings().get().sub.is_none());
    let mut tx = a.pg().begin().await.unwrap();
    apply_update(
        &mut tx,
        &Actor::test(),
        0,
        &Values {
            sub_domain: Some("sub.example.com".into()),
            trust_cloudflare: Some(true),
            ..Values::default()
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut seen = false;
    for _ in 0..100 {
        let e = b.settings().get();
        if e.sub_url("test", "t").as_deref() == Some("https://sub.example.com/test/sub/t") {
            assert!(e.trust_cloudflare && !e.trust.cloudflare.is_empty());
            seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(seen, "B picked up A's change");
    la.abort();
    lb.abort();
    let _ = la.await;
    let _ = lb.await;
    db.drop().await;
}

/// Host gate (HTTP level): once the main domain is set, an unknown DNS
/// Host gets the canonical rejection on every path, even with the right
/// prefix; configured names and IP literals pass.
#[tokio::test]
async fn unknown_host_gets_the_canonical_rejection() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let mut c = Client::new(&state, rand_ip());
    let canonical = c.get("/definitely/not/here").await.fingerprint();
    c.headers = vec![("host".into(), "evil.example.com".into())];
    assert_eq!(
        c.get("/test/healthz").await.status,
        StatusCode::OK,
        "gate off"
    );

    set(
        &db,
        0,
        Values {
            main_domain: Some("panel.example.com".into()),
            sub_domain: Some("sub.example.com".into()),
            ..Values::default()
        },
    )
    .await
    .unwrap();
    reload(&state).await.unwrap();
    for host in [
        "evil.example.com",
        "example.com",
        "panel.example.com.evil.net",
    ] {
        c.headers = vec![("host".into(), host.into())];
        for path in [
            "/test/healthz",
            "/test/api/v1/me",
            "/",
            "/test/sub/abc",
            "/nope",
        ] {
            assert_eq!(c.get(path).await.fingerprint(), canonical, "{host} {path}");
        }
    }
    for host in [
        "panel.example.com",
        "SUB.example.com:443",
        "203.0.113.5:8080",
        "[2001:db8::1]",
    ] {
        c.headers = vec![("host".into(), host.into())];
        assert_eq!(
            c.get("/test/healthz").await.status,
            StatusCode::OK,
            "{host}"
        );
        assert_eq!(c.get("/nope").await.fingerprint(), canonical, "{host}");
    }
    db.drop().await;
}

/// The settings API: admin only, IDN normalized, host-change confirmation,
/// sub_url in token responses, server-name removal with affected nodes.
#[tokio::test]
async fn settings_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let mut admin = admin_client(&state, &db).await;
    admin.headers = vec![("host".into(), "203.0.113.5".into())];
    let r = admin.get("/test/api/v1/settings").await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["version"], 0);
    // testdb seeds the node domain the old default grpc.advertise had.
    assert_eq!(v["node"]["source"], "settings");
    assert_eq!(v["node"]["panel_addr"], "127.0.0.1:8443");
    assert_eq!(v["main"]["source"], "browser");

    // Validation.
    for (field, bad) in [
        ("main_domain", "https://x.com"),
        ("sub_domain", "x.com/p"),
        ("node_domain", "*.x.com"),
    ] {
        let mut body = json!({"version": 0, "main_domain": null, "sub_domain": null,
                              "node_domain": null, "trust_cloudflare": null});
        body[field] = json!(bad);
        let r = admin
            .req(axum::http::Method::PUT, "/test/api/v1/settings", Some(body))
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{field}={bad}");
    }
    // An IP-literal node domain (no DNS involved), IDN main domain.
    let body = json!({"version": 0, "main_domain": "例子.example", "sub_domain": "",
                      "node_domain": "203.0.113.20", "trust_cloudflare": true});
    let r = admin
        .req(axum::http::Method::PUT, "/test/api/v1/settings", Some(body))
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let v = r.json();
    assert_eq!(v["main"]["value"], "xn--fsqu00a.example");
    assert_eq!(v["main"]["display"], "例子.example");
    assert_eq!(v["sub"]["source"], "main");
    assert_eq!(v["node"]["panel_addr"], "203.0.113.20:8443");
    assert_eq!(v["trust_cloudflare"]["effective"], true);
    assert_eq!(v["host_gate"], true);

    // Accessing through a DNS name that the new main domain would refuse:
    // 422 unless confirmed.
    admin.headers = vec![("host".into(), "xn--fsqu00a.example".into())];
    let body = json!({"version": 1, "main_domain": "new.example.com", "sub_domain": null,
                      "node_domain": "203.0.113.20", "trust_cloudflare": true});
    let r = admin
        .req(
            axum::http::Method::PUT,
            "/test/api/v1/settings",
            Some(body.clone()),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let mut confirmed = body;
    confirmed["confirm_host_change"] = json!(true);
    let r = admin
        .req(
            axum::http::Method::PUT,
            "/test/api/v1/settings",
            Some(confirmed),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    admin.headers = vec![("host".into(), "new.example.com".into())];

    // Subscription URLs on the effective subscription domain.
    let user = db.user().await;
    let r = admin
        .post(&format!("/test/api/v1/users/{user}/sub-token"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let tok = r.json()["sub_token"].as_str().unwrap().to_string();
    assert_eq!(
        r.json()["sub_url"].as_str().unwrap(),
        format!("https://new.example.com/test/sub/{tok}")
    );

    // Server names: the current one is locked; an older one is removable
    // and lists the nodes still using it.
    let node = db.node().await;
    let mut tx = db.pool.begin().await.unwrap();
    let ep = node_endpoint(&mut tx, state.cfg()).await.unwrap();
    assert_eq!(ep.server_name, "203.0.113.20");
    crate::enroll::apply_issue_token(&mut tx, &Actor::test(), node, 3600, None, &ep)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let r = admin
        .post(
            "/test/api/v1/settings/server-names/remove",
            json!({"name": "203.0.113.20", "confirm": true}),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "current name");
    let body = json!({"version": 2, "main_domain": "new.example.com", "sub_domain": null,
                      "node_domain": "203.0.113.21", "trust_cloudflare": true});
    let r = admin
        .req(axum::http::Method::PUT, "/test/api/v1/settings", Some(body))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    let old = v["server_names"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["name"] == "203.0.113.20")
        .unwrap()
        .clone();
    assert_eq!(old["current"], false);
    assert_eq!(old["locked"], Value::Null);
    assert_eq!(old["nodes"][0]["id"], node.to_string());
    assert_eq!(old["nodes"][0]["reason"], "pending");
    let r = admin
        .post(
            "/test/api/v1/settings/server-names/remove",
            json!({"name": "203.0.113.20", "confirm": false}),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "needs confirmation");
    for locked in ["localhost"] {
        let r = admin
            .post(
                "/test/api/v1/settings/server-names/remove",
                json!({"name": locked, "confirm": true}),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{locked} is built in");
    }
    let r = admin
        .post(
            "/test/api/v1/settings/server-names/remove",
            json!({"name": "203.0.113.20", "confirm": true}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["affected_nodes"][0]["id"], node.to_string());
    let rows = audit_rows(&db, "settings.server_name.remove").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].1.as_ref().unwrap()["affected_nodes"][0],
        node.to_string()
    );

    // Non-admins get nothing.
    let mut u = Client::new(&state, rand_ip());
    let (role, sv): (String, i64) =
        sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
            .bind(user)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    u.cookie =
        Some(crate::auth::issue_token(&state, user, &role, sv, crate::auth::Stage::Full).unwrap());
    u.headers = vec![("host".into(), "new.example.com".into())];
    assert_eq!(
        u.get("/test/api/v1/settings").await.status,
        StatusCode::FORBIDDEN
    );
    db.drop().await;
}

/// A failed login with a fresh (unknown) name: counts against the
/// client's address bucket only.
async fn login(c: &Client, n: usize) -> StatusCode {
    c.post(
        "/test/auth/login",
        json!({"login": format!("nobody-{}-{n}", uuid::Uuid::new_v4()), "password": "x"}),
    )
    .await
    .status
}

/// Client address behind Cloudflare → Caddy → panel: with "trust
/// Cloudflare" the login limit counts the real client (CF-Connecting-IP),
/// a forged header from an untrusted peer is ignored, and without the
/// setting the whole Cloudflare edge is one client.
#[tokio::test]
async fn cloudflare_chain_attributes_the_real_client() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let caddy = rand_ip();
    let state = AppState::for_test_with(db.pool.clone(), |c| {
        c.web.trusted_proxies = vec![Cidr::parse(&caddy.to_string()).unwrap()];
    })
    .await;
    let edge: IpAddr = format!("104.16.{}.{}", rand::random::<u8>(), rand::random::<u8>())
        .parse()
        .unwrap();
    let via_cf = |client: IpAddr| {
        let mut c = Client::new(&state, caddy);
        // Stock Caddy (not trusting Cloudflare) replaced Cloudflare's XFF
        // with the edge address; CF-Connecting-IP passes through.
        c.headers = vec![
            ("x-forwarded-for".into(), edge.to_string()),
            ("cf-connecting-ip".into(), client.to_string()),
        ];
        c
    };
    let set_trust = |v: bool| {
        let db = &db;
        let state = &state;
        async move {
            let cur: i64 = sqlx::query_scalar("SELECT version FROM panel_settings")
                .fetch_one(&db.pool)
                .await
                .unwrap();
            set(
                db,
                cur,
                Values {
                    trust_cloudflare: Some(v),
                    ..Values::default()
                },
            )
            .await
            .unwrap();
            reload(state).await.unwrap();
        }
    };

    set_trust(true).await;
    let (c1, c2) = (rand_ip(), rand_ip());
    let a = via_cf(c1);
    for n in 0..crate::login_limit::PER_IP as usize {
        assert_eq!(login(&a, n).await, StatusCode::UNAUTHORIZED, "c1 #{n}");
    }
    assert_eq!(
        login(&a, 99).await,
        StatusCode::TOO_MANY_REQUESTS,
        "c1 limited"
    );
    assert_eq!(
        login(&via_cf(c2), 0).await,
        StatusCode::UNAUTHORIZED,
        "another client behind the same edge is not"
    );
    // An untrusted peer forging both headers is attributed to itself: c1's
    // bucket is not its to use (and it cannot hide in c2's).
    let mut forger = Client::new(&state, rand_ip());
    forger.headers = vec![
        ("x-forwarded-for".into(), edge.to_string()),
        ("cf-connecting-ip".into(), c2.to_string()),
    ];
    assert_eq!(login(&forger, 0).await, StatusCode::UNAUTHORIZED);
    // A client-chosen CF-Connecting-IP behind Caddy but NOT via an edge
    // (XFF = the client's own address) is ignored.
    let mut direct = Client::new(&state, caddy);
    direct.headers = vec![
        ("x-forwarded-for".into(), c2.to_string()),
        ("cf-connecting-ip".into(), c1.to_string()),
    ];
    assert_eq!(
        login(&direct, 0).await,
        StatusCode::UNAUTHORIZED,
        "c2 bucket, not c1"
    );

    // Trust off: the edge itself is the client (header ignored), so c1's
    // exhausted bucket does not apply to it.
    set_trust(false).await;
    assert_eq!(login(&via_cf(c1), 0).await, StatusCode::UNAUTHORIZED);
    db.drop().await;
}

/// gRPC certificate hot swap: after a node domain is saved, agents that
/// verify the new name handshake on the running server (no restart), and
/// agents with the old server name keep working.
#[tokio::test]
async fn node_domain_hot_swaps_the_grpc_certificate() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let panel = PanelHarness::start(&db).await;
    let st = &panel.state;
    // An enrolled agent from before (server name "127.0.0.1", the node
    // domain testdb seeds).
    let old_node = db.node().await;
    let mut tx = db.pool.begin().await.unwrap();
    let ep = node_endpoint(&mut tx, st.cfg()).await.unwrap();
    assert_eq!(ep.server_name, "127.0.0.1");
    let (t, _) =
        crate::enroll::apply_issue_token(&mut tx, &Actor::test(), old_node, 3600, None, &ep)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    let old_creds = panel.enroll(&t).await.unwrap();
    let sn: Option<String> = sqlx::query_scalar("SELECT server_name FROM nodes WHERE id = $1")
        .bind(old_node)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(sn.as_deref(), Some("127.0.0.1"), "recorded at enrollment");

    assert!(
        panel.channel_named(None, "grpc.akari.test").await.is_err(),
        "not covered yet"
    );
    set(
        &db,
        0,
        Values {
            node_domain: Some("grpc.akari.test".into()),
            ..Values::default()
        },
    )
    .await
    .unwrap();
    reload(st).await.unwrap();
    assert!(
        st.settings()
            .certs()
            .names()
            .contains(&"grpc.akari.test".to_string())
    );

    // A new node's bootstrap carries the new endpoint; it enrolls and
    // connects verifying it.
    let new_node = db.node().await;
    let mut tx = db.pool.begin().await.unwrap();
    let ep = node_endpoint(&mut tx, st.cfg()).await.unwrap();
    assert_eq!(ep.server_name, "grpc.akari.test");
    assert_eq!(ep.panel_addr, "grpc.akari.test:8443");
    let (t, _) =
        crate::enroll::apply_issue_token(&mut tx, &Actor::test(), new_node, 3600, None, &ep)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    let mut client = crate::pb::agent_enrollment_client::AgentEnrollmentClient::new(
        panel.channel_named(None, "grpc.akari.test").await.unwrap(),
    );
    let key = rcgen::KeyPair::generate().unwrap();
    let csr = rcgen::CertificateParams::default()
        .serialize_request(&key)
        .unwrap();
    let issued = client
        .enroll(crate::pb::EnrollRequest {
            token: t,
            csr_der: csr.der().to_vec(),
        })
        .await
        .unwrap()
        .into_inner();
    let new_creds = crate::testdb::fake_agent::AgentCreds {
        cert: issued.cert_pem,
        key: key.serialize_pem(),
        ca: issued.ca_pem,
    };
    let sn: Option<String> = sqlx::query_scalar("SELECT server_name FROM nodes WHERE id = $1")
        .bind(new_node)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(sn.as_deref(), Some("grpc.akari.test"));
    assert!(
        panel
            .connect_named(&new_creds, "grpc.akari.test")
            .await
            .is_ok()
    );
    // The old agent (server name localhost) still handshakes.
    assert!(panel.connect(&old_creds).await.is_ok());

    // Another node domain later: both earlier names stay covered.
    set(
        &db,
        1,
        Values {
            node_domain: Some("grpc2.akari.test".into()),
            ..Values::default()
        },
    )
    .await
    .unwrap();
    reload(st).await.unwrap();
    let names = st.settings().certs().names();
    for n in ["localhost", "grpc.akari.test", "grpc2.akari.test"] {
        assert!(names.contains(&n.to_string()), "{n} in {names:?}");
    }
    assert!(
        panel
            .connect_named(&new_creds, "grpc.akari.test")
            .await
            .is_ok()
    );
    assert!(panel.connect(&old_creds).await.is_ok());
    db.drop().await;
}

/// Caddy ask endpoint: 200 only for configured domains, canonical 404
/// otherwise, per-instance rate limit.
#[tokio::test]
async fn ask_endpoint() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state =
        AppState::for_test_with(db.pool.clone(), |c| c.limits.tls_ask_rate_per_sec = 4).await;
    set(
        &db,
        0,
        Values {
            main_domain: Some("panel.example.com".into()),
            sub_domain: Some("sub.example.com:8443".into()),
            ..Values::default()
        },
    )
    .await
    .unwrap();
    reload(&state).await.unwrap();
    let app = ask_router(state.clone());
    let get = |uri: &str| {
        let app = app.clone();
        let req = axum::http::Request::get(uri)
            .body(axum::body::Body::empty())
            .unwrap();
        async move { app.oneshot(req).await.unwrap().status() }
    };
    assert_eq!(get("/ask?domain=panel.example.com").await, StatusCode::OK);
    assert_eq!(get("/ask?domain=sub.example.com").await, StatusCode::OK);
    assert_eq!(
        get("/ask?domain=evil.example.com").await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(get("/ask").await, StatusCode::NOT_FOUND);
    assert_eq!(get("/other").await, StatusCode::NOT_FOUND);
    // The window of 4 is used up now.
    assert_eq!(
        get("/ask?domain=panel.example.com").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    db.drop().await;
}

// ---------------------------------------------------------------------------
// W12: latency-test settings
// ---------------------------------------------------------------------------

#[test]
fn probe_precedence_and_bounds() {
    let c = cfg();
    let e = compute(&c, Stored::default(), vec![]);
    assert_eq!(e.probe.interval_secs, 18_000);
    assert_eq!(e.probe.urls, ProbeConfig::default().urls);
    assert!(e.probe.panel_tcp);
    assert_eq!(
        e.probe_sources,
        ProbeSources {
            interval_secs: Source::Default,
            urls: Source::Default,
            panel_tcp: Source::Default
        }
    );
    let s = Stored {
        probe_interval_secs: Some(900),
        probe_urls: Some(vec!["http://probe.example/204".into()]),
        probe_panel_tcp: Some(false),
        ..Stored::default()
    };
    let e = compute(&c, s, vec![]);
    assert_eq!(e.probe.interval_secs, 900);
    assert_eq!(e.probe.urls, vec!["http://probe.example/204".to_string()]);
    assert!(!e.probe.panel_tcp);
    assert_eq!(e.probe_sources.interval_secs, Source::Settings);
    assert_eq!(e.probe_sources.urls, Source::Settings);
    assert_eq!(e.probe_sources.panel_tcp, Source::Settings);
    // Values the API and the CHECKs refuse are ignored, never applied.
    let s = Stored {
        probe_interval_secs: Some(5),
        probe_urls: Some(vec!["ftp://x".into()]),
        ..Stored::default()
    };
    let e = compute(&c, s, vec![]);
    assert_eq!(e.probe.interval_secs, 18_000);
    assert_eq!(e.probe.urls, ProbeConfig::default().urls);
    assert_eq!(e.probe_sources.interval_secs, Source::Default);
}

#[test]
fn probe_form_validation() {
    let req = |iv: Option<u64>, urls: Option<Vec<&str>>| ProbeReq {
        version: 0,
        interval_secs: iv,
        urls: urls.map(|u| u.into_iter().map(String::from).collect()),
        panel_tcp: Some(true),
    };
    let ok = probe_values(&req(
        Some(600),
        Some(vec![
            " https://a.example/generate_204 ",
            "http://b.example:8080/x",
        ]),
    ))
    .unwrap();
    assert_eq!(ok.interval_secs, Some(600));
    assert_eq!(
        ok.urls.unwrap(),
        vec!["https://a.example/generate_204", "http://b.example:8080/x"],
        "trimmed"
    );
    assert_eq!(probe_values(&req(None, Some(vec![]))).unwrap().urls, None);
    for bad in [
        req(Some(599), None),
        req(Some(604_801), None),
        req(None, Some(vec!["ftp://a.example/"])),
        req(None, Some(vec!["https://user@a.example/"])),
        req(None, Some(vec!["https://a.example/ x"])),
        req(None, Some(vec!["https://a.example/", "https://a.example/"])),
        req(
            None,
            Some(vec![
                "http://a/1",
                "http://a/2",
                "http://a/3",
                "http://a/4",
                "http://a/5",
            ]),
        ),
    ] {
        let e = probe_values(&bad).unwrap_err();
        assert_eq!(e.status(), StatusCode::BAD_REQUEST);
    }
}

/// The probe form: versioned with the domains (one row), audited as
/// settings.probe.update, unset = panel.toml, a shorter interval pulls far
/// scheduled panel tests forward, and the domains form leaves it alone.
#[tokio::test]
async fn probe_settings_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let mut admin = admin_client(&state, &db).await;
    admin.headers = vec![("host".into(), "203.0.113.5".into())];
    let v = admin.get("/test/api/v1/settings").await.json();
    assert_eq!(v["probe"]["interval_secs"]["effective"], 18_000);
    assert_eq!(v["probe"]["interval_secs"]["source"], "default");
    assert_eq!(v["probe"]["urls"]["value"], Value::Null);
    assert_eq!(v["probe"]["panel_tcp"]["default"], true);

    let (n, _) = db.member().await;
    sqlx::query("UPDATE nodes SET panel_probe_next_at = now() + interval '4 hours' WHERE id = $1")
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
    let put = |body: Value| {
        let admin = &admin;
        async move {
            admin
                .req(
                    axum::http::Method::PUT,
                    "/test/api/v1/settings/probe",
                    Some(body),
                )
                .await
        }
    };
    let r = put(json!({"version": 0, "interval_secs": 60, "urls": null, "panel_tcp": null})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = put(json!({"version": 0, "interval_secs": 600, "unknown": 1})).await;
    assert!(r.status.is_client_error(), "unknown field refused");
    let r = put(json!({"version": 0, "interval_secs": 600,
        "urls": ["http://127.0.0.1:9/generate_204"], "panel_tcp": false}))
    .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let v = r.json();
    assert_eq!(v["version"], 1);
    assert_eq!(v["probe"]["interval_secs"]["effective"], 600);
    assert_eq!(v["probe"]["interval_secs"]["source"], "settings");
    assert_eq!(
        v["probe"]["urls"]["effective"][0],
        "http://127.0.0.1:9/generate_204"
    );
    assert_eq!(v["probe"]["panel_tcp"]["effective"], false);
    assert_eq!(
        state.settings().get().probe.interval_secs,
        600,
        "this instance reloaded"
    );
    let next_in: f64 = sqlx::query_scalar(
        "SELECT EXTRACT(EPOCH FROM panel_probe_next_at - now())::float8 FROM nodes WHERE id = $1",
    )
    .bind(n)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(next_in <= 601.0, "panel test pulled forward: {next_in}");
    // Stale form.
    let r =
        put(json!({"version": 0, "interval_secs": null, "urls": null, "panel_tcp": null})).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    // The domains form keeps the probe values (and bumps the shared version).
    let r = admin
        .req(
            axum::http::Method::PUT,
            "/test/api/v1/settings",
            Some(
                json!({"version": 1, "main_domain": null, "sub_domain": null,
                        "node_domain": null, "trust_cloudflare": true}),
            ),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["probe"]["interval_secs"]["value"], 600);
    // Unset: the built-in default again.
    let r = put(json!({"version": 2, "interval_secs": null, "urls": [], "panel_tcp": null})).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["probe"]["interval_secs"]["source"], "default");
    assert_eq!(v["probe"]["urls"]["value"], Value::Null);
    let rows = audit_rows(&db, "settings.probe.update").await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].1.as_ref().unwrap()["probe_interval_secs"], 600);
    assert_eq!(
        rows[1].1.as_ref().unwrap()["probe_interval_secs"],
        Value::Null
    );
    db.drop().await;
}

/// A probe settings change reaches a connected latency-capable agent (the
/// reload wakes its session, which re-sends LatencyProbeConfig), and the
/// agent's Hello capabilities are recorded on the node.
#[tokio::test]
async fn probe_change_reaches_connected_agents() {
    use crate::pb::panel_down::Msg as DownMsg;
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (n, _u) = db.member().await;
    let panel = PanelHarness::start(&db).await;
    let creds = panel.register(&db, n).await;
    let mut agent = panel.connect(&creds).await.unwrap();
    agent
        .hello_caps((0, 0), String::new(), &["metrics", "latency", "latency"])
        .await;
    let mut first = None;
    while first.is_none() {
        match agent.next().await {
            Some(Ok(DownMsg::LatencyProbe(c))) => first = Some(c),
            Some(Ok(_)) => {}
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(first.unwrap().interval_seconds, 18_000);
    let caps: Option<Vec<String>> =
        sqlx::query_scalar("SELECT agent_capabilities FROM nodes WHERE id = $1")
            .bind(n)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        caps.unwrap(),
        vec!["latency", "metrics"],
        "sorted, deduplicated"
    );

    let mut tx = db.pool.begin().await.unwrap();
    apply_update_probe(
        &mut tx,
        &Actor::test(),
        panel.state.cfg(),
        0,
        &ProbeValues {
            interval_secs: Some(1200),
            urls: Some(vec!["http://probe.example/204".into()]),
            panel_tcp: None,
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    // The harness runs no LISTEN task: reload as the notification would.
    reload(&panel.state).await.unwrap();
    let got = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match agent.next().await {
                Some(Ok(DownMsg::LatencyProbe(c))) => break c,
                Some(Ok(_)) => {}
                other => panic!("{other:?}"),
            }
        }
    })
    .await
    .expect("new probe config sent");
    assert_eq!(got.interval_seconds, 1200);
    assert_eq!(got.urls, vec!["http://probe.example/204".to_string()]);
    db.drop().await;
}

// ---------------------------------------------------------------------------
// W25 (R39): obsolete panel.toml keys, 节点通信 / 安全 settings
// ---------------------------------------------------------------------------

/// An old-style panel.toml: every moved key, a few constants, one unusable
/// value and an unknown-but-obsolete-section neighbour.
const OLD_TOML: &str = r#"
[web]
bind = "127.0.0.1:8080"
advertised_names = ["panel.example.com", "*.akari.test"]
sub_domain = "sub.example.com"
trust_cloudflare = true
cloudflare_ranges = ["198.51.100.0/24"]
[grpc]
bind = "127.0.0.1:8443"
advertise = "grpc.example.com:9443"
server_name = "panel.example.com"
lease_seconds = 7200
[install]
public_url = "https://panel.example.com"
tls_pin = "sha256//CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk="
fallback_binary_url = ""
token_ttl_secs = 600
[probe]
interval_secs = 1200
urls = ["https://probe.example/204"]
panel_tcp = false
timeout_ms = 2000
[acme]
directory_url = "https://ca.example/dir"
email = "not-an-address"
[audit]
retention_days = 30
[traffic]
daily_retention_days = 60
node_burst_secs = 60
[auth]
require_admin_2fa = true
[agent]
remove_mode = "rebuild"
cert_validity_secs = 60
[updates]
release_keys = ["ciJILGk6W1TnPr56Dncgv0mVQFBzqOrawiOaH0/d5Pg= key-f2ad18a8bb718a1a", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= extra"]
[alerts]
eval_interval_secs = 5
telegram_api_url = "https://tg.example.com/"
"#;

async fn old_state(db: &TestDb, text: &str) -> AppState {
    let parsed = PanelConfig::parse(text).unwrap();
    AppState::for_test_with(db.pool.clone(), |c| c.legacy = parsed.legacy).await
}

/// The import writes every moved value the database lacks, once, in one
/// audited transaction (actor system) that notifies every instance; records
/// the server names; reports constants and unusable values; and never
/// re-imports — not even after an admin unsets an imported value.
#[tokio::test]
async fn obsolete_keys_are_imported_once() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    // testdb seeds a node domain: the file's advertise must not replace it.
    let st = old_state(&db, OLD_TOML).await;
    let mut listener = sqlx::postgres::PgListener::connect_with(&db.pool)
        .await
        .unwrap();
    listener.listen("akari_change").await.unwrap();
    let report = import_legacy(&st).await;
    let got = |k: &str| report.get(k).cloned();
    for k in [
        "web.sub_domain",
        "web.trust_cloudflare",
        "web.cloudflare_ranges",
        "web.advertised_names",
        "grpc.server_name",
        "install.public_url",
        "install.tls_pin",
        "install.fallback_binary_url",
        "probe.interval_secs",
        "probe.urls",
        "probe.panel_tcp",
        "acme.directory_url",
        "audit.retention_days",
        "traffic.daily_retention_days",
        "auth.require_admin_2fa",
        "agent.remove_mode",
        "updates.release_keys",
        "alerts.telegram_api_url",
    ] {
        assert_eq!(got(k), Some(Imported::Now), "{k}");
    }
    assert_eq!(
        got("grpc.advertise"),
        Some(Imported::Kept),
        "DB had a node domain"
    );
    assert!(matches!(got("acme.email"), Some(Imported::Unusable(_))));
    for k in [
        "grpc.lease_seconds",
        "install.token_ttl_secs",
        "probe.timeout_ms",
        "traffic.node_burst_secs",
        "agent.cert_validity_secs",
        "alerts.eval_interval_secs",
    ] {
        assert_eq!(got(k), Some(Imported::Constant), "{k}");
    }
    assert!(report.host_gate_on, "public_url became the main domain");
    // The committed import notified (every instance reloads).
    let n = tokio::time::timeout(Duration::from_secs(5), listener.recv())
        .await
        .expect("notification")
        .unwrap();
    assert_eq!(n.payload(), "settings");
    drop(listener);

    reload(&st).await.unwrap();
    let e = st.settings().get();
    assert_eq!(e.main_source, Source::Settings);
    assert_eq!(
        e.install_origin().as_deref(),
        Some("https://panel.example.com")
    );
    assert_eq!(
        e.sub_url("p", "t").as_deref(),
        Some("https://sub.example.com/p/sub/t")
    );
    assert_eq!(e.node.as_ref().unwrap().panel_addr, "127.0.0.1:8443");
    assert!(e.trust_cloudflare && e.cloudflare_source == Source::Settings);
    assert_eq!(e.cloudflare.len(), 1);
    assert_eq!(e.install_fallback_url, None, "\"\" = no fallback, imported");
    assert!(
        e.install_tls_pin
            .as_deref()
            .unwrap()
            .starts_with("sha256//")
    );
    assert_eq!(
        (e.probe.interval_secs, e.probe.urls.len(), e.probe.panel_tcp),
        (1200, 1, false)
    );
    assert_eq!(e.acme_directory_url, "https://ca.example/dir");
    assert_eq!(e.acme_email, "", "unusable: not imported");
    assert_eq!(
        (e.audit_retention_days, e.traffic_daily_retention_days),
        (30, 60)
    );
    assert!(e.require_admin_2fa);
    assert_eq!(e.remove_mode, RemoveMode::Rebuild);
    assert_eq!(
        e.stored.extra_release_keys.as_deref(),
        Some(&["AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= extra".to_string()][..]),
        "only the non-official key is extra"
    );
    assert_eq!(e.release_keys.len(), 2);
    for n in ["panel.example.com", "*.akari.test"] {
        assert!(e.sans.contains(&n.to_string()), "{n} in {:?}", e.sans);
        let src: String =
            sqlx::query_scalar("SELECT source FROM grpc_server_names WHERE name = $1")
                .bind(n)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(src, "config");
    }
    // One audit row, actor system, listing the imported keys.
    let rows: Vec<(String, Option<Value>)> =
        sqlx::query_as("SELECT actor_login, after FROM audit_log WHERE action = 'settings.import'")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "system");
    let after = rows[0].1.clone().unwrap();
    assert!(after["keys"].as_array().unwrap().len() >= 15, "{after}");
    assert_eq!(after["values"]["main_domain"], "panel.example.com");
    assert!(after["values"].get("node_domain").is_none(), "unchanged");
    let marks: i64 = sqlx::query_scalar("SELECT count(*) FROM legacy_config_imports")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(marks, 20, "every moved key handled once");
    // 告警 → Telegram API 地址 (alert_settings, same transaction and audit row).
    let tg: Option<String> =
        sqlx::query_scalar("SELECT telegram_api_url FROM alert_settings WHERE id = 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(tg.as_deref(), Some("https://tg.example.com"));
    assert_eq!(
        after["values"]["alerts.telegram_api_url"],
        "https://tg.example.com"
    );

    // An admin clears an imported value: the file never brings it back.
    let v = st.settings().get().stored.version;
    let mut tx = db.pool.begin().await.unwrap();
    apply_update_security(&mut tx, &Actor::test(), v, &SecurityValues::default())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let again = import_legacy(&old_state(&db, OLD_TOML).await).await;
    assert_eq!(again.get("auth.require_admin_2fa"), Some(&Imported::Before));
    assert_eq!(again.get("grpc.lease_seconds"), Some(&Imported::Constant));
    assert!(!again.host_gate_on);
    reload(&st).await.unwrap();
    assert!(!st.settings().get().require_admin_2fa, "stays cleared");
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'settings.import'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(rows, 1, "nothing imported the second time");
    db.drop().await;
}

/// A node domain from grpc.advertise when the database has none; values of
/// the wrong type never stop anything; a file with nothing obsolete is a
/// no-op.
#[tokio::test]
async fn import_edge_cases() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    sqlx::query("UPDATE panel_settings SET node_domain = NULL")
        .execute(&db.pool)
        .await
        .unwrap();
    let st = old_state(
        &db,
        "[grpc]\nadvertise = \"203.0.113.9:8443\"\n[audit]\nretention_days = \"many\"\n\
         [install]\npublic_url = \"http://panel.example.com\"\n",
    )
    .await;
    let r = import_legacy(&st).await;
    assert_eq!(r.get("grpc.advertise"), Some(&Imported::Now));
    assert!(matches!(
        r.get("audit.retention_days"),
        Some(Imported::Unusable(_))
    ));
    assert!(matches!(
        r.get("install.public_url"),
        Some(Imported::Unusable(_))
    ));
    assert!(!r.host_gate_on);
    reload(&st).await.unwrap();
    let e = st.settings().get();
    assert_eq!(e.node.as_ref().unwrap().panel_addr, "203.0.113.9:8443");
    assert_eq!(e.audit_retention_days, 365);
    // Nothing obsolete: nothing happens.
    let clean = AppState::for_test(db.pool.clone()).await;
    assert!(import_legacy(&clean).await.keys.is_empty());
    db.drop().await;
}

/// No node domain = no enrollment token, with a coded error (no fallback
/// to any default address).
#[tokio::test]
async fn unset_node_domain_refuses_tokens() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    sqlx::query("UPDATE panel_settings SET node_domain = NULL")
        .execute(&db.pool)
        .await
        .unwrap();
    let st = AppState::for_test(db.pool.clone()).await;
    reload(&st).await.unwrap();
    let admin = admin_client(&st, &db).await;
    let r = admin
        .post("/test/api/v1/nodes", json!({"name": "no-endpoint"}))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "settings.node_domain_unset");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM nodes")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "nothing created");
    let v = admin.get("/test/api/v1/settings").await.json();
    assert_eq!(v["node"]["source"], "unset");
    assert_eq!(v["node"]["panel_addr"], Value::Null);
    assert_eq!(v["node"]["default_port"], 8443);
    db.drop().await;
}

/// 节点通信 and 安全: validated, versioned (409), audited, effective at
/// once (2FA policy on the next request; remove mode in the next lease;
/// an extra release key is trusted for uploads).
#[tokio::test]
async fn node_ops_and_security_api() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    let admin = admin_client(&st, &db).await;
    let put = |path: &'static str, body: Value| {
        let admin = &admin;
        async move {
            admin
                .req(
                    axum::http::Method::PUT,
                    &format!("/test/api/v1/settings/{path}"),
                    Some(body),
                )
                .await
        }
    };
    let v0 = admin.get("/test/api/v1/settings").await.json();
    assert_eq!(v0["node_ops"]["remove_mode"]["effective"], "gate");
    assert_eq!(v0["security"]["audit_retention_days"]["default"], 365);
    assert_eq!(v0["security"]["release_keys"][0]["official"], true);
    assert_eq!(v0["obsolete_config_keys"], json!([]));
    let version = v0["version"].as_i64().unwrap();

    for (body, code) in [
        (
            json!({"version": version, "install_tls_pin": "sha256//nope"}),
            "settings.tls_pin_invalid",
        ),
        (
            json!({"version": version, "install_fallback_url": "http://x/{arch}"}),
            "settings.fallback_url_invalid",
        ),
        (
            json!({"version": version, "acme_directory_url": "http://ca/dir"}),
            "settings.acme_url_invalid",
        ),
        (
            json!({"version": version, "acme_email": "nope"}),
            "settings.acme_email_invalid",
        ),
    ] {
        let r = put("nodes", body).await;
        assert_eq!(
            (r.status, r.json()["code"].clone()),
            (StatusCode::BAD_REQUEST, json!(code))
        );
    }
    assert_eq!(
        put(
            "nodes",
            json!({"version": version, "remove_mode": "sometimes"})
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    let r = put(
        "nodes",
        json!({"version": version, "install_fallback_disabled": true,
               "acme_directory_url": " https://ca.example/dir ", "acme_email": "ops@example.com",
               "remove_mode": "rebuild"}),
    )
    .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let v = r.json();
    assert_eq!(v["node_ops"]["install_fallback_url"], "");
    assert_eq!(v["node_ops"]["install_fallback_effective"], Value::Null);
    assert_eq!(
        v["node_ops"]["acme_directory_url"],
        "https://ca.example/dir"
    );
    assert_eq!(v["node_ops"]["remove_mode"]["source"], "settings");
    assert_eq!(st.settings().get().remove_mode, RemoveMode::Rebuild);
    assert_eq!(
        put("nodes", json!({"version": version})).await.json()["code"],
        "settings.version_conflict"
    );
    let rows = audit_rows(&db, "settings.nodes.update").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1.as_ref().unwrap()["remove_mode"], "rebuild");
    let version = v["version"].as_i64().unwrap();

    for (body, code) in [
        (
            json!({"version": version, "audit_retention_days": 40000}),
            "settings.audit_retention_invalid",
        ),
        (
            json!({"version": version, "traffic_daily_retention_days": 10}),
            "settings.traffic_retention_invalid",
        ),
        (
            json!({"version": version, "cloudflare_ranges": ["1.2.3.4/40"]}),
            "settings.cloudflare_range_invalid",
        ),
        (
            json!({"version": version, "extra_release_keys": ["not-a-key"]}),
            "settings.release_key_invalid",
        ),
        (
            json!({"version": version, "extra_release_keys": vec!["x"; 17]}),
            "settings.release_keys_too_many",
        ),
        (
            json!({"version": version, "cloudflare_ranges": vec!["10.0.0.0/8"; 257]}),
            "settings.cloudflare_ranges_too_many",
        ),
    ] {
        let r = put("security", body).await;
        assert_eq!(
            (r.status, r.json()["code"].clone()),
            (StatusCode::BAD_REQUEST, json!(code))
        );
    }
    let signer = crate::updates::testkit::Signer::new().config_line();
    let r = put(
        "security",
        json!({"version": version, "require_admin_2fa": true, "audit_retention_days": 0,
               "traffic_daily_retention_days": 0, "cloudflare_ranges": ["198.51.100.0/24", " 2001:db8::/32 "],
               "extra_release_keys": [signer]}),
    )
    .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let v = r.json();
    assert_eq!(v["security"]["require_admin_2fa"]["effective"], true);
    assert_eq!(v["security"]["audit_retention_days"]["effective"], 0);
    assert_eq!(
        v["security"]["cloudflare_ranges"],
        json!(["198.51.100.0/24", "2001:db8::/32"])
    );
    assert_eq!(v["cloudflare_ranges"], 2);
    assert_eq!(v["security"]["release_keys"].as_array().unwrap().len(), 2);
    let e = st.settings().get();
    assert!(e.require_admin_2fa && e.audit_retention_days == 0);
    assert_eq!(e.traffic_daily_retention_days, 0);
    // The Cloudflare list is audited by size, never verbatim.
    let rows = audit_rows(&db, "settings.security.update").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1.as_ref().unwrap()["cloudflare_ranges"], 2);
    // Back to defaults.
    let version = v["version"].as_i64().unwrap();
    let r = put(
        "security",
        json!({"version": version, "require_admin_2fa": false, "audit_retention_days": 365,
               "cloudflare_ranges": [], "extra_release_keys": null}),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    let s = st.settings().get().stored.clone();
    assert_eq!(
        (
            s.require_admin_2fa,
            s.audit_retention_days,
            s.cloudflare_ranges,
            s.extra_release_keys
        ),
        (None, None, None, None),
        "defaults are stored as NULL"
    );
    db.drop().await;
}
