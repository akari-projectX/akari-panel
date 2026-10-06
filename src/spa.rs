//! The user portal (R23, D11): the embedded portal build at `/` of the
//! main domain (`spa/dist/app`). The admin app — its sign-in page under
//! `/{admin}/app` and the console under `/{admin}/admin` — is a separate
//! build served by `console.rs`; nothing of it ships to users
//! (spa/scripts/check-bundles.mjs, admin/scripts/check-bundles.mjs, smoke).

use axum::extract::Path;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::reject;

// The compiled portal (spa/dist/app). build.rs drops a placeholder index
// on fresh clones so `cargo build` works without a node toolchain; `make
// spa` replaces it.
#[derive(RustEmbed)]
#[folder = "spa/dist/app"]
struct UserAssets;

/// The portal's pages at `/` (D11; `console::app_entry` hands them over).
/// Client-side routes all land here.
pub async fn index() -> Response {
    let Some(file) = UserAssets::get("index.html") else {
        return reject::not_found();
    };
    html_response(String::from_utf8_lossy(&file.data).into_owned(), "no-store")
}

/// User portal build assets: fingerprinted, cacheable forever, keyed on the
/// secret prefix.
pub async fn asset(Path((_, rel)): Path<(String, String)>) -> Response {
    let key = format!("assets/{rel}");
    match UserAssets::get(&key) {
        Some(file) => file_response(
            &key,
            file.data.to_vec(),
            "public, max-age=31536000, immutable",
        ),
        None => reject::not_found(),
    }
}

fn html_response(html: String, cache: &'static str) -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
        ],
        html,
    )
        .into_response()
}

fn file_response(key: &str, data: Vec<u8>, cache: &'static str) -> Response {
    let mime = mime_guess::from_path(key)
        .first_or_octet_stream()
        .to_string();
    let mime = HeaderValue::from_str(&mime)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
        ],
        data,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::testdb::TestDb;
    use crate::testdb::http::{Client, rand_ip};
    use axum::http::StatusCode;

    fn header(r: &crate::testdb::http::Resp, name: header::HeaderName) -> &str {
        r.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }

    /// The portal is public at `/` and its assets are immutable; it never
    /// references the admin app.
    #[tokio::test]
    async fn portal_is_public_and_immutable() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let c = Client::new(&state, rand_ip());
        for p in ["/", "/orders"] {
            let r = c.get(p).await;
            assert_eq!(r.status, StatusCode::OK, "{p}");
            assert_eq!(header(&r, header::CACHE_CONTROL), "no-store");
            let html = String::from_utf8_lossy(&r.body);
            assert!(!html.contains("/admin/"), "{html}");
        }
        if let Some(k) = UserAssets::iter().find(|k| k.starts_with("assets/")) {
            let r = c.get(&format!("/{k}")).await;
            assert_eq!(r.status, StatusCode::OK);
            assert_eq!(
                header(&r, header::CACHE_CONTROL),
                "public, max-age=31536000, immutable"
            );
        }
    }
}
