// D9 time-window multipliers (mirror of src/rates.rs for display: the SQL
// function akari_entrance_rate stays the only definition used for billing).
// Minutes of the day; an end at or before the start crosses midnight.
const DAY = 1440;
const WEEK = 7 * DAY;

export type Rule = { weekdays: number[]; start: number; end: number; rate: number };

/**
 * A multiplier typed by the admin: 0–100 with at most 3 decimals, or null.
 * Empty (or blank) is null — never 0x (`Number("")` is 0); saving 0x needs
 * an explicit 0 and a confirmation.
 */
export function parseRate(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const rate = Number(t);
  return rate >= 0 && rate <= 100 ? rate : null;
}

export function segments(r: Rule): [number, number][] {
  const len = r.end > r.start ? r.end - r.start : DAY - r.start + r.end;
  const out: [number, number][] = [];
  for (const d of r.weekdays) {
    const a = (d - 1) * DAY + r.start;
    const b = a + len;
    if (b <= WEEK) out.push([a, b]);
    else out.push([a, WEEK], [0, b - WEEK]);
  }
  return out;
}

/** Pairs of rules (indexes) that overlap and the first shared minute of the week. */
export function overlaps(rules: Rule[]): { a: number; b: number; at: number; rate: number }[] {
  const out: { a: number; b: number; at: number; rate: number }[] = [];
  rules.forEach((ra, i) =>
    rules.forEach((rb, j) => {
      if (j <= i) return;
      let best: number | null = null;
      for (const [a0, a1] of segments(ra))
        for (const [b0, b1] of segments(rb)) {
          const lo = Math.max(a0, b0);
          if (lo < Math.min(a1, b1) && (best === null || lo < best)) best = lo;
        }
      if (best !== null) out.push({ a: i, b: j, at: best, rate: Math.max(ra.rate, rb.rate) });
    }),
  );
  return out;
}

/** The multiplier at minute `m` of the week (0 = Monday 00:00). */
export function rateAt(base: number, rules: Rule[], m: number): number {
  let hit: number | null = null;
  for (const r of rules)
    for (const [a, b] of segments(r)) if (m >= a && m < b) hit = hit === null ? r.rate : Math.max(hit, r.rate);
  return hit ?? base;
}

/** 7 × 24 grid of the highest multiplier in each hour. */
export function heatmap(base: number, rules: Rule[]): number[][] {
  return Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => {
      let max = -1;
      for (let m = 0; m < 60; m += 5) max = Math.max(max, rateAt(base, rules, d * DAY + h * 60 + m));
      return max;
    }),
  );
}

export function hhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "HH:MM" → minutes ("24:00" = 1440); null when invalid. */
export function parseHhmm(s: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && v <= DAY ? v : null;
}
