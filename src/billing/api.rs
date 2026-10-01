//! Billing HTTP: the user's shop and orders, admin prices and orders, and
//! the Alipay async notify (POST /{prefix}/pay/alipay/notify).
//!
//! The notify endpoint is a public entry behind the same prefix gate as
//! everything else; every refusal (rate limit, payments off, oversized or
//! malformed body, bad signature, foreign app/seller, unknown order, amount
//! mismatch) is the canonical `reject::not_found()` and leaves an event
//! row. Only a verified notify for our order is answered `success`.

use std::collections::BTreeMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::alipay::{self, Alipay};
use super::orders::{self, payment_actor, Paid, Pending, Via};
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, MaybeClientIp};
use crate::state::AppState;

/// Notify body cap (Alipay's are ~1-2 KiB).
const MAX_NOTIFY_BODY: usize = 16 * 1024;
const MAX_NOTIFY_PARAMS: usize = 64;
/// Notifies per source address (/64) per window.
const NOTIFY_RATE: i64 = 120;
const NOTIFY_WINDOW_SECS: i64 = 60;
/// Orders a user may create per hour.
const ORDER_RATE: i64 = 20;
const ORDER_WINDOW_SECS: i64 = 3600;
const MAX_REASON: usize = 500;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/{prefix}/pay/alipay/notify", post(notify))
        .route("/{prefix}/api/v1/me/shop", get(shop))
        .route(
            "/{prefix}/api/v1/me/orders",
            get(my_orders).post(create_order),
        )
        .route("/{prefix}/api/v1/me/orders/{id}", get(my_order))
        .route("/{prefix}/api/v1/me/orders/{id}/cancel", post(cancel_order))
        .route("/{prefix}/api/v1/plan-prices", get(list_prices))
        .route(
            "/{prefix}/api/v1/plans/{id}/price",
            put(set_price).delete(delete_price),
        )
        .route("/{prefix}/api/v1/orders", get(list_orders))
        .route("/{prefix}/api/v1/orders/{id}", get(get_order))
        .route("/{prefix}/api/v1/orders/{id}/fulfil", post(fulfil_order))
}

fn payments_off() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "payments are not enabled")
}

async fn within_limit(state: &AppState, key: String, limit: i64, window: i64) -> bool {
    match crate::rate::hit(state, key, limit, window).await {
        Ok(ok) => ok,
        Err(e) => {
            tracing::warn!(error = %e, "billing rate limit unavailable (failing open)");
            true
        }
    }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// An order as its owner sees it.
#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct MyOrderView {
    id: Uuid,
    out_trade_no: String,
    plan_id: Option<Uuid>,
    plan_name: String,
    amount_cents: i64,
    period_days: i32,
    status: String,
    /// Only while pending.
    qr_code: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    paid_at: Option<DateTime<Utc>>,
    fulfilled: bool,
}

const MY_ORDER_SQL: &str = "SELECT id, out_trade_no, plan_id, plan_name, amount_cents, \
     period_days, status, CASE WHEN status = 'pending' THEN qr_code END AS qr_code, created_at, \
     expires_at, paid_at, fulfilled_at IS NOT NULL AS fulfilled FROM orders";

/// An order as an admin sees it.
#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct OrderView {
    id: Uuid,
    out_trade_no: String,
    user_id: Option<Uuid>,
    user_login: String,
    plan_id: Option<Uuid>,
    plan_name: String,
    amount_cents: i64,
    period_days: i32,
    status: String,
    trade_no: Option<String>,
    paid_via: Option<String>,
    paid_amount_cents: Option<i64>,
    manual_reason: Option<String>,
    fulfilled_at: Option<DateTime<Utc>>,
    fulfil_result: Option<Value>,
    fulfil_error: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    paid_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
    close_state: Option<String>,
}

const ORDER_SQL: &str = "SELECT id, out_trade_no, user_id, user_login, plan_id, plan_name, \
     amount_cents, period_days, status, trade_no, paid_via, paid_amount_cents, manual_reason, \
     fulfilled_at, fulfil_result, fulfil_error, created_at, expires_at, paid_at, ended_at, \
     close_state FROM orders";

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct EventView {
    id: i64,
    source: String,
    verified: bool,
    outcome: String,
    trade_status: Option<String>,
    params: Option<Value>,
    ip: Option<String>,
    created_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// User: shop and orders
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct ShopRow {
    plan_id: Uuid,
    name: String,
    price_cents: i64,
    period_days: i32,
    traffic_quota_bytes: Option<i64>,
    reset_period: String,
    reset_days: Option<i32>,
    speed_limit_mbps: Option<i32>,
}

/// GET /me/shop: purchasable plans with the action buying one would take
/// for the caller ("new" | "renew" | "replace" | "unavailable").
pub async fn shop(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let enabled = state.alipay().is_some() && user.role == "user";
    let mut c = state.pg().acquire().await?;
    let current: Option<(Uuid, String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT up.plan_id, p.name, up.expires_at FROM user_plans up JOIN plans p \
         ON p.id = up.plan_id WHERE up.user_id = $1 AND up.status = 'active'",
    )
    .bind(user.id)
    .fetch_optional(&mut *c)
    .await?;
    let rows: Vec<ShopRow> = if enabled {
        sqlx::query_as(
            "SELECT p.id AS plan_id, p.name, pp.price_cents, pp.period_days, \
             p.traffic_quota_bytes, p.reset_period, p.reset_days, p.speed_limit_mbps \
             FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id \
             WHERE pp.purchasable AND p.enabled ORDER BY p.sort, pp.price_cents, p.name",
        )
        .fetch_all(&mut *c)
        .await?
    } else {
        Vec::new()
    };
    let plans: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            let action = match &current {
                Some((p, _, None)) if *p == r.plan_id => "unavailable",
                Some((p, _, Some(_))) if *p == r.plan_id => "renew",
                Some(_) => "replace",
                None => "new",
            };
            json!({
                "plan_id": r.plan_id,
                "name": r.name,
                "price_cents": r.price_cents,
                "period_days": r.period_days,
                "traffic_quota_bytes": r.traffic_quota_bytes,
                "period": crate::plans::Period::from_columns(&r.reset_period, r.reset_days).render(),
                "speed_limit_mbps": r.speed_limit_mbps,
                "action": action,
            })
        })
        .collect();
    Ok(Json(json!({
        "enabled": enabled,
        "current": current.map(|(id, name, exp)| json!({ "plan_id": id, "name": name, "expires_at": exp })),
        "plans": plans,
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateOrderReq {
    pub plan_id: Uuid,
}

async fn my_order_view(state: &AppState, user: Uuid, id: Uuid) -> Result<MyOrderView, ApiError> {
    sqlx::query_as::<_, MyOrderView>(sqlx::AssertSqlSafe(format!(
        "{MY_ORDER_SQL} WHERE id = $1 AND user_id = $2"
    )))
    .bind(id)
    .bind(user)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)
}

fn new_out_trade_no() -> String {
    let r: [u8; 12] = rand::random();
    format!("AK{}{}", Utc::now().format("%Y%m%d"), hex::encode(r))
}

/// POST /me/orders {plan_id}: create an order at the plan's current price
/// and precreate its QR code. A previous pending order of the user is
/// ended first (queried: if it was paid it is fulfilled instead).
pub async fn create_order(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateOrderReq>,
) -> Result<(StatusCode, Json<MyOrderView>), ApiError> {
    let Some(alipay) = state.alipay().cloned() else {
        return Err(payments_off());
    };
    if user.role != "user" {
        return Err(ApiError::bad_request("admin accounts cannot buy plans"));
    }
    if !within_limit(
        &state,
        format!("akari:rl:order:{}", user.id),
        ORDER_RATE,
        ORDER_WINDOW_SECS,
    )
    .await
    {
        return Err(ApiError::too_many());
    }
    let actor = Actor::of(&user);
    // End the user's open order (one pending per user).
    let open: Option<Pending> = sqlx::query_as(
        "SELECT id, out_trade_no, amount_cents, expires_at, expires_at <= now() AS due \
         FROM orders WHERE user_id = $1 AND status = 'pending'",
    )
    .bind(user.id)
    .fetch_optional(state.pg())
    .await?;
    if let Some(o) = open {
        let st = orders::end_order(&state, &alipay, &o, "cancelled", &actor, false).await?;
        if st == "pending" {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "payment gateway unavailable, try again",
            ));
        }
    }
    let id = Uuid::new_v4();
    let out_trade_no = new_out_trade_no();
    let mut tx = state.pg().begin().await?;
    #[allow(clippy::type_complexity)]
    let price: Option<(
        String,
        i64,
        i32,
        bool,
        Option<(Uuid, Option<DateTime<Utc>>)>,
    )> = sqlx::query_as(
        "SELECT p.name, pp.price_cents, pp.period_days, pp.purchasable AND p.enabled, \
             (SELECT ROW(up.plan_id, up.expires_at) FROM user_plans up \
              WHERE up.user_id = $2 AND up.status = 'active') \
             FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id WHERE pp.plan_id = $1",
    )
    .bind(req.plan_id)
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((plan_name, cents, days, purchasable, active)) = price else {
        return Err(ApiError::bad_request("plan is not for sale"));
    };
    if !purchasable {
        return Err(ApiError::bad_request("plan is not for sale"));
    }
    if matches!(active, Some((p, None)) if p == req.plan_id) {
        return Err(ApiError::conflict(
            "your current plan does not expire; nothing to renew",
        ));
    }
    let subject: String = format!("Akari - {plan_name}").chars().take(128).collect();
    let r = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO orders (id, out_trade_no, user_id, user_login, plan_id, plan_name, \
         amount_cents, period_days, subject, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(mins => $10)) \
         RETURNING {}",
        orders::order_snapshot_sql("orders")
    )))
    .bind(id)
    .bind(&out_trade_no)
    .bind(user.id)
    .bind(&user.login)
    .bind(req.plan_id)
    .bind(&plan_name)
    .bind(cents)
    .bind(days)
    .bind(&subject)
    .bind(alipay.order_timeout_minutes as i32)
    .fetch_one(&mut *tx)
    .await;
    let after = match r {
        Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
            return Err(ApiError::conflict("another order is being created"))
        }
        r => r?,
    };
    crate::audit::record(
        &mut tx,
        &actor,
        "order.create",
        "order",
        Some(id.to_string()),
        None,
        Some(after),
    )
    .await?;
    tx.commit().await?;

    // The row exists before Alipay knows the trade: a payment can never
    // arrive for an order we do not have.
    match alipay.precreate(&out_trade_no, cents, &subject).await {
        Ok(qr) => {
            let mut tx = state.pg().begin().await?;
            sqlx::query("UPDATE orders SET qr_code = $2 WHERE id = $1")
                .bind(id)
                .bind(&qr)
                .execute(&mut *tx)
                .await?;
            orders::record_event(
                &mut tx,
                Some(id),
                Some(&out_trade_no),
                "precreate",
                true,
                "ok",
                None,
                None,
                None,
            )
            .await?;
            tx.commit().await?;
        }
        Err(e) => {
            tracing::warn!(order = %id, error = %e, "alipay precreate failed");
            let mut tx = state.pg().begin().await?;
            let ended: Option<(Value, Value)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "UPDATE orders SET status = 'cancelled', ended_at = now(), \
                 close_state = 'precreate_failed' WHERE id = $1 AND status = 'pending' \
                 RETURNING {}, {}",
                orders::order_snapshot_sql("old"),
                orders::order_snapshot_sql("new"),
            )))
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            orders::record_event(
                &mut tx,
                Some(id),
                Some(&out_trade_no),
                "precreate",
                true,
                "failed",
                None,
                Some(json!({ "error": e.to_string() })),
                None,
            )
            .await?;
            if let Some((before, after)) = ended {
                crate::audit::record(
                    &mut tx,
                    &actor,
                    "order.cancel",
                    "order",
                    Some(id.to_string()),
                    Some(before),
                    Some(after),
                )
                .await?;
            }
            tx.commit().await?;
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "payment gateway unavailable, try again",
            ));
        }
    }
    Ok((
        StatusCode::CREATED,
        Json(my_order_view(&state, user.id, id).await?),
    ))
}

/// GET /me/orders: the caller's last 50 orders.
pub async fn my_orders(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<MyOrderView>>, ApiError> {
    let rows = sqlx::query_as::<_, MyOrderView>(sqlx::AssertSqlSafe(format!(
        "{MY_ORDER_SQL} WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50"
    )))
    .bind(user.id)
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// GET /me/orders/{id}: status polling. A pending order is actively
/// queried at Alipay (throttled per order across instances), so payment
/// is detected even when the notify cannot reach the panel.
pub async fn my_order(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<MyOrderView>, ApiError> {
    let view = my_order_view(&state, user.id, id).await?;
    if view.status == "pending" {
        if let Some(a) = state.alipay().cloned() {
            orders::poll(&state, &a, id).await?;
            return Ok(Json(my_order_view(&state, user.id, id).await?));
        }
    }
    Ok(Json(view))
}

/// POST /me/orders/{id}/cancel: end a pending order (queried first; if it
/// was paid meanwhile it is fulfilled and returned as paid).
pub async fn cancel_order(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<MyOrderView>, ApiError> {
    let Some(alipay) = state.alipay().cloned() else {
        return Err(payments_off());
    };
    let open: Option<Pending> = sqlx::query_as(
        "SELECT id, out_trade_no, amount_cents, expires_at, expires_at <= now() AS due \
         FROM orders WHERE id = $1 AND user_id = $2 AND status = 'pending'",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(state.pg())
    .await?;
    let Some(o) = open else {
        my_order_view(&state, user.id, id).await?;
        return Err(ApiError::conflict("order is not pending"));
    };
    let st = orders::end_order(&state, &alipay, &o, "cancelled", &Actor::of(&user), false).await?;
    if st == "pending" {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "payment gateway unavailable, try again",
        ));
    }
    Ok(Json(my_order_view(&state, user.id, id).await?))
}

// ---------------------------------------------------------------------------
// Admin: prices
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
struct PriceRow {
    plan_id: Uuid,
    plan_name: String,
    plan_enabled: bool,
    price_cents: Option<i64>,
    period_days: Option<i32>,
    purchasable: bool,
    updated_at: Option<DateTime<Utc>>,
}

/// GET /plan-prices: every plan with its price (null = not priced).
pub async fn list_prices(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let rows: Vec<PriceRow> = sqlx::query_as(
        "SELECT p.id AS plan_id, p.name AS plan_name, p.enabled AS plan_enabled, \
         pp.price_cents, pp.period_days, COALESCE(pp.purchasable, false) AS purchasable, \
         pp.updated_at FROM plans p LEFT JOIN plan_prices pp ON pp.plan_id = p.id \
         ORDER BY p.sort, p.name",
    )
    .fetch_all(state.pg())
    .await?;
    Ok(Json(json!({
        "payments_enabled": state.alipay().is_some(),
        "prices": rows,
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetPriceReq {
    pub price_cents: i64,
    pub period_days: i32,
    pub purchasable: bool,
}

/// PUT /plans/{id}/price. Existing orders keep the price they were created
/// with.
pub async fn apply_set_price(
    conn: &mut sqlx::PgConnection,
    actor: &Actor,
    plan_id: Uuid,
    req: &SetPriceReq,
) -> Result<(), ApiError> {
    if !(1..=100_000_000).contains(&req.price_cents) {
        return Err(ApiError::bad_request(
            "price_cents must be 1..=100000000 (integer cents)",
        ));
    }
    if !(1..=3650).contains(&req.period_days) {
        return Err(ApiError::bad_request("period_days must be 1..=3650"));
    }
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM plans WHERE id = $1")
        .bind(plan_id)
        .fetch_optional(&mut *conn)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found());
    }
    let snap = "jsonb_build_object('price_cents', price_cents, 'period_days', period_days, \
                'purchasable', purchasable)";
    let before: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {snap} FROM plan_prices WHERE plan_id = $1 FOR UPDATE"
    )))
    .bind(plan_id)
    .fetch_optional(&mut *conn)
    .await?;
    let after: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "INSERT INTO plan_prices (plan_id, price_cents, period_days, purchasable) \
         VALUES ($1, $2, $3, $4) ON CONFLICT (plan_id) DO UPDATE SET \
         price_cents = EXCLUDED.price_cents, period_days = EXCLUDED.period_days, \
         purchasable = EXCLUDED.purchasable, updated_at = now() RETURNING {snap}"
    )))
    .bind(plan_id)
    .bind(req.price_cents)
    .bind(req.period_days)
    .bind(req.purchasable)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "plan.price.set",
        "plan",
        Some(plan_id.to_string()),
        before,
        Some(after),
    )
    .await?;
    Ok(())
}

pub async fn set_price(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<SetPriceReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_set_price(&mut tx, &Actor::of(&user), id, &req).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_price(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let before: Option<Value> = sqlx::query_scalar(
        "DELETE FROM plan_prices WHERE plan_id = $1 RETURNING jsonb_build_object(\
         'price_cents', price_cents, 'period_days', period_days, 'purchasable', purchasable)",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(before) = before else {
        return Err(ApiError::not_found());
    };
    crate::audit::record(
        &mut tx,
        &Actor::of(&user),
        "plan.price.delete",
        "plan",
        Some(id.to_string()),
        Some(before),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Admin: orders
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListOrdersQuery {
    pub status: Option<String>,
    pub login: Option<String>,
    pub out_trade_no: Option<String>,
    /// Keyset cursor: orders older than this order id.
    pub before: Option<Uuid>,
    pub limit: Option<i64>,
    /// true = paid but not fulfilled (needs attention).
    pub unfulfilled: Option<bool>,
}

pub async fn list_orders(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListOrdersQuery>,
) -> Result<Json<Vec<OrderView>>, ApiError> {
    user.require_admin()?;
    if let Some(s) = &q.status {
        if !matches!(s.as_str(), "pending" | "paid" | "expired" | "cancelled") {
            return Err(ApiError::bad_request("unknown status"));
        }
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let mut qb = sqlx::QueryBuilder::new(format!("{ORDER_SQL} WHERE true"));
    if let Some(s) = &q.status {
        qb.push(" AND status = ").push_bind(s.clone());
    }
    if let Some(l) = q.login.as_deref().filter(|l| !l.is_empty()) {
        qb.push(" AND user_login = ").push_bind(l.to_string());
    }
    if let Some(o) = q.out_trade_no.as_deref().filter(|o| !o.is_empty()) {
        qb.push(" AND (out_trade_no = ")
            .push_bind(o.to_string())
            .push(" OR trade_no = ")
            .push_bind(o.to_string())
            .push(")");
    }
    if q.unfulfilled == Some(true) {
        qb.push(" AND status = 'paid' AND fulfilled_at IS NULL");
    }
    if let Some(b) = q.before {
        qb.push(" AND (created_at, id) < (SELECT created_at, id FROM orders WHERE id = ")
            .push_bind(b)
            .push(")");
    }
    qb.push(" ORDER BY created_at DESC, id DESC LIMIT ")
        .push_bind(limit);
    let rows = qb
        .build_query_as::<OrderView>()
        .fetch_all(state.pg())
        .await?;
    Ok(Json(rows))
}

pub async fn get_order(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let order =
        sqlx::query_as::<_, OrderView>(sqlx::AssertSqlSafe(format!("{ORDER_SQL} WHERE id = $1")))
            .bind(id)
            .fetch_optional(state.pg())
            .await?
            .ok_or_else(ApiError::not_found)?;
    let events: Vec<EventView> = sqlx::query_as(
        "SELECT id, source, verified, outcome, trade_status, params, ip, created_at \
         FROM payment_events WHERE order_id = $1 ORDER BY id LIMIT 500",
    )
    .bind(id)
    .fetch_all(state.pg())
    .await?;
    Ok(Json(json!({ "order": order, "events": events })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FulfilReq {
    pub reason: String,
}

/// POST /orders/{id}/fulfil {reason}: support action — mark an unpaid
/// order paid (manual) or retry a failed fulfilment. Audited with reason.
pub async fn fulfil_order(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<FulfilReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let reason = req.reason.trim();
    if reason.is_empty() || reason.chars().count() > MAX_REASON {
        return Err(ApiError::bad_request(format!(
            "reason must be 1-{MAX_REASON} characters"
        )));
    }
    let mut tx = state.pg().begin().await?;
    let r = orders::apply_admin_fulfil(&mut tx, &Actor::of(&user), id, reason).await?;
    tx.commit().await?;
    let fulfilled = matches!(r, Paid::Now { fulfilled: true });
    Ok(Json(json!({ "fulfilled": fulfilled })))
}

// ---------------------------------------------------------------------------
// Alipay async notify
// ---------------------------------------------------------------------------

/// Notify params for the event log: the signature replaced by a marker,
/// values capped.
fn redacted_params(p: &BTreeMap<String, String>) -> Value {
    let mut m = serde_json::Map::new();
    for (k, v) in p.iter().take(MAX_NOTIFY_PARAMS) {
        let v = if k == "sign" {
            "<redacted>".to_string()
        } else {
            v.chars().take(256).collect()
        };
        m.insert(k.chars().take(64).collect(), Value::String(v));
    }
    Value::Object(m)
}

/// Decode a form body; None on duplicates, too many params or non-UTF-8.
fn parse_form(body: &[u8]) -> Option<BTreeMap<String, String>> {
    std::str::from_utf8(body).ok()?;
    let mut out = BTreeMap::new();
    for (k, v) in form_urlencoded::parse(body) {
        if out.len() >= MAX_NOTIFY_PARAMS || out.insert(k.into_owned(), v.into_owned()).is_some() {
            return None;
        }
    }
    Some(out)
}

/// POST /{prefix}/pay/alipay/notify.
pub async fn notify(
    State(state): State<AppState>,
    MaybeClientIp(ip): MaybeClientIp,
    body: Bytes,
) -> Response {
    if let Some(addr) = ip {
        let key = format!("akari:rl:paynotify:{}", crate::client_ip::bucket(addr));
        if !within_limit(&state, key, NOTIFY_RATE, NOTIFY_WINDOW_SECS).await {
            return crate::reject::not_found();
        }
    }
    let Some(alipay) = state.alipay().cloned() else {
        return crate::reject::not_found();
    };
    match handle_notify(&state, &alipay, ip, &body).await {
        Ok(true) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "success",
        )
            .into_response(),
        Ok(false) => crate::reject::not_found(),
        Err(e) => {
            tracing::warn!(error = e.message(), "alipay notify failed");
            crate::reject::not_found()
        }
    }
}

/// Ok(true) = acknowledge ("success"); Ok(false) = refuse. Every outcome
/// leaves a payment_events row.
pub async fn handle_notify(
    state: &AppState,
    alipay: &Alipay,
    ip: Option<std::net::IpAddr>,
    body: &[u8],
) -> Result<bool, ApiError> {
    let mut c = state.pg().acquire().await?;
    if body.len() > MAX_NOTIFY_BODY {
        orders::record_event(
            &mut c,
            None,
            None,
            "notify",
            false,
            "oversized",
            None,
            None,
            ip,
        )
        .await?;
        return Ok(false);
    }
    let Some(p) = parse_form(body) else {
        orders::record_event(
            &mut c,
            None,
            None,
            "notify",
            false,
            "malformed",
            None,
            None,
            ip,
        )
        .await?;
        return Ok(false);
    };
    let otn = p.get("out_trade_no").cloned();
    let status = p.get("trade_status").cloned();
    let params = redacted_params(&p);
    if !alipay::verify_notify(alipay.keys(), &p) {
        orders::record_event(
            &mut c,
            None,
            otn.as_deref(),
            "notify",
            false,
            "bad_signature",
            status.as_deref(),
            Some(params),
            ip,
        )
        .await?;
        return Ok(false);
    }
    let order: Option<(Uuid, i64)> =
        sqlx::query_as("SELECT id, amount_cents FROM orders WHERE out_trade_no = $1")
            .bind(otn.as_deref().unwrap_or_default())
            .fetch_optional(&mut *c)
            .await?;
    let problem = if p.get("app_id") != Some(&alipay.app_id) {
        Some("app_id_mismatch")
    } else if alipay
        .seller_id
        .as_ref()
        .is_some_and(|s| p.get("seller_id") != Some(s))
    {
        Some("seller_id_mismatch")
    } else if order.is_none() {
        Some("unknown_order")
    } else if p.get("total_amount").and_then(|a| alipay::parse_amount(a)) != order.map(|o| o.1) {
        Some("amount_mismatch")
    } else {
        None
    };
    let order_id = order.map(|o| o.0);
    if let Some(reason) = problem {
        let mut tx = c.begin_tx().await?;
        orders::record_event(
            &mut tx,
            order_id,
            otn.as_deref(),
            "notify",
            true,
            reason,
            status.as_deref(),
            Some(params),
            ip,
        )
        .await?;
        if let Some(id) = order_id {
            crate::audit::record(
                &mut tx,
                &payment_actor(ip),
                "order.payment.rejected",
                "order",
                Some(id.to_string()),
                None,
                Some(json!({ "reason": reason, "source": "notify" })),
            )
            .await?;
        }
        tx.commit().await?;
        tracing::warn!(reason, "alipay notify refused");
        return Ok(false);
    }
    let Some((order_id, amount)) = order else {
        return Ok(false);
    };
    let paid = matches!(status.as_deref(), Some("TRADE_SUCCESS" | "TRADE_FINISHED"));
    let mut tx = c.begin_tx().await?;
    let outcome = if paid {
        let r = orders::apply_mark_paid(
            &mut tx,
            &payment_actor(ip),
            order_id,
            Via::Notify,
            p.get("trade_no").map(String::as_str),
            Some(amount),
            None,
        )
        .await?;
        match r {
            Paid::Already => "duplicate",
            Paid::Now { fulfilled: true } => "paid",
            Paid::Now { fulfilled: false } => "paid_unfulfilled",
        }
    } else {
        "ignored"
    };
    orders::record_event(
        &mut tx,
        Some(order_id),
        otn.as_deref(),
        "notify",
        true,
        outcome,
        status.as_deref(),
        Some(params),
        ip,
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}

/// `begin` on a pooled connection.
trait BeginTx {
    async fn begin_tx(&mut self) -> sqlx::Result<sqlx::Transaction<'_, sqlx::Postgres>>;
}

impl BeginTx for sqlx::pool::PoolConnection<sqlx::Postgres> {
    async fn begin_tx(&mut self) -> sqlx::Result<sqlx::Transaction<'_, sqlx::Postgres>> {
        use sqlx::Connection;
        (**self).begin().await
    }
}
