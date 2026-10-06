import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { useBootOut } from '@/lib/boot';

/**
 * 全站动效的统一口径。加载、切页、刷新、交互都从这里取值，不在各处另写数字。
 *
 *   缓动   进场与位移一律 --ease-out（快起慢收）；退场用 --ease-in（慢起快走，不拖泥带水），见 index.css。
 *   时长   EXIT  离开：旧页面、关闭的提示        —— 越快越好，别让人等一个要走的东西
 *          FAST  小件：行、按钮、数字跳变、切页外壳
 *          BASE  块级：标题、统计条、卡片、正文块；也是启动画面淡出的时长
 *          SLOW  只给首屏大件：导航栏落下、落地页英雄区
 *   位移   块级上浮 RISE，小件与列表行 NUDGE。方向统一向上浮起，不左右滑。
 *   错峰   每项 STEP，最多排到第 CAP 项——列表再长，最后一行也不必等。
 *
 * CSS 里的同一套值是 index.css 顶部的 --ease-out / --ease-in / --dur-*，两边改要一起改。
 *
 * 动画全部由 CSS 播放（index.css「入场」一节），这里只给元素打上属性。
 * 以前用 motion 库，它压缩后 40 kB，又被页头、切页外壳引用，成了每个页面首屏必经的下载；
 * 而全站用到的只是「淡入上浮」「淡出」这几种，CSS 关键帧就能做，还不占主线程。
 */
export const DUR = { exit: 0.14, fast: 0.26, base: 0.42, slow: 0.7 } as const;

const RISE = 12;
export const NUDGE = 6;

const STEP = 0.045;
const CAP = 8;

/** 第 i 项的错峰延迟 */
export const stagger = (i: number, base = 0) => base + Math.min(i, CAP) * STEP;

export type EnterOpts = { delay?: number; y?: number; duration?: number; scale?: number };

/**
 * 入场的属性包：show 为 false 时停在起始状态（透明、下沉），变成 true 的那一刻开播。
 * 动画用 backwards 填充，播完就回到元素本来的样式——之后的悬停位移、opacity-55 这类类名照常生效。
 * 元素本身的 style 要和它合并：`style={{ ...p.style, … }}`，直接写 style 会把它盖掉。
 */
export function enterProps(show: boolean, { delay = 0, y = RISE, duration = DUR.base, scale }: EnterOpts = {}) {
  return {
    'data-enter': show ? 'in' : 'wait',
    style: {
      '--enter-y': `${y}px`,
      '--enter-delay': `${delay}s`,
      '--enter-dur': `${duration}s`,
      ...(scale !== undefined && { '--enter-scale': scale }),
    } as CSSProperties,
  };
}

/**
 * 入场动画的属性包：`<div {...enter()} />`、`{...enter({ delay: stagger(i), y: NUDGE })}`。
 *
 * 刷新时它会等启动画面开始淡出才开播（见 lib/boot 的 useBootOut）：
 * 在那之前停在起始状态，被启动画面盖着；淡出的同时浮起，整段动画都被看见。
 * 启动画面收起之后挂载的组件挂载即开播。
 */
export function useEnter() {
  const ready = useBootOut();
  return useCallback((opts?: EnterOpts) => enterProps(ready, opts), [ready]);
}

/** 元素第一次进入视口后恒为 true（不再观察） */
export function useInViewOnce<T extends Element>(margin = '0px'): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setSeen(true); io.disconnect(); }
    }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, margin]);
  return [ref, seen];
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
