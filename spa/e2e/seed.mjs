#!/usr/bin/env node
/*
 * 给端到端测试准备一个真实面板里的数据（通过后台接口，和管理员在后台点出来的一样）。
 *
 *   PANEL_URL=http://127.0.0.1:18480 PANEL_PREFIX=… ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *   PSQL="docker exec -i <postgres 容器> psql -U akari -d <库>" node e2e/seed.mjs
 *
 * 面板不允许直接改到期时间（D12），「已过期」账户只能在数据库里把到期时间拨到过去：这一步用 PSQL。
 * 输出一行 JSON（账户与套餐），由 scripts/e2e-local.sh 存成 e2e/.seed.json 给测试读。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PANEL = process.env.PANEL_URL;
const P = `/${process.env.PANEL_PREFIX}`;
const PW = 'e2e-password-123';
let cookie = '';

async function call(method, path, body) {
  const r = await fetch(`${PANEL}${P}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.getSetCookie();
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

/* 公开表单要带 guard：先取 /auth/options 的表单令牌，等过最短提交时间 */
async function guard() {
  const o = await call('GET', '/auth/options');
  await new Promise((r) => setTimeout(r, (o.guard?.form_min_secs ?? 0) * 1000 + 300));
  return { ...(o.guard?.form_token ? { form_token: o.guard.form_token } : {}), website: '' };
}

await call('POST', '/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, guard: await guard() });

/* 主域名 = 测试用的门户地址；支付回调、订阅地址都按它生成（IP 地址上没有通行密钥，那部分由单测覆盖） */
const settings = await call('GET', '/api/v1/settings');
await call('PUT', '/api/v1/settings', {
  version: settings.version, main_domain: process.env.PORTAL_HOST, sub_domain: null, node_domain: '127.0.0.1:18443', trust_cloudflare: null,
});

/* 支付方式：指向模拟网关的支付宝当面付（商店只在有可用的支付方式时列出套餐） */
const pay = (f) => readFileSync(`${process.env.PAY_DIR}/${f}`, 'utf8');
await call('POST', '/api/v1/settings/payments', {
  kind: 'alipay_f2f', display_name: '支付宝', enabled: true,
  config: {
    environment: 'custom', gateway_url: `${process.env.MOCK_ALIPAY}/gateway.do`, app_id: '2021000000000001',
    seller_id: '2088000000000001', app_private_key: pay('app-key.pem'), alipay_public_key: pay('alipay-pub.pem'),
    order_timeout_minutes: 15,
  },
});

/* 注册：开放、不要邮箱验证（工作量证明那条路）、不要邀请码；找回密码要邮件服务，测试面板没有，关着 */
const signup = await call('GET', '/api/v1/settings/signup');
await call('PUT', '/api/v1/settings/signup', {
  version: signup.version, register_enabled: true, invite_required: false, invite_single_use: false,
  invite_codes_per_user: 5, email_domains: [], trial_plan_id: null, trial_days: signup.trial_days ?? 3,
  reset_enabled: false, email_verify: false,
});

const plan = await call('POST', '/api/v1/plans', {
  name: 'E2E 标准', period: 'monthly', traffic_quota_bytes: 100 * 1024 ** 3, speed_limit_mbps: 300,
  description: '- 全部节点\n- 每月重置流量',
  pricing: { on_sale: true, prices: [
    { period: 'month', days: null, price_cents: 1500 },
    { period: 'year', days: null, price_cents: 15000 },
    { period: 'reset', days: null, price_cents: 500 },
  ] },
});
const premium = await call('POST', '/api/v1/plans', {
  name: 'E2E 高级', period: 'monthly', traffic_quota_bytes: 500 * 1024 ** 3, speed_limit_mbps: null,
  description: '更多流量', pricing: { on_sale: true, prices: [{ period: 'month', days: null, price_cents: 3000 }] },
});

const user = await call('POST', '/api/v1/users', { email: 'user@e2e.test', password: PW, plan: { plan_id: plan.id, period: 'month' } });
await call('POST', `/api/v1/users/${user.id}/balance`, { amount_cents: 20000, reason: 'e2e' });
/* 商店用例会换套餐：桌面、手机各一个账户，互不影响 */
for (const v of ['desktop', 'mobile']) {
  const u = await call('POST', '/api/v1/users', { email: `shop-${v}@e2e.test`, password: PW, plan: { plan_id: plan.id, period: 'month' } });
  await call('POST', `/api/v1/users/${u.id}/balance`, { amount_cents: 20000, reason: 'e2e' });
}
const expired = await call('POST', '/api/v1/users', { email: 'expired@e2e.test', password: PW, plan: { plan_id: plan.id, period: 'month' } });
const banned = await call('POST', '/api/v1/users', { email: 'banned@e2e.test', password: PW });
await call('POST', `/api/v1/users/${banned.id}/ban`, { reason: 'E2E：违反服务条款' });
await call('POST', '/api/v1/users', { email: 'plain@e2e.test', password: PW });

await call('POST', '/api/v1/announcements', {
  title_zh: 'E2E 维护通知', title_en: 'E2E maintenance', body_zh: '今晚 **维护** 一小时。', body_en: 'One hour of **maintenance** tonight.', pinned: true,
});
const cat = await call('POST', '/api/v1/kb/categories', { name_zh: 'Windows 教程', name_en: 'Windows guides' });
await call('POST', '/api/v1/kb/articles', {
  category_id: cat.id, title_zh: 'E2E 第一篇', title_en: 'E2E first article', body_zh: '## 安装\n下载客户端。', body_en: '## Install\nDownload the client.', published: true,
});

execFileSync('sh', ['-c', `${process.env.PSQL} -v ON_ERROR_STOP=1 -q`], {
  input: `UPDATE users SET expires_at = now() - interval '1 day' WHERE id = '${expired.id}';\n`
    + `UPDATE user_plans SET expires_at = now() - interval '1 day' WHERE user_id = '${expired.id}' AND status = 'active';\n`,
  stdio: ['pipe', 'inherit', 'inherit'],
});

console.log(JSON.stringify({ mock: process.env.MOCK_ALIPAY, password: PW, plan: plan.name, premium: premium.name, admin: process.env.ADMIN_EMAIL, adminPassword: process.env.ADMIN_PASSWORD }));
