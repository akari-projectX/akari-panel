//! Invite codes (W15; one per user since 2026-10-14) and the invite
//! attribution of registration.
//!
//! **Hook for W16 (commission):** the registration transaction
//! (`register::apply_register`) consumes the code with `consume` and writes
//! the code owner into the new account's `users.inviter_id` (set once,
//! never changed by any API; `ON DELETE SET NULL`). Commission/balance code
//! reads `users.inviter_id` of the paying user — nothing else here needs to
//! change. `invite_codes.uses` counts registrations per code.
//!
//! Codes: 10 characters of `[a-z2-9]` (no 0/1, ~50 bits). Only role=user
//! accounts have codes. **Exactly one code per account** (PLAN-next
//! "门户下一批"; unique index `invite_codes_user`):
//! created automatically by `GET /me/invite-codes` while registration is
//! open and user invites are allowed (or explicitly by `POST`, which refuses
//! a second one with `invite.exists`); the user can neither delete nor
//! regenerate it (there is no delete endpoint).
//! Multi-use unless `invite_single_use` (then a code admits one
//! registration: `uses = 0` checked in the consuming UPDATE, race-safe — so
//! each account invites at most one person).
//!
//! **允许用户邀请** (`signup_settings.user_invites`, default on): off, no
//! code is created or shown, and no code admits a registration (`usable` /
//! `consume` answer as for an unknown code). Codes are kept and work again
//! when the switch is turned back on.

use crate::auth::conflict;
use axum::Json;
use axum::extract::State;
use chrono::{DateTime, Utc};
use rand::RngExt;
use serde::Serialize;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

use super::SignupSettings;

const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
pub const CODE_LEN: usize = 10;

pub fn new_code() -> String {
    let mut r = rand::rng();
    (0..CODE_LEN)
        .map(|_| ALPHABET[r.random_range(0..ALPHABET.len())] as char)
        .collect()
}

/// The shape the table accepts (lower case already applied).
pub fn plausible(code: &str) -> bool {
    (8..=32).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'9').contains(&b))
}

/// Whether `code` would admit a registration now (pre-check of the code
/// request; `consume` is authoritative).
pub async fn usable(conn: &mut PgConnection, code: &str, s: &SignupSettings) -> sqlx::Result<bool> {
    if !s.user_invites || !plausible(code) {
        return Ok(false);
    }
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM invite_codes c JOIN users u ON u.id = c.user_id \
         WHERE c.code = $1 AND (NOT $2 OR c.uses = 0))",
    )
    .bind(code)
    .bind(s.invite_single_use)
    .fetch_one(conn)
    .await
}

/// Count one registration on `code`; returns its owner (the inviter), or
/// None if the code does not exist, (single use) was used, or user invites
/// are off.
pub async fn consume(
    conn: &mut PgConnection,
    code: &str,
    s: &SignupSettings,
) -> sqlx::Result<Option<Uuid>> {
    if !s.user_invites || !plausible(code) {
        return Ok(None);
    }
    sqlx::query_scalar(
        "UPDATE invite_codes SET uses = uses + 1 WHERE code = $1 AND (NOT $2 OR uses = 0) \
         RETURNING user_id",
    )
    .bind(code)
    .bind(s.invite_single_use)
    .fetch_optional(conn)
    .await
}

#[derive(Serialize, sqlx::FromRow)]
pub struct CodeView {
    code: String,
    uses: i32,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct MyCodeView {
    /// The account's invite code (None while user invites are off, or while
    /// registration is closed and no code was made yet).
    code: Option<CodeView>,
    register_enabled: bool,
    /// 允许用户邀请: off = no code, invites are closed.
    user_invites: bool,
    invite_required: bool,
    single_use: bool,
    /// Accounts this user invited.
    invited: i64,
    /// `<origin>/register?invite=` (the portal at `/`) when a main domain is set
    /// (else the portal uses its own origin).
    link_base: Option<String>,
}

fn require_user(user: &AuthUser) -> Result<(), ApiError> {
    if user.role == "user" {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

/// The account's code (one per account).
pub async fn mine(conn: &mut PgConnection, user: Uuid) -> sqlx::Result<Option<CodeView>> {
    sqlx::query_as("SELECT code, uses, created_at FROM invite_codes WHERE user_id = $1")
        .bind(user)
        .fetch_optional(conn)
        .await
}

/// GET /api/v1/me/invite-codes → the account's one code.
///
/// While registration is open and user invites are allowed, an account
/// without a code gets it here (audited `invite.create`); with user invites
/// off, no code is returned.
pub async fn list_codes(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<MyCodeView>, ApiError> {
    require_user(&user)?;
    let mut c = state.pg().begin().await?;
    let s = super::load_settings(&mut c).await?;
    if s.register_enabled && s.user_invites {
        apply_ensure(&mut c, &Actor::of(&user), user.id).await?;
    }
    let code = if s.user_invites {
        mine(&mut c, user.id).await?
    } else {
        None
    };
    let invited: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE inviter_id = $1")
        .bind(user.id)
        .fetch_one(&mut *c)
        .await?;
    c.commit().await?;
    Ok(Json(MyCodeView {
        code,
        register_enabled: s.register_enabled,
        user_invites: s.user_invites,
        invite_required: s.invite_required,
        single_use: s.invite_single_use,
        invited,
        link_base: crate::mail::portal_url(&state).map(|p| format!("{p}/register?invite=")),
    }))
}

async fn has_code(conn: &mut PgConnection, user: Uuid) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM invite_codes WHERE user_id = $1)")
        .bind(user)
        .fetch_one(conn)
        .await
}

/// Give `user` its invite code unless it already has one, in the caller's
/// transaction: Some(new code), or None when the account has a code. A
/// concurrent creation for the same account waits on the unique index
/// `invite_codes_user` and then does nothing.
pub async fn apply_ensure(
    conn: &mut PgConnection,
    actor: &Actor,
    user: Uuid,
) -> Result<Option<String>, ApiError> {
    // Fast path: almost every call finds the code.
    if has_code(conn, user).await? {
        return Ok(None);
    }
    // ~50-bit codes: a collision with another account's code is
    // astronomically rare; retry anyway.
    for _ in 0..3 {
        let code = new_code();
        let done: Option<String> = sqlx::query_scalar(
            "INSERT INTO invite_codes (code, user_id) VALUES ($1, $2) \
             ON CONFLICT DO NOTHING RETURNING code",
        )
        .bind(&code)
        .bind(user)
        .fetch_optional(&mut *conn)
        .await?;
        if done.is_some() {
            crate::audit::record(
                conn,
                actor,
                "invite.create",
                "user",
                Some(user.to_string()),
                None,
                Some(json!({ "code": code })),
            )
            .await?;
            return Ok(Some(code));
        }
        if has_code(conn, user).await? {
            return Ok(None);
        }
    }
    Err(ApiError::internal())
}

/// POST /api/v1/me/invite-codes → 201 {code}; an account that already has
/// its code → 409 `invite.exists` (one code per account, never replaced);
/// user invites off → 409 `invite.disabled`.
pub async fn create_code(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), ApiError> {
    require_user(&user)?;
    let mut tx = state.pg().begin().await?;
    let s = super::load_settings(&mut tx).await?;
    if !s.register_enabled {
        return Err(conflict!(
            "invite.registration_closed",
            "registration is closed"
        ));
    }
    if !s.user_invites {
        return Err(conflict!(
            "invite.disabled",
            "user invites are turned off on this site"
        ));
    }
    let Some(code) = apply_ensure(&mut tx, &Actor::of(&user), user.id).await? else {
        return Err(conflict!(
            "invite.exists",
            "you already have an invite code; it cannot be replaced"
        ));
    };
    tx.commit().await?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "code": code })),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_match_the_table_check() {
        for _ in 0..200 {
            let c = new_code();
            assert_eq!(c.len(), CODE_LEN);
            assert!(plausible(&c), "{c}");
            assert!(!c.contains('0') && !c.contains('1') && !c.contains('l') && !c.contains('o'));
        }
        assert!(!plausible("short"));
        assert!(!plausible("ABCDEFGHJK"));
        assert!(!plausible("abcdefgh0k"));
        assert!(!plausible(&"a".repeat(33)));
        assert!(plausible("abcdefgh"));
    }
}
