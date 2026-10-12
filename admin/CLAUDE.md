# admin/ — 管理后台（W33-b）

独立的 Vite 8 + React 19 + TypeScript + Tailwind 4 应用（2026-10 改版：Radix、lucide、sonner、cmdk、react-router 7、react-query、@tanstack/react-virtual、recharts、CodeMirror 6；视觉见 `design/admin-redesign-2026-10/`），与门户 `spa/` **不共享任何代码、路由或产物**。功能清单（验收基准）是 `INVENTORY.md`：每一行都有 Playwright 用例（测试标题里写清单编号）。

## 两个包

| 包 | 入口 | 产物 | 服务（`src/console.rs`） |
|---|---|---|---|
| 登录页 | `login.html` → `src/login/` | `dist/login` | `/{prefix}/app`（公开，只在后台前缀下；`no-store`）、`/{prefix}/app/assets/*`（immutable） |
| 控制台 | `index.html` → `src/console/` | `dist/console`（按页面分包） | `/{prefix}/admin`、`/{prefix}/admin/*`、`/{prefix}/admin/assets/*`（只对管理员会话，`private, no-store`；其他一律规范拒绝） |

- `vite.config.ts`：`ADMIN_ENTRY=login|console` 各构建一次；`base` 分别为 `/app/`、`/admin/`（面板运行时只在**下发的 HTML** 里把 `"/app/assets/`、`"/admin/assets/` 改写到前缀下，**不要改 base**）；`modulePreload: false`、`cssCodeSplit: false`。控制台**按页面分包**（2026-10 改版：react-router 懒加载路由，每个页面一个 chunk；recharts、CodeMirror、命令面板 cmdk 各在自己的 chunk 里，用到时才加载）：`experimental.renderBuiltUrl` 让 JS/CSS 里引用的分包与字体都写成**相对于引用它的文件**的路径，所以天然落在入口脚本所在的前缀下；只有 HTML 里是绝对路径（由面板改写）。
- `loginGuard`：登录页的依赖图里不得出现 `src/console/`，也不得出现控制台专用库（recharts、cmdk、react-router、react-query、react-virtual、CodeMirror、d3）——登录页保持单个小包。登录页只带自己的小错误表（`src/login/app.tsx` 的 `LOGIN_ERRORS`，`check-error-codes.mjs` 校验其中的码都已登记）。
- `scripts/check-bundles.mjs`（`npm run build` 末尾，smoke 对实际下发的文件再跑一次）：控制台标记必须出现在控制台包、不得出现在登录页包与门户包；门户标记不得出现在后台包；JS/CSS 里不得出现绝对的 `"/admin/assets/`、`"/app/assets/`；每个被引用的分包/字体文件都必须存在；登录页恰好 1 个 JS chunk，控制台 ≥2 个。smoke 在真实前缀下逐个取回控制台的全部分包与字体（都必须 200），并断言无会话时分包是规范拒绝；e2e `SH-19` 逐页打开、断言无 404/CSP 报告。
- `scripts/bundle-report.mjs`（`npm run build` 末尾）：各分包 gzip 大小写入 `dist/bundle-report.json` 与 GitHub Step Summary（CI 工件 `admin-bundle-report`）。**体积只报告、不设门槛**（用户裁决 2026-10-07）。
- 字体：Inter（拉丁子集）+ Noto Sans SC（按 unicode-range 分片），随产物发布（`src/assets/fonts/`，许可在 `public/assets/licenses/`）。子集由 `scripts/subset-admin-font.py` 生成（`scripts/collect-text.mjs` 收集源码里的中文 + `scripts/cjk-slices/sc.txt`；Noto 源文件在构建时读取门户的 `../spa/fonts-src/noto/NotoSansSC-VF.woff2`，可用 `NOTO_SRC` 覆盖——只读输入，不共享代码或产物，符合 R23）。**新增中文文案后重新生成子集**（需要 fonttools）。
- `scripts/check-tokens.mjs`（`npm run check`）：后台 `src/shared/index.css` 的动效变量（`--ease-*`、`--dur-*`）必须与门户 `../spa/src/index.css` 的**数值**一致（只比对，不共享源码）。
- CSP 一律 `default-src 'self'; style-src 'self' 'unsafe-inline'`：不得有内联脚本。Turnstile 只在登录页、只在开启时由面板放宽 CSP。

## 目录

- `src/shared/`：两个包共用（i18n、API 客户端、错误映射、格式化、主题、通行密钥、UI 组件）。**不得**引用 `src/console/` 或 `src/login/`。
  - `api.ts`：`request`/`get`/`post`/…；204 返回 `null`；401 交给 `setUnauthorizedHandler`（控制台：整页跳到登录页并带 `?next=`）；每次成功的写请求通知 `setWriteListener`（控制台的数据层据此失效查询）。
  - `errors.gen.ts`：由 `src/error_codes.txt` 生成的中英错误表（`errorText`）；新错误码必须在这里有中英两份（`check-error-codes.mjs`：与登记表一致、两种语言非空、英文里没有中文）。
  - `i18n.tsx`：内联 `tr("中文", "English")`；语言存 `akari.admin.lang`。`theme.ts`：浅/深色存 `akari.admin.theme`，否则跟随系统。
  - `format.ts`：时间一律按**站点时区**（`/settings` 的 `timezone`）显示，不用浏览器时区。
  - `index.css`：设计令牌（类 macOS：主色 `#2563eb`/深色 `#4a9dff`、石墨灰分层、毛玻璃 `.glass`、`--scrim`、图表色 `--chart-1..8`、圆角、阴影、字号令牌 `text-caption|footnote|body|callout|headline|title3|title2|title1`、`.hit-44`、减少动效/透明度）。**不用任意字号（`text-[13px]`）与硬编码颜色**。
  - `ui/`（Radix + lucide + sonner）：`button`（Button/ButtonLink）、`badge`、`card`（Card/Group/Row/Tile）、`form`（Input、Textarea、原生 Select、`Field`（错误经 `aria-invalid`/`aria-describedby` 关联）、`SecretInput`、Switch/`SwitchField`、Checkbox、Segmented、Kbd/`MOD_KEY`）、`tabs`、`states`（Skeleton、LoadingBlock、EmptyState、带重试的 ErrorState）、`meter`、`layout`（PageHeader、Callout、KV、SettingRow、SectionTitle）、`dialog`（Radix Dialog，sm/md/lg/xl，手机全屏；**有修改时 Esc/点遮罩/关闭先问"放弃未保存的修改？"**，`data-nodirty` 例外；只自动聚焦 `[data-autofocus]`；Esc 只关最上一层）、`confirm`（`useConfirm`：影响列表、输入确认文字 `typeToConfirm`）、`toast`、`menu`（Menu/RowMenu/Popover）、`table`（DataTable：手机卡片、勾选与全选本页、无数据/无匹配两种空状态、>120 行虚拟滚动；Pager 可改每页条数与跳页）、`charts`（recharts `TrendChart`，带 sr-only 数据表）、`ring`、`qr-code`。**详情、编辑、新建一律是居中弹窗，没有侧边抽屉。**
- `src/login/`：邮箱 + 密码、通行密钥（可发现凭据；两个按钮各自转圈）、仅通行密钥提示（含 `akari admin reset-login`）、密码登录后的绑定引导、蜜罐 + 最短提交时间 + Turnstile；凭据错误时输入框标红；非管理员账户登录后立即登出并提示。每次尝试（含非管理员）后 Turnstile 令牌作废换新，并重新取 `/auth/options`（另有每 30 秒与窗口回到前台）；打开后才开启的登录 Turnstile 让页面重新加载一次（CSP）；组件出错/超时/脚本加载失败显示「人机验证加载失败，请刷新重试」+「重试」。
- 只写的秘密输入框（Turnstile 密钥、SMTP 密码、Resend 密钥、支付密钥、告警通道密钥）一律用 `shared/ui/form` 的 `SecretInput` / `secretInputProps`（`new-password` + 1Password/LastPass/Bitwarden 忽略属性）：浏览器无视 `autocomplete="off"`，会把管理员密码填进去再随保存存成密钥；留空 = 不发送 = 不改。
- `src/console/`：
  - `routes.tsx` + `pages.ts`：`createBrowserRouter`（basename = 后台前缀下的 `/admin`），每个页面一个懒加载路由；侧栏/标签栏悬停或聚焦时预取（`prefetchPage`）。`router.tsx`：`navigate`/`setQuery`/`useRoute`/`useQueryParam`（URL 即视图，查询串即筛选与打开的对象）。
  - `data.ts`：**统一的数据层**——每次成功写请求按 API 路径的实体表（`ENTITIES`）让相关查询失效并重取（未登记的根一律重取，宁多一次请求不留旧数据）；窗口回到前台时重取；`useAction()` 执行写操作 + 成功提示 + 错误映射，等重取落地后才返回，每个按钮自己的 busy。查询键以实体名开头（`["users", …]`、`["user", id]`）。
  - `shell.tsx`：桌面 = 浮起的毛玻璃侧栏（分组导航、待处理计数、可折叠并记住 `akari.admin.sidebar`、底部账户卡片菜单）+ 工具栏（按设计稿：左侧搜索 / ⌘K，右侧主题、告警铃铛；语言在账户菜单；`useCrumb` 目前不显示）；手机 = 顶栏（站点标识、搜索、铃铛、账户菜单）+ **底部标签栏 仪表盘 / 用户 / 订单 / 工单 / 更多**（`nav.ts` 的 `TABS`），"更多"页（`pages/more.tsx`）列出全部页面并带语言与主题。`main[data-page][data-ready]` 标出页面数据已到（e2e 计时用）。
  - `palette.tsx`：cmdk 命令面板（独立 chunk，首次打开时加载）：页面、常用操作、`@` 只搜用户、`#` 只搜订单。
  - `kit.tsx`（FormError、useDebounced、CopyButton、Mono、StatusBadge、Stat）、`session.tsx`（`useMe`/`useSite`/`useBadges`/`useCrumb`）、`servers.ts`（服务器列表与状态）、`pages/*`（每个导航项一个页面；`protocols.gen.ts` 由 `make gen-protocols` 从 `proto/protocols.toml` 生成）。

## 命令

```bash
npm ci
npm run check     # tsc + eslint + prettier + 错误码表 + vitest
npm run build     # 两个包 + check-bundles
make admin        # 仓库根：同上
```

e2e：`scripts/e2e.sh`（`make e2e` 先跑门户套件 `scripts/e2e-portal.sh` 再跑本套件）起一个独立的面板 + Mailpit + 本地发布源，Playwright 两个项目 desktop（Desktop Chrome）与 mobile（Pixel 7），中文界面、串行。`e2e/helpers.ts`：`openConsole`（复用缓存的管理员会话）、`signIn`、`sql`（docker compose psql 造数据）、`row`/`openRow`、`dialog`（dialog 与 alertdialog 都匹配）、`confirmDialog`（alertdialog）、`toast`（`[data-sonner-toast]`）、`nav`（桌面侧栏；手机标签栏，否则"更多"）、`accountMenu`。每个 spec 都要能在同一库里先后跑 desktop 与 mobile（名字用 `uniq(info, …)`，改全局设置的用例结束时恢复原样）；写操作后的断言**不允许 `page.reload()`**（列表、详情、徽标必须自己更新）。`zz-screens.spec.ts` 最后跑：与设计稿相同的画面、视口（1440×900、390×844@2x）与主题的截图集（`test-results/screens/`，CI 工件 `admin-screens`，只截图不断言；与设计稿并排放在 `design/admin-redesign-2026-10/compare/`）。`zz-passkeys.spec.ts`：把主域名设为 `e2e.localhost:<端口>`（Chromium 把 `*.localhost` 解析到本机且视为安全上下文；面板对 `localhost`/`*.localhost` 主域名同时接受其 http 源，`passkey::Rp::localhost_http`），用 CDP 虚拟认证器，结束后恢复。`zz-perf.spec.ts` 最后跑（**只报告**）：首屏 ready 与 LCP、切页（仪表盘 → 用户 → 节点 → 订单 → 设置）、2000 行用户列表滚动的 rAF 间隔，桌面与"中端手机"（Pixel 7 + CDP CPU×4 + Fast 3G）各 5 次取中位数（第 1 次单列为首访），预算在 `perf-budget.json`，结果写 Step Summary 与工件 `admin-perf`；CI 跑够 10 次后按中位数 +30% 定预算再打开阻断。

## 约定

- 新功能先进 `INVENTORY.md`（编号），再实现，再写 e2e（标题带编号）；桌面与手机都要可用。
- 运营者可见文案中英双语；错误一律经 `errorText` 映射（不显示原始英文消息）。
- 破坏性操作：确认框写明影响数量，删除类要求输入名称/确认文字。
