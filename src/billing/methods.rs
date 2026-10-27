//! R40 (W24): payment methods — configured instances of a provider kind
//! (`provider.rs`), stored ONLY in the database (`payment_methods`;
//! no panel.toml).
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
//! - **Reload**: the trigger function notifies every instance
//!   (`settings`); `settings::reload` calls `reload` here, which rebuilds
//!   the clients of changed rows and swaps the whole set atomically
//!   (`AppState::payments`). A call in flight keeps the client it took.
//!   Orders never store keys: pending orders keep working across a key
//!   change.

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
            // The portal icon: the operator's, else the kind's (EPay: its
            // channel).
            icon: row
                .icon
                .or_else(|| kind.default_icon(&row.config).map(str::to_string)),
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
) -> Result<Row, ApiError> {
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
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(kind)
        .bind(name)
        .bind(icon)
        .bind(sort)
        .bind(enabled)
        .bind(config)
        .bind(enc)
        .fetch_one(conn)
        .await?)
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

/// The notify URL of a method: `<main domain>/pay/<id>/notify` (None = no
/// main domain: orders are refused). No prefix (D4/D11): the signature is
/// the gate, and Alipay never learns the admin prefix.
pub fn notify_url(state: &AppState, method: Uuid) -> Option<String> {
    let origin = state.settings().get().public_origin()?;
    Some(format!("{origin}/pay/{method}/notify"))
}

/// Where a provider sends the payer back (EPay `return_url`): the portal's
/// page of the order (`portal/src/lib/routes.ts` `R.order`). It only shows
/// the order, which polls its status; nothing is marked paid there.
pub fn return_url(state: &AppState, order: Uuid) -> Option<String> {
    let origin = state.settings().get().public_origin()?;
    Some(format!("{origin}/orders/{order}"))
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
    let usage: Vec<(Uuid, i64, i64, bool)> = sqlx::query_as(USAGE_SQL)
        .bind(rows.iter().map(|r| r.id).collect::<Vec<_>>())
        .fetch_all(&mut *c)
        .await?;
    let methods = rows
        .iter()
        .map(|r| {
            let mut v = serde_json::to_value(method_view(&state, r)).unwrap_or(Value::Null);
            let (cents, count, used) = usage
                .iter()
                .find(|u| u.0 == r.id)
                .map(|u| (u.1, u.2, u.3))
                .unwrap_or((0, 0, false));
            if let Value::Object(m) = &mut v {
                m.insert("month_cents".into(), json!(cents));
                m.insert("month_count".into(), json!(count));
                m.insert("used".into(), json!(used));
            }
            v
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "kinds": provider::KINDS.iter().map(|k| json!({
            "id": k.id(), "label": k.label(), "schema": k.schema(),
        })).collect::<Vec<_>>(),
        "methods": methods,
    })))
}

/// Per method: channel money collected this site-calendar month (paid
/// orders' `amount_cents` by `paid_at`, refunds not deducted; one range
/// over `orders_paid_at` for the month, like the dashboard's windows), how
/// many such orders, and whether any order ever used it (one index probe
/// each on `orders_payment_method`; a used method cannot be deleted).
const USAGE_SQL: &str = "WITH b AS (SELECT date_trunc('month', akari_site_day(now()))::timestamp \
     AT TIME ZONE akari_site_tz() AS m), \
     month AS (SELECT o.payment_method_id AS id, sum(o.amount_cents)::bigint AS cents, \
       count(*) AS n FROM orders o, b WHERE o.status = 'paid' AND o.paid_at >= b.m \
       AND o.payment_method_id IS NOT NULL GROUP BY 1) \
     SELECT pm.id, coalesce(month.cents, 0)::bigint, coalesce(month.n, 0)::bigint, \
     EXISTS (SELECT 1 FROM orders o WHERE o.payment_method_id = pm.id) \
     FROM unnest($1::uuid[]) AS pm(id) LEFT JOIN month ON month.id = pm.id";

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
