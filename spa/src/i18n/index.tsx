import { Fragment, createContext, useCallback, useContext, type ReactNode } from 'react';

/* 只有中、英两种：切换按钮就是在两者之间互换，见 components/prefs */
export const LOCALES = [
  { id: 'zh-CN', label: '简体中文', short: '中' },
  { id: 'en', label: 'English', short: 'EN' },
] as const;

export type Locale = (typeof LOCALES)[number]['id'];

const KEY = 'akari.locale';

/**
 * 词典以**简体原文作为键**，而不是 `nav.dashboard` 这类人造 key。
 * 理由：这套 UI 已经写满了中文字面量，造 key 要改动每一处并额外维护一份映射；
 * 用原文当键，接入只需把字符串包进 t()，缺翻译时天然回落到简体，不会显示 key。
 * 代价是键较长、同词不同义时无法区分——真遇到再拆成带前缀的键。
 */

/*
 * 英文词典按需加载。它有六十来 kB，以前打在入口包里，每个中文用户都要白下一遍。
 * 界面是英文时才去取；首屏就是英文的话拖住启动画面等它（见下面的 effect），不会先闪一版中文。
 */
let EN: Record<string, string> | null = null;
let enLoading: Promise<void> | null = null;
/** 取英文词典；失败时清掉在途的 Promise，下一次还能重试（调用方决定失败后怎么办） */
export function loadEN(): Promise<void> {
  enLoading ??= import('./dict').then((m) => { EN = m.EN; }, (e) => { enLoading = null; throw e; });
  return enLoading;
}

/** 英文词典是否已经在内存里 */
export const hasEN = () => EN !== null;

/** 按界面语言翻译一句简体原文；英文词典还没到或缺条目时回落到原文 */
export function translate(locale: Locale, s: string): string {
  if (!s || locale !== 'en' || !EN) return s;
  return EN[s] ?? s;
}

/** 语言菜单一打开就预取英文词典，点下去时通常已经到了，不会先闪一下中文 */
export function preloadEN() {
  loadEN().catch(() => {});
}

/**
 * 切到这门语言所需的词典已经就绪。切语言的淡入淡出要等它：
 * 不然截到的「新画面」还是中文，词典到了之后又硬切一次。下载失败也放行，照旧回落到中文。
 */
export function localeReady(l: Locale): Promise<void> {
  if (l !== 'en' || EN) return Promise.resolve();
  return loadEN().catch(() => {});
}

let ZH: Map<string, string> | null = null;
/**
 * 英文译文 → 简体原文。英文界面预热中文字体时用：切回中文后这一页要显示哪些字，
 * 按页面上的英文反查词典就知道（见 lib/han-font）。词典还没到时返回 undefined。
 */
export function sourceOf(en: string): string | undefined {
  if (!EN) return undefined;
  ZH ??= new Map(Object.entries(EN).map(([zh, v]) => [v, zh]));
  return ZH.get(en);
}

export type LocaleCtxValue = { locale: Locale; setLocale: (l: Locale) => void; t: (s: string) => string };

/* Provider 在 ./provider.tsx（组件和 hook 分文件放，开发时的热更新才能只刷新组件） */
export const LocaleCtx = createContext<LocaleCtxValue | null>(null);

/** 启动时的界面语言：存过的优先，否则跟随浏览器 */
export function readLocale(): Locale {
  try {
    const v = localStorage.getItem(KEY);
    if (v && LOCALES.some((l) => l.id === v)) return v as Locale;
    /* 没存过就跟随浏览器：任何中文（含 zh-TW / zh-HK）都用中文，其余走英文 */
    return /^zh\b/i.test(navigator.language || 'zh-CN') ? 'zh-CN' : 'en';
  } catch {
    return 'zh-CN';
  }
}

export function saveLocale(locale: Locale) {
  try {
    localStorage.setItem(KEY, locale);
  } catch { /* 隐私模式下写不进去，忽略 */ }
}

export function useLocale() {
  const c = useContext(LocaleCtx);
  if (!c) throw new Error('useLocale 必须在 <LocaleProvider> 内使用');
  return c;
}

/** 只要翻译函数时用它，省一层解构 */
export function useT() {
  return useLocale().t;
}

/**
 * 带占位符的翻译：`tp('共 {n} 条', { n: 12 })`。
 * 中英语序不同，把整句留作一个键再回填变量，比 `t('共') + n + t('条')` 拼出来的通顺得多。
 */
export function useTp() {
  const t = useLocale().t;
  return useCallback(
    (s: string, vars: Record<string, string | number>) =>
      t(s).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)),
    [t],
  );
}

/**
 * 占位符可以是元素的翻译：`tn('发邮件到 {email}', { email: <a …/> })`。
 * 先按整句查词典，再把占位符换成对应的节点——链接能嵌在句子中间，语序仍跟着译文走。
 */
export function useTn() {
  const t = useLocale().t;
  return useCallback(
    (s: string, vars: Record<string, ReactNode>): ReactNode =>
      t(s).split(/\{(\w+)\}/).map((part, i) =>
        i % 2 ? <Fragment key={i}>{vars[part] ?? `{${part}}`}</Fragment> : part),
    [t],
  );
}
