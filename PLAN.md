# Akari 开发计划（终态：三仓库）

> 配套文档：`HANDOVER.md`（现状交接与踩坑）、`README.md`（架构与 API）。
> 本计划 2026-09-30 制定，反映三个已确认的战略决策：
>
> 1. **三仓库结构**：控制面板 / agent(内嵌 xray-core) / 自研客户端(内嵌 mihomo)
> 2. **订阅接口是过渡期产物**：自研客户端成熟后，移除面向第三方软件的订阅格式（base64 链接 / sing-box JSON / 通用 Clash），仅保留自研客户端的 Clash 格式接口
> 3. **设备限制 = 客户端席位绑定制**（不是 IP 限制），依赖自研客户端实现，**当前阶段不做**任何设备限制

---

## 一、终态架构

```
┌────────────── 仓库 1: akari-panel ──────────────┐
│ Rust 后端（单二进制） + 前端两端                   │
│  · 控制面 gRPC（agent 接入，mTLS）                │
│  · REST API（管理端 + 用户端 + 客户端注册）        │
│  · 订阅端点（过渡期三格式 → 终态仅 Clash 给自研端） │
│  · PostgreSQL（事实源） + Valkey（热状态）         │
│  · 前端：管理控制台 + 用户门户（React 内嵌）        │
└──────────────┬──────────────────────────────────┘
               │ mTLS gRPC（纯出站）
┌──────────────┴──────────────────────────────────┐
│ 仓库 2: akari-agent（Go，每节点一个）               │
│  · 内嵌 xray-core（MPL-2.0）                      │
│  · 动态用户 / 配置热更 / 流量统计 / 心跳            │
└─────────────────────────────────────────────────┘

┌────────────── 仓库 3: akari-client ──────────────┐
│ 自研代理客户端（Go，用户设备上运行）                │
│  · 内嵌 mihomo 内核（MIT）                        │
│  · 从面板拉取 Clash 配置 + 席位绑定注册             │
│  · 本地代理端口 / 系统代理 / TUN（后期）            │
│  · 桌面优先（Win/mac/Linux），移动端后置            │
└─────────────────────────────────────────────────┘
```

### 仓库边界与契约依赖

| 仓库 | 内容 | 依赖的契约 |
|---|---|---|
| `akari-panel` | Rust 后端 `src/`、前端 `spa/`、数据库迁移、proto 定义、smoke.sh | 无（契约的所有者） |
| `akari-agent` | Go agent（仓库根，含生成的 `pb/`） | 控制面 proto（AgentChannel） |
| `akari-client` | Go 客户端（mihomo 内嵌） | 订阅端点 URL 约定 → 终态 client API |

**契约共享策略**（Phase 0 决策并落地）：
- `proto/agent.proto` 的所有者是 akari-panel；akari-agent 持有 **vendor 副本**（`make sync-proto` / `make check-proto`；git submodule 方案已否决，见 Phase 0）。改契约必须先改 panel 仓库再同步 agent
- 面板↔客户端之间没有 proto：客户端走 REST（注册/拉配置），配置本身是 Clash YAML
- 三仓库各自 CI（GitHub Actions `.github/workflows/ci.yml`，Sprint 4a）：panel = fmt/clippy/test（PG+Valkey 服务）/spa/cargo-deny/smoke；agent = gofmt/vet/test(-race+canary)/build/govulncheck/check-proto；client = 待建

---

## 二、阶段计划

### ~~Phase 0：仓库拆分~~ ✅ 完成（2026-09-30）
- 三仓已建立：`akari-panel/`（含 proto 正本、spa、docker-compose、smoke、文档）、`akari-agent/`（vendor 契约副本 + `sync-proto`/`check-proto`）、`akari-client/`（README 脚手架）
- 契约共享落地方式从 submodule 修正为 **vendor 副本 + 同步/漂移校验**：git submodule 只能指向仓库根而非子目录，vendor+校验对三仓结构更简单可靠
- ~~CI workflow 已建~~ **更正（2026-09-30 接手审查）**：三仓均无 `.github/workflows`，移入 Phase 0.5
- **更正**：接手时 smoke 实际为红（agent `pb/` 仍是改名前的 `onyx.v1` 绑定 → gRPC Unimplemented）；已修复 buf 生成路径，2026-09-30 smoke 首次全绿
- **更正**：akari-panel / akari-agent 的 `.git` 丢失，已重新 `git init`，待首次提交

### Phase 0.5：接手质量基线（1–1.5 周，阻塞 Phase 1/2）
> 详细依据与行号见工作区根 `REVIEW-2026-09-30.md`。每项修复需配套 smoke 断言或单元测试。

**P0（本阶段必须完成）**
1. SPA 登录/登出路径错误（`/api/v1/auth/*` → `/auth/*`），smoke 增加"按 SPA 实际拼接路径"的断言，并人工在浏览器走通一遍
2. 流量基线持久化：会话首次出现 (node,user,session) 时，从 `traffic_counters` 恢复基线；drain 改为在事务提交后再清零
3. 状态变更统一顺序"写库 → bump → notify"（`delete_user` 先删后 bump，放进同一事务）
4. 禁用节点：关闭该节点的流，并拒绝重连（或下发空快照）
5. `expires_at` 到期执行：快照 SQL 过滤、登录拒绝、到期扫描时 bump 版本（从 Phase 1 提前）
6. 用户增删改走 `UserDelta`（面板计算差集），只有 inbound 变更才发 Snapshot；agent 重建后重发 Hello（新 session_id）；agent 在 Rebuild 前先上报一次流量

**P1**
7. PATCH 语义：空更新返回 400；可清空字段改用 `Option<Option<T>>`（`serde_with::double_option`）
8. `assign_user`：校验协议与 inbound 一致、user 不存在返回 404、放进事务并 `SELECT … FOR UPDATE`
9. `set_inbounds` 同步清理孤儿凭据；agent 回 `ok=false` 时面板不视为已收敛，并暴露到节点状态
10. 反代部署支持：`web.trusted_proxies` + `X-Forwarded-For`；`web.cookie_secure` 显式配置；只统计失败的登录
11. 处理 SIGTERM，退出前做一次最终流量 flush
12. 会话清理按代数判断后再写 offline；最后一个管理员保护；改密码/登出吊销会话（jwt 加 `pwd_ver` 或 Valkey 黑名单）

**工程**
13. ✅ CI（Sprint 4a）：panel（fmt/clippy/test/tsc/build）、agent（gofmt/vet/build/check-proto，其中 check-proto 需检出 panel）；smoke 作为可手动触发的 workflow
14. 单元测试起步：traffic 差值、sub 渲染（三格式快照测试）、prefix gate、PATCH 构造
15. ✅ 文档去漂移（Sprint 4a）：README/HANDOVER 的 `panel/`、`agent/` 旧路径，决策表中的 submodule
- **验收**：`make check` 通过、`cargo test` 通过、smoke 全绿且覆盖 P0 各项；浏览器人工验收登录与管理全流程

### Phase 1：面板过渡期补强（与 Phase 2 并行，1–2 周）
- **套餐/节点组授权模型**（新增，接手审查建议）：`plans`（流量、周期、节点组）、`node_groups`、按周期重置流量；取代"逐个把用户分配到节点"。它是 Phase 5 订单/续费的前置
- ~~`expires_at` 到期强制执行~~ → 已提前到 Phase 0.5
- 管理操作审计日志（谁改了什么）
- 用户自助 API：改密码、查看自己的订阅 URL/席位占用
- 前端两端拆分评估：当前单 SPA 双角色视图；若决定物理拆两个入口（管理台/用户门户独立 bundle），在本阶段定案（默认维持单应用，理由：共享登录与组件，体积可接受）
- **验收**：smoke 扩展覆盖新 API；存量行为无回归

### Phase 2：akari-client MVP（4–6 周，主线）
- **技术 spike（1 周内出结论）**：mihomo 内嵌方式二选一——
  - a) 库内嵌：`import github.com/metacubex/mihomo`，参考其 `hub/execute` 与 config 解析，进程内启停内核（推荐：可控性强、单二进制）
  - b) 子进程 + external controller：隔离性好但分发两文件
- MVP 功能集：设备注册（连 Phase 3 的 API，先占位）→ 拉取订阅（Clash 格式）→ 内核生命周期管理 → 本地 mixed 端口（7890）→ 系统代理开关 → 延迟测试 → 基础托盘 UI
- 非目标（明确不做）：规则编辑、订阅聚合、TUN 模式（放二期）
- 平台顺序：Windows → macOS → Linux（打包：nsis/pkg/AppImage）
- **验收**：干净设备上 5 分钟内完成 安装→登录→绑定→可用代理；断网重连自愈；内核崩溃自动拉起
- **风险**：mihomo 内嵌 API 非公开稳定契约（MIT 但不承诺库稳定性），spike 必须 pin 版本 + 锁定集成面

### Phase 3：席位绑定制（2–3 周，依赖 Phase 2 API 落点）
- 数据模型：`devices` 表（user_id、device_id=硬件指纹哈希、名称、绑定时间、最近在线、revoked_at）；users 增加 `seat_limit`
- 客户端 API（新 `/client/v1/*` 命名空间，与订阅前缀同门禁策略）：注册/心跳/解绑；超席位注册返回明确错误
- 管理端：用户详情显示设备列表、踢出/解绑；用户门户显示席位占用
- **订阅退役执行点**（本阶段末）：
  1. 下线 `base64 链接` 与 `sing-box JSON` 格式
  2. Clash 格式仅对**已绑定设备**下发（订阅 token + 设备绑定双重校验），并给第三方客户端一个迁移周期的明确失效（1–2 个月公告期）
  3. README/API 文档同步标注 breaking change
- **验收**：席位满后新设备被拒；解绑后可立即换绑；第三方客户端按公告期失效

### Phase 4：agent 加固（2 周，可与 Phase 3 并行）
- CSR 注册：私钥在 agent 首次启动生成，只上交 CSR + 一次性 enrollment token（替换现 bootstrap 内嵌私钥）
- 签名自动更新：agent 二进制面板签名分发、客户端校验后自替换
- **验收**：bootstrap 文件不再含私钥；升级通道可灰度（按节点百分比）

### Phase 5：商业化（4–6 周）
- 套餐/订单/支付（stripe-rs；易支付自研签名回调）、优惠券、邀请佣金
- 工单与邮件通知
- **验收**：完整购买→使用→续费闭环；对账脚本

### 后置池（无排期）
- TUN 模式、客户端移动端（Android 优先）
- 面板指标导出（Prometheus）、备份/容灾文档
- 多面板实例（Valkey 会话已在，主要补 PG 迁移策略）

---

## 三、关键决策记录

| 决策 | 结论 | 原因 |
|---|---|---|
| 订阅格式终态 | 仅 Clash（给自研客户端） | 自研客户端就位后第三方兼容无价值，且第三方客户端无法实现席位绑定，是安全面收窄的自然结果 |
| 设备限制 | 席位绑定（客户端注册制），非 IP 制 | IP 制误伤（NAT/移动网络）且可绕过；席位绑定把信任锚放在自研客户端 |
| 设备限制时机 | 随自研客户端做，现在不做 | 没有自有客户端时任何限制都是对第三方友好的空谈 |
| 客户端内核 | mihomo（MIT, v1.19.31） | MIT 允许闭源内嵌（保留版权声明）；xray-core 为 MPL-2.0，agent 侧继续用它（保留声明 + 对其源码的修改需开源） |
| proto 归属 | akari-panel 所有，agent 持有 vendor 副本（`sync-proto`/`check-proto`） | 契约随事实源走；submodule 无法指向子目录 |
| 用户变更下发（2026-09-30） | 用户集变更走 UserDelta，inbound 变更才发 Snapshot | 全量重建会断开节点上所有连接并丢流量；快照仍作为兜底收敛手段 |
| 前端形态 | 单 SPA 双角色视图（默认），拆分留决策点 | 共享登录/组件/嵌入管线；有真实痛点再拆 |
