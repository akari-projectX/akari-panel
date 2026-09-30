# akari-panel/migrations

sqlx 迁移，`sqlx::migrate!("./migrations")` 在 `serve`、`node add`、`admin add` 启动时自动执行。

- **只追加，不修改**已存在的迁移文件（sqlx 会校验 checksum，改了已部署环境会拒绝启动）。
- 命名：`NNNN_<topic>.sql`，四位递增。
- 改列名/加列后，同步检查 `src/` 中所有手写 SQL 与 `FromRow` 结构体（没有编译期 SQL 校验）。

## 当前表

| 表 | 关键点 |
|---|---|
| `nodes` | `cert_serial` UNIQUE = agent 身份；`config_version`/`user_version` 单调递增；`server_addr`（0002）供订阅使用 |
| `users` | `id` 同时是 xray `email`；`sub_token_hash`（0002）只存 SHA-256；`traffic_used_bytes` 由 traffic.rs 累加 |
| `node_users` | PK (node_id,user_id)；`credentials` JSONB = `[{inbound_tag, protocol, account}]` |
| `traffic_counters` | PK (node_id,user_id,session_id) 的最新累计值；**无外键、无清理**，会随会话数增长 |

已知缺口（见 REVIEW）：`traffic_counters` 无保留策略；无审计日志表；`role`/`status` 为自由文本，无 CHECK 约束。
