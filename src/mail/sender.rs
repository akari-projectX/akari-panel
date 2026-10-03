//! The outbox sender (W15): runs on every panel instance (`run`, started
//! from main). Each tick, while SMTP is enabled, it claims due rows ONE at a
//! time (`claim`: `FOR UPDATE SKIP LOCKED` picks a row no other instance is
//! claiming, the UPDATE sets a lease `claimed_until` and a fresh
//! `claim_token`), sends it, and settles it with an UPDATE conditioned on
//! that token (`settle`): a sender whose lease ran out can never overwrite
//! the outcome of the instance that re-claimed the row. The lease
//! (`LEASE_SECS`) is longer than the whole send may take (`SEND_TIMEOUT`),
//! so a row is sent by at most one instance unless a sender dies between
//! the server's acceptance and the settle UPDATE (then it is re-sent after
//! the lease: at-least-once across crashes, never concurrently).
//!
//! Failures: permanent (5xx, bad address) or the last attempt → `dead`
//! (dead letter, visible to the admin); otherwise retried after
//! `backoff(attempts)`. Rows past `discard_after` (codes, reset links) are
//! never sent late: `maintain` turns them into dead letters ("expired").
//! Settling clears the body of every sent row and of dead rows that carry
//! a secret. Nothing here logs a body, an address or a code.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use lettre::message::{header::ContentType, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use sqlx::PgPool;
use uuid::Uuid;

use super::Smtp;
use crate::state::AppState;

/// One message, rendered.
#[derive(Debug, Clone)]
pub struct OutMsg {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
}

#[derive(Debug, Clone)]
pub struct SendError {
    /// Retrying cannot help (5xx reply, unusable address).
    pub permanent: bool,
    pub message: String,
}

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<(), SendError>> + Send + 'a>>;

/// Something that delivers a message (SMTP in production; tests count).
pub trait Transport: Send + Sync {
    fn send<'a>(&'a self, msg: &'a OutMsg) -> SendFuture<'a>;
}

/// Lease of a claimed row; must exceed `SEND_TIMEOUT` with margin.
pub const LEASE_SECS: i64 = 180;
/// Upper bound of one delivery (connect, TLS, AUTH, DATA).
pub const SEND_TIMEOUT: Duration = Duration::from_secs(60);
/// Per-command SMTP timeout.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
/// Attempts before a transient failure becomes a dead letter (~2 h).
pub const MAX_ATTEMPTS: i32 = 8;
/// Messages per tick per instance (then the loop yields a tick).
const PER_TICK: usize = 50;
const TICK: Duration = Duration::from_secs(2);
/// Periodic notices (expiry, quota) cadence.
const NOTICES_EVERY: Duration = Duration::from_secs(60);
/// Expiry/retention housekeeping cadence.
const MAINTAIN_EVERY: Duration = Duration::from_secs(600);
/// Kinds whose body holds a secret (cleared on any settle).
pub const SECRET_KINDS: &str = "('register_code', 'email_code', 'password_reset')";

/// Seconds before retry number `attempts` (1-based count of attempts made):
/// 30 s doubling, capped at 1 h.
pub fn backoff(attempts: i32) -> i64 {
    let n = attempts.clamp(1, 16) - 1;
    (30_i64 << n).min(3600)
}

struct Lettre {
    inner: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    domain: String,
}

impl Transport for Lettre {
    fn send<'a>(&'a self, msg: &'a OutMsg) -> SendFuture<'a> {
        Box::pin(async move {
            let to: Mailbox = msg.to.parse().map_err(|_| SendError {
                permanent: true,
                message: "invalid recipient address".into(),
            })?;
            let m = Message::builder()
                .from(self.from.clone())
                .to(to)
                .subject(msg.subject.clone())
                .message_id(Some(format!(
                    "<{}@{}>",
                    Uuid::new_v4().simple(),
                    self.domain
                )))
                .multipart(
                    MultiPart::alternative()
                        .singlepart(
                            SinglePart::builder()
                                .header(ContentType::TEXT_PLAIN)
                                .body(msg.text.clone()),
                        )
                        .singlepart(
                            SinglePart::builder()
                                .header(ContentType::TEXT_HTML)
                                .body(msg.html.clone()),
                        ),
                )
                .map_err(|e| SendError {
                    permanent: true,
                    message: format!("message: {e}"),
                })?;
            match self.inner.send(m).await {
                Ok(_) => Ok(()),
                Err(e) => Err(SendError {
                    permanent: e.is_permanent(),
                    message: e.to_string().chars().take(300).collect(),
                }),
            }
        })
    }
}

/// The SMTP transport for the saved settings. Errors are admin-facing text
/// (no secrets).
pub fn smtp_transport(smtp: &Smtp, keys: &crate::totp::Keys) -> Result<Box<dyn Transport>, String> {
    let host = smtp.host.as_deref().ok_or("no SMTP host")?;
    let from_addr = smtp.from_addr.as_deref().ok_or("no sender address")?;
    let port = u16::try_from(smtp.port).map_err(|_| "invalid port")?;
    let builder = match smtp.security.as_str() {
        "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(host)
            .map_err(|e| format!("TLS setup: {e}"))?,
        "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
            .map_err(|e| format!("TLS setup: {e}"))?,
        _ => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host),
    };
    let mut builder = builder.port(port).timeout(Some(COMMAND_TIMEOUT));
    if let Some(user) = &smtp.username {
        let password = match &smtp.password_enc {
            Some(blob) => {
                let pt = keys.open(super::SMTP_AAD, blob).ok_or(
                    "the stored SMTP password cannot be decrypted (data/totp.key changed?); enter it again",
                )?;
                String::from_utf8(pt).map_err(|_| "stored SMTP password is not UTF-8")?
            }
            None => String::new(),
        };
        builder = builder.credentials(Credentials::new(user.clone(), password));
    }
    let from = Mailbox::new(
        Some(smtp.sender_name().to_string()),
        from_addr
            .parse()
            .map_err(|_| "the sender address is invalid")?,
    );
    Ok(Box::new(Lettre {
        inner: builder.build(),
        from,
        domain: crate::signup::email::domain_of(from_addr).to_string(),
    }))
}

#[derive(sqlx::FromRow)]
struct Claimed {
    id: i64,
    kind: String,
    to_addr: String,
    subject: String,
    body_text: String,
    body_html: String,
    attempts: i32,
}

async fn claim(pg: &PgPool, token: Uuid) -> sqlx::Result<Option<Claimed>> {
    sqlx::query_as(
        "UPDATE mail_outbox SET claimed_until = now() + make_interval(secs => $2), \
         claim_token = $1, attempts = attempts + 1 \
         WHERE id = (SELECT id FROM mail_outbox WHERE status = 'pending' \
           AND next_attempt_at <= now() \
           AND (claimed_until IS NULL OR claimed_until < now()) \
           AND (discard_after IS NULL OR discard_after > now()) \
           ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) \
         RETURNING id, kind, to_addr, subject, body_text, body_html, attempts",
    )
    .bind(token)
    .bind(LEASE_SECS as f64)
    .fetch_optional(pg)
    .await
}

/// Record the outcome of a claimed row (only while we still hold it).
async fn settle(
    pg: &PgPool,
    row: &Claimed,
    token: Uuid,
    res: &Result<(), SendError>,
) -> sqlx::Result<()> {
    match res {
        Ok(()) => {
            sqlx::query(
                "UPDATE mail_outbox SET status = 'sent', settled_at = now(), body_text = '', \
                 body_html = '', claimed_until = NULL, claim_token = NULL, last_error = NULL \
                 WHERE id = $1 AND claim_token = $2 AND status = 'pending'",
            )
            .bind(row.id)
            .bind(token)
            .execute(pg)
            .await?;
        }
        Err(e) if e.permanent || row.attempts >= MAX_ATTEMPTS => {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE mail_outbox SET status = 'dead', settled_at = now(), last_error = $3, \
                 claimed_until = NULL, claim_token = NULL, \
                 body_text = CASE WHEN kind IN {SECRET_KINDS} THEN '' ELSE body_text END, \
                 body_html = CASE WHEN kind IN {SECRET_KINDS} THEN '' ELSE body_html END \
                 WHERE id = $1 AND claim_token = $2 AND status = 'pending'"
            )))
            .bind(row.id)
            .bind(token)
            .bind(&e.message)
            .execute(pg)
            .await?;
        }
        Err(e) => {
            sqlx::query(
                "UPDATE mail_outbox SET next_attempt_at = now() + make_interval(secs => $3), \
                 last_error = $4, claimed_until = NULL, claim_token = NULL \
                 WHERE id = $1 AND claim_token = $2 AND status = 'pending'",
            )
            .bind(row.id)
            .bind(token)
            .bind(backoff(row.attempts) as f64)
            .bind(&e.message)
            .execute(pg)
            .await?;
        }
    }
    Ok(())
}

/// `s` with every email-address-like token (`local@domain.tld`, with or
/// without angle brackets) replaced by `<address>`.
pub fn redact_addresses(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let local = |c: char| c.is_alphanumeric() || "._%+-'!#$&*/=?^`{|}~".contains(c);
    let domain = |c: char| c.is_alphanumeric() || c == '.' || c == '-';
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' {
            let mut start = out.chars().count();
            let prefix: Vec<char> = out.chars().collect();
            while start > 0 && local(prefix[start - 1]) {
                start -= 1;
            }
            let mut end = i + 1;
            while end < chars.len() && domain(chars[end]) {
                end += 1;
            }
            while end > i + 1 && matches!(chars[end - 1], '.' | '-') {
                end -= 1;
            }
            let dom: String = chars[i + 1..end].iter().collect();
            if start < prefix.len() && dom.trim_matches('.').contains('.') {
                out = prefix[..start].iter().collect();
                out.push_str("<address>");
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out.replace("<<address>>", "<address>")
}

/// Deliver up to `max` due messages through `t`. Returns how many were
/// claimed (sent or not).
pub async fn deliver_due(pg: &PgPool, t: &dyn Transport, max: usize) -> sqlx::Result<usize> {
    let mut n = 0;
    while n < max {
        let token = Uuid::new_v4();
        let Some(row) = claim(pg, token).await? else {
            break;
        };
        n += 1;
        let msg = OutMsg {
            to: row.to_addr.clone(),
            subject: row.subject.clone(),
            text: row.body_text.clone(),
            html: row.body_html.clone(),
        };
        let res = match tokio::time::timeout(SEND_TIMEOUT, t.send(&msg)).await {
            Ok(r) => r,
            Err(_) => Err(SendError {
                permanent: false,
                message: "timed out".into(),
            }),
        };
        match &res {
            Ok(()) => tracing::debug!(id = row.id, kind = %row.kind, "mail sent"),
            // SMTP replies often quote the recipient ("550 <x@y>: no such
            // user"): addresses never go to the log (the outbox row keeps
            // the reply for the admin).
            Err(e) => tracing::warn!(id = row.id, kind = %row.kind, attempt = row.attempts,
                permanent = e.permanent, error = %redact_addresses(&e.message),
                "mail delivery failed"),
        }
        crate::metrics::mail_sent(&row.kind, res.is_ok());
        settle(pg, &row, token, &res).await?;
    }
    Ok(n)
}

/// Housekeeping (any instance, idempotent): expire undeliverable secrets,
/// drop old settled rows (sent after 30 days, dead after 90).
pub async fn maintain(pg: &PgPool) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE mail_outbox SET status = 'dead', settled_at = now(), \
         last_error = 'expired before delivery', body_text = '', body_html = '', \
         claimed_until = NULL, claim_token = NULL \
         WHERE status = 'pending' AND discard_after <= now() \
         AND (claimed_until IS NULL OR claimed_until < now())",
    )
    .execute(pg)
    .await?;
    sqlx::query(
        "DELETE FROM mail_outbox WHERE id IN (SELECT id FROM mail_outbox \
         WHERE (status = 'sent' AND settled_at < now() - interval '30 days') \
            OR (status = 'dead' AND settled_at < now() - interval '90 days') LIMIT 10000)",
    )
    .execute(pg)
    .await?;
    crate::signup::prune(pg).await?;
    Ok(())
}

/// The sender loop (every instance). Never returns.
pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_notices = tokio::time::Instant::now();
    let mut last_maintain: Option<tokio::time::Instant> = None;
    let mut last_announce: Option<tokio::time::Instant> = None;
    loop {
        tick.tick().await;
        if last_maintain.is_none_or(|t| t.elapsed() >= MAINTAIN_EVERY) {
            last_maintain = Some(tokio::time::Instant::now());
            if let Err(e) = maintain(state.pg()).await {
                tracing::warn!(error = %e, "mail outbox maintenance failed");
            }
        }
        let smtp = match state.pg().acquire().await {
            Ok(mut c) => match super::load(&mut c).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(error = %e, "mail settings unavailable");
                    continue;
                }
            },
            Err(e) => {
                tracing::warn!(error = %e, "mail sender: no database connection");
                continue;
            }
        };
        if !smtp.enabled {
            continue;
        }
        if last_notices.elapsed() >= NOTICES_EVERY {
            last_notices = tokio::time::Instant::now();
            if let Err(e) = super::notices::run(&state, &smtp).await {
                tracing::warn!(error = %e, "mail notices pass failed");
            }
        }
        // Ops: one batch of a requested announcement mailing (rate-limited
        // by MAIL_EVERY × MAIL_BATCH; any instance, row claimed).
        if last_announce.is_none_or(|t| t.elapsed() >= crate::announcements::MAIL_EVERY) {
            last_announce = Some(tokio::time::Instant::now());
            match crate::announcements::mail_pass(&state, &smtp).await {
                Ok(n) if n > 0 => tracing::info!(queued = n, "announcement mail batch queued"),
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "announcement mail pass failed"),
            }
        }
        let transport = match smtp_transport(&smtp, state.totp()) {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(error = %e, "mail sender: SMTP settings unusable");
                continue;
            }
        };
        if let Err(e) = deliver_due(state.pg(), transport.as_ref(), PER_TICK).await {
            tracing::warn!(error = %e, "mail sender tick failed");
        }
    }
}
