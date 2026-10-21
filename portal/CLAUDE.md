# portal/ — 门户 v2（Svelte 5）

用户门户的重写（brief：工作区 `briefs/portal-v2.md`；样稿 `design/portal-v2-2026-10/`）。切换（cutover PR）之前，
面板默认仍下发 React 门户 `spa/`；本应用也编进面板，**只有设了 `AKARI_PORTAL_V2=1` 才下发**（预览）。
功能以 React 门户为准，结构以新设计为准（brief「Functional source of truth」）。

## 架构与理由

- **Vite + Svelte 5（runes）+ Tailwind 4，手写的小路由，不用 SvelteKit**：SvelteKit 的静态 / SPA 产物靠内联 `<script>` 启动，
  面板的 CSP 是固定的 `'self'`（无 hash、无 nonce），那张页面跑不起来。路由约百行（`src/lib/router.svelte.ts`、`pages.ts`），首屏也更小。
- 页面表 `src/lib/pages.ts`：地址 → 按需加载的页面、布局（dash 要登录 / guest 已登录就跳走 / public 谁都能看）、标题；`/orders/:id`；
  旧地址 `/invite` → `/wallet?tab=invite`；找不到 = 404 页。门禁在 `App.svelte`（与 React 的 RequireAuth / GuestOnly / RequireScope 相同）。
- **路由表 `src/lib/routes.ts`** 与 `spa/src/lib/routes.ts` 地址相同；面板测试 `access::tests::routes_match_the_portal` 两个文件都读
  （`export const R = {` 到 `} as const;` 之间的单引号路径），加路由要和 `access::PORTAL_PAGES` 一起改。
- **与 React 门户共用、与框架无关的模块经别名 `@/` 直接引用 `../spa/src`**（同一份源码，不手抄）：`@/api`（整个接口层）、
  `@/i18n/dict`（英文词典，按需加载）、`@/i18n/errors`、`@/lib/format`、`@/lib/cache`、字体 `@/assets/fonts/{akari,inter}.css?url`、
  字体许可证（`publicDir` = `../spa/public`）。**不要引用 `@/lib/routes` 或任何引了 React 的模块**（`@/i18n` 的 index、`@/lib/auth` 等）。
  切换 PR 把这些文件 `git mv` 进 `portal/src`。`$lib/` = 本应用自己的代码。
- 默认 Logo = L3 小写 akari 字标（`src/components/Wordmark.svelte`、`index.html` 启动画面里同形的 SVG，颜色 `--logo-ink` / `--logo-dot`；favicon `src/assets/favicon.svg`、`apple-touch-icon.png`；源文件 `design/portal-v2-2026-10/logo/`）；站长上传了 Logo / favicon 时用站长的。
- 外壳（`src/components/`、`src/layouts/`）：顶栏导航、邮箱下拉、窄屏全屏菜单都是手写的、完整无障碍（menu button 模式：↑↓ Home End、
  Esc 还焦点、Tab 关闭、点外面关闭；全屏菜单是模态对话框：焦点困在「关闭按钮 + 菜单」、Esc、锁滚动、切页 / 变宽自动收起；
  aria-expanded / aria-controls；减少动效）。不为外壳引入 bits-ui，首屏更小；**PR 2 起对话框、表单用 bits-ui / shadcn-svelte**。
- 启动画面（`index.html` 的 `#boot`、`src/boot/boot.css`、`src/lib/boot.svelte.ts`）、启动守护（`src/boot/boot.js`，经典脚本，带哈希输出到
  `assets/`）、按需加载与新版本自动重新加载（`src/lib/lazy.ts`：重试一次 → 整页重新加载一次（sessionStorage `akari.chunk-reload`）→
  「这一页没能下载完」；`vite:preloadError` 同样处理），规则与 React 门户相同。
- 导航上的数字（`src/lib/attention.svelte.ts`）：启动画面收起后取待付款订单、工单新回复、未读公告；打开账户菜单取余额、返利比例；
  打开窄屏菜单再取线路可用数。按账户范围（full / renewal / banned）取，拉不到就空着。

## 开关（`AKARI_PORTAL_V2`）

环境变量 `AKARI_PORTAL_V2=1`（启动时读一次，`src/spa.rs` `portal_v2()`，`serve` 打 WARN）：`spa::index` 与 `spa::asset` 改下发
`portal/dist/app`（`PortalAssets`），Turnstile 的 CSP 照旧。不是 panel.toml 键（R39 不加键），也不是数据库设置（临时开关不值得迁移 + 后台界面）。
生产行为不变，直到切换 PR。

## 颜色（换配色 = 改一个文件）

**全部颜色只在 `src/styles/tokens.css`**：浅色在 `:root`，深色在 `:root.dark` 与 `prefers-color-scheme` 回退（两段一致），
还有启动画面、Logo、公告标签、流量图（PR 3）的令牌。组件、`app.css`、`boot.css`、Tailwind 类、SVG 只用 `var(--…)` 或
`@theme inline` 映射出来的名字（Tailwind 默认色板已清空：`bg-red-500` 这类类名不存在）。`npm run check:colors`
（`scripts/check-colors.mjs`）在 `src/` 与 `index.html` 里找十六进制、颜色函数、`bg-[#…]`、颜色名，`tokens.css` 之外出现即失败。
`src/assets/` 的图片（favicon.svg）不查。

## 偏好与存储（与 React 门户同键，同一个源上互通）

明暗 `localStorage.theme`（light / dark / system；boot.js 首帧前给 `<html>` 加 `.dark` / `.light`）、语言 `akari.locale`（zh-CN / en）、
接口缓存 sessionStorage `akari.cache:*`（`/me` 去掉订阅令牌）、`akari.boot-retry`、`akari.chunk-reload`。

## 文案

词典只有一份：`../spa/src/i18n/dict.ts`（键 = 简体原文）。界面文字一律 `t('…')` / `tp('…', {…})`（`src/lib/i18n.svelte.ts`，读 `$state`，
模板随语言重渲染）；新文案加进那份词典。`npm run check:i18n`：每个含汉字的字符串都有英文条目，`.svelte` 标记文本与属性值里不许直接写汉字。
React 门户的 `check-i18n.mjs` 把这里的字符串算作「有人用」、`collect-text.mjs` 把它们收进字体子集（都导入无依赖的 `scripts/strings.mjs`）。

## CSP 与产物

与 React 门户相同的规则（`spa/CLAUDE.md`）：`index.html` 无内联脚本 / 样式 / 事件，所有产物在 `assets/` 下，无 `data:` 地址
（`assetsInlineLimit: 0`）。`npm run build` = `vite build` + `scripts/check-dist.mjs`（parse5）+ `../spa/scripts/check-bundles.mjs dist/app`
（产物里没有后台代码）。体积报告 `npm run report:size`（`../spa/scripts/bundle-report.mjs dist/app`）。

## 命令

```bash
npm ci
npm run dev          # Vite（5174），接口转发到 PANEL_URL（默认 http://127.0.0.1:18480）
npm run check        # svelte-check（警告即失败）+ oxlint + check:colors + check:i18n + vitest
npm run build        # dist/app + 产物检查
make -C .. portal    # 同上（npm ci + build）；面板 `make panel` 之后才编进去
```

## 端到端与性能

- `e2e/`（Playwright，自己的 Playwright 版本与 Chromium（CI 单独安装））：`../scripts/e2e-portal.sh` 跑完 React 门户的用例后，以 `AKARI_PORTAL_V2=1`
  重启同一个面板（同一份种子数据），跑这里的用例：桌面 1440×900、手机 390×844，减少动效；每个用例收集 CSP 违规与页面异常。
  登录走接口（PR 2 才有登录页）。user@e2e.test 永远不退出；退出用 `logout-<视口>@e2e.test`。
- 截图（设计评审）写到 `test-results/screens/<视口>-<名字>.png`，CI 工件 `portal-v2-screens`；每个 PR 的终版截图另存到工作区
  `design/portal-v2-2026-10/impl/<pr>/`。
- 性能：同一份 `spa/e2e/perf/perf.spec.ts` 对两个门户各跑一遍（`E2E_PERF_LABEL=react|svelte`），加上两边的体积
  （`size-<门户>.json`），`spa/e2e/perf/summary.mjs` 合并；CI 写进任务摘要并上传工件 `portal-perf`。
