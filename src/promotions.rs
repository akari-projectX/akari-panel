//! Promotions: the dashboard's activity slot (限时活动 · 倒计时 · 优惠码).
//!
//! - **Admins** (`/promotions*`, any admin, like announcements) create, edit
//!   and delete promotions: Chinese title and one-line description, optional
//!   English variants, an optional badge ("8折"), an optional coupon (stored
//!   by id; its code is shown only while the coupon is usable), an optional
//!   call to action (https / http / same-origin, default the shop), a
//!   required window and an audience. Every mutation is an `apply_*` in the
//!   caller's transaction with its audit row (`promotion.create/update/
//!   delete`); `version` guards the edit form (stale → 409).
//! - **Users** (`GET /me/promotion`, `auth::ShopUser`: the renewal scope sees
//!   sales prompts too) get the single best promotion visible to them right
//!   now (enabled, inside the window by the database clock, in the audience;
//!   highest `sort`, then the one ending soonest) or `null`, with the server
//!   clock for the countdown.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{
    api::ApiJson,
    audit::Actor,
    auth::{ApiError, AuthUser, ShopUser, bad_request, conflict},
    state::AppState,
};

pub const AUDIENCES: [&str; 3] = crate::announcements::AUDIENCES;
pub const MAX_TITLE_ZH: usize = 40;
pub const MAX_TITLE_EN: usize = 80;
pub const MAX_LINE_ZH: usize = 80;
pub const MAX_LINE_EN: usize = 160;
pub const MAX_BADGE: usize = 8;
pub const MAX_CTA_LABEL: usize = 16;
pub const MAX_SORT: i32 = 1_000_000;
/// Where the call to action goes when none is set.
pub const DEFAULT_CTA_URL: &str = "/shop";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/// Create / replace body (PUT replaces every field and carries `version`).
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct PromotionReq {
    pub title_zh: String,
    #[serde(default)]
    pub title_en: Option<String>,
    pub line_zh: String,
    #[serde(default)]
    pub line_en: Option<String>,
    #[serde(default)]
    pub badge: Option<String>,
    /// A coupon code (case-insensitive); absent or empty = none.
    #[serde(default)]
    pub coupon_code: Option<String>,
    #[serde(default)]
    pub cta_label: Option<String>,
    #[serde(default)]
    pub cta_url: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    #[serde(default = "all")]
    pub audience: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub sort: i32,
    /// The version the form was loaded at (required on PUT).
    #[serde(default)]
    pub version: Option<i32>,
}

fn yes() -> bool {
    true
}
fn all() -> String {
    "all".into()
}

/// A one-line text field: trimmed, no control characters, 1..=max.
fn line(field: &str, s: &str, max: usize) -> Result<String, ApiError> {
    let s = s.trim();
    if s.is_empty() {
        return Err(bad_request!(
            "promotion.text_required",
            "{field} is required",
            field = field
        ));
    }
    if s.chars().any(char::is_control) {
        return Err(bad_request!(
            "promotion.text_multiline",
            "{field} must be a single line",
            field = field
        ));
    }
    if s.chars().count() > max {
        return Err(bad_request!(
            "promotion.text_long",
            "{field} is longer than {max} characters",
            field = field,
            max = max
        ));
    }
    Ok(s.to_string())
}

/// Optional variant: empty / whitespace = absent.
fn optional(field: &str, s: &Option<String>, max: usize) -> Result<Option<String>, ApiError> {
    match s.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(v) => line(field, v, max).map(Some),
    }
}

/// The validated form of a request (the coupon still as typed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clean {
    pub title_zh: String,
    pub title_en: Option<String>,
    pub line_zh: String,
    pub line_en: Option<String>,
    pub badge: Option<String>,
    pub coupon_code: Option<String>,
    pub cta_label: Option<String>,
    pub cta_url: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub audience: String,
    pub enabled: bool,
    pub sort: i32,
}

pub fn check(req: &PromotionReq) -> Result<Clean, ApiError> {
    if !AUDIENCES.contains(&req.audience.as_str()) {
        return Err(bad_request!(
            "promotion.audience_invalid",
            "audience must be one of: {allowed}",
            allowed = AUDIENCES.join(", ")
        ));
    }
    if req.starts_at >= req.ends_at {
        return Err(bad_request!(
            "promotion.window_invalid",
            "starts_at must be before ends_at"
        ));
    }
    if !(-MAX_SORT..=MAX_SORT).contains(&req.sort) {
        return Err(bad_request!(
            "promotion.sort_invalid",
            "sort must be between -{max} and {max}",
            max = MAX_SORT
        ));
    }
    let cta_url = match req.cta_url.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(v) => Some(crate::branding::url(v).map_err(|_| {
            bad_request!(
                "promotion.cta_url_invalid",
                "the link must start with https://, http:// or /"
            )
        })?),
    };
    Ok(Clean {
        title_zh: line("title_zh", &req.title_zh, MAX_TITLE_ZH)?,
        title_en: optional("title_en", &req.title_en, MAX_TITLE_EN)?,
        line_zh: line("line_zh", &req.line_zh, MAX_LINE_ZH)?,
        line_en: optional("line_en", &req.line_en, MAX_LINE_EN)?,
        badge: optional("badge", &req.badge, MAX_BADGE)?,
        coupon_code: optional("coupon_code", &req.coupon_code, 32)?,
        cta_label: optional("cta_label", &req.cta_label, MAX_CTA_LABEL)?,
        cta_url,
        starts_at: req.starts_at,
        ends_at: req.ends_at,
        audience: req.audience.clone(),
        enabled: req.enabled,
        sort: req.sort,
    })
}

/// The coupon's id by code (case-insensitive). Locks it against a concurrent
/// delete; unknown = 400.
async fn coupon_id(conn: &mut PgConnection, code: Option<&str>) -> Result<Option<Uuid>, ApiError> {
    let Some(code) = code else {
        return Ok(None);
    };
    let id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM coupons WHERE lower(code) = lower($1) FOR KEY SHARE")
            .bind(code)
            .fetch_optional(conn)
            .await?;
    id.map(Some).ok_or_else(|| {
        bad_request!(
            "promotion.coupon_unknown",
            "no coupon with code {code}",
            code = code
        )
    })
}

// ---------------------------------------------------------------------------
// Mutations (caller's transaction; audited)
// ---------------------------------------------------------------------------

fn snapshot(c: &Clean, coupon: Option<Uuid>) -> serde_json::Value {
    json!({
        "title_zh": c.title_zh, "title_en": c.title_en, "line_zh": c.line_zh, "line_en": c.line_en,
        "badge": c.badge, "coupon_id": coupon, "cta_label": c.cta_label, "cta_url": c.cta_url,
        "starts_at": c.starts_at, "ends_at": c.ends_at, "audience": c.audience,
        "enabled": c.enabled, "sort": c.sort,
    })
}

#[derive(Clone, Copy)]
enum Store {
    Insert,
    Update,
}

/// Write every editable field (`$2..$14` in the same order for both): a new
/// row, or a replacement that also moves `version` on.
async fn store(
    conn: &mut PgConnection,
    how: Store,
    id: Uuid,
    c: &Clean,
    coupon: Option<Uuid>,
) -> sqlx::Result<()> {
    let sql = match how {
        Store::Insert => {
            "INSERT INTO promotions (id, title_zh, title_en, line_zh, line_en, badge, coupon_id, \
               cta_label, cta_url, starts_at, ends_at, audience, enabled, sort) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)"
        }
        Store::Update => {
            "UPDATE promotions SET title_zh = $2, title_en = $3, line_zh = $4, line_en = $5, badge = $6, \
               coupon_id = $7, cta_label = $8, cta_url = $9, starts_at = $10, ends_at = $11, \
               audience = $12, enabled = $13, sort = $14, version = version + 1, updated_at = now() \
             WHERE id = $1"
        }
    };
    sqlx::query(sql)
        .bind(id)
        .bind(&c.title_zh)
        .bind(&c.title_en)
        .bind(&c.line_zh)
        .bind(&c.line_en)
        .bind(&c.badge)
        .bind(coupon)
        .bind(&c.cta_label)
        .bind(&c.cta_url)
        .bind(c.starts_at)
        .bind(c.ends_at)
        .bind(&c.audience)
        .bind(c.enabled)
        .bind(c.sort)
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn apply_create(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &PromotionReq,
) -> Result<Uuid, ApiError> {
    let c = check(req)?;
    let coupon = coupon_id(conn, c.coupon_code.as_deref()).await?;
    let id = Uuid::new_v4();
    store(conn, Store::Insert, id, &c, coupon).await?;
    crate::audit::record(
        conn,
        actor,
        "promotion.create",
        "promotion",
        Some(id.to_string()),
        None,
        Some(snapshot(&c, coupon)),
    )
    .await?;
    Ok(id)
}

#[derive(sqlx::FromRow)]
struct Locked {
    title_zh: String,
    title_en: Option<String>,
    line_zh: String,
    line_en: Option<String>,
    badge: Option<String>,
    coupon_id: Option<Uuid>,
    cta_label: Option<String>,
    cta_url: Option<String>,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    audience: String,
    enabled: bool,
    sort: i32,
    version: i32,
}

impl Locked {
    fn snapshot(&self) -> serde_json::Value {
        json!({
            "title_zh": self.title_zh, "title_en": self.title_en, "line_zh": self.line_zh,
            "line_en": self.line_en, "badge": self.badge, "coupon_id": self.coupon_id,
            "cta_label": self.cta_label, "cta_url": self.cta_url, "starts_at": self.starts_at,
            "ends_at": self.ends_at, "audience": self.audience, "enabled": self.enabled,
            "sort": self.sort,
        })
    }
}

async fn lock_row(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Option<Locked>> {
    sqlx::query_as(
        "SELECT title_zh, title_en, line_zh, line_en, badge, coupon_id, cta_label, cta_url, \
           starts_at, ends_at, audience, enabled, sort, version FROM promotions WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
}

/// Replace every field. Ok(false) = no such promotion; a missing or stale
/// `version` is 400 / 409.
pub async fn apply_update(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &PromotionReq,
) -> Result<bool, ApiError> {
    let Some(expected) = req.version else {
        return Err(bad_request!(
            "promotion.version_required",
            "version is required"
        ));
    };
    let c = check(req)?;
    let Some(before) = lock_row(conn, id).await? else {
        return Ok(false);
    };
    if before.version != expected {
        return Err(conflict!(
            "promotion.version_conflict",
            "this promotion was changed by someone else; reload it"
        ));
    }
    let coupon = coupon_id(conn, c.coupon_code.as_deref()).await?;
    store(conn, Store::Update, id, &c, coupon).await?;
    crate::audit::record(
        conn,
        actor,
        "promotion.update",
        "promotion",
        Some(id.to_string()),
        Some(before.snapshot()),
        Some(snapshot(&c, coupon)),
    )
    .await?;
    Ok(true)
}

/// Ok(false) = no such promotion.
pub async fn apply_delete(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<bool, ApiError> {
    let Some(before) = lock_row(conn, id).await? else {
        return Ok(false);
    };
    sqlx::query("DELETE FROM promotions WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "promotion.delete",
        "promotion",
        Some(id.to_string()),
        Some(before.snapshot()),
        None,
    )
    .await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// The coupon (alias `c`) can be used right now: its code is worth showing.
const COUPON_USABLE: &str = "(c.enabled AND (c.starts_at IS NULL OR c.starts_at <= now()) \
     AND (c.ends_at IS NULL OR c.ends_at > now()) AND (c.max_uses IS NULL OR c.used < c.max_uses))";

/// Live and visible to user `$1` now (alias `p`).
const VISIBLE: &str = "p.enabled AND p.starts_at <= now() AND p.ends_at > now() \
     AND (p.audience = 'all' OR (p.audience = 'with_plan') = EXISTS (SELECT 1 FROM user_plans up \
         WHERE up.user_id = $1 AND up.status = 'active'))";

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct Row {
    pub id: Uuid,
    pub title_zh: String,
    pub title_en: Option<String>,
    pub line_zh: String,
    pub line_en: Option<String>,
    pub badge: Option<String>,
    /// The coupon's current code (null without one, or after it was deleted).
    pub coupon_code: Option<String>,
    /// The code is shown to users right now.
    pub coupon_usable: bool,
    pub cta_label: Option<String>,
    pub cta_url: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub audience: String,
    pub enabled: bool,
    pub sort: i32,
    pub version: i32,
    /// Enabled and inside its window now (audience aside).
    pub active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn admin_select() -> String {
    format!(
        "SELECT p.id, p.title_zh, p.title_en, p.line_zh, p.line_en, p.badge, c.code AS coupon_code, \
           coalesce({COUPON_USABLE}, false) AS coupon_usable, p.cta_label, p.cta_url, p.starts_at, \
           p.ends_at, p.audience, p.enabled, p.sort, p.version, \
           (p.enabled AND p.starts_at <= now() AND p.ends_at > now()) AS active, \
           p.created_at, p.updated_at \
         FROM promotions p LEFT JOIN coupons c ON c.id = p.coupon_id"
    )
}

/// What a user sees: both languages (the portal picks), the coupon code only
/// while usable, the link (default the shop).
#[derive(Serialize, Debug)]
pub struct MyPromotion {
    pub id: Uuid,
    pub title_zh: String,
    pub title_en: Option<String>,
    pub line_zh: String,
    pub line_en: Option<String>,
    pub badge: Option<String>,
    pub code: Option<String>,
    pub cta_label: Option<String>,
    pub cta_url: String,
    pub ends_at: DateTime<Utc>,
}

#[derive(Serialize, Debug)]
pub struct MyPromotionView {
    pub promotion: Option<MyPromotion>,
    /// The database clock, for the countdown (the device clock may be off).
    pub now: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct MyRow {
    id: Uuid,
    title_zh: String,
    title_en: Option<String>,
    line_zh: String,
    line_en: Option<String>,
    badge: Option<String>,
    code: Option<String>,
    cta_label: Option<String>,
    cta_url: Option<String>,
    ends_at: DateTime<Utc>,
}

/// The single best promotion visible to `user` now.
pub async fn visible_to(conn: &mut PgConnection, user: Uuid) -> sqlx::Result<MyPromotionView> {
    let row: Option<MyRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT p.id, p.title_zh, p.title_en, p.line_zh, p.line_en, p.badge, \
           CASE WHEN {COUPON_USABLE} THEN c.code END AS code, p.cta_label, p.cta_url, p.ends_at \
         FROM promotions p LEFT JOIN coupons c ON c.id = p.coupon_id \
         WHERE {VISIBLE} ORDER BY p.sort DESC, p.ends_at, p.id LIMIT 1"
    )))
    .bind(user)
    .fetch_optional(&mut *conn)
    .await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *conn)
        .await?;
    Ok(MyPromotionView {
        promotion: row.map(|r| MyPromotion {
            id: r.id,
            title_zh: r.title_zh,
            title_en: r.title_en,
            line_zh: r.line_zh,
            line_en: r.line_en,
            badge: r.badge,
            code: r.code,
            cta_label: r.cta_label,
            cta_url: r.cta_url.unwrap_or_else(|| DEFAULT_CTA_URL.into()),
            ends_at: r.ends_at,
        }),
        now,
    })
}

// ---------------------------------------------------------------------------
// User API
// ---------------------------------------------------------------------------

/// GET /me/promotion.
pub async fn my_promotion(
    State(state): State<AppState>,
    u: ShopUser,
) -> Result<Json<MyPromotionView>, ApiError> {
    let mut c = state.pg().acquire().await?;
    Ok(Json(visible_to(&mut c, u.user.id).await?))
}

// ---------------------------------------------------------------------------
// Admin API (/promotions*)
// ---------------------------------------------------------------------------

/// GET /promotions (admin): every promotion, live ones first.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<Row>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(format!(
        "{} ORDER BY p.ends_at < now(), p.sort DESC, p.ends_at, p.id LIMIT 500",
        admin_select()
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// POST /promotions (admin) → 201 {id}.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<PromotionReq>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let id = apply_create(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

/// PUT /promotions/{id} (admin): replace every field.
pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<PromotionReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let actor = Actor::of(&user);
    let mut tx = state.pg().begin().await?;
    let found = apply_update(&mut tx, &actor, id, &req).await?;
    tx.commit().await?;
    done(found)
}

/// DELETE /promotions/{id} (admin).
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let actor = Actor::of(&user);
    let mut tx = state.pg().begin().await?;
    let found = apply_delete(&mut tx, &actor, id).await?;
    tx.commit().await?;
    done(found)
}

/// 204, or 404 when the promotion did not exist (nothing was written then).
fn done(found: bool) -> Result<StatusCode, ApiError> {
    if found {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found())
    }
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, put};
    axum::Router::new()
        .route("/{prefix}/api/v1/me/promotion", get(my_promotion))
        .route("/{prefix}/api/v1/promotions", get(list).post(create))
        .route(
            "/{prefix}/api/v1/promotions/{id}",
            put(update).delete(delete),
        )
}

#[cfg(test)]
mod tests;
