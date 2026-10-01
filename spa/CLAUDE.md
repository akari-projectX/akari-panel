# akari-panel/spa — 前端

React 19 + Vite 8 (Rolldown) + Tailwind 4 + TanStack Query 5；shadcn 风格组件为手拷代码（`src/components/ui/`）。
构建产物 `dist/` 被 rust-embed 编进二进制，只在 `/{prefix}/app` 下提供。改完前端必须 `make spa && make panel` 才生效。

## 结构

- `src/lib/api.ts` — fetch 封装与 API 类型（手工镜像 `src/api.rs` 的 View 结构，改后端字段要同步）。`appBase`/`apiBase` 从 `location` 推导，**不内嵌前缀**。
- `src/lib/router.ts` — 极简 history 路由，无路由依赖。
- `src/pages/` — `login`（含可选的验证码字段：TOTP 或恢复码）、`admin-users`（2FA 列 + Reset 2FA / 无 2FA 的 admin 用 "2FA code"，返回的一次性注册码只显示一次）、`admin-nodes`（R18-2，中文：节点列表（状态/地区/地址/Agent/租约剩余/证书/心跳/警告）、`NodeWizard` 新建向导（协议模板行 `TemplateRows` + 「检测目标站点」+ 高级 JSON）→ `InstallCard`（一行安装命令 + 复制、倒计时、pin 说明、警告、手动 bootstrap）；「重装命令」/「bootstrap」/停用（确认）/删除（确认）；`NodeEditor` 以 `key={node.id}` 挂载（F1），基础信息与入站各自的错误提示（F4），入站表 + 从模板添加（`/inbound-templates/render`）+ 高级 JSON；测试 `admin-nodes.test.tsx`）、`audit`（管理员审计视图，keyset 翻页）、`two-factor`（`EnrollPage` = enroll 会话的全屏引导；`enroll_code_required` 时要求输入注册码，`TwoFactorCard` = 账户页/门户的 2FA 卡片）、`portal`（含"新订阅链接"；M3：`PlanCard` = `/me/plan` 套餐/周期/下次重置/节点名+地区，`PasswordCard` = `/me/password`，管理员的 Account 页也有）、`admin-plans`（M3：套餐 CRUD、节点组 CRUD + 成员勾选）；`admin-users` 有 Plan/Resets 列、`UserPlanForm`（分配/更换/取消套餐，不提供已退役套餐）、禁用原因。
- M6：`admin-updates`（Updates 视图：发布上传 = manifest + sig + 二进制三文件，`putBinary` 原始 body；rollout 创建（版本、百分比、waves、超时、失败比、可选节点子集）、列表 5s 刷新、展开看每节点状态、pause/resume/abort 只在合法状态显示）；`admin-nodes` 的 Agent 列显示平台与最近一次 rollout 状态。测试 `src/pages/m6.test.tsx`。
- R18-3 支付：`purchase.tsx`（`Billing` = 商店 + `PaymentPanel`（二维码、3s 轮询、取消）+ `orders.tsx` 我的订单；用户页中英双语，文案暂在 `pages/billing-i18n.ts`（`billing.zh/en` + `useBillingT` 垫片，合并 W2 i18n 时迁入其词典并换成 `useT`））、`admin-orders.tsx`（后台仅中文：套餐定价（元↔分整数换算 `lib/billing.ts` `yuan`/`parseYuan`）、订单筛选/翻页、详情 + 支付事件、人工确认/重试开通需原因）；二维码只在 `components/pay-qr.tsx` 生成（依赖 `uqr`，零依赖 MIT，本地渲染 SVG，无 CDN）；类型在 `lib/billing.ts`。测试 `pages/billing.test.tsx`。
- 会话阶段：`/me` 401 时探测 `/me/totp`，`stage === "enroll"`（无 2FA 的管理员）则只显示 `EnrollPage`；秘密与恢复码只在生成那次响应里出现，界面不缓存它们。
- `src/components/ui/` — button/input/card/table/badge/label。

## 规则

- REST 请求走 `lib/api.ts` 的 `get/post/put/patch/del`，它们固定拼 `apiBase`（= `/{prefix}/api/v1`）。
  **后端 `/auth/*` 不在 `/api/v1` 下**：登录/登出只能用 `login()`/`logout()`（拼 `authBase` = `/{prefix}/auth`，由 `appBase` 推导）。
  守卫：`scripts/check-auth-paths.mjs`（`make check` 与 smoke 都会跑）+ smoke 对打包 JS 的 grep。登出失败必须可见；成功后 `lib/session.ts` 的 `resetAfterLogout()`（`clear()` 不通知观察者，界面会停在仪表盘）。Node >= 22.18。
- Vite 产出的资源必须以 `/assets/` 开头（spa.rs 靠这个做前缀改写）；不要改 `base`。
- CSP 为 `default-src 'self'; style-src 'unsafe-inline'`：禁止内联脚本和外部 CDN。
- 测试（M3）：vitest 5 + @testing-library/react（jsdom），`src/**/*.test.tsx`，`src/test/harness.tsx` 提供按 "METHOD /path" 应答的假 fetch 与 QueryClient；`make check` 与 CI spa job 都跑 `npx vitest run`。测试文件不被应用导入，不进包。
- 前端形态（PLAN 决策点，M3 定案）：维持**单 SPA、按角色视图**（理由见 PLAN.md 决策表）。
- 验收：`npx tsc --noEmit` + `npx vitest run`；UI 从未在真实浏览器中验证过，改动后需要人工打开 `/{prefix}/app` 检查。
