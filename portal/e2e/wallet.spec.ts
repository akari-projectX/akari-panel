/*
 * 门户 v2 · PR 5：钱包与邀请（/wallet，旧地址 /invite）。覆盖切换前 React 门户 e2e 的 wallet.spec.ts（#51–#56：USDT 提现的网络、
 * 地址提示、TON Memo、参考汇率、撤回、通过后的实付与交易哈希、邀请统计与唯一的邀请码、佣金追回）、polish.spec.ts #52
 * （提现表单的内联错误）、account.spec.ts #19 / #18 的钱包部分（续费范围只有流水、封禁看不到），外加：「允许用户邀请」关闭、
 * 单次使用的邀请码、流水翻页、分页的键盘操作与地址，以及设计评审截图（邀请 / 流水 / 提现记录 / 提现对话框 / 续费范围 × 桌面 / 手机 × 浅 / 深）。
 * 账户：v2-inviter-<视口> / v2-invitee-<视口>（seed.ts 给门户 v2 单独建的一对，被邀请人付过一单，佣金已入账）、user@e2e.test、
 * expired / banned。改站点设置的用例在 finally 里恢复。
 */
import type { Page, TestInfo } from '@playwright/test';
import { FIELDS, psql } from './support/panel.ts';
import { admin, dark, expect, mine, ready, shot, signIn, test } from './fixtures';

/* 不用 serial：workers = 1 本来就按文件顺序跑；一条失败不该让后面的都跳过。#56 的退款依赖它前面的邀请用例先看过「已入账」，顺序保留。 */

const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TON = 'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI';
const SIGNUP = [...FIELDS.signup, 'user_invites'];

const inviter = (info: TestInfo) => mine(info, 'v2-inviter');

/** 打开钱包页（可带 ?tab=），等到页面标题与所有区块取完 */
async function wallet(page: Page, path = '/wallet', title = '邀请') {
  await page.goto(path);
  await ready(page, title);
  await expect(page.locator('main [aria-busy]')).toHaveCount(0, { timeout: 15_000 });
}

test('#51 #52 #53 USDT withdrawals: network, address hints, TON memo, reference amount; withdraw it again', async ({ page }, info) => {
  await signIn(page, inviter(info));
  await wallet(page, '/wallet?tab=ledger');
  await expect(page.getByRole('tab', { name: '收支流水' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('邀请佣金入账').filter({ visible: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '申请提现' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('提现金额（元）').fill('1');
  /* 参考汇率 7.20：约 0.14 USDT */
  await expect(dialog.getByText('约 0.14 USDT（按参考汇率，以实际打款为准）')).toBeVisible();
  /* 只列后台开着的网络 */
  const net = dialog.getByLabel('USDT 网络');
  await expect(dialog.getByText('T 开头的 34 位 Tron 地址')).toBeVisible();
  await net.click();
  await expect(page.getByRole('option')).toHaveText(['TRC20 (Tron)', 'Polygon', 'TON']);
  await page.getByRole('option', { name: 'TON' }).click();
  await expect(dialog.getByText('TON 地址（UQ / EQ 开头）；转到交易所时请填写 Memo')).toBeVisible();
  /* 地址填错网络：面板按网络校验，错误画在地址下面并把焦点放回去 */
  await dialog.getByLabel('收款地址').fill(TRON);
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(dialog.getByText('这不是有效的 ton 地址，请核对网络与地址')).toBeVisible();
  await expect(dialog.getByLabel('收款地址')).toBeFocused();
  await expect(dialog.getByLabel('收款地址')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('收款地址').fill(TON);
  await dialog.getByLabel('Memo（选填）').fill('12345');
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(page.getByText('提现申请已提交').filter({ visible: true }).first()).toBeVisible();
  await expect(dialog).toHaveCount(0);
  /* 同一时间只能有一笔待审核的：按钮置灰并说明原因 */
  await expect(page.getByRole('button', { name: '申请提现' })).toBeDisabled();
  await expect(page.getByText('同一时间只能有一笔待审核的提现申请。')).toBeVisible();
  await expect(page.getByText('提现', { exact: true }).filter({ visible: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: '提现记录' }).click();
  await expect(page).toHaveURL(/\/wallet\?tab=withdrawals$/);
  await expect(page.getByText('TON', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('12345').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('待审核').filter({ visible: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '撤回' }).first().click();
  await expect(page.getByText('提现申请已撤回').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('已撤回').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '撤回' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '申请提现' })).toBeEnabled();
});

test('#52 an approved withdrawal shows the USDT sent and the transaction hash; the address copies', async ({ page, context }, info) => {
  const email = inviter(info);
  await signIn(page, email);
  await wallet(page);
  await page.getByRole('button', { name: '申请提现' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('提现金额（元）').fill('1');
  await dialog.getByLabel('收款地址').fill(TRON);
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(page.getByText('提现申请已提交').filter({ visible: true }).first()).toBeVisible();

  const id = psql(`SELECT w.id FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE u.email = '${email}' AND w.status = 'pending';`);
  const txid = 'a'.repeat(64);
  await (await admin()).call('POST', `/api/v1/withdrawals/${id}/approve`, { usdt_amount: '0.138888', txid });
  await wallet(page, '/wallet?tab=withdrawals');
  await expect(page.getByText('已打款').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(/实付 0\.138888 USDT/).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('aaaaaaaa…aaaaaaaa').filter({ visible: true }).first()).toBeVisible();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制 交易哈希' }).first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(txid);
  await shot(page, info, 'wallet-withdrawals-light');
  await dark(page);
  await shot(page, info, 'wallet-withdrawals-dark');
});

test('#54 #55 invite: /invite opens the invite tab of the merged page; terms, stats, commissions without the invitee\'s address; one invite code that cannot be deleted or regenerated', async ({ page, context }, info) => {
  const email = inviter(info);
  await signIn(page, email);
  await page.goto('/invite');
  await expect(page).toHaveURL(/\/wallet\?tab=invite$/);
  await ready(page, '邀请');
  await expect(page.locator('main [aria-busy]')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('tab', { name: '邀请返佣' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/返佣 20%/).filter({ visible: true }).first()).toBeVisible();
  /* 余额与提现在同一页 */
  await expect(page.getByRole('button', { name: '申请提现' })).toBeVisible();
  await expect(page.getByText('已入账').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('返佣明细 · 共 1 条')).toBeVisible();
  await expect(page.getByText(mine(info, 'v2-invitee'))).toHaveCount(0);
  /* 每个账户一个邀请码：自动生成，没有「生成」与「删除」 */
  const shown = page.getByTestId('invite-code');
  await expect(shown).toHaveCount(1);
  const code = (await shown.textContent())?.trim() ?? '';
  const uid = `(SELECT id FROM users WHERE email = '${email}')`;
  expect(psql(`SELECT code FROM invite_codes WHERE user_id = ${uid};`)).toBe(code);
  await expect(page.getByText('每个账户一个，长期有效')).toBeVisible();
  await expect(page.getByRole('button', { name: /生成邀请码|再生成一个/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除' })).toHaveCount(0);
  /* 邀请链接用面板给的 link_base（主域名 + /register?invite=）+ 这个码 */
  await expect(page.getByRole('textbox', { name: '邀请链接' })).toHaveValue(new RegExp(`^${process.env.E2E_ORIGIN}/register\\?invite=${code}$`));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制邀请码' }).click();
  await expect(page.getByText('邀请码已复制').filter({ visible: true }).first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await page.getByRole('button', { name: '复制链接' }).first().click();
  await expect(page.getByText('邀请链接已复制').filter({ visible: true }).first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/register\\?invite=${code}$`));
  expect(psql(`SELECT count(*) FROM invite_codes WHERE user_id = ${uid};`)).toBe('1');
  await shot(page, info, 'wallet-invite-light');
  await dark(page);
  await shot(page, info, 'wallet-invite-dark');
});

test('tabs: arrow keys move between them, the address follows without a new history entry or a jump to the top', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'keyboard');
  await signIn(page, inviter(info));
  await page.goto('/');
  await ready(page, '仪表盘');
  await wallet(page);
  const before = await page.evaluate(() => history.length);
  await page.getByRole('tab', { name: '邀请返佣' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '收支流水' })).toBeFocused();
  await expect(page.getByRole('tab', { name: '收支流水' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('邀请佣金入账');
  await expect(page).toHaveURL(/\?tab=ledger$/);
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: '提现记录' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '邀请返佣' })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => history.length)).toBe(before);
  await page.goBack();
  await ready(page, '仪表盘');
});

test('#56 a refund after the commission was credited claws it back (the balance stops at zero, the rest is owed)', async ({ page }, info) => {
  const a = await admin();
  const order = psql(`SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = '${mine(info, 'v2-invitee')}' AND o.status = 'paid' LIMIT 1;`);
  await a.call('POST', `/api/v1/orders/${order}/refund`, { reason: 'e2e 追回', to_balance: true });
  await signIn(page, inviter(info));
  await wallet(page, '/wallet?tab=ledger');
  await expect(page.getByText('佣金追回').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(/^[−-]¥[0-9.]+$/).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: '邀请返佣' }).click();
  await expect(page.getByText('已追回').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(/被追回的佣金因订单退款从余额里扣回/)).toBeVisible();
  /* 余额到 0：没有可提现的金额，按钮置灰并说明 */
  await expect(page.getByRole('button', { name: '申请提现' })).toBeDisabled();
  await expect(page.getByText('现在没有可提现的金额：佣金过了冻结期才能提现。')).toBeVisible();
});

test('#52 withdrawal form: inline errors, the first bad field is focused, nothing is sent; a closed network list disables it', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  /* 余额、提现记录、网络由桩给出：这条只测表单本身 */
  await page.route(/\/api\/v1\/me\/balance(\?|$)/, (r) => r.fulfill({ json: { balance_cents: 8000, withdrawable_cents: 5000, entries: [] } }));
  const inviteBody = {
    enabled: true, rate_percent: 20, first_order_only: false, hold_days: 7, min_withdrawal_cents: 1000,
    usdt_chains: [{ id: 'trc20', name: 'TRC20 (Tron)' }], usdt_rate_cents: null, invited_count: 0,
    pending_cents: 0, credited_cents: 5000, reversed_cents: 0, balance_cents: 8000, withdrawable_cents: 5000, commissions: [],
  };
  await page.route(/\/api\/v1\/me\/invite$/, (r) => r.fulfill({ json: inviteBody }));
  let posted = 0;
  await page.route(/\/api\/v1\/me\/withdrawals$/, (r) => {
    if (r.request().method() === 'POST') posted++;
    return r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.fulfill({ status: 500, json: {} });
  });
  await wallet(page, '/wallet?tab=withdrawals');
  await expect(page.getByText('还没有提现记录')).toBeVisible();
  await expect(page.getByText('最低提现').filter({ visible: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '申请提现' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('可提现 ¥50，最低 ¥10')).toBeVisible();
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(dialog.getByText('请输入提现金额')).toBeVisible();
  await expect(dialog.getByText('请输入收款地址')).toBeVisible();
  await expect(dialog.getByLabel('提现金额（元）')).toBeFocused();
  await expect(dialog.getByLabel('提现金额（元）')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('提现金额（元）').fill('1.234');
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(dialog.getByText('请输入正确的金额，最多两位小数')).toBeVisible();
  await dialog.getByLabel('提现金额（元）').fill('80');
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(dialog.getByText('超过了可提现金额（¥50）')).toBeVisible();
  await dialog.getByLabel('提现金额（元）').fill('5');
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(dialog.getByText('最低提现 ¥10')).toBeVisible();
  await shot(page, info, 'wallet-withdraw-dialog-light');
  await dark(page);
  await shot(page, info, 'wallet-withdraw-dialog-dark');
  /* 关掉再打开：错误清掉，填了的金额还在 */
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '申请提现' }).click();
  await expect(dialog.getByText('最低提现 ¥10')).toHaveCount(0);
  await expect(dialog.getByLabel('提现金额（元）')).toHaveValue('5');
  expect(posted).toBe(0);

  /* 后台没开任何网络：不能申请，并说明 */
  inviteBody.usdt_chains = [];
  await page.keyboard.press('Escape');
  await page.reload();
  await ready(page, '邀请');
  await expect(page.getByRole('button', { name: '申请提现' })).toBeDisabled();
  await expect(page.getByText('暂未开放提现。')).toBeVisible();
});

test('invites: the "allow user invites" switch off explains it on both panes; a single-use code says so', async ({ page }, info) => {
  const a = await admin();
  await signIn(page, 'user@e2e.test');
  let before = await a.patch('signup', SIGNUP, { user_invites: false });
  try {
    await wallet(page, '/wallet?tab=invite');
    await expect(page.getByTestId('invites-closed')).toHaveText('本站已关闭用户邀请，暂时不能邀请新用户。已邀请的用户与返佣不受影响。');
    await expect(page.getByText('邀请已关闭')).toBeVisible();
    await expect(page.getByTestId('invite-code')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '邀请链接' })).toHaveCount(0);
    await shot(page, info, 'wallet-invites-closed-light');
  } finally {
    await a.patch('signup', SIGNUP, before);
  }
  before = await a.patch('signup', SIGNUP, { invite_single_use: true });
  try {
    await wallet(page, '/wallet?tab=invite');
    await expect(page.getByText('每个账户一个，只能使用一次')).toBeVisible();
    await expect(page.getByTestId('invite-code')).toHaveCount(1);
  } finally {
    await a.patch('signup', SIGNUP, before);
  }
});

test('ledger: older entries load page by page', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  const entry = (id: number) => ({
    id, kind: 'admin_adjust', amount_cents: 100, balance_after_cents: id * 100, out_trade_no: null, reason: `e2e ${id}`, created_at: new Date().toISOString(),
  });
  await page.route(/\/api\/v1\/me\/balance(\?|$)/, (r) => {
    const q = new URL(r.request().url()).searchParams;
    if (q.get('limit') !== '30') return r.fallback();
    const before = Number(q.get('before') ?? 46);
    const ids = Array.from({ length: Math.min(30, before - 1) }, (_, i) => before - 1 - i);
    return r.fulfill({ json: { balance_cents: 4500, withdrawable_cents: 0, entries: ids.map(entry) } });
  });
  await wallet(page, '/wallet?tab=ledger');
  /* 宽屏「说明」一格就是原因，窄屏是「时间 · 原因」一行 */
  const reason = (n: number) => page.getByText(new RegExp(`(^|· )e2e ${n}$`)).filter({ visible: true });
  await expect(reason(45)).toBeVisible();
  await expect(reason(15)).toHaveCount(0);
  await page.getByRole('button', { name: '加载更早的记录' }).click();
  await expect(reason(1)).toBeVisible();
  await expect(page.getByRole('button', { name: '加载更早的记录' })).toHaveCount(0);
});

test('#19 renewal scope (expired): the page is the wallet with the ledger only; no withdrawals or invites', async ({ page }, info) => {
  const calls: string[] = [];
  page.on('request', (r) => calls.push(new URL(r.url()).pathname));
  await signIn(page, 'expired@e2e.test');
  await wallet(page, '/wallet?tab=invite', '钱包');
  await expect(page.getByText('账户余额与收支流水。余额可以在下单时抵扣。')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.locator('#panel-ledger')).toBeVisible();
  await expect(page.getByRole('button', { name: '申请提现' })).toHaveCount(0);
  await expect(page.getByText('你的邀请链接')).toHaveCount(0);
  await expect(page.getByText('套餐已到期，服务已暂停')).toHaveCount(0);
  expect(calls.filter((c) => /\/me\/(invite|invite-codes|withdrawals)$/.test(c))).toEqual([]);
  await shot(page, info, 'wallet-renewal-light');
  await dark(page);
  await shot(page, info, 'wallet-renewal-dark');
});

test('#18 banned: no wallet', async ({ page }) => {
  await signIn(page, 'banned@e2e.test');
  for (const path of ['/wallet', '/invite', '/nodes', '/traffic']) {
    await page.goto(path);
    await ready(page, '账户已被封禁');
  }
});

test('screens: the ledger (light + dark); English labels; no sideways scroll on phones', async ({ page }, info) => {
  await signIn(page, inviter(info));
  await wallet(page, '/wallet?tab=ledger');
  if (info.project.name === 'mobile') {
    for (const path of ['/wallet', '/wallet?tab=ledger', '/wallet?tab=withdrawals']) {
      await wallet(page, path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), path).toBe(true);
    }
    await wallet(page, '/wallet?tab=ledger');
  }
  await shot(page, info, 'wallet-ledger-light');
  await dark(page);
  await shot(page, info, 'wallet-ledger-dark');
  await page.evaluate(() => localStorage.setItem('akari.locale', 'en'));
  await page.reload();
  await ready(page, 'Referral');
  await expect(page.getByRole('tab', { name: 'Ledger' })).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => localStorage.removeItem('akari.locale'));
});
