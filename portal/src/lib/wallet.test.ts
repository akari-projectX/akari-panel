import { describe, expect, it, vi } from 'vitest';
import type { InviteCodes, MyInvite } from '@/api';
import { chainName, inviteLink, shorten, spent, terms, usdtEstimate } from './wallet';

const t = (s: string) => s;
const tp = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k]));

describe('wallet helpers', () => {
  it('estimates USDT only with a reference rate', () => {
    expect(usdtEstimate(100, 720)).toBe('0.14');
    expect(usdtEstimate(100, null)).toBeNull();
    expect(usdtEstimate(100, 0)).toBeNull();
  });

  it('names known networks and passes unknown ones through', () => {
    expect(chainName('trc20')).toBe('TRC20 (Tron)');
    expect(chainName('ton')).toBe('TON');
    expect(chainName('newnet')).toBe('newnet');
  });

  it('shortens long addresses in the middle', () => {
    expect(shorten('a'.repeat(64))).toBe('aaaaaaaa…aaaaaaaa');
    expect(shorten('short')).toBe('short');
  });

  it('builds the invite link from the panel\'s base, else the portal\'s register page', () => {
    expect(inviteLink('AB C', 'https://x.test/register?invite=')).toBe('https://x.test/register?invite=AB%20C');
    vi.stubGlobal('location', { origin: 'https://portal.test' });
    expect(inviteLink('ABC', null)).toBe('https://portal.test/register?invite=ABC');
    vi.unstubAllGlobals();
  });

  it('a single-use code is spent once it was used', () => {
    const c = (single_use: boolean, uses: number) => ({ single_use, code: { code: 'X', uses, created_at: '' } }) as InviteCodes;
    expect(spent(c(true, 1))).toBe(true);
    expect(spent(c(true, 0))).toBe(false);
    expect(spent(c(false, 3))).toBe(false);
  });

  it('writes the commission terms on one line', () => {
    const i = { enabled: true, rate_percent: 20, first_order_only: false, hold_days: 7 } as MyInvite;
    expect(terms(i, t, tp)).toBe('返佣 20% · 被邀请人的每一笔订单都返 · 冻结 7 天后入账');
    expect(terms({ ...i, first_order_only: true }, t, tp)).toContain('只返被邀请人的首单');
    expect(terms({ ...i, enabled: false }, t, tp)).toBe('站点暂未开启邀请返佣。');
  });
});
