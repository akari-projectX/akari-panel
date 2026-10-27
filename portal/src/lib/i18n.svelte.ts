import { holdBoot } from './boot.svelte';
import { crossfade } from './motion';

/**
 * 界面语言：简体中文 / English。词典 src/shared/i18n/dict.ts（键 = 简体原文），
 * 英文词典按需加载（中文用户不下载它）。存储键 akari.locale。
 *
 * t() / tp() 读 $state（i18n.locale、i18n.en），模板里调用它们会随语言切换重新渲染。
 * 缺条目时回落到简体原文，不显示 key。
 */

export type Locale = 'zh-CN' | 'en';

const KEY = 'akari.locale';

function readLocale(): Locale {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'zh-CN' || v === 'en') return v;
    /* 没存过就跟随浏览器：任何中文（含 zh-TW / zh-HK）都用中文，其余走英文 */
    return /^zh\b/i.test(navigator.language || 'zh-CN') ? 'zh-CN' : 'en';
  } catch {
    return 'zh-CN';
  }
}

export const i18n = $state<{ locale: Locale; en: Record<string, string> | null }>({ locale: readLocale(), en: null });

let enLoading: Promise<void> | null = null;
/** 取英文词典；失败时清掉在途的 Promise，下一次还能重试 */
function loadEN(): Promise<void> {
  enLoading ??= import('@/i18n/dict').then(
    (m) => { i18n.en = m.EN; },
    (e: unknown) => { enLoading = null; throw e; },
  );
  return enLoading;
}

/** 语言按钮一获得指针 / 焦点就预取，点下去时通常已经到了 */
export function preloadEN() {
  loadEN().catch(() => {});
}

/** 按界面语言翻译一句简体原文 */
export function t(s: string): string {
  if (!s || i18n.locale !== 'en' || !i18n.en) return s;
  return i18n.en[s] ?? s;
}

/** 带占位符的翻译：`tp('共 {n} 条', { n: 12 })`——整句作一个键，语序跟着译文走 */
export function tp(s: string, vars: Record<string, string | number>): string {
  return t(s).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

function applyLang() {
  document.documentElement.lang = i18n.locale;
}

/** 切换语言：先等英文词典（下载失败也放行，回落中文），再换 */
export async function setLocale(next: Locale) {
  if (next === 'en') await loadEN().catch(() => {});
  crossfade(() => {
    i18n.locale = next;
    try { localStorage.setItem(KEY, next); } catch { /* 隐私模式 */ }
    applyLang();
  });
}

/** 启动：设 <html lang>；首屏是英文就拖住启动画面等词典，不先闪一版中文 */
export function startI18n() {
  applyLang();
  if (i18n.locale !== 'en') return;
  const release = holdBoot();
  loadEN().catch(() => {}).finally(release);
}
