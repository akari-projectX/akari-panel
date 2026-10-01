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
| `Dockerfile` | 多阶段：spa → musl 静态二进制 → distroless nonroot 镜像（target `artifact`/`prebuilt`/`runtime`） | — |
| `deploy/` | systemd 单元、生产 compose、Caddy/nginx、Prometheus 告警、Grafana 面板 | `docs/DEPLOY.md` |
| `scripts/` | `backup.sh`/`restore.sh`（age 加密）、`restore-drill.sh`（开发栈恢复演练） | `docs/BACKUP.md` |
| `.github/workflows/` | `ci.yml`（含 docker build）、`release.yml`（tag `v*`：构建、SBOM、cosign 无密钥签名、GitHub Release、ghcr 镜像） | — |
| `data/` | 运行时生成：route prefix、CA、jwt.key、totp.key（gitignored，机密；totp.key 丢失 = 所有 2FA 账户需 `admin reset-2fa`） | — |

## 命令

```bash
make dev-up        # docker compose: PG 5432 / Valkey 6379（仅 127.0.0.1）
make spa           # npm install + tsc + vite build → spa/dist
make panel         # cargo build --release（嵌入当前 spa/dist）
make check         # cargo fmt --check + clippy -D warnings + tsc
make smoke         # 全量构建 + smoke.sh（会 TRUNCATE PG、flushall Valkey、删 data/）
./target/release/akari info    # 查看 route prefix
./target/release/akari config check   # 校验并打印生效配置（凭据已打码）
./target/release/akari --version      # 版本 + git sha（build.rs，Docker 构建用 AKARI_GIT_SHA）
```

## 硬性不变量

- **拒绝同构**：任何"拒绝"（`/`、错前缀、裸前缀、未匹配路由、错误方法、坏 token、缺资源）都必须返回 `reject::not_found()`：404、空 body、不带安全头，除 `Date` 外字节同构（smoke 断言）；订阅失败绝不带 quota 头。没有伪装站。
- **PostgreSQL ≥ 18**：计费依赖 `RETURNING old/new`；`db::migrate` 启动时校验版本。
- **路由**：所有路由带 `/{prefix}` 参数，`Path` 提取器用 `(String, ...)` 元组吃掉前缀；axum 路由匹配先于中间件，不要改成"中间件剥前缀"。
- **收敛**：面板是唯一事实源。改变节点/用户期望状态的操作都是 `apply_*(&mut PgConnection, …)`：写库 + bump 受影响节点的 `config_version`/`user_version` 在**同一事务**；版本变化由 `nodes` 上的触发器（0007）在同一事务内 `pg_notify('akari_change', <node id>)`，提交后投递到所有面板实例（没有进程内通知路径，handler 提交后什么都不用做）。全局加锁顺序：nodes（`ORDER BY id FOR UPDATE`）→ users → node_users。`api::tests::every_access_change_bumps_affected_nodes` 是这条规则的表驱动测试，新增 mutator 必须加进去。
- **禁用即停用**：禁用节点的期望状态 = 无 inbound、无用户（不拒绝连接）；启用/禁用都 bump `config_version`。用户期望集 = `enforce::SERVED`：role=user、enabled、未过期（DB 时钟）。**管理员账户不是代理用户**：不下发到节点、订阅返回拒绝、不能被分配（400）、不受流量上限禁用；user→admin 会移除其节点访问，admin→user 恢复。每个会话另有 60s 对账 tick。
- **agent 先于面板升级**：面板丢弃不带 `session_id` 的流量上报，并依赖 agent 失败时不前移持有版本。`Hello.protocol_version < MIN_AGENT_PROTOCOL`（旧 agent = 0）的节点被下发空状态并在 `last_error`/`agent_protocol` 标出——这是有意的降级模式，不是 bug。
- **下发**：只有用户集变化（config_version 不变、节点启用、本会话已验证 agent 所跑用户集）才发 `UserDelta`，其余一律 Snapshot（重建 xray = 断开全部连接）。agent 与面板的 state hash 必须按 proto 定义一致，改动时同步更新 `proto/state_hash_vectors.json`。
- **取消分配的尾部计费**：删 node_users 行（用户仍在）必须同事务写 `node_users_departed`，否则 agent 在 REMOVE 之后上报的最终计数被丢。
- **失联租约**：面板只在成功读到期望状态后发 `LeaseGrant`；DB 不可用时不续约（R8 产品决定）。
- **身份**：agent 身份 = mTLS 客户端证书序列号（`install::normalize_serial`：小写 hex、去前导零字节，签发/识别/墓碑共用）；xray `email` = 面板 user UUID。
- **删除节点两阶段**：阶段 1（API/CLI）置 `deleting_at` + 禁用 + bump（agent 收敛到空状态，最终计数照常计费）；阶段 2（`reaper`，任意实例）在 ack+10s / 2min 超时 / 节点离线时写 `revoked_certs` 墓碑并删行。已吊销证书**接受连接**、推空状态后关闭（拒绝会让 agent 留着旧配置），永不计费。删除只从 DB 推导，`del:` 通知仅是提示。
- **多实例**：LISTEN 需要直连 PG，不支持 PgBouncer 事务/语句池模式。
- **会话吊销（S4-2）**：JWT 带 `sv` = `users.session_ver`，`AuthUser` 不一致即 401。改密码/禁用/改角色/过期执行由 0009 的 `users` 触发器自动 bump（任何路径，包括 CLI 与手写 SQL）；登出、`revoke-sessions` 显式 bump。**最后一个启用的管理员**不能被禁用/降级/删除：0009 触发器在 advisory xact lock 下检查，SQLSTATE `AK001` → 409（仅在 READ COMMITTED 下无竞争，应用事务全是 RC）。
- **反代（S4-1）**：客户端地址只在 TCP 对端属于 `web.trusted_proxies` 时才取 X-Forwarded-For（最右侧非受信跳）；登录限速只计失败，按地址（IPv6 按 /64）和按登录名，Valkey Lua 原子预留。`web.cookie_secure` 默认 true。
- **GO-2026-6443**：agent 的 grpc-go < 1.85 遇缺 :authority 的请求会 panic，`streamSettings.network` = grpc/gun 的 inbound 一律 400；已存的在 NodeView `warnings` 中提示。agent 升级 grpc ≥ 1.85.0 后可解除。
- **可观测性（M1-4）**：Prometheus 指标只在独立监听 `metrics.bind`（默认关闭；非回环须 `allow_non_loopback`；不得与 web/grpc 同端口），**永不**挂在公网 web 端口。标签只用路由模板（`/{prefix}/...`）与有限枚举，不得出现前缀或 id。`X-Request-Id` 只加在通过前缀闸门的响应上（`request_id.rs` 在闸门之内；带 `Rejected` 标记的响应不加），拒绝响应必须保持字节同构；URI 不进日志（可能含订阅 token）。
- **启动校验（M1-3）**：`config.rs` 结构体 `deny_unknown_fields`；`config_check.rs` 的 `validate()`（纯函数）+ `check_data_dir`，`serve` 与 `config check` 共用；错误一次列全，警告不阻止启动。
- **管理员双因素（M1-6）**：JWT 带必需 claim `st`（`full`/`enroll`）。`AuthUser` 只收 `full`，且 role=admin 时还要求 `user_totp` 有已启用行；无 2FA 的管理员密码登录只得 15 分钟 `enroll` 会话，仅 `SessionUser`（`/me/totp*` 三个端点）接受。登录 = 同一个 POST 带 `code`（TOTP 或恢复码），所有凭据失败统一 401、同样工作量（一条查询带出 TOTP 与未用恢复码哈希、一次 argon2、固定的 HMAC 计算），二因素失败计入登录限速。防重放 = `user_totp.last_step` 条件 UPDATE（只接受 > last_step 的步，DB 时钟），恢复码 = `used_at IS NULL` 条件 UPDATE，均多实例安全；**不得**用进程内缓存。启用/重置 2FA、rotate-jwt 都 bump `session_ver`。秘密 AES-256-GCM（AAD=user id）存库，恢复码 HMAC-SHA256，密钥派生自 `data/totp.key`。
- **审计（M1-7）**：每个 `apply_*` 自带 `&Actor` 参数并在**同一事务**内写 `audit::record`（回滚 = 无审计行）；新增 mutator 必须同样写审计，`every_access_change_bumps_affected_nodes` 断言每个操作恰好一行。快照只走 `audit::user_snapshot_sql`/`node_snapshot_sql`/`inbounds_summary`（白名单），秘密只记 `"changed"`。登录失败审计在请求路径之外写（spawn），只记已存在账户。
- **请求路径即秘密**：前缀与订阅 token 不得出现在任何日志/trace/指标标签中，记录路径一律用 `web::redacted_path`（或匹配到的路由模板）。
- 验收门：`make check` 与 `make smoke` 全绿；新 API 必须在 smoke.sh 加断言。

## 已知问题

完整清单见 `../REVIEW-2026-09-30.md`，排期在 `PLAN.md` Phase 0.5。改相关代码前先看。
