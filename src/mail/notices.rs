//! Account notices by mail (W15): the order receipt (from the payment
//! path) and the periodic expiry / quota notices.
//!
//! Receipt: `order_paid` runs inside `billing::orders::apply_mark_paid`'s
//! transaction under a savepoint — the outbox row commits with the payment
//! (a payment replay is `Paid::Already` and enqueues nothing: exactly one
//! receipt per paid order), and a failure here never rolls back money.
//!
//! Periodic notices: `run` (from the sender loop, every minute on every
//! instance while SMTP is enabled; the 5 s enforcement tick is too hot for
//! full-table scans) enqueues each notice once, guarded by `user_notices`
//! markers claimed with `INSERT ... ON CONFLICT` in the same transaction as
//! the outbox insert: concurrent instances race on the marker's unique key
//! and exactly one of them returns the row and enqueues. Expiry markers key
//! on the expiry instant (a renewal moves it and re-arms the reminder);
//! quota markers are deleted when usage drops below the threshold (period
//! reset, a bigger plan, an admin reset), re-arming them once per period.
//! Only role=user accounts with a VERIFIED address that are enabled (or
//! only quota-disabled) receive notices. Every candidate query excludes
//! already-notified rows before its LIMIT, so a backlog drains in batches.

use chrono::{DateTime, Utc};
use sqlx::{Connection, PgConnection};
use uuid::Uuid;

use super::{enqueue, Locale, Smtp, Template};
use crate::state::AppState;

/// Candidates per notice kind per pass.
const BATCH: i64 = 500;

/// Marker key of an expiry instant (microseconds since the epoch).
const EXPIRY_KEY: &str = "((extract(epoch FROM u.expires_at) * 1000000)::bigint)::text";

/// Accounts that may receive notices (alias `u`).
const RECIPIENT: &str = "u.role = 'user' AND u.email_verified_at IS NOT NULL \
     AND (u.enabled OR u.disabled_reason = 'quota')";

#[derive(sqlx::FromRow)]
struct Due {
    id: Uuid,
    email: String,
    locale: String,
    expires_at: Option<DateTime<Utc>>,
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
}

const DUE_COLS: &str =
    "u.id, u.email, u.locale, u.expires_at, u.traffic_used_bytes, u.traffic_limit_bytes";

/// Claim markers for `kind` on the candidates matching `pred` and return
/// the accounts this call claimed.
async fn claim(
    conn: &mut PgConnection,
    kind: &str,
    key: &str,
    pred: &str,
    also_mark: Option<&str>,
) -> sqlx::Result<Vec<Due>> {
    let extra = also_mark
        .map(|k| {
            format!(
                ", extra AS (INSERT INTO user_notices (user_id, kind, key) \
                 SELECT user_id, '{k}', '' FROM ins ON CONFLICT (user_id, kind) DO NOTHING)"
            )
        })
        .unwrap_or_default();
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "WITH cand AS (SELECT {DUE_COLS}, {key} AS nkey FROM users u \
           WHERE {RECIPIENT} AND {pred} AND NOT EXISTS (SELECT 1 FROM user_notices n \
             WHERE n.user_id = u.id AND n.kind = '{kind}' AND n.key = {key}) \
           ORDER BY u.id LIMIT {BATCH}), \
         ins AS (INSERT INTO user_notices (user_id, kind, key) \
           SELECT id, '{kind}', nkey FROM cand \
           ON CONFLICT (user_id, kind) DO UPDATE SET key = EXCLUDED.key, at = now() \
             WHERE user_notices.key <> EXCLUDED.key \
           RETURNING user_id){extra} \
         SELECT c.id, c.email, c.locale, c.expires_at, c.traffic_used_bytes, c.traffic_limit_bytes \
         FROM cand c JOIN ins ON ins.user_id = c.id ORDER BY c.id"
    )))
    .fetch_all(conn)
    .await
}

/// One pass over every enabled notice kind, in the caller's transaction.
/// Returns the number of mails enqueued.
pub async fn pass(
    conn: &mut PgConnection,
    smtp: &Smtp,
    portal: Option<&str>,
) -> sqlx::Result<usize> {
    let mut n = 0;
    let portal_url = portal.map(String::from);
    if smtp.notify_expiry_days > 0 {
        let pred = format!(
            "u.expires_at > now() AND u.expires_at <= now() + make_interval(days => {})",
            smtp.notify_expiry_days
        );
        for d in claim(conn, "expiry_soon", EXPIRY_KEY, &pred, None).await? {
            let Some(expires_at) = d.expires_at else {
                continue;
            };
            let t = Template::ExpirySoon {
                expires_at,
                portal_url: portal_url.clone(),
            };
            enqueue(
                conn,
                smtp,
                &t,
                Locale::parse(&d.locale),
                &d.email,
                Some(d.id),
                None,
            )
            .await?;
            n += 1;
        }
    }
    if smtp.notify_expired {
        // Recent expiries only: enabling notices must not mail every
        // account that expired long ago.
        let pred = "u.expires_at <= now() AND u.expires_at > now() - interval '3 days'";
        for d in claim(conn, "expired", EXPIRY_KEY, pred, None).await? {
            let Some(expires_at) = d.expires_at else {
                continue;
            };
            let t = Template::Expired {
                expires_at,
                portal_url: portal_url.clone(),
            };
            enqueue(
                conn,
                smtp,
                &t,
                Locale::parse(&d.locale),
                &d.email,
                Some(d.id),
                None,
            )
            .await?;
            n += 1;
        }
    }
    if smtp.notify_quota {
        // Re-arm: usage back under a threshold (reset, bigger limit).
        sqlx::query(
            "DELETE FROM user_notices n USING users u WHERE n.user_id = u.id AND ( \
               (n.kind = 'quota_80' AND (u.traffic_limit_bytes IS NULL OR u.traffic_limit_bytes = 0 \
                 OR u.traffic_used_bytes::numeric * 5 < u.traffic_limit_bytes::numeric * 4)) \
               OR (n.kind = 'quota_100' AND (u.traffic_limit_bytes IS NULL \
                 OR u.traffic_limit_bytes = 0 OR u.traffic_used_bytes < u.traffic_limit_bytes)))",
        )
        .execute(&mut *conn)
        .await?;
        let full = "u.traffic_limit_bytes > 0 AND u.traffic_used_bytes >= u.traffic_limit_bytes";
        // 100% first; it also marks 80% so a jump past both sends one mail.
        for (kind, pred, also) in [
            ("quota_100", full.to_string(), Some("quota_80")),
            (
                "quota_80",
                "u.traffic_limit_bytes > 0 AND u.traffic_used_bytes < u.traffic_limit_bytes \
                 AND u.traffic_used_bytes::numeric * 5 >= u.traffic_limit_bytes::numeric * 4"
                    .to_string(),
                None,
            ),
        ] {
            for d in claim(conn, kind, "''", &pred, also).await? {
                let limit = d.traffic_limit_bytes.unwrap_or(0);
                let t = Template::Quota {
                    percent: if kind == "quota_100" { 100 } else { 80 },
                    used_bytes: d.traffic_used_bytes,
                    limit_bytes: limit,
                    portal_url: portal_url.clone(),
                };
                enqueue(
                    conn,
                    smtp,
                    &t,
                    Locale::parse(&d.locale),
                    &d.email,
                    Some(d.id),
                    None,
                )
                .await?;
                n += 1;
            }
        }
    }
    Ok(n)
}

/// The periodic notices pass (one transaction).
pub async fn run(state: &AppState, smtp: &Smtp) -> anyhow::Result<usize> {
    let portal = super::portal_url(state);
    let mut tx = state.pg().begin().await?;
    let n = pass(&mut tx, smtp, portal.as_deref()).await?;
    tx.commit().await?;
    if n > 0 {
        tracing::info!(mails = n, "account notices queued");
    }
    Ok(n)
}

#[derive(sqlx::FromRow)]
struct Receipt {
    user_id: Uuid,
    email: String,
    locale: String,
    out_trade_no: String,
    plan_name: Option<String>,
    list_price_cents: i64,
    discount_cents: i64,
    credit_cents: i64,
    balance_cents: i64,
    amount_cents: i64,
    paid_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
}

async fn enqueue_receipt(conn: &mut PgConnection, order_id: Uuid) -> sqlx::Result<bool> {
    let smtp = super::load(conn).await?;
    if !smtp.enabled || !smtp.notify_order_paid {
        return Ok(false);
    }
    let r: Option<Receipt> = sqlx::query_as(
        "SELECT u.id AS user_id, u.email, u.locale, o.out_trade_no, o.plan_name, o.list_price_cents, o.discount_cents, \
         o.credit_cents, o.balance_cents, o.amount_cents, \
         o.paid_at, (SELECT up.expires_at FROM user_plans up WHERE up.user_id = u.id \
           AND up.status = 'active') AS expires_at \
         FROM orders o JOIN users u ON u.id = o.user_id \
         WHERE o.id = $1 AND o.paid_at IS NOT NULL AND u.email_verified_at IS NOT NULL",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(r) = r else { return Ok(false) };
    let t = Template::OrderPaid {
        order_no: r.out_trade_no,
        plan_name: r.plan_name.unwrap_or_default(),
        money: super::templates::OrderMoney {
            list_cents: r.list_price_cents,
            discount_cents: r.discount_cents,
            credit_cents: r.credit_cents,
            balance_cents: r.balance_cents,
            paid_cents: r.amount_cents,
        },
        paid_at: r.paid_at,
        expires_at: r.expires_at,
    };
    enqueue(
        conn,
        &smtp,
        &t,
        Locale::parse(&r.locale),
        &r.email,
        Some(r.user_id),
        None,
    )
    .await?;
    Ok(true)
}

/// Queue the receipt of a just-paid order, in the payment's transaction,
/// under a savepoint: any failure is logged and rolled back alone — the
/// payment and its fulfilment always commit.
pub async fn order_paid(conn: &mut PgConnection, order_id: Uuid) -> sqlx::Result<()> {
    let mut sp = conn.begin().await?;
    match enqueue_receipt(&mut sp, order_id).await {
        Ok(_) => sp.commit().await,
        Err(e) => {
            tracing::warn!(order = %order_id, error = %e, "order receipt not queued");
            sp.rollback().await
        }
    }
}
