//! Ops: batch coupon generation (migration 0167).
//!
//! `POST /coupon-batches` makes N coupons sharing one template (kind,
//! value, plans, periods, minimum, validity, per-code use limit (default
//! 1), per-user limit, new users only). Each code is `prefix` + `length`
//! characters drawn from the OS CSPRNG over an unambiguous 32-letter
//! alphabet (no 0/O, no 1/I: `ALPHABET`, 5 bits per character, no modulo
//! bias). Every code is an ordinary `coupons` row (with `batch_id`), so the
//! W16 path is reused unchanged: eligibility (`coupons::check`), the
//! race-safe reservation at order creation, release and redemption.
//! Uniqueness is the database's `coupons_code` unique index on
//! `lower(code)`: the insert is `ON CONFLICT DO NOTHING` and the missing
//! codes are drawn again (bounded rounds), never assumed. Codes are not
//! secrets but are not written to the audit log either (5000 of them):
//! `coupon.batch.create` records the template and the count, the codes
//! are exported as CSV (`export.coupon_batch` audited). Revoking a batch
//! disables every code (`coupon.batch.revoke`); orders that already
//! reserved or redeemed one keep it (as with disabling a single coupon).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use super::catalog::PeriodKindText;
use super::coupons::{self, Kind, Terms};
use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{bad_request, conflict, ApiError, AuthUser};
use crate::csvx::{self, Cell};
use crate::state::AppState;

/// Unambiguous upper-case alphabet: 32 symbols (5 bits each); no 0/O/1/I.
pub const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const MAX_COUNT: i32 = 5000;
pub const MIN_LEN: usize = 6;
pub const MAX_LEN: usize = 16;
pub const DEFAULT_LEN: usize = 10;
pub const MAX_PREFIX: usize = 16;
/// Rounds of re-drawing codes that collided with existing ones.
const ROUNDS: usize = 8;

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct CreateBatchReq {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub prefix: Option<String>,
    pub count: i32,
    /// Random characters per code (default 10).
    #[serde(default)]
    pub length: Option<usize>,
    pub kind: Kind,
    pub value: i64,
    #[serde(default)]
    pub plan_ids: Option<Vec<Uuid>>,
    #[serde(default)]
    pub periods: Option<Vec<PeriodKindText>>,
    #[serde(default)]
    pub min_amount_cents: Option<i64>,
    #[serde(default)]
    pub starts_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub ends_at: Option<DateTime<Utc>>,
    /// Uses of EACH code (default 1; null = unlimited).
    #[serde(default = "one", deserialize_with = "crate::api::double_option")]
    pub max_uses: Option<Option<i32>>,
    #[serde(default)]
    pub per_user_limit: Option<i32>,
    #[serde(default)]
    pub new_users_only: Option<bool>,
}

fn one() -> Option<Option<i32>> {
    Some(Some(1))
}

/// Validate the shape (pure): prefix, count, length. Returns (prefix, len).
pub fn check_shape(req: &CreateBatchReq) -> Result<(String, usize), ApiError> {
    let prefix = req.prefix.as_deref().unwrap_or("").trim().to_string();
    if prefix.len() > MAX_PREFIX
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(bad_request!(
            "coupon_batch.prefix_invalid",
            "prefix must be 0-{max_prefix} characters of A-Z a-z 0-9 _ -",
            max_prefix = MAX_PREFIX
        ));
    }
    if !(1..=MAX_COUNT).contains(&req.count) {
        return Err(bad_request!(
            "coupon_batch.count_range",
            "count must be 1..={max_count}",
            max_count = MAX_COUNT
        ));
    }
    let len = req.length.unwrap_or(DEFAULT_LEN);
    if !(MIN_LEN..=MAX_LEN).contains(&len) {
        return Err(bad_request!(
            "coupon_batch.length_range",
            "length must be {min_len}..={max_len}",
            min_len = MIN_LEN,
            max_len = MAX_LEN
        ));
    }
    Ok((prefix, len))
}

/// The template as complete coupon terms (validated by `check_terms`).
pub fn terms(req: &CreateBatchReq) -> Terms {
    Terms {
        name: req.name.clone().unwrap_or_default().trim().to_string(),
        kind: req.kind,
        value: req.value,
        plan_ids: coupons::dedup_plans(&req.plan_ids),
        periods: coupons::periods_of(&req.periods),
        min_amount_cents: req.min_amount_cents.unwrap_or(0),
        starts_at: req.starts_at,
        ends_at: req.ends_at,
        max_uses: req.max_uses.flatten(),
        per_user_limit: req.per_user_limit,
        new_users_only: req.new_users_only.unwrap_or(false),
        enabled: true,
    }
}

/// `n` random codes (OS CSPRNG), distinct among themselves.
pub fn draw(prefix: &str, len: usize, n: usize) -> Result<Vec<String>, ApiError> {
    use ring::rand::SecureRandom;
    let rng = ring::rand::SystemRandom::new();
    let mut seen = std::collections::HashSet::with_capacity(n);
    let mut out = Vec::with_capacity(n);
    let mut buf = vec![0u8; len];
    // Each round draws what is missing; with ≥ 32^6 codes per batch of at
    // most 5000 a few rounds always suffice.
    for _ in 0..(n * 4 + 16) {
        if out.len() == n {
            break;
        }
        rng.fill(&mut buf)
            .map_err(|_| anyhow::anyhow!("system random source failed"))?;
        let mut code = String::with_capacity(prefix.len() + len);
        code.push_str(prefix);
        code.extend(buf.iter().map(|b| ALPHABET[usize::from(b & 31)] as char));
        if seen.insert(code.to_ascii_lowercase()) {
            out.push(code);
        }
    }
    if out.len() != n {
        return Err(anyhow::anyhow!("could not draw distinct codes").into());
    }
    Ok(out)
}

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct BatchView {
    pub id: Uuid,
    pub name: String,
    pub prefix: String,
    pub count: i32,
    pub template: Value,
    pub actor_login: String,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    /// Codes still in the coupons table (deleted ones are gone).
    pub codes: i64,
    /// Uses counted (reserved + redeemed) over all codes.
    pub used: i64,
    pub redeemed: i64,
}

const BATCH_SQL: &str = "SELECT b.id, b.name, b.prefix, b.count, b.template, b.actor_login, \
     b.created_at, b.revoked_at, \
     (SELECT count(*) FROM coupons c WHERE c.batch_id = b.id) AS codes, \
     (SELECT COALESCE(sum(c.used), 0)::bigint FROM coupons c WHERE c.batch_id = b.id) AS used, \
     (SELECT count(*) FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id \
      WHERE c.batch_id = b.id AND r.status = 'redeemed') AS redeemed \
     FROM coupon_batches b";

/// Create the batch and its codes (caller's transaction). Audited
/// `coupon.batch.create`. Returns (batch id, codes).
pub async fn apply_create(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &CreateBatchReq,
) -> Result<(Uuid, Vec<String>), ApiError> {
    let (prefix, len) = check_shape(req)?;
    let t = terms(req);
    coupons::check_terms(&t)?;
    coupons::check_plans_exist(conn, &t.plan_ids).await?;
    let id = Uuid::new_v4();
    let template = json!({
        "name": t.name, "kind": t.kind.as_str(), "value": t.value, "plan_ids": t.plan_ids,
        "periods": t.periods, "min_amount_cents": t.min_amount_cents, "starts_at": t.starts_at,
        "ends_at": t.ends_at, "max_uses": t.max_uses, "per_user_limit": t.per_user_limit,
        "new_users_only": t.new_users_only, "length": len,
    });
    sqlx::query(
        "INSERT INTO coupon_batches (id, name, prefix, count, template, actor_login) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(id)
    .bind(&t.name)
    .bind(&prefix)
    .bind(req.count)
    .bind(&template)
    .bind(&actor.login)
    .execute(&mut *conn)
    .await?;
    let want = req.count as usize;
    let mut codes: Vec<String> = Vec::with_capacity(want);
    for _ in 0..ROUNDS {
        let missing = want - codes.len();
        if missing == 0 {
            break;
        }
        let candidates = draw(&prefix, len, missing)?;
        let inserted = insert_codes(conn, id, &t, &candidates).await?;
        codes.extend(inserted);
    }
    if codes.len() != want {
        return Err(conflict!(
            "coupon_batch.code_space",
            "too many code collisions; use a longer length or another prefix"
        ));
    }
    crate::audit::record(
        conn,
        actor,
        "coupon.batch.create",
        "coupon_batch",
        Some(id.to_string()),
        None,
        Some(json!({ "prefix": prefix, "count": req.count, "template": template })),
    )
    .await?;
    Ok((id, codes))
}

/// Insert `candidates` as coupons of batch `id` with terms `t`; codes that
/// already exist (any case) are skipped by the `coupons_code` unique index.
/// Returns the codes actually inserted.
pub async fn insert_codes(
    conn: &mut PgConnection,
    id: Uuid,
    t: &Terms,
    candidates: &[String],
) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(
        "INSERT INTO coupons (id, code, name, kind, value, plan_ids, periods, \
         min_amount_cents, starts_at, ends_at, max_uses, per_user_limit, new_users_only, \
         enabled, batch_id) \
         SELECT gen_random_uuid(), c, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13 \
         FROM unnest($1::text[]) AS c ON CONFLICT ((lower(code))) DO NOTHING RETURNING code",
    )
    .bind(candidates)
    .bind(&t.name)
    .bind(t.kind.as_str())
    .bind(t.value)
    .bind(&t.plan_ids)
    .bind(&t.periods)
    .bind(t.min_amount_cents)
    .bind(t.starts_at)
    .bind(t.ends_at)
    .bind(t.max_uses)
    .bind(t.per_user_limit)
    .bind(t.new_users_only)
    .bind(id)
    .fetch_all(conn)
    .await
}

/// Disable every code of the batch (caller's transaction). Audited
/// `coupon.batch.revoke`. 409 when already revoked.
pub async fn apply_revoke(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<u64, ApiError> {
    let row: Option<Option<DateTime<Utc>>> =
        sqlx::query_scalar("SELECT revoked_at FROM coupon_batches WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    match row {
        None => return Err(ApiError::not_found()),
        Some(Some(_)) => {
            return Err(conflict!(
                "coupon_batch.revoked",
                "the batch is already revoked"
            ))
        }
        Some(None) => {}
    }
    // Lock order: coupons rows in id order (order creation locks one coupon
    // row; nothing here waits on anything else).
    let disabled = sqlx::query(
        "UPDATE coupons SET enabled = false, updated_at = now() WHERE id IN \
         (SELECT id FROM coupons WHERE batch_id = $1 ORDER BY id FOR UPDATE) AND enabled",
    )
    .bind(id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    sqlx::query("UPDATE coupon_batches SET revoked_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "coupon.batch.revoke",
        "coupon_batch",
        Some(id.to_string()),
        Some(json!({ "revoked": false })),
        Some(json!({ "revoked": true, "disabled": disabled })),
    )
    .await?;
    Ok(disabled)
}

/// The batch's codes as CSV (code, enabled, used, max_uses, redeemed).
pub async fn codes_csv(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Vec<u8>> {
    let rows: Vec<(String, bool, i32, Option<i32>, i64)> = sqlx::query_as(
        "SELECT c.code, c.enabled, c.used, c.max_uses, \
         (SELECT count(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id \
          AND r.status = 'redeemed') FROM coupons c WHERE c.batch_id = $1 ORDER BY c.code",
    )
    .bind(id)
    .fetch_all(conn)
    .await?;
    let mut out = Vec::with_capacity(64 + rows.len() * 32);
    out.extend_from_slice(csvx::BOM);
    csvx::header(
        &mut out,
        &["code", "enabled", "used", "max_uses", "redeemed"],
    );
    for (code, enabled, used, max, redeemed) in rows {
        csvx::write_row(
            &mut out,
            &[
                Cell::text(code),
                Cell::bool(enabled),
                Cell::raw(used),
                Cell::opt_raw(max),
                Cell::raw(redeemed),
            ],
        );
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<BatchView>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{BATCH_SQL} ORDER BY b.created_at DESC, b.id LIMIT 200"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// POST /coupon-batches → 201 `{id, count}`.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateBatchReq>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let (id, codes) = apply_create(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "count": codes.len() })),
    ))
}

pub async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let n = apply_revoke(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(Json(json!({ "disabled": n })))
}

/// GET /coupon-batches/{id}/export.csv (audited `export.coupon_batch`).
pub async fn export(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Response, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM coupon_batches WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(ApiError::not_found());
    }
    let bytes = codes_csv(&mut tx, id).await?;
    crate::export::audit(
        &mut tx,
        &Actor::of(&user),
        "coupon_batch",
        json!({ "batch_id": id }),
    )
    .await?;
    tx.commit().await?;
    Ok(crate::export::csv_response(
        crate::export::filename("coupons"),
        bytes,
    ))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/{prefix}/api/v1/coupon-batches", get(list).post(create))
        .route("/{prefix}/api/v1/coupon-batches/{id}/revoke", post(revoke))
        .route(
            "/{prefix}/api/v1/coupon-batches/{id}/export.csv",
            get(export),
        )
}
