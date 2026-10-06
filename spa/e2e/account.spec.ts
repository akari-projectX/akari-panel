/*
 * 账户（research/portal-gap.md §1.2 #17–#26，通行密钥 #24 #25 在 auth.spec.ts）与三种账户范围。
 */
import { Client, latestMail, psql } from './panel.ts';
import { expect, login, mine, open, seed, signIn, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

test('#17 #21 #20 #22 #23 account: verify the address, change it, change the password, mail language follows the UI', async ({ page }, info) => {
  const email = mine(info, 'account');
  psql(`UPDATE users SET email_verified_at = NULL WHERE email = '${email}';`);
  await signIn(page, email);
  /* 未验证：仪表盘提示去验证 */
  await expect(page.getByText('邮箱还没有验证')).toBeVisible();
  await page.getByRole('button', { name: '去验证' }).click();
  await expect(page).toHaveURL(/\/account/);
  await expect(page.getByText('未验证')).toBeVisible();
  /* 切页动画（旧页面淡出）结束、新页面定下来之后再填 */
  await expect(page.locator('.page-out')).toHaveCount(0);

  /* 验证当前地址 */
  await page.getByLabel('邮箱地址').fill(email);
  await expect(page.getByLabel('邮箱地址')).toHaveValue(email);
  await page.getByLabel('当前密码').first().fill(seed.password);
  let sent = Date.now() - 1000;
  await page.getByRole('button', { name: '发送验证码' }).click();
  let code = /\b(\d{6})\b/.exec(await latestMail(email, sent))?.[1] ?? '';
  await page.getByLabel('邮箱验证码').fill(code);
  await page.getByRole('button', { name: '验证', exact: true }).click();
  await expect(page.getByText('已验证').first()).toBeVisible();

  /* 换一个地址：验证通过后就是新的登录名 */
  const next = `moved-${Date.now()}-${info.project.name}@e2e.test`;
  await page.getByLabel('邮箱地址').fill(next);
  await page.getByLabel('当前密码').first().fill(seed.password);
  sent = Date.now() - 1000;
  await page.getByRole('button', { name: '发送验证码' }).click();
  code = /\b(\d{6})\b/.exec(await latestMail(next, sent))?.[1] ?? '';
  await page.getByLabel('邮箱验证码').fill(code);
  await page.getByRole('button', { name: '验证', exact: true }).click();
  await expect(page.getByText(next).first()).toBeVisible();

  /* 改密码（安全设置页签）：其他会话结束，本会话保留 */
  await open(page, '/account?tab=security');
  const pw = `changed-${seed.password}`;
  await page.getByLabel('当前密码').fill(seed.password);
  await page.getByLabel('新密码', { exact: true }).fill(pw);
  await page.getByLabel('确认新密码').fill(pw);
  await page.getByRole('button', { name: '更新密码' }).click();
  await expect(page.getByText('密码已更新').first()).toBeVisible();

  /* 界面语言 = 邮件语言 */
  await open(page, '/account');
  await page.locator('#settings-locale').click();
  await page.getByRole('option', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect.poll(() => psql(`SELECT locale FROM users WHERE email = '${next}';`)).toBe('en');
  await page.locator('#settings-locale').click();
  await page.getByRole('option', { name: '简体中文' }).click();
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, next, pw);
});

test('#26 self-service deletion: impact first, pending orders block it, then the account is gone', async ({ page }, info) => {
  const email = mine(info, 'delete');
  /* 一笔待支付订单：面板拒绝注销，页面先说清楚 */
  const c = await Client.user(email, seed.password);
  const plans = await c.call<{ plans: { plan_id: string; name: string }[] }>('GET', '/api/v1/me/shop');
  const plan = plans.plans.find((p) => p.name === seed.plan)?.plan_id;
  const order = await c.call<{ id: string }>('POST', '/api/v1/me/orders', { plan_id: plan, period: 'month' });

  await signIn(page, email);
  await open(page, '/account');
  await page.getByRole('button', { name: '我要注销账户' }).click();
  /* 有订单（哪怕没付）就是财务记录：账户匿名化保留 */
  await expect(page.getByText('账户有付款记录：财务记录匿名保留，其余个人数据删除')).toBeVisible();
  await expect(page.getByRole('alert').getByText(/待支付订单/)).toBeVisible();
  await page.getByLabel('输入当前密码确认').fill(seed.password);
  await expect(page.getByRole('button', { name: '注销账户', exact: true })).toBeDisabled();

  await c.call('POST', `/api/v1/me/orders/${order.id}/cancel`);
  await page.reload();
  await page.getByRole('button', { name: '我要注销账户' }).click();
  await expect(page.getByRole('alert').getByText(/待支付订单/)).toHaveCount(0);
  await page.getByLabel('输入当前密码确认').fill(seed.password);
  await page.getByRole('button', { name: '注销账户', exact: true }).click();
  await page.getByRole('button', { name: '确认注销' }).click();
  await expect(page.getByText('账户已注销')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await login(page, email);
  await expect(page.getByText('邮箱或密码错误')).toBeVisible();
});

test('#19 renewal scope (expired): banner, no nodes or subscription, the shop still works', async ({ page }) => {
  await signIn(page, 'expired@e2e.test');
  await expect(page.getByText('套餐已到期，服务已暂停')).toBeVisible();
  await expect(page.getByRole('button', { name: '复制订阅链接' })).toHaveCount(0);
  await open(page, '/nodes');
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  await open(page, '/shop');
  await expect(page.getByRole('heading', { name: '商店' })).toBeVisible();
  /* 套餐到期后订阅已结束：可以重新订阅 */
  await expect(page.locator('.plan-col').filter({ hasText: seed.plan }).getByRole('button', { name: '立即订阅' })).toBeVisible();
  await open(page, '/wallet');
  await expect(page.getByRole('heading', { name: '钱包' })).toBeVisible();
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
