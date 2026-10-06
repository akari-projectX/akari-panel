//! Ops: batch operations on users from the admin console (migration 0165).
//!
//! A job = one action applied to a fixed set of users (the selected ids,
//! or every user matching the users-list filter when the job was created).
//! Creation snapshots the targets into `admin_batch_items` (status
//! `pending`) in one transaction and audits `user.batch.create`. Any
//! instance runs jobs (`run_loop`): a job is claimed with a lease + token
//! (like the mail outbox); the runner processes the pending items in id
//! order in bounded chunks, ONE TRANSACTION PER CHUNK, and inside it each
//! user under its own savepoint:
//!
//!   apply_* (the existing mutator: audit + node bumps, same tx)  →
//!   item row `pending` → `done` | `failed` | `skipped`
//!
//! so a user is applied exactly once per job whatever crashes or restarts
//! happen between chunks (the item flips with the apply, or neither does),
//! and a job resumes wherever it stopped. Nothing is applied here that is
//! not an existing `apply_*` (lock order and audit are theirs); admin
//! accounts are always skipped; a cancelled job stops after the current
//! chunk and its pending items are marked skipped.
//!
//! `send_email` goes through the W15 outbox (template `AdminNotice`, only
//! to verified addresses) and is rate-limited through Valkey: when the
//! window is used up the runner stops the chunk and the job waits for the
//! next tick (items stay pending — nothing is dropped).

use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};
use uuid::Uuid;

use crate::api::{self, UserListQuery};
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::billing::ledger;
use crate::mail::templates::{Locale, Template};
use crate::plans;
use crate::state::AppState;

/// Users handled per transaction: plan actions hold `entitle::lock`
/// (one global lock) for the whole chunk, so they take smaller bites.
const CHUNK_PLAIN: i64 = 500;
const CHUNK_LOCKED: i64 = 100;
/// Most users one job may target through explicit ids (a filter job
/// targets whatever matches).
pub const MAX_IDS: usize = 10_000;
/// Claim lease; a dead runner's job is picked up after this.
const LEASE_SECS: i64 = 60;
/// Runner cadence (new jobs are also run right after creation).
const EVERY: Duration = Duration::from_secs(3);
/// Batch mail: at most this many mails per window, fleet-wide.
pub const MAIL_RATE: i64 = 600;
pub const MAIL_WINDOW_SECS: i64 = 600;
const MAIL_RATE_KEY: &str = "akari:rl:batchmail";
/// Items listed in a job's detail (failed/skipped first).
const DETAIL_ITEMS: i64 = 500;
pub const MAX_SUBJECT: usize = 120;
pub const MAX_BODY: usize = 5000;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// The users-list filter (W21 `GET /users` parameters without paging).
#[derive(Deserialize, Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UserFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// D10 filters (as `GET /users`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub never_used: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registered_before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_login_before: Option<String>,
}

impl UserFilter {
    pub(crate) fn query(&self) -> UserListQuery {
        UserListQuery {
            q: self.q.clone(),
            plan_id: self.plan_id.clone(),
            status: self.status.clone(),
            role: self.role.clone(),
            never_used: self.never_used,
            registered_before: self.registered_before.clone(),
            last_login_before: self.last_login_before.clone(),
            ..Default::default()
        }
    }
}

/// Which users: explicit ids, or everyone matching a filter (exactly one).
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    #[serde(default)]
    pub ids: Option<Vec<Uuid>>,
    #[serde(default)]
    pub filter: Option<UserFilter>,
}

/// What to do (`kind` + parameters).
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    /// D12 "延长 N 天": push the active subscription's expiry out by N days
    /// (from the later of now and the expiry); users without a plan, with
    /// a one-time purchase (ruling ④) or without an expiry are skipped.
    ExtendExpiry {
        days: i32,
    },
    /// Reset the plan traffic (users without a plan are skipped).
    ResetTraffic {},
    /// W28-c: ban with the reason shown to the users.
    Ban {
        reason: String,
    },
    Unban {},
    /// Assign / replace the plan for one term (D12; M3 replace semantics).
    SetPlan {
        plan_id: Uuid,
        period: crate::billing::catalog::PeriodKindText,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        days: Option<i32>,
    },
    CancelPlan {},
    /// Credit (or debit) the balance: one ledger row + audit per user.
    AddBalance {
        amount_cents: i64,
        reason: String,
    },
    /// A notice through the outbox (verified addresses only).
    SendEmail {
        subject: String,
        body: String,
    },
}

impl Action {
    pub fn kind(&self) -> &'static str {
        match self {
            Action::ExtendExpiry { .. } => "extend_expiry",
            Action::ResetTraffic {} => "reset_traffic",
            Action::Ban { .. } => "ban",
            Action::Unban {} => "unban",
            Action::SetPlan { .. } => "set_plan",
            Action::CancelPlan {} => "cancel_plan",
            Action::AddBalance { .. } => "add_balance",
            Action::SendEmail { .. } => "send_email",
        }
    }

    fn chunk(&self) -> i64 {
        match self {
            Action::ExtendExpiry { .. }
            | Action::ResetTraffic {}
            | Action::SetPlan { .. }
            | Action::CancelPlan {} => CHUNK_LOCKED,
            _ => CHUNK_PLAIN,
        }
    }

    /// The parameters as stored (`kind` left out).
    fn params(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Value::Object(m) = &mut v {
            m.remove("kind");
        }
        v
    }

    fn from_row(kind: &str, params: &Value) -> Result<Action, ApiError> {
        let mut v = params.clone();
        if let Value::Object(m) = &mut v {
            m.insert("kind".into(), json!(kind));
        }
        serde_json::from_value(v).map_err(|e| anyhow::anyhow!("stored batch action: {e}").into())
    }
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct PreviewReq {
    pub selection: Selection,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct CreateReq {
    pub selection: Selection,
    pub action: Action,
}

/// Validate the action's parameters (pure; plan existence is checked in
/// the transaction).
pub fn check_action(a: &Action) -> Result<(), ApiError> {
    match a {
        Action::ExtendExpiry { days } => {
            plans::Renewal::extend(*days)?;
        }
        Action::Ban { reason } => {
            api::clean_ban_reason(reason)?;
        }
        Action::SetPlan { period, days, .. } => {
            plans::Term::new(period.0, *days)?;
        }
        Action::AddBalance {
            amount_cents,
            reason,
        } => {
            ledger::check_adjust(&ledger::AdjustReq {
                amount_cents: *amount_cents,
                reason: reason.clone(),
            })?;
        }
        Action::SendEmail { subject, body } => {
            let s = subject.trim();
            if s.is_empty() || s.chars().count() > MAX_SUBJECT || s.chars().any(char::is_control) {
                return Err(bad_request!(
                    "batch.subject_invalid",
                    "subject must be 1-{max_subject} characters without control characters",
                    max_subject = MAX_SUBJECT
                ));
            }
            let b = body.trim();
            if b.is_empty() || b.chars().count() > MAX_BODY {
                return Err(bad_request!(
                    "batch.body_length",
                    "body must be 1-{max_body} characters",
                    max_body = MAX_BODY
                ));
            }
        }
        Action::ResetTraffic {} | Action::Unban {} | Action::CancelPlan {} => {}
    }
    Ok(())
}

/// Push `WHERE …` (over alias `u`) for the selection into `qb`; returns the
/// selection kind. An empty id list is a 400.
pub(crate) fn push_selection(
    qb: &mut sqlx::QueryBuilder<sqlx::Postgres>,
    sel: &Selection,
) -> Result<&'static str, ApiError> {
    match (&sel.ids, &sel.filter) {
        (Some(ids), None) => {
            if ids.is_empty() {
                return Err(bad_request!("batch.empty", "no users selected"));
            }
            if ids.len() > MAX_IDS {
                return Err(bad_request!(
                    "batch.too_many_ids",
                    "at most {max_ids} users per batch by id",
                    max_ids = MAX_IDS
                ));
            }
            let mut ids = ids.clone();
            ids.sort();
            ids.dedup();
            qb.push(" WHERE u.id = ANY(").push_bind(ids).push(")");
            Ok("ids")
        }
        (None, Some(f)) => {
            api::push_user_filters(qb, &f.query())?;
            Ok("filter")
        }
        _ => Err(bad_request!(
            "batch.selection_invalid",
            "give either ids or filter"
        )),
    }
}

#[derive(Serialize, Debug)]
pub struct Preview {
    pub total: i64,
    /// Admin accounts in the selection (always skipped).
    pub admins: i64,
    /// Up to 10 email addresses.
    pub sample: Vec<String>,
}

pub async fn preview_selection(
    conn: &mut PgConnection,
    sel: &Selection,
) -> Result<Preview, ApiError> {
    let mut qb = sqlx::QueryBuilder::new(
        "SELECT count(*), count(*) FILTER (WHERE u.role = 'admin') FROM users u",
    );
    push_selection(&mut qb, sel)?;
    let (total, admins): (i64, i64) = qb.build_query_as().fetch_one(&mut *conn).await?;
    let mut qb = sqlx::QueryBuilder::new("SELECT u.email FROM users u");
    push_selection(&mut qb, sel)?;
    qb.push(" ORDER BY u.created_at, u.id LIMIT 10");
    let sample: Vec<String> = qb.build_query_scalar().fetch_all(conn).await?;
    Ok(Preview {
        total,
        admins,
        sample,
    })
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow, Debug, Clone)]
pub struct JobView {
    pub id: Uuid,
    pub actor_label: String,
    pub action: String,
    pub params: Value,
    pub selection: String,
    pub filter: Option<Value>,
    pub status: String,
    pub total: i32,
    pub done: i32,
    pub failed: i32,
    pub skipped: i32,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

const JOB_COLS: &str = "id, actor_label, action, params, selection, filter, status, total, done, \
     failed, skipped, last_error, created_at, started_at, finished_at";

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct ItemView {
    pub user_id: Uuid,
    /// Q4: snapshot label; `user_email` = the current address (null once
    /// the account is gone).
    pub user_label: String,
    pub user_email: Option<String>,
    pub status: String,
    pub detail: Option<String>,
    pub updated_at: DateTime<Utc>,
}

/// Create the job and snapshot its targets (one transaction, audited
/// `user.batch.create`). Returns the job.
pub async fn apply_create(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &CreateReq,
) -> Result<JobView, ApiError> {
    check_action(&req.action)?;
    match &req.action {
        Action::SetPlan { plan_id, .. } => {
            let enabled: Option<bool> =
                sqlx::query_scalar("SELECT enabled FROM plans WHERE id = $1")
                    .bind(plan_id)
                    .fetch_optional(&mut *conn)
                    .await?;
            match enabled {
                None => return Err(bad_request!("plan.unknown", "unknown plan id")),
                Some(false) => {
                    return Err(conflict!("plan.disabled", "plan is disabled (not offered)"));
                }
                Some(true) => {}
            }
        }
        Action::SendEmail { .. } if !crate::mailhook::available(conn).await? => {
            return Err(conflict!(
                "batch.mail_unavailable",
                "email is not configured or disabled (系统设置 → 邮件)"
            ));
        }
        _ => {}
    }
    let id = Uuid::new_v4();
    let mut qb = sqlx::QueryBuilder::new(
        "INSERT INTO admin_batch_items (job_id, user_id, user_label) SELECT ",
    );
    qb.push_bind(id)
        .push(", u.id, ")
        .push(crate::audit::user_label_sql("u.id"))
        .push(" FROM users u");
    let selection = push_selection(&mut qb, &req.selection)?;
    // The job row first (the items reference it); the total is the number
    // of snapshotted items.
    sqlx::query(
        "INSERT INTO admin_batch_jobs (id, actor_id, actor_label, action, params, selection, \
         filter, total) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)",
    )
    .bind(id)
    .bind(actor.id)
    .bind(&actor.label)
    .bind(req.action.kind())
    .bind(req.action.params())
    .bind(selection)
    .bind(
        req.selection
            .filter
            .as_ref()
            .map(|f| serde_json::to_value(f).unwrap_or(Value::Null)),
    )
    .execute(&mut *conn)
    .await?;
    let n = qb.build().execute(&mut *conn).await?.rows_affected();
    if n == 0 {
        return Err(bad_request!("batch.empty", "no users selected"));
    }
    let job: JobView = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE admin_batch_jobs SET total = $2 WHERE id = $1 RETURNING {JOB_COLS}"
    )))
    .bind(id)
    .bind(n as i32)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "user.batch.create",
        "batch",
        Some(id.to_string()),
        None,
        Some(json!({
            "action": job.action,
            "params": redact_params(&job.params),
            "selection": job.selection,
            "filter": job.filter,
            "total": job.total,
        })),
    )
    .await?;
    Ok(job)
}

/// Mail bodies are not audit material (only the subject is kept).
fn redact_params(p: &Value) -> Value {
    let mut v = p.clone();
    if let Value::Object(m) = &mut v
        && m.contains_key("body")
    {
        m.insert("body".into(), json!(crate::audit::CHANGED));
    }
    v
}

/// Cancel a pending/running job: the runner stops after its current chunk;
/// still-pending items are marked skipped. Audited `user.batch.cancel`.
pub async fn apply_cancel(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<JobView, ApiError> {
    let exists: Option<String> =
        sqlx::query_scalar("SELECT status FROM admin_batch_jobs WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some(status) = exists else {
        return Err(ApiError::not_found());
    };
    if !matches!(status.as_str(), "pending" | "running") {
        return Err(conflict!(
            "batch.finished",
            "the batch has already finished ({status})",
            status = status
        ));
    }
    let skipped = sqlx::query(
        "UPDATE admin_batch_items SET status = 'skipped', detail = '已取消', updated_at = now() \
         WHERE job_id = $1 AND status = 'pending'",
    )
    .bind(id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    let job: JobView = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE admin_batch_jobs SET status = 'cancelled', finished_at = now(), \
         skipped = skipped + $2 WHERE id = $1 RETURNING {JOB_COLS}"
    )))
    .bind(id)
    .bind(skipped as i32)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "user.batch.cancel",
        "batch",
        Some(id.to_string()),
        Some(json!({ "status": status })),
        Some(json!({ "status": "cancelled", "skipped": skipped })),
    )
    .await?;
    Ok(job)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/// Background runner (every instance): claims and works jobs.
pub async fn run_loop(state: AppState) {
    let mut tick = tokio::time::interval(EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        run_available(&state).await;
    }
}

/// Work every claimable job once (until none is left or one pauses).
pub async fn run_available(state: &AppState) {
    loop {
        match run_one(state).await {
            Ok(Ran::Nothing) | Ok(Ran::Paused) => return,
            Ok(Ran::Finished) => {}
            Err(e) => {
                tracing::warn!(error = %e, "batch job runner failed");
                return;
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Ran {
    Nothing,
    /// A job was worked to its end (done or cancelled).
    Finished,
    /// A job stopped early (mail rate limit, lost claim, chunk error).
    Paused,
}

#[derive(sqlx::FromRow)]
struct Claimed {
    id: Uuid,
    actor_id: Option<Uuid>,
    actor_label: String,
    action: String,
    params: Value,
    claim_token: Uuid,
}

/// Claim one job and run its chunks.
pub async fn run_one(state: &AppState) -> anyhow::Result<Ran> {
    let claimed: Option<Claimed> = sqlx::query_as(
        "UPDATE admin_batch_jobs SET status = 'running', started_at = COALESCE(started_at, now()), \
         claimed_until = now() + make_interval(secs => $1), claim_token = gen_random_uuid() \
         WHERE id = (SELECT id FROM admin_batch_jobs WHERE status IN ('pending', 'running') \
                     AND (claimed_until IS NULL OR claimed_until < now()) \
                     ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) \
         RETURNING id, actor_id, actor_label, action, params, claim_token",
    )
    .bind(LEASE_SECS as f64)
    .fetch_optional(state.pg())
    .await?;
    let Some(job) = claimed else {
        return Ok(Ran::Nothing);
    };
    let action = Action::from_row(&job.action, &job.params)
        .map_err(|e| anyhow::anyhow!(e.message().to_string()))?;
    let actor = Actor {
        id: job.actor_id,
        label: job.actor_label.clone(),
        ip: None,
    };
    loop {
        match chunk(state, &job, &actor, &action).await {
            Ok(Chunk::Finished) => return Ok(Ran::Finished),
            Ok(Chunk::More) => {}
            Ok(Chunk::Paused) => {
                release(state, &job).await?;
                return Ok(Ran::Paused);
            }
            Err(e) => {
                let msg = e.to_string().chars().take(300).collect::<String>();
                tracing::warn!(job = %job.id, error = %msg, "batch chunk failed; will retry");
                sqlx::query(
                    "UPDATE admin_batch_jobs SET last_error = $2, claimed_until = now() + \
                     interval '15 seconds' WHERE id = $1 AND claim_token = $3",
                )
                .bind(job.id)
                .bind(&msg)
                .bind(job.claim_token)
                .execute(state.pg())
                .await?;
                return Ok(Ran::Paused);
            }
        }
    }
}

/// Give the claim back early (the job continues on the next tick).
async fn release(state: &AppState, job: &Claimed) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE admin_batch_jobs SET claimed_until = now() + interval '5 seconds' \
         WHERE id = $1 AND claim_token = $2",
    )
    .bind(job.id)
    .bind(job.claim_token)
    .execute(state.pg())
    .await?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum Chunk {
    More,
    Finished,
    Paused,
}

/// The per-user result inside a chunk.
enum Step {
    Done,
    /// Nothing to do for this user (Chinese reason, shown as is).
    Skipped(String),
    /// The apply refused (the error code; the console maps it).
    Failed(ApiError),
}

/// One chunk = one transaction.
async fn chunk(
    state: &AppState,
    job: &Claimed,
    actor: &Actor,
    action: &Action,
) -> anyhow::Result<Chunk> {
    let mut tx = state.pg().begin().await?;
    // Still ours and still wanted? (A cancel marks the items skipped; the
    // refresh keeps the lease alive for the chunk.)
    let status: Option<String> = sqlx::query_scalar(
        "UPDATE admin_batch_jobs SET claimed_until = now() + make_interval(secs => $2) \
         WHERE id = $1 AND claim_token = $3 RETURNING status",
    )
    .bind(job.id)
    .bind(LEASE_SECS as f64)
    .bind(job.claim_token)
    .fetch_optional(&mut *tx)
    .await?;
    match status.as_deref() {
        Some("running") => {}
        Some(_) => {
            tx.commit().await?;
            return Ok(Chunk::Finished);
        }
        None => return Ok(Chunk::Paused),
    }
    let items: Vec<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM admin_batch_items WHERE job_id = $1 \
         AND status = 'pending' ORDER BY user_id LIMIT $2 FOR UPDATE",
    )
    .bind(job.id)
    .bind(action.chunk())
    .fetch_all(&mut *tx)
    .await?;
    if items.is_empty() {
        sqlx::query(
            "UPDATE admin_batch_jobs SET status = 'done', finished_at = now() \
             WHERE id = $1 AND status = 'running'",
        )
        .bind(job.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Chunk::Finished);
    }
    let (mut done, mut failed, mut skipped) = (0i32, 0i32, 0i32);
    let mut paused = false;
    for user in &items {
        if matches!(action, Action::SendEmail { .. }) && !mail_slot(state, &mut tx).await {
            paused = true;
            break;
        }
        let mut sp = (*tx).begin().await?;
        let step = match apply_one(&mut sp, state, actor, action, *user).await {
            Ok(step) => step,
            Err(e) if e.status().is_server_error() => {
                return Err(anyhow::anyhow!(e.message().to_string()));
            }
            Err(e) => Step::Failed(e),
        };
        let (status, detail) = match &step {
            Step::Done => {
                sp.commit().await?;
                done += 1;
                ("done", None)
            }
            Step::Skipped(why) => {
                sp.commit().await?;
                skipped += 1;
                ("skipped", Some(why.clone()))
            }
            Step::Failed(e) => {
                sp.rollback().await?;
                failed += 1;
                ("failed", Some(e.code().to_string()))
            }
        };
        sqlx::query(
            "UPDATE admin_batch_items SET status = $3, detail = $4, updated_at = now() \
             WHERE job_id = $1 AND user_id = $2",
        )
        .bind(job.id)
        .bind(user)
        .bind(status)
        .bind(detail)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE admin_batch_jobs SET done = done + $2, failed = failed + $3, \
         skipped = skipped + $4 WHERE id = $1",
    )
    .bind(job.id)
    .bind(done)
    .bind(failed)
    .bind(skipped)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(if paused { Chunk::Paused } else { Chunk::More })
}

/// One mail may go out now: a fleet-wide window in Valkey (per database
/// schema, so test schemas never share it). Fails closed: without Valkey
/// the job pauses and resumes later (items stay pending).
async fn mail_slot(state: &AppState, conn: &mut PgConnection) -> bool {
    let schema: String = match sqlx::query_scalar("SELECT current_schema()::text")
        .fetch_one(conn)
        .await
    {
        Ok(s) => s,
        Err(_) => return false,
    };
    crate::rate::hit(
        state,
        format!("{MAIL_RATE_KEY}:{schema}"),
        MAIL_RATE,
        MAIL_WINDOW_SECS,
    )
    .await
    .unwrap_or(false)
}

/// The placeholder a batch mail may carry (D11): each recipient's own
/// subscription link.
pub const SUB_URL: &str = "{sub_url}";

/// The user's subscription link as the portal shows it (issued if the
/// account has none yet), or None when it cannot be shown.
async fn sub_url_of(
    conn: &mut PgConnection,
    state: &AppState,
    actor: &Actor,
    user: Uuid,
) -> Result<Option<String>, ApiError> {
    let stored = crate::sub::ensure_token(conn, state.master_key(), actor, user).await?;
    let Some(crate::sub::Stored::Ready(token)) = stored else {
        return Ok(None);
    };
    Ok(state.sub_url(user, &token))
}

/// Apply the action to one user (inside the chunk's savepoint). Business
/// refusals are `Err(ApiError)` (4xx) and become `failed`; internal errors
/// (5xx) abort the chunk.
async fn apply_one(
    conn: &mut PgConnection,
    state: &AppState,
    actor: &Actor,
    action: &Action,
    user: Uuid,
) -> Result<Step, ApiError> {
    type Row = (String, Option<String>, Option<String>, bool);
    let row: Option<Row> = sqlx::query_as(
        "SELECT u.role, u.disabled_reason, up.term_kind, up.expires_at IS NOT NULL \
         FROM users u LEFT JOIN user_plans up ON up.user_id = u.id AND up.status = 'active' \
         WHERE u.id = $1",
    )
    .bind(user)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((role, disabled_reason, term_kind, has_expiry)) = row else {
        return Ok(Step::Skipped("用户已删除".into()));
    };
    if role != "user" {
        return Ok(Step::Skipped("管理员账户".into()));
    }
    let has_plan = term_kind.is_some();
    let banned = disabled_reason.as_deref() == Some("admin");
    match action {
        Action::ExtendExpiry { days } => {
            if !has_plan {
                return Ok(Step::Skipped("无生效套餐".into()));
            }
            if term_kind.as_deref() == Some("onetime") {
                return Ok(Step::Skipped("一次性套餐不能延长天数".into()));
            }
            if !has_expiry {
                return Ok(Step::Skipped("无到期时间".into()));
            }
            plans::apply_renew_user_plan(conn, actor, user, plans::Renewal::extend(*days)?).await?;
        }
        Action::ResetTraffic {} => {
            if !has_plan {
                return Ok(Step::Skipped("无生效套餐".into()));
            }
            plans::apply_admin_reset_traffic(conn, actor, user).await?;
        }
        Action::Ban { reason } => {
            api::apply_ban_user(conn, actor, user, reason).await?;
        }
        Action::Unban {} => {
            if !banned {
                return Ok(Step::Skipped("未封禁".into()));
            }
            api::apply_unban_user(conn, actor, user).await?;
        }
        Action::SetPlan {
            plan_id,
            period,
            days,
        } => {
            let assign = plans::AssignPlanReq {
                plan_id: *plan_id,
                period: *period,
                days: *days,
            }
            .assignment()?;
            plans::apply_set_user_plan(conn, actor, user, &assign).await?;
        }
        Action::CancelPlan {} => {
            if !has_plan {
                return Ok(Step::Skipped("无生效套餐".into()));
            }
            plans::apply_cancel_user_plan(conn, actor, user).await?;
        }
        Action::AddBalance {
            amount_cents,
            reason,
        } => {
            ledger::apply_adjust(
                conn,
                actor,
                user,
                &ledger::AdjustReq {
                    amount_cents: *amount_cents,
                    reason: reason.clone(),
                },
            )
            .await?;
        }
        Action::SendEmail { subject, body } => {
            let smtp = crate::mail::load(&mut *conn).await?;
            if !(smtp.enabled && smtp.complete()) {
                return Err(conflict!(
                    "batch.mail_unavailable",
                    "email is not configured or disabled (系统设置 → 邮件)"
                ));
            }
            let to: Option<(String, String)> = sqlx::query_as(
                "SELECT email, locale FROM users WHERE id = $1 AND email IS NOT NULL \
                 AND email_verified_at IS NOT NULL",
            )
            .bind(user)
            .fetch_optional(&mut *conn)
            .await?;
            let Some((email, locale)) = to else {
                return Ok(Step::Skipped("无已验证邮箱".into()));
            };
            // D11: `{sub_url}` = the recipient's own subscription link (a
            // link that cannot be shown — pre-0120 or unreadable — skips).
            // The audit keeps the template (a link is a credential).
            let (mut subject, mut body) = (subject.trim().to_string(), body.trim().to_string());
            let audit_subject = subject.clone();
            if subject.contains(SUB_URL) || body.contains(SUB_URL) {
                let Some(url) = sub_url_of(conn, state, actor, user).await? else {
                    return Ok(Step::Skipped("订阅链接无法显示（需重置）".into()));
                };
                subject = subject.replace(SUB_URL, &url);
                body = body.replace(SUB_URL, &url);
            }
            let tpl = Template::AdminNotice { subject, body };
            let mail_id = crate::mail::enqueue(
                conn,
                &smtp,
                &tpl,
                Locale::parse(&locale),
                &email,
                Some(user),
                None,
            )
            .await?;
            crate::audit::record(
                conn,
                actor,
                "user.mail.send",
                "user",
                Some(user.to_string()),
                None,
                Some(json!({ "subject": audit_subject, "mail_id": mail_id })),
            )
            .await?;
        }
    }
    Ok(Step::Done)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// POST /users/batch/preview {selection}: how many users (and admins) the
/// selection targets, with a sample.
pub async fn preview(
    State(state): State<AppState>,
    user: AuthUser,
    api::ApiJson(req): api::ApiJson<PreviewReq>,
) -> Result<Json<Preview>, ApiError> {
    user.require_admin()?;
    let mut c = state.pg().acquire().await?;
    Ok(Json(preview_selection(&mut c, &req.selection).await?))
}

/// POST /users/batch {selection, action} → 202 + the job. The job starts
/// at once on this instance (and on any instance's next tick).
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    api::ApiJson(req): api::ApiJson<CreateReq>,
) -> Result<(StatusCode, Json<JobView>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let job = apply_create(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    let st = state.clone();
    tokio::spawn(async move { run_available(&st).await });
    Ok((StatusCode::ACCEPTED, Json(job)))
}

/// GET /users/batch: the 50 most recent jobs.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<JobView>>, ApiError> {
    user.require_admin()?;
    let rows: Vec<JobView> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {JOB_COLS} FROM admin_batch_jobs ORDER BY created_at DESC, id LIMIT 50"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// GET /users/batch/{id}: the job and its items (failed and skipped first,
/// at most 500).
pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let job: JobView = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {JOB_COLS} FROM admin_batch_jobs WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(state.pg())
    .await?
    .ok_or_else(ApiError::not_found)?;
    let items: Vec<ItemView> = sqlx::query_as(
        "SELECT i.user_id, i.user_label, u.email AS user_email, i.status, i.detail, i.updated_at \
         FROM admin_batch_items i LEFT JOIN users u ON u.id = i.user_id \
         WHERE i.job_id = $1 ORDER BY (i.status IN ('failed', 'skipped')) DESC, i.status, i.user_label \
         LIMIT $2",
    )
    .bind(id)
    .bind(DETAIL_ITEMS)
    .fetch_all(state.pg())
    .await?;
    Ok(Json(json!({ "job": job, "items": items })))
}

/// POST /users/batch/{id}/cancel.
pub async fn cancel(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<JobView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let job = apply_cancel(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(Json(job))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get as g, post};
    axum::Router::new()
        .route("/{prefix}/api/v1/users/batch", g(list).post(create))
        .route("/{prefix}/api/v1/users/batch/preview", post(preview))
        .route("/{prefix}/api/v1/users/batch/{id}", g(get))
        .route("/{prefix}/api/v1/users/batch/{id}/cancel", post(cancel))
}

#[cfg(test)]
mod tests;
