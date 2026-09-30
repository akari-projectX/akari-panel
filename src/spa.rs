use axum::extract::{Path, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::{decoy, state::AppState};

// The compiled SPA (panel/spa/dist). A placeholder index.html is committed so
// `cargo build` works without a node toolchain; `make spa` refreshes it.
#[derive(RustEmbed)]
#[folder = "spa/dist"]
struct SpaAssets;

/// The SPA entry point. Vite emits asset URLs rooted at "/assets/" — those
/// are rewritten to the secret prefix at serve time, because the random
/// prefix only exists on the server. Client-side routes (anything below
/// /app/) all land here.
pub async fn index(State(state): State<AppState>) -> Response {
    let Some(file) = SpaAssets::get("index.html") else {
        return decoy::not_found();
    };
    let prefix = state.route_prefix();
    let html = String::from_utf8_lossy(&file.data)
        .replace("href=\"/assets/", &format!("href=\"/{prefix}/assets/"))
        .replace("src=\"/assets/", &format!("src=\"/{prefix}/assets/"));
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        html,
    )
        .into_response()
}

/// Fingerprinted build assets: cacheable forever, keyed on the secret prefix.
pub async fn asset(Path((_, rel)): Path<(String, String)>) -> Response {
    let key = format!("assets/{rel}");
    let Some(file) = SpaAssets::get(&key) else {
        return decoy::not_found();
    };
    let mime = mime_guess::from_path(&key)
        .first_or_octet_stream()
        .to_string();
    let mime = HeaderValue::from_str(&mime)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    (
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            ),
        ],
        file.data.to_vec(),
    )
        .into_response()
}
