//! Ops: editable email templates (系统设置 → 邮件模板).
//!
//! An admin may replace the subject and body of any mail kind in either
//! language. Overrides live in `mail_templates` (migration 0158; absent
//! row = the built-in default from `templates::defaults`) and are looked
//! up by `render_for` inside the transaction that enqueues the mail, so a
//! committed edit is what the next mail uses on every instance — no cache,
//! no restart. Writes validate against the kind's placeholder whitelist
//! (`templates::validate`: unknown placeholders refused, required ones
//! must stay), use `version` for optimistic concurrency and are audited
//! (`settings.mail_template.update` / `.reset`; the text itself is in the
//! row, the audit carries lengths only). The preview and the test mail
//! render the kind's sample values (`Template::sample`).

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;

use super::templates::{self, COMMON, KINDS, Locale, Placeholder, Rendered, Template};
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::state::AppState;

/// A stored override.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct Override {
    pub subject: String,
    pub body: String,
    pub version: i64,
}

/// The stored override of (kind, locale), if any.
pub async fn load(
    conn: &mut PgConnection,
    kind: &str,
    locale: Locale,
) -> sqlx::Result<Option<Override>> {
    sqlx::query_as(
        "SELECT subject, body, version FROM mail_templates WHERE kind = $1 AND locale = $2",
    )
    .bind(kind)
    .bind(locale.as_str())
    .fetch_optional(conn)
    .await
}

/// Render `tpl` with the admin's override when there is one, else the
/// built-in template.
pub async fn render_for(
    conn: &mut PgConnection,
    tpl: &Template,
    locale: Locale,
    site: &str,
) -> sqlx::Result<Rendered> {
    let kind = tpl.outbox_kind();
    Ok(match load(conn, kind, locale).await? {
        Some(o) => templates::render_custom(&o.subject, &o.body, &tpl.values(locale), locale, site),
        None => templates::render(tpl, locale, site),
    })
}

fn parse_locale(s: &str) -> Result<Locale, ApiError> {
    match s {
        "zh" => Ok(Locale::Zh),
        "en" => Ok(Locale::En),
        _ => Err(bad_request!(
            "mail_template.locale_invalid",
            "locale must be zh or en"
        )),
    }
}

fn known_kind(kind: &str) -> Result<&'static str, ApiError> {
    KINDS.iter().copied().find(|k| *k == kind).ok_or_else(|| {
        bad_request!(
            "mail_template.kind_unknown",
            "unknown template kind: {kind}",
            kind = kind
        )
    })
}

// ---------------------------------------------------------------------------
// Mutations (caller's transaction; audited)
// ---------------------------------------------------------------------------

/// Store an override. `expected_version`: 0 when none is stored yet, else
/// the stored row's version (409 on mismatch). Returns the new version.
pub async fn apply_set(
    conn: &mut PgConnection,
    actor: &Actor,
    kind: &str,
    locale: Locale,
    expected_version: i64,
    subject: &str,
    body: &str,
) -> Result<i64, ApiError> {
    let kind = known_kind(kind)?;
    templates::validate(kind, subject, body)?;
    let subject = subject.trim();
    let body = body.replace("\r\n", "\n").replace('\r', "\n");
    let cur: Option<Override> = sqlx::query_as(
        "SELECT subject, body, version FROM mail_templates WHERE kind = $1 AND locale = $2 FOR UPDATE",
    )
    .bind(kind)
    .bind(locale.as_str())
    .fetch_optional(&mut *conn)
    .await?;
    let have = cur.as_ref().map_or(0, |c| c.version);
    if have != expected_version {
        return Err(conflict!(
            "mail_template.version_conflict",
            "模板已被修改（可能是其他管理员），请刷新后重试"
        ));
    }
    let version: i64 = sqlx::query_scalar(
        "INSERT INTO mail_templates (kind, locale, subject, body, version, updated_by) \
         VALUES ($1, $2, $3, $4, 1, $5) \
         ON CONFLICT (kind, locale) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, \
           version = mail_templates.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by \
         RETURNING version",
    )
    .bind(kind)
    .bind(locale.as_str())
    .bind(subject)
    .bind(&body)
    .bind(&actor.login)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.mail_template.update",
        "mail_template",
        Some(format!("{kind}/{}", locale.as_str())),
        cur.map(|c| json!({ "version": c.version, "subject": c.subject, "body_length": c.body.chars().count() })),
        Some(json!({ "version": version, "subject": subject, "body_length": body.chars().count() })),
    )
    .await?;
    Ok(version)
}

/// Remove an override (back to the built-in default). Returns whether a
/// row existed; nothing is audited otherwise.
pub async fn apply_reset(
    conn: &mut PgConnection,
    actor: &Actor,
    kind: &str,
    locale: Locale,
) -> Result<bool, ApiError> {
    let kind = known_kind(kind)?;
    let gone: Option<Override> = sqlx::query_as(
        "DELETE FROM mail_templates WHERE kind = $1 AND locale = $2 RETURNING subject, body, version",
    )
    .bind(kind)
    .bind(locale.as_str())
    .fetch_optional(&mut *conn)
    .await?;
    let Some(old) = gone else {
        return Ok(false);
    };
    crate::audit::record(
        conn,
        actor,
        "settings.mail_template.reset",
        "mail_template",
        Some(format!("{kind}/{}", locale.as_str())),
        Some(json!({ "version": old.version, "subject": old.subject, "body_length": old.body.chars().count() })),
        None,
    )
    .await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// API (admin)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct TemplateView {
    pub kind: &'static str,
    pub label: &'static str,
    pub locale: &'static str,
    /// The effective subject / body (the override, else the default).
    pub subject: String,
    pub body: String,
    pub default_subject: &'static str,
    pub default_body: &'static str,
    /// An override is stored (`version` > 0).
    pub custom: bool,
    pub version: i64,
    pub placeholders: Vec<Placeholder>,
    pub required: &'static [&'static str],
}

async fn view_all(conn: &mut PgConnection) -> Result<Vec<TemplateView>, ApiError> {
    let rows: Vec<(String, String, String, String, i64)> =
        sqlx::query_as("SELECT kind, locale, subject, body, version FROM mail_templates")
            .fetch_all(&mut *conn)
            .await?;
    let mut out = Vec::with_capacity(KINDS.len() * 2);
    for kind in KINDS {
        let (allowed, required) = templates::spec(kind).unwrap_or((&[], &[]));
        for locale in [Locale::Zh, Locale::En] {
            let (ds, db) = templates::defaults(kind, locale).unwrap_or(("", ""));
            let stored = rows.iter().find(|r| r.0 == kind && r.1 == locale.as_str());
            out.push(TemplateView {
                kind,
                label: templates::kind_label(kind),
                locale: locale.as_str(),
                subject: stored.map_or_else(|| ds.to_string(), |r| r.2.clone()),
                body: stored.map_or_else(|| db.to_string(), |r| r.3.clone()),
                default_subject: ds,
                default_body: db,
                custom: stored.is_some(),
                version: stored.map_or(0, |r| r.4),
                placeholders: COMMON.iter().chain(allowed.iter()).copied().collect(),
                required,
            });
        }
    }
    Ok(out)
}

/// GET /api/v1/settings/mail-templates (admin): every kind × locale.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<TemplateView>>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    Ok(Json(view_all(&mut c).await?))
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct PutReq {
    /// 0 = no override stored yet.
    pub version: i64,
    pub subject: String,
    pub body: String,
}

/// PUT /api/v1/settings/mail-templates/{kind}/{locale} (admin).
pub async fn put(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, kind, locale)): Path<(String, String, String)>,
    ApiJson(req): ApiJson<PutReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let loc = parse_locale(&locale)?;
    let mut tx = state.pg().begin().await?;
    let version = apply_set(
        &mut tx,
        &Actor::of(&user),
        &kind,
        loc,
        req.version,
        &req.subject,
        &req.body,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "version": version, "custom": true })))
}

/// DELETE /api/v1/settings/mail-templates/{kind}/{locale} (admin): 恢复默认.
pub async fn reset(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, kind, locale)): Path<(String, String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let loc = parse_locale(&locale)?;
    let mut tx = state.pg().begin().await?;
    let existed = apply_reset(&mut tx, &Actor::of(&user), &kind, loc).await?;
    tx.commit().await?;
    Ok(Json(json!({ "reset": existed })))
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct PreviewReq {
    pub kind: String,
    pub locale: String,
    pub subject: String,
    pub body: String,
}

/// POST /api/v1/settings/mail-templates/preview (admin): render the
/// submitted text with the kind's sample values (validated first, so the
/// editor's errors show live).
pub async fn preview(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<PreviewReq>,
) -> Result<Json<Rendered>, ApiError> {
    user.require_admin()?;
    let kind = known_kind(&req.kind)?;
    let loc = parse_locale(&req.locale)?;
    templates::validate(kind, &req.subject, &req.body)?;
    let sample = Template::sample(kind).ok_or_else(ApiError::internal)?;
    let site = {
        let mut c = state.pg().acquire().await?;
        super::load(&mut c).await?.site().to_string()
    };
    Ok(Json(templates::render_custom(
        &req.subject,
        &req.body,
        &sample.values(loc),
        loc,
        &site,
    )))
}

/// POST /api/v1/settings/mail-templates/{kind}/{locale}/test (admin):
/// send the STORED version (or the default) with sample values to `to`,
/// right now, over the saved SMTP settings; reports the server's answer.
pub async fn send_test(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, kind, locale)): Path<(String, String, String)>,
    ApiJson(req): ApiJson<super::TestReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let kind = known_kind(&kind)?;
    let loc = parse_locale(&locale)?;
    let sample = Template::sample(kind).ok_or_else(ApiError::internal)?;
    let (smtp, rendered) = {
        let mut c = state.pg().acquire().await?;
        let smtp = super::load(&mut c).await?;
        let r = render_for(&mut c, &sample, loc, smtp.site()).await?;
        (smtp, r)
    };
    super::send_now(&state, &user, &smtp, &req.to, rendered, Some(kind)).await
}

impl Serialize for Rendered {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("Rendered", 3)?;
        st.serialize_field("subject", &self.subject)?;
        st.serialize_field("text", &self.text)?;
        st.serialize_field("html", &self.html)?;
        st.end()
    }
}

#[cfg(test)]
mod tests;
