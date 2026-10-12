//! Dashboard aggregates on a real database (every source, window edges).

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;

async fn today_start(db: &TestDb) -> DateTime<Utc> {
    type Bounds = (
        DateTime<Utc>,
        String,
        chrono::NaiveDate,
        DateTime<Utc>,
        DateTime<Utc>,
        DateTime<Utc>,
    );
    let (_, _, _, d1, _, _): Bounds = sqlx::query_as(BOUNDS_SQL)
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
         created_at, action) VALUES ($1, $2, $3, 'u', 'p', $4, $4, 'days', 30, 's', $5, 'paid', $5, \
         'notify', $5, 'new')",
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

/// A paid order with a balance part (held), `channel` cents through the
/// payment channel.
async fn balance_order(
    db: &TestDb,
    user: Uuid,
    balance: i64,
    channel: i64,
    paid_at: DateTime<Utc>,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO orders (id, out_trade_no, user_id, user_label, plan_name, amount_cents, \
         list_price_cents, balance_cents, balance_state, period, period_days, subject, \
         expires_at, status, paid_at, paid_via, created_at, action) VALUES ($1, $2, $3, 'u', \
         'p', $4, $4 + $5, $5, 'held', 'days', 30, 's', $6, 'paid', $6, \
         CASE WHEN $4 > 0 THEN 'notify' ELSE 'balance' END, $6, 'new')",
    )
    .bind(id)
    .bind(format!("AKT{}", id.simple()))
    .bind(user)
    .bind(channel)
    .bind(balance)
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
    assert_eq!(d.pending_detail, PendingDetail::default());
    assert_eq!(d.subscribers_7d, 0);
    assert!(d.latest_orders.is_empty());
    assert_eq!(d.today_start, d1);
    // Q3: local midnight of the site day (Asia/Shanghai = 16:00 UTC).
    assert_eq!(d.timezone, "Asia/Shanghai");
    assert_eq!(
        d1,
        d.today_date.and_hms_opt(0, 0, 0).unwrap().and_utc() - Duration::hours(8)
    );

    // Revenue windows: today, 2 days ago (7d), 20 days ago (30d), 40 days
    // ago (none); exactly at the window start counts.
    paid_order(&db, u, 100, d1).await;
    paid_order(&db, u, 200, d1 - Duration::days(2)).await;
    paid_order(&db, u, 400, d1 - Duration::days(20)).await;
    paid_order(&db, u, 800, d1 - Duration::days(40)).await;
    // Refunded today, paid on an earlier day (the refund lowers today's
    // net, the payment stays on its own day):
    // A: 1600 paid 6 days ago, 600 refunded in the provider's console;
    // B: 1000 list = 300 balance + 700 channel, 10 days ago, all to the
    //    balance: only the 700 channel part reverses revenue;
    // C: paid fully from the balance yesterday (no revenue), refunded.
    let a = paid_order(&db, u, 1600, d1 - Duration::days(6)).await;
    let b = balance_order(&db, u, 300, 700, d1 - Duration::days(10)).await;
    let c = balance_order(&db, u, 500, 0, d1 - Duration::days(1)).await;
    for (id, to_balance, external_cents) in
        [(a, false, Some(600)), (b, true, None), (c, false, None)]
    {
        let mut tx = db.pool.begin().await.unwrap();
        crate::billing::refund::apply_refund(
            &mut tx,
            &crate::audit::Actor::system(),
            id,
            &crate::billing::refund::Refund {
                reason: "r",
                to_balance,
                external_cents,
                keep_plan: true,
                portal: None,
            },
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
    let split: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT refund_cents, refund_gateway_cents FROM orders WHERE id = ANY($1) \
         ORDER BY amount_cents DESC",
    )
    .bind(vec![a, b, c])
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(split, [(600, 600), (1000, 700), (500, 0)]);
    // Not revenue: pending and before the window.
    sqlx::query(
        "INSERT INTO orders (id, out_trade_no, user_id, user_label, plan_name, amount_cents, \
         list_price_cents, period, period_days, subject, expires_at, action) VALUES ($1, \
         'AKTpending', $2, 'u', 'p', 999, 999, 'days', 30, 's', now() + interval '15 minutes', \
         'new')",
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
            revenue_cents: 100 - 1300,
            gross_cents: 100,
            orders: 1,
            refunds_cents: 1300,
            signups: 1,
            ..Default::default()
        }
    );
    assert_eq!(
        d.d7,
        Window {
            revenue_cents: 1900 - 1300,
            gross_cents: 1900,
            orders: 4,
            refunds_cents: 1300,
            signups: 1,
            ..Default::default()
        }
    );
    assert_eq!(
        d.d30,
        Window {
            revenue_cents: 3000 - 1300,
            gross_cents: 3000,
            orders: 6,
            refunds_cents: 1300,
            signups: 1,
            ..Default::default()
        }
    );
    assert_eq!(d.users_total, 2, "role=user only");
    assert_eq!(d.latest_orders.len(), 8);
    assert_eq!(d.latest_orders[0].status, "pending", "newest first");
    assert_eq!(d.latest_orders[0].action, "new");
    assert!(d.latest_orders[0].fulfilled_at.is_none());

    // Subscribers.
    let plan = Uuid::new_v4();
    sqlx::query("INSERT INTO plans (id, name, reset_period) VALUES ($1, 'p', 'none')")
        .bind(plan)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO user_plans (id, user_id, plan_id, status, period_anchor, term_kind) \
         VALUES ($1, $2, $3, 'active', now(), 'onetime')",
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
        "UPDATE servers SET status = 'online', last_seen_at = now(), cert_serial = '41' WHERE id = $1",
    )
    .bind(online_node)
    .execute(&db.pool)
    .await
    .unwrap();
    let offline = db.node().await;
    sqlx::query("UPDATE servers SET cert_serial = '42' WHERE id = $1")
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
    sqlx::query("UPDATE servers SET deleting_at = now() WHERE id = $1")
        .bind(deleting)
        .execute(&db.pool)
        .await
        .unwrap();
    // A stale "online" row (last seen 5 minutes ago) is offline.
    let stale = db.node().await;
    sqlx::query(
        "UPDATE servers SET status = 'online', last_seen_at = now() - interval '5 minutes', \
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
        sqlx::query(
            "INSERT INTO server_alerts (server_id, kind, status) VALUES ($1, $2, 'firing')",
        )
        .bind(node)
        .bind(kind)
        .execute(&db.pool)
        .await
        .unwrap();
    }
    // The offline alert started first and was acknowledged.
    sqlx::query(
        "UPDATE server_alerts SET fired_at = now() - interval '1 hour', acked_at = now(), \
         acked_by = 'lam' WHERE server_id = $1",
    )
    .bind(offline)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO server_alerts (server_id, kind, status, resolved_at, fired_at) \
         VALUES ($1, 'disk', 'resolved', now(), now() - interval '2 hours')",
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
        "INSERT INTO withdrawals (id, user_id, user_label, amount_cents, chain, address) \
         VALUES ($1, $2, 'u', 100, 'trc20', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')",
    )
    .bind(Uuid::new_v4())
    .bind(u)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO mail_outbox (kind, to_addr, subject, body_text, body_html, status, settled_at) \
         VALUES ('test', 'a@b.c', 's', 't', 'h', 'dead', now() - interval '1 minute'), \
                ('test', 'a@b.c', 's', 't', 'h', 'sent', now()), \
                ('test', 'a@b.c', 's', 't', 'h', 'pending', NULL)",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO mail_outbox (kind, to_addr, subject, body_text, body_html, status, \
         last_error, settled_at) VALUES ('test', 'a@b.c', 's', 't', 'h', 'dead', \
         '550 no such user', now())",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    // The first ticket's user wrote again 3 hours ago: it waits longest.
    sqlx::query(
        "UPDATE tickets SET last_user_at = now() - interval '3 hours' \
         WHERE id = (SELECT id FROM tickets WHERE subject = 's')",
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
        d.servers,
        Servers {
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
            mail_failed: 2,
            orders_unfulfilled: 1,
            alerts_firing: 3,
        }
    );
    let offline_name: String = sqlx::query_scalar("SELECT name FROM servers WHERE id = $1")
        .bind(offline)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let pd = &d.pending_detail;
    assert_eq!(pd.alert_oldest_kind.as_deref(), Some("offline"));
    assert_eq!(
        pd.alert_oldest_server.as_deref(),
        Some(offline_name.as_str())
    );
    assert!(pd.alert_oldest_at.unwrap() < d.at - Duration::minutes(59));
    assert_eq!(pd.alerts_unacked, 2, "the acknowledged one is not counted");
    assert_eq!(pd.order_sample_id, Some(broken));
    assert_eq!(pd.order_sample_error.as_deref(), Some("plan disabled"));
    assert!(pd.order_sample_no.as_deref().unwrap().starts_with("AKT"));
    assert_eq!(pd.withdrawals_cents, 100);
    let waited = d.at - pd.ticket_oldest_at.unwrap();
    assert!(waited > Duration::minutes(179) && waited < Duration::minutes(181));
    assert_eq!(
        pd.mail_last_error.as_deref(),
        Some("550 no such user"),
        "the newest"
    );
    assert_eq!(d.subscribers_7d, 1);
    assert_eq!(d.d30.revenue_cents, 1700, "the 50-day-old order is outside");
    assert_eq!(d.latest_orders.len() as i64, LATEST_ORDERS, "capped");
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
        "servers",
        "pending",
        "latest_orders",
        "online_users",
        "series",
        "prev_today",
        "pending_detail",
        "subscribers_7d",
    ] {
        assert!(j.get(k).is_some(), "{k}: {j}");
    }
    assert_eq!(j["pending_detail"]["withdrawals_cents"], 0);
    assert!(j["pending_detail"]["alert_oldest_at"].is_null());
    assert_eq!(
        j["series"].as_array().map(Vec::len),
        Some(SERIES_DAYS as usize)
    );
    for k in [
        "day",
        "revenue_cents",
        "direct_bytes",
        "relay_bytes",
        "other_bytes",
        "signups",
    ] {
        assert!(j["series"][0].get(k).is_some(), "series.{k}: {j}");
    }
    db.drop().await;
}

/// Inserts one `traffic_entrance_daily` row.
async fn traffic(
    db: &TestDb,
    entrance: Uuid,
    node: Uuid,
    day: chrono::NaiveDate,
    up: i64,
    down: i64,
) {
    sqlx::query(
        "INSERT INTO traffic_entrance_daily (entrance_id, day, node_id, up_bytes, down_bytes) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(entrance)
    .bind(day)
    .bind(node)
    .bind(up)
    .bind(down)
    .execute(&db.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn daily_series_and_prev_today() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let d1 = today_start(&db).await;
    let u = db.user().await; // signed up today
    // Paid: today, 2 days ago, 20 days ago, the series' first day at its
    // start, and one day before the series (not in it).
    paid_order(&db, u, 100, d1).await;
    paid_order(&db, u, 200, d1 - Duration::days(2)).await;
    paid_order(&db, u, 400, d1 - Duration::days(20)).await;
    paid_order(&db, u, 50, d1 - Duration::days(SERIES_DAYS - 1)).await;
    paid_order(&db, u, 800, d1 - Duration::days(SERIES_DAYS)).await;
    // Yesterday at its start (in prev_today) and a day before now + 1 min
    // (after now's time of day yesterday: not in prev_today).
    paid_order(&db, u, 70, d1 - Duration::days(1)).await;
    let late: DateTime<Utc> =
        sqlx::query_scalar("SELECT now() - interval '1 day' + interval '1 minute'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    paid_order(&db, u, 9, late).await;
    sqlx::query("INSERT INTO users (id, email, created_at) VALUES ($1, 'y@example.com', $2)")
        .bind(Uuid::new_v4())
        .bind(d1 - Duration::days(1))
        .execute(&db.pool)
        .await
        .unwrap();
    // Paid 6 days ago, 600 refunded today in the provider's console: on
    // today's row, not the payment's.
    let a = paid_order(&db, u, 1600, d1 - Duration::days(6)).await;
    let mut tx = db.pool.begin().await.unwrap();
    crate::billing::refund::apply_refund(
        &mut tx,
        &crate::audit::Actor::system(),
        a,
        &crate::billing::refund::Refund {
            reason: "r",
            to_balance: false,
            external_cents: Some(600),
            keep_plan: true,
            portal: None,
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    // Traffic by entrance kind: direct, relay, a deleted entrance, and a
    // day before the series.
    let n = db.node().await;
    let direct = db.direct(n).await;
    let relay = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO entrances (id, node_id, server_id, kind, name, connect_host, connect_port, \
         wire_no, listen_port, source_cidrs) VALUES ($1, $2, $2, 'relay', 'IPLC', 'r.example', 30001, \
         1, 20443, '{203.0.113.7/32}')",
    )
    .bind(relay)
    .bind(n)
    .execute(&db.pool)
    .await
    .unwrap();
    let (_, _, today, ..): (
        DateTime<Utc>,
        String,
        chrono::NaiveDate,
        DateTime<Utc>,
        DateTime<Utc>,
        DateTime<Utc>,
    ) = sqlx::query_as(BOUNDS_SQL)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    traffic(&db, direct, n, today, 10, 20).await;
    traffic(&db, relay, n, today, 5, 5).await;
    traffic(&db, Uuid::new_v4(), n, today - Duration::days(1), 7, 0).await;
    traffic(&db, direct, n, today - Duration::days(SERIES_DAYS), 1000, 0).await;

    let (d, _) = read(&db.pool).await.unwrap();
    let s = &d.series;
    assert_eq!(s.len() as i64, SERIES_DAYS, "every day present");
    assert_eq!(s.last().unwrap().day, d.today_date);
    assert_eq!(s[0].day, d.today_date - Duration::days(SERIES_DAYS - 1));
    assert_eq!(
        s[s.len() - 1],
        Day {
            day: d.today_date,
            revenue_cents: 100 - 600,
            gross_cents: 100,
            refunds_cents: 600,
            orders: 1,
            signups: 1,
            direct_bytes: 30,
            relay_bytes: 10,
            other_bytes: 0,
        }
    );
    assert_eq!(s[s.len() - 2].other_bytes, 7, "a deleted entrance's bytes");
    assert_eq!(s[s.len() - 2].signups, 1);
    assert_eq!(s[s.len() - 3].gross_cents, 200);
    assert_eq!(
        s[s.len() - 7].gross_cents,
        1600,
        "the payment stays on its own day"
    );
    assert_eq!(
        s[0].gross_cents, 50,
        "the first day from its local midnight"
    );
    let total: i64 = s.iter().map(|x| x.gross_cents).sum();
    assert_eq!(
        total,
        100 + 200 + 400 + 50 + 70 + 9 + 1600,
        "nothing before the series"
    );
    // The series agrees with the windows.
    for (n, w) in [(1, &d.today), (7, &d.d7), (30, &d.d30)] {
        let tail = &s[s.len() - n..];
        assert_eq!(
            tail.iter().map(|x| x.gross_cents).sum::<i64>(),
            w.gross_cents,
            "{n}d gross"
        );
        assert_eq!(
            tail.iter().map(|x| x.refunds_cents).sum::<i64>(),
            w.refunds_cents,
            "{n}d refunds"
        );
        assert_eq!(
            tail.iter().map(|x| x.revenue_cents).sum::<i64>(),
            w.revenue_cents,
            "{n}d net"
        );
        assert_eq!(
            tail.iter().map(|x| x.orders).sum::<i64>(),
            w.orders,
            "{n}d orders"
        );
        assert_eq!(
            tail.iter().map(|x| x.signups).sum::<i64>(),
            w.signups,
            "{n}d signups"
        );
    }
    assert_eq!(
        d.prev_today,
        PrevToday {
            revenue_cents: 70,
            gross_cents: 70,
            refunds_cents: 0,
            orders: 1,
            signups: 1,
        }
    );
}
