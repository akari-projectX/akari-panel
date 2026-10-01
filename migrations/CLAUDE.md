# akari-panel/migrations

sqlx 迁移，经 `db::migrate`（先校验 PostgreSQL ≥ 18）在 `serve`、`node add`、`admin add` 启动时自动执行。

- **只追加，不修改**已存在的迁移文件（sqlx 会校验 checksum，改了已部署环境会拒绝启动）。
- 命名：`NNNN_<topic>.sql`，四位递增（M3 从 0020 起，0014–0019 留给 M2）。
- 改列名/加列后，同步检查 `src/` 中所有手写 SQL 与 `FromRow` 结构体（没有编译期 SQL 校验）。

## 当前表

| 表 | 关键点 |
|---|---|
| `nodes` | 0020：`region`（给用户看的地区，可空）；`cert_serial` UNIQUE = agent 身份；`config_version`/`user_version` 单调递增；`server_addr`（0002）供订阅使用；0003：`last_error`/`last_error_at`/`failed_config_version`/`failed_user_version`（agent 最近一次失败的应用及其尝试的版本，被覆盖它的 ok Ack 清空），`online_session`（最后标记 online 的 gRPC 会话）；0004：`failed_reason`（nack/no_ack）、`failed_held_config_version`/`failed_held_user_version`（失败时 agent 持有的版本）；0005：`agent_protocol`（最近连接 agent 的 Hello.protocol_version）、`lease_expires_at`（最近一次下发的失联租约到期时间）；0007：`deleting_at`/`delete_acked_at`（两阶段删除）、`traffic_tat`（节点 GCRA 虚拟时钟，NULL=now−60s）、`traffic_max_rate_bytes_per_sec`（节点计费上限覆盖，>0）；触发器 `nodes_notify_versions`（(config_version,user_version) 变化 → `pg_notify('akari_change', id)`）、`nodes_notify_delete`（`del:<id>`）、`nodes_refuse_revoked_serial`（拒绝插入/改成已吊销序列号）；0007 把旧的带前导 `00` 的 `cert_serial` 规范化；0008：`traffic_credit_floor`/`traffic_credit_until`（重连计费额度，见 traffic.rs）；0011：`cert_serial` 在注册前为 NULL（pending 节点），`prev_cert_serial` UNIQUE（续期来源，新证书首次出现前仍有效），`cert_not_after`（cert_serial 的到期时间；M1c 前签发的证书在 agent 下次连接时补上），`nodes_refuse_revoked_serial` 触发器同时检查 prev_cert_serial |
| `users` | 0012：`users_created_at (created_at, id)`（用户列表的 deferred-join 分页）、fillfactor 85（计费 UPDATE 走 HOT，勿给 `traffic_used_bytes` 建索引）；`id` 同时是 xray `email`；`sub_token_hash`（0002）只存 SHA-256；`traffic_used_bytes` 由 traffic.rs 累加；0003：`expiry_enforced`（过期移除已下发的标记，改 `expires_at` 时重置）；0020：`disabled_reason` 枚举 admin/quota/expiry（触发器 `users_disabled_reason`：启用清空、禁用未给原因 = admin；CHECK `enabled = (disabled_reason IS NULL)`；expiry 预留未用——过期由谓词执行）；0009：`session_ver`（JWT `sv`），触发器 `users_bump_session_ver`（BEFORE UPDATE OF password_hash/role/enabled/expiry_enforced：改密码、改角色、禁用、过期执行时 +1；计费 UPDATE 不触发），`users_keep_last_admin_update/_delete`（advisory xact lock 下保证至少一个 role=admin AND enabled，否则 SQLSTATE AK001） |
| `node_users` | PK (node_id,user_id)；`credentials` JSONB = `[{inbound_tag, protocol, account}]`；0020：`manual`（默认 TRUE：手工分配/旧行/任何其他写入者 = 管理员覆盖；reconcile 只写 FALSE 行） |
| `node_groups` / `node_group_members` | 0020：组（name UNIQUE、description）；成员 PK (group_id,node_id)，节点/组删除级联，索引 node_id |
| `plans` / `plan_groups` | 0020：`traffic_quota_bytes`（NULL=不限）、`reset_period` monthly/days/none + `reset_days`（仅 days，1–3650，CHECK）、`speed_limit_mbps`（提示，不执行）、`device_seats`（M5 预留，不执行）、`sort`、`enabled`（是否对新分配提供）；plan_groups PK (plan_id,group_id)，级联 |
| `user_plans` | 0020：`status` 枚举 active/replaced/cancelled/expired（`(status='active') = (ended_at IS NULL)`），部分唯一索引 `user_plans_one_active (user_id) WHERE active`；`period_anchor`、`last_reset_at`、`next_reset_at`（重置标记，pass 处理 `<= now()` 并在同一 UPDATE 推进）、`expires_at`；用户/套餐删除级联；函数 `akari_next_reset(anchor, period, days, after)`（UTC 月份边界夹到月末、N 天精确秒数，严格晚于 after） |
| `node_users_departed` | 0006：PK (node_id,user_id) + departed_at。user 仍存在但 node_users 行被删（unassign、set_inbounds 裁空）时写入，宽限期内仍计费最终计数；re-assign 删除；flush 循环清理过期行；user/node 删除级联；0008：`billed_bytes`（离开后累计已计费，重新离开时清零） |
| `revoked_certs` | 0007：`cert_serial` PK（规范化形式）、node_id、revoked_at。永久墓碑，身份识别最先查它；0011：`reason`（`deleted` = 接受→空状态→关闭；`rotated` = 续期/重新注册取代，按未知证书拒绝） |
| `node_enrollments` | 0011：PK node_id（级联删除；重新签发覆盖）、`token_hash` BYTEA UNIQUE（SHA-256）、expires_at、used_at（条件 UPDATE 烧掉，单次使用） |
| `totp_enroll_codes` | 0011：PK user_id（级联）、`code_hash` BYTEA（SHA-256(user id‖规范化码)）、expires_at（24h）；admin 激活 TOTP 时消费 |
| `user_totp` | 0010：PK user_id（级联删除）；`secret_enc` BYTEA（0x01‖nonce‖AES-256-GCM 密文，AAD=user id）；`enabled_at` NULL=待确认；`last_step` 已接受的最大时间步（防重放） |
| `user_recovery_codes` | 0010：PK (user_id, code_hash)；`code_hash` = hex HMAC-SHA256；`used_at` 非空 = 已用 |
| `audit_log` | 0010：`id` IDENTITY（keyset 游标）、`at`（事务开始）、`actor_id`（无外键，CLI 为 NULL）、`actor_login`（CLI = `cli`）、`ip` TEXT、`action`、`target_type`/`target_id`、`before`/`after` JSONB（已脱敏）；索引 at / (actor_login,id) / (action,id)；按 `audit.retention_days` 清理 |
| `traffic_sessions` | 0013：PK (node_id,session_id)（级联删除）、`first_seen_at`、`retired_at`（墓碑，永久；`FLUSH_SQL` 拒收退休会话的上报）、`purged_at`（其 `traffic_counters` 行已清）。`nodes` 同迁移新增 `agent_session`/`agent_session_at`（最近 Hello 带来的 agent session）与 `finals_drained_session`/`finals_drained_at`（排空证明：流在 Hello 之后存活 ≥60s，agent 已交付此前所有被取代 session 的最终上报） |
| `traffic_counters` | PK (node_id,user_id,session_id) 的最高累计值（GREATEST）。0007：`first_seen_at`（插入时写、之后不改；NULL = 旧行，按 updated_at）。**这是计费基线，不是日志**：flush 用它算差值（`new - old`）。删掉一个仍会上报的会话的行 = 下次上报把整段累计值重新计费。无外键；0012：fillfactor 80（计费 UPDATE 走 HOT，**不要**给计数列或 `updated_at` 建索引）；删除节点时保留，由 `traffic::retention_pass`（0013）清理可证明已死的行 |

**保留策略须知**：任何清理任务只能删除**可证明已死**的会话行（该 agent 已换新 session 且旧 session 不可能再上报，例如节点已删除，或 `updated_at` 远早于该节点当前 session 首次出现且超过安全窗口）；不确定就不删。

已知缺口（见 REVIEW）：`role`/`status` 为自由文本，无 CHECK 约束。
