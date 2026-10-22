/*
 * 门户 v2 端到端测试的公共部分：每个用例都收集 CSP 违规与页面异常（必须为空），登录（走接口，或经登录页）、退出、
 * 管理员接口与虚拟认证器（与 React 门户 spa/e2e 的同名工具相同；面板客户端直接用 spa/e2e/panel.ts），截图。
 * 数据来自 React 门户的 spa/e2e/seed.ts（E2E_SEED），面板由 ../scripts/e2e-portal.sh 起好。
 */
import { readFileSync } from 'node:fs';
import { expect, request, test as base, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { Client } from '../../spa/e2e/panel.ts';

export const seed = JSON.parse(readFileSync(process.env.E2E_SEED ?? '', 'utf8')) as {
  password: string;
  plan: string;
  premium: string;
  refundOrders: Record<'original' | 'balance' | 'manual', string>;
};

/** 每个视口（desktop / mobile）各用一个账户的用例：`logout` → `logout-desktop@e2e.test` */
export const mine = (info: TestInfo, name: string) => `${name}-${info.project.name}@e2e.test`;

export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('console', (m) => {
        if (/Content Security Policy|Refused to (load|execute|connect|frame)/i.test(m.text())) problems.push(`CSP: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
      await use(problems);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/**
 * 登录（接口，与 spa/e2e/panel.ts 的 Client.login 一样：带表单令牌、等过最短提交时间）。
 * 接口请求在 Node 里发，浏览器的域名映射管不到它：直连面板（E2E_API），再把会话 cookie 放进浏览器上下文（门户的域名）。
 */
export async function signIn(page: Page, email: string, password = seed.password) {
  const api = await request.newContext({ baseURL: process.env.E2E_API });
  const o = (await (await api.get('/auth/options')).json()) as { guard?: { form_token?: string; form_min_secs?: number } };
  await new Promise((r) => setTimeout(r, (o.guard?.form_min_secs ?? 0) * 1000 + 300));
  const guard = { ...(o.guard?.form_token ? { form_token: o.guard.form_token } : {}), website: '' };
  const res = await api.post('/auth/login', { data: { email, password, guard } });
  expect(res.ok(), `login ${email}: ${res.status()}`).toBe(true);
  const host = new URL(process.env.E2E_BASE ?? '').hostname;
  const { cookies } = await api.storageState();
  await page.context().addCookies(cookies.map(({ name, value, path, httpOnly, sameSite }) => ({ name, value, path, httpOnly, sameSite, domain: host })));
  await api.dispose();
}

/** 启动画面收起、页面标题出现 */
export async function ready(page: Page, title?: string) {
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: 15_000 });
  const h1 = page.locator('main h1');
  if (title) await expect(h1).toHaveText(title);
  else await expect(h1).toBeVisible();
}

/** 设计评审截图：test-results/screens/<视口>-<名字>.png（CI 工件 portal-v2-screens） */
export async function shot(page: Page, info: TestInfo, name: string) {
  /* 启动画面淡出前不拍（否则会盖在页面上） */
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: 15_000 });
  await page.screenshot({ path: `test-results/screens/${info.project.name}-${name}.png`, fullPage: true });
}

/** 经登录页登录（不等结果） */
export async function login(page: Page, email: string, password = seed.password) {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

/** 经登录页登录，等到离开登录页 */
export async function signInUI(page: Page, email: string, password = seed.password) {
  await login(page, email, password);
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
}

/** 从页头退出：桌面是邮箱下拉，窄屏是全屏菜单 */
export async function signOut(page: Page, info: TestInfo) {
  if (info.project.name === 'desktop') {
    await page.locator('header button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: '退出登录' }).click();
  } else {
    await page.getByRole('button', { name: '菜单' }).click();
    await page.getByRole('dialog', { name: '菜单' }).getByRole('button', { name: '退出登录' }).click();
  }
}

/** 管理员接口（每个文件一个会话） */
let adminClient: Promise<Client> | null = null;
export const admin = (): Promise<Client> => (adminClient ??= Client.admin());

/** Chromium 的虚拟认证器（WebAuthn）：平台认证器、可发现凭据、已验证用户 */
export const AUTHENTICATOR = {
  protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
  isUserVerified: true, automaticPresenceSimulation: true,
} as const;

/** 开启虚拟认证器；返回的会话带 authenticatorId（换一台设备时先移除它） */
export async function authenticator(page: Page): Promise<CDPSession & { authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR });
  return Object.assign(cdp, { authenticatorId });
}

/** 截图前切到深色（跟随系统的默认主题下，模拟系统深色） */
export async function dark(page: Page) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
}

/**
 * 付款结果（components/shop/PayResult）：等它出现，核对标题与小结里的套餐名（可选截图），再从右上角关掉。
 * 对话框开着时页面其余部分对无障碍树是隐藏的，所以先处理它（同 spa/e2e/fixtures.ts 的 payResult）。
 */
export async function payResult(page: Page, title: string, plan?: string, timeout = 10_000, screen?: { info: TestInfo; name: string }) {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: title })).toBeVisible({ timeout });
  if (plan) await expect(dialog.getByText(plan, { exact: true })).toBeVisible();
  if (screen) await page.screenshot({ path: `test-results/screens/${screen.info.project.name}-${screen.name}.png` });
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toHaveCount(0);
}
