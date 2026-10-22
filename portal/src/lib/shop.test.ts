import { describe, expect, it } from 'vitest';
import type { Offer } from '@/api';
import { mmss, safeUrl, savePercent, toneClass } from './shop';

const offer = (period: Offer['period'], price: number): Offer => ({
  period, days: null, price_cents: price, amount_cents: price, discount_cents: 0, credit_cents: 0, forfeited_cents: 0,
  balance_cents: 0, coupon_refusal: null, action: 'new', refusal: null,
});

describe('savePercent', () => {
  const offers = [offer('month', 1500), offer('quarter', 4400), offer('year', 15000), offer('reset', 500)];
  it('compares the per-month list price with the monthly offer', () => {
    expect(savePercent(offers, offers[2])).toBe(17);
  });
  it('says nothing below 5 %, for the month itself, or without a monthly offer', () => {
    expect(savePercent(offers, offers[1])).toBeNull();
    expect(savePercent(offers, offers[0])).toBeNull();
    expect(savePercent(offers, offers[3])).toBeNull();
    expect(savePercent([offers[2]], offers[2])).toBeNull();
  });
});

describe('safeUrl', () => {
  it('lets ordinary and app links through', () => {
    expect(safeUrl('https://pay.example.com/submit.php?x=1')).toBe(true);
    expect(safeUrl('alipays://platformapi/startapp')).toBe(true);
  });
  it('refuses script and data links, also with whitespace or control characters in the scheme', () => {
    expect(safeUrl('javascript:alert(1)')).toBe(false);
    expect(safeUrl(' java\tscript:alert(1)')).toBe(false);
    expect(safeUrl('VBScript:x')).toBe(false);
    expect(safeUrl('data:text/html,x')).toBe(false);
  });
});

describe('mmss / toneClass', () => {
  it('formats a countdown', () => {
    expect(mmss(65_000)).toBe('01:05');
    expect(mmss(3_725_000)).toBe('1:02:05');
    expect(mmss(-5)).toBe('00:00');
  });
  it('maps order tones to status classes', () => {
    expect(toneClass('success')).toBe('st ok');
    expect(toneClass('warning')).toBe('st warn');
    expect(toneClass('neutral')).toBe('st');
  });
});
