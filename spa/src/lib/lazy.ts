import { createElement, lazy, useState, type ComponentProps, type ComponentType } from 'react';

/**
 * 按需加载的页面组件，带两样 React.lazy 没有的东西：
 *
 * 1. 下载失败重试一次。
 *    移动网络切基站、进隧道的那几秒，import() 会直接失败；失败就甩用户一张错误页太急了——先隔 700ms 重来一次。
 *    但**不能**原样再 import 一次同一个地址：浏览器会把失败的模块记在 module map 里，再 import 连请求都不会发。
 *    所以从报错信息里把地址抠出来，加个查询串，当成一个新模块重新取。
 *    重试失败时抛回原始错误，好让 ErrorBoundary 仍然认出这是「分包没下完」。
 *
 * 2. preload()，并且预载过的页面第一次渲染就是同步的。
 *    React.lazy 的第一次渲染**一定**会挂起一拍——哪怕模块早就下载好了，它也要等下一个微任务才知道。
 *    路由切换本身包在 transition 里，挂起那一拍看不出来；可切页动画是旧页面退场之后才挂上新页面，
 *    那一次挂载不在 transition 里，挂起就会亮出骨架屏，而且 React 为防闪烁会让骨架至少停留 300ms。
 *    所以模块到手后记下来：之后挂载的实例直接渲染真组件，不经过 lazy。
 *    是否走 lazy 在每个实例挂载时定下来（useState），之后不再切换，免得组件类型一变整棵子树被重建。
 */
type Loader<T> = () => Promise<{ default: T }>;

function withRetry<T>(load: Loader<T>): Promise<{ default: T }> {
  return load().catch((err: unknown) => {
    const url = String(err instanceof Error ? err.message : err).match(/https?:\/\/\S+?\.m?js/)?.[0];
    return new Promise<{ default: T }>((resolve, reject) => {
      setTimeout(() => {
        const again = url
          ? (import(/* @vite-ignore */ `${url}?retry=${Date.now()}`) as Promise<{ default: T }>)
          : load();
        again.then(resolve, () => reject(err));
      }, 700);
    });
  });
}

export type PageComponent<T extends ComponentType<any>> = ComponentType<ComponentProps<T>> & {
  /** 提前下载并记下模块；失败静默，真进页面时会重新请求并交给错误边界 */
  preload: () => Promise<void>;
};

export function lazyRetry<T extends ComponentType<any>>(load: Loader<T>): PageComponent<T> {
  let mod: { default: T } | undefined;
  let pending: Promise<{ default: T }> | undefined;
  const loadOnce = () => {
    pending ??= withRetry(load).then(
      (m) => (mod = m),
      (e) => { pending = undefined; throw e; },
    );
    return pending;
  };
  const Lazy = lazy(loadOnce);

  function Page(props: ComponentProps<T>) {
    const [ready] = useState(() => mod);
    return ready ? createElement(ready.default, props) : createElement(Lazy, props);
  }
  Page.preload = () => loadOnce().then(() => {}, () => {});
  return Page as PageComponent<T>;
}
