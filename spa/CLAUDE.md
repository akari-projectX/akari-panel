# akari-panel/spa — 前端

React 19 + Vite 8 (Rolldown) + Tailwind 4 + TanStack Query 5；shadcn 风格组件为手拷代码（`src/components/ui/`）。
构建产物 `dist/` 被 rust-embed 编进二进制，只在 `/{prefix}/app` 下提供。改完前端必须 `make spa && make panel` 才生效。

## 结构

- `src/lib/api.ts` — fetch 封装与 API 类型（手工镜像 `src/api.rs` 的 View 结构，改后端字段要同步）。`appBase`/`apiBase` 从 `location` 推导，**不内嵌前缀**。
- `src/lib/router.ts` — 极简 history 路由（`usePath`/`navigate`），无路由依赖。管理后台视图即 URL：`/{prefix}/app/{users|plans|nodes|updates|audit|account}`（`app.tsx` 的 `VIEWS`/`viewOf`；深链与后退可用）。**`/{prefix}/app/`（带尾斜杠）不是路由**（面板返回拒绝 404），导航一律用 `appBase` 或 `appBase + "/<view>"`。
- `src/lib/errors.ts` — `errorText(err, t)`：把 `ApiError`/网络错误转成本地化的用户可读文本（401/403/429/5xx、几条已知服务端消息；其余 = "操作失败：<原文>"）。
- `src/lib/qr.ts` + `src/components/qr-code.tsx` — 本地 QR 编码器（字节模式、1–40 版、M 级纠错、自动选掩码）渲染为内联 SVG：2FA 的 otpauth URI 不出浏览器、无 CDN、符合 CSP。测试用独立解码器 jsQR（仅 devDependency）往返验证。
- `src/lib/utils.ts` — `humanBytes`（二进制单位 KiB/MiB/GiB，与输入框的 GiB 一致）、`downloadText`（Blob URL，CSP 安全）、`copyText`。
- `src/components/status.tsx` — `Loading`（role=status）、`ErrorText`（role=alert）、`TableNote`（表格空态/加载行）。
- `src/pages/` — `login`（i18n、语言切换、可选验证码字段；所有凭据失败统一显示"账号、密码或验证码错误"）、`portal`（i18n；`PlanCard`/`PasswordCard`/订阅链接，管理员账户页复用后两者）、`two-factor`（i18n；`TotpEnroll` = 二维码 + base32 + 确认，`RecoveryCodes` = 复制/下载 .txt，`EnrollPage` 仅 `auth.require_admin_2fa` 时出现，`TwoFactorCard`）、`admin-users`（分页 50/页；每行"管理"展开：编辑角色/启用/上限/到期（套餐管理的字段锁定）、套餐分配/更换/取消（说明"沿用上一个套餐的上限"）、节点权限只读表、吊销会话/重置两步验证/重新生成订阅令牌/删除，全部二次确认）、`admin-plans`、`audit`、`admin-updates`（M6）、`admin-nodes`（R18-2，中文：节点列表（状态/地区/地址/Agent/租约剩余/证书/心跳/警告）、`NodeWizard` 新建向导（协议模板行 `TemplateRows` + 「检测目标站点」+ 高级 JSON）→ `InstallCard`（一行安装命令 + 复制、倒计时、pin 说明、警告、手动 bootstrap）；「重装命令」/「bootstrap」/停用（确认）/删除（确认）；`NodeEditor` 以 `key={node.id}` 挂载（F1），基础信息与入站各自的错误提示（F4），入站表 + 从模板添加（`/inbound-templates/render`）+ 高级 JSON；测试 `admin-nodes.test.tsx`）。
- M6：`admin-updates`（Updates 视图：发布上传 = manifest + sig + 二进制三文件，`putBinary` 原始 body；rollout 创建（版本、百分比、waves、超时、失败比、可选节点子集）、列表 5s 刷新、展开看每节点状态、pause/resume/abort 只在合法状态显示）；`admin-nodes` 的 Agent 列显示平台与最近一次 rollout 状态。测试 `src/pages/m6.test.tsx`。
- R18-3 支付：`purchase.tsx`（`Billing` = 商店 + `PaymentPanel`（二维码、3s 轮询、取消）+ `orders.tsx` 我的订单；用户页中英双语，文案暂在 `pages/billing-i18n.ts`（`billing.zh/en` + `useBillingT` 垫片，合并 W2 i18n 时迁入其词典并换成 `useT`））、`admin-orders.tsx`（后台仅中文：套餐定价（元↔分整数换算 `lib/billing.ts` `yuan`/`parseYuan`）、订单筛选/翻页、详情 + 支付事件、人工确认/重试开通需原因）；二维码只在 `components/pay-qr.tsx` 生成（依赖 `uqr`，零依赖 MIT，本地渲染 SVG，无 CDN）；类型在 `lib/billing.ts`。测试 `pages/billing.test.tsx`。
- 到期用户（R21）：`Me.expired` 为真时门户显示续费提示，隐藏订阅链接与 2FA 卡片（这些端点拒绝过期会话）；购买/订单页面对其可用。
- 会话阶段：`/me` 401 时探测 `/me/totp`，`stage === "enroll"`（仅 `require_admin_2fa` 下无 2FA 的管理员）只显示 `EnrollPage`；管理员无 2FA 时后台顶部显示可关闭的"建议开启两步验证"横幅（关闭状态存 localStorage，按用户 id）。秘密与恢复码只在生成那次响应里出现，界面不缓存它们。

## i18n（R18）

- 前台（登录、用户门户、购买等面向用户的页面）中英双语；**管理后台只做中文**（直接写中文，`app.tsx` 用 `<FixedLocale locale="zh">` 包住后台，共享卡片如 2FA/改密码随之显示中文）。
- API：`import { useT, useLocale, setLocale, LocaleSwitch, FixedLocale } from "../i18n"`；`const t = useT(); t("login.title"); t("portal.expires", { date })`。语言 = localStorage `akari.locale`（读写都 try/catch）→ 否则浏览器语言（zh* → zh，其余 en）。每个界面挂 `useHtmlLang(locale)` 同步 `<html lang>`（zh-CN / en）。
- 字典：`src/i18n/zh.ts` 是键的正本，`src/i18n/en.ts` 类型为 `Messages`（= zh 的形状），**缺键/多键都是编译错误**；`i18n.test.tsx` 另断言两边键与 `{占位符}` 一致。
- **新增功能的约定（W3 购买页等照此执行）**：在 `zh.ts` 与 `en.ts` 各加一个**顶层命名空间**（如 `purchase: { title: "...", ... }`），键用 camelCase，插值写 `{name}`；页面里用 `t("purchase.title")`。不要在运行时按需导入或注册字典，不要在组件里写面向用户的硬编码文案（管理后台除外）。服务端错误用 `errorText(err, t)`；需要新的已知错误映射时加到 `errors` 命名空间与 `lib/errors.ts` 的 `KNOWN`。日期用 `toLocaleDateString(locale === "zh" ? "zh-CN" : "en")`。

## 规则

- REST 请求走 `lib/api.ts` 的 `get/post/put/patch/del`，它们固定拼 `apiBase`（= `/{prefix}/api/v1`）。
  **后端 `/auth/*` 不在 `/api/v1` 下**：登录/登出只能用 `login()`/`logout()`（拼 `authBase` = `/{prefix}/auth`，由 `appBase` 推导）。
  守卫：`scripts/check-auth-paths.mjs`（`make check` 与 smoke 都会跑）+ smoke 对打包 JS 的 grep。登出失败必须可见；成功后 `lib/session.ts` 的 `resetAfterLogout()`（`clear()` 不通知观察者，界面会停在仪表盘）。Node >= 22.18。
- Vite 产出的资源必须以 `/assets/` 开头（spa.rs 靠这个做前缀改写）；不要改 `base`。
- CSP 为 `default-src 'self'; style-src 'self' 'unsafe-inline'`：禁止内联脚本和外部 CDN（二维码、下载都在本地生成）。
- 可访问性：错误用 `role="alert"`（`ErrorText`），成功提示 `role="status"`；焦点环用 `--ring`/`ring-ring`；表单控件必须有 label；标题层级 h1（页面）/h2（卡片）。375px 宽度下 header 换行、导航横向滚动。
- 代码质量：ESLint（typescript-eslint + react-hooks + jsx-a11y，`eslint.config.js`）+ Prettier（printWidth 120），`npm run lint` 在 `make check` 与 CI spa job 中运行；`npm run format` 自动格式化。`admin-nodes.tsx` 暂在 `.prettierignore`（W1 并行改写中，合并后移除并格式化）。
- 单元测试：vitest 5 + @testing-library/react（jsdom），`src/**/*.test.{ts,tsx}`；`src/test/harness.tsx` 提供按 "METHOD /path" 应答的假 fetch（记录 `search`）、`renderWithClient`、`renderAdmin`（中文固定）。测试文件不被应用导入，不进包。
- 端到端（A17）：`e2e/*.spec.ts`（Playwright，Chromium），由 `../scripts/e2e.sh`（`make e2e`）对真实 release 面板运行：独立库 `akari_e2e`、Valkey 索引 15、数据目录 `/tmp/akari-e2e`、端口 8090；主机名优先 `myapp.test`（本机映射到 127.0.0.1，Windows 浏览器可打开同一 URL），否则 127.0.0.1。断言：真实 CSP 头、无 CSP 违规/页面异常、语言切换与 `<html lang>`、密码登录与 2FA（二维码绑定 → 仅密码被拒 → TOTP 登录）、后台样式生效（计算样式）、深链与后退。CI 作业 `e2e` 暂为非必需。本机（Arch/WSL）缺 `libgbm` 时把 mesa 的 `libgbm.so.1`/`libdrm.so.2`/`libwayland-server.so.0` 放进一个目录并以 `LD_LIBRARY_PATH` 运行。
- 前端形态（PLAN 决策点，M3 定案）：维持**单 SPA、按角色视图**（理由见 PLAN.md 决策表）。
- 验收：`make check`（tsc + lint + auth paths + vitest）+ `make e2e`。
