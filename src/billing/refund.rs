//! Admin refunds (W16; P1 and the ops-logic review batch A).
//!
//! `POST /orders/{id}/refund` refunds a paid order once, in one
//! transaction: the money (the held balance part always goes back to the
//! balance; the gateway part is credited to the balance with `to_balance`,
//! otherwise the admin records what was refunded in the provider's console
//! — `refund_balance_cents` / `refund_external_cents`, 中-3) and — P1 — what the order did to the subscription, unless the admin
//! keeps the plan (`keep_plan`):
//! - a new subscription ends (status `cancelled`, access revoked — the
//!   agents drop the user's credentials and live connections);
//! - a renewal's term is taken back from the current expiry (exactly what
//!   the renewal added, recorded at fulfilment as `expires_at - base`); an
//!   expiry that would fall at or before now ends the subscription;
//! - a plan switch restores the replaced subscription (its plan and
//!   expiry; the traffic used before the switch is added to what was used
//!   since) — when that one has expired meanwhile the subscription ends;
//! - a traffic reset pack is money only (used traffic cannot be undone);
//! - nothing when the order was never fulfilled, or the subscription it
//!   touched is no longer the active one (replaced, expired, cancelled).
//!
//! The order's coupon use is given back and a refunded order no longer
//! counts as a purchase (new-customer coupons, first-order commission;
//! 低-2); its invite commission is reversed (pending) or clawed back
//! (credited, 中-4).
//!
//! `GET /orders/{id}/refund-preview` shows the same computation without
//! changing anything (the console's confirmation dialog).
//!
//! Three ways for the gateway amount (支付宝原路退款): ① **original route**
//! — the panel asks the provider (`alipay.trade.refund`, key mode) to
//! refund all or part of it (`begin_original` + `settle_original`; the
//! channel's "allow original-route refunds" switch, default on). The
//! request number (`out_request_no`, `<out_trade_no>R<n>`) makes it
//! idempotent; an unknown outcome (network) stays `pending` and the
//! reconcile loop (`refund_tick`) queries the provider and retries with the
//! same number until it is confirmed; a refusal is `failed` (nothing
//! moved; the admin may try again or choose another way). When the
//! provider confirms, `apply_refund` records it like ③ (the amount as
//! refunded at the provider) with the subscription effect and the
//! customer's notice. ② **to the balance**. ③ **record only** — refunded
//! by hand in the provider's console, the real amount entered.
//!
//! Lock order (as `orders::apply_mark_paid`): `entitle::lock` → the order
//! row → the subscription's nodes and user rows → commissions → balances.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use super::provider::{CallError, RefundReq, RefundState};
use crate::state::AppState;

use crate::audit::Actor;
use crate::auth::{ApiError, bad_request, conflict};
use crate::plans::Revoke;

/// Why a refund leaves the subscription alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unchanged {
    /// The admin chose to refund the money only.
    KeepPlan,
    /// The order was paid but never fulfilled.
    NotFulfilled,
    /// A traffic reset pack: the traffic used since cannot be undone.
    ResetPack,
    /// The subscription the order created or renewed is no longer active.
    NotActive,
    /// The account is gone.
    UserGone,
    /// A fulfilment recorded before refunds tracked their subscription.
    Untracked,
}

/// What a refund does to the subscription.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Effect {
    None {
        why: Unchanged,
    },
    /// The subscription ends now.
    Cancel {
        user_plan_id: Uuid,
        plan_name: String,
        expires_at: Option<DateTime<Utc>>,
    },
    /// The renewal's term is taken back.
    Rollback {
        user_plan_id: Uuid,
        plan_name: String,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    },
    /// The plan before the switch comes back.
    Restore {
        user_plan_id: Uuid,
        prior_user_plan_id: Uuid,
        plan_name: String,
        expires_at: Option<DateTime<Utc>>,
        /// Traffic used before the switch, added to the usage since.
        prior_used_bytes: i64,
    },
}

impl Effect {
    fn none(why: Unchanged) -> Self {
        Effect::None { why }
    }

    /// The plan change to apply (None = money only).
    pub fn revoke(&self) -> Option<Revoke> {
        match *self {
            Effect::None { .. } => None,
            Effect::Cancel { user_plan_id, .. } => Some(Revoke::End { user_plan_id }),
            Effect::Rollback {
                user_plan_id, to, ..
            } => Some(Revoke::Rollback { user_plan_id, to }),
            Effect::Restore {
                user_plan_id,
                prior_user_plan_id,
                prior_used_bytes,
                ..
            } => Some(Revoke::Restore {
                user_plan_id,
                prior_user_plan_id,
                prior_used_bytes,
            }),
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

fn uuid_at(v: &Value, ptr: &str) -> Option<Uuid> {
    v.pointer(ptr)?.as_str()?.parse().ok()
}

fn time_at(v: &Value, ptr: &str) -> Option<DateTime<Utc>> {
    serde_json::from_value(v.pointer(ptr)?.clone()).ok()
}

/// The active subscription `id` of `user`: (plan name, expiry).
async fn active_sub(
    conn: &mut PgConnection,
    user: Uuid,
    id: Uuid,
) -> sqlx::Result<Option<(String, Option<DateTime<Utc>>)>> {
    sqlx::query_as(
        "SELECT p.name, up.expires_at FROM user_plans up JOIN plans p ON p.id = up.plan_id \
         WHERE up.id = $1 AND up.user_id = $2 AND up.status = 'active'",
    )
    .bind(id)
    .bind(user)
    .fetch_optional(conn)
    .await
}

/// What refunding `order_id` would do to the subscription now (DB clock).
/// Reads only; the caller holds the locks when it is about to apply it.
pub async fn effect(conn: &mut PgConnection, order_id: Uuid) -> Result<Effect, ApiError> {
    let row: Option<(Option<Uuid>, bool, Option<Value>)> = sqlx::query_as(
        "SELECT user_id, fulfilled_at IS NOT NULL, fulfil_result FROM orders WHERE id = $1",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((user, fulfilled, result)) = row else {
        return Err(ApiError::not_found());
    };
    let Some(user) = user else {
        return Ok(Effect::none(Unchanged::UserGone));
    };
    let (true, Some(r)) = (fulfilled, result) else {
        return Ok(Effect::none(Unchanged::NotFulfilled));
    };
    let kind = r["kind"].as_str().unwrap_or_default();
    if kind == "reset" {
        return Ok(Effect::none(Unchanged::ResetPack));
    }
    let Some(up) = uuid_at(&r, "/user_plan_id") else {
        return Ok(Effect::none(Unchanged::Untracked));
    };
    let Some((plan_name, expires_at)) = active_sub(conn, user, up).await? else {
        return Ok(Effect::none(Unchanged::NotActive));
    };
    let cancel = |plan_name: String, expires_at| Effect::Cancel {
        user_plan_id: up,
        plan_name,
        expires_at,
    };
    match kind {
        "renew" => {
            let (Some(cur), Some(added_to), Some(base)) =
                (expires_at, time_at(&r, "/expires_at"), time_at(&r, "/base"))
            else {
                // A renewal of a permanent subscription added nothing.
                return Ok(Effect::none(Unchanged::Untracked));
            };
            // The term the renewal added, taken from the current expiry
            // (DB arithmetic; a later renewal keeps its own term).
            let (to, ends): (DateTime<Utc>, bool) =
                sqlx::query_as("SELECT $1 - ($2 - $3), $1 - ($2 - $3) <= now()")
                    .bind(cur)
                    .bind(added_to)
                    .bind(base)
                    .fetch_one(&mut *conn)
                    .await?;
            Ok(if ends {
                cancel(plan_name, expires_at)
            } else {
                Effect::Rollback {
                    user_plan_id: up,
                    plan_name,
                    from: cur,
                    to,
                }
            })
        }
        "switch" => {
            let prior = uuid_at(&r, "/prior/user_plan_id");
            let used = r
                .pointer("/prior/used_bytes")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            // The replaced subscription comes back unless it has expired.
            let restorable: Option<(String, Option<DateTime<Utc>>)> = match prior {
                None => None,
                Some(p) => {
                    sqlx::query_as(
                        "SELECT pl.name, up.expires_at FROM user_plans up \
                         JOIN plans pl ON pl.id = up.plan_id \
                         WHERE up.id = $1 AND up.user_id = $2 AND up.status = 'replaced' \
                         AND (up.expires_at IS NULL OR up.expires_at > now())",
                    )
                    .bind(p)
                    .bind(user)
                    .fetch_optional(&mut *conn)
                    .await?
                }
            };
            Ok(match (prior, restorable) {
                (Some(prior), Some((name, exp))) => Effect::Restore {
                    user_plan_id: up,
                    prior_user_plan_id: prior,
                    plan_name: name,
                    expires_at: exp,
                    prior_used_bytes: used,
                },
                _ => cancel(plan_name, expires_at),
            })
        }
        _ => Ok(cancel(plan_name, expires_at)),
    }
}

/// (status, refunded_at, user_id, amount, balance part, balance_state,
/// an original-route refund in progress).
type RefundRow = (
    String,
    Option<DateTime<Utc>>,
    Option<Uuid>,
    i64,
    i64,
    String,
    bool,
);

async fn refundable(
    conn: &mut PgConnection,
    order_id: Uuid,
    lock: bool,
) -> Result<RefundRow, ApiError> {
    let row: Option<RefundRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT status, refunded_at, user_id, amount_cents, balance_cents, balance_state, \
         COALESCE(refund_request->>'state' = 'pending', false) \
         FROM orders WHERE id = $1{}",
        if lock { " FOR UPDATE" } else { "" }
    )))
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Err(ApiError::not_found());
    };
    if row.0 != "paid" {
        return Err(conflict!(
            "order_admin.refund_not_paid",
            "only a paid order can be refunded"
        ));
    }
    if row.1.is_some() {
        return Err(conflict!(
            "order_admin.already_refunded",
            "the order was already refunded"
        ));
    }
    if row.6 {
        return Err(conflict!(
            "order_admin.refund_in_progress",
            "a refund through the payment provider is in progress"
        ));
    }
    Ok(row)
}

/// `GET /orders/{id}/refund-preview`: the money and the subscription
/// effect a refund would have now (409 like the refund when the order is
/// not refundable).
pub async fn preview(conn: &mut PgConnection, order_id: Uuid) -> Result<Value, ApiError> {
    let (_, _, _, amount, balance, balance_state, _) = refundable(conn, order_id, false).await?;
    let effect = effect(conn, order_id).await?;
    let commission = super::commission::refund_preview(conn, order_id).await?;
    let coupon: Option<String> = sqlx::query_scalar(
        "SELECT c.code FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id \
         WHERE r.order_id = $1 AND r.status = 'redeemed'",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(json!({
        "balance_part_cents": if balance_state == "held" { balance } else { 0 },
        "amount_cents": amount,
        "effect": effect.to_json(),
        "commission": commission,
        // 低-2: the coupon whose use the refund gives back.
        "coupon_released": coupon,
    }))
}

/// What the admin asked for.
#[derive(Clone, Copy, Debug)]
pub struct Refund<'a> {
    pub reason: &'a str,
    /// Credit the gateway amount to the balance too (else it was refunded
    /// in the provider's console).
    pub to_balance: bool,
    /// Without `to_balance` (and with a gateway amount): what was refunded
    /// in the provider's console, 0..=the order's gateway amount (中-3).
    pub external_cents: Option<i64>,
    /// Refund the money only; the subscription stays as it is.
    pub keep_plan: bool,
    /// The portal link of the customer's refund notice (None: no link).
    pub portal: Option<&'a str>,
}

impl Refund<'_> {
    /// The out-of-band part of a refund of `amount` gateway cents
    /// (400 when it does not fit the request).
    fn external(&self, amount: i64) -> Result<i64, ApiError> {
        match (self.to_balance, self.external_cents) {
            (true, None | Some(0)) => Ok(0),
            (true, Some(_)) => Err(bad_request!(
                "order_admin.refund_external_with_balance",
                "the gateway amount goes to the balance; do not also record an external refund"
            )),
            (false, None) if amount > 0 => Err(bad_request!(
                "order_admin.refund_external_required",
                "enter the amount refunded in the payment provider's console (external_cents)"
            )),
            (false, None) => Ok(0),
            (false, Some(c)) if (0..=amount).contains(&c) => Ok(c),
            (false, Some(_)) => Err(bad_request!(
                "order_admin.refund_external_range",
                "external_cents must be 0..={amount_cents}",
                amount_cents = amount
            )),
        }
    }
}

/// Refund a paid order once (409 afterwards), in the caller's transaction:
/// money, the subscription effect (see the module docs), the pending invite
/// commission reversed. Audited `order.refund` (+ `user.plan.refund`).
pub async fn apply_refund(
    conn: &mut PgConnection,
    actor: &Actor,
    order_id: Uuid,
    req: &Refund<'_>,
) -> Result<Value, ApiError> {
    crate::entitle::lock(conn).await?;
    let (_, _, user, amount, balance, balance_state, _) = refundable(conn, order_id, true).await?;
    let external = req.external(amount)?;
    let effect = if req.keep_plan {
        Effect::none(Unchanged::KeepPlan)
    } else {
        effect(conn, order_id).await?
    };
    let balance_part = if balance_state == "held" { balance } else { 0 };
    let cash_part = if req.to_balance { amount } else { 0 };
    let credit = balance_part + cash_part;
    let user = match (user, credit > 0) {
        (Some(u), _) => Some(u),
        (None, false) => None,
        (None, true) => {
            return Err(conflict!(
                "order_admin.refund_user_gone",
                "the user no longer exists; refund out of band without to_balance"
            ));
        }
    };
    // 低-2: the coupon use comes back (lock order: orders → coupons).
    let coupon_released = super::coupons::release_refunded(conn, order_id).await?;
    if let (Some(user), Some(revoke)) = (user, effect.revoke()) {
        crate::plans::apply_refund_revoke(conn, actor, user, order_id, revoke).await?;
    }
    let commission =
        super::commission::reverse_for_order(conn, actor, order_id, "order refunded").await?;
    let (commission, clawback) = match commission {
        Some(u) => (Some(u.status), u.clawback),
        None => (None, None),
    };
    if let (Some(user), true) = (user, credit > 0) {
        let mut e = super::ledger::Entry::new(user, super::ledger::Kind::RefundToBalance, credit);
        e.order_id = Some(order_id);
        e.reason = Some(req.reason);
        super::ledger::apply_entry(conn, actor, &e).await?;
    }
    let effect_json = effect.to_json();
    sqlx::query(
        "UPDATE orders SET refunded_at = now(), refund_cents = $2 + $5, refund_reason = $3, \
         refund_effect = $4, refund_balance_cents = $2, refund_external_cents = $5, \
         refund_gateway_cents = $6, \
         balance_state = CASE WHEN balance_state = 'held' THEN 'refunded' ELSE balance_state END \
         WHERE id = $1",
    )
    .bind(order_id)
    .bind(credit)
    .bind(req.reason)
    .bind(&effect_json)
    .bind(external)
    .bind(cash_part + external)
    .execute(&mut *conn)
    .await?;
    let after = json!({
        "refund_cents": credit + external,
        "refund_balance_cents": credit,
        "refund_external_cents": external,
        "refund_gateway_cents": cash_part + external,
        "to_balance": req.to_balance,
        "balance_part_cents": balance_part,
        "cash_part_cents": cash_part,
        "effect": effect_json,
        "commission": commission,
        "commission_clawback": clawback,
        "coupon_released": coupon_released,
        "reason": req.reason,
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
    // The customer's notice commits with the refund (savepoint: a mail
    // failure never rolls the refund back).
    crate::mail::notices::order_refunded(conn, order_id, req.portal).await?;
    Ok(after)
}

// ---------------------------------------------------------------------------
// ① Original route (the provider refunds)
// ---------------------------------------------------------------------------

/// `orders.refund_request` (migration 1018).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginalRequest {
    pub out_request_no: String,
    pub cents: i64,
    /// pending | done | failed.
    pub state: String,
    pub attempts: i32,
    pub last_error: Option<String>,
    pub reason: String,
    pub keep_plan: bool,
    pub actor_id: Option<Uuid>,
    pub actor_label: String,
    pub requested_at: DateTime<Utc>,
    /// The next reconcile attempt (pending).
    pub next_at: Option<DateTime<Utc>>,
    pub done_at: Option<DateTime<Utc>>,
}

/// After this many unanswered attempts the reconcile loop slows to hourly.
const BACKOFF_CAP_SECS: i64 = 3600;

fn backoff(attempts: i32) -> chrono::Duration {
    let secs = 60i64.saturating_mul(1i64 << attempts.clamp(0, 6));
    chrono::Duration::seconds(secs.min(BACKOFF_CAP_SECS))
}

/// What the admin asked for.
#[derive(Clone, Copy, Debug)]
pub struct Original<'a> {
    pub reason: &'a str,
    /// Of the gateway amount (None = all of it); partial refunds allowed.
    pub cents: Option<i64>,
    pub keep_plan: bool,
}

/// Start a refund through the order's provider (in the caller's short
/// transaction): the order must be refundable, its method must allow
/// original-route refunds, the amount 1..=the gateway amount. Records the
/// request (`pending`, a new request number unless a failed one is
/// repeated with the same amount) and audits `order.refund.request`.
pub async fn begin_original(
    conn: &mut PgConnection,
    state: &AppState,
    actor: &Actor,
    order_id: Uuid,
    req: &Original<'_>,
) -> Result<OriginalRequest, ApiError> {
    let (_, _, _, amount, _, _, _) = refundable(conn, order_id, true).await?;
    let (otn, method, prev): (String, Option<Uuid>, Option<Value>) = sqlx::query_as(
        "SELECT out_trade_no, payment_method_id, refund_request FROM orders WHERE id = $1",
    )
    .bind(order_id)
    .fetch_one(&mut *conn)
    .await?;
    let provider = method.and_then(|m| state.payments().provider(m));
    if !provider.as_ref().is_some_and(|p| p.refunds()) {
        return Err(conflict!(
            "order_admin.refund_original_unavailable",
            "this order's payment method does not allow original-route refunds"
        ));
    }
    let cents = req.cents.unwrap_or(amount);
    if amount <= 0 || !(1..=amount).contains(&cents) {
        return Err(bad_request!(
            "order_admin.refund_original_range",
            "the original-route refund must be 1..={amount_cents} cents",
            amount_cents = amount
        ));
    }
    let prev: Option<OriginalRequest> = prev.and_then(|v| serde_json::from_value(v).ok());
    // A failed request moved nothing: the same amount retries the same
    // number (idempotent), another amount gets the next number.
    let out_request_no = match &prev {
        Some(p) if p.cents == cents => p.out_request_no.clone(),
        Some(p) => {
            let n: u32 = p
                .out_request_no
                .rsplit_once('R')
                .and_then(|(_, n)| n.parse().ok())
                .unwrap_or(1);
            format!("{otn}R{}", n + 1)
        }
        None => format!("{otn}R1"),
    };
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *conn)
        .await?;
    let r = OriginalRequest {
        out_request_no,
        cents,
        state: "pending".into(),
        attempts: 0,
        last_error: None,
        reason: req.reason.to_string(),
        keep_plan: req.keep_plan,
        actor_id: actor.id,
        actor_label: actor.label.clone(),
        requested_at: now,
        next_at: Some(now + backoff(0)),
        done_at: None,
    };
    store(conn, order_id, &r).await?;
    crate::audit::record(
        conn,
        actor,
        "order.refund.request",
        "order",
        Some(order_id.to_string()),
        None,
        Some(json!({
            "out_request_no": r.out_request_no,
            "cents": r.cents,
            "keep_plan": r.keep_plan,
            "reason": r.reason,
        })),
    )
    .await?;
    Ok(r)
}

async fn store(conn: &mut PgConnection, order_id: Uuid, r: &OriginalRequest) -> sqlx::Result<()> {
    sqlx::query("UPDATE orders SET refund_request = $2 WHERE id = $1")
        .bind(order_id)
        .bind(serde_json::to_value(r).unwrap_or(Value::Null))
        .execute(conn)
        .await?;
    Ok(())
}

/// Where an original-route refund stands after `settle_original`.
#[derive(Debug, Clone, PartialEq)]
pub enum Settled {
    /// Confirmed and recorded (the `apply_refund` answer).
    Done(Value),
    /// The provider refused (nothing moved): its message.
    Failed(String),
    /// No answer yet: the reconcile loop keeps asking.
    Pending,
    /// Not pending any more (settled elsewhere meanwhile).
    Gone,
}

/// Ask the provider about the pending refund of `order_id` and settle it:
/// a retry (`attempts > 0`) queries first, then (not found) refunds again
/// with the same request number; a first attempt refunds. Confirmed →
/// `apply_refund` (+ state done) in one transaction; refused → failed
/// (audited `order.refund.failed`); no answer → pending with a backoff.
pub async fn settle_original(state: &AppState, order_id: Uuid) -> Result<Settled, ApiError> {
    let row: Option<(String, Option<Uuid>, Option<Value>)> = sqlx::query_as(
        "SELECT out_trade_no, payment_method_id, refund_request FROM orders WHERE id = $1",
    )
    .bind(order_id)
    .fetch_optional(state.pg())
    .await?;
    let Some((otn, method, Some(raw))) = row else {
        return Ok(Settled::Gone);
    };
    let Ok(r) = serde_json::from_value::<OriginalRequest>(raw) else {
        return Ok(Settled::Gone);
    };
    if r.state != "pending" {
        return Ok(Settled::Gone);
    }
    let provider = method.and_then(|m| state.payments().provider(m));
    let outcome: Result<RefundState, CallError> = match &provider {
        None => Err(CallError::Transport("payment method unavailable".into())),
        Some(p) => {
            let asked = if r.attempts > 0 {
                p.refund_query(&otn, &r.out_request_no).await
            } else {
                Ok(RefundState::NotFound)
            };
            match asked {
                Ok(RefundState::NotFound) => {
                    p.refund(RefundReq {
                        out_trade_no: &otn,
                        out_request_no: &r.out_request_no,
                        cents: r.cents,
                        reason: &r.reason,
                    })
                    .await
                }
                other => other,
            }
        }
    };
    let actor = Actor {
        id: r.actor_id,
        label: r.actor_label.clone(),
        ip: None,
    };
    let mut tx = state.pg().begin().await?;
    // Still ours? (Another instance may have settled it meanwhile.)
    let cur: Option<Value> =
        sqlx::query_scalar("SELECT refund_request FROM orders WHERE id = $1 FOR UPDATE")
            .bind(order_id)
            .fetch_one(&mut *tx)
            .await?;
    let still = cur
        .and_then(|v| serde_json::from_value::<OriginalRequest>(v).ok())
        .is_some_and(|c| c.state == "pending" && c.out_request_no == r.out_request_no);
    if !still {
        return Ok(Settled::Gone);
    }
    let mut next = r.clone();
    let settled = match outcome {
        Ok(RefundState::Refunded { cents }) if cents.is_none_or(|c| c >= r.cents) => {
            // Recorded like ③: the amount was refunded at the provider.
            let portal = crate::mail::portal_url(state);
            // The row lock above is the order's: `apply_refund` takes the
            // entitlement lock first, so release and redo in order.
            drop(tx);
            let mut tx = state.pg().begin().await?;
            crate::entitle::lock(&mut tx).await?;
            let cur: Option<Value> =
                sqlx::query_scalar("SELECT refund_request FROM orders WHERE id = $1 FOR UPDATE")
                    .bind(order_id)
                    .fetch_one(&mut *tx)
                    .await?;
            if !cur
                .and_then(|v| serde_json::from_value::<OriginalRequest>(v).ok())
                .is_some_and(|c| c.state == "pending" && c.out_request_no == r.out_request_no)
            {
                return Ok(Settled::Gone);
            }
            // Free the order for apply_refund (it refuses a pending one).
            next.state = "done".into();
            next.last_error = None;
            next.next_at = None;
            next.done_at = Some(Utc::now());
            store(&mut tx, order_id, &next).await?;
            let result = apply_refund(
                &mut tx,
                &actor,
                order_id,
                &Refund {
                    reason: &r.reason,
                    to_balance: false,
                    external_cents: Some(r.cents),
                    keep_plan: r.keep_plan,
                    portal: portal.as_deref(),
                },
            )
            .await?;
            tx.commit().await?;
            let mut result = result;
            result["original"] = json!({
                "out_request_no": r.out_request_no,
                "cents": r.cents,
            });
            return Ok(Settled::Done(result));
        }
        Ok(RefundState::Refunded { .. }) => {
            next.attempts += 1;
            next.last_error = Some("the provider confirmed a smaller amount".into());
            next.next_at = Some(Utc::now() + backoff(next.attempts));
            Settled::Pending
        }
        Ok(RefundState::NotFound) => {
            next.attempts += 1;
            next.last_error = Some("the provider does not know the refund yet".into());
            next.next_at = Some(Utc::now() + backoff(next.attempts));
            Settled::Pending
        }
        Err(CallError::Business {
            sub_code, sub_msg, ..
        }) => {
            next.state = "failed".into();
            next.attempts += 1;
            let detail = format!("{sub_code}: {sub_msg}");
            next.last_error = Some(detail.clone());
            next.next_at = None;
            crate::audit::record(
                &mut tx,
                &actor,
                "order.refund.failed",
                "order",
                Some(order_id.to_string()),
                None,
                Some(json!({ "out_request_no": r.out_request_no, "error": detail })),
            )
            .await?;
            Settled::Failed(detail)
        }
        Err(e) => {
            next.attempts += 1;
            next.last_error = Some(e.to_string());
            next.next_at = Some(Utc::now() + backoff(next.attempts));
            Settled::Pending
        }
    };
    store(&mut tx, order_id, &next).await?;
    tx.commit().await?;
    Ok(settled)
}

/// Reconcile: settle the pending original-route refunds that are due
/// (each claimed by pushing `next_at` out first, so instances do not race
/// on one). Returns how many were looked at.
pub async fn refund_tick(state: &AppState) -> Result<usize, ApiError> {
    let due: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE orders o SET refund_request = jsonb_set(o.refund_request, '{next_at}', \
             to_jsonb(now() + interval '5 minutes')) \
         FROM (SELECT id FROM orders \
               WHERE refund_request->>'state' = 'pending' \
               AND (refund_request->>'next_at')::timestamptz <= now() \
               ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED) d \
         WHERE o.id = d.id RETURNING o.id",
    )
    .fetch_all(state.pg())
    .await?;
    for id in &due {
        match settle_original(state, *id).await {
            Ok(Settled::Failed(e)) => {
                tracing::warn!(order = %id, error = e, "original-route refund refused")
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(order = %id, error = %e.message(), "original-route refund"),
        }
    }
    Ok(due.len())
}
