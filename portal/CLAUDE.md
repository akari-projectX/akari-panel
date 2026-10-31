# portal/ — 门户 v2（Svelte 5）

用户门户（样稿只剩默认 Logo：`design/portal-v2-2026-10/logo/`）。面板只下发 `dist/app`（`src/spa.rs`）。

## 外观 = A · 纸面简约（2026-10-30 用户确认，分三步接入）

**配色（2026-10-31 用户裁决，取代下文「暖白纸面、墨蓝强调」的颜色）**：中性纯白底（`--bg` #fafafa、卡面 #fff）、近黑正文（#0a0a0a / #404040）、中性灰辅助色、亮蓝强调（`--brand` #2563eb）；深色是中性近黑（#0a0a0a / #141414、细线 #262626）+ 浅亮蓝（#60a5fa）。排版与零件不变。对比度（`tokens.css` 头注）：`--body`/`--muted`/状态色/`--brand` 在底与卡面上 ≥ 4.5，`--faint` 只作次要说明（≥ 3.5）。

**交互与手机浏览器（2026-10-31，用户：「操作起来太死了」，`app.css` 末尾「触摸与按下反馈」一节）**：可点的元素一律 `touch-action: manipulation`（去掉双击缩放等待），系统点按高亮已去掉、由 `:active` 代替：按钮类按下缩小（`scale`，`.btn` 原有 .985、图标按钮 .94、分段 / 胶囊 .97，不加过渡、松手即回弹），整行可点的列表 / 菜单项按下换 `--hover` 底；触屏（`pointer: coarse`）上图标按钮用 `::before` 外扩点按范围到约 44px（外观不变），提示条的关闭钮常显；`viewport-fit=cover` + `env(safe-area-inset-*)`：顶栏高度加上顶部安全区、`.wrap` 两侧与页脚底部让开、吸顶的设置分区 / 订单账单跟着下移；窄屏文本框一律 16px（iOS 聚焦不放大，`!important` 盖过页面里的 13px 等宽框）；菜单卡片、弹窗正文、横向滚动的表格 `overscroll-behavior: contain`；窄屏横向滚动的 `.tbl-w` 两侧有「还能滚」的淡影（`background-attachment: local` 的遮罩）；切页退场与弹层退场从 100 ms 缩到 60 ms（`App.svelte`、`lib/pop.svelte.ts`、`--dur-exit`）；减少动效时按下不缩放。theme-color 仍由 `lib/theme.svelte.ts` 按 `--bg` 设置。

2026-10-30 用户确认新外观「A · 纸面简约」（取代 2026-10-26 恢复的 v1.4.0 外观）：暖白纸面、近黑正文、细线分隔、墨蓝只做强调，主按钮是正文色实底（`.btn.pri`）。
样稿（单文件，所有页面）不进仓库；裁决要点：

- 顶栏 **N1**：Logo（门户现有字标）+ 纯文字导航八项 `概览 商店 线路 用量 订单 公告 文档 工单`（`lib/account.ts` 的 `PRIMARY`，按账户范围过滤；没有「更多」），
  当前项正文色加粗 + 一道同色细线（`.nav-indicator`，切页时滑动）；右侧明暗按钮 + 头像（邮箱首字母，`.av`）。
- **头像菜单**（`AccountCard`，桌面点头像 / 窄屏点「头像 + 三道线」）：抬头（头像、名字、邮箱）、套餐块（名字、还有几天、用量条、已用 / 剩余、快捷按钮「复制订阅」「续费」）、
  窄屏才有的页面导航（八项，带图标与实时数字）、钱包 / 邀请与设置（`ACCOUNT`）、外观与语言两枚开关、退出登录。窄屏的导航只在这里。
- 页脚（`SiteFooter`）：细线 + 一行版权与条款 / 隐私 / 站长链接（没有大号站点名字样）；不显示后端版本号；页脚贴底（`.shell` 是纵向 flex）。
- 接入顺序：① 配色 + 外壳（本节）；② 仪表盘（A3，见下文「仪表盘」）；③ 其余各页（已完成）。
- 页头（`flat/PageTitle` 的 `lead`）：给了 `lead` 时页名 `<h1>` 是一行小字眉标，下面一句大字说这一页现在的状况（线路「4 条线路，3 条在线」、订单「2 笔订单等待支付」、用量「本期已用 X / Y GB」、钱包「余额 ¥x」…），再下面一行说明，右侧操作；h1 文字不变（e2e 的 `ready(page, 标题)` 依赖它）。文档页「全部」视图是每个分类一栏（栏头分类名 + 文章标题，细线分栏），选了分类或搜索时仍是文章格子。
- **其余各页（③）**：先只改了共用零件的外观（下面这些），2026-10-31 用户要求按仪表盘的风格重排全部页面（商店、线路、用量、订单、钱包、公告、文档、工单、设置、登录 / 注册都已重排，见下文各页）：页头 `PageTitle`（h1 36px，h1 文字仍是各页原来的标题）；区块标题 `.sec-title`（12px 加字距的辅助灰，不带图标）；
  按钮 `.btn` 一律胶囊（次要 = 一圈 `--line2` 细线、无底色，主 = 正文色实底）；分段切换 `.tabs-pill`（细线胶囊，当前项正文色实底）；
  指标 `flat/StatRow`（标签在上、数字在下，上面一道细线、格间竖线）；提示条 `.notice`（上下两道细线之间的一行，不画卡片）；表格 `.tbl` / `.wtbl`（表头 12px faint、行间细线、悬停 `--hover`）；
  商店套餐 `.plan-card`（列间竖细线，不画卡片；右上角只写「当前套餐」/「推荐」一个词）；文档文章 `DocList` 是细线格子、搜索框是胶囊；
  工单对话里自己的气泡是正文色实底；开关 `.switch` 打开是正文色；设置页「危险操作」不再画红框（只有标题是红字）；登录 / 注册页去掉品牌色光晕，输入框 12px 圆角、按钮胶囊，标题是一行小字眉标（`AuthTitle` 的 `eyebrow`：「欢迎回来」「新用户」）+ 40px 的 h1。
  仪表盘的细线列表 `.dlist` / `.drow` / `.dtag` / `.drow-go` 在 `pages/common.css`（仪表盘、公告页、工单页共用）；分段胶囊 `.tabs-pill` 也可以是一组 `aria-pressed` 按钮（筛选），当前项正文色实底。
  强调色只留给链接、未读点、公告标签与图表。

- 样式分层：`src/app.css`（外壳、对话框、阅读弹窗、切页）、`src/styles/flat.css`（v1.4.0 的版式零件：`PageTitle`、`StatRow`、`Section`、`Row`、`Tabs`、
  `.bdg` 徽章、`.wtbl`、`.nstate` 等）、`src/styles/pages/*.css`（用户中心各页的版式与表格 `.tbl` 等，原 pages.css 按「哪些页面用」拆开：`common.css` 多数页要的（它 `@import` 了 `styles/flat-dash.css`）、`rest.css` 除仪表盘外的页面共用的、`dashboard.css`/`shop.css`/`order-detail.css`/`wallet.css`/`traffic.css`/`account.css`/`nodes.css` 一页独用的；common/rest 由 `lib/pages.ts` 的 `withCss` 在页面分包之前动态引入（Vite 不保证共用 CSS 先于页面 CSS 进 `<head>`；`withCss` 按调用顺序先插 common、rest 再插页面自己的），各 `pages/*.svelte` 只 import 自己的那份，只由登录后的页面分包带，不进首屏 CSS；规则的相对顺序与层包装不变，拆分时要核对「先出现的专页规则不能被后出现、改成先加载的共用规则反超」，新规则放进只有它的使用者会加载的文件，多页共用的放 common）、`styles/flat.css` 只留访客页也要的几条（其余在 `flat-dash.css`）、`tokens.css`（颜色只能写在这里，`check:colors`）。
  页面用 `components/flat/*` 拼，不再手写 `.ph` / `.kpis` / `.banner` / `.li` / `.cols` / `.sh`（已删除）。
- 图表只有一个：`components/dash/WeekChart.svelte`（纯 HTML/CSS 的每日柱图，下行在下、上行叠在上面，键盘可逐日看提示），仪表盘的「流量」与用量页的「每日」共用；样式在 `styles/flat-dash.css`（`.wk*`、分段切换 `.seg-t`）。不引入图表库。
- 下拉用 `components/ui/Select.svelte`（bits-ui，v1.4.0 的 shadcn Select 外观，高 32px）；对话框三种（2026-10-29 起一律不带图标：`Dialog` 没有 `icon` 片段）：流程（标题 + 说明，底部按钮栏）、确认（`alert`，420px）、
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
- **与框架无关的共用模块在 `src/shared/`，别名 `@/`**（后台 `admin/` 也引其中一部分）：`@/api`（整个接口层）、
  `@/i18n/dict`（英文词典，按需加载）、`@/i18n/errors`、`@/lib/format`、`@/lib/cache`、`@/lib/traffic`、`@/lib/node`、`@/lib/sub-links`、
  `@/lib/content-text`、`@/lib/doc-categories`、`@/lib/shop`、`@/lib/confetti`、`@/data/platforms`；
  `$lib/` = 本应用自己的代码（`src/lib/`）。
- 默认 Logo = L3 小写 akari 字标（`src/components/Wordmark.svelte`、`index.html` 启动画面里同形的 SVG，颜色 `--logo-ink` / `--logo-dot`；favicon `src/assets/favicon.svg`、`apple-touch-icon.png`；源文件 `design/portal-v2-2026-10/logo/`）；站长上传了 Logo / favicon 时用站长的。
- 外壳（`src/components/`、`src/layouts/`）：顶栏导航、头像菜单、窄屏菜单都是手写的、完整无障碍（menu button 模式：↑↓ Home End、
  Esc 还焦点、Tab 关闭、点外面关闭；全屏菜单是模态对话框：焦点困在「关闭按钮 + 菜单」、Esc、锁滚动、切页 / 变宽自动收起；
  aria-expanded / aria-controls；减少动效；指针 / 触摸打开时焦点在菜单容器上（不画焦点环），键盘（click 的 detail 为 0）打开时在第一项上）。
  不为外壳引入 bits-ui，首屏更小。
- **bits-ui 只用于真正需要的原语**：对话框（`src/components/ui/Dialog.svelte`：焦点困住、Esc / 遮罩、锁滚动、还焦点；`dismissible=false` = 不可关闭；`alert` = role="alertdialog"（确认 / 破坏性操作，`ConfirmDialog` 与重置订阅，同 React）；
  窄屏是底部抽屉；标题 / 说明用 `.dlg-title` / `.dlg-desc` 定样式（bits-ui 的 data 属性在 alert 变体下是 `data-alert-dialog-*`，别按属性选）；`tone` 只决定确认按钮的语气）与开关（`ui/Switch.svelte`）。用到它们的组件一律按需加载（`PasskeyPrompt`、`BindEmailDialog` 由 DashLayout `{#await import()}`），
  所以 bits-ui 不进首屏。**按钮打开的对话框一律经 `lib/dialogs.ts`**：加载函数写在 `<script module>`，`preloadDialogs(…)` 在页面空闲时预载（同 `lib/prefetch` 的快网络规则），
  触发按钮 `{@attach intent(加载函数)}`（指针移上 / 按下、聚焦即下载；`flat/Row` 把组件上的 `{@attach}` 落到按钮上），打开用 `{#await chunk(加载函数) then m}`（已下好则同步画出）；
  否则第一次点击要等分包下载（限速网络上一两秒）。要取数的对话框先打开、数据区用 `Loading` 占位。e2e `e2e/dialogs.spec.ts`。表单控件（`TextField`、按钮）是手写的。
- 页面容器：用户中心与访客布局的 `<main>` 都是 `.wrap`（访客是 `.wrap.guest`），两侧留白只来自 `--gutter`（56 / 32 / 20px），页面自己不加左右边距；要贴满页宽的条用 `calc(-1 * var(--gutter))` 抵消。
- 登录、注册、找回 / 重设密码、注销结果、条款 / 隐私（`src/pages/`，访客布局；条款 / 隐私用 680px 的阅读栏 `Page.wide`）。共用的小模块：`lib/forms.svelte.ts`（`FieldErrors` 内联错误 + 聚焦第一个、`Pending`、`Countdown`、
  `isEmail` / `isCode` / `digits` / `fieldOf`）、`lib/form-guard.svelte.ts`（`FormGuard`：蜜罐、Turnstile、表单令牌、每 30 秒 / 回到前台 / 提交后
  重新取 `/auth/options`、开了 Turnstile 而 CSP 没放行就重新加载一次；构造函数里挂 `$effect`，只能在组件初始化时 new）、
  `components/Turnstile.svelte`、`GuardFields.svelte`、`lib/errors.ts`（面板错误码 → 一句话，同 React 的 `errorText`）、`lib/site.ts`（`/auth/options` 的开关）。
  站点配置在 `lib/auth.svelte.ts`：`site.options`（只有表单令牌以外变了才替换）、`site.turnstileAllowed`（第一次取到时定下）、`refreshOptions()`；
  `signIn(result)`（登录答复之后取账户，记下 `passkey_prompt`）。用通行密钥注册的账户（`me.email_pending`）在 DashLayout 里只有不可关闭的「绑定邮箱」。
- **页面取数** `lib/resource.svelte.ts`：`resource(() => ({ key, fetch, enabled }))`（= React 的 `useApi` 带缓存用法：先读 sessionStorage 缓存、后台刷新、
  没缓存时 soft 拖住启动画面、键变了读新键的缓存）与 `autoReload`（线路每 30 秒，后台标签页不取）。只能在组件初始化时调用。
  区块占位用 `components/Loading.svelte`（`aria-busy`，测速脚本等它消失），空状态 `Empty.svelte`（文字由调用处 `t()`）。
- **仪表盘（外观 A · A3，2026-10-30）** `pages/Dashboard.svelte` → `components/dash/`：`Banned`（封禁说明）/ `Overview`（两栏首屏 + 整宽线路）：
  左栏 `Status`（页标题那行 `<h1>仪表盘</h1> · 问候 · 套餐 · 状态`；`Notices` 提醒细行（已暂停 / 待支付 / 邮箱 / 工单 / 公告，类别字带色点 + 加粗标题 + 说明 + 操作；除「已暂停」外都有 ×：公告 = 标为已读，工单与订单记在 `lib/notice-dismiss`）；
  一句大字（本期还剩多少、几天后到期，数字取译文按占位符切开加粗）；流量 / 时间两把尺（流量是 `role=meter`「剩余流量」，时间 = 本期（上次重置或开通 → 下次重置或到期）过了几天）；
  照近 7 天计费流量的判断（会在本期结束前用完才提醒日期）；续费 / 买重置包（剩不到一成或已用完）；四个小事实（套餐到期、在线线路、余额与可提现、速率））
  → `Flow`（7 / 30 天切换，默认 7 天 = 预取的那份（`lib/dash-data` 的 `trafficSpec`），切到 30 天才取；`WeekChart` 30 天时只标今天和往前每 5 天）→ `News`（三条公告的细线列表，点开公告详情）；
  右栏 `Access`（`#subscribe`；仅自研客户端 / 暂停 / 读不出 / 没有套餐几种分支）+ `Subscribe`（「复制订阅链接」正文色胶囊、格式菜单、二维码开关（默认收起，`Qr` 本地生成）、导入的客户端名字之间细竖线 + 更多、还没有客户端）→ `DocsPreview`（教程：四篇文章，分类名 + 标题，当前设备的分类在前）；
  整宽 `NodesPreview`（线路表 `components/NodeTable`（与线路页共用）：线路 · 负载（小条 + 字）· 延迟 · 倍率 · 状态，至多两个入口标签，每页 5 条）。
  活动位 `Promo`（右栏，接入配置与教程之间）：数据 = 站长在后台「内容 › 活动」配置的 `GET /me/promotion`（`K.promotion`，在 `lib/dash-data` 里随首屏预取），没有活动整块不画；标签「限时活动」+ 倒计时（`role=timer`，按面板 `now` 与本机时钟的差，每秒走、后台标签页不走，到 0 收起）、大号折扣字样（公告标签的玫红 `--t-pink`）、标题与说明（按界面语言，英文空回落中文）、虚线框优惠码 + 复制（券可用时才有）、按钮（默认去商店，外链新窗口）。样式在 `src/styles/pages/dashboard.css`（类名 `hs-*`、`dsec`/`dsh`/`dlist`/`drow`、`acc-*`）；与线路页共用的线路表 `.ntbl`/`.dload`/`.nlat`/`.nrate` 与小分段切换 `.seg-t` 在 `pages/common.css`。
  对话框（公告详情、重置订阅、验证邮箱，含 bits-ui）不进页面分包，空闲时与按钮意图时预载（`lib/dialogs`）。小下拉菜单 `ui/Menu.svelte`（手写 menu button，不用 bits-ui 的浮层）。e2e `e2e/dashboard.spec.ts`。
- **商店与订单（PR 4）** `pages/Shop.svelte`、`Orders.svelte`、`OrderDetail.svelte`（也是易支付 `return_url` 回来的页面）→ `components/shop/`：
  `PlanGrid`（外观 A，2026-10-31 按仪表盘风格重排：细线分隔的列、不画卡片，一行最多 3 列；1 个套餐时横排一整行（左：名称、价格、规格、按钮；右：功能清单），2 个时各占一半；无周期切换（2026-10-29 裁决）、「¥x /月 起」（「推荐」的价格用强调色）、三格规格（流量 / 重置 / 速率，左对齐）、功能清单、一个靠左的胶囊按钮 + 旁边一行说明（当前套餐与「推荐」用主按钮）；简介与功能清单 = 面板把套餐说明（Markdown）经 `src/markdown.rs` 渲染好的 `summary_html` / `details_html`，经 `RichHtml` 插入，门户不再自己解析说明）、`ConfirmOrder`（确认订单对话框，
  单独分包、空闲时预载：周期单选 + 省 x%、优惠码、「用余额抵扣」开关（逐单打开）、原价 / 各项抵扣 / 还需支付、换套餐作废确认、支付方式单选；窄屏底部抽屉、操作栏吸底）、`PendingOrder`（待付款细行）、
  `PayResult`（付款结果，
  轮询到变化或商店当场付清后带着 `history.state.paid` 跳来时弹一次）。报价、拒绝原因、默认档、卡片大字价格的纯逻辑在 `@/lib/shop`；
  本应用的小工具在 `lib/shop.ts`（省 x%、支付方式说明、`safeUrl`、支付宝唤起、倒计时、状态色调）、`lib/copy.svelte.ts`（`Copied`）。
  余额抵扣是确认订单里的开关（`ui/Switch`）。商店页没有「当前订阅」区（2026-10-31 用户裁决删掉：天数大字、流量尺、到期 / 速率 / 余额），页头（「选一个适合你的套餐」，右侧一行价格说明）下面是待付款细行与套餐列，最后一行小字（人民币、续费顺延、换套餐抵扣）；流量重置包是套餐列表下面的一行（`.shop-reset`，当前套餐配了重置包且现在能买时；流量用完时当前套餐卡的按钮本身就是重置包，这一行不出现）。`resource` 的 `keep`：换优惠码 / 余额重新报价时不闪空。
  e2e `e2e/shop.spec.ts`（React shop 全部场景 + #19 商店部分）；账户 `v2-shop-<视口>`（seed）。
- **线路、用量、钱包（PR 5）**：`pages/Nodes.svelte`（外观 A，2026-10-31 按仪表盘风格重排：页头一句大字「N 条线路，M 条在线」+ 右侧「每 30 秒自动刷新 · 刚刚」与刷新按钮；
  筛选行 `.abar`（`pages/common.css`：左边 `.seg-t` 标签筛选「全部 + 订阅里出现的入口标签」，右边倍率说明）；一张线路表 `components/NodeTable`（与仪表盘共用，窄屏收起负载列与标签），默认按倍率升序、点「倍率」列头切换（`aria-sort`）；
  表下一行负载图例与「维护中的线路不会出现在订阅里」（`data-node-legend`）；每 30 秒刷新；没有统计格子与搜索框）、
  `pages/Traffic.svelte`（外观 A，2026-10-31 按仪表盘风格重排：页头一句「本期已用 X / Y GB」+ 右侧本月 / 近 7 天 / 近 30 天；三个数（今日与昨天比、这段时间与日均、计费含倍率）；「每日」= 仪表盘的 `WeekChart`（今天那根加深，`.us-week`）；按线路（此刻的倍率与时段规则）；明细（每天一行，右上「导出 CSV」：浏览器里由同一份 `/me/traffic` 生成，`lib/usage-csv.ts`：BOM、字节与 GB、防公式注入，不另开接口）。`resource` 的 `keep` 换范围时留着上一段）、
  `pages/Wallet.svelte`（外观 A：页头「余额 ¥x」、三个数（余额 / 可提现 / 待结算）、两栏「邀请好友」（`InviteLink` + 返佣条款 + 申请提现与置灰原因）|「余额明细」（最近四笔，「全部 →」切到收支流水）；仅 full）→ `components/wallet/`（`InviteDetails` / `Ledger` / `Withdrawals` 三个分页、
  `WithdrawDialog`（含 bits-ui）单独分包、空闲时预载；USDT 网络是 `ui/Select`）。分页是 WAI-ARIA tabs（← → Home End），
  地址 `?tab=`，换分页 `navigate(…, { replace: true, keepScroll: true })`。文案表与纯函数 `lib/wallet.ts`（`wallet.test.ts`），
  复制 `lib/copy.svelte.ts`（`Copied`）。页内分页是 `components/flat/Tabs`，关键数字 `flat/StatRow`，表格 `.tbl.flat-head` / `.wtbl`。
  订单列表 `pages/Orders.svelte`（外观 A：页头一句（几笔等待支付 / 共几笔）、状态筛选胶囊、宽屏表格「订单号 · 项目（套餐 + 类型 · 周期）· 时间 · 状态点（`.sdot`，`pages/common.css`）· 金额 · 待支付的「取消」+「去支付」/ 其余「详情」」、窄屏一行一笔；没有关键数字行）；订单详情的页头一句 = 套餐 · 金额 · 状态，下面一行订单号。e2e `e2e/wallet.spec.ts`（账户 `v2-inviter-<视口>` / `v2-invitee-<视口>`，
  seed.ts 给门户 v2 单独建的一对）、`e2e/lines.spec.ts`。
- **文档、公告、工单、设置（PR 6）**：`pages/Help.svelte`（`?id=` 时 `components/help/Article`，否则 `DocList`：页头「有什么可以帮你？」（没有说明行）、搜索 `?q=`（面板搜）、分类 `?cat=`、最下面「找不到答案？提交工单」、
  当前设备一行、「全部文档 · N 篇」、细线文章列表与本机未读点 `lib/read-state.svelte.ts`（与 React 同键 `akari.read.kb`）；文章：面包屑、目录（宽屏右侧吸顶、
  窄屏 `<details>`，`RichHtml headings` 给 h3 / h4 补锚点）、同类文档、上一篇 / 下一篇、复制订阅链接）；`pages/Announcements.svelte`（页头一句「N 条公告还没看」；用到的标签多于一个时一排分段胶囊筛选（`role=group`「按标签筛选」，标签色圆点 + 条数）；头条（置顶 · 标签 · 日期 · 未读一行、26px 标题、摘要、阅读全文）+ 其余是仪表盘同款细线行（日期、标签、标题（未读加粗 + 蓝点）、摘要、→）；
  打开 = 面板记已读并更新导航未读数；标签（实底，`/me/announcements` 的 `tag`：两种语言的名称 + 预设色键）画在标题前，`lib/announcement.ts` 的 `tagOf` / `tagFilters`；用到的标签多于一个时列表上方出现按标签筛选；仪表盘顶部的公告胶囊用标签色（`pages/dashboard.css` 的 `.cap`），颜色类 `.c-<色>` 与 `.tg` 在 `pages/common.css`、色值在 `tokens.css` 的 `--t-*`）；`pages/Tickets.svelte`（页头一句话 + 右侧「提交工单」；状态分段胶囊（全部 / 待处理 / 已回复 / 已关闭，带张数）；细线行 `button.rowline.tk-row`：未读蓝点 + 加粗标题、分类 · 高 / 紧急优先级 · 多久前更新、状态色点 + 字、→；没有统计格子）→ `components/tickets/`
  （`NewTicket`、`Thread` 两个对话框按需加载，对话仍是阅读对话框；`?id=` 直达；文字表 `lib/tickets.ts`）；`pages/Account.svelte`（页头大字是登录邮箱；单栏，分区导航是页头下吸顶的一排细线胶囊（`nav`「设置分区」）+ `#锚点`、旧 `?tab=security`；分区小标题同仪表盘、设置行上下细线、右侧值与操作靠右）→
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
  「这一页没能下载完」；`vite:preloadError` 同样处理）。
- 导航上的数字（`src/lib/attention.svelte.ts`）：启动画面收起后取待付款订单、工单新回复、未读公告；打开账户菜单取余额、返利比例；
  打开窄屏菜单再取线路可用数。按账户范围（full / renewal / banned）取，拉不到就空着。

## 颜色（换配色 = 改一个文件）

**全部颜色只在 `src/styles/tokens.css`**：浅色在 `:root`，深色在 `:root.dark` 与 `prefers-color-scheme` 回退（两段一致），
还有启动画面、Logo、公告标签、流量图（PR 3）的令牌。组件、`app.css`、`boot.css`、Tailwind 类、SVG 只用 `var(--…)` 或
`@theme inline` 映射出来的名字（Tailwind 默认色板已清空：`bg-red-500` 这类类名不存在）。`npm run check:colors`
（`scripts/check-colors.mjs`）在 `src/` 与 `index.html` 里找十六进制、颜色函数、`bg-[#…]`、颜色名，`tokens.css` 之外出现即失败。
`src/assets/` 的图片（favicon.svg）不查。

## 字体与字重（2026-10-31：HarmonyOS Sans SC）

**字体 = HarmonyOS Sans SC**（用户 2026-10-31 选定，取代 2026-10-26 起的「只用系统字体」）：所有平台同一套字形（Windows 上不再落到微软雅黑）。字体栈 `--font-ui`（`src/styles/tokens.css`）把它放在最前，后面仍是原来的系统字体栈作回落。
文件：`src/assets/fonts/hos/hos-<400|600>-<片号>.woff2`（400 = Regular，600 = Bold），由 `scripts/font-slices.py <HarmonyOS_Sans_SC 目录>` 生成（fonttools；产物进仓库，CI 不跑）：字符集 = ASCII 与常用标点符号 + GB2312 全部汉字 + 门户源码里出现的字，门户界面先用到的字排在前面，每片约 200 字、约 30 KB，两字重共约 2 MB；`src/styles/fonts.css`（同一脚本生成，`app.css` 引入）给每片一条 `@font-face` + `unicode-range`，浏览器只下载页面上真正出现的字所在的片，`font-display: swap`（加载前用系统字体，首帧不等字体）。GB2312 以外的字落到系统字体。
**授权**：HarmonyOS Sans Fonts License Agreement（原文 `src/assets/fonts/hos/LICENSE.txt`，第三方清单 `make third-party` 收录）：要求在软件里显著注明使用了该字体（页脚「字体：HarmonyOS Sans」，`SiteFooter`），且**不得修改字体**——切片是修改，用户 2026-10-31 知情后仍选择切片，风险由站长承担；改字体或去掉页脚声明前先看这里。`scripts/check-weights.mjs` 跳过生成的 `fonts.css`（那里的 `font-weight` 是字体文件自己的字重）。
**字重只有两档**：`--fw-regular`（400，正文）与 `--fw-strong`（600，标题 / 强调 / 按钮 / 数字）。字体只带这两个字重，回落的微软雅黑也没有 500，别的字重会悄悄并成相邻一档、层次消失。所以层次靠颜色（`--fg` / `--muted` / `--faint`）与字号，不靠第三档字重；一律写 `font-weight: var(--fw-strong)`，不写数字。`npm run check:weights`（`scripts/check-weights.mjs`，在 `npm run check` 里）拒绝 `src/` 与 `index.html` 里任何其他字重（`font-weight`、`font:` 简写、Tailwind `font-medium` 之类、`wght` 轴）。UA 默认加粗的元素（h1–h6、th、b、strong）在 `app.css` 基础层统一成 `--fw-strong`。`body` 的 `font-synthesis: weight`：系统汉字字体缺粗体时由浏览器合成 600（不合成斜体），不要改回 `none`。

## 偏好与存储

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
  `auth.spec.ts` 覆盖登录、注册、找回密码的全部场景，外加通行密钥注册 + 绑定邮箱、站点设置取不到、条款 / 隐私、注销结果页。
- 截图（设计评审）写到 `test-results/screens/<视口>-<名字>.png`，CI 工件 `portal-screens`。
- 性能：`e2e/perf/perf.spec.ts`（`playwright.perf.config.ts`；桌面 + 限速中端手机，各 5 次取中位：FCP、LCP、TTI、内容就绪、站内切页）
  加上体积（`size-svelte.json`），`e2e/perf/summary.mjs` 与 `e2e/perf/baseline/`（切换前 React 门户最后一次的数字，以及 v2.0.0 发布时同一套测法的数字 `perf-v2-*.json`）对比，Δ 列相对 v2.0.0；切页另给不含旧页面淡出（100 ms，v1.4.0 的刻意动效）的 `bare.*`；
  CI 写进任务摘要并上传工件 `portal-perf`。切页预取（`lib/prefetch.ts`：门户空闲时按优先级每次三个预载分包与首屏数据，链接意图预载；一次全发会和首页抢带宽反而更慢）是手机端切页快于旧 React 门户的原因。

- 首屏性能（v2.0.0 起不得更慢）：①首帧样式表 `assets/head-<哈希>.css` = 令牌 + 启动画面（`src/boot/head.css`，`vite.config.ts` `headCss` 展开去空白后以阻塞 `<link>` 插在 `<head>` 最前），启动画面带 Logo 在 HTML + 这张小表到手时就画出来（FCP 不再等应用样式表）；应用样式表（入口分包 CSS）标成 `media="print" data-defer`（`deferAppCss`），`boot.js` 在文档解析完成时改成 `all`，`boot.svelte.ts` 收起启动画面前等它加载完。②`main.ts` 一启动就预载当前路由的分包（与 `/me` 并行）；`/me` 与 `/me/plan` 在多半已登录时并行（`auth.svelte.ts` `fetchAccount(speculative)`）；`prefetchCurrent`（App 一知道账户范围就调）在页面挂载前开始取仪表盘首屏数据（`lib/dash-data.ts` 与 Overview 共用键）。③`lib/error-toast.ts`：Rolldown 的命名空间小助手曾落在 bits-ui 的 Dialog 分包里，`import('./errors')` 把约 60 KB 对话框栈拖进每个页面的静态依赖；别在多个分包共享的模块上直接动态 `import()`。；⑤（桌面追平）刷新后的第一页的 `.page` 不播 `page-in` 淡入（`PageView` 在启动画面还在时给 `.first`；启动画面的淡出就是入场，淡入会让 Chrome 的 LCP 晚到动画结束，实测 LCP 492→312 ms）；⑥`lib/cache` 的 `isFresh`：预取刚取回的数据（3 秒内、非 reload）页面挂载时不再重复请求（原来每个首屏请求发两遍）；⑦`auth.startAuth` 在 /me 回来后立刻 `prefetchCurrent`（不等渲染外壳）；⑧`main.ts` 在 `mount(App)` 之后才预载当前页分包（几十个小模块的响应否则和应用启动抢主线程）；⑨首屏的订阅二维码 `Qr defer` 放到首帧绘制之后再编码，`TopBar` 的下划线不在 effect 里同步量（交给 ResizeObserver 的首次通知）
