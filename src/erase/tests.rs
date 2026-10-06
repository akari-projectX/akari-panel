//! Account erasure: deleted without finance records, anonymized with them
//! (personal data gone, money kept, never usable again), the self-service
//! endpoints and their refusals.

use axum::http::{Method, StatusCode};
use serde_json::json;
use uuid::Uuid;

use super::*;
use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

async fn setup() -> Option<(TestDb, AppState)> {
    let db = TestDb::new().await?;
    let state = AppState::for_test(db.pool.clone()).await;
    Some((db, state))
}

async fn with_password(db: &TestDb, id: Uuid, pw: &str) -> String {
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(id)
        .bind(auth::hash_password(pw).unwrap())
        .execute(&db.pool)
        .await
        .unwrap();
    crate::testdb::test_email(id)
}

async fn credit(db: &TestDb, id: Uuid, cents: i64) {
    let mut tx = db.pool.begin().await.unwrap();
    crate::billing::ledger::apply_adjust(
        &mut tx,
        &Actor::test(),
        id,
        &crate::billing::ledger::AdjustReq {
            amount_cents: cents,
            reason: "t".into(),
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn pending_order(db: &TestDb, user: Uuid) {
    sqlx::query(
        "INSERT INTO orders (id, out_trade_no, user_id, user_label, plan_id, plan_name, \
         amount_cents, list_price_cents, period, period_days, subject, expires_at, action) \
         VALUES (gen_random_uuid(), 'AKT' || md5(random()::text), $1, 'u', \
                 (SELECT id FROM plans LIMIT 1), 'p', 100, 100, 'days', 30, 's', \
                 now() + interval '15 minutes', 'new')",
    )
    .bind(user)
    .execute(&db.pool)
    .await
    .unwrap();
}

async fn erase(db: &TestDb, id: Uuid, why: Why) -> Result<Option<Erased>, ApiError> {
    let mut tx = db.pool.begin().await.unwrap();
    let r = apply_erase(&mut tx, &Actor::test(), id, why).await;
    if r.is_ok() {
        tx.commit().await.unwrap();
    }
    r
}

/// Without finance records the account is gone; with them it stays,
/// anonymized: personal rows deleted, access revoked, the balance's history
/// intact, never usable or changeable again.
#[tokio::test]
async fn erase_deletes_or_anonymizes() {
    let Some((db, state)) = setup().await else {
        return;
    };
    // Plain account: deleted.
    let plain = db.user().await;
    assert_eq!(
        erase(&db, plain, Why::NeverUsed).await.unwrap(),
        Some(Erased::Deleted)
    );
    let gone: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id = $1")
        .bind(plain)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(gone, 0);
    assert_eq!(erase(&db, plain, Why::NeverUsed).await.unwrap(), None);

    // With finance records: anonymized.
    let (node, u) = db.member().await;
    let email = with_password(&db, u, "user-password-1").await;
    credit(&db, u, 700).await;
    for sql in [
        "INSERT INTO webauthn_credentials (user_id, rp_id, cred_id, passkey, name) \
         VALUES ($1, 'x.example', '\\x00112233445566778899aabbccddeeff', '{}', 'k')",
        "INSERT INTO invite_codes (code, user_id) VALUES ('abcdefgh', $1)",
        "INSERT INTO tickets (id, user_id, subject, category, priority) \
         VALUES (gen_random_uuid(), $1, 'help', 'general', 'normal')",
        "UPDATE users SET sub_token_hash = '\\x01', email_verified_at = now() WHERE id = $1",
    ] {
        sqlx::query(sql).bind(u).execute(&db.pool).await.unwrap();
    }
    let v0 = db.versions(node).await;
    let mut c = state.pg().acquire().await.unwrap();
    let before = impact(&mut c, u).await.unwrap().unwrap();
    drop(c);
    assert_eq!(before["anonymized"], true);
    assert_eq!(before["balance_cents"], 700);
    assert_eq!(
        erase(&db, u, Why::SelfService).await.unwrap(),
        Some(Erased::Anonymized)
    );
    type Row = (String, bool, Option<String>, bool, bool, Option<Vec<u8>>);
    let row: Row = sqlx::query_as(
        "SELECT email, enabled, disabled_reason, erased_at IS NOT NULL, \
         email_verified_at IS NULL, sub_token_hash FROM users WHERE id = $1",
    )
    .bind(u)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            format!("erased-{}@erased.invalid", u.simple()),
            false,
            Some("admin".into()),
            true,
            true,
            None
        )
    );
    for t in [
        "webauthn_credentials",
        "invite_codes",
        "tickets",
        "entrance_users",
    ] {
        let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT count(*) FROM {t} WHERE user_id = $1"
        )))
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(n, 0, "{t}");
    }
    assert_ne!(db.versions(node).await, v0, "the node dropped the user");
    let ledger: i64 = sqlx::query_scalar("SELECT count(*) FROM balance_ledger WHERE user_id = $1")
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(ledger, 1, "the money's history stays");
    let audits: Vec<serde_json::Value> =
        sqlx::query_scalar("SELECT after FROM audit_log WHERE action = 'user.erase' ORDER BY id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        audits,
        vec![
            json!({"anonymized": false, "why": "never_used"}),
            json!({"anonymized": true, "why": "self_service"}),
        ]
    );
    // The old address signs in to nothing; the address is free again.
    let mut anon = Client::new(&state, rand_ip());
    assert_eq!(
        anon.login(&email, "user-password-1").await.status,
        StatusCode::UNAUTHORIZED
    );
    // Never changed again; listed as erased.
    let owner = db.owner().await;
    let admin = client_for(&state, owner).await;
    for (m, p, body) in [
        (
            Method::PATCH,
            format!("/test/api/v1/users/{u}"),
            json!({"role": "admin"}),
        ),
        (
            Method::POST,
            format!("/test/api/v1/users/{u}/ban"),
            json!({"reason": "x"}),
        ),
    ] {
        let r = admin.req(m, &p, Some(body)).await;
        assert_eq!(r.status, StatusCode::CONFLICT, "{p}");
        assert_eq!(r.json()["code"], "user.erased");
    }
    let list = admin.get("/test/api/v1/users?status=erased").await.json();
    assert_eq!(list["total"], 1);
    assert_eq!(
        erase(&db, u, Why::SelfService).await.unwrap_err().code(),
        "user.erased"
    );
    assert_eq!(
        erase(&db, owner, Why::NeverUsed).await.unwrap_err().code(),
        "user.erase_admin"
    );
    db.drop().await;
}

/// `POST /me/delete`: confirmation, the password (rate limited like a
/// login), no pending orders or withdrawals, users only, not banned; the
/// cookie is cleared and the session is gone.
#[tokio::test]
async fn self_service_deletion() {
    let Some((db, state)) = setup().await else {
        return;
    };
    let u = db.user().await;
    with_password(&db, u, "user-password-1").await;
    let c = client_for(&state, u).await;
    let r = c.get("/test/api/v1/me/delete-impact").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["anonymized"], false);
    let del = |body: serde_json::Value| {
        let c = &c;
        async move { c.post("/test/api/v1/me/delete", body).await }
    };
    assert_eq!(
        del(json!({"confirm": false})).await.json()["code"],
        "account.delete_confirm_required"
    );
    assert_eq!(
        del(json!({"confirm": true})).await.json()["code"],
        "account.password_required"
    );
    assert_eq!(
        del(json!({"confirm": true, "password": "wrong-password"}))
            .await
            .json()["code"],
        "account.invalid_password"
    );
    sqlx::query(
        "INSERT INTO plans (id, name, reset_period) VALUES (gen_random_uuid(), 'p', 'none')",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    pending_order(&db, u).await;
    let r = del(json!({"confirm": true, "password": "user-password-1"})).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "account.delete_pending_orders");
    sqlx::query("UPDATE orders SET status = 'cancelled', ended_at = now() WHERE user_id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = del(json!({"confirm": true, "password": "user-password-1"})).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{:?}", r.json());
    assert!(
        r.headers
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .any(|v| v.to_str().unwrap_or("").contains("Max-Age=0")),
        "cookie cleared"
    );
    // An order is a finance record: kept anonymized; the session is dead.
    assert_eq!(
        c.get("/test/api/v1/me").await.status,
        StatusCode::UNAUTHORIZED
    );
    let kept: bool = sqlx::query_scalar("SELECT erased_at IS NOT NULL FROM users WHERE id = $1")
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(kept);

    // Admins and banned users cannot.
    let a = client_for(&state, db.admin().await).await;
    assert_eq!(
        a.post("/test/api/v1/me/delete", json!({"confirm": true}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        a.get("/test/api/v1/me/delete-impact").await.status,
        StatusCode::FORBIDDEN
    );
    let b = db.user().await;
    sqlx::query(
        "UPDATE users SET enabled = false, disabled_reason = 'admin', disabled_note = 'x' \
         WHERE id = $1",
    )
    .bind(b)
    .execute(&db.pool)
    .await
    .unwrap();
    let bc = client_for(&state, b).await;
    let r = bc
        .post("/test/api/v1/me/delete", json!({"confirm": true}))
        .await;
    assert_eq!(r.json()["code"], "account.banned");
    db.drop().await;
}
