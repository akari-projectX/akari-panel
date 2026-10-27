# portal/ — 门户 v2（Svelte 5）

用户门户（brief：工作区 `briefs/portal-v2.md`；样稿 `design/portal-v2-2026-10/`）。v2.0.0 起它就是门户：面板只下发 `dist/app`
（`src/spa.rs`），原来的 React 门户已删除（功能对照与 e2e 覆盖表见 PR #150）。

## 外观 = v1.4.0（门户外观恢复，PR #160）

门户 v2 的外观已**整体恢复为 v1.4.0 React 门户**（2026-10-26 用户裁决，见工作区 `briefs/portal-restore.md`：v2 样稿的新外观作废，只保留 Svelte 的性能与架构；新 Logo 除外）。
逐页参照图在 `design/portal-v1-reference-2026-10/screens/`，恢复报告（对照图、几何差异、剩余差异及原因）在 `design/portal-restore-2026-10/REPORT.md`。
改外观时先对照 v1.4.0 源码（`git show v1.4.0:spa/src/...`），不要凭样稿。

- 样式分层：`src/app.css`（外壳、对话框、阅读弹窗、切页）、`src/styles/flat.css`（v1.4.0 的版式零件：`PageTitle`、`StatRow`、`Section`、`Row`、`Tabs`、`Split`、
  `.bdg` 徽章、`.wtbl`、`.nstate` 等）、`src/styles/pages/*.css`（用户中心各页的版式与表格 `.tbl` 等，原 pages.css 按「哪些页面用」拆开：`common.css` 多数页要的（它 `@import` 了 `styles/flat-dash.css`）、`rest.css` 除仪表盘外的页面共用的、`dashboard.css`/`shop.css`/`order-detail.css`/`wallet.css`/`traffic.css`/`account.css`/`nodes.css` 一页独用的；common/rest 由 `lib/pages.ts` 的 `withCss` 在页面分包之前动态引入（Vite 不保证共用 CSS 先于页面 CSS 进 `<head>`；`withCss` 按调用顺序先插 common、rest 再插页面自己的），各 `pages/*.svelte` 只 import 自己的那份，只由登录后的页面分包带，不进首屏 CSS；规则的相对顺序与层包装不变，拆分时要核对「先出现的专页规则不能被后出现、改成先加载的共用规则反超」，新规则放进只有它的使用者会加载的文件，多页共用的放 common）、`styles/flat.css` 只留访客页也要的几条（其余在 `flat-dash.css`）、`tokens.css`（颜色只能写在这里，`check:colors`）。
  页面用 `components/flat/*` 拼，不再手写 `.ph` / `.kpis` / `.banner` / `.li` / `.cols` / `.sh`（已删除）。
- 图表（`components/charts/`：`AreaChart`、`BarChart`、`Donut`、`ChartTip`、`Legend`，`lib/rechart.ts`）是手写 SVG，复刻 recharts 的外观（刻度、单调曲线、渐变、提示框），不引入图表库。
- 下拉用 `components/ui/Select.svelte`（bits-ui，v1.4.0 的 shadcn Select 外观，高 32px）；对话框三种：流程（图标 + 标题 + 说明，底部按钮栏）、确认（`alert`，420px）、
  **阅读**（`reading` + `meta` 片段：公告、工单对话，宽 640，只有正文滚动）。弹窗开着时 `lib/visual-viewport.ts` 把可见视口写进 `--vv-h` / `--vv-top`，
  手机弹出软键盘时弹窗挪到键盘上方。
- 切页：旧页面淡出（`--dur-exit` 100ms）→ 回到页首 → 新页面淡入（`App.svelte` 的 `shown` / `leaving`、`.page.out`）；换页的回到页首由它做，`navigate` 只在同一页内改查询串时立刻回到页首；
  系统要求减少动效时直接换页。
- 对照工具（不进仓库）：并排起 v1.4.0 的 Vite 开发服务器与本应用，按文字锚点比较每个文字块的位置、尺寸、字体、颜色；CI 的 `e2e/zz-screens.spec.ts` 按参照图的名字出对应的截图（`portal-screens` 工件，含真实 seed 数据）。

## 架构与理由

- **Vite + Svelte 5（runes）+ Tailwind 4，手写的小路由，不用 SvelteKit**：SvelteKit 的静态 / SPA 产物靠内联 `<script>` 启动，
  面板的 CSP 是固定的 `'self'`（无 hash、无 nonce），那张页面跑不起来。路由约百行（`src/lib/router.svelte.ts`、`pages.ts`），首屏也更小。
- 页面表 `src/lib/pages.ts`：地址 → 按需加载的页面、布局（dash 要登录 / guest 已登录就跳走 / public 谁都能看）、标题；`/orders/:id`；
  旧地址 `/invite` → `/wallet?tab=invite`；找不到 = 404 页。门禁在 `App.svelte`（与 React 的 RequireAuth / GuestOnly / RequireScope 相同）。
- **路由表 `src/lib/routes.ts`**：面板测试 `access::tests::routes_match_the_portal` 读它（`export const R = {` 到 `} as const;`
  之间的单引号路径），加路由要和 `access::PORTAL_PAGES` 一起改。
- **与框架无关的共用模块在 `src/shared/`，别名 `@/`**（从 React 门户原样搬来，后台 `admin/` 也引其中一部分）：`@/api`（整个接口层）、
  `@/i18n/dict`（英文词典，按需加载）、`@/i18n/errors`、`@/lib/format`、`@/lib/cache`、`@/lib/traffic`、`@/lib/node`、`@/lib/sub-links`、
  `@/lib/content-text`、`@/lib/doc-categories`、`@/lib/shop`、`@/lib/confetti`、`@/data/platforms`；
  `$lib/` = 本应用自己的代码（`src/lib/`）。
- 默认 Logo = L3 小写 akari 字标（`src/components/Wordmark.svelte`、`index.html` 启动画面里同形的 SVG，颜色 `--logo-ink` / `--logo-dot`；favicon `src/assets/favicon.svg`、`apple-touch-icon.png`；源文件 `design/portal-v2-2026-10/logo/`）；站长上传了 Logo / favicon 时用站长的。
- 外壳（`src/components/`、`src/layouts/`）：顶栏导航、邮箱下拉、窄屏全屏菜单都是手写的、完整无障碍（menu button 模式：↑↓ Home End、
  Esc 还焦点、Tab 关闭、点外面关闭；全屏菜单是模态对话框：焦点困在「关闭按钮 + 菜单」、Esc、锁滚动、切页 / 变宽自动收起；
  aria-expanded / aria-controls；减少动效；指针 / 触摸打开时焦点在菜单容器上（不画焦点环），键盘（click 的 detail 为 0）打开时在第一项上）。
  不为外壳引入 bits-ui，首屏更小。
- **bits-ui 只用于真正需要的原语**：对话框（`src/components/ui/Dialog.svelte`：焦点困住、Esc / 遮罩、锁滚动、还焦点；`dismissible=false` = 不可关闭；`alert` = role="alertdialog"（确认 / 破坏性操作，`ConfirmDialog` 与重置订阅，同 React）；
  窄屏是底部抽屉）与开关（`ui/Switch.svelte`）。用到它们的组件一律按需加载（`PasskeyPrompt`、`BindEmailDialog` 由 DashLayout `{#await import()}`），
  所以 bits-ui 不进首屏。表单控件（`TextField`、按钮）是手写的。
- 登录、注册、找回 / 重设密码、注销结果、条款 / 隐私（`src/pages/`，访客布局；条款 / 隐私用 680px 的阅读栏 `Page.wide`）与 React 门户
  `pages/auth.tsx`、`legal.tsx` 行为相同。共用的小模块：`lib/forms.svelte.ts`（`FieldErrors` 内联错误 + 聚焦第一个、`Pending`、`Countdown`、
  `isEmail` / `isCode` / `digits` / `fieldOf`）、`lib/form-guard.svelte.ts`（`FormGuard`：蜜罐、Turnstile、表单令牌、每 30 秒 / 回到前台 / 提交后
  重新取 `/auth/options`、开了 Turnstile 而 CSP 没放行就重新加载一次；构造函数里挂 `$effect`，只能在组件初始化时 new）、
  `components/Turnstile.svelte`、`GuardFields.svelte`、`lib/errors.ts`（面板错误码 → 一句话，同 React 的 `errorText`）、`lib/site.ts`（`/auth/options` 的开关）。
  站点配置在 `lib/auth.svelte.ts`：`site.options`（只有表单令牌以外变了才替换）、`site.turnstileAllowed`（第一次取到时定下）、`refreshOptions()`；
  `signIn(result)`（登录答复之后取账户，记下 `passkey_prompt`）。用通行密钥注册的账户（`me.email_pending`）在 DashLayout 里只有不可关闭的「绑定邮箱」。
- **页面取数** `lib/resource.svelte.ts`：`resource(() => ({ key, fetch, enabled }))`（= React 的 `useApi` 带缓存用法：先读 sessionStorage 缓存、后台刷新、
  没缓存时 soft 拖住启动画面、键变了读新键的缓存）与 `autoReload`（线路每 30 秒，后台标签页不取）。只能在组件初始化时调用。
  区块占位用 `components/Loading.svelte`（`aria-busy`，测速脚本等它消失），空状态 `Empty.svelte`（文字由调用处 `t()`）。
- **仪表盘（PR 3）** `pages/Dashboard.svelte` → `components/dash/`：`Banned`（封禁说明）/ `Overview`（页头、最新未读公告横幅、`Notices` 提醒细行、
  四个关键数字、`TrafficSection` + `TrafficChart`（手写 SVG 平滑面积图，纯函数在 `lib/chart.ts`；7 / 30 天都是 `/me/traffic` 的真实数据；
  图本身是 `role=slider`，← → 逐日看）、`Access`（订阅 / 仅自研客户端 / 空状态）+ `Subscribe`（格式菜单、打码链接、一键导入、`Qr`（uqr 本地生成）、
  下载或教程）、公告列表、`NodesPreview`、`DocsPreview`）。对话框（公告详情、重置订阅、验证邮箱）都是第一次打开时才下载（含 bits-ui）。
  小下拉菜单 `ui/Menu.svelte`（手写 menu button，不用 bits-ui 的浮层）。内容页共用样式（区块头、两栏、行式列表、提醒细行、横幅、公告标签、
  线路状态、空状态）在 `src/styles/pages/dashboard.css`/`common.css`。e2e `e2e/dashboard.spec.ts`。
- **商店与订单（PR 4）** `pages/Shop.svelte`、`Orders.svelte`、`OrderDetail.svelte`（也是易支付 `return_url` 回来的页面）→ `components/shop/`：
  `PlanGrid`（样稿 shop-cards：无周期切换、「¥x /月 起」、三格规格、功能清单、一个按钮；当前套餐卡与「推荐」卡用主按钮）、`ConfirmOrder`（确认订单对话框，
  第一次打开才下载：周期单选 + 省 x%、优惠码、换套餐作废确认、支付方式单选、金额明细；窄屏底部抽屉、操作栏吸底）、`PendingOrder`（待付款细行）、
  `PayResult`（付款结果，
  轮询到变化或商店当场付清后带着 `history.state.paid` 跳来时弹一次）。报价、拒绝原因、默认档、卡片大字价格的纯逻辑用 React 门户的 `@/lib/shop`；
  本应用的小工具在 `lib/shop.ts`（省 x%、支付方式说明、`safeUrl`、支付宝唤起、倒计时、状态色调）、`lib/copy.svelte.ts`（`Copied`）。
  余额抵扣是商店页上的开关（手写 `role=switch`，不为它加载 bits-ui）。`resource` 的 `keep`：换优惠码 / 余额重新报价时不闪空。
  e2e `e2e/shop.spec.ts`（React shop 全部场景 + #19 商店部分）；账户 `v2-shop-<视口>`（seed）。
- **线路、用量、钱包（PR 5）**：`pages/Nodes.svelte`（关键数字、图例、搜索、默认按倍率升序、宽屏表格（点「流量倍率」列头切换排序，`aria-sort`）/
  窄屏行式列表（`svelte/reactivity` 的 `MediaQuery`，只渲染一份）、每 30 秒刷新；状态 / 倍率的样式在 `flat.css`（`.nstate` / `.rate`），仪表盘的线路预览共用）、
  `pages/Traffic.svelte`（本月 / 近 7 天 / 近 30 天，`resource` 的 `keep` 换范围时留着上一段；面积图、线路环形图与每日计费柱图都按 v1.4.0 恢复，见 `components/charts/`）、
  `pages/Wallet.svelte` → `components/wallet/`（`InviteLink` 概览右栏、`InviteDetails` / `Ledger` / `Withdrawals` 三个分页、
  `WithdrawDialog` 第一次点「申请提现」才下载（含 bits-ui）；USDT 网络是 `ui/Select`）。分页是 WAI-ARIA tabs（← → Home End），
  地址 `?tab=`，换分页 `navigate(…, { replace: true, keepScroll: true })`。文案表与纯函数 `lib/wallet.ts`（`wallet.test.ts`），
  复制 `lib/copy.svelte.ts`（`Copied`）。页内分页是 `components/flat/Tabs`，关键数字 `flat/StatRow`，表格 `.tbl.flat-head` / `.wtbl`。e2e `e2e/wallet.spec.ts`（账户 `v2-inviter-<视口>` / `v2-invitee-<视口>`，
  seed.ts 给门户 v2 单独建的一对）、`e2e/lines.spec.ts`。
- **文档、公告、工单、设置（PR 6）**：`pages/Help.svelte`（`?id=` 时 `components/help/Article`，否则 `DocList`：搜索 `?q=`（面板搜）、分类 `?cat=`、
  当前设备一行、「全部文档 · N 篇」、细线文章列表与本机未读点 `lib/read-state.svelte.ts`（与 React 同键 `akari.read.kb`）；文章：面包屑、目录（宽屏右侧吸顶、
  窄屏 `<details>`，`RichHtml headings` 给 h3 / h4 补锚点）、同类文档、上一篇 / 下一篇、复制订阅链接）；`pages/Announcements.svelte`（头条 + 按月细线时间轴，
  打开 = 面板记已读并更新导航未读数；标签（实底，`/me/announcements` 的 `tag`：两种语言的名称 + 预设色键）画在标题前，`lib/announcement.ts` 的 `tagOf` / `tagFilters`；用到的标签多于一个时列表上方出现按标签筛选；仪表盘顶部提示条带标签时卡片左侧 3px 同色细边（`pages/dashboard.css` 的 `.notice.edge`），颜色类 `.c-<色>` 与 `.tg` 在 `pages/common.css`、色值在 `tokens.css` 的 `--t-*`）；`pages/Tickets.svelte` → `components/tickets/`
  （`NewTicket`、`Thread` 两个对话框按需加载；`?id=` 直达；文字表 `lib/tickets.ts`）；`pages/Account.svelte`（分区导航 + `#锚点`、旧 `?tab=security`）→
  `components/settings/`（`Security`、`Passkeys`（含「只用通行密钥」开关、窄屏「⋯」菜单 `ui/Menu align=end`）、`PasswordDialog`、`ChangeEmailDialog`、
  `DeleteAccountDialog`、`HolderConfirm` + `lib/holder.svelte.ts`（确认是本人：密码或通行密钥））。确认框 `ui/ConfirmDialog.svelte`（按需加载）。
  设置行样式 `.set-row` 在 `styles/pages/` 下（account.css 或 rest.css）。`lib/router.svelte.ts` 的 `setParams`（换查询串）、`navigate(…, { keepScroll })`；`auth.forget()`（注销后只收本地态）。
  e2e `e2e/support.spec.ts`（React support #57–#59、polish #57）、`e2e/account.spec.ts`（React account 的设置场景）、`auth.spec.ts` #3–#5 接着测设置页的通行密钥管理；
  账户 `v2-account-`、`v2-settings-`、`v2-legacy-`、`v2-delete-<视口>`（seed）。
- 提示条 `lib/toast.svelte.ts`（`toast.success / error(标题, {description})`，手写，代替 sonner）：`components/Toaster.svelte` 在第一次弹提示时才下载、挂到 body。
- 面板下发的 HTML（条款、之后的公告 / 文章）只经 `components/RichHtml.svelte` 的 `{@html}`（全站唯一一处，约定同 React 的 server-html）。
- 小心 Tailwind 的工具类名：`block`、`hidden`、`flex`、`border` 之类会被 Tailwind 生成（工具层优先于组件层），自己的类名别用这些名字（按钮是 `btn-block`）。
- 启动画面（`index.html` 的 `#boot`、`src/boot/boot.css`、`src/lib/boot.svelte.ts`）、启动守护（`src/boot/boot.js`，经典脚本，带哈希输出到
  `assets/`）、按需加载与新版本自动重新加载（`src/lib/lazy.ts`：重试一次 → 整页重新加载一次（sessionStorage `akari.chunk-reload`）→
  「这一页没能下载完」；`vite:preloadError` 同样处理），规则与 React 门户相同。
- 导航上的数字（`src/lib/attention.svelte.ts`）：启动画面收起后取待付款订单、工单新回复、未读公告；打开账户菜单取余额、返利比例；
  打开窄屏菜单再取线路可用数。按账户范围（full / renewal / banned）取，拉不到就空着。

## 颜色（换配色 = 改一个文件）

**全部颜色只在 `src/styles/tokens.css`**：浅色在 `:root`，深色在 `:root.dark` 与 `prefers-color-scheme` 回退（两段一致），
还有启动画面、Logo、公告标签、流量图（PR 3）的令牌。组件、`app.css`、`boot.css`、Tailwind 类、SVG 只用 `var(--…)` 或
`@theme inline` 映射出来的名字（Tailwind 默认色板已清空：`bg-red-500` 这类类名不存在）。`npm run check:colors`
（`scripts/check-colors.mjs`）在 `src/` 与 `index.html` 里找十六进制、颜色函数、`bg-[#…]`、颜色名，`tokens.css` 之外出现即失败。
`src/assets/` 的图片（favicon.svg）不查。

## 字体与字重（2026-10-26）

**只用系统字体，不自托管任何字体文件**（原来的 Noto Sans SC 切片 + Inter 在挂载后才注入，换字体时整页重排，还多下载约 1.3 MB）。字体栈 `--font-ui`（`src/styles/tokens.css`，`--font-sans` 指向它）：拉丁字母与数字在前（SF / Segoe UI），汉字落到 PingFang SC / 微软雅黑 / Noto Sans CJK SC；`<html lang>` 随界面语言，所以回落的汉字字形按简体选。系统字体的数字默认是比例数字：价格、流量、表格要对齐处显式 `font-variant-numeric: tabular-nums`（`.tnum` 与 `pages/common.css` 里的选择器清单）。
**字重只有两档**：`--fw-regular`（400，正文）与 `--fw-strong`（600，标题 / 强调 / 按钮 / 数字）。微软雅黑没有 500，Windows / Android / Linux 上没有 300，别的字重会悄悄并成相邻一档、层次消失。所以层次靠颜色（`--fg` / `--muted` / `--faint`）与字号，不靠第三档字重；一律写 `font-weight: var(--fw-strong)`，不写数字。`npm run check:weights`（`scripts/check-weights.mjs`，在 `npm run check` 里）拒绝 `src/` 与 `index.html` 里任何其他字重（`font-weight`、`font:` 简写、Tailwind `font-medium` 之类、`wght` 轴）。UA 默认加粗的元素（h1–h6、th、b、strong）在 `app.css` 基础层统一成 `--fw-strong`。`body` 的 `font-synthesis: weight`：系统汉字字体缺粗体时由浏览器合成 600（不合成斜体），不要改回 `none`。

## 偏好与存储（键名沿用 React 门户，老用户的偏好照旧生效）

明暗 `localStorage.theme`（light / dark / system；boot.js 首帧前给 `<html>` 加 `.dark` / `.light`）、语言 `akari.locale`（zh-CN / en）、
接口缓存 sessionStorage `akari.cache:*`（`/me` 去掉订阅令牌）、`akari.boot-retry`、`akari.chunk-reload`。

## 文案

词典只有一份：`src/shared/i18n/dict.ts`（键 = 简体原文）。界面文字一律 `t('…')` / `tp('…', {…})`（`src/lib/i18n.svelte.ts`，读 `$state`，
模板随语言重渲染）；新文案加进那份词典。`npm run check:i18n`：每个含汉字的字符串都有英文条目，`.svelte` 标记文本与属性值里不许直接写汉字。
`check:i18n` 也拒绝没人用的词条（`node scripts/check-i18n.mjs --fix` 删掉它们；后台 `admin/` 用到的键算有人用）。
`scripts/strings.mjs` 是 check-i18n / check-colors / check-weights 共用的无依赖扫描工具。

## CSP 与产物

面板的 CSP 固定为 `'self'`：`index.html` 无内联脚本 / 样式 / 事件，所有产物在 `assets/` 下，无 `data:` 地址
（`assetsInlineLimit: 0`）。`npm run build` = `vite build` + `scripts/check-dist.mjs`（parse5）+ `scripts/check-bundles.mjs dist/app`
（产物里没有后台代码）。体积报告 `npm run report:size`（`scripts/bundle-report.mjs dist/app`）。

## 命令

```bash
npm ci
npm run dev          # Vite（5174），接口转发到 PANEL_URL（默认 http://127.0.0.1:18480）
npm run check        # svelte-check（警告即失败）+ oxlint + check:colors + check:i18n + vitest
npm run build        # dist/app + 产物检查
make -C .. portal    # 同上（npm ci + build）；面板 `make panel` 之后才编进去
```

## 端到端与性能

- `e2e/`（Playwright，自己的 Playwright 版本与 Chromium）：`../scripts/e2e-portal.sh`（`make e2e`，CI 的 e2e 任务）起一个真面板（真 CSP），
  `e2e/support/seed.ts` 建种子数据，跑这里的用例：桌面 1440×900、手机 390×844，减少动效；每个用例收集 CSP 违规与页面异常。
  `e2e/support/`：`panel.ts`（管理员 `Client`、`psql`、`latestMail`、`FIELDS`）、`seed.ts`、`mock-alipay.py`、`tls-proxy.mjs`。
  `fixtures.ts`：`signIn`（走接口）、`login` / `signInUI`（经登录页）、`signOut`（桌面邮箱下拉 / 窄屏菜单）、`admin()`（`support/panel.ts` 的 Client）、
  `authenticator`（虚拟 WebAuthn；服务端带 excludeCredentials，同一账户再添加一个要先换一台虚拟认证器）、`dark`。user@e2e.test 永远不退出；退出用 `logout-<视口>@e2e.test`；会改密码 / 改登录方式的用例用
  `v2-reset-<视口>`、`v2-passkey-<视口>`（seed 里每个视口一个）。
  `auth.spec.ts` 覆盖切换前 React 门户 auth.spec 的全部场景，外加通行密钥注册 + 绑定邮箱、站点设置取不到、条款 / 隐私、注销结果页。
- 截图（设计评审）写到 `test-results/screens/<视口>-<名字>.png`，CI 工件 `portal-screens`；每个 PR 的终版截图另存到工作区
  `design/portal-v2-2026-10/impl/<pr>/`。
- 性能：`e2e/perf/perf.spec.ts`（`playwright.perf.config.ts`；桌面 + 限速中端手机，各 5 次取中位：FCP、LCP、TTI、内容就绪、站内切页）
  加上体积（`size-svelte.json`），`e2e/perf/summary.mjs` 与 `e2e/perf/baseline/`（切换前 React 门户最后一次的数字，以及 v2.0.0 发布时同一套测法的数字 `perf-v2-*.json`）对比，Δ 列相对 v2.0.0；切页另给不含旧页面淡出（100 ms，v1.4.0 的刻意动效）的 `bare.*`；
  CI 写进任务摘要并上传工件 `portal-perf`。切页预取（`lib/prefetch.ts`：门户空闲时按优先级每次三个预载分包与首屏数据，链接意图预载；一次全发会和首页抢带宽反而更慢）是手机端切页快于旧 React 门户的原因。

- 首屏性能（v2.0.0 起不得更慢）：①首帧样式表 `assets/head-<哈希>.css` = 令牌 + 启动画面（`src/boot/head.css`，`vite.config.ts` `headCss` 展开去空白后以阻塞 `<link>` 插在 `<head>` 最前），启动画面带 Logo 在 HTML + 这张小表到手时就画出来（FCP 不再等应用样式表）；应用样式表（入口分包 CSS）标成 `media="print" data-defer`（`deferAppCss`），`boot.js` 在文档解析完成时改成 `all`，`boot.svelte.ts` 收起启动画面前等它加载完。②`main.ts` 一启动就预载当前路由的分包（与 `/me` 并行）；`/me` 与 `/me/plan` 在多半已登录时并行（`auth.svelte.ts` `fetchAccount(speculative)`）；`prefetchCurrent`（App 一知道账户范围就调）在页面挂载前开始取仪表盘首屏数据（`lib/dash-data.ts` 与 Overview 共用键）。③`lib/error-toast.ts`：Rolldown 的命名空间小助手曾落在 bits-ui 的 Dialog 分包里，`import('./errors')` 把约 60 KB 对话框栈拖进每个页面的静态依赖；别在多个分包共享的模块上直接动态 `import()`。；⑤（桌面追平）刷新后的第一页的 `.page` 不播 `page-in` 淡入（`PageView` 在启动画面还在时给 `.first`；启动画面的淡出就是入场，淡入会让 Chrome 的 LCP 晚到动画结束，实测 LCP 492→312 ms）；⑥`lib/cache` 的 `isFresh`：预取刚取回的数据（3 秒内、非 reload）页面挂载时不再重复请求（原来每个首屏请求发两遍）；⑦`auth.startAuth` 在 /me 回来后立刻 `prefetchCurrent`（不等渲染外壳）；⑧`main.ts` 在 `mount(App)` 之后才预载当前页分包（几十个小模块的响应否则和应用启动抢主线程）；⑨首屏的订阅二维码 `Qr defer` 放到首帧绘制之后再编码，`TopBar` 的下划线不在 effect 里同步量（交给 ResizeObserver 的首次通知）
