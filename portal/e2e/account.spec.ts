/*
 * 门户 v2 · PR 6：设置页（账户、登录与安全、订阅链接、偏好、危险操作）。覆盖切换前 React 门户 account.spec.ts 的全部设置场景
 * （#17 #20–#23 验证 / 更换邮箱、改密码、邮件语言；分区锚点与旧 ?tab=security；明暗三档；站点没开发信；退出所有设备；
 * 读不出来的订阅链接的重置；#26 自助注销与它的阻止状态），通行密钥的管理在 auth.spec.ts 的 #3–#5 里（同一个账户接着做）。
 * #18 / #19 的账户范围在 dashboard.spec.ts / shell.spec.ts / shop.spec.ts。
 * 账户（e2e/support/seed.ts，每个视口一个）：v2-account-、v2-settings-、v2-unreadable-、v2-delete-；退出所有设备的账户在用例里建。
 */
import type { Page, TestInfo } from '@playwright/test';
import { Client, latestMail, psql } from './support/panel.ts';
import { admin, dark, expect, login, mine, ready, seed, shot, signIn, test } from './fixtures';

test.describe.configure({ mode: 'serial' });

const isDesktop = (info: TestInfo) => info.project.name === 'desktop';

async function settings(page: Page, path = '/account', title = '设置') {
  await page.goto(path);
  await ready(page, title);
  await expect(page.locator('main [aria-busy]')).toHaveCount(0, { timeout: 15_000 });
}

/** 去一页：桌面 = 顶栏导航 / 账户菜单；手机 = 菜单卡片里的链接（客户端切页） */
async function go(page: Page, info: TestInfo, name: '仪表盘' | '设置') {
  if (isDesktop(info) && name === '仪表盘') {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name }).click();
  } else if (isDesktop(info)) {
    await page.locator('header .acct').click();
    await page.getByRole('menu', { name: '账户菜单' }).getByRole('menuitem', { name: /^设置/ }).click();
  } else {
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('menu', { name: '菜单' }).getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
  }
}

test('page transition: a page whose chunk is still downloading never renders over the next one; what is typed at once is kept', async ({ page }, info) => {
  /* 仪表盘分包慢：切过去时还在下载，马上又切到设置——下载完的仪表盘不能盖住设置页，也不能把刚打开的弹窗冲掉 */
  let slow = 0;
  await page.route(/\/assets\/Dashboard-[^/]+\.js$/, async (r) => {
    slow++;
    await new Promise((ok) => setTimeout(ok, 3000));
    await r.continue();
  });
  const email = `transition-${info.project.name}-${Date.now()}@e2e.test`;
  await (await admin()).call('POST', '/api/v1/users', { email, password: seed.password });
  await signIn(page, email);
  await page.goto('/orders');
  await ready(page, '我的订单');
  await go(page, info, '仪表盘');
  await go(page, info, '设置');
  /* 不等仪表盘：马上打开「更换邮箱」并填 */
  await page.locator('#account').getByRole('button', { name: '更换', exact: true }).click();
  const change = page.getByRole('dialog', { name: '更换邮箱' });
  await change.getByLabel('新邮箱地址').fill(`next-${email}`);
  await page.waitForTimeout(3500);
  expect(slow).toBeGreaterThan(0);
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.locator('main h1')).toHaveText('设置');
  await expect(page.locator('main [aria-busy]')).toHaveCount(0);
  await expect(change.getByLabel('新邮箱地址')).toHaveValue(`next-${email}`);
});

test('#17 #21 #20 #22 #23 settings: verify the address, change it in two steps, change the password, mail language follows an explicit switch only', async ({ page }, info) => {
  const email = mine(info, 'v2-account');
  psql(`UPDATE users SET email_verified_at = NULL WHERE email = '${email}';`);
  await signIn(page, email);
  await settings(page);
  const account = page.locator('#account');
  await expect(account.getByText('未验证')).toBeVisible();
  /* 验证：弹窗第一步只有「发送验证码」 */
  await account.getByRole('button', { name: '验证', exact: true }).click();
  const verify = page.getByRole('dialog', { name: '验证邮箱' });
  await expect(verify.getByText(email)).toBeVisible();
  await expect(verify.getByLabel('邮箱验证码')).toHaveCount(0);
  let sent = Date.now() - 1000;
  await verify.getByRole('button', { name: '发送验证码' }).click();
  await expect(verify.getByRole('button', { name: /秒后重发/ })).toBeDisabled();
  await verify.getByRole('button', { name: '完成验证' }).click();
  await expect(verify.getByText('请输入 6 位数字验证码')).toBeVisible();
  await expect(verify.getByLabel('邮箱验证码')).toBeFocused();
  let code = /\b(\d{6})\b/.exec(await latestMail(email, sent))?.[1] ?? '';
  await verify.getByLabel('邮箱验证码').fill(code);
  await verify.getByRole('button', { name: '完成验证' }).click();
  await expect(verify).toHaveCount(0);
  await expect(account.getByText('已验证')).toBeVisible();
  await expect(account.getByRole('button', { name: '验证', exact: true })).toHaveCount(0);

  /* 更换 = 两步弹窗（新地址 + 当前密码 → 验证码） */
  await account.getByRole('button', { name: '更换', exact: true }).click();
  const change = page.getByRole('dialog', { name: '更换邮箱' });
  await expect(change.getByText('第 1 步，共 2 步')).toBeVisible();
  /* 空着提交：两个字段都给内联错误，聚焦第一个 */
  await change.getByRole('button', { name: '发送验证码' }).click();
  await expect(change.getByText('请输入新邮箱地址')).toBeVisible();
  await expect(change.getByText('请输入当前密码')).toBeVisible();
  await expect(change.getByLabel('新邮箱地址')).toBeFocused();
  await expect(change.getByLabel('新邮箱地址')).toHaveAttribute('aria-invalid', 'true');
  /* 就是现在的地址：内联说明 */
  await change.getByLabel('新邮箱地址').fill(email.toUpperCase());
  await change.getByLabel('当前密码').fill(seed.password);
  await change.getByRole('button', { name: '发送验证码' }).click();
  await expect(change.getByText('这就是你现在的邮箱')).toBeVisible();
  const next = `v2-moved-${Date.now()}-${info.project.name}@e2e.test`;
  await change.getByLabel('新邮箱地址').fill(next);
  /* 密码错误：面板的错误码画在密码框下面 */
  await change.getByLabel('当前密码').fill('not-the-password');
  await change.getByRole('button', { name: '发送验证码' }).click();
  await expect(change.getByText('当前密码不正确')).toBeVisible();
  await expect(change.getByLabel('当前密码')).toBeFocused();
  await change.getByLabel('当前密码').fill(seed.password);
  sent = Date.now() - 1000;
  await change.getByRole('button', { name: '发送验证码' }).click();
  await expect(change.getByText('第 2 步，共 2 步')).toBeVisible();
  await expect(change.getByText(next)).toBeVisible();
  await expect(change.getByRole('button', { name: /秒后重发/ })).toBeDisabled();
  await shot(page, info, 'account-change-email');
  code = /\b(\d{6})\b/.exec(await latestMail(next, sent))?.[1] ?? '';
  await change.getByLabel('邮箱验证码').fill(code);
  await change.getByRole('button', { name: '确认更换' }).click();
  await expect(change).toHaveCount(0);
  await expect(page.getByText('邮箱已更换').first()).toBeVisible();
  await expect(account.getByText(next)).toBeVisible();

  /* 改密码：两次不一致是内联错误（失焦时就比对）；其他会话结束，本会话保留 */
  await page.locator('#security').getByRole('button', { name: '修改', exact: true }).click();
  const pwd = page.getByRole('dialog', { name: '修改密码' });
  const pw = `changed-${seed.password}`;
  await pwd.getByLabel('当前密码').fill(seed.password);
  await pwd.getByLabel('新密码', { exact: true }).fill(pw);
  await pwd.getByLabel('确认新密码').fill(`${pw}-typo`);
  await pwd.getByLabel('当前密码').focus();
  await expect(pwd.getByText('两次输入的新密码不一致')).toBeVisible();
  await pwd.getByRole('button', { name: '更新密码' }).click();
  await expect(pwd.getByLabel('确认新密码')).toBeFocused();
  await pwd.getByLabel('确认新密码').fill(pw);
  await pwd.getByRole('button', { name: '更新密码' }).click();
  await expect(page.getByText('密码已更新').first()).toBeVisible();
  await expect(pwd).toHaveCount(0);
  await ready(page, '设置');

  /* 界面语言：主动切换时邮件语言跟过去；打开页面时不改 */
  const prefs = page.locator('#preferences');
  await prefs.getByRole('button', { name: 'EN', exact: true }).click();
  await ready(page, 'Settings');
  await expect.poll(() => psql(`SELECT locale FROM users WHERE email = '${next}';`)).toBe('en');
  psql(`UPDATE users SET locale = 'zh' WHERE email = '${next}';`);
  await page.reload();
  await ready(page, 'Settings');
  await page.waitForTimeout(1000);
  expect(psql(`SELECT locale FROM users WHERE email = '${next}';`)).toBe('zh');
  await prefs.getByRole('button', { name: '中', exact: true }).click();
  await ready(page, '设置');

  await page.context().clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await signIn(page, next, pw);
});

test('settings: one page with section anchors; screens', async ({ page }, info) => {
  await signIn(page, mine(info, 'v2-settings'));
  await settings(page, '/account');
  const nav = page.getByRole('navigation', { name: '设置分区' });
  for (const s of ['账户', '登录与安全', '订阅链接', '偏好', '危险操作']) {
    await expect(nav.getByRole('link', { name: s })).toBeVisible();
  }
  for (const id of ['account', 'security', 'subscription', 'preferences', 'danger']) {
    await expect(page.locator(`section#${id}`)).toHaveCount(1);
  }
  /* 手机上不出现横向滚动（分区导航自己横滑） */
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await nav.getByRole('link', { name: '危险操作' }).click();
  await expect(page).toHaveURL(/#danger$/);
  await expect(page.locator('#danger').getByRole('button', { name: '注销账户…' })).toBeInViewport();
  /* 套餐只有一行摘要，导入在仪表盘 */
  await expect(page.locator('#account').getByText(/E2E 标准 · .* 到期/)).toBeVisible();
  await expect(page.getByRole('button', { name: '复制订阅链接' })).toHaveCount(0);
  await expect(page.locator('#subscription').getByText('正常')).toBeVisible();
  await expect(page.locator('#subscription').getByRole('link', { name: '去导入' })).toHaveAttribute('href', '/#subscribe');
  await page.evaluate(() => scrollTo(0, 0));
  await shot(page, info, 'account-light');
  await dark(page);
  await shot(page, info, 'account-dark');
});

test('settings: light / dark / follow the system (the default)', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page, mine(info, 'v2-settings'));
  await settings(page, '/account#preferences');
  const html = page.locator('html');
  const theme = page.locator('#preferences').getByRole('group', { name: '切换明暗模式' });
  await expect(theme.getByRole('button', { name: '跟随系统' })).toHaveAttribute('aria-pressed', 'true');
  await expect(html).toHaveClass(/\bdark\b/);
  await theme.getByRole('button', { name: '浅色' }).click();
  await expect(html).not.toHaveClass(/\bdark\b/);
  await expect(theme.getByRole('button', { name: '浅色' })).toHaveAttribute('aria-pressed', 'true');
  await theme.getByRole('button', { name: '跟随系统' }).click();
  await expect(html).toHaveClass(/\bdark\b/);
  /* 跟随：系统一变就跟着变 */
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).not.toHaveClass(/\bdark\b/);
});

test('settings: with site mail off there is no "change email" or "verify"', async ({ page }, info) => {
  await page.route(/\/auth\/options$/, async (r) => {
    const res = await fetch(`${process.env.E2E_API}/auth/options`);
    await r.fulfill({ json: { ...(await res.json()), mail: false }, headers: { 'cache-control': 'no-store' } });
  });
  const email = mine(info, 'v2-settings');
  psql(`UPDATE users SET email_verified_at = NULL WHERE email = '${email}';`);
  try {
    await signIn(page, email);
    await settings(page);
    const account = page.locator('#account');
    await expect(account.getByText('站点没有开启邮件发送，暂时不能验证或更换邮箱。')).toBeVisible();
    await expect(account.getByText('未验证')).toBeVisible();
    await expect(account.getByRole('button', { name: '更换', exact: true })).toHaveCount(0);
    await expect(account.getByRole('button', { name: '验证', exact: true })).toHaveCount(0);
  } finally {
    psql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}';`);
  }
});

test('settings: sign out of every device from the security section', async ({ page, browser }, info) => {
  const email = `v2-everywhere-${info.project.name}-${Date.now()}@e2e.test`;
  await (await admin()).call('POST', '/api/v1/users', { email, password: seed.password });
  await signIn(page, email);
  const other = await browser.newContext();
  const elsewhere = await other.newPage();
  await signIn(elsewhere, email);
  await settings(page, '/account#security');
  await page.locator('#security').getByRole('button', { name: '全部退出' }).click();
  const confirm = page.getByRole('alertdialog', { name: '退出所有设备？' });
  await expect(confirm.getByText('订阅链接不受影响，客户端照常连接')).toBeVisible();
  await confirm.getByRole('button', { name: '全部退出' }).click();
  await expect(page).toHaveURL(/\/login/);
  await elsewhere.goto('/orders');
  await expect(elsewhere).toHaveURL(/\/login/);
  await other.close();
});

test('settings: an unreadable link (stored copy does not open) can still be reset from settings', async ({ page }, info) => {
  const email = mine(info, 'v2-unreadable');
  /* 先签发一次，再把密文换成打不开的内容（主密钥换过的站点就是这样） */
  await (await Client.user(email, seed.password)).call('GET', '/api/v1/me');
  psql(`UPDATE users SET sub_token_enc = '\\x01' WHERE email = '${email}';`);
  await signIn(page, email);
  await settings(page, '/account#subscription');
  const sub = page.locator('#subscription');
  await expect(sub.getByText('无法显示，重置后可查看')).toBeVisible();
  await expect(sub.getByRole('link', { name: '去导入' })).toHaveCount(0);
  await sub.getByRole('button', { name: '重置', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: '重置订阅？' });
  await expect(confirm.getByText('用于订阅链接泄露的情况。')).toBeVisible();
  await confirm.getByRole('button', { name: '确认重置' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText('订阅已重置').first()).toBeVisible();
  await expect(sub.getByText('正常')).toBeVisible();
  expect(psql(`SELECT sub_token_enc IS NOT NULL FROM users WHERE email = '${email}';`)).toBe('t');
});

test('#26 self-service deletion: the impact; pending orders block it; inline errors, then the account is gone', async ({ page }, info) => {
  const email = mine(info, 'v2-delete');
  /* 一笔待支付订单：面板拒绝注销，弹窗先说清楚 */
  const c = await Client.user(email, seed.password);
  const plans = await c.call<{ plans: { plan_id: string; name: string }[] }>('GET', '/api/v1/me/shop');
  const plan = plans.plans.find((p) => p.name === seed.plan)?.plan_id;
  const order = await c.call<{ id: string }>('POST', '/api/v1/me/orders', { plan_id: plan, period: 'month' });

  await signIn(page, email);
  await settings(page);
  await page.getByRole('button', { name: '注销账户…' }).click();
  const dialog = page.getByRole('dialog', { name: '注销账户' });
  await expect(dialog.getByText('注销后你将失去')).toBeVisible();
  /* 有订单（哪怕没付）就是财务记录：账户匿名化保留 */
  await expect(dialog.getByText('账户有付款记录：财务记录匿名保留，其余个人数据删除')).toBeVisible();
  /* 被阻止：说明要先处理什么、给去处的链接，没有注销按钮，只有「知道了」 */
  await expect(dialog.getByRole('alert').getByText(/待支付订单/)).toBeVisible();
  await expect(dialog.getByRole('link', { name: '去订单页' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '永久注销' })).toHaveCount(0);
  await shot(page, info, 'account-delete-blocked');

  await c.call('POST', `/api/v1/me/orders/${order.id}/cancel`);
  await dialog.getByRole('button', { name: '知道了' }).click();
  await expect(dialog).toHaveCount(0);
  expect(psql(`SELECT count(*) FROM users WHERE email = '${email}' AND erased_at IS NULL;`)).toBe('1');

  /* 再打开：重新取影响，不再被阻止 */
  await page.getByRole('button', { name: '注销账户…' }).click();
  await expect(dialog.getByText('注销后你将失去')).toBeVisible();
  await expect(dialog.getByRole('alert').getByText(/待支付订单/)).toHaveCount(0);
  /* 没勾「不可恢复」：内联提示，不提交 */
  await dialog.getByLabel('输入当前密码确认').fill('not-the-password');
  await dialog.getByRole('button', { name: '永久注销' }).click();
  await expect(dialog.getByText('请先勾选确认')).toBeVisible();
  await dialog.getByLabel('我已了解：注销后账户和上面这些内容都不可恢复').check();
  await expect(dialog.getByText('请先勾选确认')).toHaveCount(0);
  await shot(page, info, 'account-delete');
  /* 密码错误：面板拒绝（不是只有前端在拦），错误在密码框下面，弹窗留着 */
  await dialog.getByRole('button', { name: '永久注销' }).click();
  await expect(dialog.getByText('当前密码不正确')).toBeVisible();
  await expect(dialog.getByLabel('输入当前密码确认')).toBeFocused();
  expect(psql(`SELECT count(*) FROM users WHERE email = '${email}' AND erased_at IS NULL;`)).toBe('1');

  await dialog.getByLabel('输入当前密码确认').fill(seed.password);
  await dialog.getByRole('button', { name: '永久注销' }).click();
  /* 退出登录，结果页 */
  await expect(page).toHaveURL(/\/deleted$/);
  await expect(page.getByRole('heading', { name: '账户已注销' })).toBeVisible();
  await expect(page.getByText('付款与退款记录按法规匿名保留', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: '返回登录页' }).click();
  await login(page, email);
  await expect(page.getByText('邮箱或密码错误')).toBeVisible();
});

test('#18 banned: settings, docs and announcements send you back to the ban notice', async ({ page }) => {
  await signIn(page, 'banned@e2e.test');
  for (const path of ['/account', '/help', '/announcements']) {
    await page.goto(path);
    await ready(page, '账户已被封禁');
  }
});

test('#19 renewal scope: settings say the link comes back after renewal', async ({ page }, info) => {
  await signIn(page, 'expired@e2e.test');
  await settings(page, '/account#subscription');
  const sub = page.locator('#subscription');
  await expect(sub.getByText('续费后可用')).toBeVisible();
  await expect(sub.getByRole('link', { name: '去商店' })).toBeVisible();
  await expect(sub.getByRole('button', { name: '重置', exact: true })).toHaveCount(0);
  /* 续费范围没有「查看」（仪表盘不给套餐详情） */
  await expect(page.locator('#account').getByRole('link', { name: '查看' })).toHaveCount(0);
  if (!isDesktop(info)) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
