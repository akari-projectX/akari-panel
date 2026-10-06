# Payments: payment methods (Alipay Face-to-Face first)

R18-3 / W24 (R40). The panel sells plans through **payment methods**
configured in 系统设置 → 支付 (database only, no panel.toml). A method is a
configured instance of a **provider kind**; the first and for now only kind
is **Alipay Face-to-Face** (`alipay_f2f`: `alipay.trade.precreate` → QR
code). Several methods of one kind are allowed (two Alipay merchants).
Code: `src/billing/` (`provider.rs` traits + registry, `methods.rs`
methods/API/reload/legacy import, `alipay.rs` the Alipay kind; W7
catalogue: `catalog.rs`); migrations `0040_billing.sql`,
`0070_plan_catalog.sql`, `0140_payment_methods.sql`; SPA:
`spa/src/pages/purchase.tsx`, `orders.tsx`, `admin-orders.tsx`,
`admin-plans.tsx` (prices), `admin-payments.tsx` (系统设置 → 支付).

## How it works

1. An admin prices a plan per period (`PUT /api/v1/plans/{id}/prices`
   `{on_sale, prices: [{period, days?, price_cents}]}`; SPA: 套餐 → 定价).
   Money is **integer CNY cents** everywhere. A plan is for sale when
   `plans.enabled`, `on_sale` and it has a price for the requested period
   (see "Periods" below).
2. A user buys (`POST /api/v1/me/orders {plan_id, period}`). The server
   decides what the purchase is (new / renew / switch / reset pack, or a
   refusal: sold out, renewal-only, switching not allowed, …), computes the
   amount (the period's price minus any switch credit) and writes the
   order row first with `period`, `list_price_cents`, `credit_cents`,
   `credit_order_id` and `amount_cents` — the client never sends an
   amount, and `GET /me/shop` shows exactly this computation beforehand.
   An order whose credit covers the whole price is paid at once (`paid_via
   = credit`, same `apply_mark_paid` path) and never reaches Alipay.
   Otherwise the order is bound to a **payment method** (`method_id` in the
   request; may be omitted when exactly one method is enabled — the portal
   then skips the picker; `order.method_required` /
   `order.method_unavailable` otherwise), stored as
   `orders.payment_method_id`, and the panel calls `alipay.trade.precreate`
   (`timeout_express` = `order_timeout_minutes`, default 15) and returns
   the QR payload. The SPA renders the QR locally (no CDN). One open order
   per user: a new order ends the previous pending one (queried and closed
   at Alipay first).
3. The payment becomes known by any of:
   - the **async notify** (`POST /{prefix}/pay/{method_id}/notify`; the
     pre-R40 `/{prefix}/pay/alipay/notify` stays for older orders),
   - **status polling** (`GET /api/v1/me/orders/{id}` queries the order's
     method (`alipay.trade.query`) for a pending order, at most every 3 s
     per order across all instances),
   - the **reconcile** (every instance, every 10 s: pending orders not
     queried in the last 20 s are queried, each at its own method;
     `FOR UPDATE SKIP LOCKED` + a claim timestamp keep instances from
     duplicating work). An order whose method is disabled (or unusable) is
     not queried; once past its expiry + the close grace it ends with
     `close_state = method_unavailable` (no remote call).
4. Every path ends in `orders::apply_mark_paid`: `entitle::lock` →
   conditional `UPDATE orders SET status='paid' ... WHERE status <> 'paid'`
   → fulfilment via the M3 `plans::apply_*` functions → audit, **one
   transaction**. Only the transaction whose UPDATE flips the row fulfils:
   replayed notifies, concurrent notify + query and several instances
   fulfil exactly once (tests: `billing::tests::concurrent_duplicates_fulfil_once`).

### Periods (W7)

Each plan has at most one price per period kind (`plan_period_prices`);
every price is optional, and `on_sale` needs at least one that is not the
reset pack. Period arithmetic is SQL only (`akari_period_end`, DB clock):

| `period` | Adds | Nominal days (proration) |
|---|---|---|
| `month` / `quarter` / `half_year` / `year` / `two_year` / `three_year` | 1 / 3 / 6 / 12 / 24 / 36 calendar months of the site time zone (Q3, 系统设置 → 站点 → 时区, default Asia/Shanghai: a month bought on the 1st, local time, ends on the 1st); the day clamps to the month's end (Jan 31 + 1 month = Feb 28/29) | 30 / 90 / 180 / 365 / 730 / 1095 |
| `days` (`days` = N, 1–3650) | N × 86400 s (the R18-3 single price migrated to this) | N |
| `onetime` (`days` = N or null) | N days, or **no expiry** when `days` is null | N (none when permanent) |
| `reset` | traffic reset pack: zeroes the used traffic of the current plan; no period change, the reset schedule is untouched | — |

### What a purchase does

| The user's active plan | Buying plan P, period X |
|---|---|
| none | `new`: P for one X from now, usage reset. Refused for `renewal_only` plans and when P is full (`capacity`). |
| P with an expiry | `renew`: expiry = one X after max(expiry, now) (`onetime` without days makes it permanent); reset anchor unchanged; usage unchanged — except a one-time term or a plan without periodic resets, which starts a fresh quota (中-1). Allowed when P is full or renewal-only. |
| P without expiry | renewal refused (409 "nothing to renew"); the reset pack is still allowed. |
| P, X = `reset` | `reset`: used traffic → 0; a user disabled for quota is re-enabled (never an admin-disabled one); audited `user.traffic.reset` with `source: reset_pack`. Only for current subscribers of P — this is what quota-exhausted users (R21 renewal scope) buy. |
| another plan Q | `switch`: replaces Q (M3 replace semantics, **usage reset**), P for one X from now, charged P's full price **minus the switch credit**. Refused when P has `allow_switch_in = false`, is `renewal_only`, or is full. |

### Switching plans: the credit

The credit is the unused value of the current subscription, computed in SQL
(`catalog::switch_credit` → `akari_prorate`) when the order is created:

```
latest  = the newest paid, fulfilled, non-reset, NOT refunded order of the
          user for the current plan, fulfilled since the current
          subscription started
value   = list_price − discount − gift  (what was actually paid: gateway
          amount + balance + the credit it carried; High-2)
credit  = floor(value(latest) × remaining_seconds / (nominal_days(latest) × 86400))
credit  = min(credit, Σ value of all such orders)   -- never more than was paid
credit  = min(credit, floor(Σ value × traffic_left / quota))   -- High-1, quota plans only
credit  = 0 when there is no such order (admin-assigned), no expiry,
          nothing remaining, or a permanent one-time purchase
amount  = price − min(credit, price)        -- never negative
```

运营规则（运营逻辑审查 高-2）：折算按**实付价值**算——优惠券折扣和管理员赠送（`gift_cents`）
不算价值，已退款的订单不参与折算（既不是最新一单，也不计入封顶）。所以「券只限套餐 A」不能
靠换套餐变成别的套餐的价值，「赠送 A」也不会变成可换任意套餐的余额。最新一单是赠送（价值 0）
时折算为 0（保守取值，只会少折、不会多折）。

运营规则（运营逻辑审查高-1，lead 定的默认值）：折算 = 实付 × min(剩余时间比例, 剩余流量比例)。
有流量额度的订阅（`users.traffic_limit_bytes`，即当前订阅的执行额度）按「剩余流量 / 额度」再打一次
折：流量用完的订阅不值钱，来回换套餐不能只花时间的钱就买到满额流量。新套餐从零开始计流量。
有周期重置的长订阅按**当前周期**的剩余比例计（只会少折）。不限流量的套餐只按时间算。

Example: 30.00 for a month, switched with 15 days left → 15.00 credit; a
50.00 plan then costs 35.00. A credit larger than the new price is
**forfeited** (no balance, no refunds) — the shop says so before buying
(`forfeited_cents`) and the order is paid by the credit. The credit is
fixed in the order at creation (orders expire after
`order_timeout_minutes`); if the subscription it came from is no longer the
one replaced at fulfilment, the payment is still honoured and
`fulfil_result.credit_source_changed = true` flags it for review.

### Stock and sale rules

- `capacity` (max active subscribers, null = unlimited) is checked at order
  creation and again, authoritatively, at fulfilment under
  `entitle::lock`. Pending orders reserve nothing: two buyers can pay for
  the last slot; one is fulfilled, the other stays **paid with
  `fulfil_error` "plan is sold out"** (money kept; the admin raises the
  capacity and retries, or refunds out of band). Admin assignment (PUT
  /users/{id}/plan) ignores capacity and sale rules.
- `renewal_only`: hidden from the shop for everybody except its holders;
  holders renew and buy its reset pack.
- `allow_switch_in = false`: holders of another plan cannot switch to it
  (newcomers can buy it).
- `speed_limit_mbps` is enforced by the agent (see README "Plans and node
  groups"); `device_seats` is not enforced until the client ships (R25).

Traffic resets inside the period follow the plan's `reset_period` (M3
period pass). 运营规则（运营逻辑审查中-1）：续费**不重置**流量的套餐（`reset_period = none`）或一次性
（`onetime`）时长时，新的一期从满额流量开始（已用清零、因超额被停用的账户恢复、记
`last_reset_at`）——否则用完流量的用户付了续费仍然连不上。按月重置的套餐续费仍只延长时间
（流量由周期重置处理）；流量重置包照旧可单独购买。

### Late payments, failures, refunds

- An order that expired or was cancelled locally but is reported paid
  (notify or query) is still fulfilled: Alipay took the money.
- If fulfilment fails for a business reason (plan deleted or disabled,
  plan sold out, reset pack for a plan the user no longer holds, user
  deleted or now an admin) the order stays **paid** with
  `fulfil_error`; Alipay still gets `success`. Admin: 订单 → 状态「已付款未开通」
  → 详情 → 重试开通 (reason required, audited `order.fulfil.retry`).
- Manual mark-paid (support case, e.g. a payment proven out of band):
  same button on an unpaid order; `paid_via = manual`, reason stored and
  audited.
- **Refunds** of the Alipay amount happen in the Alipay merchant console;
  the panel records them (W16, 订单 → 退款, see "Refunds (admin)" below),
  returns the balance part and, if chosen, credits the amount to the
  balance instead; P1: the order's effect on the subscription is undone in
  the same transaction (unless 仅退款).
- Expiry: the reconcile queries a pending order past `expires_at`; paid →
  fulfilled, otherwise `alipay.trade.close` (best effort) and the order
  becomes `expired`. While the gateway is unreachable the order stays
  pending and is retried; after 1 h it is expired anyway (`close_state =
  failed`; a later notify still fulfils it).

## Coupons, balance, invite commission (W16, M7)

Code: `src/billing/{coupons,ledger,commission}.rs`; migrations
`0105_inviter.sql` … `0108_commissions.sql`; SPA: purchase page (coupon
field, "pay with my balance"), portal `wallet.tsx` (余额 + 我的邀请), console
`admin-coupons.tsx` (优惠券), `admin-finance.tsx` (资金), refund in
`admin-orders.tsx`.

### How the amount is split

An order's list price (the period's price) is covered, **in this order**:

```
discount = coupon on the LIST price      percent: floor(list × p / 100); fixed: min(value, list)
credit   = min(switch credit, list − discount)            excess forfeited (W7 rule)
balance  = min(user's balance, list − discount − credit)  only when the buyer asks (use_balance)
amount   = list − discount − credit − balance  ≥ 0        what Alipay is asked for
```

All of it is computed by the server in SQL (`akari_coupon_discount`,
`akari_split`) at order creation and copied into the order
(`discount_cents`, `coupon_id`/`coupon_code`, `credit_cents`,
`balance_cents`, `amount_cents`); the `orders` CHECK enforces
`amount = list − credit − discount − balance ≥ 0` for every row. The client
sends `{plan_id, period, coupon?, use_balance?}` — never an amount — and the
shop (`GET /me/shop?coupon=&use_balance=`) shows the same split beforehand.
An amount of 0 is paid at creation through `apply_mark_paid` (`paid_via`
`balance` when the balance took part, else `credit`, else `coupon`) and
never reaches Alipay.

Why this order: the coupon is a promotion on the advertised price
("20% off ¥30" is ¥6 whatever the buyer's situation), so it is computed on
the list price, independent of the credit; the switch credit is the buyer's
own value and covers what is left; the balance, the buyer's money, is used
last and only as far as needed. Nothing can turn negative: each part is
capped at what is left, and the CHECK is the backstop.

The commission base is **the Alipay amount only** (`amount_cents`): coupon,
switch credit and balance parts earn nothing (no commission on commission
paid back in, no commission on discounts).

### Coupons

| Field | Meaning |
|---|---|
| `code` | 3–32 of `[A-Za-z0-9_-]`, unique **case-insensitively**, entered in any case, immutable |
| `kind`, `value` | `percent` 1–100 (% off the list price, floored to the fen) or `fixed` fen (capped at the list price) |
| `plan_ids`, `periods` | scope; null = every plan / period kind (the reset pack included) |
| `min_amount_cents` | the list price must be at least this |
| `starts_at`, `ends_at` | validity window, DB clock (`ends_at` exclusive) |
| `max_uses` | total uses (null = unlimited); `used` counts reservations of pending orders + redemptions |
| `per_user_limit` | uses per buyer (pending orders count) |
| `new_users_only` | only for buyers without any paid order yet |
| `enabled` | off = "invalid coupon code" |

**Reservation, race-free (decision)**: the use is **reserved at order
creation and released when the order ends unpaid**, rather than counted at
fulfilment. Counting at fulfilment would let two buyers pay for the last use
and leave one of them paid at a price the coupon no longer allowed;
reserving makes the last use go to exactly one buyer before anyone pays.
Order creation takes `entitle::lock` (the lock apply_mark_paid starts
with), then the coupon row `FOR UPDATE`, re-checks every rule under that
lock (the per-user count after the lock, so a buyer racing herself is
serialised too), then `UPDATE coupons SET used = used + 1 WHERE … AND (max_uses
IS NULL OR used < max_uses)` and inserts `coupon_redemptions` (`reserved`)
in the order's transaction; `CHECK (used <= max_uses)` is the backstop. N
buyers racing for the last use: exactly one order is created with it, the
others get 409 "coupon has been used up"
(`billing::tests::w16::coupon_last_use_race_and_per_user_limit`).

- An order that ends unpaid (cancel, a new order replacing it, expiry,
  precreate failure) releases the reservation in the transaction that ends
  it (`orders::release_holds`): `released`, `used − 1`.
- A paid order redeems it inside `apply_mark_paid` (`redeemed`).
- A **late payment** of an ended order (Alipay took the discounted amount)
  re-reserves the use if one is free; if the coupon is used up by then the
  payment is honoured anyway: `redeemed` with `over_limit = true` (not
  counted; flagged in the order's `order.paid` audit row and the coupon's
  redemptions for review).
- A coupon that discounts 0 fen on a given order (1% of a few fen) is not
  applied to it (no reservation).
- Coupons used by any order cannot be deleted (409: disable them).
- The shop preview with a code is rate-limited per user (30 / 10 min) against
  code guessing; order creation has its own limit (20 / h).

### Balance (余额)

`user_balances.balance_cents` (materialised) changes **only** through an
INSERT into the append-only `balance_ledger`: the ledger's trigger applies
the amount under the balance row's lock and refuses a negative result
(SQLSTATE `AK003` → 409 "insufficient balance"); a guard trigger refuses any
other write of the column; ledger rows cannot be updated or deleted (only
`user_id → NULL` when the user is deleted; the non-personal `user_label`
snapshot — `u-` + the first 8 hex digits of the id, never the address —
stays). So
`balance = sum(ledger) ≥ 0` for every user, at every commit, whoever writes.
Every movement is written by `ledger::apply_entry`: **one ledger row + one
`balance.<kind>` audit row, in the transaction of its cause**.

| kind | sign | when |
|---|---|---|
| `admin_adjust` | ± | 资金 → 用户余额 → 调整 (`POST /users/{id}/balance {amount_cents, reason}`), customers only |
| `order_payment` | − | the balance part of an order, at creation (held); or re-taken by a late payment |
| `refund_to_balance` | + | the held balance part of an order that ended unpaid; an admin refund to balance |
| `commission` | + | an invite commission past its hold |
| `commission_clawback` | − | 中-4: a refunded order's credited commission taken back from the inviter (at the refund, as far as the balance goes; the rest out of the next commissions) |
| `withdrawal` | − | a withdrawal request (funds held until decided) |
| `withdrawal_reversal` | + | a rejected or cancelled withdrawal |

Paying with the balance (`use_balance: true`): as much of the remainder as
the balance holds is debited when the order is created (`balance_state`
`held`). If that covers it, the order is paid at once; otherwise Alipay is
asked for the rest. When the order ends unpaid, the balance part goes back
(`refunded`). A late payment of such an order re-takes it inside the
fulfilment savepoint; if the balance no longer covers it the order stays
**paid with `fulfil_error` "insufficient balance"** (never a negative
balance): top the balance up and 重试开通, or refund.

### Invite commission (邀请返利)

Settings (资金 → 邀请返利设置, `PUT /commission-settings`, audited
`commission.settings.update`): `enabled`, `rate_percent` (0–100),
`first_order_only`, `hold_days` (0–365), `min_withdrawal_cents`.

- Attribution: `users.inviter_id` (set at registration with an invite code —
  W15; migration 0105 only guarantees the column and that it never expresses
  a self-referral or a cycle, trigger `users_inviter_acyclic`, SQLSTATE
  `AK002` → 409). Only customer (`role=user`) inviters earn.
- When an invited customer's order is paid (inside `apply_mark_paid`, so
  exactly once — `commissions.order_id` is UNIQUE too): if the programme is
  enabled and the Alipay amount is > 0 (and, with `first_order_only`, it is
  the invitee's first paid order with an Alipay amount), a **pending**
  commission of `floor(amount_cents × rate / 100)` is created, available
  `hold_days` after the payment. It is created even when fulfilment failed
  (the money was received); a refund reverses it.
- An enforce pass (every instance, every flush tick, `FOR UPDATE SKIP
  LOCKED`, conditional on `pending`) credits due commissions to the
  inviter's balance (ledger `commission`) exactly once
  (`billing::tests::w16::commission_exactly_once_under_duplicates`). An
  inviter deleted meanwhile → reversed.
- An admin refund within the hold reverses the pending commission
  (`commission.reverse`).
- 运营规则（运营逻辑审查中-4）：冻结期**之后**退款也会追回已入账的返利（`commission.clawback`）：
  邀请人余额够就当场扣回（明细 `commission_clawback`，负数，只追加）；不够（例如已经提现）
  只扣到 0（余额永不为负），差额记为欠款（`commissions.clawback_cents` − `clawback_recovered_cents`），
  之后该邀请人的新返利入账时**先抵扣欠款**；可提现金额把整笔追回都扣掉，所以欠款永远提不出来。
  退款确认框（`refund-preview` 的 `commission`）显示「将撤销 / 将追回、当场可扣回多少」。

### Withdrawals (提现)

Withdrawable = min(balance, credited commissions − clawed-back commissions
(中-4) − withdrawals not rejected or cancelled): refunds and admin credits are
spendable on plans, not cash.
A request (`POST /me/withdrawals {amount_cents, method, account}`, at least
`min_withdrawal_cents`, one open request per user) debits the amount at once
(ledger `withdrawal`). The admin pays out by hand (Alipay/WeChat/bank) and
then approves with the payout reference (资金 → 提现审核), or rejects with a
reason (ledger `withdrawal_reversal`); the user may cancel while pending.
Withdrawals of a deleted user can only be approved.

### Refunds (admin) / 退款（管理员）

订单 → 详情 → 退款（`POST /orders/{id}/refund {reason, to_balance, external_cents?, keep_plan?}`），
只对已付款订单、只能退一次，一个事务内完成：

- **钱**：订单扣的余额部分总是退回余额；勾选「也退到余额」（`to_balance`）时
  支付宝实付部分也记入余额（两者合为一行 `refund_to_balance` 明细），否则请在
  支付宝商家后台原路退款，并在面板填写**实际退款金额**（`external_cents`，0 到实付金额；
  有实付金额时必填，运营审查中-3：以前登记为 0，仪表盘与导出漏记）。订单记录
  `refund_balance_cents`（退到余额）、`refund_external_cents`（支付宝后台已退），
  `refund_cents` = 两者之和；仪表盘「退款」与订单 CSV（两列分开）都按它统计。
  待结算的邀请返利撤销，已入账的追回（中-4，见上文「Invite commission」）。
- **优惠券与首单（低-2）**：退款把该订单用掉的优惠券次数还回去（券的总次数与该用户的
  每人次数都减一；超限兑现的本来就没计数）。已退款的订单不再算「已购买」：新人券对他重新
  可用，邀请返利的「仅首单」也不把它算作首单。
- **套餐（P1）**：默认同时撤销该订单对订阅的效果，写审计 `user.plan.refund`：
  - 新购：结束该订阅（状态 `cancelled`），用户的节点凭据随即撤销，agent 断开其连接；
  - 续费：到期时间回退该订单增加的时长（开通时记录 `base`，回退量 = 本单到期 −
    `base`）；回退后不晚于当前时间则结束该订阅；
  - 换套餐（含补差价升级）：结束新订阅，恢复换之前的订阅（原套餐、原到期时间；
    换之前已用的流量加回当前用量）；原订阅在此期间已过期则只结束新订阅；
  - 流量重置包：只退钱（已用流量无法撤销）；
  - 订单未开通、或它开通/续费的订阅已不是当前订阅（之后又换了套餐等）：只退钱。
- 勾选「仅退款（保留套餐）」（`keep_plan: true`）则只退钱，套餐不动。
- **退款通知邮件**：同一事务（savepoint，发信失败不影响退款）给用户发 `refund` 邮件：退款总额、
  退回余额 / 原路退回的金额、套餐被怎样处理（已取消 / 到期时间回退到 X / 恢复原套餐 /
  不受影响 / 未开通）。系统设置 → 邮件 →「订单退款通知」开关（`notify_refund`，默认开）；
  只发已验证邮箱；模板可在「邮件模板」里改（种类 `refund`，`{order_no}` 必填）。
- 确认框里的效果来自 `GET /orders/{id}/refund-preview`（`{balance_part_cents,
  amount_cents, effect}`，`effect.kind` = `none`（带 `why`）/`cancel`/`rollback`/
  `restore`），与实际执行用同一段计算；已退款或未付款的订单 409。
- 退款后订单不能再「重试开通」。订单详情显示 `refund_effect`（套餐被怎样处理）。
  审计 `order.refund`（含 `effect`）。

### Manual orders (Ops)

`POST /orders/manual {user_id, plan_id, period, gift?, reason}` (console:
订单 → 新建人工订单) records a sale made outside the gateway, or a gift.
It is **not a new pay path**: the order row is created like a customer's
(the period's price is read from `plan_period_prices` in SQL and copied
into `list_price_cents`; the request carries no amount and an
`amount_cents` member is a 400) and is then paid in the same transaction
by `orders::apply_mark_paid(…, Via::Manual, …, reason)` — `entitle::lock`,
the conditional flip (exactly once), fulfilment under its savepoint,
`order.paid` audit. A gift sets `gift_cents` = the list price (migration
0166; the amount identity becomes `amount = list − credit − discount −
balance − gift`), so `amount_cents` = 0 and revenue (the sum of
`amount_cents`) is unchanged. A paid manual order is revenue flagged
`paid_via = 'manual'`: the dashboard reports `manual_cents` and
`gift_cents` per window, the orders list filters `?via=manual`, the CSV
has a `manual` column. Unlike a gateway payment, a manual order whose
fulfilment fails (plan gone, sold out, reset pack without the plan) is
rolled back whole (409 `order_admin.manual_not_fulfilled`); a user with a
pending order gets 409 `order_admin.user_has_pending`. An invite
commission applies to a paid (non-gift) manual order as to any payment.

### Batch coupons (Ops)

`POST /coupon-batches` generates N (≤5000) codes sharing one template:
`prefix` (0–16 of `A-Za-z0-9_-`) + `length` (6–16, default 10) characters
from the OS CSPRNG over `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I; 32
symbols, 5 bits each, no modulo bias). Every code is an ordinary
`coupons` row with `batch_id` (migration 0167), so eligibility, the
race-safe reservation at order creation, release and redemption are the
W16 path unchanged; uniqueness is the `coupons_code` unique index
(`ON CONFLICT DO NOTHING`, collisions re-drawn, bounded rounds). Per-code
uses default to 1. The single-coupon list hides batch codes; the batch
list shows codes/used/redeemed, exports the codes as CSV, and revoking
disables every code (reservations already made stand).

### Lock order

`entitle::lock` (order creation and `apply_mark_paid`) → `orders` row →
`coupons` / `coupon_redemptions` → `commissions` → `user_balances` →
`withdrawals`. The commission pass and withdrawals never take an earlier
lock after a later one.

## Configuration (系统设置 → 支付)

**UI setup is the only path** (database, all instances at once; no restart):

1. 系统设置 → 支付 → 添加支付方式 → 支付宝当面付.
2. 名称 (shown to payers when more than one method is enabled), 排序.
3. 环境: 正式 (`https://openapi.alipay.com/gateway.do`), 沙箱
   (`https://openapi-sandbox.dl.alipaydev.com/gateway.do`) or 自定义网关
   (https; http only to loopback — test mocks).
4. APPID, 商户 PID (optional; when set, notifies must carry it), 订单有效期
   (5–120 minutes).
5. 应用私钥: paste (PEM or the bare base64 Alipay's key tool writes,
   PKCS#8 or PKCS#1) or load the file in the browser. It is validated (RSA,
   ≥ 2048 bits), then stored sealed (AES-256-GCM, key derived from
   `data/master.key` with the label `akari/payment-secrets-aead/v1`, AAD = the
   method id) and **never returned**: the page shows 已设置 + the app public
   key's SHA-256 fingerprint and the derived **应用公钥** (SPKI base64) to
   upload to the Alipay open platform. Leave it empty when editing to keep it.
6. 支付宝公钥: paste Alipay's public key (not the app's: pasting the app
   public key or any private key is refused with a coded error).
7. 启用, 保存, then **测试连接**: one `alipay.trade.query` of a random
   `out_trade_no`. Alipay answers `ACQ.TRADE_NOT_EXIST` only after checking
   the APPID and our signature (= the app private key matches the 应用公钥
   registered at Alipay) and signs that answer with its key (= the
   configured 支付宝公钥 is right): `keys_ok`. Other outcomes, in Chinese:
   APPID invalid / wrong environment, request signature rejected (upload
   the shown 应用公钥), response signature invalid (wrong 支付宝公钥),
   gateway unreachable / HTTP error. Tested against the real sandbox
   2026-10-03: `keys_ok`.

Rules (`billing::methods`, `provider::ProviderKind::validate`):

- Every change is versioned (`version`, stale form → 409
  `settings.version_conflict`) and audited (`payment_method.create` /
  `.update` / `.delete` / `.import`; secret fields only as `"changed"`, the
  non-secret config — public keys, APPID — in clear). The 0060 trigger
  function notifies every instance, which rebuilds the changed method's
  client and swaps the whole set atomically; a call in flight keeps the
  client it took. Enabling requires a configuration that builds.
- A method used by any order cannot be deleted (409
  `payments.method_in_use`): disable it. Disabling stops new orders, the
  notify route (canonical rejection) and the reconcile for its pending
  orders; paid orders are unaffected.
- **Key rotation.** Orders never store keys, so in-flight orders keep
  working across a key change. A new 应用私钥 takes effect at once (upload
  the new 应用公钥 at Alipay first, or requests fail until you do). A
  replaced **支付宝公钥** stays valid for verification (notifies and
  gateway responses) for 48 hours (`PREV_KEY_GRACE_HOURS`; Alipay retries a
  notify for ~25 h), so a notify signed with the old key just before the
  rotation still settles its order; after the grace it is refused like any
  bad signature (polling/the reconcile then use the new key). Changing the
  APPID of a method strands its pending orders' notifies (`app_id`
  mismatch → refused); polling/reconcile query with the new APPID. Prefer
  adding a new method for a new merchant.
- **Notify URL** (shown read-only): `<main domain>/<route prefix>/pay/<method id>/notify`,
  the main domain of 系统设置 → 站点 (W25: the only source; an old
  `install.public_url` is imported there once). It is sent
  with every precreate, so nothing is configured at Alipay, and it follows
  a domain change and `rotate-prefix` by itself. With no main domain
  configured, orders that need the provider are refused (503 "payments are
  not enabled", no order row; fully covered orders still work) and 系统设置
  / startup warn. Orders created before a main domain change carry the old
  URL; the host gate then refuses notifies to the old name, and
  polling/the reconcile fulfil those orders. It contains the secret prefix:
  never logged.
- Public-key mode, **RSA2** only (certificate mode is not supported).
- Alipay must reach the notify URL over the internet (HTTPS through your
  reverse proxy; only the prefix is forwarded, see DEPLOY.md). If it
  cannot (development, firewalls), payments are still detected through
  polling and the reconcile — notify only makes it faster.
- The panel connects to the gateway directly (no HTTP proxy support) with
  the webpki root store.

**Upgrading from panel.toml (obsolete `[payments.alipay]`).** The section is
no longer part of the configuration. An old file still starts: on the
first start with **no payment method** in the database the section (and
its two key files) is imported once into an Alipay method named 支付宝
(audit `payment_method.import`, actor `system`, key sealed as above), and
every pre-0140 order (`payment_method_id` NULL, amount > 0) is assigned to
it; the log says to delete the section. Afterwards it is ignored with a
startup warning, `config check` reports it as obsolete, and 系统设置 → 支付
shows a warning while it is present. If the key files cannot be read the
import is skipped (warning) and the start goes on: configure the method in
the UI. The old explicit `notify_url` is gone; orders created before the
upgrade keep their old URL `/{prefix}/pay/alipay/notify`, which is still
accepted (below).

### Adding a provider kind (developers)

Implement `provider::PaymentProvider` (create → QR or redirect URL, query,
close, verify_notify, notify_ack, optional refund, test_connection) and
`provider::ProviderKind` (id, Chinese label, form schema, validate with
secret fields kept when absent, build, view without secrets,
peek_out_trade_no), add it to `provider::KINDS`, widen the
`payment_methods.kind` CHECK in a new migration, and extend the SPA's
error mappings if the kind adds error codes. The money rules stay in
`orders.rs`/`api.rs` and do not change per kind.

## Notify endpoint rules

`POST /{prefix}/pay/{method_id}/notify` (per method; unknown, malformed or
disabled method ids are the canonical rejection) and the legacy
`POST /{prefix}/pay/alipay/notify` (pre-R40 orders: the claimed
`out_trade_no` selects the order and thus its method, which must be a
usable Alipay method). Form-encoded, ≤16 KiB, ≤64 params, no duplicate
keys, rate-limited per source address (/64) at 120/min in Valkey (fails
open). Checks in order: RSA2 signature (all params except
`sign`/`sign_type`, URL-decoded, sorted; empty values kept, or dropped as
some Alipay SDKs do — both are under Alipay's signature; the current
支付宝公钥 or the previous one within its grace), the method's `app_id`,
`seller_id` (if configured), an `out_trade_no` **of this method**
(`orders.payment_method_id` — a validly signed notify routed to method A
never settles an order of method B: `unknown_order`), `total_amount` = the
order's amount (strict decimal parse to cents). `TRADE_SUCCESS` /
`TRADE_FINISHED` → paid; other statuses are acknowledged without effect.

Answer: `success` (text/plain) only for a verified notify of our order;
**every** refusal is the canonical rejection (`reject::not_found()`:
404, empty body, byte-identical to any unknown URL), so Alipay retries and
nothing about the endpoint is observable. Every notify — verified or not —
leaves a `payment_events` row (outcome `bad_signature`, `app_id_mismatch`,
`seller_id_mismatch`, `unknown_order`, `amount_mismatch`, `malformed`,
`oversized`, `paid`, `paid_unfulfilled`, `duplicate`, `ignored`); the
`sign` value is stored only as `<redacted>`. Verified-but-wrong notifies
for a real order are also audited (`order.payment.rejected`). Unverified
events are pruned after the audit retention (系统设置 → 安全); verified ones are kept.

Sync responses (precreate/query/close) are verified too: the signature
covers the raw `<method>_response` JSON bytes as received; an unsigned or
badly signed success is an error.

## Audit actions

Ops additions: `order.create` + `order.paid` (manual orders, `after.manual`,
`reason`), `coupon.batch.create` (template + count, never the codes),
`coupon.batch.revoke`, `export.orders` / `export.users` / `export.traffic`
/ `export.coupon_batch` (the filters), `user.batch.create` /
`user.batch.cancel`, and per user the action's own rows
(`balance.admin_adjust`, `user.update`, `user.plan.*`, `user.traffic.reset`,
`user.mail.send` (subject only)).


`plan.price.set`, `plan.price.delete`, `order.create`, `order.cancel`,
`order.expire`, `order.paid` (actor `alipay` for notify/query, the admin
for manual; includes the fulfilment result), `order.fulfil.retry`,
`order.payment.rejected`, plus the plan change's own `user.plan.set` /
`user.plan.renew` row. W16: `order.refund` (P1: + `user.plan.refund` when
the subscription is undone), `coupon.create` /
`coupon.update` / `coupon.delete`, `commission.create` /
`commission.reverse`, `commission.settings.update`,
`withdrawal.approved` / `withdrawal.rejected` / `withdrawal.cancelled`, and
one `balance.<kind>` row per ledger row (kind as in the ledger table).
W24: `payment_method.create` / `.update` / `.delete` / `.import`.
`payment_events.payment_method_id` records the order's method.

## Reconciliation (operator)

- 订单 → 筛选「已付款未开通」: paid orders that need attention.
- Order detail lists every payment event (source, verification, outcome,
  Alipay trade status, source address).
- Daily: compare paid orders (`status='paid' AND paid_via <> 'manual'`,
  `trade_no`, `paid_amount_cents`) with the Alipay merchant statement
  (账单); SQL:

```sql
SELECT out_trade_no, trade_no, amount_cents, paid_amount_cents, paid_at, user_label,
       (SELECT email FROM users WHERE id = orders.user_id) AS user_email, plan_name
FROM orders WHERE status = 'paid' AND paid_at >= date_trunc('day', now() - interval '1 day')
ORDER BY paid_at;
```

## Sandbox

- Sandbox gateway (official, since the 2023-05 sandbox upgrade):
  `https://openapi-sandbox.dl.alipaydev.com/gateway.do`. Sandbox APPID,
  keys and the buyer account are in the Alipay open platform console
  (开放平台 → 控制台 → 沙箱). Pay with the sandbox Alipay app (沙箱版支付宝)
  logged in as the sandbox **buyer** account.
- A local panel (e.g. `http://myapp.test:8080/<prefix>/app`) cannot receive
  notifies from the sandbox; status polling and the reconcile detect the
  payment through `alipay.trade.query` (same exactly-once path).
- In 系统设置 → 支付 choose 环境 = 沙箱 and paste the sandbox APPID and keys.
- Live checks (ignored tests; read the credential files by path —
  `~/secrets/alipay-sandbox{.env,-app-private.pem,-alipay-public.pem}` by
  default, `AKARI_ALIPAY_LIVE_{ENV,KEY,PUB}` override — skip when they are
  absent, print outcomes only, never run in CI). `live_sandbox` drives the
  client directly; `live_sandbox_db_configured` configures a method
  **through the admin API** (database, sealed key), runs 测试连接 and a
  precreate with that client:

```bash
cargo test --lib live_sandbox -- --ignored --nocapture
```

**Results 2026-10-03 (W24)**: both live tests passed against the real
sandbox: 测试连接 `keys_ok` (signed `ACQ.TRADE_NOT_EXIST` verified with the
sandbox 支付宝公钥), precreate 0.01 CNY → QR, query → not paid, close, and
the wrong Alipay public key → `BadSignature`.

**Results 2026-10-02** (this dev machine, real sandbox gateway, keys from
`~/secrets`, nothing committed): `alipay.trade.precreate` 0.01 CNY →
`code 10000` with a `https://qr.alipay.com/...` QR, response signature
verified with the sandbox Alipay public key; `alipay.trade.query` on the
unscanned order → `40004 ACQ.TRADE_NOT_EXIST` (mapped to "not paid");
`alipay.trade.close` → `ACQ.TRADE_NOT_EXIST` (nothing to close); the same
query verified against a wrong Alipay public key → rejected
(`BadSignature`). The sandbox gateway intermittently answered **HTTP 404
with an HTML page** (roughly 1 in 4 calls); every gateway call is therefore
retried up to 3 times on transport errors / non-200 answers (all three
calls are idempotent per `out_trade_no`), after which the order stays
pending and polling/reconcile retry. With the retry, repeated live runs
passed. A scanned
but unpaid trade (`WAIT_BUYER_PAY`) and a real `TRADE_SUCCESS` need the
sandbox app and were not exercised live; they are covered by the mock
gateway tests and smoke.

## Tests

- `billing::alipay::tests`: amounts, canonical strings, an openssl-made
  signature vector, PKCS#1/PKCS#8/bare-base64 keys, key errors (too short,
  private key as public key, app key as Alipay key), the previous Alipay
  key's grace window, 测试连接 outcomes, notify and response verification
  (raw-bytes, `\/` escapes, tampering, unsigned success, signed business
  errors). `billing::provider::mock`: the trait objects with a mock
  provider.
- `billing::tests::w24` (real DB + mock gateways): the methods API (coded
  validation errors, sealed secrets with AAD = id, never returned or
  audited, optimistic concurrency, 测试连接, rotation grace, disable =
  canonical rejection, delete only when unused), two methods (picker
  errors, cross-method notify isolation, legacy notify path, reconcile per
  method), unreadable secrets, reload on another instance (LISTEN/NOTIFY,
  atomic swap), the legacy panel.toml import.
- `billing::tests` (real DB + a local mock gateway that verifies the
  panel's request signatures): HTTP purchase flow with poll-based
  fulfilment, canonical notify rejections, concurrent duplicate
  notify + query, renew/replace with node bumps and notifications,
  failed fulfilment + admin retry + manual mark-paid, reconcile expiry and
  late payment, one open order per user, config validation, key file mode.
- `billing::tests::w16` (real DB): SQL money functions vs their Rust
  mirrors; coupon rules, preview, rounding, admin API; the last-use race and
  per-user limit; release on expiry and late payment (over the limit); the
  ledger invariants (triggers, append-only, concurrent spends never
  overdraw); full/partial balance payment, refund on cancel/expiry, late
  payment with the balance spent; refunds; commission lifecycle (pending →
  credited by the enforce pass, first order only, reversed by a refund,
  coupon/balance parts earn nothing, admin inviter, deleted inviter);
  exactly once under duplicate notifies/queries and concurrent credit
  passes; withdrawals; one ledger row + one audit row per money movement
  (table-driven). `api::tests::every_access_change_bumps_affected_nodes`
  has a balance-adjustment row (money moves, no node bump).
- Fuzz target `billing_input` (docs/FUZZING.md).
- `smoke.sh` "W16": coupon order paid by a signed notify, the coupon's last
  use refused to another buyer, commission pending → credited after a SQL
  time travel, withdrawal approve, balance-paid and partially balance-paid
  orders (cancel returns the balance part), refund to balance, ledger
  invariants in SQL. e2e "W16": console coupon + balance adjustment, user
  buys with coupon + balance (paid without the gateway).
- `smoke.sh` "R18-3": throwaway keys made with openssl, a Python mock
  gateway, price → order → tampered / wrong-amount notify = canonical
  rejection → signed notify → plan active → VLESS round trip through the
  node → replay no-op → renewal through polling (+30 days). W24: the mock
  gateway is added as a payment method through the admin API (app key as
  Alipay key refused, secrets sealed and never in the view/audit,
  测试连接 `keys_ok`), notifies go to the per-method route, the W16 order
  is settled through the legacy path, `config check` lists the methods
  with secrets redacted. e2e "W24": the method imported from the obsolete
  panel.toml section, 测试连接 against an unreachable gateway, adding a
  second method in the form, the checkout picker.
