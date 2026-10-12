# 截图集（设计稿对比用）

`zz-screens.spec.ts` 在 e2e 最后跑，按区域文件取镜头，对每个镜头拍 **桌面 1440×900 + 手机 390×844@2x × 浅色 + 深色** 四张，写到 `test-results/screens/<名称>-<desktop|mobile>-<light|dark>.png`（CI 工件 `admin-screens`）。组长把它们与 `design/admin-redesign-2026-10/screenshots-v2/` 同名文件并排放进 `compare/`。拍不到的镜头只记录（日志 + 测试注解），不让用例失败。

## 文件

- `shared.ts`：类型 `Shot` / `Ctx`、打开辅助（`go(path)`、`goto(page, path)`、`goDialog(c => path)`、`need(id, "说明")`、`ready`）、公共数据 `buildCtx`（自建一个用户 + 套餐 + 人工订单、一个节点 + 中转入口；`ctx.userId`、`planId`、`orderId`、`nodeId`、`serverId`、`entranceId`）。
- `seed.ts`：在任何镜头之前造一份"像样的"数据（`seed(ctx)`，约 10–20 秒）：两台在线服务器（Valkey 心跳 blob、24 小时分钟指标 + 7 天小时指标、30 天入口流量含中转；在线 = status online 且 90 秒内刷新，所以拍摄期间每 20 秒续一次，`stopSeed()` 结束）、节点组 + 三个套餐、15 个客户（注册日期、用量、到期、最后登录各不相同）、60 天内约 40 张订单（新购 / 续费 / 换套餐；支付宝与人工；待付款、已过期、已取消、已退款、一张已付款未开通）、两张优惠券及兑换、邀请返利（已入账 / 冻结 / 已撤销）、提现（待审 / 已通过 / 已拒绝）、共享用户的通行密钥、system 审计行、有已上传的 linux/amd64 发布时一个进行中的灰度。只用真实 API，API 造不出的状态（过去的时间、网关付款、agent）用 SQL 写，遵守表的 CHECK 与不变量（余额只经 `balance_ledger`）。每次运行带随机标记，互不冲突。把 id 放进 `ctx.extra`（`liveServer`、`unfulfilledOrder`、`pendingOrder`、`inviter`、`rollout`）。
- `<区域>.ts`：`ops`、`people`、`commerce`、`nodes`、`settings`、`support`（与 `prototype/scripts/shots/*.json` 同名；`support.json` 的 tickets-/content- 镜头在 `support-content.ts`）。每个文件导出：
  - `shots: Shot[]`——`{ name, open(page, ctx, device), full?, devices? }`；
  - 可选 `setup(ctx)`——为本区镜头造数据（经 `apiJson`），把 id 放进 `ctx.extra`。

## 规则

- `name` = v2 PNG 文件名去掉 `-<device>-<theme>.png`（例如 `users-detail-overview`），与 `screenshots-v2/` 完全一致，不要自造名字。
- `open` 用真实地址（真实的 `?open=`、`?tab=`、子路由）和真实操作打开画面，并等到画面出现（`go`/`goto` 会等 `main[data-ready]`，弹窗再等 `getByRole("dialog")`）；需要的数据不存在时 `throw`（用 `need`），该镜头记为未拍。
- `full: true` 对应 v2 镜头的 `fullPage`（把视口拉到页面高度，最高 6000px）。
- 拍不了的 v2 镜头（`?state=loading|error` 这类无法稳定重现的状态、原型专用的演示）不要加，在报告里列出。
- 四种变体并行（每种一个浏览器上下文，所有镜头复用），总时长受 `SCREENS_BUDGET_MIN`（默认 10 分钟）限制，超时剩下的镜头记为"skipped (time budget)"。每个镜头尽量快：不要多余的等待。
- 本地不跑 e2e（只在 CI）；调试时可用 `SCREENS_ONLY=people,nodes`、`SCREENS_MATCH=detail` 缩小范围。
