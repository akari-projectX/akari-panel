# akari-panel/src — Rust 后端

扁平模块，`main.rs` 末尾声明。全局状态是 `state::AppState`（`Arc<Inner>` 克隆句柄）。

## 模块地图

| 模块 | 职责 | 改动须知 |
|---|---|---|
| `main.rs` | clap CLI（serve/info/node/admin）与启动装配 | 顶部强制装 rustls ring provider，勿删；目前只处理 ctrl_c，不处理 SIGTERM |
| `config.rs` | `panel.toml` + `DATABASE_URL`/`VALKEY_URL` 覆盖 | gRPC advertise 必须写显式 IP；`grpc.lease_seconds` 失联租约（默认 86400）；`traffic.departed_grace_secs`（默认 900）；`agent.remove_mode` = gate（默认）/rebuild |
| `install.rs` | data/ 下的 route prefix、CA、jwt.key；每次启动重签服务端证书 | SAN 取自 `web.advertised_names`（虽然证书用于 gRPC）；服务端证书 EKU 仅 ServerAuth，agent 证书仅 ClientAuth（测试断言） |
| `state.rs` | AppState、agent 代数注册表、`notify_change()` watch 通道 | `notify_change` 只唤醒，不携带内容；每个会话自行重读 DB |
| `grpc.rs` | AgentChannel：证书→节点、Hello/心跳/流量/Ack、`desired_state`（REPEATABLE READ 只读事务，版本与用户集同一快照）+ `sync_if_stale`（Snapshot 或 UserDelta）、租约下发、60s 对账 tick | **下发选择**（`SyncState::decide` 返回 `Plan`）：只在本会话内"可验证地知道 agent 正在跑的用户集"（`acked`：本会话发出且 ok Ack、哈希一致；或 Hello 的 state_hash 与持有版本处的期望集一致）且 config_version 不变、inbounds 原文不变、节点启用、协议 ≥ `MIN_AGENT_PROTOCOL`（`remove_mode=rebuild` 时还要求不删除/不轮换任何活凭据，`drops_credential`）时发 `UserDelta`（base=acked 或在途状态，`diff_user_sets` 计算，ADD=REPLACE 带完整列表）；否则 Snapshot。失败版本重试、发散修复一律 Snapshot。**Ack reason**：OK→核对 `state_hash`（delta 不一致→`Resync` 立即 Snapshot；snapshot 自身不一致→按失败退避，防重建风暴）；`BASE_MISMATCH`→立即 Snapshot，不算失败不退避；`APPLY_FAILED`→失败 + 退避后 Snapshot。持有版本取 Ack 的 `held_*`。**协议门（N5）**：Hello 前不下发；`protocol_version < MIN_AGENT_PROTOCOL`（旧 agent 为 0）→ 接受连接但每会话强制推一次空状态（版本 (0,0)），不信任其 Hello/Ack（不清 last_error、不记失败），`last_error` 写 "agent too old"、`nodes.agent_protocol` 记录协议号。**租约**：每次成功读到期望状态（Hello 同步、notify、对账 tick）后、在任何 Snapshot 之前发 `LeaseGrant`（`grpc.lease_seconds`，夹到 [1h,30d]）；读库失败不发；`nodes.lease_expires_at` 每会话 ≤30s 写一次（NodeView `lease_remaining_seconds`）；旧 agent 不发。state hash v2 规范见 proto（含 inbounds 原文的 SHA-256；`NodeState` = inbounds + 用户集），`state_hash`/`user_set` 与 agent 共用 `proto/state_hash_vectors.json`（由独立参考实现 `proto/testdata/gen_vectors.py` 生成）。LeaseGrant 同时携带 `remove_mode`。其余沿用：读 DB 前取票据防旧快照覆盖新快照；同一版本在途不重发；失败版本（会话内 + `nodes.failed_*`）只在期望变化或退避（30s 起翻倍，封顶 10min）后重发；在途超时（120s）或断流仍在途算失败；0004 失败上下文（nack/no_ack、失败时持有版本），Hello (0,0) 或持有版本变化不退避；ok Ack 或 Hello 覆盖失败版本时清 `last_error`。`nodes.online_session` 归属：只有最后标记 online 的会话能刷新/置 offline |
| `traffic.rs` | 累计值记账：内存只存每 (node,user,session) 最高累计值；5s flush 用**单条 SQL** upsert `traffic_counters`(GREATEST) 并按 PG18 `RETURNING old/new` 算差值加到 users；随后跑 `enforce::run_all` | 差值只能在 SQL 里算，**不要**在内存里攒 pending（重放/重启/重试/乱序的幂等性全靠它）。session 只取 `TrafficReport.session_id`（agent 与计数原子读取）；缺失则丢弃并告警，不回退 Hello session。会话内回退 → warn、计 0。session id 拒收空/超 128/含 NUL；>i64::MAX 丢弃。批量被库拒 → 逐行重试，单行因数据错误（SQLSTATE 22/23）连续 12 次被拒则放弃，瞬时错误不计数。内存侧先按节点成员缓存（`set_members`/`refresh_members`：会话开始加载，每次 notify/对账刷新；未加载则整份丢弃）过滤非成员，单份上报 ≤ 65536 行（非成员逐行丢弃，不整份丢），每节点条目 ≤ 成员×16（满时整体淘汰该节点最久未触碰的干净 session）；准入/脏 session 计数/淘汰都走每节点索引 `NodeIndex`，**不得**扫描全部条目；索引只能在持有条目锁时更新（锁序 entries → index，删除的记账在 `remove_if` 闭包内），prune 每个 tick 从 entries 全量重建索引自愈；SQL 侧只计费 node_users 中存在的、或 `node_users_departed` 里 departed_at 在宽限期（`traffic.departed_grace_secs`，默认 15min）内的 (node,user)——被取消分配用户的最终计数在 REMOVE 之后才到；成员缓存同样加载宽限内的 departed；过期行每个 flush tick 清理，被 SQL 拒绝的条目直接移除；每节点未落库 session ≤16（已知 session 总是接受）；单行差值按 `traffic.max_rate_bytes_per_sec`×距上次写入时间（+15s，新行至少 60s）截断，计数照存（只会少计）。干净且闲置 10 分钟的条目被淘汰。真库测试 `db_tests` 需 `make dev-up`（`AKARI_SKIP_DB_TESTS=1` 跳过） |
| `auth.rs` | `ApiError`、argon2id、HS256 JWT、`AuthUser` 提取器（每请求回查 DB） | 提取器拒绝禁用或已过期（role=user）账户；JWT 无吊销；改密码不失效旧会话 |
| `api.rs` | REST handler（登录、me、用户、节点、分配）+ `apply_*` 事务内变更 | 请求体用 `ApiJson`（所有解析错误 → 400）+ `deny_unknown_fields`；PATCH 字段一律 `double_option`：缺省=不改，null=清空（仅可空字段，否则 400），空 PATCH → 400。`server_addr` 空串归一为 null。assign 锁节点行并校验 inbound 协议；set_inbounds 同事务按 (tag, protocol) 裁剪凭据、删除变空的行（写 `node_users_departed`；unassign 同样写，assign 删除；删用户不写，级联删除）；inbounds 中出现 fakedns → 400，tag 唯一且不得为保留名（`api`、`akari-*`、`_*`）。**提高流量上限不会自动重新启用**被超限禁用的用户，需显式 `enabled: true` |
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
