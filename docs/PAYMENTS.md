# Payments: Alipay Face-to-Face (当面付)

R18-3. The panel sells plans through **Alipay Face-to-Face** only
(`alipay.trade.precreate` → QR code). Code: `src/billing/` (W7 catalogue:
`catalog.rs`); migrations `0040_billing.sql`, `0070_plan_catalog.sql`; SPA:
`spa/src/pages/purchase.tsx`, `orders.tsx`, `admin-orders.tsx`,
`admin-plans.tsx` (prices).

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
   Otherwise the panel calls `alipay.trade.precreate`
   (`timeout_express` = `order_timeout_minutes`, default 15) and returns
   the QR payload. The SPA renders the QR locally (no CDN). One open order
   per user: a new order ends the previous pending one (queried and closed
   at Alipay first).
3. The payment becomes known by any of:
   - the **async notify** (`POST /{prefix}/pay/alipay/notify`),
   - **status polling** (`GET /api/v1/me/orders/{id}` queries
     `alipay.trade.query` for a pending order, at most every 3 s per order
     across all instances),
   - the **reconcile** (every instance, every 10 s: pending orders not
     queried in the last 20 s are queried; `FOR UPDATE SKIP LOCKED` + a
     claim timestamp keep instances from duplicating work).
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
| `month` / `quarter` / `half_year` / `year` / `two_year` / `three_year` | 1 / 3 / 6 / 12 / 24 / 36 calendar months, UTC; the day clamps to the month's end (Jan 31 + 1 month = Feb 28/29) | 30 / 90 / 180 / 365 / 730 / 1095 |
| `days` (`days` = N, 1–3650) | N × 86400 s (the R18-3 single price migrated to this) | N |
| `onetime` (`days` = N or null) | N days, or **no expiry** when `days` is null | N (none when permanent) |
| `reset` | traffic reset pack: zeroes the used traffic of the current plan; no period change, the reset schedule is untouched | — |

### What a purchase does

| The user's active plan | Buying plan P, period X |
|---|---|
| none | `new`: P for one X from now, usage reset. Refused for `renewal_only` plans and when P is full (`capacity`). |
| P with an expiry | `renew`: expiry = one X after max(expiry, now) (`onetime` without days makes it permanent); usage and reset anchor unchanged. Allowed when P is full or renewal-only. |
| P without expiry | renewal refused (409 "nothing to renew"); the reset pack is still allowed. |
| P, X = `reset` | `reset`: used traffic → 0; a user disabled for quota is re-enabled (never an admin-disabled one); audited `user.traffic.reset` with `source: reset_pack`. Only for current subscribers of P — this is what quota-exhausted users (R21 renewal scope) buy. |
| another plan Q | `switch`: replaces Q (M3 replace semantics, **usage reset**), P for one X from now, charged P's full price **minus the switch credit**. Refused when P has `allow_switch_in = false`, is `renewal_only`, or is full. |

### Switching plans: the credit

The credit is the unused value of the current subscription, computed in SQL
(`catalog::switch_credit` → `akari_prorate`) when the order is created:

```
latest  = the newest paid, fulfilled, non-reset order of the user for the
          current plan, fulfilled since the current subscription started
value   = latest.list_price_cents (what was paid + any credit it used)
credit  = floor(value × remaining_seconds / (nominal_days(latest) × 86400))
credit  = min(credit, Σ list_price_cents of all such orders)   -- never more than was paid
credit  = 0 when there is no such order (admin-assigned), no expiry,
          nothing remaining, or a permanent one-time purchase
amount  = price − min(credit, price)        -- never negative
```

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
period pass); a renewal of a `none`-period plan extends the time, not the
quota (that is what the reset pack is for).

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
  balance instead. Cancel the plan by hand if needed.
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
`user_id → NULL` when the user is deleted; `user_login` stays). So
`balance = sum(ledger) ≥ 0` for every user, at every commit, whoever writes.
Every movement is written by `ledger::apply_entry`: **one ledger row + one
`balance.<kind>` audit row, in the transaction of its cause**.

| kind | sign | when |
|---|---|---|
| `admin_adjust` | ± | 资金 → 用户余额 → 调整 (`POST /users/{id}/balance {amount_cents, reason}`), customers only |
| `order_payment` | − | the balance part of an order, at creation (held); or re-taken by a late payment |
| `refund_to_balance` | + | the held balance part of an order that ended unpaid; an admin refund to balance |
| `commission` | + | an invite commission past its hold |
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
  (`commission.reverse`); after the hold it stays credited (the hold is the
  refund window; claw back with an admin adjustment if needed).

### Withdrawals (提现)

Withdrawable = min(balance, credited commissions − withdrawals not rejected
or cancelled): refunds and admin credits are spendable on plans, not cash.
A request (`POST /me/withdrawals {amount_cents, method, account}`, at least
`min_withdrawal_cents`, one open request per user) debits the amount at once
(ledger `withdrawal`). The admin pays out by hand (Alipay/WeChat/bank) and
then approves with the payout reference (资金 → 提现审核), or rejects with a
reason (ledger `withdrawal_reversal`); the user may cancel while pending.
Withdrawals of a deleted user can only be approved.

### Refunds (admin)

订单 → 详情 → 退款 (`POST /orders/{id}/refund {reason, to_balance}`), paid
orders only, once: the held balance part always goes back to the balance;
with `to_balance` the Alipay amount is credited to the balance too (one
`refund_to_balance` row for both) — otherwise refund it in the Alipay
merchant console. A pending commission is reversed. The plan is **not**
touched (cancel it in 用户 if needed); a refunded order cannot be fulfilled
again. Audited `order.refund`.

### Lock order

`entitle::lock` (order creation and `apply_mark_paid`) → `orders` row →
`coupons` / `coupon_redemptions` → `commissions` → `user_balances` →
`withdrawals`. The commission pass and withdrawals never take an earlier
lock after a later one.

## Configuration

```toml
[payments.alipay]
enabled = true
app_id = "2021000000000000"          # APPID
seller_id = "2088000000000000"       # optional; when set, notifies must carry it
app_private_key_file = "/etc/akari/alipay-app-private.pem"   # mode 0600 (checked)
alipay_public_key_file = "/etc/akari/alipay-public.pem"      # Alipay's key, NOT the app public key
gateway_url = "https://openapi.alipay.com/gateway.do"        # default
# notify_url = ""                   # default: derived from the main domain (系统设置)
order_timeout_minutes = 15           # 5..=120
```

- Public-key mode, **RSA2** only (certificate mode is not supported).
- Key files: PKCS#8 or PKCS#1, PEM or the bare base64 that Alipay's key
  tool writes. The private key file must not be group/other readable.
  Keys are loaded and checked at startup and by `akari config check`
  (errors never contain key material). Never commit keys; keep them outside
  the repository and the data dir backups you share.
- `notify_url` empty (default, R22): every order is created with
  `<main domain>/<route prefix>/pay/alipay/notify`, the main domain being
  系统设置's (else `install.public_url`). It follows a domain change and
  `rotate-prefix` by itself. With no main domain configured at all, orders
  are refused (503 "payments are not enabled", no order row) and startup,
  `config check` and 系统设置 warn. Orders created before a main domain change
  carry the old URL; the host gate then refuses notifies to the old name,
  and polling/the reconcile fulfil those orders.
- An explicit `notify_url` **must** be `<public base>/<route prefix>/pay/alipay/notify`
  (no query). Its host stays accepted by the host gate and the Caddy ask
  endpoint; when it is not the main domain, `config check`, startup and
  系统设置 warn. It contains the secret prefix: `config check` prints it as
  `***` and it is never logged. The panel refuses to start when its path
  does not carry the current prefix — after `akari secrets rotate-prefix`
  update `notify_url` (and nothing else is needed at Alipay: the URL is
  sent with every precreate).
- Alipay must reach `notify_url` over the internet (HTTPS through your
  reverse proxy; only the prefix is forwarded, see DEPLOY.md). If it
  cannot (development, firewalls), payments are still detected through
  polling and the reconcile — notify only makes it faster.
- `gateway_url` must be https; plain http is accepted only for loopback
  hosts (a local mock, with a warning). The panel connects directly (no
  HTTP proxy support) with the webpki root store.

## Notify endpoint rules

`POST /{prefix}/pay/alipay/notify` (form-encoded, ≤16 KiB, ≤64 params, no
duplicate keys), rate-limited per source address (/64) at 120/min in
Valkey (fails open). Checks in order: RSA2 signature (all params except
`sign`/`sign_type`, URL-decoded, sorted; empty values kept, or dropped as
some Alipay SDKs do — both are under Alipay's signature), `app_id`,
`seller_id` (if configured), known `out_trade_no`, `total_amount` = the
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
events are pruned after `audit.retention_days`; verified ones are kept.

Sync responses (precreate/query/close) are verified too: the signature
covers the raw `<method>_response` JSON bytes as received; an unsigned or
badly signed success is an error.

## Audit actions

`plan.price.set`, `plan.price.delete`, `order.create`, `order.cancel`,
`order.expire`, `order.paid` (actor `alipay` for notify/query, the admin
for manual; includes the fulfilment result), `order.fulfil.retry`,
`order.payment.rejected`, plus the plan change's own `user.plan.set` /
`user.plan.update` row. W16: `order.refund`, `coupon.create` /
`coupon.update` / `coupon.delete`, `commission.create` /
`commission.reverse`, `commission.settings.update`,
`withdrawal.approved` / `withdrawal.rejected` / `withdrawal.cancelled`, and
one `balance.<kind>` row per ledger row (kind as in the ledger table).

## Reconciliation (operator)

- 订单 → 筛选「已付款未开通」: paid orders that need attention.
- Order detail lists every payment event (source, verification, outcome,
  Alipay trade status, source address).
- Daily: compare paid orders (`status='paid' AND paid_via <> 'manual'`,
  `trade_no`, `paid_amount_cents`) with the Alipay merchant statement
  (账单); SQL:

```sql
SELECT out_trade_no, trade_no, amount_cents, paid_amount_cents, paid_at, user_login, plan_name
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
  payment through `alipay.trade.query` (same exactly-once path). Use any
  `notify_url` with the right prefix (http is accepted with a warning).
- Live check (ignored test; reads credentials from paths you give, prints
  outcomes only):

```bash
AKARI_ALIPAY_LIVE_ENV=~/secrets/alipay-sandbox.env \
AKARI_ALIPAY_LIVE_KEY=~/secrets/alipay-sandbox-app-private.pem \
AKARI_ALIPAY_LIVE_PUB=~/secrets/alipay-sandbox-alipay-public.pem \
cargo test --lib live_sandbox -- --ignored --nocapture
```

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
  signature vector, PKCS#1/PKCS#8/bare-base64 keys, notify and response
  verification (raw-bytes, `\/` escapes, tampering, unsigned success).
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
  node → replay no-op → renewal through polling (+30 days); restart with a
  stale `notify_url` after `rotate-prefix` is refused.
