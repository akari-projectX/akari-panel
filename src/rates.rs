//! D9 (PLAN-v0.4, W28-b): time-window multipliers on entrances.
//!
//! An entrance has a base multiplier (`entrances.rate_permille`, PATCH
//! /entrances/{id}) and up to `MAX_RULES` rules (migration 1038): weekdays,
//! a window in the site time zone and a multiplier. Where rules overlap the
//! highest applies (`PUT` answers with overlap warnings); outside every
//! rule the base applies. The SQL function `akari_entrance_rate(entrance,
//! at)` is the only definition: settlement (`traffic::FLUSH_SQL`, the lower
//! of now and 30 s ago: never over-bills), subscriptions, `/me/nodes`,
//! `/me/traffic` and the admin views (`rate_now`) all read it. Rules do not
//! bump the agent (settlement only).
//!
//! `PUT /entrances/{id}/rate-rules {rules: [{weekdays, start, end, rate}]}`
//! replaces the rules in one transaction (audited
//! `entrance.rate_rules.set`).

use axum::Json;
use axum::extract::{Path, State};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request};
use crate::state::AppState;

/// Rules per entrance (the `entrance_rate_rules_ord_range` CHECK).
pub const MAX_RULES: usize = 24;

const MINUTES_PER_DAY: u32 = 1440;
const WEEKDAY_ZH: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/// One rule as the API takes it: ISO weekdays (1 = Monday .. 7 = Sunday),
/// "HH:MM" start and end in the site time zone (end "24:00" = midnight;
/// an end before the start crosses midnight into the next day), and the
/// multiplier (0-100, at most 3 decimals).
#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct RuleReq {
    pub weekdays: Vec<i16>,
    pub start: String,
    pub end: String,
    pub rate: f64,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct SetRulesReq {
    pub rules: Vec<RuleReq>,
}

/// A validated rule (minutes of the day, permille).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub weekdays: Vec<i16>,
    pub start: i16,
    pub end: i16,
    pub permille: i32,
}

/// "HH:MM" -> minutes of the day; "24:00" only as an end.
fn minutes(s: &str, end: bool) -> Option<i16> {
    let (h, m) = s.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (i16, i16) = (h.parse().ok()?, m.parse().ok()?);
    match (h, m) {
        (24, 0) if end => Some(1440),
        (0..=23, 0..=59) => Some(h * 60 + m),
        _ => None,
    }
}

fn invalid(index: usize, detail: &str) -> ApiError {
    bad_request!(
        "entrance.rate_rule_invalid",
        "rule {index}: {detail}",
        index = index + 1,
        detail = detail
    )
}

/// Validate the requested rules (in order).
pub fn parse(reqs: &[RuleReq]) -> Result<Vec<Rule>, ApiError> {
    if reqs.len() > MAX_RULES {
        return Err(bad_request!(
            "entrance.rate_rules_too_many",
            "at most {max} rules per entrance",
            max = MAX_RULES
        ));
    }
    reqs.iter()
        .enumerate()
        .map(|(i, r)| {
            let mut days = r.weekdays.clone();
            days.sort_unstable();
            days.dedup();
            if days.is_empty() || days.iter().any(|d| !(1..=7).contains(d)) {
                return Err(invalid(i, "weekdays must be 1 (Monday) to 7 (Sunday)"));
            }
            let start = minutes(&r.start, false)
                .ok_or_else(|| invalid(i, "start must be HH:MM (00:00-23:59)"))?;
            // An end of 00:00 is midnight at the end of the day (24:00).
            let end = match minutes(&r.end, true) {
                Some(0) => 1440,
                Some(m) => m,
                None => return Err(invalid(i, "end must be HH:MM (00:00-24:00)")),
            };
            if start == end {
                return Err(invalid(i, "start and end must differ"));
            }
            Ok(Rule {
                weekdays: days,
                start,
                end,
                permille: crate::entrances::rate_permille(r.rate)?,
            })
        })
        .collect()
}

/// The rule's windows as minute ranges of the week [a, b) (Monday 00:00 =
/// 0), split at the end of the week.
fn segments(r: &Rule) -> Vec<(u32, u32)> {
    let week = 7 * MINUTES_PER_DAY;
    let (s, e) = (r.start as u32, r.end as u32);
    let len = if e > s {
        e - s
    } else {
        MINUTES_PER_DAY - s + e
    };
    let mut out = Vec::new();
    for d in &r.weekdays {
        let a = (*d as u32 - 1) * MINUTES_PER_DAY + s;
        let b = a + len;
        if b <= week {
            out.push((a, b));
        } else {
            out.push((a, week));
            out.push((0, b - week));
        }
    }
    out
}

fn clock(m: u32) -> String {
    format!("{:02}:{:02}", m / 60, m % 60)
}

/// The first overlapping minute range of the week of two rules.
fn overlap(a: &Rule, b: &Rule) -> Option<(u32, u32)> {
    let mut best: Option<(u32, u32)> = None;
    for (a0, a1) in segments(a) {
        for (b0, b1) in segments(b) {
            let (lo, hi) = (a0.max(b0), a1.min(b1));
            if lo < hi && best.is_none_or(|(x, _)| lo < x) {
                best = Some((lo, hi));
            }
        }
    }
    best
}

/// Warnings for rules that overlap (Chinese, shown as they are): where,
/// and which multiplier applies there (the highest).
pub fn overlap_warnings(rules: &[Rule]) -> Vec<String> {
    let mut w = Vec::new();
    for (i, a) in rules.iter().enumerate() {
        for (j, b) in rules.iter().enumerate().skip(i + 1) {
            if let Some((lo, hi)) = overlap(a, b) {
                let day = WEEKDAY_ZH[(lo / MINUTES_PER_DAY) as usize % 7];
                let end = if hi % MINUTES_PER_DAY == 0 && hi > lo {
                    "24:00".to_string()
                } else {
                    clock(hi % MINUTES_PER_DAY)
                };
                w.push(format!(
                    "规则 {} 与规则 {} 的时段重叠（如 {day} {}–{end}）：重叠时按较高的倍率 {} 计费",
                    i + 1,
                    j + 1,
                    clock(lo % MINUTES_PER_DAY),
                    crate::sub::proxy::rate_label(a.permille.max(b.permille)),
                ));
            }
        }
    }
    w
}

fn rules_json(rules: &[Rule]) -> Value {
    Value::Array(
        rules
            .iter()
            .map(|r| {
                json!({"weekdays": r.weekdays, "start": r.start, "end": r.end,
                       "rate": f64::from(r.permille) / 1000.0})
            })
            .collect(),
    )
}

/// Replace an entrance's rules in the caller's transaction: lock its
/// server (409 `server.deleting`) and the entrance, replace, audit
/// `entrance.rate_rules.set` (before/after). Returns the overlap warnings.
pub async fn apply_set_rules(
    conn: &mut PgConnection,
    actor: &Actor,
    entrance: Uuid,
    rules: &[Rule],
) -> Result<Vec<String>, ApiError> {
    let server: Option<Uuid> = sqlx::query_scalar("SELECT server_id FROM entrances WHERE id = $1")
        .bind(entrance)
        .fetch_optional(&mut *conn)
        .await?;
    let server = server.ok_or_else(ApiError::not_found)?;
    crate::servers::lock_server(conn, server).await?;
    let found: Option<Value> = sqlx::query_scalar(
        "SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('weekdays', r.weekdays, \
            'start', r.start_minute, 'end', r.end_minute, \
            'rate', r.rate_permille::float8 / 1000) ORDER BY r.ord), '[]'::jsonb) \
            FROM entrance_rate_rules r WHERE r.entrance_id = e.id) \
         FROM entrances e WHERE e.id = $1 FOR UPDATE",
    )
    .bind(entrance)
    .fetch_optional(&mut *conn)
    .await?;
    let before = found.ok_or_else(ApiError::not_found)?;
    // A rule change is a rate change (1100): for the settlement window the
    // bytes moved before it bill at most at the old configuration's rate.
    sqlx::query(
        "UPDATE entrances SET rate_prev_permille = akari_entrance_settle_rate(id), \
         rate_changed_at = statement_timestamp() WHERE id = $1",
    )
    .bind(entrance)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM entrance_rate_rules WHERE entrance_id = $1")
        .bind(entrance)
        .execute(&mut *conn)
        .await?;
    for (ord, r) in rules.iter().enumerate() {
        sqlx::query(
            "INSERT INTO entrance_rate_rules \
             (entrance_id, ord, weekdays, start_minute, end_minute, rate_permille) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(entrance)
        .bind(ord as i16)
        .bind(&r.weekdays)
        .bind(r.start)
        .bind(r.end)
        .bind(r.permille)
        .execute(&mut *conn)
        .await?;
    }
    crate::audit::record(
        conn,
        actor,
        "entrance.rate_rules.set",
        "entrance",
        Some(entrance.to_string()),
        Some(before),
        Some(rules_json(rules)),
    )
    .await?;
    Ok(overlap_warnings(rules))
}

/// PUT /entrances/{id}/rate-rules (admin): `{entrance, warnings}`.
pub async fn set_rules(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<SetRulesReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let rules = parse(&req.rules)?;
    let mut tx = state.pg().begin().await?;
    let warnings = apply_set_rules(&mut tx, &Actor::of(&user), id, &rules).await?;
    let v = crate::entrances::view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(json!({ "entrance": v, "warnings": warnings })))
}

#[cfg(test)]
mod tests;
