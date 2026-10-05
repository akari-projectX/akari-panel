//! W29 block rule tests: entry parsing and the compiled policy (pure),
//! the admin API with audit rows and the built-in guard (real database),
//! the per-node switch (no version bump, a targeted wake), counter
//! ingestion (exactly-once daily counts, bounded agent input), retention,
//! and the session end to end over the real gRPC server.

use axum::http::{Method, StatusCode};
use serde_json::json;
use uuid::Uuid;

use super::*;
use crate::pb::BlockHits;
use crate::testdb::TestDb;
use crate::testdb::http::client_for;

fn hits(pairs: &[(u64, u64)]) -> Vec<BlockHits> {
    pairs
        .iter()
        .map(|&(rule_id, hits)| BlockHits { rule_id, hits })
        .collect()
}

fn stats(epoch: &str, pairs: &[(u64, u64)]) -> BlockStats {
    BlockStats {
        epoch: epoch.into(),
        hits: hits(pairs),
        applied: String::new(),
        error: String::new(),
    }
}

#[test]
fn domain_entries() {
    let got = parse_entries(
        Kind::Domain,
        " Example.COM \n\nfull:a.example.org.\nkeyword:torrent\r\ndomain:b.example\nexample.com\n",
    )
    .unwrap();
    assert_eq!(
        got,
        [
            "domain:example.com",
            "full:a.example.org",
            "keyword:torrent",
            "domain:b.example"
        ]
    );
    for bad in [
        "exa mple.com",
        "-a.example",
        "a-.example",
        "a..b",
        "regexp:.*",
        "geosite:cn",
        "ex_ample.com",
        "例子.com",
        &format!("{}.com", "a".repeat(64)),
        &format!("{}a", "a.".repeat(127)),
        "keyword:",
        "full:",
    ] {
        let e = parse_entries(Kind::Domain, &format!("ok.example\n{bad}")).unwrap_err();
        assert_eq!(e.code(), "block_rule.entry_invalid", "{bad}");
        assert_eq!(e.params()["line"], 2, "{bad}");
    }
    assert_eq!(
        parse_entries(Kind::Domain, " \n\t\n").unwrap_err().code(),
        "block_rule.entries_required"
    );
    let many: String = (0..=MAX_ENTRIES)
        .map(|i| format!("h{i}.example\n"))
        .collect();
    assert_eq!(
        parse_entries(Kind::Domain, &many).unwrap_err().code(),
        "block_rule.too_many_entries"
    );
    // Duplicates count once.
    let dup: String = (0..MAX_ENTRIES + 10).map(|_| "same.example\n").collect();
    assert_eq!(parse_entries(Kind::Domain, &dup).unwrap().len(), 1);
}

#[test]
fn ip_and_protocol_entries() {
    let got = parse_entries(
        Kind::Ip,
        "192.0.2.77/24\n198.51.100.1\n2001:db8::1/32\n::1\n0.0.0.0/0\n192.0.2.0/24",
    )
    .unwrap();
    assert_eq!(
        got,
        [
            "192.0.2.0/24",
            "198.51.100.1/32",
            "2001:db8::/32",
            "::1/128",
            "0.0.0.0/0"
        ]
    );
    for bad in [
        "192.0.2.0/33",
        "2001:db8::/129",
        "192.0.2.0/",
        "192.0.2.0/+8",
        "192.0.2.0/0008",
        "300.0.0.1",
        "example.com",
        "192.0.2.0/24/1",
    ] {
        assert_eq!(
            parse_entries(Kind::Ip, bad).unwrap_err().code(),
            "block_rule.entry_invalid",
            "{bad}"
        );
    }
    assert_eq!(
        parse_entries(Kind::Protocol, "BitTorrent\nquic\nbittorrent").unwrap(),
        ["bittorrent", "quic"]
    );
    assert_eq!(
        parse_entries(Kind::Protocol, "ssh").unwrap_err().code(),
        "block_rule.entry_invalid"
    );
}

/// The vendored lists hold only entries a custom rule would accept too
/// (suffix/full/keyword matchers, valid names), and are non-trivial.
#[test]
fn vendored_lists_are_valid() {
    for (text, min) in [(BT_TRACKER, 100), (XUNLEI_PT, 50)] {
        let entries = vendored(text);
        assert!(entries.len() >= min, "{}", entries.len());
        let joined = entries.join("\n");
        assert_eq!(parse_entries(Kind::Domain, &joined).unwrap(), entries);
    }
    assert_eq!(lists_version().len(), 40);
    assert!(lists_version().bytes().all(|b| b.is_ascii_hexdigit()));
}

#[test]
fn compiling_rules() {
    let bt = compile_rule(1, "builtin", Some("bittorrent"), None).unwrap();
    assert_eq!(
        (bt.id, bt.protocols.as_slice()),
        (1, ["bittorrent".to_string()].as_slice())
    );
    assert!(bt.domains.is_empty() && bt.cidrs.is_empty());
    let tr = compile_rule(2, "builtin", Some("bt_tracker"), None).unwrap();
    assert!(tr.domains.len() > 100 && tr.protocols.is_empty());
    let ip = compile_rule(3, "ip", None, Some("10.0.0.0/8")).unwrap();
    assert_eq!(ip.cidrs, ["10.0.0.0/8"]);
    // A hand-written row that does not parse is left out, never sent.
    assert!(compile_rule(4, "domain", None, Some("not a name")).is_none());
    assert!(compile_rule(5, "builtin", Some("unknown"), None).is_none());
    assert!(compile_rule(-1, "ip", None, Some("10.0.0.0/8")).is_none());

    // No tags = the empty policy: off, version "".
    assert_eq!(assemble(vec![], vec![ip.clone()]), BlockPolicy::default());
    let a = assemble(vec!["in-a".into()], vec![ip.clone()]);
    assert_eq!(a.version.len(), 24);
    assert_eq!(a, assemble(vec!["in-a".into()], vec![ip.clone()]));
    assert_ne!(
        a.version,
        assemble(vec!["in-b".into()], vec![ip.clone()]).version
    );
    assert_ne!(a.version, assemble(vec!["in-a".into()], vec![bt]).version);
    // On with no rules: tags still listed (sniffing follows the switch, so
    // a later rule change never re-creates an inbound).
    let none = assemble(vec!["in-a".into()], vec![]);
    assert!(none.rules.is_empty() && !none.version.is_empty());

    assert_eq!(
        inbound_tags(&json!([{"tag":"b"},{"tag":"a"},{"port":1},{"tag":""},{"tag":"a"},{"tag":5}])),
        ["a", "b"]
    );
    assert!(inbound_tags(&json!({"tag":"x"})).is_empty());
}

#[test]
fn agent_counters_are_bounded() {
    assert!(clean_stats(&stats("", &[(1, 1)])).is_none());
    assert!(clean_stats(&stats("a b", &[(1, 1)])).is_none());
    assert!(clean_stats(&stats(&"e".repeat(65), &[(1, 1)])).is_none());
    let (e, ids, h) = clean_stats(&stats(
        "epoch-1",
        &[(1, 5), (1, 9), (2, 0), (u64::MAX, 3), (3, u64::MAX)],
    ))
    .unwrap();
    assert_eq!(e, "epoch-1");
    assert_eq!(ids, [1, 3]);
    assert_eq!(h, [5, i64::MAX]);
    let many: Vec<(u64, u64)> = (1..=200).map(|i| (i, 1)).collect();
    assert_eq!(
        clean_stats(&stats("e", &many)).unwrap().1.len(),
        MAX_REPORTED_RULES
    );
    let s = status_json(&BlockStats {
        epoch: "e".into(),
        hits: vec![],
        applied: format!("v1\n{}", "x".repeat(400)),
        error: String::new(),
    });
    assert_eq!(s["applied"].as_str().unwrap().len(), 256);
    assert!(s["error"].is_null());
}

async fn rule_id(db: &TestDb, key: &str) -> i64 {
    sqlx::query_scalar("SELECT id FROM block_rules WHERE builtin_key = $1")
        .bind(key)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn audit_count(db: &TestDb, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = $1")
        .bind(action)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

/// Admin CRUD: validation codes, normalized storage, audit rows that
/// summarize the entries, the built-in guard on the API and in SQL, the
/// custom rule cap, and admins only.
#[tokio::test]
async fn admin_api_and_builtin_guard() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;

    let r = admin.get("/test/api/v1/block-rules").await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["lists_version"], lists_version());
    let keys: Vec<_> = v["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["builtin_key"].as_str().unwrap().to_string(),
                r["enabled"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        keys,
        [
            ("bittorrent".into(), true),
            ("bt_tracker".into(), true),
            ("xunlei_pt".into(), false)
        ]
    );
    assert!(v["rules"][1]["entries"].as_u64().unwrap() > 100);
    assert_eq!(
        user.get("/test/api/v1/block-rules").await.status,
        StatusCode::FORBIDDEN
    );

    let r = admin
        .post(
            "/test/api/v1/block-rules",
            json!({"kind":"domain","name":" 挖矿池 ","pattern":"Pool.Example\nfull:x.example"}),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let id = r.json()["id"].as_i64().unwrap();
    let (name, pattern, enabled): (String, String, bool) =
        sqlx::query_as("SELECT name, pattern, enabled FROM block_rules WHERE id = $1")
            .bind(id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        (name.as_str(), pattern.as_str(), enabled),
        ("挖矿池", "domain:pool.example\nfull:x.example", true)
    );
    let after: serde_json::Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'block_rule.create' AND target_id = $1",
    )
    .bind(id.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(after["entries"], 2);
    assert!(!after.to_string().contains("pool.example"), "{after}");

    for (body, code) in [
        (
            json!({"kind":"geosite","name":"x","pattern":"a.example"}),
            "block_rule.kind_invalid",
        ),
        (
            json!({"kind":"ip","name":"","pattern":"10.0.0.1"}),
            "block_rule.name_required",
        ),
        (
            json!({"kind":"ip","name":"x","pattern":"10.0.0.300"}),
            "block_rule.entry_invalid",
        ),
        (
            json!({"kind":"protocol","name":"x","pattern":"  "}),
            "block_rule.entries_required",
        ),
        (
            json!({"kind":"ip","name":"x","pattern":"10.0.0.1","sort":2_000_000}),
            "block_rule.sort_range",
        ),
    ] {
        let r = admin.post("/test/api/v1/block-rules", body).await;
        assert_eq!(
            (r.status, r.json()["code"].as_str().unwrap()),
            (StatusCode::BAD_REQUEST, code)
        );
    }
    let r = admin
        .post(
            "/test/api/v1/block-rules",
            json!({"kind":"ip","name":"x","pattern":"10.0.0.1","zz":1}),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // PATCH: partial; an unchanged PATCH writes no audit row.
    let path = format!("/test/api/v1/block-rules/{id}");
    let r = admin
        .req(
            Method::PATCH,
            &path,
            Some(json!({"pattern":"pool2.example"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = admin
        .req(
            Method::PATCH,
            &path,
            Some(json!({"enabled":false,"sort":5})),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = admin
        .req(Method::PATCH, &path, Some(json!({"enabled":false})))
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(audit_count(&db, "block_rule.update").await, 2);
    let r = admin
        .req(Method::PATCH, &path, Some(json!({"pattern":"10.0.0.0/33"})))
        .await;
    assert_eq!(r.json()["code"], "block_rule.entry_invalid");
    assert_eq!(
        admin
            .req(
                Method::PATCH,
                "/test/api/v1/block-rules/999999",
                Some(json!({"enabled":true}))
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // Built-ins: switch and sort only; never deleted (API and SQL).
    let bt = rule_id(&db, "bittorrent").await;
    let bpath = format!("/test/api/v1/block-rules/{bt}");
    assert_eq!(
        admin
            .req(Method::PATCH, &bpath, Some(json!({"enabled":false})))
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    for body in [json!({"name":"x"}), json!({"pattern":"a.example"})] {
        let r = admin.req(Method::PATCH, &bpath, Some(body)).await;
        assert_eq!(r.json()["code"], "block_rule.builtin_fixed");
    }
    let r = admin.req(Method::DELETE, &bpath, None).await;
    assert_eq!(r.json()["code"], "block_rule.builtin_fixed");
    let e = sqlx::query("DELETE FROM block_rules WHERE id = $1")
        .bind(bt)
        .execute(&db.pool)
        .await
        .unwrap_err();
    assert_eq!(
        e.as_database_error().unwrap().code().as_deref(),
        Some("AK029")
    );
    let e = sqlx::query("UPDATE block_rules SET kind = 'domain', builtin_key = NULL, pattern = 'a.example' WHERE id = $1")
        .bind(bt)
        .execute(&db.pool)
        .await
        .unwrap_err();
    assert_eq!(
        e.as_database_error().unwrap().code().as_deref(),
        Some("AK029")
    );
    let e = sqlx::query(
        "INSERT INTO block_rules (kind, builtin_key, name) VALUES ('builtin', 'bittorrent', 'dup')",
    )
    .execute(&db.pool)
    .await
    .unwrap_err();
    assert_eq!(
        e.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );

    // Custom rule cap.
    for i in 1..MAX_CUSTOM_RULES {
        let r = admin
            .post(
                "/test/api/v1/block-rules",
                json!({"kind":"ip","name":format!("r{i}"),"pattern":"10.0.0.1"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED);
    }
    let r = admin
        .post(
            "/test/api/v1/block-rules",
            json!({"kind":"ip","name":"one more","pattern":"10.0.0.1"}),
        )
        .await;
    assert_eq!(r.json()["code"], "block_rule.too_many_rules");

    assert_eq!(
        admin.req(Method::DELETE, &path, None).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        admin.req(Method::DELETE, &path, None).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(audit_count(&db, "block_rule.delete").await, 1);
    assert_eq!(
        user.req(Method::DELETE, &bpath, None).await.status,
        StatusCode::FORBIDDEN
    );
    db.drop().await;
}

/// Rule writes notify `block-rules` (wake every session); the node switch
/// notifies the node only, bumps neither version, is audited, and is
/// refused for unknown and deleting nodes.
#[tokio::test]
async fn notifications_and_node_switch() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let node = db.node().await;
    let mut listener = db.listener().await;

    let r = admin
        .post(
            "/test/api/v1/block-rules",
            json!({"kind":"ip","name":"x","pattern":"10.0.0.1"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let got = crate::testdb::drain(&mut listener, std::time::Duration::from_millis(300)).await;
    assert!(got.iter().any(|p| p == "block-rules"), "{got:?}");

    let before = db.versions(node).await;
    let path = format!("/test/api/v1/nodes/{node}/block-rules");
    let r = admin.put(&path, json!({"enabled": true})).await;
    assert_eq!(
        (r.status, r.json()["changed"].clone()),
        (StatusCode::OK, json!(true))
    );
    let got = crate::testdb::drain(&mut listener, std::time::Duration::from_millis(300)).await;
    assert!(got.contains(&node.to_string()), "{got:?}");
    assert_eq!(db.versions(node).await, before);
    let r = admin.put(&path, json!({"enabled": true})).await;
    assert_eq!(r.json()["changed"], json!(false));
    assert_eq!(audit_count(&db, "node.block_rules.set").await, 1);
    // Unchanged: no notify.
    let got = crate::testdb::drain(&mut listener, std::time::Duration::from_millis(200)).await;
    assert!(!got.contains(&node.to_string()), "{got:?}");

    assert_eq!(
        admin
            .put(
                &format!("/test/api/v1/nodes/{}/block-rules", Uuid::new_v4()),
                json!({"enabled": true})
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    sqlx::query("UPDATE nodes SET deleting_at = now() WHERE id = $1")
        .bind(node)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        admin.put(&path, json!({"enabled": false})).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        admin.put(&path, json!({"on": false})).await.status,
        StatusCode::BAD_REQUEST
    );
    drop(listener);
    db.drop().await;
}

/// The compiled policy: off unless the switch is on and the node serves;
/// tags from the node's inbounds; only enabled rules, in sort order.
#[tokio::test]
async fn node_policy_follows_switch_and_rules() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = db.node().await;
    let off = node_policy(&db.pool, node).await.unwrap().unwrap();
    assert_eq!(off, BlockPolicy::default());
    assert!(
        node_policy(&db.pool, Uuid::new_v4())
            .await
            .unwrap()
            .is_none()
    );

    sqlx::query("UPDATE nodes SET block_rules_enabled = true WHERE id = $1")
        .bind(node)
        .execute(&db.pool)
        .await
        .unwrap();
    let on = node_policy(&db.pool, node).await.unwrap().unwrap();
    assert_eq!(on.inbound_tags, ["in-vless"]);
    let ids: Vec<u64> = on.rules.iter().map(|r| r.id).collect();
    let (bt, tr) = (
        rule_id(&db, "bittorrent").await,
        rule_id(&db, "bt_tracker").await,
    );
    assert_eq!(ids, [bt as u64, tr as u64]);

    let mut tx = db.pool.begin().await.unwrap();
    let custom = apply_create(
        &mut tx,
        &Actor::test(),
        &CreateReq {
            kind: "protocol".into(),
            name: "quic".into(),
            pattern: "quic".into(),
            enabled: true,
            sort: -100,
        },
    )
    .await
    .unwrap();
    apply_update(
        &mut tx,
        &Actor::test(),
        tr,
        &UpdateReq {
            enabled: Some(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let p = node_policy(&db.pool, node).await.unwrap().unwrap();
    let ids: Vec<u64> = p.rules.iter().map(|r| r.id).collect();
    assert_eq!(ids, [custom as u64, bt as u64]);
    assert_ne!(p.version, on.version);

    for sql in [
        "UPDATE nodes SET enabled = false WHERE id = $1",
        "UPDATE nodes SET enabled = true, deleting_at = now() WHERE id = $1",
    ] {
        sqlx::query(sql).bind(node).execute(&db.pool).await.unwrap();
        assert_eq!(
            node_policy(&db.pool, node).await.unwrap().unwrap(),
            BlockPolicy::default()
        );
    }
    db.drop().await;
}

async fn daily(db: &TestDb, node: Uuid) -> Vec<(i64, i64)> {
    sqlx::query_as("SELECT rule_id, hits FROM node_block_daily WHERE node_id = $1 ORDER BY rule_id")
        .bind(node)
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

/// Counters: deltas of the cumulative counts land once (replays, reorders
/// and regressions add nothing; a new epoch starts from zero), unknown
/// rules are dropped, a node holds baselines for at most
/// MAX_EPOCHS_PER_NODE processes, and retention prunes both tables.
#[tokio::test]
async fn ingest_exactly_once_and_bounded() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = db.node().await;
    let (bt, tr) = (
        rule_id(&db, "bittorrent").await as u64,
        rule_id(&db, "bt_tracker").await as u64,
    );
    ingest_stats(&db.pool, node, &stats("p1", &[(bt, 3), (999_999, 50)]))
        .await
        .unwrap();
    assert_eq!(daily(&db, node).await, [(bt as i64, 3)]);
    ingest_stats(&db.pool, node, &stats("p1", &[(bt, 3)]))
        .await
        .unwrap();
    ingest_stats(&db.pool, node, &stats("p1", &[(bt, 2), (tr, 1)]))
        .await
        .unwrap();
    assert_eq!(daily(&db, node).await, [(bt as i64, 3), (tr as i64, 1)]);
    ingest_stats(&db.pool, node, &stats("p1", &[(bt, 10)]))
        .await
        .unwrap();
    ingest_stats(&db.pool, node, &stats("p2", &[(bt, 4)]))
        .await
        .unwrap();
    assert_eq!(daily(&db, node).await, [(bt as i64, 14), (tr as i64, 1)]);
    // No hits / malformed: nothing.
    ingest_stats(&db.pool, node, &stats("p3", &[]))
        .await
        .unwrap();
    ingest_stats(&db.pool, node, &stats("bad epoch", &[(bt, 100)]))
        .await
        .unwrap();
    assert_eq!(daily(&db, node).await, [(bt as i64, 14), (tr as i64, 1)]);

    // Epoch cap: two live already; six more fit, then new ones are dropped
    // while known ones keep counting.
    for i in 0..(MAX_EPOCHS_PER_NODE - 2) {
        ingest_stats(&db.pool, node, &stats(&format!("x{i}"), &[(bt, 1)]))
            .await
            .unwrap();
    }
    ingest_stats(&db.pool, node, &stats("overflow", &[(bt, 1000)]))
        .await
        .unwrap();
    ingest_stats(&db.pool, node, &stats("p2", &[(bt, 5)]))
        .await
        .unwrap();
    let epochs: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT epoch) FROM node_block_counters WHERE node_id = $1",
    )
    .bind(node)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(epochs, MAX_EPOCHS_PER_NODE);
    assert_eq!(daily(&db, node).await[0], (bt as i64, 14 + 6 + 1));

    // Retention: old days and silent epochs go; the rest stays.
    sqlx::query("UPDATE node_block_daily SET day = day - 91 WHERE rule_id = $1")
        .bind(tr as i64)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE node_block_counters SET updated_at = now() - interval '8 days' WHERE epoch = 'p1'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let (days, counters) = retention_pass(&db.pool).await.unwrap();
    assert_eq!((days, counters), (1, 2));
    assert_eq!(daily(&db, node).await, [(bt as i64, 21)]);
    // Deleting a node or a rule takes their rows with them.
    sqlx::query("DELETE FROM nodes WHERE id = $1")
        .bind(node)
        .execute(&db.pool)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM node_block_counters")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
    db.drop().await;
}

/// GET /nodes/{id}/block-rules: switch, capability, sync state from the
/// heartbeat blob, daily hits with rule names, bounded range.
#[tokio::test]
async fn node_view_endpoint() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let node = db.node().await;
    sqlx::query("UPDATE nodes SET block_rules_enabled = true, agent_capabilities = ARRAY['block-rules'] WHERE id = $1")
        .bind(node)
        .execute(&db.pool)
        .await
        .unwrap();
    let bt = rule_id(&db, "bittorrent").await as u64;
    ingest_stats(&db.pool, node, &stats("p", &[(bt, 7)]))
        .await
        .unwrap();
    let policy = node_policy(&db.pool, node).await.unwrap().unwrap();
    crate::valkey_util::set_with_ttl(
        &state,
        format!("akari:node:hb:{node}"),
        json!({"block": {"applied": policy.version, "error": null}}).to_string(),
        60,
    )
    .await;
    let path = format!("/test/api/v1/nodes/{node}/block-rules");
    let r = admin.get(&path).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["enabled"], true);
    assert_eq!(v["agent_supported"], true);
    assert_eq!(v["in_sync"], true, "{v}");
    assert_eq!(v["days"][0]["hits"], 7);
    assert_eq!(v["days"][0]["name"], "BitTorrent 协议识别");
    assert_eq!(
        admin.get(&format!("{path}?days=91")).await.json()["code"],
        "block_rule.days_range"
    );
    assert_eq!(
        admin.get(&format!("{path}?days=1&x=1")).await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        admin
            .get(&format!(
                "/test/api/v1/nodes/{}/block-rules",
                Uuid::new_v4()
            ))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    crate::valkey_util::del(&state, vec![format!("akari:node:hb:{node}")]).await;
    db.drop().await;
}

/// End to end over the real gRPC server: a capable agent gets the (off)
/// policy after its Hello, the compiled one when the switch turns on and
/// again when a rule changes, never a Snapshot for either; its heartbeat
/// counters land in the daily table once. An agent without the
/// capability never gets a policy.
#[tokio::test]
async fn session_sends_policy_and_stores_counters() {
    use crate::pb::agent_up::Msg as UpMsg;
    use crate::pb::panel_down::Msg as DownMsg;
    use crate::testdb::fake_agent::PanelHarness;
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (n, _u) = db.member().await;
    let panel = PanelHarness::start(&db).await;
    let creds = panel.register(&db, n).await;
    let mut agent = panel.connect(&creds).await.unwrap();
    agent.hello_caps((0, 0), String::new(), &[CAPABILITY]).await;
    let mut first = None;
    let mut snap = None;
    while first.is_none() || snap.is_none() {
        match agent.next().await {
            Some(Ok(DownMsg::Snapshot(s))) => snap = Some(s),
            Some(Ok(DownMsg::BlockPolicy(p))) => first = Some(p),
            Some(Ok(_)) => {}
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(first.unwrap(), BlockPolicy::default());
    agent.ack_snapshot(&snap.unwrap()).await;
    let versions = db.versions(n).await;

    let mut tx = db.pool.begin().await.unwrap();
    apply_set_node(&mut tx, &Actor::test(), n, true)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    // The harness runs no LISTEN task: deliver the wake by hand.
    panel.state.wakeups().wake(n);
    let on = loop {
        match agent.next().await {
            Some(Ok(DownMsg::BlockPolicy(p))) => break p,
            Some(Ok(DownMsg::Snapshot(_) | DownMsg::Delta(_))) => {
                panic!("switch caused a config push")
            }
            Some(Ok(_)) => {}
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(on.inbound_tags, ["in-vless"]);
    assert_eq!(on.rules.len(), 2);

    let xl = rule_id(&db, "xunlei_pt").await;
    let mut tx = db.pool.begin().await.unwrap();
    apply_update(
        &mut tx,
        &Actor::test(),
        xl,
        &UpdateReq {
            enabled: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    panel.state.wakeups().wake_all();
    let more = loop {
        match agent.next().await {
            Some(Ok(DownMsg::BlockPolicy(p))) => break p,
            Some(Ok(DownMsg::Snapshot(_) | DownMsg::Delta(_))) => {
                panic!("rule change caused a config push")
            }
            Some(Ok(_)) => {}
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(more.rules.len(), 3);
    assert_eq!(db.versions(n).await, versions);

    let bt = rule_id(&db, "bittorrent").await as u64;
    let hb = |count: u64| crate::pb::Heartbeat {
        block: Some(BlockStats {
            epoch: "agent-epoch".into(),
            hits: hits(&[(bt, count)]),
            applied: more.version.clone(),
            error: String::new(),
        }),
        ..Default::default()
    };
    agent.send_up(UpMsg::Heartbeat(hb(4))).await;
    agent.send_up(UpMsg::Heartbeat(hb(4))).await;
    agent.send_up(UpMsg::Heartbeat(hb(9))).await;
    let mut got = Vec::new();
    for _ in 0..100 {
        got = daily(&db, n).await;
        if got == [(bt as i64, 9)] {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(got, [(bt as i64, 9)]);
    drop(agent);

    // No capability: no policy, however the switch stands.
    let mut agent = panel.connect(&creds).await.unwrap();
    agent.hello_caps((0, 0), String::new(), &["metrics"]).await;
    panel.state.wakeups().wake(n);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(800);
    while let Ok(m) = tokio::time::timeout_at(deadline, agent.next()).await {
        match m {
            Some(Ok(DownMsg::BlockPolicy(_))) => {
                panic!("policy sent to an agent without the capability")
            }
            Some(Ok(_)) => {}
            _ => break,
        }
    }
    drop(agent);
    panel.stop().await;
    db.drop().await;
}
