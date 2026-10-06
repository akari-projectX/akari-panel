//! D10: never-used accounts — the definition, the console's bulk deletion,
//! the automatic cleanup (migration 1017).
//!
//! "Never used" (`NEVER_USED`, alias `u`): a role=user account that is not
//! erased, never had a plan, has no finance record (`erase::HAS_FINANCE`),
//! no traffic (counter and history), a zero balance and no ticket. Admins
//! and accounts with finance records never qualify.
//!
//! Bulk deletion (`POST /users/delete/preview` → count + confirm token,
//! `POST /users/delete` with the token): the selected users or all users
//! matching a filter (the list's filters, D10 ones included), role=user
//! only, each erased by `erase::apply_erase` (deleted, or kept anonymized
//! with finance records) in its own transaction. The token binds the
//! selection, the count shown and the admin: a changed count means a new
//! preview.
//!
//! The automatic cleanup (`cleanup_settings`, default off; `run_loop`,
//! hourly, one instance at a time): accounts never used, registered and not
//! signed in for `after_days` are deleted; with `warn`, they are first
//! mailed (verified address) and deleted `warn_days` later unless they
//! sign in meanwhile (a sign-in clears `cleanup_warned_at`).

use std::time::Duration;

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::batch::Selection;
use crate::erase::{Erased, Why};
use crate::state::AppState;

/// SQL (alias `u`): the account was never used.
pub const NEVER_USED: &str = "(u.role = 'user' AND u.erased_at IS NULL \
     AND NOT EXISTS (SELECT 1 FROM user_plans up WHERE up.user_id = u.id) \
     AND NOT (EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id) \
       OR EXISTS (SELECT 1 FROM balance_ledger l WHERE l.user_id = u.id) \
       OR EXISTS (SELECT 1 FROM commissions c WHERE c.inviter_id = u.id OR c.invitee_id = u.id) \
       OR EXISTS (SELECT 1 FROM withdrawals w WHERE w.user_id = u.id)) \
     AND u.traffic_used_bytes = 0 \
     AND NOT EXISTS (SELECT 1 FROM traffic_daily td WHERE td.user_id = u.id) \
     AND NOT EXISTS (SELECT 1 FROM traffic_daily_pending tp WHERE tp.user_id = u.id) \
     AND NOT EXISTS (SELECT 1 FROM traffic_monthly tm WHERE tm.user_id = u.id) \
     AND COALESCE((SELECT b.balance_cents FROM user_balances b WHERE b.user_id = u.id), 0) = 0 \
     AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.user_id = u.id))";

/// At most this many accounts per bulk deletion request (narrow the filter
/// or repeat).
pub const MAX_BULK: i64 = 2000;

/// At most this many accounts per automatic run (the next run continues).
const RUN_LIMIT: i64 = 1000;

const RUN_EVERY: Duration = Duration::from_secs(3600);

/// The warning (an admin-notice mail: the site's own frame, both
/// languages).
pub const WARN_SUBJECT: &str = "账号即将被删除 / Your account will be deleted";
pub const WARN_BODY: &str = "你的账号注册后一直没有使用，将在 {days} 天后自动删除。\
如果想保留它，登录一次即可。\n\n\
Your account has not been used since it was created and will be deleted \
in {days} days. Sign in once to keep it.";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, sqlx::FromRow, PartialEq, Eq)]
pub struct Settings {
    pub version: i64,
    pub auto: bool,
    pub after_days: i32,
    pub warn: bool,
    pub warn_days: i32,
    pub last_run_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_deleted: i32,
    pub last_warned: i32,
}

const COLS: &str =
    "version, auto, after_days, warn, warn_days, last_run_at, last_deleted, last_warned";

async fn load(conn: &mut PgConnection, lock: bool) -> sqlx::Result<Settings> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM cleanup_settings WHERE id = 1{}",
        if lock { " FOR UPDATE" } else { "" }
    )))
    .fetch_one(conn)
    .await
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct PutReq {
    pub version: i64,
    pub auto: bool,
    pub after_days: i32,
    pub warn: bool,
    pub warn_days: i32,
}

/// Write the settings (optimistic `version`; audited
/// `settings.cleanup.update`).
pub async fn apply_update(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &PutReq,
) -> Result<Settings, ApiError> {
    if !(1..=3650).contains(&req.after_days) {
        return Err(bad_request!(
            "cleanup.after_days_range",
            "after_days must be 1-3650"
        ));
    }
    if !(1..=90).contains(&req.warn_days) {
        return Err(bad_request!(
            "cleanup.warn_days_range",
            "warn_days must be 1-90"
        ));
    }
    let cur = load(conn, true).await?;
    if cur.version != req.version {
        return Err(conflict!(
            "settings.version_conflict",
            "设置已被修改（可能是其他管理员），请刷新后重试"
        ));
    }
    let new: Settings = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE cleanup_settings SET auto = $1, after_days = $2, warn = $3, warn_days = $4, \
             version = version + 1, updated_at = now() WHERE id = 1 RETURNING {COLS}"
    )))
    .bind(req.auto)
    .bind(req.after_days)
    .bind(req.warn)
    .bind(req.warn_days)
    .fetch_one(&mut *conn)
    .await?;
    let view = |s: &Settings| {
        json!({ "auto": s.auto, "after_days": s.after_days, "warn": s.warn,
                "warn_days": s.warn_days })
    };
    crate::audit::record(
        conn,
        actor,
        "settings.cleanup.update",
        "settings",
        Some("cleanup".into()),
        Some(view(&cur)),
        Some(view(&new)),
    )
    .await?;
    Ok(new)
}

/// The accounts the automatic cleanup would warn and delete now.
async fn due_counts(conn: &mut PgConnection, s: &Settings) -> sqlx::Result<(i64, i64)> {
    let warn: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM users u WHERE {}",
        warn_sql()
    )))
    .bind(s.after_days)
    .fetch_one(&mut *conn)
    .await?;
    let delete: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM users u WHERE {}",
        delete_sql()
    )))
    .bind(s.after_days)
    .bind(s.warn.then_some(s.warn_days))
    .fetch_one(conn)
    .await?;
    Ok((warn, delete))
}

/// GET /api/v1/settings/cleanup (admin): the settings + `due_warn` /
/// `due_delete` (what the next run would do, with the settings as saved).
pub async fn get_settings(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    let s = load(&mut c, false).await?;
    let (w, d) = due_counts(&mut c, &s).await?;
    Ok(Json(view(&s, w, d)))
}

fn view(s: &Settings, due_warn: i64, due_delete: i64) -> Value {
    let mut v = serde_json::to_value(s).unwrap_or_default();
    if let Value::Object(m) = &mut v {
        m.insert("due_warn".into(), json!(if s.warn { due_warn } else { 0 }));
        m.insert("due_delete".into(), json!(due_delete));
    }
    v
}

/// PUT /api/v1/settings/cleanup (admin) `{version, auto, after_days, warn,
/// warn_days}`.
pub async fn put_settings(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<PutReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let s = apply_update(&mut tx, &Actor::of(&user), &req).await?;
    let (w, d) = due_counts(&mut tx, &s).await?;
    tx.commit().await?;
    Ok(Json(view(&s, w, d)))
}

// ---------------------------------------------------------------------------
// Bulk deletion (console)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct PreviewReq {
    pub selection: Selection,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct DeleteReq {
    pub selection: Selection,
    /// From the preview: the count the admin confirmed.
    pub confirm_token: String,
}

/// The selection's role=user, not yet erased accounts (id order).
async fn selected(conn: &mut PgConnection, sel: &Selection) -> Result<Vec<Uuid>, ApiError> {
    let mut qb = sqlx::QueryBuilder::new("SELECT u.id FROM users u");
    crate::batch::push_selection(&mut qb, sel)?;
    qb.push(" AND u.role = 'user' AND u.erased_at IS NULL ORDER BY u.id LIMIT ")
        .push_bind(MAX_BULK + 1);
    Ok(qb.build_query_scalar().fetch_all(conn).await?)
}

/// The confirmation of `count` accounts of `sel` by `admin`.
fn confirm_token(state: &AppState, sel: &Selection, count: usize, admin: Uuid) -> String {
    let payload = format!(
        "akari/user-delete/v1\n{}\n{count}\n{admin}",
        serde_json::to_string(sel).unwrap_or_default()
    );
    hex::encode(&state.master_key().form_mac(payload.as_bytes())[..16])
}

/// POST /api/v1/users/delete/preview (admin) `{selection}` →
/// `{total, admins (never deleted), sample, deletable, anonymized,
/// confirm_token}` (`anonymized` = how many of them have finance records:
/// kept anonymized). More than `MAX_BULK` = 400.
pub async fn preview(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<PreviewReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    let p = crate::batch::preview_selection(&mut c, &req.selection).await?;
    let ids = selected(&mut c, &req.selection).await?;
    too_many(ids.len())?;
    let anonymized: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM users u WHERE u.id = ANY($1) AND {}",
        crate::erase::HAS_FINANCE
    )))
    .bind(&ids)
    .fetch_one(&mut *c)
    .await?;
    Ok(Json(json!({
        "total": p.total,
        "admins": p.admins,
        "sample": p.sample,
        "deletable": ids.len(),
        "anonymized": anonymized,
        "confirm_token": confirm_token(&state, &req.selection, ids.len(), user.id),
    })))
}

fn too_many(n: usize) -> Result<(), ApiError> {
    if i64::try_from(n).unwrap_or(i64::MAX) > MAX_BULK {
        return Err(bad_request!(
            "user.bulk_delete_too_many",
            "at most {max} accounts at once: narrow the selection",
            max = MAX_BULK
        ));
    }
    Ok(())
}

/// POST /api/v1/users/delete (admin) `{selection, confirm_token}`: erase
/// every role=user account of the selection (each in its own transaction;
/// audited `user.erase` each, `users.bulk_delete` once). A count that
/// changed since the preview = 409 `user.bulk_delete_changed`.
/// → `{deleted, anonymized, failed}`.
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<DeleteReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    let ids = selected(&mut c, &req.selection).await?;
    drop(c);
    too_many(ids.len())?;
    let want = confirm_token(&state, &req.selection, ids.len(), user.id);
    if !bool::from(subtle::ConstantTimeEq::ct_eq(
        want.as_bytes(),
        req.confirm_token.as_bytes(),
    )) {
        return Err(conflict!(
            "user.bulk_delete_changed",
            "the selection changed since the preview: preview again"
        ));
    }
    let actor = Actor::of(&user);
    let (mut deleted, mut anonymized, mut failed) = (0usize, 0usize, 0usize);
    for id in &ids {
        match erase_one(&state, &actor, *id, Why::Bulk).await {
            Ok(Some(Erased::Deleted)) => deleted += 1,
            Ok(Some(Erased::Anonymized)) => anonymized += 1,
            Ok(None) => {}
            Err(e) if e.status().is_server_error() => return Err(e),
            Err(_) => failed += 1,
        }
    }
    let mut c = state.pg().acquire().await?;
    crate::audit::record(
        &mut c,
        &actor,
        "users.bulk_delete",
        "user",
        None,
        None,
        Some(json!({ "deleted": deleted, "anonymized": anonymized, "failed": failed })),
    )
    .await?;
    Ok(Json(json!({
        "deleted": deleted,
        "anonymized": anonymized,
        "failed": failed,
    })))
}

async fn erase_one(
    state: &AppState,
    actor: &Actor,
    id: Uuid,
    why: Why,
) -> Result<Option<Erased>, ApiError> {
    let mut tx = state.pg().begin().await?;
    let r = crate::erase::apply_erase(&mut tx, actor, id, why).await?;
    tx.commit().await?;
    Ok(r)
}

// ---------------------------------------------------------------------------
// Automatic cleanup
// ---------------------------------------------------------------------------

/// SQL (alias `u`, $1 = after_days): never used, registered and not signed
/// in for `after_days`.
fn inactive_sql() -> String {
    format!(
        "{NEVER_USED} AND u.created_at < now() - make_interval(days => $1) \
         AND COALESCE(u.last_login_at, u.created_at) < now() - make_interval(days => $1)"
    )
}

/// SQL (alias `u`, $1 = after_days): inactive and not warned yet.
fn warn_sql() -> String {
    format!("{} AND u.cleanup_warned_at IS NULL", inactive_sql())
}

/// SQL (alias `u`, $1 = after_days, $2 = warn_days or NULL without the
/// warning): due for deletion — warned `warn_days` ago (and not signed in
/// since: a sign-in clears the mark), or inactive when nobody is warned.
fn delete_sql() -> String {
    format!(
        "{} AND ($2::int IS NULL OR (u.cleanup_warned_at IS NOT NULL \
         AND u.cleanup_warned_at <= now() - make_interval(days => $2::int)))",
        inactive_sql()
    )
}

/// What one run did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Ran {
    pub warned: i64,
    pub deleted: i64,
}

/// One run (any instance; a second one at the same time does nothing).
pub async fn run_once(state: &AppState) -> anyhow::Result<Ran> {
    let mut lock = state.pg().begin().await?;
    let got: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('akari.cleanup', 0))",
    )
    .fetch_one(&mut *lock)
    .await?;
    if !got {
        return Ok(Ran::default());
    }
    let s = load(&mut lock, false).await?;
    if !s.auto {
        return Ok(Ran::default());
    }
    let mut ran = Ran::default();
    if s.warn {
        ran.warned = warn_due(state, &s).await?;
    }
    let ids: Vec<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT u.id FROM users u WHERE {} ORDER BY u.id LIMIT {RUN_LIMIT}",
        delete_sql()
    )))
    .bind(s.after_days)
    .bind(s.warn.then_some(s.warn_days))
    .fetch_all(state.pg())
    .await?;
    for id in ids {
        match erase_one(state, &Actor::system(), id, Why::NeverUsed).await {
            Ok(Some(_)) => ran.deleted += 1,
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %e.message(), "cleanup: an account was not erased"),
        }
    }
    sqlx::query(
        "UPDATE cleanup_settings SET last_run_at = now(), last_deleted = $1, last_warned = $2 \
         WHERE id = 1",
    )
    .bind(i32::try_from(ran.deleted).unwrap_or(i32::MAX))
    .bind(i32::try_from(ran.warned).unwrap_or(i32::MAX))
    .execute(&mut *lock)
    .await?;
    lock.commit().await?;
    if ran != Ran::default() {
        tracing::info!(
            warned = ran.warned,
            deleted = ran.deleted,
            "never-used account cleanup"
        );
    }
    Ok(ran)
}

/// Warn the due accounts (mark them; mail those with a verified address
/// while mail is on). Returns how many were marked.
async fn warn_due(state: &AppState, s: &Settings) -> anyhow::Result<i64> {
    let mut tx = state.pg().begin().await?;
    let due: Vec<(Uuid, Option<String>, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE users u SET cleanup_warned_at = now() WHERE u.id IN \
           (SELECT u.id FROM users u WHERE {} ORDER BY u.id LIMIT {RUN_LIMIT} \
            FOR UPDATE SKIP LOCKED) \
         RETURNING u.id, CASE WHEN u.email_verified_at IS NOT NULL THEN u.email END, u.locale",
        warn_sql()
    )))
    .bind(s.after_days)
    .fetch_all(&mut *tx)
    .await?;
    let mail = crate::mail::load(&mut tx).await?;
    if mail.enabled && mail.complete() {
        let tpl = crate::mail::Template::AdminNotice {
            subject: WARN_SUBJECT.into(),
            body: WARN_BODY.replace("{days}", &s.warn_days.to_string()),
        };
        for (id, to, locale) in &due {
            if let Some(to) = to {
                crate::mail::enqueue(
                    &mut tx,
                    &mail,
                    &tpl,
                    crate::mail::Locale::parse(locale),
                    to,
                    Some(*id),
                    None,
                )
                .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(i64::try_from(due.len()).unwrap_or(i64::MAX))
}

/// Hourly on every instance (`run_once` lets one of them work).
pub async fn run_loop(state: AppState) {
    let mut tick = tokio::time::interval(RUN_EVERY);
    loop {
        tick.tick().await;
        if let Err(e) = run_once(&state).await {
            tracing::warn!(error = %e, "never-used account cleanup failed");
        }
    }
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route(
            "/{prefix}/api/v1/settings/cleanup",
            get(get_settings).put(put_settings),
        )
        .route("/{prefix}/api/v1/users/delete/preview", post(preview))
        .route("/{prefix}/api/v1/users/delete", post(delete))
}

#[cfg(test)]
mod tests;
