# akari-panel/src — Rust 后端

扁平模块，`main.rs` 末尾声明。全局状态是 `state::AppState`（`Arc<Inner>` 克隆句柄）。

## 模块地图

| 模块 | 职责 | 改动须知 |
|---|---|---|
| `main.rs` | clap CLI（serve/info/node/admin）与启动装配 | 顶部强制装 rustls ring provider，勿删；目前只处理 ctrl_c，不处理 SIGTERM |
| `config.rs` | `panel.toml` + `DATABASE_URL`/`VALKEY_URL` 覆盖 | gRPC advertise 必须写显式 IP |
| `install.rs` | data/ 下的 route prefix、CA、jwt.key；每次启动重签服务端证书 | SAN 取自 `web.advertised_names`（虽然证书用于 gRPC） |
| `state.rs` | AppState、agent 代数注册表、`notify_change()` watch 通道 | `notify_change` 只唤醒，不携带内容；每个会话自行重读 DB |
| `grpc.rs` | AgentChannel：证书→节点、Hello/心跳/流量/Ack、`sync_if_stale` 全量快照 | 只发 Snapshot，从不发 UserDelta；节点被禁用时不会断开流 |
| `traffic.rs` | 累计值→差值记账，5s 批量落库，超限禁用 | 内存基线未从 `traffic_counters` 恢复：面板重启后会重复计费 |
| `auth.rs` | `ApiError`、argon2id、HS256 JWT、`AuthUser` 提取器（每请求回查 DB） | JWT 无吊销；改密码不失效旧会话 |
| `api.rs` | REST handler（登录、me、用户、节点、分配） | 动态 SET 用手工逗号 + `#[allow(unused_assignments)]`；空 body 会拼出非法 SQL |
| `sub.rs` | 过渡期订阅：UA 分流 links/clash/sing-box，8KiB 填充 | 终态只留 Clash；token 只存 SHA-256 |
| `web.rs` | 路由表 + `prefix_gate` 常数时间前缀校验 + 安全头 | 新路由照抄 `/{prefix}/...` 形式 |
| `decoy.rs` + `decoy.html` | 伪装站 | 200 与 404 同字节 |
| `spa.rs` | rust-embed 服务 `spa/dist`，运行时把 `/assets/` 改写到前缀下 | — |
| `nodeops.rs` | `node add/list`、`admin add` CLI | bootstrap 文件含 agent 私钥（v1） |
| `valkey_util.rs` | 带 TTL 的 set；失败只记日志 | 键名空间 `akari:*` |
| `gen.rs` | `tonic::include_proto!("akari.v1")` | 由 build.rs 生成 |

## 约定

- 错误：handler 返回 `Result<_, ApiError>`；`sqlx::Error`/`anyhow::Error` 自动转 500，并记录日志，不向客户端泄露细节。
- SQL：运行时 `sqlx::query*`（非编译期宏），手写 SQL，列名与 migrations 保持一致。
- 状态变更的顺序：**写库 → bump 版本 → notify_change**，放在同一事务里更好。
- 目前**没有单元测试**；新增纯逻辑（traffic 差值、sub 渲染、prefix gate）应带 `#[cfg(test)]` 测试。
