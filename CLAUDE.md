# akari-panel

Rust 单二进制 `akari`（axum 0.8 web + tonic 0.14 gRPC）+ PostgreSQL 18（事实源）+ Valkey 9（热状态）+ 内嵌 React SPA。
Cargo.toml 在仓库根（文档里的 `panel/` 前缀是拆仓前的旧路径，已不存在）。

## 目录

| 路径 | 内容 | 子文档 |
|---|---|---|
| `src/` | 全部 Rust 代码（`lib.rs` = crate `akari_panel` 的全部模块，`main.rs` = CLI/启动入口；全局分配器 mimalloc） | `src/CLAUDE.md` |
| `bench/` | M2 基准与压测工具 crate（独立 workspace + lockfile，**不在**面板依赖图/发布二进制里）：`akari-bench seed/explain/http/swarm/lb/retention/multi` + criterion；专用 PG/Valkey 栈 `bench/compose.yml`（端口 5433/6380，不碰开发栈） | `docs/PERF.md` |
| `spa/` | React 19 + Vite 8 + Tailwind 4 前端 | `spa/CLAUDE.md` |
| `migrations/` | sqlx 迁移（启动时自动执行） | `migrations/CLAUDE.md` |
| `proto/` | **控制协议正本** `agent.proto` | `proto/CLAUDE.md` |
| `build.rs` | protox 编译 proto；缺 `spa/dist` 时写占位 index.html | — |
| `smoke.sh` | 跨仓端到端验收（需 `../akari-agent`） | — |
| `Dockerfile` | 多阶段：spa → musl 静态二进制 → distroless nonroot 镜像（target `artifact`/`prebuilt`/`runtime`） | — |
| `deploy/` | systemd 单元、生产 compose、Caddy/nginx、Prometheus 告警、Grafana 面板 | `docs/DEPLOY.md` |
| `docs/PAYMENTS.md` | 支付宝当面付：配置、沙箱、通知 URL、对账、实测记录 | — |
| `scripts/` | `backup.sh`/`restore.sh`（age 加密）、`restore-drill.sh`（开发栈恢复演练） | `docs/BACKUP.md` |
| `.github/workflows/` | `ci.yml`（含 docker build、`bench-tooling` fmt/clippy）、`bench.yml`（手动：种子数据 + criterion，工件 `target/criterion`；噪声大，只看趋势）、`release.yml`（tag `v*`：构建、SBOM、cosign 无密钥签名、GitHub Release、ghcr 镜像） | — |
| `data/` | 运行时生成：route prefix、CA、jwt.key、totp.key（gitignored，机密；totp.key 丢失 = 所有 2FA 账户需 `admin reset-2fa`；CA 丢失 = 所有节点需 `node enroll-token` 重新注册） | — |

## 命令

```bash
make dev-up        # docker compose: PG 5432 / Valkey 6379（仅 127.0.0.1）
make spa           # npm install + tsc + vite build → spa/dist
make panel         # cargo build --release（嵌入当前 spa/dist）
make check         # cargo fmt --check + clippy -D warnings + tsc + eslint/prettier + auth paths + vitest
make e2e           # Playwright（Chromium）对真实面板 + 真实 CSP 的端到端（独立库/端口 8090，见 scripts/e2e.sh）
make bench-up      # 基准专用栈（bench/compose.yml：PG 5433 / Valkey 6380）
make bench-seed    # 200 节点 / 5 万用户 / 每节点 1 万（约 60s，独立库 akari_bench）
make bench         # criterion（快照构建、订阅渲染、flush 5 万行）；其余工具见 docs/PERF.md
make bench-lint    # bench crate 的 fmt + clippy（CI 也跑）
make smoke         # 全量构建 + smoke.sh（会 TRUNCATE PG、FLUSHDB 本次 Valkey db、删 data/）
# 并行 checkout/worktree：SMOKE_DB=<名> 用独立 PG 库 + 独立 Valkey db 序号（cksum%15+1，可用 SMOKE_VALKEY_DB 覆盖；
# 默认 akari→db 0）；AGENT_DIR=<agent 检出> 指向 agent；共享端口 8443/8081，须用 flock 串行化 smoke
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
- **授权模型（M3，`entitle.rs`/`plans.rs`）**：用户可用节点 = 生效套餐（`user_plans.status='active'`，每用户至多一个，部分唯一索引）所授节点组的成员（删除中的节点除外）。`node_users.manual=false` 的行由 `entitle::apply_reconcile(conn, Scope)` 维护：每个合格 inbound（vless/vmess/trojan）一个凭据，仍存在的 (tag,protocol) 凭据原样保留，不再授权的行删除并写 `node_users_departed`，**只 bump 行真正变化的节点**。改 node_groups/node_group_members/plans/plan_groups/user_plans/节点 inbounds 的每个 `apply_*` 都在**同一事务**内调用它。**锁**：这些表的所有写者与 reconcile 调用方必须**最先**取 `entitle::lock`（事务级 advisory lock，全库一把），然后才是 nodes → users → node_users；不取会产生写偏斜（"组加节点" 与 "用户获得含该组的套餐" 互相看不见）。`manual=true`（手工分配 = 管理员覆盖，0020 之前的所有行）reconcile 永不触碰；unassign 手工行时若套餐授权该对则交还套餐（保留凭据），否则删除；套餐行 unassign → 409。授权与 role/enabled/过期无关（下发仍由 `SERVED` 过滤），但 admin 不能有套餐（400），有生效套餐的用户不能升 admin（409）。生效套餐期间 `users.traffic_limit_bytes`/`expires_at` 是套餐写入的执行值，PATCH /users 改它们 → 409。`users.disabled_reason`（admin|quota|expiry；`enabled ⇔ reason IS NULL`，0020 触发器 + CHECK 对任何写入路径成立）：周期重置与放宽配额的套餐变更**只**重新启用 `quota`，绝不启用 `admin`。周期重置/套餐到期是 `enforce::run_all` 里的幂等 pass（标记 `user_plans.next_reset_at`/status，DB 时钟），审计 actor `system`。
- **取消分配的尾部计费**：删 node_users 行（用户仍在；含 reconcile 回收、取消套餐、套餐到期）必须同事务写 `node_users_departed`，否则 agent 在 REMOVE 之后上报的最终计数被丢。
- **失联租约**：面板只在成功读到期望状态后发 `LeaseGrant`；DB 不可用时不续约（R8 产品决定）。
- **身份**：agent 身份 = mTLS 客户端证书序列号（`install::normalize_serial`：小写 hex、去前导零字节，签发/识别/墓碑共用）；xray `email` = 面板 user UUID。
- **注册与轮换（M1c / M1-8）**：bootstrap 文件**不含私钥**（panel_addr、server_name、CA、一次性 enrollment token）。gRPC TLS 客户端证书为**可选**（`grpc::server_tls`，出示的仍须经 CA/有效期/ClientAuth 校验），只为 `AgentEnrollment.Enroll`；`AgentChannel` 的每个方法（OpenChannel、Renew）都经 `enroll::peer_cert` 强制要求已验证的客户端证书，无证书在进入会话代码前就 UNAUTHENTICATED。token：256-bit，只存 SHA-256，TTL 默认 24h，单次使用 = 锁节点行后的条件 UPDATE（`used_at IS NULL AND expires_at > now()`），未知/已用/过期/节点删除中统一 PERMISSION_DENIED "enrollment refused"（同一条只匹配有效 token 的查询，无 oracle）；CSR 先于 token 检查（仅 P-256 + ecdsa-with-SHA256、无任何 attribute/扩展，subject 忽略，面板决定 CN=agent-<id>、仅 ClientAuth、新序列号、`agent.cert_validity_secs`）。Enroll 按来源地址（/64）与全局在 Valkey 限速。`nodes.cert_serial` = 最新签发，`prev_cert_serial` = 续期来源，新证书首次被看到时（`promote_on_first_sight`）旧的写 `revoked_certs`（reason `rotated`）；从 prev 再次续期会把未见过的 cert_serial 墓碑。墓碑 reason：`deleted` → 接受、推空状态、关闭（原语义）；`rotated` → 与未知证书一样拒绝（节点仍在，agent 必须保留配置改用新证书）。删除节点阶段 2 把 cert_serial 与 prev 都写 `deleted` 并把该节点的 `rotated` 升级为 `deleted`。签发/续期/提升/发 token 都在同一事务审计（actor `agent`/调用者）。
- **删除节点两阶段**：阶段 1（API/CLI）置 `deleting_at` + 禁用 + bump（agent 收敛到空状态，最终计数照常计费）；阶段 2（`reaper`，任意实例）在 ack+10s / 2min 超时 / 节点离线时写 `revoked_certs` 墓碑并删行。已吊销证书**接受连接**、推空状态后关闭（拒绝会让 agent 留着旧配置），永不计费。删除只从 DB 推导，`del:` 通知仅是提示。
- **多实例**：LISTEN 需要直连 PG，不支持 PgBouncer 事务/语句池模式。
- **会话吊销（S4-2）**：JWT 带 `sv` = `users.session_ver`，`AuthUser` 不一致即 401。改密码/禁用/改角色/过期执行由 0009 的 `users` 触发器自动 bump（任何路径，包括 CLI 与手写 SQL）；登出、`revoke-sessions` 显式 bump。**最后一个启用的管理员**不能被禁用/降级/删除：0009 触发器在 advisory xact lock 下检查，SQLSTATE `AK001` → 409（仅在 READ COMMITTED 下无竞争，应用事务全是 RC）。
- **反代（S4-1）**：客户端地址只在 TCP 对端属于 `web.trusted_proxies` 时才取 X-Forwarded-For（最右侧非受信跳）；登录限速只计失败，按地址（IPv6 按 /64）和按登录名，Valkey Lua 原子预留。`web.cookie_secure` 默认 true。
- **GO-2026-6443**：agent 的 grpc-go < 1.85 遇缺 :authority 的请求会 panic，`streamSettings.network` = grpc/gun 的 inbound 一律 400；已存的在 NodeView `warnings` 中提示；agent 在 xray 解析后由 `refuseGRPCTransport` 再拒一次（APPLY_FAILED，权威检查）。agent 升级 grpc ≥ 1.85.0 后可解除。
- **可观测性（M1-4）**：Prometheus 指标只在独立监听 `metrics.bind`（默认关闭；非回环须 `allow_non_loopback`；不得与 web/grpc 同端口），**永不**挂在公网 web 端口。标签只用路由模板（`/{prefix}/...`）与有限枚举，不得出现前缀或 id。`X-Request-Id` 只加在通过前缀闸门的响应上（`request_id.rs` 在闸门之内；带 `Rejected` 标记的响应不加），拒绝响应必须保持字节同构；URI 不进日志（可能含订阅 token）。
- **启动校验（M1-3）**：`config.rs` 结构体 `deny_unknown_fields`；`config_check.rs` 的 `validate()`（纯函数）+ `check_data_dir`，`serve` 与 `config check` 共用；错误一次列全，警告不阻止启动。
- **双因素（M1-6；R18 更正：可选但推荐）**：**更正（R18，2026-10-02，SPRINT R18-4）**：2FA 对所有账户都是可选的（后台对未开启的管理员显示可关闭的"建议开启两步验证"横幅）；配置 `auth.require_admin_2fa`（默认 false）为 true 时才恢复旧语义。JWT 带必需 claim `st`（`full`/`enroll`）。`AuthUser` 只收 `full`；仅当 `require_admin_2fa` 时 role=admin 还要求 `user_totp` 有已启用行（`auth::needs_enrollment`；开关打开后，无 2FA 管理员已有的 full 会话在下一次请求即失效，`/me/totp` 报 `stage: enroll`），此时无 2FA 的管理员密码登录只得 15 分钟 `enroll` 会话，仅 `SessionUser`（`/me/totp*` 三个端点）接受。登录请求体走 `ApiJson` + `deny_unknown_fields`（坏 body = 400 JSON，不计入登录限速）。**到期用户续费范围（R21，对标 xboard）**：已过期（`enforce::EXPIRED`，仅 role=user）但未禁用的账户可以登录（响应 `expired: true`），其会话只被 `auth::ShopUser` 接受（`/me`（带 `expired`）、`/me/plan`、`/me/password`、商店/订单端点必须用它）；`AuthUser`/`SessionUser` 一律拒绝过期账户，所以订阅、自助换 token、2FA、节点访问照旧封锁；禁用账户（任何原因，含 quota）登录与所有会话照旧 401。新端点默认用 `AuthUser`，只有明确属于续费路径的才用 `ShopUser`。登录 = 同一个 POST 带 `code`（TOTP 或恢复码），所有凭据失败统一 401、同样工作量（一条查询带出 TOTP 与未用恢复码哈希、一次 argon2、固定的 HMAC 计算），二因素失败计入登录限速。防重放 = `user_totp.last_step` 条件 UPDATE（只接受 > last_step 的步，DB 时钟），恢复码 = `used_at IS NULL` 条件 UPDATE，均多实例安全；**不得**用进程内缓存。启用/重置 2FA、rotate-jwt 都 bump `session_ver`。秘密 AES-256-GCM（AAD=user id）存库，恢复码 HMAC-SHA256，密钥派生自 `data/totp.key`。
- **审计（M1-7）**：每个 `apply_*` 自带 `&Actor` 参数并在**同一事务**内写 `audit::record`（回滚 = 无审计行）；新增 mutator 必须同样写审计，`every_access_change_bumps_affected_nodes` 断言每个操作恰好一行。快照只走 `audit::user_snapshot_sql`/`node_snapshot_sql`/`inbounds_summary`（白名单），秘密只记 `"changed"`。登录失败审计在请求路径之外写（spawn），只记已存在账户。
- **请求路径即秘密**：前缀与订阅 token 不得出现在任何日志/trace/指标标签中，记录路径一律用 `web::redacted_path`（或匹配到的路由模板）。
- **~~管理员首次 2FA 注册码（M1c）~~ 已移除（更正，R18，SPRINT R18-4）**：用户决定"安全不等于要求管理员和用户过多不必要的操作"。激活 TOTP（`/me/totp/confirm {code}`）只需当前验证码（错误统一 400 "invalid code"，计入登录限速）；`enrollment_code` 字段现为未知字段（400）。`admin add` 只打印 2FA 建议，`admin reset-2fa`/`DELETE /users/{id}/totp` 只移除 2FA（后者返回 `{"totp": <被移除的状态>}`）。表 `totp_enroll_codes` 由迁移 0035 删除。代价：开启 `require_admin_2fa` 时，拿到管理员密码者可抢先绑定自己的身份验证器（与"密码即可登录"同级的风险，接受）。
- **性能（M2）**：达标数字与复现步骤在 `docs/PERF.md`（flush 5 万行 0.91s 余量只有约 9%，改 `traffic::FLUSH_SQL`/`write_rows` 前后都跑 `make bench`；快照 10k 用户 43ms；管理 API/订阅 p99 见 PERF）。`traffic_counters` 保留任务（`traffic::retention_pass`，reaper 循环）只删可证明已死的会话行，见 `src/CLAUDE.md`/`migrations/CLAUDE.md`；`AuthUser` 每请求一次索引查询（约 0.4ms），**不加缓存**——吊销必须在下一次请求、所有实例上生效（`akari-bench multi` 断言）。多实例参考拓扑在 `docs/DEPLOY.md`。
- **agent 自更新（M6，`updates.rs`/`rollout.rs`）**：信任根是**编译进 agent 的** Ed25519 发布公钥（akari-agent `release-keys.txt`），面板只是中继——面板被攻破也只能扣住/延迟更新，不能推未签名、异平台或降级的二进制（降级仅限签名的 `rollback` manifest，且节点已回滚过的版本永不再接受）。面板用 `updates.release_keys` 再验一遍（提前拒绝，不是安全边界）；manifest 字节原样存储与下发，**不得重新序列化**。二进制按 1 MiB 存 `agent_release_chunks`（任意实例可服务），下载走现有 mTLS 的 `AgentChannel.FetchArtifact`（需已验证客户端证书、已删除节点拒绝、每实例并发 `updates.max_concurrent_downloads`）。协议门：只给 `protocol_version >= 3` 的 agent 发 `UpdateOffer`（1/2 照常服务，永不收到 offer，rollout 中记为 skipped）。健康门是面板自己的：节点以目标版本重新 Hello 且本流有 ok Ack；agent 的 REJECTED/FAILED/ROLLED_BACK 立即判失败；超时判失败；失败比 > 阈值自动 halt（halted 只能 abort）；至多一个未结束 rollout（唯一索引）；所有状态变更同事务审计（自动的用 actor `system`），advisory lock `akari.rollout` 串行化。
- **一键安装（R18-2，`nodeinstall.rs`/`nodetpl.rs`）**：安装链接 = 节点的一次性 enrollment token（`node_enrollments.install_origin` 非空，0030；TTL `install.token_ttl_secs` 默认 1h；新链接/新 token 覆盖旧的）。`GET /{prefix}/install/{token}` 出脚本、`.../agent/{arch}` 出最新完整发布（`agent_release_chunks`）——**只在 token 有效**（未用、未过期、非 bootstrap token、节点未删除、未超每地址限速）时回答，其余一律 `reject::not_found()`（与垃圾路径字节同构，smoke 断言）；agent 注册即烧掉 token，链接随之失效。脚本里的 token 不上任何命令行（URL 走 stdin），日志路径 `/{prefix}/install/{token}`。源站证书非公共 CA 信任时命令带 `--pinnedpubkey`（`-k` 只与 pin 同时出现，绝不单独输出）。模板只生成 JSON，入站仍走 `validate_inbounds` + `apply_set_inbounds`；REALITY 密钥用 x25519-dalek（RFC 7748 向量测试）。
- **支付（R18-3，`src/billing/`，`docs/PAYMENTS.md`）**：只接支付宝当面付（公钥模式 RSA2）。金额一律整数分，订单金额在创建时从 `plan_prices` 拷贝，**客户端从不提交金额**，与支付宝比对的只有这个值。**付款只有一条路径** `billing::orders::apply_mark_paid`：`entitle::lock` → 条件 `UPDATE orders ... WHERE status <> 'paid'` → 通过 `plans::apply_set_user_plan`/`apply_update_user_plan` 开通（savepoint：业务失败只回滚套餐变更，订单仍为 paid + `fulfil_error`，绝不丢钱）→ 审计，同一事务；异步通知、轮询查询（`GET /me/orders/{id}`）、对账（每实例 10s，`SKIP LOCKED` + `last_query_at` 认领）、管理员人工确认都走它，所以重放/并发/多实例恰好开通一次（`billing::tests::concurrent_duplicates_fulfil_once`）。过期/取消的订单收到付款照样开通。通知端点 `/{prefix}/pay/alipay/notify` 的**一切**拒绝（限速、未启用、超大/畸形、验签失败、app_id/seller_id 不符、未知订单、金额不符）都是 `reject::not_found()` 且写 `payment_events`；只有验签通过的本系统订单回 `success`。`sign` 只以 `<redacted>` 存；`notify_url` 含前缀：不进日志、`config check` 打码，路径与当前前缀不符则拒绝启动（rotate-prefix 后要改配置）。同步响应按原始字节验签（`RawValue`，不得重新序列化）。私钥文件 0600、启动与 `config check` 校验。续费 = 同套餐延长 `period_days`（从 max(到期, now)）；换套餐 = M3 替换 + 清零已用流量。新状态变更必须同事务写审计（`order.*`、`plan.price.*`）。
- 验收门：`make check` 与 `make smoke` 全绿；新 API 必须在 smoke.sh 加断言。

## 已知问题

完整清单见 `../REVIEW-2026-09-30.md`，排期在 `PLAN.md` Phase 0.5。改相关代码前先看。
