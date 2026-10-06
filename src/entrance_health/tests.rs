//! W28-a relay entrance health: the consecutive-failure rule, the claimed
//! rounds against real sockets, what hiding does (subscription, portal,
//! alert) and what it does not (the agent's config).

use std::time::Duration;

use serde_json::json;

use super::*;
use crate::testdb::TestDb;

/// A node with a TCP inbound and a relay entrance at `port` on 127.0.0.1.
async fn relay(db: &TestDb, port: i32) -> (Uuid, Uuid) {
    let n = db.node().await;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO entrances (id, node_id, server_id, kind, name, connect_host, connect_port, \
         wire_no, listen_port, source_cidrs) VALUES ($1, $2, $2, 'relay', 'IPLC', '127.0.0.1', $3, \
         1, 20443, \
         '{203.0.113.7/32}')",
    )
    .bind(id)
    .bind(n)
    .bind(port)
    .execute(&db.pool)
    .await
    .unwrap();
    (n, id)
}

async fn state(db: &TestDb, id: Uuid) -> (Option<bool>, i32, bool, Option<String>) {
    sqlx::query_as(
        "SELECT health_ok, health_failures, hidden_since IS NOT NULL, health_error \
         FROM entrances WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

/// Hidden after the configured number of consecutive failures (not
/// before), shown again by the first success; the direct entrance is never
/// touched; nothing bumps the agent's config.
#[tokio::test]
async fn consecutive_failures_hide_and_success_restores() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (n, e) = relay(&db, 1).await;
    let versions = db.versions(n).await;
    for i in 1..crate::config::ENTRANCE_HEALTH_FAILURES {
        record(&db.pool, e, Err("timeout".into())).await.unwrap();
        assert_eq!(
            state(&db, e).await,
            (Some(false), i, false, Some("timeout".into()))
        );
    }
    record(&db.pool, e, Err("refused\n".into())).await.unwrap();
    let s = state(&db, e).await;
    assert!(
        s.2,
        "hidden after {} failures",
        crate::config::ENTRANCE_HEALTH_FAILURES
    );
    assert_eq!(
        s.3.as_deref(),
        Some("refused"),
        "control characters dropped"
    );
    // Still hidden while failing; the first success restores it.
    record(&db.pool, e, Err("timeout".into())).await.unwrap();
    assert!(state(&db, e).await.2);
    record(&db.pool, e, Ok(())).await.unwrap();
    assert_eq!(state(&db, e).await, (Some(true), 0, false, None));
    assert_eq!(
        db.versions(n).await,
        versions,
        "health never bumps the node"
    );
    // The direct entrance is not a relay: nothing recorded.
    let direct = db.direct(n).await;
    record(&db.pool, direct, Err("x".into())).await.unwrap();
    let (at, failures): (Option<chrono::DateTime<chrono::Utc>>, i32) =
        sqlx::query_as("SELECT health_at, health_failures FROM entrances WHERE id = $1")
            .bind(direct)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!((at, failures), (None, 0));
    db.drop().await;
}

/// A round tests every due relay once (a listening port answers, a closed
/// one fails), claims it until the next interval, and skips disabled
/// relays, disabled nodes and UDP-only inbounds.
#[tokio::test]
async fn rounds_test_due_relays_against_real_sockets() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let open = i32::from(listener.local_addr().unwrap().port());
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        i32::from(l.local_addr().unwrap().port())
    };
    let (_, up) = relay(&db, open).await;
    let (_, down) = relay(&db, closed).await;
    let (off_node, off) = relay(&db, open).await;
    sqlx::query("UPDATE nodes SET enabled = false WHERE id = $1")
        .bind(off_node)
        .execute(&db.pool)
        .await
        .unwrap();
    let (_, disabled) = relay(&db, open).await;
    sqlx::query("UPDATE entrances SET enabled = false WHERE id = $1")
        .bind(disabled)
        .execute(&db.pool)
        .await
        .unwrap();
    let (udp_node, udp) = relay(&db, open).await;
    sqlx::query("UPDATE nodes SET inbound = $2 WHERE id = $1")
        .bind(udp_node)
        .bind(json!({"protocol": "hysteria", "port": 443, "settings": {"version": 2}}))
        .execute(&db.pool)
        .await
        .unwrap();
    let timeout = Duration::from_millis(500);
    let tested = health_round(&db.pool, 60, timeout).await.unwrap();
    assert_eq!(tested, 3, "up, down and the UDP-only one are claimed");
    assert_eq!(state(&db, up).await.0, Some(true));
    assert_eq!(state(&db, down).await.0, Some(false));
    for skipped in [off, disabled, udp] {
        assert_eq!(state(&db, skipped).await.0, None, "{skipped}");
    }
    // Claimed until the next interval: a second round finds nothing due.
    assert_eq!(health_round(&db.pool, 60, timeout).await.unwrap(), 0);
    // A new address is tested at the next round.
    sqlx::query("UPDATE entrances SET health_next_at = NULL WHERE id = $1")
        .bind(down)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(health_round(&db.pool, 60, timeout).await.unwrap(), 1);
    assert_eq!(state(&db, down).await.1, 2);
    drop(listener);
    db.drop().await;
}

/// Hidden relays are left out of the subscription and the portal and
/// raise the node's entrance_down alert; restored ones come back.
#[tokio::test]
async fn hidden_relays_leave_subscription_and_portal_and_alert() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (n, e) = relay(&db, 30443).await;
    let u = db.user().await;
    sqlx::query(
        "INSERT INTO entrance_users (entrance_id, user_id, protocol, account) VALUES \
         ($1, $3, 'vless', '{\"id\":\"a\"}'), ($2, $3, 'vless', '{\"id\":\"b\"}')",
    )
    .bind(db.direct(n).await)
    .bind(e)
    .bind(u)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE nodes SET inbound = $2 WHERE id = $1")
        .bind(n)
        .bind(json!({"protocol": "vless", "port": 443, "settings": {"clients": [], "decryption": "none"}}))
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE servers SET cert_serial = 'aa' WHERE id = $1")
        .bind(n)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE entrances SET connect_host = '1.2.3.4' WHERE id = $1")
        .bind(db.direct(n).await)
        .execute(&db.pool)
        .await
        .unwrap();
    let state = crate::state::AppState::for_test(db.pool.clone()).await;
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
    let me = crate::testdb::http::client_for(&state, u).await;
    async fn sub(me: &crate::testdb::http::Client, token: &str) -> String {
        String::from_utf8(
            me.get(&format!("/test/sub/{token}?format=clash"))
                .await
                .body,
        )
        .unwrap()
    }
    async fn portal(me: &crate::testdb::http::Client) -> Vec<String> {
        me.get("/test/api/v1/me/nodes")
            .await
            .json()
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["entrance"].as_str().unwrap().to_string())
            .collect()
    }
    assert!(sub(&me, &token).await.contains("IPLC"));
    assert_eq!(portal(&me).await, vec!["直连", "IPLC"]);
    for _ in 0..crate::config::ENTRANCE_HEALTH_FAILURES {
        record(&db.pool, e, Err("timeout".into())).await.unwrap();
    }
    let body = sub(&me, &token).await;
    assert!(!body.contains("IPLC") && body.contains("直连"), "{body}");
    assert_eq!(portal(&me).await, vec!["直连"]);
    // The alert facts carry it.
    let mut tx = db.pool.begin().await.unwrap();
    let settings = crate::alerts::load(&mut tx).await.unwrap();
    let monitored = crate::alerts::eval::gather(&state, &mut tx, &settings)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    let m = monitored.iter().find(|m| m.id == n).unwrap();
    assert_eq!(
        m.facts.hidden_entrances,
        vec![("IPLC".to_string(), Some("timeout".to_string()))]
    );
    record(&db.pool, e, Ok(())).await.unwrap();
    assert!(sub(&me, &token).await.contains("IPLC"));
    drop(state);
    db.drop().await;
}
