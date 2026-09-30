use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// Response-extension marker: this response is a rejection. The outer
/// security-header layer (web.rs) leaves such responses untouched, because
/// a distinctive header set on a 404 would itself fingerprint the panel.
#[derive(Clone, Copy, Debug)]
pub struct Rejected;

/// The single rejection response: 404, empty body, no headers of our own.
/// Used for "/", unknown paths, wrong or bare prefix, wrong method, bad
/// subscription token, missing asset — all byte-identical (minus `Date`).
pub fn not_found() -> Response {
    let mut r = StatusCode::NOT_FOUND.into_response();
    r.extensions_mut().insert(Rejected);
    r
}
