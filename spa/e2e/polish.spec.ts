/*
 * 门户逐页细节打磨（design/portal-polish-2026-10）的行为回归：手机上不横向滚动、表单的内联错误、
 * 仪表盘最大内容块原地渲染（LCP）、站点设置 / 账户接口出错时的说明。编号对应 research/portal-gap.md。
 */
import type { Page } from '@playwright/test';
import { admin, expect, mine, open, seed, signIn, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

/** 新建一个没有套餐的账户并登录（不碰共享的种子账户） */
async function freshUser(page: Page, info: { project: { name: string } }, tag: string) {
  const email = `${tag}-${info.project.name}-${Date.now()}@e2e.test`;
  await (await admin()).call('POST', '/api/v1/users', { email, password: seed.password });
  await signIn(page, email);
  return email;
}

const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('#60 phones: no page scrolls sideways (dashboard, usage, guest pages)', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'only narrow screens can overflow');
  for (const path of ['/forgot', '/reset', '/deleted', '/login']) {
    await open(page, path);
    await expect(page.locator('main h1, h1').first()).toBeVisible();
    expect(await noSideScroll(page), path).toBe(true);
  }
  await signIn(page, 'user@e2e.test');
  for (const path of ['/', '/traffic', '/wallet', '/invite', '/tickets', '/orders', '/nodes']) {
    await open(page, path);
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await noSideScroll(page), path).toBe(true);
  }
});

test('#60 dashboard: the stat row (largest content) renders in place, the other blocks keep their entrance', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await expect(page.locator('.statrow')).toBeVisible();
  await expect(page.locator('.statrow [data-enter]')).toHaveCount(0);
  await expect(page.locator('main [data-enter]').first()).toBeAttached();
});

test('#52 withdrawal form: inline errors, the first bad field is focused, nothing is sent', async ({ page }, info) => {
  await freshUser(page, info, 'polish-wd');
  /* 余额、提现记录、网络由桩给出：这条只测表单本身 */
  await page.route(/\/api\/v1\/me\/balance(\?|$)/, (r) => r.fulfill({ json: { balance_cents: 8000, withdrawable_cents: 5000, entries: [] } }));
  await page.route(/\/api\/v1\/me\/invite$/, async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...(await res.json()), usdt_chains: [{ id: 'trc20', name: 'TRC20 (Tron)' }], min_withdrawal_cents: 1000 } });
  });
  let posted = 0;
  await page.route(/\/api\/v1\/me\/withdrawals$/, (r) => {
    if (r.request().method() === 'POST') posted++;
    return r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.fulfill({ status: 500, json: {} });
  });
  await open(page, '/wallet');
  await page.getByRole('button', { name: '申请提现' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(dialog.getByText('请输入提现金额')).toBeVisible();
  await expect(dialog.getByText('请输入收款地址')).toBeVisible();
  await expect(dialog.getByLabel('提现金额（元）')).toBeFocused();
  await expect(dialog.getByLabel('提现金额（元）')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('提现金额（元）').fill('80');
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(dialog.getByText('超过了可提现金额（¥50）')).toBeVisible();
  await dialog.getByLabel('提现金额（元）').fill('5');
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(dialog.getByText('最低提现 ¥10')).toBeVisible();
  expect(posted).toBe(0);
});

test('#57 new ticket: inline errors instead of a greyed-out button', async ({ page }, info) => {
  await freshUser(page, info, 'polish-ticket');
  await open(page, '/tickets');
  await page.getByRole('button', { name: '提交工单' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '提交工单' }).click();
  await expect(dialog.getByText('请填写问题标题')).toBeVisible();
  await expect(dialog.getByText('请描述遇到的问题')).toBeVisible();
  await expect(dialog.getByLabel('问题标题')).toBeFocused();
  await dialog.getByLabel('问题标题').fill('x');
  await expect(dialog.getByText('请填写问题标题')).toHaveCount(0);
});

test('#1 site settings that fail to load are explained on the sign-in page', async ({ page }) => {
  await page.route(/\/auth\/options$/, (r) => r.fulfill({ status: 500, json: { error: 'x', code: 'request.internal' } }));
  await open(page, '/login');
  await expect(page.getByRole('alert').filter({ hasText: '站点设置没能加载' })).toBeVisible();
});

test('#17 a panel error on /me does not send a signed-in user to the login page', async ({ page }, info) => {
  await signIn(page, mine(info, 'settings'));
  /* 新标签页（没有 sessionStorage 缓存）打开时 /me 出错 */
  const tab = await page.context().newPage();
  await tab.route(/\/api\/v1\/me$/, (r) => r.fulfill({ status: 502, body: '' }));
  await tab.goto('/');
  await expect(tab.getByText('这一块没能加载出来')).toBeVisible();
  expect(new URL(tab.url()).pathname).toBe('/');
  await tab.unroute(/\/api\/v1\/me$/);
  await tab.getByRole('button', { name: '重试' }).click();
  await expect(tab.locator('main h1')).toHaveText('仪表盘');
  await tab.close();
});
