//! M3 operations model: node groups, plans, user plans (admin API), the
//! user's own plan view, and the periodic plan passes (traffic period reset,
//! plan expiry).
//!
//! Every mutation is an `apply_*` on the caller's transaction that takes
//! the entitlement lock first (entitle.rs), writes, reconciles `node_users`
//! (bumping exactly the nodes whose rows changed), syncs the users'
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
//! - `speed_limit_mbps` is a hint only (not enforced); `device_seats` is
//!   stored for M5 and not enforced.

use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::{double_option, non_null, ApiJson};
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::entitle::{self, Outcome, Scope};
use crate::state::AppState;

const MAX_NAME: usize = 64;
const MAX_DESCRIPTION: usize = 500;
/// Upper bound of `days-N` periods (10 years).
const MAX_PERIOD_DAYS: i32 = 3650;
/// Rows handled per periodic pass (the rest next tick).
const PASS_BATCH: i64 = 500;

fn clean_name(field: &str, name: &str) -> Result<String, ApiError> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > MAX_NAME {
        return Err(ApiError::bad_request(format!(
            "{field} must be 1-{MAX_NAME} characters"
        )));
    }
    Ok(n.to_string())
}

fn clean_description(d: &str) -> Result<String, ApiError> {
    if d.chars().count() > MAX_DESCRIPTION {
        return Err(ApiError::bad_request(format!(
            "description must be at most {MAX_DESCRIPTION} characters"
        )));
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
        return Err(ApiError::bad_request(format!("unknown {what} id")));
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

    fn from_columns(kind: &str, days: Option<i32>) -> Self {
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
        ApiError::bad_request(format!(
            "period must be \"monthly\", \"none\" or \"days-N\" (N = 1..{MAX_PERIOD_DAYS})"
        ))
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
    node_ids: Vec<Uuid>,
    /// Plans granting this group.
    plan_ids: Vec<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const GROUP_VIEW_SQL: &str = "SELECT g.id, g.name, g.description, \
     ARRAY(SELECT m.node_id FROM node_group_members m WHERE m.group_id = g.id ORDER BY m.node_id) \
     AS node_ids, \
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
    pub node_ids: Option<Vec<Uuid>>,
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
    pub node_ids: Option<Option<Vec<Uuid>>>,
}

async fn group_members(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar(
        "SELECT node_id FROM node_group_members WHERE group_id = $1 ORDER BY node_id",
    )
    .bind(id)
    .fetch_all(conn)
    .await
}

async fn lock_nodes(conn: &mut PgConnection, ids: &[Uuid]) -> sqlx::Result<()> {
    sqlx::query("SELECT id FROM nodes WHERE id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(ids)
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
    let nodes = id_set(req.node_ids.as_deref().unwrap_or(&[]));
    entitle::lock(conn).await?;
    lock_nodes(conn, &nodes).await?;
    require_all_exist(conn, "nodes", "node", &nodes).await?;
    let id = Uuid::new_v4();
    let r = sqlx::query("INSERT INTO node_groups (id, name, description) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(&name)
        .bind(&description)
        .execute(&mut *conn)
        .await;
    match r {
        Err(e) if is_unique_violation(&e) => {
            return Err(ApiError::conflict("group name already exists"))
        }
        r => r?,
    };
    sqlx::query("INSERT INTO node_group_members (group_id, node_id) SELECT $1, unnest($2::uuid[])")
        .bind(id)
        .bind(&nodes)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "group.create",
        "node_group",
        Some(id.to_string()),
        None,
        Some(json!({ "name": name, "description": description, "node_ids": nodes })),
    )
    .await?;
    Ok(id)
}

/// PATCH /node-groups/{id}. A membership change reconciles exactly the
/// nodes that joined or left.
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
    let nodes = non_null("node_ids", &req.node_ids)?.map(|n| id_set(&n));
    if name.is_none() && description.is_none() && nodes.is_none() {
        return Err(ApiError::bad_request("no fields to update"));
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
    let old_nodes = group_members(conn, id).await?;
    let mut outcome = Outcome::default();
    if let Some(new) = &nodes {
        let changed: Vec<Uuid> = id_set(
            &old_nodes
                .iter()
                .filter(|n| !new.contains(n))
                .chain(new.iter().filter(|n| !old_nodes.contains(n)))
                .copied()
                .collect::<Vec<_>>(),
        );
        lock_nodes(conn, &changed).await?;
        require_all_exist(conn, "nodes", "node", new).await?;
        sqlx::query("DELETE FROM node_group_members WHERE group_id = $1 AND NOT node_id = ANY($2)")
            .bind(id)
            .bind(new)
            .execute(&mut *conn)
            .await?;
        sqlx::query(
            "INSERT INTO node_group_members (group_id, node_id) SELECT $1, unnest($2::uuid[]) \
             ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(new)
        .execute(&mut *conn)
        .await?;
        outcome = entitle::apply_reconcile(conn, Scope::Nodes(&changed)).await?;
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
            return Err(ApiError::conflict("group name already exists"))
        }
        r => r?,
    };
    let mut after = json!({
        "name": new_name, "description": new_desc,
        "node_ids": nodes.clone().unwrap_or_else(|| old_nodes.clone()),
    });
    after["entitlement"] = outcome.summary();
    crate::audit::record(
        conn,
        actor,
        "group.update",
        "node_group",
        Some(id.to_string()),
        Some(json!({ "name": old_name, "description": old_desc, "node_ids": old_nodes })),
        Some(after),
    )
    .await?;
    Ok(outcome)
}

/// DELETE /node-groups/{id}: plans granting it lose its nodes.
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
    let nodes = group_members(conn, id).await?;
    lock_nodes(conn, &nodes).await?;
    sqlx::query("DELETE FROM node_groups WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    let outcome = entitle::apply_reconcile(conn, Scope::Nodes(&nodes)).await?;
    crate::audit::record(
        conn,
        actor,
        "group.delete",
        "node_group",
        Some(id.to_string()),
        Some(json!({ "name": name, "description": description, "node_ids": nodes })),
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
    /// Hint shown to users; NOT enforced.
    speed_limit_mbps: Option<i32>,
    /// Reserved for M5 seat binding; NOT enforced.
    device_seats: Option<i32>,
    sort: i32,
    /// Offered for new assignments.
    enabled: bool,
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
            group_ids: r.group_ids,
            active_users: r.active_users,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

const PLAN_VIEW_SQL: &str = "SELECT p.id, p.name, p.traffic_quota_bytes, p.reset_period, \
     p.reset_days, p.speed_limit_mbps, p.device_seats, p.sort, p.enabled, \
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
         'sort', {a}.sort, 'enabled', {a}.enabled)",
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

#[derive(Deserialize)]
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
}

fn check_plan_numbers(
    quota: Option<i64>,
    speed: Option<i32>,
    seats: Option<i32>,
) -> Result<(), ApiError> {
    if quota.is_some_and(|q| q < 0) {
        return Err(ApiError::bad_request("traffic_quota_bytes must be >= 0"));
    }
    if speed.is_some_and(|s| s <= 0) {
        return Err(ApiError::bad_request("speed_limit_mbps must be > 0"));
    }
    if seats.is_some_and(|s| s < 0) {
        return Err(ApiError::bad_request("device_seats must be >= 0"));
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
    let groups = id_set(req.group_ids.as_deref().unwrap_or(&[]));
    entitle::lock(conn).await?;
    require_all_exist(conn, "node_groups", "group", &groups).await?;
    let id = Uuid::new_v4();
    let (kind, days) = period.columns();
    let r: Result<Value, _> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "INSERT INTO plans (id, name, traffic_quota_bytes, reset_period, reset_days, \
         speed_limit_mbps, device_seats, sort, enabled) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING {}",
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
    .fetch_one(&mut *conn)
    .await;
    let mut after = match r {
        Err(e) if is_unique_violation(&e) => {
            return Err(ApiError::conflict("plan name already exists"))
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
    check_plan_numbers(
        req.traffic_quota_bytes.flatten(),
        req.speed_limit_mbps.flatten(),
        req.device_seats.flatten(),
    )?;
    if name.is_none()
        && period.is_none()
        && sort.is_none()
        && enabled.is_none()
        && groups.is_none()
        && req.traffic_quota_bytes.is_none()
        && req.speed_limit_mbps.is_none()
        && req.device_seats.is_none()
    {
        return Err(ApiError::bad_request("no fields to update"));
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
    qb.push(" WHERE id = ").push_bind(id);
    qb.push(format!(
        " RETURNING {}, {}, old.traffic_quota_bytes IS DISTINCT FROM new.traffic_quota_bytes",
        plan_snapshot_sql("old"),
        plan_snapshot_sql("new")
    ));
    let (before, mut after, quota_changed) = match qb
        .build_query_as::<(Value, Value, bool)>()
        .fetch_one(&mut *conn)
        .await
    {
        Err(e) if is_unique_violation(&e) => {
            return Err(ApiError::conflict("plan name already exists"))
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
    if (groups_changed || quota_changed) && !users.is_empty() {
        // Also locks every node the users have rows on (Scope::Users), so
        // the user updates and bumps below stay in lock order.
        res.outcome = entitle::apply_reconcile(conn, Scope::Users(&users)).await?;
    }
    if quota_changed && !users.is_empty() {
        let synced = sync_users_from_plan(conn, &users, false).await?;
        let changed: Vec<Uuid> = synced
            .iter()
            .filter(|s| s.serve_changed)
            .map(|s| s.user)
            .collect();
        res.served_bumped = bump_nodes_of_users(conn, &changed).await?;
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
        return Err(ApiError::conflict(format!(
            "{active} user(s) hold this plan; change or cancel their plans first \
             (or disable the plan to stop offering it)"
        )));
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
    let mut tx = state.pg().begin().await?;
    let id = apply_create_plan(&mut tx, &Actor::of(&user), &req).await?;
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
    let mut tx = state.pg().begin().await?;
    apply_update_plan(&mut tx, &Actor::of(&user), id, &req).await?;
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
    let mut v: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE nodes SET user_version = user_version + 1 \
         WHERE id IN (SELECT node_id FROM node_users WHERE user_id = ANY($1)) RETURNING id",
    )
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
    starts_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    period_anchor: DateTime<Utc>,
    last_reset_at: Option<DateTime<Utc>>,
    next_reset_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
}

const USER_PLAN_VIEW_SQL: &str = "SELECT up.id, up.plan_id, p.name AS plan_name, \
     up.status::text AS status, up.starts_at, up.expires_at, up.period_anchor, up.last_reset_at, \
     up.next_reset_at, up.ended_at FROM user_plans up JOIN plans p ON p.id = up.plan_id";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetUserPlanReq {
    pub plan_id: Uuid,
    /// null/absent = no expiry. Must be in the future.
    pub expires_at: Option<DateTime<Utc>>,
    /// Start of the first traffic period (default now); not in the future.
    pub period_anchor: Option<DateTime<Utc>>,
    /// Zero the user's usage (default false: a plan change keeps it).
    pub reset_traffic: Option<bool>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct UpdateUserPlanReq {
    /// null clears the expiry.
    #[serde(default, deserialize_with = "double_option")]
    pub expires_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "double_option")]
    pub period_anchor: Option<Option<DateTime<Utc>>>,
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

/// 400 unless `t` is after the DB clock's now.
async fn require_future(
    conn: &mut PgConnection,
    field: &str,
    t: DateTime<Utc>,
) -> Result<(), ApiError> {
    let ok: bool = sqlx::query_scalar("SELECT $1 > now()")
        .bind(t)
        .fetch_one(conn)
        .await?;
    if !ok {
        return Err(ApiError::bad_request(format!(
            "{field} must be in the future"
        )));
    }
    Ok(())
}

async fn require_not_future(
    conn: &mut PgConnection,
    field: &str,
    t: DateTime<Utc>,
) -> Result<(), ApiError> {
    let ok: bool = sqlx::query_scalar("SELECT $1 <= now()")
        .bind(t)
        .fetch_one(conn)
        .await?;
    if !ok {
        return Err(ApiError::bad_request(format!(
            "{field} must not be in the future"
        )));
    }
    Ok(())
}

/// PUT /users/{id}/plan: give the user a plan, replacing the active one.
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
            return Err(ApiError::bad_request(
                "admin accounts are not proxy users and cannot have a plan",
            ))
        }
    }
    let plan: Option<bool> = sqlx::query_scalar("SELECT enabled FROM plans WHERE id = $1")
        .bind(req.plan_id)
        .fetch_optional(&mut *conn)
        .await?;
    match plan {
        None => return Err(ApiError::bad_request("unknown plan id")),
        Some(false) => return Err(ApiError::conflict("plan is disabled (not offered)")),
        Some(true) => {}
    }
    if let Some(t) = req.expires_at {
        require_future(conn, "expires_at", t).await?;
    }
    if let Some(a) = req.period_anchor {
        require_not_future(conn, "period_anchor", a).await?;
    }
    // Lock every node the reconcile will touch BEFORE the user_plans insert
    // (whose foreign key check share-locks the user row): nodes -> users.
    sqlx::query(
        "SELECT id FROM nodes WHERE id IN (SELECT m.node_id FROM plan_groups pg \
         JOIN node_group_members m ON m.group_id = pg.group_id WHERE pg.plan_id = $2 \
         UNION SELECT node_id FROM node_users WHERE user_id = $1) ORDER BY id FOR UPDATE",
    )
    .bind(user_id)
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
    let up_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO user_plans (id, user_id, plan_id, expires_at, period_anchor, next_reset_at) \
         SELECT $1, $2, p.id, $4, COALESCE($5, now()), \
                akari_next_reset(COALESCE($5, now()), p.reset_period, p.reset_days, now()) \
         FROM plans p WHERE p.id = $3",
    )
    .bind(up_id)
    .bind(user_id)
    .bind(req.plan_id)
    .bind(req.expires_at)
    .bind(req.period_anchor)
    .execute(&mut *conn)
    .await?;
    let mut res = UserPlanChange {
        outcome: entitle::apply_reconcile(conn, Scope::Users(&[user_id])).await?,
        ..Default::default()
    };
    let reset = req.reset_traffic.unwrap_or(false);
    let synced = sync_users_from_plan(conn, &[user_id], reset).await?;
    let (before, mut after) = match synced.into_iter().next() {
        Some(s) => {
            if s.serve_changed {
                res.served_bumped = bump_nodes_of_users(conn, &[user_id]).await?;
            }
            (s.before, s.after)
        }
        None => return Err(anyhow::anyhow!("user plan vanished in its own transaction").into()),
    };
    after["plan_id"] = json!(req.plan_id);
    after["user_plan_id"] = json!(up_id);
    after["reset_traffic"] = json!(reset);
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

/// PATCH /users/{id}/plan: change the active plan's expiry (renewal) or
/// period anchor. Entitlement is unchanged.
pub async fn apply_update_user_plan(
    conn: &mut PgConnection,
    actor: &Actor,
    user_id: Uuid,
    req: &UpdateUserPlanReq,
) -> Result<UserPlanChange, ApiError> {
    let anchor = non_null("period_anchor", &req.period_anchor)?;
    if req.expires_at.is_none() && anchor.is_none() {
        return Err(ApiError::bad_request("no fields to update"));
    }
    entitle::lock(conn).await?;
    if let Some(Some(t)) = req.expires_at {
        require_future(conn, "expires_at", t).await?;
    }
    if let Some(a) = anchor {
        require_not_future(conn, "period_anchor", a).await?;
    }
    let mut qb = sqlx::QueryBuilder::new("UPDATE user_plans up SET ");
    let mut set = qb.separated(", ");
    if let Some(e) = req.expires_at {
        set.push("expires_at = ").push_bind_unseparated(e);
    }
    if let Some(a) = anchor {
        set.push("period_anchor = ").push_bind_unseparated(a);
        set.push("next_reset_at = akari_next_reset(")
            .push_bind_unseparated(a)
            .push_unseparated(", p.reset_period, p.reset_days, now())");
    }
    qb.push(" FROM plans p WHERE p.id = up.plan_id AND up.status = 'active' AND up.user_id = ")
        .push_bind(user_id);
    qb.push(
        " RETURNING jsonb_build_object('expires_at', old.expires_at, 'period_anchor', \
         old.period_anchor, 'next_reset_at', old.next_reset_at), \
         jsonb_build_object('expires_at', new.expires_at, 'period_anchor', new.period_anchor, \
         'next_reset_at', new.next_reset_at)",
    );
    let Some((plan_before, plan_after)) = qb
        .build_query_as::<(Value, Value)>()
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Err(ApiError::not_found());
    };
    // Locks the user's nodes (nothing to change: same entitlement).
    let mut res = UserPlanChange {
        outcome: entitle::apply_reconcile(conn, Scope::Users(&[user_id])).await?,
        ..Default::default()
    };
    let synced = sync_users_from_plan(conn, &[user_id], false).await?;
    let mut after = plan_after;
    if let Some(s) = synced.into_iter().next() {
        if s.serve_changed {
            res.served_bumped = bump_nodes_of_users(conn, &[user_id]).await?;
        }
        after["user"] = s.after;
    }
    crate::audit::record(
        conn,
        actor,
        "user.plan.update",
        "user",
        Some(user_id.to_string()),
        Some(plan_before),
        Some(after),
    )
    .await?;
    Ok(res)
}

/// DELETE /users/{id}/plan: end the active plan; plan-granted access is
/// revoked (departed rows written). The user's enforced limit and expiry
/// stay as they were (now editable via PATCH /users).
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
        return Err(ApiError::not_found());
    };
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
    ApiJson(req): ApiJson<SetUserPlanReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_set_user_plan(&mut tx, &Actor::of(&user), id, &req).await?;
    let view = user_plan_state(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(view))
}

pub async fn update_user_plan(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<UpdateUserPlanReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_update_user_plan(&mut tx, &Actor::of(&user), id, &req).await?;
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
}

/// GET /api/v1/me/plan (any full session): the caller's active plan (or
/// null), usage, enforced limit/expiry, and the nodes they can use (names
/// and regions only — no addresses, ids or inbounds).
pub async fn my_plan(
    State(state): State<AppState>,
    user: AuthUser,
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
         up.next_reset_at FROM user_plans up JOIN plans p ON p.id = up.plan_id \
         WHERE up.user_id = $1 AND up.status = 'active'",
    )
    .bind(user.id)
    .fetch_optional(&mut *c)
    .await?;
    let nodes = sqlx::query_as::<_, MyNode>(
        "SELECT n.name, n.region FROM node_users nu JOIN nodes n ON n.id = nu.node_id \
         WHERE nu.user_id = $1 AND n.enabled AND n.deleting_at IS NULL ORDER BY n.name",
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
            "next_reset_at": p.next_reset_at,
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
        "SELECT id FROM nodes WHERE id IN (SELECT nu.node_id FROM node_users nu \
         JOIN user_plans up ON up.user_id = nu.user_id WHERE up.id = ANY($1)) \
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
         old.disabled_reason::text",
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
