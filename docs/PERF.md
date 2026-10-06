# Performance and scale（性能与规模，M2）

目标（ROADMAP §0）在单个面板实例的数据集上测得：200 个节点 / 5 万用户 / 每节点 1 万用户（200 万行 `node_users`——W28-a 起为 `entrance_users`，每个用户每个入口一行；另有 200 万行 `traffic_counters`）。以下全部结果都可用 `bench/` 复现。

## Results against the targets（对照目标的结果）

| 目标 | 实测 | 结论 |
|---|---|---|
| 1 万用户节点的快照构建 < 200 ms | 数据库读取 + 构建 33 ms；完整构建（读取 + 用户集 + 状态哈希 + 编码）43 ms；agent 侧：1 万用户的 xray 重建 57 ms | 通过 |
| 5 万行流量的 flush < 1 s | 0.91 s（criterion 均值；10 块，每块 5000 行，约 91 ms/块）；W11 0.49 s；W22（含流量历史）0.58 s，见 "W22" | 通过，余量约 40% |
| 管理 API p99 < 50 ms | 节点 top 用户（`traffic_node`）查询 36–48 → 约 10 ms（0151 覆盖索引），见 "Node top users"；W21：`dashboard` 16–21 ms，`users_search` 7–31 ms，`users_filtered` 18–22 ms（一次噪声运行 55 ms）；空闲、16 客户端：最差端点 10.2 ms（`nodes`）；200 agent 负载下：最差读 30.5 ms（`users_deep`）；W17：控制台节点列表（`nodes?view=summary`）负载下 12–26 ms（完整列表 27–43 ms） | 通过 |
| 订阅 p99 < 30 ms | 空闲 5.1 ms；负载下 16.7 ms（单实例），经双实例负载均衡器 31 ms（`clash`）/ 20 ms（`links`） | 通过（单实例）；均衡器那次超 1 ms，见注 |
| 用户变更到 agent < 2 s | 单实例：p50 0.26 s，p99 0.59 s，max 0.68 s；负载均衡器后双实例：p99 0.89 s，max 0.98 s（各 3200 次 agent 应用） | 通过 |
| 计费精确 | 单实例和双实例的每次稳态运行中，上报量 = 计费量，精确到字节 | 通过 |
| 负载均衡器后的双实例通过跨实例检查 | `akari-bench multi`：全部通过 | 通过 |

注：

- 压测生成器、面板、PostgreSQL 和 Valkey 共用一台机器，期间还有其他任务在跑，所以每个延迟都含客户端 CPU 争用。请视为上界。
- 均衡器那次的 31 ms 是 `clash` 的 p99：200 个 agent 在上报、80 次变更在传播，且经过同机的用户态 TCP 均衡器；同样负载下单实例为 16.7 ms。
- 饱和下的写入：16 个并发 `PATCH /users/{id}` 客户端打向繁忙的面板，p99 达 55 ms（每次 patch 要锁定该用户约 40 个节点，并排在 flush 块及其他并发请求之后）；2 个并发客户端：p99 14 ms。这不是管理员的真实速率（该次为 2400 次 patch/秒），仅为完整起见记录。

## Review 2026-10-02 panel fixes (W3/W4/W5, 2026-10-03)（评审后的面板修复）

Criterion，`make bench` 的 `pure`/`db`/`buffer` 组，同一台机器上修复前后对比（4 vCPU 云容器，bench 栈在 Docker 中；未改动代码在 1k 用户下的噪声可达 ±15%，所以只有大幅变化才算数）：

| bench | 之前 | 之后 | |
|---|---|---|---|
| `pure/digest_and_diff/1_changed/10000`（期望摘要 + 增量 diff，即会话每次增量的开销） | 9.20 ms | 5.36 ms | −42%（W4：diff 复用期望摘要；对两份摘要做合并，不再逐用户 SHA-256） |
| `pure/digest_and_diff/10pct_changed/10000` | 10.04 ms | 6.04 ms | −40% |
| `pure/set_digest_ss/1000`（Shadowsocks 节点，40 KB inbounds） | 967 µs | 884 µs | −10%（W5：不再复制小写副本、不再克隆树） |
| `pure/set_digest_ss/10000` | 5.72 ms | 5.70 ms | ±0（用户摘要占主导） |
| `buffer/update/10k_rows`（写入 200 万条目的缓冲区） | 4.67 ms | 4.64 ms | ±0（W3：每行 2 次堆分配 → 0；耗时在 DashMap + UUID 解析） |
| `db/snapshot_build_full/10000`、`db/flush/50000` | 82.4 ms、1.07 s | 82.8 ms、1.09 s | 不变（未触及） |

W4 的后半部分（用借用的 `UserSet` 取代每次读取的拷贝）没有做：`UserSet`/`NodeState` 是公开 API，`bench/src/swarm.rs` 长期持有它们，约 35 个会话测试也直接构造它们。`akari_sync_message_bytes`（C3）现在可在生产中看到编码后的 Snapshot/UserDelta 大小。

## W22: traffic history (2026-10-03)（流量历史）

flush 现在还会按用户、节点和 UTC 日记录它结算了什么。设计由 flush 预算驱动：

| `db/flush`，5 万行（bench 数据集 + 30 天历史：300 万行 `traffic_daily`） | 耗时 |
|---|---|
| W22 之前的 main（同一次运行、同一数据库） | 0.490 s（全新种子）；A/B 交替：0.515 / 0.547 / 0.635 s |
| 初版：`FLUSH_SQL` 直接 upsert `traffic_daily` + `traffic_node_daily`（`ON CONFLICT`） | 1.29 s（超出预算） |
| 同上，已有的日行改用普通 `UPDATE`（仅新行用 `ON CONFLICT`，与 `traffic_counters` 相同） | 0.81 s |
| **已上线**：`FLUSH_SQL` 追加到无索引的暂存表（`traffic_daily_pending`），reaper 每 30 s 合并一次 | A/B 交替：0.576 / 0.581 / 0.630 s |

所以历史让 flush 多花约 10–15%（每个计费行多一次堆插入，无索引、无冲突检查），且每行与结算写在同一条语句里（幂等性完全一样）。直接更新日行的开销与 `traffic_counters` 更新本身相当（每 5000 行一块约 27 ms，见 `akari-bench explain`），这就是它不放在 flush 路径上的原因。

压缩（`traffic::COMPACT_SQL`，每 5 万条暂存行一条语句：`DELETE ... RETURNING` → 聚合 → `UPDATE` 已有日行 → `INSERT` 新行 → 按节点日 upsert）：`db/compact/50000` = 0.25–0.29 s，相当于一次 flush 的量（5 万个不同的用户-节点对）。按 30 s 的节奏，繁忙面板每轮暂存约 6 次 flush，但它们会合并进同样的 5 万个日行，所以每 30 s 一轮远低于 1 秒；该过程持有 advisory try-lock（同一时刻只有一个实例），不持有任何节点锁或用户锁。

读取侧（`akari-bench http`，面板运行在 bench 数据集 + 30 天历史上，每用户每天 2 个节点 = 300 万日行，30 天内每节点约 7.9k 个不同用户；默认 30 天范围）：

| 场景 | 4 客户端 p99 | 8 客户端 p99 | 16 客户端 p99 |
|---|---|---|---|
| `traffic_user`（`/users/{id}/traffic`，按天） | 2.1 ms | 5.6 ms | 15.0 ms |
| `traffic_user_nodes`（`group=node`） | — | — | 14.4 ms |
| `traffic_node`（`/nodes/{id}/traffic`，按天 + top 20 用户） | 10.4 ms | 11.0 ms | 55.4 ms |
| `traffic_summary`（`/traffic/summary`） | 3.5 ms | 8.8 ms | 20.3 ms |
| `traffic_me`（`/me/traffic`） | 2.3 ms | 7.9 ms | 5.2 ms |

`traffic_node` 每个请求聚合约 1.5 万个日行（每次约 10 ms CPU）：16 个并发客户端会让机器核心饱和（770 req/s），此时的 p99 是排队造成的，而不是查询本身；8 个并发的管理员节点页仍保持在 11 ms。节点和全局图表读取 `traffic_node_daily`（每节点每天一行）；只有 top 用户列表会访问 `traffic_daily`（索引 `(node_id, day)`；自 0151 起为覆盖索引，见 "Node top users"）。

复现：`make bench-seed`（现在还会写入 `--history-days 30
--history-nodes-per-user 2`）、`make bench`，然后在 bench 数据集上启动面板并运行 `akari-bench http --only traffic_user,traffic_user_nodes,traffic_node,traffic_summary,traffic_me`；
`akari-bench explain` 包含 `COMPACT_SQL` 和 `ROLLUP_SQL`。

## Node top users (2026-10-03)（节点 top 用户）

`GET /nodes/{id}/traffic`（管理端节点页：按天 + top 20 用户）是 W22 中最慢的读取（`traffic_node`，16 客户端下 p99 55.4 ms）。在 bench 数据集（30 天历史、最繁忙节点、30 天范围）上对 `trafficlog::node_top_users` 做 `EXPLAIN (ANALYZE, BUFFERS)`：约 8k 个用户的 1.55 万个 `traffic_daily` 行来自一次位图堆扫描，涉及 **8.8k 个堆页**（表按主键聚簇，user 在前），然后是哈希聚合：每次查询 36–48 ms。迁移 0151 把 `traffic_daily_node (node_id, day)` 替换为 `traffic_daily_node_cov (node_id, day) INCLUDE (user_id, up_bytes, down_bytes, billed_bytes)`：变成仅索引扫描，226 个缓冲区、0 次堆读取，每次查询 **约 10 ms**（现在大部分时间在哈希聚合）。查询文本不变。

在本次运行的机器上测得（4 vCPU 云容器；bench 栈在 Docker 中；压测生成器、面板和 PostgreSQL 在同一批核心上），`akari-bench http --only traffic_node`，每轮 10 s：

| | 4 客户端 p99 | 8 客户端 p99 | 16 客户端 p99（3 次） | 16 客户端 req/s |
|---|---|---|---|---|
| 之前（main） | 52.8 ms | 98.3 ms | 247 / 178 / 172 ms | 142–149 |
| 之后（0151） | 32.2 ms | 56.4 ms | 122 / 115 / 104 ms | 265–281 |

单核吞吐几乎翻倍。这台机器在 16 个闭环客户端下 4 核即饱和（单客户端：p50 13 ms），所以它的 16 客户端 p99 是排队；W22 的数字（770 req/s 下 55.4 ms）来自一台快约 5 倍的机器，在那里同样的单请求成本下降应使 16 客户端 p99 远低于 50 ms——**但没有在那里重新测量**（依赖该结论前，请在参考机器上重跑上面的命令）。一个两步方案（用 `float8` 求和排名，仅对 top 20 做精确的 `numeric` 求和）还能再省约 18% 查询时间，但不值得多一次查询。

代价：计数器现在有了索引，所以压缩时对日行做的累加式 `UPDATE` 不再是 HOT（每次还要写主键和覆盖索引）。`make bench`，同一台机器：`db/compact/50000`（合并 5 万个不同的用户-节点对）**0.43 s → 0.94 s**，每 30 s 一次，在历史 try-lock 之下，不在计费路径上；`db/flush/50000` 1.01 s（不变：flush 只向暂存表追加；此前在这台机器上的运行记录为 1.07–1.09 s）。

复现：`make bench-seed`，在 bench 数据集上启动面板（`akari -c bench/panel-bench-1.toml serve`，迁移会应用 0151），`akari-bench http --only traffic_node --concurrency 16 --seconds 10`；
`CARGO_TARGET_DIR=target cargo bench --manifest-path bench/Cargo.toml --bench panel -- db/compact`。

## Admin dashboard and user search (W21, 2026-10-03)（管理端仪表盘与用户搜索）

`GET /dashboard`（src/dashboard.rs）是在 REPEATABLE READ 快照中的一次聚合读取；`GET
/users` 新增了搜索（`q`，登录名/邮箱前缀）、过滤（`status`、`plan_id`、`role`）、排序和 `total`。在 bench 栈上测得（独立数据库 `akari_bench_w21`：`make bench-seed` = 200 节点、5 万用户、200 万 node_users（现为 `entrance_users`）、20 万条审计行；另用 SQL 插入分布在一年内的 20 万笔已支付订单（2% 已退款）和 1 万笔已过期订单），`akari-bench http` 16 个闭环客户端 × 10 s，面板空闲（无 agent），三次运行，同时另一个 worker 的 e2e 在同一台机器上运行：

| 场景 | p50 | p99（第 1 / 2 / 3 次） | req/s |
|---|---|---|---|
| `dashboard` | 10.8–11.8 ms | 20.6 / 16.8 / 15.7 ms | 1286–1439 |
| `users_search`（`q=bench-user-123`，约 100 个匹配 + total） | 4.6–5.0 ms | 30.8 / 6.6 / 8.2 ms | 2413–3413 |
| `users_filtered`（`status=active&role=user&sort=-traffic`） | 12.7–14.1 ms | 22.3 / 55.2 / 18.4 ms | 935–1219 |
| `users_page1`（对照） | 6.0–6.5 ms | 11.6 / 9.7 / 9.5 ms | 2336–2561 |

仪表盘的第一版 p99 为 45–139 ms：对 users 做了两次独立扫描（注册窗口和总数），并为 1.65 万个收入行做堆读取。现在用户只扫一遍，收入/退款窗口改为仅索引扫描（`orders_paid_at` / `orders_refunded_at` INCLUDE 了金额，0125）。users 表的那一遍（5 万行下约 5–10 ms）是该端点的下限；`users_filtered` 要按流量对所有匹配用户排序（`traffic_used_bytes` 必须保持无索引：计费更新是 HOT，0012），它那次噪声运行来自并发的 e2e。复现：

```bash
BENCH_DATABASE_URL=postgres://akari:akari-dev@localhost:5433/akari_bench_w21 make bench-seed
# orders: see the W21 PR (INSERT … generate_series(1, 200000), then VACUUM ANALYZE orders)
akari -c <panel.toml on akari_bench_w21> serve &
akari-bench http --data-dir <its data dir> --url <its url> --only dashboard,users_search,users_filtered,users_page1
```

## Node list summary view (W17, 2026-10-02)（节点列表摘要视图）

W14 时 `GET /nodes` 在 200 个 agent 上报下处于临界（p99 47–55 ms，响应体 480 KB）。W17 新增 `GET /nodes?view=summary`——只含列表所需的列：没有 inbound JSON，没有完整延迟集合（只留最佳 agent 结果），心跳裁剪为 CPU/内存/连接数/速率/在线用户，不含逐秒变化的 `lease_remaining_seconds`——并且两种视图都带强 ETag（`If-None-Match` → 空 304）。控制台的列表、套餐编辑器和发布表单中的节点选择器都读它；节点页读取 `GET /nodes/{id}`。

机器和方法与 W14 相同（bench 栈，`make bench-seed` 写入独立数据库 `akari_bench_w17`，已设置 系统设置 主域名，200 个 swarm agent × 1 万用户，心跳带 W11 机器指标，`http` 16 个闭环客户端在 150 s 的 swarm 中从第 80 s 起跑 80 s，其间有 40 次定时变更）。`nodes_etag` 模拟浏览器：每个请求都带上一次的 ETag（无变化时返回 304）。三次负载运行：

| 场景 | 空闲 p99 | 200 agent p99（第 1 / 2 / 3 次） | 负载下 req/s | 负载下响应体 |
|---|---|---|---|---|
| `nodes`（完整） | 12.1 ms | 43.3 / 29.6 / 26.7 ms | 759–827 | 480 KB |
| `nodes_summary` | 10.2 ms | 26.2 / 12.8 / 11.9 ms | 1612–1929 | 180 KB |
| `nodes_etag`（重新验证） | 9.9 ms | 25.5 / 11.9 / 11.5 ms | 1661–2025 | 0（304）或 180 KB |
| `users_deep`（对照） | — | 37.4 / 16.1 / 15.7 ms | 1796–2155 | — |

结论：控制台列表现在以很大余量满足管理端目标（负载下最差 p99 26 ms，目标 50 ms；第 1 次运行对所有场景都更嘈杂，包括 `users_deep`）。列表吞吐翻倍（480 KB 的序列化曾是上限）。重新验证的请求仍要构建响应体来计算哈希（没有服务端缓存：心跳数据每 15 s 变化），所以它的收益是线上字节数和浏览器解析，而不是服务器时间。同样几次运行中计费保持精确，变更到 agent 的 p99 为 0.76 s。

## Re-verification 2026-10-02 (W14, after W5/W7/W9/W11/W12)（复验）

机器和方法与下文相同（bench 栈、`make bench-seed`、200 个 swarm agent × 1 万用户、`http` 16 个闭环客户端，负载下的 `http` 运行在 150 s swarm 的第 80 s 开始，含 40 次定时变更）。M2 以来负载中的新增项：系统设置 Host 闸门已生效（`panel_settings` 中设了主域名），每个 swarm 心跳都带 W11 机器指标（`node_metrics_1m` 的 upsert），用户集读取 LEFT JOIN 套餐限速（W7），节点列表带心跳/延迟/分组/发布字段。宿主机说明：15 GiB 内存与其他任务共用，swarm 运行期间 swap 已满，所以所有负载下的数字都是上界。

| §0 目标 | M2（下方 PERF） | W14 首次运行 | W14 修复后 | 结论 |
|---|---|---|---|---|
| 1 万用户快照构建 < 200 ms | 33 / 43 ms | `db/desired_snapshot` 42.6 ms，`db/snapshot_build_full` 52.6 ms | （不变） | 通过（W7 的 join + 新字段：+10 ms） |
| flush 5 万行 < 1 s | 0.91 s（M2），0.49 s（W11） | 0.477 s | （不变） | 通过，余量 52% |
| 管理 API p99 < 50 ms，空闲 | 最差读 10.2 ms（`nodes`） | `nodes` 20.1 ms；最差写 `user_patch` 24.5 ms | `nodes` 12.6 ms；`user_patch` 23.3 ms | 通过 |
| 管理 API p99 < 50 ms，200 agent | 最差读 30.5 ms（`users_deep`） | `nodes` 58.2 / 61.3 ms | `nodes` 47–55 ms（4 次运行：49.9、54.6、47.5、49.3），`users_deep` 35.8 ms | **临界**（`nodes`，见下） |
| 订阅 p99 < 30 ms | 空闲 5.1 / 负载 16.7 / 均衡器 31 | 5.5 / 15.4 | 空闲 5.3 / 负载 16.4–17.0 / 均衡器 28.0（`clash`）、11.2（`links`） | 通过 |
| 用户变更 → agent < 2 s | p99 0.59 s，max 0.68 s | **p99 1.86 s，max 2.01 s** | p99 0.75 s，max 0.96 s（均衡器：p99 0.55 s，max 0.79 s） | 修复后通过 |
| 计费精确 | 精确 | 精确 | 精确（每次运行，单实例和双实例） | 通过 |
| `akari-bench multi` | 全部通过 | — | 全部通过 | 通过 |

**Fix 1 — change-to-agent tail (grpc.rs)（变更到 agent 的长尾）。** 每个会话每 60 s 做一次 reconcile tick，重新读取其节点的完整期望状态，而 tick 的相位就是会话启动时间，所以一同连上的 agent（面板重启后的全部 agent，以及 swarm）会同步 reconcile：约 200 次 1 万用户的读取每分钟一次挤在 8 个读许可上排队，落在这一波里的变更要排在它们后面（无 HTTP 负载时最长 1.36 s，有负载时 2.01 s）。现在 tick 的相位对每个会话随机；周期、租约续期和通知路径不变。

**Fix 2 — node list query (api.rs)（节点列表查询）。** `NODE_VIEW_COLS` 对每个节点跑五个相关子查询（enrollment、groups、latency、rollout、限速检查）；其中四个现在改为与各表聚合做 join（`NODE_VIEW_FROM`）：PostgreSQL 中 200 个节点 4.4 → 2.6 ms（单节点 0.65 → 0.85 ms），心跳 blob 以校验过的原始 JSON 透传，不再解析成 `Value` 再重新序列化。空闲时 `nodes` p99 20.1 → 12.6 ms（1157 → 1865 req/s）。

**Remaining: `GET /nodes` under 200 reporting agents（遗留：200 个 agent 上报下的 `GET /nodes`）。** swarm 连上后，列表为 480 KB（每个节点：inbounds JSON、延迟，以及带机器指标的完整 W11 心跳），16 个客户端连续请求时在约 670 req/s 饱和；p99 落在 47–55 ms，正好卡在 50 ms 线附近。这是闭环的吞吐上限，不是慢查询：4 个客户端时同样负载下 p99 为 34 ms，而一个管理控制台每隔几秒才轮询一次。真正的解法是更瘦的列表（机器指标和 inbound JSON 只在节点页给出，或分页），属于 UI 改动，留待后续。饱和下的写入（`user_patch`，16 客户端约 530/s）与 M2 的记录一致：不是管理员的真实速率（p99 130–200 ms，每次 patch 都要锁定用户约 40 个节点，并排在 flush 块之后）。

Criterion（同一次运行）：`user_set` 3.34 ms，`state_hash` 1.12 ms，`diff_user_sets` 1.50 / 1.67 ms，
`snapshot_encode` 0.40 ms，`sub_render` 200 节点 clash/links/sing-box 0.60 / 0.63 / 1.26 ms，
`buffer/snapshot` 22 ms，`buffer/prune_idle` 33 ms，`buffer/prune_full` 0.60 s。

## Machine and stack（机器与软件栈）

- Intel Core Ultra 7 265K（20 线程），15 GiB 内存，WSL2（Linux 6.18）。
- PostgreSQL 18（docker，`bench/compose.yml`）：`shared_buffers=2GB`，
  `effective_cache_size=6GB`，`work_mem=16MB`，`max_wal_size=4GB`。原版
  `postgres:18`（128 MB shared buffers）装不下 200 万行的工作集；
  DEPLOY.md 建议按此规模配置 PostgreSQL。
- Valkey 9，面板 release 构建（与发布版相同的静态 feature，mimalloc），
  `pool max_connections = 16`。
- Agent：`akari-bench swarm` 使用真实的 mTLS gRPC 协议（enrollment、
  Hello、Snapshot/UserDelta、Ack、流量上报、心跳）；它的 agent 都在一个进程里，
  因此所有计时用同一个时钟。

## Methodology and reproduction（方法与复现）

压测 crate 位于 `bench/`（独立的 workspace 和 lockfile，不在面板的依赖图中，也绝不进入 release 二进制）。

```bash
make bench-up                    # dedicated PostgreSQL :5433 / Valkey :6380 (bench/compose.yml)
make bench-seed                  # 200 nodes, 50k users, 10k per node: ~2 min
                                 # (akari-bench seed --layout scattered --plans true: production-like heap order and plans)
akari-bench explain              # EXPLAIN (ANALYZE, BUFFERS) of every hot query, rolled back
make bench                       # criterion: pure CPU + DB benches (snapshot, flush)
akari -c bench/panel-bench-1.toml serve &                 # lifted rate limits, metrics on :19100
akari-bench http --concurrency 16 --seconds 10            # closed-loop HTTP latency (hdrhistogram)
akari-bench swarm --seconds 150 --changes 40 --report-all false
                                 # 200 fake agents x 10k users, 10 s traffic reports,
                                 # 2.5% of users with new traffic per report, 40 timed changes
                                 # (disable + re-enable = 80 propagations); prints convergence,
                                 # change-to-agent latency, billing exactness, final convergence
```

`swarm` 说明：变更到 agent 的延迟 = 从发出 PATCH 起，到指名该用户的 op 到达每个为其服务的 agent 为止。负载下的数字，`http` 运行在 swarm 运行开始后 80 s 才启动（flush 积压已清空，agent 已稳定）。`swarm` 临时禁用的那个用户可能导致一次订阅请求失败（404），`http` 会把它算作错误（约 2.8 万次中一次）。

双实例：`panel-bench-2.toml` + `akari-bench lb`（对 web 和 gRPC 做轮询的 TCP 均衡器，TLS 不动，所以 mTLS 身份与没有均衡器时一样到达面板），swarm 和 http 经均衡器运行，然后运行 `akari-bench multi`。

CI：`.github/workflows/bench.yml`（手动）在已灌入种子的数据集上运行 criterion 套件并上传 `target/criterion`。共享 runner 噪声大：只用来看趋势（`--save-baseline` / `critcmp`），不用来对照绝对目标。ci.yml 中的 `bench-lint` 保证该 crate 能持续针对面板库编译通过。

## Microbenchmarks (criterion, 10k users per node unless noted)（微基准）

| Bench | 耗时 |
|---|---|
| `user_set`（由 ops 构建用户集） | 3.3 ms |
| `state_hash` | 1.1 ms |
| `diff_user_sets`（1 个变更 / 10% 变更） | 1.9 / 2.1 ms |
| `snapshot_encode`（protobuf） | 0.54 ms |
| `sub_render` clash / links / sing-box，1 个节点 | 5.2 / 5.5 / 8.2 us |
| `sub_render` clash / links / sing-box，40 个节点 | 90 / 108 / 199 us |
| `sub_render` clash / links / sing-box，200 个节点 | 428 / 498 / 986 us |
| `db/desired_snapshot`（REPEATABLE READ 读取 + 构建） | 33.3 ms |
| `db/snapshot_build_full` | 43.1 ms |
| `db/flush`，5 万行 | 0.907 s（M2）→ **0.49 s**（W11，见下）→ 0.58 s（W22，暂存流量历史；见 "W22"） |
| `db/compact`，5 万条暂存行（W22，不在 flush 路径上） | 0.25–0.29 s |

## What changed to get there（做了哪些改动）

- Flush SQL：去掉了 O(行数 × 节点数) 的 join；已有的计数器行用普通 `UPDATE`（每行一次索引探测，`ON CONFLICT` 只裁决新行）；更新过的行直接从 `UPDATE ... RETURNING` 带出它们的节点/会话列，不再重新 join；已离开的用户-节点对的窗口聚合只对已离开的行运行；会话墓碑只为尚未登记的会话插入；所有行都已存在时跳过空操作的 insert 阶段。1.37 s -> 0.91 s。
- 分块 flush：每个事务 5000 行，节点 id 从大到小。每块持有其节点和用户的行锁约 100 ms，所以即使重启使所有 agent 重新上报数百万行，管理员写入和变更传播最多也只等一块。对计费安全：每行都是幂等的，每个上限（每节点 GCRA、已离开的用户-节点对）都是跨事务累计的。
- 每会话的用户集保存为紧凑摘要（200 × 1 万的运行曾因此内存耗尽）；读许可限制完整用户集的加载并发。
- `mimalloc` 作为全局分配器（发布的二进制是静态 musl；它的分配器会把这种分配密集的负载串行化）。
- 迁移 0012：为用户列表建 `users(created_at, id)`（延迟 join 分页：第 1 页 0.2 ms，offset 49000 为 3.6 ms），`users` 和 `traffic_counters` 的 fillfactor 设为 85/80，使计费更新为 HOT。不要给 `traffic_counters.updated_at` 或计数器建索引：否则每次计费更新都不再是 HOT。
- 审计过滤（actor、action 前缀）走各自的 `(column, id)` 索引。
- 用户在节点之后按 id 顺序加锁（全局锁顺序），这样两个实例 flush 共享用户的节点时不会死锁。

## W4-A9: flush-tick buffer maintenance (`make bench`, group `buffer`)（flush tick 的缓冲区维护）

5 s 的 flush tick 过去每次都要运行 `TrafficBuffer::prune`（空闲淘汰 + 完整重建每节点索引）和 `snapshot`（完整遍历 `entries`）。纯 CPU，200 节点 × 1 万用户 = 200 万条目，2.5% 为脏（criterion，机器同上；`prune` 噪声大，因为它要分配 200 万个集合条目）：

| 操作 | 之前（每 5 s） | 之后 |
|---|---|---|
| `snapshot`（要 flush 什么） | 64 ms（遍历全部 200 万条目） | 27-30 ms（只遍历每会话的脏集合：开销随脏行数而变） |
| `prune` | 1.1-3.5 s（均值约 2.2 s），持有分片写锁 | `prune_idle` 每 60 s 46 ms；完整索引重建（自愈）每 15 分钟 0.87-0.98 s |

折算到每 5 s 一个 tick，之前约 2.2 s CPU（原因是要完整重建 200 万条目的索引），之后约 30 ms 加摊销的 4 ms。空闲淘汰的效果不受影响（条目要 10 分钟后才可被淘汰）。索引通过增量保持精确；周期性重建只是自愈。

## EXPLAIN highlights (`akari-bench explain`, rolled back)（EXPLAIN 要点）

每个热点查询要么由索引驱动，要么是对有界集合的一次扫描；工具输出里的 `seq_scans` 计数都是极小的表（nodes、sessions、空的 `node_users_departed`）。

| 查询 | 执行 |
|---|---|
| 1 万用户节点的 `desired_state` 用户 | 14 ms（join + 1 万行排序） |
| `refresh_members` | 1.8 ms |
| 强制执行候选（超限 / 过期） | 2.2 / 2.3 ms |
| `list_users` 第 1 页 / offset 49000 | 0.2 / 3.6 ms |
| `list_nodes`（200 个节点） | 1.3 ms |
| 审计列表：首页 / 深游标 / action 前缀 / actor | 0.04 / 0.04 / 0.22 / 0.06 ms |
| 订阅用户查找 / 节点列表 | 0.02 / 0.24 ms |
| 登录查找（不含密码哈希） | 0.2 ms |
| `AuthUser` 会话查询 | 0.03 ms |
| 保留：`RETIRE_SQL`（1 个节点）/ 死节点扫描 | 0.07 / 2.5 ms |
| `FLUSH_SQL`，5000 行：更新 / 全是新行 | 84 ms / 177 ms |

给一块计费每行约 17 us：节点成员探测 2 us，计数器更新 4 us，用户更新 5 us，其余是 numeric 上限运算和排序。新行（会话的首次上报）开销翻倍，所以每个 agent 都带着 1 万用户开新会话的重启风暴（200 万新行）大约要 70 s 才能排空；稳态上报只涉及约 2.5% 的行。

## M2-3: `AuthUser` per-request cost（每请求开销）

`AuthUser` 每个请求做一次带索引的查询（会话版本、enabled、过期、TOTP 状态）：服务器侧 0.03 ms；端到端实测约 0.4 ms，含连接池取连接和往返（`/me` 会执行两次：1.0 ms，对比单客户端 `/healthz` 的 0.11 ms）。16 连接的池每秒可承受数万次这样的查询，比管理流量高三个数量级，管理 API 的 p99 因此远低于目标。**没有加缓存**：当前的保证是，被撤销的会话（登出、改密码、禁用、改角色、`session_ver` 递增）在每个实例上都会在下一个请求就被拒绝（`akari-bench multi` 会断言这一点），而任何缓存都会把它变成"在 TTL 内"。如果将来需要，要写明的上界就是 TTL（<= 1 s）；没有跨实例失效机制可依赖，所以 TTL 就是最坏的撤销延迟。

## M2-4: multiple instances（多实例）

参考拓扑见 DEPLOY.md（"Several panel instances"）。`akari-bench multi` 的结果（实例 A 和 B 共用一个 PostgreSQL 和一个 Valkey）：

- 在 A 上登录的会话在 B 上有效；在 A 上登出会立刻在 B 上终止它。
- 在 A/B 之间交替的登录失败共用同一份预算（20 次失败，之后两边都返回 429）。
- 同一个 agent 身份先连 A 再连 B：B 提供服务；A 的流结束。A 在下一次数据库读取时（变更通知或 60 s reconcile tick）得知自己被取代，所以陈旧的流最多可滞留 60 s；计费是幂等的，因此无害。
- 通过 A 删除节点，而它的 agent 正连在 B：B 的 agent 在几毫秒内拿到空状态，reaper（任一实例）约 10 s 后删除该节点，流被关闭；之后用已吊销证书的连接会拿到空状态并被关闭。
- 经均衡器的 swarm（agent 分布在两个实例上）：收敛 2.0 s，计费精确，200/200 最终收敛，0 次 BASE_MISMATCH，两个实例都是 0 次 flush 失败。

内存：一个实例承载 200 个 agent × 1 万用户上报：稳态 0.55 GiB，峰值 1.5 GiB（200 个初始 snapshot，每个 2.3 MB，是一起构建的）。

## M2-5: `traffic_counters` retention（保留策略）

`traffic_counters` 是计费基线（`new - old`），所以只删除可证明已死的行（迁移 0013，`traffic::retention_pass`，由任一实例的 reaper 循环每 10 分钟运行，并发运行安全）：

1. 只有当会话所属节点拥有至少 1 小时前的排空证明时，会话才会被退役（在 `traffic_sessions` 中写墓碑，`FLUSH_SQL` 会遵守：已退役会话的迟到上报会被丢弃，绝不重复计费）：排空证明是一次 Hello，其流保持了 60 s 且携带 `finals_drained_session`，证明 agent 在那次 Hello 之前已交付它所取代的每个会话的最后一次上报；并且该会话不是 agent 当前的会话。
2. 已退役会话的行按 1 万行一批删除；已删除节点的行同理。存活会话的行无论多旧都不会被删除。

因此表大小的上界是（存活会话 + 最近一小时的会话 + 每节点一个）× 每节点用户数。在 bench 数据集上，多次 swarm 运行后实测（为演示把余量调为 0）：退役 1194 个会话，3.3 s 内删除约 100 万行，`traffic_counters` 从 370 万行降到 270 万行。

## M2-6: agent overhead (Go benchmarks, 10k users x 2 inbounds)（agent 开销）

akari-agent 中的 `make bench`（`bench_test.go`），同一台机器：

| 操作 | 耗时 | 分配 |
|---|---|---|
| Snapshot = 完整 xray 重建，1 万用户 | 56.5 ms | 54 MB，597k 次分配 |
| 运行中的 1 万用户实例占用的堆 | 18.8 MB（构建 + GC：98.8 ms） | |
| UserDelta 轮换 1 万用户中的 1 个 | 5.4 us | 59 |
| 流量上报（每个用户都有计数器） | 每 10 s 2.5 ms = 单核的 0.025% | 2.6 MB |
| 2 万个凭据的状态哈希（Hello、每次 Ack） | 7.6 ms | 9.9 MB |
| 每个被代理连接的 Gate admit + release | 249 ns（并行） | 2 |
| 5k 个存活 dispatch 时的心跳连接计数 | 每 15 s 24.7 us | 0 |

结论：在 1 万用户规模下，agent 循环里没有任何东西值得担心。值得了解的成本是 57 ms 的重建（会断开该节点上的所有连接，这就是存在增量的原因）和状态哈希每次 Ack 分配 10 MB。没有对 agent 做优化。

**W7 speed limits（限速）**（`ratelimit.go`，同样的基准）：不限速的用户永远不会被包装——它们唯一增加的开销，是 `admit` 内一次 map 查找，且在它本来就要取的锁之下；`BenchmarkGateAdmitRelease` 前后差异在运行间噪声之内（并行 263–500 ns vs 280–398 ns，2026-10-02，20 线程）。受限用户的 dispatch 每个缓冲区付出一次令牌桶预约：`BenchmarkLimitedWrite8k` 每个 8 KiB 块 129 ns（含缓冲区分配）（有 > 60 GB/s 的余量，3 次分配，其中 2 次是测试自己的缓冲区）。限速准确度（真实 xray，裸 VLESS）：512 KiB/s 下 768 KiB 用了 1.303 s，期望的上下行均为 1.300 s；Vision over TLS（splice 路径）1 MiB/s 下 3 MiB 用了 2.809 s，期望 2.800 s（`ratelimit_test.go`、`ratelimit_canary_test.go`）。

**W7 panel side（面板侧）**：`desired_state` 现在会为每个节点用户 LEFT JOIN 其生效套餐以获取限速：一个节点 1 万用户的用户集查询从 4.7 ms 变为 7.9 ms（EXPLAIN ANALYZE，开发环境 PG 18，2026-10-02），在约 43 ms 的快照构建上约 +3 ms。每用户摘要仅对受限用户多哈希 12 个字节。

**W11（流量倍率、节点总量；2026-10-02，同一台机器，在重新灌种的 bench 数据集上做 A/B 交替运行）：**

| `db/flush`，5 万行 | 耗时 |
|---|---|
| W11 之前的 main | 0.902 / 0.924 / 0.915 s |
| main + 仅 `nf AS MATERIALIZED` | 0.455 s |
| W11（`MATERIALIZED` + 倍率 `charged` CTE + 原始/计费节点总量） | 0.485 / 0.494 / 0.491 s |

倍率只多了一个 CTE（`charged`：把缩放后的行与按节点的 CTE `nf` 做哈希 join，floor(billed × permille / 1000)），以及 flush 本来就要执行的按节点 `UPDATE nodes` 多了两列（`traffic_raw_bytes`、`traffic_billed_bytes`）：约 +30 ms（6%）。`nf` 被引用两次，使 PostgreSQL 把它物化，而不是内联进 `classified`，这让语句耗时减半（内联形式会对每个输入行重新规划节点查找）；现在显式写成 `MATERIALIZED`，使执行计划不依赖该 CTE 被引用几次。净效果：0.91 s → 0.49 s，距 1 s 预算的余量约 51%。

**W11 machine-status history（机器状态历史）**：每个节点每次心跳向该节点当前分钟做一次 upsert（`node_metrics_1m`，求和 + 最大值，fillfactor 70 以支持 HOT 更新），限流为每节点每 5 s 一次，实例上已有 8 个写入在途时跳过。200 个节点、默认 15 s 的情况下约为每秒 13 次小 upsert；按小时的 rollup 每 10 分钟对最近约 3 小时的分钟行重新求和（≤ 200 × 180 行），在 advisory try-lock 之下，保留清理按 1 万行一批删除。`akari-bench swarm` 的 agent 会在心跳里发送指标，所以 swarm 的数字已含这部分负载。

## W26: protocol-layer modularization (subscription render, snapshot build)（协议层模块化）

W26 把订阅渲染器放到与内核无关的模型上（每个凭据的 inbound 由 xray 适配器 `protocols::xray::parse_as` 解析，而不是克隆并遍历存储的 JSON），并把协议规则移入 manifest。Snapshot 路径（`desired_state`）只读存储的 JSON，没有改动。门槛：回退不得超过 5%。用 criterion 测得，`make bench` 过滤为 `sub_render|db/desired_snapshot|db/snapshot_build_full`，`main`（f2a4c9d）在同一 target 目录的 worktree 中保存为基线，bench 数据库来自 `make bench-seed`（200 节点，200 万 node_users），同一台 4 vCPU 云容器：

| bench | main | W26 | 变化（criterion） |
|---|---:|---:|---:|
| sub_render/clash/1 | 14.08 µs | 13.03 µs | −6.6% |
| sub_render/links/1 | 14.90 µs | 13.75 µs | −6.1% |
| sub_render/sing-box/1 | 22.75 µs | 21.80 µs | −6.5%（首次运行 +8.0%，为噪声：main 对自身 −1.5%） |
| sub_render/clash/40 | 310.4 µs | 273.9 µs | −14.1% |
| sub_render/links/40 | 330.0 µs | 313.8 µs | −6.4% |
| sub_render/sing-box/40 | 583.8 µs | 565.3 µs | −2.9% |
| sub_render/clash/200 | 1.476 ms | 1.373 ms | −7.6% |
| sub_render/links/200 | 1.591 ms | 1.478 ms | −8.4% |
| sub_render/sing-box/200 | 2.974 ms | 2.784 ms | −6.4% |
| db/desired_snapshot/10000 | 85.5 ms | 83.2 ms | −0.7%（n.s.） |
| db/snapshot_build_full/10000 | 100.7 ms | 102.0 ms | +1.3%（在运行间噪声之内：main 对自身基线 −7.1%） |

W26 首次运行时，两个 `db/*` bench 读数为 +21%/+8%：bench Postgres 刚完成 WAL 恢复。在几分钟内交替运行 main 与 W26 重测，得到上表各行。Snapshot 路径没有 W26 的代码。

## W29: node block rules (agent Go benchmarks)（节点屏蔽规则）

Intel Xeon 2.1 GHz，4 vCPU，Go 1.27，xray 26.3.27。之前 = akari-agent main（0ac007c），之后 = 分支 `w29-block-rules`，各 8 次交替运行，`benchstat`（没有任何一行有显著差异，p > 0.2）：

| 基准（开关关闭） | 之前 | 之后 |
|---|---|---|
| Rebuild10k | 111.6 ms | 113.3 ms (~) |
| InstanceHeap10k（构建后的堆） | 21.35 MiB | 21.34 MiB (~) |
| TrafficSnapshot10k | 799 µs | 789 µs (~) |
| GateAdmitRelease | 510 ns，2 次分配 | 512 ns，2 次分配 (~) |
| ConnectEcho（新建 VLESS 连接 + 64 B 往返） | 280 µs，266 次分配 | 290 µs，266 次分配（~，±20% 噪声） |

开关关闭时：xray 配置与没有该功能的 agent 逐字节相同（`TestBlockSniffingConfig`），路由每次 dispatch 只多一次原子读取（`PickRouteBase` 1.2 ns → `PickRouteOff` 2.2 ns，0 次分配）。

开关打开，策略规模为内置集合加两条各 1000 行的自定义规则（2,573 个域名条目、1,000 个 CIDR、BitTorrent 协议）：

| | |
|---|---|
| `PickRouteOnMiss` / `OnHit` | 每次 dispatch 225 ns / 153 ns |
| `ConnectEchoBlockOn` 对比 `ConnectEcho`（同一次运行，n=10） | 305 µs 对 300 µs，每个连接 +18 次分配（嗅探） |
| `BlockPolicySwap`（编译 + 原子切换，规则内容变更） | 5.4 ms，1.7 MB 临时内存 |
| `BlockPolicyHeap`（已编译策略的常驻开销） | 320 KiB |
| `BlockStatsSize`：`Heartbeat.block`，35 条规则全部命中 / 开关关闭 | 每个 15 s 心跳 421 / 21 字节 |

嗅探要等客户端先发的字节（xray 默认最多约 300 ms）；客户端先发的协议（所测情形）不需要等待，被审计节点上服务端先发的协议则要等。复现：在 akari-agent 中运行
`go test -run '^$' -bench 'PickRoute|BlockPolicy|BlockStats|ConnectEcho' -benchmem .`

## W28-a: per-entrance accounting and relay entrances (2026-10-05)（按入口计费与中转入口）

面板 flush（`make bench-seed` + `cargo bench -- db/flush`，本地 bench 栈，main 对比 entrance 分支，同一台机器）：`db/flush/50000` 570.5 ms → 589.6 ms（+3.3 %，在运行间噪声之内；目标 < 1 s）。flush 现在为取倍率而 join 每行的入口（`ef AS
MATERIALIZED`，与 `nf` 相同）。

Agent（`go test -bench . -count 6`，Intel Core Ultra 7 265K，agent main 对比 W28-a agent 分支；benchstat，`~` = 无显著变化）：

| 基准 | main | W28-a | |
|---|---|---|---|
| `Rebuild10k`（1 万用户 × 2 个 inbound） | 75.2 ms | 74.0 ms | ~ |
| `DeltaRotate1of10k` | 6.06 µs | 6.09 µs | ~ |
| `StateHash10k` | 5.51 ms | 5.30 ms | −3.9 % |
| `GateAdmitRelease`（count 10） | 287.0 ns | 288.7 ns | ~（无人被限速时不查找每账户限速） |
| `TrafficSnapshot10k`（count 10） | 357.2 µs | 360.6 µs | ~ |
| `Rebuild10kEntrances`（同样的 2 万个凭据，作为 2 万个按入口的用户 `<id>` / `<id>#1`） | — | 94.6 ms | 对比 `Rebuild10k` +26 %：xray 用户数翻倍（每个入口一个） |
| `NftScript16x64`（16 个中转 × 64 个网段；每个 Snapshot 渲染一次，仅在变化时运行 nft） | — | 84.8 µs | |

中转入口的额外开销来自它的用户：每个用户每个中转多一个 xray 用户（有自己的凭据和流量键）；除了内核对中转端口做的 `ct state new` 匹配外，每个包没有任何额外开销。

**R44 (2026-10-06): the root updater applies the allowlists, the agent has no `CAP_NET_ADMIN`.（root updater 应用白名单，agent 不再有 `CAP_NET_ADMIN`。）**
`go test -bench -count 1` × 6 次交替运行，Intel Core Ultra 7 265K，agent main（322bc47，含 W29 + W32）对比 R44 agent 分支；benchstat，没有任何一行有显著差异（p > 0.06）：

| 基准 | main | R44 分支 | |
|---|---|---|---|
| `Rebuild10k` | 67.5 ms | 68.2 ms | ~ |
| `InstanceHeap10k`（构建后的堆） | 21.35 MiB | 21.35 MiB | ~ |
| `DeltaRotate1of10k` | 5.63 µs | 5.69 µs | ~ |
| `TrafficSnapshot10k` | 355 µs | 357 µs | ~ |
| `StateHash10k` | 4.72 ms | 4.68 ms | ~ |
| `GateAdmitRelease` | 282 ns，2 次分配 | 285 ns，2 次分配 | ~ |
| `ConnectEcho`（新建 VLESS 连接 + 往返） | 610 µs，262 次分配 | 618 µs，263 次分配 | ~ |
| `Rebuild10kEntrances` | — | 88.4 ms | |
| `SourceFilterRequest16x64`（agent，每个带中转的 Snapshot：规范化 + id + 请求 JSON） | — | 81.5 µs，72 KiB | |
| `NftScript16x64`（root updater，每次变更） | — | 99.2 µs，184 KiB | |

二进制（stripped，linux/amd64）：33,972,384 → 34,005,152 字节（+0.10 %，即整个 W28-a agent 改动的增量）。agent 对每个变更的白名单写一个小请求文件，请求未应答期间，每次心跳读取一个 ≤ 4 KiB 的结果文件；`Heartbeat.source_filter` 增加几个字节（没有中转时为零）。nft 在 root updater 中运行（每次变更一次 `nft -f`），不在 agent 进程里。

## W28-a PR4: site time zone and monthly partitions of `traffic_daily` (2026-10-06)（站点时区与 `traffic_daily` 的按月分区）

Flush（`make bench-seed` + `cargo bench -- db/flush`，本地 bench 栈，每次运行重新灌种，main
（235ce59）与本分支交替，各两轮）：`db/flush/50000` main 595.6 / 584.9 ms，分支 598.8 / 592.5 ms（+0.5 % / +1.3 %，在运行间噪声之内；目标 < 1 s）。flush 唯一的改动是暂存行的日期：`(SELECT akari_site_day(statement_timestamp()))`，一个非相关子查询（一个 initplan：每条语句查一次设置，而不是每行一次）。flush 仍然只写无索引、未分区的 `traffic_daily_pending`。

保留清理（bench 种子：最近 30 天的 300 万行 `traffic_daily`，外加同样的 300 万行回溯复制 400 天；然后对所有早于 400 天的数据做 rollup，在 bench 栈上用一个 `DO` 循环）：

| | main（`ROLLUP_SQL`：`DELETE … RETURNING`，每条语句 1 万行） | 分支（`akari_rollup_traffic_partition`：整月 → `traffic_monthly`，`DROP`） |
|---|---|---|
| 搬移行数 | 290 万 | 290 万（两个整月） |
| 耗时 | 21.8 s | 20.1 s（两者都主要耗在 `traffic_monthly` 的 upsert） |
| `traffic_daily*` 中遗留的死元组 | 290 万 | 0 |
| 之后 `traffic_daily*` 的大小（堆 + 索引） | 1679 MB（VACUUM 前不变，索引膨胀） | 880 MB（该分区的文件已消失） |

因此保留清理不再每月给 autovacuum 留下一个月的死堆和 B-tree 条目，分区占用的磁盘空间也立即归还。父表的 ACCESS EXCLUSIVE 锁由每个月事务末尾的 `DROP` 获取（`lock_timeout` 5 s，下一轮重试），所以读者最多等提交，而不是等复制。

## Phase A PR ②: servers split, NIC quota, time-window multipliers (2026-10-06)（servers 拆分、网卡配额、时间窗倍率）

`make bench-seed` + `cargo bench -- 'db/(flush|desired_snapshot)'`，本地 bench 栈，每次运行重新灌种，main（d907f52）与分支（Q1 + D5 + D9）交替：

| | main | 分支 |
|---|---|---|
| `db/flush/50000` | 599.3 / 580.1 ms | 609.3 / 600.7 / 609.1 ms（+1.7 % … +5 %） |
| `db/desired_snapshot/10000` | 18.8 / 18.6 ms | 20.0 ms（+8 %），使用固定的种子布局 |

- Flush：结算现在会更新 server（GCRA 时钟），并在单独的 `node_totals` CTE 中更新每个入口的节点（每节点的原始/计费总量，Q1），并对批次中的每个入口调用两次 `akari_entrance_rate()` 取倍率（D9：取当前与 30 s 前中较低者；plpgsql 查找，入口没有规则时立即返回基础值）。在目标内（5 万行 < 1 s）且接近噪声；多出的那次行更新，是同一 agent 下按节点总量的代价。
- Snapshot：server 的用户集会 join 它的节点（`enabled`，inbound 存在）。分支最初几次运行显示 28 ms：问题不在查询而在种子——`entrance_users` 的 INSERT … SELECT 没有 ORDER BY，在新的触发器/计划下，一个入口的 1 万行落在了 1 万个堆页上（main 偶然的布局：183 页）。种子现在按入口排序写入（`seed.rs`），因此各次运行可以公平对比。生产环境的表是逐用户写入的（在两个版本上都像那个 28 ms 的情形一样分散）。
- D5 在每个通过现有 5 s 历史节流的心跳上多一次单行 `UPDATE servers`（后台任务，8 个写许可繁忙时跳过；计数器是累计的，所以跳过一次心跳不会丢数据）。

## Snapshot read: covering key, no SQL sort; flush trims (2026-10-07)（快照读取：覆盖键、不在 SQL 里排序；flush 精简）

接续 "Phase A PR ②"。`make bench-seed`（现在带 `--layout pinned|scattered` 和
`--plans`）+ `cargo bench -- 'db/(desired_snapshot|snapshot_build_full|flush)'`，本地 bench 栈，
每次运行重新灌种，main（6376126）与分支交替：

| 种子 | bench | main | 分支 |
|---|---|---|---|
| pinned（`--layout pinned`，默认） | `db/desired_snapshot/10000` | 18.96 / 19.45 ms | **16.87 / 16.15 ms**（−13 %） |
| | `db/snapshot_build_full/10000` | 24.75 / 24.03 ms | 21.85 / 20.52 ms |
| | `db/flush/50000` | 599.1 / 618.3 ms | 585.8 / 600.6 ms（−2.5 %） |
| scattered（`--layout scattered`：逐用户写入行，与生产一致） | `db/desired_snapshot/10000` | 31.49 / 30.06 ms | **18.87 / 20.55 ms**（−35 %） |
| | `db/snapshot_build_full/10000` | 37.17 / 34.33 ms | 23.81 / 25.34 ms |
| | `db/flush/50000` | 654.0 / 633.7 ms | 611.8 / 637.6 ms |
| scattered + `--plans`（每个用户都有生效套餐，与生产一致） | `db/desired_snapshot/10000` | 43.46 ms | **27.82 ms**（−36 %） |
| | `db/flush/50000` | 638.1 ms | 639.0 ms |

快照读取的开销在哪里（`EXPLAIN (ANALYZE, BUFFERS)`，1 万用户的 server，5 万用户）：

- **堆分散。** 一个入口的 1 万行 `entrance_users` 在 pinned 种子中位于 182 个堆页，而逐用户写入时分布在约 9.5k 页上（一个用户在其全部 40 个入口上的行会落在一起）：位图堆扫描 9.5k 页，多 10–13 ms。迁移 1090 把主键改为覆盖式，`(entrance_id, user_id) INCLUDE (protocol, account)`：无论堆顺序如何，都是约 190–330 页的仅索引扫描（`Heap Fetches: 0`）。它取代旧键（只有一个索引，每个分配多约 95 字节：按顺序构建的 200 万行从 95 MB 增至 286 MB，逐用户构建时为 507 MB）；键列不变，所以 flush 的准入探测和所有 ON CONFLICT 与之前一致。该表在变更/插入行达 1 % 时 vacuum，以保持可见性映射新鲜。`account` 更新（重置凭据）不再是 HOT；这种操作很少。
- **排序。** `ORDER BY eu.user_id, e.wire_no` 在 PostgreSQL 中对 1 万个宽行排序（约 1 ms）。一个入口的行从该键中按用户顺序出来，所以面板现在改在 Rust 中排序（`sort_unstable_by_key`，对这种顺序段是线性的）；发给 agent 的 op 顺序不变（测试 `snapshot_users_are_ordered_by_user_then_entrance`）。
- **Rust 构建**（占总量约 1.9 ms）：每个入口克隆一个 tag 字符串，而不是每行格式化；`stat_key` 直接编码进精确大小的字符串；`BEGIN ISOLATION LEVEL …` 合并为一次往返。
- **剩余部分**，以及为何不改：`users` 过滤（`enforce::SERVED`）和限速（`user_plans`）是对*所有*用户和生效套餐的哈希 join（顺序扫描 + 哈希，5 万规模下各约 5–7 ms）：1 万次索引探测开销相同（实测每次约 0.7 µs），`users` 的仅索引扫描会退回堆（计费会更新每个活跃用户的行），而对 `users_pkey` 做 `= ANY(array)` 探测更慢（6 ms）。bench 的默认种子没有 `user_plans`；`--plans` 展示生产形态（见上）。

Flush（D9 / Q1 开销）：`ef` 对 5000 行块中的每个入口调用两次 plpgsql 的 `akari_entrance_rate()`；现在入口没有规则时直接读基础倍率（函数此时的返回值），只对有规则的入口调用函数。server 的 GCRA（`advanced`）和节点总量（`node_totals`）原本对该块聚合了两次（节点那次为 Sort + GroupAggregate，每块约 1.2 ms）；现在都读同一个 `per_node` 聚合（按 server 和节点）。计费结果不变（所有计费测试，包括倍率规则结算，原样通过）。

## Limits and honest caveats（局限与坦率的注意事项）

- Flush 余量（W22）：5 万行 0.58 s，对照 1 s 预算（W11：0.49 s）；在更慢的磁盘或更繁忙的 PostgreSQL 上，flush 仍会平滑降级（分块把锁持有限制在一块之内），只是积压排空所需的时间会变长。
- 如果数据库停顿的时间超过突发窗口，而 agent 仍在上报，则按节点的上限会钳制延迟到达的流量（少计费，绝不多计费）。在这台机器上观察到过一次：宿主机磁盘使 PostgreSQL 在 200 万行重启风暴期间停顿了数秒；这是文档中已有的界限（R13），不是缺陷，但积压排空缓慢会扩大它。
- `LISTEN/NOTIFY` 需要直连 PostgreSQL（不能用事务模式的连接池）。
