//! Subscription templates (2026-10-27): the per-client configuration an
//! operator edits (系统设置 → 订阅模板), replacing the routing page. A
//! template is the whole file a client receives, with placeholders where
//! the user's lines go:
//!
//! - sing-box (JSON) and Clash (YAML) are *structural*: the template is
//!   parsed, the user's proxies are injected and the document is written
//!   back (`singbox.rs`, `clash.rs`); no text substitution touches a
//!   credential;
//! - Surge and Surfboard (INI-like text) substitute single-line values
//!   (`ini.rs`, proxy lines in `sub::surge`).
//!
//! Names follow xboard (`$subs_link`, `$subscribe_info`, `$proxies`,
//! `$proxy_group`, `{all}`) so an operator can paste a template from there.
//! A missing `sub_templates` row = the built-in default
//! (`<format>.tmpl`). Writes: `apply_set` / `apply_reset` (version check,
//! same-transaction audit, never the body).

mod clash;
pub(crate) mod doc;
mod ini;
mod proxies;
mod singbox;
#[cfg(test)]
mod tests;

use std::collections::HashSet;

use axum::Json;
use axum::extract::{Path, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use super::proxy::{Proxy, collect_proxies};
use super::surge::Dialect;
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::state::AppState;
use doc::Doc;

/// Longest template body.
pub const MAX_BODY: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemplateFormat {
    SingBox,
    Clash,
    Surge,
    Surfboard,
}

impl TemplateFormat {
    /// Tab order of the admin page.
    pub const ALL: [TemplateFormat; 4] = [
        TemplateFormat::SingBox,
        TemplateFormat::Clash,
        TemplateFormat::Surge,
        TemplateFormat::Surfboard,
    ];

    pub fn id(self) -> &'static str {
        self.format().id()
    }

    pub fn format(self) -> super::Format {
        match self {
            TemplateFormat::SingBox => super::Format::SingBox,
            TemplateFormat::Clash => super::Format::Clash,
            TemplateFormat::Surge => super::Format::Surge,
            TemplateFormat::Surfboard => super::Format::Surfboard,
        }
    }

    pub fn of(format: super::Format) -> Option<TemplateFormat> {
        Some(match format {
            super::Format::SingBox => TemplateFormat::SingBox,
            super::Format::Clash => TemplateFormat::Clash,
            super::Format::Surge => TemplateFormat::Surge,
            super::Format::Surfboard => TemplateFormat::Surfboard,
            super::Format::Links => return None,
        })
    }

    pub fn parse(id: &str) -> Option<TemplateFormat> {
        Self::ALL.into_iter().find(|f| f.id() == id)
    }

    pub fn default_body(self) -> &'static str {
        match self {
            TemplateFormat::SingBox => include_str!("sing-box.tmpl"),
            TemplateFormat::Clash => include_str!("clash.tmpl"),
            TemplateFormat::Surge => include_str!("surge.tmpl"),
            TemplateFormat::Surfboard => include_str!("surfboard.tmpl"),
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            TemplateFormat::SingBox => "application/json; charset=utf-8",
            TemplateFormat::Clash => "text/yaml; charset=utf-8",
            TemplateFormat::Surge | TemplateFormat::Surfboard => "text/plain; charset=utf-8",
        }
    }
}

// ---------------------------------------------------------------------------
// Errors with a position
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateError {
    pub message: String,
    /// 1-based line and column (characters) in the template, where known.
    pub line: Option<usize>,
    pub column: Option<usize>,
}

impl TemplateError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            line: None,
            column: None,
        }
    }

    /// An error about `needle`, located at its first occurrence in `body`.
    pub(crate) fn at(body: &str, needle: &str, message: impl Into<String>) -> Self {
        let mut e = Self::new(message);
        if let Some(i) = body.find(needle) {
            let before = &body[..i];
            e.line = Some(before.matches('\n').count() + 1);
            e.column = Some(before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1);
        }
        e
    }

    pub fn into_api(self) -> ApiError {
        let msg = self.message;
        match (self.line, self.column) {
            (Some(line), Some(column)) => bad_request!(
                "sub_template.invalid",
                "{msg} (line {line}, column {column})",
                field = "body",
                msg = msg,
                line = line,
                column = column
            ),
            _ => bad_request!("sub_template.invalid", "{msg}", field = "body", msg = msg),
        }
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// The `[Panel]` figures (`$subscribe_info`).
#[derive(Clone, Copy, Debug)]
pub struct Info {
    pub upload: i64,
    pub download: i64,
    pub total: i64,
    pub expire: i64,
}

pub struct Ctx<'a> {
    pub subs_link: &'a str,
    pub subs_domain: &'a str,
    pub site_name: &'a str,
    pub info: Info,
    pub format_id: &'static str,
}

/// Replace the `$` placeholders in every string value of a structural
/// template (before any credential is injected).
pub(crate) fn substitute(doc: &mut Doc, ctx: &Ctx<'_>) {
    doc.each_string(&mut |s| {
        if s.contains('$') {
            *s = s
                .replace("$subs_link", ctx.subs_link)
                .replace("$subs_domain", ctx.subs_domain)
                .replace("$site_name", ctx.site_name);
        }
    });
}

/// `names`, each made unique against `taken` (and recorded in it) by
/// ` #2`, ` #3`…
pub(crate) fn unique_names<'a>(
    names: impl Iterator<Item = &'a str>,
    taken: &mut HashSet<String>,
) -> Vec<String> {
    names
        .map(|n| {
            let mut name = n.to_string();
            let mut i = 2;
            while !taken.insert(name.clone()) {
                name = format!("{n} #{i}");
                i += 1;
            }
            name
        })
        .collect()
}

/// The policy a rule line sends traffic to (`final_kw` = the catch-all
/// rule type, whose policy is the first argument). None for rules whose
/// shape is not checked (logical rules).
pub(crate) fn rule_target<'a>(rule: &'a str, final_kw: &str) -> Option<&'a str> {
    let mut fields = rule.split(',').map(str::trim);
    let kind = fields.next()?;
    if ["AND", "OR", "NOT", "SUB-RULE"]
        .iter()
        .any(|k| kind.eq_ignore_ascii_case(k))
    {
        return None;
    }
    let idx = if kind.eq_ignore_ascii_case(final_kw) {
        0
    } else {
        1
    };
    fields.nth(idx).filter(|t| !t.is_empty())
}

/// Render `body` for `proxies`. `strict` = saving and previewing (dangling
/// references are errors); a subscription is lenient.
pub(crate) fn render(
    format: TemplateFormat,
    body: &str,
    proxies: &[Proxy],
    ctx: &Ctx<'_>,
    strict: bool,
) -> Result<String, TemplateError> {
    if body.len() > MAX_BODY {
        return Err(TemplateError::new("the template is too long"));
    }
    if body.chars().any(|c| c == '\0') {
        return Err(TemplateError::new("the template holds a NUL character"));
    }
    match format {
        TemplateFormat::Clash => clash::render(body, clash::parse(body)?, proxies, ctx, strict),
        TemplateFormat::SingBox => {
            singbox::render(body, singbox::parse(body)?, proxies, ctx, strict)
        }
        TemplateFormat::Surge => ini::render(Dialect::Surge, body, proxies, ctx, strict),
        TemplateFormat::Surfboard => ini::render(Dialect::Surfboard, body, proxies, ctx, strict),
    }
}

/// The built-in sample user: one line of every kind the formats carry.
pub(crate) fn sample_rows() -> Vec<super::NodeRow> {
    let row = |entrance: &str,
               region: &str,
               server: &str,
               inbound: Value,
               protocol: &str,
               account: Value| {
        super::NodeRow {
            entrance_id: Uuid::new_v4(),
            region: Some(region.into()),
            name: entrance.into(),
            display_name: None,
            tags: vec![],
            entrance: entrance.into(),
            name_rate_permille: None,
            inbound,
            server: Some(server.into()),
            port: None,
            protocol: protocol.into(),
            account,
        }
    };
    vec![
        row(
            "香港 01",
            "香港",
            "hk.example.com",
            json!({"port": 443, "streamSettings": {"network": "tcp", "security": "reality",
                "realitySettings": {"serverNames": ["www.apple.com"], "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "shortId": "ab12"}}}),
            "vless",
            json!({"id": "11111111-1111-4111-8111-111111111111", "flow": "xtls-rprx-vision"}),
        ),
        row(
            "日本 01",
            "日本",
            "jp.example.com",
            json!({"port": 8443, "streamSettings": {"network": "ws", "security": "tls",
                "tlsSettings": {"serverName": "jp.example.com"}, "wsSettings": {"path": "/ws"}}}),
            "vmess",
            json!({"id": "22222222-2222-4222-8222-222222222222"}),
        ),
        row(
            "美国 01",
            "美国",
            "us.example.com",
            json!({"port": 9443, "streamSettings": {"network": "tcp", "security": "tls",
                "tlsSettings": {"serverName": "us.example.com"}}}),
            "trojan",
            json!({"password": "sample-password"}),
        ),
        row(
            "新加坡 01",
            "新加坡",
            "sg.example.com",
            json!({"protocol": "shadowsocks", "port": 8388, "settings": {"method": "2022-blake3-aes-128-gcm",
                "password": "AAAAAAAAAAAAAAAAAAAAAA==", "clients": [], "network": "tcp,udp"}}),
            "shadowsocks",
            json!({"password": "AQEBAQEBAQEBAQEBAQEBAQ=="}),
        ),
        row(
            "台湾 01",
            "台湾",
            "tw.example.com",
            json!({"port": 443, "protocol": "hysteria", "settings": {"version": 2, "clients": []},
                "streamSettings": {"network": "hysteria", "security": "tls",
                    "tlsSettings": {"serverName": "tw.example.com"}, "hysteriaSettings": {"version": 2}}}),
            "hysteria",
            json!({"auth": "sample-auth-0123456789abcdef"}),
        ),
    ]
}

const SAMPLE_LINK: &str = "https://sub.example.com/sample/SAMPLE-TOKEN";

fn sample_render(
    format: TemplateFormat,
    body: &str,
    proxies: &[Proxy],
    strict: bool,
) -> Result<String, TemplateError> {
    let link = format!("{SAMPLE_LINK}?format={}", format.id());
    render(
        format,
        body,
        proxies,
        &Ctx {
            subs_link: &link,
            subs_domain: "sub.example.com",
            site_name: "Akari",
            info: Info {
                upload: 0,
                download: 1_073_741_824,
                total: 107_374_182_400,
                expire: 1_893_456_000,
            },
            format_id: format.id(),
        },
        strict,
    )
}

/// Render for the built-in sample user (saving, previews).
pub fn render_sample(format: TemplateFormat, body: &str) -> Result<String, TemplateError> {
    sample_render(format, body, &collect_proxies(&sample_rows()), true)
}

/// Render `rows`' proxies with placeholder link data and no strictness
/// (`sub::render`, used by benchmarks and the fuzzer).
pub(crate) fn render_sample_for(
    format: TemplateFormat,
    body: &str,
    proxies: &[Proxy],
) -> Result<String, TemplateError> {
    sample_render(format, body, proxies, false)
}

/// The template the site uses for `format`: its row, else the built-in.
pub async fn body_of(pg: &sqlx::PgPool, format: TemplateFormat) -> sqlx::Result<String> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT body FROM sub_templates WHERE format = $1")
            .bind(format.id())
            .fetch_optional(pg)
            .await?;
    Ok(stored.unwrap_or_else(|| format.default_body().to_string()))
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Stored {
    pub body: String,
    pub version: i64,
    pub updated_at: DateTime<Utc>,
    pub updated_by: Option<String>,
}

pub async fn load(conn: &mut PgConnection, format: TemplateFormat) -> sqlx::Result<Option<Stored>> {
    sqlx::query_as(
        "SELECT body, version, updated_at, updated_by FROM sub_templates WHERE format = $1",
    )
    .bind(format.id())
    .fetch_optional(conn)
    .await
}

fn sha(body: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(body.as_bytes()))
}

fn audit_value(version: i64, body: &str) -> Value {
    json!({ "version": version, "body_length": body.len(), "body_sha256": sha(body) })
}

fn normalize(body: &str) -> String {
    body.replace("\r\n", "\n").replace('\r', "\n")
}

/// Store a template. `expected_version`: 0 when none is stored yet, else
/// the stored row's version (409 on mismatch). Validates (renders for the
/// sample user). Returns the new version.
pub async fn apply_set(
    conn: &mut PgConnection,
    actor: &Actor,
    format: TemplateFormat,
    expected_version: i64,
    body: &str,
) -> Result<i64, ApiError> {
    let body = normalize(body);
    render_sample(format, &body).map_err(TemplateError::into_api)?;
    let cur: Option<Stored> = sqlx::query_as(
        "SELECT body, version, updated_at, updated_by FROM sub_templates WHERE format = $1 FOR UPDATE",
    )
    .bind(format.id())
    .fetch_optional(&mut *conn)
    .await?;
    let have = cur.as_ref().map_or(0, |c| c.version);
    if have != expected_version {
        return Err(conflict!(
            "sub_template.version_conflict",
            "模板已被修改（可能是其他管理员），请刷新后重试"
        ));
    }
    let version: i64 = sqlx::query_scalar(
        "INSERT INTO sub_templates (format, body, version, updated_by) VALUES ($1, $2, 1, $3) \
         ON CONFLICT (format) DO UPDATE SET body = EXCLUDED.body, \
           version = sub_templates.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by \
         RETURNING version",
    )
    .bind(format.id())
    .bind(&body)
    .bind(&actor.label)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.sub_template.update",
        "sub_template",
        Some(format.id().to_string()),
        cur.map(|c| audit_value(c.version, &c.body)),
        Some(audit_value(version, &body)),
    )
    .await?;
    Ok(version)
}

/// Back to the built-in default. Whether a row existed; nothing is audited
/// otherwise.
pub async fn apply_reset(
    conn: &mut PgConnection,
    actor: &Actor,
    format: TemplateFormat,
) -> Result<bool, ApiError> {
    let old: Option<Stored> = sqlx::query_as(
        "DELETE FROM sub_templates WHERE format = $1 RETURNING body, version, updated_at, updated_by",
    )
    .bind(format.id())
    .fetch_optional(&mut *conn)
    .await?;
    let Some(old) = old else {
        return Ok(false);
    };
    crate::audit::record(
        conn,
        actor,
        "settings.sub_template.reset",
        "sub_template",
        Some(format.id().to_string()),
        Some(audit_value(old.version, &old.body)),
        None,
    )
    .await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// API (admin)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Placeholder {
    token: &'static str,
    zh: &'static str,
    en: &'static str,
}

const fn ph(token: &'static str, zh: &'static str, en: &'static str) -> Placeholder {
    Placeholder { token, zh, en }
}

fn placeholders(f: TemplateFormat) -> Vec<Placeholder> {
    let mut v = vec![
        ph(
            "$subs_link",
            "订阅链接（含 token）",
            "The subscription link (with the token)",
        ),
        ph("$subs_domain", "订阅域名", "The subscription domain"),
        ph("$site_name", "站点名称", "The site name"),
    ];
    match f {
        TemplateFormat::Clash => v.push(ph(
            "$proxies",
            "代理组 proxies 列表里：展开为用户的全部线路名称",
            "In a group's proxies list: expands to all of the user's line names",
        )),
        TemplateFormat::SingBox => {
            v.push(ph(
                "{all}",
                "selector / urltest 的 outbounds 里：展开为全部线路标签",
                "In a selector/urltest outbounds list: all line tags",
            ));
            v.push(ph(
                "{all:<regex>}",
                "只展开标签匹配正则的线路",
                "Only the lines whose tag matches the regular expression",
            ));
        }
        TemplateFormat::Surge | TemplateFormat::Surfboard => {
            v.push(ph(
                "$proxies",
                "单独一行：每条线路一行代理",
                "Alone on a line: one proxy line per line",
            ));
            v.push(ph(
                "$proxy_group",
                "线路名称，逗号分隔（无线路时为 DIRECT）",
                "Line names, comma-separated (DIRECT when none)",
            ));
            v.push(ph(
                "$subscribe_info",
                "upload=…, download=…, total=…, expire=…",
                "upload=…, download=…, total=…, expire=…",
            ));
        }
    }
    v
}

#[derive(Serialize)]
struct View {
    format: &'static str,
    body: String,
    default_body: &'static str,
    is_default: bool,
    version: i64,
    updated_at: Option<DateTime<Utc>>,
    updated_by: Option<String>,
    placeholders: Vec<Placeholder>,
}

fn view(f: TemplateFormat, s: Option<Stored>) -> View {
    View {
        format: f.id(),
        default_body: f.default_body(),
        is_default: s.is_none(),
        version: s.as_ref().map_or(0, |s| s.version),
        updated_at: s.as_ref().map(|s| s.updated_at),
        updated_by: s.as_ref().and_then(|s| s.updated_by.clone()),
        body: s.map_or_else(|| f.default_body().to_string(), |s| s.body),
        placeholders: placeholders(f),
    }
}

fn format_of(id: &str) -> Result<TemplateFormat, ApiError> {
    TemplateFormat::parse(id).ok_or_else(|| {
        bad_request!(
            "sub_template.format_unknown",
            "unknown template format {format} (sing-box, clash, surge, surfboard)",
            format = id
        )
    })
}

/// GET /api/v1/sub-templates (admin): the four templates.
pub async fn list(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    let mut out = Vec::new();
    for f in TemplateFormat::ALL {
        out.push(view(f, load(&mut c, f).await?));
    }
    Ok(Json(json!({ "templates": out })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutReq {
    /// 0 = no template stored yet.
    pub version: i64,
    pub body: String,
}

/// PUT /api/v1/sub-templates/{format} (admin).
pub async fn put(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, format)): Path<(String, String)>,
    ApiJson(req): ApiJson<PutReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let f = format_of(&format)?;
    let mut tx = state.pg().begin().await?;
    apply_set(&mut tx, &Actor::of(&user), f, req.version, &req.body).await?;
    let v = view(f, load(&mut tx, f).await?);
    tx.commit().await?;
    Ok(Json(json!(v)))
}

/// DELETE /api/v1/sub-templates/{format} (admin): back to the default.
pub async fn reset(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, format)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let f = format_of(&format)?;
    let mut tx = state.pg().begin().await?;
    apply_reset(&mut tx, &Actor::of(&user), f).await?;
    tx.commit().await?;
    Ok(Json(json!(view(f, None))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewReq {
    /// The draft; absent = the stored (or default) template.
    #[serde(default)]
    pub body: Option<String>,
    /// A real user's lines instead of the sample ones.
    #[serde(default)]
    pub user_id: Option<Uuid>,
}

/// POST /api/v1/sub-templates/{format}/preview (admin): the rendered
/// output. The subscription link in it is a placeholder, never the user's.
/// With `user_id` the user's real lines (and credentials) are rendered, so
/// that read is audited like reading the link.
pub async fn preview(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, format)): Path<(String, String)>,
    ApiJson(req): ApiJson<PreviewReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let f = format_of(&format)?;
    let body = match req.body {
        Some(b) => normalize(&b),
        None => body_of(state.pg(), f).await?,
    };
    let out = match req.user_id {
        None => render_sample(f, &body),
        Some(id) => {
            let rows =
                super::load_rows(state.pg(), id, state.settings().get().sub_name_rate).await?;
            let exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
                .bind(id)
                .fetch_optional(state.pg())
                .await?;
            if exists.is_none() {
                return Err(ApiError::not_found());
            }
            let mut tx = state.pg().begin().await?;
            crate::audit::record(
                &mut tx,
                &Actor::of(&user),
                "sub_template.preview",
                "user",
                Some(id.to_string()),
                None,
                Some(json!({ "format": f.id() })),
            )
            .await?;
            tx.commit().await?;
            let link = format!("{SAMPLE_LINK}?format={}", f.id());
            render(
                f,
                &body,
                &collect_proxies(&rows),
                &Ctx {
                    subs_link: &link,
                    subs_domain: "sub.example.com",
                    site_name: state
                        .settings()
                        .get()
                        .stored
                        .site_name
                        .as_deref()
                        .unwrap_or(crate::settings::DEFAULT_SITE_NAME),
                    info: Info {
                        upload: 0,
                        download: 0,
                        total: 0,
                        expire: 0,
                    },
                    format_id: f.id(),
                },
                true,
            )
        }
    };
    let rendered = out.map_err(TemplateError::into_api)?;
    Ok(Json(
        json!({ "content_type": f.content_type(), "body": rendered }),
    ))
}
