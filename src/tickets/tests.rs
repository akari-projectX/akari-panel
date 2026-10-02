//! W17 ticket tests: permissions (another user's ticket is the canonical
//! rejection, byte-identical to an unknown path), the status/unread
//! lifecycle on both sides, the renewal scope (expired and quota-disabled
//! customers), limits (open cap under concurrency, rate, sizes, message
//! cap), audit rows, and the staff list filters.

use axum::http::{Method, StatusCode};
use serde_json::{json, Value};

use super::*;
use crate::testdb::http::{rand_ip, Client};
use crate::testdb::TestDb;

async fn token(state: &AppState, id: Uuid) -> String {
    let (role, sv): (String, i64) =
        sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
            .bind(id)
            .fetch_one(state.pg())
            .await
            .unwrap();
    crate::auth::issue_token(state, id, &role, sv, crate::auth::Stage::Full).unwrap()
}

async fn client(state: &AppState, id: Uuid) -> Client {
    let mut c = Client::new(state, rand_ip());
    c.cookie = Some(token(state, id).await);
    c
}

fn new_ticket(subject: &str) -> Value {
    json!({ "subject": subject, "category": "technical", "priority": "high",
            "message": "节点连不上\r\n第二行" })
}

async fn create(c: &Client, subject: &str) -> Uuid {
    let r = c.post("/test/api/v1/me/tickets", new_ticket(subject)).await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    r.json()["id"].as_str().unwrap().parse().unwrap()
}

async fn audit_count(db: &TestDb, action: &str, target: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = $1 AND target_id = $2")
        .bind(action)
        .bind(target.to_string())
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

#[test]
fn text_rules() {
    assert_eq!(clean_subject("  hi  ").unwrap(), "hi");
    assert!(clean_subject("").is_err());
    assert!(clean_subject("a\nb").is_err());
    assert!(clean_subject(&"x".repeat(MAX_SUBJECT + 1)).is_err());
    assert!(clean_subject(&"字".repeat(MAX_SUBJECT)).is_ok());
    assert_eq!(clean_body(" a\r\nb\rc\0\u{1b}d\t ").unwrap(), "a\nb\ncd");
    assert!(clean_body(" \n\t ").is_err());
    assert!(clean_body("\0").is_err());
    assert!(clean_body(&"x".repeat(MAX_BODY + 1)).is_err());
    assert!(clean_body(&"字".repeat(MAX_BODY)).is_ok());
}

#[test]
fn list_filters() {
    let me = Uuid::new_v4();
    let (wh, b) = list_filter(&ListQuery::default(), me).unwrap();
    assert!(wh.is_empty() && b.is_empty());
    let q = ListQuery {
        status: Some("active".into()),
        category: Some("billing".into()),
        priority: Some("urgent".into()),
        assignee: Some("me".into()),
        unread: Some(true),
        q: Some("50%_off\\".into()),
        page: None,
    };
    let (wh, b) = list_filter(&q, me).unwrap();
    assert!(wh.contains("t.status <> 'closed'") && wh.contains(UNREAD_STAFF));
    assert_eq!(
        b,
        vec!["billing", "urgent", &me.to_string(), "%50\\%\\_off\\\\%"]
    );
    for bad in [
        ListQuery {
            status: Some("x".into()),
            ..Default::default()
        },
        ListQuery {
            category: Some("x".into()),
            ..Default::default()
        },
        ListQuery {
            assignee: Some("someone".into()),
            ..Default::default()
        },
        ListQuery {
            q: Some("x".repeat(65)),
            ..Default::default()
        },
    ] {
        assert!(list_filter(&bad, me).is_err(), "{bad:?}");
    }
    let (wh, _) = list_filter(
        &ListQuery {
            assignee: Some("none".into()),
            status: Some("closed".into()),
            ..Default::default()
        },
        me,
    )
    .unwrap();
    assert!(wh.contains("t.assignee_id IS NULL") && wh.contains("t.status = $1"));
}

/// User A's ticket is invisible to user B: every customer endpoint answers
/// B exactly like an unknown path (the canonical rejection), so ticket ids
/// are no oracle; malformed ids too. Staff see author logins, customers
/// never see staff logins.
#[tokio::test]
async fn another_users_ticket_is_the_canonical_rejection() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let (a, b) = (db.user().await, db.user().await);
    let ca = client(&state, a).await;
    let cb = client(&state, b).await;
    let t = create(&ca, "A 的工单").await;
    let canonical = cb.get("/test/no-such-path").await.fingerprint();
    assert_eq!(canonical.0, StatusCode::NOT_FOUND);
    for r in [
        cb.get(&format!("/test/api/v1/me/tickets/{t}")).await,
        cb.post(
            &format!("/test/api/v1/me/tickets/{t}/replies"),
            json!({"message": "hi"}),
        )
        .await,
        cb.post(&format!("/test/api/v1/me/tickets/{t}/close"), json!({}))
            .await,
        cb.get(&format!("/test/api/v1/me/tickets/{}", Uuid::new_v4()))
            .await,
        cb.get("/test/api/v1/me/tickets/not-a-uuid").await,
        cb.post("/test/api/v1/me/tickets/not-a-uuid/close", json!({}))
            .await,
    ] {
        assert_eq!(r.fingerprint(), canonical);
    }
    // B's list does not show it; nothing changed on A's ticket.
    let list = cb.get("/test/api/v1/me/tickets").await;
    assert_eq!(list.json(), json!([]));
    let (status, msgs): (String, i32) =
        sqlx::query_as("SELECT status, messages FROM tickets WHERE id = $1")
            .bind(t)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!((status.as_str(), msgs), ("open", 1));
    // Admins are not customers here; customers are not staff there.
    let admin = client(&state, db.admin().await).await;
    assert_eq!(
        admin.get("/test/api/v1/me/tickets").await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        ca.get("/test/api/v1/tickets").await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        ca.get(&format!("/test/api/v1/tickets/{t}")).await.status,
        StatusCode::FORBIDDEN
    );
    // No session at all: 401 (the API, not a guessable resource).
    let anon = Client::new(&state, rand_ip());
    assert_eq!(
        anon.get("/test/api/v1/me/tickets").await.status,
        StatusCode::UNAUTHORIZED
    );
    drop(state);
    db.drop().await;
}

/// The whole conversation, both sides: status, unread markers, staff
/// identity hidden from the customer, close/reopen/assign, audit rows.
#[tokio::test]
async fn lifecycle_both_sides() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let user = db.user().await;
    let node = db.node().await;
    db.assign(node, user).await;
    let admin_id = db.admin().await;
    let cu = client(&state, user).await;
    let ca = client(&state, admin_id).await;

    // Unknown order / node of someone else: 400; own node: linked.
    let mut body = new_ticket("连不上");
    body["order_id"] = json!(Uuid::new_v4());
    assert_eq!(
        cu.post("/test/api/v1/me/tickets", body).await.status,
        StatusCode::BAD_REQUEST
    );
    let other = db.node().await;
    let mut body = new_ticket("连不上");
    body["node_id"] = json!(other);
    assert_eq!(
        cu.post("/test/api/v1/me/tickets", body).await.status,
        StatusCode::BAD_REQUEST
    );
    let mut body = new_ticket("连不上");
    body["node_id"] = json!(node);
    body["zz"] = json!(1);
    assert_eq!(
        cu.post("/test/api/v1/me/tickets", body).await.status,
        StatusCode::BAD_REQUEST
    );
    let mut body = new_ticket("连不上");
    body["node_id"] = json!(node);
    let r = cu.post("/test/api/v1/me/tickets", body).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let t: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(audit_count(&db, "ticket.create", t).await, 1);

    // Staff queue: open + unread; reading marks it read.
    let list = ca.get("/test/api/v1/tickets?status=open&unread=true").await;
    assert_eq!(list.status, StatusCode::OK);
    let l = list.json();
    assert_eq!(l["total"], 1);
    assert_eq!(l["open"], 1);
    assert_eq!(l["unread"], 1);
    assert_eq!(l["tickets"][0]["user_login"], user.to_string());
    assert_eq!(l["tickets"][0]["node_id"], node.to_string());
    let v = ca.get(&format!("/test/api/v1/tickets/{t}")).await.json();
    assert_eq!(v["thread"][0]["body"], "节点连不上\n第二行");
    assert_eq!(v["thread"][0]["author_login"], user.to_string());
    assert_eq!(v["thread"][0]["staff"], false);
    let l = ca.get("/test/api/v1/tickets?unread=true").await.json();
    assert_eq!(l["total"], 0);
    assert_eq!(
        ca.get("/test/api/v1/admin-badges").await.json()["tickets_unread"],
        0
    );

    // Staff reply -> answered; the customer sees it unread, without the
    // staff login.
    let r = ca
        .post(
            &format!("/test/api/v1/tickets/{t}/replies"),
            json!({"message": "请重启客户端"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let mine = cu.get("/test/api/v1/me/tickets").await.json();
    assert_eq!(mine[0]["status"], "answered");
    assert_eq!(mine[0]["unread"], true);
    let v = cu.get(&format!("/test/api/v1/me/tickets/{t}")).await;
    assert_eq!(v.status, StatusCode::OK);
    let v = v.json();
    assert_eq!(v["messages"].as_array().unwrap().len(), 2);
    assert_eq!(v["messages"][1]["staff"], true);
    assert!(v["messages"][1].get("author_login").is_none());
    assert!(!v.to_string().contains(&admin_id.to_string()));
    assert_eq!(
        cu.get("/test/api/v1/me/tickets").await.json()[0]["unread"],
        false
    );

    // Customer reply -> open; staff reply-and-close -> closed.
    let r = cu
        .post(
            &format!("/test/api/v1/me/tickets/{t}/replies"),
            json!({"message": "还是不行"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(
        cu.get("/test/api/v1/me/tickets").await.json()[0]["status"],
        "open"
    );
    let r = ca
        .post(
            &format!("/test/api/v1/tickets/{t}/replies"),
            json!({"message": "已修复", "close": true}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let v = ca.get(&format!("/test/api/v1/tickets/{t}")).await.json();
    assert_eq!(v["status"], "closed");
    assert_eq!(v["closed_by"], "staff");
    // Closed: replies refused on both sides until staff reopen.
    let r = cu
        .post(
            &format!("/test/api/v1/me/tickets/{t}/replies"),
            json!({"message": "x"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let r = ca
        .post(
            &format!("/test/api/v1/tickets/{t}/replies"),
            json!({"message": "x"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let r = ca
        .req(
            Method::POST,
            &format!("/test/api/v1/tickets/{t}/reopen"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = ca
        .req(
            Method::POST,
            &format!("/test/api/v1/tickets/{t}/reopen"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    // The customer closes it; again is a no-op (one audit row).
    for _ in 0..2 {
        let r = cu
            .post(&format!("/test/api/v1/me/tickets/{t}/close"), json!({}))
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
    }
    let v = ca.get(&format!("/test/api/v1/tickets/{t}")).await.json();
    assert_eq!(
        (v["status"].as_str(), v["closed_by"].as_str()),
        (Some("closed"), Some("user"))
    );

    // Assign: an enabled admin only; me/none filters.
    let r = ca
        .req(
            Method::PUT,
            &format!("/test/api/v1/tickets/{t}/assignee"),
            Some(json!({"assignee_id": user})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = ca
        .req(
            Method::PUT,
            &format!("/test/api/v1/tickets/{t}/assignee"),
            Some(json!({"assignee_id": admin_id})),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(
        ca.get("/test/api/v1/tickets?assignee=me").await.json()["total"],
        1
    );
    assert_eq!(
        ca.get("/test/api/v1/tickets?assignee=none").await.json()["total"],
        0
    );
    let v = ca.get(&format!("/test/api/v1/tickets/{t}")).await.json();
    assert_eq!(v["assignee_login"], admin_id.to_string());
    let admins = ca.get("/test/api/v1/admins").await.json();
    assert!(admins
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["id"] == admin_id.to_string()));
    let r = ca
        .req(
            Method::PUT,
            &format!("/test/api/v1/tickets/{t}/assignee"),
            Some(json!({"assignee_id": null})),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    // Staff on an unknown ticket: a plain JSON 404 (staff are trusted).
    let r = ca
        .get(&format!("/test/api/v1/tickets/{}", Uuid::new_v4()))
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert!(!r.body.is_empty());

    // Search, category filter, bad filter.
    assert_eq!(
        ca.get("/test/api/v1/tickets?q=%E8%BF%9E%E4%B8%8D")
            .await
            .json()["total"],
        1
    );
    assert_eq!(
        ca.get("/test/api/v1/tickets?category=billing").await.json()["total"],
        0
    );
    assert_eq!(
        ca.get("/test/api/v1/tickets?status=nope").await.status,
        StatusCode::BAD_REQUEST
    );

    // One audit row per mutation; bodies never copied into the audit log.
    assert_eq!(audit_count(&db, "ticket.reply", t).await, 3);
    assert_eq!(audit_count(&db, "ticket.close", t).await, 1);
    assert_eq!(audit_count(&db, "ticket.reopen", t).await, 1);
    assert_eq!(audit_count(&db, "ticket.assign", t).await, 2);
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE (after::text LIKE '%还是不行%' \
         OR after::text LIKE '%节点连不上%')",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(leaked, 0);
    drop(state);
    db.drop().await;
}

/// Expired and quota-disabled customers keep support (renewal scope, R21);
/// admin-disabled ones do not.
#[tokio::test]
async fn renewal_scope_users_can_open_tickets() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let expired = db.user().await;
    let quota = db.user().await;
    let banned = db.user().await;
    let (ce, cq, cb) = (
        client(&state, expired).await,
        client(&state, quota).await,
        client(&state, banned).await,
    );
    sqlx::query("UPDATE users SET expires_at = now() - interval '1 day' WHERE id = $1")
        .bind(expired)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET enabled = false, disabled_reason = 'quota' WHERE id = $1")
        .bind(quota)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET enabled = false WHERE id = $1")
        .bind(banned)
        .execute(&db.pool)
        .await
        .unwrap();
    // Sessions issued before the change are re-checked per request; the
    // quota/disable updates bumped session_ver: take fresh tokens.
    let mut cq = cq;
    cq.cookie = Some(token(&state, quota).await);
    let mut cb = cb;
    cb.cookie = Some(token(&state, banned).await);
    for c in [&ce, &cq] {
        let t = create(c, "续费后还能用吗").await;
        let r = c.get(&format!("/test/api/v1/me/tickets/{t}")).await;
        assert_eq!(r.status, StatusCode::OK);
        let r = c
            .post(
                &format!("/test/api/v1/me/tickets/{t}/replies"),
                json!({"message": "补充"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED);
    }
    let r = cb.post("/test/api/v1/me/tickets", new_ticket("x")).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    drop(state);
    db.drop().await;
}

/// The open-ticket cap holds under concurrent creation (per-user advisory
/// lock), the hourly create limit and the message cap apply, oversized
/// text is refused.
#[tokio::test]
async fn limits() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let user = db.user().await;
    let me = Author {
        id: user,
        login: user.to_string(),
        staff: false,
    };
    let req = CreateReq {
        subject: "并发".into(),
        category: "general".into(),
        priority: "normal".into(),
        message: "m".into(),
        order_id: None,
        node_id: None,
    };
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let (pool, me) = (db.pool.clone(), me.clone());
        let req = CreateReq {
            subject: req.subject.clone(),
            category: req.category.clone(),
            priority: req.priority.clone(),
            message: req.message.clone(),
            order_id: None,
            node_id: None,
        };
        set.spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            match apply_create(&mut tx, &Actor::test(), &me, &req, None).await {
                Ok(_) => {
                    tx.commit().await.unwrap();
                    true
                }
                Err(e) => {
                    assert_eq!(e.status(), StatusCode::CONFLICT, "{}", e.message());
                    false
                }
            }
        });
    }
    let mut ok = 0;
    while let Some(r) = set.join_next().await {
        ok += usize::from(r.unwrap());
    }
    assert_eq!(ok as i64, MAX_OPEN_PER_USER);

    // Message cap.
    let t: Uuid = sqlx::query_scalar("SELECT id FROM tickets WHERE user_id = $1 LIMIT 1")
        .bind(user)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE tickets SET messages = $2 WHERE id = $1")
        .bind(t)
        .bind(MAX_MESSAGES)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    let e = apply_reply(
        &mut tx,
        &Actor::test(),
        &me,
        t,
        &ReplyReq {
            message: "x".into(),
            close: false,
        },
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(e.status(), StatusCode::CONFLICT);
    drop(tx);

    // Hourly create limit (HTTP, per user): a fresh customer closes as it
    // goes, so only the rate stops it.
    let other = db.user().await;
    let c = client(&state, other).await;
    for i in 0..CREATE_PER_HOUR {
        let t = create(&c, &format!("t{i}")).await;
        let r = c
            .post(&format!("/test/api/v1/me/tickets/{t}/close"), json!({}))
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
    }
    let r = c
        .post("/test/api/v1/me/tickets", new_ticket("one more"))
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // Invalid input does not spend the budget of a third customer.
    let third = client(&state, db.user().await).await;
    for _ in 0..(CREATE_PER_HOUR + 2) {
        let mut b = new_ticket("x");
        b["message"] = json!("y".repeat(MAX_BODY + 1));
        assert_eq!(
            third.post("/test/api/v1/me/tickets", b).await.status,
            StatusCode::BAD_REQUEST
        );
    }
    create(&third, "ok").await;
    let mut b = new_ticket("x");
    b["category"] = json!("nope");
    assert_eq!(
        third.post("/test/api/v1/me/tickets", b).await.status,
        StatusCode::BAD_REQUEST
    );
    drop(state);
    db.drop().await;
}

async fn enable_smtp(db: &TestDb) {
    sqlx::query(
        "UPDATE smtp_settings SET enabled = true, host = 'smtp.example.com', \
         from_addr = 'noreply@example.com'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
}

async fn set_email(db: &TestDb, user: Uuid, email: &str, verified: bool, locale: &str) {
    sqlx::query(
        "UPDATE users SET email = $2, locale = $4, \
         email_verified_at = CASE WHEN $3 THEN now() END WHERE id = $1",
    )
    .bind(user)
    .bind(email)
    .bind(verified)
    .bind(locale)
    .execute(&db.pool)
    .await
    .unwrap();
}

async fn outbox(db: &TestDb) -> Vec<(String, String, String)> {
    sqlx::query_as("SELECT kind, to_addr, subject FROM mail_outbox ORDER BY id")
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

/// Ticket mail goes through the W15 outbox, to verified addresses only, in
/// the recipient's language; nothing without SMTP.
#[tokio::test]
async fn ticket_mail_uses_the_outbox() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let user = db.user().await;
    let admin = db.admin().await;
    let other_admin = db.admin().await;
    set_email(&db, user, "user@example.com", true, "en").await;
    set_email(&db, admin, "ops@example.com", true, "zh").await;
    set_email(&db, other_admin, "unverified@example.com", false, "zh").await;
    let cu = client(&state, user).await;
    let ca = client(&state, admin).await;
    // SMTP off: nothing is queued.
    let t = create(&cu, "无邮件").await;
    assert!(outbox(&db).await.is_empty());
    enable_smtp(&db).await;
    let t2 = create(&cu, "有邮件").await;
    assert_eq!(
        outbox(&db).await,
        vec![(
            "ticket_new".into(),
            "ops@example.com".into(),
            "Akari：新工单".into()
        )]
    );
    for id in [t, t2] {
        let r = ca
            .post(
                &format!("/test/api/v1/tickets/{id}/replies"),
                json!({"message": "已处理"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED);
    }
    let mails = outbox(&db).await;
    assert_eq!(mails.len(), 3);
    assert_eq!(
        mails[1],
        (
            "ticket_reply".into(),
            "user@example.com".into(),
            "Akari: new reply to your ticket".into()
        )
    );
    // A customer reply mails nobody; an unverified owner gets nothing.
    let r = cu
        .post(
            &format!("/test/api/v1/me/tickets/{t2}/replies"),
            json!({"message": "谢谢"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    set_email(&db, user, "user@example.com", false, "en").await;
    let r = ca
        .post(
            &format!("/test/api/v1/tickets/{t2}/replies"),
            json!({"message": "再见"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(outbox(&db).await.len(), 3);
    drop(state);
    db.drop().await;
}
