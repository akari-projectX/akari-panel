//! W16 balance (余额): the append-only ledger and the views on it.
//!
//! The balance changes ONLY by inserting a `balance_ledger` row (migration
//! 0106): the table's trigger applies the amount to `user_balances` under
//! that row's lock and refuses a negative result (SQLSTATE AK003 → 409
//! "insufficient balance"); a guard trigger refuses every other write of
//! the balance column. `apply_entry` is the one Rust entry point: one
//! ledger row + one `balance.<kind>` audit row, in the caller's
//! transaction, next to whatever caused the movement (order, commission,
//! withdrawal, admin adjustment).
//!
//! Lock order of money rows (deadlock-free; apply_mark_paid and order
//! creation start with entitle::lock): orders → coupons → commissions →
//! user_balances → withdrawals.

use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, ShopUser};
use crate::state::AppState;

/// Largest single admin adjustment (1,000,000.00 CNY).
pub const MAX_ADJUST_CENTS: i64 = 100_000_000;
const MAX_REASON: usize = 500;

/// What moved the balance (sign enforced by the table's CHECK).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Commission,
    AdminAdjust,
    OrderPayment,
    RefundToBalance,
    Withdrawal,
    WithdrawalReversal,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Commission => "commission",
            Kind::AdminAdjust => "admin_adjust",
            Kind::OrderPayment => "order_payment",
            Kind::RefundToBalance => "refund_to_balance",
            Kind::Withdrawal => "withdrawal",
            Kind::WithdrawalReversal => "withdrawal_reversal",
        }
    }
}

/// One balance movement.
#[derive(Clone, Debug)]
pub struct Entry<'a> {
    pub user_id: Uuid,
    pub kind: Kind,
    /// Signed fen (never 0).
    pub amount_cents: i64,
    pub order_id: Option<Uuid>,
    pub commission_id: Option<Uuid>,
    pub withdrawal_id: Option<Uuid>,
    pub reason: Option<&'a str>,
}

impl<'a> Entry<'a> {
    pub fn new(user_id: Uuid, kind: Kind, amount_cents: i64) -> Self {
        Entry {
            user_id,
            kind,
            amount_cents,
            order_id: None,
            commission_id: None,
            withdrawal_id: None,
            reason: None,
        }
    }
}

/// Write one ledger row (the trigger moves the balance; AK003 → 409
/// "insufficient balance") and its `balance.<kind>` audit row, in the
/// caller's transaction. Returns (ledger id, balance after).
pub async fn apply_entry(
    conn: &mut PgConnection,
    actor: &Actor,
    e: &Entry<'_>,
) -> Result<(i64, i64), ApiError> {
    let row: Option<(i64, i64)> = sqlx::query_as(
        "INSERT INTO balance_ledger (user_id, user_login, kind, amount_cents, order_id, \
         commission_id, withdrawal_id, reason, actor_login) \
         SELECT u.id, u.login, $2, $3, $4, $5, $6, $7, $8 FROM users u WHERE u.id = $1 \
         RETURNING id, balance_after_cents",
    )
    .bind(e.user_id)
    .bind(e.kind.as_str())
    .bind(e.amount_cents)
    .bind(e.order_id)
    .bind(e.commission_id)
    .bind(e.withdrawal_id)
    .bind(e.reason)
    .bind(&actor.login)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((id, after)) = row else {
        return Err(ApiError::conflict("the user no longer exists"));
    };
    crate::audit::record(
        conn,
        actor,
        &format!("balance.{}", e.kind.as_str()),
        "user",
        Some(e.user_id.to_string()),
        None,
        Some(json!({
            "ledger_id": id,
            "kind": e.kind.as_str(),
            "amount_cents": e.amount_cents,
            "balance_after_cents": after,
            "order_id": e.order_id,
            "commission_id": e.commission_id,
            "withdrawal_id": e.withdrawal_id,
            "reason": e.reason,
        })),
    )
    .await?;
    Ok((id, after))
}

/// Lock the user's balance row (creating it at 0) and return the balance.
/// Callers decide how much to take under this lock.
pub async fn lock_balance(conn: &mut PgConnection, user_id: Uuid) -> sqlx::Result<i64> {
    sqlx::query("INSERT INTO user_balances (user_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query_scalar("SELECT balance_cents FROM user_balances WHERE user_id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_one(conn)
        .await
}

/// The user's balance (0 without a row). No lock.
pub async fn balance(conn: &mut PgConnection, user_id: Uuid) -> sqlx::Result<i64> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT balance_cents FROM user_balances WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(conn)
            .await?
            .unwrap_or(0),
    )
}

/// SQL: what user `$1` may withdraw as cash: the balance, but at most the
/// commissions credited to them minus their withdrawals that were not
/// rejected or cancelled (refunds and admin credits are spendable on
/// orders, not withdrawable).
pub const WITHDRAWABLE_SQL: &str = "SELECT GREATEST(0, LEAST( \
       COALESCE((SELECT balance_cents FROM user_balances WHERE user_id = $1), 0), \
       COALESCE((SELECT sum(amount_cents) FROM commissions \
                 WHERE inviter_id = $1 AND status = 'credited'), 0) \
       - COALESCE((SELECT sum(amount_cents) FROM withdrawals \
                   WHERE user_id = $1 AND status IN ('pending', 'approved')), 0)))::bigint";

pub async fn withdrawable(conn: &mut PgConnection, user_id: Uuid) -> sqlx::Result<i64> {
    sqlx::query_scalar(WITHDRAWABLE_SQL)
        .bind(user_id)
        .fetch_one(conn)
        .await
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct EntryView {
    id: i64,
    kind: String,
    amount_cents: i64,
    balance_after_cents: i64,
    order_id: Option<Uuid>,
    out_trade_no: Option<String>,
    commission_id: Option<Uuid>,
    withdrawal_id: Option<Uuid>,
    reason: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct AdminEntryView {
    #[serde(flatten)]
    #[sqlx(flatten)]
    entry: EntryView,
    user_id: Option<Uuid>,
    user_login: String,
    actor_login: String,
}

const ENTRY_COLS: &str = "l.id, l.kind, l.amount_cents, l.balance_after_cents, l.order_id, \
     o.out_trade_no, l.commission_id, l.withdrawal_id, l.reason, l.created_at";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageQuery {
    /// Keyset: entries older than this ledger id.
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

async fn entries(
    conn: &mut PgConnection,
    user_id: Uuid,
    q: &PageQuery,
) -> sqlx::Result<Vec<AdminEntryView>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {ENTRY_COLS}, l.user_id, l.user_login, l.actor_login FROM balance_ledger l \
         LEFT JOIN orders o ON o.id = l.order_id \
         WHERE l.user_id = $1 AND ($2::bigint IS NULL OR l.id < $2) \
         ORDER BY l.id DESC LIMIT $3"
    )))
    .bind(user_id)
    .bind(q.before)
    .bind(q.limit.unwrap_or(50).clamp(1, 200))
    .fetch_all(conn)
    .await
}

/// GET /me/balance: the caller's balance, what of it is withdrawable, and
/// the ledger (newest first, keyset `before`). Renewal scope (ShopUser):
/// an expired account can still see and spend its balance.
pub async fn my_balance(
    State(state): State<AppState>,
    ShopUser { user, .. }: ShopUser,
    Query(q): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    let mut c = state.pg().acquire().await?;
    let balance = balance(&mut c, user.id).await?;
    let withdrawable = withdrawable(&mut c, user.id).await?;
    let rows: Vec<EntryView> = entries(&mut c, user.id, &q)
        .await?
        .into_iter()
        .map(|r| r.entry)
        .collect();
    Ok(Json(json!({
        "balance_cents": balance,
        "withdrawable_cents": withdrawable,
        "entries": rows,
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BalancesQuery {
    /// Exact login.
    pub login: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct BalanceRow {
    user_id: Uuid,
    login: String,
    balance_cents: i64,
    updated_at: DateTime<Utc>,
}

/// GET /balances: customers holding a balance row (largest first), or
/// the customer with this exact login (balance 0 when they never had one,
/// so an admin can find anyone to adjust). Admin.
pub async fn list_balances(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<BalancesQuery>,
) -> Result<Json<Vec<BalanceRow>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as(
        "SELECT u.id AS user_id, u.login, COALESCE(b.balance_cents, 0) AS balance_cents, \
         COALESCE(b.updated_at, u.created_at) AS updated_at \
         FROM users u LEFT JOIN user_balances b ON b.user_id = u.id \
         WHERE u.role = 'user' AND (($1::text IS NULL AND b.user_id IS NOT NULL) OR u.login = $1) \
         ORDER BY balance_cents DESC, u.login LIMIT $2",
    )
    .bind(q.login.filter(|l| !l.is_empty()))
    .bind(q.limit.unwrap_or(100).clamp(1, 500))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// GET /users/{id}/balance: balance, withdrawable and ledger. Admin.
pub async fn user_balance(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    let login: Option<String> = sqlx::query_scalar("SELECT login FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *c)
        .await?;
    let Some(login) = login else {
        return Err(ApiError::not_found());
    };
    let balance = balance(&mut c, id).await?;
    let withdrawable = withdrawable(&mut c, id).await?;
    let rows = entries(&mut c, id, &q).await?;
    Ok(Json(json!({
        "user_id": id,
        "login": login,
        "balance_cents": balance,
        "withdrawable_cents": withdrawable,
        "entries": rows,
    })))
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct AdjustReq {
    /// Signed fen: positive credits, negative debits (never below 0).
    pub amount_cents: i64,
    pub reason: String,
}

/// Validate an adjustment request; returns the trimmed reason.
pub fn check_adjust(req: &AdjustReq) -> Result<&str, ApiError> {
    if req.amount_cents == 0 || req.amount_cents.unsigned_abs() > MAX_ADJUST_CENTS as u64 {
        return Err(ApiError::bad_request(format!(
            "amount_cents must be non-zero and within ±{MAX_ADJUST_CENTS} (integer fen)"
        )));
    }
    let reason = req.reason.trim();
    if reason.is_empty() || reason.chars().count() > MAX_REASON {
        return Err(ApiError::bad_request(format!(
            "reason must be 1-{MAX_REASON} characters"
        )));
    }
    Ok(reason)
}

/// Admin adjustment (ledger admin_adjust + audit, one transaction). Only
/// customer accounts hold balances.
pub async fn apply_adjust(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
    req: &AdjustReq,
) -> Result<i64, ApiError> {
    let reason = check_adjust(req)?;
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    match role.as_deref() {
        None => return Err(ApiError::not_found()),
        Some("user") => {}
        Some(_) => return Err(ApiError::bad_request("admin accounts have no balance")),
    }
    let mut e = Entry::new(user_id, Kind::AdminAdjust, req.amount_cents);
    e.reason = Some(reason);
    let (_, after) = apply_entry(conn, actor, &e).await?;
    Ok(after)
}

/// POST /users/{id}/balance {amount_cents, reason}. Admin.
pub async fn adjust(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<AdjustReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let after = apply_adjust(&mut tx, &Actor::of(&user), id, &req).await?;
    tx.commit().await?;
    Ok(Json(json!({ "balance_cents": after })))
}
