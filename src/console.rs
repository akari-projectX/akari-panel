//! W33-b: the admin app (`admin/`), two independent Vite builds embedded
//! here — never served outside the admin prefix (D4):
//!
//! - **Sign-in page** (`admin/dist/login`) at `/{admin}/app` (any path
//!   below it too) with its assets at `/{admin}/app/assets/*`: public under
//!   the prefix (it is how admins get a session), no console code in it
//!   (admin/scripts/check-bundles.mjs). With Turnstile switched on for
//!   logins its CSP also allows `challenges.cloudflare.com` (the widget's
//!   script and frame); otherwise the panel's `'self'` CSP applies.
//! - **Console** (`admin/dist/console`) at `/{admin}/admin` and every
//!   `/{admin}/admin/<view>`, assets at `/{admin}/admin/assets/*`: for a
//!   live admin session only (R23); anything else — no or bad cookie,
//!   revoked session, a user's session, a database error — is the canonical
//!   rejection, so the console is as invisible as an unknown path.
//!
//! The portal at `/` (Via::Portal) shares the internal `/app` route with
//! the sign-in page; `app_entry` hands those requests to `spa::index`.

use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::access::{Entry, Via};
use crate::auth::{ApiError, AuthUser};
use crate::{reject, spa, state::AppState};

// build.rs drops placeholder index files on fresh clones so `cargo build`
// works without node; `make admin` replaces them.
#[derive(RustEmbed)]
#[folder = "admin/dist/login"]
struct LoginAssets;

#[derive(RustEmbed)]
#[folder = "admin/dist/console"]
struct ConsoleAssets;

/// The console is session-gated: never stored by any cache.
const CONSOLE_CACHE: &str = "private, no-store";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// `/{prefix}/app[/…]`: the admin sign-in page under the admin prefix; the
/// portal's pages at `/` (D11) otherwise.
pub async fn app_entry(State(state): State<AppState>, entry: Entry) -> Response {
    if entry.0 != Some(Via::Admin) {
        return spa::index(&state).await;
    }
    let Some(file) = LoginAssets::get("login.html") else {
        return reject::not_found();
    };
    let prefix = state.settings().access().admin_prefix.clone();
    let html = rewrite(
        &file.data,
        "/app/assets/",
        &format!("/{prefix}/app/assets/"),
    );
    let mut res = html_response(html, "no-store");
    if turnstile_login(&state).await {
        res.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(crate::web::CSP_TURNSTILE),
        );
    }
    res
}

/// Whether the login form asks for Turnstile (unreadable settings: no
/// widget, the default CSP; the login then fails closed in botguard).
async fn turnstile_login(state: &AppState) -> bool {
    let Ok(mut c) = state.pg().acquire().await else {
        return false;
    };
    crate::botguard::load(&mut c)
        .await
        .is_ok_and(|s| s.turnstile_login && s.turnstile_site_key.is_some())
}

/// `/{prefix}/app/assets/*`: the sign-in page's fingerprinted assets.
pub async fn login_asset(entry: Entry, Path((_, rel)): Path<(String, String)>) -> Response {
    if entry.0 != Some(Via::Admin) {
        return reject::not_found();
    }
    let key = format!("assets/{rel}");
    match LoginAssets::get(&key) {
        Some(file) => file_response(&key, file.data.to_vec(), IMMUTABLE),
        None => reject::not_found(),
    }
}

/// `/{prefix}/admin` and `/{prefix}/admin/<view>`: the console's index,
/// for a live admin session only.
pub async fn console_index(
    State(state): State<AppState>,
    session: Result<AuthUser, ApiError>,
) -> Response {
    if !is_admin(&session) {
        return reject::not_found();
    }
    let Some(file) = ConsoleAssets::get("index.html") else {
        return reject::not_found();
    };
    let prefix = state.settings().access().admin_prefix.clone();
    let html = rewrite(
        &file.data,
        "/admin/assets/",
        &format!("/{prefix}/admin/assets/"),
    );
    html_response(html, CONSOLE_CACHE)
}

/// `/{prefix}/admin/assets/*`: same gate as the index; never cached.
pub async fn console_asset(
    Path((_, rel)): Path<(String, String)>,
    session: Result<AuthUser, ApiError>,
) -> Response {
    if !is_admin(&session) {
        return reject::not_found();
    }
    let key = format!("assets/{rel}");
    match ConsoleAssets::get(&key) {
        Some(file) => file_response(&key, file.data.to_vec(), CONSOLE_CACHE),
        None => reject::not_found(),
    }
}

/// The console gate. `AuthUser` already refuses missing, forged, revoked
/// (session_ver), disabled and expired sessions; a database error is
/// refused the same way (no distinguishable 500 under /admin).
fn is_admin(session: &Result<AuthUser, ApiError>) -> bool {
    matches!(session, Ok(u) if u.role == "admin")
}

/// `html` with `href="<from>` / `src="<from>` attribute prefixes replaced.
fn rewrite(html: &[u8], from: &str, to: &str) -> String {
    String::from_utf8_lossy(html)
        .replace(&format!("href=\"{from}"), &format!("href=\"{to}"))
        .replace(&format!("src=\"{from}"), &format!("src=\"{to}"))
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
    use crate::auth::issue_token;
    use crate::testdb::TestDb;
    use crate::testdb::http::{Client, rand_ip};
    use axum::http::{Method, StatusCode};
    use uuid::Uuid;

    /// A client holding a session of `id` (current session_ver).
    async fn session(state: &AppState, id: Uuid) -> Client {
        let (role, sv): (String, i64) =
            sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
                .bind(id)
                .fetch_one(state.pg())
                .await
                .unwrap();
        let mut c = Client::new(state, rand_ip());
        c.cookie = Some(issue_token(state, id, &role, sv).unwrap());
        c
    }

    /// An asset the console's index references, if `make admin` ran (debug
    /// builds read admin/dist from disk; a fresh clone has placeholders).
    fn console_asset_path() -> Option<String> {
        let index = ConsoleAssets::get("index.html")?;
        let index = String::from_utf8_lossy(&index.data).to_string();
        ConsoleAssets::iter()
            .filter(|k| k.starts_with("assets/"))
            .find(|k| index.contains(k.as_ref()))
            .map(|k| format!("/test/admin/{k}"))
    }

    fn login_asset_path() -> Option<String> {
        LoginAssets::iter()
            .find(|k| k.starts_with("assets/"))
            .map(|k| format!("/test/app/{k}"))
    }

    fn header(r: &crate::testdb::http::Resp, name: header::HeaderName) -> &str {
        r.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }

    /// R23: the console (index, every view path, its assets) answers only an
    /// admin session; no cookie, a forged or revoked cookie, a user's session
    /// and wrong methods all get the canonical rejection, byte-identical to
    /// an unknown path. Console responses are never cacheable.
    #[tokio::test]
    async fn console_is_session_gated_and_rejections_are_identical() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let anon = Client::new(&state, rand_ip());
        let canonical = anon.get("/definitely/not/here").await.fingerprint();
        let mut paths = vec![
            "/test/admin".to_string(),
            "/test/admin/users".to_string(),
            "/test/admin/nodes/extra".to_string(),
            "/test/admin/assets/missing.js".to_string(),
        ];
        paths.extend(console_asset_path());

        let user = session(&state, db.user().await).await;
        let mut forged = Client::new(&state, rand_ip());
        forged.cookie = Some("not-a-jwt".into());
        let admin_id = db.admin().await;
        let revoked = session(&state, admin_id).await;
        let admin_live = {
            sqlx::query("UPDATE users SET session_ver = session_ver + 1 WHERE id = $1")
                .bind(admin_id)
                .execute(&db.pool)
                .await
                .unwrap();
            session(&state, admin_id).await
        };

        for c in [&anon, &forged, &user, &revoked] {
            for p in &paths {
                assert_eq!(c.get(p).await.fingerprint(), canonical, "GET {p}");
            }
        }
        // Even an admin: a trailing slash is not a route, wrong methods are
        // rejections, a missing asset is a rejection, and console assets do
        // not exist under the sign-in page's asset path.
        for (m, p) in [
            (Method::GET, "/test/admin/".to_string()),
            (Method::POST, "/test/admin".to_string()),
            (Method::DELETE, "/test/admin/users".to_string()),
            (Method::GET, "/test/admin/assets/missing.js".to_string()),
        ]
        .into_iter()
        .chain(console_asset_path().map(|p| {
            (
                Method::GET,
                p.replace("/test/admin/assets/", "/test/app/assets/"),
            )
        })) {
            assert_eq!(
                admin_live.req(m.clone(), &p, None).await.fingerprint(),
                canonical,
                "{m} {p}"
            );
        }

        for p in ["/test/admin", "/test/admin/users", "/test/admin/settings"] {
            let r = admin_live.get(p).await;
            assert_eq!(r.status, StatusCode::OK, "{p}");
            assert_eq!(header(&r, header::CACHE_CONTROL), CONSOLE_CACHE, "{p}");
            assert!(header(&r, header::CONTENT_SECURITY_POLICY).contains("default-src 'self'"));
            let html = String::from_utf8_lossy(&r.body);
            assert!(
                !html.contains("\"/admin/assets/"),
                "asset URLs carry the prefix: {html}"
            );
        }
        if let Some(p) = console_asset_path() {
            let r = admin_live.get(&p).await;
            assert_eq!(r.status, StatusCode::OK, "{p}");
            assert_eq!(header(&r, header::CACHE_CONTROL), CONSOLE_CACHE);
        }
    }

    /// R23-3 (with R22, D8): once the main domain is set, the console and
    /// its sign-in page answer on the main domain only (and IP literals).
    #[tokio::test]
    async fn console_only_on_the_main_domain() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let mut c = session(&state, db.admin().await).await;
        let canonical = c.get("/definitely/not/here").await.fingerprint();
        c.headers = vec![("host".into(), "sub.example.com".into())];
        assert_eq!(
            c.get("/test/admin").await.status,
            StatusCode::OK,
            "gate off"
        );

        let mut tx = db.pool.begin().await.unwrap();
        crate::settings::apply_update(
            &mut tx,
            &crate::audit::Actor::test(),
            0,
            &crate::settings::Values {
                main_domains: vec!["panel.example.com:8446".into()],
                sub_domains: vec!["sub.example.com".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        crate::settings::reload(&state).await.unwrap();

        for host in ["sub.example.com", "SUB.example.com:443"] {
            c.headers = vec![("host".into(), host.into())];
            for p in [
                "/test/admin",
                "/test/admin/users",
                "/test/admin/assets/missing.js",
                "/test/app",
                "/",
                "/shop",
            ] {
                assert_eq!(c.get(p).await.fingerprint(), canonical, "{host} {p}");
            }
        }
        for host in [
            "panel.example.com",
            "Panel.Example.com.:443",
            "203.0.113.5:8080",
        ] {
            c.headers = vec![("host".into(), host.into())];
            for p in ["/test/admin/settings", "/test/app"] {
                assert_eq!(c.get(p).await.status, StatusCode::OK, "{host} {p}");
            }
        }
    }

    /// The sign-in page is public under the prefix (no session needed), its
    /// assets immutable and prefixed; it is the admin app's own page, not
    /// the portal's; the portal at `/` stays the portal. Turnstile for
    /// logins widens the sign-in page's CSP (and the portal's, whose login
    /// form is switched by the same setting).
    #[tokio::test]
    async fn sign_in_page_is_public_under_the_prefix() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let c = Client::new(&state, rand_ip());
        let login = LoginAssets::get("login.html").map(|f| f.data.to_vec());
        for p in ["/test/app", "/test/app/users"] {
            let r = c.get(p).await;
            assert_eq!(r.status, StatusCode::OK, "{p}");
            assert_eq!(header(&r, header::CACHE_CONTROL), "no-store");
            assert_eq!(
                header(&r, header::CONTENT_SECURITY_POLICY),
                "default-src 'self'; style-src 'self' 'unsafe-inline'"
            );
            let html = String::from_utf8_lossy(&r.body);
            assert!(!html.contains("\"/app/assets/"), "prefixed: {html}");
            assert!(!html.contains("/admin/assets/"), "{html}");
            if let Some(l) = &login {
                assert_eq!(
                    html,
                    rewrite(l, "/app/assets/", "/test/app/assets/"),
                    "the admin sign-in page"
                );
            }
        }
        if let Some(p) = login_asset_path() {
            let r = c.get(&p).await;
            assert_eq!(r.status, StatusCode::OK, "{p}");
            assert_eq!(header(&r, header::CACHE_CONTROL), IMMUTABLE);
        }
        // The portal at `/` is not the sign-in page, and the sign-in
        // page's assets do not exist outside the prefix.
        let canonical = c.get("/definitely/not/here").await.fingerprint();
        let portal = c.get("/").await;
        assert_eq!(portal.status, StatusCode::OK);
        if let Some(l) = &login {
            assert_ne!(portal.body, *l);
        }
        if let Some(p) = login_asset_path() {
            let outside = p.trim_start_matches("/test");
            assert_eq!(c.get(outside).await.fingerprint(), canonical, "{outside}");
        }

        sqlx::query(
            "UPDATE auth_settings SET turnstile_site_key = 'site', turnstile_login = true, \
             turnstile_secret_enc = '\\x00'::bytea, version = version + 1",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        let r = c.get("/test/app").await;
        assert_eq!(
            header(&r, header::CONTENT_SECURITY_POLICY),
            crate::web::CSP_TURNSTILE
        );
        // The portal's login form is switched by the same setting.
        assert_eq!(
            header(&c.get("/").await, header::CONTENT_SECURITY_POLICY),
            crate::web::CSP_TURNSTILE,
            "the portal's login form uses it too"
        );
    }
}
