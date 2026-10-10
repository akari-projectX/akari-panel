//! W28-a (PLAN-v0.4 section 5): entrances — how clients reach a node.
//!
//! Every node has one built-in `direct` entrance (created with the node by
//! the `nodes_direct_entrance` trigger, migration 1030; it can be disabled,
//! not deleted) and any number of `relay` entrances (migration 1031): an
//! external relay (IPLC, a forwarding VPS) that forwards to the node. An
//! entrance carries the address/port clients dial (subscriptions), the
//! traffic multiplier (settled per entrance by `traffic::FLUSH_SQL`) and
//! the node groups it belongs to (access: plans -> node groups ->
//! entrances, `entitle.rs`). Each entrance is its own xray inbound on the
//! node with its own per-user credentials (`entrance_users`): the direct
//! entrance the node's inbound (tag `direct`), a relay its derived inbound
//! (`derived_inbounds`: the node's inbound on the relay's `listen_port`,
//! tag `e<wire_no>`), reachable only from the relay's egress addresses
//! (`source_cidrs`, enforced by the agent in the kernel).
//!
//! What changes the agent's desired state bumps the node in the same
//! transaction: creating/deleting an entrance, enabling/disabling it,
//! a relay's listen port or source networks (the inbound set changes:
//! config_version) and group membership (via the reconcile: user_version).
//! Name, address, multiplier and sort only affect subscriptions and
//! settlement (no bump).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
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
/// An external relay's entrance kind.
pub const RELAY: &str = "relay";

/// Tag of the inbound the direct entrance serves on the agent (the stored
/// node inbound has none; the panel names it when rendering the agent's
/// config).
pub const DIRECT_TAG: &str = "direct";

pub const MAX_NAME_CHARS: usize = 64;
/// Source networks per relay entrance (migration 1031 CHECK).
pub const MAX_SOURCE_CIDRS: usize = 64;

/// The agent-side inbound tag of the entrance numbered `wire_no` on its
/// node (0 = the direct entrance).
pub fn inbound_tag(wire_no: i32) -> String {
    if wire_no == 0 {
        DIRECT_TAG.to_string()
    } else {
        format!("e{wire_no}")
    }
}

/// One entrance as the agent's config needs it.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Served {
    pub wire_no: i32,
    /// A relay's derived inbound port (None = the direct entrance).
    pub listen_port: Option<i32>,
    pub source_cidrs: Vec<String>,
}

/// The inbounds the agent runs for a node: its inbound tagged `direct` for
/// the direct entrance, and per relay entrance a copy on the relay's
/// listen port tagged `e<wire_no>` (same protocol and settings — derived
/// credentials fit it too). `entrances` = the enabled ones, in order.
pub fn derived_inbounds(
    inbound: &serde_json::Value,
    entrances: &[Served],
) -> Vec<serde_json::Value> {
    let serde_json::Value::Object(base) = inbound else {
        return Vec::new();
    };
    entrances
        .iter()
        .map(|e| {
            let mut ib = base.clone();
            ib.insert("tag".into(), inbound_tag(e.wire_no).into());
            if let Some(p) = e.listen_port {
                ib.insert("port".into(), p.into());
            }
            serde_json::Value::Object(ib)
        })
        .collect()
}

/// A port clash among the inbounds the server would run (Q1: every node of
/// the server shares its ports) with `node`'s inbound replaced by
/// `inbound` (`node` = None: a node being created, with its direct
/// entrance), all entrances counted (enabled or not: a disabled entrance
/// or node keeps its port), plus `extra` = (an entrance of `node` to leave
/// out, a relay listen port of `node` to add) — or None.
pub async fn port_clash(
    conn: &mut PgConnection,
    server: Uuid,
    node: Option<Uuid>,
    inbound: &serde_json::Value,
    extra: Option<(Option<Uuid>, i32)>,
) -> Result<(), ApiError> {
    #[derive(sqlx::FromRow)]
    struct Row {
        node_id: Uuid,
        inbound: Option<serde_json::Value>,
        #[sqlx(flatten)]
        entrance: Served,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT e.node_id, n.inbound, e.wire_no, e.listen_port, \
         e.source_cidrs::text[] AS source_cidrs \
         FROM entrances e JOIN nodes n ON n.id = e.node_id \
         WHERE e.server_id = $1 AND ($2::uuid IS NULL OR e.id <> $2) ORDER BY e.wire_no",
    )
    .bind(server)
    .bind(extra.and_then(|(id, _)| id))
    .fetch_all(&mut *conn)
    .await?;
    let mut all = Vec::new();
    let mut has_direct = false;
    for r in &rows {
        let ours = Some(r.node_id) == node;
        has_direct |= ours && r.entrance.listen_port.is_none();
        let ib = if ours {
            Some(inbound)
        } else {
            r.inbound.as_ref()
        };
        if let Some(ib) = ib {
            all.extend(derived_inbounds(ib, std::slice::from_ref(&r.entrance)));
        }
    }
    let mut more = Vec::new();
    if !has_direct {
        more.push(Served {
            wire_no: -1,
            listen_port: None,
            source_cidrs: Vec::new(),
        });
    }
    if let Some((_, port)) = extra {
        more.push(Served {
            wire_no: i32::MAX,
            listen_port: Some(port),
            source_cidrs: Vec::new(),
        });
    }
    all.extend(derived_inbounds(inbound, &more));
    match crate::protocols::port_clash(&all) {
        None => Ok(()),
        Some(detail) => Err(bad_request!(
            "entrance.port_clash",
            "{detail}",
            detail = detail
        )),
    }
}

/// SQL expression (one row per node aliased `nodes`): the node's entrances
/// as a JSON array, direct first, then by sort. Each element is the shape
/// of `EntranceView` (what the admin API returns).
pub const ENTRANCES_JSON_SQL: &str = "coalesce((SELECT jsonb_agg(jsonb_build_object( \
     'id', e.id, 'kind', e.kind, 'name', e.name, \
     'connect_host', e.connect_host, 'connect_port', e.connect_port, \
     'rate_permille', e.rate_permille, 'rate', e.rate_permille::float8 / 1000, \
     'rate_now', akari_entrance_rate(e.id, statement_timestamp())::float8 / 1000, \
     'rate_rules', (SELECT coalesce(jsonb_agg(jsonb_build_object('weekdays', r.weekdays, \
        'start', r.start_minute, 'end', r.end_minute, 'rate', r.rate_permille::float8 / 1000) \
        ORDER BY r.ord), '[]'::jsonb) FROM entrance_rate_rules r WHERE r.entrance_id = e.id), \
     'enabled', e.enabled, 'sort', e.sort, 'tags', to_jsonb(e.tags), \
     'wire_no', e.wire_no, 'version', e.version, \
     'listen_port', e.listen_port, 'source_cidrs', to_jsonb(e.source_cidrs::text[]), \
     'health_ok', e.health_ok, 'health_at', e.health_at, 'health_failures', e.health_failures, \
     'health_error', e.health_error, 'hidden_since', e.hidden_since, \
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
    /// Base traffic multiplier: permille and as a number (0.5 = half).
    pub rate_permille: i32,
    #[sqlx(skip)]
    pub rate: f64,
    /// D9: the multiplier in effect now (base or a time-window rule) and
    /// the rules (`rates::RuleView`: weekdays, start/end minute, rate).
    pub rate_now: f64,
    pub rate_rules: serde_json::Value,
    pub enabled: bool,
    pub sort: i32,
    /// Shown after the entrance's name in subscriptions and the portal
    /// ("中转 | IPLC"; 1104: per entrance, not per node).
    pub tags: Vec<String>,
    /// The entrance's number on its node (0 = direct): its agent inbound
    /// tag and traffic key suffix.
    pub wire_no: i32,
    /// Optimistic concurrency (1100): +1 on every update; PATCH may send it
    /// back (`EntranceReq::version`) to refuse a stale form.
    pub version: i64,
    /// Relay: the derived inbound's port on the node and the relay's
    /// egress networks allowed to reach it (direct: null / []).
    pub listen_port: Option<i32>,
    pub source_cidrs: Vec<String>,
    /// Relay health (`entrance_health.rs`): the last TCP test (null = not
    /// tested yet), consecutive failures, and since when the entrance is
    /// hidden from subscriptions (null = shown).
    pub health_ok: Option<bool>,
    pub health_at: Option<chrono::DateTime<chrono::Utc>>,
    pub health_failures: i32,
    pub health_error: Option<String>,
    pub hidden_since: Option<chrono::DateTime<chrono::Utc>>,
    pub group_ids: Vec<Uuid>,
}

const ENTRANCE_VIEW_SQL: &str = "SELECT e.id, e.node_id, e.kind, e.name, e.connect_host, \
     e.connect_port, e.rate_permille, \
     akari_entrance_rate(e.id, statement_timestamp())::float8 / 1000 AS rate_now, \
     (SELECT coalesce(jsonb_agg(jsonb_build_object('weekdays', r.weekdays, \
        'start', r.start_minute, 'end', r.end_minute, 'rate', r.rate_permille::float8 / 1000) \
        ORDER BY r.ord), '[]'::jsonb) FROM entrance_rate_rules r WHERE r.entrance_id = e.id) \
        AS rate_rules, \
     e.enabled, e.sort, e.tags, e.wire_no, e.version, e.listen_port, \
     e.source_cidrs::text[] AS source_cidrs, e.health_ok, e.health_at, e.health_failures, \
     e.health_error, e.hidden_since, \
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
    /// Tags shown after the node's name (the complete list; [] = none;
    /// `nodemeta::tags` rules).
    #[serde(default, deserialize_with = "double_option")]
    pub tags: Option<Option<Vec<String>>>,
    /// Node groups (the complete list; [] = none).
    #[serde(default, deserialize_with = "double_option")]
    pub group_ids: Option<Option<Vec<Uuid>>>,
    /// Relay only: the derived inbound's port on the node.
    #[serde(default, deserialize_with = "double_option")]
    pub listen_port: Option<Option<i32>>,
    /// Relay only: the relay's egress networks ("203.0.113.7",
    /// "198.51.100.0/24"; 1..=64).
    #[serde(default, deserialize_with = "double_option")]
    pub source_cidrs: Option<Option<Vec<String>>>,
    /// The `version` the form was opened at (EntranceView): the update is
    /// refused (409 `entrance.version_conflict`) when the entrance changed
    /// since. Absent = no check (API clients that send only what they
    /// change).
    #[serde(default)]
    pub version: Option<i64>,
}

impl EntranceReq {
    fn has_row_fields(&self) -> bool {
        self.name.is_some()
            || self.connect_host.is_some()
            || self.connect_port.is_some()
            || self.rate.is_some()
            || self.enabled.is_some()
            || self.sort.is_some()
            || self.tags.is_some()
            || self.listen_port.is_some()
            || self.source_cidrs.is_some()
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

/// A relay's egress networks: each an IPv4/IPv6 address (a host network)
/// or a CIDR; host bits are cleared ("10.1.2.3/8" -> "10.0.0.0/8"),
/// duplicates dropped, order kept; 1..=64 of them.
pub fn clean_cidrs(v: &[String]) -> Result<Vec<String>, ApiError> {
    let bad = |detail: String| {
        bad_request!(
            "entrance.source_invalid",
            "source_cidrs: {detail}",
            detail = detail
        )
    };
    let mut out: Vec<String> = Vec::new();
    for raw in v {
        let t = raw.trim();
        let (addr, len) = match t.split_once('/') {
            Some((a, l)) => (a, Some(l)),
            None => (t, None),
        };
        let ip: std::net::IpAddr = addr
            .parse()
            .map_err(|_| bad(format!("{t:?} is not an IP address or network")))?;
        let max = if ip.is_ipv4() { 32 } else { 128 };
        let len: u32 = match len {
            None => max,
            Some(l) => l
                .parse()
                .ok()
                .filter(|l| *l <= max)
                .ok_or_else(|| bad(format!("{t:?} has a bad prefix length")))?,
        };
        let net = match ip {
            std::net::IpAddr::V4(a) => {
                let mask = u32::MAX.checked_shl(32 - len).unwrap_or(0);
                std::net::IpAddr::V4((u32::from(a) & mask).into())
            }
            std::net::IpAddr::V6(a) => {
                let mask = u128::MAX.checked_shl(128 - len).unwrap_or(0);
                std::net::IpAddr::V6((u128::from(a) & mask).into())
            }
        };
        let c = format!("{net}/{len}");
        if !out.contains(&c) {
            out.push(c);
        }
    }
    if out.is_empty() || out.len() > MAX_SOURCE_CIDRS {
        return Err(bad(format!(
            "a relay needs 1-{MAX_SOURCE_CIDRS} egress networks"
        )));
    }
    Ok(out)
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
    tags: Option<Vec<String>>,
    groups: Option<Vec<Uuid>>,
    listen_port: Option<i32>,
    source_cidrs: Option<Vec<String>>,
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
        tags: non_null("tags", &req.tags)?
            .map(|t| crate::nodemeta::tags(&t))
            .transpose()?,
        groups,
        listen_port: non_null("listen_port", &req.listen_port)?
            .map(|p| listen_port(Some(p)))
            .transpose()?
            .flatten(),
        source_cidrs: non_null("source_cidrs", &req.source_cidrs)?
            .map(|c| clean_cidrs(&c))
            .transpose()?,
    })
}

fn listen_port(v: Option<i32>) -> Result<Option<i32>, ApiError> {
    match v {
        Some(p) if !(1..=65535).contains(&p) => Err(bad_request!(
            "entrance.listen_port_invalid",
            "listen_port must be 1-65535"
        )),
        p => Ok(p),
    }
}

/// Update an entrance in the caller's transaction: `entitle::lock` (when
/// the groups change) -> the server row (FOR UPDATE; refused while the
/// server is being deleted) -> the entrance -> membership + reconcile of
/// this entrance -> audit `entrance.update`. Enabling/disabling bumps the
/// server's config_version (its inbound set changes). Returns the
/// reconcile outcome.
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
    let row: Option<(Uuid, Uuid, bool, String, Option<serde_json::Value>)> = sqlx::query_as(
        "SELECT s.id, n.id, s.deleting_at IS NOT NULL, e.kind, n.inbound \
         FROM entrances e JOIN nodes n ON n.id = e.node_id JOIN servers s ON s.id = e.server_id \
         WHERE e.id = $1 FOR UPDATE OF s",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((server, node, deleting, kind, inbound)) = row else {
        return Err(ApiError::not_found());
    };
    if deleting {
        return Err(conflict!("server.deleting", "server is being deleted"));
    }
    if kind == RELAY {
        if matches!(c.connect_host, Some(None)) || matches!(c.connect_port, Some(None)) {
            return Err(bad_request!(
                "entrance.relay_address",
                "a relay entrance needs connect_host and connect_port"
            ));
        }
    } else if c.listen_port.is_some() || c.source_cidrs.is_some() {
        return Err(bad_request!(
            "entrance.relay_only",
            "listen_port and source_cidrs belong to relay entrances"
        ));
    }
    if let (Some(port), Some(ib)) = (c.listen_port, &inbound) {
        port_clash(conn, server, Some(node), ib, Some((Some(id), port))).await?;
    }
    if let Some(expected) = req.version {
        let current: i64 = sqlx::query_scalar("SELECT version FROM entrances WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *conn)
            .await?;
        if current != expected {
            return Err(conflict!(
                "entrance.version_conflict",
                "入口已被修改（可能是其他管理员），请关闭后重新打开再保存"
            ));
        }
    }
    let mut qb =
        sqlx::QueryBuilder::new("UPDATE entrances SET updated_at = now(), version = version + 1");
    if let Some(v) = &c.name {
        qb.push(", name = ").push_bind(v.clone());
    }
    if let Some(v) = &c.connect_host {
        qb.push(", connect_host = ").push_bind(v.clone());
    }
    if c.connect_host.is_some() || c.connect_port.is_some() {
        // A relay's new address is tested at the next health round; a
        // hidden one stays hidden until it answers.
        qb.push(", health_next_at = NULL, health_failures = 0");
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
    if let Some(v) = &c.tags {
        qb.push(", tags = ").push_bind(v.clone());
    }
    if let Some(v) = c.listen_port {
        qb.push(", listen_port = ").push_bind(v);
    }
    if let Some(v) = &c.source_cidrs {
        qb.push(", source_cidrs = ")
            .push_bind(v.clone())
            .push("::cidr[]");
    }
    qb.push(" WHERE id = ").push_bind(id);
    // The agent's inbounds or its source filters change.
    qb.push(format!(
        " RETURNING {}, {}, old.enabled <> new.enabled \
         OR old.listen_port IS DISTINCT FROM new.listen_port \
         OR old.source_cidrs <> new.source_cidrs",
        crate::audit::entrance_snapshot_sql("old"),
        crate::audit::entrance_snapshot_sql("new")
    ));
    let (mut before, mut after, reconfigured): (serde_json::Value, serde_json::Value, bool) = qb
        .build_query_as()
        .fetch_one(&mut *conn)
        .await
        .map_err(listen_port_taken)?;
    if reconfigured {
        sqlx::query("UPDATE servers SET config_version = config_version + 1 WHERE id = $1")
            .bind(server)
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

/// The unique (server, listen_port) index refused the port (another relay
/// of the server has it).
fn listen_port_taken(e: sqlx::Error) -> ApiError {
    match &e {
        sqlx::Error::Database(d) if d.constraint() == Some("entrances_listen_port_key") => {
            bad_request!(
                "entrance.port_clash",
                "listen_port is used by another entrance of the server"
            )
        }
        sqlx::Error::Database(d) if d.constraint() == Some("entrances_name_key") => conflict!(
            "entrance.name_exists",
            "the node already has an entrance with this name"
        ),
        _ => e.into(),
    }
}

/// A new relay entrance (POST /nodes/{id}/entrances).
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct CreateRelayReq {
    pub name: String,
    /// The relay's address and port (what clients dial).
    pub connect_host: String,
    pub connect_port: i32,
    /// The derived inbound's port on the node (what the relay forwards to).
    pub listen_port: i32,
    /// The relay's egress networks (1..=64).
    pub source_cidrs: Vec<String>,
    /// Traffic multiplier 0..=100, at most 3 decimals: required (a missing
    /// multiplier is never taken as a default or as 0x).
    pub rate: f64,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub sort: Option<i32>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub group_ids: Option<Vec<Uuid>>,
}

/// Create a relay entrance in the caller's transaction: `entitle::lock`
/// (when it joins groups) -> the server row (FOR UPDATE; 404 / 409 while
/// deleting) -> port check against the server's inbounds -> a fresh
/// `wire_no` from `servers.entrance_seq` -> the row, bumping the server's
/// config_version (a new inbound) -> membership + reconcile -> audit
/// `entrance.create`.
pub async fn apply_create_relay(
    conn: &mut PgConnection,
    actor: &Actor,
    node: Uuid,
    req: &CreateRelayReq,
) -> Result<(Uuid, Outcome), ApiError> {
    let name = clean_name(&req.name)?;
    let host = clean_host(Some(&req.connect_host))?.ok_or_else(|| {
        bad_request!(
            "entrance.relay_address",
            "a relay entrance needs connect_host and connect_port"
        )
    })?;
    let port = clean_port(Some(req.connect_port))?;
    listen_port(Some(req.listen_port))?;
    let listen = req.listen_port;
    let cidrs = clean_cidrs(&req.source_cidrs)?;
    let rate = rate_permille(req.rate)?;
    let sort = req
        .sort
        .map(crate::nodemeta::sort)
        .transpose()?
        .unwrap_or(0);
    let tags = crate::nodemeta::tags(req.tags.as_deref().unwrap_or_default())?;
    let groups = req.group_ids.clone().map(|mut g| {
        g.sort();
        g.dedup();
        g
    });
    if groups.is_some() {
        entitle::lock(conn).await?;
    }
    let row: Option<(Uuid, bool, Option<serde_json::Value>)> = sqlx::query_as(
        "SELECT s.id, s.deleting_at IS NOT NULL, n.inbound FROM nodes n \
         JOIN servers s ON s.id = n.server_id WHERE n.id = $1 FOR UPDATE OF s",
    )
    .bind(node)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((server, deleting, inbound)) = row else {
        return Err(ApiError::not_found());
    };
    if deleting {
        return Err(conflict!("server.deleting", "server is being deleted"));
    }
    if let Some(ib) = &inbound {
        port_clash(conn, server, Some(node), ib, Some((None, listen))).await?;
    }
    let wire: i32 = sqlx::query_scalar(
        "UPDATE servers SET entrance_seq = entrance_seq + 1, config_version = config_version + 1 \
         WHERE id = $1 RETURNING entrance_seq",
    )
    .bind(server)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(d) if d.constraint() == Some("servers_entrance_seq") => conflict!(
            "entrance.too_many",
            "the server has used up its entrance numbers"
        ),
        _ => e.into(),
    })?;
    let id = Uuid::new_v4();
    let after: serde_json::Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "INSERT INTO entrances AS e (id, node_id, server_id, kind, name, connect_host, \
         connect_port, rate_permille, enabled, sort, wire_no, listen_port, source_cidrs, tags) \
         VALUES ($1, $2, $12, 'relay', $3, $4, $5, $6, $7, $8, $9, $10, $11::cidr[], $13) \
         RETURNING {}",
        crate::audit::entrance_snapshot_sql("e")
    )))
    .bind(id)
    .bind(node)
    .bind(&name)
    .bind(&host)
    .bind(port)
    .bind(rate)
    .bind(req.enabled.unwrap_or(true))
    .bind(sort)
    .bind(wire)
    .bind(listen)
    .bind(&cidrs)
    .bind(server)
    .bind(&tags)
    .fetch_one(&mut *conn)
    .await
    .map_err(listen_port_taken)?;
    let mut after = after;
    let mut outcome = Outcome::default();
    if let Some(groups) = &groups {
        set_groups(conn, id, groups).await?;
        outcome = entitle::apply_reconcile(conn, Scope::Entrances(&[id])).await?;
        after["group_ids"] = json!(groups);
        after["entitlement"] = outcome.summary();
    }
    crate::audit::record(
        conn,
        actor,
        "entrance.create",
        "entrance",
        Some(id.to_string()),
        None,
        Some(after),
    )
    .await?;
    Ok((id, outcome))
}

/// Delete a relay entrance in the caller's transaction: `entitle::lock` ->
/// the server row -> the row (its credentials and memberships cascade; its
/// derived inbound goes away: config_version) -> audit `entrance.delete`.
/// The direct entrance cannot be deleted (409; disable it instead). The
/// relay's users lose it at once; counters the agent reports for it after
/// the removal are not billed (its rows are gone).
pub async fn apply_delete(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<(), ApiError> {
    entitle::lock(conn).await?;
    let row: Option<(Uuid, String, bool)> = sqlx::query_as(
        "SELECT s.id, e.kind, s.deleting_at IS NOT NULL FROM entrances e \
         JOIN servers s ON s.id = e.server_id WHERE e.id = $1 FOR UPDATE OF s",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((server, kind, deleting)) = row else {
        return Err(ApiError::not_found());
    };
    if kind == DIRECT {
        return Err(conflict!(
            "entrance.direct_permanent",
            "the direct entrance cannot be deleted; disable it instead"
        ));
    }
    if deleting {
        return Err(conflict!("server.deleting", "server is being deleted"));
    }
    let before: serde_json::Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "DELETE FROM entrances AS e WHERE id = $1 RETURNING {}",
        crate::audit::entrance_snapshot_sql("e")
    )))
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query("UPDATE servers SET config_version = config_version + 1 WHERE id = $1")
        .bind(server)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "entrance.delete",
        "entrance",
        Some(id.to_string()),
        Some(before),
        None,
    )
    .await?;
    Ok(())
}

/// Replace the entrance's group membership (caller holds `entitle::lock`
/// and the server row); returns the previous groups (sorted). 400 for an
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

/// POST /nodes/{id}/entrances (admin): a relay entrance (201).
pub async fn create_relay(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, node)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<CreateRelayReq>,
) -> Result<(StatusCode, Json<EntranceView>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let (id, _) = apply_create_relay(&mut tx, &Actor::of(&user), node, &req).await?;
    let v = view(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(v)))
}

/// DELETE /entrances/{id} (admin; relay entrances only).
pub async fn delete_entrance(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_delete(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
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
