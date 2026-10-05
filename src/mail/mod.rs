//! Outgoing email (W15): mail settings (系统设置 → 邮件), the outbox, the
//! background sender, templates and the periodic notices. W31: the provider
//! is a plugin (`transport`: SMTP or the Resend API) and 测试发信 runs a
//! step-by-step diagnostic (`diagnose`).
//!
//! **Requests never talk to the mail provider.** Every mail is rendered at request time
//! and INSERTed into `mail_outbox` inside the caller's transaction
//! (`enqueue`): a rolled-back request sends nothing, a committed one is
//! delivered by `sender::run` on any panel instance (claim with `FOR UPDATE
//! SKIP LOCKED` + lease + claim token, so two instances never send the same
//! row while its lease holds; delivery is at-least-once only across a crash
//! between the SMTP acceptance and the settle UPDATE). Retries back off
//! exponentially; permanent failures and exhausted retries become dead
//! letters the admin can see (`GET /mail/outbox?status=dead`) and retry.
//! Bodies are cleared once a row is settled for anything that carries a
//! secret (codes, reset links), and on success for every kind; neither
//! bodies nor codes are ever logged.
//!
//! The only synchronous sends are the admin's test mails
//! (`POST /settings/mail/test`, `POST /settings/mail/diagnose`).

pub mod diagnose;
pub mod notices;
pub mod overrides;
pub mod sender;
pub mod templates;
pub mod transport;

use crate::auth::{bad_request, conflict};
use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::{ApiJson, double_option};
use crate::audit::{Actor, CHANGED};
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;
pub use templates::{Locale, Template};

/// AAD of the sealed SMTP password (`totp::Keys::seal`, bound to this fixed
/// id).
pub const SMTP_AAD: Uuid = Uuid::from_u128(0x616b_6172_692d_736d_7470_2d70_6173_7377);

/// AAD of the sealed Resend API key (W31).
pub const RESEND_AAD: Uuid = Uuid::from_u128(0x616b_6172_692d_7265_7365_6e64_2d6b_6579);

/// Sender name when none is configured.
pub const DEFAULT_SITE: &str = "Akari";

/// The `mail_settings` row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MailSettings {
    pub version: i64,
    pub enabled: bool,
    /// `transport::PROVIDERS` id: smtp | resend.
    pub provider: String,
    pub api_key_enc: Option<Vec<u8>>,
    pub host: Option<String>,
    pub port: i32,
    pub security: String,
    pub username: Option<String>,
    pub password_enc: Option<Vec<u8>>,
    pub from_addr: Option<String>,
    pub from_name: Option<String>,
    pub notify_order_paid: bool,
    pub notify_expiry_days: i32,
    pub notify_expired: bool,
    pub notify_quota: bool,
    /// W21: 系统设置 → 站点名称 (panel_settings.site_name).
    pub site_name: Option<String>,
}

const MAIL_COLS: &str = "version, enabled, provider, api_key_enc, host, port, security, username, password_enc, \
     from_addr, from_name, notify_order_paid, notify_expiry_days, notify_expired, notify_quota, \
     (SELECT site_name FROM panel_settings WHERE id = 1) AS site_name";

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

impl MailSettings {
    /// The site's name in templates (subjects, headers, footers): the
    /// site name setting, else the sender name, else "Akari".
    pub fn site(&self) -> &str {
        non_empty(&self.site_name)
            .or(non_empty(&self.from_name))
            .unwrap_or(DEFAULT_SITE)
    }
    /// The sender's display name: the sender name, else the site name.
    pub fn sender_name(&self) -> &str {
        non_empty(&self.from_name)
            .or(non_empty(&self.site_name))
            .unwrap_or(DEFAULT_SITE)
    }
    /// The provider has everything it needs (the enabled row always has).
    pub fn complete(&self) -> bool {
        transport::provider(&self.provider).is_some_and(|p| p.complete(self))
    }
}

pub async fn load(conn: &mut PgConnection) -> sqlx::Result<MailSettings> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {MAIL_COLS} FROM mail_settings WHERE id = 1"
    )))
    .fetch_one(conn)
    .await
}

/// Render `tpl` and add it to the outbox in the caller's transaction.
/// `discard_after_secs`: the mail is pointless after that long (codes,
/// reset links) — the sender drops it instead of delivering it late.
pub async fn enqueue(
    conn: &mut PgConnection,
    smtp: &MailSettings,
    tpl: &Template,
    locale: Locale,
    to: &str,
    user_id: Option<Uuid>,
    discard_after_secs: Option<i64>,
) -> sqlx::Result<i64> {
    // Ops: the admin's edited template, when one is stored (same
    // transaction: a committed edit is what the next mail uses).
    let r = overrides::render_for(conn, tpl, locale, smtp.site()).await?;
    sqlx::query_scalar(
        "INSERT INTO mail_outbox (kind, user_id, to_addr, subject, body_text, body_html, \
         discard_after) VALUES ($1, $2, $3, $4, $5, $6, \
         CASE WHEN $7::bigint IS NULL THEN NULL ELSE now() + make_interval(secs => $7::bigint::double precision) END) \
         RETURNING id",
    )
    .bind(tpl.outbox_kind())
    .bind(user_id)
    .bind(to)
    .bind(&r.subject)
    .bind(&r.text)
    .bind(&r.html)
    .bind(discard_after_secs)
    .fetch_one(conn)
    .await
}

/// `<public origin>/<prefix>/app` (the portal), if a main domain is
/// configured. Links in mail never derive from a request's Host header.
pub fn portal_url(state: &AppState) -> Option<String> {
    state
        .settings()
        .get()
        .public_origin()
        .map(|o| format!("{o}/{}/app", state.route_prefix()))
}

// ---------------------------------------------------------------------------
// 系统设置 → 邮件 (admin)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct MailView {
    version: i64,
    enabled: bool,
    /// W31: smtp | resend.
    provider: String,
    /// Every provider id, for the form.
    providers: Vec<&'static str>,
    host: Option<String>,
    port: i32,
    security: String,
    username: Option<String>,
    /// Whether a password is stored (never the password).
    password_set: bool,
    /// Whether an API key is stored (never the key).
    api_key_set: bool,
    from_addr: Option<String>,
    from_name: Option<String>,
    notify_order_paid: bool,
    notify_expiry_days: i32,
    notify_expired: bool,
    notify_quota: bool,
    /// Dead letters (for the card's badge).
    dead_letters: i64,
    pending: i64,
    warnings: Vec<String>,
}

async fn view(conn: &mut PgConnection) -> Result<MailView, ApiError> {
    let s = load(conn).await?;
    let (dead, pending): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE status = 'dead'), count(*) FILTER (WHERE status = 'pending') \
         FROM mail_outbox",
    )
    .fetch_one(&mut *conn)
    .await?;
    let signup = crate::signup::load_settings(conn).await?;
    let mut warnings = Vec::new();
    if !s.enabled && (signup.register_enabled || signup.reset_enabled) {
        warnings.push("注册或找回密码已开启，但邮件发送未启用：验证码与重置链接无法送达".into());
    }
    if s.provider == "smtp" && s.security == "none" {
        warnings.push("未加密连接只适用于本机或内网的中继/测试收件服务".into());
    }
    Ok(MailView {
        version: s.version,
        enabled: s.enabled,
        provider: s.provider,
        providers: transport::PROVIDERS.iter().map(|p| p.id()).collect(),
        host: s.host,
        port: s.port,
        security: s.security,
        username: s.username,
        password_set: s.password_enc.is_some(),
        api_key_set: s.api_key_enc.is_some(),
        from_addr: s.from_addr,
        from_name: s.from_name,
        notify_order_paid: s.notify_order_paid,
        notify_expiry_days: s.notify_expiry_days,
        notify_expired: s.notify_expired,
        notify_quota: s.notify_quota,
        dead_letters: dead,
        pending,
        warnings,
    })
}

/// GET /api/v1/settings/mail (admin).
pub async fn get_mail_settings(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<MailView>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    Ok(Json(view(&mut c).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MailReq {
    pub version: i64,
    pub enabled: bool,
    /// W31: smtp | resend; absent = keep the stored provider.
    #[serde(default)]
    pub provider: Option<String>,
    pub host: Option<String>,
    pub port: i32,
    pub security: String,
    pub username: Option<String>,
    /// Absent = keep the stored password, null or "" = remove it,
    /// a string = replace it.
    #[serde(default, deserialize_with = "double_option")]
    pub password: Option<Option<String>>,
    /// W31, the Resend API key: same rules as `password`.
    #[serde(default, deserialize_with = "double_option")]
    pub api_key: Option<Option<String>>,
    pub from_addr: Option<String>,
    pub from_name: Option<String>,
    pub notify_order_paid: bool,
    pub notify_expiry_days: i32,
    pub notify_expired: bool,
    pub notify_quota: bool,
}

/// Validated values of a `MailReq` (provider/password/api_key: None = keep).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailValues {
    pub enabled: bool,
    pub provider: Option<String>,
    pub host: Option<String>,
    pub port: i32,
    pub security: String,
    pub username: Option<String>,
    pub password: Option<Option<String>>,
    pub api_key: Option<Option<String>>,
    pub from_addr: Option<String>,
    pub from_name: Option<String>,
    pub notify_order_paid: bool,
    pub notify_expiry_days: i32,
    pub notify_expired: bool,
    pub notify_quota: bool,
}

fn printable(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

/// SMTP host: a DNS name (any case, IDN ok) or an IP literal.
fn valid_host(h: &str) -> Option<String> {
    if h.parse::<std::net::IpAddr>().is_ok() {
        return Some(h.to_string());
    }
    let ascii = idna::domain_to_ascii(h.trim_end_matches('.')).ok()?;
    let ok = !ascii.is_empty()
        && ascii.len() <= 253
        && ascii.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        });
    ok.then(|| ascii.to_ascii_lowercase())
}

fn blank(v: &Option<String>) -> Option<String> {
    v.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// A replacement secret: None = keep, Some(None) = remove.
fn secret(
    v: &Option<Option<String>>,
    max: usize,
    invalid: impl Fn() -> ApiError,
) -> Result<Option<Option<String>>, ApiError> {
    match v {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(p)) if p.is_empty() => Ok(Some(None)),
        Some(Some(p)) => {
            if p.len() > max || !printable(p) {
                return Err(invalid());
            }
            Ok(Some(Some(p.clone())))
        }
    }
}

pub fn mail_values(req: &MailReq) -> Result<MailValues, ApiError> {
    let provider = match &req.provider {
        None => None,
        Some(p) if transport::provider(p).is_some() => Some(p.clone()),
        Some(_) => {
            return Err(bad_request!(
                "mail.provider_invalid",
                "unknown mail provider"
            ));
        }
    };
    let host = match blank(&req.host) {
        None => None,
        Some(h) => Some(valid_host(&h).ok_or_else(|| {
            bad_request!(
                "mail.host_invalid",
                "host must be a host name or IP address"
            )
        })?),
    };
    if !(1..=65535).contains(&req.port) {
        return Err(bad_request!("request.port_range", "port must be 1-65535"));
    }
    if !["starttls", "tls", "none"].contains(&req.security.as_str()) {
        return Err(bad_request!(
            "mail.security_invalid",
            "security must be starttls, tls or none"
        ));
    }
    let username = blank(&req.username);
    if username
        .as_deref()
        .is_some_and(|u| u.len() > 256 || !printable(u))
    {
        return Err(bad_request!("mail.username_invalid", "username is invalid"));
    }
    let password = secret(&req.password, 256, || {
        bad_request!("mail.password_invalid", "password is invalid")
    })?;
    let api_key = secret(&req.api_key, 256, || {
        bad_request!("mail.api_key_invalid", "api_key is invalid")
    })?;
    if req.security == "none" && username.is_some() {
        return Err(bad_request!(
            "mail.credentials_need_tls",
            "credentials are only sent over TLS (security starttls or tls)"
        ));
    }
    let from_addr = match blank(&req.from_addr) {
        None => None,
        Some(a) => Some(crate::signup::email::parse(&a).ok_or_else(|| {
            bad_request!(
                "mail.from_invalid",
                "from_addr is not a valid email address"
            )
        })?),
    };
    let from_name = blank(&req.from_name);
    if from_name
        .as_deref()
        .is_some_and(|n| n.chars().count() > 64 || !printable(n))
    {
        return Err(bad_request!(
            "mail.from_name_long",
            "from_name must be at most 64 characters"
        ));
    }
    if !(0..=30).contains(&req.notify_expiry_days) {
        return Err(bad_request!(
            "mail.expiry_days_range",
            "notify_expiry_days must be 0-30"
        ));
    }
    Ok(MailValues {
        enabled: req.enabled,
        provider,
        host,
        port: req.port,
        security: req.security.clone(),
        password: if username.is_none() {
            Some(None)
        } else {
            password
        },
        api_key,
        username,
        from_addr,
        from_name,
        notify_order_paid: req.notify_order_paid,
        notify_expiry_days: req.notify_expiry_days,
        notify_expired: req.notify_expired,
        notify_quota: req.notify_quota,
    })
}

/// Write the mail settings (optimistic concurrency on `version`) with the
/// audit row, in the caller's transaction. Secrets are sealed with the
/// panel's master key and audited only as "changed". Enabling needs what
/// the provider needs (stored or new): SMTP a host, Resend an API key, both
/// a sender address.
pub async fn apply_update_mail(
    conn: &mut PgConnection,
    actor: &Actor,
    keys: &crate::totp::Keys,
    version: i64,
    v: &MailValues,
) -> Result<(), ApiError> {
    let cur: MailSettings = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {MAIL_COLS} FROM mail_settings WHERE id = 1 FOR UPDATE"
    )))
    .fetch_one(&mut *conn)
    .await?;
    if cur.version != version {
        return Err(conflict!(
            "settings.version_conflict",
            "settings changed meanwhile; reload and retry"
        ));
    }
    let provider = v.provider.clone().unwrap_or_else(|| cur.provider.clone());
    let sealed = |new: &Option<Option<String>>, old: &Option<Vec<u8>>, aad| match new {
        None => Ok(old.clone()),
        Some(None) => Ok(None),
        Some(Some(p)) => keys.seal(aad, p.as_bytes()).map(Some),
    };
    let password_enc = sealed(&v.password, &cur.password_enc, SMTP_AAD)?;
    let api_key_enc = sealed(&v.api_key, &cur.api_key_enc, RESEND_AAD)?;
    if v.enabled {
        if v.from_addr.is_none() {
            return Err(bad_request!(
                "mail.enable_needs_host",
                "host and from_addr are required to enable sending"
            ));
        }
        match provider.as_str() {
            "resend" if api_key_enc.is_none() => {
                return Err(bad_request!(
                    "mail.enable_needs_api_key",
                    "an API key and from_addr are required to enable sending"
                ));
            }
            "smtp" if v.host.is_none() => {
                return Err(bad_request!(
                    "mail.enable_needs_host",
                    "host and from_addr are required to enable sending"
                ));
            }
            _ => {}
        }
    }
    let snap = |s: &MailValues, provider: &str| {
        json!({
            "enabled": s.enabled, "provider": provider, "host": s.host, "port": s.port,
            "security": s.security, "username": s.username,
            "password": if s.password.is_some() { CHANGED } else { "" },
            "api_key": if s.api_key.is_some() { CHANGED } else { "" },
            "from_addr": s.from_addr, "from_name": s.from_name,
            "notify_order_paid": s.notify_order_paid, "notify_expiry_days": s.notify_expiry_days,
            "notify_expired": s.notify_expired, "notify_quota": s.notify_quota,
        })
    };
    let before = json!({
        "enabled": cur.enabled, "provider": cur.provider, "host": cur.host, "port": cur.port,
        "security": cur.security, "username": cur.username, "from_addr": cur.from_addr,
        "from_name": cur.from_name, "notify_order_paid": cur.notify_order_paid,
        "notify_expiry_days": cur.notify_expiry_days, "notify_expired": cur.notify_expired,
        "notify_quota": cur.notify_quota,
    });
    sqlx::query(
        "UPDATE mail_settings SET version = version + 1, enabled = $1, host = $2, port = $3, \
         security = $4, username = $5, password_enc = $6, from_addr = $7, from_name = $8, \
         notify_order_paid = $9, notify_expiry_days = $10, notify_expired = $11, \
         notify_quota = $12, provider = $13, api_key_enc = $14, updated_at = now() WHERE id = 1",
    )
    .bind(v.enabled)
    .bind(&v.host)
    .bind(v.port)
    .bind(&v.security)
    .bind(&v.username)
    .bind(&password_enc)
    .bind(&v.from_addr)
    .bind(&v.from_name)
    .bind(v.notify_order_paid)
    .bind(v.notify_expiry_days)
    .bind(v.notify_expired)
    .bind(v.notify_quota)
    .bind(&provider)
    .bind(&api_key_enc)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "settings.mail.update",
        "settings",
        Some("mail".into()),
        Some(before),
        Some(snap(v, &provider)),
    )
    .await?;
    Ok(())
}

/// PUT /api/v1/settings/mail (admin).
pub async fn put_mail_settings(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<MailReq>,
) -> Result<Json<MailView>, ApiError> {
    user.require_admin()?;
    let v = mail_values(&req)?;
    let mut tx = state.pg().begin().await?;
    apply_update_mail(&mut tx, &Actor::of(&user), state.totp(), req.version, &v).await?;
    let out = view(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(out))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestReq {
    pub to: String,
}

/// Longest wait for the test mail (connect + TLS + AUTH + DATA / API call).
const TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// POST /api/v1/settings/mail/test (admin): send a test message right now
/// with the SAVED settings (enabled or not) and report the provider's
/// answer. Uses the (possibly edited) `test` template. The step-by-step
/// check is `POST /settings/mail/diagnose` (`diagnose::diagnose`).
pub async fn send_test(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<TestReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let (settings, rendered) = {
        let mut c = state.pg().acquire().await?;
        let s = load(&mut c).await?;
        let r = overrides::render_for(&mut c, &Template::Test, Locale::Zh, s.site()).await?;
        (s, r)
    };
    send_now(&state, &user, &settings, &req.to, rendered, None).await
}

/// Send one rendered message synchronously with the saved settings (the
/// admin's test mails), audit the outcome (`settings.mail.test`,
/// `template` = the kind when testing a template) and report the
/// provider's answer (502 with the detail on failure).
pub(crate) async fn send_now(
    state: &AppState,
    user: &AuthUser,
    settings: &MailSettings,
    to: &str,
    rendered: templates::Rendered,
    template: Option<&str>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let to = crate::signup::email::parse(to)
        .ok_or_else(|| bad_request!("mail.to_invalid", "to is not a valid email address"))?;
    if !settings.complete() {
        return Err(bad_request!(
            "mail.test_needs_host",
            "save the SMTP host and sender address first"
        ));
    }
    let transport = transport::build(settings, state.totp()).map_err(|e| {
        crate::auth::api_error!(BAD_GATEWAY, "mail.test_failed", "{detail}", detail = e)
    })?;
    let msg = transport::OutMsg {
        to: to.clone(),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
    };
    let res = tokio::time::timeout(TEST_TIMEOUT, transport.send(&msg)).await;
    let outcome = match &res {
        Ok(Ok(())) => "sent".to_string(),
        Ok(Err(e)) => e.message.clone(),
        Err(_) => "timed out".to_string(),
    };
    {
        let mut c = state.pg().acquire().await?;
        crate::audit::record(
            &mut c,
            &Actor::of(user),
            "settings.mail.test",
            "settings",
            Some("mail".into()),
            None,
            Some(json!({ "to": to, "outcome": outcome, "template": template, "provider": settings.provider })),
        )
        .await?;
    }
    match res {
        Ok(Ok(())) => Ok(Json(json!({ "ok": true }))),
        _ => Err(crate::auth::api_error!(
            BAD_GATEWAY,
            "mail.test_failed",
            "send failed: {detail}",
            detail = outcome
        )),
    }
}

// ---------------------------------------------------------------------------
// Outbox (admin): dead letters and retry
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct OutboxRow {
    id: i64,
    kind: String,
    to_addr: String,
    subject: String,
    status: String,
    attempts: i32,
    last_error: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    next_attempt_at: chrono::DateTime<chrono::Utc>,
    settled_at: Option<chrono::DateTime<chrono::Utc>>,
    /// A dead letter that can still be re-queued (body kept, not expired).
    retryable: bool,
}

#[derive(Deserialize)]
pub struct OutboxQuery {
    pub status: Option<String>,
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

/// GET /api/v1/mail/outbox?status=dead|pending|sent&before=<id>&limit=
/// (admin): newest first; never the bodies.
pub async fn list_outbox(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<OutboxQuery>,
) -> Result<Json<Vec<OutboxRow>>, ApiError> {
    user.require_admin()?;
    let status = q.status.as_deref().unwrap_or("dead");
    if !["dead", "pending", "sent"].contains(&status) {
        return Err(bad_request!(
            "mail.status_invalid",
            "status must be dead, pending or sent"
        ));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows = sqlx::query_as::<_, OutboxRow>(
        "SELECT id, kind, to_addr, subject, status, attempts, last_error, created_at, \
         next_attempt_at, settled_at, \
         (status = 'dead' AND body_text <> '' AND (discard_after IS NULL OR discard_after > now())) \
         AS retryable \
         FROM mail_outbox WHERE status = $1 AND ($2::bigint IS NULL OR id < $2) \
         ORDER BY id DESC LIMIT $3",
    )
    .bind(status)
    .bind(q.before)
    .bind(limit)
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// POST /api/v1/mail/outbox/{id}/retry (admin): re-queue a dead letter.
pub async fn retry_outbox(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, i64)>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let n = sqlx::query(
        "UPDATE mail_outbox SET status = 'pending', settled_at = NULL, attempts = 0, \
         next_attempt_at = now(), claimed_until = NULL, claim_token = NULL \
         WHERE id = $1 AND status = 'dead' AND body_text <> '' \
         AND (discard_after IS NULL OR discard_after > now())",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(conflict!(
            "mail.retry_not_dead",
            "only a dead letter that has not expired can be retried"
        ));
    }
    crate::audit::record(
        &mut tx,
        &Actor::of(&user),
        "mail.retry",
        "mail",
        Some(id.to_string()),
        None,
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route(
            "/{prefix}/api/v1/settings/mail",
            get(get_mail_settings).put(put_mail_settings),
        )
        .route("/{prefix}/api/v1/settings/mail/test", post(send_test))
        .route(
            "/{prefix}/api/v1/settings/mail/diagnose",
            post(diagnose::diagnose),
        )
        // Ops: editable templates.
        .route(
            "/{prefix}/api/v1/settings/mail-templates",
            get(overrides::list),
        )
        .route(
            "/{prefix}/api/v1/settings/mail-templates/preview",
            post(overrides::preview),
        )
        .route(
            "/{prefix}/api/v1/settings/mail-templates/{kind}/{locale}",
            axum::routing::put(overrides::put).delete(overrides::reset),
        )
        .route(
            "/{prefix}/api/v1/settings/mail-templates/{kind}/{locale}/test",
            post(overrides::send_test),
        )
        .route("/{prefix}/api/v1/mail/outbox", get(list_outbox))
        .route(
            "/{prefix}/api/v1/mail/outbox/{id}/retry",
            post(retry_outbox),
        )
}

#[cfg(test)]
mod tests;
