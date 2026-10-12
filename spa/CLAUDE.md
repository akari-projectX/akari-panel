# akari-panel/spa — 用户门户

React 19 + Vite 8（Rolldown）+ Tailwind 4 + shadcn/ui（Radix，`src/components/ui/` 是拷贝来的原语）+ React Router 7（BrowserRouter）。
W36-b（R45 修订）起 spa/ 就是用户门户：源码来自 Akari-theme（mwnydev/Akari-theme，导入后归档），构建配置与依赖以它为准。
**管理后台是另一个应用**（`admin/`，W33-b），门户与它不共享源码、路由与产物。

产物 `dist/app`（`index.html` + `assets/**`），面板用 rust-embed 编进二进制（`src/spa.rs` 的 `UserAssets`）：
门户在主域名根路径 `/`（D11），`access::PORTAL_PAGES` 里的每个顶层路径都返回 index，`/assets/*` 不可变缓存。改完前端 `make spa && make panel` 才生效（debug 构建运行时读磁盘上的 dist）。

## 命令

```bash
npm ci
npm run dev            # Vite 开发服务器；/api、/auth、/brand 转发到 PANEL_URL（默认 http://127.0.0.1:18480）
npm run check          # tsc -b + oxlint（任何警告即失败）+ 错误码覆盖 + 词典检查 + vitest（make check 调它）
npm run build          # tsc -b && vite build → dist/app，然后 check-dist、check-bundles
npm run report:size    # 体积报告（只报告；--base <json> 出差值，见「体积与性能」）
npm run e2e            # = ../scripts/e2e-portal.sh（make e2e；见「端到端」）
npx knip               # 可选：查未用的文件/导出/依赖
```

CI（`.github/workflows/ci.yml` 的 `spa` job）：npm ci → audit → typecheck → lint → check:errors → check:i18n → test → build。另有不阻断的 `spa-size` job（体积报告）。

## 结构

| 路径 | 内容 |
|---|---|
| `src/api/` | **与面板的唯一边界**，页面只从 `@/api` 导入：`base.ts`（`/api/v1`、`/auth`、品牌图片、深链接）、`http.ts`（请求、`ApiError{status,code,params}`、会话事件：401 / 403 `account.banned` 广播给 AuthProvider）、`types.ts`（面板视图的形状，手工镜像 Rust 视图——改后端字段要同步）、`index.ts`（全部调用：auth / me / account（注销）/ passkey / shop / order / wallet / invite / ticket / content / page）、`guard.ts`（表单令牌、最短提交时间、蜜罐、Turnstile 令牌；`lib/form-guard` 在表单挂着时定期/回到前台/每次提交后经 `SiteProvider.refresh` 重新取 `/auth/options`，打开后才开启的 Turnstile 让页面重新加载一次；组件出错/超时/脚本加载失败时 `components/form-guard` 显示「人机验证加载失败，请刷新重试」+「重试」（脚本失败 = 重新加载页面，组件失败 = 重置组件））、`pow.ts`（关闭邮箱验证时注册的工作量证明）、`webauthn.ts`（options ↔ 浏览器 API 的 base64url 编解码） |
| `src/lib/routes.ts` | 路由表与每页的账户范围（`PAGE_SCOPES`）。**顶层路径必须与面板 `access::PORTAL_PAGES` 一致**：面板测试 `access::tests::routes_match_the_portal` 读这个文件比对 |
| `src/lib/auth.ts`、`auth-provider.tsx` | 登录态：`GET /me` 为准（401 或统一拒绝 404 = 没登录；同一浏览器里的管理员会话在门户上就是 404；第一次取就遇到网络 / 服务器错误且没有缓存 = `failed`，门禁显示「重试」，不送去登录页）；范围 `scopeOf`：full（AuthUser）/ renewal（到期或流量用完，ShopUser）/ banned（PortalUser）。管理员不在门户里（D4） |
| `src/lib/sub-links.ts` | 订阅地址只用 `me.sub_url`（D11 随机路径、D8 订阅域名；相对地址补本站 origin）；格式选择按 `me.sub_formats`，一键导入按 `me.sub_import_clients`（面板 `sub::IMPORT_CLIENTS`，已按开着的格式筛过）在前端按各客户端 scheme 拼链接 |
| `src/pages/registry.ts` | 全部页面按需加载（`lazyRetry`）；`pages/auth.tsx`（登录/注册/找回/重置）、`pages/legal.tsx`（条款/隐私）、`pages/dash/*`（用户中心） |
| `src/i18n/` | `tr('简体原文')` + 英文词典 `dict.ts`（键 = 简体原文，按需加载）；错误码文案 `errors.ts`（`CODE_KEYS`：码 → `errors.*`，`errorText` 填 params，`<p>_cents` 另给 `<p>_yuan`） |
| `src/components/server-html.tsx` | 全站唯一的 `dangerouslySetInnerHTML`：只接面板服务端渲染并清洗过的公告 / 知识库 / 条款 HTML（`src/markdown.rs`） |
| `e2e/` | Playwright：`seed.ts`（经后台接口灌数据）、`panel.ts`（接口客户端、Mailpit、psql）、`fixtures.ts`（每个用例收集 CSP 违规与页面异常，必须为空）、`*.spec.ts`、`mock-alipay.py`、`tls-proxy.mjs`；`perf/`（性能报告，另一份配置 `playwright.perf.config.ts`，见「体积与性能」） |
| `scripts/` | `check-dist.mjs`、`check-bundles.mjs`、`bundle-report.mjs`、`check-error-codes.mjs`、`check-i18n.mjs`、`collect-text.mjs` + `subset-akari-font.py`（字体子集） |

## 路由表

| 路径 | 页面 | 账户范围 |
|---|---|---|
| `/` | 仪表盘（续费范围：缩减版 + 续费横幅；封禁：封禁说明） | 全部 |
| `/shop` | 商店（服务端报价、优惠码（只在确认订单弹窗里填，列表不带码）、余额抵扣、折算与作废确认、拒绝原因、支付方式） | full、renewal |
| `/orders`、`/orders/:id` | 订单列表（类型列 `action`）、详情与付款（二维码 / 收银台，轮询；手机上金额单在付款区上面）、退款去向 | full、renewal |
| `/wallet` | 余额、流水、USDT 提现（R46：网络、地址提示、TON Memo、参考汇率、实付与交易哈希；提现仅 full） | full、renewal |
| `/invite` | 邀请链接（面板给的 `link_base`）、邀请码、返佣 | full |
| `/nodes` | 可用入口（每个入口一行；倍率 = 此刻生效的倍率，D9；状态 在线/离线/维护中（中转健康检查失败或服务器额度用完 = 维护中，置灰，订阅里没有它）、负载等级、延迟参考（面板 TCP 测速优先），图例 + 每 30 秒刷新（`hooks/use-auto-reload`，仪表盘「订阅内的线路」同样）） | full |
| `/traffic` | 流量明细（站点时区的日界；按线路 = 每个入口一行，显示此刻倍率与时段规则，不显示计费 ÷ 原始的混合比值） | full |
| `/tickets` | 工单（新工单内联校验；对话打开 / 发出回复后滚到最新一条；关闭前确认） | full、renewal、banned |
| `/help`、`/announcements` | 知识库、公告 | full、renewal |
| `/account` | 设置（2026-10-12 用户裁决，走查 `design/portal-settings-audit-2026-10`）：**单页 + 分区锚点导航**（`components/settings/setting-row` 的 `SettingsNav`：桌面左侧吸顶竖排，手机页头下吸顶横排；旧链接 `?tab=security` → `#security`）。只放能改的东西，每项一行 `SettingRow`（左名称 + 说明，右当前值 + 操作）：`#account` 邮箱（已验证 / 未验证 +「验证」「更换」：`verify-email-dialog`、`settings/change-email-dialog` 两步弹窗；站点没开发信（`/auth/options.mail`）时两个按钮都不出现）、套餐一行摘要（详情在商店「当前套餐」）；`#security` 密码（`settings/password-dialog`，无密码账户用通行密钥设置第一个）、通行密钥（`settings/passkeys`：删除与开启「只用通行密钥」走确认弹窗，手机行内操作收进「⋯」）、退出所有设备（`/auth/logout`）；`#subscription` 订阅链接状态（正常 / 旧格式（可重置）/ 续费后可用）+ 重置，导入只在仪表盘；`#preferences` 界面语言（= 邮件语言，只在主动切换时同步，`AuthCtxValue.setMailLocale`）、明暗（浅 / 深 / 跟随系统，默认跟随）；`#danger` 注销（`settings/delete-account-dialog`：影响清单、可提现提示 + 去钱包、被阻止时给去处链接只留「知道了」）。确认本人的输入是 `components/holder-confirm` + `hooks/use-holder-confirm`（登录方式取不到时说明 + 重试，不默认给密码框） | full、renewal |
| `/login`、`/register`、`/forgot`、`/reset` | 登录（密码 / 通行密钥）、注册（PoW 或邮箱验证码，`?invite=` 预填）、申请重置链接、按 `#token=` 设新密码 | 未登录 |
| `/deleted` | 注销之后的结果页（会话已清掉；路由 state 带是否匿名化保留） | 公开 |
| `/terms`、`/privacy` | 条款、隐私：知识库里 slug 为 `terms` / `privacy` 的已发布文章（公开接口 `GET /api/v1/pages/{slug}`）；没写时显示中性缺省文案（门户不内置任何法律文本）；品牌设置里配了外链时页脚直接指向外链 | 公开 |

面板邮件里的链接（到期提醒 `/shop`、重置 `/reset#token=…`、邀请 `/register?invite=…`）都在这张表里。不在表里的顶层路径由面板直接回答统一的拒绝。

## 与面板的约束（改代码前先看）

- **CSP `default-src 'self'; style-src 'self' 'unsafe-inline'`**：没有内联 `<script>`、`on*` 属性、`javascript:`、第三方脚本/字体/图片，`data:` 图片也不行（`assetsInlineLimit: 0`；二维码中心的标是 `src/assets/qr-mark.svg`）。唯一例外：站长为任一表单开了 Turnstile 时，面板只给**门户页面**加 `script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com`（`web::CSP_TURNSTILE`，`spa::index`），`components/turnstile.tsx` 才去加载它。`check-dist` 检查产物。
- **门户里没有后台**：不出现后台前缀、后台 API 路径与后台文案（`check-bundles.mjs`，标记自带样例防空跑；smoke 对实际下发的全部分包再查一遍）。门户从不往后台跳。
- **会话**：httpOnly + SameSite=Strict cookie，前端不存令牌；sessionStorage 里的 `/me` 副本去掉 `sub_token`/`sub_url`。
- **错误**：按 `code` 显示（`useErrorText`），不显示 `error` 原文；统一拒绝（404 空 body）不带信息。`scripts/check-error-codes.mjs` 读 `../src/error_codes.txt`：命名空间 auth/account/signup/shop/order/coupon/balance/withdrawal/invite/ticket/request 与 `kb.query_long` 的每个码都要有 `CODE_KEYS`，多余/重复映射也失败（后台的码由后台应用检查）。新增用户可见的码 → 这里加文案。
- **文案**：所有界面中文经 `tr()`/`tp()`；`scripts/check-i18n.mjs` 要求每个含汉字的字符串都有英文条目、词典里没有没人用的条目（`--fix` 删掉）。改了中文文案要重跑字体子集（见「字体」）。
- **表单**：一律 `noValidate`，不用浏览器原生校验气泡；字段用 `components/text-field`（标签 + 输入 + 常驻帮助 / 内联错误，`aria-invalid` + `aria-describedby`，密码框带显示 / 隐藏），校验与服务端错误码 → 字段用 `lib/form-errors`（`useFieldErrors`：提交时聚焦第一个出错的字段；`fieldOf` 把能对应字段的错误码画在字段下面，其余才用 toast）。区块加载失败（`data-state` 的 `LoadError`）同样按错误码显示；整页加载失败时保留页面标题。提现、新工单同样走这一套（按钮不预先置灰，提交时逐项说明）。
- **手机宽度**：任何页面在 390px 下都不能横向滚动（e2e `polish.spec.ts`）。两栏 `.split2` 用 `minmax(0, 1fr)`；提醒条（`.notice`、待支付订单）文字至少留 15rem，放不下时按钮换到下一行；访客页头在手机上只放一个按钮；列表行右侧在手机上只留一个状态（多余的徽章挪进说明行），日期 `whitespace-nowrap`；宽表格在手机上改成行式列表（钱包、订单、返佣、节点）或只留关键列（使用明细）。
- **金额**：整数分，`lib/format.ts` 的 `yuan`/`formatMoney`/`parseYuan` 不经过浮点；前端不算价，报价全部来自 `/me/shop`；余额本身不为负（佣金追回不够时记欠款）。
- **时间**：RFC 3339，按全站时区显示（`/me`、`/auth/options` 的 `timezone`）。
- **退款显示**：`MyOrderView` 的 `refund_route`（original 原路退回 / balance 退到余额 / manual 支付渠道后台退款后登记）、`refund_balance_cents`/`refund_external_cents`、`refund_pending`（原路退款等渠道确认）、`refund_effect`（P1：none/cancel/rollback/restore）。

## 端到端（`../scripts/e2e-portal.sh`，CI job `e2e`）

起一个真实面板（独立库 `akari_e2e`、Valkey 15、`/tmp/akari-e2e`、端口 8090）、Mailpit（11026/18026）、模拟支付宝（18489，含原路退款）、一个占着中转入口端口的 TCP 监听（否则健康检查 3 分钟后隐藏该入口），
以及 **TLS 前端** `e2e/tls-proxy.mjs`：浏览器访问 `https://portal.e2e.test:8493`（Chromium 用 `--host-resolver-rules` 指到本机、`--ignore-certificate-errors-spki-list` 只信任那把临时密钥）——主域名是 https 源，通行密钥（虚拟认证器）因此能端到端走通，邮件链接也指向它。
种子数据与测试里的接口调用直连 `http://127.0.0.1:8090`（IP 字面量过得了主域名闸门）。代理给每个连接一个随机的 `X-Forwarded-For`，按地址的限速不会串到别的用例。
桌面（Desktop Chrome）与手机（Pixel 7）各跑一遍；会改状态的用例每个视口用自己的账户（`mine(info, 'shop')` → `shop-desktop@e2e.test`）。
验收清单是 `research/portal-gap.md`，用例标题里的 `#n` 对应清单行号。本机（WSL）缺 `libgbm` 时把 mesa 的库放进一个目录并设 `LD_LIBRARY_PATH`；`PANEL_BIN=…/debug/akari` 可用 debug 构建。

## 体积与性能（只报告，不设门槛）

2026-10-07 用户裁决：门户与后台都**不设硬性体积预算**（原 145 KiB 首屏 JS 门槛已删除），在交互感、性能、美观之间平衡，以真实性能指标为准；明显退化时在 PR 正文里说明理由，CI 不阻断。

- **体积**：`scripts/bundle-report.mjs` 读 Vite 清单，报首屏 JS/CSS（gzip）、全部 JS/CSS、字体与每个分包；CI `spa-size` job 同时构建基线分支，差值写进任务摘要（`continue-on-error`，不是必需检查）。新的重页面/重依赖照旧用 `lazyRetry` 拆出去，特效代码（撒花等）按需加载。
- **性能**：`e2e/perf/perf.spec.ts`（`playwright.perf.config.ts`）在 e2e 跑完后对同一个真实面板测：冷启动（新上下文、空缓存）登录页与仪表盘的 FCP、LCP、TTI（简化：FCP 之后最后一个长任务结束）、内容就绪，以及仪表盘出发的客户端切页耗时（含切页动画）；画像 desktop（不限速）与 mobile-mid（Pixel 7 + CPU 4× + 150 ms RTT、1.6 Mbps），各取 5 次中位数。`E2E_PERF_OUT=<目录>` 才跑（CI e2e job 设了，结果在任务摘要），测量失败只出警告。动效照常播放（验收用例则全部在 reduced motion 下跑）。

## 动效（全站口径，后台改版照此对齐）

令牌只在两处定义、两边一起改：CSS `src/index.css` 顶部 `:root`，JS `src/lib/motion.ts` 的 `DUR`。

| 令牌 | 值 | 用在 |
|---|---|---|
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | 一切进场与位移（快起慢收） |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | 退场 |
| `--ease-spring` | `cubic-bezier(.34,1.56,.64,1)` | 带回弹：成功图标弹出、按钮松手 |
| `--dur-press` | 120 ms | 按下（按钮、开关、`.press` 缩到 0.97） |
| `--dur-hover` | 200 ms | 悬停变色；弹出层打开 |
| `--dur-exit` / `DUR.exit` | 140 ms | 离开：旧页面、关闭的弹层 |
| `--dur-fast` / `DUR.fast` | 260 ms | 小件：列表行、切页外壳 |
| `--dur-base` / `DUR.base` | 420 ms | 块级：标题、统计条、卡片、区块 |
| `--dur-slow` / `DUR.slow` | 700 ms | 首屏大件、对勾描画 |
| `DUR.roll` | 600 ms | 数字从旧值滚到新值（`components/count-up`） |
| `DUR.celebrate` | 1.3 s | 付款成功撒花（`lib/confetti`，按需加载） |

- **入场**：`lib/motion` 的 `useEnter()` / `enterProps()` 打 `data-enter`，错峰 `stagger(i)`（每项 45 ms，最多 8 项）；块级上浮 12px，行与小件 `NUDGE` 6px，一律向上不左右滑。关键帧叫 `akari-rise`——**不能叫 `enter` / `exit`**（tw-animate-css 的同名关键帧会把它顶掉，全站入场曾因此全部失效）。切页进来时没有 `data-enter` 的区块（`.sec`）由 CSS 错峰浮起。
- **切页**：`PageTransition` 旧页淡出下沉 4px（EXIT）→ 新页上浮 8px 淡入（FAST）。
- **按下**：按钮、开关、`.press` 缩到 0.97，松手回弹；带下拉的按钮不缩。
- **数字**：统计条的数字用 `CountUp`（直接写 DOM、不重渲染）；金额给 `fmt: formatMoney`（值是分，逐分滚动）。
- **最大内容块原地渲染（LCP）**：页面的最大内容块不做入场、数字第一次直接是终值（`StatRow still` → `CountUp instant`，之后值变了照常滚动）。仪表盘的统计条就是它（#117 的入场让仪表盘 LCP 晚了 100–450 ms）；其余区块照常错峰。e2e `polish.spec.ts` 断言统计条里没有 `data-enter`。
- **复制成功**：对勾加 `pop-in`。骨架屏延迟 120 ms 淡入（`load-in`），内容到后按入场替换。
- **弹窗**（`components/ui/panels`：阅读 / 确认 / 流程 / 结果）：任何宽度都居中（2026-10-12 用户要求，不再贴底），四边 12px；`.panel` 跟随可见视口（`lib/visual-viewport` 写 `--vv-h`/`--vv-top`，软键盘弹出时挪到键盘上方）、限高 = 可见视口 − 上下 max(12px, 安全区)，超出在弹窗内部滚动、头尾不动；进场淡入 + 0.96 放大 + 上浮 8px，退场更快。流程弹窗的底栏（`FlowFooter`）在手机上按钮另起一行等宽铺满，左边的小结独占上一行（以前和小结抢宽度，「提交申请」被挤出弹窗）。
- **付款结果**（`components/pay-result`）：订单页轮询到已付款 / 超时，或商店当场付清（余额、优惠、折算全额抵扣、免费订单）带 `state.paid` 跳到订单页时弹出：成功 = 圆环 + 对勾描画、一次性撒花、金额 / 套餐 / 到期、「查看订阅」「返回仪表盘」；付了但没能开通 = 退回余额；超时 = 时钟轻摇 +「重新选购」。只弹一次（刷新不再出现）。
- **减少动效**（`prefers-reduced-motion`）：位移、缩放、描线、撒花全部关闭，内容直接到位；弹出层进退场缩成 1 ms（Radix 要等 animationend）；加载指示器只放慢。**e2e 一律在 reduced motion 下跑**（`playwright.config.ts`），性能报告则照常播放动效。
- 只动 `transform` / `opacity`（独立属性 `translate` / `scale` 优先，不覆盖元素自己的 transform）；唯一例外是结果图标的描线（56px SVG 的 `stroke-dashoffset`，只重绘不布局）。不引入动效库；特效代码按需加载。

## 字体

全平台用 **Noto Sans SC**（SIL OFL 1.1；原文 `fonts-src/noto/OFL.txt`，随产物发布于 `assets/licenses/NotoSansSC-OFL.txt`，并进 `make third-party` 清单）。只收需要的字：`scripts/subset-akari-font.py`（需 fonttools + brotli；`collect-text.mjs` 从源码字符串统计界面用字 + 常用 3500 字 + `fonts-src/akari/extra-chars.txt`，按字频切约 110 片，`unicode-range` 按实际字形写）。**改了界面中文文案就重跑**，否则新字会落到系统字体。

## 这几处别拆

- `index.html` 不加内联任何东西，启动逻辑在 `src/boot/`（`boot.js` 作为带哈希的经典脚本输出，管首帧明暗与启动失败兜底）。
- 常青浏览器（es2023），不做 polyfill 与旧存储键迁移。
- `scrollbar-gutter: stable` + `body[data-scroll-locked]`；触屏输入框 16px（不用 `maximum-scale=1`）。
- 版权与站名用后台的站点名称（`/auth/options.site_name`）；条款、隐私只取知识库内容——**不要在门户里写任何法律承诺或营销断言**（W36-b 删除了主题自带的条款/隐私/FAQ 文本）。
- 切页动画（`PageTransition` + `FrozenOutlet`）：页面分包的 Suspense 在 `FrozenOutlet` **里面**（定格之后）。放在外面时，旧页面分包没下完就切页，定格会按新地址重做，新页面先在退场容器里渲染一遍、头 0.14 秒填的表单丢失；回归测试 `e2e/account.spec.ts`「page transition」（e2e 不需要等 `.page-out` 消失）。
