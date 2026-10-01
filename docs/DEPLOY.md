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
| 8443 gRPC | agents (mTLS, client certificate = node identity; enrollment = server TLS + one-time token) | public or allow-listed to your node IPs; **never behind an HTTP proxy that terminates TLS** |
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

The compose file sets `AKARI_CONFIG=/etc/akari/panel.toml` on the panel service, so every
`/akari ...` you run through `docker compose run` or `exec` reads your `panel.toml` (these
commands replace the service's `command:`, which is why the path is an environment variable and
not a `-c` flag). `config check` prints the effective values: confirm they are yours (your
`grpc.advertise`, not `127.0.0.1`). The image itself sets no default `AKARI_CONFIG`: a bare
`docker run` of it uses built-in defaults. Outside compose use `-c <file>` or export `AKARI_CONFIG`.

Put the prefix (without the slash) into `.env` as `AKARI_PREFIX`, then `docker compose up -d`
(starts Caddy, which obtains the certificate and forwards only `/<prefix>/*`).

**IP-only deployments (no domain).** With `AKARI_DOMAIN` set to an IP address, Caddy issues the
certificate from its own internal CA, which no browser or client trusts. That is fine to try the
admin UI (accept the browser warning once), but subscription clients and browsers will refuse it:
use a real domain (an A record to the VPS, ports 80/443 open) so Caddy obtains a certificate by
ACME. The Caddyfile sets `default_sni` to `AKARI_DOMAIN` because clients send no SNI for an IP
address. The agent's gRPC channel is unaffected: it pins the panel CA, not the web certificate.

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

Omit the variable to be prompted. The command also prints a one-time **2FA enrollment code**
(valid 24 h). Open `https://panel.example.com/<prefix>/app` and log in. Admins must use two-factor
authentication: the first login only opens the authenticator setup (TOTP), which needs a current
code from the app **and** the enrollment code — a leaked password alone cannot bind an attacker's
authenticator. Store the 10 recovery codes it shows. Lost authenticator and recovery codes, or an
expired enrollment code: `akari admin reset-2fa <login>` (prints a new enrollment code; in the UI
an admin's **Reset 2FA** / **2FA code** shows it once). Admins created through the API get theirs
in the create response; a user promoted to admin gets one through **2FA code**. Admin accounts
created before this release that never enrolled need `admin reset-2fa` once.

## 3. Add a node and install the agent

```bash
# bare metal, on the panel host
sudo -u akari akari -c /etc/akari/panel.toml node add tokyo-1 --out /tmp/tokyo-1-bootstrap.toml

# compose: `--out -` writes the bootstrap to stdout (progress goes to stderr), so nothing is left
# in the distroless container (it has no `rm`). Redirect on the host; -T = no TTY, keeps it clean.
( umask 077; docker compose exec -T panel /akari node add vps-1 --out - > vps-1-bootstrap.toml )
chmod 600 vps-1-bootstrap.toml
```

`node enroll-token <id> --out -` works the same way.

Or in the UI: Nodes → **New node** (the bootstrap file is shown once, with a Download button).

The bootstrap file holds the panel address, the TLS server name, the panel CA and a **one-time
enrollment token** — no private key. The token is single use and expires after
`agent.enroll_token_ttl_secs` (default 24 h); only its SHA-256 is stored. Still treat the file as
a credential until the agent has enrolled (copy it over SSH, delete the copy). On the node:

```bash
install -m 0755 akari-agent-linux-amd64 /usr/local/bin/akari-agent   # arm64: akari-agent-linux-arm64
akari-agent -version
install -d -m 0700 /etc/akari-agent
install -m 0600 tokyo-1-bootstrap.toml /etc/akari-agent/bootstrap.toml && shred -u tokyo-1-bootstrap.toml
install -m 0644 akari-agent.service /etc/systemd/system/             # deploy/systemd/ in the panel repo
systemctl daemon-reload && systemctl enable --now akari-agent
journalctl -u akari-agent -f                                         # "enrolled", then "channel established"
```

On its first start the agent generates its key (ECDSA P-256) in its state directory
(`StateDirectory=akari-agent`, i.e. `/var/lib/private/akari-agent`, mode 0700, files 0600; without
systemd: `-state-dir`, default the config file's directory), sends a CSR with the token to the
panel's gRPC port (the one call that works without a client certificate) and stores the issued
certificate next to the key. The private key never leaves the node. The panel decides the whole
certificate (CN `agent-<node id>`, client-auth only, `agent.cert_validity_secs`, default 90 days).

The unit grants only `CAP_NET_BIND_SERVICE` (inbounds on 443) and reads the bootstrap file as a
systemd credential (systemd >= 250). In the UI, set the node's `server_addr` and inbounds, create
users, assign them. The node shows `online` within seconds.

**Token expired / agent state lost / certificate expired** (agent offline longer than its
validity): `akari node enroll-token <node id>` (UI: **Enrollment token**) writes a new bootstrap
file; install it and restart the agent. The agent re-enrolls once when the bootstrap file carries a
token it has not used yet; after that the node's older certificates are refused. A used, unknown
or expired token is refused with one uniform error ("enrollment refused"), and the agent exits.

Enrollment is rate limited per source address and globally (`agent.enroll_rate_per_ip`,
`agent.enroll_rate_global`, `agent.enroll_rate_window_secs`; defaults 10 / 60 per 10 min).

### Certificate renewal

Agents of protocol 2 renew automatically once less than a third of the validity is left
(day 60 of 90): a new key and CSR go over the existing mTLS connection, the agent reconnects with
the new certificate, and the panel revokes the old one the first time it sees the new one. Until
then the old certificate keeps working, so a crash or network failure in between costs nothing
(the agent simply renews again). Nodes whose certificate is within 14 days of expiry carry a
warning in the node list (protocol 1 agents never renew: upgrade them, or re-enroll before the
certificate expires — an expired certificate is refused at the TLS handshake).

Back up the agent's state directory if you want to restore a node without re-enrolling it.

### Nodes added before M1c (bootstrap files with a private key)

Nothing to do for them to keep working: the agent still accepts `identity.cert_pem` /
`identity.key_pem` in the bootstrap file (v1), and the panel keeps their certificates (2-year
validity). Upgrade the agent (section 5) and give it a state directory (the new unit file); at its
first renewal it moves onto a key generated on the node and the panel revokes the old,
panel-generated one. Then delete `cert_pem`/`key_pem` from `/etc/akari-agent/bootstrap.toml`. To
migrate at once instead of at renewal time, issue a new enrollment token for the node and install
that bootstrap file.

## 3b. REALITY inbounds

A REALITY inbound borrows the TLS handshake of a real site (`dest`) and lets clients that know
your public key through. Three things go wrong in practice.

**Pick a `dest` the current xray-core accepts.** Not every site works with every xray release. On
2026-10-01 with xray 26.3.27, `www.microsoft.com:443` failed (the agent log showed `REALITY:
processed invalid connection ... handshake did not complete`) while `www.apple.com`,
`dl.google.com`, `www.cloudflare.com` and `addons.mozilla.org` worked. Re-check after xray
upgrades. Needs TLS 1.3 and H2 on the target; test it from the node before you rely on it, with
a standalone xray (any machine with the same xray version, reality client in one file):

```bash
# on the node: key pair for the server side (private key stays in the inbound, public goes to clients)
xray x25519                      # prints PrivateKey and Password (= the public key)
# quick dest check: run `xray run -c server.json` with only the REALITY inbound
# (realitySettings.dest = the candidate), then from another host
#   curl -sv --resolve <dest-host>:<port>:<node-ip> https://<dest-host>:<port>/ -o /dev/null
# must complete the handshake and return the real site's page; a dest xray
# cannot use logs "REALITY: processed invalid connection" on the server.
openssl s_client -connect www.apple.com:443 -tls1_3 -alpn h2 </dev/null 2>/dev/null | grep -E 'Protocol|ALPN'
```

**The panel's inbound must carry `publicKey`.** xray's server side only needs `privateKey`; the
panel builds subscriptions from the same JSON, so it reads the client-side fields from
`realitySettings` too: `publicKey` (required, subscriptions are broken without it), `shortId`
(one id handed to clients; must be one of `shortIds`) and optionally `fingerprint`. The panel-only
fields are not used by xray. Subscriptions always carry a uTLS fingerprint for REALITY (`fp=` in
links, `client-fingerprint` in Clash, `tls.utls` in sing-box): `fingerprint` if you set one of
`chrome`, `firefox`, `safari`, `ios`, `android`, `edge`, `360`, `qq`, `random`, `randomized`,
otherwise (or for any other value) `chrome`.

```json
{
  "tag": "in-reality",
  "listen": "0.0.0.0",
  "port": 443,
  "protocol": "vless",
  "settings": { "clients": [], "decryption": "none" },
  "streamSettings": {
    "network": "tcp",
    "security": "reality",
    "realitySettings": {
      "dest": "www.apple.com:443",
      "serverNames": ["www.apple.com"],
      "privateKey": "<xray x25519 PrivateKey>",
      "shortIds": ["6ba85179e30d4fc2"],
      "publicKey": "<xray x25519 Password / public key>",
      "shortId": "6ba85179e30d4fc2",
      "fingerprint": "chrome"
    }
  }
}
```

`serverNames[0]` is the SNI clients send. Assign users to the inbound with protocol `vless` and
flow `xtls-rprx-vision`.

## 3c. Resource footprint (measured)

One real deployment on a 1 vCPU-class VPS with 920 MB RAM (Debian 13, compose, IP-only), resident
memory at idle: panel 5 MB, PostgreSQL 56 MB, Valkey 8 MB, Caddy 17 MB, agent 27 MB. The whole
stack plus an agent fits a 1 GB machine with room to spare. The first full deployment from this
guide took about 23 minutes including troubleshooting.

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
to agents below `MIN_AGENT_PROTOCOL`. (M1c: protocol 2 agents work with older panels — renewal
then fails with "unimplemented" and is retried hourly; certificates from before M1c are valid for
2 years.) The agent unit file gained `StateDirectory=` in M1c: install the new one with the agent.

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
