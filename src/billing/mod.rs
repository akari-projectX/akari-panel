//! R18-3 billing: plan prices, orders and Alipay Face-to-Face payments.
//!
//! - `alipay`: RSA2 signing/verification and the gateway calls.
//! - `http`: the minimal HTTPS client those calls use.
//! - `orders`: order lifecycle; `apply_mark_paid` is THE paid transition
//!   (entitle::lock → conditional UPDATE → fulfil via plans::apply_* →
//!   audit, one transaction, exactly once).
//! - `api`: user shop/orders, admin prices/orders, the async notify.
//!
//! Invariants (see CLAUDE.md "计费/支付"): integer cents, the amount is
//! copied from the price at order creation and is the only amount compared
//! with Alipay's; every notify rejection is `reject::not_found()`; every
//! state change writes an audit row in its transaction; no instance-local
//! state (claims and idempotency live in PostgreSQL).

pub mod alipay;
pub mod api;
pub mod http;
pub mod orders;

#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use crate::config::PanelConfig;
use crate::state::AppState;

pub use api::routes;

/// Reconcile cadence (pending orders: query, expire + close).
const RECONCILE_EVERY: Duration = Duration::from_secs(10);
/// Junk-event pruning every N reconcile ticks (~1 h).
const PRUNE_EVERY_TICKS: u64 = 360;

/// Load the configured Alipay keys (startup and `config check`). None when
/// payments are disabled.
pub fn load(cfg: &PanelConfig) -> Result<Option<alipay::Alipay>, String> {
    let a = &cfg.payments.alipay;
    if !a.enabled {
        return Ok(None);
    }
    alipay::Alipay::from_config(a).map(Some)
}

/// The notify URL must carry this panel's route prefix (a rotated prefix
/// would silently break fulfilment by notify).
pub fn check_notify_prefix(cfg: &PanelConfig, prefix: &str) -> Result<(), String> {
    let a = &cfg.payments.alipay;
    if !a.enabled {
        return Ok(());
    }
    let path = a
        .notify_url
        .parse::<axum::http::Uri>()
        .map(|u| u.path().to_string())
        .unwrap_or_default();
    if path != format!("/{prefix}/pay/alipay/notify") {
        return Err(
            "payments.alipay.notify_url does not carry this panel's route prefix \
             (see `akari info`; after `secrets rotate-prefix` update notify_url)"
                .into(),
        );
    }
    Ok(())
}

/// Periodic reconcile of pending orders (every instance runs it; claims
/// make it safe) and pruning of junk payment events.
pub async fn reconcile_loop(state: AppState) {
    let Some(alipay) = state.alipay() else {
        return;
    };
    let alipay: Arc<alipay::Alipay> = alipay.clone();
    let mut tick = tokio::time::interval(RECONCILE_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut n: u64 = 0;
    loop {
        tick.tick().await;
        if let Err(e) = orders::reconcile_tick(&state, &alipay).await {
            tracing::warn!(error = e.message(), "order reconcile tick failed");
        }
        n += 1;
        if n % PRUNE_EVERY_TICKS == 0 {
            if let Err(e) = orders::prune_events(&state).await {
                tracing::warn!(error = %e, "payment event pruning failed");
            }
        }
    }
}
