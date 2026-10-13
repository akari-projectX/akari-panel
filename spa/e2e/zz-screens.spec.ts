/*
 * 截图集（不是验收用例）：仪表盘「近 7 日流量趋势」、商店套餐、钱包与邀请，以及几张没改版的页面（仪表盘、订单、工单、设置），桌面 + 手机 × 浅色 + 深色，简体中文。
 * 写到 test-results/screens/<名字>-<desktop|mobile>-<light|dark>.png，CI 作为 portal-screens 工件上传，给设计走查对照。
 * 放在最后跑（文件名 zz-，只在 mobile 项目里跑一次——那时两个视口的其余用例都跑完了），用前面用例留下的数据；
 * 另外加两个只为截图的套餐（多周期、仅限续费），看 1–4 个套餐时的排版。拍不到的图记一条注解，不让整套失败。
 */
import type { Browser, Page } from '@playwright/test';
import { admin, mine, seed, signIn, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

type Device = 'desktop' | 'mobile';
type Theme = 'light' | 'dark';
const VP = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;

type Shot = { name: string; account: string; run: (page: Page) => Promise<void> };

const section = (page: Page, title: string) => page.locator('section.sec').filter({ has: page.getByText(title, { exact: true }) }).first();

async function shotsFor(device: Device, theme: Theme, browser: Browser, shots: Shot[], note: (s: string) => void) {
  const ctx = await browser.newContext({
    ...VP[device], baseURL: process.env.E2E_BASE, locale: 'zh-CN', colorScheme: theme, reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  let who = '';
  try {
    for (const s of shots) {
      try {
        if (who !== s.account) {
          await ctx.clearCookies();
          await signIn(page, s.account);
          who = s.account;
        }
        await s.run(page);
        await page.screenshot({ path: `test-results/screens/${s.name}-${device}-${theme}.png`, fullPage: true });
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
  test.setTimeout(10 * 60_000);
  await extraPlans().catch((e) => console.log(`[screens] extra plans: ${(e as Error).message}`));
  const inviter = mine(info, 'inviter');
  const shots: Shot[] = [
    {
      name: 'dashboard-chart', account: 'user@e2e.test',
      run: async (page) => {
        await page.goto('/');
        const s = section(page, '近 7 日流量趋势');
        await s.waitFor();
        await page.waitForLoadState('networkidle');
        await s.scrollIntoViewIfNeeded();
        await s.screenshot({ path: `test-results/screens/dashboard-chart-only-${info.project.name}.png` }).catch(() => {});
      },
    },
    {
      name: 'shop', account: 'user@e2e.test',
      run: async (page) => {
        await page.goto('/shop');
        await page.locator('.plan-col').filter({ hasText: seed.premium }).first().waitFor();
        await page.waitForLoadState('networkidle');
      },
    },
    /* 没改版的页面：看全局的字重、颜色与动效变化 */
    ...(['/', '/orders', '/tickets', '/account'] as const).map((path) => ({
      name: `page-${path === '/' ? 'dashboard' : path.slice(1)}`, account: 'user@e2e.test',
      run: async (page: Page) => {
        await page.goto(path);
        await page.locator('main h1').first().waitFor();
        await page.waitForLoadState('networkidle');
      },
    })),
    {
      name: 'wallet', account: inviter,
      run: async (page) => {
        await page.goto('/wallet');
        await page.getByText('邀请佣金入账').first().waitFor();
        await page.waitForLoadState('networkidle');
      },
    },
    {
      name: 'invite', account: inviter,
      run: async (page) => {
        await page.goto('/invite');
        await page.getByText('返佣比例').first().waitFor();
        await page.waitForLoadState('networkidle');
      },
    },
  ];
  const notes: string[] = [];
  for (const device of ['desktop', 'mobile'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await shotsFor(device, theme, browser, shots, (s) => notes.push(s));
    }
  }
  for (const n of notes) {
    info.annotations.push({ type: 'screen-skipped', description: n });
    console.log(`[screens] skipped ${n}`);
  }
});
