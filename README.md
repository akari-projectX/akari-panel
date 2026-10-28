# Akari

**自托管的代理服务控制面板：一个 Rust 单二进制面板 + 每台节点上一个内嵌 xray-core 的 Go agent。**
A self-hosted control plane for proxy services: one Rust binary for the panel, one Go agent per node.

Akari 管理用户、套餐、订阅、计费和节点，并把结果实时推到节点上：用户被禁用、套餐到期、凭据被轮换，对应的活连接在一秒内被切断；节点只主动外连面板，没有任何入站管理端口。一个面板实例即可承载 200 个节点 / 5 万用户。
（节点协议是面板与 agent 之间专用的 gRPC 契约，不兼容 V2Board / XrayR 的节点接口。）

```
┌──────────────── Rust binary (akari) ────────────────┐
│ axum web        portal at /, console + API behind a │
│                 secret admin prefix, empty 404 else │
│ tonic gRPC      mTLS AgentChannel (server)          │
│ PG 18           source of truth: users / nodes /    │
│                 traffic ledger / audit              │
│ Valkey 9        liveness TTL keys, heartbeat blobs, │
│                 rate limits                         │
└───────────────▲────────────────────────────────────┘
                │ outbound-only mTLS gRPC stream
┌───────────────┴────────────────────────────────────┐
│ Go agent: embedded xray-core, dynamic AddUser,     │
│ per-user traffic counters, heartbeats              │
└────────────────────────────────────────────────────┘
```

- [性能](#性能) · [技术栈](#技术栈) · [特性](#特性) · [安全模型](#安全模型)
- [部署](#部署) · [升级](#升级) · [迁移](#迁移) · [卸载](#卸载)
- [仓库结构](#仓库结构) · [文档索引与许可](#文档索引与许可)

## 性能

下面的数字都是本仓库实测，全部可用 [`bench/`](bench/) 复现（命令与方法见 [`docs/PERF.md`](docs/PERF.md)，每个数字在那里有测量日期与机器）。数据集：**200 个节点 / 5 万用户 / 每节点 1 万用户**（约 200 万条授权行、200 万条流量计数行），单个面板实例，PostgreSQL 18 与 Valkey 9 在同一台机器上，压测器也在这台机器上，所以延迟偏保守。

| 场景 | 实测 |
|---|---|
| 1 万用户节点的完整快照构建（读库 + 用户集 + 状态哈希 + 编码） | 约 21–25 ms |
| 5 万行流量一次结算（含流量明细） | 约 0.58 s（4 vCPU 开发机，分 5000 行一块） |
| 订阅响应 p99 | 空闲 5.1 ms；200 个 agent 在线上报时 16.7 ms |
| 管理 API p99 | 仪表盘 16–21 ms；用户搜索 7–31 ms；200 个 agent 在线时节点列表（摘要视图）12–26 ms |
| 管理员变更 → 节点生效 | p50 0.26 s，p99 0.59 s；两个面板实例 + 负载均衡器 p99 0.89 s |
| 流量计费精确度 | 上报量 = 计费量，精确到字节（单实例与双实例） |
| 订单搜索（20 万订单，SQL 部分） | 稀有关键字 p50 0.55 ms，邮箱片段 0.24 ms（trigram 索引） |
| 登录洪水（256 并发，4 vCPU 共享机） | 被拒请求 p50 7.5 ms，约 12.5k req/s，同时管理员请求 p50 62 ms |
| 单实例承载 200 个 agent × 1 万用户 | 稳态内存 0.55 GiB |
| 空闲常驻内存（1 vCPU / 920 MB VPS，含一个 agent） | 面板 5 MB、PostgreSQL 56 MB、Valkey 8 MB、Caddy 17 MB、agent 27 MB |
| agent：1 万用户 xray 重建 / 增删 1 个用户 | 约 57 ms / 5.4 µs |
| agent：每个被代理连接的准入判断（撤权闸门） | 249 ns |

注：表中结算数字来自 2026-10 的开发机；在另一台更慢的共享 4 vCPU 机器上同一条结算语句测得 1.5 s，所以结算耗时随硬件和同机负载变化，PERF.md 如实记录了两者。200 个 agent × 1 万用户同时重连的风暴在共享 4 vCPU 机器上 13–17 s 全部恢复。

**为什么快**

- **长连接 + 增量推送。** 每个 agent 与面板之间是一条长连接，面板只在有变化时推送。用户变化走 `UserDelta`（微秒级，不重建 xray、不断开其他用户的连接），只有入站结构变化才整体快照。
- **结算在一条 SQL 里完成。** agent 上报累计值，面板按块用单条语句（`RETURNING old/new`）对账、套用倍率与上限、写入流量明细；每行幂等，重放、重试、多实例都不会多记。流量明细先追加到无索引的暂存表，后台再合并，不拖慢结算路径。
- **变更即时传播。** 改状态的操作在同一事务里写库、递增版本、发 `NOTIFY`，所有面板实例立即唤醒受影响节点的会话（< 1 s），不等轮询周期。
- **撤权立即生效。** 节点内的 gate 在分发层按用户凭据放行，禁用、过期或轮换凭据会立刻切断该用户的活连接；会话鉴权每个请求只查一次索引（约 0.4 ms）、**不做缓存**，所以吊销在下一个请求、所有实例上生效。
- **读路径按索引设计。** 快照读取用覆盖索引避免堆分散；节点列表改为分组连接；订阅在进程内渲染；订单与用户搜索走 trigram 索引。
- **单个静态二进制。** Rust + mimalloc，内置 TLS 与 gRPC，空闲时面板只占几 MB。
- **多实例。** 多个面板实例共用 PostgreSQL + Valkey，会话、限速与吊销跨实例一致；agent 在实例间切换不会重复计费。

## 技术栈

| 层 | 组成 |
|---|---|
| 后端 | Rust（edition 2024）单二进制 `akari`；axum 0.8（web）、tonic 0.14 gRPC（`proto/agent.proto` 由 protox 编译）、sqlx 0.9（PostgreSQL 18，依赖 `RETURNING old/new`）、fred 10（Valkey）、rustls（ring）、webauthn-rs（通行密钥）、argon2、lettre（SMTP）/ Resend、prometheus 指标、mimalloc |
| 用户门户 | Svelte 5 + Vite 8 + Tailwind 4 + bits-ui，中英双语，Playwright e2e（桌面 + 手机） |
| 管理后台 | React 19 + TypeScript + Vite 8 + Tailwind 4 + TanStack Query；登录页与控制台是两个独立构建包；邮件与订阅模板用 CodeMirror 6 编辑；中英双语，Playwright e2e |
| 节点 agent | Go 1.27；内嵌 xray-core（[akari-projectX 的分支](https://github.com/akari-projectX/xray-core)，在官方版本上只多一处补丁）；仅出站 mTLS gRPC；systemd 或 OpenRC；Ed25519 签名的自更新 |
| 数据与部署 | PostgreSQL 18、Valkey 9、Caddy（按需 TLS）；Docker（distroless 静态 musl 镜像）或裸机，均由安装器完成；Prometheus 指标 + 告警规则、Grafana 面板 |
| 质量与供应链 | 分级 CI 与合并队列；`cargo deny`、`clippy -D warnings`、golangci-lint；knip、jscpd、cargo-machete；cargo-fuzz + Go 原生 fuzz；计费核心覆盖率门槛；cosign 无密钥签名、SBOM、按摘要固定的容器镜像 |

前后端通过 HTTP JSON API 通信；门户与后台都嵌入二进制（rust-embed），部署时没有单独的前端服务。

## 特性

**面板**

- **用户门户**（`/`）：邮箱 + 密码或通行密钥登录、套餐与用量、订阅链接与一键导入、节点线路（在线 / 负载 / 延迟）、商店与订单、钱包与邀请返利、工单、公告与帮助中心、账号注销。
- **管理后台**（独立应用，位于机密前缀之下）：仪表盘、用户、套餐与节点组、服务器 / 节点 / 入口、订单与退款、优惠券、提现、工单、告警、审计日志、DNS、系统设置、批量操作与 CSV 导出。
- **服务器、节点与入口**：一台服务器 = 一个 agent 身份，其上可有多个节点（xray 入站）；每个节点有「直连」入口，可再加**中转入口**（独立凭据、来源 IP 白名单、健康检查、分时段倍率）；服务器可设按网卡计的月流量额度。
- **套餐与计费**：按周期定价、库存、换套餐折算、周期重置、限速；订单、优惠券、余额、邀请返利、提现（USDT）、退款（含原路退款）；支付渠道可插拔：支付宝当面付、易支付、CoinPayments、Coinbase（见 [`docs/PAYMENTS.md`](docs/PAYMENTS.md)）。
- **订阅**：按真实客户端 UA 输出 Clash / sing-box / Surge / Surfboard / 通用链接；每种客户端的订阅模板可在后台编辑；各格式与一键导入可单独开关。
- **协议**：VLESS（REALITY / TLS / WS / gRPC / XHTTP）、VMess、Trojan、Shadowsocks 2022（多用户）、Hysteria 2；协议能力清单是单一数据源（`proto/protocols.toml`），部署文档与后台表单由它生成。
- **登录与账号**：通行密钥（含多个主域名共用的关联来源）、Cloudflare Turnstile 与蜜罐可选、注册 / 找回密码 / 邀请码、安全通知邮件、唯一的「所有者」账号。
- **通知与运营**：告警中心（Telegram / webhook / 邮件）、可编辑的邮件模板、公告与帮助中心、站点品牌、系统状态页、Prometheus 指标（独立监听）。
- **DNS 管理**：用 Cloudflare 令牌直接管理区域与记录，并一键把面板或节点域名指向正确地址。
- **审计规则**：按节点开关的域名 / IP / 协议拦截（不记录用户或目标，只记每规则命中次数）。
- **安装器**：`akari-ctl` 一条命令完成安装、升级（带备份与自动回滚）、备份恢复、同机迁移、卸载，也支持多个面板实例；节点一键安装命令支持 Debian / Ubuntu（systemd）与 Alpine（OpenRC），并自动开启 BBR。

## 安全模型

- **节点身份**是 mTLS 客户端证书（P-256，私钥只在节点生成，面板 CA 签发，90 天自动续期）；注册用一次性 token。节点上没有入站管理端口。
- **机密的后台前缀**：全站唯一的秘密，可轮换、可加 IP 白名单；其余一切拒绝（错误前缀、白名单外、垃圾路径、坏订阅令牌）都返回**字节同构的空 404**，探测无法区分。
- **登录**：argon2id（有界队列，繁忙时 503 而不是拖垮服务）、失败限速、会话吊销（改密码 / 禁用 / 登出即刻全端失效）、通行密钥、防机器人。
- **面板是唯一事实源**：任何改变节点 / 用户期望状态的操作在**同一事务**里写库、递增版本并写审计；管理操作全部有审计，密钥只记「已更改」。
- **出站访问防护**：面板访问运营者给定地址（webhook、规则下载、支付网关等）一律经 SSRF 防护，只连公网地址。
- **agent 自更新**：编译进 agent 的 Ed25519 发布公钥是信任根，面板只做中继；支持分批灰度，失败自动回滚，降级只能用带有效期的签名回滚清单。
- **供应链**：发布件有 SBOM 与 cosign 无密钥签名，安装器逐项校验；容器镜像按摘要固定。

## 部署

在全新的 **Debian 12/13 或 Ubuntu 22.04/24.04**（amd64 / arm64，≥ 1 GB 内存）上，以 root 或有 sudo 的用户执行（非 root 用 `| sudo sh`）：

```bash
curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh | sh
```

安装器按系统语言显示中文或英文提示，每一项都有默认值：

- **部署方式**：Docker Compose（默认），或裸机（systemd 下的 PostgreSQL 18 + Valkey 9 + Caddy）。
- **访问方式**：域名（先把 DNS 指向本机，放行 80 / 443 / 8443），或仅用 IP。
- **管理员邮箱**（即登录名）；密码自动生成，**只显示一次**。

安装前会先校验发布版本（cosign 签名的 `SHA256SUMS`）。结束时打印后台地址（含机密前缀）、门户地址和管理员密码。之后：登录后台 → 系统设置确认域名 → 节点 → 添加节点 → 在节点上执行一键安装命令。

全自动安装：`… | sh -s -- --yes --mode bare --domain panel.example.com`（`install.sh --help` 列出全部选项）。其他发行版 / nginx / 已有数据库：见 [`docs/DEPLOY.md`](docs/DEPLOY.md) 附录 A（Docker Compose）与附录 B（裸机）的手动步骤。

安装后可用：

```bash
akari-ctl status     # 服务状态 + 健康检查
akari-ctl info       # 再次显示后台与门户地址
akari-ctl upgrade    # 升级
akari-ctl backup     # 备份
akari-ctl migrate --to docker|bare   # 同机迁移
akari-ctl uninstall [--purge]        # 卸载
```

## 升级

```bash
akari-ctl upgrade                  # 最新发布版；--version vX.Y.Z 指定版本
```

升级会先运行目标版本自带的安装器，校验发布签名，然后依次：备份 → 新二进制先对现有配置做 `config check` → 原子切换（保留 `.prev`）/ 更换镜像 tag@digest → 健康检查；**失败自动回滚**。数据库迁移只前进、在监听前跑完（需要 PostgreSQL ≥ 18）。

要点：

- **先升级 agent，再升级面板。** 面板会丢弃缺少 `session_id` 的流量上报；协议过旧的 agent 会被下发空状态并在后台标出。agent 通过后台「更新」页做签名自更新与分批灰度，也可在节点上重跑安装命令。
- 备份在 `/var/backups/akari/`；设置 `AGE_RECIPIENT` 后用 age 加密，否则是 0600 明文并给出警告。
- 升级后想撤销：没有运行迁移时直接换回旧二进制 / 镜像；运行过迁移则需恢复升级前的备份。详见 [`docs/DEPLOY.md`](docs/DEPLOY.md) §5「升级」与 §6「回滚」。

## 迁移

- **同一台机器，裸机 ⇄ Docker**：`akari-ctl migrate --to docker`（或 `--to bare`）。保留后台前缀、CA 与密钥，面板停机一两分钟，agent 继续服务并自行重连；任何一步失败都会切回旧模式。
- **换服务器**：

  ```bash
  # 旧机
  akari-ctl backup --out /root/move          # 推荐用 age 加密
  scp -r /root/move/akari-<UTC> new-host:/root/
  # 新机（全新的 Debian / Ubuntu）
  curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh \
    | sh -s -- --restore /root/akari-<UTC> [--age-identity backup.key] [--domain …]
  ```

  新机得到相同的后台前缀、CA 与密钥，域名切换后**现有节点与订阅链接继续可用**。建议提前降低 DNS TTL，在最后一次备份前停止旧面板，新机验证通过后再停用旧机。以 IP 注册的节点需要重新注册。
- 详见 [`docs/DEPLOY.md`](docs/DEPLOY.md) §8「迁移」与 [`docs/BACKUP.md`](docs/BACKUP.md)。

## 卸载

```bash
akari-ctl uninstall                 # 停止并移除服务；数据与配置保留
akari-ctl uninstall --purge         # 同时删除数据库、数据目录、配置（需输入 purge 确认）
```

普通卸载会保留数据库、`/var/lib/akari`（CA 私钥、`jwt.key`、`master.key`）与配置，再次运行安装器即可接管（相同的前缀与账号）。`--purge` 之后每个节点都需要重新注册（CA 已不存在），除非恢复备份；`/var/backups/akari` 中的备份**永远不会被删除**。节点上的 agent 用 `akari-agent-uninstall` 卸载。详见 [`docs/DEPLOY.md`](docs/DEPLOY.md) §7。

## 仓库结构

节点 agent 在兄弟仓库 [`akari-agent`](https://github.com/akari-projectX/akari-agent)，两个仓库需并排检出才能跑 `smoke.sh`。逐文件说明见 [`src/CLAUDE.md`](src/CLAUDE.md)，不变量见 [`CLAUDE.md`](CLAUDE.md)。

```
akari-panel/
├── src/                   Rust 后端（crate akari_panel；main.rs = CLI 与启动）
├── proto/                 控制协议正本 agent.proto + 协议能力清单 protocols.toml
├── migrations/            sqlx 迁移（启动时自动执行）
├── portal/                用户门户（Svelte 5）
├── admin/                 管理后台（React，登录页包 + 控制台包）
├── deploy/                docker-compose、systemd 单元、Caddy / nginx、Prometheus 规则、Grafana 面板
├── scripts/               install.sh（= akari-ctl）、backup / restore、发布打包、e2e / 安装器测试
├── docs/                  部署、参考、备份、支付、性能、模糊测试
├── bench/                 压测与基准工具（独立 crate，不进发布二进制）
├── fuzz/                  cargo-fuzz 目标（独立 crate）
├── smoke.sh               跨仓端到端验收（需 ../akari-agent）
└── Dockerfile             portal + admin → musl 静态二进制 → distroless 镜像
```

## 文档索引与许可

| 文档 | 内容 |
|---|---|
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | 部署、升级、回滚、卸载、迁移、协议矩阵、节点与告警、发布校验 |
| [`docs/REFERENCE.md`](docs/REFERENCE.md) | 功能与实现参考：行为说明、API 表、设计笔记 |
| [`docs/BACKUP.md`](docs/BACKUP.md) | 备份与恢复 |
| [`docs/PAYMENTS.md`](docs/PAYMENTS.md) | 支付渠道、套餐目录规则、优惠券 / 余额 / 返利 |
| [`docs/PERF.md`](docs/PERF.md) · [`docs/FUZZING.md`](docs/FUZZING.md) | 性能数字与复现、模糊测试与覆盖率门槛 |
| [`CLAUDE.md`](CLAUDE.md) · [`src/CLAUDE.md`](src/CLAUDE.md) | 开发者须知：硬性不变量、模块地图 |

面板采用 MIT 许可（[`LICENSE`](LICENSE)）。`akari` 二进制静态链接的依赖在 CI 中由 `cargo deny` 检查（只允许宽松许可证），许可证清单作为 `THIRD_PARTY_LICENSES.txt` 随每个发布版本发布。
节点 agent 是独立程序，自有源码为 MIT，二进制链接 xray-core（MPL-2.0）等模块，许可清单见 akari-agent 的 README「Licence」。面板只负责中继 agent 二进制，不会链接它们。
