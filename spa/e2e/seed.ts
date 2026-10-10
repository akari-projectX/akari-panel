/*
 * 给门户端到端测试准备一个真实面板里的数据：通过后台接口（和管理员在后台点出来的一样），
 * 面板刻意不提供接口的状态（过去的到期时间、历史流量、邀请人）才直接写库。
 *
 *   node e2e/seed.ts > seed.json        （环境变量由 ../scripts/e2e-portal.sh 设置）
 *
 * 输出一行 JSON，测试读它（E2E_SEED）。会改状态的用例每个视口（desktop / mobile）各用一个账户，互不影响。
 */
import { readFileSync } from 'node:fs';
import { Client, payAtGateway, psql, until } from './panel.ts';

const PW = 'e2e-password-123';
const PROJECTS = ['desktop', 'mobile'] as const;
const origin = new URL(process.env.E2E_ORIGIN ?? '');
const admin = await Client.admin();

/* ── 站点：主域名 = 测试用的门户地址（通行密钥的 RP、邮件链接、支付回调都按它）；邮件发到 Mailpit ── */
const site = await admin.call<{ version: number }>('GET', '/api/v1/settings');
await admin.call('PUT', '/api/v1/settings', {
  version: site.version, main_domains: [origin.host], sub_domains: [], node_domains: ['127.0.0.1:8453'], trust_cloudflare: null,
});
await admin.call('PUT', '/api/v1/settings/mail', {
  version: 0, enabled: true, host: '127.0.0.1', port: Number(process.env.E2E_SMTP_PORT), security: 'none', username: null,
  from_addr: 'noreply@e2e.test', from_name: 'Akari E2E', notify_order_paid: true, notify_expiry_days: 3,
  notify_expired: true, notify_quota: true,
});

/* ── 支付：指向模拟网关的支付宝当面付，允许原路退款 ── */
const pay = (f: string) => readFileSync(`${process.env.E2E_PAY_DIR}/${f}`, 'utf8');
await admin.call('POST', '/api/v1/settings/payments', {
  kind: 'alipay_f2f', display_name: '支付宝', enabled: true,
  config: {
    environment: 'custom', gateway_url: `${process.env.E2E_MOCK_ALIPAY}/gateway.do`, app_id: '2021000000000001',
    seller_id: '2088000000000001', app_private_key: pay('app-key.pem'), alipay_public_key: pay('alipay-pub.pem'),
    order_timeout_minutes: 15,
  },
});

/* ── 注册：开放、不要邮箱验证（工作量证明那条路；验证码那条路在用例里切换）、可以找回密码 ── */
const signup = await admin.call<{ version: number; trial_days: number }>('GET', '/api/v1/settings/signup');
await admin.call('PUT', '/api/v1/settings/signup', {
  version: signup.version, register_enabled: true, invite_required: false, invite_single_use: false,
  invite_codes_per_user: 5, email_domains: [], trial_plan_id: null, trial_days: signup.trial_days || 3,
  reset_enabled: true, email_verify: false,
});

/* ── 邀请返佣：20%，不冻结（入账立刻可提现），USDT 参考汇率 7.20 ── */
await admin.call('PUT', '/api/v1/commission-settings', {
  enabled: true, rate_percent: 20, first_order_only: false, hold_days: 0, min_withdrawal_cents: 100,
  usdt_chains: ['trc20', 'polygon', 'ton'], usdt_rate_cents: 720,
});

/* ── 线路：两个节点（一个带中转入口），一个按时段的倍率（D9：全天 0.5×，此刻就是 0.5） ── */
type NodeView = { id: string; entrances: { id: string; kind: string }[] };
async function node(name: string, region: string, port: number): Promise<NodeView> {
  const n = await admin.call<{ id: string }>('POST', '/api/v1/nodes', { name });
  await admin.call('PATCH', `/api/v1/nodes/${n.id}`, { region, display_name: name });
  await admin.call('PUT', `/api/v1/nodes/${n.id}/inbound`, {
    inbound: { listen: '127.0.0.1', port, protocol: 'vless', settings: { clients: [], decryption: 'none' }, streamSettings: { network: 'tcp' } },
  });
  return admin.call<NodeView>('GET', `/api/v1/nodes/${n.id}`);
}
const hk = await node('香港 01', '香港', 21443);
const jp = await node('日本 01', '日本', 21444);
const direct = (n: NodeView) => n.entrances.find((e) => e.kind === 'direct')?.id ?? '';
/* 用户只看见入口名与标签（节点名「香港 01」「日本 01」是运营方的，门户与订阅里都不出现） */
await admin.call('PATCH', `/api/v1/entrances/${direct(hk)}`, { name: '香港直连' });
await admin.call('PATCH', `/api/v1/entrances/${direct(jp)}`, { name: '日本直连', tags: ['原生'] });
const relay = await admin.call<{ id: string }>('POST', `/api/v1/nodes/${hk.id}/entrances`, {
  name: 'IPLC', connect_host: '127.0.0.1', connect_port: 21446, listen_port: 21446, source_cidrs: ['127.0.0.1'], rate: 2,
});
await admin.call('PUT', `/api/v1/entrances/${direct(jp)}/rate-rules`, {
  rules: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '24:00', rate: 0.5 }],
});
const group = await admin.call<{ id: string }>('POST', '/api/v1/node-groups', {
  name: 'e2e', entrance_ids: [direct(hk), direct(jp), relay.id],
});

/* ── 套餐 ── */
const plan = await admin.call<{ id: string }>('POST', '/api/v1/plans', {
  name: 'E2E 标准', period: 'monthly', traffic_quota_bytes: 100 * 1024 ** 3, speed_limit_mbps: 300, group_ids: [group.id],
  description: '- 全部节点\n- 每月重置流量',
  pricing: { on_sale: true, prices: [
    { period: 'month', days: null, price_cents: 1500 },
    { period: 'year', days: null, price_cents: 15000 },
    { period: 'reset', days: null, price_cents: 500 },
  ] },
});
const premium = await admin.call<{ id: string }>('POST', '/api/v1/plans', {
  name: 'E2E 高级', period: 'monthly', traffic_quota_bytes: 500 * 1024 ** 3, speed_limit_mbps: null, group_ids: [group.id],
  description: '更多流量', pricing: { on_sale: true, prices: [{ period: 'month', days: null, price_cents: 3000 }] },
});

/* ── 账户 ── */
type User = { id: string };
const user = (email: string, withPlan = true) => admin.call<User>('POST', '/api/v1/users', {
  email, password: PW, ...(withPlan ? { plan: { plan_id: plan.id, period: 'month' } } : {}),
});
const credit = (id: string, cents: number) => admin.call('POST', `/api/v1/users/${id}/balance`, { amount_cents: cents, reason: 'e2e' });

const main = await user('user@e2e.test');
await credit(main.id, 20000);
for (const p of PROJECTS) {
  await credit((await user(`shop-${p}@e2e.test`)).id, 20000);
  await user(`account-${p}@e2e.test`);
  await user(`delete-${p}@e2e.test`, false);
  await user(`passkey-${p}@e2e.test`, false);
  await user(`reset-${p}@e2e.test`, false);
  await user(`logout-${p}@e2e.test`, false);
}
const expired = await user('expired@e2e.test');
const quota = await user('quota@e2e.test');
const banned = await user('banned@e2e.test', false);
await admin.call('POST', `/api/v1/users/${banned.id}/ban`, { reason: 'E2E：违反服务条款' });
await user('plain@e2e.test', false);

/* 到期（D12：面板不提供改到期时间的接口）、流量用完（结算下一轮就停用） */
psql(`UPDATE user_plans SET expires_at = now() - interval '1 day' WHERE user_id = '${expired.id}' AND status = 'active';
      UPDATE users SET expires_at = now() - interval '1 day' WHERE id = '${expired.id}';
      UPDATE users SET traffic_used_bytes = traffic_limit_bytes + 1 WHERE id = '${quota.id}';`);

/* 两天的历史流量（站点时区的日），挂在已有的入口上 */
psql(`INSERT INTO traffic_daily (user_id, day, node_id, entrance_id, up_bytes, down_bytes, billed_bytes)
      SELECT '${main.id}', akari_site_day(now()) - d, '${hk.id}', '${direct(hk)}', (2 - d) * 536870912::bigint, (2 - d) * 1073741824::bigint, (2 - d) * 1610612736::bigint
      FROM generate_series(0, 1) d;`);
/* 同一节点的中转（2×）与时段倍率入口（日本，全天 0.5×）：门户按入口列出、显示此刻的倍率，不把直连与中转混成一个比值 */
psql(`INSERT INTO traffic_daily (user_id, day, node_id, entrance_id, up_bytes, down_bytes, billed_bytes) VALUES
      ('${main.id}', akari_site_day(now()), '${hk.id}', '${relay.id}', 0, 1073741824, 2147483648),
      ('${main.id}', akari_site_day(now()), '${jp.id}', '${direct(jp)}', 0, 536870912, 268435456);`);

/* ── 返佣与提现：邀请人 + 被邀请人（邀请关系只在注册时写，这里直接写库），被邀请人经支付宝付款 → 佣金入账 ── */
for (const p of PROJECTS) {
  const inviter = await user(`inviter-${p}@e2e.test`, false);
  const invitee = await user(`invitee-${p}@e2e.test`, false);
  psql(`UPDATE users SET inviter_id = '${inviter.id}' WHERE id = '${invitee.id}';`);
  const c = await Client.user(`invitee-${p}@e2e.test`, PW);
  const o = await c.call<{ id: string; out_trade_no: string }>('POST', '/api/v1/me/orders', { plan_id: premium.id, period: 'month' });
  await payAtGateway(o.out_trade_no);
  await until('the invitee\'s order paid', async () => (await c.call<{ status: string }>('GET', `/api/v1/me/orders/${o.id}`)).status === 'paid');
  const inv = await Client.user(`inviter-${p}@e2e.test`, PW);
  await until('the commission credited', async () => (await inv.call<{ withdrawable_cents: number }>('GET', '/api/v1/me/balance')).withdrawable_cents > 0);
}

/* ── 三种退款去向：原路退回、退到余额、在支付渠道后台退款后登记（P1：套餐效果同时撤销） ── */
const refundUser = await user('refund@e2e.test', false);
const rc = await Client.user('refund@e2e.test', PW);
const orders: Record<string, string> = {};
for (const [route, body] of [
  ['original', { reason: 'e2e 原路', original: true }],
  ['balance', { reason: 'e2e 余额', to_balance: true }],
  ['manual', { reason: 'e2e 登记', external_cents: 1500 }],
] as const) {
  const o = await rc.call<{ id: string; out_trade_no: string }>('POST', '/api/v1/me/orders', { plan_id: plan.id, period: 'month' });
  await payAtGateway(o.out_trade_no);
  await until('the refund test order paid', async () => (await rc.call<{ status: string }>('GET', `/api/v1/me/orders/${o.id}`)).status === 'paid');
  await admin.call('POST', `/api/v1/orders/${o.id}/refund`, body);
  orders[route] = o.out_trade_no;
}

/* ── 内容：公告；知识库（分类 + 长文章，排版用例看它） ── */
await admin.call('POST', '/api/v1/announcements', {
  title_zh: 'E2E 维护通知', title_en: 'E2E maintenance', body_zh: '今晚 **维护** 一小时。', body_en: 'One hour of **maintenance** tonight.', pinned: true,
});
const win = await admin.call<{ id: string }>('POST', '/api/v1/kb/categories', { name_zh: 'Windows 教程', name_en: 'Windows guides' });
const ios = await admin.call<{ id: string }>('POST', '/api/v1/kb/categories', { name_zh: 'iOS 与 iPadOS 教程', name_en: 'iOS and iPadOS guides' });
/* 多几个分类（名字长短不一）：分类要换行排开、不被截断 */
for (const n of ['Android 教程', 'macOS 教程', 'Linux 与路由器（OpenWrt / 梅林）', '常见问题与故障排查', '账户与付款']) {
  const c = await admin.call<{ id: string }>('POST', '/api/v1/kb/categories', { name_zh: n, name_en: null });
  await admin.call('POST', '/api/v1/kb/articles', {
    category_id: c.id, title_zh: `${n}：入门`, title_en: null, body_zh: '## 第一步\n按页面提示操作。', body_en: null, published: true,
  });
}
await admin.call('POST', '/api/v1/kb/articles', {
  category_id: win.id, title_zh: 'E2E 第一篇', title_en: 'E2E first article', published: true,
  body_zh: '## 安装\n下载客户端。\n\n## 导入订阅\n复制订阅链接后在客户端里粘贴。',
  body_en: '## Install\nDownload the client.\n\n## Import\nPaste the subscription link into the client.',
});
await admin.call('POST', '/api/v1/kb/articles', {
  category_id: ios.id, published: true, title_en: null,
  title_zh: '在 iPhone 上用 Shadowrocket 一键导入订阅并开启按规则分流（适合第一次使用的用户）',
  body_zh: [
    '这篇文章带你从零开始配置。',
    '## 准备',
    '- 一台 iOS 15 以上的设备\n- 已购买的套餐',
    '1. 打开 App Store\n2. 搜索并安装客户端',
    '### 网络要求',
    '> 安装客户端需要一个非中国大陆地区的 Apple ID。',
    '## 导入',
    '在门户的仪表盘点「导入到客户端」，或者复制下面这样的地址：',
    '```\nhttps://sub.example.com/very/long/subscription/path/that/should/scroll/horizontally/instead/of/overflowing/the/page?format=links\n```',
    '#### 手动粘贴',
    '打开客户端，点右上角 **+**，类型选 `Subscribe`，粘贴地址。',
    '## 常见问题',
    '连不上时先看 [帮助中心](/help)，再提交工单。',
  ].join('\n\n'),
});

console.log(JSON.stringify({
  password: PW, plan: 'E2E 标准', premium: 'E2E 高级', refundOrders: orders, refundUser: refundUser.id,
}));
