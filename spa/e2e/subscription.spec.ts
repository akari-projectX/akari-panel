/*
 * 订阅与节点（research/portal-gap.md §1.3 #27–#34，D5、D9、D11 随机订阅路径、W30 格式与导入开关）。
 */
import type { Page } from '@playwright/test';
import { psql } from './panel.ts';
import { admin, expect, mine, open, signIn, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

/** 「复制订阅链接」后剪贴板里的地址 */
async function copiedLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: '复制订阅链接' }).first().click();
  await expect(page.getByText('订阅地址已复制').first()).toBeVisible();
  return page.evaluate(() => navigator.clipboard.readText());
}

test('#27 #30 D11: the link is the panel\'s random subscription path, it works, a reset replaces it', async ({ page, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, mine(info, 'shop'));
  const link = await copiedLink(page);
  const url = new URL(link);
  expect(url.origin).toBe(process.env.E2E_ORIGIN);
  const subPath = psql('SELECT sub_path FROM access_settings;');
  expect(url.pathname.split('/')[1]).toBe(subPath);
  expect(subPath).not.toBe('sub');
  /* 二维码就是这条地址（本地生成的 SVG，不出浏览器） */
  await expect(page.locator('svg:has(> title)').filter({ hasText: '订阅二维码' }).locator('visible=true').first()).toBeVisible();
  /* 订阅地址真的能用：直接问面板 */
  const r = await fetch(`${process.env.E2E_API}${url.pathname}?format=clash`);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('proxies:');

  await open(page, '/account?tab=security');
  await page.getByRole('button', { name: '重置订阅' }).click();
  await page.getByRole('button', { name: '确认重置' }).click();
  await expect(page.getByText('订阅已重置').first()).toBeVisible();
  const next = await copiedLink(page);
  expect(next).not.toBe(link);
  expect((await fetch(`${process.env.E2E_API}${url.pathname}`)).status).toBe(404);
});

test('#28 #29 W30: formats and import buttons follow the site switches', async ({ page }) => {
  const a = await admin();
  await signIn(page, 'user@e2e.test');
  await page.getByRole('button', { name: '订阅格式' }).click();
  for (const f of ['自动识别', 'Clash / mihomo', 'sing-box', '通用链接']) {
    await expect(page.getByRole('menuitem', { name: f })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Clash Verge / mihomo' })).toBeVisible();

  const cur = await a.call<{ version: number }>('GET', '/api/v1/settings');
  await a.call('PUT', '/api/v1/settings/subscription', { version: cur.version, formats: ['clash', 'links'], import_clients: ['stash', 'sing-box'] });
  try {
    await page.reload();
    await page.getByRole('button', { name: '订阅格式' }).click();
    await expect(page.getByRole('menuitem', { name: 'sing-box' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: '通用链接' })).toBeVisible();
    await page.keyboard.press('Escape');
    /* sing-box 格式关了：它的导入按钮也不给（面板按开着的格式筛） */
    await expect(page.getByRole('button', { name: 'Stash' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'sing-box' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clash Verge / mihomo' })).toHaveCount(0);
  } finally {
    const now = await a.call<{ version: number }>('GET', '/api/v1/settings');
    await a.call('PUT', '/api/v1/settings/subscription', { version: now.version, formats: null, import_clients: null });
  }
});

test('#31 the current plan: quota, reset period and next reset, expiry, speed', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/account');
  await expect(page.getByText('E2E 标准').first()).toBeVisible();
  await expect(page.getByText('100 GB').first()).toBeVisible();
  await expect(page.getByText('每月重置流量')).toBeVisible();
  await expect(page.getByText('300 Mbps')).toBeVisible();
});

test('#32 #33 D9 D5 entrances: one row per entrance, the multiplier in effect now, a server over its quota is gone', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/nodes');
  await expect(page.getByRole('heading', { name: '节点状态' })).toBeVisible();
  /* 桌面是表格、手机是列表（另一份隐藏着）：只看看得见的那份 */
  const shown = (text: string) => page.getByText(text, { exact: true }).locator('visible=true').first();
  await expect(shown('IPLC')).toBeVisible();
  await expect(shown('×2')).toBeVisible();
  /* 日本 01 的直连入口全天 0.5×（时段规则，按站点时区，面板 SQL 算好） */
  await expect(shown('×0.5')).toBeVisible();
  await expect(shown('日本 01')).toBeVisible();

  /* D5：日本 01 所在服务器流量额度用完 → 它的入口不再出现在门户里 */
  psql(`UPDATE servers s SET traffic_quota_bytes = 1, traffic_quota_rx_bytes = 10 FROM nodes n WHERE n.server_id = s.id AND n.name = '日本 01';`);
  try {
    await page.reload();
    await expect(shown('IPLC')).toBeVisible();
    await expect(page.getByText('日本 01', { exact: true })).toHaveCount(0);
  } finally {
    psql(`UPDATE servers s SET traffic_quota_bytes = NULL FROM nodes n WHERE n.server_id = s.id AND n.name = '日本 01';`);
  }
});

test('#34 traffic history by the site\'s days, per entrance with the multiplier now', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/traffic');
  await expect(page.getByRole('heading', { name: '使用明细' })).toBeVisible();
  await expect(page.getByText(/日期按 Asia\/Shanghai 计算/)).toBeVisible();
  const line = () => page.getByText('香港 01').locator('visible=true').first();
  await expect(line()).toBeVisible();
  await page.getByRole('tab', { name: '近 30 天' }).click();
  await expect(line()).toBeVisible();
  // Per entrance, each with the multiplier in effect now (and its time-window
  // rules), never a billed ÷ raw ratio mixing a 1× direct and a 2× relay.
  const rowOf = (name: string) => page.getByRole('row').filter({ hasText: name });
  await expect(page.getByRole('columnheader', { name: '当前倍率' })).toBeVisible();
  await expect(rowOf('香港 01 · 直连')).toContainText('×1');
  await expect(rowOf('香港 01 · IPLC')).toContainText('×2');
  await expect(rowOf('日本 01 · 直连')).toContainText('×0.5');
  await expect(rowOf('日本 01 · 直连')).toContainText('每天 00:00–24:00 ×0.5');
  await expect(page.getByText('有效倍率')).toHaveCount(0);
});
