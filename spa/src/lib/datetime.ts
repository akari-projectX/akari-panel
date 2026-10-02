// W21 (M7): the admin console's one date/time format — zh-CN, 24-hour, in
// Beijing time (Asia/Shanghai, UTC+8 all year), whatever the browser's
// locale or time zone. The server stores UTC; only display and the date
// inputs convert. Date inputs mean a Beijing calendar day; an expiry picked
// as a day lasts until 23:59:59 Beijing time of that day.

export const TIME_ZONE = "Asia/Shanghai";
/** Label for inputs and column headers. */
export const TZ_LABEL = "北京时间";

type Parts = { year: string; month: string; day: string; hour: string; minute: string; second: string };

const FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function parts(d: Date): Parts {
  const out: Record<string, string> = {};
  for (const p of FORMAT.formatToParts(d)) out[p.type] = p.value;
  return out as Parts;
}

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2026-10-02 14:03" (Beijing); "—" for none. `seconds` adds ":05". */
export function fmtDateTime(v: string | number | Date | null | undefined, seconds = false): string {
  const d = toDate(v);
  if (!d) return "—";
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${seconds ? `:${p.second}` : ""}`;
}

/** "2026-10-02" (Beijing); "—" for none. */
export function fmtDate(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return "—";
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "14:03" (Beijing); `seconds` adds ":05". */
export function fmtTime(v: string | number | Date | null | undefined, seconds = false): string {
  const d = toDate(v);
  if (!d) return "—";
  const p = parts(d);
  return `${p.hour}:${p.minute}${seconds ? `:${p.second}` : ""}`;
}

/** "10-02 14:03" (Beijing): compact, for chart axes and tooltips. */
export function fmtShort(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return "—";
  const p = parts(d);
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** The Beijing calendar day of a timestamp, for <input type="date"> ("" for none). */
export function dateInputValue(v: string | null | undefined): string {
  const d = toDate(v);
  return d ? fmtDate(d) : "";
}

/** RFC 3339 of 23:59:59 Beijing time on a picked "YYYY-MM-DD" (null for ""). */
export function endOfDayIso(day: string): string | null {
  if (!day) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return new Date(`${day}T23:59:59+08:00`).toISOString();
}

/** The Beijing wall time of a timestamp, for <input type="datetime-local"> ("" for none). */
export function datetimeInputValue(v: string | null | undefined): string {
  const d = toDate(v);
  if (!d) return "";
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** RFC 3339 of a datetime-local value read as Beijing time (null for ""). */
export function datetimeInputIso(v: string): string | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return null;
  return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}+08:00`).toISOString();
}

/** "3 天 4 小时" / "5 小时 12 分" / "8 分钟" of a number of seconds ("已到期" when ≤ 0). */
export function fmtDuration(secs: number | null): string {
  if (secs == null) return "—";
  if (secs <= 0) return "已到期";
  const h = Math.floor(secs / 3600);
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  if (h >= 1) return `${h} 小时 ${Math.floor((secs % 3600) / 60)} 分`;
  return `${Math.max(1, Math.floor(secs / 60))} 分钟`;
}
