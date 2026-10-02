use std::net::IpAddr;
use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::testdb::fake_agent::PanelHarness;
use crate::testdb::http::{rand_ip, Client};
use crate::testdb::TestDb;

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

#[test]
fn precedence_settings_over_config() {
    let mut c = cfg();
    // Nothing configured: browser origin, node from grpc.*.
    let e = compute(&c, Stored::default(), vec![], &[]);
    assert_eq!((e.main.is_none(), e.main_source), (true, Source::Browser));
    assert_eq!((e.sub.is_none(), e.sub_source), (true, Source::Browser));
    assert_eq!(e.node.panel_addr, "127.0.0.1:8443");
    assert_eq!(e.node.server_name, "localhost");
    assert_eq!(e.node_source, Source::Config);
    assert!(!e.trust_cloudflare && e.trust_source == Source::Config);
    assert!(!e.host_gate_on());
    assert_eq!(e.sub_url("p", "t"), None);

    // panel.toml values.
    c.install.public_url = "https://panel.example.com".into();
    c.web.trust_cloudflare = true;
    let e = compute(&c, Stored::default(), vec![], &[]);
    assert_eq!(
        e.install_origin().as_deref(),
        Some("https://panel.example.com")
    );
    assert_eq!(e.main_source, Source::Config);
    assert_eq!(e.sub_source, Source::Main, "sub follows main");
    assert_eq!(
        e.sub_url("p", "t").as_deref(),
        Some("https://panel.example.com/p/sub/t")
    );
    assert!(e.trust_cloudflare);
    assert!(!e.host_gate_on(), "config alone never turns the gate on");
    c.web.sub_domain = "s.example.com".into();
    let e = compute(&c, Stored::default(), vec![], &[]);
    assert_eq!(e.sub_source, Source::Config);

    // Database wins.
    let mut s = stored(
        Some("m.example.org:8443"),
        Some("sub.example.org"),
        Some("node.example.org"),
    );
    s.trust_cloudflare = Some(false);
    let e = compute(&c, s, vec![], &[]);
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
    // Node domain without a port: grpc.advertise's port.
    assert_eq!(e.node.panel_addr, "node.example.org:8443");
    assert_eq!(e.node.server_name, "node.example.org");
    assert!(!e.trust_cloudflare && e.trust_source == Source::Settings);
    assert!(e.trust.cloudflare.is_empty());

    let e = compute(
        &c,
        stored(None, None, Some("[2001:db8::7]:9443")),
        vec![],
        &[],
    );
    assert_eq!(e.node.panel_addr, "[2001:db8::7]:9443");
    assert_eq!(e.node.server_name, "2001:db8::7");
}

#[test]
fn host_gate_and_ask() {
    let mut c = cfg();
    c.install.public_url = "https://old.example.com".into();
    let e = compute(
        &c,
        stored(Some("panel.example.com"), Some("sub.example.net"), None),
        vec![],
        &[],
    );
    assert!(e.host_gate_on());
    for ok in [
        "panel.example.com",
        "sub.example.net",
        "old.example.com", // panel.toml's public_url stays reachable
        "203.0.113.7",
        "2001:db8::1",
        "127.0.0.1",
    ] {
        assert!(e.host_allowed(Some(ok)), "{ok}");
    }
    for no in [
        "evil.example.com",
        "example.com",
        "localhost",
        "x.panel.example.com",
    ] {
        assert!(!e.host_allowed(Some(no)), "{no}");
    }
    assert!(!e.host_allowed(None), "no Host at all");

    assert!(e.ask_allowed("panel.example.com"));
    assert!(e.ask_allowed("SUB.example.net."));
    assert!(
        !e.ask_allowed("old.example.com"),
        "not configured in settings"
    );
    assert!(!e.ask_allowed("evil.example.com"));
    assert!(!e.ask_allowed(""));
    // IP main domain: never an ask host.
    let e = compute(&c, stored(Some("203.0.113.7"), None, None), vec![], &[]);
    assert!(!e.ask_allowed("203.0.113.7"));
}

/// R22 × payments: an explicit notify URL host stays reachable (host gate,
/// Caddy ask) and is flagged when it is not the main domain; an empty one
/// needs a main domain.
#[test]
fn payment_notify_host() {
    let mut c = cfg();
    c.payments.alipay.enabled = true;
    c.payments.alipay.notify_url = "https://pay.example.org/abc/pay/alipay/notify".into();
    let e = compute(
        &c,
        stored(Some("panel.example.com"), None, None),
        vec![],
        &[],
    );
    assert!(e.host_allowed(Some("pay.example.org")));
    assert!(e.ask_allowed("pay.example.org"));
    let w = e.standing_warnings(&c);
    assert_eq!(w.len(), 1, "{w:?}");
    assert!(w[0].contains("pay.example.org") && w[0].contains("panel.example.com"));
    assert!(!w[0].contains("/abc/"), "never the prefixed URL: {w:?}");
    let same = compute(&c, stored(Some("pay.example.org"), None, None), vec![], &[]);
    assert!(same.standing_warnings(&c).is_empty());
    // Payments off: the notify host is nobody's business.
    c.payments.alipay.enabled = false;
    let off = compute(
        &c,
        stored(Some("panel.example.com"), None, None),
        vec![],
        &[],
    );
    assert!(!off.host_allowed(Some("pay.example.org")) && !off.ask_allowed("pay.example.org"));
    assert!(off.standing_warnings(&c).is_empty());
    // Derived notify URL without any main domain: warned.
    c.payments.alipay.enabled = true;
    c.payments.alipay.notify_url = String::new();
    let none = compute(&c, Stored::default(), vec![], &[]);
    assert_eq!(none.standing_warnings(&c).len(), 1);
    assert_eq!(none.public_origin(), None);
    let set = compute(
        &c,
        stored(Some("panel.example.com"), None, None),
        vec![],
        &[],
    );
    assert!(set.standing_warnings(&c).is_empty());
    assert_eq!(
        set.public_origin().as_deref(),
        Some("https://panel.example.com")
    );
}

/// The certificate names are a superset of config + history + current
/// node name, for any sequence of saves: changing the node domain never
/// drops a name (only apply_remove_server_name deletes history rows).
#[test]
fn sans_never_shrink() {
    let mut c = cfg();
    c.web.advertised_names = vec!["localhost".into(), "127.0.0.1".into()];
    let mut history: Vec<ServerName> = vec![name("localhost")];
    let mut prev: Vec<String> = sans(&c, &history, "localhost");
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
        let e = compute(&c, stored(None, None, Some(d)), history.clone(), &[]);
        assert_eq!(e.node.server_name, host);
        for p in &prev {
            assert!(e.sans.contains(p), "step {i}: {p} dropped");
        }
        for n in &history {
            assert!(e.sans.contains(&n.name));
        }
        assert!(e.sans.contains(&"127.0.0.1".to_string()));
        // Unsetting the node domain (back to panel.toml) keeps them too.
        let back = compute(&c, Stored::default(), history.clone(), &[]);
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
    assert!(apply_update(&mut tx, &Actor::test(), 7, &Values::default())
        .await
        .is_err());
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
    assert_eq!(v["node"]["source"], "config");
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
        assert_eq!(
            r.status,
            StatusCode::BAD_REQUEST,
            "{locked} comes from panel.toml"
        );
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
    // An enrolled agent from before (server name "localhost").
    let old_node = db.node().await;
    let mut tx = db.pool.begin().await.unwrap();
    let ep = node_endpoint(&mut tx, st.cfg()).await.unwrap();
    assert_eq!(ep.server_name, "localhost");
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
    assert_eq!(sn.as_deref(), Some("localhost"), "recorded at enrollment");

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
    assert!(st
        .settings()
        .certs()
        .names()
        .contains(&"grpc.akari.test".to_string()));

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
    assert!(panel
        .connect_named(&new_creds, "grpc.akari.test")
        .await
        .is_ok());
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
    assert!(panel
        .connect_named(&new_creds, "grpc.akari.test")
        .await
        .is_ok());
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
    let state = AppState::for_test_with(db.pool.clone(), |c| c.tls_ask.rate_per_sec = 4).await;
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
    let e = compute(&c, Stored::default(), vec![], &[]);
    assert_eq!(e.probe.interval_secs, 18_000);
    assert_eq!(e.probe.urls, c.probe.urls);
    assert!(e.probe.panel_tcp);
    assert_eq!(
        e.probe_sources,
        ProbeSources {
            interval_secs: Source::Config,
            urls: Source::Config,
            panel_tcp: Source::Config
        }
    );
    let s = Stored {
        probe_interval_secs: Some(900),
        probe_urls: Some(vec!["http://probe.example/204".into()]),
        probe_panel_tcp: Some(false),
        ..Stored::default()
    };
    let e = compute(&c, s, vec![], &[]);
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
    let e = compute(&c, s, vec![], &[]);
    assert_eq!(e.probe.interval_secs, 18_000);
    assert_eq!(e.probe.urls, c.probe.urls);
    assert_eq!(e.probe_sources.interval_secs, Source::Config);
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
    assert_eq!(v["probe"]["interval_secs"]["source"], "config");
    assert_eq!(v["probe"]["urls"]["value"], Value::Null);
    assert_eq!(v["probe"]["panel_tcp"]["config"], true);

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
    // Unset: panel.toml again.
    let r = put(json!({"version": 2, "interval_secs": null, "urls": [], "panel_tcp": null})).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["probe"]["interval_secs"]["source"], "config");
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
