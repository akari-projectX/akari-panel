import { contentApi, orderApi, ticketApi } from '@/api';
import type { Scope } from '@/lib/auth';
import { K, load, readCache } from '@/lib/cache';
import { DASH_PAGES, SITE_PAGES } from '@/pages/registry';

/**
 * 进入用户中心后，趁浏览器空闲把各页的分包和首屏数据先取好。
 *
 * 缓存只能让「看过的页面」再进来时一次到位；第一次点进某一页仍然要经过
 * 分包下载 → 骨架 → 数据填充。预取把这一步挪到用户还没点的时候，
 * 于是第一次进来也和接入真接口之前一样，是整页一起出来的。
 *
 * 分包用各页面组件自己的 preload() 取（见 pages/registry 与 lib/lazy），预载过的页面第一次进来是同步渲染的；
 * 数据只预取还没有缓存的——有缓存的页面进来时自己会在后台刷新。
 * 失败一律静默：预取是锦上添花，真正进页面时会重新请求并展示错误。
 */

/**
 * 网络够快才预取。effectiveType 只有 slow-2g / 2g / 3g / 4g 四档；3g 下全部分包加起来要下好几秒，
 * 会和用户正在看的页面抢带宽。拿不到这个值的浏览器（Safari、Firefox）按快网络处理。
 */
export function fastNetwork(): boolean {
  const net = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (net?.saveData) return false;
  return !net?.effectiveType || net.effectiveType === '4g';
}

export function prefetchDash(scope: Scope | undefined) {
  /* 开了省流量、或者网络不到 4G：预取是锦上添花，不替用户花流量 */
  if (!fastNetwork() || !scope) return;

  for (const page of DASH_PAGES) page.preload();

  const jobs: [string, () => Promise<unknown>][] = [[K.tickets, () => ticketApi.list()]];
  if (scope !== 'banned') {
    jobs.push([K.orders, () => orderApi.list()], [K.announcements, () => contentApi.announcements()], [K.help(), () => contentApi.help()]);
  }
  /* 两路并发，做完一个再发下一个，不在进门那一刻同时打一串请求 */
  const todo = jobs.filter(([key]) => readCache(key) === undefined);
  const next = (): void => {
    const job = todo.shift();
    if (job) load(job[0], job[1]).catch(() => {}).finally(next);
  };
  next();
  next();
}

/** 站点页只预载分包（登录、注册、找回密码同在一个分包里）；这些页的数据很少，进页面时再取 */
export function prefetchSite() {
  if (!fastNetwork()) return;
  for (const page of SITE_PAGES) page.preload();
}

/** 等浏览器闲下来再跑，别和当前页面自己的请求抢带宽 */
export function whenIdle(fn: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 2500 });
    return () => window.cancelIdleCallback(id);
  }
  const t = setTimeout(fn, 1200);
  return () => clearTimeout(t);
}
