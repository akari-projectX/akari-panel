//! Audit log (M1-7): who changed what, when, from where, with redacted
//! before/after snapshots.
//!
//! Rules:
//! - A mutation's row is written by `record` on the mutation's own
//!   connection, inside its transaction (the `apply_*` functions take the
//!   `Actor` and record themselves), so a rolled-back change leaves no row
//!   and a committed one always has its row.
//! - Snapshots never contain secrets: no password hashes, subscription
//!   tokens, passkey material, proxy credentials or raw inbound
//!   JSON (which can hold REALITY private keys, TLS keys, client ids). Such
//!   fields appear only as a marker that they changed (`"changed"`), and
//!   inbounds only as an allow-listed summary plus a digest.
//! - Login events: successes are recorded (admins always, regular users at
//!   most once per account per `LOGIN_OK_THROTTLE_SECS`); failures only for
//!   existing accounts, and only the first failure of an account's
//!   rate-limit window and the one that fills it. Unknown addresses are
//!   never recorded. Together with login_limit.rs this bounds the rows a
//!   remote client can create; failure rows are written off the request
//!   path so their cost is not a timing oracle for account existence.
//! - Not recorded: logout (it only ends the caller's own sessions), the
//!   traffic-limit disable and user-expiry passes (visible in the user's
//!   state: `disabled_reason`, `expires_at`), subscription fetches.
//! - M3 periodic passes ARE recorded, actor `system`: traffic period
//!   resets (`user.traffic.reset`, one row per user and period) and plan
//!   expiry (`user.plan.expire`), since they change usage and access.
//! - Retention: rows older than `audit.retention_days` (default 365; 0 =
//!   keep forever) are pruned hourly by the reaper loop on any instance.

use std::net::IpAddr;

use axum::Json;
use axum::extract::{Query, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

/// Who performed an action.
#[derive(Clone, Debug)]
pub struct Actor {
    pub id: Option<Uuid>,
    /// Non-personal label (Q4): `user_label(id)` for accounts, else one of
    /// the constants below. Displays join `users` on `id` for the address.
    pub label: String,
    pub ip: Option<IpAddr>,
}

/// actor_label of command-line actions.
pub const CLI: &str = "cli";
/// actor_label of the panel's own periodic passes (M3: traffic period
/// resets, plan expiry).
pub const SYSTEM: &str = "system";
/// actor_label of actions an agent triggers itself (enrollment, certificate
/// renewal); `ip` = the agent's source address.
pub const AGENT: &str = "agent";

/// actor_label of an unauthenticated request (a failed login: the target is
/// the account it named).
pub const ANONYMOUS: &str = "anonymous";

/// The non-personal label of an account in snapshot columns (Q4: money and
/// audit rows outlive accounts and must not keep their email address):
/// "u-" + the first 8 hex digits of the id. Stable, so it still groups an
/// erased account's rows; never parsed back (the id columns are the link).
pub fn user_label(id: Uuid) -> String {
    let mut s = id.simple().to_string();
    s.truncate(8);
    format!("u-{s}")
}

/// SQL expression of `user_label` over a uuid expression (snapshot columns
/// written by SQL, e.g. batch items).
pub fn user_label_sql(id: &str) -> String {
    format!("('u-' || left(replace(({id})::text, '-', ''), 8))")
}

impl Actor {
    pub fn cli() -> Self {
        Self {
            id: None,
            label: CLI.into(),
            ip: None,
        }
    }

    pub fn system() -> Self {
        Self {
            id: None,
            label: SYSTEM.into(),
            ip: None,
        }
    }

    pub fn agent(ip: Option<IpAddr>) -> Self {
        Self {
            id: None,
            label: AGENT.into(),
            ip,
        }
    }

    pub fn anonymous(ip: Option<IpAddr>) -> Self {
        Self {
            id: None,
            label: ANONYMOUS.into(),
            ip,
        }
    }

    pub fn of(user: &AuthUser) -> Self {
        Self::account(user.id, user.ip)
    }

    pub fn account(id: Uuid, ip: Option<IpAddr>) -> Self {
        Self {
            id: Some(id),
            label: user_label(id),
            ip,
        }
    }

    #[cfg(test)]
    pub fn test() -> Self {
        Self {
            id: None,
            label: "test".into(),
            ip: None,
        }
    }
}

/// Write one audit row on `conn` (the caller's transaction).
pub async fn record(
    conn: &mut PgConnection,
    actor: &Actor,
    action: &str,
    target_type: &str,
    target_id: Option<String>,
    before: Option<Value>,
    after: Option<Value>,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO audit_log (actor_id, actor_label, ip, action, target_type, target_id, before, after) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(actor.id)
    .bind(&actor.label)
    .bind(actor.ip.map(|ip| crate::client_ip::canonical(ip).to_string()))
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .bind(before)
    .bind(after)
    .execute(conn)
    .await?;
    Ok(())
}

/// Marker stored instead of a secret's value.
pub const CHANGED: &str = "changed";

/// SQL expression: the redacted jsonb snapshot of a `users` row under
/// `alias` (e.g. `old`/`new` in an UPDATE ... RETURNING). Never
/// password_hash, sub_token_hash or session_ver. `alias` is a code
/// constant, never input.
pub fn user_snapshot_sql(alias: &str) -> String {
    format!(
        "jsonb_build_object('email', {a}.email, 'role', {a}.role, 'enabled', {a}.enabled, \
         'traffic_limit_bytes', {a}.traffic_limit_bytes, 'expires_at', {a}.expires_at)",
        a = alias
    )
}

/// SQL expression: the snapshot of a `nodes` row (inbounds go through
/// `inbounds_summary`; cert serial, versions and runtime state are left out).
pub fn node_snapshot_sql(alias: &str) -> String {
    format!(
        "jsonb_build_object('name', {a}.name, 'enabled', {a}.enabled, 'server_addr', {a}.server_addr, \
         'region', {a}.region, 'tls_domain', {a}.tls_domain, \
         'traffic_max_rate_bytes_per_sec', {a}.traffic_max_rate_bytes_per_sec, \
         'display_name', {a}.display_name, 'sort', {a}.sort, 'visible', {a}.visible, \
         'tags', {a}.tags, 'traffic_rate_permille', {a}.traffic_rate_permille, \
         'connect_overrides', {a}.connect_overrides, \
         'deleting', {a}.deleting_at IS NOT NULL)",
        a = alias
    )
}

/// Inbounds as the audit log may show them: per inbound only tag,
/// protocol, listen, port, transport and security (allow-list), plus a
/// SHA-256 of the full JSON so any change is visible without its content.
pub fn inbounds_summary(inbounds: &Value) -> Value {
    let items: Vec<Value> = inbounds
        .as_array()
        .map(|a| {
            a.iter()
                .map(|i| {
                    let ss = i.get("streamSettings");
                    json!({
                        "tag": i.get("tag").and_then(Value::as_str),
                        "protocol": i.get("protocol").and_then(Value::as_str),
                        "listen": i.get("listen").and_then(Value::as_str),
                        "port": i.get("port").filter(|p| p.is_u64() || p.is_string()),
                        "network": ss.and_then(|s| s.get("network")).and_then(Value::as_str),
                        "security": ss.and_then(|s| s.get("security")).and_then(Value::as_str),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "inbounds": items,
        "sha256": hex::encode(Sha256::digest(inbounds.to_string().as_bytes())),
    })
}

// ---------------------------------------------------------------------------
// Query API: GET /api/v1/audit?limit&before&actor&action (admin).
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AuditQuery {
    limit: Option<i64>,
    /// Keyset cursor: only entries with id < before (the previous page's
    /// `next_before`).
    before: Option<i64>,
    /// Exact actor_label ("cli" for command-line actions, `u-…` for an
    /// account).
    actor: Option<String>,
    /// Exact action, or a prefix ending in '.' (e.g. "user.").
    action: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AuditEntry {
    id: i64,
    at: DateTime<Utc>,
    actor_id: Option<Uuid>,
    actor_label: String,
    /// The acting account's current address (null: not an account, or
    /// deleted since).
    actor_email: Option<String>,
    ip: Option<String>,
    action: String,
    target_type: Option<String>,
    target_id: Option<String>,
    before: Option<Value>,
    after: Option<Value>,
}

#[derive(Serialize)]
pub struct AuditPage {
    entries: Vec<AuditEntry>,
    /// Pass as `before` for the next (older) page; null when this is the
    /// last one.
    next_before: Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<AuditQuery>,
) -> Result<Json<AuditPage>, ApiError> {
    user.require_admin()?;
    Ok(Json(query_page(state.pg(), &q).await?))
}

async fn query_page(pg: &sqlx::PgPool, q: &AuditQuery) -> Result<AuditPage, ApiError> {
    const COLS: &str =
        "id, at, actor_id, actor_label, ip, action, target_type, target_id, before, after";
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let action = q.action.as_deref().filter(|a| !a.is_empty());
    // The page query (index-friendly, see below) is wrapped once to join the
    // acting account's current address (Q4: the row keeps a label only).
    let mut qb = sqlx::QueryBuilder::new("SELECT q.*, u.email AS actor_email FROM (");
    let prefix = action.filter(|a| a.ends_with('.'));
    if let Some(p) = prefix {
        // Prefix match (M2-2) without LIKE wildcards from the input and
        // without scanning the newest rows of every other action: list the
        // distinct actions with a loose scan of the (action, id) index,
        // keep those starting with the prefix (exact, any collation), take
        // the newest rows of each from its own index range, merge.
        qb.push(
            "WITH RECURSIVE acts AS ( \
               (SELECT action FROM audit_log ORDER BY action LIMIT 1) \
               UNION ALL \
               SELECT (SELECT a.action FROM audit_log a WHERE a.action > acts.action \
                       ORDER BY a.action LIMIT 1) \
               FROM acts WHERE acts.action IS NOT NULL) \
             SELECT e.* FROM (SELECT action FROM acts WHERE action IS NOT NULL AND left(action, ",
        )
        .push_bind(p.chars().count() as i32)
        .push(") = ")
        .push_bind(p.to_string())
        .push(") m CROSS JOIN LATERAL (SELECT ")
        .push(COLS)
        .push(" FROM audit_log WHERE action >= m.action AND action <= m.action");
    } else {
        qb.push("SELECT ")
            .push(COLS)
            .push(" FROM audit_log WHERE true");
        if let Some(a) = action {
            qb.push(" AND action >= ")
                .push_bind(a.to_string())
                .push(" AND action <= ")
                .push_bind(a.to_string());
        }
    }
    if let Some(b) = q.before {
        qb.push(" AND id < ").push_bind(b);
    }
    if let Some(a) = q.actor.as_deref().filter(|a| !a.is_empty()) {
        if action.is_some() {
            qb.push(" AND actor_label = ").push_bind(a.to_string());
        } else {
            qb.push(" AND actor_label >= ")
                .push_bind(a.to_string())
                .push(" AND actor_label <= ")
                .push_bind(a.to_string());
        }
    }
    // M2-2: equality on the filtered column is written as `>= x AND <= x`
    // (identical under the database's deterministic collation) and leads
    // the ORDER BY: the planner then walks that column's (column, id)
    // index backward. With a plain `=` it prunes the constant sort key and
    // filters the primary key from the newest row down instead — fast for
    // common values, a scan of most of the table for rare ones.
    let order = match (action, q.actor.as_deref().filter(|a| !a.is_empty())) {
        (Some(_), _) => " ORDER BY action DESC, id DESC LIMIT ",
        (None, Some(_)) => " ORDER BY actor_label DESC, id DESC LIMIT ",
        (None, None) => " ORDER BY id DESC LIMIT ",
    };
    qb.push(order).push_bind(limit + 1);
    if prefix.is_some() {
        qb.push(") e ORDER BY e.id DESC LIMIT ")
            .push_bind(limit + 1);
    }
    qb.push(") q LEFT JOIN users u ON u.id = q.actor_id ORDER BY q.id DESC");
    let mut entries: Vec<AuditEntry> = qb.build_query_as().fetch_all(pg).await?;
    let more = entries.len() as i64 > limit;
    entries.truncate(limit as usize);
    let next_before = if more {
        entries.last().map(|e| e.id)
    } else {
        None
    };
    Ok(AuditPage {
        entries,
        next_before,
    })
}

// ---------------------------------------------------------------------------
// Retention.
// ---------------------------------------------------------------------------

/// How often the reaper loop prunes.
pub const PRUNE_EVERY: std::time::Duration = std::time::Duration::from_secs(3600);
const PRUNE_BATCH: i64 = 10_000;

/// Delete rows older than `retention_days` (0 = keep forever), in batches
/// so a large backlog never holds one long transaction. Returns the number
/// deleted.
pub async fn prune(pg: &sqlx::PgPool, retention_days: u32) -> sqlx::Result<u64> {
    if retention_days == 0 {
        return Ok(0);
    }
    let mut total = 0;
    loop {
        let n = sqlx::query(
            "DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log \
             WHERE at < now() - make_interval(days => $1) ORDER BY id LIMIT $2)",
        )
        .bind(i32::try_from(retention_days).unwrap_or(i32::MAX))
        .bind(PRUNE_BATCH)
        .execute(pg)
        .await?
        .rows_affected();
        total += n;
        if n < PRUNE_BATCH as u64 {
            return Ok(total);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::TestDb;

    #[test]
    fn inbounds_summary_drops_secrets() {
        let inb = json!([{
            "tag": "r", "protocol": "vless", "port": 443, "listen": "0.0.0.0",
            "settings": {"clients": [{"id": "client-uuid-secret"}], "decryption": "none"},
            "streamSettings": {"network": "tcp", "security": "reality",
                "realitySettings": {"privateKey": "PRIVATE-KEY-SECRET", "shortIds": ["abcd"]},
                "tlsSettings": {"certificates": [{"key": "TLS-KEY-SECRET"}]}}
        }]);
        let s = inbounds_summary(&inb);
        let text = s.to_string();
        for secret in [
            "client-uuid-secret",
            "PRIVATE-KEY-SECRET",
            "TLS-KEY-SECRET",
            "abcd",
        ] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert_eq!(s["inbounds"][0]["tag"], "r");
        assert_eq!(s["inbounds"][0]["security"], "reality");
        assert_eq!(s["inbounds"][0]["port"], 443);
        let mut changed = inb.clone();
        changed[0]["streamSettings"]["realitySettings"]["privateKey"] = json!("other");
        assert_ne!(inbounds_summary(&changed)["sha256"], s["sha256"]);
    }

    async fn insert(db: &TestDb, n: usize, actor: &str, action: &str) {
        for _ in 0..n {
            let mut c = db.pool.acquire().await.unwrap();
            let a = Actor {
                id: None,
                label: actor.into(),
                ip: Some("::ffff:192.0.2.1".parse().unwrap()),
            };
            record(&mut c, &a, action, "user", Some("x".into()), None, None)
                .await
                .unwrap();
        }
    }

    fn q(limit: i64, before: Option<i64>, actor: Option<&str>, action: Option<&str>) -> AuditQuery {
        AuditQuery {
            limit: Some(limit),
            before,
            actor: actor.map(String::from),
            action: action.map(String::from),
        }
    }

    #[tokio::test]
    async fn keyset_pagination_and_filters() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        insert(&db, 7, "alice", "user.update").await;
        insert(&db, 5, "bob", "node.update").await;
        insert(&db, 3, "cli", "user.create").await;
        // Walk all 15 newest-first, 4 per page.
        let mut seen = Vec::new();
        let mut before = None;
        loop {
            let p = query_page(&db.pool, &q(4, before, None, None))
                .await
                .unwrap();
            assert!(p.entries.len() <= 4);
            seen.extend(p.entries.iter().map(|e| e.id));
            match p.next_before {
                Some(b) => before = Some(b),
                None => break,
            }
        }
        assert_eq!(seen.len(), 15);
        assert!(
            seen.windows(2).all(|w| w[0] > w[1]),
            "strictly newest first"
        );
        let p = query_page(&db.pool, &q(50, None, Some("bob"), None))
            .await
            .unwrap();
        assert_eq!(p.entries.len(), 5);
        assert!(p.next_before.is_none());
        assert!(p.entries.iter().all(|e| e.actor_label == "bob"));
        let p = query_page(&db.pool, &q(50, None, None, Some("user.")))
            .await
            .unwrap();
        assert_eq!(p.entries.len(), 10, "prefix");
        // Prefix (M2-2 merge of per-action ranges): newest first across
        // actions, pages via `before`, combines with actor, and ignores
        // look-alikes a linguistic collation sorts in between.
        insert(&db, 2, "bob", "username.x").await;
        insert(&db, 2, "bob", "user").await;
        insert(&db, 2, "alice", "userx.y").await;
        let mut prefix = Vec::new();
        let mut before = None;
        loop {
            let p = query_page(&db.pool, &q(3, before, None, Some("user.")))
                .await
                .unwrap();
            assert!(p.entries.iter().all(|e| e.action.starts_with("user.")));
            prefix.extend(p.entries.iter().map(|e| e.id));
            match p.next_before {
                Some(b) => before = Some(b),
                None => break,
            }
        }
        assert_eq!(prefix.len(), 10, "prefix across pages");
        assert!(prefix.windows(2).all(|w| w[0] > w[1]), "newest first");
        let p = query_page(&db.pool, &q(50, None, Some("cli"), Some("user.")))
            .await
            .unwrap();
        assert_eq!(p.entries.len(), 3, "prefix + actor");
        let p = query_page(&db.pool, &q(50, None, None, Some("nothing.")))
            .await
            .unwrap();
        assert!(p.entries.is_empty() && p.next_before.is_none());
        let p = query_page(&db.pool, &q(50, None, None, Some("user.create")))
            .await
            .unwrap();
        assert_eq!(p.entries.len(), 3, "exact");
        let p = query_page(&db.pool, &q(50, None, None, Some("user%")))
            .await
            .unwrap();
        assert_eq!(p.entries.len(), 0, "no LIKE wildcards");
        // IPv4-mapped addresses are stored canonical.
        assert_eq!(p_ip(&db).await, "192.0.2.1");
        // Limit is clamped.
        let p = query_page(&db.pool, &q(0, None, None, None)).await.unwrap();
        assert_eq!(p.entries.len(), 1);
        db.drop().await;
    }

    async fn p_ip(db: &TestDb) -> String {
        sqlx::query_scalar("SELECT ip FROM audit_log LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn retention_prunes_only_old_rows() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        insert(&db, 3, "a", "x").await;
        sqlx::query("UPDATE audit_log SET at = now() - interval '400 days'")
            .execute(&db.pool)
            .await
            .unwrap();
        insert(&db, 2, "a", "y").await;
        sqlx::query(
            "UPDATE audit_log SET at = now() - interval '10 days' WHERE action = 'y' \
             AND id = (SELECT min(id) FROM audit_log WHERE action = 'y')",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        assert_eq!(prune(&db.pool, 0).await.unwrap(), 0, "0 = keep forever");
        assert_eq!(prune(&db.pool, 365).await.unwrap(), 3);
        assert_eq!(prune(&db.pool, 30).await.unwrap(), 0);
        assert_eq!(prune(&db.pool, 5).await.unwrap(), 1);
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(left, 1);
        db.drop().await;
    }
}
