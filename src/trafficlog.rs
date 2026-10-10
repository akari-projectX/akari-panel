//! W22: traffic history — per user, per entrance (W28-a; with its node),
//! per day in the site time zone (Q3).
//!
//! `traffic::FLUSH_SQL` stages the accepted deltas in the same statement
//! that bills the users, and `traffic::compact_pass` folds them into
//! `traffic_daily` (user, day, entrance; node kept) and
//! `traffic_entrance_daily` (entrance, day; node kept): the history is
//! built from exactly the settled deltas, as idempotent as the settlement, and Σ billed_bytes of a user's rows is
//! what was added to users.traffic_used_bytes. `traffic::rollup_pass` moves
//! days older than `traffic.daily_retention_days` into `traffic_monthly`.
//!
//! This module is the read side: a strict query-string parser (fuzzed:
//! `parse_query`), the queries (public, for the admin dashboard) and the
//! four endpoints:
//!
//! - admin `GET /users/{id}/traffic?from&to&group=day|entrance|month`
//! - admin `GET /nodes/{id}/traffic?from&to&limit` (per day + top users)
//! - admin `GET /entrances/{id}/traffic?from&to` (per day + the entrance's
//!   multiplier changes from the audit log)
//! - admin `GET /traffic/summary?from&to&limit` (fleet per day + top nodes)
//! - user `GET /me/traffic?from&to` (own rows only: per day, per entrance
//!   by public NAME with its multiplier now and its time-window rules; no
//!   ids; entrances of hidden or deleted nodes, and deleted entrances,
//!   merged into one unnamed row)
//!
//! Dates are `YYYY-MM-DD` days in the site time zone (Q3,
//! `panel_settings.timezone`, default Asia/Shanghai), `to` inclusive;
//! default the last 30 days; at most 366 days (month grouping: 3660,
//! widened to whole months).

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use chrono::{Duration, NaiveDate};
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::{ApiError, AuthUser};
use crate::settings::{SiteClock as Clock, site_clock};
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
    Entrance,
    Month,
}

impl Group {
    fn as_str(self) -> &'static str {
        match self {
            Group::Day => "day",
            Group::Entrance => "entrance",
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
    /// from, to (the user's own history, an entrance's history)
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

/// Parse and validate a history query string (`today` = the current day
/// in the site time zone). Pure; every error is a short message for a 400.
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
        Some("entrance") => Group::Entrance,
        Some("month") => Group::Month,
        Some(_) => return Err("group must be day, entrance or month".into()),
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

/// One entrance of a user's history (admin view, R43): ids, current names
/// (null = deleted), kind and the multiplier now (null = deleted).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct EntranceRow {
    pub entrance_id: Uuid,
    pub node_id: Uuid,
    pub entrance: Option<String>,
    pub kind: Option<String>,
    pub node: Option<String>,
    pub rate_now: Option<f64>,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub bytes: Bytes,
}

/// One node of the fleet's history (admin view: id + current name; name
/// null = deleted node).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct NodeRow {
    pub node_id: Uuid,
    pub name: Option<String>,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub bytes: Bytes,
}

/// One day of a node (or of the fleet): `users` = user-entrance pairs with
/// traffic that day (a user on two entrances of the node counts twice).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct NodeDayRow {
    pub day: NaiveDate,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub bytes: Bytes,
    pub users: i64,
}

/// A top user of a node (email null = deleted user).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct UserRow {
    pub user_id: Uuid,
    pub email: Option<String>,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub bytes: Bytes,
}

/// One entrance of the user's own history (next07: per entrance, so a
/// direct 1x and a relay 10x of one node are never mixed): the node's
/// public name and the entrance's name, or both null for the merged row of
/// hidden or gone ones.
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct MyEntranceRow {
    /// The entrance's name and tags (never the node's or the server's
    /// name); null / [] for the merged row.
    pub name: Option<String>,
    pub tags: Vec<String>,
    /// D9: the multiplier in effect now and the time-window rules
    /// (`[{weekdays, start, end, rate}]`, minutes of the day in the site
    /// time zone); null / [] for the merged row.
    pub rate: Option<f64>,
    pub rules: Value,
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub bytes: Bytes,
}

/// One multiplier change of an entrance (audit log): when, who (label and
/// current email, null for system/CLI or a deleted admin), what
/// (`entrance.create` / `entrance.update` with a different base /
/// `entrance.rate_rules.set`), base multiplier before/after (null when not
/// applicable), rules before/after (rule changes only).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct RateChange {
    pub at: chrono::DateTime<chrono::Utc>,
    pub actor_label: String,
    pub actor_email: Option<String>,
    pub action: String,
    pub rate_before: Option<f64>,
    pub rate_after: Option<f64>,
    pub rules_before: Option<Value>,
    pub rules_after: Option<Value>,
}

/// Most recent multiplier changes listed per entrance.
pub const RATE_CHANGES_LIMIT: i64 = 100;

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

/// A user's history per entrance over the range, most billed first.
pub async fn user_entrances(
    pg: &sqlx::PgPool,
    user: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<EntranceRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT t.entrance_id, t.node_id, e.name AS entrance, e.kind, \
                coalesce(n.display_name, n.name) AS node, \
                akari_entrance_rate(e.id, statement_timestamp())::float8 / 1000 AS rate_now, \
                t.up_bytes, t.down_bytes, t.billed_bytes \
         FROM (SELECT entrance_id, node_id, {SUMS} FROM traffic_daily \
               WHERE user_id = $1 AND day BETWEEN $2 AND $3 GROUP BY entrance_id, node_id) t \
         LEFT JOIN entrances e ON e.id = t.entrance_id \
         LEFT JOIN nodes n ON n.id = t.node_id \
         ORDER BY t.billed_bytes DESC, t.up_bytes::numeric + t.down_bytes DESC, t.entrance_id"
    )))
    .bind(user)
    .bind(from)
    .bind(to)
    .fetch_all(pg)
    .await
}

/// A user's history per calendar month (site days) over the whole months
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

/// A node per day (its entrances' traffic_entrance_daily rows summed).
pub async fn node_days(
    pg: &sqlx::PgPool,
    node: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<NodeDayRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT day, {SUMS}, sum(users)::bigint AS users FROM traffic_entrance_daily \
         WHERE node_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day ORDER BY day"
    )))
    .bind(node)
    .bind(from)
    .bind(to)
    .fetch_all(pg)
    .await
}

/// An entrance per day (traffic_entrance_daily).
pub async fn entrance_days(
    pg: &sqlx::PgPool,
    entrance: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<NodeDayRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT day, {SUMS}, sum(users)::bigint AS users FROM traffic_entrance_daily \
         WHERE entrance_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day ORDER BY day"
    )))
    .bind(entrance)
    .bind(from)
    .bind(to)
    .fetch_all(pg)
    .await
}

/// An entrance's multiplier changes from the audit log, newest first (at
/// most `RATE_CHANGES_LIMIT`; the log keeps `audit.retention_days`).
pub async fn rate_changes(pg: &sqlx::PgPool, entrance: Uuid) -> sqlx::Result<Vec<RateChange>> {
    sqlx::query_as(
        "SELECT a.at, a.actor_label, u.email AS actor_email, a.action, \
                CASE WHEN a.action <> 'entrance.rate_rules.set' \
                     THEN (a.before->>'rate_permille')::float8 / 1000 END AS rate_before, \
                CASE WHEN a.action <> 'entrance.rate_rules.set' \
                     THEN (a.after->>'rate_permille')::float8 / 1000 END AS rate_after, \
                CASE WHEN a.action = 'entrance.rate_rules.set' THEN a.before END AS rules_before, \
                CASE WHEN a.action = 'entrance.rate_rules.set' THEN a.after END AS rules_after \
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id \
         WHERE a.target_type = 'entrance' AND a.target_id = $1::text \
           AND (a.action IN ('entrance.create', 'entrance.rate_rules.set') \
                OR (a.action = 'entrance.update' \
                    AND a.before->'rate_permille' IS DISTINCT FROM a.after->'rate_permille')) \
         ORDER BY a.id DESC LIMIT $2",
    )
    .bind(entrance)
    .bind(RATE_CHANGES_LIMIT)
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
        "SELECT t.user_id, u.email, t.up_bytes, t.down_bytes, t.billed_bytes \
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

/// The fleet per day: every traffic_entrance_daily row summed (deleted
/// nodes and entrances included). `users` = user-entrance pairs with
/// traffic.
pub async fn fleet_days(
    pg: &sqlx::PgPool,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<NodeDayRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT day, {SUMS}, sum(users)::bigint AS users FROM traffic_entrance_daily \
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
         FROM (SELECT node_id, {SUMS} FROM traffic_entrance_daily \
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

/// The user's own per-entrance view: public names only (the entrance's name
/// and tags, as in /me/nodes; no node or server names); entrances of nodes
/// hidden from users or deleted, and deleted entrances, are merged into one
/// row with a null name. The multiplier is the one in effect now
/// (never a historical billed/raw ratio).
pub async fn my_entrances(
    pg: &sqlx::PgPool,
    user: Uuid,
    from: NaiveDate,
    to: NaiveDate,
) -> sqlx::Result<Vec<MyEntranceRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT name, tags, \
                CASE WHEN name IS NULL THEN NULL \
                     ELSE akari_entrance_rate(eid, statement_timestamp())::float8 / 1000 \
                END AS rate, \
                CASE WHEN name IS NULL THEN '[]'::jsonb ELSE ( \
                    SELECT coalesce(jsonb_agg(jsonb_build_object('weekdays', r.weekdays, \
                        'start', r.start_minute, 'end', r.end_minute, \
                        'rate', r.rate_permille::float8 / 1000) ORDER BY r.ord), '[]'::jsonb) \
                    FROM entrance_rate_rules r WHERE r.entrance_id = eid) END AS rules, \
            {SUMS} FROM ( \
            SELECT CASE WHEN v.shown THEN t.entrance_id END AS eid, \
                   CASE WHEN v.shown THEN e.name END AS name, \
                   CASE WHEN v.shown THEN e.tags ELSE '{{}}'::text[] END AS tags, \
                   t.up_bytes, t.down_bytes, t.billed_bytes \
            FROM (SELECT entrance_id, node_id, {SUMS} FROM traffic_daily \
                  WHERE user_id = $1 AND day BETWEEN $2 AND $3 GROUP BY entrance_id, node_id) t \
            LEFT JOIN entrances e ON e.id = t.entrance_id \
            LEFT JOIN nodes n ON n.id = t.node_id \
            LEFT JOIN servers s ON s.id = n.server_id \
            CROSS JOIN LATERAL (SELECT e.id IS NOT NULL AND coalesce(n.visible, false) \
                                       AND s.deleting_at IS NULL AS shown) v) x \
         GROUP BY eid, name, tags \
         ORDER BY name IS NULL, sum(billed_bytes) DESC, name, eid"
    )))
    .bind(user)
    .bind(from)
    .bind(to)
    .fetch_all(pg)
    .await
}

fn parse(raw: Option<String>, params: Params, clock: &Clock) -> Result<Range, ApiError> {
    parse_query(raw.as_deref(), clock.today, params).map_err(|e| {
        crate::auth::bad_request!("request.traffic_query_invalid", "{detail}", detail = e)
    })
}

/// First day surely kept per day (whole months older than it may be
/// monthly only: the retention moves whole months); None = days are kept
/// forever.
fn daily_since(state: &AppState, clock: &Clock) -> Option<NaiveDate> {
    match state.settings().get().traffic_daily_retention_days {
        0 => None,
        n => Some(clock.today - Duration::days(n as i64)),
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
    let pg = state.pg();
    let clock = site_clock(pg).await?;
    let r = parse(q, Params::User, &clock)?;
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
        Group::Entrance => {
            let rows = user_entrances(pg, id, r.from, r.to).await?;
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
        "timezone": clock.tz,
        "group": r.group.as_str(),
        "daily_since": daily_since(&state, &clock),
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
    let pg = state.pg();
    let clock = site_clock(pg).await?;
    let r = parse(q, Params::Top, &clock)?;
    exists(pg, "SELECT EXISTS (SELECT 1 FROM nodes WHERE id = $1)", id).await?;
    let days = node_days(pg, id, r.from, r.to).await?;
    let top = node_top_users(pg, id, r.from, r.to, r.limit).await?;
    Ok(Json(json!({
        "from": r.from,
        "to": r.to,
        "timezone": clock.tz,
        "daily_since": daily_since(&state, &clock),
        "total": total(days.iter().map(|d| &d.bytes)),
        "days": days,
        "top_users": top,
    })))
}

/// GET /entrances/{id}/traffic?from&to (admin): the entrance per day (raw,
/// billed, users) and its multiplier changes (audit log, all retained).
pub async fn entrance_traffic(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let pg = state.pg();
    let clock = site_clock(pg).await?;
    let r = parse(q, Params::Me, &clock)?;
    exists(
        pg,
        "SELECT EXISTS (SELECT 1 FROM entrances WHERE id = $1)",
        id,
    )
    .await?;
    let days = entrance_days(pg, id, r.from, r.to).await?;
    let changes = rate_changes(pg, id).await?;
    Ok(Json(json!({
        "from": r.from,
        "to": r.to,
        "timezone": clock.tz,
        "daily_since": daily_since(&state, &clock),
        "total": total(days.iter().map(|d| &d.bytes)),
        "days": days,
        "rate_changes": changes,
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
    let pg = state.pg();
    let clock = site_clock(pg).await?;
    let r = parse(q, Params::Top, &clock)?;
    let days = fleet_days(pg, r.from, r.to).await?;
    let top = fleet_top_nodes(pg, r.from, r.to, r.limit).await?;
    Ok(Json(json!({
        "from": r.from,
        "to": r.to,
        "timezone": clock.tz,
        "total": total(days.iter().map(|d| &d.bytes)),
        "days": days,
        "top_nodes": top,
    })))
}

/// GET /me/traffic?from&to (user portal): the caller's own history per day
/// and per entrance (public names, the multiplier now and its rules).
pub async fn my_traffic(
    State(state): State<AppState>,
    user: AuthUser,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let pg = state.pg();
    let clock = site_clock(pg).await?;
    let r = parse(q, Params::Me, &clock)?;
    let days = user_days(pg, user.id, r.from, r.to).await?;
    let entrances = my_entrances(pg, user.id, r.from, r.to).await?;
    Ok(Json(json!({
        "from": r.from,
        "to": r.to,
        "timezone": clock.tz,
        "daily_since": daily_since(&state, &clock),
        "total": total(days.iter().map(|d| &d.bytes)),
        "days": days,
        "entrances": entrances,
    })))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::get;
    axum::Router::new()
        .route("/{prefix}/api/v1/users/{id}/traffic", get(user_traffic))
        .route("/{prefix}/api/v1/nodes/{id}/traffic", get(node_traffic))
        .route(
            "/{prefix}/api/v1/entrances/{id}/traffic",
            get(entrance_traffic),
        )
        .route("/{prefix}/api/v1/traffic/summary", get(summary))
        .route("/{prefix}/api/v1/me/traffic", get(my_traffic))
}

#[cfg(test)]
mod tests;
