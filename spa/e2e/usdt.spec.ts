/*
 * USDT 链上收款（C2）：一个 Polygon 支付方式指向模拟的 JSON-RPC 节点（scripts/mock-chain-rpc.py，面板以
 * chain_rpc_loopback=1 启动）。下单 → 订单页给出精确金额（识别尾数突出）、共用的收款地址、网络提醒 →
 * 模拟节点上出现这笔转账 → 监听达到确认数后付款，页面自己弹出付款结果。只在本用例里启用，结束时停用
 * （其他用例仍然只有一种支付方式）。
 */
import { Client, until } from './panel.ts';
import { admin, expect, mine, open, payResult, seed, signIn, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

/** 每个视口一个收款地址（同一条链上一个地址只能属于一个支付方式） */
const address = (project: string) => `0x${(project === 'mobile' ? 'b' : 'a').repeat(40)}`;

async function rpc(path: string): Promise<{ tx?: string }> {
  const r = await fetch(`${process.env.E2E_MOCK_RPC}${path}`, { method: 'POST' });
  if (!r.ok) throw new Error(`mock RPC: ${r.status}`);
  return r.json() as Promise<{ tx?: string }>;
}

test('USDT on-chain: unique exact amount on the shared address, the transfer confirmed, the order paid', async ({ page }, info) => {
  const a = await admin();
  const addr = address(info.project.name);
  const method = await a.call<{ id: string; version: number }>('POST', '/api/v1/settings/payments', {
    kind: 'usdt_chain', display_name: 'USDT（Polygon）', enabled: true,
    config: { chain: 'polygon', address: addr, rpc_urls: process.env.E2E_MOCK_RPC, rate_cents: 720, confirmations: 3 },
  });
  const email = mine(info, 'usdt');
  await a.call('POST', '/api/v1/users', { email, password: seed.password });
  try {
    await signIn(page, email);
    const order = async () => {
      await open(page, '/shop');
      await page.locator('.plan-card').filter({ hasText: seed.plan }).getByRole('button', { name: '立即订阅' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('label').filter({ hasText: 'USDT（Polygon）' }).click();
      await dialog.getByRole('button', { name: /^支付 ¥/ }).click();
      await expect(page.getByRole('heading', { name: 'USDT 转账付款' })).toBeVisible();
    };

    /* 先下一单再取消：页面说明保留期内到账仍会开通、没转的不要再转这个金额 */
    await order();
    await page.getByRole('button', { name: '取消订单' }).click();
    await expect(page.getByTestId('chain-late')).toContainText('前到账的仍会自动开通');
    await expect(page.getByTestId('chain-late')).toContainText('请不要再转这个金额');
    await page.screenshot({ path: `test-results/screens/usdt-cancelled-${info.project.name}.png`, fullPage: true });

    await order();

    /* 订单页：网络提醒、精确金额（¥15.00 ÷ 7.20 = 2.083… → 2.09，加 4 位识别尾数）、共用地址 */
    await expect(page.getByRole('heading', { name: '订单详情' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'USDT 转账付款' })).toBeVisible();
    await expect(page.getByText(/只能通过 Polygon \(PoS\) 网络转 USDT/)).toBeVisible();
    const amount = (await page.getByTestId('chain-amount').textContent())?.trim() ?? '';
    expect(amount).toMatch(/^2\.09\d{4}$/);
    expect(amount.endsWith('0000')).toBe(false);
    await expect(page.getByTestId('chain-amount').locator('span')).toHaveText(amount.slice(-4));
    /* 面板存 EIP-55 形式（大小写混合）：不分大小写比较 */
    await expect(page.getByTestId('chain-address')).toHaveText(new RegExp(`^${addr}$`, 'i'));
    await expect(page.getByText('这是本站共用的收款地址，订单按上面的精确金额识别。')).toBeVisible();
    await expect(page.getByTestId('chain-status')).toContainText('等待转账');
    await expect(page.getByTestId('chain-countdown')).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.getByText(/前到账的这笔金额仍会自动开通/)).toBeVisible();
    await page.screenshot({ path: `test-results/screens/usdt-order-${info.project.name}.png`, fullPage: true });

    /* 转账：精确金额（含尾数）。先看到「已收到，确认中 1/3」，再出两个块达到 3 个确认即入账 */
    const units = Number(amount.replace('.', ''));
    await rpc(`/control/pay?to=${addr}&units=${units}`);
    await expect(page.getByTestId('chain-status')).toContainText(/已收到转账，确认中 [12]\/3/, { timeout: 30_000 });
    await page.screenshot({ path: `test-results/screens/usdt-confirming-${info.project.name}.png`, fullPage: true });
    await rpc('/control/mine?n=2');
    await payResult(page, '支付成功', seed.plan, 45_000, `usdt-paid-${info.project.name}`);
    await expect(page.getByText('已付款').first()).toBeVisible();

    /* 面板侧：链上入账、交易号 = 交易哈希 */
    const c = await Client.user(email, seed.password);
    type Row = { status: string; chain: { transfer: { status: string } | null } | null };
    await until('the USDT order credited', async () => {
      const [o] = await c.call<Row[]>('GET', '/api/v1/me/orders');
      return o?.status === 'paid' && o.chain?.transfer?.status === 'credited';
    });
  } finally {
    const m = await a.call<{ methods: { id: string; version: number; config: Record<string, unknown> }[] }>('GET', '/api/v1/settings/payments');
    const cur = m.methods.find((x) => x.id === method.id)!;
    await a.call('PUT', `/api/v1/settings/payments/${method.id}`, {
      version: cur.version, display_name: 'USDT（Polygon）', enabled: false,
      config: { chain: 'polygon', address: addr, rate_cents: 720, confirmations: 3 },
    });
  }
});
