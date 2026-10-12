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
//! row, the audit carries lengths only). The preview and the test mails
//! (the stored template, or the editor's unsaved draft: `send_test_draft`)
//! render the kind's sample values (`Template::sample`).
//!
//! An override may also carry an HTML source (`html_source`, migration
//! 1106) that replaces the whole HTML part, the panel's shell included
//! (`templates::validate_html` / `render_source`); the text body stays as
//! the plain-text alternative.

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
    pub html_source: Option<String>,
    pub version: i64,
}

/// The stored override of (kind, locale), if any.
pub async fn load(
    conn: &mut PgConnection,
    kind: &str,
    locale: Locale,
) -> sqlx::Result<Option<Override>> {
    sqlx::query_as(
        "SELECT subject, body, html_source, version FROM mail_templates WHERE kind = $1 AND locale = $2",
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
        Some(o) => templates::render_custom_html(
            &o.subject,
            &o.body,
            o.html_source.as_deref(),
            &tpl.values(locale),
            locale,
            site,
        ),
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

/// What an admin submits for one (kind, locale).
#[derive(Debug, Clone, Copy)]
pub struct Fields<'a> {
    pub subject: &'a str,
    pub body: &'a str,
    /// The HTML source; None = the panel's own HTML shell.
    pub html_source: Option<&'a str>,
}

/// Store an override. `expected_version`: 0 when none is stored yet, else
/// the stored row's version (409 on mismatch). Returns the new version.
pub async fn apply_set(
    conn: &mut PgConnection,
    actor: &Actor,
    kind: &str,
    locale: Locale,
    expected_version: i64,
    fields: Fields<'_>,
) -> Result<i64, ApiError> {
    let Fields {
        subject,
        body,
        html_source,
    } = fields;
    let kind = known_kind(kind)?;
    templates::validate(kind, subject, body)?;
    if let Some(h) = html_source {
        templates::validate_html(kind, h)?;
    }
    let html_source = html_source.map(|h| h.replace("\r\n", "\n").replace('\r', "\n"));
    let subject = subject.trim();
    let body = body.replace("\r\n", "\n").replace('\r', "\n");
    let cur: Option<Override> = sqlx::query_as(
        "SELECT subject, body, html_source, version FROM mail_templates WHERE kind = $1 AND locale = $2 FOR UPDATE",
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
        "INSERT INTO mail_templates (kind, locale, subject, body, html_source, version, updated_by) \
         VALUES ($1, $2, $3, $4, $5, 1, $6) \
         ON CONFLICT (kind, locale) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, \
           html_source = EXCLUDED.html_source, \
           version = mail_templates.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by \
         RETURNING version",
    )
    .bind(kind)
    .bind(locale.as_str())
    .bind(subject)
    .bind(&body)
    .bind(&html_source)
    .bind(&actor.label)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.mail_template.update",
        "mail_template",
        Some(format!("{kind}/{}", locale.as_str())),
        cur.map(|c| json!({ "version": c.version, "subject": c.subject, "body_length": c.body.chars().count(), "html_length": c.html_source.as_ref().map(|h| h.chars().count()) })),
        Some(json!({ "version": version, "subject": subject, "body_length": body.chars().count(), "html_length": html_source.as_ref().map(|h| h.chars().count()) })),
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
        "DELETE FROM mail_templates WHERE kind = $1 AND locale = $2 RETURNING subject, body, html_source, version",
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
        Some(json!({ "version": old.version, "subject": old.subject, "body_length": old.body.chars().count(), "html_length": old.html_source.as_ref().map(|h| h.chars().count()) })),
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
    /// The HTML source of the override, when it has one (else the panel
    /// builds the HTML from `body`).
    pub html_source: Option<String>,
    /// What the editor's "edit the source" starts from: the HTML built from
    /// the effective subject and body, placeholders left in.
    pub starter_html: String,
    pub default_subject: &'static str,
    pub default_body: &'static str,
    /// An override is stored (`version` > 0).
    pub custom: bool,
    pub version: i64,
    pub placeholders: Vec<Placeholder>,
    pub required: &'static [&'static str],
}

async fn view_all(conn: &mut PgConnection) -> Result<Vec<TemplateView>, ApiError> {
    let rows: Vec<(String, String, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT kind, locale, subject, body, html_source, version FROM mail_templates",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(KINDS.len() * 2);
    for kind in KINDS {
        let (allowed, required) = templates::spec(kind).unwrap_or((&[], &[]));
        for locale in [Locale::Zh, Locale::En] {
            let (ds, db) = templates::defaults(kind, locale).unwrap_or(("", ""));
            let stored = rows.iter().find(|r| r.0 == kind && r.1 == locale.as_str());
            let subject = stored.map_or_else(|| ds.to_string(), |r| r.2.clone());
            let body = stored.map_or_else(|| db.to_string(), |r| r.3.clone());
            out.push(TemplateView {
                kind,
                label: templates::kind_label(kind),
                locale: locale.as_str(),
                starter_html: templates::starter_html(&subject, &body, locale),
                subject,
                body,
                html_source: stored.and_then(|r| r.4.clone()),
                default_subject: ds,
                default_body: db,
                custom: stored.is_some(),
                version: stored.map_or(0, |r| r.5),
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
    /// The HTML source; absent or null = none (the panel's own HTML shell).
    #[serde(default)]
    pub html_source: Option<String>,
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
        Fields {
            subject: &req.subject,
            body: &req.body,
            html_source: req.html_source.as_deref(),
        },
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
    #[serde(default)]
    pub html_source: Option<String>,
}

/// A draft, validated exactly like a save: its kind, the kind's sample
/// values, the locale and the saved mail settings.
async fn checked_draft(
    state: &AppState,
    req: &PreviewReq,
) -> Result<(&'static str, Template, Locale, super::MailSettings), ApiError> {
    let kind = known_kind(&req.kind)?;
    let loc = parse_locale(&req.locale)?;
    templates::validate(kind, &req.subject, &req.body)?;
    if let Some(h) = &req.html_source {
        templates::validate_html(kind, h)?;
    }
    let sample = Template::sample(kind).ok_or_else(ApiError::internal)?;
    let mut c = state.pg().acquire().await?;
    let settings = super::load(&mut c).await?;
    Ok((kind, sample, loc, settings))
}

/// The draft rendered with the kind's sample values.
fn render_draft(req: &PreviewReq, sample: &Template, loc: Locale, site: &str) -> Rendered {
    templates::render_custom_html(
        &req.subject,
        &req.body,
        req.html_source.as_deref(),
        &sample.values(loc),
        loc,
        site,
    )
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
    let (_, sample, loc, settings) = checked_draft(&state, &req).await?;
    Ok(Json(render_draft(&req, &sample, loc, settings.site())))
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct TestDraftReq {
    pub kind: String,
    pub locale: String,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub html_source: Option<String>,
    pub to: String,
}

/// POST /api/v1/settings/mail-templates/test-draft (admin): send the
/// editor's UNSAVED draft (validated like the preview) with sample values
/// to `to`, right now — the same path, answer and audit as the stored
/// template's test mail.
pub async fn send_test_draft(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<TestDraftReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let TestDraftReq {
        kind,
        locale,
        subject,
        body,
        html_source,
        to,
    } = req;
    let draft = PreviewReq {
        kind,
        locale,
        subject,
        body,
        html_source,
    };
    let (kind, sample, loc, settings) = checked_draft(&state, &draft).await?;
    let rendered = render_draft(&draft, &sample, loc, settings.site());
    super::send_now(&state, &user, &settings, &to, rendered, Some(kind)).await
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
