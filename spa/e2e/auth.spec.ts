/*
 * 登录、注册、找回密码、通行密钥、公开表单防护（research/portal-gap.md §1.1 #1–#16）。
 */
import type { Page } from '@playwright/test';
import { FIELDS, latestMail } from './panel.ts';
import { admin, authenticator, expect, login, mine, open, seed, signIn, signOut, test } from './fixtures.ts';

test.describe.configure({ mode: 'serial' });

const freshEmail = (tag: string) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.test`;

test('#1 #2 wrong password = the uniform answer; a full account lands on the dashboard', async ({ page }) => {
  await login(page, 'user@e2e.test', 'not-the-password');
  await expect(page.getByText('邮箱或密码错误')).toBeVisible();
  await signIn(page, 'user@e2e.test');
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('#2 D4: admin credentials get the same answer as a wrong password; no console address anywhere', async ({ page }) => {
  await login(page, process.env.E2E_ADMIN_EMAIL ?? '', process.env.E2E_ADMIN_PASSWORD ?? '');
  await expect(page.getByText('邮箱或密码错误')).toBeVisible();
  const prefix = new URL(process.env.E2E_ADMIN_BASE ?? '').pathname;
  expect(await page.content()).not.toContain(prefix);
  expect(await page.locator('a[href*="admin"]').count()).toBe(0);
});

test('#7 #10 registration with the proof of work; the trial plan is announced', async ({ page }) => {
  const a = await admin();
  const plans = await a.call<{ id: string; name: string }[]>('GET', '/api/v1/plans');
  const before = await a.patch('signup', FIELDS.signup, { trial_plan_id: plans.find((p) => p.name === seed.plan)?.id, trial_days: 3 });
  try {
    await page.goto('/register');
    await page.getByLabel('邮箱', { exact: true }).fill(freshEmail('pow'));
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '创建账号' }).click();
    await expect(page.getByText('已赠送试用套餐，现在就可以使用')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
    await expect(page.getByRole('button', { name: '复制订阅链接' }).first()).toBeVisible();
  } finally {
    await a.patch('signup', FIELDS.signup, before);
  }
});

test('#6 registration with an emailed code (email verification on)', async ({ page }) => {
  const a = await admin();
  const before = await a.patch('signup', FIELDS.signup, { email_verify: true });
  try {
    const email = freshEmail('code');
    await page.goto('/register');
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    const sent = Date.now() - 1000;
    await page.getByRole('button', { name: '发送验证码' }).click();
    const code = /\b(\d{6})\b/.exec(await latestMail(email, sent))?.[1] ?? '';
    expect(code).toMatch(/^\d{6}$/);
    await page.getByLabel('邮箱验证码').fill(code);
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '创建账号' }).click();
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible({ timeout: 30_000 });
  } finally {
    await a.patch('signup', FIELDS.signup, before);
  }
});

test('#8 #9 site switches: closed registration, invite required + allowed domains, no self-service reset; ?invite= prefills', async ({ page }) => {
  const a = await admin();
  let before = await a.patch('signup', FIELDS.signup, { register_enabled: false, reset_enabled: false });
  try {
    await page.goto('/register');
    await expect(page.getByText('网站已暂停注册新用户。')).toBeVisible();
    await page.goto('/login');
    await expect(page.getByRole('link', { name: '忘记密码' })).toHaveCount(0);
    await a.patch('signup', FIELDS.signup, before);
    before = await a.patch('signup', FIELDS.signup, { invite_required: true, email_domains: ['example.org'] });
    await page.goto('/register?invite=E2EINVITE');
    await expect(page.getByLabel(/邀请码/)).toHaveValue('E2EINVITE');
    await expect(page.getByText('example.org')).toBeVisible();
    await page.getByLabel('邮箱', { exact: true }).fill(freshEmail('dom'));
    await page.getByLabel('密码', { exact: true }).fill('e2e-password-123');
    await page.getByRole('button', { name: '创建账号' }).click();
    await expect(page.getByText(/不支持该邮箱域名|邀请码/).first()).toBeVisible({ timeout: 30_000 });
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
  /* 移到屏幕外：人看不见 */
  const box = await trap.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThan(0);
});

test('#11 Turnstile: its origin is allowed only while on; the widget token goes with the form', async ({ page }) => {
  const a = await admin();
  /* 没开：门户页的 CSP 只有本站 */
  const off = await page.goto('/login');
  expect(off?.headers()['content-security-policy']).not.toContain('challenges.cloudflare.com');
  const before = await a.patch('auth', FIELDS.auth, { turnstile_site_key: 'e2e-site-key', turnstile_secret: 'e2e-secret', turnstile_login: true });
  try {
    /* 用一个假的 Turnstile 脚本代替 Cloudflare 的（测试不连外网）：渲染时直接回调一个令牌 */
    await page.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({
      contentType: 'text/javascript',
      body: 'window.turnstile={render:function(el,o){var b=document.createElement("span");b.textContent="turnstile";el.appendChild(b);setTimeout(function(){o.callback("fake-token")},50);return "w1"},reset:function(){},remove:function(){}};',
    }));
    const on = await page.goto('/login');
    const csp = on?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    await expect(page.getByText('turnstile', { exact: true })).toBeAttached();
    await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    /* 面板拿假令牌去 Cloudflare 校验：不通过或校验不可达，两种都有对应文案 */
    await expect(page.getByText(/人机验证未通过|人机验证服务暂不可用/)).toBeVisible({ timeout: 20_000 });
  } finally {
    await a.patch('auth', FIELDS.auth, { ...before, turnstile_site_key: null, turnstile_secret: '' });
  }
});

/* Cloudflare 公开的测试密钥：组件总是通过、siteverify 总是接受 */
const TS_SITE_KEY = '1x00000000000000000000AA';
const TS_SECRET = '1x0000000000000000000000000000000AA';
const noCaptchaError = (page: Page) => expect(page.getByText(/人机验证未通过|人机验证服务暂不可用|邮箱或密码错误/)).toHaveCount(0);

test('#11 站长在登录页打开期间打开最短提交时间与 Turnstile：回到页面后第一次登录就成功', async ({ page }) => {
  const a = await admin();
  const before = await a.patch('auth', FIELDS.auth, { min_submit_secs: 0 });
  try {
    /* 页面按「没有最短时间、没有 Turnstile」打开（拿到的表单令牌是 null） */
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    /* 这时站长在后台：最短提交时间 2 秒 + 登录用 Turnstile（v0.4.0：这页从此每次提交都是「人机验证未通过」） */
    await a.patch('auth', FIELDS.auth, {
      min_submit_secs: 2, turnstile_site_key: TS_SITE_KEY, turnstile_secret: TS_SECRET, turnstile_login: true,
    });
    /*
     * 用户切回这个标签页：页面重新取防护设置。这一页打开时没有表单开 Turnstile，CSP 不放行 Cloudflare 的脚本，
     * 所以页面自己重新加载一次；之后组件出现，拿到令牌前按钮不可用
     */
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
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible({ timeout: 20_000 });
    await noCaptchaError(page);
    await signOut(page);
    await expect(page).toHaveURL(/\/login/);
    /* 已经打开的单页应用里从别的页面进登录页（设置在那之前改过）：进来时就重新取 */
    await a.patch('auth', FIELDS.auth, { min_submit_secs: 3 });
    await page.getByRole('link', { name: '注册', exact: true }).last().click();
    await expect(page).toHaveURL(/\/register/);
    await page.getByRole('link', { name: '登录', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    await expect(button).toBeEnabled({ timeout: 30_000 });
    await button.click();
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible({ timeout: 20_000 });
    await noCaptchaError(page);
  } finally {
    await a.patch('auth', FIELDS.auth, { ...before, turnstile_site_key: null, turnstile_secret: '' });
  }
});

/* 每次渲染、重置都给一个新令牌的替身组件（测试站点密钥总是给同一个假令牌，重复使用看不出来）；校验仍走 Cloudflare 的测试密钥 */
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
    /* 打开就立刻提交（不到 2 秒）：不会被当成机器人 */
    await login(page, 'user@e2e.test', 'not-the-password');
    await expect(page.getByText('邮箱或密码错误')).toBeVisible();
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible({ timeout: 20_000 });
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
    /* 用户切回标签页：重新取一遍（面板发了新令牌），然后马上提交 */
    const refetched = page.waitForResponse((r) => new URL(r.url()).pathname === '/auth/options');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refetched;
    const posted = page.waitForRequest((r) => r.url().endsWith('/auth/login'));
    const clicked = Date.now();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const req = await posted;
    expect(Date.now() - clicked).toBeLessThan(1500);
    /* 交上去的是页面一开始拿到的那个（已经够老的）令牌，不是刚取的新令牌 */
    expect(req.postDataJSON().guard.form_token).toBe(tokens[0]);
    expect(tokens.at(-1)).not.toBe(tokens[0]);
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  } finally {
    await a.patch('auth', FIELDS.auth, before);
  }
});

/* 第一次渲染就报错（相当于 Cloudflare 挑战没通过 / 无头浏览器被拦），重置之后才给令牌 */
const FAILING_TURNSTILE =
  "(function(){var n=0,w={};window.turnstile={render:function(el,o){var id='w'+(++n),k=0;" +
  "w[id]=function(){k++;setTimeout(function(){k===1?o['error-callback']('300030'):o.callback('tok-'+id+'-'+k)},50)};" +
  'w[id]();return id},reset:function(id){w[id]&&w[id]()},remove:function(){}}})();';

test('#11 人机验证加载失败：说清楚原因并给「重试」，而不是笼统的网络错误', async ({ page }) => {
  const a = await admin();
  const before = await a.patch('auth', FIELDS.auth, {
    min_submit_secs: 2, turnstile_site_key: TS_SITE_KEY, turnstile_secret: TS_SECRET, turnstile_login: true,
  });
  try {
    /* 组件出错：提示 + 重试（重置组件），拿到令牌后照常登录 */
    await page.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAILING_TURNSTILE }));
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill('user@e2e.test');
    await page.getByLabel('密码', { exact: true }).fill(seed.password);
    const alert = page.getByRole('alert').filter({ hasText: '人机验证加载失败，请刷新重试' });
    await expect(alert).toBeVisible();
    await expect(page.getByText(/网络/)).toHaveCount(0);
    const button = page.getByRole('button', { name: '登录', exact: true });
    await expect(button).toBeDisabled();
    await alert.getByRole('button', { name: '重试' }).click();
    await expect(alert).toHaveCount(0);
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible({ timeout: 20_000 });
    await signOut(page);
    /* 脚本被拦（加载不出来）：同样的提示；重试 = 重新加载页面 */
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

test('#13 forgotten password: link by mail, new password, every session ends', async ({ page }, info) => {
  const email = mine(info, 'reset');
  await page.goto('/forgot');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  const sent = Date.now() - 1000;
  await page.getByRole('button', { name: '发送重置链接' }).click();
  await expect(page.getByText(/重置链接已经发出/)).toBeVisible();
  const link = /https:\/\/\S+\/reset#token=[A-Za-z0-9_-]+/.exec(await latestMail(email, sent))?.[0] ?? '';
  expect(link).toContain(process.env.E2E_ORIGIN ?? '');
  await page.goto(link);
  await expect(page).not.toHaveURL(/token=/);
  const next = `new-${seed.password}`;
  await page.getByLabel('新密码', { exact: true }).fill(next);
  await page.getByLabel('确认新密码').fill(next);
  await page.getByRole('button', { name: '重置密码' }).click();
  await expect(page.getByText('密码已重置，请用新密码登录')).toBeVisible();
  await signIn(page, email, next);
  await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
});

test('a bad reset link is refused with the mapped message', async ({ page }) => {
  await page.goto('/reset#token=not-a-real-token');
  await expect(page).not.toHaveURL(/token=/);
  await page.getByLabel('新密码', { exact: true }).fill('another-password-1');
  await page.getByLabel('确认新密码').fill('another-password-1');
  await page.getByRole('button', { name: '重置密码' }).click();
  await expect(page.getByText(/链接无效或已过期|验证码错误或已过期/)).toBeVisible();
});

test('#3 #4 #5 #24 #25 passkeys: offered after a password login, then sign-in without a password, passkey-only and back', async ({ page }, info) => {
  const a = await admin();
  const before = await a.patch('auth', FIELDS.auth, { passkey_prompt: true });
  try {
    await authenticator(page);
    const email = mine(info, 'passkey');
    await signIn(page, email);
    /* 密码登录后引导绑定，勾上「以后只用通行密钥登录」 */
    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText('给这台设备添加通行密钥？')).toBeVisible();
    await prompt.getByRole('switch').click();
    await prompt.getByRole('button', { name: '添加通行密钥' }).click();
    await expect(page.getByText('通行密钥已添加').first()).toBeVisible();

    /* 退出后用通行密钥登录（可发现凭据，不填邮箱） */
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByRole('button', { name: '使用通行密钥登录' }).click();
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();

    /* 这个账户只用通行密钥：密码登录被拒，给出对应提示 */
    await page.context().clearCookies();
    await login(page, email);
    await expect(page.getByText('这个账户只能用通行密钥登录。')).toBeVisible();

    /* 账户页：通行密钥列表、改名、恢复密码登录 */
    await page.getByRole('button', { name: '使用通行密钥登录' }).click();
    await expect(page.getByRole('heading', { name: '仪表盘' })).toBeVisible();
    await open(page, '/account?tab=security');
    await expect(page.getByText('只用通行密钥登录')).toBeVisible();
    await page.getByRole('switch', { name: '只用通行密钥登录' }).click();
    await expect(page.getByText('已恢复密码登录')).toBeVisible();
    await page.context().clearCookies();
    await signIn(page, email);
  } finally {
    await a.patch('auth', FIELDS.auth, before);
  }
});

test('#16 signing out ends the account\'s sessions on every device', async ({ page, browser }, info) => {
  const email = mine(info, 'logout');
  await signIn(page, email);
  const other = await browser.newContext();
  const elsewhere = await other.newPage();
  await signIn(elsewhere, email);
  await expect(elsewhere.getByRole('heading', { name: '仪表盘' })).toBeVisible();
  await signOut(page);
  await expect(page.getByText('所有设备上的登录都已结束')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  /* 另一台设备的会话也结束了：下一个请求就被送回登录页 */
  await elsewhere.goto('/orders');
  await expect(elsewhere).toHaveURL(/\/login/);
  await other.close();
});
