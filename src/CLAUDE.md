# akari-panel/src — Rust 后端

扁平模块，`main.rs` 末尾声明。全局状态是 `state::AppState`（`Arc<Inner>` 克隆句柄）。

## 模块地图

| 模块 | 职责 | 改动须知 |
|---|---|---|
| `main.rs` | clap CLI（serve/info/node/admin）与启动装配 | 顶部强制装 rustls ring provider，勿删；目前只处理 ctrl_c，不处理 SIGTERM |
| `config.rs` | `panel.toml` + `DATABASE_URL`/`VALKEY_URL` 覆盖 | gRPC advertise 必须写显式 IP |
| `install.rs` | data/ 下的 route prefix、CA、jwt.key；每次启动重签服务端证书 | SAN 取自 `web.advertised_names`（虽然证书用于 gRPC） |
| `state.rs` | AppState、agent 代数注册表、`notify_change()` watch 通道 | `notify_change` 只唤醒，不携带内容；每个会话自行重读 DB |
| `grpc.rs` | AgentChannel：证书→节点、Hello（每条流首条 + agent 每次重建后重发）/心跳/流量/Ack、`sync_if_stale` 全量快照 | 只发 Snapshot，从不发 UserDelta；节点被禁用时不会断开流 |
| `traffic.rs` | 累计值记账：内存只存每 (node,user,session) 最高累计值；5s flush 用**单条 SQL** upsert `traffic_counters`(GREATEST) 并按 PG18 `RETURNING old/new` 算差值加到 users；然后超限禁用 | 差值只能在 SQL 里算，**不要**在内存里攒 pending（重放/重启/重试/乱序的幂等性全靠它）。session 取 `TrafficReport.session_id`（agent 与计数原子读取），为空才回退 Hello session（旧 agent）。会话内回退 → warn、计 0。session id 拒收空/超 128/含 NUL；>i64::MAX 丢弃。批量被库拒 → 逐行重试，单行连续 12 次被拒则放弃。干净且闲置 10 分钟的条目被淘汰。真库测试 `db_tests` 需 `make dev-up`（`AKARI_SKIP_DB_TESTS=1` 跳过） |
| `auth.rs` | `ApiError`、argon2id、HS256 JWT、`AuthUser` 提取器（每请求回查 DB） | JWT 无吊销；改密码不失效旧会话 |
| `api.rs` | REST handler（登录、me、用户、节点、分配） | 动态 SET 用手工逗号 + `#[allow(unused_assignments)]`；空 body 会拼出非法 SQL |
| `sub.rs` | 过渡期订阅：UA 分流 links/clash/sing-box，8KiB 填充 | 终态只留 Clash；token 只存 SHA-256 |
| `web.rs` | 路由表 + `prefix_gate` 常数时间前缀校验 + 安全头（仅真实响应） | 新路由照抄 `/{prefix}/...` 形式；fallback 与 `method_not_allowed_fallback` 都走 reject（否则 405 是前缀探针） |
| `reject.rs` | 统一拒绝响应：404 + 空 body，带 `Rejected` 扩展标记 | 所有拒绝都用 `reject::not_found()`；web.rs 的安全头中间件跳过带标记的响应（404 上的安全头组合本身就是指纹） |
| `spa.rs` | rust-embed 服务 `spa/dist`，运行时把 `/assets/` 改写到前缀下 | 缺失资源 → `reject::not_found()` |
| `nodeops.rs` | `node add/list`、`admin add` CLI | bootstrap 文件含 agent 私钥（v1） |
| `valkey_util.rs` | 带 TTL 的 set；失败只记日志 | 键名空间 `akari:*` |
| `gen.rs` | `tonic::include_proto!("akari.v1")` | 由 build.rs 生成 |

## 约定

- 错误：handler 返回 `Result<_, ApiError>`；`sqlx::Error`/`anyhow::Error` 自动转 500，并记录日志，不向客户端泄露细节。
- SQL：运行时 `sqlx::query*`（非编译期宏），手写 SQL，列名与 migrations 保持一致。
- 状态变更的顺序：**写库 → bump 版本 → notify_change**，放在同一事务里更好。
- 单元测试：`traffic.rs` 已有（含依赖开发库的 `db_tests`）；新增纯逻辑（sub 渲染、prefix gate）应带 `#[cfg(test)]` 测试。
