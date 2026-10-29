/*
 * 门户 v2 · PR 5：线路（/nodes）与用量明细（/traffic）。覆盖切换前 React 门户 e2e 的 subscription.spec.ts #32 #33（每个入口一行、
 * 此刻的倍率、状态与图例、维护中置灰）与 #34（按全站时区的日、按入口的倍率与时段规则）、polish.spec.ts #60（手机不横向滚动）、
 * shell / account 的范围门禁（续费范围没有线路与用量），外加：倍率排序、搜索与空结果、刷新、用量的范围切换与平滑面积图、
 * 每日明细，以及设计评审截图（线路 / 用量 × 桌面 / 手机 × 浅 / 深）。
 * 账户：user@e2e.test（两天流量：香港 01 直连 + IPLC 中转（2×），日本 01 直连（全天 0.5×））、expired。
 */
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
  /* 图例说明三种状态与负载 / 延迟的来源；e2e 里没有 agent，线路都是离线 */
  await expect(page.locator('[data-node-legend]')).toContainText('维护中');
  await expect(page.locator('[data-node-legend]')).toContainText('每 30 秒自动刷新');
  await expect(page.locator('[data-node-status="offline"]:visible').first()).toBeVisible();
  await expect(page.getByText('最低倍率')).toBeVisible();
  await expect(page.getByText('客户端会自动跳过')).toBeVisible();

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

test('lines: lowest multiplier first, the column header flips the order; search by name, region or tag; no match', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/nodes', '节点状态');
  const rates = () => page.locator('main .rate:visible').allTextContents();
  await expect.poll(rates).toContain('×2');
  const asc = await rates();
  expect(asc[0]).toBe('×0.5');
  expect(asc.at(-1)).toBe('×2');
  if (info.project.name === 'desktop') {
    await expect(page.getByText(/点击「倍率」列可切换排序/)).toBeVisible();
    const head = page.getByRole('columnheader', { name: /流量倍率/ });
    await expect(head).toHaveAttribute('aria-sort', 'ascending');
    await head.getByRole('button').click();
    await expect(head).toHaveAttribute('aria-sort', 'descending');
    expect((await rates())[0]).toBe('×2');
  } else {
    await expect(page.getByText(/按倍率从低到高排列/)).toBeVisible();
  }
  const search = page.getByLabel('搜索线路、地区或标签');
  await search.fill('iplc');
  await expect.poll(rates).toEqual(['×2']);
  await search.fill('没有这条线路');
  await expect(page.getByText('没有匹配的线路')).toBeVisible();
  await search.fill('');
  await expect.poll(async () => (await rates()).length).toBe(asc.length);
});

test('#34 traffic history by the site\'s days, per entrance with the multiplier now', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/traffic', '使用明细');
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
  /* 种子写在「种子那天」：跑到站点时区的午夜之后，它就是第二行（最上面是新的一天，0 流量） */
  await expect(days.filter({ hasText: '4.50 GB' })).toHaveCount(1);
  await expect(days.nth(0).or(days.nth(1)).filter({ hasText: '4.50 GB' })).toHaveCount(1);
  await shot(page, info, 'traffic-30d-light');
});

test('traffic charts: area, donut and daily bars; a tooltip by keyboard', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/traffic', '使用明细');
  await page.getByRole('tab', { name: '近 7 天' }).click();
  await expect(page.getByText(/至 .*，按天统计/)).toBeVisible();
  const chart = page.getByRole('slider', { name: '流量走势，用左右方向键逐日查看' });
  /* 下行 / 上行两条曲线；横轴首尾保留：最后一天（今天）一定有标签 */
  await expect(chart.locator('path.rc-ln')).toHaveCount(2);
  await expect(chart.locator('text.rc-t').last()).toHaveText(/^\d\d-\d\d$/);
  await chart.focus();
  await page.keyboard.press('ArrowLeft');
  const tip = chart.getByRole('status');
  await expect(tip).toBeVisible();
  for (const k of ['下行流量', '上行流量']) await expect(tip.getByText(k, { exact: true })).toBeVisible();
  await expect(chart).toHaveAttribute('aria-valuenow', '6');
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
  /* 柱状图：每天一根，键盘同样可逐日看 */
  const bars = page.getByRole('slider', { name: '每日计费流量，用左右方向键逐日查看' });
  await bars.focus();
  await page.keyboard.press('End');
  await expect(bars.getByRole('status')).toBeVisible();
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
  await open(page, '/traffic', '使用明细');
  await expect(page.getByText('这段时间还没有流量记录')).toBeVisible();
  await expect(page.getByText(/按天的明细只保留到 .*，更早的日子显示为 0。/)).toBeVisible();
  await expect(page.getByRole('slider')).toHaveCount(0);
  await expect(page.getByText('明细记录')).toHaveCount(0);
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
  for (const [path, title] of [['/nodes', '节点状态'], ['/traffic', '使用明细']]) {
    await open(page, path, title);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), path).toBe(true);
  }
});
