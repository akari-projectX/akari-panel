//! W28-a entrances: the built-in direct entrance, its settings through the
//! node form and PATCH /entrances/{id}, access through groups, what the
//! agent and the subscription get from it.

use axum::http::{Method, StatusCode};
use serde_json::json;
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::client_for;

#[test]
fn relay_rules() {
    assert_eq!(inbound_tag(0), DIRECT_TAG);
    assert_eq!(inbound_tag(7), "e7");
    assert_eq!(
        clean_cidrs(&[
            " 203.0.113.7 ".into(),
            "10.1.2.3/8".into(),
            "2001:db8::1/48".into(),
            "203.0.113.7/32".into(),
            "::1".into(),
        ])
        .unwrap(),
        vec!["203.0.113.7/32", "10.0.0.0/8", "2001:db8::/48", "::1/128"]
    );
    assert_eq!(
        clean_cidrs(&["0.0.0.0/0".into()]).unwrap(),
        vec!["0.0.0.0/0"]
    );
    for bad in [
        vec![],
        vec!["x".to_string()],
        vec!["10.0.0.0/33".into()],
        vec!["::/129".into()],
        vec!["10.0.0.0/-1".into()],
        vec!["10.0.0.0/".into()],
        (0..65).map(|i| format!("10.0.0.{i}")).collect(),
    ] {
        let e = clean_cidrs(&bad).unwrap_err();
        assert_eq!(e.code(), "entrance.source_invalid", "{bad:?}");
    }
    // Derived inbounds: the node's inbound per entrance, tagged and on the
    // relay's port; nothing for a non-object.
    let ib = json!({"protocol": "vless", "port": 443, "tag": "x",
                    "settings": {"clients": [], "decryption": "none"}});
    let served = [
        Served {
            wire_no: 0,
            listen_port: None,
            source_cidrs: vec![],
        },
        Served {
            wire_no: 3,
            listen_port: Some(20443),
            source_cidrs: vec!["203.0.113.7/32".into()],
        },
    ];
    let d = derived_inbounds(&ib, &served);
    assert_eq!(d.len(), 2);
    assert_eq!(
        (d[0]["tag"].clone(), d[0]["port"].clone()),
        (json!("direct"), json!(443))
    );
    assert_eq!(
        (d[1]["tag"].clone(), d[1]["port"].clone()),
        (json!("e3"), json!(20443))
    );
    assert_eq!(d[1]["settings"], ib["settings"]);
    assert!(derived_inbounds(&json!([1]), &served).is_empty());
}

#[test]
fn field_rules() {
    assert_eq!(clean_name(" IPLC ").unwrap(), "IPLC");
    assert!(clean_name("  ").is_err());
    assert!(clean_name(&"x".repeat(65)).is_err());
    assert!(clean_name("a\nb").is_err());
    assert_eq!(clean_host(Some(" ")).unwrap(), None);
    assert_eq!(clean_host(None).unwrap(), None);
    assert_eq!(
        clean_host(Some("Relay.Example.com")).unwrap(),
        Some("relay.example.com".into())
    );
    assert_eq!(
        clean_host(Some("[2001:db8::1]")).unwrap(),
        Some("2001:db8::1".into())
    );
    for bad in ["https://x", "a b", "-a.example", "a..b"] {
        assert!(clean_host(Some(bad)).is_err(), "{bad}");
    }
    assert_eq!(clean_port(Some(443)).unwrap(), Some(443));
    assert!(clean_port(Some(0)).is_err());
    assert!(clean_port(Some(65536)).is_err());
    assert_eq!(rate_permille(0.5).unwrap(), 500);
    assert_eq!(rate_permille(1.255).unwrap(), 1255);
    assert_eq!(rate_permille(0.0).unwrap(), 0);
    assert_eq!(rate_permille(100.0).unwrap(), 100_000);
    for bad in [-0.1, 100.001, 0.0005, 1.2345, f64::NAN, f64::INFINITY] {
        assert!(rate_permille(bad).is_err(), "{bad}");
    }
}

/// Every node gets exactly one direct entrance, from whatever inserts it.
#[tokio::test]
async fn every_node_has_one_direct_entrance() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let n = db.node().await;
    let rows: Vec<(String, String, i32, bool)> = sqlx::query_as(
        "SELECT kind, name, rate_permille, enabled FROM entrances WHERE node_id = $1",
    )
    .bind(n)
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(rows, vec![("direct".into(), "直连".into(), 1000, true)]);
    // A second direct entrance is refused by the schema.
    let e = sqlx::query(
        "INSERT INTO entrances (id, node_id, server_id, kind, name, wire_no) \
         VALUES (gen_random_uuid(), $1, $1, 'direct', 'x', 9)",
    )
    .bind(n)
    .execute(&db.pool)
    .await
    .unwrap_err();
    assert!(e.to_string().contains("entrances_one_direct"), "{e}");
    // It goes away with the node.
    sqlx::query("DELETE FROM nodes WHERE id = $1")
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM entrances")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
    db.drop().await;
}

/// The node form creates the node, its inbound and its direct entrance's
/// settings in one request; PATCH /entrances/{id} edits them (validated,
/// audited); groups grant access through the entrance; disabling it takes
/// its inbound off the agent; the subscription uses its address,
/// multiplier and name.
#[tokio::test]
async fn node_form_entrance_patch_access_and_subscription() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = crate::state::AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let g = admin
        .post("/test/api/v1/node-groups", json!({"name": "hk"}))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let r = admin
        .post(
            "/test/api/v1/nodes",
            json!({
                "name": "w28-a",
                "inbound": {"tag": "ignored", "protocol": "vless", "port": 443,
                            "settings": {"clients": [], "decryption": "none"}},
                "display_name": "香港 01", "sort": 5, "visible": true, "tags": ["节点级"],
                "direct": {"connect_host": "1.2.3.4", "rate": 0.5, "group_ids": [g],
                           "tags": ["IPLC"]}
            }),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let id: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
    // Q1: no server_id given = a server of its own, named like the node.
    let server: Uuid = r.json()["server_id"].as_str().unwrap().parse().unwrap();
    assert_ne!(server, id);
    assert!(r.json()["enrollment_token"].is_string());
    let node = admin.get(&format!("/test/api/v1/nodes/{id}")).await.json();
    assert_eq!(node["server_id"], server.to_string());
    assert_eq!(node["server_name"], "w28-a");
    assert_eq!(
        node["inbound"],
        json!({"protocol": "vless", "port": 443,
               "settings": {"clients": [], "decryption": "none"}}),
        "stored without the tag"
    );
    let e = &node["entrances"][0];
    assert_eq!(e["kind"], "direct");
    assert_eq!(e["connect_host"], "1.2.3.4");
    assert_eq!(e["rate"], 0.5);
    assert_eq!(e["rate_permille"], 500);
    assert_eq!(e["group_ids"], json!([g]));
    assert_eq!(e["tags"], json!(["IPLC"]));
    let eid = e["id"].as_str().unwrap().to_string();
    // next07: a rate set in the creating transaction is the creation rate,
    // not a change (no 30 s lower-of window after it).
    let changed: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT rate_changed_at FROM entrances WHERE id = $1::uuid")
            .bind(&eid)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(changed.is_none());

    // A user with a plan granting the group gets a credential there.
    let u = db.user().await;
    let p = admin
        .post(
            "/test/api/v1/plans",
            json!({"name": "basic", "period": "monthly", "group_ids": [g]}),
        )
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let r = admin
        .put(
            &format!("/test/api/v1/users/{u}/plan"),
            json!({"plan_id": p, "period": "month"}),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let snap = crate::grpc::desired_snapshot(&db.pool, server)
        .await
        .unwrap()
        .unwrap();
    let inbounds: serde_json::Value = serde_json::from_str(&snap.inbounds_json).unwrap();
    assert_eq!(inbounds[0]["tag"], DIRECT_TAG);
    assert_eq!(snap.users.len(), 1);
    assert_eq!(snap.users[0].user_id, u.to_string());
    assert_eq!(snap.users[0].inbound_users[0].inbound_tag, DIRECT_TAG);

    // The subscription: the entrance's address, the node's and entrance's
    // names.
    let token = {
        let mut tx = db.pool.begin().await.unwrap();
        let t =
            crate::sub::rotate_token(&mut tx, state.master_key(), &crate::audit::Actor::test(), u)
                .await
                .unwrap()
                .unwrap();
        tx.commit().await.unwrap();
        t
    };
    let mut sub = crate::testdb::http::Client::new(&state, crate::testdb::http::rand_ip());
    sub.headers = vec![("user-agent".into(), "clash.meta".into())];
    let body =
        String::from_utf8(sub.get(&format!("/sub/{token}?format=clash")).await.body).unwrap();
    assert!(body.contains("香港 01 | IPLC 直连"), "{body}");
    assert!(
        !body.contains("节点级"),
        "1104: node-level tags name nothing"
    );
    assert!(body.contains("server: 1.2.3.4\n    port: 443\n"), "{body}");

    // PATCH: rename, another port, a multiplier — no bump.
    let before = db.versions(id).await;
    let path = format!("/test/api/v1/entrances/{eid}");
    let r = admin
        .req(
            Method::PATCH,
            &path,
            Some(json!({"name": "BGP", "connect_port": 30443, "rate": 2,
                         "tags": [" IPLC ", "原生", "IPLC", ""]})),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    assert_eq!(r.json()["name"], "BGP");
    assert_eq!(r.json()["rate"], 2.0);
    assert_eq!(
        r.json()["tags"],
        json!(["IPLC", "原生"]),
        "trimmed, deduplicated"
    );
    for (bad, code) in [
        (json!(["a|b"]), "node.tag_invalid"),
        (json!(["x".repeat(25)]), "node.tag_invalid"),
        (
            json!((0..9).map(|i| i.to_string()).collect::<Vec<_>>()),
            "node.too_many_tags",
        ),
    ] {
        let r = admin
            .req(Method::PATCH, &path, Some(json!({ "tags": bad })))
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        assert_eq!(r.json()["code"], code);
    }
    let r = admin
        .req(Method::PATCH, &path, Some(json!({ "tags": null })))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "null is not []");
    let audited: serde_json::Value = sqlx::query_scalar(
        "SELECT after->'tags' FROM audit_log WHERE action = 'entrance.update' \
         ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audited, json!(["IPLC", "原生"]));
    assert_eq!(
        db.versions(id).await,
        before,
        "display/billing fields never bump"
    );
    let body =
        String::from_utf8(sub.get(&format!("/sub/{token}?format=clash")).await.body).unwrap();
    assert!(body.contains("香港 01 | IPLC | 原生 BGP"), "{body}");
    assert!(body.contains("port: 30443"), "{body}");
    // Disabled: no inbound, out of the subscription; enabled: back.
    let r = admin
        .req(Method::PATCH, &path, Some(json!({"enabled": false})))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_ne!(db.versions(id).await.0, before.0, "config_version bumped");
    let snap = crate::grpc::desired_snapshot(&db.pool, server)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((snap.inbounds_json.as_str(), snap.users.len()), ("[]", 0));
    let body =
        String::from_utf8(sub.get(&format!("/sub/{token}?format=clash")).await.body).unwrap();
    assert!(!body.contains("BGP"), "{body}");
    admin
        .req(Method::PATCH, &path, Some(json!({"enabled": true})))
        .await;
    // Leaving the group revokes the credential (departed), back restores.
    let r = admin
        .req(Method::PATCH, &path, Some(json!({"group_ids": []})))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["group_ids"], json!([]));
    let creds: i64 = sqlx::query_scalar("SELECT count(*) FROM entrance_users WHERE user_id = $1")
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(creds, 0);
    // Refusals.
    for bad in [
        json!({}),
        json!({"rate": 0.0001}),
        json!({"rate": null}),
        json!({"name": ""}),
        json!({"name": null}),
        json!({"connect_host": "a b"}),
        json!({"connect_port": 0}),
        json!({"group_ids": [Uuid::new_v4()]}),
        json!({"group_ids": null}),
        json!({"kind": "relay"}),
    ] {
        let r = admin.req(Method::PATCH, &path, Some(bad.clone())).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(
        admin
            .req(
                Method::PATCH,
                &format!("/test/api/v1/entrances/{}", Uuid::new_v4()),
                Some(json!({"name": "x"})),
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // Users cannot.
    let me = client_for(&state, u).await;
    assert_eq!(
        me.req(Method::PATCH, &path, Some(json!({"name": "x"})))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    // Audited: create (node form) + 4 patches + group change.
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'entrance.update' AND target_id = $1",
    )
    .bind(&eid)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audits, 5);
    // D3: no manual assignment API.
    for (m, p) in [
        (Method::POST, format!("/test/api/v1/users/{u}/nodes/{id}")),
        (Method::DELETE, format!("/test/api/v1/users/{u}/nodes/{id}")),
        (Method::GET, format!("/test/api/v1/users/{u}/nodes")),
        (Method::PUT, format!("/test/api/v1/nodes/{id}/inbounds")),
    ] {
        let r = admin.req(m, &p, Some(json!({}))).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{p}");
        assert!(r.body.is_empty(), "canonical rejection: {p}");
    }
    drop(state);
    db.drop().await;
}

/// Node creation refuses a template and an inbound together, a bad
/// inbound and bad direct-entrance settings, and leaves nothing behind.
#[tokio::test]
async fn create_refusals() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = crate::state::AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    db.node().await;
    for (body, code) in [
        (
            json!({"name": "a", "inbound": {"protocol": "vless"},
                   "template": {"template": "vmess_tcp", "port": 1}}),
            "node.template_and_inbound",
        ),
        (
            json!({"name": "b", "inbound": [{"protocol": "vless"}]}),
            "inbound.not_object",
        ),
        (
            json!({"name": "c", "inbound": {"port": 1}}),
            "inbound.protocol_missing",
        ),
        (
            json!({"name": "d", "direct": {"rate": 101}}),
            "entrance.rate_invalid",
        ),
    ] {
        let r = admin.post("/test/api/v1/nodes", body.clone()).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(r.json()["code"], code, "{body}");
    }
    let nodes: i64 = sqlx::query_scalar("SELECT count(*) FROM nodes")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(nodes, 1, "a refused create leaves nothing behind");
    drop(state);
    db.drop().await;
}

/// W28-a relay entrances: created on a node (validated, numbered, the
/// node's inbound on its own port with its own credentials and a source
/// allowlist), granted through groups independently of the direct
/// entrance, edited (listen port / sources bump the config), refused where
/// they would clash, deleted without touching the direct entrance.
#[tokio::test]
async fn relay_entrance_lifecycle() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = crate::state::AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let n = db.node().await;
    sqlx::query(
        "UPDATE nodes SET inbound = '{\"protocol\":\"vless\",\"port\":443,\
         \"settings\":{\"clients\":[],\"decryption\":\"none\"}}'::jsonb WHERE id = $1",
    )
    .bind(n)
    .execute(&db.pool)
    .await
    .unwrap();
    let group = |name: &str| {
        let admin = &admin;
        let name = name.to_string();
        async move {
            admin
                .post("/test/api/v1/node-groups", json!({ "name": name }))
                .await
                .json()["id"]
                .as_str()
                .unwrap()
                .to_string()
        }
    };
    let (g_direct, g_relay) = (group("direct").await, group("relay").await);
    let direct: Uuid = sqlx::query_scalar("SELECT id FROM entrances WHERE node_id = $1")
        .bind(n)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    admin
        .req(
            Method::PATCH,
            &format!("/test/api/v1/entrances/{direct}"),
            Some(json!({"group_ids": [g_direct]})),
        )
        .await;
    let path = format!("/test/api/v1/nodes/{n}/entrances");
    let relay = json!({"name": "IPLC", "connect_host": "relay.example.net", "connect_port": 30443,
                       "listen_port": 20443, "source_cidrs": ["203.0.113.7", "198.51.100.0/24"],
                       "rate": 2, "tags": ["专线"], "group_ids": [g_relay]});
    // Refusals first: nothing is created.
    for (body, status, code) in [
        (
            json!({"listen_port": 443}),
            StatusCode::BAD_REQUEST,
            "entrance.port_clash",
        ),
        (
            json!({"source_cidrs": []}),
            StatusCode::BAD_REQUEST,
            "entrance.source_invalid",
        ),
        (
            json!({"connect_host": " "}),
            StatusCode::BAD_REQUEST,
            "entrance.relay_address",
        ),
        (
            json!({"listen_port": 0}),
            StatusCode::BAD_REQUEST,
            "entrance.listen_port_invalid",
        ),
        (
            json!({"name": "直连"}),
            StatusCode::CONFLICT,
            "entrance.name_exists",
        ),
        (
            json!({"group_ids": [Uuid::new_v4()]}),
            StatusCode::BAD_REQUEST,
            "group.unknown",
        ),
        (
            json!({"tags": ["a|b"]}),
            StatusCode::BAD_REQUEST,
            "node.tag_invalid",
        ),
    ] {
        let mut b = relay.clone();
        for (k, v) in body.as_object().unwrap() {
            b[k] = v.clone();
        }
        let r = admin.post(&path, b).await;
        assert_eq!(r.status, status, "{body}");
        assert_eq!(r.json()["code"], code, "{body}");
    }
    let r = admin
        .post(
            &format!("/test/api/v1/nodes/{}/entrances", Uuid::new_v4()),
            relay.clone(),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let count = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM entrances WHERE node_id = $1")
            .bind(n)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    };
    assert_eq!(count().await, 1);
    let seq: i32 = sqlx::query_scalar("SELECT entrance_seq FROM servers WHERE id = $1")
        .bind(n)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(seq, 0, "refusals roll the number back");

    let before = db.versions(n).await;
    let r = admin.post(&path, relay.clone()).await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let v = r.json();
    let rid: Uuid = v["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(v["kind"], "relay");
    assert_eq!(v["wire_no"], 1);
    assert_eq!(v["listen_port"], 20443);
    assert_eq!(
        v["source_cidrs"],
        json!(["203.0.113.7/32", "198.51.100.0/24"])
    );
    assert_eq!(v["rate_permille"], 2000);
    assert_eq!(v["group_ids"], json!([g_relay]));
    assert_eq!(v["tags"], json!(["专线"]));
    assert!(
        db.versions(n).await.0 > before.0,
        "a new inbound: config_version"
    );
    // The same port twice is refused (another relay has it).
    let mut dup = relay.clone();
    dup["name"] = json!("other");
    let r = admin.post(&path, dup).await;
    assert_eq!(r.json()["code"], "entrance.port_clash");
    // The node view lists it after the direct entrance.
    let node = admin.get(&format!("/test/api/v1/nodes/{n}")).await.json();
    assert_eq!(node["entrances"][0]["kind"], "direct");
    assert_eq!(node["entrances"][1]["id"], json!(rid));
    assert_eq!(
        node["entrances"][0]["tags"],
        json!([]),
        "the direct one keeps its own"
    );
    assert_eq!(node["entrances"][1]["tags"], json!(["专线"]));

    // A plan with both groups: one credential per entrance, independent.
    let u = db.user().await;
    let plan = admin
        .post(
            "/test/api/v1/plans",
            json!({"name": "both", "period": "monthly", "group_ids": [g_direct, g_relay]}),
        )
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let r = admin
        .put(
            &format!("/test/api/v1/users/{u}/plan"),
            json!({"plan_id": plan, "period": "month"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let accounts: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT entrance_id, account->>'id' FROM entrance_users WHERE user_id = $1 \
         ORDER BY entrance_id = $2 DESC",
    )
    .bind(u)
    .bind(direct)
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(accounts.len(), 2);
    assert_ne!(accounts[0].1, accounts[1].1, "independent credentials");

    // The agent's config: two inbounds, the user under two keys, the
    // relay's port filtered to its sources.
    let snap = crate::grpc::desired_snapshot(&db.pool, n)
        .await
        .unwrap()
        .unwrap();
    let ibs: serde_json::Value = serde_json::from_str(&snap.inbounds_json).unwrap();
    assert_eq!(ibs.as_array().unwrap().len(), 2);
    assert_eq!(
        (ibs[0]["tag"].clone(), ibs[0]["port"].clone()),
        (json!("direct"), json!(443))
    );
    assert_eq!(
        (ibs[1]["tag"].clone(), ibs[1]["port"].clone()),
        (json!("e1"), json!(20443))
    );
    let keys: Vec<(String, String)> = snap
        .users
        .iter()
        .map(|o| (o.user_id.clone(), o.inbound_users[0].inbound_tag.clone()))
        .collect();
    assert_eq!(
        keys,
        vec![
            (u.to_string(), "direct".into()),
            (format!("{u}#1"), "e1".into())
        ]
    );
    assert_eq!(snap.source_filters.len(), 1);
    let f = &snap.source_filters[0];
    assert_eq!((f.port, f.tcp, f.udp), (20443, true, false));
    assert_eq!(f.cidrs, vec!["203.0.113.7/32", "198.51.100.0/24"]);

    // Leaving the relay's group: only the relay credential goes.
    admin
        .req(
            Method::PATCH,
            &format!("/test/api/v1/entrances/{rid}"),
            Some(json!({"group_ids": []})),
        )
        .await;
    let left: Vec<Uuid> =
        sqlx::query_scalar("SELECT entrance_id FROM entrance_users WHERE user_id = $1")
            .bind(u)
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(left, vec![direct]);
    let departed: Vec<Uuid> =
        sqlx::query_scalar("SELECT entrance_id FROM entrance_users_departed WHERE user_id = $1")
            .bind(u)
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(departed, vec![rid]);

    // PATCH: relay fields; the direct entrance has none.
    let rpath = format!("/test/api/v1/entrances/{rid}");
    let before = db.versions(n).await;
    let r = admin
        .req(
            Method::PATCH,
            &rpath,
            Some(json!({"listen_port": 20444, "source_cidrs": ["192.0.2.1"]})),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    assert_eq!(r.json()["source_cidrs"], json!(["192.0.2.1/32"]));
    assert!(
        db.versions(n).await.0 > before.0,
        "listen port/sources bump"
    );
    let before = db.versions(n).await;
    admin
        .req(
            Method::PATCH,
            &rpath,
            Some(json!({"rate": 1.5, "name": "IPLC 2"})),
        )
        .await;
    assert_eq!(db.versions(n).await, before, "name/rate never bump");
    for (path, body, code) in [
        (&rpath, json!({"listen_port": 443}), "entrance.port_clash"),
        (
            &rpath,
            json!({"connect_host": null}),
            "entrance.relay_address",
        ),
        (
            &rpath,
            json!({"connect_port": null}),
            "entrance.relay_address",
        ),
        (
            &rpath,
            json!({"source_cidrs": null}),
            "request.field_not_null",
        ),
        (
            &format!("/test/api/v1/entrances/{direct}"),
            json!({"listen_port": 1000}),
            "entrance.relay_only",
        ),
        (
            &format!("/test/api/v1/entrances/{direct}"),
            json!({"source_cidrs": ["192.0.2.1"]}),
            "entrance.relay_only",
        ),
    ] {
        let r = admin.req(Method::PATCH, path, Some(body.clone())).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(r.json()["code"], code, "{body}");
    }
    // The node's inbound cannot move onto the relay's port.
    let r = admin
        .put(
            &format!("/test/api/v1/nodes/{n}/inbound"),
            json!({"inbound": {"protocol": "vless", "port": 20444,
                               "settings": {"clients": [], "decryption": "none"}}}),
        )
        .await;
    assert_eq!(r.json()["code"], "entrance.port_clash");

    // Disabled: no derived inbound, no filter.
    admin
        .req(Method::PATCH, &rpath, Some(json!({"enabled": false})))
        .await;
    let snap = crate::grpc::desired_snapshot(&db.pool, n)
        .await
        .unwrap()
        .unwrap();
    assert!(snap.source_filters.is_empty());
    assert!(!snap.inbounds_json.contains("e1"));

    // Delete: the relay only; the direct entrance cannot be deleted.
    let r = admin
        .req(
            Method::DELETE,
            &format!("/test/api/v1/entrances/{direct}"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "entrance.direct_permanent");
    let before = db.versions(n).await;
    let r = admin.req(Method::DELETE, &rpath, None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(db.versions(n).await.0 > before.0);
    assert_eq!(count().await, 1);
    let r = admin.req(Method::DELETE, &rpath, None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // A new relay never reuses the number.
    let r = admin.post(&path, relay.clone()).await;
    assert_eq!(r.json()["wire_no"], 2);
    // Audited.
    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE target_type = 'entrance' AND target_id = $1 ORDER BY id",
    )
    .bind(rid.to_string())
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        actions,
        vec![
            "entrance.create",
            "entrance.update",
            "entrance.update",
            "entrance.update",
            "entrance.update",
            "entrance.delete"
        ]
    );
    // Users cannot.
    let me = client_for(&state, u).await;
    assert_eq!(me.post(&path, relay).await.status, StatusCode::FORBIDDEN);
    drop(state);
    db.drop().await;
}

/// next07: the multiplier is never taken as 0x (or a default) from a
/// missing or empty value — a relay needs one, PATCH without it keeps the
/// current one, null / "" are refused — and a stale form cannot overwrite
/// newer values: PATCH with the `version` it was opened at is refused 409
/// `entrance.version_conflict` once the entrance changed, nothing written.
#[tokio::test]
async fn rate_input_safety_and_stale_forms() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = crate::state::AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let n = db.node().await;
    let relay = json!({"name": "IPLC", "connect_host": "relay.example.net", "connect_port": 30443,
                       "listen_port": 20443, "source_cidrs": ["203.0.113.7"]});
    let path = format!("/test/api/v1/nodes/{n}/entrances");
    for rate in [None, Some(json!(null)), Some(json!("")), Some(json!(-1))] {
        let mut b = relay.clone();
        if let Some(r) = &rate {
            b["rate"] = r.clone();
        }
        let r = admin.post(&path, b).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{rate:?}");
    }
    let n_entrances: i64 = sqlx::query_scalar("SELECT count(*) FROM entrances WHERE node_id = $1")
        .bind(n)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n_entrances, 1, "nothing created");

    let e: Uuid = sqlx::query_scalar("SELECT id FROM entrances WHERE node_id = $1")
        .bind(n)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let epath = format!("/test/api/v1/entrances/{e}");
    let patch = |body: serde_json::Value| {
        let (admin, epath) = (&admin, epath.clone());
        async move { admin.req(Method::PATCH, &epath, Some(body)).await }
    };
    let r = patch(json!({"rate": 10})).await;
    assert_eq!(r.status, StatusCode::OK);
    let v1 = r.json()["version"].as_i64().unwrap();
    assert_eq!(r.json()["rate_permille"], 10_000);
    // Absent = unchanged; null and "" refused.
    let r = patch(json!({"name": "主线"})).await;
    assert_eq!(r.json()["rate_permille"], 10_000);
    for bad in [json!(null), json!("")] {
        let r = patch(json!({ "rate": bad })).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    // Explicit 0x is allowed (the console asks for confirmation).
    let r = patch(json!({"rate": 0})).await;
    assert_eq!(r.json()["rate_permille"], 0);
    let current = r.json()["version"].as_i64().unwrap();
    assert!(current > v1);

    // Two forms opened at `current`: the first save wins, the second is
    // refused and writes nothing.
    let r = patch(json!({"rate": 10, "version": current})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["version"], current + 1);
    let r = patch(json!({"name": "stale", "rate": 1, "version": current})).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "entrance.version_conflict");
    let (name, rate, version): (String, i32, i64) =
        sqlx::query_as("SELECT name, rate_permille, version FROM entrances WHERE id = $1")
            .bind(e)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        (name.as_str(), rate, version),
        ("主线", 10_000, current + 1)
    );
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'entrance.update' AND target_id = $1",
    )
    .bind(e.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audits, 4, "the refused save is not audited");
    db.drop().await;
}

/// next07: subscription line names are stable. Clients (mihomo / Clash
/// Verge, sing-box, Stash, Hiddify, Shadowrocket, v2rayN) remember the
/// user's selection by proxy name; a name carrying the live multiplier
/// changed on every rate change and time-window flip and the selection fell
/// back to the first proxy (the direct entrance). Every format's whole body
/// is byte-identical across a base change and a time-window rule taking
/// effect. With the operator switch (系统设置 → 订阅 "订阅线路名显示倍率")
/// names show the base multiplier, never the time-window one.
#[tokio::test]
async fn subscription_names_are_stable_across_rate_changes() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = crate::state::AppState::for_test_with(db.pool.clone(), |c| {
        c.limits.sub_rate_per_token = 1000;
        c.limits.sub_rate_per_ip = 1000;
    })
    .await;
    let admin = client_for(&state, db.admin().await).await;
    let g = admin
        .post("/test/api/v1/node-groups", json!({"name": "all"}))
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let r = admin
        .post(
            "/test/api/v1/nodes",
            json!({
                "name": "hk",
                "inbound": {"protocol": "vless", "port": 443,
                            "settings": {"clients": [], "decryption": "none"}},
                "display_name": "香港 01",
                "direct": {"connect_host": "1.2.3.4", "group_ids": [g]}
            }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let node: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
    let r = admin
        .post(
            &format!("/test/api/v1/nodes/{node}/entrances"),
            json!({"name": "中转A", "connect_host": "relay.example.net", "connect_port": 30443,
                   "listen_port": 20443, "source_cidrs": ["203.0.113.7"], "rate": 1,
                   "group_ids": [g]}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let relay = r.json()["id"].as_str().unwrap().to_string();
    let u = db.user().await;
    let p = admin
        .post(
            "/test/api/v1/plans",
            json!({"name": "basic", "period": "monthly", "group_ids": [g]}),
        )
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let r = admin
        .put(
            &format!("/test/api/v1/users/{u}/plan"),
            json!({"plan_id": p, "period": "month"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let token = {
        let mut tx = db.pool.begin().await.unwrap();
        let t =
            crate::sub::rotate_token(&mut tx, state.master_key(), &crate::audit::Actor::test(), u)
                .await
                .unwrap()
                .unwrap();
        tx.commit().await.unwrap();
        t
    };
    let uas = [
        "clash.meta",
        "mihomo/1.19.32",
        "clash-verge/v2.2.3",
        "Stash/2.4",
        "sing-box 1.14.2",
        "HiddifyNext/2.5",
        "Shadowrocket/2070",
        "v2rayN/7.0",
        "",
    ];
    let fetch_all = || {
        let (state, token) = (&state, &token);
        async move {
            let mut out = Vec::new();
            for ua in uas {
                let mut c = crate::testdb::http::Client::new(state, crate::testdb::http::rand_ip());
                c.headers = vec![("user-agent".into(), ua.into())];
                let r = c.get(&format!("/sub/{token}")).await;
                assert_eq!(r.status, StatusCode::OK, "{ua}");
                out.push(String::from_utf8(r.body).unwrap());
            }
            out
        }
    };
    let before = fetch_all().await;
    assert!(before[0].contains("香港 01 中转A"), "{}", before[0]);
    let rpath = format!("/test/api/v1/entrances/{relay}");
    let r = admin
        .req(Method::PATCH, &rpath, Some(json!({"rate": 10})))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let after_base = fetch_all().await;
    // A time-window rule in effect now (every minute of the week).
    let r = admin
        .put(
            &format!("{rpath}/rate-rules"),
            json!({"rules": [{"weekdays": [1, 2, 3, 4, 5, 6, 7], "start": "00:00", "end": "24:00",
                              "rate": 2}]}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["entrance"]["rate_now"], 2.0);
    let in_window = fetch_all().await;
    for (i, ua) in uas.iter().enumerate() {
        assert_eq!(before[i], after_base[i], "{ua}: base change renamed");
        assert_eq!(before[i], in_window[i], "{ua}: time window renamed");
        for b in [&before[i], &in_window[i]] {
            assert!(!b.contains("10.0x") && !b.contains("2.0x"), "{ua}: {b}");
        }
    }

    // The operator switch: the base multiplier (10x), never the window's
    // (2x); 1x lines unchanged.
    let version = admin.get("/test/api/v1/settings").await.json()["version"]
        .as_i64()
        .unwrap();
    let r = admin
        .put(
            "/test/api/v1/settings/subscription",
            json!({"version": version, "name_rate": true}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["subscription"]["name_rate"], true);
    let named = fetch_all().await;
    assert!(named[0].contains("香港 01 中转A 10.0x"), "{}", named[0]);
    assert!(!named[0].contains("2.0x"));
    assert!(named[0].contains("香港 01 直连"));
    // Back off: the original names.
    let r = admin
        .put(
            "/test/api/v1/settings/subscription",
            json!({"version": version + 1, "name_rate": false}),
        )
        .await;
    assert_eq!(r.json()["subscription"]["name_rate"], false);
    assert_eq!(fetch_all().await, before);
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'settings.subscription.update' \
         AND after->>'name_rate' IS NOT NULL",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audits, 2);
    db.drop().await;
}
