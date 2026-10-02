//! Request IDs for log correlation (M1-4).
//!
//! Applied only INSIDE the prefix gate, so it exists for accepted (prefixed)
//! requests only. Rejections never pass through it and never get the header:
//! the empty 404 stays byte-identical (a response that carries the marker
//! `reject::Rejected` is also left untouched here, because later layers
//! re-mint it).
//!
//! The ID is taken from the proxy's `X-Request-Id` when it is short and
//! printable (nginx `$request_id`, Caddy `{http.request.uuid}`), else minted.
//! It is put on a tracing span (so every log line a handler emits carries
//! it) and echoed in the response. The URI is deliberately not logged
//! anywhere: it can hold a subscription token.

use axum::extract::{MatchedPath, Request};
use axum::http::{HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;
use tracing::Instrument;

pub const HEADER: HeaderName = HeaderName::from_static("x-request-id");

fn acceptable(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

pub async fn layer(req: Request, next: Next) -> Response {
    let id = req
        .headers()
        .get(&HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|v| acceptable(v))
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_default();
    let span =
        tracing::info_span!("http", request_id = %id, method = %req.method(), route = %route);
    let mut res = next.run(req).instrument(span).await;
    if res.extensions().get::<crate::reject::Rejected>().is_none()
        && let Ok(v) = HeaderValue::from_str(&id)
    {
        res.headers_mut().insert(HEADER, v);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incoming_ids_are_validated() {
        assert!(acceptable("3f2a-91_b.c"));
        assert!(!acceptable(""));
        assert!(!acceptable("a b"));
        assert!(!acceptable("line\nbreak"));
        assert!(!acceptable(&"x".repeat(65)));
    }
}
