use axum::http::StatusCode;
use serde_json::json;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, rand_ip};

fn d(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

const TODAY: &str = "2026-10-02";

fn p(q: &str, params: Params) -> Result<Range, String> {
    parse_query(Some(q), d(TODAY), params)
}

#[test]
fn parse_defaults_and_partial_ranges() {
    let r = parse_query(None, d(TODAY), Params::User).unwrap();
    assert_eq!(
        r,
        Range {
            from: d("2026-09-03"),
            to: d(TODAY),
            group: Group::Day,
            limit: DEFAULT_LIMIT
        }
    );
    assert_eq!(p("", Params::Me).unwrap(), r);
    // Only `to`: the 30 days ending there.
    let r = p("to=2026-01-30", Params::Me).unwrap();
    assert_eq!((r.from, r.to), (d("2026-01-01"), d("2026-01-30")));
    // Only `from`: 30 days from there, capped at today.
    let r = p("from=2026-01-01", Params::Me).unwrap();
    assert_eq!((r.from, r.to), (d("2026-01-01"), d("2026-01-30")));
    let r = p("from=2026-09-30", Params::Me).unwrap();
    assert_eq!((r.from, r.to), (d("2026-09-30"), d(TODAY)));
    // A future `from` alone is a one-day... no: up to 30 days after it.
    let r = p("from=2027-01-01", Params::Me).unwrap();
    assert_eq!((r.from, r.to), (d("2027-01-01"), d("2027-01-01")));
    // `to` near the lower bound clamps the default `from`.
    let r = p("to=2000-01-05", Params::Me).unwrap();
    assert_eq!((r.from, r.to), (d("2000-01-01"), d("2000-01-05")));
    // Percent-encoding is decoded.
    let r = p("from=2026%2D10%2D01&to=2026-10-02", Params::Me).unwrap();
    assert_eq!(r.from, d("2026-10-01"));
}

#[test]
fn parse_groups_limits_and_spans() {
    assert_eq!(
        p("group=entrance", Params::User).unwrap().group,
        Group::Entrance
    );
    assert_eq!(p("group=day", Params::User).unwrap().group, Group::Day);
    assert_eq!(p("group=month", Params::User).unwrap().group, Group::Month);
    assert!(p("group=week", Params::User).is_err());
    assert!(p("group=Day", Params::User).is_err());
    assert_eq!(p("limit=1", Params::Top).unwrap().limit, 1);
    assert_eq!(p("limit=100", Params::Top).unwrap().limit, 100);
    for bad in [
        "0",
        "101",
        "+5",
        "-1",
        "1e2",
        "",
        "x",
        "99999999999999999999",
    ] {
        assert!(p(&format!("limit={bad}"), Params::Top).is_err(), "{bad}");
    }
    // 366 days inclusive is the maximum.
    assert!(p("from=2025-01-01&to=2026-01-01", Params::Me).is_ok());
    assert!(p("from=2025-01-01&to=2026-01-02", Params::Me).is_err());
    assert!(p("from=2020-01-01&to=2026-01-01&group=month", Params::User).is_ok());
    assert!(p("from=2015-01-01&to=2026-01-01&group=month", Params::User).is_err());
    assert!(p("from=2026-10-02&to=2026-10-01", Params::Me).is_err());
    assert!(p("from=2026-10-02&to=2026-10-02", Params::Me).is_ok());
}

#[test]
fn parse_rejects_malformed_unknown_and_duplicate() {
    for bad in [
        "from=2026-1-01",
        "from=2026-02-30",
        "from=20261001",
        "from=2026/10/01",
        "from=+026-10-01",
        "from=1999-12-31",
        "from=3000-01-01",
        "from=２０２６-10-01",
        "to=2026-10-01T00:00",
        "to=",
        "from",
    ] {
        assert!(p(bad, Params::Me).is_err(), "{bad}");
    }
    assert_eq!(p("x=1", Params::Me).unwrap_err(), "unknown parameter");
    assert_eq!(p("group=day", Params::Me).unwrap_err(), "unknown parameter");
    assert_eq!(
        p("group=day", Params::Top).unwrap_err(),
        "unknown parameter"
    );
    assert_eq!(p("limit=5", Params::User).unwrap_err(), "unknown parameter");
    assert_eq!(p("limit=5", Params::Me).unwrap_err(), "unknown parameter");
    assert_eq!(
        p("from=2026-10-01&from=2026-10-01", Params::Me).unwrap_err(),
        "duplicate parameter"
    );
    for k in ["to", "group", "limit"] {
        let params = if k == "limit" {
            Params::Top
        } else {
            Params::User
        };
        let v = if k == "limit" {
            "1"
        } else if k == "group" {
            "day"
        } else {
            TODAY
        };
        assert!(p(&format!("{k}={v}&{k}={v}"), params).is_err());
    }
    assert_eq!(
        p(&"a".repeat(300), Params::Me).unwrap_err(),
        "query too long"
    );
}

#[test]
fn bytes_total_saturates() {
    let big = Bytes {
        up_bytes: i64::MAX,
        down_bytes: 1,
        billed_bytes: 2,
    };
    let t = total([big, big].iter());
    assert_eq!(t.up_bytes, i64::MAX);
    assert_eq!((t.down_bytes, t.billed_bytes), (2, 4));
    assert_eq!(Group::Entrance.as_str(), "entrance");
}

async fn admin_client(state: &AppState, db: &TestDb) -> Client {
    let admin = db.admin().await;
    let sv: i64 = sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
        .bind(admin)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let mut c = Client::new(state, rand_ip());
    c.cookie = Some(crate::auth::issue_token(state, admin, "admin", sv).unwrap());
    c
}

async fn user_client(state: &AppState, user: Uuid) -> Client {
    let mut c = Client::new(state, rand_ip());
    c.cookie = Some(crate::auth::issue_token(state, user, "user", 0).unwrap());
    c
}

/// The node's direct entrance (a deleted node: its id stands for a deleted
/// entrance).
async fn direct(db: &TestDb, node: Uuid) -> Uuid {
    sqlx::query_scalar("SELECT id FROM entrances WHERE node_id = $1 AND kind = 'direct'")
        .bind(node)
        .fetch_optional(&db.pool)
        .await
        .unwrap()
        .unwrap_or(node)
}

async fn daily(db: &TestDb, user: Uuid, day: NaiveDate, node: Uuid, b: (i64, i64, i64)) {
    let entrance = direct(db, node).await;
    sqlx::query(
        "INSERT INTO traffic_daily \
         (user_id, day, entrance_id, node_id, up_bytes, down_bytes, billed_bytes) \
         VALUES ($1, $2, $3, $7, $4, $5, $6)",
    )
    .bind(user)
    .bind(day)
    .bind(entrance)
    .bind(b.0)
    .bind(b.1)
    .bind(b.2)
    .bind(node)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO traffic_entrance_daily AS t \
         (entrance_id, node_id, day, up_bytes, down_bytes, billed_bytes, users) \
         VALUES ($1, $6, $2, $3, $4, $5, 1) ON CONFLICT (entrance_id, day) DO UPDATE SET \
         up_bytes = t.up_bytes + EXCLUDED.up_bytes, down_bytes = t.down_bytes + EXCLUDED.down_bytes, \
         billed_bytes = t.billed_bytes + EXCLUDED.billed_bytes, users = t.users + 1",
    )
    .bind(entrance)
    .bind(day)
    .bind(b.0)
    .bind(b.1)
    .bind(b.2)
    .bind(node)
    .execute(&db.pool)
    .await
    .unwrap();
}

fn bytes(v: &Value) -> (i64, i64, i64) {
    (
        v["up_bytes"].as_i64().unwrap(),
        v["down_bytes"].as_i64().unwrap(),
        v["billed_bytes"].as_i64().unwrap(),
    )
}

/// The four endpoints over seeded history: grouping, ordering, totals,
/// names (deleted / hidden), month grouping across the rollup, the
/// user's view holds only their own rows and no node ids, and every
/// permission / validation path.
#[tokio::test]
async fn endpoints_queries_and_permissions() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = admin_client(&state, &db).await;
    let (n1, u1) = db.member().await;
    let n2 = db.node().await; // hidden from users
    let gone = Uuid::new_v4(); // a deleted node: its history stays
    let u2 = db.user().await;
    let ghost = Uuid::new_v4(); // a deleted user
    sqlx::query("UPDATE nodes SET display_name = '香港 01' WHERE id = $1")
        .bind(n1)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE nodes SET visible = false, display_name = 'secret' WHERE id = $1")
        .bind(n2)
        .execute(&db.pool)
        .await
        .unwrap();
    // Q3: days are site days.
    let today: NaiveDate = sqlx::query_scalar("SELECT (now() AT TIME ZONE akari_site_tz())::date")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let y = today - Duration::days(1);
    let old = today - Duration::days(45);
    daily(&db, u1, today, n1, (10, 20, 15)).await;
    daily(&db, u1, y, n1, (1, 2, 3)).await;
    daily(&db, u1, y, n2, (100, 200, 300)).await;
    daily(&db, u1, today, gone, (5, 5, 5)).await;
    daily(&db, u1, old, n1, (7, 7, 7)).await;
    daily(&db, u2, today, n1, (1000, 1000, 2000)).await;
    daily(&db, ghost, today, n1, (1, 0, 1)).await;
    // A rolled-up month of u1 (older than the daily rows).
    let m = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
    sqlx::query(
        "INSERT INTO traffic_monthly \
         (user_id, month, entrance_id, node_id, up_bytes, down_bytes, billed_bytes) \
         VALUES ($1, $2, $3, $3, 50, 60, 70)",
    )
    .bind(u1)
    .bind(m)
    .bind(n1)
    .execute(&db.pool)
    .await
    .unwrap();

    // Admin: user per day (default 30 days: `old` is outside).
    let r = admin.get(&format!("/test/api/v1/users/{u1}/traffic")).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["group"], "day");
    assert_eq!(v["timezone"], "Asia/Shanghai");
    assert_eq!(v["to"], json!(today));
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{v}");
    assert_eq!(rows[0]["day"], json!(y));
    assert_eq!(bytes(&rows[0]), (101, 202, 303));
    assert_eq!(bytes(&rows[1]), (15, 25, 20));
    assert_eq!(bytes(&v["total"]), (116, 227, 323));
    assert!(v["daily_since"].is_string());
    // Per entrance (R43): most billed first, node and entrance names, kind
    // and the multiplier now; the deleted ones have none.
    let (e1, e2) = (direct(&db, n1).await, direct(&db, n2).await);
    sqlx::query("UPDATE entrances SET rate_permille = 2500 WHERE id = $1")
        .bind(e1)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = admin
        .get(&format!("/test/api/v1/users/{u1}/traffic?group=entrance"))
        .await;
    let v = r.json();
    assert_eq!(v["group"], "entrance");
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 3, "{v}");
    assert_eq!(rows[0]["entrance_id"], json!(e2));
    assert_eq!(rows[0]["node_id"], json!(n2));
    assert_eq!(rows[0]["node"], "secret");
    assert_eq!(rows[0]["entrance"], "直连");
    assert_eq!(rows[0]["kind"], "direct");
    assert_eq!(rows[0]["rate_now"], 1.0);
    assert_eq!(rows[1]["entrance_id"], json!(e1));
    assert_eq!(rows[1]["node"], "香港 01");
    assert_eq!(rows[1]["rate_now"], 2.5);
    assert_eq!(bytes(&rows[1]), (11, 22, 18));
    assert_eq!(rows[2]["node_id"], json!(gone));
    assert!(rows[2]["node"].is_null() && rows[2]["entrance"].is_null());
    assert!(rows[2]["rate_now"].is_null());
    assert_eq!(bytes(&v["total"]), (116, 227, 323));
    // Per month: rolled-up months + kept days, whole months.
    let from = m;
    let r = admin
        .get(&format!(
            "/test/api/v1/users/{u1}/traffic?group=month&from={from}&to={today}"
        ))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows[0]["day"], json!(m));
    assert_eq!(bytes(&rows[0]), (50, 60, 70));
    let sum: i64 = rows.iter().map(|r| bytes(r).2).sum();
    assert_eq!(sum, 70 + 323 + 7, "{v}");
    assert_eq!(bytes(&v["total"]).2, 400);

    // Node: per day (with user counts) + top users by raw bytes.
    let r = admin
        .get(&format!("/test/api/v1/nodes/{n1}/traffic?limit=2"))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    let days = v["days"].as_array().unwrap();
    assert_eq!(days.len(), 2, "{v}");
    assert_eq!(days[1]["users"], 3);
    let top = v["top_users"].as_array().unwrap();
    assert_eq!(top.len(), 2);
    assert_eq!(top[0]["user_id"], json!(u2));
    assert_eq!(top[0]["email"], json!(crate::testdb::test_email(u2)));
    assert_eq!(top[1]["user_id"], json!(u1));
    assert_eq!(bytes(&top[1]), (11, 22, 18));
    assert_eq!(bytes(&v["total"]), (1012, 1022, 2019));
    let r = admin.get(&format!("/test/api/v1/nodes/{n1}/traffic")).await;
    let top = r.json()["top_users"].as_array().unwrap().clone();
    assert_eq!(top.len(), 3);
    assert!(top[2]["email"].is_null(), "deleted user: {top:?}");

    // Fleet summary: per day over every node (deleted included), top nodes.
    let r = admin
        .get(&format!("/test/api/v1/traffic/summary?from={y}&to={today}"))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    let days = v["days"].as_array().unwrap();
    assert_eq!(days.len(), 2);
    assert_eq!(bytes(&days[0]), (101, 202, 303));
    assert_eq!(days[0]["users"], 2);
    assert_eq!(bytes(&days[1]), (1016, 1025, 2021));
    assert_eq!(days[1]["users"], 4);
    assert_eq!(bytes(&v["total"]), (1117, 1227, 2324));
    let top = v["top_nodes"].as_array().unwrap();
    assert_eq!(top.len(), 3);
    assert_eq!(top[0]["node_id"], json!(n1));
    assert_eq!(top[2]["node_id"], json!(gone));
    assert!(top[2]["name"].is_null());
    let r = admin.get("/test/api/v1/traffic/summary?limit=1").await;
    assert_eq!(r.json()["top_nodes"].as_array().unwrap().len(), 1);

    // The user's own view: own rows only, names only, hidden + deleted
    // merged into one unnamed row (last).
    let me = user_client(&state, u1).await;
    let r = me.get("/test/api/v1/me/traffic").await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(bytes(&v["total"]), (116, 227, 323));
    assert_eq!(v["days"].as_array().unwrap().len(), 2);
    let rows = v["entrances"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{v}");
    assert_eq!(rows[0]["name"], "香港 01");
    assert_eq!(rows[0]["entrance"], "直连");
    assert_eq!(bytes(&rows[0]), (11, 22, 18));
    assert!(rows[1]["name"].is_null() && rows[1]["entrance"].is_null());
    assert_eq!(bytes(&rows[1]), (105, 205, 305));
    // next07: the multiplier now (never billed ÷ raw: 18 / 33 here) and the
    // time-window rules; none for the merged row.
    assert_eq!(rows[0]["rate"], 2.5);
    assert_eq!(rows[0]["rules"], json!([]));
    assert!(rows[1]["rate"].is_null());
    assert_eq!(rows[1]["rules"], json!([]));
    sqlx::query(
        "INSERT INTO entrance_rate_rules (entrance_id, ord, weekdays, start_minute, end_minute, \
         rate_permille) VALUES ($1, 0, '{1,2,3,4,5}', 1200, 1440, 2000)",
    )
    .bind(e1)
    .execute(&db.pool)
    .await
    .unwrap();
    let v = me.get("/test/api/v1/me/traffic").await.json();
    assert_eq!(
        v["entrances"][0]["rules"],
        json!([{"weekdays": [1, 2, 3, 4, 5], "start": 1200, "end": 1440, "rate": 2}])
    );
    let body = v.to_string();
    for leak in [
        n1.to_string(),
        n2.to_string(),
        gone.to_string(),
        e1.to_string(),
        e2.to_string(),
        "secret".into(),
    ] {
        assert!(!body.contains(&leak), "{leak} leaked: {body}");
    }
    assert!(!body.contains("node_id") && !body.contains("entrance_id"));
    let other = user_client(&state, u2).await;
    let v = other.get("/test/api/v1/me/traffic").await.json();
    assert_eq!(bytes(&v["total"]), (1000, 1000, 2000));
    // An admin's own history is empty, not someone else's.
    let v = admin.get("/test/api/v1/me/traffic").await.json();
    assert_eq!(bytes(&v["total"]), (0, 0, 0));

    // Permissions: users never reach the admin endpoints; no session = 401.
    for path in [
        format!("/test/api/v1/users/{u1}/traffic"),
        format!("/test/api/v1/users/{u2}/traffic"),
        format!("/test/api/v1/nodes/{n1}/traffic"),
        format!("/test/api/v1/entrances/{e1}/traffic"),
        "/test/api/v1/traffic/summary".to_string(),
    ] {
        assert_eq!(me.get(&path).await.status, StatusCode::FORBIDDEN, "{path}");
        let anon = Client::new(&state, rand_ip());
        assert_eq!(
            anon.get(&path).await.status,
            StatusCode::UNAUTHORIZED,
            "{path}"
        );
    }
    let anon = Client::new(&state, rand_ip());
    assert_eq!(
        anon.get("/test/api/v1/me/traffic").await.status,
        StatusCode::UNAUTHORIZED
    );
    // Unknown ids: 404; bad queries: 400 (after the role check).
    let nobody = Uuid::new_v4();
    assert_eq!(
        admin
            .get(&format!("/test/api/v1/users/{nobody}/traffic"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        admin
            .get(&format!("/test/api/v1/nodes/{nobody}/traffic"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        admin
            .get(&format!("/test/api/v1/entrances/{nobody}/traffic"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    for path in [
        format!("/test/api/v1/users/{u1}/traffic?group=year"),
        format!("/test/api/v1/users/{u1}/traffic?limit=3"),
        format!("/test/api/v1/nodes/{n1}/traffic?limit=0"),
        format!("/test/api/v1/users/{u1}/traffic?group=node"),
        format!("/test/api/v1/entrances/{e1}/traffic?limit=3"),
        "/test/api/v1/traffic/summary?from=2020-01-01&to=2026-01-01".to_string(),
        "/test/api/v1/me/traffic?group=node".to_string(),
        "/test/api/v1/me/traffic?user_id=x".to_string(),
        format!("/test/api/v1/me/traffic?from={today}&to={y}"),
    ] {
        let a = if path.contains("/me/") { &me } else { &admin };
        assert_eq!(a.get(&path).await.status, StatusCode::BAD_REQUEST, "{path}");
    }
    assert_eq!(
        me.get("/test/api/v1/me/traffic?group=node").await.json()["error"],
        "unknown parameter"
    );
    db.drop().await;
}

/// next07: GET /entrances/{id}/traffic — the entrance's own days (never
/// mixed with the node's other entrances) and its multiplier changes from
/// the audit log (base changes through PATCH, rule sets; a PATCH that
/// leaves the multiplier alone is not listed), newest first.
#[tokio::test]
async fn entrance_days_and_rate_history() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = admin_client(&state, &db).await;
    let (n1, u1) = db.member().await;
    let e1 = direct(&db, n1).await;
    let today: NaiveDate = sqlx::query_scalar("SELECT (now() AT TIME ZONE akari_site_tz())::date")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    daily(&db, u1, today, n1, (10, 20, 30)).await;
    // Another entrance of the same node: not in e1's days.
    let relay = admin
        .post(
            &format!("/test/api/v1/nodes/{n1}/entrances"),
            json!({"name": "IPLC", "connect_host": "relay.example.net", "connect_port": 30443,
                   "listen_port": 20443, "source_cidrs": ["203.0.113.7"], "rate": 10}),
        )
        .await;
    assert_eq!(relay.status, StatusCode::CREATED, "{:?}", relay.json());
    let relay_id: Uuid = serde_json::from_value(relay.json()["id"].clone()).unwrap();
    sqlx::query(
        "INSERT INTO traffic_entrance_daily (entrance_id, node_id, day, up_bytes, down_bytes, \
         billed_bytes, users) VALUES ($1, $2, $3, 100, 100, 2000, 1)",
    )
    .bind(relay_id)
    .bind(n1)
    .bind(today)
    .execute(&db.pool)
    .await
    .unwrap();
    for body in [
        json!({"rate": 10}),
        json!({"name": "主线"}),
        json!({"rate": 1.5}),
    ] {
        let r = admin
            .req(
                axum::http::Method::PATCH,
                &format!("/test/api/v1/entrances/{e1}"),
                Some(body),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    }
    let r = admin
        .put(
            &format!("/test/api/v1/entrances/{e1}/rate-rules"),
            json!({"rules": [{"weekdays": [6, 7], "start": "00:00", "end": "24:00", "rate": 0.5}]}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());

    let r = admin
        .get(&format!("/test/api/v1/entrances/{e1}/traffic"))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    let days = v["days"].as_array().unwrap();
    assert_eq!(days.len(), 1, "{v}");
    assert_eq!(bytes(&days[0]), (10, 20, 30));
    assert_eq!(days[0]["users"], 1);
    assert_eq!(bytes(&v["total"]), (10, 20, 30));
    let ch = v["rate_changes"].as_array().unwrap();
    assert_eq!(ch.len(), 3, "{v}");
    assert_eq!(ch[0]["action"], "entrance.rate_rules.set");
    assert_eq!(ch[0]["rules_before"], json!([]));
    assert_eq!(ch[0]["rules_after"][0]["rate"], 0.5);
    assert!(ch[0]["rate_before"].is_null());
    assert_eq!(ch[1]["action"], "entrance.update");
    assert_eq!(
        (ch[1]["rate_before"].as_f64(), ch[1]["rate_after"].as_f64()),
        (Some(10.0), Some(1.5))
    );
    assert_eq!(
        (ch[2]["rate_before"].as_f64(), ch[2]["rate_after"].as_f64()),
        (Some(1.0), Some(10.0))
    );
    for c in ch {
        assert!(c["actor_email"].is_string() && c["at"].is_string(), "{c}");
        assert!(c["actor_label"].as_str().unwrap().starts_with("u-"), "{c}");
    }
    // The relay: its own day and its creation (at 10x).
    let v = admin
        .get(&format!("/test/api/v1/entrances/{relay_id}/traffic"))
        .await
        .json();
    assert_eq!(bytes(&v["total"]), (100, 100, 2000));
    assert_eq!(v["rate_changes"][0]["action"], "entrance.create");
    assert!(v["rate_changes"][0]["rate_before"].is_null());
    assert_eq!(v["rate_changes"][0]["rate_after"], 10.0);
    db.drop().await;
}
