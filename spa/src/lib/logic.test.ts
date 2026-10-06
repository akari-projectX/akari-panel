import { describe, expect, it } from 'vitest';
import type { MyTraffic, Offer, ShopPlan } from '@/api';
import { safeRedirect, scopeOf } from './auth';
import { docCategories, pick } from './doc-categories';
import { defaultPasskeyName } from './passkey-name';
import { allowed, R } from './routes';
import { needsMethod, needsSwitchConfirm, offerKey, planRefusal, preselect } from './shop';
import { enabledFormats, importLinks, mySubUrl, withFormat } from './sub-links';
import { trafficByNode, trafficDays } from './traffic';

const offer = (o: Partial<Offer>): Offer => ({
  period: 'month', days: null, price_cents: 1000, amount_cents: 1000, discount_cents: 0, credit_cents: 0,
  forfeited_cents: 0, balance_cents: 0, coupon_refusal: null, action: 'new', refusal: null, ...o,
});
const plan = (offers: Offer[], current = false): ShopPlan => ({
  plan_id: 'p', name: 'P', description: '', traffic_quota_bytes: null, period: 'monthly', speed_limit_mbps: null,
  device_seats: null, current, remaining: null, sold_out: false, offers,
});
const ok = { expired: false, quota_exhausted: false };

describe('shop preselection (中-1)', () => {
  const renew = offer({ action: 'renew' });
  const year = offer({ period: 'year', action: 'renew' });
  const reset = offer({ period: 'reset', action: 'reset' });
  it('picks the reset pack for the current plan when traffic ran out', () => {
    expect(preselect(plan([renew, reset], true), { ...ok, quota_exhausted: true })).toBe(reset);
  });
  it('picks renewal for the current plan when it expired', () => {
    expect(preselect(plan([reset, year], true), { ...ok, expired: true })).toBe(year);
  });
  it('otherwise picks the first buyable non-reset offer and never a refused one', () => {
    const refused = offer({ action: null, refusal: 'sold_out' });
    expect(preselect(plan([refused, reset, renew]), ok)).toBe(renew);
    expect(preselect(plan([refused]), ok)).toBeUndefined();
    expect(planRefusal(plan([refused]))).toBe('sold_out');
    expect(planRefusal(plan([renew]))).toBeNull();
  });
  it('keys multiple day-based offers apart', () => {
    expect(offerKey(offer({ period: 'days', days: 30 }))).not.toBe(offerKey(offer({ period: 'days', days: 90 })));
  });
  it('asks for a second confirmation when credit is forfeited or leaving a permanent plan (低-3)', () => {
    const sw = offer({ action: 'switch' });
    expect(needsSwitchConfirm(offer({ action: 'switch', forfeited_cents: 1 }), { current: { plan_id: 'a', name: 'A', expires_at: '2027-01-01T00:00:00Z' } })).toBe(true);
    expect(needsSwitchConfirm(sw, { current: { plan_id: 'a', name: 'A', expires_at: null } })).toBe(true);
    expect(needsSwitchConfirm(sw, { current: { plan_id: 'a', name: 'A', expires_at: '2027-01-01T00:00:00Z' } })).toBe(false);
    expect(needsSwitchConfirm(offer({ action: 'renew', forfeited_cents: 5 }), { current: null })).toBe(false);
  });
  it('asks for a payment method only when there is something to pay and a choice', () => {
    const m = { id: 'm', kind: 'alipay', display_name: 'A', icon: null };
    expect(needsMethod(offer({ amount_cents: 0 }), { methods: [m, m] })).toBe(false);
    expect(needsMethod(offer({}), { methods: [m] })).toBe(false);
    expect(needsMethod(offer({}), { methods: [m, m] })).toBe(true);
  });
});

describe('subscription links', () => {
  it('adds the format parameter', () => {
    expect(withFormat('https://s.example/sub/t', 'auto')).toBe('https://s.example/sub/t');
    expect(withFormat('https://s.example/sub/t', 'clash')).toBe('https://s.example/sub/t?format=clash');
    expect(withFormat('https://s.example/x?a=1', 'links')).toBe('https://s.example/x?a=1&format=links');
  });
  it('builds one-click import links in each client\'s own format, in the panel\'s order', () => {
    const links = importLinks('https://s.example/sub/t', 'Akari', ['clash', 'stash', 'shadowrocket', 'sing-box', 'hiddify']);
    expect(links.map((l) => l.id)).toEqual(['clash', 'stash', 'shadowrocket', 'sing-box', 'hiddify']);
    expect(links[0].href).toBe('clash://install-config?url=https%3A%2F%2Fs.example%2Fsub%2Ft%3Fformat%3Dclash&name=Akari');
    /* URL-safe base64 without padding: '+' '/' '=' would be read as URL syntax */
    const b64 = btoa('https://s.example/sub/t?format=links').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(links[2].href).toBe(`shadowrocket://add/sub://${b64}?remark=Akari`);
    expect(b64).not.toMatch(/[+/=]/);
  });
  it('shows only the clients and formats the panel has on', () => {
    expect(importLinks('https://s.example/x', 'A', ['hiddify', 'nope']).map((l) => l.id)).toEqual(['hiddify']);
    expect(importLinks('https://s.example/x', 'A', [])).toEqual([]);
    expect(enabledFormats({ sub_formats: ['links'] })).toEqual(['auto', 'links']);
    expect(enabledFormats({ sub_formats: ['clash', 'sing-box', 'links'] })).toEqual(['auto', 'clash', 'sing-box', 'links']);
  });
  it('uses the panel\'s sub_url only (random path), absolute on this origin when relative', () => {
    expect(mySubUrl({ sub_url: 'https://sub.example/r4nd/t' })).toBe('https://sub.example/r4nd/t');
    expect(mySubUrl({ sub_url: '/r4nd/t' }, 'https://p.example')).toBe('https://p.example/r4nd/t');
    expect(mySubUrl({ sub_url: null })).toBeNull();
    expect(mySubUrl(undefined)).toBeNull();
  });
});


describe('account scopes and routes', () => {
  const me = { role: 'user' as const, banned: false, expired: false, quota_exhausted: false };
  it('derives the scope like the panel guards', () => {
    expect(scopeOf(me)).toBe('full');
    expect(scopeOf({ ...me, expired: true })).toBe('renewal');
    expect(scopeOf({ ...me, quota_exhausted: true, banned: true })).toBe('banned');
  });
  it('opens pages per scope', () => {
    expect(allowed(R.nodes, 'renewal')).toBe(false);
    expect(allowed(R.shop, 'renewal')).toBe(true);
    expect(allowed(R.tickets, 'banned')).toBe(true);
    expect(allowed(R.wallet, 'banned')).toBe(false);
    expect(allowed(R.dashboard, 'banned')).toBe(true);
  });
  it('only redirects inside the portal', () => {
    expect(safeRedirect('/orders/1')).toBe('/orders/1');
    expect(safeRedirect('//evil.example')).toBe('/');
    expect(safeRedirect('https://evil.example')).toBe('/');
    expect(safeRedirect(null)).toBe('/');
  });
});

describe('traffic and knowledge base shaping', () => {
  const t: MyTraffic = {
    from: '2026-10-01', to: '2026-10-03', timezone: 'Asia/Shanghai', daily_since: null,
    total: { up_bytes: 0, down_bytes: 0, billed_bytes: 0 },
    days: [{ day: '2026-10-02', up_bytes: 1024 ** 3, down_bytes: 2 * 1024 ** 3, billed_bytes: 1.5 * 1024 ** 3 }],
    nodes: [
      { name: 'HK', up_bytes: 1024 ** 3, down_bytes: 1024 ** 3, billed_bytes: 1024 ** 3 },
      { name: null, up_bytes: 0, down_bytes: 1024 ** 3, billed_bytes: 1024 ** 3 },
    ],
  };
  it('fills every day of the range', () => {
    expect(trafficDays(t).map((d) => [d.day, d.down])).toEqual([['2026-10-01', 0], ['2026-10-02', 2], ['2026-10-03', 0]]);
  });
  it('sums per line with an effective multiplier', () => {
    expect(trafficByNode(t, 'other')).toEqual([
      { name: 'HK', value: 2, billed: 1, rate: 0.5 },
      { name: 'other', value: 1, billed: 1, rate: 1 },
    ]);
  });
  it('picks the UI language with a Chinese fallback', () => {
    expect(pick('en', '中', 'en')).toBe('en');
    expect(pick('en', '中', '')).toBe('中');
    expect(pick('zh-CN', '中', 'en')).toBe('中');
    const cats = docCategories({
      total: 2,
      categories: [{ id: 'c', name_zh: '安卓', name_en: 'Android', articles: [{ id: 'a', category_id: 'c', title_zh: '甲', title_en: null, updated_at: '' }] }],
      uncategorized: [{ id: 'b', category_id: null, title_zh: '乙', title_en: 'B', updated_at: '' }],
    }, 'en', 'Other', { mineFirst: false });
    expect(cats.map((c) => [c.name, c.articles.map((a) => a.title)])).toEqual([['Android', ['甲']], ['Other', ['B']]]);
    expect(cats[0].platform?.id).toBe('android');
  });
});

describe('passkey names', () => {
  it('names a new passkey after the device', () => {
    expect(defaultPasskeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17.0 Mobile Safari/604.1')).toBe('iPhone · Safari');
    expect(defaultPasskeyName('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Windows · Edge');
    expect(defaultPasskeyName('')).toBe('Passkey');
  });
});
