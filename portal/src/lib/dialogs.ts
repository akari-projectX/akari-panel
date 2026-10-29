import { onMount } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import { fastNetwork, loadPage, loadedPage, preloadPage, whenIdle } from './lazy';

/**
 * 按需加载的对话框（连同 bits-ui 都在单独的分包里，不进页面首屏）。原来第一次点按钮才开始下载，
 * 限速的网络上要等一两秒对话框才出来；现在分包照旧拆开，但在点击之前就下好：
 *   · 页面挂载后浏览器空闲时预载这一页的对话框（preloadDialogs；规则同 lib/prefetch 的页面预载：省流量、网络不到 4G 时不做）；
 *   · 指针移上 / 按下、键盘聚焦触发按钮时马上预载（{@attach intent(加载函数)}，空闲预载还没轮到时）；
 *   · 打开时 chunk(加载函数)：已经下好的模块同步返回，{#await} 当场画出对话框；没下好才等下载（lib/lazy 的重试 / 重新加载照常）。
 * 加载函数要是模块级常量（<script module>）：lib/lazy 按函数记已下好的模块。
 */
type Load = () => Promise<unknown>;

/** 组件初始化时调用：挂载后等浏览器空闲再预载这些对话框 */
export function preloadDialogs(...loads: Load[]) {
  onMount(() => {
    if (!fastNetwork()) return;
    return whenIdle(() => {
      for (const load of loads) void preloadPage(load);
    });
  });
}

/** 触发按钮上的意图：指针移上 / 按下、键盘聚焦时开始下载对话框 */
export function intent(load: Load): Attachment<HTMLElement> {
  return (el) => {
    const go = () => void preloadPage(load);
    const types = ['pointerenter', 'pointerdown', 'focus'] as const;
    for (const type of types) el.addEventListener(type, go, { passive: true });
    return () => {
      for (const type of types) el.removeEventListener(type, go);
    };
  };
}

/** 打开对话框时取模块：已经下好的同步返回，否则下载 */
export function chunk<T>(load: () => Promise<T>): T | Promise<T> {
  return loadedPage(load) ?? loadPage(load);
}
