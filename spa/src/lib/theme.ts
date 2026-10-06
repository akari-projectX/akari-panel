import { useSyncExternalStore } from 'react';

/**
 * 明暗模式：light / dark / system（跟随系统）。
 *
 * 首帧之前由 src/boot/boot.js 按同一个存储键先给 <html> 加好 class（那是同步的经典脚本，
 * 模块脚本都是延后执行的，等它们跑起来深色用户已经先看到一片白）。这里负责之后的一切：
 * 读写选择、跟随系统切换、多个标签页之间同步。两边的键名和判定必须一致。
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/* 与 src/boot/boot.js 的 THEME_KEY 一致 */
const KEY = 'theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function stored(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* 隐私模式下读不了，按跟随系统 */ }
  return 'system';
}

let mode: ThemeMode = stored();
const subs = new Set<() => void>();

const resolve = (m: ThemeMode): ResolvedTheme => (m === 'system' ? (media.matches ? 'dark' : 'light') : m);

function apply() {
  const r = resolve(mode);
  const root = document.documentElement;
  root.classList.toggle('dark', r === 'dark');
  root.classList.toggle('light', r === 'light');
  root.style.colorScheme = r;
  subs.forEach((f) => f());
}

apply();
media.addEventListener('change', () => { if (mode === 'system') apply(); });
/* 另一个标签页改了选择 */
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  mode = stored();
  apply();
});

function setTheme(next: ThemeMode) {
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* 存不下也照样切换，只是下次不记得 */ }
  apply();
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => { subs.delete(f); };
}

/** theme = 用户的选择（含 system），resolvedTheme = 实际生效的明暗 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => mode);
  const resolvedTheme = useSyncExternalStore(subscribe, () => resolve(mode));
  return { theme, resolvedTheme, setTheme };
}
