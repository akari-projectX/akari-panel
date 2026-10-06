//! R40 (W24): payment methods — configured instances of a provider kind
//! (`provider.rs`), stored ONLY in the database (`payment_methods`,
//! migration 0140; no panel.toml).
//!
//! - **Secrets** (e.g. the Alipay app private key) are one JSON object
//!   sealed with AES-256-GCM under a key derived from data/master.key (label
//!   `akari/payment-secrets-aead/v1`), AAD = the method id
//!   (`masterkey::Keys::seal_payment_secrets`). The API never returns them (the
//!   kind's `view` shows `<field>_set` and fingerprints); the audit log
//!   records them as `"changed"`.
//! - **Writes** go through `apply_create` / `apply_update` / `apply_delete`
//!   (optimistic concurrency on `version`, audit `payment_method.*` in the
//!   same transaction). Enabling requires a complete configuration that
//!   builds.
//! - **Reload**: the 0060 trigger function notifies every instance
//!   (`settings`); `settings::reload` calls `reload` here, which rebuilds
//!   the clients of changed rows and swaps the whole set atomically
//!   (`AppState::payments`). A call in flight keeps the client it took.
//!   Orders never store keys: pending orders keep working across a key
//!   change.
//! - **Obsolete panel.toml `[payments.alipay]`**: imported ONCE into an
//!   Alipay method while no method exists (`import_legacy`, actor
//!   `system`), which also becomes the method of the pre-0140 orders;
//!   otherwise ignored with a startup warning.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use super::provider::{self, PaymentProvider, ProviderKind};
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::state::AppState;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Row {
    pub id: Uuid,
    pub kind: String,
    pub display_name: String,
    pub icon: Option<String>,
    pub sort: i32,
    pub enabled: bool,
    pub version: i64,
    pub config: Value,
    pub secrets_enc: Option<Vec<u8>>,
}

const COLS: &str = "id, kind, display_name, icon, sort, enabled, version, config, secrets_enc";

pub async fn load_all(conn: &mut PgConnection) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM payment_methods ORDER BY sort, created_at, id"
    )))
    .fetch_all(conn)
    .await
}

async fn load_one(conn: &mut PgConnection, id: Uuid, lock: bool) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM payment_methods WHERE id = $1{}",
        if lock { " FOR UPDATE" } else { "" }
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
}

/// Stored secrets that cannot be opened (data/master.key changed, or the
/// blob was moved/altered).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unreadable;

/// The secrets of a row: Ok(None) = none stored.
pub fn open_secrets(keys: &crate::masterkey::Keys, row: &Row) -> Result<Option<Value>, Unreadable> {
    let Some(blob) = &row.secrets_enc else {
        return Ok(None);
    };
    let plain = keys.open_payment_secrets(row.id, blob).ok_or(Unreadable)?;
    serde_json::from_slice(&plain)
        .map(Some)
        .map_err(|_| Unreadable)
}

fn kind_of(id: &str) -> Result<&'static dyn ProviderKind, ApiError> {
    provider::kind(id).ok_or_else(|| {
        bad_request!(
            "payments.kind_unknown",
            "unknown payment method kind: {kind}",
            kind = id.chars().take(32).collect::<String>()
        )
    })
}

/// Build the client of a stored row (enabled or not).
pub fn build(keys: &crate::masterkey::Keys, row: &Row) -> Result<Arc<dyn PaymentProvider>, String> {
    let kind = provider::kind(&row.kind).ok_or("unknown kind")?;
    let secrets = open_secrets(keys, row)
        .map_err(|_| "the stored secrets cannot be opened (data/master.key changed?)".to_string())?
        .ok_or("no secrets stored")?;
    kind.build(&row.config, &secrets)
}

// ---------------------------------------------------------------------------
// Live (per instance)
// ---------------------------------------------------------------------------

/// One method as this instance serves it.
#[derive(Debug)]
pub struct LiveMethod {
    pub id: Uuid,
    pub kind: &'static str,
    pub display_name: String,
    pub icon: Option<String>,
    pub sort: i32,
    pub enabled: bool,
    pub version: i64,
    /// Built client (enabled and usable); None = disabled or broken.
    pub provider: Option<Arc<dyn PaymentProvider>>,
}

/// Every method of this instance (atomic snapshot).
#[derive(Debug, Default)]
pub struct Live {
    pub methods: Vec<Arc<LiveMethod>>,
}

impl Live {
    /// Methods a payer may choose now (enabled, client built), in order.
    pub fn usable(&self) -> impl Iterator<Item = &Arc<LiveMethod>> {
        self.methods.iter().filter(|m| m.provider.is_some())
    }
    /// The client of a usable method.
    pub fn provider(&self, id: Uuid) -> Option<Arc<dyn PaymentProvider>> {
        self.methods
            .iter()
            .find(|m| m.id == id)
            .and_then(|m| m.provider.clone())
    }
    pub fn any_usable(&self) -> bool {
        self.usable().next().is_some()
    }
}

/// Re-read the methods; rebuild the clients of rows whose version changed;
/// swap the set (called by `settings::reload`, serialized).
pub async fn reload(state: &AppState) -> anyhow::Result<()> {
    let mut c = state.pg().acquire().await?;
    let rows = load_all(&mut c).await?;
    drop(c);
    let cur = state.payments();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        if let Some(m) = cur
            .methods
            .iter()
            .find(|m| m.id == row.id && m.version == row.version)
        {
            out.push(m.clone());
            continue;
        }
        let Some(kind) = provider::kind(&row.kind) else {
            continue;
        };
        let provider = if row.enabled {
            match build(state.master_key(), &row) {
                Ok(p) => Some(p),
                Err(e) => {
                    tracing::error!(method = %row.id, error = %e, "payment method unusable");
                    None
                }
            }
        } else {
            None
        };
        tracing::info!(method = %row.id, kind = kind.id(), version = row.version,
            usable = provider.is_some(), "payment method loaded");
        out.push(Arc::new(LiveMethod {
            id: row.id,
            kind: kind.id(),
            display_name: row.display_name,
            icon: row.icon,
            sort: row.sort,
            enabled: row.enabled,
            version: row.version,
            provider,
        }));
    }
    state.swap_payments(Live { methods: out });
    Ok(())
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/// The common (kind-independent) fields of a method form.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MethodReq {
    /// Create only.
    #[serde(default)]
    pub kind: Option<String>,
    /// Update only.
    #[serde(default)]
    pub version: Option<i64>,
    pub display_name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub sort: i32,
    #[serde(default)]
    pub enabled: bool,
    /// Kind-specific; secret fields absent/null = keep.
    #[serde(default)]
    pub config: Value,
}

/// Validate the common fields (pure).
pub fn common(req: &MethodReq) -> Result<(String, Option<String>), ApiError> {
    let name = req.display_name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(bad_request!(
            "payments.name_invalid",
            "display_name must be 1-64 characters without control characters"
        ));
    }
    let icon = req.icon.as_deref().map(str::trim).filter(|i| !i.is_empty());
    if icon.is_some_and(|i| {
        i.len() > 32
            || !i
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    }) {
        return Err(bad_request!(
            "payments.icon_invalid",
            "icon must be 1-32 of a-z 0-9 - _"
        ));
    }
    if !(-1_000_000..=1_000_000).contains(&req.sort) {
        return Err(bad_request!(
            "payments.sort_range",
            "sort must be within ±1000000"
        ));
    }
    Ok((name.to_string(), icon.map(str::to_string)))
}

fn snapshot(row: &Row) -> Value {
    json!({
        "kind": row.kind, "display_name": row.display_name, "icon": row.icon,
        "sort": row.sort, "enabled": row.enabled, "config": row.config,
        "secrets_set": row.secrets_enc.is_some(),
    })
}

fn seal(keys: &crate::masterkey::Keys, id: Uuid, secrets: &Value) -> Result<Vec<u8>, ApiError> {
    keys.seal_payment_secrets(id, secrets.to_string().as_bytes())
        .map_err(|e| {
            tracing::error!(error = %e, "sealing payment secrets failed");
            ApiError::internal()
        })
}

fn incomplete() -> ApiError {
    conflict!(
        "payments.incomplete",
        "the configuration is incomplete: fill every required field before enabling"
    )
}

/// The audit "after" with the replaced secret fields as "changed".
fn after_of(row: &Row, changed: &[&str]) -> Value {
    let mut a = snapshot(row);
    if !changed.is_empty() {
        a["secrets"] = Value::Object(
            changed
                .iter()
                .map(|k| (k.to_string(), json!(crate::audit::CHANGED)))
                .collect(),
        );
    }
    a
}

#[allow(clippy::too_many_arguments)]
async fn write_row(
    conn: &mut PgConnection,
    insert: bool,
    id: Uuid,
    kind: &str,
    name: &str,
    icon: &Option<String>,
    sort: i32,
    enabled: bool,
    config: &Value,
    enc: &[u8],
) -> sqlx::Result<Row> {
    let sql = if insert {
        format!(
            "INSERT INTO payment_methods (id, kind, display_name, icon, sort, enabled, config, \
             secrets_enc) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {COLS}"
        )
    } else {
        format!(
            "UPDATE payment_methods SET display_name = $3, icon = $4, sort = $5, enabled = $6, \
             config = $7, secrets_enc = $8, version = version + 1, updated_at = now() \
             WHERE id = $1 AND kind = $2 RETURNING {COLS}"
        )
    };
    sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(kind)
        .bind(name)
        .bind(icon)
        .bind(sort)
        .bind(enabled)
        .bind(config)
        .bind(enc)
        .fetch_one(conn)
        .await
}

/// Create a method (audited `payment_method.create`, or `action`).
pub async fn apply_create(
    conn: &mut PgConnection,
    keys: &crate::masterkey::Keys,
    actor: &Actor,
    action: &str,
    req: &MethodReq,
) -> Result<Row, ApiError> {
    // R47: payment channels and their keys are the owner's.
    crate::owner::require(conn, actor).await?;
    let kind = kind_of(req.kind.as_deref().unwrap_or_default())?;
    let (name, icon) = common(req)?;
    let v = kind.validate(&req.config, None, req.enabled)?;
    if req.enabled {
        kind.build(&v.config, &v.secrets)
            .map_err(|_| incomplete())?;
    }
    let id = Uuid::new_v4();
    let enc = seal(keys, id, &v.secrets)?;
    let row = write_row(
        conn,
        true,
        id,
        kind.id(),
        &name,
        &icon,
        req.sort,
        req.enabled,
        &v.config,
        &enc,
    )
    .await?;
    crate::audit::record(
        conn,
        actor,
        action,
        "payment_method",
        Some(id.to_string()),
        None,
        Some(after_of(&row, &v.changed_secrets)),
    )
    .await?;
    Ok(row)
}

fn not_found() -> ApiError {
    ApiError::not_found()
}

/// Update a method (optimistic: `req.version` must be current, else 409).
/// Audited `payment_method.update`.
pub async fn apply_update(
    conn: &mut PgConnection,
    keys: &crate::masterkey::Keys,
    actor: &Actor,
    id: Uuid,
    req: &MethodReq,
) -> Result<Row, ApiError> {
    let (name, icon) = common(req)?;
    let cur = load_one(conn, id, true).await?.ok_or_else(not_found)?;
    if Some(cur.version) != req.version {
        return Err(conflict!(
            "settings.version_conflict",
            "设置已被修改（可能是其他管理员），请刷新后重试"
        ));
    }
    let kind = kind_of(&cur.kind)?;
    let prev_secrets = open_secrets(keys, &cur)
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({}));
    let v = kind.validate(&req.config, Some((&cur.config, &prev_secrets)), req.enabled)?;
    // R47: the channel's keys and account (configuration) are the owner's;
    // any admin may rename, sort, enable or disable it.
    if !v.changed_secrets.is_empty() || v.config != cur.config {
        crate::owner::require(conn, actor).await?;
    }
    if req.enabled {
        kind.build(&v.config, &v.secrets)
            .map_err(|_| incomplete())?;
    }
    let enc = seal(keys, id, &v.secrets)?;
    let row = write_row(
        conn,
        false,
        id,
        kind.id(),
        &name,
        &icon,
        req.sort,
        req.enabled,
        &v.config,
        &enc,
    )
    .await?;
    crate::audit::record(
        conn,
        actor,
        "payment_method.update",
        "payment_method",
        Some(id.to_string()),
        Some(snapshot(&cur)),
        Some(after_of(&row, &v.changed_secrets)),
    )
    .await?;
    Ok(row)
}

/// Delete a method that no order references (409 otherwise: disable it).
/// Audited `payment_method.delete`.
pub async fn apply_delete(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<(), ApiError> {
    crate::owner::require(conn, actor).await?;
    let cur = load_one(conn, id, true).await?.ok_or_else(not_found)?;
    let used: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM orders WHERE payment_method_id = $1)")
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;
    if used {
        return Err(conflict!(
            "payments.method_in_use",
            "orders use this payment method; disable it instead"
        ));
    }
    sqlx::query("DELETE FROM payment_methods WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "payment_method.delete",
        "payment_method",
        Some(id.to_string()),
        Some(snapshot(&cur)),
        None,
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// API (admin, 系统设置 → 支付)
// ---------------------------------------------------------------------------

/// The notify URL of a method: `<main domain>/<prefix>/pay/<id>/notify`
/// (None = no main domain: orders are refused). Contains the route prefix.
pub fn notify_url(state: &AppState, method: Uuid) -> Option<String> {
    let origin = state.settings().get().public_origin()?;
    Some(format!(
        "{origin}/{}/pay/{method}/notify",
        state.route_prefix()
    ))
}

#[derive(Debug, Serialize)]
pub struct MethodView {
    pub id: Uuid,
    pub kind: String,
    pub kind_label: &'static str,
    pub display_name: String,
    pub icon: Option<String>,
    pub sort: i32,
    pub enabled: bool,
    pub version: i64,
    /// The kind's view: non-secret fields, `<secret>_set`, fingerprints.
    pub config: Value,
    pub notify_url: Option<String>,
    /// This instance serves it now.
    pub active: bool,
    pub warnings: Vec<String>,
}

pub fn method_view(state: &AppState, row: &Row) -> MethodView {
    let kind = provider::kind(&row.kind);
    let secrets = open_secrets(state.master_key(), row);
    let mut warnings = Vec::new();
    if secrets.is_err() {
        warnings
            .push("已保存的密钥无法解密（data/master.key 已更换？）：请重新粘贴密钥".to_string());
    }
    let notify_url = notify_url(state, row.id);
    if row.enabled && notify_url.is_none() {
        warnings.push(
            "未设置主域名：异步通知地址由主域名生成，设置主域名（系统设置 → 站点）之前无法创建订单"
                .to_string(),
        );
    }
    let config = kind
        .map(|k| k.view(&row.config, secrets.as_ref().ok().and_then(|s| s.as_ref())))
        .unwrap_or(Value::Null);
    if config["environment"] == "sandbox" && row.enabled {
        warnings.push("沙箱环境：用户付款不会产生真实资金".to_string());
    }
    let active = state.payments().provider(row.id).is_some();
    if row.enabled && !active && secrets.is_ok() {
        warnings.push("已启用但当前实例无法使用该支付方式（配置不完整？）".to_string());
    }
    MethodView {
        id: row.id,
        kind: row.kind.clone(),
        kind_label: kind.map_or("未知", |k| k.label()),
        display_name: row.display_name.clone(),
        icon: row.icon.clone(),
        sort: row.sort,
        enabled: row.enabled,
        version: row.version,
        config,
        notify_url,
        active,
        warnings,
    }
}

/// GET /api/v1/settings/payments (admin): kinds (form schemas) + methods.
pub async fn list(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    let rows = load_all(&mut c).await?;
    let mut warnings = Vec::new();
    if state.cfg().legacy.keys.contains_key("payments.*") {
        warnings.push(
            "panel.toml 中仍有已废弃的 [payments] 段：支付配置只以本页为准，请删除该段与密钥文件"
                .to_string(),
        );
    }
    Ok(Json(json!({
        "kinds": provider::KINDS.iter().map(|k| json!({
            "id": k.id(), "label": k.label(), "schema": k.schema(),
        })).collect::<Vec<_>>(),
        "methods": rows.iter().map(|r| method_view(&state, r)).collect::<Vec<_>>(),
        "warnings": warnings,
    })))
}

async fn after_write(state: &AppState) {
    // This instance at once (the others on the notification).
    if let Err(e) = crate::settings::reload(state).await {
        tracing::warn!(error = %e, "settings reload failed");
    }
}

/// POST /api/v1/settings/payments (admin): add a method.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<MethodReq>,
) -> Result<(StatusCode, Json<MethodView>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let row = apply_create(
        &mut tx,
        state.master_key(),
        &Actor::of(&user),
        "payment_method.create",
        &req,
    )
    .await?;
    tx.commit().await?;
    after_write(&state).await;
    Ok((StatusCode::CREATED, Json(method_view(&state, &row))))
}

/// PUT /api/v1/settings/payments/{id} (admin).
pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<MethodReq>,
) -> Result<Json<MethodView>, ApiError> {
    user.require_admin()?;
    if req.kind.is_some() {
        return Err(bad_request!(
            "payments.kind_immutable",
            "the kind of a method cannot change; add a new method"
        ));
    }
    let mut tx = state.pg().begin().await?;
    let row = apply_update(&mut tx, state.master_key(), &Actor::of(&user), id, &req).await?;
    tx.commit().await?;
    after_write(&state).await;
    Ok(Json(method_view(&state, &row)))
}

/// DELETE /api/v1/settings/payments/{id} (admin): only unused methods.
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_delete(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    after_write(&state).await;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/settings/payments/{id}/test (admin): 测试连接 with the
/// SAVED configuration (enabled or not).
pub async fn test(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<provider::TestOutcome>, ApiError> {
    user.require_admin()?;
    let ok = crate::rate::hit(&state, format!("akari:rl:paytest:{}", user.id), 10, 60)
        .await
        .unwrap_or(true);
    if !ok {
        return Err(ApiError::too_many());
    }
    let mut c = state.pg().acquire().await?;
    let row = load_one(&mut c, id, false).await?.ok_or_else(not_found)?;
    drop(c);
    if open_secrets(state.master_key(), &row).is_err() {
        return Err(conflict!(
            "payments.stored_key_unreadable",
            "the stored secrets cannot be opened (data/master.key changed); paste them again"
        ));
    }
    let client = build(state.master_key(), &row).map_err(|_| {
        conflict!(
            "payments.not_configured",
            "save a complete configuration first"
        )
    })?;
    Ok(Json(client.test_connection().await))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post, put};
    axum::Router::new()
        .route("/{prefix}/api/v1/settings/payments", get(list).post(create))
        .route(
            "/{prefix}/api/v1/settings/payments/{id}",
            put(update).delete(delete),
        )
        .route("/{prefix}/api/v1/settings/payments/{id}/test", post(test))
}

// ---------------------------------------------------------------------------
// Obsolete panel.toml [payments.alipay]: one-time import
// ---------------------------------------------------------------------------

/// The obsolete section, parsed leniently (unknown keys ignored) — used
/// only by the import.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct LegacyPayments {
    pub alipay: LegacyAlipay,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct LegacyAlipay {
    pub enabled: bool,
    pub app_id: String,
    pub seller_id: String,
    pub app_private_key_file: std::path::PathBuf,
    pub alipay_public_key_file: std::path::PathBuf,
    pub gateway_url: String,
    pub order_timeout_minutes: Option<i64>,
}

/// The method form of the legacy section (reads the two key files).
pub fn legacy_request(l: &LegacyAlipay) -> Result<MethodReq, String> {
    use super::alipay::{GATEWAY_PRODUCTION, GATEWAY_SANDBOX, gateway_ok};
    let (environment, gateway_url) = match l.gateway_url.trim() {
        "" | GATEWAY_PRODUCTION => ("production", None),
        GATEWAY_SANDBOX => ("sandbox", None),
        other if gateway_ok(other) => ("custom", Some(other.to_string())),
        _ => return Err("gateway_url is not usable".into()),
    };
    let read = |p: &std::path::Path, what: &str| {
        std::fs::read_to_string(p).map_err(|e| format!("{what} {}: {e}", p.display()))
    };
    let private = read(&l.app_private_key_file, "app_private_key_file")?;
    let public = read(&l.alipay_public_key_file, "alipay_public_key_file")?;
    Ok(MethodReq {
        kind: Some(super::alipay::KIND.into()),
        version: None,
        display_name: "支付宝".into(),
        icon: Some("alipay".into()),
        sort: 0,
        enabled: l.enabled,
        config: json!({
            "environment": environment,
            "gateway_url": gateway_url,
            "app_id": l.app_id,
            "seller_id": l.seller_id,
            "app_private_key": private,
            "alipay_public_key": public,
            "order_timeout_minutes": l.order_timeout_minutes.unwrap_or(15).clamp(5, 120),
        }),
    })
}

/// Startup: an obsolete `[payments]` section is imported once while no
/// method exists (one transaction, table lock: concurrent instances import
/// once), audited `payment_method.import` as actor `system`; the imported
/// method becomes the method of every pre-0140 order. Afterwards (or when
/// it cannot be imported) the section is ignored with a warning. Never
/// fails the start.
pub async fn import_legacy(state: &AppState) {
    let Some(raw) = state.cfg().legacy.keys.get("payments.*").cloned() else {
        return;
    };
    let legacy: LegacyPayments = match raw.try_into() {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!(error = %e, "panel.toml [payments] is obsolete and unreadable: ignored; delete it");
            return;
        }
    };
    let r = async {
        let mut tx = state.pg().begin().await?;
        sqlx::query("LOCK TABLE payment_methods IN SHARE ROW EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await?;
        let any: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM payment_methods)")
            .fetch_one(&mut *tx)
            .await?;
        if any || legacy.alipay.app_id.is_empty() {
            return anyhow::Ok(false);
        }
        let req = legacy_request(&legacy.alipay).map_err(anyhow::Error::msg)?;
        let row = apply_create(
            &mut tx,
            state.master_key(),
            &Actor::system(),
            "payment_method.import",
            &req,
        )
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message()))?;
        // Orders created before 0140 were Alipay orders of this merchant.
        sqlx::query(
            "UPDATE orders SET payment_method_id = $1 \
             WHERE payment_method_id IS NULL AND amount_cents > 0",
        )
        .bind(row.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        anyhow::Ok(true)
    };
    match r.await {
        Ok(true) => tracing::warn!(
            "panel.toml [payments.alipay] imported into 系统设置 → 支付 as a payment method; the \
             section is obsolete and now ignored: delete it and the key files"
        ),
        Ok(false) => tracing::warn!(
            "panel.toml [payments] is obsolete and ignored (系统设置 → 支付 is the only \
             configuration): delete it"
        ),
        Err(e) => tracing::warn!(
            error = %e,
            "panel.toml [payments.alipay] could not be imported and is ignored: configure \
             系统设置 → 支付, then delete the section"
        ),
    }
}

/// `config check`: the database side of payments (TOML comments).
pub struct Described {
    pub enabled: bool,
    pub text: String,
}

pub async fn describe(conn: &mut PgConnection) -> sqlx::Result<Described> {
    let rows = load_all(conn).await?;
    let mut text = String::from("# --- 系统设置 → 支付 (database only) ---\n");
    if rows.is_empty() {
        text.push_str("# (no payment methods)\n");
    }
    for r in &rows {
        text.push_str(&format!(
            "# payment method {} kind={} enabled={} name={:?} secrets=<redacted{}>\n",
            r.id,
            r.kind,
            r.enabled,
            r.display_name,
            if r.secrets_enc.is_some() {
                ", set"
            } else {
                ", not set"
            },
        ));
    }
    Ok(Described {
        enabled: rows.iter().any(|r| r.enabled),
        text,
    })
}
