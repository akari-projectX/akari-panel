/*
 * 门户源码（src/，含 src/shared）里的字符串，给 check-i18n.mjs 与 collect-text.mjs 用（无依赖，不用装 node_modules）。
 *
 *   · .ts：字符串字面量、模板字符串的静态部分（注释、正则不算）；
 *   · .svelte：<script> 里同上；标记里 {…} 表达式同上；<style> 跳过；
 *     直接写在标记文本或属性值里的汉字记为 markup——界面文案一律经 t() / tp()（check-i18n 让它失败）。
 *
 * 不是完整的解析器，只认这套代码的写法：正则字面量按前一个记号判断，Svelte 的 {#if}/{:else}/{/if} 按表达式扫。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORTAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HAN = /[一-鿿]/;
const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^'], '');
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * 从 i 开始扫一段 TS / JS。stopAtBrace：遇到不配对的 `}` 就停（模板 ${…} 与 Svelte {…}）。
 * 字面量推进 out.strings；`'键': …` 这种后面跟冒号的另推进 out.keys。返回停下的位置。
 */
function scanCode(src, i, out, stopAtBrace) {
  let depth = 0;
  let prev = '';
  let word = '';
  const n = src.length;
  const literal = (text, end) => {
    out.strings.push(text);
    let j = end;
    while (j < n && /\s/.test(src[j])) j++;
    if (src[j] === ':') out.keys.push(text);
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { s += unescape(src[j + 1]); j += 2; continue; }
        s += src[j++];
      }
      literal(s, j + 1);
      i = j + 1; prev = 'lit'; word = '';
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let s = '';
      let parts = 0;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { s += unescape(src[j + 1]); j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          out.strings.push(s); s = ''; parts++;
          j = scanCode(src, j + 2, out, true) + 1;
          continue;
        }
        s += src[j++];
      }
      if (parts === 0) literal(s, j + 1);
      else out.strings.push(s);
      i = j + 1; prev = 'lit'; word = '';
      continue;
    }
    if (c === '/' && (REGEX_AFTER.has(prev) || REGEX_KEYWORDS.has(word))) {
      let j = i + 1;
      let cls = false;
      while (j < n && (cls || src[j] !== '/') && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        j++;
      }
      j++;
      while (j < n && /[a-z]/.test(src[j])) j++;
      i = j; prev = 'lit'; word = '';
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      word = src.slice(i, j); prev = 'id';
      i = j;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (depth === 0 && stopAtBrace) return i;
      depth--;
    }
    prev = c; word = '';
    i++;
  }
  return i;
}

function unescape(c) {
  return ({ n: '\n', t: '\t', r: '\r', '0': '\0' })[c] ?? c ?? '';
}

/** 一段 TS / JS 源码里的字面量；keys = 后面跟冒号的（对象键） */
export function scanTs(src) {
  const out = { strings: [], keys: [], markup: [] };
  scanCode(src, 0, out, false);
  return out;
}

/** 一个 .svelte 文件：字面量 + 直接写在标记里的汉字（markup） */
export function scanSvelte(src) {
  const out = { strings: [], keys: [], markup: [] };
  const n = src.length;
  let i = 0;
  let text = '';
  const flush = () => {
    const t = text.trim();
    if (HAN.test(t)) out.markup.push(t);
    text = '';
  };
  while (i < n) {
    if (src.startsWith('<!--', i)) { flush(); const e = src.indexOf('-->', i); i = e < 0 ? n : e + 3; continue; }
    const block = /^<(script|style)\b[^>]*>/i.exec(src.slice(i, i + 200));
    if (block) {
      flush();
      const tag = block[1].toLowerCase();
      const body = i + block[0].length;
      const close = new RegExp(`</${tag}\\s*>`, 'i').exec(src.slice(body));
      const end = close ? body + close.index : n;
      if (tag === 'script') scanCode(src.slice(body, end), 0, out, false);
      i = close ? end + close[0].length : n;
      continue;
    }
    const c = src[i];
    if (c === '{') { flush(); i = scanCode(src, i + 1, out, true) + 1; continue; }
    if (c === '<' && /[A-Za-z/]/.test(src[i + 1] ?? '')) { flush(); i = scanTag(src, i + 1, out); continue; }
    text += c;
    i++;
  }
  flush();
  return out;
}

/* 标签内部：属性值里的静态文字（含汉字则记 markup）与 {…} 表达式；返回 `>` 之后的位置 */
function scanTag(src, i, out) {
  const n = src.length;
  while (i < n && src[i] !== '>') {
    const c = src[i];
    if (c === '{') { i = scanCode(src, i + 1, out, true) + 1; continue; }
    if (c === '"' || c === '\'') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '{') { if (HAN.test(s)) out.markup.push(s.trim()); s = ''; j = scanCode(src, j + 1, out, true) + 1; continue; }
        s += src[j++];
      }
      if (HAN.test(s)) out.markup.push(s.trim());
      i = j + 1;
      continue;
    }
    i++;
  }
  return i + 1;
}

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(ts|svelte)$/.test(e.name) && !e.name.endsWith('.test.ts')) yield p;
  }
}

/** portal/src 的每个文件：{file（相对 portal/）, strings, markup} */
export function portalFiles(root = PORTAL) {
  const dir = path.join(root, 'src');
  if (!fs.existsSync(dir)) return [];
  return [...sources(dir)].map((file) => {
    const src = fs.readFileSync(file, 'utf8');
    const r = file.endsWith('.svelte') ? scanSvelte(src) : scanTs(src);
    return { file: path.relative(root, file), strings: r.strings, markup: r.markup };
  });
}

/** portal/src 用到的全部字符串 */
export function portalStrings(root = PORTAL) {
  return new Set(portalFiles(root).flatMap((f) => f.strings));
}
