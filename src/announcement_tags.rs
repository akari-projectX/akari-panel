//! Ops: announcement tags (公告标签): the small coloured label in front of
//! an announcement's title ([活动] [维护] ...).
//!
//! - A tag is a Chinese name, an optional English name and one of eleven
//!   preset colour keys (`COLORS`; the portal and the admin map the key to
//!   a CSS variable, so no free colour and every tag reads well in both
//!   themes). Tags are ordered, can be disabled and are seeded by the
//!   migration (eight presets).
//! - A tag that announcements use cannot be deleted (409 with the count),
//!   only disabled: a disabled tag stays on the announcements that have it
//!   but cannot be picked for another one (`announcements::tag_pickable`).
//! - **Admins** (`/announcement-tags*`) manage them; every mutation is an
//!   `apply_*` in the caller's transaction with its audit row
//!   (`announcement_tag.create/update/delete/reorder`). Users never call
//!   this module: `/me/announcements*` carry the tag of each announcement
//!   (`UserTag`).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::state::AppState;

/// The preset colour keys (the migration's CHECK lists the same).
pub const COLORS: [&str; 11] = [
    "red", "orange", "amber", "green", "teal", "cyan", "blue", "indigo", "violet", "pink", "slate",
];
/// Longest tag name (characters): a tag is a word, not a sentence.
pub const MAX_NAME: usize = 12;
const MAX_SORT: i32 = 1_000_000;

/// A tag as a user sees it: both names (the portal picks by language,
/// like the announcement titles) and the colour key.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct UserTag {
    pub id: Uuid,
    pub name_zh: String,
    pub name_en: Option<String>,
    pub color: String,
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/// Create / replace body (PUT replaces every field).
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct TagReq {
    pub name_zh: String,
    #[serde(default)]
    pub name_en: Option<String>,
    pub color: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// A tag name: trimmed like an announcement title (one line, no control
/// characters), 1..=MAX_NAME characters.
pub fn clean_name(s: &str) -> Result<String, ApiError> {
    let s = s.trim();
    if s.is_empty() {
        return Err(bad_request!(
            "announcement_tag.name_required",
            "name is required"
        ));
    }
    if s.chars().any(char::is_control) {
        return Err(bad_request!(
            "announcement_tag.name_multiline",
            "name must be a single line"
        ));
    }
    if s.chars().count() > MAX_NAME {
        return Err(bad_request!(
            "announcement_tag.name_long",
            "name is longer than {max} characters",
            max = MAX_NAME
        ));
    }
    Ok(s.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clean {
    pub name_zh: String,
    pub name_en: Option<String>,
    pub color: String,
    pub enabled: bool,
}

pub fn check(req: &TagReq) -> Result<Clean, ApiError> {
    if !COLORS.contains(&req.color.as_str()) {
        return Err(bad_request!(
            "announcement_tag.color_invalid",
            "color must be one of: {allowed}",
            allowed = COLORS.join(", ")
        ));
    }
    let name_en = match req.name_en.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(v) => Some(clean_name(v)?),
    };
    Ok(Clean {
        name_zh: clean_name(&req.name_zh)?,
        name_en,
        color: req.color.clone(),
        enabled: req.enabled,
    })
}

// ---------------------------------------------------------------------------
// Mutations (caller's transaction; audited)
// ---------------------------------------------------------------------------

fn snapshot(c: &Clean) -> serde_json::Value {
    json!({ "name_zh": c.name_zh, "name_en": c.name_en, "color": c.color, "enabled": c.enabled })
}

pub async fn apply_create(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &TagReq,
) -> Result<Uuid, ApiError> {
    let c = check(req)?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO announcement_tags (name_zh, name_en, color, enabled, sort) \
         VALUES ($1, $2, $3, $4, (SELECT LEAST(coalesce(max(sort) + 1, 0), $5) FROM announcement_tags)) \
         RETURNING id",
    )
    .bind(&c.name_zh)
    .bind(&c.name_en)
    .bind(&c.color)
    .bind(c.enabled)
    .bind(MAX_SORT)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "announcement_tag.create",
        "announcement_tag",
        Some(id.to_string()),
        None,
        Some(snapshot(&c)),
    )
    .await?;
    Ok(id)
}

/// Lock one tag and return its editable fields (None = no such tag).
async fn lock_row(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Option<Clean>> {
    let row: Option<(String, Option<String>, String, bool)> = sqlx::query_as(
        "SELECT name_zh, name_en, color, enabled FROM announcement_tags WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|(name_zh, name_en, color, enabled)| Clean {
        name_zh,
        name_en,
        color,
        enabled,
    }))
}

/// Replace every field. Ok(false) = no such tag.
pub async fn apply_update(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &TagReq,
) -> Result<bool, ApiError> {
    let c = check(req)?;
    let Some(before) = lock_row(conn, id).await? else {
        return Ok(false);
    };
    if before == c {
        return Ok(true);
    }
    sqlx::query(
        "UPDATE announcement_tags SET name_zh = $2, name_en = $3, color = $4, enabled = $5 WHERE id = $1",
    )
    .bind(id)
    .bind(&c.name_zh)
    .bind(&c.name_en)
    .bind(&c.color)
    .bind(c.enabled)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "announcement_tag.update",
        "announcement_tag",
        Some(id.to_string()),
        Some(snapshot(&before)),
        Some(snapshot(&c)),
    )
    .await?;
    Ok(true)
}

/// Delete an unused tag. 409 `announcement_tag.in_use` (with the count)
/// while announcements carry it. Ok(false) = no such tag.
pub async fn apply_delete(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<bool, ApiError> {
    let Some(before) = lock_row(conn, id).await? else {
        return Ok(false);
    };
    let uses: i64 = sqlx::query_scalar("SELECT count(*) FROM announcements WHERE tag_id = $1")
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
    if uses > 0 {
        return Err(conflict!(
            "announcement_tag.in_use",
            "{count} announcements use this tag; disable it instead",
            count = uses
        ));
    }
    sqlx::query("DELETE FROM announcement_tags WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "announcement_tag.delete",
        "announcement_tag",
        Some(id.to_string()),
        Some(snapshot(&before)),
        None,
    )
    .await?;
    Ok(true)
}

/// Put the tags in the given order. `ids` must be exactly the existing
/// tags (a tag created or deleted since the page loaded = 409, reload).
pub async fn apply_reorder(
    conn: &mut PgConnection,
    actor: &Actor,
    ids: &[Uuid],
) -> Result<(), ApiError> {
    let current: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM announcement_tags ORDER BY sort, created_at, id FOR UPDATE",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut want = ids.to_vec();
    want.sort();
    want.dedup();
    let mut have = current.clone();
    have.sort();
    if want.len() != ids.len() || want != have {
        return Err(conflict!(
            "announcement_tag.order_stale",
            "the tag list changed; reload and try again"
        ));
    }
    if current == ids {
        return Ok(());
    }
    sqlx::query(
        "UPDATE announcement_tags t SET sort = o.pos::int - 1 \
         FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, pos) WHERE t.id = o.id",
    )
    .bind(ids)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "announcement_tag.reorder",
        "announcement_tag",
        None,
        Some(json!({ "ids": current })),
        Some(json!({ "ids": ids })),
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Admin API (/announcement-tags*)
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct Row {
    pub id: Uuid,
    pub name_zh: String,
    pub name_en: Option<String>,
    pub color: String,
    pub enabled: bool,
    pub sort: i32,
    /// Announcements carrying the tag.
    pub uses: i64,
    pub created_at: DateTime<Utc>,
}

/// GET /announcement-tags (admin): in display order.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<Row>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, Row>(
        "SELECT t.id, t.name_zh, t.name_en, t.color, t.enabled, t.sort, \
           (SELECT count(*) FROM announcements a WHERE a.tag_id = t.id) AS uses, t.created_at \
         FROM announcement_tags t ORDER BY t.sort, t.created_at, t.id",
    )
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// POST /announcement-tags (admin) → 201 {id}; appended last.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<TagReq>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let id = apply_create(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

/// PUT /announcement-tags/{id} (admin): replace every field.
pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<TagReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    if !apply_update(&mut tx, &Actor::of(&user), id, &req).await? {
        return Err(ApiError::not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /announcement-tags/{id} (admin): 409 while announcements use it.
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    if !apply_delete(&mut tx, &Actor::of(&user), id).await? {
        return Err(ApiError::not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct OrderReq {
    pub ids: Vec<Uuid>,
}

/// PUT /announcement-tags/order {ids} (admin): the whole list, in order.
pub async fn reorder(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<OrderReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_reorder(&mut tx, &Actor::of(&user), &req.ids).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, put};
    axum::Router::new()
        .route("/{prefix}/api/v1/announcement-tags", get(list).post(create))
        .route("/{prefix}/api/v1/announcement-tags/order", put(reorder))
        .route(
            "/{prefix}/api/v1/announcement-tags/{id}",
            put(update).delete(delete),
        )
}

#[cfg(test)]
mod tests;
