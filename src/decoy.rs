use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

/// The camouflage site. Served at `/`, at every unknown path, and for any
/// request that does not know the secret route prefix. Identical bytes for
/// 200 and 404 keeps active probes from distinguishing anything.
pub const DECOY_HTML: &str = include_str!("decoy.html");

pub fn page() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        DECOY_HTML,
    )
        .into_response()
}

pub fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        DECOY_HTML,
    )
        .into_response()
}
