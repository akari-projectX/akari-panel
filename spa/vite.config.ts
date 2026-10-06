import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

/*
 * 用户门户的构建。产物（dist/app）由 Akari 面板内嵌（rust-embed）下发：门户在主域名根路径 `/`（D11），
 * index.html 对路由表里的每个路径返回，资源在 /assets/*（带内容哈希，面板按不可变缓存下发）。
 *
 *   · 面板的 CSP 是 default-src 'self'; style-src 'self' 'unsafe-inline'（开了 Turnstile 时门户页另放行它的来源）：
 *     index.html 里不能有内联脚本、内联事件，图片/字体只能来自本站（data: 也不行）。scripts/check-dist.mjs 检查产物。
 *   · 门户里没有任何后台代码或后台地址（后台是另一个应用，在秘密前缀下）。
 *
 * npm run dev：页面由 Vite 提供，接口转发到 PANEL_URL（一个本地运行的面板）。
 * 浏览器眼里是同源，面板的 SameSite=Strict 会话 cookie 照常工作。
 */

const PANEL_URL = process.env.PANEL_URL ?? 'http://127.0.0.1:18480';

/*
 * src/boot/boot.js（首帧前定明暗 + 启动守护，说明见该文件）以经典脚本形式插进 <head>。
 * 构建时原样输出为 assets/boot-<内容哈希>.js：面板对 /assets/ 下的文件按不可变缓存，
 * 不带哈希的文件改了也到不了用户那里。它不能进应用包：应用包下载失败时正是它在兜底。
 */
function bootScript(): Plugin {
  const file = path.resolve(import.meta.dirname, "src/boot/boot.js")
  const read = () => readFileSync(file, "utf8")
  const fileName = () => `assets/boot-${createHash("sha256").update(read()).digest("hex").slice(0, 8)}.js`
  return {
    name: "akari-boot-script",
    transformIndexHtml: {
      order: "post",
      handler: (_html, ctx) => [
        { tag: "script", attrs: { src: ctx.server ? "/src/boot/boot.js" : `/${fileName()}` }, injectTo: "head-prepend" },
      ],
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: fileName(), source: read() })
    },
  }
}

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), bootScript()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    host: true,
    port: 5173,
    /* 接口、品牌图片转发给面板 */
    proxy: { '^/(api|auth|brand)/': { target: PANEL_URL, changeOrigin: false } },
  },
  build: {
    /* 只支持常青浏览器（近两年的 Chrome / Edge / Firefox / Safari），不做语法降级 */
    target: "es2023",
    cssTarget: ["chrome111", "edge111", "firefox114", "safari16.4"],
    outDir: "dist/app",
    assetsDir: "assets",
    emptyOutDir: true,
    /* 体积预算脚本（scripts/bundle-budget.mjs）按清单算首屏 JS */
    manifest: true,
    sourcemap: false,
    /* 不把小图片内联成 data: 地址：CSP 的 default-src 'self' 不允许 data: 图片 */
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        /*
         * 第三方库按用途拆成稳定的包：主题更新时只有我们自己的代码变，
         * 这两个包的文件名（内容哈希）不变，浏览器缓存照样能用。
         */
        codeSplitting: {
          groups: [
            /*
             * React + 路由，以及入口和图表库都会用到的小库（clsx、react-is 等）。
             * 不先在这里认领，下面的 vendor-chart 会把它们一起吸走，入口就得为了一个小库加载整个图表库。
             * ^\0@oxc-project+runtime：转译器注入的辅助函数，同理。
             */
            { name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|react-is|clsx|use-sync-external-store)[\\/]|^\0@oxc-project\+runtime/, priority: 20 },
            /* 图表库（recharts 及其依赖）只有仪表盘和使用明细用到，单独成包、按需加载 */
            { name: "vendor-chart", test: /node_modules[\\/](recharts|d3-[\w-]+|victory-vendor|es-toolkit|eventemitter3|@reduxjs|redux|redux-thunk|react-redux|immer|reselect|decimal\.js-light|internmap)[\\/]/, priority: 5 },
          ],
        },
      },
    },
  },
})
