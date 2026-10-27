//! Cloudflare API tokens (`dns_accounts`).
//!
//! A token is sealed with the master key (`masterkey::Keys::seal`, AAD = the
//! row id), shown only as "set" plus a fingerprint, and recorded in the audit
//! log as `"changed"`. Writes are the owner's (like the payment secrets) and
//! go through `apply_create` / `apply_update` / `apply_delete`: optimistic
//! concurrency on `version`, audit `dns.account.*` in the same transaction.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::audit::{self, Actor};
use crate::auth::{ApiError, bad_request, conflict};
use crate::masterkey::Keys;

/// Longest Cloudflare token we accept (they are 40 characters).
const TOKEN_MAX: usize = 200;
const TOKEN_MIN: usize = 20;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Row {
    pub id: Uuid,
    pub name: String,
    pub token_enc: Vec<u8>,
    pub token_fingerprint: String,
    pub version: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

const COLS: &str = "id, name, token_enc, token_fingerprint, version, created_at, updated_at";

/// What the API shows of an account: never the token.
#[derive(Debug, Serialize)]
pub struct View {
    pub id: Uuid,
    pub name: String,
    pub token_set: bool,
    pub fingerprint: String,
    pub version: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

impl From<&Row> for View {
    fn from(r: &Row) -> Self {
        Self {
            id: r.id,
            name: r.name.clone(),
            token_set: true,
            fingerprint: r.token_fingerprint.clone(),
            version: r.version,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

/// Body of create / update. `token` is write-only; on update, absent or
/// empty keeps the stored one.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountReq {
    pub name: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub version: Option<i64>,
}

pub async fn load_all(conn: &mut PgConnection) -> sqlx::Result<Vec<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM dns_accounts ORDER BY lower(name), id"
    )))
    .fetch_all(conn)
    .await
}

pub async fn load(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM dns_accounts WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
}

async fn lock(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM dns_accounts WHERE id = $1 FOR UPDATE"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
}

/// The plain token of `row`, or `None` when the blob cannot be opened
/// (data/master.key changed).
pub fn open_token(keys: &Keys, row: &Row) -> Option<String> {
    String::from_utf8(keys.open(row.id, &row.token_enc)?).ok()
}

fn fingerprint(token: &str) -> String {
    hex::encode(&Sha256::digest(token.as_bytes())[..6])
}

fn clean_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim();
    let n = name.chars().count();
    if !(1..=64).contains(&n) || name.chars().any(char::is_control) {
        return Err(bad_request!(
            "dns.account_name_invalid",
            "the account name must be 1-64 characters"
        ));
    }
    Ok(name.to_string())
}

fn clean_token(raw: &str) -> Result<String, ApiError> {
    let token = raw.trim();
    let shape = (TOKEN_MIN..=TOKEN_MAX).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !shape {
        return Err(bad_request!(
            "dns.token_invalid",
            "that does not look like a Cloudflare API token"
        ));
    }
    Ok(token.to_string())
}

fn seal(keys: &Keys, id: Uuid, token: &str) -> Result<Vec<u8>, ApiError> {
    keys.seal(id, token.as_bytes()).map_err(|e| {
        tracing::error!(error = %e, "sealing a Cloudflare token failed");
        ApiError::internal()
    })
}

fn snapshot(row: &Row) -> Value {
    json!({ "name": row.name, "token_fingerprint": row.token_fingerprint })
}

fn name_taken() -> ApiError {
    conflict!(
        "dns.account_name_exists",
        "an account with this name exists"
    )
}

fn is_name_clash(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .is_some_and(|d| d.constraint() == Some("dns_accounts_name_key"))
}

/// Add a token. Owner only; audited `dns.account.create`.
pub async fn apply_create(
    conn: &mut PgConnection,
    keys: &Keys,
    actor: &Actor,
    req: &AccountReq,
) -> Result<Row, ApiError> {
    crate::owner::require(conn, actor).await?;
    let name = clean_name(&req.name)?;
    let token = clean_token(req.token.as_deref().unwrap_or_default())?;
    let id = Uuid::new_v4();
    let enc = seal(keys, id, &token)?;
    let row: Row = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO dns_accounts (id, name, token_enc, token_fingerprint) \
         VALUES ($1, $2, $3, $4) RETURNING {COLS}"
    )))
    .bind(id)
    .bind(&name)
    .bind(&enc)
    .bind(fingerprint(&token))
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| {
        if is_name_clash(&e) {
            name_taken()
        } else {
            e.into()
        }
    })?;
    let mut after = snapshot(&row);
    after["token"] = json!(audit::CHANGED);
    audit::record(
        conn,
        actor,
        "dns.account.create",
        "dns_account",
        Some(id.to_string()),
        None,
        Some(after),
    )
    .await?;
    Ok(row)
}

/// Rename and/or replace the token (`version` must be current, else 409).
/// Owner only; audited `dns.account.update`.
pub async fn apply_update(
    conn: &mut PgConnection,
    keys: &Keys,
    actor: &Actor,
    id: Uuid,
    req: &AccountReq,
) -> Result<Row, ApiError> {
    crate::owner::require(conn, actor).await?;
    let name = clean_name(&req.name)?;
    let cur = lock(conn, id).await?.ok_or_else(ApiError::not_found)?;
    if Some(cur.version) != req.version {
        return Err(conflict!(
            "settings.version_conflict",
            "设置已被修改（可能是其他管理员），请刷新后重试"
        ));
    }
    let new_token = match req.token.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(t) => Some(clean_token(t)?),
    };
    let (enc, print) = match &new_token {
        Some(t) => (seal(keys, id, t)?, fingerprint(t)),
        None => (cur.token_enc.clone(), cur.token_fingerprint.clone()),
    };
    let row: Row = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE dns_accounts SET name = $2, token_enc = $3, token_fingerprint = $4, \
         version = version + 1, updated_at = now() WHERE id = $1 RETURNING {COLS}"
    )))
    .bind(id)
    .bind(&name)
    .bind(&enc)
    .bind(&print)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| {
        if is_name_clash(&e) {
            name_taken()
        } else {
            e.into()
        }
    })?;
    let mut after = snapshot(&row);
    if new_token.is_some() {
        after["token"] = json!(audit::CHANGED);
    }
    audit::record(
        conn,
        actor,
        "dns.account.update",
        "dns_account",
        Some(id.to_string()),
        Some(snapshot(&cur)),
        Some(after),
    )
    .await?;
    Ok(row)
}

/// Remove a token (Cloudflare is untouched). Owner only; audited
/// `dns.account.delete`.
pub async fn apply_delete(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<(), ApiError> {
    crate::owner::require(conn, actor).await?;
    let cur = lock(conn, id).await?.ok_or_else(ApiError::not_found)?;
    sqlx::query("DELETE FROM dns_accounts WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    audit::record(
        conn,
        actor,
        "dns.account.delete",
        "dns_account",
        Some(id.to_string()),
        Some(snapshot(&cur)),
        None,
    )
    .await?;
    Ok(())
}
