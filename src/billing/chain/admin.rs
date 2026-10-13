//! C2: on-chain transfers for the admin — the list (with each method's
//! watcher state) and the two resolutions of an unmatched transfer:
//! assign it to an order of the same method (paid through
//! `apply_mark_paid`, paid_via `chain`, the reason kept as the order's
//! `manual_reason`) or ignore it (money handled outside the panel). Both
//! audited in their transaction; nothing is ever credited without one of
//! them.

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::billing::orders::{self, Paid, Via};
use crate::state::AppState;

const MAX_REASON: usize = 500;
const STATUSES: [&str; 6] = [
    "pending",
    "credited",
    "unmatched",
    "assigned",
    "ignored",
    "dropped",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    pub status: Option<String>,
    pub method_id: Option<Uuid>,
    /// Keyset: transfers with a smaller id.
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TransferView {
    id: i64,
    method_id: Uuid,
    method_name: Option<String>,
    chain: String,
    tx_hash: String,
    log_index: i32,
    block_number: i64,
    block_time: Option<DateTime<Utc>>,
    /// Confirmations now (from the method's last head).
    confirmations: Option<i64>,
    from_address: String,
    amount_units: i64,
    /// Decimal USDT ("4.170123").
    amount: String,
    status: String,
    reason: Option<String>,
    order_id: Option<Uuid>,
    out_trade_no: Option<String>,
    /// The order's amount in CNY fen (to compare when assigning).
    order_amount_cents: Option<i64>,
    note: Option<String>,
    seen_at: DateTime<Utc>,
    confirmed_at: Option<DateTime<Utc>>,
    resolved_at: Option<DateTime<Utc>>,
    resolved_by_email: Option<String>,
}

const TRANSFER_SQL: &str = "SELECT t.id, t.method_id, pm.display_name AS method_name, t.chain, \
     t.tx_hash, t.log_index, t.block_number, t.block_time, \
     GREATEST(0, c.head - t.block_number + 1) AS confirmations, t.from_address, t.amount_units, \
     (t.amount_units / 1000000)::text || '.' || lpad((t.amount_units % 1000000)::text, 6, '0') \
       AS amount, t.status, t.reason, t.order_id, o.out_trade_no, \
     o.amount_cents AS order_amount_cents, t.note, t.seen_at, t.confirmed_at, t.resolved_at, \
     u.email AS resolved_by_email \
     FROM chain_transfers t \
     LEFT JOIN payment_methods pm ON pm.id = t.method_id \
     LEFT JOIN chain_cursors c ON c.method_id = t.method_id \
     LEFT JOIN orders o ON o.id = t.order_id \
     LEFT JOIN users u ON u.id = t.resolved_by";

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct WatcherView {
    method_id: Uuid,
    display_name: String,
    enabled: bool,
    chain: Option<String>,
    next_block: Option<i64>,
    head: Option<i64>,
    head_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
    failing_since: Option<DateTime<Utc>>,
    pending: i64,
    unmatched: i64,
}

const WATCHER_SQL: &str = "SELECT pm.id AS method_id, pm.display_name, pm.enabled, \
     pm.config->>'chain' AS chain, c.next_block, c.head, c.head_at, c.last_error, c.failing_since, \
     (SELECT count(*) FROM chain_transfers t WHERE t.method_id = pm.id AND t.status = 'pending') \
       AS pending, \
     (SELECT count(*) FROM chain_transfers t WHERE t.method_id = pm.id AND t.status = 'unmatched') \
       AS unmatched \
     FROM payment_methods pm LEFT JOIN chain_cursors c ON c.method_id = pm.id \
     WHERE pm.kind = 'usdt_chain' ORDER BY pm.sort, pm.created_at, pm.id";

/// GET /payments/chain-transfers (admin): transfers newest first (keyset
/// `before`, filters `status`, `method_id`) and every on-chain method's
/// watcher state.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    if q.status.as_deref().is_some_and(|s| !STATUSES.contains(&s)) {
        return Err(bad_request!("request.status_invalid", "unknown status"));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let transfers: Vec<TransferView> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{TRANSFER_SQL} WHERE ($1::text IS NULL OR t.status = $1) \
         AND ($2::uuid IS NULL OR t.method_id = $2) AND ($3::bigint IS NULL OR t.id < $3) \
         ORDER BY t.id DESC LIMIT $4"
    )))
    .bind(&q.status)
    .bind(q.method_id)
    .bind(q.before)
    .bind(limit)
    .fetch_all(state.pg())
    .await?;
    let watchers: Vec<WatcherView> = sqlx::query_as(WATCHER_SQL).fetch_all(state.pg()).await?;
    Ok(Json(
        json!({ "transfers": transfers, "watchers": watchers }),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssignReq {
    pub order_id: Uuid,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IgnoreReq {
    pub reason: String,
}

fn reason_of(raw: &str) -> Result<String, ApiError> {
    let r = raw.trim();
    if r.is_empty() || r.chars().count() > MAX_REASON || r.chars().any(char::is_control) {
        return Err(bad_request!(
            "request.reason_length",
            "reason must be 1-{max_reason} characters",
            max_reason = MAX_REASON
        ));
    }
    Ok(r.to_string())
}

#[derive(Debug, sqlx::FromRow)]
struct Locked {
    method_id: Uuid,
    status: String,
    tx_hash: String,
    log_index: i32,
    amount_units: i64,
    from_address: String,
    block_number: i64,
}

fn snapshot(t: &Locked) -> Value {
    json!({ "method_id": t.method_id, "status": t.status, "tx_hash": t.tx_hash,
            "log_index": t.log_index, "amount_units": t.amount_units,
            "amount": super::format_units(t.amount_units),
            "from": t.from_address, "block_number": t.block_number })
}

async fn lock_open(conn: &mut sqlx::PgConnection, id: i64) -> Result<Locked, ApiError> {
    let t: Locked = sqlx::query_as(
        "SELECT method_id, status, tx_hash, log_index, amount_units, from_address, block_number \
         FROM chain_transfers WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(ApiError::not_found)?;
    if t.status != "unmatched" {
        return Err(conflict!(
            "chain.transfer_not_open",
            "only an unmatched transfer can be assigned or ignored"
        ));
    }
    Ok(t)
}

/// Assign an unmatched transfer to an unpaid order of the same method:
/// the order is paid (`apply_mark_paid`, paid_via `chain`, trade number =
/// the transaction hash, the reason as `manual_reason`) and the transfer
/// becomes `assigned`. Audited `chain_transfer.assign`.
pub async fn apply_assign(
    conn: &mut sqlx::PgConnection,
    actor: &Actor,
    id: i64,
    req: &AssignReq,
) -> Result<Paid, ApiError> {
    let reason = reason_of(&req.reason)?;
    crate::entitle::lock(conn).await?;
    let t = lock_open(conn, id).await?;
    let order: Option<(Option<Uuid>, String, i64, String)> = sqlx::query_as(
        "SELECT payment_method_id, status, amount_cents, out_trade_no FROM orders \
         WHERE id = $1 FOR UPDATE",
    )
    .bind(req.order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((method, status, cents, otn)) = order else {
        return Err(bad_request!("chain.order_unknown", "no such order"));
    };
    if method != Some(t.method_id) {
        return Err(conflict!(
            "chain.order_mismatch",
            "the order is not paid with this transfer's payment method"
        ));
    }
    if status == "paid" {
        return Err(conflict!("chain.order_paid", "the order is already paid"));
    }
    let r = orders::apply_mark_paid(
        conn,
        actor,
        req.order_id,
        Via::Chain,
        Some(&t.tx_hash),
        Some(cents),
        Some(&reason),
    )
    .await?;
    sqlx::query(
        "UPDATE chain_transfers SET status = 'assigned', order_id = $2, note = $3, \
         confirmed_at = COALESCE(confirmed_at, now()), resolved_at = now(), resolved_by = $4 \
         WHERE id = $1",
    )
    .bind(id)
    .bind(req.order_id)
    .bind(&reason)
    .bind(actor.id)
    .execute(&mut *conn)
    .await?;
    let shown = snapshot(&t);
    orders::record_event(
        conn,
        Some(req.order_id),
        Some(&otn),
        "chain",
        true,
        "assigned",
        Some("assigned"),
        Some(json!({ "transfer": shown, "reason": reason, "by": actor.label })),
        actor.ip,
    )
    .await?;
    crate::audit::record(
        conn,
        actor,
        "chain_transfer.assign",
        "chain_transfer",
        Some(id.to_string()),
        Some(shown),
        Some(
            json!({ "status": "assigned", "order_id": req.order_id, "out_trade_no": otn,
                     "order_amount_cents": cents, "reason": reason }),
        ),
    )
    .await?;
    Ok(r)
}

/// Mark an unmatched transfer ignored (handled outside the panel).
/// Audited `chain_transfer.ignore`.
pub async fn apply_ignore(
    conn: &mut sqlx::PgConnection,
    actor: &Actor,
    id: i64,
    req: &IgnoreReq,
) -> Result<(), ApiError> {
    let reason = reason_of(&req.reason)?;
    let t = lock_open(conn, id).await?;
    sqlx::query(
        "UPDATE chain_transfers SET status = 'ignored', note = $2, \
         confirmed_at = COALESCE(confirmed_at, now()), resolved_at = now(), resolved_by = $3 \
         WHERE id = $1",
    )
    .bind(id)
    .bind(&reason)
    .bind(actor.id)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "chain_transfer.ignore",
        "chain_transfer",
        Some(id.to_string()),
        Some(snapshot(&t)),
        Some(json!({ "status": "ignored", "reason": reason })),
    )
    .await?;
    Ok(())
}

/// POST /payments/chain-transfers/{id}/assign {order_id, reason} (admin).
pub async fn assign(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, i64)>,
    ApiJson(req): ApiJson<AssignReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let r = apply_assign(&mut tx, &Actor::of(&user), id, &req).await?;
    tx.commit().await?;
    Ok(Json(
        json!({ "fulfilled": matches!(r, Paid::Now { fulfilled: true }) }),
    ))
}

/// POST /payments/chain-transfers/{id}/ignore {reason} (admin).
pub async fn ignore(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, i64)>,
    ApiJson(req): ApiJson<IgnoreReq>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_ignore(&mut tx, &Actor::of(&user), id, &req).await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/{prefix}/api/v1/payments/chain-transfers", get(list))
        .route(
            "/{prefix}/api/v1/payments/chain-transfers/{id}/assign",
            post(assign),
        )
        .route(
            "/{prefix}/api/v1/payments/chain-transfers/{id}/ignore",
            post(ignore),
        )
}
