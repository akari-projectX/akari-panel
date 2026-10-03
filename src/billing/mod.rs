//! R18-3 billing: plan prices, orders and payments (R40: pluggable
//! payment providers; Alipay Face-to-Face is the first kind).
//!
//! - `provider`: the `PaymentProvider` / `ProviderKind` traits + registry.
//! - `methods`: configured payment methods (系统设置 → 支付, DB only),
//!   their per-instance clients, the legacy panel.toml import.
//! - `alipay`: RSA2 signing/verification, the gateway calls, the
//!   `alipay_f2f` provider kind.
//! - `http`: the minimal HTTPS client those calls use.
//! - `orders`: order lifecycle; `apply_mark_paid` is THE paid transition
//!   (entitle::lock → conditional UPDATE → fulfil via plans::apply_* →
//!   audit, one transaction, exactly once).
//! - `catalog`: W7 period kinds, prices, sale rules, proration credit.
//! - `api`: user shop/orders, admin orders, the async notify.
//! - `coupons` (W16): coupon CRUD, eligibility (shop + order creation),
//!   race-free reservation, release on unpaid end, redemption when paid.
//! - `ledger` (W16): the balance (余额) and its append-only ledger; every
//!   movement = one ledger row + one `balance.<kind>` audit row.
//! - `manual` (Ops): admin-created paid orders (gift or offline sale),
//!   paid through `orders::apply_mark_paid` (paid_via 'manual').
//! - `coupon_batches` (Ops): N random codes from one coupon template.
//! - `commission` (W16): invite commissions (created in apply_mark_paid,
//!   credited after the hold by an enforce pass, reversed by a refund) and
//!   withdrawals.
//!
//! Invariants (see CLAUDE.md "计费/支付"): integer cents, the amount is
//! copied from the price at order creation and is the only amount compared
//! with Alipay's; every notify rejection is `reject::not_found()`; every
//! state change writes an audit row in its transaction; no instance-local
//! state (claims and idempotency live in PostgreSQL).

pub mod alipay;
pub mod api;
pub mod catalog;
pub mod commission;
pub mod coupon_batches;
pub mod coupons;
pub mod http;
pub mod ledger;
pub mod manual;
pub mod methods;
pub mod orders;
pub mod provider;

#[cfg(test)]
mod tests;

use std::time::Duration;

use crate::state::AppState;

pub use api::routes;

/// Reconcile cadence (pending orders: query, expire + close).
const RECONCILE_EVERY: Duration = Duration::from_secs(10);
/// Junk-event pruning every N reconcile ticks (~1 h).
const PRUNE_EVERY_TICKS: u64 = 360;

/// Periodic reconcile of pending orders (every instance runs it; claims
/// make it safe) and pruning of junk payment events.
/// Each order is queried at its own method (`orders::reconcile_tick`);
/// methods may be switched on, off or re-keyed at any time.
pub async fn reconcile_loop(state: AppState) {
    let mut tick = tokio::time::interval(RECONCILE_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut n: u64 = 0;
    loop {
        tick.tick().await;
        if let Err(e) = orders::reconcile_tick(&state).await {
            tracing::warn!(error = e.message(), "order reconcile tick failed");
        }
        n += 1;
        if n.is_multiple_of(PRUNE_EVERY_TICKS)
            && let Err(e) = orders::prune_events(&state).await
        {
            tracing::warn!(error = %e, "payment event pruning failed");
        }
    }
}
