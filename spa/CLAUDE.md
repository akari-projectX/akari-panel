# akari-panel/spa — 前端

React 19 + Vite 8 (Rolldown) + Tailwind 4 + TanStack Query 5；shadcn 风格组件为手拷代码（`src/components/ui/`）。
构建产物 `dist/` 被 rust-embed 编进二进制，只在 `/{prefix}/app` 下提供。改完前端必须 `make spa && make panel` 才生效。

## 结构

- `src/lib/api.ts` — fetch 封装与 API 类型（手工镜像 `src/api.rs` 的 View 结构，改后端字段要同步）。`appBase`/`apiBase` 从 `location` 推导，**不内嵌前缀**。
- `src/lib/router.ts` — 极简 history 路由，无路由依赖。
- `src/pages/` — `login`、`admin-users`、`admin-nodes`、`portal`（单 SPA 双角色视图）。
- `src/components/ui/` — button/input/card/table/badge/label。

## 规则

- REST 请求走 `lib/api.ts` 的 `get/post/put/patch/del`，它们固定拼 `apiBase`（= `/{prefix}/api/v1`）。
  **后端 `/auth/*` 不在 `/api/v1` 下**：登录/登出只能用 `login()`/`logout()`（拼 `authBase` = `/{prefix}/auth`，由 `appBase` 推导）。
  守卫：`scripts/check-auth-paths.mjs`（`make check` 与 smoke 都会跑）+ smoke 对打包 JS 的 grep。登出失败必须可见；成功后 `lib/session.ts` 的 `resetAfterLogout()`（`clear()` 不通知观察者，界面会停在仪表盘）。Node >= 22.18。
- Vite 产出的资源必须以 `/assets/` 开头（spa.rs 靠这个做前缀改写）；不要改 `base`。
- CSP 为 `default-src 'self'; style-src 'unsafe-inline'`：禁止内联脚本和外部 CDN。
- 验收：`npx tsc --noEmit`；UI 从未在真实浏览器中验证过，改动后需要人工打开 `/{prefix}/app` 检查。
