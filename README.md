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

## Quick start / 快速开始

On a fresh Debian 12/13 or Ubuntu 22.04/24.04 server (root or sudo) — 在全新的 Debian 12/13 或
Ubuntu 22.04/24.04 服务器上执行：

```bash
curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh | sh
```

Interactive (Chinese/English), every prompt has a default: Docker Compose or bare metal
(PostgreSQL 18 + Valkey 9 + Caddy under systemd), domain or IP only, the admin's e-mail address
(its login name; password generated and printed once). The release is verified (cosign-signed SHA256SUMS) before anything is
installed. Afterwards: `akari-ctl status | info | upgrade | backup | migrate --to docker|bare |
uninstall [--purge]`. Non-interactive: `… | sh -s -- --yes --mode bare --domain panel.example.com`.
Details, manual installation, upgrade/rollback/migration: `docs/DEPLOY.md`.

## Status / what works

End-to-end verified by `./smoke.sh` (fully API-driven):

- `akari admin add <email>` creates the first account (v0.4 D1: everyone,
  admins too, logs in with the e-mail address; password via
  `AKARI_ADMIN_PASSWORD` env or hidden prompt; argon2id hashing).
- All panel API lives under a per-install random route prefix. Anything that
  guesses wrong — including the bare prefix and `/` — gets one identical
  empty 404 (no body, none of the panel's security headers).
- **Bot protection of the public forms (W27, `botguard.rs`)**: login,
  registration (code + submit) and the reset request take an optional
  `guard: {form_token?, website?, turnstile?}`. Honeypot (default on): a
  non-empty `website` (a field people never see) is a bot. Minimum submit
  time (default 2 s, 0 = off): `form_token` (from `/auth/options`; an HMAC
  of its issue time with a key derived from `data/master.key`, valid 24 h)
  must be at least that old. A trapped request gets exactly the answer of an
  ordinary failure of that form (login: the uniform 401, counted like a
  wrong password; mail requests: `{"ok":true}`, nothing sent; registration:
  the generic refusal) and increments only `akari_bot_trap_total{form,reason}`
  (no log line). Cloudflare Turnstile (per form, default off) is verified
  server side after those checks and fails closed (400/503). Clients: fetch
  `/auth/options`, wait `form_min_secs`, post `guard.form_token`; the
  console's Turnstile widget (CSP: `challenges.cloudflare.com`) is not built
  yet (W36-b).
- **Passkeys (W27, `passkey.rs`, webauthn-rs)**: RP ID = the main domain's
  host (https DNS name; otherwise passkeys are unavailable and no policy
  applies). Usernameless login (no address sent: no account oracle);
  ceremony state in Valkey, single use, 5 min. Password login is refused
  (403 `auth.passkey_required`, only after the right password) when the
  account has a passkey for today's RP ID and chose passkey-only or its
  role's policy says so; without a current passkey the password always
  works (a domain change or deleting the last passkey never locks anyone
  out). The login answer's `passkey_prompt` asks the page to offer binding
  one. Lost passkey: `akari admin reset-login <email>`.
- `POST /{prefix}/auth/login` (`{email, password}`) verifies argon2id hashes
  (timing-equalized for unknown addresses; failed attempts rate limited per
  client address — IPv6 per /64 — at 20/15min and per address at 50/15min,
  in Valkey) and issues
  an HS256 JWT in an `HttpOnly` `SameSite=Strict` cookie (12h; `Secure`
  unless `web.cookie_secure = false`). The token carries the account's
  `session_ver`: a password change, disable, role change, expiry, logout or
  `POST /api/v1/users/{id}/revoke-sessions` ends every session of the
  account (logout = log out everywhere; a copied cookie dies with it). The
  last enabled admin cannot be disabled, demoted or deleted (409; enforced
  by a DB trigger, race-free). Every administrative change is in the audit
  log (see "Security" below). (TOTP two-factor authentication was removed in
  v0.4: passkeys replace it.)
- Admin API: user CRUD, node listing/enable, the node's xray `inbound`
  (one per node), entrances (credentials are panel-generated by the plan
  reconcile, one per granted entrance).
- **Plans (M3)**: node groups, plans (traffic quota, monthly / every-N-days
  / no reset, granted groups) and user plans. A user's nodes follow their
  plan automatically — credentials are issued and revoked by the panel (see
  "Plans and node groups" below); there is no manual per-node assignment
  (D3). Periodic traffic resets re-enable users disabled only for
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
  lease expiry, and 撤权方式 = 重建 (系统设置 → 节点通信) all take that path.
  Disabling a user via the API propagates to connected agents within a
  second.
- Heartbeats (15s) land in Valkey; traffic counters (10s polls) flow to the
  panel where deltas are applied idempotently against a session-scoped
  baseline.
- **Node operations (W11, docs/DEPLOY.md §3e)**: xboard-style node form —
  display name (user-facing; `name` stays the unique internal name), sort,
  shown to users or hidden, tags (shown in the portal and in subscription
  names "香港 01 | IPLC 直连"). W28-a: a node has one inbound and is reached
  through entrances — every node has its built-in 直连 (direct) entrance
  (can be disabled); the entrance carries the traffic multiplier 倍率
  (0–100x, exact permille; billed = floor(raw × rate) inside the flush SQL
  only, the rate in effect at flush time applies; the node keeps raw and
  billed totals), 连接地址/连接端口 (NAT / port forwarding; all three
  subscription formats and the panel's TCP test use them) and node-group
  membership; each usable entrance is its own subscription entry (with its
  multiplier in the name when not 1x). Relay entrances (IPLC, forwarding
  VPS) are served on derived inbounds: the node's inbound on another port
  with their own credentials, reachable only from the relay's egress
  addresses (nftables, agent capability `source-filter`; applied by the
  agent's root updater: the agent has no `CAP_NET_ADMIN`).
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
  address and per user (built-in limits); over the limit is the same empty 404.

- Payments (W24/R40): pluggable payment methods configured in 系统设置 → 支付
  (database only; Alipay Face-to-Face is the first kind, several methods
  allowed, secrets sealed, 测试连接); see docs/PAYMENTS.md. Self-service
  registration with or without email verification (系统设置 → 注册).

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
  admins) and one view per URL (W20; top nav on desktop, bottom tab bar on
  phones): dashboard `/app` (plan, days and traffic left, the permanent
  subscription link with copy/QR/format/one-click import, announcements),
  `/app/shop`, `/app/nodes`, `/app/orders`, `/app/wallet` (invites and
  balance), `/app/tickets`, `/app/account` (email, password, language)
  — Chinese/English;
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

`scripts/install.sh` (the one-command installer above, installed as `akari-ctl`: install, upgrade
with backup + health check + automatic rollback, uninstall, bare metal ⇄ Docker migration, host
moves via `--restore`), `docs/DEPLOY.md` (installer, then by hand: Docker Compose or systemd,
Caddy/nginx, firewall, first admin, node install, upgrade order, rollback, uninstall, migration,
release verification), `docs/BACKUP.md`
(age-encrypted backup/restore and the restore drill), `deploy/` (units, compose, proxy examples,
Prometheus alerts, Grafana dashboard). Release artifacts (static linux amd64/arm64 binaries,
distroless image `ghcr.io/akari-projectx/akari-panel`, SBOM, cosign signatures) come from the
`release.yml` workflow on `v*` tags. `akari --version`, `akari config check` (validates and prints
the effective config, secrets redacted). Optional `[metrics] bind` serves Prometheus metrics on a
separate loopback listener, never on the public port.

### API surface (all under the secret prefix)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /auth/login | — | `{email, password, guard?}` (D1: the address, any case, verified or not): argon2id, sets the session cookie; → `{id, email, role, expired, quota_exhausted, banned, passkey_prompt}` (R21 renewal scope; W28-c: a banned role=user account signs in to the portal scope*). Every failure is the uniform 401 — including a trapped bot (W27 `guard`, below). Turnstile on: 400 `auth.captcha_failed` (missing/rejected token) / 503 `auth.captcha_unavailable` (verifier unreachable) |
| POST | /auth/passkey/options | — (passkeys available) | W27: discoverable-login challenge `{state, options}` (`options` = WebAuthn `publicKey` request options; `no-store`; 30/min per client address). No https main domain = the canonical rejection |
| POST | /auth/passkey/login | — (passkeys available) | W27: `{state, credential}` (the browser's `PublicKeyCredential` JSON) → session cookie + the login answer. Every failure is the uniform 401 |
| POST | /auth/logout | — | clears the cookie and ends all of the account's sessions |
| GET | /auth/options | — | W15: what the login page offers `{register, invite_required, email_domains, reset, email_verify, site_name, branding, guard}`; `Cache-Control: no-store`. W27 `guard` = `{form_token, form_min_secs, honeypot, turnstile: {site_key, login, register, reset} \| null}` (null = settings unreadable: the forms refuse) |
| POST | /auth/register/code | — (registration + verification on) | W15: `{email, invite_code?, locale?, guard?}` → `{"ok":true}` for every address (a code by mail, or an "already registered" mail); rate limited per client and address |
| POST | /auth/register | — (registration on) | W15: `{email, code \| pow, password, invite_code?, locale?, guard?}` (`code` when 注册需要邮箱验证 is on, else the W24 proof of work); a trapped bot gets the mode's generic refusal → account (address verified) + session `{id, email, role, …}`; wrong/expired/used code = 400 `invalid or expired code` |
| POST | /auth/password-reset/request | — (reset on) | W15: `{email, guard?}` → `{"ok":true}` for every address (and for a trapped bot: nothing sent); a 30-minute single-use link goes to a verified address |
| POST | /auth/password-reset | — (reset on) | W15: `{token, password}`: new password, every session ends |
| GET | /api/v1/me | user (portal scope*) | profile (`email` = the login name, `email_verified`) + traffic usage; `expired` / `quota_exhausted` (R21); W28-c `banned`, `ban_reason` (written by the admin for the user), `banned_at`; W20: `sub_token` + `sub_url` (the subscription link, `Cache-Control: no-store`; null for admins and the renewal scope; an account without a token gets one here), `sub_legacy` (pre-W20 link: works, cannot be shown until reset), `probe_interval_secs` |
| POST | /api/v1/me/sub-token | user (role=user) | reset own subscription (5/hour): new link AND new credentials on every entrance (高-3) — the old link and every imported client stop working (live connections are cut); `credentials_rotated` = how many |
| GET | /api/v1/me/plan | user | own active plan (or null), usage, enforced limit/expiry, node names + regions (Q3: `plan.next_reset_at` with the site time zone's offset) |
| GET | /api/v1/me/nodes | user | W11: own visible entrances (W28-a: one row per usable entrance) — node display name, `entrance` name, region, tags, the entrance's multiplier, online, latency (no ids, addresses or machine metrics) |
| POST | /api/v1/me/email/code | user (renewal scope*) | W15: `{email, password}`: code to the new address (current password required; same answer if the address is taken) |
| POST | /api/v1/me/email/verify | user (renewal scope*) | W15: `{code}`: the address becomes the account's verified email and its login name (D1) |
| PUT | /api/v1/me/locale | user (renewal scope*) | W15: `{locale: zh\|en}`: language of the account's mails |
| GET/POST | /api/v1/me/invite-codes | user (role=user) | W15: own invite codes, link base, invited count / new code (per-user limit; registration must be open) |
| DELETE | /api/v1/me/invite-codes/{code} | user (role=user) | W15: delete an invite code |
| GET/PUT | /api/v1/settings/signup | admin | W15 系统设置 → 注册: registration, invite rules, email domain allow-list, trial plan, password reset, `email_verify` (W27: a plain bool, default false; true needs mail sending) (optimistic `version`) |
| GET/PUT | /api/v1/me/passkeys | user (renewal scope*) | W27: GET `{available, rp_id, passkeys: [{id, name, created_at, last_used_at, current}], password_set, password_login_disabled, password_login, max}`; POST `{state, credential, name, disable_password?}` → 201 `{id, name}` (stores a verified passkey; `disable_password` = the login prompt's "passkey only") |
| POST | /api/v1/me/passkeys/options | user (renewal scope*) | W27: registration challenge `{state, options}` (resident key + user verification required; 20/hour; ≤10 per account; 409 `account.passkey_unavailable` without an https main domain) |
| PATCH/DELETE | /api/v1/me/passkeys/{id} | user (renewal scope*) | W27: rename `{name}` / delete (someone else's id = the canonical rejection) |
| PUT | /api/v1/me/password-login | user (renewal scope*) | W27: `{enabled}`: the account's own passkey-only switch (off needs a current passkey, 409 `account.passkey_required`) → the GET view |
| GET | /api/v1/users/{id}/passkeys | admin | W27: an account's login methods (same view) |
| POST | /api/v1/users/{id}/login-method/reset | admin | W27: lost passkey: delete the account's passkeys, password login back on (audited `user.login_method.reset`) → `{deleted_passkeys}`; CLI `akari admin reset-login <email>` |
| GET/PUT | /api/v1/settings/auth | admin | W27 bot protection of the public forms and the passkey policies: `{version, turnstile_site_key, turnstile_secret?, turnstile_login, turnstile_register, turnstile_reset, honeypot, min_submit_secs, passkey_only_admins, passkey_only_users, passkey_prompt}` (GET/PUT answer adds `warnings`); the secret is write-only (absent = keep, `""` = remove; sealed with the master key; GET answers `turnstile_secret_set`; audit `settings.auth.update` records it as `"changed"`); a form switch needs both keys (`auth_admin.turnstile_incomplete`); `min_submit_secs` 0–60 (0 = off). CLI way back in: `akari settings unset turnstile` |
| PUT | /api/v1/settings/site | admin | W21 site name + Q3 site time zone: `{version, site_name?, timezone?}` (each: absent = unchanged, `null`/`""` = the default — "Akari" / `Asia/Shanghai`); `timezone` is a full IANA name PostgreSQL knows (`Asia/Shanghai`, `UTC`, `America/New_York`; abbreviations such as `CST`, POSIX strings such as `UTC+8`, wrong case = 400 `settings.timezone_invalid`); answers the settings view (`timezone: {value, effective, default, source}`); audited `settings.site.update`. The time zone sets the day of the traffic history and block rule counts, plan monthly resets and calendar-month terms (local day and time of day; DST keeps the local time), the dashboard's days and the CSV export ranges; it applies from the next write on (stored days are not rewritten) |
| GET/PUT | /api/v1/settings/mail | admin | W15 系统设置 → 邮件: provider (W31: `smtp` or `resend`; absent = keep), SMTP host/port/security/credentials (password write-only, sealed), Resend `api_key` (write-only, sealed; view: `api_key_set`), sender, notice switches (`notify_refund`: the refund notice, absent = unchanged) |
| POST | /api/v1/settings/mail/test | admin | W15: `{to}`: send a test mail now with the saved settings (502 = the server's answer) |
| POST | /api/v1/settings/mail/diagnose | admin | W31: `{to}`: step-by-step check of the saved provider — config, DNS, TCP, TLS (implicit 465 / STARTTLS 587, mismatch detected), greeting, AUTH, send — always 200 `{provider, ok, steps: [{step, status ok\|warn\|fail\|skip, elapsed_ms, code mail.diag.*, params, message: {zh, en}}]}`; audited `settings.mail.test` |
| GET | /api/v1/system/status | admin | W31 系统状态: every panel instance (host CPU/memory/load/disk, RSS, version, agent sessions; Valkey heartbeats), PostgreSQL, Valkey, the reverse proxy (Caddy, probed via the main domain), background jobs (settlement, reconciliation, mail, alerts: last run, duration, lag, stale, last error, backlog); cached 5 s |
| GET | /api/v1/mail/outbox | admin | W15: outbox rows `?status=dead\|pending\|sent&before&limit` (no bodies) |
| POST | /api/v1/mail/outbox/{id}/retry | admin | W15: re-queue a dead letter (not for expired codes/links) |
| POST | /api/v1/me/password | user/admin | `{current_password, new_password}`: change own password (wrong current = 400, counts against the login rate limit; other sessions end, this one continues) |
| GET | /api/v1/audit | admin | audit log, `?limit&before&actor&action` (keyset, newest first; `actor` = an exact `actor_label`). Entries: `actor_id`, `actor_label` (Q4: non-personal — `u-<8 hex of the id>`, `cli`, `system`, `agent`, `anonymous`), `actor_email` (the account's current address, null when not an account or deleted) |
| GET/POST | /api/v1/users | admin | list (`?q&plan_id&status=active\|expired\|quota\|banned&role&sort&limit&offset`; `q` = address prefix or id prefix; `sort` created\|-created\|email\|-traffic\|expires) / create `{email, password, role?, plan?: {plan_id, period, days?}}` (D1: the address is required and counts as verified; taken = 409 `user.email_exists`. D12: the plan and its term, assigned in the same transaction; never a traffic limit or expiry) |
| GET | /api/v1/users/{id} | admin | D12/W28-c detail: the list row + `subscription` (null without a plan: `{user_plan_id, plan_id, plan_name, period, period_days, starts_at, expires_at, traffic_used_bytes, traffic_total_bytes, reset_period, last_reset_at, next_reset_at, timezone, speed_limit_mbps, status: active\|expired\|over_quota\|banned}`; Q3: `next_reset_at` is RFC 3339 with the site time zone's offset, e.g. `2026-11-01T00:00:00+08:00`, and `timezone` is that zone) + `ban` (null unless banned: `{reason, banned_at, banned_by_id, banned_by_email}`) |
| PATCH/DELETE | /api/v1/users/{id} | admin | update `{password?, role?}` (D12: no `traffic_limit_bytes`/`expires_at`; W28-c: no `enabled` — ban instead; unknown fields 400) / delete user (中-7: `?confirm=true` required, else 400 `user.delete_confirm_required`) |
| GET | /api/v1/users/{id}/delete-impact | admin | 中-7: what deleting the account loses: `{email, balance_cents, withdrawable_cents, pending_withdrawals, pending_withdrawal_cents, pending_orders, unfulfilled_orders, plan: {name, expires_at}|null}` (the console's confirmation shows it) |
| POST | /api/v1/users/{id}/ban | admin | W28-c `{reason}` (1–500 characters, shown to the user): disable (`disabled_reason = admin`), every node drops the user at once (live connections cut), every session ends, the subscription is the canonical rejection; banning again replaces the reason; not yourself (400 `user.ban_self`), not the last enabled admin (409); audited `user.ban`; returns the detail |
| POST | /api/v1/users/{id}/unban | admin | W28-c: lift a ban (409 `user.not_banned` otherwise); audited `user.unban`; returns the detail |
| GET/PUT/PATCH/DELETE | /api/v1/users/{id}/plan | admin | active plan + history (with `period`/`period_days`) / D12 assign or change `{plan_id, period, days?}` (period = month…three_year, `days` (needs days), `onetime` (days optional = permanent); not `reset`; from now, usage zeroed) / renew `{period, days?}` (one more term) or `{extend_days}` (1–3650; not for `onetime` purchases: 409 `user_plan.extend_onetime`), both from max(expiry, now) (no expiry: 409 `user_plan.no_expiry`) / cancel (no plan: 409 `user_plan.none`) |
| POST | /api/v1/users/{id}/plan/reset-traffic | admin | D12 `{confirm: true}`: zero the plan traffic (reset schedule unchanged, a quota-disabled account re-enabled, never a banned one); audited `user.traffic.reset`; returns `{subscription}` |
| GET/POST | /api/v1/node-groups | admin | list / create `{name, description?, entrance_ids?}` (W28-a: groups hold entrances) |
| PATCH/DELETE | /api/v1/node-groups/{id} | admin | rename, describe, replace `entrance_ids` / delete |
| GET/POST | /api/v1/plans | admin | list / create `{name, period, traffic_quota_bytes?, speed_limit_mbps?, device_seats?, sort?, enabled?, group_ids?, description?, capacity?, renewal_only?, renew_off_sale? (中-6, default true: off sale, subscribers still renew), allow_switch_in?}` (views include `on_sale` and `prices`) |
| PATCH/DELETE | /api/v1/plans/{id} | admin | update (same fields; null clears nullable ones; 中-5: changes new purchases only unless `apply_to_existing: true`, which gives the active subscriptions all of the plan's current terms) / delete (409 while users hold it) |
| POST | /api/v1/plans/{id}/impact | admin | 中-5: body = the PATCH to preview → `{subscribers, over_quota}` (active subscriptions; how many already used more than the resulting quota) |
| GET/POST | /api/v1/nodes | admin | W17: `?view=summary` = the list's columns only (no inbound JSON, slim heartbeat, best agent latency, `alerts_firing`, `needs_certificate`), with an ETag (`If-None-Match` → 304; `?view=full`, the default, also carries one); full: node list with live status, certificate expiry, last heartbeat (W11: machine status, latency, tags), the node's one `inbound` (W28-a, null = none) and its `entrances` (`[{id, kind, name, connect_host, connect_port, rate_permille, rate, enabled, sort, wire_no, listen_port, source_cidrs, health_ok, health_at, health_failures, health_error, hidden_since, group_ids}]`; a relay hidden by the health test (3 failed TCP connects in a row) is left out of subscriptions and `/me/nodes` until it answers again, and raises the node's `entrance_down` alert, the built-in `direct` entrance first, then the relays), warnings / create a node `{name, region?, tls_domain?, template? \| inbound?, install?: {origin?}, display_name?, sort?, visible?, tags?, direct?: {connect_host?, connect_port?, rate?, enabled?, sort?, group_ids?}}` (one inbound: a template or an xray inbound object without tag; `direct` sets the built-in direct entrance; 201: one-time enrollment token + bootstrap file + one-line install command, shown once) |
| GET | /api/v1/nodes/{id} | admin | W17: one node, full view (the node page) |
| GET/PUT | /api/v1/nodes/{id}/alert-rules | admin | W17: per-node alert overrides `{muted, disabled: [kind], offline_secs?, cpu_percent?, cpu_minutes?, mem_percent?, mem_minutes?, disk_percent?, cert_days?}` (null = the global value) |
| POST | /api/v1/nodes/{id}/install | admin | new one-line install command `{origin?}` (re-install; replaces the node's unused token) |
| GET | /api/v1/inbound-templates | admin | template choices (REALITY dests, fingerprints) |
| POST | /api/v1/inbound-templates/render | admin | `{template, taken_ports?, tls_domain?}` → `{inbound, needs_certificate}`: one xray inbound object (fresh REALITY keys; nothing stored; a port in `taken_ports` = 400 `template.port_clash`; `tls_domain` = the node's TLS domain, default certificate domain) |
| POST | /api/v1/inbound-templates/check-domain | admin | `{domain, node_id?, connect_host?}` → what the domain resolves to vs. the node's addresses (agent address, direct entrance host; warn-only pre-flight for 节点域名) |
| POST | /api/v1/inbound-templates/check-dest | admin | TLS 1.3 + h2 check of a REALITY dest from the panel |
| POST | /api/v1/nodes/{id}/enroll-token | admin | new one-time enrollment token + bootstrap file (re-enrollment) |
| PATCH/DELETE | /api/v1/nodes/{id} | admin | enable / rename / region / billing cap override / W11 `display_name`, `sort`, `visible`, `tags` (multiplier, address and groups: `PATCH /entrances/{id}`); delete (202, revokes the certificate); `tls_domain` = 节点域名: the agent obtains its certificate itself (change bumps config_version, DEPLOY §3f) |
| POST | /api/v1/nodes/{id}/entrances | admin | W28-a: a relay entrance `{name, connect_host, connect_port, listen_port, source_cidrs, rate?, enabled?, sort?, group_ids?}` (201): an external relay forwarding to the node. The node serves it on a derived inbound (its inbound on `listen_port`, own per-user credentials) that accepts new connections only from `source_cidrs` (the relay's egress, 1–64 IPs/CIDRs; enforced by agents with `source-filter`); clients dial `connect_host:connect_port`; numbered `wire_no` (agent key `<user>#<n>`). Refused: a port the node already serves (`entrance.port_clash`), a name the node has (409). Audited `entrance.create` |
| PATCH/DELETE | /api/v1/entrances/{id} | admin | W28-a: an entrance's `{name?, connect_host?, connect_port?, rate?, enabled?, sort?, group_ids?}`, relays also `{listen_port?, source_cidrs?}` (direct: null host = the node's TLS domain, null port = the inbound's; a relay keeps both; `rate` 0–100, 3 decimals; disabling it removes its users from the node; audited `entrance.update`) → the entrance / delete a relay (204; the direct entrance: 409 `entrance.direct_permanent`; audited `entrance.delete`) |
| GET | /api/v1/nodes/{id}/status | admin | W11: latest heartbeat + machine status, online, latency results, raw/billed traffic |
| GET | /api/v1/nodes/{id}/metrics | admin | W11: history `?range=1h\|6h\|24h\|48h\|7d\|30d\|90d` (averages and maxima per point, ≤ 360 points) |
| POST | /api/v1/nodes/{id}/probe | admin | W11: "立即测速" (202; 429 within the built-in 30 s cooldown) |
| PUT | /api/v1/nodes/{id}/inbound | admin | W28-a: `{inbound}` replaces the node's one xray inbound (an object without tag; null = none; bumps config_version). Users keep their credentials when the protocol stays, get new ones when it changes |
| POST | /api/v1/users/{id}/sub-token | admin | reset the user's subscription: new token + new credentials on every entrance (高-3, as above) |
| GET | /api/v1/users/{id}/subscription | admin | W20: the user's subscription link `{sub_token, sub_url, legacy}` (every read is audited as `user.sub_token.read`, without the token; `no-store`) |
| POST | /api/v1/users/{id}/revoke-sessions | admin | log the account out everywhere (204) |
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
| GET | /api/v1/orders | admin | orders, `?status&email&out_trade_no&unfulfilled&via&before&limit` (keyset; `via=manual` = admin-created/confirmed; `email` = the buyer's current address). Rows carry `user_label` (Q4 snapshot) and `user_email` (current address, null once deleted) |
| POST | /api/v1/orders/manual | admin | Ops: `{user_id, plan_id, period, gift?, reason}` → a paid order through the one pay path (`paid_via` manual; amount = the period's price from SQL, 0 for a gift, never from the client; fulfilment failure = 409 and nothing kept) |
| GET | /api/v1/orders/export.csv | admin | Ops: orders CSV `?from&to&status&via` (days of the site time zone: local midnights; ≤366, default last 30; audited) |
| GET | /api/v1/users/export.csv | admin | Ops: users CSV with the list filters `?q&plan_id&status&role&sort` (streamed, UTF-8 BOM, formula-safe; audited) |
| GET | /api/v1/traffic/export.csv | admin | Ops: fleet traffic history CSV `?from&to&group=day\|node` (site days, column `day`; audited) |
| POST | /api/v1/users/batch/preview | admin | Ops: `{selection: {ids} \| {filter}}` → `{total, admins, sample}` |
| GET/POST | /api/v1/users/batch | admin | Ops: recent jobs / create `{selection, action: {kind: extend_expiry {days} (periodic subscriptions only)\|reset_traffic\|ban {reason}\|unban\|set_plan {plan_id, period, days?}\|cancel_plan\|add_balance\|send_email, …}}` → 202 + job (runs in the background, each user once through the existing `apply_*`, audited per user) |
| GET | /api/v1/users/batch/{id} | admin | Ops: job progress + items (failed/skipped first) ; `POST …/cancel` skips what is still pending |
| GET/POST | /api/v1/coupon-batches | admin | Ops: batches / generate `{name?, prefix?, count ≤5000, length?, kind, value, …coupon terms, max_uses (per code, default 1)}` |
| POST | /api/v1/coupon-batches/{id}/revoke | admin | Ops: disable every code of the batch (once) |
| GET | /api/v1/coupon-batches/{id}/export.csv | admin | Ops: the batch's codes as CSV (audited) |
| GET | /api/v1/orders/{id} | admin | order + payment events |
| POST | /api/v1/orders/{id}/fulfil | admin | `{reason}`: mark an unpaid order paid (manual) or retry a failed fulfilment (audited) |
| POST | /api/v1/orders/{id}/refund | admin | W16 `{reason, to_balance, external_cents?, keep_plan?}`: refund a paid order once (balance part back; with `to_balance` the Alipay amount too, otherwise `external_cents` = what was refunded in the Alipay console, required when the order has an Alipay amount; recorded as `refund_balance_cents` + `refund_external_cents` = `refund_cents`); gives the coupon use back (低-2); reverses a pending commission and claws back a credited one (中-4: from the inviter's balance now, the rest owed and netted against later commissions); P1: undoes the order's effect on the subscription (new → cancelled, renewal → term taken back, switch → previous plan restored, reset pack → money only) unless `keep_plan` |
| GET | /api/v1/orders/{id}/refund-preview | admin | P1: `{balance_part_cents, amount_cents, effect}` — what a refund would do now (`effect.kind` none/cancel/rollback/restore); 409 when not refundable |
| GET/POST | /api/v1/coupons | admin | W16: coupons / create `{code, kind percent\|fixed, value, plan_ids?, periods?, min_amount_cents?, starts_at?, ends_at?, max_uses?, per_user_limit?, new_users_only?, enabled?}` |
| GET/PATCH/DELETE | /api/v1/coupons/{id} | admin | W16: coupon + redemptions / update (code immutable) / delete (never used only) |
| GET | /api/v1/balances | admin | W16: customers with a balance (`{user_id, email, …}`), `?email` finds anyone |
| GET/POST | /api/v1/users/{id}/balance | admin | W16: balance + ledger / adjust `{amount_cents (signed), reason}` (never below 0) |
| GET | /api/v1/commissions | admin | W16: commissions `?status&email&limit` (`email` = the inviter's); rows: `inviter_label`/`inviter_email`, `invitee_label`/`invitee_email` |
| GET/PUT | /api/v1/commission-settings | admin | W16: `{enabled, rate_percent, first_order_only, hold_days, min_withdrawal_cents}` |
| GET | /api/v1/withdrawals | admin | W16: withdrawal requests `?status&email&limit`; rows: `user_label`, `user_email` |
| POST | /api/v1/withdrawals/{id}/approve \| reject | admin | W16: `{payout_reference, note?}` after paying out by hand / `{reason}` (amount back to the balance) |
| GET/POST | /api/v1/me/tickets | user (portal scope*) | W17: own tickets (unread markers) / open `{subject, category, priority?, message, order_id?, node_id?}` (5/hour, at most 5 not closed) |
| GET | /api/v1/me/tickets/{id} | user (portal scope*) | W17: own ticket + messages (staff shown as staff, never by name); marks replies read. Anyone else's / unknown / malformed id = the canonical rejection |
| POST | /api/v1/me/tickets/{id}/replies \| close | user (portal scope*) | W17: `{message}` (30/hour; 409 when closed) / close |
| GET | /api/v1/tickets | admin | W17: queue `?status=open\|answered\|closed\|active&category&priority&assignee=me\|none\|<id>&unread=true&q&page` + open/unread counters |
| GET | /api/v1/tickets/{id} | admin | W17: ticket (`user_email`, `assignee_email`) + thread (`author_label`, `author_email`; marks the customer's messages read) |
| POST | /api/v1/tickets/{id}/replies \| close \| reopen | admin | W17: `{message, close?}` / close / reopen |
| PUT | /api/v1/tickets/{id}/assignee | admin | W17: `{assignee_id}` (an enabled admin, or null) |
| GET | /api/v1/admins, /api/v1/admin-badges | admin | W17: assignable admins; console counters (unread tickets, firing alerts) |
| GET | /api/v1/alerts | admin | W17: alert center `?status=firing\|resolved&node&kind&before&limit` + `firing` counts by kind |
| POST | /api/v1/alerts/{id}/ack | admin | W17: acknowledge (audited once) |
| GET/PUT | /api/v1/alerts/settings | admin | W17: thresholds and channels (Telegram bot, signed webhook, email); secrets write-only (`*_set` flags), `version` for optimistic concurrency (409) |
| POST | /api/v1/alerts/test | admin | W17: `{channel}` sends a test message through the saved configuration, `{ok, error?}` |
| GET | /api/v1/alerts/notifications | admin | W17: the last 100 deliveries; `POST …/{id}/retry` requeues a dead one |
| POST | /pay/alipay/notify | Alipay signature | Alipay async notify (RSA2); every refusal = the canonical rejection; see docs/PAYMENTS.md |
| GET | /sub/{token} | token | subscription (UA-based format; W20: `?format=clash\|sing-box\|links` picks it explicitly) |
| GET | /install/{token}[/agent/{arch}] | install link | node install script / agent binary while the link is live (docs/DEPLOY.md §3) |
| GET | /healthz | — | panel liveness |

\* Renewal scope (R21): also reachable by an expired or quota-disabled `role=user` account (login answers `expired` / `quota_exhausted`), together with `/me/plan` and `/me/password`; everything that serves or reveals proxy access (subscription, sub-token) stays refused. Portal scope (W28-c): the renewal scope's `GET /me` and tickets are also reachable by a **banned** `role=user` account (login answers `banned`); every other endpoint answers it 403 `account.banned`. A disabled admin account cannot log in.

Defaults bind web on `127.0.0.1:8080` and gRPC on `127.0.0.1:8443`; override
via `panel.toml` (start-up keys only, see `deploy/panel.toml.example`) or
`DATABASE_URL`/`VALKEY_URL`. Everything else is set in the console under
系统设置 (database; W25/R39) or is a built-in constant.
`akari admin passwd <email>` resets a password (and ends its sessions).
`akari node enroll-token <id>`
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
- **Revoked users' last bytes**: revoking a user's access to an entrance
  (plan change, group membership, a disabled entrance) records
  `entrance_users_departed`; the agent's final counters, which arrive after
  the removal, are still billed for `traffic.departed_grace_secs` (default
  15 min).
- **Traffic history (W22)**: every flush also records what it settled per
  user, entrance (with its node) and day of the site time zone (Q3,
  default Asia/Shanghai; `traffic_daily`, partitioned by month,
  `traffic_entrance_daily`; folded from a staging table every
  ~30 s); 流量明细保留天数 (系统设置 → 安全, default 400, `0` = forever) days
  are kept, older whole months are rolled up into months
  (`traffic_monthly`) and their partition dropped (so up to a month more
  is kept per day). Responses carry `timezone`. Admin
  `GET /api/v1/users/{id}/traffic`, `/nodes/{id}/traffic`,
  `/traffic/summary`; users `GET /api/v1/me/traffic` (node names only).
- **Removal mode** (系统设置 → 节点通信 → 撤权方式): gate (default) removes/rotates
  users in place; rebuild sends every removal/rotation as a full
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
  lease (24 h, built in). An agent that gets no grant for
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
  (entrances and access rows cascade; `traffic_counters` billing rows are kept). A
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
  end, in the site time zone — Q3), `days-N` (every N days, 1–3650) or `none`. `speed_limit_mbps`
  is **enforced** per user by the agent (W7, agent protocol 4: each
  direction, shared by all of the user's connections on a node, XTLS
  splice disabled for limited users; older agents run the user unthrottled
  and the node shows a warning); `device_seats` is stored for seat binding
  (with the client, R25) and **not enforced**. A disabled plan is no longer
  offered for new assignments; existing subscribers keep it. Prices, stock
  and sale rules are in docs/PAYMENTS.md.
- **Plan terms are snapshotted (中-5)**: a subscription keeps the quota,
  reset period, speed limit and node groups of the plan as it was when the
  subscription was created (`user_plans` + `user_plan_groups`, copied by
  triggers on every creation path); renewals keep them too. Editing a plan
  changes what new purchases get. To change the plan's current subscribers
  as well, save with **同时应用到现有用户** (`apply_to_existing: true`): they
  take all of the plan's current terms (audited with the count); the console
  first shows `POST /plans/{id}/impact` (subscribers, and how many are
  already over the new quota and would be paused).
- **User plans (D12)**: one active plan per user (admins cannot have one).
  Users are managed only through plans: an assignment is a plan + term
  (`month` … `three_year`, `days` + N, `onetime` with or without N days),
  the expiry is computed in SQL and the usage starts at zero; renewals add
  one term or N days (periodic subscriptions only) from max(expiry, now).
  `traffic_limit_bytes` and `expires_at` are always the plan's (no API
  writes them directly). Cancel or expiry ends the plan and removes plan
  access; the enforced limit/expiry stay as a record.
- **Ban (W28-c)**: `disabled_reason = admin` with a reason the user sees.
  The user is dropped from every node in the same transaction (the usual
  bump/revocation path), all sessions end; a banned user may sign in again
  but reaches only `GET /me` (with the reason) and tickets — subscription,
  nodes, shop and orders refuse it (403 `account.banned`). Traffic resets
  and plan changes never lift a ban.
- **Entitlement**: the user's entrances = the members of the groups of
  their active subscription (its snapshot; W28-a/D3: the only source of access; there is no manual
  assignment). Every change to groups, memberships, plans, user plans,
  entrances or a node's inbound reconciles `entrance_users` in the same
  transaction: one credential per granted entrance whose node's inbound is
  a managed protocol is issued, credentials are kept while the protocol
  stays (clients keep working across plan changes), access no longer
  granted is revoked (final counters are still billed for the departed
  grace), and exactly the affected nodes are bumped.
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
plain for a local relay; the password is stored encrypted with a key
derived from data/master.key and never shown again) and send a test mail; then
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
their address in the portal (current password + emailed code); the
verified new address is their login name from then on. Details: docs/DEPLOY.md §2c.

## Accounts

Only `role=user` accounts are proxy users. Admin accounts are never pushed
to nodes, cannot be assigned to one (400), get the rejection 404 on
subscription URLs and are exempt from traffic-limit disabling and expiry.
Changing a user to admin removes their node access; changing back restores
it. Raising a traffic limit does not re-enable a user the limit disabled.

## Security: master key, audit log, secret rotation

**Master key.** `data/master.key` (32 random bytes, hex, 0600, created on
first start; `data/totp.key` before v0.4 — an install that has only the old
file gets it renamed once, and two different copies refuse to start) is the
root of every key the panel derives (HMAC-SHA-256 with fixed labels): the
AES-256-GCM keys of the subscription links, the SMTP password, the payment
method and alert channel secrets, and the MAC keys of mail codes and
registration proofs of work. **Back it up with the rest of `data/`**:
without it those sealed secrets cannot be opened (paste them again; users
reset their links).

**Audit log.** Every administrative change (API and CLI — CLI actions are
recorded as actor `cli`), secret rotation and login is recorded
with time (transaction start), actor, client address, action, target and
redacted before/after snapshots — in the same transaction as the change.
The actor is stored as a non-personal label (`u-` + the first 8 hex digits
of the account id; the console shows the account's current address next
to it). Passwords, hashes, tokens, proxy credentials
and inbound keys are never recorded (only that they changed; the inbound as a
protocol/port/transport summary plus a digest). Failed logins are recorded only
for existing accounts (first failure per rate-limit window and the one that
fills it; actor `anonymous`); successful logins of regular users
at most once per 10 minutes per account. Admins: Audit view, or `GET
/api/v1/audit`. Retention: 系统设置 → 安全 → 审计日志保留天数 (default 365,
0 = forever), pruned hourly.

**Secret rotation.**
- `akari secrets rotate-jwt`: new `data/jwt.key`; every session ends at once
  (all instances); restart every instance to sign with the new key.
- `akari secrets rotate-prefix`: new route prefix in `data/state.json`,
  effective when the panel (every instance) restarts; the old prefix then
  becomes the plain rejection. **Every subscription URL contains the prefix
  and changes with it**: the portal shows the new link at once (the token
  itself is unchanged) and users must re-import it; tell them the new
  console address.
- Subscription links (W20): the token is stored hashed (lookup) **and**
  AES-256-GCM-encrypted (AAD = user id, key derived from `data/master.key`),
  so the portal shows the link permanently and admins can copy it (each
  read audited). Losing `data/master.key` keeps the links working but no
  longer viewable (users reset them). Accounts from before W20 keep their
  working link; the portal offers a reset to make it viewable — it is never
  rotated implicitly. Users reset their own link in the portal
  (`POST /api/v1/me/sub-token`, 5 per hour, confirmed); admins can do it per
  user. A reset also replaces the user's credential on every entrance
  (运营审查高-3): clients that imported the old link or its nodes are
  disconnected and refused, so a leaked or shared subscription is stopped.

Run the CLI as the panel's service user, against the same `data/`
directory (and database) the panel uses.

## Upgrading

**M3 (plans) upgrade:** migration 0020 adds node groups, plans and user
plans. Existing node assignments become manual overrides and keep working
unchanged; existing disabled users get `disabled_reason = admin` (so no
reset will ever re-enable them).

Installations made by `scripts/install.sh`: `akari-ctl upgrade` (backup, signature check,
switch, health check, automatic rollback; docs/DEPLOY.md §5).

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
