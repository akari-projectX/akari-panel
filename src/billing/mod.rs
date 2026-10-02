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

/// An explicit notify URL must carry this panel's route prefix (a rotated
/// prefix would silently break fulfilment by notify). An empty one is
/// derived per order (`notify_url`) and always carries the current prefix.
pub fn check_notify_prefix(cfg: &PanelConfig, prefix: &str) -> Result<(), String> {
    let a = &cfg.payments.alipay;
    if !a.enabled || a.notify_url.is_empty() {
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
             (see `akari info`; after `secrets rotate-prefix` update notify_url, or \
             leave it empty to derive it from the main domain)"
                .into(),
        );
    }
    Ok(())
}

/// The notify URL handed to Alipay with a new order: the explicit
/// `payments.alipay.notify_url`, else `<main domain>/<prefix>/pay/alipay/notify`
/// from the system settings (`settings::Effective::public_origin`: 系统设置
/// main domain, else `install.public_url`). None = neither is configured: no
/// order may be created (Alipay could never notify it; it is refused before
/// the order row exists). Contains the route prefix: never log it.
pub fn notify_url(state: &AppState, alipay: &alipay::Alipay) -> Option<String> {
    if let Some(n) = alipay.explicit_notify_url() {
        return Some(n.to_string());
    }
    let origin = state.settings().get().public_origin()?;
    Some(format!(
        "{origin}/{}/pay/alipay/notify",
        state.route_prefix()
    ))
}

/// Lower-case host of an explicit `payments.alipay.notify_url` (payments
/// enabled), for the host gate, the Caddy ask endpoint and the "differs
/// from the main domain" warnings. Never the URL itself (route prefix).
pub fn explicit_notify_host(cfg: &PanelConfig) -> Option<String> {
    let a = &cfg.payments.alipay;
    if !a.enabled || a.notify_url.is_empty() {
        return None;
    }
    let uri = a.notify_url.parse::<axum::http::Uri>().ok()?;
    let host = uri.host()?;
    Some(
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .trim_end_matches('.')
            .to_ascii_lowercase(),
    )
}

/// Advisory: the host of an explicit notify URL when it is not the main
/// domain's (`main_host`, lower case). Alipay then notifies that host; the
/// panel keeps accepting it (host gate, ask), but it is easy to forget when
/// the main domain moves.
pub fn notify_host_mismatch(cfg: &PanelConfig, main_host: Option<&str>) -> Option<String> {
    let notify = explicit_notify_host(cfg)?;
    (notify != main_host?).then_some(notify)
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
        if n.is_multiple_of(PRUNE_EVERY_TICKS) {
            if let Err(e) = orders::prune_events(&state).await {
                tracing::warn!(error = %e, "payment event pruning failed");
            }
        }
    }
}
