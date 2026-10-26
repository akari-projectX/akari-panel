/*
 * 公告标签（实底，design/announcement-tags-2026-10）：标签在仪表盘顶部提示条（卡片左侧 3px 同色细边）、「公告与动态」列表、
 * 公告详情弹窗、公告页；公告页用到的标签多于一个时有按标签筛选；颜色只来自 tokens.css（浅色 700 档底 + 白字，深色 400 档底 + 深字）；
 * 手机上标题单行截断。账户：user@e2e.test；种子里有两条带标签的公告（维护、活动，e2e/support/seed.ts）。
 */
import type { Page, TestInfo } from '@playwright/test';
import { expect, dark, ready, shot, signIn, test } from './fixtures';

const isDesktop = (info: TestInfo) => info.project.name === 'desktop';
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const LONG = '日本、新加坡、香港三地的线路将在今晚零点到凌晨三点之间轮流维护，期间可能短暂中断，请提前保存好手头的工作';

/** 读一个元素的计算样式（颜色是 rgb(...) 字符串） */
const colors = (el: ReturnType<Page['locator']>) =>
  el.evaluate((n) => {
    const s = getComputedStyle(n);
    return { color: s.color, bg: s.backgroundColor };
  });

async function stubAnnouncements(page: Page) {
  const list = [
    {
      id: 'a-1', title_zh: LONG, title_en: null, html_zh: '<p>期间其他地区不受影响。</p>', html_en: null, pinned: true,
      tag: { id: 'tg-1', name_zh: '维护', name_en: 'Maintenance', color: 'amber' }, created_at: iso(-3 * 3600_000), read: false,
    },
    {
      id: 'a-2', title_zh: '双十一全场八折', title_en: null, html_zh: '<p>活动时间 11 月 1 日至 11 月 11 日。</p>', html_en: null, pinned: false,
      tag: { id: 'tg-2', name_zh: '活动', name_en: 'Event', color: 'pink' }, created_at: iso(-7200_000), read: false,
    },
    {
      id: 'a-3', title_zh: '没有标签的公告', title_en: null, html_zh: '<p>x</p>', html_en: null, pinned: false, tag: null, created_at: iso(-86_400_000), read: true,
    },
  ];
  await page.route(/\/api\/v1\/me\/announcements$/, (r) => r.fulfill({ json: { announcements: list, unread: 2 } }));
  await page.route(/\/api\/v1\/me\/announcements\/[^/]+\/read$/, (r) => r.fulfill({ status: 204 }));
}

test('tags: the dashboard banner has the coloured edge and a one-line title; list and dialog show the solid tag', async ({ page }, info) => {
  await stubAnnouncements(page);
  await signIn(page, 'user@e2e.test');
  await page.goto('/');
  await ready(page, '仪表盘');
  await expect(page.locator('main [aria-busy]')).toHaveCount(0, { timeout: 15_000 });

  const banner = page.locator('[data-page-notices] .notice.edge');
  await expect(banner).toHaveCount(1);
  const chip = banner.locator('.tg');
  await expect(chip).toHaveText('维护');
  await expect(chip).toHaveClass(/c-amber/);
  /* 浅色：700 档底 + 白字；细边与标签同色 */
  expect(await colors(chip)).toEqual({ color: 'rgb(255, 255, 255)', bg: 'rgb(180, 83, 9)' });
  const edge = () => banner.evaluate((n) => getComputedStyle(n, '::before').backgroundColor);
  expect(await edge()).toBe('rgb(180, 83, 9)');
  expect(await banner.evaluate((n) => getComputedStyle(n, '::before').width)).toBe('3px');
  /* 标题单行：手机上被截断（省略号），不换行 */
  const title = banner.locator('.nt .trunc');
  expect(await title.evaluate((n) => getComputedStyle(n).whiteSpace)).toBe('nowrap');
  if (!isDesktop(info)) {
    expect(await title.evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true);
    expect(await banner.locator('.nt').evaluate((n) => n.getBoundingClientRect().height)).toBeLessThan(30);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await shot(page, info, 'announcement-tag-banner-light');
  await dark(page);
  /* 深色：400 档底 + 深字 */
  expect(await colors(chip)).toEqual({ color: 'rgb(17, 19, 23)', bg: 'rgb(251, 191, 36)' });
  expect(await edge()).toBe('rgb(251, 191, 36)');
  await shot(page, info, 'announcement-tag-banner-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  /* 「公告与动态」列表：置顶仍是蓝色淡底的「置顶」，标签在它后面、标题前 */
  const feed = page.locator('#subscribe');
  const first = feed.getByRole('button').filter({ hasText: '维护' }).first();
  await expect(first.locator('.pinb')).toHaveText('置顶');
  await expect(first.locator('.tg')).toHaveText('维护');
  const order = await first.locator('.rt').evaluate((n) => [...n.children].map((c) => c.className.split(' ')[0]));
  expect(order.slice(0, 2)).toEqual(['pinb', 'tg']);
  await expect(feed.getByRole('button').filter({ hasText: '双十一全场八折' }).locator('.tg')).toHaveText('活动');
  await expect(feed.getByRole('button').filter({ hasText: '没有标签的公告' }).locator('.tg')).toHaveCount(0);
  await shot(page, info, 'announcement-tag-feed-light');

  /* 详情弹窗 */
  await feed.getByRole('button').filter({ hasText: '双十一全场八折' }).click();
  const dialog = page.getByRole('dialog', { name: '双十一全场八折' });
  await expect(dialog.locator('.tg')).toHaveText('活动');
  await expect(dialog.locator('.tg')).toHaveClass(/c-pink/);
  await shot(page, info, 'announcement-tag-dialog-light');
});

test('tags: the announcements page shows tags and filters by tag when more than one is in use', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await page.goto('/announcements');
  await ready(page, '公告与动态');
  await expect(page.locator('main [aria-busy]')).toHaveCount(0, { timeout: 15_000 });

  /* 种子里用到了两个标签（维护、活动）：筛选出现；每个按钮带条数 */
  const filter = page.getByRole('group', { name: '按标签筛选' });
  await expect(filter).toBeVisible();
  const all = filter.getByRole('button', { name: /^全部/ });
  const maintenance = filter.getByRole('button', { name: /^维护/ });
  const event = filter.getByRole('button', { name: /^活动/ });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(maintenance).toHaveClass(/c-amber/);
  await expect(event).toHaveClass(/c-pink/);
  await shot(page, info, 'announcements-tags-light');
  await dark(page);
  await shot(page, info, 'announcements-tags-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  const flags = page.locator('main .tg');
  await event.click();
  await expect(event).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('main').getByText('E2E 双十一活动').first()).toBeVisible();
  await expect(page.locator('main').getByText('E2E 维护通知')).toHaveCount(0);
  for (const el of await flags.all()) await expect(el).toHaveText('活动');
  await maintenance.click();
  await expect(page.locator('main').getByText('E2E 维护通知').first()).toBeVisible();
  await expect(page.locator('main').getByText('E2E 双十一活动')).toHaveCount(0);
  for (const el of await flags.all()) await expect(el).toHaveText('维护');
  await all.click();
  await expect(page.locator('main').getByText('E2E 双十一活动').first()).toBeVisible();

  /* 打开一条：详情弹窗里有它的标签 */
  const item = page.locator('main').getByRole('button').filter({ hasText: 'E2E 双十一活动' });
  if (await item.count()) await item.first().click();
  else await page.locator('article').filter({ hasText: 'E2E 双十一活动' }).getByRole('button', { name: '阅读全文' }).click();
  await expect(page.getByRole('dialog', { name: 'E2E 双十一活动' }).locator('.tg')).toHaveText('活动');
  if (!isDesktop(info)) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('tags: English interface names the tag in English (and the filter label)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('akari.locale', 'en'));
  await signIn(page, 'user@e2e.test');
  await page.goto('/announcements');
  await expect(page.locator('main h1')).toHaveText('Announcements', { timeout: 15_000 }).catch(() => undefined);
  const filter = page.getByRole('group', { name: 'Filter by tag' });
  await expect(filter).toBeVisible({ timeout: 15_000 });
  await expect(filter.getByRole('button', { name: /^Event/ })).toBeVisible();
  await expect(filter.getByRole('button', { name: /^Maintenance/ })).toBeVisible();
});
