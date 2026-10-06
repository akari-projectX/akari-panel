import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_ZONE, addDays, daysLeft, fillDays, formatBytes, formatDate, formatDateTime, formatMoney, formatMonthDay,
  formatRate, formatTime, fromNow, monthStart, orderState, parseYuan, periodText, resetPeriodText, setSiteTimeZone,
  signedMoney, siteToday, trafficUsage, yuan,
} from './format';

const tr = (s: string) => s;
const tp = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k]));

afterEach(() => setSiteTimeZone(DEFAULT_TIME_ZONE));

describe('money (integer cents, never floats)', () => {
  it('formats cents as yuan without float rounding', () => {
    expect(yuan(990)).toBe('9.90');
    expect(yuan(3200)).toBe('32');
    expect(yuan(3200, { always2: true })).toBe('32.00');
    expect(yuan(1)).toBe('0.01');
    expect(yuan(10)).toBe('0.10');
    /* 0.1 + 0.2 style sums stay exact */
    expect(yuan(10 + 20)).toBe('0.30');
  });

  it('keeps negative balances (commission clawback) negative', () => {
    expect(formatMoney(-1050)).toBe('−¥10.50');
    expect(formatMoney(0)).toBe('¥0');
    expect(formatMoney(null)).toBe('¥0');
    expect(signedMoney(500)).toBe('+¥5');
    expect(signedMoney(-500)).toBe('−¥5');
  });

  it('parses a typed yuan amount as text', () => {
    expect(parseYuan('9.9')).toBe(990);
    expect(parseYuan('9.90')).toBe(990);
    expect(parseYuan(' 10 ')).toBe(1000);
    expect(parseYuan('0.01')).toBe(1);
    expect(parseYuan('0.1')).toBe(10);
    expect(parseYuan('0')).toBeNull();
    expect(parseYuan('1.234')).toBeNull();
    expect(parseYuan('-1')).toBeNull();
    expect(parseYuan('1e3')).toBeNull();
    expect(parseYuan('')).toBeNull();
  });
});

describe('time in the site time zone', () => {
  it('formats RFC 3339 instants in Asia/Shanghai by default', () => {
    /* 2026-10-31 17:30 UTC = 2026-11-01 01:30 in Shanghai: the site day, not the browser's */
    expect(formatDate('2026-10-31T17:30:00Z')).toBe('2026-11-01');
    expect(formatDateTime('2026-10-31T17:30:00Z')).toBe('2026-11-01 01:30');
    expect(formatDate('2026-11-01T00:00:00+08:00')).toBe('2026-11-01');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });

  it('follows the panel time zone when it is set', () => {
    setSiteTimeZone('UTC');
    expect(formatDate('2026-10-31T17:30:00Z')).toBe('2026-10-31');
    setSiteTimeZone('Not/AZone');
    expect(formatDate('2026-10-31T17:30:00Z')).toBe('2026-10-31');
  });

  it('shows the date only when not today', () => {
    const now = new Date('2026-10-06T04:00:00Z');
    expect(formatTime('2026-10-06T06:05:00Z', now)).toBe('14:05');
    expect(formatTime('2026-10-04T06:05:00Z', now)).toBe('10-04 14:05');
  });

  it('computes site days, month start and day arithmetic', () => {
    const now = new Date('2026-10-31T17:30:00Z');
    expect(siteToday(now)).toBe('2026-11-01');
    expect(monthStart(now)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(formatMonthDay('2026-03-09')).toBe('03-09');
  });

  it('fills missing days with zeros', () => {
    const rows = fillDays([{ day: '2026-10-02', n: 5 }], '2026-10-01', '2026-10-03', { n: 0 });
    expect(rows).toEqual([{ day: '2026-10-01', n: 0 }, { day: '2026-10-02', n: 5 }, { day: '2026-10-03', n: 0 }]);
  });

  it('counts days left and relative times', () => {
    const now = Date.parse('2026-10-06T00:00:00Z');
    expect(daysLeft(null, now)).toBeNull();
    expect(daysLeft('2026-10-05T00:00:00Z', now)).toBe(0);
    expect(daysLeft('2026-10-07T12:00:00Z', now)).toBe(2);
    expect(fromNow('2026-10-05T23:59:30Z', tp, now)).toBe('刚刚');
    expect(fromNow('2026-10-05T21:00:00Z', tp, now)).toBe('3 小时前');
  });
});

describe('traffic and labels', () => {
  it('treats a null limit as unlimited, not zero', () => {
    const u = trafficUsage(5 * 1024 ** 3, null);
    expect(u.unlimited).toBe(true);
    expect(u.usedPct).toBe(0);
    const v = trafficUsage(25 * 1024 ** 3, 100 * 1024 ** 3);
    expect(v.left).toBeCloseTo(75);
    expect(v.usedPct).toBeCloseTo(25);
  });

  it('formats bytes and rates', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(100 * 1024 ** 3)).toBe('100 GB');
    expect(formatRate(0.25)).toBe('0.25');
    expect(formatRate(1)).toBe('1');
  });

  it('names periods and reset cycles', () => {
    expect(periodText('days', 45, tr, tp)).toBe('45 天');
    expect(periodText('onetime', null, tr, tp)).toBe('一次性（永久）');
    expect(periodText('onetime', 30, tr, tp)).toBe('一次性（30 天）');
    expect(resetPeriodText('days-30', tr, tp)).toBe('每 30 天重置流量');
    expect(resetPeriodText('none', tr, tp)).toBe('流量不重置');
  });

  it('shows refunds and unfulfilled payments before the raw status', () => {
    expect(orderState({ status: 'paid', refunded_at: '2026-10-01T00:00:00Z', fulfilled: true }).text).toBe('已退款');
    expect(orderState({ status: 'paid', refunded_at: null, fulfilled: false }).text).toBe('未开通');
    expect(orderState({ status: 'paid', refunded_at: null, fulfilled: true }).text).toBe('已付款');
    expect(orderState({ status: 'expired', refunded_at: null, fulfilled: false }).text).toBe('已超时');
  });
});
