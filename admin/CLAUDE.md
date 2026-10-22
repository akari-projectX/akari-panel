# admin/ — 管理后台（W33-b）

独立的 Vite 8 + React 19 + TypeScript + Tailwind 4 应用（2026-10 改版：Radix、lucide、sonner、cmdk、react-router 7、react-query、@tanstack/react-virtual、recharts、CodeMirror 6；视觉见 `design/admin-redesign-2026-10/`），与门户 `portal/` **不共享任何代码、路由或产物**。功能清单（验收基准）是 `INVENTORY.md`：每一行都有 Playwright 用例（测试标题里写清单编号）。

## 两个包

| 包 | 入口 | 产物 | 服务（`src/console.rs`） |
|---|---|---|---|
| 登录页 | `login.html` → `src/login/` | `dist/login` | `/{prefix}/app`（公开，只在后台前缀下；`no-store`）、`/{prefix}/app/assets/*`（immutable） |
| 控制台 | `index.html` → `src/console/` | `dist/console`（按页面分包） | `/{prefix}/admin`、`/{prefix}/admin/*`、`/{prefix}/admin/assets/*`（只对管理员会话；index 与无哈希文件 `private, no-store`，带内容哈希的资源 `private, max-age=31536000, immutable`（主管 2026-10-12）；JS/CSS 有构建时写的 `.br`/`.gz`（`scripts/precompress.mjs`），按 `Accept-Encoding` 下发；字体样式表 `fonts.css` 在首屏 ready 后才挂上（`shared/fonts.ts`）；其他一律规范拒绝） |

- `vite.config.ts`：`ADMIN_ENTRY=login|console` 各构建一次；`base` 分别为 `/app/`、`/admin/`（面板运行时只在**下发的 HTML** 里把 `"/app/assets/`、`"/admin/assets/` 改写到前缀下，**不要改 base**）；`cssCodeSplit: false`；`modulePreload: { polyfill: false }`（HTML 列出入口的静态分包，懒加载页面的 import 同时取该页的全部分包：每层一波而不是逐级瀑布；依赖路径同样相对于引用它的文件）。控制台**按页面分包**（2026-10 改版：react-router 懒加载路由，每个页面一个 chunk；recharts、CodeMirror、命令面板 cmdk 各在自己的 chunk 里，用到时才加载；**不设手工分组**：把 lucide 图标或小的共用模块合成一个分包能让冷首访更快（中端手机约 2.4 s 对 3.0 s），但 4 次 CI 里热切页都更慢（切到用户约 700–790 ms 对 410–750 ms；CI 机器之间可差 2 倍）；模块预加载已经去掉了逐级瀑布）：`experimental.renderBuiltUrl` 让 JS/CSS 里引用的分包与字体都写成**相对于引用它的文件**的路径，所以天然落在入口脚本所在的前缀下；只有 HTML 里是绝对路径（由面板改写）。
- `loginGuard`：登录页的依赖图里不得出现 `src/console/`，也不得出现控制台专用库（recharts、cmdk、react-router、react-query、react-virtual、CodeMirror、d3）——登录页保持单个小包。登录页只带自己的小错误表（`src/login/app.tsx` 的 `LOGIN_ERRORS`，`check-error-codes.mjs` 校验其中的码都已登记）。
- `scripts/check-bundles.mjs`（`npm run build` 末尾，smoke 对实际下发的文件再跑一次）：控制台标记必须出现在控制台包、不得出现在登录页包与门户包；门户标记不得出现在后台包；JS/CSS 里不得出现绝对的 `"/admin/assets/`、`"/app/assets/`；每个被引用的分包/字体文件都必须存在；登录页恰好 1 个 JS chunk，控制台 ≥2 个。smoke 在真实前缀下逐个取回控制台的全部分包与字体（都必须 200），并断言无会话时分包是规范拒绝；e2e `SH-19` 逐页打开、断言无 404/CSP 报告。
- `scripts/bundle-report.mjs`（`npm run build` 末尾）：各分包 gzip 大小写入 `dist/bundle-report.json` 与 GitHub Step Summary（CI 工件 `admin-bundle-report`）。**体积只报告、不设门槛**（用户裁决 2026-10-07）。
- 字体：Inter（拉丁子集）+ Noto Sans SC（按 unicode-range 分片），随产物发布（`src/assets/fonts/`，许可在 `public/assets/licenses/`）。子集由 `scripts/subset-admin-font.py` 生成（`scripts/collect-text.mjs` 收集源码里的中文 + `scripts/cjk-slices/sc.txt`；Noto 源文件在构建时读取门户的 `../portal/fonts-src/noto/NotoSansSC-VF.woff2`，可用 `NOTO_SRC` 覆盖——只读输入，不共享代码或产物，符合 R23）。**新增中文文案后重新生成子集**（需要 fonttools）。
- `scripts/check-tokens.mjs`（`npm run check`）：后台 `src/shared/index.css` 的动效变量（`--ease-*`、`--dur-*`）必须与门户 `../portal/src/app.css` 的**数值**一致（只比对，不共享源码）。
- CSP 一律 `default-src 'self'; style-src 'self' 'unsafe-inline'`：不得有内联脚本。Turnstile 只在登录页、只在开启时由面板放宽 CSP。

## 目录

- `src/shared/`：两个包共用（i18n、API 客户端、错误映射、格式化、主题、通行密钥、UI 组件）。**不得**引用 `src/console/` 或 `src/login/`。
  - `api.ts`：`request`/`get`/`post`/…；204 返回 `null`；401 交给 `setUnauthorizedHandler`（控制台：整页跳到登录页并带 `?next=`）；每次成功的写请求通知 `setWriteListener`（控制台的数据层据此失效查询）。
  - `errors.gen.ts`：由 `src/error_codes.txt` 生成的中英错误表（`errorText`）；新错误码必须在这里有中英两份（`check-error-codes.mjs`：与登记表一致、两种语言非空、英文里没有中文）。
  - `i18n.tsx`：内联 `tr("中文", "English")`；语言存 `akari.admin.lang`（`?lang=en|zh` 只对这一页生效、不记住）。`theme.ts`：浅/深色存 `akari.admin.theme`，否则跟随系统。
  - `format.ts`：时间一律按**站点时区**（`/settings` 的 `timezone`）显示，不用浏览器时区。
  - `index.css`：设计令牌（类 macOS：主色 `#2563eb`/深色 `#4a9dff`、石墨灰分层、毛玻璃 `.glass`、`--scrim`、图表色 `--chart-1..8`、圆角、阴影、字号令牌 `text-caption|footnote|body|callout|headline|title3|title2|title1`、`.hit-44`、减少动效/透明度）。**不用任意字号（`text-[13px]`）与硬编码颜色**。
  - `ui/`（Radix + lucide + sonner）：`button`（Button/ButtonLink）、`badge`、`card`（Card/Group/Row/Tile）、`form`（Input、Textarea、原生 Select、`Field`（错误经 `aria-invalid`/`aria-describedby` 关联）、`SecretInput`、Switch/`SwitchField`、Checkbox、Segmented、Kbd/`MOD_KEY`）、`tabs`、`states`（Skeleton、LoadingBlock、EmptyState、带重试的 ErrorState）、`meter`、`layout`（PageHeader、Callout、KV、SettingRow、SectionTitle）、`dialog`（Radix Dialog，sm/md/lg/xl，手机全屏；**有修改时 Esc/点遮罩/关闭先问"放弃未保存的修改？"**，`data-nodirty` 例外；只自动聚焦 `[data-autofocus]`；Esc 只关最上一层）、`confirm`（`useConfirm`：影响列表、输入确认文字 `typeToConfirm`）、`toast`、`menu`（Menu/RowMenu/Popover）、`table`（DataTable：手机卡片、勾选与全选本页、无数据/无匹配两种空状态、>120 行虚拟滚动；Pager 可改每页条数与跳页）、`charts`（recharts `TrendChart`，带 sr-only 数据表）、`ring`、`qr-code`。**详情、编辑、新建一律是居中弹窗，没有侧边抽屉。**
- `src/login/`（v2 login-*）：品牌标记与站点名在卡片上方；通行密钥按钮在最上（可发现凭据；等待时按钮自身转圈、表单禁用、可取消 = `getAssertion(options, signal)`），"或用邮箱和密码"下是表单（主按钮）；凭据错误 = 顶部红色提示 + 两个输入框标红 + 密码清空并聚焦；仅通行密钥（`auth.passkey_required`）只剩通行密钥按钮并展开"丢失了全部通行密钥？"（`akari admin reset-login <邮箱>`）；非管理员账户登录后立即登出，显示"不是管理员账户"页 +"换个账户登录"；`?next=` 显示"登录已过期"与返回的视图；`?signed_out=1` 显示"已退出登录"；密码登录后的绑定引导（可勾选之后只用通行密钥、可"以后再说"）；蜜罐 + 最短提交时间 + Turnstile。每次尝试（含非管理员）后 Turnstile 令牌作废换新，并重新取 `/auth/options`（另有每 30 秒与窗口回到前台）；打开后才开启的登录 Turnstile 让页面重新加载一次（CSP）；组件出错/超时/脚本加载失败显示「人机验证加载失败，请刷新重试」+「重试」。
- 只写的秘密输入框（Turnstile 密钥、SMTP 密码、Resend 密钥、支付密钥、告警通道密钥）一律用 `shared/ui/form` 的 `SecretInput` / `secretInputProps`（`new-password` + 1Password/LastPass/Bitwarden 忽略属性）：浏览器无视 `autocomplete="off"`，会把管理员密码填进去再随保存存成密钥；留空 = 不发送 = 不改。
- `src/console/`：
  - `routes.tsx` + `pages.ts`：`createBrowserRouter`（basename = 后台前缀下的 `/admin`），每个页面一个懒加载路由；侧栏/标签栏悬停或聚焦时预取（`prefetchPage`）。`router.tsx`：`navigate`/`setQuery`/`useRoute`/`useQueryParam`（URL 即视图，查询串即筛选与打开的对象）。
  - `data.ts`：**统一的数据层**——每次成功写请求按 API 路径的实体表（`ENTITIES`）让相关查询失效并重取（未登记的根一律重取，宁多一次请求不留旧数据）；窗口回到前台时重取；`useAction()` 执行写操作 + 成功提示 + 错误映射，等重取落地后才返回，每个按钮自己的 busy。查询键以实体名开头（`["users", …]`、`["user", id]`）。
  - `shell.tsx`（v2 外壳，proposal-v2 §6）：桌面 = 浮起的毛玻璃侧栏（**与内容同一画布 `bg-window`，侧栏列没有单独背景/边框/分隔线，四周等距 8px**；分组导航、计数（工单未读蓝、正在告警红）、可收起为 60px 图标栏（悬停提示、角标，记住 `akari.admin.sidebar`）、底部账户卡片菜单）+ 工具栏（左：面包屑「分组 › 页面 › 子页 › 打开的对象」，子页标签见 `nav.ts` 的 `SUB_LABELS`，对象名由页面用 `useCrumb(名称)` 报告（没有时按 `OPEN_LABELS` 写通用名，**不显示原始参数**）；右：搜索胶囊 ⌘K、中 / EN、深浅色、告警铃铛弹层 `components/shell-bell.tsx`（独立分包，打开时才加载））；账户菜单 = 身份 + 我的账户与通行密钥 + 主题/语言分段（`menuitemradio`）+ 退出；手机 = 顶栏（站点标识；打开了对象时为返回箭头 + 对象名；大标题滚走后显示标题；搜索、铃铛、头像菜单）+ **底部标签栏 仪表盘 / 用户 / 订单 / 工单 / 更多**（`nav.ts` 的 `TABS`）。`document.title` = `<视图> · <站点名> 管理后台`（视图 = 最后一级面包屑）。`?demo=bell|account-menu` 打开铃铛/账户菜单（设计稿对比截图用）。`useCrumb` 的对象同时记入"最近打开"（`recent.ts`，本机 localStorage `akari.admin.recent`，最多 6 条）。`<main>` 按页面加 key（区域内换子路由不重放入场动画），`main[data-page][data-ready]` 标出页面数据已到（e2e 计时用；= 导航空闲且页面上**还没有数据**的查询都已返回，提交后直接问查询缓存；后台重取不算；只是细节的查询加 `meta: SECONDARY`（`data.ts`）不等）。首页 ready 后依次预取常用页面分包（`pages.ts` 的 `prefetchIdle`：第一个（用户）立即开始，其余在空闲时；Save-Data/2G 不预取），用户 / 节点 / 系统设置三页同时预取首屏数据（各页导出 `prefetchData(qc)`，与页面同 key、同请求；链接悬停/聚焦/触摸时也预取）。系统设置概览只发一个 `GET /settings/overview`（每部分 = 该分区自己的 GET），结果预填各分区的查询缓存，分区查询在它返回后才启用（失败时各自去取）。退出登录一律去 `signedOutUrl`（登录页 `?signed_out=1` 显示"已退出登录"）。
  - `pages/more.tsx`："更多"页（手机标签栏进入，桌面也能打开）：账户卡片、搜索胶囊、按侧栏分组的全部页面（`nav[aria-label=全部页面]`）、语言与外观分段控件、退出与版本。
  - `palette.tsx`：cmdk 命令面板（独立 chunk，首次打开时加载）：空输入 = 最近打开 + 操作 + 全部页面；输入时搜页面、操作、设置分区（`settings-ia.ts` 的名称与 `keywords`），2 字符起前 3 个用户、3 字符起订单（订单号或邮箱，精确）；`@` 只搜用户、`#` 只搜订单（输入框左侧模式标签，可清除，退格退出）。
  - 分流规则编辑器（SET-11，路由 PR 3）：`pages/settings-routing.tsx`（`settings.tsx` 里 `lazy()` 加载，自己一个分包）+ `components/routing-editor.tsx`（条目、自动识别输入框、线路、测试框、一句话、客户端预览）+ `components/routing-model.ts`（纯逻辑，`routing-model.test.ts`）。客户端分组预览照 `src/sub/groups.rs` 的规则算，测试框照客户端"第一条命中"的顺序算；改后端分组/匹配规则时同步这里。规则集检查 `POST …/rule-set/check` 在 `data.ts` 的只读 POST 名单里（不触发重取）。
  - `kit.tsx`（FormError、useDebounced、CopyButton、Mono、StatusBadge、Stat）、`components/`（v2 kit，见下）、`session.tsx`（`useMe`/`useSite`/`useBadges`/`useCrumb`）、`servers.ts`（服务器列表与状态）、`pages/*`（每个导航项一个页面；`protocols.gen.ts` 由 `make gen-protocols` 从 `proto/protocols.toml` 生成）。

## v2 kit（2026-10 改版第 3 轮：各页面按 v2 设计稿移植时只用这些）

设计稿 `design/admin-redesign-2026-10/proposal-v2.md` §7 的组件已合并去重进后台（真实数据 props、`tr()` 双语、只用令牌）。缺什么先放页面本地或 `src/console/components/<区域>-*.tsx`，不要改共享文件。

- **基础控件 `src/shared/ui/`**（原有，v2 补充）：`layout` — `KV` 另收对象项 `{k, v, mono?, span?}[]` + `cols` 成 v2 网格；`SectionTitle` 加 `count`、`action`、`page`（卡片外的 headline 小标题）；`Banner`（单行页内提示 + 操作）。`states` — `ErrorState` 加 `title`、`raw`（可折叠原文）；`SkeletonRows`（与真实行同高的列表骨架）。`table` — `FilterChip` 改为 v2 主色淡底、`value`/`onClear` 可选。`ring` — `Gauge`（环形仪表 + 标签 + 明细，≥80 琥珀、≥95 红）、`Spark`（= `Sparkline`）。`charts` — `MetricChart`（仪表盘大图：`metric` net/orders/signups/traffic，数据即 `GET /dashboard` 的 `series` 行；净营收提示框 实收/退款（按退款日）/净额、负值红柱；流量为面积，有 `direct_bytes/relay_bytes` 时堆叠 直连/中转/其他）、`LineChart`（多线 + `area`/`dashed`，合并 v2 的 LinesChart 与 UsageChart；与 `TrendChart` 同样的 `times` + `series[{label, values, slot}]`）。弹窗 `Dialog` 已含 v2 的 `dirty`；**SmallConfirm = `useConfirm({ tone: "default" | "warning" })`**，DangerConfirm = `useConfirm({ impacts, typeToConfirm })`。
- **`src/console/components/kit.tsx`**：`SearchField`（必须给 `label`；`shortcut="/"`、`autofocus`）、`StatStrip`（带 `onClick` 的格子是筛选按钮）、`RelDays`（站点日，<3 天红、≤7 天黄）、`CopyText`、`Avatar`（`name`、`size` px，颜色取图表令牌）、`IconBadge`（合并 IconBadge/IconBox/IconTile：`icon` 或 children、`tone`、`round`、`size`）、`ChannelIcon`、`EntranceChip`、`ListItem`、`Timeline`、`Steps`（纵向进度）、`Stepper`（向导步骤条，已完成可点回）、`PageTabs`（子路由页面标签，NavLink）、`SelectionBar`（浮动批量操作条）、`FixCount`、`ImpactList`、`Spin`、`AsyncButton`（`onClick` 返回 promise，自己的转圈）、`RawError`、`WarningItem`、`Fresh`（喂 `q.dataUpdatedAt` / `q.isError && q.data` / `q.refetch`）、`PreviewPane`（服务端已消毒的 `html`，ok/rendering/error + 重试）。
- **`src/console/components/inputs.tsx`**：`numErr(raw, tr, {min,max,int,money,allowEmpty})`、`intErr`/`intError`/`intOf`/`numText`、`AffixInput`（¥ 前缀 / GB 后缀）、`UnitInput`、`RadioCards`、`ChoiceChip`、`LangTabs`（中 / EN + 填写状态点）、`GroupChips`（`groups` 来自 `servers.ts` 的 `useGroups`）、`PasswordField`（生成 / 显示 / 强度条）。
- **`src/console/components/status.tsx`**：`OrdStatus`（含 未开通 / 退款中 / 部分退款 / 已过期；`orderState(row)`）、`UserStatus`（含 已注销；`userState(row)`）、`CouponStatus`（`couponState(row)`）、`ServerStatus`（`serverStateOf(row)`）；都可传 `state` 或行。
- **`src/console/components/settings-kit.tsx`**（原 `pages/settings-kit.tsx`）：`useDraft`（服务器值 + 补丁；保存成功后调 `saved()` 而不是 `reset()`：只去掉发出去的修改，保存进行中又改的留在保存栏）、`useSavePart` + **`SectionForm`**（唯一保存栏的作用域：汇总、⌘S、离开保护；系统设置每个分区一个）+ `SaveBar`（展示组件）、`FieldRow`/`SwitchRow`（加 `changed` 蓝条）、`InfoRow`、`SRow`（v2：多控件行，`changed`/`locked`/`error`/`wide`）、`DangerZone`/`DangerRow`、`useOwner`/`OwnerNotice`/`OwnerBadge`、`ReadValue`、`Panel`、`Loaded`、`Warnings`、`TimeZonePicker`、校验 `intError`/`intErr`/`domainError`/`urlError`。
- **路由**：`router.tsx` 的 `useQS()` → `[query, patch(obj, replace?)]`，一次改多个查询参数（`null`/"" 删除；默认 push，搜索框打字时传 `replace`）。
- **截图集**：`e2e/screens/<区域>.ts`，格式见 `e2e/screens/README.md`。

## 命令

```bash
npm ci
npm run check     # tsc + eslint + prettier + 错误码表 + 双语检查（check-i18n）+ vitest
npm run build     # 两个包 + check-bundles
make admin        # 仓库根：同上
```

e2e：`scripts/e2e.sh`（`make e2e` 先跑门户套件 `scripts/e2e-portal.sh` 再跑本套件）起一个独立的面板 + Mailpit + 本地发布源，Playwright 两个项目 desktop（Desktop Chrome）与 mobile（Pixel 7），中文界面、串行。`e2e/helpers.ts`：`openConsole`（复用缓存的管理员会话）、`signIn`、`sql`（docker compose psql 造数据）、`row`/`openRow`、`dialog`（dialog 与 alertdialog 都匹配）、`confirmDialog`（alertdialog）、`toast`（`[data-sonner-toast]`；每次消耗一条新提示并打标记：同一操作连做两次时等第二条，不会被 4.5 秒内还在的上一条放过）、`nav`（桌面侧栏；手机标签栏，否则"更多"）、`accountMenu`。每个 spec 都要能在同一库里先后跑 desktop 与 mobile（名字用 `uniq(info, …)`，改全局设置的用例结束时恢复原样）；写操作后的断言**不允许 `page.reload()`**（列表、详情、徽标必须自己更新）。**不允许 `force: true` 点击**：点不中就是真问题。手机页面不得横向溢出：`openConsole` 在页面数据到达后、以及用例点名的位置（`expectFits`）断言 `scrollWidth` 不超过项目配置的屏幕宽度（不是 `innerWidth`——Android 版 Chrome 会把过宽的页面整体缩小，`innerWidth` 随之变大，固定栏与弹窗跟着变宽、点击落到目标旁边；软断言，一次列出全部溢出页面与最内层的溢出元素）。常见原因：`grid` 的隐式列按内容的 min-content 撑开（长地址、长 id），给容器 `grid-cols-1`（`minmax(0,1fr)`）或子项 `min-w-0`。`zz-screens.spec.ts` 最后跑：v2 设计稿同名镜头（按区域写在 `e2e/screens/<区域>.ts`）在同样视口（1440×900、390×844@2x）与主题下的截图集（`test-results/screens/`，CI 工件 `admin-screens`，只截图不断言，四种变体并行、总时长 `SCREENS_BUDGET_MIN` 默认 10 分钟；与设计稿并排放在 `design/admin-redesign-2026-10/compare/`）。`zz-passkeys.spec.ts`：把主域名设为 `e2e.localhost:<端口>`（Chromium 把 `*.localhost` 解析到本机且视为安全上下文；面板对 `localhost`/`*.localhost` 主域名同时接受其 http 源，`passkey::Rp::localhost_http`），用 CDP 虚拟认证器，结束后恢复。`zz-perf.spec.ts` 最后跑：首屏 ready 与 LCP、切页（仪表盘 → 用户 → 节点 → 订单 → 设置；时间 = 页面内记录的"点击目标链接 → `main[data-ready]`"，"更多"后面的页面从第二次点击算，不含 Playwright 自身往返与断言轮询，墙钟时间另记在时间线 `wallMs`）、2000 行用户列表滚动的 rAF 间隔，桌面与"中端手机"（Pixel 7 + CDP CPU×4 + Fast 3G）各 5 次取中位数（第 1 次单列为首访），预算在 `perf-budget.json`，结果写 Step Summary 与工件 `admin-perf`（`perf-timeline.json`：首屏请求时间线 + 每次热切页的请求、长任务、点击/首个 API 返回/ready 时刻）；`perf-budget.json` 为 **`"blocking": true`**（超预算即失败；`PERF_BLOCKING=1` 同效）：每项预算 = 至少两次 CI（要包含一次慢机器：CI 机器之间可差 2 倍）的最大中位数 × 1.3（向上取整到 10 ms），且不超过计划目标（桌面切页 ≤300 ms、首屏 ≤1.2 s；手机切页 ≤900 ms、首屏 ≤3.0 s），由 `scripts/perf-budget.py` 生成（计划目标存在 `"targets"` 里）；首访（冷缓存）单列、不设预算。

## 双语（SH-13）：切换语言 = 整个后台一起切换

- **每一段运营者可见的文字都经 `tr("中文", "English")`**（`useTr()`；组件外用 `trFor(lang)`），包括按钮、标签、`aria-label`、占位符、提示、toast、确认框、空状态、图表图例、页面标题；不要写"只有中文"的字符串，也不要在英文里夹中文（中文的顿号「、」、全角括号与冒号也只放在中文那一半）。枚举/状态/种类的名称用 `{ zh, en }` 表或返回 `tr(...)` 的函数；拼接列表时分隔符也要按语言（`lang === "en" ? ", " : "、"`）。
- 服务端错误一律经 `errorText(err, lang)`（`useErrText()`、`useAction()` 已内置）；新错误码在 `errors.gen.ts` 里中英各一份（`check-error-codes.mjs`）。
- 日期时间用 `format.ts`（站点时区、数字格式，与语言无关）；相对时间与时长用 `ago(iso, lang)` / `duration(secs, lang)`；数字分组用 `toLocaleString()`（两种语言相同）。
- 语言切换走 `LangProvider` 的 context：凡是用 `useTr()`/`useLang()` 的组件都会重渲染。**不要**在模块顶层或 `useMemo` 无依赖地把 `tr(...)` 的结果缓存起来（依赖里要有 `tr`/`lang`）。
- `scripts/check-i18n.mjs`（`npm run check`）：源码里每个含中文的字符串/模板/JSX 文本必须是 `tr()` 的第一个参数、同时有 `en` 的对象里的 `zh`、`["中文", "English"]` 二元组的第一个、或 `lang === "en" ? … : "中文"` 的后一支；英文那一半含中文也报错。确实与语言无关的（语言自己的名字"中文"、品牌字形）在同一行写 `// i18n-ok: 原因`。没有豁免名单：任何文件出现一处即失败（改版时遗留的 155 处已全部补齐英文）。`--list` 列出全部。`protocols.gen.ts` 不查：清单（`proto/protocols.toml`，agent 严格解析、不能随意加键）只有中文标签，英文在 `protocol-form.ts` 的 `FIELD_EN`，`protocol-form.test.ts` 保证每个字段都有英文。

## 约定

- 新功能先进 `INVENTORY.md`（编号），再实现，再写 e2e（标题带编号）；桌面与手机都要可用。
- 运营者可见文案中英双语；错误一律经 `errorText` 映射（不显示原始英文消息）。
- 破坏性操作：确认框写明影响数量，删除类要求输入名称/确认文字。
