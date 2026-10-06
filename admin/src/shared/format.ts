// Formatting. Dates are shown in the SITE time zone (Q3: the panel's
// `timezone` setting), never the browser's; set once by the console from
// GET /settings (setTimeZone).
import type { Lang } from "./i18n";

let timeZone = "Asia/Shanghai";
export function setTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    timeZone = tz;
  } catch {
    /* unknown to this browser: keep the previous one */
  }
}
export function siteTimeZone(): string {
  return timeZone;
}

const GiB = 1024 ** 3;
export { GiB };

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const neg = n < 0;
  let v = Math.abs(n);
  if (v < 1024) return `${neg ? "-" : ""}${v} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = -1;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${neg ? "-" : ""}${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function yuan(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const sign = cents < 0 ? "-" : "";
  return `${sign}¥${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** "12.34" (yuan text) → 1234 cents; null when not a valid amount. */
export function parseYuan(text: string, allowNegative = false): number | null {
  const t = text.trim();
  const re = allowNegative ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/;
  if (!re.test(t)) return null;
  const neg = t.startsWith("-");
  const [i, f = ""] = t.replace("-", "").split(".");
  const v = Number(i) * 100 + Number((f + "00").slice(0, 2));
  return neg ? -v : v;
}

export function centsToYuanText(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);
}

export function pct(a: number, b: number | null | undefined): number {
  return !b || b <= 0 ? 0 : Math.min(100, Math.round((a / b) * 100));
}

function parts(iso: string): Record<string, string> | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
}

/** "2026-10-07 14:03" in the site time zone. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const p = parts(iso);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : "—";
}

export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const p = parts(iso);
  return p ? `${p.year}-${p.month}-${p.day}` : "—";
}

/** Today's date (YYYY-MM-DD) in the site time zone. */
export function siteToday(): string {
  return dateOnly(new Date().toISOString());
}

/** YYYY-MM-DD `n` days before `day`. */
export function daysBefore(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Offset (minutes) of the site zone at `when`. */
function offsetMinutes(when: Date): number {
  const p = parts(when.toISOString());
  if (!p) return 0;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - when.getTime()) / 60000);
}

/** A `datetime-local` value (site zone) of an ISO instant. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const p = parts(iso);
  return p ? `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` : "";
}

/** The ISO instant of a `datetime-local` value read in the site zone. */
export function fromLocalInput(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = offsetMinutes(new Date(guess));
  const at = new Date(guess - off * 60000);
  const off2 = offsetMinutes(at);
  return new Date(guess - off2 * 60000).toISOString();
}

/** End of a site-zone day (YYYY-MM-DD) as an ISO instant. */
export function endOfDay(day: string): string | null {
  const start = fromLocalInput(`${day}T00:00`);
  return start ? new Date(new Date(start).getTime() + 86_400_000 - 1000).toISOString() : null;
}

export function ago(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const fmt = (n: number, zh: string, en: string) => (lang === "en" ? `${n} ${en} ago` : `${n} ${zh}前`);
  if (s < 0) return dateTime(iso);
  if (s < 60) return lang === "en" ? "just now" : "刚刚";
  if (s < 3600) return fmt(Math.floor(s / 60), "分钟", "min");
  if (s < 86400) return fmt(Math.floor(s / 3600), "小时", "h");
  return fmt(Math.floor(s / 86400), "天", "d");
}

export function duration(secs: number | null | undefined, lang: Lang): string {
  if (secs === null || secs === undefined) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (lang === "en") return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(secs % 60)}s`;
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分 ${Math.floor(secs % 60)} 秒`;
}

/** Multiplier text from permille (1000 → "1x", 1500 → "1.5x"). */
export function rateText(permille: number | null | undefined): string {
  if (permille === null || permille === undefined) return "—";
  return `${Number((permille / 1000).toFixed(3))}x`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Download text as a file (Blob URL: CSP-safe). */
export function downloadText(name: string, text: string, type = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
