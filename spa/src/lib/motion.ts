import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';

/**
 * 全站动效的统一口径（2026-10-13 用户：动效太多、太花、太慢 → 安静、利落）。
 *
 *   原则   内容直接出现。没有逐项错峰、没有区块上浮、没有数字滚动；只有切页时整页一次短淡入（index.css .page-in）。
 *   缓动   进场 --ease-out；退场 --ease-in。回弹（--ease-spring）只给付款成功的结果图标。
 *   时长   EXIT  离开：旧页面、关闭的弹层、提示条
 *          FAST  切页淡入、小件出现（离线提示条）
 *          BASE  弹窗、块级的状态变化
 *          SLOW  付款成功的对勾描画
 *          CELEBRATE  付款成功的一次性撒花（lib/confetti），短而小
 *   按下   按钮、开关、.press 缩到 0.985（--dur-press），不回弹，见 index.css「按下」
 *
 * CSS 里的同一套值是 index.css 顶部的 --ease-* / --dur-*，两边改要一起改（后台 admin/src/shared/index.css 同值，check-tokens 比对）。
 * 动画全部由 CSS 播放，这里只给元素打属性。
 */
export const DUR = { exit: 0.1, fast: 0.16, base: 0.2, slow: 0.32, celebrate: 0.8 } as const;

export type EnterOpts = { delay?: number; duration?: number };

/**
 * 淡入的属性包（只有不透明度，没有位移）：show 为 false 时停在透明，变成 true 的那一刻开播。
 * 用 backwards 填充，播完回到元素本来的样式。
 */
export function enterProps(show: boolean, { delay = 0, duration = DUR.fast }: EnterOpts = {}) {
  return {
    'data-enter': show ? 'in' : 'wait',
    style: { '--enter-delay': `${delay}s`, '--enter-dur': `${duration}s` } as CSSProperties,
  };
}

const REDUCE = '(prefers-reduced-motion: reduce)';
function subscribeReduce(f: () => void) {
  const mq = window.matchMedia(REDUCE);
  mq.addEventListener('change', f);
  return () => mq.removeEventListener('change', f);
}

/** 系统是否要求减少动效 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, () => window.matchMedia(REDUCE).matches, () => false);
}

/**
 * 有退场动画的条件渲染：visible 变 false 后再留 exitMs 毫秒，期间 leaving 为 true，给它播淡出。
 */
export function usePresence(visible: boolean, exitMs: number) {
  const [kept, setKept] = useState(visible);
  /* 出现时在渲染期间就记下，不必等 effect 再渲染一遍 */
  if (visible && !kept) setKept(true);
  useEffect(() => {
    if (visible) return;
    const t = setTimeout(() => setKept(false), exitMs);
    return () => clearTimeout(t);
  }, [visible, exitMs]);
  return { mounted: visible || kept, leaving: !visible && kept };
}

/**
 * 整页换状态（明暗、语言）用的淡入淡出。
 * 浏览器支持 View Transitions 时，把改动包进一次过渡：旧画面和新画面交叉淡化，
 * 而不是所有颜色同一帧硬切。不支持的浏览器照常直接切。
 * update 必须同步把 DOM 改完（React 状态用 flushSync 包一层），否则截到的「新画面」还是旧的。
 */
export function crossfade(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (typeof doc.startViewTransition !== 'function') { update(); return; }
  doc.startViewTransition(update);
}
