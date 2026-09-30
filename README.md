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
  unknown users, per-IP rate limit 20/15min via Valkey) and issues an HS256
  JWT in an `HttpOnly` `SameSite=Strict` cookie (12h; Secure everywhere
  except loopback binds).
- Admin API: user CRUD, node listing/enable, per-node xray `inbounds`
  editing, account generation + assignment (VLESS/VMess/Trojan credentials
  are panel-generated, one per inbound).
- `akari node add <name>` issues a per-node client certificate (panel CA) and
  writes an agent bootstrap file. `akari node delete <id>` (or
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
  buckets so size does not reveal node counts.

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
./target/release/akari node add test-node   # writes test-node-bootstrap.toml
(cd ../akari-agent && ./agent -config ../akari-panel/test-node-bootstrap.toml)
make smoke             # full end-to-end check (truncates the dev DB)
make check             # fmt + clippy + tsc (fast gate); make lint test deny = CI
```

### API surface (all under the secret prefix)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /auth/login | — | argon2id login, sets session cookie |
| POST | /auth/logout | — | clears session cookie |
| GET | /api/v1/me | user | profile + traffic usage |
| GET/POST | /api/v1/users | admin | list / create users |
| PATCH/DELETE | /api/v1/users/{id} | admin | update / delete user |
| POST/DELETE | /api/v1/users/{id}/nodes/{node_id} | admin | assign (generates account) / remove |
| GET | /api/v1/nodes | admin | node list with live status |
| PATCH/DELETE | /api/v1/nodes/{id} | admin | enable / rename / billing cap override; delete (202, revokes the certificate) |
| PUT | /api/v1/nodes/{id}/inbounds | admin | replace xray inbounds (bumps config_version) |
| POST | /api/v1/users/{id}/sub-token | admin | regenerate subscription token |
| GET | /sub/{token} | token | subscription (UA-based format) |
| GET | /healthz | — | panel liveness |

Defaults bind web on `127.0.0.1:8080` and gRPC on `127.0.0.1:8443`; override
via `panel.toml` (see `src/config.rs`) or `DATABASE_URL`/`VALKEY_URL`.

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
  billed and can never be registered again. Reinstalling needs a new
  `akari node add`.
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
  an outage still bills in full. An unassigned user's pair only bills
  traffic plausibly carried before the unassignment (+30 s), cumulatively
  across flushes.

## Accounts

Only `role=user` accounts are proxy users. Admin accounts are never pushed
to nodes, cannot be assigned to one (400), get the rejection 404 on
subscription URLs and are exempt from traffic-limit disabling and expiry.
Changing a user to admin removes their node access; changing back restores
it. Raising a traffic limit does not re-enable a user the limit disabled.

## Upgrading

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
