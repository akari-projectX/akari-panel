/*
 * 门户 v2 · PR 2：登录、注册、找回 / 重设密码、通行密钥（登录、登录后引导、只用通行密钥、用通行密钥注册 + 绑定邮箱）、
 * 公开表单防护（表单令牌、蜜罐、最短提交时间、Turnstile）、站点开关、条款与隐私、注销结果页。
 * 覆盖登录、注册、找回密码的全部场景，外加截图。
 * 会改状态的账户每个视口各一个：v2-passkey-<视口>、v2-reset-<视口>（e2e/support/seed.ts）。
 */
import type { Page } from '@playwright/test';
import { FIELDS, latestMail } from './support/panel.ts';
import {
  admin, AUTHENTICATOR, authenticator, dark, expect, login, mine, ready, seed, shot, signIn, signInUI, signOut, test,
} from './fixtures';

test.describe.configure({ mode: 'serial' });

const freshEmail = (tag: string) => `v2-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.test`;
const dashboard = (page: Page) => ready(page, '仪表盘');

test('#1 #2 wrong password = the uniform answer under the password; a full account lands on the dashboard', async ({ page }, info) => {
  await login(page, 'user@e2e.test', 'not-the-password');
  const pwd = page.getByLabel('密码', { exact: true });
  await expect(page.getByText('邮箱或密码错误')).toBeVisible();
  await expect(pwd).toHaveAttribute('aria-invalid', 'true');
  await expect(pwd).toBeFocused();
  await shot(page, info, 'login-error-light');
  await signInUI(page, 'user@e2e.test');
  await dashboard(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('登录成功')).toBeVisible();
});

test('a sign-in from a guarded page goes back there; ?redirect= only accepts in-site paths', async ({ page }) => {
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/login\?redirect=%2Forders$/);
  await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
  await page.getByLabel('密码', { exact: true }).fill(seed.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await page.context().clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('/login?redirect=%2F%2Fevil.example');
  await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
  await page.getByLabel('密码', { exact: true }).fill(seed.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await dashboard(page);
  expect(new URL(page.url()).host).toBe(new URL(process.env.E2E_BASE ?? '').host);
});

test('forms validate inline (no browser bubbles): errors under the fields, the first one focused', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('请输入邮箱', { exact: true })).toBeVisible();
  await expect(page.getByText('请输入密码', { exact: true })).toBeVisible();
  const email = page.getByLabel('邮箱', { exact: true });
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveAttribute('aria-describedby', 'login-email-msg');
  /* 改了那个字段，它的错误就消失 */
  await email.fill('not-an-address');
  await expect(page.getByText('请输入邮箱', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('请输入有效的邮箱地址')).toBeVisible();
  /* 密码框的显示 / 隐藏 */
  const pwd = page.getByLabel('密码', { exact: true });
  await pwd.fill('secret');
  await page.getByRole('button', { name: '显示密码' }).click();
  await expect(pwd).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '隐藏密码' }).click();
  await expect(pwd).toHaveAttribute('type', 'password');

  await page.goto('/register');
  await page.getByLabel('邮箱', { exact: true }).fill(freshEmail('inline'));
  await page.getByLabel('密码', { exact: true }).fill('short');
  /* 密码规则随输入点亮 */
  const rules = page.getByRole('list', { name: '密码要求' }).getByRole('listitem');
  await expect(rules).toHaveText(['至少 8 位', '含字母', '含数字']);
  await expect(rules.filter({ hasText: '含字母' })).toHaveClass(/ok/);
  await expect(rules.filter({ hasText: '至少 8 位' })).not.toHaveClass(/ok/);
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page.getByText('密码至少 8 位')).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
});

test('#2 D4: admin credentials get the same answer as a wrong password; no console address anywhere', async ({ page }) => {
  await login(page, process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
  await expect(page.getByText('邮箱或密码错误')).toBeVisible();
  const prefix = new URL(process.env.E2E_ADMIN_BASE ?? '').pathname;
  expect(await page.content()).not.toContain(prefix);
  expect(await page.locator('a[href*="admin"]').count()).toBe(0);
});

test('#7 #10 registration with the proof of work; the trial plan is announced', async ({ page }, info) => {
  const a = await admin();
  const plans = await a.call<{ id: string; name: string }[]>('GET', '/api/v1/plans');
  const before = await a.patch('signup', FIELDS.signup, { trial_plan_id: plans.find((p) => p.name === seed.plan)?.id, trial_days: 3, email_verify: false });
  try {
    await page.goto('/register');
    await expect(page.locator('#main').getByRole('link', { name: '登录', exact: true })).toBeVisible();
    await expect(page.getByLabel('邮箱验证码')).toHaveCount(0);
    await page.getByLabel('邮箱', { exact: true }).fill(freshEmail('pow'));
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '创建账号' }).click();
    await expect(page.getByText('已赠送试用套餐，现在就可以使用')).toBeVisible({ timeout: 30_000 });
    await dashboard(page);
    await expect(page.getByText('注册成功')).toBeVisible();
  } finally {
    await a.patch('signup', FIELDS.signup, before);
  }
  await shot(page, info, 'after-register');
});

test('#6 registration with an emailed code (email verification on); the send button cools down', async ({ page }, info) => {
  const a = await admin();
  const before = await a.patch('signup', FIELDS.signup, { email_verify: true });
  try {
    const email = freshEmail('code');
    await page.goto('/register');
    await shot(page, info, 'register-light');
    await dark(page);
    await shot(page, info, 'register-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    /* 没填邮箱就发码：错误画在邮箱下面 */
    await page.getByRole('button', { name: '发送验证码' }).click();
    await expect(page.getByText('请输入邮箱', { exact: true })).toBeVisible();
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    const sent = Date.now() - 1000;
    await page.getByRole('button', { name: '发送验证码' }).click();
    await expect(page.getByText('如果这个邮箱可以注册，验证码已经发出')).toBeVisible();
    await expect(page.getByRole('button', { name: /^\d+ 秒$/ })).toBeDisabled();
    const code = /\b(\d{6})\b/.exec(await latestMail(email, sent))?.[1] ?? '';
    expect(code).toMatch(/^\d{6}$/);
    /* 验证码框只收数字 */
    await page.getByLabel('邮箱验证码').fill(`${code}x`);
    await expect(page.getByLabel('邮箱验证码')).toHaveValue(code);
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '创建账号' }).click();
    await dashboard(page);
  } finally {
    await a.patch('signup', FIELDS.signup, before);
  }
});

test('#8 #9 site switches: closed registration, invite required + allowed domains, user invites off, no self-service reset; ?invite= prefills', async ({ page }, info) => {
  const a = await admin();
  let before = await a.patch('signup', FIELDS.signup, { register_enabled: false, reset_enabled: false });
  try {
    await page.goto('/register?invite=E2EINVITE');
    await expect(page.getByText('网站已暂停注册新用户。')).toBeVisible();
    await expect(page.getByLabel('邮箱', { exact: true })).toHaveCount(0);
    await shot(page, info, 'register-closed');
    await page.getByRole('link', { name: '登录已有账号' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('link', { name: '忘记密码' })).toHaveCount(0);
    /* 关了注册：没有「注册」入口 */
    await expect(page.getByRole('link', { name: '注册', exact: true })).toHaveCount(0);
    await page.goto('/forgot');
    await expect(page.getByText('本站没有开放自助找回密码。')).toBeVisible();
    await a.patch('signup', FIELDS.signup, before);

    before = await a.patch('signup', FIELDS.signup, { invite_required: true, email_domains: ['example.org'], email_verify: false });
    await page.goto('/register?invite=E2EINVITE');
    await expect(page.getByLabel('邀请码')).toHaveValue('E2EINVITE');
    await expect(page.getByText('选填')).toHaveCount(0);
    await expect(page.getByText('example.org')).toBeVisible();
    await page.getByLabel('邀请码').fill('');
    await page.getByLabel('邮箱', { exact: true }).fill(freshEmail('dom'));
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '创建账号' }).click();
    await expect(page.getByText('请填写邀请码')).toBeVisible();
    await page.getByLabel('邀请码').fill('E2EINVITE');
    await page.getByRole('button', { name: '创建账号' }).click();
    await expect(page.getByText(/不支持该邮箱域名|邀请码/).first()).toBeVisible({ timeout: 30_000 });
    await a.patch('signup', FIELDS.signup, before);

    /* 后台关了「允许用户邀请」：没有邀请码框，邀请链接里的码也不带上 */
    before = await a.patch('signup', FIELDS.signup, { user_invites: false });
    await page.goto('/register?invite=E2EINVITE');
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    await expect(page.getByLabel('邀请码')).toHaveCount(0);
  } finally {
    await a.patch('signup', FIELDS.signup, before);
  }
});

test('#12 the honeypot is hidden from people and assistive tech', async ({ page }) => {
  await page.goto('/login');
  const trap = page.locator('input[name="website"]');
  await expect(trap).toHaveCount(1);
  await expect(trap).toHaveAttribute('tabindex', '-1');
  await expect(trap).toHaveValue('');
  expect(await trap.evaluate((el) => !!el.closest('[aria-hidden="true"]'))).toBe(true);
  const box = await trap.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThan(0);
});

test('#11 Turnstile: its origin is allowed only while on; the widget token goes with the form', async ({ page }) => {
  const a = await admin();
  const off = await page.goto('/login');
  expect(off?.headers()['content-security-policy']).not.toContain('challenges.cloudflare.com');
  /* 离开这一页再开 Turnstile：否则这一页的 FormGuard 取到新设置会自己重新加载（见 form-guard），和下面的 goto 抢 */
  await page.goto('about:blank');
  const before = await a.patch('auth', FIELDS.auth, { turnstile_site_key: 'e2e-site-key', turnstile_secret: 'e2e-secret', turnstile_login: true });
  try {
    await page.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({
      contentType: 'text/javascript',
      body: 'window.__ts=[];window.turnstile={render:function(el,o){window.__ts.push({appearance:o.appearance,size:o.size,theme:o.theme,language:o.language});var b=document.createElement("span");b.textContent="turnstile";el.appendChild(b);setTimeout(function(){o.callback("fake-token")},50);return "w1"},reset:function(){},remove:function(){}};',
    }));
    const on = await page.goto('/login');
    const csp = on?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    await expect(page.getByText('turnstile', { exact: true })).toBeAttached();
    const opts = await page.evaluate(() => (window as unknown as { __ts: Record<string, string>[] }).__ts.at(-1));
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    expect(opts).toEqual({ appearance: 'interaction-only', size: 'flexible', theme: isDark ? 'dark' : 'light', language: 'zh-cn' });
    await expect(page.getByText('正在进行人机验证…')).toHaveCount(0);
    await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByText(/人机验证未通过|人机验证服务暂不可用/)).toBeVisible({ timeout: 20_000 });
  } finally {
    await a.patch('auth', FIELDS.auth, { ...before, turnstile_site_key: null, turnstile_secret: '' });
  }
});

/* Cloudflare 公开的测试密钥：组件总是通过、siteverify 总是接受 */
const TS_SITE_KEY = '1x00000000000000000000AA';
const TS_SECRET = '1x0000000000000000000000000000000AA';
const noCaptchaError = (page: Page) => expect(page.getByText(/人机验证未通过|人机验证服务暂不可用|邮箱或密码错误/)).toHaveCount(0);

test('#11 站长在登录页打开期间打开最短提交时间与 Turnstile：回到页面后第一次登录就成功', async ({ page }, info) => {
  const a = await admin();
  const before = await a.patch('auth', FIELDS.auth, { min_submit_secs: 0 });
  try {
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    await a.patch('auth', FIELDS.auth, {
      min_submit_secs: 2, turnstile_site_key: TS_SITE_KEY, turnstile_secret: TS_SECRET, turnstile_login: true,
    });
    /* 切回这个标签页：重新取防护设置；这一页的 CSP 不放行 Cloudflare 的脚本，页面自己重新加载一次 */
    await page.waitForTimeout(1000);
    const reloaded = page.waitForResponse((r) => r.request().resourceType() === 'document' && new URL(r.url()).pathname === '/login');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect((await reloaded).headers()['content-security-policy']).toContain('https://challenges.cloudflare.com');
    await page.waitForLoadState();
    await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    const button = page.getByRole('button', { name: '登录', exact: true });
    await expect(button).toBeEnabled({ timeout: 30_000 });
    const answer = page.waitForResponse((r) => r.url().endsWith('/auth/login'));
    await button.click();
    expect((await answer).status()).toBe(200);
    await dashboard(page);
    await noCaptchaError(page);
    await signOut(page, info);
    await expect(page).toHaveURL(/\/login/);
    /* 已经打开的单页应用里从别的页面进登录页（设置在那之前改过）：进来时就重新取 */
    await a.patch('auth', FIELDS.auth, { min_submit_secs: 3 });
    await page.getByRole('link', { name: '注册', exact: true }).last().click();
    await expect(page).toHaveURL(/\/register/);
    await page.getByRole('link', { name: '登录', exact: true }).last().click();
    await ready(page, '登录');
    await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    await expect(button).toBeEnabled({ timeout: 30_000 });
    await button.click();
    await dashboard(page);
    await noCaptchaError(page);
  } finally {
    await a.patch('auth', FIELDS.auth, { ...before, turnstile_site_key: null, turnstile_secret: '' });
  }
});

/* 每次渲染、重置都给一个新令牌的替身组件；校验仍走 Cloudflare 的测试密钥 */
const STUB_TURNSTILE =
  "(function(){var n=0,w={};window.turnstile={render:function(el,o){var id='w'+(++n);" +
  "w[id]=function(){setTimeout(function(){o.callback('tok-'+id+'-'+Date.now()+'-'+Math.random().toString(36).slice(2))},50)};" +
  'w[id]();return id},reset:function(id){w[id]&&w[id]()},remove:function(){}}})();';

test('#11 Turnstile + 2 秒：太快提交时页面替用户等；密码错了重试用的是新令牌，然后成功', async ({ page }) => {
  const a = await admin();
  const before = await a.patch('auth', FIELDS.auth, {
    min_submit_secs: 2, turnstile_site_key: TS_SITE_KEY, turnstile_secret: TS_SECRET, turnstile_login: true,
  });
  try {
    await page.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB_TURNSTILE }));
    const sent: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/auth/login')) sent.push(String(JSON.parse(r.postData() ?? '{}').guard?.turnstile));
    });
    await login(page, 'user@e2e.test', 'not-the-password');
    await expect(page.getByText('邮箱或密码错误')).toBeVisible();
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await dashboard(page);
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size, sent.join('\n')).toBe(2);
    for (const t of sent) expect(t).toMatch(/^tok-/);
  } finally {
    await a.patch('auth', FIELDS.auth, { ...before, turnstile_site_key: null, turnstile_secret: '' });
  }
});

test('#11 后台定期重新取设置不让最短提交时间重新计时：回到页面马上提交不用再等', async ({ page }) => {
  const a = await admin();
  const before = await a.patch('auth', FIELDS.auth, { min_submit_secs: 2 });
  try {
    const tokens: string[] = [];
    page.on('response', async (r) => {
      if (new URL(r.url()).pathname === '/auth/options') tokens.push((await r.json()).guard?.form_token);
    });
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    await page.waitForTimeout(2500);
    const refetched = page.waitForResponse((r) => new URL(r.url()).pathname === '/auth/options');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refetched;
    const posted = page.waitForRequest((r) => r.url().endsWith('/auth/login'));
    const clicked = Date.now();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const req = await posted;
    expect(Date.now() - clicked).toBeLessThan(1500);
    expect(req.postDataJSON().guard.form_token).toBe(tokens[0]);
    expect(tokens.at(-1)).not.toBe(tokens[0]);
    await dashboard(page);
  } finally {
    await a.patch('auth', FIELDS.auth, before);
  }
});

/* 第一次渲染就报错，重置之后才给令牌 */
const FAILING_TURNSTILE =
  "(function(){var n=0,w={};window.turnstile={render:function(el,o){var id='w'+(++n),k=0;" +
  "w[id]=function(){k++;setTimeout(function(){k===1?o['error-callback']('300030'):o.callback('tok-'+id+'-'+k)},50)};" +
  'w[id]();return id},reset:function(id){w[id]&&w[id]()},remove:function(){}}})();';

test('#11 人机验证加载失败：说清楚原因并给「重试」，而不是笼统的网络错误', async ({ page }, info) => {
  const a = await admin();
  const before = await a.patch('auth', FIELDS.auth, {
    min_submit_secs: 2, turnstile_site_key: TS_SITE_KEY, turnstile_secret: TS_SECRET, turnstile_login: true,
  });
  try {
    await page.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAILING_TURNSTILE }));
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    const alert = page.getByRole('alert').filter({ hasText: '人机验证加载失败，请刷新重试' });
    await expect(alert).toBeVisible();
    await expect(page.getByText(/网络/)).toHaveCount(0);
    await shot(page, info, 'login-turnstile-failed');
    const button = page.getByRole('button', { name: '登录', exact: true });
    await expect(button).toBeDisabled();
    await alert.getByRole('button', { name: '重试' }).click();
    await expect(alert).toHaveCount(0);
    await expect(button).toBeEnabled();
    await button.click();
    await dashboard(page);
    await signOut(page, info);
    await page.unroute('https://challenges.cloudflare.com/**');
    await page.route('https://challenges.cloudflare.com/**', (r) => r.abort());
    await page.goto('/login');
    await expect(alert).toBeVisible();
    const reloaded = page.waitForResponse((r) => r.request().resourceType() === 'document');
    await alert.getByRole('button', { name: '重试' }).click();
    await reloaded;
  } finally {
    await a.patch('auth', FIELDS.auth, { ...before, turnstile_site_key: null, turnstile_secret: '' });
  }
});

test('site settings that do not load: say so and offer a retry, instead of silently hiding sign-up', async ({ page }) => {
  await page.route('**/auth/options', (r) => r.abort());
  await page.goto('/login');
  const alert = page.getByRole('alert').filter({ hasText: '站点设置没能加载，暂时无法登录或注册。' });
  await expect(alert).toBeVisible();
  await page.unroute('**/auth/options');
  await alert.getByRole('button', { name: '重试' }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByRole('link', { name: '忘记密码' })).toBeVisible();
});

test('#13 forgotten password: link by mail, new password, every session ends', async ({ page }, info) => {
  const email = mine(info, 'v2-reset');
  await page.goto('/forgot');
  await shot(page, info, 'forgot');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  const sent = Date.now() - 1000;
  await page.getByRole('button', { name: '发送重置链接' }).click();
  await expect(page.getByText(/重置链接已经发出/)).toBeVisible();
  await shot(page, info, 'forgot-sent');
  const link = /https:\/\/\S+\/reset#token=[A-Za-z0-9_-]+/.exec(await latestMail(email, sent))?.[0] ?? '';
  expect(link).toContain(process.env.E2E_ORIGIN ?? '');
  await page.goto(link);
  await expect(page).not.toHaveURL(/token=/);
  await ready(page, '设置新密码');
  const next = `new-${seed.password}`;
  /* 两次不一致：失焦就提示 */
  await page.getByLabel('新密码', { exact: true }).fill(next);
  await page.getByLabel('确认新密码').fill(`${next}x`);
  await page.getByLabel('新密码', { exact: true }).focus();
  await expect(page.getByText('两次输入的新密码不一致')).toBeVisible();
  await shot(page, info, 'reset');
  await page.getByLabel('确认新密码').fill(next);
  await page.getByRole('button', { name: '重置密码' }).click();
  await expect(page.getByText('密码已重置，请用新密码登录')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await signInUI(page, email, next);
  await dashboard(page);
});

test('a bad reset link is refused with the mapped message; no token at all = the link is invalid', async ({ page }) => {
  await page.goto('/reset#token=not-a-real-token');
  await expect(page).not.toHaveURL(/token=/);
  await page.getByLabel('新密码', { exact: true }).fill('another-password-1');
  await page.getByLabel('确认新密码').fill('another-password-1');
  await page.getByRole('button', { name: '重置密码' }).click();
  await expect(page.getByText(/链接无效或已过期|验证码错误或已过期/)).toBeVisible();
  await page.goto('/reset');
  await ready(page, '链接无效');
  await page.getByRole('link', { name: '重新申请重置' }).click();
  await expect(page).toHaveURL(/\/forgot$/);
});

test('#3 #4 #5 passkeys: offered after a password login, then sign-in without a password, passkey-only', async ({ page }, info) => {
  const a = await admin();
  const before = await a.patch('auth', FIELDS.auth, { passkey_prompt: true });
  try {
    const auth1 = await authenticator(page);
    const email = mine(info, 'v2-passkey');
    await signInUI(page, email);
    /* 密码登录后引导绑定（对话框），打开「以后只用通行密钥登录」 */
    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText('给这台设备添加通行密钥？')).toBeVisible();
    await shot(page, info, 'passkey-prompt');
    const only = prompt.getByRole('switch');
    await expect(only).toHaveAttribute('aria-checked', 'false');
    await only.click();
    await expect(only).toHaveAttribute('aria-checked', 'true');
    await prompt.getByRole('button', { name: '添加通行密钥' }).click();
    await expect(page.getByText('通行密钥已添加').first()).toBeVisible();
    await expect(page.getByText('以后这个账户只能用通行密钥登录')).toBeVisible();
    await expect(prompt).toHaveCount(0);

    /* 退出后用通行密钥登录（可发现凭据，不填邮箱） */
    await page.context().clearCookies();
    await page.evaluate(() => sessionStorage.clear());
    await page.goto('/login');
    await page.getByRole('button', { name: '使用通行密钥登录' }).click();
    await dashboard(page);

    /* 这个账户只用通行密钥：密码登录被拒，通行密钥按钮提到表单前面（主按钮） */
    await page.context().clearCookies();
    await page.evaluate(() => sessionStorage.clear());
    await login(page, email);
    await expect(page.getByText('这个账户只能用通行密钥登录。')).toBeVisible();
    const pk = page.getByRole('button', { name: '使用通行密钥登录' });
    await expect(pk).toHaveCount(1);
    await expect(pk).toHaveClass(/pri/);
    await shot(page, info, 'login-passkey-only');

    /* 通行密钥用不了（回退）：密码 + 发到已验证邮箱的验证码；错码被拒，对的码登录 */
    const fb = page.getByTestId('passkey-fallback');
    await page.getByRole('button', { name: '通行密钥用不了？改用密码 + 邮箱验证码' }).click();
    const sentAt = Date.now() - 1000;
    await fb.getByRole('button', { name: '发送邮箱验证码' }).click();
    await expect(fb.getByText('验证码已发送到账户的已验证邮箱')).toBeVisible();
    await shot(page, info, 'login-passkey-fallback');
    const code = /\b(\d{6})\b/.exec(await latestMail(email, sentAt))?.[1] ?? '';
    expect(code).toMatch(/^\d{6}$/);
    await page.getByLabel('邮箱验证码').fill(code === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByText('验证码不正确或已失效，请重新获取')).toBeVisible();
    await page.getByLabel('邮箱验证码').fill(code);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await dashboard(page);
    await page.context().clearCookies();
    await page.evaluate(() => sessionStorage.clear());
    await login(page, email);
    await expect(page.getByText('这个账户只能用通行密钥登录。')).toBeVisible();
    await pk.click();
    await dashboard(page);
    /* 「以后再说」只问一次：没有 passkey_prompt 的登录不再弹 */
    await expect(page.getByRole('dialog')).toHaveCount(0);

    /* 设置页（PR 6）：通行密钥列表、改名、删除最后一个的确认、只用通行密钥的开关、再添加一个 */
    await page.goto('/account#security');
    await ready(page, '设置');
    const security = page.locator('#security');
    const onlySwitch = security.getByRole('switch', { name: '只用通行密钥登录' });
    await expect(onlySwitch).toHaveAttribute('aria-checked', 'true');
    const row = security.locator('li').first();
    await expect(row.getByText(/添加于 \d{4}-/)).toBeVisible();
    const desktopView = info.project.name === 'desktop';
    if (desktopView) await row.getByRole('button', { name: /^重命名 / }).click();
    else {
      await row.getByRole('button', { name: /的操作$/ }).click();
      await page.getByRole('menuitem', { name: '重命名' }).click();
    }
    const name = security.getByLabel('通行密钥名称');
    await name.fill('E2E 钥匙');
    await security.getByRole('button', { name: '保存' }).click();
    await expect(row.getByText('E2E 钥匙', { exact: true })).toBeVisible();
    /* 删除最后一个当前可用的通行密钥：确认框写明「只用通行密钥」会随之失效（这里取消） */
    if (desktopView) await row.getByRole('button', { name: '删除 E2E 钥匙' }).click();
    else {
      await row.getByRole('button', { name: 'E2E 钥匙 的操作' }).click();
      await page.getByRole('menuitem', { name: '删除' }).click();
    }
    const del = page.getByRole('alertdialog', { name: '删除通行密钥「E2E 钥匙」？' });
    await expect(del.getByText('设备里保存的那一份需要在设备上自行删除')).toBeVisible();
    await expect(del.getByText(/这是最后一个可用的通行密钥/)).toBeVisible();
    await shot(page, info, 'account-passkey-delete');
    await del.getByRole('button', { name: '取消' }).click();
    await expect(del).toHaveCount(0);
    /* 关掉直接生效；再打开要先确认 */
    await onlySwitch.click();
    await expect(page.getByText('已恢复密码登录').first()).toBeVisible();
    await expect(onlySwitch).toHaveAttribute('aria-checked', 'false');
    await onlySwitch.click();
    const ask = page.getByRole('alertdialog', { name: '只用通行密钥登录？' });
    await expect(ask.getByText('通行密钥全部丢失时，需要联系管理员恢复')).toBeVisible();
    await ask.getByRole('button', { name: '取消' }).click();
    await expect(onlySwitch).toHaveAttribute('aria-checked', 'false');
    await onlySwitch.click();
    await ask.getByRole('button', { name: '确认开启' }).click();
    await expect(page.getByText('已改为只用通行密钥登录').first()).toBeVisible();
    await expect(onlySwitch).toHaveAttribute('aria-checked', 'true');
    await onlySwitch.click();
    await expect(page.getByText('已恢复密码登录').first()).toBeVisible();
    /* 设置页上再添加一个：服务端带 excludeCredentials，同一个认证器会拒绝，换一台（新的虚拟认证器） */
    await auth1.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: auth1.authenticatorId });
    await auth1.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR });
    await security.getByRole('button', { name: '添加通行密钥' }).click();
    await expect(page.getByText('通行密钥已添加').first()).toBeVisible();
    await expect(security.locator('li')).toHaveCount(2);
    await shot(page, info, 'account-security');
  } finally {
    await a.patch('auth', FIELDS.auth, before);
  }
});

test('a browser that refuses the site\'s passkeys gets the emailed-code fallback up front', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.credentials.get = () => Promise.reject(new DOMException('related origin not allowed', 'SecurityError'));
  });
  await page.goto('/login');
  await page.getByRole('button', { name: '使用通行密钥登录' }).click();
  const fb = page.getByTestId('passkey-fallback');
  await expect(fb.getByText('这个浏览器无法使用本站的通行密钥')).toBeVisible();
  await expect(fb.getByRole('button', { name: '发送邮箱验证码' })).toHaveClass(/pri/);
  await expect(fb.getByRole('button', { name: '使用通行密钥登录' })).toHaveCount(0);
});

test('registration with a passkey: no address or password, then an email must be bound (a dialog that cannot be closed)', async ({ page }, info) => {
  const a = await admin();
  const before = await a.patch('signup', FIELDS.signup, { passkey_register: true, email_verify: false });
  try {
    await authenticator(page);
    await page.goto('/register');
    await expect(page.getByText('不用设置密码；创建后需要绑定一个邮箱才能使用。')).toBeVisible();
    await page.getByRole('button', { name: '用通行密钥注册' }).click();
    const bind = page.getByRole('dialog', { name: '绑定邮箱' });
    await expect(bind).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('账号已创建', { exact: true })).toBeVisible();
    /* 不可关闭：没有关闭按钮，Esc 不起作用 */
    await expect(bind.getByRole('button', { name: '关闭' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(bind).toBeVisible();
    await shot(page, info, 'bind-email');
    await bind.getByRole('button', { name: '完成绑定' }).click();
    await expect(bind.getByText('请输入邮箱', { exact: true })).toBeVisible();
    await bind.getByLabel('邮箱', { exact: true }).fill(freshEmail('bind'));
    await bind.getByRole('button', { name: '完成绑定' }).click();
    await expect(page.getByText('邮箱已绑定')).toBeVisible();
    await expect(bind).toHaveCount(0);
    await dashboard(page);
  } finally {
    await a.patch('signup', FIELDS.signup, before);
  }
});

test('#16 signing out ends the account\'s sessions on every device', async ({ page, browser }, info) => {
  const email = mine(info, 'logout');
  await signIn(page, email);
  await page.goto('/');
  await dashboard(page);
  const other = await browser.newContext();
  const elsewhere = await other.newPage();
  await signIn(elsewhere, email);
  await elsewhere.goto('/');
  await ready(elsewhere, '仪表盘');
  await signOut(page, info);
  await expect(page.getByText('所有设备上的登录都已结束')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await elsewhere.goto('/orders');
  await expect(elsewhere).toHaveURL(/\/login/);
  await other.close();
});

test('the tab title is "page · site name" and follows a renamed site, before and after sign-in', async ({ page }, info) => {
  const a = await admin();
  const name = `E2E 站点 v2 ${info.project.name}`;
  const s = await a.call<{ version: number; site_name: string | null }>('GET', '/api/v1/settings');
  await a.call('PUT', '/api/v1/settings/site', { version: s.version, site_name: name });
  try {
    await page.goto('/login');
    await expect(page).toHaveTitle(`登录 · ${name}`);
    await signInUI(page, 'user@e2e.test');
    await expect(page).toHaveTitle(`仪表盘 · ${name}`);
  } finally {
    const now = await a.call<{ version: number }>('GET', '/api/v1/settings');
    await a.call('PUT', '/api/v1/settings/site', { version: now.version, site_name: s.site_name });
  }
});

test('#61 terms and privacy: the site\'s own text, a neutral default until it is written; #14 an external terms link', async ({ page }, info) => {
  for (const [path, title] of [['/terms', '服务条款'], ['/privacy', '隐私政策']]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByText(/尚未发布这份文件。如有疑问，请登录后提交工单联系我们。/)).toBeVisible();
  }
  const a = await admin();
  const terms = await a.call<{ id: string }>('POST', '/api/v1/kb/articles', {
    title_zh: 'E2E 服务条款 v2', body_zh: '本站条款 **正文**\n\n### 一、账户\n\n- 一人一个账户\n- 不得转售', published: true, slug: 'terms',
  });
  try {
    await page.goto('/terms');
    await expect(page.getByRole('heading', { level: 1, name: 'E2E 服务条款 v2' })).toBeVisible();
    await expect(page.locator('.rich strong', { hasText: '正文' })).toBeVisible();
    await expect(page.getByText('最后更新')).toBeVisible();
    await shot(page, info, 'terms');
    await dark(page);
    await shot(page, info, 'terms-dark');
  } finally {
    await a.call('DELETE', `/api/v1/kb/articles/${terms.id}`);
  }
  /* 站长配了条款外链：注册页与页脚直接指向外链（新标签页） */
  const before = await a.patch('branding', FIELDS.branding, { tos_url: 'https://example.com/tos' });
  try {
    await page.goto('/register');
    const links = page.getByRole('link', { name: '服务条款' });
    await expect(links.first()).toBeVisible();
    for (const l of await links.all()) {
      await expect(l).toHaveAttribute('href', 'https://example.com/tos');
      await expect(l).toHaveAttribute('target', '_blank');
    }
    await expect(page.locator('main').getByRole('link', { name: '隐私政策' })).toHaveAttribute('href', '/privacy');
  } finally {
    await a.patch('branding', FIELDS.branding, before);
  }
});

test('the result page after an account is deleted; going back to sign in replaces it in the history', async ({ page }, info) => {
  await page.goto('/login');
  await page.goto('/deleted');
  await ready(page, '账户已注销');
  await expect(page.getByText('你的账户已注销，所有设备上的登录都已结束。')).toBeVisible();
  await shot(page, info, 'deleted');
  await page.getByRole('link', { name: '返回登录页' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
});

test('#60 phones: no guest page scrolls sideways; light and dark screenshots', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'only narrow screens can overflow');
  for (const path of ['/login', '/register', '/forgot', '/reset', '/deleted', '/terms']) {
    await page.goto(path);
    await expect(page.locator('main h1').first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), path).toBe(true);
  }
  await page.goto('/forgot');
  await dark(page);
  await shot(page, info, 'forgot-dark');
});
