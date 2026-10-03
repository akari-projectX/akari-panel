//! Per-user invite codes (W15) and the invite attribution of registration.
//!
//! **Hook for W16 (commission):** the registration transaction
//! (`register::apply_register`) consumes the code with `consume` and writes
//! the code owner into the new account's `users.inviter_id` (set once,
//! never changed by any API; `ON DELETE SET NULL`). Commission/balance code
//! reads `users.inviter_id` of the paying user — nothing else here needs to
//! change. `invite_codes.uses` counts registrations per code.
//!
//! Codes: 10 characters of `[a-z2-9]` (no 0/1, ~50 bits), at most
//! `signup_settings.invite_codes_per_user` per account (creation serialised
//! per account with an advisory transaction lock). Only role=user accounts
//! have codes. Multi-use unless `invite_single_use` (then a code admits one
//! registration: `uses = 0` checked in the consuming UPDATE, race-safe).

use crate::auth::conflict;
use axum::Json;
use axum::extract::{Path, State};
use chrono::{DateTime, Utc};
use rand::Rng;
use serde::Serialize;
use serde_json::json;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

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
pub async fn usable(conn: &mut PgConnection, code: &str, single_use: bool) -> sqlx::Result<bool> {
    if !plausible(code) {
        return Ok(false);
    }
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM invite_codes c JOIN users u ON u.id = c.user_id \
         WHERE c.code = $1 AND (NOT $2 OR c.uses = 0))",
    )
    .bind(code)
    .bind(single_use)
    .fetch_one(conn)
    .await
}

/// Count one registration on `code`; returns its owner (the inviter), or
/// None if the code does not exist or (single use) was used.
pub async fn consume(
    conn: &mut PgConnection,
    code: &str,
    single_use: bool,
) -> sqlx::Result<Option<Uuid>> {
    if !plausible(code) {
        return Ok(None);
    }
    sqlx::query_scalar(
        "UPDATE invite_codes SET uses = uses + 1 WHERE code = $1 AND (NOT $2 OR uses = 0) \
         RETURNING user_id",
    )
    .bind(code)
    .bind(single_use)
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
pub struct CodesView {
    codes: Vec<CodeView>,
    limit: i32,
    register_enabled: bool,
    invite_required: bool,
    single_use: bool,
    /// Accounts this user invited.
    invited: i64,
    /// `<origin>/<prefix>/app/register?invite=` when a main domain is set
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

/// GET /api/v1/me/invite-codes
///
/// W20 (Minor 6): while registration is open, an account's first code is
/// created here automatically — once per account (`users.invite_autocreated`,
/// 0120, flipped in the same transaction; audited `invite.create` like a
/// manual one). An account that already has codes only gets the flag set;
/// one that deleted its codes does not get them back.
pub async fn list_codes(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<CodesView>, ApiError> {
    require_user(&user)?;
    let mut c = state.pg().begin().await?;
    let s = super::load_settings(&mut c).await?;
    if s.register_enabled && s.invite_codes_per_user > 0 {
        ensure_first(&mut c, &Actor::of(&user), user.id, s.invite_codes_per_user).await?;
    }
    let codes = sqlx::query_as::<_, CodeView>(
        "SELECT code, uses, created_at FROM invite_codes WHERE user_id = $1 \
         ORDER BY created_at, code",
    )
    .bind(user.id)
    .fetch_all(&mut *c)
    .await?;
    let invited: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE inviter_id = $1")
        .bind(user.id)
        .fetch_one(&mut *c)
        .await?;
    c.commit().await?;
    Ok(Json(CodesView {
        codes,
        limit: s.invite_codes_per_user,
        register_enabled: s.register_enabled,
        invite_required: s.invite_required,
        single_use: s.invite_single_use,
        invited,
        link_base: crate::mail::portal_url(&state).map(|p| format!("{p}/register?invite=")),
    }))
}

/// W20: the once-per-account automatic first code (see `list_codes`).
async fn ensure_first(
    conn: &mut PgConnection,
    actor: &Actor,
    user: Uuid,
    limit: i32,
) -> Result<(), ApiError> {
    let done: Option<bool> =
        sqlx::query_scalar("SELECT invite_autocreated FROM users WHERE id = $1 FOR NO KEY UPDATE")
            .bind(user)
            .fetch_optional(&mut *conn)
            .await?;
    if done != Some(false) {
        return Ok(());
    }
    let has: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM invite_codes WHERE user_id = $1)")
            .bind(user)
            .fetch_one(&mut *conn)
            .await?;
    if !has {
        apply_create(conn, actor, user, limit).await?;
    }
    sqlx::query("UPDATE users SET invite_autocreated = true WHERE id = $1")
        .bind(user)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Create a code for `user` in the caller's transaction (limit per user).
pub async fn apply_create(
    conn: &mut PgConnection,
    actor: &Actor,
    user: Uuid,
    limit: i32,
) -> Result<String, ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('akari.invite.' || $1::text, 0))")
        .bind(user)
        .execute(&mut *conn)
        .await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM invite_codes WHERE user_id = $1")
        .bind(user)
        .fetch_one(&mut *conn)
        .await?;
    if n >= i64::from(limit) {
        return Err(conflict!("invite.limit", "invite code limit reached"));
    }
    let mut code = new_code();
    // ~50-bit codes: a collision is astronomically rare; retry anyway.
    for _ in 0..3 {
        let done: Option<String> = sqlx::query_scalar(
            "INSERT INTO invite_codes (code, user_id) VALUES ($1, $2) \
             ON CONFLICT (code) DO NOTHING RETURNING code",
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
            return Ok(code);
        }
        code = new_code();
    }
    Err(ApiError::internal())
}

/// POST /api/v1/me/invite-codes → {code}
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
    let code = apply_create(&mut tx, &Actor::of(&user), user.id, s.invite_codes_per_user).await?;
    tx.commit().await?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "code": code })),
    ))
}

/// DELETE /api/v1/me/invite-codes/{code}
pub async fn delete_code(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, code)): Path<(String, String)>,
) -> Result<axum::http::StatusCode, ApiError> {
    require_user(&user)?;
    let mut tx = state.pg().begin().await?;
    let n = sqlx::query("DELETE FROM invite_codes WHERE code = $1 AND user_id = $2")
        .bind(&code)
        .bind(user.id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(ApiError::not_found());
    }
    crate::audit::record(
        &mut tx,
        &Actor::of(&user),
        "invite.delete",
        "user",
        Some(user.id.to_string()),
        Some(json!({ "code": code })),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
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
