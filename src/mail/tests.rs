//! W15 outbox/sender/notices tests (real DB).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::{Method, StatusCode};
use serde_json::json;
use uuid::Uuid;

use super::sender;
use super::transport::{OutMsg, SendError, SendFuture, Transport};
use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, rand_ip};

/// Counts deliveries per recipient; optionally fails by recipient.
#[derive(Default, Clone)]
struct Recorder {
    sent: Arc<Mutex<HashMap<String, usize>>>,
    /// recipient → (permanent?, message)
    fail: Arc<Mutex<HashMap<String, (bool, String)>>>,
    delay: Duration,
}

impl Transport for Recorder {
    fn send<'a>(&'a self, msg: &'a OutMsg) -> SendFuture<'a> {
        Box::pin(async move {
            tokio::time::sleep(self.delay).await;
            if let Some((permanent, message)) = self.fail.lock().unwrap().get(&msg.to).cloned() {
                return Err(SendError { permanent, message });
            }
            assert!(!msg.text.is_empty() && msg.html.starts_with("<!doctype html>"));
            *self.sent.lock().unwrap().entry(msg.to.clone()).or_default() += 1;
            Ok(())
        })
    }
}

async fn smtp(db: &TestDb) -> MailSettings {
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', port = 1025, \
         security = 'none', from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    load(&mut db.pool.acquire().await.unwrap()).await.unwrap()
}

async fn queue(db: &TestDb, s: &MailSettings, t: &Template, to: &str, discard: Option<i64>) -> i64 {
    let mut c = db.pool.acquire().await.unwrap();
    enqueue(&mut c, s, t, Locale::Zh, to, None, discard)
        .await
        .unwrap()
}

#[derive(sqlx::FromRow, Debug)]
struct Row {
    status: String,
    attempts: i32,
    body_text: String,
    last_error: Option<String>,
    retry_in: Option<f64>,
}

async fn row(db: &TestDb, id: i64) -> Row {
    sqlx::query_as(
        "SELECT status, attempts, body_text, last_error, \
         extract(epoch FROM next_attempt_at - now())::float8 AS retry_in \
         FROM mail_outbox WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

#[test]
fn backoff_doubles_and_caps() {
    assert_eq!(
        (1..=9).map(sender::backoff).collect::<Vec<_>>(),
        [30, 60, 120, 240, 480, 960, 1920, 3600, 3600]
    );
    assert_eq!(sender::backoff(0), 30);
    assert_eq!(sender::backoff(i32::MAX), 3600);
}

#[test]
fn smtp_values_rules() {
    let base = MailReq {
        version: 0,
        enabled: true,
        provider: None,
        host: Some(" Smtp.Example.COM ".into()),
        port: 587,
        security: "starttls".into(),
        username: Some("u".into()),
        password: Some(Some("p".into())),
        api_key: None,
        from_addr: Some("A@Example.com".into()),
        from_name: Some(" Akari ".into()),
        notify_order_paid: true,
        notify_expiry_days: 3,
        notify_expired: true,
        notify_quota: true,
        notify_refund: None,
    };
    let v = mail_values(&base).unwrap();
    assert_eq!(v.host.as_deref(), Some("smtp.example.com"));
    assert_eq!(v.from_addr.as_deref(), Some("a@example.com"));
    assert_eq!(v.from_name.as_deref(), Some("Akari"));
    assert_eq!(v.password, Some(Some("p".into())));
    let with = |f: &dyn Fn(&mut MailReq)| {
        let mut r = MailReq { ..clone_req(&base) };
        f(&mut r);
        mail_values(&r)
    };
    assert_eq!(
        with(&|r| r.password = Some(Some(String::new())))
            .unwrap()
            .password,
        Some(None)
    );
    assert_eq!(with(&|r| r.password = None).unwrap().password, None, "keep");
    assert_eq!(
        with(&|r| {
            r.username = Some("  ".into());
            r.security = "none".into();
        })
        .unwrap()
        .password,
        Some(None),
        "no username → no password"
    );
    assert!(with(&|r| r.security = "none".into()).is_err());
    assert!(with(&|r| r.security = "ssl".into()).is_err());
    assert!(with(&|r| r.host = Some("a b".into())).is_err());
    assert_eq!(
        with(&|r| r.host = Some("10.0.0.5".into()))
            .unwrap()
            .host
            .as_deref(),
        Some("10.0.0.5")
    );
    assert!(with(&|r| r.port = 70000).is_err());
    assert!(with(&|r| r.username = Some("a\nb".into())).is_err());
    assert!(with(&|r| r.password = Some(Some("a\r\nb".into()))).is_err());
    assert!(with(&|r| r.from_name = Some("a\nBcc: x".into())).is_err());
    // Completeness for enabling depends on the stored secrets/provider:
    // checked by apply_update_mail (tested there), not here.
    assert!(with(&|r| r.host = None).is_ok());
    assert!(with(&|r| r.provider = Some("sendgrid".into())).is_err());
    assert_eq!(
        with(&|r| r.provider = Some("resend".into()))
            .unwrap()
            .provider
            .as_deref(),
        Some("resend")
    );
    assert!(with(&|r| r.api_key = Some(Some("re_\nx".into()))).is_err());
    assert_eq!(
        with(&|r| r.api_key = Some(Some(String::new())))
            .unwrap()
            .api_key,
        Some(None)
    );
    let off = with(&|r| {
        r.enabled = false;
        r.host = None;
        r.from_addr = None;
    })
    .unwrap();
    assert!(!off.enabled);
}

fn clone_req(r: &MailReq) -> MailReq {
    MailReq {
        version: r.version,
        enabled: r.enabled,
        provider: r.provider.clone(),
        host: r.host.clone(),
        port: r.port,
        security: r.security.clone(),
        username: r.username.clone(),
        password: r.password.clone(),
        api_key: r.api_key.clone(),
        from_addr: r.from_addr.clone(),
        from_name: r.from_name.clone(),
        notify_order_paid: r.notify_order_paid,
        notify_expiry_days: r.notify_expiry_days,
        notify_expired: r.notify_expired,
        notify_quota: r.notify_quota,
        notify_refund: r.notify_refund,
    }
}

/// Two senders (think: two panel instances) draining the same outbox
/// concurrently deliver every message exactly once.
#[tokio::test]
async fn two_senders_deliver_each_message_exactly_once() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let s = smtp(&db).await;
    let n = 40;
    for i in 0..n {
        queue(&db, &s, &Template::Test, &format!("m{i}@example.com"), None).await;
    }
    let rec = Recorder {
        delay: Duration::from_millis(5),
        ..Default::default()
    };
    let mut tasks = Vec::new();
    for _ in 0..2 {
        let (pool, rec) = (db.pool.clone(), rec.clone());
        tasks.push(tokio::spawn(async move {
            let mut total = 0;
            loop {
                let k = sender::deliver_due(&pool, &rec, 7).await.unwrap();
                if k == 0 {
                    break total;
                }
                total += k;
            }
        }));
    }
    let mut claimed = Vec::new();
    for t in tasks {
        claimed.push(t.await.unwrap());
    }
    assert_eq!(claimed.iter().sum::<usize>(), n, "{claimed:?}");
    assert!(
        claimed.iter().all(|&c| c > 0),
        "both senders worked: {claimed:?}"
    );
    let sent = rec.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), n);
    assert!(sent.values().all(|&c| c == 1), "{sent:?}");
    let left: (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE status <> 'sent'), \
         count(*) FILTER (WHERE body_text <> '' OR body_html <> '') FROM mail_outbox",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(left, (0, 0), "all sent, bodies cleared");
    db.drop().await;
}

#[tokio::test]
async fn failures_retry_dead_letter_and_expire() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let s = smtp(&db).await;
    let rec = Recorder::default();
    let transient = queue(&db, &s, &Template::Test, "t@example.com", None).await;
    let permanent = queue(
        &db,
        &s,
        &Template::RegisterCode {
            code: "123456".into(),
            minutes: 10,
        },
        "p@example.com",
        Some(600),
    )
    .await;
    rec.fail
        .lock()
        .unwrap()
        .insert("t@example.com".into(), (false, "421 try later".into()));
    rec.fail
        .lock()
        .unwrap()
        .insert("p@example.com".into(), (true, "550 no such user".into()));
    assert_eq!(sender::deliver_due(&db.pool, &rec, 10).await.unwrap(), 2);
    let t = row(&db, transient).await;
    assert_eq!((t.status.as_str(), t.attempts), ("pending", 1));
    assert_eq!(t.last_error.as_deref(), Some("421 try later"));
    assert!((25.0..=31.0).contains(&t.retry_in.unwrap()), "{t:?}");
    let p = row(&db, permanent).await;
    assert_eq!(p.status, "dead");
    assert_eq!(p.body_text, "", "secret-bearing dead letter is cleared");
    // Not due yet: nothing claimed.
    assert_eq!(sender::deliver_due(&db.pool, &rec, 10).await.unwrap(), 0);
    // Exhaust the retries.
    for _ in 1..sender::MAX_ATTEMPTS {
        sqlx::query("UPDATE mail_outbox SET next_attempt_at = now() WHERE id = $1")
            .bind(transient)
            .execute(&db.pool)
            .await
            .unwrap();
        sender::deliver_due(&db.pool, &rec, 10).await.unwrap();
    }
    let t = row(&db, transient).await;
    assert_eq!(
        (t.status.as_str(), t.attempts),
        ("dead", sender::MAX_ATTEMPTS)
    );
    assert!(
        !t.body_text.is_empty(),
        "a plain dead letter keeps its body (retry)"
    );

    // A held lease is respected; an expired one is re-claimed.
    let leased = queue(&db, &s, &Template::Test, "l@example.com", None).await;
    sqlx::query(
        "UPDATE mail_outbox SET claimed_until = now() + interval '1 minute', \
         claim_token = gen_random_uuid() WHERE id = $1",
    )
    .bind(leased)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(sender::deliver_due(&db.pool, &rec, 10).await.unwrap(), 0);
    sqlx::query("UPDATE mail_outbox SET claimed_until = now() - interval '1 second' WHERE id = $1")
        .bind(leased)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(sender::deliver_due(&db.pool, &rec, 10).await.unwrap(), 1);
    assert_eq!(row(&db, leased).await.status, "sent");

    // Codes past discard_after are never sent late.
    let stale = queue(
        &db,
        &s,
        &Template::EmailCode {
            code: "654321".into(),
            minutes: 10,
        },
        "s@example.com",
        Some(600),
    )
    .await;
    sqlx::query("UPDATE mail_outbox SET discard_after = now() - interval '1 second' WHERE id = $1")
        .bind(stale)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(sender::deliver_due(&db.pool, &rec, 10).await.unwrap(), 0);
    sender::maintain(&db.pool).await.unwrap();
    let st = row(&db, stale).await;
    assert_eq!(st.status, "dead");
    assert_eq!(st.last_error.as_deref(), Some("expired before delivery"));
    assert_eq!(st.body_text, "");

    // Admin: list dead letters (no bodies) and retry the retryable one.
    let state = crate::state::AppState::for_test(db.pool.clone()).await;
    let admin = db.admin().await;
    let mut c = Client::new(&state, rand_ip());
    c.cookie = Some(crate::auth::issue_token(&state, admin, "admin", 0).unwrap());
    let list = c.get("/test/api/v1/mail/outbox?status=dead").await;
    assert_eq!(list.status, StatusCode::OK);
    let list = list.json();
    let rows = list.as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|r| r.get("body_text").is_none()));
    let retryable: Vec<i64> = rows
        .iter()
        .filter(|r| r["retryable"] == true)
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    assert_eq!(retryable, [transient]);
    let r = c
        .req(
            Method::POST,
            &format!("/test/api/v1/mail/outbox/{permanent}/retry"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let r = c
        .req(
            Method::POST,
            &format!("/test/api/v1/mail/outbox/{transient}/retry"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    rec.fail.lock().unwrap().clear();
    assert_eq!(sender::deliver_due(&db.pool, &rec, 10).await.unwrap(), 1);
    assert_eq!(row(&db, transient).await.status, "sent");
    assert_eq!(
        c.get("/test/api/v1/mail/outbox?status=bogus").await.status,
        StatusCode::BAD_REQUEST
    );
    let v = c.get("/test/api/v1/settings/mail").await.json();
    assert_eq!(v["dead_letters"], 2);
    db.drop().await;
}

async fn notice_user(db: &TestDb, sql: &str) -> (Uuid, String) {
    let id = db.user().await;
    let email = format!("n{}@example.com", &id.simple().to_string()[..10]);
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE users SET email = $2, email_verified_at = now(), {sql} WHERE id = $1"
    )))
    .bind(id)
    .bind(&email)
    .execute(&db.pool)
    .await
    .unwrap();
    (id, email)
}

/// A subscription of `user` ending at the account's expiry, in `status`.
async fn subscribe(db: &TestDb, user: Uuid, status: &str) {
    let plan: Uuid = sqlx::query_scalar(
        "INSERT INTO plans (id, name, reset_period) \
         VALUES (gen_random_uuid(), 'n-' || $1::text, 'none') RETURNING id",
    )
    .bind(user)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO user_plans (id, user_id, plan_id, status, expires_at, period_anchor, \
         term_kind, ended_at) SELECT gen_random_uuid(), u.id, $2, $3::user_plan_status, \
         u.expires_at, now(), 'month', CASE WHEN $3 = 'active' THEN NULL ELSE now() END \
         FROM users u WHERE u.id = $1",
    )
    .bind(user)
    .bind(plan)
    .bind(status)
    .execute(&db.pool)
    .await
    .unwrap();
}

async fn kinds_to(db: &TestDb, to: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT kind FROM mail_outbox WHERE to_addr = $1 ORDER BY id")
        .bind(to)
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

async fn run_pass(db: &TestDb, s: &MailSettings) -> usize {
    let mut tx = db.pool.begin().await.unwrap();
    let n = notices::pass(&mut tx, s, Some("https://p.example/x/app"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    n
}

#[tokio::test]
async fn notices_once_per_event() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let s = smtp(&db).await;
    let (q, q_mail) = notice_user(&db, "traffic_limit_bytes = 100, traffic_used_bytes = 85").await;
    let (_, full_mail) =
        notice_user(&db, "traffic_limit_bytes = 100, traffic_used_bytes = 120").await;
    let (e, soon_mail) = notice_user(&db, "expires_at = now() + interval '2 days'").await;
    subscribe(&db, e, "active").await;
    let (late, late_mail) = notice_user(&db, "expires_at = now() + interval '5 days'").await;
    subscribe(&db, late, "active").await;
    let (gone, gone_mail) = notice_user(&db, "expires_at = now() - interval '1 hour'").await;
    subscribe(&db, gone, "expired").await;
    let (old, old_mail) = notice_user(&db, "expires_at = now() - interval '10 days'").await;
    subscribe(&db, old, "expired").await;
    // 低-1: a cancelled/refunded subscription gets no expiry mail (the
    // account keeps the old expiry as a record), nor does an account
    // without a subscription.
    let (cs, cancelled_soon) = notice_user(&db, "expires_at = now() + interval '2 days'").await;
    subscribe(&db, cs, "cancelled").await;
    let (cg, cancelled_gone) = notice_user(&db, "expires_at = now() - interval '1 hour'").await;
    subscribe(&db, cg, "cancelled").await;
    let (_, no_plan) = notice_user(&db, "expires_at = now() + interval '2 days'").await;
    // Not recipients: unverified, admin-disabled.
    let (u, unverified) =
        notice_user(&db, "traffic_limit_bytes = 100, traffic_used_bytes = 99").await;
    sqlx::query("UPDATE users SET email_verified_at = NULL WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    let (_, disabled) = notice_user(
        &db,
        "traffic_limit_bytes = 100, traffic_used_bytes = 99, enabled = false",
    )
    .await;

    assert_eq!(run_pass(&db, &s).await, 4);
    assert_eq!(kinds_to(&db, &q_mail).await, ["quota_80"]);
    assert_eq!(
        kinds_to(&db, &full_mail).await,
        ["quota_100"],
        "one mail past both"
    );
    assert_eq!(kinds_to(&db, &soon_mail).await, ["expiry_soon"]);
    assert_eq!(kinds_to(&db, &gone_mail).await, ["expired"]);
    // W20: reminders link to the shop view.
    let text: String =
        sqlx::query_scalar("SELECT body_text FROM mail_outbox WHERE kind = 'expiry_soon'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(text.contains("https://p.example/x/app/shop"), "{text}");
    for m in [
        &late_mail,
        &old_mail,
        &unverified,
        &disabled,
        &cancelled_soon,
        &cancelled_gone,
        &no_plan,
    ] {
        assert!(kinds_to(&db, m).await.is_empty(), "{m}");
    }
    assert_eq!(run_pass(&db, &s).await, 0, "idempotent");

    // 80% → 100%: one more; reset → re-armed for the next period.
    sqlx::query("UPDATE users SET traffic_used_bytes = 100 WHERE id = $1")
        .bind(q)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(run_pass(&db, &s).await, 1);
    sqlx::query("UPDATE users SET traffic_used_bytes = 0 WHERE id = $1")
        .bind(q)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(run_pass(&db, &s).await, 0);
    sqlx::query("UPDATE users SET traffic_used_bytes = 81 WHERE id = $1")
        .bind(q)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(run_pass(&db, &s).await, 1);
    assert_eq!(
        kinds_to(&db, &q_mail).await,
        ["quota_80", "quota_100", "quota_80"]
    );

    // Renewal (new expiry) re-arms the reminder.
    for sql in [
        "UPDATE users SET expires_at = expires_at + interval '1 day' WHERE id = $1",
        "UPDATE user_plans SET expires_at = expires_at + interval '1 day' WHERE user_id = $1",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(e)
            .execute(&db.pool)
            .await
            .unwrap();
    }
    assert_eq!(run_pass(&db, &s).await, 1);
    assert_eq!(
        kinds_to(&db, &soon_mail).await,
        ["expiry_soon", "expiry_soon"]
    );

    // Toggles off: nothing.
    let mut off = s.clone();
    off.notify_expiry_days = 0;
    off.notify_expired = false;
    off.notify_quota = false;
    sqlx::query("UPDATE users SET expires_at = expires_at + interval '1 hour' WHERE id = $1")
        .bind(e)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(run_pass(&db, &off).await, 0);

    // Concurrent passes (two instances): each notice exactly once.
    let mut users = Vec::new();
    for _ in 0..10 {
        users.push(
            notice_user(&db, "traffic_limit_bytes = 10, traffic_used_bytes = 9")
                .await
                .1,
        );
    }
    let mut tasks = Vec::new();
    for _ in 0..3 {
        let (pool, s) = (db.pool.clone(), s.clone());
        tasks.push(tokio::spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            let n = notices::pass(&mut tx, &s, None).await.unwrap();
            tx.commit().await.unwrap();
            n
        }));
    }
    let mut total = 0;
    for t in tasks {
        total += t.await.unwrap();
    }
    assert_eq!(total, 10);
    for m in &users {
        assert_eq!(kinds_to(&db, m).await, ["quota_80"]);
    }
    db.drop().await;
}

#[tokio::test]
async fn test_mail_endpoint_reports_failures() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = crate::state::AppState::for_test(db.pool.clone()).await;
    let admin = db.admin().await;
    let mut c = Client::new(&state, rand_ip());
    c.cookie = Some(crate::auth::issue_token(&state, admin, "admin", 0).unwrap());
    let r = c
        .post(
            "/test/api/v1/settings/mail/test",
            json!({ "to": "a@example.com" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "nothing saved yet");
    // A closed local port: a prompt, reported failure (never a hang).
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    sqlx::query(
        "UPDATE mail_settings SET host = '127.0.0.1', port = $1, security = 'none', \
         from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .bind(i32::from(port))
    .execute(&db.pool)
    .await
    .unwrap();
    let r = c
        .post(
            "/test/api/v1/settings/mail/test",
            json!({ "to": "a@example.com" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_GATEWAY, "{:?}", r.json());
    assert!(
        r.json()["error"]
            .as_str()
            .unwrap()
            .starts_with("send failed")
    );
    let r = c
        .post(
            "/test/api/v1/settings/mail/test",
            json!({ "to": "not an address" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'settings.mail.test'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(n, 1);
    db.drop().await;
}

/// W17: SMTP error text in the warning log never carries an address.
#[test]
fn smtp_errors_are_logged_without_addresses() {
    use super::sender::redact_addresses as r;
    assert_eq!(
        r("permanent error (550): 5.1.1 <Alice.B+x@Mail.Example.COM>: Recipient address rejected"),
        "permanent error (550): 5.1.1 <address>: Recipient address rejected"
    );
    assert_eq!(
        r("to bob@example.org, cc c@d.io."),
        "to <address>, cc <address>."
    );
    assert_eq!(
        r("no address @ here, user@localhost, a@b"),
        "no address @ here, user@localhost, a@b"
    );
    assert_eq!(r("用户 张三@例子.中国 不存在"), "用户 <address> 不存在");
    assert_eq!(r(""), "");
}

async fn admin_client(state: &crate::state::AppState, db: &TestDb) -> Client {
    let admin = db.admin().await;
    let mut c = Client::new(state, rand_ip());
    c.cookie = Some(crate::auth::issue_token(state, admin, "admin", 0).unwrap());
    c
}

fn put_body(version: i64, extra: serde_json::Value) -> serde_json::Value {
    let mut b = json!({
        "version": version, "enabled": false, "host": null, "port": 587,
        "security": "starttls", "username": null, "from_addr": "noreply@example.com",
        "from_name": null, "notify_order_paid": true, "notify_expiry_days": 3,
        "notify_expired": true, "notify_quota": true,
    });
    for (k, v) in extra.as_object().unwrap() {
        b[k] = v.clone();
    }
    b
}

/// W31: the provider and the Resend API key through the settings API.
#[tokio::test]
async fn resend_settings_seal_the_key_and_gate_enabling() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = crate::state::AppState::for_test(db.pool.clone()).await;
    let c = admin_client(&state, &db).await;
    let r = c.get("/test/api/v1/settings/mail").await;
    assert_eq!(r.json()["provider"], "smtp");
    assert_eq!(r.json()["providers"], json!(["smtp", "resend"]));
    let v = r.json()["version"].as_i64().unwrap();
    // Enabling Resend without a key: refused before anything is written.
    let r = c
        .put(
            "/test/api/v1/settings/mail",
            put_body(v, json!({ "enabled": true, "provider": "resend" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "mail.enable_needs_api_key");
    let r = c
        .put(
            "/test/api/v1/settings/mail",
            put_body(v, json!({ "provider": "mailgun" })),
        )
        .await;
    assert_eq!(r.json()["code"], "mail.provider_invalid");
    // With a key: enabled, sealed under RESEND_AAD, never echoed.
    let r = c
        .put(
            "/test/api/v1/settings/mail",
            put_body(
                v,
                json!({ "enabled": true, "provider": "resend", "api_key": "re_abc" }),
            ),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["api_key_set"], true);
    assert!(!String::from_utf8_lossy(&r.body).contains("re_abc"));
    let sealed: Vec<u8> = sqlx::query_scalar("SELECT api_key_enc FROM mail_settings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        state.master_key().open(RESEND_AAD, &sealed).as_deref(),
        Some(&b"re_abc"[..])
    );
    assert!(
        state.master_key().open(SMTP_AAD, &sealed).is_none(),
        "own AAD"
    );
    let s = load(&mut db.pool.acquire().await.unwrap()).await.unwrap();
    assert!(s.enabled && s.complete() && s.provider == "resend");
    // Absent provider/key = kept; audit says only "changed".
    let r = c
        .put(
            "/test/api/v1/settings/mail",
            put_body(s.version, json!({ "enabled": true, "from_name": "Shop" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["provider"], "resend");
    assert_eq!(r.json()["api_key_set"], true);
    let audits: Vec<String> = sqlx::query_scalar(
        "SELECT after::text FROM audit_log WHERE action = 'settings.mail.update' ORDER BY id",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(audits.len(), 2);
    assert!(audits[0].contains("\"api_key\": \"changed\"") && !audits[0].contains("re_abc"));
    assert!(audits[1].contains("\"api_key\": \"\""));
    // Removing the key of the enabled provider: refused (and the CHECK
    // backs it for any other writer).
    let r = c
        .put(
            "/test/api/v1/settings/mail",
            put_body(s.version + 1, json!({ "enabled": true, "api_key": null })),
        )
        .await;
    assert_eq!(r.json()["code"], "mail.enable_needs_api_key");
    let e = sqlx::query("UPDATE mail_settings SET api_key_enc = NULL")
        .execute(&db.pool)
        .await
        .unwrap_err();
    assert!(
        e.to_string().contains("mail_settings_enabled_complete"),
        "{e}"
    );
    let e = sqlx::query("UPDATE mail_settings SET provider = 'mailgun'")
        .execute(&db.pool)
        .await
        .unwrap_err();
    assert!(e.to_string().contains("mail_settings_provider"), "{e}");
    db.drop().await;
}

/// W31: the diagnose endpoint runs every step against a local relay and
/// reports a blocked port step by step; both are audited.
#[tokio::test]
async fn diagnose_endpoint_reports_steps() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = crate::state::AppState::for_test(db.pool.clone()).await;
    let c = admin_client(&state, &db).await;
    // A minimal plaintext relay (security none, no AUTH).
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let got = Arc::new(Mutex::new(0usize));
    let n = got.clone();
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        while let Ok((tcp, _)) = l.accept().await {
            let n = n.clone();
            tokio::spawn(async move {
                let mut io = BufReader::new(tcp);
                let _ = io.get_mut().write_all(b"220 relay\r\n").await;
                let mut data = false;
                loop {
                    let mut line = String::new();
                    if io.read_line(&mut line).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let l = line.trim_end();
                    let reply: &[u8] = if data {
                        if l != "." {
                            continue;
                        }
                        data = false;
                        *n.lock().unwrap() += 1;
                        b"250 queued\r\n"
                    } else if l.starts_with("EHLO") {
                        b"250-relay\r\n250 8BITMIME\r\n"
                    } else if l == "DATA" {
                        data = true;
                        b"354 go\r\n"
                    } else if l == "QUIT" {
                        let _ = io.get_mut().write_all(b"221 bye\r\n").await;
                        break;
                    } else {
                        b"250 ok\r\n"
                    };
                    let _ = io.get_mut().write_all(reply).await;
                }
            });
        }
    });
    sqlx::query(
        "UPDATE mail_settings SET host = '127.0.0.1', port = $1, security = 'none', \
         from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .bind(i32::from(port))
    .execute(&db.pool)
    .await
    .unwrap();
    let r = c
        .post(
            "/test/api/v1/settings/mail/diagnose",
            json!({ "to": "a@example.com" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let j = r.json();
    assert_eq!(j["ok"], true, "{j}");
    assert_eq!(j["provider"], "smtp");
    let names: Vec<&str> = j["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["step"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["config", "dns", "tcp", "tls", "greeting", "auth", "send"]
    );
    assert_eq!(j["steps"][0]["code"], "mail.diag.plaintext");
    assert!(
        j["steps"][6]["message"]["zh"]
            .as_str()
            .unwrap()
            .contains("a@example.com")
    );
    assert_eq!(*got.lock().unwrap(), 1);
    // A closed port: 200 with the failing step, never a hang.
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    sqlx::query("UPDATE mail_settings SET port = $1")
        .bind(i32::from(closed))
        .execute(&db.pool)
        .await
        .unwrap();
    let j = c
        .post(
            "/test/api/v1/settings/mail/diagnose",
            json!({ "to": "a@example.com" }),
        )
        .await
        .json();
    assert_eq!(j["ok"], false);
    assert_eq!(j["steps"][2]["code"], "mail.diag.tcp_refused");
    assert_eq!(j["steps"][6]["status"], "skip");
    let r = c
        .post(
            "/test/api/v1/settings/mail/diagnose",
            json!({ "to": "nope" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let outcomes: Vec<String> = sqlx::query_scalar(
        "SELECT after->>'outcome' FROM audit_log WHERE action = 'settings.mail.test' ORDER BY id",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(outcomes, ["sent", "mail.diag.tcp_refused"]);
    // Admins only.
    let user = db.user().await;
    let mut u = Client::new(&state, rand_ip());
    u.cookie = Some(crate::auth::issue_token(&state, user, "user", 0).unwrap());
    let r = u
        .post(
            "/test/api/v1/settings/mail/diagnose",
            json!({ "to": "a@example.com" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    db.drop().await;
}
