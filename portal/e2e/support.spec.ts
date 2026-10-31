/*
 * 门户 v2 · PR 6：工单、公告、文档（知识库）。覆盖切换前 React 门户 support.spec.ts #57–#59 与 polish.spec.ts #57 的全部场景，
 * 外加：工单 ?id= 直达、封禁账户的工单（没有「关联订单」）、关闭后的说明、文档的设备捷径 / 未读点 / 上一篇下一篇 / 窄屏目录，
 * 以及设计评审截图（桌面 / 手机 × 浅 / 深）。
 * 账户：refund@e2e.test（有订单，工单可以关联）、user@e2e.test（公告、文档）、banned@e2e.test。
 */
import type { Page, TestInfo } from '@playwright/test';
import { psql } from './support/panel.ts';
import { admin, dark, expect, ready, shot, signIn, test } from './fixtures';

test.describe.configure({ mode: 'serial' });

const isDesktop = (info: TestInfo) => info.project.name === 'desktop';

/** 打开一页，等到每一块都取完（没有 aria-busy 的占位） */
async function open(page: Page, path: string, title: string) {
  await page.goto(path);
  await ready(page, title);
  await expect(page.locator('main [aria-busy]')).toHaveCount(0, { timeout: 15_000 });
}

const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test('#57 tickets: inline errors; category, priority, linked order; reply, the staff answer is unread, close', async ({ page }, info) => {
  await signIn(page, 'refund@e2e.test');
  await open(page, '/tickets', '支持');
  await page.getByRole('button', { name: '提交工单' }).first().click();
  const form = page.getByRole('dialog', { name: '提交新工单' });
  /* 空着提交：内联错误，第一个出错的字段被聚焦，按钮不预先置灰（polish #57） */
  await form.getByRole('button', { name: '提交工单' }).click();
  await expect(form.getByText('请填写问题标题')).toBeVisible();
  await expect(form.getByText('请描述遇到的问题')).toBeVisible();
  await expect(form.getByLabel('问题标题')).toBeFocused();
  const subject = `E2E v2 工单 ${info.project.name} ${Date.now()}`;
  await form.getByLabel('问题标题').fill(subject);
  await expect(form.getByText('请填写问题标题')).toHaveCount(0);
  await form.getByLabel('分类').click();
  await page.getByRole('option', { name: '账单与付款' }).click();
  await form.getByLabel('关联订单').click();
  await expect(page.getByRole('option')).not.toHaveCount(1);
  await page.getByRole('option').nth(1).click();
  await form.getByText('高', { exact: true }).click();
  await expect(form.getByText('无法正常使用')).toBeVisible();
  await form.getByLabel('详细描述').fill('退款没收到，请帮忙看看。');
  await expect(form.getByText('还能写 4988 字')).toBeVisible();
  await shot(page, info, 'tickets-new');
  await form.getByRole('button', { name: '提交工单' }).click();

  /* 新工单直接打开：消息、分类与优先级、关联订单 */
  const thread = page.getByRole('dialog', { name: subject });
  await expect(thread.getByText('退款没收到，请帮忙看看。')).toBeVisible();
  for (const m of ['账单与付款', '高优先级', '待处理']) await expect(thread.getByText(m, { exact: true }).first()).toBeVisible();
  await expect(thread.getByText(/^关联订单 /)).toBeVisible();
  await thread.getByLabel('回复此工单…').fill('补充：订单号见关联订单。');
  await thread.getByRole('button', { name: '发送' }).click();
  await expect(thread.getByText('补充：订单号见关联订单。')).toBeVisible();
  await expect(thread.getByLabel('回复此工单…')).toHaveValue('');

  /* 客服回复：列表标未读（品牌蓝点 + 读屏文字），打开即已读 */
  const a = await admin();
  const list = await a.call<{ tickets: { id: string; subject: string }[] }>('GET', '/api/v1/tickets');
  const id = list.tickets.find((x) => x.subject === subject)?.id ?? '';
  await a.call('POST', `/api/v1/tickets/${id}/replies`, { message: '已经原路退回了，请查收。' });
  await page.keyboard.press('Escape');
  await expect(thread).toHaveCount(0);
  await page.reload();
  await ready(page, '支持');
  const row = page.locator('main button.rowline').filter({ hasText: subject });
  await expect(row.getByText('已回复')).toBeVisible();
  await expect(row.getByText('客服有新回复')).toHaveCount(1);
  await shot(page, info, 'tickets-light');
  await dark(page);
  await shot(page, info, 'tickets-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await row.click();
  await expect(thread.getByText('已经原路退回了，请查收。')).toBeVisible();
  await expect(thread.getByText('客服', { exact: true })).toBeVisible();
  await shot(page, info, 'tickets-thread');
  /* 打开即已读：列表上的未读点去掉 */
  await expect(row.getByText('客服有新回复')).toHaveCount(0);

  /* 关闭不能撤销：先确认 */
  await thread.getByRole('button', { name: '问题已解决，关闭工单' }).click();
  const confirm = page.getByRole('alertdialog', { name: '关闭这张工单？' });
  await expect(confirm.getByText('关闭后不能再回复')).toBeVisible();
  await confirm.getByRole('button', { name: '关闭工单' }).click();
  await expect(page.getByText('工单已关闭').first()).toBeVisible();
  await expect(page.getByRole('dialog').or(page.getByRole('alertdialog'))).toHaveCount(0);

  /* ?id= 直达（仪表盘「客服回复了」的链接）：打开那一张，参数去掉；已关闭的只说明请新开一张 */
  await page.goto(`/tickets?id=${id}`);
  await expect(thread.getByText('这张工单已关闭，如果问题再次出现，请新开一张。')).toBeVisible();
  await expect(thread.getByLabel('回复此工单…')).toHaveCount(0);
  await expect(page).toHaveURL(/\/tickets$/);
  await page.keyboard.press('Escape');
  await expect(row.getByText('已关闭')).toBeVisible();
  if (!isDesktop(info)) await noSideways(page);
});

test('#18 tickets for a banned account: no linked order (it cannot see orders)', async ({ page }) => {
  await signIn(page, 'banned@e2e.test');
  await open(page, '/tickets', '支持');
  await page.getByRole('button', { name: '提交工单' }).first().click();
  const form = page.getByRole('dialog', { name: '提交新工单' });
  await expect(form.getByLabel('分类')).toBeVisible();
  await expect(form.getByLabel('关联订单')).toHaveCount(0);
});

test('#58 announcements: unread first, the panel\'s HTML, read state kept by the server', async ({ page }, info) => {
  const title = `E2E v2 公告 ${info.project.name} ${Date.now()}`;
  await (await admin()).call('POST', '/api/v1/announcements', {
    title_zh: title, title_en: null, body_zh: '新的 **线路** 已上线。', body_en: null, pinned: false,
  });
  await signIn(page, 'user@e2e.test');
  await open(page, '/announcements', '公告与动态');
  await expect(page.locator('main').getByText('条未读').first()).toBeVisible();
  /* 置顶的在前（种子数据的维护通知）；最新的一条是头条 */
  await expect(page.getByText('置顶').first()).toBeVisible();
  await shot(page, info, 'announcements-light');
  await dark(page);
  await shot(page, info, 'announcements-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  const item = page.locator('main').getByRole('button').filter({ hasText: title });
  if (await item.count()) await item.first().click();
  else await page.locator('article').filter({ hasText: title }).getByRole('button', { name: '阅读全文' }).click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog.locator('strong', { hasText: '线路' })).toBeVisible();
  await shot(page, info, 'announcements-dialog');
  await dialog.getByRole('button', { name: '我知道了' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => psql(`SELECT count(*) FROM announcement_reads r JOIN announcements a ON a.id = r.announcement_id WHERE a.title_zh = '${title}';`)).toBe('1');
  await page.reload();
  await ready(page, '公告与动态');
  if (!isDesktop(info)) await noSideways(page);
});

test('#59 docs: categories wrap (none cut off), the device line, search, an article with a table of contents', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await page.evaluate(() => { try { localStorage.removeItem('akari.read.kb'); } catch { /* 无 */ } });
  await open(page, '/help', '使用指南');
  await expect(page.getByRole('link', { name: '提交工单' })).toHaveAttribute('href', '/tickets');
  await expect(page.getByText(/客户端下载、连接指南/)).toHaveCount(0);
  /* 设备捷径不重复「教程」（分类名已以「教程」结尾）；没有下载链接、没有「复制订阅地址」 */
  await expect(page.getByText(/教程\s+教程/)).toHaveCount(0);
  await expect(page.getByText(/^你正在使用 /)).toBeVisible();
  await expect(page.getByRole('link', { name: /下载 .* 客户端/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制订阅地址' })).toHaveCount(0);
  const nav = page.locator('nav[aria-label="文档分类"]');
  await expect(nav.getByRole('button')).toHaveCount(8);
  const heading = page.getByTestId('docs-heading');
  await expect(heading).toHaveText(/^全部文档 · \d+ 篇$/);
  const navBox = await nav.boundingBox();
  const gap = ((await heading.boundingBox())?.y ?? 0) - ((navBox?.y ?? 0) + (navBox?.height ?? 0));
  expect(gap).toBeGreaterThanOrEqual(32);
  /* 每个分类都完整地在视口里（换行排开，不被截断） */
  const width = page.viewportSize()?.width ?? 0;
  for (const b of await nav.getByRole('button').all()) {
    const box = await b.boundingBox();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);
  }
  /* 没打开过的文档标蓝点 */
  const first = page.locator('main button.card').filter({ hasText: 'E2E 第一篇' });
  await expect(first.locator('.ud')).toHaveCount(1);
  await shot(page, info, 'help-light');
  await dark(page);
  await shot(page, info, 'help-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await nav.getByRole('button', { name: /iOS 与 iPadOS 教程/ }).click();
  await expect(nav.getByRole('button', { name: /iOS 与 iPadOS 教程/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/cat=/);
  await expect(page.getByText(/在 iPhone 上用 Shadowrocket/).first()).toBeVisible();
  await expect(page.getByText('E2E 第一篇')).toHaveCount(0);
  await expect(heading).toHaveText(/^iOS 与 iPadOS 教程 · 1 篇$/);
  await nav.getByRole('button', { name: /全部/ }).click();

  const search = page.getByRole('searchbox', { name: '搜索文档' });
  await search.fill('下载客户端');
  await search.press('Enter');
  await expect(page.getByText(/关于「下载客户端」的搜索结果：找到 1 篇匹配文档/)).toBeVisible();
  await expect(heading).toHaveText('搜索结果 · 1 篇');
  await page.getByText('E2E 第一篇').first().click();
  await expect(page.getByRole('heading', { name: '安装' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'E2E 第一篇' })).toBeVisible();
  await expect(page.getByText(/约 \d+ 分钟读完/)).toBeVisible();
  await expect(page.getByText('本页目录').locator('visible=true').first()).toBeVisible();
  /* 目录跳到章节 */
  if (isDesktop(info)) {
    await page.locator('aside').getByRole('link', { name: '导入订阅' }).click();
  } else {
    await page.locator('details').getByText('本页目录').click();
    await page.locator('details').getByRole('link', { name: '导入订阅' }).click();
  }
  await expect(page.getByRole('heading', { name: '导入订阅' })).toBeInViewport();
  /* 面包屑回到列表；读过的文档不再标蓝点 */
  await page.getByRole('navigation', { name: '使用指南' }).getByRole('button', { name: '使用指南' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '使用指南' })).toBeVisible();
  await expect(first.locator('.ud')).toHaveCount(0);
});

test('docs: a long article (code, quote, nested headings), copy the subscription link, no sideways scroll; screens', async ({ page, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, 'user@e2e.test');
  await open(page, '/help?cat=' + encodeURIComponent('iOS 与 iPadOS 教程'), '使用指南');
  await page.getByText(/在 iPhone 上用 Shadowrocket/).first().click();
  await expect(page.getByRole('heading', { level: 1, name: /在 iPhone 上用 Shadowrocket/ })).toBeVisible();
  await expect(page.locator('main pre')).toBeVisible();
  await expect(page.getByRole('link', { name: '帮助中心' })).toHaveAttribute('href', '/help');
  /* 复制订阅链接（有订阅的账户） */
  await page.getByRole('button', { name: '复制订阅链接' }).click();
  await expect(page.getByText('订阅链接已复制').first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^https?:\/\//);
  if (!isDesktop(info)) await noSideways(page);
  await shot(page, info, 'help-article-light');
  await dark(page);
  await shot(page, info, 'help-article-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  /* 同一分类只有这一篇：没有上一篇 / 下一篇 */
  await expect(page.getByRole('button', { name: /上一篇|下一篇/ })).toHaveCount(0);
  await page.getByRole('navigation', { name: '使用指南' }).getByRole('button', { name: '使用指南' }).click();
  await ready(page, '使用指南');
});
