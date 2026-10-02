# Akari

A proxy-panel control plane with zero legacy fingerprints: a single Rust
binary (panel) plus a Go agent that embeds xray-core. No V2Board/XrayR
protocol compatibility, no inbound management ports on nodes, nothing that
identifies the software to unauthenticated probes.

```
┌──────────────── Rust binary (akari) ────────────────┐
│ axum web        empty 404 for all, panel API behind │
│                 a per-install random route prefix   │
│ tonic gRPC      mTLS AgentChannel (server)          │
│ PG 18           users / nodes / traffic ledger      │
│ Valkey 9        liveness TTL keys, heartbeat blobs  │
└───────────────▲────────────────────────────────────┘
                │ outbound-only mTLS gRPC stream
┌───────────────┴────────────────────────────────────┐
│ Go agent: embedded xray-core, dynamic AddUser,     │
│ per-user traffic counters, heartbeats              │
└────────────────────────────────────────────────────┘
```

## Status / what works

End-to-end verified by `./smoke.sh` (fully API-driven):

- `akari admin add <login>` creates the first account (password via
  `AKARI_ADMIN_PASSWORD` env or hidden prompt; argon2id hashing).
- All panel API lives under a per-install random route prefix. Anything that
  guesses wrong — including the bare prefix and `/` — gets one identical
  empty 404 (no body, none of the panel's security headers).
- `POST /{prefix}/auth/login` verifies argon2id hashes (timing-equalized for
  unknown users; failed attempts rate limited per client address — IPv6 per
  /64 — at 20/15min and per login name at 50/15min, in Valkey) and issues
  an HS256 JWT in an `HttpOnly` `SameSite=Strict` cookie (12h; `Secure`
  unless `web.cookie_secure = false`). The token carries the account's
  `session_ver`: a password change, disable, role change, expiry, logout or
  `POST /api/v1/users/{id}/revoke-sessions` ends every session of the
  account (logout = log out everywhere; a copied cookie dies with it). The
  last enabled admin cannot be disabled, demoted or deleted (409; enforced
  by a DB trigger, race-free). TOTP two-factor authentication is optional
  (recommended; `[auth] require_admin_2fa = true` makes it mandatory for
  admins); every administrative change is in the audit log (see "Security"
  below).
- Admin API: user CRUD, node listing/enable, per-node xray `inbounds`
  editing, account generation + assignment (VLESS/VMess/Trojan credentials
  are panel-generated, one per inbound).
- **Plans (M3)**: node groups, plans (traffic quota, monthly / every-N-days
  / no reset, granted groups) and user plans. A user's nodes follow their
  plan automatically — credentials are issued and revoked by the panel (see
  "Plans and node groups" below); manual per-node assignment remains as an
  admin override. Periodic traffic resets re-enable users disabled only for
  quota. Users see their plan, usage, next reset, expiry and node list
  (names/regions) in the portal and can change their password.
- **Support and alerts (W17)**: customer tickets (工单: categories,
  priorities, threaded replies, unread markers, close/reopen/assign; another
  user's ticket is indistinguishable from an unknown path) and node alerts
  (offline, CPU/memory over time, disk, failing latency tests, expiring
  certificates, failed applies; one evaluator at a time, dedupe, cooldown,
  mute; Telegram bot, HMAC-signed webhook, email via the SMTP outbox) with
  an alert center in the console; Prometheus rules and a fleet dashboard in
  `deploy/` (docs/DEPLOY.md §4b).
- **Plan catalogue (W7)**: prices per period (month / quarter / half-year /
  year / two / three years / custom days / one-time / traffic reset pack),
  a Markdown-lite description, stock (max subscribers), renewal-only and
  switch-in rules, plan switching with pro-rata credit, and a per-user
  speed limit enforced by the agent (see docs/PAYMENTS.md).
- `akari node add <name>` (or `POST /api/v1/nodes`, or New node in the UI)
  creates the node with a one-time enrollment token and writes a bootstrap
  file without any private key: the agent generates its key (ECDSA P-256)
  locally and enrolls with a CSR over the gRPC port (the only call that
  works without a client certificate); the panel signs a 90-day client
  certificate. Protocol 2 agents renew it over mTLS when a third is left
  (new key; the old certificate is revoked once the new one is seen).
  `akari node enroll-token <id>` re-enrolls a node. See docs/DEPLOY.md.
  `akari node delete <id>` (or
  `DELETE /api/v1/nodes/{id}`, or the Delete button) retires a node: see
  "Node deletion" below.
- Agent dials out (TLS 1.3, client cert = node identity), sends `Hello` with
  its held config/user versions; node flips to `online`, versions recorded.
- Panel pushes a `ConfigSnapshot` (xray inbounds + full user set) when the
  inbounds change or the agent's state is unknown, and a `UserDelta`
  (base/target versions, REPLACE semantics) when only the user set changed:
  adding, disabling or rotating one user does not rebuild xray, and only
  that user's live connections are closed. A `ConfigSnapshot` DOES rebuild
  the agent's xray instance and drops every live connection on the node:
  inbound changes, an agent whose state is unknown or diverged
  (Hello/Ack state hash), a failed delta, a new session after a restart or
  lease expiry, and `agent.remove_mode = "rebuild"` all take that path.
  Disabling a user via the API propagates to connected agents within a
  second.
- Heartbeats (15s) land in Valkey; traffic counters (10s polls) flow to the
  panel where deltas are applied idempotently against a session-scoped
  baseline.
- **Node operations (W11, docs/DEPLOY.md §3e)**: xboard-style node form —
  display name (user-facing; `name` stays the unique internal name), sort,
  shown to users or hidden, tags (shown in the portal and in subscription
  names "香港 01 | IPLC"), traffic multiplier 倍率 (0–100x, exact permille;
  billed = floor(raw × rate) inside the flush SQL only, the rate in effect at
  flush time applies; the node keeps raw and billed totals), per-inbound
  连接地址/连接端口 (NAT / port forwarding / relays; all three subscription
  formats and the panel's TCP test use them) and node-group membership.
  Agents report machine status with every heartbeat (CPU, load, memory/swap,
  disk, default-route interface rates and totals, TCP/UDP sockets, proxied
  connections, online users, RSS, uptime, xray version): latest values in
  Valkey, 1-minute history for 48 h and 1-hour history for 90 days in
  PostgreSQL; the admin node list refreshes every 5 s and each node has a
  detail page with charts. Latency like Clash Verge's url-test (every 5 h,
  configurable, plus "立即测速"): the agent's HTTP test from its own egress,
  and the panel's TCP connect test to every inbound; users see online state,
  multiplier, tags and latency of their visible nodes.
- Users over `traffic_limit_bytes` are auto-disabled; affected nodes get a
  version bump and connected agents converge immediately.
- Subscription endpoint: `/{prefix}/sub/{token}` with a 256-bit per-user
  token (DB stores only its SHA-256). Output format follows the User-Agent
  (base64 share links / Clash YAML / sing-box JSON); TLS, REALITY and
  WebSocket transport params are mapped from each inbound's streamSettings.
  `subscription-userinfo` and other quota headers are sent only on success;
  bad tokens get the same empty 404 as every other rejection. Bodies are padded to 8 KiB
  buckets so size does not reveal node counts. Rate limited per client
  address and per user (`[sub]`); over the limit is the same empty 404.

Not yet: payments/orders, agent CSR enrollment and auto-update, akari-client.

## Layout

```
proto/agent.proto      the control-plane contract (single source of truth)
src/grpc.rs            agent sessions, snapshot/delta convergence
src/traffic.rs         delta accounting + limit enforcement
src/install.rs         CA, server/agent cert issuance
src/auth.rs            argon2id passwords, JWT sessions, extractor
src/api.rs             REST handlers (users, nodes, accounts)
src/spa.rs             embedded frontends (rust-embed): user portal, session-gated admin console
src/web.rs + reject.rs prefix gate + uniform rejection
spa/                   React 19 + Vite 8 + Tailwind 4 frontend
migrations/            sqlx migrations (run at startup)
smoke.sh               cross-repo end-to-end check (needs ../akari-agent)
```

The agent lives in the sibling repo `akari-agent` (Go: `agent.go` stream
lifecycle and reconnect backoff, `core.go` xray-core embedding, `gate.go`
revocation gate, `monitor.go` heartbeat + traffic loops). Both repos must be
checked out side by side; `src/CLAUDE.md` has the per-file map.

## Frontend

`spa/` holds two independently built frontends (R23) on React 19, Vite 8
(Rolldown), Tailwind 4 and shadcn/ui-style components, with TanStack Query as
the data layer:

- the **user portal** at `/{prefix}/app` — the login page (shared with
  admins), account, subscription, purchase and orders (Chinese/English);
- the **admin console** at `/{prefix}/admin` — users, plans, orders, nodes,
  updates, audit, account (Chinese). Its index and assets are served only to
  an admin session (private, no-store); to anyone else `/admin` is the
  uniform empty 404. Admins sign in at `/{prefix}/app` and are sent there.

The portal bundle contains no console code (a build-time check greps it for
admin markers). Both bundles are embedded into the binary via rust-embed and
served only under the secret prefix; Vite's asset URLs are rewritten to the
prefix at serve time, so nothing about the app leaks without the prefix.
Missing assets return the uniform empty 404, and the dev tree is never served.

```bash
make spa               # npm install + vite build (updates spa/dist)
make panel             # rebuild the binary to embed the new bundle
```

## Running

```bash
make dev-up            # PG 18 + Valkey 9 (docker compose)
make spa               # frontend build (first run installs npm deps)
make panel             # cargo build --release
make agent-build       # go build of ../akari-agent
# contract change: edit proto/agent.proto, then in ../akari-agent:
#   make sync-proto && make check-proto

./target/release/akari serve
AKARI_ADMIN_PASSWORD=... ./target/release/akari admin add root
./target/release/akari node add test-node   # writes test-node-bootstrap.toml (one-time token)
(cd ../akari-agent && ./agent -config ../akari-panel/test-node-bootstrap.toml -state-dir /tmp/akari-agent-state)
make smoke             # full end-to-end check (truncates the dev DB)
make check             # fmt + clippy + tsc (fast gate); make lint test deny = CI
```

### Production deployment

`docs/DEPLOY.md` (fresh VPS in ~30 minutes: Docker Compose or systemd, Caddy/nginx, firewall,
first admin, node install, upgrade order, rollback, release verification), `docs/BACKUP.md`
(age-encrypted backup/restore and the restore drill), `deploy/` (units, compose, proxy examples,
Prometheus alerts, Grafana dashboard). Release artifacts (static linux amd64/arm64 binaries,
distroless image `ghcr.io/akari-projectx/akari-panel`, SBOM, cosign signatures) come from the
`release.yml` workflow on `v*` tags. `akari --version`, `akari config check` (validates and prints
the effective config, secrets redacted). Optional `[metrics] bind` serves Prometheus metrics on a
separate loopback listener, never on the public port.

### API surface (all under the secret prefix)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /auth/login | — | `{login, password, code?}`: argon2id + TOTP/recovery code, sets session cookie |
| POST | /auth/logout | — | clears the cookie and ends all of the account's sessions |
| GET | /auth/options | — | W15: what the login page offers `{register, invite_required, email_domains, reset}` |
| POST | /auth/register/code | — (registration on) | W15: `{email, invite_code?, locale?}` → `{"ok":true}` for every address (a code by mail, or an "already registered" mail); rate limited per client and address |
| POST | /auth/register | — (registration on) | W15: `{email, code, password, invite_code?, locale?}` → account (login = address, verified) + session; wrong/expired/used code = 400 `invalid or expired code` |
| POST | /auth/password-reset/request | — (reset on) | W15: `{email}` → `{"ok":true}` for every address; a 30-minute single-use link goes to a verified address |
| POST | /auth/password-reset | — (reset on) | W15: `{token, password}`: new password, every session ends |
| GET | /api/v1/me | user (renewal scope*) | profile + traffic usage; `expired` / `quota_exhausted` (R21) |
| GET | /api/v1/me/totp | any session | session stage, 2FA state (never the secret) |
| POST | /api/v1/me/totp/enroll | any session | new pending TOTP secret (shown once) |
| POST | /api/v1/me/totp/confirm | any session | `{code}`: activate 2FA, returns 10 recovery codes once |
| POST | /api/v1/me/totp/recovery-codes | user | `{code}`: replace recovery codes |
| POST | /api/v1/me/sub-token | user (role=user) | regenerate own subscription token (5/hour) |
| GET | /api/v1/me/plan | user | own active plan (or null), usage, enforced limit/expiry, node names + regions |
| GET | /api/v1/me/nodes | user | W11: own visible nodes — display name, region, tags, multiplier, online, latency (no ids, addresses or machine metrics) |
| POST | /api/v1/me/email/code | user (renewal scope*) | W15: `{email, password}`: code to the new address (current password required; same answer if the address is taken) |
| POST | /api/v1/me/email/verify | user (renewal scope*) | W15: `{code}`: the address becomes the account's verified email (a registered login follows it) |
| PUT | /api/v1/me/locale | user (renewal scope*) | W15: `{locale: zh\|en}`: language of the account's mails |
| GET/POST | /api/v1/me/invite-codes | user (role=user) | W15: own invite codes, link base, invited count / new code (per-user limit; registration must be open) |
| DELETE | /api/v1/me/invite-codes/{code} | user (role=user) | W15: delete an invite code |
| GET/PUT | /api/v1/settings/signup | admin | W15 系统设置 → 注册: registration, invite rules, email domain allow-list, trial plan, password reset (optimistic `version`) |
| GET/PUT | /api/v1/settings/mail | admin | W15 系统设置 → 邮件: SMTP host/port/security/credentials (password write-only, sealed), sender, notice switches |
| POST | /api/v1/settings/mail/test | admin | W15: `{to}`: send a test mail now with the saved settings (502 = the server's answer) |
| GET | /api/v1/mail/outbox | admin | W15: outbox rows `?status=dead\|pending\|sent&before&limit` (no bodies) |
| POST | /api/v1/mail/outbox/{id}/retry | admin | W15: re-queue a dead letter (not for expired codes/links) |
| POST | /api/v1/me/password | user/admin | `{current_password, new_password}`: change own password (wrong current = 400, counts against the login rate limit; other sessions end, this one continues) |
| GET | /api/v1/audit | admin | audit log, `?limit&before&actor&action` (keyset, newest first) |
| GET/POST | /api/v1/users | admin | list / create users |
| PATCH/DELETE | /api/v1/users/{id} | admin | update / delete user |
| GET | /api/v1/users/{id}/nodes | admin | the account's node access: node, region, state, inbound tags/protocols, plan-granted or manual (no credentials) |
| POST/DELETE | /api/v1/users/{id}/nodes/{node_id} | admin | manual override: assign (generates account, pins the pair) / remove (hands a plan-granted pair back to the plan; 409 on plan-managed rows) |
| GET/PUT/PATCH/DELETE | /api/v1/users/{id}/plan | admin | active plan + history / assign or change `{plan_id, expires_at?, period_anchor?, reset_traffic?}` / `{expires_at?, period_anchor?}` / cancel |
| GET/POST | /api/v1/node-groups | admin | list / create `{name, description?, node_ids?}` |
| PATCH/DELETE | /api/v1/node-groups/{id} | admin | rename, describe, replace `node_ids` / delete |
| GET/POST | /api/v1/plans | admin | list / create `{name, period, traffic_quota_bytes?, speed_limit_mbps?, device_seats?, sort?, enabled?, group_ids?, description?, capacity?, renewal_only?, allow_switch_in?}` (views include `on_sale` and `prices`) |
| PATCH/DELETE | /api/v1/plans/{id} | admin | update (same fields; null clears nullable ones) / delete (409 while users hold it) |
| GET/POST | /api/v1/nodes | admin | W17: `?view=summary` = the list's columns only (no inbounds JSON, slim heartbeat, best agent latency, `alerts_firing`, `needs_certificate`), with an ETag (`If-None-Match` → 304; `?view=full`, the default, also carries one); full: node list with live status, certificate expiry, last heartbeat (W11: machine status, latency, multiplier, tags, groups), warnings / create a node `{name, region?, server_addr?, tls_domain?, templates? \| inbounds?, install?: {origin?}, display_name?, sort?, visible?, tags?, traffic_rate?, connect_overrides?, group_ids?}` (201: one-time enrollment token + bootstrap file + one-line install command, shown once) |
| GET | /api/v1/nodes/{id} | admin | W17: one node, full view (the node page) |
| GET/PUT | /api/v1/nodes/{id}/alert-rules | admin | W17: per-node alert overrides `{muted, disabled: [kind], offline_secs?, cpu_percent?, cpu_minutes?, mem_percent?, mem_minutes?, disk_percent?, cert_days?}` (null = the global value) |
| POST | /api/v1/nodes/{id}/install | admin | new one-line install command `{origin?}` (re-install; replaces the node's unused token) |
| GET | /api/v1/inbound-templates | admin | template choices (REALITY dests, fingerprints) |
| POST | /api/v1/inbound-templates/render | admin | templates → xray inbounds JSON (fresh REALITY keys; nothing stored; `tls_domain` = the node's TLS domain, default certificate domain) |
| POST | /api/v1/inbound-templates/check-domain | admin | `{domain, node_id?, server_addr?}` → what the domain resolves to vs. the node's addresses (warn-only pre-flight for 节点域名) |
| POST | /api/v1/inbound-templates/check-dest | admin | TLS 1.3 + h2 check of a REALITY dest from the panel |
| POST | /api/v1/nodes/{id}/enroll-token | admin | new one-time enrollment token + bootstrap file (re-enrollment) |
| PATCH/DELETE | /api/v1/nodes/{id} | admin | enable / rename / billing cap override / W11 `display_name`, `sort`, `visible`, `tags`, `traffic_rate`, `connect_overrides`, `group_ids`; delete (202, revokes the certificate); `tls_domain` = 节点域名: the agent obtains its certificate itself (change bumps config_version, DEPLOY §3f) |
| GET | /api/v1/nodes/{id}/status | admin | W11: latest heartbeat + machine status, online, latency results, raw/billed traffic |
| GET | /api/v1/nodes/{id}/metrics | admin | W11: history `?range=1h\|6h\|24h\|48h\|7d\|30d\|90d` (averages and maxima per point, ≤ 360 points) |
| POST | /api/v1/nodes/{id}/probe | admin | W11: "立即测速" (202; 429 within `[probe].manual_cooldown_secs`) |
| PUT | /api/v1/nodes/{id}/inbounds | admin | replace xray inbounds (bumps config_version) |
| POST | /api/v1/users/{id}/sub-token | admin | regenerate subscription token |
| POST | /api/v1/users/{id}/revoke-sessions | admin | log the account out everywhere (204) |
| DELETE | /api/v1/users/{id}/totp | admin | reset the account's 2FA, end its sessions; `{"totp": "active"\|"pending"\|"none"}` (what was removed) |
| GET | /api/v1/me/shop | user (renewal scope*) | plans on sale with every priced period as the caller would buy it now (`action` new/renew/switch/reset, `discount_cents`, `credit_cents`, `balance_cents`, `amount_cents`, or `refusal`), description, stock; the caller's subscription, switch credit and balance. W16: `?coupon=CODE` (rate-limited) prices with a coupon (`coupon.refusal` / per-offer `coupon_refusal`), `?use_balance=true` with the balance |
| GET/POST | /api/v1/me/orders | user (renewal scope*) | own orders (last 50) / create `{plan_id, period, coupon?, use_balance?}` → order + Alipay QR (the amount is the server's price minus coupon, switch credit and balance, computed in SQL; fully covered orders are paid at once) |
| GET | /api/v1/me/balance | user (renewal scope*) | W16: balance, withdrawable amount, ledger (`?before&limit`) |
| GET | /api/v1/me/invite | user | W16: invite programme terms, invited count, commission totals and history (invite codes: W15) |
| GET/POST | /api/v1/me/withdrawals | user | W16: own withdrawals / request `{amount_cents, method, account}` (debited at once; ≤ withdrawable) |
| POST | /api/v1/me/withdrawals/{id}/cancel | user | W16: cancel a pending withdrawal (amount back to the balance) |
| GET | /api/v1/me/orders/{id} | user (renewal scope*) | order status; a pending order is actively queried at Alipay (throttled) |
| POST | /api/v1/me/orders/{id}/cancel | user (renewal scope*) | cancel a pending order (queried + closed at Alipay first) |
| GET | /api/v1/plan-prices | admin | every plan with its `on_sale` flag and prices, `payments_enabled` |
| PUT | /api/v1/plans/{id}/prices | admin | `{on_sale, prices: [{period, days?, price_cents}]}` replaces the plan's prices (W7 period kinds) |
| GET | /api/v1/orders | admin | orders, `?status&login&out_trade_no&unfulfilled&before&limit` (keyset) |
| GET | /api/v1/orders/{id} | admin | order + payment events |
| POST | /api/v1/orders/{id}/fulfil | admin | `{reason}`: mark an unpaid order paid (manual) or retry a failed fulfilment (audited) |
| POST | /api/v1/orders/{id}/refund | admin | W16 `{reason, to_balance}`: refund a paid order once (balance part back; with `to_balance` the Alipay amount too); reverses a pending commission |
| GET/POST | /api/v1/coupons | admin | W16: coupons / create `{code, kind percent\|fixed, value, plan_ids?, periods?, min_amount_cents?, starts_at?, ends_at?, max_uses?, per_user_limit?, new_users_only?, enabled?}` |
| GET/PATCH/DELETE | /api/v1/coupons/{id} | admin | W16: coupon + redemptions / update (code immutable) / delete (never used only) |
| GET | /api/v1/balances | admin | W16: customers with a balance, `?login` finds anyone |
| GET/POST | /api/v1/users/{id}/balance | admin | W16: balance + ledger / adjust `{amount_cents (signed), reason}` (never below 0) |
| GET | /api/v1/commissions | admin | W16: commissions `?status&login&limit` |
| GET/PUT | /api/v1/commission-settings | admin | W16: `{enabled, rate_percent, first_order_only, hold_days, min_withdrawal_cents}` |
| GET | /api/v1/withdrawals | admin | W16: withdrawal requests `?status&login&limit` |
| POST | /api/v1/withdrawals/{id}/approve \| reject | admin | W16: `{payout_reference, note?}` after paying out by hand / `{reason}` (amount back to the balance) |
| GET/POST | /api/v1/me/tickets | user (renewal scope*) | W17: own tickets (unread markers) / open `{subject, category, priority?, message, order_id?, node_id?}` (5/hour, at most 5 not closed) |
| GET | /api/v1/me/tickets/{id} | user (renewal scope*) | W17: own ticket + messages (staff shown as staff, never by login); marks replies read. Anyone else's / unknown / malformed id = the canonical rejection |
| POST | /api/v1/me/tickets/{id}/replies \| close | user (renewal scope*) | W17: `{message}` (30/hour; 409 when closed) / close |
| GET | /api/v1/tickets | admin | W17: queue `?status=open\|answered\|closed\|active&category&priority&assignee=me\|none\|<id>&unread=true&q&page` + open/unread counters |
| GET | /api/v1/tickets/{id} | admin | W17: ticket + thread (marks the customer's messages read) |
| POST | /api/v1/tickets/{id}/replies \| close \| reopen | admin | W17: `{message, close?}` / close / reopen |
| PUT | /api/v1/tickets/{id}/assignee | admin | W17: `{assignee_id}` (an enabled admin, or null) |
| GET | /api/v1/admins, /api/v1/admin-badges | admin | W17: assignable admins; console counters (unread tickets, firing alerts) |
| GET | /api/v1/alerts | admin | W17: alert center `?status=firing\|resolved&node&kind&before&limit` + `firing` counts by kind |
| POST | /api/v1/alerts/{id}/ack | admin | W17: acknowledge (audited once) |
| GET/PUT | /api/v1/alerts/settings | admin | W17: thresholds and channels (Telegram bot, signed webhook, email); secrets write-only (`*_set` flags), `version` for optimistic concurrency (409) |
| POST | /api/v1/alerts/test | admin | W17: `{channel}` sends a test message through the saved configuration, `{ok, error?}` |
| GET | /api/v1/alerts/notifications | admin | W17: the last 100 deliveries; `POST …/{id}/retry` requeues a dead one |
| POST | /pay/alipay/notify | Alipay signature | Alipay async notify (RSA2); every refusal = the canonical rejection; see docs/PAYMENTS.md |
| GET | /sub/{token} | token | subscription (UA-based format) |
| GET | /install/{token}[/agent/{arch}] | install link | node install script / agent binary while the link is live (docs/DEPLOY.md §3) |
| GET | /healthz | — | panel liveness |

\* Renewal scope (R21): also reachable by an expired or quota-disabled `role=user` account (login answers `expired` / `quota_exhausted`), together with `/me/plan` and `/me/password`; everything that serves or reveals proxy access (subscription, sub-token, 2FA) stays refused. Accounts disabled for any other reason cannot log in.

Defaults bind web on `127.0.0.1:8080` and gRPC on `127.0.0.1:8443`; override
via `panel.toml` (see `src/config.rs`) or `DATABASE_URL`/`VALKEY_URL`.
`akari admin passwd <login>` resets a password (and ends its sessions).
`akari admin reset-2fa <login>` removes an account's 2FA (lockout recovery);
the account then logs in with its password. `akari node enroll-token <id>`
issues a new one-time node enrollment token.
`akari secrets rotate-prefix` / `akari secrets rotate-jwt` rotate secrets
(see "Security").

### Deployment behind a reverse proxy

Serve the web port only through a TLS-terminating proxy (Caddy, nginx) and
keep it bound to loopback or a private address. The gRPC port is **not**
proxied: agents need direct mTLS to it.

```toml
[web]
bind = "127.0.0.1:8080"
cookie_secure = true                 # default; false only for plain-HTTP dev
trusted_proxies = ["127.0.0.1/32"]   # the proxy's address(es) as seen by the panel
```

- The client address (login rate limit) is taken from `X-Forwarded-For`
  **only** when the TCP peer is in `trusted_proxies`; it is the rightmost
  hop that is not itself a trusted proxy. Anything a client writes into the
  header is ignored, and requests from untrusted peers are attributed to
  the peer. With the default (empty) list the header is never read — then
  every client behind a proxy shares the proxy's bucket, so set it.
- The proxy must **append** to `X-Forwarded-For` (nginx:
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` Caddy
  does this by default) and must not be reachable in a way that lets
  clients connect to the panel directly from a trusted address.
- Forward everything under the route prefix unchanged; do not add
  distinguishing error pages for the panel's 404s.
- Shutdown: `SIGTERM`/`SIGINT` stop accepting, end agent streams
  (UNAVAILABLE, agents reconnect), run a final traffic flush (≤ 5 s) and
  exit within ~10 s, inside `docker stop`'s default grace; with a
  process manager allow at least 15 s.

### Security advisory GO-2026-6443 (更正, R26)

Earlier releases refused the xray gRPC transport because the agent's
grpc-go (< v1.85.0) was listed under GO-2026-6443 (server panic on a
request without `:authority`). The agent now pins grpc-go to the fixed
upstream commit (`v1.85.0-dev.0.20260825072537-93e31b48545e`, to be replaced
by v1.85.0 when tagged) and gRPC inbounds are accepted again; see
docs/DEPLOY.md §3d for the protocol/transport matrix.

Pinned versions: xray-core `v1.260327.0` (the Go module form of release
v26.3.27 — Xray uses calendar tags, Go needs semver), axum 0.8, tonic 0.14,
SQLx 0.9, fred 10 (Valkey client), Go 1.27.

## Design notes

- **Identity**: the agent's TLS client certificate serial is the node's
  identity; the protocol itself carries no credentials. Agent keys are
  panel-issued in v1 (CSR enrollment is the planned upgrade).
- **Convergence**: the panel is the source of truth. Every node state has a
  monotonically increasing `config_version`/`user_version`. A mismatch on
  Hello, Ack, or a change notification is repaired with a `UserDelta` if the
  panel knows (this session) the exact user set the agent runs and only
  users changed, otherwise with a full snapshot, so agents converge from any
  state (including panel rollbacks). Deltas carry base and target versions:
  the agent applies one only on top of its base, answers a resend of the
  target as a no-op, and rejects anything else with `BASE_MISMATCH` (the
  panel then sends a snapshot at once). Hello and every Ack carry a state
  hash of what the agent actually runs (see `proto/agent.proto`, shared test
  vectors in `proto/state_hash_vectors.json`); a mismatch is repaired with a
  snapshot.
- **Unassigned users' last bytes**: unassigning a user (or pruning all of
  its credentials via `PUT inbounds`) records `node_users_departed`; the
  agent's final counters, which arrive after the removal, are still billed
  for `traffic.departed_grace_secs` (default 15 min).
- **Removal mode**: `agent.remove_mode = "gate"` (default) removes/rotates
  users in place; `"rebuild"` sends every removal/rotation as a full
  snapshot (fallback if the agent's gate is ever in doubt). User-less
  inbounds (dokodemo/socks/http without clients) are neither gated nor
  billed; FakeDNS sniffing (`sniffing.destOverride` containing `fakedns` /
  `fakedns+others`, any key case) is rejected (400), and the agent refuses
  it again after xray's own parse.
- **Control protocol revisions**: agents send `Hello.protocol_version`
  (current: 1). Agents below the panel's `MIN_AGENT_PROTOCOL` (e.g. old
  agents that send 0) are still accepted but served the empty state (no
  inbounds, no users) and flagged in the node's `last_error` /
  `agent_protocol`. **Rollout: upgrade agents before the panel.**
- **Fail-closed lease**: after every successful read of a node's desired
  state (initial sync, every 60 s reconcile) the panel grants the agent a
  lease (`grpc.lease_seconds`, default 24 h). An agent that gets no grant for
  that long (panel unreachable, or panel up but its database down) stops
  xray, forgets its versions and reports the final counters after it
  reconnects. The agent measures the lease on CLOCK_BOOTTIME (suspend does
  not extend it), clamps it to >= 1 h and only arms it after the first
  grant (older panels never arm it). Node view: `lease_remaining_seconds`.
- **Traffic accounting**: agents report *cumulative* per-user counters; the
  agent tags each report with the session (xray instance lifetime) the
  counters belong to. The panel keeps the high-water mark per
  `(node, user, session)` in `traffic_counters` and bills
  `max(new - old, 0)` computed by PostgreSQL in one statement, so restarts,
  retries, duplicates and reordered reports never double-bill and a failed
  flush loses nothing. Requires PostgreSQL >= 18 (`RETURNING old/new`).
- **Per-user counters** are keyed by xray's user `email` field, which is set
  to the panel user id — the identity mapping between panel and core is
  identity itself.
- **Nothing to fingerprint**: every request that doesn't know the install's
  random route prefix (including `/`), and every rejection behind it (wrong
  method, bad token, missing asset), gets the same empty 404 without the
  panel's security headers, byte-identical apart from `Date`.

- **Change notification (multi-instance)**: every change of a node's
  desired-state versions (and every node deletion) raises
  `NOTIFY akari_change '<node id>'` (`'del:<id>'`) from a trigger on `nodes`,
  inside the writing transaction; every panel instance LISTENs on a
  dedicated connection and wakes only its own sessions of that node. After
  any listener reconnect all local sessions re-read their node, a self-ping
  every 30 s detects half-open listener connections, and every session still
  reconciles every 60 s. Several panel instances can therefore share one
  database. **LISTEN needs a direct PostgreSQL session: do not put the panel
  behind PgBouncer in transaction/statement pooling mode** (session pooling
  is fine). A warning is logged when `pg_notification_queue_usage()`
  exceeds 10% (a stuck listener; when the queue is full every mutation
  fails).
- **Node deletion** (two phases): the delete marks the node deleting and
  disables it, so its agent converges to the empty state (no inbounds, no
  users) while its final counters are still billed. Once the agent acked
  that (plus 10 s for flushes), or after 2 min, or at once if no agent is
  online, a background task on any panel instance tombstones the
  certificate serial (`revoked_certs`, permanent) and deletes the node
  (assignments cascade; `traffic_counters` billing rows are kept). A
  session still open is closed with UNAUTHENTICATED. A revoked certificate
  that connects again is accepted only to be served the empty state and
  closed (a refused agent would keep running its last config); it is never
  billed and can never be registered again (also the certificate it renewed
  from, if still accepted). Reinstalling needs a new `akari node add`.
- **Billing plausibility caps** (only ever under-bill; the counter is stored
  in full): every cap credits at most a short burst window of elapsed time
  (`traffic.node_burst_secs`, default 120 s) — per (node, user, session)
  `traffic.max_rate_bytes_per_sec`, and per node (all users together) a
  GCRA budget of `traffic.node_max_rate_bytes_per_sec` (default 10 Gbit/s;
  per-node override `traffic_max_rate_bytes_per_sec` via PATCH) against
  `nodes.traffic_tat` in the DB, so a panel restart grants nothing and an
  under-using node cannot bank a large burst. Only a recorded connectivity
  gap extends it: when an agent comes back online, the time since the node
  was last seen (at most the lease) is credited once, so traffic delayed by
  an outage still bills in full. Likewise the panel's own flush outage
  (database down while agents stayed connected): the first successful
  flush after failures credits the time since this instance's last
  successful flush (at most the lease) to the nodes it writes, once. An unassigned user's pair only bills
  traffic plausibly carried before the unassignment (+30 s), cumulatively
  across flushes.

## Plans and node groups

- **Node groups** collect nodes (a node can be in many groups). **Plans**
  grant groups and set a traffic quota (`null` = unlimited) and a reset
  period: `monthly` (on the anchor's day of month, clamped to the month's
  end, UTC), `days-N` (every N days, 1–3650) or `none`. `speed_limit_mbps`
  is **enforced** per user by the agent (W7, agent protocol 4: each
  direction, shared by all of the user's connections on a node, XTLS
  splice disabled for limited users; older agents run the user unthrottled
  and the node shows a warning); `device_seats` is stored for seat binding
  (with the client, R25) and **not enforced**. A disabled plan is no longer
  offered for new assignments; existing subscribers keep it. Prices, stock
  and sale rules are in docs/PAYMENTS.md.
- **User plans**: one active plan per user (admins cannot have one).
  Assigning replaces the active plan; while it is active the user's
  `traffic_limit_bytes` and `expires_at` are the plan's (PATCH /users
  refuses to edit them, 409; renew with PATCH /users/{id}/plan). Cancel or
  expiry ends the plan and removes plan access; the enforced limit/expiry
  stay as they were.
- **Entitlement**: the user's nodes = the members of their active plan's
  groups. Every change to groups, memberships, plans, user plans or a node's
  inbounds reconciles `node_users` in the same transaction: one credential
  per eligible inbound (vless/vmess/trojan) is issued, credentials of
  inbounds that still exist are kept (clients keep working across plan
  changes), access no longer granted is revoked (final counters are still
  billed for the departed grace), and exactly the affected nodes are bumped.
- **Manual assignment is an override**: `POST /users/{id}/nodes/{node}` pins
  the pair (the reconcile never touches it); `DELETE` hands a pinned pair
  back to the plan when the plan grants it (credentials of still eligible
  inbounds kept), or removes it. Assignments made before M3 are all pins:
  to migrate, create groups/plans, assign the plans, then remove the pins.
- **Quota and resets**: the traffic-limit pass disables over-quota users
  with `disabled_reason = quota`. The period reset (any instance, every
  flush tick, DB clock) zeroes usage once per period — restart-safe and
  idempotent via `user_plans.next_reset_at`; missed periods collapse into
  one reset — and re-enables users disabled **only** for quota; a plan
  change that admits a quota-disabled user re-enables them too. An admin's
  explicit disable (`disabled_reason = admin`) is never undone
  automatically. Resets and plan expiry are audited with actor `system`.

## Payments (Alipay Face-to-Face)

Plans can be sold through Alipay 当面付 (QR code): admins price plans
(integer CNY cents per `period_days`), users buy from the portal, and the
paid order grants or extends the plan in one transaction, exactly once,
whether the payment is learned from the async notify, from status polling
or from the background reconcile. Buying the active plan again extends it
by its period; buying another plan replaces the active one (usage reset).
W16 (M7): coupons (percent/fixed, scoped, limited, race-free reservation),
a per-user balance (余额) with an append-only ledger (orders can be paid
fully or partly from it), invite commissions (pending for a hold period,
then balance; reversed by a refund) and manually paid-out withdrawals.
Setup, sandbox testing, notify URL rules and reconciliation:
[docs/PAYMENTS.md](docs/PAYMENTS.md).

## Registration, password reset and email (W15)

Off by default. In **系统设置 → 邮件** configure SMTP (STARTTLS / SSL/TLS /
plain for a local relay; the password is stored encrypted with the
data/totp.key key and never shown again) and send a test mail; then
**系统设置 → 注册** opens self-service registration (email + 6-digit code,
optional invite code requirement, optional email domain allow-list,
optional trial plan for N days) and/or password reset by emailed link
(needs the main domain). While a feature is off its endpoints are the same
empty 404 as any unknown path. Requests never wait for SMTP: mails go into
an outbox that a background sender on any instance delivers with retries;
failures show up as dead letters under 系统设置. The same outbox carries
order receipts and, while enabled, plan-expiry reminders (N days before),
"expired" and traffic 80% / 100% notices (once per event) — only to
verified addresses, in the account's language (zh/en). Users add or change
their address in the portal (current password + emailed code) and can log
in with it. Details: docs/DEPLOY.md §2c.

## Accounts

Only `role=user` accounts are proxy users. Admin accounts are never pushed
to nodes, cannot be assigned to one (400), get the rejection 404 on
subscription URLs and are exempt from traffic-limit disabling and expiry.
Changing a user to admin removes their node access; changing back restores
it. Raising a traffic limit does not re-enable a user the limit disabled.

## Security: two-factor, audit log, secret rotation

**Two-factor (TOTP, RFC 6238: SHA-1, 6 digits, 30 s, ±1 step).** Optional
for every account and recommended (the admin console shows a banner until
it is on). With `[auth] require_admin_2fa = true` it is mandatory for
admins: an admin without active TOTP who logs in with the right password
gets a 15-minute *enrollment-only* session that reaches nothing but
`/api/v1/me/totp*` (the SPA shows the setup screen). Enrollment shows the
secret once (a QR code drawn in the browser — nothing is fetched — plus the
base32 key and the `otpauth://` URI) and activates only after a valid code;
activation issues 10 single-use recovery codes (shown once; copy or
download as .txt) and ends the account's other sessions. Login sends password and code in **one** request (`code` = TOTP
code or recovery code); every failure — unknown account, wrong password,
missing/wrong/replayed code — is the same 401 after the same work, and
counts toward the login rate limit. A code (and any older one) is accepted
once per account across all instances (DB-recorded time step); the DB clock
is used. Secrets are stored AES-256-GCM-encrypted with a key derived from
`data/totp.key` (0600, created on first start — **back it up with the rest
of `data/`**: without it every enrolled account needs a reset); recovery
codes as keyed HMAC-SHA-256. Lost authenticator: `akari admin reset-2fa
<login>` (or another admin: 用户 → 管理 → 重置两步验证); the account's
sessions end and it logs in with its password again.

**Audit log.** Every administrative change (API and CLI — CLI actions are
recorded as actor `cli`), 2FA change, secret rotation and login is recorded
with time (transaction start), actor, client address, action, target and
redacted before/after snapshots — in the same transaction as the change.
Passwords, hashes, tokens, TOTP secrets, recovery codes, proxy credentials
and inbound keys are never recorded (only that they changed; inbounds as a
tag/protocol/port summary plus a digest). Failed logins are recorded only
for existing accounts (first failure per rate-limit window, the one that
fills it, every second-factor failure); successful logins of regular users
at most once per 10 minutes per account. Admins: Audit view, or `GET
/api/v1/audit`. Retention: `[audit] retention_days` (default 365, 0 =
forever), pruned hourly.

**Secret rotation.**
- `akari secrets rotate-jwt`: new `data/jwt.key`; every session ends at once
  (all instances); restart every instance to sign with the new key.
- `akari secrets rotate-prefix`: new route prefix in `data/state.json`,
  effective when the panel (every instance) restarts; the old prefix then
  becomes the plain rejection. **Every subscription URL contains the prefix
  and changes with it**: users get a new link from the portal ("New
  subscription link") and must be told the new console address.
- Users regenerate their own subscription link in the portal
  (`POST /api/v1/me/sub-token`, 5 per hour); admins can do it per user.

Run the CLI as the panel's service user, against the same `data/`
directory (and database) the panel uses.

## Upgrading

**R18 (optional 2FA) upgrade:** migration 0035 drops the unused
`totp_enroll_codes` table (the one-time admin enrollment code is gone).
Admins without 2FA now log in with their password (full session) unless
`[auth] require_admin_2fa = true`. Existing 2FA setups are unchanged.

**M3 (plans) upgrade:** migration 0020 adds node groups, plans and user
plans. Existing node assignments become manual overrides and keep working
unchanged; existing disabled users get `disabled_reason = admin` (so no
reset will ever re-enable them).

**M1b (2FA) upgrade:** session tokens now carry a stage claim; every
existing session is invalid after the upgrade (everyone logs in again), and
every admin must enroll TOTP at the next login. A new `data/totp.key` is
created on first start: include it in backups.

Upgrade **agents before the panel**. The panel drops traffic reports that
lack `TrafficReport.session_id` and relies on agents never claiming a
version they failed to apply; an old agent against a new panel is not
billed and can look converged when it is not. Migrations run automatically
on `akari serve` (PostgreSQL >= 18 is required and checked at startup).

## Licence

The panel is MIT licensed (`LICENSE`). The `akari` binary statically links
Rust crates and embeds the web console built from npm packages; their
licences are checked in CI by `cargo deny check` (`deny.toml`: permissive
licences only — no copyleft reaches the panel binary) and listed, with
their licence texts, in `THIRD_PARTY_LICENSES.txt`, which every release
ships as an asset (`make third-party` writes it to `target/`;
`scripts/third-party.py`). The node agent is a separate program with its
own licensing: its source is MIT, but its released binaries are
GPL-3.0-or-later combined works (xray-core links GPL modules) — see the
akari-agent README ("Licence"). The panel only relays agent binaries for
self-update and one-line installs; it does not link them.

## Roadmap

The authoritative plan lives in `PLAN.md` (three-repo end state:
`akari-panel` / `akari-agent` / `akari-client`). Strategy decisions:

- **The subscription endpoint is transitional.** Once our own client
  (embedding mihomo) ships, the third-party formats (base64 links,
  sing-box JSON, generic Clash) are retired; only the Clash config for
  akari-client remains.
- **Device limiting is seat-based binding** (client registers its device),
  not IP-based — implemented with akari-client, deliberately not built now.

Done: control plane, auth/REST API, embedded SPA, transitional subscription
(REALITY/TLS/WS mapping, padding, hashed tokens — WS+gRPC transport mapping
is partial). Next: repo split → akari-client MVP (mihomo embed) → seat
binding (+ subscription retirement) → agent CSR/auto-update → payments.
