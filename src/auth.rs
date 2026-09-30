use argon2::{
    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},
    Argon2,
};
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::{http::StatusCode, Json};
use axum_extra::extract::cookie::CookieJar;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::state::AppState;

pub const COOKIE_NAME: &str = "sid";
/// Session lifetime, shared by the JWT exp and the cookie Max-Age.
pub const COOKIE_TTL_SECS: i64 = 12 * 3600;

// ---------------------------------------------------------------------------
// API error type: every failure is a small JSON body, never a stack trace.
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    #[cfg(test)]
    pub fn status(&self) -> StatusCode {
        self.status
    }
    pub fn message(&self) -> &str {
        &self.message
    }
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized")
    }
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden")
    }
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not found")
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, msg)
    }
    pub fn too_many() -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "too many requests")
    }
    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "api internal error");
        ApiError::internal()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "api db error");
        ApiError::internal()
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        tracing::error!(error = %e, "api serialization error");
        ApiError::internal()
    }
}

// ---------------------------------------------------------------------------
// Passwords (argon2id) and session tokens (HS256 JWT in an HttpOnly cookie).
// ---------------------------------------------------------------------------

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    // Argon2id v19 with OWASP-default params; the salt is generated inside.
    Ok(Argon2::default()
        .hash_password(password.as_bytes())?
        .to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Burn equivalent CPU when the login cannot succeed, so response timing
/// does not reveal whether an account exists.
pub fn scrub_password(password: &str) {
    let _ = Argon2::default().hash_password(password.as_bytes());
}

#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub role: String,
    pub iat: u64,
    pub exp: u64,
}

pub fn issue_token(state: &AppState, user_id: Uuid, role: &str) -> anyhow::Result<String> {
    let now = chrono::Utc::now().timestamp() as u64;
    let claims = Claims {
        sub: user_id,
        role: role.to_owned(),
        iat: now,
        exp: now + COOKIE_TTL_SECS as u64,
    };
    Ok(encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret().as_bytes()),
    )?)
}

// ---------------------------------------------------------------------------
// Authenticated-user extractor. Binds the session to a live, enabled user on
// every request (no stale-role or stale-enabled states from old tokens).
// ---------------------------------------------------------------------------

pub struct AuthUser {
    pub id: Uuid,
    pub login: String,
    pub role: String,
}

impl AuthUser {
    pub fn require_admin(&self) -> Result<(), ApiError> {
        if self.role == "admin" {
            Ok(())
        } else {
            Err(ApiError::forbidden())
        }
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_request_parts(parts, state)
            .await
            .unwrap_or_default();
        let token = jar
            .get(COOKIE_NAME)
            .map(|c| c.value())
            .ok_or_else(ApiError::unauthorized)?;

        let claims = decode::<Claims>(
            token,
            &DecodingKey::from_secret(state.jwt_secret().as_bytes()),
            &Validation::new(Algorithm::HS256),
        )
        .map_err(|_| ApiError::unauthorized())?
        .claims;

        #[derive(sqlx::FromRow)]
        struct Row {
            id: Uuid,
            login: String,
            role: String,
            enabled: bool,
        }
        // Disabled or expired (role=user) accounts lose existing sessions.
        let row = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(format!(
            "SELECT u.id, u.login, u.role, (u.enabled AND NOT {}) AS enabled \
             FROM users u WHERE u.id = $1",
            crate::enforce::EXPIRED
        )))
        .bind(claims.sub)
        .fetch_optional(state.pg())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "auth db error");
            ApiError::internal()
        })?
        .ok_or_else(ApiError::unauthorized)?;

        if !row.enabled {
            return Err(ApiError::unauthorized());
        }
        Ok(AuthUser {
            id: row.id,
            login: row.login,
            role: row.role,
        })
    }
}
