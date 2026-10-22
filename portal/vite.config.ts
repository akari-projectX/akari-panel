/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

/*
 * 用户门户（Svelte 5）的构建。产物 dist/app 由面板内嵌（src/spa.rs 的 UserAssets），在主域名 / 下发。
 *
 *   · 面板的 CSP 是 default-src 'self'; style-src 'self' 'unsafe-inline'：index.html 里不能有内联脚本、
 *     内联事件，图片 / 字体只能来自本站（data: 也不行）。scripts/check-dist.mjs 检查产物。
 *   · `@/…` 是与框架无关的模块（src/shared：接口层、词典、错误码文案、格式化、缓存、字体；
 *     从 React 门户搬来，React 门户已删除）。`$lib/…` 是界面这一层的代码。
 *
 * npm run dev：页面由 Vite 提供，接口转发到 PANEL_URL（一个本地运行的面板）。
 */

const PANEL_URL = process.env.PANEL_URL ?? 'http://127.0.0.1:18480';
const SHARED = path.resolve(import.meta.dirname, 'src/shared');

/*
 * src/boot/boot.js（首帧前定明暗 + 启动守护）以经典脚本形式插进 <head>，输出为 assets/boot-<内容哈希>.js：
 * 面板对 /assets/ 下的文件按不可变缓存，不带哈希的文件改了到不了用户那里。它不能进应用包：应用包下载失败时正是它在兜底。
 */
function bootScript(): Plugin {
  const file = path.resolve(import.meta.dirname, 'src/boot/boot.js');
  const read = () => readFileSync(file, 'utf8');
  const fileName = () => `assets/boot-${createHash('sha256').update(read()).digest('hex').slice(0, 8)}.js`;
  return {
    name: 'akari-boot-script',
    transformIndexHtml: {
      order: 'post',
      handler: (_html, ctx) => [
        { tag: 'script', attrs: { src: ctx.server ? '/src/boot/boot.js' : `/${fileName()}` }, injectTo: 'head-prepend' },
      ],
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: fileName(), source: read() });
    },
  };
}

export default defineConfig({
  base: '/',
  /* public/assets/licenses/：字体许可证，原样复制 */
  publicDir: path.resolve(import.meta.dirname, 'public'),
  plugins: [svelte(), tailwindcss(), bootScript()],
  resolve: {
    alias: {
      $lib: path.resolve(import.meta.dirname, 'src/lib'),
      '@': SHARED,
    },
  },
  server: {
    host: true,
    port: 5174,
    proxy: { '^/(api|auth|brand)/': { target: PANEL_URL, changeOrigin: false } },
  },
  build: {
    /* 常青浏览器，不做语法降级 */
    target: 'es2023',
    cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.4'],
    outDir: 'dist/app',
    assetsDir: 'assets',
    emptyOutDir: true,
    /* scripts/bundle-report.mjs 按清单算首屏 JS */
    manifest: true,
    sourcemap: false,
    /* 不内联成 data: 地址：CSP 的 default-src 'self' 不允许 */
    assetsInlineLimit: 0,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
