//! W17 support tickets (工单, xboard parity).
//!
//! - **Customers** (`/me/tickets*`, `auth::ShopUser`: expired and
//!   quota-disabled accounts need support too, R21) open tickets (subject,
//!   category, priority, first message, optionally one of their own orders
//!   or a node they use), reply and close them. Only their own: any other
//!   ticket id — another user's, unknown, malformed — is the canonical
//!   rejection (`reject::not_found()`, byte-identical to an unknown path),
//!   so ticket ids are not an oracle. Staff never appear by login (the user
//!   view only says `staff: true`).
//! - **Staff** (`/tickets*`, admin) list with filters, read, reply (and
//!   optionally close in the same step), close, reopen, assign to an admin.
//! - **Status**: `open` (waiting for staff) → staff reply → `answered` →
//!   user reply → `open`; `closed` by either side (replies refused until
//!   staff reopen). **Unread**: per side, the other side's last message
//!   time vs. the side's read marker; reading the ticket advances the
//!   marker to the newest message it actually returned (never past it).
//! - **Limits** (multi-instance: Valkey counters + DB): a customer opens at
//!   most `CREATE_PER_HOUR` tickets per hour and has at most
//!   `MAX_OPEN_PER_USER` not-closed tickets (checked under a per-user
//!   advisory lock), replies at most `REPLY_PER_HOUR` per hour; a ticket
//!   holds at most `MAX_MESSAGES` messages; text only with length caps
//!   (also CHECKs in migration 0115).
//! - Every mutation is an `apply_*` in the caller's transaction with its
//!   audit row (`ticket.create/reply/close/reopen/assign`; bodies are not
//!   copied into the audit log). Email notifications go through
//!   `mailhook` (the W15 SMTP outbox, verified addresses only).

use crate::auth::{bad_request, conflict};
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, ShopUser};
use crate::state::AppState;

pub const CATEGORIES: [&str; 5] = ["general", "billing", "technical", "account", "other"];
pub const PRIORITIES: [&str; 4] = ["low", "normal", "high", "urgent"];
pub const MAX_SUBJECT: usize = 120;
pub const MAX_BODY: usize = 5000;
pub const MAX_MESSAGES: i32 = 200;
pub const MAX_OPEN_PER_USER: i64 = 5;
pub const CREATE_PER_HOUR: i64 = 5;
pub const REPLY_PER_HOUR: i64 = 30;
const PAGE: i64 = 50;
const MY_LIST_LIMIT: i64 = 100;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct CreateReq {
    pub subject: String,
    pub category: String,
    #[serde(default = "normal")]
    pub priority: String,
    pub message: String,
    #[serde(default)]
    pub order_id: Option<Uuid>,
    #[serde(default)]
    pub node_id: Option<Uuid>,
}

fn normal() -> String {
    "normal".into()
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct ReplyReq {
    pub message: String,
    /// Close the ticket with this reply.
    #[serde(default)]
    pub close: bool,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct AssignReq {
    /// An admin account, or null to unassign.
    pub assignee_id: Option<Uuid>,
}

/// A one-line subject: trimmed, no control characters, 1..=MAX_SUBJECT
/// characters.
pub fn clean_subject(s: &str) -> Result<String, ApiError> {
    let s = s.trim();
    if s.is_empty() {
        return Err(bad_request!(
            "ticket.subject_required",
            "subject is required"
        ));
    }
    if s.chars().any(char::is_control) {
        return Err(bad_request!(
            "ticket.subject_multiline",
            "subject must be a single line"
        ));
    }
    if s.chars().count() > MAX_SUBJECT {
        return Err(bad_request!(
            "ticket.subject_long",
            "subject is longer than {max_subject} characters",
            max_subject = MAX_SUBJECT
        ));
    }
    Ok(s.to_string())
}

/// A message body: CRLF/CR normalized to LF, control characters other than
/// LF and TAB removed, trimmed, 1..=MAX_BODY characters.
pub fn clean_body(s: &str) -> Result<String, ApiError> {
    let s = s.replace("\r\n", "\n").replace('\r', "\n");
    let s: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let s = s.trim();
    if s.is_empty() {
        return Err(bad_request!(
            "ticket.message_required",
            "message is required"
        ));
    }
    if s.chars().count() > MAX_BODY {
        return Err(bad_request!(
            "ticket.message_long",
            "message is longer than {max_body} characters",
            max_body = MAX_BODY
        ));
    }
    Ok(s.to_string())
}

fn check_choice(field: &str, v: &str, allowed: &[&str]) -> Result<(), ApiError> {
    if allowed.contains(&v) {
        Ok(())
    } else {
        Err(bad_request!(
            "ticket.choice_invalid",
            "{field} must be one of: {allowed}",
            field = field,
            allowed = allowed.join(", ")
        ))
    }
}

/// Who writes a message.
#[derive(Debug, Clone)]
pub struct Author {
    pub id: Uuid,
    pub login: String,
    pub staff: bool,
}

impl Author {
    pub fn of(user: &AuthUser) -> Self {
        Self {
            id: user.id,
            login: user.login.clone(),
            staff: user.role == "admin",
        }
    }
}

// ---------------------------------------------------------------------------
// Mutations (caller's transaction; audited)
// ---------------------------------------------------------------------------

/// Serializes one customer's ticket creation (the open-ticket cap) across
/// instances, for the rest of the transaction.
async fn lock_user_tickets(conn: &mut PgConnection, user: Uuid) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('akari.ticket.' || $1::text, 0))")
        .bind(user)
        .execute(conn)
        .await?;
    Ok(())
}

/// Open a ticket for `user` (a customer) with its first message.
pub async fn apply_create(
    conn: &mut PgConnection,
    actor: &Actor,
    user: &Author,
    req: &CreateReq,
    links: Option<&crate::mailhook::Links>,
) -> Result<Uuid, ApiError> {
    let subject = clean_subject(&req.subject)?;
    let body = clean_body(&req.message)?;
    check_choice("category", &req.category, &CATEGORIES)?;
    check_choice("priority", &req.priority, &PRIORITIES)?;
    if let Some(o) = req.order_id {
        let mine: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM orders WHERE id = $1 AND user_id = $2)",
        )
        .bind(o)
        .bind(user.id)
        .fetch_one(&mut *conn)
        .await?;
        if !mine {
            return Err(bad_request!("ticket.unknown_order", "unknown order"));
        }
    }
    if let Some(n) = req.node_id {
        let mine: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM node_users WHERE node_id = $1 AND user_id = $2)",
        )
        .bind(n)
        .bind(user.id)
        .fetch_one(&mut *conn)
        .await?;
        if !mine {
            return Err(bad_request!("ticket.unknown_node", "unknown node"));
        }
    }
    lock_user_tickets(conn, user.id).await?;
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM tickets WHERE user_id = $1 AND status <> 'closed'",
    )
    .bind(user.id)
    .fetch_one(&mut *conn)
    .await?;
    if open >= MAX_OPEN_PER_USER {
        return Err(conflict!(
            "ticket.open_limit",
            "too many open tickets (at most {max_open_per_user}); close one first",
            max_open_per_user = MAX_OPEN_PER_USER
        ));
    }
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO tickets (id, user_id, subject, category, priority, status, order_id, node_id, \
           messages, last_user_at, user_read_at) \
         VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, 1, now(), now())",
    )
    .bind(id)
    .bind(user.id)
    .bind(&subject)
    .bind(&req.category)
    .bind(&req.priority)
    .bind(req.order_id)
    .bind(req.node_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO ticket_messages (ticket_id, author_id, author_login, staff, body) \
         VALUES ($1, $2, $3, false, $4)",
    )
    .bind(id)
    .bind(user.id)
    .bind(&user.login)
    .bind(&body)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "ticket.create",
        "ticket",
        Some(id.to_string()),
        None,
        Some(json!({
            "user_id": user.id, "category": req.category, "priority": req.priority,
            "order_id": req.order_id, "node_id": req.node_id, "length": body.chars().count(),
        })),
    )
    .await?;
    crate::mailhook::ticket_created(conn, id, links).await?;
    Ok(id)
}

#[derive(sqlx::FromRow)]
struct Locked {
    status: String,
    messages: i32,
}

/// Lock a ticket for a mutation: a customer only sees their own (`owner`),
/// staff any. None = not found (for the customer: not theirs either).
async fn lock_ticket(
    conn: &mut PgConnection,
    id: Uuid,
    owner: Option<Uuid>,
) -> sqlx::Result<Option<Locked>> {
    sqlx::query_as(
        "SELECT status, messages FROM tickets WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2) \
         FOR UPDATE",
    )
    .bind(id)
    .bind(owner)
    .fetch_optional(conn)
    .await
}

/// Outcome of a mutation addressed to one ticket.
#[derive(Debug, PartialEq, Eq)]
pub enum Found<T> {
    Yes(T),
    /// No such ticket (for a customer: or not theirs).
    No,
}

/// Add a message. Customers: own tickets only (`Found::No` otherwise);
/// status becomes `open`. Staff: status `answered`, or `closed` with
/// `close`. Closed tickets refuse replies (409; staff reopen first).
pub async fn apply_reply(
    conn: &mut PgConnection,
    actor: &Actor,
    author: &Author,
    ticket: Uuid,
    req: &ReplyReq,
    links: Option<&crate::mailhook::Links>,
) -> Result<Found<i64>, ApiError> {
    let body = clean_body(&req.message)?;
    let owner = (!author.staff).then_some(author.id);
    let Some(t) = lock_ticket(conn, ticket, owner).await? else {
        return Ok(Found::No);
    };
    if t.status == "closed" {
        return Err(conflict!("ticket.closed", "ticket is closed"));
    }
    if t.messages >= MAX_MESSAGES {
        return Err(conflict!(
            "ticket.full",
            "ticket has {max_messages} messages; open a new ticket",
            max_messages = MAX_MESSAGES
        ));
    }
    let msg: i64 = sqlx::query_scalar(
        "INSERT INTO ticket_messages (ticket_id, author_id, author_login, staff, body) \
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(ticket)
    .bind(author.id)
    .bind(&author.login)
    .bind(author.staff)
    .bind(&body)
    .fetch_one(&mut *conn)
    .await?;
    let close = req.close;
    if author.staff {
        sqlx::query(
            "UPDATE tickets SET messages = messages + 1, updated_at = now(), last_staff_at = now(), \
               staff_read_at = now(), \
               status = CASE WHEN $2 THEN 'closed' ELSE 'answered' END, \
               closed_at = CASE WHEN $2 THEN now() END, closed_by = CASE WHEN $2 THEN 'staff' END \
             WHERE id = $1",
        )
        .bind(ticket)
        .bind(close)
        .execute(&mut *conn)
        .await?;
    } else {
        sqlx::query(
            "UPDATE tickets SET messages = messages + 1, updated_at = now(), last_user_at = now(), \
               user_read_at = now(), \
               status = CASE WHEN $2 THEN 'closed' ELSE 'open' END, \
               closed_at = CASE WHEN $2 THEN now() END, closed_by = CASE WHEN $2 THEN 'user' END \
             WHERE id = $1",
        )
        .bind(ticket)
        .bind(close)
        .execute(&mut *conn)
        .await?;
    }
    crate::audit::record(
        conn,
        actor,
        "ticket.reply",
        "ticket",
        Some(ticket.to_string()),
        Some(json!({ "status": t.status })),
        Some(json!({
            "message_id": msg, "staff": author.staff, "close": close,
            "length": body.chars().count(),
        })),
    )
    .await?;
    if author.staff {
        crate::mailhook::ticket_replied(conn, ticket, links).await?;
    }
    Ok(Found::Yes(msg))
}

/// Close a ticket (idempotent: closing a closed ticket changes nothing and
/// writes no audit row). Returns whether this call closed it.
pub async fn apply_close(
    conn: &mut PgConnection,
    actor: &Actor,
    author: &Author,
    ticket: Uuid,
) -> Result<Found<bool>, ApiError> {
    let owner = (!author.staff).then_some(author.id);
    let Some(t) = lock_ticket(conn, ticket, owner).await? else {
        return Ok(Found::No);
    };
    if t.status == "closed" {
        return Ok(Found::Yes(false));
    }
    sqlx::query(
        "UPDATE tickets SET status = 'closed', closed_at = now(), closed_by = $2, updated_at = now() \
         WHERE id = $1",
    )
    .bind(ticket)
    .bind(if author.staff { "staff" } else { "user" })
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "ticket.close",
        "ticket",
        Some(ticket.to_string()),
        Some(json!({ "status": t.status })),
        Some(json!({ "status": "closed", "by": if author.staff { "staff" } else { "user" } })),
    )
    .await?;
    Ok(Found::Yes(true))
}

/// Staff: reopen a closed ticket (status `open`). 409 when not closed.
pub async fn apply_reopen(
    conn: &mut PgConnection,
    actor: &Actor,
    ticket: Uuid,
) -> Result<Found<()>, ApiError> {
    let Some(t) = lock_ticket(conn, ticket, None).await? else {
        return Ok(Found::No);
    };
    if t.status != "closed" {
        return Err(conflict!("ticket_admin.not_closed", "ticket is not closed"));
    }
    sqlx::query(
        "UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL, updated_at = now() \
         WHERE id = $1",
    )
    .bind(ticket)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "ticket.reopen",
        "ticket",
        Some(ticket.to_string()),
        Some(json!({ "status": "closed" })),
        Some(json!({ "status": "open" })),
    )
    .await?;
    Ok(Found::Yes(()))
}

/// Staff: assign to an enabled admin account (or unassign with None).
pub async fn apply_assign(
    conn: &mut PgConnection,
    actor: &Actor,
    ticket: Uuid,
    assignee: Option<Uuid>,
) -> Result<Found<()>, ApiError> {
    if lock_ticket(conn, ticket, None).await?.is_none() {
        return Ok(Found::No);
    }
    if let Some(a) = assignee {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND role = 'admin' AND enabled)",
        )
        .bind(a)
        .fetch_one(&mut *conn)
        .await?;
        if !ok {
            return Err(bad_request!(
                "ticket_admin.assignee_invalid",
                "assignee must be an enabled admin"
            ));
        }
    }
    let before: Option<Uuid> = sqlx::query_scalar(
        "UPDATE tickets SET assignee_id = $2, updated_at = now() WHERE id = $1 \
         RETURNING old.assignee_id",
    )
    .bind(ticket)
    .bind(assignee)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "ticket.assign",
        "ticket",
        Some(ticket.to_string()),
        Some(json!({ "assignee_id": before })),
        Some(json!({ "assignee_id": assignee })),
    )
    .await?;
    Ok(Found::Yes(()))
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const UNREAD_USER: &str = "(t.last_staff_at IS NOT NULL AND (t.user_read_at IS NULL OR t.last_staff_at > t.user_read_at))";
const UNREAD_STAFF: &str = "(t.last_user_at IS NOT NULL AND (t.staff_read_at IS NULL OR t.last_user_at > t.staff_read_at))";

#[derive(Serialize, sqlx::FromRow)]
pub struct MyTicketRow {
    id: Uuid,
    subject: String,
    category: String,
    priority: String,
    status: String,
    messages: i32,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    unread: bool,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct TicketRow {
    id: Uuid,
    user_id: Uuid,
    user_login: String,
    subject: String,
    category: String,
    priority: String,
    status: String,
    messages: i32,
    order_id: Option<Uuid>,
    order_no: Option<String>,
    node_id: Option<Uuid>,
    node_name: Option<String>,
    assignee_id: Option<Uuid>,
    assignee_login: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    closed_at: Option<DateTime<Utc>>,
    closed_by: Option<String>,
    unread: bool,
    #[serde(skip)]
    last_user_at: Option<DateTime<Utc>>,
    #[serde(skip)]
    last_staff_at: Option<DateTime<Utc>>,
}

fn ticket_select(unread: &str) -> String {
    format!(
        "SELECT t.id, t.user_id, u.login AS user_login, t.subject, t.category, t.priority, \
           t.status, t.messages, t.order_id, o.out_trade_no AS order_no, t.node_id, \
           coalesce(n.display_name, n.name) AS node_name, t.assignee_id, a.login AS assignee_login, \
           t.created_at, t.updated_at, t.closed_at, t.closed_by, {unread} AS unread, \
           t.last_user_at, t.last_staff_at \
         FROM tickets t JOIN users u ON u.id = t.user_id \
         LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN nodes n ON n.id = t.node_id \
         LEFT JOIN users a ON a.id = t.assignee_id"
    )
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MessageRow {
    id: i64,
    staff: bool,
    /// Staff view only (customers never learn admin logins).
    #[serde(skip_serializing_if = "Option::is_none")]
    author_login: Option<String>,
    body: String,
    created_at: DateTime<Utc>,
}

async fn messages(
    conn: &mut PgConnection,
    ticket: Uuid,
    staff_view: bool,
) -> sqlx::Result<Vec<MessageRow>> {
    sqlx::query_as(
        "SELECT id, staff, CASE WHEN $2 OR NOT staff THEN author_login END AS author_login, body, \
           created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY id",
    )
    .bind(ticket)
    .bind(staff_view)
    .fetch_all(conn)
    .await
}

/// Customer's view of one ticket.
#[derive(Serialize)]
pub struct MyTicketView {
    id: Uuid,
    subject: String,
    category: String,
    priority: String,
    status: String,
    order_id: Option<Uuid>,
    order_no: Option<String>,
    node_id: Option<Uuid>,
    node_name: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    closed_at: Option<DateTime<Utc>>,
    closed_by: Option<String>,
    messages: Vec<MessageRow>,
}

/// Staff view of one ticket.
#[derive(Serialize)]
pub struct TicketView {
    #[serde(flatten)]
    ticket: TicketRow,
    user_email: Option<String>,
    user_enabled: bool,
    thread: Vec<MessageRow>,
}

/// Read one ticket (customer: own only) with its messages and advance the
/// reader's unread marker to the newest message of the other side it
/// returned. None = not found / not the caller's.
pub async fn read_ticket_mine(
    conn: &mut PgConnection,
    user: Uuid,
    id: Uuid,
) -> sqlx::Result<Option<MyTicketView>> {
    let row: Option<TicketRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{} WHERE t.id = $1 AND t.user_id = $2",
        ticket_select(UNREAD_USER)
    )))
    .bind(id)
    .bind(user)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(t) = row else {
        return Ok(None);
    };
    let msgs = messages(conn, id, false).await?;
    if let Some(at) = t.last_staff_at.filter(|_| t.unread) {
        sqlx::query(
            "UPDATE tickets SET user_read_at = $2 WHERE id = $1 \
             AND (user_read_at IS NULL OR user_read_at < $2)",
        )
        .bind(id)
        .bind(at)
        .execute(&mut *conn)
        .await?;
    }
    Ok(Some(MyTicketView {
        id: t.id,
        subject: t.subject,
        category: t.category,
        priority: t.priority,
        status: t.status,
        order_id: t.order_id,
        order_no: t.order_no,
        node_id: t.node_id,
        node_name: t.node_name,
        created_at: t.created_at,
        updated_at: t.updated_at,
        closed_at: t.closed_at,
        closed_by: t.closed_by,
        messages: msgs,
    }))
}

pub async fn read_ticket_staff(
    conn: &mut PgConnection,
    id: Uuid,
) -> sqlx::Result<Option<TicketView>> {
    let row: Option<TicketRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{} WHERE t.id = $1",
        ticket_select(UNREAD_STAFF)
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(t) = row else {
        return Ok(None);
    };
    let thread = messages(conn, id, true).await?;
    if let Some(at) = t.last_user_at.filter(|_| t.unread) {
        sqlx::query(
            "UPDATE tickets SET staff_read_at = $2 WHERE id = $1 \
             AND (staff_read_at IS NULL OR staff_read_at < $2)",
        )
        .bind(id)
        .bind(at)
        .execute(&mut *conn)
        .await?;
    }
    let (email, enabled): (Option<String>, bool) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {} AS email, enabled FROM users WHERE id = $1",
        email_column()
    )))
    .bind(t.user_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Some(TicketView {
        ticket: t,
        user_email: email,
        user_enabled: enabled,
        thread,
    }))
}

/// The customer's address (W15 `users.email`, verified or not: staff see it).
fn email_column() -> &'static str {
    "email"
}

// ---------------------------------------------------------------------------
// Customer API (/me/tickets*)
// ---------------------------------------------------------------------------

/// Customers only (staff use /tickets).
fn customer(u: &ShopUser) -> Result<Author, ApiError> {
    if u.user.role != "user" {
        return Err(ApiError::forbidden());
    }
    Ok(Author::of(&u.user))
}

/// Ticket id from the path; anything malformed is the canonical rejection.
fn ticket_id(raw: &str) -> Option<Uuid> {
    Uuid::parse_str(raw).ok()
}

/// Count one action in a per-user hourly window (Valkey, shared by every
/// instance; unavailable = allowed — the DB caps still hold).
async fn within_rate(state: &AppState, what: &str, user: Uuid, limit: i64) -> bool {
    match crate::rate::hit(state, format!("akari:rl:ticket:{what}:{user}"), limit, 3600).await {
        Ok(ok) => ok,
        Err(e) => {
            tracing::warn!(error = %e, "ticket rate limit unavailable; allowing");
            true
        }
    }
}

/// GET /me/tickets: the caller's tickets, newest activity first.
pub async fn my_tickets(
    State(state): State<AppState>,
    u: ShopUser,
) -> Result<Json<Vec<MyTicketRow>>, ApiError> {
    let me = customer(&u)?;
    let rows = sqlx::query_as::<_, MyTicketRow>(sqlx::AssertSqlSafe(format!(
        "SELECT t.id, t.subject, t.category, t.priority, t.status, t.messages, t.created_at, \
           t.updated_at, {UNREAD_USER} AS unread FROM tickets t WHERE t.user_id = $1 \
         ORDER BY t.updated_at DESC, t.id LIMIT {MY_LIST_LIMIT}"
    )))
    .bind(me.id)
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// POST /me/tickets → 201 {id}.
pub async fn create_my_ticket(
    State(state): State<AppState>,
    u: ShopUser,
    ApiJson(req): ApiJson<CreateReq>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let me = customer(&u)?;
    // Validate before spending the rate budget on a typo.
    clean_subject(&req.subject)?;
    clean_body(&req.message)?;
    if !within_rate(&state, "new", me.id, CREATE_PER_HOUR).await {
        return Err(ApiError::too_many());
    }
    let mut tx = state.pg().begin().await?;
    let links = crate::mailhook::Links::of(&state);
    let id = apply_create(&mut tx, &Actor::of(&u.user), &me, &req, Some(&links)).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

/// GET /me/tickets/{id}: own ticket with messages (marks staff replies
/// read). Anything else is the canonical rejection.
pub async fn my_ticket(
    State(state): State<AppState>,
    u: ShopUser,
    Path((_, raw)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let me = customer(&u)?;
    let Some(id) = ticket_id(&raw) else {
        return Ok(crate::reject::not_found());
    };
    let mut tx = state.pg().begin().await?;
    let view = read_ticket_mine(&mut tx, me.id, id).await?;
    tx.commit().await?;
    Ok(match view {
        Some(v) => Json(v).into_response(),
        None => crate::reject::not_found(),
    })
}

/// POST /me/tickets/{id}/replies {message, close?}.
pub async fn reply_my_ticket(
    State(state): State<AppState>,
    u: ShopUser,
    Path((_, raw)): Path<(String, String)>,
    ApiJson(req): ApiJson<ReplyReq>,
) -> Result<Response, ApiError> {
    let me = customer(&u)?;
    let Some(id) = ticket_id(&raw) else {
        return Ok(crate::reject::not_found());
    };
    clean_body(&req.message)?;
    if !within_rate(&state, "reply", me.id, REPLY_PER_HOUR).await {
        return Err(ApiError::too_many());
    }
    let mut tx = state.pg().begin().await?;
    match apply_reply(&mut tx, &Actor::of(&u.user), &me, id, &req, None).await? {
        Found::Yes(msg) => {
            tx.commit().await?;
            Ok((StatusCode::CREATED, Json(json!({ "message_id": msg }))).into_response())
        }
        Found::No => Ok(crate::reject::not_found()),
    }
}

/// POST /me/tickets/{id}/close.
pub async fn close_my_ticket(
    State(state): State<AppState>,
    u: ShopUser,
    Path((_, raw)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let me = customer(&u)?;
    let Some(id) = ticket_id(&raw) else {
        return Ok(crate::reject::not_found());
    };
    let mut tx = state.pg().begin().await?;
    match apply_close(&mut tx, &Actor::of(&u.user), &me, id).await? {
        Found::Yes(_) => {
            tx.commit().await?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        Found::No => Ok(crate::reject::not_found()),
    }
}

// ---------------------------------------------------------------------------
// Staff API (/tickets*)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    /// open | answered | closed | active (not closed); absent = all.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    /// me | none | <admin uuid>.
    #[serde(default)]
    pub assignee: Option<String>,
    /// Only tickets with unread customer messages.
    #[serde(default)]
    pub unread: Option<bool>,
    /// Substring of the subject or the customer's login.
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub page: Option<i64>,
}

#[derive(Serialize)]
pub struct ListView {
    tickets: Vec<TicketRow>,
    total: i64,
    page: i64,
    per_page: i64,
    /// Queue counters (unfiltered): waiting for staff, unread.
    open: i64,
    unread: i64,
}

fn bind(v: String, binds: &mut Vec<String>) -> String {
    binds.push(v);
    format!("${}", binds.len())
}

/// The WHERE clause and its text binds for a staff list query.
pub fn list_filter(q: &ListQuery, me: Uuid) -> Result<(String, Vec<String>), ApiError> {
    let mut clauses = Vec::new();
    let mut binds: Vec<String> = Vec::new();
    match q.status.as_deref() {
        None | Some("") => {}
        Some("active") => clauses.push("t.status <> 'closed'".to_string()),
        Some(s @ ("open" | "answered" | "closed")) => {
            let p = bind(s.into(), &mut binds);
            clauses.push(format!("t.status = {p}"));
        }
        Some(_) => {
            return Err(bad_request!(
                "ticket_admin.status_invalid",
                "status must be open, answered, closed or active"
            ));
        }
    }
    if let Some(c) = q.category.as_deref().filter(|s| !s.is_empty()) {
        check_choice("category", c, &CATEGORIES)?;
        let p = bind(c.into(), &mut binds);
        clauses.push(format!("t.category = {p}"));
    }
    if let Some(c) = q.priority.as_deref().filter(|s| !s.is_empty()) {
        check_choice("priority", c, &PRIORITIES)?;
        let p = bind(c.into(), &mut binds);
        clauses.push(format!("t.priority = {p}"));
    }
    match q.assignee.as_deref() {
        None | Some("") => {}
        Some("none") => clauses.push("t.assignee_id IS NULL".into()),
        Some(a) => {
            let id = if a == "me" {
                me
            } else {
                Uuid::parse_str(a).map_err(|_| {
                    bad_request!(
                        "ticket_admin.assignee_filter",
                        "assignee must be me, none or an id"
                    )
                })?
            };
            let p = bind(id.to_string(), &mut binds);
            clauses.push(format!("t.assignee_id = {p}::uuid"));
        }
    }
    if q.unread == Some(true) {
        clauses.push(UNREAD_STAFF.into());
    }
    if let Some(s) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if s.chars().count() > 64 {
            return Err(bad_request!(
                "ticket_admin.search_long",
                "search text is longer than 64 characters"
            ));
        }
        let escaped = s
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let p = bind(format!("%{escaped}%"), &mut binds);
        clauses.push(format!("(t.subject ILIKE {p} OR u.login ILIKE {p})"));
    }
    let wh = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    Ok((wh, binds))
}

/// GET /tickets (admin).
pub async fn list_tickets(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<ListView>, ApiError> {
    user.require_admin()?;
    let page = q.page.unwrap_or(1).clamp(1, 10_000);
    let (wh, binds) = list_filter(&q, user.id)?;
    let sql = format!(
        "{}{wh} ORDER BY t.updated_at DESC, t.id LIMIT {PAGE} OFFSET {}",
        ticket_select(UNREAD_STAFF),
        (page - 1) * PAGE
    );
    let mut rows = sqlx::query_as::<_, TicketRow>(sqlx::AssertSqlSafe(sql));
    for b in &binds {
        rows = rows.bind(b);
    }
    let tickets = rows.fetch_all(state.pg()).await?;
    let count_sql = format!("SELECT count(*) FROM tickets t JOIN users u ON u.id = t.user_id{wh}");
    let mut count = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql));
    for b in &binds {
        count = count.bind(b);
    }
    let total = count.fetch_one(state.pg()).await?;
    let (open, unread): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FILTER (WHERE t.status = 'open'), count(*) FILTER (WHERE {UNREAD_STAFF}) \
         FROM tickets t WHERE t.status <> 'closed'"
    )))
    .fetch_one(state.pg())
    .await?;
    Ok(Json(ListView {
        tickets,
        total,
        page,
        per_page: PAGE,
        open,
        unread,
    }))
}

/// GET /tickets/{id} (admin; marks the customer's messages read).
pub async fn get_ticket(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<TicketView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let v = read_ticket_staff(&mut tx, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    tx.commit().await?;
    Ok(Json(v))
}

fn found<T>(f: Found<T>) -> Result<T, ApiError> {
    match f {
        Found::Yes(v) => Ok(v),
        Found::No => Err(ApiError::not_found()),
    }
}

/// POST /tickets/{id}/replies {message, close?} (admin).
pub async fn reply_ticket(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<ReplyReq>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let links = crate::mailhook::Links::of(&state);
    let msg = found(
        apply_reply(
            &mut tx,
            &Actor::of(&user),
            &Author::of(&user),
            id,
            &req,
            Some(&links),
        )
        .await?,
    )?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "message_id": msg }))))
}

/// POST /tickets/{id}/close (admin).
pub async fn close_ticket(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    found(apply_close(&mut tx, &Actor::of(&user), &Author::of(&user), id).await?)?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /tickets/{id}/reopen (admin).
pub async fn reopen_ticket(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    found(apply_reopen(&mut tx, &Actor::of(&user), id).await?)?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// PUT /tickets/{id}/assignee {assignee_id} (admin).
pub async fn assign_ticket(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<AssignReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    found(apply_assign(&mut tx, &Actor::of(&user), id, req.assignee_id).await?)?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /admins (admin): enabled admin accounts (the assignee picker).
pub async fn list_admins(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    user.require_admin()?;
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, login FROM users WHERE role = 'admin' AND enabled ORDER BY login LIMIT 200",
    )
    .fetch_all(state.pg())
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, login)| json!({ "id": id, "login": login }))
            .collect(),
    ))
}

/// GET /admin-badges (admin): the console's navigation counters.
pub async fn badges(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    user.require_admin()?;
    let (open, unread): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FILTER (WHERE t.status = 'open'), count(*) FILTER (WHERE {UNREAD_STAFF}) \
         FROM tickets t WHERE t.status <> 'closed'"
    )))
    .fetch_one(state.pg())
    .await?;
    let firing: i64 =
        sqlx::query_scalar("SELECT count(*) FROM node_alerts WHERE status = 'firing'")
            .fetch_one(state.pg())
            .await?;
    Ok(Json(json!({
        "tickets_open": open,
        "tickets_unread": unread,
        "alerts_firing": firing,
    })))
}

#[cfg(test)]
mod tests;
