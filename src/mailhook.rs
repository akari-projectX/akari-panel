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
use crate::mail::templates::{PlanAction, SecurityEvent};
use crate::mail::{self, Locale, MailSettings, Template};
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

/// Queue a mail in a savepoint of the caller's transaction: `queue` runs
/// inside it; an error is logged (`what` names the mail, never an address)
/// and rolled back alone, so a mail problem can never fail the change it
/// reports. Returns whether a mail was queued.
async fn in_savepoint(
    conn: &mut PgConnection,
    what: &str,
    queue: impl AsyncFnOnce(&mut PgConnection) -> sqlx::Result<bool>,
) -> bool {
    let mut sp = match conn.begin().await {
        Ok(sp) => sp,
        Err(e) => {
            tracing::warn!(error = %e, "{what} not queued");
            return false;
        }
    };
    match queue(&mut sp).await {
        Ok(queued) => match sp.commit().await {
            Ok(()) => queued,
            Err(e) => {
                tracing::warn!(error = %e, "{what} not queued");
                false
            }
        },
        Err(e) => {
            tracing::warn!(error = %e, "{what} not queued");
            if let Err(e) = sp.rollback().await {
                tracing::warn!(error = %e, "{what}: savepoint rollback failed");
            }
            false
        }
    }
}

/// The account's address and locale, only when the address is verified
/// (and not a passkey registration's placeholder).
async fn verified_recipient(
    conn: &mut PgConnection,
    user: Uuid,
) -> sqlx::Result<Option<(String, String)>> {
    sqlx::query_as(
        "SELECT email, locale FROM users WHERE id = $1 AND email_verified_at IS NOT NULL \
         AND NOT email_pending",
    )
    .bind(user)
    .fetch_optional(&mut *conn)
    .await
}

/// Queue `tpl` for the account when mail is on, `wanted` (the settings
/// toggle of the kind) is set and the account has a verified address.
async fn notify_account(
    conn: &mut PgConnection,
    user: Uuid,
    wanted: fn(&MailSettings) -> bool,
    tpl: &Template,
) -> sqlx::Result<bool> {
    let Some(s) = smtp(conn).await?.filter(wanted) else {
        return Ok(false);
    };
    let Some((to, locale)) = verified_recipient(conn, user).await? else {
        return Ok(false);
    };
    mail::enqueue(conn, &s, tpl, Locale::parse(&locale), &to, Some(user), None).await?;
    Ok(true)
}

/// An administrator banned the account (call it after `apply_ban_user`):
/// the mail carries the stored ban reason, the text the portal shows the
/// user too. Queued in the caller's transaction (savepoint), switch
/// `notify_ban`. Returns whether a mail was queued.
pub async fn account_banned(conn: &mut PgConnection, user: Uuid, portal: Option<&str>) -> bool {
    in_savepoint(conn, "ban notice", async |c| {
        let reason: Option<Option<String>> = sqlx::query_scalar(
            "SELECT disabled_note FROM users WHERE id = $1 AND disabled_reason = 'admin'",
        )
        .bind(user)
        .fetch_optional(&mut *c)
        .await?;
        let Some(Some(reason)) = reason else {
            return Ok(false);
        };
        let tpl = Template::AccountBanned {
            reason,
            portal_url: portal.map(str::to_string),
        };
        notify_account(c, user, |s| s.notify_ban, &tpl).await
    })
    .await
}

/// An administrator lifted the ban (switch `notify_ban`).
pub async fn account_unbanned(conn: &mut PgConnection, user: Uuid, portal: Option<&str>) -> bool {
    in_savepoint(conn, "unban notice", async |c| {
        let tpl = Template::AccountUnbanned {
            portal_url: portal.map(str::to_string),
        };
        notify_account(c, user, |s| s.notify_ban, &tpl).await
    })
    .await
}

/// An administrator changed the account's plan (assign / switch, renew,
/// extend, cancel, reset traffic; switch `notify_plan_change`). Call it
/// after the mutator: the mail names the subscription as it now is (for a
/// cancellation the one that just ended). The user's own purchases do not
/// come through here — they get the payment receipt.
pub async fn plan_changed(
    conn: &mut PgConnection,
    user: Uuid,
    action: PlanAction,
    portal: Option<&str>,
) -> bool {
    in_savepoint(conn, "plan change notice", async |c| {
        let sub: Option<(String, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
            "SELECT p.name, up.expires_at FROM user_plans up JOIN plans p ON p.id = up.plan_id \
             WHERE up.user_id = $1 \
             ORDER BY (up.status = 'active') DESC, up.ended_at DESC NULLS FIRST, up.created_at DESC \
             LIMIT 1",
        )
        .bind(user)
        .fetch_optional(&mut *c)
        .await?;
        let Some((plan_name, expires_at)) = sub else {
            return Ok(false);
        };
        let tpl = Template::PlanChanged {
            action,
            plan_name,
            expires_at: expires_at.filter(|_| action != PlanAction::Cancelled),
            portal_url: portal.map(str::to_string),
        };
        notify_account(c, user, |s| s.notify_plan_change, &tpl).await
    })
    .await
}

/// An administrator decided a withdrawal (`commission::apply_decide`, status
/// approved or rejected; switch `notify_withdrawal`): the payout (USDT
/// amount, network, transaction hash) or the reason. Other statuses (the
/// user's own cancellation) send nothing.
pub async fn withdrawal_decided(
    conn: &mut PgConnection,
    withdrawal: Uuid,
    portal: Option<&str>,
) -> bool {
    in_savepoint(conn, "withdrawal notice", async |c| {
        type Row = (
            Option<Uuid>,
            i64,
            String,
            String,
            Option<i64>,
            Option<String>,
            Option<String>,
        );
        let row: Option<Row> = sqlx::query_as(
            "SELECT user_id, amount_cents, status, chain, usdt_micros, txid, note \
             FROM withdrawals WHERE id = $1",
        )
        .bind(withdrawal)
        .fetch_optional(&mut *c)
        .await?;
        let Some((Some(user), amount_cents, status, chain, usdt_micros, txid, note)) = row else {
            return Ok(false);
        };
        let portal_url = portal.map(str::to_string);
        let tpl = match (status.as_str(), usdt_micros, txid) {
            ("approved", Some(usdt_micros), Some(txid)) => Template::WithdrawalApproved {
                amount_cents,
                usdt_micros,
                network: crate::billing::usdt::CHAINS
                    .iter()
                    .find(|(id, _)| *id == chain)
                    .map_or(chain.clone(), |(_, name)| (*name).to_string()),
                txid,
                portal_url,
            },
            ("rejected", ..) => Template::WithdrawalRejected {
                amount_cents,
                reason: note.unwrap_or_default(),
                portal_url,
            },
            _ => return Ok(false),
        };
        notify_account(c, user, |s| s.notify_withdrawal, &tpl).await
    })
    .await
}

/// A commission was credited to the inviter's balance (`amount_cents` > 0;
/// switch `notify_commission`). The mail names the order, never the invitee.
pub async fn commission_credited(
    conn: &mut PgConnection,
    inviter: Uuid,
    amount_cents: i64,
    order: Uuid,
    portal: Option<&str>,
) -> bool {
    if amount_cents <= 0 {
        return false;
    }
    in_savepoint(conn, "commission notice", async |c| {
        let order_no: Option<String> =
            sqlx::query_scalar("SELECT out_trade_no FROM orders WHERE id = $1")
                .bind(order)
                .fetch_optional(&mut *c)
                .await?;
        let Some(order_no) = order_no else {
            return Ok(false);
        };
        let tpl = Template::CommissionCredited {
            amount_cents,
            order_no,
            portal_url: portal.map(str::to_string),
        };
        notify_account(c, inviter, |s| s.notify_commission, &tpl).await
    })
    .await
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
    in_savepoint(conn, "security notice", async |c| {
        let Some(s) = smtp(c).await? else {
            return Ok(false);
        };
        let (to, locale) = match old_address {
            Some(old) => {
                let locale: Option<String> =
                    sqlx::query_scalar("SELECT locale FROM users WHERE id = $1")
                        .bind(user)
                        .fetch_optional(&mut *c)
                        .await?;
                (old.to_string(), locale.unwrap_or_default())
            }
            None => match verified_recipient(c, user).await? {
                Some(recipient) => recipient,
                None => return Ok(false),
            },
        };
        let tpl = Template::SecurityNotice {
            event,
            at: chrono::Utc::now(),
            ip: ip.map(|a| a.to_string()),
            portal_url: portal.map(str::to_string),
        };
        mail::enqueue(c, &s, &tpl, Locale::parse(&locale), &to, Some(user), None).await?;
        Ok(true)
    })
    .await
}

#[cfg(test)]
mod tests;
