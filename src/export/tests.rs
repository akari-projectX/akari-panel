//! Export tests (real database): admin only, BOM + parseable CSV, formula
//! cells neutralised, the users export follows the list filters, orders by
//! date range / status / via, traffic per day and per node, more rows than
//! one page (streaming), coded 400s, one audit row per export.

use axum::http::StatusCode;
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::client_for;

async fn setup() -> Option<(TestDb, AppState, crate::testdb::http::Client)> {
    let db = TestDb::new().await?;
    let st = AppState::for_test(db.pool.clone()).await;
    let admin = db.admin().await;
    let c = client_for(&st, admin).await;
    Some((db, st, c))
}

fn rows(body: &[u8]) -> Vec<Vec<String>> {
    assert!(body.starts_with(csvx::BOM), "BOM first");
    csvx::parse(body).expect("well-formed CSV")
}

async fn audits(db: &TestDb, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = $1")
        .bind(action)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn users_export_follows_filters_and_escapes() {
    let Some((db, st, c)) = setup().await else {
        return;
    };
    // An address that would be a formula.
    let evil = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, email, email_verified_at) \
         VALUES ($1, '=hyperlink(\"x\")@example.com', now())",
    )
    .bind(evil)
    .execute(&db.pool)
    .await
    .unwrap();
    let expired = db.user().await;
    sqlx::query("UPDATE users SET expires_at = now() - interval '1 day' WHERE id = $1")
        .bind(expired)
        .execute(&db.pool)
        .await
        .unwrap();
    // More than one page of plain users (streamed in chunks).
    sqlx::query(
        "INSERT INTO users (id, email) SELECT gen_random_uuid(), 'bulk-' || g || '@example.com' \
         FROM generate_series(1, 2100) g",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let r = c.get("/test/api/v1/users/export.csv?role=user").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers["content-type"], "text/csv; charset=utf-8");
    assert_eq!(r.headers["cache-control"], "no-store");
    assert!(
        r.headers["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment; filename=\"akari-users-")
    );
    let all = rows(&r.body);
    assert_eq!(all[0][0], "id");
    assert_eq!(
        all.len(),
        1 + 2102,
        "header + every user, admin filtered out"
    );
    let ev = all.iter().find(|r| r[0] == evil.to_string()).unwrap();
    assert_eq!(
        ev[1], "'=hyperlink(\"x\")@example.com",
        "formula neutralised"
    );
    assert_eq!(ev[2], "true");
    let ex = all.iter().find(|r| r[0] == expired.to_string()).unwrap();
    assert_eq!(ex[4], "expired", "status column = console badge");
    // The list's filters apply.
    let r = c.get("/test/api/v1/users/export.csv?status=expired").await;
    assert_eq!(rows(&r.body).len(), 2);
    let r = c.get("/test/api/v1/users/export.csv?status=bogus").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "user.status_filter_invalid");
    let r = c.get("/test/api/v1/users/export.csv?nope=1").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        audits(&db, "export.users").await,
        2,
        "one per successful export"
    );
    // Not for users.
    let uc = client_for(&st, expired).await;
    assert_eq!(
        uc.get("/test/api/v1/users/export.csv").await.status,
        StatusCode::UNAUTHORIZED
    );
    let plain = db.user().await;
    let uc = client_for(&st, plain).await;
    assert_eq!(
        uc.get("/test/api/v1/users/export.csv").await.status,
        StatusCode::FORBIDDEN
    );
    db.drop().await;
}

#[tokio::test]
async fn orders_export_range_status_and_manual_flag() {
    let Some((db, _st, c)) = setup().await else {
        return;
    };
    let u = db.user().await;
    let plan = Uuid::new_v4();
    sqlx::query("INSERT INTO plans (id, name, reset_period) VALUES ($1, '+plan', 'none')")
        .bind(plan)
        .execute(&db.pool)
        .await
        .unwrap();
    let ins = |days_ago: i32, status: &'static str, via: Option<&'static str>, gift: i64| {
        let pool = db.pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO orders (id, out_trade_no, user_id, user_label, plan_id, plan_name, \
                 amount_cents, period, period_days, list_price_cents, gift_cents, subject, \
                 expires_at, created_at, status, paid_at, paid_via, ended_at) \
                 VALUES (gen_random_uuid(), 'AK' || replace(gen_random_uuid()::text, '-', ''), \
                 $1, '@user', $2, '+plan', 1000 - $6, 'days', 30, 1000, $6, 's', now(), \
                 now() - make_interval(days => $3), $4, \
                 CASE WHEN $4 = 'paid' THEN now() END, $5, \
                 CASE WHEN $4 = 'cancelled' THEN now() END)",
            )
            .bind(u)
            .bind(plan)
            .bind(days_ago)
            .bind(status)
            .bind(via)
            .bind(gift)
            .execute(&pool)
            .await
            .unwrap();
        }
    };
    ins(0, "paid", Some("notify"), 0).await;
    ins(1, "paid", Some("manual"), 1000).await;
    ins(2, "cancelled", None, 0).await;
    ins(40, "paid", Some("query"), 0).await;
    let r = c.get("/test/api/v1/orders/export.csv").await;
    assert_eq!(r.status, StatusCode::OK);
    let all = rows(&r.body);
    assert_eq!(all.len(), 1 + 3, "default range = last 30 days");
    let idx = |name: &str| all[0].iter().position(|h| h == name).unwrap();
    let manual: Vec<_> = all[1..]
        .iter()
        .filter(|r| r[idx("manual")] == "true")
        .collect();
    assert_eq!(manual.len(), 1);
    assert_eq!(manual[0][idx("gift_cents")], "1000");
    assert_eq!(manual[0][idx("amount_cents")], "0");
    assert_eq!(all[1][idx("user_label")], "'@user");
    assert_eq!(all[1][idx("plan_name")], "'+plan");
    let r = c
        .get("/test/api/v1/orders/export.csv?status=paid&via=manual")
        .await;
    assert_eq!(rows(&r.body).len(), 2);
    let today: NaiveDate = sqlx::query_scalar("SELECT akari_site_day(now())")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let r = c
        .get(&format!(
            "/test/api/v1/orders/export.csv?from={}&to={}",
            today - Duration::days(45),
            today
        ))
        .await;
    assert_eq!(rows(&r.body).len(), 1 + 4);
    for (q, code) in [
        ("status=nope", "request.status_invalid"),
        ("via=cash", "export.via_invalid"),
        ("from=2026-02-01&to=2026-01-01", "export.range_invalid"),
        ("from=2024-01-01&to=2026-01-01", "export.range_too_long"),
    ] {
        let r = c.get(&format!("/test/api/v1/orders/export.csv?{q}")).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{q}");
        assert_eq!(r.json()["code"], code, "{q}");
    }
    assert_eq!(audits(&db, "export.orders").await, 3);
    db.drop().await;
}

#[tokio::test]
async fn traffic_export_days_and_nodes() {
    let Some((db, _st, c)) = setup().await else {
        return;
    };
    let n = db.node().await;
    let today: NaiveDate = sqlx::query_scalar("SELECT akari_site_day(now())")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO traffic_entrance_daily \
         (entrance_id, node_id, day, up_bytes, down_bytes, billed_bytes, users) \
         VALUES ($1, $1, $2, 10, 20, 30, 2), ($1, $1, $3, 1, 2, 3, 1)",
    )
    .bind(n)
    .bind(today)
    .bind(today - Duration::days(1))
    .execute(&db.pool)
    .await
    .unwrap();
    let r = c.get("/test/api/v1/traffic/export.csv").await;
    let all = rows(&r.body);
    assert_eq!(
        all[0],
        vec!["day", "up_bytes", "down_bytes", "billed_bytes", "users"]
    );
    assert_eq!(all.len(), 3);
    assert_eq!(
        all[2],
        vec![
            today.to_string(),
            "10".into(),
            "20".into(),
            "30".into(),
            "2".into()
        ]
    );
    let r = c.get("/test/api/v1/traffic/export.csv?group=node").await;
    let all = rows(&r.body);
    assert_eq!(all.len(), 2);
    assert_eq!(all[1][0], n.to_string());
    assert_eq!(all[1][2], "11");
    let r = c.get("/test/api/v1/traffic/export.csv?group=user").await;
    assert_eq!(r.json()["code"], "export.group_invalid");
    assert_eq!(audits(&db, "export.traffic").await, 2);
    db.drop().await;
}
