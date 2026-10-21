/**
 * 启动画面（index.html 的 #boot）什么时候收起（与 React 门户 spa/src/lib/boot.ts 同一套规则）。
 *
 * 「占位还在就不收」：
 *   · hard —— 登录状态、页面分包、英文词典还没到：页面结构都还没有，必须等；
 *   · soft —— 首屏数据请求：结构就绪后最多再等 SOFT_WAIT，等不到就交给区块自己的骨架。
 * 另有 MAX_WAIT 兜底；收起前顺手等一下字体（最多 FONT_WAIT），免得淡出之后中文从系统字体跳成网页字体。
 * 启动画面收起之后 hold 一律是空操作——这套机制只管刷新后的第一屏。
 */

type Kind = 'hard' | 'soft';

const SOFT_WAIT = 700;
const MAX_WAIT = 10000;
const FONT_WAIT = 400;

let hard = 0;
let soft = 0;
let started = false;
let done = false;
let raf = 0;
let softTimer: ReturnType<typeof setTimeout> | undefined;

/** 启动画面开始淡出了（之后才去取导航上的提醒数字之类不挡首屏的数据） */
export const boot = $state({ out: false });

const noop = () => {};

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

/* 延后两帧再判断：「旧占位卸载、新占位挂载」时计数会短暂归零，别在那个瞬间收起 */
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
  const el = document.getElementById('boot');
  if (!el) { boot.out = true; return; }
  Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, FONT_WAIT))]).then(() => {
    el.classList.add('boot-out');
    boot.out = true;
    const drop = () => el.remove();
    /* 系统关掉动效时 transitionend 不一定触发，再挂一个兜底定时器 */
    el.addEventListener('transitionend', drop, { once: true });
    setTimeout(drop, 700);
  });
}

/** 应用挂载后调用（App 的 onMount：子组件的 hold 都已登记） */
export function startBoot() {
  if (started) return;
  started = true;
  schedule();
  setTimeout(dismiss, MAX_WAIT);
}
