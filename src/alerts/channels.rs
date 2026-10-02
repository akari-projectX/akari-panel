//! Alert notification channels and the delivery queue.
//!
//! - `enqueue` (evaluator's transaction): one `alert_notifications` row
//!   per enabled channel; the payload is the message (no secrets).
//! - `deliver_due` (every instance, every round): claims due rows with
//!   `FOR UPDATE SKIP LOCKED` + a lease (`claimed_until`) and a claim token,
//!   sends outside any transaction (Telegram/webhook) and settles only if
//!   the claim is still ours. A crash between the remote acceptance and the
//!   settle redelivers after the lease: at-least-once (webhook receivers
//!   dedupe on `X-Akari-Delivery`). Transient failures back off
//!   exponentially; permanent refusals (4xx other than 408/429, missing or
//!   unreadable secrets, disabled channel) and `MAX_ATTEMPTS` make it dead
//!   (`/alerts/notifications`, retry by hand).
//! - **Telegram**: `POST {telegram_api_url}/bot<token>/sendMessage`
//!   (outbound only; no webhook, no polling). The URL holds the token: it is
//!   never logged, and errors carry no request content.
//! - **Webhook**: `POST <url>` with the JSON payload; headers
//!   `X-Akari-Event`, `X-Akari-Delivery` (notification id),
//!   `X-Akari-Timestamp` (unix seconds) and `X-Akari-Signature: sha256=<hex
//!   HMAC-SHA256(secret, "<timestamp>.<body>")>` (docs/DEPLOY.md shows how
//!   to verify; reject stale timestamps).
//! - **Email**: the W15 outbox through `mailhook::alert`.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use super::{Settings, TELEGRAM_AAD, WEBHOOK_AAD};
use crate::state::AppState;

pub const MAX_ATTEMPTS: i32 = 8;
const CLAIM_BATCH: i64 = 20;
const LEASE_SECS: i64 = 120;
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TELEGRAM_TEXT: usize = 4000;

/// A notification's content.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub payload: Value,
}

fn ts(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%d %H:%M:%S UTC").to_string()
}

impl Message {
    /// An alert firing or resolving.
    #[allow(clippy::too_many_arguments)]
    pub fn alert(
        event: &str,
        alert_id: i64,
        node_id: Uuid,
        node_name: &str,
        kind: &str,
        value: &str,
        detail: &str,
        fired_at: DateTime<Utc>,
        resolved_at: Option<DateTime<Utc>>,
    ) -> Self {
        let label = super::kind_label(kind);
        let (title, text) = if event == "resolved" {
            let title = format!("[恢复] {node_name}：{label}");
            let text = format!(
                "{title}\n节点：{node_name}\n告警：{value}\n开始：{}\n恢复：{}",
                ts(fired_at),
                resolved_at.map(ts).unwrap_or_default()
            );
            (title, text)
        } else {
            let title = format!("[告警] {node_name}：{label}");
            let text = format!(
                "{title}\n节点：{node_name}\n情况：{value}\n详情：{detail}\n时间：{}",
                ts(fired_at)
            );
            (title, text)
        };
        Self {
            payload: json!({
                "event": event,
                "title": title,
                "text": text,
                "alert": {
                    "id": alert_id,
                    "node_id": node_id,
                    "node_name": node_name,
                    "kind": kind,
                    "value": value,
                    "detail": detail,
                    "fired_at": fired_at,
                    "resolved_at": resolved_at,
                },
            }),
        }
    }

    /// The "发送测试" message.
    pub fn test(by: &str) -> Self {
        let title = "[测试] Akari 告警通知".to_string();
        Self {
            payload: json!({
                "event": "test",
                "title": title,
                "text": format!("{title}\n这是一条测试消息（由 {by} 发送），收到即表示通道配置正确。"),
                "alert": null,
            }),
        }
    }

    pub fn event(&self) -> &str {
        self.payload["event"].as_str().unwrap_or("firing")
    }
    pub fn title(&self) -> &str {
        self.payload["title"].as_str().unwrap_or("")
    }
    pub fn text(&self) -> &str {
        self.payload["text"].as_str().unwrap_or("")
    }
}

/// Queue `msg` for every channel (caller's transaction). Returns how many
/// rows were queued.
pub async fn enqueue(
    conn: &mut PgConnection,
    channels: &[&str],
    msg: &Message,
) -> sqlx::Result<usize> {
    let alert_id = msg.payload["alert"]["id"].as_i64();
    for c in channels {
        sqlx::query(
            "INSERT INTO alert_notifications (alert_id, channel, event, payload) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(alert_id)
        .bind(*c)
        .bind(msg.event())
        .bind(&msg.payload)
        .execute(&mut *conn)
        .await?;
    }
    Ok(channels.len())
}

/// Why a send failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// Worth retrying later (network, timeouts, 5xx, 408, 429).
    Retry(String),
    /// Retrying cannot help (bad token/chat, 4xx, channel off, no secret).
    Permanent(String),
}

impl SendError {
    pub fn text(&self) -> &str {
        match self {
            SendError::Retry(s) | SendError::Permanent(s) => s,
        }
    }
}

fn by_status(what: &str, status: u16, detail: &str) -> SendError {
    let d = detail
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect::<String>();
    let msg = if d.is_empty() {
        format!("{what}: HTTP {status}")
    } else {
        format!("{what}: HTTP {status} {d}")
    };
    if status == 408 || status == 429 || status >= 500 {
        SendError::Retry(msg)
    } else {
        SendError::Permanent(msg)
    }
}

/// `sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`.
pub fn signature(secret: &[u8], timestamp: i64, body: &[u8]) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret);
    let mut ctx = ring::hmac::Context::with_key(&key);
    ctx.update(timestamp.to_string().as_bytes());
    ctx.update(b".");
    ctx.update(body);
    format!("sha256={}", hex::encode(ctx.sign().as_ref()))
}

/// Verify a webhook signature (what a receiver does; tests and docs).
pub fn verify_signature(secret: &[u8], timestamp: i64, body: &[u8], header: &str) -> bool {
    let Some(hex_sig) = header.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(sig) = hex::decode(hex_sig) else {
        return false;
    };
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret);
    let mut msg = timestamp.to_string().into_bytes();
    msg.push(b'.');
    msg.extend_from_slice(body);
    ring::hmac::verify(&key, &msg, &sig).is_ok()
}

fn open(
    state: &AppState,
    aad: Uuid,
    blob: Option<&Vec<u8>>,
    what: &str,
) -> Result<String, SendError> {
    let blob = blob.ok_or_else(|| SendError::Permanent(format!("{what} is not configured")))?;
    state
        .totp()
        .open(aad, blob)
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or_else(|| {
            SendError::Permanent(format!(
                "{what} cannot be decrypted (data/totp.key changed?): enter it again"
            ))
        })
}

/// Send one message through one channel with the given settings. `conn`
/// is needed by the email channel only (the outbox row joins the caller's
/// transaction).
pub async fn send(
    state: &AppState,
    conn: Option<&mut PgConnection>,
    s: &Settings,
    channel: &str,
    msg: &Message,
    delivery: i64,
) -> Result<(), SendError> {
    match channel {
        "telegram" => {
            if !s.telegram_enabled && msg.event() != "test" {
                return Err(SendError::Permanent("telegram is disabled".into()));
            }
            let token = open(
                state,
                TELEGRAM_AAD,
                s.telegram_token_enc.as_ref(),
                "the bot token",
            )?;
            let chat = s
                .telegram_chat_id
                .as_deref()
                .ok_or_else(|| SendError::Permanent("no telegram chat id".into()))?;
            let base = state.cfg().alerts.telegram_api_url.trim_end_matches('/');
            let url = format!("{base}/bot{token}/sendMessage");
            let text: String = msg.text().chars().take(MAX_TELEGRAM_TEXT).collect();
            let body = json!({ "chat_id": chat, "text": text, "disable_web_page_preview": true });
            let (status, resp) = crate::billing::http::post(
                &url,
                "application/json",
                &[],
                body.to_string().into_bytes(),
                SEND_TIMEOUT,
            )
            .await
            .map_err(|e| SendError::Retry(format!("telegram: {e}")))?;
            let v: Value = serde_json::from_slice(&resp).unwrap_or(Value::Null);
            if (200..300).contains(&status) && v["ok"] == Value::Bool(true) {
                Ok(())
            } else {
                Err(by_status(
                    "telegram",
                    status,
                    v["description"].as_str().unwrap_or(""),
                ))
            }
        }
        "webhook" => {
            if !s.webhook_enabled && msg.event() != "test" {
                return Err(SendError::Permanent("the webhook is disabled".into()));
            }
            let secret = open(
                state,
                WEBHOOK_AAD,
                s.webhook_secret_enc.as_ref(),
                "the webhook secret",
            )?;
            let url = s
                .webhook_url
                .as_deref()
                .ok_or_else(|| SendError::Permanent("no webhook URL".into()))?;
            let body = serde_json::to_vec(&msg.payload)
                .map_err(|_| SendError::Permanent("payload".into()))?;
            let now = Utc::now().timestamp();
            let headers = [
                ("x-akari-event", msg.event().to_string()),
                ("x-akari-delivery", delivery.to_string()),
                ("x-akari-timestamp", now.to_string()),
                (
                    "x-akari-signature",
                    signature(secret.as_bytes(), now, &body),
                ),
            ];
            let (status, resp) =
                crate::billing::http::post(url, "application/json", &headers, body, SEND_TIMEOUT)
                    .await
                    .map_err(|e| SendError::Retry(format!("webhook: {e}")))?;
            if (200..300).contains(&status) {
                Ok(())
            } else {
                Err(by_status(
                    "webhook",
                    status,
                    &String::from_utf8_lossy(&resp[..resp.len().min(200)]),
                ))
            }
        }
        "email" => {
            if !s.email_enabled && msg.event() != "test" {
                return Err(SendError::Permanent("email is disabled".into()));
            }
            if s.email_to.is_empty() {
                return Err(SendError::Permanent("no email recipients".into()));
            }
            let conn =
                conn.ok_or_else(|| SendError::Retry("email: no database connection".into()))?;
            crate::mailhook::alert(conn, &s.email_to, msg.title(), msg.text())
                .await
                .map_err(SendError::Permanent)
        }
        other => Err(SendError::Permanent(format!("unknown channel {other}"))),
    }
}

/// Delay before attempt `n + 1` (n >= 1 attempts made): 30 s doubling,
/// capped at 1 h.
pub fn backoff_secs(attempts: i32) -> i64 {
    let n = attempts.clamp(1, 12) - 1;
    (30i64 << n).min(3600)
}

#[derive(sqlx::FromRow)]
struct Claimed {
    id: i64,
    channel: String,
    payload: Value,
    attempts: i32,
}

/// Deliver due notifications (any instance). Returns how many were
/// settled as sent.
pub async fn deliver_due(state: &AppState) -> anyhow::Result<usize> {
    let pg = state.pg();
    let claim = Uuid::new_v4();
    let due: Vec<Claimed> = sqlx::query_as(
        "UPDATE alert_notifications SET claimed_until = now() + make_interval(secs => $2), \
           claim = $1, attempts = attempts + 1 \
         WHERE id IN (SELECT id FROM alert_notifications WHERE status = 'pending' \
             AND next_attempt_at <= now() AND (claimed_until IS NULL OR claimed_until < now()) \
             ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED) \
         RETURNING id, channel, payload, attempts",
    )
    .bind(claim)
    .bind(LEASE_SECS as f64)
    .bind(CLAIM_BATCH)
    .fetch_all(pg)
    .await?;
    if due.is_empty() {
        return Ok(0);
    }
    let s = {
        let mut c = pg.acquire().await?;
        super::load(&mut c).await?
    };
    let mut sent = 0;
    for n in due {
        let msg = Message { payload: n.payload };
        // Telegram/webhook: no transaction is held open across the network
        // call. Email: the outbox row joins the settling transaction.
        let (mut tx, res) = if n.channel == "email" {
            let mut tx = pg.begin().await?;
            let res = send(state, Some(&mut tx), &s, &n.channel, &msg, n.id).await;
            (tx, res)
        } else {
            let res = send(state, None, &s, &n.channel, &msg, n.id).await;
            (pg.begin().await?, res)
        };
        let (status, err, retry) = match &res {
            Ok(()) => ("sent", None, false),
            Err(SendError::Retry(e)) if n.attempts < MAX_ATTEMPTS => {
                ("pending", Some(e.as_str()), true)
            }
            Err(e) => ("dead", Some(e.text()), false),
        };
        let err: Option<String> = err.map(|e| e.chars().take(300).collect());
        sqlx::query(
            "UPDATE alert_notifications SET status = $3, last_error = $4, \
               sent_at = CASE WHEN $3 = 'sent' THEN now() END, \
               next_attempt_at = CASE WHEN $5 THEN now() + make_interval(secs => $6) \
                 ELSE next_attempt_at END, \
               claimed_until = NULL, claim = NULL \
             WHERE id = $1 AND claim = $2",
        )
        .bind(n.id)
        .bind(claim)
        .bind(status)
        .bind(&err)
        .bind(retry)
        .bind(backoff_secs(n.attempts) as f64)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        let result = match status {
            "sent" => {
                sent += 1;
                "sent"
            }
            "pending" => "retry",
            _ => "dead",
        };
        crate::metrics::alert_notification(&n.channel, result);
        if let Some(e) = &err {
            tracing::warn!(id = n.id, channel = %n.channel, result, error = %e, "alert notification failed");
        }
    }
    Ok(sent)
}
