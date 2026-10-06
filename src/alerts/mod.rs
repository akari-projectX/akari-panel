//! W17 server alerts (W11 follow-up): thresholds, the evaluator, the alert
//! center API and notification channels.
//!
//! - **Rules** (`alert_settings`, one row; per-server overrides in
//!   `server_alert_rules`): server offline > N s, CPU > X % for M minutes,
//!   memory > X % for M minutes (W11 minute history), disk > X % (latest
//!   heartbeat), every latency test target of a source failing, the server's
//!   TLS certificate (W10, heartbeat) or its agent certificate expiring
//!   within D days, `last_error` set. A NULL threshold turns a rule off; a
//!   server can override thresholds, disable kinds, or be muted (alerts
//!   recorded, never notified).
//! - **Evaluator** (`eval.rs`, every `[alerts].eval_interval_secs` on every
//!   instance): one instance at a time does the round — a transaction-level
//!   advisory try-lock (`akari.alerts`, keyed per schema so test schemas do
//!   not contend); the others skip it. Facts are read from the database
//!   (and the Valkey heartbeat blobs), so whichever instance leads computes
//!   the same thing. State machine per (server, kind): absent → firing →
//!   resolved; at most one firing row (partial unique index = dedupe across
//!   any writer); metric kinds of an offline server are "unknown" and keep
//!   their state; a re-fire within `cooldown_minutes` of the last notified
//!   one is recorded but not notified (flapping); a resolved notification
//!   follows only a notified firing.
//! - **Notifications** (`channels.rs`): each is an `alert_notifications`
//!   row written in the evaluator's transaction (one per enabled channel),
//!   delivered by any instance (claim with `FOR UPDATE SKIP LOCKED`, a lease
//!   and a claim token; at-least-once; exponential backoff; dead after
//!   `MAX_ATTEMPTS` or a permanent refusal). Channels: Telegram bot
//!   (outbound `sendMessage` only), a generic webhook (HMAC-SHA256 signed
//!   JSON), email through the W15 outbox (`mailhook`;
//!   SMTP off = a permanent failure). The bot token and the webhook key are sealed in the database
//!   (`totp::Keys::seal`) and never returned, logged or audited in clear.
//! - **Prometheus**: `akari_server_alerts_firing{kind}` (bounded: the kinds),
//!   `akari_alert_notifications_total{channel,result}`,
//!   `akari_alert_rounds_total{result}`; no per-server labels.

pub mod channels;
pub mod eval;

use crate::auth::{bad_request, conflict};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::{ApiJson, double_option};
use crate::audit::{Actor, CHANGED};
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

/// Every alert kind (the `server_alerts.kind` CHECK).
pub const KINDS: [&str; 9] = [
    "offline",
    "cpu",
    "memory",
    "disk",
    "latency",
    "cert",
    "agent_cert",
    "last_error",
    "entrance_down",
];

/// Kinds whose facts come from a live agent (unknown while it is offline).
pub const LIVE_KINDS: [&str; 5] = ["cpu", "memory", "disk", "latency", "cert"];

/// AAD of the sealed secrets (`totp::Keys::seal`, bound to these fixed ids
/// instead of a user, so a blob cannot be moved between the two columns).
pub const TELEGRAM_AAD: Uuid = Uuid::from_u128(0x616b_6172_692d_616c_6572_742d_7467_6d31);
pub const WEBHOOK_AAD: Uuid = Uuid::from_u128(0x616b_6172_692d_616c_6572_742d_7768_6b31);

pub fn kind_label(kind: &str) -> &'static str {
    match kind {
        "offline" => "服务器离线",
        "cpu" => "CPU 过高",
        "memory" => "内存过高",
        "disk" => "磁盘将满",
        "latency" => "测速全部失败",
        "cert" => "服务器证书即将到期",
        "agent_cert" => "Agent 证书即将到期",
        "last_error" => "配置应用失败",
        "entrance_down" => "中转入口不可用",
        _ => "告警",
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// The `alert_settings` row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Settings {
    pub version: i64,
    pub enabled: bool,
    pub offline_secs: Option<i32>,
    pub cpu_percent: Option<i32>,
    pub cpu_minutes: i32,
    pub mem_percent: Option<i32>,
    pub mem_minutes: i32,
    pub disk_percent: Option<i32>,
    pub cert_days: Option<i32>,
    pub latency_failures: bool,
    pub last_error: bool,
    pub cooldown_minutes: i32,
    pub notify_resolved: bool,
    pub telegram_enabled: bool,
    pub telegram_chat_id: Option<String>,
    pub telegram_token_enc: Option<Vec<u8>>,
    pub webhook_enabled: bool,
    pub webhook_url: Option<String>,
    pub webhook_secret_enc: Option<Vec<u8>>,
    pub email_enabled: bool,
    pub email_to: Vec<String>,
    /// W25: Bot API origin (None = `config::TELEGRAM_API_URL`).
    pub telegram_api_url: Option<String>,
}

const SETTINGS_COLS: &str = "version, enabled, offline_secs, cpu_percent, cpu_minutes, \
     mem_percent, mem_minutes, disk_percent, cert_days, latency_failures, last_error, \
     cooldown_minutes, notify_resolved, telegram_enabled, telegram_chat_id, telegram_token_enc, \
     webhook_enabled, webhook_url, webhook_secret_enc, email_enabled, email_to, telegram_api_url";

pub async fn load(conn: &mut PgConnection) -> sqlx::Result<Settings> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SETTINGS_COLS} FROM alert_settings WHERE id = 1"
    )))
    .fetch_one(conn)
    .await
}

impl Settings {
    /// The channels a notification goes to.
    pub fn channels(&self) -> Vec<&'static str> {
        let mut c = Vec::new();
        if self.telegram_enabled {
            c.push("telegram");
        }
        if self.webhook_enabled {
            c.push("webhook");
        }
        if self.email_enabled {
            c.push("email");
        }
        c
    }
}

/// Thresholds shared by the global settings and the per-server overrides.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct Thresholds {
    pub offline_secs: Option<i32>,
    pub cpu_percent: Option<i32>,
    pub cpu_minutes: Option<i32>,
    pub mem_percent: Option<i32>,
    pub mem_minutes: Option<i32>,
    pub disk_percent: Option<i32>,
    pub cert_days: Option<i32>,
}

fn range(field: &str, v: Option<i32>, lo: i32, hi: i32) -> Result<(), ApiError> {
    match v {
        Some(x) if !(lo..=hi).contains(&x) => Err(bad_request!(
            "alert.field_range",
            "{field} must be {lo}-{hi}",
            field = field,
            lo = lo,
            hi = hi
        )),
        _ => Ok(()),
    }
}

impl Thresholds {
    pub fn check(&self) -> Result<(), ApiError> {
        range("offline_secs", self.offline_secs, 30, 86_400)?;
        range("cpu_percent", self.cpu_percent, 1, 100)?;
        range("cpu_minutes", self.cpu_minutes, 1, 60)?;
        range("mem_percent", self.mem_percent, 1, 100)?;
        range("mem_minutes", self.mem_minutes, 1, 60)?;
        range("disk_percent", self.disk_percent, 1, 100)?;
        range("cert_days", self.cert_days, 1, 90)
    }
}

/// PUT /alerts/settings: the whole row (thresholds null = rule off).
/// Secrets: absent = keep, null = clear, a string = replace.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutSettings {
    pub version: i64,
    pub enabled: bool,
    #[serde(default)]
    pub offline_secs: Option<i32>,
    #[serde(default)]
    pub cpu_percent: Option<i32>,
    pub cpu_minutes: i32,
    #[serde(default)]
    pub mem_percent: Option<i32>,
    pub mem_minutes: i32,
    #[serde(default)]
    pub disk_percent: Option<i32>,
    #[serde(default)]
    pub cert_days: Option<i32>,
    pub latency_failures: bool,
    pub last_error: bool,
    pub cooldown_minutes: i32,
    pub notify_resolved: bool,
    pub telegram_enabled: bool,
    #[serde(default)]
    pub telegram_chat_id: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub telegram_token: Option<Option<String>>,
    pub webhook_enabled: bool,
    #[serde(default)]
    pub webhook_url: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub webhook_secret: Option<Option<String>>,
    pub email_enabled: bool,
    #[serde(default)]
    pub email_to: Vec<String>,
    /// W25: Bot API origin; absent/null = api.telegram.org.
    #[serde(default)]
    pub telegram_api_url: Option<String>,
}

/// Telegram chat id: a numeric id (groups/channels negative) or @username.
pub fn valid_chat_id(s: &str) -> bool {
    let digits = |d: &str| !d.is_empty() && d.len() <= 20 && d.bytes().all(|b| b.is_ascii_digit());
    if let Some(name) = s.strip_prefix('@') {
        (5..=32).contains(&name.len())
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    } else {
        digits(s.strip_prefix('-').unwrap_or(s))
    }
}

/// Telegram Bot API origin (a self-hosted Bot API server): https, or http
/// on a loopback host; scheme + host (+ port) only.
pub fn valid_telegram_api_url(s: &str) -> bool {
    let Ok(u) = s.parse::<axum::http::Uri>() else {
        return false;
    };
    let Some(host) = u.host() else {
        return false;
    };
    let scheme_ok = match u.scheme_str() {
        Some("https") => true,
        Some("http") => matches!(host, "127.0.0.1" | "localhost" | "[::1]"),
        _ => false,
    };
    scheme_ok
        && (9..=2048).contains(&s.len())
        && u.path_and_query().is_none_or(|p| p.as_str() == "/")
        && !s.contains('@')
}

/// Telegram bot token: `<bot id>:<secret>` (BotFather format).
pub fn valid_bot_token(s: &str) -> bool {
    let Some((id, secret)) = s.split_once(':') else {
        return false;
    };
    (3..=15).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_digit())
        && (30..=64).contains(&secret.len())
        && secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Webhook URL: https (http only to loopback, like every outbound client
/// of the panel), no credentials, no whitespace, <= 512 bytes.
pub fn check_webhook_url(s: &str) -> Result<(), ApiError> {
    let bad = |m: &str| {
        Err(bad_request!(
            "alert.webhook_url_invalid",
            "webhook_url: {m}",
            m = m
        ))
    };
    if s.is_empty() || s.len() > 512 || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return bad("must be an absolute URL of at most 512 characters");
    }
    let Ok(uri) = s.parse::<axum::http::Uri>() else {
        return bad("not a URL");
    };
    let Some(host) = uri.host() else {
        return bad("no host");
    };
    if uri.authority().is_some_and(|a| a.as_str().contains('@')) {
        return bad("credentials in the URL are not allowed (sign with the secret instead)");
    }
    match uri.scheme_str() {
        Some("https") => Ok(()),
        Some("http") if crate::billing::http::is_loopback_host(host) => Ok(()),
        _ => bad("must be https (http only to localhost)"),
    }
}

/// Webhook signing key: 16-128 printable ASCII characters.
pub fn valid_webhook_secret(s: &str) -> bool {
    (16..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_graphic())
}

/// A plausible mail address (the outbox validates again).
pub fn valid_email(s: &str) -> bool {
    let Some((local, domain)) = s.rsplit_once('@') else {
        return false;
    };
    s.len() <= 254
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !s
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == ',' || c == ';')
}

/// Validate a PUT (pure; the secrets' presence is checked against the row
/// in `apply_update_settings`).
pub fn check_put(req: &PutSettings) -> Result<(), ApiError> {
    Thresholds {
        offline_secs: req.offline_secs,
        cpu_percent: req.cpu_percent,
        cpu_minutes: Some(req.cpu_minutes),
        mem_percent: req.mem_percent,
        mem_minutes: Some(req.mem_minutes),
        disk_percent: req.disk_percent,
        cert_days: req.cert_days,
    }
    .check()?;
    range("cooldown_minutes", Some(req.cooldown_minutes), 0, 1440)?;
    if let Some(c) = &req.telegram_chat_id
        && !valid_chat_id(c)
    {
        return Err(bad_request!(
            "alert.telegram_chat_invalid",
            "telegram_chat_id must be a numeric chat id or @channel"
        ));
    }
    if let Some(Some(t)) = &req.telegram_token
        && !valid_bot_token(t)
    {
        return Err(bad_request!(
            "alert.telegram_token_invalid",
            "telegram_token must look like 123456789:AA... (from @BotFather)"
        ));
    }
    if let Some(u) = &req.webhook_url {
        check_webhook_url(u)?;
    }
    if let Some(u) = &req.telegram_api_url
        && !valid_telegram_api_url(u)
    {
        return Err(bad_request!(
            "alert.telegram_api_url_invalid",
            "telegram_api_url must be an https origin such as https://tg.example.com"
        ));
    }
    if let Some(Some(s)) = &req.webhook_secret
        && !valid_webhook_secret(s)
    {
        return Err(bad_request!(
            "alert.webhook_secret_invalid",
            "webhook_secret must be 16-128 printable ASCII characters"
        ));
    }
    if req.email_to.len() > 5 {
        return Err(bad_request!(
            "alert.too_many_recipients",
            "at most 5 email recipients"
        ));
    }
    for e in &req.email_to {
        if !valid_email(e) {
            return Err(bad_request!(
                "alert.email_invalid",
                "invalid email address {e:?}",
                e = e
            ));
        }
    }
    if req.telegram_enabled && req.telegram_chat_id.is_none() {
        return Err(bad_request!(
            "alert.telegram_chat_missing",
            "telegram needs a chat id"
        ));
    }
    if req.webhook_enabled && req.webhook_url.is_none() {
        return Err(bad_request!(
            "alert.webhook_url_missing",
            "the webhook needs a URL"
        ));
    }
    if req.email_enabled && req.email_to.is_empty() {
        return Err(bad_request!(
            "alert.email_needs_recipient",
            "email needs at least one recipient"
        ));
    }
    Ok(())
}

/// GET /alerts/settings (never the secrets).
#[derive(Serialize, Debug)]
pub struct SettingsView {
    version: i64,
    enabled: bool,
    offline_secs: Option<i32>,
    cpu_percent: Option<i32>,
    cpu_minutes: i32,
    mem_percent: Option<i32>,
    mem_minutes: i32,
    disk_percent: Option<i32>,
    cert_days: Option<i32>,
    latency_failures: bool,
    last_error: bool,
    cooldown_minutes: i32,
    notify_resolved: bool,
    telegram_enabled: bool,
    telegram_chat_id: Option<String>,
    telegram_token_set: bool,
    telegram_api_url: Option<String>,
    telegram_api_default: &'static str,
    webhook_enabled: bool,
    webhook_url: Option<String>,
    webhook_secret_set: bool,
    email_enabled: bool,
    email_to: Vec<String>,
    /// Whether the email channel can deliver (W15 SMTP outbox).
    email_available: bool,
    eval_interval_secs: u64,
}

fn view(s: &Settings, email_available: bool, eval_interval_secs: u64) -> SettingsView {
    SettingsView {
        version: s.version,
        enabled: s.enabled,
        offline_secs: s.offline_secs,
        cpu_percent: s.cpu_percent,
        cpu_minutes: s.cpu_minutes,
        mem_percent: s.mem_percent,
        mem_minutes: s.mem_minutes,
        disk_percent: s.disk_percent,
        cert_days: s.cert_days,
        latency_failures: s.latency_failures,
        last_error: s.last_error,
        cooldown_minutes: s.cooldown_minutes,
        notify_resolved: s.notify_resolved,
        telegram_enabled: s.telegram_enabled,
        telegram_chat_id: s.telegram_chat_id.clone(),
        telegram_token_set: s.telegram_token_enc.is_some(),
        telegram_api_url: s.telegram_api_url.clone(),
        telegram_api_default: crate::config::TELEGRAM_API_URL,
        webhook_enabled: s.webhook_enabled,
        webhook_url: s.webhook_url.clone(),
        webhook_secret_set: s.webhook_secret_enc.is_some(),
        email_enabled: s.email_enabled,
        email_to: s.email_to.clone(),
        email_available,
        eval_interval_secs,
    }
}

/// Audit snapshot: secrets only as set/unset.
fn audit_snapshot(s: &Settings) -> Value {
    let mut v = json!(view(s, false, 0));
    if let Some(o) = v.as_object_mut() {
        o.remove("email_available");
        o.remove("eval_interval_secs");
        o.remove("telegram_api_default");
    }
    v
}

/// Replace the settings (optimistic concurrency on `version`: 409 when
/// another admin saved meanwhile). Audited `alerts.settings.update`
/// (secrets as "changed").
pub async fn apply_update_settings(
    conn: &mut PgConnection,
    actor: &Actor,
    keys: &crate::totp::Keys,
    req: &PutSettings,
) -> Result<Settings, ApiError> {
    check_put(req)?;
    let before: Settings = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SETTINGS_COLS} FROM alert_settings WHERE id = 1 FOR UPDATE"
    )))
    .fetch_one(&mut *conn)
    .await?;
    if before.version != req.version {
        return Err(conflict!(
            "settings.version_conflict",
            "the alert settings were changed meanwhile; reload and try again"
        ));
    }
    if req.email_enabled && !before.email_enabled && !crate::mailhook::available(conn).await? {
        return Err(bad_request!(
            "alert.email_unavailable",
            "email delivery is not available yet (configure SMTP first)"
        ));
    }
    let seal = |aad: Uuid, v: &str| keys.seal(aad, v.as_bytes()).map_err(ApiError::from);
    let token_enc = match &req.telegram_token {
        None => before.telegram_token_enc.clone(),
        Some(None) => None,
        Some(Some(t)) => Some(seal(TELEGRAM_AAD, t)?),
    };
    let secret_enc = match &req.webhook_secret {
        None => before.webhook_secret_enc.clone(),
        Some(None) => None,
        Some(Some(s)) => Some(seal(WEBHOOK_AAD, s)?),
    };
    if req.telegram_enabled && token_enc.is_none() {
        return Err(bad_request!(
            "alert.telegram_token_missing",
            "telegram needs a bot token"
        ));
    }
    if req.webhook_enabled && secret_enc.is_none() {
        return Err(bad_request!(
            "alert.webhook_secret_missing",
            "the webhook needs a signing secret"
        ));
    }
    let after: Settings = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE alert_settings SET version = version + 1, enabled = $1, offline_secs = $2, \
           cpu_percent = $3, cpu_minutes = $4, mem_percent = $5, mem_minutes = $6, \
           disk_percent = $7, cert_days = $8, latency_failures = $9, last_error = $10, \
           cooldown_minutes = $11, notify_resolved = $12, telegram_enabled = $13, \
           telegram_chat_id = $14, telegram_token_enc = $15, webhook_enabled = $16, \
           webhook_url = $17, webhook_secret_enc = $18, email_enabled = $19, email_to = $20, \
           telegram_api_url = $21, updated_at = now() \
         WHERE id = 1 RETURNING {SETTINGS_COLS}"
    )))
    .bind(req.enabled)
    .bind(req.offline_secs)
    .bind(req.cpu_percent)
    .bind(req.cpu_minutes)
    .bind(req.mem_percent)
    .bind(req.mem_minutes)
    .bind(req.disk_percent)
    .bind(req.cert_days)
    .bind(req.latency_failures)
    .bind(req.last_error)
    .bind(req.cooldown_minutes)
    .bind(req.notify_resolved)
    .bind(req.telegram_enabled)
    .bind(&req.telegram_chat_id)
    .bind(&token_enc)
    .bind(req.webhook_enabled)
    .bind(&req.webhook_url)
    .bind(&secret_enc)
    .bind(req.email_enabled)
    .bind(&req.email_to)
    .bind(
        req.telegram_api_url
            .as_deref()
            .map(|u| u.trim_end_matches('/')),
    )
    .fetch_one(&mut *conn)
    .await?;
    let mut after_json = audit_snapshot(&after);
    if req.telegram_token.is_some() {
        after_json["telegram_token"] = json!(CHANGED);
    }
    if req.webhook_secret.is_some() {
        after_json["webhook_secret"] = json!(CHANGED);
    }
    crate::audit::record(
        conn,
        actor,
        "alerts.settings.update",
        "settings",
        Some("alerts".into()),
        Some(audit_snapshot(&before)),
        Some(after_json),
    )
    .await?;
    Ok(after)
}

pub async fn get_settings(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<SettingsView>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    let s = load(&mut c).await?;
    let mail = crate::mailhook::available(&mut c).await?;
    Ok(Json(view(
        &s,
        mail,
        state.cfg().limits.alerts_eval_interval_secs,
    )))
}

pub async fn put_settings(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<PutSettings>,
) -> Result<Json<SettingsView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let s = apply_update_settings(&mut tx, &Actor::of(&user), state.totp(), &req).await?;
    let mail = crate::mailhook::available(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(view(
        &s,
        mail,
        state.cfg().limits.alerts_eval_interval_secs,
    )))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestReq {
    pub channel: String,
}

/// POST /alerts/test {channel}: send a test message through the SAVED
/// configuration of one channel now and report the outcome (audited
/// `alerts.test`).
pub async fn test_channel(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<TestReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    if !["telegram", "webhook", "email"].contains(&req.channel.as_str()) {
        return Err(bad_request!(
            "alert.channel_invalid",
            "channel must be telegram, webhook or email"
        ));
    }
    let mut tx = state.pg().begin().await?;
    let s = load(&mut tx).await?;
    let msg = channels::Message::test(&user.email);
    let res = channels::send(&state, Some(&mut tx), &s, &req.channel, &msg, 0).await;
    crate::audit::record(
        &mut tx,
        &Actor::of(&user),
        "alerts.test",
        "settings",
        Some("alerts".into()),
        None,
        Some(json!({ "channel": req.channel, "ok": res.is_ok() })),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(match res {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.text() }),
    }))
}

// ---------------------------------------------------------------------------
// Per-server rules
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub struct ServerRules {
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub disabled: Vec<String>,
    #[serde(default)]
    pub offline_secs: Option<i32>,
    #[serde(default)]
    pub cpu_percent: Option<i32>,
    #[serde(default)]
    pub cpu_minutes: Option<i32>,
    #[serde(default)]
    pub mem_percent: Option<i32>,
    #[serde(default)]
    pub mem_minutes: Option<i32>,
    #[serde(default)]
    pub disk_percent: Option<i32>,
    #[serde(default)]
    pub cert_days: Option<i32>,
}

const RULE_COLS: &str = "muted, disabled, offline_secs, cpu_percent, cpu_minutes, mem_percent, \
     mem_minutes, disk_percent, cert_days";

impl ServerRules {
    pub fn check(&self) -> Result<(), ApiError> {
        Thresholds {
            offline_secs: self.offline_secs,
            cpu_percent: self.cpu_percent,
            cpu_minutes: self.cpu_minutes,
            mem_percent: self.mem_percent,
            mem_minutes: self.mem_minutes,
            disk_percent: self.disk_percent,
            cert_days: self.cert_days,
        }
        .check()?;
        if self.disabled.len() > KINDS.len() {
            return Err(bad_request!(
                "alert.too_many_kinds",
                "too many disabled kinds"
            ));
        }
        for k in &self.disabled {
            if !KINDS.contains(&k.as_str()) {
                return Err(bad_request!(
                    "alert.kind_unknown",
                    "unknown alert kind {k:?} (one of: {allowed})",
                    k = k,
                    allowed = KINDS.join(", ")
                ));
            }
        }
        Ok(())
    }
}

async fn server_exists(conn: &mut PgConnection, server: Uuid) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM servers WHERE id = $1)")
        .bind(server)
        .fetch_one(conn)
        .await
}

pub async fn server_rules(conn: &mut PgConnection, server: Uuid) -> sqlx::Result<ServerRules> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {RULE_COLS} FROM server_alert_rules WHERE server_id = $1"
    )))
    .bind(server)
    .fetch_optional(conn)
    .await?
    .unwrap_or_default())
}

/// Replace a server's overrides (all defaults = the row is removed). Does
/// not bump the server (nothing the agent runs changes). Audited
/// `server.alert_rules.set`.
pub async fn apply_set_server_rules(
    conn: &mut PgConnection,
    actor: &Actor,
    server: Uuid,
    rules: &ServerRules,
) -> Result<(), ApiError> {
    rules.check()?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM servers WHERE id = $1 FOR KEY SHARE)")
            .bind(server)
            .fetch_one(&mut *conn)
            .await?;
    if !exists {
        return Err(ApiError::not_found());
    }
    let before = server_rules(conn, server).await?;
    let mut disabled = rules.disabled.clone();
    disabled.sort();
    disabled.dedup();
    let rules = ServerRules {
        disabled,
        ..rules.clone()
    };
    if rules == ServerRules::default() {
        sqlx::query("DELETE FROM server_alert_rules WHERE server_id = $1")
            .bind(server)
            .execute(&mut *conn)
            .await?;
    } else {
        sqlx::query(
            "INSERT INTO server_alert_rules (server_id, muted, disabled, offline_secs, cpu_percent, \
               cpu_minutes, mem_percent, mem_minutes, disk_percent, cert_days) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             ON CONFLICT (server_id) DO UPDATE SET muted = EXCLUDED.muted, \
               disabled = EXCLUDED.disabled, offline_secs = EXCLUDED.offline_secs, \
               cpu_percent = EXCLUDED.cpu_percent, cpu_minutes = EXCLUDED.cpu_minutes, \
               mem_percent = EXCLUDED.mem_percent, mem_minutes = EXCLUDED.mem_minutes, \
               disk_percent = EXCLUDED.disk_percent, cert_days = EXCLUDED.cert_days, \
               updated_at = now()",
        )
        .bind(server)
        .bind(rules.muted)
        .bind(&rules.disabled)
        .bind(rules.offline_secs)
        .bind(rules.cpu_percent)
        .bind(rules.cpu_minutes)
        .bind(rules.mem_percent)
        .bind(rules.mem_minutes)
        .bind(rules.disk_percent)
        .bind(rules.cert_days)
        .execute(&mut *conn)
        .await?;
    }
    crate::audit::record(
        conn,
        actor,
        "server.alert_rules.set",
        "server",
        Some(server.to_string()),
        Some(json!(before)),
        Some(json!(rules)),
    )
    .await?;
    Ok(())
}

pub async fn get_server_rules(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<ServerRules>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    if !server_exists(&mut c, id).await? {
        return Err(ApiError::not_found());
    }
    Ok(Json(server_rules(&mut c, id).await?))
}

pub async fn put_server_rules(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<ServerRules>,
) -> Result<Json<ServerRules>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_set_server_rules(&mut tx, &Actor::of(&user), id, &req).await?;
    let r = server_rules(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(r))
}

// ---------------------------------------------------------------------------
// Alert center
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct AlertQuery {
    /// firing | resolved; absent = both.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub server: Option<Uuid>,
    #[serde(default)]
    pub kind: Option<String>,
    /// Keyset: alerts with id < before.
    #[serde(default)]
    pub before: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AlertRow {
    id: i64,
    server_id: Uuid,
    server_name: String,
    kind: String,
    status: String,
    fired_at: DateTime<Utc>,
    resolved_at: Option<DateTime<Utc>>,
    value: String,
    detail: String,
    notified: bool,
    acked_at: Option<DateTime<Utc>>,
    acked_by: Option<String>,
}

/// GET /alerts (admin): newest first, keyset paging; `firing` = how many
/// are firing now (for the nav badge), by kind.
pub async fn list_alerts(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<AlertQuery>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    if let Some(s) = q.status.as_deref()
        && !["firing", "resolved"].contains(&s)
    {
        return Err(bad_request!(
            "alert.status_invalid",
            "status must be firing or resolved"
        ));
    }
    if let Some(k) = q.kind.as_deref()
        && !KINDS.contains(&k)
    {
        return Err(bad_request!("alert.kind_unknown", "unknown alert kind"));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows: Vec<AlertRow> = sqlx::query_as(
        "SELECT a.id, a.server_id, n.name AS server_name, a.kind, a.status, \
           a.fired_at, a.resolved_at, a.value, a.detail, a.notified, a.acked_at, a.acked_by \
         FROM server_alerts a JOIN servers n ON n.id = a.server_id \
         WHERE ($1::text IS NULL OR a.status = $1) AND ($2::uuid IS NULL OR a.server_id = $2) \
           AND ($3::text IS NULL OR a.kind = $3) AND ($4::bigint IS NULL OR a.id < $4) \
         ORDER BY (a.status = 'firing') DESC, a.id DESC LIMIT $5",
    )
    .bind(&q.status)
    .bind(q.server)
    .bind(&q.kind)
    .bind(q.before)
    .bind(limit)
    .fetch_all(state.pg())
    .await?;
    let firing: Vec<(String, i64)> = sqlx::query_as(
        "SELECT kind, count(*) FROM server_alerts WHERE status = 'firing' GROUP BY kind ORDER BY kind",
    )
    .fetch_all(state.pg())
    .await?;
    let total: i64 = firing.iter().map(|f| f.1).sum();
    Ok(Json(json!({
        "alerts": rows,
        "firing": total,
        "firing_by_kind": firing.into_iter().collect::<std::collections::BTreeMap<_, _>>(),
    })))
}

/// POST /alerts/{id}/ack (admin): mark seen (idempotent; audited once).
pub async fn ack_alert(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, i64)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let row: Option<(Option<DateTime<Utc>>,)> =
        sqlx::query_as("SELECT acked_at FROM server_alerts WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((acked,)) = row else {
        return Err(ApiError::not_found());
    };
    if acked.is_none() {
        sqlx::query("UPDATE server_alerts SET acked_at = now(), acked_by = $2 WHERE id = $1")
            .bind(id)
            .bind(&user.email)
            .execute(&mut *tx)
            .await?;
        crate::audit::record(
            &mut tx,
            &Actor::of(&user),
            "alerts.ack",
            "alert",
            Some(id.to_string()),
            None,
            None,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct NotificationRow {
    id: i64,
    alert_id: Option<i64>,
    channel: String,
    event: String,
    status: String,
    attempts: i32,
    last_error: Option<String>,
    created_at: DateTime<Utc>,
    sent_at: Option<DateTime<Utc>>,
    next_attempt_at: DateTime<Utc>,
    title: Option<String>,
}

/// GET /alerts/notifications (admin): the latest 100 deliveries.
pub async fn list_notifications(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<NotificationRow>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as(
        "SELECT id, alert_id, channel, event, status, attempts, last_error, created_at, sent_at, \
           next_attempt_at, payload->>'title' AS title \
         FROM alert_notifications ORDER BY created_at DESC, id DESC LIMIT 100",
    )
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// POST /alerts/notifications/{id}/retry (admin): a dead delivery goes
/// back to the queue (attempts reset). 409 unless dead.
pub async fn retry_notification(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, i64)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM alert_notifications WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let refusal = match status.as_deref() {
        None => Some(ApiError::not_found()),
        Some("dead") => None,
        Some(_) => Some(conflict!(
            "alert.retry_not_failed",
            "only failed deliveries can be retried"
        )),
    };
    if let Some(e) = refusal {
        // Release the row lock now. A dropped sqlx transaction rolls back
        // lazily (when its connection is next used or returned to the pool),
        // and until then `FOR UPDATE SKIP LOCKED` in `deliver_due` skips the
        // row: a refused retry must not delay deliveries.
        tx.rollback().await?;
        return Err(e);
    }
    sqlx::query(
        "UPDATE alert_notifications SET status = 'pending', attempts = 0, next_attempt_at = now(), \
           claimed_until = NULL, claim = NULL WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    crate::audit::record(
        &mut tx,
        &Actor::of(&user),
        "alerts.notification.retry",
        "alert_notification",
        Some(id.to_string()),
        None,
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Firing alerts by kind (Prometheus scrape; bounded label values).
pub async fn firing_counts(pg: &sqlx::PgPool) -> sqlx::Result<Vec<(String, i64)>> {
    sqlx::query_as("SELECT kind, count(*) FROM server_alerts WHERE status = 'firing' GROUP BY kind")
        .fetch_all(pg)
        .await
}

/// Every instance: evaluate (when it wins the round's lock) and deliver
/// due notifications, every `[alerts].eval_interval_secs`.
pub async fn run(state: AppState) {
    let every = std::time::Duration::from_secs(state.cfg().limits.alerts_eval_interval_secs.max(1));
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let started = std::time::Instant::now();
        let (outcome, error) = match eval::round(&state).await {
            Ok(Some(_)) => {
                crate::metrics::alert_round("leader");
                (crate::sysstatus::Outcome::Ok, None)
            }
            Ok(None) => {
                crate::metrics::alert_round("skipped");
                (crate::sysstatus::Outcome::Skipped, None)
            }
            Err(e) => {
                crate::metrics::alert_round("error");
                tracing::warn!(error = %e, "alert evaluation failed");
                (crate::sysstatus::Outcome::Error, Some(e.to_string()))
            }
        };
        state.sysstatus().record(
            crate::sysstatus::Job::Alerts,
            started,
            outcome,
            error.as_deref(),
        );
        if let Err(e) = channels::deliver_due(&state).await {
            tracing::warn!(error = %e, "alert delivery failed");
        }
    }
}

#[cfg(test)]
mod tests;
