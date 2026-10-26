import { contentApi, meApi, orderApi, shopApi, ticketApi } from '@/api';
import { K, load, readCache } from '@/lib/cache';
import { dashSpecs } from './dash-data';
import { loadedPage, preloadPage } from './lazy';
import { match, PAGES } from './pages';
import { allowed, R, type Scope } from './routes';

/**
 * 切页预取（同 React 门户 lib/prefetch.ts）：第一次点进某一页本来要经过「分包下载 → 骨架 → 取数」两段往返，
 * 限速的手机网络上就是几百毫秒。这里把它挪到用户还没点的时候：
 *   · 进了用户中心、启动画面收起、浏览器空闲：这个账户范围能进的各页分包全部预载，再两路并发预取几页的首屏数据
 *     （只取还没缓存的；有缓存的页面进来时自己会在后台刷新）；访客页预载其余访客页与仪表盘（登录后去那里）。
 *   · 指针移上 / 按下 / 键盘聚焦站内链接：马上预载那一页的分包，同时取它的首屏数据（空闲预取还没轮到它时）。
 * 预载过的页面切过去是同步渲染的（lib/lazy 的 loadedPage），数据有缓存就一次画全。
 * 失败一律静默：预取是锦上添花，真正进页面时会重新请求并展示错误。省流量、网络不到 4G 时不做空闲预取。
 */

/** effectiveType 只有 slow-2g / 2g / 3g / 4g 四档；拿不到这个值的浏览器（Safari、Firefox）按快网络处理 */
export function fastNetwork(): boolean {
  const net = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (net?.saveData) return false;
  return !net?.effectiveType || net.effectiveType === '4g';
}

/** 各页的首屏数据（缓存键与页面自己的 resource 相同）；指针移上链接时取那一页的 */
const DATA: Record<string, [string, () => Promise<unknown>]> = {
  [R.nodes]: [K.nodes, () => meApi.nodes()],
  [R.orders]: [K.orders, () => orderApi.list()],
  [R.shop]: [K.shop('', false), () => shopApi.get()],
  [R.tickets]: [K.tickets, () => ticketApi.list()],
  [R.announcements]: [K.announcements, () => contentApi.announcements()],
  [R.help]: [K.help(), () => contentApi.help()],
};

/**
 * 空闲预取的顺序：最常去的几页在前，每页「分包 + 数据」挨着取。手机网络带宽有限，一下子把十几个分包和一串请求全发出去，
 * 最先要用的那一页反而要和其余的抢（限速手机上实测比不预取还慢）；三路并发（分包与首屏数据都很小，主要花在往返上）、按顺序来，第一页最快到手。
 * 订单在商店前：商店页也要订单列表（有待付款的单时挡住下单）。
 */
const ORDER: string[] = [R.nodes, R.orders, R.shop, R.traffic, R.announcements, R.help, R.tickets, R.wallet, R.account];

/** 已登录且绑定了邮箱时的账户范围（App 进用户中心时设置）；没有 = 不预取数据 */
let signedIn: Scope | null = null;

function dataJob(path: string): (() => Promise<unknown>) | undefined {
  const d = DATA[path];
  if (!d || readCache(d[0]) !== undefined) return undefined;
  return () => load(d[0], d[1]).catch(() => {});
}

export function prefetchDash(scope: Scope) {
  signedIn = scope;
  if (!fastNetwork()) return;
  const dash = PAGES.filter((p) => p.layout === 'dash' && allowed(p.path, scope));
  const rank = (p: string) => { const i = ORDER.indexOf(p); return i < 0 ? ORDER.length : i; };
  /* 页头的账号卡片（含图标）：第一个，点开账号菜单时已经在了 */
  const todo: (() => Promise<unknown>)[] = [() => import('../components/AccountCard.svelte')];
  for (const page of [...dash].sort((a, b) => rank(a.path) - rank(b.path))) {
    if (loadedPage(page.load) === undefined) todo.push(() => preloadPage(page.load));
    const data = dataJob(page.path);
    if (data) todo.push(data);
  }
  /* 三路并发，做完一个再发下一个 */
  const next = (): void => {
    const job = todo.shift();
    if (job) void job().finally(next);
  };
  for (let i = 0; i < 3; i++) next();
}

/**
 * 正在看的这一页：地址一知道（登录态在缓存里，或 /me 刚回来）就把它的分包与首屏数据取起来，不等页面组件挂载。
 * 刷新后的第一屏本来是一条串行的链——/me → 分包（连同它静态依赖的一串模块）→ 页面挂载 → 取数，限速的手机网络上每一段都是几百毫秒；
 * 这里让分包与数据请求和 /me 之后的渲染并行。数据请求进 lib/cache 的在途表，页面自己的 resource 复用同一个 Promise。
 * 现在只有仪表盘（刷新最常落脚的地方）有数据清单；其余页面只预载分包，数据由页面自己取（指针移上链接时的预取照旧）。
 */
export function prefetchCurrent(path: string, scope: Scope) {
  const found = match(path);
  if (!found || !allowed(found.page.path, scope)) return;
  void preloadPage(found.page.load);
  if (found.page.path !== R.dashboard) return;
  const d = dashSpecs();
  const jobs: { key: string; fetch: () => Promise<unknown> }[] = [d.announcements, d.balance, d.orders, d.tickets, d.help];
  if (scope === 'full') jobs.push(d.traffic, d.nodes);
  for (const j of jobs) void load(j.key, j.fetch).catch(() => {});
}

/** 访客页：其余访客页（登录、注册、找回密码之间互相跳）与仪表盘（登录后去那里）；数据很少，进页面时再取 */
export function prefetchSite() {
  signedIn = null;
  if (!fastNetwork()) return;
  for (const page of PAGES) if (page.layout === 'guest' || page.path === R.dashboard) void preloadPage(page.load);
}

/** 等浏览器闲下来再跑，别和当前页面自己的请求抢带宽 */
export function whenIdle(fn: () => void, timeout = 2500): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const t = setTimeout(fn, Math.min(timeout, 1200));
  return () => clearTimeout(t);
}

/** 站内链接上的意图（指针移上、按下、键盘聚焦）：预载那一页的分包 */
export function startIntentPrefetch() {
  const onIntent = (e: Event) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!(a instanceof HTMLAnchorElement) || a.origin !== location.origin) return;
    const found = match(a.pathname);
    if (!found) return;
    void preloadPage(found.page.load);
    /* 分包与数据同时取，不排成两段往返 */
    if (signedIn && allowed(found.page.path, signedIn)) void dataJob(found.page.path)?.();
  };
  for (const type of ['pointerover', 'pointerdown', 'focusin']) {
    addEventListener(type, onIntent, { capture: true, passive: true });
  }
}
