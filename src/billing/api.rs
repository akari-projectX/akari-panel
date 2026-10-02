//! Billing HTTP: the user's shop and orders, admin prices and orders, and
//! the Alipay async notify (POST /{prefix}/pay/alipay/notify).
//!
//! The notify endpoint is a public entry behind the same prefix gate as
//! everything else; every refusal (rate limit, payments off, oversized or
//! malformed body, bad signature, foreign app/seller, unknown order, amount
//! mismatch) is the canonical `reject::not_found()` and leaves an event
//! row. Only a verified notify for our order is answered `success`.

use crate::auth::{bad_request, conflict};
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
use super::catalog::{self, Current, Offer, PeriodKind, PeriodKindText, Price, Sale};
use super::orders::{self, payment_actor, Paid, Pending, Via};
use super::{commission, coupons, ledger};
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, MaybeClientIp, ShopUser};
use crate::state::AppState;

/// Notify body cap (Alipay's are ~1-2 KiB).
const MAX_NOTIFY_BODY: usize = 16 * 1024;
pub(crate) const MAX_NOTIFY_PARAMS: usize = 64;
/// Notifies per source address (/64) per window.
const NOTIFY_RATE: i64 = 120;
const NOTIFY_WINDOW_SECS: i64 = 60;
/// Orders a user may create per hour.
const ORDER_RATE: i64 = 20;
const ORDER_WINDOW_SECS: i64 = 3600;
const MAX_REASON: usize = 500;
/// Shop previews with a coupon code per user per window (code guessing).
const COUPON_RATE: i64 = 30;
const COUPON_WINDOW_SECS: i64 = 600;

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
        .route("/{prefix}/api/v1/plan-prices", get(catalog::list_prices))
        .route(
            "/{prefix}/api/v1/plans/{id}/prices",
            put(catalog::set_prices),
        )
        .route("/{prefix}/api/v1/orders", get(list_orders))
        .route("/{prefix}/api/v1/orders/{id}", get(get_order))
        .route("/{prefix}/api/v1/orders/{id}/fulfil", post(fulfil_order))
        .route("/{prefix}/api/v1/orders/{id}/refund", post(refund_order))
        // W16: balance, coupons, invite commission, withdrawals.
        .route("/{prefix}/api/v1/me/balance", get(ledger::my_balance))
        .route("/{prefix}/api/v1/me/invite", get(commission::my_invite))
        .route(
            "/{prefix}/api/v1/me/withdrawals",
            get(commission::my_withdrawals).post(commission::request_withdrawal),
        )
        .route(
            "/{prefix}/api/v1/me/withdrawals/{id}/cancel",
            post(commission::cancel_withdrawal),
        )
        .route(
            "/{prefix}/api/v1/coupons",
            get(coupons::list).post(coupons::create),
        )
        .route(
            "/{prefix}/api/v1/coupons/{id}",
            get(coupons::get)
                .patch(coupons::update)
                .delete(coupons::delete),
        )
        .route("/{prefix}/api/v1/balances", get(ledger::list_balances))
        .route(
            "/{prefix}/api/v1/users/{id}/balance",
            get(ledger::user_balance).post(ledger::adjust),
        )
        .route(
            "/{prefix}/api/v1/commissions",
            get(commission::list_commissions),
        )
        .route(
            "/{prefix}/api/v1/commission-settings",
            get(commission::get_settings).put(commission::put_settings),
        )
        .route(
            "/{prefix}/api/v1/withdrawals",
            get(commission::list_withdrawals),
        )
        .route(
            "/{prefix}/api/v1/withdrawals/{id}/approve",
            post(commission::approve_withdrawal),
        )
        .route(
            "/{prefix}/api/v1/withdrawals/{id}/reject",
            post(commission::reject_withdrawal),
        )
}

fn gateway_unavailable() -> ApiError {
    crate::auth::api_error!(
        BAD_GATEWAY,
        "order.gateway_unavailable",
        "payment gateway unavailable, try again"
    )
}

fn payments_off() -> ApiError {
    crate::auth::api_error!(
        SERVICE_UNAVAILABLE,
        "order.payments_off",
        "payments are not enabled"
    )
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
    /// W7: the period kind bought (catalog::PeriodKind) and its days
    /// (days/onetime only), the list price and the proration credit.
    period: String,
    period_days: Option<i32>,
    list_price_cents: i64,
    credit_cents: i64,
    /// W16: coupon discount (and its code), balance part, refund.
    discount_cents: i64,
    coupon_code: Option<String>,
    balance_cents: i64,
    refunded_at: Option<DateTime<Utc>>,
    status: String,
    /// Only while pending.
    qr_code: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    paid_at: Option<DateTime<Utc>>,
    fulfilled: bool,
}

const MY_ORDER_SQL: &str = "SELECT id, out_trade_no, plan_id, plan_name, amount_cents, \
     period, period_days, list_price_cents, credit_cents, discount_cents, coupon_code, \
     balance_cents, refunded_at, status, CASE WHEN status = 'pending' THEN qr_code END AS qr_code, created_at, \
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
    period: String,
    period_days: Option<i32>,
    list_price_cents: i64,
    credit_cents: i64,
    credit_order_id: Option<Uuid>,
    discount_cents: i64,
    coupon_id: Option<Uuid>,
    coupon_code: Option<String>,
    balance_cents: i64,
    balance_state: String,
    refunded_at: Option<DateTime<Utc>>,
    refund_cents: Option<i64>,
    refund_reason: Option<String>,
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
     amount_cents, period, period_days, list_price_cents, credit_cents, credit_order_id, \
     discount_cents, coupon_id, coupon_code, balance_cents, balance_state, refunded_at, \
     refund_cents, refund_reason, status, trade_no, paid_via, paid_amount_cents, manual_reason, \
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
struct ShopPlanRow {
    plan_id: Uuid,
    name: String,
    description: String,
    traffic_quota_bytes: Option<i64>,
    reset_period: String,
    reset_days: Option<i32>,
    speed_limit_mbps: Option<i32>,
    device_seats: Option<i32>,
    capacity: Option<i32>,
    renewal_only: bool,
    allow_switch_in: bool,
    active: i64,
}

#[derive(sqlx::FromRow)]
struct PriceRow {
    plan_id: Uuid,
    period: String,
    days: Option<i32>,
    price_cents: i64,
}

fn price_of(r: &PriceRow) -> Option<Price> {
    Some(Price {
        period: PeriodKindText(PeriodKind::parse(&r.period)?),
        days: r.days,
        price_cents: r.price_cents,
    })
}

const SALE_PLAN_SQL: &str = "SELECT p.id AS plan_id, p.name, p.description, \
     p.traffic_quota_bytes, p.reset_period, p.reset_days, p.speed_limit_mbps, p.device_seats, \
     p.capacity, p.renewal_only, p.allow_switch_in, \
     (SELECT count(*) FROM user_plans up WHERE up.plan_id = p.id AND up.status = 'active') \
     AS active FROM plans p WHERE p.enabled AND p.on_sale";

#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct ShopQuery {
    /// W16: price every offer with this coupon code.
    pub coupon: Option<String>,
    /// W16: show the balance part as if paying with the balance.
    pub use_balance: Option<bool>,
}

/// GET /me/shop[?coupon=CODE&use_balance=true]: the plans on sale with
/// every priced period as the caller would buy it now (action, coupon
/// discount, credit, balance part, amount — or why not), the caller's
/// subscription, the credit it is worth when switching, and the balance.
/// The money split is computed in SQL (`akari_split`), the same as at
/// order creation.
///
/// The user-side shop/order handlers take `ShopUser` (R21 renewal scope):
/// expired and quota-disabled accounts must be able to buy and pay. They
/// reveal and grant no proxy access themselves (fulfilment applies the plan).
pub async fn shop(
    State(state): State<AppState>,
    ShopUser { user, .. }: ShopUser,
    Query(q): Query<ShopQuery>,
) -> Result<Json<Value>, ApiError> {
    let enabled = state.alipay().is_some() && user.role == "user";
    let code = q.coupon.as_deref().map(str::trim).filter(|c| !c.is_empty());
    if code.is_some()
        && !within_limit(
            &state,
            format!("akari:rl:coupon:{}", user.id),
            COUPON_RATE,
            COUPON_WINDOW_SECS,
        )
        .await
    {
        return Err(ApiError::too_many());
    }
    let mut c = state.pg().acquire().await?;
    let current = catalog::current(&mut c, user.id).await?;
    let (credit, _) = catalog::switch_credit(&mut c, user.id).await?;
    let balance = ledger::balance(&mut c, user.id).await?;
    let (rows, prices): (Vec<ShopPlanRow>, Vec<PriceRow>) = if enabled {
        (
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "{SALE_PLAN_SQL} ORDER BY p.sort, p.name"
            )))
            .fetch_all(&mut *c)
            .await?,
            sqlx::query_as(
                "SELECT pp.plan_id, pp.period, pp.days, pp.price_cents FROM plan_period_prices pp \
                 JOIN plans p ON p.id = pp.plan_id WHERE p.enabled AND p.on_sale \
                 ORDER BY array_position(ARRAY['month', 'quarter', 'half_year', 'year', \
                 'two_year', 'three_year', 'days', 'onetime', 'reset'], pp.period)",
            )
            .fetch_all(&mut *c)
            .await?,
        )
    } else {
        (Vec::new(), Vec::new())
    };
    let cur = current.as_ref().map(|(id, _, exp)| Current {
        plan_id: *id,
        expires: exp.is_some(),
    });
    let mut plans: Vec<(ShopPlanRow, Vec<Offer>)> = Vec::new();
    for r in rows {
        let holder = cur.is_some_and(|c| c.plan_id == r.plan_id);
        // Renewal-only plans are invisible to everybody but their holders.
        if r.renewal_only && !holder {
            continue;
        }
        let sale = Sale {
            plan_id: r.plan_id,
            for_sale: true,
            capacity: r.capacity,
            active: r.active,
            renewal_only: r.renewal_only,
            allow_switch_in: r.allow_switch_in,
        };
        let offers: Vec<Offer> = prices
            .iter()
            .filter(|p| p.plan_id == r.plan_id)
            .filter_map(price_of)
            .filter(|p| holder || p.period.0 != PeriodKind::Reset)
            .map(|p| Offer::of(cur, &sale, &p))
            .collect();
        if !offers.is_empty() {
            plans.push((r, offers));
        }
    }
    // The coupon against every sellable offer, then the split, both in SQL.
    let sellable: Vec<(usize, usize)> = plans
        .iter()
        .enumerate()
        .flat_map(|(i, (_, o))| {
            o.iter()
                .enumerate()
                .filter(|(_, x)| x.action.is_some())
                .map(move |(j, _)| (i, j))
        })
        .collect();
    let mut coupon_view = Value::Null;
    let mut checked: Vec<Option<coupons::Checked>> = vec![None; sellable.len()];
    if let Some(raw) = code {
        match coupons::normalize_code(raw) {
            None => {
                coupon_view = json!({ "code": raw.chars().take(64).collect::<String>(),
                                      "refusal": coupons::Refusal::Invalid });
            }
            Some(code) => {
                let items: Vec<coupons::Item> = sellable
                    .iter()
                    .map(|&(i, j)| coupons::Item {
                        plan_id: plans[i].0.plan_id,
                        period: plans[i].1[j].period.as_str(),
                        list_cents: plans[i].1[j].price_cents,
                    })
                    .collect();
                let res = coupons::check(&mut c, user.id, &code, &items).await?;
                // Refusals that are not about one offer apply to the code.
                let global = res.first().and_then(|r| r.refusal).filter(|r| {
                    !matches!(
                        r,
                        coupons::Refusal::Plan
                            | coupons::Refusal::Period
                            | coupons::Refusal::BelowMinimum
                    )
                });
                let stored = res.first().and_then(|r| r.code.clone()).unwrap_or(code);
                coupon_view = json!({ "code": stored, "refusal": global });
                checked = res.into_iter().map(Some).collect();
            }
        }
    }
    let use_balance = q.use_balance.unwrap_or(false);
    let input: Vec<catalog::SplitIn> = sellable
        .iter()
        .zip(&checked)
        .map(|(&(i, j), ch)| {
            let o = &plans[i].1[j];
            (
                o.price_cents,
                ch.as_ref().map_or(0, |c| c.discount_cents),
                o.credit_available(credit),
                if use_balance { balance } else { 0 },
            )
        })
        .collect();
    let split = catalog::splits(&mut c, &input).await?;
    for ((&(i, j), ch), s) in sellable.iter().zip(&checked).zip(&split) {
        let o = &mut plans[i].1[j];
        let avail = o.credit_available(credit);
        o.priced(s, avail);
        o.coupon_refusal = ch.as_ref().and_then(|c| c.refusal);
    }
    let plans: Vec<Value> = plans
        .into_iter()
        .map(|(r, offers)| {
            let holder = cur.is_some_and(|c| c.plan_id == r.plan_id);
            let remaining = r.capacity.map(|c| (i64::from(c) - r.active).max(0));
            json!({
                "plan_id": r.plan_id,
                "name": r.name,
                "description": r.description,
                "traffic_quota_bytes": r.traffic_quota_bytes,
                "period": crate::plans::Period::from_columns(&r.reset_period, r.reset_days).render(),
                "speed_limit_mbps": r.speed_limit_mbps,
                "device_seats": r.device_seats,
                "current": holder,
                "remaining": remaining,
                "sold_out": !holder && remaining == Some(0),
                "offers": offers,
            })
        })
        .collect();
    Ok(Json(json!({
        "enabled": enabled,
        "current": current.map(|(id, name, exp)| json!({ "plan_id": id, "name": name, "expires_at": exp })),
        "credit_cents": credit,
        "balance_cents": balance,
        "coupon": coupon_view,
        "plans": plans,
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateOrderReq {
    pub plan_id: Uuid,
    /// catalog::PeriodKind ("month", ..., "reset").
    pub period: PeriodKindText,
    /// W16: a coupon code (any case).
    #[serde(default)]
    pub coupon: Option<String>,
    /// W16: cover what is left with the balance (as much as it holds).
    #[serde(default)]
    pub use_balance: bool,
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

/// POST /me/orders {plan_id, period}: create an order at the server's
/// price for that period (minus the proration credit when switching
/// plans, catalog.rs) and precreate its QR code. A previous pending order
/// of the user is ended first (queried: if it was paid it is fulfilled
/// instead). An order the credit pays in full is paid at creation (same
/// apply_mark_paid path, paid_via 'credit') and never reaches Alipay.
pub async fn create_order(
    State(state): State<AppState>,
    ShopUser { user, .. }: ShopUser,
    ApiJson(req): ApiJson<CreateOrderReq>,
) -> Result<(StatusCode, Json<MyOrderView>), ApiError> {
    let Some(alipay) = state.alipay().cloned() else {
        return Err(payments_off());
    };
    if user.role != "user" {
        return Err(bad_request!(
            "shop.admin_cannot_buy",
            "admin accounts cannot buy plans"
        ));
    }
    // Before any order row exists: without a notify URL Alipay could never
    // tell us about the payment (polling would, but an order we cannot be
    // notified about is a configuration error, not a degraded mode).
    let Some(notify_url) = super::notify_url(&state, &alipay) else {
        tracing::warn!(
            "order refused: payments.alipay.notify_url is empty and no main domain is set \
             (系统设置 or install.public_url)"
        );
        return Err(payments_off());
    };
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
            return Err(gateway_unavailable());
        }
    }
    let kind = req.period.0;
    let id = Uuid::new_v4();
    let out_trade_no = new_out_trade_no();
    let mut tx = state.pg().begin().await?;
    // W16 lock order: entitle::lock first (apply_mark_paid, which a fully
    // covered order calls below, starts with it), then the coupon row,
    // then the balance row.
    crate::entitle::lock(&mut tx).await?;
    let plan: Option<ShopPlanRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SALE_PLAN_SQL} AND p.id = $1"
    )))
    .bind(req.plan_id)
    .fetch_optional(&mut *tx)
    .await?;
    let price: Option<PriceRow> = sqlx::query_as(
        "SELECT plan_id, period, days, price_cents FROM plan_period_prices \
         WHERE plan_id = $1 AND period = $2",
    )
    .bind(req.plan_id)
    .bind(kind.as_str())
    .fetch_optional(&mut *tx)
    .await?;
    let (Some(plan), Some(price)) = (plan, price.as_ref().and_then(price_of)) else {
        return Err(catalog::Refusal::NotForSale.error());
    };
    let current = catalog::current(&mut tx, user.id).await?;
    let cur = current.as_ref().map(|(id, _, exp)| Current {
        plan_id: *id,
        expires: exp.is_some(),
    });
    let sale = Sale {
        plan_id: plan.plan_id,
        for_sale: true,
        capacity: plan.capacity,
        active: plan.active,
        renewal_only: plan.renewal_only,
        allow_switch_in: plan.allow_switch_in,
    };
    let action = catalog::decide(cur, &sale, kind).map_err(|r| r.error())?;
    let (credit, credit_order) = if action == catalog::Action::Switch {
        catalog::switch_credit(&mut tx, user.id).await?
    } else {
        (0, None)
    };
    // The coupon: locked, then every rule re-checked under the lock (the
    // reservation below cannot then lose a race).
    let coupon = match req
        .coupon
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        None => None,
        Some(raw) => {
            let code =
                coupons::normalize_code(raw).ok_or_else(|| coupons::Refusal::Invalid.error())?;
            coupons::lock(&mut tx, &code)
                .await?
                .ok_or_else(|| coupons::Refusal::Invalid.error())?;
            let item = coupons::Item {
                plan_id: plan.plan_id,
                period: kind.as_str(),
                list_cents: price.price_cents,
            };
            let ch = coupons::check(&mut tx, user.id, &code, &[item])
                .await?
                .pop()
                .ok_or_else(|| anyhow::anyhow!("coupon check returned no row"))?;
            if let Some(r) = ch.refusal {
                return Err(r.error());
            }
            Some(ch)
        }
    };
    let available = if req.use_balance {
        ledger::lock_balance(&mut tx, user.id).await?
    } else {
        0
    };
    let split = catalog::splits(
        &mut tx,
        &[(
            price.price_cents,
            coupon.as_ref().map_or(0, |c| c.discount_cents),
            credit,
            available,
        )],
    )
    .await?
    .pop()
    .ok_or_else(|| anyhow::anyhow!("akari_split returned no row"))?;
    let credit_order = credit_order.filter(|_| split.credit_cents > 0);
    // A coupon that discounts nothing here (1% of a few fen) is not used.
    let coupon = coupon.filter(|_| split.discount_cents > 0);
    let subject: String = format!("Akari - {}", plan.name).chars().take(128).collect();
    let r = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO orders (id, out_trade_no, user_id, user_login, plan_id, plan_name, \
         amount_cents, period, period_days, list_price_cents, credit_cents, credit_order_id, \
         discount_cents, coupon_id, coupon_code, balance_cents, balance_state, \
         subject, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, \
                 CASE WHEN $16 > 0 THEN 'held' ELSE 'none' END, $17, \
                 now() + make_interval(mins => $18)) \
         RETURNING {}",
        orders::order_snapshot_sql("orders")
    )))
    .bind(id)
    .bind(&out_trade_no)
    .bind(user.id)
    .bind(&user.login)
    .bind(req.plan_id)
    .bind(&plan.name)
    .bind(split.amount_cents)
    .bind(kind.as_str())
    .bind(price.days)
    .bind(price.price_cents)
    .bind(split.credit_cents)
    .bind(credit_order)
    .bind(split.discount_cents)
    .bind(coupon.as_ref().and_then(|c| c.coupon_id))
    .bind(coupon.as_ref().and_then(|c| c.code.clone()))
    .bind(split.balance_cents)
    .bind(&subject)
    .bind(alipay.order_timeout_minutes as i32)
    .fetch_one(&mut *tx)
    .await;
    let mut after = match r {
        Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
            return Err(conflict!(
                "order.in_progress",
                "another order is being created"
            ))
        }
        r => r?,
    };
    if let Some(c) = &coupon {
        let cid = c
            .coupon_id
            .ok_or_else(|| anyhow::anyhow!("checked coupon without id"))?;
        coupons::reserve(&mut tx, cid, id, user.id, split.discount_cents).await?;
    }
    if split.balance_cents > 0 {
        let mut e = ledger::Entry::new(user.id, ledger::Kind::OrderPayment, -split.balance_cents);
        e.order_id = Some(id);
        ledger::apply_entry(&mut tx, &actor, &e).await?;
    }
    after["action"] = json!(action.as_str());
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
    let cents = split.amount_cents;
    if cents == 0 {
        // Fully covered (balance, credit or coupon): the one pay path, in
        // this transaction; never sent to Alipay.
        let via = if split.balance_cents > 0 {
            Via::Balance
        } else if split.credit_cents > 0 {
            Via::Credit
        } else {
            Via::Coupon
        };
        orders::apply_mark_paid(&mut tx, &actor, id, via, None, Some(0), None).await?;
        tx.commit().await?;
        return Ok((
            StatusCode::CREATED,
            Json(my_order_view(&state, user.id, id).await?),
        ));
    }
    tx.commit().await?;

    // The row exists before Alipay knows the trade: a payment can never
    // arrive for an order we do not have.
    match alipay
        .precreate(&notify_url, &out_trade_no, cents, &subject)
        .await
    {
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
            let released = if ended.is_some() {
                orders::release_holds(&mut tx, &actor, id).await?
            } else {
                Value::Null
            };
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
            if let Some((before, mut after)) = ended {
                after["released"] = released;
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
            return Err(gateway_unavailable());
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
    ShopUser { user, .. }: ShopUser,
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
    ShopUser { user, .. }: ShopUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<MyOrderView>, ApiError> {
    let view = my_order_view(&state, user.id, id).await?;
    if view.status == "pending"
        && let Some(a) = state.alipay().cloned()
    {
        orders::poll(&state, &a, id).await?;
        return Ok(Json(my_order_view(&state, user.id, id).await?));
    }
    Ok(Json(view))
}

/// POST /me/orders/{id}/cancel: end a pending order (queried first; if it
/// was paid meanwhile it is fulfilled and returned as paid).
pub async fn cancel_order(
    State(state): State<AppState>,
    ShopUser { user, .. }: ShopUser,
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
        return Err(conflict!("order.not_pending", "order is not pending"));
    };
    let st = orders::end_order(&state, &alipay, &o, "cancelled", &Actor::of(&user), false).await?;
    if st == "pending" {
        return Err(gateway_unavailable());
    }
    Ok(Json(my_order_view(&state, user.id, id).await?))
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
    if let Some(s) = &q.status
        && !matches!(s.as_str(), "pending" | "paid" | "expired" | "cancelled")
    {
        return Err(bad_request!("request.status_invalid", "unknown status"));
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
        return Err(bad_request!(
            "request.reason_length",
            "reason must be 1-{max_reason} characters",
            max_reason = MAX_REASON
        ));
    }
    let mut tx = state.pg().begin().await?;
    let r = orders::apply_admin_fulfil(&mut tx, &Actor::of(&user), id, reason).await?;
    tx.commit().await?;
    let fulfilled = matches!(r, Paid::Now { fulfilled: true });
    Ok(Json(json!({ "fulfilled": fulfilled })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefundReq {
    pub reason: String,
    /// Credit the Alipay amount to the balance too (else it was refunded
    /// in the Alipay console). The balance part always goes back.
    #[serde(default)]
    pub to_balance: bool,
}

/// POST /orders/{id}/refund {reason, to_balance}: W16 support action on a
/// paid order (orders::apply_refund). Audited `order.refund`.
pub async fn refund_order(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<RefundReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let reason = req.reason.trim();
    if reason.is_empty() || reason.chars().count() > MAX_REASON {
        return Err(bad_request!(
            "request.reason_length",
            "reason must be 1-{max_reason} characters",
            max_reason = MAX_REASON
        ));
    }
    let mut tx = state.pg().begin().await?;
    let r = orders::apply_refund(&mut tx, &Actor::of(&user), id, reason, req.to_balance).await?;
    tx.commit().await?;
    Ok(Json(r))
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
pub(crate) fn parse_form(body: &[u8]) -> Option<BTreeMap<String, String>> {
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
