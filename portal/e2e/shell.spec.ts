/*
 * 门户 v2 · PR 1：外壳。门禁、导航（桌面顶栏 / 邮箱下拉 / 窄屏菜单）、明暗、语言、账户范围、旧地址、退出，
 * 以及设计评审截图（桌面 1440 / 手机 390 × 浅 / 深）。
 * 账户来自 spa/e2e/seed.ts：user@e2e.test（正常）、expired@e2e.test（续费范围）、banned@e2e.test（封禁）；
 * 退出用 logout-<视口>@e2e.test——user@e2e.test 永远不退出（退出会结束这个账户的所有会话）。
 */
import type { Page } from '@playwright/test';
import { expect, mine, ready, shot, signIn, test } from './fixtures';

const NAV = ['仪表盘', '商店', '线路', '用量', '公告', '文档', '工单'];

const desktop = (name: string) => name === 'desktop';

/** 链接自己的文字（不含右侧提示 <em> 与读屏用的 .sr） */
const ownText = (els: Element[]) =>
  els.map((e) => [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim());

/** 某个视口下可见的导航链接名（桌面 = 顶栏；手机 = 打开菜单后的全部条目） */
async function navNames(page: Page, isDesktop: boolean): Promise<string[]> {
  if (isDesktop) {
    return page.getByRole('navigation', { name: '主导航' }).getByRole('link').evaluateAll(ownText);
  }
  await page.getByRole('button', { name: '菜单' }).click();
  const sheet = page.getByRole('dialog', { name: '菜单' });
  await expect(sheet).toBeVisible();
  const names = await sheet.locator('a.it').evaluateAll(ownText);
  await page.keyboard.press('Escape');
  return names;
}

async function setTheme(page: Page, isDesktop: boolean, mode: '浅色' | '深色') {
  if (isDesktop) {
    /* 顶栏按钮循环：浅色 → 深色 → 跟随系统 */
    const btn = page.locator('header .tools button.iconbtn').first();
    for (let i = 0; i < 3; i++) {
      if ((await btn.getAttribute('title')) === mode) return;
      await btn.click();
    }
    await expect(btn).toHaveAttribute('title', mode);
  } else {
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('group', { name: '主题' }).getByRole('button', { name: mode }).click();
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
  expect(await navNames(page, desktop(info.project.name))).toEqual([...NAV, '订单', '钱包', '邀请', '账户设置'].slice(0, desktop(info.project.name) ? 7 : 11));
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
    await page.getByRole('dialog', { name: '菜单' }).getByRole('link', { name: /^线路/ }).click();
    await expect(page).toHaveURL(/\/nodes$/);
    await expect(page.locator('main h1')).toHaveText('节点状态');
    await expect(page.getByRole('dialog', { name: '菜单' })).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/menu-open/);
  }
  await expect(page).toHaveTitle(/ · /);
});

test('user menu (desktop): items, keyboard, Esc and focus return', async ({ page }, info) => {
  test.skip(!desktop(info.project.name), 'desktop only (the phone has the full-screen menu)');
  await signIn(page, 'user@e2e.test');
  await page.goto('/');
  await ready(page, '仪表盘');
  const button = page.locator('header button[aria-haspopup="menu"]');
  await expect(button).toHaveText(/user@e2e\.test/);
  await button.click();
  const menu = page.getByRole('menu', { name: '账户菜单' });
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveText([/^订单/, /^钱包/, /^邀请/, /^账户设置/, '退出登录']);
  /* 余额在打开时取：抬头出现「余额 ¥…」 */
  await expect(menu.locator('.who')).toContainText('余额 ¥');
  await shot(page, info, 'user-menu-light');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();

  /* 键盘：↓ 打开并聚焦第一项，↑ 回绕到最后一项，Esc 关闭 */
  await page.keyboard.press('ArrowDown');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
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

test('mobile menu: groups, focus trap, Esc, scroll lock', async ({ page }, info) => {
  test.skip(desktop(info.project.name), 'phone only');
  await signIn(page, 'user@e2e.test');
  await page.goto('/');
  await ready(page, '仪表盘');
  const toggle = page.getByRole('button', { name: '菜单' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const sheet = page.getByRole('dialog', { name: '菜单' });
  await expect(sheet).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/menu-open/);
  await expect(sheet.getByRole('heading')).toHaveText(['服务', '账户', '偏好']);
  await expect(sheet.locator('.who')).toContainText('user@e2e.test');
  await expect(sheet.getByRole('link', { name: /^仪表盘/ })).toHaveAttribute('aria-current', 'page');
  const close = page.getByRole('button', { name: '关闭' });
  await expect(close).toHaveAttribute('aria-expanded', 'true');
  await shot(page, info, 'menu-light');

  /* 点开（指针）：焦点在菜单容器上，第一项不画焦点环；Tab 从第一项开始 */
  await expect(sheet).toBeFocused();
  expect(await sheet.getByRole('link').first().evaluate((el) => el.matches(':focus-visible'))).toBe(false);
  await page.keyboard.press('Tab');
  /* 焦点困在「关闭按钮 + 菜单」里：Shift+Tab 从第一项回到关闭按钮，再 Shift+Tab 到最后一项（退出登录） */
  await expect(sheet.getByRole('link').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(sheet.getByRole('button', { name: '退出登录' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: '菜单' })).toBeFocused();
  await expect(page.locator('html')).not.toHaveClass(/menu-open/);

  /* 键盘打开（回车）：焦点直接在第一项上，带焦点环 */
  await page.keyboard.press('Enter');
  await expect(sheet.getByRole('link').first()).toBeFocused();
  expect(await sheet.getByRole('link').first().evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

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
    await expect(page.getByRole('dialog', { name: 'Menu' }).getByRole('heading')).toHaveText(['Service', 'Account', 'Preferences']);
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
  expect(renewal).not.toContain('线路');
  expect(renewal).not.toContain('用量');
  expect(renewal).toContain('商店');
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
    await page.locator('header button[aria-haspopup="menu"]').click();
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['退出登录']);
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
    await page.locator('header button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: '退出登录' }).click();
  } else {
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('dialog', { name: '菜单' }).getByRole('button', { name: '退出登录' }).click();
  }
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/login\?redirect=%2Forders$/);
});
