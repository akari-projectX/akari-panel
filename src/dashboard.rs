//! W21: the admin dashboard (仪表盘) — one aggregate read for the console's
//! landing view: revenue, sign-ups, subscribers, online users, node health,
//! pending work and the latest orders.
//!
//! Every figure is a bounded query: the revenue windows are index-only
//! scans (`orders_paid_at` / `orders_refunded_at` INCLUDE the amounts,
//! migration 0125), users are counted in one pass (sign-up windows and the
//! total together), the pending counts use the partial indexes of their
//! queues, and the node part reads the (small) node table once plus one
//! Valkey MGET of the online nodes' heartbeats. All SQL runs in one
//! read-only REPEATABLE READ snapshot, so the figures agree with each other.
//! Benchmarked at bench scale (50k users, 200 nodes) in docs/PERF.md
//! ("W21 dashboard").
//!
//! Days are site days (Q3: 系统设置 → 站点 → 时区, default Asia/Shanghai):
//! "today" starts at 00:00 in the site time zone; "7d"/"30d" are the last 7/30
//! calendar days including today. Money is integer fen.

use axum::Json;
use axum::extract::State;
use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use uuid::Uuid;

use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

/// Revenue and order count of one window (paid orders by `paid_at`;
/// `revenue_cents` = what was collected through the gateway, i.e. the
/// orders' `amount_cents`; balance/credit/coupon parts are not revenue).
#[derive(Serialize, Debug, Default, PartialEq, sqlx::FromRow)]
pub struct Window {
    pub revenue_cents: i64,
    /// Ops: the part of `revenue_cents` recorded by admins (paid_via
    /// 'manual': offline sales and confirmed payments).
    pub manual_cents: i64,
    /// Ops: list price forgiven by admin gift orders (not revenue).
    pub gift_cents: i64,
    pub orders: i64,
    pub refunds_cents: i64,
    pub signups: i64,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Nodes {
    pub total: i64,
    pub online: i64,
    /// Enabled, enrolled, not deleting and not online.
    pub offline: i64,
    pub disabled: i64,
    /// Never enrolled yet.
    pub pending: i64,
    /// Nodes with at least one firing alert.
    pub alerting: i64,
}

#[derive(Serialize, Debug, Default, PartialEq, sqlx::FromRow)]
pub struct Pending {
    /// Tickets waiting for staff (status open).
    pub tickets_open: i64,
    pub withdrawals: i64,
    /// Dead letters (failed mail).
    pub mail_failed: i64,
    /// Paid orders whose plan could not be granted (fulfil_error) and
    /// that were not refunded (中-2 refunds most of them automatically).
    pub orders_unfulfilled: i64,
    pub alerts_firing: i64,
}

#[derive(Serialize, Debug, sqlx::FromRow)]
pub struct LatestOrder {
    pub id: Uuid,
    pub out_trade_no: String,
    /// Q4: snapshot label; `user_email` = the buyer's current address.
    pub user_label: String,
    pub user_email: Option<String>,
    pub plan_name: String,
    pub amount_cents: i64,
    pub status: String,
    /// Ops: how it was paid (`manual` flagged in the console).
    pub paid_via: Option<String>,
    pub created_at: DateTime<Utc>,
    pub paid_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, Debug)]
pub struct Dashboard {
    /// When the figures were read (DB clock).
    pub at: DateTime<Utc>,
    /// Q3: the site time zone (IANA) and today there: the day windows and
    /// the traffic days are in it.
    pub timezone: String,
    pub today_date: NaiveDate,
    /// Start of today in the site time zone.
    pub today_start: DateTime<Utc>,
    pub today: Window,
    pub d7: Window,
    pub d30: Window,
    pub users_total: i64,
    /// Users with an active plan.
    pub subscribers: i64,
    /// Sum of the online users the nodes report (a user on two nodes
    /// counts twice; only nodes online now).
    pub online_users: i64,
    pub nodes: Nodes,
    pub pending: Pending,
    pub latest_orders: Vec<LatestOrder>,
    /// W22 traffic history: the fleet per site day over the last
    /// `TRAFFIC_DAYS` days (days without traffic omitted) and the top nodes
    /// over the same range.
    pub traffic_days: Vec<crate::trafficlog::NodeDayRow>,
    pub traffic_top_nodes: Vec<crate::trafficlog::NodeRow>,
}

/// Days of fleet traffic on the dashboard (W22's per-node-day rollup: one
/// row per node per day, so 14 days × 200 nodes = 2.8k rows).
pub const TRAFFIC_DAYS: i64 = 14;
/// Top nodes listed.
pub const TRAFFIC_TOP_NODES: i64 = 5;

/// Window bounds: the site time zone, today there, today's start and the
/// 7/30-day starts (local midnights: right across a DST change too).
const BOUNDS_SQL: &str = "WITH b AS (SELECT now() AS at, akari_site_tz() AS tz, \
     akari_site_day(now()) AS day) \
     SELECT at, tz, day, day::timestamp AT TIME ZONE tz AS d1, \
     (day - 6)::timestamp AT TIME ZONE tz AS d7, (day - 29)::timestamp AT TIME ZONE tz AS d30 \
     FROM b";

const WINDOWS_SQL: &str = "SELECT \
     coalesce(sum(o.amount_cents) FILTER (WHERE o.paid_at >= $1), 0)::bigint, \
     count(*) FILTER (WHERE o.paid_at >= $1), \
     coalesce(sum(o.amount_cents) FILTER (WHERE o.paid_at >= $2), 0)::bigint, \
     count(*) FILTER (WHERE o.paid_at >= $2), \
     coalesce(sum(o.amount_cents), 0)::bigint, count(*) \
     FROM orders o WHERE o.status = 'paid' AND o.paid_at >= $3";

/// Ops: admin-recorded revenue and gifts per window (orders_paid_via_paid_at).
const MANUAL_SQL: &str = "SELECT \
     coalesce(sum(amount_cents) FILTER (WHERE paid_at >= $1), 0)::bigint, \
     coalesce(sum(gift_cents) FILTER (WHERE paid_at >= $1), 0)::bigint, \
     coalesce(sum(amount_cents) FILTER (WHERE paid_at >= $2), 0)::bigint, \
     coalesce(sum(gift_cents) FILTER (WHERE paid_at >= $2), 0)::bigint, \
     coalesce(sum(amount_cents), 0)::bigint, coalesce(sum(gift_cents), 0)::bigint \
     FROM orders WHERE status = 'paid' AND paid_via = 'manual' AND paid_at >= $3";

const REFUNDS_SQL: &str = "SELECT \
     coalesce(sum(refund_cents) FILTER (WHERE refunded_at >= $1), 0)::bigint, \
     coalesce(sum(refund_cents) FILTER (WHERE refunded_at >= $2), 0)::bigint, \
     coalesce(sum(refund_cents), 0)::bigint \
     FROM orders WHERE refunded_at >= $3";

/// Sign-ups per window and the user total in ONE pass over users (two
/// separate scans were the dashboard's largest cost at 50k users).
const USERS_SQL: &str = "SELECT count(*) FILTER (WHERE created_at >= $1), \
     count(*) FILTER (WHERE created_at >= $2), count(*) FILTER (WHERE created_at >= $3), \
     count(*) FROM users WHERE role = 'user'";

const SUBSCRIBERS_SQL: &str = "SELECT count(*) FROM user_plans WHERE status = 'active'";

const PENDING_SQL: &str = "SELECT \
     (SELECT count(*) FROM tickets WHERE status = 'open') AS tickets_open, \
     (SELECT count(*) FROM withdrawals WHERE status = 'pending') AS withdrawals, \
     (SELECT count(*) FROM mail_outbox WHERE status = 'dead') AS mail_failed, \
     (SELECT count(*) FROM orders WHERE status = 'paid' AND fulfilled_at IS NULL \
        AND fulfil_error IS NOT NULL AND refunded_at IS NULL) AS orders_unfulfilled, \
     (SELECT count(*) FROM node_alerts WHERE status = 'firing') AS alerts_firing";

/// How many latest orders the dashboard lists.
pub const LATEST_ORDERS: i64 = 8;

#[derive(sqlx::FromRow)]
struct NodeRow {
    id: Uuid,
    enabled: bool,
    enrolled: bool,
    deleting: bool,
    online: bool,
    alerting: bool,
}

/// The figures (without the Valkey part: `online_users` = 0, and the ids
/// of the online nodes to look up).
pub async fn read(pool: &sqlx::PgPool) -> Result<(Dashboard, Vec<Uuid>), ApiError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    type Bounds = (
        DateTime<Utc>,
        String,
        NaiveDate,
        DateTime<Utc>,
        DateTime<Utc>,
        DateTime<Utc>,
    );
    let (at, timezone, today_date, d1, d7, d30): Bounds =
        sqlx::query_as(BOUNDS_SQL).fetch_one(&mut *tx).await?;
    let (r1, n1, r7, n7, r30, n30): (i64, i64, i64, i64, i64, i64) = sqlx::query_as(WINDOWS_SQL)
        .bind(d1)
        .bind(d7)
        .bind(d30)
        .fetch_one(&mut *tx)
        .await?;
    type Manual = (i64, i64, i64, i64, i64, i64);
    let (m1, g1, m7, g7, m30, g30): Manual = sqlx::query_as(MANUAL_SQL)
        .bind(d1)
        .bind(d7)
        .bind(d30)
        .fetch_one(&mut *tx)
        .await?;
    let (f1, f7, f30): (i64, i64, i64) = sqlx::query_as(REFUNDS_SQL)
        .bind(d1)
        .bind(d7)
        .bind(d30)
        .fetch_one(&mut *tx)
        .await?;
    let (s1, s7, s30, users_total): (i64, i64, i64, i64) = sqlx::query_as(USERS_SQL)
        .bind(d1)
        .bind(d7)
        .bind(d30)
        .fetch_one(&mut *tx)
        .await?;
    let subscribers: i64 = sqlx::query_scalar(SUBSCRIBERS_SQL)
        .fetch_one(&mut *tx)
        .await?;
    let pending: Pending = sqlx::query_as(PENDING_SQL).fetch_one(&mut *tx).await?;
    let rows: Vec<NodeRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT n.id, n.enabled, n.cert_serial IS NOT NULL AS enrolled, \
         n.deleting_at IS NOT NULL AS deleting, {} AS online, \
         EXISTS (SELECT 1 FROM node_alerts a WHERE a.node_id = n.id AND a.status = 'firing') \
         AS alerting FROM nodes n",
        crate::nodestat::online_sql("n")
    )))
    .fetch_all(&mut *tx)
    .await?;
    let latest: Vec<LatestOrder> = sqlx::query_as(
        "SELECT id, out_trade_no, user_label, \
         (SELECT u.email FROM users u WHERE u.id = orders.user_id) AS user_email, \
         plan_name, amount_cents, status, paid_via, \
         created_at, paid_at FROM orders ORDER BY created_at DESC, id DESC LIMIT $1",
    )
    .bind(LATEST_ORDERS)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    let mut nodes = Nodes::default();
    let mut online = Vec::new();
    for n in rows.iter().filter(|n| !n.deleting) {
        nodes.total += 1;
        if n.alerting {
            nodes.alerting += 1;
        }
        if !n.enabled {
            nodes.disabled += 1;
        } else if n.online {
            nodes.online += 1;
            online.push(n.id);
        } else if !n.enrolled {
            nodes.pending += 1;
        } else {
            nodes.offline += 1;
        }
    }
    let window =
        |(revenue_cents, manual_cents, gift_cents), orders, refunds_cents, signups| Window {
            revenue_cents,
            manual_cents,
            gift_cents,
            orders,
            refunds_cents,
            signups,
        };
    Ok((
        Dashboard {
            at,
            timezone,
            today_date,
            today_start: d1,
            today: window((r1, m1, g1), n1, f1, s1),
            d7: window((r7, m7, g7), n7, f7, s7),
            d30: window((r30, m30, g30), n30, f30, s30),
            users_total,
            subscribers,
            online_users: 0,
            nodes,
            pending,
            latest_orders: latest,
            traffic_days: Vec::new(),
            traffic_top_nodes: Vec::new(),
        },
        online,
    ))
}

/// Online users summed over the heartbeats of `nodes` (best effort: a
/// Valkey failure counts 0 and is logged).
pub async fn online_users(state: &AppState, nodes: &[Uuid]) -> i64 {
    use fred::prelude::KeysInterface;
    if nodes.is_empty() {
        return 0;
    }
    let keys: Vec<String> = nodes
        .iter()
        .map(|id| format!("akari:node:hb:{id}"))
        .collect();
    match state.valkey().mget::<Vec<Option<String>>, _>(keys).await {
        Ok(blobs) => blobs.iter().flatten().map(|b| blob_users(b)).sum(),
        Err(e) => {
            tracing::warn!(error = %e, "dashboard heartbeat lookup failed");
            0
        }
    }
}

/// `metrics.online_users` of one heartbeat blob (0 when absent/garbled;
/// clamped, the agent's input is untrusted).
fn blob_users(blob: &str) -> i64 {
    serde_json::from_str::<serde_json::Value>(blob)
        .ok()
        .and_then(|v| v.pointer("/metrics/online_users").and_then(|u| u.as_i64()))
        .unwrap_or(0)
        .clamp(0, 1_000_000)
}

/// GET /api/v1/dashboard (admin).
pub async fn get_dashboard(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Dashboard>, ApiError> {
    user.require_admin()?;
    let (mut d, online) = read(state.pg()).await?;
    d.online_users = online_users(&state, &online).await;
    let to = d.today_date;
    let from = to - chrono::Duration::days(TRAFFIC_DAYS - 1);
    d.traffic_days = crate::trafficlog::fleet_days(state.pg(), from, to).await?;
    d.traffic_top_nodes =
        crate::trafficlog::fleet_top_nodes(state.pg(), from, to, TRAFFIC_TOP_NODES).await?;
    Ok(Json(d))
}

#[cfg(test)]
mod tests;
