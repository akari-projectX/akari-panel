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
//!
//! Revenue is net: channel money collected in the window (paid orders'
//! `amount_cents` by `paid_at`) minus channel money refunded in the window
//! (`refund_gateway_cents` by `refunded_at`, whichever day the order was
//! paid on). Balance, credit, coupon and gift parts are never revenue, so
//! giving back an order's balance part does not lower it; refunding the
//! channel part, to the balance or in the provider's console, does
//! (docs/PAYMENTS.md "Revenue").
//!
//! The daily series (`series`, the last `SERIES_DAYS` site days, every day
//! present, oldest first: the chart, the KPI sparklines and the comparison
//! with the previous period of the same length) uses the same definitions
//! per site day: net revenue with refunds on the refund's day, orders and
//! sign-ups like the windows, and the fleet's raw traffic (up + down) split
//! by the entrance's kind (`traffic_entrance_daily` joined to `entrances`;
//! entrances deleted since are `other_bytes`). `prev_today` is yesterday
//! up to the same time of day. Both run in the same snapshot.
//!
//! `pending_detail` describes the pending queues (the oldest firing alert,
//! the oldest paid-not-granted order, the pending withdrawals' sum, the
//! longest-waiting open ticket, the newest dead letter's error), and
//! `subscribers_7d` the active plans started in the last 7 days: the same
//! snapshot, each one partial-index lookup or one pass already made.

use axum::Json;
use axum::extract::State;
use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use uuid::Uuid;

use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

/// Revenue and order count of one window (see the module docs).
#[derive(Serialize, Debug, Default, PartialEq, sqlx::FromRow)]
pub struct Window {
    /// Net: `gross_cents` − `refunds_cents` (negative on a day with more
    /// refunded than collected).
    pub revenue_cents: i64,
    /// Channel money collected: paid orders' `amount_cents` by `paid_at`.
    pub gross_cents: i64,
    /// Ops: the part of `gross_cents` recorded by admins (paid_via
    /// 'manual': offline sales and confirmed payments).
    pub manual_cents: i64,
    /// Ops: list price forgiven by admin gift orders (not revenue).
    pub gift_cents: i64,
    pub orders: i64,
    /// Channel money refunded in the window (`refund_gateway_cents` by
    /// `refunded_at`): to the balance or in the provider's console.
    pub refunds_cents: i64,
    pub signups: i64,
}

/// One site day of the series (see the module docs).
#[derive(Serialize, Debug, Default, PartialEq, sqlx::FromRow)]
pub struct Day {
    pub day: NaiveDate,
    /// Net: `gross_cents` − `refunds_cents` of that day.
    pub revenue_cents: i64,
    pub gross_cents: i64,
    pub refunds_cents: i64,
    pub orders: i64,
    pub signups: i64,
    /// Raw bytes (up + down) through direct entrances.
    pub direct_bytes: i64,
    /// Raw bytes (up + down) through relay entrances.
    pub relay_bytes: i64,
    /// Raw bytes of entrances deleted since (kind unknown).
    pub other_bytes: i64,
}

/// Yesterday from its start up to the same time of day as now.
#[derive(Serialize, Debug, Default, PartialEq, sqlx::FromRow)]
pub struct PrevToday {
    pub revenue_cents: i64,
    pub gross_cents: i64,
    pub refunds_cents: i64,
    pub orders: i64,
    pub signups: i64,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Servers {
    pub total: i64,
    pub online: i64,
    /// With an enabled node, enrolled, not deleting and not online.
    pub offline: i64,
    /// No enabled node.
    pub disabled: i64,
    /// Never enrolled yet.
    pub pending: i64,
    /// Servers with at least one firing alert.
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

/// Details of the pending queues for the dashboard's "需要你处理" rows (same
/// snapshot as `pending`; every part is one index-bounded lookup).
#[derive(Serialize, Debug, Default, PartialEq, sqlx::FromRow)]
pub struct PendingDetail {
    /// The firing alert that started first: when, its kind, its server.
    pub alert_oldest_at: Option<DateTime<Utc>>,
    pub alert_oldest_kind: Option<String>,
    pub alert_oldest_server: Option<String>,
    /// Firing alerts nobody acknowledged yet.
    pub alerts_unacked: i64,
    /// The oldest paid order that could not be granted (same filter as
    /// `orders_unfulfilled`): its id, number and fulfil error.
    pub order_sample_id: Option<Uuid>,
    pub order_sample_no: Option<String>,
    pub order_sample_error: Option<String>,
    /// Sum of the pending withdrawals.
    pub withdrawals_cents: i64,
    /// The open ticket waiting longest: since the user's last message (or
    /// its creation).
    pub ticket_oldest_at: Option<DateTime<Utc>>,
    /// The newest dead letter's last error (the server's raw answer).
    pub mail_last_error: Option<String>,
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
    /// What the order does: new / renew / switch / reset.
    pub action: String,
    /// For the order's state chip (未开通 / 已退款 / 部分退款).
    pub fulfilled_at: Option<DateTime<Utc>>,
    pub refunded_at: Option<DateTime<Utc>>,
    pub refund_cents: Option<i64>,
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
    /// Active plans that started in the last 7 site days (part of
    /// `subscribers`).
    pub subscribers_7d: i64,
    /// Sum of the online users the servers report (a user on two servers
    /// counts twice; only servers online now).
    pub online_users: i64,
    /// Q1: machines (agents), not nodes.
    pub servers: Servers,
    pub pending: Pending,
    pub pending_detail: PendingDetail,
    pub latest_orders: Vec<LatestOrder>,
    /// W22 traffic history: the fleet per site day over the last
    /// `TRAFFIC_DAYS` days (days without traffic omitted) and the top nodes
    /// over the same range.
    pub traffic_days: Vec<crate::trafficlog::NodeDayRow>,
    pub traffic_top_nodes: Vec<crate::trafficlog::NodeRow>,
    /// The last `SERIES_DAYS` site days, today last (see the module docs).
    pub series: Vec<Day>,
    pub prev_today: PrevToday,
}

/// Days in `series`: 30 for the chart and the 30-day window, and the 30
/// before them for "compared with the previous period".
pub const SERIES_DAYS: i64 = 60;

/// The daily series: $1 = first day, $2 = last day (today), $3 = the site
/// time zone. Each day is its local-midnight range (right across a DST
/// change), summed with one index range scan per source and day
/// (orders_paid_at / orders_refunded_at index-only, users_created_at), so
/// no per-row time zone conversion; traffic is already per site day
/// (traffic_entrance_daily_day).
const SERIES_SQL: &str = "WITH days AS (SELECT g::date AS day, \
       g::date::timestamp AT TIME ZONE $3 AS s, (g::date + 1)::timestamp AT TIME ZONE $3 AS e \
       FROM generate_series($1::date, $2::date, interval '1 day') g), \
     traffic AS (SELECT t.day, \
       coalesce(sum(t.up_bytes) FILTER (WHERE e.kind = 'direct'), 0) \
         + coalesce(sum(t.down_bytes) FILTER (WHERE e.kind = 'direct'), 0) AS direct, \
       coalesce(sum(t.up_bytes) FILTER (WHERE e.kind = 'relay'), 0) \
         + coalesce(sum(t.down_bytes) FILTER (WHERE e.kind = 'relay'), 0) AS relay, \
       coalesce(sum(t.up_bytes) FILTER (WHERE e.id IS NULL), 0) \
         + coalesce(sum(t.down_bytes) FILTER (WHERE e.id IS NULL), 0) AS other \
       FROM traffic_entrance_daily t LEFT JOIN entrances e ON e.id = t.entrance_id \
       WHERE t.day BETWEEN $1 AND $2 GROUP BY t.day) \
     SELECT d.day, p.gross - r.refunds AS revenue_cents, p.gross AS gross_cents, \
       r.refunds AS refunds_cents, p.orders, s.signups, \
       LEAST(coalesce(t.direct, 0), 9223372036854775807)::bigint AS direct_bytes, \
       LEAST(coalesce(t.relay, 0), 9223372036854775807)::bigint AS relay_bytes, \
       LEAST(coalesce(t.other, 0), 9223372036854775807)::bigint AS other_bytes \
     FROM days d \
     CROSS JOIN LATERAL (SELECT coalesce(sum(amount_cents), 0)::bigint AS gross, count(*) AS orders \
       FROM orders WHERE status = 'paid' AND paid_at >= d.s AND paid_at < d.e) p \
     CROSS JOIN LATERAL (SELECT coalesce(sum(refund_gateway_cents), 0)::bigint AS refunds \
       FROM orders WHERE refunded_at >= d.s AND refunded_at < d.e) r \
     CROSS JOIN LATERAL (SELECT count(*) AS signups FROM users \
       WHERE role = 'user' AND created_at >= d.s AND created_at < d.e) s \
     LEFT JOIN traffic t ON t.day = d.day ORDER BY d.day";

/// Yesterday up to now's time of day: $1 = today (site day), $2 = the site
/// time zone, $3 = now (the snapshot's `at`).
const PREV_TODAY_SQL: &str = "SELECT \
     p.gross - r.refunds AS revenue_cents, p.gross AS gross_cents, r.refunds AS refunds_cents, \
     p.orders, s.signups \
     FROM (SELECT coalesce(sum(amount_cents), 0)::bigint AS gross, count(*) AS orders \
           FROM orders WHERE status = 'paid' AND paid_at >= ($1::date - 1)::timestamp AT TIME ZONE $2 \
           AND paid_at < $3::timestamptz - interval '1 day') p, \
          (SELECT coalesce(sum(refund_gateway_cents), 0)::bigint AS refunds \
           FROM orders WHERE refunded_at >= ($1::date - 1)::timestamp AT TIME ZONE $2 \
           AND refunded_at < $3::timestamptz - interval '1 day') r, \
          (SELECT count(*) AS signups FROM users \
           WHERE role = 'user' AND created_at >= ($1::date - 1)::timestamp AT TIME ZONE $2 \
           AND created_at < $3::timestamptz - interval '1 day') s";

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
     coalesce(sum(refund_gateway_cents) FILTER (WHERE refunded_at >= $1), 0)::bigint, \
     coalesce(sum(refund_gateway_cents) FILTER (WHERE refunded_at >= $2), 0)::bigint, \
     coalesce(sum(refund_gateway_cents), 0)::bigint \
     FROM orders WHERE refunded_at >= $3";

/// Sign-ups per window and the user total in ONE pass over users (two
/// separate scans were the dashboard's largest cost at 50k users).
const USERS_SQL: &str = "SELECT count(*) FILTER (WHERE created_at >= $1), \
     count(*) FILTER (WHERE created_at >= $2), count(*) FILTER (WHERE created_at >= $3), \
     count(*) FROM users WHERE role = 'user'";

/// Active plans, and those created since $1 (the 7-day start), in one pass.
const SUBSCRIBERS_SQL: &str = "SELECT count(*), count(*) FILTER (WHERE created_at >= $1) \
     FROM user_plans WHERE status = 'active'";

const PENDING_SQL: &str = "SELECT \
     (SELECT count(*) FROM tickets WHERE status = 'open') AS tickets_open, \
     (SELECT count(*) FROM withdrawals WHERE status = 'pending') AS withdrawals, \
     (SELECT count(*) FROM mail_outbox WHERE status = 'dead') AS mail_failed, \
     (SELECT count(*) FROM orders WHERE status = 'paid' AND fulfilled_at IS NULL \
        AND fulfil_error IS NOT NULL AND refunded_at IS NULL) AS orders_unfulfilled, \
     (SELECT count(*) FROM server_alerts WHERE status = 'firing') AS alerts_firing";

const PENDING_DETAIL_SQL: &str = "SELECT a.fired_at AS alert_oldest_at, \
     a.kind AS alert_oldest_kind, a.name AS alert_oldest_server, \
     (SELECT count(*) FROM server_alerts WHERE status = 'firing' AND acked_at IS NULL) \
       AS alerts_unacked, \
     o.id AS order_sample_id, o.out_trade_no AS order_sample_no, \
     o.fulfil_error AS order_sample_error, \
     (SELECT coalesce(sum(amount_cents), 0)::bigint FROM withdrawals WHERE status = 'pending') \
       AS withdrawals_cents, \
     (SELECT min(coalesce(last_user_at, created_at)) FROM tickets WHERE status = 'open') \
       AS ticket_oldest_at, \
     (SELECT last_error FROM mail_outbox WHERE status = 'dead' \
       ORDER BY settled_at DESC NULLS LAST LIMIT 1) AS mail_last_error \
     FROM (SELECT 1) one \
     LEFT JOIN LATERAL (SELECT al.fired_at, al.kind, s.name FROM server_alerts al \
       JOIN servers s ON s.id = al.server_id WHERE al.status = 'firing' \
       ORDER BY al.fired_at, al.id LIMIT 1) a ON true \
     LEFT JOIN LATERAL (SELECT id, out_trade_no, fulfil_error FROM orders \
       WHERE status = 'paid' AND fulfilled_at IS NULL AND fulfil_error IS NOT NULL \
       AND refunded_at IS NULL ORDER BY paid_at, id LIMIT 1) o ON true";

/// How many latest orders the dashboard lists.
pub const LATEST_ORDERS: i64 = 8;

#[derive(sqlx::FromRow)]
struct ServerRow {
    id: Uuid,
    enabled: bool,
    enrolled: bool,
    deleting: bool,
    online: bool,
    alerting: bool,
}

/// The figures (without the Valkey part: `online_users` = 0, and the ids
/// of the online servers to look up).
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
    let (subscribers, subscribers_7d): (i64, i64) = sqlx::query_as(SUBSCRIBERS_SQL)
        .bind(d7)
        .fetch_one(&mut *tx)
        .await?;
    let pending: Pending = sqlx::query_as(PENDING_SQL).fetch_one(&mut *tx).await?;
    let pending_detail: PendingDetail = sqlx::query_as(PENDING_DETAIL_SQL)
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<ServerRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT s.id, EXISTS (SELECT 1 FROM nodes n WHERE n.server_id = s.id AND n.enabled) \
         AS enabled, s.cert_serial IS NOT NULL AS enrolled, \
         s.deleting_at IS NOT NULL AS deleting, {} AS online, \
         EXISTS (SELECT 1 FROM server_alerts a WHERE a.server_id = s.id AND a.status = 'firing') \
         AS alerting FROM servers s",
        crate::nodestat::online_sql("s")
    )))
    .fetch_all(&mut *tx)
    .await?;
    let series: Vec<Day> = sqlx::query_as(SERIES_SQL)
        .bind(today_date - chrono::Duration::days(SERIES_DAYS - 1))
        .bind(today_date)
        .bind(&timezone)
        .fetch_all(&mut *tx)
        .await?;
    let prev_today: PrevToday = sqlx::query_as(PREV_TODAY_SQL)
        .bind(today_date)
        .bind(&timezone)
        .bind(at)
        .fetch_one(&mut *tx)
        .await?;
    let latest: Vec<LatestOrder> = sqlx::query_as(
        "SELECT id, out_trade_no, user_label, \
         (SELECT u.email FROM users u WHERE u.id = orders.user_id) AS user_email, \
         plan_name, amount_cents, status, paid_via, \
         created_at, paid_at, action, fulfilled_at, refunded_at, refund_cents \
         FROM orders ORDER BY created_at DESC, id DESC LIMIT $1",
    )
    .bind(LATEST_ORDERS)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    let mut servers = Servers::default();
    let mut online = Vec::new();
    for s in rows.iter().filter(|s| !s.deleting) {
        servers.total += 1;
        if s.alerting {
            servers.alerting += 1;
        }
        if s.online {
            online.push(s.id);
        }
        if !s.enabled {
            servers.disabled += 1;
        } else if s.online {
            servers.online += 1;
        } else if !s.enrolled {
            servers.pending += 1;
        } else {
            servers.offline += 1;
        }
    }
    let window =
        |(gross_cents, manual_cents, gift_cents), orders, refunds_cents: i64, signups| Window {
            revenue_cents: gross_cents - refunds_cents,
            gross_cents,
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
            subscribers_7d,
            online_users: 0,
            servers,
            pending,
            pending_detail,
            latest_orders: latest,
            traffic_days: Vec::new(),
            traffic_top_nodes: Vec::new(),
            series,
            prev_today,
        },
        online,
    ))
}

/// Online users summed over the heartbeats of `servers` (best effort: a
/// Valkey failure counts 0 and is logged).
pub async fn online_users(state: &AppState, servers: &[Uuid]) -> i64 {
    use fred::prelude::KeysInterface;
    if servers.is_empty() {
        return 0;
    }
    let keys: Vec<String> = servers
        .iter()
        .map(|id| format!("akari:server:hb:{id}"))
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
