//! Admin-action mails (ban / unban, plan changes, withdrawal decisions):
//! one outbox mail per action for a verified address, none for an
//! unverified one or with the switch off, and a mail problem never fails
//! the change. Real database; commission credits are asserted in the
//! billing tests, batch actions in the batch tests.

use axum::http::{Method, StatusCode};
use serde_json::json;
use uuid::Uuid;

use crate::plans;
use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for};

async fn setup() -> Option<(TestDb, AppState, Client)> {
    let db = TestDb::new().await?;
    let state = AppState::for_test(db.pool.clone()).await;
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', security = 'none', \
         from_addr = 'noreply@example.com'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let admin = db.owner().await;
    let c = client_for(&state, admin).await;
    Some((db, state, c))
}

/// A customer with a verified address.
async fn verified(db: &TestDb, locale: &str) -> (Uuid, String) {
    let u = db.user().await;
    let email = format!("v{}@example.com", &u.simple().to_string()[..12]);
    sqlx::query(
        "UPDATE users SET email = $2, email_verified_at = now(), locale = $3 WHERE id = $1",
    )
    .bind(u)
    .bind(&email)
    .bind(locale)
    .execute(&db.pool)
    .await
    .unwrap();
    (u, email)
}

/// (to, subject, text) of every mail of `kind`, oldest first.
async fn mails(db: &TestDb, kind: &str) -> Vec<(String, String, String)> {
    sqlx::query_as(
        "SELECT to_addr, subject, body_text FROM mail_outbox WHERE kind = $1 ORDER BY id",
    )
    .bind(kind)
    .fetch_all(&db.pool)
    .await
    .unwrap()
}

async fn plan(db: &TestDb) -> Uuid {
    let node = db.node().await;
    let mut tx = db.pool.begin().await.unwrap();
    let a = crate::audit::Actor::test();
    let g = plans::apply_create_group(
        &mut tx,
        &a,
        &plans::CreateGroupReq {
            name: format!("g-{}", Uuid::new_v4().simple()),
            description: None,
            entrance_ids: Some(vec![db.direct(node).await]),
        },
    )
    .await
    .ok()
    .unwrap();
    let p = plans::apply_create_plan(
        &mut tx,
        &a,
        &plans::CreatePlanReq {
            name: "Gold".into(),
            period: "monthly".into(),
            group_ids: Some(vec![g]),
            ..Default::default()
        },
    )
    .await
    .ok()
    .unwrap();
    tx.commit().await.unwrap();
    p
}

#[tokio::test]
async fn ban_and_unban_notices() {
    let Some((db, _state, c)) = setup().await else {
        return;
    };
    let (u, email) = verified(&db, "en").await;
    let r = c
        .post(
            &format!("/test/api/v1/users/{u}/ban"),
            json!({ "reason": "shared account" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let m = mails(&db, "account_banned").await;
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].0, email);
    assert!(m[0].1.contains("suspended") && m[0].2.contains("Reason: shared account"));
    let r = c
        .post(&format!("/test/api/v1/users/{u}/unban"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(mails(&db, "account_unbanned").await.len(), 1);

    // An unverified address gets nothing; the ban still happens.
    let plain = db.user().await;
    let r = c
        .post(
            &format!("/test/api/v1/users/{plain}/ban"),
            json!({ "reason": "x" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(mails(&db, "account_banned").await.len(), 1);

    // Switch off: no mail.
    sqlx::query("UPDATE mail_settings SET notify_ban = false")
        .execute(&db.pool)
        .await
        .unwrap();
    let (off, _) = verified(&db, "zh").await;
    c.post(
        &format!("/test/api/v1/users/{off}/ban"),
        json!({ "reason": "x" }),
    )
    .await;
    assert_eq!(mails(&db, "account_banned").await.len(), 1);

    // A mail that cannot be queued never fails the change.
    sqlx::query("UPDATE mail_settings SET notify_ban = true")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_boom CHECK (false) NOT VALID")
        .execute(&db.pool)
        .await
        .unwrap();
    let (broken, _) = verified(&db, "zh").await;
    let r = c
        .post(
            &format!("/test/api/v1/users/{broken}/ban"),
            json!({ "reason": "x" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let banned: bool =
        sqlx::query_scalar("SELECT disabled_reason = 'admin' FROM users WHERE id = $1")
            .bind(broken)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(banned);
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'user.ban' AND target_id = $1",
    )
    .bind(broken.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audited, 1);
    assert_eq!(mails(&db, "account_banned").await.len(), 1);
    db.drop().await;
}

#[tokio::test]
async fn plan_change_notices() {
    let Some((db, _state, c)) = setup().await else {
        return;
    };
    let p = plan(&db).await;
    let (u, email) = verified(&db, "zh").await;
    let (unverified, _) = (db.user().await, ());
    let url = format!("/test/api/v1/users/{u}/plan");
    // A refused change sends nothing.
    let r = c
        .req(Method::PATCH, &url, Some(json!({ "extend_days": 3 })))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert!(mails(&db, "plan_changed").await.is_empty());

    let steps = [
        (
            Method::PUT,
            url.clone(),
            json!({ "plan_id": p, "period": "month" }),
            "分配了套餐「Gold」",
        ),
        (
            Method::PATCH,
            url.clone(),
            json!({ "period": "month" }),
            "续期",
        ),
        (
            Method::PATCH,
            url.clone(),
            json!({ "extend_days": 3 }),
            "延长了",
        ),
        (
            Method::POST,
            format!("{url}/reset-traffic"),
            json!({ "confirm": true }),
            "重置了",
        ),
        (Method::DELETE, url.clone(), json!(null), "取消了"),
    ];
    for (i, (method, path, body, want)) in steps.into_iter().enumerate() {
        let body = (!body.is_null()).then_some(body);
        let r = c.req(method, &path, body).await;
        assert!(r.status.is_success(), "{path}: {:?}", r.json());
        let m = mails(&db, "plan_changed").await;
        assert_eq!(m.len(), i + 1, "{path}");
        assert_eq!(m[i].0, email);
        assert!(m[i].2.contains(want), "{want}: {}", m[i].2);
    }
    // An unverified address, or the switch off: nothing more.
    let r = c
        .req(
            Method::PUT,
            &format!("/test/api/v1/users/{unverified}/plan"),
            Some(json!({ "plan_id": p, "period": "month" })),
        )
        .await;
    assert!(r.status.is_success());
    sqlx::query("UPDATE mail_settings SET notify_plan_change = false")
        .execute(&db.pool)
        .await
        .unwrap();
    c.req(
        Method::PUT,
        &url,
        Some(json!({ "plan_id": p, "period": "month" })),
    )
    .await;
    assert_eq!(mails(&db, "plan_changed").await.len(), 5);
    db.drop().await;
}

async fn withdrawal(db: &TestDb, user: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO withdrawals (id, user_id, user_label, amount_cents, chain, address) \
         VALUES ($1, $2, 'u', 5000, 'trc20', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')",
    )
    .bind(id)
    .bind(user)
    .execute(&db.pool)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn withdrawal_notices() {
    let Some((db, _state, c)) = setup().await else {
        return;
    };
    let (u, email) = verified(&db, "en").await;
    let w1 = withdrawal(&db, u).await;
    let r = c
        .post(
            &format!("/test/api/v1/withdrawals/{w1}/approve"),
            json!({ "usdt_amount": "6.89", "txid": "0xabcdef123456", "note": "internal" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{:?}", r.json());
    let m = mails(&db, "withdrawal_approved").await;
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].0, email);
    for want in ["6.89 USDT", "TRC20 (Tron)", "0xabcdef123456", "CNY 50.00"] {
        assert!(m[0].2.contains(want), "{want}: {}", m[0].2);
    }
    assert!(!m[0].2.contains("internal") && !m[0].2.contains("TR7NH"));

    let w2 = withdrawal(&db, u).await;
    let r = c
        .post(
            &format!("/test/api/v1/withdrawals/{w2}/reject"),
            json!({ "reason": "address unreachable" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{:?}", r.json());
    let m = mails(&db, "withdrawal_rejected").await;
    assert_eq!(m.len(), 1);
    assert!(m[0].2.contains("address unreachable"));

    // Unverified owner, switch off: none.
    let w3 = withdrawal(&db, db.user().await).await;
    c.post(
        &format!("/test/api/v1/withdrawals/{w3}/reject"),
        json!({ "reason": "x" }),
    )
    .await;
    sqlx::query("UPDATE mail_settings SET notify_withdrawal = false")
        .execute(&db.pool)
        .await
        .unwrap();
    let w4 = withdrawal(&db, u).await;
    c.post(
        &format!("/test/api/v1/withdrawals/{w4}/reject"),
        json!({ "reason": "x" }),
    )
    .await;
    assert_eq!(mails(&db, "withdrawal_rejected").await.len(), 1);
    db.drop().await;
}
