//! W17 ticket and alert email through the W15 outbox.
//!
//! Nothing here talks to SMTP: each mail is rendered and INSERTed into
//! `mail_outbox` (`mail::enqueue`) inside the caller's transaction, so a
//! rolled-back mutation sends nothing and a committed one is delivered by
//! `mail::sender` on any instance. Mail goes only to VERIFIED addresses
//! (`users.email_verified_at`, the W15 rule), in the recipient's locale
//! (console mail is Chinese). Callers never depend on the result: the in-app
//! markers (unread ticket, alert center) are the primary channel.

use sqlx::{Connection, PgConnection};
use uuid::Uuid;

use crate::alerts::channels::SendError;
use crate::mail::templates::SecurityEvent;
use crate::mail::{self, Locale, Template};
use crate::state::AppState;

/// At most this many admins are mailed about one new ticket.
const MAX_STAFF_RECIPIENTS: i64 = 5;

/// Links put into mail (the portal `<public origin>`, the console
/// `<public origin>/<admin prefix>/admin` — staff mail only), when a main
/// domain is configured (never derived from a request's Host).
#[derive(Debug, Clone, Default)]
pub struct Links {
    pub portal: Option<String>,
    pub console: Option<String>,
}

impl Links {
    pub fn of(state: &AppState) -> Self {
        let portal = mail::portal_url(state);
        let prefix = state.settings().access().admin_prefix.clone();
        let console = portal.as_deref().map(|o| format!("{o}/{prefix}/admin"));
        Self { portal, console }
    }
}

/// The SMTP settings when mail can be sent (enabled and complete).
async fn smtp(conn: &mut PgConnection) -> sqlx::Result<Option<mail::MailSettings>> {
    let s = mail::load(conn).await?;
    Ok((s.enabled && s.complete()).then_some(s))
}

/// Whether email can be sent at all (SMTP configured and enabled).
pub async fn available(conn: &mut PgConnection) -> sqlx::Result<bool> {
    Ok(smtp(conn).await?.is_some())
}

/// Staff replied to a ticket: tell its owner (verified address, their
/// locale). Returns whether a mail was queued.
pub async fn ticket_replied(
    conn: &mut PgConnection,
    ticket: Uuid,
    links: Option<&Links>,
) -> sqlx::Result<bool> {
    let Some(s) = smtp(conn).await? else {
        return Ok(false);
    };
    let row: Option<(Uuid, String, String, String)> = sqlx::query_as(
        "SELECT u.id, u.email, u.locale, t.subject FROM tickets t JOIN users u ON u.id = t.user_id \
         WHERE t.id = $1 AND u.email IS NOT NULL AND u.email_verified_at IS NOT NULL",
    )
    .bind(ticket)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((user, email, locale, subject)) = row else {
        return Ok(false);
    };
    let tpl = Template::TicketReply {
        subject,
        portal_url: links.and_then(|l| l.portal.clone()),
    };
    mail::enqueue(
        conn,
        &s,
        &tpl,
        Locale::parse(&locale),
        &email,
        Some(user),
        None,
    )
    .await?;
    Ok(true)
}

/// A customer opened a ticket: tell up to 5 enabled admins with a verified
/// address (Chinese). Returns how many mails were queued.
pub async fn ticket_created(
    conn: &mut PgConnection,
    ticket: Uuid,
    links: Option<&Links>,
) -> sqlx::Result<usize> {
    let Some(s) = smtp(conn).await? else {
        return Ok(0);
    };
    let t: Option<(String, String, String)> = sqlx::query_as(
        "SELECT t.subject, u.email, t.category FROM tickets t JOIN users u ON u.id = t.user_id \
         WHERE t.id = $1",
    )
    .bind(ticket)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((subject, user_email, category)) = t else {
        return Ok(0);
    };
    let staff: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, email FROM users WHERE role = 'admin' AND enabled \
         AND email_verified_at IS NOT NULL ORDER BY created_at, id LIMIT $1",
    )
    .bind(MAX_STAFF_RECIPIENTS)
    .fetch_all(&mut *conn)
    .await?;
    let tpl = Template::TicketNew {
        subject,
        user_email,
        category,
        console_url: links
            .and_then(|l| l.console.clone())
            .map(|c| format!("{c}/tickets/{ticket}")),
    };
    for (id, email) in &staff {
        mail::enqueue(conn, &s, &tpl, Locale::Zh, email, Some(*id), None).await?;
    }
    Ok(staff.len())
}

/// An alert notification for the email channel (`alerts::channels::send`):
/// one outbox row per recipient, in the caller's transaction. Err = the
/// channel cannot deliver (SMTP off: a permanent failure of this
/// notification; a database error is retried).
pub async fn alert(
    conn: &mut PgConnection,
    to: &[String],
    title: &str,
    text: &str,
) -> Result<(), SendError> {
    let s = smtp(conn)
        .await
        .map_err(|_| SendError::Retry("email: database unavailable".into()))?
        .ok_or_else(|| SendError::Permanent("email is not configured (系统设置 → 邮件)".into()))?;
    let tpl = Template::NodeAlert {
        title: title.to_string(),
        text: text.to_string(),
    };
    for addr in to {
        mail::enqueue(conn, &s, &tpl, Locale::Zh, addr, None, None)
            .await
            .map_err(|_| SendError::Retry("email: could not queue the message".into()))?;
    }
    Ok(())
}

/// Audit batch 2, P2-1: tell an account that its sign-in security changed
/// (passkey added / removed, password sign-in switched, email or password
/// changed). Goes to the account's VERIFIED address — or, for an email
/// change, to `old_address` (the verified address it had before) — in the
/// account's locale, with the time and the client address `ip` (None for an
/// administrator's action). Never a secret. Queued in the caller's
/// transaction under a savepoint: a failure is logged and rolled back alone,
/// the change itself always commits. Returns whether a mail was queued.
pub async fn security_notice(
    conn: &mut PgConnection,
    user: Uuid,
    event: SecurityEvent,
    ip: Option<std::net::IpAddr>,
    portal: Option<&str>,
    old_address: Option<&str>,
) -> bool {
    let mut sp = match conn.begin().await {
        Ok(sp) => sp,
        Err(e) => {
            tracing::warn!(error = %e, "security notice not queued");
            return false;
        }
    };
    match queue_security_notice(&mut sp, user, event, ip, portal, old_address).await {
        Ok(queued) => sp.commit().await.is_ok() && queued,
        Err(e) => {
            tracing::warn!(error = %e, "security notice not queued");
            let _ = sp.rollback().await;
            false
        }
    }
}

async fn queue_security_notice(
    conn: &mut PgConnection,
    user: Uuid,
    event: SecurityEvent,
    ip: Option<std::net::IpAddr>,
    portal: Option<&str>,
    old_address: Option<&str>,
) -> sqlx::Result<bool> {
    let Some(s) = smtp(conn).await? else {
        return Ok(false);
    };
    // The current address, only when verified (and not a passkey
    // registration's placeholder).
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT email, locale FROM users WHERE id = $1 AND email_verified_at IS NOT NULL \
         AND NOT email_pending",
    )
    .bind(user)
    .fetch_optional(&mut *conn)
    .await?;
    let (to, locale) = match (old_address, row) {
        (Some(old), _) => {
            let locale: Option<String> =
                sqlx::query_scalar("SELECT locale FROM users WHERE id = $1")
                    .bind(user)
                    .fetch_optional(&mut *conn)
                    .await?;
            (old.to_string(), locale.unwrap_or_default())
        }
        (None, Some((email, locale))) => (email, locale),
        (None, None) => return Ok(false),
    };
    let tpl = Template::SecurityNotice {
        event,
        at: chrono::Utc::now(),
        ip: ip.map(|a| a.to_string()),
        portal_url: portal.map(str::to_string),
    };
    mail::enqueue(
        conn,
        &s,
        &tpl,
        Locale::parse(&locale),
        &to,
        Some(user),
        None,
    )
    .await?;
    Ok(true)
}
