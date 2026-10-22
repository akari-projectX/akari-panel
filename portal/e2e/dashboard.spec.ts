/*
 * 门户 v2 · PR 3：仪表盘。覆盖 React 门户 spa/e2e 里仪表盘的全部场景（support #60、polish #60、subscription #27–#30 / B1、
 * account #17 的验证邮箱、#18 封禁、#19 续费范围、support #14 的客户端下载），外加新设计的：流量图（平滑面积图、7 / 30 天、
 * 悬停 / 键盘提示）、提醒细行（待付款、工单回复、流量快用完、邮箱未验证）、最新公告横幅与详情、线路与文档预览、#subscribe 直达，
 * 以及设计评审截图（默认 / 提醒 / 仅自研客户端 / 续费范围 / 封禁 × 桌面 / 手机 × 浅 / 深）。
 * 账户：user@e2e.test（正常、有两天流量）、v2-sub-<视口>（重置订阅链接）、v2-verify-<视口>（验证邮箱）、expired / quota / banned。
 * 改站点设置的用例在 finally 里恢复（整个套件 workers = 1，顺序执行）。
 */
import type { Page, TestInfo } from '@playwright/test';
import { FIELDS, latestMail, psql } from '../../spa/e2e/panel.ts';
import { admin, dark, expect, mine, ready, shot, signIn, test } from './fixtures';

const isDesktop = (info: TestInfo) => info.project.name === 'desktop';

/** 进仪表盘，等到每一块都取完（没有 aria-busy 的占位） */
async function dashboard(page: Page, title = '仪表盘') {
  await page.goto('/');
  await ready(page, title);
  await expect(page.locator('main [aria-busy]')).toHaveCount(0, { timeout: 15_000 });
}

/** 「复制订阅链接」后剪贴板里的地址 */
async function copiedLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: '复制订阅链接' }).click();
  await expect(page.getByText('订阅地址已复制').first()).toBeVisible();
  return page.evaluate(() => navigator.clipboard.readText());
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const GiB = 1024 ** 3;

/** 把提醒都触发出来：待付款订单、客服回复了的工单、两条未读公告、流量只剩 5% */
async function stubNotices(page: Page) {
  let orders = [{
    id: 'o-e2e', out_trade_no: 'E2E0001', plan_id: null, plan_name: 'E2E 高级', amount_cents: 3000, period: 'month', period_days: null,
    list_price_cents: 3000, credit_cents: 0, discount_cents: 0, coupon_code: null, balance_cents: 0, refunded_at: null, status: 'pending',
    qr_code: null, pay_url: null, payment_method_id: null, payment_method_name: null, created_at: iso(-60_000), expires_at: iso(25 * 60_000), paid_at: null,
  }];
  await page.route(/\/api\/v1\/me\/orders$/, (r) => r.fulfill({ json: orders }));
  await page.route(/\/api\/v1\/me\/orders\/o-e2e\/cancel$/, (r) => {
    orders = [];
    return r.fulfill({ json: {} });
  });
  await page.route(/\/api\/v1\/me\/tickets$/, (r) => r.fulfill({
    json: [{ id: 't-e2e', subject: 'E2E 连不上香港线路', category: 'other', priority: 'normal', status: 'answered', messages: 2, created_at: iso(-3600_000), updated_at: iso(-600_000), unread: true }],
  }));
  let read = new Set<string>();
  const anns = () => {
    const list = [
      { id: 'a-1', title_zh: '日本节点今晚 02:00–03:00 维护', title_en: null, html_zh: '<p>期间东京、大阪线路短暂不可用，其他地区不受影响。</p>', html_en: null, pinned: true, created_at: iso(-3 * 3600_000) },
      { id: 'a-2', title_zh: '双十一全场八折，年付再送 50 GB', title_en: null, html_zh: '<p>活动时间 11 月 1 日至 11 月 11 日。</p>', html_en: null, pinned: false, created_at: iso(-7200_000) },
      { id: 'a-3', title_zh: '新增新加坡 IPLC 线路', title_en: null, html_zh: '<p>已加入所有标准及以上套餐的订阅。</p>', html_en: null, pinned: false, created_at: iso(-86_400_000), read: true },
    ].map((a) => ({ ...a, read: a.read ?? read.has(a.id) }));
    return { announcements: list, unread: list.filter((a) => !a.read).length };
  };
  await page.route(/\/api\/v1\/me\/announcements$/, (r) => r.fulfill({ json: anns() }));
  await page.route(/\/api\/v1\/me\/announcements\/[^/]+\/read$/, (r) => {
    read = new Set([...read, r.request().url().split('/').at(-2) ?? '']);
    return r.fulfill({ status: 204 });
  });
  await page.route(/\/api\/v1\/me\/plan$/, (r) => r.fulfill({
    json: {
      plan: {
        name: 'E2E 标准', traffic_quota_bytes: 100 * GiB, period: 'monthly', speed_limit_mbps: 300, device_seats: null,
        starts_at: iso(-20 * 86_400_000), expires_at: iso(10 * 86_400_000), period_anchor: iso(-20 * 86_400_000), last_reset_at: null,
        next_reset_at: iso(10 * 86_400_000),
      },
      traffic_used_bytes: 95 * GiB, traffic_limit_bytes: 100 * GiB, expires_at: iso(10 * 86_400_000), nodes: [],
    },
  }));
}


test('#60 plan, days left, traffic left, lines, balance, subscription, announcements; nothing waits on a spinner', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await dashboard(page);
  await expect(page.locator('main .ph p')).toHaveText(/E2E 标准 · 每月重置流量/);
  const kpis = page.getByRole('region', { name: '账户概况' });
  for (const k of ['剩余流量', '套餐剩余', '可用线路', '账户余额']) await expect(kpis.getByText(k, { exact: true }).first()).toBeVisible();
  await expect(kpis.getByRole('meter', { name: '剩余流量' })).toBeVisible();
  await expect(kpis).toContainText(/共 100 GB，已用/);
  await expect(kpis).toContainText(/到期 \d{4}-\d{2}-\d{2}/);
  await expect(kpis).toContainText(/可提现 ¥/);
  await expect(page.getByRole('button', { name: '复制订阅链接' })).toBeVisible();
  await expect(page.getByText('E2E 维护通知').first()).toBeVisible();
  /* 线路：每个入口一行，地区码代替国旗，倍率是此刻生效的（中转 ×2、日本全天 ×0.5） */
  const lines = page.locator('section[aria-labelledby="h-lines"]');
  await expect(lines.locator('.li')).toHaveCount(3);
  await expect(lines.locator('.rc').first()).toHaveText(/^(HK|JP)$/);
  await expect(lines.getByText('×2', { exact: true })).toBeVisible();
  await expect(lines.getByText('×0.5', { exact: true })).toBeVisible();
  await expect(lines.getByRole('link', { name: '全部线路' })).toHaveAttribute('href', '/nodes');
  /* 文档：分类、篇数，点进文档页的该分类 */
  const docs = page.locator('section[aria-labelledby="h-docs"]');
  await expect(docs.getByRole('link', { name: /Windows 教程/ })).toHaveAttribute('href', `/help?cat=${encodeURIComponent('Windows 教程')}`);
  await expect(docs).toContainText(/\d+ 篇/);
});

test('#60 traffic chart: a smooth area with axes, today\'s value, tooltip by pointer and keyboard, 7 / 30 days from the panel', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await dashboard(page);
  const sec = page.locator('section[aria-labelledby="h-traffic"]');
  await expect(sec.getByRole('heading', { name: '近 7 日流量' })).toBeVisible();
  await expect(sec).toContainText(/合计 .+，其中下行 .+、上行 .+/);
  await expect(sec).toContainText(/计费 \d/);
  const chart = sec.getByRole('slider');
  await expect(chart.locator('path.curve')).toBeVisible();
  await expect(chart.locator('line.gridline, line.base')).toHaveCount(3);
  await expect(chart.locator('text.now').first()).toHaveText(/ (GB|MB|KB)$/);
  await expect(chart.locator('text.x.now')).toContainText('今天');
  /* 指针：悬停（桌面）或点按（手机）今天那一端，提示里有下行、上行、计费 */
  const box = (await chart.locator('rect.hit').boundingBox())!;
  if (isDesktop(info)) await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 2 });
  else await page.touchscreen.tap(box.x + box.width - 2, box.y + box.height / 2);
  const tip = chart.locator('.ttip');
  await expect(tip).toBeVisible();
  for (const k of ['下行', '上行', '计费']) await expect(tip.getByText(k, { exact: true })).toBeVisible();
  await expect(tip).toContainText('今天');
  /* 键盘：Tab 到图上，← 看前一天，Esc 收起 */
  await chart.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(chart).toHaveAttribute('aria-valuenow', '6');
  await expect(chart).toHaveAttribute('aria-valuetext', /下行 .+，上行 .+，合计/);
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
  /* 30 天：同一个组件，面板给的真实按天数据（from = 今天 − 29 天） */
  const req = page.waitForRequest((r) => /\/api\/v1\/me\/traffic\?/.test(r.url()));
  await sec.getByRole('button', { name: '30 天' }).click();
  const url = new URL((await req).url());
  const days = (Date.parse(url.searchParams.get('to')!) - Date.parse(url.searchParams.get('from')!)) / 86_400_000;
  expect(days).toBe(29);
  await expect(sec.getByRole('heading', { name: '近 30 日流量' })).toBeVisible();
  await expect(sec.getByRole('button', { name: '30 天' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.locator('path.curve')).toBeVisible();
  await shot(page, info, 'dashboard-30d-light');
});

test('#27 #30 D11: the link is the panel\'s random subscription path, it works, a reset on the dashboard replaces it', async ({ page, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, mine(info, 'v2-sub'));
  await dashboard(page);
  const link = await copiedLink(page);
  await expect(page.getByRole('button', { name: '已复制订阅链接' })).toBeVisible();
  const url = new URL(link);
  expect(url.origin).toBe(process.env.E2E_ORIGIN);
  const subPath = psql('SELECT sub_path FROM access_settings;');
  expect(url.pathname.split('/')[1]).toBe(subPath);
  /* 页面上的链接打了码：令牌不整段显示 */
  const token = url.pathname.split('/')[2];
  await expect(page.locator('#subscribe .mono')).toContainText('•••');
  await expect(page.locator('#subscribe')).not.toContainText(token);
  /* 二维码就是这条地址（本地生成的 SVG，不出浏览器）；窄屏不显示二维码（样稿） */
  const qr = page.locator('svg:has(> title)').filter({ hasText: '订阅二维码' });
  if (isDesktop(info)) await expect(qr).toBeVisible();
  else await expect(qr).toBeHidden();
  const r = await fetch(`${process.env.E2E_API}${url.pathname}?format=clash`);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('proxies:');

  /* 重置：区块头的「重置订阅」→ 确认对话框（后果清单）→ 新链接，旧链接立即失效 */
  await page.locator('#subscribe').getByRole('button', { name: '重置订阅' }).click();
  const dialog = page.getByRole('dialog', { name: '重置订阅？' });
  await expect(dialog).toContainText('旧的订阅链接立即失效');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await page.locator('#subscribe').getByRole('button', { name: '重置订阅' }).click();
  await page.getByRole('dialog', { name: '重置订阅？' }).getByRole('button', { name: '确认重置' }).click();
  await expect(page.getByText('订阅已重置').first()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const next = await copiedLink(page);
  expect(next).not.toBe(link);
  expect((await fetch(`${process.env.E2E_API}${url.pathname}`)).status).toBe(404);
});

test('#28 #29 W30: formats and import buttons follow the site switches; an import opens the client\'s deep link', async ({ page }) => {
  const a = await admin();
  await signIn(page, 'user@e2e.test');
  await dashboard(page);
  const format = page.getByRole('button', { name: '订阅格式' });
  await format.click();
  for (const f of ['自动识别', 'Clash / mihomo', 'sing-box', '通用链接']) await expect(page.getByRole('menuitem', { name: f })).toBeVisible();
  /* 键盘：↓ 移动，Esc 关闭并把焦点还给按钮 */
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Clash / mihomo' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(format).toBeFocused();
  /* 选一个格式：按钮上写它，复制的地址带 ?format= */
  await format.click();
  await page.getByRole('menuitem', { name: 'sing-box' }).click();
  await expect(format).toHaveText('sing-box');
  await expect(page.locator('#subscribe .mono')).toContainText('format=sing-box');
  await expect(page.getByRole('button', { name: /Clash Verge \/ mihomo/ })).toBeVisible();

  const cur = await a.call<{ version: number }>('GET', '/api/v1/settings');
  await a.call('PUT', '/api/v1/settings/subscription', { version: cur.version, formats: ['clash', 'links'], import_clients: ['stash', 'sing-box'] });
  try {
    await page.reload();
    await ready(page, '仪表盘');
    await page.getByRole('button', { name: '订阅格式' }).click();
    await expect(page.getByRole('menuitem', { name: 'sing-box' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: '通用链接' })).toBeVisible();
    await page.keyboard.press('Escape');
    /* sing-box 格式关了：它的导入按钮也不给（面板按开着的格式筛） */
    await expect(page.getByRole('button', { name: /^Stash/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^sing-box/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Clash Verge \/ mihomo/ })).toHaveCount(0);
    /* 一键导入 = 客户端自己的深链接（这里只看跳转的地址，浏览器里没有装客户端） */
    await page.getByRole('button', { name: /^Stash/ }).click();
    await expect(page.getByText('正在唤起 Stash').first()).toBeVisible();
  } finally {
    const now = await a.call<{ version: number }>('GET', '/api/v1/settings');
    await a.call('PUT', '/api/v1/settings/subscription', { version: now.version, formats: null, import_clients: null });
  }
});

test('B1 own client only: no link, copy, QR or import buttons; only the client download', async ({ page }, info) => {
  const a = await admin();
  const cur = await a.call<{ version: number }>('GET', '/api/v1/settings');
  await a.call('PUT', '/api/v1/settings/subscription', { version: cur.version, own_client_only: true });
  let branding: Record<string, unknown> | null = null;
  try {
    await signIn(page, 'user@e2e.test');
    await dashboard(page);
    const area = page.getByTestId('own-client');
    await expect(area).toContainText('在客户端里登录账户即可自动获取节点');
    await expect(page.locator('#subscribe')).toContainText('下载 Akari 客户端，登录账户即可使用');
    /* 站长没配下载地址：只有一句中性的说明 */
    await expect(area).toContainText('客户端下载地址还没有公布');
    await expect(page.getByRole('button', { name: '复制订阅链接' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '订阅格式' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Clash Verge \/ mihomo/ })).toHaveCount(0);
    await expect(page.locator('svg:has(> title)').filter({ hasText: '订阅二维码' })).toHaveCount(0);
    /* 配了客户端下载：接入区就是下载按钮 */
    branding = await a.patch('branding', FIELDS.branding, {
      client_downloads: [{ platform: 'windows', label: 'E2E Akari 客户端', url: 'https://example.com/akari.exe' }],
    });
    await page.reload();
    await ready(page, '仪表盘');
    await expect(page.getByRole('link', { name: 'E2E Akari 客户端' })).toHaveAttribute('href', 'https://example.com/akari.exe');
    await expect(area).not.toContainText('客户端下载地址还没有公布');
    await expect(page.locator('main [aria-busy]')).toHaveCount(0);
    await shot(page, info, 'dashboard-own-client-light');
  } finally {
    if (branding) await a.patch('branding', FIELDS.branding, branding);
    const now = await a.call<{ version: number }>('GET', '/api/v1/settings');
    await a.call('PUT', '/api/v1/settings/subscription', { version: now.version, own_client_only: false });
  }
});

test('#14 client downloads: configured downloads replace the per-platform guides', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await dashboard(page);
  const help = page.locator('#subscribe');
  await expect(help).toContainText('还没有客户端？按平台查看教程：');
  await expect(help.getByRole('link', { name: 'Windows', exact: true })).toHaveAttribute('href', '/help?q=Windows');
  const a = await admin();
  const before = await a.patch('branding', FIELDS.branding, {
    client_downloads: [{ platform: 'windows', label: 'E2E 客户端', url: 'https://example.com/client.exe' }],
  });
  try {
    await page.reload();
    await ready(page, '仪表盘');
    await expect(help).toContainText('还没有客户端？下载客户端：');
    const dl = help.getByRole('link', { name: 'E2E 客户端' });
    await expect(dl).toHaveAttribute('href', 'https://example.com/client.exe');
    await expect(dl).toHaveAttribute('target', '_blank');
  } finally {
    await a.patch('branding', FIELDS.branding, before);
  }
});

test('notices: pending order, staff reply, low traffic; the latest unread announcement as a banner', async ({ page }, info) => {
  await stubNotices(page);
  await signIn(page, 'user@e2e.test');
  await dashboard(page);
  const notes = page.locator('[data-page-notices]');
  await expect(notes).toContainText('你有一笔待支付的订单');
  await expect(notes).toContainText(/E2E 高级 · 月付 · ¥30 · .+前未支付将自动关闭/);
  await expect(notes.getByRole('link', { name: '去支付' })).toHaveAttribute('href', '/orders/o-e2e');
  await expect(notes).toContainText('管理员已回复你的工单');
  await expect(notes.getByRole('link', { name: '查看回复' })).toHaveAttribute('href', '/tickets?id=t-e2e');
  await expect(notes).toContainText('流量快用完了');
  await expect(notes).toContainText(/只剩 5 GB（5%），\d{2}-\d{2} 重置。/);
  await expect(page.getByRole('region', { name: '账户概况' }).locator('.meter.warn')).toBeVisible();
  const banner = page.getByRole('region', { name: '最新公告' });
  await expect(banner).toContainText('日本节点今晚 02:00–03:00 维护');
  await expect(page.locator('section[aria-labelledby="h-news"]')).toContainText('2 条未读');
  await shot(page, info, 'dashboard-notices-light');
  await dark(page);
  await shot(page, info, 'dashboard-notices-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  /* 公告详情：标题、正文（面板的 HTML）、「我知道了」；打开即已读，横幅换成下一条未读 */
  await banner.getByRole('button', { name: '查看详情' }).click();
  const dialog = page.getByRole('dialog', { name: '日本节点今晚 02:00–03:00 维护' });
  await expect(dialog).toContainText('期间东京、大阪线路短暂不可用');
  await expect(dialog).toContainText('置顶');
  await dialog.getByRole('button', { name: '我知道了' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(banner).toContainText('双十一全场八折');
  await expect(page.locator('section[aria-labelledby="h-news"]')).toContainText('1 条未读');
  /* 关掉横幅 = 这一条标记已读；没有未读了，横幅消失 */
  await banner.getByRole('button', { name: '不再显示这条公告' }).click();
  await expect(banner).toHaveCount(0);
  /* 列表里点一条：同一个详情对话框 */
  await page.locator('section[aria-labelledby="h-news"]').getByRole('button', { name: /新增新加坡 IPLC 线路/ }).click();
  await expect(page.getByRole('dialog', { name: '新增新加坡 IPLC 线路' })).toBeVisible();
  await page.keyboard.press('Escape');

  /* 取消待付款订单：提示，提醒消失 */
  await notes.getByRole('button', { name: '取消订单' }).click();
  await expect(page.getByText('订单已取消').first()).toBeVisible();
  await expect(notes).not.toContainText('你有一笔待支付的订单');
});

test('#17 unverified email: "later" hides it for the session, "verify" opens the code dialog on the page', async ({ page }, info) => {
  const email = mine(info, 'v2-verify');
  psql(`UPDATE users SET email_verified_at = NULL WHERE email = '${email}';`);
  await signIn(page, email);
  await dashboard(page);
  const notes = page.locator('[data-page-notices]');
  await expect(notes).toContainText('邮箱还没有验证');
  await notes.getByRole('button', { name: '稍后' }).click();
  await expect(page.getByText('邮箱还没有验证')).toHaveCount(0);
  await page.reload();
  await ready(page, '仪表盘');
  await expect(page.getByText('邮箱还没有验证')).toHaveCount(0);
  await page.evaluate(() => sessionStorage.removeItem('akari.verify-nudge'));
  await page.reload();
  await ready(page, '仪表盘');

  await page.getByRole('button', { name: '去验证' }).click();
  const dialog = page.getByRole('dialog', { name: '验证邮箱' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(email)).toBeVisible();
  await expect(dialog.getByLabel('邮箱验证码')).toHaveCount(0);
  const sent = Date.now() - 1000;
  await dialog.getByRole('button', { name: '发送验证码' }).click();
  /* 重发有倒计时 */
  await expect(dialog.getByRole('button', { name: /秒后重发/ })).toBeDisabled();
  /* 格式不对：内联错误 + 聚焦，不弹浏览器气泡 */
  await dialog.getByRole('button', { name: '完成验证' }).click();
  await expect(dialog.getByText('请输入 6 位数字验证码')).toBeVisible();
  await expect(dialog.getByLabel('邮箱验证码')).toBeFocused();
  const code = /\b(\d{6})\b/.exec(await latestMail(email, sent))?.[1] ?? '';
  await dialog.getByLabel('邮箱验证码').fill(code);
  await dialog.getByRole('button', { name: '完成验证' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('邮箱已验证').first()).toBeVisible();
  await expect(page.getByText('邮箱还没有验证')).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

test('#19 renewal scope (expired): banner, no lines, subscription or traffic; the shop is one click away', async ({ page }, info) => {
  await signIn(page, 'expired@e2e.test');
  await dashboard(page);
  await expect(page.getByText('套餐已到期，服务已暂停')).toBeVisible();
  /* 提醒在页头下面 */
  const [h, b] = [await page.locator('main h1').boundingBox(), await page.getByText('套餐已到期，服务已暂停').boundingBox()];
  expect(b!.y).toBeGreaterThan(h!.y + h!.height);
  await expect(page.getByRole('button', { name: '复制订阅链接' })).toHaveCount(0);
  await expect(page.locator('#subscribe')).toContainText('订阅已暂停');
  await expect(page.locator('section[aria-labelledby="h-traffic"]')).toHaveCount(0);
  await expect(page.locator('section[aria-labelledby="h-lines"]')).toContainText('线路暂不可用');
  await expect(page.getByRole('region', { name: '账户概况' })).toContainText('续费后恢复');
  await shot(page, info, 'dashboard-renewal-light');
  await dark(page);
  await shot(page, info, 'dashboard-renewal-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('link', { name: '去续费' }).click();
  await ready(page, '商店');
});

test('#19 renewal scope (quota used up): "restore" goes to the shop', async ({ page }) => {
  await signIn(page, 'quota@e2e.test');
  await dashboard(page);
  await expect(page.getByText('本期流量已用完，服务已暂停')).toBeVisible();
  await page.getByRole('link', { name: '去恢复' }).click();
  await ready(page, '商店');
});

test('#18 banned: the reason and tickets only', async ({ page }, info) => {
  await signIn(page, 'banned@e2e.test');
  await page.goto('/');
  await ready(page, '账户已被封禁');
  await expect(page.getByText('E2E：违反服务条款')).toBeVisible();
  await expect(page.getByText(/封禁时间 \d{4}-/)).toBeVisible();
  await expect(page.getByRole('button', { name: '复制订阅链接' })).toHaveCount(0);
  await shot(page, info, 'dashboard-banned-light');
  await dark(page);
  await shot(page, info, 'dashboard-banned-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('link', { name: '提交或查看工单' }).click();
  await ready(page, '工单');
});

test('#subscribe: the payment result\'s "view subscription" lands on the access section', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  await page.goto('/#subscribe');
  await ready(page, '仪表盘');
  await expect(page.locator('#subscribe')).toBeInViewport();
});

test('screens: the dashboard (light + dark), no sideways scroll on phones', async ({ page }, info) => {
  await signIn(page, 'user@e2e.test');
  await dashboard(page);
  if (!isDesktop(info)) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await shot(page, info, 'dashboard-default-light');
  await dark(page);
  await shot(page, info, 'dashboard-default-dark');
});
