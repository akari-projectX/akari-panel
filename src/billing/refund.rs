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
//! `GET /orders/{id}/refund-preview` shows the same computation without
//! changing anything (the console's confirmation dialog).
//!
//! Lock order (as `orders::apply_mark_paid`): `entitle::lock` → the order
//! row → the subscription's nodes and user rows → commissions → balances.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

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

/// (status, refunded_at, user_id, amount, balance part, balance_state).
type RefundRow = (
    String,
    Option<DateTime<Utc>>,
    Option<Uuid>,
    i64,
    i64,
    String,
);

async fn refundable(
    conn: &mut PgConnection,
    order_id: Uuid,
    lock: bool,
) -> Result<RefundRow, ApiError> {
    let row: Option<RefundRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT status, refunded_at, user_id, amount_cents, balance_cents, balance_state \
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
    Ok(row)
}

/// `GET /orders/{id}/refund-preview`: the money and the subscription
/// effect a refund would have now (409 like the refund when the order is
/// not refundable).
pub async fn preview(conn: &mut PgConnection, order_id: Uuid) -> Result<Value, ApiError> {
    let (_, _, _, amount, balance, balance_state) = refundable(conn, order_id, false).await?;
    let effect = effect(conn, order_id).await?;
    let commission = super::commission::refund_preview(conn, order_id).await?;
    Ok(json!({
        "balance_part_cents": if balance_state == "held" { balance } else { 0 },
        "amount_cents": amount,
        "effect": effect.to_json(),
        "commission": commission,
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
    let (_, _, user, amount, balance, balance_state) = refundable(conn, order_id, true).await?;
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
         balance_state = CASE WHEN balance_state = 'held' THEN 'refunded' ELSE balance_state END \
         WHERE id = $1",
    )
    .bind(order_id)
    .bind(credit)
    .bind(req.reason)
    .bind(&effect_json)
    .bind(external)
    .execute(&mut *conn)
    .await?;
    let after = json!({
        "refund_cents": credit + external,
        "refund_balance_cents": credit,
        "refund_external_cents": external,
        "to_balance": req.to_balance,
        "balance_part_cents": balance_part,
        "cash_part_cents": cash_part,
        "effect": effect_json,
        "commission": commission,
        "commission_clawback": clawback,
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
    Ok(after)
}
