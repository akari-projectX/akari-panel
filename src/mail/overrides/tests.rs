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
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', port = 1025, security = 'none', \
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
    assert!(row["updated_at"].is_null() && row["updated_by"].is_null());
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
    async fn enqueue(db: &TestDb, smtp: &crate::mail::MailSettings, tpl: &crate::mail::Template) {
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
    // v2's "已自定义 · 时间 · 人": when and by whom it was last saved.
    assert!(row["updated_at"].as_str().is_some_and(|t| t.contains('T')));
    assert!(row["updated_by"].as_str().is_some_and(|b| !b.is_empty()));
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

/// An HTML source replaces the whole HTML part (the panel's shell included)
/// for the next mail, keeps the plain-text alternative, is validated at the
/// API and in the preview, comes back in the list and can be dropped again.
#[tokio::test]
async fn html_source_replaces_the_html_part() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', port = 1025, security = 'none', \
         from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE panel_settings SET site_name = 'Akari <Test>' WHERE id = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    let path = "/test/api/v1/settings/mail-templates/register_code/zh";
    let put = |body: serde_json::Value| {
        let admin = &admin;
        async move { admin.req(Method::PUT, path, Some(body)).await }
    };
    let source = "<!doctype html><html><body style=\"background:#fff\">\
                  <h2>{site}</h2><p class=\"code\">{code}</p><p>{minutes} 分钟</p></body></html>";

    // Validation: the same placeholder rules as the text, plus the HTML ones.
    for (html, code) in [
        ("<p>{site}</p>", "mail_template.placeholder_missing"),
        ("<p>{code}{nope}</p>", "mail_template.placeholder_unknown"),
        (
            "<script>x</script><p>{code}</p>",
            "mail_template.html_forbidden",
        ),
        (
            "<a href=\"javascript:x\">{code}</a>",
            "mail_template.html_forbidden",
        ),
        ("   ", "mail_template.html_length"),
    ] {
        let r = put(json!({ "version": 0, "subject": "x", "body": "{code}", "html_source": html }))
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{html}");
        assert_eq!(r.json()["code"], code, "{html}");
    }
    assert_eq!(
        user.req(
            Method::PUT,
            path,
            Some(json!({ "version": 0, "subject": "x", "body": "{code}", "html_source": source }))
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    // Nothing was stored by the refusals.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM mail_templates")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // The preview validates too and renders the source with sample values.
    let preview = |html: Option<&str>| {
        let admin = &admin;
        let html = html.map(String::from);
        async move {
            admin
                .req(
                    Method::POST,
                    "/test/api/v1/settings/mail-templates/preview",
                    Some(
                        json!({ "kind": "register_code", "locale": "zh", "subject": "S {site}",
                                 "body": "{code}", "html_source": html }),
                    ),
                )
                .await
        }
    };
    let r = preview(Some("<p>nothing</p>")).await;
    assert_eq!(r.json()["code"], "mail_template.placeholder_missing");
    let r = preview(Some(source)).await;
    assert_eq!(r.status, StatusCode::OK);
    let html = r.json()["html"].as_str().unwrap().to_string();
    assert!(
        html.starts_with(
            "<!doctype html><html><body style=\"background:#fff\"><h2>Akari &lt;Test&gt;</h2>"
        ),
        "{html}"
    );
    assert!(
        !html.contains("max-width:520px"),
        "the panel shell is gone: {html}"
    );
    // Without a source the panel's shell is still used.
    let r = preview(None).await;
    assert!(
        r.json()["html"]
            .as_str()
            .unwrap()
            .contains("max-width:520px")
    );

    // Store it; the list shows it and the starter; the mail uses it.
    let r = put(json!({ "version": 0, "subject": "[{site}] {code}", "body": "Your code:\n\n{code}", "html_source": source })).await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let list = admin
        .get("/test/api/v1/settings/mail-templates")
        .await
        .json();
    let rows = list.as_array().unwrap();
    let row = rows
        .iter()
        .find(|r| r["kind"] == "register_code" && r["locale"] == "zh")
        .unwrap();
    assert_eq!(row["html_source"], source);
    let starter = row["starter_html"].as_str().unwrap();
    assert!(
        starter.contains("{code}") && starter.contains("{site}"),
        "{starter}"
    );
    let other = rows
        .iter()
        .find(|r| r["kind"] == "register_code" && r["locale"] == "en")
        .unwrap();
    assert_eq!(other["html_source"], serde_json::Value::Null);

    let smtp = crate::mail::load(&mut db.pool.acquire().await.unwrap())
        .await
        .unwrap();
    let tpl = crate::mail::Template::RegisterCode {
        code: "246810".into(),
        minutes: 10,
    };
    let enqueue = || async {
        let mut c = db.pool.acquire().await.unwrap();
        crate::mail::enqueue(
            &mut c,
            &smtp,
            &tpl,
            Locale::Zh,
            "a@example.com",
            None,
            Some(600),
        )
        .await
        .unwrap();
    };
    let last = || async {
        sqlx::query_as::<_, (String, String)>(
            "SELECT body_text, body_html FROM mail_outbox ORDER BY id DESC LIMIT 1",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap()
    };
    enqueue().await;
    let (text, html) = last().await;
    assert_eq!(
        html,
        "<!doctype html><html><body style=\"background:#fff\">\
         <h2>Akari &lt;Test&gt;</h2><p class=\"code\">246810</p><p>10 分钟</p></body></html>"
    );
    assert!(text.contains("Your code:\n\n    246810"), "{text}");

    // Saving again without a source drops it (the body alone is the template).
    let r = put(json!({ "version": 1, "subject": "s {site}", "body": "{code}" })).await;
    assert_eq!(r.status, StatusCode::OK);
    enqueue().await;
    assert!(last().await.1.contains("max-width:520px"));
    // Reset removes the row (and with it any source).
    let r =
        put(json!({ "version": 2, "subject": "s", "body": "{code}", "html_source": source })).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = admin.req(Method::DELETE, path, None).await;
    assert_eq!(r.json()["reset"], true);
    enqueue().await;
    assert!(last().await.1.contains("max-width:520px"));

    // The audit rows carry the source's length, never the source.
    let rows: Vec<(String, Option<serde_json::Value>)> = sqlx::query_as(
        "SELECT action, after FROM audit_log WHERE target_id = 'register_code/zh' ORDER BY id",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(
        rows[0].1.as_ref().unwrap()["html_length"],
        source.chars().count()
    );
    assert_eq!(
        rows[1].1.as_ref().unwrap()["html_length"],
        serde_json::Value::Null
    );
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action LIKE 'settings.mail_template.%' \
         AND (after::text LIKE '%class=%' OR before::text LIKE '%class=%')",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(leaked, 0);
    db.drop().await;
}

/// A one-connection SMTP sink on loopback (no TLS, no AUTH): accepts one
/// message and hands back its raw DATA.
async fn capture_smtp() -> (u16, tokio::sync::oneshot::Receiver<String>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let Ok((tcp, _)) = l.accept().await else {
            return;
        };
        let mut io = BufReader::new(tcp);
        let _ = io.get_mut().write_all(b"220 sink ESMTP\r\n").await;
        let mut data = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            if matches!(io.read_line(&mut line).await, Ok(0) | Err(_)) {
                break;
            }
            let cmd = line.trim_end().to_ascii_uppercase();
            let reply: &[u8] = if cmd.starts_with("EHLO") {
                b"250-sink\r\n250 8BITMIME\r\n"
            } else if cmd == "DATA" {
                let _ = io.get_mut().write_all(b"354 go\r\n").await;
                loop {
                    line.clear();
                    if matches!(io.read_line(&mut line).await, Ok(0) | Err(_))
                        || line.trim_end() == "."
                    {
                        break;
                    }
                    data.push_str(&line);
                }
                b"250 queued\r\n"
            } else if cmd == "QUIT" {
                let _ = io.get_mut().write_all(b"221 bye\r\n").await;
                break;
            } else {
                b"250 ok\r\n"
            };
            let _ = io.get_mut().write_all(reply).await;
        }
        let _ = tx.send(data);
    });
    (port, rx)
}

/// "Send current draft": the UNSAVED draft is validated like the preview
/// (errors carry field/line/column), rendered with sample values and sent
/// through the same path, answer and audit as the stored template's test.
#[tokio::test]
async fn test_draft_sends_the_unsaved_draft() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;
    let anon = crate::testdb::http::Client::new(&state, crate::testdb::http::rand_ip());
    const PATH: &str = "/test/api/v1/settings/mail-templates/test-draft";
    let draft = |extra: serde_json::Value| {
        let mut b = json!({ "kind": "register_code", "locale": "en", "subject": "Draft {site}",
                             "body": "Your code:\n\n{code}", "to": "me@example.com" });
        for (k, v) in extra.as_object().unwrap() {
            b[k] = v.clone();
        }
        b
    };

    // Admins only.
    assert_eq!(
        user.post(PATH, draft(json!({}))).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        anon.post(PATH, draft(json!({}))).await.status,
        StatusCode::UNAUTHORIZED
    );
    // Unknown fields are refused.
    assert_eq!(
        admin
            .post(PATH, draft(json!({ "version": 1 })))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    // Validated exactly like the preview, with the position of the problem.
    let r = admin
        .post(PATH, draft(json!({ "body": "Hi\r\nyour {nope}\n{code}" })))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let v = r.json();
    assert_eq!(v["code"], "mail_template.placeholder_unknown");
    assert_eq!(
        v["params"],
        json!({ "name": "nope", "field": "body", "line": 2, "column": 6 })
    );
    let r = admin
        .post(
            "/test/api/v1/settings/mail-templates/preview",
            json!({ "kind": "register_code", "locale": "en", "subject": "s",
                    "body": "Hi\r\nyour {nope}\n{code}" }),
        )
        .await;
    assert_eq!(r.json()["params"], v["params"], "preview reports the same");
    let r = admin
        .post(
            PATH,
            draft(json!({ "html_source": "<p>{code}</p>\n<p><script></script></p>" })),
        )
        .await;
    assert_eq!(r.json()["code"], "mail_template.html_forbidden");
    assert_eq!(r.json()["params"]["field"], "html_source");
    assert_eq!(r.json()["params"]["line"], 2);
    assert_eq!(r.json()["params"]["column"], 4);
    let r = admin.post(PATH, draft(json!({ "kind": "nope" }))).await;
    assert_eq!(r.json()["code"], "mail_template.kind_unknown");

    // A valid draft before mail is set up: the same answer as the stored
    // template's test endpoint.
    let stored = admin
        .post(
            "/test/api/v1/settings/mail-templates/register_code/en/test",
            json!({ "to": "me@example.com" }),
        )
        .await;
    let r = admin.post(PATH, draft(json!({}))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.status, stored.status);
    assert_eq!(r.json()["code"], "mail.test_needs_host");
    assert_eq!(r.json()["code"], stored.json()["code"]);
    assert_eq!(
        admin
            .post(PATH, draft(json!({ "to": "nope" })))
            .await
            .json()["code"],
        "mail.to_invalid"
    );

    // Configured (a local sink): the draft itself is what goes out, not
    // the stored template; nothing is saved; the send is audited.
    let (port, data) = capture_smtp().await;
    sqlx::query(
        "UPDATE mail_settings SET host = '127.0.0.1', port = $1, security = 'none', \
         from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .bind(i32::from(port))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE panel_settings SET site_name = 'Akari Test' WHERE id = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = admin
        .post(
            PATH,
            draft(json!({ "html_source": "<p>DRAFTHTML {code} {site}</p>" })),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    assert_eq!(r.json(), json!({ "ok": true }));
    let raw = data.await.unwrap();
    assert!(raw.contains("Subject: Draft Akari Test"), "{raw}");
    assert!(raw.contains("<p>DRAFTHTML "), "{raw}");
    assert!(raw.contains("Akari Test</p>"), "{raw}");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM mail_templates")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "a test send stores nothing");
    let (after,): (serde_json::Value,) = sqlx::query_as(
        "SELECT after FROM audit_log WHERE action = 'settings.mail.test' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(after["template"], "register_code");
    assert_eq!(after["outcome"], "sent");
    db.drop().await;
}
