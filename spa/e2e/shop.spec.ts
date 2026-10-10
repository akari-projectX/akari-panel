/*
 * 商店与订单（research/portal-gap.md §1.4 #35–#50）：服务端报价、折算、拒绝原因、优惠码、余额、支付方式、
 * 二维码付款与轮询、取消、订单类型、三种退款去向（P1、PR ③ 原路退款）、售罄。
 */
import { readFileSync } from 'node:fs';
import { payAtGateway, psql } from './panel.ts';
import { admin, expect, mine, open, seed, signIn, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

test('#35 #36 #39 #41 #43 a balance-covered reset pack is paid at once; #37 #42 #44 a switch with proration is paid by QR', async ({ page }, info) => {
  await signIn(page, mine(info, 'shop'));
  await open(page, '/shop');
  await expect(page.locator('.plan-col').filter({ hasText: seed.premium })).toBeVisible();
  /* 服务端报价：每个周期的价格都来自 /me/shop */
  await expect(page.locator('.plan-col').filter({ hasText: seed.plan }).getByText(/可选 .*月.*年/)).toBeVisible();

  /* 流量重置包，余额全额抵扣：面板当场付清 */
  await page.getByRole('switch', { name: '用余额抵扣' }).click();
  await page.getByRole('button', { name: '购买', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('余额抵扣')).toBeVisible();
  await page.getByRole('button', { name: '确认开通' }).click();
  await expect(page.getByRole('heading', { name: '订单详情' })).toBeVisible();
  await expect(page.getByText('已付款').first()).toBeVisible();
  await expect(page.getByText('流量重置').first()).toBeVisible();
  await open(page, '/wallet');
  await expect(page.getByText('订单支付').locator('visible=true').first()).toBeVisible();

  /* 用余额续费一个月（换套餐的折算按实付的订单算） */
  await open(page, '/shop');
  await page.getByRole('switch', { name: '用余额抵扣' }).click();
  await page.locator('.plan-col.is-current').getByRole('button', { name: '续费' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /月付/ }).first().click();
  await page.getByRole('button', { name: '确认开通' }).click();
  await expect(page.getByRole('heading', { name: '订单详情' })).toBeVisible();
  await expect(page.getByText('续费').first()).toBeVisible();

  /* 第二个支付方式：多于一种时必须选（#42） */
  const a = await admin();
  const pem = (f: string) => readFileSync(`${process.env.E2E_PAY_DIR}/${f}`, 'utf8');
  const second = await a.call<{ id: string }>('POST', '/api/v1/settings/payments', {
    kind: 'alipay_f2f', display_name: '支付宝（备用）', enabled: true,
    config: {
      environment: 'custom', gateway_url: `${process.env.E2E_MOCK_ALIPAY}/gateway.do`, app_id: '2021000000000002',
      seller_id: '2088000000000001', app_private_key: pem('app-key.pem'), alipay_public_key: pem('alipay-pub.pem'),
      order_timeout_minutes: 15,
    },
  });
  try {
    /* 换到高级套餐：旧套餐折算抵扣（#37），支付宝付：订单页二维码，模拟网关标记已付款后页面自己变成已付款（#44） */
    await open(page, '/shop');
    await page.locator('.plan-col').filter({ hasText: seed.premium }).getByRole('button', { name: '更换到此套餐' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('旧套餐折算抵扣')).toBeVisible();
    /* 两种支付方式：没选之前付不了 */
    await expect(dialog.getByRole('button', { name: /^支付 ¥/ })).toBeDisabled();
    await dialog.locator('label').filter({ hasText: /^支付宝$/ }).click();
    await dialog.getByRole('button', { name: /^支付 ¥/ }).click();
    await expect(page.getByRole('heading', { name: '订单详情' })).toBeVisible();
    await expect(page.getByText(/扫码支付|支付宝付款/).first()).toBeVisible();
    const otn = (await page.locator('code').first().textContent())?.trim() ?? '';
    await payAtGateway(otn);
    await expect(page.getByText('已付款').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('更换套餐').first()).toBeVisible();
  } finally {
    await a.call('DELETE', `/api/v1/settings/payments/${second.id}`);
  }
  /* #46 订单列表：类型列与状态 */
  await open(page, '/orders');
  await expect(page.getByText('更换套餐').locator('visible=true').first()).toBeVisible();
  await expect(page.getByText('流量重置').locator('visible=true').first()).toBeVisible();
});

test('#37 credit beyond the new price is forfeited only after an explicit acknowledgement', async ({ page }, info) => {
  await signIn(page, mine(info, 'shop'));
  await open(page, '/shop');
  await page.locator('.plan-col').filter({ hasText: seed.plan }).getByRole('button', { name: '更换到此套餐' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('折算作废')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认开通' })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '确认开通' }).click();
  await expect(page.getByRole('heading', { name: '订单详情' })).toBeVisible();
  await expect(page.getByText('已付款').first()).toBeVisible();
});

test('#45 a pending order can be cancelled', async ({ page }) => {
  await signIn(page, 'plain@e2e.test');
  await open(page, '/shop');
  await page.locator('.plan-col').filter({ hasText: seed.plan }).getByRole('button', { name: '立即订阅' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^支付 ¥/ }).click();
  await expect(page.getByRole('heading', { name: '订单详情' })).toBeVisible();
  await page.getByRole('button', { name: '取消订单' }).first().click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  if (await confirm.count()) await confirm.getByRole('button', { name: /确认|取消订单/ }).last().click();
  await expect(page.getByText('订单已取消').first()).toBeVisible();
});

test('#40 coupons are entered in the order confirmation: refused in the UI language, plan-limited, accepted with the server quote and with balance', async ({ page }) => {
  const a = await admin();
  const stamp = Date.now().toString(36).toUpperCase();
  const code = `E2E${stamp}`;
  const plans = await a.call<{ id: string; name: string }[]>('GET', '/api/v1/plans');
  const standard = plans.find((p) => p.name === seed.plan)!;
  await a.call('POST', '/api/v1/coupons', { code, kind: 'percent', value: 10 });
  await a.call('POST', '/api/v1/coupons', { code: `${code}S`, kind: 'percent', value: 10, plan_ids: [standard.id] });
  await signIn(page, 'user@e2e.test');
  await open(page, '/shop');
  await expect(page.locator('.plan-col').filter({ hasText: seed.premium })).toBeVisible();
  /* 商店列表上没有优惠码框 */
  await expect(page.getByLabel('优惠码')).toHaveCount(0);

  const premium = page.locator('.plan-col').filter({ hasText: seed.premium }).getByRole('button').last();
  const dialog = page.getByRole('dialog');
  const apply = async (c: string) => {
    await dialog.getByLabel('优惠码').fill(c);
    await dialog.getByRole('button', { name: '使用', exact: true }).click();
  };
  await premium.click();
  await apply('NOPE');
  await expect(dialog.getByText('优惠码无效')).toBeVisible();
  /* 限定套餐的码：用在别的套餐上 */
  await apply(`${code}S`);
  await expect(dialog.getByText('该优惠码不适用于此套餐')).toBeVisible();
  /* 有效：服务端报价里的折扣与应付金额 */
  await apply(code);
  await expect(dialog.getByText(new RegExp(`优惠码 ${code} 已生效`))).toBeVisible();
  await expect(dialog.getByText(/^[−-]¥3(\.00)?$/)).toBeVisible();
  /* 关掉再开：优惠码清空，价格回到不带码的报价 */
  await page.keyboard.press('Escape');
  await premium.click();
  await expect(dialog.getByLabel('优惠码')).toHaveValue('');
  await expect(dialog.getByText(/^[−-]¥3(\.00)?$/)).toHaveCount(0);
  await page.keyboard.press('Escape');

  /* 与余额一起用（换套餐的折算同在这份报价里，见 #37） */
  await page.getByRole('switch', { name: '用余额抵扣' }).click();
  await premium.click();
  await apply(code);
  await expect(dialog.getByText(/^[−-]¥3(\.00)?$/)).toBeVisible();
  await expect(dialog.getByText('余额抵扣')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('#38 #48 refusals: renewal-only plans are not offered to newcomers, sold-out plans say so', async ({ page }) => {
  const a = await admin();
  const plans = await a.call<{ id: string; name: string }[]>('GET', '/api/v1/plans');
  const renewal = await a.call<{ id: string }>('POST', '/api/v1/plans', {
    name: 'E2E 仅续费', period: 'monthly', traffic_quota_bytes: 1024 ** 3, renewal_only: true,
    pricing: { on_sale: true, prices: [{ period: 'month', days: null, price_cents: 100 }] },
  });
  const full = await a.call<{ id: string }>('POST', '/api/v1/plans', {
    name: 'E2E 售罄', period: 'monthly', traffic_quota_bytes: 1024 ** 3, capacity: 0,
    pricing: { on_sale: true, prices: [{ period: 'month', days: null, price_cents: 100 }] },
  });
  try {
    await signIn(page, 'plain@e2e.test');
    await open(page, '/shop');
    const soldOutFirst = page.locator('.plan-col').filter({ hasText: 'E2E 售罄' });
    await expect(soldOutFirst).toBeVisible();
    /* 仅续费的套餐不卖给新用户：不在目录里 */
    await expect(page.locator('.plan-col').filter({ hasText: 'E2E 仅续费' })).toHaveCount(0);
    const soldOut = page.locator('.plan-col').filter({ hasText: 'E2E 售罄' });
    await expect(soldOut.getByText('已售罄').first()).toBeVisible();
    await expect(soldOut.getByRole('button', { name: '已售罄' })).toBeDisabled();
    expect(plans.length).toBeGreaterThan(0);
  } finally {
    for (const id of [renewal.id, full.id]) await a.call('DELETE', `/api/v1/plans/${id}`).catch(() => undefined);
  }
});

test('#47 #49 refunds: the three routes and what happened to the plan', async ({ page }) => {
  await signIn(page, 'refund@e2e.test');
  const cases: [keyof typeof seed.refundOrders, RegExp, RegExp][] = [
    ['original', /原路退回/, /已原路退回到 支付宝/],
    ['balance', /退到余额/, /已退回账户余额/],
    ['manual', /支付渠道退款/, /已通过支付渠道退回/],
  ];
  for (const [route, method, line] of cases) {
    const id = psql(`SELECT id FROM orders WHERE out_trade_no = '${seed.refundOrders[route]}';`);
    await open(page, `/orders/${id}`);
    await expect(page.getByText(/这笔订单已于 .* 退款/)).toBeVisible();
    await expect(page.getByText(method).first()).toBeVisible();
    await expect(page.getByText(line)).toBeVisible();
    await expect(page.getByText('这笔订单开通的套餐已同时结束。')).toBeVisible();
  }
  await open(page, '/orders');
  /* 三笔都标成已退款（还有一个「已退款」页签的话也算在内） */
  await expect.poll(() => page.getByText('已退款', { exact: true }).locator('visible=true').count()).toBeGreaterThanOrEqual(3);
});
