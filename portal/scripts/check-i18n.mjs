#!/usr/bin/env node
/*
 * 门户 v2 的文案检查（CI 必跑）。词典与 React 门户共用一份：../spa/src/i18n/dict.ts（键 = 简体原文）。
 *   · 每个含汉字的字符串都要有英文条目（界面上的中文都经 t() / tp() 显示）；
 *   · .svelte 标记文本、属性值里不许直接写汉字（写成 {t('…')}）。
 * 「没人用的条目」由 React 门户的 scripts/check-i18n.mjs 检查，它把这里的字符串也算作有人用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PORTAL, portalFiles, scanTs } from './strings.mjs';

const DICT = path.join(PORTAL, '../spa/src/i18n/dict.ts');
const keys = new Set(scanTs(fs.readFileSync(DICT, 'utf8')).keys);
const HAN = /[一-鿿]/;

const errors = [];
for (const f of portalFiles()) {
  for (const s of f.markup) errors.push(`✗ Chinese written directly in markup (${f.file}): ${s} — use {t('…')}`);
  for (const s of new Set(f.strings)) {
    if (HAN.test(s) && !keys.has(s)) errors.push(`✗ no English for (${f.file}): ${s}`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`portal i18n ok: every Chinese string has an entry in the shared dictionary (${keys.size} entries)`);
