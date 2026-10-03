//! The alert evaluator: gather facts, decide per (node, kind) with a pure
//! function, then move `node_alerts` and queue notifications — all in one
//! transaction that holds the round's advisory lock (one instance at a
//! time; see `alerts` module docs).

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

use super::{LIVE_KINDS, Settings, kind_label};
use crate::state::AppState;

/// Resolved alerts are kept this long, settled notifications this long.
const ALERT_RETENTION_DAYS: i64 = 90;
const NOTIFICATION_RETENTION_DAYS: i64 = 30;
const PRUNE_BATCH: i64 = 1000;
const MAX_DETAIL: usize = 600;
const MAX_VALUE: usize = 200;

// ---------------------------------------------------------------------------
// Facts and rules (pure)
// ---------------------------------------------------------------------------

/// The effective rules of one node (global settings, its overrides and
/// disabled kinds applied). None/false = the rule is off.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Rules {
    pub offline_secs: Option<i64>,
    pub cpu: Option<(f64, i64)>,
    pub mem: Option<(f64, i64)>,
    pub disk: Option<f64>,
    pub cert_days: Option<i64>,
    pub latency: bool,
    pub last_error: bool,
}

/// What the evaluator knows about one monitored node.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub online: bool,
    /// Seconds since the node was last seen (None = never).
    pub seen_age_secs: Option<i64>,
    pub last_error: Option<String>,
    pub agent_cert_not_after: Option<DateTime<Utc>>,
    pub tls_domain: Option<String>,
    /// Complete minutes, `(minutes ago (1 = the last complete minute),
    /// value)`: average CPU % and memory %.
    pub cpu: Vec<(i64, f64)>,
    pub mem: Vec<(i64, f64)>,
    /// The latest heartbeat (Valkey) was found.
    pub heartbeat: bool,
    pub disk: Option<(i64, i64)>,
    /// W10 certificate in the heartbeat: (state, not_after).
    pub cert: Option<CertFacts>,
    /// Latency result sets: (source, measurable targets, failed, a failed
    /// target with its error).
    pub latency: Vec<(String, i64, i64, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    pub kind: &'static str,
    pub value: String,
    pub detail: String,
}

/// The decision for one node: kinds that fire now (with their current
/// value) and kinds whose state cannot be decided now (kept as they are).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Verdict {
    pub firing: Vec<Observed>,
    pub unknown: Vec<&'static str>,
}

enum Window {
    Fire(f64),
    Clear,
    Unknown,
}

/// "Above `limit` for `minutes`": fires when each of the last `minutes`
/// complete minutes averaged above it; clears as soon as the last complete
/// minute is at or below it (hysteresis: a rising value is undecided until
/// it has lasted long enough); no data for the last minute = undecided.
fn window(points: &[(i64, f64)], limit: f64, minutes: i64) -> Window {
    let at = |ago: i64| points.iter().find(|p| p.0 == ago).map(|p| p.1);
    let Some(last) = at(1) else {
        return Window::Unknown;
    };
    if last <= limit {
        return Window::Clear;
    }
    let mut lowest = last;
    for ago in 2..=minutes {
        match at(ago) {
            Some(v) if v > limit => lowest = lowest.min(v),
            _ => return Window::Unknown,
        }
    }
    Window::Fire(lowest)
}

fn clip(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

fn minutes_text(secs: i64) -> String {
    if secs >= 3600 {
        format!("{} 小时 {} 分", secs / 3600, (secs % 3600) / 60)
    } else if secs >= 60 {
        format!("{} 分钟", secs / 60)
    } else {
        format!("{secs} 秒")
    }
}

fn days_left(at: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let left = at - now;
    if left <= chrono::Duration::zero() {
        format!("已于 {} 过期", at.format("%Y-%m-%d %H:%M UTC"))
    } else {
        format!(
            "剩余 {} 天（{} 到期）",
            left.num_days(),
            at.format("%Y-%m-%d %H:%M UTC")
        )
    }
}

/// Decide every kind for one node (pure).
pub fn evaluate(f: &Facts, r: &Rules, now: DateTime<Utc>) -> Verdict {
    let mut v = Verdict::default();
    let mut fire = |kind: &'static str, value: String, detail: String| {
        v.firing.push(Observed {
            kind,
            value: clip(&value, MAX_VALUE),
            detail: clip(&detail, MAX_DETAIL),
        });
    };
    let mut unknown = Vec::new();
    if let Some(limit) = r.offline_secs
        && let (false, Some(age)) = (f.online, f.seen_age_secs)
        && age >= limit
    {
        fire(
            "offline",
            format!("离线 {}", minutes_text(age)),
            format!("超过 {} 未收到 agent 的连接", minutes_text(limit)),
        );
    }
    if !f.online {
        // Live facts of an offline node are stale: keep those alerts as
        // they are until it reports again.
        unknown.extend(LIVE_KINDS);
    } else {
        if let Some((limit, minutes)) = r.cpu {
            match window(&f.cpu, limit, minutes) {
                Window::Fire(low) => fire(
                    "cpu",
                    format!("CPU {low:.0}%"),
                    format!("最近 {minutes} 分钟每分钟平均 CPU 都高于 {limit:.0}%"),
                ),
                Window::Unknown => unknown.push("cpu"),
                Window::Clear => {}
            }
        }
        if let Some((limit, minutes)) = r.mem {
            match window(&f.mem, limit, minutes) {
                Window::Fire(low) => fire(
                    "memory",
                    format!("内存 {low:.0}%"),
                    format!("最近 {minutes} 分钟每分钟平均内存占用都高于 {limit:.0}%"),
                ),
                Window::Unknown => unknown.push("memory"),
                Window::Clear => {}
            }
        }
        if let Some(limit) = r.disk {
            match f.disk {
                Some((used, total)) if total > 0 => {
                    let pct = used as f64 * 100.0 / total as f64;
                    if pct > limit {
                        fire(
                            "disk",
                            format!("磁盘 {pct:.0}%"),
                            format!(
                                "已用 {:.1} GiB / {:.1} GiB，高于 {limit:.0}%",
                                used as f64 / (1u64 << 30) as f64,
                                total as f64 / (1u64 << 30) as f64
                            ),
                        );
                    }
                }
                // An agent without machine metrics: nothing to judge.
                Some(_) => {}
                None if f.heartbeat => {}
                None => unknown.push("disk"),
            }
        }
        if r.latency {
            for (source, measurable, failed, sample) in &f.latency {
                if *measurable > 0 && failed == measurable {
                    let who = if source == "agent" {
                        "节点出口测速"
                    } else {
                        "面板 TCP 连接测速"
                    };
                    fire(
                        "latency",
                        format!("{who}全部失败"),
                        format!("{who}的 {measurable} 个目标全部失败，例如 {sample}"),
                    );
                    break;
                }
            }
        }
        if let (Some(days), Some(domain)) = (r.cert_days, &f.tls_domain) {
            match &f.cert {
                None if f.heartbeat => {}
                None => unknown.push("cert"),
                Some((state, not_after)) => {
                    if let Some(at) = not_after
                        && *at - now < chrono::Duration::days(days)
                    {
                        fire(
                            "cert",
                            format!("证书{}", days_left(*at, now)),
                            format!(
                                "节点域名 {domain} 的证书（自动申请，状态 {state}）将在 {days} 天内到期，agent 未能续期"
                            ),
                        );
                    }
                }
            }
        }
    }
    if let (Some(days), Some(at)) = (r.cert_days, f.agent_cert_not_after)
        && at - now < chrono::Duration::days(days)
    {
        fire(
            "agent_cert",
            format!("Agent 证书{}", days_left(at, now)),
            "agent 的 mTLS 证书即将到期且未续期：检查 agent 日志，或重新生成安装命令".into(),
        );
    }
    if r.last_error
        && let Some(e) = &f.last_error
    {
        fire("last_error", "配置应用失败".into(), e.clone());
    }
    v.unknown = unknown;
    v
}

/// A firing alert as stored.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Firing {
    pub id: i64,
    pub node_id: Uuid,
    pub kind: String,
    pub value: String,
    pub detail: String,
    pub notified: bool,
    pub fired_at: DateTime<Utc>,
    pub node_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Fire {
        node: Uuid,
        obs: Observed,
    },
    Update {
        id: i64,
        value: String,
        detail: String,
    },
    /// `notify`: send the resolved notification (the firing one was sent).
    Resolve {
        id: i64,
        notify: bool,
    },
}

/// The transitions from the stored firing alerts to this round's verdicts
/// (pure). Nodes absent from `verdicts` are no longer monitored (disabled,
/// being deleted, alerts switched off): their alerts resolve silently.
pub fn plan(firing: &[Firing], verdicts: &HashMap<Uuid, Verdict>) -> Vec<Step> {
    let mut steps = Vec::new();
    let mut seen: HashSet<(Uuid, &str)> = HashSet::new();
    for f in firing {
        seen.insert((f.node_id, f.kind.as_str()));
        let Some(v) = verdicts.get(&f.node_id) else {
            steps.push(Step::Resolve {
                id: f.id,
                notify: false,
            });
            continue;
        };
        if let Some(o) = v.firing.iter().find(|o| o.kind == f.kind) {
            if o.value != f.value || o.detail != f.detail {
                steps.push(Step::Update {
                    id: f.id,
                    value: o.value.clone(),
                    detail: o.detail.clone(),
                });
            }
        } else if !v.unknown.contains(&f.kind.as_str()) {
            steps.push(Step::Resolve {
                id: f.id,
                notify: f.notified,
            });
        }
    }
    let mut nodes: Vec<&Uuid> = verdicts.keys().collect();
    nodes.sort();
    for node in nodes {
        for o in &verdicts[node].firing {
            if !seen.contains(&(*node, o.kind)) {
                steps.push(Step::Fire {
                    node: *node,
                    obs: o.clone(),
                });
            }
        }
    }
    steps
}

// ---------------------------------------------------------------------------
// Gathering (database + Valkey)
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct NodeRow {
    id: Uuid,
    name: String,
    online: bool,
    seen_age_secs: Option<i64>,
    last_error: Option<String>,
    cert_not_after: Option<DateTime<Utc>>,
    tls_domain: Option<String>,
    muted: Option<bool>,
    disabled: Option<Vec<String>>,
    offline_secs: Option<i32>,
    cpu_percent: Option<i32>,
    cpu_minutes: Option<i32>,
    mem_percent: Option<i32>,
    mem_minutes: Option<i32>,
    disk_percent: Option<i32>,
    cert_days: Option<i32>,
}

/// One monitored node: name, whether it is muted, its rules and facts.
pub struct Monitored {
    pub id: Uuid,
    pub name: String,
    pub muted: bool,
    pub rules: Rules,
    pub facts: Facts,
}

fn rules_of(s: &Settings, n: &NodeRow) -> Rules {
    let off = |k: &str| {
        n.disabled
            .as_ref()
            .is_some_and(|d| d.iter().any(|x| x == k))
    };
    let pick = |k: &str, o: Option<i32>, g: Option<i32>| if off(k) { None } else { o.or(g) };
    let cpu_minutes = i64::from(n.cpu_minutes.unwrap_or(s.cpu_minutes));
    let mem_minutes = i64::from(n.mem_minutes.unwrap_or(s.mem_minutes));
    Rules {
        offline_secs: pick("offline", n.offline_secs, s.offline_secs).map(i64::from),
        cpu: pick("cpu", n.cpu_percent, s.cpu_percent).map(|p| (f64::from(p), cpu_minutes)),
        mem: pick("memory", n.mem_percent, s.mem_percent).map(|p| (f64::from(p), mem_minutes)),
        disk: pick("disk", n.disk_percent, s.disk_percent).map(f64::from),
        // One threshold for both certificates; each kind can be disabled.
        cert_days: if off("cert") && off("agent_cert") {
            None
        } else {
            n.cert_days.or(s.cert_days).map(i64::from)
        },
        latency: s.latency_failures && !off("latency"),
        last_error: s.last_error && !off("last_error"),
    }
}

/// W10 certificate state in a heartbeat: (state, not_after).
pub type CertFacts = (String, Option<DateTime<Utc>>);

/// A resolved alert: node, kind, value, detail, fired, resolved, node name.
type Resolved = (
    Uuid,
    String,
    String,
    String,
    DateTime<Utc>,
    DateTime<Utc>,
    String,
);

/// The parts of a heartbeat blob the rules read.
pub fn heartbeat_facts(blob: &str) -> (Option<(i64, i64)>, Option<CertFacts>) {
    let Ok(v) = serde_json::from_str::<Value>(blob) else {
        return (None, None);
    };
    let disk = v.get("metrics").and_then(|m| {
        Some((
            m.get("disk_used_bytes")?.as_i64()?,
            m.get("disk_total_bytes")?.as_i64()?,
        ))
    });
    let cert = v.get("cert").filter(|c| c.is_object()).map(|c| {
        (
            c.get("state")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            c.get("not_after")
                .and_then(Value::as_str)
                .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.with_timezone(&Utc)),
        )
    });
    (disk, cert)
}

/// Every monitored node (enabled, enrolled, not being deleted) with its
/// rules and facts.
pub async fn gather(
    state: &AppState,
    conn: &mut PgConnection,
    s: &Settings,
) -> anyhow::Result<Vec<Monitored>> {
    let rows: Vec<NodeRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT n.id, coalesce(n.display_name, n.name) AS name, {} AS online, \
           EXTRACT(EPOCH FROM now() - n.last_seen_at)::bigint AS seen_age_secs, n.last_error, \
           n.cert_not_after, n.tls_domain, r.muted, r.disabled, r.offline_secs, r.cpu_percent, \
           r.cpu_minutes, r.mem_percent, r.mem_minutes, r.disk_percent, r.cert_days \
         FROM nodes n LEFT JOIN node_alert_rules r ON r.node_id = n.id \
         WHERE n.enabled AND n.deleting_at IS NULL AND n.cert_serial IS NOT NULL \
         ORDER BY n.id",
        crate::nodestat::online_sql("n")
    )))
    .fetch_all(&mut *conn)
    .await?;
    let mut out: Vec<Monitored> = rows
        .iter()
        .map(|n| Monitored {
            id: n.id,
            name: n.name.clone(),
            muted: n.muted.unwrap_or(false),
            rules: rules_of(s, n),
            facts: Facts {
                online: n.online,
                seen_age_secs: n.seen_age_secs,
                last_error: n.last_error.clone(),
                agent_cert_not_after: n.cert_not_after,
                tls_domain: n.tls_domain.clone(),
                ..Default::default()
            },
        })
        .collect();
    if out.is_empty() {
        return Ok(out);
    }
    let ids: Vec<Uuid> = out.iter().map(|m| m.id).collect();
    let index: HashMap<Uuid, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();

    // Minute history, only as far back as the longest window in use.
    let longest = out
        .iter()
        .flat_map(|m| [m.rules.cpu.map(|c| c.1), m.rules.mem.map(|c| c.1)])
        .flatten()
        .max()
        .unwrap_or(0);
    if longest > 0 {
        // W23: NULL sums = unknown minutes (no point: the window is then
        // undecided, as for a missing minute).
        let points: Vec<(Uuid, i64, Option<f64>, Option<f64>)> = sqlx::query_as(
            "SELECT node_id, \
               (EXTRACT(EPOCH FROM date_trunc('minute', now()) - bucket) / 60)::bigint AS ago, \
               cpu_sum / samples, \
               CASE WHEN mem_total > 0 THEN mem_used_sum / samples * 100 / mem_total END \
             FROM node_metrics_1m WHERE node_id = ANY($1) \
               AND bucket >= date_trunc('minute', now()) - make_interval(mins => $2) \
               AND bucket < date_trunc('minute', now())",
        )
        .bind(&ids)
        .bind(i32::try_from(longest).unwrap_or(60))
        .fetch_all(&mut *conn)
        .await?;
        for (node, ago, cpu, mem) in points {
            if let Some(&i) = index.get(&node) {
                if let Some(c) = cpu {
                    out[i].facts.cpu.push((ago, c));
                }
                if let Some(m) = mem {
                    out[i].facts.mem.push((ago, m));
                }
            }
        }
    }

    // Latency: per source, the measurable targets (UDP-only and
    // address-less inbounds are not failures) and how many failed.
    let lat: Vec<(Uuid, String, i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT node_id, source, \
           count(*) FILTER (WHERE coalesce(error, '') NOT IN ('udp', 'no address')), \
           count(*) FILTER (WHERE delay_ms IS NULL AND coalesce(error, '') NOT IN ('udp', 'no address')), \
           min(target || ': ' || coalesce(error, 'failed')) FILTER (WHERE delay_ms IS NULL \
               AND coalesce(error, '') NOT IN ('udp', 'no address')) \
         FROM node_latency WHERE node_id = ANY($1) GROUP BY node_id, source ORDER BY node_id, source",
    )
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await?;
    for (node, source, measurable, failed, sample) in lat {
        if let Some(&i) = index.get(&node) {
            out[i]
                .facts
                .latency
                .push((source, measurable, failed, sample.unwrap_or_default()));
        }
    }

    // Latest heartbeats (best effort: Valkey down = live kinds undecided).
    use fred::prelude::KeysInterface;
    let keys: Vec<String> = ids.iter().map(|id| format!("akari:node:hb:{id}")).collect();
    match state.valkey().mget::<Vec<Option<String>>, _>(keys).await {
        Ok(blobs) => {
            for (m, blob) in out.iter_mut().zip(blobs) {
                if let Some(b) = blob {
                    let (disk, cert) = heartbeat_facts(&b);
                    m.facts.heartbeat = true;
                    m.facts.disk = disk;
                    m.facts.cert = cert;
                }
            }
        }
        Err(e) => tracing::warn!(error = %e, "alerts: heartbeat lookup failed"),
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RoundStats {
    pub monitored: usize,
    pub fired: usize,
    pub resolved: usize,
    pub notifications: usize,
}

/// The round's advisory lock key: per schema (production: one), so the
/// tests' schemas do not contend for it.
const LOCK_SQL: &str =
    "SELECT pg_try_advisory_xact_lock(hashtextextended('akari.alerts.' || current_schema(), 0))";

/// One evaluation round, if this instance wins the lock (None = another
/// instance is evaluating right now).
pub async fn round(state: &AppState) -> anyhow::Result<Option<RoundStats>> {
    let mut tx = state.pg().begin().await?;
    let got: bool = sqlx::query_scalar(LOCK_SQL).fetch_one(&mut *tx).await?;
    if !got {
        return Ok(None);
    }
    let s = super::load(&mut tx).await?;
    let monitored = if s.enabled {
        gather(state, &mut tx, &s).await?
    } else {
        Vec::new()
    };
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *tx)
        .await?;
    let verdicts: HashMap<Uuid, Verdict> = monitored
        .iter()
        .map(|m| (m.id, evaluate(&m.facts, &m.rules, now)))
        .collect();
    let firing: Vec<Firing> = sqlx::query_as(
        "SELECT a.id, a.node_id, a.kind, a.value, a.detail, a.notified, a.fired_at, \
           coalesce(n.display_name, n.name) AS node_name \
         FROM node_alerts a JOIN nodes n ON n.id = a.node_id WHERE a.status = 'firing' \
         ORDER BY a.id",
    )
    .fetch_all(&mut *tx)
    .await?;
    let steps = plan(&firing, &verdicts);
    let names: HashMap<Uuid, (&str, bool)> = monitored
        .iter()
        .map(|m| (m.id, (m.name.as_str(), m.muted)))
        .collect();
    let channels = s.channels();
    let mut stats = RoundStats {
        monitored: monitored.len(),
        ..Default::default()
    };
    for step in steps {
        match step {
            Step::Update { id, value, detail } => {
                sqlx::query("UPDATE node_alerts SET value = $2, detail = $3 WHERE id = $1")
                    .bind(id)
                    .bind(&value)
                    .bind(&detail)
                    .execute(&mut *tx)
                    .await?;
            }
            Step::Fire { node, obs } => {
                let (name, muted) = names.get(&node).copied().unwrap_or(("?", true));
                let row: Option<(i64, DateTime<Utc>)> = sqlx::query_as(
                    "INSERT INTO node_alerts (node_id, kind, status, value, detail) \
                     VALUES ($1, $2, 'firing', $3, $4) \
                     ON CONFLICT (node_id, kind) WHERE status = 'firing' DO NOTHING \
                     RETURNING id, fired_at",
                )
                .bind(node)
                .bind(obs.kind)
                .bind(&obs.value)
                .bind(&obs.detail)
                .fetch_optional(&mut *tx)
                .await?;
                let Some((id, fired_at)) = row else {
                    continue;
                };
                stats.fired += 1;
                if muted || channels.is_empty() {
                    continue;
                }
                let cooling: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM node_alerts WHERE node_id = $1 AND kind = $2 \
                       AND notified AND id <> $3 \
                       AND fired_at > now() - make_interval(mins => $4))",
                )
                .bind(node)
                .bind(obs.kind)
                .bind(id)
                .bind(s.cooldown_minutes)
                .fetch_one(&mut *tx)
                .await?;
                if cooling {
                    continue;
                }
                sqlx::query("UPDATE node_alerts SET notified = true WHERE id = $1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                let msg = super::channels::Message::alert(
                    "firing",
                    id,
                    node,
                    name,
                    obs.kind,
                    &obs.value,
                    &obs.detail,
                    fired_at,
                    None,
                );
                stats.notifications += super::channels::enqueue(&mut tx, &channels, &msg).await?;
            }
            Step::Resolve { id, notify } => {
                let row: Option<Resolved> =
                    sqlx::query_as(
                        "UPDATE node_alerts a SET status = 'resolved', resolved_at = now() \
                         FROM nodes n WHERE a.id = $1 AND a.status = 'firing' AND n.id = a.node_id \
                         RETURNING a.node_id, a.kind, a.value, a.detail, a.fired_at, a.resolved_at, \
                           coalesce(n.display_name, n.name)",
                    )
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
                let Some((node, kind, value, detail, fired_at, resolved_at, name)) = row else {
                    continue;
                };
                stats.resolved += 1;
                let muted = names.get(&node).is_none_or(|n| n.1);
                if notify && s.notify_resolved && !muted && !channels.is_empty() {
                    let msg = super::channels::Message::alert(
                        "resolved",
                        id,
                        node,
                        &name,
                        &kind,
                        &value,
                        &detail,
                        fired_at,
                        Some(resolved_at),
                    );
                    stats.notifications +=
                        super::channels::enqueue(&mut tx, &channels, &msg).await?;
                }
            }
        }
    }
    prune(&mut tx).await?;
    tx.commit().await?;
    if stats.fired + stats.resolved > 0 {
        tracing::info!(
            fired = stats.fired,
            resolved = stats.resolved,
            notifications = stats.notifications,
            "alerts evaluated"
        );
    }
    Ok(Some(stats))
}

async fn prune(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DELETE FROM node_alerts WHERE ctid = ANY(ARRAY(SELECT ctid FROM node_alerts \
         WHERE status = 'resolved' AND resolved_at < now() - interval '{ALERT_RETENTION_DAYS} days' \
         LIMIT {PRUNE_BATCH}))"
    )))
    .execute(&mut *conn)
    .await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DELETE FROM alert_notifications WHERE ctid = ANY(ARRAY(SELECT ctid FROM alert_notifications \
         WHERE status <> 'pending' AND created_at < now() - interval '{NOTIFICATION_RETENTION_DAYS} days' \
         LIMIT {PRUNE_BATCH}))"
    )))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Label for a kind in messages (re-exported for channels).
pub fn label(kind: &str) -> &'static str {
    kind_label(kind)
}
