//! Account erasure (W27 self-service deletion; D10 never-used account
//! cleanup — one routine, migration 1016).
//!
//! `apply_erase` deletes a role=user account outright when it has no finance
//! records (orders, balance ledger rows, commissions as inviter or invitee,
//! withdrawals): `api::apply_delete_user` (access revoked, nodes bumped,
//! everything personal cascades). With finance records the account row
//! stays so the money's history keeps its account, but everything personal
//! goes: the address becomes `erased-<id>@erased.invalid` (unverified), the
//! password an unusable random hash, the subscription token, passkeys,
//! invite codes, email codes, reset links, notices, announcement reads,
//! tickets, queued mail and traffic history are deleted, the active plan is
//! cancelled (node access revoked in the same transaction) and the account
//! disabled for good (`erased_at`; disabled like a ban without a note, and
//! every reader of a ban excludes erased accounts; every session ends).
//! Both paths are audited `user.erase` (`anonymized`, `why`).
//!
//! Self-service (`GET /me/delete-impact`, `POST /me/delete`): role=user,
//! not banned; the holder confirms with the current password or a passkey
//! (a passkey-only account: a passkey); refused while orders or withdrawals are pending (cancel
//! them first: their money would otherwise be stranded).

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{self, ApiError, bad_request, conflict};
use crate::state::AppState;

/// Why an account is erased (audit).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// The account holder (`POST /me/delete`).
    SelfService,
    /// D10: never used (`cleanup.rs`, the automatic cleanup).
    NeverUsed,
    /// D10: the console's bulk deletion (`cleanup.rs`).
    Bulk,
}

impl Why {
    fn as_str(self) -> &'static str {
        match self {
            Why::SelfService => "self_service",
            Why::NeverUsed => "never_used",
            Why::Bulk => "bulk",
        }
    }
}

/// What happened to the account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Erased {
    Deleted,
    Anonymized,
}

/// SQL (alias `u`): the account has finance records.
pub const HAS_FINANCE: &str = "(EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id) \
     OR EXISTS (SELECT 1 FROM balance_ledger l WHERE l.user_id = u.id) \
     OR EXISTS (SELECT 1 FROM commissions c WHERE c.inviter_id = u.id OR c.invitee_id = u.id) \
     OR EXISTS (SELECT 1 FROM withdrawals w WHERE w.user_id = u.id))";

/// Personal rows of an anonymized account (every one keyed by `user_id`).
const PERSONAL_TABLES: &[&str] = &[
    "webauthn_credentials",
    "invite_codes",
    "email_codes",
    "password_resets",
    "user_notices",
    "announcement_reads",
    "tickets",
    "mail_outbox",
    "traffic_daily_pending",
    "traffic_daily",
    "traffic_monthly",
];

/// Erase `id` (role=user) in the caller's transaction. None = no such
/// account. Admin accounts are refused (an admin is demoted first).
pub async fn apply_erase(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    why: Why,
) -> Result<Option<Erased>, ApiError> {
    let row: Option<(String, bool, bool)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT u.role, u.erased_at IS NOT NULL, {HAS_FINANCE} FROM users u WHERE u.id = $1"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((role, erased, finance)) = row else {
        return Ok(None);
    };
    if role != "user" {
        return Err(bad_request!(
            "user.erase_admin",
            "admin accounts are not erased: demote the account first"
        ));
    }
    if erased {
        return Err(conflict!("user.erased", "the account was deleted"));
    }
    if !finance {
        crate::api::apply_delete_user(conn, actor, id).await?;
        record(conn, actor, id, why, Erased::Deleted).await?;
        return Ok(Some(Erased::Deleted));
    }
    // Access first (lock order: entitlement, then servers, then the user):
    // the active plan ends and every credential goes, departed rows keep
    // the final counts billable.
    crate::entitle::lock(conn).await?;
    sqlx::query(
        "UPDATE user_plans SET status = 'cancelled', ended_at = now() \
         WHERE user_id = $1 AND status = 'active'",
    )
    .bind(id)
    .execute(&mut *conn)
    .await?;
    crate::entitle::apply_reconcile(conn, crate::entitle::Scope::Users(&[id])).await?;
    for t in PERSONAL_TABLES {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {t} WHERE user_id = $1"
        )))
        .bind(id)
        .execute(&mut *conn)
        .await?;
    }
    // An argon2 hash nobody knows the password of: the uniform login
    // failure, with the same work as any other account.
    let unusable = auth::hash_password_async(&crate::sub::generate_token()).await?;
    sqlx::query(
        "UPDATE users SET email = 'erased-' || replace(id::text, '-', '') || '@erased.invalid', \
             email_verified_at = NULL, password_hash = $2, password_login_disabled_at = NULL, \
             sub_token_hash = NULL, sub_token_enc = NULL, locale = 'zh', \
             enabled = false, disabled_reason = 'admin', disabled_note = NULL, \
             disabled_by = NULL, erased_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(&unusable)
    .execute(&mut *conn)
    .await?;
    record(conn, actor, id, why, Erased::Anonymized).await?;
    Ok(Some(Erased::Anonymized))
}

async fn record(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    why: Why,
    what: Erased,
) -> Result<(), ApiError> {
    crate::audit::record(
        conn,
        actor,
        "user.erase",
        "user",
        Some(id.to_string()),
        None,
        Some(json!({
            "anonymized": what == Erased::Anonymized,
            "why": why.as_str(),
        })),
    )
    .await?;
    Ok(())
}

/// What deleting `id` loses (the console's and the portal's confirmation):
/// balance (and its withdrawable part), pending withdrawals and orders,
/// paid orders not fulfilled, the active plan, the invite rebate still
/// frozen and the accounts invited, and whether the account is
/// kept anonymized (finance records). None = no such account.
pub async fn impact(conn: &mut PgConnection, id: Uuid) -> Result<Option<Value>, ApiError> {
    type Row = (String, i64, i64, i64, i64, i64, bool);
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT u.email, COALESCE((SELECT balance_cents FROM user_balances WHERE user_id = u.id), 0), \
           (SELECT count(*) FROM withdrawals WHERE user_id = u.id AND status = 'pending'), \
           COALESCE((SELECT sum(amount_cents) FROM withdrawals \
                     WHERE user_id = u.id AND status = 'pending'), 0)::bigint, \
           (SELECT count(*) FROM orders WHERE user_id = u.id AND status = 'pending'), \
           (SELECT count(*) FROM orders WHERE user_id = u.id AND status = 'paid' \
            AND fulfilled_at IS NULL AND refunded_at IS NULL), \
           {HAS_FINANCE} \
         FROM users u WHERE u.id = $1"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((email, balance, wd, wd_cents, pending, unfulfilled, finance)) = row else {
        return Ok(None);
    };
    let withdrawable = crate::billing::ledger::withdrawable(conn, id).await?;
    // The invite rebate: still frozen (lost with the account) and the
    // accounts this one invited (their future orders earn nothing more).
    let (rebate_pending, rebate_count, invitees): (i64, i64, i64) = sqlx::query_as(
        "SELECT COALESCE((SELECT sum(amount_cents) FROM commissions \
                          WHERE inviter_id = $1 AND status = 'pending'), 0)::bigint, \
                (SELECT count(*) FROM commissions WHERE inviter_id = $1 AND status = 'pending'), \
                (SELECT count(*) FROM users WHERE inviter_id = $1 AND erased_at IS NULL)",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    let plan: Option<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT p.name, up.expires_at FROM user_plans up JOIN plans p ON p.id = up.plan_id \
         WHERE up.user_id = $1 AND up.status = 'active'",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(Some(json!({
        "email": email,
        "balance_cents": balance,
        "withdrawable_cents": withdrawable,
        "pending_withdrawals": wd,
        "pending_withdrawal_cents": wd_cents,
        "pending_orders": pending,
        "unfulfilled_orders": unfulfilled,
        "plan": plan.map(|(name, expires_at)| json!({ "name": name, "expires_at": expires_at })),
        "pending_commission_cents": rebate_pending,
        "pending_commissions": rebate_count,
        "invitees": invitees,
        "anonymized": finance,
    })))
}

fn self_only(user: &auth::AuthUser) -> Result<(), ApiError> {
    if user.role != "user" {
        return Err(ApiError::forbidden());
    }
    Ok(())
}

/// GET /api/v1/me/delete-impact (role=user, renewal scope): as the
/// console's `GET /users/{id}/delete-impact`.
pub async fn my_impact(
    State(state): State<AppState>,
    auth::ShopUser { user, .. }: auth::ShopUser,
) -> Result<Json<Value>, ApiError> {
    self_only(&user)?;
    let mut c = state.pg().acquire().await?;
    impact(&mut c, user.id)
        .await?
        .map(Json)
        .ok_or_else(ApiError::unauthorized)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteReq {
    pub confirm: bool,
    /// The current password, unless a passkey confirms the holder.
    #[serde(default)]
    pub password: Option<String>,
    /// A passkey assertion (`POST /me/reauth/options`); required for an
    /// account that signs in with passkeys only.
    #[serde(default)]
    pub passkey: Option<crate::passkey::PasskeyProof>,
}

/// POST /api/v1/me/delete `{confirm: true, password? | passkey?}`
/// (role=user, renewal scope, not banned): erase the own account; the
/// session cookie is cleared. 204. The holder is confirmed by
/// `passkey::confirm_holder`: a wrong password = 400
/// `account.invalid_password` (counts against the login rate limit), a
/// passkey-only account without a passkey proof = 400
/// `account.passkey_confirm_required`; pending orders or withdrawals = 409.
pub async fn delete_me(
    State(state): State<AppState>,
    auth::ShopUser { user, .. }: auth::ShopUser,
    jar: CookieJar,
    ApiJson(req): ApiJson<DeleteReq>,
) -> Result<Response, ApiError> {
    self_only(&user)?;
    if !req.confirm {
        return Err(bad_request!(
            "account.delete_confirm_required",
            "deleting the account needs confirm=true"
        ));
    }
    crate::passkey::confirm_holder(&state, &user, req.password.as_deref(), req.passkey.as_ref())
        .await?;
    let mut tx = state.pg().begin().await?;
    let (orders, withdrawals): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM orders WHERE user_id = $1 AND status = 'pending'), \
                (SELECT count(*) FROM withdrawals WHERE user_id = $1 AND status = 'pending')",
    )
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;
    if orders > 0 {
        return Err(conflict!(
            "account.delete_pending_orders",
            "cancel the pending order first"
        ));
    }
    if withdrawals > 0 {
        return Err(conflict!(
            "account.delete_pending_withdrawals",
            "cancel the pending withdrawal first"
        ));
    }
    apply_erase(&mut tx, &Actor::of(&user), user.id, Why::SelfService)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    tx.commit().await?;
    Ok((
        jar.add(auth::cleared_cookie(&state)),
        axum::http::StatusCode::NO_CONTENT,
    )
        .into_response())
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/{prefix}/api/v1/me/delete-impact", get(my_impact))
        .route("/{prefix}/api/v1/me/delete", post(delete_me))
}

#[cfg(test)]
mod tests;
