use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::json;
use subtle::ConstantTimeEq;

use crate::{api, reject, spa, state::AppState, sub};

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
        .route("/{prefix}/app", get(spa::index))
        .route("/{prefix}/app/{*rest}", get(spa::index))
        .route("/{prefix}/assets/{*path}", get(spa::asset))
        .route("/{prefix}/sub/{token}", get(sub::subscription))
        .route("/{prefix}/auth/login", post(api::login))
        .route("/{prefix}/auth/logout", post(api::logout))
        .route("/{prefix}/api/v1/me", get(api::me))
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
            "/{prefix}/api/v1/users/{id}/nodes/{node_id}",
            post(api::assign_user).delete(api::unassign_user),
        )
        .route("/{prefix}/api/v1/nodes", get(api::list_nodes))
        .route(
            "/{prefix}/api/v1/nodes/{id}",
            axum::routing::patch(api::update_node).delete(api::delete_node),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}/inbounds",
            put(api::set_inbounds),
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
/// who knows the prefix).
async fn prefix_gate(State(state): State<AppState>, req: Request, next: Next) -> Response {
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
    let mut res = next.run(req).await;
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
            "default-src 'self'; style-src 'unsafe-inline'",
        ),
    ] {
        h.entry(name).or_insert(HeaderValue::from_static(value));
    }
    res
}

/// Liveness for the panel itself, behind the secret prefix (knowing the
/// prefix is the gate).
async fn healthz() -> Response {
    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

async fn rejected() -> Response {
    reject::not_found()
}
