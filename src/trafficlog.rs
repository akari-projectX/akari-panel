//! W22: traffic history — per user, per node, per UTC day.
//!
//! `traffic::FLUSH_SQL` writes `traffic_daily` (user, day, node) and
//! `traffic_node_daily` (node, day) in the same statement that bills the
//! users, from the same accepted deltas: the history is exactly as
//! idempotent as the settlement, and Σ billed_bytes of a user's rows is
//! what was added to users.traffic_used_bytes. `traffic::rollup_pass` moves
//! days older than `traffic.daily_retention_days` into `traffic_monthly`.
//!
//! This module is the read side: a strict query-string parser (fuzzed:
//! `parse_query`), the queries (public, for the admin dashboard) and the
//! four endpoints:
//!
//! - admin `GET /users/{id}/traffic?from&to&group=day|node|month`
//! - admin `GET /nodes/{id}/traffic?from&to&limit` (per day + top users)
//! - admin `GET /traffic/summary?from&to&limit` (fleet per day + top nodes)
//! - user `GET /me/traffic?from&to` (own rows only: per day, per node NAME;
//!   no node ids; hidden or deleted nodes merged into one unnamed row)
//!
//! Dates are `YYYY-MM-DD` UTC days, `to` inclusive; default the last 30
//! days; at most 366 days (month grouping: 3660, widened to whole months).

use axum::extract::{Path, RawQuery, State};
use axum::Json;
use chrono::{Duration, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

/// Default range: the last 30 days (today included).
pub const DEFAULT_SPAN_DAYS: i64 = 30;
/// Longest range for per-day / per-node results.
pub const MAX_SPAN_DAYS: i64 = 366;
/// Longest range for `group=month`.
pub const MAX_MONTH_SPAN_DAYS: i64 = 3660;
/// Default / maximum `limit` (top users, top nodes).
pub const DEFAULT_LIMIT: i64 = 20;
pub const MAX_LIMIT: i64 = 100;

/// Saturating sum of a bigint column (sum() is numeric).
macro_rules! s {
    ($c:literal) => {
        concat!("LEAST(sum(", $c, "), 9223372036854775807)::bigint")
    };
}
const SUMS: &str = concat!(
    s!("up_bytes"),
    " AS up_bytes, ",
    s!("down_bytes"),
    " AS down_bytes, ",
    s!("billed_bytes"),
    " AS billed_bytes"
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Day,
    Node,
    Month,
}

impl Group {
    fn as_str(self) -> &'static str {
        match self {
            Group::Day => "day",
            Group::Node => "node",
            Group::Month => "month",
        }
    }
}

/// Which parameters an endpoint accepts (anything else is a 400).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Params {
    /// from, to, group (admin user history)
    User,
    /// from, to, limit (admin node history, fleet summary)
    Top,
    /// from, to (the user's own history)
    Me,
}

impl Params {
    fn allows(self, key: &str) -> bool {
        match key {
            "from" | "to" => true,
            "group" => self == Params::User,
            "limit" => self == Params::Top,
            _ => false,
        }
    }
}

/// A validated history request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Range {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub group: Group,
    pub limit: i64,
}

fn earliest() -> NaiveDate {
    NaiveDate::from_ymd_opt(2000, 1, 1).expect("valid date")
}

fn latest() -> NaiveDate {
    NaiveDate::from_ymd_opt(2999, 12, 31).expect("valid date")
}

/// Strict `YYYY-MM-DD` within [2000-01-01, 2999-12-31].
fn parse_day(v: &str) -> Option<NaiveDate> {
    let b = v.as_bytes();
    let shape = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !shape {
        return None;
    }
    NaiveDate::parse_from_str(v, "%Y-%m-%d")
        .ok()
        .filter(|d| (earliest()..=latest()).contains(d))
}

/// Parse and validate a history query string (`today` = the current UTC
/// day). Pure; every error is a short message for a 400.
pub fn parse_query(raw: Option<&str>, today: NaiveDate, params: Params) -> Result<Range, String> {
    let (mut from, mut to, mut group, mut limit) = (None, None, None, None);
    let raw = raw.unwrap_or("");
    if raw.len() > 256 {
        return Err("query too long".into());
    }
    for (k, v) in form_urlencoded::parse(raw.as_bytes()) {
        if !params.allows(&k) {
            return Err("unknown parameter".into());
        }
        let slot_taken = match &*k {
            "from" => from.replace(v.to_string()).is_some(),
            "to" => to.replace(v.to_string()).is_some(),
            "group" => group.replace(v.to_string()).is_some(),
            _ => limit.replace(v.to_string()).is_some(),
        };
        if slot_taken {
            return Err("duplicate parameter".into());
        }
    }
    let group = match group.as_deref() {
        None | Some("day") => Group::Day,
        Some("node") => Group::Node,
        Some("month") => Group::Month,
        Some(_) => return Err("group must be day, node or month".into()),
    };
    let limit = match limit.as_deref() {
        None => DEFAULT_LIMIT,
        Some(v) => match v.parse::<i64>() {
            Ok(n) if (1..=MAX_LIMIT).contains(&n) && v.bytes().all(|c| c.is_ascii_digit()) => n,
            _ => return Err(format!("limit must be 1..={MAX_LIMIT}")),
        },
    };
    let day = |v: Option<String>, name: &str| -> Result<Option<NaiveDate>, String> {
        v.map(|s| parse_day(&s).ok_or_else(|| format!("{name} must be a date YYYY-MM-DD")))
            .transpose()
    };
    let from = day(from, "from")?;
    let to = day(to, "to")?.unwrap_or_else(|| match from {
        // Only `from`: up to the default span after it (never past today
        // unless `from` itself is).
        Some(f) => (f + Duration::days(DEFAULT_SPAN_DAYS - 1)).min(today.max(f)),
        None => today,
    });
    let from = match from {
        Some(f) => f,
        None => (to - Duration::days(DEFAULT_SPAN_DAYS - 1)).max(earliest()),
    };
    if from > to {
        return Err("from must not be after to".into());
    }
    let max = if group == Group::Month {
        MAX_MONTH_SPAN_DAYS
    } else {
        MAX_SPAN_DAYS
    };
    if (to - from).num_days() + 1 > max {
        return Err(format!("range longer than {max} days"));
    }
    Ok(Range {
        from,
        to,
        group,
        limit,
    })
}

/// Bytes of a period: raw accepted up/down and the billed charge.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct Bytes {
    pub up_bytes: i64,
    pub down_bytes: i64,
    pub billed_bytes: i64,
}

impl Bytes {
    fn add(self, o: Bytes) -> Bytes {
        Bytes {
            up_bytes: self.up_bytes.saturating_add(o.up_bytes),
            down_bytes: self.down_bytes.saturating_add(o.down_bytes),
            billed_bytes: self.billed_bytes.saturating_add(o.billed_bytes),
        }
    }
}

fn total<'a>(it: impl Iterator<Item = &'a Bytes>) -> Bytes {
    it.fold(Bytes::default(), |a, b| a.add(*b))
}

/// One day (or month: its first day) of a user's history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct DayRow {
    pub day: NaiveDate,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub bytes: Bytes,
}

/// One node of a user's history (admin view: id + current name; name null
/// = deleted node).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct NodeRow {
    pub node_id: Uuid,
    pub name: Option<String>,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub bytes: Bytes,
}

/// One day of a node (or of the fleet): `users` = distinct users with
/// traffic on the node that day (fleet: summed over nodes, i.e. user-node
/// pairs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct NodeDayRow {
    pub day: NaiveDate,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub bytes: Bytes,
    pub users: i64,
}

/// A top user of a node (login null = deleted user).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct UserRow {
    pub user_id: Uuid,
    pub login: Option<String>,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub bytes: Bytes,
}

/// One node of the user's own history: its public name, or null for nodes
/// that are hidden or gone (merged into one row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct MyNodeRow {
    pub name: Option<String>,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub bytes: Bytes,
}

/// A user's history per day (rows only for days with traffic).
pub async fn user_days(
    pg: &sqlx::PgPool,
    user: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<DayRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT day, {SUMS} FROM traffic_daily \
         WHERE user_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day ORDER BY day"
    )))
    .bind(user)
    .bind(from)
    .bind(to)
    .fetch_all(pg)
    .await
}

/// A user's history per node over the range, most billed first.
pub async fn user_nodes(
    pg: &sqlx::PgPool,
    user: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<NodeRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT t.node_id, coalesce(n.display_name, n.name) AS name, \
                t.up_bytes, t.down_bytes, t.billed_bytes \
         FROM (SELECT node_id, {SUMS} FROM traffic_daily \
               WHERE user_id = $1 AND day BETWEEN $2 AND $3 GROUP BY node_id) t \
         LEFT JOIN nodes n ON n.id = t.node_id \
         ORDER BY t.billed_bytes DESC, t.up_bytes + t.down_bytes DESC, t.node_id"
    )))
    .bind(user)
    .bind(from)
    .bind(to)
    .fetch_all(pg)
    .await
}

/// A user's history per UTC calendar month over the whole months
/// [month of `from`, month of `to`]: rolled-up months plus the daily rows
/// still kept (a day is in exactly one of the two tables).
pub async fn user_months(
    pg: &sqlx::PgPool,
    user: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<DayRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT day, {SUMS} FROM ( \
            SELECT month AS day, up_bytes, down_bytes, billed_bytes FROM traffic_monthly \
            WHERE user_id = $1 AND month BETWEEN date_trunc('month', $2::date)::date \
                                         AND date_trunc('month', $3::date)::date \
            UNION ALL \
            SELECT date_trunc('month', day)::date, up_bytes, down_bytes, billed_bytes \
            FROM traffic_daily \
            WHERE user_id = $1 AND day >= date_trunc('month', $2::date)::date \
              AND day < (date_trunc('month', $3::date) + interval '1 month')::date \
         ) t GROUP BY day ORDER BY day"
    )))
    .bind(user)
    .bind(from)
    .bind(to)
    .fetch_all(pg)
    .await
}

/// A node per day (from traffic_node_daily).
pub async fn node_days(
    pg: &sqlx::PgPool,
    node: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<NodeDayRow>> {
    sqlx::query_as(
        "SELECT day, up_bytes, down_bytes, billed_bytes, users::bigint AS users \
         FROM traffic_node_daily WHERE node_id = $1 AND day BETWEEN $2 AND $3 ORDER BY day",
    )
    .bind(node)
    .bind(from)
    .bind(to)
    .fetch_all(pg)
    .await
}

/// A node's top `limit` users by raw bytes over the range.
pub async fn node_top_users(
    pg: &sqlx::PgPool,
    node: Uuid,
    from: NaiveDate,
    to: NaiveDate,
    limit: i64,
) -> sqlx::Result<Vec<UserRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT t.user_id, u.login, t.up_bytes, t.down_bytes, t.billed_bytes \
         FROM (SELECT user_id, {SUMS} FROM traffic_daily \
               WHERE node_id = $1 AND day BETWEEN $2 AND $3 GROUP BY user_id \
               ORDER BY sum(up_bytes) + sum(down_bytes) DESC, user_id LIMIT $4) t \
         LEFT JOIN users u ON u.id = t.user_id \
         ORDER BY t.up_bytes::numeric + t.down_bytes DESC, t.user_id"
    )))
    .bind(node)
    .bind(from)
    .bind(to)
    .bind(limit)
    .fetch_all(pg)
    .await
}

/// The fleet per day: every node's traffic_node_daily rows summed (deleted
/// nodes included). `users` = user-node pairs with traffic.
pub async fn fleet_days(
    pg: &sqlx::PgPool,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<NodeDayRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT day, {SUMS}, sum(users)::bigint AS users FROM traffic_node_daily \
         WHERE day BETWEEN $1 AND $2 GROUP BY day ORDER BY day"
    )))
    .bind(from)
    .bind(to)
    .fetch_all(pg)
    .await
}

/// The fleet's top `limit` nodes by raw bytes over the range.
pub async fn fleet_top_nodes(
    pg: &sqlx::PgPool,
    from: NaiveDate,
    to: NaiveDate,
    limit: i64,
) -> sqlx::Result<Vec<NodeRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT t.node_id, coalesce(n.display_name, n.name) AS name, \
                t.up_bytes, t.down_bytes, t.billed_bytes \
         FROM (SELECT node_id, {SUMS} FROM traffic_node_daily \
               WHERE day BETWEEN $1 AND $2 GROUP BY node_id \
               ORDER BY sum(up_bytes) + sum(down_bytes) DESC, node_id LIMIT $3) t \
         LEFT JOIN nodes n ON n.id = t.node_id \
         ORDER BY t.up_bytes::numeric + t.down_bytes DESC, t.node_id"
    )))
    .bind(from)
    .bind(to)
    .bind(limit)
    .fetch_all(pg)
    .await
}

/// The user's own per-node view: public names only (display name or name,
/// as in /me/nodes); nodes hidden from users or deleted are merged into
/// one row with a null name.
pub async fn my_nodes(
    pg: &sqlx::PgPool,
    user: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<MyNodeRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT name, {SUMS} FROM ( \
            SELECT CASE WHEN n.visible AND n.deleting_at IS NULL \
                        THEN coalesce(n.display_name, n.name) END AS name, \
                   t.up_bytes, t.down_bytes, t.billed_bytes \
            FROM (SELECT node_id, {SUMS} FROM traffic_daily \
                  WHERE user_id = $1 AND day BETWEEN $2 AND $3 GROUP BY node_id) t \
            LEFT JOIN nodes n ON n.id = t.node_id) x \
         GROUP BY name \
         ORDER BY name IS NULL, sum(billed_bytes) DESC, name"
    )))
    .bind(user)
    .bind(from)
    .bind(to)
    .fetch_all(pg)
    .await
}

/// The current UTC day (the history's day boundary).
fn today() -> NaiveDate {
    Utc::now().date_naive()
}

fn parse(raw: Option<String>, params: Params) -> Result<Range, ApiError> {
    parse_query(raw.as_deref(), today(), params).map_err(ApiError::bad_request)
}

/// First day still kept per day (older days are monthly only); None =
/// days are kept forever.
fn daily_since(state: &AppState) -> Option<NaiveDate> {
    match state.cfg().traffic.daily_retention_days {
        0 => None,
        n => Some(today() - Duration::days(n as i64)),
    }
}

async fn exists(pg: &sqlx::PgPool, sql: &'static str, id: Uuid) -> Result<(), ApiError> {
    let found: bool = sqlx::query_scalar(sql).bind(id).fetch_one(pg).await?;
    if found {
        Ok(())
    } else {
        Err(ApiError::not_found())
    }
}

/// GET /users/{id}/traffic?from&to&group=day|node|month (admin).
pub async fn user_traffic(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let r = parse(q, Params::User)?;
    let pg = state.pg();
    exists(pg, "SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)", id).await?;
    let (rows, sum) = match r.group {
        Group::Day | Group::Month => {
            let rows = if r.group == Group::Day {
                user_days(pg, id, r.from, r.to).await?
            } else {
                user_months(pg, id, r.from, r.to).await?
            };
            let sum = total(rows.iter().map(|d| &d.bytes));
            (
                serde_json::to_value(rows).map_err(anyhow::Error::from)?,
                sum,
            )
        }
        Group::Node => {
            let rows = user_nodes(pg, id, r.from, r.to).await?;
            let sum = total(rows.iter().map(|d| &d.bytes));
            (
                serde_json::to_value(rows).map_err(anyhow::Error::from)?,
                sum,
            )
        }
    };
    Ok(Json(json!({
        "from": r.from,
        "to": r.to,
        "timezone": "UTC",
        "group": r.group.as_str(),
        "daily_since": daily_since(&state),
        "rows": rows,
        "total": sum,
    })))
}

/// GET /nodes/{id}/traffic?from&to&limit (admin): per day + top users.
pub async fn node_traffic(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let r = parse(q, Params::Top)?;
    let pg = state.pg();
    exists(pg, "SELECT EXISTS (SELECT 1 FROM nodes WHERE id = $1)", id).await?;
    let days = node_days(pg, id, r.from, r.to).await?;
    let top = node_top_users(pg, id, r.from, r.to, r.limit).await?;
    Ok(Json(json!({
        "from": r.from,
        "to": r.to,
        "timezone": "UTC",
        "daily_since": daily_since(&state),
        "total": total(days.iter().map(|d| &d.bytes)),
        "days": days,
        "top_users": top,
    })))
}

/// GET /traffic/summary?from&to&limit (admin): fleet totals per day + top
/// nodes (the admin dashboard's source).
pub async fn summary(
    State(state): State<AppState>,
    user: AuthUser,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let r = parse(q, Params::Top)?;
    let pg = state.pg();
    let days = fleet_days(pg, r.from, r.to).await?;
    let top = fleet_top_nodes(pg, r.from, r.to, r.limit).await?;
    Ok(Json(json!({
        "from": r.from,
        "to": r.to,
        "timezone": "UTC",
        "total": total(days.iter().map(|d| &d.bytes)),
        "days": days,
        "top_nodes": top,
    })))
}

/// GET /me/traffic?from&to (user portal): the caller's own history per day
/// and per node name.
pub async fn my_traffic(
    State(state): State<AppState>,
    user: AuthUser,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let r = parse(q, Params::Me)?;
    let pg = state.pg();
    let days = user_days(pg, user.id, r.from, r.to).await?;
    let nodes = my_nodes(pg, user.id, r.from, r.to).await?;
    Ok(Json(json!({
        "from": r.from,
        "to": r.to,
        "timezone": "UTC",
        "daily_since": daily_since(&state),
        "total": total(days.iter().map(|d| &d.bytes)),
        "days": days,
        "nodes": nodes,
    })))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::get;
    axum::Router::new()
        .route("/{prefix}/api/v1/users/{id}/traffic", get(user_traffic))
        .route("/{prefix}/api/v1/nodes/{id}/traffic", get(node_traffic))
        .route("/{prefix}/api/v1/traffic/summary", get(summary))
        .route("/{prefix}/api/v1/me/traffic", get(my_traffic))
}

#[cfg(test)]
mod tests;
