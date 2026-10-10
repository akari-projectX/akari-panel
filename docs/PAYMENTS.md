# Payments: payment methods (Alipay Face-to-Face first)（支付：支付方式，首个为支付宝当面付）

R18-3 / W24 (R40)。面板通过**支付方式**销售套餐，支付方式在 系统设置 → 支付 中配置（仅存数据库，不用 panel.toml）。
一个支付方式是某个**渠道类型（provider kind）**的一份配置实例；目前唯一的类型是**支付宝当面付**
（`alipay_f2f`：`alipay.trade.precreate` → 二维码）。同一类型可以有多个支付方式（例如两个支付宝商户）。

- 代码：`src/billing/`（`provider.rs` 为 trait 与注册表，`methods.rs` 为支付方式 / API / 重载 / 旧配置导入，
  `alipay.rs` 为支付宝类型；W7 套餐目录：`catalog.rs`）
- 迁移：`0040_billing.sql`、`0070_plan_catalog.sql`、`0140_payment_methods.sql`
- SPA：`spa/src/pages/purchase.tsx`、`orders.tsx`、`admin-orders.tsx`、`admin-plans.tsx`（价格）、
  `admin-payments.tsx`（系统设置 → 支付）。

## How it works（工作流程）

1. 管理员按周期给套餐定价（`PUT /api/v1/plans/{id}/prices`
   `{on_sale, prices: [{period, days?, price_cents}]}`；SPA：套餐 → 定价）。金额处处使用**整数人民币分**。
   套餐可售的条件：`plans.enabled`、`on_sale`，且存在所请求周期的价格（见下文 "Periods"）。
2. 用户下单（`POST /api/v1/me/orders {plan_id, period}`）。服务器决定这次购买的性质
   （新购 / 续费 / 换套餐 / 重置包，或拒绝：售罄、仅限续费、不允许换入……），计算金额
   （该周期价格减去换套餐折算），并先写入订单行，包括 `period`、`list_price_cents`、`credit_cents`、
   `credit_order_id` 和 `amount_cents`——客户端从不传金额，`GET /me/shop` 会事先展示同样的计算结果。
   折算额覆盖全部价格的订单立即付清（`paid_via = credit`，走同一个 `apply_mark_paid` 路径），不会到达支付宝。
   否则订单绑定到一个**支付方式**（请求中的 `method_id`；恰有一个启用的支付方式时可省略，此时门户跳过选择器；
   否则返回 `order.method_required` / `order.method_unavailable`），存为 `orders.payment_method_id`，
   面板调用 `alipay.trade.precreate`（`timeout_express` = `order_timeout_minutes`，默认 15）并返回二维码内容。
   SPA 在本地渲染二维码（不使用 CDN）。每个用户同时只有一个未结订单：新订单会结束上一个待付款订单
   （先去支付宝查询并关闭）。
3. 付款结果通过以下任一途径得知：
   - **异步通知**（`POST /pay/{method_id}/notify`；R40 之前的 `/pay/alipay/notify` 为旧订单保留），
   - **状态轮询**（`GET /api/v1/me/orders/{id}` 对待付款订单向其支付方式查询（`alipay.trade.query`），
     所有实例合计每个订单最多每 3 s 一次），
   - **对账**（每个实例每 10 s 一次：最近 20 s 内未查询过的待付款订单会按各自的支付方式查询；
     `FOR UPDATE SKIP LOCKED` 加认领时间戳避免实例间重复工作）。支付方式被停用（或不可用）的订单不会被查询；
     超过过期时间 + 关闭宽限期后，订单以 `close_state = method_unavailable` 结束（不发远程调用）。
4. 所有路径最终都进入 `orders::apply_mark_paid`：`entitle::lock` →
   条件更新 `UPDATE orders SET status='paid' ... WHERE status <> 'paid'` →
   通过 M3 的 `plans::apply_*` 函数开通 → 审计，全部在**同一个事务**中。只有 UPDATE 真正翻转了该行的事务才执行开通：
   重放的通知、并发的通知 + 查询、多个实例，都恰好开通一次
   （测试：`billing::tests::concurrent_duplicates_fulfil_once`）。

### Periods (W7)

每个套餐每种周期至多一个价格（`plan_period_prices`）；价格都是可选的，`on_sale` 至少需要一个非重置包的价格。
周期运算只在 SQL 中完成（`akari_period_end`，使用数据库时钟）：

| `period` | 增加 | 名义天数（折算用） |
|---|---|---|
| `month` / `quarter` / `half_year` / `year` / `two_year` / `three_year` | 站点时区下的 1 / 3 / 6 / 12 / 24 / 36 个自然月（Q3，系统设置 → 站点 → 时区，默认 Asia/Shanghai：本地时间 1 日购买一个月，到下月 1 日结束）；日期超出月末时取月末（1 月 31 日 + 1 个月 = 2 月 28/29 日） | 30 / 90 / 180 / 365 / 730 / 1095 |
| `days` (`days` = N, 1–3650) | N × 86400 s（R18-3 的单一价格已迁移为此类型） | N |
| `onetime` (`days` = N or null) | N 天；`days` 为 null 时**永不过期** | N（永久则无） |
| `reset` | 流量重置包：把当前套餐的已用流量清零；不改变周期，重置计划不变 | — |

### What a purchase does（购买的效果）

| 用户当前的套餐 | 购买套餐 P、周期 X |
|---|---|
| 无 | `new`：从现在起获得一个 X 周期的 P，用量清零。`renewal_only` 套餐和 P 已满（`capacity`）时拒绝。 |
| 有到期时间的 P | `renew`：到期时间 = max(到期时间, 现在) 之后再加一个 X（不带天数的 `onetime` 变为永久）；重置锚点不变；用量不变——但一次性时长或不做周期重置的套餐除外，它们开始新的额度（中-1）。P 已满或仅限续费时也允许。 |
| 无到期时间的 P | 拒绝续费（409 "nothing to renew"）；仍可购买重置包。 |
| P，X = `reset` | `reset`：已用流量 → 0；因超额被停用的用户会重新启用（管理员停用的绝不会）；审计 `user.traffic.reset`，`source: reset_pack`。仅限 P 的现有订阅者——这正是流量用尽的用户（R21 续费范围）所买的。 |
| 另一个套餐 Q | `switch`：替换 Q（M3 替换语义，**用量清零**），从现在起获得一个 X 周期的 P，收取 P 的全价**减去换套餐折算**。P 的 `allow_switch_in = false`、为 `renewal_only` 或已满时拒绝。 |

### Switching plans: the credit（换套餐：折算）

折算额是当前订阅尚未使用部分的价值，在创建订单时由 SQL 计算（`catalog::switch_credit`）：

```
paid    = the paid, fulfilled, non-reset, NOT refunded orders of the user
          for the current plan, fulfilled since the current subscription
          started; each covers nominal_days(order) × 86400 seconds
value   = list_price − discount − gift  (what was actually paid: gateway
          amount + balance + the credit it carried; High-2)
covered = the remaining seconds are taken from the newest order backwards
          (the newest order covers the last part of the term, B1)
credit  = floor(Σ value(o) × covered(o) / (nominal_days(o) × 86400))
credit  = min(credit, Σ value of all such orders)   -- never more than was paid
credit  = min(credit, floor(Σ value × traffic_left / quota))   -- High-1, quota plans only
credit  = 0 when there is no such order (admin-assigned), no expiry,
          nothing remaining, or a permanent one-time purchase
amount  = price − min(credit, price)        -- never negative
```

运营规则（计费审查 B1，2026-10-10）：剩余时间**逐单**按各自的日单价折算，最新一单只覆盖它自己买的那段时间。
以前用最新一单的日单价折算整个剩余期：年付 100 元、临近到期续 1 天（1 元）后，剩余 67 天按 1 元/天
折成约 67 元（公平值约 19 元）。没有任何已付订单覆盖的剩余时间（管理员延长、31 天月份多出的那天）不折算。

运营规则（运营逻辑审查 高-2）：折算按**实付价值**算——优惠券折扣和管理员赠送（`gift_cents`）
不算价值，已退款的订单不参与折算（既不占剩余时间，也不计入封顶）。所以「券只限套餐 A」不能
靠换套餐变成别的套餐的价值，「赠送 A」也不会变成可换任意套餐的余额。赠送订单（价值 0）覆盖的
那段时间折算为 0（保守取值，只会少折、不会多折）。

运营规则（运营逻辑审查高-1，lead 定的默认值）：折算 = 实付 × min(剩余时间比例, 剩余流量比例)。
有流量额度的订阅（`users.traffic_limit_bytes`，即当前订阅的执行额度）按「剩余流量 / 额度」再打一次
折：流量用完的订阅不值钱，来回换套餐不能只花时间的钱就买到满额流量。新套餐从零开始计流量。
有周期重置的长订阅按**当前周期**的剩余比例计（只会少折）。不限流量的套餐只按时间算。

示例：一个月 30.00，剩余 15 天时换套餐 → 折算 15.00；一个 50.00 的套餐此时只需 35.00。
折算额超过新套餐价格的部分会**作废**（不转余额、不退款）——商店在购买前会提示（`forfeited_cents`），
订单由折算额全额支付。折算额在创建订单时就固定在订单中（订单在 `order_timeout_minutes` 后过期）；
如果付款会替换的订阅并非下单时所针对的那个，则退回余额（低-4，见上文）；
如果折算来源的订阅在此期间已结束，付款仍然生效，并以 `fulfil_result.credit_source_changed = true` 标记待人工复核。

### Stock and sale rules（库存与销售规则）

- `capacity`（最大活跃订阅数，null = 不限）在创建订单时检查，并在开通时于 `entitle::lock` 下再次权威检查。
  管理员指派（PUT /users/{id}/plan）忽略容量和销售规则。
- 运营规则（运营逻辑审查中-2）：**下单即占名额**。订单创建时记录它的动作（`orders.action`：
  new/renew/switch/reset），待付款的新购/换套餐订单在过期或结束前占一个名额：库存 = 生效订阅数 +
  其他人未过期的待付款订单（`catalog::taken_sql`），商店的「剩余」与「售罄」、下单与开通时的复查都按它算，
  所以两个人抢最后一个名额时第二个人在下单时就被拒绝（409「已售罄」），不会出现两人都付款。
  订单取消/过期/被新订单替换即释放名额。
- 付款时仍然开通不了（名额在订单过期后被别人占了而又迟到付款、管理员调低了库存、套餐已停用或删除、
  流量重置包的套餐已不是当前套餐）：**自动退回余额**（支付宝实付 + 订单扣的余额部分，`refund_balance_cents`；
  优惠券次数还回；不产生返利；不发支付回执而发退款通知邮件，说明「该订单没有开通套餐」），订单保持
  `fulfil_error` 记录原因，审计 `order.refund`（操作者为支付渠道），并通过「节点告警」里已启用的告警通道
  （Telegram / webhook / 邮件）通知管理员（事件 `billing`）。管理员人工标记付款的订单不自动退款（由管理员处理）。
  仪表盘「已付款未开通」与订单筛选「未开通」只列未退款的。
- `renewal_only`：对除持有者之外的所有人在商店中隐藏；持有者可续费并购买其重置包。
- 运营规则（运营逻辑审查中-6）：**下架（取消「上架」）只停止新购买**。套餐的
  `renew_off_sale`（「下架后现有用户仍可续费和购买流量重置包」，默认开）开着时，下架套餐对它的
  现有用户仍出现在商店里，只能续费和买重置包；其他人看不到、下单 400「not for sale」。关掉它则
  下架即对所有人停售。**停用**（`enabled = false`）则谁都不能买（续费也不行）。
- `allow_switch_in = false`：其他套餐的持有者不能换入（新用户可以购买）。
- `speed_limit_mbps` 由 agent 执行（见 README "Plans and node groups"）；`device_seats` 在客户端发布之前不执行（R25）。

周期内的流量重置遵循套餐的 `reset_period`（M3 周期扫描）。运营规则（运营逻辑审查中-1）：续费**不重置**流量的套餐（`reset_period = none`）或一次性
（`onetime`）时长时，新的一期从满额流量开始（已用清零、因超额被停用的账户恢复、记
`last_reset_at`）——否则用完流量的用户付了续费仍然连不上。按月重置的套餐续费仍只延长时间
（流量由周期重置处理）；流量重置包照旧可单独购买。

### Late payments, failures, refunds（迟到付款、失败与退款）

- 本地已过期或已取消、但（通过通知或查询）被报告为已付款的订单仍会开通：支付宝已经收了钱。
- 运营规则（运营逻辑审查低-4）：订单记录下单时用户的订阅（`orders.prior_user_plan_id`）。迟到的付款
  如果要**替换**的订阅已经不是下单时那个（用户之后另购、换了套餐）——不替换，转为自动退回余额
  （`fulfil_error` = "not replaced"，同中-2 的自动退款与告警）。下单时的订阅在此期间到期、现在没有
  订阅时照常开通（这正是付款要买的）；同一套餐的续费照常续期。
- 开通因业务原因失败时，订单保持**已付款**并记录 `fulfil_error`；支付宝仍会收到 `success`。
  套餐售罄、被删除或停用，或重置包对应的套餐用户已不持有：自动退回余额（中-2，见 "Stock and sale rules"）。
  其他失败（用户已被删除或现在是管理员，迟到付款所需的余额部分已不存在）：管理员到 订单 → 状态「已付款未开通」
  → 详情 → 重试开通（须填原因，审计 `order.fulfil.retry`）。
- 手动标记已付款（客服场景，例如已在线下证实的付款）：在未付款订单上用同一个按钮；
  `paid_via = manual`，原因会被保存并审计。
- 支付宝金额的**退款**在支付宝商户后台进行；面板负责记录（W16，订单 → 退款，见下文 "Refunds (admin)"），
  退回余额部分，并在选择时把该金额改记入余额；P1：订单对订阅的影响在同一事务中撤销（选择「仅退款」除外）。
- 过期：对账会查询超过 `expires_at` 的待付款订单；已付款 → 开通，否则调用 `alipay.trade.close`（尽力而为）
  并把订单置为 `expired`。网关不可达期间订单保持待付款并重试；1 小时后无论如何置为过期
  （`close_state = failed`；之后到达的通知仍会开通它）。

## Coupons, balance, invite commission (W16, M7)（优惠券、余额、邀请返利）

代码：`src/billing/{coupons,ledger,commission}.rs`；迁移 `0105_inviter.sql` … `0108_commissions.sql`；
SPA：购买页（优惠券输入框、"pay with my balance"）、门户 `wallet.tsx`（余额 + 我的邀请）、
控制台 `admin-coupons.tsx`（优惠券）、`admin-finance.tsx`（资金），退款在 `admin-orders.tsx`。

### How the amount is split（金额如何拆分）

订单的标价（该周期的价格）**按以下顺序**被覆盖：

```
discount = coupon on the LIST price      percent: floor(list × p / 100); fixed: min(value, list)
credit   = min(switch credit, list − discount)            excess forfeited (W7 rule)
balance  = min(user's balance, list − discount − credit)  only when the buyer asks (use_balance)
amount   = list − discount − credit − balance  ≥ 0        what Alipay is asked for
```

以上全部由服务器在创建订单时用 SQL（`akari_coupon_discount`、`akari_split`）计算，并复制到订单中
（`discount_cents`、`coupon_id`/`coupon_code`、`credit_cents`、`balance_cents`、`amount_cents`）；
`orders` 表的 CHECK 约束对每一行强制 `amount = list − credit − discount − balance ≥ 0`。
客户端发送 `{plan_id, period, coupon?, use_balance?}`——从不传金额——商店（`GET /me/shop?coupon=&use_balance=`）
会事先展示同样的拆分。金额为 0 的订单在创建时经 `apply_mark_paid` 付清（余额参与时 `paid_via` 为 `balance`，
否则为 `credit`，再否则为 `coupon`），不会到达支付宝。

为什么是这个顺序：优惠券是对标价的促销（「¥30 打 8 折」就是 ¥6，与买家的情况无关），所以在标价上计算，
独立于折算；换套餐折算是买家自己的价值，覆盖剩余部分；余额是买家的钱，最后使用，且只用到够为止。
任何部分都不会变成负数：每一部分都以剩余金额封顶，CHECK 约束是最后的兜底。

返利基数**只含支付宝实付金额**（`amount_cents`）：优惠券、换套餐折算和余额部分都不产生返利
（不对回流的返利再返利，也不对折扣返利）。

### Coupons（优惠券）

| 字段 | 含义 |
|---|---|
| `code` | 3–32 个 `[A-Za-z0-9_-]` 字符，**不区分大小写**唯一，输入时大小写任意，不可修改 |
| `kind`, `value` | `percent` 1–100（标价的百分之几，向下取整到分）或 `fixed` 分（以标价封顶） |
| `plan_ids`, `periods` | 适用范围；null = 所有套餐 / 周期类型（含重置包） |
| `min_amount_cents` | 标价至少要达到此值 |
| `starts_at`, `ends_at` | 有效期，使用数据库时钟（`ends_at` 不含） |
| `max_uses` | 总使用次数（null = 不限）；`used` 统计待付款订单的预留 + 已兑现次数 |
| `per_user_limit` | 每个买家的使用次数（待付款订单计入） |
| `new_users_only` | 仅限尚无任何已付款订单的买家 |
| `enabled` | 关闭 = "invalid coupon code" |

**预留，无竞态（决定）**：使用次数在**创建订单时预留，订单未付款结束时释放**，而不是在开通时才计数。
若在开通时计数，两个买家可能都为最后一次使用付了款，其中一人付出的价格已不再被优惠券允许；
预留则保证最后一次使用在任何人付款之前就恰好归属一位买家。创建订单时先取 `entitle::lock`
（`apply_mark_paid` 开头取的同一把锁），再对优惠券行 `FOR UPDATE`，在该锁下重新检查所有规则
（每用户计数在加锁之后检查，因此买家自己与自己竞争也会被串行化），然后执行
`UPDATE coupons SET used = used + 1 WHERE … AND (max_uses IS NULL OR used < max_uses)`，
并在订单事务中插入 `coupon_redemptions`（`reserved`）；`CHECK (used <= max_uses)` 是兜底。
N 个买家争抢最后一次使用：恰好一个订单拿到它，其余得到 409 "coupon has been used up"
（`billing::tests::w16::coupon_last_use_race_and_per_user_limit`）。

- 未付款而结束的订单（取消、被新订单替换、过期、precreate 失败）在结束它的事务中释放预留
  （`orders::release_holds`）：`released`，`used − 1`。
- 已付款订单在 `apply_mark_paid` 中兑现（`redeemed`）。
- 已结束订单的**迟到付款**（支付宝收的是折后金额）会在还有名额时重新预留；若此时优惠券已用完，
  付款仍然生效：记为 `redeemed` 且 `over_limit = true`（不计数；在订单的 `order.paid` 审计行和优惠券的兑现记录中标记，供复核）。
- 对某订单折扣为 0 分的优惠券（几分钱的 1%）不会应用于该订单（不预留）。
- 被任何订单使用过的优惠券不能删除（409：请停用）。
- 带优惠码的商店预览按用户限流（30 次 / 10 分钟），防止猜码；创建订单有自己的限流（20 次 / 小时）。

### Balance (余额)

`user_balances.balance_cents`（物化值）**只能**通过向仅追加的 `balance_ledger` INSERT 来改变：
账本的触发器在余额行的锁下应用金额，结果为负则拒绝（SQLSTATE `AK003` → 409 "insufficient balance"）；
守卫触发器拒绝对该列的任何其他写入；账本行不可更新或删除（仅在用户被删除时 `user_id → NULL`；
非个人信息的 `user_label` 快照——`u-` 加 id 的前 8 位十六进制，绝不含邮箱——会保留）。
因此无论谁来写，每个用户在每次提交时都有 `balance = sum(ledger) ≥ 0`。
每一笔变动都由 `ledger::apply_entry` 写入：**一行账本 + 一行 `balance.<kind>` 审计，与其起因在同一个事务中**。

| kind | 符号 | 时机 |
|---|---|---|
| `admin_adjust` | ± | 资金 → 用户余额 → 调整（`POST /users/{id}/balance {amount_cents, reason}`），仅限客户 |
| `order_payment` | − | 订单的余额部分，在创建时扣除（冻结）；或由迟到付款重新扣取 |
| `refund_to_balance` | + | 未付款结束的订单中被冻结的余额部分；管理员退款到余额 |
| `commission` | + | 已过冻结期的邀请返利 |
| `commission_clawback` | − | 中-4：已退款订单已入账的返利从邀请人处追回（退款时按余额能扣多少扣多少，其余从之后的返利中抵扣） |
| `withdrawal` | − | 提现申请（资金冻结至审核结果） |
| `withdrawal_reversal` | + | 被拒绝或被取消的提现 |

用余额支付（`use_balance: true`）：创建订单时按余额所能覆盖的程度扣除余下金额（`balance_state` 为 `held`）。
若已能覆盖则订单立即付清；否则向支付宝请求其余部分。订单未付款结束时，余额部分退回（`refunded`）。
此类订单的迟到付款会在开通的 savepoint 内重新扣取余额；若余额已不足，订单保持
**已付款且 `fulfil_error` 为 "insufficient balance"**（余额绝不为负）：请充值余额后点「重试开通」，或退款。

### Invite commission (邀请返利)

设置（资金 → 邀请返利设置，`PUT /commission-settings`，审计 `commission.settings.update`）：
`enabled`、`rate_percent`（0–100）、`first_order_only`、`hold_days`（0–365）、`min_withdrawal_cents`。

- 归属：`users.inviter_id`（注册时凭邀请码设置——W15；迁移 0105 只保证该列存在，且绝不表达自我邀请或环，
  由触发器 `users_inviter_acyclic` 保证，SQLSTATE `AK002` → 409）。只有客户（`role=user`）邀请人才有返利。
- 被邀请客户的订单付款时（在 `apply_mark_paid` 内，因此恰好一次——`commissions.order_id` 也是 UNIQUE）：
  若返利计划已启用且支付宝实付金额 > 0（并且在 `first_order_only` 下，这是被邀请人第一笔有支付宝金额的已付款订单），
  就创建一条**待结算**返利，金额 `floor(amount_cents × rate / 100)`，在付款后 `hold_days` 天可用。
  即使开通失败也会创建（钱已收到）；退款会将其撤销。
- enforce 扫描（每个实例、每个 flush tick、`FOR UPDATE SKIP LOCKED`、以 `pending` 为条件）把到期的返利
  恰好一次地记入邀请人余额（账本 `commission`）（`billing::tests::w16::commission_exactly_once_under_duplicates`）。
  邀请人期间被删除 → 撤销。
- 冻结期内的管理员退款会撤销待结算的返利（`commission.reverse`）。
- 运营规则（运营逻辑审查中-4）：冻结期**之后**退款也会追回已入账的返利（`commission.clawback`）：
  邀请人余额够就当场扣回（明细 `commission_clawback`，负数，只追加）；不够（例如已经提现）
  只扣到 0（余额永不为负），差额记为欠款（`commissions.clawback_cents` − `clawback_recovered_cents`），
  之后该邀请人的新返利入账时**先抵扣欠款**；可提现金额把整笔追回都扣掉，所以欠款永远提不出来。
  退款确认框（`refund-preview` 的 `commission`）显示「将撤销 / 将追回、当场可扣回多少」。

### Withdrawals (提现)

可提现金额 = min(余额, 已入账返利 − 已追回返利（中-4）− 未被拒绝或取消的提现, 余额中仍是返利的部分)：退款和管理员充值的金额可用于购买套餐，但不能提现。

「余额中仍是返利的部分」（计费审查 C1，迁移 1102 `akari_withdrawable_part`）按账本顺序重放：余额分成返利部分与其他部分，
返利和提现退回进返利部分，管理员充值和支付宝部分的退款进其他部分；下单用余额时**先用其他部分**，再用返利部分，
订单未付结束或退款时余额部分按原样退回各自的部分；管理员扣减先扣其他部分，追回返利先扣返利部分。
所以花在订单上的返利不会因为之后有别的钱进入余额而重新变成可提现。
申请（`POST /me/withdrawals {amount_cents, chain, address, memo?}`，不低于 `min_withdrawal_cents`，每个用户同时只能有一个未结申请）
会立即扣除金额（账本 `withdrawal`）；管理员附原因批准或拒绝（账本 `withdrawal_reversal`）；用户在待处理时可取消。
已删除用户的提现只能批准。

**只付 USDT（PR ③ R46，迁移 1019，`billing/usdt.rs`）**：提现只能以 USDT 支付，其他收款方式（支付宝/微信/银行卡）已移除。

- 用户在门户「钱包 → 申请提现」选择网络并填写收款地址；可选网络由后台「资金 → 邀请返利设置 → 提现网络」决定
  （`commission_settings.usdt_chains`，默认全部开启）：TRC20（Tron）、Plasma、Polygon、Arbitrum One、Solana、
  X Layer、TON。地址按网络校验后才保存（填错直接拒绝 `withdrawal.address_invalid`，不会把钱打到不存在的地址）：
  TRC20 = Base58Check（`T` 开头 34 位，校验和）；Plasma、Polygon、Arbitrum One、X Layer = EVM 地址（`0x` + 40 位十六进制，
  大小写混合时校验 EIP-55）；Solana = 32 字节公钥的 Base58；TON = 用户友好格式（48 位，含 CRC，拒绝仅测试网地址）
  或原始格式 `0:<64 位十六进制>`，可选 Memo（交易所充值备注；只有 TON 可填）。
- 申请记录网络、地址、Memo 与扣除的人民币金额（`amount_cents`）。**收款地址只对用户本人与管理员可见。**
- 管理员在「资金 → 提现审核」核对网络与地址，在交易所（如 OKX）人工打款后，填写**实付 USDT 数量**（最多 6 位小数）
  与**交易哈希（txid）**通过（`POST /withdrawals/{id}/approve {usdt_amount, txid, note?}`），二者写入提现记录与审计
  `withdrawal.approved`（`usdt_micros`、`txid`）。拒绝照旧退回余额。
- 可选**参考汇率**（`usdt_rate_cents`，每 1 USDT 多少分人民币）只用于显示：门户与后台显示「约 N USDT」，
  实际打款数量由管理员按当时行情决定并如实记录。
- 迁移 1019 遇到已有提现记录的 v0.4 开发库会拒绝执行（自由文本收款账号无法可靠转换），需重建开发库。

### Refunds (admin) / 退款（管理员）

订单 → 详情 → 退款（`POST /orders/{id}/refund {reason, to_balance, external_cents?, keep_plan?,
original?, original_cents?}`），只对已付款订单、只能退一次。支付宝实付部分有**三种处理方式**：

1. **原路退回**（`original: true`，支付宝 API `alipay.trade.refund`，密钥模式）：面板直接请求支付宝把
   `original_cents`（默认全部实付金额，可部分退款）退回付款账户。每笔请求带幂等的退款请求号
   `out_request_no`（`<订单号>R<n>`）：同号重试绝不会退两次。支付宝确认后才记账（与方式 3 一样记为
   「支付渠道已退」`refund_external_cents`，同时撤销订阅效果、发退款通知）；支付宝明确拒绝（余额不足等）
   = 502 `order_admin.refund_gateway_failed`，没有退出任何钱，可重试（同金额用同一请求号）或改用其他方式；
   结果未知（网络超时等）= 202 `{pending: true}`，此时其他退款方式被拒（409 `order_admin.refund_in_progress`），
   对账循环用 `alipay.trade.fastpay.refund.query` 查询该请求号，查到即记账，查不到就用同一请求号重试
   （1 分钟起翻倍，最长 1 小时）。订单详情的 `refund_request` 显示请求号、金额、状态（pending/done/failed）、
   尝试次数与最近错误，可与支付宝账单对账。支付方式的「允许原路退款」开关（`refund_original`，默认开）
   关闭后不提供此方式（409 `order_admin.refund_original_unavailable`）；`refund-preview` 的
   `original_available` 告诉后台是否可用。审计 `order.refund.request`、`order.refund.failed`、`order.refund`。
2. **退到余额**（`to_balance: true`）。
3. **仅登记**：已在支付宝商家后台手工退款，填写实际金额（`external_cents`）。

记账在一个事务内完成：

- **钱**：订单扣的余额部分总是退回余额；勾选「也退到余额」（`to_balance`）时
  支付宝实付部分也记入余额（两者合为一行 `refund_to_balance` 明细），否则请在
  支付宝商家后台原路退款，并在面板填写**实际退款金额**（`external_cents`，0 到实付金额；
  有实付金额时必填，运营审查中-3：以前登记为 0，仪表盘与导出漏记）。订单记录
  `refund_balance_cents`（退到余额）、`refund_external_cents`（支付宝后台已退），
  `refund_cents` = 两者之和，另记 `refund_gateway_cents` = 其中支付渠道的钱
  （`to_balance` 时为整个实付金额，否则为 `refund_external_cents`；迁移 1103）。
  订单 CSV 三列都有；仪表盘按下文「Revenue」只扣渠道部分。
  待结算的邀请返利撤销，已入账的追回（中-4，见上文「Invite commission」）。
- **优惠券与首单（低-2）**：退款把该订单用掉的优惠券次数还回去（券的总次数与该用户的
  每人次数都减一；超限兑现的本来就没计数）。已退款的订单不再算「已购买」：新人券对他重新
  可用，邀请返利的「仅首单」也不把它算作首单。
- **套餐（P1）**：默认同时撤销该订单对订阅的效果，写审计 `user.plan.refund`：
  - 新购：结束该订阅（状态 `cancelled`），用户的节点凭据随即撤销，agent 断开其连接；
  - 续费：到期时间回退该订单增加的时长（开通时记录 `base`，回退量 = 本单到期 −
    `base`）；回退后不晚于当前时间则结束该订阅；
  - 换套餐（含补差价升级）：结束新订阅，恢复换之前的订阅（原套餐、原到期时间；
    换之前已用的流量加回当前用量）；原订阅在此期间已过期则只结束新订阅；
  - 流量重置包：只退钱（已用流量无法撤销）；
  - 订单未开通、或它开通/续费的订阅已不是当前订阅（之后又换了套餐等）：只退钱。
- 勾选「仅退款（保留套餐）」（`keep_plan: true`）则只退钱，套餐不动。
- **退款通知邮件**：同一事务（savepoint，发信失败不影响退款）给用户发 `refund` 邮件：退款总额、
  退回余额 / 原路退回的金额、套餐被怎样处理（已取消 / 到期时间回退到 X / 恢复原套餐 /
  不受影响 / 未开通）。系统设置 → 邮件 →「订单退款通知」开关（`notify_refund`，默认开）；
  只发已验证邮箱；模板可在「邮件模板」里改（种类 `refund`，`{order_no}` 必填）。
- 确认框里的效果来自 `GET /orders/{id}/refund-preview`（`{balance_part_cents,
  amount_cents, effect}`，`effect.kind` = `none`（带 `why`）/`cancel`/`rollback`/
  `restore`），与实际执行用同一段计算；已退款或未付款的订单 409。
- 退款后订单不能再「重试开通」。订单详情显示 `refund_effect`（套餐被怎样处理）。
  审计 `order.refund`（含 `effect`）。

### Revenue（营收口径）

营收 = 经支付渠道实际收到的钱。余额、换套餐抵扣、优惠券、赠送部分**都不是营收**
（余额来自退款、返利或管理员加款，充值不存在；用余额付款只是花掉已记过账的钱）。

- **实收**（`gross_cents`）：窗口内付款的订单的 `amount_cents`（按 `paid_at`）；
- **退款**（`refunds_cents`）：窗口内退款的订单的 `refund_gateway_cents`（按 `refunded_at`，
  不管订单哪天付的款）：原路退款、支付宝后台手工退款、退到余额的渠道部分都算；
  退回的余额部分不算（它本来就不是营收）；
- **净额**（`revenue_cents`）= 实收 − 退款，可以为负（当天退的比收的多）。

日界为站点时区的日（Q3）。仪表盘「今日营收」显示净额，悬停/展开可看今日、7 天、30 天的
实收 / 退款 / 净额；订单 CSV 用 `amount_cents`（实收）与 `refund_gateway_cents`（退款）
可按同一口径自行汇总。人工订单的实付算营收（`manual_cents` 是实收里的人工部分），
赠送不算（`gift_cents` 单列）。

### Manual orders (Ops)（人工订单）

`POST /orders/manual {user_id, plan_id, period, gift?, reason}`（控制台：订单 → 新建人工订单）用于记录网关之外的销售或赠送。
它**不是新的支付路径**：订单行的创建方式与客户订单一致（该周期价格在 SQL 中从 `plan_period_prices` 读取并复制到
`list_price_cents`；请求不带金额，带 `amount_cents` 成员则返回 400），然后在同一事务内由
`orders::apply_mark_paid(…, Via::Manual, …, reason)` 付清——`entitle::lock`、条件翻转（恰好一次）、
savepoint 内开通、`order.paid` 审计。赠送会令 `gift_cents` = 标价（迁移 0166；金额恒等式变为
`amount = list − credit − discount − balance − gift`），于是 `amount_cents` = 0，收入（`amount_cents` 之和）不变。
已付款的人工订单是标记为 `paid_via = 'manual'` 的收入：仪表盘按时间窗口报告 `manual_cents` 和 `gift_cents`，
订单列表可用 `?via=manual` 过滤，CSV 有 `manual` 列。与网关付款不同，开通失败的人工订单
（套餐已不存在、售罄、重置包没有对应套餐）会整体回滚（409 `order_admin.manual_not_fulfilled`）；
有待付款订单的用户会得到 409 `order_admin.user_has_pending`。邀请返利像对待任何付款一样适用于已付款（非赠送）的人工订单。

### Batch coupons (Ops)（批量优惠券）

`POST /coupon-batches` 生成 N（≤5000）个共用一个模板的码：`prefix`（0–16 个 `A-Za-z0-9_-`）加 `length`（6–16，默认 10）个字符，
字符来自操作系统 CSPRNG，取自 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（无 0/O/1/I；32 个符号，每个 5 位，无取模偏差）。
每个码都是带 `batch_id` 的普通 `coupons` 行（迁移 0167），因此资格检查、创建订单时的无竞态预留、释放与兑现都沿用 W16 的路径；
唯一性由 `coupons_code` 唯一索引保证（`ON CONFLICT DO NOTHING`，冲突时重新生成，轮数有限）。每个码的使用次数默认为 1。
单张优惠券列表隐藏批次内的码；批次列表显示 码数/已用/已兑现，可把码导出为 CSV，撤销批次会停用其中所有码
（已做的预留仍然有效）。

### Lock order（加锁顺序）

`entitle::lock`（创建订单和 `apply_mark_paid`）→ `orders` 行 → `coupons` / `coupon_redemptions` → `commissions` →
`user_balances` → `withdrawals`。返利扫描和提现绝不会在取得靠后的锁之后再取靠前的锁。

## Configuration (系统设置 → 支付)（配置）

**只能通过界面配置**（存数据库，所有实例同时生效；无需重启）：

1. 系统设置 → 支付 → 添加支付方式 → 支付宝当面付.
2. 名称（启用多个支付方式时展示给付款人）、排序。
3. 环境：正式（`https://openapi.alipay.com/gateway.do`）、沙箱
   （`https://openapi-sandbox.dl.alipaydev.com/gateway.do`）或自定义网关（https；仅回环地址可用 http——测试 mock）。
4. APPID、商户 PID（可选；设置后通知必须携带它）、订单有效期（5–120 分钟）。
5. 应用私钥：粘贴（PEM，或支付宝密钥工具写出的裸 base64，PKCS#8 或 PKCS#1 均可），或在浏览器中加载文件。
   系统会校验（RSA，≥ 2048 位），然后加密存放（AES-256-GCM，密钥由 `data/master.key` 以标签
   `akari/payment-secrets-aead/v1` 派生，AAD = 支付方式 id），并且**绝不回显**：页面显示「已设置」、
   应用公钥的 SHA-256 指纹以及推导出的**应用公钥**（SPKI base64），供上传到支付宝开放平台。编辑时留空即保持不变。
6. 支付宝公钥：粘贴支付宝的公钥（不是应用公钥：粘贴应用公钥或任何私钥都会被拒绝并返回错误码）。
7. 启用、保存，然后点**测试连接**：用随机的 `out_trade_no` 发起一次 `alipay.trade.query`。
   支付宝只有在核对完 APPID 和我们的签名（= 应用私钥与在支付宝登记的应用公钥匹配）之后，才会返回 `ACQ.TRADE_NOT_EXIST`，
   并用其密钥对该应答签名（= 所配置的支付宝公钥正确）：`keys_ok`。其他结果以中文提示：
   APPID 无效 / 环境错误、请求签名被拒绝（请上传所示的应用公钥）、应答签名无效（支付宝公钥错误）、网关不可达 / HTTP 错误。
   2026-10-03 已在真实沙箱上测试：`keys_ok`。 Other outcomes, in Chinese:
   APPID invalid / wrong environment, request signature rejected (upload
   the shown 应用公钥), response signature invalid (wrong 支付宝公钥),
   gateway unreachable / HTTP error. Tested against the real sandbox
   2026-10-03: `keys_ok`.

规则（`billing::methods`、`provider::ProviderKind::validate`）：

- 每次变更都带版本（`version`，表单过期 → 409 `settings.version_conflict`）并被审计
  （`payment_method.create` / `.update` / `.delete` / `.import`；密钥字段只记为 `"changed"`，
  非密钥配置——公钥、APPID——明文记录）。0060 触发器函数通知所有实例，各实例重建变更的支付方式的客户端，
  并原子地替换整个集合；进行中的调用继续使用它已取得的客户端。启用要求配置能够构建成功。
- 被任何订单使用过的支付方式不能删除（409 `payments.method_in_use`）：请停用。停用会停止新订单、
  notify 路由（返回规范拒绝）以及对其待付款订单的对账；已付款订单不受影响。
- **密钥轮换。**订单从不存储密钥，因此进行中的订单在换密钥后仍可继续。新的应用私钥立即生效
  （请先在支付宝上传新的应用公钥，否则在此之前请求都会失败）。被替换的**支付宝公钥**在 48 小时内
  （`PREV_KEY_GRACE_HOURS`；支付宝对通知重试约 25 小时）仍可用于验证（通知和网关应答），
  因此轮换前不久用旧密钥签名的通知仍能结算其订单；宽限期之后它会像任何错误签名一样被拒绝
  （此后轮询/对账使用新密钥）。更改某支付方式的 APPID 会使其待付款订单的通知失效（`app_id` 不匹配 → 拒绝）；
  轮询/对账则使用新 APPID 查询。给新商户请优先新增一个支付方式。
- **Notify URL**（只读显示）：`<main domain>/pay/<method id>/notify`（不带管理前缀的公开路径：D11），
  主域名取自 系统设置 → 站点（W25：唯一来源；旧的 `install.public_url` 会一次性导入到那里）。
  它随每次 precreate 一起发送，因此无需在支付宝侧配置，并会随域名变更自动更新（轮换管理前缀不影响它）。
  未配置主域名时，需要渠道参与的订单会被拒绝（503 "payments are not enabled"，不创建订单行；
  被折算额完全覆盖的订单仍可用），系统设置 / 启动日志会给出警告。主域名变更之前创建的订单带有旧 URL；
  此时 Host 闸门会拒绝发往旧域名的通知，由轮询/对账来开通这些订单。该 URL 绝不写入日志。
- 仅支持公钥模式、**RSA2**（不支持证书模式）。
- 支付宝必须能通过互联网访问 notify URL（经你的反向代理走 HTTPS，且代理转发所有路径，见 DEPLOY.md）。
  若做不到（开发环境、防火墙），付款仍会通过轮询和对账被发现——notify 只是让它更快。
- 面板直接连接网关（不支持 HTTP 代理），使用 webpki 根证书库。

**从 panel.toml 升级（已废弃的 `[payments.alipay]`）。**该段已不再属于配置。旧文件仍可启动：
当数据库中**没有任何支付方式**的首次启动时，该段（及其两个密钥文件）会被一次性导入为名为「支付宝」的支付宝支付方式
（审计 `payment_method.import`，操作者 `system`，密钥按上述方式加密存放），并且所有 0140 之前的订单
（`payment_method_id` 为 NULL、金额 > 0）都会归属于它；日志会提示删除该段。此后它会被忽略并给出启动警告，
`config check` 报告它已废弃，系统设置 → 支付 在其存在期间显示警告。若密钥文件无法读取，则跳过导入
（警告）并继续启动：请在界面中配置支付方式。旧的显式 `notify_url` 已取消；升级前创建的订单保留旧 URL
`/pay/alipay/notify`，该路径仍被接受（见下）。

### Adding a provider kind (developers)（新增渠道类型，面向开发者）

实现 `provider::PaymentProvider`（创建 → 二维码或跳转 URL、查询、关闭、verify_notify、notify_ack、可选的退款、test_connection）
和 `provider::ProviderKind`（id、中文名称、表单 schema、缺省时保留密钥字段的 validate、build、不含密钥的视图、
peek_out_trade_no），把它加入 `provider::KINDS`，在新的迁移中放宽 `payment_methods.kind` 的 CHECK，
并在该类型新增错误码时扩展 SPA 的错误映射。金额规则留在 `orders.rs`/`api.rs` 中，不随类型而变。

## Notify endpoint rules（通知端点规则）

`POST /pay/{method_id}/notify`（按支付方式；未知、格式错误或已停用的 method id 一律返回规范拒绝）以及旧的
`POST /pay/alipay/notify`（R40 之前的订单：由声明的 `out_trade_no` 选出订单，进而确定其支付方式，该方式必须是可用的支付宝方式）。
表单编码，≤16 KiB，≤64 个参数，无重复键，按来源地址（/64）在 Valkey 中限流 120/min（故障时放行）。
依次检查：RSA2 签名（除 `sign`/`sign_type` 外的所有参数，URL 解码后排序；保留空值，或像某些支付宝 SDK 那样丢弃空值——
两种都在支付宝的签名之下；使用当前的支付宝公钥，或宽限期内的上一把）、该支付方式的 `app_id`、
`seller_id`（若已配置）、**属于该支付方式的** `out_trade_no`（`orders.payment_method_id`——签名有效但被路由到方式 A 的通知
绝不会结算方式 B 的订单：`unknown_order`）、`total_amount` = 订单金额（严格解析十进制并换算为分）。
`TRADE_SUCCESS` / `TRADE_FINISHED` → 已付款；其他状态只确认而不产生影响。

应答：只有对我们订单的已验证通知才返回 `success`（text/plain）；**所有**拒绝都是规范拒绝
（`reject::not_found()`：404、空正文，与任何未知 URL 字节级一致），因此支付宝会重试，且端点的任何信息都无法被探测。
每个通知——无论是否验证通过——都会留下一行 `payment_events`（结果为 `bad_signature`、`app_id_mismatch`、
`seller_id_mismatch`、`unknown_order`、`amount_mismatch`、`malformed`、`oversized`、`paid`、`paid_unfulfilled`、
`duplicate`、`ignored`）；`sign` 的值只存为 `<redacted>`。对真实订单的已验证但有误的通知也会被审计
（`order.payment.rejected`）。未验证的事件在审计保留期（系统设置 → 安全）之后清理；已验证的保留。

同步应答（precreate/query/close）同样会被验证：签名覆盖所收到的原始 `<method>_response` JSON 字节；
未签名或签名错误的成功应答视为错误。

## Audit actions（审计动作）

Ops 新增：`order.create` + `order.paid`（人工订单，`after.manual`、`reason`）、`coupon.batch.create`（模板 + 数量，绝不含码）、
`coupon.batch.revoke`、`export.orders` / `export.users` / `export.traffic` / `export.coupon_batch`（过滤条件）、
`user.batch.create` / `user.batch.cancel`，以及每个用户上该动作自身的记录
（`balance.admin_adjust`、`user.update`、`user.plan.*`、`user.traffic.reset`、`user.mail.send`（仅主题））。


`plan.price.set`、`plan.price.delete`、`order.create`、`order.cancel`、`order.expire`、
`order.paid`（通知/查询时操作者为 `alipay`，人工付款时为管理员；包含开通结果）、`order.fulfil.retry`、
`order.payment.rejected`，外加套餐变更自身的 `user.plan.set` / `user.plan.renew` 记录。
W16：`order.refund`（P1：撤销订阅时另有 `user.plan.refund`）、`coupon.create` / `coupon.update` / `coupon.delete`、
`commission.create` / `commission.reverse`、`commission.settings.update`、
`withdrawal.approved` / `withdrawal.rejected` / `withdrawal.cancelled`，以及每行账本对应一行 `balance.<kind>`（kind 同账本表）。
W24：`payment_method.create` / `.update` / `.delete` / `.import`。`payment_events.payment_method_id` 记录订单所用的支付方式。

## Reconciliation (operator)（对账，运维）

- 订单 → 筛选「已付款未开通」：需要处理的已付款订单。
- 订单详情列出每个支付事件（来源、验证情况、结果、支付宝交易状态、来源地址）。
- 每日：把已付款订单（`status='paid' AND paid_via <> 'manual'`、`trade_no`、`paid_amount_cents`）
  与支付宝商户对账单（账单）核对；SQL：

```sql
SELECT out_trade_no, trade_no, amount_cents, paid_amount_cents, paid_at, user_label,
       (SELECT email FROM users WHERE id = orders.user_id) AS user_email, plan_name
FROM orders WHERE status = 'paid' AND paid_at >= date_trunc('day', now() - interval '1 day')
ORDER BY paid_at;
```

## Sandbox（沙箱）

- 沙箱网关（官方，2023-05 沙箱升级后）：`https://openapi-sandbox.dl.alipaydev.com/gateway.do`。
  沙箱 APPID、密钥和买家账号在支付宝开放平台控制台（开放平台 → 控制台 → 沙箱）。
  请用沙箱版支付宝（沙箱版支付宝）登录沙箱**买家**账号来付款。
- 本地面板（如 `http://myapp.test:8080/`）无法接收沙箱的通知；状态轮询和对账会通过 `alipay.trade.query`
  发现付款（同一条恰好一次的路径）。
- 在 系统设置 → 支付 中选择 环境 = 沙箱，并粘贴沙箱 APPID 和密钥。
- 实机检查（被忽略的测试；按路径读取凭据文件——默认 `~/secrets/alipay-sandbox{.env,-app-private.pem,-alipay-public.pem}`，
  可用 `AKARI_ALIPAY_LIVE_{ENV,KEY,PUB}` 覆盖——文件不存在时跳过，只打印结果，绝不在 CI 中运行）。
  `live_sandbox` 直接驱动客户端；`live_sandbox_db_configured` **通过管理 API** 配置一个支付方式
  （数据库、加密密钥），执行 测试连接，并用该客户端发起一次 precreate：

```bash
cargo test --lib live_sandbox -- --ignored --nocapture
```

**结果 2026-10-03（W24）**：两个实机测试在真实沙箱上均通过：测试连接 `keys_ok`
（签名的 `ACQ.TRADE_NOT_EXIST` 已用沙箱支付宝公钥验证）、precreate 0.01 元 → 二维码、query → 未支付、close，
以及错误的支付宝公钥 → `BadSignature`。

**结果 2026-10-02**（本开发机、真实沙箱网关、密钥取自 `~/secrets`、未提交任何内容）：
`alipay.trade.precreate` 0.01 元 → `code 10000`，返回 `https://qr.alipay.com/...` 二维码，
应答签名已用沙箱支付宝公钥验证；对未扫码订单的 `alipay.trade.query` → `40004 ACQ.TRADE_NOT_EXIST`（映射为「未支付」）；
`alipay.trade.close` → `ACQ.TRADE_NOT_EXIST`（无需关闭）；同一个 query 用错误的支付宝公钥验证 → 被拒绝（`BadSignature`）。
沙箱网关间歇性地返回**带 HTML 页面的 HTTP 404**（大约每 4 次调用出现 1 次），因此每次网关调用在传输错误 / 非 200 应答时
最多重试 3 次（三种调用按 `out_trade_no` 都是幂等的），之后订单保持待付款，由轮询/对账继续重试。加入重试后，多次实机运行均通过。
已扫码但未付款的交易（`WAIT_BUYER_PAY`）和真实的 `TRADE_SUCCESS` 需要沙箱应用，未做实机验证；它们由 mock 网关测试和 smoke 覆盖。

## Tests（测试）

- `billing::alipay::tests`：金额、规范字符串、openssl 生成的签名向量、PKCS#1/PKCS#8/裸 base64 密钥、
  密钥错误（过短、把私钥当公钥、把应用公钥当支付宝公钥）、上一把支付宝公钥的宽限期、测试连接的各种结果、
  通知与应答验证（原始字节、`\/` 转义、篡改、未签名的成功、已签名的业务错误）。
  `billing::provider::mock`：用 mock provider 测试 trait 对象。
- `billing::tests::w24`（真实数据库 + mock 网关）：支付方式 API（带错误码的校验错误、AAD = id 的加密存放密钥、
  绝不回显或审计、乐观并发、测试连接、轮换宽限期、停用 = 规范拒绝、仅未使用时才能删除）；两个支付方式
  （选择器错误、跨方式通知隔离、旧通知路径、按方式对账）；不可读的密钥；在另一实例上重载
  （LISTEN/NOTIFY、原子替换）；旧 panel.toml 导入。
- `billing::tests`（真实数据库 + 校验面板请求签名的本地 mock 网关）：基于轮询开通的 HTTP 购买流程、
  规范的通知拒绝、并发重复通知 + 查询、带节点 bump 与通知的续费/替换、开通失败 + 管理员重试 + 手动标记已付款、
  对账过期与迟到付款、每用户一个未结订单、配置校验、密钥文件权限。
- `billing::tests::w16`（真实数据库）：SQL 金额函数与其 Rust 镜像；优惠券规则、预览、取整、管理 API；
  最后一次使用的竞争与每用户限制；过期时的释放和迟到付款（超限）；账本不变量（触发器、仅追加、并发消费绝不透支）；
  全额/部分余额支付、取消/过期时的退款、余额已花掉时的迟到付款；退款；返利生命周期（待结算 → 由 enforce 扫描入账、仅首单、
  被退款撤销、优惠券/余额部分不产生返利、管理员邀请人、已删除的邀请人）；重复通知/查询与并发入账扫描下恰好一次；提现；
  每次资金变动一行账本 + 一行审计（表驱动）。`api::tests::every_access_change_bumps_affected_nodes`
  有一行余额调整（资金变动，不 bump 节点）。
- fuzz 目标 `billing_input`（docs/FUZZING.md）。
- `smoke.sh` "W16"：由签名通知付清的优惠券订单、该优惠券的最后一次使用被拒绝给另一买家、返利待结算 → 经 SQL 时间穿越后入账、
  提现批准、余额支付与部分余额支付的订单（取消会退回余额部分）、退款到余额、SQL 中的账本不变量。
  e2e "W16"：控制台优惠券 + 余额调整，用户用优惠券 + 余额购买（无需网关即可付清）。
- `smoke.sh` "R18-3"：用 openssl 生成的一次性密钥、Python mock 网关，定价 → 下单 → 被篡改 / 金额错误的通知 = 规范拒绝 →
  签名通知 → 套餐生效 → 经节点的 VLESS 往返 → 重放为空操作 → 通过轮询续费（+30 天）。
  W24：mock 网关通过管理 API 添加为支付方式（应用公钥当支付宝公钥被拒绝，密钥加密存放且绝不出现在视图/审计中，
  测试连接 `keys_ok`），通知走按方式的路由，W16 订单经旧路径结算，`config check` 列出各支付方式且密钥已脱敏。
  e2e "W24"：从已废弃的 panel.toml 段导入的支付方式、对不可达网关的测试连接、在表单中添加第二个支付方式、结账时的选择器。
