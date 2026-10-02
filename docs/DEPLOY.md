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

## 1b. Domains (系统设置) and Cloudflare

The admin console's **系统设置** page (`/<prefix>/admin/settings`) holds three domains and one switch.
Once the main domain is saved, the console (`/<prefix>/admin`) answers on the main domain only
(and on IP literals); on the subscription domain it is the uniform empty 404 (R23). They live in the
database (table `panel_settings`): a value saved there wins over panel.toml; an empty field means
"use panel.toml". `akari config check` prints both sides; `akari settings show` the database side;
`akari settings unset main|sub|node|trust-cloudflare|all` clears it (audited) — e.g. after a
mistyped main domain. Changes take effect on every panel instance within a second (database
notification), **no restart** — including the gRPC certificate.

| Field | Used for | Cloudflare | panel.toml default |
|---|---|---|---|
| 主域名 (main) | admin console, user portal, install links, payment notify URLs | orange or grey | `install.public_url` |
| 订阅域名 (subscription) | every subscription URL the panel hands out (portal, admin, API `sub_url`) | **orange** recommended (hides the server IP) | `web.sub_domain`, else the main domain |
| 节点通信域名 (node) | `panel_addr`/`server_name` of NEW install commands and bootstrap files | **grey only** | `grpc.advertise` / `grpc.server_name` |
| 信任 Cloudflare | real client IP behind Cloudflare (`CF-Connecting-IP`) | — | `web.trust_cloudflare` |

Values are host names (IDN is stored as punycode) or IP addresses, optionally with `:port`; no
scheme or path. The **DNS 检测** buttons resolve the name from the panel: the subscription domain
warns if it does not resolve into Cloudflare's ranges; the node domain **refuses to save** if it
does (the admin can override after an explicit confirmation): agents talk gRPC with mutual TLS
directly to port 8443, and an orange-clouded record makes Cloudflare terminate TLS (and it does not
proxy arbitrary ports), so agents cannot connect.

**Host check.** Once a main domain is saved, the panel answers only requests whose Host is the
main or subscription domain (or `install.public_url`'s host) or an IP address; any other domain
name gets the same empty 404 as every other rejection. Saving asks for confirmation when the
address you are using would stop working.

**Node domain and existing nodes.** An enrolled agent keeps the server name of its bootstrap
file forever. The panel therefore records every server name it ever wrote into a bootstrap
(`grpc_server_names`) and its gRPC certificate covers all of them plus `web.advertised_names`:
changing the node domain only affects new installs, existing nodes keep connecting. A name leaves
the certificate only through **移除** in the "节点通信证书域名" table, which lists the nodes still
using it (they must be re-installed afterwards). Nodes enrolled before this release have no
recorded name and are listed separately (they use the panel.toml `grpc.server_name`, which is
always covered).

**Reverse proxy certificates.** `deploy/caddy/Caddyfile` serves `AKARI_DOMAIN` as before and any
other name **on demand**: at the first handshake for a new name Caddy asks the panel's
`ask` endpoint (`[tls_ask] bind`, its own listener: compose `0.0.0.0:8082` on the private network
with `allow_non_loopback = true`, bare metal `127.0.0.1:8082`; `AKARI_ASK` in Caddy's
environment). The panel answers 200 only for the configured main and subscription domains
(rate-limited, `tls_ask.rate_per_sec`), so no Caddyfile edit is needed when domains change and
nobody can make Caddy issue certificates for arbitrary names. Only the secret prefix is forwarded
on every domain, and every site block strips `Server`/`Via`, so Caddy's own 404 and the panel's
rejection behind the prefix are byte-identical (smoke compares them on the main domain, an
on-demand domain and the bare IP). Plain `http://` is redirected to https only for
`AKARI_DOMAIN`; every other host (the bare IP, unknown names, and the 系统设置 domains, whose
links are always https) gets the same empty 404 on port 80. ACME HTTP-01 challenges are still
answered there (Caddy handles them before any site route). With nginx, add each domain's `server_name` and certificate yourself.

### Cloudflare

1. DNS: main domain orange or grey, subscription domain **orange** (proxied), node domain
   **grey** (DNS only) pointing at the panel's IP. Keep 8443 reachable directly (firewall it to
   your node IPs if you like).
2. SSL/TLS mode **Full (strict)**: Cloudflare then verifies the origin certificate Caddy obtained.
   "Flexible" would make Cloudflare talk plain HTTP to port 80 (Caddy answers 404, or a redirect
   loop for `AKARI_DOMAIN`); "Full" without strict accepts any origin certificate.
3. First certificate for an orange-clouded name: Caddy uses the HTTP-01 challenge on port 80,
   which works through Cloudflare. If "Always Use HTTPS" is on and issuance fails, switch the
   record to grey until Caddy has the certificate (seconds after the first visit to
   `https://<domain>/<prefix>/healthz`), then back to orange; renewals work proxied.
4. In 系统设置 turn on **信任 Cloudflare**. The panel then treats Cloudflare's edge ranges as
   trusted proxies: a request whose chain is client → Cloudflare → [Caddy →] panel is attributed to
   `CF-Connecting-IP` (login/subscription rate limits, audit). The header is read only when the
   nearest genuine hop is a Cloudflare edge reached through trusted proxies (`web.trusted_proxies`
   = Caddy); someone connecting to the origin directly and forging the header is attributed to
   their own address. Without the switch, all requests through Cloudflare count as the edge's
   address (coarser rate limits, nothing breaks).
5. WebSocket works through the orange cloud (subscription and admin traffic do not need it; a
   node's own WS inbound behind Cloudflare is a separate, per-node choice). gRPC through
   Cloudflare needs its "gRPC" network setting and is **never** suitable for the agent channel.

**Updating the Cloudflare ranges.** The list ships in the binary (`src/cloudflare_ips.txt`, from
https://www.cloudflare.com/ips-v4 and /ips-v6). If Cloudflare announces new ranges before a panel
release picks them up, set them in panel.toml without rebuilding:

```bash
curl -s https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6   # review the list
# panel.toml, [web]:
#   cloudflare_ranges = ["173.245.48.0/20", ..., "2c0f:f248::/32"]
akari config check && systemctl restart akari-panel      # compose: docker compose up -d panel
```

A stale list fails safe: traffic from an unknown edge range is simply attributed to the edge.
Release maintainers refresh `src/cloudflare_ips.txt` from the same URLs (the unit test
`cloudflare::tests` checks it parses).

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
(starts Caddy, which obtains the certificate and forwards only `/<prefix>/*`; domains added later
in 系统设置 get theirs on demand, §1b).

**IP-only deployments (no domain).** With `AKARI_DOMAIN` set to an IP address, Caddy issues the
certificate from its own internal CA, which no browser or client trusts. That is fine to try the
admin UI (accept the browser warning once), but subscription clients and browsers will refuse it:
use a real domain (an A record to the VPS, ports 80/443 open) so Caddy obtains a certificate by
ACME. The Caddyfile sets `default_sni` to `AKARI_DOMAIN` because clients send no SNI for an IP
address. The agent's gRPC channel is unaffected: it pins the panel CA, not the web certificate,
and the one-line node installer pins the web certificate's key (§3).

**Moving an IP-only deployment to a domain** (verified 2026-10-02): add the A record (no
proxying CDN; ports 80/443 open), set `AKARI_DOMAIN` in `.env`, and in `panel.toml` keep the IP
**and** add the name: `web.advertised_names = ["panel.example.com", "203.0.113.10"]`. Agents
enrolled earlier keep dialing the IP with the IP as gRPC server name (their bootstrap file says
so), and the panel's gRPC certificate is regenerated at every start from `advertised_names`:
dropping the IP strands them. `grpc.advertise`/`grpc.server_name` can then move to the name (only
new bootstrap files and install links use them), and `[install] public_url =
"https://panel.example.com"` makes install commands plain `curl` (no pin). `config check`,
`docker compose up -d` (Caddy obtains the certificate within seconds; `docker compose logs caddy`
shows "certificate obtained successfully"), then restart one agent to confirm it reconnects. Any
other host name, including the bare IP, now gets the same empty 404.

The Caddyfile is bind-mounted as a single file: `git pull`/`git checkout` replace the file (new
inode) and the running container keeps the old one, so `caddy reload` changes nothing. After
updating the checkout run `docker compose up -d --force-recreate caddy`.

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

Omit the variable to be prompted. Open `https://panel.example.com/<prefix>/app` and log in with
the password; admins are taken to the console at `https://panel.example.com/<prefix>/admin`
(served only to an admin session — without one it is the same empty 404 as any unknown path, so
bookmark `/app`, not `/admin`). Two-factor authentication (TOTP) is **optional but recommended**: the console shows a
banner until you turn it on under **账户** (scan the QR code, or type the key; save or download the
10 recovery codes). Deployments that want it mandatory for admins set

```toml
[auth]
require_admin_2fa = true   # default false
```

— an admin without 2FA then only gets a 15-minute setup session at login. Lost authenticator and
recovery codes: `akari admin reset-2fa <login>` (or another admin: 用户 → 管理 → 重置两步验证); the
account then logs in with its password and can set 2FA up again.

## 3. Add a node and install the agent

**In the UI: Nodes → 新建节点.** Fill in the name, the region users see, the node's public
address (IP or domain) and one or more inbounds from the protocol templates:

| Template | Needs on the node | Notes |
|---|---|---|
| VLESS + REALITY + Vision (default) | nothing | the panel generates the X25519 key pair and a short id; `dest`/SNI from a list that works with the agent's xray (default `www.apple.com`, see §3b); **检测目标站点** runs a TLS 1.3 + h2 handshake from the panel; Vision (`xtls-rprx-vision`) on unless unticked |
| VLESS + REALITY + XHTTP | nothing | as above, XHTTP path/mode; no Vision (not raw TCP) |
| VLESS + TCP + TLS + Vision | certificate | |
| VLESS + WebSocket + TLS | certificate | WS path random unless set |
| VMess + WebSocket | certificate only with TLS | plain WS without a domain |
| VMess + TCP | nothing | plain VMess (AEAD, alterId 0) |
| Trojan + TLS | certificate | |
| 自选传输 (VLESS/VMess/Trojan × WS/HTTPUpgrade/XHTTP/gRPC) | certificate with TLS | TLS optional for VLESS/VMess over WS/HTTPUpgrade/XHTTP, required for Trojan and gRPC; path/Host/XHTTP mode/gRPC service name |
| Shadowsocks 2022 | nothing | multi-user, `2022-blake3-aes-128-gcm` (default) or `-256-gcm`; server key generated; TCP+UDP |
| Hysteria 2 | certificate | QUIC on UDP (may share the TCP port of another inbound) |

Full matrix (what each client format can carry, what is refused and why): §3d.

"Certificate" = the node's own certificate for the domain you enter, as
`/etc/akari-agent/tls/fullchain.pem` and `privkey.pem` (certbot, acme.sh, …; root-only files are
fine). The installer hands that directory to the agent as systemd credentials (the agent runs as a
dynamic user and cannot read `/etc` otherwise), read once at service start: after putting the
certificate there for the first time (before saving a TLS/Hysteria 2 inbound) and after every
renewal run `systemctl restart akari-agent`. The agent does not run ACME itself. A WS inbound behind the node's own reverse proxy
or a CDN is not a template (subscriptions would advertise the inbound's local port): write that
JSON by hand. **高级：直接编辑入站 JSON** shows/edits the generated JSON; both paths go through the
same validation (the §3d matrix, no `fakedns`).

Creating the node shows a **one-line install command**, valid for `install.token_ttl_secs`
(default 1 h) and only until the agent has enrolled with it:

```bash
curl -fsSL 'https://panel.example.com/<prefix>/install/<token>' | sudo sh
# or: wget -qO- 'https://panel.example.com/<prefix>/install/<token>' | sudo sh
```

Run it as root on the node (Linux with systemd >= 250, amd64 or arm64; Debian 12/13, Ubuntu
22.04+ are fine). Logged in as root on an image without `sudo` (many minimal Debian VPS images),
replace `| sudo sh` with `| sh`: otherwise the pipe fails with `sudo: command not found` before
anything runs (the link stays valid, just run it again). It

1. downloads the agent from the panel (the newest complete release uploaded under **Updates**,
   §5b) and checks its SHA-256 — without an uploaded release it falls back to
   `install.fallback_binary_url` (default: the latest GitHub release asset, checked against the
   release's `SHA256SUMS`); with neither it stops with a clear error before changing anything;
2. writes `/etc/akari-agent/bootstrap.toml` (0600: panel address, gRPC server name, panel CA,
   the one-time enrollment token — no private key), the systemd unit
   (`deploy/systemd/akari-agent.service`, embedded) and a drop-in for the TLS credentials;
3. starts the agent and waits until it has enrolled and connected (prints `SUCCESS`, or the
   agent's log and the reason).

Running it again is safe (reinstall/upgrade in place). The node shows `online` within seconds.
Uninstall: `sudo akari-agent-uninstall` on the node (written by the installer), or a fresh
command with `| sudo sh -s -- --uninstall`; then delete the node in the panel.

**Security of the link.** The token in the URL *is* the node's enrollment token (256 bit, only
its SHA-256 stored, single use, short TTL). The panel serves the script and the binary only while
it is live; once the agent enrolls (or the link expires, or a newer link/token is issued for the
node, or the node is being deleted) every request is the panel's uniform empty 404, as are wrong
tokens and sources over the rate limit (`install.rate_per_ip` per `install.rate_window_secs`,
default 20 / 10 min per address). Whoever runs the command first gets the node, exactly as with
a bootstrap file: copy it over a trusted channel. The script passes the token to no command
line (downloads read their URL from stdin) and the panel never logs it (`/{prefix}/install/{token}`
in logs). **重装命令** in the node list issues a new link for an existing node; when the agent
enrolls with it, the node's previous certificate is revoked.

**Where the link points.** `install.public_url` (e.g. `https://panel.example.com`, no prefix)
if set; otherwise the address the admin's browser uses for the panel. When the panel issues a
command it connects to that origin: a certificate a public CA vouches for → plain `curl`/`wget`.
Anything else (an IP-only deployment with Caddy's internal CA) → the command **pins the served
certificate's public key**:

```bash
curl -fsSL --proto '=https' -k --pinnedpubkey 'sha256//<base64>' 'https://203.0.113.10/<prefix>/install/<token>' | sudo sh
```

curl checks the pin during the handshake, before it sends the request, so a mismatch aborts
without revealing the token; `-k` only skips the CA check a self-signed panel cannot pass and is
never emitted without a pin (there is no wget variant: wget cannot pin). The script uses the
same pin for the binary download. Caddy's internal certificates are short-lived (about 12 h): if
the command fails with "public key does not match", generate a new one. Set `install.tls_pin`
to pin a fixed key instead of probing (e.g. when the panel cannot reach its own public address).

```toml
[install]
public_url = "https://panel.example.com"   # default "": the browser's origin
tls_pin = ""                                # "sha256//<base64>"; default: probe
token_ttl_secs = 3600                       # 5 min .. 7 days
rate_per_ip = 20
rate_window_secs = 600
fallback_binary_url = "https://github.com/akari-projectX/akari-agent/releases/latest/download/akari-agent-linux-{arch}"
```

**Manual path (CLI / no outbound HTTPS on the node).** The bootstrap file still works (and is
shown under the install command after a create; **bootstrap** in the node list issues a new one):

```bash
# bare metal, on the panel host
sudo -u akari akari -c /etc/akari/panel.toml node add tokyo-1 --out /tmp/tokyo-1-bootstrap.toml

# compose: `--out -` writes the bootstrap to stdout (progress goes to stderr), so nothing is left
# in the distroless container (it has no `rm`). Redirect on the host; -T = no TTY, keeps it clean.
( umask 077; docker compose exec -T panel /akari node add vps-1 --out - > vps-1-bootstrap.toml )
chmod 600 vps-1-bootstrap.toml
```

`node enroll-token <id> --out -` works the same way. The bootstrap token is single use and
expires after `agent.enroll_token_ttl_secs` (default 24 h). Treat the file as a credential until
the agent has enrolled (copy it over SSH, delete the copy). On the node:

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
systemd credential (systemd >= 250).

**Token expired / agent state lost / certificate expired** (agent offline longer than its
validity): **重装命令** (or `akari node enroll-token <node id>` for a bootstrap file). The agent
re-enrolls once when the bootstrap file carries a token it has not used yet; after that the node's
older certificates are refused. A used, unknown or expired token is refused with one uniform error
("enrollment refused"), and the agent exits.

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

The node form's REALITY template does all of the following for you (key pair, short id,
`publicKey`/`shortId`/`fingerprint`); the rest of this section is for hand-written JSON.

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

`serverNames[0]` is the SNI clients send. Users get the flow of the inbound's `settings.flow`
(add `"flow": "xtls-rprx-vision"` to `settings` for Vision, as the template does); changing it
later updates every user's credential (same id) and subscriptions follow.

## 3d. Protocol / transport matrix (W8, agent xray-core v26.3.27)

Every row was checked end to end: template → `validate_inbounds` → per-user credential →
agent apply (gate revocation) → subscription in all three formats → a real client relaying
traffic (`smoke.sh` W8 section: mihomo 1.19 and sing-box 1.12+ when available; the agent's
`TestRT_ProtocolMatrix` canary with xray's own client, including billing and revocation).

| Protocol | Transport | Security | Flow | Links (v2rayN/Shadowrocket) | Clash (mihomo) | sing-box |
|---|---|---|---|---|---|---|
| VLESS | raw TCP | REALITY | `xtls-rprx-vision` (default) or none | ✓ `flow=` | ✓ `flow:` | ✓ `flow` |
| VLESS | raw TCP | TLS | `xtls-rprx-vision` or none | ✓ | ✓ | ✓ |
| VLESS | XHTTP | REALITY / TLS / none | — | ✓ `type=xhttp&path&host&mode` | ✓ `network: xhttp` + `xhttp-opts` | ✗ left out (sing-box has no XHTTP) |
| VLESS | gRPC | REALITY / TLS | — | ✓ `type=grpc&serviceName&mode=gun` | ✓ `grpc-opts` | ✓ `transport: grpc` |
| VLESS | WebSocket | TLS / none | — | ✓ | ✓ | ✓ |
| VLESS | HTTPUpgrade | TLS / none | — | ✓ `type=httpupgrade` | ✓ `ws-opts.v2ray-http-upgrade: true` | ✓ `transport: httpupgrade` |
| VMess | raw TCP / WS / HTTPUpgrade / gRPC | TLS / none (gRPC: TLS) | — | ✓ (`aid 0`, `scy auto`) | ✓ (`alterId: 0`, `cipher: auto`) | ✓ |
| VMess | XHTTP | TLS / none | — | ✓ | ✗ left out (mihomo: XHTTP is VLESS-only) | ✗ left out |
| Trojan | raw TCP / WS / HTTPUpgrade / gRPC | TLS (required) | — | ✓ | ✓ | ✓ |
| Trojan | XHTTP | TLS | — | ✓ | ✗ left out | ✗ left out |
| Shadowsocks 2022 | (own, TCP+UDP) | — | — | ✓ `ss://method:psk%3Akey@` (SIP002, AEAD-2022 form) | ✓ `type: ss`, `cipher`, `password: "psk:key"` | ✓ `shadowsocks`, `method`, `password` |
| Hysteria 2 | QUIC (UDP) | TLS (node certificate) | — | ✓ `hysteria2://auth@host:port/?sni=` | ✓ `type: hysteria2` | ✓ `hysteria2` |

A proxy a format cannot express is left out of that format (logged at info with the reason)
instead of being rendered as a config the client rejects.

**Shadowsocks 2022 specifics.** Multi-user Shadowsocks needs one of the AES methods:
`2022-blake3-chacha20-poly1305` has no multi-user server in xray, legacy (non-2022) methods have no
per-user keys — both are refused (400). `settings.password` is the server PSK (base64, 16 bytes for
aes-128, 32 for aes-256) and `settings.clients` must be `[]`; each user gets their own key and
clients connect with `server_psk:user_key`. Changing the method reissues every user key (the
subscription must be refreshed). xray's multi-user Shadowsocks inbound cannot drop a user from its
table while running without racing its own connection path (the removed user's in-flight handshake
can run as another user, or crash the agent). Agents of protocol 5 and later (W9) therefore never
drop one: a **removed user is revoked in the agent's gate and their key stays in xray's table as a
tombstone**, so removing (and re-adding the same key, e.g. a renewed plan) is a live delta and other
users' connections are untouched. **Rotating a user's key still rebuilds the node** (a Snapshot:
every connection on that node drops once), as does a removal past the tombstone bound
(max(1024, live users) per inbound; the rebuild compacts). With an older agent, every removal from a
Shadowsocks inbound rebuilds the node. Additions are always live deltas.

**Hysteria 2** uses the node certificate like the TLS templates; `hysteriaSettings.auth` must not
be set (a shared password would bypass per-user auth); bandwidth/congestion settings are left at
xray's defaults.

**Refused (400)**, with the reason in the error: transports other than raw TCP, WebSocket,
HTTPUpgrade, XHTTP (`splithttp`), gRPC (and `hysteria` for Hysteria 2) — e.g. mKCP; `security`
other than none/tls/reality; REALITY with anything but VLESS over raw TCP/XHTTP/gRPC; Vision on
any transport but raw TCP with TLS/REALITY; VLESS `decryption` other than `none` (VLESS Encryption
is not in subscriptions); bad paths (must start with `/`, no spaces/quotes/`#`), Host values,
XHTTP modes (`auto`, `packet-up`, `stream-up`, `stream-one`) or gRPC service names; non-numeric
ports; two inbounds on the same port and L4 protocol (a UDP Hysteria 2 may share a TCP port).
Inbounds stored before these checks keep working; the node list shows them under `warnings`.

**gRPC (R26).** gRPC was refused while the agent's grpc-go was affected by GO-2026-6443. The agent
now pins grpc-go to the fixed upstream commit (`v1.85.0-dev.0.20260825072537-93e31b48545e`;
moves to v1.85.0 when tagged) and gRPC is back for VLESS/VMess/Trojan. (The advisory concerns
grpc-go's xDS server path; xray's plain gRPC server was not the vulnerable path, but the pin
keeps `govulncheck` clean without an allow-list.)

**Not supported by the embedded core:** TUIC (xray-core has no TUIC). No other core is added.
Hysteria 2 is supported because xray-core v26.3.27 implements it as a multi-user inbound.

## 3e. Node status, latency tests and the traffic multiplier (W11)

**Machine status.** Agents with the `metrics` capability (W11 agents) add a machine-status block
to every heartbeat (15 s; `akari-agent -heartbeat-interval` changes it, 1 s – 5 min): CPU %,
load 1/5/15, memory and swap, disk of `/`, the default-route interface (rates since the previous
heartbeat and totals since boot), TCP/UDP sockets in use, proxied connections, online users
(distinct users with a live connection), agent RSS, uptime and xray version — all from
`/proc` and `statfs`, no extra packages or privileges. The panel keeps the latest values in
Valkey (any instance serves them) and history in PostgreSQL: one row per node and minute
(48 h) rolled up into hours (90 days) by the reaper loop; at 200 nodes that is at most ~576k
minute rows and ~432k hour rows, one small upsert per node per heartbeat (throttled to one per
5 s). A node counts as offline exactly as before (no fresh session for 90 s). Older agents keep
working: their nodes simply show CPU/memory/connections only.

**Latency (Clash Verge url-test semantics).** Every `[probe].interval_secs` (default 5 h, ±10 %
jitter) and on "立即测速" (admin node detail; at most once per `manual_cooldown_secs`, default
30 s, per node):

- the agent (capability `latency`) sends `GET` to the first test URL from its **own egress**
  (never through xray, never via `HTTP(S)_PROXY`) — delay = request start → response headers
  (DNS + TCP + TLS + first byte, a fresh connection each attempt), median of `attempts`
  (default 3, a failed attempt counts as the timeout, default 5 s); when every attempt fails
  it tries the next URL (default `https://www.gstatic.com/generate_204`, then
  `https://cp.cloudflare.com/generate_204`). Nodes need outbound HTTPS to them;
- the panel (any instance, rows claimed in the database) measures TCP connect time to each
  inbound's client-facing address (连接地址/连接端口 override, else the node address and the
  inbound port). UDP-only inbounds (Hysteria 2) show "n/a". Set `panel_tcp = false` when the
  panel host must not dial nodes.

Badges: < 200 ms green, < 500 ms amber, else red, timeout grey. Users see the agent result
(online, multiplier, tags) of their visible nodes in the portal; never addresses or machine data.

```toml
[probe]
interval_secs = 18000          # 600 .. 604800
urls = ["https://www.gstatic.com/generate_204", "https://cp.cloudflare.com/generate_204"]
timeout_ms = 5000              # per attempt, 1000 .. 30000
attempts = 3                   # 1 .. 5, median
panel_tcp = true
manual_cooldown_secs = 30
```

**Traffic multiplier (倍率).** Billed bytes = floor(accepted bytes × rate) per counter row,
computed only inside the flush SQL (never in panel memory); the rate in effect when a report is
flushed applies to that report's increase (changing it never re-bills the past). Departed users'
final counters are billed the same way; every plausibility cap works on the accepted (raw)
bytes. The node list and detail page show both totals (`traffic_raw_bytes`,
`traffic_billed_bytes`). 0 = free node. Hidden nodes (`visible = false`) keep serving the users
they are assigned to; they are only left out of the portal and the subscription.

**Prometheus.** The metrics listener adds fleet aggregates over the nodes connected to that
instance (`akari_fleet{kind="nodes_reporting"|"online_users"|"connections"|"rx_bytes_per_second"|"tx_bytes_per_second"}`,
`akari_fleet_cpu_percent_max`; sum over instances). There are no per-node series by design:
node ids and names would be unbounded label values; per-node history is in the panel
(`/nodes/{id}/metrics`). Per-node alert thresholds are a follow-up.

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

### Sizing

At the M2 target (200 nodes, 50k users, 10k users per node) the database holds about 2M
`node_users` and 2M `traffic_counters` rows. Give PostgreSQL room for that working set
(`shared_buffers` 2 GB, `effective_cache_size` 6 GB, `max_wal_size` 4 GB were used for the
measurements in docs/PERF.md; the stock 128 MB `shared_buffers` is too small) and about 1.5 GiB of
RAM per panel instance at peak.

### Several panel instances (optional)

One instance carries the M2 target (200 nodes / 50k users, docs/PERF.md). Run
two or more for availability or headroom:

```
 admins, subscribers --> HTTPS reverse proxy (round-robin to the web ports)  --> panel A :8080, panel B :8080
 agents              --> L4 TCP balancer :8443 (TLS passthrough, no termination) --> panel A :8443, panel B :8443
 panel A, panel B    --> one PostgreSQL (direct connection), one Valkey
```

- All instances use the same `database_url`, `valkey_url` and an identical
  `data_dir` (CA, `jwt.key`, `totp.key`, route prefix: share the directory or
  copy it byte for byte); each has its own web and gRPC bind addresses.
- gRPC must be balanced at L4. The balancer must not terminate TLS (the agent's
  client certificate is the node identity). No stickiness is needed: an agent
  may land on any instance, and a reconnect elsewhere supersedes the old stream
  (the old instance notices on its next database read, within 60 s).
- PostgreSQL must be reached directly: change notification uses `LISTEN`, which
  PgBouncer in transaction or statement mode breaks.
- 系统设置 changes reach every instance through the same notification; each
  re-issues its gRPC certificate when the server-name set changed (no restart).
- Nothing else to configure: change notification, session revocation, login
  rate limiting and the flush/reaper/retention loops are database/Valkey
  based and idempotent, so every instance runs them. Metrics are per instance
  (scrape each).
- Upgrade one instance at a time after the agents (section 5); migrations run on
  the first instance that starts and are forward-only.
- Verified by `akari-bench multi` and a 200-agent swarm through a balancer
  (docs/PERF.md).

## 5. Upgrade (agents BEFORE the panel)

1. Read the release notes for protocol changes. Take a backup (docs/BACKUP.md).
2. Upgrade every agent (replace the binary, `systemctl restart akari-agent`; the xray rebuild drops live connections once).
3. Upgrade the panel: compose `AKARI_VERSION=x.y.z` in `.env`, `docker compose pull && docker compose up -d panel`; bare metal replace the binary, `systemctl restart akari-panel`. Migrations run automatically at start.
4. `akari config check`, `/healthz`, check the nodes are `online`.

**Compose deployments: the deploy files change too.** The checkout under `deploy/` (compose file,
Caddyfile) is part of the release, and new versions can need new `panel.toml` sections; the
panel refuses to start on unknown keys but cannot tell you about a missing optional section.
Per upgrade:

```bash
cd /opt/akari-panel && git status --short       # local edits to tracked files (e.g. the Caddyfile)?
git checkout deploy/caddy/Caddyfile             # only after saving anything you still need
git pull --ff-only
diff <(grep '^\[' deploy/panel.toml.compose.example) <(grep '^\[' deploy/panel.toml)   # new sections?
cd deploy && docker compose run --rm panel config check
docker compose up -d --force-recreate           # Caddyfile is a single-file bind mount (§A)
```

Since the 系统设置 release (R22) the compose stack needs `[tls_ask]` in panel.toml (`bind =
"0.0.0.0:8082"`, `allow_non_loopback = true`, see `panel.toml.compose.example`) and the
`AKARI_ASK` variable the new compose file passes to Caddy; without the section the panel never
answers Caddy's `ask`, so domains saved in 系统设置 get no certificate (AKARI_DOMAIN itself is
unaffected). `config check` run before the new version has started once may end with
`# 系统设置: database not readable (… relation "panel_settings" does not exist …)`: the migrations
have not run yet; it is harmless and gone after the first start.

**Agents without a pinned release key** (protocol 1/2, and protocol 3 builds older than v0.2.0;
`akari-agent -release-keys` prints "no release keys pinned") cannot self-update (§5b). Upload the
release under **Updates** (every architecture you run), then on the node's page use **重装命令**
(`POST /api/v1/nodes/{id}/install`) and run the printed command on the node: it installs the
newest uploaded release in place and re-enrolls the node (its previous certificate is revoked
once the new one is issued; inbounds, users and traffic stay). The panel may be upgraded first
in this case: it serves agents down to protocol 1.

W11 (node status, latency, multiplier) needs no protocol bump: features are negotiated through
`Hello.capabilities`, older agents are served as before (no machine status, no agent latency
test), so either order works; agents first is still the rule.

Why this order: a new panel drops traffic reports without `session_id` and serves the empty state
to agents below `MIN_AGENT_PROTOCOL`. (M1c: protocol 2 agents work with older panels — renewal
then fails with "unimplemented" and is retried hourly; certificates from before M1c are valid for
2 years.) The agent unit file gained `StateDirectory=` in M1c: install the new one with the agent.

## 5b. Agent updates (M6: signed self-update, staged rollout)

Agents of protocol 3 can be updated from the panel. The panel only **relays**: an agent runs a
new binary only if its manifest is signed by a release key **compiled into the agent**
(`release-keys.txt` in akari-agent), the platform matches, and the version is newer than what
runs (a signed `rollback` manifest is the only way down, and never to a version the node already
rolled back from). A compromised panel can withhold or delay updates; it cannot push an unsigned,
foreign or older binary. Protocol 1/2 agents are never offered anything (update them by hand once).

**Release key custody.** One Ed25519 key, generated and kept OFFLINE (not on the panel, not on a
build host): `go run ./cmd/akari-sign keygen -out release.key` in akari-agent prints the public
line for `release-keys.txt`. Keep `release.key` on encrypted offline media with a second copy;
whoever holds it can update every node. The agent release workflow signs manifests only if the
repository secret `AKARI_RELEASE_SIGNING_KEY` holds the key (otherwise the release has no
manifests, with a warning) and checks them against `release-keys.txt` before publishing.
Rotation: add the next public key to `release-keys.txt` and release (agents pin both); sign the
following releases with both keys (`akari-sign countersign`); once every node runs a build that
pins the next key, remove the old one. A lost or leaked key needs a manual agent release with a
new key set on every node.

The project's production key is `key-f2ad18a8bb718a1a` (pinned in agents since v0.2.0; custody
and rotation: akari-agent README "Release signing keys").

**Panel config.** Trust the same keys (early refusal of wrong uploads; agents check again):
```toml
[updates]
release_keys = ["ciJILGk6W1TnPr56Dncgv0mVQFBzqOrawiOaH0/d5Pg= key-f2ad18a8bb718a1a"]   # the lines of release-keys.txt
max_concurrent_downloads = 8                           # FetchArtifact streams per instance
```

**Publish a release** (Updates view, or the API): upload `akari-agent-linux-<arch>` with its
`.manifest.json` and `.manifest.sig` from the GitHub release (verify it first, see "Verify a
release"). The binary is stored in PostgreSQL (1 MiB rows, every panel instance can serve it;
mind the backup size) and agents download it over their existing mTLS gRPC connection
(`AgentChannel.FetchArtifact`): nodes need no extra egress.
```bash
curl -b cookies -H 'Content-Type: application/json' -X POST "$BASE/api/v1/agent-releases" \
  -d "$(jq -n --rawfile m akari-agent-linux-amd64.manifest.json --slurpfile s akari-agent-linux-amd64.manifest.sig '{manifest:$m, sig:$s[0]}')"
curl -b cookies -X PUT --data-binary @akari-agent-linux-amd64 "$BASE/api/v1/agent-releases/<id>/binary"
```

**Roll out** (`POST /api/v1/rollouts {version, percentage?, node_ids?, waves?, health_timeout_secs?,
max_failure_ratio?}`; defaults 100 %, all enrolled nodes, `[100]`, 600 s, 0.2). Waves are
cumulative percentages of the selection (e.g. `[10, 50, 100]`) in a fixed random order; the next
wave starts once every node of the current one is healthy, failed or skipped. A node is
**healthy** when it reconnects with the new version and acks its configuration within the
timeout; **failed** when the agent rejects the offer, the download/verification fails, it rolls
back, or the timeout passes; **skipped** when it cannot be offered (protocol < 3, no artifact for
its platform, development build, offline for the whole timeout). The rollout **halts** when
failed / (healthy + failed) > `max_failure_ratio`; a halted rollout can only be aborted. Pause
stops new offers (in-flight updates finish). Every action and every automatic transition is in
the audit log (`agent_release.*`, `rollout.*`; automatic ones with actor `system`).

**On the node** (no unit change needed; the installed binary stays the launcher):
- the agent downloads into `$STATE_DIRECTORY/update/bin/`, checks size, SHA-256, signature and
  version policy, stops xray (live connections drop once, as with any restart), persists its
  final traffic counters (`update/finals.json`, resent by the next process), then **replaces
  its process image** with the new binary (same PID; systemd sees no restart);
- the new binary is on probation: it must connect and get an apply acknowledged within
  `-update-self-check` (default 5 min), or it execs the previous binary again;
- if it crashes instead, systemd (`Restart=always`) starts the installed binary, which execs the
  staged one again and counts boots; after `-update-max-boots` (default 3) it goes back to the
  previous binary. Either way the version is marked failed on that node and reported
  (`ROLLED_BACK`), which fails the node in the rollout;
- installing a newer agent package by hand wins over staged binaries (they are dropped).
- `akari-agent -release-keys` prints the pinned keys ("no release keys pinned" = self-update off).

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
it runs on any Linux kernel, in distroless/scratch, and needs no glibc on the VPS. musl's own
allocator serializes this allocation-heavy multi-threaded workload, so the binary uses mimalloc
(M2). `akari --version` prints version and git sha.
