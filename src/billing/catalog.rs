//! W7 plan catalogue: period kinds and prices (admin), the sale rules and
//! the proration credit (shop listing and order creation share them).
//!
//! Rules (R24/W7, xboard-like; docs/PAYMENTS.md "Periods" and "Switching
//! plans"):
//! - A plan is for sale when `enabled && on_sale` and it has a price for
//!   the requested period. Prices are optional per period; `on_sale`
//!   needs at least one non-reset price.
//! - Same plan as the active one: a period renews (expiry extended from
//!   max(expiry, now)); the reset pack zeroes the used traffic. A plan
//!   without expiry cannot be renewed (nothing to extend).
//! - No active plan: `new` (not for `renewal_only` plans; capacity).
//! - Another active plan: `switch` (needs `allow_switch_in`, not
//!   `renewal_only`; capacity). The new plan's full period price is
//!   charged minus a credit for the unused part of the current plan:
//!   value of the latest paid order of the current subscription
//!   (list price = what was paid + any credit it used) x remaining time /
//!   that order's nominal period length, floored to the fen, capped by the
//!   total value paid for this subscription, never negative (SQL
//!   `akari_prorate`). A credit larger than the price is forfeited (no
//!   balance, no refunds): the amount is then 0 and the order is paid by
//!   the credit at creation. Admin-assigned subscriptions without a paid
//!   order earn no credit.
//! - The credit and the amount are computed by the server when the order
//!   is created and copied into it (the client never sends amounts); the
//!   shop shows the same computation beforehand.
//! - Capacity (max active subscribers) is checked here and again at
//!   fulfilment under `entitle::lock` (orders.rs): pending orders reserve
//!   nothing, so two buyers can pay for the last slot — one is fulfilled,
//!   the other stays paid with `fulfil_error` for an admin to resolve.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

/// Highest price (cents) per period; Alipay allows far more per trade.
pub const MAX_PRICE_CENTS: i64 = 100_000_000;
/// Longest custom/one-time period (10 years).
pub const MAX_PERIOD_DAYS: i32 = 3650;

/// What a price buys.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeriodKind {
    Month,
    Quarter,
    HalfYear,
    Year,
    TwoYear,
    ThreeYear,
    /// A custom N-day period.
    Days,
    /// A one-off purchase: N days, or no expiry without days.
    Onetime,
    /// Traffic reset pack (current subscribers only, no period change).
    Reset,
}

impl PeriodKind {
    pub const ALL: [PeriodKind; 9] = [
        PeriodKind::Month,
        PeriodKind::Quarter,
        PeriodKind::HalfYear,
        PeriodKind::Year,
        PeriodKind::TwoYear,
        PeriodKind::ThreeYear,
        PeriodKind::Days,
        PeriodKind::Onetime,
        PeriodKind::Reset,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PeriodKind::Month => "month",
            PeriodKind::Quarter => "quarter",
            PeriodKind::HalfYear => "half_year",
            PeriodKind::Year => "year",
            PeriodKind::TwoYear => "two_year",
            PeriodKind::ThreeYear => "three_year",
            PeriodKind::Days => "days",
            PeriodKind::Onetime => "onetime",
            PeriodKind::Reset => "reset",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    /// Calendar months a period adds (None for the others). Mirrors SQL
    /// `akari_period_end`.
    pub fn months(self) -> Option<i32> {
        match self {
            PeriodKind::Month => Some(1),
            PeriodKind::Quarter => Some(3),
            PeriodKind::HalfYear => Some(6),
            PeriodKind::Year => Some(12),
            PeriodKind::TwoYear => Some(24),
            PeriodKind::ThreeYear => Some(36),
            _ => None,
        }
    }

    /// Whether `days` is required (Some(true)), optional (None) or
    /// forbidden (Some(false)) for this kind.
    fn days_rule(self) -> Option<bool> {
        match self {
            PeriodKind::Days => Some(true),
            PeriodKind::Onetime => None,
            _ => Some(false),
        }
    }
}

/// One price as the admin sets it and the views show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Price {
    pub period: PeriodKindText,
    #[serde(default)]
    pub days: Option<i32>,
    pub price_cents: i64,
}

/// `PeriodKind` that sqlx can read from TEXT (via `try_from`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PeriodKindText(pub PeriodKind);

impl TryFrom<String> for PeriodKindText {
    type Error = String;
    fn try_from(s: String) -> Result<Self, String> {
        PeriodKind::parse(&s)
            .map(PeriodKindText)
            .ok_or_else(|| format!("unknown period kind {s:?}"))
    }
}

/// Validate a complete price list (each kind at most once, sane numbers).
pub fn check_prices(prices: &[Price], on_sale: bool) -> Result<(), ApiError> {
    let mut seen = std::collections::HashSet::new();
    for p in prices {
        let kind = p.period.0;
        if !seen.insert(kind) {
            return Err(ApiError::bad_request(format!(
                "duplicate price for period {}",
                kind.as_str()
            )));
        }
        if !(1..=MAX_PRICE_CENTS).contains(&p.price_cents) {
            return Err(ApiError::bad_request(format!(
                "price_cents must be 1..={MAX_PRICE_CENTS} (integer cents)"
            )));
        }
        match (kind.days_rule(), p.days) {
            (Some(true), None) => {
                return Err(ApiError::bad_request("period \"days\" needs days"));
            }
            (Some(false), Some(_)) => {
                return Err(ApiError::bad_request(format!(
                    "period {} takes no days",
                    kind.as_str()
                )));
            }
            (_, Some(d)) if !(1..=MAX_PERIOD_DAYS).contains(&d) => {
                return Err(ApiError::bad_request(format!(
                    "days must be 1..={MAX_PERIOD_DAYS}"
                )));
            }
            _ => {}
        }
    }
    if on_sale && !prices.iter().any(|p| p.period.0 != PeriodKind::Reset) {
        return Err(ApiError::bad_request(
            "a plan on sale needs at least one price other than the reset pack",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetPricesReq {
    pub on_sale: bool,
    /// The complete price list (replaces it).
    pub prices: Vec<Price>,
}

const PRICES_SNAPSHOT_SQL: &str = "jsonb_build_object('on_sale', p.on_sale, 'prices', \
     COALESCE((SELECT jsonb_agg(jsonb_build_object('period', pp.period, 'days', pp.days, \
       'price_cents', pp.price_cents) ORDER BY pp.period) \
       FROM plan_period_prices pp WHERE pp.plan_id = p.id), '[]'::jsonb))";

/// PUT /plans/{id}/prices: replace the plan's prices and on_sale flag.
/// Existing orders keep the amounts they were created with. Audited
/// `plan.price.set`.
pub async fn apply_set_prices(
    conn: &mut PgConnection,
    actor: &Actor,
    plan_id: Uuid,
    req: &SetPricesReq,
) -> Result<(), ApiError> {
    check_prices(&req.prices, req.on_sale)?;
    let before: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {PRICES_SNAPSHOT_SQL} FROM plans p WHERE p.id = $1 FOR UPDATE"
    )))
    .bind(plan_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(before) = before else {
        return Err(ApiError::not_found());
    };
    sqlx::query("DELETE FROM plan_period_prices WHERE plan_id = $1")
        .bind(plan_id)
        .execute(&mut *conn)
        .await?;
    let kinds: Vec<&str> = req.prices.iter().map(|p| p.period.0.as_str()).collect();
    let days: Vec<Option<i32>> = req.prices.iter().map(|p| p.days).collect();
    let cents: Vec<i64> = req.prices.iter().map(|p| p.price_cents).collect();
    sqlx::query(
        "INSERT INTO plan_period_prices (plan_id, period, days, price_cents) \
         SELECT $1, k, d, c FROM unnest($2::text[], $3::int[], $4::bigint[]) AS x(k, d, c)",
    )
    .bind(plan_id)
    .bind(&kinds)
    .bind(&days)
    .bind(&cents)
    .execute(&mut *conn)
    .await?;
    sqlx::query("UPDATE plans SET on_sale = $2, updated_at = now() WHERE id = $1")
        .bind(plan_id)
        .bind(req.on_sale)
        .execute(&mut *conn)
        .await?;
    let after: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {PRICES_SNAPSHOT_SQL} FROM plans p WHERE p.id = $1"
    )))
    .bind(plan_id)
    .fetch_one(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "plan.price.set",
        "plan",
        Some(plan_id.to_string()),
        Some(before),
        Some(after),
    )
    .await?;
    Ok(())
}

pub async fn set_prices(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<SetPricesReq>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_set_prices(&mut tx, &Actor::of(&user), id, &req).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
struct PriceListRow {
    plan_id: Uuid,
    plan_name: String,
    plan_enabled: bool,
    on_sale: bool,
    prices: Value,
}

/// GET /plan-prices: every plan with its sale flag and prices.
pub async fn list_prices(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let rows: Vec<PriceListRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT p.id AS plan_id, p.name AS plan_name, p.enabled AS plan_enabled, p.on_sale, \
         {PRICES_SNAPSHOT_SQL}->'prices' AS prices FROM plans p ORDER BY p.sort, p.name"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(json!({
        "payments_enabled": state.alipay().is_some(),
        "plans": rows,
    })))
}

// ---------------------------------------------------------------------------
// Sale rules
// ---------------------------------------------------------------------------

/// What buying a (plan, period) does for the buyer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    New,
    Renew,
    Switch,
    Reset,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::New => "new",
            Action::Renew => "renew",
            Action::Switch => "switch",
            Action::Reset => "reset",
        }
    }
}

/// Why a (plan, period) cannot be bought by this user now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    NotForSale,
    SoldOut,
    RenewalOnly,
    NoSwitch,
    ResetNeedsSubscription,
    NoExpiry,
}

impl Refusal {
    pub fn error(self) -> ApiError {
        match self {
            Refusal::NotForSale => ApiError::bad_request("plan is not for sale"),
            Refusal::SoldOut => ApiError::conflict("plan is sold out"),
            Refusal::RenewalOnly => {
                ApiError::conflict("plan is only available to its current subscribers")
            }
            Refusal::NoSwitch => {
                ApiError::conflict("switching to this plan from another plan is not allowed")
            }
            Refusal::ResetNeedsSubscription => {
                ApiError::conflict("a traffic reset pack needs an active subscription of its plan")
            }
            Refusal::NoExpiry => {
                ApiError::conflict("your current plan does not expire; nothing to renew")
            }
        }
    }
}

/// A plan's sale state.
#[derive(Clone, Debug)]
pub struct Sale {
    pub plan_id: Uuid,
    pub for_sale: bool,
    pub capacity: Option<i32>,
    /// Active subscribers now.
    pub active: i64,
    pub renewal_only: bool,
    pub allow_switch_in: bool,
}

/// The buyer's active subscription: plan and whether it expires.
#[derive(Clone, Copy, Debug)]
pub struct Current {
    pub plan_id: Uuid,
    pub expires: bool,
}

/// The sale rules (pure; see the module docs).
pub fn decide(cur: Option<Current>, sale: &Sale, period: PeriodKind) -> Result<Action, Refusal> {
    if !sale.for_sale {
        return Err(Refusal::NotForSale);
    }
    match cur {
        Some(c) if c.plan_id == sale.plan_id => {
            if period == PeriodKind::Reset {
                Ok(Action::Reset)
            } else if !c.expires {
                Err(Refusal::NoExpiry)
            } else {
                Ok(Action::Renew)
            }
        }
        other => {
            if period == PeriodKind::Reset {
                return Err(Refusal::ResetNeedsSubscription);
            }
            if sale.renewal_only {
                return Err(Refusal::RenewalOnly);
            }
            if other.is_some() && !sale.allow_switch_in {
                return Err(Refusal::NoSwitch);
            }
            if sale.capacity.is_some_and(|c| sale.active >= i64::from(c)) {
                return Err(Refusal::SoldOut);
            }
            Ok(if other.is_some() {
                Action::Switch
            } else {
                Action::New
            })
        }
    }
}

/// What the buyer pays for a list price with an available credit: the
/// credit applied (never above the price) and the amount. Integer cents.
pub fn apply_credit(list_price_cents: i64, credit_cents: i64) -> (i64, i64) {
    let applied = credit_cents.clamp(0, list_price_cents.max(0));
    (applied, list_price_cents - applied)
}

/// The credit the buyer's current subscription is worth now (switching
/// plans), and the order it derives from. (0, None) without an active,
/// expiring subscription with a paid order. All arithmetic in SQL
/// (`akari_prorate`, DB clock).
pub async fn switch_credit(
    conn: &mut PgConnection,
    user_id: Uuid,
) -> sqlx::Result<(i64, Option<Uuid>)> {
    let row: Option<(Option<Uuid>, i64)> = sqlx::query_as(
        "WITH cur AS (SELECT plan_id, starts_at, expires_at FROM user_plans \
                      WHERE user_id = $1 AND status = 'active'), \
         paid AS (SELECT o.id, o.list_price_cents, o.period, o.period_days, o.fulfilled_at \
                  FROM orders o JOIN cur ON o.plan_id = cur.plan_id \
                  WHERE o.user_id = $1 AND o.status = 'paid' AND o.fulfilled_at IS NOT NULL \
                  AND o.fulfilled_at >= cur.starts_at AND o.period <> 'reset'), \
         latest AS (SELECT * FROM paid ORDER BY fulfilled_at DESC, id DESC LIMIT 1) \
         SELECT (SELECT id FROM latest), \
                akari_prorate((SELECT list_price_cents FROM latest), \
                              (SELECT akari_period_nominal_days(period, period_days) FROM latest), \
                              extract(epoch FROM cur.expires_at - now()), \
                              (SELECT sum(list_price_cents) FROM paid)::bigint) \
         FROM cur",
    )
    .bind(user_id)
    .fetch_optional(conn)
    .await?;
    Ok(match row {
        Some((Some(order), credit)) if credit > 0 => (credit, Some(order)),
        _ => (0, None),
    })
}

/// A priced (plan, period) as the buyer would get it now.
#[derive(Clone, Debug, Serialize)]
pub struct Offer {
    pub period: PeriodKind,
    pub days: Option<i32>,
    pub price_cents: i64,
    /// What would be charged now (price - credit); null when refused.
    pub amount_cents: Option<i64>,
    pub credit_cents: i64,
    /// Credit beyond the price (lost when switching to a cheaper plan).
    pub forfeited_cents: i64,
    pub action: Option<Action>,
    pub refusal: Option<Refusal>,
}

impl Offer {
    pub fn of(cur: Option<Current>, sale: &Sale, price: &Price, credit_available: i64) -> Offer {
        let period = price.period.0;
        match decide(cur, sale, period) {
            Ok(action) => {
                let credit = if action == Action::Switch {
                    credit_available
                } else {
                    0
                };
                let (applied, amount) = apply_credit(price.price_cents, credit);
                Offer {
                    period,
                    days: price.days,
                    price_cents: price.price_cents,
                    amount_cents: Some(amount),
                    credit_cents: applied,
                    forfeited_cents: credit - applied,
                    action: Some(action),
                    refusal: None,
                }
            }
            Err(r) => Offer {
                period,
                days: price.days,
                price_cents: price.price_cents,
                amount_cents: None,
                credit_cents: 0,
                forfeited_cents: 0,
                action: None,
                refusal: Some(r),
            },
        }
    }
}

/// The buyer's active subscription (plan, expiry), if any.
pub async fn current(
    conn: &mut PgConnection,
    user_id: Uuid,
) -> sqlx::Result<Option<(Uuid, String, Option<DateTime<Utc>>)>> {
    sqlx::query_as(
        "SELECT up.plan_id, p.name, up.expires_at FROM user_plans up JOIN plans p \
         ON p.id = up.plan_id WHERE up.user_id = $1 AND up.status = 'active'",
    )
    .bind(user_id)
    .fetch_optional(conn)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sale(plan: Uuid) -> Sale {
        Sale {
            plan_id: plan,
            for_sale: true,
            capacity: None,
            active: 0,
            renewal_only: false,
            allow_switch_in: true,
        }
    }

    #[test]
    fn period_kinds_round_trip() {
        for k in PeriodKind::ALL {
            assert_eq!(PeriodKind::parse(k.as_str()), Some(k));
            let j = serde_json::to_string(&k).unwrap();
            assert_eq!(j, format!("\"{}\"", k.as_str()));
        }
        assert_eq!(PeriodKind::parse("monthly"), None);
        assert_eq!(PeriodKind::parse(""), None);
    }

    #[test]
    fn price_validation() {
        let p = |k: PeriodKind, days: Option<i32>, c: i64| Price {
            period: PeriodKindText(k),
            days,
            price_cents: c,
        };
        assert!(check_prices(&[p(PeriodKind::Month, None, 990)], true).is_ok());
        assert!(check_prices(&[], false).is_ok());
        for (bad, on_sale) in [
            (vec![], true),
            (vec![p(PeriodKind::Reset, None, 100)], true),
            (vec![p(PeriodKind::Month, None, 0)], false),
            (vec![p(PeriodKind::Month, None, MAX_PRICE_CENTS + 1)], false),
            (vec![p(PeriodKind::Month, Some(30), 1)], false),
            (vec![p(PeriodKind::Days, None, 1)], false),
            (vec![p(PeriodKind::Days, Some(0), 1)], false),
            (vec![p(PeriodKind::Onetime, Some(3651), 1)], false),
            (
                vec![p(PeriodKind::Year, None, 1), p(PeriodKind::Year, None, 2)],
                false,
            ),
        ] {
            assert!(check_prices(&bad, on_sale).is_err(), "{bad:?} {on_sale}");
        }
        assert!(check_prices(&[p(PeriodKind::Onetime, None, 1)], true).is_ok());
        assert!(check_prices(&[p(PeriodKind::Onetime, Some(7), 1)], true).is_ok());
        assert!(check_prices(&[p(PeriodKind::Days, Some(3650), 1)], true).is_ok());
    }

    #[test]
    fn sale_rules() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let on_a = Some(Current {
            plan_id: a,
            expires: true,
        });
        let on_a_forever = Some(Current {
            plan_id: a,
            expires: false,
        });
        let s = sale(a);
        assert_eq!(decide(None, &s, PeriodKind::Month), Ok(Action::New));
        assert_eq!(decide(on_a, &s, PeriodKind::Year), Ok(Action::Renew));
        assert_eq!(decide(on_a, &s, PeriodKind::Reset), Ok(Action::Reset));
        assert_eq!(
            decide(on_a_forever, &s, PeriodKind::Month),
            Err(Refusal::NoExpiry)
        );
        // A permanent subscription can still buy its reset pack.
        assert_eq!(
            decide(on_a_forever, &s, PeriodKind::Reset),
            Ok(Action::Reset)
        );
        assert_eq!(
            decide(None, &s, PeriodKind::Reset),
            Err(Refusal::ResetNeedsSubscription)
        );
        let sb = sale(b);
        assert_eq!(decide(on_a, &sb, PeriodKind::Month), Ok(Action::Switch));
        assert_eq!(
            decide(on_a, &sb, PeriodKind::Reset),
            Err(Refusal::ResetNeedsSubscription)
        );
        let no_switch = Sale {
            allow_switch_in: false,
            ..sale(b)
        };
        assert_eq!(
            decide(on_a, &no_switch, PeriodKind::Month),
            Err(Refusal::NoSwitch)
        );
        assert_eq!(decide(None, &no_switch, PeriodKind::Month), Ok(Action::New));
        let renewal = Sale {
            renewal_only: true,
            ..sale(a)
        };
        assert_eq!(
            decide(None, &renewal, PeriodKind::Month),
            Err(Refusal::RenewalOnly)
        );
        assert_eq!(decide(on_a, &renewal, PeriodKind::Month), Ok(Action::Renew));
        let full = Sale {
            capacity: Some(2),
            active: 2,
            ..sale(a)
        };
        assert_eq!(
            decide(None, &full, PeriodKind::Month),
            Err(Refusal::SoldOut)
        );
        // Holders renew a full plan; capacity 0 = closed to newcomers.
        assert_eq!(decide(on_a, &full, PeriodKind::Month), Ok(Action::Renew));
        let closed = Sale {
            capacity: Some(0),
            ..sale(b)
        };
        assert_eq!(
            decide(on_a, &closed, PeriodKind::Month),
            Err(Refusal::SoldOut)
        );
        let off = Sale {
            for_sale: false,
            ..sale(a)
        };
        assert_eq!(
            decide(on_a, &off, PeriodKind::Month),
            Err(Refusal::NotForSale)
        );
    }

    #[test]
    fn credit_application() {
        assert_eq!(apply_credit(1000, 0), (0, 1000));
        assert_eq!(apply_credit(1000, 300), (300, 700));
        assert_eq!(apply_credit(1000, 1000), (1000, 0));
        // Never negative: the excess is forfeited.
        assert_eq!(apply_credit(1000, 2500), (1000, 0));
        assert_eq!(apply_credit(1000, -5), (0, 1000));
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let price = Price {
            period: PeriodKindText(PeriodKind::Month),
            days: None,
            price_cents: 990,
        };
        let cur = Some(Current {
            plan_id: a,
            expires: true,
        });
        let o = Offer::of(cur, &sale(b), &price, 1500);
        assert_eq!(
            (o.amount_cents, o.credit_cents, o.forfeited_cents),
            (Some(0), 990, 510)
        );
        // Renewals never use credit.
        let o = Offer::of(cur, &sale(a), &price, 1500);
        assert_eq!((o.amount_cents, o.credit_cents), (Some(990), 0));
        let o = Offer::of(
            None,
            &Sale {
                renewal_only: true,
                ..sale(b)
            },
            &price,
            0,
        );
        assert_eq!(
            (o.amount_cents, o.refusal),
            (None, Some(Refusal::RenewalOnly))
        );
    }
}
