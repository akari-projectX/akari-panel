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
npm run build          # tsc -b && vite build → dist/app，然后 check-dist、check-bundles、bundle-budget
npm run e2e            # = ../scripts/e2e-portal.sh（make e2e；见「端到端」）
npx knip               # 可选：查未用的文件/导出/依赖
```

CI（`.github/workflows/ci.yml` 的 `spa` job）：npm ci → audit → typecheck → lint → check:errors → check:i18n → test → build。

## 结构

| 路径 | 内容 |
|---|---|
| `src/api/` | **与面板的唯一边界**，页面只从 `@/api` 导入：`base.ts`（`/api/v1`、`/auth`、品牌图片、深链接）、`http.ts`（请求、`ApiError{status,code,params}`、会话事件：401 / 403 `account.banned` 广播给 AuthProvider）、`types.ts`（面板视图的形状，手工镜像 Rust 视图——改后端字段要同步）、`index.ts`（全部调用：auth / me / account（注销）/ passkey / shop / order / wallet / invite / ticket / content / page）、`guard.ts`（表单令牌、最短提交时间、蜜罐、Turnstile 令牌；`lib/form-guard` 在表单挂着时定期/回到前台/每次提交后经 `SiteProvider.refresh` 重新取 `/auth/options`，打开后才开启的 Turnstile 让页面重新加载一次；组件出错/超时/脚本加载失败时 `components/form-guard` 显示「人机验证加载失败，请刷新重试」+「重试」（脚本失败 = 重新加载页面，组件失败 = 重置组件））、`pow.ts`（关闭邮箱验证时注册的工作量证明）、`webauthn.ts`（options ↔ 浏览器 API 的 base64url 编解码） |
| `src/lib/routes.ts` | 路由表与每页的账户范围（`PAGE_SCOPES`）。**顶层路径必须与面板 `access::PORTAL_PAGES` 一致**：面板测试 `access::tests::routes_match_the_portal` 读这个文件比对 |
| `src/lib/auth.ts`、`auth-provider.tsx` | 登录态：`GET /me` 为准（401 或统一拒绝 404 = 没登录；同一浏览器里的管理员会话在门户上就是 404）；范围 `scopeOf`：full（AuthUser）/ renewal（到期或流量用完，ShopUser）/ banned（PortalUser）。管理员不在门户里（D4） |
| `src/lib/sub-links.ts` | 订阅地址只用 `me.sub_url`（D11 随机路径、D8 订阅域名；相对地址补本站 origin）；格式选择按 `me.sub_formats`，一键导入按 `me.sub_import_clients`（面板 `sub::IMPORT_CLIENTS`，已按开着的格式筛过）在前端按各客户端 scheme 拼链接 |
| `src/pages/registry.ts` | 全部页面按需加载（`lazyRetry`）；`pages/auth.tsx`（登录/注册/找回/重置）、`pages/legal.tsx`（条款/隐私）、`pages/dash/*`（用户中心） |
| `src/i18n/` | `tr('简体原文')` + 英文词典 `dict.ts`（键 = 简体原文，按需加载）；错误码文案 `errors.ts`（`CODE_KEYS`：码 → `errors.*`，`errorText` 填 params，`<p>_cents` 另给 `<p>_yuan`） |
| `src/components/server-html.tsx` | 全站唯一的 `dangerouslySetInnerHTML`：只接面板服务端渲染并清洗过的公告 / 知识库 / 条款 HTML（`src/markdown.rs`） |
| `e2e/` | Playwright：`seed.ts`（经后台接口灌数据）、`panel.ts`（接口客户端、Mailpit、psql）、`fixtures.ts`（每个用例收集 CSP 违规与页面异常，必须为空）、`*.spec.ts`、`mock-alipay.py`、`tls-proxy.mjs` |
| `scripts/` | `check-dist.mjs`、`check-bundles.mjs`、`bundle-budget.mjs`、`check-error-codes.mjs`、`check-i18n.mjs`、`collect-text.mjs` + `subset-akari-font.py`（字体子集） |

## 路由表

| 路径 | 页面 | 账户范围 |
|---|---|---|
| `/` | 仪表盘（续费范围：缩减版 + 续费横幅；封禁：封禁说明） | 全部 |
| `/shop` | 商店（服务端报价、优惠码（只在确认订单弹窗里填，列表不带码）、余额抵扣、折算与作废确认、拒绝原因、支付方式） | full、renewal |
| `/orders`、`/orders/:id` | 订单列表（类型列 `action`）、详情与付款（二维码 / 收银台，轮询）、退款去向 | full、renewal |
| `/wallet` | 余额、流水、USDT 提现（R46：网络、地址提示、TON Memo、参考汇率、实付与交易哈希；提现仅 full） | full、renewal |
| `/invite` | 邀请链接（面板给的 `link_base`）、邀请码、返佣 | full |
| `/nodes` | 可用入口（每个入口一行；倍率 = 此刻生效的倍率，D9；状态 在线/离线/维护中（中转健康检查失败或服务器额度用完 = 维护中，置灰，订阅里没有它）、负载等级、延迟参考（面板 TCP 测速优先），图例 + 每 30 秒刷新（`hooks/use-auto-reload`，仪表盘「订阅内的线路」同样）） | full |
| `/traffic` | 流量明细（站点时区的日界；按线路 = 每个入口一行，显示此刻倍率与时段规则，不显示计费 ÷ 原始的混合比值） | full |
| `/tickets` | 工单 | full、renewal、banned |
| `/help`、`/announcements` | 知识库、公告 | full、renewal |
| `/account` | 账号（未验证时「验证这个邮箱」弹窗）、更换邮箱（新地址 + 当前密码 / 通行密钥 + 验证码）、语言（= 邮件语言）、注销（危险弹窗：`/me/delete-impact` 列出会失去的内容 + 密码或通行密钥 + 勾选不可恢复）；`?tab=security`：密码、通行密钥、只用通行密钥、订阅与重置。验证当前邮箱的弹窗是 `components/verify-email-dialog`（仪表盘提醒条也用它），确认是本人的输入是 `components/holder-confirm` + `hooks/use-holder-confirm` | full、renewal |
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
- **金额**：整数分，`lib/format.ts` 的 `yuan`/`formatMoney`/`parseYuan` 不经过浮点；前端不算价，报价全部来自 `/me/shop`；余额本身不为负（佣金追回不够时记欠款）。
- **时间**：RFC 3339，按全站时区显示（`/me`、`/auth/options` 的 `timezone`）。
- **退款显示**：`MyOrderView` 的 `refund_route`（original 原路退回 / balance 退到余额 / manual 支付渠道后台退款后登记）、`refund_balance_cents`/`refund_external_cents`、`refund_pending`（原路退款等渠道确认）、`refund_effect`（P1：none/cancel/rollback/restore）。

## 端到端（`../scripts/e2e-portal.sh`，CI job `e2e`）

起一个真实面板（独立库 `akari_e2e`、Valkey 15、`/tmp/akari-e2e`、端口 8090）、Mailpit（11026/18026）、模拟支付宝（18489，含原路退款）、一个占着中转入口端口的 TCP 监听（否则健康检查 3 分钟后隐藏该入口），
以及 **TLS 前端** `e2e/tls-proxy.mjs`：浏览器访问 `https://portal.e2e.test:8493`（Chromium 用 `--host-resolver-rules` 指到本机、`--ignore-certificate-errors-spki-list` 只信任那把临时密钥）——主域名是 https 源，通行密钥（虚拟认证器）因此能端到端走通，邮件链接也指向它。
种子数据与测试里的接口调用直连 `http://127.0.0.1:8090`（IP 字面量过得了主域名闸门）。代理给每个连接一个随机的 `X-Forwarded-For`，按地址的限速不会串到别的用例。
桌面（Desktop Chrome）与手机（Pixel 7）各跑一遍；会改状态的用例每个视口用自己的账户（`mine(info, 'shop')` → `shop-desktop@e2e.test`）。
验收清单是 `research/portal-gap.md`，用例标题里的 `#n` 对应清单行号。本机（WSL）缺 `libgbm` 时把 mesa 的库放进一个目录并设 `LD_LIBRARY_PATH`；`PANEL_BIN=…/debug/akari` 可用 debug 构建。

## 体积预算（`scripts/bundle-budget.mjs`，KiB）

initialJs 145（gzip）、initialCss 30、totalJs 440、totalCss 40、fonts 1450（原始字节）。调高前先看 `vite build` 的输出找出谁变大；新的重页面/重依赖用 `lazyRetry` 拆出去。

## 字体

全平台用 **Noto Sans SC**（SIL OFL 1.1；原文 `fonts-src/noto/OFL.txt`，随产物发布于 `assets/licenses/NotoSansSC-OFL.txt`，并进 `make third-party` 清单）。只收需要的字：`scripts/subset-akari-font.py`（需 fonttools + brotli；`collect-text.mjs` 从源码字符串统计界面用字 + 常用 3500 字 + `fonts-src/akari/extra-chars.txt`，按字频切约 110 片，`unicode-range` 按实际字形写）。**改了界面中文文案就重跑**，否则新字会落到系统字体。

## 这几处别拆

- `index.html` 不加内联任何东西，启动逻辑在 `src/boot/`（`boot.js` 作为带哈希的经典脚本输出，管首帧明暗与启动失败兜底）。
- 常青浏览器（es2023），不做 polyfill 与旧存储键迁移。
- `scrollbar-gutter: stable` + `body[data-scroll-locked]`；触屏输入框 16px（不用 `maximum-scale=1`）。
- 版权与站名用后台的站点名称（`/auth/options.site_name`）；条款、隐私只取知识库内容——**不要在门户里写任何法律承诺或营销断言**（W36-b 删除了主题自带的条款/隐私/FAQ 文本）。
- 切页动画（`PageTransition` + `FrozenOutlet`）：页面分包的 Suspense 在 `FrozenOutlet` **里面**（定格之后）。放在外面时，旧页面分包没下完就切页，定格会按新地址重做，新页面先在退场容器里渲染一遍、头 0.14 秒填的表单丢失；回归测试 `e2e/account.spec.ts`「page transition」（e2e 不需要等 `.page-out` 消失）。
