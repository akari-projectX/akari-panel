//! M3 entitlement: which (user, node) pairs a plan grants, and the
//! deterministic reconcile that makes `node_users` match it.
//!
//! Model:
//! - A user's plan-granted nodes = the members of the groups of their
//!   ACTIVE plan (`user_plans.status = 'active'`), minus nodes being
//!   deleted. Role, enabled and expiry do not matter here: what a node
//!   actually serves is still filtered by `enforce::SERVED`, so an
//!   admin/disabled/expired user keeps rows (exactly like pre-M3 manual
//!   assignments) and regains service without new credentials.
//! - A plan-granted pair has a `node_users` row with `manual = false` and
//!   one credential per eligible inbound of the node (protocol vless, vmess
//!   or trojan). Existing credentials whose (tag, protocol) still exists are
//!   kept byte for byte (clients keep working across plan changes); missing
//!   ones are generated; others dropped. A pair with no eligible inbound
//!   has no row.
//! - Manual overrides (`manual = true`: the admin assignment endpoint and
//!   every pre-M3 row) are never touched by the reconcile. Precedence: a
//!   manual row wins over the plan for its (user, node) pair; unassigning a
//!   manual row hands the pair back to the plan (see api::apply_unassign).
//!
//! Concurrency: every writer of node_groups, node_group_members, plans,
//! plan_groups and user_plans — and every caller of `apply_reconcile` —
//! takes `lock()` (a transaction-scoped advisory lock) FIRST, before any
//! row lock. Entitlement changes are therefore serialized, and the
//! reconcile, reading after the lock, sees every committed change (READ
//! COMMITTED: fresh snapshot per statement). Without it, "add node N to
//! group G" and "give user U a plan with G" could each miss the other
//! (write skew). Row locks then follow the global order: nodes (one
//! statement, ORDER BY id) -> users -> node_users.

use std::collections::HashSet;

use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::Credential;

/// Protocols the panel can generate accounts for (protocols.rs).
pub const ELIGIBLE_PROTOCOLS: [&str; 5] = crate::protocols::MANAGED;

/// Take the entitlement lock (held until the transaction ends). Must be the
/// first lock of the transaction.
pub async fn lock(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('akari.entitlement', 0))")
        .execute(conn)
        .await?;
    Ok(())
}

/// What a reconcile looks at.
#[derive(Clone, Copy, Debug)]
pub enum Scope<'a> {
    /// Every pair of these users (all nodes). Also locks every node the
    /// users have any row on (manual included), so a caller may update the
    /// users' rows and bump their nodes afterwards in lock order.
    Users(&'a [Uuid]),
    /// Every pair on these nodes (all users).
    Nodes(&'a [Uuid]),
    /// Only these users on these nodes.
    Pairs {
        users: &'a [Uuid],
        nodes: &'a [Uuid],
    },
}

/// What a reconcile changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// Nodes whose user_version was bumped (sorted).
    pub bumped: Vec<Uuid>,
    /// Pairs that got a new row.
    pub issued: usize,
    /// Pairs whose row was removed (departed rows written).
    pub revoked: usize,
    /// Pairs whose credentials changed.
    pub updated: usize,
}

impl Outcome {
    pub fn summary(&self) -> Value {
        serde_json::json!({
            "issued": self.issued,
            "revoked": self.revoked,
            "updated": self.updated,
            "bumped_nodes": self.bumped,
        })
    }

    fn merge(&mut self, other: Outcome) {
        self.issued += other.issued;
        self.revoked += other.revoked;
        self.updated += other.updated;
        self.bumped.extend(other.bumped);
        self.bumped.sort();
        self.bumped.dedup();
    }
}

/// SQL: the users a node is plan-granted to (bind $1 = node id).
const GRANTED_USERS_OF_NODE: &str = "SELECT up.user_id FROM user_plans up \
     JOIN plan_groups pg ON pg.plan_id = up.plan_id \
     JOIN node_group_members m ON m.group_id = pg.group_id \
     WHERE up.status = 'active' AND m.node_id = $1";

/// (tag, protocol) of a node's inbounds the panel issues credentials for,
/// in inbound order.
pub fn eligible_inbounds(inbounds: &Value) -> Vec<(String, String)> {
    inbounds
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|i| {
                    let tag = i.get("tag")?.as_str()?;
                    let proto = i.get("protocol")?.as_str()?;
                    (!tag.is_empty()
                        && ELIGIBLE_PROTOCOLS.contains(&proto)
                        && crate::protocols::issuable(i))
                    .then(|| (tag.to_string(), proto.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The credentials a plan-granted pair must have: existing ones for still
/// eligible (tag, protocol) kept in their order (accounts refit to their
/// inbound, see protocols::refit_account), then new ones for the rest in
/// inbound order. `None` = unchanged.
fn merge_credentials(
    existing: &[Credential],
    eligible: &[(String, String)],
    inbounds: &Value,
) -> Result<Option<Vec<Credential>>, crate::auth::ApiError> {
    let want: HashSet<(&str, &str)> = eligible
        .iter()
        .map(|(t, p)| (t.as_str(), p.as_str()))
        .collect();
    let mut seen = HashSet::new();
    let kept: Vec<Credential> = existing
        .iter()
        .filter(|c| {
            want.contains(&(c.inbound_tag.as_str(), c.protocol.as_str()))
                && seen.insert(c.inbound_tag.clone())
        })
        .cloned()
        .collect();
    let mut out = crate::api::refit_credentials(kept, inbounds);
    for (tag, proto) in eligible {
        if !seen.contains(tag) {
            out.push(Credential {
                inbound_tag: tag.clone(),
                protocol: proto.clone(),
                account: crate::api::generate_account(
                    crate::api::inbound_by_tag(inbounds, tag).unwrap_or(&Value::Null),
                )?,
            });
        }
    }
    Ok((out != existing).then_some(out))
}

async fn lock_nodes(conn: &mut PgConnection, ids: &[Uuid]) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar("SELECT id FROM nodes WHERE id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(ids)
        .fetch_all(conn)
        .await
}

/// The nodes a scope may touch, as of now.
async fn scope_nodes(conn: &mut PgConnection, scope: Scope<'_>) -> sqlx::Result<Vec<Uuid>> {
    match scope {
        Scope::Nodes(n) | Scope::Pairs { nodes: n, .. } => Ok(n.to_vec()),
        Scope::Users(u) => {
            sqlx::query_scalar(
                "SELECT m.node_id FROM user_plans up \
                 JOIN plan_groups pg ON pg.plan_id = up.plan_id \
                 JOIN node_group_members m ON m.group_id = pg.group_id \
                 WHERE up.status = 'active' AND up.user_id = ANY($1) \
                 UNION SELECT node_id FROM node_users WHERE user_id = ANY($1)",
            )
            .bind(u)
            .fetch_all(conn)
            .await
        }
    }
}

/// Make `node_users` match the plan entitlement for `scope`, in the
/// caller's transaction (which must hold `lock()`): issue rows/credentials
/// for granted pairs, revoke plan rows no longer granted (writing
/// `node_users_departed`, so final counters are still billed), and bump
/// user_version on exactly the nodes whose rows changed. Manual rows are
/// left alone. Idempotent: a second run changes nothing.
pub async fn apply_reconcile(
    conn: &mut PgConnection,
    scope: Scope<'_>,
) -> Result<Outcome, crate::auth::ApiError> {
    let users: Option<&[Uuid]> = match scope {
        Scope::Users(u) | Scope::Pairs { users: u, .. } => Some(u),
        Scope::Nodes(_) => None,
    };
    if users.is_some_and(<[Uuid]>::is_empty) {
        return Ok(Outcome::default());
    }
    let nodes = scope_nodes(conn, scope).await?;
    if nodes.is_empty() {
        return Ok(Outcome::default());
    }
    let locked = lock_nodes(conn, &nodes).await?;
    let mut total = Outcome::default();
    for node in locked {
        total.merge(reconcile_node(conn, node, users).await?);
    }
    Ok(total)
}

/// One locked node.
async fn reconcile_node(
    conn: &mut PgConnection,
    node: Uuid,
    users: Option<&[Uuid]>,
) -> Result<Outcome, crate::auth::ApiError> {
    let (inbounds, deleting): (Value, bool) =
        sqlx::query_as("SELECT xray_inbounds, deleting_at IS NOT NULL FROM nodes WHERE id = $1")
            .bind(node)
            .fetch_one(&mut *conn)
            .await?;
    if deleting {
        // Going away: its rows stay (final counters are billed) until
        // phase 2 deletes the node.
        return Ok(Outcome::default());
    }
    let eligible = eligible_inbounds(&inbounds);
    // Granted users, row-locked FOR KEY SHARE (users after nodes): a
    // concurrent user deletion then waits for us instead of failing our
    // insert's foreign key check.
    let granted: HashSet<Uuid> = if eligible.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, Uuid>(sqlx::AssertSqlSafe(format!(
            "SELECT id FROM users WHERE id IN ({GRANTED_USERS_OF_NODE}) \
             AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY id FOR KEY SHARE"
        )))
        .bind(node)
        .bind(users)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect()
    };
    let rows: Vec<(Uuid, Value, bool)> = sqlx::query_as(
        "SELECT user_id, credentials, manual FROM node_users WHERE node_id = $1 \
         AND ($2::uuid[] IS NULL OR user_id = ANY($2)) ORDER BY user_id FOR UPDATE",
    )
    .bind(node)
    .bind(users)
    .fetch_all(&mut *conn)
    .await?;

    let mut revoke = Vec::new();
    let mut update: Vec<(Uuid, Value)> = Vec::new();
    let mut have = HashSet::new();
    for (user, raw, manual) in rows {
        have.insert(user);
        if manual {
            continue;
        }
        if !granted.contains(&user) {
            revoke.push(user);
            continue;
        }
        let creds: Vec<Credential> = serde_json::from_value(raw)
            .map_err(|e| anyhow::anyhow!("corrupt credentials json: {e}"))?;
        if let Some(new) = merge_credentials(&creds, &eligible, &inbounds)? {
            update.push((user, serde_json::to_value(&new)?));
        }
    }
    let mut issue: Vec<(Uuid, Value)> = Vec::new();
    let mut new_users: Vec<Uuid> = granted.difference(&have).copied().collect();
    new_users.sort();
    for user in new_users {
        if let Some(new) = merge_credentials(&[], &eligible, &inbounds)? {
            issue.push((user, serde_json::to_value(&new)?));
        }
    }

    if !revoke.is_empty() {
        sqlx::query(
            "DELETE FROM node_users WHERE node_id = $1 AND user_id = ANY($2) AND NOT manual",
        )
        .bind(node)
        .bind(&revoke)
        .execute(&mut *conn)
        .await?;
        // The users still exist (rows are only revoked for live users;
        // deletion cascades): their final counters stay billable.
        sqlx::query(
            "INSERT INTO node_users_departed (node_id, user_id, departed_at) \
             SELECT $1, u, now() FROM unnest($2::uuid[]) AS u \
             ON CONFLICT (node_id, user_id) DO UPDATE SET departed_at = now(), billed_bytes = 0",
        )
        .bind(node)
        .bind(&revoke)
        .execute(&mut *conn)
        .await?;
    }
    if !update.is_empty() {
        let (u, c): (Vec<Uuid>, Vec<Value>) = update.iter().cloned().unzip();
        sqlx::query(
            "UPDATE node_users nu SET credentials = t.c \
             FROM unnest($2::uuid[], $3::jsonb[]) AS t(u, c) \
             WHERE nu.node_id = $1 AND nu.user_id = t.u",
        )
        .bind(node)
        .bind(&u)
        .bind(&c)
        .execute(&mut *conn)
        .await?;
    }
    if !issue.is_empty() {
        let (u, c): (Vec<Uuid>, Vec<Value>) = issue.iter().cloned().unzip();
        sqlx::query(
            "INSERT INTO node_users (node_id, user_id, credentials, manual) \
             SELECT $1, t.u, t.c, false FROM unnest($2::uuid[], $3::jsonb[]) AS t(u, c)",
        )
        .bind(node)
        .bind(&u)
        .bind(&c)
        .execute(&mut *conn)
        .await?;
        // Granted again: no longer departed pairs.
        sqlx::query("DELETE FROM node_users_departed WHERE node_id = $1 AND user_id = ANY($2)")
            .bind(node)
            .bind(&u)
            .execute(&mut *conn)
            .await?;
    }
    let changed = !(revoke.is_empty() && update.is_empty() && issue.is_empty());
    if changed {
        sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = $1")
            .bind(node)
            .execute(&mut *conn)
            .await?;
    }
    Ok(Outcome {
        bumped: if changed { vec![node] } else { Vec::new() },
        issued: issue.len(),
        revoked: revoke.len(),
        updated: update.len(),
    })
}

/// Is (user, node) plan-granted right now (node not being deleted, with at
/// least one eligible inbound)?
pub async fn is_granted(conn: &mut PgConnection, user: Uuid, node: Uuid) -> sqlx::Result<bool> {
    let row: Option<(Value, bool)> =
        sqlx::query_as("SELECT xray_inbounds, deleting_at IS NOT NULL FROM nodes WHERE id = $1")
            .bind(node)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((inbounds, deleting)) = row else {
        return Ok(false);
    };
    if deleting || eligible_inbounds(&inbounds).is_empty() {
        return Ok(false);
    }
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT EXISTS ({GRANTED_USERS_OF_NODE} AND up.user_id = $2)"
    )))
    .bind(node)
    .bind(user)
    .fetch_one(conn)
    .await
}

/// Nodes the users have rows on (any kind) — for bumps after a change to
/// what they are served.
pub async fn nodes_of_users(conn: &mut PgConnection, users: &[Uuid]) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar(
        "SELECT DISTINCT node_id FROM node_users WHERE user_id = ANY($1) ORDER BY node_id",
    )
    .bind(users)
    .fetch_all(conn)
    .await
}

/// Debug helper for tests: the pairs a fresh full computation grants
/// (`user -> nodes`), ignoring manual rows.
#[cfg(test)]
pub async fn granted_pairs(conn: &mut PgConnection) -> std::collections::HashMap<Uuid, Vec<Uuid>> {
    let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT DISTINCT up.user_id, m.node_id FROM user_plans up \
         JOIN plan_groups pg ON pg.plan_id = up.plan_id \
         JOIN node_group_members m ON m.group_id = pg.group_id \
         JOIN nodes n ON n.id = m.node_id AND n.deleting_at IS NULL \
         WHERE up.status = 'active' ORDER BY 1, 2",
    )
    .fetch_all(conn)
    .await
    .unwrap_or_default();
    let mut out: std::collections::HashMap<Uuid, Vec<Uuid>> = Default::default();
    for (u, n) in rows {
        out.entry(u).or_default().push(n);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cred(tag: &str, proto: &str, id: &str) -> Credential {
        Credential {
            inbound_tag: tag.into(),
            protocol: proto.into(),
            account: json!({ "id": id }),
        }
    }

    #[test]
    fn eligible_filters_protocols_and_tags() {
        let inb = json!([
            {"tag": "a", "protocol": "vless"},
            {"tag": "b", "protocol": "shadowsocks"},
            {"tag": "", "protocol": "vmess"},
            {"protocol": "trojan"},
            {"tag": "c", "protocol": "trojan"},
        ]);
        assert_eq!(
            eligible_inbounds(&inb),
            vec![("a".into(), "vless".into()), ("c".into(), "trojan".into())]
        );
        assert!(eligible_inbounds(&json!({})).is_empty());
    }

    #[test]
    fn merge_keeps_existing_and_fills_gaps() {
        let elig = vec![
            ("a".to_string(), "vless".to_string()),
            ("b".to_string(), "vmess".to_string()),
        ];
        let inb = json!([{"tag": "a", "protocol": "vless"}, {"tag": "b", "protocol": "vmess"}]);
        let existing = vec![cred("a", "vless", "keep")];
        let out = merge_credentials(&existing, &elig, &inb)
            .ok()
            .flatten()
            .unwrap_or_default();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], existing[0], "kept byte for byte");
        assert_eq!(out[1].inbound_tag, "b");
        // Unchanged when complete.
        assert_eq!(merge_credentials(&out, &elig, &inb).ok(), Some(None));
        // Re-protocoled or removed inbounds are dropped, duplicates too.
        let stale = vec![
            cred("a", "vmess", "x"),
            cred("b", "vmess", "y"),
            cred("b", "vmess", "dup"),
            cred("gone", "vless", "z"),
        ];
        let out = merge_credentials(&stale, &elig, &inb)
            .ok()
            .flatten()
            .unwrap_or_default();
        assert_eq!(out[0], cred("b", "vmess", "y"));
        assert_eq!(out[1].inbound_tag, "a");
        assert_eq!(out[1].protocol, "vless");
        assert_eq!(out.len(), 2);
        // Nothing eligible: empty.
        assert_eq!(merge_credentials(&[], &[], &json!([])).ok(), Some(None));
    }
}
