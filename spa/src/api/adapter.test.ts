import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, authApi, inviteApi, meApi, onSessionEvent, orderApi, passkeyApi, shopApi, ticketApi, walletApi } from './index';
import { buildGuard, guardWait, rememberGuard } from './guard';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let replies: (() => Response)[] = [];

const json = (status: number, body: unknown) => () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return next();
  }));
});
afterEach(() => vi.unstubAllGlobals());

const body = (i = 0) => JSON.parse(String(calls[i].init.body));

describe('request layer', () => {
  it('sends the session cookie, never a bearer token', async () => {
    replies.push(json(200, { id: 'u1' }));
    await meApi.get();
    expect(calls[0].url).toBe('/api/v1/me');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBeNull();
  });

  it('posts JSON to /auth (not under /api/v1)', async () => {
    replies.push(json(200, { id: 'u1', email: 'a@b.c', role: 'user', expired: false, quota_exhausted: false }));
    await authApi.login('a@b.c', 'pw', { website: '' });
    expect(calls[0].url).toBe('/auth/login');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(body()).toEqual({ email: 'a@b.c', password: 'pw', guard: { website: '' } });
  });

  it('turns a coded error body into an ApiError', async () => {
    replies.push(json(409, { error: 'another order', code: 'order.in_progress', params: { n: 1 } }));
    const err = await orderApi.create({ plan_id: 'p', period: 'month' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('order.in_progress');
    expect(err.params).toEqual({ n: 1 });
  });

  it('handles the uniform empty 404 and 204 answers', async () => {
    replies.push(() => new Response(null, { status: 404 }), () => new Response(null, { status: 204 }));
    const err = await orderApi.get('x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('');
    await expect(passkeyApi.remove('k')).resolves.toBeUndefined();
    expect(calls[1].init.method).toBe('DELETE');
  });

  it('broadcasts a session that ended mid-way and a ban, but not a plain signed-out /me', async () => {
    const seen: string[] = [];
    const off = onSessionEvent((e) => seen.push(`${e.status}:${e.code}`));
    replies.push(
      json(401, { error: 'unauthorized', code: 'auth.unauthorized' }),
      json(401, { error: 'unauthorized', code: 'auth.unauthorized' }),
      json(401, { error: 'unauthorized' }),
      json(403, { error: 'banned', code: 'account.banned' }),
    );
    await meApi.get().catch(() => undefined);
    await authApi.login('a', 'b', { website: '' }).catch(() => undefined);
    await orderApi.list().catch(() => undefined);
    await shopApi.get().catch(() => undefined);
    off();
    expect(seen).toEqual(['401:', '403:account.banned']);
  });
});

describe('endpoints', () => {
  it('prices the shop server-side with coupon and balance', async () => {
    replies.push(json(200, {}), json(200, {}));
    await shopApi.get();
    await shopApi.get({ coupon: 'SPRING', useBalance: true });
    expect(calls[0].url).toBe('/api/v1/me/shop');
    expect(calls[1].url).toBe('/api/v1/me/shop?coupon=SPRING&use_balance=true');
  });

  it('creates an order in one call without any amount', async () => {
    replies.push(json(200, { id: 'o1' }));
    await orderApi.create({ plan_id: 'p1', period: 'days', coupon: 'X', use_balance: true, method_id: 'm1' });
    expect(calls[0].url).toBe('/api/v1/me/orders');
    expect(body()).toEqual({ plan_id: 'p1', period: 'days', coupon: 'X', use_balance: true, method_id: 'm1' });
    expect(JSON.stringify(body())).not.toMatch(/amount/);
  });

  it('maps wallet, invite, ticket and traffic paths', async () => {
    for (let i = 0; i < 8; i++) replies.push(json(200, {}));
    await walletApi.balance({ before: 42, limit: 30 });
    await walletApi.withdraw(990, 'alipay', 'acc');
    await walletApi.cancelWithdrawal('w1');
    await inviteApi.deleteCode('A B');
    await ticketApi.reply('t1', 'hi');
    await meApi.traffic('2026-10-01', '2026-10-06');
    await meApi.emailCode('n@x.y', 'pw');
    await passkeyApi.setPasswordLogin(false);
    expect(calls.map((c) => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /api/v1/me/balance?before=42&limit=30',
      'POST /api/v1/me/withdrawals',
      'POST /api/v1/me/withdrawals/w1/cancel',
      'DELETE /api/v1/me/invite-codes/A%20B',
      'POST /api/v1/me/tickets/t1/replies',
      'GET /api/v1/me/traffic?from=2026-10-01&to=2026-10-06',
      'POST /api/v1/me/email/code',
      'PUT /api/v1/me/password-login',
    ]);
    expect(body(1)).toEqual({ amount_cents: 990, method: 'alipay', account: 'acc' });
    expect(body(7)).toEqual({ enabled: false });
  });
});

describe('form guard', () => {
  it('remembers the form token from /auth/options and waits the minimum submit time', async () => {
    vi.useFakeTimers();
    try {
      replies.push(json(200, { guard: { form_token: 'tok', form_min_secs: 3, honeypot: true, turnstile: null } }));
      await authApi.options();
      expect(guardWait()).toBeGreaterThan(3000);
      let done = false;
      const p = buildGuard('', 'ts-token').then((g) => { done = true; return g; });
      await vi.advanceTimersByTimeAsync(2000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(p).resolves.toEqual({ form_token: 'tok', website: '', turnstile: 'ts-token' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait when the minimum submit time is off', async () => {
    rememberGuard({ guard: { form_token: null, form_min_secs: 0, honeypot: false, turnstile: null } });
    expect(guardWait()).toBe(0);
    await expect(buildGuard('bot-filled')).resolves.toEqual({ website: 'bot-filled' });
  });
});
