//! D10: the never-used definition, the list filters, the console's bulk
//! deletion with its confirmation, and the automatic cleanup (warning, a
//! sign-in keeps the account).

use axum::http::StatusCode;
use serde_json::json;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

async fn setup() -> Option<(TestDb, AppState)> {
    let db = TestDb::new().await?;
    let state = AppState::for_test(db.pool.clone()).await;
    Some((db, state))
}

/// A role=user account registered `days` ago.
async fn aged(db: &TestDb, days: i32) -> Uuid {
    let id = db.user().await;
    sqlx::query("UPDATE users SET created_at = now() - make_interval(days => $2) WHERE id = $1")
        .bind(id)
        .bind(days)
        .execute(&db.pool)
        .await
        .unwrap();
    id
}

async fn exists(db: &TestDb, id: Uuid) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn never_used(db: &TestDb) -> Vec<Uuid> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT u.id FROM users u WHERE {NEVER_USED} ORDER BY u.id"
    )))
    .fetch_all(&db.pool)
    .await
    .unwrap()
}

/// Never used = no plan ever, no finance record, no traffic, zero balance,
/// no ticket; admins never.
#[tokio::test]
async fn the_definition() {
    let Some((db, _state)) = setup().await else {
        return;
    };
    let idle = aged(&db, 40).await;
    let (_, traffic) = db.member().await;
    sqlx::query("UPDATE users SET traffic_used_bytes = 1 WHERE id = $1")
        .bind(traffic)
        .execute(&db.pool)
        .await
        .unwrap();
    let ticket = db.user().await;
    sqlx::query(
        "INSERT INTO tickets (id, user_id, subject, category, priority) \
         VALUES (gen_random_uuid(), $1, 's', 'general', 'normal')",
    )
    .bind(ticket)
    .execute(&db.pool)
    .await
    .unwrap();
    let money = db.user().await;
    let mut tx = db.pool.begin().await.unwrap();
    crate::billing::ledger::apply_adjust(
        &mut tx,
        &Actor::test(),
        money,
        &crate::billing::ledger::AdjustReq {
            amount_cents: 1,
            reason: "r".into(),
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let planned = db.user().await;
    let plan: Uuid = sqlx::query_scalar(
        "INSERT INTO plans (id, name, reset_period) VALUES (gen_random_uuid(), 'p', 'none') \
         RETURNING id",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO user_plans (id, user_id, plan_id, period_anchor, term_kind, status, ended_at) \
         VALUES (gen_random_uuid(), $1, $2, now(), 'onetime', 'cancelled', now())",
    )
    .bind(planned)
    .bind(plan)
    .execute(&db.pool)
    .await
    .unwrap();
    db.admin().await;
    assert_eq!(never_used(&db).await, vec![idle]);
    db.drop().await;
}

/// The list's D10 filters; the bulk deletion needs the preview's token for
/// exactly what it showed.
#[tokio::test]
async fn filters_and_bulk_deletion() {
    let Some((db, state)) = setup().await else {
        return;
    };
    let (old_a, old_b) = (aged(&db, 60).await, aged(&db, 50).await);
    let fresh = db.user().await;
    let (_, used) = db.member().await;
    sqlx::query("UPDATE users SET traffic_used_bytes = 5, created_at = now() - interval '90 days' WHERE id = $1")
        .bind(used)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET last_login_at = now() - interval '45 days' WHERE id = $1")
        .bind(old_b)
        .execute(&db.pool)
        .await
        .unwrap();
    let admin = client_for(&state, db.admin().await).await;
    let before = (chrono::Utc::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d")
        .to_string();
    let total = |q: String| {
        let admin = &admin;
        async move { admin.get(&format!("/test/api/v1/users?{q}")).await.json()["total"].clone() }
    };
    assert_eq!(total("never_used=true&role=user".into()).await, json!(3));
    assert_eq!(
        total(format!("never_used=true&registered_before={before}")).await,
        json!(2)
    );
    let a_bit = (chrono::Utc::now() - chrono::Duration::days(40))
        .format("%Y-%m-%d")
        .to_string();
    assert_eq!(
        total(format!("role=user&last_login_before={a_bit}")).await,
        json!(4),
        "never signed in counts; old_b signed in 45 days ago"
    );
    let r = admin
        .get("/test/api/v1/users?registered_before=yesterday")
        .await;
    assert_eq!(r.json()["code"], "user.date_filter_invalid");

    // Bulk: everything never used and registered 30+ days ago.
    let sel = json!({"filter": {"never_used": true, "registered_before": before}});
    let r = admin
        .post(
            "/test/api/v1/users/delete/preview",
            json!({"selection": sel}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let p = r.json();
    assert_eq!(
        (p["deletable"].clone(), p["anonymized"].clone()),
        (json!(2), json!(0))
    );
    let token = p["confirm_token"].as_str().unwrap().to_string();
    let r = admin
        .post(
            "/test/api/v1/users/delete",
            json!({"selection": sel, "confirm_token": "nope"}),
        )
        .await;
    assert_eq!(r.json()["code"], "user.bulk_delete_changed");
    // The selection grows meanwhile: the token no longer fits.
    let late = aged(&db, 70).await;
    let r = admin
        .post(
            "/test/api/v1/users/delete",
            json!({"selection": sel, "confirm_token": token}),
        )
        .await;
    assert_eq!(r.json()["code"], "user.bulk_delete_changed");
    let p = admin
        .post(
            "/test/api/v1/users/delete/preview",
            json!({"selection": sel}),
        )
        .await
        .json();
    let r = admin
        .post(
            "/test/api/v1/users/delete",
            json!({"selection": sel, "confirm_token": p["confirm_token"]}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(
        r.json(),
        json!({"deleted": 3, "anonymized": 0, "failed": 0})
    );
    for id in [old_a, old_b, late] {
        assert!(!exists(&db, id).await);
    }
    for id in [fresh, used] {
        assert!(exists(&db, id).await);
    }
    // Selected ids: a used account is kept anonymized, admins never.
    let other_admin = db.admin().await;
    let sel = json!({"ids": [used, other_admin]});
    let p = admin
        .post(
            "/test/api/v1/users/delete/preview",
            json!({"selection": sel}),
        )
        .await
        .json();
    assert_eq!(p["admins"], 1);
    assert_eq!(p["deletable"], 1);
    let r = admin
        .post(
            "/test/api/v1/users/delete",
            json!({"selection": sel, "confirm_token": p["confirm_token"]}),
        )
        .await;
    assert_eq!(r.json()["deleted"], 1, "no finance record: deleted");
    assert!(exists(&db, other_admin).await);
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action IN ('users.bulk_delete', 'user.erase')",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(n, 2 + 4);
    db.drop().await;
}

/// The automatic cleanup: off by default; on, it deletes the never-used
/// inactive accounts; with the warning it marks (and mails) first, deletes
/// `warn_days` later, and a sign-in keeps the account.
#[tokio::test]
async fn automatic_cleanup() {
    let Some((db, state)) = setup().await else {
        return;
    };
    let admin = client_for(&state, db.admin().await).await;
    let v = admin.get("/test/api/v1/settings/cleanup").await.json();
    assert_eq!(
        (
            v["auto"].clone(),
            v["after_days"].clone(),
            v["warn"].clone()
        ),
        (json!(false), json!(30), json!(false))
    );
    let put = |body: serde_json::Value| {
        let admin = &admin;
        async move { admin.put("/test/api/v1/settings/cleanup", body).await }
    };
    let r =
        put(json!({"version": 0, "auto": true, "after_days": 0, "warn": false, "warn_days": 7}))
            .await;
    assert_eq!(r.json()["code"], "cleanup.after_days_range");
    let r =
        put(json!({"version": 0, "auto": true, "after_days": 30, "warn": true, "warn_days": 99}))
            .await;
    assert_eq!(r.json()["code"], "cleanup.warn_days_range");

    let gone = aged(&db, 40).await;
    let young = aged(&db, 10).await;
    assert_eq!(run_once(&state).await.unwrap(), Ran::default(), "off");
    let r =
        put(json!({"version": 0, "auto": true, "after_days": 30, "warn": false, "warn_days": 7}))
            .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["due_delete"], 1);
    assert_eq!(
        put(json!({"version": 0, "auto": true, "after_days": 30, "warn": false, "warn_days": 7}))
            .await
            .json()["code"],
        "settings.version_conflict"
    );
    let ran = run_once(&state).await.unwrap();
    assert_eq!(
        ran,
        Ran {
            warned: 0,
            deleted: 1
        }
    );
    assert!(!exists(&db, gone).await && exists(&db, young).await);
    let why: String = sqlx::query_scalar(
        "SELECT after->>'why' FROM audit_log WHERE action = 'user.erase' AND target_id = $1",
    )
    .bind(gone.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(why, "never_used");

    // With the warning: marked (and mailed) first.
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', port = 1025, \
         security = 'none', from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let warned = aged(&db, 40).await;
    let keeps = aged(&db, 40).await;
    for id in [warned, keeps] {
        sqlx::query("UPDATE users SET email_verified_at = now() WHERE id = $1")
            .bind(id)
            .execute(&db.pool)
            .await
            .unwrap();
    }
    let pw = auth_password(&db, keeps).await;
    let r =
        put(json!({"version": 1, "auto": true, "after_days": 30, "warn": true, "warn_days": 7}))
            .await;
    assert_eq!(r.json()["due_warn"], 2);
    assert_eq!(
        run_once(&state).await.unwrap(),
        Ran {
            warned: 2,
            deleted: 0
        }
    );
    let mails: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM mail_outbox WHERE kind = 'admin_notice' AND user_id = ANY($1)",
    )
    .bind(vec![warned, keeps])
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(mails, 2);
    // Nothing new next time; a sign-in keeps `keeps`.
    assert_eq!(run_once(&state).await.unwrap(), Ran::default());
    let mut c = Client::new(&state, rand_ip());
    assert_eq!(
        c.login(&crate::testdb::test_email(keeps), &pw).await.status,
        StatusCode::OK
    );
    sqlx::query("UPDATE users SET cleanup_warned_at = now() - interval '8 days' WHERE cleanup_warned_at IS NOT NULL")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        run_once(&state).await.unwrap(),
        Ran {
            warned: 0,
            deleted: 1
        }
    );
    assert!(!exists(&db, warned).await && exists(&db, keeps).await);
    let last: (i32, i32) = sqlx::query_as("SELECT last_deleted, last_warned FROM cleanup_settings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(last, (1, 0));
    db.drop().await;
}

async fn auth_password(db: &TestDb, id: Uuid) -> String {
    let pw = "keep-me-password-1".to_string();
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(id)
        .bind(crate::auth::hash_password(&pw).unwrap())
        .execute(&db.pool)
        .await
        .unwrap();
    pw
}
