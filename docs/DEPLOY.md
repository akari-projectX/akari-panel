# Deploying Akari（部署 Akari）

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
| 节点通信地址 | 主域名（仅 IP 安装 = 本机 IP） | **只在主域名解析到 Cloudflare（橙色云）时询问**：agent 经 8443 端口与面板做双向 TLS，必须直连，不能经过 Cloudflare 或其他反向代理。填一个**仅 DNS（灰色云）**、指向本机的域名或本机公网 IP；`--yes` 时用 `--node-address` 指定，否则安装器停下并说明原因 |

安装结束时会打印：

- 管理后台的完整地址（含**机密后台前缀**：不知道前缀的人看不到后台，只会得到空 404）；
- 用户门户地址（主域名根路径 `/`）；
- 管理员密码。

接下来：登录后台 → **系统设置** 确认主域名 / 订阅域名 / 节点通信域名 → **节点** → 添加节点 → 在节点上执行一键安装命令（§3）。

常用运维命令（安装后可用，以 root 或 `sudo` 执行）：

```bash
akari-ctl status                    # 服务状态 + 健康检查
akari-ctl info                      # 再次显示后台地址（含后台前缀）与门户地址
akari-ctl upgrade                   # 升级到最新版本：先备份 → 校验签名 → 切换 → 健康检查，失败自动回滚
akari-ctl backup                    # 备份数据库 + 数据目录（CA 私钥、jwt.key、master.key）+ 配置；
                                    # 默认不含库里的 agent 发布二进制（--with-agent-releases 包含；docs/BACKUP.md）
akari-ctl migrate --to docker       # 同一台机器上 裸机 → Docker（或 --to bare），保留前缀、密钥与数据
akari-ctl uninstall                 # 卸载服务，保留数据与配置；--purge 彻底删除（需输入 purge 确认）
```

- **备份加密**：在 `/etc/akari/install.env` 设置 `AGE_RECIPIENT=age1…`（`age-keygen` 生成，私钥离线保存），
  之后的备份（含升级前自动备份）都用 age 加密；未设置时为 0600 明文文件并给出警告（docs/BACKUP.md）。
- **v0.3.x → v0.4 不能升级，只能全新安装**：v0.4 把迁移 0001–0168 压缩为新基线 `1000_baseline.sql`。
  - `akari-ctl upgrade` 在改动任何东西之前就会拒绝（`database from v0.3.x — fresh install required`），面板启动时也会拒绝 v0.3.x 的数据库。
  - v0.3.x 的备份**不能**恢复到 v0.4。
  - 做法：`akari-ctl uninstall --purge --confirm purge` 后重新安装（见 §5）。
- **换服务器**：
  1. 旧机执行 `akari-ctl backup`；
  2. 把备份目录复制到新机；
  3. 新机执行 `curl … | sh -s -- --restore <目录>`（加密备份加 `--age-identity <私钥>`）；
  4. 改 DNS。

  路由前缀、CA 与密钥不变，已注册的节点与订阅链接继续可用（§8）。
- **全自动安装**（脚本/批量）：`… | sh -s -- --yes --mode bare --domain panel.example.com --email you@example.com`，
  密码用环境变量 `AKARI_ADMIN_PASSWORD` 或 `--admin-password-file` 传入（`install.sh --help` 列出全部选项）。
- 安装日志：`/var/log/akari-install.log`（0600，不含密码与前缀）。

不想用安装器、或在其他发行版上部署：按附录 A（Docker Compose）/ 附录 B（裸机）手动部署。

---

以下为部署手册正文。

支持两种部署形态：**Docker Compose**（panel + PostgreSQL 18 + Valkey 9 + Caddy）和**裸机**
（systemd + PostgreSQL 18 + Valkey 9 + Caddy）。下面的安装器一条命令即可装好任意一种；附录 A / B 是同样形态的手动做法
（适用于其他发行版、nginx、已有数据库等情况）。节点（agent）始终是 systemd 下的单个静态二进制（§3）。

要求：

- 一台运行面板的 Linux VPS（1 vCPU / 1 GB 即可起步）；
- 一个指向它的 DNS 名称（下文用 `panel.example.com`；试用时用 IP 也行）；
- 80/443（TLS 代理）与 8443（agent gRPC）端口可达。

## Quick start: the installer（安装器快速开始）

```bash
curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh | sh
```

以 root 或有 sudo 的用户运行（脚本会通过 `sudo` 重新执行自身，管道方式下同样如此）。
支持：Debian 12/13、Ubuntu 22.04/24.04，amd64/arm64，systemd；其他系统一律拒绝，并指向附录。
默认交互式（按 locale 显示中文或英文，`--lang zh|en`），每个提示都有默认值；`--yes` 取默认值，其余全部由参数/环境变量提供：

| Option | Environment | Default |
|---|---|---|
| `--mode bare\|docker` | `AKARI_MODE` | `docker` |
| `--domain NAME` | `AKARI_DOMAIN` | 空 = 仅 IP（Caddy 内部 CA；浏览器会警告） |
| `--ip ADDR` | `AKARI_PUBLIC_IP` | 默认路由的源地址 |
| `--email ADDR` | `AKARI_EMAIL` | 无（ACME 账号邮箱） |
| `--admin LOGIN` | `AKARI_ADMIN` | `admin` |
| `--admin-password-file F` | `AKARI_ADMIN_PASSWORD` | 自动生成（20 个字符），只显示一次 |
| `--node-address HOST[:PORT]` | `AKARI_NODE_ADDRESS` | 域名（或 IP）：系统设置 → 节点通信域名。可为主机名、IPv4 或 `[IPv6]`，可带 `:port`。当域名（或该地址）解析到 Cloudflare 的地址段时，安装器会改为询问一个仅 DNS 的名称或 IP（`--yes` 时：停止并提示传入此选项）：agent 需要直连 gRPC 端口做双向 TLS |
| `--http-port/--https-port/--grpc-port` | | 80 / 443 / 8443 |
| `--version vX.Y.Z` | `AKARI_VERSION` | 安装器自身所属的发布版本（`latest/download` = 最新） |
| `--dir DIR` (docker) | `AKARI_DOCKER_DIR` | `/opt/akari` |
| `--local-certs` | | 所有名称都用 Caddy 内部 CA（测试/局域网名称，如 `myapp.test`） |
| `--restore DIR` / `--age-identity F` | | 从备份安装（§8 换主机） |

改动任何东西之前的检查项：操作系统与架构、root、systemd（裸机）、内存（≥ 512 MiB，低于 1 GiB 警告）、
端口占用（80/443/8443；裸机另查回环上的 8080/8082/6379）、是否已有安装（有则提示改用 `upgrade`；被中断的安装可续装：每一步都是幂等的）。然后：

- **Docker**（`/opt/akari`）：
  - 缺少 Docker 时，从 Docker 的 apt 仓库安装 Docker Engine + compose v2（密钥指纹已固定）；
  - 取该发布版本的 compose 文件、Caddyfile 和 `panel.toml`；
  - 在 `env/*.env`（0600）中生成随机的数据库/Valkey 密码；
  - `.env`（0600）把 `AKARI_IMAGE` 固定为该发布版本的 `tag@digest`；
  - 执行 `docker compose up -d`。
- **裸机**：
  - 从 PGDG 仓库安装 PostgreSQL 18（5432 上已有的集群不动：18 集群使用下一个端口）；
  - Valkey 9（`akari-valkey.service`，仅回环、带密码、不持久化；见下）；
  - 从 Caddy 官方仓库安装 Caddy，使用仓库自带的 Caddyfile（`/etc/caddy/Caddyfile`；其环境变量放在 `/etc/akari/caddy.env`，0600，经 drop-in 去掉 `--environ` 和 admin API，使 journal 和本地用户都看不到它）；
  - `akari` 系统用户（sysusers）、`/var/lib/akari`（0700）、`/etc/akari/panel.toml`（0640 root:akari，只含 R39 启动键）、加固过的 `akari-panel.service`；
  - ufw 处于启用状态时放行 80/443/8443。
- 两种形态共同的收尾步骤：
  - 等待 `/healthz`，设置主域名和节点通信域名（`akari settings set`），创建管理员（密码只经环境变量交给 CLI）；
  - 通过 Caddy 检查 `https://<domain>/healthz`，打印各 URL 并仅显示一次密码；
  - `akari-ctl`（即本安装器）和备份脚本放在 `/usr/local/sbin` 与 `/usr/local/lib/akari`；`/etc/akari/install.env` 记录模式、版本、端口（不含密钥）。

**Supply chain（供应链）。** 安装器下载该发布版本的 `SHA256SUMS` 及其 Sigstore bundle，用 **cosign** 对照本仓库在该 tag 下的发布工作流验证
（`…/.github/workflows/release.yml@refs/tags/vX.Y.Z`，issuer 为 GitHub Actions；cosign 本身按脚本中固定的 SHA-256 下载），
再用这些校验和检查它用到的每个文件：二进制、镜像引用（`akari-panel-image.txt`，Docker 据此按 digest 拉取）、部署包（`akari-deploy.tar.gz`）。
PGDG、Caddy 和 Docker 的 apt 密钥均按指纹固定。**Valkey**：Debian/Ubuntu 自带版本 < 9（Debian 13：8.1；Ubuntu 24.04：7.2），
而 Valkey 没有 apt 仓库，所以安装器使用上游发布构建（`download.valkey.io`；Debian 12/Ubuntu 22.04 用 `jammy` 构建，Debian 13/Ubuntu 24.04 用 `noble` 构建），
版本与 SHA-256 在脚本中固定，安装到 `/opt/akari-valkey`，以 `DynamicUser` 运行，配置作为 systemd credential 传入。
升级 Valkey = 发布新的安装器版本（更新 `VALKEY_VERSION` 和四个校验和）。
`curl | sh` 执行的就是这个脚本本身：如果你的策略要求，请先审阅（`curl -fsSLO …/install.sh`；`akari-ctl` 就是这个文件）。

**Secrets（密钥）。** 生成的密码不会出现在命令行或日志（`/var/log/akari-install.log`，0600）中；
管理员密码和带机密后台前缀的控制台 URL 只在终端打印一次（`akari-ctl info` 可再次打印 URL）。

私有镜像源 / 测试：`AKARI_RELEASES_URL`（采用 GitHub 目录布局的发布根地址，支持 `file://`）和
`AKARI_COSIGN_KEY`（改用 cosign 公钥验证，而非 keyless 身份；仍然是签名校验，绝不跳过，并会打印警告）。

## 0. Network model (read once)（网络模型，读一次即可）

| Port | Who connects | Exposure |
|---|---|---|
| 443（ACME 用 80） | 管理员、订阅客户端 | 公开，经 TLS 反向代理（转发所有路径；面板响应门户、后台前缀、订阅、安装链接和支付回调，其余一律返回其空 404） |
| 8443 gRPC | agent（mTLS，客户端证书 = 节点身份；注册 = 服务端 TLS + 一次性令牌） | 公开，或仅对节点 IP 放行；**绝不能放在终止 TLS 的 HTTP 代理后面** |
| 8080 panel web | 仅反向代理 | 回环 / 内网，绝不对外发布 |
| 5432, 6379 | 仅面板 | 绝不对外发布 |
| 9100 metrics | Prometheus | 回环 / 内网，默认关闭 |

防火墙（nftables 示例，裸机；ufw 请自行调整）：

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

使用 Docker 时，发布的端口会绕过 ufw/nftables 的 input 规则（Docker 自己写规则）：只发布上表列出的端口。Compose 文件就是这样做的。

## 1. Choose the config values（选择配置值）

`panel.toml` 只保存进程启动所需的内容（R39）：`data_dir`、`database_url`、`valkey_url`（后两者也可来自环境变量）、
监听器（`web.bind`、`grpc.bind`、`metrics.*`、`tls_ask.*`）、`web.trusted_proxies`（面板所见的代理地址）以及 `web.cookie_secure`。
参见 `deploy/panel.toml.example` / `panel.toml.compose.example`；其余内容都不从该文件读取。

运维人员在运行时改动的一切，都在控制台 **系统设置** 中设置并存入数据库：没有文件回退，两者之间也没有优先级：

```
主域名 / 订阅域名 / 信任 Cloudflare     系统设置 → 站点
节点通信域名 (host agents dial)          系统设置 → 节点通信   (required before the first node)
install pin, download fallback, ACME, remove mode   系统设置 → 节点通信
retention, Cloudflare ranges, extra release keys               系统设置 → 安全
latency tests                           系统设置 → 测速
Telegram API origin (alert channel)     系统设置 → 告警
```

首次登录之前（或无界面环境），节点域名也可以用 CLI 设置：
`akari settings set node panel.example.com`（不带端口的域名使用 `grpc.bind` 的端口）。
没有节点域名就无法签发安装命令或 bootstrap 文件（`settings.node_domain_unset`）。

内部调优参数（限流、令牌有效期、fail-closed 租约、计费合理性上限、告警节奏、agent 证书有效期等）是内置常量（`src/CLAUDE.md`
"Built-in constants"）。

`akari config check` 校验配置文件，打印隐去密钥的生效配置，列出已废弃的键（警告），并在数据库可达时列出 系统设置 的值；
`akari serve` 执行同样的校验，出错则拒绝启动。

### Upgrading: obsolete keys（升级：废弃的键）

旧版本的键（`web.advertised_names`、`web.sub_domain`、`web.trust_cloudflare`、
`web.cloudflare_ranges`、`grpc.advertise`、`grpc.server_name`、`install.*`、`[probe]`、`[acme]`、
`[audit]`、`[traffic]`、`[auth]`、`[agent]`、`[sub]`、`[updates]`、`[alerts]`、
`tls_ask.rate_per_sec`、`grpc.lease_seconds`、W24 的 `[payments]`）不会阻止面板启动：

- 已迁到 系统设置 的每个键，会在第一次看到它的那次启动中**导入一次**，前提是数据库中还没有对应的值
  （一个事务，审计记录为 `settings.import`，操作者 `system`；所有实例同时重载）。
  `web.advertised_names` 和 `grpc.server_name` 并入 gRPC 证书的名称列表（`grpc_server_names`，来源 `config`），
  使已注册的 agent 继续连得上；`install.public_url` 成为主域名（这会打开 host 检查，见下）；
  `updates.release_keys` 只保留非内置官方密钥的那些。
- 此后该键会被**忽略**，并在启动时给出警告：即使你在控制台修改或清空了该值也一样（文件不会让它复活；`legacy_config_imports` 记录已处理的内容）。
- 已变成常量的键会被忽略并给出警告。

所以：升级、启动一次、检查 系统设置（以及 `config check` 的警告），然后**从 panel.toml 中删除这些废弃的键**。

## 1b. Domains (系统设置) and Cloudflare（域名与 Cloudflare）

管理后台的 **系统设置** 页面（`/<admin prefix>/admin/settings`）包含三个域名列表和一个开关。保存主域名后，控制台（`/<admin prefix>/admin`）
只在主域名（以及 IP 字面量）上响应；在订阅域名上则是统一的空 404（R23、D8）。
这些设置只存在数据库中（表 `site_domains` 和 `panel_settings`；列表为空 = 下表中的内置行为）。
`akari settings show` 会打印它们；`akari settings set main|sub|node <host[:port]>` /
`set trust-cloudflare true|false` 和 `akari settings unset main|sub|node|trust-cloudflare|probe|all`
可从 CLI 修改（带审计）：例如主域名填错之后。修改在一秒内对所有面板实例生效（通过数据库通知），**无需重启**，gRPC 证书同样如此。

### 多域名（D8，中文）

主域名、订阅域名、节点通信域名都是**列表**，每类有一个**首选**（列表第一个）。每类域名只能访问规定的内容：

| 类别 | 能访问 | 首选的用途 |
|---|---|---|
| 主域名 | 门户、后台（后台前缀）、安装链接、支付回调、订阅 | 安装命令、邮件链接、支付回调地址、通行密钥 |
| 订阅域名 | **只有订阅**，其他一律空 404 | 订阅链接（开启「每个用户分配订阅域名」后，每个用户固定分到列表中的某一个；增加域名只会把一部分用户移到新域名上） |
| 节点通信域名 | HTTP 上什么都没有（agent 只连 gRPC 端口）；必须是**灰色云朵** | 新生成的安装命令与注册文件；面板证书包含用过的每一个节点域名（只增不减，已注册节点不断线） |

同一个域名不能既是主域名又是订阅域名；节点通信域名可以和主域名同名（端口不同）。Caddy 会为全部主域名和订阅域名自动签发证书
（节点通信域名用面板自己的 CA，不经过 Caddy）。删除域名前，后台先显示影响（门户/后台不再可用、改用哪个首选域名、多少待付款订单的回调、
多少未使用的安装命令、多少用户的订阅链接、多少节点在用），确认后才保存。命令行 `akari settings set main <域名>` 把它设为首选（保留其他），
`akari settings unset main` 清空整个列表。

| Field | Used for | Cloudflare | When empty |
|---|---|---|---|
| 主域名 (main) | 管理控制台、用户门户、安装链接、支付回调 URL | 橙色或灰色 | 管理员浏览器所用的 origin；不做 host 检查 |
| 订阅域名 (subscription) | 面板发出的每个订阅 URL（门户、后台、API `sub_url`） | 推荐**橙色**（隐藏服务器 IP） | 主域名 |
| 节点通信域名 (node) | 新生成的安装命令与 bootstrap 文件中的 `panel_addr`/`server_name` | **只能灰色** | **无法签发令牌** |
| 信任 Cloudflare | Cloudflare 后面的真实客户端 IP（`CF-Connecting-IP`） | — | 关闭 |

取值为主机名（IDN 以 punycode 存储）或 IP 地址，可带 `:port`；不带 scheme 和路径。**DNS 检测** 按钮从面板侧解析该名称：
订阅域名若没有解析到 Cloudflare 的网段会给出警告；节点域名若解析到了 Cloudflare 网段则**拒绝保存**（管理员明确确认后可强制覆盖）：
agent 以双向 TLS 直连 8443 端口的 gRPC，而橙色云记录会让 Cloudflare 终止 TLS（并且它不代理任意端口），agent 因此连不上。

**Host 检查。** 保存主域名后，面板只响应 Host 为主域名、订阅域名或 IP 地址的请求；其他任何域名都得到与其他拒绝情形相同的空 404。
当你正在使用的地址会因此失效时，保存前会要求确认。

**节点域名与已有节点。** 已注册的 agent 永远沿用其 bootstrap 文件中的 server name。因此面板记录写进 bootstrap 的每一个 server name
（`grpc_server_names`），其 gRPC 证书覆盖所有这些名称加上 `localhost`/`127.0.0.1`：更改节点域名只影响新安装，已有节点继续连接。
名称只能通过“节点通信证书域名”表中的 **移除** 从证书里去掉，该表会列出仍在使用它的节点（之后需要重新安装这些节点）。
在本版本之前注册的节点没有记录名称，单独列出（它们使用旧 panel.toml 的 `grpc.server_name`，已作为来源 `config` 导入列表；只要还有这类节点，就不能移除）。

**反向代理证书。** `deploy/caddy/Caddyfile` 照旧为 `AKARI_DOMAIN` 提供服务，对其他任何名称则**按需**签发：
首次为新名称握手时，Caddy 询问面板的 `ask` 端点（`[tls_ask] bind`，独立监听器：compose 为内网上的 `0.0.0.0:8082`，需 `allow_non_loopback = true`；
裸机为 `127.0.0.1:8082`；Caddy 环境变量里是 `AKARI_ASK`）。面板仅对已配置的主域名和订阅域名返回 200（每个实例限流，内置），
所以域名变化时无需修改 Caddyfile，也没人能让 Caddy 为任意名称签发证书。
所有域名上都转发所有路径，且每个站点块都会去掉 `Server`/`Via`，因此垃圾请求和面板在后台前缀之后的拒绝响应逐字节相同
（smoke 会在主域名、按需域名和裸 IP 上比较）。纯 `http://` 只对 `AKARI_DOMAIN` 重定向到 https；
其他所有 host（裸 IP、未知名称，以及 系统设置 中的域名，其链接总是 https）在 80 端口得到同样的空 404。
ACME HTTP-01 挑战仍会在那里被应答（Caddy 在任何站点路由之前处理它们）。使用 nginx 时，需要自行添加每个域名的 `server_name` 和证书。

### Cloudflare

1. DNS：主域名橙色或灰色均可，订阅域名用**橙色**（代理），节点域名用**灰色**（仅 DNS），都指向面板的 IP。保持 8443 可直连
   （如有需要，防火墙只对节点 IP 放行）。
2. SSL/TLS 模式选 **Full (strict)**：这样 Cloudflare 会校验 Caddy 获得的源站证书。
   “Flexible” 会让 Cloudflare 以明文 HTTP 访问 80 端口（Caddy 返回 404，对 `AKARI_DOMAIN` 则是重定向循环）；
   不带 strict 的 “Full” 会接受任意源站证书。
3. 橙色云名称的首张证书：Caddy 在 80 端口用 HTTP-01 挑战，经 Cloudflare 也能通过。如果开启了 “Always Use HTTPS” 而签发失败，
   先把记录切到灰色，等 Caddy 拿到证书（首次访问 `https://<domain>/healthz` 后几秒内），再切回橙色；续期在代理状态下可以正常进行。
4. 在 系统设置 中打开 **信任 Cloudflare**。面板随后把 Cloudflare 边缘网段视为可信代理：链路为 客户端 → Cloudflare → [Caddy →] 面板 的请求，
   会归属到 `CF-Connecting-IP`（登录/订阅限流、审计）。只有当最近的真实一跳是经由可信代理（`web.trusted_proxies` = Caddy）到达的 Cloudflare 边缘时，
   才会读取该头；直接连源站并伪造该头的人，会被归属到其自身地址。不开此开关时，所有经 Cloudflare 的请求都算作边缘地址
   （限流更粗，但不会出问题）。
5. WebSocket 可以通过橙色云工作（订阅和后台流量不需要它；节点自己的 WS 入站放在 Cloudflare 后面是另一个按节点的独立选择）。
   经 Cloudflare 的 gRPC 需要其 “gRPC” 网络设置，并且**绝不**适用于 agent 通道。

**更新 Cloudflare 网段。** 列表随二进制发布（`src/cloudflare_ips.txt`，来自
https://www.cloudflare.com/ips-v4 和 /ips-v6）。如果 Cloudflare 在面板发布新版之前公布了新网段，把完整列表粘贴到
系统设置 → 安全 → **Cloudflare 网段**（每行一个 CIDR；它会同时替换所有实例上的内置列表，无需重启；留空 = 使用内置）：

```bash
curl -s https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6   # review, paste
```

过期的列表是安全失败：来自未知边缘网段的流量只会被归属到边缘地址。
发布维护者从相同 URL 刷新 `src/cloudflare_ips.txt`（单元测试 `cloudflare::tests` 检查它能解析）。

## 2. First admin（第一个管理员）

安装器会创建它（并设置 主域名 / 节点通信域名，§2b）；也可以手动创建，或之后再建别的管理员
（`akari-ctl` 安装的环境：compose 目录为 `/opt/akari`）：

```bash
# compose:  docker compose exec -e AKARI_ADMIN_PASSWORD='...' panel /akari admin add you@example.com
# bare metal: sudo -u akari env AKARI_ADMIN_PASSWORD='...' akari -c /etc/akari/panel.toml admin add you@example.com
```

省略该变量则会提示输入。邮箱地址就是登录名（v0.4：包括管理员在内，所有人都用邮箱登录；它视为已验证）。
管理员打开 `https://panel.example.com/<admin prefix>/app`（`akari info` / `akari-ctl info`），用邮箱和密码登录；
随后进入 `https://panel.example.com/<admin prefix>/admin` 的控制台
（只对管理员会话提供；没有会话时与任何未知路径一样是空 404，所以请收藏 `/app` 而不是 `/admin`）。
用户使用 `https://panel.example.com/` 的门户；管理员不能在那里登录。
忘记密码：`akari admin passwd <email>`（会结束该账号的所有会话）。
（TOTP 两步验证已在 v0.4 移除，由通行密钥取代。）

### 后台前缀、IP 白名单与订阅路径（D4/D11，中文）

- **门户**在主域名根路径 `/`（用户登录、注册、购买、订阅等）；门户的页面、接口与回答里**永远不出现后台地址**，登录后也不会跳到后台。
  门户的页面：`/`、`/shop`、`/orders`、`/wallet`、`/invite`、`/nodes`、`/traffic`、`/tickets`、`/help`、`/announcements`、`/account`、
  `/login`、`/register`、`/forgot`、`/reset`、`/terms`、`/privacy`（其他顶层路径都是空 404）。**服务条款与隐私政策**取自知识库里
  slug 为 `terms`、`privacy` 的已发布文章（没写时显示一段中性说明）；也可以在 **系统设置 → 站点** 的品牌设置里填外链，页脚直接指向外链。
- **后台前缀**是全站唯一的秘密前缀：后台 `/<前缀>/admin`、管理员登录页 `/<前缀>/app` 与全部管理接口都在它下面。安装时随机生成（`data/state.json`），
  第一次启动后保存在数据库里。**系统设置 → 访问**（只有所有者可改）：更换前缀（可随机或自定义，二次确认，写入审计但不记录前缀本身；
  所有面板实例立即生效，旧前缀立即变成空 404）、**IP 白名单**（地址或 CIDR，最多 64 条；名单外的地址访问前缀下的任何路径都是空 404；
  保存时若名单不含你当前的地址会被拒绝）。命令行：`akari secrets rotate-prefix`（随机换新前缀）、
  `akari settings unset admin-allow`（被白名单锁在外面时清空名单）、`akari info`（查看当前前缀与订阅路径）。
- **订阅路径**：订阅链接是 `https://<订阅域名>/<订阅路径>/<令牌>`，订阅路径是安装时随机生成、全站共用的一段，不再是固定的 `/sub/`。
  在 **系统设置 → 访问** 修改（二次确认、写入审计）后**旧路径立即失效**，所有用户的订阅链接随之改变；默认勾选
  「邮件通知所有用户」：后台批量任务给每个有已验证邮箱的用户发一封带其新链接的邮件（需已启用邮件）。
- **安装链接**（`/install/…`）与**支付回调**（`/pay/…`）是独立的公开路径，不含后台前缀；后台前缀下也不提供订阅、安装链接与支付回调。
- 反向代理（Caddy/nginx）把所有路径原样转发给面板，由面板判断；改前缀不需要改代理配置。

### 账号注销（W27，中文）

用户可以在门户自助注销账号（需要输入当前密码；只用通行密钥登录的账户除外）。注销前会显示会丢失什么（余额、可提现金额、生效中的套餐）。
有待付款订单或待处理提现时需要先取消。没有任何财务记录（订单、余额明细、返佣、提现）的账号直接删除；有财务记录的账号**匿名化保留**：
邮箱改为 `erased-<id>@erased.invalid`，个人数据（通行密钥、订阅链接、工单、邮件、流量明细等）全部删除，套餐取消、节点权限立即撤销，账号永久停用；
订单与余额流水仍按原账户保留（后台用户列表状态为「已注销」）。原邮箱之后可以重新注册。

### 清理从未使用的账号（D10，中文）

「从未使用」指：从没有过套餐、从没付过款（没有任何订单、余额流水、返佣、提现）、没有流量、余额为 0、没有工单的普通用户。管理员和有任何财务记录的账号永远不算。

- **后台用户列表**：筛选「从未使用」「注册早于」「最后登录早于」（从未登录也算），可以勾选或选「全部匹配的 N 个」批量删除：先显示数量，确认后才删除（数量变了需要重新确认）。删除逻辑与用户自助注销相同。
- **自动清理**（系统设置，默认关闭）：注册超过 N 天（默认 30）且 N 天内没有登录的从未使用账号，每小时检查一次并删除。可选**删除前发邮件提醒**：先发提醒，等待若干天（默认 7）后再删除；期间用户登录一次即保留。

### 所有者（R47，中文）

安装时创建的第一个管理员（`akari admin add`）是**所有者**，全站唯一。只有所有者能：

- 管理其他管理员：设为管理员、降级、改密码、封禁、删除、踢下线、重置登录方式；
- 修改后台前缀与 IP 白名单、支付渠道的密钥与账号；
- 把所有者转让给另一位已启用的管理员（后台二次确认，写入审计 `user.owner.transfer`）。

所有者不能被降级、封禁或删除（数据库同样拒绝）；普通管理员负责日常运营（用户、套餐、节点、订单、工单等）。
所有者账号丢失时，在服务器上执行 `akari admin set-owner <邮箱>`（Docker：`docker compose exec panel /akari admin set-owner <邮箱>`）
把所有者交给另一位已启用的管理员；忘记密码用 `akari admin passwd`，通行密钥丢失用 `akari admin reset-login`。

提升管理员：被封禁的账号要先解封；因超流量被停用的账号提升后自动恢复（管理员没有流量额度）。
（v0.4 之前的「至少保留一个启用的管理员」规则由「所有者必须是启用的管理员」取代。曾经出现过的"删除账号时提示必须保留一个管理员，
但明明还有另一位管理员"，原因是那位管理员是在超流量停用状态下被提升的、一直处于停用状态，不算有效管理员；升级迁移会把这类账号恢复。）

## 2b. 系统设置 (main domain)（主域名）

（安装器：已设为 `--domain`，节点通信域名也设为同一名称，仅 IP 安装则为该 IP；请检查。）
在控制台 **系统设置** 中，把 **主域名** 设为你部署所用的名称（`panel.yourdomain.com`）并保存。
安装链接、订阅 URL 和支付回调随后都由它生成，而不再取决于浏览器碰巧使用的地址；同时 Host 检查（§1b）开启：
请求其他任何名称都会得到空 404。订阅域名（用于 Cloudflare）和节点通信域名是可选的（§1b）。

### 站点时区（Q3，W28-a，中文）

**系统设置 → 站点 → 时区**（API `PUT /api/v1/settings/site {"version": N, "timezone": "Asia/Shanghai"}`），默认 `Asia/Shanghai`（北京时间，无夏令时）。填写 IANA 时区名（如 `Asia/Shanghai`、`Asia/Tokyo`、`UTC`、`America/New_York`），必须与 PostgreSQL 时区库中的名称完全一致；`CST`、`UTC+8`、`+08:00` 这类缩写或偏移会被拒绝（`settings.timezone_invalid`），因为它们的含义有歧义。留空 = 恢复默认。修改写入审计（`settings.site.update`）。

它决定以下"日"和"月"的边界：

- **流量明细**：每天的流量按该时区的 0 点切分（用户「流量记录」、后台用户/节点流量、仪表盘近 14 天、流量 CSV 导出）。默认设置下，北京时间 0 点即新的一天（以前按 UTC，相当于北京时间 8 点）。
- **审计规则拦截次数**：按该时区的日统计（`node_block_daily`）。
- **套餐流量月重置**：按该时区的当地日期与时刻（例如北京时间 3 月 1 日 03:00 开通，每月 1 日 03:00 重置；31 日开通的在小月夹到月末）。有夏令时的时区保持当地钟点不变。
- **按月/季/年计的套餐时长**：同样按该时区的日历月计算到期（北京时间 1 号买的月付在下月 1 号同一时刻到期，与月重置对齐）。按天计的套餐始终是精确的 N×24 小时。
- **仪表盘**的今日/近 7 天/近 30 天、**订单 CSV 导出**的日期范围（按当地 0 点）。
- 后台用户详情与门户「我的套餐」里的下次重置时间以该时区呈现（`2026-11-01T00:00:00+08:00`）。

**修改时区只影响之后的数据**：已经记录的流量日期不会改写；已经排好的下次重置时间在下一次重置时按新时区重新计算。建议在开始运营前设置好，之后不要频繁修改。

**流量明细的存储**：`traffic_daily` 按月分区（`traffic_daily_YYYYMM`）。面板启动时和每 10 分钟检查一次，保证上个月到后两个月的分区存在；超过「流量明细保留天数」（系统设置 → 安全，默认 400 天）的**整月**汇总进月表后直接删除整个分区，不产生数据库膨胀。因此日明细至少保留设定的天数，最多再多保留不到一个月。

## 2c. Mail, registration and password reset (optional, W15)（邮件、注册与找回密码，可选）

这里的一切在你打开之前都是关闭的；panel.toml 中没有对应项。

1. **系统设置 → 邮件**：填写 SMTP 服务器、端口和安全方式。邮件服务商用 **STARTTLS**（587）或 **SSL/TLS**（465）；
   **不加密** 只用于同一主机/内网上的中继（面板拒绝在其上发送凭据）。服务商需要时填用户名/密码
   （密码用由 `data/master.key` 派生的密钥加密存放：该文件丢失后需重新输入）、发件地址
   （须被服务商允许；在服务商处为该域名设置 SPF/DKIM）和发件人名称（也是邮件里的站点名）。
   勾选 **启用邮件发送**，保存，然后给自己 **发送测试邮件**：失败时会显示服务商的应答。
2. 通知（同一张卡片）：订单收据、到期前 N 天的套餐到期提醒（0 = 关闭）、“套餐已到期”、流量达 80 % 和用尽（每个周期各一次）。
   只有已验证的地址才会收到邮件；用户在门户的 邮箱 卡片中添加自己的地址（当前密码 + 邮件验证码）。到期提醒
   只发给仍在生效的订阅；被取消或退款撤销的订阅不再收到「即将到期 / 已到期」（运营审查低-1）。
   「订单退款通知」（默认开）：管理员退款时告诉用户退了多少、退到哪里、套餐怎样处理。
3. **系统设置 → 注册**：**开放注册**（登录页显示 注册；邮箱地址就是登录名）。
   **注册需要邮箱验证**（v0.4：开/关开关，默认关，与 必须使用邀请码 相互独立；开启需要 邮件发送）。
   注册可以**不配置 SMTP** 开放：此时用户只用邮箱 + 密码注册；地址以**未验证**状态保存
   （不会给它发邮件、不能找回密码、不要求唯一、不能用于登录的邮箱形式；登录名就是该地址，不区分大小写，所以他们用它登录）。
   邮件可用后，用户可在 账户 下验证；管理员也可以将其标记为已验证（用户 → 管理 → 标记邮箱已验证）。
   无验证时的防滥用措施：
   - 内置工作量证明，由浏览器无感求解（约 2^18 次 SHA-256，不使用第三方验证码）；
   - 每个客户端地址每小时 5 次注册 / 每天 20 次，每个邮箱地址每小时 5 次尝试；
   - 可选的邀请码和域名白名单。

   残余的信息泄露：注册尝试会暴露某个地址是否已被占用（统一回答“无法注册”，受上述限流约束），这是无验证注册固有的。
   还可选择开启 **必须使用邀请码**（用户在门户创建邀请码/链接；可一次性或非一次性；每用户有上限）、
   **邮箱域名白名单**（每行一个；包含子域名）和 **试用套餐**（含天数）。
   **允许通过邮件找回密码** 需要主域名（§2b）：重置链接总是由它生成，绝不取自请求所用的地址。
4. 投递：请求只是把邮件入队；每个面板实例都运行一个发送器（一次一封，`FOR UPDATE SKIP LOCKED` + 租约，
   实例之间不会并发发送同一封），带退避重试约两小时，之后保留一条可重试的 **失败邮件** 记录
   （验证码和重置链接则直接过期：迟到就没用了）。已发送的正文会被擦除；记录保留 30 天（已发送）/ 90 天（失败）。
   指标：`akari_mail_deliveries_total{kind,result}`。
5. 滥用限制（Valkey，所有实例共享）：每个客户端地址每小时 10 封邮件，每个目标地址每小时 5 封、每天 20 封，
   每个客户端地址每 15 分钟完成 30 次验证码/链接；验证码输错 5 次即作废。启用验证时，应答绝不暴露某个地址是否有账号。
6. **机器人防护（W27，`PUT /api/v1/settings/auth`；控制台页面在 W36-b）**，用于 登录、注册、找回密码：
   - **蜜罐 + 最短提交时间**（默认开启：2 秒）：页面从 `/auth/options` 取一个签名的表单令牌，并且不早于最短时间才提交；
     隐藏字段被填、令牌缺失/伪造/过期或提交过快，都只会得到该表单的普通失败（不给机器人任何提示），
     并且只增加 `akari_bot_trap_total{form,reason}`，不写日志。用 curl 登录的脚本必须照做
     （`/auth/options` → 等待 → 提交 `"guard":{"form_token":…}`），或把 最短提交时间 设为 0。
     改了这些设置（或下面的 Turnstile 开关）不需要用户刷新：已经打开的门户页面和后台登录页在表单挂着时每 30 秒、
     窗口回到前台时、每次提交之后都会重新取 `/auth/options`；页面打开之后才开启的 Turnstile 会让页面自动重新加载一次
     （打开时的 CSP 不放行 Cloudflare 的脚本）。v0.4.0 的页面不会重新取：改设置之后，已打开的页面每次提交都失败
     （「邮箱或密码错误」或「人机验证未通过」），直到刷新。
   - **Cloudflare Turnstile**（按表单，默认关闭）：站点密钥 + 密钥（密钥只写不读，用 `data/master.key` 加密），在服务端验证；
     开启后**失败即关闭**：
     - 400 `auth.captcha_failed`（「人机验证未通过」）= 访客这边的问题：没有令牌，或 Cloudflare 以
       `missing-input-response` / `invalid-input-response` / `timeout-or-duplicate`（过期或重复使用）拒绝了令牌；
     - 503 `auth.captcha_unavailable`（「人机验证服务暂不可用」）= **站点这边的问题**，所有受保护的表单都会失败：
       Cloudflare 不可达或出错，或者 **Turnstile 密钥配置错误**——Cloudflare 拒绝了密钥或请求
       （`invalid-input-secret`、`missing-input-secret`、`bad-request` 等），或 `data/master.key` 换过导致存储的密钥打不开。
       密钥配置错误时面板日志有一条 ERROR（只含 Cloudflare 的错误码，不含令牌、密钥或客户端地址），
       `akari_turnstile_verify_total{result="misconfigured"}` 增加，Prometheus 告警 `AkariTurnstileMisconfigured` 触发。
       检查方法：看日志里的错误码；到 系统设置 → 注册与人机验证 重新填写**密钥**（不是站点密钥），并确认
       站点密钥与密钥来自 Cloudflare 控制台里的同一个组件、组件的主机名包含本站域名。
     - 指标 `akari_turnstile_verify_total{result}`：`ok`、`no_token`、`rejected`（访客侧）、`misconfigured`、`unavailable`。
     - 后台的密钥输入框只写：留空保存 = 保持原密钥（保存同一张卡片上的其他设置，比如最短提交时间，不会改动它）；
       输入框关闭了浏览器/密码管理器的自动填充，免得把管理员密码当成密钥存进去（SMTP 密码、Resend 密钥、支付密钥、
       告警通道密钥同理）。
     因密钥填错而被锁在外面时：
     `akari settings unset turnstile` 会在所有表单上关闭它（带审计，密钥保留）。
     Content-Security-Policy：只要 Turnstile 保护着至少一个表单，**门户页面**（仅这些：绝不包括 API、静态资源或控制台）
     就会在通常的 `default-src 'self'` 之上加上
     `script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com`，使组件得以加载。
     关闭时，面板自身 origin 之外的内容一概不允许。
7. **通行密钥（W27）** 需要主域名（§2b）是 https 的 DNS 名称：通行密钥属于该名称（RP ID）。
   策略（`PUT /api/v1/settings/auth`）：管理员仅通行密钥 / 用户仅通行密钥（已有通行密钥的账号必须使用它；没有的账号在添加之前仍可用密码），
   以及 密码登录后提示绑定（从提示中绑定会关闭该账号的密码登录）。管理员不需要第二个通行密钥，但唯一的一个丢失时：
   在服务器上执行 `akari admin reset-login <email>`（删除该账号的通行密钥，恢复密码登录，带审计）。
   **更换主域名** 会让现有通行密钥成为孤儿（浏览器只在旧名称上提供它们）：它们显示为非当前，对应账号回退到密码登录。

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

## 2d. Payments (系统设置 → 支付, W24)（支付）

支付方式只在控制台里配置（存数据库；不在 panel.toml 中，所有实例同时生效）：
**系统设置 → 支付 → 添加支付方式 → 支付宝当面付**，选择环境（正式/沙箱），填 APPID、可选的 商户 PID，
粘贴应用私钥（用 `data/master.key` 加密，之后不再显示）和支付宝公钥，把显示的 **应用公钥** 上传到支付宝开放平台，启用，然后 **测试连接**。
回调 URL 按支付方式由主域名（§2b）生成：支付宝侧无需配置。可以配置多种支付方式（付款人在结账时选择）。
详情、密钥轮换和旧版升级见 docs/PAYMENTS.md。旧 panel.toml 中的 `[payments.alipay]` 会在数据库配置为空时导入一次，
之后被忽略并给出警告：请删除该段及其密钥文件。

## 3. Add a node and install the agent（添加节点并安装 agent）

### 服务器与节点（Q1，中文）

- **服务器** = 一台机器 = 一个 agent 身份：证书、注册/安装命令、在线状态、机器状态与测速、告警、
  agent 更新（灰度按服务器）、节点域名（TLS 证书）、计费上限都属于服务器。
- **节点** = 服务器上的**一个入站**（一个协议/端口），带它自己的入口（直连 + 中转）、倍率与节点组。
  同一台机器要跑第二个协议 = 在同一服务器上再建一个节点，**不需要再装一个 agent**。
- 后台节点页按 服务器 → 节点 → 入口 分组显示（`GET /api/v1/servers`）。
- **新建节点**：不选服务器 = 同时新建一台同名服务器并给出一键安装命令（与以前一样）；选择已有服务器
  （`POST /api/v1/nodes {"server_id": …}`）= 只加一个入站，agent 几秒内收到新配置，无需安装。
  端口不能与该服务器上已有的入站或中转入口冲突（`entrance.port_clash`）。
- **删除节点**：立即删除该节点、它的入口与用户凭据，服务器和其他节点照常运行（删除后才上报的尾部
  流量不再计费）。**删除服务器**：先让 agent 收敛到空配置，再吊销证书并删除服务器及其全部节点
  （两阶段，与以前删除节点相同）。
- **服务器流量额度（D5）**：`PATCH /api/v1/servers/{id}` 的 `traffic_quota_bytes`（字节，null = 不限）、
  `traffic_quota_mode`（`both` 双向 / `up` 仅上行 = 服务器发出的流量（多数服务商的"出站流量"）/
  `down` 仅下行 = 服务器收到的流量）、`traffic_quota_reset_day`（每月几号 00:00（站点时区）开始新周期，
  1–31，大于当月天数取月末；null = 不重置）。**按服务器网卡计**（agent 心跳里的网卡累计计数，
  与服务商账单一致，包括 agent 与面板之间、系统更新等全部流量），不是用户的代理字节数。
  重启后计数从 0 继续累加，换网卡只换基线，不会多计。用完后：此服务器上的**全部节点**下发空配置
  （与停用节点效果相同，节点的启用状态不变，管理员停用的节点恢复后仍是停用），从订阅与门户中消失，
  触发告警「流量额度已用完」（告警中心可按服务器关闭）；进入下个周期，或把额度调高到已用量以上
  （或取消额度）立即自动恢复。服务器列表里 `traffic_quota` 给出本期上下行、已用量与下次重置时间。
  每次修改写审计 `server.update`，周期重置写 `server.traffic_quota.reset`（操作人 system）。
- 命令行：`akari server add <名称>`（新服务器 + bootstrap 文件）、`akari server enroll-token <id>`、
  `akari server list`、`akari server delete <id>`。升级时已有的每个节点成为一台同 id 的服务器，
  已安装的 agent 不需要任何操作。

**界面操作：节点 → 新建节点（In the UI: Nodes → 新建节点）。** 填写名称、用户看到的地区、客户端拨入的 连接地址（IP 或域名），
可选填节点的 **节点域名**（TLS 域名：agent 会自行获取证书，§3f），并从协议模板中选择节点的入站
（W28-a：每个节点一个入站，同一台机器上的第二个协议就是第二个节点）：

| Template | Needs on the node | Notes |
|---|---|---|
| VLESS + REALITY + Vision（默认） | 无 | 面板生成 X25519 密钥对和 short id；`dest`/SNI 取自与 agent 的 xray 兼容的列表（默认 `www.apple.com`，见 §3b）；**检测目标站点** 从面板发起 TLS 1.3 + h2 握手；除非取消勾选，否则启用 Vision（`xtls-rprx-vision`） |
| VLESS + REALITY + XHTTP | 无 | 同上，带 XHTTP path/mode；没有 Vision（不是原始 TCP） |
| VLESS + TCP + TLS + Vision | 证书 | |
| VLESS + WebSocket + TLS | 证书 | 未设置时 WS path 随机 |
| VMess + WebSocket | 仅 TLS 时需要证书 | 无域名时为明文 WS |
| VMess + TCP | 无 | 明文 VMess（AEAD，alterId 0） |
| Trojan + TLS | 证书 | |
| 自选传输 (VLESS/VMess/Trojan × WS/HTTPUpgrade/XHTTP/gRPC) | TLS 时需要证书 | WS/HTTPUpgrade/XHTTP 上的 VLESS/VMess 可选 TLS，Trojan 和 gRPC 必须 TLS；path/Host/XHTTP mode/gRPC service name |
| Shadowsocks 2022 | 无 | 多用户，`2022-blake3-aes-128-gcm`（默认）或 `-256-gcm`；服务端密钥自动生成；TCP+UDP |
| Hysteria 2 | 证书 | 基于 UDP 的 QUIC |

完整矩阵（各客户端格式能承载什么、拒绝什么及原因）：§3d。

“证书”即节点自己用于 TLS 域名的证书。**设置了 节点域名（推荐）时，agent 通过 ACME（Let's Encrypt）自行获取并续期，§3f**：
不需要 certbot，节点上除了一条指向它的 DNS 记录和可达的 TCP 80 之外什么都不用做。TLS 模板随后把该域名作为证书域名/SNI
（其域名字段留空；填别的名称会被拒绝，证书只覆盖节点域名）。没有 节点域名 时，需要你自己把证书放到节点的
`/etc/akari-agent/tls/fullchain.pem` 和 `privkey.pem`（certbot、acme.sh 等；仅 root 可读的文件也行）。
安装器把该目录作为 systemd credentials 交给 agent（agent 以动态用户运行，否则读不了 `/etc`），在服务启动时读取一次：
首次放入证书之后（在保存 TLS/Hysteria 2 入站之前），以及每次续期之后，都要执行 `systemctl restart akari-agent`。
放在节点自己的反向代理或 CDN 后面的 WS 入站不是模板（订阅会通告入站的本地端口）：请手写那段 JSON。
**高级：直接编辑入站 JSON** 显示/编辑生成的 JSON（一个 xray inbound 对象，不含 `tag`：由面板命名）；
两条路径经过相同的校验（§3d 矩阵，不允许 `fakedns`）。

**Entrances（入口，W28-a）。** 客户端通过节点的入口连接节点。每个节点都有内置的 **直连** 入口：
连接地址/连接端口（地址为空 = 节点域名，端口为空 = 入站端口）、倍率及其所属节点组都属于该入口
（节点页 → 展示与计费；`PATCH /api/v1/entrances/{id}`）。套餐授予节点组，组包含入口；
用户恰好可以使用其套餐所含节点组中的入口（没有按用户手动分配），每个可用入口都是一条独立的订阅条目，
名称为 "<显示名称 | 标签> <入口名>"（例如 "香港 01 | IPLC 直连"；倍率不是 1 时名字后附倍率，如 "香港 01 IPLC 2.0x"）。
停用直连入口会让其用户离开该节点。

**中转入口（relay）。** 转发到节点的中转（IPLC、转发 VPS）以中转入口的形式添加（`POST /api/v1/nodes/{id}/entrances`）：
填写名称、客户端拨入的地址/端口（中转机的）、中转转发到的节点上的 **监听端口**、中转的 **出口 IP**（1–64 个地址/CIDR）、倍率和节点组。
节点随后运行一个派生入站：协议和设置与节点入站相同、监听端口不同，且每个用户有该入站专属的凭据
（因此中转凭据只在该中转的入站上有效，从一个入口移除用户也不会影响另一个入口）。
请在节点防火墙中对中转的出口 IP 放行该监听端口。流量按入口计量，并按该入口的倍率计费。

具备 `source-filter` 能力的 agent（W28-a agent 发布版）会为每个派生入站添加内核白名单：自己的 nftables 表 `inet akari_sources`，
中转变化时整体替换，没有中转时移除；来自其他地址的、到监听端口的新连接会被丢弃（已有连接不会被切断）。
**agent 本身没有 `CAP_NET_ADMIN`（R44）**：它把白名单写入状态目录中的请求文件（`update/source-filter-request.json`），
已负责安装自更新的 root 更新器（systemd：`akari-agent-update.path` + `.service`；Alpine：`akari-agent-update` 服务循环）
重新校验它，约一秒内用 `nft -f -` 应用，并把结果交还；agent 在心跳中上报结果。
这需要节点上有 `nft`（缺少时安装器会安装 `nftables` 包）以及最新的更新器 unit
（在本版本之前安装的节点，会随 agent 自更新获得，或重新运行安装命令）。
在更新器应答之前，以及它失败的任何时候，中转入口仍可工作，只是仅有凭据隔离；失败或缺少更新器时，节点页显示“来源 IP 过滤未生效”。
旧版 agent 忽略白名单（节点页警告），并且在协议版本 7 以下，按入口分别计算用户的限速。

**中转入口健康检查。** 面板每分钟对每个已启用的中转入口的地址（其 连接地址:连接端口，即中转机本身）发起一次 TCP 连接。
连续失败 3 次后，该中转入口会从订阅和门户中隐藏，并在已配置的渠道上触发节点的 **中转入口不可用** 告警（`entrance_down`）。
第一次测试成功即恢复并解除告警。节点始终继续提供服务，所以已通过该中转连接的客户端不会被切断。
更改中转地址会立即触发一次测试。该检查遵循 系统设置 → 测速 → 面板 TCP 测速：该开关关闭时，不测试也不隐藏任何中转。
仅 UDP 入站（Hysteria 2）的中转无法做 TCP 测试，也从不隐藏。节点页显示每个中转的最近结果（`health_ok`、`health_error`、`hidden_since`）。

创建节点会显示一条**一行安装命令**，有效期 1 小时（内置），且仅在 agent 用它完成注册之前有效。
它需要 系统设置 → 节点通信 → **节点通信域名**（agent 拨入的地址；没有它面板拒绝签发命令）：

```bash
sh -c 'command -v curl >/dev/null || { echo "…how to install curl…" >&2; exit 1; }' && curl -fsSL 'https://panel.example.com/install/<token>' | sh -c '[ "$(id -u)" = 0 ] || exec sudo sh; exec sh'
# or: sh -c 'command -v wget …' && wget -qO- 'https://panel.example.com/install/<token>' | sh -c '…same…'
```

**节点需要 curl（或 wget）。** 部分精简镜像（例如 Lightsail 的 Debian 13）两者都没有；命令开头的检查
会停下并提示安装方法，什么都不执行。先在节点上以 root 安装再运行安装命令：

```bash
apt-get update && apt-get install -y curl      # Debian / Ubuntu（非 root 加 sudo）
apk add curl                                   # Alpine
```

在节点上运行它（带 systemd >= 250 的 Linux，amd64 或 arm64；Debian 12/13、Ubuntu 22.04+ 均可；
W32：也支持带 OpenRC >= 0.45 的 Alpine Linux，已在 3.22 上测试，见 §3h），以 root 或 sudo 用户身份执行：
命令末尾直接以 root 运行脚本（没有 `sudo` 的镜像也能用），否则经 `sudo` 运行
（W10；之前签发的命令末尾是 `| sudo sh`，即使是 root 也需要 `sudo`）。既不是 root 也没有 `sudo` 时，它会停在 `sudo` 处，什么都不执行。
它会：

1. 从面板下载 agent（在 **Updates** 下上传的最新完整发布版本，§5b）并校验其 SHA-256；
   如果没有上传过发布版本，则回退到 系统设置 → 节点通信 → **备用下载地址**
   （默认：最新的 GitHub release 资源，对照该发布的 `SHA256SUMS` 校验；可设为镜像或关闭）；两者都没有时，在改动任何东西之前报出明确错误并停止；
2. 写入 `/etc/akari-agent/bootstrap.toml`（0600：面板地址、gRPC server name、面板 CA、一次性注册令牌，不含私钥）、
   systemd unit（`akari-agent.service`，以及 agent 的特权更新器 `akari-agent-update.service` +
   `akari-agent-update.path`；path unit 会被启用，§5b）和一个用于 TLS credentials 的 drop-in。
   **这些 unit 就是所下载发布版本自带的**（W23：经校验的二进制会打印它们，`akari-agent -print-unit <name>`；
   其正本在 agent 仓库的 `systemd/`）。只有比这更旧的发布版本才使用脚本里内嵌的副本
   （面板的 `deploy/systemd/`，由 agent 的 CI 保持逐字节一致）；此时输出会显示 `does not carry its systemd units`。
   自更新会随二进制一起安装每个新版本的 unit（§5b），所以不要编辑已安装的 unit 文件：本地改动请放进 drop-in
   （`/etc/systemd/system/akari-agent.service.d/*.conf`；被编辑过的 unit 会在节点页提示，并在下次更新或重装时被替换）；
   在 Alpine（OpenRC）上则改为安装该发布版本的 OpenRC 脚本（`/etc/init.d/akari-agent`、
   `/etc/init.d/akari-agent-update`）和系统用户 `akari-agent`（§3h）；
3. 在内核支持且机器允许时，开启 TCP BBR 和 fq 队列（W32，§3h；`--no-bbr` / `AKARI_BBR=0` 可跳过）；
4. 设置了 节点域名 时：在已启用的 `ufw`/`firewalld` 中放行 TCP 80（CA 的 HTTP-01 校验；
   云防火墙/安全组在机器之外，输出里会提醒你）；
5. 启动 agent，并等待它完成注册和连接（打印 `SUCCESS`，或 agent 的日志及原因）。证书几秒内跟上；其状态可在节点页查看。

重复运行是安全的（原地重装/升级）。节点几秒内显示为 `online`。
重装还会把该节点在已结束（中止/完成）的灰度发布中的条目转为历史：节点列表中它显示为灰色的 `…（重装前）`，而不是节点当前的更新状态。
卸载：在节点上以 root 执行 `akari-agent-uninstall`（sudo 用户用 `sudo akari-agent-uninstall`；安装器会打印适合其运行方式的形式），
或使用新命令加 `| sudo sh -s -- --uninstall`（root：`| sh -s -- --uninstall`）；然后在面板中删除该节点。

**Security of the link（链接的安全性）。** URL 中的令牌*就是*节点的注册令牌（256 位，只存其 SHA-256，一次性，TTL 很短）。
面板只在其有效期内提供脚本和二进制；一旦 agent 完成注册（或链接过期、或为该节点签发了更新的链接/令牌、或该节点正在被删除），
每个请求都得到面板统一的空 404，错误令牌和超出限流的来源（每个地址每 10 分钟 20 次，内置）也一样。
谁先运行该命令谁就得到该节点，与 bootstrap 文件完全一样：请通过可信渠道复制。
脚本不把令牌传给任何命令行（下载从 stdin 读取其 URL），面板也从不记录它（日志里是 `/install/{token}`）。
节点列表中的 **重装命令** 为已有节点签发新链接；agent 用它完成注册时，该节点之前的证书会被吊销。

**Where the link points（链接指向哪里）。** 设置了则为主域名（系统设置 → 站点 → 主域名）；否则为管理员浏览器访问面板所用的地址。
面板签发命令时会连接该 origin：证书由公共 CA 担保 → 普通 `curl`/`wget`。
其他情况（仅 IP 部署，使用 Caddy 内部 CA）→ 命令会**钉扎所提供证书的公钥**：

```bash
sh -c 'command -v curl …' && curl -fsSL --proto '=https' -k --pinnedpubkey 'sha256//<base64>' 'https://203.0.113.10/install/<token>' | sh -c '[ "$(id -u)" = 0 ] || exec sudo sh; exec sh'
```

curl 在握手期间、发送请求之前检查该钉扎，所以不匹配时会中止而不泄露令牌；`-k` 只是跳过自签面板无法通过的 CA 检查，
没有钉扎时绝不会输出（没有 wget 变体：wget 无法钉扎）。脚本下载二进制时使用同一个钉扎。
Caddy 内部证书有效期很短（约 12 小时）：如果命令因 “public key does not match” 失败，请重新生成一条。
可设置 系统设置 → 节点通信 → **安装命令公钥钉扎**（`sha256//<base64>`）来钉扎固定的密钥而不是探测
（例如面板无法访问自己的公网地址时）。

**Manual path（手动路径：CLI / 节点没有出站 HTTPS）。** bootstrap 文件仍然可用（创建之后显示在安装命令下方；节点列表中的 **bootstrap** 签发新的）：

```bash
# bare metal, on the panel host
sudo -u akari akari -c /etc/akari/panel.toml server add tokyo-1 --out /tmp/tokyo-1-bootstrap.toml

# compose: `--out -` writes the bootstrap to stdout (progress goes to stderr), so nothing is left
# in the distroless container (it has no `rm`). Redirect on the host; -T = no TTY, keeps it clean.
( umask 077; docker compose exec -T panel /akari server add vps-1 --out - > vps-1-bootstrap.toml )
chmod 600 vps-1-bootstrap.toml
```

`server enroll-token <id> --out -` 的用法相同（然后在界面中或用 `POST /api/v1/nodes {"server_id": …}` 添加该服务器的节点）。
bootstrap 令牌一次性，24 小时后过期（内置）。在 agent 完成注册之前，请把该文件当作凭据对待（通过 SSH 复制，删除副本）。在节点上：

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

agent 首次启动时，在其状态目录中生成密钥（ECDSA P-256）
（`StateDirectory=akari-agent`，即 `/var/lib/private/akari-agent`，目录权限 0700，文件 0600；没有 systemd 时用 `-state-dir`，默认是配置文件所在目录），
带着令牌把 CSR 发到面板的 gRPC 端口（唯一一个无需客户端证书即可工作的调用），并把签发的证书存放在密钥旁边。
私钥从不离开节点。证书的全部内容由面板决定（CN `agent-<node id>`，仅用于客户端认证，有效期 90 天，内置；agent 在剩余三分之一时续期）。

该 unit 只授予 `CAP_NET_BIND_SERVICE`（在 443 上建立入站），并把 bootstrap 文件作为 systemd credential 读取（systemd >= 250）。
它隐藏其他用户的进程（`ProtectProc=invisible`），但不隐藏节点状态所读取的机器级 `/proc` 文件（`/proc/stat`、`meminfo`、`loadavg`、`net/*`）：
W23 之前的 unit 带有 `ProcSubset=pid`，导致所有机器指标读出来都是 0；现在 agent 把读不到的内容上报为 **未知**（unknown），绝不是 0，
节点页会说明原因（§3e）。

**Token expired / agent state lost / certificate expired（令牌过期 / agent 状态丢失 / 证书过期）**
（agent 离线时间超过其有效期）：使用 **重装命令**（或为 bootstrap 文件使用 `akari server enroll-token <server id>`）。
当 bootstrap 文件带着尚未使用的令牌时，agent 会重新注册一次；此后该节点较旧的证书会被拒绝。
已使用、未知或过期的令牌都被同一个统一错误拒绝（“enrollment refused”），并且 agent 退出。

注册按来源地址和全局限流（每 10 分钟 10 / 60 次，内置）。

### Certificate renewal（证书续期）

协议 2 的 agent 在有效期剩余不足三分之一时自动续期（90 天中的第 60 天）：新的密钥和 CSR 经现有的 mTLS 连接发送，
agent 用新证书重新连接，面板第一次见到新证书时吊销旧证书。在此之前旧证书一直有效，所以中间崩溃或网络故障没有任何代价
（agent 只会再续期一次）。证书距过期不足 14 天的节点，在节点列表中带有警告
（协议 1 的 agent 永不续期：请升级它们，或在证书过期前重新注册；过期的证书会在 TLS 握手时被拒绝）。

如果想在不重新注册的情况下恢复节点，请备份 agent 的状态目录。

### Nodes added before M1c (bootstrap files with a private key)（M1c 之前添加的节点：带私钥的 bootstrap 文件）

它们无需任何操作即可继续工作：agent 仍接受 bootstrap 文件（v1）中的 `identity.cert_pem` / `identity.key_pem`，面板也保留其证书（2 年有效期）。
升级 agent（第 5 节）并给它一个状态目录（新的 unit 文件）；在第一次续期时，它换用节点上生成的密钥，面板吊销旧的、由面板生成的密钥。
然后从 `/etc/akari-agent/bootstrap.toml` 中删除 `cert_pem`/`key_pem`。如果想立即迁移而不是等到续期，
请为该节点签发新的注册令牌并安装那份 bootstrap 文件。

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

## 3g. First user: node group, plan, subscription（第一个用户：节点组、套餐、订阅）

访问权限按套餐授予（M3）：拥有生效套餐的用户可以使用该套餐所含节点组中的每个节点；节点、组和套餐之后都可以改动，每个节点会自行收敛。

1. **套餐 → 新建节点组**：命名并勾选节点。
2. **套餐 → 新建套餐**：流量额度、重置周期（每月……）、可选的限速；勾选节点组
   （到期时间在分配给用户时设置，或由商店的购买周期决定）。价格只对商店有意义（docs/PAYMENTS.md）。
3. **用户 → 新建用户**：登录名和密码，然后在该用户上 **分配套餐**。节点在一两秒内收到该用户
   （`POST /api/v1/users`、`PUT /api/v1/users/{id}/plan
   {"plan_id": …, "period": "month"}`；`period` 必填：`month` … `three_year`、带 `"days": N` 的 `days`，
   或 `onetime`（可选 `days`，不填 = 永久）；见 README 的 API 表）。
4. 用户在 `https://panel.yourdomain.com/`（门户）登录并复制 **订阅链接**（管理员在该用户上看到同一个 URL，`sub_url`）。
   链接根据客户端的 User-Agent 返回它所要的格式：Clash/mihomo YAML、sing-box JSON，或 base64 分享链接（v2rayN、Shadowrocket 等）；
   额度和到期时间通过 `subscription-userinfo` 传递。
5. 在客户端中导入链接并连接。用量约 15 秒内显示在用户上（agent 每 10 秒上报，每 5 秒刷新一次）。

**重新生成订阅令牌** 会立即使旧链接失效（用户也可以在门户里这样做）。

### 订阅格式、客户端与分流规则（W30，中文）

**按客户端自动选择格式**（User-Agent；链接加 `?format=clash|sing-box|links` 可强制指定）：

| 客户端 | 收到的格式 | 门户「一键导入」 |
|---|---|---|
| Clash Verge (Rev)、Clash Meta for Android、FlClash、Mihomo Party | Clash（mihomo）YAML + 分流规则 | `clash://install-config?url=…&name=…` |
| Stash | Clash YAML + 分流规则 | `stash://install-config?url=…&name=…` |
| sing-box 官方 App（SFA/SFI/SFM/SFT） | sing-box 1.12+ 完整配置（TUN、本地 mixed 127.0.0.1:2080、DNS、PROXY 选择器、规则集） | `sing-box://import-remote-profile?url=…#名称` |
| Shadowrocket | base64 分享链接 | `shadowrocket://add/sub://<URL 安全 base64，无填充>?remark=…` |
| Hiddify | base64 分享链接（Hiddify 内核较旧，且对导入的链接套用自己的分流设置：在 Hiddify 里把「区域」设为中国） | `hiddify://import/<订阅链接>#名称` |
| v2rayN / v2rayNG / 其他 | base64 分享链接 | — |

每个入口都是订阅里单独的一个节点，倍率不是 1x 时名称里带**当前**倍率（D9）。

**分流规则模板**（系统设置 → 订阅，`PUT /api/v1/settings/subscription`）：Clash 与 sing-box 订阅按顺序带上
这些规则，最后「其余全部走 PROXY」。内置默认：广告拦截（`geosite:category-ads-all` → 拒绝）、国内直连
（`geosite:private`、`geoip:private`、`geosite:cn`、`geoip:cn` → 直连）、国外代理（其余）。规则类型：
geosite / geoip（规则列表名，如 `cn`、`geolocation-!cn`）、domain、domain_suffix、domain_keyword、ip_cidr；
动作：direct / proxy / reject；最多 64 条；`rules: null` 恢复默认，`[]` = 不带规则。geosite/geoip 在 Clash 里是
`rule-providers`（文本列表，Stash 也支持），在 sing-box 里是远程规则集（.srs），由**客户端自己下载**，默认来自
jsDelivr 上的 MetaCubeX meta-rules-dat；国内访问 jsDelivr 不稳定时可改成镜像（`rule_set_clash_url` /
`rule_set_singbox_url`，必须是 https 且包含 `{name}`，可含 `{kind}` = geosite|geoip）。规则下载在客户端首次
启动时经代理进行（规则未加载前全部流量走 PROXY）。修改写审计 `settings.subscription.update`。

**订阅格式开关与一键导入开关**（PR ② §5，同一接口的 `formats` / `import_clients`，写审计）：可以分别关闭
Clash、sing-box、base64 链接三种输出格式，以及门户里每个客户端的一键导入按钮（默认全部开启）。关闭的格式
对订阅链接的回答与无效令牌**完全相同**（统一的 404，不会透露「已关闭」）：显式 `?format=` 指向关闭的格式、或
识别出的客户端所用格式已关闭 → 拒绝；无法识别的客户端按 链接 → Clash → sing-box 的顺序落到第一个开启的格式。
格式关闭时它的导入按钮也自动隐藏。保存的是「开启的列表」：以后新增的格式（包括自研客户端的通道）对已自定义
列表的站点默认是关闭的——全部第三方格式都关掉后，就只剩自研客户端可用。

**验证情况**（云端/CI 没有图形客户端，以下是实际做过的）：mihomo v1.19（`mihomo -t` 校验配置，并实际运行加载
rule-providers）与 sing-box 1.14（`sing-box check`，并实际运行加载远程规则集）对生成的配置验证通过；黄金文件
（`testdata/w26/sub_*.golden`、`w30_*.golden`）锁定每种格式与每个客户端 UA 的输出。**未用真实 GUI 客户端验证**：
Clash Verge Rev、Clash Meta for Android、FlClash、Mihomo Party、Stash、Shadowrocket、SFA/SFI/SFM、Hiddify、
v2rayN —— 导入链接按各客户端公开文档的格式生成，上线前请在真机上各导入一次。

## 3b. REALITY inbounds（REALITY 入站）

REALITY 入站借用真实站点（`dest`）的 TLS 握手，并放行知道你公钥的客户端。实践中有三件事容易出错。

**选一个当前 xray-core 接受的 `dest`。** 并非每个站点都适用于每个 xray 版本。2026-10-01 在 xray 26.3.27 上，
`www.microsoft.com:443` 失败了（agent 日志显示 `REALITY:
processed invalid connection ... handshake did not complete`），而 `www.apple.com`、
`dl.google.com`、`www.cloudflare.com` 和 `addons.mozilla.org` 可用。xray 升级后请重新检查。目标需要支持 TLS 1.3 和 H2；
在依赖它之前，先从节点上用独立的 xray 测试（任一台 xray 版本相同的机器，reality 客户端写在一个文件里）：

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

节点表单的 REALITY 模板会替你完成下面所有这些（密钥对、short id、`publicKey`/`shortId`/`fingerprint`）；本节其余部分是给手写 JSON 的人看的。

**面板的入站必须带 `publicKey`。** xray 服务端只需要 `privateKey`；面板用同一份 JSON 生成订阅，
所以也从 `realitySettings` 读取客户端侧字段：`publicKey`（必填，没有它订阅就是坏的）、`shortId`
（发给客户端的一个 id；必须是 `shortIds` 之一）以及可选的 `fingerprint`。这些仅供面板使用的字段 xray 并不使用。
订阅中的 REALITY 始终带有 uTLS 指纹（链接里的 `fp=`、Clash 里的 `client-fingerprint`、sing-box 里的 `tls.utls`）：
若设置了 `fingerprint` 且为 `chrome`、`firefox`、`safari`、`ios`、`android`、`edge`、`360`、`qq`、`random`、`randomized` 之一，则用它；
否则（或为任何其他值）用 `chrome`。

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

`serverNames[0]` 是客户端发送的 SNI。用户的 flow 取自入站的 `settings.flow`
（要用 Vision，就像模板那样在 `settings` 中加 `"flow": "xtls-rprx-vision"`）；之后修改它会更新每个用户的凭据（id 不变），订阅随之更新。

## 3d. Protocol / transport matrix (W8, agent xray-core v26.3.27)（协议 / 传输矩阵）

每一行都做过端到端检查：模板 → `validate_inbound` → 每用户凭据 → agent 应用（gate 吊销）→ 三种格式的订阅 → 真实客户端转发流量
（`smoke.sh` W8 段：可用时用 mihomo 1.19 和 sing-box 1.12+；agent 的 `TestRT_ProtocolMatrix` 金丝雀用 xray 自带客户端，含计费和吊销）。

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

格式无法表达的代理会从该格式中省略（以 info 级别记录原因），而不是渲染成客户端会拒绝的配置。

**Shadowsocks 2022 的特殊之处。** 多用户 Shadowsocks 需要使用 AES 方法：
`2022-blake3-chacha20-poly1305` 在 xray 中没有多用户服务端，旧式（非 2022）方法没有每用户密钥，二者都会被拒绝（400）。
`settings.password` 是服务端 PSK（base64，aes-128 为 16 字节，aes-256 为 32 字节），`settings.clients` 必须是 `[]`；
每个用户有自己的密钥，客户端用 `server_psk:user_key` 连接。更改方法会重新签发所有用户密钥（订阅必须刷新）。
xray 的多用户 Shadowsocks 入站在运行时无法从其表中去掉用户，否则会与自己的连接路径产生竞争
（被移除用户正在进行的握手可能以另一个用户的身份运行，或使 agent 崩溃）。因此协议 5 及以后的 agent（W9）从不去除：
**被移除的用户在 agent 的 gate 中被吊销，其密钥作为墓碑留在 xray 的表里**，所以移除（以及重新加回同一密钥，例如续期的套餐）是实时增量，
不影响其他用户的连接。**轮换某个用户的密钥仍会重建节点**（Snapshot：该节点上的所有连接断开一次），
墓碑数量超过上限（每个入站 max(1024, 在线用户数)；重建时会压实）的移除也一样。
对于较旧的 agent，从 Shadowsocks 入站移除任何用户都会重建节点。新增则始终是实时增量。

**Hysteria 2** 像 TLS 模板一样使用节点证书（设置 节点域名 时自动获得，§3f）；不得设置 `hysteriaSettings.auth`
（共享密码会绕过每用户认证）；带宽/拥塞设置保持 xray 的默认值。

**被拒绝（400）** 的情形，原因在错误信息中给出：原始 TCP、WebSocket、HTTPUpgrade、XHTTP（`splithttp`）、gRPC
（以及 Hysteria 2 的 `hysteria`）之外的传输，例如 mKCP；`security` 不是 none/tls/reality；
REALITY 用于 VLESS over 原始 TCP/XHTTP/gRPC 之外的组合；Vision 用在带 TLS/REALITY 的原始 TCP 之外的传输上；
VLESS `decryption` 不是 `none`（订阅中不含 VLESS Encryption）；非法的 path（必须以 `/` 开头，不含空格/引号/`#`）、Host 值、
XHTTP mode（`auto`、`packet-up`、`stream-up`、`stream-one`）或 gRPC service name；非数字端口；入站数组（每个节点一个入站，W28-a）。
在这些检查加入之前保存的入站继续可用；节点列表在 `warnings` 下显示它们。

**gRPC（R26）。** 当 agent 的 grpc-go 受 GO-2026-6443 影响时，gRPC 曾被拒绝。agent 现在把 grpc-go 固定到上游已修复的 commit
（`v1.85.0-dev.0.20260825072537-93e31b48545e`；v1.85.0 发布后会移到该 tag），VLESS/VMess/Trojan 的 gRPC 已恢复。
（该公告涉及 grpc-go 的 xDS 服务端路径；xray 的普通 gRPC 服务端不在受影响路径上，但固定版本使 `govulncheck` 无需 allow-list 即可保持干净。）

**内嵌内核不支持：** TUIC（xray-core 没有 TUIC）。不会添加其他内核。
Hysteria 2 之所以受支持，是因为 xray-core v26.3.27 把它实现为多用户入站。

## 3e. Node status, latency tests and the traffic multiplier (W11)（节点状态、延迟测试与流量倍率）

**机器状态。** 具备 `metrics` 能力的 agent（W11 agent）在每次心跳（15 秒；`akari-agent -heartbeat-interval` 可改，1 秒 – 5 分钟）中加入机器状态块：
CPU %、负载 1/5/15、内存和 swap、`/` 的磁盘、默认路由网卡（自上次心跳以来的速率及开机以来的累计）、在用的 TCP/UDP socket、被代理的连接、
在线用户（有活动连接的不同用户）、agent RSS、运行时间和 xray 版本，全部来自 `/proc` 和 `statfs`，无需额外软件包或权限。
面板把最新值保存在 Valkey（任何实例都能提供），历史保存在 PostgreSQL：每个节点每分钟一行（48 小时），由 reaper 循环汇总为小时（90 天）；
200 个节点时最多约 576k 条分钟行和约 432k 条小时行，每个节点每次心跳一次小 upsert（限流为每 5 秒一次）。
节点是否离线的判定与之前完全一样（90 秒内没有新会话）。较旧的 agent 照常工作：其节点只显示 CPU/内存/连接数。

**Unknown is not 0（未知不等于 0，W23）。** agent 读不到的值（来源文件缺失或被沙箱隐藏；第一次心跳或计数器重置后的速率）
显示为 **未知**：在节点列表、节点页和历史图表中表现为断点，绝不是 0；CPU/内存告警规则把这样的分钟视为未决。
具备 `metrics-presence` 能力的 agent（W23 起的 agent 发布版）把这类值留空；对于较旧的 agent，留空仍表示 0。
使用 W23 之前 unit（`ProcSubset=pid`）安装的节点，CPU、内存、负载、网络和 socket 显示为 未知，并附带提示，
从第一个 W23 agent 起还会有 “systemd 单元” 警告：执行一次 **重装命令** 即可（§5b “Units”）。

**Latency（延迟，Clash Verge url-test 语义）。** 每个 测速间隔（系统设置 → 测速，默认 5 小时，±10 % 抖动）以及点击 “立即测速” 时
（管理员节点详情；每个节点最多每 30 秒一次，内置）：

- agent（能力 `latency`）从**自己的出口**向第一个测试 URL 发 `GET`（不经过 xray，也不经过 `HTTP(S)_PROXY`）：
  延迟 = 请求开始 → 响应头（DNS + TCP + TLS + 首字节，每次尝试都是新连接），取 `attempts` 次（3 次，失败的尝试按 5 秒超时计；两者都内置）的中位数；
  当所有尝试都失败时，改试下一个 URL（默认 `https://www.gstatic.com/generate_204`，然后是 `https://cp.cloudflare.com/generate_204`）。
  节点需要能对它们发起出站 HTTPS；
- 面板（任一实例，在数据库中领取行）测量到每个入口面向客户端地址（其 连接地址/连接端口，否则为 节点域名 和入站端口；结果的目标是入口名）的 TCP 连接时间。
  仅 UDP 的入站（Hysteria 2）显示 “n/a”。面板主机不应拨号节点时，请关闭 面板 TCP 测速。

徽标：< 200 ms 绿色，< 500 ms 琥珀色，否则红色，超时灰色。用户在门户中看到可见节点中自己可用入口的 agent 结果（在线、倍率、标签）；
绝不会看到地址或机器数据。

间隔（600 秒 – 7 天）、测试 URL 和 面板 TCP 测速 只在管理控制台中设置
（系统设置 → 测速；`PUT /api/v1/settings/probe`；W25：panel.toml 中不再有 `[probe]`，旧段落会被导入一次，见 §1 “Upgrading”）。
每次更改都有版本并写入审计（`settings.probe.update`），每个面板实例立即应用，并把新设置重新发给已连接的 agent
（无需重启；间隔变化时 agent 会重新调度）；间隔缩短也会把已排期的面板 TCP 测试提前。`akari settings unset probe` 恢复上述默认值。

**流量倍率（倍率）。** 倍率属于入口（W28-a：用户流量按入口计量，并按该入口的倍率计费）。
计费字节 = 每个计数器行的 floor(已接受字节 × 倍率)，只在刷新 SQL 内计算（绝不在面板内存里）；
上报被刷新时生效的倍率适用于该上报的增量（更改倍率绝不会重新计过去的账）。已离开用户的最终计数以同样方式计费；
所有合理性上限都作用于已接受的（原始）字节。节点列表和详情页显示两个总数（`traffic_raw_bytes`、`traffic_billed_bytes`）。
0 = 免费入口。隐藏的节点（`visible = false`）继续为其套餐所授予的用户提供服务；它们只是不出现在门户和订阅中。

**分时段倍率（D9，中文）**：入口的倍率 = 基础倍率（`PATCH /api/v1/entrances/{id}` 的 `rate`）+ 最多 24 条
时段规则（`PUT /api/v1/entrances/{id}/rate-rules {"rules": [{"weekdays": [1..7], "start": "HH:MM",
"end": "HH:MM", "rate": 1.5}]}`，整体替换，`{"rules": []}` = 清空）。星期按 ISO（1 = 周一 … 7 = 周日），时间按
**站点时区**（系统设置 → 站点，默认 Asia/Shanghai），区间为 [开始, 结束)，结束 `24:00`（或 `00:00`）= 当天午夜，
结束早于开始 = 跨午夜（属于开始那天，延续到次日）。不在任何规则内用基础倍率；多条规则重叠时取**最高**的倍率，
保存时响应的 `warnings` 会逐条列出重叠的规则与时段。结算只在 SQL 里（`akari_entrance_rate()`），取「结算时刻」与
「30 秒前」两者中**较低**的倍率：跨时段边界的流量只会少计、不会多计（时段以分钟为单位，30 秒内至多跨一个边界）。
订阅里的节点名、门户节点列表（`/me/nodes` 的 `rate`）、流量明细（`/me/traffic` 每节点的 `rates`）和后台入口
（`rate_now`、`rate_rules`）显示的都是**当前**倍率。规则变更写审计 `entrance.rate_rules.set`（前后规则全文）；
改规则不需要 agent 做任何事（不 bump）。


**Prometheus。** metrics 监听器增加了该实例所连接节点的全局汇总
（`akari_fleet{kind="nodes_reporting"|"online_users"|"connections"|"rx_bytes_per_second"|"tx_bytes_per_second"}`、
`akari_fleet_cpu_percent_max`；对各实例求和）。按设计没有每节点的序列：节点 id 和名称会是无界的 label 值；
每节点历史在面板中（`/servers/{id}/metrics`）。每节点的告警阈值留作后续工作。

## 3f. Automatic node certificate (节点域名, W10, agent protocol 6)（节点自动证书）

在服务器上设置 **节点域名**（向导或节点页；新服务器用 `POST /api/v1/nodes` 的 `tls_domain`，已有的用 `PATCH /api/v1/servers/{id}`），
每个读取节点证书文件的入站就会得到该域名的 Let's Encrypt 证书，由 agent 获取并续期。只有带这类入站的节点才会申请
（仅 REALITY 的节点从不申请）。管理员要做的是：为该域名添加指向节点的 `A`/`AAAA` 记录（仅 DNS，不经 Cloudflare 代理），并向互联网开放 TCP 80。
表单中的 **检查解析**（失败时节点页也有）会把域名的解析结果与节点的公网地址以及其 agent 连接所用的地址做比较；它只警告
（安装之前节点地址未知）。

agent 的做法（详见 akari-agent 的 `acme.go`）：

| Situation on the node | Challenge |
|---|---|
| TCP 80 未被入站使用且空闲 | 在 :80 上做 HTTP-01（默认；agent 只在申请期间监听 :80） |
| 80 被占用（入站或其他程序），TCP 443 未被入站使用且空闲 | 在 :443 上做 TLS-ALPN-01 |
| 80 被占用且 443 被入站使用（如 443 上的 VLESS-WS-TLS）或被占用 | 失败，提示 “80 端口被占用”：请释放 TCP 80 |

不支持 DNS-01（通配符、没有入站 80/443 的节点）。连接或 DNS 失败之后，下一次申请在另一种挑战可用时会改用它。

- **存储**：agent 的状态目录（`/var/lib/private/akari-agent/tls/<domain>/`
  `fullchain.pem` + `privkey.pem`，0600；ACME 账号密钥在 `tls/accounts/`），而不是 `/etc/akari-agent/tls`：
  agent 在 `ProtectSystem=strict` 下以动态用户运行；systemd 管理状态目录的属主。请与状态目录的其余内容一起备份。
- **在拿到第一张证书之前**，TLS 入站使用自签占位证书（其他入站正常启动）；签发的证书会立即替换它，只重启那些 TLS 入站。
- **续期**在有效期剩余三分之一时进行（90 天中约第 60 天，带抖动；ARI `replaces`）。文件被原子替换，xray 在一小时内重新读取
  （它自己的证书重载；不要在手写 JSON 中设置 `oneTimeLoading`）：不重建，不断开连接。
- **失败**后退避，从 5 分钟翻倍到 6 小时（收到限流应答后至少 1 小时）；每次尝试只做一种挑战，使失败的验证低于 Let's Encrypt 每主机名每小时 5 次的限制。
  `systemctl restart akari-agent` 会立即重试（例如修好 DNS 之后）。
- **状态**（节点页，来自 agent 的心跳）：证书有效 + 到期和续期日期，或用大白话说明的错误
  （域名无法解析 / 域名未解析到本机 IP x.x.x.x / 80 端口不可达 / 80 端口被占用 / 频率限制 / CAA / CA unreachable），
  原始 ACME 错误在 详细错误 下。
- **面板设置**（系统设置 → 节点通信）：ACME 目录（空 = Let's Encrypt 正式环境；staging：`https://acme-staging-v02.api.letsencrypt.org/directory`）
  和 ACME 邮箱（可选的账号联系人）。更改会立即到达每个已连接的节点（对使用节点证书的节点是新的 Snapshot）。
  W25：panel.toml 中的 `[acme]` 会被导入一次，之后被忽略。
- **协议低于 6 的 agent** 忽略该域名，照旧读取 §3 的文件；节点页会提示（升级 agent，§5b）。
  更改 节点域名 会向节点发送新配置（重建：其连接断开一次）。节点没有设置公网地址时，订阅使用 节点域名 作为服务器地址。
- 不支持：ZeroSSL / EAB CA（任何不需要 external account binding 的 CA 都可通过 `directory_url` 使用）、每个节点多个域名、DNS-01。

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
- **开启时**该节点**每个启用的入口**（直连入口与每个中转入口各自的入站，见 §3 的「中转入口（relay）」）都受规则约束：经中转入口连接的用户与直连用户一样被拦截、一样计数；直连入口停用时中转入口照样拦截。这些入站开启嗅探（`routeOnly`：嗅探结果只用于路由，不改变连接目标；入站 JSON 里已经自己配置了 `sniffing` 的保持原样）。嗅探会等待客户端的第一个数据包（xray 默认最多约 300 ms），服务器先发数据的协议（如 SSH、SMTP）首包延迟会增加。
- **开关时会断开哪些连接**：只重建这个节点的入站监听（直连与中转入口的入站）（不重建 xray，其他节点不受影响，用户与计费不变）。以下是 agent 金丝雀测试（`rt_block_canary_test.go`，真实 xray 客户端逐个协议组合）实测结果：
  - **保留**：raw TCP / TLS / REALITY（含 Vision）、WebSocket、HTTPUpgrade、VMess TCP、Shadowsocks 2022、以及 TLS/REALITY 上的 XHTTP（一条长 HTTP/2 请求）。
  - **断开一次、客户端自动重连**：gRPC（流属于监听端的 HTTP/2 服务）、明文 HTTP 上的 XHTTP（客户端 packet-up 模式，每次上传都是新请求）、Hysteria 2（QUIC 连接属于监听端）。
- **修改规则内容**（增删改规则、开关某个规则集）**不断开任何连接**：agent 原子替换整套路由规则，不重建入站、不重建 xray。规则只作用于新建立的连接（路由在每次分发时决定）：已经建立的连接即使命中新规则也继续转发，直到客户端重连。
- agent 版本过旧（没有 `block-rules` 能力）时开关无效，`GET /api/v1/nodes/{id}/block-rules` 的 `agent_supported` 为 false。

**统计**：`GET /api/v1/nodes/{id}/block-rules?days=7`（1–90）返回开关状态、agent 是否支持、当前生效的规则版本是否与面板一致（`in_sync`、`error`）、以及最近 N 天（按站点时区的日，见 §2b「站点时区」）每条规则的拦截次数；规则列表里的 `hits_7d` 是全部节点近 7 天合计。**只记录每个节点每条规则的拦截次数，不记录任何用户或访问目标。**日数据保留 90 天。

## 3c. Resource footprint (measured)（资源占用，实测）

一次真实部署在 1 vCPU 级别、920 MB 内存的 VPS 上（Debian 13，compose，仅 IP），空闲时的常驻内存：
panel 5 MB、PostgreSQL 56 MB、Valkey 8 MB、Caddy 17 MB、agent 27 MB。整套服务加一个 agent 可以装进 1 GB 的机器并有富余。
按本指南完成的第一次完整部署（含排错）用了约 23 分钟。

**Timed fresh-deploy drill（计时的全新部署演练，2026-10-02，W14）。** 干净的 Debian 13 机器（systemd 容器：
一台用 Debian 软件包安装 Docker 的面板主机、一个节点、一个客户端），逐字照着 §A → §2 → §2b → §3 → §3g 操作，
镜像通过 digest 从 registry 拉取（首个发布之前用来代替 ghcr.io），使用 `myapp.test` 与 `AKARI_CADDY_OPTIONS=local_certs`。
“机器”列是每步的机器耗时；“阅读与输入”是估计的人手工在控制台操作的耗时。

| Step | Machine | Reading and typing |
|---|---|---|
| 0. 安装 Docker + git（`apt-get`） | 22 s | 2 min |
| 1–3. 克隆、env 文件、密码、域名、镜像行 | 2 s | 6 min |
| 4. `config check`（拉取 panel、PostgreSQL、Valkey 镜像） | 39 s | 1 min |
| 4. `up -d`、`akari info` | 4 s | 1 min |
| 4. `up -d`（拉取 Caddy + 证书），`/healthz` 200 | 49 s | 2 min |
| §2 第一个管理员，登录 | 1 s | 2 min |
| §2b 主域名 | 1 s | 1 min |
| §3 新建节点（REALITY 模板）→ 带钉扎的安装命令 | 1 s | 3 min |
| §3 在节点上运行安装命令 → SUCCESS，节点在线 | 7 s | 2 min |
| §3g 节点组、套餐、用户、分配套餐 | 1 s | 4 min |
| §3g 把订阅导入客户端（xray 26.3.27），连接，用量被计费 | 5 s + 15 s | 3 min |
| **Total** | **~2.5 min** | **~27 min** |

客户端通过节点获取了 `https://www.gstatic.com/generate_204`（204）和 5 MB，15 秒内在用户上显示为 5.02 MB。
演练发现的缺口已在本节修复（Docker 安装、密码/域名/前缀命令、空数据库上的 `config check` 提示、没有公共 DNS 的名称、§2b、§3g），
并在 compose 文件中修复（Debian 的 compose 2.26 拒绝嵌套的 `${VAR:?}`）。

## 4. Observability (optional)（可观测性，可选）

设置 `[metrics] bind = "127.0.0.1:9100"` 并抓取它（`deploy/prometheus/`）。告警规则：
`deploy/prometheus/alerts.yml`（单元测试在 `alerts_test.yml`；`make monitoring-check` 运行 promtool，并检查每个仪表盘/规则用到的指标都存在）；
仪表盘：`deploy/grafana/akari-dashboard.json`（面板内部）和 `deploy/grafana/akari-fleet.json`
（W17：来自 W11 心跳和节点告警的集群健康）：导入 Grafana，选择 Prometheus 数据源。
指标 label 从不包含后台前缀或节点 id：每节点的详情在控制台的节点页和 告警中心（§4b）。
被接受的请求的每个响应都带有 `X-Request-Id`（传入的若短且可打印则复用）；它出现在该请求的日志行中。拒绝响应从不带它。

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

## 4b. Node alerts and notifications (告警中心, W17)（节点告警与通知）

面板自己监视整个集群；Prometheus 是可选的。控制台 → **告警** 显示正在触发的告警（及历史）、阈值和通知渠道。默认值：
开启，离线 > 300 秒，CPU / 内存 > 90 % 持续 5 分钟，磁盘 > 90 %，证书（节点自动 TLS 证书 W10，或 agent 的 mTLS 证书）14 天内到期，
某个来源的所有延迟测试目标都失败，配置应用失败，中转入口被隐藏（`entrance_down`），以及
（D5）服务器流量额度用完（`traffic_quota`，服务器恢复时解除）。
告警按**服务器**计（Q1：一个 agent）。阈值留空 = 关闭该规则；节点页（告警规则）可按服务器覆盖阈值、关闭某类告警，或静音该服务器（告警被记录，但不通知）。

- **单一评估者**：每个实例每 30 秒（内置）运行一轮，但只有赢得 PostgreSQL advisory lock 的那个才评估，其他的跳过。
  事实来自数据库和 Valkey，所以任何实例算出的结果相同。
- **状态**：每个（节点，类型）从 firing → resolved，最多一条 firing 行（去重）。离线节点的实时类型（CPU、内存、磁盘、延迟、节点证书）在它再次上报之前保持其状态。
  CPU/内存在最近 N 个完整分钟的平均值都高于阈值时触发，最近一分钟不高于阈值时立即解除。
  在最近一次已通知告警之后的 `重复告警冷却` 分钟内再次触发，只记录不通知；“恢复” 只在已通知的触发之后才通知（可选）。
- **投递**：每个渠道一条排队的通知，由任一实例投递（领取 + 租约），带退避重试（30 秒起翻倍，8 次），之后在 通知记录 中标记为失败（有重试按钮）。
  至少一次：崩溃后接收方可能收到两次；请按 `X-Akari-Delivery` 去重。

**Telegram**：用 @BotFather 创建 bot，把它加入群组/频道，输入 bot token 和 chat id（数字；群组和频道为负数，或 `@channelname`），保存，然后 发送测试。
面板只调用 `sendMessage`（向 api.telegram.org 的出站 HTTPS；无需开放入站）。token 用由 `data/master.key` 派生的密钥加密存放，之后不再显示
（丢失 `master.key` 意味着需要重新输入）。对于屏蔽 Telegram 的网络，请把 **Telegram API 地址**（系统设置 → 告警）设为自托管的 Bot API 服务器
（https；仅 origin；空 = `https://api.telegram.org`）。W25：旧的 `[alerts] telegram_api_url` 会被导入到这里一次。

**Webhook**：`POST <url>`（https；明文 http 仅限 localhost），JSON body：

```json
{"event": "firing", "title": "[告警] hk-1：节点离线", "text": "…",
 "alert": {"id": 7, "node_id": "…", "node_name": "hk-1", "kind": "offline",
           "value": "离线 6 分钟", "detail": "…", "fired_at": "…", "resolved_at": null}}
```

`event` 为 `firing`、`resolved`、`test` 或 `billing`（测试和 billing 时 `alert` 为 null；
`billing` 事件，中-2：面板无法履约并已自动退款到客户余额的已支付订单，带有 `billing: {order_id, out_trade_no, code,
refund_cents}`）。请求头：
`X-Akari-Event`、`X-Akari-Delivery`（通知 id）、`X-Akari-Timestamp`（unix 秒）和
`X-Akari-Signature: sha256=<hex>` = HMAC-SHA256(secret, `<timestamp>.<raw body>`)。信任 body 之前先验证，并拒绝过期的时间戳：

```python
import hashlib, hmac, time
def verify(secret: bytes, headers, body: bytes) -> bool:
    ts = headers["X-Akari-Timestamp"]
    want = "sha256=" + hmac.new(secret, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, headers["X-Akari-Signature"]) and abs(time.time() - int(ts)) < 300
```

任何 2xx 都算成功；408/429/5xx 和网络错误会重试；其他 4xx 为终态。

**Email**：经面板的 SMTP 发件箱（系统设置 → 邮件，W15）发给最多 5 个地址；配置好 SMTP 之后即可启用该渠道。

**Prometheus**：`akari_node_alerts_firing{kind}`（来自数据库：每个实例相同，用 `max` 聚合）、
`akari_alert_notifications_total{channel,result}`、`akari_alert_rounds_total{result}`；
`alerts.yml` 中的规则 `AkariNodeAlertsFiring`、`AkariAlertEvaluatorStalled`、`AkariAlertNotificationsFailing` 以及集群规则（`AkariFleet*`）。

**Support tickets（工单）**：客户在门户中提交工单（过期或超额时也可以），工作人员在控制台 → 工单 中回复（筛选、指派、关闭/重新打开）。
每位客户每小时最多提交 5 张工单，同时最多保持 5 张未关闭；回复每小时 30 条。新工单和员工回复的邮件通知在配置了 SMTP 时通过 SMTP 发件箱发送。

### Sizing（容量规划）

在 M2 目标下（200 个节点、5 万用户、每节点 1 万用户），数据库约有 200 万行 `entrance_users` 和 200 万行 `traffic_counters`。
请给 PostgreSQL 留够这部分工作集所需的空间（docs/PERF.md 中的测量使用 `shared_buffers` 2 GB、`effective_cache_size` 6 GB、`max_wal_size` 4 GB；
默认的 128 MB `shared_buffers` 太小），并且每个面板实例峰值约需 1.5 GiB 内存。

### Several panel instances (optional)（多个面板实例，可选）

一个实例即可承载 M2 目标（200 个节点 / 5 万用户，docs/PERF.md）。为了可用性或余量，可以运行两个或更多：

```
 admins, subscribers --> HTTPS reverse proxy (round-robin to the web ports)  --> panel A :8080, panel B :8080
 agents              --> L4 TCP balancer :8443 (TLS passthrough, no termination) --> panel A :8443, panel B :8443
 panel A, panel B    --> one PostgreSQL (direct connection), one Valkey
```

- 所有实例使用相同的 `database_url`、`valkey_url` 和完全相同的 `data_dir`（CA、`jwt.key`、`master.key`：共享该目录或逐字节复制）；
  各自有自己的 web 和 gRPC 绑定地址。
- gRPC 必须在 L4 做负载均衡。均衡器不能终止 TLS（agent 的客户端证书就是节点身份）。不需要会话保持：
  agent 可以落到任何实例，在别处重连会取代旧的流（旧实例在下一次读数据库时发现，60 秒内）。
- 必须直连 PostgreSQL：变更通知使用 `LISTEN`，事务或语句模式的 PgBouncer 会破坏它。
- 系统设置 的更改经同一个通知到达每个实例；当 server-name 集合变化时，各实例各自重新签发 gRPC 证书（无需重启）。
- 无需其他配置：变更通知、会话吊销、登录限流以及 flush/reaper/retention 循环都基于数据库/Valkey 且幂等，所以每个实例都运行它们。
  指标按实例提供（逐个抓取）。
- 一次升级一个实例，且在 agent 之后（第 5 节）；迁移在第一个启动的实例上运行，且只能前进。
- 由 `akari-bench multi` 和经均衡器的 200 个 agent 的 swarm 验证（docs/PERF.md）。

## 5. Upgrade (agents BEFORE the panel)（升级：agent 先于面板）

### v0.3.x → v0.4: fresh install only（v0.3.x → v0.4：只能全新安装）

v0.4 把迁移 0001–0168 压缩为单一基线 `migrations/1000_baseline.sql`（schema 相同；research/db-schema-review.md §7）。
v0.3.x 创建的数据库不能原地升级：

- 从 v0.3.x 安装执行 `akari-ctl upgrade` 会**在改动任何东西之前**停止（不备份、不切换），并报 `database from v0.3.x — fresh install required; see docs/DEPLOY.md`；
- 面板本身拒绝在这样的数据库上启动（`db::migrate`：任何 `_sqlx_migrations` 版本低于 1000），报相同的信息；这也涵盖手工部署、保留的数据卷和恢复的备份；
- **v0.3.x 做的备份不能恢复到 v0.4**（`install --restore` 在加载之后以相同信息停止）。

所以：记下你需要的东西（设置、套餐、用户），执行 `akari-ctl uninstall --purge --confirm
purge`（`/var/backups/akari` 下的备份会保留，但只能用于 v0.3），全新安装 v0.4，并重新注册节点（重装命令）。
v0.4 各发布版本之间的升级按下文进行。

**用安装器升级**（任何由它完成的安装，或 `/opt/akari-panel/deploy` 或 `/opt/akari` 下的 §A compose 检出，它会接管）：

```bash
akari-ctl upgrade                    # the newest release; --version vX.Y.Z for a given one
```

它运行目标发布版本自带的安装器（升级逻辑更新），像安装一样验证该发布（cosign + SHA256SUMS），然后：

1. **备份**（`/var/backups/akari/akari-<UTC>/`：数据库转储、数据目录、配置；
   在 `/etc/akari/install.env` 中设置了 `AGE_RECIPIENT` 时用 age 加密，否则是 0600 明文文件并给出警告，见 docs/BACKUP.md）；
2. 裸机：新二进制必须先对当前生效的配置通过 `config check`，才会切换任何东西；旧的保留为 `/usr/local/bin/akari.prev`，
   新的原子地移入，unit 和 Caddyfile 用发布包中的刷新，`systemctl restart`；
   Docker：刷新 compose 文件/Caddyfile，把 `AKARI_IMAGE` 设为新的 `tag@digest`，
   `docker compose pull panel` + `up -d`（PostgreSQL/Valkey/Caddy 跟随其大版本 tag）；
3. **健康检查**：2 分钟内 `/healthz`（Docker 为 3 分钟）。迁移在启动时、面板开始监听之前运行，所以面板健康就意味着已迁移；
4. 失败 → **自动回滚**到之前的二进制 / 镜像（以及 compose 文件），并再次检查健康。`akari-ctl`/备份脚本只在升级成功之后才被替换。

迁移只能前进：当失败的版本已经迁移了数据库时，旧版本会拒绝较新的 schema，回滚无法恢复健康；安装器会说明这一点，
并指出应当恢复的升级前备份（§6）。仍然遵循“先升级 agent”的规则（见下）。

**手动升级**（附录 A/B 的安装）：

1. 阅读发布说明中的协议变更。做一次备份（docs/BACKUP.md）。
2. 升级每个 agent（替换二进制，`systemctl restart akari-agent`；xray 重建会让现有连接断开一次）。
3. 升级面板：compose：验证新发布，并在 `.env` 中设置其 `AKARI_IMAGE=ghcr.io/akari-projectx/akari-panel:X.Y.Z@sha256:…` 行（“Verify a release” 第 3 步），
   然后 `docker compose pull panel && docker compose up -d panel`（0.2 之前、只有 `AKARI_VERSION=` 的 `.env` 仍可用，但未固定：请换成 `AKARI_IMAGE`）；
   裸机：替换二进制，`systemctl restart akari-panel`。迁移在启动时自动运行。
4. `akari config check`、`/healthz`，确认节点为 `online`。

**Compose 部署：deploy 文件也会变。** `deploy/` 下的检出（compose 文件、Caddyfile）是发布的一部分。
panel.toml 只保留启动键（W25）；其余一切都在 系统设置 中，所以新版本从不需要新的 panel.toml 段落，
废弃的键会被导入一次，之后只给警告（§1 “Upgrading: obsolete keys”）。每次升级：

```bash
cd /opt/akari-panel && git status --short       # local edits to tracked files (e.g. the Caddyfile)?
git checkout deploy/caddy/Caddyfile             # only after saving anything you still need
git pull --ff-only
cd deploy && docker compose run --rm panel config check   # lists obsolete keys to delete
docker compose up -d --force-recreate           # Caddyfile is a single-file bind mount (§A)
```

自 系统设置 版本（R22）起，compose 栈需要 panel.toml 中有 `[tls_ask]`（`bind =
"0.0.0.0:8082"`、`allow_non_loopback = true`，见 `panel.toml.compose.example`），以及新 compose 文件传给 Caddy 的 `AKARI_ASK` 变量；
缺少该段时，面板永远不会应答 Caddy 的 `ask`，所以在 系统设置 中保存的域名拿不到证书（AKARI_DOMAIN 本身不受影响）。
在新版本首次启动之前运行 `config check`，可能以
`# 系统设置: database not readable (… relation "panel_settings" does not exist …)` 结尾，升级时则是
`(… column "<name>" does not exist …)`（0.2 → 0.3：`probe_interval_secs`）：迁移尚未运行；这无害，首次启动后即消失。
真正有意义的是它上面的结论行（`configuration OK (0 warnings)`）。

**在 updater unit 之前安装的节点（W18；v0.4.0 及之前的 agent）：需手动处理一次。** 这些 agent 的自更新会从其 StateDirectory 执行新二进制，
而 systemd ≥ 256（Debian 13 带的是 257）会把 `DynamicUser` 服务的该目录以 `noexec` 挂载：更新会失败，报
`switch to vX: permission denied`（灰度发布会显示原因和修复办法；节点视图对每个没有 `updater` 能力的 agent 都会警告）。
对该节点执行一次 **重装命令**（先在 **Updates** 下上传当前发布版本）：它会原地安装当前 agent 和 updater unit
（`akari-agent-update.path/.service`），保留入站、用户和流量；此后更新经由面板进行。手动安装的 agent 也需要这两个 unit 文件
（`akari-agent -print-unit akari-agent-update.path` / `akari-agent-update.service`，§3 手动路径）；
没有它们时，当前版本的 agent 会以 “updater unit missing” 拒绝更新提议。

**unit 早于 W23 的节点（v0.4.x 及之前的 agent）：需手动处理一次。** unit 文件过去只在重装时改变；从 W23 起，每次更新都会安装新发布版本的 unit（§5b “Units”）。
执行这件事的是节点上*已安装的* updater unit，而 W23 之前的 `akari-agent-update.service` 对 `/etc/systemd/system` 是只读的：
更新到 W23 版本仍能完成（二进制可以，unit 不行，见 `journalctl -u akari-agent-update` 中的 `systemd units NOT refreshed`），
随后新 agent 会上报 unit 过期（节点警告 “systemd 单元…重装命令”；在此之前，其机器状态里的 CPU、内存、负载和网络显示为 未知，§3e）。
对该节点执行一次 **重装命令**（先在 **Updates** 下上传发布版本）；此后 unit 随发布版本更新，无需手动步骤。
这一步无法绕开：旧 updater unit 自己的沙箱禁止了写入，而新版本带来的任何东西在这次重装之前都无法在其沙箱之外运行。

**没有固定发布密钥的 agent**（协议 1/2，以及早于 v0.2.0 的协议 3 构建；`akari-agent -release-keys` 打印 “no release keys pinned”）无法自更新（§5b）。
在 **Updates** 下上传发布版本（你运行的每种架构），然后在节点页使用 **重装命令**（`POST /api/v1/servers/{id}/install`），并在节点上运行打印出的命令：
它会原地安装最新上传的发布版本并重新注册该节点（新证书签发后，其之前的证书被吊销；入站、用户和流量保持不变）。
这种情况下可以先升级面板：它向下兼容到协议 1 的 agent。

W11（节点状态、延迟、倍率）不需要提升协议版本：功能通过 `Hello.capabilities` 协商，较旧的 agent 照常服务（没有机器状态，没有 agent 延迟测试），
所以任一顺序都行；但仍然遵循先升级 agent 的规则。

为什么是这个顺序：新面板会丢弃没有 `session_id` 的流量上报，并对低于 `MIN_AGENT_PROTOCOL` 的 agent 返回空状态。
（M1c：协议 2 的 agent 可与旧面板配合：续期会因 “unimplemented” 失败并每小时重试；M1c 之前的证书有效期为 2 年。）
agent 的 unit 文件在 M1c 中增加了 `StateDirectory=`：请随 agent 一起安装新的 unit。

## 5b. Agent updates (M6: signed self-update, staged rollout)（agent 更新：签名自更新、分批灰度）

协议 3 的 agent 可以从面板更新。面板只做**中继**：agent 只有在其 manifest 由**编译进 agent** 的发布密钥签名（akari-agent 中的 `release-keys.txt`）、
平台匹配、且版本比当前运行的更新时，才会运行新二进制（签名的 `rollback` manifest 是唯一的降级方式，并且永远不会降到该节点已经回滚过的版本）。
被攻破的面板可以扣留或延迟更新，但不能推送未签名的、外来的或更旧的二进制。协议 1/2 的 agent 永远不会收到任何提议（需手动更新一次）。

**Release key custody（发布密钥保管）。** 一把 Ed25519 密钥，离线生成并保管（不在面板上，也不在构建主机上）：
在 akari-agent 中执行 `go run ./cmd/akari-sign keygen -out release.key`，会打印要加入 `release-keys.txt` 的公钥行。
请把 `release.key` 放在加密的离线介质上并保留第二份副本；持有它的人可以更新每一个节点。
agent 发布工作流只有在仓库 secret `AKARI_RELEASE_SIGNING_KEY` 持有该密钥时才对 manifest 签名（否则发布没有 manifest，并带警告），
并在发布前对照 `release-keys.txt` 检查。
轮换：把下一把公钥加入 `release-keys.txt` 并发布（agent 同时固定两把）；之后的发布用两把密钥签名（`akari-sign countersign`）；
一旦每个节点都运行了固定下一把密钥的构建，就移除旧的。密钥丢失或泄露时，需要手动发布 agent，并在每个节点上设置新的密钥集。

项目的生产密钥是 `key-f2ad18a8bb718a1a`（自 v0.2.0 起固定在 agent 中；保管与轮换：akari-agent README “Release signing keys”）。

**Panel side（面板侧）。** `release-keys.txt` 中的官方密钥也编译进了面板（副本在 `src/release-keys.txt`；与 akari-agent main 不同时 CI 会失败），
因此无需任何配置，上传就会被提前检查。你用来给自己构建签名的密钥放到 系统设置 → 安全 → 额外信任的发布公钥
（每行一个 `<base64> [label]`，最多 16 个）：agent 仍然只运行其自身编译进去的密钥所接受的内容。
W25：当 `[updates] release_keys` 与官方集合不同时，会被导入该列表一次；`max_concurrent_downloads` 是内置的（每实例 8 个 FetchArtifact 流）。

**Check for updates（一键检查更新）。** Updates 视图 → 「检查更新」：面板从 GitHub API 获取 `akari-projectX/akari-agent` 的最新 release，
为**每个 linux 平台（amd64、arm64）**下载二进制、其 `.manifest.json` 和 `.manifest.sig`，外加 `SHA256SUMS`，
并检查：manifest 签名（在受信任的密钥下：官方 + 额外）、每个文件对照 `SHA256SUMS`、平台、版本 = tag、大小，以及它不是 rollback manifest。
然后它像手动上传一样存储该发布（同一份代码，manifest 字节原样，审计行 `agent_release.create`/`.upload`），所有平台在一个事务中：
任何失败都不会存储任何东西，原因（带编码的错误，以中文显示）保留为 “上次检查”。它从不启动灰度；请使用下面的灰度表单。
- **Source（发布源）**：默认 `https://api.github.com/repos/akari-projectX/akari-agent/releases/latest`；
  可以在同一张卡片中设置兼容的镜像（存数据库，没有 panel.toml 键）。面板只联系该主机
  （对 api.github.com 还包括 GitHub 的下载主机 `github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`，资产下载会重定向到那里），
  走 HTTPS（明文 http 仅限回环），直连（不支持 HTTP 代理）：请放行到它们的出站 443。响应有大小上限和超时；整个检查最长 15 分钟。
- **不允许降级：** 如果源的最新版本比面板已持有的最新发布更旧，检查会被拒绝（`agent_update.downgrade`）。签名的 rollback 仍需手动上传。
- **自动检查**（默认关闭）：每 6 小时由一个面板实例以同样方式检查（审计操作者 `system`）。跨实例同一时间只运行一次检查（advisory lock）：
  第二次点击会得到 “已有更新检查在进行中”。
- 当最新的完整发布版本比某个可更新节点（协议 ≥ 3，平台已覆盖）运行的版本更新时，节点列表和仪表盘显示 **「有新版本 vX」**。
- API：`GET /api/v1/agent-updates`（设置、上次检查、最新发布、过期节点数）、
  `PUT /api/v1/agent-updates/settings {version, source_url|null, auto_check}`、
  `POST /api/v1/agent-updates/check`（202；轮询 GET 获取 `last_check`）。

**Publish a release by hand（手动发布，高级；Updates 视图或 API）：** 从 GitHub release 上传 `akari-agent-linux-<arch>` 及其
`.manifest.json` 和 `.manifest.sig`（先验证，见 “Verify a release”）。二进制存储在 PostgreSQL 中（1 MiB 一行，任何面板实例都能提供；
备份默认不含这些行，docs/BACKUP.md），agent 通过现有的 mTLS gRPC 连接下载它（`AgentChannel.FetchArtifact`）：节点不需要额外的出站。
```bash
curl -b cookies -H 'Content-Type: application/json' -X POST "$BASE/api/v1/agent-releases" \
  -d "$(jq -n --rawfile m akari-agent-linux-amd64.manifest.json --slurpfile s akari-agent-linux-amd64.manifest.sig '{manifest:$m, sig:$s[0]}')"
curl -b cookies -X PUT --data-binary @akari-agent-linux-amd64 "$BASE/api/v1/agent-releases/<id>/binary"
```

**Roll out（灰度发布）**（`POST /api/v1/rollouts {version, percentage?, server_ids?, waves?, health_timeout_secs?,
max_failure_ratio?}`；默认 100 %、所有已注册节点、`[100]`、600 秒、0.2）。waves 是所选节点的累计百分比（如 `[10, 50, 100]`），按固定的随机顺序；
当前一波的每个节点都健康、失败或被跳过后，下一波才开始。节点在以新版本重新连接并在超时内确认其配置时为 **healthy**；
在 agent 拒绝提议、下载/验证失败、回滚或超时时为 **failed**；在无法被提供更新时为 **skipped**
（协议 < 3、没有其平台的构件、开发构建、整个超时期间离线）。当 failed / (healthy + failed) > `max_failure_ratio` 时灰度 **halted**；
halted 的灰度只能被中止。暂停会停止发出新的提议（进行中的更新会完成）。每个操作和每次自动状态转换都在审计日志中
（`agent_release.*`、`rollout.*`；自动的以操作者 `system` 记录）。

**一键安装用哪个版本**：节点安装命令下载的是「最新的、完整的、且没有在灰度中失败的」发布。某个版本
最近一次灰度处于 halted（或 halted 之后被中止）时，新装/重装节点改用此前的版本（最后一个已知良好
版本），安装卡片给出警告；同一版本之后有一次未失败的灰度（例如修好节点后重新灰度并完成）即恢复使用它。
确认是坏版本后在「更新」页删除该发布。

**On the node（在节点上）**（W18；安装器会设置好它，§3；更早安装的节点：对其执行一次 **重装命令**，§5）。
agent 以一次性用户运行，其 StateDirectory 被 systemd 以 `noexec` 挂载；这一点保持不变（agent 能写入的任何东西都不会被执行）。
更新通过一个单独的 root unit 进行，它只运行**已安装的**二进制：
- agent 下载到 `$STATE_DIRECTORY/update/staged`（0600，永不可执行），检查大小、SHA-256、签名和版本策略，停止 xray
  （现有连接断开一次，与任何重启相同），持久化其最终流量计数（`update/finals.json`，由下一个进程重发），发送 `RESTARTING`，并写入 `update/apply-request.json`；
- `akari-agent-update.path` 启动 `akari-agent-update.service`（root，无网络，`ProtectSystem=strict`，只有 `/usr/local/bin`、`/etc/systemd/system`（W23）和 agent 的状态可写），
  它运行 `/usr/local/bin/akari-agent -apply-update /var/lib/private/akari-agent`。它把 agent 的目录视为不可信
  （不跟随符号链接；只收归 agent 所有的普通单链接文件），把暂存的二进制复制到 `/usr/local/bin/akari-agent` 旁边的仅 root 文件中，
  用**自身**编译进去的发布密钥验证**那份副本**（签名、平台、更新的版本或签名的 rollback，永不降到该节点已回滚过的版本；其自身记录在 `/var/lib/akari-agent-update`），
  把运行中的二进制保留为 `akari-agent.prev`，把新的重命名到位，安装新发布版本的 unit（见下）并重启 `akari-agent`。
  拒绝的结果会回传给 agent，agent 上报它（`FAILED`）并继续运行；
- 新二进制处于试用期：它必须在 `-update-self-check`（默认 5 分钟）内连接上并让一次 apply 被确认；updater 监视它，
  当它崩溃 `-update-max-boots` 次（默认 3）或未能及时通过时，把 `akari-agent.prev` 放回去（并重启 agent）（连同之前的 unit）。
  该版本随后在该节点上被标记为失败并上报（`ROLLED_BACK`），使该节点在灰度中失败；
- **Units（W23）。** 每个发布版本都带有其 systemd unit（编译进去；`akari-agent -print-unit <name>`）。验证副本之后，
  updater 用 `-print-units` 运行它（无网络、空环境、30 秒、输出有界：这就是它本来就要安装的二进制，绝不是 agent 目录里的任何东西），
  并替换 `/etc/systemd/system` 中的 `akari-agent.service`、`akari-agent-update.service` 和 `akari-agent-update.path`
  （只有这些名字、只在它们存在时、只在不同的时候），原子地（root，0644），被替换的保存在 `/var/lib/akari-agent-update/units.prev/`，然后 `systemctl daemon-reload`。
  回滚会把它们放回去（并重新加载）。drop-in（`akari-agent.service.d/`，例如安装器的 TLS credential drop-in）从不被改动：本地改动请放在那里。
  unit 无法读取的发布会被拒绝。W23 之前的 updater unit 无法写该目录：见 §5 “Nodes whose units predate W23”；
- `journalctl -u akari-agent-update` 显示 updater 做了什么；手动安装更新的 agent（或 重装命令）优先于 updater 记录的一切；
- **Alpine / OpenRC（W32）**：同样的交接，只是用 `akari-agent-update` 服务（一个每秒检查一次请求的 root 循环）代替 path unit，
  用两个 init 脚本代替三个 unit，用 supervise-daemon 的重启计数代替 `NRestarts`；差异与缺口（没有 updater 沙箱）见 §3h；日志 `/var/log/akari-agent-update.log`；
- `akari-agent -release-keys` 打印固定的密钥（“no release keys pinned” = 自更新关闭）。

## 6. Rollback（回滚）

agent 向后兼容，所以先回滚**面板**。当新版本未通过健康检查时，`akari-ctl upgrade` 会自动完成这件事（§5）。
手动回滚，或在一次“成功”的升级之后想撤销它：

- **没有运行迁移**（schema 相同）：裸机 `mv /usr/local/bin/akari.prev /usr/local/bin/akari
  && systemctl restart akari-panel`；Docker：把之前的 `AKARI_IMAGE` 行放回 `.env`，
  `docker compose up -d panel`（或 `akari-ctl upgrade --version <previous> --force`）。
- **运行过迁移**：迁移只能前进，旧二进制会拒绝较新的 schema。把升级前的备份与旧的二进制/镜像一起恢复：停止面板，恢复
  （docs/BACKUP.md “Restore”：先重新创建空数据库，即以 `postgres`（裸机）/ `akari`（Docker）身份，在 `postgres` 数据库上执行
  `DROP DATABASE akari WITH
  (FORCE); CREATE DATABASE akari OWNER akari;`，因为 `pg_restore --clean` 无法删除 `traffic_daily` 的分区；
  然后像安装器那样使用 `AKARI_PG_RESTORE_CMD`/`AKARI_DATA_DIR`：裸机 `runuser -u postgres
  -- pg_restore -p <port> -d akari --no-owner --role=akari --single-transaction`，数据目录
  `/var/lib/akari`；Docker `docker compose exec -T postgres pg_restore -U akari -d akari
  --no-owner --single-transaction`，数据目录 = `akari_akari-data` 卷的挂载点），然后启动旧版本。
  备份之后计入的流量会丢失；其余一切都回到备份时的状态。

恢复了数据库、同时保留旧 `data/` 的情况下，后台前缀（在数据库中）和 agent 证书保持不变。

## 7. Uninstall（卸载）

```bash
akari-ctl uninstall                  # services/units/containers go; data and configuration stay
akari-ctl uninstall --purge          # also database, data dir, configuration: type "purge" to confirm
                                     # (non-interactive: --yes --purge --confirm purge)
```

普通卸载会保留：裸机的 `/var/lib/akari`（CA 密钥、jwt.key、master.key）、`/etc/akari/panel.toml`、PostgreSQL 数据库 `akari`；
Docker 的 `/opt/akari` 和 `akari_*` 卷。再次运行安装器会接管它们（相同的后台前缀、相同的账号）。
如果 Caddy 是安装器装的，会被停止；如果之前就有，则恢复其之前的配置。`--purge` 会删除数据库和角色、数据目录、`/etc/akari`、Valkey 以及（Docker）卷；
软件包（postgresql-18、caddy、Docker）仍保持安装（需要的话自行 `apt purge`），并且
**`/var/backups/akari` 中的备份永远不会被删除**。purge 之后，每个节点都需要重新注册（CA 已不存在），除非你恢复备份。

## 8. Migration（迁移）

### Same host: bare metal ⇄ Docker（同一主机：裸机 ⇄ Docker）

```bash
akari-ctl migrate --to docker        # or --to bare
```

它会做一份安全备份（保留，已配置时加密）和一份用于迁移的明文转储（放在 0700 的临时目录，之后删除），停止当前服务，
以 **restore** 方式安装另一种模式（数据库通过 `pg_restore --single-transaction`，数据目录 CA、
`jwt.key`、`master.key` 连同属主一起复制），等待健康，然后停用旧服务
（它们的数据保留到你删除为止：裸机 `/var/lib/akari`、数据库 `akari`；Docker 的 `akari_*` 卷）。
会生成新的数据库/Valkey 密码；系统设置（域名、支付方式等）存放在数据库中，随之迁移。任何失败都会切回旧模式。
迁移期间面板不可用（一两分钟；agent 继续为用户服务并自行重连）。

### Host to host（主机到主机）

```bash
# old host
akari-ctl backup --out /root/move                           # age: --age-recipient age1... (recommended)
scp -r /root/move/akari-<UTC> new-host:/root/
# new host (fresh Debian/Ubuntu)
curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh \
  | sh -s -- --restore /root/akari-<UTC> [--age-identity backup.key] [--mode docker|bare] [--domain …]
```

新主机得到相同的后台前缀（数据库）、CA 和密钥，所以一旦域名指向新主机，**现有 agent 和订阅链接继续可用**：

1. 提前一天降低主域名/订阅域名/节点域名的 DNS TTL（60–300 秒）。
2. 在最后一次备份之前停止旧面板（`systemctl stop akari-panel` /
   `docker compose stop panel`），这样之后不会再有流量被计入（agent 保留自己的计数器并向新面板上报）。
3. 在新主机上恢复，然后切换 主域名、订阅域名 和 节点通信域名 的 A/AAAA 记录。
   agent 拨入节点域名：只要其解析器看到新地址，就会重新连接到新主机（节点自己固定的证书是面板 CA，它随数据目录一起迁移了）。
   以 **IP 地址** 注册的 agent 会继续拨那个 IP：请重新注册它们（重装命令），或让旧地址继续路由到新主机。
4. 在新主机上验证：`akari-ctl status`（healthz）、登录、节点变为 **online**、获取一个订阅链接。
5. 到此才停用旧主机（`akari-ctl uninstall --purge`）。

Caddy 会在新主机上获取新证书（主域名在启动时，其他的按需）。

## Installer tests (CI)（安装器测试）

`.github/workflows/ci.yml`，jobs `installer-*`，脚本在 `scripts/installer-test/`。在 pull request 中，当安装器、部署包、备份/恢复或 Dockerfile 改变时
（`scripts/ci-changes.sh` 的 `installer` 组）或带有 `full-ci` 标签时运行；在 main 上、每晚和发布之前总是运行。

- `build (static binary + images)`：PR 的静态二进制和镜像，每次运行构建一次，并（作为 artifacts）与 `docker build (no push)` 和各安装器 job 共享。
  像发布一样制作（Dockerfile `artifact` → `prebuilt`），但使用 CI 的 cargo profile（`Cargo.toml` `[profile.ci]`：无 LTO，16 个 codegen unit；release.yml 发布 `release`），
  版本为 `<version>-ci.<run>`；依赖来自 Dockerfile 的 cargo-chef `deps` 阶段，存放在 BuildKit GitHub Actions 缓存中（只由仅 main 的 `image cache (main)` job 写入）。
  `make-release.sh` 把它们变成本地发布（GitHub 目录布局，用一次性的 cosign 密钥签名；外加一个故意损坏的发布 `v9.9.9`）。
- `installer (bare, debian:13 / ubuntu:24.04)`：`bare-e2e.sh` 在全新的 systemd 容器中运行：从 GitHub 安装最新已发布版本（v0.3.x，真实的 keyless 验证），
  其到 PR 构建的升级被原样拒绝（v0.4 基线）→ purge → 全新安装 PR 构建 → 通过 Caddy 的 healthz
  （带 `local_certs` 的 `myapp.test`，或仅 IP）、经 API 的管理员登录、`akari settings show` 中的节点地址
  （`--node-address`：主机名，或 `[::1]:9443`）、一个用户及其订阅 → 损坏的发布会回滚 → 卸载保留数据，重装保留前缀/密码/订阅 →
  age 加密的备份 → `--purge` → 从该备份 `--restore` 安装（主机迁移）。
- `installer (host, docker + migration)`：`host-e2e.sh` 在 runner 上运行：Docker 安装最新发布版本（ghcr 镜像）→ 其到 PR 镜像的升级被原样拒绝 → purge →
  Docker 安装 PR 镜像（本地 registry，按 digest 固定）→ purge；裸机安装 PR 构建，注册一个真实 agent（`../akari-agent`），
  `migrate --to docker` 再 `--to bare` 回来：前缀相同，agent 无需重新注册即可重连，订阅仍能应答。
- `shellcheck`：`make shellcheck`（也是 `make check` 的一部分），它还运行 `scripts/installer-test/validators.sh`：
  安装器的输入校验函数（`valid_domain`、`valid_node_addr` 等，用 `AKARI_INSTALL_LIB=1` 引入）在 dash + GNU grep 下对已接受和已拒绝的值的测试；
  该 job 还会在 busybox sh + grep（alpine）下再运行一次。正则方言不同（WSL 的 grep 即 ugrep，在方括号里接受 `[\]]`；GNU grep 不接受），
  所以安装器的模式请保持为可移植的 ERE，并在那里添加用例。

本地运行：`scripts/installer-test/bare-e2e.sh debian:13 <releases> <tag> v9.9.9 [<previous>]` 需要支持特权容器的 Docker
（在会拦截 TLS 的代理后面时用 `EXTRA_CA=<bundle>`）。

## Verify a release（校验发布版本）

发布采用 keyless 签名（GitHub OIDC，Sigstore；没有会丢失的项目密钥）：每个签名的证书都写明产生它的工作流文件**和 tag**，
所以请对照这个确切的身份来验证。需要 **cosign >= 3**（`cosign version`；2.4.x 仅在带 `--new-bundle-format` 时适用于 blob，更旧的 2.x 无法读取这些 bundle）。
发布工作流在发布之前，会对刚签名的内容运行同样的命令。

```bash
TAG=v0.4.0
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

同一个引用位于 GitHub release notes 的顶部。随后 `docker compose pull` 会为你的架构精确拉取该 digest
（该镜像是多架构 index：linux/amd64 和 linux/arm64）。agent 发布：把 `ID`/`REL` 中的 `akari-panel` 换成 `akari-agent`，
并使用其 `akari-agent-linux-<arch>` 文件（它只发布二进制）。SBOM（CycloneDX）是发布资产，也是镜像上的 attestation；
`THIRD_PARTY_LICENSES.txt` 列出每个打包的 crate 和 npm 包及其许可证文本。

### Build the image yourself (fallback)（自行构建镜像，备用）

无法访问 ghcr.io，或要运行未发布的 commit 时，从检出自行构建同一个镜像（4 核约 10 分钟；需要支持 BuildKit 的 Docker，不需要别的），并让 compose 指向它：

```bash
cd /opt/akari-panel && git checkout v0.4.0              # the release you want
docker build -t akari-panel:local --build-arg AKARI_GIT_SHA="$(git rev-parse --short=12 HEAD)" .
sed -i 's|^AKARI_IMAGE=.*|AKARI_IMAGE=akari-panel:local|' deploy/.env
cd deploy && docker compose up -d                           # skip `docker compose pull` for a local image
```

升级这样的部署 = 检出新 tag，重新构建，`docker compose up -d`。

## Build notes（构建说明）

二进制是静态 musl 构建（`rust:alpine`；ring/rustls/sqlx 不需要系统库）：它能在任何 Linux 内核上运行，包括 distroless/scratch，VPS 上不需要 glibc。
musl 自带的分配器会使这种分配密集的多线程负载串行化，所以二进制使用 mimalloc（M2）。`akari --version` 打印版本和 git sha。

## Appendix A. Docker Compose by hand（附录 A：手动 Docker Compose）

安装器在 Docker 模式下做的事情，逐步展开（适用于其他发行版、已有的 Docker 主机，或想看每一步的情况）。

以下命令在面板主机上以 root 运行。本节、§2、§2b、§3 和 §3g 把一台干净的 Debian 13 机器带到用户通过新节点完成代理连接（计时演练：§3c）。

```bash
# 0. Docker Engine + compose v2 (Debian 13 packages; Docker's own apt repository works the same)
apt-get update && apt-get install -y docker.io docker-compose git
docker compose version                                 # v2.x

# 1. the deploy files of the release you install (the tag matches the image in step 3)
git clone -b v0.4.0 https://github.com/akari-projectX/akari-panel /opt/akari-panel
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
sed -i 's|^AKARI_IMAGE=.*|AKARI_IMAGE=ghcr.io/akari-projectx/akari-panel:0.4.0@sha256:<digest>|' .env

# 4. check, start, read the admin prefix
docker compose run --rm panel config check             # last line: "configuration OK (0 warnings)"
docker compose up -d                                   # Caddy: certificate, forwards everything
docker compose exec panel /akari info                  # admin prefix: /<prefix>, sub path: /<path>
curl -s -o /dev/null -w '%{http_code}\n' https://panel.yourdomain.com/healthz   # 200
```

compose 文件在 panel 服务上设置了 `AKARI_CONFIG=/etc/akari/panel.toml`，所以你通过 `docker compose run` 或 `exec` 运行的每个 `/akari ...`
都会读取你的 `panel.toml`（这些命令会替换服务的 `command:`，这就是路径用环境变量而不是 `-c` 参数的原因）。
`config check` 打印生效的值（监听器、已脱敏的 URL），然后是 `configuration OK`。全新安装时，其输出还会以
`# 系统设置: database not readable (... relation "panel_settings" does not exist ...)` 结尾：数据库仍是空的；面板启动后这一行就会消失。
镜像本身不设置默认的 `AKARI_CONFIG`：直接 `docker run` 它会使用内置默认值。compose 之外请使用 `-c <file>` 或导出 `AKARI_CONFIG`。

Caddy 在首次启动时为 `AKARI_DOMAIN` 获取证书（`docker compose logs caddy`：“certificate obtained successfully”；
DNS 记录必须已指向该主机，80/443 端口必须开放）；之后在 系统设置 中添加的域名按需获取证书（§1b）。

**没有公共 DNS 的名称**（测试或局域网名称，如 `myapp.test`）：Let's Encrypt 无法为其签发（Caddy 日志里的 `rejectedIdentifier`）。
在 `.env` 中设置 `AKARI_CADDY_OPTIONS=local_certs`，并执行 `docker compose up -d --force-recreate caddy`：之后所有证书都来自 Caddy 的内部 CA（与下面的 IP 情形相同）。
节点安装器会钉扎该证书（§3）：面板探测自己的地址来获取它，所以面板容器也必须能解析该名称（你的局域网 DNS，或带
`services: {panel: {extra_hosts: ["myapp.test:<host IP>"]}}` 的 `docker-compose.override.yml`）；
做不到时，安装命令会带着 “could not check the TLS certificate” 警告，并在节点上因证书错误而失败。

**仅 IP 的部署（没有域名）。** 当 `AKARI_DOMAIN` 设为 IP 地址时，Caddy 用自己的内部 CA 签发证书，没有浏览器或客户端信任它。
试用管理界面没问题（接受一次浏览器警告），但订阅客户端和浏览器会拒绝它：请使用真实域名（指向 VPS 的 A 记录，80/443 端口开放），让 Caddy 通过 ACME 获取证书。
Caddyfile 把 `default_sni` 设为 `AKARI_DOMAIN`，因为客户端访问 IP 地址时不发送 SNI。
agent 的 gRPC 通道不受影响：它固定的是面板 CA，而不是 web 证书，而一行节点安装器固定的是 web 证书的密钥（§3）。

**把仅 IP 的部署迁到域名**（2026-10-02 验证；W25：panel.toml 无需改动）：添加 A 记录（不要使用代理型 CDN；80/443 端口开放），
在 `.env` 中设置 `AKARI_DOMAIN`，`docker compose up -d`（Caddy 几秒内获取证书；`docker compose logs caddy` 显示 “certificate obtained successfully”），
然后在 系统设置 中把 **主域名** 设为该名称（安装命令变成普通 `curl`，不再钉扎），如果希望 agent 从现在起拨该名称，再设置 **节点通信域名**。
之前注册的 agent 继续拨 IP，并以该 IP 作为 gRPC server name（其 bootstrap 文件如此写明）：该 IP 会一直留在证书的名称列表中（节点通信证书域名），直到你在那里移除它，
所以不会有任何节点被丢下。重启一个 agent 以确认它能重新连接。现在任何其他主机名都会得到同样的空 404。

Caddyfile 是以单个文件的方式 bind mount 的：`git pull`/`git checkout` 会替换该文件（新的 inode），而运行中的容器保留旧的，所以 `caddy reload` 什么都不会改变。
更新检出之后请执行 `docker compose up -d --force-recreate caddy`。

注意：镜像是 distroless（没有 shell；`exec panel /akari ...` 能用是因为它直接运行二进制），以 UID 65532 运行，状态保存在 `akari-data` 卷（`/data`）中。
没有容器 HEALTHCHECK；请从你的监控中探测 `https://panel.example.com/healthz`。
compose 的 `frontend` 子网是固定的（172.28.0.0/24），以便 `web.trusted_proxies` 能指名它。

## Appendix B. Bare metal by hand（附录 B：手动裸机部署）

安装器在裸机模式下做的事情，手动版（其他发行版、已有的 PostgreSQL ≥ 18 / Valkey ≥ 9、用 nginx 代替 Caddy）。
安装器的选择可作参考：来自 PGDG 的 PostgreSQL 18，来自 `deploy/systemd/akari-valkey.service` 的 Valkey（上游构建、回环、密码放在 credential 文件中），
以 `/etc/akari/caddy.env` 作为 `EnvironmentFile` 且没有 `--environ` 的 Caddy。

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
sudo -u akari akari -c /etc/akari/panel.toml info      # admin prefix, sub path
```

然后是代理：**Caddy**（`deploy/caddy/Caddyfile`，在其环境中设置 `AKARI_DOMAIN`，上游 `127.0.0.1:8080`）或
**nginx**（`deploy/nginx/akari.conf`，替换域名和证书路径）。两者都转发所有路径（面板自行判断，其余一律以空 404 应答），追加 `X-Forwarded-For`，
并且不把 URI（后台前缀、订阅令牌）写入访问日志。`trusted_proxies = ["127.0.0.1/32"]` 适用于同机代理。
