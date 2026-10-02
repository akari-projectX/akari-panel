//! W17 → W15 email hook.
//!
//! **W15 HOOK.** Ticket and alert emails go through the W15 SMTP outbox
//! (`mail::enqueue`: rendered and INSERTed into `mail_outbox` inside the
//! caller's transaction, delivered by any instance). W15 is not merged on
//! this branch, so every function here is a no-op that reports "not sent";
//! when W15 lands, each one renders its template and calls `mail::enqueue`
//! in the given transaction (the signatures already take it), and
//! `available()` returns whether SMTP is enabled. Callers never depend on
//! the result for correctness: the in-app markers (unread ticket, alert
//! center) are the primary channel.

use sqlx::PgConnection;
use uuid::Uuid;

/// Whether email can be sent at all (W15: SMTP configured and enabled).
pub async fn available(_conn: &mut PgConnection) -> sqlx::Result<bool> {
    Ok(false)
}

/// Staff replied to a ticket: tell the ticket's owner (their locale).
pub async fn ticket_replied(_conn: &mut PgConnection, _ticket: Uuid) -> sqlx::Result<bool> {
    Ok(false)
}

/// A user opened a ticket: tell the assigned admin, else every admin with
/// an email address.
pub async fn ticket_created(_conn: &mut PgConnection, _ticket: Uuid) -> sqlx::Result<bool> {
    Ok(false)
}

/// An alert notification for the email channel (`alerts::deliver`): one
/// outbox row per recipient. Err = the channel cannot deliver (the
/// notification is retried, then dead-lettered).
pub async fn alert(
    _conn: &mut PgConnection,
    _to: &[String],
    _subject: &str,
    _text: &str,
) -> Result<(), String> {
    Err("email delivery is not available yet (SMTP outbox, W15)".into())
}
