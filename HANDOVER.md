# Akari 交接文档（面向接手者）

> 更新：2026-09-30。**接手审查见工作区根 `REVIEW-2026-09-30.md`（含 P0 缺陷清单，排期 PLAN.md Phase 0.5）。** 配套：`PLAN.md`（三仓库终态与阶段计划）、`README.md`（架构图/API 表/设计说明）。
> 战略框架（已确认，勿推翻）：**三仓库** = ① akari-panel（Rust 后端 + 前端两端）② akari-agent（内嵌 xray-core）③ akari-client（自研内嵌 mihomo 客户端）；**现有订阅接口是过渡期产物**（终态仅保留 Clash 格式给自研客户端）；**设备限制 = 席位绑定制，随自研客户端实现，现在不做**。

---

## 1. 工作目录说明（三仓库，已完成拆分 ✅ 2026-09-30）

工作区 `/home/lam/projectX/` 下三个**独立 git 仓库**（兄弟检出约定：必须放在同一父目录，面板的 smoke 与 agent 的契约同步依赖 `../akari-agent` 相对路径）：

| 目录 | 仓库 | 内容 |
|---|---|---|
| `akari-panel/` | 控制面板 | Rust 后端（Cargo.toml 在仓库根）+ `spa/` 前端 + `migrations/` + **契约正本 `proto/agent.proto`** + `docker-compose.yml` + `smoke.sh`（跨仓集成验收）+ Makefile + 文档 |
| `akari-agent/` | 节点 agent | Go + `pb/`（生成物已提交）+ vendor 契约副本 `proto/agent.proto`（buf 模块根在 proto/，生成物落 pb/ 根以匹配 import 路径） |
| `akari-client/` | 自研客户端 | 仅脚手架（README + 计划引用），Phase 2 开工 |

契约流转：正本在 panel；agent 侧 `make sync-proto`（拷贝+重新生成 pb）与 `make check-proto`（漂移校验）。smoke.sh 归 panel 仓（面板是集成方），运行时构建并调用兄弟目录的 agent 二进制。

注：dist 已 gitignore，panel `build.rs` 在缺目录时自动生成占位 index.html，fresh clone 可直接 `cargo build`。

## 2. 进度总览

| 里程碑 | 状态 |
|---|---|
| 控制面链路：注册→mTLS→快照→动态加用户→心跳→在线 | ✅ |
| REST API + 认证（argon2id / JWT Cookie / 登录限速 / 前缀门禁） | ✅ |
| React SPA 内置（管理台 + 用户门户） | ✅ |
| 订阅接口（**过渡期**：base64 / sing-box / clash 三格式） | ✅（过渡） |
| 席位绑定制 + 自研客户端（akari-client） | ⬜ 见 PLAN.md Phase 2/3 |
| agent CSR 注册 + 签名自动更新 | ⬜ |
| 支付/订单/工单/邀请 | ⬜ |

验收：`make smoke` 全绿（~30 项断言）。

## 3. 已完成工作明细

### akari-panel（panel/src/）
| 文件 | 职责 | 接手要点 |
|---|---|---|
| `main.rs` | CLI（serve/info/admin add/node）+ 启动装配；最先安装 rustls ring provider | 改依赖前先看 §8 |
| `config.rs` | panel.toml + 环境变量覆盖；gRPC advertise 必须显式 IP | — |
| `install.rs` | 安装态：随机前缀(24hex)、内部 CA、agent 证书、JWT 密钥(0600) | 证书 SAN 来自 web.advertised_names |
| `state.rs` | AppState：pg/valkey/agents(gen 注册表)/watch 变更通道/流量缓冲 | `notify_change()` 是推送入口 |
| `grpc.rs` | AgentChannel gRPC：证书序列号→节点身份；版本比对→全量快照；Hello/心跳/流量/Ack 处理；代数防重连竞态 | 契约改了先改 proto/agent.proto |
| `traffic.rs` | 累计值差值记账；session_id 变化重置基线；5s 批量落库；超限禁用→bump 版本→notify | 计费粒度 5s |
| `auth.rs` | argon2id + 等时烧录；JWT(HS256,12h,HttpOnly,SameSite=Strict)；AuthUser 提取器每请求回查 DB | cookie 名 `sid`；Secure 回环自动关 |
| `api.rs` | REST handlers；账号生成（vless uuid/vmess id/trojan 32B 密码）；动态 SET 手工逗号 | Path 全是 `(String, Uuid)` 元组 |
| `sub.rs` | 订阅（**过渡期**）：UA 分流三格式；streamSettings→TLS/REALITY/WS 映射；userinfo 头；≥8KiB 填充；token 只存 SHA-256 | 终态退役计划见 PLAN.md Phase 3 |
| `spa.rs` | rust-embed 服务 dist；`/assets/` 运行时重写到前缀；缺失→伪装 404 | 只服务 dist，源码树不可达 |
| `web.rs` | 路由全部带 `/{prefix}` 参数 + 门禁中间件（常数时间校验） | axum 路由先于中间件，勿改剥前缀方案 |
| `decoy.rs` + `decoy.html` | 伪装站；200 与 404 字节同构 | 所有"拒绝"必须落在这里 |
| `nodeops.rs` | node add/list、admin add CLI | bootstrap 文件**含 agent 私钥**（v1，Phase 4 改 CSR） |

### akari-agent（agent/）
| 文件 | 职责 |
|---|---|
| `agent.go` | 会话生命周期、指数退避重连（>1min 重置）、Hello/Ack |
| `core.go` | xray-core 嵌入：完整 config（policy 开 per-user 统计）→`DecodeJSONConfig→Build→core.New`；动态用户 `GetHandler→GetInbound()→AddUser/RemoveUser(*protocol.MemoryUser)`；`user>>>email>>>traffic>>>*` 计数查询 |
| `monitor.go` | 心跳 15s（gopsutil cpu/mem）、流量 10s（累计值） |
| `config.go` | bootstrap.toml 解析（panel_addr/server_name/身份三件套 PEM） |
| `pb/` | buf 生成（`make proto`） |

### 前端（panel/spa/）
- 技术栈：React 19.3 / Vite 8.3(Rolldown) / Tailwind 4.3 / shadcn 风格手拷组件（button/input/card/table/badge/label）/ TanStack Query 5 / 手写 history 路由（`lib/router.ts`，零路由依赖）
- 页面：`login`、`admin-users`（建户+sub token 展示/重发+启停删除）、`admin-nodes`（状态/版本表、server_addr、inbounds JSON 编辑推送、账号签发）、`portal`（用量进度）
- API 前缀自位置推导（`lib/api.ts` 的 appBase/apiBase），**不内嵌任何前缀知识**

## 4. 数据模型（migrations/）

- `nodes`：id/name/enabled/status/xray_inbounds(JSONB)/config_version/user_version/cert_serial(UNIQUE)/server_addr/agent_version/core_version/last_seen_at
- `users`：id/login(UNIQUE)/password_hash/role/enabled/traffic_limit_bytes/traffic_used_bytes/expires_at/sub_token_hash(UNIQUE)
- `node_users`：(node_id,user_id) 主键，credentials JSONB=`[{inbound_tag,protocol,account}]`
- `traffic_counters`：(node_id,user_id,session_id) 主键，累计值；面板做差值

## 5. API 速查（全部在 `/{prefix}` 下）

```
POST /auth/login | /auth/logout          argon2id 登录 → HttpOnly cookie `sid`
GET  /api/v1/me                          当前用户 + 用量
GET/POST /api/v1/users                   admin：列表/建户（响应含一次性 sub_token）
PATCH/DELETE /api/v1/users/{id}          admin：更新/删除（启停→bump 节点版本→推送）
POST /api/v1/users/{id}/sub-token        admin：重发订阅 token
POST/DELETE /api/v1/users/{id}/nodes/{node_id}  admin：分配（生成账号）/解绑
GET  /api/v1/nodes                       admin：节点列表（含 inbounds/server_addr）
PATCH /api/v1/nodes/{id}                 admin：启停/改名/server_addr
PUT  /api/v1/nodes/{id}/inbounds         admin：整体替换 inbounds（config_version+1）
GET  /sub/{token}                        订阅（UA 分流；token 即凭据；userinfo 头）
GET  /app, /assets/*, /healthz           SPA / 静态资源 / 存活
```

## 6. 构建与运行

```bash
make dev-up spa panel agent     # 全量构建
make smoke                      # 验收（TRUNCATE PG + flushall Valkey，仅限开发）
make proto                      # 改 proto 后生成 Go 绑定
make check                      # clippy -D warnings + tsc + go vet/gofmt
```
运行顺序：`akari serve` → `AKARI_ADMIN_PASSWORD=… akari admin add root` → `akari node add test-node` → agent `-config bootstrap` → 浏览器 `/{prefix}/app`。默认 `127.0.0.1:8080`(web) / `:8443`(gRPC)。

## 7. 踩坑记录（改代码前必读）

### 依赖版本
- **tonic 0.14**：TLS feature=`tls-ring`；代码生成在 `tonic-prost-build`；gRPC 方法禁名 `Connect`（与客户端便捷构造撞名，现名 `OpenChannel`）
- **jsonwebtoken 11**：必须启用 `rust_crypto`（或 `aws_lc_rs`）feature，否则签发 panic
- **rustls**：依赖树双 provider（ring+aws-lc-rs），`main()` 顶部强制安装 ring
- **argon2 0.6**：`hash_password` 自动加盐；`PasswordHash` 在 `phc` 模块
- **sqlx 0.9**：`push_set_separator` 已删；`Separated` 把片段/bind 拆开插逗号 → 动态 SET 手工管理（api.rs 两处带 allow 注释）
- **PG 18 镜像**：挂载 `/var/lib/postgresql`（非 `.../data`）
- **xray-core CalVer**：release v26.3.27 = module v1.260327.0；更新 tag 均为 prerelease 勿盲升；升级必须重跑 agent 构建 + smoke
- **xray 动态用户 API**：`features/inbound.Handler` 无 AddUser；链路=断言 `GetInbound()`→协议自带 AddUser/RemoveUser；trojan 合并在 `proxy/trojan`（无 inbound 子包）；app 侧必须 blank-import dispatcher/dns/policy/proxyman(in/outbound)/router/stats
- **许可**：mihomo=MIT（v1.19.31，可闭源内嵌，保留版权声明）；xray-core=MPL-2.0（保留声明；对 xray 源文件的修改须开源）

### axum 0.8 语义
- `Router::layer` 在每个路由+fallback 外层，但**路由匹配最先发生**——中间件剥前缀再路由行不通；路由全带 `/{prefix}` 参数，`Path` 提取器统一 `(String, Uuid)` 元组模式，新增路由照抄

### 本机/运维
- WSL 环境有 HTTP_PROXY：curl 本地必须 `--noproxy '*'`
- `pkill -f` 会自杀（命令行含同名字样）；单独一条命令 + `[o]nyx` 括号技巧
- gRPC advertise 写显式 IP（localhost 可能解析 ::1）
- `data/` 含 CA 私钥 + jwt.key（0600）：**需备份**；jwt.key 泄露=会话可伪造
- 生产需反代 TLS + 打开 Cookie Secure（现回环自动关）；登录限速键在 Valkey（smoke 会 flushall）

### 测试现状
- `make smoke` 是唯一验收门 + clippy `-D warnings` 同级要求；改动必须全绿
- **UI 未做真实浏览器渲染验证**（本环境无浏览器后端）——人工打开 `/{prefix}/app` 核对
- 未压测；未做多面板实例（Valkey 会话已无状态化，PG 迁移策略未做）

## 8. 设计决策（为什么）

- 全量快照而非增量：面板唯一事实源+单调版本号，任意状态（含面板回滚）可收敛，无 diff 协议边角态
- xray `email` 字段 = 面板用户 UUID：统计键即身份，零映射
- agent 只出不进：节点零管理端口
- token/证书序列号只存哈希或单向引用：拖库≠失守
- 不兼容 V2Board/XrayR 协议：**需求，不是缺陷**
- 订阅三格式是过渡期兼容层：终态仅 Clash 格式服务自研客户端（退役执行点在 PLAN.md Phase 3，含 1–2 个月公告期）
- 设备限制为席位绑定制：信任锚在自研客户端；IP 制误伤 NAT 且可绕过；时机=随客户端，现在不做
