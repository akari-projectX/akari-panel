#!/usr/bin/env node
/*
 * 字重只有两档：--fw-regular（400，正文）与 --fw-strong（600，强调 / 标题），定义在 src/styles/tokens.css。
 * 门户只用系统字体：微软雅黑没有 500，Windows / Android / Linux 上没有 300，其余字重会悄悄并成相邻一档，层次随之消失。
 * 层次靠颜色（--fg / --muted / --faint）与字号，不靠第三档字重。
 *
 * 在 src/ 与 index.html 里找：
 *   · font-weight: 后面不是 var(--fw-regular) / var(--fw-strong) / inherit（tokens.css 里定义令牌的 --fw-*: 数值除外）；
 *   · font: 简写里写了数值或关键字字重（100–900、bold、bolder、lighter）；
 *   · Tailwind 的 font-thin … font-black 与 font-[数值]；
 *   · font-variation-settings / font-weight 的 wght 轴。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PORTAL } from './strings.mjs';

const ROOTS = [join(PORTAL, 'src'), join(PORTAL, 'index.html')];
const TOKENS = join(PORTAL, 'src/styles/tokens.css');
const EXT = /\.(css|svelte|ts|html)$/;

function walk(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return [p];
  return readdirSync(p).flatMap((n) => walk(join(p, n)));
}

const WEIGHT_OK = /^(?:var\(--fw-(?:regular|strong)\)|inherit)$/;
const bad = [];

for (const file of ROOTS.flatMap(walk).filter((f) => EXT.test(f))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const at = (why) => bad.push(`${relative(PORTAL, file)}:${i + 1}: ${why}: ${line.trim().slice(0, 120)}`);
    for (const m of line.matchAll(/font-weight\s*:\s*([^;}"'`]+)/g)) {
      if (!WEIGHT_OK.test(m[1].trim())) at(`font-weight ${m[1].trim()}`);
    }
    for (const m of line.matchAll(/(?<![\w-])font\s*:\s*([^;}"'`]+)/g)) {
      if (/(?<![\w.-])(?:[1-9]00|bold|bolder|lighter)(?![\w.-])/.test(m[1].replace(/var\([^)]*\)/g, ''))) at('font shorthand with a weight');
    }
    if (/(?<![\w-])font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)(?![\w-])/.test(line)) at('Tailwind font weight class');
    if (/(?<![\w-])font-\[\d+\]/.test(line)) at('Tailwind arbitrary font weight');
    if (/font-variation-settings/.test(line) && /wght/.test(line)) at('wght axis');
    if (file !== TOKENS && /--fw-[a-z]+\s*:/.test(line)) at('weight token defined outside tokens.css');
  });
}

const tokens = readFileSync(TOKENS, 'utf8');
if (!/--fw-regular:\s*400\s*;/.test(tokens) || !/--fw-strong:\s*600\s*;/.test(tokens)) {
  bad.push('src/styles/tokens.css: --fw-regular must be 400 and --fw-strong 600');
}

if (bad.length) {
  console.error(`check-weights: only var(--fw-regular) and var(--fw-strong) are allowed (${bad.length}):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('check-weights: ok');
