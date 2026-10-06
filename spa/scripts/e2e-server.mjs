#!/usr/bin/env node
/*
 * 本地端到端测试用的门户服务器：把构建好的门户（dist/）和一个真实运行的面板拼到同一个源上。
 *
 *   PANEL_URL=http://127.0.0.1:18480 PANEL_PREFIX=abcd… PORT=18490 node scripts/e2e-server.mjs
 *
 * 面板 main（③ 之前）把门户放在 /{prefix}/app 下，并改写 index.html 里的 /assets/ 地址；
 * 这里做同样的事，好让 VITE_PORTAL_MODE=prefixed 的构建跑在真实面板的接口上：
 *   · /{prefix}/app、/{prefix}/app/*  → dist/index.html（/assets/ 改写成 /{prefix}/assets/）
 *   · /{prefix}/assets/*              → dist/assets/*
 *   · 其余请求原样转发给面板（接口、认证、订阅……），响应头（含 Set-Cookie、CSP）原样带回
 * 门户页面带上与面板一致的安全头（CSP default-src 'self' 等），产物违反 CSP 的话浏览器会当场报错。
 * 只给开发机和 CI 跑测试用，不是部署方式。
 */
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PANEL = process.env.PANEL_URL ?? 'http://127.0.0.1:18480';
const PREFIX = process.env.PANEL_PREFIX;
const PORT = Number(process.env.PORT ?? 18490);
const DIST = join(import.meta.dirname, '..', 'dist');
if (!PREFIX) throw new Error('PANEL_PREFIX is required');

const TYPES = {
  '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8',
};
const SECURITY = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

async function portal(res, path) {
  if (path.startsWith(`/${PREFIX}/assets/`)) {
    const file = normalize(join(DIST, 'assets', path.slice(`/${PREFIX}/assets/`.length)));
    if (!file.startsWith(join(DIST, 'assets'))) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...SECURITY }).end(body);
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  const html = (await readFile(join(DIST, 'index.html'), 'utf8'))
    .replaceAll('href="/assets/', `href="/${PREFIX}/assets/`)
    .replaceAll('src="/assets/', `src="/${PREFIX}/assets/`);
  res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', ...SECURITY }).end(html);
}

/* 原样转发，Host 也照传：面板设了主域名后只认它（host gate） */
function proxy(req, res) {
  return new Promise((resolve, reject) => {
    const up = request(new URL(req.url, PANEL), { method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res).on('finish', resolve);
    });
    up.on('error', reject);
    req.pipe(up);
  });
}

createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const app = path === `/${PREFIX}/app` || path.startsWith(`/${PREFIX}/app/`) || path.startsWith(`/${PREFIX}/assets/`);
  (app ? portal(res, path) : proxy(req, res)).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
}).listen(PORT, '127.0.0.1', () => console.log(`portal e2e server on http://localhost:${PORT}/${PREFIX}/app → ${PANEL}`));
