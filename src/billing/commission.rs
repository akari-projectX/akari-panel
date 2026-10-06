//! W16 invite commissions (邀请返利) and withdrawals (提现).
//!
//! Lifecycle (docs/PAYMENTS.md "Invite commission"):
//! - `on_paid` runs inside `orders::apply_mark_paid`'s transaction (the
//!   one pay path, after the conditional paid flip): when the programme is
//!   enabled and the buyer has an inviter (a customer account, never the
//!   buyer), a `pending` commission of floor(amount_cents × rate / 100) fen
//!   is created, available after `hold_days`. `commissions.order_id` is
//!   UNIQUE and only the transaction that flipped the order gets here, so
//!   replayed/concurrent notifies and several instances create it once.
//!   The base is the Alipay amount only: coupon, switch credit and balance
//!   parts earn nothing (balance paid from commissions earns no commission).
//! - `credit_due` (enforce pass, every instance, `FOR UPDATE SKIP LOCKED`,
//!   conditional on `status = 'pending'`): due commissions become balance
//!   (ledger `commission`) exactly once.
//! - `reverse_for_order` (admin refund of a paid order): a still pending
//!   commission is reversed and never credited. A credited one stays (the
//!   hold period is the window for refunds; adjust by hand after it).
//! - Withdrawals (R46: USDT only): the user picks a chain the admin enabled
//!   and an address (checked per chain, `usdt.rs`); the CNY amount is
//!   debited when requested (funds held, one open request per user), the
//!   admin pays by hand on the exchange and approves with the USDT sent and
//!   the transaction hash, or rejects (funds back); the user may cancel
//!   while pending. Withdrawable = min(balance, credited commissions −
//!   withdrawals not rejected/cancelled). The address is shown only to the
//!   user and to admins.

use crate::auth::{bad_request, conflict};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use super::catalog::MAX_PRICE_CENTS;
use super::ledger::{self, Entry, Kind};
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

const MAX_HOLD_DAYS: i32 = 365;
const MAX_NOTE: usize = 500;
/// Commissions credited per pass (the rest next pass).
const CREDIT_BATCH: i64 = 200;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, sqlx::FromRow, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub rate_percent: i32,
    pub first_order_only: bool,
    pub hold_days: i32,
    pub min_withdrawal_cents: i64,
    /// R46: the USDT chains users may withdraw to (absent = all).
    #[serde(default = "super::usdt::default_chains")]
    pub usdt_chains: Vec<String>,
    /// R46: reference rate, CNY fen per 1 USDT (display only; null = none).
    #[serde(default)]
    pub usdt_rate_cents: Option<i64>,
}

const SETTINGS_COLS: &str = "enabled, rate_percent, first_order_only, hold_days, \
     min_withdrawal_cents, usdt_chains, usdt_rate_cents";

pub fn check_settings(s: &Settings) -> Result<(), ApiError> {
    if !(0..=100).contains(&s.rate_percent) {
        return Err(bad_request!(
            "finance.rate_percent_range",
            "rate_percent must be 0-100"
        ));
    }
    if !(0..=MAX_HOLD_DAYS).contains(&s.hold_days) {
        return Err(bad_request!(
            "finance.hold_days_range",
            "hold_days must be 0-{max_hold_days}",
            max_hold_days = MAX_HOLD_DAYS
        ));
    }
    if !(1..=MAX_PRICE_CENTS).contains(&s.min_withdrawal_cents) {
        return Err(bad_request!(
            "finance.min_withdrawal_range",
            "min_withdrawal_cents must be 1..={max_price_cents} (integer fen)",
            max_price_cents = MAX_PRICE_CENTS
        ));
    }
    if let Some(c) = s.usdt_chains.iter().find(|c| !super::usdt::known(c)) {
        return Err(bad_request!(
            "finance.usdt_chain_unknown",
            "unknown USDT chain {chain}",
            chain = c.chars().take(32).collect::<String>()
        ));
    }
    if s.usdt_rate_cents
        .is_some_and(|r| !(1..=1_000_000).contains(&r))
    {
        return Err(bad_request!(
            "finance.usdt_rate_range",
            "usdt_rate_cents must be 1..=1000000 (CNY fen per USDT)"
        ));
    }
    Ok(())
}

pub async fn settings(conn: &mut PgConnection) -> sqlx::Result<Settings> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SETTINGS_COLS} FROM commission_settings WHERE id = 1"
    )))
    .fetch_one(conn)
    .await
}

/// Replace the settings (audited `commission.settings.update`). Existing
/// commissions keep the rate and hold they were created with.
pub async fn apply_update_settings(
    conn: &mut PgConnection,
    actor: &Actor,
    s: &Settings,
) -> Result<(), ApiError> {
    check_settings(s)?;
    let before: Settings = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SETTINGS_COLS} FROM commission_settings WHERE id = 1 FOR UPDATE"
    )))
    .fetch_one(&mut *conn)
    .await?;
    // The chains in the canonical order, each once.
    let chains: Vec<String> = super::usdt::CHAINS
        .iter()
        .map(|(c, _)| c.to_string())
        .filter(|c| s.usdt_chains.contains(c))
        .collect();
    sqlx::query(
        "UPDATE commission_settings SET enabled = $1, rate_percent = $2, first_order_only = $3, \
         hold_days = $4, min_withdrawal_cents = $5, usdt_chains = $6, usdt_rate_cents = $7, \
         updated_at = now() WHERE id = 1",
    )
    .bind(s.enabled)
    .bind(s.rate_percent)
    .bind(s.first_order_only)
    .bind(s.hold_days)
    .bind(s.min_withdrawal_cents)
    .bind(&chains)
    .bind(s.usdt_rate_cents)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "commission.settings.update",
        "settings",
        Some("commission".into()),
        Some(json!(before)),
        Some(json!(s)),
    )
    .await?;
    Ok(())
}

pub async fn get_settings(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Settings>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    Ok(Json(settings(&mut c).await?))
}

pub async fn put_settings(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<Settings>,
) -> Result<Json<Settings>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_update_settings(&mut tx, &Actor::of(&user), &req).await?;
    let stored = settings(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(stored))
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Inside apply_mark_paid (the transaction that flipped the order): create
/// the pending commission, if any. Returns its (id, amount).
pub async fn on_paid(
    conn: &mut PgConnection,
    actor: &Actor,
    order_id: Uuid,
) -> Result<Option<(Uuid, i64)>, ApiError> {
    let row: Option<(Uuid, i64, Uuid, Uuid, DateTime<Utc>)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "INSERT INTO commissions (id, order_id, inviter_id, inviter_label, invitee_id, \
           invitee_label, base_cents, rate_percent, amount_cents, available_at) \
         SELECT gen_random_uuid(), o.id, inv.id, {}, u.id, {}, o.amount_cents, \
           s.rate_percent, (o.amount_cents * s.rate_percent) / 100, \
           now() + make_interval(days => s.hold_days) \
         FROM orders o JOIN users u ON u.id = o.user_id JOIN users inv ON inv.id = u.inviter_id \
         CROSS JOIN commission_settings s \
         WHERE o.id = $1 AND s.enabled AND s.rate_percent > 0 AND o.amount_cents > 0 \
           AND (o.amount_cents * s.rate_percent) / 100 > 0 \
           AND inv.id <> u.id AND inv.role = 'user' \
           AND (NOT s.first_order_only OR NOT EXISTS (SELECT 1 FROM orders p \
                WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_cents > 0 \
                AND p.refunded_at IS NULL AND p.id <> o.id)) \
         ON CONFLICT (order_id) DO NOTHING \
         RETURNING id, amount_cents, inviter_id, invitee_id, available_at",
            crate::audit::user_label_sql("inv.id"),
            crate::audit::user_label_sql("u.id"),
        )))
        .bind(order_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((id, amount, inviter, invitee, available_at)) = row else {
        return Ok(None);
    };
    crate::audit::record(
        conn,
        actor,
        "commission.create",
        "commission",
        Some(id.to_string()),
        None,
        Some(
            json!({ "order_id": order_id, "inviter_id": inviter, "invitee_id": invitee,
                     "amount_cents": amount, "available_at": available_at }),
        ),
    )
    .await?;
    Ok(Some((id, amount)))
}

/// Enforce pass (any instance, concurrently safe): credit due commissions
/// to their inviters' balances. A commission whose inviter was deleted is
/// reversed. Returns how many were settled.
pub async fn credit_due(conn: &mut PgConnection) -> Result<usize, ApiError> {
    let due: Vec<(Uuid, Option<Uuid>, i64, Uuid)> = sqlx::query_as(
        "SELECT id, inviter_id, amount_cents, order_id FROM commissions \
         WHERE status = 'pending' AND available_at <= now() \
         ORDER BY available_at, id LIMIT $1 FOR UPDATE SKIP LOCKED",
    )
    .bind(CREDIT_BATCH)
    .fetch_all(&mut *conn)
    .await?;
    let actor = Actor::system();
    for (id, inviter, amount, order) in &due {
        let Some(inviter) = inviter else {
            reverse(conn, &actor, *id, "the inviter no longer exists").await?;
            continue;
        };
        // 中-4: the inviter's outstanding clawbacks, locked before the
        // balance row (lock order commissions → user_balances); paid first
        // out of what this commission brings.
        let debts: Vec<(Uuid, i64)> = sqlx::query_as(
            "SELECT id, clawback_cents - clawback_recovered_cents FROM commissions \
             WHERE inviter_id = $1 AND clawback_cents > clawback_recovered_cents \
             ORDER BY id FOR UPDATE",
        )
        .bind(inviter)
        .fetch_all(&mut *conn)
        .await?;
        let mut e = Entry::new(*inviter, Kind::Commission, *amount);
        e.commission_id = Some(*id);
        e.order_id = Some(*order);
        let (ledger_id, _) = ledger::apply_entry(conn, &actor, &e).await?;
        sqlx::query(
            "UPDATE commissions SET status = 'credited', credited_at = now(), ledger_id = $2 \
             WHERE id = $1 AND status = 'pending'",
        )
        .bind(id)
        .bind(ledger_id)
        .execute(&mut *conn)
        .await?;
        for (debt, owed) in debts {
            if recover(conn, &actor, *inviter, debt, owed).await? < owed {
                break;
            }
        }
    }
    Ok(due.len())
}

/// 中-4: take up to `want` from `inviter`'s balance for the clawback of
/// commission `id` (ledger `commission_clawback`; the caller holds the
/// commission's row lock). Returns what was taken (never more than the
/// balance: it cannot go negative).
async fn recover(
    conn: &mut PgConnection,
    actor: &Actor,
    inviter: Uuid,
    id: Uuid,
    want: i64,
) -> Result<i64, ApiError> {
    let balance = ledger::lock_balance(conn, inviter).await?;
    let take = balance.min(want);
    if take <= 0 {
        return Ok(0);
    }
    let mut e = Entry::new(inviter, Kind::CommissionClawback, -take);
    e.commission_id = Some(id);
    ledger::apply_entry(conn, actor, &e).await?;
    sqlx::query(
        "UPDATE commissions SET clawback_recovered_cents = clawback_recovered_cents + $2 \
         WHERE id = $1",
    )
    .bind(id)
    .bind(take)
    .execute(&mut *conn)
    .await?;
    Ok(take)
}

/// 中-4: claw a credited commission back (its order was refunded): the
/// whole amount is owed; what the inviter's balance holds is taken now,
/// the rest later (`credit_due`). Audited `commission.clawback`. Returns
/// {amount_cents, recovered_cents, outstanding_cents}.
async fn claw_back(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    inviter: Option<Uuid>,
    amount: i64,
    reason: &str,
) -> Result<Value, ApiError> {
    sqlx::query(
        "UPDATE commissions SET clawback_cents = amount_cents, clawed_back_at = now() \
         WHERE id = $1 AND status = 'credited' AND clawback_cents IS NULL",
    )
    .bind(id)
    .execute(&mut *conn)
    .await?;
    // A deleted inviter has no balance left to take from.
    let recovered = match inviter {
        Some(u) => recover(conn, actor, u, id, amount).await?,
        None => 0,
    };
    let detail = json!({ "amount_cents": amount, "recovered_cents": recovered,
                         "outstanding_cents": amount - recovered });
    let mut after = detail.clone();
    after["reason"] = json!(reason);
    crate::audit::record(
        conn,
        actor,
        "commission.clawback",
        "commission",
        Some(id.to_string()),
        Some(json!({ "status": "credited" })),
        Some(after),
    )
    .await?;
    Ok(detail)
}

/// Reverse one pending commission (audited `commission.reverse`). Returns
/// false when it was not pending.
async fn reverse(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    reason: &str,
) -> Result<bool, ApiError> {
    let done: Option<i64> = sqlx::query_scalar(
        "UPDATE commissions SET status = 'reversed', reversed_at = now(), reverse_reason = $2 \
         WHERE id = $1 AND status = 'pending' RETURNING amount_cents",
    )
    .bind(id)
    .bind(reason)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(amount) = done else {
        return Ok(false);
    };
    crate::audit::record(
        conn,
        actor,
        "commission.reverse",
        "commission",
        Some(id.to_string()),
        Some(json!({ "status": "pending" })),
        Some(json!({ "status": "reversed", "amount_cents": amount, "reason": reason })),
    )
    .await?;
    Ok(true)
}

/// What a refund did to its order's commission.
#[derive(Debug, Clone, PartialEq)]
pub struct Undone {
    /// `reversed` (was pending), `clawed_back` (was credited, 中-4), or
    /// the state it was left in.
    pub status: String,
    /// The clawback: {amount_cents, recovered_cents, outstanding_cents}.
    pub clawback: Option<Value>,
}

/// The order was refunded: a pending commission is reversed, a credited
/// one clawed back (中-4: regardless of the hold; what the inviter's
/// balance cannot cover now is netted against later commissions and kept
/// out of withdrawals). None without a commission.
pub async fn reverse_for_order(
    conn: &mut PgConnection,
    actor: &Actor,
    order_id: Uuid,
    reason: &str,
) -> Result<Option<Undone>, ApiError> {
    type Row = (Uuid, String, Option<Uuid>, i64, Option<i64>);
    let c: Option<Row> = sqlx::query_as(
        "SELECT id, status, inviter_id, amount_cents, clawback_cents FROM commissions \
         WHERE order_id = $1 FOR UPDATE",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((id, status, inviter, amount, clawback)) = c else {
        return Ok(None);
    };
    Ok(Some(match (status.as_str(), clawback) {
        ("pending", _) => {
            reverse(conn, actor, id, reason).await?;
            Undone {
                status: "reversed".into(),
                clawback: None,
            }
        }
        ("credited", None) => Undone {
            status: "clawed_back".into(),
            clawback: Some(claw_back(conn, actor, id, inviter, amount, reason).await?),
        },
        _ => Undone {
            status,
            clawback: None,
        },
    }))
}

/// For the refund preview: the order's commission, what a refund would do
/// to it and what the inviter's balance would cover now. None without one.
pub async fn refund_preview(
    conn: &mut PgConnection,
    order_id: Uuid,
) -> sqlx::Result<Option<Value>> {
    let row: Option<(String, i64, Option<i64>, i64)> = sqlx::query_as(
        "SELECT c.status, c.amount_cents, c.clawback_cents, \
         COALESCE((SELECT b.balance_cents FROM user_balances b WHERE b.user_id = c.inviter_id), 0) \
         FROM commissions c WHERE c.order_id = $1",
    )
    .bind(order_id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|(status, amount, clawback, balance)| {
        let action = match (status.as_str(), clawback) {
            ("pending", _) => "reverse",
            ("credited", None) => "claw_back",
            _ => "none",
        };
        let recoverable = if action == "claw_back" {
            balance.min(amount)
        } else {
            0
        };
        json!({ "status": status, "amount_cents": amount, "action": action,
                "recoverable_now_cents": recoverable })
    }))
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct WithdrawReq {
    pub amount_cents: i64,
    /// R46: one of the enabled `usdt_chains`.
    pub chain: String,
    pub address: String,
    /// TON only: the deposit memo / comment (optional).
    #[serde(default)]
    pub memo: Option<String>,
}

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct WithdrawalView {
    id: Uuid,
    user_id: Option<Uuid>,
    /// Q4: snapshot label; `user_email` = the requester's current address.
    user_label: String,
    user_email: Option<String>,
    /// CNY debited.
    amount_cents: i64,
    chain: String,
    /// Only the requester and admins ever see it.
    address: String,
    memo: Option<String>,
    status: String,
    /// The USDT the admin sent (decimal text, 6 places) and the hash.
    usdt_amount: Option<String>,
    txid: Option<String>,
    note: Option<String>,
    decided_at: Option<DateTime<Utc>>,
    decided_by: Option<String>,
    created_at: DateTime<Utc>,
}

const WITHDRAWAL_SQL: &str = "SELECT id, user_id, user_label, \
     (SELECT u.email FROM users u WHERE u.id = withdrawals.user_id) AS user_email, \
     amount_cents, chain, address, memo, status, \
     CASE WHEN usdt_micros IS NULL THEN NULL \
          ELSE to_char(usdt_micros / 1000000.0, 'FM999999999990.000000') END AS usdt_amount, \
     txid, note, decided_at, decided_by, created_at FROM withdrawals";

/// Pure: a USDT amount (decimal text, ≤ 6 places, > 0) in micro-USDT.
pub fn usdt_micros(text: &str) -> Option<i64> {
    let t = text.trim();
    let (int, frac) = match t.split_once('.') {
        Some((i, f)) => (i, f),
        None => (t, ""),
    };
    if int.is_empty()
        || int.len() > 9
        || frac.len() > 6
        || !int.bytes().all(|b| b.is_ascii_digit())
        || !frac.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let micros =
        int.parse::<i64>().ok()? * 1_000_000 + format!("{frac:0<6}").parse::<i64>().ok()?;
    (micros > 0).then_some(micros)
}

/// Pure: a transaction hash as an explorer shows it (hex, base58 or
/// base64 characters, 8–128).
pub fn txid_ok(t: &str) -> bool {
    (8..=128).contains(&t.len())
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'+' | b'/' | b'='))
}

/// A user's withdrawal request: checked against the withdrawable amount
/// under the balance row lock, the funds debited at once (ledger
/// `withdrawal`). One open request per user (409).
pub async fn apply_request(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
    req: &WithdrawReq,
) -> Result<Uuid, ApiError> {
    if !(1..=MAX_PRICE_CENTS).contains(&req.amount_cents) {
        return Err(bad_request!(
            "withdrawal.amount_range",
            "amount_cents must be 1..={max_price_cents} (integer fen)",
            max_price_cents = MAX_PRICE_CENTS
        ));
    }
    let s = settings(conn).await?;
    if !s.usdt_chains.contains(&req.chain) {
        return Err(bad_request!(
            "withdrawal.chain_invalid",
            "unknown chain {chain}",
            chain = req.chain.chars().take(32).collect::<String>()
        ));
    }
    let (address, memo) =
        super::usdt::check_address(&req.chain, &req.address, req.memo.as_deref())?;
    if req.amount_cents < s.min_withdrawal_cents {
        return Err(bad_request!(
            "withdrawal.below_minimum",
            "the minimum withdrawal is {min_cents} fen",
            min_cents = s.min_withdrawal_cents
        ));
    }
    ledger::lock_balance(conn, user_id).await?;
    let withdrawable = ledger::withdrawable(conn, user_id).await?;
    if req.amount_cents > withdrawable {
        return Err(conflict!(
            "withdrawal.exceeds",
            "amount exceeds the withdrawable balance"
        ));
    }
    let id = Uuid::new_v4();
    let r = sqlx::query(
        "INSERT INTO withdrawals (id, user_id, user_label, amount_cents, chain, address, memo) \
         SELECT $1, u.id, $6, $3, $4, $5, $7 FROM users u WHERE u.id = $2",
    )
    .bind(id)
    .bind(user_id)
    .bind(req.amount_cents)
    .bind(&req.chain)
    .bind(&address)
    .bind(crate::audit::user_label(user_id))
    .bind(&memo)
    .execute(&mut *conn)
    .await;
    match r {
        Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
            return Err(conflict!(
                "withdrawal.open",
                "you already have an open withdrawal request"
            ));
        }
        r => r?,
    };
    let mut e = Entry::new(user_id, Kind::Withdrawal, -req.amount_cents);
    e.withdrawal_id = Some(id);
    ledger::apply_entry(conn, actor, &e).await?;
    Ok(id)
}

/// What an approval records: the USDT sent (micro-USDT) and the hash.
#[derive(Debug, Clone, Copy)]
pub struct Payout<'a> {
    pub usdt_micros: i64,
    pub txid: &'a str,
}

/// Decide a pending withdrawal: `approved` (with the payout) or
/// `rejected`/`cancelled` (funds back: ledger `withdrawal_reversal`).
/// Audited `withdrawal.<status>`. 409 when no longer pending.
pub async fn apply_decide(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    owner: Option<Uuid>,
    status: &str,
    payout: Option<Payout<'_>>,
    note: Option<&str>,
) -> Result<(), ApiError> {
    // Lock order: the balance row before the withdrawal row (as
    // apply_request, which locks the balance and then inserts).
    let owner_now: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT user_id FROM withdrawals WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    if let Some(Some(u)) = owner_now {
        ledger::lock_balance(conn, u).await?;
    }
    let cur: Option<(Option<Uuid>, i64, String)> = sqlx::query_as(
        "SELECT user_id, amount_cents, status FROM withdrawals WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((user, amount, cur_status)) = cur else {
        return Err(ApiError::not_found());
    };
    if owner.is_some() && owner != user {
        return Err(ApiError::not_found());
    }
    if cur_status != "pending" {
        return Err(conflict!(
            "withdrawal.not_pending",
            "the withdrawal is no longer pending"
        ));
    }
    if status != "approved" {
        let Some(user) = user else {
            return Err(conflict!(
                "finance.withdrawal_user_gone",
                "the user no longer exists; approve or leave the request"
            ));
        };
        let mut e = Entry::new(user, Kind::WithdrawalReversal, amount);
        e.withdrawal_id = Some(id);
        e.reason = note;
        ledger::apply_entry(conn, actor, &e).await?;
    }
    sqlx::query(
        "UPDATE withdrawals SET status = $2, usdt_micros = $3, txid = $4, note = $5, \
         decided_at = now(), decided_by = $6 WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(payout.map(|p| p.usdt_micros))
    .bind(payout.map(|p| p.txid))
    .bind(note)
    .bind(&actor.label)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        &format!("withdrawal.{status}"),
        "withdrawal",
        Some(id.to_string()),
        Some(json!({ "status": "pending", "amount_cents": amount, "user_id": user })),
        Some(json!({
            "status": status,
            "usdt_micros": payout.map(|p| p.usdt_micros),
            "txid": payout.map(|p| p.txid),
            "note": note,
        })),
    )
    .await?;
    Ok(())
}

fn check_text(
    field: &str,
    v: Option<&str>,
    max: usize,
    required: bool,
) -> Result<Option<String>, ApiError> {
    let v = v.map(str::trim).filter(|s| !s.is_empty());
    match v {
        None if required => Err(bad_request!(
            "request.field_required",
            "{field} is required",
            field = field
        )),
        Some(s) if s.chars().count() > max => Err(bad_request!(
            "request.field_too_long",
            "{field} must be at most {max} characters",
            field = field,
            max = max
        )),
        v => Ok(v.map(str::to_string)),
    }
}

// ----- user endpoints -------------------------------------------------------

/// GET /me/invite: programme terms, invite codes (W15), invited users,
/// commission totals and history, withdrawable.
pub async fn my_invite(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let mut c = state.pg().acquire().await?;
    let s = settings(&mut c).await?;
    let (invited, pending, credited, reversed): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM users WHERE inviter_id = $1), \
           COALESCE((SELECT sum(amount_cents) FROM commissions WHERE inviter_id = $1 \
                     AND status = 'pending'), 0)::bigint, \
           COALESCE((SELECT sum(amount_cents) FROM commissions WHERE inviter_id = $1 \
                     AND status = 'credited'), 0)::bigint, \
           COALESCE((SELECT sum(amount_cents) FROM commissions WHERE inviter_id = $1 \
                     AND status = 'reversed'), 0)::bigint",
    )
    .bind(user.id)
    .fetch_one(&mut *c)
    .await?;
    let history: Vec<MyCommission> = sqlx::query_as(
        "SELECT id, invitee_label, base_cents, rate_percent, amount_cents, status, \
         available_at, credited_at, reversed_at, clawback_cents, clawback_recovered_cents, \
         clawed_back_at, created_at FROM commissions \
         WHERE inviter_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100",
    )
    .bind(user.id)
    .fetch_all(&mut *c)
    .await?;
    // W15: the account's invite codes (managed at /me/invite-codes).
    let invite_codes: Vec<String> = sqlx::query_scalar(
        "SELECT code FROM invite_codes WHERE user_id = $1 ORDER BY created_at, code",
    )
    .bind(user.id)
    .fetch_all(&mut *c)
    .await?;
    let withdrawable = ledger::withdrawable(&mut c, user.id).await?;
    let balance = ledger::balance(&mut c, user.id).await?;
    Ok(Json(json!({
        "enabled": s.enabled,
        "rate_percent": s.rate_percent,
        "first_order_only": s.first_order_only,
        "hold_days": s.hold_days,
        "min_withdrawal_cents": s.min_withdrawal_cents,
        // R46: where withdrawals can go, and the reference rate.
        "usdt_chains": s.usdt_chains.iter().map(|c| json!({
            "id": c,
            "name": super::usdt::CHAINS.iter().find(|(id, _)| id == c).map(|(_, n)| *n),
        })).collect::<Vec<_>>(),
        "usdt_rate_cents": s.usdt_rate_cents,
        // W15's per-user codes (registration invite links).
        "invite_codes": invite_codes,
        "invited_count": invited,
        "pending_cents": pending,
        "credited_cents": credited,
        "reversed_cents": reversed,
        "balance_cents": balance,
        "withdrawable_cents": withdrawable,
        "commissions": history,
    })))
}

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct MyCommission {
    id: Uuid,
    /// Q4: the invitee's non-personal label (never their address).
    invitee_label: String,
    base_cents: i64,
    rate_percent: i32,
    amount_cents: i64,
    status: String,
    available_at: DateTime<Utc>,
    credited_at: Option<DateTime<Utc>>,
    reversed_at: Option<DateTime<Utc>>,
    /// 中-4: clawed back by a refund (amount; recovered so far).
    clawback_cents: Option<i64>,
    clawback_recovered_cents: i64,
    clawed_back_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

pub async fn my_withdrawals(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<WithdrawalView>>, ApiError> {
    let rows = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{WITHDRAWAL_SQL} WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50"
    )))
    .bind(user.id)
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

pub async fn request_withdrawal(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<WithdrawReq>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if user.role != "user" {
        return Err(bad_request!(
            "balance.admin_none",
            "admin accounts have no balance"
        ));
    }
    let mut tx = state.pg().begin().await?;
    let id = apply_request(&mut tx, &Actor::of(&user), user.id, &req).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

pub async fn cancel_withdrawal(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let mut tx = state.pg().begin().await?;
    apply_decide(
        &mut tx,
        &Actor::of(&user),
        id,
        Some(user.id),
        "cancelled",
        None,
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ----- admin endpoints ------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    pub status: Option<String>,
    /// Exact email address, any case (inviter for commissions, requester
    /// for withdrawals).
    pub email: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct CommissionView {
    id: Uuid,
    order_id: Uuid,
    out_trade_no: String,
    inviter_id: Option<Uuid>,
    /// Q4: snapshot labels; the `*_email` fields are the current addresses
    /// (null once the account is gone).
    inviter_label: String,
    inviter_email: Option<String>,
    invitee_id: Option<Uuid>,
    invitee_label: String,
    invitee_email: Option<String>,
    base_cents: i64,
    rate_percent: i32,
    amount_cents: i64,
    status: String,
    available_at: DateTime<Utc>,
    credited_at: Option<DateTime<Utc>>,
    reversed_at: Option<DateTime<Utc>>,
    reverse_reason: Option<String>,
    /// 中-4: clawed back by a refund (amount; recovered so far).
    clawback_cents: Option<i64>,
    clawback_recovered_cents: i64,
    clawed_back_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

pub async fn list_commissions(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<CommissionView>>, ApiError> {
    user.require_admin()?;
    if let Some(s) = &q.status
        && !matches!(s.as_str(), "pending" | "credited" | "reversed")
    {
        return Err(bad_request!("request.status_invalid", "unknown status"));
    }
    let rows = sqlx::query_as(
        "SELECT c.id, c.order_id, o.out_trade_no, c.inviter_id, c.inviter_label, \
         (SELECT u.email FROM users u WHERE u.id = c.inviter_id) AS inviter_email, c.invitee_id, \
         c.invitee_label, (SELECT u.email FROM users u WHERE u.id = c.invitee_id) AS invitee_email, \
         c.base_cents, c.rate_percent, c.amount_cents, c.status, \
         c.available_at, c.credited_at, c.reversed_at, c.reverse_reason, c.clawback_cents, \
         c.clawback_recovered_cents, c.clawed_back_at, c.created_at \
         FROM commissions c JOIN orders o ON o.id = c.order_id \
         WHERE ($1::text IS NULL OR c.status = $1) \
           AND ($2::text IS NULL OR c.inviter_id = (SELECT u.id FROM users u WHERE u.email = $2)) \
         ORDER BY c.created_at DESC, c.id DESC LIMIT $3",
    )
    .bind(q.status)
    .bind(
        q.email
            .as_deref()
            .map(|e| e.trim().to_lowercase())
            .filter(|e| !e.is_empty()),
    )
    .bind(q.limit.unwrap_or(100).clamp(1, 500))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

pub async fn list_withdrawals(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<WithdrawalView>>, ApiError> {
    user.require_admin()?;
    if let Some(s) = &q.status
        && !matches!(
            s.as_str(),
            "pending" | "approved" | "rejected" | "cancelled"
        )
    {
        return Err(bad_request!("request.status_invalid", "unknown status"));
    }
    let rows = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{WITHDRAWAL_SQL} WHERE ($1::text IS NULL OR status = $1) \
         AND ($2::text IS NULL OR user_id = (SELECT u.id FROM users u WHERE u.email = $2)) \
         ORDER BY created_at DESC, id DESC LIMIT $3"
    )))
    .bind(q.status)
    .bind(
        q.email
            .as_deref()
            .map(|e| e.trim().to_lowercase())
            .filter(|e| !e.is_empty()),
    )
    .bind(q.limit.unwrap_or(100).clamp(1, 500))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct ApproveReq {
    /// R46: the USDT actually sent (decimal text, ≤ 6 places).
    pub usdt_amount: String,
    /// The transaction hash on the chain.
    pub txid: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct RejectReq {
    pub reason: String,
}

pub async fn approve_withdrawal(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<ApproveReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let micros = usdt_micros(&req.usdt_amount).ok_or_else(|| {
        bad_request!(
            "withdrawal.usdt_amount_invalid",
            "usdt_amount must be a positive amount with at most 6 decimals"
        )
    })?;
    let txid = req.txid.trim();
    if !txid_ok(txid) {
        return Err(bad_request!(
            "withdrawal.txid_invalid",
            "txid must be the transaction hash (8-128 characters)"
        ));
    }
    let note = check_text("note", req.note.as_deref(), MAX_NOTE, false)?;
    let mut tx = state.pg().begin().await?;
    apply_decide(
        &mut tx,
        &Actor::of(&user),
        id,
        None,
        "approved",
        Some(Payout {
            usdt_micros: micros,
            txid,
        }),
        note.as_deref(),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn reject_withdrawal(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<RejectReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let reason = check_text("reason", Some(&req.reason), MAX_NOTE, true)?;
    let mut tx = state.pg().begin().await?;
    apply_decide(
        &mut tx,
        &Actor::of(&user),
        id,
        None,
        "rejected",
        None,
        reason.as_deref(),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
