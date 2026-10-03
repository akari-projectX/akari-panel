//! The two embedded frontends (R23): the user portal at `/{prefix}/app`
//! (public; also the shared login page) and the admin console at
//! `/{prefix}/admin` (index and assets for admin sessions only). They are
//! independent Vite builds (spa/vite.config.ts), so nothing of the console
//! ships to users; spa/scripts/check-bundles.mjs and smoke assert that.

use std::net::IpAddr;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::auth::{ApiError, SessionUser};
use crate::{reject, state::AppState};

// The compiled bundles (spa/dist/{app,admin}). build.rs drops placeholder
// index files on fresh clones so `cargo build` works without a node
// toolchain; `make spa` replaces them.
#[derive(RustEmbed)]
#[folder = "spa/dist/app"]
struct UserAssets;

#[derive(RustEmbed)]
#[folder = "spa/dist/admin"]
struct AdminAssets;

/// Cache policy of the console: session-gated, so never stored by the
/// browser or any shared cache (a cached copy would outlive the session).
const ADMIN_CACHE: &str = "private, no-store";

/// The user portal entry point. Vite emits asset URLs rooted at "/assets/"
/// — those are rewritten to the secret prefix at serve time, because the
/// random prefix only exists on the server. Client-side routes (anything
/// below /app/) all land here.
pub async fn index(State(state): State<AppState>) -> Response {
    let Some(file) = UserAssets::get("index.html") else {
        return reject::not_found();
    };
    let html = rewrite(
        &file.data,
        "/assets/",
        &format!("/{}/assets/", state.route_prefix()),
    );
    html_response(html, "no-store")
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

/// The admin console entry point (every /admin and /admin/<view> path):
/// only for a live admin session — a full one, or the enrollment-only
/// session `auth.require_admin_2fa` gives an admin without 2FA (the console
/// owns the enrollment page). Anything else — no or bad cookie, expired or
/// revoked session, a user's session — is the canonical rejection, so the
/// console is as invisible as an unknown path.
pub async fn admin_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    session: Result<SessionUser, ApiError>,
) -> Response {
    if !console_host(&state, &headers, &uri) || !is_admin(&session) {
        return reject::not_found();
    }
    let Some(file) = AdminAssets::get("admin.html") else {
        return reject::not_found();
    };
    let prefix = state.route_prefix();
    let html = rewrite(
        &file.data,
        "/admin/assets/",
        &format!("/{prefix}/admin/assets/"),
    );
    html_response(html, ADMIN_CACHE)
}

/// Admin console build assets: same gate as the index; never cached.
pub async fn admin_asset(
    State(state): State<AppState>,
    Path((_, rel)): Path<(String, String)>,
    headers: HeaderMap,
    uri: Uri,
    session: Result<SessionUser, ApiError>,
) -> Response {
    if !console_host(&state, &headers, &uri) || !is_admin(&session) {
        return reject::not_found();
    }
    let key = format!("assets/{rel}");
    match AdminAssets::get(&key) {
        Some(file) => file_response(&key, file.data.to_vec(), ADMIN_CACHE),
        None => reject::not_found(),
    }
}

/// The console gate. `SessionUser` already refuses missing, forged,
/// revoked (session_ver), disabled and expired sessions; a database error
/// is refused the same way (no distinguishable 500 under /admin).
fn is_admin(session: &Result<SessionUser, ApiError>) -> bool {
    matches!(session, Ok(u) if u.role == "admin")
}

/// R23-3: once the main domain is set in the system settings (R22 host
/// gate on), the console is served on the main domain only (IP literals
/// stay allowed, as for the host gate itself): on the subscription domain,
/// or any other configured name, /admin is the canonical rejection.
fn console_host(state: &AppState, headers: &HeaderMap, uri: &Uri) -> bool {
    let eff = state.settings().get();
    if !eff.host_gate_on() {
        return true;
    }
    let Some(main) = &eff.main else {
        return true;
    };
    let main = crate::settings::request_host(&main.host);
    match crate::settings::host_of(headers, uri) {
        Some(h) => h.parse::<IpAddr>().is_ok() || h == main,
        None => false,
    }
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
    use crate::auth::{Stage, issue_token};
    use crate::testdb::TestDb;
    use crate::testdb::http::{Client, rand_ip};
    use axum::http::{Method, StatusCode};
    use uuid::Uuid;

    /// A client holding a session of `id` (current session_ver, `stage`).
    async fn session(state: &AppState, id: Uuid, stage: Stage) -> Client {
        let (role, sv): (String, i64) =
            sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
                .bind(id)
                .fetch_one(state.pg())
                .await
                .unwrap();
        let mut c = Client::new(state, rand_ip());
        c.cookie = Some(issue_token(state, id, &role, sv, stage).unwrap());
        c
    }

    /// A built console asset, if `make spa` ran (debug builds read
    /// spa/dist from disk; a fresh clone only has the placeholder index).
    /// An asset the console's index references (W21: the console is
    /// code-split, so not every asset is in the index; the view chunks are
    /// imported relatively by the entry).
    fn admin_asset_path() -> Option<String> {
        let index = AdminAssets::get("admin.html")?;
        let index = String::from_utf8_lossy(&index.data).to_string();
        AdminAssets::iter()
            .filter(|k| k.starts_with("assets/"))
            .find(|k| index.contains(k.as_ref()))
            .map(|k| format!("/test/admin/{k}"))
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
    /// an unknown path. Admin responses are never cacheable.
    #[tokio::test]
    async fn admin_bundle_is_session_gated_and_rejections_are_identical() {
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
        paths.extend(admin_asset_path());

        let user = session(&state, db.user().await, Stage::Full).await;
        let mut forged = Client::new(&state, rand_ip());
        forged.cookie = Some("not-a-jwt".into());
        let admin_id = db.admin().await;
        // Revoked: a token from before the last session_ver bump.
        let revoked = session(&state, admin_id, Stage::Full).await;
        let admin_live = {
            sqlx::query("UPDATE users SET session_ver = session_ver + 1 WHERE id = $1")
                .bind(admin_id)
                .execute(&db.pool)
                .await
                .unwrap();
            session(&state, admin_id, Stage::Full).await
        };

        for c in [&anon, &forged, &user, &revoked] {
            for p in &paths {
                assert_eq!(c.get(p).await.fingerprint(), canonical, "GET {p}");
            }
        }
        // Even an admin: a trailing slash is not a route, wrong methods are
        // rejections, a missing asset is a rejection, and console assets do
        // not exist under the public /assets/ path.
        for (m, p) in [
            (Method::GET, "/test/admin/".to_string()),
            (Method::POST, "/test/admin".to_string()),
            (Method::DELETE, "/test/admin/users".to_string()),
            (Method::GET, "/test/admin/assets/missing.js".to_string()),
        ]
        .into_iter()
        .chain(admin_asset_path().map(|p| {
            (
                Method::GET,
                p.replace("/test/admin/assets/", "/test/assets/"),
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
            assert_eq!(
                header(&r, header::CACHE_CONTROL),
                "private, no-store",
                "{p}"
            );
            assert!(header(&r, header::CONTENT_SECURITY_POLICY).contains("default-src 'self'"));
            let html = String::from_utf8_lossy(&r.body);
            assert!(
                !html.contains("\"/admin/assets/"),
                "asset URLs carry the prefix: {html}"
            );
        }
        if let Some(p) = admin_asset_path() {
            let r = admin_live.get(&p).await;
            assert_eq!(r.status, StatusCode::OK, "{p}");
            assert_eq!(header(&r, header::CACHE_CONTROL), "private, no-store");
            let html =
                String::from_utf8_lossy(&admin_live.get("/test/admin").await.body).to_string();
            assert!(html.contains(&format!(
                "\"/test/admin/{}",
                p.trim_start_matches("/test/admin/")
            )));
        }
    }

    /// With `auth.require_admin_2fa` an admin without 2FA only holds an
    /// enrollment session; the console (which owns the enrollment page) is
    /// served to it. A user's session is still refused.
    #[tokio::test]
    async fn enrollment_session_of_an_admin_gets_the_console() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        db.settings(&state, "require_admin_2fa = true").await;
        let canonical = Client::new(&state, rand_ip())
            .get("/definitely/not/here")
            .await
            .fingerprint();
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, login, role) VALUES ($1, $2, 'admin')")
            .bind(id)
            .bind(id.to_string())
            .execute(&db.pool)
            .await
            .unwrap();
        for stage in [Stage::Enroll, Stage::Full] {
            let c = session(&state, id, stage).await;
            assert_eq!(c.get("/test/admin/account").await.status, StatusCode::OK);
        }
        let user = session(&state, db.user().await, Stage::Enroll).await;
        assert_eq!(user.get("/test/admin").await.fingerprint(), canonical);
    }

    /// R23-3 (with R22): once the main domain is set, the console answers
    /// on the main domain only (and IP literals); on the subscription
    /// domain it is the canonical rejection even for an admin session,
    /// while the portal is still served there.
    #[tokio::test]
    async fn console_only_on_the_main_domain() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let mut c = session(&state, db.admin().await, Stage::Full).await;
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
                main_domain: Some("panel.example.com:8446".into()),
                sub_domain: Some("sub.example.com".into()),
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
            ] {
                assert_eq!(c.get(p).await.fingerprint(), canonical, "{host} {p}");
            }
            assert_eq!(
                c.get("/test/app").await.status,
                StatusCode::OK,
                "{host} portal"
            );
        }
        if let Some(p) = admin_asset_path() {
            c.headers = vec![("host".into(), "sub.example.com".into())];
            assert_eq!(c.get(&p).await.fingerprint(), canonical);
        }
        for host in [
            "panel.example.com",
            "Panel.Example.com.:443",
            "203.0.113.5:8080",
        ] {
            c.headers = vec![("host".into(), host.into())];
            assert_eq!(
                c.get("/test/admin/settings").await.status,
                StatusCode::OK,
                "{host}"
            );
        }
    }

    /// The user portal stays public (it is the login page) and its assets
    /// are immutable; they never include the console's.
    #[tokio::test]
    async fn user_bundle_is_public_and_immutable() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test(db.pool.clone()).await;
        let c = Client::new(&state, rand_ip());
        for p in ["/test/app", "/test/app/orders"] {
            let r = c.get(p).await;
            assert_eq!(r.status, StatusCode::OK, "{p}");
            assert_eq!(header(&r, header::CACHE_CONTROL), "no-store");
            let html = String::from_utf8_lossy(&r.body);
            assert!(!html.contains("/admin/"), "{html}");
            assert!(
                !html.contains("\"/assets/"),
                "asset URLs carry the prefix: {html}"
            );
        }
        if let Some(k) = UserAssets::iter().find(|k| k.starts_with("assets/")) {
            let r = c.get(&format!("/test/{k}")).await;
            assert_eq!(r.status, StatusCode::OK);
            assert_eq!(
                header(&r, header::CACHE_CONTROL),
                "public, max-age=31536000, immutable"
            );
        }
    }
}
