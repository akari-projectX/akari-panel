//! Ops announcement tests (real database): text rules, what each user
//! sees (window, audience, read state; everything else is the canonical
//! rejection), the admin CRUD with audit rows, and the mailing in batches.

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

fn body(title: &str, extra: Value) -> Value {
    let mut v = json!({ "title_zh": title, "body_zh": "**正文** <script>x</script>" });
    for (k, val) in extra.as_object().cloned().unwrap_or_default() {
        v[k] = val;
    }
    v
}

async fn create(c: &Client, v: Value) -> Uuid {
    let r = c.post("/test/api/v1/announcements", v).await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    r.json()["id"].as_str().unwrap().parse().unwrap()
}

async fn give_plan(db: &TestDb, user: Uuid) {
    let plan = Uuid::new_v4();
    sqlx::query("INSERT INTO plans (id, name, reset_period) VALUES ($1, $2, 'none')")
        .bind(plan)
        .bind(plan.to_string())
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO user_plans (id, user_id, plan_id, status, period_anchor, term_kind) \
         VALUES ($1, $2, $3, 'active', now(), 'onetime')",
    )
    .bind(Uuid::new_v4())
    .bind(user)
    .bind(plan)
    .execute(&db.pool)
    .await
    .unwrap();
}

async fn audit_actions(db: &TestDb, target: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id")
        .bind(target.to_string())
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

#[test]
fn text_rules() {
    assert_eq!(clean_title("  公告  ").unwrap(), "公告");
    assert_eq!(
        clean_title("").unwrap_err().code(),
        "announcement.title_required"
    );
    assert_eq!(
        clean_title("a\nb").unwrap_err().code(),
        "announcement.title_multiline"
    );
    assert_eq!(
        clean_title(&"x".repeat(MAX_TITLE + 1)).unwrap_err().code(),
        "announcement.title_long"
    );
    assert_eq!(clean_markdown(" a\r\nb\rc\0d\t ").unwrap(), "a\nb\ncd");
    assert_eq!(
        clean_markdown(" \n ").unwrap_err().code(),
        "announcement.body_required"
    );
    assert_eq!(
        clean_markdown(&"x".repeat(MAX_BODY + 1))
            .unwrap_err()
            .code(),
        "announcement.body_long"
    );
    let base: AnnouncementReq = serde_json::from_value(body("t", json!({}))).unwrap();
    let c = check(&base).unwrap();
    assert!(c.enabled && !c.pinned && c.audience == "all" && c.title_en.is_none());
    let mut r = base.clone();
    r.audience = "vip".into();
    assert_eq!(
        check(&r).unwrap_err().code(),
        "announcement.audience_invalid"
    );
    let mut r = base.clone();
    r.visible_from = Some(Utc::now());
    r.visible_until = Some(Utc::now() - chrono::Duration::hours(1));
    assert_eq!(check(&r).unwrap_err().code(), "announcement.window_invalid");
    let mut r = base.clone();
    r.title_en = Some("  ".into());
    r.body_en = Some(String::new());
    let c = check(&r).unwrap();
    assert!(c.title_en.is_none() && c.body_en.is_none());
    // Unknown members are refused (deny_unknown_fields).
    assert!(serde_json::from_value::<AnnouncementReq>(body("t", json!({ "zz": 1 }))).is_err());
}

/// Users see enabled announcements inside their window for their
/// audience; every other id (disabled, future, past, other audience,
/// unknown, malformed) is the canonical rejection. Reading marks one read.
#[tokio::test]
async fn users_see_only_visible_ones() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let free = db.user().await;
    let paying = db.user().await;
    give_plan(&db, paying).await;
    let now = Utc::now();
    let a = create(
        &admin,
        body(
            "A 所有人",
            json!({ "title_en": "A everyone", "body_en": "english *body*" }),
        ),
    )
    .await;
    let b = create(&admin, body("B 停用", json!({ "enabled": false }))).await;
    let c = create(
        &admin,
        body(
            "C 未来",
            json!({ "visible_from": now + chrono::Duration::hours(1) }),
        ),
    )
    .await;
    let d = create(&admin, body("D 过去", json!({ "visible_from": now - chrono::Duration::hours(2), "visible_until": now - chrono::Duration::hours(1) }))).await;
    let e = create(
        &admin,
        body(
            "E 有套餐",
            json!({ "audience": "with_plan", "pinned": true }),
        ),
    )
    .await;
    let f = create(
        &admin,
        body("F 无套餐", json!({ "audience": "without_plan" })),
    )
    .await;
    let g = create(&admin, body("G 窗口内", json!({ "visible_from": now - chrono::Duration::hours(1), "visible_until": now + chrono::Duration::hours(1) }))).await;

    let cf = client_for(&state, free).await;
    let r = cf.get("/test/api/v1/me/announcements").await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    let ids: Vec<Uuid> = v["announcements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap().parse().unwrap())
        .collect();
    // Newest first (g, f, a), no pinned ones for this user.
    assert_eq!(ids, vec![g, f, a]);
    assert_eq!(v["unread"], 3);
    let first = &v["announcements"][2];
    assert_eq!(first["title_en"], "A everyone");
    assert!(
        first["html_zh"]
            .as_str()
            .unwrap()
            .contains("<strong>正文</strong>")
    );
    assert!(
        first["html_zh"]
            .as_str()
            .unwrap()
            .contains("&lt;script&gt;")
    );
    assert!(!first["html_zh"].as_str().unwrap().contains("<script"));
    assert!(first["html_en"].as_str().unwrap().contains("<em>body</em>"));
    assert_eq!(first["read"], false);
    assert!(v["announcements"][1]["html_en"].is_null());

    let cp = client_for(&state, paying).await;
    let v = cp.get("/test/api/v1/me/announcements").await.json();
    let ids: Vec<Uuid> = v["announcements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap().parse().unwrap())
        .collect();
    // Pinned first, then newest.
    assert_eq!(ids, vec![e, g, a]);

    // Read state.
    let r = cf
        .req(
            Method::POST,
            &format!("/test/api/v1/me/announcements/{a}/read"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let v = cf.get("/test/api/v1/me/announcements").await.json();
    assert_eq!(v["unread"], 2);
    assert_eq!(v["announcements"][2]["read"], true);
    // Idempotent.
    let r = cf
        .req(
            Method::POST,
            &format!("/test/api/v1/me/announcements/{a}/read"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    // The paying user's read state is separate.
    let v = cp.get("/test/api/v1/me/announcements").await.json();
    assert_eq!(v["unread"], 3);

    // Everything the free user may not see is the canonical rejection.
    let canonical = cf.get("/test/no-such-path").await.fingerprint();
    assert_eq!(canonical.0, StatusCode::NOT_FOUND);
    for id in [
        b.to_string(),
        c.to_string(),
        d.to_string(),
        e.to_string(),
        Uuid::new_v4().to_string(),
        "not-a-uuid".into(),
    ] {
        let r = cf
            .req(
                Method::POST,
                &format!("/test/api/v1/me/announcements/{id}/read"),
                None,
            )
            .await;
        assert_eq!(r.fingerprint(), canonical, "{id}");
    }
    // No read row was written for them.
    let reads: i64 =
        sqlx::query_scalar("SELECT count(*) FROM announcement_reads WHERE user_id = $1")
            .bind(free)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(reads, 1);
    // No session: the user endpoints are 401 like the rest of /me.
    let anon = Client::new(&state, rand_ip());
    assert_eq!(
        anon.get("/test/api/v1/me/announcements").await.status,
        StatusCode::UNAUTHORIZED
    );
    // The expired (renewal scope) user still sees the dashboard list.
    sqlx::query("UPDATE users SET expires_at = now() - interval '1 day' WHERE id = $1")
        .bind(free)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        cf.get("/test/api/v1/me/announcements").await.status,
        StatusCode::OK
    );
    let _ = f;
    db.drop().await;
}

/// Admin CRUD: validation, 404s, every change audited exactly once (a
/// no-op PUT writes nothing), customers refused.
#[tokio::test]
async fn admin_crud_and_audit() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;
    for (status, b) in [
        (
            StatusCode::BAD_REQUEST,
            json!({ "title_zh": "", "body_zh": "x" }),
        ),
        (
            StatusCode::BAD_REQUEST,
            json!({ "title_zh": "t", "body_zh": "" }),
        ),
        (
            StatusCode::BAD_REQUEST,
            json!({ "title_zh": "t", "body_zh": "x", "audience": "x" }),
        ),
        (
            StatusCode::BAD_REQUEST,
            json!({ "title_zh": "t", "body_zh": "x", "nope": 1 }),
        ),
    ] {
        let r = admin.post("/test/api/v1/announcements", b).await;
        assert_eq!(r.status, status, "{}", String::from_utf8_lossy(&r.body));
    }
    assert_eq!(
        admin
            .post(
                "/test/api/v1/announcements",
                json!({ "title_zh": "t", "body_zh": "x", "audience": "x" })
            )
            .await
            .json()["code"],
        "announcement.audience_invalid"
    );
    let id = create(&admin, body("维护", json!({ "pinned": true }))).await;
    assert_eq!(
        user.post("/test/api/v1/announcements", body("x", json!({})))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        user.get("/test/api/v1/announcements").await.status,
        StatusCode::FORBIDDEN
    );
    let list = admin.get("/test/api/v1/announcements").await.json();
    let row = list
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == id.to_string())
        .unwrap();
    assert_eq!(row["pinned"], true);
    assert_eq!(row["active"], true);
    assert_eq!(row["reads"], 0);
    assert_eq!(row["body_zh"], "**正文** <script>x</script>");
    assert_eq!(
        admin
            .get(&format!("/test/api/v1/announcements/{id}"))
            .await
            .json()["title_zh"],
        "维护"
    );
    // Replace.
    let path = format!("/test/api/v1/announcements/{id}");
    let put = |v: Value| admin.req(Method::PUT, &path, Some(v));
    let r = put(body(
        "维护（更新）",
        json!({ "enabled": false, "pinned": true }),
    ))
    .await;
    assert_eq!(
        r.status,
        StatusCode::NO_CONTENT,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    // Same content again: no audit row.
    assert_eq!(
        put(body(
            "维护（更新）",
            json!({ "enabled": false, "pinned": true })
        ))
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    let v = admin
        .get(&format!("/test/api/v1/announcements/{id}"))
        .await
        .json();
    assert_eq!(v["title_zh"], "维护（更新）");
    assert_eq!(v["active"], false);
    assert_eq!(
        admin
            .req(
                Method::PUT,
                &format!("/test/api/v1/announcements/{}", Uuid::new_v4()),
                Some(body("x", json!({})))
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        put(json!({ "title_zh": "", "body_zh": "x" })).await.status,
        StatusCode::BAD_REQUEST
    );
    // Preview renders the safe subset.
    let r = admin
        .post(
            "/test/api/v1/content/preview",
            json!({ "markdown": "# 标题\n\n<img src=x onerror=1>" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let html = r.json()["html"].as_str().unwrap().to_string();
    assert!(
        html.starts_with("<h3>标题</h3>") && !html.contains("<img") && html.contains("&lt;img")
    );
    assert_eq!(
        user.post("/test/api/v1/content/preview", json!({ "markdown": "x" }))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    // Delete.
    assert_eq!(
        user.req(
            Method::DELETE,
            &format!("/test/api/v1/announcements/{id}"),
            None
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        admin
            .req(
                Method::DELETE,
                &format!("/test/api/v1/announcements/{id}"),
                None
            )
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        admin
            .req(
                Method::DELETE,
                &format!("/test/api/v1/announcements/{id}"),
                None
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        audit_actions(&db, id).await,
        [
            "announcement.create",
            "announcement.update",
            "announcement.delete"
        ]
    );
    // The audit rows carry titles and lengths, never bodies.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE after::text LIKE '%<script>x%' OR before::text LIKE '%<script>x%'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    db.drop().await;
}

/// Mailing: needs SMTP (409 otherwise), one running mailing at a time
/// (409), batches walk the audience through the outbox exactly once per
/// verified recipient in their language, a finished mailing can run again.
#[tokio::test]
async fn mailing_batches_the_audience() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let id = create(
        &admin,
        body(
            "通知",
            json!({ "title_en": "Notice", "body_en": "english", "audience": "with_plan" }),
        ),
    )
    .await;
    let mail_path = format!("/test/api/v1/announcements/{id}/mail");
    let mail = |_: Uuid| admin.req(Method::POST, &mail_path, None);
    let r = mail(id).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "announcement.mail_unavailable");
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', port = 1025, security = 'none', \
         from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    // Recipients: three verified customers with a plan (one English, one
    // quota-disabled), one verified without a plan, one unverified with a
    // plan, one admin-disabled with a plan.
    let mut with_plan = Vec::new();
    for (i, (locale, extra)) in [
        ("zh", ""),
        ("en", ""),
        ("zh", ", enabled = false, disabled_reason = 'quota'"),
    ]
    .iter()
    .enumerate()
    {
        let u = db.user().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE users SET email = $2, email_verified_at = now(), locale = $3{extra} WHERE id = $1"
        )))
        .bind(u)
        .bind(format!("p{i}@example.com"))
        .bind(locale)
        .execute(&db.pool)
        .await
        .unwrap();
        give_plan(&db, u).await;
        with_plan.push(u);
    }
    let free = db.user().await;
    sqlx::query(
        "UPDATE users SET email = 'free@example.com', email_verified_at = now() WHERE id = $1",
    )
    .bind(free)
    .execute(&db.pool)
    .await
    .unwrap();
    let unverified = db.user().await;
    sqlx::query("UPDATE users SET email = 'unv@example.com' WHERE id = $1")
        .bind(unverified)
        .execute(&db.pool)
        .await
        .unwrap();
    give_plan(&db, unverified).await;
    let disabled = db.user().await;
    sqlx::query("UPDATE users SET email = 'dis@example.com', email_verified_at = now(), enabled = false, disabled_reason = 'admin' WHERE id = $1")
        .bind(disabled)
        .execute(&db.pool)
        .await
        .unwrap();
    give_plan(&db, disabled).await;

    assert_eq!(mail(id).await.status, StatusCode::ACCEPTED);
    let r = mail(id).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "announcement.mail_in_progress");
    let smtp = crate::mail::load(&mut db.pool.acquire().await.unwrap())
        .await
        .unwrap();
    // Batches of one: three passes queue one each, the fourth finds the
    // end (fewer than a batch) and finishes.
    let mut queued = Vec::new();
    for _ in 0..6 {
        queued.push(mail_pass_batch(&state, &smtp, 1).await.unwrap());
    }
    assert_eq!(queued, [1, 1, 1, 0, 0, 0]);
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT to_addr, subject, body_text FROM mail_outbox WHERE kind = 'announcement' ORDER BY to_addr",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].0, "p0@example.com");
    assert!(rows[0].1.contains("通知") && rows[0].2.contains("**正文**"));
    assert_eq!(rows[1].0, "p1@example.com");
    assert!(
        rows[1].1.contains("Notice") && rows[1].2.contains("english"),
        "{:?}",
        rows[1]
    );
    assert_eq!(rows[2].0, "p2@example.com");
    let v = admin
        .get(&format!("/test/api/v1/announcements/{id}"))
        .await
        .json();
    assert_eq!(v["mail_sent"], 3);
    assert!(!v["mail_done_at"].is_null());
    // Finished: a new request starts over (and re-queues).
    assert_eq!(mail(id).await.status, StatusCode::ACCEPTED);
    assert_eq!(mail_pass(&state, &smtp).await.unwrap(), 3);
    assert_eq!(mail_pass(&state, &smtp).await.unwrap(), 0);
    assert_eq!(
        audit_actions(&db, id).await,
        [
            "announcement.create",
            "announcement.mail",
            "announcement.mail"
        ]
    );
    db.drop().await;
}
