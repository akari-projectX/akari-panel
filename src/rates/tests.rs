use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::client_for;
use axum::http::StatusCode;

fn req(days: &[i16], start: &str, end: &str, rate: f64) -> RuleReq {
    RuleReq {
        weekdays: days.to_vec(),
        start: start.into(),
        end: end.into(),
        rate,
    }
}

fn code(e: ApiError) -> String {
    e.code().to_string()
}

#[test]
fn parse_validates_and_normalizes() {
    let r = parse(&[req(&[5, 1, 5], "08:00", "24:00", 1.5)]).unwrap();
    assert_eq!(
        r,
        vec![Rule {
            weekdays: vec![1, 5],
            start: 480,
            end: 1440,
            permille: 1500
        }]
    );
    // 00:00 as an end = midnight at the end of the day; across midnight.
    assert_eq!(
        parse(&[req(&[1], "22:00", "00:00", 1.0)]).unwrap()[0].end,
        1440
    );
    assert_eq!(
        parse(&[req(&[1], "22:00", "06:00", 1.0)]).unwrap()[0].end,
        360
    );
    for bad in [
        req(&[], "08:00", "09:00", 1.0),
        req(&[0], "08:00", "09:00", 1.0),
        req(&[8], "08:00", "09:00", 1.0),
        req(&[1], "8:00", "09:00", 1.0),
        req(&[1], "24:00", "09:00", 1.0),
        req(&[1], "08:60", "09:00", 1.0),
        req(&[1], "08:00", "08:00", 1.0),
        req(&[1], "08:00", "x", 1.0),
    ] {
        assert_eq!(
            code(parse(&[bad]).unwrap_err()),
            "entrance.rate_rule_invalid"
        );
    }
    assert_eq!(
        code(parse(&[req(&[1], "08:00", "09:00", 1.0005)]).unwrap_err()),
        "entrance.rate_invalid"
    );
    let many = vec![req(&[1], "08:00", "09:00", 1.0); MAX_RULES + 1];
    assert_eq!(
        code(parse(&many).unwrap_err()),
        "entrance.rate_rules_too_many"
    );
}

#[test]
fn overlaps_are_reported_with_the_winning_rate() {
    let rules = parse(&[
        req(&[1, 2, 3, 4, 5], "18:00", "23:00", 2.0),
        req(&[5], "22:00", "02:00", 3.0),
        req(&[6], "01:00", "03:00", 0.5),
        req(&[2], "08:00", "09:00", 1.0),
    ])
    .unwrap();
    let w = overlap_warnings(&rules);
    assert_eq!(w.len(), 2, "{w:?}");
    assert!(
        w[0].contains("规则 1 与规则 2") && w[0].contains("周五 22:00–23:00"),
        "{}",
        w[0]
    );
    assert!(w[0].contains("3.0x"), "{}", w[0]);
    // Rule 2 crosses midnight into Saturday 00:00-02:00: meets rule 3.
    assert!(
        w[1].contains("规则 2 与规则 3") && w[1].contains("周六 01:00–02:00"),
        "{}",
        w[1]
    );
    // Sunday night into Monday wraps the week.
    let rules = parse(&[
        req(&[7], "23:00", "01:00", 2.0),
        req(&[1], "00:00", "00:30", 0.5),
    ])
    .unwrap();
    let w = overlap_warnings(&rules);
    assert_eq!(w.len(), 1);
    assert!(w[0].contains("周一 00:00–00:30"), "{}", w[0]);
    // Touching windows do not overlap.
    let rules = parse(&[
        req(&[1], "08:00", "09:00", 2.0),
        req(&[1], "09:00", "10:00", 0.5),
    ])
    .unwrap();
    assert!(overlap_warnings(&rules).is_empty());
}

/// The SQL rate at a site-local time (Asia/Shanghai unless set).
async fn rate_at(db: &TestDb, e: Uuid, local: &str) -> i32 {
    sqlx::query_scalar(
        "SELECT akari_entrance_rate($1, ($2::timestamp AT TIME ZONE akari_site_tz()))",
    )
    .bind(e)
    .bind(local)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

/// `akari_entrance_rate` is the one definition: base outside every rule,
/// the highest of the matching rules inside, windows across midnight
/// belong to the start day, the site time zone decides.
#[tokio::test]
async fn sql_rate_follows_rules_in_the_site_time_zone() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let node = db.node().await;
    let e = db.direct(node).await;
    sqlx::query("UPDATE entrances SET rate_permille = 1000 WHERE id = $1")
        .bind(e)
        .execute(&db.pool)
        .await
        .unwrap();
    let rules = parse(&[
        req(&[1, 2, 3, 4, 5], "18:00", "23:00", 2.0),
        req(&[5], "22:00", "02:00", 3.0),
        req(&[6, 7], "00:00", "24:00", 0.5),
    ])
    .unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    let w = apply_set_rules(&mut tx, &Actor::system(), e, &rules)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(w.len(), 2);
    // 2026-10-05 is a Monday.
    for (at, want) in [
        ("2026-10-05 17:59:59", 1000),
        ("2026-10-05 18:00:00", 2000),
        ("2026-10-05 22:59:59", 2000),
        ("2026-10-05 23:00:00", 1000),
        ("2026-10-09 22:30:00", 3000), // Friday: overlap, highest wins
        ("2026-10-10 01:59:00", 3000), // Saturday, Friday's window
        ("2026-10-10 02:00:00", 500),
        ("2026-10-11 23:59:59", 500),
        ("2026-10-12 00:00:00", 1000), // Monday again
    ] {
        assert_eq!(rate_at(&db, e, at).await, want, "{at}");
    }
    // Another site time zone shifts the windows.
    sqlx::query("UPDATE panel_settings SET timezone = 'UTC'")
        .execute(&db.pool)
        .await
        .unwrap();
    let utc: i32 =
        sqlx::query_scalar("SELECT akari_entrance_rate($1, '2026-10-05 18:30:00+00'::timestamptz)")
            .bind(e)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(utc, 2000);
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'entrance.rate_rules.set' AND target_id = $1",
    )
    .bind(e.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);
    db.drop().await;
}

/// The API: replace, warnings, the view's rate_now/rate_rules, 404 for an
/// unknown entrance, 409 on a server being deleted, the flush bills the
/// rule's rate.
#[tokio::test]
async fn put_rules_through_the_api_and_settle() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let c = client_for(&state, db.admin().await).await;
    let (node, u) = db.member().await;
    let e = db.direct(node).await;
    // All week, all day: the rule is in effect now and 30 s ago.
    let r = c
        .put(
            &format!("/test/api/v1/entrances/{e}/rate-rules"),
            json!({"rules": [
                {"weekdays": [1,2,3,4,5,6,7], "start": "00:00", "end": "24:00", "rate": 0.25},
                {"weekdays": [1], "start": "00:00", "end": "01:00", "rate": 0.25}
            ]}),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let v = r.json();
    assert_eq!(v["entrance"]["rate_now"], 0.25);
    assert_eq!(v["entrance"]["rate"], 1.0);
    assert_eq!(v["entrance"]["rate_rules"].as_array().unwrap().len(), 2);
    assert_eq!(v["warnings"].as_array().unwrap().len(), 1);
    let r = c
        .put(
            &format!("/test/api/v1/entrances/{}/rate-rules", Uuid::new_v4()),
            json!({"rules": []}),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = c
        .put(
            &format!("/test/api/v1/entrances/{e}/rate-rules"),
            json!({"rules": [{"weekdays": [9], "start": "00:00", "end": "24:00", "rate": 1}]}),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "entrance.rate_rule_invalid");
    assert_eq!(r.json()["params"]["index"], 1);

    // Settlement: 4000 raw at 0.25x.
    let b = crate::traffic::TrafficBuffer::new();
    crate::traffic::refresh_members(&db.pool, &b, node)
        .await
        .unwrap();
    b.update(
        node,
        "s1",
        &crate::pb::TrafficReport {
            users: vec![crate::pb::UserTraffic {
                user_id: u.to_string(),
                up_bytes: 1000,
                down_bytes: 3000,
            }],
            ..Default::default()
        },
    );
    crate::traffic::flush_for_test(&db.pool, &b).await;
    assert_eq!(db.used(u).await, 1000);

    // The admin's node view shows the rate now.
    let n = c.get(&format!("/test/api/v1/nodes/{node}")).await.json();
    assert_eq!(n["entrances"][0]["rate_now"], 0.25);

    // Clearing the rules: back to the base.
    let r = c
        .put(
            &format!("/test/api/v1/entrances/{e}/rate-rules"),
            json!({"rules": []}),
        )
        .await;
    assert_eq!(r.json()["entrance"]["rate_now"], 1.0);

    sqlx::query("UPDATE servers SET deleting_at = now() WHERE id = $1")
        .bind(db.server_of(node).await)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c
        .put(
            &format!("/test/api/v1/entrances/{e}/rate-rules"),
            json!({"rules": []}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    db.drop().await;
}
