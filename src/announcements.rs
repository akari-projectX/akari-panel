//! Ops: announcements (公告, xboard parity).
//!
//! - **Admins** (`/announcements*`) create, edit, delete announcements:
//!   Chinese title and body (a safe Markdown subset, `markdown.rs`),
//!   optional English variants, pinned, enabled, a visibility window and
//!   an audience (`all` / `with_plan` = an active plan / `without_plan`).
//!   Every mutation is an `apply_*` in the caller's transaction with its
//!   audit row (`announcement.create/update/delete/mail`).
//! - **Users** (`/me/announcements*`, `auth::ShopUser`: the renewal scope
//!   sees the dashboard too) get the announcements visible to them right
//!   now (database clock, audience by their active plan), rendered to HTML
//!   server-side, with their read state; `POST …/{id}/read` marks one
//!   read. An announcement the caller may not see — disabled, outside its
//!   window, another audience, unknown, malformed id — is the canonical
//!   rejection (`reject::not_found()`), so ids are not an oracle.
//! - **Mail to the audience**: an admin requests it once
//!   (`POST /announcements/{id}/mail`, needs SMTP); `mail_pass` (the W15
//!   sender loop, every instance, every `MAIL_EVERY`) walks the audience
//!   in batches of `MAIL_BATCH` through the outbox — the announcement row
//!   is claimed with `FOR UPDATE SKIP LOCKED`, `mail_cursor` is the last
//!   user id enqueued, so a crash resumes without duplicates and two
//!   instances never mail the same batch. Verified addresses only, each
//!   in the recipient's language, with the (possibly edited)
//!   `announcement` template.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, ShopUser, bad_request, conflict};
use crate::state::AppState;

pub const AUDIENCES: [&str; 3] = ["all", "with_plan", "without_plan"];
pub const MAX_TITLE: usize = 120;
pub const MAX_BODY: usize = crate::markdown::MAX_BODY;
/// Announcements a user sees at most (newest, pinned first).
const USER_LIMIT: i64 = 50;
/// Recipients handed to the outbox per pass and how often a pass runs.
pub const MAIL_BATCH: i64 = 100;
pub const MAIL_EVERY: std::time::Duration = std::time::Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/// Create / replace body (PUT replaces every field).
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct AnnouncementReq {
    pub title_zh: String,
    #[serde(default)]
    pub title_en: Option<String>,
    pub body_zh: String,
    #[serde(default)]
    pub body_en: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub visible_from: Option<DateTime<Utc>>,
    #[serde(default)]
    pub visible_until: Option<DateTime<Utc>>,
    #[serde(default = "all")]
    pub audience: String,
}

fn yes() -> bool {
    true
}
fn all() -> String {
    "all".into()
}

/// A one-line title: trimmed, no control characters, 1..=MAX_TITLE.
pub fn clean_title(s: &str) -> Result<String, ApiError> {
    let s = s.trim();
    if s.is_empty() {
        return Err(bad_request!(
            "announcement.title_required",
            "title is required"
        ));
    }
    if s.chars().any(char::is_control) {
        return Err(bad_request!(
            "announcement.title_multiline",
            "title must be a single line"
        ));
    }
    if s.chars().count() > MAX_TITLE {
        return Err(bad_request!(
            "announcement.title_long",
            "title is longer than {max} characters",
            max = MAX_TITLE
        ));
    }
    Ok(s.to_string())
}

/// A Markdown body: CRLF/CR normalized, control characters other than LF
/// and TAB removed, trimmed, 1..=MAX_BODY characters.
pub fn clean_markdown(s: &str) -> Result<String, ApiError> {
    let s = s.replace("\r\n", "\n").replace('\r', "\n");
    let s: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let s = s.trim();
    if s.is_empty() {
        return Err(bad_request!(
            "announcement.body_required",
            "body is required"
        ));
    }
    if s.chars().count() > MAX_BODY {
        return Err(bad_request!(
            "announcement.body_long",
            "body is longer than {max} characters",
            max = MAX_BODY
        ));
    }
    Ok(s.to_string())
}

/// Optional variant: empty / whitespace = absent.
fn optional(
    s: &Option<String>,
    f: impl Fn(&str) -> Result<String, ApiError>,
) -> Result<Option<String>, ApiError> {
    match s.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(v) => f(v).map(Some),
    }
}

/// The validated form of a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clean {
    pub title_zh: String,
    pub title_en: Option<String>,
    pub body_zh: String,
    pub body_en: Option<String>,
    pub pinned: bool,
    pub enabled: bool,
    pub visible_from: Option<DateTime<Utc>>,
    pub visible_until: Option<DateTime<Utc>>,
    pub audience: String,
}

pub fn check(req: &AnnouncementReq) -> Result<Clean, ApiError> {
    if !AUDIENCES.contains(&req.audience.as_str()) {
        return Err(bad_request!(
            "announcement.audience_invalid",
            "audience must be one of: {allowed}",
            allowed = AUDIENCES.join(", ")
        ));
    }
    if let (Some(f), Some(u)) = (req.visible_from, req.visible_until)
        && f >= u
    {
        return Err(bad_request!(
            "announcement.window_invalid",
            "visible_from must be before visible_until"
        ));
    }
    Ok(Clean {
        title_zh: clean_title(&req.title_zh)?,
        title_en: optional(&req.title_en, clean_title)?,
        body_zh: clean_markdown(&req.body_zh)?,
        body_en: optional(&req.body_en, clean_markdown)?,
        pinned: req.pinned,
        enabled: req.enabled,
        visible_from: req.visible_from,
        visible_until: req.visible_until,
        audience: req.audience.clone(),
    })
}

// ---------------------------------------------------------------------------
// Mutations (caller's transaction; audited)
// ---------------------------------------------------------------------------

fn snapshot(c: &Clean) -> serde_json::Value {
    json!({
        "title_zh": c.title_zh, "title_en": c.title_en, "pinned": c.pinned, "enabled": c.enabled,
        "visible_from": c.visible_from, "visible_until": c.visible_until, "audience": c.audience,
        "body_zh_length": c.body_zh.chars().count(),
        "body_en_length": c.body_en.as_ref().map(|b| b.chars().count()),
    })
}

pub async fn apply_create(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &AnnouncementReq,
) -> Result<Uuid, ApiError> {
    let c = check(req)?;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO announcements (id, title_zh, title_en, body_zh, body_en, pinned, enabled, \
           visible_from, visible_until, audience) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(id)
    .bind(&c.title_zh)
    .bind(&c.title_en)
    .bind(&c.body_zh)
    .bind(&c.body_en)
    .bind(c.pinned)
    .bind(c.enabled)
    .bind(c.visible_from)
    .bind(c.visible_until)
    .bind(&c.audience)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "announcement.create",
        "announcement",
        Some(id.to_string()),
        None,
        Some(snapshot(&c)),
    )
    .await?;
    Ok(id)
}

/// Lock one row and return its editable fields (None = no such row).
async fn lock_row(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Option<Clean>> {
    #[derive(sqlx::FromRow)]
    struct Locked {
        title_zh: String,
        title_en: Option<String>,
        body_zh: String,
        body_en: Option<String>,
        pinned: bool,
        enabled: bool,
        visible_from: Option<DateTime<Utc>>,
        visible_until: Option<DateTime<Utc>>,
        audience: String,
    }
    let row: Option<Locked> = sqlx::query_as(
        "SELECT title_zh, title_en, body_zh, body_en, pinned, enabled, visible_from, visible_until, \
           audience FROM announcements WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|r| Clean {
        title_zh: r.title_zh,
        title_en: r.title_en,
        body_zh: r.body_zh,
        body_en: r.body_en,
        pinned: r.pinned,
        enabled: r.enabled,
        visible_from: r.visible_from,
        visible_until: r.visible_until,
        audience: r.audience,
    }))
}

/// Replace every field. Ok(false) = no such announcement.
pub async fn apply_update(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &AnnouncementReq,
) -> Result<bool, ApiError> {
    let c = check(req)?;
    let Some(before) = lock_row(conn, id).await? else {
        return Ok(false);
    };
    if before == c {
        return Ok(true);
    }
    sqlx::query(
        "UPDATE announcements SET title_zh = $2, title_en = $3, body_zh = $4, body_en = $5, \
           pinned = $6, enabled = $7, visible_from = $8, visible_until = $9, audience = $10, \
           updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(&c.title_zh)
    .bind(&c.title_en)
    .bind(&c.body_zh)
    .bind(&c.body_en)
    .bind(c.pinned)
    .bind(c.enabled)
    .bind(c.visible_from)
    .bind(c.visible_until)
    .bind(&c.audience)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "announcement.update",
        "announcement",
        Some(id.to_string()),
        Some(snapshot(&before)),
        Some(snapshot(&c)),
    )
    .await?;
    Ok(true)
}

/// Ok(false) = no such announcement.
pub async fn apply_delete(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<bool, ApiError> {
    let Some(before) = lock_row(conn, id).await? else {
        return Ok(false);
    };
    sqlx::query("DELETE FROM announcements WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "announcement.delete",
        "announcement",
        Some(id.to_string()),
        Some(snapshot(&before)),
        None,
    )
    .await?;
    Ok(true)
}

/// Request the mailing (restarts a finished one; 409 while one runs).
/// Ok(false) = no such announcement.
pub async fn apply_request_mail(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<bool, ApiError> {
    if lock_row(conn, id).await?.is_none() {
        return Ok(false);
    }
    let running: bool = sqlx::query_scalar(
        "SELECT mail_requested_at IS NOT NULL AND mail_done_at IS NULL FROM announcements WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    if running {
        return Err(conflict!(
            "announcement.mail_in_progress",
            "this announcement is being mailed right now"
        ));
    }
    sqlx::query(
        "UPDATE announcements SET mail_requested_at = now(), mail_cursor = NULL, mail_sent = 0, \
           mail_done_at = NULL WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "announcement.mail",
        "announcement",
        Some(id.to_string()),
        None,
        Some(json!({ "requested": true })),
    )
    .await?;
    Ok(true)
}

/// Mark `id` read by `user` if it is visible to them. Ok(false) = not
/// visible (the caller answers with the canonical rejection).
pub async fn apply_mark_read(conn: &mut PgConnection, user: Uuid, id: Uuid) -> sqlx::Result<bool> {
    let visible: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT EXISTS (SELECT 1 FROM announcements a WHERE a.id = $2 AND {VISIBLE})"
    )))
    .bind(user)
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    if !visible {
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO announcement_reads (announcement_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(user)
    .execute(&mut *conn)
    .await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Mailing pass (sender loop)
// ---------------------------------------------------------------------------

/// Recipients of an announcement's mailing (alias `u`, `$1` = the
/// announcement's audience): customers with a verified address, enabled
/// or only quota-disabled, matching the audience.
const RECIPIENT: &str = "u.role = 'user' AND u.email IS NOT NULL AND u.email_verified_at IS NOT NULL \
     AND (u.enabled OR u.disabled_reason = 'quota') \
     AND ($1 = 'all' OR ($1 = 'with_plan') = EXISTS (SELECT 1 FROM user_plans p \
         WHERE p.user_id = u.id AND p.status = 'active'))";

#[derive(sqlx::FromRow)]
struct Recipient {
    id: Uuid,
    email: String,
    locale: String,
}

/// One batch of one due mailing. Returns the rows enqueued (0 = nothing
/// due or another instance holds the row).
pub async fn mail_pass(state: &AppState, smtp: &crate::mail::MailSettings) -> sqlx::Result<usize> {
    mail_pass_batch(state, smtp, MAIL_BATCH).await
}

/// `mail_pass` with an explicit batch size (tests).
pub async fn mail_pass_batch(
    state: &AppState,
    smtp: &crate::mail::MailSettings,
    batch: i64,
) -> sqlx::Result<usize> {
    let mut tx = state.pg().begin().await?;
    let due: Option<(Uuid, String, String, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT id, title_zh, body_zh, audience, mail_cursor FROM announcements \
         WHERE mail_requested_at IS NOT NULL AND mail_done_at IS NULL \
         ORDER BY mail_requested_at LIMIT 1 FOR UPDATE SKIP LOCKED",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some((id, title_zh, body_zh, audience, cursor)) = due else {
        return Ok(0);
    };
    let (title_en, body_en): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT title_en, body_en FROM announcements WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let rows: Vec<Recipient> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT u.id, u.email, u.locale FROM users u WHERE {RECIPIENT} \
         AND ($2::uuid IS NULL OR u.id > $2) ORDER BY u.id LIMIT {batch}"
    )))
    .bind(&audience)
    .bind(cursor)
    .fetch_all(&mut *tx)
    .await?;
    let portal = crate::mail::portal_url(state);
    for r in &rows {
        let locale = crate::mail::Locale::parse(&r.locale);
        let en = locale == crate::mail::Locale::En;
        let tpl = crate::mail::Template::Announcement {
            title: if en {
                title_en.clone().unwrap_or_else(|| title_zh.clone())
            } else {
                title_zh.clone()
            },
            body_md: if en {
                body_en.clone().unwrap_or_else(|| body_zh.clone())
            } else {
                body_zh.clone()
            },
            portal_url: portal.clone(),
        };
        crate::mail::enqueue(&mut tx, smtp, &tpl, locale, &r.email, Some(r.id), None).await?;
    }
    let n = rows.len() as i64;
    let done = n < batch;
    sqlx::query(
        "UPDATE announcements SET mail_cursor = coalesce($2, mail_cursor), mail_sent = mail_sent + $3, \
           mail_done_at = CASE WHEN $4 THEN now() END WHERE id = $1",
    )
    .bind(id)
    .bind(rows.last().map(|r| r.id))
    .bind(n)
    .bind(done)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows.len())
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// Visible to user `$1` now (alias `a`).
const VISIBLE: &str = "a.enabled AND (a.visible_from IS NULL OR a.visible_from <= now()) \
     AND (a.visible_until IS NULL OR a.visible_until > now()) \
     AND (a.audience = 'all' OR (a.audience = 'with_plan') = EXISTS (SELECT 1 FROM user_plans p \
         WHERE p.user_id = $1 AND p.status = 'active'))";

#[derive(Serialize, sqlx::FromRow)]
pub struct Row {
    pub id: Uuid,
    pub title_zh: String,
    pub title_en: Option<String>,
    pub body_zh: String,
    pub body_en: Option<String>,
    pub pinned: bool,
    pub enabled: bool,
    pub visible_from: Option<DateTime<Utc>>,
    pub visible_until: Option<DateTime<Utc>>,
    pub audience: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Currently within its window and enabled (audience aside).
    pub active: bool,
    pub reads: i64,
    pub mail_requested_at: Option<DateTime<Utc>>,
    pub mail_sent: i32,
    pub mail_done_at: Option<DateTime<Utc>>,
}

const ADMIN_SELECT: &str = "SELECT a.id, a.title_zh, a.title_en, a.body_zh, a.body_en, a.pinned, a.enabled, \
       a.visible_from, a.visible_until, a.audience, a.created_at, a.updated_at, \
       (a.enabled AND (a.visible_from IS NULL OR a.visible_from <= now()) \
         AND (a.visible_until IS NULL OR a.visible_until > now())) AS active, \
       (SELECT count(*) FROM announcement_reads r WHERE r.announcement_id = a.id) AS reads, \
       a.mail_requested_at, a.mail_sent, a.mail_done_at FROM announcements a";

/// What a user sees: both languages (the SPA picks), rendered.
#[derive(Serialize, Debug)]
pub struct MyAnnouncement {
    pub id: Uuid,
    pub title_zh: String,
    pub title_en: Option<String>,
    pub html_zh: String,
    pub html_en: Option<String>,
    pub pinned: bool,
    pub created_at: DateTime<Utc>,
    pub read: bool,
}

#[derive(Serialize)]
pub struct MyList {
    pub announcements: Vec<MyAnnouncement>,
    pub unread: i64,
}

#[derive(sqlx::FromRow)]
struct MyRow {
    id: Uuid,
    title_zh: String,
    title_en: Option<String>,
    body_zh: String,
    body_en: Option<String>,
    pinned: bool,
    created_at: DateTime<Utc>,
    read: bool,
}

/// The announcements visible to `user` now, pinned and newest first.
pub async fn visible_to(conn: &mut PgConnection, user: Uuid) -> sqlx::Result<MyList> {
    let rows: Vec<MyRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT a.id, a.title_zh, a.title_en, a.body_zh, a.body_en, a.pinned, a.created_at, \
           (r.user_id IS NOT NULL) AS read FROM announcements a \
         LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $1 \
         WHERE {VISIBLE} ORDER BY a.pinned DESC, a.created_at DESC, a.id LIMIT {USER_LIMIT}"
    )))
    .bind(user)
    .fetch_all(conn)
    .await?;
    let unread = rows.iter().filter(|r| !r.read).count() as i64;
    Ok(MyList {
        announcements: rows
            .into_iter()
            .map(|r| MyAnnouncement {
                id: r.id,
                title_zh: r.title_zh,
                title_en: r.title_en,
                html_zh: crate::markdown::render(&r.body_zh),
                html_en: r.body_en.as_deref().map(crate::markdown::render),
                pinned: r.pinned,
                created_at: r.created_at,
                read: r.read,
            })
            .collect(),
        unread,
    })
}

// ---------------------------------------------------------------------------
// User API (/me/announcements*)
// ---------------------------------------------------------------------------

/// GET /me/announcements.
pub async fn my_announcements(
    State(state): State<AppState>,
    u: ShopUser,
) -> Result<Json<MyList>, ApiError> {
    let mut c = state.pg().acquire().await?;
    Ok(Json(visible_to(&mut c, u.user.id).await?))
}

/// POST /me/announcements/{id}/read → 204; not visible = canonical rejection.
pub async fn read_my_announcement(
    State(state): State<AppState>,
    u: ShopUser,
    Path((_, raw)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let Some(id) = Uuid::parse_str(&raw).ok() else {
        return Ok(crate::reject::not_found());
    };
    let mut tx = state.pg().begin().await?;
    let ok = apply_mark_read(&mut tx, u.user.id, id).await?;
    tx.commit().await?;
    Ok(if ok {
        StatusCode::NO_CONTENT.into_response()
    } else {
        crate::reject::not_found()
    })
}

// ---------------------------------------------------------------------------
// Admin API (/announcements*)
// ---------------------------------------------------------------------------

/// GET /announcements (admin): every announcement, pinned and newest first.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<Row>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(format!(
        "{ADMIN_SELECT} ORDER BY a.pinned DESC, a.created_at DESC, a.id LIMIT 500"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// POST /announcements (admin) → 201 {id}.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<AnnouncementReq>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let id = apply_create(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

/// GET /announcements/{id} (admin).
pub async fn get_one(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<Row>, ApiError> {
    user.require_admin()?;
    let row = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(format!(
        "{ADMIN_SELECT} WHERE a.id = $1"
    )))
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    Ok(Json(row))
}

/// PUT /announcements/{id} (admin): replace every field.
pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<AnnouncementReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    if !apply_update(&mut tx, &Actor::of(&user), id, &req).await? {
        return Err(ApiError::not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /announcements/{id} (admin).
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

/// POST /announcements/{id}/mail (admin): mail it to the audience.
pub async fn request_mail(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    if !crate::mailhook::available(&mut tx).await? {
        return Err(conflict!(
            "announcement.mail_unavailable",
            "email sending is not configured (系统设置 → 邮件)"
        ));
    }
    if !apply_request_mail(&mut tx, &Actor::of(&user), id).await? {
        return Err(ApiError::not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::ACCEPTED)
}

/// POST /content/preview {markdown} (admin): the HTML the users would see.
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct PreviewReq {
    pub markdown: String,
}

pub async fn preview(
    user: AuthUser,
    ApiJson(req): ApiJson<PreviewReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let md = clean_markdown(&req.markdown)?;
    Ok(Json(json!({ "html": crate::markdown::render(&md) })))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/{prefix}/api/v1/me/announcements", get(my_announcements))
        .route(
            "/{prefix}/api/v1/me/announcements/{id}/read",
            post(read_my_announcement),
        )
        .route("/{prefix}/api/v1/announcements", get(list).post(create))
        .route(
            "/{prefix}/api/v1/announcements/{id}",
            get(get_one).put(update).delete(delete),
        )
        .route(
            "/{prefix}/api/v1/announcements/{id}/mail",
            post(request_mail),
        )
        .route("/{prefix}/api/v1/content/preview", post(preview))
}

#[cfg(test)]
mod tests;
