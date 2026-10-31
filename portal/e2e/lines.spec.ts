/*
 * 门户 v2 · PR 5：线路（/nodes）与用量明细（/traffic）。覆盖切换前 React 门户 e2e 的 subscription.spec.ts #32 #33（每个入口一行、
 * 此刻的倍率、状态与图例、维护中置灰）与 #34（按全站时区的日、按入口的倍率与时段规则）、polish.spec.ts #60（手机不横向滚动）、
 * shell / account 的范围门禁（续费范围没有线路与用量），外加：倍率排序、标签筛选、刷新、用量的范围切换、三个数与每日柱图、
 * 每日明细，以及设计评审截图（线路 / 用量 × 桌面 / 手机 × 浅 / 深）。
 * 账户：user@e2e.test（两天流量：香港 01 直连 + IPLC 中转（2×），日本 01 直连（全天 0.5×））、expired。
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { psql } from './support/panel.ts';
import { dark, expect, ready, shot, signIn, test } from './fixtures';

async function open(page: Page, path: string, title: string) {
  await page.goto(path);
  await ready(page, title);
  await expect(page.locator('main [aria-busy]')).toHaveCount(0, { timeout: 15_000 });
}

test('#32 #33 D9 D5 entrances: one row per entrance, the multiplier in effect now, status with a legend', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/nodes', '节点状态');
  const shown = (text: string) => page.getByText(text, { exact: true }).locator('visible=true').first();
  await expect(shown('IPLC')).toBeVisible();
  await expect(shown('×2')).toBeVisible();
  /* 日本 01 的直连入口全天 0.5×（时段规则，按站点时区，面板 SQL 算好） */
  await expect(shown('×0.5')).toBeVisible();
  await expect(shown('直连')).toBeVisible();
  /* 只显示入口名与标签：节点（服务器）名不出现 */
  await expect(page.getByText(/香港 01|日本 01/)).toHaveCount(0);
  /* 页头：一句大字（几条线路、几条在线）+ 刷新间隔；表下的图例：负载三档与「维护中的线路不在订阅里」；e2e 里没有 agent，线路都是离线 */
  await expect(page.locator('.page-lead')).toHaveText(/^\d+ 条线路，0 条在线$/);
  await expect(page.locator('main .pt-extra')).toContainText('每 30 秒自动刷新');
  await expect(page.locator('[data-node-legend]')).toContainText('负载高');
  await expect(page.locator('[data-node-legend]')).toContainText('维护中的线路不会出现在订阅里');
  await expect(page.locator('[data-node-status="offline"]:visible').first()).toBeVisible();
  /* 没有统计格子、搜索框 */
  await expect(page.locator('main .statrow')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);

  /* 香港 01 的服务器在线、日本 01 所在服务器流量额度用完：日本 01 仍列出来，但是「维护中」并置灰（订阅里没有它） */
  psql(`UPDATE servers s SET status = 'online', last_seen_at = now() FROM nodes n WHERE n.server_id = s.id AND n.name = '香港 01';
        UPDATE servers s SET traffic_quota_bytes = 1, traffic_quota_rx_bytes = 10 FROM nodes n WHERE n.server_id = s.id AND n.name = '日本 01';`);
  try {
    await page.getByRole('button', { name: '刷新' }).click();
    await expect(page.locator('[data-node-status="maintenance"]:visible').first()).toBeVisible();
    await expect(page.locator('[data-node-status="online"]:visible').first()).toBeVisible();
    await expect(shown('IPLC')).toBeVisible();
    await expect(shown('直连')).toBeVisible();
    await shot(page, info, 'nodes-light');
    await dark(page);
    await shot(page, info, 'nodes-dark');
  } finally {
    psql(`UPDATE servers s SET traffic_quota_bytes = NULL FROM nodes n WHERE n.server_id = s.id AND n.name = '日本 01';
          UPDATE servers s SET status = 'offline' FROM nodes n WHERE n.server_id = s.id AND n.name = '香港 01';`);
  }
});

test('lines: lowest multiplier first, the column header flips the order; the tag filter', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/nodes', '节点状态');
  const rates = () => page.locator('main .nrate:visible').allTextContents();
  await expect.poll(rates).toContain('×2');
  const asc = await rates();
  expect(asc[0]).toBe('×0.5');
  expect(asc.at(-1)).toBe('×2');
  const head = page.getByRole('columnheader', { name: /倍率/ });
  await expect(head).toHaveAttribute('aria-sort', 'ascending');
  await head.getByRole('button').click();
  await expect(head).toHaveAttribute('aria-sort', 'descending');
  expect((await rates())[0]).toBe('×2');
  /* 标签筛选：全部 + 订阅里出现的入口标签 */
  const filter = page.getByRole('group', { name: '按标签筛选' });
  await expect(filter.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
  await filter.getByRole('button', { name: 'IPLC' }).click();
  await expect(filter.getByRole('button', { name: 'IPLC' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(rates).toEqual(['×2']);
  await filter.getByRole('button', { name: '全部' }).click();
  await expect.poll(async () => (await rates()).length).toBe(asc.length);
});

test('#34 traffic history by the site\'s days, per entrance with the multiplier now', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/traffic', '流量明细');
  await expect(page.getByText(/日期按 Asia\/Shanghai 计算/)).toBeVisible();
  await expect(page.getByRole('tab', { name: '本月' })).toHaveAttribute('aria-selected', 'true');
  const line = () => page.getByText('香港 01 · 直连').first();
  await expect(line()).toBeVisible();
  await page.getByRole('tab', { name: '近 30 天' }).click();
  await expect(page.getByRole('tab', { name: '近 30 天' })).toHaveAttribute('aria-selected', 'true');
  await expect(line()).toBeVisible();
  /* 按入口，各自此刻的倍率（与时段规则），不是计费 ÷ 原始 */
  const rowOf = (name: string) => page.getByRole('row').filter({ hasText: name });
  await expect(page.getByRole('columnheader', { name: '当前倍率' })).toBeVisible();
  await expect(rowOf('香港 01 · 直连')).toContainText('×1');
  await expect(rowOf('香港 01 · IPLC')).toContainText('×2');
  await expect(rowOf('日本 01 · 直连')).toContainText('×0.5');
  await expect(rowOf('日本 01 · 直连')).toContainText('每天 00:00–24:00 ×0.5');
  await expect(page.getByText('有效倍率')).toHaveCount(0);
  /* 每日明细：30 行，最新的在上面；今天 = 两个入口的流量（直连 2 GiB + 中转 1 GiB + 日本 0.5 GiB + 上行 1 GiB） */
  await expect(page.getByText('30 天的每日上下行流量')).toBeVisible();
  const days = page.locator('section.sec').filter({ hasText: '30 天的每日上下行流量' }).locator('tbody tr');
  await expect(days).toHaveCount(30);
  await expect(days.first()).toContainText('4.50 GB');
  /* 导出 CSV：浏览器里生成的那 30 天，带 BOM，表头 + 每天一行 */
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出 CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^usage-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv.startsWith('\uFEFF日期,')).toBe(true);
  expect(csv.trimEnd().split('\r\n')).toHaveLength(31);
  await shot(page, info, 'traffic-30d-light');
});

test('traffic: three numbers and the daily bars (the dashboard\'s chart); a tooltip by keyboard', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/traffic', '流量明细');
  /* 页头一句：本期已用多少；下面三个数：今日、这段时间、计费 */
  await expect(page.locator('.page-lead')).toHaveText(/^本期已用 [\d.]+ (\/ \d+ )?GB$/);
  await expect(page.locator('.statrow > div')).toHaveCount(3);
  await expect(page.locator('.statrow')).toContainText('今日');
  await expect(page.locator('.statrow')).toContainText('计费（含倍率）');
  await page.getByRole('tab', { name: '近 7 天' }).click();
  await expect(page.getByRole('tab', { name: '近 7 天' })).toHaveAttribute('aria-selected', 'true');
  /* 每天一根柱子，最后一天写「今天」；键盘聚焦一天出提示（下行 / 上行 / 合计 / 计费） */
  const chart = page.getByRole('group', { name: '近 7 日流量，每天一项' });
  const cols = chart.getByRole('button');
  await expect(cols).toHaveCount(7);
  await expect(page.locator('.wk-x .is-today')).toContainText('今天');
  await cols.last().focus();
  const tip = page.locator('.wk-tip');
  await expect(tip).toBeVisible();
  for (const k of ['下行', '上行', '合计', '计费']) await expect(tip.getByText(k, { exact: true })).toBeVisible();
  await shot(page, info, 'traffic-light');
  await dark(page);
  await shot(page, info, 'traffic-dark');
});

test('traffic: a range with no traffic says so; the panel keeps daily rows only so far', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await page.route(/\/api\/v1\/me\/traffic\?/, (r) => {
    const q = new URL(r.request().url()).searchParams;
    return r.fulfill({
      json: {
        from: q.get('from'), to: q.get('to'), timezone: 'Asia/Shanghai', daily_since: q.get('to'),
        total: { up_bytes: 0, down_bytes: 0, billed_bytes: 0 }, days: [], entrances: [],
      },
    });
  });
  await open(page, '/traffic', '流量明细');
  await expect(page.getByText('这段时间还没有流量记录')).toBeVisible();
  await expect(page.getByText(/按天的明细只保留到 .*，更早的日子显示为 0。/)).toBeVisible();
  await expect(page.locator('.wk')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导出 CSV' })).toHaveCount(0);
});

test('#19 renewal scope: no lines or usage (back to the dashboard)', async ({ page }) => {
  await signIn(page, 'expired@e2e.test');
  for (const path of ['/nodes', '/traffic']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/$/);
    await ready(page, '仪表盘');
  }
});

test('#60 phones: lines and usage never scroll sideways', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'only narrow screens can overflow');
  await signIn(page, 'user@e2e.test');
  for (const [path, title] of [['/nodes', '节点状态'], ['/traffic', '流量明细']]) {
    await open(page, path, title);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), path).toBe(true);
  }
});
