//! Ops: admin-created ("manual") paid orders (migration 0166).
//!
//! `POST /orders/manual {user_id, plan_id, period, gift, reason}`: the
//! admin records a sale made outside the gateway (bank transfer, cash) or a
//! gift. NOT a new pay path: the order row is created exactly like a
//! customer order (snapshots, `list_price_cents` = the period's price read
//! from `plan_period_prices` in SQL — the request never carries an amount)
//! and then paid in the SAME transaction through
//! `orders::apply_mark_paid(…, Via::Manual, …, reason)`, which takes
//! `entitle::lock`, flips the order exactly once, fulfils it under its
//! savepoint and audits. A gift sets `gift_cents` = the list price, so
//! `amount_cents` = 0 and revenue (which sums `amount_cents`) is untouched;
//! a non-gift manual order is revenue, flagged `paid_via = 'manual'`.
//!
//! Unlike a gateway payment, a manual order whose fulfilment fails (plan
//! gone, sold out, reset pack without the plan) is rolled back whole and
//! answered 409 with the reason: nothing was paid through the panel, so
//! there is nothing to keep. No coupon, credit or balance applies.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use super::api::new_out_trade_no;
use super::catalog::PeriodKindText;
use super::orders::{self, Paid, Via};
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::state::AppState;

/// Longest reason (same as other admin money actions).
pub const MAX_REASON: usize = 200;

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct ManualOrderReq {
    pub user_id: Uuid,
    pub plan_id: Uuid,
    pub period: PeriodKindText,
    /// true = a gift: the price is forgiven (amount 0, not revenue).
    #[serde(default)]
    pub gift: bool,
    pub reason: String,
}

/// Validate the reason (pure); returns it trimmed.
pub fn check_reason(reason: &str) -> Result<&str, ApiError> {
    let r = reason.trim();
    if r.is_empty() || r.chars().count() > MAX_REASON || r.chars().any(char::is_control) {
        return Err(bad_request!(
            "request.reason_length",
            "reason must be 1-{max_reason} characters",
            max_reason = MAX_REASON
        ));
    }
    Ok(r)
}

/// Create and pay a manual order in the caller's transaction. Returns the
/// order id. Lock order: entitle (first statement) → orders.
pub async fn apply_create(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &ManualOrderReq,
) -> Result<Uuid, ApiError> {
    let reason = check_reason(&req.reason)?;
    crate::entitle::lock(conn).await?;
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM users WHERE id = $1 FOR KEY SHARE")
            .bind(req.user_id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some(role) = role else {
        return Err(ApiError::not_found());
    };
    if role != "user" {
        return Err(bad_request!(
            "user.admin_no_plan",
            "admin accounts are not proxy users and cannot have a plan"
        ));
    }
    let kind = req.period.0;
    // The price: read here, copied into the order (never from the client).
    let price: Option<(String, Option<i32>, i64)> = sqlx::query_as(
        "SELECT p.name, pp.days, pp.price_cents FROM plans p \
         JOIN plan_period_prices pp ON pp.plan_id = p.id \
         WHERE p.id = $1 AND pp.period = $2",
    )
    .bind(req.plan_id)
    .bind(kind.as_str())
    .fetch_optional(&mut *conn)
    .await?;
    let Some((plan_name, days, list_cents)) = price else {
        return Err(bad_request!(
            "order_admin.no_price",
            "the plan has no price for this period"
        ));
    };
    let gift_cents = if req.gift { list_cents } else { 0 };
    // What it does (stored like a customer order's; 中-2, 低-4).
    let current: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT id, plan_id FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(req.user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let action = super::catalog::action_for(current.map(|c| c.1), req.plan_id, kind);
    let id = Uuid::new_v4();
    let otn = new_out_trade_no();
    let subject: String = format!("Akari - {plan_name}").chars().take(128).collect();
    let r = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO orders (id, out_trade_no, user_id, user_label, plan_id, plan_name, \
         amount_cents, period, period_days, list_price_cents, gift_cents, subject, expires_at, \
         action, prior_user_plan_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7 - $8, $9, $10, $7, $8, $11, now(), $12, $13) \
         RETURNING {}",
        orders::order_snapshot_sql("orders")
    )))
    .bind(id)
    .bind(&otn)
    .bind(req.user_id)
    .bind(crate::audit::user_label(req.user_id))
    .bind(req.plan_id)
    .bind(&plan_name)
    .bind(list_cents)
    .bind(gift_cents)
    .bind(kind.as_str())
    .bind(days)
    .bind(&subject)
    .bind(action.as_str())
    .bind(current.map(|c| c.0))
    .fetch_one(&mut *conn)
    .await;
    let mut after = match r {
        Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
            return Err(conflict!(
                "order_admin.user_has_pending",
                "the user has a pending order; cancel it or wait for it to end"
            ));
        }
        r => r?,
    };
    after["manual"] = json!(true);
    after["gift"] = json!(req.gift);
    after["reason"] = json!(reason);
    crate::audit::record(
        conn,
        actor,
        "order.create",
        "order",
        Some(id.to_string()),
        None,
        Some(after),
    )
    .await?;
    let paid = orders::apply_mark_paid(
        conn,
        actor,
        id,
        Via::Manual,
        None,
        Some(list_cents - gift_cents),
        Some(reason),
    )
    .await?;
    if paid != (Paid::Now { fulfilled: true }) {
        let err: Option<String> =
            sqlx::query_scalar("SELECT fulfil_error FROM orders WHERE id = $1")
                .bind(id)
                .fetch_one(&mut *conn)
                .await?;
        return Err(conflict!(
            "order_admin.manual_not_fulfilled",
            "the plan could not be granted: {error}",
            error = err.unwrap_or_default()
        ));
    }
    orders::record_event(
        conn,
        Some(id),
        Some(&otn),
        "manual",
        true,
        "manual_order",
        None,
        Some(json!({ "reason": reason, "by": actor.label, "gift": req.gift })),
        actor.ip,
    )
    .await?;
    Ok(id)
}

/// POST /orders/manual (admin): 201 + `{id}`.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<ManualOrderReq>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    // A fulfilment failure returns Err: the transaction is dropped (rolled
    // back) with the order, the payment and every audit row.
    let id = apply_create(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}
