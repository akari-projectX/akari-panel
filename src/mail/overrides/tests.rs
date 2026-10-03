//! Ops editable-template tests (real database): an edited template is what
//! `enqueue` sends, placeholder validation at the API, versioning,
//! restore-default, preview, the test endpoint, audit rows.

use axum::http::{Method, StatusCode};
use serde_json::json;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::client_for;

async fn outbox_subjects(db: &TestDb) -> Vec<String> {
    sqlx::query_scalar("SELECT subject FROM mail_outbox ORDER BY id")
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn edited_template_is_used_by_enqueue() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;
    sqlx::query(
        "UPDATE smtp_settings SET enabled = true, host = '127.0.0.1', port = 1025, security = 'none', \
         from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE panel_settings SET site_name = 'Akari Test' WHERE id = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        user.get("/test/api/v1/settings/mail-templates")
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let list = admin
        .get("/test/api/v1/settings/mail-templates")
        .await
        .json();
    let rows = list.as_array().unwrap();
    assert_eq!(rows.len(), KINDS.len() * 2);
    let row = rows
        .iter()
        .find(|r| r["kind"] == "register_code" && r["locale"] == "zh")
        .unwrap();
    assert_eq!(row["custom"], false);
    assert_eq!(row["version"], 0);
    assert_eq!(row["label"], "注册验证码");
    assert!(row["subject"].as_str().unwrap().contains("{site}"));
    assert_eq!(row["placeholders"][0]["name"], "site");
    assert_eq!(row["required"], json!(["code"]));

    let tpl = crate::mail::Template::RegisterCode {
        code: "246810".into(),
        minutes: 10,
    };
    let smtp = crate::mail::load(&mut db.pool.acquire().await.unwrap())
        .await
        .unwrap();
    async fn enqueue(db: &TestDb, smtp: &crate::mail::Smtp, tpl: &crate::mail::Template) {
        let mut c = db.pool.acquire().await.unwrap();
        crate::mail::enqueue(
            &mut c,
            smtp,
            tpl,
            Locale::Zh,
            "a@example.com",
            None,
            Some(600),
        )
        .await
        .unwrap();
    }
    enqueue(&db, &smtp, &tpl).await;
    assert_eq!(outbox_subjects(&db).await, ["Akari Test 注册验证码"]);

    // Validation at the API: unknown placeholder, missing required, bad locale/kind.
    let put = |kind: &str, locale: &str, body: serde_json::Value| {
        let path = format!("/test/api/v1/settings/mail-templates/{kind}/{locale}");
        let admin = &admin;
        async move { admin.req(Method::PUT, &path, Some(body)).await }
    };
    let r = put(
        "register_code",
        "zh",
        json!({ "version": 0, "subject": "x", "body": "{code} {nope}" }),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "mail_template.placeholder_unknown");
    assert_eq!(r.json()["params"]["name"], "nope");
    let r = put(
        "register_code",
        "zh",
        json!({ "version": 0, "subject": "x", "body": "no code" }),
    )
    .await;
    assert_eq!(r.json()["code"], "mail_template.placeholder_missing");
    assert_eq!(
        put(
            "register_code",
            "fr",
            json!({ "version": 0, "subject": "x", "body": "{code}" })
        )
        .await
        .json()["code"],
        "mail_template.locale_invalid"
    );
    assert_eq!(
        put(
            "nope",
            "zh",
            json!({ "version": 0, "subject": "x", "body": "{code}" })
        )
        .await
        .json()["code"],
        "mail_template.kind_unknown"
    );
    assert_eq!(
        put(
            "register_code",
            "zh",
            json!({ "version": 0, "subject": "x", "body": "{code}", "zz": 1 })
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        user.req(
            Method::PUT,
            "/test/api/v1/settings/mail-templates/register_code/zh",
            Some(json!({ "version": 0, "subject": "x", "body": "{code}" }))
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );

    // Store an override; the next mail uses it.
    let r = put("register_code", "zh", json!({ "version": 0, "subject": "【{site}】验证码 {code}", "body": "你的验证码：\r\n\r\n{code}\r\n\r\n{minutes} 分钟内有效。" })).await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    assert_eq!(r.json()["version"], 1);
    enqueue(&db, &smtp, &tpl).await;
    let subjects = outbox_subjects(&db).await;
    assert_eq!(subjects[1], "【Akari Test】验证码 246810");
    let (text, html): (String, String) =
        sqlx::query_as("SELECT body_text, body_html FROM mail_outbox ORDER BY id DESC LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(
        text.contains("你的验证码：\n\n    246810\n\n10 分钟内有效。"),
        "{text}"
    );
    assert!(html.contains("letter-spacing:6px") && html.contains("246810"));
    // The English mail is untouched.
    let mut c = db.pool.acquire().await.unwrap();
    let r = render_for(&mut c, &tpl, Locale::En, "S").await.unwrap();
    assert_eq!(r.subject, "Your S sign-up code");
    drop(c);
    // Stale version → 409; current → new version.
    let r = put(
        "register_code",
        "zh",
        json!({ "version": 0, "subject": "s", "body": "{code}" }),
    )
    .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "mail_template.version_conflict");
    let r = put(
        "register_code",
        "zh",
        json!({ "version": 1, "subject": "s2 {site}", "body": "{code}" }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["version"], 2);
    let list = admin
        .get("/test/api/v1/settings/mail-templates")
        .await
        .json();
    let row = list
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["kind"] == "register_code" && r["locale"] == "zh")
        .unwrap();
    assert_eq!(row["custom"], true);
    assert_eq!(row["version"], 2);
    assert_eq!(row["subject"], "s2 {site}");
    assert!(
        row["default_subject"]
            .as_str()
            .unwrap()
            .contains("注册验证码")
    );

    // Preview with sample values (validated).
    let r = admin.post("/test/api/v1/settings/mail-templates/preview", json!({ "kind": "password_reset", "locale": "en", "subject": "Reset {site}", "body": "Open:\n\n{link}" })).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["subject"], "Reset Akari Test");
    assert!(v["html"].as_str().unwrap().contains("Reset password"));
    assert!(v["text"].as_str().unwrap().contains("#token=example"));
    let r = admin
        .post(
            "/test/api/v1/settings/mail-templates/preview",
            json!({ "kind": "password_reset", "locale": "en", "subject": "x", "body": "no link" }),
        )
        .await;
    assert_eq!(r.json()["code"], "mail_template.placeholder_missing");

    // The test send renders the stored version; the SMTP sink here is not
    // listening, so the answer is 502 with the server detail (and audited).
    let r = admin
        .post(
            "/test/api/v1/settings/mail-templates/register_code/zh/test",
            json!({ "to": "me@example.com" }),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::BAD_GATEWAY,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    assert_eq!(r.json()["code"], "mail.test_failed");
    let (after,): (serde_json::Value,) = sqlx::query_as(
        "SELECT after FROM audit_log WHERE action = 'settings.mail.test' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(after["template"], "register_code");
    assert_eq!(
        admin
            .post(
                "/test/api/v1/settings/mail-templates/register_code/zh/test",
                json!({ "to": "nope" })
            )
            .await
            .json()["code"],
        "mail.to_invalid"
    );

    // Restore the default.
    let r = admin
        .req(
            Method::DELETE,
            "/test/api/v1/settings/mail-templates/register_code/zh",
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["reset"], true);
    assert_eq!(
        admin
            .req(
                Method::DELETE,
                "/test/api/v1/settings/mail-templates/register_code/zh",
                None
            )
            .await
            .json()["reset"],
        false
    );
    enqueue(&db, &smtp, &tpl).await;
    assert_eq!(outbox_subjects(&db).await[2], "Akari Test 注册验证码");
    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE target_id = 'register_code/zh' ORDER BY id",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        actions,
        [
            "settings.mail_template.update",
            "settings.mail_template.update",
            "settings.mail_template.reset"
        ]
    );
    // The audit rows carry subjects and lengths, not bodies.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action LIKE 'settings.mail_template.%' AND (after::text LIKE '%分钟内有效%' OR before::text LIKE '%分钟内有效%')")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    db.drop().await;
}
