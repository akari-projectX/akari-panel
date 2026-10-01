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

use std::net::IpAddr;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{Connection, PgConnection};
use uuid::Uuid;

use super::alipay::{Alipay, Close, Query};
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
}

impl Via {
    fn as_str(self) -> &'static str {
        match self {
            Via::Notify => "notify",
            Via::Query => "query",
            Via::Manual => "manual",
        }
    }
}

/// SQL: the audit snapshot of an orders row under `alias`.
pub fn order_snapshot_sql(alias: &str) -> String {
    format!(
        "jsonb_build_object('out_trade_no', {a}.out_trade_no, 'user_id', {a}.user_id, \
         'plan_id', {a}.plan_id, 'amount_cents', {a}.amount_cents, 'period_days', \
         {a}.period_days, 'status', {a}.status, 'trade_no', {a}.trade_no, 'paid_via', \
         {a}.paid_via)",
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
         trade_status, params, ip) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
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
    let row: Option<(Value, Value, Option<Uuid>, Option<Uuid>, i32)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "UPDATE orders SET status = 'paid', paid_at = now(), ended_at = NULL, \
             paid_via = $2, trade_no = COALESCE($3, trade_no), paid_amount_cents = $4, \
             manual_reason = $5 WHERE id = $1 AND status <> 'paid' \
             RETURNING {}, {}, user_id, plan_id, period_days",
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
    let Some((before, mut after, user_id, plan_id, period_days)) = row else {
        return Ok(Paid::Already);
    };
    let (fulfilled, detail) = fulfil(conn, actor, order_id, user_id, plan_id, period_days).await?;
    after["fulfilment"] = detail;
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
    Ok(Paid::Now { fulfilled })
}

/// Grant/extend the plan of a paid order under a savepoint: a business
/// failure (plan gone/disabled, user gone/admin) rolls back only the plan
/// change and is stored in `fulfil_error`. Returns (fulfilled, detail).
async fn fulfil(
    conn: &mut PgConnection,
    actor: &Actor,
    order_id: Uuid,
    user_id: Option<Uuid>,
    plan_id: Option<Uuid>,
    period_days: i32,
) -> Result<(bool, Value), ApiError> {
    let mut sp = conn.begin().await?;
    let res = grant(&mut sp, actor, user_id, plan_id, period_days).await;
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

/// The plan change itself: renew (same active plan: expiry + period_days
/// from max(expiry, now)) or new/replace (plan for period_days from now,
/// usage reset — M3 replace semantics).
async fn grant(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Option<Uuid>,
    plan_id: Option<Uuid>,
    period_days: i32,
) -> Result<Value, ApiError> {
    let user = user_id.ok_or_else(|| ApiError::conflict("the user no longer exists"))?;
    let plan = plan_id.ok_or_else(|| ApiError::conflict("the plan no longer exists"))?;
    let active: Option<(Uuid, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT plan_id, expires_at FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(user)
    .fetch_optional(&mut *conn)
    .await?;
    match active {
        Some((p, None)) if p == plan => {
            // Unlimited already (admin-assigned); order creation refuses
            // this, so it only happens if the plan changed meanwhile.
            Ok(json!({ "kind": "renew", "expires_at": null, "note": "plan has no expiry" }))
        }
        Some((p, Some(old))) if p == plan => {
            let new: DateTime<Utc> =
                sqlx::query_scalar("SELECT GREATEST($1, now()) + make_interval(days => $2)")
                    .bind(old)
                    .bind(period_days)
                    .fetch_one(&mut *conn)
                    .await?;
            crate::plans::apply_update_user_plan(
                conn,
                actor,
                user,
                &crate::plans::UpdateUserPlanReq {
                    expires_at: Some(Some(new)),
                    ..Default::default()
                },
            )
            .await?;
            Ok(json!({ "kind": "renew", "from": old, "expires_at": new }))
        }
        other => {
            let new: DateTime<Utc> = sqlx::query_scalar("SELECT now() + make_interval(days => $1)")
                .bind(period_days)
                .fetch_one(&mut *conn)
                .await?;
            crate::plans::apply_set_user_plan(
                conn,
                actor,
                user,
                &crate::plans::SetUserPlanReq {
                    plan_id: plan,
                    expires_at: Some(new),
                    period_anchor: None,
                    reset_traffic: Some(true),
                },
            )
            .await?;
            let kind = if other.is_some() { "replace" } else { "new" };
            Ok(json!({ "kind": kind, "expires_at": new }))
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
    let row: Option<(String, Option<DateTime<Utc>>, Option<Uuid>, Option<Uuid>, i32, String)> =
        sqlx::query_as(
            "SELECT status, fulfilled_at, user_id, plan_id, period_days, out_trade_no \
             FROM orders WHERE id = $1 FOR UPDATE",
        )
        .bind(order_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((status, fulfilled_at, user_id, plan_id, period_days, otn)) = row else {
        return Err(ApiError::not_found());
    };
    if status != "paid" {
        let r = apply_mark_paid(conn, actor, order_id, Via::Manual, None, None, Some(reason)).await?;
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
        return Err(ApiError::conflict("order is already fulfilled"));
    }
    let (fulfilled, detail) = fulfil(conn, actor, order_id, user_id, plan_id, period_days).await?;
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
        if fulfilled { "fulfilled" } else { "fulfil_failed" },
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
}

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
        trade_no,
        total_cents,
    } = q
    else {
        return Ok(false);
    };
    if status != "TRADE_SUCCESS" && status != "TRADE_FINISHED" {
        return Ok(false);
    }
    let mut tx = state.pg().begin().await?;
    if *total_cents != Some(order.amount_cents) {
        tracing::error!(order = %order.id, "alipay query: paid amount differs from the order");
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

/// Status polling: query Alipay for a pending order of this user, at most
/// every POLL_QUERY_SECS per order across instances (claim marker).
pub async fn poll(state: &AppState, alipay: &Alipay, order_id: Uuid) -> Result<(), ApiError> {
    let claimed: Option<Pending> = sqlx::query_as(
        "UPDATE orders SET last_query_at = now() WHERE id = $1 AND status = 'pending' \
         AND (last_query_at IS NULL OR last_query_at <= now() - make_interval(secs => $2)) \
         RETURNING id, out_trade_no, amount_cents, expires_at, expires_at <= now() AS due",
    )
    .bind(order_id)
    .bind(POLL_QUERY_SECS as f64)
    .fetch_optional(state.pg())
    .await?;
    let Some(order) = claimed else {
        return Ok(());
    };
    match alipay.query(&order.out_trade_no).await {
        Ok(q) => {
            apply_query_result(state, &order, &q, "query").await?;
        }
        Err(e) => tracing::warn!(order = %order.id, error = %e, "alipay query failed"),
    }
    Ok(())
}

/// End a pending order (`expired` or `cancelled`): query first (paid →
/// fulfil instead), then close remotely; the row is ended only when the
/// close succeeded (or there was nothing to close), or `force` (close
/// grace exceeded). Returns the order's status afterwards.
pub async fn end_order(
    state: &AppState,
    alipay: &Alipay,
    order: &Pending,
    target: &str,
    actor: &Actor,
    force: bool,
) -> Result<String, ApiError> {
    match alipay.query(&order.out_trade_no).await {
        Ok(q) => {
            if apply_query_result(state, order, &q, "query").await? {
                return Ok("paid".into());
            }
        }
        Err(e) => {
            tracing::warn!(order = %order.id, error = %e, "alipay query failed");
            if !force {
                return Ok("pending".into());
            }
        }
    }
    let close_state = match alipay.close(&order.out_trade_no).await {
        Ok(Close::Closed) => "closed".to_string(),
        Ok(Close::NotExist) => "not_exist".to_string(),
        Err(e) => {
            tracing::warn!(order = %order.id, error = %e, "alipay close failed");
            if !force {
                return Ok("pending".into());
            }
            "failed".to_string()
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
    record_event(
        &mut tx,
        Some(order.id),
        Some(&order.out_trade_no),
        if target == "expired" { "expire" } else { "close" },
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
/// each — paid → fulfil; past expiry → close and expire.
pub async fn reconcile_tick(state: &AppState, alipay: &Arc<Alipay>) -> Result<usize, ApiError> {
    let batch: Vec<Pending> = sqlx::query_as(
        "UPDATE orders o SET last_query_at = now() FROM (\
           SELECT id FROM orders WHERE status = 'pending' \
           AND (last_query_at IS NULL OR last_query_at <= now() - make_interval(secs => $1)) \
           ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED) c \
         WHERE o.id = c.id \
         RETURNING o.id, o.out_trade_no, o.amount_cents, o.expires_at, o.expires_at <= now() AS due",
    )
    .bind(RECONCILE_QUERY_SECS as f64)
    .bind(RECONCILE_BATCH)
    .fetch_all(state.pg())
    .await?;
    let n = batch.len();
    for order in batch {
        let res = if order.due {
            let force = sqlx::query_scalar::<_, bool>(
                "SELECT $1 <= now() - make_interval(secs => $2)",
            )
            .bind(order.expires_at)
            .bind(CLOSE_GRACE_SECS as f64)
            .fetch_one(state.pg())
            .await?;
            end_order(state, alipay, &order, "expired", &crate::audit::Actor::system(), force)
                .await
                .map(|_| ())
        } else {
            match alipay.query(&order.out_trade_no).await {
                Ok(q) => apply_query_result(state, &order, &q, "query")
                    .await
                    .map(|_| ()),
                Err(e) => {
                    tracing::warn!(order = %order.id, error = %e, "alipay query failed");
                    Ok(())
                }
            }
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
    let days = state.cfg().audit.retention_days;
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
