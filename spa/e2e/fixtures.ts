/*
 * 门户端到端测试的公共部分：每个用例都收集 CSP 违规与页面异常（必须为空），以及登录、跳转、虚拟认证器等小工具。
 * 数据来自 e2e/seed.ts（E2E_SEED），面板由 ../scripts/e2e-portal.sh 起好。
 */
import { readFileSync } from 'node:fs';
import { expect, test as base, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { Client } from './panel.ts';

export const seed = JSON.parse(readFileSync(process.env.E2E_SEED ?? '', 'utf8')) as {
  password: string;
  plan: string;
  premium: string;
  refundOrders: Record<'original' | 'balance' | 'manual', string>;
};

/** 每个视口（desktop / mobile）各用一个账户的用例：`shop` → `shop-desktop@e2e.test` */
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

export async function login(page: Page, email: string, password = seed.password) {
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

/** 登录成功：离开登录页 */
export async function signIn(page: Page, email: string, password = seed.password) {
  await login(page, email, password);
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
}

/** 从页头的账户菜单退出（桌面是「账户菜单」，手机是同一位置的菜单按钮） */
export async function signOut(page: Page) {
  await page.locator('header button[aria-haspopup="menu"]:visible').last().click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
}

/** 管理员接口（每个文件一个会话） */
let adminClient: Promise<Client> | null = null;
export const admin = (): Promise<Client> => (adminClient ??= Client.admin());

/** Chromium 的虚拟认证器（WebAuthn）：平台认证器、可发现凭据、已验证用户 */
export async function authenticator(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

/** 手机上导航收在菜单里，直接按地址进页面 */
export const open = (page: Page, path: string) => page.goto(path);
