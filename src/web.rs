use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::json;
use subtle::ConstantTimeEq;

use crate::{
    account, alerts, api, audit, nodeinstall, nodestat, nodetpl, plans, reject, rollout, settings,
    spa, state::AppState, sub, tickets, updates,
};

pub fn router(state: AppState) -> Router {
    // Routes carry the secret prefix as a {prefix} path parameter (handlers
    // ignore it). The gate layer wraps every route and the fallback: it runs
    // after route matching but before any handler, validating the first path
    // segment in constant time. Every rejection — "/", junk URLs, wrong or
    // bare prefix, wrong method — is the same empty 404 (reject.rs) without
    // the security headers, so nothing about the panel is observable without
    // the prefix.
    let routes = Router::new()
        .route("/{prefix}/healthz", get(healthz))
        .merge(crate::billing::routes())
        // W15: registration / reset / invites / 系统设置 → 注册, 邮件.
        .merge(crate::signup::routes())
        .merge(crate::mail::routes())
        // W22: traffic history (admin + /me/traffic).
        .merge(crate::trafficlog::routes())
        // R23: two bundles. The user portal (and shared login) is public;
        // the admin console's index and assets answer admin sessions only
        // (everything else under /admin is the canonical rejection).
        .route("/{prefix}/app", get(spa::index))
        .route("/{prefix}/app/{*rest}", get(spa::index))
        .route("/{prefix}/assets/{*path}", get(spa::asset))
        .route("/{prefix}/admin", get(spa::admin_index))
        .route("/{prefix}/admin/assets/{*path}", get(spa::admin_asset))
        .route("/{prefix}/admin/{*rest}", get(spa::admin_index))
        .route("/{prefix}/sub/{token}", get(sub::subscription))
        .route("/{prefix}/install/{token}", get(nodeinstall::script))
        .route(
            "/{prefix}/install/{token}/agent/{sha256}",
            get(nodeinstall::binary),
        )
        .route("/{prefix}/auth/login", post(api::login))
        .route("/{prefix}/auth/logout", post(api::logout))
        .route("/{prefix}/api/v1/me", get(api::me))
        .route("/{prefix}/api/v1/me/totp", get(account::totp_status))
        .route(
            "/{prefix}/api/v1/me/totp/enroll",
            post(account::totp_enroll),
        )
        .route(
            "/{prefix}/api/v1/me/totp/confirm",
            post(account::totp_confirm),
        )
        .route(
            "/{prefix}/api/v1/me/totp/recovery-codes",
            post(account::regenerate_recovery_codes),
        )
        .route(
            "/{prefix}/api/v1/me/sub-token",
            post(account::regenerate_own_sub_token),
        )
        .route("/{prefix}/api/v1/me/plan", get(plans::my_plan))
        .route(
            "/{prefix}/api/v1/me/password",
            post(account::change_own_password),
        )
        .route("/{prefix}/api/v1/audit", get(audit::list))
        .route(
            "/{prefix}/api/v1/users",
            get(api::list_users).post(api::create_user),
        )
        .route(
            "/{prefix}/api/v1/users/{id}",
            axum::routing::patch(api::update_user).delete(api::delete_user),
        )
        .route(
            "/{prefix}/api/v1/users/{id}/revoke-sessions",
            post(api::revoke_sessions),
        )
        .route(
            "/{prefix}/api/v1/users/{id}/sub-token",
            post(api::regenerate_sub_token),
        )
        .route(
            "/{prefix}/api/v1/users/{id}/subscription",
            get(api::user_subscription),
        )
        .route(
            "/{prefix}/api/v1/users/{id}/totp",
            axum::routing::delete(api::reset_totp),
        )
        .route("/{prefix}/api/v1/users/{id}/nodes", get(api::user_nodes))
        .route(
            "/{prefix}/api/v1/users/{id}/nodes/{node_id}",
            post(api::assign_user).delete(api::unassign_user),
        )
        .route(
            "/{prefix}/api/v1/users/{id}/plan",
            get(plans::get_user_plan)
                .put(plans::set_user_plan)
                .patch(plans::update_user_plan)
                .delete(plans::cancel_user_plan),
        )
        .route(
            "/{prefix}/api/v1/node-groups",
            get(plans::list_groups).post(plans::create_group),
        )
        .route(
            "/{prefix}/api/v1/node-groups/{id}",
            axum::routing::patch(plans::update_group).delete(plans::delete_group),
        )
        .route(
            "/{prefix}/api/v1/plans",
            get(plans::list_plans).post(plans::create_plan),
        )
        .route(
            "/{prefix}/api/v1/plans/{id}",
            axum::routing::patch(plans::update_plan).delete(plans::delete_plan),
        )
        .route(
            "/{prefix}/api/v1/nodes",
            get(api::list_nodes).post(api::create_node),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}/enroll-token",
            post(api::issue_enroll_token),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}",
            get(api::get_node)
                .patch(api::update_node)
                .delete(api::delete_node),
        )
        // W17: per-node alert overrides.
        .route(
            "/{prefix}/api/v1/nodes/{id}/alert-rules",
            get(alerts::get_node_rules).put(alerts::put_node_rules),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}/inbounds",
            put(api::set_inbounds),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}/install",
            post(nodeinstall::issue_install),
        )
        // W11: machine status, history, "立即测速"; the portal node list.
        .route(
            "/{prefix}/api/v1/nodes/{id}/status",
            get(nodestat::node_status),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}/metrics",
            get(nodestat::node_metrics),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}/probe",
            post(nodestat::request_probe),
        )
        .route("/{prefix}/api/v1/me/nodes", get(nodestat::my_nodes))
        // W17: support tickets (customers: own tickets only; staff: all).
        .route(
            "/{prefix}/api/v1/me/tickets",
            get(tickets::my_tickets).post(tickets::create_my_ticket),
        )
        .route("/{prefix}/api/v1/me/tickets/{id}", get(tickets::my_ticket))
        .route(
            "/{prefix}/api/v1/me/tickets/{id}/replies",
            post(tickets::reply_my_ticket),
        )
        .route(
            "/{prefix}/api/v1/me/tickets/{id}/close",
            post(tickets::close_my_ticket),
        )
        .route("/{prefix}/api/v1/tickets", get(tickets::list_tickets))
        .route("/{prefix}/api/v1/tickets/{id}", get(tickets::get_ticket))
        .route(
            "/{prefix}/api/v1/tickets/{id}/replies",
            post(tickets::reply_ticket),
        )
        .route(
            "/{prefix}/api/v1/tickets/{id}/close",
            post(tickets::close_ticket),
        )
        .route(
            "/{prefix}/api/v1/tickets/{id}/reopen",
            post(tickets::reopen_ticket),
        )
        .route(
            "/{prefix}/api/v1/tickets/{id}/assignee",
            put(tickets::assign_ticket),
        )
        .route("/{prefix}/api/v1/admins", get(tickets::list_admins))
        .route("/{prefix}/api/v1/admin-badges", get(tickets::badges))
        // W17: node alerts (alert center, settings, channels).
        .route("/{prefix}/api/v1/alerts", get(alerts::list_alerts))
        .route(
            "/{prefix}/api/v1/alerts/settings",
            get(alerts::get_settings).put(alerts::put_settings),
        )
        .route("/{prefix}/api/v1/alerts/test", post(alerts::test_channel))
        .route(
            "/{prefix}/api/v1/alerts/notifications",
            get(alerts::list_notifications),
        )
        .route(
            "/{prefix}/api/v1/alerts/notifications/{id}/retry",
            post(alerts::retry_notification),
        )
        .route("/{prefix}/api/v1/alerts/{id}/ack", post(alerts::ack_alert))
        .route("/{prefix}/api/v1/inbound-templates", get(nodetpl::catalog))
        .route(
            "/{prefix}/api/v1/inbound-templates/render",
            post(nodetpl::render_templates),
        )
        .route(
            "/{prefix}/api/v1/inbound-templates/check-dest",
            post(nodetpl::check_dest),
        )
        .route(
            "/{prefix}/api/v1/inbound-templates/check-domain",
            post(nodetpl::check_domain),
        )
        .route(
            "/{prefix}/api/v1/settings",
            get(settings::get_settings).put(settings::put_settings),
        )
        .route("/{prefix}/api/v1/settings/probe", put(settings::put_probe))
        .route(
            "/{prefix}/api/v1/settings/dns-check",
            post(settings::dns_check),
        )
        .route(
            "/{prefix}/api/v1/settings/server-names/remove",
            post(settings::remove_server_name),
        )
        .route(
            "/{prefix}/api/v1/agent-releases",
            get(updates::list_releases).post(updates::create_release),
        )
        .route(
            "/{prefix}/api/v1/agent-releases/{id}",
            axum::routing::delete(updates::delete_release),
        )
        .route(
            "/{prefix}/api/v1/agent-releases/{id}/binary",
            put(updates::upload_binary),
        )
        .route(
            "/{prefix}/api/v1/rollouts",
            get(rollout::list_rollouts).post(rollout::create_rollout),
        )
        .route("/{prefix}/api/v1/rollouts/{id}", get(rollout::get_rollout))
        .route(
            "/{prefix}/api/v1/rollouts/{id}/pause",
            post(rollout::pause_rollout),
        )
        .route(
            "/{prefix}/api/v1/rollouts/{id}/resume",
            post(rollout::resume_rollout),
        )
        .route(
            "/{prefix}/api/v1/rollouts/{id}/abort",
            post(rollout::abort_rollout),
        )
        .fallback(rejected)
        // Otherwise a wrong method on a real route (GET /{p}/auth/login)
        // answers 405 + Allow: a prefix oracle.
        .method_not_allowed_fallback(rejected)
        // Inside the gate: request IDs exist for accepted requests only.
        .layer(middleware::from_fn(crate::request_id::layer))
        .layer(middleware::from_fn_with_state(state.clone(), prefix_gate))
        // Outside the gate, observation only (separate metrics listener).
        .layer(middleware::from_fn(crate::metrics::track_http))
        .with_state(state);
    // `Router::layer` wraps each method handler *inside* its MethodRouter,
    // which appends `Allow` on a method mismatch after those layers run.
    // Wrapping the finished router as one service puts security_headers
    // outside everything, so it sees (and re-mints) the final response.
    Router::new()
        .fallback_service(routes)
        .layer(middleware::from_fn(security_headers))
}

/// Constant-time check of the first path segment against the secret
/// prefix. A bare correct prefix is rejected too (stealthy even for someone
/// who knows the prefix). R22 host gate: once the main domain is set in the
/// system settings, a request addressed to any other DNS name (Host) gets
/// the same canonical rejection, on every path (IP-literal hosts stay
/// allowed; `settings::Effective::host_allowed`).
async fn prefix_gate(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let host = settings::host_of(req.headers(), req.uri());
    if !state.settings().get().host_allowed(host.as_deref()) {
        return reject::not_found();
    }
    let path = req.uri().path();
    let stripped = path.strip_prefix('/').unwrap_or(path);
    let (seg, rest) = match stripped.split_once('/') {
        Some((seg, rest)) => (seg, rest),
        None => (stripped, ""),
    };
    let expected = state.route_prefix();
    if seg.len() != expected.len() || !bool::from(seg.as_bytes().ct_eq(expected.as_bytes())) {
        return reject::not_found();
    }
    if rest.is_empty() {
        return reject::not_found();
    }
    next.run(req).await
}

/// Security headers for real (prefixed, accepted) responses only. They are
/// deliberately absent from rejections: that header combination on a 404
/// would fingerprint the panel.
async fn security_headers(req: Request, next: Next) -> Response {
    // Captured before the request is consumed; logged only redacted.
    let path = redacted_path(req.uri().path());
    let mut res = next.run(req).await;
    if res.status().is_server_error() {
        tracing::warn!(path = %path, status = res.status().as_u16(), "request failed");
    }
    if res.extensions().get::<reject::Rejected>().is_some() {
        // Re-mint the canonical rejection: axum appends headers after the
        // fallback runs (e.g. `Allow` on a method mismatch), and any such
        // header would reveal that a real route exists under the prefix.
        return reject::not_found();
    }
    let h = res.headers_mut();
    for (name, value) in [
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::REFERRER_POLICY, "no-referrer"),
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'self'; style-src 'self' 'unsafe-inline'",
        ),
    ] {
        h.entry(name).or_insert(HeaderValue::from_static(value));
    }
    res
}

/// A request path safe to log: the secret route prefix and subscription
/// tokens are replaced (`/{prefix}/sub/{token}`). Any request logging,
/// tracing span or metric label must use this (or the matched route
/// template), never the raw URI — the prefix and the tokens are
/// credentials. Query strings are dropped.
pub fn redacted_path(path: &str) -> String {
    let path = path.split('?').next().unwrap_or("");
    let mut segs = path.split('/').skip(1);
    let Some(_prefix) = segs.next() else {
        return "/".into();
    };
    let rest: Vec<&str> = segs.collect();
    let mut out = String::from("/{prefix}");
    for (i, seg) in rest.iter().enumerate() {
        out.push('/');
        if i == 1 && matches!(rest.first(), Some(&"sub") | Some(&"install")) {
            out.push_str("{token}");
        } else {
            out.push_str(seg);
        }
    }
    out
}

/// Liveness for the panel itself, behind the secret prefix (knowing the
/// prefix is the gate).
async fn healthz() -> Response {
    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

async fn rejected() -> Response {
    reject::not_found()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::http::{rand_ip, Client};
    use crate::testdb::TestDb;
    use axum::http::Method;

    /// A10: every rejection the gate (or a fallback) produces is
    /// byte-identical to the canonical one: wrong or bare prefix, prefix
    /// of the wrong length, unknown route, wrong method on a real route.
    #[tokio::test]
    async fn prefix_gate_rejections_are_byte_identical() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let c = Client::new(&state, rand_ip());
        let canonical = c.get("/definitely/not/here").await.fingerprint();
        assert_eq!(canonical.0, StatusCode::NOT_FOUND);
        assert!(
            canonical.1.is_empty() && canonical.2.is_empty(),
            "{canonical:?}"
        );
        for path in [
            "/",
            "/test",
            "/test/",
            "/tes/healthz",
            "/testx/healthz",
            "/TEST/healthz",
            "/test/no-such-route",
            "/test/api/v1/nothing",
            "/test/auth/login", // GET on a POST route
        ] {
            assert_eq!(c.get(path).await.fingerprint(), canonical, "GET {path}");
        }
        for (m, path) in [
            (Method::PUT, "/test/healthz"),
            (Method::DELETE, "/test/healthz"),
            (Method::POST, "/"),
            (Method::POST, "/wrong/auth/login"),
        ] {
            assert_eq!(
                c.req(m.clone(), path, None).await.fingerprint(),
                canonical,
                "{m} {path}"
            );
        }
        // Control: the right prefix does reach a real route.
        assert_eq!(c.get("/test/healthz").await.status, StatusCode::OK);
        db.drop().await;
    }

    #[test]
    fn redacted_paths_hide_prefix_and_tokens() {
        for (raw, want) in [
            ("/0123abcd/sub/SECRET-TOKEN", "/{prefix}/sub/{token}"),
            ("/0123abcd/sub/SECRET-TOKEN?x=1", "/{prefix}/sub/{token}"),
            ("/0123abcd/sub/SECRET/extra", "/{prefix}/sub/{token}/extra"),
            ("/0123abcd/install/SECRET", "/{prefix}/install/{token}"),
            (
                "/0123abcd/install/SECRET/agent/ab12",
                "/{prefix}/install/{token}/agent/ab12",
            ),
            ("/0123abcd/api/v1/users", "/{prefix}/api/v1/users"),
            ("/0123abcd", "/{prefix}"),
            ("/", "/{prefix}"),
            ("", "/"),
        ] {
            let got = redacted_path(raw);
            assert_eq!(got, want, "{raw}");
            assert!(!got.contains("SECRET") && !got.contains("0123abcd"));
        }
    }
}
