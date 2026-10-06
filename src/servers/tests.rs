use super::*;

fn caps(c: &[&str]) -> Vec<String> {
    c.iter().map(|s| s.to_string()).collect()
}

/// M1-8: a certificate within 14 days of expiry (or expired) is flagged,
/// with the likely cause by agent protocol.
#[test]
fn cert_expiry_warning() {
    let now = Utc::now();
    let d = chrono::Duration::days;
    assert_eq!(cert_warning(None, Some(2), now), None, "unknown expiry");
    assert_eq!(cert_warning(Some(now + d(15)), Some(1), now), None);
    let w = cert_warning(Some(now + d(10)), Some(1), now).unwrap();
    assert!(
        w.contains("将在 9 天后") || w.contains("将在 10 天后"),
        "{w}"
    );
    assert!(w.contains("不能续期"), "{w}");
    let w = cert_warning(Some(now + d(3)), Some(2), now).unwrap();
    assert!(w.contains("没有按时续期"), "{w}");
    let w = cert_warning(Some(now - d(1)), None, now).unwrap();
    assert!(w.contains("已于") && w.contains("过期"), "{w}");
}

fn tls(sni: &str) -> Value {
    json!({"streamSettings": {"security": "tls", "tlsSettings": {
        "serverName": sni,
        "certificates": [{"certificateFile": crate::nodetpl::TLS_CERT_FILE,
            "keyFile": crate::nodetpl::TLS_KEY_FILE}]}}})
}

/// W10: an old agent or an inbound naming another SNI keeps the automatic
/// certificate from working; said on the server (over all its nodes).
#[test]
fn tls_domain_warnings_flag_old_agents_and_other_names() {
    let d = Some("n1.example.com");
    let one = |ib: Value| json!([ib]);
    assert!(tls_domain_warnings(None, &one(tls("x.example.com")), Some(5)).is_empty());
    assert!(tls_domain_warnings(d, &one(tls("n1.example.com")), Some(6)).is_empty());
    assert!(
        tls_domain_warnings(d, &one(tls("N1.example.com")), None).is_empty(),
        "not connected yet"
    );
    assert!(
        tls_domain_warnings(d, &json!([]), Some(1)).is_empty(),
        "no certificate needed"
    );
    let w = tls_domain_warnings(d, &one(tls("n1.example.com")), Some(5));
    assert!(w.len() == 1 && w[0].contains("版本过旧"), "{w:?}");
    let w = tls_domain_warnings(d, &one(tls("other.example.com")), Some(6));
    assert!(w.len() == 1 && w[0].contains("other.example.com"), "{w:?}");
    // Q1: every node's inbound counts.
    let w = tls_domain_warnings(
        d,
        &json!([tls("n1.example.com"), tls("b.example.com")]),
        Some(6),
    );
    assert!(w.len() == 1 && w[0].contains("b.example.com"), "{w:?}");
}

/// W18: a certificate the agent must obtain itself is refused for agents
/// of protocol 1..6 (they would fail the whole snapshot); not connected yet
/// (None) and protocol-0 agents (served the empty state) pass, as does a
/// server without a TLS domain (certificates by hand).
#[test]
fn acme_inbounds_need_an_acme_agent() {
    let t = json!([tls("n1.example.com")]);
    let d = Some("n1.example.com");
    assert_eq!(acme_needs_newer_agent(d, &t, Some(5)), Some(5));
    assert_eq!(acme_needs_newer_agent(d, &t, Some(1)), Some(1));
    assert_eq!(acme_needs_newer_agent(d, &t, Some(6)), None);
    assert_eq!(acme_needs_newer_agent(d, &t, None), None);
    assert_eq!(acme_needs_newer_agent(d, &t, Some(0)), None);
    assert_eq!(acme_needs_newer_agent(None, &t, Some(5)), None);
    assert_eq!(acme_needs_newer_agent(d, &json!([]), Some(5)), None);
}

/// W18: self-updatable agents without the "updater" capability fail on
/// systemd >= 256 (noexec state directory): told on the server.
#[test]
fn updater_warning_for_pre_updater_agents() {
    let w = updater_warning(Some(6), Some(&caps(&["metrics", "latency"]))).unwrap();
    assert!(
        w.contains("重装命令") && w.contains("akari-agent-update"),
        "{w}"
    );
    assert!(
        updater_warning(Some(3), None).is_some(),
        "protocol 3, no capabilities"
    );
    assert!(updater_warning(Some(6), Some(&caps(&["metrics", "updater"]))).is_none());
    assert!(
        updater_warning(Some(2), None).is_none(),
        "never offered updates"
    );
    assert!(updater_warning(None, None).is_none(), "not connected yet");
}

/// W23: the agent says the server's systemd units are not its own.
#[test]
fn stale_units_warning_names_the_reinstall() {
    let w = stale_units_warning(Some(&caps(&["metrics", "stale-units"]))).unwrap();
    assert!(w.contains("重装命令") && w.contains("drop-in"), "{w}");
    assert!(stale_units_warning(Some(&caps(&["metrics", "updater"]))).is_none());
    assert!(stale_units_warning(None).is_none());
    let all = WarnFacts {
        agent_protocol: Some(6),
        agent_capabilities: Some(caps(&["updater", "stale-units"])),
        inbounds: json!([]),
        ..Default::default()
    }
    .warnings();
    assert_eq!(all.len(), 1, "{all:?}");
}

/// W28-a / Q1: relay entrances on an agent without source filtering, and
/// several entrances on an agent without the per-account limits of
/// protocol 7, are flagged; a filter the agent could not install is
/// reported from its heartbeat.
#[test]
fn entrance_and_source_filter_warnings() {
    let w = entrance_warnings(1, 2, Some(6), Some(&caps(&["metrics"])));
    assert_eq!(w.len(), 2, "{w:?}");
    assert!(
        w[0].contains("来源 IP 过滤") && w[1].contains("协议 < 7"),
        "{w:?}"
    );
    assert!(entrance_warnings(1, 2, Some(7), Some(&caps(&["source-filter"]))).is_empty());
    assert!(
        entrance_warnings(0, 1, Some(1), None).is_empty(),
        "one direct entrance"
    );
    let w = entrance_warnings(0, 2, Some(6), None);
    assert!(
        w.len() == 1 && w[0].contains("协议 < 7"),
        "two nodes' direct entrances: {w:?}"
    );
    assert!(
        entrance_warnings(1, 2, None, None).is_empty(),
        "never connected"
    );
    let w = source_filter_warning(
        r#"{"ts":"x","source_filter":{"applied":false,"error":"nft: permission denied"}}"#,
    )
    .unwrap();
    assert!(w.contains("nft: permission denied"), "{w}");
    assert!(source_filter_warning(r#"{"source_filter":{"applied":true,"error":null}}"#).is_none());
    assert!(source_filter_warning(r#"{"ts":"x"}"#).is_none());
    assert!(
        source_filter_warning(
            r#"{"source_filter":{"applied":false,"error":"pending: waiting for the root updater"}}"#
        )
        .is_none()
    );
    assert!(source_filter_warning("not json").is_none());
}

// ---------------------------------------------------------------------------
// Real database: several nodes on one server (distinct ids throughout)
// ---------------------------------------------------------------------------

use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for};
use axum::http::{Method, StatusCode};

fn vless(port: u16) -> Value {
    json!({"protocol": "vless", "port": port,
           "settings": {"clients": [], "decryption": "none"}})
}

async fn admin(db: &TestDb) -> (AppState, Client) {
    let state = AppState::for_test(db.pool.clone()).await;
    let c = client_for(&state, db.admin().await).await;
    (state, c)
}

fn id_of(v: &Value, key: &str) -> Uuid {
    v[key].as_str().unwrap().parse().unwrap()
}

/// The direct entrance of a node, and its number on the server.
async fn direct(db: &TestDb, node: Uuid) -> (Uuid, i32) {
    sqlx::query_as("SELECT id, wire_no FROM entrances WHERE node_id = $1 AND kind = 'direct'")
        .bind(node)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

/// A plan granting `entrances` (one group), assigned to `user`.
async fn grant(c: &Client, user: Uuid, entrances: &[Uuid]) {
    let g = c
        .post(
            "/test/api/v1/node-groups",
            json!({"name": format!("g-{}", Uuid::new_v4().simple()), "entrance_ids": entrances}),
        )
        .await
        .json()["id"]
        .clone();
    let p = c
        .post(
            "/test/api/v1/plans",
            json!({"name": format!("p-{}", Uuid::new_v4().simple()), "period": "monthly",
                   "group_ids": [g]}),
        )
        .await
        .json()["id"]
        .clone();
    let r = c
        .put(
            &format!("/test/api/v1/users/{user}/plan"),
            json!({"plan_id": p, "period": "month"}),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
}

/// Q1 end to end through the admin API: one server, two nodes; the agent's
/// desired state is both nodes' inbounds with per-node entrance numbers
/// and traffic keys; ports clash across nodes; node switches and deletion
/// bump the server; the grouped list; server deletion empties the state.
#[tokio::test]
async fn two_nodes_on_one_server_share_one_agent() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (_state, c) = admin(&db).await;
    let r = c.post("/test/api/v1/servers", json!({"name": "hk"})).await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let sid = id_of(&r.json(), "id");
    assert!(
        r.json()["bootstrap"]
            .as_str()
            .unwrap()
            .contains("enrollment_token")
    );
    assert_eq!(
        c.post("/test/api/v1/servers", json!({"name": "hk"}))
            .await
            .json()["code"],
        "server.name_exists"
    );
    let node = |name: &'static str, port: u16| {
        let c = &c;
        async move {
            c.post(
                "/test/api/v1/nodes",
                json!({"server_id": sid, "name": name, "inbound": vless(port)}),
            )
            .await
        }
    };
    let r = node("hk-a", 443).await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    assert!(
        r.json().get("enrollment_token").is_none(),
        "existing server"
    );
    let a = id_of(&r.json(), "id");
    assert_eq!(id_of(&r.json(), "server_id"), sid);
    // The second node's port must not clash with the first's.
    let r = node("hk-b", 443).await;
    assert_eq!(r.json()["code"], "entrance.port_clash");
    let b = id_of(&node("hk-b", 8443).await.json(), "id");
    // Server-only fields belong to the server.
    assert_eq!(
        c.post(
            "/test/api/v1/nodes",
            json!({"server_id": sid, "name": "x", "tls_domain": "x.example.com"})
        )
        .await
        .json()["code"],
        "node.server_fields"
    );
    let ((ea, wa), (eb, wb)) = (direct(&db, a).await, direct(&db, b).await);
    assert_eq!((wa, wb), (0, 1), "numbered per server");

    let u = db.user().await;
    let before = db.versions(sid).await;
    grant(&c, u, &[ea, eb]).await;
    assert!(
        db.versions(sid).await.1 > before.1,
        "the grant bumps the server"
    );
    let snap = crate::grpc::desired_snapshot(&db.pool, sid)
        .await
        .unwrap()
        .unwrap();
    let inbounds: Value = serde_json::from_str(&snap.inbounds_json).unwrap();
    let tags: Vec<(&str, u64)> = inbounds
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (i["tag"].as_str().unwrap(), i["port"].as_u64().unwrap()))
        .collect();
    assert_eq!(tags, [("direct", 443), ("e1", 8443)]);
    let keys: Vec<(String, String)> = snap
        .users
        .iter()
        .map(|o| (o.user_id.clone(), o.inbound_users[0].inbound_tag.clone()))
        .collect();
    assert_eq!(
        keys,
        [
            (u.to_string(), "direct".to_string()),
            (format!("{u}#1"), "e1".to_string())
        ]
    );

    // Disabling one node: only the other's inbound, a config bump.
    let v0 = db.versions(sid).await;
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/nodes/{b}"),
            Some(json!({"enabled": false})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["server_id"], sid.to_string());
    assert!(db.versions(sid).await.0 > v0.0);
    let snap = crate::grpc::desired_snapshot(&db.pool, sid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snap.users.len(), 1);

    // The grouped list.
    let list = c.get("/test/api/v1/servers").await.json();
    let s = &list[0];
    assert_eq!(s["id"], sid.to_string());
    assert_eq!(s["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(s["nodes"][0]["entrances"][0]["kind"], "direct");
    assert_eq!(s["nodes"][1]["port"], 8443);
    assert_eq!(
        c.get(&format!("/test/api/v1/servers/{sid}")).await.json()["name"],
        "hk"
    );

    // Deleting a node keeps the server and its other node.
    let v1 = db.versions(sid).await;
    let r = c
        .req(Method::DELETE, &format!("/test/api/v1/nodes/{b}"), None)
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(db.versions(sid).await.0 > v1.0);
    let left: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM nodes WHERE server_id = $1")
        .bind(sid)
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(left, [a]);
    // A new node never reuses the deleted one's number.
    let c2 = id_of(&node("hk-c", 9443).await.json(), "id");
    assert_eq!(direct(&db, c2).await.1, 2);

    // Server fields.
    let v2 = db.versions(sid).await;
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/servers/{sid}"),
            Some(json!({"name": "hk-2", "tls_domain": "HK.Example.com"})),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    assert_eq!(r.json()["tls_domain"], "hk.example.com");
    assert_eq!(db.versions(sid).await.0, v2.0 + 1, "the domain bumps");
    assert_eq!(
        c.req(
            Method::PATCH,
            &format!("/test/api/v1/servers/{sid}"),
            Some(json!({"name": "hk-2"}))
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(db.versions(sid).await.0, v2.0 + 1, "a rename does not");
    let r = c
        .post(
            &format!("/test/api/v1/servers/{sid}/enroll-token"),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["name"], "hk-2");

    // Deleting the server: the empty state, mutations refused.
    let r = c
        .req(Method::DELETE, &format!("/test/api/v1/servers/{sid}"), None)
        .await;
    assert_eq!(r.status, StatusCode::ACCEPTED);
    let snap = crate::grpc::desired_snapshot(&db.pool, sid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((snap.inbounds_json.as_str(), snap.users.len()), ("[]", 0));
    assert_eq!(
        c.req(
            Method::PATCH,
            &format!("/test/api/v1/nodes/{a}"),
            Some(json!({"sort": 3}))
        )
        .await
        .json()["code"],
        "server.deleting"
    );
    db.drop().await;
}

/// Traffic of two nodes reported by their one agent: admitted for the
/// server's entrances only, billed per entrance, totals per node, history
/// per node; another server cannot bill them.
#[tokio::test]
async fn one_agent_bills_each_of_its_nodes() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let s = db.server().await;
    let (a, b) = (db.node_on(s, 1001).await, db.node_on(s, 1002).await);
    let u = db.user().await;
    let (ea, wa) = direct(&db, a).await;
    let (eb, wb) = direct(&db, b).await;
    for e in [ea, eb] {
        sqlx::query(
            "INSERT INTO entrance_users (entrance_id, user_id, protocol, account) \
             VALUES ($1, $2, 'vless', '{\"id\":\"x\"}')",
        )
        .bind(e)
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    }
    let buf = crate::traffic::TrafficBuffer::new();
    crate::traffic::refresh_members(&db.pool, &buf, s)
        .await
        .unwrap();
    let report = |rows: &[(String, u64)]| crate::pb::TrafficReport {
        users: rows
            .iter()
            .map(|(k, up)| crate::pb::UserTraffic {
                user_id: k.clone(),
                up_bytes: *up,
                down_bytes: 0,
            })
            .collect(),
        ..Default::default()
    };
    let key = |w: i32| crate::grpc::stat_key(u, w);
    buf.update(s, "s1", &report(&[(key(wa), 1000), (key(wb), 3000)]));
    // Another agent claiming the same keys has no members for them.
    let other = db.server().await;
    crate::traffic::refresh_members(&db.pool, &buf, other)
        .await
        .unwrap();
    buf.update(other, "s1", &report(&[(key(wa), 50_000)]));
    crate::traffic::flush_for_test(&db.pool, &buf).await;
    assert_eq!(db.used(u).await, 4000);
    let totals: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT id, traffic_raw_bytes FROM nodes WHERE server_id = $1 ORDER BY traffic_raw_bytes",
    )
    .bind(s)
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(totals, [(a, 1000), (b, 3000)]);
    let staged: Vec<(Uuid, Uuid, i64)> = sqlx::query_as(
        "SELECT node_id, entrance_id, up_bytes FROM traffic_daily_pending ORDER BY up_bytes",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(staged, [(a, ea, 1000), (b, eb, 3000)]);
    let counters: Vec<Uuid> = sqlx::query_scalar("SELECT DISTINCT server_id FROM traffic_counters")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(counters, [s], "the baseline belongs to the agent");
    db.drop().await;
}

/// W29 over several nodes: the server's policy lists the inbound of every
/// node with the switch on (as the agent names it), none when its server
/// is being deleted.
#[tokio::test]
async fn block_policy_covers_the_nodes_with_the_switch() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let s = db.server().await;
    let (a, b) = (db.node_on(s, 1001).await, db.node_on(s, 1002).await);
    let policy = || async {
        crate::blockrules::server_policy(&db.pool, s)
            .await
            .unwrap()
            .unwrap()
            .inbound_tags
    };
    assert!(policy().await.is_empty(), "default off");
    sqlx::query("UPDATE nodes SET block_rules_enabled = true WHERE id = ANY($1)")
        .bind([a, b])
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(policy().await, ["direct", "e1"]);
    sqlx::query("UPDATE nodes SET enabled = false WHERE id = $1")
        .bind(a)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(policy().await, ["e1"]);
    sqlx::query("UPDATE servers SET deleting_at = now() WHERE id = $1")
        .bind(s)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(policy().await.is_empty());
    db.drop().await;
}

/// (rx, tx, exceeded) of a server's quota period.
async fn quota_state(db: &TestDb, s: Uuid) -> (i64, i64, bool) {
    sqlx::query_as(
        "SELECT traffic_quota_rx_bytes, traffic_quota_tx_bytes, \
         traffic_quota_exceeded_at IS NOT NULL FROM servers WHERE id = $1",
    )
    .bind(s)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

async fn nic(db: &TestDb, s: Uuid, name: &str, rx: i64, tx: i64) {
    crate::nodestat::write_nic(
        &db.pool,
        s,
        &crate::nodestat::Nic {
            name: name.into(),
            rx,
            tx,
        },
    )
    .await
    .unwrap();
}

/// Inbound tags the agent of `s` is told to run.
async fn served_tags(db: &TestDb, s: Uuid) -> usize {
    let snap = crate::grpc::desired_snapshot(&db.pool, s)
        .await
        .unwrap()
        .unwrap();
    serde_json::from_str::<Value>(&snap.inbounds_json)
        .unwrap()
        .as_array()
        .map_or(0, Vec::len)
}

/// D5: the interface counters become the period's usage: a first sample
/// and a new interface only set the baseline, a reboot counts from 0, an
/// implausible step is capped (only ever under-counts).
#[tokio::test]
async fn nic_counters_accumulate_from_deltas() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let s = db.server().await;
    nic(&db, s, "eth0", 1_000_000, 5_000_000).await;
    assert_eq!(
        quota_state(&db, s).await,
        (0, 0, false),
        "first sample = baseline"
    );
    nic(&db, s, "eth0", 1_300_000, 5_100_000).await;
    assert_eq!(quota_state(&db, s).await, (300_000, 100_000, false));
    // Reboot: the counters restart from 0.
    nic(&db, s, "eth0", 40_000, 70_000).await;
    assert_eq!(quota_state(&db, s).await, (340_000, 170_000, false));
    // Another interface: new baseline, nothing counted.
    nic(&db, s, "ens3", 9_000_000, 9_000_000).await;
    assert_eq!(quota_state(&db, s).await, (340_000, 170_000, false));
    // A step beyond 100 Gbit/s since the last sample is capped.
    sqlx::query("UPDATE servers SET nic_at = now() - interval '2 seconds' WHERE id = $1")
        .bind(s)
        .execute(&db.pool)
        .await
        .unwrap();
    nic(&db, s, "ens3", 9_000_000 + 10_i64.pow(15), 9_000_000).await;
    let (rx, _, _) = quota_state(&db, s).await;
    assert!(
        (340_000 + 25_000_000_000..340_000 + 26_000_000_000).contains(&rx),
        "{rx}"
    );
    db.drop().await;
}

/// D5 end to end: the quota runs out on a heartbeat → every node of the
/// server gets the empty state (an admin-disabled node stays disabled),
/// an alert fires; raising the quota restores; the period reset restores
/// and is audited; a lowered quota stops at once. Every flip bumps.
#[tokio::test]
async fn quota_stops_and_restores_the_server() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (state, c) = admin(&db).await;
    let s = db.server().await;
    let (a, b) = (db.node_on(s, 1001).await, db.node_on(s, 1002).await);
    sqlx::query("UPDATE nodes SET enabled = false WHERE id = $1")
        .bind(b)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(served_tags(&db, s).await, 1);

    // Validation.
    for (body, code) in [
        (json!({"traffic_quota_bytes": 0}), "server.quota_invalid"),
        (
            json!({"traffic_quota_mode": "sideways"}),
            "server.quota_mode_invalid",
        ),
        (
            json!({"traffic_quota_reset_day": 32}),
            "server.reset_day_invalid",
        ),
    ] {
        let r = c
            .req(
                Method::PATCH,
                &format!("/test/api/v1/servers/{s}"),
                Some(body),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        assert_eq!(r.json()["code"], code);
    }
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/servers/{s}"),
            Some(
                json!({"traffic_quota_bytes": 1_000_000, "traffic_quota_mode": "up",
                        "traffic_quota_reset_day": 1}),
            ),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let v = r.json();
    assert_eq!(v["traffic_quota"]["bytes"], 1_000_000);
    assert_eq!(v["traffic_quota"]["mode"], "up");
    assert!(v["traffic_quota"]["next_reset_at"].is_string());

    // Up = tx only: lots of rx does not count.
    let v0 = db.versions(s).await.0;
    nic(&db, s, "eth0", 0, 0).await;
    nic(&db, s, "eth0", 50_000_000, 999_999).await;
    assert!(!quota_state(&db, s).await.2);
    assert_eq!(db.versions(s).await.0, v0, "no flip, no bump");
    nic(&db, s, "eth0", 50_000_000, 1_000_000).await;
    assert!(quota_state(&db, s).await.2);
    assert_eq!(db.versions(s).await.0, v0 + 1, "stopping bumps");
    assert_eq!(served_tags(&db, s).await, 0, "the empty state");
    let enabled: Vec<bool> =
        sqlx::query_scalar("SELECT enabled FROM nodes WHERE server_id = $1 ORDER BY id = $2 DESC")
            .bind(s)
            .bind(a)
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(enabled, vec![true, false], "nodes untouched");
    let r = c.get(&format!("/test/api/v1/servers/{s}")).await.json();
    assert!(r["traffic_quota"]["exceeded_at"].is_string());
    assert!(
        r["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("流量额度已用完")),
        "{}",
        r["warnings"]
    );
    assert_eq!(r["traffic_quota"]["used_bytes"], 1_000_000);
    // The alert.
    let mut conn = db.pool.acquire().await.unwrap();
    let settings = crate::alerts::load(&mut conn).await.unwrap();
    let monitored = crate::alerts::eval::gather(&state, &mut conn, &settings)
        .await
        .unwrap();
    drop(conn);
    // A pending server (no certificate) is not monitored: enroll it.
    assert!(monitored.iter().all(|m| m.id != s));
    sqlx::query("UPDATE servers SET cert_serial = 'ab' WHERE id = $1")
        .bind(s)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut conn = db.pool.acquire().await.unwrap();
    let monitored = crate::alerts::eval::gather(&state, &mut conn, &settings)
        .await
        .unwrap();
    drop(conn);
    let m = monitored.iter().find(|m| m.id == s).unwrap();
    let verdict = crate::alerts::eval::evaluate(&m.facts, &m.rules, chrono::Utc::now());
    assert!(verdict.firing.iter().any(|o| o.kind == "traffic_quota"));

    // Raising the quota restores (the disabled node stays off).
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/servers/{s}"),
            Some(json!({"traffic_quota_bytes": 2_000_000})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(!quota_state(&db, s).await.2);
    assert_eq!(db.versions(s).await.0, v0 + 2);
    assert_eq!(served_tags(&db, s).await, 1);

    // Lowering it below the usage stops at once; the mode switch to both
    // counts the rx as well.
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/servers/{s}"),
            Some(json!({"traffic_quota_mode": "both"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(quota_state(&db, s).await.2);
    assert_eq!(db.versions(s).await.0, v0 + 3);

    // The period reset: counters 0, restored, next reset ahead, audited.
    sqlx::query(
        "UPDATE servers SET traffic_quota_next_reset_at = now() - interval '1 second' WHERE id = $1",
    )
    .bind(s)
    .execute(&db.pool)
    .await
    .unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    assert_eq!(apply_quota_resets(&mut tx).await.unwrap(), vec![s]);
    tx.commit().await.unwrap();
    assert_eq!(quota_state(&db, s).await, (0, 0, false));
    assert_eq!(db.versions(s).await.0, v0 + 4);
    let (ahead, audits): (bool, i64) = sqlx::query_as(
        "SELECT traffic_quota_next_reset_at > now(), (SELECT count(*) FROM audit_log \
         WHERE action = 'server.traffic_quota.reset' AND target_id = $1::text) \
         FROM servers WHERE id = $1",
    )
    .bind(s)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(ahead);
    assert_eq!(audits, 1);
    let mut tx = db.pool.begin().await.unwrap();
    assert!(apply_quota_resets(&mut tx).await.unwrap().is_empty());
    tx.commit().await.unwrap();
    // Removing the quota: never stops.
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/servers/{s}"),
            Some(json!({"traffic_quota_bytes": null, "traffic_quota_reset_day": null})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    nic(&db, s, "eth0", 90_000_000, 90_000_000).await;
    assert!(!quota_state(&db, s).await.2);
    let updates: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'server.update' AND target_id = $1::text",
    )
    .bind(s.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(updates, 4);
    db.drop().await;
}
