#!/usr/bin/env node
/*
 * 颜色只在 src/styles/tokens.css 里（2026-10-22 协调人：配色可能随时换，换配色必须是一个文件的改动）。
 * 其余源码（.svelte / .ts / .js / .css / index.html）不许出现颜色字面量：十六进制、rgb()/hsl()/oklch() 等颜色函数、
 * Tailwind 任意值 bg-[#…]、常见颜色名作属性值。注释不算。图片文件（src/assets/ 里的 .svg 图标）不查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PORTAL } from './strings.mjs';

const TOKENS = path.join(PORTAL, 'src/styles/tokens.css');
const RULES = [
  ['hex colour', /(?<![\w&])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![\w-])/i],
  ['colour function', /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i],
  ['named colour', /(?:fill|stroke|color|background(?:-color)?|border(?:-[a-z]+)?-color|stop-color)\s*[:=]\s*["']?(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink)\b/i],
];

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(svelte|ts|js|css|html)$/.test(e.name) && p !== TOKENS) yield p;
  }
}

const problems = [];
for (const f of [...files(path.join(PORTAL, 'src')), path.join(PORTAL, 'index.html')]) {
  strip(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
    for (const [what, re] of RULES) {
      const m = re.exec(line);
      if (m) problems.push(`${path.relative(PORTAL, f)}:${i + 1}: ${what} "${m[0]}" — colours live in src/styles/tokens.css`);
    }
  });
}
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log('colours ok: every colour comes from src/styles/tokens.css');
