# Akari

代理面板控制平面，不留任何历史指纹：一个 Rust 单二进制（面板）加一个内嵌 xray-core 的 Go agent。
不兼容 V2Board/XrayR 协议，节点上没有入站管理端口，也没有任何能让未认证探测识别出本软件的特征。

```
┌──────────────── Rust binary (akari) ────────────────┐
│ axum web        portal at /, console + API behind a │
│                 secret admin prefix, empty 404 else │
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

在全新的 Debian 12/13 或 Ubuntu 22.04/24.04 服务器上（root 或 sudo）执行：

```bash
curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh | sh
```

安装过程为交互式（中文/英文），每个提示都有默认值：

- 部署方式：Docker Compose，或裸机（systemd 下的 PostgreSQL 18 + Valkey 9 + Caddy）。
- 访问方式：域名，或仅用 IP。
- 管理员邮箱（即登录名；密码自动生成，只显示一次）。

安装前会先校验发布版本（cosign 签名的 SHA256SUMS）。安装后可用：`akari-ctl status | info | upgrade | backup | migrate --to docker|bare | uninstall [--purge]`。
非交互安装：`… | sh -s -- --yes --mode bare --domain panel.example.com`。
手动安装、升级、回滚、迁移的细节见 `docs/DEPLOY.md`。

## Status / what works

`./smoke.sh`（完全由 API 驱动）端到端验证了以下功能：

- `akari admin add <email>` 创建第一个账号（v0.4 D1：所有人包括管理员都用邮箱登录；密码通过环境变量 `AKARI_ADMIN_PASSWORD` 或隐藏提示输入；argon2id 哈希）。
- **URL 布局（v0.4 D4/D11，`access.rs`，入口在 `web.rs`）**：
  - 用户门户（页面、`/api/v1/…`、`/auth/…`）位于主域名的 `/`。
  - 控制台和管理员 API 位于**管理前缀**之下。管理前缀是唯一的秘密前缀，存放在数据库中（首次启动导入 `data/state.json` 里的值）；owner 可免重启轮换（旧前缀在所有实例上立即失效），也可限定为 CIDR 白名单。
  - 订阅位于 `/<sub path>/<token>`。订阅路径是首次启动时抽取的全站随机路径，可编辑，旧路径立即失效，也可选择给每个用户邮件发送新链接。
  - 安装链接位于 `/install/…`，支付通知位于 `/pay/…`。
  - 管理员账号不能登录门户（返回的是“密码错误”的应答），门户上也不存在其会话；门户既不携带也不链接管理前缀，管理前缀之下没有任何公开路径可用。
  - 其他一切请求（错误或裸前缀、白名单之外的地址、垃圾请求）都得到同一个空 404（无响应体，也没有面板的任何安全头）。
- **公开表单的机器人防护（W27，`botguard.rs`）**：登录、注册（验证码 + 提交）和重置请求接受可选的 `guard: {form_token?, website?, turnstile?}`。
  - 蜜罐（默认开启）：`website`（人看不见的字段）非空即判为机器人。
  - 最短提交时间（默认 2 秒，0 = 关闭）：`form_token`（来自 `/auth/options`，是以 `data/master.key` 派生密钥对签发时间做的 HMAC，有效期 24 小时）至少要存在这么久。
  - 被拦截的请求得到的应答与该表单的普通失败完全一致（登录：统一的 401，按密码错误计数；邮件请求：`{"ok":true}`，不发送任何邮件；注册：通用拒绝），并且只增加 `akari_bot_trap_total{form,reason}`（不写日志）。
  - Cloudflare Turnstile（按表单设置，默认关闭）在上述检查之后于服务端校验，失败即拒绝（400/503）。
  - 客户端流程：取 `/auth/options`，等待 `form_min_secs`，再提交 `guard.form_token`。控制台的 Turnstile 组件（CSP：`challenges.cloudflare.com`）尚未实现（W36-b）。
- **Passkey（W27，`passkey.rs`，webauthn-rs）**：RP ID = 主域名的主机名（须为 https DNS 名称，否则 passkey 不可用，也不适用任何策略）。
  - 无用户名登录（不发送地址，因此没有账号探测）；仪式状态存于 Valkey，一次性，5 分钟。
  - 当账号在当前 RP ID 下有 passkey，且选择了仅 passkey 或其角色策略要求时，密码登录会被拒绝（403 `auth.passkey_required`，仅在密码正确之后）。没有当前有效的 passkey 时，密码始终可用（换域名或删除最后一个 passkey 都不会把任何人锁在门外）。
  - 登录应答中的 `passkey_prompt` 提示页面引导用户绑定 passkey。passkey 丢失：`akari admin reset-login <email>`。
- `POST /auth/login`（`{email, password}`；管理员：`/{admin prefix}/auth/login`）校验 argon2id 哈希。
  - 对未知地址做了耗时均衡；失败尝试在 Valkey 中限速：按客户端地址（IPv6 按 /64）20 次/15 分钟，按账号地址 50 次/15 分钟。
  - 通过后签发 HS256 JWT，放在 `HttpOnly`、`SameSite=Strict` 的 cookie 中（12 小时；除非 `web.cookie_secure = false`，否则带 `Secure`）。
  - 令牌携带账号的 `session_ver`：改密码、禁用、改角色、过期、登出或 `POST /api/v1/users/{id}/revoke-sessions` 都会终止该账号的所有会话（登出 = 全端登出；被复制的 cookie 随之失效）。
  - **Owner（R47）**：`akari admin add` 创建的第一个管理员（即安装器创建的那个）就是 owner（`/me` 与用户视图中的 `is_owner`）。
    - 只有 owner 能修改其他管理员账号（角色、密码、封禁、删除、会话、登录方式、邮箱验证）、创建管理员、修改管理前缀及其白名单、写入支付渠道的密钥或账号（403 `user.owner_only`）。
    - owner 不能被降级、封禁或删除（409 `user.owner_protected`，数据库层也强制），通过 `POST /api/v1/users/{id}/owner` 移交角色；服务器上的恢复方式：`akari admin set-owner <email>`。
  - 所有管理操作都记入审计日志（见下文 "Security"）。（TOTP 双因素认证已在 v0.4 移除，由 passkey 取代。）
- 管理员 API：用户 CRUD、节点列表/启用、节点的 xray `inbound`（每节点一个）、入口（凭据由套餐 reconcile 由面板生成，每个授权入口一份）。
- **套餐（M3）**：节点组、套餐（流量配额，按月 / 每 N 天 / 不重置，授权的节点组）和用户套餐。
  - 用户的节点自动跟随其套餐，凭据由面板签发和回收（见下文 "Plans and node groups"）；不存在手动按节点分配（D3）。
  - 周期性流量重置会重新启用仅因配额被禁用的用户。
  - 用户在门户中可以看到套餐、用量、下次重置、到期时间和节点列表（名称/地区），并可修改密码。
- **工单与告警（W17）**：
  - 客户工单：分类、优先级、串联回复、未读标记、关闭/重开/指派；他人的工单与未知路径无法区分。
  - 节点告警：离线、CPU/内存持续过高、磁盘、延迟测试失败、证书将到期、应用失败；同一时间只有一个评估器，带去重、冷却、静音；通知渠道为 Telegram 机器人、HMAC 签名的 webhook、经 SMTP outbox 的邮件。
  - 控制台中有告警中心；`deploy/` 中有 Prometheus 规则和全网仪表盘（docs/DEPLOY.md §4b）。
- **套餐目录（W7）**：
  - 按周期定价（月 / 季 / 半年 / 年 / 两年 / 三年 / 自定义天数 / 一次性 / 流量重置包）。
  - 轻量 Markdown 描述、库存（最大订阅数）、仅限续费和换入规则。
  - 套餐切换按比例抵扣，以及由 agent 强制执行的按用户限速（见 docs/PAYMENTS.md）。
- **服务器与节点（Q1）**：*服务器*是一台机器 = 一个 agent 身份（证书、版本、租约、指标、告警、发布、TLS 域名）；*节点*是服务器上的一个入站（协议）及其入口。
  - 一个 agent 运行其服务器上的所有节点（一台机器上多个协议 = 同一服务器下多个节点）。
  - 管理端列表按 服务器 → 节点 → 入口 分组（`GET /api/v1/servers`）。
- `akari server add <name>`（或 `POST /api/v1/servers`，或不带 `server_id` 的 `POST /api/v1/nodes`：为该节点单独建一台服务器；UI 中为“新建节点”）创建服务器，生成一次性注册令牌，并写出不含任何私钥的 bootstrap 文件。
  - agent 在本地生成密钥（ECDSA P-256），通过 gRPC 端口用 CSR 注册（这是唯一不需要客户端证书的调用）；面板签发 90 天的客户端证书。
  - Protocol 2 的 agent 在证书剩余三分之一有效期时通过 mTLS 续期（新密钥；看到新证书后旧证书被吊销）。
  - `akari server enroll-token <id>` 用于重新注册服务器，见 docs/DEPLOY.md。
  - `akari server delete <id>`（或 `DELETE /api/v1/servers/{id}`）退役服务器及其节点，见下文 "Node deletion"。`DELETE /api/v1/nodes/{id}` 立即删除单个节点并保留其服务器。
- agent 主动外连（TLS 1.3，客户端证书 = 节点身份），发送带有其已持有配置/用户版本的 `Hello`；节点变为 `online`，并记录版本。
- 面板在入站变化或 agent 状态未知时推送 `ConfigSnapshot`（xray 入站 + 完整用户集），在仅用户集变化时推送 `UserDelta`（base/target 版本，REPLACE 语义）：
  - 添加、禁用或轮换单个用户不会重建 xray，只会关闭该用户的现有连接。
  - `ConfigSnapshot` **会**重建 agent 的 xray 实例，并断开节点上所有现有连接。会走这条路径的情形：入站变更、agent 状态未知或不一致（Hello/Ack 状态哈希）、delta 失败、重启或租约过期后的新会话，以及 撤权方式 = 重建（系统设置 → 节点通信）。
  - 通过 API 禁用用户，会在一秒内传播到已连接的 agent。
- 心跳（15 秒）写入 Valkey；流量计数器（10 秒轮询）上送面板，在会话级基线上幂等地应用增量。
- **节点运维（W11，docs/DEPLOY.md §3e）**：xboard 风格的节点表单——显示名（面向用户；`name` 仍是唯一的内部名）、排序、对用户显示或隐藏、标签（显示在门户和订阅名称中，如 "香港 01 | IPLC 直连"）。
  - W28-a：一个节点有一个入站，经由入口访问。每个节点都有内置的 直连 入口（可禁用）。
  - 入口携带流量倍率（0–100x，精确到千分位；计费量 = floor(原始量 × 倍率)，仅在 flush 的 SQL 内计算，以 flush 时生效的倍率为准；节点同时保存原始总量与计费总量）、连接地址/连接端口（NAT / 端口转发；三种订阅格式和面板的 TCP 测试都使用它们），以及节点组归属。
  - 每个可用入口都是独立的订阅条目（倍率不是 1x 时，倍率写在名称中）。
  - 中转入口（IPLC、转发 VPS）使用派生入站：同一节点入站在另一端口上，有自己的凭据，且只能从中转的出口地址访问（nftables，agent 能力 `source-filter`；由 agent 的 root updater 应用：agent 本身没有 `CAP_NET_ADMIN`）。
  - agent 在每次心跳中上报机器状态（CPU、负载、内存/swap、磁盘、默认路由网卡的速率和累计量、TCP/UDP 套接字、被代理的连接、在线用户、RSS、运行时间、xray 版本）：最新值存于 Valkey，1 分钟粒度历史保留 48 小时、1 小时粒度历史保留 90 天，存于 PostgreSQL；管理端节点列表每 5 秒刷新，每个节点有带图表的详情页。
  - 延迟测试类似 Clash Verge 的 url-test（每 5 小时，可配置，另有 "立即测速"）：由 agent 从自身出口做 HTTP 测试，面板对每个入站做 TCP 连接测试；用户可看到其可见节点的在线状态、倍率、标签和延迟。
- 超过 `traffic_limit_bytes` 的用户会被自动禁用；受影响节点的版本号递增，已连接的 agent 立即收敛。
- 订阅端点：`/{sub path}/{token}`（D11），每用户一个 256 位令牌（数据库只存其 SHA-256）。
  - 输出格式跟随 User-Agent（base64 分享链接 / Clash YAML / sing-box JSON）；TLS、REALITY 和 WebSocket 传输参数从每个入站的 streamSettings 映射而来。
  - `subscription-userinfo` 等配额头仅在成功时发送；错误令牌与其他所有拒绝一样得到同样的空 404。
  - 响应体按 8 KiB 分桶填充，大小不会泄露节点数量。
  - 按客户端地址和按用户限速（内置限额）；超限同样返回空 404。
- 支付（W24/R40）：可插拔的支付方式，在 系统设置 → 支付 中配置（仅存数据库；支付宝当面付是第一种，允许配置多个，密钥加密保存，支持 测试连接），见 docs/PAYMENTS.md。
  自助注册可选择是否做邮箱验证（系统设置 → 注册）。

## Layout

```
proto/agent.proto      the control-plane contract (single source of truth)
src/grpc.rs            agent sessions, snapshot/delta convergence
src/traffic.rs         delta accounting + limit enforcement
src/install.rs         CA, server/agent cert issuance
src/auth.rs            argon2id passwords, JWT sessions, extractor
src/api.rs             REST handlers (users, nodes, accounts)
src/spa.rs             embedded user portal (rust-embed)
src/console.rs         embedded admin app (rust-embed): sign-in page, session-gated console
src/access.rs          D4/D11 URL layout: admin prefix + allowlist, subscription path
src/web.rs + reject.rs front door + uniform rejection
spa/                   React 19 + Vite 8 + Tailwind 4 user portal
admin/                 the admin app (W33-b): sign-in page + console, own build and e2e
migrations/            sqlx migrations (run at startup)
smoke.sh               cross-repo end-to-end check (needs ../akari-agent)
```

agent 位于兄弟仓库 `akari-agent`（Go：`agent.go` 流生命周期与重连退避，`core.go` xray-core 内嵌，`gate.go` 撤权闸门，`monitor.go` 心跳与流量循环）。
两个仓库必须并排检出；逐文件说明见 `src/CLAUDE.md`。

## Frontend

两个独立构建的前端（R23、W33-b），基于 React 19、Vite 8（Rolldown）和 Tailwind 4，数据层用 TanStack Query：

- **用户门户**（`spa/`）位于主域名的 `/`（D11）：登录页，以及每个 URL 一个视图（仪表盘、商店、节点、订单、钱包、工单、账号），中文/英文。入口只提供它认识的页面（`access::PORTAL_PAGES`；须与门户路由保持一致）。
- **管理端应用**（`admin/`，W33-b）：
  - 独立的**登录页**位于 `/{admin prefix}/app`（邮箱 + 密码、passkey、登录策略，启用时含 Turnstile/蜜罐；非管理员账号会被重新登出）。
  - **控制台**位于 `/{admin prefix}/admin`：仪表盘、状态、用户、订单、优惠券、财务、工单、内容、节点、套餐、告警、更新、审计、设置、账号；中文/英文，手机可用。
  - 控制台的 index 和静态资源只对管理员会话提供（private、no-store）；对其他人，`/admin` 是统一的空 404。
  - 它提供的每项功能都列在 `admin/INVENTORY.md` 中，并由其 Playwright 套件覆盖。

两套产物不共享代码：构建检查会在每个产物里 grep 对方的标记（门户从不包含控制台代码，登录页从不包含控制台）。
所有产物都通过 rust-embed 嵌入二进制；在管理前缀之下，Vite 的资源 URL 在服务时被改写为带前缀，位于 `/` 的门户则从不带前缀。
CSP 仅允许 `'self'`。缺失的资源返回统一的空 404，开发目录永不对外提供。

```bash
make spa               # npm install + vite build (updates spa/dist)
make admin             # the admin app: checks + both builds (updates admin/dist)
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
./target/release/akari server add test-node   # writes test-node-bootstrap.toml (one-time token)
# then add a node on it: POST /api/v1/nodes {"server_id": …, "name": …, "inbound" | "template": …}
(cd ../akari-agent && ./agent -config ../akari-panel/test-node-bootstrap.toml -state-dir /tmp/akari-agent-state)
make smoke             # full end-to-end check (truncates the dev DB)
make check             # fmt + clippy + tsc (fast gate); make lint test deny = CI
```

### Production deployment

- `scripts/install.sh`：上文的一键安装器，安装后名为 `akari-ctl`。支持安装、升级（含备份、健康检查和自动回滚）、卸载、裸机 ⇄ Docker 迁移，以及通过 `--restore` 迁移主机。
- `docs/DEPLOY.md`：先讲安装器，再讲手动部署——Docker Compose 或 systemd、Caddy/nginx、防火墙、首个管理员、节点安装、升级顺序、回滚、卸载、迁移、发布版本校验。
- `docs/BACKUP.md`：age 加密的备份/恢复与恢复演练。
- `deploy/`：unit 文件、compose、反向代理示例、Prometheus 告警、Grafana 仪表盘。

发布产物（静态 linux amd64/arm64 二进制、distroless 镜像 `ghcr.io/akari-projectx/akari-panel`、SBOM、cosign 签名）由 `v*` 标签触发的 `release.yml` 工作流生成。
`akari --version`；`akari config check`（校验并打印生效配置，密钥已脱敏）。
可选的 `[metrics] bind` 在独立的回环监听器上提供 Prometheus 指标，绝不在公网端口上提供。

### API surface

管理员在 `/{admin prefix}` 下调用所有端点；门户在 `/` 下调用相同的路径（管理员会话和管理员登录在门户上不存在）。

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /auth/login | — | `{email, password, guard?}`（D1：地址不区分大小写，已验证与否均可）：argon2id 校验，设置会话 cookie；→ `{id, email, role, expired, quota_exhausted, banned, passkey_prompt}`（R21 续费范围；W28-c：被封禁的 role=user 账号登录后进入门户范围*）。所有失败都返回统一的 401，包括被拦截的机器人（W27 `guard`，见下）。开启 Turnstile 时：400 `auth.captcha_failed`（令牌缺失/被拒）/ 503 `auth.captcha_unavailable`（校验服务不可达） |
| POST | /auth/passkey/options | — (passkeys available) | W27：可发现凭据登录的挑战 `{state, options}`（`options` = WebAuthn `publicKey` 请求选项；`no-store`；每客户端地址 30 次/分钟）。没有 https 主域名 = 标准拒绝 |
| POST | /auth/passkey/login | — (passkeys available) | W27：`{state, credential}`（浏览器的 `PublicKeyCredential` JSON）→ 会话 cookie + 登录应答。所有失败都返回统一的 401 |
| POST | /auth/logout | — | 清除 cookie，并终止该账号的所有会话 |
| GET | /auth/options | — | W15：登录页提供的选项 `{register, invite_required, email_domains, reset, email_verify, site_name, branding, guard}`；`Cache-Control: no-store`。W27 `guard` = `{form_token, form_min_secs, honeypot, turnstile: {site_key, login, register, reset} \| null}`（null = 设置不可读：表单拒绝提交）；W36-b `timezone`（站点时区，IANA 名称） |
| POST | /auth/register/code | — (registration + verification on) | W15：`{email, invite_code?, locale?, guard?}` → 对任何地址都返回 `{"ok":true}`（邮件发送验证码，或发送“已注册”提示邮件）；按客户端和地址限速 |
| POST | /auth/register | — (registration on) | W15：`{email, code \| pow, password, invite_code?, locale?, guard?}`（开启 注册需要邮箱验证 时用 `code`，否则用 W24 工作量证明）；被拦截的机器人得到该模式的通用拒绝 → 账号（地址已验证）+ 会话 `{id, email, role, …}`；验证码错误/过期/已用 = 400 `invalid or expired code` |
| POST | /auth/password-reset/request | — (reset on) | W15：`{email, guard?}` → 对任何地址都返回 `{"ok":true}`（被拦截的机器人也一样：不发送任何东西）；30 分钟有效的一次性链接发往已验证的地址 |
| POST | /auth/password-reset | — (reset on) | W15：`{token, password}`：设置新密码，所有会话终止 |
| GET | /api/v1/me | user (portal scope*) | 个人资料（`email` = 登录名，`email_verified`）+ 流量用量；`expired` / `quota_exhausted`（R21）；W28-c `banned`、`ban_reason`（管理员写给用户的原因）、`banned_at`；W20：`sub_token` + `sub_url`（订阅链接，`Cache-Control: no-store`；D11：在订阅/主域名上为绝对地址，未配置时为根相对的 `/<sub path>/<token>`；管理员和续费范围为 null；没有令牌的账号会在此生成一个），`sub_legacy`（W20 之前的旧链接：可用，但在重置前无法显示），`probe_interval_secs`；R47 `is_owner`；W36-b `timezone`（站点时区：门户以此显示日期） |
| GET | /api/v1/me/delete-impact | user (renewal scope*) | W27：删除自己的账号会失去什么（同控制台的 `/users/{id}/delete-impact`，另有 `anonymized`：财务记录保留匿名化的账号） |
| POST | /api/v1/me/delete | user (renewal scope*, not banned) | W27 `{confirm: true, password?}`（除非账号只用 passkey 登录，否则必须提供密码；错误 = 400 `account.invalid_password`，与登录一样计数）：清除自己的账号（`erase.rs`：没有财务记录 = 直接删除；否则匿名化并保留：地址 `erased-<id>@erased.invalid`，个人数据删除，访问权限撤销，永久禁用）；409 `account.delete_pending_orders` / `account.delete_pending_withdrawals`（须先取消）；204，清除 cookie；审计 `user.erase` |
| POST | /api/v1/me/sub-token | user (role=user) | 重置自己的订阅（5 次/小时）：新链接和每个入口的新凭据（高-3）——旧链接和所有已导入的客户端都会失效（现有连接被切断）；`credentials_rotated` = 轮换的数量 |
| GET | /api/v1/me/plan | user | 自己当前的套餐（或 null）、用量、生效的限额/到期时间、节点名称 + 地区（Q3：`plan.next_reset_at` 带站点时区的偏移） |
| GET | /api/v1/me/nodes | user | W11：自己可见的入口（W28-a：每个可用入口一行）——节点显示名、`entrance` 名称、地区、标签、入口倍率、在线状态、延迟（不含 id、地址和机器指标） |
| POST | /api/v1/me/email/code | user (renewal scope*) | W15：`{email, password}`：向新地址发送验证码（需要当前密码；地址已被占用时应答相同） |
| POST | /api/v1/me/email/verify | user (renewal scope*) | W15：`{code}`：该地址成为账号已验证的邮箱及其登录名（D1） |
| PUT | /api/v1/me/locale | user (renewal scope*) | W15：`{locale: zh\|en}`：账号邮件的语言 |
| GET/POST | /api/v1/me/invite-codes | user (role=user) | W15：自己的邀请码、链接前缀、已邀请人数 / 新建邀请码（有每用户上限；注册必须开放） |
| DELETE | /api/v1/me/invite-codes/{code} | user (role=user) | W15：删除邀请码 |
| GET/PUT | /api/v1/settings | admin | 系统设置（R22，D8）：GET = 视图：`main`/`sub` `{value (preferred), display, domains: [{domain, display, preferred}], effective, source}`、`sub_domain_per_user`、`node {value, display, domains, panel_addr, server_name, source, default_port}`、Cloudflare 信任、服务器名称等 / PUT `{version, main_domains, sub_domains, node_domains (each preferred-first, ≤ 16), sub_domain_per_user?, trust_cloudflare, force_node_cloudflare?, confirm_host_change?, confirm_removal?}`：D8 按主机划分角色——主域名提供门户、管理前缀、安装链接、支付通知和订阅；订阅域名只提供订阅；节点域名在 HTTP 上什么都不提供（gRPC）；每个主机只能有一个 HTTP 角色（`settings.domain_conflict`），同一主机不能出现两次（`settings.domain_duplicate`）；新的节点域名会检查是否在 Cloudflare 后（422 `settings.node_domain_cloudflare`，除非强制）并记入 gRPC 证书（其域名只增不减）；删除域名需要 `confirm_removal`（409 `settings.domain_removal_unconfirmed`）；审计 `settings.update` |
| POST | /api/v1/settings/domains/impact | admin | D8：PUT 将要发送的列表 → `{removed: [{kind, domain, preferred, places: [{what, count, detail?}]}]}`：移除每个域名会影响什么（`portal_console`、`links`（下一个首选主域名）、`pending_orders`、`install_links`、`subscription_links`（链接在该域名上的用户）、`nodes`（正在连接它的已注册 agent：它们继续正常工作）） |
| GET/PUT | /api/v1/settings/signup | admin | W15 系统设置 → 注册：注册、邀请规则、邮箱域名白名单、试用套餐、密码重置、`email_verify`（W27：纯布尔值，默认 false；true 需要能发送邮件）（乐观锁 `version`） |
| GET/PUT | /api/v1/me/passkeys | user (renewal scope*) | W27：GET `{available, rp_id, passkeys: [{id, name, created_at, last_used_at, current}], password_set, password_login_disabled, password_login, max}`；POST `{state, credential, name, disable_password?}` → 201 `{id, name}`（保存已验证的 passkey；`disable_password` = 登录提示中的“仅 passkey”） |
| POST | /api/v1/me/passkeys/options | user (renewal scope*) | W27：注册挑战 `{state, options}`（要求 resident key + 用户验证；20 次/小时；每账号 ≤10 个；没有 https 主域名时 409 `account.passkey_unavailable`） |
| PATCH/DELETE | /api/v1/me/passkeys/{id} | user (renewal scope*) | W27：重命名 `{name}` / 删除（他人的 id = 标准拒绝） |
| PUT | /api/v1/me/password-login | user (renewal scope*) | W27：`{enabled}`：账号自己的“仅 passkey”开关（关闭需要一个当前有效的 passkey，409 `account.passkey_required`）→ GET 视图 |
| GET | /api/v1/users/{id}/passkeys | admin | W27：账号的登录方式（同一视图） |
| POST | /api/v1/users/{id}/login-method/reset | admin | W27：passkey 丢失：删除该账号的 passkey，恢复密码登录（审计 `user.login_method.reset`）→ `{deleted_passkeys}`；CLI `akari admin reset-login <email>` |
| GET | /api/v1/settings/access | admin | D4/D11：`{version, admin_prefix, admin_url (null without a main domain), admin_allow_cidrs, your_ip (what the allowlist sees), sub_path}` |
| POST | /api/v1/settings/access/admin-prefix | owner | D4 `{version, confirm: true, admin_prefix?}`（缺省 = 随机；8–64 位 `A-Za-z0-9-_`，不能是门户路径）：新前缀在所有实例上立即生效，旧前缀得到普通拒绝；审计 `settings.admin_prefix.rotate`（不记录值）。`settings.confirm_required`、`settings.path_invalid`/`path_reserved`/`path_taken`、`settings.version_conflict` → 访问视图 |
| PUT | /api/v1/settings/access/admin-allow | owner | D4 `{version, admin_allow_cidrs}`（地址/CIDR 段，≤ 64；`[]` = 任意地址）：前缀下其他所有客户端得到标准 404；不含调用者自身地址的列表会被拒绝（409 `settings.allowlist_excludes_you`）；审计 `settings.admin_allowlist.update`。CLI 恢复入口：`akari settings unset admin-allow` |
| PUT | /api/v1/settings/access/sub-path | admin | D11 `{version, sub_path, confirm: true, notify_users? (default true)}`（4–64 位 `A-Za-z0-9-_`，不能是门户路径）：旧路径立即失效；审计 `settings.sub_path.update`；→ `{access, notify_job}`（`notify_job` = 给每个已验证邮箱的用户发送新链接的批处理任务；未请求、未变更或邮件关闭时为 null） |
| GET/PUT | /api/v1/settings/auth | admin | W27 公开表单的机器人防护与 passkey 策略：`{version, turnstile_site_key, turnstile_secret?, turnstile_login, turnstile_register, turnstile_reset, honeypot, min_submit_secs, passkey_only_admins, passkey_only_users, passkey_prompt}`（GET/PUT 应答另有 `warnings`）；secret 只写不读（缺省 = 保持，`""` = 删除；用主密钥加密；GET 返回 `turnstile_secret_set`；审计 `settings.auth.update` 记为 `"changed"`）；打开某个表单的开关需要两个密钥齐全（`auth_admin.turnstile_incomplete`）；`min_submit_secs` 0–60（0 = 关闭）。CLI 恢复入口：`akari settings unset turnstile` |
| PUT | /api/v1/settings/subscription | admin | W30 订阅：`{version, rules?, rule_set_clash_url?, rule_set_singbox_url?, formats?, import_clients?}`。PR ② §5：`formats` = 开启的输出格式（`clash`、`sing-box`、`links`；`null` = 全部，`[]` = 无；已关闭的格式返回统一拒绝——显式的 `?format=` 或该格式的已识别客户端什么也得不到，未识别的客户端按 links、Clash、sing-box 的顺序回落到第一个已启用的格式），`import_clients` = 门户的一键导入按钮（`clash`、`stash`、`shadowrocket`、`sing-box`、`hiddify`；`null` = 全部；对应格式关闭的按钮也隐藏；`GET /me` 带有 `sub_formats`/`sub_import_clients`）；`settings.sub_format_invalid`、`settings.sub_import_client_invalid`。Clash 与 sing-box 订阅的路由模板 `rules: [{type: geosite\|geoip\|domain\|domain_suffix\|domain_keyword\|ip_cidr, value, action: direct\|proxy\|reject}]`（≤ 64 条，按顺序匹配，其余全部走 PROXY；`null` = 内置的 广告拦截 / 国内直连 / 国外代理，`[]` = 无）以及规则集 URL 模板（`{kind}` = geosite\|geoip，`{name}`；https；`null`/`""` = jsDelivr 上的 MetaCubeX meta-rules-dat）。缺省 = 不变；返回设置视图（`subscription`）；`settings.sub_rule_invalid {index, detail}`、`settings.sub_rules_too_many`、`settings.sub_rule_set_url_invalid`；审计 `settings.subscription.update` |
| PUT | /api/v1/settings/site | admin | W21 站点名称 + Q3 站点时区：`{version, site_name?, timezone?}`（各字段：缺省 = 不变，`null`/`""` = 默认值——"Akari" / `Asia/Shanghai`）；`timezone` 须是 PostgreSQL 认识的完整 IANA 名称（`Asia/Shanghai`、`UTC`、`America/New_York`；`CST` 之类缩写、`UTC+8` 之类 POSIX 字符串、大小写错误 = 400 `settings.timezone_invalid`）；返回设置视图（`timezone: {value, effective, default, source}`）；审计 `settings.site.update`。时区决定流量历史和拦截规则计数的“日”、套餐按月重置与自然月期限（本地日期和时刻；夏令时保持本地时间）、仪表盘的天数以及 CSV 导出范围；从下一次写入起生效（已存储的日期不重写） |
| GET/PUT | /api/v1/settings/mail | admin | W15 系统设置 → 邮件：服务商（W31：`smtp` 或 `resend`；缺省 = 保持）、SMTP 主机/端口/安全方式/凭据（密码只写，加密保存）、Resend `api_key`（只写，加密保存；视图：`api_key_set`）、发件人、通知开关（`notify_refund`：退款通知，缺省 = 不变） |
| POST | /api/v1/settings/mail/test | admin | W15：`{to}`：立即用已保存的设置发送测试邮件（502 = 服务器的应答） |
| POST | /api/v1/settings/mail/diagnose | admin | W31：`{to}`：对已保存的服务商做逐步检查——配置、DNS、TCP、TLS（隐式 465 / STARTTLS 587，检测不匹配）、问候、AUTH、发送——始终 200 `{provider, ok, steps: [{step, status ok\|warn\|fail\|skip, elapsed_ms, code mail.diag.*, params, message: {zh, en}}]}`；审计 `settings.mail.test` |
| GET | /api/v1/system/status | admin | W31 系统状态：每个面板实例（主机 CPU/内存/负载/磁盘、RSS、版本、agent 会话；Valkey 心跳）、PostgreSQL、Valkey、反向代理（Caddy，经主域名探测）、后台任务（结算、对账、邮件、告警：上次运行、耗时、滞后、过期、上次错误、积压）；缓存 5 秒 |
| GET | /api/v1/mail/outbox | admin | W15：outbox 行 `?status=dead\|pending\|sent&before&limit`（不含正文） |
| POST | /api/v1/mail/outbox/{id}/retry | admin | W15：重新入队死信（不适用于已过期的验证码/链接） |
| POST | /api/v1/me/password | user/admin | `{current_password, new_password}`：修改自己的密码（当前密码错误 = 400，计入登录限速；其他会话终止，当前会话继续） |
| GET | /api/v1/audit | admin | 审计日志，`?limit&before&actor&action`（keyset，最新在前；`actor` = 精确匹配的 `actor_label`）。条目：`actor_id`、`actor_label`（Q4：非个人信息——`u-<id 的前 8 位十六进制>`、`cli`、`system`、`agent`、`anonymous`）、`actor_email`（账号当前的地址，非账号或已删除时为 null） |
| GET/POST | /api/v1/users | admin | 列表（`?q&plan_id&status=active\|expired\|quota\|banned\|erased&role&sort&limit&offset`；D10 `never_used=true`、`registered_before=YYYY-MM-DD`、`last_login_before=YYYY-MM-DD`（从未登录也算；按站点时区计日）；行带有 `is_owner`、`erased`、`last_login_at`、`balance_cents`、`passkeys`（W33-b）；`q` = 地址前缀或 id 前缀；`sort` created\|-created\|email\|-traffic\|expires）/ 创建 `{email, password, role?, plan?: {plan_id, period, days?}}`（D1：地址必填且视为已验证；已存在 = 409 `user.email_exists`。D12：套餐及其期限在同一事务中分配；绝不设置流量限额或到期时间） |
| GET/POST, PUT/DELETE | /api/v1/kb/articles, /api/v1/kb/articles/{id} | admin | 运维知识库文章（分类在 `/api/v1/kb/categories` 下）；W33-b：可选 `slug`（`^[a-z0-9][a-z0-9-]{0,63}$`，唯一；`terms`/`privacy` 对应门户的条款和隐私页；格式错误 = 400 `kb.slug_invalid`，已占用 = 409 `kb.slug_taken`） |
| GET | /api/v1/pages/{terms\|privacy} | — (public) | W36-b：门户的条款 / 隐私页：带该 slug 的已发布知识库文章，渲染方式同帮助文章 `{title_zh, title_en, html_zh, html_en, updated_at}`；其他 slug、未撰写或为草稿 = 标准拒绝（门户显示中性默认内容） |
| GET | /api/v1/users/{id} | admin | D12/W28-c 详情：列表行 + `subscription`（无套餐时为 null：`{user_plan_id, plan_id, plan_name, period, period_days, starts_at, expires_at, traffic_used_bytes, traffic_total_bytes, reset_period, last_reset_at, next_reset_at, timezone, speed_limit_mbps, status: active\|expired\|over_quota\|banned}`；Q3：`next_reset_at` 为带站点时区偏移的 RFC 3339，如 `2026-11-01T00:00:00+08:00`，`timezone` 即该时区）+ `ban`（未封禁时为 null：`{reason, banned_at, banned_by_id, banned_by_email}`） |
| PATCH/DELETE | /api/v1/users/{id} | admin | 更新 `{password?, role?}`（D12：没有 `traffic_limit_bytes`/`expires_at`；W28-c：没有 `enabled`——请用封禁；未知字段 400；R47：其他管理员的账号或 `role: admin` 只有 owner 能改（403 `user.owner_only`），owner 永不被降级（409 `user.owner_protected`），被封禁的账号不能被提升（409 `user.promote_banned`），提升会解除因流量配额造成的禁用）/ 删除用户（中-7：必须带 `?confirm=true`，否则 400 `user.delete_confirm_required`；永不删除 owner） |
| POST | /api/v1/users/delete/preview | admin | D10 `{selection: {ids} \| {filter}}`（列表的筛选条件）→ `{total, admins (never deleted), sample, deletable, anonymized (finance records: kept anonymized), confirm_token}`（≤ 2000，否则 400 `user.bulk_delete_too_many`） |
| POST | /api/v1/users/delete | admin | D10 `{selection, confirm_token}`：像自助删除一样清除所选范围内的每个 role=user 账号（各自独立事务，审计 `user.erase` + `users.bulk_delete`）；令牌绑定所显示的数量（有变化 = 409 `user.bulk_delete_changed`）→ `{deleted, anonymized, failed}` |
| GET/PUT | /api/v1/settings/cleanup | admin | D10 自动清理 `{version, auto (default false), after_days (1–3650, default 30), warn (default false), warn_days (1–90, default 7)}` + `last_run_at`、`last_deleted`、`last_warned`、`due_warn`、`due_delete`；每小时执行：注册后 `after_days` 天内从未使用且未登录的账号会被删除（开启 `warn` 时：先发邮件提醒，`warn_days` 天后若仍未登录再删除）；审计 `settings.cleanup.update` |
| GET | /api/v1/users/{id}/delete-impact | admin | 中-7：删除该账号会失去什么：`{email, balance_cents, withdrawable_cents, pending_withdrawals, pending_withdrawal_cents, pending_orders, unfulfilled_orders, plan: {name, expires_at}|null, anonymized}`（控制台的确认框会显示它；`anonymized` = 财务记录：自助删除会保留匿名化的账号） |
| POST | /api/v1/users/{id}/ban | admin | W28-c `{reason}`（1–500 个字符，显示给用户）：禁用（`disabled_reason = admin`），所有节点立即移除该用户（现有连接被切断），所有会话终止，订阅返回标准拒绝；再次封禁会替换原因；不能封自己（400 `user.ban_self`），不能封 owner（409 `user.owner_protected`），封其他管理员只有 owner 可以（403 `user.owner_only`）；审计 `user.ban`；返回详情 |
| POST | /api/v1/users/{id}/unban | admin | W28-c：解除封禁（否则 409 `user.not_banned`）；审计 `user.unban`；返回详情 |
| GET/PUT/PATCH/DELETE | /api/v1/users/{id}/plan | admin | 当前套餐 + 历史（含 `period`/`period_days`）/ D12 分配或变更 `{plan_id, period, days?}`（period = month…three_year、`days`（需要 days）、`onetime`（days 可选 = 永久）；不能是 `reset`；从现在起算，用量清零）/ 续期 `{period, days?}`（再加一个期限）或 `{extend_days}`（1–3650；不适用于 `onetime` 购买：409 `user_plan.extend_onetime`），均从 max(到期时间, 现在) 起算（无到期时间：409 `user_plan.no_expiry`）/ 取消（无套餐：409 `user_plan.none`） |
| POST | /api/v1/users/{id}/plan/reset-traffic | admin | D12 `{confirm: true}`：套餐流量清零（重置计划不变，因配额被禁用的账号重新启用，被封禁的永不启用）；审计 `user.traffic.reset`；返回 `{subscription}` |
| GET/POST | /api/v1/node-groups | admin | 列表 / 创建 `{name, description?, entrance_ids?}`（W28-a：组包含入口） |
| PATCH/DELETE | /api/v1/node-groups/{id} | admin | 重命名、修改描述、替换 `entrance_ids` / 删除 |
| GET/POST | /api/v1/plans | admin | 列表 / 创建 `{name, period, traffic_quota_bytes?, speed_limit_mbps?, device_seats?, sort?, enabled?, group_ids?, description?, capacity?, renewal_only?, renew_off_sale? (中-6, default true: off sale, subscribers still renew), allow_switch_in?}`（视图包含 `on_sale` 和 `prices`） |
| PATCH/DELETE | /api/v1/plans/{id} | admin | 更新（字段同上；null 清除可空字段；中-5：默认只影响新购买，除非带 `apply_to_existing: true`，此时现有订阅获得套餐当前的全部期限）/ 删除（仍有用户持有时 409） |
| POST | /api/v1/plans/{id}/impact | admin | 中-5：请求体 = 要预览的 PATCH → `{subscribers, over_quota}`（有效订阅数；其中已用量超过新配额的有多少） |
| GET/POST | /api/v1/servers | admin | Q1：服务器（机器，agent）连同其节点和入口分组：`[{id, name, created_at, status, online, agent_version, core_version, agent_os, agent_arch, agent_protocol, agent_capabilities, update_status, config_version, user_version, tls_domain, agent_addr, last_error, last_error_at, failed_config_version, failed_user_version, lease_expires_at, lease_remaining_seconds, traffic_max_rate_bytes_per_sec, deleting_at, last_seen_at, enrolled, cert_not_after, enroll_token_expires_at, latency, probe_requested_at, alerts_firing, heartbeat, warnings, nodes: [{id, name, display_name, enabled, visible, sort, region, tags, protocol, port, block_rules_enabled, entrances: [EntranceView]}]}]`（ETag，`If-None-Match` → 304）/ 创建服务器 `{name, tls_domain?, install?: {origin?}}`（201：一次性注册令牌 + bootstrap 文件 + 安装命令，只显示一次；节点用 `POST /nodes {server_id}` 添加）。审计 `server.create`、`server.enroll_token` |
| GET/PATCH/DELETE | /api/v1/servers/{id} | admin | Q1：单个服务器（同列表，D5：带 `traffic_quota {bytes, mode, reset_day, next_reset_at, period_start, rx_bytes, tx_bytes, used_bytes, exceeded_at}`）/ `{name?, tls_domain?, traffic_max_rate_bytes_per_sec?, traffic_quota_bytes?, traffic_quota_mode?: both\|up\|down, traffic_quota_reset_day?: 1–31}`（D5 配额按服务器的网卡计量；超额后该服务器的所有节点收到空状态，直到下个周期或配额提高；`server.quota_invalid`、`server.quota_mode_invalid`、`server.reset_day_invalid`）（`tls_domain` = 服务器的域名：agent 自行获取证书；变更会使 config_version 递增，DEPLOY §3f；审计 `server.update`）/ 删除（202，两阶段：agent 先收到空状态，然后证书被吊销，服务器及其节点被删除；审计 `server.delete`）。删除过程中任何变更均 `409 server.deleting` |
| POST | /api/v1/servers/{id}/enroll-token | admin | 新的一次性注册令牌 + bootstrap 文件（重新注册） |
| POST | /api/v1/servers/{id}/install | admin | 新的一行安装命令 `{origin?}`（重新安装；替换该服务器未使用的令牌） |
| GET/PUT | /api/v1/servers/{id}/alert-rules | admin | W17：每服务器的告警覆盖 `{muted, disabled: [kind], offline_secs?, cpu_percent?, cpu_minutes?, mem_percent?, mem_minutes?, disk_percent?, cert_days?}`（null = 使用全局值） |
| GET | /api/v1/servers/{id}/status | admin | W11：最新心跳 + 机器状态、在线状态、延迟结果（面板 TCP 目标 `<node> / <entrance>`）、其节点的原始/计费流量 |
| GET | /api/v1/servers/{id}/metrics | admin | W11：历史 `?range=1h\|6h\|24h\|48h\|7d\|30d\|90d`（每点为平均值和最大值，≤ 360 个点） |
| POST | /api/v1/servers/{id}/probe | admin | W11："立即测速"（202；内置 30 秒冷却内再次触发返回 429） |
| GET/POST | /api/v1/nodes | admin | W17：`?view=summary` = 仅列表所需的列（无 inbound JSON，精简心跳，最佳 agent 延迟，`alerts_firing`，`needs_certificate`），带 ETag（`If-None-Match` → 304；默认的 `?view=full` 也带 ETag）；full：节点列表，每个节点带其服务器（`server_id`、`server_name`）及该服务器的机器状态（状态、证书到期、上次心跳、延迟、agent、TLS 域名：同 `/servers`）、节点唯一的 `inbound`（W28-a，null = 无）及其 `entrances`（`[{id, kind, name, connect_host, connect_port, rate_permille, rate, enabled, sort, wire_no, listen_port, source_cidrs, health_ok, health_at, health_failures, health_error, hidden_since, group_ids}]`；被健康检测隐藏的中转（连续 3 次 TCP 连接失败）会从订阅和 `/me/nodes` 中去掉直到恢复应答，并触发该服务器的 `entrance_down` 告警；内置的 `direct` 入口排第一，然后是各中转），warnings / 创建节点 `{server_id?, name, region?, template? \| inbound?, display_name?, sort?, visible?, tags?, direct?: {connect_host?, connect_port?, rate?, enabled?, sort?, group_ids?}}`，建在 `server_id` 上，或——不带 `server_id` 时——连同一个同名的新服务器一起创建（此时另可带 `tls_domain?`、`install?: {origin?}`；带 `server_id` 时传这些服务器字段会报错 `node.server_fields`）。一个 inbound：模板（用服务器的 TLS 域名和空闲端口渲染）或不带 tag 的 xray inbound 对象；其端口不得与服务器上已提供的任何服务冲突（`entrance.port_clash`）；`direct` 设置内置的直连入口。201 `{id, server_id, name}`，若同时创建了新服务器，另含其一次性注册令牌 + bootstrap 文件 + 安装命令（只显示一次） |
| GET | /api/v1/nodes/{id} | admin | W17：单个节点，完整视图（节点页） |
| GET | /api/v1/inbound-templates | admin | 模板选项（REALITY dest、指纹） |
| POST | /api/v1/inbound-templates/render | admin | `{template, taken_ports?, tls_domain?}` → `{inbound, needs_certificate}`：一个 xray inbound 对象（全新的 REALITY 密钥；不存储；`taken_ports` 中的端口 = 400 `template.port_clash`；`tls_domain` = 节点的 TLS 域名，默认证书域名） |
| POST | /api/v1/inbound-templates/check-domain | admin | `{domain, node_id?, connect_host?}` → 域名的解析结果与节点地址的对比（agent 地址、直连入口主机；对 节点域名 的仅告警预检） |
| POST | /api/v1/inbound-templates/check-dest | admin | 由面板对 REALITY dest 做 TLS 1.3 + h2 检查 |
| PATCH/DELETE | /api/v1/nodes/{id} | admin | 启用（使其服务器版本递增）/ 重命名 / 地区 / W11 `display_name`、`sort`、`visible`、`tags`（倍率、地址和分组：`PATCH /entrances/{id}`；TLS 域名和计费上限：`PATCH /servers/{id}`）；删除（204：节点、其入口及其凭据立即删除，服务器继续运行；之后为它们上报的计数器不计费；审计 `node.delete`） |
| POST | /api/v1/nodes/{id}/entrances | admin | W28-a：中转入口 `{name, connect_host, connect_port, listen_port, source_cidrs, rate?, enabled?, sort?, group_ids?}`（201）：转发到该节点的外部中转。节点在派生 inbound 上提供它（节点的 inbound 换到 `listen_port`，有各用户独立的凭据），只接受来自 `source_cidrs`（中转的出口，1–64 个 IP/CIDR；由带 `source-filter` 的 agent 强制执行）的新连接；客户端连接 `connect_host:connect_port`；按服务器编号 `wire_no`（agent 键 `<user>#<n>`）。会被拒绝的情形：服务器已在使用的端口（`entrance.port_clash`）、节点已有的名称（409）。审计 `entrance.create` |
| PATCH/DELETE | /api/v1/entrances/{id} | admin | W28-a：入口的 `{name?, connect_host?, connect_port?, rate?, enabled?, sort?, group_ids?}`，中转另有 `{listen_port?, source_cidrs?}`（直连：host 为 null = 节点的 TLS 域名，port 为 null = inbound 的端口；中转两者都保留；`rate` 0–100，3 位小数；禁用它会把其用户从节点移除；审计 `entrance.update`）→ 该入口（D9：另有 `rate_now` = 当前生效的倍率，以及 `rate_rules`）/ 删除中转（204；直连入口：409 `entrance.direct_permanent`；审计 `entrance.delete`） |
| PUT | /api/v1/entrances/{id}/rate-rules | admin | D9：替换入口的分时段倍率 `{rules: [{weekdays: [1–7], start: "HH:MM", end: "HH:MM", rate}]}`（≤ 24 条；站点时区；end 早于 start 表示跨午夜；重叠时取最高者）→ `{entrance, warnings}`（重叠警告）。`entrance.rate_rule_invalid {index, detail}`、`entrance.rate_rules_too_many`；审计 `entrance.rate_rules.set` |
| PUT | /api/v1/nodes/{id}/inbound | admin | W28-a：`{inbound}` 替换节点唯一的 xray inbound（不带 tag 的对象；null = 无；其端口不得与服务器上的冲突；使服务器的 config_version 递增）。协议不变时用户保留凭据，协议改变时获得新凭据 |
| POST | /api/v1/users/{id}/sub-token | admin | 重置该用户的订阅：新令牌 + 每个入口的新凭据（高-3，同上） |
| GET | /api/v1/users/{id}/subscription | admin | W20：该用户的订阅链接 `{sub_token, sub_url, legacy}`（每次读取都审计为 `user.sub_token.read`，不含令牌；`no-store`） |
| POST | /api/v1/users/{id}/revoke-sessions | admin | 让该账号在所有地方登出（204） |
| POST | /api/v1/users/{id}/owner | owner | R47 `{confirm: true}`：把 owner 身份移交给一个已启用的管理员（204；400 `user.owner_confirm_required`，409 `user.owner_target` / `user.owner_already`，403 `user.owner_only`）；审计 `user.owner.transfer` |
| GET | /api/v1/me/shop | user (renewal scope*) | 在售套餐及其每个标价周期按调用者此刻购买的价格（`action` new/renew/switch/reset、`discount_cents`、`credit_cents`、`balance_cents`、`amount_cents`，或 `refusal`）、描述、库存；调用者的订阅、切换抵扣和余额。W16：`?coupon=CODE`（限速）按优惠券计价（`coupon.refusal` / 各报价的 `coupon_refusal`），`?use_balance=true` 计入余额 |
| GET/POST | /api/v1/me/orders | user (renewal scope*) | 自己的订单（最近 50 条）/ 创建 `{plan_id, period, coupon?, use_balance?}` → 订单 + 支付宝二维码（金额 = 服务端价格减去优惠券、切换抵扣和余额，在 SQL 中计算；被完全抵扣的订单立即标记为已支付） |
| GET | /api/v1/me/balance | user (renewal scope*) | W16：余额、可提现金额、流水（`?before&limit`） |
| GET | /api/v1/me/invite | user | W16：邀请计划条款、已邀请人数、佣金合计与历史（邀请码：W15；R46：`usdt_chains` `[{id, name}]`、`usdt_rate_cents`） |
| GET/POST | /api/v1/me/withdrawals | user | W16：自己的提现 / 申请 `{amount_cents, chain, address, memo?}`（R46：仅 USDT；chain 取自已启用的链，地址按链校验，memo 仅 TON；立即扣款；≤ 可提现金额） |
| POST | /api/v1/me/withdrawals/{id}/cancel | user | W16：取消待处理的提现（金额退回余额） |
| GET | /api/v1/me/orders/{id} | user (renewal scope*) | 订单状态；待支付订单会主动向支付宝查询（限流）。W36-b：每个订单视图（包括列表）都带有 `action`（new/renew/switch/reset），退款后还带有资金去向：`refund_route`（`original` = 经支付服务商原路退回，`balance` = 退到余额，`manual` = 在面板外退款并记录）、`refund_balance_cents`、`refund_external_cents`、`refund_effect`（P1：none/cancel/rollback/restore）；`refund_pending` = 原路退款正等待服务商处理 |
| POST | /api/v1/me/orders/{id}/cancel | user (renewal scope*) | 取消待支付订单（先向支付宝查询并关闭） |
| GET | /api/v1/plan-prices | admin | 每个套餐及其 `on_sale` 标记和价格，`payments_enabled` |
| PUT | /api/v1/plans/{id}/prices | admin | `{on_sale, prices: [{period, days?, price_cents}]}` 替换该套餐的价格（W7 的周期类型） |
| GET | /api/v1/orders | admin | 订单，`?status&email&out_trade_no&unfulfilled&via&before&limit`（keyset；`via=manual` = 管理员创建/确认；`email` = 买家当前的地址）。行带有 `user_label`（Q4 快照）和 `user_email`（当前地址，删除后为 null） |
| POST | /api/v1/orders/manual | admin | 运维：`{user_id, plan_id, period, gift?, reason}` → 经由唯一的支付路径产生一个已支付订单（`paid_via` manual；金额 = 来自 SQL 的该周期价格，赠送为 0，绝不取自客户端；履约失败 = 409 且不保留任何内容） |
| GET | /api/v1/orders/export.csv | admin | 运维：订单 CSV `?from&to&status&via`（按站点时区的天：本地午夜；≤366，默认最近 30 天；有审计） |
| GET | /api/v1/users/export.csv | admin | 运维：带列表筛选条件的用户 CSV `?q&plan_id&status&role&sort`（流式，UTF-8 BOM，防公式注入；有审计） |
| GET | /api/v1/traffic/export.csv | admin | 运维：全网流量历史 CSV `?from&to&group=day\|node`（站点日，列 `day`；有审计） |
| POST | /api/v1/users/batch/preview | admin | 运维：`{selection: {ids} \| {filter}}` → `{total, admins, sample}` |
| GET/POST | /api/v1/users/batch | admin | 运维：最近的任务 / 创建 `{selection, action: {kind: extend_expiry {days} (periodic subscriptions only)\|reset_traffic\|ban {reason}\|unban\|set_plan {plan_id, period, days?}\|cancel_plan\|add_balance\|send_email, …}}` → 202 + 任务（后台运行，每个用户经现有的 `apply_*` 执行一次，按用户审计） |
| GET | /api/v1/users/batch/{id} | admin | 运维：任务进度 + 条目（失败/跳过的在前）；`POST …/cancel` 跳过仍待处理的部分 |
| GET/POST | /api/v1/coupon-batches | admin | 运维：批次 / 生成 `{name?, prefix?, count ≤5000, length?, kind, value, …coupon terms, max_uses (per code, default 1)}` |
| POST | /api/v1/coupon-batches/{id}/revoke | admin | 运维：停用该批次的所有码（仅一次） |
| GET | /api/v1/coupon-batches/{id}/export.csv | admin | 运维：该批次的码，CSV 格式（有审计） |
| GET | /api/v1/orders/{id} | admin | 订单 + 支付事件 |
| POST | /api/v1/orders/{id}/fulfil | admin | `{reason}`：把未支付订单标记为已支付（手动），或重试失败的履约（有审计） |
| POST | /api/v1/orders/{id}/refund | admin | W16 `{reason, to_balance, external_cents?, keep_plan?, original?, original_cents?}`：对已支付订单退款一次（余额部分退回；支付宝金额：① `original` = 经支付宝退款（`alipay.trade.refund`，全额或其中 `original_cents`，幂等的 `out_request_no`；确认时 200，结果未知时 202 `{pending}`——对账循环会查询并重试，被拒绝时 502 `order_admin.refund_gateway_failed`——不动任何资金；该支付方式的 `refund_original` 开关，默认开），② `to_balance`，③ 否则 `external_cents` = 在支付宝后台已退的金额，订单有支付宝金额时必填；记为 `refund_balance_cents` + `refund_external_cents` = `refund_cents`）；归还优惠券使用次数（低-2）；撤销待结算的佣金，追回已入账的佣金（中-4：立即从邀请人余额扣回，余下部分记为欠款，与后续佣金冲抵）；P1：撤销该订单对订阅的影响（新购 → 取消，续期 → 收回该期限，切换 → 恢复原套餐，重置包 → 仅退钱），除非带 `keep_plan` |
| GET | /api/v1/orders/{id}/refund-preview | admin | P1：`{balance_part_cents, amount_cents, effect, original_available, original_request}`——此刻退款会产生的结果（`effect.kind` none/cancel/rollback/restore）；不可退款时 409 |
| GET/POST | /api/v1/coupons | admin | W16：优惠券 / 创建 `{code, kind percent\|fixed, value, plan_ids?, periods?, min_amount_cents?, starts_at?, ends_at?, max_uses?, per_user_limit?, new_users_only?, enabled?}` |
| GET/PATCH/DELETE | /api/v1/coupons/{id} | admin | W16：优惠券 + 兑换记录 / 更新（code 不可改）/ 删除（仅限从未使用过的） |
| GET | /api/v1/balances | admin | W16：有余额的客户（`{user_id, email, …}`），`?email` 可查找任何人 |
| GET/POST | /api/v1/users/{id}/balance | admin | W16：余额 + 流水 / 调整 `{amount_cents (signed), reason}`（不会低于 0） |
| GET | /api/v1/commissions | admin | W16：佣金 `?status&email&limit`（`email` = 邀请人的）；行：`inviter_label`/`inviter_email`、`invitee_label`/`invitee_email` |
| GET/PUT | /api/v1/commission-settings | admin | W16：`{enabled, rate_percent, first_order_only, hold_days, min_withdrawal_cents, usdt_chains?, usdt_rate_cents?}`（R46：提供的 USDT 链，默认全部；参考汇率为每 USDT 的分数，仅用于显示） |
| GET | /api/v1/withdrawals | admin | W16：提现申请 `?status&email&limit`；行：`user_label`、`user_email` |
| POST | /api/v1/withdrawals/{id}/approve \| reject | admin | W16：手动以 USDT 打款后 `{usdt_amount, txid, note?}`（R46，有审计）/ `{reason}`（金额退回余额） |
| GET/POST | /api/v1/me/tickets | user (portal scope*) | W17：自己的工单（未读标记）/ 新建 `{subject, category, priority?, message, order_id?, node_id?}`（5 次/小时，未关闭的最多 5 个） |
| GET | /api/v1/me/tickets/{id} | user (portal scope*) | W17：自己的工单 + 消息（客服只显示为客服，不显示姓名）；标记回复为已读。他人的 / 未知的 / 格式错误的 id = 标准拒绝 |
| POST | /api/v1/me/tickets/{id}/replies \| close | user (portal scope*) | W17：`{message}`（30 次/小时；已关闭时 409）/ 关闭 |
| GET | /api/v1/tickets | admin | W17：队列 `?status=open\|answered\|closed\|active&category&priority&assignee=me\|none\|<id>&unread=true&q&page` + 待处理/未读计数 |
| GET | /api/v1/tickets/{id} | admin | W17：工单（`user_email`、`assignee_email`）+ 对话（`author_label`、`author_email`；把客户的消息标记为已读） |
| POST | /api/v1/tickets/{id}/replies \| close \| reopen | admin | W17：`{message, close?}` / 关闭 / 重开 |
| PUT | /api/v1/tickets/{id}/assignee | admin | W17：`{assignee_id}`（已启用的管理员，或 null） |
| GET | /api/v1/admins, /api/v1/admin-badges | admin | W17：可指派的管理员；控制台计数（未读工单、正在触发的告警） |
| GET | /api/v1/alerts | admin | W17：告警中心 `?status=firing\|resolved&server&kind&before&limit` + 按 kind 统计的 `firing` 数量（Q1：告警按服务器归属：`server_id`、`server_name`） |
| POST | /api/v1/alerts/{id}/ack | admin | W17：确认（仅审计一次） |
| GET/PUT | /api/v1/alerts/settings | admin | W17：阈值和渠道（Telegram 机器人、签名 webhook、邮件）；密钥只写（`*_set` 标记），`version` 用于乐观并发（409） |
| POST | /api/v1/alerts/test | admin | W17：`{channel}` 通过已保存的配置发送测试消息，`{ok, error?}` |
| GET | /api/v1/alerts/notifications | admin | W17：最近 100 条投递记录；`POST …/{id}/retry` 把死信重新入队 |
| POST | /pay/alipay/notify | Alipay signature | 支付宝异步通知（RSA2）；所有拒绝 = 标准拒绝；见 docs/PAYMENTS.md |
| GET | /sub/{token} | token | 订阅（按 UA 选格式；W20：`?format=clash\|sing-box\|links` 可显式指定）。W30：Clash（Clash Verge、Clash Meta for Android、FlClash、Mihomo Party、Stash、NekoBox）= 带 PROXY 组和路由模板（rule-providers）的 YAML；sing-box（`SFA/`、`SFI/`、`SFM/`、`SFT/`、内核）= 完整的 1.12+ 客户端配置（TUN + 本地 mixed inbound、DNS、PROXY selector、规则集）；其他（v2rayN/v2rayNG、Shadowrocket、Hiddify、未知）= base64 分享链接。每个入口是各自独立的代理，倍率 ≠ 1x 时名称中带当前倍率 |
| GET | /install/{token}[/agent/{arch}] | install link | 链接有效期内提供节点安装脚本 / agent 二进制（docs/DEPLOY.md §3） |
| GET | /healthz | — | 面板存活检查 |

\* 续费范围（R21）：已过期或因配额被禁用的 `role=user` 账号也能访问（登录应答 `expired` / `quota_exhausted`），连同 `/me/plan` 和 `/me/password`；所有提供或暴露代理访问的功能（订阅、sub-token）仍被拒绝。门户范围（W28-c）：续费范围的 `GET /me` 和工单，**被封禁**的 `role=user` 账号也能访问（登录应答 `banned`）；其余所有端点对其返回 403 `account.banned`。被禁用的管理员账号无法登录。

默认情况下 web 绑定 `127.0.0.1:8080`，gRPC 绑定 `127.0.0.1:8443`；可通过 `panel.toml`（仅限启动期键，见 `deploy/panel.toml.example`）或 `DATABASE_URL`/`VALKEY_URL` 覆盖。
其他一切都在控制台的 系统设置 中配置（存数据库；W25/R39），或是内置常量。

- `akari admin passwd <email>` 重置密码（并终止其会话）。
- `akari server enroll-token <id>` 签发新的一次性服务器注册令牌。
- `akari secrets rotate-prefix` / `akari secrets rotate-jwt` 轮换密钥（见 "Security"）。
- `akari settings unset admin-allow` 清除管理前缀的 IP 白名单（被锁在外面时使用）。

### Deployment behind a reverse proxy

Web 端口只能经由终止 TLS 的反向代理（Caddy、nginx）对外提供，并保持绑定在回环或内网地址上。gRPC 端口**不**经代理：agent 需要直接对它做 mTLS。

```toml
[web]
bind = "127.0.0.1:8080"
cookie_secure = true                 # default; false only for plain-HTTP dev
trusted_proxies = ["127.0.0.1/32"]   # the proxy's address(es) as seen by the panel
```

- 客户端地址（用于登录限速）**仅在** TCP 对端属于 `trusted_proxies` 时才取自 `X-Forwarded-For`，取的是最右侧本身不是受信代理的那一跳。客户端写入该头的任何内容都被忽略；来自不受信对端的请求按对端地址归属。默认（空）列表下永远不读这个头——此时代理后面的所有客户端共用代理的那一个桶，所以请务必设置。
- 代理必须向 `X-Forwarded-For` **追加**（nginx：`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，Caddy 默认如此），并且不能让客户端以受信地址直接连到面板。
- 所有路径原样转发（由面板决定：门户、管理前缀、订阅、安装链接、支付通知）；不要为面板的 404 加上可区分的错误页。
- 关闭：`SIGTERM`/`SIGINT` 会停止接受连接、结束 agent 流（UNAVAILABLE，agent 会重连）、执行最后一次流量 flush（≤ 5 秒），并在约 10 秒内退出，落在 `docker stop` 默认的宽限期内；使用进程管理器时至少留 15 秒。

### Security advisory GO-2026-6443 (更正, R26)

早期版本拒绝 xray 的 gRPC 传输，因为 agent 的 grpc-go（< v1.85.0）被列在 GO-2026-6443 之下（对没有 `:authority` 的请求会使服务端 panic）。
现在 agent 把 grpc-go 固定到已修复的上游提交（`v1.85.0-dev.0.20260825072537-93e31b48545e`，待 v1.85.0 打标签后替换），gRPC 入站重新被接受；协议/传输矩阵见 docs/DEPLOY.md §3d。

固定的版本：xray-core `v1.260327.0`（发布版 v26.3.27 的 Go 模块写法——Xray 用日历标签，Go 需要 semver）、axum 0.8、tonic 0.14、SQLx 0.9、fred 10（Valkey 客户端）、Go 1.27。

## Design notes

- **身份（Identity）**：agent 的 TLS 客户端证书序列号就是节点的身份；协议本身不携带凭据。v1 中 agent 密钥由面板签发（CSR 注册是计划中的升级）。
- **收敛（Convergence）**：面板是事实来源。每个节点状态都有单调递增的 `config_version`/`user_version`。在 Hello、Ack 或变更通知上发现版本不一致时：
  - 如果面板知道（本会话内）agent 当前运行的确切用户集，且只有用户变了，就用 `UserDelta` 修复；否则发送完整快照。因此 agent 能从任意状态收敛（包括面板回滚）。
  - delta 携带 base 和 target 版本：agent 只在其 base 之上应用；对 target 的重发按空操作应答；其他一概以 `BASE_MISMATCH` 拒绝（面板随即立刻发送快照）。
  - Hello 和每个 Ack 都带有 agent 实际所运行内容的状态哈希（见 `proto/agent.proto`，共享测试向量在 `proto/state_hash_vectors.json`）；不一致则用快照修复。
- **被撤权用户的最后流量**：撤销用户对某入口的访问（套餐变更、分组成员变化、入口被禁用）会记录 `entrance_users_departed`；移除之后才到达的 agent 最终计数器，在 `traffic.departed_grace_secs`（默认 15 分钟）内仍会计费。
- **流量历史（W22）**：每次 flush 还会按用户、入口（连同其节点）和站点时区的日期（Q3，默认 Asia/Shanghai；`traffic_daily` 按月分区，以及 `traffic_entrance_daily`；约每 30 秒从暂存表折叠一次）记录其结算内容。
  - 保留 流量明细保留天数（系统设置 → 安全，默认 400，`0` = 永久）天的明细；更早的整月汇总为月度数据（`traffic_monthly`），其分区被丢弃（因此按日数据最多会多保留一个月）。
  - 响应带有 `timezone`。管理员：`GET /api/v1/users/{id}/traffic`、`/nodes/{id}/traffic`、`/traffic/summary`；用户：`GET /api/v1/me/traffic`（仅节点名称）。
- **撤权方式（Removal mode）**（系统设置 → 节点通信 → 撤权方式）：gate（默认）就地移除/轮换用户；rebuild 把每次移除/轮换都作为完整快照发送（agent 的 gate 一旦存疑时的兜底）。
  - 无用户的入站（没有 clients 的 dokodemo/socks/http）既不过 gate 也不计费。
  - FakeDNS 嗅探（`sniffing.destOverride` 含 `fakedns` / `fakedns+others`，键名大小写不限）会被拒绝（400），agent 在 xray 自己解析之后也会再次拒绝。
- **控制协议修订（Control protocol revisions）**：agent 发送 `Hello.protocol_version`（当前：1）。低于面板 `MIN_AGENT_PROTOCOL` 的 agent（例如发送 0 的旧 agent）仍会被接受，但只得到空状态（无入站、无用户），并在节点的 `last_error` / `agent_protocol` 中标记。**上线顺序：先升级 agent，再升级面板。**
- **故障关闭租约（Fail-closed lease）**：每次成功读取节点期望状态（初始同步、每 60 秒的 reconcile）之后，面板会授予 agent 一份租约（24 小时，内置）。
  - 在这么长时间内没有得到授予的 agent（面板不可达，或面板在但数据库挂了）会停止 xray、忘掉其版本，并在重连后上报最终计数器。
  - agent 以 CLOCK_BOOTTIME 计量租约（挂起不会延长），下限为 >= 1 小时，且只在第一次授予之后才启动租约（旧面板永不会启动它）。节点视图：`lease_remaining_seconds`。
- **流量计费（Traffic accounting）**：agent 上报每个用户的*累计*计数器，并为每份上报标记其所属的会话（xray 实例生命周期）。
  - 面板在 `traffic_counters` 中按 `(node, user, session)` 保存高水位线，并按 `max(new - old, 0)` 计费，由 PostgreSQL 在一条语句中算出。因此重启、重试、重复和乱序上报都不会重复计费，flush 失败也不丢数据。
  - 需要 PostgreSQL >= 18（`RETURNING old/new`）。
- **每用户计数器**以 xray 用户的 `email` 字段为键，该字段被设为面板用户 id——面板与内核之间的身份映射就是身份本身。
- **管理前缀之后没有可供指纹识别的东西**：每个不知道秘密管理前缀的请求（或来自白名单之外的请求），以及每一次拒绝（方法错误、令牌错误、资源缺失、路径未知），都得到同一个空 404，不带面板的安全头，除 `Date` 外逐字节相同。
- **变更通知（多实例）**：节点期望状态版本的每次变化（以及每次节点删除），都会由 `nodes` 上的触发器在写入事务内发出 `NOTIFY akari_change '<node id>'`（`'del:<id>'`）；每个面板实例在专用连接上 LISTEN，只唤醒自己持有的该节点的会话。
  - 任何监听连接重连之后，所有本地会话都会重新读取其节点；每 30 秒一次自 ping 检测半开的监听连接；每个会话仍然每 60 秒 reconcile 一次。因此多个面板实例可以共享一个数据库。
  - **LISTEN 需要直连 PostgreSQL 会话：不要把面板放在事务/语句池模式的 PgBouncer 后面**（会话池模式没问题）。当 `pg_notification_queue_usage()` 超过 10%（监听器卡住）时会记录警告；队列满时每个写操作都会失败。
- **节点删除（Node deletion）**（两阶段）：删除操作先把节点标记为删除中并禁用，使其 agent 收敛到空状态（无入站、无用户），同时其最终计数器仍会计费。
  - 当 agent 已确认（再加 10 秒用于 flush），或超过 2 分钟，或没有在线 agent 时立即，任一面板实例上的后台任务会把证书序列号写入墓碑（`revoked_certs`，永久），并删除该节点（入口和访问行级联删除；`traffic_counters` 计费行保留）。仍然打开的会话以 UNAUTHENTICATED 关闭。
  - 被吊销的证书再次连接时，只会被接受以便送去空状态后关闭（被拒绝的 agent 会继续运行它最后的配置）；它永不计费，也永远不能再次注册（它由之续期的那张证书如果仍被接受，同理）。重新安装需要新的 `akari server add`。
- **计费合理性上限（Billing plausibility caps）**（只会少计，不会多计；计数器完整保存）：每个上限最多只计入一小段突发时间窗内流逝的时间（`traffic.node_burst_secs`，默认 120 秒）——按 (node, user, session) 为 `traffic.max_rate_bytes_per_sec`，按节点（所有用户合计）为 `traffic.node_max_rate_bytes_per_sec` 的 GCRA 预算（默认 10 Gbit/s；可经 PATCH 按节点覆盖 `traffic_max_rate_bytes_per_sec`），对照数据库中的 `nodes.traffic_tat`，所以面板重启不会多给额度，用量不足的节点也无法囤积大量突发额度。
  - 只有被记录下来的连通性中断才会放宽上限：agent 重新上线时，距节点上次被看到的时间（至多一个租约）会被计入一次，因此因中断而延迟的流量仍能全额计费。
  - 面板自身的 flush 中断（agent 保持连接而数据库挂了）同理：失败之后第一次成功的 flush，会把距该实例上次成功 flush 的时间（至多一个租约）一次性计入它所写的节点。
  - 被取消分配的用户的那一对（用户，节点）只会对取消分配之前合理承载的流量计费（+30 秒），跨 flush 累计。

## Plans and node groups

- **节点组（Node groups）**汇集节点（一个节点可属于多个组）。**套餐**授予节点组，并设置流量配额（`null` = 不限）和重置周期：`monthly`（在锚点日期的当月同一天，不足则取月末，按站点时区——Q3）、`days-N`（每 N 天，1–3650）或 `none`。
  - `speed_limit_mbps` 由 agent 按用户**强制执行**（W7，agent protocol 4：每个方向，由用户在节点上的所有连接共享，受限用户禁用 XTLS splice；旧 agent 不限速地运行该用户，节点上显示警告）。
  - `device_seats` 为席位绑定而存储（随客户端做，R25），**不强制执行**。
  - 被禁用的套餐不再提供给新的分配；现有订阅者保留它。价格、库存和销售规则见 docs/PAYMENTS.md。
- **套餐条款会被快照（中-5）**：订阅保留创建订阅时套餐的配额、重置周期、限速和节点组（`user_plans` + `user_plan_groups`，由每条创建路径上的触发器复制）；续期也保留它们。
  - 编辑套餐只改变新购买所得。若要同时改变该套餐现有订阅者，保存时选择 **同时应用到现有用户**（`apply_to_existing: true`）：他们将获得套餐当前的全部条款（审计中记录人数）；控制台会先显示 `POST /plans/{id}/impact`（订阅者人数，以及已经超过新配额、将被暂停的人数）。
- **用户套餐（D12）**：每个用户一个有效套餐（管理员不能有套餐）。
  - 用户只通过套餐管理：一次分配 = 一个套餐 + 期限（`month` … `three_year`、`days` + N、带或不带 N 天的 `onetime`），到期时间在 SQL 中计算，用量从零开始；续期从 max(到期时间, 现在) 起增加一个期限或 N 天（仅周期性订阅）。
  - `traffic_limit_bytes` 和 `expires_at` 始终取自套餐（没有 API 能直接写它们）。取消或到期会结束套餐并移除套餐的访问权限；生效的限额/到期时间保留作为记录。
- **封禁（Ban，W28-c）**：`disabled_reason = admin`，附带用户可见的原因。
  - 用户在同一事务中从所有节点移除（走通常的版本递增/撤权路径），所有会话终止；被封禁的用户可以再次登录，但只能访问 `GET /me`（带原因）和工单——订阅、节点、商店和订单都会拒绝他（403 `account.banned`）。
  - 流量重置和套餐变更永远不会解除封禁。
- **授权（Entitlement）**：用户的入口 = 其有效订阅（的快照）所含节点组的成员（W28-a/D3：唯一的访问来源；没有手动分配）。
  - 节点组、成员关系、套餐、用户套餐、入口或节点 inbound 的每次变化，都会在同一事务中 reconcile `entrance_users`：每个获授权、且其节点 inbound 为受管协议的入口发放一份凭据；协议不变时保留凭据（客户端在套餐变更后继续可用）；不再授权的访问被撤销（最终计数器在撤权宽限期内仍会计费）；并且恰好只递增受影响节点的版本。
- **配额与重置（Quota and resets）**：流量限额检查会以 `disabled_reason = quota` 禁用超额用户。
  - 周期重置（任一实例、每个 flush 周期、用数据库时钟）每个周期把用量清零一次——经 `user_plans.next_reset_at` 做到重启安全且幂等；错过的周期合并为一次重置——并重新启用**仅**因配额被禁用的用户；使被配额禁用的用户重新获得准入的套餐变更，也会重新启用他们。
  - 管理员明确的禁用（`disabled_reason = admin`）永远不会被自动撤销。重置和套餐到期以 actor `system` 记入审计。

## Payments (Alipay Face-to-Face)

套餐可以通过支付宝 当面付（二维码）销售：管理员给套餐定价（以人民币分为单位的整数，按 `period_days`），用户在门户购买，已支付订单在一个事务中授予或延长套餐，且恰好一次——无论支付结果是从异步通知、状态轮询还是后台对账得知的。
重复购买当前套餐会按其周期延长；购买另一个套餐会替换当前套餐（用量重置）。

W16（M7）：优惠券（百分比/固定金额，可限定范围、可限次数，无竞态的预留）、每用户余额（余额）及只追加的流水（订单可全额或部分用余额支付）、邀请佣金（先挂起一个保留期，再入余额；退款时冲回），以及人工打款的提现。
配置、沙箱测试、通知 URL 规则和对账：[docs/PAYMENTS.md](docs/PAYMENTS.md)。

## Registration, password reset and email (W15)

默认关闭。
1. 在 **系统设置 → 邮件** 配置 SMTP（STARTTLS / SSL/TLS / 本地中继的明文；密码用由 data/master.key 派生的密钥加密保存，之后不再显示），并发送一封测试邮件。
2. 然后在 **系统设置 → 注册** 开放自助注册（邮箱 + 6 位验证码，可选要求邀请码，可选邮箱域名白名单，可选 N 天试用套餐），和/或通过邮件链接重置密码（需要主域名）。

其他要点：

- 功能关闭时，其端点与任何未知路径一样返回同一个空 404。
- 请求从不等待 SMTP：邮件进入 outbox，由任一实例上的后台发送器带重试地投递；失败的会作为死信显示在 系统设置 下。
- 同一个 outbox 还承载订单回执，以及（启用时）套餐到期提醒（提前 N 天）、“已到期”和流量 80% / 100% 通知（每个事件一次）——只发往已验证的地址，使用账号的语言（zh/en）。
- 用户在门户中添加或更改自己的地址（当前密码 + 邮件验证码）；验证后的新地址从此成为其登录名。

详情：docs/DEPLOY.md §2c。

## Accounts

只有 `role=user` 账号才是代理用户。管理员账号永远不会被推送到节点，不能被分配到节点（400），访问订阅 URL 得到拒绝用的 404，并且免于流量限额禁用和到期。
把用户改为管理员会移除其节点访问权限；改回来则恢复。提高流量限额不会重新启用因该限额被禁用的用户。

## Security: master key, audit log, secret rotation

**主密钥（Master key）。** `data/master.key`（32 个随机字节，十六进制，0600，首次启动时创建；v0.4 之前为 `data/totp.key`——只有旧文件的安装会被一次性重命名，两份不同的副本则拒绝启动）是面板派生的所有密钥的根（带固定标签的 HMAC-SHA-256）：订阅链接的 AES-256-GCM 密钥、SMTP 密码、支付方式和告警渠道的密钥，以及邮件验证码和注册工作量证明的 MAC 密钥。
**请与 `data/` 的其余部分一起备份**：没有它，这些加密保存的密钥就无法打开（需要重新粘贴；用户需重置其链接）。

**审计日志（Audit log）。** 每一次管理变更（API 和 CLI——CLI 操作以 actor `cli` 记录）、密钥轮换和登录，都会连同时间（事务开始时间）、操作者、客户端地址、动作、目标以及脱敏的前后快照一起记录，且与变更处于同一事务。
- 操作者以非个人标签存储（`u-` + 账号 id 的前 8 位十六进制；控制台在其旁边显示该账号当前的地址）。
- 密码、哈希、令牌、代理凭据和 inbound 密钥永远不记录（只记录它们发生了变化；inbound 记录为协议/端口/传输的摘要加一个 digest）。
- 登录失败只记录已存在的账号（每个限速窗口内的第一次失败，以及使其达到上限的那一次；actor 为 `anonymous`）；普通用户的成功登录每账号至多每 10 分钟记录一次。
- 管理员：审计视图，或 `GET /api/v1/audit`。保留期：系统设置 → 安全 → 审计日志保留天数（默认 365，0 = 永久），每小时清理。

**密钥轮换（Secret rotation）。**
- `akari secrets rotate-jwt`：生成新的 `data/jwt.key`；所有会话立即终止（所有实例）；需要重启每个实例才会用新密钥签名。
- `akari secrets rotate-prefix`（或 系统设置 → 访问，仅 owner）：在数据库中生成新的管理前缀；所有实例立即切换，旧前缀变为普通拒绝。订阅、安装和支付链接不含该前缀，不受影响；请把新的控制台地址告知其他管理员。
- 订阅路径（系统设置 → 访问，任一管理员，需确认）：每个订阅链接随之改变，旧路径立即失效；默认会给每个已验证地址的用户邮件发送新链接（批处理任务；管理员批量邮件中的 `{sub_url}` 是每个收件人自己的链接）。
- 订阅链接（W20）：令牌既以哈希形式存储（用于查找），**又**用 AES-256-GCM 加密存储（AAD = 用户 id，密钥由 `data/master.key` 派生），因此门户能一直显示链接，管理员可以复制它（每次读取都有审计）。丢失 `data/master.key` 后链接仍可使用，但无法再查看（用户需重置）。W20 之前的账号保留其可用的链接；门户提供重置以使其可查看——绝不会被隐式轮换。用户在门户中重置自己的链接（`POST /api/v1/me/sub-token`，5 次/小时，需确认）；管理员可按用户操作。重置还会替换该用户在每个入口上的凭据（运营审查高-3）：导入了旧链接或其节点的客户端会被断开并拒绝，从而阻止泄露或被共享的订阅。

CLI 须以面板的服务用户身份运行，并指向面板所用的同一个 `data/` 目录（和数据库）。

## Upgrading

**M3（套餐）升级：** 迁移 0020 增加节点组、套餐和用户套餐。现有的节点分配变为手动覆盖并保持不变地继续工作；现有被禁用的用户获得 `disabled_reason = admin`（因此任何重置都不会再启用他们）。

通过 `scripts/install.sh` 安装的环境：`akari-ctl upgrade`（备份、签名校验、切换、健康检查、自动回滚；docs/DEPLOY.md §5）。

**先升级 agent，再升级面板。** 面板会丢弃缺少 `TrafficReport.session_id` 的流量上报，并依赖 agent 从不声称自己拥有未成功应用的版本；旧 agent 对着新面板不会计费，而且可能在未收敛时看起来已收敛。
迁移在 `akari serve` 时自动运行（需要 PostgreSQL >= 18，启动时检查）。

## Licence

面板采用 MIT 许可（`LICENSE`）。`akari` 二进制静态链接 Rust crate，并内嵌由 npm 包构建的 Web 控制台；它们的许可证在 CI 中由 `cargo deny check`（`deny.toml`：只允许宽松许可证——没有 copyleft 会进入面板二进制）检查，并连同许可证文本列在 `THIRD_PARTY_LICENSES.txt` 中，每个发布版本都把它作为附件发布（`make third-party` 把它写到 `target/`；`scripts/third-party.py`）。
节点 agent 是独立的程序，有自己的许可：源码为 MIT，但其发布的二进制是 GPL-3.0-or-later 的组合作品（xray-core 链接了 GPL 模块）——见 akari-agent 的 README（"Licence"）。面板只负责中继 agent 二进制以供自更新和一行安装，不会链接它们。

## Roadmap

权威计划见 `PLAN.md`（三仓库终态：`akari-panel` / `akari-agent` / `akari-client`）。战略决策：

- **第三方订阅由后台开关控制。** 各订阅格式与一键导入按客户端分别开关（默认开启）；自研客户端 akari-client 发布后，运营者可自行选择关闭第三方格式，不强制只保留自有客户端（2026-10-06 战略决策 2 修订）。
- **设备限制采用席位绑定**（客户端登记其设备），而非基于 IP——随 akari-client 实现，现在刻意不做。

已完成：控制平面、认证/REST API、内嵌 SPA、订阅（REALITY/TLS/WS 映射、填充、哈希令牌——WS+gRPC 传输映射尚不完整）。
下一步：拆仓 → akari-client MVP（内嵌 mihomo）→ 席位绑定（+ 订阅淘汰）→ agent CSR/自动更新 → 支付。
