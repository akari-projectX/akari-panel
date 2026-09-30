# akari-panel

Rust 单二进制 `akari`（axum 0.8 web + tonic 0.14 gRPC）+ PostgreSQL 18（事实源）+ Valkey 9（热状态）+ 内嵌 React SPA。
Cargo.toml 在仓库根（文档里的 `panel/` 前缀是拆仓前的旧路径，已不存在）。

## 目录

| 路径 | 内容 | 子文档 |
|---|---|---|
| `src/` | 全部 Rust 代码 | `src/CLAUDE.md` |
| `spa/` | React 19 + Vite 8 + Tailwind 4 前端 | `spa/CLAUDE.md` |
| `migrations/` | sqlx 迁移（启动时自动执行） | `migrations/CLAUDE.md` |
| `proto/` | **控制协议正本** `agent.proto` | `proto/CLAUDE.md` |
| `build.rs` | protox 编译 proto；缺 `spa/dist` 时写占位 index.html | — |
| `smoke.sh` | 跨仓端到端验收（需 `../akari-agent`） | — |
| `data/` | 运行时生成：route prefix、CA、jwt.key（gitignored，机密） | — |

## 命令

```bash
make dev-up        # docker compose: PG 5432 / Valkey 6379（仅 127.0.0.1）
make spa           # npm install + tsc + vite build → spa/dist
make panel         # cargo build --release（嵌入当前 spa/dist）
make check         # cargo fmt --check + clippy -D warnings + tsc
make smoke         # 全量构建 + smoke.sh（会 TRUNCATE PG、flushall Valkey、删 data/）
./target/release/akari info    # 查看 route prefix
```

## 硬性不变量

- **拒绝同构**：任何"拒绝"（`/`、错前缀、裸前缀、未匹配路由、错误方法、坏 token、缺资源）都必须返回 `reject::not_found()`：404、空 body、不带安全头，除 `Date` 外字节同构（smoke 断言）；订阅失败绝不带 quota 头。没有伪装站。
- **PostgreSQL ≥ 18**：计费依赖 `RETURNING old/new`；`db::migrate` 启动时校验版本。
- **路由**：所有路由带 `/{prefix}` 参数，`Path` 提取器用 `(String, ...)` 元组吃掉前缀；axum 路由匹配先于中间件，不要改成"中间件剥前缀"。
- **收敛**：面板是唯一事实源。改变节点/用户期望状态的操作都是 `apply_*(&mut PgConnection, …)`：写库 + bump 受影响节点的 `config_version`/`user_version` 在**同一事务**；handler 提交后才 `state.notify_change()`。全局加锁顺序：nodes（`ORDER BY id FOR UPDATE`）→ users → node_users。`api::tests::every_access_change_bumps_affected_nodes` 是这条规则的表驱动测试，新增 mutator 必须加进去。
- **禁用即停用**：禁用节点的期望状态 = 无 inbound、无用户（不拒绝连接）；启用/禁用都 bump `config_version`。用户期望集 = `enforce::SERVED`：role=user、enabled、未过期（DB 时钟）。**管理员账户不是代理用户**：不下发到节点、订阅返回拒绝、不能被分配（400）、不受流量上限禁用；user→admin 会移除其节点访问，admin→user 恢复。每个会话另有 60s 对账 tick。
- **agent 先于面板升级**：面板丢弃不带 `session_id` 的流量上报，并依赖 agent 失败时不前移持有版本。`Hello.protocol_version < MIN_AGENT_PROTOCOL`（旧 agent = 0）的节点被下发空状态并在 `last_error`/`agent_protocol` 标出——这是有意的降级模式，不是 bug。
- **下发**：只有用户集变化（config_version 不变、节点启用、本会话已验证 agent 所跑用户集）才发 `UserDelta`，其余一律 Snapshot（重建 xray = 断开全部连接）。agent 与面板的 state hash 必须按 proto 定义一致，改动时同步更新 `proto/state_hash_vectors.json`。
- **失联租约**：面板只在成功读到期望状态后发 `LeaseGrant`；DB 不可用时不续约（R8 产品决定）。
- **身份**：agent 身份 = mTLS 客户端证书序列号；xray `email` = 面板 user UUID。
- 验收门：`make check` 与 `make smoke` 全绿；新 API 必须在 smoke.sh 加断言。

## 已知问题

完整清单见 `../REVIEW-2026-09-30.md`，排期在 `PLAN.md` Phase 0.5。改相关代码前先看。
