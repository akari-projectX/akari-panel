//! Dashboard aggregates on a real database (every source, window edges).

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;

async fn today_start(db: &TestDb) -> DateTime<Utc> {
    let (_, d1, _, _): (DateTime<Utc>, DateTime<Utc>, DateTime<Utc>, DateTime<Utc>) =
        sqlx::query_as(BOUNDS_SQL)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    d1
}

async fn paid_order(db: &TestDb, user: Uuid, cents: i64, paid_at: DateTime<Utc>) -> Uuid {
    let id = Uuid::new_v4();
    let otn = format!("AKT{}", id.simple());
    sqlx::query(
        "INSERT INTO orders (id, out_trade_no, user_id, user_label, plan_name, amount_cents, \
         list_price_cents, period, period_days, subject, expires_at, status, paid_at, paid_via, \
         created_at) VALUES ($1, $2, $3, 'u', 'p', $4, $4, 'days', 30, 's', $5, 'paid', $5, \
         'notify', $5)",
    )
    .bind(id)
    .bind(otn)
    .bind(user)
    .bind(cents)
    .bind(paid_at)
    .execute(&db.pool)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn aggregates_every_source() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let d1 = today_start(&db).await;
    let u = db.user().await;

    // Empty panel apart from one user: all zero.
    let (d, online) = read(&db.pool).await.unwrap();
    assert_eq!(
        d.today,
        Window {
            signups: 1,
            ..Window::default()
        }
    );
    assert_eq!(d.users_total, 1);
    assert_eq!(d.subscribers, 0);
    assert!(online.is_empty());
    assert_eq!(d.pending, Pending::default());
    assert!(d.latest_orders.is_empty());
    assert_eq!(d.today_start, d1);

    // Revenue windows: today, 2 days ago (7d), 20 days ago (30d), 40 days
    // ago (none); exactly at the window start counts.
    paid_order(&db, u, 100, d1).await;
    paid_order(&db, u, 200, d1 - Duration::days(2)).await;
    paid_order(&db, u, 400, d1 - Duration::days(20)).await;
    paid_order(&db, u, 800, d1 - Duration::days(40)).await;
    let refunded = paid_order(&db, u, 1600, d1 - Duration::days(6)).await;
    sqlx::query(
        "UPDATE orders SET refunded_at = $2, refund_cents = 50, refund_reason = 'r' WHERE id = $1",
    )
    .bind(refunded)
    .bind(d1 + Duration::seconds(1))
    .execute(&db.pool)
    .await
    .unwrap();
    // Not revenue: pending and before the window.
    sqlx::query(
        "INSERT INTO orders (id, out_trade_no, user_id, user_label, plan_name, amount_cents, \
         list_price_cents, period, period_days, subject, expires_at) VALUES ($1, 'AKTpending', \
         $2, 'u', 'p', 999, 999, 'days', 30, 's', now() + interval '15 minutes')",
    )
    .bind(Uuid::new_v4())
    .bind(u)
    .execute(&db.pool)
    .await
    .unwrap();
    // Sign-ups: an old user (outside 30d) and an admin (not counted).
    sqlx::query(
        "INSERT INTO users (id, email, created_at) VALUES ($1, 'old@example.com', now() - interval '90 days')",
    )
    .bind(Uuid::new_v4())
    .execute(&db.pool)
    .await
    .unwrap();
    db.admin().await;

    let (d, _) = read(&db.pool).await.unwrap();
    assert_eq!(
        d.today,
        Window {
            revenue_cents: 100,
            orders: 1,
            refunds_cents: 50,
            signups: 1,
            ..Default::default()
        }
    );
    assert_eq!(
        d.d7,
        Window {
            revenue_cents: 1900,
            orders: 3,
            refunds_cents: 50,
            signups: 1,
            ..Default::default()
        }
    );
    assert_eq!(
        d.d30,
        Window {
            revenue_cents: 2300,
            orders: 4,
            refunds_cents: 50,
            signups: 1,
            ..Default::default()
        }
    );
    assert_eq!(d.users_total, 2, "role=user only");
    assert_eq!(d.latest_orders.len(), 6);
    assert_eq!(d.latest_orders[0].status, "pending", "newest first");

    // Subscribers.
    let plan = Uuid::new_v4();
    sqlx::query("INSERT INTO plans (id, name, reset_period) VALUES ($1, 'p', 'none')")
        .bind(plan)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO user_plans (id, user_id, plan_id, status, period_anchor) \
         VALUES ($1, $2, $3, 'active', now())",
    )
    .bind(Uuid::new_v4())
    .bind(u)
    .bind(plan)
    .execute(&db.pool)
    .await
    .unwrap();

    // Nodes: online (alerting), offline (enrolled), pending, disabled, deleting.
    let online_node = db.node().await;
    sqlx::query(
        "UPDATE nodes SET status = 'online', last_seen_at = now(), cert_serial = '41' WHERE id = $1",
    )
    .bind(online_node)
    .execute(&db.pool)
    .await
    .unwrap();
    let offline = db.node().await;
    sqlx::query("UPDATE nodes SET cert_serial = '42' WHERE id = $1")
        .bind(offline)
        .execute(&db.pool)
        .await
        .unwrap();
    let _pending = db.node().await;
    let disabled = db.node().await;
    sqlx::query("UPDATE nodes SET enabled = false WHERE id = $1")
        .bind(disabled)
        .execute(&db.pool)
        .await
        .unwrap();
    let deleting = db.node().await;
    sqlx::query("UPDATE nodes SET deleting_at = now(), enabled = false WHERE id = $1")
        .bind(deleting)
        .execute(&db.pool)
        .await
        .unwrap();
    // A stale "online" row (last seen 5 minutes ago) is offline.
    let stale = db.node().await;
    sqlx::query(
        "UPDATE nodes SET status = 'online', last_seen_at = now() - interval '5 minutes', \
         cert_serial = '43' WHERE id = $1",
    )
    .bind(stale)
    .execute(&db.pool)
    .await
    .unwrap();
    for (node, kind) in [
        (online_node, "cpu"),
        (online_node, "memory"),
        (offline, "offline"),
    ] {
        sqlx::query("INSERT INTO node_alerts (node_id, kind, status) VALUES ($1, $2, 'firing')")
            .bind(node)
            .bind(kind)
            .execute(&db.pool)
            .await
            .unwrap();
    }
    sqlx::query(
        "INSERT INTO node_alerts (node_id, kind, status, resolved_at) \
         VALUES ($1, 'disk', 'resolved', now())",
    )
    .bind(disabled)
    .execute(&db.pool)
    .await
    .unwrap();

    // Pending work.
    sqlx::query(
        "INSERT INTO tickets (id, user_id, subject, category, priority) \
         VALUES ($1, $2, 's', 'general', 'normal'), ($3, $2, 't', 'general', 'normal')",
    )
    .bind(Uuid::new_v4())
    .bind(u)
    .bind(Uuid::new_v4())
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO tickets (id, user_id, subject, category, priority, status) \
         VALUES ($1, $2, 'a', 'general', 'normal', 'answered')",
    )
    .bind(Uuid::new_v4())
    .bind(u)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO withdrawals (id, user_id, user_label, amount_cents, method, account) \
         VALUES ($1, $2, 'u', 100, 'alipay', 'a')",
    )
    .bind(Uuid::new_v4())
    .bind(u)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO mail_outbox (kind, to_addr, subject, body_text, body_html, status, settled_at) \
         VALUES ('test', 'a@b.c', 's', 't', 'h', 'dead', now()), \
                ('test', 'a@b.c', 's', 't', 'h', 'sent', now()), \
                ('test', 'a@b.c', 's', 't', 'h', 'pending', NULL)",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let broken = paid_order(&db, u, 300, d1 - Duration::days(50)).await;
    sqlx::query("UPDATE orders SET fulfil_error = 'plan disabled' WHERE id = $1")
        .bind(broken)
        .execute(&db.pool)
        .await
        .unwrap();

    let (d, online) = read(&db.pool).await.unwrap();
    assert_eq!(d.subscribers, 1);
    assert_eq!(
        d.nodes,
        Nodes {
            total: 5,
            online: 1,
            offline: 2,
            disabled: 1,
            pending: 1,
            alerting: 2
        }
    );
    assert_eq!(online, vec![online_node]);
    assert_eq!(
        d.pending,
        Pending {
            tickets_open: 2,
            withdrawals: 1,
            mail_failed: 1,
            orders_unfulfilled: 1,
            alerts_firing: 3,
        }
    );
    assert_eq!(d.d30.revenue_cents, 2300, "the 50-day-old order is outside");
    assert_eq!(d.latest_orders.len(), 7, "all of them (< LATEST_ORDERS)");
    db.drop().await;
}

#[test]
fn heartbeat_users_are_read_and_clamped() {
    assert_eq!(blob_users(r#"{"metrics":{"online_users":7}}"#), 7);
    assert_eq!(blob_users(r#"{"metrics":{"online_users":-3}}"#), 0);
    assert_eq!(
        blob_users(r#"{"metrics":{"online_users":9999999999}}"#),
        1_000_000
    );
    assert_eq!(blob_users(r#"{"connections":3}"#), 0);
    assert_eq!(blob_users("not json"), 0);
}

#[tokio::test]
async fn http_admin_only_and_shape() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    use crate::testdb::http::client_for;
    let user = db.user().await;
    let r = client_for(&state, user)
        .await
        .get("/test/api/v1/dashboard")
        .await;
    assert_eq!(r.status, axum::http::StatusCode::FORBIDDEN);
    let admin = db.admin().await;
    let r = client_for(&state, admin)
        .await
        .get("/test/api/v1/dashboard")
        .await;
    assert_eq!(r.status, axum::http::StatusCode::OK, "{:?}", r.json());
    let j = r.json();
    for k in [
        "today",
        "d7",
        "d30",
        "nodes",
        "pending",
        "latest_orders",
        "online_users",
    ] {
        assert!(j.get(k).is_some(), "{k}: {j}");
    }
    db.drop().await;
}
