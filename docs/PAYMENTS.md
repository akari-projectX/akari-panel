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
- **Refunds are not supported** by the panel (do them in the Alipay
  merchant console; cancel the plan by hand if needed).
- Expiry: the reconcile queries a pending order past `expires_at`; paid →
  fulfilled, otherwise `alipay.trade.close` (best effort) and the order
  becomes `expired`. While the gateway is unreachable the order stays
  pending and is retried; after 1 h it is expired anyway (`close_state =
  failed`; a later notify still fulfils it).

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
`user.plan.update` row.

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
- `smoke.sh` "R18-3": throwaway keys made with openssl, a Python mock
  gateway, price → order → tampered / wrong-amount notify = canonical
  rejection → signed notify → plan active → VLESS round trip through the
  node → replay no-op → renewal through polling (+30 days); restart with a
  stale `notify_url` after `rotate-prefix` is refused.
