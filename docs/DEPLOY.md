# Deploying Akari on a fresh VPS (target: 30 minutes)

Two supported layouts: **A. Docker Compose** (panel + PostgreSQL 18 + Valkey 9 + Caddy)
and **B. bare metal** (systemd + your own PostgreSQL/Valkey + Caddy or nginx).
Nodes (agents) are always a single static binary under systemd.

Requirements: a Linux VPS for the panel (1 vCPU / 1 GB is enough to start), a DNS
name pointing at it (`panel.example.com` below), ports 80/443 (TLS proxy) and
8443 (agent gRPC) reachable.

## 0. Network model (read once)

| Port | Who connects | Exposure |
|---|---|---|
| 443 (80 for ACME) | admins, subscription clients | public, via the TLS reverse proxy; **only the secret prefix path is forwarded** |
| 8443 gRPC | agents (mTLS, client certificate = node identity) | public or allow-listed to your node IPs; **never behind an HTTP proxy that terminates TLS** |
| 8080 panel web | the reverse proxy only | loopback / private network, never published |
| 5432, 6379 | the panel only | never published |
| 9100 metrics | Prometheus | loopback / private, off by default |

Firewall (nftables example, bare metal; adapt for ufw):

```
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
    tcp dport 22 accept                       # ssh (restrict to your IP if you can)
    tcp dport { 80, 443 } accept              # reverse proxy
    tcp dport 8443 accept                     # agents; or: ip saddr { <node IPs> } tcp dport 8443 accept
  }
}
```

With Docker, published ports bypass ufw/nftables input rules (Docker writes its own
rules): publish only what the table above lists. The Compose file does.

## 1. Choose the config values

```
host agents dial   = panel.example.com        (or an IP)
web.advertised_names = ["panel.example.com"]  (must cover the host of grpc.advertise AND grpc.server_name)
grpc.advertise     = "panel.example.com:8443" (explicit IP:port or hostname:port)
grpc.server_name   = "panel.example.com"
web.trusted_proxies = the proxy's address as the panel sees it
```

`akari config check` validates everything and prints the effective config with
secrets redacted; `akari serve` runs the same validation and refuses to start on errors.

## A. Docker Compose

```bash
git clone https://github.com/akari-projectX/akari-panel && cd akari-panel/deploy
cp .env.example .env                                   # AKARI_VERSION, AKARI_DOMAIN
for f in env/*.example; do cp "$f" "${f%.example}"; done
chmod 600 env/*.env                                    # set the 3 passwords (db, valkey; same value in panel.env)
cp panel.toml.compose.example panel.toml               # replace panel.example.com
docker compose run --rm panel config check             # must say "configuration OK"
docker compose up -d postgres valkey panel
docker compose exec panel /akari info                  # prints the route prefix
```

Put the prefix (without the slash) into `.env` as `AKARI_PREFIX`, then `docker compose up -d`
(starts Caddy, which obtains the certificate and forwards only `/<prefix>/*`).

Notes: the image is distroless (no shell; `exec panel /akari ...` works because it runs the
binary directly), runs as UID 65532, state lives in the `akari-data` volume (`/data`).
There is no container HEALTHCHECK; probe `https://panel.example.com/<prefix>/healthz`
from your monitoring. The compose `frontend` subnet is fixed (172.28.0.0/24) so that
`web.trusted_proxies` can name it.

## B. Bare metal

```bash
# binary (verify it first, see "Verify a release")
install -m 0755 akari-linux-amd64 /usr/local/bin/akari
# PostgreSQL >= 18 and Valkey >= 9 (or Redis-compatible): create db/user, set a Valkey password
# service account, config, unit
install -m 0644 deploy/systemd/akari.sysusers /usr/lib/sysusers.d/akari.conf && systemd-sysusers
install -d -m 0750 -o root -g akari /etc/akari
install -m 0640 -o root -g akari deploy/panel.toml.example /etc/akari/panel.toml   # edit
sudo -u akari akari -c /etc/akari/panel.toml config check
install -m 0644 deploy/systemd/akari-panel.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now akari-panel
sudo -u akari akari -c /etc/akari/panel.toml info      # route prefix
```

Then the proxy: **Caddy** (`deploy/caddy/Caddyfile`, set `AKARI_DOMAIN`/`AKARI_PREFIX` in its
environment, upstream `127.0.0.1:8080`) or **nginx** (`deploy/nginx/akari.conf`, replace
`SECRETPREFIX`, domain, certificate paths). Both return an empty 404 for everything outside the
prefix, append to `X-Forwarded-For`, and keep the URI (prefix, subscription tokens) out of access
logs. `trusted_proxies = ["127.0.0.1/32"]` matches a same-host proxy.

## 2. First admin

```bash
# compose:  docker compose exec -e AKARI_ADMIN_PASSWORD='...' panel /akari admin add root
# bare metal: sudo -u akari env AKARI_ADMIN_PASSWORD='...' akari -c /etc/akari/panel.toml admin add root
```

Omit the variable to be prompted. Open `https://panel.example.com/<prefix>/app` and log in.
Admins must use two-factor authentication: the first login only opens the authenticator setup
(TOTP); store the 10 recovery codes it shows. Do this right after creating the account — until
enrolled, the password alone is enough to enroll. Lost authenticator and recovery codes:
`akari admin reset-2fa <login>`.

## 3. Add a node and install the agent

```bash
# on the panel host (compose: docker compose exec panel /akari node add ... then docker cp the file out)
sudo -u akari akari -c /etc/akari/panel.toml node add tokyo-1 --out /tmp/tokyo-1-bootstrap.toml
```

The bootstrap file contains the node's **private key** (v1): copy it over SSH, delete the copy.
On the node:

```bash
install -m 0755 akari-agent-linux-amd64 /usr/local/bin/akari-agent   # arm64: akari-agent-linux-arm64
akari-agent -version
install -d -m 0700 /etc/akari-agent
install -m 0600 tokyo-1-bootstrap.toml /etc/akari-agent/bootstrap.toml && shred -u tokyo-1-bootstrap.toml
install -m 0644 akari-agent.service /etc/systemd/system/             # deploy/systemd/ in the panel repo
systemctl daemon-reload && systemctl enable --now akari-agent
journalctl -u akari-agent -f                                         # "channel established"
```

The unit grants only `CAP_NET_BIND_SERVICE` (inbounds on 443) and reads the bootstrap file as a
systemd credential (systemd >= 250). In the UI, set the node's `server_addr` and inbounds, create
users, assign them. The node shows `online` within seconds.

## 4. Observability (optional)

Set `[metrics] bind = "127.0.0.1:9100"` and scrape it (`deploy/prometheus/`). Alert rules:
`deploy/prometheus/alerts.yml`; dashboard: `deploy/grafana/akari-dashboard.json` (import in
Grafana, pick the Prometheus data source). Metric labels never contain the route prefix.
Every response of an accepted request carries `X-Request-Id` (an incoming one is reused if it is
short and printable); it is on the log lines of that request. Rejections never carry it.

## 5. Upgrade (agents BEFORE the panel)

1. Read the release notes for protocol changes. Take a backup (docs/BACKUP.md).
2. Upgrade every agent (replace the binary, `systemctl restart akari-agent`; the xray rebuild drops live connections once).
3. Upgrade the panel: compose `AKARI_VERSION=x.y.z` in `.env`, `docker compose pull && docker compose up -d panel`; bare metal replace the binary, `systemctl restart akari-panel`. Migrations run automatically at start.
4. `akari config check`, `/healthz`, check the nodes are `online`.

Why this order: a new panel drops traffic reports without `session_id` and serves the empty state
to agents below `MIN_AGENT_PROTOCOL`.

## 6. Rollback

Agents are backward-tolerant, so roll back the **panel** first: previous image tag / binary, restart.
Migrations are forward-only: if the new version ran a migration, restore the pre-upgrade backup
(docs/BACKUP.md) together with the old binary. A restored database with the old `data/` keeps the
same route prefix and agent certificates.

## Verify a release

Releases are signed keylessly (GitHub OIDC, Sigstore). Needs `cosign` >= 2.
```bash
cosign verify-blob --bundle akari-linux-amd64.sigstore.json \
  --certificate-identity-regexp '^https://github.com/akari-projectX/akari-panel/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com akari-linux-amd64
sha256sum -c --ignore-missing SHA256SUMS
cosign verify ghcr.io/akari-projectx/akari-panel:X.Y.Z \
  --certificate-identity-regexp '^https://github.com/akari-projectX/akari-panel/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
(agent: replace `akari-panel` by `akari-agent` in the identity and use its binaries.) The SBOM
(CycloneDX) is a release asset and an attestation on the image.

## Build notes

The binary is a static musl build (`rust:alpine`; ring/rustls/sqlx need no system library):
it runs on any Linux kernel, in distroless/scratch, and needs no glibc on the VPS. Trade-off: musl's
allocator is slower under heavy multi-thread contention; revisit with mimalloc in M2 if profiling
says so. `akari --version` prints version and git sha.
