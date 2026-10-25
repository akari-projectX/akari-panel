/*
 * 门户外壳（v1.4.0 外观）。门禁、导航（桌面顶栏 + 「更多」 / 账号卡片 / 窄屏的两根线菜单）、明暗、语言、账户范围、旧地址、退出，
 * 以及设计评审截图（桌面 1440 / 手机 390 × 浅 / 深）。
 * 账户来自 e2e/support/seed.ts：user@e2e.test（正常）、expired@e2e.test（续费范围）、banned@e2e.test（封禁）；
 * 退出用 logout-<视口>@e2e.test——user@e2e.test 永远不退出（退出会结束这个账户的所有会话）。
 */
import type { Page } from '@playwright/test';
import { FIELDS } from './support/panel.ts';
import { admin, expect, mine, ready, shot, signIn, test } from './fixtures';

/** 顶栏五项 + 「更多」里的五项（v1.4.0：仪表盘 · 商店 · 文档 · 邀请 · 工单 · 更多） */
const NAV = ['仪表盘', '商店', '文档', '邀请', '工单', '节点状态', '使用明细', '公告与动态', '我的订单', '设置'];

const desktop = (name: string) => name === 'desktop';

/** 某个视口下可见的导航名（桌面 = 顶栏 + 展开的「更多」；手机 = 打开菜单后卡片里的全部导航行） */
async function navNames(page: Page, isDesktop: boolean): Promise<string[]> {
  if (isDesktop) {
    const nav = page.getByRole('navigation', { name: '主导航' });
    const names = await nav.getByRole('link').allInnerTexts();
    const more = nav.getByRole('button', { name: '更多' });
    if (await more.count()) {
      await more.click();
      const menu = page.getByRole('menu', { name: '更多' });
      await expect(menu).toBeVisible();
      names.push(...(await menu.locator('.more-t').allInnerTexts()));
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    }
    return names.map((n) => n.trim());
  }
  await page.getByRole('button', { name: '菜单' }).click();
  const menu = page.getByRole('menu', { name: '菜单' });
  await expect(menu).toBeVisible();
  const names = await menu.locator('a.row .row-t').allInnerTexts();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  return names;
}

/** 明暗：桌面顶栏的按钮在明 ↔ 暗之间切；手机在菜单卡片里选 */
async function setTheme(page: Page, isDesktop: boolean, mode: '浅色' | '深色') {
  if (isDesktop) {
    const dark = mode === '深色';
    if ((await page.locator('html').evaluate((h) => h.classList.contains('dark'))) !== dark) {
      await page.locator('header .tools .ibtn').click();
    }
    await expect(page.locator('html')).toHaveClass(dark ? /(^|\s)dark(\s|$)/ : /(^|\s)light(\s|$)/);
  } else {
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('group', { name: '切换明暗模式' }).getByRole('button', { name: mode }).click();
    await page.keyboard.press('Escape');
  }
}

test('signed out: the dashboard sends you to sign in and comes back', async ({ page }, info) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?redirect=%2F$/);
  await ready(page, '登录');
  await shot(page, info, 'login-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await shot(page, info, 'login-dark');
});

test('navigation: order, current page, client-side switches', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await page.goto('/');
  await ready(page, '仪表盘');
  expect(await navNames(page, desktop(info.project.name))).toEqual(NAV);
  await setTheme(page, desktop(info.project.name), '浅色');
  await shot(page, info, 'dashboard-light');

  if (desktop(info.project.name)) {
    const nav = page.getByRole('navigation', { name: '主导航' });
    await expect(nav.getByRole('link', { name: /^仪表盘/ })).toHaveAttribute('aria-current', 'page');
    await nav.getByRole('link', { name: /^商店/ }).click();
    await expect(page).toHaveURL(/\/shop$/);
    await expect(page.locator('main h1')).toHaveText('商店');
    await expect(nav.getByRole('link', { name: /^商店/ })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: /^仪表盘/ })).not.toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(page.locator('main h1')).toHaveText('仪表盘');
  } else {
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('menu', { name: '菜单' }).getByRole('menuitem', { name: /^节点状态/ }).click();
    await expect(page).toHaveURL(/\/nodes$/);
    await expect(page.locator('main h1')).toHaveText('节点状态');
    await expect(page.getByRole('menu', { name: '菜单' })).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/menu-open/);
  }
  await expect(page).toHaveTitle(/ · /);
});

test('user menu (desktop): items, keyboard, Esc and focus return', async ({ page }, info) => {
  test.skip(!desktop(info.project.name), 'desktop only (the phone has the two-line menu)');
  await signIn(page, 'user@e2e.test');
  await page.goto('/');
  await ready(page, '仪表盘');
  const button = page.locator('header .acct');
  await expect(button).toHaveText(/user/);
  await button.click();
  const menu = page.getByRole('menu', { name: '账户菜单' });
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveText([/续费/, /我的订单/, /设置/, /退出登录/]);
  /* 抬头：剩余流量 · 剩余天数、套餐、邮箱；顶边那根线 */
  await expect(menu.locator('.acc-l1')).toContainText('GB 剩余');
  await expect(menu.locator('.acc-l2').last()).toHaveText('user@e2e.test');
  await expect(menu.locator('.card-line')).toBeAttached();
  await shot(page, info, 'user-menu-light');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();

  /* 键盘：↓ 打开并聚焦第一项，↑ 回绕到最后一项，Home 回第一项，Esc 关闭 */
  await page.keyboard.press('ArrowDown');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/orders$/);
  await expect(menu).toHaveCount(0);

  /* 点外面关闭 */
  await button.click();
  await expect(menu).toBeVisible();
  await page.locator('main').click();
  await expect(menu).toHaveCount(0);

  await setTheme(page, true, '深色');
  await button.click();
  await expect(menu).toBeVisible();
  await shot(page, info, 'user-menu-dark');
});

test('more menu (desktop): numbered directory, current item, Esc', async ({ page }, info) => {
  test.skip(!desktop(info.project.name), 'desktop only');
  await signIn(page, 'user@e2e.test');
  await page.goto('/orders');
  await ready(page);
  const nav = page.getByRole('navigation', { name: '主导航' });
  const more = nav.getByRole('button', { name: '更多' });
  /* 当前页在「更多」里：触发按钮变蓝（data-active），顶栏五项都不是当前项 */
  await expect(more).toHaveAttribute('data-active', 'true');
  await expect(nav.locator('a[aria-current="page"]')).toHaveCount(0);
  await more.click();
  const menu = page.getByRole('menu', { name: '更多' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('.more-head')).toContainText('05 – 09');
  await expect(menu.locator('.more-no')).toHaveText(['05', '06', '07', '08', '09']);
  await expect(menu.getByRole('menuitem', { name: /^08\s*我的订单/ })).toHaveAttribute('aria-current', 'page');
  await shot(page, info, 'more-menu-light');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/nodes$/);
  await expect(menu).toHaveCount(0);
});

test('mobile menu: card, keyboard, Esc, scroll lock', async ({ page }, info) => {
  test.skip(desktop(info.project.name), 'phone only');
  await signIn(page, 'user@e2e.test');
  await page.goto('/');
  await ready(page, '仪表盘');
  const toggle = page.getByRole('button', { name: '菜单' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const menu = page.getByRole('menu', { name: '菜单' });
  await expect(menu).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('html')).toHaveClass(/menu-open/);
  await expect(menu.locator('.acc-l2').last()).toHaveText('user@e2e.test');
  await expect(menu.getByRole('menuitem', { name: /^仪表盘/ })).toHaveAttribute('aria-current', 'page');
  await expect(menu.locator('a.row .row-t')).toHaveText(NAV);
  await shot(page, info, 'menu-light');

  /* 点开（指针）：焦点在菜单容器上，第一项不画焦点环；↓ 才到第一项 */
  await expect(menu).toBeFocused();
  expect(await menu.getByRole('menuitem').first().evaluate((el) => el.matches(':focus-visible'))).toBe(false);
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  /* ↑ 回绕到最后一项（退出登录），Tab 收起菜单 */
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: /^退出登录/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(page.locator('html')).not.toHaveClass(/menu-open/);

  /* 键盘打开（回车）：焦点直接在第一项上，带焦点环 */
  await page.keyboard.press('Enter');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  expect(await menu.getByRole('menuitem').first().evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);

  await setTheme(page, false, '深色');
  await page.getByRole('button', { name: '菜单' }).click();
  await shot(page, info, 'menu-dark');
});

test('theme: dark sticks across a reload; screenshots in dark', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await page.goto('/');
  await ready(page, '仪表盘');
  await setTheme(page, desktop(info.project.name), '深色');
  await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  await page.reload();
  await ready(page, '仪表盘');
  await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
  await shot(page, info, 'dashboard-dark');
  await setTheme(page, desktop(info.project.name), '浅色');
  await expect(page.locator('html')).toHaveClass(/(^|\s)light(\s|$)/);
});

test('language: English labels and <html lang>, then back', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await page.goto('/');
  await ready(page, '仪表盘');
  if (desktop(info.project.name)) {
    await page.getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('main h1')).toHaveText('Dashboard');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Store/ })).toBeVisible();
    await page.reload();
    await ready(page, 'Dashboard');
    await page.getByRole('button', { name: 'Switch to Chinese' }).click();
  } else {
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('main h1')).toHaveText('Dashboard');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('menu', { name: 'Menu' }).getByRole('menuitem', { name: /^Store/ })).toBeVisible();
    await page.getByRole('button', { name: '中文' }).click();
  }
  await expect(page.locator('main h1')).toHaveText('仪表盘');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

test('scopes: renewal and banned accounts see only their pages', async ({ page }, info) => {
  const isDesktop = desktop(info.project.name);
  await signIn(page, 'expired@e2e.test');
  await page.goto('/');
  await ready(page, '仪表盘');
  const renewal = await navNames(page, isDesktop);
  expect(renewal).not.toContain('节点状态');
  expect(renewal).not.toContain('使用明细');
  expect(renewal).toContain('商店');
  /* 续费范围没有邀请，同一项叫「钱包」 */
  expect(renewal).toContain('钱包');
  expect(renewal).not.toContain('邀请');
  await page.goto('/nodes');
  await expect(page).toHaveURL(/\/$/);
  await ready(page, '仪表盘');

  await page.context().clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await signIn(page, 'banned@e2e.test');
  await page.goto('/');
  /* 封禁账户的仪表盘就是封禁说明（dashboard.spec.ts 详测） */
  await ready(page, '账户已被封禁');
  expect(await navNames(page, isDesktop)).toEqual(['仪表盘', '工单']);
  await page.goto('/shop');
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/tickets');
  await ready(page, '工单');
  if (isDesktop) {
    await page.locator('header .acct').click();
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([/退出登录/]);
  }
});

test('old and unknown addresses', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await page.goto('/invite');
  await expect(page).toHaveURL(/\/wallet\?tab=invite$/);
  await ready(page, '邀请');
  /* 面板只对门户的顶层路径返回页面（其余是统一的拒绝），所以 404 页只会在站内跳转时出现 */
  await page.evaluate(() => {
    history.pushState({}, '', '/wallet/no-such-page');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.locator('main h1')).toHaveText('这片海图上没有这一页');
  await expect(page).toHaveTitle(/这片海图上没有这一页/);
});

test('sign out ends the session', async ({ page }, info) => {
  await signIn(page, mine(info, 'logout'));
  await page.goto('/orders');
  await ready(page, '我的订单');
  if (desktop(info.project.name)) {
    await page.locator('header .acct').click();
    await page.getByRole('menuitem', { name: /^退出登录/ }).click();
  } else {
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('menu', { name: '菜单' }).getByRole('menuitem', { name: /^退出登录/ }).click();
  }
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/login\?redirect=%2Forders$/);
});

test('the portal\'s edges: unknown paths are the canonical rejection, the portal never calls the console', async ({ page }) => {
  const prefix = new URL(process.env.E2E_ADMIN_BASE ?? '').pathname;
  const calls: string[] = [];
  page.on('request', (r) => calls.push(new URL(r.url()).pathname));
  await signIn(page, 'user@e2e.test');
  for (const p of ['/', '/shop', '/orders', '/wallet', '/invite', '/nodes', '/traffic', '/tickets', '/help', '/announcements', '/account']) {
    await page.goto(p);
    await ready(page);
  }
  expect(calls.filter((c) => c.startsWith(prefix) || c.startsWith('/admin'))).toEqual([]);
  for (const p of ['/admin', '/app', '/dashboard', '/faq', '/nope']) {
    const r = await page.goto(p);
    expect(r?.status(), p).toBe(404);
    expect(await r?.body(), p).toHaveLength(0);
  }
});

test('#17 a panel error on /me does not send a signed-in user to the login page', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  /* 新标签页（没有 sessionStorage 缓存）打开时 /me 出错：说清楚、给「重试」，不送去登录页 */
  const tab = await page.context().newPage();
  await tab.route(/\/api\/v1\/me$/, (r) => r.fulfill({ status: 502, body: '' }));
  await tab.goto('/');
  await expect(tab.getByRole('heading', { name: '这一块没能加载出来' })).toBeVisible();
  expect(new URL(tab.url()).pathname).toBe('/');
  await tab.unroute(/\/api\/v1\/me$/);
  await tab.getByRole('button', { name: '重试' }).click();
  await expect(tab.locator('main h1')).toHaveText('仪表盘');
  await tab.close();
});

test('#15 branding: footer text and links, an external terms link', async ({ page }) => {
  const a = await admin();
  const before = await a.patch('branding', FIELDS.branding, {
    footer_text: 'E2E 页脚文字', footer_links: [{ label: 'E2E 状态页', url: 'https://status.example.com' }],
    tos_url: 'https://example.com/tos',
  });
  try {
    await signIn(page, 'user@e2e.test');
    await page.goto('/');
    await ready(page, '仪表盘');
    const footer = page.locator('footer.site');
    await expect(footer.getByText('E2E 页脚文字')).toBeVisible();
    await expect(footer.getByRole('link', { name: 'E2E 状态页' })).toHaveAttribute('href', 'https://status.example.com');
    await expect(footer.getByRole('link', { name: '服务条款' })).toHaveAttribute('href', 'https://example.com/tos');
    await expect(footer.getByRole('link', { name: '隐私政策' })).toHaveAttribute('href', '/privacy');
  } finally {
    await a.patch('branding', FIELDS.branding, before);
  }
});
