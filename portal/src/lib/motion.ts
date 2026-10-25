import { flushSync } from 'svelte';

/**
 * 明暗、语言切换：整页新旧两帧交叉淡化，而不是所有颜色、文字在同一帧硬切（v1.4.0 的 crossfade）。
 * update 必须同步把 DOM 改完（flushSync），否则截到的「新画面」还是旧的；不支持的浏览器照常直接切。
 */
export function crossfade(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const run = () => { update(); flushSync(); };
  if (typeof doc.startViewTransition !== 'function') { run(); return; }
  doc.startViewTransition(run);
}
