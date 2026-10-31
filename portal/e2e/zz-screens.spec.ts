/*
 * 截图集（不是验收用例）：给设计评审逐张对照用，每个视口（桌面 / 手机）× 主题（浅 / 深）各一张：导航（桌面的页头、手机打开的菜单）、页面（仪表盘、商店、订单、工单、设置、隐私、文档、邀请、钱包三个页签、节点、流量、公告）、加载骨架。
 * 写到 test-results/screens/<名字>-<desktop|mobile>-<light|dark>.png，CI 作为 portal-screens 工件上传。
 * 放在最后跑（文件名 zz-，只在 mobile 项目里跑一次——那时两个视口的其余用例都跑完了），用前面用例留下的数据；
 * 拍不到的图记一条注解，不让整套失败。
 */
import type { Browser, Locator, Page } from '@playwright/test';
import { signIn, test } from './fixtures.ts';

/* 钱包用例的邀请人（zz 只在 mobile 项目里跑一次）：账户里有佣金流水和两条提现记录 */
const INVITER = 'v2-inviter-mobile@e2e.test';

test.describe.configure({ mode: 'serial' });

type Device = 'desktop' | 'mobile';
type Theme = 'light' | 'dark';
const VP = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;

/** run 返回一个元素时只截它，返回 'viewport' 时截可见区域，否则截整页 */
type Shot = { name: string; account: string; /** 只拍浅色，文件名不带主题（如 pay-success-desktop.png） */ plain?: boolean; run: (page: Page, device: Device) => Promise<Locator | 'viewport' | void> };

/** 每一步最多等这么久：拍不到就记一条注解，接着拍下一张 */
const WAIT = 10_000;

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
          if (s.account) await signIn(page, s.account);
          who = s.account;
        }
        if (s.plain && theme !== 'light') continue;
        const what = await s.run(page, device);
        const path = `test-results/screens/${s.name}-${device}${s.plain ? '' : `-${theme}`}.png`;
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

test('screens: nav, pages, loading skeleton (desktop + mobile × light + dark)', async ({ browser }, info) => {
  test.skip(info.project.name !== 'mobile', 'one run after both viewports finished');
  test.setTimeout(10 * 60_000);
  const ready = async (page: Page, path: string, text?: string) => {
    await page.goto(path);
    await page.locator('main h1').first().waitFor({ timeout: WAIT });
    /* attached，不要 visible：桌面上同一段文字的手机版行是隐藏的，first() 可能正是它 */
    if (text) await page.getByText(text).first().waitFor({ state: 'attached', timeout: WAIT });
    await page.waitForLoadState('networkidle', { timeout: WAIT }).catch(() => undefined);
  };
  const shots: Shot[] = [
    /* 导航：桌面的页头、手机打开的菜单 */
    {
      name: 'nav', account: 'user@e2e.test',
      run: async (page, device) => {
        await ready(page, '/');
        if (device === 'desktop') return page.locator('header').first();
        await page.getByRole('button', { name: '菜单' }).click();
        await page.getByRole('menu').first().waitFor({ timeout: WAIT });
        return 'viewport';
      },
    },
    /* 访客页（账号为空 = 不登录）：登录、注册、找回密码、条款 */
    ...(['/login', '/register', '/forgot'] as const).map((path) => ({
      name: `page-${path.slice(1)}`, account: '',
      run: (page: Page) => page.goto(path).then(() => page.locator('main h1').first().waitFor({ timeout: WAIT }))
        .then(() => page.waitForLoadState('networkidle', { timeout: WAIT }).catch(() => undefined)),
    })),
    /* 页面的外壳：页头、页宽、页脚、字体与颜色 */
    { name: 'page-privacy', account: 'user@e2e.test', run: (page) => ready(page, '/privacy') },
    ...(['/', '/orders', '/tickets', '/account'] as const).map((path) => ({
      name: `page-${path === '/' ? 'dashboard' : path.slice(1)}`, account: 'user@e2e.test',
      run: (page: Page) => ready(page, path),
    })),
    /* 仪表盘的「流量」（近 7 天）：整块、以及点开今天那一根的提示 */
    ...(['dashboard-chart', 'dashboard-chart-tip'] as const).map((name) => ({
      name, account: 'user@e2e.test',
      run: async (page: Page, device: Device) => {
        await ready(page, '/');
        const sec = page.locator('section.flow', { has: page.getByRole('heading', { name: '流量', exact: true }) });
        await sec.scrollIntoViewIfNeeded();
        if (name === 'dashboard-chart-tip') {
          if (device === 'desktop') await sec.locator('.wk-col').last().hover();
          else await sec.locator('.wk-col').last().tap();
          await sec.locator('.wk-tip').waitFor({ timeout: WAIT });
        }
        return sec;
      },
    })),
    /* 商店：整页、套餐卡片一列 */
    { name: 'shop', account: 'user@e2e.test', run: (page) => ready(page, '/shop', '选一个适合你的套餐') },
    {
      name: 'shop-cards', account: 'user@e2e.test',
      run: async (page) => { await ready(page, '/shop', '选一个适合你的套餐'); const c = page.locator('.plan-cols'); await c.waitFor({ timeout: WAIT }); return c; },
    },
    /* 文档（使用手册）列表与一篇文章 */
    { name: 'docs', account: 'user@e2e.test', run: (page) => ready(page, '/help', '使用手册') },
    {
      name: 'docs-article', account: 'user@e2e.test',
      run: async (page) => {
        await ready(page, '/help', '使用手册');
        await page.locator('main .grid button.card, main button.card').first().click();
        await page.locator('main article').first().waitFor({ timeout: WAIT });
        await page.waitForLoadState('networkidle', { timeout: WAIT }).catch(() => undefined);
      },
    },
    /* 邀请与钱包：邀请返佣 / 收支流水 / 提现记录三个页签（邀请人账户有佣金入账、追回、两笔提现） */
    { name: 'invite', account: INVITER, run: (page) => ready(page, '/wallet?tab=invite', '邀请返佣') },
    { name: 'wallet', account: INVITER, run: (page) => ready(page, '/wallet', '邀请返佣') },
    {
      name: 'wallet-ledger', account: INVITER,
      run: async (page) => { await ready(page, '/wallet?tab=ledger', '收支流水'); await page.locator('main .tp-sm tbody tr:visible, main .tp-sm .rowline:visible').first().waitFor({ timeout: WAIT }); },
    },
    {
      name: 'wallet-withdrawals', account: INVITER,
      run: async (page) => { await ready(page, '/wallet?tab=withdrawals', '提现记录'); await page.locator('main .tp-sm tbody tr:visible, main .tp-sm .rowline:visible').first().waitFor({ timeout: WAIT }); },
    },
    /* 其余页面：节点、流量、公告 */
    ...(['/nodes', '/traffic', '/announcements'] as const).map((path) => ({
      name: `page-${path.slice(1)}`, account: 'user@e2e.test', run: (page: Page) => ready(page, path),
    })),
    /* 付款成功弹窗：商店当场付清后带着 paid 跳到订单页的那一刻（这里用一张已付款的订单模拟，只拍浅色） */
    {
      name: 'pay-success', account: 'user@e2e.test', plain: true,
      run: async (page) => {
        await ready(page, '/orders');
        /* 页内取（页面的主机名只有浏览器认得，page.request 解析不了） */
        const list = await page.evaluate(() => fetch('/api/v1/me/orders').then((r) => r.json())) as { id: string; status: string; refunded_at: string | null }[];
        const paid = list.find((o) => o.status === 'paid' && !o.refunded_at);
        if (!paid) throw new Error('no paid order to show');
        await page.evaluate((id) => {
          history.pushState({ paid: true }, '', `/orders/${id}`);
          dispatchEvent(new PopStateEvent('popstate'));
        }, paid.id);
        await page.getByRole('dialog').waitFor({ timeout: WAIT });
        await page.waitForTimeout(900);
        return 'viewport';
      },
    },
    /* 加载态：订单列表的请求挂住不回，拍骨架（拍完上下文就关，拦截随之消失） */
    {
      name: 'loading-skeleton', account: 'user@e2e.test',
      run: async (page) => {
        await page.route('**/api/v1/me/orders', () => undefined);
        /* 整页重新加载时启动画面会盖住骨架：先在仪表盘落地（缓存清空），再站内跳到订单页 */
        await page.evaluate(() => sessionStorage.clear());
        await ready(page, '/');
        await page.evaluate(() => {
          history.pushState({}, '', '/orders');
          dispatchEvent(new PopStateEvent('popstate'));
        });
        await page.locator('.lines i:visible, .sk:visible').first().waitFor({ timeout: WAIT });
        await page.waitForTimeout(300);
        return 'viewport';
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
