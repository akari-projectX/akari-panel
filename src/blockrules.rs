//! W29: node block rules (后台「审计规则」; named block rules so it is
//! never confused with `audit.rs`, the admin audit log).
//!
//! - **Rules** (`block_rules`): three vendored built-in sets that can only
//!   be switched (`bittorrent` = BitTorrent protocol detection,
//!   `bt_tracker` = public tracker domains, `xunlei_pt` = Thunder/PT site
//!   domains; lists in `blockrules/lists/`, refreshed by
//!   `scripts/update-block-lists.py`) plus custom domain / IP / protocol
//!   rules (one entry per line, validated and normalized by
//!   [`parse_entries`]). Mutations are `apply_*` in the caller's
//!   transaction with audit rows (`block_rule.*`); the 1060 trigger wakes
//!   every agent session (`notify.rs`, payload `block-rules`).
//! - **Per-node switch** (`nodes.block_rules_enabled`, default off,
//!   `apply_set_node`, audit `node.block_rules.set`): never bumps the node's
//!   versions — no Snapshot, no xray rebuild. The 1060 trigger wakes the
//!   node's sessions instead.
//! - **Compiling** ([`server_policy`] → `pb::BlockPolicy`): done here, once
//!   per send; the agent only installs the result into xray routing.
//!   Sessions of agents with the `block-rules` capability send it after the
//!   Hello and whenever it differs from the one last sent on the stream
//!   (`grpc.rs`, like `LatencyProbeConfig`).
//! - **Counters**: the agent reports cumulative hits per rule and agent
//!   process (`Heartbeat.block`); [`ingest_stats`] turns them into daily
//!   per-node, per-rule counts in one SQL statement (GREATEST + `RETURNING
//!   old/new`, so a replay never counts twice). Aggregates only: no user,
//!   no destination is ever recorded. [`retention_pass`] (reaper) keeps 90
//!   days.

use std::collections::BTreeSet;
use std::net::IpAddr;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::NaiveDate;
use prost::Message;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request};
use crate::pb::{BlockPolicy, BlockRule, BlockStats};
use crate::state::AppState;

/// The agent capability that accepts `PanelDown.block_policy`.
pub const CAPABILITY: &str = "block-rules";
/// Custom rules at most (built-ins come on top).
pub const MAX_CUSTOM_RULES: i64 = 32;
/// Entries in one custom rule at most.
pub const MAX_ENTRIES: usize = 1000;
/// Stored pattern (normalized entries, one per line) at most, bytes.
pub const MAX_PATTERN: usize = 65536;
pub const MAX_NAME: usize = 64;
pub const MAX_SORT: i32 = 1_000_000;
/// Protocols xray's sniffer reports (`protocol` routing condition).
pub const PROTOCOLS: [&str; 4] = ["bittorrent", "http", "tls", "quic"];
/// Daily hit counts kept (days).
pub const DAILY_RETENTION_DAYS: i32 = 90;
/// Counter baselines of agent processes not heard from in this long are
/// dead (a live agent reports every heartbeat).
pub const COUNTER_RETENTION_DAYS: i32 = 7;
/// Distinct agent processes (epochs) with live baselines per node at most:
/// a compromised agent cannot grow the table by inventing epochs.
pub const MAX_EPOCHS_PER_SERVER: i64 = 8;
/// Hit entries accepted from one heartbeat at most (agent input).
pub const MAX_REPORTED_RULES: usize = 64;
/// Longest stats range (days) for the node view.
pub const MAX_STATS_DAYS: i64 = 90;

const BT_TRACKER: &str = include_str!("blockrules/lists/bt_tracker.txt");
const XUNLEI_PT: &str = include_str!("blockrules/lists/xunlei_pt.txt");
const LISTS_VERSION: &str = include_str!("blockrules/lists/VERSION");

/// The vendored lists' upstream commit (v2fly/domain-list-community).
pub fn lists_version() -> &'static str {
    LISTS_VERSION.trim()
}

/// A custom rule's entry kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Domain,
    Ip,
    Protocol,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "domain" => Some(Self::Domain),
            "ip" => Some(Self::Ip),
            "protocol" => Some(Self::Protocol),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Domain => "domain",
            Self::Ip => "ip",
            Self::Protocol => "protocol",
        }
    }
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/// A DNS name as xray's domain matchers take it: lowercase LDH labels
/// (punycode for IDNs), 1..=63 per label, at most 253 overall.
fn valid_domain(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// One domain entry → `domain:`/`full:`/`keyword:` form (a bare name is a
/// suffix match, like xray's own default).
fn domain_entry(raw: &str) -> Option<String> {
    let s = raw.to_ascii_lowercase();
    let (kind, value) = match s.split_once(':') {
        Some((k @ ("domain" | "full" | "keyword"), v)) => (k, v.trim()),
        Some(_) => return None,
        None => ("domain", s.as_str()),
    };
    let value = value.strip_suffix('.').unwrap_or(value);
    let ok = match kind {
        "keyword" => {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        }
        _ => valid_domain(value),
    };
    ok.then(|| format!("{kind}:{value}"))
}

/// One IP entry → canonical network (`192.0.2.0/24`; a bare address is a
/// /32 or /128; host bits are cleared).
fn ip_entry(raw: &str) -> Option<String> {
    let (addr, len) = match raw.split_once('/') {
        Some((a, l)) => (a, Some(l)),
        None => (raw, None),
    };
    let ip: IpAddr = addr.parse().ok()?;
    let max = if ip.is_ipv4() { 32 } else { 128 };
    let len: u8 = match len {
        None => max,
        Some(l) if !l.is_empty() && l.bytes().all(|b| b.is_ascii_digit()) && l.len() <= 3 => {
            l.parse().ok()?
        }
        Some(_) => return None,
    };
    if len > max {
        return None;
    }
    let net = match ip {
        IpAddr::V4(v) => {
            let mask = u32::MAX.checked_shl(u32::from(32 - len)).unwrap_or(0);
            IpAddr::V4((u32::from(v) & mask).into())
        }
        IpAddr::V6(v) => {
            let mask = u128::MAX.checked_shl(u32::from(128 - len)).unwrap_or(0);
            IpAddr::V6((u128::from(v) & mask).into())
        }
    };
    Some(format!("{net}/{len}"))
}

fn protocol_entry(raw: &str) -> Option<String> {
    let s = raw.to_ascii_lowercase();
    PROTOCOLS.contains(&s.as_str()).then_some(s)
}

/// Validate and normalize a custom rule's entries: one per line, blank
/// lines ignored, duplicates dropped (first occurrence kept).
pub fn parse_entries(kind: Kind, pattern: &str) -> Result<Vec<String>, ApiError> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for (i, line) in pattern.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let entry = match kind {
            Kind::Domain => domain_entry(line),
            Kind::Ip => ip_entry(line),
            Kind::Protocol => protocol_entry(line),
        };
        let Some(entry) = entry else {
            return Err(bad_request!(
                "block_rule.entry_invalid",
                "line {line}: not a valid {kind} entry",
                line = i + 1,
                kind = kind.as_str()
            ));
        };
        if seen.insert(entry.clone()) {
            out.push(entry);
        }
        if out.len() > MAX_ENTRIES {
            return Err(bad_request!(
                "block_rule.too_many_entries",
                "a rule holds at most {max} entries",
                max = MAX_ENTRIES
            ));
        }
    }
    if out.is_empty() {
        return Err(bad_request!(
            "block_rule.entries_required",
            "a rule needs at least one entry"
        ));
    }
    if out.iter().map(|e| e.len() + 1).sum::<usize>() > MAX_PATTERN {
        return Err(bad_request!(
            "block_rule.pattern_long",
            "the entries exceed {max} bytes",
            max = MAX_PATTERN
        ));
    }
    Ok(out)
}

/// A vendored list file: comment lines (`#`) and blank lines skipped.
fn vendored(text: &'static str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// What a rule matches, as the agent receives it.
fn compile_rule(
    id: i64,
    kind: &str,
    builtin_key: Option<&str>,
    pattern: Option<&str>,
) -> Option<BlockRule> {
    let mut rule = BlockRule {
        id: u64::try_from(id).ok()?,
        ..Default::default()
    };
    match (kind, builtin_key) {
        ("builtin", Some("bittorrent")) => rule.protocols = vec!["bittorrent".into()],
        ("builtin", Some("bt_tracker")) => rule.domains = vendored(BT_TRACKER),
        ("builtin", Some("xunlei_pt")) => rule.domains = vendored(XUNLEI_PT),
        (k, None) => {
            let kind = Kind::parse(k)?;
            // Stored patterns are normalized on write; a row written by
            // hand that no longer parses is left out (and logged), never
            // sent half-valid.
            let entries = match parse_entries(kind, pattern?) {
                Ok(e) => e,
                Err(e) => {
                    tracing::error!(rule = id, error = %e.message(), "block rule does not parse; left out");
                    return None;
                }
            };
            match kind {
                Kind::Domain => rule.domains = entries,
                Kind::Ip => rule.cidrs = entries,
                Kind::Protocol => rule.protocols = entries,
            }
        }
        _ => return None,
    }
    Some(rule)
}

/// The policy's content id: hex SHA-256 prefix of its encoding (prost
/// encodes fields in number order, repeated fields in list order).
fn policy_version(p: &BlockPolicy) -> String {
    let digest = Sha256::digest(p.encode_to_vec());
    hex::encode(&digest[..12])
}

/// Assemble a policy; no tags or no rules = the empty (off) policy.
pub fn assemble(inbound_tags: Vec<String>, rules: Vec<BlockRule>) -> BlockPolicy {
    if inbound_tags.is_empty() {
        return BlockPolicy::default();
    }
    let mut p = BlockPolicy {
        inbound_tags,
        rules,
        version: String::new(),
    };
    p.version = policy_version(&p);
    p
}

#[derive(sqlx::FromRow)]
struct RuleRow {
    id: i64,
    kind: String,
    builtin_key: Option<String>,
    pattern: Option<String>,
}

/// The enabled rules, compiled, in display order.
async fn enabled_rules(conn: &mut PgConnection) -> sqlx::Result<Vec<BlockRule>> {
    let rows: Vec<RuleRow> = sqlx::query_as(
        "SELECT id, kind, builtin_key, pattern FROM block_rules WHERE enabled ORDER BY sort, id",
    )
    .fetch_all(conn)
    .await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            compile_rule(
                r.id,
                &r.kind,
                r.builtin_key.as_deref(),
                r.pattern.as_deref(),
            )
        })
        .collect())
}

/// The policy a server's agent should run (None = the server is gone).
/// It lists every inbound the agent serves (`grpc::SERVED_ENTRANCES`: each
/// enabled entrance, direct and relay, of an enabled node with an inbound)
/// whose node has the switch on, tagged as the snapshot names it
/// (`entrances::inbound_tag`) — a relay entrance is audited exactly like
/// the direct one. A server being deleted (or not serving, D5) gets the
/// empty policy.
pub async fn server_policy(pg: &sqlx::PgPool, server: Uuid) -> sqlx::Result<Option<BlockPolicy>> {
    let mut tx = pg.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let serves: Option<bool> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM servers s WHERE s.id = $1",
        crate::grpc::SERVER_SERVES
    )))
    .bind(server)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(serves) = serves else {
        return Ok(None);
    };
    let tags: Vec<String> = if serves {
        sqlx::query_scalar::<_, i32>(sqlx::AssertSqlSafe(format!(
            "SELECT e.wire_no FROM {} AND n.block_rules_enabled ORDER BY e.wire_no",
            crate::grpc::SERVED_ENTRANCES
        )))
        .bind(server)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(crate::entrances::inbound_tag)
        .collect()
    } else {
        Vec::new()
    };
    let policy = if !tags.is_empty() {
        let rules = enabled_rules(&mut tx).await?;
        assemble(tags, rules)
    } else {
        BlockPolicy::default()
    };
    tx.commit().await?;
    Ok(Some(policy))
}

// ---------------------------------------------------------------------------
// Counters (Heartbeat.block)
// ---------------------------------------------------------------------------

/// Agent input as stored: a printable epoch of 1..=64 bytes, at most
/// MAX_REPORTED_RULES entries, ids and counts clamped into i64.
pub fn clean_stats(s: &BlockStats) -> Option<(String, Vec<i64>, Vec<i64>)> {
    let epoch = s.epoch.as_str();
    if epoch.is_empty() || epoch.len() > 64 || !epoch.bytes().all(|b| b.is_ascii_graphic()) {
        return None;
    }
    let mut ids = Vec::new();
    let mut hits = Vec::new();
    let mut seen = BTreeSet::new();
    for h in s.hits.iter().take(MAX_REPORTED_RULES) {
        let Ok(id) = i64::try_from(h.rule_id) else {
            continue;
        };
        if h.hits == 0 || !seen.insert(id) {
            continue;
        }
        ids.push(id);
        hits.push(i64::try_from(h.hits).unwrap_or(i64::MAX));
    }
    Some((epoch.to_string(), ids, hits))
}

/// Raise the node's per-epoch baselines and add the increase to today's
/// (site time zone, Q3) daily counts, in one statement: a replayed or
/// reordered report adds nothing (the baseline only grows), counts for
/// unknown rules are dropped, and a node cannot hold baselines for more
/// than MAX_EPOCHS_PER_SERVER agent processes.
pub const INGEST_SQL: &str = "\
WITH input AS (
    SELECT t.rule_id, t.hits FROM unnest($3::bigint[], $4::bigint[]) AS t(rule_id, hits)
    JOIN block_rules r ON r.id = t.rule_id
    WHERE EXISTS (SELECT 1 FROM server_block_counters WHERE server_id = $1 AND epoch = $2)
       OR (SELECT count(DISTINCT epoch) FROM server_block_counters WHERE server_id = $1) < $5
),
raised AS (
    INSERT INTO server_block_counters AS c (server_id, epoch, rule_id, hits)
    SELECT $1, $2, rule_id, hits FROM input
    ON CONFLICT (server_id, epoch, rule_id) DO UPDATE
        SET hits = GREATEST(c.hits, EXCLUDED.hits), updated_at = now()
    RETURNING new.rule_id, new.hits - COALESCE(old.hits, 0) AS added
)
INSERT INTO server_block_daily AS d (server_id, day, rule_id, hits)
SELECT $1, (SELECT akari_site_day(statement_timestamp())), rule_id, added
FROM raised WHERE added > 0
ON CONFLICT (server_id, day, rule_id) DO UPDATE SET hits = d.hits + EXCLUDED.hits";

/// Store one heartbeat's counters (nothing to do without hits).
pub async fn ingest_stats(pg: &sqlx::PgPool, server: Uuid, stats: &BlockStats) -> sqlx::Result<()> {
    let Some((epoch, ids, hits)) = clean_stats(stats) else {
        return Ok(());
    };
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query(INGEST_SQL)
        .bind(server)
        .bind(epoch)
        .bind(ids)
        .bind(hits)
        .bind(MAX_EPOCHS_PER_SERVER)
        .execute(pg)
        .await?;
    Ok(())
}

/// The heartbeat blob's `block` member (applied policy and last error;
/// agent text bounded).
pub fn status_json(s: &BlockStats) -> Value {
    let short = |t: &str| -> String { t.chars().filter(|c| !c.is_control()).take(256).collect() };
    json!({
        "applied": short(&s.applied),
        "error": (!s.error.is_empty()).then(|| short(&s.error)),
    })
}

/// Reaper: drop daily rows past the retention and baselines of agent
/// processes that stopped reporting.
pub async fn retention_pass(pg: &sqlx::PgPool) -> sqlx::Result<(u64, u64)> {
    let days = sqlx::query(
        "DELETE FROM server_block_daily \
         WHERE day < (SELECT akari_site_day(statement_timestamp())) - $1",
    )
    .bind(DAILY_RETENTION_DAYS)
    .execute(pg)
    .await?
    .rows_affected();
    let counters = sqlx::query(
        "DELETE FROM server_block_counters WHERE updated_at < now() - make_interval(days => $1)",
    )
    .bind(COUNTER_RETENTION_DAYS)
    .execute(pg)
    .await?
    .rows_affected();
    Ok((days, counters))
}

// ---------------------------------------------------------------------------
// Rule mutations (caller's transaction; audited)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct CreateReq {
    pub kind: String,
    pub name: String,
    pub pattern: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub sort: i32,
}

fn yes() -> bool {
    true
}

/// PATCH: absent members stay as they are. Built-in sets take `enabled`
/// and `sort` only.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(deny_unknown_fields)]
pub struct UpdateReq {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub sort: Option<i32>,
}

pub fn clean_name(s: &str) -> Result<String, ApiError> {
    let s = s.trim();
    if s.is_empty() {
        return Err(bad_request!("block_rule.name_required", "name is required"));
    }
    if s.chars().any(char::is_control) {
        return Err(bad_request!(
            "block_rule.name_multiline",
            "name must be a single line"
        ));
    }
    if s.chars().count() > MAX_NAME {
        return Err(bad_request!(
            "block_rule.name_long",
            "name is longer than {max} characters",
            max = MAX_NAME
        ));
    }
    Ok(s.to_string())
}

fn check_sort(sort: i32) -> Result<i32, ApiError> {
    if sort.abs() > MAX_SORT {
        return Err(bad_request!(
            "block_rule.sort_range",
            "sort must be within ±{max}",
            max = MAX_SORT
        ));
    }
    Ok(sort)
}

/// Serializes the custom-rule count check (and every rule write).
async fn lock_rules(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('akari.block_rules', 0))")
        .execute(conn)
        .await?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
struct Stored {
    kind: String,
    builtin_key: Option<String>,
    name: String,
    pattern: Option<String>,
    enabled: bool,
    sort: i32,
}

/// Audit snapshot: the entries are summarized (count and hash), never
/// copied in full.
fn snapshot(s: &Stored) -> Value {
    json!({
        "kind": s.kind,
        "builtin_key": s.builtin_key,
        "name": s.name,
        "enabled": s.enabled,
        "sort": s.sort,
        "entries": s.pattern.as_deref().map(|p| p.lines().count()),
        "pattern_sha256": s.pattern.as_deref().map(|p| hex::encode(Sha256::digest(p.as_bytes()))),
    })
}

pub async fn apply_create(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &CreateReq,
) -> Result<i64, ApiError> {
    let Some(kind) = Kind::parse(&req.kind) else {
        return Err(bad_request!(
            "block_rule.kind_invalid",
            "kind must be domain, ip or protocol"
        ));
    };
    let stored = Stored {
        kind: kind.as_str().to_string(),
        builtin_key: None,
        name: clean_name(&req.name)?,
        pattern: Some(parse_entries(kind, &req.pattern)?.join("\n")),
        enabled: req.enabled,
        sort: check_sort(req.sort)?,
    };
    lock_rules(conn).await?;
    let custom: i64 =
        sqlx::query_scalar("SELECT count(*) FROM block_rules WHERE kind <> 'builtin'")
            .fetch_one(&mut *conn)
            .await?;
    if custom >= MAX_CUSTOM_RULES {
        return Err(bad_request!(
            "block_rule.too_many_rules",
            "at most {max} custom rules",
            max = MAX_CUSTOM_RULES
        ));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO block_rules (kind, name, pattern, enabled, sort) \
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(&stored.kind)
    .bind(&stored.name)
    .bind(&stored.pattern)
    .bind(stored.enabled)
    .bind(stored.sort)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "block_rule.create",
        "block_rule",
        Some(id.to_string()),
        None,
        Some(snapshot(&stored)),
    )
    .await?;
    Ok(id)
}

async fn lock_rule(conn: &mut PgConnection, id: i64) -> sqlx::Result<Option<Stored>> {
    sqlx::query_as(
        "SELECT kind, builtin_key, name, pattern, enabled, sort FROM block_rules \
         WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
}

/// Ok(false) = no such rule.
pub async fn apply_update(
    conn: &mut PgConnection,
    actor: &Actor,
    id: i64,
    req: &UpdateReq,
) -> Result<bool, ApiError> {
    lock_rules(conn).await?;
    let Some(before) = lock_rule(conn, id).await? else {
        return Ok(false);
    };
    let builtin = before.kind == "builtin";
    if builtin && (req.name.is_some() || req.pattern.is_some()) {
        return Err(bad_request!(
            "block_rule.builtin_fixed",
            "built-in rule sets can only be switched and sorted"
        ));
    }
    let mut after = before.clone();
    if let Some(n) = &req.name {
        after.name = clean_name(n)?;
    }
    if let Some(p) = &req.pattern {
        let kind = Kind::parse(&before.kind).ok_or_else(ApiError::internal)?;
        after.pattern = Some(parse_entries(kind, p)?.join("\n"));
    }
    if let Some(e) = req.enabled {
        after.enabled = e;
    }
    if let Some(s) = req.sort {
        after.sort = check_sort(s)?;
    }
    if after == before {
        return Ok(true);
    }
    sqlx::query(
        "UPDATE block_rules SET name = $2, pattern = $3, enabled = $4, sort = $5, \
           updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(&after.name)
    .bind(&after.pattern)
    .bind(after.enabled)
    .bind(after.sort)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "block_rule.update",
        "block_rule",
        Some(id.to_string()),
        Some(snapshot(&before)),
        Some(snapshot(&after)),
    )
    .await?;
    Ok(true)
}

/// Ok(false) = no such rule. Built-in sets cannot be deleted.
pub async fn apply_delete(
    conn: &mut PgConnection,
    actor: &Actor,
    id: i64,
) -> Result<bool, ApiError> {
    lock_rules(conn).await?;
    let Some(before) = lock_rule(conn, id).await? else {
        return Ok(false);
    };
    if before.kind == "builtin" {
        return Err(bad_request!(
            "block_rule.builtin_fixed",
            "built-in rule sets can only be switched and sorted"
        ));
    }
    sqlx::query("DELETE FROM block_rules WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "block_rule.delete",
        "block_rule",
        Some(id.to_string()),
        Some(snapshot(&before)),
        None,
    )
    .await?;
    Ok(true)
}

/// Switch block rules on or off for a node (no version bump: the 1065
/// trigger wakes its server's sessions). Ok(None) = no such node (or its
/// server is being deleted); Ok(Some(changed)). Locks the server, then
/// the node.
pub async fn apply_set_node(
    conn: &mut PgConnection,
    actor: &Actor,
    node: Uuid,
    enabled: bool,
) -> Result<Option<bool>, ApiError> {
    if crate::servers::lock_live_server_of(conn, node)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    let before: Option<bool> =
        sqlx::query_scalar("SELECT block_rules_enabled FROM nodes WHERE id = $1 FOR UPDATE")
            .bind(node)
            .fetch_optional(&mut *conn)
            .await?;
    let Some(before) = before else {
        return Ok(None);
    };
    if before == enabled {
        return Ok(Some(false));
    }
    sqlx::query("UPDATE nodes SET block_rules_enabled = $2 WHERE id = $1")
        .bind(node)
        .bind(enabled)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "node.block_rules.set",
        "node",
        Some(node.to_string()),
        Some(json!({ "block_rules_enabled": before })),
        Some(json!({ "block_rules_enabled": enabled })),
    )
    .await?;
    Ok(Some(true))
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct RuleView {
    pub id: i64,
    pub kind: String,
    pub builtin_key: Option<String>,
    pub name: String,
    /// Custom rules: the normalized entries, one per line.
    pub pattern: Option<String>,
    /// Entries the rule matches with (built-ins: the vendored list).
    #[sqlx(skip)]
    pub entries: usize,
    pub enabled: bool,
    pub sort: i32,
    /// Blocked connections over the last 7 days (site time zone), all nodes.
    pub hits_7d: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize)]
pub struct RulesView {
    pub lists_version: &'static str,
    /// Nodes with the switch on.
    pub nodes_enabled: i64,
    pub rules: Vec<RuleView>,
}

/// GET /block-rules (admin).
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<RulesView>, ApiError> {
    user.require_admin()?;
    let mut rules: Vec<RuleView> = sqlx::query_as(
        "SELECT r.id, r.kind, r.builtin_key, r.name, r.pattern, r.enabled, r.sort, \
           COALESCE((SELECT sum(d.hits) FROM server_block_daily d WHERE d.rule_id = r.id \
             AND d.day > (SELECT akari_site_day(statement_timestamp())) - 7), 0)::bigint AS hits_7d, \
           r.created_at, r.updated_at \
         FROM block_rules r ORDER BY r.sort, r.id",
    )
    .fetch_all(state.pg())
    .await?;
    for r in &mut rules {
        r.entries = compile_rule(
            r.id,
            &r.kind,
            r.builtin_key.as_deref(),
            r.pattern.as_deref(),
        )
        .map(|c| c.domains.len() + c.cidrs.len() + c.protocols.len())
        .unwrap_or(0);
    }
    let nodes_enabled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM nodes n JOIN servers s ON s.id = n.server_id \
         WHERE n.block_rules_enabled AND s.deleting_at IS NULL",
    )
    .fetch_one(state.pg())
    .await?;
    Ok(Json(RulesView {
        lists_version: lists_version(),
        nodes_enabled,
        rules,
    }))
}

/// POST /block-rules (admin) → 201 {id}.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateReq>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let id = apply_create(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

/// PATCH /block-rules/{id} (admin).
pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, i64)>,
    ApiJson(req): ApiJson<UpdateReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    if !apply_update(&mut tx, &Actor::of(&user), id, &req).await? {
        return Err(ApiError::not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /block-rules/{id} (admin).
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, i64)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    if !apply_delete(&mut tx, &Actor::of(&user), id).await? {
        return Err(ApiError::not_found());
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Serialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct NodeSwitchReq {
    pub enabled: bool,
}

#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct StatsQuery {
    #[serde(default)]
    pub days: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct DayHits {
    pub day: NaiveDate,
    pub rule_id: i64,
    pub name: String,
    pub hits: i64,
}

/// GET /nodes/{id}/block-rules?days=N (admin): the node's switch, whether
/// its server's agent supports it and runs the current policy, and the
/// server's daily hits per rule over the last N days (site time zone;
/// default 7, at most 90; hits are counted per agent, i.e. per server, Q1).
pub async fn node_view(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, node)): Path<(String, Uuid)>,
    Query(q): Query<StatsQuery>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let days = q.days.unwrap_or(7);
    if !(1..=MAX_STATS_DAYS).contains(&days) {
        return Err(bad_request!(
            "block_rule.days_range",
            "days must be within 1..={max}",
            max = MAX_STATS_DAYS
        ));
    }
    let row: Option<(Uuid, bool, Option<Vec<String>>)> = sqlx::query_as(
        "SELECT s.id, n.block_rules_enabled, s.agent_capabilities FROM nodes n \
         JOIN servers s ON s.id = n.server_id WHERE n.id = $1",
    )
    .bind(node)
    .fetch_optional(state.pg())
    .await?;
    let Some((server, enabled, caps)) = row else {
        return Err(ApiError::not_found());
    };
    let rows: Vec<DayHits> = sqlx::query_as(
        "SELECT d.day, d.rule_id, r.name, d.hits FROM server_block_daily d \
         JOIN block_rules r ON r.id = d.rule_id \
         WHERE d.server_id = $1 AND d.day > (SELECT akari_site_day(statement_timestamp())) - $2::int \
         ORDER BY d.day, r.sort, d.rule_id",
    )
    .bind(server)
    .bind(i32::try_from(days).unwrap_or(7))
    .fetch_all(state.pg())
    .await?;
    let expected = server_policy(state.pg(), server)
        .await?
        .ok_or_else(ApiError::not_found)?
        .version;
    let status = heartbeat_block(&state, server).await;
    let applied = status
        .as_ref()
        .and_then(|s| s.get("applied"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(Json(json!({
        "enabled": enabled,
        "agent_supported": caps.as_deref().is_some_and(|c| c.iter().any(|c| c == CAPABILITY)),
        "policy_version": expected,
        "applied_version": applied,
        "in_sync": applied.as_deref() == Some(expected.as_str()),
        "error": status.as_ref().and_then(|s| s.get("error")).cloned().unwrap_or(Value::Null),
        "days": rows,
    })))
}

/// The `block` member of the server's heartbeat blob (best effort).
async fn heartbeat_block(state: &AppState, server: Uuid) -> Option<Value> {
    use fred::prelude::KeysInterface;
    match state
        .valkey()
        .get::<Option<String>, _>(format!("akari:server:hb:{server}"))
        .await
    {
        Ok(b) => b
            .and_then(|b| serde_json::from_str::<Value>(&b).ok())
            .and_then(|mut v| v.get_mut("block").map(Value::take)),
        Err(e) => {
            tracing::warn!(error = %e, "heartbeat lookup failed");
            None
        }
    }
}

/// PUT /nodes/{id}/block-rules {enabled} (admin).
pub async fn set_node(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, node)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<NodeSwitchReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let Some(changed) = apply_set_node(&mut tx, &Actor::of(&user), node, req.enabled).await? else {
        return Err(ApiError::not_found());
    };
    tx.commit().await?;
    Ok(Json(json!({ "enabled": req.enabled, "changed": changed })))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, patch};
    axum::Router::new()
        .route("/{prefix}/api/v1/block-rules", get(list).post(create))
        .route(
            "/{prefix}/api/v1/block-rules/{id}",
            patch(update).delete(delete),
        )
        .route(
            "/{prefix}/api/v1/nodes/{id}/block-rules",
            get(node_view).put(set_node),
        )
}

#[cfg(test)]
mod tests;
