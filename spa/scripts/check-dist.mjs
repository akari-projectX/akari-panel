#!/usr/bin/env node
/*
 * 构建产物检查（CI 必跑）：产物能在面板的 CSP 下工作，面板也下发得到。
 *
 * 面板在主域名根路径下发门户（D11）：
 *   · CSP = default-src 'self'; style-src 'self' 'unsafe-inline'
 *     （站长开了 Turnstile 时面板才为门户页另外放行 https://challenges.cloudflare.com 的 script-src / frame-src，
 *       这是产物里唯一允许出现的外部脚本地址，见 components/turnstile.tsx）
 *     → index.html 不能有内联 <script>、on* 事件属性、javascript: 地址；
 *       也不放内联 <style> / style=""（虽然 CSP 暂时允许内联样式，我们不依赖它）；
 *       图片、字体只能来自本站，data: 也不行。
 *   · 面板只下发 index.html 与 /assets/*（akari-panel src/spa.rs）→ 其余产物都必须在 assets/ 下，
 *     index 里引用的本站文件都以 /assets/ 开头。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'parse5';

const DIST = 'dist/app';
const errors = [];
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/* ---------- index.html ----------
 * 用 HTML 规范的解析器（parse5，浏览器同款算法）建树再逐个元素检查，不用正则：
 * 注释、引号、大小写、属性写法的各种变体都按浏览器的理解来，不会被绕过。
 * scriptingEnabled: false 让 <noscript> 里的内容也作为元素被检查（更严）。 */
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const doc = parse(html, { scriptingEnabled: false });
const show = (el) => `<${el.tagName}${el.attrs.map((a) => ` ${a.name}="${a.value}"`).join('')}>`.slice(0, 120);
const visit = (node) => {
  const kids = node.tagName === 'template' ? node.content.childNodes : node.childNodes ?? [];
  if (node.tagName) checkElement(node);
  kids.forEach(visit);
};
const checkElement = (el) => {
  const attr = new Map(el.attrs.map((a) => [a.name, a.value]));
  if (el.tagName === 'script' && (!attr.has('src') || el.childNodes.some((c) => c.nodeName !== '#text' || c.value.trim()))) {
    errors.push(`index.html: inline <script>: ${show(el)}`);
  }
  if (el.tagName === 'style') errors.push('index.html: inline <style> element');
  for (const { name, value } of el.attrs) {
    if (name.startsWith('on')) errors.push(`index.html: inline event handler: ${show(el)}`);
    if (name === 'style') errors.push(`index.html: style attribute: ${show(el)}`);
    /* 浏览器解析 URL 前会去掉制表、换行与首尾空白，这里同样处理后再看 */
    if (/javascript:/i.test(value.replace(/\s/g, ''))) errors.push(`index.html: javascript: URL: ${show(el)}`);
  }
  for (const name of ['src', 'href']) {
    if (!attr.has(name)) continue;
    const url = attr.get(name).trim();
    if (url === '' || url.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || /^[\\/]{2}/.test(url)) errors.push(`index.html: external URL: ${url}`);
    else if (!url.startsWith('/assets/')) errors.push(`index.html: URL not under /assets/ (the panel serves only /assets/*): ${url}`);
  }
  if (attr.has('srcset')) errors.push(`index.html: srcset (not checked; use src): ${show(el)}`);
};
visit(doc);

/* ---------- 产物位置 ---------- */
for (const f of walk(DIST)) {
  const r = relative(DIST, f).split('\\').join('/');
  if (r === 'index.html' || r.startsWith('assets/') || r.startsWith('.vite/')) continue;
  errors.push(`${r}: outside assets/ (the panel serves only /assets/*)`);
}

/* ---------- JS / CSS ---------- */
for (const f of walk(join(DIST, 'assets'))) {
  if (!/\.(js|css)$/.test(f)) continue;
  const src = readFileSync(f, 'utf8');
  const r = relative(DIST, f);
  if (f.endsWith('.css') && /url\(\s*["']?data:/i.test(src)) errors.push(`${r}: data: URL in CSS (blocked by default-src 'self')`);
  /* 运行时拼出来的 data: 图片（比如二维码中心的标）同样会被 img-src 'self' 拦下 */
  if (f.endsWith('.js') && /["'`]data:image\//i.test(src)) errors.push(`${r}: data: image URL in JS (blocked by img-src 'self')`);
  if (/https?:\/\/(?!www\.w3\.org\/|challenges\.cloudflare\.com\/turnstile\/)[a-z0-9.-]+\.[a-z]{2,}\/[^"'`\s)]*\.(js|css|woff2?)\b/i.test(src)) {
    errors.push(`${r}: references a remote script/stylesheet/font`);
  }
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log('dist ok: no inline <script>/<style>/style=""/on* in index.html; every shipped file under assets/; no data: URLs or remote scripts in JS/CSS');
