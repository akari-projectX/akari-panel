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
  by a DB trigger, race-free). **Admins must use TOTP two-factor
  authentication**; every administrative change is in the audit log (see
  "Security" below).
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
src/spa.rs             embedded frontend serving (rust-embed)
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

`spa/` is a single-page console (login, admin: users/nodes/accounts,
user portal) built with React 19, Vite 8 (Rolldown), Tailwind 4 and
shadcn/ui-style components; TanStack Query is the data layer. The compiled
bundle is embedded into the binary via rust-embed and served only under the
secret prefix (`/{prefix}/app`); Vite's `/assets/` URLs are rewritten to the
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
| GET | /api/v1/me | user | profile + traffic usage |
| GET | /api/v1/me/totp | any session | session stage, 2FA state (never the secret) |
| POST | /api/v1/me/totp/enroll | any session | new pending TOTP secret (shown once) |
| POST | /api/v1/me/totp/confirm | any session | `{code, enrollment_code?}`: activate 2FA (admins: plus their one-time enrollment code), returns 10 recovery codes once |
| POST | /api/v1/me/totp/recovery-codes | user | `{code}`: replace recovery codes |
| POST | /api/v1/me/sub-token | user (role=user) | regenerate own subscription token (5/hour) |
| GET | /api/v1/me/plan | user | own active plan (or null), usage, enforced limit/expiry, node names + regions |
| POST | /api/v1/me/password | user/admin | `{current_password, new_password}`: change own password (wrong current = 400, counts against the login rate limit; other sessions end, this one continues) |
| GET | /api/v1/audit | admin | audit log, `?limit&before&actor&action` (keyset, newest first) |
| GET/POST | /api/v1/users | admin | list / create users |
| PATCH/DELETE | /api/v1/users/{id} | admin | update / delete user |
| POST/DELETE | /api/v1/users/{id}/nodes/{node_id} | admin | manual override: assign (generates account, pins the pair) / remove (hands a plan-granted pair back to the plan; 409 on plan-managed rows) |
| GET/PUT/PATCH/DELETE | /api/v1/users/{id}/plan | admin | active plan + history / assign or change `{plan_id, expires_at?, period_anchor?, reset_traffic?}` / `{expires_at?, period_anchor?}` / cancel |
| GET/POST | /api/v1/node-groups | admin | list / create `{name, description?, node_ids?}` |
| PATCH/DELETE | /api/v1/node-groups/{id} | admin | rename, describe, replace `node_ids` / delete |
| GET/POST | /api/v1/plans | admin | list / create `{name, period, traffic_quota_bytes?, speed_limit_mbps?, device_seats?, sort?, enabled?, group_ids?}` |
| PATCH/DELETE | /api/v1/plans/{id} | admin | update (same fields; null clears nullable ones) / delete (409 while users hold it) |
| GET/POST | /api/v1/nodes | admin | node list with live status, certificate expiry, last heartbeat, warnings / create a node `{name, region?, server_addr?, templates? \| inbounds?, install?: {origin?}}` (201: one-time enrollment token + bootstrap file + one-line install command, shown once) |
| POST | /api/v1/nodes/{id}/install | admin | new one-line install command `{origin?}` (re-install; replaces the node's unused token) |
| GET | /api/v1/inbound-templates | admin | template choices (REALITY dests, fingerprints) |
| POST | /api/v1/inbound-templates/render | admin | templates → xray inbounds JSON (fresh REALITY keys; nothing stored) |
| POST | /api/v1/inbound-templates/check-dest | admin | TLS 1.3 + h2 check of a REALITY dest from the panel |
| POST | /api/v1/nodes/{id}/enroll-token | admin | new one-time enrollment token + bootstrap file (re-enrollment) |
| PATCH/DELETE | /api/v1/nodes/{id} | admin | enable / rename / billing cap override; delete (202, revokes the certificate) |
| PUT | /api/v1/nodes/{id}/inbounds | admin | replace xray inbounds (bumps config_version) |
| POST | /api/v1/users/{id}/sub-token | admin | regenerate subscription token |
| POST | /api/v1/users/{id}/revoke-sessions | admin | log the account out everywhere (204) |
| DELETE | /api/v1/users/{id}/totp | admin | reset the account's 2FA, end its sessions; returns an admin's new one-time `totp_enrollment_code` |
| GET | /sub/{token} | token | subscription (UA-based format) |
| GET | /install/{token}[/agent/{arch}] | install link | node install script / agent binary while the link is live (docs/DEPLOY.md §3) |
| GET | /healthz | — | panel liveness |

Defaults bind web on `127.0.0.1:8080` and gRPC on `127.0.0.1:8443`; override
via `panel.toml` (see `src/config.rs`) or `DATABASE_URL`/`VALKEY_URL`.
`akari admin passwd <login>` resets a password (and ends its sessions).
`akari admin reset-2fa <login>` removes an account's 2FA (lockout recovery)
and prints an admin's new enrollment code. `akari node enroll-token <id>`
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

### Security advisory GO-2026-6443 (xray gRPC transport)

The agent's `google.golang.org/grpc` (< v1.85.0) panics on a request
without `:authority`, and xray runs a grpc server for any inbound with
`streamSettings.network = "grpc"` (alias `"gun"`), so any unauthenticated
client could crash the agent. Until the agent ships the fixed grpc, `PUT
/nodes/{id}/inbounds` refuses such inbounds (400, any case, Go-json key
folding). Inbounds stored before this check are left as they are: the node
list shows them under `warnings`; replace them with another transport.

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
  is a hint shown to users and **not enforced**; `device_seats` is stored
  for seat binding (M5) and **not enforced**. A disabled plan is no longer
  offered for new assignments; existing subscribers keep it.
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

## Accounts

Only `role=user` accounts are proxy users. Admin accounts are never pushed
to nodes, cannot be assigned to one (400), get the rejection 404 on
subscription URLs and are exempt from traffic-limit disabling and expiry.
Changing a user to admin removes their node access; changing back restores
it. Raising a traffic limit does not re-enable a user the limit disabled.

## Security: two-factor, audit log, secret rotation

**Two-factor (TOTP, RFC 6238: SHA-1, 6 digits, 30 s, ±1 step).** Mandatory
for admins: an admin without active TOTP who logs in with the right
password gets a 15-minute *enrollment-only* session that reaches nothing
but `/api/v1/me/totp*` (the SPA shows the setup screen). Enrollment shows
the secret once (base32 + `otpauth://` URI) and activates only after a
valid code — for an admin also the one-time **enrollment code** that
`akari admin add` / `admin reset-2fa` print (or the API returns once on
admin create / 2FA reset; 128-bit, SHA-256 stored, 24 h, consumed by the
activation), so a leaked password alone cannot bind an attacker's
authenticator; activation issues 10 single-use recovery codes (shown once) and
ends the account's other sessions. Regular users may opt in from the
portal. Login sends password and code in **one** request (`code` = TOTP
code or recovery code); every failure — unknown account, wrong password,
missing/wrong/replayed code — is the same 401 after the same work, and
counts toward the login rate limit. A code (and any older one) is accepted
once per account across all instances (DB-recorded time step); the DB clock
is used. Secrets are stored AES-256-GCM-encrypted with a key derived from
`data/totp.key` (0600, created on first start — **back it up with the rest
of `data/`**: without it every enrolled account needs a reset); recovery
codes as keyed HMAC-SHA-256. Lost authenticator: `akari admin reset-2fa
<login>` (or another admin: Users → Reset 2FA); the account's sessions end
and an admin re-enrolls at the next login.

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
