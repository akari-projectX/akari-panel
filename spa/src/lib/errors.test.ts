import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api';
import { CODE_KEYS, ERRORS } from '@/i18n/errors';
import { EN } from '@/i18n/dict';
import { loadEN } from '@/i18n';
import { errorText, errorVars } from './errors';

describe('panel error codes', () => {
  it('maps every user-visible panel code (the panel registry ../src/error_codes.txt)', () => {
    const ns = ['auth', 'account', 'signup', 'shop', 'order', 'coupon', 'balance', 'withdrawal', 'invite', 'ticket', 'request'];
    const codes = readFileSync('../src/error_codes.txt', 'utf8').split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && (ns.includes(l.split('.')[0]) || l === 'kb.query_long'));
    expect(codes.length).toBeGreaterThan(80);
    expect(codes.filter((c) => !CODE_KEYS[c])).toEqual([]);
  });

  it('has an English text for every error message', () => {
    expect(Object.values(ERRORS).filter((zh) => !EN[zh])).toEqual([]);
  });

  it('fills params and adds yuan for cents', () => {
    expect(errorVars({ min_cents: 1000, field: 'x', n: null })).toEqual({ min_cents: 1000, min_yuan: '10.00', min_cents_yuan: '10.00', field: 'x' });
    const e = new ApiError(400, 'below', { code: 'withdrawal.below_minimum', params: { min_cents: 5000 } });
    expect(errorText(e, 'zh-CN')).toBe('最低提现金额为 50.00 元');
  });

  it('never shows the raw English server message', async () => {
    await loadEN();
    const e = new ApiError(400, 'some internal english text', { code: 'not.a.code' });
    expect(errorText(e, 'zh-CN')).toBe('操作失败，请稍后重试');
    expect(errorText(new ApiError(409, 'x', { code: 'order.in_progress' }), 'en')).toBe('Another order is being created. Please wait.');
    expect(errorText(new ApiError(429, 'x'), 'en')).toBe('Too many attempts. Please try again later.');
    expect(errorText(new ApiError(503, 'x'), 'zh-CN')).toBe('服务器出错了，请稍后再试');
    expect(errorText(new TypeError('Failed to fetch'), 'zh-CN')).toBe('无法连接服务器，请检查网络后重试');
  });
});
