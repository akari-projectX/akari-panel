//! R47: the owner (super admin), migration 1013.
//!
//! One account — the first admin `akari admin add` creates (the
//! installer's) — is the owner (`users.is_owner`). Only the owner may:
//! change another admin account (role, password, ban, delete, sessions,
//! login method: any admin mutation whose target is an admin other than
//! the actor, `guard_target`) or make an account an admin; change the
//! admin prefix and its allowlist; write payment channels (their keys);
//! transfer the ownership (`apply_transfer`). The owner cannot be demoted,
//! disabled, banned or deleted (`protect`, and the database: CHECK
//! `users_owner_enabled_admin`, triggers `users_keep_owner` /
//! `users_owner_exists`); it hands the role to another enabled admin.
//! Command-line actions (actor without an account) are the server's
//! operator and pass every check (`akari admin set-owner` is the recovery).

use axum::extract::{Path, State};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser, api_error, bad_request, conflict};
use crate::state::AppState;

fn owner_only() -> ApiError {
    api_error!(
        FORBIDDEN,
        "user.owner_only",
        "only the owner may do this (admin accounts, admin prefix, payment keys)"
    )
}

/// The refusal for demoting, disabling, banning or deleting the owner.
pub fn protected() -> ApiError {
    conflict!(
        "user.owner_protected",
        "the owner cannot be demoted, banned or deleted; transfer the ownership first"
    )
}

/// Is `id` the owner?
pub async fn is_owner(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT is_owner FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(conn)
            .await?
            .unwrap_or(false),
    )
}

/// Owner-only actions: the actor must be the owner (an actor without an
/// account — CLI, system — passes).
pub async fn require(conn: &mut PgConnection, actor: &Actor) -> Result<(), ApiError> {
    match actor.id {
        None => Ok(()),
        Some(id) if is_owner(conn, id).await? => Ok(()),
        Some(_) => Err(owner_only()),
    }
}

/// An admin mutation on `target`: when the target is an admin account
/// other than the actor's own, only the owner may (a missing target
/// passes: the caller answers 404).
pub async fn guard_target(
    conn: &mut PgConnection,
    actor: &Actor,
    target: Uuid,
) -> Result<(), ApiError> {
    if actor.id == Some(target) {
        return Ok(());
    }
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE id = $1")
        .bind(target)
        .fetch_optional(&mut *conn)
        .await?;
    if role.as_deref() == Some("admin") {
        require(conn, actor).await?;
    }
    Ok(())
}

/// Refuse demoting, disabling, banning or deleting the owner (the database
/// refuses too; this gives the coded answer first).
pub async fn protect(conn: &mut PgConnection, target: Uuid) -> Result<(), ApiError> {
    if is_owner(conn, target).await? {
        return Err(protected());
    }
    Ok(())
}

/// Hand the ownership to `to` (an enabled admin other than the current
/// owner), audited `user.owner.transfer`. The actor must be the owner
/// (CLI: any). Returns the previous owner.
pub async fn apply_transfer(
    conn: &mut PgConnection,
    actor: &Actor,
    to: Uuid,
) -> Result<Option<Uuid>, ApiError> {
    require(conn, actor).await?;
    let target: Option<(String, bool, bool)> =
        sqlx::query_as("SELECT role, enabled, is_owner FROM users WHERE id = $1 FOR UPDATE")
            .bind(to)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((role, enabled, already)) = target else {
        return Err(ApiError::not_found());
    };
    if already {
        return Err(conflict!(
            "user.owner_already",
            "this account is already the owner"
        ));
    }
    if role != "admin" || !enabled {
        return Err(conflict!(
            "user.owner_target",
            "only an enabled admin can become the owner"
        ));
    }
    let previous: Option<Uuid> =
        sqlx::query_scalar("UPDATE users SET is_owner = false WHERE is_owner RETURNING id")
            .fetch_optional(&mut *conn)
            .await?;
    sqlx::query("UPDATE users SET is_owner = true WHERE id = $1")
        .bind(to)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "user.owner.transfer",
        "user",
        Some(to.to_string()),
        Some(json!({ "owner": previous.map(crate::audit::user_label) })),
        Some(json!({ "owner": crate::audit::user_label(to) })),
    )
    .await?;
    Ok(previous)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferReq {
    /// The console asked "are you sure" (the change is immediate).
    pub confirm: bool,
}

/// POST /users/{id}/owner `{confirm: true}` (owner): make `id` the owner.
/// 204; the caller stays an ordinary admin.
pub async fn transfer(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<TransferReq>,
) -> Result<axum::http::StatusCode, ApiError> {
    user.require_admin()?;
    if !req.confirm {
        return Err(bad_request!(
            "user.owner_confirm_required",
            "transferring the ownership needs confirm=true"
        ));
    }
    let mut tx = state.pg().begin().await?;
    apply_transfer(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// `akari admin set-owner <email>` (recovery, actor cli).
pub async fn cli_set_owner(pg: &sqlx::PgPool, email: &str) -> anyhow::Result<Option<Uuid>> {
    let email = email.trim().to_lowercase();
    let mut tx = pg.begin().await?;
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(id) = id else {
        anyhow::bail!("no account {email}");
    };
    let previous = apply_transfer(&mut tx, &Actor::cli(), id)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message()))?;
    tx.commit().await?;
    Ok(previous)
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new().route(
        "/{prefix}/api/v1/users/{id}/owner",
        axum::routing::post(transfer),
    )
}

#[cfg(test)]
mod tests;
