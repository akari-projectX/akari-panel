//! Ops: site branding (系统设置 → 站点): logo and favicon, footer text and
//! links, terms / privacy links, client download links per platform.
//!
//! - Stored in `site_branding` (one row, `version` for optimistic
//!   concurrency, migration 0157), **database only** (R39: no panel.toml
//!   keys). Text fields are written by `apply_update` (audited
//!   `settings.branding.update` with before/after), images by
//!   `apply_set_image` / `apply_clear_image` (audited
//!   `settings.branding.logo` / `.favicon` with sizes only — never bytes).
//! - Images are **PNG only** (no SVG: an SVG is a script container):
//!   the signature and IHDR are checked, dimensions capped, size capped
//!   (`LOGO_MAX` / `FAVICON_MAX`). Served publicly under the secret prefix
//!   at `/{prefix}/brand/logo` and `/{prefix}/brand/favicon` with
//!   `Cache-Control: public, max-age=86400` and a strong ETag (SHA-256);
//!   the SPA appends `?v=<sha prefix>` so a new upload shows at once. No
//!   image stored = the canonical rejection (`reject::not_found()`).
//! - The public view (`/auth/options` → `branding`) carries the text
//!   fields and the image URLs (prefix-relative, never the bytes).

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::markdown::{UrlKind, safe_link};
use crate::state::AppState;

pub const LOGO_MAX: usize = 256 * 1024;
pub const FAVICON_MAX: usize = 64 * 1024;
pub const LOGO_MAX_DIM: u32 = 2048;
pub const FAVICON_MAX_DIM: u32 = 256;
pub const MAX_FOOTER: usize = 500;
pub const MAX_LABEL: usize = 64;
pub const MAX_LINKS: usize = 8;
pub const MAX_DOWNLOADS: usize = 12;
pub const PLATFORMS: [&str; 7] = [
    "windows", "macos", "linux", "android", "ios", "harmony", "other",
];

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/// Width and height of a PNG (signature + IHDR checked). None = not a PNG.
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 33 || bytes[..8] != SIG {
        return None;
    }
    // First chunk: length 13, type IHDR, width, height.
    if bytes[8..12] != [0, 0, 0, 13] || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// Which image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Image {
    Logo,
    Favicon,
}

impl Image {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "logo" => Some(Image::Logo),
            "favicon" => Some(Image::Favicon),
            _ => None,
        }
    }
    fn column(self) -> &'static str {
        match self {
            Image::Logo => "logo",
            Image::Favicon => "favicon",
        }
    }
    fn limits(self) -> (usize, u32) {
        match self {
            Image::Logo => (LOGO_MAX, LOGO_MAX_DIM),
            Image::Favicon => (FAVICON_MAX, FAVICON_MAX_DIM),
        }
    }
    fn action(self) -> &'static str {
        match self {
            Image::Logo => "settings.branding.logo",
            Image::Favicon => "settings.branding.favicon",
        }
    }
}

/// Check an upload: PNG, within the size and dimension caps.
pub fn check_image(which: Image, bytes: &[u8]) -> Result<(u32, u32), ApiError> {
    let (max_bytes, max_dim) = which.limits();
    if bytes.len() > max_bytes {
        return Err(bad_request!(
            "branding.image_too_large",
            "image is larger than {max_kib} KiB",
            max_kib = max_bytes / 1024
        ));
    }
    let Some((w, h)) = png_dimensions(bytes) else {
        return Err(bad_request!(
            "branding.image_not_png",
            "image must be a PNG"
        ));
    };
    if w > max_dim || h > max_dim {
        return Err(bad_request!(
            "branding.image_dimensions",
            "image must be at most {max}×{max} pixels",
            max = max_dim
        ));
    }
    Ok((w, h))
}

// ---------------------------------------------------------------------------
// Text fields
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FooterLink {
    pub label: String,
    pub url: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Download {
    pub platform: String,
    #[serde(default)]
    pub label: Option<String>,
    pub url: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct BrandingReq {
    pub version: i64,
    #[serde(default)]
    pub footer_text: Option<String>,
    #[serde(default)]
    pub footer_links: Vec<FooterLink>,
    #[serde(default)]
    pub tos_url: Option<String>,
    #[serde(default)]
    pub privacy_url: Option<String>,
    #[serde(default)]
    pub client_downloads: Vec<Download>,
}

/// The validated text fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Fields {
    pub footer_text: Option<String>,
    pub footer_links: Vec<FooterLink>,
    pub tos_url: Option<String>,
    pub privacy_url: Option<String>,
    pub client_downloads: Vec<Download>,
}

fn label(s: &str) -> Result<String, ApiError> {
    let s = s.trim();
    if s.is_empty() || s.chars().count() > MAX_LABEL || s.chars().any(char::is_control) {
        return Err(bad_request!(
            "branding.label_invalid",
            "labels must be 1-{max} characters without control characters",
            max = MAX_LABEL
        ));
    }
    Ok(s.to_string())
}

/// A link target: `https://`/`http://` or same-origin (`/…`).
pub fn url(s: &str) -> Result<String, ApiError> {
    let s = s.trim();
    let ok = match safe_link(s) {
        Some(UrlKind::SameOrigin) => s.starts_with('/'),
        Some(UrlKind::Absolute) => !s.to_ascii_lowercase().starts_with("mailto:"),
        None => false,
    };
    if !ok {
        return Err(bad_request!(
            "branding.url_invalid",
            "links must start with https://, http:// or /"
        ));
    }
    Ok(s.to_string())
}

fn optional_url(s: &Option<String>) -> Result<Option<String>, ApiError> {
    match s.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(v) => url(v).map(Some),
    }
}

pub fn check(req: &BrandingReq) -> Result<Fields, ApiError> {
    let footer_text = match req.footer_text.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(t) => {
            if t.chars().count() > MAX_FOOTER || t.chars().any(|c| c.is_control() && c != '\n') {
                return Err(bad_request!(
                    "branding.footer_invalid",
                    "footer text must be at most {max} characters",
                    max = MAX_FOOTER
                ));
            }
            Some(t.to_string())
        }
    };
    if req.footer_links.len() > MAX_LINKS {
        return Err(bad_request!(
            "branding.too_many_links",
            "at most {max} footer links",
            max = MAX_LINKS
        ));
    }
    if req.client_downloads.len() > MAX_DOWNLOADS {
        return Err(bad_request!(
            "branding.too_many_downloads",
            "at most {max} download links",
            max = MAX_DOWNLOADS
        ));
    }
    let mut footer_links = Vec::new();
    for l in &req.footer_links {
        footer_links.push(FooterLink {
            label: label(&l.label)?,
            url: url(&l.url)?,
        });
    }
    let mut client_downloads = Vec::new();
    for d in &req.client_downloads {
        if !PLATFORMS.contains(&d.platform.as_str()) {
            return Err(bad_request!(
                "branding.platform_invalid",
                "platform must be one of: {allowed}",
                allowed = PLATFORMS.join(", ")
            ));
        }
        client_downloads.push(Download {
            platform: d.platform.clone(),
            label: match d.label.as_deref().map(str::trim) {
                None | Some("") => None,
                Some(l) => Some(label(l)?),
            },
            url: url(&d.url)?,
        });
    }
    Ok(Fields {
        footer_text,
        footer_links,
        tos_url: optional_url(&req.tos_url)?,
        privacy_url: optional_url(&req.privacy_url)?,
        client_downloads,
    })
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow, Debug, Clone)]
pub struct Stored {
    pub version: i64,
    pub logo_sha256: Option<Vec<u8>>,
    pub favicon_sha256: Option<Vec<u8>>,
    pub footer_text: Option<String>,
    pub footer_links: serde_json::Value,
    pub tos_url: Option<String>,
    pub privacy_url: Option<String>,
    pub client_downloads: serde_json::Value,
    pub updated_at: DateTime<Utc>,
}

const COLS: &str = "version, logo_sha256, favicon_sha256, footer_text, footer_links, tos_url, privacy_url, \
     client_downloads, updated_at";

pub async fn load(conn: &mut PgConnection) -> sqlx::Result<Stored> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM site_branding WHERE id = 1"
    )))
    .fetch_one(conn)
    .await
}

async fn lock(conn: &mut PgConnection) -> sqlx::Result<Stored> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM site_branding WHERE id = 1 FOR UPDATE"
    )))
    .fetch_one(conn)
    .await
}

impl Stored {
    pub fn fields(&self) -> Fields {
        Fields {
            footer_text: self.footer_text.clone(),
            footer_links: serde_json::from_value(self.footer_links.clone()).unwrap_or_default(),
            tos_url: self.tos_url.clone(),
            privacy_url: self.privacy_url.clone(),
            client_downloads: serde_json::from_value(self.client_downloads.clone())
                .unwrap_or_default(),
        }
    }
}

fn version_conflict() -> ApiError {
    conflict!(
        "branding.version_conflict",
        "设置已被修改（可能是其他管理员），请刷新后重试"
    )
}

/// Write the text fields (409 on a stale `expected_version`).
pub async fn apply_update(
    conn: &mut PgConnection,
    actor: &Actor,
    expected_version: i64,
    fields: &Fields,
) -> Result<Stored, ApiError> {
    let cur = lock(conn).await?;
    if cur.version != expected_version {
        return Err(version_conflict());
    }
    let before = cur.fields();
    if before == *fields {
        return Ok(cur);
    }
    let row: Stored = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE site_branding SET footer_text = $1, footer_links = $2, tos_url = $3, privacy_url = $4, \
           client_downloads = $5, version = version + 1, updated_at = now() WHERE id = 1 RETURNING {COLS}"
    )))
    .bind(&fields.footer_text)
    .bind(serde_json::to_value(&fields.footer_links).unwrap_or_default())
    .bind(&fields.tos_url)
    .bind(&fields.privacy_url)
    .bind(serde_json::to_value(&fields.client_downloads).unwrap_or_default())
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.branding.update",
        "settings",
        Some("branding".into()),
        Some(serde_json::to_value(&before).unwrap_or_default()),
        Some(serde_json::to_value(fields).unwrap_or_default()),
    )
    .await?;
    Ok(row)
}

/// Store an image (validated). Audited with sizes only.
pub async fn apply_set_image(
    conn: &mut PgConnection,
    actor: &Actor,
    which: Image,
    bytes: &[u8],
) -> Result<Stored, ApiError> {
    let (w, h) = check_image(which, bytes)?;
    let cur = lock(conn).await?;
    let sha = Sha256::digest(bytes).to_vec();
    let col = which.column();
    let row: Stored = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE site_branding SET {col} = $1, {col}_sha256 = $2, version = version + 1, \
           updated_at = now() WHERE id = 1 RETURNING {COLS}"
    )))
    .bind(bytes)
    .bind(&sha)
    .fetch_one(&mut *conn)
    .await?;
    let had = match which {
        Image::Logo => cur.logo_sha256.is_some(),
        Image::Favicon => cur.favicon_sha256.is_some(),
    };
    crate::audit::record(
        conn,
        actor,
        which.action(),
        "settings",
        Some("branding".into()),
        Some(json!({ "set": had })),
        Some(
            json!({ "set": true, "bytes": bytes.len(), "width": w, "height": h,
                     "sha256": hex::encode(&sha) }),
        ),
    )
    .await?;
    Ok(row)
}

/// Remove an image. Ok(None) = there was none (nothing audited).
pub async fn apply_clear_image(
    conn: &mut PgConnection,
    actor: &Actor,
    which: Image,
) -> Result<Option<Stored>, ApiError> {
    let cur = lock(conn).await?;
    let had = match which {
        Image::Logo => cur.logo_sha256.is_some(),
        Image::Favicon => cur.favicon_sha256.is_some(),
    };
    if !had {
        return Ok(None);
    }
    let col = which.column();
    let row: Stored = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE site_branding SET {col} = NULL, {col}_sha256 = NULL, version = version + 1, \
           updated_at = now() WHERE id = 1 RETURNING {COLS}"
    )))
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        which.action(),
        "settings",
        Some("branding".into()),
        Some(json!({ "set": true })),
        Some(json!({ "set": false })),
    )
    .await?;
    Ok(Some(row))
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// What the public (`/auth/options`) and the console see: no bytes.
#[derive(Serialize, Debug, Clone)]
pub struct View {
    pub version: i64,
    /// Prefix-relative URL with a cache-busting query (`brand/logo?v=…`), or null.
    pub logo_url: Option<String>,
    pub favicon_url: Option<String>,
    pub footer_text: Option<String>,
    pub footer_links: Vec<FooterLink>,
    pub tos_url: Option<String>,
    pub privacy_url: Option<String>,
    pub client_downloads: Vec<Download>,
    pub updated_at: DateTime<Utc>,
}

fn image_url(name: &str, sha: &Option<Vec<u8>>) -> Option<String> {
    sha.as_ref()
        .map(|s| format!("brand/{name}?v={}", hex::encode(&s[..8])))
}

impl From<Stored> for View {
    fn from(s: Stored) -> Self {
        let f = s.fields();
        View {
            version: s.version,
            logo_url: image_url("logo", &s.logo_sha256),
            favicon_url: image_url("favicon", &s.favicon_sha256),
            footer_text: f.footer_text,
            footer_links: f.footer_links,
            tos_url: f.tos_url,
            privacy_url: f.privacy_url,
            client_downloads: f.client_downloads,
            updated_at: s.updated_at,
        }
    }
}

/// The public view, or None when the database is unavailable (the login
/// page then shows no branding rather than failing).
pub async fn public_view(state: &AppState) -> Option<View> {
    let mut c = state.pg().acquire().await.ok()?;
    load(&mut c).await.ok().map(View::from)
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/// GET /api/v1/settings/branding (admin).
pub async fn get_branding(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<View>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    Ok(Json(View::from(load(&mut c).await?)))
}

/// PUT /api/v1/settings/branding (admin): the text fields.
pub async fn put_branding(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<BrandingReq>,
) -> Result<Json<View>, ApiError> {
    user.require_admin()?;
    let fields = check(&req)?;
    let mut tx = state.pg().begin().await?;
    let row = apply_update(&mut tx, &Actor::of(&user), req.version, &fields).await?;
    tx.commit().await?;
    Ok(Json(View::from(row)))
}

fn which(name: &str) -> Result<Image, ApiError> {
    Image::parse(name).ok_or_else(ApiError::not_found)
}

/// PUT /api/v1/settings/branding/{logo|favicon} (admin): the PNG bytes
/// as the request body (`image/png`).
pub async fn put_image(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, name)): Path<(String, String)>,
    body: Body,
) -> Result<Json<View>, ApiError> {
    user.require_admin()?;
    let which = which(&name)?;
    let (max, _) = which.limits();
    // Bounded read: one byte over the cap is refused like any other
    // oversized upload (the cap is the admin-facing error).
    let bytes = axum::body::to_bytes(body, max + 1).await.map_err(|_| {
        bad_request!(
            "branding.image_too_large",
            "image is larger than {max_kib} KiB",
            max_kib = max / 1024
        )
    })?;
    let mut tx = state.pg().begin().await?;
    let row = apply_set_image(&mut tx, &Actor::of(&user), which, &bytes).await?;
    tx.commit().await?;
    Ok(Json(View::from(row)))
}

/// DELETE /api/v1/settings/branding/{logo|favicon} (admin).
pub async fn delete_image(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, name)): Path<(String, String)>,
) -> Result<Json<View>, ApiError> {
    user.require_admin()?;
    let which = which(&name)?;
    let mut tx = state.pg().begin().await?;
    let row = match apply_clear_image(&mut tx, &Actor::of(&user), which).await? {
        Some(r) => r,
        None => load(&mut tx).await?,
    };
    tx.commit().await?;
    Ok(Json(View::from(row)))
}

/// GET /{prefix}/brand/{logo|favicon} (public): the PNG with cache
/// headers and an ETag; none stored = the canonical rejection.
pub async fn serve_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((_, name)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let Some(which) = Image::parse(&name) else {
        return Ok(crate::reject::not_found());
    };
    let col = which.column();
    type Stored = (Option<Vec<u8>>, Option<Vec<u8>>);
    let row: Option<Stored> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {col}, {col}_sha256 FROM site_branding WHERE id = 1"
    )))
    .fetch_optional(state.pg())
    .await?;
    let Some((Some(bytes), Some(sha))) = row else {
        return Ok(crate::reject::not_found());
    };
    let etag = format!("\"{}\"", hex::encode(&sha));
    let fresh = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag));
    let etag = HeaderValue::from_str(&etag).map_err(|_| ApiError::internal())?;
    let common = [
        (
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=86400"),
        ),
        (header::ETAG, etag),
        (header::CONTENT_TYPE, HeaderValue::from_static("image/png")),
    ];
    if fresh {
        return Ok((StatusCode::NOT_MODIFIED, common).into_response());
    }
    Ok((common, bytes).into_response())
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::get;
    axum::Router::new()
        .route("/{prefix}/brand/{name}", get(serve_image))
        .route(
            "/{prefix}/api/v1/settings/branding",
            get(get_branding).put(put_branding),
        )
        .route(
            "/{prefix}/api/v1/settings/branding/{name}",
            axum::routing::put(put_image).delete(delete_image),
        )
}

#[cfg(test)]
mod tests;
