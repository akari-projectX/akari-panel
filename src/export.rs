//! Ops: CSV exports for the admin console (`csvx` does the encoding).
//!
//! - `GET /users/export.csv?<users-list filters>` — the users matching the
//!   current filter (same parameters and order as `GET /users`);
//! - `GET /orders/export.csv?from&to&status&via` — orders created in a
//!   date range of the site time zone (Q3; ≤366 days);
//! - `GET /traffic/export.csv?from&to&group=day|node` — the W22 fleet
//!   history per day, or per node over the range.
//!
//! Admin only. Every export writes one audit row (`export.<what>` with the
//! filters) BEFORE the first byte; the body is streamed (a page of rows per
//! chunk from one REPEATABLE READ snapshot, so a 50k-user export never
//! holds its rows in memory), UTF-8 BOM first, formula-safe text cells,
//! `Content-Disposition: attachment`, `Cache-Control: no-store`. Row
//! counts are bounded by the pages, not by the result size.

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::{self, UserListQuery};
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request};
use crate::csvx::{self, Cell};
use crate::state::AppState;
use crate::trafficlog;

/// Rows fetched (and flushed) per chunk.
const PAGE: i64 = 1000;
/// Longest date range (inclusive days).
pub const MAX_RANGE_DAYS: i64 = 366;
const DEFAULT_RANGE_DAYS: i64 = 30;

/// A CSV download response whose body is produced by `producer` on its own
/// task: rows are sent as they are read.
fn download(
    filename: String,
    producer: impl Future<Output = anyhow::Result<()>> + Send + 'static,
    tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
    rx: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>,
) -> Response {
    tokio::spawn(async move {
        if let Err(e) = producer.await {
            tracing::warn!(error = %e, "csv export aborted");
            // The client sees a truncated body (an error mid-stream cannot
            // become a status code any more).
            let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
        }
    });
    let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));
    let mut resp = Response::new(body);
    *resp.status_mut() = StatusCode::OK;
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    resp
}

/// A complete (small, already built) CSV as a download, same headers as
/// the streamed exports.
pub(crate) fn csv_response(filename: String, bytes: Vec<u8>) -> Response {
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let producer = {
        let tx = tx.clone();
        async move {
            tx.send(Ok(Bytes::from(bytes)))
                .await
                .map_err(|_| anyhow::anyhow!("client went away"))
        }
    };
    download(filename, producer, tx, rx)
}

/// Writes rows into chunks and ships them down the channel.
struct Sink {
    tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
    buf: Vec<u8>,
    pub rows: u64,
}

impl Sink {
    fn new(tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>, names: &[&str]) -> Self {
        let mut buf = Vec::with_capacity(64 * 1024);
        buf.extend_from_slice(csvx::BOM);
        csvx::header(&mut buf, names);
        Self { tx, buf, rows: 0 }
    }
    fn row(&mut self, cells: &[Cell]) {
        csvx::write_row(&mut self.buf, cells);
        self.rows += 1;
    }
    /// Send what is buffered (the client may have gone: that ends the job).
    async fn flush(&mut self) -> anyhow::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::take(&mut self.buf));
        self.tx
            .send(Ok(chunk))
            .await
            .map_err(|_| anyhow::anyhow!("client went away"))
    }
}

fn date(d: Option<DateTime<Utc>>) -> Cell {
    Cell::opt_raw(d.map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)))
}

/// Audit row for an export (before streaming; the filter, never the rows).
pub(crate) async fn audit(
    conn: &mut PgConnection,
    actor: &Actor,
    what: &str,
    filter: Value,
) -> sqlx::Result<()> {
    crate::audit::record(
        conn,
        actor,
        &format!("export.{what}"),
        "export",
        None,
        None,
        Some(filter),
    )
    .await
}

/// The download's name, dated with today in the site time zone (Q3).
pub(crate) fn filename(what: &str, today: NaiveDate) -> String {
    format!("akari-{what}-{}.csv", today.format("%Y%m%d"))
}

/// A date range (days of the site time zone, Q3) from optional bounds
/// (defaults: the last 30 days up to `today`).
pub fn date_range(
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    today: NaiveDate,
) -> Result<(NaiveDate, NaiveDate), ApiError> {
    let to = to.unwrap_or(today);
    let from = from.unwrap_or(to - Duration::days(DEFAULT_RANGE_DAYS - 1));
    if from > to {
        return Err(bad_request!(
            "export.range_invalid",
            "from must not be after to"
        ));
    }
    if (to - from).num_days() + 1 > MAX_RANGE_DAYS {
        return Err(bad_request!(
            "export.range_too_long",
            "range longer than {max_range_days} days",
            max_range_days = MAX_RANGE_DAYS
        ));
    }
    Ok((from, to))
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const USER_COLS: &[&str] = &[
    "id",
    "email",
    "email_verified",
    "role",
    "status",
    "enabled",
    "disabled_reason",
    "plan",
    "plan_expires_at",
    "traffic_used_bytes",
    "traffic_limit_bytes",
    "next_reset_at",
    "expires_at",
    "balance_cents",
    "created_at",
];

#[derive(sqlx::FromRow)]
struct UserRow {
    id: Uuid,
    email: String,
    email_verified: bool,
    role: String,
    status: String,
    enabled: bool,
    disabled_reason: Option<String>,
    plan_name: Option<String>,
    plan_expires_at: Option<DateTime<Utc>>,
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    next_reset_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
    balance_cents: i64,
    created_at: DateTime<Utc>,
}

/// Columns over alias `u`; `status` is the console's derived badge.
fn user_select() -> String {
    format!(
        "SELECT u.id, u.email, u.email_verified_at IS NOT NULL AS email_verified, u.role, \
         CASE WHEN {} THEN 'banned' WHEN {} THEN 'quota' WHEN {} THEN 'expired' ELSE 'active' END \
         AS status, u.enabled, u.disabled_reason, \
         (SELECT p.name FROM user_plans up JOIN plans p ON p.id = up.plan_id \
          WHERE up.user_id = u.id AND up.status = 'active') AS plan_name, \
         (SELECT up.expires_at FROM user_plans up WHERE up.user_id = u.id AND up.status = 'active') \
          AS plan_expires_at, \
         u.traffic_used_bytes, u.traffic_limit_bytes, \
         (SELECT up.next_reset_at FROM user_plans up WHERE up.user_id = u.id AND up.status = 'active') \
          AS next_reset_at, \
         u.expires_at, \
         COALESCE((SELECT b.balance_cents FROM user_balances b WHERE b.user_id = u.id), 0) \
          AS balance_cents, u.created_at FROM users u",
        api::STATUS_BANNED,
        api::STATUS_QUOTA,
        api::STATUS_EXPIRED
    )
}

fn user_cells(r: &UserRow) -> Vec<Cell> {
    vec![
        Cell::raw(r.id),
        Cell::text(&r.email),
        Cell::bool(r.email_verified),
        Cell::raw(&r.role),
        Cell::raw(&r.status),
        Cell::bool(r.enabled),
        Cell::opt_raw(r.disabled_reason.as_deref()),
        Cell::opt_text(r.plan_name.as_deref()),
        date(r.plan_expires_at),
        Cell::raw(r.traffic_used_bytes),
        Cell::opt_raw(r.traffic_limit_bytes),
        date(r.next_reset_at),
        date(r.expires_at),
        Cell::raw(r.balance_cents),
        date(Some(r.created_at)),
    ]
}

/// Stream every user matching `q` (the list's filters and order).
async fn produce_users(state: AppState, q: UserListQuery, mut sink: Sink) -> anyhow::Result<()> {
    let order =
        api::user_order(q.sort.as_deref()).map_err(|e| anyhow::anyhow!(e.message().to_string()))?;
    let mut tx = state.pg().begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let mut offset: i64 = 0;
    loop {
        let mut qb = sqlx::QueryBuilder::new(user_select());
        api::push_user_filters(&mut qb, &q)
            .map_err(|e| anyhow::anyhow!(e.message().to_string()))?;
        qb.push(format!(" ORDER BY {order} LIMIT "))
            .push_bind(PAGE)
            .push(" OFFSET ")
            .push_bind(offset);
        let rows: Vec<UserRow> = qb.build_query_as().fetch_all(&mut *tx).await?;
        for r in &rows {
            sink.row(&user_cells(r));
        }
        sink.flush().await?;
        if (rows.len() as i64) < PAGE {
            break;
        }
        offset += PAGE;
    }
    tx.commit().await?;
    Ok(())
}

/// GET /users/export.csv (admin): the users matching the list filters.
pub async fn users(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<UserListQuery>,
) -> Result<Response, ApiError> {
    user.require_admin()?;
    // Validate the filters now (a 400 must be a 400, not a broken stream).
    let mut probe = sqlx::QueryBuilder::new("SELECT 1 FROM users u");
    api::push_user_filters(&mut probe, &q)?;
    api::user_order(q.sort.as_deref())?;
    let mut tx = state.pg().begin().await?;
    let today = crate::settings::site_clock(&mut *tx).await?.today;
    audit(
        &mut tx,
        &Actor::of(&user),
        "users",
        json!({ "q": q.q, "plan_id": q.plan_id, "status": q.status, "role": q.role, "sort": q.sort }),
    )
    .await?;
    tx.commit().await?;
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    let sink = Sink::new(tx.clone(), USER_COLS);
    Ok(download(
        filename("users", today),
        produce_users(state, q, sink),
        tx,
        rx,
    ))
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct OrdersQuery {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    pub status: Option<String>,
    /// paid_via filter (`manual` = admin-created / confirmed orders).
    pub via: Option<String>,
}

const ORDER_COLS: &[&str] = &[
    "id",
    "out_trade_no",
    "created_at",
    "paid_at",
    "user_label",
    "user_email",
    "plan_name",
    "period",
    "period_days",
    "list_price_cents",
    "discount_cents",
    "coupon_code",
    "credit_cents",
    "balance_cents",
    "gift_cents",
    "amount_cents",
    "status",
    "paid_via",
    "manual",
    "manual_reason",
    "trade_no",
    "payment_method",
    "refunded_at",
    "refund_cents",
    "fulfil_error",
];

#[derive(sqlx::FromRow)]
struct OrderRow {
    id: Uuid,
    out_trade_no: String,
    created_at: DateTime<Utc>,
    paid_at: Option<DateTime<Utc>>,
    user_label: String,
    user_email: Option<String>,
    plan_name: String,
    period: String,
    period_days: Option<i32>,
    list_price_cents: i64,
    discount_cents: i64,
    coupon_code: Option<String>,
    credit_cents: i64,
    balance_cents: i64,
    gift_cents: i64,
    amount_cents: i64,
    status: String,
    paid_via: Option<String>,
    manual_reason: Option<String>,
    trade_no: Option<String>,
    payment_method: Option<String>,
    refunded_at: Option<DateTime<Utc>>,
    refund_cents: Option<i64>,
    fulfil_error: Option<String>,
}

const ORDER_SELECT: &str = "SELECT o.id, o.out_trade_no, o.created_at, o.paid_at, o.user_label, \
     (SELECT u.email FROM users u WHERE u.id = o.user_id) AS user_email, \
     o.plan_name, o.period, o.period_days, o.list_price_cents, o.discount_cents, o.coupon_code, \
     o.credit_cents, o.balance_cents, o.gift_cents, o.amount_cents, o.status, o.paid_via, \
     o.manual_reason, o.trade_no, \
     (SELECT m.display_name FROM payment_methods m WHERE m.id = o.payment_method_id) \
      AS payment_method, o.refunded_at, o.refund_cents, o.fulfil_error FROM orders o";

fn order_cells(r: &OrderRow) -> Vec<Cell> {
    vec![
        Cell::raw(r.id),
        Cell::raw(&r.out_trade_no),
        date(Some(r.created_at)),
        date(r.paid_at),
        Cell::text(&r.user_label),
        Cell::opt_text(r.user_email.as_deref()),
        Cell::text(&r.plan_name),
        Cell::raw(&r.period),
        Cell::opt_raw(r.period_days),
        Cell::raw(r.list_price_cents),
        Cell::raw(r.discount_cents),
        Cell::opt_text(r.coupon_code.as_deref()),
        Cell::raw(r.credit_cents),
        Cell::raw(r.balance_cents),
        Cell::raw(r.gift_cents),
        Cell::raw(r.amount_cents),
        Cell::raw(&r.status),
        Cell::opt_raw(r.paid_via.as_deref()),
        Cell::bool(r.paid_via.as_deref() == Some("manual")),
        Cell::opt_text(r.manual_reason.as_deref()),
        Cell::opt_text(r.trade_no.as_deref()),
        Cell::opt_text(r.payment_method.as_deref()),
        date(r.refunded_at),
        Cell::opt_raw(r.refund_cents),
        Cell::opt_text(r.fulfil_error.as_deref()),
    ]
}

fn push_order_filters(
    qb: &mut sqlx::QueryBuilder<sqlx::Postgres>,
    from: NaiveDate,
    to: NaiveDate,
    q: &OrdersQuery,
) {
    // Local midnights of the site time zone (Q3).
    qb.push(" WHERE o.created_at >= (")
        .push_bind(from)
        .push("::date::timestamp AT TIME ZONE akari_site_tz()) AND o.created_at < (")
        .push_bind(to + Duration::days(1))
        .push("::date::timestamp AT TIME ZONE akari_site_tz())");
    if let Some(s) = &q.status {
        qb.push(" AND o.status = ").push_bind(s.clone());
    }
    if let Some(v) = &q.via {
        qb.push(" AND o.paid_via = ").push_bind(v.clone());
    }
}

async fn produce_orders(
    state: AppState,
    q: OrdersQuery,
    from: NaiveDate,
    to: NaiveDate,
    mut sink: Sink,
) -> anyhow::Result<()> {
    let mut tx = state.pg().begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let mut after: Option<(DateTime<Utc>, Uuid)> = None;
    loop {
        let mut qb = sqlx::QueryBuilder::new(ORDER_SELECT);
        push_order_filters(&mut qb, from, to, &q);
        if let Some((t, id)) = after {
            qb.push(" AND (o.created_at, o.id) > (")
                .push_bind(t)
                .push(", ")
                .push_bind(id)
                .push(")");
        }
        qb.push(" ORDER BY o.created_at, o.id LIMIT ")
            .push_bind(PAGE);
        let rows: Vec<OrderRow> = qb.build_query_as().fetch_all(&mut *tx).await?;
        for r in &rows {
            sink.row(&order_cells(r));
        }
        sink.flush().await?;
        match rows.last() {
            Some(l) if rows.len() as i64 == PAGE => after = Some((l.created_at, l.id)),
            _ => break,
        }
    }
    tx.commit().await?;
    Ok(())
}

/// GET /orders/export.csv?from&to&status&via (admin).
pub async fn orders(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<OrdersQuery>,
) -> Result<Response, ApiError> {
    user.require_admin()?;
    if let Some(s) = &q.status
        && !matches!(s.as_str(), "pending" | "paid" | "expired" | "cancelled")
    {
        return Err(bad_request!("request.status_invalid", "unknown status"));
    }
    if let Some(v) = &q.via
        && !matches!(
            v.as_str(),
            "notify" | "query" | "manual" | "credit" | "balance" | "coupon"
        )
    {
        return Err(bad_request!("export.via_invalid", "unknown paid_via"));
    }
    let today = crate::settings::site_clock(state.pg()).await?.today;
    let (from, to) = date_range(q.from, q.to, today)?;
    let mut tx = state.pg().begin().await?;
    audit(
        &mut tx,
        &Actor::of(&user),
        "orders",
        json!({ "from": from, "to": to, "status": q.status, "via": q.via }),
    )
    .await?;
    tx.commit().await?;
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    let sink = Sink::new(tx.clone(), ORDER_COLS);
    Ok(download(
        filename("orders", today),
        produce_orders(state, q, from, to, sink),
        tx,
        rx,
    ))
}

// ---------------------------------------------------------------------------
// Traffic (W22 history)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct TrafficQuery {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    /// day (default) | node
    pub group: Option<String>,
}

async fn produce_traffic(
    state: AppState,
    from: NaiveDate,
    to: NaiveDate,
    by_node: bool,
    mut sink: Sink,
) -> anyhow::Result<()> {
    if by_node {
        let rows = trafficlog::fleet_top_nodes(state.pg(), from, to, 100_000).await?;
        for r in &rows {
            sink.row(&[
                Cell::raw(r.node_id),
                Cell::opt_text(r.name.as_deref()),
                Cell::raw(r.bytes.up_bytes),
                Cell::raw(r.bytes.down_bytes),
                Cell::raw(r.bytes.billed_bytes),
            ]);
        }
    } else {
        let rows = trafficlog::fleet_days(state.pg(), from, to).await?;
        for r in &rows {
            sink.row(&[
                Cell::raw(r.day),
                Cell::raw(r.bytes.up_bytes),
                Cell::raw(r.bytes.down_bytes),
                Cell::raw(r.bytes.billed_bytes),
                Cell::raw(r.users),
            ]);
        }
    }
    sink.flush().await
}

/// GET /traffic/export.csv?from&to&group=day|node (admin): the fleet's
/// W22 history (days of the site time zone).
pub async fn traffic(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<TrafficQuery>,
) -> Result<Response, ApiError> {
    user.require_admin()?;
    let by_node = match q.group.as_deref() {
        None | Some("day") => false,
        Some("node") => true,
        Some(_) => {
            return Err(bad_request!(
                "export.group_invalid",
                "group must be day or node"
            ));
        }
    };
    let today = crate::settings::site_clock(state.pg()).await?.today;
    let (from, to) = date_range(q.from, q.to, today)?;
    let mut tx = state.pg().begin().await?;
    audit(
        &mut tx,
        &Actor::of(&user),
        "traffic",
        json!({ "from": from, "to": to, "group": if by_node { "node" } else { "day" } }),
    )
    .await?;
    tx.commit().await?;
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    let cols: &[&str] = if by_node {
        &["node_id", "node", "up_bytes", "down_bytes", "billed_bytes"]
    } else {
        &["day", "up_bytes", "down_bytes", "billed_bytes", "users"]
    };
    let sink = Sink::new(tx.clone(), cols);
    Ok(download(
        filename("traffic", today),
        produce_traffic(state, from, to, by_node, sink),
        tx,
        rx,
    ))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::get;
    axum::Router::new()
        .route("/{prefix}/api/v1/users/export.csv", get(users))
        .route("/{prefix}/api/v1/orders/export.csv", get(orders))
        .route("/{prefix}/api/v1/traffic/export.csv", get(traffic))
}

#[cfg(test)]
mod tests;
