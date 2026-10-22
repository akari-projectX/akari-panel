/*
 * 门户 v2 · PR 4：商店、确认订单、订单、订单详情、付款。覆盖 React 门户 spa/e2e 的 shop.spec（#35–#49：服务端报价、折算与作废、
 * 拒绝原因、优惠码、余额、支付方式、二维码付款与轮询、取消、订单类型、三种退款去向、售罄）、usdt.spec（链上收款：唯一金额、
 * 确认数、付款结果、取消后的说明）、account.spec #19 的商店部分（续费范围），外加新设计的：待付款提醒挡住下单、
 * 订单列表筛选与窄屏行、付款结果只弹一次，以及设计评审截图（商店、确认订单 × 支付方式、USDT 付款页、订单列表、订单详情各状态
 * × 桌面 / 手机 × 浅 / 深）。
 * 账户：v2-shop-<视口>（余额 200 元、标准套餐；本文件按顺序改它）、user@e2e.test（只看报价，不下单）、plain@e2e.test（无套餐）、
 * refund@e2e.test（三笔已退款订单）、expired / quota、v2-usdt-<视口>（用例里建）。整个套件 workers = 1，顺序执行。
 */
import { readFileSync } from 'node:fs';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { Client, payAtGateway, psql, until } from '../../spa/e2e/panel.ts';
import { admin, dark, expect, mine, payResult, ready, seed, shot, signIn, test } from './fixtures';

const isMobile = (info: TestInfo) => info.project.name === 'mobile';

/** 进商店，等套餐卡片出来 */
async function shop(page: Page) {
  await page.goto('/shop');
  await ready(page, '商店');
  await expect(page.locator('.plan').first()).toBeVisible({ timeout: 15_000 });
}

const card = (page: Page, name: string) => page.locator('.plan').filter({ has: page.getByRole('heading', { name, exact: true }) });

/** 确认订单里的一个选项（周期、支付方式）：整行 label */
const option = (dialog: Locator, text: string | RegExp) => dialog.locator('label.opt').filter({ has: dialog.page().locator('b', { hasText: text }) });

/** 订单页上的订单号 */
const outTradeNo = async (page: Page) => (await page.locator('.info dd.no code').textContent())?.trim() ?? '';

/** 第二个支付宝方式（多于一种时必须选）；用完删掉 */
async function secondAlipay(): Promise<() => Promise<void>> {
  const a = await admin();
  const pem = (f: string) => readFileSync(`${process.env.E2E_PAY_DIR}/${f}`, 'utf8');
  const m = await a.call<{ id: string }>('POST', '/api/v1/settings/payments', {
    kind: 'alipay_f2f', display_name: '支付宝（备用）', enabled: true,
    config: {
      environment: 'custom', gateway_url: `${process.env.E2E_MOCK_ALIPAY}/gateway.do`, app_id: '2021000000000003',
      seller_id: '2088000000000001', app_private_key: pem('app-key.pem'), alipay_public_key: pem('alipay-pub.pem'),
      order_timeout_minutes: 15,
    },
  });
  return async () => { await a.call('DELETE', `/api/v1/settings/payments/${m.id}`); };
}

test('cards: monthly headline, periods and savings, three specs, features, current and recommended; the confirm dialog per method', async ({ page }, info) => {
  await signIn(page, mine(info, 'v2-shop'));
  await shop(page);
  /* 卡片上没有周期切换；大字是各周期按月折算的最低价，周期数与年付省多少 */
  await expect(page.getByRole('tablist')).toHaveCount(0);
  const std = card(page, seed.plan);
  await expect(std.getByTestId('plan-price')).toHaveText(/¥\s*12\.50\s*\/月 起/);
  await expect(std.getByText('2 种周期可选')).toBeVisible();
  await expect(std.getByText('年付省 17%')).toBeVisible();
  await expect(std.locator('.specs > div')).toHaveCount(3);
  await expect(std.locator('.specs')).toContainText('100 GB');
  await expect(std.locator('.specs')).toContainText('每月');
  await expect(std.locator('.feats li').filter({ hasText: '全部节点' })).toBeVisible();
  const prem = card(page, seed.premium);
  await expect(prem.getByTestId('plan-price')).toHaveText(/¥\s*30\s*\/月$/);
  await expect(prem.getByText('更多流量')).toBeVisible();
  /* 后台标了「推荐」：实底小标签 */
  await expect(prem.locator('.tag')).toHaveText('推荐');
  await expect(prem.locator('.tag')).toHaveClass(/tg/);
  /* 当前套餐：品牌色边框 + 文字 + 主按钮「续费」+ 一行说明；别的套餐：换套餐 + 折算说明 */
  const cur = page.locator('.plan.current');
  await expect(cur).toHaveCount(1);
  await expect(cur.locator('.tag')).toHaveText('当前套餐');
  await expect(cur.getByRole('button', { name: '续费' })).toHaveClass(/pri/);
  await expect(cur.getByText('从到期日顺延')).toBeVisible();
  await expect(prem.getByText('旧套餐剩余价值自动抵扣')).toBeVisible();
  await expect(prem.getByRole('button', { name: '更换到此套餐' })).not.toHaveClass(/pri/);
  /* 当前套餐区：名称 + 生效中、到期与剩余天数、流量用量 */
  await expect(page.getByRole('region', { name: '当前套餐' })).toContainText('生效中');
  await expect(page.getByRole('region', { name: '当前套餐' })).toContainText(/到期 \d{4}-\d{2}-\d{2}/);
  await expect(page.getByRole('meter', { name: '流量用量' })).toBeVisible();
  /* 手机一栏，桌面同一行并排 */
  const [b1, b2] = [await std.boundingBox(), await prem.boundingBox()];
  if (isMobile(info)) expect(Math.abs((b1?.x ?? 0) - (b2?.x ?? 1))).toBeLessThan(2);
  else expect(Math.abs((b1?.y ?? 0) - (b2?.y ?? 1))).toBeLessThan(2);
  await shot(page, info, 'shop-light');
  await dark(page);
  await shot(page, info, 'shop-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  /* 确认订单（续费当前套餐）：两档周期（年付省 17%、每月折算）、金额明细；只有一种支付方式时不用选 */
  await cur.getByRole('button', { name: '续费' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '确认订单' })).toBeVisible();
  await expect(dialog.getByRole('radiogroup', { name: '购买时长' }).getByRole('radio')).toHaveCount(2);
  await expect(option(dialog, '年付')).toContainText('省 17%');
  await expect(option(dialog, '年付')).toContainText(/每月 ¥12\.50/);
  await expect(dialog.getByRole('radiogroup', { name: '支付方式' })).toHaveCount(0);
  await expect(dialog.getByText('应付金额')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^支付 ¥15(\.00)?$/ })).toBeEnabled();
  await option(dialog, '年付').click();
  await expect(dialog.getByRole('button', { name: /^支付 ¥150(\.00)?$/ })).toBeEnabled();
  await shot(page, info, 'confirm-alipay-light');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  /* 余额抵扣：面板重新报价，全额抵扣 = 「确认开通」 */
  await page.getByRole('switch', { name: '用余额抵扣' }).click();
  await expect(page.getByRole('switch', { name: '用余额抵扣' })).toHaveAttribute('aria-checked', 'true');
  await cur.getByRole('button', { name: '续费' }).click();
  await expect(dialog.getByText('余额抵扣')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认开通' })).toBeEnabled();
  await shot(page, info, 'confirm-balance-light');
  await dark(page);
  await shot(page, info, 'confirm-balance-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');
});

test('#35 #36 #39 #41 #43 a balance-covered reset pack is paid at once; #37 #42 #44 a switch with proration is paid by QR; #46 types', async ({ page }, info) => {
  const email = mine(info, 'v2-shop');
  await signIn(page, email);
  await shop(page);
  const dialog = page.getByRole('dialog');

  /* 流量重置包，余额全额抵扣：面板当场付清，订单页弹付款结果（对勾 + 金额 / 套餐 / 到期 + 两个去处） */
  await page.getByRole('switch', { name: '用余额抵扣' }).click();
  await expect(page.getByRole('region', { name: '流量重置包' })).toContainText(`重置「${seed.plan}」的流量`);
  await page.getByRole('button', { name: '购买', exact: true }).click();
  await expect(dialog.getByText('余额抵扣')).toBeVisible();
  await expect(dialog.getByRole('radiogroup', { name: '购买时长' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '确认开通' }).click();
  await expect(dialog.getByRole('button', { name: '查看订阅' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '返回仪表盘' })).toBeVisible();
  await expect(dialog.getByText('到期时间')).toBeVisible();
  await payResult(page, '支付成功', seed.plan, 10_000, { info, name: 'pay-success-light' });
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
  await ready(page, '订单详情');
  await expect(page.locator('.bill-head')).toContainText('已付款');
  await expect(page.locator('.info')).toContainText('流量重置');
  await expect(page.getByRole('list', { name: '订单进度' })).toContainText('套餐生效');
  /* 只弹一次：刷新后不再出现 */
  await page.reload();
  await ready(page, '订单详情');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await shot(page, info, 'order-paid-light');
  await dark(page);
  await shot(page, info, 'order-paid-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  /* 余额明细里有这笔（钱包页在 PR 5 迁移，先看接口） */
  const c = await Client.user(email, seed.password);
  const ledger = await c.call<{ entries: { kind: string }[] }>('GET', '/api/v1/me/balance');
  expect(ledger.entries.some((e) => e.kind === 'order_payment')).toBe(true);

  /* 用余额续费一个月 */
  await shop(page);
  await page.getByRole('switch', { name: '用余额抵扣' }).click();
  await page.locator('.plan.current').getByRole('button', { name: '续费' }).click();
  await option(dialog, '月付').click();
  await dialog.getByRole('button', { name: '确认开通' }).click();
  await payResult(page, '支付成功', seed.plan);
  await expect(page.locator('.info')).toContainText('续费');

  /* 第二个支付方式：多于一种时必须选（#42）；换到高级套餐：旧套餐折算抵扣（#37），支付宝扫码，网关标记已付款后页面自己变（#44） */
  const drop = await secondAlipay();
  try {
    await shop(page);
    await card(page, seed.premium).getByRole('button', { name: '更换到此套餐' }).click();
    await expect(dialog.getByText('旧套餐折算抵扣')).toBeVisible();
    await expect(dialog.getByRole('radiogroup', { name: '支付方式' }).getByRole('radio')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: /^支付 ¥/ })).toBeDisabled();
    await option(dialog, /^支付宝$/).click();
    await expect(option(dialog, /^支付宝$/)).toHaveClass(/on/);
    await shot(page, info, 'confirm-methods-light');
    await dark(page);
    await shot(page, info, 'confirm-methods-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await dialog.getByRole('button', { name: /^支付 ¥/ }).click();
    await ready(page, '订单详情');
    await expect(page.getByRole('heading', { name: /扫码支付|支付宝付款/ })).toBeVisible();
    await expect(page.getByRole('img', { name: '付款二维码' })).toBeVisible();
    await expect(page.locator('.bill-head')).toContainText('待支付');
    await expect(page.getByText(/请在 .* 前完成支付（还剩 \d+ 分钟）/)).toBeVisible();
    await shot(page, info, 'order-pending-light');
    await dark(page);
    await shot(page, info, 'order-pending-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await payAtGateway(await outTradeNo(page));
    /* 轮询看到已付款：同一个结果弹窗 */
    await payResult(page, '支付成功', seed.premium, 30_000);
    await expect(page.locator('.bill-head')).toContainText('已付款');
    await expect(page.locator('.info')).toContainText('更换套餐');
  } finally {
    await drop();
  }

  /* #46 订单列表：类型、状态、四个数字；筛选 */
  await page.goto('/orders');
  await ready(page, '我的订单');
  const list = isMobile(info) ? page.locator('.rows') : page.locator('table');
  await expect(list).toContainText('更换套餐');
  await expect(list).toContainText('流量重置');
  await expect(list).toContainText('已付款');
  await expect(page.getByRole('region', { name: '订单概况' })).toContainText('累计消费');
  await page.getByRole('button', { name: '已关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '已关闭', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('这里还没有订单')).toBeVisible();
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await shot(page, info, 'orders-light');
  await dark(page);
  await shot(page, info, 'orders-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  /* 点一行进详情 */
  if (isMobile(info)) await page.locator('.rows a').first().click();
  else await page.locator('table').getByRole('link', { name: '详情' }).first().click();
  await ready(page, '订单详情');
});

test('#37 credit beyond the new price is forfeited only after an explicit acknowledgement', async ({ page }, info) => {
  await signIn(page, mine(info, 'v2-shop'));
  await shop(page);
  await card(page, seed.plan).getByRole('button', { name: '更换到此套餐' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('折算作废')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认开通' })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '确认开通' }).click();
  await payResult(page, '支付成功', seed.plan);
  await ready(page, '订单详情');
  await expect(page.locator('.bill-head')).toContainText('已付款');
});

test('#45 a pending order is shown on the shop, blocks a new order, and can be cancelled', async ({ page }, info) => {
  await signIn(page, 'plain@e2e.test');
  await shop(page);
  /* 没有套餐：当前套餐区写未订阅，按钮是立即订阅 */
  await expect(page.getByRole('region', { name: '当前套餐' })).toContainText('未订阅');
  await card(page, seed.plan).getByRole('button', { name: '立即订阅' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^支付 ¥/ }).click();
  await ready(page, '订单详情');
  await expect(page.getByRole('list', { name: '订单进度' })).toContainText('等待付款');

  /* 回商店：页头下面有待支付提醒；确认订单里同样提醒，提交按钮不可用 */
  await shop(page);
  await expect(page.getByText('你有一笔待支付的订单').first()).toBeVisible();
  await card(page, seed.plan).getByRole('button', { name: '立即订阅' }).click();
  await expect(dialog.getByText('你有一笔待支付的订单')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^支付 ¥/ })).toBeDisabled();
  await shot(page, info, 'confirm-pending-light');
  await page.keyboard.press('Escape');
  /* 「去支付」回到订单页，取消 */
  await page.getByRole('link', { name: '去支付' }).first().click();
  await ready(page, '订单详情');
  await page.getByRole('button', { name: '取消订单' }).click();
  await expect(page.getByText('订单已取消').first()).toBeVisible();
  await expect(page.locator('.bill-head')).toContainText('已取消');
  await expect(page.getByRole('list', { name: '订单进度' })).toContainText('已取消');
  await expect(page.getByText('这笔订单已关闭，可以重新选购套餐。')).toBeVisible();
  await shot(page, info, 'order-cancelled-light');
});

test('#40 coupons are entered in the order confirmation: refused in the UI language, plan-limited, accepted with the server quote and with balance', async ({ page }, info) => {
  const a = await admin();
  const code = `V2${info.project.name.slice(0, 1).toUpperCase()}${Date.now().toString(36).toUpperCase()}`;
  const plans = await a.call<{ id: string; name: string }[]>('GET', '/api/v1/plans');
  const standard = plans.find((p) => p.name === seed.plan)!;
  await a.call('POST', '/api/v1/coupons', { code, kind: 'percent', value: 10 });
  await a.call('POST', '/api/v1/coupons', { code: `${code}S`, kind: 'percent', value: 10, plan_ids: [standard.id] });
  await signIn(page, 'user@e2e.test');
  await shop(page);
  /* 商店列表上没有优惠码框 */
  await expect(page.getByLabel('优惠码')).toHaveCount(0);

  const premium = card(page, seed.premium).getByRole('button', { name: '更换到此套餐' });
  const dialog = page.getByRole('dialog');
  const apply = async (c: string) => {
    await dialog.getByLabel('优惠码').fill(c);
    await dialog.getByRole('button', { name: '使用', exact: true }).click();
  };
  await premium.click();
  await apply('NOPE');
  await expect(dialog.getByRole('alert')).toHaveText('优惠码无效');
  /* 限定套餐的码：用在别的套餐上 */
  await apply(`${code}S`);
  await expect(dialog.getByRole('alert')).toHaveText('该优惠码不适用于此套餐');
  /* 有效：服务端报价里的折扣与应付金额 */
  await apply(code);
  await expect(dialog.getByText(new RegExp(`优惠码 ${code} 已生效`))).toBeVisible();
  await expect(dialog.locator('.sum')).toContainText(/[−-]¥3(\.00)?/);
  await shot(page, info, 'confirm-coupon-light');
  /* 关掉再开：优惠码清空，价格回到不带码的报价 */
  await page.keyboard.press('Escape');
  await premium.click();
  await expect(dialog.getByLabel('优惠码')).toHaveValue('');
  await expect(dialog.locator('.sum')).not.toContainText(/[−-]¥3(\.00)?/);
  await page.keyboard.press('Escape');

  /* 与余额一起用（换套餐的折算同在这份报价里） */
  await page.getByRole('switch', { name: '用余额抵扣' }).click();
  await premium.click();
  await apply(code);
  await expect(dialog.locator('.sum')).toContainText(/[−-]¥3(\.00)?/);
  await expect(dialog.locator('.sum')).toContainText('余额抵扣');
  await page.keyboard.press('Escape');
});

test('#38 #48 refusals: renewal-only plans are not offered to newcomers, sold-out plans say so', async ({ page }) => {
  const a = await admin();
  const renewal = await a.call<{ id: string }>('POST', '/api/v1/plans', {
    name: 'V2 仅续费', period: 'monthly', traffic_quota_bytes: 1024 ** 3, renewal_only: true,
    pricing: { on_sale: true, prices: [{ period: 'month', days: null, price_cents: 100 }] },
  });
  const full = await a.call<{ id: string }>('POST', '/api/v1/plans', {
    name: 'V2 售罄', period: 'monthly', traffic_quota_bytes: 1024 ** 3, capacity: 0,
    pricing: { on_sale: true, prices: [{ period: 'month', days: null, price_cents: 100 }] },
  });
  try {
    await signIn(page, 'plain@e2e.test');
    await shop(page);
    const soldOut = card(page, 'V2 售罄');
    await expect(soldOut).toBeVisible();
    /* 仅续费的套餐不卖给新用户：不在目录里 */
    await expect(card(page, 'V2 仅续费')).toHaveCount(0);
    await expect(soldOut.locator('.tag')).toHaveText('已售罄');
    await expect(soldOut.getByRole('button', { name: '已售罄' })).toBeDisabled();
  } finally {
    for (const id of [renewal.id, full.id]) await a.call('DELETE', `/api/v1/plans/${id}`).catch(() => undefined);
  }
});

test('#47 #49 refunds: the three routes and what happened to the plan', async ({ page }, info) => {
  await signIn(page, 'refund@e2e.test');
  const cases: [keyof typeof seed.refundOrders, RegExp, RegExp][] = [
    ['original', /原路退回/, /已原路退回到 支付宝/],
    ['balance', /退到余额/, /已退回账户余额/],
    ['manual', /支付渠道退款/, /已通过支付渠道退回/],
  ];
  for (const [route, method, line] of cases) {
    const id = psql(`SELECT id FROM orders WHERE out_trade_no = '${seed.refundOrders[route]}';`);
    await page.goto(`/orders/${id}`);
    await ready(page, '订单详情');
    await expect(page.getByText(/这笔订单已于 .* 退款/)).toBeVisible();
    await expect(page.locator('.info')).toContainText(method);
    await expect(page.getByText(line)).toBeVisible();
    await expect(page.getByText('这笔订单开通的套餐已同时结束。')).toBeVisible();
    await expect(page.locator('.bill-head')).toContainText('已退款');
    if (route === 'balance') {
      await expect(page.getByRole('link', { name: '查看钱包' })).toBeVisible();
      await shot(page, info, 'order-refunded-light');
      await dark(page);
      await shot(page, info, 'order-refunded-dark');
      await page.emulateMedia({ colorScheme: 'light' });
    }
  }
  await page.goto('/orders');
  await ready(page, '我的订单');
  await page.getByRole('button', { name: '已退款', exact: true }).click();
  const list = isMobile(info) ? page.locator('.rows .li') : page.locator('tbody tr');
  await expect(list).toHaveCount(3);
});

test('#19 renewal scope (expired): the shop still works and the plan can be subscribed again', async ({ page }) => {
  await signIn(page, 'expired@e2e.test');
  await shop(page);
  await expect(page.getByRole('heading', { name: '商店' })).toBeVisible();
  /* 账户提醒只在仪表盘 */
  await expect(page.getByText('套餐已到期，服务已暂停')).toHaveCount(0);
  await expect(card(page, seed.plan).getByRole('button', { name: '立即订阅' })).toBeVisible();
});

test('#19 renewal scope (quota used up): the dashboard leads to the shop, which preselects the traffic reset pack', async ({ page }) => {
  await signIn(page, 'quota@e2e.test');
  await page.goto('/');
  await ready(page);
  await page.getByRole('link', { name: '去恢复' }).click();
  await ready(page, '商店');
  /* 流量用完：当前套餐排最前，默认给重置包 */
  await expect(page.locator('.plan').first()).toHaveClass(/current/);
  await expect(page.locator('.plan.current').getByRole('button', { name: '购买重置包' })).toBeVisible();
  await expect(page.getByRole('region', { name: '当前套餐' })).toContainText('流量已用完');
});

/* ── USDT 链上收款（React 门户 usdt.spec）：每个视口一个收款地址（同链同地址只能属于一个支付方式；React 套件用了 a / b） ── */
const address = (project: string) => `0x${(project === 'mobile' ? 'd' : 'c').repeat(40)}`;

async function rpc(path: string): Promise<void> {
  const r = await fetch(`${process.env.E2E_MOCK_RPC}${path}`, { method: 'POST' });
  if (!r.ok) throw new Error(`mock RPC: ${r.status}`);
}

test('USDT on-chain: unique exact amount on the shared address, the transfer confirmed, the order paid', async ({ page }, info) => {
  const a = await admin();
  const addr = address(info.project.name);
  const method = await a.call<{ id: string }>('POST', '/api/v1/settings/payments', {
    kind: 'usdt_chain', display_name: 'USDT（Polygon）', enabled: true,
    config: { chain: 'polygon', address: addr, rpc_urls: process.env.E2E_MOCK_RPC, rate_cents: 720, confirmations: 3 },
  });
  const email = mine(info, 'v2-usdt');
  await a.call('POST', '/api/v1/users', { email, password: seed.password });
  try {
    await signIn(page, email);
    const order = async (screens = false) => {
      await shop(page);
      await card(page, seed.plan).getByRole('button', { name: '立即订阅' }).click();
      const dialog = page.getByRole('dialog');
      await option(dialog, 'USDT（Polygon）').click();
      await expect(option(dialog, 'USDT（Polygon）')).toContainText('USDT 链上转账');
      if (screens) {
        await shot(page, info, 'confirm-usdt-light');
        await dark(page);
        await shot(page, info, 'confirm-usdt-dark');
        await page.emulateMedia({ colorScheme: 'light' });
      }
      await dialog.getByRole('button', { name: /^支付 ¥/ }).click();
      await expect(page.getByRole('heading', { name: 'USDT 转账付款' })).toBeVisible();
    };

    /* 先下一单再取消：页面说明保留期内到账仍会开通、没转的不要再转这个金额 */
    await order(true);
    await page.getByRole('button', { name: '取消订单' }).click();
    await expect(page.getByTestId('chain-late')).toContainText('前到账的仍会自动开通');
    await expect(page.getByTestId('chain-late')).toContainText('请不要再转这个金额');
    await shot(page, info, 'usdt-cancelled-light');

    await order();
    /* 订单页：网络提醒、精确金额（¥15.00 ÷ 7.20 = 2.083… → 2.09，加 4 位识别尾数）、共用地址、二维码、倒计时 */
    await ready(page, '订单详情');
    await expect(page.getByText(/只能通过 Polygon \(PoS\) 网络转 USDT/)).toBeVisible();
    const amount = (await page.getByTestId('chain-amount').textContent())?.trim() ?? '';
    expect(amount).toMatch(/^2\.09\d{4}$/);
    expect(amount.endsWith('0000')).toBe(false);
    await expect(page.getByTestId('chain-amount').locator('span')).toHaveText(amount.slice(-4));
    await expect(page.getByTestId('chain-address')).toHaveText(new RegExp(`^${addr}$`, 'i'));
    await expect(page.getByText('这是本站共用的收款地址，订单按上面的精确金额识别。')).toBeVisible();
    await expect(page.getByRole('img', { name: '收款地址二维码' })).toBeVisible();
    await expect(page.getByTestId('chain-status')).toContainText('等待转账');
    await expect(page.getByTestId('chain-countdown')).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.getByText(/前到账的这笔金额仍会自动开通/)).toBeVisible();
    await shot(page, info, 'usdt-order-light');
    await dark(page);
    await shot(page, info, 'usdt-order-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    /* 转账：精确金额（含尾数）。先看到「已收到，确认中 1/3」，再出两个块达到 3 个确认即入账 */
    await rpc(`/control/pay?to=${addr}&units=${Number(amount.replace('.', ''))}`);
    await expect(page.getByTestId('chain-status')).toContainText(/已收到转账，确认中 [12]\/3/, { timeout: 30_000 });
    await shot(page, info, 'usdt-confirming-light');
    await rpc('/control/mine?n=2');
    await payResult(page, '支付成功', seed.plan, 45_000);
    await expect(page.locator('.bill-head')).toContainText('已付款');

    /* 面板侧：链上入账 */
    const c = await Client.user(email, seed.password);
    type Row = { status: string; chain: { transfer: { status: string } | null } | null };
    await until('the USDT order credited', async () => {
      const [o] = await c.call<Row[]>('GET', '/api/v1/me/orders');
      return o?.status === 'paid' && o.chain?.transfer?.status === 'credited';
    });
  } finally {
    const m = await a.call<{ methods: { id: string; version: number }[] }>('GET', '/api/v1/settings/payments');
    const cur = m.methods.find((x) => x.id === method.id)!;
    await a.call('PUT', `/api/v1/settings/payments/${method.id}`, {
      version: cur.version, display_name: 'USDT（Polygon）', enabled: false,
      config: { chain: 'polygon', address: addr, rate_cents: 720, confirmations: 3 },
    });
  }
});
