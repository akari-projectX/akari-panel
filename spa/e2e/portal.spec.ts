import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/*
 * 门户端到端：真实面板（scripts/e2e-local.sh）+ e2e/seed.mjs 灌的数据。
 * 每个用例都检查页面没有 CSP 违规（面板的 CSP 是 default-src 'self'）。
 */

const seed = JSON.parse(readFileSync(process.env.E2E_SEED ?? '.e2e/seed.json', 'utf8')) as {
  mock: string; password: string; plan: string; premium: string; admin: string; adminPassword: string;
};
const BASE = process.env.E2E_BASE ?? '';
const go = (page: Page, path = '') => page.goto(`${BASE}${path}`);

const csp: string[] = [];
test.beforeEach(({ page }) => {
  csp.length = 0;
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
});
test.afterEach(() => expect(csp).toEqual([]));

async function login(page: Page, email: string, password = seed.password) {
  await go(page, '/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

/** 登录成功：离开登录页 */
async function signIn(page: Page, email: string, password = seed.password) {
  await login(page, email, password);
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
}

/** 手机上导航收在菜单里：直接改地址 */
async function open(page: Page, path: string) {
  await go(page, path);
}

test('registration with the proof of work, then sign out of every device', async ({ page }) => {
  const email = `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.test`;
  await go(page, '/register');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`${BASE}/?$`));
  /* 没有套餐：订阅区给「去选套餐」，不给一个用不了的链接 */
  await expect(page.getByText('还没有可用的订阅')).toBeVisible();
  await expect(page.getByRole('button', { name: '复制订阅链接' })).toHaveCount(0);
});

test('wrong password gets the uniform answer; the right one opens the dashboard with the plan', async ({ page }) => {
  await login(page, 'user@e2e.test', 'not-the-password');
  await expect(page.getByText('邮箱或密码错误')).toBeVisible();
  await signIn(page, 'user@e2e.test');
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  await expect(page.getByText('E2E 维护通知').first()).toBeVisible();
  /* 过渡期（prefixed）没有主域名时按令牌拼订阅地址：复制按钮在 */
  await expect(page.getByRole('button', { name: '复制订阅链接' })).toBeVisible();
});

test('shop: a balance-covered reset pack is paid at once; an Alipay switch is paid by QR', async ({ page }, info) => {
  await signIn(page, `shop-${info.project.name}@e2e.test`);
  await open(page, '/shop');
  await expect(page.getByText(seed.premium).first()).toBeVisible();

  /* 流量重置包，余额全额抵扣：面板当场付清 */
  await page.getByRole('switch', { name: '用余额抵扣' }).click();
  await page.getByRole('button', { name: '购买', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('余额抵扣')).toBeVisible();
  await page.getByRole('button', { name: '确认开通' }).click();
  await expect(page.getByRole('heading', { name: '订单详情' })).toBeVisible();
  await expect(page.getByText('已付款').first()).toBeVisible();
  await open(page, '/wallet');
  await expect(page.getByText('订单支付').locator('visible=true').first()).toBeVisible();

  /* 换到高级套餐，用支付宝付：订单页显示二维码，模拟网关标记已付款后页面自己变成已付款 */
  await open(page, '/shop');
  await expect(page.getByText(seed.premium).first()).toBeVisible();
  await page.getByRole('button', { name: '更换到此套餐' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^支付 ¥/ }).click();
  await expect(page.getByRole('heading', { name: '订单详情' })).toBeVisible();
  await expect(page.getByText(/扫码支付|支付宝付款/).first()).toBeVisible();
  const otn = (await page.locator('code').first().textContent())?.trim() ?? '';
  expect(otn).not.toBe('');
  const r = await fetch(`${seed.mock}/control/pay?otn=${otn}`, { method: 'POST' });
  expect(r.ok).toBe(true);
  await expect(page.getByText('已付款').first()).toBeVisible({ timeout: 30_000 });
  await open(page, '/orders');
  await expect(page.getByText(seed.premium).locator('visible=true').first()).toBeVisible();
});

test('coupon refusals are explained in the UI language', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/shop');
  await page.getByLabel('优惠码').fill('NOPE');
  await page.getByRole('button', { name: '使用', exact: true }).click();
  await expect(page.getByText('优惠码无效').first()).toBeVisible();
});

test('tickets: open, read, reply, close', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/tickets');
  await page.getByRole('button', { name: '提交工单' }).first().click();
  const subject = `E2E 工单 ${Date.now()}`;
  await page.getByLabel('问题标题').fill(subject);
  await page.getByLabel('详细描述').fill('节点连不上，请帮忙看看。');
  await page.getByRole('dialog').getByRole('button', { name: '提交工单' }).click();
  await expect(page.getByRole('dialog').getByText('节点连不上，请帮忙看看。')).toBeVisible();
  await page.getByLabel('回复此工单…').fill('补充：只有晚上不行。');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('补充：只有晚上不行。')).toBeVisible();
  await page.getByRole('button', { name: '问题已解决，关闭工单' }).click();
  await expect(page.getByText('工单已关闭').first()).toBeVisible();
});

test('account: language switch reaches the server errors too', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/account');
  await page.getByRole('combobox', { name: '界面语言' }).click();
  await page.getByRole('option', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  /* 邮件服务没配：面板答 account.mail_off，门户显示英文文案而不是英文原文 */
  await page.getByLabel('Email address').fill('other@e2e.test');
  await page.getByLabel('Current password').first().fill(seed.password);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText(/Email is not available|Something went wrong|Not found/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Language' }).click();
  await page.getByRole('option', { name: '简体中文' }).click();
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
});

test('expired accounts get the renewal scope', async ({ page }) => {
  await signIn(page, 'expired@e2e.test');
  await expect(page.getByText('套餐已到期，服务已暂停')).toBeVisible();
  await expect(page.getByText('订阅已暂停')).toBeVisible();
  await open(page, '/nodes');
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  await open(page, '/shop');
  await expect(page.getByRole('heading', { name: '商店' })).toBeVisible();
});

test('banned accounts see the reason and tickets only', async ({ page }) => {
  await signIn(page, 'banned@e2e.test');
  await expect(page.getByRole('heading', { name: '账户已被封禁' })).toBeVisible();
  await expect(page.getByText('E2E：违反服务条款')).toBeVisible();
  await open(page, '/shop');
  await expect(page.getByRole('heading', { name: '账户已被封禁' })).toBeVisible();
  await open(page, '/tickets');
  await expect(page.getByRole('heading', { name: '工单', exact: true })).toBeVisible();
});

test('admins are told to use the admin address, without a link to it', async ({ page }) => {
  await signIn(page, seed.admin, seed.adminPassword);
  await expect(page.getByRole('heading', { name: '管理员账户' })).toBeVisible();
  expect(await page.locator('a[href*="/admin"]').count()).toBe(0);
});

test('a bad reset link is refused with the mapped message', async ({ page }) => {
  await go(page, '/reset#token=not-a-real-token');
  /* 令牌读完就从地址栏抹掉 */
  await expect(page).not.toHaveURL(/token=/);
  await page.getByLabel('新密码', { exact: true }).fill('another-password-1');
  await page.getByLabel('确认新密码').fill('another-password-1');
  await page.getByRole('button', { name: '重置密码' }).click();
  await expect(page.getByText(/链接无效或已过期|内容不存在|操作失败/)).toBeVisible();
});

test('knowledge base and announcements render the panel\'s HTML', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/help');
  await page.getByText('E2E 第一篇').first().click();
  await expect(page.getByRole('heading', { name: '安装' })).toBeVisible();
  await open(page, '/announcements');
  await page.getByRole('button', { name: '阅读全文' }).click();
  await expect(page.getByRole('dialog').locator('strong', { hasText: '维护' })).toBeVisible();
});
