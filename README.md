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
  writes an agent bootstrap file.
- Agent dials out (TLS 1.3, client cert = node identity), sends `Hello` with
  its held config/user versions; node flips to `online`, versions recorded.
- Panel pushes a `ConfigSnapshot` (xray inbounds + full user set); the agent
  starts an embedded xray-core and applies users via dynamic `AddUser` — no
  restart, no reload. Disabling a user via the API propagates to connected
  agents within a second.
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

Not yet: web API/SPA, subscription endpoints, payments, agent auto-update.

## Layout

```
proto/agent.proto      the control-plane contract (single source of truth)
panel/   (Rust)        src/grpc.rs  agent sessions, snapshot convergence
                       src/traffic.rs  delta accounting + limit enforcement
                       src/install.rs  CA, server/agent cert issuance
                       src/auth.rs  argon2id passwords, JWT sessions, extractor
                       src/api.rs  REST handlers (users, nodes, accounts)
                       src/spa.rs  embedded frontend serving (rust-embed)
                       src/web.rs + reject.rs  prefix gate + uniform rejection
                       spa/  React 19 + Vite 8 + Tailwind 4 frontend
agent/   (Go)          agent.go  stream lifecycle, reconnect backoff
                       core.go   xray-core embedding, user store access
                       monitor.go  heartbeat + traffic loops
```

## Frontend

`panel/spa` is a single-page console (login, admin: users/nodes/accounts,
user portal) built with React 19, Vite 8 (Rolldown), Tailwind 4 and
shadcn/ui-style components; TanStack Query is the data layer. The compiled
bundle is embedded into the binary via rust-embed and served only under the
secret prefix (`/{prefix}/app`); Vite's `/assets/` URLs are rewritten to the
prefix at serve time, so nothing about the app leaks without the prefix.
Missing assets return the uniform empty 404, and the dev tree is never served.

```bash
make spa               # npm install + vite build (updates panel/spa/dist)
make panel             # rebuild the binary to embed the new bundle
```

## Running

```bash
make dev-up            # PG 18 + Valkey 9 (docker compose)
make spa               # frontend build (first run installs npm deps)
make panel             # cargo build --release
make agent             # go build
make proto             # regenerate Go bindings after editing proto/

./panel/target/release/akari serve
AKARI_ADMIN_PASSWORD=... ./panel/target/release/akari admin add root
./panel/target/release/akari node add test-node   # writes test-node-bootstrap.toml
(cd agent && ./agent -config ../test-node-bootstrap.toml)
make smoke             # full end-to-end check
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
| PATCH | /api/v1/nodes/{id} | admin | enable / rename |
| PUT | /api/v1/nodes/{id}/inbounds | admin | replace xray inbounds (bumps config_version) |
| POST | /api/v1/users/{id}/sub-token | admin | regenerate subscription token |
| GET | /sub/{token} | token | subscription (UA-based format) |
| GET | /healthz | — | panel liveness |

Defaults bind web on `127.0.0.1:8080` and gRPC on `127.0.0.1:8443`; override
via `panel.toml` (see `panel/src/config.rs`) or `DATABASE_URL`/`VALKEY_URL`.

Pinned versions: xray-core `v1.260327.0` (the Go module form of release
v26.3.27 — Xray uses calendar tags, Go needs semver), axum 0.8, tonic 0.14,
SQLx 0.9, fred 10 (Valkey client), Go 1.27.

## Design notes

- **Identity**: the agent's TLS client certificate serial is the node's
  identity; the protocol itself carries no credentials. Agent keys are
  panel-issued in v1 (CSR enrollment is the planned upgrade).
- **Convergence**: the panel is the source of truth. Every node state has a
  monotonically increasing `config_version`/`user_version`; any mismatch on
  Hello, Ack, or a change notification triggers a full snapshot, so agents
  converge from any state (including panel rollbacks) without a diff
  protocol.
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
