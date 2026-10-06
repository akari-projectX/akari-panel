/*
 * 工单、公告、知识库、仪表盘（research/portal-gap.md §1.6 #57–#60），条款 / 隐私页，以及门户的边界：
 * 只有路由表里的路径有页面、门户从不请求后台、页脚品牌与客户端下载来自后台设置。
 */
import { FIELDS, psql } from './panel.ts';
import { admin, expect, open, signIn, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

test('#57 tickets: category, priority, linked order; reply, the staff answer is unread, close', async ({ page }) => {
  await signIn(page, 'refund@e2e.test');
  await open(page, '/tickets');
  await page.getByRole('button', { name: '提交工单' }).first().click();
  const subject = `E2E 工单 ${Date.now()}`;
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('问题标题').fill(subject);
  await dialog.getByLabel('分类').click();
  await page.getByRole('option', { name: '账单与付款' }).click();
  await dialog.getByLabel('关联订单').click();
  await page.getByRole('option').nth(1).click();
  await dialog.locator('label').filter({ hasText: /^高$/ }).click();
  await dialog.getByLabel('详细描述').fill('退款没收到，请帮忙看看。');
  await dialog.getByRole('button', { name: '提交工单' }).click();
  await expect(page.getByRole('dialog').getByText('退款没收到，请帮忙看看。')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('高优先级').or(page.getByRole('dialog').getByText(/账单与付款/)).first()).toBeVisible();
  await page.getByLabel('回复此工单…').fill('补充：订单号见关联订单。');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('补充：订单号见关联订单。')).toBeVisible();

  /* 客服回复：列表标未读，打开即已读 */
  const a = await admin();
  const list = await a.call<{ tickets: { id: string; subject: string }[] }>('GET', '/api/v1/tickets');
  const t = list.tickets.find((x) => x.subject === subject);
  await a.call('POST', `/api/v1/tickets/${t?.id}/replies`, { message: '已经原路退回了，请查收。' });
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByText('已回复').locator('visible=true').first()).toBeVisible();
  await page.getByText(subject).locator('visible=true').first().click();
  await expect(page.getByText('已经原路退回了，请查收。')).toBeVisible();
  await page.getByRole('button', { name: '问题已解决，关闭工单' }).click();
  await expect(page.getByText('工单已关闭').first()).toBeVisible();
});

test('#58 announcements: unread first, the panel\'s HTML, read state kept by the server', async ({ page }, info) => {
  const title = `E2E 公告 ${info.project.name} ${Date.now()}`;
  await (await admin()).call('POST', '/api/v1/announcements', {
    title_zh: title, title_en: null, body_zh: '新的 **线路** 已上线。', body_en: null, pinned: false,
  });
  await signIn(page, 'user@e2e.test');
  await open(page, '/announcements');
  await expect(page.getByText('条未读').first()).toBeVisible();
  const card = page.getByText(title).locator('visible=true').first();
  await card.click();
  const dialog = page.getByRole('dialog');
  if (!(await dialog.count())) await page.getByRole('button', { name: '阅读全文' }).locator('visible=true').first().click();
  await expect(page.getByRole('dialog').locator('strong', { hasText: '线路' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect.poll(() => psql(`SELECT count(*) FROM announcement_reads r JOIN announcements a ON a.id = r.announcement_id WHERE a.title_zh = '${title}';`)).toBe('1');
});

test('#59 knowledge base: categories wrap (none cut off), search, article with a table of contents', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await open(page, '/help');
  await expect(page.getByRole('heading', { name: '使用手册' })).toBeVisible();
  const nav = page.locator('nav[aria-label="文档分类"]');
  await expect(nav.getByRole('button')).toHaveCount(8);
  /* 每个分类都完整地在视口里（换行排开，不被截断） */
  const width = page.viewportSize()?.width ?? 0;
  for (const b of await nav.getByRole('button').all()) {
    const box = await b.boundingBox();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);
  }

  await nav.getByRole('button', { name: /iOS 与 iPadOS 教程/ }).click();
  await expect(page.getByText(/在 iPhone 上用 Shadowrocket/).first()).toBeVisible();
  await expect(page.getByText('E2E 第一篇')).toHaveCount(0);
  await nav.getByRole('button', { name: /全部/ }).click();

  await page.getByRole('searchbox', { name: '搜索文档' }).fill('下载客户端');
  await page.getByRole('searchbox', { name: '搜索文档' }).press('Enter');
  await expect(page.getByText(/关于「下载客户端」的搜索结果：找到 1 篇匹配文档/)).toBeVisible();
  await page.getByText('E2E 第一篇').first().click();
  await expect(page.getByRole('heading', { name: '安装' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'E2E 第一篇' })).toBeVisible();
  await expect(page.getByText('本页目录').locator('visible=true').first()).toBeVisible();
  await page.getByRole('navigation', { name: '使用手册' }).getByRole('button', { name: '使用手册' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '使用手册' })).toBeVisible();
});

test('#60 dashboard: plan, days left, traffic left, subscription, announcements', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  await expect(page.getByText('套餐剩余').first()).toBeVisible();
  await expect(page.getByText('剩余流量').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '复制订阅链接' }).first()).toBeVisible();
  await expect(page.getByText('E2E 维护通知').first()).toBeVisible();
});

test('#14 #15 branding: footer text and links, external terms link, client downloads, site name in titles', async ({ page }) => {
  const a = await admin();
  const before = await a.patch('branding', FIELDS.branding, {
    footer_text: 'E2E 页脚文字', footer_links: [{ label: 'E2E 状态页', url: 'https://status.example.com' }],
    tos_url: 'https://example.com/tos', client_downloads: [{ platform: 'windows', label: 'E2E 客户端', url: 'https://example.com/client.exe' }],
  });
  try {
    await signIn(page, 'user@e2e.test');
    await expect(page.getByText('E2E 页脚文字')).toBeVisible();
    await expect(page.getByRole('link', { name: 'E2E 状态页' })).toHaveAttribute('href', 'https://status.example.com');
    await expect(page.getByRole('link', { name: '服务条款' })).toHaveAttribute('href', 'https://example.com/tos');
    await page.getByRole('button', { name: '下载客户端' }).first().click();
    await expect(page.getByRole('menuitem', { name: /E2E 客户端/ })).toBeVisible();
  } finally {
    await a.patch('branding', FIELDS.branding, before);
  }
});

test('#61 terms and privacy: the site\'s own text, a neutral default until it is written', async ({ page }) => {
  for (const [path, title] of [['/terms', '服务条款'], ['/privacy', '隐私政策']]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByText(/尚未发布这份文件。如有疑问，请登录后提交工单联系我们。/)).toBeVisible();
  }
  /* 站长在知识库里写了 slug 为 terms 的已发布文章：条款页显示它；隐私只有草稿，仍是缺省文案 */
  const a = await admin();
  const terms = await a.call<{ id: string }>('POST', '/api/v1/kb/articles', {
    title_zh: 'E2E 服务条款', body_zh: '本站条款 **正文**', published: true, slug: 'terms',
  });
  const draft = await a.call<{ id: string }>('POST', '/api/v1/kb/articles', {
    title_zh: 'E2E 隐私草稿', body_zh: '草稿', published: false, slug: 'privacy',
  });
  try {
    await page.goto('/terms');
    await expect(page.getByRole('heading', { level: 1, name: 'E2E 服务条款' })).toBeVisible();
    await expect(page.locator('strong', { hasText: '正文' })).toBeVisible();
    await expect(page.getByText('最后更新')).toBeVisible();
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { level: 1, name: '隐私政策' })).toBeVisible();
    await expect(page.getByText(/尚未发布这份文件/)).toBeVisible();
  } finally {
    await a.call('DELETE', `/api/v1/kb/articles/${terms.id}`);
    await a.call('DELETE', `/api/v1/kb/articles/${draft.id}`);
  }
});

test('the portal\'s edges: unknown paths are the canonical rejection, the portal never calls the console', async ({ page }) => {
  const prefix = new URL(process.env.E2E_ADMIN_BASE ?? '').pathname;
  const calls: string[] = [];
  page.on('request', (r) => calls.push(new URL(r.url()).pathname));
  await signIn(page, 'user@e2e.test');
  for (const p of ['/shop', '/orders', '/wallet', '/invite', '/nodes', '/traffic', '/tickets', '/help', '/announcements', '/account']) {
    await open(page, p);
  }
  expect(calls.filter((c) => c.startsWith(prefix) || c.startsWith('/admin'))).toEqual([]);
  for (const p of ['/admin', '/app', '/dashboard', '/faq', '/nope']) {
    const r = await page.goto(p);
    expect(r?.status(), p).toBe(404);
    expect(await r?.body(), p).toHaveLength(0);
  }
});
