/*
 * 门户性能报告（只报告，不判定；2026-10-07 用户裁决：以真实性能指标代替硬性体积预算）。
 * 由 ../scripts/e2e-portal.sh 在 E2E_PERF_OUT 设置时用 playwright.perf.config.ts 跑：每个画像写一份 perf-svelte-<画像>.json，
 * e2e/perf/summary.mjs 与 React 门户的最后一次测量（e2e/perf/baseline/，切换前同一套测法）合并成 Markdown
 * （CI 写进任务摘要并作为工件 portal-perf 上传）。登录走接口，之后测冷启动与切页。
 *
 *   画像    desktop（不限速）/ mobile-mid（Pixel 7 视口 + CPU 4× 降速 + 150 ms RTT、1.6 Mbps 下行，近似 Lighthouse 的移动端）
 *   指标    冷启动（新上下文 = 空缓存）的 FCP、LCP、TTI（简化：FCP 之后最后一个长任务结束，至少到 DOMContentLoaded；
 *           长任务静默 1 秒即判定），内容就绪（启动画面收起、无骨架、有页面标题）；
 *           切页（客户端导航开始 → 新页面内容就绪，页内 rAF 计时，含切页动画）
 *   动效    照常播放（不是 reduced motion）：测的是用户实际等的时间
 * 每项取 RUNS 次的中位数。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

const OUT = process.env.E2E_PERF_OUT ?? 'test-results/perf';
const LABEL = process.env.E2E_PERF_LABEL ?? 'svelte';
const RUNS = Number(process.env.E2E_PERF_RUNS ?? 5);
const USER = 'user@e2e.test';
const PASSWORD = 'e2e-password-123';
const ROUTES = ['/nodes', '/orders', '/shop', '/traffic', '/'];

type Throttle = { cpu: number; latency: number; down: number; up: number } | null;
const THROTTLE: Record<string, Throttle> = {
  desktop: null,
  'mobile-mid': { cpu: 4, latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8 },
};

/* 页内观察器：在任何脚本之前装上，记 FCP / LCP / 长任务 */
const OBSERVE = () => {
  const w = window as unknown as { __perf: { lcp: number; fcp: number; long: [number, number][] } };
  w.__perf = { lcp: 0, fcp: 0, long: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.lcp = e.startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') w.__perf.fcp = e.startTime;
  }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) w.__perf.long.push([e.startTime, e.startTime + e.duration]);
  }).observe({ type: 'longtask', buffered: true });
};

/* 内容就绪：启动画面已收起、没有骨架 / 加载中、没有正在退场的旧页面、有页面标题 */
const READY = (path: string) =>
  location.pathname === path &&
  !document.querySelector('#boot:not(.boot-out)') &&
  !document.querySelector('[aria-busy], .page-out') &&
  !!document.querySelector('main h1, h1');

async function throttle(ctx: BrowserContext, page: Page, t: Throttle) {
  if (!t) return;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: t.latency, downloadThroughput: t.down, uploadThroughput: t.up,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: t.cpu });
}

async function newPage(browser: Browser, info: TestInfo, state?: string) {
  const ctx = await browser.newContext({ ...info.project.use, storageState: state, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  await page.addInitScript(OBSERVE);
  await throttle(ctx, page, THROTTLE[info.project.name] ?? null);
  return { ctx, page };
}

/* 冷启动一次：返回 FCP / LCP / TTI / 内容就绪（毫秒，相对导航开始） */
async function coldLoad(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'commit' });
  await page.waitForFunction(READY, path, { timeout: 60_000, polling: 'raf' });
  const ready = await page.evaluate(() => performance.now());
  /* 长任务静默 1 秒（最多再等 10 秒） */
  await page.waitForFunction(() => {
    const p = (window as unknown as { __perf: { long: [number, number][] } }).__perf;
    const last = p.long.at(-1)?.[1] ?? 0;
    return performance.now() - last > 1000;
  }, undefined, { timeout: 10_000, polling: 250 }).catch(() => {});
  return page.evaluate((r) => {
    const p = (window as unknown as { __perf: { lcp: number; fcp: number; long: [number, number][] } }).__perf;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const lastLong = p.long.filter(([s]) => s >= p.fcp).at(-1)?.[1] ?? 0;
    return { fcp: p.fcp, lcp: p.lcp, tti: Math.max(p.fcp, nav?.domContentLoadedEventEnd ?? 0, lastLong), ready: r };
  }, ready);
}

/* 一次客户端切页：pushState + popstate（门户的路由照常接手），页内计时到内容就绪。
   就绪条件同 READY，另要求标题换了一个节点；写在页内（CSP 不许 eval，不能把函数文本传进去再构造） */
async function routeSwitch(page: Page, path: string) {
  return page.evaluate(async (to) => {
    /* 新页面重新挂载，标题是新节点：旧页面在原地（切页还没开始或在过渡里被保留）时不算就绪 */
    const before = document.querySelector('main h1, h1');
    const ready = () =>
      location.pathname === to &&
      document.querySelector('main h1, h1') !== before &&
      !document.querySelector('#boot:not(.boot-out)') &&
      !document.querySelector('[aria-busy], .page-out') &&
      !!document.querySelector('main h1, h1');
    const t0 = performance.now();
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    await new Promise<void>((done) => {
      const tick = () => (ready() ? done() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    return performance.now() - t0;
  }, path);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.floor(s.length / 2)]) : NaN;
};

test('portal performance report', async ({ browser }, info) => {
  test.setTimeout(10 * 60_000);
  /*
   * 登录一次（接口，与 e2e/panel.ts 的 Client.login 一样带表单令牌、等过最短提交时间），存会话：
   * 后面每次冷启动都是新上下文 + 空缓存，只带 cookie。会话文件不放进报告目录（那里的 JSON 会作为工件上传）。
   */
  const state = join('test-results', `perf-state-${LABEL}-${info.project.name}.json`);
  mkdirSync('test-results', { recursive: true });
  mkdirSync(OUT, { recursive: true });
  {
    /* 接口请求在 Node 里发（浏览器的域名映射管不到）：直连面板（E2E_API），cookie 记到门户的域名下 */
    const api = await request.newContext({ baseURL: process.env.E2E_API });
    const o = await (await api.get('/auth/options')).json() as { guard?: { form_token?: string; form_min_secs?: number } };
    await new Promise((r) => setTimeout(r, (o.guard?.form_min_secs ?? 0) * 1000 + 300));
    const guard = { ...(o.guard?.form_token ? { form_token: o.guard.form_token } : {}), website: '' };
    const res = await api.post('/auth/login', { data: { email: USER, password: PASSWORD, guard } });
    if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
    const host = new URL(String(info.project.use.baseURL ?? process.env.E2E_BASE)).hostname;
    const { cookies } = await api.storageState();
    writeFileSync(state, JSON.stringify({ cookies: cookies.map((c) => ({ ...c, domain: host })), origins: [] }));
    await api.dispose();
  }

  const samples: Record<string, number[]> = {};
  const add = (k: string, v: number) => { (samples[k] ??= []).push(v); };

  for (let i = 0; i < RUNS; i++) {
    for (const [name, path, auth] of [['login', '/login', false], ['dashboard', '/', true]] as const) {
      const { ctx, page } = await newPage(browser, info, auth ? state : undefined);
      const m = await coldLoad(page, path);
      for (const [k, v] of Object.entries(m)) add(`${name}.${k}`, v);
      if (name === 'dashboard') {
        for (const r of ROUTES) add(`switch.${r}`, await routeSwitch(page, r));
      }
      await ctx.close();
    }
  }

  const result = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, median(v)]));
  writeFileSync(
    join(OUT, `perf-${LABEL}-${info.project.name}.json`),
    JSON.stringify({ portal: LABEL, profile: info.project.name, runs: RUNS, result }, null, 2),
  );
  console.log(LABEL, info.project.name, result);
});
