import { useEffect } from 'react';

/**
 * 弹窗开着时，把「可见视口」（visualViewport）的高度和顶边写进根元素的 --vv-h / --vv-top。
 *
 * 手机上弹窗居中（index.css 的 .panel）：按布局视口居中的话，弹出软键盘时
 * iOS Safari 与默认的安卓 Chrome 都只缩可见视口，不缩布局视口——输入框和按钮会被键盘盖住。
 * 跟着可见视口居中、按它的高度限高，键盘弹出时弹窗自己挪到键盘上方、内部滚动。
 * 不支持 visualViewport 时变量不存在，.panel 回落到 100dvh。
 * 多个弹窗同时开着（确认叠在流程上）共用一份监听，最后一个关掉时移除变量。
 */
let users = 0;
let stop: (() => void) | null = null;

function start() {
  const v = window.visualViewport;
  if (!v) return null;
  const root = document.documentElement.style;
  let raf = 0;
  const sync = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      root.setProperty('--vv-h', `${v.height}px`);
      root.setProperty('--vv-top', `${v.offsetTop}px`);
    });
  };
  root.setProperty('--vv-h', `${v.height}px`);
  root.setProperty('--vv-top', `${v.offsetTop}px`);
  v.addEventListener('resize', sync);
  v.addEventListener('scroll', sync);
  return () => {
    cancelAnimationFrame(raf);
    v.removeEventListener('resize', sync);
    v.removeEventListener('scroll', sync);
    root.removeProperty('--vv-h');
    root.removeProperty('--vv-top');
  };
}

export function useVisualViewport(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (users++ === 0) stop = start();
    return () => {
      if (--users === 0) { stop?.(); stop = null; }
    };
  }, [active]);
}
