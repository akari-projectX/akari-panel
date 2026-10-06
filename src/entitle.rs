//! Entitlement (M3; W28-a: per entrance, PLAN-v0.4 D3 and section 5): which
//! (user, entrance) pairs a plan grants, and the deterministic reconcile
//! that makes `entrance_users` match it.
//!
//! Model:
//! - A user's entrances = the members (`entrance_group_members`) of the
//!   groups of their ACTIVE subscription (`user_plans.status = 'active'`;
//!   the groups are the subscription's snapshot `user_plan_groups`, taken
//!   from the plan at purchase — 运营审查中-5), on nodes not being deleted. Plans are the only source (D3: no manual
//!   assignment). Role, enabled, expiry and the entrance's own `enabled`
//!   do not matter here: what an agent actually runs is still filtered at
//!   read time (`enforce::SERVED`, enabled entrances of enabled nodes), so
//!   a user or entrance switched off and on again keeps its credentials.
//! - A granted pair has an `entrance_users` row with one account for the
//!   node's inbound (protocols::issuable: vless/vmess/trojan/multi-user
//!   SS2022/Hysteria 2). Every entrance has its own account (section 5:
//!   independent credentials per inbound). An existing account whose
//!   protocol still matches the inbound is kept (refit to it, see
//!   protocols::refit_account), so clients keep working across plan and
//!   inbound changes; otherwise a new one is generated. A node without an
//!   issuable inbound has no rows.
//! - A pair no longer granted loses its row and gets an
//!   `entrance_users_departed` row in the same statement batch, so the
//!   final counters the agent reports after the removal are still billed.
//!
//! Concurrency: every writer of node_groups, entrance_group_members, plans,
//! plan_groups, user_plans, user_plan_groups and of a node's inbound or
//! entrances — and every
//! caller of `apply_reconcile` — takes `lock()` (a transaction-scoped
//! advisory lock) FIRST, before any row lock. Entitlement changes are
//! therefore serialized, and the reconcile, reading after the lock, sees
//! every committed change (READ COMMITTED: fresh snapshot per statement).
//! Without it, "add entrance E to group G" and "give user U a plan with G"
//! could each miss the other (write skew). Row locks then follow the
//! global order: nodes (one statement, ORDER BY id) -> users ->
//! entrance_users.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

/// Protocols the panel can generate accounts for (protocols.rs).
pub const ELIGIBLE_PROTOCOLS: [&str; 5] = crate::protocols::MANAGED;

/// SQL: the nodes on which the users in `$1` (uuid[]) hold credentials.
pub const NODES_OF_USERS: &str = "SELECT e.node_id FROM entrance_users eu \
     JOIN entrances e ON e.id = eu.entrance_id WHERE eu.user_id = ANY($1)";

/// SQL: (entrance_id, user_id) pairs granted by active plans, restricted to
/// the entrances in `$1` (uuid[]) and, unless `$2` is NULL, the users in
/// `$2` (uuid[]).
const GRANTED_PAIRS: &str = "SELECT DISTINCT m.entrance_id, up.user_id FROM user_plans up \
     JOIN user_plan_groups ug ON ug.user_plan_id = up.id \
     JOIN entrance_group_members m ON m.group_id = ug.group_id \
     WHERE up.status = 'active' AND m.entrance_id = ANY($1) \
     AND ($2::uuid[] IS NULL OR up.user_id = ANY($2))";

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
    /// Every pair of these users (all entrances). Also locks every node the
    /// users hold credentials on, so a caller may update the users' rows
    /// and bump their nodes afterwards in lock order.
    Users(&'a [Uuid]),
    /// Every pair on the entrances of these nodes (all users).
    Nodes(&'a [Uuid]),
    /// Every pair on these entrances (all users).
    Entrances(&'a [Uuid]),
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
    /// Pairs whose account changed.
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

/// The wire protocol the panel issues accounts for on `inbound`, if any.
pub fn eligible_protocol(inbound: Option<&Value>) -> Option<&str> {
    let inbound = inbound?;
    let proto = inbound.get("protocol")?.as_str()?;
    (ELIGIBLE_PROTOCOLS.contains(&proto) && crate::protocols::issuable(inbound)).then_some(proto)
}

/// The account a granted pair must have on `inbound` (whose eligible
/// protocol is `proto`), given its current one: kept (refit to the inbound)
/// when the protocol still matches, else a new one. `None` = unchanged.
pub(crate) fn fit_account(
    current: Option<(&str, &Value)>,
    proto: &str,
    inbound: &Value,
) -> Result<Option<Value>, crate::auth::ApiError> {
    match current {
        Some((p, account)) if p == proto => Ok(crate::protocols::refit_account(inbound, account)),
        _ => crate::api::generate_account(inbound).map(Some),
    }
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
        Scope::Nodes(n) => Ok(n.to_vec()),
        Scope::Entrances(e) => {
            sqlx::query_scalar("SELECT DISTINCT node_id FROM entrances WHERE id = ANY($1)")
                .bind(e)
                .fetch_all(conn)
                .await
        }
        Scope::Users(u) => {
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT e.node_id FROM user_plans up \
                 JOIN user_plan_groups ug ON ug.user_plan_id = up.id \
                 JOIN entrance_group_members m ON m.group_id = ug.group_id \
                 JOIN entrances e ON e.id = m.entrance_id \
                 WHERE up.status = 'active' AND up.user_id = ANY($1) \
                 UNION {NODES_OF_USERS}"
            )))
            .bind(u)
            .fetch_all(conn)
            .await
        }
    }
}

/// Make `entrance_users` match the plan entitlement for `scope`, in the
/// caller's transaction (which must hold `lock()`): issue rows for granted
/// pairs, refit kept accounts, revoke rows no longer granted (writing
/// `entrance_users_departed`, so final counters are still billed), and bump
/// user_version on exactly the nodes whose rows changed. Idempotent: a
/// second run changes nothing.
pub async fn apply_reconcile(
    conn: &mut PgConnection,
    scope: Scope<'_>,
) -> Result<Outcome, crate::auth::ApiError> {
    let users: Option<&[Uuid]> = match scope {
        Scope::Users(u) => Some(u),
        Scope::Nodes(_) | Scope::Entrances(_) => None,
    };
    let entrances: Option<&[Uuid]> = match scope {
        Scope::Entrances(e) => Some(e),
        Scope::Nodes(_) | Scope::Users(_) => None,
    };
    if users.is_some_and(<[Uuid]>::is_empty) || entrances.is_some_and(<[Uuid]>::is_empty) {
        return Ok(Outcome::default());
    }
    let nodes = scope_nodes(conn, scope).await?;
    if nodes.is_empty() {
        return Ok(Outcome::default());
    }
    let locked = lock_nodes(conn, &nodes).await?;
    let mut total = Outcome::default();
    for node in locked {
        total.merge(reconcile_node(conn, node, users, entrances).await?);
    }
    Ok(total)
}

/// One row of `entrance_users` as the reconcile reads it.
#[derive(sqlx::FromRow)]
struct Row {
    entrance_id: Uuid,
    user_id: Uuid,
    protocol: String,
    account: Value,
}

/// One locked node: its entrances (all, or those of `only`), all users or
/// those of `users`.
async fn reconcile_node(
    conn: &mut PgConnection,
    node: Uuid,
    users: Option<&[Uuid]>,
    only: Option<&[Uuid]>,
) -> Result<Outcome, crate::auth::ApiError> {
    let (inbound, deleting): (Option<Value>, bool) =
        sqlx::query_as("SELECT inbound, deleting_at IS NOT NULL FROM nodes WHERE id = $1")
            .bind(node)
            .fetch_one(&mut *conn)
            .await?;
    if deleting {
        // Going away: its rows stay (final counters are billed) until
        // phase 2 deletes the node.
        return Ok(Outcome::default());
    }
    let entrances: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM entrances WHERE node_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2)) \
         ORDER BY id",
    )
    .bind(node)
    .bind(only)
    .fetch_all(&mut *conn)
    .await?;
    if entrances.is_empty() {
        return Ok(Outcome::default());
    }
    let proto = eligible_protocol(inbound.as_ref());
    // Granted pairs, the users row-locked FOR KEY SHARE (users after
    // nodes): a concurrent user deletion then waits for us instead of
    // failing our insert's foreign key check.
    let granted: HashSet<(Uuid, Uuid)> = match proto {
        None => HashSet::new(),
        Some(_) => {
            let pairs: Vec<(Uuid, Uuid)> = sqlx::query_as(sqlx::AssertSqlSafe(GRANTED_PAIRS))
                .bind(&entrances)
                .bind(users)
                .fetch_all(&mut *conn)
                .await?;
            let mut ids: Vec<Uuid> = pairs.iter().map(|(_, u)| *u).collect();
            ids.sort();
            ids.dedup();
            let live: HashSet<Uuid> = sqlx::query_scalar(
                "SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR KEY SHARE",
            )
            .bind(&ids)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
            pairs
                .into_iter()
                .filter(|(_, u)| live.contains(u))
                .collect()
        }
    };
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT entrance_id, user_id, protocol, account FROM entrance_users \
         WHERE entrance_id = ANY($1) AND ($2::uuid[] IS NULL OR user_id = ANY($2)) \
         ORDER BY entrance_id, user_id FOR UPDATE",
    )
    .bind(&entrances)
    .bind(users)
    .fetch_all(&mut *conn)
    .await?;

    let mut revoke: Vec<(Uuid, Uuid)> = Vec::new();
    let mut write: BTreeMap<(Uuid, Uuid), Value> = BTreeMap::new();
    let mut have: HashMap<(Uuid, Uuid), Row> = HashMap::new();
    for r in rows {
        have.insert((r.entrance_id, r.user_id), r);
    }
    let mut keys: Vec<&(Uuid, Uuid)> = have.keys().collect();
    keys.sort();
    for key in keys {
        if !granted.contains(key) {
            revoke.push(*key);
        }
    }
    let mut issued = 0;
    let mut updated = 0;
    if let (Some(proto), Some(inbound)) = (proto, inbound.as_ref()) {
        let mut want: Vec<&(Uuid, Uuid)> = granted.iter().collect();
        want.sort();
        for key in want {
            let current = have.get(key).map(|r| (r.protocol.as_str(), &r.account));
            if let Some(account) = fit_account(current, proto, inbound)? {
                if current.is_some() {
                    updated += 1;
                } else {
                    issued += 1;
                }
                write.insert(*key, account);
            }
        }
    }

    if !revoke.is_empty() {
        let (e, u): (Vec<Uuid>, Vec<Uuid>) = revoke.iter().copied().unzip();
        sqlx::query(
            "DELETE FROM entrance_users eu USING unnest($1::uuid[], $2::uuid[]) AS t(e, u) \
             WHERE eu.entrance_id = t.e AND eu.user_id = t.u",
        )
        .bind(&e)
        .bind(&u)
        .execute(&mut *conn)
        .await?;
        // The users still exist (rows are only revoked for live users;
        // deletion cascades): their final counters stay billable.
        record_departed(conn, &e, &u).await?;
    }
    if !write.is_empty() {
        let mut e = Vec::with_capacity(write.len());
        let mut u = Vec::with_capacity(write.len());
        let mut a = Vec::with_capacity(write.len());
        for ((entrance, user), account) in &write {
            e.push(*entrance);
            u.push(*user);
            a.push(account.clone());
        }
        let proto = proto.unwrap_or_default();
        sqlx::query(
            "INSERT INTO entrance_users (entrance_id, user_id, protocol, account) \
             SELECT t.e, t.u, $4, t.a FROM unnest($1::uuid[], $2::uuid[], $3::jsonb[]) AS t(e, u, a) \
             ON CONFLICT (entrance_id, user_id) DO UPDATE \
             SET protocol = EXCLUDED.protocol, account = EXCLUDED.account",
        )
        .bind(&e)
        .bind(&u)
        .bind(&a)
        .bind(proto)
        .execute(&mut *conn)
        .await?;
        // Granted again: no longer departed pairs.
        sqlx::query(
            "DELETE FROM entrance_users_departed d USING unnest($1::uuid[], $2::uuid[]) AS t(e, u) \
             WHERE d.entrance_id = t.e AND d.user_id = t.u",
        )
        .bind(&e)
        .bind(&u)
        .execute(&mut *conn)
        .await?;
    }
    let changed = !(revoke.is_empty() && write.is_empty());
    if changed {
        sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = $1")
            .bind(node)
            .execute(&mut *conn)
            .await?;
    }
    Ok(Outcome {
        bumped: if changed { vec![node] } else { Vec::new() },
        issued,
        revoked: revoke.len(),
        updated,
    })
}

/// 运营审查高-3 ("重置订阅"): give `user` a new account on every entrance
/// they hold one on (same protocol, freshly generated for the node's
/// inbound), in the caller's transaction (which holds `lock()`): the
/// user's nodes are locked (ORDER BY id), then their rows, and every node
/// whose rows changed is bumped — the agent swaps the account and closes
/// the live connections of the old one (UserOp REPLACE; a Snapshot where
/// the node needs one), so a leaked or shared client config stops working.
/// Nodes being deleted are left alone (they serve nothing).
pub async fn apply_rotate_user(
    conn: &mut PgConnection,
    user: Uuid,
) -> Result<Outcome, crate::auth::ApiError> {
    let nodes: Vec<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT id FROM nodes WHERE id IN ({NODES_OF_USERS}) AND deleting_at IS NULL \
         ORDER BY id FOR UPDATE"
    )))
    .bind([user])
    .fetch_all(&mut *conn)
    .await?;
    // Lock order: nodes → users → entrance_users (the caller then updates
    // the user row, e.g. the subscription token).
    sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE")
        .bind(user)
        .execute(&mut *conn)
        .await?;
    let rows: Vec<(Uuid, Uuid, Option<Value>, String)> = sqlx::query_as(
        "SELECT eu.entrance_id, e.node_id, n.inbound, eu.protocol FROM entrance_users eu \
         JOIN entrances e ON e.id = eu.entrance_id JOIN nodes n ON n.id = e.node_id \
         WHERE eu.user_id = $1 AND e.node_id = ANY($2) ORDER BY eu.entrance_id FOR UPDATE OF eu",
    )
    .bind(user)
    .bind(&nodes)
    .fetch_all(&mut *conn)
    .await?;
    let mut entrances = Vec::with_capacity(rows.len());
    let mut accounts = Vec::with_capacity(rows.len());
    let mut bumped = Vec::new();
    for (entrance, node, inbound, proto) in rows {
        // A row exists only for an issuable inbound of its protocol (the
        // reconcile keeps them in step); anything else is left as it is.
        let Some(inbound) = inbound.filter(|i| eligible_protocol(Some(i)) == Some(proto.as_str()))
        else {
            continue;
        };
        entrances.push(entrance);
        accounts.push(crate::api::generate_account(&inbound)?);
        bumped.push(node);
    }
    bumped.sort();
    bumped.dedup();
    if !entrances.is_empty() {
        sqlx::query(
            "UPDATE entrance_users eu SET account = t.a \
             FROM unnest($2::uuid[], $3::jsonb[]) AS t(e, a) \
             WHERE eu.user_id = $1 AND eu.entrance_id = t.e",
        )
        .bind(user)
        .bind(&entrances)
        .bind(&accounts)
        .execute(&mut *conn)
        .await?;
        sqlx::query("UPDATE nodes SET user_version = user_version + 1 WHERE id = ANY($1)")
            .bind(&bumped)
            .execute(&mut *conn)
            .await?;
    }
    Ok(Outcome {
        bumped,
        issued: 0,
        revoked: 0,
        updated: entrances.len(),
    })
}

/// The pairs (entrances `e[i]`, users `u[i]`) lost their rows while the
/// users still exist: their final counters (reported by the agent after the
/// removal) stay billable for the departed grace (traffic::FLUSH_SQL). Not
/// used for user deletion (nothing left to bill; the rows cascade away).
pub(crate) async fn record_departed(
    conn: &mut PgConnection,
    e: &[Uuid],
    u: &[Uuid],
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO entrance_users_departed (entrance_id, user_id, departed_at) \
         SELECT t.e, t.u, now() FROM unnest($1::uuid[], $2::uuid[]) AS t(e, u) \
         ON CONFLICT (entrance_id, user_id) DO UPDATE SET departed_at = now(), billed_bytes = 0",
    )
    .bind(e)
    .bind(u)
    .execute(conn)
    .await?;
    Ok(())
}

/// Nodes the users hold credentials on — for bumps after a change to what
/// they are served.
pub async fn nodes_of_users(conn: &mut PgConnection, users: &[Uuid]) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT DISTINCT node_id FROM ({NODES_OF_USERS}) n ORDER BY node_id"
    )))
    .bind(users)
    .fetch_all(conn)
    .await
}

/// Debug helper for tests: the pairs a fresh full computation grants
/// (`user -> entrances`).
#[cfg(test)]
pub async fn granted_pairs(conn: &mut PgConnection) -> HashMap<Uuid, Vec<Uuid>> {
    let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT DISTINCT up.user_id, m.entrance_id FROM user_plans up \
         JOIN user_plan_groups ug ON ug.user_plan_id = up.id \
         JOIN entrance_group_members m ON m.group_id = ug.group_id \
         JOIN entrances e ON e.id = m.entrance_id \
         JOIN nodes n ON n.id = e.node_id AND n.deleting_at IS NULL \
         WHERE up.status = 'active' ORDER BY 1, 2",
    )
    .fetch_all(conn)
    .await
    .unwrap_or_default();
    let mut out: HashMap<Uuid, Vec<Uuid>> = Default::default();
    for (u, e) in rows {
        out.entry(u).or_default().push(e);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn eligible_protocol_of_inbounds() {
        assert_eq!(
            eligible_protocol(Some(&json!({"protocol": "vless", "port": 1}))),
            Some("vless")
        );
        assert_eq!(
            eligible_protocol(Some(&json!({"protocol": "vmess", "port": 1}))),
            Some("vmess")
        );
        // Not managed / no protocol / no inbound.
        assert_eq!(
            eligible_protocol(Some(&json!({"protocol": "dokodemo-door"}))),
            None
        );
        assert_eq!(eligible_protocol(Some(&json!({"port": 1}))), None);
        assert_eq!(eligible_protocol(None), None);
        // A hand-written (single-user) shadowsocks inbound gets no users.
        assert_eq!(
            eligible_protocol(Some(&json!({"protocol": "shadowsocks", "port": 1,
                "settings": {"method": "aes-128-gcm", "password": "x"}}))),
            None
        );
    }

    #[test]
    fn fit_keeps_matching_accounts_and_replaces_the_rest() {
        let vless = json!({"protocol": "vless", "port": 1});
        let kept = json!({"id": "keep", "flow": ""});
        // Same protocol, already fitting: unchanged.
        assert_eq!(
            fit_account(Some(("vless", &kept)), "vless", &vless).ok(),
            Some(None)
        );
        // Flow follows the inbound, the id is kept.
        let vision = json!({"protocol": "vless", "port": 1,
            "settings": {"flow": "xtls-rprx-vision"}});
        let refit = fit_account(Some(("vless", &kept)), "vless", &vision)
            .ok()
            .flatten()
            .unwrap_or_default();
        assert_eq!(refit["id"], "keep");
        assert_eq!(refit["flow"], "xtls-rprx-vision");
        // Another protocol, or none yet: a new account.
        let trojan = json!({"protocol": "trojan", "port": 1});
        let new = fit_account(Some(("vless", &kept)), "trojan", &trojan)
            .ok()
            .flatten()
            .unwrap_or_default();
        assert!(new.get("password").is_some());
        assert!(
            fit_account(None, "vless", &vless)
                .ok()
                .flatten()
                .is_some_and(|a| a.get("id").is_some())
        );
    }
}
