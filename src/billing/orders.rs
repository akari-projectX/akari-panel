//! Orders: creation, the paid transition + fulfilment (one transaction,
//! exactly once), ending (expiry/cancel with a remote query + close), the
//! active query used by status polling and the periodic reconcile.
//!
//! Exactly-once fulfilment: every path that learns of a payment (notify,
//! query from polling, reconcile, admin) goes through `apply_mark_paid`,
//! which takes `entitle::lock` first and flips the order with a
//! conditional `UPDATE ... WHERE status <> 'paid'`; only the transaction
//! whose UPDATE returns the row fulfils. Replays, concurrent notify + query
//! and several instances therefore fulfil once. A late payment of an
//! expired/cancelled order is still fulfilled (Alipay took the money).

use crate::auth::conflict;
use std::net::IpAddr;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};
use uuid::Uuid;

use super::provider::{Close, PaymentProvider, Query};
use crate::audit::Actor;
use crate::auth::ApiError;
use crate::entitle;
use crate::state::AppState;

/// actor_login of payment-driven changes (notify, query, reconcile).
pub const PAYMENT_ACTOR: &str = "alipay";

/// Polling may query one order at most this often (any instance).
const POLL_QUERY_SECS: i64 = 3;
/// The reconcile queries each pending order at most this often.
const RECONCILE_QUERY_SECS: i64 = 20;
/// Orders handled per reconcile tick.
const RECONCILE_BATCH: i64 = 20;
/// An expired order whose remote close keeps failing is ended anyway
/// after this grace (a late payment is still fulfilled via notify).
const CLOSE_GRACE_SECS: i64 = 3600;

pub fn payment_actor(ip: Option<IpAddr>) -> Actor {
    Actor {
        id: None,
        login: PAYMENT_ACTOR.into(),
        ip,
    }
}

/// How the payment became known.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Notify,
    Query,
    Manual,
    /// W7: an amount-0 order the proration credit pays in full (at
    /// creation, never sent to Alipay).
    Credit,
    /// W16: an amount-0 order whose remainder the balance covers.
    Balance,
    /// W16: an amount-0 order a coupon covers (no credit, no balance).
    Coupon,
}

impl Via {
    fn as_str(self) -> &'static str {
        match self {
            Via::Notify => "notify",
            Via::Query => "query",
            Via::Manual => "manual",
            Via::Credit => "credit",
            Via::Balance => "balance",
            Via::Coupon => "coupon",
        }
    }
}

/// What fulfilling an order needs (copied into the order at creation).
#[derive(sqlx::FromRow, Debug, Clone)]
pub struct Bought {
    pub user_id: Option<Uuid>,
    pub plan_id: Option<Uuid>,
    pub period: String,
    pub period_days: Option<i32>,
    pub credit_cents: i64,
    pub credit_order_id: Option<Uuid>,
}

const BOUGHT_COLS: &str = "user_id, plan_id, period, period_days, credit_cents, credit_order_id";

/// SQL: the audit snapshot of an orders row under `alias`.
pub fn order_snapshot_sql(alias: &str) -> String {
    format!(
        "jsonb_build_object('out_trade_no', {a}.out_trade_no, 'user_id', {a}.user_id, \
         'plan_id', {a}.plan_id, 'amount_cents', {a}.amount_cents, 'period', {a}.period, \
         'period_days', {a}.period_days, 'list_price_cents', {a}.list_price_cents, \
         'credit_cents', {a}.credit_cents, 'credit_order_id', {a}.credit_order_id, \
         'discount_cents', {a}.discount_cents, 'coupon_code', {a}.coupon_code, \
         'balance_cents', {a}.balance_cents, 'balance_state', {a}.balance_state, \
         'gift_cents', {a}.gift_cents, \
         'status', {a}.status, 'trade_no', {a}.trade_no, 'paid_via', {a}.paid_via, \
         'payment_method_id', {a}.payment_method_id)",
        a = alias
    )
}

/// One payment_events row (in the caller's transaction or alone).
#[allow(clippy::too_many_arguments)]
pub async fn record_event(
    conn: &mut PgConnection,
    order_id: Option<Uuid>,
    out_trade_no: Option<&str>,
    source: &str,
    verified: bool,
    outcome: &str,
    trade_status: Option<&str>,
    params: Option<Value>,
    ip: Option<IpAddr>,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO payment_events (order_id, out_trade_no, source, verified, outcome, \
         trade_status, params, ip, payment_method_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, \
         (SELECT payment_method_id FROM orders WHERE id = $1))",
    )
    .bind(order_id)
    .bind(out_trade_no.map(|s| s.chars().take(64).collect::<String>()))
    .bind(source)
    .bind(verified)
    .bind(outcome)
    .bind(trade_status.map(|s| s.chars().take(32).collect::<String>()))
    .bind(params)
    .bind(ip.map(|ip| crate::client_ip::canonical(ip).to_string()))
    .execute(conn)
    .await?;
    Ok(())
}

/// The result of `apply_mark_paid`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Paid {
    /// Already paid: nothing changed (replay / concurrent duplicate).
    Already,
    /// This call flipped the order; fulfilment succeeded or not.
    Now { fulfilled: bool },
}

/// Flip an order to paid (from any other status) and fulfil it, in the
/// caller's transaction. Takes `entitle::lock` first (lock order). Writes
/// one `order.paid` audit row (plus the plan change's own row).
pub async fn apply_mark_paid(
    conn: &mut PgConnection,
    actor: &Actor,
    order_id: Uuid,
    via: Via,
    trade_no: Option<&str>,
    paid_cents: Option<i64>,
    reason: Option<&str>,
) -> Result<Paid, ApiError> {
    entitle::lock(conn).await?;
    let row: Option<(Value, Value)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE orders SET status = 'paid', paid_at = now(), ended_at = NULL, \
         paid_via = $2, trade_no = COALESCE($3, trade_no), paid_amount_cents = $4, \
         manual_reason = $5 WHERE id = $1 AND status <> 'paid' \
         RETURNING {}, {}",
        order_snapshot_sql("old"),
        order_snapshot_sql("new"),
    )))
    .bind(order_id)
    .bind(via.as_str())
    .bind(trade_no)
    .bind(paid_cents)
    .bind(reason)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((before, mut after)) = row else {
        return Ok(Paid::Already);
    };
    // W16: the coupon reservation becomes a redemption (a late payment of
    // an ended order re-reserves it); fulfilment re-takes a returned
    // balance part; the inviter's commission is created — all in this
    // transaction, so exactly once like the fulfilment.
    if let Some(c) = super::coupons::redeem(conn, order_id).await? {
        after["coupon"] = c;
    }
    let bought = bought(conn, order_id).await?;
    let (fulfilled, detail) = fulfil(conn, actor, order_id, &bought).await?;
    after["fulfilment"] = detail;
    if let Some((id, cents)) = super::commission::on_paid(conn, actor, order_id).await? {
        after["commission"] = json!({ "id": id, "amount_cents": cents });
    }
    if let Some(r) = reason {
        after["reason"] = json!(r);
    }
    crate::audit::record(
        conn,
        actor,
        "order.paid",
        "order",
        Some(order_id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    // W15: the receipt mail commits with the payment (savepoint: a mail
    // failure never rolls back money; a replay never gets here).
    crate::mail::notices::order_paid(conn, order_id).await?;
    Ok(Paid::Now { fulfilled })
}

async fn bought(conn: &mut PgConnection, order_id: Uuid) -> sqlx::Result<Bought> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {BOUGHT_COLS} FROM orders WHERE id = $1"
    )))
    .bind(order_id)
    .fetch_one(conn)
    .await
}

/// Grant/extend the plan of a paid order under a savepoint: a business
/// failure (plan gone/disabled/sold out, user gone/admin, reset pack
/// without the plan) rolls back only the plan change and is stored in
/// `fulfil_error`. Returns (fulfilled, detail).
async fn fulfil(
    conn: &mut PgConnection,
    actor: &Actor,
    order_id: Uuid,
    bought: &Bought,
) -> Result<(bool, Value), ApiError> {
    let mut sp = conn.begin().await?;
    let res = match retake_balance(&mut sp, actor, order_id).await {
        Ok(()) => grant(&mut sp, actor, bought).await,
        Err(e) => Err(e),
    };
    match res {
        Ok(detail) => {
            sp.commit().await?;
            sqlx::query(
                "UPDATE orders SET fulfilled_at = now(), fulfil_result = $2, fulfil_error = NULL \
                 WHERE id = $1",
            )
            .bind(order_id)
            .bind(&detail)
            .execute(&mut *conn)
            .await?;
            Ok((true, detail))
        }
        Err(e) => {
            sp.rollback().await?;
            let msg = e.message().chars().take(300).collect::<String>();
            let msg = if msg.is_empty() {
                "internal error".to_string()
            } else {
                msg
            };
            tracing::warn!(order = %order_id, error = %msg, "paid order not fulfilled");
            sqlx::query("UPDATE orders SET fulfil_error = $2 WHERE id = $1")
                .bind(order_id)
                .bind(&msg)
                .execute(&mut *conn)
                .await?;
            Ok((false, json!({ "error": msg })))
        }
    }
}

/// W16: a paid order whose balance part was returned when it ended unpaid
/// (a late payment) takes it again before fulfilment, inside the
/// fulfilment savepoint: when the balance no longer covers it the order
/// stays paid with `fulfil_error` "insufficient balance" (the admin tops up
/// and retries, or refunds), never a negative balance.
async fn retake_balance(
    conn: &mut PgConnection,
    actor: &Actor,
    order_id: Uuid,
) -> Result<(), ApiError> {
    let row: Option<(Option<Uuid>, i64)> = sqlx::query_as(
        "SELECT user_id, balance_cents FROM orders WHERE id = $1 AND balance_state = 'refunded'",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((user, cents)) = row else {
        return Ok(());
    };
    let user =
        user.ok_or_else(|| conflict!("order_admin.user_gone", "the user no longer exists"))?;
    let mut e = super::ledger::Entry::new(user, super::ledger::Kind::OrderPayment, -cents);
    e.order_id = Some(order_id);
    super::ledger::apply_entry(conn, actor, &e).await?;
    sqlx::query("UPDATE orders SET balance_state = 'held' WHERE id = $1")
        .bind(order_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// W16: an order ended unpaid (expired, cancelled, precreate failed): its
/// held balance part goes back (ledger refund_to_balance) and its coupon
/// reservation is released, in the caller's transaction (the one that
/// ended it). Idempotent. Returns a detail for the audit row.
pub async fn release_holds(
    conn: &mut PgConnection,
    actor: &Actor,
    order_id: Uuid,
) -> Result<Value, ApiError> {
    let mut detail = json!({});
    let held: Option<(Option<Uuid>, i64)> = sqlx::query_as(
        "UPDATE orders SET balance_state = 'refunded' WHERE id = $1 AND balance_state = 'held' \
         RETURNING user_id, balance_cents",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((user, cents)) = held {
        match user {
            Some(user) => {
                let mut e =
                    super::ledger::Entry::new(user, super::ledger::Kind::RefundToBalance, cents);
                e.order_id = Some(order_id);
                super::ledger::apply_entry(conn, actor, &e).await?;
                detail["balance_refunded_cents"] = json!(cents);
            }
            // The user is gone: nothing to return to (their balance row
            // went with them).
            None => detail["balance_refunded_cents"] = json!(0),
        }
    }
    if super::coupons::release(conn, order_id).await? {
        detail["coupon_released"] = json!(true);
    }
    Ok(detail)
}

/// (status, refunded_at, user_id, amount, balance part, balance_state).
type RefundRow = (
    String,
    Option<DateTime<Utc>>,
    Option<Uuid>,
    i64,
    i64,
    String,
);

/// W16: admin refund of a paid order (support action, reason required):
/// the held balance part always goes back to the balance; with
/// `to_balance` the Alipay amount is credited to the balance as well
/// (otherwise it was refunded out of band in the Alipay console). One
/// ledger row (refund_to_balance) when anything is credited; a pending
/// invite commission is reversed. The plan is not touched (cancel it by
/// hand if needed). Once per order (409 afterwards). Audited
/// `order.refund`.
pub async fn apply_refund(
    conn: &mut PgConnection,
    actor: &Actor,
    order_id: Uuid,
    reason: &str,
    to_balance: bool,
) -> Result<Value, ApiError> {
    let row: Option<RefundRow> = sqlx::query_as(
        "SELECT status, refunded_at, user_id, amount_cents, balance_cents, balance_state \
             FROM orders WHERE id = $1 FOR UPDATE",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((status, refunded_at, user, amount, balance, balance_state)) = row else {
        return Err(ApiError::not_found());
    };
    if status != "paid" {
        return Err(conflict!(
            "order_admin.refund_not_paid",
            "only a paid order can be refunded"
        ));
    }
    if refunded_at.is_some() {
        return Err(conflict!(
            "order_admin.already_refunded",
            "the order was already refunded"
        ));
    }
    let balance_part = if balance_state == "held" { balance } else { 0 };
    let cash_part = if to_balance { amount } else { 0 };
    let credit = balance_part + cash_part;
    if credit > 0 {
        let user = user.ok_or_else(|| {
            conflict!(
                "order_admin.refund_user_gone",
                "the user no longer exists; refund out of band without to_balance"
            )
        })?;
        let mut e = super::ledger::Entry::new(user, super::ledger::Kind::RefundToBalance, credit);
        e.order_id = Some(order_id);
        e.reason = Some(reason);
        super::ledger::apply_entry(conn, actor, &e).await?;
    }
    sqlx::query(
        "UPDATE orders SET refunded_at = now(), refund_cents = $2, refund_reason = $3, \
         balance_state = CASE WHEN balance_state = 'held' THEN 'refunded' ELSE balance_state END \
         WHERE id = $1",
    )
    .bind(order_id)
    .bind(credit)
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    let commission =
        super::commission::reverse_for_order(conn, actor, order_id, "order refunded").await?;
    let after = json!({
        "refund_cents": credit,
        "to_balance": to_balance,
        "balance_part_cents": balance_part,
        "cash_part_cents": cash_part,
        "commission": commission,
        "reason": reason,
    });
    crate::audit::record(
        conn,
        actor,
        "order.refund",
        "order",
        Some(order_id.to_string()),
        Some(json!({ "status": "paid", "refunded": false })),
        Some(after.clone()),
    )
    .await?;
    Ok(after)
}

/// The plan change itself (the caller holds `entitle::lock`):
/// - reset pack: zero the used traffic of the user's active plan, which
///   must still be the order's plan;
/// - same active plan: renew — expiry = one period after max(expiry, now)
///   (SQL `akari_period_end`; a one-time purchase without days makes it
///   permanent);
/// - otherwise new/switch: capacity re-checked here (authoritative: under
///   the lock, so two payments for the last slot cannot both get it), then
///   the plan for one period from now, usage reset (M3 replace semantics).
async fn grant(conn: &mut PgConnection, actor: &Actor, b: &Bought) -> Result<Value, ApiError> {
    let user = b
        .user_id
        .ok_or_else(|| conflict!("order_admin.user_gone", "the user no longer exists"))?;
    let plan = b
        .plan_id
        .ok_or_else(|| conflict!("order_admin.plan_gone", "the plan no longer exists"))?;
    let kind = super::catalog::PeriodKind::parse(&b.period)
        .ok_or_else(|| anyhow::anyhow!("order has an unknown period kind"))?;
    if kind == super::catalog::PeriodKind::Reset {
        crate::plans::apply_reset_traffic(conn, actor, user, plan).await?;
        return Ok(json!({ "kind": "reset" }));
    }
    let active: Option<(Uuid, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT plan_id, expires_at FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(user)
    .fetch_optional(&mut *conn)
    .await?;
    match active {
        Some((p, None)) if p == plan => {
            // Unlimited already (admin-assigned or a permanent purchase);
            // order creation refuses this, so it only happens if the plan
            // changed meanwhile.
            Ok(json!({ "kind": "renew", "expires_at": null, "note": "plan has no expiry" }))
        }
        Some((p, Some(old))) if p == plan => {
            let new: Option<DateTime<Utc>> =
                sqlx::query_scalar("SELECT akari_period_end(GREATEST($1, now()), $2, $3)")
                    .bind(old)
                    .bind(&b.period)
                    .bind(b.period_days)
                    .fetch_one(&mut *conn)
                    .await?;
            crate::plans::apply_update_user_plan(
                conn,
                actor,
                user,
                &crate::plans::UpdateUserPlanReq {
                    expires_at: Some(new),
                    ..Default::default()
                },
            )
            .await?;
            Ok(json!({ "kind": "renew", "from": old, "expires_at": new }))
        }
        other => {
            let cap: Option<(Option<i32>, i64)> = sqlx::query_as(
                "SELECT capacity, (SELECT count(*) FROM user_plans \
                 WHERE plan_id = $1 AND status = 'active') FROM plans WHERE id = $1",
            )
            .bind(plan)
            .fetch_optional(&mut *conn)
            .await?;
            let Some((capacity, holders)) = cap else {
                return Err(conflict!(
                    "order_admin.plan_gone",
                    "the plan no longer exists"
                ));
            };
            if capacity.is_some_and(|c| holders >= i64::from(c)) {
                return Err(conflict!("shop.sold_out", "plan is sold out"));
            }
            let new: Option<DateTime<Utc>> =
                sqlx::query_scalar("SELECT akari_period_end(now(), $1, $2)")
                    .bind(&b.period)
                    .bind(b.period_days)
                    .fetch_one(&mut *conn)
                    .await?;
            // The credit was computed from the subscription active at order
            // creation; flag it for review if that is no longer what is
            // being replaced (the payment is honoured either way).
            let credit_source_changed = if b.credit_cents > 0 {
                let src: Option<Option<Uuid>> =
                    sqlx::query_scalar("SELECT plan_id FROM orders WHERE id = $1")
                        .bind(b.credit_order_id)
                        .fetch_optional(&mut *conn)
                        .await?;
                src.flatten() != other.map(|o| o.0)
            } else {
                false
            };
            crate::plans::apply_set_user_plan(
                conn,
                actor,
                user,
                &crate::plans::SetUserPlanReq {
                    plan_id: plan,
                    expires_at: new,
                    period_anchor: None,
                    reset_traffic: Some(true),
                },
            )
            .await?;
            let kind = if other.is_some() { "switch" } else { "new" };
            let mut detail = json!({ "kind": kind, "expires_at": new });
            if b.credit_cents > 0 {
                detail["credit_cents"] = json!(b.credit_cents);
                detail["credit_source_changed"] = json!(credit_source_changed);
            }
            Ok(detail)
        }
    }
}

/// Admin: mark an unpaid order paid (manual, with reason) or retry the
/// fulfilment of a paid, unfulfilled one. 409 when already fulfilled.
pub async fn apply_admin_fulfil(
    conn: &mut PgConnection,
    actor: &Actor,
    order_id: Uuid,
    reason: &str,
) -> Result<Paid, ApiError> {
    entitle::lock(conn).await?;
    let row: Option<(String, Option<DateTime<Utc>>, String, bool)> = sqlx::query_as(
        "SELECT status, fulfilled_at, out_trade_no, refunded_at IS NOT NULL FROM orders \
         WHERE id = $1 FOR UPDATE",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((status, fulfilled_at, otn, refunded)) = row else {
        return Err(ApiError::not_found());
    };
    if refunded {
        return Err(conflict!("order_admin.refunded", "the order was refunded"));
    }
    if status != "paid" {
        let r =
            apply_mark_paid(conn, actor, order_id, Via::Manual, None, None, Some(reason)).await?;
        record_event(
            conn,
            Some(order_id),
            Some(&otn),
            "manual",
            true,
            "marked_paid",
            None,
            Some(json!({ "reason": reason, "by": actor.login })),
            actor.ip,
        )
        .await?;
        return Ok(r);
    }
    if fulfilled_at.is_some() {
        return Err(conflict!(
            "order_admin.already_fulfilled",
            "order is already fulfilled"
        ));
    }
    let b = bought(conn, order_id).await?;
    let (fulfilled, detail) = fulfil(conn, actor, order_id, &b).await?;
    crate::audit::record(
        conn,
        actor,
        "order.fulfil.retry",
        "order",
        Some(order_id.to_string()),
        Some(json!({ "status": "paid", "fulfilled": false })),
        Some(json!({ "fulfilled": fulfilled, "fulfilment": detail, "reason": reason })),
    )
    .await?;
    record_event(
        conn,
        Some(order_id),
        Some(&otn),
        "manual",
        true,
        if fulfilled {
            "fulfilled"
        } else {
            "fulfil_failed"
        },
        None,
        Some(json!({ "reason": reason, "by": actor.login })),
        actor.ip,
    )
    .await?;
    Ok(Paid::Now { fulfilled })
}

/// A pending order's essentials.
#[derive(sqlx::FromRow, Debug, Clone)]
pub struct Pending {
    pub id: Uuid,
    pub out_trade_no: String,
    pub amount_cents: i64,
    pub expires_at: DateTime<Utc>,
    /// expires_at <= now() (DB clock).
    pub due: bool,
    /// R40: the method that may settle it (None: pre-0140 order never
    /// assigned, or a method-less order).
    pub payment_method_id: Option<Uuid>,
}

/// The columns of `Pending` (alias `o`).
pub const PENDING_COLS: &str = "o.id, o.out_trade_no, o.amount_cents, o.expires_at, \
     o.expires_at <= now() AS due, o.payment_method_id";

/// Apply a trade query result: TRADE_SUCCESS/FINISHED with the right
/// amount → paid (exactly once). Returns true when the order is paid now
/// (by this or an earlier call).
pub async fn apply_query_result(
    state: &AppState,
    order: &Pending,
    q: &Query,
    source: &str,
) -> Result<bool, ApiError> {
    let Query::Trade {
        status,
        paid,
        trade_no,
        total_cents,
    } = q
    else {
        return Ok(false);
    };
    if !paid {
        return Ok(false);
    }
    let mut tx = state.pg().begin().await?;
    if *total_cents != Some(order.amount_cents) {
        tracing::error!(order = %order.id, "payment query: paid amount differs from the order");
        record_event(
            &mut tx,
            Some(order.id),
            Some(&order.out_trade_no),
            source,
            true,
            "amount_mismatch",
            Some(status),
            Some(json!({ "trade_no": trade_no, "total_cents": total_cents })),
            None,
        )
        .await?;
        crate::audit::record(
            &mut tx,
            &payment_actor(None),
            "order.payment.rejected",
            "order",
            Some(order.id.to_string()),
            None,
            Some(json!({ "reason": "amount_mismatch", "source": source,
                         "expected_cents": order.amount_cents, "total_cents": total_cents })),
        )
        .await?;
        tx.commit().await?;
        return Ok(false);
    }
    let r = apply_mark_paid(
        &mut tx,
        &payment_actor(None),
        order.id,
        Via::Query,
        Some(trade_no),
        *total_cents,
        None,
    )
    .await?;
    if r != Paid::Already {
        record_event(
            &mut tx,
            Some(order.id),
            Some(&order.out_trade_no),
            source,
            true,
            "paid",
            Some(status),
            Some(json!({ "trade_no": trade_no, "total_cents": total_cents })),
            None,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// Status polling: query the order's method for a pending order, at most
/// every POLL_QUERY_SECS per order across instances (claim marker).
pub async fn poll(state: &AppState, order_id: Uuid) -> Result<(), ApiError> {
    let claimed: Option<Pending> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE orders o SET last_query_at = now() WHERE id = $1 AND status = 'pending' \
         AND (last_query_at IS NULL OR last_query_at <= now() - make_interval(secs => $2)) \
         RETURNING {PENDING_COLS}"
    )))
    .bind(order_id)
    .bind(POLL_QUERY_SECS as f64)
    .fetch_optional(state.pg())
    .await?;
    let Some(order) = claimed else {
        return Ok(());
    };
    let Some(p) = order
        .payment_method_id
        .and_then(|m| state.payments().provider(m))
    else {
        return Ok(());
    };
    match p.query(&order.out_trade_no).await {
        Ok(q) => {
            apply_query_result(state, &order, &q, "query").await?;
        }
        Err(e) => tracing::warn!(order = %order.id, error = %e, "payment query failed"),
    }
    Ok(())
}

/// The client of an order's method on this instance (None = the method is
/// disabled, unusable or unknown).
pub fn provider_of(state: &AppState, order: &Pending) -> Option<Arc<dyn PaymentProvider>> {
    order
        .payment_method_id
        .and_then(|m| state.payments().provider(m))
}

/// End a pending order (`expired` or `cancelled`): query first (paid →
/// fulfil instead), then close remotely; the row is ended only when the
/// close succeeded (or there was nothing to close), or `force` (close
/// grace exceeded). Without a usable method (disabled since) nothing can
/// be asked remotely: the order ends only with `force`
/// (`close_state = method_unavailable`). Returns the status afterwards.
pub async fn end_order(
    state: &AppState,
    provider: Option<&dyn PaymentProvider>,
    order: &Pending,
    target: &str,
    actor: &Actor,
    force: bool,
) -> Result<String, ApiError> {
    let close_state = match provider {
        None if !force => return Ok("pending".into()),
        None => "method_unavailable".to_string(),
        Some(p) => {
            match p.query(&order.out_trade_no).await {
                Ok(q) => {
                    if apply_query_result(state, order, &q, "query").await? {
                        return Ok("paid".into());
                    }
                }
                Err(e) => {
                    tracing::warn!(order = %order.id, error = %e, "payment query failed");
                    if !force {
                        return Ok("pending".into());
                    }
                }
            }
            match p.close(&order.out_trade_no).await {
                Ok(Close::Closed) => "closed".to_string(),
                Ok(Close::NotExist) => "not_exist".to_string(),
                Err(e) => {
                    tracing::warn!(order = %order.id, error = %e, "payment close failed");
                    if !force {
                        return Ok("pending".into());
                    }
                    "failed".to_string()
                }
            }
        }
    };
    let mut tx = state.pg().begin().await?;
    let ended: Option<(Value, Value)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE orders SET status = $2, ended_at = now(), close_state = $3 \
         WHERE id = $1 AND status = 'pending' RETURNING {}, {}",
        order_snapshot_sql("old"),
        order_snapshot_sql("new"),
    )))
    .bind(order.id)
    .bind(target)
    .bind(&close_state)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((before, mut after)) = ended else {
        let now: Option<String> = sqlx::query_scalar("SELECT status FROM orders WHERE id = $1")
            .bind(order.id)
            .fetch_optional(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(now.unwrap_or_default());
    };
    after["close_state"] = json!(close_state);
    after["released"] = release_holds(&mut tx, actor, order.id).await?;
    record_event(
        &mut tx,
        Some(order.id),
        Some(&order.out_trade_no),
        if target == "expired" {
            "expire"
        } else {
            "close"
        },
        true,
        target,
        None,
        Some(json!({ "close_state": close_state })),
        actor.ip,
    )
    .await?;
    crate::audit::record(
        &mut tx,
        actor,
        if target == "expired" {
            "order.expire"
        } else {
            "order.cancel"
        },
        "order",
        Some(order.id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    tx.commit().await?;
    Ok(target.to_string())
}

/// One reconcile tick (any instance, concurrently safe): claim a batch of
/// pending orders not queried recently (SKIP LOCKED + claim marker), query
/// each at ITS method — paid → fulfil; past expiry → close and expire
/// (an order whose method is no longer usable ends after the close grace
/// without a remote call).
pub async fn reconcile_tick(state: &AppState) -> Result<usize, ApiError> {
    let batch: Vec<Pending> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE orders o SET last_query_at = now() FROM (\
           SELECT id FROM orders WHERE status = 'pending' \
           AND (last_query_at IS NULL OR last_query_at <= now() - make_interval(secs => $1)) \
           ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED) c \
         WHERE o.id = c.id \
         RETURNING {PENDING_COLS}"
    )))
    .bind(RECONCILE_QUERY_SECS as f64)
    .bind(RECONCILE_BATCH)
    .fetch_all(state.pg())
    .await?;
    let n = batch.len();
    for order in batch {
        let provider = provider_of(state, &order);
        let res = if order.due {
            let force =
                sqlx::query_scalar::<_, bool>("SELECT $1 <= now() - make_interval(secs => $2)")
                    .bind(order.expires_at)
                    .bind(CLOSE_GRACE_SECS as f64)
                    .fetch_one(state.pg())
                    .await?;
            end_order(
                state,
                provider.as_deref(),
                &order,
                "expired",
                &crate::audit::Actor::system(),
                force,
            )
            .await
            .map(|_| ())
        } else if let Some(p) = provider {
            match p.query(&order.out_trade_no).await {
                Ok(q) => apply_query_result(state, &order, &q, "query")
                    .await
                    .map(|_| ()),
                Err(e) => {
                    tracing::warn!(order = %order.id, error = %e, "payment query failed");
                    Ok(())
                }
            }
        } else {
            Ok(())
        };
        if let Err(e) = res {
            tracing::warn!(order = %order.id, error = e.message(), "order reconcile failed");
        }
    }
    Ok(n)
}

/// Prune unverified payment events (junk notifies) older than the audit
/// retention. Verified events are money records and are kept.
pub async fn prune_events(state: &AppState) -> sqlx::Result<u64> {
    let days = state.settings().get().audit_retention_days;
    if days == 0 {
        return Ok(0);
    }
    let r = sqlx::query(
        "DELETE FROM payment_events WHERE NOT verified \
         AND created_at < now() - make_interval(days => $1)",
    )
    .bind(days as i32)
    .execute(state.pg())
    .await?;
    Ok(r.rows_affected())
}
