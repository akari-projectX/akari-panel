//! W16 coupons (优惠券): admin CRUD, the eligibility check shared by the
//! shop preview and order creation, and the reservation lifecycle.
//!
//! Rules (docs/PAYMENTS.md "Coupons"):
//! - Code: 3-32 of `[A-Za-z0-9_-]`, unique case-insensitively, entered in
//!   any case.
//! - Discount on the LIST price (SQL `akari_coupon_discount`): percent
//!   1-100 floors to the fen; fixed fen capped at the list price. The W7
//!   switch credit and the balance then cover what is left (`akari_split`),
//!   so the amount is never negative.
//! - Scope: plans (NULL = all), period kinds (NULL = all), minimum list
//!   price, validity window (DB clock), total uses, uses per user, new users
//!   only (no paid order yet), enabled.
//! - Reservation, race-free: order creation locks the coupon row (`FOR
//!   UPDATE`), re-checks everything under the lock (per-user count
//!   included), then `used = used + 1` with the cap in the WHERE and a
//!   `coupon_redemptions` row 'reserved', all in the order's transaction.
//!   Two buyers racing for the last use serialise on the row lock: exactly
//!   one reserves, the other is refused ("coupon has been used up"); the
//!   table CHECK `used <= max_uses` is the backstop.
//! - An order that ends unpaid releases its reservation (`release`, same
//!   transaction as the status change); a paid one redeems it (`redeem`,
//!   inside apply_mark_paid). A late payment of an ended order re-reserves
//!   — if the coupon is used up by then, the payment is honoured anyway
//!   (Alipay took the discounted amount): redeemed with `over_limit`.

use crate::auth::{bad_request, conflict};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use super::catalog::{MAX_PRICE_CENTS, PeriodKindText};
use crate::api::{ApiJson, double_option};
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

pub const MIN_CODE: usize = 3;
pub const MAX_CODE: usize = 32;
const MAX_NAME: usize = 100;
const MAX_SCOPE_PLANS: usize = 200;
const MAX_LIMIT: i32 = 100_000_000;

/// A syntactically valid coupon code (trimmed), or None.
pub fn normalize_code(raw: &str) -> Option<String> {
    let c = raw.trim();
    ((MIN_CODE..=MAX_CODE).contains(&c.len())
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then(|| c.to_string())
}

/// Why a coupon does not apply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    /// Unknown, disabled or malformed.
    Invalid,
    NotStarted,
    Expired,
    UsedUp,
    UserLimit,
    NewUsersOnly,
    Plan,
    Period,
    BelowMinimum,
}

impl Refusal {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "invalid" => Refusal::Invalid,
            "not_started" => Refusal::NotStarted,
            "expired" => Refusal::Expired,
            "used_up" => Refusal::UsedUp,
            "user_limit" => Refusal::UserLimit,
            "new_users_only" => Refusal::NewUsersOnly,
            "plan" => Refusal::Plan,
            "period" => Refusal::Period,
            "below_minimum" => Refusal::BelowMinimum,
            _ => return None,
        })
    }

    pub fn error(self) -> ApiError {
        match self {
            Refusal::Invalid => bad_request!("coupon.invalid", "invalid coupon code"),
            Refusal::NotStarted => conflict!("coupon.not_started", "coupon is not valid yet"),
            Refusal::Expired => conflict!("coupon.expired", "coupon has expired"),
            Refusal::UsedUp => conflict!("coupon.used_up", "coupon has been used up"),
            Refusal::UserLimit => {
                conflict!("coupon.user_limit", "you have already used this coupon")
            }
            Refusal::NewUsersOnly => {
                conflict!("coupon.new_users_only", "coupon is for new customers only")
            }
            Refusal::Plan => conflict!("coupon.plan", "coupon does not apply to this plan"),
            Refusal::Period => conflict!("coupon.period", "coupon does not apply to this period"),
            Refusal::BelowMinimum => {
                conflict!(
                    "coupon.below_minimum",
                    "order amount is below the coupon's minimum"
                )
            }
        }
    }
}

/// One (plan, period, list price) to check a coupon against.
#[derive(Clone, Debug)]
pub struct Item {
    pub plan_id: Uuid,
    pub period: &'static str,
    pub list_cents: i64,
}

/// The coupon as it applies to one item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checked {
    pub coupon_id: Option<Uuid>,
    /// The code as stored (the admin's spelling).
    pub code: Option<String>,
    pub refusal: Option<Refusal>,
    /// The discount it would give (0 when refused).
    pub discount_cents: i64,
}

/// Every rule in one statement (DB clock). `$1` code, `$2` user, items as
/// arrays. The per-user count includes reservations (pending orders).
const CHECK_SQL: &str = "WITH c AS (SELECT * FROM coupons WHERE lower(code) = lower($1)), \
     u AS (SELECT (SELECT count(*) FROM coupon_redemptions r JOIN c ON r.coupon_id = c.id \
                   WHERE r.user_id = $2 AND r.status <> 'released') AS mine, \
                  EXISTS (SELECT 1 FROM orders WHERE user_id = $2 AND status = 'paid' \
                          AND refunded_at IS NULL) AS bought), \
     x AS (SELECT * FROM unnest($3::uuid[], $4::text[], $5::bigint[]) WITH ORDINALITY \
           AS x(plan_id, period, list, ord)) \
     SELECT c.id, c.code, CASE \
       WHEN c.id IS NULL OR NOT c.enabled THEN 'invalid' \
       WHEN c.starts_at IS NOT NULL AND now() < c.starts_at THEN 'not_started' \
       WHEN c.ends_at IS NOT NULL AND now() >= c.ends_at THEN 'expired' \
       WHEN c.max_uses IS NOT NULL AND c.used >= c.max_uses THEN 'used_up' \
       WHEN c.per_user_limit IS NOT NULL AND u.mine >= c.per_user_limit THEN 'user_limit' \
       WHEN c.new_users_only AND u.bought THEN 'new_users_only' \
       WHEN c.plan_ids IS NOT NULL AND NOT (x.plan_id = ANY (c.plan_ids)) THEN 'plan' \
       WHEN c.periods IS NOT NULL AND NOT (x.period = ANY (c.periods)) THEN 'period' \
       WHEN x.list < c.min_amount_cents THEN 'below_minimum' END, \
       akari_coupon_discount(x.list, c.kind, c.value) \
     FROM x CROSS JOIN u LEFT JOIN c ON true ORDER BY x.ord";

/// (coupon id, stored code, refusal, discount) per item.
type CheckRow = (Option<Uuid>, Option<String>, Option<String>, i64);

/// Check a coupon for each item (no lock; the shop preview, and order
/// creation after `lock`).
pub async fn check(
    conn: &mut PgConnection,
    user_id: Uuid,
    code: &str,
    items: &[Item],
) -> sqlx::Result<Vec<Checked>> {
    let plans: Vec<Uuid> = items.iter().map(|i| i.plan_id).collect();
    let periods: Vec<&str> = items.iter().map(|i| i.period).collect();
    let lists: Vec<i64> = items.iter().map(|i| i.list_cents).collect();
    let rows: Vec<CheckRow> = sqlx::query_as(CHECK_SQL)
        .bind(code)
        .bind(user_id)
        .bind(&plans)
        .bind(&periods)
        .bind(&lists)
        .fetch_all(conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, code, refusal, discount)| {
            let refusal = refusal.map(|r| Refusal::parse(&r).unwrap_or(Refusal::Invalid));
            Checked {
                coupon_id: id,
                code,
                refusal,
                discount_cents: if refusal.is_some() { 0 } else { discount },
            }
        })
        .collect())
}

/// Lock the coupon row of `code` (order creation, before `check`).
pub async fn lock(conn: &mut PgConnection, code: &str) -> sqlx::Result<Option<Uuid>> {
    sqlx::query_scalar("SELECT id FROM coupons WHERE lower(code) = lower($1) FOR UPDATE")
        .bind(code)
        .fetch_optional(conn)
        .await
}

/// Reserve one use for a new order (caller holds the coupon's row lock and
/// has checked it). The cap is in the WHERE: a refusal here is "used up".
pub async fn reserve(
    conn: &mut PgConnection,
    coupon_id: Uuid,
    order_id: Uuid,
    user_id: Uuid,
    discount_cents: i64,
) -> Result<(), ApiError> {
    let ok: Option<Uuid> = sqlx::query_scalar(
        "UPDATE coupons SET used = used + 1 WHERE id = $1 \
         AND (max_uses IS NULL OR used < max_uses) RETURNING id",
    )
    .bind(coupon_id)
    .fetch_optional(&mut *conn)
    .await?;
    if ok.is_none() {
        return Err(Refusal::UsedUp.error());
    }
    sqlx::query(
        "INSERT INTO coupon_redemptions (order_id, coupon_id, user_id, status, discount_cents) \
         VALUES ($1, $2, $3, 'reserved', $4)",
    )
    .bind(order_id)
    .bind(coupon_id)
    .bind(user_id)
    .bind(discount_cents)
    .execute(conn)
    .await?;
    Ok(())
}

/// The order ended unpaid: give its reservation back. Idempotent.
pub async fn release(conn: &mut PgConnection, order_id: Uuid) -> sqlx::Result<bool> {
    let coupon: Option<Uuid> = sqlx::query_scalar(
        "UPDATE coupon_redemptions SET status = 'released', updated_at = now() \
         WHERE order_id = $1 AND status = 'reserved' RETURNING coupon_id",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(coupon) = coupon else {
        return Ok(false);
    };
    sqlx::query("UPDATE coupons SET used = used - 1 WHERE id = $1")
        .bind(coupon)
        .execute(conn)
        .await?;
    Ok(true)
}

/// 低-2: the order was refunded — its redemption is given back (the
/// coupon's use count and the buyer's per-user count drop by one; an
/// over-limit redemption was never counted). Idempotent. Returns whether
/// a redemption was released.
pub async fn release_refunded(conn: &mut PgConnection, order_id: Uuid) -> sqlx::Result<bool> {
    let r: Option<(Uuid, bool)> = sqlx::query_as(
        "UPDATE coupon_redemptions SET status = 'released', over_limit = false, \
         updated_at = now() WHERE order_id = $1 AND status = 'redeemed' \
         RETURNING coupon_id, old.over_limit",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((coupon, over_limit)) = r else {
        return Ok(false);
    };
    if !over_limit {
        sqlx::query("UPDATE coupons SET used = used - 1 WHERE id = $1 AND used > 0")
            .bind(coupon)
            .execute(conn)
            .await?;
    }
    Ok(true)
}

/// The order was paid (apply_mark_paid): its reservation becomes a
/// redemption. A released one (late payment of an ended order) is
/// re-reserved within the cap, else redeemed over the limit (counted
/// nowhere, flagged). Returns the fulfilment detail, None without coupon.
pub async fn redeem(conn: &mut PgConnection, order_id: Uuid) -> sqlx::Result<Option<Value>> {
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT coupon_id, status FROM coupon_redemptions WHERE order_id = $1 FOR UPDATE",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((coupon, status)) = row else {
        return Ok(None);
    };
    let over_limit = match status.as_str() {
        "reserved" => false,
        "released" => sqlx::query_scalar::<_, Uuid>(
            "UPDATE coupons SET used = used + 1 WHERE id = $1 \
                 AND (max_uses IS NULL OR used < max_uses) RETURNING id",
        )
        .bind(coupon)
        .fetch_optional(&mut *conn)
        .await?
        .is_none(),
        _ => return Ok(Some(json!({ "coupon_id": coupon, "over_limit": false }))),
    };
    sqlx::query(
        "UPDATE coupon_redemptions SET status = 'redeemed', over_limit = $2, updated_at = now() \
         WHERE order_id = $1",
    )
    .bind(order_id)
    .bind(over_limit)
    .execute(conn)
    .await?;
    Ok(Some(
        json!({ "coupon_id": coupon, "over_limit": over_limit }),
    ))
}

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct CouponView {
    id: Uuid,
    code: String,
    name: String,
    kind: String,
    value: i64,
    plan_ids: Option<Vec<Uuid>>,
    periods: Option<Vec<String>>,
    min_amount_cents: i64,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
    max_uses: Option<i32>,
    per_user_limit: Option<i32>,
    new_users_only: bool,
    enabled: bool,
    used: i32,
    redeemed: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const COUPON_SQL: &str = "SELECT c.id, c.code, c.name, c.kind, c.value, c.plan_ids, c.periods, \
     c.min_amount_cents, c.starts_at, c.ends_at, c.max_uses, c.per_user_limit, \
     c.new_users_only, c.enabled, c.used, \
     (SELECT count(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id \
      AND r.status = 'redeemed') AS redeemed, c.created_at, c.updated_at FROM coupons c";

const SNAPSHOT_SQL: &str = "jsonb_build_object('code', c.code, 'name', c.name, 'kind', c.kind, \
     'value', c.value, 'plan_ids', c.plan_ids, 'periods', c.periods, \
     'min_amount_cents', c.min_amount_cents, 'starts_at', c.starts_at, 'ends_at', c.ends_at, \
     'max_uses', c.max_uses, 'per_user_limit', c.per_user_limit, \
     'new_users_only', c.new_users_only, 'enabled', c.enabled, 'used', c.used)";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Percent,
    Fixed,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Percent => "percent",
            Kind::Fixed => "fixed",
        }
    }
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct CreateCouponReq {
    pub code: String,
    #[serde(default)]
    pub name: Option<String>,
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
    #[serde(default)]
    pub max_uses: Option<i32>,
    #[serde(default)]
    pub per_user_limit: Option<i32>,
    #[serde(default)]
    pub new_users_only: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// PATCH: absent = unchanged, null = cleared (nullable fields only). The
/// code is immutable (orders keep the code they used).
#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct UpdateCouponReq {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub kind: Option<Kind>,
    #[serde(default)]
    pub value: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    pub plan_ids: Option<Option<Vec<Uuid>>>,
    #[serde(default, deserialize_with = "double_option")]
    pub periods: Option<Option<Vec<PeriodKindText>>>,
    #[serde(default)]
    pub min_amount_cents: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    pub starts_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "double_option")]
    pub ends_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "double_option")]
    pub max_uses: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    pub per_user_limit: Option<Option<i32>>,
    #[serde(default)]
    pub new_users_only: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// The complete terms after a create/update, validated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    pub name: String,
    pub kind: Kind,
    pub value: i64,
    pub plan_ids: Option<Vec<Uuid>>,
    pub periods: Option<Vec<String>>,
    pub min_amount_cents: i64,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub max_uses: Option<i32>,
    pub per_user_limit: Option<i32>,
    pub new_users_only: bool,
    pub enabled: bool,
}

/// Validate complete terms (pure).
pub fn check_terms(t: &Terms) -> Result<(), ApiError> {
    if t.name.chars().count() > MAX_NAME {
        return Err(bad_request!(
            "coupon_admin.name_long",
            "name must be at most {max_name} characters",
            max_name = MAX_NAME
        ));
    }
    match t.kind {
        Kind::Percent if !(1..=100).contains(&t.value) => {
            return Err(bad_request!(
                "coupon_admin.percent_range",
                "a percent coupon's value must be 1-100"
            ));
        }
        Kind::Fixed if !(1..=MAX_PRICE_CENTS).contains(&t.value) => {
            return Err(bad_request!(
                "coupon_admin.fixed_range",
                "a fixed coupon's value must be 1..={max_price_cents} (integer fen)",
                max_price_cents = MAX_PRICE_CENTS
            ));
        }
        _ => {}
    }
    if let Some(p) = &t.plan_ids
        && (p.is_empty() || p.len() > MAX_SCOPE_PLANS)
    {
        return Err(bad_request!(
            "coupon_admin.plans_range",
            "plan_ids must list 1-{max_scope_plans} plans (or be null for all)",
            max_scope_plans = MAX_SCOPE_PLANS
        ));
    }
    if let Some(p) = &t.periods
        && p.is_empty()
    {
        return Err(bad_request!(
            "coupon_admin.periods_empty",
            "periods must list at least one period (or be null for all)"
        ));
    }
    if !(0..=MAX_PRICE_CENTS).contains(&t.min_amount_cents) {
        return Err(bad_request!(
            "coupon_admin.min_amount_range",
            "min_amount_cents must be 0..={max_price_cents}",
            max_price_cents = MAX_PRICE_CENTS
        ));
    }
    if let (Some(s), Some(e)) = (t.starts_at, t.ends_at)
        && e <= s
    {
        return Err(bad_request!(
            "coupon_admin.ends_before_starts",
            "ends_at must be after starts_at"
        ));
    }
    for (field, v) in [
        ("max_uses", t.max_uses),
        ("per_user_limit", t.per_user_limit),
    ] {
        if v.is_some_and(|v| !(1..=MAX_LIMIT).contains(&v)) {
            return Err(bad_request!(
                "coupon_admin.limit_range",
                "{field} must be 1..={max_limit} (or null for unlimited)",
                field = field,
                max_limit = MAX_LIMIT
            ));
        }
    }
    Ok(())
}

pub(crate) fn periods_of(p: &Option<Vec<PeriodKindText>>) -> Option<Vec<String>> {
    p.as_ref().map(|v| {
        let mut out: Vec<String> = v.iter().map(|k| k.0.as_str().to_string()).collect();
        out.sort();
        out.dedup();
        out
    })
}

pub(crate) fn dedup_plans(p: &Option<Vec<Uuid>>) -> Option<Vec<Uuid>> {
    p.as_ref().map(|v| {
        let mut out = v.clone();
        out.sort();
        out.dedup();
        out
    })
}

pub(crate) async fn check_plans_exist(
    conn: &mut PgConnection,
    plans: &Option<Vec<Uuid>>,
) -> Result<(), ApiError> {
    if let Some(p) = plans {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM plans WHERE id = ANY ($1)")
            .bind(p)
            .fetch_one(conn)
            .await?;
        if n != p.len() as i64 {
            return Err(bad_request!(
                "coupon_admin.unknown_plan",
                "plan_ids contains an unknown plan"
            ));
        }
    }
    Ok(())
}

async fn write_terms(conn: &mut PgConnection, id: Uuid, t: &Terms) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE coupons SET name = $2, kind = $3, value = $4, plan_ids = $5, periods = $6, \
         min_amount_cents = $7, starts_at = $8, ends_at = $9, max_uses = $10, \
         per_user_limit = $11, new_users_only = $12, enabled = $13, updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
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
    .bind(t.enabled)
    .execute(conn)
    .await?;
    Ok(())
}

async fn snapshot(conn: &mut PgConnection, id: Uuid) -> sqlx::Result<Value> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {SNAPSHOT_SQL} FROM coupons c WHERE c.id = $1"
    )))
    .bind(id)
    .fetch_one(conn)
    .await
}

/// Create a coupon (audited `coupon.create`). 409 on a duplicate code.
pub async fn apply_create(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &CreateCouponReq,
) -> Result<Uuid, ApiError> {
    let code = normalize_code(&req.code).ok_or_else(|| {
        bad_request!(
            "coupon_admin.code_invalid",
            "code must be {min_code}-{max_code} characters of A-Z a-z 0-9 _ -",
            min_code = MIN_CODE,
            max_code = MAX_CODE
        )
    })?;
    let t = Terms {
        name: req.name.clone().unwrap_or_default().trim().to_string(),
        kind: req.kind,
        value: req.value,
        plan_ids: dedup_plans(&req.plan_ids),
        periods: periods_of(&req.periods),
        min_amount_cents: req.min_amount_cents.unwrap_or(0),
        starts_at: req.starts_at,
        ends_at: req.ends_at,
        max_uses: req.max_uses,
        per_user_limit: req.per_user_limit,
        new_users_only: req.new_users_only.unwrap_or(false),
        enabled: req.enabled.unwrap_or(true),
    };
    check_terms(&t)?;
    check_plans_exist(conn, &t.plan_ids).await?;
    let id = Uuid::new_v4();
    let r = sqlx::query("INSERT INTO coupons (id, code, kind, value) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(&code)
        .bind(t.kind.as_str())
        .bind(t.value)
        .execute(&mut *conn)
        .await;
    match r {
        Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
            return Err(conflict!(
                "coupon_admin.code_exists",
                "a coupon with this code already exists"
            ));
        }
        r => r?,
    };
    write_terms(conn, id, &t).await?;
    let after = snapshot(conn, id).await?;
    crate::audit::record(
        conn,
        actor,
        "coupon.create",
        "coupon",
        Some(id.to_string()),
        None,
        Some(after),
    )
    .await?;
    Ok(id)
}

#[derive(sqlx::FromRow)]
struct TermsRow {
    name: String,
    kind: String,
    value: i64,
    plan_ids: Option<Vec<Uuid>>,
    periods: Option<Vec<String>>,
    min_amount_cents: i64,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
    max_uses: Option<i32>,
    per_user_limit: Option<i32>,
    new_users_only: bool,
    enabled: bool,
    used: i32,
}

/// Update a coupon (audited `coupon.update`). Lowering `max_uses` below
/// the uses already counted is refused (409).
pub async fn apply_update(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    req: &UpdateCouponReq,
) -> Result<(), ApiError> {
    let cur: Option<TermsRow> = sqlx::query_as(
        "SELECT name, kind, value, plan_ids, periods, min_amount_cents, starts_at, ends_at, \
         max_uses, per_user_limit, new_users_only, enabled, used FROM coupons \
         WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(cur) = cur else {
        return Err(ApiError::not_found());
    };
    let before = snapshot(conn, id).await?;
    let t = Terms {
        name: req
            .name
            .as_deref()
            .map(|n| n.trim().to_string())
            .unwrap_or(cur.name),
        kind: req.kind.unwrap_or(if cur.kind == "percent" {
            Kind::Percent
        } else {
            Kind::Fixed
        }),
        value: req.value.unwrap_or(cur.value),
        plan_ids: match &req.plan_ids {
            None => cur.plan_ids,
            Some(p) => dedup_plans(p),
        },
        periods: match &req.periods {
            None => cur.periods,
            Some(p) => periods_of(p),
        },
        min_amount_cents: req.min_amount_cents.unwrap_or(cur.min_amount_cents),
        starts_at: req.starts_at.unwrap_or(cur.starts_at),
        ends_at: req.ends_at.unwrap_or(cur.ends_at),
        max_uses: req.max_uses.unwrap_or(cur.max_uses),
        per_user_limit: req.per_user_limit.unwrap_or(cur.per_user_limit),
        new_users_only: req.new_users_only.unwrap_or(cur.new_users_only),
        enabled: req.enabled.unwrap_or(cur.enabled),
    };
    check_terms(&t)?;
    if t.max_uses.is_some_and(|m| m < cur.used) {
        return Err(conflict!(
            "coupon_admin.max_uses_below_used",
            "max_uses cannot be below the {used} uses already counted",
            used = cur.used
        ));
    }
    if req.plan_ids.is_some() {
        check_plans_exist(conn, &t.plan_ids).await?;
    }
    write_terms(conn, id, &t).await?;
    let after = snapshot(conn, id).await?;
    crate::audit::record(
        conn,
        actor,
        "coupon.update",
        "coupon",
        Some(id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(())
}

/// Delete a coupon that no order ever used (audited `coupon.delete`); a
/// used one is kept for the records (409: disable it instead).
pub async fn apply_delete(
    conn: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<(), ApiError> {
    let before: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {SNAPSHOT_SQL} FROM coupons c WHERE c.id = $1 FOR UPDATE"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(before) = before else {
        return Err(ApiError::not_found());
    };
    let used: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM coupon_redemptions WHERE coupon_id = $1) \
         OR EXISTS (SELECT 1 FROM orders WHERE coupon_id = $1)",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    if used {
        return Err(conflict!(
            "coupon_admin.in_use",
            "the coupon has been used by orders; disable it instead"
        ));
    }
    sqlx::query("DELETE FROM coupons WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    crate::audit::record(
        conn,
        actor,
        "coupon.delete",
        "coupon",
        Some(id.to_string()),
        Some(before),
        None,
    )
    .await?;
    Ok(())
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<CouponView>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{COUPON_SQL} WHERE c.batch_id IS NULL ORDER BY c.created_at DESC, c.id LIMIT 1000"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct RedemptionView {
    order_id: Uuid,
    out_trade_no: String,
    user_id: Option<Uuid>,
    /// Q4: the order's snapshot label; `user_email` = current address.
    user_label: String,
    user_email: Option<String>,
    status: String,
    over_limit: bool,
    discount_cents: i64,
    order_status: String,
    created_at: DateTime<Utc>,
}

/// GET /coupons/{id}: the coupon and its last 200 redemptions.
pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let coupon: CouponView =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{COUPON_SQL} WHERE c.id = $1")))
            .bind(id)
            .fetch_optional(state.pg())
            .await?
            .ok_or_else(ApiError::not_found)?;
    let redemptions: Vec<RedemptionView> = sqlx::query_as(
        "SELECT r.order_id, o.out_trade_no, r.user_id, o.user_label, \
         (SELECT u.email FROM users u WHERE u.id = r.user_id) AS user_email, r.status, r.over_limit, \
         r.discount_cents, o.status AS order_status, r.created_at FROM coupon_redemptions r \
         JOIN orders o ON o.id = r.order_id WHERE r.coupon_id = $1 \
         ORDER BY r.created_at DESC LIMIT 200",
    )
    .bind(id)
    .fetch_all(state.pg())
    .await?;
    Ok(Json(
        json!({ "coupon": coupon, "redemptions": redemptions }),
    ))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateCouponReq>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let id = apply_create(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<UpdateCouponReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_update(&mut tx, &Actor::of(&user), id, &req).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_delete(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Mirror of SQL `akari_coupon_discount` (tests and fuzzing check that
/// the money rules hold; production computes in SQL).
#[cfg(any(test, fuzzing))]
pub mod mirror {
    /// Discount in fen for a list price.
    pub fn discount(list_cents: i64, percent: bool, value: i64) -> i64 {
        if list_cents <= 0 || value <= 0 {
            0
        } else if percent {
            list_cents * value.min(100) / 100
        } else {
            value.min(list_cents)
        }
    }

    /// Mirror of SQL `akari_split`: (discount, credit, balance, amount).
    pub fn split(list: i64, discount: i64, credit: i64, balance: i64) -> (i64, i64, i64, i64) {
        let d = discount.clamp(0, list);
        let c = credit.clamp(0, list - d);
        let b = balance.clamp(0, list - d - c);
        (d, c, b, list - d - c - b)
    }
}
