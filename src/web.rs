use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::json;

use crate::access::{self, Route, Via};
use crate::{
    account, alerts, api, audit, dashboard, nodeinstall, nodes, nodestat, nodetpl, plans, reject,
    rollout, servers, settings, spa, state::AppState, sub, tickets, updates,
};

/// The panel's HTTP service. D4/D11: `front` maps the public URL layout
/// (`access::route`: the portal at `/`, the console and every API under the
/// secret admin prefix, `/{sub_path}/{token}`, `/install/…`, `/pay/…`) onto
/// the internal routes `/_/…` and tags each request with its
/// `access::Via`; every other request — junk, a wrong or bare prefix, a
/// wrong host, an address outside the admin allowlist — is the same empty
/// 404 (reject.rs) without the security headers, so nothing behind the
/// admin prefix is observable without it.
pub fn router(state: AppState) -> Router {
    let inner = inner_router(state.clone());
    // A plain service (not a handler): nothing is added to the responses,
    // so a rejection stays the canonical empty 404.
    Router::new().fallback_service(tower::service_fn(move |req: Request| {
        let (state, inner) = (state.clone(), inner.clone());
        async move { Ok::<_, std::convert::Infallible>(front(state, inner, req).await) }
    }))
}

/// The front door: host gate (R22), then the URL layout. The admin prefix
/// is compared in constant time and, with an allowlist, only answers the
/// listed client addresses.
async fn front(state: AppState, inner: Router, mut req: Request) -> Response {
    use tower::ServiceExt as _;
    let host = settings::host_of(req.headers(), req.uri());
    if !state.settings().get().host_allowed(host.as_deref()) {
        return reject::not_found();
    }
    let layout = state.settings().access();
    let get = matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    );
    let (path, via) = match access::route(&layout, req.uri().path(), get) {
        Route::Reject => return reject::not_found(),
        Route::Inner { path, via } => (path, via),
        Route::Admin { path } => {
            let peer = req
                .extensions()
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|c| c.0.ip());
            let allowed = match peer {
                Some(p) => layout.admin_allowed(state.client_ip(p, req.headers())),
                None => layout.admin_allow.is_empty() && !layout.admin_locked,
            };
            if !allowed {
                return reject::not_found();
            }
            (path, Via::Admin)
        }
    };
    let pq = match req.uri().query() {
        Some(q) => format!("{path}?{q}"),
        None => path,
    };
    let Ok(uri) = pq.parse::<axum::http::Uri>() else {
        return reject::not_found();
    };
    *req.uri_mut() = uri;
    req.extensions_mut().insert(via);
    match inner.oneshot(req).await {
        Ok(r) => r,
        Err(e) => match e {},
    }
}

fn inner_router(state: AppState) -> Router {
    // Routes carry the internal prefix (`access::INNER`) as a {prefix} path
    // parameter (handlers ignore it); `front` is the only way in.
    let routes = Router::new()
        .route("/{prefix}/healthz", get(healthz))
        .merge(crate::access::routes())
        .merge(crate::billing::routes())
        .merge(crate::billing::methods::routes())
        // W15: registration / reset / invites / 系统设置 → 注册, 邮件.
        .merge(crate::signup::routes())
        .merge(crate::passkey::routes())
        .merge(crate::owner::routes())
        .merge(crate::mail::routes())
        // W22: traffic history (admin + /me/traffic).
        .merge(crate::trafficlog::routes())
        .merge(crate::batch::routes())
        .merge(crate::export::routes())
        // Ops: announcements, knowledge base, branding (logo/favicon served
        // publicly under the prefix with cache headers).
        .merge(crate::announcements::routes())
        .merge(crate::kb::routes())
        .merge(crate::branding::routes())
        .merge(crate::sysstatus::routes())
        // W29: node block rules (审计规则) and the per-node switch.
        .merge(crate::blockrules::routes())
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
            get(api::user_detail)
                .patch(api::update_user)
                .delete(api::delete_user),
        )
        .route(
            "/{prefix}/api/v1/users/{id}/delete-impact",
            get(api::user_delete_impact),
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
            "/{prefix}/api/v1/users/{id}/plan",
            get(plans::get_user_plan)
                .put(plans::set_user_plan)
                .patch(plans::renew_user_plan)
                .delete(plans::cancel_user_plan),
        )
        .route(
            "/{prefix}/api/v1/users/{id}/plan/reset-traffic",
            post(plans::reset_user_traffic),
        )
        .route("/{prefix}/api/v1/users/{id}/ban", post(api::ban_user))
        .route("/{prefix}/api/v1/users/{id}/unban", post(api::unban_user))
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
            "/{prefix}/api/v1/plans/{id}/impact",
            axum::routing::post(plans::plan_impact),
        )
        // Q1: servers (machines, agents) and their nodes (one inbound each).
        .route(
            "/{prefix}/api/v1/servers",
            get(servers::list_servers).post(servers::create_server),
        )
        .route(
            "/{prefix}/api/v1/servers/{id}",
            get(servers::get_server)
                .patch(servers::update_server)
                .delete(servers::delete_server),
        )
        .route(
            "/{prefix}/api/v1/servers/{id}/enroll-token",
            post(servers::issue_enroll_token),
        )
        .route(
            "/{prefix}/api/v1/servers/{id}/install",
            post(nodeinstall::issue_install),
        )
        // W17: per-server alert overrides.
        .route(
            "/{prefix}/api/v1/servers/{id}/alert-rules",
            get(alerts::get_server_rules).put(alerts::put_server_rules),
        )
        // W11: machine status, history, "立即测速".
        .route(
            "/{prefix}/api/v1/servers/{id}/status",
            get(nodestat::server_status),
        )
        .route(
            "/{prefix}/api/v1/servers/{id}/metrics",
            get(nodestat::server_metrics),
        )
        .route(
            "/{prefix}/api/v1/servers/{id}/probe",
            post(nodestat::request_probe),
        )
        .route(
            "/{prefix}/api/v1/nodes",
            get(nodes::list_nodes).post(nodes::create_node),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}",
            get(nodes::get_node)
                .patch(nodes::update_node)
                .delete(nodes::delete_node),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}/inbound",
            put(nodes::set_inbound),
        )
        .route(
            "/{prefix}/api/v1/entrances/{id}",
            axum::routing::patch(crate::entrances::update_entrance)
                .delete(crate::entrances::delete_entrance),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}/entrances",
            post(crate::entrances::create_relay),
        )
        .route(
            "/{prefix}/api/v1/entrances/{id}/rate-rules",
            put(crate::rates::set_rules),
        )
        // The portal node list.
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
        .route("/{prefix}/api/v1/dashboard", get(dashboard::get_dashboard))
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
        .route("/{prefix}/api/v1/settings/site", put(settings::put_site))
        .route(
            "/{prefix}/api/v1/settings/subscription",
            put(settings::put_subscription),
        )
        .route(
            "/{prefix}/api/v1/settings/nodes",
            put(settings::put_node_ops),
        )
        .route(
            "/{prefix}/api/v1/settings/security",
            put(settings::put_security),
        )
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
            "/{prefix}/api/v1/agent-updates",
            get(crate::updatecheck::get_status),
        )
        .route(
            "/{prefix}/api/v1/agent-updates/settings",
            put(crate::updatecheck::put_settings),
        )
        .route(
            "/{prefix}/api/v1/agent-updates/check",
            post(crate::updatecheck::post_check),
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
        .layer(middleware::from_fn(prefix_gate))
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

/// Defense in depth behind `front` (the only way in): an internal path
/// with a `Via` tag, nothing else.
async fn prefix_gate(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let stripped = path.strip_prefix('/').unwrap_or(path);
    let (seg, rest) = match stripped.split_once('/') {
        Some((seg, rest)) => (seg, rest),
        None => (stripped, ""),
    };
    if seg != access::INNER || rest.is_empty() || req.extensions().get::<Via>().is_none() {
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
    use crate::testdb::TestDb;
    use crate::testdb::http::{Client, rand_ip};
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
        // (`/` is the portal since D11: access::tests.)
        for path in [
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
