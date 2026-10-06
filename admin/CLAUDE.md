# admin/ — 管理后台（W33-b）

独立的 Vite 8 + React 19 + TypeScript + Tailwind 4 应用，与门户 `spa/` **不共享任何代码、路由或产物**。功能清单（验收基准）是 `INVENTORY.md`：每一行都有 Playwright 用例（测试标题里写清单编号）。

## 两个包

| 包 | 入口 | 产物 | 服务（`src/console.rs`） |
|---|---|---|---|
| 登录页 | `login.html` → `src/login/` | `dist/login` | `/{prefix}/app`（公开，只在后台前缀下；`no-store`）、`/{prefix}/app/assets/*`（immutable） |
| 控制台 | `index.html` → `src/console/` | `dist/console` | `/{prefix}/admin`、`/{prefix}/admin/*`、`/{prefix}/admin/assets/*`（只对管理员会话，`private, no-store`；其他一律规范拒绝） |

- `vite.config.ts`：`ADMIN_ENTRY=login|console` 各构建一次；`base` 分别为 `/app/`、`/admin/`（面板运行时把 `"/app/assets/`、`"/admin/assets/` 改写到前缀下，**不要改 base**）；单 chunk、`modulePreload: false`、`cssCodeSplit: false`；**禁止动态 `import()`**（`check-bundles.mjs` 会失败）。
- `loginGuard`：登录页的依赖图里不得出现 `src/console/`。登录页只带自己的小错误表（`src/login/app.tsx` 的 `LOGIN_ERRORS`，`check-error-codes.mjs` 校验其中的码都已登记）。
- `scripts/check-bundles.mjs`（`npm run build` 末尾，smoke 对实际下发的文件再跑一次）：控制台标记必须出现在控制台包、不得出现在登录页包与门户包；门户标记不得出现在后台包；无 `__vitePreload`、无绝对资源路径、无动态导入。
- CSP 一律 `default-src 'self'; style-src 'self' 'unsafe-inline'`：不得有内联脚本。Turnstile 只在登录页、只在开启时由面板放宽 CSP。

## 目录

- `src/shared/`：两个包共用（i18n、API 客户端、错误映射、格式化、主题、通行密钥、UI 组件）。**不得**引用 `src/console/` 或 `src/login/`。
  - `api.ts`：`request`/`get`/`post`/…；204 返回 `null`（`useRun` 把 `undefined` 当失败）；401 交给 `setUnauthorizedHandler`（控制台：整页跳到登录页并带 `?next=`）。
  - `errors.gen.ts`：由 `src/error_codes.txt` 生成的中英错误表（`errorText`）；新错误码必须在这里有中英两份（`check-error-codes.mjs`：与登记表一致、两种语言非空、英文里没有中文）。
  - `i18n.tsx`：内联 `tr("中文", "English")`；语言存 `akari.admin.lang`。
  - `format.ts`：时间一律按**站点时区**（`/settings` 的 `timezone`）显示，不用浏览器时区。
  - `ui/`：`DataTable`（筛选、勾选批量、列选择、手机卡片）、`Drawer`/`Dialog`、`useConfirm`（破坏性操作 = 影响数量 + 输入确认文字）、`useToast`、骨架/空/错误状态。
- `src/login/`：邮箱 + 密码、通行密钥（可发现凭据）、仅通行密钥提示（含 `akari admin reset-login`）、密码登录后的绑定引导、蜜罐 + 最短提交时间 + Turnstile；非管理员账户登录后立即登出并提示。
- `src/console/`：`router.ts`（history 路由，URL 即视图，查询串即筛选）、`nav.ts`（侧边栏）、`shell.tsx`（可折叠侧边栏、手机抽屉、Ctrl+K 命令面板、账户菜单）、`kit.tsx`（`useRun`：执行 + 等待失效查询重读 + 提示）、`pages/*`（每个导航项一个页面；`protocols.gen.ts` 由 `make gen-protocols` 从 `proto/protocols.toml` 生成）。

## 命令

```bash
npm ci
npm run check     # tsc + eslint + prettier + 错误码表 + vitest
npm run build     # 两个包 + check-bundles
make admin        # 仓库根：同上
```

e2e：`scripts/e2e.sh`（`make e2e`；`E2E_SUITE=admin` 只跑本套件）起一个独立的面板 + Mailpit + 本地发布源，Playwright 两个项目 desktop（Desktop Chrome）与 mobile（Pixel 7），中文界面、串行。`e2e/helpers.ts`：`openConsole`（复用缓存的管理员会话）、`signIn`、`sql`（docker compose psql 造数据）、`row`/`dialog`/`toast`/`confirmDialog`。每个 spec 都要能在同一库里先后跑 desktop 与 mobile（名字用 `uniq(info, …)`，改全局设置的用例结束时恢复原样）。`zz-passkeys.spec.ts` 最后跑：把主域名设为 `e2e.localhost:<端口>`（Chromium 把 `*.localhost` 解析到本机且视为安全上下文；面板对 `localhost`/`*.localhost` 主域名同时接受其 http 源，`passkey::Rp::localhost_http`），用 CDP 虚拟认证器，结束后恢复。

## 约定

- 新功能先进 `INVENTORY.md`（编号），再实现，再写 e2e（标题带编号）；桌面与手机都要可用。
- 运营者可见文案中英双语；错误一律经 `errorText` 映射（不显示原始英文消息）。
- 破坏性操作：确认框写明影响数量，删除类要求输入名称/确认文字。
