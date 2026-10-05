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
        "INSERT INTO entrances (id, node_id, kind, name) VALUES (gen_random_uuid(), $1, 'direct', 'x')",
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
                "display_name": "香港 01", "sort": 5, "visible": true, "tags": ["IPLC"],
                "direct": {"connect_host": "1.2.3.4", "rate": 0.5, "group_ids": [g]}
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
    let node = admin.get(&format!("/test/api/v1/nodes/{id}")).await.json();
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
    let eid = e["id"].as_str().unwrap().to_string();

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
            json!({"plan_id": p}),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let snap = crate::grpc::desired_snapshot(&db.pool, id)
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
        let t = crate::sub::rotate_token(&mut tx, state.totp(), &crate::audit::Actor::test(), u)
            .await
            .unwrap()
            .unwrap();
        tx.commit().await.unwrap();
        t
    };
    let mut sub = crate::testdb::http::Client::new(&state, crate::testdb::http::rand_ip());
    sub.headers = vec![("user-agent".into(), "clash.meta".into())];
    let body = String::from_utf8(
        sub.get(&format!("/test/sub/{token}?format=clash"))
            .await
            .body,
    )
    .unwrap();
    assert!(body.contains("香港 01 | IPLC 直连"), "{body}");
    assert!(body.contains("server: 1.2.3.4\n    port: 443\n"), "{body}");

    // PATCH: rename, another port, a multiplier — no bump.
    let before = db.versions(id).await;
    let path = format!("/test/api/v1/entrances/{eid}");
    let r = admin
        .req(
            Method::PATCH,
            &path,
            Some(json!({"name": "BGP", "connect_port": 30443, "rate": 2})),
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
        db.versions(id).await,
        before,
        "display/billing fields never bump"
    );
    let body = String::from_utf8(
        sub.get(&format!("/test/sub/{token}?format=clash"))
            .await
            .body,
    )
    .unwrap();
    assert!(body.contains("香港 01 | IPLC BGP"), "{body}");
    assert!(body.contains("port: 30443"), "{body}");
    // Disabled: no inbound, out of the subscription; enabled: back.
    let r = admin
        .req(Method::PATCH, &path, Some(json!({"enabled": false})))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_ne!(db.versions(id).await.0, before.0, "config_version bumped");
    let snap = crate::grpc::desired_snapshot(&db.pool, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((snap.inbounds_json.as_str(), snap.users.len()), ("[]", 0));
    let body = String::from_utf8(
        sub.get(&format!("/test/sub/{token}?format=clash"))
            .await
            .body,
    )
    .unwrap();
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
