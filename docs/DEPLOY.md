# Deploying Akari

## 快速开始（一键安装，中文）

在一台全新的 **Debian 12/13 或 Ubuntu 22.04/24.04**（amd64 / arm64，≥ 1 GB 内存）上，以 root
或有 sudo 权限的用户执行**一条命令**：

```bash
curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh | sh
```

安装器按系统语言显示中文或英文提示，每一项都有默认值，直接回车即可：

| 提示 | 默认 | 说明 |
|---|---|---|
| 安装方式 | `1` Docker Compose | `2` = 裸机（systemd：PostgreSQL 18 + Valkey 9 + Caddy） |
| 主域名 | 留空 = 仅 IP | 填域名前先把 DNS A 记录指向本机，并放行 80/443 |
| 证书通知邮箱 | 留空 | 仅用于 Let's Encrypt 通知 |
| 管理员邮箱 / 密码 | 证书通知邮箱，否则 `admin@<主域名>`（仅 IP：`admin@akari.invalid`）/ 自动生成 | 邮箱就是登录名（v0.4：所有人都用邮箱登录）；自动生成的密码**只在结束时显示一次** |
| 自定义端口 | 否（80/443/8443） | 8443 是节点 agent 连接面板的 gRPC 端口 |

结束时会打印管理后台与用户门户的完整地址（含**机密路由前缀**——没有前缀，面板对外只返回空 404）
以及管理员密码。接下来：登录后台 → **系统设置** 确认主域名/订阅域名/节点通信域名 → **节点** →
添加节点 → 在节点上执行一键安装命令（§3）。

常用运维命令（安装后可用，以 root 或 `sudo` 执行）：

```bash
akari-ctl status                    # 服务状态 + 健康检查
akari-ctl info                      # 再次显示后台/门户地址（含前缀）
akari-ctl upgrade                   # 升级到最新版本：先备份 → 校验签名 → 切换 → 健康检查，失败自动回滚
akari-ctl backup                    # 备份数据库 + 数据目录（CA 私钥、jwt.key、master.key）+ 配置
akari-ctl migrate --to docker       # 同一台机器上 裸机 → Docker（或 --to bare），保留前缀、密钥与数据
akari-ctl uninstall                 # 卸载服务，保留数据与配置；--purge 彻底删除（需输入 purge 确认）
```

- **备份加密**：在 `/etc/akari/install.env` 设置 `AGE_RECIPIENT=age1…`（`age-keygen` 生成，私钥离线保存），
  之后的备份（含升级前自动备份）都用 age 加密；未设置时为 0600 明文文件并给出警告（docs/BACKUP.md）。
- **v0.3.x → v0.4 不能升级，只能全新安装**：v0.4 把迁移 0001–0168 压缩为新基线 `1000_baseline.sql`。
  `akari-ctl upgrade` 在改动任何东西之前拒绝（`database from v0.3.x — fresh install required`），面板启动时也会拒绝
  v0.3.x 的数据库；v0.3.x 的备份**不能**恢复到 v0.4。做法：`akari-ctl uninstall --purge --confirm purge` 后重新安装（见 §5）。
- **换服务器**：旧机 `akari-ctl backup` → 把备份目录复制到新机 →
  新机 `curl … | sh -s -- --restore <目录>`（加密备份加 `--age-identity <私钥>`）→ 改 DNS。
  路由前缀、CA 与密钥不变，已注册的节点与订阅链接继续可用（§8）。
- **全自动安装**（脚本/批量）：`… | sh -s -- --yes --mode bare --domain panel.example.com --email you@example.com`，
  密码用环境变量 `AKARI_ADMIN_PASSWORD` 或 `--admin-password-file` 传入（`install.sh --help` 列出全部选项）。
- 安装日志：`/var/log/akari-install.log`（0600，不含密码与前缀）。

不想用安装器、或在其他发行版上部署：按附录 A（Docker Compose）/ 附录 B（裸机）手动部署。

---

The rest of this document is in English.

Two supported layouts: **Docker Compose** (panel + PostgreSQL 18 + Valkey 9 + Caddy) and **bare
metal** (systemd + PostgreSQL 18 + Valkey 9 + Caddy). The installer below sets up either in one
command; Appendix A / B are the same layouts by hand (other distributions, nginx, an existing
database). Nodes (agents) are always a single static binary under systemd (§3).

Requirements: a Linux VPS for the panel (1 vCPU / 1 GB is enough to start), a DNS name pointing at
it (`panel.example.com` below; an IP works to try it out), ports 80/443 (TLS proxy) and 8443
(agent gRPC) reachable.

## Quick start: the installer

```bash
curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh | sh
```

As root, or as a user with sudo (the script re-runs itself through `sudo`, also when piped).
Supported: Debian 12/13, Ubuntu 22.04/24.04, amd64/arm64, systemd; anything else is refused with
a pointer to the appendix. Interactive by default (Chinese or English by locale, `--lang zh|en`),
every prompt with a default; `--yes` takes the defaults and the flags/environment for everything:

| Option | Environment | Default |
|---|---|---|
| `--mode bare\|docker` | `AKARI_MODE` | `docker` |
| `--domain NAME` | `AKARI_DOMAIN` | empty = IP only (Caddy's internal CA; browsers warn) |
| `--ip ADDR` | `AKARI_PUBLIC_IP` | the source address of the default route |
| `--email ADDR` | `AKARI_EMAIL` | none (ACME account e-mail) |
| `--admin LOGIN` | `AKARI_ADMIN` | `admin` |
| `--admin-password-file F` | `AKARI_ADMIN_PASSWORD` | generated (20 characters), printed once |
| `--node-address HOST[:PORT]` | `AKARI_NODE_ADDRESS` | the domain (or IP): 系统设置 → 节点通信域名 |
| `--http-port/--https-port/--grpc-port` | | 80 / 443 / 8443 |
| `--version vX.Y.Z` | `AKARI_VERSION` | the installer's own release (`latest/download` = newest) |
| `--dir DIR` (docker) | `AKARI_DOCKER_DIR` | `/opt/akari` |
| `--local-certs` | | Caddy's internal CA for every name (test/LAN names such as `myapp.test`) |
| `--restore DIR` / `--age-identity F` | | install from a backup (§8 host move) |

Checks before anything is changed: OS and architecture, root, systemd (bare metal), RAM (≥ 512
MiB, warning below 1 GiB), free ports (80/443/8443; bare metal also 8080/8082/6379 on loopback),
an existing installation (→ offers `upgrade` instead; an interrupted install is resumed: every
step is idempotent). Then:

- **Docker** (`/opt/akari`): Docker Engine + compose v2 from Docker's apt repository when missing
  (key fingerprint pinned); the release's compose file, Caddyfile and `panel.toml`; random
  database/Valkey passwords in `env/*.env` (0600); `.env` (0600) pins `AKARI_IMAGE` to the release's
  `tag@digest`; `docker compose up -d`.
- **Bare metal**: PostgreSQL 18 from the PGDG repository (an existing cluster on 5432 is left
  alone: the 18 cluster takes the next port), Valkey 9 (`akari-valkey.service`, loopback, password,
  no persistence; see below), Caddy from its repository with the repository's Caddyfile
  (`/etc/caddy/Caddyfile`; the environment with the secret prefix in `/etc/akari/caddy.env`, 0600,
  via a drop-in that drops `--environ` and the admin API so neither the journal nor local users
  see the prefix); the `akari` system user (sysusers), `/var/lib/akari` 0700, `/etc/akari/panel.toml`
  0640 root:akari with only the R39 start-up keys, the hardened `akari-panel.service`; ufw is
  opened for 80/443/8443 when active.
- Both: wait for `/<prefix>/healthz`, set 主域名 and 节点通信域名 (`akari settings set`), create the
  admin (the password reaches the CLI through the environment only), check `https://<domain>/<prefix>/healthz`
  through Caddy, print the URLs and the password once. `akari-ctl` (= this installer) and the backup
  scripts land in `/usr/local/sbin` and `/usr/local/lib/akari`; `/etc/akari/install.env` records
  mode, version, ports (no secrets).

**Supply chain.** The installer downloads the release's `SHA256SUMS` and its Sigstore bundle and
verifies it with **cosign** against this repository's release workflow at that tag
(`…/.github/workflows/release.yml@refs/tags/vX.Y.Z`, issuer GitHub Actions; cosign itself is
fetched with a SHA-256 pinned in the script), then checks every file it uses — the binary, the
image reference (`akari-panel-image.txt`, so Docker pulls by that digest), the deploy bundle
(`akari-deploy.tar.gz`) — against those sums. The PGDG, Caddy and Docker apt keys are pinned by
fingerprint. **Valkey**: Debian/Ubuntu ship < 9 (Debian 13: 8.1; Ubuntu 24.04: 7.2) and Valkey has
no apt repository, so the installer uses the upstream release build (`download.valkey.io`; the
`jammy` build for Debian 12/Ubuntu 22.04, `noble` for Debian 13/Ubuntu 24.04), pinned by version
and SHA-256 in the script, installed under `/opt/akari-valkey` and run as a `DynamicUser` with the
config as a systemd credential. Upgrading Valkey = a new installer release (bump `VALKEY_VERSION`
and the four checksums). The script itself is what `curl | sh` runs: read it first if your policy
requires (`curl -fsSLO …/install.sh`; `akari-ctl` is that file).

**Secrets.** Generated passwords never appear on a command line or in the log
(`/var/log/akari-install.log`, 0600); the admin password and the URLs with the secret prefix are
printed once to the terminal (`akari-ctl info` prints the URLs again).

Private mirrors / tests: `AKARI_RELEASES_URL` (a release base with the GitHub layout, `file://`
works) and `AKARI_COSIGN_KEY` (verify with a cosign public key instead of the keyless identity —
still a signature check, never skipped; it prints a warning).

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

`panel.toml` holds only what the process needs to start (R39): `data_dir`, `database_url`,
`valkey_url` (both can come from the environment), the listeners (`web.bind`, `grpc.bind`,
`metrics.*`, `tls_ask.*`), `web.trusted_proxies` (the proxy's address as the panel sees it) and
`web.cookie_secure`. See `deploy/panel.toml.example` / `panel.toml.compose.example`; nothing else
is read from it.

Everything an operator changes at runtime is set in the console under **系统设置** and stored in
the database — there is no file fallback and no precedence between the two:

```
主域名 / 订阅域名 / 信任 Cloudflare     系统设置 → 站点
节点通信域名 (host agents dial)          系统设置 → 节点通信   (required before the first node)
install pin, download fallback, ACME, remove mode   系统设置 → 节点通信
retention, Cloudflare ranges, extra release keys               系统设置 → 安全
latency tests                           系统设置 → 测速
Telegram API origin (alert channel)     系统设置 → 告警
```

Before the first login (or headless) the node domain can also be set from the CLI:
`akari settings set node panel.example.com` (a domain without a port uses `grpc.bind`'s port).
Without a node domain no install command or bootstrap file can be issued
(`settings.node_domain_unset`).

Internal tuning knobs (rate limits, token lifetimes, the fail-closed lease, billing plausibility
caps, alert cadence, agent certificate validity…) are built-in constants (`src/CLAUDE.md`
"Built-in constants").

`akari config check` validates the file, prints the effective config with secrets redacted, lists
obsolete keys (warnings) and, when the database is reachable, the 系统设置 values; `akari serve`
runs the same validation and refuses to start on errors.

### Upgrading: obsolete keys

Keys of older releases (`web.advertised_names`, `web.sub_domain`, `web.trust_cloudflare`,
`web.cloudflare_ranges`, `grpc.advertise`, `grpc.server_name`, `install.*`, `[probe]`, `[acme]`,
`[audit]`, `[traffic]`, `[auth]`, `[agent]`, `[sub]`, `[updates]`, `[alerts]`,
`tls_ask.rate_per_sec`, `grpc.lease_seconds`, W24's `[payments]`) never stop the panel:

- Each key that moved to 系统设置 is **imported once** on the first start that sees it, when the
  database has no value for it yet (one transaction, audited `settings.import` as actor `system`;
  every instance reloads at once). `web.advertised_names` and `grpc.server_name` join the gRPC
  certificate's name list (`grpc_server_names`, source `config`) so enrolled agents keep
  connecting; `install.public_url` becomes the main domain (which turns the host check on — see
  below); `updates.release_keys` keeps only keys that are not the official one compiled in.
- From then on the key is **ignored** with a startup warning — also after you change or clear the
  value in the console (the file never brings it back; `legacy_config_imports` remembers what was
  handled).
- Keys that became constants are ignored with a warning.

So: upgrade, start once, check 系统设置 (and the `config check` warnings), then **delete the
obsolete keys from panel.toml**.

## 1b. Domains (系统设置) and Cloudflare

The admin console's **系统设置** page (`/<prefix>/admin/settings`) holds three domains and one switch.
Once the main domain is saved, the console (`/<prefix>/admin`) answers on the main domain only
(and on IP literals); on the subscription domain it is the uniform empty 404 (R23). They live in the
database only (table `panel_settings`; an empty field = the built-in behaviour in the table below).
`akari settings show` prints them; `akari settings set main|sub|node <host[:port]>` /
`set trust-cloudflare true|false` and `akari settings unset main|sub|node|trust-cloudflare|probe|all`
change them from the CLI (audited) — e.g. after a mistyped main domain. Changes take effect on every panel instance within a second (database
notification), **no restart** — including the gRPC certificate.

| Field | Used for | Cloudflare | When empty |
|---|---|---|---|
| 主域名 (main) | admin console, user portal, install links, payment notify URLs | orange or grey | the admin's browser origin; no host check |
| 订阅域名 (subscription) | every subscription URL the panel hands out (portal, admin, API `sub_url`) | **orange** recommended (hides the server IP) | the main domain |
| 节点通信域名 (node) | `panel_addr`/`server_name` of NEW install commands and bootstrap files | **grey only** | **no tokens can be issued** |
| 信任 Cloudflare | real client IP behind Cloudflare (`CF-Connecting-IP`) | — | off |

Values are host names (IDN is stored as punycode) or IP addresses, optionally with `:port`; no
scheme or path. The **DNS 检测** buttons resolve the name from the panel: the subscription domain
warns if it does not resolve into Cloudflare's ranges; the node domain **refuses to save** if it
does (the admin can override after an explicit confirmation): agents talk gRPC with mutual TLS
directly to port 8443, and an orange-clouded record makes Cloudflare terminate TLS (and it does not
proxy arbitrary ports), so agents cannot connect.

**Host check.** Once a main domain is saved, the panel answers only requests whose Host is the
main or subscription domain or an IP address; any other domain
name gets the same empty 404 as every other rejection. Saving asks for confirmation when the
address you are using would stop working.

**Node domain and existing nodes.** An enrolled agent keeps the server name of its bootstrap
file forever. The panel therefore records every server name it ever wrote into a bootstrap
(`grpc_server_names`) and its gRPC certificate covers all of them plus `localhost`/`127.0.0.1`:
changing the node domain only affects new installs, existing nodes keep connecting. A name leaves
the certificate only through **移除** in the "节点通信证书域名" table, which lists the nodes still
using it (they must be re-installed afterwards). Nodes enrolled before this release have no
recorded name and are listed separately (they use the old panel.toml `grpc.server_name`, imported
into the list with source `config`; it cannot be removed while such nodes exist).

**Reverse proxy certificates.** `deploy/caddy/Caddyfile` serves `AKARI_DOMAIN` as before and any
other name **on demand**: at the first handshake for a new name Caddy asks the panel's
`ask` endpoint (`[tls_ask] bind`, its own listener: compose `0.0.0.0:8082` on the private network
with `allow_non_loopback = true`, bare metal `127.0.0.1:8082`; `AKARI_ASK` in Caddy's
environment). The panel answers 200 only for the configured main and subscription domains
(rate-limited per instance, built in), so no Caddyfile edit is needed when domains change and
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
release picks them up, paste the full list into 系统设置 → 安全 → **Cloudflare 网段** (one CIDR
per line; it replaces the shipped list on every instance at once, no restart; empty = shipped):

```bash
curl -s https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6   # review, paste
```

A stale list fails safe: traffic from an unknown edge range is simply attributed to the edge.
Release maintainers refresh `src/cloudflare_ips.txt` from the same URLs (the unit test
`cloudflare::tests` checks it parses).

## 2. First admin

The installer creates it (and sets 主域名 / 节点通信域名, §2b); by hand, or another one later
(`akari-ctl` installations: compose directory `/opt/akari`):

```bash
# compose:  docker compose exec -e AKARI_ADMIN_PASSWORD='...' panel /akari admin add you@example.com
# bare metal: sudo -u akari env AKARI_ADMIN_PASSWORD='...' akari -c /etc/akari/panel.toml admin add you@example.com
```

Omit the variable to be prompted. The e-mail address is the login name (v0.4: everyone, admins
too, logs in with the address; it counts as verified). Open
`https://panel.example.com/<prefix>/app` and log in with the address and the password; admins are
taken to the console at `https://panel.example.com/<prefix>/admin` (served only to an admin
session — without one it is the same empty 404 as any unknown path, so bookmark `/app`, not
`/admin`). Forgotten password: `akari admin passwd <email>` (ends the account's sessions).
(TOTP two-factor authentication was removed in v0.4; passkeys replace it.)

## 2b. 系统设置 (main domain)

(Installer: already set to `--domain`, and 节点通信域名 to the same name, or the IP for an IP-only
install; check them.) In the console, **系统设置**: set **主域名** to the name you deployed with (`panel.yourdomain.com`)
and save. Install links, subscription URLs and payment callbacks are then built from it instead of
from whatever address a browser happened to use, and the Host check (§1b) turns on: requests for
any other name get the empty 404. A subscription domain (for Cloudflare) and a node communication
domain are optional (§1b).

## 2c. Mail, registration and password reset (optional, W15)

Everything here is off until you turn it on; nothing in panel.toml.

1. **系统设置 → 邮件**: SMTP server, port and security — **STARTTLS** (587) or **SSL/TLS**
   (465) for a mail provider; **不加密** only for a relay on the same host/private network (the
   panel refuses credentials over it). Username/password if the provider needs them (the password
   is sealed with a key derived from `data/master.key`: if that file is lost, enter it again), sender
   address (the provider must allow it; set SPF/DKIM for that domain at the provider) and sender
   name (also the site name in mails). Tick **启用邮件发送**, save, then **发送测试邮件** to
   yourself — the provider's answer is shown when it fails.
2. Notices (same card): order receipts, plan-expiry reminder N days before (0 = off), "plan
   expired", traffic at 80 % and used up (once each per period). Only verified addresses get
   mail; users add theirs in the portal (邮箱 card: current password + emailed code).
3. **系统设置 → 注册**: **开放注册** (login page shows 注册; the address becomes the login).
   **注册需要邮箱验证** (v0.4: an on/off switch, default off, independent of 必须使用邀请码; on
   needs 邮件发送). Registration can be opened **without SMTP**: people then sign up with email +
   password only; the address is stored **unverified** (no mail to it, no password reset, not
   unique, not usable for the email form of the login — the login name is the address, any case,
   so they log in with it). Users verify it later under 账户 once mail works; an admin can mark
   it verified (用户 → 管理 → 标记邮箱已验证). Anti-abuse without verification: a built-in
   proof of work the browser solves invisibly (~2^18 SHA-256, no third-party captcha), 5
   registrations per client address per hour / 20 per day and 5 attempts per address per hour,
   plus the optional invite code and domain allow-list. Residual oracle: a registration attempt
   reveals whether an address is taken (one generic "cannot be registered" answer, bounded by
   those limits) — inherent to sign-up without verification. Optionally
   **必须使用邀请码** (users create codes/links in the portal; single-use or not;
   per-user limit), an **邮箱域名白名单** (one per line; subdomains included) and a **试用套餐**
   with its length in days. **允许通过邮件找回密码** needs the main domain (§2b): reset links
   are always built from it, never from the address a request came in on.
4. Delivery: requests only queue mail; every panel instance runs a sender (one message at a time,
   `FOR UPDATE SKIP LOCKED` + lease, so instances never send the same message concurrently), retries
   with backoff for about two hours, then keeps a **失败邮件** entry you can retry (codes and reset
   links expire instead: they are useless late). Sent bodies are erased; rows are kept 30 days
   (sent) / 90 days (failed). Metric: `akari_mail_deliveries_total{kind,result}`.
5. Abuse limits (Valkey, all instances): 10 mails per client address per hour, 5 per destination
   address per hour and 20 per day, 30 code/link completions per client address per 15 minutes;
   a code burns after 5 wrong tries. With verification, answers never reveal whether an address
   has an account.
6. **Bot protection (W27, `PUT /api/v1/settings/auth`; console page in W36-b)** for 登录、注册、找回密码:
   - **蜜罐 + 最短提交时间**（默认开启：2 秒）: the page fetches a signed form token from
     `/auth/options` and posts it no sooner than the minimum time; a filled hidden field, a
     missing/forged/stale token or a too-fast post gets exactly the ordinary failure of that form
     (no hint for the bot) and only increments `akari_bot_trap_total{form,reason}` — no log
     lines. Scripts that log in with curl must do the same (`/auth/options` → wait → post
     `"guard":{"form_token":…}`) or set 最短提交时间 to 0.
   - **Cloudflare Turnstile** (per form, default off): site key + secret (secret write-only, sealed
     with `data/master.key`), verified server side; when switched on it **fails closed** (no or a
     rejected token = 400, Cloudflare unreachable = 503). Locked out by a wrong key:
     `akari settings unset turnstile` switches it off on every form (audited, keys kept).
7. **Passkeys (W27)** need the main domain (§2b) as an https DNS name: passkeys belong to that
   name (RP ID). Policies (`PUT /api/v1/settings/auth`): 管理员仅通行密钥 / 用户仅通行密钥 (an
   account with a passkey must use it; accounts without one keep their password until they add
   one), and 密码登录后提示绑定 (binding from the prompt switches that account's password login
   off). An admin needs no second passkey, but losing the only one means:
   `akari admin reset-login <email>` on the server (deletes the account's passkeys, password login
   back on, audited). **Changing the main domain** orphans existing passkeys (browsers only offer
   them on the old name): they show as not current and those accounts fall back to the password.

### 发信方式与「测试发信」诊断（W31）

**系统设置 → 邮件 → 发信方式** 二选一：

- **SMTP**：服务器、端口、加密方式与账号同上。常见组合：**465 + SSL/TLS（隐式 TLS）**，或
  **587 + STARTTLS**。很多云服务商默认封锁出站 25/465/587，需要先提交工单开通。
- **Resend（HTTPS API）**：只走出站 443，不受 SMTP 端口封锁影响。在 Resend 后台验证发件域名
  （按提示添加 DNS 记录），创建一个有发信权限的 API 密钥，填入 **API 密钥**，发件地址必须属于
  已验证的域名。

密码与 API 密钥都用面板主密钥派生的同一把加密密钥存库（各自固定的 AAD：`SMTP_AAD`、`RESEND_AAD`），接口只返回「已设置」，审计只记
"changed"；主密钥更换后需要重新填写。以后增加服务商 = `src/mail/transport/` 新增一个模块 +
注册表一行 + 迁移放宽 `mail_settings_provider`。

**测试发信**（`POST /api/v1/settings/mail/diagnose`）用**已保存**的设置逐步检查，每一步给出状态、
耗时和中文说明（另附英文与 `mail.diag.*` 代码）：

| 步骤 | 检查什么 | 常见失败与说明 |
|---|---|---|
| 配置 | 必填项、密钥能否解密、端口与加密方式是否匹配（465 应为 SSL/TLS，587/25 应为 STARTTLS，不匹配时警告） | 缺少服务器/发件地址/API 密钥；主密钥更换后密钥无法解密 |
| DNS | 主机名能否解析 | 拼写错误、面板机器 DNS 故障 |
| TCP | 能否连上端口（10 秒） | **超时 = 出站端口被服务商或防火墙封锁**；拒绝 = 端口上没有服务 |
| TLS | 握手与证书 | 设为 SSL/TLS 但服务器发来明文问候 → 改 STARTTLS；设为 STARTTLS 但服务器不问候、却接受 TLS 握手 → 改 SSL/TLS；证书不受信任（填了 IP 或自签证书） |
| 问候 | 220 问候与 EHLO | 服务器拒绝服务 |
| 认证 | AUTH PLAIN / LOGIN | 535 用户名或密码错误（QQ/163/Gmail/Outlook 需要**授权码/应用专用密码**）；534 要求应用专用密码；530 要求先加密 |
| 发送 | 用与发件队列相同的传输发出测试邮件 | 服务器拒收（发件地址与账号不一致、收件人不存在）；Resend：密钥无效、域名未验证、请求过多 |

诊断最多 60 秒，前一步失败后其余步骤标为「未执行」；结果写审计 `settings.mail.test`。原来的
「发送测试邮件」（`/settings/mail/test`，失败时 502 带服务器回答）保留。

## 2d. Payments (系统设置 → 支付, W24)

Payment methods are configured only in the console (database; no panel.toml, every instance at
once): **系统设置 → 支付 → 添加支付方式 → 支付宝当面付**, environment (正式/沙箱), APPID, optional
商户 PID, paste the app private key (sealed with `data/master.key`, never shown again) and Alipay's
public key, upload the shown **应用公钥** at the Alipay open platform, enable, then **测试连接**.
The notify URL is derived from the main domain (§2b) per method — nothing to configure at Alipay.
Several methods are possible (payers choose at checkout). Details, key rotation and the legacy
upgrade: docs/PAYMENTS.md. An old panel.toml `[payments.alipay]` is imported once into an empty
database configuration and then ignored with a warning: delete the section and its key files.

## 3. Add a node and install the agent

**In the UI: Nodes → 新建节点.** Fill in the name, the region users see, the node's public
address (IP or domain), optionally the node's **节点域名** (TLS domain: the agent then gets the
certificate by itself, §3f) and one or more inbounds from the protocol templates:

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

"Certificate" = the node's own certificate for the TLS domain. **With 节点域名 set (recommended)
the agent obtains and renews it itself over ACME (Let's Encrypt), §3f**: no certbot, nothing to do
on the node beyond a DNS record pointing at it and TCP 80 reachable. The TLS templates then take
that domain as certificate domain/SNI (leave their domain field empty; another name is refused,
the certificate covers only the node's domain). Without 节点域名 the certificate is yours to put
on the node as `/etc/akari-agent/tls/fullchain.pem` and `privkey.pem` (certbot, acme.sh, …;
root-only files are fine). The installer hands that directory to the agent as systemd credentials
(the agent runs as a dynamic user and cannot read `/etc` otherwise), read once at service start:
after putting the certificate there for the first time (before saving a TLS/Hysteria 2 inbound)
and after every renewal run `systemctl restart akari-agent`. A WS inbound behind the node's own reverse proxy
or a CDN is not a template (subscriptions would advertise the inbound's local port): write that
JSON by hand. **高级：直接编辑入站 JSON** shows/edits the generated JSON; both paths go through the
same validation (the §3d matrix, no `fakedns`).

Creating the node shows a **one-line install command**, valid for 1 hour (built in) and only
until the agent has enrolled with it. It needs 系统设置 → 节点通信 → **节点通信域名** (the address
agents dial; without it the panel refuses to issue the command):

```bash
curl -fsSL 'https://panel.example.com/<prefix>/install/<token>' | sh -c '[ "$(id -u)" = 0 ] || exec sudo sh; exec sh'
# or: wget -qO- 'https://panel.example.com/<prefix>/install/<token>' | sh -c '…same…'
```

Run it on the node (Linux with systemd >= 250, amd64 or arm64; Debian 12/13, Ubuntu 22.04+ are
fine; W32: also Alpine Linux with OpenRC >= 0.45, tested on 3.22 — §3h), as root or as a sudo user: the tail runs the script directly as root (images without
`sudo` work) and through `sudo` otherwise (W10; commands issued before printed `| sudo sh`, which
needs `sudo` even as root). Without root and without `sudo` it stops at `sudo` and runs nothing.
It

1. downloads the agent from the panel (the newest complete release uploaded under **Updates**,
   §5b) and checks its SHA-256 — without an uploaded release it falls back to
   系统设置 → 节点通信 → **备用下载地址** (default: the latest GitHub release asset, checked
   against the release's `SHA256SUMS`; can be set to a mirror or turned off); with neither it
   stops with a clear error before changing anything;
2. writes `/etc/akari-agent/bootstrap.toml` (0600: panel address, gRPC server name, panel CA,
   the one-time enrollment token — no private key), the systemd units
   (`akari-agent.service` and the agent's privileged updater `akari-agent-update.service` +
   `akari-agent-update.path`; the path unit is enabled, §5b) and a drop-in for the TLS
   credentials. **The units are the ones the downloaded release carries** (W23: the verified
   binary prints them, `akari-agent -print-unit <name>`; their canonical copy is the agent
   repository's `systemd/`). Only releases older than that get the copies embedded in the script
   (`deploy/systemd/` of the panel, kept byte-identical by the agent's CI); the output then says
   `does not carry its systemd units`. Self-updates install each new release's units with its
   binary (§5b), so do not edit the installed unit files: local changes go into a drop-in
   (`/etc/systemd/system/akari-agent.service.d/*.conf`; an edited unit is reported on the node
   page and replaced by the next update or reinstall);
   On Alpine (OpenRC) it installs the release's OpenRC scripts instead (`/etc/init.d/akari-agent`,
   `/etc/init.d/akari-agent-update`) and a system user `akari-agent` (§3h);
3. turns on TCP BBR with the fq qdisc where the kernel supports it and the machine allows it
   (W32, §3h; `--no-bbr` / `AKARI_BBR=0` skips it);
4. with 节点域名 set: opens TCP 80 in an active `ufw`/`firewalld` (the CA's HTTP-01 check; a
   cloud firewall / security group is outside the machine, the output reminds you);
5. starts the agent and waits until it has enrolled and connected (prints `SUCCESS`, or the
   agent's log and the reason). The certificate follows within seconds; its state is on the node
   page.

Running it again is safe (reinstall/upgrade in place). The node shows `online` within seconds.
A reinstall also turns the node's entry in a finished (aborted/completed) rollout into history:
the node list shows it greyed as `…（重装前）` instead of as the node's current update state.
Uninstall: `akari-agent-uninstall` on the node as root (`sudo akari-agent-uninstall` for a sudo
user; the installer prints the form that fits how it ran), or a fresh command with
`| sudo sh -s -- --uninstall` (as root: `| sh -s -- --uninstall`); then delete the node in the
panel.

**Security of the link.** The token in the URL *is* the node's enrollment token (256 bit, only
its SHA-256 stored, single use, short TTL). The panel serves the script and the binary only while
it is live; once the agent enrolls (or the link expires, or a newer link/token is issued for the
node, or the node is being deleted) every request is the panel's uniform empty 404, as are wrong
tokens and sources over the rate limit (20 per 10 min per address, built in). Whoever runs the command first gets the node, exactly as with
a bootstrap file: copy it over a trusted channel. The script passes the token to no command
line (downloads read their URL from stdin) and the panel never logs it (`/{prefix}/install/{token}`
in logs). **重装命令** in the node list issues a new link for an existing node; when the agent
enrolls with it, the node's previous certificate is revoked.

**Where the link points.** The main domain (系统设置 → 站点 → 主域名) if set; otherwise the
address the admin's browser uses for the panel. When the panel issues a
command it connects to that origin: a certificate a public CA vouches for → plain `curl`/`wget`.
Anything else (an IP-only deployment with Caddy's internal CA) → the command **pins the served
certificate's public key**:

```bash
curl -fsSL --proto '=https' -k --pinnedpubkey 'sha256//<base64>' 'https://203.0.113.10/<prefix>/install/<token>' | sh -c '[ "$(id -u)" = 0 ] || exec sudo sh; exec sh'
```

curl checks the pin during the handshake, before it sends the request, so a mismatch aborts
without revealing the token; `-k` only skips the CA check a self-signed panel cannot pass and is
never emitted without a pin (there is no wget variant: wget cannot pin). The script uses the
same pin for the binary download. Caddy's internal certificates are short-lived (about 12 h): if
the command fails with "public key does not match", generate a new one. Set 系统设置 → 节点通信 →
**安装命令公钥钉扎** (`sha256//<base64>`) to pin a fixed key instead of probing (e.g. when the panel
cannot reach its own public address).

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
expires after 24 h (built in). Treat the file as a credential until
the agent has enrolled (copy it over SSH, delete the copy). On the node:

```bash
install -m 0755 akari-agent-linux-amd64 /usr/local/bin/akari-agent   # arm64: akari-agent-linux-arm64
akari-agent -version
install -d -m 0700 /etc/akari-agent
install -m 0600 tokyo-1-bootstrap.toml /etc/akari-agent/bootstrap.toml && shred -u tokyo-1-bootstrap.toml
for u in akari-agent.service akari-agent-update.service akari-agent-update.path; do
  akari-agent -print-unit $u >/etc/systemd/system/$u                 # the units this release carries
done
systemctl daemon-reload && systemctl enable --now akari-agent akari-agent-update.path
journalctl -u akari-agent -f                                         # "enrolled", then "channel established"
```

On its first start the agent generates its key (ECDSA P-256) in its state directory
(`StateDirectory=akari-agent`, i.e. `/var/lib/private/akari-agent`, mode 0700, files 0600; without
systemd: `-state-dir`, default the config file's directory), sends a CSR with the token to the
panel's gRPC port (the one call that works without a client certificate) and stores the issued
certificate next to the key. The private key never leaves the node. The panel decides the whole
certificate (CN `agent-<node id>`, client-auth only, valid 90 days — built in; agents renew at a
third left).

The unit grants only `CAP_NET_BIND_SERVICE` (inbounds on 443) and reads the bootstrap file as a
systemd credential (systemd >= 250). It hides other users' processes (`ProtectProc=invisible`)
but not the machine-wide `/proc` files the node status reads (`/proc/stat`, `meminfo`,
`loadavg`, `net/*`): units from before W23 had `ProcSubset=pid`, under which every machine
metric read 0 — the agent now reports what it cannot read as **未知** (unknown), never as 0, and
the node page says why (§3e).

**Token expired / agent state lost / certificate expired** (agent offline longer than its
validity): **重装命令** (or `akari node enroll-token <node id>` for a bootstrap file). The agent
re-enrolls once when the bootstrap file carries a token it has not used yet; after that the node's
older certificates are refused. A used, unknown or expired token is refused with one uniform error
("enrollment refused"), and the agent exits.

Enrollment is rate limited per source address and globally (10 / 60 per 10 min, built in).

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

## 3h. 系统支持：BBR + fq 与 Alpine（W32，中文）

**BBR + fq（安装时自动开启，可关闭）。** 一键安装脚本在节点上开启 TCP BBR 拥塞控制 + fq 队列
（跨境、有丢包的长距离线路吞吐明显更好）。agent 本身**从不**修改内核参数，只有安装脚本做这件事：

- 先检测：内核有 `tcp_bbr`（已内置、已加载，或能 `modprobe tcp_bbr`），且 `/proc/sys` 可写。
  不满足就跳过并说明原因，安装照常完成——常见于 OpenVZ/LXC 等容器（内核参数只读、或容器有自己的
  网络命名空间而没有 `net.core.default_qdisc`）以及没有 BBR 的旧内核；
- 开启后写入独立的 `/etc/sysctl.d/90-akari-bbr.conf`（`net.core.default_qdisc = fq`、
  `net.ipv4.tcp_congestion_control = bbr`，并以注释记下原来的值），`tcp_bbr` 是模块时另写
  `/etc/modules-load.d/akari-bbr.conf`，开机自动生效。BBR 对新连接立即生效；fq 对之后新建的网卡
  队列生效（重启后全部生效）；
- 已经是 BBR + fq 的机器：不写任何文件（"already enabled ... left as it is"）。重复运行安装命令
  是幂等的；
- **关闭**：安装时加 `--no-bbr`，或设置环境变量 `AKARI_BBR=0`：
  ```bash
  curl -fsSL '<安装链接>' | sh -s -- --no-bbr               # root
  curl -fsSL '<安装链接>' | sudo sh -s -- --no-bbr          # sudo 用户
  curl -fsSL '<安装链接>' | sudo AKARI_BBR=0 sh             # 或用环境变量
  ```
  对已经由安装脚本开启过 BBR 的节点，带 `--no-bbr` 重装会删除上述文件并恢复原来的值；
- **卸载**（`akari-agent-uninstall`）只删除安装脚本加的这两个文件；如果当前生效的仍是我们设置的
  值，就恢复为安装前记录的值（期间被别人改过的不动）。自己手工配置的 sysctl 不受影响。

**Alpine Linux（OpenRC）。** 同一条安装命令在 Alpine 上自动识别 OpenRC（要求 OpenRC ≥ 0.45；
CI 在 Alpine 3.22 / OpenRC 0.62 上测试；amd64/arm64）。agent 是无 cgo 的静态二进制，musl 上直接运行，
不需要单独的 musl 构建。安装内容：

- 系统用户 `akari-agent`（代替 systemd 的 DynamicUser）；`/etc/init.d/akari-agent` 与
  `/etc/init.d/akari-agent-update`（来自所装版本本身，`akari-agent -print-unit akari-agent`；
  更早的、不带 OpenRC 脚本的版本在 Alpine 上会被拒绝，请先在「更新」里发布新版本），两者加入
  default 运行级；
- agent 由 supervise-daemon 守护（崩溃 3 秒后重启，默认不限次数），只有
  `CAP_NET_BIND_SERVICE`（可监听 443）与 `no_new_privs`；`/etc/akari-agent/bootstrap.toml`
  （及自备证书 `/etc/akari-agent/tls/*.pem`）在启动时复制到 `/run/credentials/akari-agent.service/`
  （内存盘、仅 agent 可读、停止即删除），与 systemd 下路径一致；状态目录 `/var/lib/akari-agent`
  （0700）以 bind mount 重新挂成 `noexec,nosuid,nodev`（W^X，与 systemd 的 noexec StateDirectory
  等价；容器里没有挂载权限时照常启动并在服务日志里提示）；
- 日志：`/var/log/akari-agent/agent.log`（`tail -f` 查看；每次启动时超过 16 MiB 轮转为
  `agent.log.1`；需要定期轮转可 `apk add logrotate` 并配置 `copytruncate`），更新器日志
  `/var/log/akari-agent-update.log`；
- 常用命令：`rc-service akari-agent restart|status`；本地设置写在 `/etc/conf.d/akari-agent`
  （例如 `AKARI_AGENT_ARGS="-heartbeat-interval 30s"`、`respawn_max=5 respawn_period=60`），
  安装脚本与自更新**从不**修改 conf.d；不要直接改 `/etc/init.d/` 里的脚本（会被下次更新替换，
  节点页会提示"单元已被修改"）；
- BBR 持久化依赖 `sysctl` 服务在 boot 运行级（Alpine 标准安装默认如此；没有时安装脚本会提示
  `rc-update add sysctl boot`）。

**Alpine 上的自更新**与 systemd 节点走同一套校验（§5b），差异与已知缺口：

| systemd | OpenRC（Alpine） |
|---|---|
| `akari-agent-update.path` 监视请求文件，立即触发 | `akari-agent-update` 服务是一个 root shell 循环，每秒检查一次请求文件（agent 等待裁决 90 秒，足够），然后运行**已安装的**二进制 `-apply-update`，一次一个 |
| 更新器单元有沙箱：无网络、`ProtectSystem=strict`、能力边界集、系统调用过滤 | **缺口**：OpenRC 没有对应机制，更新器以普通 root 运行（通过 OpenRC 重启 agent 本身就需要启动服务所需的权限）。校验逻辑完全相同：不跟随符号链接、只收 agent 所有的单链接普通文件、先拷入 root 文件再校验副本、用自身编译进的公钥验签 |
| agent 单元的文件系统/内核/系统调用沙箱（ProtectSystem、ProtectProc=invisible、SystemCallFilter 等） | **缺口**：只有专用用户 + 仅 `CAP_NET_BIND_SERVICE` + `no_new_privs` + `/etc/akari-agent` 仅 root 可读 + noexec 状态目录 |
| 崩溃次数 = `NRestarts`；启动次数限制触发 = 立即回滚 | 崩溃次数 = supervise-daemon 的重启计数（`/run/openrc/options/akari-agent/start_count`）；conf.d 设置了 `respawn_max` 且 supervise-daemon 放弃（服务停止并标记 failed）、守护进程消失，或服务仍显示 started 但子进程已不在超过 15 秒（supervise-daemon 偶尔会漏掉立即退出的子进程）= 立即回滚 |
| 单元随更新刷新，`daemon-reload` | 两个 init 脚本随更新刷新（root 0755，旧的存 `units.prev/`，回滚恢复）；OpenRC 每次启动都重新读取脚本，无需 reload。更新器自己的脚本在它下次启动（重启或重装）时生效 |
| `journalctl -u akari-agent-update` | `/var/log/akari-agent-update.log` |

CI：agent 仓库的 `openrc self-update` job（Alpine 3.22 容器，OpenRC 为 init）覆盖 安装 → 更新 →
坏版本回滚（重启计数与 supervise-daemon 放弃两种）→ 恶意请求拒绝；面板 smoke 的 W32 段用一键安装
命令在 Alpine 容器里装节点、验证 BBR 开关、重装与卸载。

## 3g. First user: node group, plan, subscription

Access is granted by plan (M3): a user with an active plan may use every node in the plan's node
groups; nodes, groups and plans can change later and every node converges by itself.

1. **套餐 → 新建节点组**: name it, tick the node(s).
2. **套餐 → 新建套餐**: traffic quota, reset period (monthly …), optional speed limit;
   tick the node group (expiry is set per user when assigning, or by the shop period). Prices only
   matter for the shop (docs/PAYMENTS.md).
3. **用户 → 新建用户**: login and password, then **分配套餐** on the user. The node receives the
   user within a second or two (`POST /api/v1/users`, `PUT /api/v1/users/{id}/plan
   {"plan_id": …}`).
4. The user logs in at `https://panel.yourdomain.com/<prefix>/app` and copies **订阅链接** (the
   admin sees the same URL on the user, `sub_url`). The link serves the format the client asks
   for by its User-Agent: Clash/mihomo YAML, sing-box JSON, or base64 share links (v2rayN,
   Shadowrocket, …); quota and expiry travel in `subscription-userinfo`.
5. Import the link in the client and connect. Usage shows up on the user within about 15 s
   (agent report every 10 s, flush every 5 s).

**重新生成订阅令牌** invalidates the old link at once (the user can do it in the portal too).

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

<!-- BEGIN GENERATED protocols-matrix: from proto/protocols.toml by `make gen-protocols`; CI fails when stale -->
Generated from `proto/protocols.toml` (manifest schema 1, kernel xray-core v26.3.27); edit the manifest, then `make gen-protocols`.

| Protocol | Transport | Security | Options | Links (v2rayN/Shadowrocket) | Clash (mihomo) | sing-box |
|---|---|---|---|---|---|---|
| VLESS | raw TCP | none / TLS / REALITY | flow: none, `xtls-rprx-vision` (TLS / REALITY) | ✓ `vless://`, `flow=` | ✓ `type: vless`, `flow:` | ✓ `vless`, `flow` |
| VLESS | WebSocket | none / TLS | — | ✓ `vless://`, `flow=` | ✓ `type: vless`, `flow:` | ✓ `vless`, `flow` |
| VLESS | HTTPUpgrade | none / TLS | — | ✓ `vless://`, `flow=` | ✓ `type: vless`, `flow:` | ✓ `vless`, `flow` |
| VLESS | XHTTP | none / TLS / REALITY | — | ✓ `vless://`, `flow=` | ✓ `type: vless`, `flow:` | ✗ left out (sing-box has no xhttp transport) |
| VLESS | gRPC | TLS / REALITY (none: hand-written JSON only) | — | ✓ `vless://`, `flow=` | ✓ `type: vless`, `flow:` | ✓ `vless`, `flow` |
| VMess | raw TCP | none / TLS | — | ✓ `vmess://` (`aid 0`, `scy auto`) | ✓ `alterId: 0`, `cipher: auto` | ✓ `vmess` |
| VMess | WebSocket | none / TLS | — | ✓ `vmess://` (`aid 0`, `scy auto`) | ✓ `alterId: 0`, `cipher: auto` | ✓ `vmess` |
| VMess | HTTPUpgrade | none / TLS | — | ✓ `vmess://` (`aid 0`, `scy auto`) | ✓ `alterId: 0`, `cipher: auto` | ✓ `vmess` |
| VMess | XHTTP | none / TLS | — | ✓ `vmess://` (`aid 0`, `scy auto`) | ✗ left out (mihomo supports xhttp only for vless) | ✗ left out (sing-box has no xhttp transport) |
| VMess | gRPC | TLS (none: hand-written JSON only) | — | ✓ `vmess://` (`aid 0`, `scy auto`) | ✓ `alterId: 0`, `cipher: auto` | ✓ `vmess` |
| Trojan | raw TCP | TLS (none: hand-written JSON only) | — | ✓ `trojan://` | ✓ `type: trojan` | ✓ `trojan` |
| Trojan | WebSocket | TLS (none: hand-written JSON only) | — | ✓ `trojan://` | ✓ `type: trojan` | ✓ `trojan` |
| Trojan | HTTPUpgrade | TLS (none: hand-written JSON only) | — | ✓ `trojan://` | ✓ `type: trojan` | ✓ `trojan` |
| Trojan | XHTTP | TLS (none: hand-written JSON only) | — | ✓ `trojan://` | ✗ left out (mihomo supports xhttp only for vless) | ✗ left out (sing-box has no xhttp transport) |
| Trojan | gRPC | TLS (none: hand-written JSON only) | — | ✓ `trojan://` | ✓ `type: trojan` | ✓ `trojan` |
| Shadowsocks 2022 | (own) | none | method: `2022-blake3-aes-128-gcm`, `2022-blake3-aes-256-gcm` | ✓ `ss://method:psk%3Akey@` (SIP002, AEAD-2022 form) | ✓ `type: ss`, `cipher`, `password: "psk:key"` | ✓ `shadowsocks`, `method`, `password` |
| Hysteria 2 | (own) | TLS | — | ✓ `hysteria2://auth@host:port/?sni=` | ✓ `type: hysteria2` | ✓ `hysteria2` |

Combination rules (checked in this order, beyond each protocol's transports and security):

- `reality_protocol`: REALITY only with VLESS
- `reality_transport`: REALITY only over raw TCP, XHTTP or gRPC
- `vision`: Vision (xtls-rprx-vision) only on raw TCP with TLS or REALITY
- `grpc_tls`: the templates put gRPC behind TLS (templates only)

Per-user credentials (`account_json`, keys sorted):

- VLESS (agent protocol name `vless`): `flow` (= the inbound's `flow`), `id` (UUID)
- VMess (agent protocol name `vmess`): `id` (UUID)
- Trojan (agent protocol name `trojan`): `password` (32 random bytes, hex)
- Shadowsocks 2022 (agent protocol name `shadowsocks`): `password` (base64 key, length by `method`); removed users stay as gate-refused tombstones (removal = delta, rotation = rebuild)
- Hysteria 2 (agent protocol name `hysteria`): `auth` (32 random bytes, hex)

End-to-end scenarios (agent `TestRT_ProtocolMatrix`: real client, billing, speed limit, revocation, re-add): VLESS-REALITY-Vision, VLESS-TLS-Vision, VLESS-REALITY-XHTTP, VLESS-XHTTP, VLESS-XHTTP-TLS, VLESS-HTTPUpgrade, VLESS-HTTPUpgrade-TLS, VLESS-WS-TLS, VLESS-gRPC-TLS, VLESS-REALITY-gRPC, VMess-TCP, VMess-WS, Trojan-WS-TLS, Trojan-gRPC-TLS, SS2022-AES128, SS2022-AES256, Hysteria2.
<!-- END GENERATED protocols-matrix -->

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

**Hysteria 2** uses the node certificate like the TLS templates (automatic with 节点域名, §3f); `hysteriaSettings.auth` must not
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

**Unknown is not 0 (W23).** A value the agent cannot read (its source file missing or hidden by
the sandbox; a rate on the first heartbeat or after a counter reset) is shown as **未知** — in the
node list, on the node page and as a gap in the history charts — never as 0, and the CPU/memory
alert rules treat such minutes as undecided. Agents with the capability `metrics-presence`
(agent releases from W23 on) leave such values unset; for older agents unset still means 0.
Nodes installed with the pre-W23 unit (`ProcSubset=pid`) show CPU, memory, load, network and
sockets as 未知 together with a hint and, from the first W23 agent on, a "systemd 单元" warning:
run **重装命令** once (§5b "Units").

**Latency (Clash Verge url-test semantics).** Every 测速间隔 (系统设置 → 测速, default 5 h,
±10 % jitter) and on "立即测速" (admin node detail; at most once per 30 s per node, built in):

- the agent (capability `latency`) sends `GET` to the first test URL from its **own egress**
  (never through xray, never via `HTTP(S)_PROXY`) — delay = request start → response headers
  (DNS + TCP + TLS + first byte, a fresh connection each attempt), median of `attempts`
  (3, a failed attempt counts as the 5 s timeout; both built in); when every attempt fails
  it tries the next URL (default `https://www.gstatic.com/generate_204`, then
  `https://cp.cloudflare.com/generate_204`). Nodes need outbound HTTPS to them;
- the panel (any instance, rows claimed in the database) measures TCP connect time to each
  inbound's client-facing address (连接地址/连接端口 override, else the node address and the
  inbound port). UDP-only inbounds (Hysteria 2) show "n/a". Turn 面板 TCP 测速 off when the
  panel host must not dial nodes.

Badges: < 200 ms green, < 500 ms amber, else red, timeout grey. Users see the agent result
(online, multiplier, tags) of their visible nodes in the portal; never addresses or machine data.

The interval (600 s – 7 d), the test URLs and 面板 TCP 测速 are set in the admin console only
(系统设置 → 测速; `PUT /api/v1/settings/probe`; W25: no `[probe]` in panel.toml any more, an
old section is imported once, see §1 "Upgrading"). Every change is versioned and audited
(`settings.probe.update`), every panel instance applies it at once and re-sends the new settings
to connected agents (no restart; agents reschedule on an interval change); a shorter interval
also pulls already scheduled panel TCP tests forward. `akari settings unset probe` goes back to
the defaults above.

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

## 3f. Automatic node certificate (节点域名, W10, agent protocol 6)

Set **节点域名** on a node (wizard or node page; `tls_domain` in `POST/PATCH /api/v1/nodes`) and
every inbound reading the node certificate files gets a Let's Encrypt certificate for it, obtained
and renewed by the agent. Only nodes with such an inbound order one (a REALITY-only node never
does). What the admin does: an `A`/`AAAA` record for the domain pointing at the node (DNS only —
not Cloudflare-proxied), TCP 80 open to the internet. **检查解析** in the form (and the node page
on failures) compares what the domain resolves to with the node's public address and the address
its agent connects from; it only warns (the node's address is unknown before the install).

How the agent does it (details in akari-agent `acme.go`):

| Situation on the node | Challenge |
|---|---|
| TCP 80 not used by an inbound and free | HTTP-01 on :80 (default; the agent listens on :80 only during an order) |
| 80 used (inbound or another program), TCP 443 not used by an inbound and free | TLS-ALPN-01 on :443 |
| 80 busy and 443 used by an inbound (e.g. VLESS-WS-TLS on 443) or busy | fails as "80 端口被占用": free TCP 80 |

DNS-01 (wildcards, nodes without inbound 80/443) is not supported. After a connection or DNS
failure the next order tries the other challenge when it is available.

- **Storage**: the agent's state directory (`/var/lib/private/akari-agent/tls/<domain>/`
  `fullchain.pem` + `privkey.pem`, 0600; the ACME account key in `tls/accounts/`), not
  `/etc/akari-agent/tls`: the agent runs as a dynamic user under `ProtectSystem=strict`; systemd
  manages the state directory's ownership. Back it up with the rest of the state directory.
- **Until the first certificate** the TLS inbounds serve a self-signed placeholder (the other
  inbounds start normally); the issued certificate replaces it at once, restarting only those
  TLS inbounds.
- **Renewal** with a third of the validity left (about day 60 of 90, with jitter; ARI `replaces`).
  The files are replaced atomically and xray re-reads them within the hour (its own certificate
  reload; do not set `oneTimeLoading` in hand-written JSON): no rebuild, no dropped connection.
- **Failures** back off 5 min doubling to 6 h (at least 1 h after a rate-limit answer); one
  challenge per attempt keeps the failed validations below Let's Encrypt's 5 per hostname per
  hour. `systemctl restart akari-agent` retries at once (after fixing DNS, say).
- **Status** (node page, from the agent's heartbeat): 证书有效 + expiry and renewal date, or the
  error in plain words — 域名无法解析 / 域名未解析到本机 IP x.x.x.x / 80 端口不可达 / 80 端口被占用 /
  频率限制 / CAA / CA unreachable — with the raw ACME error under 详细错误.
- **Panel settings** (系统设置 → 节点通信): ACME 目录 (empty = Let's Encrypt
  production; staging: `https://acme-staging-v02.api.letsencrypt.org/directory`) and ACME 邮箱
  (optional account contact). A change reaches every connected node at once (a new Snapshot for
  nodes that use a node certificate). W25: `[acme]` in panel.toml is imported once, then ignored.
- **Agents older than protocol 6** ignore the domain and read the files of §3 as before; the node
  page says so (upgrade the agent, §5b). Changing 节点域名 sends the node a new configuration
  (rebuild: its connections drop once). Subscriptions use 节点域名 as server address when the
  node has no public address set.
- Not supported: ZeroSSL / EAB CAs (any CA without external account binding works through
  `directory_url`), several domains per node, DNS-01.

## 3h. 审计规则（节点拦截，W29，agent 能力 `block-rules`）

后台「审计规则」在节点上拦截指定流量（xray 路由 + `blackhole` 出站，被拦截的连接直接关闭）。规则在**面板**里编译好，agent 只把结果写进 xray 路由。

**规则**（全站共用，`GET/POST /api/v1/block-rules`、`PATCH/DELETE /api/v1/block-rules/{id}`，均需管理员，写入审计 `block_rule.*`）：

| 规则 | 内容 | 默认 |
|---|---|---|
| BitTorrent 协议识别（内置） | 按流量特征识别 BitTorrent / uTP | 开 |
| BT Tracker 域名（内置） | v2fly `category-public-tracker` | 开 |
| 迅雷 / PT 站域名（内置） | v2fly `xunlei` + `category-pt` | 关 |
| 自定义：域名 | 每行一条：`example.com`（含子域）、`full:a.example.com`（精确）、`keyword:torrent`（包含） | — |
| 自定义：IP | 每行一条：`192.0.2.0/24`、`2001:db8::/32`、单个地址 | — |
| 自定义：协议 | `bittorrent`、`http`、`tls`、`quic`（`tls` 等于拦截几乎所有 HTTPS，慎用） | — |

- 内置规则集只能开关、排序（不能改内容或删除，数据库触发器兜底）；自定义规则最多 32 条、每条最多 1000 行，不支持正则与 geosite（避免性能与依赖问题）。
- 内置列表随面板发布（`src/blockrules/lists/`，来源 [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)，MIT，版本见 `VERSION`）；更新 = 开发者运行 `scripts/update-block-lists.py [commit]` 后随新版面板发布。
- 域名规则匹配客户端请求的域名，以及嗅探出的域名（TLS SNI、HTTP Host、QUIC）；IP 规则只匹配以 IP 形式请求的目标（不为域名请求做 DNS 解析）。

**按节点开关**（`PUT /api/v1/nodes/{id}/block-rules {"enabled": true|false}`，默认关，审计 `node.block_rules.set`）：

- **关闭时**节点上没有任何额外开销：xray 配置与没有本功能时逐字节相同，不开嗅探，没有拦截出站。
- **开启时**该节点的入站开启嗅探（`routeOnly`：嗅探结果只用于路由，不改变连接目标；入站 JSON 里已经自己配置了 `sniffing` 的保持原样）。嗅探会等待客户端的第一个数据包（xray 默认最多约 300 ms），服务器先发数据的协议（如 SSH、SMTP）首包延迟会增加。
- **开关时会断开哪些连接**：只重建这个节点的入站监听（不重建 xray，其他节点不受影响，用户与计费不变）。以下是 agent 金丝雀测试（`rt_block_canary_test.go`，真实 xray 客户端逐个协议组合）实测结果：
  - **保留**：raw TCP / TLS / REALITY（含 Vision）、WebSocket、HTTPUpgrade、VMess TCP、Shadowsocks 2022、以及 TLS/REALITY 上的 XHTTP（一条长 HTTP/2 请求）。
  - **断开一次、客户端自动重连**：gRPC（流属于监听端的 HTTP/2 服务）、明文 HTTP 上的 XHTTP（客户端 packet-up 模式，每次上传都是新请求）、Hysteria 2（QUIC 连接属于监听端）。
- **修改规则内容**（增删改规则、开关某个规则集）**不断开任何连接**：agent 原子替换整套路由规则，不重建入站、不重建 xray。规则只作用于新建立的连接（路由在每次分发时决定）：已经建立的连接即使命中新规则也继续转发，直到客户端重连。
- agent 版本过旧（没有 `block-rules` 能力）时开关无效，`GET /api/v1/nodes/{id}/block-rules` 的 `agent_supported` 为 false。

**统计**：`GET /api/v1/nodes/{id}/block-rules?days=7`（1–90）返回开关状态、agent 是否支持、当前生效的规则版本是否与面板一致（`in_sync`、`error`）、以及最近 N 天（UTC）每条规则的拦截次数；规则列表里的 `hits_7d` 是全部节点近 7 天合计。**只记录每个节点每条规则的拦截次数，不记录任何用户或访问目标。**日数据保留 90 天。

## 3c. Resource footprint (measured)

One real deployment on a 1 vCPU-class VPS with 920 MB RAM (Debian 13, compose, IP-only), resident
memory at idle: panel 5 MB, PostgreSQL 56 MB, Valkey 8 MB, Caddy 17 MB, agent 27 MB. The whole
stack plus an agent fits a 1 GB machine with room to spare. The first full deployment from this
guide took about 23 minutes including troubleshooting.

**Timed fresh-deploy drill (2026-10-02, W14).** Clean Debian 13 machines (systemd containers: a
panel host with Docker installed from Debian's packages, a node, a client), §A → §2 → §2b → §3 →
§3g followed literally, the image pulled by digest from a registry (a stand-in for ghcr.io before
the first release), `myapp.test` with `AKARI_CADDY_OPTIONS=local_certs`. Machine time per step;
"reading and typing" is an estimate for a person doing the same by hand and in the console.

| Step | Machine | Reading and typing |
|---|---|---|
| 0. install Docker + git (`apt-get`) | 22 s | 2 min |
| 1–3. clone, env files, passwords, domain, image line | 2 s | 6 min |
| 4. `config check` (pulls panel, PostgreSQL, Valkey images) | 39 s | 1 min |
| 4. `up -d postgres valkey panel`, `akari info`, prefix into `.env` | 4 s | 1 min |
| 4. `up -d` (Caddy pull + certificate), `/healthz` 200 | 49 s | 2 min |
| §2 first admin, log in | 1 s | 2 min |
| §2b 主域名 | 1 s | 1 min |
| §3 新建节点 (REALITY template) → pinned install command | 1 s | 3 min |
| §3 install command on the node → SUCCESS, node online | 7 s | 2 min |
| §3g node group, plan, user, assign plan | 1 s | 4 min |
| §3g subscription into a client (xray 26.3.27), connect, usage billed | 5 s + 15 s | 3 min |
| **Total** | **~2.5 min** | **~27 min** |

Through the node the client fetched `https://www.gstatic.com/generate_204` (204) and 5 MB, which
appeared on the user as 5.02 MB within 15 s. Gaps the drill found are fixed in this section (Docker
install, password/domain/prefix commands, the `config check` notice on an empty database, names
without public DNS, §2b, §3g) and in the compose file (Debian's compose 2.26 rejected a nested
`${VAR:?}`).

## 4. Observability (optional)

Set `[metrics] bind = "127.0.0.1:9100"` and scrape it (`deploy/prometheus/`). Alert rules:
`deploy/prometheus/alerts.yml` (unit tests in `alerts_test.yml`; `make monitoring-check` runs
promtool and checks that every dashboard/rule metric exists); dashboards:
`deploy/grafana/akari-dashboard.json` (panel internals) and `deploy/grafana/akari-fleet.json`
(W17: fleet health from the W11 heartbeats and the node alerts) — import in Grafana, pick the
Prometheus data source. Metric labels never contain the route prefix or a node id: per-node
detail is the console's node page and 告警中心 (§4b).
Every response of an accepted request carries `X-Request-Id` (an incoming one is reused if it is
short and printable); it is on the log lines of that request. Rejections never carry it.

## 4a. 系统状态（W31）

后台 `GET /api/v1/system/status`（仅管理员，结果缓存 5 秒）一次给出：

- **面板实例**：每个实例每 10 秒把自己的心跳写进 Valkey（`akari:status:instances`，实例 id →
  主机 CPU/内存/负载/数据目录磁盘、进程内存、版本、持有的 agent 连接数、数据库连接池、后台任务统计）。
  30 秒没有心跳 = 离线，24 小时后自动移除。多实例部署时任一实例都能给出全部实例的状态。
- **PostgreSQL**：版本、是否只读副本、连接数 / `max_connections`、库大小、往返延迟。
- **Valkey**：版本、内存、客户端数、运行时长、往返延迟。
- **Caddy（反向代理）**：经系统设置的主域名探测（TCP → TLS（证书到期时间）→ `HEAD /`，任何 HTTP
  回答即视为在线）；未设置主域名时显示「未配置」。
- **后台任务**：结算（流量入账，5 秒）、对账（支付订单，10 秒）、邮件队列（2 秒）、告警评估（30 秒）
  各自的最近一次运行、耗时、距上次成功的延迟（`lag_secs`）、超过 6 个周期没有成功 = `stale`、最近
  错误（已去掉邮箱地址），以及积压：待发/到期/最老到期邮件、死信数、待付订单数、待投递告警数。

各项检查并发执行、每项最多 3 秒，不读写 agent 路径；读不到的值为 `null`（未知），不当作 0。

## 4b. Node alerts and notifications (告警中心, W17)

The panel watches the fleet itself; Prometheus is optional. Console → **告警** shows what is
firing (and history), the thresholds and the notification channels. Defaults: on, offline >
300 s, CPU / memory > 90 % for 5 minutes, disk > 90 %, a certificate (the node's automatic TLS
certificate, W10, or the agent's mTLS certificate) expiring within 14 days, every latency-test
target of a source failing, a failed config apply. An empty threshold turns a rule off; the node
page (告警规则) overrides thresholds per node, turns kinds off, or mutes the node (alerts are
recorded, never notified).

- **One evaluator**: every instance runs the round every 30 s (built in) but only the one that wins a PostgreSQL advisory lock evaluates; the others skip.
  Facts come from the database and Valkey, so any instance computes the same thing.
- **State**: firing → resolved per (node, kind), at most one firing row (dedupe). Live kinds (CPU,
  memory, disk, latency, node certificate) of an offline node keep their state until it reports
  again. CPU/memory fire when each of the last N complete minutes averaged above the threshold and
  clear as soon as the last minute is at or below it. A re-fire within `重复告警冷却` minutes of
  the last notified one is recorded but not notified; "恢复" is notified only after a notified
  firing (optional).
- **Delivery**: one queued notification per channel, delivered by any instance (claim + lease),
  retried with backoff (30 s doubling, 8 attempts), then marked failed in 通知记录 (retry button).
  At-least-once: a receiver may see a delivery twice after a crash; dedupe on
  `X-Akari-Delivery`.

**Telegram**: create a bot with @BotFather, add it to the group/channel, enter the bot token and
the chat id (a number, groups and channels are negative, or `@channelname`), save, then 发送测试.
The panel only calls `sendMessage` (outbound HTTPS to api.telegram.org; nothing to open
inbound). The token is stored encrypted with a key derived from `data/master.key` and never shown
again (losing `master.key` means entering it again). For networks that block Telegram, set
**Telegram API 地址** (系统设置 → 告警) to a self-hosted Bot API server (https; origin only; empty =
`https://api.telegram.org`). W25: the old `[alerts] telegram_api_url` is imported there once.

**Webhook**: `POST <url>` (https; plain http only to localhost), JSON body:

```json
{"event": "firing", "title": "[告警] hk-1：节点离线", "text": "…",
 "alert": {"id": 7, "node_id": "…", "node_name": "hk-1", "kind": "offline",
           "value": "离线 6 分钟", "detail": "…", "fired_at": "…", "resolved_at": null}}
```

`event` is `firing`, `resolved` or `test` (`alert` is null for a test). Headers:
`X-Akari-Event`, `X-Akari-Delivery` (notification id), `X-Akari-Timestamp` (unix seconds) and
`X-Akari-Signature: sha256=<hex>` = HMAC-SHA256(secret, `<timestamp>.<raw body>`). Verify it
before trusting the body and reject stale timestamps:

```python
import hashlib, hmac, time
def verify(secret: bytes, headers, body: bytes) -> bool:
    ts = headers["X-Akari-Timestamp"]
    want = "sha256=" + hmac.new(secret, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, headers["X-Akari-Signature"]) and abs(time.time() - int(ts)) < 300
```

Any 2xx is success; 408/429/5xx and network errors are retried; other 4xx are final.

**Email**: goes through the panel's SMTP outbox (系统设置 → 邮件, W15) to up to 5 addresses;
the channel can be enabled once SMTP is configured.

**Prometheus**: `akari_node_alerts_firing{kind}` (from the database: the same on every
instance, aggregate with `max`), `akari_alert_notifications_total{channel,result}`,
`akari_alert_rounds_total{result}`; rules `AkariNodeAlertsFiring`, `AkariAlertEvaluatorStalled`,
`AkariAlertNotificationsFailing` and the fleet rules (`AkariFleet*`) in `alerts.yml`.

**Support tickets (工单)**: customers open tickets in the portal (also while expired or over
quota), staff answer in console → 工单 (filters, assign, close/reopen). A customer can open at
most 5 tickets per hour and keep at most 5 open; replies 30 per hour. Email notices for new
tickets and staff replies use the SMTP outbox when configured.

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
  `data_dir` (CA, `jwt.key`, `master.key`, route prefix: share the directory or
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

### v0.3.x → v0.4: fresh install only

v0.4 squashed migrations 0001–0168 into a single baseline, `migrations/1000_baseline.sql`
(same schema; research/db-schema-review.md §7). A database created by v0.3.x cannot be upgraded in
place:

- `akari-ctl upgrade` from a v0.3.x installation stops **before anything is changed** (no backup,
  no switch) with `database from v0.3.x — fresh install required; see docs/DEPLOY.md`;
- the panel itself refuses to start on such a database (`db::migrate`: any `_sqlx_migrations`
  version below 1000) with the same message — this also covers a hand-made deployment, a kept
  data volume and a restored backup;
- **backups made by v0.3.x cannot be restored into v0.4** (`install --restore` stops with the same
  message after loading one).

So: write down what you need (settings, plans, users), `akari-ctl uninstall --purge --confirm
purge` (backups under `/var/backups/akari` are kept, but are v0.3-only), install v0.4 fresh, and
re-enroll the nodes (重装命令). Upgrades between v0.4 releases work as below.

**With the installer** (any installation made by it, or a §A compose checkout under
`/opt/akari-panel/deploy` or `/opt/akari`, which it adopts):

```bash
akari-ctl upgrade                    # the newest release; --version vX.Y.Z for a given one
```

It runs the target release's own installer (newer upgrade logic), verifies the release exactly as
an install does (cosign + SHA256SUMS), then:

1. **backup** (`/var/backups/akari/akari-<UTC>/`: database dump, data dir, configuration;
   age-encrypted when `AGE_RECIPIENT` is set in `/etc/akari/install.env`, otherwise plain 0600
   files with a warning — docs/BACKUP.md);
2. bare metal: the new binary must pass `config check` against the live configuration before
   anything is switched; the old one is kept as `/usr/local/bin/akari.prev`, the new one moved in
   atomically, units and Caddyfile refreshed from the release's bundle, `systemctl restart`;
   Docker: compose file/Caddyfile refreshed, `AKARI_IMAGE` set to the new `tag@digest`,
   `docker compose pull panel` + `up -d` (PostgreSQL/Valkey/Caddy follow their major tags);
3. **health check**: `/<prefix>/healthz` within 2 minutes (3 with Docker). Migrations run at start,
   before the panel listens, so a healthy panel is a migrated one;
4. failure → **automatic rollback** to the previous binary / image (and compose files), health
   checked again. `akari-ctl`/backup scripts are replaced only after a successful upgrade.

Migrations are forward-only: when the failed release already migrated the database, the old
release refuses the newer schema and the rollback cannot become healthy; the installer says so and
names the pre-upgrade backup to restore (§6). Agents first (below) is still the rule.

**By hand** (Appendix A/B installations):

1. Read the release notes for protocol changes. Take a backup (docs/BACKUP.md).
2. Upgrade every agent (replace the binary, `systemctl restart akari-agent`; the xray rebuild drops live connections once).
3. Upgrade the panel: compose: verify the new release and set its `AKARI_IMAGE=ghcr.io/akari-projectx/akari-panel:X.Y.Z@sha256:…` line in `.env` ("Verify a release" step 3), then `docker compose pull panel && docker compose up -d panel` (a `.env` from before 0.2 with only `AKARI_VERSION=` still works, unpinned: replace it with `AKARI_IMAGE`); bare metal replace the binary, `systemctl restart akari-panel`. Migrations run automatically at start.
4. `akari config check`, `/healthz`, check the nodes are `online`.

**Compose deployments: the deploy files change too.** The checkout under `deploy/` (compose file,
Caddyfile) is part of the release. panel.toml keeps only the start-up keys (W25); everything
else lives in 系统设置, so a new release never needs a new panel.toml section, and obsolete keys
are imported once and then only warned about (§1 "Upgrading: obsolete keys").
Per upgrade:

```bash
cd /opt/akari-panel && git status --short       # local edits to tracked files (e.g. the Caddyfile)?
git checkout deploy/caddy/Caddyfile             # only after saving anything you still need
git pull --ff-only
cd deploy && docker compose run --rm panel config check   # lists obsolete keys to delete
docker compose up -d --force-recreate           # Caddyfile is a single-file bind mount (§A)
```

Since the 系统设置 release (R22) the compose stack needs `[tls_ask]` in panel.toml (`bind =
"0.0.0.0:8082"`, `allow_non_loopback = true`, see `panel.toml.compose.example`) and the
`AKARI_ASK` variable the new compose file passes to Caddy; without the section the panel never
answers Caddy's `ask`, so domains saved in 系统设置 get no certificate (AKARI_DOMAIN itself is
unaffected). `config check` run before the new version has started once may end with
`# 系统设置: database not readable (… relation "panel_settings" does not exist …)` or, on an
upgrade, `(… column "<name>" does not exist …)` (0.2 → 0.3: `probe_interval_secs`): the
migrations have not run yet; it is harmless and gone after the first start. The verdict line
above it (`configuration OK (0 warnings)`) is what counts.

**Nodes installed before the updater units (W18; agents up to v0.4.0) — once, by hand.** The
self-update of those agents executes the new binary from its StateDirectory, which systemd ≥ 256
(Debian 13 ships 257) mounts `noexec` for `DynamicUser` services: the update fails with
`switch to vX: permission denied` (the rollout shows the reason and the fix; the node view warns
for every agent without the `updater` capability). Run the node's **重装命令** once (upload the
current release under **Updates** first): it installs the current agent and the updater units
(`akari-agent-update.path/.service`) in place, keeping inbounds, users and traffic; from then on
updates go through the panel. Agents installed by hand need the two unit files too
(`akari-agent -print-unit akari-agent-update.path` / `akari-agent-update.service`, §3 manual
path); without them a current agent refuses offers with "updater unit missing".

**Nodes whose units predate W23 (agents up to v0.4.x) — once, by hand.** Unit files used to
change only with a reinstall; from W23 on every update installs the new release's units (§5b
"Units"). The updater that does this is the node's *installed* updater unit, and the pre-W23
`akari-agent-update.service` has `/etc/systemd/system` read-only: an update to a W23 release
still goes through (binary yes, units no — `systemd units NOT refreshed` in
`journalctl -u akari-agent-update`), and the new agent then reports the stale units (node
warning "systemd 单元…重装命令"; until then its machine status shows 未知 for CPU, memory, load
and network, §3e). Run the node's **重装命令** once (after uploading the release under
**Updates**); from then on units follow the releases with no manual step. There is no way around
this one step: the old updater unit's own sandbox is what forbids the write, and nothing the new
release ships runs outside it before that reinstall.

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

**Panel side.** The official keys of `release-keys.txt` are compiled into the panel too (a copy
in `src/release-keys.txt`; CI fails when it differs from akari-agent main), so uploads are checked
early with no configuration. Keys you sign your own builds with go to 系统设置 → 安全 → 额外信任的
发布公钥 (one `<base64> [label]` line each, at most 16) — agents still only run what their own
compiled keys accept. W25: `[updates] release_keys` is imported once into that list when it
differs from the official set; `max_concurrent_downloads` is built in (8 FetchArtifact streams
per instance).

**Check for updates (one click).** Updates view → 「检查更新」: the panel fetches the latest
release of `akari-projectX/akari-agent` from the GitHub API, downloads for **each linux platform
(amd64, arm64)** the binary, its `.manifest.json` and `.manifest.sig`, plus `SHA256SUMS`, and checks
the manifest signature under the trusted keys (official + extra), every file against `SHA256SUMS`, the platform,
version = tag, size, and that it is not a rollback manifest. Then it stores the release exactly as a
manual upload does (same code, manifest bytes verbatim, `agent_release.create`/`.upload` audit
rows), all platforms in one transaction: any failure stores nothing and the reason (a coded error,
shown in Chinese) is kept as "上次检查". It never starts a rollout; use the rollout form below.
- **Source** (发布源): default `https://api.github.com/repos/akari-projectX/akari-agent/releases/latest`;
  a compatible mirror can be set in the same card (stored in the database, no panel.toml key). The
  panel contacts only that host (for api.github.com also GitHub's download hosts `github.com`,
  `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, where asset downloads
  redirect), over HTTPS (plain http only for loopback), directly (no HTTP proxy support): allow
  outbound 443 to them. Responses are size-capped and time out; the whole check is bounded at 15 min.
- **No downgrade:** if the source's latest version is older than the newest release the panel already
  holds, the check refuses (`agent_update.downgrade`). A signed rollback stays a manual upload.
- **自动检查** (off by default): every 6 h one panel instance checks the same way (audit actor
  `system`). Only one check runs at a time across instances (advisory lock): a second click gets
  "已有更新检查在进行中".
- The node list and the dashboard show **「有新版本 vX」** when the newest complete release is newer
  than what some updatable node (protocol ≥ 3, platform covered) runs.
- API: `GET /api/v1/agent-updates` (settings, last check, newest release, outdated node count),
  `PUT /api/v1/agent-updates/settings {version, source_url|null, auto_check}`,
  `POST /api/v1/agent-updates/check` (202; poll the GET for `last_check`).

**Publish a release by hand** (advanced; Updates view, or the API): upload `akari-agent-linux-<arch>` with its
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

**On the node** (W18; the installer sets this up, §3 — nodes installed earlier: run their
**重装命令** once, §5). The agent runs as a throw-away user and its StateDirectory is mounted
`noexec` by systemd; that stays so (nothing the agent can write is ever executed). Updates go
through a separate root unit that only ever runs the **installed** binary:
- the agent downloads into `$STATE_DIRECTORY/update/staged` (0600, never executable), checks
  size, SHA-256, signature and version policy, stops xray (live connections drop once, as with
  any restart), persists its final traffic counters (`update/finals.json`, resent by the next
  process), sends `RESTARTING` and writes `update/apply-request.json`;
- `akari-agent-update.path` starts `akari-agent-update.service` (root, no network,
  `ProtectSystem=strict` with only `/usr/local/bin`, `/etc/systemd/system` (W23) and the agent's
  state writable), which runs
  `/usr/local/bin/akari-agent -apply-update /var/lib/private/akari-agent`. It treats the agent's
  directory as untrusted (no symlink is followed; only regular, single-link files owned by the
  agent), copies the staged binary into a root-only file next to `/usr/local/bin/akari-agent`,
  verifies **that copy** with the release keys compiled into **itself** (signature, platform,
  newer version or signed rollback, never a version this node rolled back from — its own record
  in `/var/lib/akari-agent-update`), keeps the running binary as `akari-agent.prev`, renames the
  new one into place, installs the new release's units (below) and restarts `akari-agent`. A
  refusal goes back to the agent, which reports it (`FAILED`) and keeps running;
- the new binary is on probation: it must connect and get an apply acknowledged within
  `-update-self-check` (default 5 min); the updater watches it and puts `akari-agent.prev` back
  (and restarts the agent) when it crashes `-update-max-boots` times (default 3) or does not
  pass in time (together with the previous units). The version is then marked failed on that
  node and reported (`ROLLED_BACK`), which fails the node in the rollout;
- **Units (W23).** Each release carries its systemd units (compiled in; `akari-agent -print-unit
  <name>`). After verifying the copy, the updater runs it with `-print-units` (no network, empty
  environment, 30 s, bounded output — the binary it is about to install anyway, never anything
  from the agent's directory) and replaces `akari-agent.service`, `akari-agent-update.service`
  and `akari-agent-update.path` in `/etc/systemd/system` — only those names, only where they
  exist, only when they differ — atomically (root, 0644), keeping the replaced ones in
  `/var/lib/akari-agent-update/units.prev/`, then `systemctl daemon-reload`. A rollback puts
  them back (and reloads). Drop-ins (`akari-agent.service.d/`, e.g. the installer's TLS
  credential drop-in) are never touched: put local changes there. A release whose units cannot
  be read is refused. An updater unit from before W23 cannot write the directory: see §5
  "Nodes whose units predate W23";
- `journalctl -u akari-agent-update` shows what the updater did; installing a newer agent by
  hand (or 重装命令) wins over everything the updater recorded;
- **Alpine / OpenRC (W32)**: the same hand-over, with the `akari-agent-update` service (a root
  loop that checks for the request once a second) instead of the path unit, the two init scripts
  instead of the three units, and supervise-daemon's respawn counter instead of `NRestarts`;
  differences and gaps (no updater sandbox) in §3h; log `/var/log/akari-agent-update.log`;
- `akari-agent -release-keys` prints the pinned keys ("no release keys pinned" = self-update off).

## 6. Rollback

Agents are backward-tolerant, so roll back the **panel** first. `akari-ctl upgrade` does this by
itself when the new release fails its health check (§5). By hand, or after a "successful" upgrade
you want to undo:

- **No migration ran** (same schema): bare metal `mv /usr/local/bin/akari.prev /usr/local/bin/akari
  && systemctl restart akari-panel`; Docker: put the previous `AKARI_IMAGE` line back in `.env`,
  `docker compose up -d panel` (or `akari-ctl upgrade --version <previous> --force`).
- **A migration ran**: migrations are forward-only, the old binary refuses the newer schema.
  Restore the pre-upgrade backup together with the old binary/image: stop the panel, restore
  (docs/BACKUP.md "Restore"; `AKARI_PG_RESTORE_CMD`/`AKARI_DATA_DIR` as in the installer: bare
  metal `runuser -u postgres -- pg_restore -p <port> -d akari --clean --if-exists --no-owner
  --role=akari --single-transaction`, data dir `/var/lib/akari`; Docker `docker compose exec -T
  postgres pg_restore -U akari -d akari --clean --if-exists --no-owner --single-transaction`, data
  dir = the `akari_akari-data` volume's mountpoint), start the old release. Traffic counted since
  the backup is lost; everything else is as of the backup.

A restored database with the old `data/` keeps the same route prefix and agent certificates.

## 7. Uninstall

```bash
akari-ctl uninstall                  # services/units/containers go; data and configuration stay
akari-ctl uninstall --purge          # also database, data dir, configuration: type "purge" to confirm
                                     # (non-interactive: --yes --purge --confirm purge)
```

Plain uninstall keeps: bare metal `/var/lib/akari` (prefix, CA key, jwt.key, master.key),
`/etc/akari/panel.toml`, the PostgreSQL database `akari`; Docker `/opt/akari` and the `akari_*`
volumes. Running the installer again picks them up (same prefix, same accounts). Caddy is stopped
when the installer installed it, and given back its previous configuration when it was there
before. `--purge` drops the database and role, the data dir, `/etc/akari`, Valkey and (Docker) the
volumes; packages (postgresql-18, caddy, Docker) stay installed (`apt purge` them if wanted), and
**backups in `/var/backups/akari` are never deleted**. After a purge every node needs a new
enrollment (the CA is gone) unless you restore a backup.

## 8. Migration

### Same host: bare metal ⇄ Docker

```bash
akari-ctl migrate --to docker        # or --to bare
```

Takes a safety backup (kept, encrypted if configured) and a plain dump for the move (in a 0700
temporary directory, deleted afterwards), stops the current services, installs the other mode with
**restore** (database via `pg_restore --single-transaction`, the data dir — route prefix, CA,
`jwt.key`, `master.key` — copied with its ownership), waits for health, then retires the old services
(their data stays until you delete it: bare metal `/var/lib/akari`, database `akari`; Docker the
`akari_*` volumes). New database/Valkey passwords are generated; 系统设置 (domains, payment
methods…) live in the database and move with it. Any failure brings the old mode back. The panel is
down for the move (a minute or two; agents keep serving users and reconnect by themselves).

### Host to host

```bash
# old host
akari-ctl backup --out /root/move                           # age: --age-recipient age1... (recommended)
scp -r /root/move/akari-<UTC> new-host:/root/
# new host (fresh Debian/Ubuntu)
curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh \
  | sh -s -- --restore /root/akari-<UTC> [--age-identity backup.key] [--mode docker|bare] [--domain …]
```

The new host gets the same route prefix, CA and keys, so **existing agents and subscription links
keep working** once their names point at the new host:

1. Lower the DNS TTL of the main/subscription/node domains a day before (60–300 s).
2. Stop the old panel right before the final backup (`systemctl stop akari-panel` /
   `docker compose stop panel`), so no traffic is counted after it (agents keep their counters
   and report them to the new panel).
3. Restore on the new host, then switch the A/AAAA records of 主域名, 订阅域名 and 节点通信域名.
   Agents dial the node domain: they reconnect to the new host as soon as their resolver sees the
   new address (the node's own certificate pin is the panel CA, which moved with the data dir).
   Agents enrolled against an **IP address** keep dialing that IP: re-enroll them (重装命令) or keep
   the old address routed to the new host.
4. Verify on the new host: `akari-ctl status` (healthz), log in, the nodes turn **online**, fetch
   a subscription link.
5. Decommission the old host only then (`akari-ctl uninstall --purge`).

Caddy obtains new certificates on the new host (the main domain at start, the others on demand).

## Installer tests (CI)

`.github/workflows/ci.yml`, jobs `installer-*`, scripts in `scripts/installer-test/`. On pull
requests they run when the installer, the deploy bundle, backup/restore or the Dockerfile change
(`scripts/ci-changes.sh` group `installer`) or with the `full-ci` label; always on main, nightly
and before a release.

- `installer (build)`: the PR's static binary and image, made like a release, versioned
  `<version>-ci.<run>`; `make-release.sh` turns them into a local release (GitHub layout, signed
  with a throwaway cosign key; plus a deliberately broken release `v9.9.9`).
- `installer (bare, debian:13 / ubuntu:24.04)` — `bare-e2e.sh` in a fresh systemd container: the
  latest published release (v0.3.x) installed from GitHub (real keyless verification), its
  upgrade to the PR build is refused untouched (v0.4 baseline) → purge → fresh
  install of the PR build → healthz through Caddy (`myapp.test` with `local_certs`, resp. IP-only),
  admin login over the API, a user and its subscription → the broken release rolls back → uninstall keeps data,
  reinstall keeps prefix/password/subscription → age-encrypted backup → `--purge` → install
  `--restore` from that backup (host move).
- `installer (host, docker + migration)` — `host-e2e.sh` on the runner: Docker install of the latest
  release (ghcr image) → its upgrade to the PR image refused untouched → purge → Docker install of
  the PR image (local registry, pinned by digest) → purge; bare
  install of the PR build, a real agent (`../akari-agent`) enrolled, `migrate --to docker` and back
  `--to bare`: same prefix, the agent reconnects without re-enrolling, the subscription still answers.
- `shellcheck` — `make shellcheck` (also part of `make check`).

Locally: `scripts/installer-test/bare-e2e.sh debian:13 <releases> <tag> v9.9.9 [<previous>]` needs
Docker with privileged containers (`EXTRA_CA=<bundle>` behind a TLS-intercepting proxy).

## Verify a release

Releases are signed keylessly (GitHub OIDC, Sigstore; there is no project key to lose): each
signature's certificate names the workflow file **and the tag** that produced it, so verify against
that exact identity. Needs **cosign >= 3** (`cosign version`; 2.4.x works for blobs only with
`--new-bundle-format`, older 2.x cannot read the bundles). The release workflow runs these same
commands against what it has just signed before it publishes.

```bash
TAG=v0.3.2
ID="https://github.com/akari-projectX/akari-panel/.github/workflows/release.yml@refs/tags/$TAG"
ISS=https://token.actions.githubusercontent.com
REL="https://github.com/akari-projectX/akari-panel/releases/download/$TAG"

# 1. the release assets (binaries, SBOM, licence notice, image reference)
for f in SHA256SUMS akari-panel-image.txt akari-linux-amd64; do
  curl -fsSLO "$REL/$f" && curl -fsSLO "$REL/$f.sigstore.json"
  cosign verify-blob --bundle "$f.sigstore.json" --certificate-identity "$ID" \
    --certificate-oidc-issuer "$ISS" "$f"                     # "Verified OK"
done
sha256sum -c --ignore-missing SHA256SUMS                       # every downloaded file: OK

# 2. the image, by digest (akari-panel-image.txt = ghcr.io/akari-projectx/akari-panel:X.Y.Z@sha256:...)
IMAGE_REF="$(cat akari-panel-image.txt)"
DIGEST="${IMAGE_REF#*@}"
cosign verify "ghcr.io/akari-projectx/akari-panel@$DIGEST" \
  --certificate-identity "$ID" --certificate-oidc-issuer "$ISS" >/dev/null && echo "image signature OK"
cosign verify-attestation --type cyclonedx "ghcr.io/akari-projectx/akari-panel@$DIGEST" \
  --certificate-identity "$ID" --certificate-oidc-issuer "$ISS" >/dev/null && echo "SBOM attestation OK"

# 3. pin it (compose pulls by digest: a moved tag cannot change what runs)
sed -i "s|^AKARI_IMAGE=.*|AKARI_IMAGE=$IMAGE_REF|" deploy/.env    # from the checkout root
```

The same reference is at the top of the GitHub release notes. `docker compose pull` then fetches
exactly that digest for your architecture (the image is a multi-arch index: linux/amd64 and
linux/arm64). Agent releases: replace `akari-panel` by `akari-agent` in `ID`/`REL` and use its
`akari-agent-linux-<arch>` files (it publishes binaries only). The SBOM (CycloneDX) is a release
asset and an attestation on the image; `THIRD_PARTY_LICENSES.txt` lists every bundled crate and
npm package with its licence text.

### Build the image yourself (fallback)

Without access to ghcr.io, or to run an unreleased commit, build the same image from the checkout
(about 10 minutes on 4 cores; Docker with BuildKit, nothing else needed) and point compose at it:

```bash
cd /opt/akari-panel && git checkout v0.3.2                  # the release you want
docker build -t akari-panel:local --build-arg AKARI_GIT_SHA="$(git rev-parse --short=12 HEAD)" .
sed -i 's|^AKARI_IMAGE=.*|AKARI_IMAGE=akari-panel:local|' deploy/.env
cd deploy && docker compose up -d                           # skip `docker compose pull` for a local image
```

Upgrading such a deployment = check out the new tag, rebuild, `docker compose up -d`.

## Build notes

The binary is a static musl build (`rust:alpine`; ring/rustls/sqlx need no system library):
it runs on any Linux kernel, in distroless/scratch, and needs no glibc on the VPS. musl's own
allocator serializes this allocation-heavy multi-threaded workload, so the binary uses mimalloc
(M2). `akari --version` prints version and git sha.

## Appendix A. Docker Compose by hand

What the installer does in Docker mode, step by step (another distribution, an existing Docker
host, or to see every step).


Commands run as root on the panel host. This section, §2, §2b, §3 and §3g take a clean Debian 13
machine to a user's proxied connection through a new node (timed drill: §3c).

```bash
# 0. Docker Engine + compose v2 (Debian 13 packages; Docker's own apt repository works the same)
apt-get update && apt-get install -y docker.io docker-compose git
docker compose version                                 # v2.x

# 1. the deploy files of the release you install (the tag matches the image in step 3)
git clone -b v0.3.2 https://github.com/akari-projectX/akari-panel /opt/akari-panel
cd /opt/akari-panel/deploy
cp .env.example .env
for f in env/*.example; do cp "$f" "${f%.example}"; done
chmod 600 env/*.env

# 2. passwords (database, Valkey): random, the same value in panel.env and the service's file
DBPW=$(tr -dc a-z0-9 </dev/urandom | head -c 32); VKPW=$(tr -dc a-z0-9 </dev/urandom | head -c 32)
sed -i "s/CHANGE-ME-db/$DBPW/" env/panel.env env/postgres.env
sed -i "s/CHANGE-ME-valkey/$VKPW/" env/panel.env env/valkey.env

# 3. your domain, and the image: the tag@digest line from the release notes, verified first
#    ("Verify a release" below)
cp panel.toml.compose.example panel.toml            # no names in it: domains are set in 系统设置
sed -i 's/panel.example.com/panel.yourdomain.com/g' .env
sed -i 's|^AKARI_IMAGE=.*|AKARI_IMAGE=ghcr.io/akari-projectx/akari-panel:0.3.2@sha256:<digest>|' .env

# 4. check, start, read the route prefix
docker compose run --rm panel config check             # last line: "configuration OK (0 warnings)"
docker compose up -d postgres valkey panel
docker compose exec panel /akari info                  # route prefix: /<prefix>
sed -i "s|^AKARI_PREFIX=.*|AKARI_PREFIX=<prefix without the slash>|" .env
docker compose up -d                                   # Caddy: certificate, forwards /<prefix>/* only
curl -s -o /dev/null -w '%{http_code}\n' https://panel.yourdomain.com/<prefix>/healthz   # 200
```

The compose file sets `AKARI_CONFIG=/etc/akari/panel.toml` on the panel service, so every
`/akari ...` you run through `docker compose run` or `exec` reads your `panel.toml` (these
commands replace the service's `command:`, which is why the path is an environment variable and
not a `-c` flag). `config check` prints the effective values (listeners, redacted URLs) and then
`configuration OK`. On a fresh install its output also
ends with `# 系统设置: database not readable (... relation "panel_settings" does not exist ...)`:
the database is still empty; that line disappears once the panel has started. The image itself
sets no default `AKARI_CONFIG`: a bare `docker run` of it uses built-in defaults. Outside compose
use `-c <file>` or export `AKARI_CONFIG`.

Caddy obtains the certificate for `AKARI_DOMAIN` at its first start (`docker compose logs caddy`:
"certificate obtained successfully"; the DNS record must already point at the host and ports
80/443 must be open); domains added later in 系统设置 get theirs on demand (§1b).

**A name without public DNS** (a test or LAN name such as `myapp.test`): Let's Encrypt cannot
issue for it (`rejectedIdentifier` in Caddy's log). Set `AKARI_CADDY_OPTIONS=local_certs` in `.env`
and `docker compose up -d --force-recreate caddy`: every certificate then comes from Caddy's
internal CA (as for an IP, below). The node installer pins that certificate (§3): the panel
probes its own address for it, so the panel container must resolve the name too (your LAN DNS,
or a `docker-compose.override.yml` with `services: {panel: {extra_hosts: ["myapp.test:<host IP>"]}}`);
when it cannot, the install command comes with the warning "could not check the TLS certificate"
and fails on the node with a certificate error.

**IP-only deployments (no domain).** With `AKARI_DOMAIN` set to an IP address, Caddy issues the
certificate from its own internal CA, which no browser or client trusts. That is fine to try the
admin UI (accept the browser warning once), but subscription clients and browsers will refuse it:
use a real domain (an A record to the VPS, ports 80/443 open) so Caddy obtains a certificate by
ACME. The Caddyfile sets `default_sni` to `AKARI_DOMAIN` because clients send no SNI for an IP
address. The agent's gRPC channel is unaffected: it pins the panel CA, not the web certificate,
and the one-line node installer pins the web certificate's key (§3).

**Moving an IP-only deployment to a domain** (verified 2026-10-02; W25: no panel.toml change):
add the A record (no proxying CDN; ports 80/443 open), set `AKARI_DOMAIN` in `.env`,
`docker compose up -d` (Caddy obtains the certificate within seconds; `docker compose logs caddy`
shows "certificate obtained successfully"), then in 系统设置 set **主域名** to the name (install
commands become plain `curl`, no pin) and, if agents should dial the name from now on, **节点通信域名**.
Agents enrolled earlier keep dialing the IP with the IP as gRPC server name (their bootstrap file
says so): the IP stays in the certificate's name list (节点通信证书域名) until you remove it there,
so nothing strands them. Restart one agent to confirm it reconnects. Any other host name now gets
the same empty 404.

The Caddyfile is bind-mounted as a single file: `git pull`/`git checkout` replace the file (new
inode) and the running container keeps the old one, so `caddy reload` changes nothing. After
updating the checkout run `docker compose up -d --force-recreate caddy`.

Notes: the image is distroless (no shell; `exec panel /akari ...` works because it runs the
binary directly), runs as UID 65532, state lives in the `akari-data` volume (`/data`).
There is no container HEALTHCHECK; probe `https://panel.example.com/<prefix>/healthz`
from your monitoring. The compose `frontend` subnet is fixed (172.28.0.0/24) so that
`web.trusted_proxies` can name it.

## Appendix B. Bare metal by hand

What the installer does in bare-metal mode, by hand (another distribution, an existing PostgreSQL
≥ 18 / Valkey ≥ 9, nginx instead of Caddy). The installer's choices are a reference: PostgreSQL 18
from PGDG, Valkey from `deploy/systemd/akari-valkey.service` (upstream build, loopback, password in
a credential file), Caddy with `/etc/akari/caddy.env` as `EnvironmentFile` and no `--environ`.


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
