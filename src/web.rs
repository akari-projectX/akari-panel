use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::json;
use subtle::ConstantTimeEq;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::{api, decoy, spa, state::AppState, sub};

pub fn router(state: AppState) -> Router {
    // Routes carry the secret prefix as a {prefix} path parameter (handlers
    // ignore it). The gate layer wraps every route and the fallback: it runs
    // after route matching but before any handler, validating the first path
    // segment in constant time. Requests that guessed the prefix wrong — and
    // junk URLs alike — get the same decoy site, so nothing about the panel
    // is observable without the prefix.
    Router::new()
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
            axum::routing::patch(api::update_node),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}/inbounds",
            put(api::set_inbounds),
        )
        .fallback(decoy_404)
        .layer(middleware::from_fn_with_state(state.clone(), prefix_gate))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'self'; style-src 'unsafe-inline'"),
        ))
        .with_state(state)
}

/// "/" serves the decoy site itself; a bare correct prefix still 404s
/// (staying stealthy even for someone who knows the prefix); wrong prefixes
/// are byte-identical to other junk URLs.
async fn prefix_gate(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if path == "/" {
        return decoy::page();
    }
    let stripped = path.strip_prefix('/').unwrap_or(path);
    let (seg, rest) = match stripped.split_once('/') {
        Some((seg, rest)) => (seg, rest),
        None => (stripped, ""),
    };
    let expected = state.route_prefix();
    if seg.len() != expected.len() || !bool::from(seg.as_bytes().ct_eq(expected.as_bytes())) {
        return decoy::not_found();
    }
    if rest.is_empty() {
        return decoy::not_found();
    }
    next.run(req).await
}

/// Liveness for the panel itself, behind the secret prefix (knowing the
/// prefix is the gate).
async fn healthz() -> Response {
    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

async fn decoy_404() -> Response {
    decoy::not_found()
}
