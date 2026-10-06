/**
 * 面板单位到界面文案的换算，集中在这里：
 *   · 金额是整数**分**，用整数运算换成元，不经过浮点（0.1 + 0.2 的问题不会出现）；可以为负；
 *   · 时间是 RFC 3339 字符串，一律按**全站时区**显示（面板的日界、月重置、自然月周期都按它算），
 *     不按浏览器所在时区——用户在国外打开，看到的到期日也和面板、邮件里写的是同一天；
 *   · 流量是字节。
 */

import type { OfferAction, OrderStatus, PeriodKind, ResetPeriod } from '@/api';

/* ───────────── 金额 ───────────── */

/** 990 → "9.90"；整数元不补小数（3200 → "32"）。负数带 U+2212 */
export function yuan(cents: number, { always2 = false } = {}): string {
  const c = Math.trunc(cents);
  const abs = Math.abs(c);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  const body = frac === 0 && !always2 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
  return c < 0 ? `−${body}` : body;
}

/** "¥9.90" / "−¥10"（余额被佣金追回后可以是负数，不能截成 0） */
export function formatMoney(cents: number | null | undefined, { always2 = false } = {}): string {
  const c = Math.trunc(cents ?? 0);
  return `${c < 0 ? '−' : ''}¥${yuan(Math.abs(c), { always2 })}`;
}

/** 流水的变动额："+¥50" / "−¥10" */
export function signedMoney(cents: number): string {
  return `${cents < 0 ? '−' : '+'}¥${yuan(Math.abs(cents))}`;
}

/** 用户唯一需要手输的金额（提现）："9.9" / "9.90" / "10" → 990；不合法或不大于 0 时为 null。服务端还会再校验 */
export function parseYuan(s: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

/* ───────────── 流量 ───────────── */

const GIB = 1024 ** 3;

/** 字节 → GB 数值（不带单位） */
export function toGB(bytes: number | null | undefined): number {
  return (bytes ?? 0) / GIB;
}

/** 字节 → "12.3 GB" / "512 MB" / "0 B" */
export function formatBytes(bytes: number | null | undefined): string {
  const b = Math.max(0, bytes ?? 0);
  if (b >= GIB) return `${+(b / GIB).toFixed(b >= 100 * GIB ? 0 : 1)} GB`;
  if (b >= 1024 ** 2) return `${+(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${+(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

/**
 * 账户的流量用量。limit 为 null 是**不限流量**（套餐没有额度）；没有套餐时调用方自己判断。
 * used 是计费后的已用量（面板 traffic_used_bytes）。
 */
export function trafficUsage(used: number | null | undefined, limit: number | null | undefined) {
  const u = toGB(used);
  const unlimited = limit === null || limit === undefined;
  const total = unlimited ? 0 : toGB(limit);
  const left = unlimited ? 0 : Math.max(0, total - u);
  return {
    used: u, total, left, unlimited,
    usedPct: !unlimited && total > 0 ? Math.min(100, (u / total) * 100) : 0,
    leftPct: !unlimited && total > 0 ? Math.min(100, (left / total) * 100) : 0,
  };
}

/** 倍率显示：0.25 → "0.25"，1 → "1"（不四舍五入成 0.3） */
export function formatRate(rate: number): string {
  return String(+rate.toFixed(3));
}

/* ───────────── 时间（全站时区） ───────────── */

/** 面板的默认时区；接口给了就换成接口的（/me、/auth/options、/me/traffic） */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
let zone = DEFAULT_TIME_ZONE;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** 换全站时区（无效的 IANA 名字忽略） */
export function setSiteTimeZone(tz: string | null | undefined) {
  if (!tz || tz === zone) return;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    zone = tz;
  } catch { /* 不认识的时区名：保留原来的 */ }
}

export function siteTimeZone(): string {
  return zone;
}

type Parts = { year: string; month: string; day: string; hour: string; minute: string; weekday: string };

function parts(d: Date): Parts {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    formatters.set(zone, f);
  }
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(d)) out[p.type] = p.value;
  return out as Parts;
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2026-09-11" */
export function formatDate(v: string | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '—';
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-09-11 14:22" */
export function formatDateTime(v: string | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '—';
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "14:22"；不是今天的再带上日期（"09-12 14:22"） */
export function formatTime(v: string | Date | null | undefined, now: Date = new Date()): string {
  const d = toDate(v);
  if (!d) return '—';
  const p = parts(d);
  const today = parts(now);
  const hm = `${p.hour}:${p.minute}`;
  return p.year === today.year && p.month === today.month && p.day === today.day ? hm : `${p.month}-${p.day} ${hm}`;
}

/** 日历日 "2026-09-11" 或时间戳 → "09-11"（图表横轴） */
export function formatMonthDay(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.slice(5);
  const d = toDate(v);
  if (!d) return '—';
  const p = parts(d);
  return `${p.month}-${p.day}`;
}

/** 全站时区里这一时刻是星期几的简写（英文，供 Intl 本地化之外的场合；页面一般自己用 Intl） */
export function siteParts(v: string | Date): { year: number; month: number; day: number } {
  const p = parts(toDate(v) ?? new Date(0));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/** 今天（全站时区）的日历日 */
export function siteToday(now: Date = new Date()): string {
  return formatDate(now);
}

const DAY_MS = 86_400_000;
const parseDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** 日历日加减天数 */
export function addDays(day: string, n: number): string {
  return fmtDay(parseDay(day) + n * DAY_MS);
}

/** 本月 1 日（全站时区） */
export function monthStart(now: Date = new Date()): string {
  return `${siteToday(now).slice(0, 8)}01`;
}

/** [from, to] 的每一天，没有记录的补 0（最多 400 天） */
export function fillDays<T extends { day: string }>(rows: T[], from: string, to: string, zero: Omit<T, 'day'>): T[] {
  const by = new Map(rows.map((r) => [r.day, r]));
  const out: T[] = [];
  const end = parseDay(to);
  for (let t = parseDay(from), i = 0; t <= end && i < 400; t += DAY_MS, i++) {
    const day = fmtDay(t);
    out.push(by.get(day) ?? ({ ...zero, day } as T));
  }
  return out;
}

/** 距今多久。数字要和量词一起翻译，所以把 tp 传进来 */
type Tp = (s: string, vars: Record<string, string | number>) => string;

export function fromNow(v: string | null | undefined, tp: Tp, now = Date.now()): string {
  const d = toDate(v);
  if (!d) return '—';
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return tp('刚刚', {});
  if (diff < 3600) return tp('{n} 分钟前', { n: Math.floor(diff / 60) });
  if (diff < 86400) return tp('{n} 小时前', { n: Math.floor(diff / 3600) });
  if (diff < 86400 * 30) return tp('{n} 天前', { n: Math.floor(diff / 86400) });
  return formatDate(d);
}

/** 到期还剩几天；null（不过期）返回 null，已过期返回 0 */
export function daysLeft(v: string | null | undefined, now = Date.now()): number | null {
  const d = toDate(v);
  if (!d) return null;
  const diff = d.getTime() - now;
  return diff <= 0 ? 0 : Math.ceil(diff / DAY_MS);
}

/* ───────────── 套餐、订单的名字 ───────────── */

type Tr = (s: string) => string;

/** 购买周期的名字（简体原文，调用方过 t）；days 档带天数 */
export function periodText(kind: PeriodKind, days: number | null, tr: Tr, tp: Tp): string {
  switch (kind) {
    case 'month': return tr('月付');
    case 'quarter': return tr('季付');
    case 'half_year': return tr('半年付');
    case 'year': return tr('年付');
    case 'two_year': return tr('两年付');
    case 'three_year': return tr('三年付');
    case 'days': return tp('{n} 天', { n: days ?? '?' });
    case 'onetime': return days != null ? tp('一次性（{n} 天）', { n: days }) : tr('一次性（永久）');
    case 'reset': return tr('流量重置包');
  }
}

/** 一个周期折合多少个月，用于算「每月 ¥x」；没有固定月数的为 undefined */
export const PERIOD_MONTHS: Partial<Record<PeriodKind, number>> = {
  month: 1, quarter: 3, half_year: 6, year: 12, two_year: 24, three_year: 36,
};

/** 流量重置周期 "monthly" / "days-N" / "none" */
export function resetPeriodText(p: ResetPeriod, tr: Tr, tp: Tp): string {
  if (p === 'monthly') return tr('每月重置流量');
  const m = /^days-(\d+)$/.exec(p);
  if (m) return tp('每 {n} 天重置流量', { n: m[1] });
  return tr('流量不重置');
}

export const ORDER_STATUS: Record<OrderStatus, string> = {
  pending: '待支付',
  paid: '已付款',
  expired: '已超时',
  cancelled: '已取消',
};

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const ORDER_TONE: Record<OrderStatus, StatusTone> = {
  pending: 'warning',
  paid: 'success',
  expired: 'neutral',
  cancelled: 'neutral',
};

export const ORDER_ACTION: Record<OfferAction, string> = {
  new: '新购',
  renew: '续费',
  switch: '更换套餐',
  reset: '流量重置',
};

/** 订单在用户眼里的状态：已退款、已付款但没能开通（中-2：款项自动退到余额）优先于 status */
export function orderState(o: { status: OrderStatus; refunded_at: string | null; fulfilled: boolean }): {
  text: string; tone: StatusTone;
} {
  if (o.refunded_at) return { text: '已退款', tone: 'neutral' };
  if (o.status === 'paid' && !o.fulfilled) return { text: '未开通', tone: 'warning' };
  return { text: ORDER_STATUS[o.status], tone: ORDER_TONE[o.status] };
}

/** 速率限制：Mbps，null 表示不限速 */
export function formatSpeed(mbps: number | null | undefined): string {
  return mbps ? `${mbps} Mbps` : '不限速';
}
