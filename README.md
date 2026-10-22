# Akari

**一个自托管的代理面板控制平面：Rust 单二进制面板 + 内嵌 xray-core 的 Go 节点 agent。**
A self-hosted control plane for proxy services: one Rust binary for the panel, one Go agent per node.

面板与 V2Board / Xboard / SSPanel 做同一类事——用户、套餐、订阅、计费、节点管理——但架构不同，差别主要在性能：长连接增量推送、单条 SQL 批量结算、撤权立即断线，一个实例即可承载 200 个节点 / 5 万用户。
**刻意不兼容 V2Board / XrayR 协议**——这是需求，不是缺陷。

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

- [特性](#特性)
- [性能：与 V2Board / Xboard / SSPanel 的区别](#性能与-v2board--xboard--sspanel-的区别)
- [部署](#部署) · [升级](#升级) · [迁移](#迁移) · [卸载](#卸载)
- [目录树与功能映射](#目录树与功能映射)
- [路线](#路线)
- [文档索引与许可](#文档索引与许可)

## 特性

**面板**

- **用户门户**（`/`）：注册 / 登录（邮箱 + 密码，或通行密钥）、套餐与用量、订阅链接、节点线路、商店与订单、钱包与邀请返利、工单、公告与帮助中心、账号注销。React 19，中英双语。
- **管理后台**（独立应用，位于机密前缀之下）：用户、套餐与节点组、服务器 / 节点 / 入口、订单与退款、优惠券、提现、工单、告警、审计日志、系统设置、批量操作与 CSV 导出。
- **节点与入口**：一台服务器 = 一个 agent 身份，其上可有多个节点（xray 入站）；每个节点有「直连」入口，可再加**中转入口**（独立凭据、来源 IP 白名单、健康检查、分时段倍率）。
- **套餐与计费**：按周期定价、库存、换套餐折算、周期重置、限速；订单、优惠券、余额、邀请返利、提现（USDT）、退款（含原路退款）；支付渠道为可插拔结构，目前接入支付宝当面付。
- **订阅**：按真实客户端 UA 输出 Clash / sing-box / 通用链接，分流模板可编辑，各格式可由后台开关。
- **协议**：VLESS（REALITY / TLS / WS / gRPC / XHTTP）、VMess、Trojan、Shadowsocks 2022（多用户）、Hysteria 2；协议能力清单是单一数据源（`proto/protocols.toml`）。
- **审计规则**：按节点开关的域名 / IP / 协议拦截（不记录用户或目标，只记每规则次数）。
- **运营**：告警中心（Telegram / webhook / 邮件）、系统状态页、Prometheus 指标（独立监听）、邮件模板与站点品牌、从未使用账号的自动清理。

**安全与可靠性**

- 节点身份是 mTLS 客户端证书（P-256，节点自己生成私钥，面板 CA 签发，90 天自动续期）；注册用一次性 token。
- 管理后台前缀是全站唯一的秘密，可轮换、可加 IP 白名单；其余一切拒绝（错误前缀、白名单外、垃圾路径）都是**字节同构的空 404**。
- 登录：argon2id、失败限速、会话吊销（改密码 / 禁用 / 登出即刻全端失效）、通行密钥（支持跨域名的关联来源 ROR）、Cloudflare Turnstile 与蜜罐可选。
- 面板是唯一事实源：任何改变节点 / 用户期望状态的操作，在**同一事务**里写库并递增版本、写审计；多实例通过 PostgreSQL `LISTEN/NOTIFY` 收敛。
- agent 自更新：编译进 agent 的 Ed25519 发布公钥是信任根，面板只做中继；支持分批灰度，更新失败自动回滚。
- 发布件有 SBOM 与 cosign 无密钥签名，安装器逐项校验。

## 性能：与 V2Board / Xboard / SSPanel 的区别

Akari 的差别主要在性能：热路径（节点同步、流量结算、订阅）按「大规模、多节点、高频上报」设计。

**Akari 的实测**（[`docs/PERF.md`](docs/PERF.md)，单个面板实例；数据集 200 个节点 / 5 万用户 / 每节点 1 万用户，约 200 万条授权行；复现命令在文档里）：

| 场景 | 实测 | 目标 |
|---|---|---|
| 1 万用户节点的完整快照构建 | 约 21–25 ms（2026-10-07 复测；此前为 43 ms） | < 200 ms |
| 5 万行流量一次结算（flush，含流量明细） | 0.58 s（约 91 ms / 5000 行块） | < 1 s |
| 订阅响应 p99 | 空闲 5.1 ms；200 个 agent 在线上报时 16.7 ms | < 30 ms |
| 管理 API p99（用户搜索、仪表盘、节点流量） | 约 7–31 ms；仪表盘 16–21 ms | < 50 ms |
| 管理员变更 → 节点生效 | p50 0.26 s，p99 0.59 s（双实例 + 均衡器 p99 0.89 s） | < 2 s |
| 流量计费精确度 | 上报量 = 计费量，精确到字节（单实例与双实例） | 精确 |
| 单实例承载 200 个 agent × 1 万用户的内存 | 稳态 0.55 GiB | — |
| 空闲常驻内存（1 vCPU / 920 MB VPS，含 agent） | 面板 5 MB、PostgreSQL 56 MB、Valkey 8 MB、Caddy 17 MB、agent 27 MB | — |
| agent：1 万用户 xray 重建 / 增删 1 个用户 | 57 ms / 5.4 µs | — |
| agent：每个被代理连接的准入判断（撤权闸门） | 249 ns | — |

**为什么快：架构上的取舍**

| 热路径 | Akari 的做法 | 传统 PHP + 拉取式面板的常见结构（用于对照，非实测） |
|---|---|---|
| 进程 | Rust 单静态二进制，mimalloc；内置 TLS 与 gRPC | PHP 运行时 + Web 服务器 + 队列 / 计划任务多个进程 |
| 节点同步 | agent 与面板之间一条**长连接**，面板只在有变化时推送；用户变化走**增量**（微秒级，不重建、不断线），只有结构变化才整体快照 | 节点按固定间隔**轮询**接口并拉取整份用户列表，节点越多、间隔越短，面板请求量越大 |
| 流量结算 | agent 上报累计值，面板按批量**单条 SQL** 完成对账与计费；5 万行约 0.5 秒；只发有变化的行 | 常见为逐节点、逐批次的应用层循环写库 |
| 变更传播 | 数据库同事务写库并 `NOTIFY`，所有面板实例即时唤醒受影响节点的会话，< 1 s | 等待节点下一个轮询周期 |
| 订阅 | 索引查找后在进程内渲染，p99 个位数到十几毫秒 | 每次请求走应用框架与 ORM |
| 横向扩展 | 多个面板实例共用 PostgreSQL + Valkey，会话与限速跨实例一致；节点在实例间切换不重复计费 | 通常依赖框架缓存与队列自行拼装 |
| 撤权 | 节点内的 gate 在分发层拦截，撤权**立即断开**该用户的活连接 | 通常等下一个同步周期 |

> 说明：Akari 一侧的数字都是本仓库实测，用的是上述数据集和一台开发机（共享同一台机器上的压测器、PostgreSQL 与 Valkey，所以延迟偏保守）。**我们没有对 V2Board / Xboard / SSPanel 做同机对比测试，不给出它们的数字**；右列只描述这类面板常见的架构特点，具体表现随项目版本与部署而异。

## 部署

在全新的 **Debian 12/13 或 Ubuntu 22.04/24.04**（amd64 / arm64，≥ 1 GB 内存）上，以 root 或有 sudo 的用户执行：

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
- **v0.3.x → v0.4 只能全新安装**（迁移已压缩为基线 `1000_baseline.sql`）；`akari-ctl upgrade` 会在改动任何东西之前拒绝。
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

## 目录树与功能映射

仓库结构（Cargo.toml 在仓库根）；逐文件说明见 [`src/CLAUDE.md`](src/CLAUDE.md)，不变量见 [`CLAUDE.md`](CLAUDE.md)。节点 agent 在兄弟仓库 [`akari-agent`](https://github.com/akari-projectX/akari-agent)，两个仓库需并排检出才能跑 `smoke.sh`。

```
akari-panel/
├── src/                   Rust 后端（crate akari_panel，全部模块在 lib.rs；main.rs = CLI 与启动）
├── proto/                 控制协议正本 agent.proto + 协议能力清单 protocols.toml
├── migrations/            sqlx 迁移（启动时自动执行；v0.4 基线 1000_baseline.sql）
├── portal/                用户门户（Svelte 5 + Vite + Tailwind 4 + bits-ui，Playwright e2e）
├── admin/                 管理后台（独立应用：登录页包 + 控制台包，中英双语）
├── deploy/                docker-compose、systemd 单元、Caddy / nginx、Prometheus 告警、Grafana 面板
├── scripts/               install.sh（= akari-ctl）、backup / restore、发布打包、e2e / 安装器测试
├── docs/                  DEPLOY（部署手册）· REFERENCE（功能与 API 参考）· BACKUP · PAYMENTS · PERF · FUZZING
├── bench/                 压测与基准工具（独立 crate，不进发布二进制）
├── fuzz/                  cargo-fuzz 目标（独立 crate）
├── testdata/              黄金文件（模板、凭据、订阅格式、校验信息）
├── smoke.sh               跨仓端到端验收（需 ../akari-agent）
├── Dockerfile             portal + admin → musl 静态二进制 → distroless 镜像
└── build.rs               编译 proto；缺前端产物时写占位页
```

**功能 → 代码**

| 功能 | 主要位置 |
|---|---|
| 前门、URL 布局、统一空 404 | `src/web.rs`、`src/access.rs`、`src/reject.rs` |
| 节点 agent 会话（快照 / 增量、租约、心跳） | `src/grpc.rs`、`src/state.rs`、`src/notify.rs`、`proto/agent.proto` |
| 节点注册、证书签发与续期、CA | `src/enroll.rs`、`src/install.rs`、`src/tlsserver.rs` |
| 服务器 / 节点 / 入口、中转与健康检查 | `src/servers.rs`、`src/nodes.rs`、`src/entrances.rs`、`src/entrance_health.rs`、`src/rates.rs` |
| 授权（套餐 → 节点组 → 入口 → 凭据） | `src/entitle.rs`、`src/plans.rs`、`src/enforce.rs` |
| 流量记账与流量明细 | `src/traffic.rs`、`src/trafficlog.rs`、`src/reaper.rs` |
| 协议矩阵（模型 / 校验 / 渲染） | `src/protocols/`、`src/nodetpl.rs` |
| 订阅（Clash / sing-box / 链接） | `src/sub/` |
| 订单、支付、优惠券、余额、返利、退款 | `src/billing/` |
| 登录、会话、通行密钥、防机器人 | `src/auth.rs`、`src/api.rs`、`src/passkey.rs`、`src/botguard.rs`、`src/login_limit.rs` |
| 注册、找回密码、邮件 | `src/signup/`、`src/mail/` |
| 工单、公告、知识库、站点品牌 | `src/tickets.rs`、`src/announcements.rs`、`src/kb.rs`、`src/branding.rs` |
| 告警、系统状态、指标 | `src/alerts/`、`src/sysstatus/`、`src/metrics.rs` |
| 审计、所有者、账号注销与清理 | `src/audit.rs`、`src/owner.rs`、`src/erase.rs`、`src/cleanup.rs` |
| 审计规则（节点拦截） | `src/blockrules.rs` |
| 节点一键安装与 agent 自更新 | `src/nodeinstall.rs`、`src/updates.rs`、`src/updatecheck.rs`、`src/rollout.rs` |
| 系统设置、域名、主密钥 | `src/settings.rs`、`src/masterkey.rs`、`src/config.rs` |
| 面板安装 / 升级 / 迁移 / 卸载 | `scripts/install.sh`（`akari-ctl`）、`deploy/` |

## 路线

权威计划在工作区的 `PLAN-next.md`（三仓库：`akari-panel` / `akari-agent` / `akari-client`）。

**已完成（v0.4.x）**：身份与登录（邮箱登录、通行密钥及跨域名 ROR、通行密钥注册 + 绑定邮箱）、域名与前门（多域名、后台前缀与白名单、订阅路径）、服务器 / 节点 / 入口拆分与中转、分时段倍率、服务器流量额度、审计规则、订阅格式与分流模板、系统状态与发信、Alpine（OpenRC）节点、新后台与新门户、订单 / 退款 / 返利 / USDT 提现。

**下一版本**：

- 性能与稳定性：agent 24 小时以上压测、面板压测与瓶颈分析、单节点容量数据（写入 `docs/PERF.md`）。
- 代码质量：全仓审计（计费漏洞、重复与无用代码），工程规范文档，并把重复代码 / 未用依赖检测放进 CI。
- 红队测试：后台前缀与订阅令牌探测、认证、支付回调与资金逻辑、节点 mTLS 与注册、中转隔离、安装脚本供应链。
- 运营：发信与支付宝沙箱实测、主流图形客户端的导入实测、更多支付渠道（按插件方式）、门户动效打磨。

**暂缓 / 不做**：

- 自研客户端 `akari-client`（mihomo 作为子进程）与**设备数限制**（席位绑定制，随客户端做；刻意不基于 IP）。
- sing-box 第二内核。
- 提现方式扩展与自动打款（目前只支持 USDT，人工打款）。
- 兼容 V2Board / XrayR 节点协议（刻意不做）。

## 文档索引与许可

| 文档 | 内容 |
|---|---|
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | 部署、升级、回滚、卸载、迁移、协议矩阵、节点与告警、发布校验 |
| [`docs/REFERENCE.md`](docs/REFERENCE.md) | 功能与实现参考：行为说明、API 表、设计笔记（原 README） |
| [`docs/BACKUP.md`](docs/BACKUP.md) | 备份与恢复 |
| [`docs/PAYMENTS.md`](docs/PAYMENTS.md) | 支付渠道、套餐目录规则、优惠券 / 余额 / 返利 |
| [`docs/PERF.md`](docs/PERF.md) · [`docs/FUZZING.md`](docs/FUZZING.md) | 性能数字与复现、模糊测试 |
| [`CLAUDE.md`](CLAUDE.md) · [`src/CLAUDE.md`](src/CLAUDE.md) | 开发者须知：硬性不变量、模块地图 |

面板采用 MIT 许可（[`LICENSE`](LICENSE)）。`akari` 二进制静态链接的依赖在 CI 中由 `cargo deny` 检查（只允许宽松许可证），许可证清单作为 `THIRD_PARTY_LICENSES.txt` 随每个发布版本发布。
节点 agent 是独立程序，自有源码为 MIT，但其发布的二进制是 GPL-3.0-or-later 的组合作品（xray-core 链接了 GPL 模块），见 akari-agent 的 README「Licence」。面板只负责中继 agent 二进制，不会链接它们。
