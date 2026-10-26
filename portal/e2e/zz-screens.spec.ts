/*
 * 截图集（不是验收用例）：和 v1.4.0 React 门户的参照图（design/portal-v1-reference-2026-10/screens/）同名同视口同主题，
 * 给「恢复 v1.4.0 外观」的逐张对照用：导航（桌面的页头、手机打开的菜单）、几张页面（仪表盘、订单、工单、设置、隐私）、加载骨架。
 * 写到 test-results/screens/<名字>-<desktop|mobile>-<light|dark>.png，CI 作为 portal-screens 工件上传。
 * 放在最后跑（文件名 zz-，只在 mobile 项目里跑一次——那时两个视口的其余用例都跑完了），用前面用例留下的数据；
 * 拍不到的图记一条注解，不让整套失败。后续的恢复 PR 在这里继续加（商店、钱包、文档……）。
 */
import type { Browser, Locator, Page } from '@playwright/test';
import { signIn, test } from './fixtures.ts';

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
    /* 仪表盘的「近 7 日流量趋势」：整块、以及点开今天那一根的提示 */
    ...(['dashboard-chart', 'dashboard-chart-tip'] as const).map((name) => ({
      name, account: 'user@e2e.test',
      run: async (page: Page, device: Device) => {
        await ready(page, '/');
        const sec = page.locator('section.sec', { has: page.getByRole('heading', { name: '近 7 日流量趋势' }) });
        await sec.scrollIntoViewIfNeeded();
        if (name === 'dashboard-chart-tip') {
          if (device === 'desktop') await sec.locator('.wk-col').last().hover();
          else await sec.locator('.wk-col').last().tap();
          await sec.locator('.wk-tip').waitFor({ timeout: WAIT });
        }
        return sec;
      },
    })),
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
