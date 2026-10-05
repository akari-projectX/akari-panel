//! W28-a (PLAN-v0.4 section 5): entrances — how clients reach a node.
//!
//! Every node has one built-in `direct` entrance (created with the node by
//! the `nodes_direct_entrance` trigger, migration 1030; it can be disabled,
//! not deleted). An entrance carries what used to be per-node client-facing
//! settings: the address/port clients dial (subscriptions), the traffic
//! multiplier (settled per entrance by `traffic::FLUSH_SQL`) and the node
//! groups it belongs to (access: plans -> node groups -> entrances,
//! `entitle.rs`). Each entrance serves its own xray inbound with its own
//! per-user credentials (`entrance_users`).
//!
//! What changes the agent's desired state bumps the node in the same
//! transaction: enabling/disabling an entrance (its inbound appears or
//! goes away: config_version) and group membership (via the reconcile:
//! user_version). Name, address, port, multiplier and sort only affect
//! subscriptions and settlement (no bump).

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::{ApiJson, double_option, non_null};
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::entitle::{self, Outcome, Scope};
use crate::state::AppState;

/// The built-in entrance kind.
pub const DIRECT: &str = "direct";

/// Tag of the inbound the direct entrance serves on the agent (the stored
/// node inbound has none; the panel names it when rendering the agent's
/// config).
pub const DIRECT_TAG: &str = "direct";

pub const MAX_NAME_CHARS: usize = 64;

/// SQL expression (one row per node aliased `nodes`): the node's entrances
/// as a JSON array, direct first, then by sort. Each element is the shape
/// of `EntranceView` (what the admin API returns).
pub const ENTRANCES_JSON_SQL: &str = "coalesce((SELECT jsonb_agg(jsonb_build_object( \
     'id', e.id, 'kind', e.kind, 'name', e.name, \
     'connect_host', e.connect_host, 'connect_port', e.connect_port, \
     'rate_permille', e.rate_permille, 'rate', e.rate_permille::float8 / 1000, \
     'enabled', e.enabled, 'sort', e.sort, \
     'group_ids', coalesce((SELECT jsonb_agg(m.group_id ORDER BY m.group_id) \
        FROM entrance_group_members m WHERE m.entrance_id = e.id), '[]'::jsonb)) \
     ORDER BY e.kind <> 'direct', e.sort, e.created_at, e.id) \
     FROM entrances e WHERE e.node_id = nodes.id), '[]'::jsonb)";

/// One entrance as the admin API returns it (also embedded in NodeView via
/// `ENTRANCES_JSON_SQL`, same fields).
#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct EntranceView {
    pub id: Uuid,
    pub node_id: Uuid,
    pub kind: String,
    pub name: String,
    /// What clients dial: host (null = the node's TLS domain) and port
    /// (null = the inbound's port).
    pub connect_host: Option<String>,
    pub connect_port: Option<i32>,
    /// Traffic multiplier: permille and as a number (0.5 = half).
    pub rate_permille: i32,
    #[sqlx(skip)]
    pub rate: f64,
    pub enabled: bool,
    pub sort: i32,
    pub group_ids: Vec<Uuid>,
}

const ENTRANCE_VIEW_SQL: &str = "SELECT e.id, e.node_id, e.kind, e.name, e.connect_host, \
     e.connect_port, e.rate_permille, e.enabled, e.sort, \
     coalesce(ARRAY(SELECT m.group_id FROM entrance_group_members m \
        WHERE m.entrance_id = e.id ORDER BY m.group_id), '{}') AS group_ids \
     FROM entrances e WHERE e.id = $1";

pub async fn view(conn: &mut PgConnection, id: Uuid) -> Result<EntranceView, ApiError> {
    let mut v = sqlx::query_as::<_, EntranceView>(ENTRANCE_VIEW_SQL)
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(ApiError::not_found)?;
    v.rate = f64::from(v.rate_permille) / 1000.0;
    Ok(v)
}

/// The editable fields of an entrance (PATCH /entrances/{id}; also the
/// `direct` object of POST /nodes). Absent = unchanged; null clears the
/// nullable ones (host, port), refused for the others.
#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
pub struct EntranceReq {
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    /// Hostname or IP literal clients dial; null (or "") = the node's TLS
    /// domain.
    #[serde(default, deserialize_with = "double_option")]
    pub connect_host: Option<Option<String>>,
    /// 1..=65535; null = the inbound's port.
    #[serde(default, deserialize_with = "double_option")]
    pub connect_port: Option<Option<i32>>,
    /// Traffic multiplier 0..=100, at most 3 decimals.
    #[serde(default, deserialize_with = "double_option")]
    pub rate: Option<Option<f64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub enabled: Option<Option<bool>>,
    #[serde(default, deserialize_with = "double_option")]
    pub sort: Option<Option<i32>>,
    /// Node groups (the complete list; [] = none).
    #[serde(default, deserialize_with = "double_option")]
    pub group_ids: Option<Option<Vec<Uuid>>>,
}

impl EntranceReq {
    fn has_row_fields(&self) -> bool {
        self.name.is_some()
            || self.connect_host.is_some()
            || self.connect_port.is_some()
            || self.rate.is_some()
            || self.enabled.is_some()
            || self.sort.is_some()
    }

    pub fn is_empty(&self) -> bool {
        !self.has_row_fields() && self.group_ids.is_none()
    }
}

fn printable(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

/// Entrance name: trimmed, 1..=64 printable characters.
pub fn clean_name(v: &str) -> Result<String, ApiError> {
    let v = v.trim();
    if v.is_empty() || v.chars().count() > MAX_NAME_CHARS || !printable(v) {
        return Err(bad_request!(
            "entrance.name_invalid",
            "name must be 1-{max} printable characters",
            max = MAX_NAME_CHARS
        ));
    }
    Ok(v.to_string())
}

/// A hostname, IPv4 or IPv6 literal (no scheme, path, port, spaces);
/// brackets around an IPv6 literal are dropped.
pub fn valid_host(h: &str) -> bool {
    if h.is_empty() || h.len() > 253 {
        return false;
    }
    if h.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    h.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// "" / whitespace / null = cleared (None).
pub fn clean_host(v: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(h) = v.map(str::trim).filter(|h| !h.is_empty()) else {
        return Ok(None);
    };
    let h = h.trim_start_matches('[').trim_end_matches(']');
    if !valid_host(h) {
        return Err(bad_request!(
            "entrance.host_invalid",
            "connect_host must be a hostname or IP address"
        ));
    }
    Ok(Some(h.to_ascii_lowercase()))
}

pub fn clean_port(v: Option<i32>) -> Result<Option<i32>, ApiError> {
    match v {
        None => Ok(None),
        Some(p) if (1..=65535).contains(&p) => Ok(Some(p)),
        Some(_) => Err(bad_request!(
            "entrance.port_invalid",
            "connect_port must be 1-65535"
        )),
    }
}

/// The multiplier as an exact integer permille: 0..=100 with at most three
/// decimals (0.5 -> 500, 1.25 -> 1250); anything finer is refused rather
/// than rounded.
pub fn rate_permille(x: f64) -> Result<i32, ApiError> {
    let bad = || {
        bad_request!(
            "entrance.rate_invalid",
            "rate must be 0-100 with at most 3 decimals"
        )
    };
    if !x.is_finite() || !(0.0..=100.0).contains(&x) {
        return Err(bad());
    }
    let p = (x * 1000.0).round();
    if ((x * 1000.0) - p).abs() > 1e-6 {
        return Err(bad());
    }
    Ok(p as i32)
}

/// Validated row fields of a request (None = unchanged).
struct Clean {
    name: Option<String>,
    connect_host: Option<Option<String>>,
    connect_port: Option<Option<i32>>,
    rate: Option<i32>,
    enabled: Option<bool>,
    sort: Option<i32>,
    groups: Option<Vec<Uuid>>,
}

fn clean(req: &EntranceReq) -> Result<Clean, ApiError> {
    let groups = non_null("group_ids", &req.group_ids)?.map(|g| {
        let mut g = g;
        g.sort();
        g.dedup();
        g
    });
    Ok(Clean {
        name: non_null("name", &req.name)?
            .map(|n| clean_name(&n))
            .transpose()?,
        connect_host: req
            .connect_host
            .as_ref()
            .map(|h| clean_host(h.as_deref()))
            .transpose()?,
        connect_port: req
            .connect_port
            .as_ref()
            .map(|p| clean_port(*p))
            .transpose()?,
        rate: non_null("rate", &req.rate)?
            .map(rate_permille)
            .transpose()?,
        enabled: non_null("enabled", &req.enabled)?,
        sort: non_null("sort", &req.sort)?
            .map(crate::nodemeta::sort)
            .transpose()?,
        groups,
    })
}

/// Update an entrance in the caller's transaction: `entitle::lock` (when
/// the groups change) -> the node row (FOR UPDATE; refused while the node is
/// being deleted) -> the entrance -> membership + reconcile of this
/// entrance -> audit `entrance.update`. Enabling/disabling bumps the node's
/// config_version (its inbound set changes). Returns the reconcile outcome.
pub async fn apply_update(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &EntranceReq,
) -> Result<Outcome, ApiError> {
    if req.is_empty() {
        return Err(bad_request!("request.no_fields", "no fields to update"));
    }
    let c = clean(req)?;
    if c.groups.is_some() {
        entitle::lock(conn).await?;
    }
    let node: Option<(Uuid, bool)> = sqlx::query_as(
        "SELECT n.id, n.deleting_at IS NOT NULL FROM entrances e JOIN nodes n ON n.id = e.node_id \
         WHERE e.id = $1 FOR UPDATE OF n",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((node, deleting)) = node else {
        return Err(ApiError::not_found());
    };
    if deleting {
        return Err(conflict!("node.deleting", "node is being deleted"));
    }
    let mut qb = sqlx::QueryBuilder::new("UPDATE entrances SET updated_at = now()");
    if let Some(v) = &c.name {
        qb.push(", name = ").push_bind(v.clone());
    }
    if let Some(v) = &c.connect_host {
        qb.push(", connect_host = ").push_bind(v.clone());
    }
    if let Some(v) = c.connect_port {
        qb.push(", connect_port = ").push_bind(v);
    }
    if let Some(v) = c.rate {
        qb.push(", rate_permille = ").push_bind(v);
    }
    if let Some(v) = c.enabled {
        qb.push(", enabled = ").push_bind(v);
    }
    if let Some(v) = c.sort {
        qb.push(", sort = ").push_bind(v);
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.push(format!(
        " RETURNING {}, {}, old.enabled <> new.enabled",
        crate::audit::entrance_snapshot_sql("old"),
        crate::audit::entrance_snapshot_sql("new")
    ));
    let (mut before, mut after, toggled): (serde_json::Value, serde_json::Value, bool) =
        qb.build_query_as().fetch_one(&mut *conn).await?;
    if toggled {
        sqlx::query("UPDATE nodes SET config_version = config_version + 1 WHERE id = $1")
            .bind(node)
            .execute(&mut *conn)
            .await?;
    }
    let mut outcome = Outcome::default();
    if let Some(groups) = &c.groups {
        let old = set_groups(conn, id, groups).await?;
        if old != *groups {
            outcome = entitle::apply_reconcile(conn, Scope::Entrances(&[id])).await?;
        }
        before["group_ids"] = json!(old);
        after["group_ids"] = json!(groups);
        after["entitlement"] = outcome.summary();
    }
    crate::audit::record(
        conn,
        actor,
        "entrance.update",
        "entrance",
        Some(id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(outcome)
}

/// Replace the entrance's group membership (caller holds `entitle::lock`
/// and the node row); returns the previous groups (sorted). 400 for an
/// unknown group.
async fn set_groups(
    conn: &mut PgConnection,
    entrance: Uuid,
    groups: &[Uuid],
) -> Result<Vec<Uuid>, ApiError> {
    let found: i64 = sqlx::query_scalar("SELECT count(*) FROM node_groups WHERE id = ANY($1)")
        .bind(groups)
        .fetch_one(&mut *conn)
        .await?;
    if found != groups.len() as i64 {
        return Err(bad_request!("group.unknown", "unknown group id"));
    }
    let old: Vec<Uuid> = sqlx::query_scalar(
        "SELECT group_id FROM entrance_group_members WHERE entrance_id = $1 ORDER BY group_id",
    )
    .bind(entrance)
    .fetch_all(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM entrance_group_members WHERE entrance_id = $1 AND NOT group_id = ANY($2)",
    )
    .bind(entrance)
    .bind(groups)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO entrance_group_members (group_id, entrance_id) \
         SELECT unnest($2::uuid[]), $1 ON CONFLICT DO NOTHING",
    )
    .bind(entrance)
    .bind(groups)
    .execute(&mut *conn)
    .await?;
    Ok(old)
}

/// The node's direct entrance.
pub async fn direct_of(conn: &mut PgConnection, node: Uuid) -> sqlx::Result<Option<Uuid>> {
    sqlx::query_scalar("SELECT id FROM entrances WHERE node_id = $1 AND kind = 'direct'")
        .bind(node)
        .fetch_optional(conn)
        .await
}

/// PATCH /entrances/{id} (admin).
pub async fn update_entrance(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<EntranceReq>,
) -> Result<Json<EntranceView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_update(&mut tx, &Actor::of(&user), id, &req).await?;
    let v = view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(v))
}

#[cfg(test)]
mod tests;
