# akari-panel/spa — 前端

React 19 + Vite 8 (Rolldown) + Tailwind 4 + TanStack Query 5；shadcn 风格组件为手拷代码（`src/components/ui/`）。
**两个独立打包（R23，推翻 M3 的单 SPA）**：用户门户（`index.html` → `src/main.tsx` → `src/app.tsx`，产物 `dist/app`，在 `/{prefix}/app`）与管理后台（`admin.html` → `src/admin-main.tsx` → `src/admin-app.tsx`，产物 `dist/admin`，在 `/{prefix}/admin`，仅对管理员会话下发）。`npm run build` = tsc + 两次 `vite build`（第二次 `AKARI_BUNDLE=admin`）+ `scripts/check-bundles.mjs`。共用的 `src/mount.tsx`（QueryClient + 挂载）、`lib/`、`components/`、`i18n/` 两边各自打包（不共享 chunk）。产物被 rust-embed 编进二进制。改完前端必须 `make spa && make panel` 才生效。

**门户不得引用后台代码**：`src/main.tsx`/`src/app.tsx` 及其依赖不得 import `src/admin-*`、`src/pages/admin-*`、`src/pages/audit.tsx`（门户构建的 `userBundleGuard` 直接报错）；后台专用文案、API 路径、错误映射（`lib/errors.ts` 的 `ADMIN_KNOWN`）只能出现在后台模块或只被后台调用的导出里（单模块内未用的导出会被 tree-shake）。`check-bundles.mjs` 的标记（后台 API 路径如 `/users`、`/nodes`、`/rollouts`，以及"管理后台""审计日志"等）必须同时出现在后台产物中（防失效）；新增后台视图/接口时补标记。门户只知道 `/admin` 这一个跳转目标（`adminBase`）。

## 结构

- `src/lib/api.ts` — fetch 封装与 API 类型（手工镜像 `src/api.rs` 的 View 结构，改后端字段要同步）。`appBase`/`apiBase` 从 `location` 推导，**不内嵌前缀**。
- `src/lib/router.ts` — 极简 history 路由（`usePath`/`navigate`），无路由依赖；`loadPage(url)` = 整页跳转（门户 ↔ 后台是不同的包；测试里 `vi.mock` 它）。前缀 = 路径第一段（`prefixBase`），`appBase` = `/{prefix}/app`、`adminBase` = `/{prefix}/admin`。后台视图即 URL：`/{prefix}/admin/{users|plans|orders|nodes|updates|audit|account|…}`（`admin-app.tsx` 的 `VIEWS`/`viewOf`；深链与后退可用）。门户：`/me` 为管理员或 enroll 阶段 → `loadPage(adminTarget(path))`（`/app/nodes` → `/admin/nodes`，所以登录前打开的视图保留）；后台：会话结束 → `loadPage(loginTarget(path))`（`/admin/nodes` → `/app/nodes`），非管理员 → `/app`，登出 → `/app`。**`/{prefix}/app/`、`/{prefix}/admin/`（带尾斜杠）不是路由**（面板返回拒绝 404），导航一律用 `appBase`/`adminBase` 或 `base + "/<view>"`。
- `src/lib/errors.ts` — `errorText(err, t)`：把 `ApiError`/网络错误转成本地化的用户可读文本（401/403/429/5xx、几条已知服务端消息；其余 = "操作失败：<原文>"）。后台用 `adminErrorText(err, context?)`：先查后台专用消息 `ADMIN_KNOWN`（中文直写，不进共享词典），带 `context` 时为"<context>：<详情>"（不会出现"…失败：操作失败：…"的双前缀）。
- `src/lib/qr.ts` + `src/components/qr-code.tsx` — 本地 QR 编码器（字节模式、1–40 版、M 级纠错、自动选掩码）渲染为内联 SVG：2FA 的 otpauth URI 与支付二维码都不出浏览器、无 CDN、符合 CSP。测试用独立解码器 jsQR（仅 devDependency）往返验证。
- `src/lib/utils.ts` — `humanBytes`（二进制单位 KiB/MiB/GiB，与输入框的 GiB 一致）、`downloadText`（Blob URL，CSP 安全）、`copyText`。
- `src/components/status.tsx` — `Loading`（role=status）、`ErrorText`（role=alert）、`TableNote`（表格空态/加载行）。
- `src/pages/` — `login`（i18n、语言切换、可选验证码字段；所有凭据失败统一显示"账号、密码或验证码错误"）、`portal`（i18n；`PlanCard`/`PasswordCard`/订阅链接，管理员账户页复用后两者）、`two-factor`（i18n；`TotpEnroll` = 二维码 + base32 + 确认，`RecoveryCodes` = 复制/下载 .txt，`EnrollPage` 仅 `auth.require_admin_2fa` 时出现，`TwoFactorCard`）、`admin-users`（分页 50/页；每行"管理"展开：编辑角色/启用/上限/到期（套餐管理的字段锁定）、套餐分配/更换/取消（说明"沿用上一个套餐的上限"）、节点权限只读表、吊销会话/重置两步验证/重新生成订阅令牌/删除，全部二次确认）、`admin-plans`、`audit`、`admin-updates`（M6）、`admin-nodes`（R18-2，中文：节点列表（状态/地区/地址/Agent/租约剩余/证书/心跳/警告）、`NodeWizard` 新建向导（协议模板行 `TemplateRows` + 「检测目标站点」+ 高级 JSON）→ `InstallCard`（一行安装命令 + 复制、倒计时、pin 说明、警告、手动 bootstrap）；「重装命令」/「bootstrap」/停用（确认）/删除（确认）；`NodeEditor` 以 `key={node.id}` 挂载（F1），基础信息与入站各自的错误提示（F4），入站表 + 从模板添加（`/inbound-templates/render`）+ 高级 JSON；测试 `admin-nodes.test.tsx`）。
- M6：`admin-updates`（Updates 视图：发布上传 = manifest + sig + 二进制三文件，`putBinary` 原始 body；rollout 创建（版本、百分比、waves、超时、失败比、可选节点子集）、列表 5s 刷新、展开看每节点状态、pause/resume/abort 只在合法状态显示）；`admin-nodes` 的 Agent 列显示平台与最近一次 rollout 状态。测试 `src/pages/m6.test.tsx`。
- R18-3 支付：`purchase.tsx`（`Billing` = 商店 + `PaymentPanel`（二维码、3s 轮询、取消）+ `orders.tsx` 我的订单；用户页中英双语，文案在 i18n 词典的 `billing` 命名空间，服务端错误走 `errorText`（支付相关已知消息在 `errors` 命名空间））、`admin-orders.tsx`（后台仅中文：套餐定价（元↔分整数换算 `lib/billing.ts` `yuan`/`parseYuan`）、订单筛选/翻页、详情 + 支付事件、人工确认/重试开通需原因）；支付二维码 `components/pay-qr.tsx` 复用本地编码器（`QrCode`/`lib/qr.ts`，无第三方依赖）；类型与 `STATUS_KEY` 在 `lib/billing.ts`。测试 `pages/billing.test.tsx`。
- W11：`admin-node-form`（`NodeOpsFields` 显示名称/标签/倍率/排序/对用户显示/节点组，新建向导只发与默认不同的字段 `changedFromDefaults`；`NodeOpsCard`「展示与计费」+ 每入站连接地址/连接端口，一次 PATCH）、`admin-node-status`（列表实时列 `NodeLiveHeads`/`NodeLiveCells`：CPU/内存、↑↓ 速率、在线用户、延迟徽章；`NodeDetail` 节点详情 = `/admin/nodes/<id>` 深链：机器状态、延迟表 + 「立即测速」（429 提示）、历史曲线 1h–90d）；节点列表 5s 刷新；`components/latency-badge.tsx`（Clash Verge 阈值 <200 绿 / <500 黄 / 其余红 / 超时灰，门户与后台共用，文案在 i18n `latency` 命名空间）；`components/line-chart.tsx`（自绘 SVG 折线图，无依赖、CSP 安全，仅后台使用）；门户 `portal-nodes.tsx`（`NodesCard`，`/me/nodes`，i18n `nodes` 命名空间，到期/超流量用户不显示）。测试 `pages/node-ops.test.tsx`、e2e「W11 nodes」。
- W10：`admin-node-cert.tsx`（中文）：`TlsDomainField`（「节点域名」输入 + 「检查解析」→ `/inbound-templates/check-domain`，只警告：无记录/CF 橙云/「域名未解析到本机 IP x」）、`NodeCertStatus`（节点页：读 `heartbeat.cert`，有效/申请中/失败按 `error_kind` 给出可操作的中文说明，DNS/连接类失败时自动做一次解析比对，agent < 6 或无 TLS 入站另有说明）；`admin-nodes.tsx` 只做挂接：向导与编辑页的节点域名字段（PATCH `tls_domain`，改动前确认会重建）、`toSpecs(rows, nodeDomain)`（有节点域名时 TLS 行可不填域名，transport/vmess_ws 发 `tls: true`）、渲染请求带 `tls_domain`。测试 `admin-node-cert.test.tsx`。
- R22：`admin-settings`（系统设置，中文：主域名/订阅域名/节点通信域名 + DNS 检测、信任 Cloudflare 三态、改节点域名前确认影响、节点域名解析到 CF 时需勾选强制、当前访问地址会被 Host 闸门拒绝时需确认；「节点通信证书域名」表 + 移除确认列出仍在用的节点；类型就在该文件里，镜像 `src/settings.rs`）；测试 `admin-settings.test.tsx`。订阅链接优先用 API 返回的 `sub_url`（订阅域名），没有才用 `subscriptionUrl`（当前 origin）。
- 到期/超流量用户（R21）：`Me.expired` 或 `Me.quota_exhausted` 为真时门户显示续费提示，隐藏订阅链接与 2FA 卡片（这些端点拒绝过期会话）；购买/订单页面对其可用。
- 会话阶段：`/me` 401 时探测 `/me/totp`，`stage === "enroll"`（仅 `require_admin_2fa` 下无 2FA 的管理员）：门户跳到后台，后台只显示 `EnrollPage`（面板对 enroll 会话也下发后台）；管理员无 2FA 时后台顶部显示可关闭的"建议开启两步验证"横幅（关闭状态存 localStorage，按用户 id）。秘密与恢复码只在生成那次响应里出现，界面不缓存它们。

## i18n（R18）

- 前台（登录、用户门户、购买等面向用户的页面）中英双语；**管理后台只做中文**（直接写中文，`admin-app.tsx` 用 `<FixedLocale locale="zh">` 包住整个后台，共享卡片如 2FA/改密码随之显示中文）。
- API：`import { useT, useLocale, setLocale, LocaleSwitch, FixedLocale } from "../i18n"`；`const t = useT(); t("login.title"); t("portal.expires", { date })`。语言 = localStorage `akari.locale`（读写都 try/catch）→ 否则浏览器语言（zh* → zh，其余 en）。每个界面挂 `useHtmlLang(locale)` 同步 `<html lang>`（zh-CN / en）。
- 字典：`src/i18n/zh.ts` 是键的正本，`src/i18n/en.ts` 类型为 `Messages`（= zh 的形状），**缺键/多键都是编译错误**；`i18n.test.tsx` 另断言两边键与 `{占位符}` 一致。
- **新增功能的约定（W3 购买页等照此执行）**：在 `zh.ts` 与 `en.ts` 各加一个**顶层命名空间**（如 `purchase: { title: "...", ... }`），键用 camelCase，插值写 `{name}`；页面里用 `t("purchase.title")`。不要在运行时按需导入或注册字典，不要在组件里写面向用户的硬编码文案（管理后台除外）。服务端错误用 `errorText(err, t)`；需要新的已知错误映射时加到 `errors` 命名空间与 `lib/errors.ts` 的 `KNOWN`。日期用 `toLocaleDateString(locale === "zh" ? "zh-CN" : "en")`。

## 规则

- REST 请求走 `lib/api.ts` 的 `get/post/put/patch/del`，它们固定拼 `apiBase`（= `/{prefix}/api/v1`）。
  **后端 `/auth/*` 不在 `/api/v1` 下**：登录/登出只能用 `login()`/`logout()`（拼 `authBase` = `/{prefix}/auth`，由 `prefixBase`（路径第一段）推导）。
  守卫：`scripts/check-auth-paths.mjs`（`make check` 与 smoke 都会跑）+ smoke 对打包 JS 的 grep。登出失败必须可见；成功后 `lib/session.ts` 的 `resetAfterLogout()`（`clear()` 不通知观察者，界面会停在仪表盘）。Node >= 22.18。
- Vite 产出的资源：门户以 `/assets/`、后台以 `/admin/assets/` 开头（`vite.config.ts` 的 `base`；spa.rs 靠这个做前缀改写）；不要改 `base`，不要引入动态 `import()`（预加载路径不经改写）。
- CSP 为 `default-src 'self'; style-src 'self' 'unsafe-inline'`：禁止内联脚本和外部 CDN（二维码、下载都在本地生成）。
- 可访问性：错误用 `role="alert"`（`ErrorText`），成功提示 `role="status"`；焦点环用 `--ring`/`ring-ring`；表单控件必须有 label；标题层级 h1（页面）/h2（卡片）。375px 宽度下 header 换行、导航横向滚动。
- 代码质量：ESLint（typescript-eslint + react-hooks + jsx-a11y，`eslint.config.js`）+ Prettier（printWidth 120），`npm run lint` 在 `make check` 与 CI spa job 中运行；`npm run format` 自动格式化。后台页面的服务端错误用 `lib/errors.ts` 的 `adminErrorText`（中文）。
- 单元测试：vitest 5 + @testing-library/react（jsdom），`src/**/*.test.{ts,tsx}`；`src/test/harness.tsx` 提供按 "METHOD /path" 应答的假 fetch（记录 `search`）、`renderWithClient`、`renderAdmin`（中文固定）。壳层测试：`app.test.tsx`（门户：管理员/enroll 会话跳后台）、`admin-app.test.tsx`（后台：视图、横幅、enroll、会话结束/非管理员/登出跳回门户）。测试文件不被应用导入，不进包。
- 端到端（A17）：`e2e/*.spec.ts`（Playwright，Chromium），由 `../scripts/e2e.sh`（`make e2e`）对真实 release 面板运行：独立库 `akari_e2e`、Valkey 索引 15、数据目录 `/tmp/akari-e2e`、端口 8090；主机名优先 `myapp.test`（本机映射到 127.0.0.1，Windows 浏览器可打开同一 URL），否则 127.0.0.1。断言：真实 CSP 头、无 CSP 违规/页面异常、语言切换与 `<html lang>`、密码登录与 2FA（二维码绑定 → 仅密码被拒 → TOTP 登录）、后台样式生效（计算样式）、深链与后退；R23：用户登录后网络日志里没有任何 `/admin` 请求、用户会话与无会话访问 `/admin*` 与未知路径字节同构（状态、头、body）、管理员在 `/app` 登录后落到 `/admin/<视图>`、登出回 `/app`。CI 作业 `e2e` 暂为非必需。本机（Arch/WSL）缺 `libgbm` 时把 mesa 的 `libgbm.so.1`/`libdrm.so.2`/`libwayland-server.so.0` 放进一个目录并以 `LD_LIBRARY_PATH` 运行。
- 前端形态：~~M3 定案维持单 SPA~~ **更正（R23）**：门户与后台拆为两个独立打包（见顶部与 PLAN.md 决策表）。
- 验收：`make check`（tsc + lint + auth paths + vitest）+ `npm run build`（含 `check-bundles.mjs`）+ `make e2e`。
