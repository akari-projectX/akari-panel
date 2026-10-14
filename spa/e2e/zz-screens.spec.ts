/*
 * 截图集（不是验收用例）：仪表盘「近 7 日流量趋势」、商店套餐卡片、使用手册、钱包与邀请（页头的 AKARI 标识在每一张里），以及几张没改版的页面（仪表盘、订单、工单、设置），桌面 + 手机 × 浅色 + 深色，简体中文。
 * 写到 test-results/screens/<名字>-<desktop|mobile>-<light|dark>.png，CI 作为 portal-screens 工件上传，给设计走查对照。
 * 放在最后跑（文件名 zz-，只在 mobile 项目里跑一次——那时两个视口的其余用例都跑完了），用前面用例留下的数据；
 * 另外加两个只为截图的套餐（多周期、仅限续费），看 1–4 个套餐时的排版。拍不到的图记一条注解，不让整套失败。
 */
import type { Browser, Locator, Page } from '@playwright/test';
import { Client } from './panel.ts';
import { admin, mine, seed, signIn, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

type Device = 'desktop' | 'mobile';
type Theme = 'light' | 'dark';
const VP = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;

/** run 返回一个元素时只截它，返回 'viewport' 时截可见区域，否则截整页 */
type Shot = { name: string; account: string; run: (page: Page, device: Device) => Promise<Locator | 'viewport' | void> };

/** 每一步最多等这么久：拍不到就记一条注解，接着拍下一张 */
const WAIT = 10_000;

const section = (page: Page, title: string) => page.locator('section.sec').filter({ has: page.getByText(title, { exact: true }) }).first();

async function shotsFor(device: Device, theme: Theme, browser: Browser, shots: Shot[], note: (s: string) => void) {
  const ctx = await browser.newContext({
    ...VP[device], baseURL: process.env.E2E_BASE, locale: 'zh-CN', colorScheme: theme, reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(WAIT);
  let who = '';
  try {
    for (const s of shots) {
      try {
        if (who !== s.account) {
          await ctx.clearCookies();
          await signIn(page, s.account);
          who = s.account;
        }
        const what = await s.run(page, device);
        const path = `test-results/screens/${s.name}-${device}-${theme}.png`;
        if (what === 'viewport') await page.screenshot({ path });
        else if (what) await what.screenshot({ path });
        else await page.screenshot({ path, fullPage: true });
      } catch (e) {
        note(`${s.name}-${device}-${theme}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  } finally {
    await ctx.close();
  }
}

/** 截图专用的套餐（重复跑不重复建） */
async function extraPlans() {
  const a = await admin();
  const plans = await a.call<{ name: string }[]>('GET', '/api/v1/plans');
  const groups = await a.call<{ id: string; name: string }[]>('GET', '/api/v1/node-groups');
  const group = groups.find((g) => g.name === 'e2e')?.id;
  const want = [
    {
      name: 'E2E 轻量', period: 'monthly', traffic_quota_bytes: 50 * 1024 ** 3, speed_limit_mbps: 100, sort: -1,
      description: '- 适合日常浏览\n- 单设备', pricing: { on_sale: true, prices: [
        { period: 'month', days: null, price_cents: 800 },
        { period: 'quarter', days: null, price_cents: 2100 },
        { period: 'year', days: null, price_cents: 7800 },
      ] },
    },
    {
      name: 'E2E 旧版', period: 'monthly', traffic_quota_bytes: 200 * 1024 ** 3, speed_limit_mbps: 500, renewal_only: true,
      description: '已下架，仅供老用户续费', pricing: { on_sale: true, prices: [{ period: 'month', days: null, price_cents: 2000 }] },
    },
  ];
  for (const p of want) {
    if (!plans.some((x) => x.name === p.name)) await a.call('POST', '/api/v1/plans', { ...p, group_ids: group ? [group] : [] });
  }
}

test('screens: dashboard chart, shop plans, wallet and invite (desktop + mobile × light + dark)', async ({ browser }, info) => {
  test.skip(info.project.name !== 'mobile', 'one run after both viewports finished');
  test.setTimeout(18 * 60_000);
  await extraPlans().catch((e) => console.log(`[screens] extra plans: ${(e as Error).message}`));
  const inviter = mine(info, 'inviter');
  const ready = async (page: Page, path: string, text?: string) => {
    await page.goto(path);
    await page.locator('main h1').first().waitFor({ timeout: WAIT });
    /* attached，不要 visible：桌面上同一段文字的手机版行是隐藏的，first() 可能正是它 */
    if (text) await page.getByText(text).first().waitFor({ state: 'attached', timeout: WAIT });
    await page.waitForLoadState('networkidle', { timeout: WAIT }).catch(() => undefined);
  };
  const chart = async (page: Page) => {
    await ready(page, '/', '近 7 日流量趋势');
    const s = section(page, '近 7 日流量趋势');
    await s.scrollIntoViewIfNeeded({ timeout: WAIT });
    return s;
  };
  const shots: Shot[] = [
    /* ① 仪表盘的流量图：区块本身；悬停 / 点按今天那一列的提示（新图才有，旧图拍不到时记一条注解） */
    { name: 'dashboard-chart', account: 'user@e2e.test', run: chart },
    {
      name: 'dashboard-chart-tip', account: 'user@e2e.test',
      run: async (page, device) => {
        const s = await chart(page);
        const col = page.locator('.wk-col').last();
        if (device === 'mobile') await col.tap({ timeout: 5000 });
        else await col.hover({ timeout: 5000 });
        return s;
      },
    },
    /* ② 商店（2026-10-14 套餐卡片：整页 + 只截卡片区） */
    { name: 'shop', account: 'user@e2e.test', run: (page) => ready(page, '/shop', seed.premium) },
    {
      name: 'shop-cards', account: 'user@e2e.test',
      run: async (page) => {
        await ready(page, '/shop', seed.premium);
        return page.locator('.plan-cols').first();
      },
    },
    /* 使用手册（2026-10-14：去掉「复制订阅地址」与设备下载链接，卡片区与搜索区拉开） */
    { name: 'docs', account: 'user@e2e.test', run: (page) => ready(page, '/help') },
    /* ③ 钱包与邀请：默认分页、流水、提现记录、旧地址 /invite */
    { name: 'wallet', account: inviter, run: (page) => ready(page, '/wallet', '申请提现') },
    { name: 'wallet-ledger', account: inviter, run: (page) => ready(page, '/wallet?tab=ledger', '邀请佣金入账') },
    { name: 'wallet-withdrawals', account: inviter, run: (page) => ready(page, '/wallet?tab=withdrawals') },
    { name: 'invite', account: inviter, run: (page) => ready(page, '/invite') },
    /* 导航：桌面的页头、手机打开的菜单 */
    {
      name: 'nav', account: 'user@e2e.test',
      run: async (page, device) => {
        await ready(page, '/');
        if (device === 'desktop') return page.locator('header').first();
        await page.locator('header button[aria-haspopup="menu"]:visible').last().click();
        await page.getByRole('menu').first().waitFor({ timeout: WAIT });
        return 'viewport';
      },
    },
    /* 没改版的页面：看全局的字重、颜色与动效变化 */
    /* 条款 / 隐私：阅读栏居中（用户 2026-10-13：以前只在左半边） */
    { name: 'page-privacy', account: 'user@e2e.test', run: (page) => ready(page, '/privacy') },
    ...(['/', '/orders', '/tickets', '/account'] as const).map((path) => ({
      name: `page-${path === '/' ? 'dashboard' : path.slice(1)}`, account: 'user@e2e.test',
      run: (page: Page) => ready(page, path),
    })),
  ];
  const notes: string[] = [];
  /* USDT 链上收款（C2b）：临时启用一个方式（高确认数：拍摄期间一直「确认中」），一单等待转账，一单已看到转账 */
  const usdt = await usdtSetup().catch((e) => { notes.push(`usdt setup: ${(e as Error).message}`); return null; });
  if (usdt) {
    const order = (id: string, text: string) => async (page: Page) => {
      await page.goto(`/orders/${id}`);
      await page.getByTestId('chain-status').getByText(text).first().waitFor({ timeout: WAIT });
    };
    shots.push(
      { name: 'usdt-order', account: usdt.waiting.email, run: order(usdt.waiting.order, '等待转账') },
      { name: 'usdt-confirming', account: usdt.seen.email, run: order(usdt.seen.order, '确认中') },
    );
  }
  try {
    for (const device of ['desktop', 'mobile'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        await shotsFor(device, theme, browser, shots, (s) => notes.push(s));
      }
    }
  } finally {
    await usdt?.done().catch(() => undefined);
  }
  for (const n of notes) {
    info.annotations.push({ type: 'screen-skipped', description: n });
    console.log(`[screens] skipped ${n}`);
  }
});

/**
 * 截图用的 USDT 链上收款方式（模拟 JSON-RPC 节点，见 usdt.spec.ts）：两个账户各下一单，其中一单按精确金额转账、
 * 确认数设得很高，所以拍摄期间一直是「已收到，确认中」。结束时停用该方式。
 */
async function usdtSetup() {
  const rpc = process.env.E2E_MOCK_RPC;
  if (!rpc) throw new Error('E2E_MOCK_RPC is not set');
  const a = await admin();
  const addr = `0x${'5'.repeat(40)}`;
  const config = { chain: 'polygon', address: addr, rate_cents: 720, confirmations: 900 };
  const existing = (await a.call<{ methods: { id: string; version: number; config: { address?: string } }[] }>('GET', '/api/v1/settings/payments'))
    .methods.find((m) => m.config.address?.toLowerCase() === addr);
  const method = existing
    ? await a.call<{ id: string; version: number }>('PUT', `/api/v1/settings/payments/${existing.id}`, {
      version: existing.version, display_name: 'USDT（Polygon）', enabled: true, config: { ...config, rpc_urls: rpc },
    })
    : await a.call<{ id: string; version: number }>('POST', '/api/v1/settings/payments', {
      kind: 'usdt_chain', display_name: 'USDT（Polygon）', enabled: true, config: { ...config, rpc_urls: rpc },
    });
  const plans = await a.call<{ id: string; name: string }[]>('GET', '/api/v1/plans');
  const plan = plans.find((p) => p.name === seed.plan)?.id;
  if (!plan) throw new Error('no seed plan');
  const make = async (who: string) => {
    const email = `${who}-${Date.now()}@e2e.test`;
    await a.call('POST', '/api/v1/users', { email, password: seed.password });
    const c = await Client.user(email, seed.password);
    const o = await c.call<{ id: string; chain: { amount_units: number } }>('POST', '/api/v1/me/orders', { plan_id: plan, period: 'month', method_id: method.id });
    return { email, order: o.id, units: o.chain.amount_units, c };
  };
  const waiting = await make('usdt-shot-wait');
  const seen = await make('usdt-shot-seen');
  const r = await fetch(`${rpc}/control/pay?to=${addr}&units=${seen.units}`, { method: 'POST' });
  if (!r.ok) throw new Error(`mock RPC: ${r.status}`);
  /* 监听每 5 秒一轮：等它记下这笔转账 */
  for (let i = 0; i < 40; i++) {
    const o = await seen.c.call<{ chain: { transfer: unknown } | null }>('GET', `/api/v1/me/orders/${seen.order}`);
    if (o.chain?.transfer) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const done = async () => {
    const m = (await a.call<{ methods: { id: string; version: number }[] }>('GET', '/api/v1/settings/payments')).methods.find((x) => x.id === method.id);
    if (m) await a.call('PUT', `/api/v1/settings/payments/${method.id}`, { version: m.version, display_name: 'USDT（Polygon）', enabled: false, config });
  };
  return { waiting, seen, done };
}
