/*
 * 钱包与邀请（research/portal-gap.md §1.5 #51–#56，R46 USDT 提现）：流水、提现（网络、地址提示、Memo、参考汇率）、
 * 撤回、通过后的实付 USDT 与交易哈希、邀请统计与邀请码、佣金追回后余额为负。
 */
import { psql } from './panel.ts';
import { admin, expect, mine, open, signIn, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TON = 'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI';

test('#51 #52 #53 USDT withdrawals: network, address hints, TON memo, reference amount; withdraw it again', async ({ page }, info) => {
  await signIn(page, mine(info, 'inviter'));
  await open(page, '/wallet');
  await expect(page.getByText('邀请佣金入账').locator('visible=true').first()).toBeVisible();
  await page.getByRole('button', { name: '申请提现' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('提现金额（元）').fill('1');
  /* 参考汇率 7.20：约 0.14 USDT */
  await expect(dialog.getByText('约 0.14 USDT（按参考汇率，以实际打款为准）')).toBeVisible();
  /* 只列后台开着的网络 */
  await dialog.getByLabel('USDT 网络').click();
  await expect(page.getByRole('option')).toHaveText(['TRC20 (Tron)', 'Polygon', 'TON']);
  await page.getByRole('option', { name: 'TON' }).click();
  await expect(dialog.getByText('TON 地址（UQ / EQ 开头）；转到交易所时请填写 Memo')).toBeVisible();
  /* 地址填错网络：面板按网络校验，给出对应文案 */
  await dialog.getByLabel('收款地址').fill(TRON);
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(page.getByText('这不是有效的 ton 地址，请核对网络与地址').first()).toBeVisible();
  await dialog.getByLabel('收款地址').fill(TON);
  await dialog.getByLabel('Memo（选填）').fill('12345');
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(page.getByText('提现申请已提交').first()).toBeVisible();
  const row = page.getByText('TON', { exact: true }).locator('visible=true').first();
  await expect(row).toBeVisible();
  await expect(page.getByText('12345').locator('visible=true').first()).toBeVisible();
  await page.getByRole('button', { name: '撤回' }).locator('visible=true').first().click();
  await expect(page.getByText('提现申请已撤回').first()).toBeVisible();
  await expect(page.getByText('已撤回').locator('visible=true').first()).toBeVisible();
});

test('#52 an approved withdrawal shows the USDT sent and the transaction hash', async ({ page }, info) => {
  const email = mine(info, 'inviter');
  await signIn(page, email);
  await open(page, '/wallet');
  await page.getByRole('button', { name: '申请提现' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('提现金额（元）').fill('1');
  await dialog.getByLabel('收款地址').fill(TRON);
  await dialog.getByRole('button', { name: '提交申请' }).click();
  await expect(page.getByText('提现申请已提交').first()).toBeVisible();

  const id = psql(`SELECT w.id FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE u.email = '${email}' AND w.status = 'pending';`);
  const txid = 'a'.repeat(64);
  await (await admin()).call('POST', `/api/v1/withdrawals/${id}/approve`, { usdt_amount: '0.138888', txid });
  await page.reload();
  await expect(page.getByText('已打款').locator('visible=true').first()).toBeVisible();
  await expect(page.getByText(/实付 0\.138888 USDT/).locator('visible=true').first()).toBeVisible();
  await expect(page.getByText(/aaaaaaaa…aaaaaaaa/).locator('visible=true').first()).toBeVisible();
});

test('#54 #55 invite: terms, stats, commissions without the invitee\'s address; codes are created and deleted', async ({ page }, info) => {
  await signIn(page, mine(info, 'inviter'));
  await open(page, '/invite');
  await expect(page.getByText('返佣比例').first()).toBeVisible();
  await expect(page.getByText('20%').first()).toBeVisible();
  await expect(page.getByText(`invitee-${info.project.name}`)).toHaveCount(0);
  await page.getByRole('button', { name: /生成邀请码|再生成一个/ }).first().click();
  await expect(page.getByText('邀请码已生成').first()).toBeVisible();
  /* 邀请链接用面板给的 link_base（主域名 + /register?invite=） */
  await expect(page.locator('input[value*="/register?invite="]').first()).toHaveValue(new RegExp(`^${process.env.E2E_ORIGIN}/register\\?invite=`));
  await page.getByRole('button', { name: '删除' }).locator('visible=true').first().click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  if (await confirm.count()) await confirm.getByRole('button', { name: /删除|确认/ }).last().click();
  await expect(page.getByText('邀请码已删除').first()).toBeVisible();
});

test('#56 a refund after the commission was credited claws it back (the balance stops at zero, the rest is owed)', async ({ page }, info) => {
  const a = await admin();
  const order = psql(`SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = '${mine(info, 'invitee')}' AND o.status = 'paid' LIMIT 1;`);
  await a.call('POST', `/api/v1/orders/${order}/refund`, { reason: 'e2e 追回', to_balance: true });
  await signIn(page, mine(info, 'inviter'));
  await open(page, '/wallet');
  await expect(page.getByText('佣金追回').locator('visible=true').first()).toBeVisible();
  await expect(page.getByText(/^[−-]¥[0-9.]+$/).locator('visible=true').first()).toBeVisible();
});
