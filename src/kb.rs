//! Ops: knowledge base (知识库 / 帮助, xboard parity).
//!
//! - **Admins** (`/kb/categories*`, `/kb/articles*`) manage categories
//!   (Chinese name, optional English, sort) and articles (Chinese title
//!   and Markdown body, optional English variants, category, sort,
//!   published). Mutations are `apply_*` in the caller's transaction with
//!   audit rows (`kb.category.*`, `kb.article.*`).
//! - **Users** (`/me/help*`, `auth::ShopUser`: help is for everyone with
//!   an account, the renewal scope included) see published articles
//!   grouped by category, optionally filtered by `?q=` (title and body,
//!   both languages), and read one rendered to HTML server-side
//!   (`markdown.rs`). An unpublished, unknown or malformed article id is
//!   the canonical rejection (`reject::not_found()`).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::announcements::{clean_markdown, clean_title};
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{bad_request, ApiError, AuthUser, ShopUser};
use crate::state::AppState;

pub const MAX_NAME: usize = 64;
pub const MAX_SORT: i32 = 1_000_000;
/// Longest search text (characters).
pub const MAX_QUERY: usize = 64;
/// Articles listed to a user at most.
const USER_LIMIT: i64 = 500;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct CategoryReq {
    pub name_zh: String,
    #[serde(default)]
    pub name_en: Option<String>,
    #[serde(default)]
    pub sort: i32,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct ArticleReq {
    #[serde(default)]
    pub category_id: Option<Uuid>,
    pub title_zh: String,
    #[serde(default)]
    pub title_en: Option<String>,
    pub body_zh: String,
    #[serde(default)]
    pub body_en: Option<String>,
    #[serde(default)]
    pub sort: i32,
    #[serde(default)]
    pub published: bool,
}

/// A category name: one line, 1..=MAX_NAME characters.
pub fn clean_name(s: &str) -> Result<String, ApiError> {
    let s = s.trim();
    if s.is_empty() {
        return Err(bad_request!("kb.name_required", "name is required"));
    }
    if s.chars().any(char::is_control) {
        return Err(bad_request!(
            "kb.name_multiline",
            "name must be a single line"
        ));
    }
    if s.chars().count() > MAX_NAME {
        return Err(bad_request!(
            "kb.name_long",
            "name is longer than {max} characters",
            max = MAX_NAME
        ));
    }
    Ok(s.to_string())
}

fn check_sort(sort: i32) -> Result<i32, ApiError> {
    if sort.abs() > MAX_SORT {
        return Err(bad_request!(
            "kb.sort_range",
            "sort must be within ±{max}",
            max = MAX_SORT
        ));
    }
    Ok(sort)
}

fn optional(
    s: &Option<String>,
    f: impl Fn(&str) -> Result<String, ApiError>,
) -> Result<Option<String>, ApiError> {
    match s.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(v) => f(v).map(Some),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanCategory {
    pub name_zh: String,
    pub name_en: Option<String>,
    pub sort: i32,
}

pub fn check_category(req: &CategoryReq) -> Result<CleanCategory, ApiError> {
    Ok(CleanCategory {
        name_zh: clean_name(&req.name_zh)?,
        name_en: optional(&req.name_en, clean_name)?,
        sort: check_sort(req.sort)?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanArticle {
    pub category_id: Option<Uuid>,
    pub title_zh: String,
    pub title_en: Option<String>,
    pub body_zh: String,
    pub body_en: Option<String>,
    pub sort: i32,
    pub published: bool,
}

pub fn check_article(req: &ArticleReq) -> Result<CleanArticle, ApiError> {
    Ok(CleanArticle {
        category_id: req.category_id,
        title_zh: clean_title(&req.title_zh)?,
        title_en: optional(&req.title_en, clean_title)?,
        body_zh: clean_markdown(&req.body_zh)?,
        body_en: optional(&req.body_en, clean_markdown)?,
        sort: check_sort(req.sort)?,
        published: req.published,
    })
}

// ---------------------------------------------------------------------------
// Mutations (caller's transaction; audited)
// ---------------------------------------------------------------------------

fn cat_json(c: &CleanCategory) -> serde_json::Value {
    json!({ "name_zh": c.name_zh, "name_en": c.name_en, "sort": c.sort })
}

fn art_json(a: &CleanArticle) -> serde_json::Value {
    json!({
        "category_id": a.category_id, "title_zh": a.title_zh, "title_en": a.title_en,
        "sort": a.sort, "published": a.published,
        "body_zh_length": a.body_zh.chars().count(),
        "body_en_length": a.body_en.as_ref().map(|b| b.chars().count()),
    })
}

pub async fn apply_create_category(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &CategoryReq,
) -> Result<Uuid, ApiError> {
    let c = check_category(req)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO kb_categories (id, name_zh, name_en, sort) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(&c.name_zh)
        .bind(&c.name_en)
        .bind(c.sort)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "kb.category.create",
        "kb_category",
        Some(id.to_string()),
        None,
        Some(cat_json(&c)),
    )
    .await?;
    Ok(id)
}

async fn lock_category(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Option<CleanCategory>> {
    let row: Option<(String, Option<String>, i32)> =
        sqlx::query_as("SELECT name_zh, name_en, sort FROM kb_categories WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(conn)
            .await?;
    Ok(row.map(|(name_zh, name_en, sort)| CleanCategory {
        name_zh,
        name_en,
        sort,
    }))
}

/// Ok(false) = no such category.
pub async fn apply_update_category(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &CategoryReq,
) -> Result<bool, ApiError> {
    let c = check_category(req)?;
    let Some(before) = lock_category(conn, id).await? else {
        return Ok(false);
    };
    if before == c {
        return Ok(true);
    }
    sqlx::query("UPDATE kb_categories SET name_zh = $2, name_en = $3, sort = $4 WHERE id = $1")
        .bind(id)
        .bind(&c.name_zh)
        .bind(&c.name_en)
        .bind(c.sort)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "kb.category.update",
        "kb_category",
        Some(id.to_string()),
        Some(cat_json(&before)),
        Some(cat_json(&c)),
    )
    .await?;
    Ok(true)
}

/// Delete a category (its articles become uncategorized). Ok(false) = none.
pub async fn apply_delete_category(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<bool, ApiError> {
    let Some(before) = lock_category(conn, id).await? else {
        return Ok(false);
    };
    sqlx::query("DELETE FROM kb_categories WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "kb.category.delete",
        "kb_category",
        Some(id.to_string()),
        Some(cat_json(&before)),
        None,
    )
    .await?;
    Ok(true)
}

async fn category_exists(conn: &mut PgConnection, id: Option<Uuid>) -> Result<(), ApiError> {
    let Some(id) = id else {
        return Ok(());
    };
    let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM kb_categories WHERE id = $1)")
        .bind(id)
        .fetch_one(conn)
        .await?;
    if ok {
        Ok(())
    } else {
        Err(bad_request!("kb.category_unknown", "unknown category"))
    }
}

pub async fn apply_create_article(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &ArticleReq,
) -> Result<Uuid, ApiError> {
    let a = check_article(req)?;
    category_exists(conn, a.category_id).await?;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO kb_articles (id, category_id, title_zh, title_en, body_zh, body_en, sort, published) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(id)
    .bind(a.category_id)
    .bind(&a.title_zh)
    .bind(&a.title_en)
    .bind(&a.body_zh)
    .bind(&a.body_en)
    .bind(a.sort)
    .bind(a.published)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "kb.article.create",
        "kb_article",
        Some(id.to_string()),
        None,
        Some(art_json(&a)),
    )
    .await?;
    Ok(id)
}

async fn lock_article(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Option<CleanArticle>> {
    #[derive(sqlx::FromRow)]
    struct Locked {
        category_id: Option<Uuid>,
        title_zh: String,
        title_en: Option<String>,
        body_zh: String,
        body_en: Option<String>,
        sort: i32,
        published: bool,
    }
    let row: Option<Locked> = sqlx::query_as(
        "SELECT category_id, title_zh, title_en, body_zh, body_en, sort, published \
         FROM kb_articles WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|r| CleanArticle {
        category_id: r.category_id,
        title_zh: r.title_zh,
        title_en: r.title_en,
        body_zh: r.body_zh,
        body_en: r.body_en,
        sort: r.sort,
        published: r.published,
    }))
}

/// Ok(false) = no such article.
pub async fn apply_update_article(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &ArticleReq,
) -> Result<bool, ApiError> {
    let a = check_article(req)?;
    let Some(before) = lock_article(conn, id).await? else {
        return Ok(false);
    };
    if before == a {
        return Ok(true);
    }
    category_exists(conn, a.category_id).await?;
    sqlx::query(
        "UPDATE kb_articles SET category_id = $2, title_zh = $3, title_en = $4, body_zh = $5, \
           body_en = $6, sort = $7, published = $8, updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(a.category_id)
    .bind(&a.title_zh)
    .bind(&a.title_en)
    .bind(&a.body_zh)
    .bind(&a.body_en)
    .bind(a.sort)
    .bind(a.published)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "kb.article.update",
        "kb_article",
        Some(id.to_string()),
        Some(art_json(&before)),
        Some(art_json(&a)),
    )
    .await?;
    Ok(true)
}

/// Ok(false) = no such article.
pub async fn apply_delete_article(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<bool, ApiError> {
    let Some(before) = lock_article(conn, id).await? else {
        return Ok(false);
    };
    sqlx::query("DELETE FROM kb_articles WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "kb.article.delete",
        "kb_article",
        Some(id.to_string()),
        Some(art_json(&before)),
        None,
    )
    .await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct CategoryRow {
    pub id: Uuid,
    pub name_zh: String,
    pub name_en: Option<String>,
    pub sort: i32,
    pub articles: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ArticleRow {
    pub id: Uuid,
    pub category_id: Option<Uuid>,
    pub category_name: Option<String>,
    pub title_zh: String,
    pub title_en: Option<String>,
    pub body_zh: String,
    pub body_en: Option<String>,
    pub sort: i32,
    pub published: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const ARTICLE_SELECT: &str =
    "SELECT a.id, a.category_id, c.name_zh AS category_name, a.title_zh, a.title_en, \
       a.body_zh, a.body_en, a.sort, a.published, a.created_at, a.updated_at \
     FROM kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id";

/// A published article as a user sees it in the list.
#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct HelpItem {
    pub id: Uuid,
    pub category_id: Option<Uuid>,
    pub title_zh: String,
    pub title_en: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize, Debug)]
pub struct HelpCategory {
    pub id: Uuid,
    pub name_zh: String,
    pub name_en: Option<String>,
    pub articles: Vec<HelpItem>,
}

#[derive(Serialize, Debug)]
pub struct HelpList {
    pub categories: Vec<HelpCategory>,
    /// Published articles without a category.
    pub uncategorized: Vec<HelpItem>,
    pub total: usize,
}

#[derive(Serialize)]
pub struct HelpArticle {
    pub id: Uuid,
    pub category_id: Option<Uuid>,
    pub category_zh: Option<String>,
    pub category_en: Option<String>,
    pub title_zh: String,
    pub title_en: Option<String>,
    pub html_zh: String,
    pub html_en: Option<String>,
    pub updated_at: DateTime<Utc>,
}

/// A search text: trimmed, ≤ MAX_QUERY characters; None = no filter.
pub fn clean_query(q: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(q) = q.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if q.chars().count() > MAX_QUERY {
        return Err(bad_request!(
            "kb.query_long",
            "search text is longer than {max} characters",
            max = MAX_QUERY
        ));
    }
    Ok(Some(q.to_string()))
}

fn like_pattern(q: &str) -> String {
    let escaped = q
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// Published articles grouped by category (categories by sort), filtered
/// by `q` (substring of a title or body, either language).
pub async fn help_list(conn: &mut PgConnection, q: Option<&str>) -> sqlx::Result<HelpList> {
    let pattern = q.map(like_pattern);
    let items: Vec<HelpItem> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT a.id, a.category_id, a.title_zh, a.title_en, a.updated_at FROM kb_articles a \
         WHERE a.published AND ($1::text IS NULL OR a.title_zh ILIKE $1 OR a.title_en ILIKE $1 \
           OR a.body_zh ILIKE $1 OR a.body_en ILIKE $1) \
         ORDER BY a.sort, a.created_at, a.id LIMIT {USER_LIMIT}"
    )))
    .bind(&pattern)
    .fetch_all(&mut *conn)
    .await?;
    let cats: Vec<(Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT id, name_zh, name_en FROM kb_categories ORDER BY sort, created_at, id",
    )
    .fetch_all(&mut *conn)
    .await?;
    let total = items.len();
    let mut uncategorized = Vec::new();
    let mut by_cat: std::collections::HashMap<Uuid, Vec<HelpItem>> =
        std::collections::HashMap::new();
    for it in items {
        match it.category_id {
            Some(c) => by_cat.entry(c).or_default().push(it),
            None => uncategorized.push(it),
        }
    }
    let categories = cats
        .into_iter()
        .filter_map(|(id, name_zh, name_en)| {
            let articles = by_cat.remove(&id)?;
            Some(HelpCategory {
                id,
                name_zh,
                name_en,
                articles,
            })
        })
        .collect();
    Ok(HelpList {
        categories,
        uncategorized,
        total,
    })
}

/// One published article, rendered. None = unpublished or unknown.
pub async fn help_article(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Option<HelpArticle>> {
    #[derive(sqlx::FromRow)]
    struct Locked {
        id: Uuid,
        category_id: Option<Uuid>,
        category_zh: Option<String>,
        category_en: Option<String>,
        title_zh: String,
        title_en: Option<String>,
        body_zh: String,
        body_en: Option<String>,
        updated_at: DateTime<Utc>,
    }
    let r: Option<Locked> = sqlx::query_as(
        "SELECT a.id, a.category_id, c.name_zh AS category_zh, c.name_en AS category_en, a.title_zh, \
           a.title_en, a.body_zh, a.body_en, a.updated_at FROM kb_articles a \
         LEFT JOIN kb_categories c ON c.id = a.category_id WHERE a.id = $1 AND a.published",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(r.map(|r| HelpArticle {
        id: r.id,
        category_id: r.category_id,
        category_zh: r.category_zh,
        category_en: r.category_en,
        title_zh: r.title_zh,
        title_en: r.title_en,
        html_zh: crate::markdown::render(&r.body_zh),
        html_en: r.body_en.as_deref().map(crate::markdown::render),
        updated_at: r.updated_at,
    }))
}

// ---------------------------------------------------------------------------
// User API (/me/help*)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct HelpQuery {
    #[serde(default)]
    pub q: Option<String>,
}

/// GET /me/help?q=
pub async fn my_help(
    State(state): State<AppState>,
    _u: ShopUser,
    Query(q): Query<HelpQuery>,
) -> Result<Json<HelpList>, ApiError> {
    let q = clean_query(q.q.as_deref())?;
    let mut c = state.pg().acquire().await?;
    Ok(Json(help_list(&mut c, q.as_deref()).await?))
}

/// GET /me/help/{id}: a published article; anything else is the
/// canonical rejection.
pub async fn my_help_article(
    State(state): State<AppState>,
    _u: ShopUser,
    Path((_, raw)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let Some(id) = Uuid::parse_str(&raw).ok() else {
        return Ok(crate::reject::not_found());
    };
    let mut c = state.pg().acquire().await?;
    Ok(match help_article(&mut c, id).await? {
        Some(a) => Json(a).into_response(),
        None => crate::reject::not_found(),
    })
}

// ---------------------------------------------------------------------------
// Admin API (/kb/*)
// ---------------------------------------------------------------------------

/// GET /kb/categories (admin).
pub async fn list_categories(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<CategoryRow>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, CategoryRow>(
        "SELECT c.id, c.name_zh, c.name_en, c.sort, \
           (SELECT count(*) FROM kb_articles a WHERE a.category_id = c.id) AS articles, c.created_at \
         FROM kb_categories c ORDER BY c.sort, c.created_at, c.id",
    )
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// POST /kb/categories (admin) → 201 {id}.
pub async fn create_category(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CategoryReq>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let id = apply_create_category(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

/// PUT /kb/categories/{id} (admin).
pub async fn update_category(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<CategoryReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    if !apply_update_category(&mut tx, &Actor::of(&user), id, &req).await? {
        return Err(ApiError::not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /kb/categories/{id} (admin).
pub async fn delete_category(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    if !apply_delete_category(&mut tx, &Actor::of(&user), id).await? {
        return Err(ApiError::not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /kb/articles (admin): every article.
pub async fn list_articles(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<ArticleRow>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, ArticleRow>(sqlx::AssertSqlSafe(format!(
        "{ARTICLE_SELECT} ORDER BY c.sort NULLS LAST, a.sort, a.created_at, a.id LIMIT 2000"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// GET /kb/articles/{id} (admin).
pub async fn get_article(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<ArticleRow>, ApiError> {
    user.require_admin()?;
    let row = sqlx::query_as::<_, ArticleRow>(sqlx::AssertSqlSafe(format!(
        "{ARTICLE_SELECT} WHERE a.id = $1"
    )))
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    Ok(Json(row))
}

/// POST /kb/articles (admin) → 201 {id}.
pub async fn create_article(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<ArticleReq>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let id = apply_create_article(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

/// PUT /kb/articles/{id} (admin).
pub async fn update_article(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<ArticleReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    if !apply_update_article(&mut tx, &Actor::of(&user), id, &req).await? {
        return Err(ApiError::not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /kb/articles/{id} (admin).
pub async fn delete_article(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    if !apply_delete_article(&mut tx, &Actor::of(&user), id).await? {
        return Err(ApiError::not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::get;
    axum::Router::new()
        .route("/{prefix}/api/v1/me/help", get(my_help))
        .route("/{prefix}/api/v1/me/help/{id}", get(my_help_article))
        .route(
            "/{prefix}/api/v1/kb/categories",
            get(list_categories).post(create_category),
        )
        .route(
            "/{prefix}/api/v1/kb/categories/{id}",
            axum::routing::put(update_category).delete(delete_category),
        )
        .route(
            "/{prefix}/api/v1/kb/articles",
            get(list_articles).post(create_article),
        )
        .route(
            "/{prefix}/api/v1/kb/articles/{id}",
            get(get_article).put(update_article).delete(delete_article),
        )
}

#[cfg(test)]
mod tests;
