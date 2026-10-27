/*
 * 通行密钥的跨域名与注册绑定（Chromium 虚拟认证器，真实面板与真实 CSP）：
 *   · 通行密钥中心域名：在主域名 A 绑定的通行密钥，在主域名 B 直接登录（WebAuthn 关联来源，中心域名提供 /.well-known/webauthn）；
 *   · 用通行密钥注册 → 待绑定账户 → 绑定邮箱对话框 → 绑定后的账户可用（站点不验证邮箱 / 验证邮箱两种设置）；
 *   · Chromium 对关联来源「不同注册域标签数 ≤ 5」的实际处理（RP 自己算不算在内）：用例记录观察到的行为，
 *     结论写在 docs/DEPLOY.md 的通行密钥一节与 src/settings.rs 的 PASSKEY_LABEL_LIMIT 注释里。
 * 域名由 scripts/e2e-portal.sh 备好（证书、浏览器解析都带上了）；每个用例开头改站点域名、结尾原样写回。
 */
import type { Page } from '@playwright/test';
import { Client, FIELDS, latestMail } from './support/panel.ts';
import { admin, authenticator, expect, mine, ready, signOut, signInUI, test } from './fixtures';

test.describe.configure({ mode: 'serial' });

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set (run ../scripts/e2e-portal.sh)`);
  return v;
};
const port = new URL(env('E2E_BASE')).port;
const HOST_A = new URL(env('E2E_BASE')).hostname;
const HOST_B = env('E2E_HOST_B');
const CENTRE = env('E2E_HOST_CENTRE');
const CENTRE_LABELS = env('E2E_HOST_CENTRE_LABELS');
const LABEL_HOSTS = env('E2E_LABEL_HOSTS').split(' ').filter(Boolean);
const at = (host: string, path = '/') => `https://${host}:${port}${path}`;
const dashboard = (page: Page) => ready(page, '仪表盘');
const freshEmail = (tag: string) => `pk-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.test`;

type Domains = { domain: string }[];
type SiteView = { version: number; main: { domains: Domains }; sub: { domains: Domains }; node: { domains: Domains }; sub_domain_per_user: boolean };

/** 主域名与通行密钥中心域名（不动订阅 / 节点域名）；返回改之前的，用来写回 */
async function setDomains(a: Client, mains: string[], centre: string | null): Promise<{ mains: string[]; centre: string | null }> {
  const s = await a.call<SiteView>('GET', '/api/v1/settings');
  const before = {
    mains: s.main.domains.map((d) => d.domain),
    centre: (await a.call<{ domain: string | null }>('GET', '/api/v1/settings/passkey-domain').catch(() => ({ domain: null }))).domain,
  };
  await putDomains(a, mains, centre);
  return before;
}

async function putDomains(a: Client, mains: string[], centre: string | null) {
  /* 先去掉中心域名（它不能同时是主域名），再改主域名，最后设中心域名 */
  const cur0 = await a.call<SiteView>('GET', '/api/v1/settings');
  await a.call('PUT', '/api/v1/settings/passkey-domain', { version: cur0.version, domain: null });
  const s = await a.call<SiteView>('GET', '/api/v1/settings');
  await a.call('PUT', '/api/v1/settings', {
    version: s.version,
    main_domains: mains,
    sub_domains: s.sub.domains.map((d) => d.domain),
    node_domains: s.node.domains.map((d) => d.domain),
    sub_domain_per_user: s.sub_domain_per_user,
    trust_cloudflare: null,
    force_node_cloudflare: false,
    confirm_host_change: true,
    confirm_removal: true,
  });
  if (centre) {
    const cur = await a.call<SiteView>('GET', '/api/v1/settings');
    await a.call('PUT', '/api/v1/settings/passkey-domain', { version: cur.version, domain: centre });
  }
}

test('one passkey signs in on two main domains through the passkey centre', async ({ page }, info) => {
  const a = await admin();
  const before = await setDomains(a, [`${HOST_A}:${port}`, `${HOST_B}:${port}`], CENTRE);
  const auth = await a.patch('auth', FIELDS.auth, { passkey_prompt: true });
  try {
    /* 中心域名只答关联来源文件，别的什么都没有 */
    const wk = await page.goto(at(CENTRE, '/.well-known/webauthn'));
    expect(wk?.status()).toBe(200);
    expect((await wk?.json()) as { origins: string[] }).toEqual({ origins: [at(HOST_A, ''), at(HOST_B, '')] });
    expect((await page.goto(at(CENTRE, '/login')))?.status()).toBe(404);

    await authenticator(page);
    const email = mine(info, 'passkey');
    /* 主域名 A：密码登录，按提示添加通行密钥 */
    await page.goto(at(HOST_A, '/login'));
    await signInUI(page, email);
    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText('给这台设备添加通行密钥？')).toBeVisible();
    await prompt.getByRole('button', { name: '添加通行密钥' }).click();
    await expect(page.getByText('通行密钥已添加').first()).toBeVisible();

    /* 主域名 B：另一个来源、没有登录态，同一把通行密钥直接登录 */
    await page.goto(at(HOST_B, '/login'));
    await expect(page.getByRole('button', { name: '使用通行密钥登录' })).toBeVisible();
    await page.getByRole('button', { name: '使用通行密钥登录' }).click();
    await dashboard(page);
    expect(new URL(page.url()).hostname).toBe(HOST_B);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    /* 回到 A 再用一次（B 上的登录没有影响 A） */
    await page.context().clearCookies();
    await page.goto(at(HOST_A, '/login'));
    await page.getByRole('button', { name: '使用通行密钥登录' }).click();
    await dashboard(page);
    expect(new URL(page.url()).hostname).toBe(HOST_A);
  } finally {
    await a.patch('auth', FIELDS.auth, auth);
    await putDomains(a, before.mains, before.centre);
  }
});

for (const verify of [false, true]) {
  test(`registering with a passkey, binding the e-mail (site ${verify ? 'verifies' : 'does not verify'} e-mail), then the account works`, async ({ page }, info) => {
    const a = await admin();
    const signup = await a.patch('signup', FIELDS.signup, { passkey_register: true, email_verify: verify });
    try {
      await authenticator(page);
      await page.goto('/register');
      await page.getByRole('button', { name: '用通行密钥注册' }).click();
      const bind = page.getByRole('dialog', { name: '绑定邮箱' });
      await expect(bind).toBeVisible({ timeout: 30_000 });
      /* 待绑定账户：只有这个对话框，关不掉 */
      await expect(bind.getByRole('button', { name: '关闭' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(bind).toBeVisible();

      const email = freshEmail(verify ? 'verify' : 'plain');
      const password = 'e2e-password-123';
      await bind.getByLabel('邮箱', { exact: true }).fill(email);
      if (verify) {
        const sentAt = Date.now() - 1000;
        await bind.getByRole('button', { name: '发送验证码' }).click();
        const code = /\b(\d{6})\b/.exec(await latestMail(email, sentAt))?.[1] ?? '';
        expect(code).toMatch(/^\d{6}$/);
        /* 错码被拒，对话框还在 */
        await bind.getByLabel('邮箱验证码').fill(code === '000000' ? '111111' : '000000');
        await bind.getByRole('button', { name: '完成绑定' }).click();
        await expect(bind.getByText('验证码不正确或已失效，请重新获取')).toBeVisible();
        await bind.getByLabel('邮箱验证码').fill(code);
      }
      await bind.getByLabel(/^密码/).fill(password);
      await bind.getByRole('button', { name: '完成绑定' }).click();
      await expect(page.getByText('邮箱已绑定')).toBeVisible();
      await expect(bind).toHaveCount(0);
      await dashboard(page);

      /* 绑定后的账户是完整账户：邮箱 + 刚设的密码登录，通行密钥登录也行 */
      await signOut(page, info);
      await expect(page).toHaveURL(/\/login/);
      await signInUI(page, email, password);
      await dashboard(page);
      await signOut(page, info);
      await page.getByRole('button', { name: '使用通行密钥登录' }).click();
      await dashboard(page);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await a.patch('signup', FIELDS.signup, signup);
    }
  });
}

/*
 * Chromium 与关联来源的标签上限：6 个主域名（各有不同的注册域标签），中心域名自己的标签（e2e）不与它们重复。
 * 在每个主域名的页面上，用 RP = 中心域名直接调 WebAuthn（创建、获取）：谁被接受，就是浏览器认下的关联来源。
 * RP 自己不算：lab1…lab5 通过、lab6 被拒；RP 算在内：只有 lab1…lab4。观察到的结果写在期望里。
 */
test('Chromium: how many related-origin labels are accepted, and does the RP\'s own label count', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a browser property, measured once');
  const a = await admin();
  const before = await setDomains(a, LABEL_HOSTS.map((h) => `${h}:${port}`), CENTRE_LABELS);
  try {
    await authenticator(page);
    const outcome: Record<string, { create: string; get: string }> = {};
    for (const host of LABEL_HOSTS) {
      await page.goto(at(host, '/healthz'));
      outcome[host] = await page.evaluate(async (rpId) => {
        const result = { create: 'ok', get: 'ok' };
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        try {
          await navigator.credentials.create({
            publicKey: {
              challenge, rp: { id: rpId, name: 'label limit' },
              user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'label', displayName: 'label' },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
              authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            },
          });
        } catch (e) {
          result.create = (e as DOMException).name;
        }
        try {
          await navigator.credentials.get({ publicKey: { challenge, rpId, userVerification: 'required' } });
        } catch (e) {
          result.get = (e as DOMException).name;
        }
        return result;
      }, CENTRE_LABELS);
    }
    const accepted = LABEL_HOSTS.filter((h) => outcome[h].create === 'ok' && outcome[h].get === 'ok');
    console.log(`related-origins label limit (${LABEL_HOSTS.length} main domains, ${CENTRE_LABELS} as the RP): ${JSON.stringify(outcome)}`);
    info.annotations.push({ type: 'chromium-related-origin-labels', description: JSON.stringify(outcome) });
    expect(accepted).toEqual(LABEL_HOSTS.slice(0, 5));
  } finally {
    await putDomains(a, before.mains, before.centre);
  }
});
