# Fuzzing and the billing-core coverage gate（模糊测试与计费核心覆盖率门槛）

ROADMAP §0 出口标准：「关键解析器做 fuzz」和「计费核心路径覆盖率 ≥ 90%」。
本文件说明面板侧的这两项；agent 侧对应内容在 `akari-agent`
（`fuzz_test.go`、`release/fuzz_test.go`、`make fuzz`、`make cover`）。

## Fuzz targets (`fuzz/`)（模糊测试目标）

使用 cargo-fuzz（libFuzzer）。`fuzz/` 是独立的 crate，有自己的 lockfile 和固定的 nightly
（`fuzz/rust-toolchain.toml`）：libfuzzer-sys 不会进入发布二进制、Docker 构建或 `cargo deny`。
cargo-fuzz 以 `--cfg fuzzing` 构建库，从而编译 `src/fuzzing.rs`（暴露 crate 私有解析器的入口）和
`traffic::introspect`；其他构建中都不存在这两者。调试断言和溢出检查开启（cargo-fuzz 的默认构建），
AddressSanitizer 同样开启。

每个目标断言的是不变量，而不只是「不 panic」：

| 目标 | 输入（由谁控制） | 不变量 |
|---|---|---|
| `alipay_notify` | notify 表单正文（互联网上任何人） | 解码器是规范的（重新编码 → 同一个 map），参数 ≤ 64 个且无重复；没有支付宝密钥就无法通过验签；支付宝签过名的 map（两种空值约定均可）经线上往返后仍能验签；篡改任一已签名的非空值，或 `sign_type` ≠ RSA2，都会验签失败 |
| `alipay_response` | 网关响应字节 | 未签名或伪造的正文绝不会被接受；对原始 `<method>_response` 文本签名的正文，当且仅当 `code` = 10000 时被接受，并得到解析后的该文本；已签名文本内的任何改动 → `BadSignature` |
| `inbounds` | 管理员提交的 inbound JSON（W28-a：每个节点一个对象） | 判定是确定且幂等的；被接受 ⇒ 没有 tag（由面板命名）、通过 `check_inbound`、任意深度都没有键在 Go 的大小写折叠下相等的对象（W14）；可签发的 inbound 得到无需再调整的账号；三种订阅格式都能渲染（sing-box 为合法 JSON） |
| `node_templates` | 模板请求（管理员，单个模板） | 凡是渲染出的结果都能通过 `validate_inbound` 且没有 tag；渲染出的受管 inbound 可签发；绝不使用已被占用的端口 |
| `protocols_manifest` | W26：`proto/protocols.toml`（仓库内文件；由 build.rs 和 `protocols::manifest_def` 解析） | 解析是确定的；被接受的清单可再次通过校验，每个场景都是合法组合（其协议接受该传输/安全层，未违反任何规则）；生成的文档矩阵能渲染并列出每个协议 |
| `inbound_model` | W26：inbound JSON（管理员提供或已存储的），经 xray 适配器与内核无关模型处理 | 不 panic；每个错误都有解释；渲染一次即规范化（render∘parse 经一轮后幂等）；按任一受管协议解析都能渲染；被接受 inbound 签发的账号无需再调整，其规范化形式同样被接受 |
| `client_ip` | 对端、受信 CIDR、Cloudflare CIDR、请求头（攻击者可控的头） | 不受信的对端 ⇒ 结果就是该对端；答案只会是对端、某个 X-Forwarded-For 跳或 CF-Connecting-IP；没有 Cloudflare 信任时 CF-Connecting-IP 不起作用；`Cidr` 的 Display 往返一致且包含其网络 |
| `domain` | 系统设置中的域名（管理员）、Host 头（攻击者）、CF 地址段列表 | 被接受的域名为 ASCII、小写、≤ 253 且无结尾点；能从其 authority **以及其 Unicode 显示形式**（控制台回传的内容）重新解析；其 authority 的 `request_host` 恰好等于存储的 host（Host 闸门放行它） |
| `csr` | 注册/续期 CSR（未认证对端） | 原始 DER 和经字节修补的有效 CSR：仅当 rcgen 认定为 P-256 密钥时才接受，被修补的 CSR 绝不会以另一把密钥被接受；> 4 KiB 一律不接受 |
| `updates` | 发布清单、签名文件、`release_keys`、版本号（管理员；agent 会再次验证） | 清单往返一致；版本序满足自反、反对称、传递；签名只对其确切字节和 key id 验证通过 |
| `agent_messages` | 节点发来的 `AgentUp` protobuf（节点可能已被攻陷） | 一系列流量上报 / flush / prune / 成员变更之后，流量缓冲的索引与其条目保持一致；未持久化期间计数器绝不减少；非成员和未知节点绝不产生条目；心跳 blob 是 JSON，数字被钳制，agent 文本有长度上限且不含控制字符 |
| `billing_input` | 优惠码、W16 的订单/商店/优惠券/余额/提现/返利/退款请求体（用户和管理员）、金额拆分 | 规范化后的优惠码等于去空白后的输入，由 3–32 个 `[A-Za-z0-9_-]` 字符组成，且幂等；每个请求体都是 `deny_unknown_fields`，订单请求体绝不携带金额；优惠券折扣落在 [0, 标价] 内，百分比折扣恰为 floor(标价 × % / 100)；折扣 + 抵扣 + 余额 + 应付金额 = 标价，且各部分均非负（这是 SQL `akari_coupon_discount`/`akari_split` 的 Rust 镜像，`billing::tests::w16::money_sql_matches_the_mirrors` 将其与 SQL 对齐） |
| `support_input` | W17 工单请求体（创建/回复/指派）、告警设置 / 单节点规则 / 测试请求体、工单文本清洗器、告警渠道校验器（chat id、bot token、webhook URL、邮箱）、心跳事实、对任意事实运行的告警评估器 | 每个请求体都是 `deny_unknown_fields`；清洗后的主题是去空白、无控制字符的 1–120 字符单行，清洗后的正文除 LF/TAB 外无控制字符且为 1–5000 字符，两者均幂等；被接受的设置请求体中每个阈值都在范围内，Telegram/webhook 值格式正确（https 或回环 http，不含凭据）；评估器每种类型至多触发一次，绝不同时处于触发和未知状态，文本有长度上限且无控制字符 |
| `json_bodies` | 23 个带 `deny_unknown_fields` 的请求体、请求路径 | 能解析的请求体一旦加入未知成员就不再能解析；`redacted_path` 总会替换前缀段以及 sub/install 令牌段；令牌形状检查恰为 43 个 base64url 字符 |
| `signup` | W15：邮箱地址、注册白名单、验证码 / 重置令牌 / 邀请码的形状、9 个注册/重置/邮件/设置请求体、邮件模板 | 解析后的地址为小写、≤ 254 字节、恰有一个 `@`、不含会破坏邮件头/HTML 的字符，重新解析得到自身，且被其自身域名放行；形状精确匹配；请求体拒绝未知成员，经校验的 SMTP 值不含控制字符（明文 SMTP 绝不携带凭据）；输入不会向 HTML 引入标记，主题保持单行 |
| `payment_methods` | W24/R40：系统设置 → 支付 的请求体（`MethodReq`）、支付宝当面付配置校验（创建与编辑两种情形）、注册工作量证明、旧版 notify 的 out_trade_no 预读 | 不 panic；请求体拒绝未知成员；任何密钥（私钥）都不会出现在存储的明文配置或管理员视图中；随机的工作量证明不会通过验证 |
| `content` | Ops：安全的 Markdown 渲染器/清洗器（`markdown::render`：公告、帮助文章、公告邮件）、其 URL 规则（`safe_link`/`safe_image`）、可编辑邮件模板（`templates::validate` + 带示例值的 `render_custom`）、品牌 PNG 的头部与正文、公告 / 帮助请求体 | 不 panic；输出只含标签 `p br h3-h6 strong em code pre ul ol li blockquote hr a img`，且属性只有 `href target rel src alt loading`；每个 `href` 都通过 `safe_link`（无 `javascript:`），每个 `src` 都通过 `safe_image`（https 或同源，绝不用 http）；绝对链接带 `rel="noopener noreferrer"`；输出规模与输入呈线性；被接受的模板渲染出无控制字符的主题，且只含布局/渲染器标签；请求体拒绝未知成员 |

精选种子（包括发现过的每个崩溃，命名为 `regress-*`）提交在 `fuzz/seeds/<target>/` 下；
增长后的语料库放在 `fuzz/corpus/`（已 gitignore；CI 把它保存在 Actions 缓存中）。

```bash
cargo install cargo-fuzz          # once (0.13)
make fuzz FUZZ_SECS=600           # every target 10 min (fuzz/run.sh)
cd fuzz && ./run.sh 60 csr domain # some targets
make fuzz-lint                    # fmt + clippy of the fuzz crate
```

崩溃会把触发输入留在 `fuzz/artifacts/<target>/`；复现方法：
`cd fuzz && cargo fuzz run <target> artifacts/<target>/<file>`。修复后，在出错处补一个单元测试，
并把该输入移到 `seeds/<target>/regress-*`。

- `ops_input`（Ops）：批量请求（`CreateReq`/`PreviewReq`，包括其中的 `action`/`selection`）、
  手动订单和优惠券批次请求体都是 `deny_unknown_fields`；手动订单绝不携带金额；批量动作校验器绝不 panic；
  CSV 写出器的输出总能解析回相同的单元格，文本单元格也绝不会以电子表格公式开头
  （`= + - @`、制表符、CR → 加撇号前缀）。

### CI (`.github/workflows/fuzz.yml`)（持续集成）

- 推送到 main，以及改动了目标编译内容的 PR（`src/`、`fuzz/`、`Cargo.*`、工具链；
  `scripts/ci-changes.sh` 的 `fuzz` 组）或带 `full-ci` 标签的 PR：每个目标跑 20 s
  （19 个目标：约 6 分钟模糊测试加构建时间），用种子和缓存的语料库捕获回归；其他 PR 跳过该 job（W37）；
- 发布前：`release.yml` 在打 tag 的提交上运行同样的 20 s 一轮，未通过则不发布任何内容；
- 每夜（03:47 UTC）：每个目标 4 分钟（19 个目标：模糊测试 76 分钟，含构建约 86 分钟）；
- 手动（`workflow_dispatch`）：可选择每个目标的秒数（默认 240）。

时间预算：job 的 `timeout-minutes` 为 150；所有目标的模糊测试总时长上限为 `FUZZ_BUDGET_MIN`（120 分钟）
——若 目标数 × 秒数 超出，该步骤会降低每个目标的秒数并给出警告，而不是超时。超时（被取消）的 job 还会跳过语料库缓存的保存，
导致夜间任务不再增长语料库。新增目标时，要让 目标数 × 夜间秒数 远低于预算（240 s 下最多约 30 个目标）。

语料库从 Actions 缓存恢复并保存回去，因此各次夜间运行是逐次累积的。崩溃会使 job 失败并上传 `fuzz/artifacts/`。

### Findings (W13, 2026-10-02)（发现的问题）

| 目标 | 发现 | 修复 |
|---|---|---|
| `domain` | 超长 IDN（Unicode 形式 > 300 字节，punycode ≤ 253）无法保存回去：控制台回传的是 Unicode `display`，而 `Domain::parse` 把输入限制在 300 字节 | 输入上限提高到 1024（真正的限制是 253 字节的 ASCII 长度）； `settings::tests::long_idn_display_round_trips` |
| `agent_messages` | `Heartbeat.cert` 的 domain/challenge/error 未设上限且含控制字符就写入了共享的 Valkey blob（被攻陷的节点每次心跳可塞入约 4 MB） | `grpc::cert_status_json` 让每个 agent 字符串都经过 `nodestat::agent_text`（253/512/32）；含控制字符的延迟 URL 会被丢弃 |
| `node_templates` | 模板渲染出了保存时会被拒绝的 tag（`_x`、`akari-*`、`api`、重复项） | `nodetpl::render` 以 `validate_inbound` 收尾（W28-a：模板完全不带 tag） |

覆盖率工作还发现，`traffic::db_tests::one_bad_row_does_not_poison_the_batch` 在按节点索引重构之后
不再覆盖逐行重试路径（它植入的那一行对 `snapshot` 不可见）；现在它同时植入索引条目，并断言该路径。

## Billing-core coverage gate (`scripts/coverage-gate.py`)（计费核心覆盖率门槛）

Ops 新增 `src/batch.rs`、`src/export.rs`、`src/csvx.rs`、
`src/billing/manual.rs`、`src/billing/coupon_batches.rs`（各 ≥ 90%）。

对完整测试集运行 `cargo llvm-cov`，**包括真实数据库测试**（CI 的 `coverage` job 与 `rust` job 使用相同的
PostgreSQL/Valkey 服务），再按模块统计行覆盖率，只计生产代码（内联的 `#[cfg(test)] mod … {` 标志着文件中生产代码行的结束）。
任何模块低于其阈值（90 %）时 job 即失败：

`traffic.rs`, `enforce.rs`, `entitle.rs`, `plans.rs`, `billing/orders.rs`,
`billing/catalog.rs`, `billing/api.rs`, `billing/alipay.rs`.

```bash
cargo install cargo-llvm-cov && rustup component add llvm-tools-preview
make dev-up && make coverage
```

各模块的覆盖率表会输出到 job 日志和 job summary；lcov 文件作为 artifact 上传。阈值只升不降。
