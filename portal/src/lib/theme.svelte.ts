/**
 * 明暗模式：light / dark / system（跟随系统）。
 *
 * 首帧之前由 src/boot/boot.js 按同一个存储键给 <html> 加好 .dark / .light（模块脚本都是延后执行的）。
 * 这里负责之后的一切：读写选择、跟随系统切换、多个标签页之间同步、theme-color。
 * 键名与 React 门户相同（同一个源，偏好互通）。
 */

import { crossfade } from './motion';

export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'theme';
const media = matchMedia('(prefers-color-scheme: dark)');

function stored(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* 隐私模式下读不了，按跟随系统 */ }
  return 'system';
}

export const theme = $state({ mode: stored(), dark: false });

function apply() {
  const dark = theme.mode === 'dark' || (theme.mode === 'system' && media.matches);
  theme.dark = dark;
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  /* 浏览器地址栏的颜色 = 页面底色（颜色只在 tokens.css：读计算后的 --bg） */
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = getComputedStyle(root).getPropertyValue('--bg').trim();
}

function commit(next: ThemeMode) {
  theme.mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* 存不下也照样切换 */ }
  apply();
}

/** 选一个模式；明暗真的变了才交叉淡化（跟随系统且系统恰好就是这一边：不变，不必淡化） */
export function setTheme(next: ThemeMode) {
  if (next === theme.mode) return;
  const dark = next === 'dark' || (next === 'system' && media.matches);
  if (dark === theme.dark) commit(next);
  else crossfade(() => commit(next));
}

/** 顶栏的主题按钮（v1.4.0）：明 ↔ 暗互换，按当前实际看到的那一边算 */
export function toggleTheme() {
  setTheme(theme.dark ? 'light' : 'dark');
}

export function startTheme() {
  apply();
  media.addEventListener('change', () => { if (theme.mode === 'system') apply(); });
  addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    theme.mode = stored();
    apply();
  });
}
