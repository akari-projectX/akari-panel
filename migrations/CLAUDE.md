# akari-panel/migrations

sqlx 迁移，经 `db::migrate`（先校验 PostgreSQL ≥ 18）在 `serve`、`node add`、`admin add` 启动时自动执行。

- **只追加，不修改**已存在的迁移文件（sqlx 会校验 checksum，改了已部署环境会拒绝启动）。
- 命名：`NNNN_<topic>.sql`，四位递增。
- 改列名/加列后，同步检查 `src/` 中所有手写 SQL 与 `FromRow` 结构体（没有编译期 SQL 校验）。

## 当前表

| 表 | 关键点 |
|---|---|
| `nodes` | `cert_serial` UNIQUE = agent 身份；`config_version`/`user_version` 单调递增；`server_addr`（0002）供订阅使用；0003：`last_error`/`last_error_at`/`failed_config_version`/`failed_user_version`（agent 最近一次失败的应用及其尝试的版本，被覆盖它的 ok Ack 清空），`online_session`（最后标记 online 的 gRPC 会话）；0004：`failed_reason`（nack/no_ack）、`failed_held_config_version`/`failed_held_user_version`（失败时 agent 持有的版本）；0005：`agent_protocol`（最近连接 agent 的 Hello.protocol_version）、`lease_expires_at`（最近一次下发的失联租约到期时间） |
| `users` | `id` 同时是 xray `email`；`sub_token_hash`（0002）只存 SHA-256；`traffic_used_bytes` 由 traffic.rs 累加；0003：`expiry_enforced`（过期移除已下发的标记，改 `expires_at` 时重置） |
| `node_users` | PK (node_id,user_id)；`credentials` JSONB = `[{inbound_tag, protocol, account}]` |
| `traffic_counters` | PK (node_id,user_id,session_id) 的最高累计值（GREATEST）。**这是计费基线，不是日志**：flush 用它算差值（`new - old`）。删掉一个仍会上报的会话的行 = 下次上报把整段累计值重新计费。**无外键、无清理**，会随会话数增长 |

**保留策略须知**：任何清理任务只能删除**可证明已死**的会话行（该 agent 已换新 session 且旧 session 不可能再上报，例如节点已删除，或 `updated_at` 远早于该节点当前 session 首次出现且超过安全窗口）；不确定就不删。

已知缺口（见 REVIEW）：`traffic_counters` 无保留策略；无审计日志表；`role`/`status` 为自由文本，无 CHECK 约束。
