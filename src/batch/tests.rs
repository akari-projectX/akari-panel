//! Batch job tests (real database): preview, every action through its
//! apply_*, exactly-once per user across restarts and concurrent runners,
//! resume after an interrupted run, refusals that fail one user only,
//! ledger + audit per change, node bumps only for real access changes,
//! concurrency with direct user edits (no deadlock, lock order), mail via
//! the outbox with a fail-closed rate limit, cancel, and the HTTP surface.

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::client_for;

async fn setup() -> Option<(TestDb, AppState)> {
    let db = TestDb::new().await?;
    let st = AppState::for_test(db.pool.clone()).await;
    Some((db, st))
}

async fn users(db: &TestDb, n: usize) -> Vec<Uuid> {
    let mut v = Vec::new();
    for _ in 0..n {
        v.push(db.user().await);
    }
    v.sort();
    v
}

fn ids(v: &[Uuid]) -> Selection {
    Selection {
        ids: Some(v.to_vec()),
        filter: None,
    }
}

async fn create(db: &TestDb, sel: Selection, action: Action) -> Result<JobView, ApiError> {
    let mut tx = db.pool.begin().await.unwrap();
    let r = apply_create(
        &mut tx,
        &Actor::test(),
        &CreateReq {
            selection: sel,
            action,
        },
    )
    .await;
    if r.is_ok() {
        tx.commit().await.unwrap();
    }
    r
}

async fn job(db: &TestDb, id: Uuid) -> JobView {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {JOB_COLS} FROM admin_batch_jobs WHERE id = $1"
    )))
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

async fn scalar(db: &TestDb, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn audits(db: &TestDb, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = $1")
        .bind(action)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn balance(db: &TestDb, u: Uuid) -> i64 {
    let mut c = db.pool.acquire().await.unwrap();
    ledger::balance(&mut c, u).await.unwrap()
}

/// A plan granting one group that holds `node`.
async fn plan_with(db: &TestDb, node: Uuid) -> Uuid {
    let mut tx = db.pool.begin().await.unwrap();
    let a = Actor::test();
    let g = plans::apply_create_group(
        &mut tx,
        &a,
        &plans::CreateGroupReq {
            name: format!("g-{}", Uuid::new_v4().simple()),
            description: None,
            node_ids: Some(vec![node]),
        },
    )
    .await
    .ok()
    .unwrap();
    let p = plans::apply_create_plan(
        &mut tx,
        &a,
        &plans::CreatePlanReq {
            name: format!("p-{}", Uuid::new_v4().simple()),
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

/// Wait until job `id` has ended (the create handler may already be
/// running it on its own task: help, then poll its status).
async fn wait_ended(db: &TestDb, st: &AppState, id: Uuid) {
    for _ in 0..400 {
        let _ = run_one(st).await.unwrap();
        let status: String =
            sqlx::query_scalar("SELECT status FROM admin_batch_jobs WHERE id = $1")
                .bind(id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        if matches!(status.as_str(), "done" | "cancelled" | "failed") {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("job {id} did not end");
}

async fn finish(st: &AppState) {
    for _ in 0..200 {
        if run_one(st).await.unwrap() == Ran::Nothing {
            return;
        }
    }
    panic!("jobs did not finish");
}

#[test]
fn action_validation() {
    assert!(check_action(&Action::ExtendExpiry { days: 0 }).is_err());
    assert!(check_action(&Action::ExtendExpiry { days: 3651 }).is_err());
    assert!(check_action(&Action::ExtendExpiry { days: 30 }).is_ok());
    // W28-c: a ban needs a reason; D12: a set_plan needs a valid term.
    assert_eq!(
        check_action(&Action::Ban { reason: " ".into() })
            .unwrap_err()
            .code(),
        "user.ban_reason_required"
    );
    assert!(
        check_action(&Action::Ban {
            reason: "abuse".into()
        })
        .is_ok()
    );
    let set = |period: &str, days: Option<i32>| Action::SetPlan {
        plan_id: Uuid::nil(),
        period: serde_json::from_value(json!(period)).unwrap(),
        days,
    };
    assert_eq!(
        check_action(&set("reset", None)).unwrap_err().code(),
        "user_plan.term_reset"
    );
    assert_eq!(
        check_action(&set("days", None)).unwrap_err().code(),
        "user_plan.term_days_missing"
    );
    assert_eq!(
        check_action(&set("month", Some(3))).unwrap_err().code(),
        "user_plan.term_days_unexpected"
    );
    assert!(check_action(&set("days", Some(30))).is_ok());
    assert!(check_action(&set("onetime", None)).is_ok());
    assert!(
        check_action(&Action::AddBalance {
            amount_cents: 0,
            reason: "x".into()
        })
        .is_err()
    );
    assert!(
        check_action(&Action::AddBalance {
            amount_cents: 100,
            reason: " ".into()
        })
        .is_err()
    );
    let e = check_action(&Action::SendEmail {
        subject: "a\r\nBcc: x".into(),
        body: "b".into(),
    })
    .unwrap_err();
    assert_eq!(e.code(), "batch.subject_invalid");
    assert_eq!(
        check_action(&Action::SendEmail {
            subject: "s".into(),
            body: "x".repeat(MAX_BODY + 1)
        })
        .unwrap_err()
        .code(),
        "batch.body_length"
    );
    // Stored parameters round-trip through the job row.
    for a in [
        Action::ExtendExpiry { days: 7 },
        Action::ResetTraffic {},
        Action::SetPlan {
            plan_id: Uuid::nil(),
            period: serde_json::from_value(json!("days")).unwrap(),
            days: Some(7),
        },
        Action::Ban {
            reason: "共享账号".into(),
        },
        Action::Unban {},
        Action::AddBalance {
            amount_cents: -5,
            reason: "r".into(),
        },
    ] {
        assert_eq!(Action::from_row(a.kind(), &a.params()).unwrap(), a);
    }
    // Unknown members anywhere are refused.
    assert!(
        serde_json::from_value::<CreateReq>(json!({
            "selection": {"ids": []}, "action": {"kind": "unban", "x": 1}
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<CreateReq>(json!({
            "selection": {"ids": [], "y": 1}, "action": {"kind": "unban"}
        }))
        .is_err()
    );
    // Mail bodies never reach the audit log.
    assert_eq!(
        redact_params(&json!({"subject": "s", "body": "secret text"}))["body"],
        json!(crate::audit::CHANGED)
    );
}

/// Preview and creation: ids vs filter, admins counted and later skipped,
/// empty and ambiguous selections refused.
#[tokio::test]
async fn preview_and_selection() {
    let Some((db, _st)) = setup().await else {
        return;
    };
    let us = users(&db, 3).await;
    let admin = db.admin().await;
    sqlx::query("UPDATE users SET expires_at = now() - interval '1 day' WHERE id = $1")
        .bind(us[0])
        .execute(&db.pool)
        .await
        .unwrap();
    let mut c = db.pool.acquire().await.unwrap();
    let mut all = us.clone();
    all.push(admin);
    let p = preview_selection(&mut c, &ids(&all)).await.unwrap();
    assert_eq!((p.total, p.admins), (4, 1));
    let f = Selection {
        ids: None,
        filter: Some(UserFilter {
            status: Some("expired".into()),
            ..Default::default()
        }),
    };
    let p = preview_selection(&mut c, &f).await.unwrap();
    assert_eq!(p.total, 1);
    let bad = Selection {
        ids: None,
        filter: Some(UserFilter {
            status: Some("bogus".into()),
            ..Default::default()
        }),
    };
    assert_eq!(
        preview_selection(&mut c, &bad).await.unwrap_err().code(),
        "user.status_filter_invalid"
    );
    assert_eq!(
        preview_selection(&mut c, &Selection::default())
            .await
            .unwrap_err()
            .code(),
        "batch.selection_invalid"
    );
    assert_eq!(
        preview_selection(&mut c, &ids(&[]))
            .await
            .unwrap_err()
            .code(),
        "batch.empty"
    );
    drop(c);
    // A filter matching nobody creates nothing.
    let none = Selection {
        ids: None,
        filter: Some(UserFilter {
            q: Some("nobody-matches-this".into()),
            ..Default::default()
        }),
    };
    assert_eq!(
        create(&db, none, Action::Unban {})
            .await
            .unwrap_err()
            .code(),
        "batch.empty"
    );
    assert_eq!(
        scalar(&db, "SELECT count(*) FROM admin_batch_jobs").await,
        0
    );
    // The filter is snapshotted: users created after the job are not in it.
    let j = create(&db, f, Action::Unban {}).await.unwrap();
    assert_eq!(j.total, 1);
    db.drop().await;
}

/// add_balance: one ledger row + one audit row per user, exactly once
/// across repeated and concurrent runners; admins skipped; balance = sum
/// of the ledger.
#[tokio::test]
async fn balance_exactly_once_with_concurrent_runners() {
    let Some((db, st)) = setup().await else {
        return;
    };
    let mut us = users(&db, 120).await;
    let admin = db.admin().await;
    us.push(admin);
    let j = create(
        &db,
        ids(&us),
        Action::AddBalance {
            amount_cents: 250,
            reason: "补偿".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(j.total, 121);
    assert_eq!(audits(&db, "user.batch.create").await, 1);
    // Three "instances" race for the job.
    let (a, b, c) = tokio::join!(finish(&st), finish(&st), finish(&st));
    let _ = (a, b, c);
    finish(&st).await;
    let j = job(&db, j.id).await;
    assert_eq!(
        (j.status.as_str(), j.done, j.skipped, j.failed),
        ("done", 120, 1, 0)
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) FROM balance_ledger WHERE kind = 'admin_adjust'"
        )
        .await,
        120
    );
    assert_eq!(audits(&db, "balance.admin_adjust").await, 120);
    for u in &us[..120] {
        assert_eq!(balance(&db, *u).await, 250);
    }
    assert_eq!(balance(&db, admin).await, 0);
    let skipped: String = sqlx::query_scalar(
        "SELECT detail FROM admin_batch_items WHERE job_id = $1 AND status = 'skipped'",
    )
    .bind(j.id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(skipped, "管理员账户");
    // Running again changes nothing.
    assert_eq!(run_one(&st).await.unwrap(), Ran::Nothing);
    assert_eq!(
        scalar(&db, "SELECT count(*) FROM balance_ledger").await,
        120
    );
    db.drop().await;
}

/// An interrupted run resumes: items already done are never applied again
/// (the item flips with the apply), a live claim of another runner is
/// respected, an expired one is taken over.
#[tokio::test]
async fn resume_after_interruption() {
    let Some((db, st)) = setup().await else {
        return;
    };
    let us = users(&db, 5).await;
    let j = create(
        &db,
        ids(&us),
        Action::AddBalance {
            amount_cents: 100,
            reason: "r".into(),
        },
    )
    .await
    .unwrap();
    // A previous runner applied user 0 and died holding the claim.
    {
        let mut tx = db.pool.begin().await.unwrap();
        let step = apply_one(
            &mut tx,
            &Actor::test(),
            &Action::AddBalance {
                amount_cents: 100,
                reason: "r".into(),
            },
            us[0],
        )
        .await
        .ok()
        .unwrap();
        assert!(matches!(step, Step::Done));
        sqlx::query(
            "UPDATE admin_batch_items SET status = 'done' WHERE job_id = $1 AND user_id = $2",
        )
        .bind(j.id)
        .bind(us[0])
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE admin_batch_jobs SET status = 'running', started_at = now(), done = 1, \
             claimed_until = now() + interval '1 hour', claim_token = gen_random_uuid() \
             WHERE id = $1",
        )
        .bind(j.id)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
    // Its claim is still live: nobody else runs the job.
    assert_eq!(run_one(&st).await.unwrap(), Ran::Nothing);
    assert_eq!(scalar(&db, "SELECT count(*) FROM balance_ledger").await, 1);
    // The lease runs out: the job resumes with the four pending users.
    sqlx::query("UPDATE admin_batch_jobs SET claimed_until = now() - interval '1 second'")
        .execute(&db.pool)
        .await
        .unwrap();
    finish(&st).await;
    let j = job(&db, j.id).await;
    assert_eq!((j.status.as_str(), j.done), ("done", 5));
    assert_eq!(scalar(&db, "SELECT count(*) FROM balance_ledger").await, 5);
    for u in &us {
        assert_eq!(balance(&db, *u).await, 100, "exactly once");
    }
    db.drop().await;
}

/// A refusal fails that user alone (savepoint: no ledger row, no audit
/// row), the rest of the chunk commits; a debit never goes negative.
#[tokio::test]
async fn refusal_fails_one_user_only() {
    let Some((db, st)) = setup().await else {
        return;
    };
    let us = users(&db, 3).await;
    // Only user 1 can afford the debit.
    let mut tx = db.pool.begin().await.unwrap();
    ledger::apply_adjust(
        &mut tx,
        &Actor::test(),
        us[1],
        &ledger::AdjustReq {
            amount_cents: 500,
            reason: "seed".into(),
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let before = audits(&db, "balance.admin_adjust").await;
    let j = create(
        &db,
        ids(&us),
        Action::AddBalance {
            amount_cents: -300,
            reason: "扣回".into(),
        },
    )
    .await
    .unwrap();
    finish(&st).await;
    let j = job(&db, j.id).await;
    assert_eq!((j.done, j.failed), (1, 2));
    assert_eq!(balance(&db, us[1]).await, 200);
    assert_eq!(balance(&db, us[0]).await, 0);
    assert_eq!(audits(&db, "balance.admin_adjust").await - before, 1);
    let codes: Vec<String> = sqlx::query_scalar(
        "SELECT detail FROM admin_batch_items WHERE job_id = $1 AND status = 'failed'",
    )
    .bind(j.id)
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(codes, vec!["balance.insufficient"; 2]);
    db.drop().await;
}

/// Node bumps only for real access changes; each changed user gets its
/// own audit row from the mutator.
#[tokio::test]
async fn bumps_only_real_access_changes() {
    let Some((db, st)) = setup().await else {
        return;
    };
    let (n1, u1) = db.member().await;
    let (n2, u2) = db.member().await;
    let v = |db: &TestDb| {
        let pool = db.pool.clone();
        async move {
            let mut out = Vec::new();
            for n in [n1, n2] {
                out.push(
                    sqlx::query_as::<_, (i64, i64)>(
                        "SELECT config_version, user_version FROM nodes WHERE id = $1",
                    )
                    .bind(n)
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                );
            }
            out
        }
    };
    // Both hold a plan without nodes or expiry (D12: traffic resets are
    // per subscription); assigning it changes nothing the nodes serve.
    let empty = {
        let mut tx = db.pool.begin().await.unwrap();
        let p = plans::apply_create_plan(
            &mut tx,
            &Actor::test(),
            &plans::CreatePlanReq {
                name: "empty".into(),
                period: "monthly".into(),
                ..Default::default()
            },
        )
        .await
        .ok()
        .unwrap();
        tx.commit().await.unwrap();
        p
    };
    let before = v(&db).await;
    create(
        &db,
        ids(&[u1, u2]),
        Action::SetPlan {
            plan_id: empty,
            period: serde_json::from_value(json!("onetime")).unwrap(),
            days: None,
        },
    )
    .await
    .unwrap();
    finish(&st).await;
    assert_eq!(v(&db).await, before);
    // Unbanning users that are not banned: skipped, nothing bumped.
    create(&db, ids(&[u1, u2]), Action::Unban {}).await.unwrap();
    finish(&st).await;
    assert_eq!(v(&db).await, before);
    assert_eq!(audits(&db, "user.unban").await, 0);
    // Resetting usage of enabled users: no access change.
    sqlx::query("UPDATE users SET traffic_used_bytes = 1000")
        .execute(&db.pool)
        .await
        .unwrap();
    create(&db, ids(&[u1, u2]), Action::ResetTraffic {})
        .await
        .unwrap();
    finish(&st).await;
    assert_eq!(v(&db).await, before);
    assert_eq!(db.used(u1).await, 0);
    assert_eq!(audits(&db, "user.traffic.reset").await, 2);
    // Banning: both nodes bumped, one audit row per user, the reason kept.
    create(
        &db,
        ids(&[u1, u2]),
        Action::Ban {
            reason: "共享账号".into(),
        },
    )
    .await
    .unwrap();
    finish(&st).await;
    let after = v(&db).await;
    assert!(after[0].1 > before[0].1 && after[1].1 > before[1].1);
    assert_eq!(audits(&db, "user.ban").await, 2);
    let reasons: Vec<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT disabled_reason, disabled_note FROM users ORDER BY id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert!(
        reasons
            .iter()
            .all(|r| r.0.as_deref() == Some("admin") && r.1.as_deref() == Some("共享账号"))
    );
    // A quota-disabled user comes back with a traffic reset (bump); a
    // banned one stays banned.
    sqlx::query("UPDATE users SET disabled_reason = 'quota' WHERE id = $1")
        .bind(u1)
        .execute(&db.pool)
        .await
        .unwrap();
    let before = v(&db).await;
    create(&db, ids(&[u1, u2]), Action::ResetTraffic {})
        .await
        .unwrap();
    finish(&st).await;
    let after = v(&db).await;
    assert!(after[0].1 > before[0].1, "u1 back in service");
    assert_eq!(after[1], before[1], "u2 stays banned");
    // Unbanning the banned one: bump + audit.
    create(&db, ids(&[u1, u2]), Action::Unban {}).await.unwrap();
    finish(&st).await;
    assert!(v(&db).await[1].1 > after[1].1);
    assert_eq!(audits(&db, "user.unban").await, 1);
    db.drop().await;
}

/// extend_expiry (D12 "延长 N 天"): periodic subscriptions only, from
/// max(expiry, now); users without a plan, with a one-time purchase
/// (ruling ④) or without an expiry are skipped.
#[tokio::test]
async fn extend_expiry_paths() {
    let Some((db, st)) = setup().await else {
        return;
    };
    let node = db.node().await;
    let plan = plan_with(&db, node).await;
    let us = users(&db, 5).await;
    // us[0]: 10 days; us[1]: 10 days, already past its expiry (the pass
    // has not run); us[2]: no plan; us[3]: one-time purchase of 30 days;
    // us[4]: permanent one-time purchase.
    let term = |kind: &str, days: Option<i32>| {
        plans::Term::new(
            serde_json::from_value::<crate::billing::catalog::PeriodKindText>(json!(kind))
                .unwrap()
                .0,
            days,
        )
        .ok()
        .unwrap()
    };
    let mut tx = db.pool.begin().await.unwrap();
    for (u, t) in [
        (us[0], term("days", Some(10))),
        (us[1], term("days", Some(10))),
        (us[3], term("onetime", Some(30))),
        (us[4], term("onetime", None)),
    ] {
        plans::apply_set_user_plan(
            &mut tx,
            &Actor::test(),
            u,
            &plans::SetUserPlanReq {
                plan_id: plan,
                term: t,
            },
        )
        .await
        .ok()
        .unwrap();
    }
    tx.commit().await.unwrap();
    sqlx::query(
        "UPDATE user_plans SET expires_at = now() - interval '5 days' \
         WHERE user_id = $1 AND status = 'active'",
    )
    .bind(us[1])
    .execute(&db.pool)
    .await
    .unwrap();
    let j = create(&db, ids(&us), Action::ExtendExpiry { days: 30 })
        .await
        .unwrap();
    finish(&st).await;
    let j = job(&db, j.id).await;
    assert_eq!((j.done, j.skipped, j.failed), (2, 3, 0));
    let days = |u: Uuid| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, f64>(
                "SELECT extract(epoch FROM expires_at - now())::float8 / 86400 FROM users \
                 WHERE id = $1",
            )
            .bind(u)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    assert!(
        (days(us[0]).await - 40.0).abs() < 0.01,
        "plan expiry pushed"
    );
    assert!(
        (days(us[1]).await - 30.0).abs() < 0.01,
        "from now, not the past"
    );
    assert!(
        (days(us[3]).await - 30.0).abs() < 0.01,
        "one-time purchase untouched"
    );
    let details: Vec<String> = sqlx::query_scalar(
        "SELECT detail FROM admin_batch_items WHERE job_id = $1 AND status = 'skipped' \
         ORDER BY detail",
    )
    .bind(j.id)
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        details,
        vec![
            "一次性套餐不能延长天数",
            "一次性套餐不能延长天数",
            "无生效套餐"
        ]
    );
    assert_eq!(audits(&db, "user.plan.renew").await, 2);
    db.drop().await;
}

/// set_plan / cancel_plan through the M3 path (reconcile + bump), and a
/// disabled plan refused at creation.
#[tokio::test]
async fn plan_actions() {
    let Some((db, st)) = setup().await else {
        return;
    };
    let node = db.node().await;
    let plan = plan_with(&db, node).await;
    let us = users(&db, 4).await;
    let before: i64 = scalar(&db, "SELECT user_version FROM nodes").await;
    create(
        &db,
        ids(&us),
        Action::SetPlan {
            plan_id: plan,
            period: serde_json::from_value(json!("month")).unwrap(),
            days: None,
        },
    )
    .await
    .unwrap();
    finish(&st).await;
    assert_eq!(
        scalar(&db, "SELECT count(*) FROM node_users WHERE NOT manual").await,
        4
    );
    assert!(scalar(&db, "SELECT user_version FROM nodes").await > before);
    assert_eq!(audits(&db, "user.plan.set").await, 4);
    create(&db, ids(&us[..2]), Action::CancelPlan {})
        .await
        .unwrap();
    // A user without a plan is skipped by cancel.
    create(&db, ids(&us[..3]), Action::CancelPlan {})
        .await
        .unwrap();
    finish(&st).await;
    assert_eq!(scalar(&db, "SELECT count(*) FROM node_users").await, 1);
    assert_eq!(
        scalar(&db, "SELECT count(*) FROM node_users_departed").await,
        3,
        "tail billing kept"
    );
    assert_eq!(audits(&db, "user.plan.cancel").await, 3);
    sqlx::query("UPDATE plans SET enabled = false")
        .execute(&db.pool)
        .await
        .unwrap();
    let e = create(
        &db,
        ids(&us),
        Action::SetPlan {
            plan_id: plan,
            period: serde_json::from_value(json!("month")).unwrap(),
            days: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.code(), "plan.disabled");
    let e = create(
        &db,
        ids(&us),
        Action::SetPlan {
            plan_id: Uuid::new_v4(),
            period: serde_json::from_value(json!("month")).unwrap(),
            days: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.code(), "plan.unknown");
    db.drop().await;
}

/// A set_plan batch (entitle lock per chunk) racing direct admin edits of
/// the same users (disable, plan cancel, balance) finishes without a
/// deadlock and leaves every invariant intact.
#[tokio::test]
async fn concurrent_batch_vs_user_edits() {
    let Some((db, st)) = setup().await else {
        return;
    };
    let node = db.node().await;
    let plan = plan_with(&db, node).await;
    let us = users(&db, 60).await;
    create(
        &db,
        ids(&us),
        Action::SetPlan {
            plan_id: plan,
            period: serde_json::from_value(json!("month")).unwrap(),
            days: None,
        },
    )
    .await
    .unwrap();
    create(
        &db,
        ids(&us),
        Action::AddBalance {
            amount_cents: 10,
            reason: "r".into(),
        },
    )
    .await
    .unwrap();
    let edits = {
        let pool = db.pool.clone();
        let us = us.clone();
        async move {
            for (i, u) in us.iter().enumerate() {
                let mut tx = pool.begin().await.unwrap();
                let a = Actor::test();
                let r = match i % 3 {
                    0 => api::apply_ban_user(&mut tx, &a, *u, "r").await.map(|_| ()),
                    1 => plans::apply_cancel_user_plan(&mut tx, &a, *u)
                        .await
                        .map(|_| ()),
                    _ => ledger::apply_adjust(
                        &mut tx,
                        &a,
                        *u,
                        &ledger::AdjustReq {
                            amount_cents: 5,
                            reason: "direct".into(),
                        },
                    )
                    .await
                    .map(|_| ()),
                };
                match r {
                    Ok(()) => tx.commit().await.unwrap(),
                    // Cancel before the batch reached the user: no plan.
                    Err(e) if e.code() == "user_plan.none" => {}
                    Err(e) => panic!("edit failed: {} {}", e.code(), e.message()),
                }
            }
        }
    };
    let run = async {
        let (_, _) = tokio::join!(finish(&st), finish(&st));
    };
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        tokio::join!(edits, run)
    })
    .await
    .expect("no deadlock");
    finish(&st).await;
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) FROM admin_batch_jobs WHERE status = 'done'"
        )
        .await,
        2
    );
    assert_eq!(
        scalar(&db, "SELECT sum(failed) FROM admin_batch_jobs").await,
        0
    );
    // Ledger: balance = sum(rows) for everyone; 60 batch rows + 20 direct.
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) FROM users u LEFT JOIN user_balances b ON b.user_id = u.id \
             WHERE COALESCE(b.balance_cents, 0) <> COALESCE((SELECT sum(amount_cents) \
             FROM balance_ledger l WHERE l.user_id = u.id), 0)"
        )
        .await,
        0
    );
    assert_eq!(scalar(&db, "SELECT count(*) FROM balance_ledger").await, 80);
    // At most one active plan per user (partial unique index) and the
    // node rows match the active plans.
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) FROM node_users nu WHERE NOT nu.manual AND NOT EXISTS \
             (SELECT 1 FROM user_plans up WHERE up.user_id = nu.user_id AND up.status = 'active')"
        )
        .await,
        0
    );
    db.drop().await;
}

/// send_email: verified addresses only, through the outbox (kind
/// admin_notice), audited without the body; mail off = refused; the rate
/// limit pauses the job (items stay pending) and it resumes.
#[tokio::test]
async fn send_email_through_outbox_with_rate_limit() {
    let Some((db, st)) = setup().await else {
        return;
    };
    let us = users(&db, 3).await;
    let mail = Action::SendEmail {
        subject: "维护通知".into(),
        body: "今晚 23:00 维护。\n\n谢谢。".into(),
    };
    assert_eq!(
        create(&db, ids(&us), mail.clone())
            .await
            .unwrap_err()
            .code(),
        "batch.mail_unavailable"
    );
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = 'smtp.invalid', \
         from_addr = 'ops@example.com'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    for (i, u) in us[..2].iter().enumerate() {
        sqlx::query("UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1")
            .bind(u)
            .bind(format!("u{i}@example.com"))
            .execute(&db.pool)
            .await
            .unwrap();
    }
    // The window is used up: the job pauses with every item pending.
    let schema: String = sqlx::query_scalar("SELECT current_schema()::text")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let key = format!("{MAIL_RATE_KEY}:{schema}");
    for _ in 0..MAIL_RATE {
        crate::rate::hit(&st, key.clone(), MAIL_RATE, MAIL_WINDOW_SECS)
            .await
            .unwrap();
    }
    let j = create(&db, ids(&us), mail).await.unwrap();
    assert_eq!(run_one(&st).await.unwrap(), Ran::Paused);
    assert_eq!(job(&db, j.id).await.done, 0);
    assert_eq!(scalar(&db, "SELECT count(*) FROM mail_outbox").await, 0);
    // The window resets: the job resumes.
    use fred::prelude::*;
    let _: i64 = st.valkey().del(key).await.unwrap();
    sqlx::query("UPDATE admin_batch_jobs SET claimed_until = NULL")
        .execute(&db.pool)
        .await
        .unwrap();
    finish(&st).await;
    let j = job(&db, j.id).await;
    assert_eq!((j.status.as_str(), j.done, j.skipped), ("done", 2, 1));
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT kind, to_addr, body_text FROM mail_outbox ORDER BY to_addr")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .all(|r| r.0 == "admin_notice" && r.2.contains("今晚 23:00 维护。"))
    );
    assert_eq!(audits(&db, "user.mail.send").await, 2);
    let leaked: i64 = scalar(
        &db,
        "SELECT count(*) FROM audit_log WHERE after::text LIKE '%23:00%'",
    )
    .await;
    assert_eq!(leaked, 0, "mail body not in the audit log");
    db.drop().await;
}

/// Cancel: pending items skipped, a finished job cannot be cancelled.
#[tokio::test]
async fn cancel_job() {
    let Some((db, st)) = setup().await else {
        return;
    };
    let us = users(&db, 3).await;
    let j = create(&db, ids(&us), Action::Ban { reason: "r".into() })
        .await
        .unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    let c = apply_cancel(&mut tx, &Actor::test(), j.id).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!((c.status.as_str(), c.skipped), ("cancelled", 3));
    finish(&st).await;
    assert_eq!(
        scalar(&db, "SELECT count(*) FROM users WHERE NOT enabled").await,
        0
    );
    let mut tx = db.pool.begin().await.unwrap();
    let e = apply_cancel(&mut tx, &Actor::test(), j.id)
        .await
        .unwrap_err();
    assert_eq!(e.code(), "batch.finished");
    let e = apply_cancel(&mut tx, &Actor::test(), Uuid::new_v4())
        .await
        .unwrap_err();
    assert_eq!(e.status(), StatusCode::NOT_FOUND);
    drop(tx);
    assert_eq!(audits(&db, "user.batch.cancel").await, 1);
    db.drop().await;
}

/// The HTTP surface: admin only, preview, 202 + job, detail, list,
/// cancel, coded errors.
#[tokio::test]
async fn http_surface() {
    let Some((db, st)) = setup().await else {
        return;
    };
    let admin = db.admin().await;
    let c = client_for(&st, admin).await;
    let us = users(&db, 2).await;
    let uc = client_for(&st, us[0]).await;
    let r = uc
        .post(
            "/test/api/v1/users/batch/preview",
            json!({"selection": {"ids": us}}),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = c
        .post(
            "/test/api/v1/users/batch/preview",
            json!({"selection": {"filter": {"role": "user"}}}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["total"], 2);
    let r = c
        .post(
            "/test/api/v1/users/batch",
            json!({"selection": {"ids": us}, "action": {"kind": "extend_expiry", "days": 0}}),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "user_plan.extend_days_range");
    let r = c
        .post(
            "/test/api/v1/users/batch",
            json!({"selection": {"ids": us}, "action": {"kind": "ban", "reason": ""}}),
        )
        .await;
    assert_eq!(r.json()["code"], "user.ban_reason_required");
    let r = c
        .post(
            "/test/api/v1/users/batch",
            json!({"selection": {"ids": us}, "action": {"kind": "ban", "reason": "abuse"}}),
        )
        .await;
    assert_eq!(r.status, StatusCode::ACCEPTED);
    let id = r.json()["id"].as_str().unwrap().to_string();
    wait_ended(&db, &st, id.parse().unwrap()).await;
    let r = c.get(&format!("/test/api/v1/users/batch/{id}")).await;
    assert_eq!(r.status, StatusCode::OK);
    let v: Value = r.json();
    assert_eq!(v["job"]["status"], "done");
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    let r = c.get("/test/api/v1/users/batch").await;
    assert_eq!(r.json().as_array().unwrap().len(), 1);
    let r = c
        .req(
            Method::POST,
            &format!("/test/api/v1/users/batch/{id}/cancel"),
            Some(json!({})),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "batch.finished");
    let r = c
        .get(&format!("/test/api/v1/users/batch/{}", Uuid::new_v4()))
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    db.drop().await;
}
