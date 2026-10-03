# akari-panel/proto — 控制协议正本

`agent.proto`（package `akari.v1`）是面板↔agent 的**唯一**契约正本；akari-agent 保存 vendor 副本。

改契约流程：
1. 只在这里改，保持 proto3 向后兼容（新增字段用新编号，不复用、不改类型）。
2. `cargo build`（build.rs 用 protox 重新生成 Rust 绑定）。
3. `make -C ../akari-agent sync-proto`（拷贝 + `buf generate`），再 `check-proto` 确认无漂移。
4. 两侧代码一起改，跑 `make smoke`。

agent 仓库的 `make sync-proto`/`check-proto` 写死 `../akari-panel`；在 worktree 里要手工 `cp` + `buf generate proto` + `diff`。
`state_hash_vectors.json` 与 `update_vector.json` 也要同步到 agent 的 `proto/`（两边测试都读本地副本）。

**协议能力清单 `protocols.toml`（W26，R41）**：协议/传输/安全层、字段、合法组合（规则）、每用户凭据形状、各订阅格式支持、端到端场景的**唯一数据源**；名称内核无关（内核专有字段名只在适配器里），`wire` = 契约里的协议名（冻结）。面板：build.rs 解析并校验（坏清单 = 编译失败，`src/protocols/manifest_def.rs` 与 crate 共用），生成 `protocols::manifest`（构造代码 + const 表）；`make gen-protocols` 重写生成物（DEPLOY §3d 矩阵），`make check-generated`/`cargo test` 在过期时失败。agent：`make sync-proto` 一并拷贝，`check-proto` 逐字节比对（与 agent.proto 同样面板先行）。改清单 = 改行为：先跑 `src/protocols/manifest_tests.rs`（清单与面板校验/订阅逐组合一致）。

语义要点（完整定义见 proto 注释）：
- `TrafficReport.session_id` 是计费键（与计数原子读取）；Hello 的 session 仅供展示/日志。
- `Hello.protocol_version`：当前 6（= agent 自己用 ACME 申请/续期节点证书：`ConfigSnapshot.acme`（AcmeConfig：domain、directory_url（空 = Let's Encrypt）、email），`Heartbeat.cert`（CertStatus：state PENDING/VALID/FAILED、not_after、next_attempt、last_error ≤512 字节、error_kind DNS/CONNECTION/RATE_LIMITED/PORT_BUSY/CAA/REJECTED/CA_UNREACHABLE、challenge、failures），W10；acme 不进 state hash（改域名 bump config_version → Snapshot）；**字段号分段**：W10 用既有消息的 10–19，W11 用 20–49）；5 = SS2022 墓碑删除；4 = 执行 `UserOp.speed_limit_bytes_per_sec` 每用户限速，W7；3 = 自更新；2 = 会用 `AgentChannel.Renew` 续期证书）；1 = 不续期，面板照常服务（NodeView 在证书 14 天内到期时警告）；旧 agent 不发 = 0。面板 `MIN_AGENT_PROTOCOL` 以下给空状态并标记，不拒绝连接。**先升级 agent 再升级面板**；改协议语义时加版本号并更新两侧常量。
- `UserOp.speed_limit_bytes_per_sec`（协议 4）：每用户、上下行各自、该用户在本节点所有连接共享，0 = 不限；**不进** state hash（持有版本即带该版本的限速，应用不会单独失败），面板会话记录每用户限速（`SetDigest.limits`），所以只改限速也是一次 UserDelta（不算掉凭据）（ADD 原凭据 + 新限速，连接保留；从无到有会断开该用户的活连接以便限速生效）。
- `ConfigSnapshot` 是完整期望状态；`UserDelta` 带 base/target：持有 == base 才应用，持有 == target 按 no-op ack，其余 `BASE_MISMATCH`；delta 不改 config_version。`UserOp.ADD` = REPLACE（恰好列出的 inbound，旧/轮换凭据的活连接被断开）。
- `Ack.reason`（OK / APPLY_FAILED / BASE_MISMATCH）+ `held_*`（处理后 agent 实际持有）+ `state_hash`。
- State hash v2：SHA-256，`"akari-state-v2\n"` + u64be(config_version) + 按 (user_id, tag) 字节序的长度前缀四元组 + u32be(32)‖SHA-256(inbounds_json 原文，无实例时 "")；account_json **原样**参与（面板用 serde_json 紧凑+键排序输出，agent 不重新序列化）。向量由 `testdata/gen_vectors.py`（独立 Python 参考实现）生成，改算法先改它再重生成、同步到 agent。
- `LeaseGrant.remove_mode`（`RemoveMode` GATE/REBUILD）：REBUILD 时删除/轮换走 Snapshot，agent 拒收此类 delta。
- `LeaseGrant`：面板读库成功后才发；agent 用 CLOCK_BOOTTIME、0=24h、≥1h、只接受当前流；到期拆 xray、持有版本归 (0,0)、最终计数留待重连上报。`Heartbeat.lease_remaining_seconds` 未武装时不设置。
- gRPC 方法名不可叫 `Connect`（与 tonic 客户端构造函数撞名）。
- **自更新（协议 3，M6）**：`UpdateOffer{rollout_id, manifest（签名字节原样）, signatures, panel_protocol}` → agent 用**编译进来的**公钥验签 + 平台/单调版本（或签名 rollback）/未回滚过/`min_panel_protocol` → `UpdateStatus`（REJECTED/DOWNLOADING/FAILED/RESTARTING/ROLLED_BACK/CONFIRMED）；制品经 `AgentChannel.FetchArtifact(sha256, offset)` 流式下载（需客户端证书）。签名 = Ed25519("akari-agent-manifest-v1\n" ‖ manifest)，key id = SHA-256(pub)[:8] hex；共享向量 `update_vector.json`（agent 侧 `proto/update_vector.json`，由 akari-sign 生成，两边测试都读）。协议 1/2 的 agent 永不收到 offer。
- **TLS 与两个服务（M1c）**：客户端证书在 TLS 层可选；`AgentEnrollment.Enroll(token, CSR)` 是唯一无证书可调用的方法（agent 仍用 bootstrap 里的 CA 校验服务端）；`AgentChannel` 每个方法都必须有已验证客户端证书。CSR：ECDSA P-256 + ecdsa-with-SHA256、零 attribute/扩展（无 SAN），subject 忽略。所有 token 问题 = PERMISSION_DENIED "enrollment refused"；坏 CSR = INVALID_ARGUMENT（token 不消耗）；限速 = RESOURCE_EXHAUSTED。`Renew(CSR 新密钥)`：面板记录新序列号，调用证书在新证书首次被看到前一直有效（之后墓碑），没收到回复的 agent 用旧证书重试即可（未见过的那张被墓碑）。agent 只在用新证书的流上收到第一条面板消息后才把它提升为当前身份。
- `Heartbeat.connections` = gate 跟踪的分发数，`uptime_seconds` = agent 进程运行秒数。
- **W11（字段号 20–49 段；W10 用 10–19）**：`Hello.capabilities`（repeated string，与 `protocol_version` 无关的可选能力：`metrics` = 填 `Heartbeat.metrics`（`NodeMetrics`），`latency` = 接受 `PanelDown.latency_probe`（`LatencyProbeConfig`：间隔/URL/超时/次数/`run_token`）并回 `AgentUp.latency`（`LatencyReport`））。面板只给声明了 `latency` 的 agent 发 `LatencyProbeConfig`；旧 agent 不受影响（不 bump 协议号，避免与并行工作争用版本号）。`run_token` 非零且与上次不同才立即测（进程启动后见到的第一个只记录）。`NodeMetrics` 读不到的值：W23 起数值字段为 proto3 `optional`（与原隐式字段线格式相同），带能力 `metrics-presence` 的 agent 读不到就不设置（未设置 = 未知，读到 0 也会显式设置）；无该能力的旧 agent 未设置 = 0（W11 语义）；`Heartbeat.cpu_percent/mem_*` 同理。速率是距上一心跳的平均值（首个心跳、计数回绕、换网卡时不设置）。能力 `stale-units`（W23，状态标志）= 节点上已安装的 systemd 单元与该 agent 版本自带的不同（面板提示重装命令）。改字段存在性（隐式 ↔ optional）是唯一允许的"改字段"，因为线格式不变。
