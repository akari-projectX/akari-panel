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
use crate::state::AppState;

// The compiled portal (spa/dist/app). build.rs drops a placeholder index
// on fresh clones so `cargo build` works without a node toolchain; `make
// spa` replaces it.
#[derive(RustEmbed)]
#[folder = "spa/dist/app"]
struct UserAssets;

// Portal v2 (Svelte, portal/dist/app; `make portal`), served instead of the
// React portal only while `AKARI_PORTAL_V2=1` is set (preview until the
// cutover PR; portal/CLAUDE.md). Same placeholder rule in build.rs.
#[derive(RustEmbed)]
#[folder = "portal/dist/app"]
struct PortalAssets;

/// The opt-in switch for portal v2 (env, read once at startup).
pub const PORTAL_V2_ENV: &str = "AKARI_PORTAL_V2";

static PORTAL_V2: std::sync::LazyLock<bool> =
    std::sync::LazyLock::new(|| std::env::var(PORTAL_V2_ENV).is_ok_and(|v| v.trim() == "1"));

/// Whether this process serves portal v2 instead of the React portal.
pub fn portal_v2() -> bool {
    *PORTAL_V2
}

/// One embedded portal file: portal v2 when `v2`, else the React portal.
fn file(v2: bool, key: &str) -> Option<rust_embed::EmbeddedFile> {
    if v2 {
        PortalAssets::get(key)
    } else {
        UserAssets::get(key)
    }
}

/// The portal's pages at `/` (D11; `console::app_entry` hands them over).
/// Client-side routes all land here.
pub async fn index(state: &AppState) -> Response {
    let Some(file) = file(portal_v2(), "index.html") else {
        return reject::not_found();
    };
    let html = String::from_utf8_lossy(&file.data).into_owned();
    let mut res = html_response(html, "no-store");
    if turnstile_on(state).await {
        res.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(crate::web::CSP_TURNSTILE),
        );
    }
    res
}

/// Whether the portal page must allow Turnstile (settings read per request,
/// like the forms do). Unreadable settings keep the strict policy: the forms
/// refuse every submission then anyway.
async fn turnstile_on(state: &AppState) -> bool {
    let Ok(mut c) = state.pg().acquire().await else {
        return false;
    };
    crate::botguard::load(&mut c)
        .await
        .is_ok_and(|s| s.turnstile_on())
}

/// User portal build assets: fingerprinted, cacheable forever, keyed on the
/// secret prefix.
pub async fn asset(Path((_, rel)): Path<(String, String)>) -> Response {
    let key = format!("assets/{rel}");
    match file(portal_v2(), &key) {
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

    /// The switch picks the embedded build: portal v2 only when on.
    #[test]
    fn switch_picks_the_build() {
        let react = UserAssets::get("index.html").map(|f| f.data.into_owned());
        let svelte = PortalAssets::get("index.html").map(|f| f.data.into_owned());
        assert!(react.is_some() && svelte.is_some());
        assert_eq!(
            file(false, "index.html").map(|f| f.data.into_owned()),
            react
        );
        assert_eq!(
            file(true, "index.html").map(|f| f.data.into_owned()),
            svelte
        );
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
