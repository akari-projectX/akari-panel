//! R47: the owner — who may change admin accounts, the owner's protection
//! (API and database), transfers, and the user's report (a quota-disabled
//! account promoted to admin did not count as an admin).

use axum::http::{Method, StatusCode};
use serde_json::json;
use uuid::Uuid;

use super::*;
use crate::api::UpdateUserReq;
use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::client_for;

async fn setup() -> Option<(TestDb, AppState)> {
    let db = TestDb::new().await?;
    let state = AppState::for_test(db.pool.clone()).await;
    Some((db, state))
}

async fn row(db: &TestDb, id: Uuid) -> (String, bool, Option<String>, bool) {
    sqlx::query_as("SELECT role, enabled, disabled_reason, is_owner FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

/// The report: an account disabled for traffic, promoted to admin, stayed
/// disabled and so was not an admin that counted — deleting the other
/// admin then failed with "keep an admin". A promotion now enables it, a
/// banned account is refused, and the other admin can be deleted.
#[tokio::test]
async fn promoting_a_quota_disabled_user_makes_a_working_admin() {
    let Some((db, state)) = setup().await else {
        return;
    };
    let owner = db.owner().await;
    let other = db.admin().await;
    let u = db.user().await;
    sqlx::query("UPDATE users SET enabled = false, disabled_reason = 'quota' WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    let c = client_for(&state, owner).await;
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/users/{u}"),
            Some(json!({ "role": "admin" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(row(&db, u).await, ("admin".into(), true, None, false));
    // The promoted admin signs in and works.
    let promoted = client_for(&state, u).await;
    assert_eq!(
        promoted.get("/test/api/v1/users").await.status,
        StatusCode::OK
    );
    // The other admins can go.
    for id in [other, u] {
        let r = c
            .req(
                Method::DELETE,
                &format!("/test/api/v1/users/{id}?confirm=true"),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT, "{:?}", r.json());
    }
    // A banned account is unbanned first.
    let b = db.user().await;
    sqlx::query(
        "UPDATE users SET enabled = false, disabled_reason = 'admin', disabled_note = 'x' \
         WHERE id = $1",
    )
    .bind(b)
    .execute(&db.pool)
    .await
    .unwrap();
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/users/{b}"),
            Some(json!({ "role": "admin" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "user.promote_banned");
    assert_eq!(row(&db, b).await.0, "user");
    db.drop().await;
}

/// The migration repairs admins left disabled for quota.
#[tokio::test]
async fn migration_enables_quota_disabled_admins() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    // The 1013 repair statement, as the migration ran it.
    let a = db.admin().await;
    sqlx::query("UPDATE users SET enabled = false, disabled_reason = 'quota' WHERE id = $1")
        .bind(a)
        .execute(&db.pool)
        .await
        .unwrap();
    let sql = include_str!("../../migrations/1013_owner.sql");
    let repair = sql
        .split(';')
        .map(str::trim)
        .find(|s| s.contains("UPDATE users SET enabled = true"))
        .unwrap();
    let repair = repair
        .lines()
        .filter(|l| !l.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    sqlx::query(sqlx::AssertSqlSafe(repair))
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(row(&db, a).await.1);
    db.drop().await;
}

/// Only the owner changes admin accounts or makes admins; an ordinary admin
/// manages users and its own account.
#[tokio::test]
async fn ordinary_admins_cannot_touch_other_admins() {
    let Some((db, state)) = setup().await else {
        return;
    };
    let owner = db.owner().await;
    let a = db.admin().await;
    let b = db.admin().await;
    let u = db.user().await;
    let c = client_for(&state, a).await;
    let forbidden = |r: crate::testdb::http::Resp| {
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{:?}", r.json());
        assert_eq!(r.json()["code"], "user.owner_only");
    };
    for target in [b, owner] {
        forbidden(
            c.req(
                Method::PATCH,
                &format!("/test/api/v1/users/{target}"),
                Some(json!({ "password": "hijacked-1234" })),
            )
            .await,
        );
        forbidden(
            c.req(
                Method::PATCH,
                &format!("/test/api/v1/users/{target}"),
                Some(json!({ "role": "user" })),
            )
            .await,
        );
        forbidden(
            c.post(
                &format!("/test/api/v1/users/{target}/ban"),
                json!({ "reason": "r" }),
            )
            .await,
        );
        forbidden(
            c.req(
                Method::DELETE,
                &format!("/test/api/v1/users/{target}?confirm=true"),
                None,
            )
            .await,
        );
        forbidden(
            c.post(
                &format!("/test/api/v1/users/{target}/revoke-sessions"),
                json!({}),
            )
            .await,
        );
        forbidden(
            c.post(
                &format!("/test/api/v1/users/{target}/login-method/reset"),
                json!({}),
            )
            .await,
        );
        forbidden(
            c.post(
                &format!("/test/api/v1/users/{target}/email/verify"),
                json!({}),
            )
            .await,
        );
    }
    // Making admins.
    forbidden(
        c.req(
            Method::PATCH,
            &format!("/test/api/v1/users/{u}"),
            Some(json!({ "role": "admin" })),
        )
        .await,
    );
    forbidden(
        c.post(
            "/test/api/v1/users",
            json!({ "email": "new-admin@example.com", "password": "password-123", "role": "admin" }),
        )
        .await,
    );
    forbidden(
        c.post(
            &format!("/test/api/v1/users/{b}/owner"),
            json!({ "confirm": true }),
        )
        .await,
    );
    // Users and the admin's own account stay its business.
    let r = c
        .post(
            &format!("/test/api/v1/users/{u}/ban"),
            json!({ "reason": "spam" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/users/{a}"),
            Some(json!({ "password": "my-own-new-1" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(row(&db, b).await, ("admin".into(), true, None, false));
    db.drop().await;
}

/// The owner cannot be demoted, banned or deleted — not even by itself or
/// the command line — and the database refuses it on every path.
#[tokio::test]
async fn the_owner_is_protected() {
    let Some((db, state)) = setup().await else {
        return;
    };
    let owner = db.owner().await;
    let c = client_for(&state, owner).await;
    let protected_ = |r: crate::testdb::http::Resp| {
        assert_eq!(r.status, StatusCode::CONFLICT, "{:?}", r.json());
        assert_eq!(r.json()["code"], "user.owner_protected");
    };
    protected_(
        c.req(
            Method::PATCH,
            &format!("/test/api/v1/users/{owner}"),
            Some(json!({ "role": "user" })),
        )
        .await,
    );
    protected_(
        c.req(
            Method::DELETE,
            &format!("/test/api/v1/users/{owner}?confirm=true"),
            None,
        )
        .await,
    );
    let mut tx = db.pool.begin().await.unwrap();
    let e = crate::api::apply_ban_user(&mut tx, &Actor::cli(), owner, "r")
        .await
        .unwrap_err();
    assert_eq!(e.code(), "user.owner_protected");
    drop(tx);
    let mut tx = db.pool.begin().await.unwrap();
    let e = crate::api::apply_update_user(
        &mut tx,
        &Actor::cli(),
        owner,
        &UpdateUserReq {
            role: Some(Some("user".into())),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.code(), "user.owner_protected");
    drop(tx);
    // Direct SQL: the CHECK, the delete trigger, the deferred owner check.
    for sql in [
        "UPDATE users SET enabled = false WHERE is_owner",
        "UPDATE users SET role = 'user' WHERE is_owner",
        "DELETE FROM users WHERE is_owner",
    ] {
        let e = sqlx::query(sql).execute(&db.pool).await.unwrap_err();
        assert_eq!(
            crate::auth::ApiError::from(e).code(),
            "user.owner_protected",
            "{sql}"
        );
    }
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("UPDATE users SET is_owner = false WHERE is_owner")
        .execute(&mut *tx)
        .await
        .unwrap();
    let e = tx.commit().await.unwrap_err();
    assert_eq!(
        crate::auth::ApiError::from(e).code(),
        "user.owner_protected"
    );
    // At most one owner.
    let a = db.admin().await;
    assert!(
        sqlx::query("UPDATE users SET is_owner = true WHERE id = $1")
            .bind(a)
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert_eq!(row(&db, owner).await, ("admin".into(), true, None, true));
    db.drop().await;
}

/// Transfer: owner only, to an enabled admin, confirmed, audited; the old
/// owner becomes an ordinary admin the new owner may delete. The CLI
/// recovery does the same.
#[tokio::test]
async fn ownership_is_transferred() {
    let Some((db, state)) = setup().await else {
        return;
    };
    let owner = db.owner().await;
    let a = db.admin().await;
    let u = db.user().await;
    let c = client_for(&state, owner).await;
    let r = c
        .post(
            &format!("/test/api/v1/users/{a}/owner"),
            json!({ "confirm": false }),
        )
        .await;
    assert_eq!(r.json()["code"], "user.owner_confirm_required");
    let r = c
        .post(
            &format!("/test/api/v1/users/{u}/owner"),
            json!({ "confirm": true }),
        )
        .await;
    assert_eq!(r.json()["code"], "user.owner_target");
    let r = c
        .post(
            &format!("/test/api/v1/users/{owner}/owner"),
            json!({ "confirm": true }),
        )
        .await;
    assert_eq!(r.json()["code"], "user.owner_already");
    let r = c
        .post(
            &format!("/test/api/v1/users/{}/owner", Uuid::new_v4()),
            json!({ "confirm": true }),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = c
        .post(
            &format!("/test/api/v1/users/{a}/owner"),
            json!({ "confirm": true }),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{:?}", r.json());
    assert!(row(&db, a).await.3 && !row(&db, owner).await.3);
    let (before, after): (serde_json::Value, serde_json::Value) =
        sqlx::query_as("SELECT before, after FROM audit_log WHERE action = 'user.owner.transfer'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(before["owner"], crate::audit::user_label(owner));
    assert_eq!(after["owner"], crate::audit::user_label(a));
    // The new owner manages the old one.
    let c2 = client_for(&state, a).await;
    let me = c2.get("/test/api/v1/me").await.json();
    assert_eq!(me["is_owner"], true);
    let r = c2
        .req(
            Method::DELETE,
            &format!("/test/api/v1/users/{owner}?confirm=true"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{:?}", r.json());
    // CLI recovery.
    let b = db.admin().await;
    let email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(b)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(cli_set_owner(&db.pool, &email).await.unwrap(), Some(a));
    assert!(row(&db, b).await.3);
    assert!(cli_set_owner(&db.pool, "nobody@example.com").await.is_err());
    db.drop().await;
}
