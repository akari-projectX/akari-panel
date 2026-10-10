//! W27 (v0.4 D4 + D11): the public URL layout.
//!
//! - **Portal at `/`** of the main domain: the user portal, its API
//!   (`/api/v1/…`, `/auth/…`), branding and assets. Admin sessions are not
//!   accepted there (canonical rejection) and admin accounts cannot sign in
//!   there (the uniform 401): portal code and answers never reveal or lead
//!   to the console.
//! - **Admin prefix** (`/{admin_prefix}/…`, D4: the only secret prefix):
//!   the console, the shared login page (`/{admin_prefix}/app`) and every
//!   API — but never the subscription, install or payment paths, which have
//!   public paths of their own (a link handed out never carries the
//!   prefix). Stored in `access_settings` (the first start imports
//!   data/state.json's route prefix, so the installer's URL keeps working);
//!   rotatable by the owner (R47; audited without the value; the old prefix
//!   dies at once on every instance); optional CIDR allowlist (owner) — any
//!   other client gets the canonical 404 for everything under the prefix.
//! - **Subscription** at `/{sub_path}/{token}` (D11): a site-wide random
//!   segment, editable (audited, the old path dies at once; optionally every
//!   user gets the new link by mail through a resumable batch job).
//! - **Install links** `/install/{token}…` and **payment notifications**
//!   `/pay/…`: fixed paths without any prefix (their tokens / signatures are
//!   the gate).
//!
//! `web::router` dispatches with `route` (pure): every accepted request is
//! rewritten to the internal `/_/…` routes (`INNER`) and tagged with its
//! [`Via`]; everything else is the canonical rejection.

use std::net::IpAddr;

use axum::Json;
use axum::extract::State;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::client_ip::Cidr;
use crate::state::AppState;

/// The internal first path segment every accepted request is rewritten to.
pub const INNER: &str = "_";

/// How a request entered (a request extension set by the dispatcher).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// Under the admin prefix (allowlist passed): every route.
    Admin,
    /// The portal at `/`: admin sessions are refused.
    Portal,
    /// `/{sub_path}/{token}`.
    Sub,
    /// `/install/…`, `/pay/…`.
    Public,
}

/// Extractor: how the request entered (never rejects).
pub struct Entry(pub Option<Via>);

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for Entry {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _: &S,
    ) -> Result<Self, Self::Rejection> {
        Ok(Entry(parts.extensions.get::<Via>().copied()))
    }
}

impl Entry {
    /// Admin accounts sign in under the admin prefix only.
    pub fn refuses(&self, role: &str) -> bool {
        role == "admin" && self.0 == Some(Via::Portal)
    }
}

/// The portal's pages (first path segment; `/` is the dashboard): every
/// client-side route answers the portal's index. Other paths are the
/// canonical rejection, as before D11. Keep in step with the portal's route
/// table (spa/src/lib/routes.ts; `routes_match_the_portal` checks it).
pub const PORTAL_PAGES: &[&str] = &[
    "shop",
    "nodes",
    "traffic",
    "orders",
    "wallet",
    "invite",
    "tickets",
    "help",
    "announcements",
    "account",
    "login",
    "register",
    "forgot",
    "reset",
    "deleted",
    "terms",
    "privacy",
];

/// Paths that exist outside the admin prefix only.
const PUBLIC_ONLY: &[&str] = &["sub", "install", "pay"];

fn first(path: &str) -> &str {
    path.split('/').next().unwrap_or("")
}

/// Top-level portal paths a subscription path may not shadow (the SPA's
/// views and the fixed public paths).
pub const RESERVED: &[&str] = &[
    "_",
    "api",
    "auth",
    "assets",
    "brand",
    "install",
    "pay",
    "healthz",
    "app",
    "admin",
    "sub",
    "login",
    "register",
    "reset",
    "forgot",
    "shop",
    "orders",
    "account",
    "wallet",
    "tickets",
    "help",
    "traffic",
    "announcements",
    "nodes",
    "plan",
    "invite",
    "deleted",
    "terms",
    "privacy",
    "favicon.ico",
    "robots.txt",
];

/// The effective layout (one per settings reload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Access {
    pub version: i64,
    pub admin_prefix: String,
    pub admin_allow: Vec<Cidr>,
    pub admin_allow_raw: Vec<String>,
    /// An unreadable stored allowlist entry: nobody passes (never widen).
    pub admin_locked: bool,
    pub sub_path: String,
}

impl Access {
    /// The built-in layout before the database is read (and for tests):
    /// the install's route prefix, subscriptions at `/sub/`.
    pub fn boot(route_prefix: &str) -> Self {
        Self {
            version: 0,
            admin_prefix: route_prefix.to_string(),
            admin_allow: Vec::new(),
            admin_allow_raw: Vec::new(),
            admin_locked: false,
            sub_path: "sub".into(),
        }
    }

    /// May `ip` use the admin prefix?
    pub fn admin_allowed(&self, ip: IpAddr) -> bool {
        !self.admin_locked
            && (self.admin_allow.is_empty() || self.admin_allow.iter().any(|c| c.contains(ip)))
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    version: i64,
    admin_prefix: Option<String>,
    admin_allow_cidrs: Vec<String>,
    sub_path: Option<String>,
}

async fn read_row(conn: &mut PgConnection, lock: bool) -> sqlx::Result<Row> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT version, admin_prefix, admin_allow_cidrs, sub_path FROM access_settings \
         WHERE id = 1{}",
        if lock { " FOR UPDATE" } else { "" }
    )))
    .fetch_one(conn)
    .await
}

/// Read the layout; NULL values (before `ensure`) fall back to `boot`.
pub async fn load(conn: &mut PgConnection, route_prefix: &str) -> sqlx::Result<Access> {
    let r = read_row(conn, false).await?;
    let boot = Access::boot(route_prefix);
    let mut allow = Vec::new();
    let mut locked = false;
    for c in &r.admin_allow_cidrs {
        match Cidr::parse(c) {
            Ok(c) => allow.push(c),
            // Impossible through the API (validated); never widen: an
            // unreadable entry closes the prefix (`akari settings unset
            // admin-allow` reopens it).
            Err(e) => {
                tracing::error!(error = %e, "unreadable admin allowlist entry: the admin prefix is closed");
                locked = true;
            }
        }
    }
    Ok(Access {
        version: r.version,
        admin_prefix: r.admin_prefix.unwrap_or(boot.admin_prefix),
        admin_allow: allow,
        admin_allow_raw: r.admin_allow_cidrs,
        admin_locked: locked,
        sub_path: r.sub_path.unwrap_or(boot.sub_path),
    })
}

fn random_segment(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut b);
    hex::encode(b)
}

/// First start (idempotent, any instance): import the route prefix of
/// data/state.json as the admin prefix and draw the subscription path,
/// each once, audited (actor system).
pub async fn ensure(state: &AppState) -> anyhow::Result<()> {
    let mut tx = state.pg().begin().await?;
    let r = read_row(&mut tx, true).await?;
    if r.admin_prefix.is_none() {
        sqlx::query(
            "UPDATE access_settings SET admin_prefix = $1, version = version + 1, \
             updated_at = now() WHERE id = 1",
        )
        .bind(state.route_prefix())
        .execute(&mut *tx)
        .await?;
        crate::audit::record(
            &mut tx,
            &Actor::system(),
            "settings.access.import",
            "settings",
            Some("access".into()),
            None,
            Some(json!({ "admin_prefix": "imported from data/state.json" })),
        )
        .await?;
        tracing::info!("admin prefix imported from data/state.json into the database");
    }
    if r.sub_path.is_none() {
        sqlx::query(
            "UPDATE access_settings SET sub_path = $1, version = version + 1, \
             updated_at = now() WHERE id = 1",
        )
        .bind(random_segment(8))
        .execute(&mut *tx)
        .await?;
        crate::audit::record(
            &mut tx,
            &Actor::system(),
            "settings.sub_path.generate",
            "settings",
            Some("access".into()),
            None,
            Some(json!({ "sub_path": crate::audit::CHANGED })),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Dispatch (pure)
// ---------------------------------------------------------------------------

/// Where an external request goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Rewrite to this internal path (with the original query string).
    Inner {
        path: String,
        via: Via,
    },
    /// Under the admin prefix: needs the allowlist check first.
    Admin {
        path: String,
    },
    Reject,
}

/// Pure: map an external path to its internal route. `get` = a GET/HEAD
/// request (only those reach the portal's page fallback).
pub fn route(a: &Access, path: &str, get: bool) -> Route {
    let Some(rest) = path.strip_prefix('/') else {
        return Route::Reject;
    };
    let (seg, tail) = match rest.split_once('/') {
        Some((s, t)) => (s, Some(t)),
        None => (rest, None),
    };
    // The admin prefix (constant time: it is a secret). A bare prefix is
    // rejected too, and so are the public paths below it: a subscription,
    // install or payment link with the prefix in it must not work.
    if subtle::ConstantTimeEq::ct_eq(seg.as_bytes(), a.admin_prefix.as_bytes()).into() {
        return match tail {
            Some(t) if !t.is_empty() && !PUBLIC_ONLY.contains(&first(t)) => Route::Admin {
                path: format!("/{INNER}/{t}"),
            },
            _ => Route::Reject,
        };
    }
    // The subscription: exactly `/{sub_path}/{token}`.
    if seg == a.sub_path {
        return match tail {
            Some(t) if !t.is_empty() && !t.contains('/') => Route::Inner {
                path: format!("/{INNER}/sub/{t}"),
                via: Via::Sub,
            },
            _ => Route::Reject,
        };
    }
    match seg {
        "install" | "pay" => match tail {
            Some(t) if !t.is_empty() => Route::Inner {
                path: format!("/{INNER}/{seg}/{t}"),
                via: Via::Public,
            },
            _ => Route::Reject,
        },
        "api" | "auth" | "brand" | "assets" => match tail {
            Some(t) if !t.is_empty() => Route::Inner {
                path: format!("/{INNER}/{seg}/{t}"),
                via: Via::Portal,
            },
            _ => Route::Reject,
        },
        "healthz" if tail.is_none() => Route::Inner {
            path: format!("/{INNER}/healthz"),
            via: Via::Portal,
        },
        // The portal's pages.
        _ if get && (rest.is_empty() || PORTAL_PAGES.contains(&seg)) => Route::Inner {
            path: if rest.is_empty() {
                format!("/{INNER}/app")
            } else {
                format!("/{INNER}/app/{rest}")
            },
            via: Via::Portal,
        },
        _ => Route::Reject,
    }
}

// ---------------------------------------------------------------------------
// URLs handed out
// ---------------------------------------------------------------------------

/// The subscription URL of `token` on `origin`.
pub fn sub_url(origin: &str, sub_path: &str, token: &str) -> String {
    format!("{origin}/{sub_path}/{token}")
}

// ---------------------------------------------------------------------------
// 系统设置 → 访问 (admin)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct AccessView {
    version: i64,
    admin_prefix: String,
    /// The console's URL on the main domain (null without one).
    admin_url: Option<String>,
    admin_allow_cidrs: Vec<String>,
    /// The address this request came from (what the allowlist sees).
    your_ip: Option<String>,
    sub_path: String,
}

fn view(state: &AppState, a: &Access, ip: Option<IpAddr>) -> AccessView {
    let origin = state.settings().get().public_origin();
    AccessView {
        version: a.version,
        admin_prefix: a.admin_prefix.clone(),
        admin_url: origin.map(|o| format!("{o}/{}/admin", a.admin_prefix)),
        admin_allow_cidrs: a.admin_allow_raw.clone(),
        your_ip: ip.map(|i| crate::client_ip::canonical(i).to_string()),
        sub_path: a.sub_path.clone(),
    }
}

fn version_conflict() -> ApiError {
    conflict!(
        "settings.version_conflict",
        "settings changed meanwhile; reload and retry"
    )
}

fn confirm_required() -> ApiError {
    bad_request!(
        "settings.confirm_required",
        "this change takes effect at once: send confirm=true"
    )
}

/// Pure: validate a path segment for the admin prefix / subscription path.
pub fn check_segment(s: &str, min: usize) -> Result<(), ApiError> {
    let ok = (min..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        return Err(bad_request!(
            "settings.path_invalid",
            "use {min}-64 characters of A-Z a-z 0-9 - _",
            min = min
        ));
    }
    if RESERVED.contains(&s.to_ascii_lowercase().as_str()) {
        return Err(bad_request!(
            "settings.path_reserved",
            "{value} is used by the portal",
            value = s.to_string()
        ));
    }
    Ok(())
}

async fn reload_now(state: &AppState) -> Result<(), ApiError> {
    crate::settings::reload(state).await.map_err(|e| {
        tracing::error!(error = %e, "settings reload");
        ApiError::internal()
    })
}

/// GET /api/v1/settings/access
pub async fn get_access(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<AccessView>, ApiError> {
    user.require_admin()?;
    let a = state.settings().access();
    Ok(Json(view(&state, &a, user.ip)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RotateReq {
    pub version: i64,
    #[serde(default)]
    pub confirm: bool,
    /// A chosen prefix (default: a new random one).
    #[serde(default)]
    pub admin_prefix: Option<String>,
}

/// Replace the admin prefix (owner, R47; audited; the old value is never
/// logged).
pub async fn apply_rotate_prefix(
    conn: &mut PgConnection,
    actor: &Actor,
    version: Option<i64>,
    chosen: Option<&str>,
) -> Result<String, ApiError> {
    crate::owner::require(conn, actor).await?;
    let cur = read_row(conn, true).await?;
    if version.is_some_and(|v| v != cur.version) {
        return Err(version_conflict());
    }
    let new = match chosen {
        Some(p) => {
            check_segment(p, 8)?;
            p.to_string()
        }
        None => random_segment(12),
    };
    if cur.sub_path.as_deref() == Some(new.as_str()) || cur.admin_prefix.as_deref() == Some(&new) {
        return Err(bad_request!(
            "settings.path_taken",
            "that value is already in use"
        ));
    }
    sqlx::query(
        "UPDATE access_settings SET admin_prefix = $1, version = version + 1, \
         updated_at = now() WHERE id = 1",
    )
    .bind(&new)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.admin_prefix.rotate",
        "settings",
        Some("access".into()),
        None,
        Some(json!({ "admin_prefix": crate::audit::CHANGED })),
    )
    .await?;
    Ok(new)
}

/// POST /api/v1/settings/access/admin-prefix {version, confirm, admin_prefix?}
pub async fn rotate_prefix(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<RotateReq>,
) -> Result<Json<AccessView>, ApiError> {
    user.require_admin()?;
    if !req.confirm {
        return Err(confirm_required());
    }
    let mut tx = state.pg().begin().await?;
    apply_rotate_prefix(
        &mut tx,
        &Actor::of(&user),
        Some(req.version),
        req.admin_prefix.as_deref().map(str::trim),
    )
    .await?;
    tx.commit().await?;
    reload_now(&state).await?;
    let a = state.settings().access();
    Ok(Json(view(&state, &a, user.ip)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AllowReq {
    pub version: i64,
    pub admin_allow_cidrs: Vec<String>,
}

/// Pure: normalize an allowlist (one CIDR or address per entry, ≤ 64).
pub fn allow_values(raw: &[String]) -> Result<Vec<String>, ApiError> {
    if raw.len() > 64 {
        return Err(bad_request!(
            "settings.allowlist_too_long",
            "at most {max} entries",
            max = 64
        ));
    }
    let mut out: Vec<String> = Vec::new();
    for r in raw {
        let r = r.trim();
        if r.is_empty() {
            continue;
        }
        Cidr::parse(r).map_err(|_| {
            bad_request!(
                "settings.allowlist_invalid",
                "{value} is not an address or CIDR block",
                value = r.to_string()
            )
        })?;
        if !out.iter().any(|o| o == r) {
            out.push(r.to_string());
        }
    }
    Ok(out)
}

/// Write the allowlist (owner, R47; audited). `client`: the requesting
/// address — a list that would shut it out is refused (the CLI passes
/// None).
pub async fn apply_allowlist(
    conn: &mut PgConnection,
    actor: &Actor,
    version: Option<i64>,
    raw: &[String],
    client: Option<IpAddr>,
) -> Result<Vec<String>, ApiError> {
    crate::owner::require(conn, actor).await?;
    let list = allow_values(raw)?;
    if let Some(ip) = client
        && !list.is_empty()
        && !list
            .iter()
            .filter_map(|c| Cidr::parse(c).ok())
            .any(|c| c.contains(ip))
    {
        return Err(conflict!(
            "settings.allowlist_excludes_you",
            "the list does not contain your address {ip}",
            ip = crate::client_ip::canonical(ip).to_string()
        ));
    }
    let cur = read_row(conn, true).await?;
    if version.is_some_and(|v| v != cur.version) {
        return Err(version_conflict());
    }
    sqlx::query(
        "UPDATE access_settings SET admin_allow_cidrs = $1, version = version + 1, \
         updated_at = now() WHERE id = 1",
    )
    .bind(&list)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.admin_allowlist.update",
        "settings",
        Some("access".into()),
        Some(json!({ "admin_allow_cidrs": cur.admin_allow_cidrs })),
        Some(json!({ "admin_allow_cidrs": list })),
    )
    .await?;
    Ok(list)
}

/// PUT /api/v1/settings/access/admin-allow {version, admin_allow_cidrs}
pub async fn put_allowlist(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<AllowReq>,
) -> Result<Json<AccessView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_allowlist(
        &mut tx,
        &Actor::of(&user),
        Some(req.version),
        &req.admin_allow_cidrs,
        user.ip,
    )
    .await?;
    tx.commit().await?;
    reload_now(&state).await?;
    let a = state.settings().access();
    Ok(Json(view(&state, &a, user.ip)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubPathReq {
    pub version: i64,
    pub sub_path: String,
    #[serde(default)]
    pub confirm: bool,
    /// Mail every user (verified address) the new link (default on).
    #[serde(default = "yes")]
    pub notify_users: bool,
}

fn yes() -> bool {
    true
}

/// The mail every user gets after a path change (a batch `send_email`;
/// `{sub_url}` is each recipient's own new link).
pub const NOTICE_SUBJECT: &str = "订阅链接已更新 / Your subscription link has changed";
pub const NOTICE_BODY: &str = "你的订阅地址已更新，旧链接已失效。请在客户端中改用新链接：\n{sub_url}\n\n\
Your subscription address has changed and the old link no longer works. \
Please update your client to the new link:\n{sub_url}";

/// Change the subscription path (audited). The old path stops working at
/// once.
pub async fn apply_sub_path(
    conn: &mut PgConnection,
    actor: &Actor,
    version: i64,
    new: &str,
) -> Result<(), ApiError> {
    check_segment(new, 4)?;
    let cur = read_row(conn, true).await?;
    if version != cur.version {
        return Err(version_conflict());
    }
    if cur.admin_prefix.as_deref() == Some(new) {
        return Err(bad_request!(
            "settings.path_taken",
            "that value is already in use"
        ));
    }
    if cur.sub_path.as_deref() == Some(new) {
        return Ok(());
    }
    sqlx::query(
        "UPDATE access_settings SET sub_path = $1, version = version + 1, \
         updated_at = now() WHERE id = 1",
    )
    .bind(new)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.sub_path.update",
        "settings",
        Some("access".into()),
        Some(json!({ "sub_path": cur.sub_path })),
        Some(json!({ "sub_path": new })),
    )
    .await?;
    Ok(())
}

/// PUT /api/v1/settings/access/sub-path {version, sub_path, confirm,
/// notify_users?}: → the view + `notify_job` (the batch job mailing every
/// user the new link, null when not requested or mail is off).
pub async fn put_sub_path(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<SubPathReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    if !req.confirm {
        return Err(confirm_required());
    }
    let new = req.sub_path.trim().to_string();
    let actor = Actor::of(&user);
    let mut tx = state.pg().begin().await?;
    let before = read_row(&mut tx, false).await?.sub_path;
    apply_sub_path(&mut tx, &actor, req.version, &new).await?;
    let changed = before.as_deref() != Some(new.as_str());
    let mut job = None;
    if changed && req.notify_users && crate::mailhook::available(&mut tx).await? {
        let created = crate::batch::apply_create(
            &mut tx,
            &actor,
            &crate::batch::CreateReq {
                selection: crate::batch::Selection {
                    ids: None,
                    filter: Some(crate::batch::UserFilter {
                        role: Some("user".into()),
                        ..Default::default()
                    }),
                },
                action: crate::batch::Action::SendEmail {
                    subject: NOTICE_SUBJECT.into(),
                    body: NOTICE_BODY.into(),
                },
            },
        )
        .await?;
        job = Some(created);
    }
    tx.commit().await?;
    reload_now(&state).await?;
    if job.is_some() {
        let st = state.clone();
        tokio::spawn(async move { crate::batch::run_available(&st).await });
    }
    let a = state.settings().access();
    Ok(Json(json!({
        "access": view(&state, &a, user.ip),
        "notify_job": job,
    })))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/// `akari secrets rotate-prefix`: a new random admin prefix (actor cli).
pub async fn cli_rotate_prefix(pg: &sqlx::PgPool) -> anyhow::Result<String> {
    let mut tx = pg.begin().await?;
    let p = apply_rotate_prefix(&mut tx, &Actor::cli(), None, None)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message()))?;
    tx.commit().await?;
    Ok(p)
}

/// `akari settings unset admin-allow`: allow every address again.
pub async fn cli_clear_allowlist(pg: &sqlx::PgPool) -> anyhow::Result<()> {
    let mut tx = pg.begin().await?;
    apply_allowlist(&mut tx, &Actor::cli(), None, &[], None)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message()))?;
    tx.commit().await?;
    Ok(())
}

/// `akari info`: the stored admin prefix and subscription path (None =
/// not yet imported: the panel has not started on this database).
pub async fn cli_read(pg: &sqlx::PgPool) -> anyhow::Result<(Option<String>, Option<String>)> {
    let mut c = pg.acquire().await?;
    let r = read_row(&mut c, false).await?;
    Ok((r.admin_prefix, r.sub_path))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post, put};
    axum::Router::new()
        .route("/{prefix}/api/v1/settings/access", get(get_access))
        .route(
            "/{prefix}/api/v1/settings/access/admin-prefix",
            post(rotate_prefix),
        )
        .route(
            "/{prefix}/api/v1/settings/access/admin-allow",
            put(put_allowlist),
        )
        .route(
            "/{prefix}/api/v1/settings/access/sub-path",
            put(put_sub_path),
        )
}

#[cfg(test)]
mod tests;
