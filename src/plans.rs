//! M3 operations model: node groups, plans, user plans (admin API), the
//! user's own plan view, and the periodic plan passes (traffic period reset,
//! plan expiry).
//!
//! Every mutation is an `apply_*` on the caller's transaction that takes
//! the entitlement lock first (entitle.rs), writes, reconciles
//! `entrance_users` (bumping exactly the nodes whose rows changed), syncs the users'
//! enforced columns from their plan (`traffic_limit_bytes`, `expires_at`)
//! and bumps the users' nodes when what they are served changed, and writes
//! its audit row — all in that transaction.
//!
//! Semantics:
//! - One active plan per user (partial unique index). Assigning a plan
//!   replaces the active one (status `replaced`); cancelling ends it
//!   (`cancelled`) and removes plan access; the expiry pass ends it at
//!   `expires_at` (`expired`). Admin accounts cannot have plans.
//! - With an active plan, `users.traffic_limit_bytes` = the plan quota and
//!   `users.expires_at` = the user plan's expiry (PATCH /users refuses to
//!   edit them, 409). Cancel/expiry leave both as they were.
//! - Users disabled for quota (`disabled_reason = 'quota'`) are re-enabled
//!   when a plan change leaves them within the (new) quota, and by the
//!   period reset. Admin-disabled users never are.
//! - `speed_limit_mbps` is enforced per user by the agent (protocol 4,
//!   `UserOp.speed_limit_bytes_per_sec`, both directions, shared by all of
//!   the user's connections on a node). Every change of a user's effective
//!   limit (plan edit, plan change, cancel, expiry) bumps the user's nodes
//!   in the same transaction. `device_seats` is stored for the client's
//!   seat binding (R25) and not enforced.
//! - W7 catalogue fields (description, on_sale, capacity, renewal_only,
//!   allow_switch_in) and the prices (`plan_period_prices`) are sale rules
//!   used by `billing/`; admin assignment ignores them.

use crate::auth::{bad_request, conflict};
use axum::Json;
use axum::extract::{Path, State};
use chrono::{DateTime, FixedOffset, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::{ApiJson, double_option, non_null};
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::billing::catalog::{PeriodKind, PeriodKindText};
use crate::entitle::{self, Outcome, Scope};
use crate::state::AppState;

const MAX_NAME: usize = 64;
const MAX_DESCRIPTION: usize = 500;
/// Plan descriptions (Markdown-lite text on the purchase page).
const MAX_PLAN_DESCRIPTION: usize = 4000;
/// Upper bound of `days-N` periods (10 years).
const MAX_PERIOD_DAYS: i32 = 3650;
/// Rows handled per periodic pass (the rest next tick).
const PASS_BATCH: i64 = 500;

fn clean_name(field: &str, name: &str) -> Result<String, ApiError> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > MAX_NAME {
        return Err(bad_request!(
            "plan.name_length",
            "{field} must be 1-{max_name} characters",
            field = field,
            max_name = MAX_NAME
        ));
    }
    Ok(n.to_string())
}

fn clean_description(d: &str) -> Result<String, ApiError> {
    if d.chars().count() > MAX_DESCRIPTION {
        return Err(bad_request!(
            "group.description_long",
            "description must be at most {max_description} characters",
            max_description = MAX_DESCRIPTION
        ));
    }
    Ok(d.trim().to_string())
}

/// A plan description: Markdown-lite plain text (rendered as text nodes by
/// the SPA, never as HTML). Control characters other than newlines/tabs are
/// refused; CRLF is normalised.
fn clean_plan_description(d: &str) -> Result<String, ApiError> {
    let d = d.replace("\r\n", "\n");
    if d.chars().count() > MAX_PLAN_DESCRIPTION {
        return Err(bad_request!(
            "plan.description_long",
            "description must be at most {max_plan_description} characters",
            max_plan_description = MAX_PLAN_DESCRIPTION
        ));
    }
    if d.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(bad_request!(
            "plan.description_control",
            "description must not contain control characters"
        ));
    }
    Ok(d.trim().to_string())
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.is_unique_violation())
}

/// Sorted, de-duplicated ids.
fn id_set(ids: &[Uuid]) -> Vec<Uuid> {
    let mut v = ids.to_vec();
    v.sort();
    v.dedup();
    v
}

/// 400 unless every id exists in `table` (a code constant).
async fn require_all_exist(
    conn: &mut PgConnection,
    table: &'static str,
    what: &str,
    ids: &[Uuid],
) -> Result<(), ApiError> {
    let found: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM {table} WHERE id = ANY($1)"
    )))
    .bind(ids)
    .fetch_one(conn)
    .await?;
    if found != ids.len() as i64 {
        return Err(bad_request!(
            "plan.unknown_ref",
            "unknown {what} id",
            what = what
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reset period
// ---------------------------------------------------------------------------

/// A plan's traffic reset period: "monthly", "days-N" or "none".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Period {
    Monthly,
    Days(i32),
    None,
}

impl Period {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "monthly" => Some(Self::Monthly),
            "none" => Some(Self::None),
            _ => {
                let n = s.strip_prefix("days-")?;
                if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) || n.starts_with('0') {
                    return None;
                }
                let d: i32 = n.parse().ok()?;
                (1..=MAX_PERIOD_DAYS).contains(&d).then_some(Self::Days(d))
            }
        }
    }

    pub fn from_columns(kind: &str, days: Option<i32>) -> Self {
        match (kind, days) {
            ("monthly", _) => Self::Monthly,
            ("days", Some(d)) => Self::Days(d),
            _ => Self::None,
        }
    }

    /// (reset_period, reset_days) columns.
    fn columns(self) -> (&'static str, Option<i32>) {
        match self {
            Self::Monthly => ("monthly", None),
            Self::Days(d) => ("days", Some(d)),
            Self::None => ("none", None),
        }
    }

    pub fn render(self) -> String {
        match self {
            Self::Monthly => "monthly".into(),
            Self::Days(d) => format!("days-{d}"),
            Self::None => "none".into(),
        }
    }
}

fn parse_period(s: &str) -> Result<Period, ApiError> {
    Period::parse(s).ok_or_else(|| {
        bad_request!(
            "plan.period_invalid",
            "period must be \"monthly\", \"none\" or \"days-N\" (N = 1..{max_period_days})",
            max_period_days = MAX_PERIOD_DAYS
        )
    })
}

// ---------------------------------------------------------------------------
// Node groups
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct GroupView {
    id: Uuid,
    name: String,
    description: String,
    /// W28-a: groups hold entrances (plans -> node groups -> entrances).
    entrance_ids: Vec<Uuid>,
    /// Plans granting this group.
    plan_ids: Vec<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const GROUP_VIEW_SQL: &str = "SELECT g.id, g.name, g.description, \
     ARRAY(SELECT m.entrance_id FROM entrance_group_members m WHERE m.group_id = g.id \
        ORDER BY m.entrance_id) AS entrance_ids, \
     ARRAY(SELECT pg.plan_id FROM plan_groups pg WHERE pg.group_id = g.id ORDER BY pg.plan_id) \
     AS plan_ids, g.created_at, g.updated_at FROM node_groups g";

async fn group_view(conn: &mut PgConnection, id: Uuid) -> Result<GroupView, ApiError> {
    sqlx::query_as::<_, GroupView>(sqlx::AssertSqlSafe(format!(
        "{GROUP_VIEW_SQL} WHERE g.id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or_else(ApiError::not_found)
}

pub async fn list_groups(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<GroupView>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, GroupView>(sqlx::AssertSqlSafe(format!(
        "{GROUP_VIEW_SQL} ORDER BY g.name"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateGroupReq {
    pub name: String,
    pub description: Option<String>,
    pub entrance_ids: Option<Vec<Uuid>>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct UpdateGroupReq {
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    /// The complete membership (replaces it).
    #[serde(default, deserialize_with = "double_option")]
    pub entrance_ids: Option<Option<Vec<Uuid>>>,
}

async fn group_members(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar(
        "SELECT entrance_id FROM entrance_group_members WHERE group_id = $1 ORDER BY entrance_id",
    )
    .bind(id)
    .fetch_all(conn)
    .await
}

/// Lock the nodes of these entrances (global order: nodes by id).
async fn lock_nodes_of(conn: &mut PgConnection, entrances: &[Uuid]) -> sqlx::Result<()> {
    sqlx::query(
        "SELECT id FROM nodes WHERE id IN (SELECT node_id FROM entrances WHERE id = ANY($1)) \
         ORDER BY id FOR UPDATE",
    )
    .bind(entrances)
    .execute(conn)
    .await?;
    Ok(())
}

/// POST /node-groups. A new group is in no plan: nothing to reconcile.
pub async fn apply_create_group(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &CreateGroupReq,
) -> Result<Uuid, ApiError> {
    let name = clean_name("name", &req.name)?;
    let description = clean_description(req.description.as_deref().unwrap_or(""))?;
    let entrances = id_set(req.entrance_ids.as_deref().unwrap_or(&[]));
    entitle::lock(conn).await?;
    lock_nodes_of(conn, &entrances).await?;
    require_all_exist(conn, "entrances", "entrance", &entrances).await?;
    let id = Uuid::new_v4();
    let r = sqlx::query("INSERT INTO node_groups (id, name, description) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(&name)
        .bind(&description)
        .execute(&mut *conn)
        .await;
    match r {
        Err(e) if is_unique_violation(&e) => {
            return Err(conflict!("group.name_exists", "group name already exists"));
        }
        r => r?,
    };
    sqlx::query(
        "INSERT INTO entrance_group_members (group_id, entrance_id) SELECT $1, unnest($2::uuid[])",
    )
    .bind(id)
    .bind(&entrances)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "group.create",
        "node_group",
        Some(id.to_string()),
        None,
        Some(json!({ "name": name, "description": description, "entrance_ids": entrances })),
    )
    .await?;
    Ok(id)
}

/// PATCH /node-groups/{id}. A membership change reconciles exactly the
/// entrances that joined or left.
pub async fn apply_update_group(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &UpdateGroupReq,
) -> Result<Outcome, ApiError> {
    let name = non_null("name", &req.name)?
        .map(|n| clean_name("name", &n))
        .transpose()?;
    let description = match &req.description {
        None => None,
        Some(d) => Some(clean_description(d.as_deref().unwrap_or(""))?),
    };
    let entrances = non_null("entrance_ids", &req.entrance_ids)?.map(|n| id_set(&n));
    if name.is_none() && description.is_none() && entrances.is_none() {
        return Err(bad_request!("request.no_fields", "no fields to update"));
    }
    entitle::lock(conn).await?;
    let before: Option<(String, String)> =
        sqlx::query_as("SELECT name, description FROM node_groups WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((old_name, old_desc)) = before else {
        return Err(ApiError::not_found());
    };
    let old_entrances = group_members(conn, id).await?;
    let mut outcome = Outcome::default();
    if let Some(new) = &entrances {
        let changed: Vec<Uuid> = id_set(
            &old_entrances
                .iter()
                .filter(|e| !new.contains(e))
                .chain(new.iter().filter(|e| !old_entrances.contains(e)))
                .copied()
                .collect::<Vec<_>>(),
        );
        lock_nodes_of(conn, &changed).await?;
        require_all_exist(conn, "entrances", "entrance", new).await?;
        sqlx::query(
            "DELETE FROM entrance_group_members WHERE group_id = $1 AND NOT entrance_id = ANY($2)",
        )
        .bind(id)
        .bind(new)
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            "INSERT INTO entrance_group_members (group_id, entrance_id) \
             SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(new)
        .execute(&mut *conn)
        .await?;
        outcome = entitle::apply_reconcile(conn, Scope::Entrances(&changed)).await?;
    }
    let new_name = name.clone().unwrap_or_else(|| old_name.clone());
    let new_desc = description.clone().unwrap_or_else(|| old_desc.clone());
    let r = sqlx::query(
        "UPDATE node_groups SET name = $2, description = $3, updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(&new_name)
    .bind(&new_desc)
    .execute(&mut *conn)
    .await;
    match r {
        Err(e) if is_unique_violation(&e) => {
            return Err(conflict!("group.name_exists", "group name already exists"));
        }
        r => r?,
    };
    let mut after = json!({
        "name": new_name, "description": new_desc,
        "entrance_ids": entrances.clone().unwrap_or_else(|| old_entrances.clone()),
    });
    after["entitlement"] = outcome.summary();
    crate::audit::record(
        conn,
        actor,
        "group.update",
        "node_group",
        Some(id.to_string()),
        Some(json!({ "name": old_name, "description": old_desc, "entrance_ids": old_entrances })),
        Some(after),
    )
    .await?;
    Ok(outcome)
}

/// DELETE /node-groups/{id}: plans granting it lose its entrances.
pub async fn apply_delete_group(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<Outcome, ApiError> {
    entitle::lock(conn).await?;
    let before: Option<(String, String)> =
        sqlx::query_as("SELECT name, description FROM node_groups WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((name, description)) = before else {
        return Err(ApiError::not_found());
    };
    let entrances = group_members(conn, id).await?;
    lock_nodes_of(conn, &entrances).await?;
    sqlx::query("DELETE FROM node_groups WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    let outcome = entitle::apply_reconcile(conn, Scope::Entrances(&entrances)).await?;
    crate::audit::record(
        conn,
        actor,
        "group.delete",
        "node_group",
        Some(id.to_string()),
        Some(json!({ "name": name, "description": description, "entrance_ids": entrances })),
        Some(json!({ "entitlement": outcome.summary() })),
    )
    .await?;
    Ok(outcome)
}

pub async fn create_group(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateGroupReq>,
) -> Result<(axum::http::StatusCode, Json<GroupView>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let id = apply_create_group(&mut tx, &Actor::of(&user), &req).await?;
    let view = group_view(&mut tx, id).await?;
    tx.commit().await?;
    Ok((axum::http::StatusCode::CREATED, Json(view)))
}

pub async fn update_group(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<UpdateGroupReq>,
) -> Result<Json<GroupView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_update_group(&mut tx, &Actor::of(&user), id, &req).await?;
    let view = group_view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(view))
}

pub async fn delete_group(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_delete_group(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct PlanRow {
    id: Uuid,
    name: String,
    traffic_quota_bytes: Option<i64>,
    reset_period: String,
    reset_days: Option<i32>,
    speed_limit_mbps: Option<i32>,
    device_seats: Option<i32>,
    sort: i32,
    enabled: bool,
    description: String,
    on_sale: bool,
    capacity: Option<i32>,
    renewal_only: bool,
    allow_switch_in: bool,
    prices: Value,
    group_ids: Vec<Uuid>,
    active_users: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Serialize, Debug)]
pub struct PlanView {
    id: Uuid,
    name: String,
    /// null = unlimited.
    traffic_quota_bytes: Option<i64>,
    /// "monthly" | "days-N" | "none".
    period: String,
    /// Per-user limit, both directions, enforced by the agent (protocol 4).
    speed_limit_mbps: Option<i32>,
    /// Reserved for the client's seat binding (R25); NOT enforced.
    device_seats: Option<i32>,
    sort: i32,
    /// Offered for new assignments.
    enabled: bool,
    /// Markdown-lite text for the purchase page.
    description: String,
    /// Offered in the shop (with `enabled` and at least one price).
    on_sale: bool,
    /// Max active subscribers (null = unlimited).
    capacity: Option<i32>,
    /// Only current subscribers may buy it (renewal / reset pack).
    renewal_only: bool,
    /// Holders of another plan may switch to it.
    allow_switch_in: bool,
    /// [{period, days, price_cents}] in period order.
    prices: Value,
    group_ids: Vec<Uuid>,
    active_users: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<PlanRow> for PlanView {
    fn from(r: PlanRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            traffic_quota_bytes: r.traffic_quota_bytes,
            period: Period::from_columns(&r.reset_period, r.reset_days).render(),
            speed_limit_mbps: r.speed_limit_mbps,
            device_seats: r.device_seats,
            sort: r.sort,
            enabled: r.enabled,
            description: r.description,
            on_sale: r.on_sale,
            capacity: r.capacity,
            renewal_only: r.renewal_only,
            allow_switch_in: r.allow_switch_in,
            prices: r.prices,
            group_ids: r.group_ids,
            active_users: r.active_users,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

const PLAN_VIEW_SQL: &str = "SELECT p.id, p.name, p.traffic_quota_bytes, p.reset_period, \
     p.reset_days, p.speed_limit_mbps, p.device_seats, p.sort, p.enabled, p.description, \
     p.on_sale, p.capacity, p.renewal_only, p.allow_switch_in, \
     COALESCE((SELECT jsonb_agg(jsonb_build_object('period', pp.period, 'days', pp.days, \
       'price_cents', pp.price_cents) ORDER BY array_position(ARRAY['month', 'quarter', \
       'half_year', 'year', 'two_year', 'three_year', 'days', 'onetime', 'reset'], pp.period)) \
       FROM plan_period_prices pp WHERE pp.plan_id = p.id), '[]'::jsonb) AS prices, \
     ARRAY(SELECT pg.group_id FROM plan_groups pg WHERE pg.plan_id = p.id ORDER BY pg.group_id) \
     AS group_ids, \
     (SELECT count(*) FROM user_plans up WHERE up.plan_id = p.id AND up.status = 'active') \
     AS active_users, p.created_at, p.updated_at FROM plans p";

async fn plan_view(conn: &mut PgConnection, id: Uuid) -> Result<PlanView, ApiError> {
    sqlx::query_as::<_, PlanRow>(sqlx::AssertSqlSafe(format!(
        "{PLAN_VIEW_SQL} WHERE p.id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .map(PlanView::from)
    .ok_or_else(ApiError::not_found)
}

/// SQL: the audit snapshot of a plans row under `alias`.
fn plan_snapshot_sql(alias: &str) -> String {
    format!(
        "jsonb_build_object('name', {a}.name, 'traffic_quota_bytes', {a}.traffic_quota_bytes, \
         'reset_period', {a}.reset_period, 'reset_days', {a}.reset_days, \
         'speed_limit_mbps', {a}.speed_limit_mbps, 'device_seats', {a}.device_seats, \
         'sort', {a}.sort, 'enabled', {a}.enabled, 'description', {a}.description, \
         'capacity', {a}.capacity, 'renewal_only', {a}.renewal_only, \
         'allow_switch_in', {a}.allow_switch_in)",
        a = alias
    )
}

pub async fn list_plans(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<PlanView>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, PlanRow>(sqlx::AssertSqlSafe(format!(
        "{PLAN_VIEW_SQL} ORDER BY p.sort, p.name"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows.into_iter().map(PlanView::from).collect()))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct CreatePlanReq {
    pub name: String,
    pub traffic_quota_bytes: Option<i64>,
    pub period: String,
    pub speed_limit_mbps: Option<i32>,
    pub device_seats: Option<i32>,
    pub sort: Option<i32>,
    pub enabled: Option<bool>,
    pub group_ids: Option<Vec<Uuid>>,
    pub description: Option<String>,
    pub capacity: Option<i32>,
    pub renewal_only: Option<bool>,
    pub allow_switch_in: Option<bool>,
    /// W21 (M11): the plan's prices and on-sale flag, set in the same
    /// transaction (one dialog, one save). Absent = no prices.
    pub pricing: Option<crate::billing::catalog::SetPricesReq>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct UpdatePlanReq {
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    /// null = unlimited.
    #[serde(default, deserialize_with = "double_option")]
    pub traffic_quota_bytes: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub period: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub speed_limit_mbps: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    pub device_seats: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    pub sort: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    pub enabled: Option<Option<bool>>,
    /// The complete set of granted groups (replaces it).
    #[serde(default, deserialize_with = "double_option")]
    pub group_ids: Option<Option<Vec<Uuid>>>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    /// null = unlimited.
    #[serde(default, deserialize_with = "double_option")]
    pub capacity: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    pub renewal_only: Option<Option<bool>>,
    #[serde(default, deserialize_with = "double_option")]
    pub allow_switch_in: Option<Option<bool>>,
    /// W21 (M11): replace the prices and on-sale flag in the same
    /// transaction as the field changes (absent = unchanged).
    #[serde(default)]
    pub pricing: Option<crate::billing::catalog::SetPricesReq>,
}

impl UpdatePlanReq {
    /// Whether any plan field (not the pricing) is present.
    fn has_plan_fields(&self) -> bool {
        self.name.is_some()
            || self.traffic_quota_bytes.is_some()
            || self.period.is_some()
            || self.speed_limit_mbps.is_some()
            || self.device_seats.is_some()
            || self.sort.is_some()
            || self.enabled.is_some()
            || self.group_ids.is_some()
            || self.description.is_some()
            || self.capacity.is_some()
            || self.renewal_only.is_some()
            || self.allow_switch_in.is_some()
    }
}

/// The highest accepted speed limit (100 Gbit/s).
const MAX_SPEED_MBPS: i32 = 100_000;

fn check_plan_numbers(
    quota: Option<i64>,
    speed: Option<i32>,
    seats: Option<i32>,
) -> Result<(), ApiError> {
    if quota.is_some_and(|q| q < 0) {
        return Err(bad_request!(
            "plan.quota_negative",
            "traffic_quota_bytes must be >= 0"
        ));
    }
    if speed.is_some_and(|s| !(1..=MAX_SPEED_MBPS).contains(&s)) {
        return Err(bad_request!(
            "plan.speed_limit_range",
            "speed_limit_mbps must be 1..={max_speed_mbps}",
            max_speed_mbps = MAX_SPEED_MBPS
        ));
    }
    if seats.is_some_and(|s| s < 0) {
        return Err(bad_request!(
            "plan.seats_negative",
            "device_seats must be >= 0"
        ));
    }
    Ok(())
}

fn check_capacity(c: Option<i32>) -> Result<(), ApiError> {
    if c.is_some_and(|c| c < 0) {
        return Err(bad_request!(
            "plan.capacity_negative",
            "capacity must be >= 0"
        ));
    }
    Ok(())
}

/// POST /plans. No subscribers yet: nothing to reconcile.
pub async fn apply_create_plan(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &CreatePlanReq,
) -> Result<Uuid, ApiError> {
    let name = clean_name("name", &req.name)?;
    let period = parse_period(&req.period)?;
    check_plan_numbers(
        req.traffic_quota_bytes,
        req.speed_limit_mbps,
        req.device_seats,
    )?;
    check_capacity(req.capacity)?;
    let description = clean_plan_description(req.description.as_deref().unwrap_or(""))?;
    let groups = id_set(req.group_ids.as_deref().unwrap_or(&[]));
    entitle::lock(conn).await?;
    require_all_exist(conn, "node_groups", "group", &groups).await?;
    let id = Uuid::new_v4();
    let (kind, days) = period.columns();
    let r: Result<Value, _> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "INSERT INTO plans (id, name, traffic_quota_bytes, reset_period, reset_days, \
         speed_limit_mbps, device_seats, sort, enabled, description, capacity, renewal_only, \
         allow_switch_in) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING {}",
        plan_snapshot_sql("plans")
    )))
    .bind(id)
    .bind(&name)
    .bind(req.traffic_quota_bytes)
    .bind(kind)
    .bind(days)
    .bind(req.speed_limit_mbps)
    .bind(req.device_seats)
    .bind(req.sort.unwrap_or(0))
    .bind(req.enabled.unwrap_or(true))
    .bind(&description)
    .bind(req.capacity)
    .bind(req.renewal_only.unwrap_or(false))
    .bind(req.allow_switch_in.unwrap_or(true))
    .fetch_one(&mut *conn)
    .await;
    let mut after = match r {
        Err(e) if is_unique_violation(&e) => {
            return Err(conflict!("plan.name_exists", "plan name already exists"));
        }
        r => r?,
    };
    sqlx::query("INSERT INTO plan_groups (plan_id, group_id) SELECT $1, unnest($2::uuid[])")
        .bind(id)
        .bind(&groups)
        .execute(&mut *conn)
        .await?;
    after["group_ids"] = json!(groups);
    crate::audit::record(
        conn,
        actor,
        "plan.create",
        "plan",
        Some(id.to_string()),
        None,
        Some(after),
    )
    .await?;
    Ok(id)
}

/// What a plan update did.
#[derive(Debug, Default)]
pub struct PlanUpdate {
    pub outcome: Outcome,
    /// Nodes bumped because users' served state changed (re-enabled).
    pub served_bumped: Vec<Uuid>,
}

/// PATCH /plans/{id}. Group changes reconcile the plan's active users;
/// quota changes rewrite their enforced limit (re-enabling quota-disabled
/// users the new quota admits); period changes move their next reset
/// (computed from each user's anchor, strictly after now — never an
/// immediate reset).
pub async fn apply_update_plan(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &UpdatePlanReq,
) -> Result<PlanUpdate, ApiError> {
    let name = non_null("name", &req.name)?
        .map(|n| clean_name("name", &n))
        .transpose()?;
    let period = non_null("period", &req.period)?
        .map(|p| parse_period(&p))
        .transpose()?;
    let sort = non_null("sort", &req.sort)?;
    let enabled = non_null("enabled", &req.enabled)?;
    let groups = non_null("group_ids", &req.group_ids)?.map(|g| id_set(&g));
    let renewal_only = non_null("renewal_only", &req.renewal_only)?;
    let allow_switch_in = non_null("allow_switch_in", &req.allow_switch_in)?;
    let description = match &req.description {
        None => None,
        Some(d) => Some(clean_plan_description(d.as_deref().unwrap_or(""))?),
    };
    check_plan_numbers(
        req.traffic_quota_bytes.flatten(),
        req.speed_limit_mbps.flatten(),
        req.device_seats.flatten(),
    )?;
    check_capacity(req.capacity.flatten())?;
    if name.is_none()
        && period.is_none()
        && sort.is_none()
        && enabled.is_none()
        && groups.is_none()
        && req.traffic_quota_bytes.is_none()
        && req.speed_limit_mbps.is_none()
        && req.device_seats.is_none()
        && description.is_none()
        && req.capacity.is_none()
        && renewal_only.is_none()
        && allow_switch_in.is_none()
    {
        return Err(bad_request!("request.no_fields", "no fields to update"));
    }
    entitle::lock(conn).await?;
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM plans WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found());
    }
    if let Some(g) = &groups {
        require_all_exist(conn, "node_groups", "group", g).await?;
    }
    let old_groups: Vec<Uuid> =
        sqlx::query_scalar("SELECT group_id FROM plan_groups WHERE plan_id = $1 ORDER BY group_id")
            .bind(id)
            .fetch_all(&mut *conn)
            .await?;

    let mut qb = sqlx::QueryBuilder::new("UPDATE plans SET ");
    let mut set = qb.separated(", ");
    set.push("updated_at = now()");
    if let Some(n) = &name {
        set.push("name = ").push_bind_unseparated(n.clone());
    }
    if let Some(p) = period {
        let (kind, days) = p.columns();
        set.push("reset_period = ").push_bind_unseparated(kind);
        set.push("reset_days = ").push_bind_unseparated(days);
    }
    if let Some(q) = req.traffic_quota_bytes {
        set.push("traffic_quota_bytes = ").push_bind_unseparated(q);
    }
    if let Some(s) = req.speed_limit_mbps {
        set.push("speed_limit_mbps = ").push_bind_unseparated(s);
    }
    if let Some(s) = req.device_seats {
        set.push("device_seats = ").push_bind_unseparated(s);
    }
    if let Some(s) = sort {
        set.push("sort = ").push_bind_unseparated(s);
    }
    if let Some(e) = enabled {
        set.push("enabled = ").push_bind_unseparated(e);
    }
    if let Some(d) = &description {
        set.push("description = ").push_bind_unseparated(d.clone());
    }
    if let Some(c) = req.capacity {
        set.push("capacity = ").push_bind_unseparated(c);
    }
    if let Some(r) = renewal_only {
        set.push("renewal_only = ").push_bind_unseparated(r);
    }
    if let Some(a) = allow_switch_in {
        set.push("allow_switch_in = ").push_bind_unseparated(a);
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.push(format!(
        " RETURNING {}, {}, old.traffic_quota_bytes IS DISTINCT FROM new.traffic_quota_bytes, \
         old.speed_limit_mbps IS DISTINCT FROM new.speed_limit_mbps",
        plan_snapshot_sql("old"),
        plan_snapshot_sql("new")
    ));
    let (before, mut after, quota_changed, speed_changed) = match qb
        .build_query_as::<(Value, Value, bool, bool)>()
        .fetch_one(&mut *conn)
        .await
    {
        Err(e) if is_unique_violation(&e) => {
            return Err(conflict!("plan.name_exists", "plan name already exists"));
        }
        r => r?,
    };
    let groups_changed = groups.as_ref().is_some_and(|g| *g != old_groups);
    if let Some(g) = &groups {
        sqlx::query("DELETE FROM plan_groups WHERE plan_id = $1")
            .bind(id)
            .execute(&mut *conn)
            .await?;
        sqlx::query("INSERT INTO plan_groups (plan_id, group_id) SELECT $1, unnest($2::uuid[])")
            .bind(id)
            .bind(g)
            .execute(&mut *conn)
            .await?;
    }
    if period.is_some() {
        sqlx::query(
            "UPDATE user_plans up SET next_reset_at = \
             akari_next_reset(up.period_anchor, p.reset_period, p.reset_days, now()) \
             FROM plans p WHERE p.id = up.plan_id AND up.plan_id = $1 AND up.status = 'active'",
        )
        .bind(id)
        .execute(&mut *conn)
        .await?;
    }
    let users: Vec<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM user_plans WHERE plan_id = $1 AND status = 'active' ORDER BY user_id",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let mut res = PlanUpdate::default();
    if (groups_changed || quota_changed || speed_changed) && !users.is_empty() {
        // Also locks every node the users have rows on (Scope::Users), so
        // the user updates and bumps below stay in lock order.
        res.outcome = entitle::apply_reconcile(conn, Scope::Users(&users)).await?;
    }
    if speed_changed && !users.is_empty() {
        // The limit travels in every user op (agent protocol 4): every node
        // serving these users must resend them.
        let bumped = bump_nodes_of_users(conn, &users).await?;
        after["speed_bumped_nodes"] = json!(bumped.len());
        res.served_bumped = bumped;
    }
    if quota_changed && !users.is_empty() {
        let synced = sync_users_from_plan(conn, &users, false).await?;
        let changed: Vec<Uuid> = synced
            .iter()
            .filter(|s| s.serve_changed)
            .map(|s| s.user)
            .collect();
        let bumped = bump_nodes_of_users(conn, &changed).await?;
        res.served_bumped = id_set(&[res.served_bumped.clone(), bumped].concat());
        after["users_synced"] = json!(synced.len());
        after["users_reenabled"] = json!(changed);
    }
    after["group_ids"] = json!(groups.clone().unwrap_or_else(|| old_groups.clone()));
    after["entitlement"] = res.outcome.summary();
    let mut before = before;
    before["group_ids"] = json!(old_groups);
    crate::audit::record(
        conn,
        actor,
        "plan.update",
        "plan",
        Some(id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(res)
}

/// DELETE /plans/{id}: refused while users hold it (409; reassign or cancel
/// them first, or disable the plan to stop offering it). Its ended
/// user_plans history goes with it (the audit log keeps the record).
pub async fn apply_delete_plan(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<(), ApiError> {
    entitle::lock(conn).await?;
    let before: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM plans p WHERE id = $1 FOR UPDATE",
        plan_snapshot_sql("p")
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(before) = before else {
        return Err(ApiError::not_found());
    };
    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM user_plans WHERE plan_id = $1 AND status = 'active'",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    if active > 0 {
        return Err(conflict!(
            "plan.in_use",
            "{active} user(s) hold this plan; change or cancel their plans first \
             (or disable the plan to stop offering it)",
            active = active
        ));
    }
    sqlx::query("DELETE FROM plans WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "plan.delete",
        "plan",
        Some(id.to_string()),
        Some(before),
        None,
    )
    .await?;
    Ok(())
}

pub async fn create_plan(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreatePlanReq>,
) -> Result<(axum::http::StatusCode, Json<PlanView>), ApiError> {
    user.require_admin()?;
    if let Some(p) = &req.pricing {
        crate::billing::catalog::check_prices(&p.prices, p.on_sale)?;
    }
    let actor = Actor::of(&user);
    let mut tx = state.pg().begin().await?;
    let id = apply_create_plan(&mut tx, &actor, &req).await?;
    if let Some(p) = &req.pricing {
        crate::billing::catalog::apply_set_prices(&mut tx, &actor, id, p).await?;
    }
    let view = plan_view(&mut tx, id).await?;
    tx.commit().await?;
    Ok((axum::http::StatusCode::CREATED, Json(view)))
}

pub async fn update_plan(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<UpdatePlanReq>,
) -> Result<Json<PlanView>, ApiError> {
    user.require_admin()?;
    if let Some(p) = &req.pricing {
        crate::billing::catalog::check_prices(&p.prices, p.on_sale)?;
    }
    let actor = Actor::of(&user);
    let mut tx = state.pg().begin().await?;
    // Fields and prices in one transaction (W21): both apply or neither.
    if req.has_plan_fields() || req.pricing.is_none() {
        apply_update_plan(&mut tx, &actor, id, &req).await?;
    }
    if let Some(p) = &req.pricing {
        crate::billing::catalog::apply_set_prices(&mut tx, &actor, id, p).await?;
    }
    let view = plan_view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(view))
}

pub async fn delete_plan(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_delete_plan(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// User plans
// ---------------------------------------------------------------------------

/// One user's enforced columns rewritten from their active plan.
struct Synced {
    user: Uuid,
    before: Value,
    after: Value,
    /// enabled or expires_at changed: what their nodes serve changed.
    serve_changed: bool,
}

/// Rewrite users' enforced `traffic_limit_bytes` / `expires_at` from their
/// active plan (resetting the expiry marker when the expiry moves),
/// optionally zero their usage, and re-enable quota-disabled users the
/// quota now admits. Callers hold the locks of every node the users have
/// rows on (Scope::Users reconcile) — users are locked after nodes.
async fn sync_users_from_plan(
    conn: &mut PgConnection,
    users: &[Uuid],
    reset_traffic: bool,
) -> sqlx::Result<Vec<Synced>> {
    let rows: Vec<(Uuid, Value, Value, bool)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE users u SET traffic_limit_bytes = p.traffic_quota_bytes, \
         expires_at = up.expires_at, \
         expiry_enforced = CASE WHEN u.expires_at IS DISTINCT FROM up.expires_at \
                           THEN false ELSE u.expiry_enforced END, \
         traffic_used_bytes = CASE WHEN $2 THEN 0 ELSE u.traffic_used_bytes END, \
         enabled = u.enabled OR (u.disabled_reason = 'quota' AND (p.traffic_quota_bytes IS NULL \
                   OR (CASE WHEN $2 THEN 0 ELSE u.traffic_used_bytes END) <= p.traffic_quota_bytes)) \
         FROM user_plans up JOIN plans p ON p.id = up.plan_id \
         WHERE u.id = ANY($1) AND up.user_id = u.id AND up.status = 'active' \
         RETURNING u.id, {}, {}, \
         (old.enabled <> new.enabled OR old.expires_at IS DISTINCT FROM new.expires_at)",
        crate::audit::user_snapshot_sql("old"),
        crate::audit::user_snapshot_sql("new"),
    )))
    .bind(users)
    .bind(reset_traffic)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(user, before, after, serve_changed)| Synced {
            user,
            before,
            after,
            serve_changed,
        })
        .collect())
}

/// Bump user_version on every node the users have rows on (already locked
/// by the caller). Returns them.
async fn bump_nodes_of_users(conn: &mut PgConnection, users: &[Uuid]) -> sqlx::Result<Vec<Uuid>> {
    if users.is_empty() {
        return Ok(Vec::new());
    }
    let mut v: Vec<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "UPDATE nodes SET user_version = user_version + 1 WHERE id IN ({}) RETURNING id",
        entitle::NODES_OF_USERS
    )))
    .bind(users)
    .fetch_all(conn)
    .await?;
    v.sort();
    Ok(v)
}

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct UserPlanView {
    id: Uuid,
    plan_id: Uuid,
    plan_name: String,
    status: String,
    /// The term (catalog period kind) and its days.
    period: String,
    period_days: Option<i32>,
    starts_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    period_anchor: DateTime<Utc>,
    last_reset_at: Option<DateTime<Utc>>,
    next_reset_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
}

const USER_PLAN_VIEW_SQL: &str = "SELECT up.id, up.plan_id, p.name AS plan_name, \
     up.status::text AS status, up.term_kind AS period, up.term_days AS period_days, up.starts_at, up.expires_at, up.period_anchor, up.last_reset_at, \
     up.next_reset_at, up.ended_at FROM user_plans up JOIN plans p ON p.id = up.plan_id";

/// D12: the duration of a subscription — a catalog period kind (the
/// traffic reset pack is not a duration) and its days. Admins assign plans
/// only as plan + term (or extend a periodic one by N days); the expiry is
/// always computed in SQL (`akari_period_end`), never sent by a client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Term {
    pub kind: PeriodKind,
    pub days: Option<i32>,
}

impl Term {
    /// A validated term (400 `user_plan.term_*`).
    pub fn new(kind: PeriodKind, days: Option<i32>) -> Result<Self, ApiError> {
        if kind == PeriodKind::Reset {
            return Err(bad_request!(
                "user_plan.term_reset",
                "the traffic reset pack is not a subscription term"
            ));
        }
        match (kind.days_rule(), days) {
            (Some(true), None) => Err(bad_request!(
                "user_plan.term_days_missing",
                "period \"days\" needs days"
            )),
            (Some(false), Some(_)) => Err(bad_request!(
                "user_plan.term_days_unexpected",
                "period {period} takes no days",
                period = kind.as_str()
            )),
            (_, Some(d)) if !(1..=MAX_PERIOD_DAYS).contains(&d) => Err(bad_request!(
                "user_plan.term_days_range",
                "days must be 1..={max_period_days}",
                max_period_days = MAX_PERIOD_DAYS
            )),
            _ => Ok(Term { kind, days }),
        }
    }

    /// A one-time purchase (ruling ④: never extended by N days).
    pub fn is_onetime(self) -> bool {
        self.kind == PeriodKind::Onetime
    }
}

/// `PUT /users/{id}/plan` (and `POST /users` `plan`, batch `set_plan`):
/// assign or change the plan for one term from now.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AssignPlanReq {
    pub plan_id: Uuid,
    pub period: PeriodKindText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<i32>,
}

impl AssignPlanReq {
    pub fn assignment(&self) -> Result<SetUserPlanReq, ApiError> {
        Ok(SetUserPlanReq {
            plan_id: self.plan_id,
            term: Term::new(self.period.0, self.days)?,
        })
    }
}

/// What `apply_set_user_plan` assigns: the plan for `term` from now. The
/// user's usage is zeroed (a new subscription starts empty, like a bought
/// one — docs/PAYMENTS.md "Switching plans").
#[derive(Clone, Copy, Debug)]
pub struct SetUserPlanReq {
    pub plan_id: Uuid,
    pub term: Term,
}

/// `PATCH /users/{id}/plan`: renew the active subscription by one term
/// (`period` + `days`) or extend it by `extend_days` — both from the later
/// of its expiry and now.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct RenewUserPlanReq {
    #[serde(default)]
    pub period: Option<PeriodKindText>,
    #[serde(default)]
    pub days: Option<i32>,
    #[serde(default)]
    pub extend_days: Option<i32>,
}

impl RenewUserPlanReq {
    pub fn renewal(&self) -> Result<Renewal, ApiError> {
        match (self.period, self.extend_days) {
            (Some(p), None) => Ok(Renewal::Term(Term::new(p.0, self.days)?)),
            (None, Some(n)) if self.days.is_none() => Renewal::extend(n),
            _ => Err(bad_request!(
                "user_plan.renew_mode",
                "send either period (with days when needed) or extend_days"
            )),
        }
    }
}

/// How a subscription is renewed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Renewal {
    /// One more term (its kind becomes the subscription's term).
    Term(Term),
    /// N more days; periodic subscriptions only (not `onetime`, ruling ④).
    ExtendDays(i32),
}

impl Renewal {
    pub fn extend(days: i32) -> Result<Self, ApiError> {
        if !(1..=MAX_PERIOD_DAYS).contains(&days) {
            return Err(bad_request!(
                "user_plan.extend_days_range",
                "extend_days must be 1..={max_period_days}",
                max_period_days = MAX_PERIOD_DAYS
            ));
        }
        Ok(Renewal::ExtendDays(days))
    }
}

/// `POST /users/{id}/plan/reset-traffic`: the console's confirmation.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetTrafficReq {
    pub confirm: bool,
}

/// What a user plan mutation bumped.
#[derive(Debug, Default)]
pub struct UserPlanChange {
    pub outcome: Outcome,
    pub served_bumped: Vec<Uuid>,
}

impl UserPlanChange {
    /// Every bumped node, sorted.
    pub fn bumped(&self) -> Vec<Uuid> {
        id_set(
            &self
                .outcome
                .bumped
                .iter()
                .chain(&self.served_bumped)
                .copied()
                .collect::<Vec<_>>(),
        )
    }
}

/// PUT /users/{id}/plan: give the user a plan for one term from now,
/// replacing the active one (status `replaced`), and zero their usage.
/// Credentials of nodes the old and new plan share are kept.
pub async fn apply_set_user_plan(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
    req: &SetUserPlanReq,
) -> Result<UserPlanChange, ApiError> {
    entitle::lock(conn).await?;
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    match role.as_deref() {
        None => return Err(ApiError::not_found()),
        Some("user") => {}
        Some(_) => {
            return Err(bad_request!(
                "user.admin_no_plan",
                "admin accounts are not proxy users and cannot have a plan"
            ));
        }
    }
    let plan: Option<bool> = sqlx::query_scalar("SELECT enabled FROM plans WHERE id = $1")
        .bind(req.plan_id)
        .fetch_optional(&mut *conn)
        .await?;
    match plan {
        None => return Err(bad_request!("plan.unknown", "unknown plan id")),
        Some(false) => return Err(conflict!("plan.disabled", "plan is disabled (not offered)")),
        Some(true) => {}
    }
    // Lock every node the reconcile will touch BEFORE the user_plans insert
    // (whose foreign key check share-locks the user row): nodes -> users.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT id FROM nodes WHERE id IN (SELECT e.node_id FROM plan_groups pg \
         JOIN entrance_group_members m ON m.group_id = pg.group_id \
         JOIN entrances e ON e.id = m.entrance_id WHERE pg.plan_id = $2 \
         UNION {}) ORDER BY id FOR UPDATE",
        entitle::NODES_OF_USERS
    )))
    .bind([user_id])
    .bind(req.plan_id)
    .execute(&mut *conn)
    .await?;
    let previous: Option<(Uuid, Uuid)> = sqlx::query_as(
        "UPDATE user_plans SET status = 'replaced', ended_at = now() \
         WHERE user_id = $1 AND status = 'active' RETURNING id, plan_id",
    )
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let speed_changed: bool = sqlx::query_scalar(
        "SELECT (SELECT speed_limit_mbps FROM plans WHERE id = $1) \
         IS DISTINCT FROM (SELECT speed_limit_mbps FROM plans WHERE id = $2)",
    )
    .bind(previous.map(|p| p.1))
    .bind(req.plan_id)
    .fetch_one(&mut *conn)
    .await?;
    let up_id = Uuid::new_v4();
    let expires_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        "INSERT INTO user_plans (id, user_id, plan_id, expires_at, period_anchor, next_reset_at, \
                                 term_kind, term_days) \
         SELECT $1, $2, p.id, akari_period_end(now(), $4, $5), now(), \
                akari_next_reset(now(), p.reset_period, p.reset_days, now()), $4, $5 \
         FROM plans p WHERE p.id = $3 RETURNING expires_at",
    )
    .bind(up_id)
    .bind(user_id)
    .bind(req.plan_id)
    .bind(req.term.kind.as_str())
    .bind(req.term.days)
    .fetch_one(&mut *conn)
    .await?;
    let mut res = UserPlanChange {
        outcome: entitle::apply_reconcile(conn, Scope::Users(&[user_id])).await?,
        ..Default::default()
    };
    let synced = sync_users_from_plan(conn, &[user_id], true).await?;
    let (before, mut after) = match synced.into_iter().next() {
        Some(s) => {
            // Served state or speed limit changed: every node of the user
            // resends it (the reconcile only bumped nodes whose rows moved).
            if s.serve_changed || speed_changed {
                res.served_bumped = bump_nodes_of_users(conn, &[user_id]).await?;
            }
            (s.before, s.after)
        }
        None => return Err(anyhow::anyhow!("user plan vanished in its own transaction").into()),
    };
    after["plan_id"] = json!(req.plan_id);
    after["user_plan_id"] = json!(up_id);
    after["term"] = json!({ "period": req.term.kind.as_str(), "days": req.term.days });
    after["plan_expires_at"] = json!(expires_at);
    after["entitlement"] = res.outcome.summary();
    let mut before = before;
    before["plan_id"] = json!(previous.map(|p| p.1));
    crate::audit::record(
        conn,
        actor,
        "user.plan.set",
        "user",
        Some(user_id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(res)
}

/// 404 for an unknown user, 409 `user_plan.none` for one without an active
/// plan.
async fn no_active_plan(conn: &mut PgConnection, user_id: Uuid) -> Result<ApiError, ApiError> {
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(match exists {
        None => ApiError::not_found(),
        Some(_) => conflict!("user_plan.none", "the user has no active plan"),
    })
}

/// PATCH /users/{id}/plan (and a paid renewal order, and batch "extend"):
/// push the active subscription's expiry out by one term or by N days,
/// from the later of its expiry and now (DB clock). A subscription without
/// expiry has nothing to renew (409 `user_plan.no_expiry`); N days are
/// refused for a one-time purchase (409 `user_plan.extend_onetime`, ruling
/// ④). Entitlement is unchanged; usage and the reset schedule stay.
pub async fn apply_renew_user_plan(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
    renewal: Renewal,
) -> Result<UserPlanChange, ApiError> {
    entitle::lock(conn).await?;
    type Active = (Uuid, String, Option<i32>, Option<DateTime<Utc>>);
    let active: Option<Active> = sqlx::query_as(
        "SELECT id, term_kind, term_days, expires_at FROM user_plans \
         WHERE user_id = $1 AND status = 'active' FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((up_id, term_kind, term_days, expires)) = active else {
        return Err(no_active_plan(conn, user_id).await?);
    };
    if expires.is_none() {
        return Err(conflict!(
            "user_plan.no_expiry",
            "the subscription has no expiry; nothing to renew"
        ));
    }
    let (term, extend) = match renewal {
        Renewal::Term(t) => (Some(t), None),
        Renewal::ExtendDays(n) => {
            if term_kind == PeriodKind::Onetime.as_str() {
                return Err(conflict!(
                    "user_plan.extend_onetime",
                    "a one-time purchase cannot be extended by days; renew it or assign a plan"
                ));
            }
            (None, Some(n))
        }
    };
    let new_expiry: Option<DateTime<Utc>> = sqlx::query_scalar(
        "UPDATE user_plans SET \
         expires_at = CASE WHEN $2::text IS NULL \
             THEN GREATEST(expires_at, now()) + make_interval(secs => $4::bigint * 86400) \
             ELSE akari_period_end(GREATEST(expires_at, now()), $2, $3) END, \
         term_kind = COALESCE($2, term_kind), \
         term_days = CASE WHEN $2::text IS NULL THEN term_days ELSE $3 END \
         WHERE id = $1 RETURNING expires_at",
    )
    .bind(up_id)
    .bind(term.map(|t| t.kind.as_str()))
    .bind(term.and_then(|t| t.days))
    .bind(extend)
    .fetch_one(&mut *conn)
    .await?;
    // Locks the user's nodes (nothing to change: same entitlement).
    let mut res = UserPlanChange {
        outcome: entitle::apply_reconcile(conn, Scope::Users(&[user_id])).await?,
        ..Default::default()
    };
    let synced = sync_users_from_plan(conn, &[user_id], false).await?;
    let mut after = json!({
        "user_plan_id": up_id,
        "expires_at": new_expiry,
        "term": term.map_or_else(
            || json!({ "period": term_kind, "days": term_days }),
            |t| json!({ "period": t.kind.as_str(), "days": t.days })
        ),
    });
    if let Some(n) = extend {
        after["extend_days"] = json!(n);
    }
    if let Some(s) = synced.into_iter().next() {
        if s.serve_changed {
            res.served_bumped = bump_nodes_of_users(conn, &[user_id]).await?;
        }
        after["user"] = s.after;
    }
    crate::audit::record(
        conn,
        actor,
        "user.plan.renew",
        "user",
        Some(user_id.to_string()),
        Some(json!({
            "user_plan_id": up_id,
            "expires_at": expires,
            "term": { "period": term_kind, "days": term_days },
        })),
        Some(after),
    )
    .await?;
    Ok(res)
}

/// DELETE /users/{id}/plan: end the active plan; plan-granted access is
/// revoked (departed rows written). The user's enforced limit and expiry
/// stay as they were (a record; only a new plan changes them, D12).
pub async fn apply_cancel_user_plan(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
) -> Result<UserPlanChange, ApiError> {
    entitle::lock(conn).await?;
    let ended: Option<(Uuid, Uuid)> = sqlx::query_as(
        "UPDATE user_plans SET status = 'cancelled', ended_at = now() \
         WHERE user_id = $1 AND status = 'active' RETURNING id, plan_id",
    )
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((up_id, plan_id)) = ended else {
        return Err(no_active_plan(conn, user_id).await?);
    };
    // D3: plans are the only source of access: the reconcile revokes every
    // credential of the user (what is left needs no speed-limit bump).
    let res = UserPlanChange {
        outcome: entitle::apply_reconcile(conn, Scope::Users(&[user_id])).await?,
        ..Default::default()
    };
    crate::audit::record(
        conn,
        actor,
        "user.plan.cancel",
        "user",
        Some(user_id.to_string()),
        Some(json!({ "plan_id": plan_id, "user_plan_id": up_id, "status": "active" })),
        Some(json!({ "status": "cancelled", "entitlement": res.outcome.summary() })),
    )
    .await?;
    Ok(res)
}

/// P1: what a refund undoes on the subscription its order created or
/// changed (computed by `billing::refund::effect` under the entitlement
/// lock, applied by `apply_refund_revoke` in the same transaction).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Revoke {
    /// End the subscription (status `cancelled`; access revoked).
    End { user_plan_id: Uuid },
    /// Take a renewal's term back: the expiry becomes `to` (> now).
    Rollback {
        user_plan_id: Uuid,
        to: DateTime<Utc>,
    },
    /// Undo a plan switch: end the subscription the order created and
    /// reactivate the one it replaced, with that one's expiry; the traffic
    /// used before the switch (`prior_used_bytes`) is added back to what
    /// was used since.
    Restore {
        user_plan_id: Uuid,
        prior_user_plan_id: Uuid,
        prior_used_bytes: i64,
    },
}

/// P1: apply a refund's `Revoke` to `user_id` (the caller holds
/// `entitle::lock` and the refunded order's row lock). Nodes are locked
/// before the user rows (Restore: the replaced plan's nodes too, like
/// `apply_set_user_plan`); every node of the user is bumped when what they
/// are served changes. Audited `user.plan.refund` (with the order id).
pub async fn apply_refund_revoke(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
    order_id: Uuid,
    revoke: Revoke,
) -> Result<UserPlanChange, ApiError> {
    let gone = || -> ApiError {
        anyhow::anyhow!("the refunded subscription changed in its own transaction").into()
    };
    let (up_id, before, mut after, prior) = match revoke {
        Revoke::End { user_plan_id } => {
            let r: Option<(Uuid, Option<DateTime<Utc>>)> = sqlx::query_as(
                "UPDATE user_plans SET status = 'cancelled', ended_at = now() \
                 WHERE id = $1 AND user_id = $2 AND status = 'active' \
                 RETURNING plan_id, expires_at",
            )
            .bind(user_plan_id)
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?;
            let (plan, expires) = r.ok_or_else(gone)?;
            (
                user_plan_id,
                json!({ "status": "active", "plan_id": plan, "expires_at": expires }),
                json!({ "status": "cancelled" }),
                None,
            )
        }
        Revoke::Rollback { user_plan_id, to } => {
            let r: Option<(Uuid, Option<DateTime<Utc>>)> = sqlx::query_as(
                "UPDATE user_plans SET expires_at = $3 \
                 WHERE id = $1 AND user_id = $2 AND status = 'active' \
                 RETURNING plan_id, old.expires_at",
            )
            .bind(user_plan_id)
            .bind(user_id)
            .bind(to)
            .fetch_optional(&mut *conn)
            .await?;
            let (plan, from) = r.ok_or_else(gone)?;
            (
                user_plan_id,
                json!({ "plan_id": plan, "expires_at": from }),
                json!({ "expires_at": to }),
                None,
            )
        }
        Revoke::Restore {
            user_plan_id,
            prior_user_plan_id,
            prior_used_bytes,
        } => {
            // Lock order: every node the reconcile will touch (the replaced
            // plan's and the user's current ones), then the user rows.
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT id FROM nodes WHERE id IN (SELECT e.node_id FROM user_plans up \
                 JOIN plan_groups pg ON pg.plan_id = up.plan_id \
                 JOIN entrance_group_members m ON m.group_id = pg.group_id \
                 JOIN entrances e ON e.id = m.entrance_id WHERE up.id = $2 \
                 UNION {}) ORDER BY id FOR UPDATE",
                entitle::NODES_OF_USERS
            )))
            .bind([user_id])
            .bind(prior_user_plan_id)
            .execute(&mut *conn)
            .await?;
            let cur: Option<Uuid> = sqlx::query_scalar(
                "UPDATE user_plans SET status = 'cancelled', ended_at = now() \
                 WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING plan_id",
            )
            .bind(user_plan_id)
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?;
            let cur = cur.ok_or_else(gone)?;
            let restored: Option<(Uuid, Option<DateTime<Utc>>)> = sqlx::query_as(
                "UPDATE user_plans SET status = 'active', ended_at = NULL \
                 WHERE id = $1 AND user_id = $2 AND status = 'replaced' \
                 RETURNING plan_id, expires_at",
            )
            .bind(prior_user_plan_id)
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?;
            let (plan, expires) = restored.ok_or_else(gone)?;
            (
                user_plan_id,
                json!({ "status": "active", "plan_id": cur }),
                json!({ "status": "cancelled", "restored": {
                    "user_plan_id": prior_user_plan_id, "plan_id": plan,
                    "expires_at": expires, "prior_used_bytes": prior_used_bytes } }),
                Some(prior_used_bytes),
            )
        }
    };
    // Revokes/issues credentials and locks every node of the user.
    let mut res = UserPlanChange {
        outcome: entitle::apply_reconcile(conn, Scope::Users(&[user_id])).await?,
        ..Default::default()
    };
    if let Some(carried) = prior {
        // The restored plan counts what was used before the switch plus
        // what was used since (never more than i64::MAX).
        sqlx::query(
            "UPDATE users SET traffic_used_bytes = LEAST(traffic_used_bytes::numeric + $2, \
             9223372036854775807)::bigint WHERE id = $1",
        )
        .bind(user_id)
        .bind(carried.max(0))
        .execute(&mut *conn)
        .await?;
    }
    if !matches!(revoke, Revoke::End { .. }) {
        let synced = sync_users_from_plan(conn, &[user_id], false).await?;
        // A restore may change the speed limit as well: resend everything.
        if synced.iter().any(|s| s.serve_changed) || prior.is_some() {
            res.served_bumped = bump_nodes_of_users(conn, &[user_id]).await?;
        }
        if let Some(s) = synced.into_iter().next() {
            after["user"] = s.after;
        }
    }
    after["entitlement"] = res.outcome.summary();
    after["order_id"] = json!(order_id);
    let mut before = before;
    before["user_plan_id"] = json!(up_id);
    crate::audit::record(
        conn,
        actor,
        "user.plan.refund",
        "user",
        Some(user_id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(res)
}

/// W7 traffic reset pack: zero the used traffic of a user whose ACTIVE
/// plan is `plan_id` and re-enable them if (and only if) they were disabled
/// for quota; no period change (the reset marker stays). 409 when the user
/// no longer holds that plan. Bumps the user's nodes when they become
/// served again; audited `user.traffic.reset` (source `reset_pack`).
pub async fn apply_reset_traffic(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
    plan_id: Uuid,
) -> Result<UserPlanChange, ApiError> {
    entitle::lock(conn).await?;
    let active: Option<Uuid> = sqlx::query_scalar(
        "SELECT plan_id FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    if active != Some(plan_id) {
        return Err(conflict!(
            "shop.reset_needs_plan",
            "a traffic reset pack needs an active subscription of its plan"
        ));
    }
    reset_traffic_locked(
        conn,
        actor,
        user_id,
        json!({ "source": "reset_pack", "plan_id": plan_id }),
    )
    .await
}

/// D12 "重置套餐流量" (`POST /users/{id}/plan/reset-traffic`, batch
/// `reset_traffic`): zero the used traffic of a user with an active plan
/// (409 `user_plan.none` otherwise); a quota-disabled account is re-enabled
/// (never a banned one). The reset schedule stays. Audited
/// `user.traffic.reset` (source `admin`).
pub async fn apply_admin_reset_traffic(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
) -> Result<UserPlanChange, ApiError> {
    entitle::lock(conn).await?;
    let active: Option<Uuid> = sqlx::query_scalar(
        "SELECT plan_id FROM user_plans WHERE user_id = $1 AND status = 'active'",
    )
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(plan_id) = active else {
        return Err(no_active_plan(conn, user_id).await?);
    };
    reset_traffic_locked(
        conn,
        actor,
        user_id,
        json!({ "source": "admin", "plan_id": plan_id }),
    )
    .await
}

/// The reset itself (caller holds `entitle::lock`): nodes -> users lock
/// order, bump only when the account comes back into service.
async fn reset_traffic_locked(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
    source: Value,
) -> Result<UserPlanChange, ApiError> {
    // Lock order: nodes (of the user's rows) -> users.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT id FROM nodes WHERE id IN ({}) ORDER BY id FOR UPDATE",
        entitle::NODES_OF_USERS
    )))
    .bind([user_id])
    .execute(&mut *conn)
    .await?;
    let row: Option<(i64, bool, bool, Option<String>)> = sqlx::query_as(
        "UPDATE users u SET traffic_used_bytes = 0, \
         enabled = u.enabled OR u.disabled_reason = 'quota' WHERE u.id = $1 \
         RETURNING old.traffic_used_bytes, old.enabled, new.enabled, old.disabled_reason",
    )
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((used, was_enabled, enabled, reason)) = row else {
        return Err(ApiError::not_found());
    };
    // The subscription's record of its last zeroing (the schedule stays).
    sqlx::query(
        "UPDATE user_plans SET last_reset_at = now() WHERE user_id = $1 AND status = 'active'",
    )
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    let mut res = UserPlanChange::default();
    if !was_enabled && enabled {
        res.served_bumped = bump_nodes_of_users(conn, &[user_id]).await?;
    }
    let mut after = json!({ "traffic_used_bytes": 0, "enabled": enabled });
    if let (Value::Object(a), Value::Object(s)) = (&mut after, source) {
        a.extend(s);
    }
    crate::audit::record(
        conn,
        actor,
        "user.traffic.reset",
        "user",
        Some(user_id.to_string()),
        Some(json!({ "traffic_used_bytes": used, "enabled": was_enabled,
                     "disabled_reason": reason })),
        Some(after),
    )
    .await?;
    Ok(res)
}

async fn user_plan_state(conn: &mut PgConnection, user_id: Uuid) -> Result<Value, ApiError> {
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found());
    }
    let history = sqlx::query_as::<_, UserPlanView>(sqlx::AssertSqlSafe(format!(
        "{USER_PLAN_VIEW_SQL} WHERE up.user_id = $1 ORDER BY up.created_at DESC, up.id LIMIT 20"
    )))
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    let active = history.iter().find(|h| h.status == "active");
    Ok(json!({ "active": active, "history": history }))
}

pub async fn get_user_plan(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    Ok(Json(user_plan_state(&mut c, id).await?))
}

pub async fn set_user_plan(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<AssignPlanReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let assign = req.assignment()?;
    let mut tx = state.pg().begin().await?;
    apply_set_user_plan(&mut tx, &Actor::of(&user), id, &assign).await?;
    let view = user_plan_state(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(view))
}

pub async fn renew_user_plan(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<RenewUserPlanReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let renewal = req.renewal()?;
    let mut tx = state.pg().begin().await?;
    apply_renew_user_plan(&mut tx, &Actor::of(&user), id, renewal).await?;
    let view = user_plan_state(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(view))
}

pub async fn cancel_user_plan(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_cancel_user_plan(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// POST /users/{id}/plan/reset-traffic `{confirm: true}`: D12 "重置套餐流量".
/// Returns the user's current subscription.
pub async fn reset_user_traffic(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<ResetTrafficReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    if !req.confirm {
        return Err(bad_request!(
            "user_plan.confirm_required",
            "resetting the traffic needs confirm: true"
        ));
    }
    let mut tx = state.pg().begin().await?;
    apply_admin_reset_traffic(&mut tx, &Actor::of(&user), id).await?;
    let sub = subscription(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(json!({ "subscription": sub })))
}

/// D12 "当前订阅" of a user's detail view (`GET /users/{id}`).
#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct SubscriptionView {
    pub user_plan_id: Uuid,
    pub plan_id: Uuid,
    pub plan_name: String,
    /// The term it was assigned/bought or last renewed with (catalog period
    /// kind: month … three_year, days, onetime) and its days.
    pub period: String,
    pub period_days: Option<i32>,
    pub starts_at: DateTime<Utc>,
    /// null = no expiry.
    pub expires_at: Option<DateTime<Utc>>,
    pub traffic_used_bytes: i64,
    /// The plan's quota (null = unlimited).
    pub traffic_total_bytes: Option<i64>,
    /// The plan's traffic reset period ("monthly", "days-N", "none").
    pub reset_period: String,
    pub last_reset_at: Option<DateTime<Utc>>,
    /// null = never (reset period "none"). Q3: presented in the site time
    /// zone (RFC 3339 with its offset, e.g. `2026-11-01T00:00:00+08:00`).
    #[sqlx(skip)]
    pub next_reset_at: Option<DateTime<FixedOffset>>,
    /// Q3: the site time zone (IANA) the reset schedule follows.
    pub timezone: String,
    pub speed_limit_mbps: Option<i32>,
    /// banned | over_quota | expired | active (the badge's precedence).
    pub status: String,
    #[serde(skip)]
    next_reset_utc: Option<DateTime<Utc>>,
    #[serde(skip)]
    next_reset_offset: Option<i32>,
    #[serde(skip)]
    reset_kind: String,
    #[serde(skip)]
    reset_days: Option<i32>,
}

/// The user's active subscription (None without one).
pub async fn subscription(
    conn: &mut PgConnection,
    user_id: Uuid,
) -> Result<Option<SubscriptionView>, ApiError> {
    let row = sqlx::query_as::<_, SubscriptionView>(
        "SELECT up.id AS user_plan_id, up.plan_id, p.name AS plan_name, up.term_kind AS period, \
         up.term_days AS period_days, up.starts_at, up.expires_at, u.traffic_used_bytes, \
         p.traffic_quota_bytes AS traffic_total_bytes, '' AS reset_period, up.last_reset_at, \
         up.next_reset_at AS next_reset_utc, akari_site_offset(up.next_reset_at) AS next_reset_offset, \
         akari_site_tz() AS timezone, p.speed_limit_mbps, \
         CASE WHEN NOT u.enabled AND u.disabled_reason = 'admin' THEN 'banned' \
              WHEN NOT u.enabled THEN 'over_quota' \
              WHEN up.expires_at IS NOT NULL AND up.expires_at <= now() THEN 'expired' \
              ELSE 'active' END AS status, \
         p.reset_period AS reset_kind, p.reset_days \
         FROM user_plans up JOIN plans p ON p.id = up.plan_id JOIN users u ON u.id = up.user_id \
         WHERE up.user_id = $1 AND up.status = 'active'",
    )
    .bind(user_id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|mut r| {
        r.reset_period = Period::from_columns(&r.reset_kind, r.reset_days).render();
        r.next_reset_at = r
            .next_reset_utc
            .map(|t| crate::settings::site_time(t, r.next_reset_offset.unwrap_or(0)));
        r
    }))
}

// ---------------------------------------------------------------------------
// Self-service: GET /me/plan
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
struct MyNode {
    name: String,
    region: Option<String>,
}

#[derive(sqlx::FromRow)]
struct MyPlanRow {
    name: String,
    traffic_quota_bytes: Option<i64>,
    reset_period: String,
    reset_days: Option<i32>,
    speed_limit_mbps: Option<i32>,
    device_seats: Option<i32>,
    starts_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    period_anchor: DateTime<Utc>,
    last_reset_at: Option<DateTime<Utc>>,
    next_reset_at: Option<DateTime<Utc>>,
    next_reset_offset: Option<i32>,
}

/// GET /api/v1/me/plan (any full session): the caller's active plan (or
/// null), usage, enforced limit/expiry, and the nodes they can use (names
/// and regions only — no addresses, ids or inbounds).
/// GET /api/v1/me/plan (renewal scope: also for expired users, R21).
pub async fn my_plan(
    State(state): State<AppState>,
    crate::auth::ShopUser { user, .. }: crate::auth::ShopUser,
) -> Result<Json<Value>, ApiError> {
    let mut c = state.pg().acquire().await?;
    let (used, limit, expires): (i64, Option<i64>, Option<DateTime<Utc>>) = sqlx::query_as(
        "SELECT traffic_used_bytes, traffic_limit_bytes, expires_at FROM users WHERE id = $1",
    )
    .bind(user.id)
    .fetch_optional(&mut *c)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    let plan = sqlx::query_as::<_, MyPlanRow>(
        "SELECT p.name, p.traffic_quota_bytes, p.reset_period, p.reset_days, p.speed_limit_mbps, \
         p.device_seats, up.starts_at, up.expires_at, up.period_anchor, up.last_reset_at, \
         up.next_reset_at, akari_site_offset(up.next_reset_at) AS next_reset_offset \
         FROM user_plans up JOIN plans p ON p.id = up.plan_id \
         WHERE up.user_id = $1 AND up.status = 'active'",
    )
    .bind(user.id)
    .fetch_optional(&mut *c)
    .await?;
    let nodes = sqlx::query_as::<_, MyNode>(
        "SELECT DISTINCT ON (n.sort, coalesce(n.display_name, n.name), n.id) \
         coalesce(n.display_name, n.name) AS name, n.region FROM entrance_users eu \
         JOIN entrances e ON e.id = eu.entrance_id AND e.enabled \
         JOIN nodes n ON n.id = e.node_id \
         WHERE eu.user_id = $1 AND n.enabled AND n.visible AND n.deleting_at IS NULL \
         ORDER BY n.sort, coalesce(n.display_name, n.name), n.id",
    )
    .bind(user.id)
    .fetch_all(&mut *c)
    .await?;
    let plan = plan.map(|p| {
        json!({
            "name": p.name,
            "traffic_quota_bytes": p.traffic_quota_bytes,
            "period": Period::from_columns(&p.reset_period, p.reset_days).render(),
            "speed_limit_mbps": p.speed_limit_mbps,
            "device_seats": p.device_seats,
            "starts_at": p.starts_at,
            "expires_at": p.expires_at,
            "period_anchor": p.period_anchor,
            "last_reset_at": p.last_reset_at,
            // Q3: in the site time zone (RFC 3339 with its offset).
            "next_reset_at": p.next_reset_at
                .map(|t| crate::settings::site_time(t, p.next_reset_offset.unwrap_or(0))),
        })
    });
    Ok(Json(json!({
        "plan": plan,
        "traffic_used_bytes": used,
        "traffic_limit_bytes": limit,
        "expires_at": expires,
        "nodes": nodes,
    })))
}

// ---------------------------------------------------------------------------
// Periodic passes (enforce::run_all, every flush tick, any instance)
// ---------------------------------------------------------------------------

/// End active user plans whose expiry passed (DB clock): status
/// `expired`, plan access revoked (departed rows), one audit row per user
/// (actor `system`). Restart-safe and idempotent: the status is the
/// marker. Returns the bumped nodes.
pub async fn apply_plan_expiry(conn: &mut PgConnection) -> Result<Vec<Uuid>, ApiError> {
    let due: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM user_plans WHERE status = 'active' AND expires_at <= now() \
         ORDER BY expires_at LIMIT $1",
    )
    .bind(PASS_BATCH)
    .fetch_all(&mut *conn)
    .await?;
    if due.is_empty() {
        return Ok(Vec::new());
    }
    entitle::lock(conn).await?;
    let ended: Vec<(Uuid, Uuid, Uuid, Option<DateTime<Utc>>)> = sqlx::query_as(
        "UPDATE user_plans SET status = 'expired', ended_at = now() \
         WHERE id = ANY($1) AND status = 'active' AND expires_at <= now() \
         RETURNING user_id, id, plan_id, expires_at",
    )
    .bind(&due)
    .fetch_all(&mut *conn)
    .await?;
    if ended.is_empty() {
        return Ok(Vec::new());
    }
    let mut users: Vec<Uuid> = ended.iter().map(|e| e.0).collect();
    users.sort();
    let outcome = entitle::apply_reconcile(conn, Scope::Users(&users)).await?;
    let actor = Actor::system();
    for (user, up, plan, expires) in &ended {
        crate::audit::record(
            conn,
            &actor,
            "user.plan.expire",
            "user",
            Some(user.to_string()),
            Some(
                json!({ "user_plan_id": up, "plan_id": plan, "status": "active",
                         "expires_at": expires }),
            ),
            Some(json!({ "status": "expired" })),
        )
        .await?;
    }
    if !outcome.bumped.is_empty() {
        tracing::info!(
            plans = ended.len(),
            nodes = outcome.bumped.len(),
            "expired user plans"
        );
    }
    Ok(outcome.bumped)
}

/// Traffic period reset: for active user plans whose `next_reset_at` passed
/// (DB clock), in ONE statement advance the marker past now (a pass that is
/// repeated, crashes before commit, or runs after any downtime resets each
/// period at most once — missed periods collapse into one reset), zero the
/// users' usage and re-enable users disabled ONLY for quota (never 'admin'),
/// bump the re-enabled users' nodes, and write one audit row per user
/// (actor `system`). Returns the bumped nodes.
pub async fn apply_period_resets(conn: &mut PgConnection) -> Result<Vec<Uuid>, ApiError> {
    let due: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM user_plans WHERE status = 'active' AND next_reset_at <= now() \
         ORDER BY next_reset_at LIMIT $1",
    )
    .bind(PASS_BATCH)
    .fetch_all(&mut *conn)
    .await?;
    if due.is_empty() {
        return Ok(Vec::new());
    }
    entitle::lock(conn).await?;
    // Lock order: nodes (of the users' rows) -> users.
    sqlx::query(
        "SELECT id FROM nodes WHERE id IN (SELECT e.node_id FROM entrance_users eu \
         JOIN entrances e ON e.id = eu.entrance_id \
         JOIN user_plans up ON up.user_id = eu.user_id WHERE up.id = ANY($1)) \
         ORDER BY id FOR UPDATE",
    )
    .bind(&due)
    .execute(&mut *conn)
    .await?;
    let reset: Vec<(Uuid, DateTime<Utc>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "UPDATE user_plans up SET last_reset_at = now(), \
         next_reset_at = akari_next_reset(up.period_anchor, p.reset_period, p.reset_days, now()) \
         FROM plans p WHERE p.id = up.plan_id AND up.id = ANY($1) AND up.status = 'active' \
         AND up.next_reset_at <= now() \
         RETURNING up.user_id, old.next_reset_at, new.next_reset_at",
    )
    .bind(&due)
    .fetch_all(&mut *conn)
    .await?;
    if reset.is_empty() {
        return Ok(Vec::new());
    }
    let mut users: Vec<Uuid> = reset.iter().map(|r| r.0).collect();
    users.sort();
    let changed: Vec<(Uuid, i64, bool, bool, Option<String>)> = sqlx::query_as(
        "UPDATE users u SET traffic_used_bytes = 0, \
         enabled = u.enabled OR u.disabled_reason = 'quota' \
         WHERE u.id = ANY($1) \
         RETURNING u.id, old.traffic_used_bytes, old.enabled, new.enabled, \
         old.disabled_reason",
    )
    .bind(&users)
    .fetch_all(&mut *conn)
    .await?;
    let reenabled: Vec<Uuid> = changed
        .iter()
        .filter(|c| !c.2 && c.3)
        .map(|c| c.0)
        .collect();
    let bumped = bump_nodes_of_users(conn, &reenabled).await?;
    let actor = Actor::system();
    for (user, used, was_enabled, enabled, reason) in &changed {
        let Some((_, boundary, next)) = reset.iter().find(|r| r.0 == *user) else {
            continue;
        };
        crate::audit::record(
            conn,
            &actor,
            "user.traffic.reset",
            "user",
            Some(user.to_string()),
            Some(json!({ "traffic_used_bytes": used, "enabled": was_enabled,
                         "disabled_reason": reason })),
            Some(json!({ "traffic_used_bytes": 0, "enabled": enabled,
                         "period_boundary": boundary, "next_reset_at": next })),
        )
        .await?;
    }
    tracing::info!(
        users = changed.len(),
        reenabled = reenabled.len(),
        "traffic period reset"
    );
    Ok(bumped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::TestDb;
    use crate::testdb::http::{Client, rand_ip};
    use axum::http::StatusCode;

    #[test]
    fn period_parsing() {
        assert_eq!(Period::parse("monthly"), Some(Period::Monthly));
        assert_eq!(Period::parse("none"), Some(Period::None));
        assert_eq!(Period::parse("days-30"), Some(Period::Days(30)));
        assert_eq!(Period::parse("days-3650"), Some(Period::Days(3650)));
        for bad in [
            "days-0",
            "days-3651",
            "days-",
            "days-07",
            "days--1",
            "days-+1",
            "days-1x",
            "Monthly",
            "weekly",
            "",
            "days-99999999999",
        ] {
            assert_eq!(Period::parse(bad), None, "{bad}");
        }
        for p in [Period::Monthly, Period::None, Period::Days(7)] {
            assert_eq!(Period::parse(&p.render()), Some(p));
            let (k, d) = p.columns();
            assert_eq!(Period::from_columns(k, d), p);
        }
    }

    // ----- real-DB helpers ----------------------------------------------

    fn a() -> Actor {
        Actor::test()
    }

    /// The direct entrances of `nodes` (in order).
    async fn directs(db: &TestDb, nodes: &[Uuid]) -> Vec<Uuid> {
        let mut out = Vec::new();
        for n in nodes {
            out.push(db.direct(*n).await);
        }
        out
    }

    /// A group of the nodes' direct entrances.
    async fn group(db: &TestDb, name: &str, nodes: &[Uuid]) -> Uuid {
        let entrances = directs(db, nodes).await;
        let mut tx = db.pool.begin().await.unwrap();
        let id = apply_create_group(
            &mut tx,
            &a(),
            &CreateGroupReq {
                name: name.into(),
                description: None,
                entrance_ids: Some(entrances),
            },
        )
        .await
        .ok()
        .unwrap();
        tx.commit().await.unwrap();
        id
    }

    /// The group holds the nodes' direct entrances (exactly).
    async fn set_group(db: &TestDb, g: Uuid, nodes: &[Uuid]) -> Outcome {
        let entrances = directs(db, nodes).await;
        let mut tx = db.pool.begin().await.unwrap();
        let o = apply_update_group(
            &mut tx,
            &a(),
            g,
            &UpdateGroupReq {
                entrance_ids: Some(Some(entrances)),
                ..Default::default()
            },
        )
        .await
        .ok()
        .unwrap();
        tx.commit().await.unwrap();
        o
    }

    async fn plan(db: &TestDb, name: &str, groups: &[Uuid], quota: Option<i64>) -> Uuid {
        let mut tx = db.pool.begin().await.unwrap();
        let id = apply_create_plan(
            &mut tx,
            &a(),
            &CreatePlanReq {
                name: name.into(),
                traffic_quota_bytes: quota,
                period: "monthly".into(),
                speed_limit_mbps: None,
                device_seats: None,
                sort: None,
                enabled: None,
                group_ids: Some(groups.to_vec()),
                ..Default::default()
            },
        )
        .await
        .ok()
        .unwrap();
        tx.commit().await.unwrap();
        id
    }

    async fn give(
        db: &TestDb,
        user: Uuid,
        plan: Uuid,
        expires: Option<DateTime<Utc>>,
    ) -> Vec<Uuid> {
        let mut tx = db.pool.begin().await.unwrap();
        let r = apply_set_user_plan(&mut tx, &a(), user, &forever(plan))
            .await
            .unwrap_or_else(|e| panic!("set plan: {}", e.message()));
        // A test-chosen expiry, written the way a renewal does (marker
        // reset with it).
        if let Some(t) = expires {
            sqlx::query(
                "UPDATE user_plans SET expires_at = $2 WHERE user_id = $1 AND status = 'active'",
            )
            .bind(user)
            .bind(t)
            .execute(&mut *tx)
            .await
            .unwrap();
            sqlx::query("UPDATE users SET expires_at = $2, expiry_enforced = false WHERE id = $1")
                .bind(user)
                .bind(t)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        r.bumped()
    }

    /// The plan without expiry (a permanent one-time purchase).
    fn forever(plan_id: Uuid) -> SetUserPlanReq {
        SetUserPlanReq {
            plan_id,
            term: Term {
                kind: PeriodKind::Onetime,
                days: None,
            },
        }
    }

    async fn plan_update(db: &TestDb, plan: Uuid, req: UpdatePlanReq) -> PlanUpdate {
        let mut tx = db.pool.begin().await.unwrap();
        let r = apply_update_plan(&mut tx, &a(), plan, &req)
            .await
            .unwrap_or_else(|e| panic!("update plan: {}", e.message()));
        tx.commit().await.unwrap();
        r
    }

    /// PUT /nodes/{id}/inbound (through the router).
    async fn set_inbound(db: &TestDb, node: Uuid, inbound: Value) {
        let state = crate::state::AppState::for_test(db.pool.clone()).await;
        let mut c = Client::new(&state, rand_ip());
        let admin = db.admin().await;
        c.cookie = Some(admin_token(&state, admin).await);
        let r = c
            .req(
                axum::http::Method::PUT,
                &format!("/test/api/v1/nodes/{node}/inbound"),
                Some(json!({ "inbound": inbound })),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    }

    async fn admin_token(state: &AppState, id: Uuid) -> String {
        let (role, sv): (String, i64) =
            sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
                .bind(id)
                .fetch_one(state.pg())
                .await
                .unwrap();
        crate::auth::issue_token(state, id, &role, sv).unwrap()
    }

    /// (node, protocol, account) of a user's credentials, by node.
    async fn rows(db: &TestDb, user: Uuid) -> Vec<(Uuid, String, Value)> {
        sqlx::query_as(
            "SELECT e.node_id, eu.protocol, eu.account FROM entrance_users eu \
             JOIN entrances e ON e.id = eu.entrance_id WHERE eu.user_id = $1 ORDER BY e.node_id",
        )
        .bind(user)
        .fetch_all(&db.pool)
        .await
        .unwrap()
    }

    async fn nodes_of(db: &TestDb, user: Uuid) -> Vec<Uuid> {
        rows(db, user).await.into_iter().map(|r| r.0).collect()
    }

    /// Nodes whose entrance the user departed from.
    async fn departed(db: &TestDb, user: Uuid) -> Vec<Uuid> {
        sqlx::query_scalar(
            "SELECT e.node_id FROM entrance_users_departed d JOIN entrances e \
             ON e.id = d.entrance_id WHERE d.user_id = $1 ORDER BY e.node_id",
        )
        .bind(user)
        .fetch_all(&db.pool)
        .await
        .unwrap()
    }

    fn sorted(mut v: Vec<Uuid>) -> Vec<Uuid> {
        v.sort();
        v
    }

    /// The reconcile invariant over the whole database: the credentials
    /// are exactly the granted (entrance, user) pairs on nodes with an
    /// issuable inbound, each of that inbound's protocol.
    async fn assert_consistent(db: &TestDb) {
        let mut c = db.pool.acquire().await.unwrap();
        let granted = entitle::granted_pairs(&mut c).await;
        let all: Vec<(Uuid, Uuid, String)> =
            sqlx::query_as("SELECT entrance_id, user_id, protocol FROM entrance_users")
                .fetch_all(&mut *c)
                .await
                .unwrap();
        let inbounds: std::collections::HashMap<Uuid, Option<Value>> =
            sqlx::query_as::<_, (Uuid, Option<Value>)>(
                "SELECT e.id, n.inbound FROM entrances e JOIN nodes n ON n.id = e.node_id",
            )
            .fetch_all(&mut *c)
            .await
            .unwrap()
            .into_iter()
            .collect();
        let mut want: Vec<(Uuid, Uuid)> = granted
            .iter()
            .flat_map(|(u, es)| es.iter().map(move |e| (*e, *u)))
            .filter(|(e, _)| entitle::eligible_protocol(inbounds[e].as_ref()).is_some())
            .collect();
        want.sort();
        let mut have: Vec<(Uuid, Uuid)> = all.iter().map(|r| (r.0, r.1)).collect();
        have.sort();
        assert_eq!(have, want, "credentials == granted pairs");
        for (e, _, proto) in &all {
            assert_eq!(
                Some(proto.as_str()),
                entitle::eligible_protocol(inbounds[e].as_ref()),
                "the inbound's protocol"
            );
        }
    }

    async fn audit_rows(db: &TestDb, action: &str) -> Vec<(String, Option<String>, Option<Value>)> {
        sqlx::query_as(
            "SELECT actor_label, target_id, after FROM audit_log WHERE action = $1 ORDER BY id",
        )
        .bind(action)
        .fetch_all(&db.pool)
        .await
        .unwrap()
    }

    // ----- tests ----------------------------------------------------------

    #[tokio::test]
    async fn next_reset_boundaries() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let q = |anchor: &str, period: &str, days: Option<i32>, after: &str| {
            let pool = db.pool.clone();
            let (anchor, period, after) =
                (anchor.to_string(), period.to_string(), after.to_string());
            async move {
                sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
                    "SELECT akari_next_reset($1::timestamptz, $2, $3, $4::timestamptz)",
                )
                .bind(anchor)
                .bind(period)
                .bind(days)
                .bind(after)
                .fetch_one(&pool)
                .await
                .unwrap()
                .map(|t| t.to_rfc3339())
            }
        };
        let some = |s: &str| Some(s.to_string());
        // Monthly on the anchor day, clamped to the month's end, no drift.
        assert_eq!(
            q(
                "2026-01-31T10:00:00Z",
                "monthly",
                None,
                "2026-02-01T00:00:00Z"
            )
            .await,
            some("2026-02-28T10:00:00+00:00")
        );
        assert_eq!(
            q(
                "2026-01-31T10:00:00Z",
                "monthly",
                None,
                "2026-02-28T10:00:00Z"
            )
            .await,
            some("2026-03-31T10:00:00+00:00"),
            "strictly after"
        );
        assert_eq!(
            q(
                "2024-01-31T00:00:00Z",
                "monthly",
                None,
                "2024-02-15T00:00:00Z"
            )
            .await,
            some("2024-02-29T00:00:00+00:00"),
            "leap year"
        );
        assert_eq!(
            q(
                "2026-01-15T00:00:00Z",
                "monthly",
                None,
                "2026-10-02T12:00:00Z"
            )
            .await,
            some("2026-10-15T00:00:00+00:00"),
            "long gap: next boundary after now, not the missed ones"
        );
        assert_eq!(
            q(
                "2025-12-20T00:00:00Z",
                "monthly",
                None,
                "2026-01-25T00:00:00Z"
            )
            .await,
            some("2026-02-20T00:00:00+00:00"),
            "across a year"
        );
        assert_eq!(
            q(
                "2026-05-01T00:00:00Z",
                "monthly",
                None,
                "2026-04-01T00:00:00Z"
            )
            .await,
            some("2026-05-01T00:00:00+00:00"),
            "anchor in the future of `after`"
        );
        // Every N days, exact seconds.
        assert_eq!(
            q(
                "2026-01-01T00:00:00Z",
                "days",
                Some(30),
                "2026-01-31T00:00:00Z"
            )
            .await,
            some("2026-03-02T00:00:00+00:00")
        );
        assert_eq!(
            q(
                "2026-01-01T00:00:00Z",
                "days",
                Some(30),
                "2026-01-30T23:59:59Z"
            )
            .await,
            some("2026-01-31T00:00:00+00:00")
        );
        assert_eq!(
            q("2026-01-01T00:00:00Z", "none", None, "2026-01-30T23:59:59Z").await,
            None
        );
        db.drop().await;
    }

    /// Q3: monthly resets and calendar-month terms follow the site time
    /// zone (default Asia/Shanghai, no DST): a plan started on the 1st
    /// local (still the last day of the month in UTC) resets and ends on
    /// the 1st local; UTC reproduces the old boundaries; in a DST zone the
    /// local wall-clock time is kept across the change; N-day periods stay
    /// exact seconds. The setting refuses anything but a full IANA name.
    #[tokio::test]
    async fn resets_and_terms_follow_the_site_time_zone() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let reset = |anchor: &'static str, period: &'static str, after: &'static str| {
            let pool = db.pool.clone();
            async move {
                sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
                    "SELECT akari_next_reset($1::timestamptz, $2, 30, $3::timestamptz)",
                )
                .bind(anchor)
                .bind(period)
                .bind(after)
                .fetch_one(&pool)
                .await
                .unwrap()
                .map(|t| t.to_rfc3339())
            }
        };
        let end = |base: &'static str, period: &'static str| {
            let pool = db.pool.clone();
            async move {
                sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
                    "SELECT akari_period_end($1::timestamptz, $2, NULL)",
                )
                .bind(base)
                .bind(period)
                .fetch_one(&pool)
                .await
                .unwrap()
                .map(|t| t.to_rfc3339())
            }
        };
        let set_tz = |tz: Option<&'static str>| {
            let pool = db.pool.clone();
            async move {
                sqlx::query("UPDATE panel_settings SET timezone = $1 WHERE id = 1")
                    .bind(tz)
                    .execute(&pool)
                    .await
            }
        };
        let some = |s: &str| Some(s.to_string());
        // 2026-02-28 19:00 UTC = 2026-03-01 03:00 in Shanghai.
        let start = "2026-02-28T19:00:00Z";
        assert_eq!(
            reset(start, "monthly", "2026-03-02T00:00:00Z").await,
            some("2026-03-31T19:00:00+00:00"),
            "the 1st of April, 03:00 Shanghai"
        );
        assert_eq!(
            end(start, "month").await,
            some("2026-03-31T19:00:00+00:00"),
            "a month bought on the 1st (local) ends on the 1st (local)"
        );
        assert_eq!(
            end(start, "quarter").await,
            some("2026-05-31T19:00:00+00:00")
        );
        // The day clamps to the month's end in local time: 31 Jan 18:00
        // Shanghai + 1 month = 28 Feb 18:00 Shanghai.
        assert_eq!(
            end("2026-01-31T10:00:00Z", "month").await,
            some("2026-02-28T10:00:00+00:00")
        );
        // N days: exact seconds whatever the zone.
        assert_eq!(
            reset(start, "days", "2026-03-01T00:00:00Z").await,
            some("2026-03-30T19:00:00+00:00")
        );
        // UTC: the old (v0.3) boundaries.
        set_tz(Some("UTC")).await.unwrap();
        assert_eq!(
            reset(start, "monthly", "2026-03-02T00:00:00Z").await,
            some("2026-03-28T19:00:00+00:00")
        );
        assert_eq!(end(start, "month").await, some("2026-03-28T19:00:00+00:00"));
        // DST (America/New_York, 2026-03-08): 10:00 EST before, 10:00 EDT
        // after, i.e. 15:00 UTC then 14:00 UTC.
        set_tz(Some("America/New_York")).await.unwrap();
        assert_eq!(
            reset("2026-02-15T15:00:00Z", "monthly", "2026-03-01T00:00:00Z").await,
            some("2026-03-15T14:00:00+00:00")
        );
        assert_eq!(
            end("2026-02-15T15:00:00Z", "month").await,
            some("2026-03-15T14:00:00+00:00")
        );
        // Only full IANA names (the trigger; the API checks first).
        for bad in ["CST", "UTC+8", "+08", "Mars/Olympus_Mons", "asia/shanghai"] {
            let e = set_tz(Some(bad)).await.unwrap_err();
            assert_eq!(
                e.as_database_error().and_then(|d| d.code()).as_deref(),
                Some("23514"),
                "{bad}"
            );
        }
        // NULL = the default again.
        set_tz(None).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT akari_site_tz()")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            "Asia/Shanghai"
        );
        db.drop().await;
    }

    /// W8: plan credentials for every managed protocol, shaped by their
    /// inbound (one per entrance); inbound changes refit kept accounts
    /// (VLESS flow follows settings.flow keeping the id; a Shadowsocks key
    /// is reissued when the method's key length changes).
    #[tokio::test]
    async fn w8_credentials_follow_inbound_settings() {
        use base64::Engine;
        let Some(db) = TestDb::new().await else {
            return;
        };
        let b64 = |n: usize| base64::engine::general_purpose::STANDARD.encode(vec![7u8; n]);
        let (nv, ns, nh, nx) = (
            db.node().await,
            db.node().await,
            db.node().await,
            db.node().await,
        );
        let u = db.user().await;
        let g = group(&db, "g", &[nv, ns, nh, nx]).await;
        let p = plan(&db, "p", &[g], None).await;
        let vless = |flow: &str| {
            json!({"protocol": "vless", "port": 443,
                 "settings": {"clients": [], "decryption": "none", "flow": flow},
                 "streamSettings": {"network": "tcp", "security": "reality"}})
        };
        let ss = |method: &str, psk: String| {
            json!({"protocol": "shadowsocks", "port": 8388,
                 "settings": {"method": method, "password": psk, "clients": [], "network": "tcp,udp"}})
        };
        set_inbound(&db, nv, vless("xtls-rprx-vision")).await;
        set_inbound(&db, ns, ss("2022-blake3-aes-128-gcm", b64(16))).await;
        set_inbound(
            &db,
            nh,
            json!({"protocol": "hysteria", "port": 443,
                 "settings": {"version": 2, "clients": []},
                 "streamSettings": {"network": "hysteria", "security": "tls", "hysteriaSettings": {"version": 2}}}),
        )
        .await;
        set_inbound(&db, nx, json!({"protocol": "socks", "port": 1080})).await;
        give(&db, u, p, None).await;
        let account = |rows: &[(Uuid, String, Value)], n: Uuid| -> Value {
            rows.iter()
                .find(|r| r.0 == n)
                .map(|r| r.2.clone())
                .unwrap_or(Value::Null)
        };
        let key_len = |a: &Value| {
            base64::engine::general_purpose::STANDARD
                .decode(a["password"].as_str().unwrap())
                .unwrap()
                .len()
        };
        let r = rows(&db, u).await;
        assert_eq!(r.len(), 3, "socks gets none: {r:?}");
        let v = account(&r, nv);
        assert_eq!(v["flow"], "xtls-rprx-vision");
        assert_eq!(key_len(&account(&r, ns)), 16);
        assert_eq!(account(&r, nh)["auth"].as_str().unwrap().len(), 64);
        let hy = account(&r, nh);
        // Method 128 -> 256 and Vision off: SS key reissued (32 bytes),
        // VLESS id kept with flow "", hysteria untouched.
        set_inbound(&db, nv, vless("")).await;
        set_inbound(&db, ns, ss("2022-blake3-aes-256-gcm", b64(32))).await;
        let r2 = rows(&db, u).await;
        assert_eq!(account(&r2, nv)["id"], v["id"]);
        assert_eq!(account(&r2, nv)["flow"], "");
        assert_eq!(key_len(&account(&r2, ns)), 32);
        assert_eq!(account(&r2, nh), hy);
        // Same again: nothing changes (idempotent).
        set_inbound(&db, ns, ss("2022-blake3-aes-256-gcm", b64(32))).await;
        assert_eq!(rows(&db, u).await, r2);
        assert_consistent(&db).await;
        db.drop().await;
    }

    /// Group / plan / user-plan / inbound changes issue and revoke exactly
    /// the right credentials, write departed rows, keep credentials across
    /// changes and bump exactly the affected nodes (D3: plans are the only
    /// source of access).
    #[tokio::test]
    async fn reconcile_follows_every_entitlement_change() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (na, nb, nc) = (db.node().await, db.node().await, db.node().await);
        let u = db.user().await;
        let bystander = db.user().await;
        let g1 = group(&db, "g1", &[na, nb]).await;
        let g2 = group(&db, "g2", &[nc]).await;
        let p1 = plan(&db, "p1", &[g1], Some(1000)).await;
        let p2 = plan(&db, "p2", &[g2], None).await;

        // Assign: credentials on A and B, one vless account each.
        assert_eq!(give(&db, u, p1, None).await, sorted(vec![na, nb]));
        let r = rows(&db, u).await;
        assert_eq!(r.len(), 2);
        assert!(
            r.iter()
                .all(|(_, p, a)| p == "vless" && a.get("id").is_some())
        );
        let limit: Option<i64> =
            sqlx::query_scalar("SELECT traffic_limit_bytes FROM users WHERE id = $1")
                .bind(u)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(limit, Some(1000), "limit derived from the plan");
        assert_consistent(&db).await;

        // Group gains C: only C is bumped.
        let o = set_group(&db, g1, &[na, nb, nc]).await;
        assert_eq!(o.bumped, vec![nc]);
        assert_eq!((o.issued, o.revoked), (1, 0));
        // Group loses A: A bumped, departed row for (A, u).
        let o = set_group(&db, g1, &[nb, nc]).await;
        assert_eq!((o.bumped.clone(), o.revoked), (vec![na], 1));
        assert_eq!(departed(&db, u).await, vec![na]);
        assert_consistent(&db).await;

        // Plan change P1 -> P2 (C only): B revoked, C's account kept byte
        // for byte; A untouched (already gone).
        let c_before = rows(&db, u)
            .await
            .into_iter()
            .find(|r| r.0 == nc)
            .unwrap()
            .2;
        assert_eq!(give(&db, u, p2, None).await, vec![nb]);
        assert_eq!(nodes_of(&db, u).await, vec![nc]);
        assert_eq!(rows(&db, u).await[0].2, c_before, "credentials kept");
        assert_eq!(departed(&db, u).await, sorted(vec![na, nb]));
        let limit: Option<i64> =
            sqlx::query_scalar("SELECT traffic_limit_bytes FROM users WHERE id = $1")
                .bind(u)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(limit, None, "P2 is unlimited");
        assert_consistent(&db).await;

        // C's inbound becomes trojan: a trojan account replaces the vless one.
        let before_v = db.versions(nc).await;
        set_inbound(&db, nc, json!({"protocol": "trojan", "port": 443})).await;
        let r = rows(&db, u).await;
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].1, "trojan");
        assert_eq!(r[0].2["password"].as_str().unwrap().len(), 64);
        assert_ne!(db.versions(nc).await, before_v);
        assert_consistent(&db).await;
        // Nothing issuable: revoked.
        set_inbound(&db, nc, json!({"protocol": "socks", "port": 1080})).await;
        assert!(nodes_of(&db, u).await.is_empty());
        assert_eq!(departed(&db, u).await, sorted(vec![na, nb, nc]));
        // Back: issued again, departed row cleared.
        set_inbound(&db, nc, json!({"protocol": "vless", "port": 443})).await;
        assert_eq!(nodes_of(&db, u).await, vec![nc]);
        assert_eq!(departed(&db, u).await, sorted(vec![na, nb]));
        assert_consistent(&db).await;

        // Idempotent: reconciling everything again changes nothing.
        let mut tx = db.pool.begin().await.unwrap();
        entitle::lock(&mut tx).await.unwrap();
        let o = entitle::apply_reconcile(&mut tx, Scope::Nodes(&[na, nb, nc]))
            .await
            .ok()
            .unwrap();
        assert_eq!(o, Outcome::default());
        tx.commit().await.unwrap();

        // Cancel: access gone, departed; limits stay; second cancel 409.
        let mut tx = db.pool.begin().await.unwrap();
        let r = apply_cancel_user_plan(&mut tx, &a(), u).await.ok().unwrap();
        tx.commit().await.unwrap();
        assert_eq!(r.bumped(), vec![nc]);
        assert!(nodes_of(&db, u).await.is_empty());
        let mut tx = db.pool.begin().await.unwrap();
        let e = apply_cancel_user_plan(&mut tx, &a(), u)
            .await
            .err()
            .unwrap();
        assert_eq!(e.code(), "user_plan.none");
        drop(tx);
        assert!(nodes_of(&db, bystander).await.is_empty());
        assert_consistent(&db).await;

        // Deleting a group removes its entrances from plans.
        give(&db, u, p2, None).await;
        assert_eq!(nodes_of(&db, u).await, vec![nc]);
        let mut tx = db.pool.begin().await.unwrap();
        let o = apply_delete_group(&mut tx, &a(), g2).await.ok().unwrap();
        tx.commit().await.unwrap();
        assert_eq!(o.bumped, vec![nc]);
        assert!(nodes_of(&db, u).await.is_empty());
        // A plan with subscribers cannot be deleted.
        let mut tx = db.pool.begin().await.unwrap();
        let e = apply_delete_plan(&mut tx, &a(), p2).await.err().unwrap();
        assert_eq!(e.status(), StatusCode::CONFLICT);
        drop(tx);
        // A node being deleted is skipped (its rows stay for final billing).
        let g3 = group(&db, "g3", &[na]).await;
        plan_update(
            &db,
            p2,
            UpdatePlanReq {
                group_ids: Some(Some(vec![g3])),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(nodes_of(&db, u).await, vec![na]);
        let mut tx = db.pool.begin().await.unwrap();
        crate::api::apply_begin_delete_node(&mut tx, &a(), na)
            .await
            .ok()
            .unwrap();
        tx.commit().await.unwrap();
        let o = set_group(&db, g3, &[]).await;
        assert!(o.bumped.is_empty(), "deleting node not reconciled");
        assert_eq!(nodes_of(&db, u).await, vec![na]);
        db.drop().await;
    }

    /// Admins cannot get plans; plan-managed user fields are refused; a
    /// user with a plan cannot be promoted.
    #[tokio::test]
    async fn plan_rules() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let admin = db.admin().await;
        let u = db.user().await;
        let p = plan(&db, "p", &[], Some(10)).await;
        let mut tx = db.pool.begin().await.unwrap();
        let req = forever(p);
        let e = apply_set_user_plan(&mut tx, &a(), admin, &req)
            .await
            .err()
            .unwrap();
        assert_eq!(e.status(), StatusCode::BAD_REQUEST);
        drop(tx);
        let mut tx = db.pool.begin().await.unwrap();
        let bad = forever(Uuid::new_v4());
        let e = apply_set_user_plan(&mut tx, &a(), u, &bad)
            .await
            .err()
            .unwrap();
        assert_eq!(e.status(), StatusCode::BAD_REQUEST);
        drop(tx);
        give(&db, u, p, None).await;
        // One active plan: a second assignment replaces the first.
        give(&db, u, p, None).await;
        let statuses: Vec<String> = sqlx::query_scalar(
            "SELECT status::text FROM user_plans WHERE user_id = $1 ORDER BY created_at, status",
        )
        .bind(u)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert_eq!(statuses, vec!["replaced", "active"]);
        // The partial unique index is the backstop.
        let dup = sqlx::query(
            "INSERT INTO user_plans (id, user_id, plan_id, period_anchor, term_kind) \
             VALUES ($1, $2, $3, now(), 'onetime')",
        )
        .bind(Uuid::new_v4())
        .bind(u)
        .bind(p)
        .execute(&db.pool)
        .await;
        assert!(dup.is_err(), "second active plan refused by the index");

        for req in [crate::api::UpdateUserReq {
            role: Some(Some("admin".into())),
            ..Default::default()
        }] {
            let mut tx = db.pool.begin().await.unwrap();
            let e = crate::api::apply_update_user_for_test(&mut tx, u, &req)
                .await
                .err()
                .unwrap();
            assert_eq!(e.status(), StatusCode::CONFLICT);
        }
        // Disabled plans are not offered.
        plan_update(
            &db,
            p,
            UpdatePlanReq {
                enabled: Some(Some(false)),
                ..Default::default()
            },
        )
        .await;
        let u2 = db.user().await;
        let mut tx = db.pool.begin().await.unwrap();
        let e = apply_set_user_plan(&mut tx, &a(), u2, &req)
            .await
            .err()
            .unwrap();
        assert_eq!(e.status(), StatusCode::CONFLICT);
        tx.rollback().await.unwrap();
        db.drop().await;
    }

    async fn user_state(db: &TestDb, u: Uuid) -> (i64, bool, Option<String>) {
        sqlx::query_as(
            "SELECT traffic_used_bytes, enabled, disabled_reason FROM users WHERE id = $1",
        )
        .bind(u)
        .fetch_one(&db.pool)
        .await
        .unwrap()
    }

    async fn make_due(db: &TestDb, u: Uuid, ago: &str) {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE user_plans SET next_reset_at = now() - interval '{ago}' \
             WHERE user_id = $1 AND status = 'active'"
        )))
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    async fn run_resets(db: &TestDb) -> Vec<Uuid> {
        let mut tx = db.pool.begin().await.unwrap();
        let r = apply_period_resets(&mut tx).await.ok().unwrap();
        tx.commit().await.unwrap();
        r
    }

    /// Period reset: zeroes usage, re-enables quota-disabled users only,
    /// bumps only their nodes, audits as `system`; idempotent, restart-safe
    /// (a rolled-back pass changes nothing), missed periods collapse.
    #[tokio::test]
    async fn period_reset_rules() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (n1, n2, n3) = (db.node().await, db.node().await, db.node().await);
        let g1 = group(&db, "g1", &[n1]).await;
        let g2 = group(&db, "g2", &[n2]).await;
        let g3 = group(&db, "g3", &[n3]).await;
        let p1 = plan(&db, "p1", &[g1], Some(100)).await;
        let p2 = plan(&db, "p2", &[g2], Some(100)).await;
        let p3 = plan(&db, "p3", &[g3], Some(100)).await;
        let (quota, admin_off, fine) = (db.user().await, db.user().await, db.user().await);
        give(&db, quota, p1, None).await;
        give(&db, admin_off, p2, None).await;
        give(&db, fine, p3, None).await;
        for u in [quota, admin_off, fine] {
            sqlx::query("UPDATE users SET traffic_used_bytes = 150 WHERE id = $1")
                .bind(u)
                .execute(&db.pool)
                .await
                .unwrap();
        }
        sqlx::query("UPDATE users SET traffic_used_bytes = 50 WHERE id = $1")
            .bind(fine)
            .execute(&db.pool)
            .await
            .unwrap();
        // The limit pass disables the two over quota, reason 'quota'.
        let mut tx = db.pool.begin().await.unwrap();
        let bumped = crate::enforce::apply_traffic_limits(&mut tx).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(sorted(bumped), sorted(vec![n1, n2]));
        assert_eq!(
            user_state(&db, quota).await,
            (150, false, Some("quota".into()))
        );
        // The admin then disables admin_off explicitly: reason 'admin'.
        let mut tx = db.pool.begin().await.unwrap();
        crate::api::apply_ban_user(&mut tx, &a(), admin_off, "r")
            .await
            .ok()
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(user_state(&db, admin_off).await.2.as_deref(), Some("admin"));

        // Not due yet: nothing.
        assert!(run_resets(&db).await.is_empty());
        for u in [quota, admin_off, fine] {
            make_due(&db, u, "1 second").await;
        }
        // A crashed pass (rolled back) changes nothing.
        let mut tx = db.pool.begin().await.unwrap();
        apply_period_resets(&mut tx).await.ok().unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(user_state(&db, quota).await.0, 150);
        assert!(audit_rows(&db, "user.traffic.reset").await.is_empty());

        let v = db.versions(n1).await;
        let (v2, v3) = (db.versions(n2).await, db.versions(n3).await);
        assert_eq!(
            run_resets(&db).await,
            vec![n1],
            "only the re-enabled user's node"
        );
        assert_ne!(db.versions(n1).await, v);
        assert_eq!((db.versions(n2).await, db.versions(n3).await), (v2, v3));
        assert_eq!(user_state(&db, quota).await, (0, true, None));
        assert_eq!(
            user_state(&db, admin_off).await,
            (0, false, Some("admin".into())),
            "admin-disabled stays disabled"
        );
        assert_eq!(user_state(&db, fine).await, (0, true, None));
        let rows = audit_rows(&db, "user.traffic.reset").await;
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.0 == "system"));
        // Marker advanced past now: idempotent.
        let next_ok: bool = sqlx::query_scalar(
            "SELECT bool_and(next_reset_at > now() AND last_reset_at IS NOT NULL) \
             FROM user_plans WHERE status = 'active'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(next_ok);
        sqlx::query("UPDATE users SET traffic_used_bytes = 7 WHERE id = $1")
            .bind(fine)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(run_resets(&db).await.is_empty());
        assert_eq!(user_state(&db, fine).await.0, 7, "no second reset");
        assert_eq!(audit_rows(&db, "user.traffic.reset").await.len(), 3);

        // Downtime of many periods: exactly one reset, next boundary in
        // the future.
        make_due(&db, fine, "95 days").await;
        run_resets(&db).await;
        assert!(run_resets(&db).await.is_empty());
        assert_eq!(audit_rows(&db, "user.traffic.reset").await.len(), 4);
        db.drop().await;
    }

    /// Plan quota changes rewrite enforced limits and re-enable only
    /// quota-disabled users the new quota admits.
    #[tokio::test]
    async fn plan_quota_change_reenables_quota_disabled_only() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        let g = group(&db, "g", &[n]).await;
        let p = plan(&db, "p", &[g], Some(100)).await;
        let (q, adm) = (db.user().await, db.user().await);
        give(&db, q, p, None).await;
        give(&db, adm, p, None).await;
        sqlx::query("UPDATE users SET traffic_used_bytes = 150 WHERE id = ANY($1)")
            .bind(vec![q, adm])
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE users SET enabled = false, disabled_reason = 'quota' WHERE id = $1")
            .bind(q)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE users SET enabled = false WHERE id = $1")
            .bind(adm)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            user_state(&db, adm).await.2.as_deref(),
            Some("admin"),
            "trigger default"
        );
        // Still over quota: nobody re-enabled.
        let r = plan_update(
            &db,
            p,
            UpdatePlanReq {
                traffic_quota_bytes: Some(Some(120)),
                ..Default::default()
            },
        )
        .await;
        assert!(r.served_bumped.is_empty());
        assert!(!user_state(&db, q).await.1);
        // Raised above usage: the quota-disabled user is back.
        let r = plan_update(
            &db,
            p,
            UpdatePlanReq {
                traffic_quota_bytes: Some(Some(200)),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(r.served_bumped, vec![n]);
        assert_eq!(user_state(&db, q).await, (150, true, None));
        assert!(!user_state(&db, adm).await.1, "admin-disabled stays");
        let limits: Vec<Option<i64>> =
            sqlx::query_scalar("SELECT traffic_limit_bytes FROM users WHERE id = ANY($1)")
                .bind(vec![q, adm])
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert_eq!(limits, vec![Some(200), Some(200)]);
        // CHECK: enabled <=> no reason, whatever SQL says.
        let bad = sqlx::query("UPDATE users SET disabled_reason = 'quota' WHERE id = $1")
            .bind(q)
            .execute(&db.pool)
            .await;
        assert!(bad.is_ok(), "trigger clears it on an enabled user");
        assert_eq!(user_state(&db, q).await.2, None);
        db.drop().await;
    }

    /// Plan expiry pass: status expired, access revoked (departed),
    /// audited as system; idempotent.
    #[tokio::test]
    async fn plan_expiry_pass() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let n = db.node().await;
        let g = group(&db, "g", &[n]).await;
        let p = plan(&db, "p", &[g], None).await;
        let u = db.user().await;
        give(
            &db,
            u,
            p,
            Some(Utc::now() + chrono::Duration::milliseconds(400)),
        )
        .await;
        let exp: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT expires_at FROM users WHERE id = $1")
                .bind(u)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(exp.is_some(), "user expiry derived from the plan");
        let run = || async {
            let mut tx = db.pool.begin().await.unwrap();
            let r = apply_plan_expiry(&mut tx).await.ok().unwrap();
            tx.commit().await.unwrap();
            r
        };
        assert!(run().await.is_empty());
        assert_eq!(nodes_of(&db, u).await, vec![n]);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(run().await, vec![n]);
        assert!(nodes_of(&db, u).await.is_empty());
        assert_eq!(departed(&db, u).await, vec![n]);
        assert!(run().await.is_empty(), "idempotent");
        let rows = audit_rows(&db, "user.plan.expire").await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "system");
        let status: String =
            sqlx::query_scalar("SELECT status::text FROM user_plans WHERE user_id = $1")
                .bind(u)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(status, "expired");
        assert_consistent(&db).await;
        db.drop().await;
    }

    /// Two admins changing the same plan at once, and the write-skew pair
    /// (group gains a node || a user gets a plan with that group): the
    /// entitlement lock serializes them; the end state is consistent.
    #[tokio::test]
    async fn concurrent_entitlement_changes_stay_consistent() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let nodes: Vec<Uuid> = {
            let mut v = Vec::new();
            for _ in 0..4 {
                v.push(db.node().await);
            }
            v
        };
        let ga = group(&db, "ga", &nodes[..2]).await;
        let gb = group(&db, "gb", &nodes[2..]).await;
        let p = plan(&db, "p", &[ga], None).await;
        let mut users = Vec::new();
        for _ in 0..6 {
            let u = db.user().await;
            give(&db, u, p, None).await;
            users.push(u);
        }
        for round in 0..6 {
            let (x, y) = if round % 2 == 0 {
                (vec![ga], vec![gb])
            } else {
                (vec![gb], vec![ga, gb])
            };
            let t = |groups: Vec<Uuid>| {
                let pool = db.pool.clone();
                tokio::spawn(async move {
                    let mut tx = pool.begin().await.unwrap();
                    apply_update_plan(
                        &mut tx,
                        &Actor::test(),
                        p,
                        &UpdatePlanReq {
                            group_ids: Some(Some(groups)),
                            ..Default::default()
                        },
                    )
                    .await
                    .ok()
                    .unwrap();
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    tx.commit().await.unwrap();
                })
            };
            let (r1, r2) = tokio::join!(t(x), t(y));
            r1.unwrap();
            r2.unwrap();
            assert_consistent(&db).await;
        }
        assert_eq!(audit_rows(&db, "plan.update").await.len(), 12);

        // Write skew: group membership vs. plan assignment.
        let n_new = db.node().await;
        let gc = group(&db, "gc", &[]).await;
        let pc = plan(&db, "pc", &[gc], None).await;
        let late = db.user().await;
        let e_new = db.direct(n_new).await;
        let pool = db.pool.clone();
        let t1 = tokio::spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            apply_update_group(
                &mut tx,
                &Actor::test(),
                gc,
                &UpdateGroupReq {
                    entrance_ids: Some(Some(vec![e_new])),
                    ..Default::default()
                },
            )
            .await
            .ok()
            .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            tx.commit().await.unwrap();
        });
        let pool = db.pool.clone();
        let t2 = tokio::spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            apply_set_user_plan(&mut tx, &Actor::test(), late, &forever(pc))
                .await
                .ok()
                .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            tx.commit().await.unwrap();
        });
        let (r1, r2) = tokio::join!(t1, t2);
        r1.unwrap();
        r2.unwrap();
        assert_eq!(nodes_of(&db, late).await, vec![n_new], "no write skew");
        assert_consistent(&db).await;
        db.drop().await;
    }

    /// The HTTP surface: CRUD, validation (deny_unknown_fields, double
    /// option), 409s, self-service plan view and password change.
    #[tokio::test]
    async fn http_surface() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = crate::state::AppState::for_test(db.pool.clone()).await;
        let admin = db.admin().await;
        let mut c = Client::new(&state, rand_ip());
        c.cookie = Some(admin_token(&state, admin).await);
        let n = db.node().await;
        sqlx::query("UPDATE nodes SET region = 'Tokyo', name = 'jp-1' WHERE id = $1")
            .bind(n)
            .execute(&db.pool)
            .await
            .unwrap();
        use axum::http::Method;
        let e = db.direct(n).await;
        let r = c
            .post(
                "/test/api/v1/node-groups",
                json!({ "name": "asia", "entrance_ids": [e] }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
        let g = r.json()["id"].as_str().unwrap().to_string();
        assert_eq!(r.json()["entrance_ids"], json!([e]));
        for (body, want) in [
            (json!({ "name": "asia" }), StatusCode::CONFLICT),
            (json!({ "name": "" }), StatusCode::BAD_REQUEST),
            (
                json!({ "name": "x", "node_ids": [] }),
                StatusCode::BAD_REQUEST,
            ),
            (
                json!({ "name": "x", "entrance_ids": [Uuid::new_v4()] }),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let r = c.post("/test/api/v1/node-groups", body.clone()).await;
            assert_eq!(r.status, want, "{body}");
        }
        for (body, want) in [
            (json!({}), StatusCode::BAD_REQUEST),
            (json!({ "name": null }), StatusCode::BAD_REQUEST),
            (json!({ "entrance_ids": null }), StatusCode::BAD_REQUEST),
            (json!({ "description": null }), StatusCode::OK),
            (json!({ "description": "east" }), StatusCode::OK),
        ] {
            let r = c
                .req(
                    Method::PATCH,
                    &format!("/test/api/v1/node-groups/{g}"),
                    Some(body.clone()),
                )
                .await;
            assert_eq!(r.status, want, "{body}");
        }
        let r = c
            .post(
                "/test/api/v1/plans",
                json!({ "name": "basic", "traffic_quota_bytes": 1000, "period": "days-30",
                        "speed_limit_mbps": 100, "device_seats": 3, "group_ids": [g] }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
        let p = r.json()["id"].as_str().unwrap().to_string();
        assert_eq!(r.json()["period"], "days-30");
        for body in [
            json!({ "name": "x", "period": "weekly" }),
            json!({ "name": "x", "period": "monthly", "traffic_quota_bytes": -1 }),
            json!({ "name": "x", "period": "monthly", "speed_limit_mbps": 0 }),
            json!({ "name": "x" }),
        ] {
            let r = c.post("/test/api/v1/plans", body.clone()).await;
            assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
        }
        let r = c
            .req(
                Method::PATCH,
                &format!("/test/api/v1/plans/{p}"),
                Some(json!({ "speed_limit_mbps": null, "period": "monthly" })),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.json()["speed_limit_mbps"], Value::Null);
        assert_eq!(r.json()["period"], "monthly");
        let r = c
            .req(
                Method::PATCH,
                &format!("/test/api/v1/plans/{p}"),
                Some(json!({ "period": null })),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);

        // A user with a password, given the plan.
        let u = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, email, password_hash) VALUES ($1, 'm3user@example.com', $2)",
        )
        .bind(u)
        .bind(crate::auth::hash_password("old-password-1").unwrap())
        .execute(&db.pool)
        .await
        .unwrap();
        let r = c
            .req(
                Method::PUT,
                &format!("/test/api/v1/users/{u}/plan"),
                Some(json!({ "plan_id": p, "bogus": 1 })),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "deny_unknown_fields");
        let r = c
            .req(
                Method::PUT,
                &format!("/test/api/v1/users/{u}/plan"),
                Some(json!({ "plan_id": p })),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "D12: a term is required");
        let r = c
            .req(
                Method::PUT,
                &format!("/test/api/v1/users/{u}/plan"),
                Some(json!({ "plan_id": p, "period": "month" })),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
        assert_eq!(r.json()["active"]["plan_name"], "basic");
        assert_eq!(r.json()["active"]["period"], "month");
        let r = c
            .req(
                Method::PATCH,
                &format!("/test/api/v1/users/{u}"),
                Some(json!({ "traffic_limit_bytes": 5 })),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "D12: not editable");
        let r = c.get("/test/api/v1/users").await;
        let me_row = r.json()["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == json!(u))
            .cloned()
            .unwrap();
        assert_eq!(me_row["plan_name"], "basic");
        assert_eq!(me_row["traffic_limit_bytes"], 1000);
        assert!(me_row["next_reset_at"].is_string());
        let r = c
            .req(
                Method::PATCH,
                &format!("/test/api/v1/users/{u}/plan"),
                Some(json!({ "expires_at": "2099-01-01T00:00:00Z" })),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "D12: no direct expiry");
        let before = me_row["expires_at"].as_str().map(str::to_owned);
        let r = c
            .req(
                Method::PATCH,
                &format!("/test/api/v1/users/{u}/plan"),
                Some(json!({ "extend_days": 10 })),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
        let after = r.json()["active"]["expires_at"].as_str().map(str::to_owned);
        assert!(after > before, "{before:?} -> {after:?}");
        let r = c.get(&format!("/test/api/v1/users/{u}/plan")).await;
        assert_eq!(r.status, StatusCode::OK);
        let r = c
            .req(Method::DELETE, &format!("/test/api/v1/plans/{p}"), None)
            .await;
        assert_eq!(r.status, StatusCode::CONFLICT);

        // Self-service.
        let mut me = Client::new(&state, rand_ip());
        let r = me.login("m3user@example.com", "old-password-1").await;
        assert_eq!(r.status, StatusCode::OK);
        let r = me.get("/test/api/v1/me/plan").await;
        assert_eq!(r.status, StatusCode::OK);
        let v = r.json();
        assert_eq!(v["plan"]["name"], "basic");
        assert_eq!(v["plan"]["period"], "monthly");
        assert_eq!(v["traffic_limit_bytes"], 1000);
        assert_eq!(v["nodes"], json!([{ "name": "jp-1", "region": "Tokyo" }]));
        // Q3: in the site time zone (Asia/Shanghai).
        let next = v["plan"]["next_reset_at"].as_str().unwrap();
        assert!(next.ends_with("+08:00"), "{next}");
        // Users cannot reach the admin API.
        assert_eq!(
            me.get("/test/api/v1/plans").await.status,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            me.get("/test/api/v1/node-groups").await.status,
            StatusCode::FORBIDDEN
        );
        // Password change: wrong current -> 400; right -> 204, other
        // sessions end, this one continues.
        let old_cookie = me.cookie.clone();
        let r = me
            .post(
                "/test/api/v1/me/password",
                json!({ "current_password": "nope-nope", "new_password": "new-password-2" }),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        let r = me
            .post(
                "/test/api/v1/me/password",
                json!({ "current_password": "old-password-1", "new_password": "short" }),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        let r = me
            .post(
                "/test/api/v1/me/password",
                json!({ "current_password": "old-password-1", "new_password": "new-password-2" }),
            )
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
        let fresh = r.session_cookie();
        assert!(fresh.is_some());
        me.cookie = old_cookie;
        assert_eq!(
            me.get("/test/api/v1/me").await.status,
            StatusCode::UNAUTHORIZED
        );
        me.cookie = fresh;
        assert_eq!(me.get("/test/api/v1/me").await.status, StatusCode::OK);
        let mut again = Client::new(&state, rand_ip());
        assert_eq!(
            again
                .login("m3user@example.com", "new-password-2")
                .await
                .status,
            StatusCode::OK
        );
        assert_eq!(audit_rows(&db, "user.password.change").await.len(), 1);

        // Cancel via HTTP.
        let r = c
            .req(
                Method::DELETE,
                &format!("/test/api/v1/users/{u}/plan"),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
        let r = c
            .req(
                Method::DELETE,
                &format!("/test/api/v1/users/{u}/plan"),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::CONFLICT, "no active plan");
        let r = c
            .req(Method::DELETE, &format!("/test/api/v1/plans/{p}"), None)
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
        let r = c
            .req(
                Method::DELETE,
                &format!("/test/api/v1/node-groups/{g}"),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
        drop(state);
        db.drop().await;
    }
}
