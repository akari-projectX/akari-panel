/*
 * 端到端测试与真实面板打交道的小工具（seed.ts 与 *.spec.ts 共用）：
 *   · admin：用管理员身份调后台接口（和管理员在后台点出来的一样），会话 cookie 自己记；
 *   · mail：从 Mailpit 取最新一封发给某个地址的邮件（验证码、重置链接）；
 *   · psql：面板不允许直接写的状态（比如把到期时间拨到过去，D12）只能改库。
 * 环境变量由 ../scripts/e2e-portal.sh 设置。
 */
import { execFileSync } from 'node:child_process';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set (run ../scripts/e2e-portal.sh)`);
  return v;
};

/** 一个带会话 cookie 的接口客户端（管理员走后台前缀，用户走门户根路径） */
export class Client {
  private cookie = '';
  private readonly base: string;

  private constructor(base: string) {
    this.base = base;
  }

  /** 登录。公开表单要带 guard：先取表单令牌，等过最短提交时间 */
  static async login(base: string, email: string, password: string): Promise<Client> {
    const c = new Client(base);
    const o = await c.call<{ guard?: { form_token?: string; form_min_secs?: number } }>('GET', '/auth/options');
    await new Promise((r) => setTimeout(r, (o.guard?.form_min_secs ?? 0) * 1000 + 300));
    const guard = { ...(o.guard?.form_token ? { form_token: o.guard.form_token } : {}), website: '' };
    await c.call('POST', '/auth/login', { email, password, guard });
    return c;
  }

  /** 管理员（后台前缀下） */
  static admin(): Promise<Client> {
    return Client.login(env('E2E_ADMIN_BASE'), env('E2E_ADMIN_EMAIL'), env('E2E_ADMIN_PASSWORD'));
  }

  /** 门户用户（根路径；直连面板，IP 字面量过得了主域名闸门） */
  static user(email: string, password: string): Promise<Client> {
    return Client.login(env('E2E_API'), email, password);
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.getSetCookie();
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * 读-改-写一组带 version 的设置：GET 当前值，只取请求体认得的字段（PUT 拒绝未知字段），合并改动后 PUT。
   * 返回改之前的值，用例结束时原样写回。
   */
  async patch(path: string, fields: readonly string[], change: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cur = await this.call<Record<string, unknown>>('GET', `/api/v1/settings/${path}`);
    const body: Record<string, unknown> = { version: cur.version };
    for (const f of fields) if (f in cur) body[f] = cur[f];
    await this.call('PUT', `/api/v1/settings/${path}`, { ...body, ...change });
    const before: Record<string, unknown> = {};
    for (const f of fields) if (f in cur) before[f] = cur[f];
    for (const f of Object.keys(change)) before[f] = cur[f] ?? null;
    return before;
  }

  /** 按邮箱找用户 id（管理员） */
  async userId(email: string): Promise<string> {
    const r = await this.call<{ users: { id: string; email: string }[] }>('GET', `/api/v1/users?q=${encodeURIComponent(email)}`);
    const u = r.users.find((x) => x.email === email);
    if (!u) throw new Error(`no user ${email}`);
    return u.id;
  }
}

/** 模拟网关把这笔交易标成已付款（面板下一次查单时开通） */
export async function payAtGateway(outTradeNo: string): Promise<void> {
  const r = await fetch(`${env('E2E_MOCK_ALIPAY')}/control/pay?otn=${encodeURIComponent(outTradeNo)}`, { method: 'POST' });
  if (!r.ok) throw new Error(`mock gateway: ${r.status}`);
}

/** 等到 check() 为真（面板的后台循环：对账、结算、返佣入账） */
export async function until(what: string, check: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

type MailItem = { ID: string; To: { Address: string }[]; Subject: string; Created: string };

/** 发给 to 的最新一封邮件的纯文本（等最多 20 秒：面板经发件箱异步发送） */
export async function latestMail(to: string, after = 0): Promise<string> {
  const api = env('E2E_MAILPIT');
  for (let i = 0; i < 80; i++) {
    const r = (await (await fetch(`${api}/search?query=${encodeURIComponent(`to:${to}`)}&limit=5`)).json()) as { messages: MailItem[] };
    const m = (r.messages ?? []).find((x) => Date.parse(x.Created) > after);
    if (m) {
      const full = (await (await fetch(`${api}/message/${m.ID}`)).json()) as { Text: string };
      return full.Text;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`no mail to ${to}`);
}

/** 在 e2e 库上执行 SQL（只用于面板刻意不提供接口的状态） */
export function psql(sql: string): string {
  return execFileSync('sh', ['-c', `${env('E2E_PSQL')} -v ON_ERROR_STOP=1 -qtA`], { input: sql, encoding: 'utf8' }).trim();
}

/** 各设置页 PUT 认得的字段（GET 里多出来的只读字段不能原样交回） */
export const FIELDS = {
  signup: ['register_enabled', 'invite_required', 'invite_single_use', 'invite_codes_per_user', 'email_domains', 'trial_plan_id', 'trial_days', 'reset_enabled', 'email_verify'],
  auth: ['turnstile_site_key', 'turnstile_login', 'turnstile_register', 'turnstile_reset', 'honeypot', 'min_submit_secs', 'passkey_only_admins', 'passkey_only_users', 'passkey_prompt'],
  branding: ['footer_text', 'footer_links', 'tos_url', 'privacy_url', 'client_downloads'],
} as const;
