# akari-panel/src — Rust 后端

扁平模块，`main.rs` 末尾声明。全局状态是 `state::AppState`（`Arc<Inner>` 克隆句柄）。

## 模块地图

| 模块 | 职责 | 改动须知 |
|---|---|---|
| `main.rs` | clap CLI（serve/info/node/admin）与启动装配 | 顶部强制装 rustls ring provider，勿删；目前只处理 ctrl_c，不处理 SIGTERM |
| `config.rs` | `panel.toml` + `DATABASE_URL`/`VALKEY_URL` 覆盖 | gRPC advertise 必须写显式 IP |
| `install.rs` | data/ 下的 route prefix、CA、jwt.key；每次启动重签服务端证书 | SAN 取自 `web.advertised_names`（虽然证书用于 gRPC） |
| `state.rs` | AppState、agent 代数注册表、`notify_change()` watch 通道 | `notify_change` 只唤醒，不携带内容；每个会话自行重读 DB |
| `grpc.rs` | AgentChannel：证书→节点、Hello/心跳/流量/Ack、`desired_state` + `sync_if_stale` 全量快照、60s 对账 tick | 只发 Snapshot，从不发 UserDelta。禁用节点照常接入并收到空快照。`SyncState`：读 DB 前取票据，票据更旧且版本不更新的期望状态不发送（防旧快照覆盖新快照）；持有版本只由 Hello/ok Ack 更新；同一版本在途不重发，Ack 仅在版本等于在途版本时结束在途；失败版本（会话内 + `nodes.failed_*`）只在期望变化或退避（30s 起翻倍，封顶 10min）后重发；在途超时（120s）或断流时仍在途都算失败。持久化的失败带上下文（0004：`failed_reason` nack/no_ack、失败时持有版本）：新会话只有在 agent 状态未变时才退避——no_ack 失败每会话允许一次立即重发，Hello (0,0) 或持有版本变化则不退避。ok Ack 或 Hello 覆盖失败版本时清 `last_error`。`nodes.online_session` 归属：只有最后标记 online 的会话能刷新/置 offline |
| `traffic.rs` | 累计值记账：内存只存每 (node,user,session) 最高累计值；5s flush 用**单条 SQL** upsert `traffic_counters`(GREATEST) 并按 PG18 `RETURNING old/new` 算差值加到 users；随后跑 `enforce::run_all` | 差值只能在 SQL 里算，**不要**在内存里攒 pending（重放/重启/重试/乱序的幂等性全靠它）。session 只取 `TrafficReport.session_id`（agent 与计数原子读取）；缺失则丢弃并告警，不回退 Hello session。会话内回退 → warn、计 0。session id 拒收空/超 128/含 NUL；>i64::MAX 丢弃。批量被库拒 → 逐行重试，单行因数据错误（SQLSTATE 22/23）连续 12 次被拒则放弃，瞬时错误不计数。内存侧先按节点成员缓存（`set_members`/`refresh_members`：会话开始加载，每次 notify/对账刷新；未加载则整份丢弃）过滤非成员，单份上报 ≤ 65536 行（非成员逐行丢弃，不整份丢），每节点条目 ≤ 成员×16（满时整体淘汰该节点最久未触碰的干净 session）；准入/脏 session 计数/淘汰都走每节点索引 `NodeIndex`，**不得**扫描全部条目；SQL 侧只计费 node_users 中存在的 (node,user)，被 SQL 拒绝的条目直接移除；每节点未落库 session ≤16（已知 session 总是接受）；单行差值按 `traffic.max_rate_bytes_per_sec`×距上次写入时间（+15s，新行至少 60s）截断，计数照存（只会少计）。干净且闲置 10 分钟的条目被淘汰。真库测试 `db_tests` 需 `make dev-up`（`AKARI_SKIP_DB_TESTS=1` 跳过） |
| `auth.rs` | `ApiError`、argon2id、HS256 JWT、`AuthUser` 提取器（每请求回查 DB） | 提取器拒绝禁用或已过期（role=user）账户；JWT 无吊销；改密码不失效旧会话 |
| `api.rs` | REST handler（登录、me、用户、节点、分配）+ `apply_*` 事务内变更 | 请求体用 `ApiJson`（所有解析错误 → 400）+ `deny_unknown_fields`；PATCH 字段一律 `double_option`：缺省=不改，null=清空（仅可空字段，否则 400），空 PATCH → 400。`server_addr` 空串归一为 null。assign 锁节点行并校验 inbound 协议；set_inbounds 同事务按 (tag, protocol) 裁剪凭据、删除变空的行，tag 唯一且不得为保留名（`api`、`akari-*`、`_*`）。**提高流量上限不会自动重新启用**被超限禁用的用户，需显式 `enabled: true` |
| `sub.rs` | 过渡期订阅：UA 分流 links/clash/sing-box，8KiB 填充 | 终态只留 Clash；token 只存 SHA-256 |
| `web.rs` | 路由表 + `prefix_gate` 常数时间前缀校验 + 安全头（仅真实响应） | 新路由照抄 `/{prefix}/...` 形式；fallback 与 `method_not_allowed_fallback` 都走 reject（否则 405 是前缀探针） |
| `reject.rs` | 统一拒绝响应：404 + 空 body，带 `Rejected` 扩展标记 | 所有拒绝都用 `reject::not_found()`；web.rs 的安全头中间件跳过带标记的响应（404 上的安全头组合本身就是指纹） |
| `spa.rs` | rust-embed 服务 `spa/dist`，运行时把 `/assets/` 改写到前缀下 | 缺失资源 → `reject::not_found()` |
| `enforce.rs` | 周期执行（随 5s flush）：超限禁用、过期下发；共享过期谓词 `EXPIRED` | 每个 pass 一个事务：无锁 SELECT 候选 → 按 id 锁其节点 → 复查谓词 UPDATE users → bump（新出现的节点由 bump 越序加锁，死锁则下个 tick 重试）；提交后有变化才 notify；`users.expiry_enforced` 在 PATCH `expires_at` 时重置 |
| `testdb.rs` | 测试专用：每个测试一个临时 schema 并跑完迁移 | 需 `make dev-up`；`AKARI_SKIP_DB_TESTS=1` 跳过 |
| `nodeops.rs` | `node add/list`、`admin add` CLI | bootstrap 文件含 agent 私钥（v1） |
| `valkey_util.rs` | 带 TTL 的 set；失败只记日志 | 键名空间 `akari:*` |
| `gen.rs` | `tonic::include_proto!("akari.v1")` | 由 build.rs 生成 |

## 约定

- 错误：handler 返回 `Result<_, ApiError>`；`sqlx::Error`/`anyhow::Error` 自动转 500，并记录日志，不向客户端泄露细节。
- SQL：运行时 `sqlx::query*`（非编译期宏），手写 SQL，列名与 migrations 保持一致。
- 状态变更：`apply_*` 在调用方事务内写库 + bump，handler 提交后 notify（见根 CLAUDE.md「收敛」）。
- 测试：`traffic`、`api`、`grpc`、`db` 有单元测试与真库测试（`testdb.rs`）；sub 渲染、prefix gate 仍缺。
