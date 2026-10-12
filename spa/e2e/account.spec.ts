/*
 * 账户（research/portal-gap.md §1.2 #17–#26，通行密钥 #24 #25 在 auth.spec.ts）与三种账户范围。
 */
import type { Page } from '@playwright/test';
import { Client, latestMail, psql } from './panel.ts';
import { admin, expect, login, mine, open, seed, signIn, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

test('page transition: the next page mounts once, after the old one has left; what is typed at once is kept', async ({ page }, info) => {
  const email = `transition-${info.project.name}-${Date.now()}@e2e.test`;
  await (await admin()).call('POST', '/api/v1/users', { email, password: seed.password });
  psql(`UPDATE users SET email_verified_at = NULL WHERE email = '${email}';`);
  /* 仪表盘分包慢：切到设置时旧页面还停在骨架屏——以前这时新页面会先在淡出的旧容器里渲染一遍 */
  await page.route(/\/assets\/dashboard-[^/]+\.js$/, async (r) => {
    await new Promise((ok) => setTimeout(ok, 1500));
    await r.continue();
  });
  await signIn(page, email);
  await expect(page.getByText('邮箱还没有验证')).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { leaked?: boolean };
    w.leaked = false;
    new MutationObserver(() => {
      if (document.querySelector('.page-out #account')) w.leaked = true;
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  /* 账户菜单里的「设置」：客户端切页 */
  await page.locator('header button[aria-haspopup="menu"]:visible').last().click();
  await page.getByRole('menuitem', { name: '设置' }).click();
  /* 不等切页动画：马上打开「更换邮箱」并填 */
  await page.locator('#account').getByRole('button', { name: '更换', exact: true }).click();
  await page.getByLabel('新邮箱地址').fill(email);
  await expect(page.locator('.page-out')).toHaveCount(0);
  await expect(page.getByLabel('新邮箱地址')).toHaveValue(email);
  expect(await page.evaluate(() => (window as unknown as { leaked?: boolean }).leaked)).toBe(false);
});

test('#17 #21 #20 #22 #23 account: verify the address in a dialog, change it in two steps, change the password, mail language follows an explicit switch only', async ({ page }, info) => {
  const email = mine(info, 'account');
  psql(`UPDATE users SET email_verified_at = NULL WHERE email = '${email}';`);
  await signIn(page, email);
  /* 未验证：仪表盘提醒条「去验证」就在当前页弹出验证码弹窗；第一步只有「发送验证码」 */
  await expect(page.getByText('邮箱还没有验证')).toBeVisible();
  await page.getByRole('button', { name: '去验证' }).click();
  const dialog = page.getByRole('dialog', { name: '验证邮箱' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(email)).toBeVisible();
  await expect(dialog.getByLabel('邮箱验证码')).toHaveCount(0);
  let sent = Date.now() - 1000;
  await dialog.getByRole('button', { name: '发送验证码' }).click();
  /* 重发有倒计时 */
  await expect(dialog.getByRole('button', { name: /秒后重发/ })).toBeDisabled();
  /* 填错的格式：内联错误 + 聚焦，不弹浏览器气泡 */
  await dialog.getByRole('button', { name: '完成验证' }).click();
  await expect(dialog.getByText('请输入 6 位数字验证码')).toBeVisible();
  await expect(dialog.getByLabel('邮箱验证码')).toBeFocused();
  let code = /\b(\d{6})\b/.exec(await latestMail(email, sent))?.[1] ?? '';
  await dialog.getByLabel('邮箱验证码').fill(code);
  await dialog.getByRole('button', { name: '完成验证' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('邮箱还没有验证')).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);

  /* 设置页：邮箱一行「已验证」+「更换」；更换 = 两步弹窗（新地址 + 当前密码 → 验证码） */
  await open(page, '/account');
  const account = page.locator('#account');
  await expect(account.getByText('已验证')).toBeVisible();
  await expect(account.getByRole('button', { name: '验证', exact: true })).toHaveCount(0);
  await account.getByRole('button', { name: '更换', exact: true }).click();
  const change = page.getByRole('dialog', { name: '更换邮箱' });
  await expect(change.getByText('第 1 步，共 2 步')).toBeVisible();
  /* 空着提交：两个字段都给内联错误，聚焦第一个 */
  await change.getByRole('button', { name: '发送验证码' }).click();
  await expect(change.getByText('请输入新邮箱地址')).toBeVisible();
  await expect(change.getByText('请输入当前密码')).toBeVisible();
  await expect(change.getByLabel('新邮箱地址')).toBeFocused();
  await expect(change.getByLabel('新邮箱地址')).toHaveAttribute('aria-invalid', 'true');
  const next = `moved-${Date.now()}-${info.project.name}@e2e.test`;
  await change.getByLabel('新邮箱地址').fill(next);
  /* 密码错误：面板的错误码画在密码框下面 */
  await change.getByLabel('当前密码').fill('not-the-password');
  await change.getByRole('button', { name: '发送验证码' }).click();
  await expect(change.getByText('当前密码不正确')).toBeVisible();
  await change.getByLabel('当前密码').fill(seed.password);
  sent = Date.now() - 1000;
  await change.getByRole('button', { name: '发送验证码' }).click();
  await expect(change.getByText('第 2 步，共 2 步')).toBeVisible();
  await expect(change.getByText(next)).toBeVisible();
  await expect(change.getByRole('button', { name: /秒后重发/ })).toBeDisabled();
  code = /\b(\d{6})\b/.exec(await latestMail(next, sent))?.[1] ?? '';
  await change.getByLabel('邮箱验证码').fill(code);
  await change.getByRole('button', { name: '确认更换' }).click();
  await expect(change).toHaveCount(0);
  await expect(account.getByText(next)).toBeVisible();

  /* 改密码（登录与安全 → 修改）：两次不一致是内联错误；其他会话结束，本会话保留 */
  await page.locator('#security').getByRole('button', { name: '修改', exact: true }).click();
  const pwdDialog = page.getByRole('dialog', { name: '修改密码' });
  const pw = `changed-${seed.password}`;
  await pwdDialog.getByLabel('当前密码').fill(seed.password);
  await pwdDialog.getByLabel('新密码', { exact: true }).fill(pw);
  await pwdDialog.getByLabel('确认新密码').fill(`${pw}-typo`);
  await pwdDialog.getByRole('button', { name: '更新密码' }).click();
  await expect(pwdDialog.getByText('两次输入的新密码不一致')).toBeVisible();
  await expect(pwdDialog.getByLabel('确认新密码')).toBeFocused();
  await pwdDialog.getByLabel('确认新密码').fill(pw);
  await pwdDialog.getByRole('button', { name: '更新密码' }).click();
  await expect(page.getByText('密码已更新').first()).toBeVisible();
  await expect(pwdDialog).toHaveCount(0);

  /* 界面语言：主动切换时邮件语言跟过去；打开页面时不改（另一台设备上的语言偏好不会悄悄改掉邮件语言） */
  const prefs = page.locator('#preferences');
  await prefs.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect.poll(() => psql(`SELECT locale FROM users WHERE email = '${next}';`)).toBe('en');
  psql(`UPDATE users SET locale = 'zh' WHERE email = '${next}';`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.waitForTimeout(1000);
  expect(psql(`SELECT locale FROM users WHERE email = '${next}';`)).toBe('zh');
  await prefs.getByRole('button', { name: '中', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, next, pw);
});

test('settings: one page with section anchors; the old ?tab=security link lands on #security', async ({ page }, info) => {
  await signIn(page, mine(info, 'settings'));
  await open(page, '/account?tab=security');
  await expect(page).toHaveURL(/\/account#security$/);
  const nav = page.getByRole('navigation', { name: '设置分区' });
  for (const s of ['账户', '登录与安全', '订阅链接', '偏好', '危险操作']) {
    await expect(nav.getByRole('link', { name: s })).toBeVisible();
  }
  /* 页签没了：五个分区都在同一页 */
  for (const id of ['account', 'security', 'subscription', 'preferences', 'danger']) {
    await expect(page.locator(`section#${id}`)).toHaveCount(1);
  }
  await nav.getByRole('link', { name: '危险操作' }).click();
  await expect(page).toHaveURL(/#danger$/);
  await expect(page.locator('#danger').getByRole('button', { name: '注销账户…' })).toBeInViewport();
  /* 套餐只有一行摘要，导入在仪表盘 */
  await expect(page.locator('#account').getByText(/E2E 标准 · .* 到期/)).toBeVisible();
  await expect(page.getByRole('button', { name: '复制订阅链接' })).toHaveCount(0);
  await expect(page.locator('#subscription').getByText('正常')).toBeVisible();
  await info.attach('settings', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});

test('settings: light / dark / follow the system (the default)', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page, mine(info, 'settings'));
  await open(page, '/account#preferences');
  const html = page.locator('html');
  const theme = page.locator('#preferences').getByRole('group', { name: '切换明暗模式' });
  await expect(theme.getByRole('button', { name: '跟随系统' })).toHaveAttribute('aria-pressed', 'true');
  await expect(html).toHaveClass(/\bdark\b/);
  await theme.getByRole('button', { name: '浅色' }).click();
  await expect(html).toHaveClass(/\blight\b/);
  await theme.getByRole('button', { name: '跟随系统' }).click();
  await expect(html).toHaveClass(/\bdark\b/);
  /* 跟随：系统一变就跟着变 */
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveClass(/\blight\b/);
});

test('settings: with site mail off there is no "change email" or "verify"', async ({ page }, info) => {
  await page.route(/\/auth\/options$/, async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...(await res.json()), mail: false } });
  });
  psql(`UPDATE users SET email_verified_at = NULL WHERE email = '${mine(info, 'settings')}';`);
  try {
    await signIn(page, mine(info, 'settings'));
    await open(page, '/account');
    const account = page.locator('#account');
    await expect(account.getByText('站点没有开启邮件发送，暂时不能验证或更换邮箱。')).toBeVisible();
    await expect(account.getByRole('button', { name: '更换', exact: true })).toHaveCount(0);
    await expect(account.getByRole('button', { name: '验证', exact: true })).toHaveCount(0);
  } finally {
    psql(`UPDATE users SET email_verified_at = now() WHERE email = '${mine(info, 'settings')}';`);
  }
});

test('settings: sign out of every device from the security section', async ({ page, browser }, info) => {
  const email = `everywhere-${info.project.name}-${Date.now()}@e2e.test`;
  await (await admin()).call('POST', '/api/v1/users', { email, password: seed.password });
  await signIn(page, email);
  const other = await browser.newContext();
  const elsewhere = await other.newPage();
  await signIn(elsewhere, email);
  await open(page, '/account#security');
  await page.locator('#security').getByRole('button', { name: '全部退出' }).click();
  const confirm = page.getByRole('alertdialog', { name: '退出所有设备？' });
  await expect(confirm.getByText('订阅链接不受影响，客户端照常连接')).toBeVisible();
  await confirm.getByRole('button', { name: '全部退出' }).click();
  await expect(page).toHaveURL(/\/login/);
  await elsewhere.goto('/orders');
  await expect(elsewhere).toHaveURL(/\/login/);
  await other.close();
});

test('settings: an old-format link (no stored copy) can still be reset from settings', async ({ page }, info) => {
  const email = mine(info, 'legacy');
  /* 先签发一次，再去掉可显示的密文：0120 之前的账户就是这样（只有哈希） */
  await (await Client.user(email, seed.password)).call('GET', '/api/v1/me');
  psql(`UPDATE users SET sub_token_enc = NULL WHERE email = '${email}';`);
  await signIn(page, email);
  await open(page, '/account#subscription');
  const sub = page.locator('#subscription');
  await expect(sub.getByText('旧格式链接，重置后可查看')).toBeVisible();
  await sub.getByRole('button', { name: '重置', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: '重置订阅？' });
  await expect(confirm.getByText('链接泄露时重置。所有设备都会断开，需要重新导入。')).toBeVisible();
  await confirm.getByRole('button', { name: '确认重置' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText('订阅已重置').first()).toBeVisible();
  await expect(sub.getByText('正常')).toBeVisible();
  expect(psql(`SELECT sub_token_enc IS NOT NULL FROM users WHERE email = '${email}';`)).toBe('t');
});

test('#26 self-service deletion: a danger dialog with the impact; pending orders block it; inline errors, then the account is gone', async ({ page }, info) => {
  const email = mine(info, 'delete');
  /* 一笔待支付订单：面板拒绝注销，弹窗先说清楚 */
  const c = await Client.user(email, seed.password);
  const plans = await c.call<{ plans: { plan_id: string; name: string }[] }>('GET', '/api/v1/me/shop');
  const plan = plans.plans.find((p) => p.name === seed.plan)?.plan_id;
  const order = await c.call<{ id: string }>('POST', '/api/v1/me/orders', { plan_id: plan, period: 'month' });

  await signIn(page, email);
  await open(page, '/account');
  await page.getByRole('button', { name: '注销账户…' }).click();
  const dialog = page.getByRole('dialog', { name: '注销账户' });
  await expect(dialog.getByText('注销后你将失去')).toBeVisible();
  /* 有订单（哪怕没付）就是财务记录：账户匿名化保留 */
  await expect(dialog.getByText('账户有付款记录：财务记录匿名保留，其余个人数据删除')).toBeVisible();
  /* 被阻止：说明要先处理什么、给去处的链接，没有注销按钮，只有「知道了」 */
  await expect(dialog.getByRole('alert').getByText(/待支付订单/)).toBeVisible();
  await expect(dialog.getByRole('link', { name: '去订单页' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '永久注销' })).toHaveCount(0);

  await c.call('POST', `/api/v1/me/orders/${order.id}/cancel`);
  await dialog.getByRole('button', { name: '知道了' }).click();
  await expect(dialog).toHaveCount(0);
  expect(psql(`SELECT count(*) FROM users WHERE email = '${email}' AND erased_at IS NULL;`)).toBe('1');

  await page.getByRole('button', { name: '注销账户…' }).click();
  await expect(dialog.getByRole('alert').getByText(/待支付订单/)).toHaveCount(0);
  /* 没勾「不可恢复」：内联提示，不提交 */
  await dialog.getByLabel('输入当前密码确认').fill('not-the-password');
  await dialog.getByRole('button', { name: '永久注销' }).click();
  await expect(dialog.getByText('请先勾选确认')).toBeVisible();
  await dialog.getByLabel('我已了解：注销后账户和上面这些内容都不可恢复').check();
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

/* 提醒条在页面标题下方、同一个提醒区里（只有仪表盘有账户提醒） */
async function bannerBelowTitle(page: Page, title: string, banner: string) {
  const h = page.getByRole('heading', { level: 1, name: title });
  const b = page.locator('[data-page-notices]').getByText(banner);
  await expect(h).toBeVisible();
  await expect(b).toBeVisible();
  const [hb, bb] = [await h.boundingBox(), await b.boundingBox()];
  expect(bb!.y).toBeGreaterThan(hb!.y + hb!.height);
}

test('#19 renewal scope (expired): banner, no nodes or subscription, the shop still works', async ({ page }, info) => {
  await signIn(page, 'expired@e2e.test');
  await expect(page.getByText('套餐已到期，服务已暂停')).toBeVisible();
  await bannerBelowTitle(page, '仪表盘', '套餐已到期，服务已暂停');
  await info.attach('banner-dashboard', { body: await page.screenshot(), contentType: 'image/png' });
  await expect(page.getByRole('button', { name: '复制订阅链接' })).toHaveCount(0);
  await open(page, '/nodes');
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  await open(page, '/shop');
  await expect(page.getByRole('heading', { name: '商店' })).toBeVisible();
  /* 账户提醒只在仪表盘 */
  await expect(page.getByText('套餐已到期，服务已暂停')).toHaveCount(0);
  /* 套餐到期后订阅已结束：可以重新订阅 */
  await expect(page.locator('.plan-col').filter({ hasText: seed.plan }).getByRole('button', { name: '立即订阅' })).toBeVisible();
  await open(page, '/wallet');
  await expect(page.getByRole('heading', { name: '钱包' })).toBeVisible();
  await expect(page.getByText('套餐已到期，服务已暂停')).toHaveCount(0);
});

test('#19 renewal scope (quota used up): the shop preselects the traffic reset pack', async ({ page }) => {
  await signIn(page, 'quota@e2e.test');
  await expect(page.getByText('本期流量已用完，服务已暂停')).toBeVisible();
  await page.getByRole('button', { name: '去恢复' }).click();
  await expect(page.getByRole('heading', { name: '商店' })).toBeVisible();
  /* 中-1：流量用完时，当前套餐默认给重置包 */
  await expect(page.locator('.plan-col.is-current').getByRole('button', { name: '购买重置包' })).toBeVisible();
});

test('#18 banned: the reason and tickets only', async ({ page }) => {
  await signIn(page, 'banned@e2e.test');
  await expect(page.getByRole('heading', { name: '账户已被封禁' })).toBeVisible();
  await expect(page.getByText('E2E：违反服务条款')).toBeVisible();
  for (const path of ['/shop', '/wallet', '/nodes', '/account']) {
    await open(page, path);
    await expect(page.getByRole('heading', { name: '账户已被封禁' })).toBeVisible();
  }
  await open(page, '/tickets');
  await expect(page.getByRole('heading', { name: '工单', exact: true })).toBeVisible();
});
