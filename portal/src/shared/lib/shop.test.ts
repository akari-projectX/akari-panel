import { describe, expect, it } from 'vitest';
import type { Offer } from '@/api';
import { needsSwitchConfirm } from './shop';

const offer = (over: Partial<Offer>): Offer => ({
  period: 'month', days: null, price_cents: 1500, amount_cents: 1500, discount_cents: 0, credit_cents: 0, forfeited_cents: 0,
  balance_cents: 0, coupon_refusal: null, action: 'switch', refusal: null,
  forfeits_permanent: false, payable: true, balance_only: false, ...over,
});

describe('needsSwitchConfirm', () => {
  it('asks for a switch that forfeits credit or a permanent plan, nothing else', () => {
    expect(needsSwitchConfirm(offer({}))).toBe(false);
    expect(needsSwitchConfirm(offer({ forfeited_cents: 1 }))).toBe(true);
    expect(needsSwitchConfirm(offer({ forfeits_permanent: true }))).toBe(true);
    expect(needsSwitchConfirm(offer({ forfeits_permanent: true, action: 'renew' }))).toBe(false);
  });
});
