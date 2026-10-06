/**
 * 启动画面（index.html 里的 #boot）什么时候收起。
 *
 * 原来的做法是 React 一画出首帧就收。可首帧往往什么都还没有：
 * 登录令牌在校验、页面分包在下载、首屏数据在路上——于是刷新一次，
 * 用户会看到 启动画面 → 另一个菊花 → 骨架屏 → 一排小菊花 → 内容一块块撑开，
 * 五种加载态轮流闪过，这就是「刷新很生硬」的来源。
 *
 * 现在改成「占位还在就不收」：
 *   · hard —— 路由 / 登录 / 分包级别的占位（PageLoading、各种 Skeleton）。
 *            它们在，说明页面结构都还没有，必须等。
 *   · soft —— 首屏数据请求（useApi 的第一次加载）。
 *            结构就绪后最多再等 SOFT_WAIT，等到了就直接露出填好数据的页面；
 *            接口慢就不等了，交给区块自己的骨架。
 * 另有 MAX_WAIT 兜底：网络再慢也不会一直停在启动画面上。
 *
 * 启动画面收起之后，hold 一律是空操作——这套机制只管刷新后的第一屏。
 */

import { useSyncExternalStore } from 'react';

type Kind = 'hard' | 'soft';

/* 数据最多再等这么久；超过就交给区块骨架，别让整页陪一个慢接口 */
const SOFT_WAIT = 700;
const MAX_WAIT = 10000;
/* 收起前顺手等一下字体，免得淡出之后中文再从系统字体跳成网页字体；最多等这么久 */
const FONT_WAIT = 400;

let hard = 0;
let soft = 0;
let started = false;
let done = false;
let raf = 0;
let softTimer: ReturnType<typeof setTimeout> | undefined;

const noop = () => {};

/*
 * 启动画面「开始淡出」的那一刻。
 *
 * 页面的入场动画在组件挂载时就会开播，而刷新时挂载发生在启动画面底下——
 * 等它淡出，动画要么播了一半（导航栏滑到一半、标题浮到一半），要么早已播完、整页定格出现，
 * 每次刷新看到的都不一样。首屏的入场动画都等这个信号（useBootOut / lib/motion 的 useEnter），
 * 于是启动画面淡出和页面入场同时发生，完整地播一遍。启动画面收起之后挂载的组件拿到的恒为 true，行为不变。
 */
let out = false;
const outSubs = new Set<() => void>();

function markOut() {
  if (out) return;
  out = true;
  outSubs.forEach((f) => f());
}

function subscribeOut(f: () => void) {
  outSubs.add(f);
  return () => { outSubs.delete(f); };
}

export function useBootOut(): boolean {
  return useSyncExternalStore(subscribeOut, () => out, () => true);
}

export function holdBoot(kind: Kind = 'hard'): () => void {
  if (done) return noop;
  if (kind === 'hard') hard++;
  else soft++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (kind === 'hard') hard--;
    else soft--;
    schedule();
  };
}

/*
 * 延后两帧再判断：同一次提交里常常是「旧占位卸载、新占位挂载」，
 * 计数会短暂归零（比如登录校验结束 → 布局里的分包骨架接着出现），别在那个瞬间收起。
 */
function schedule() {
  if (done || !started) return;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => { raf = requestAnimationFrame(check); });
}

function check() {
  if (done) return;
  if (hard > 0) {
    clearTimeout(softTimer);
    softTimer = undefined;
    return;
  }
  if (soft === 0) { dismiss(); return; }
  softTimer ??= setTimeout(dismiss, SOFT_WAIT);
}

function dismiss() {
  if (done) return;
  done = true;
  cancelAnimationFrame(raf);
  clearTimeout(softTimer);

  const boot = document.getElementById('boot');
  if (!boot) { markOut(); return; }
  const fonts = document.fonts.ready;
  Promise.race([fonts, new Promise((r) => setTimeout(r, FONT_WAIT))]).then(() => {
    boot.classList.add('boot-out');
    markOut();
    const drop = () => boot.remove();
    /* 系统关掉动效时 transitionend 不会触发，再挂一个兜底定时器 */
    boot.addEventListener('transitionend', drop, { once: true });
    setTimeout(drop, 700);
  });
}

/**
 * 由 App 在挂载后的 effect 里调用。
 * 放在 effect 里而不是 main.tsx 的 render() 之后：首次渲染是异步调度的，
 * 那时各个占位的 hold 还没登记，计数是 0，会被误判成「已就绪」。
 * 父组件的 effect 在全部子组件之后执行，到这里 hold 一定都登记好了。
 */
export function startBoot() {
  if (started) return;
  started = true;
  schedule();
  setTimeout(dismiss, MAX_WAIT);
}
