/*
 * 门户 v2 端到端测试的公共部分：每个用例都收集 CSP 违规与页面异常（必须为空），登录（走接口：登录页在 PR 2 迁移），截图。
 * 数据来自 React 门户的 spa/e2e/seed.ts（E2E_SEED），面板由 ../scripts/e2e-portal.sh 起好。
 */
import { readFileSync } from 'node:fs';
import { expect, test as base, type Page, type TestInfo } from '@playwright/test';

export const seed = JSON.parse(readFileSync(process.env.E2E_SEED ?? '', 'utf8')) as { password: string };

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

/** 登录（接口，与 spa/e2e/panel.ts 的 Client.login 一样：带表单令牌、等过最短提交时间）；cookie 进这个页面的上下文 */
export async function signIn(page: Page, email: string, password = seed.password) {
  const o = (await (await page.request.get('/auth/options')).json()) as { guard?: { form_token?: string; form_min_secs?: number } };
  await new Promise((r) => setTimeout(r, (o.guard?.form_min_secs ?? 0) * 1000 + 300));
  const guard = { ...(o.guard?.form_token ? { form_token: o.guard.form_token } : {}), website: '' };
  const res = await page.request.post('/auth/login', { data: { email, password, guard } });
  expect(res.ok(), `login ${email}: ${res.status()}`).toBe(true);
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
  await page.screenshot({ path: `test-results/screens/${info.project.name}-${name}.png`, fullPage: true });
}
