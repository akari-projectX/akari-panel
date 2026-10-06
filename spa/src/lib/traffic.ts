// W22: traffic history (mirror of src/trafficlog.rs). Days are calendar
// days "YYYY-MM-DD" in the site time zone (Q3, W28-a: the response's
// `timezone`; default Asia/Shanghai, the console's zone); rows exist only
// for days with traffic.
import { TIME_ZONE } from "./datetime";

export interface TrafficBytes {
  up_bytes: number;
  down_bytes: number;
  billed_bytes: number;
}

export interface TrafficDay extends TrafficBytes {
  day: string;
}

export interface TrafficNodeDay extends TrafficDay {
  /** Distinct users with traffic on the node that day (fleet: user-node pairs). */
  users: number;
}

/** GET /me/traffic: per day and per node name (null = hidden or deleted nodes, merged). */
export interface MyTraffic {
  from: string;
  to: string;
  timezone: string;
  daily_since: string | null;
  total: TrafficBytes;
  days: TrafficDay[];
  nodes: (TrafficBytes & { name: string | null })[];
}

/** GET /users/{id}/traffic (admin). */
export interface UserTrafficView {
  from: string;
  to: string;
  timezone: string;
  group: "day" | "node" | "month";
  daily_since: string | null;
  total: TrafficBytes;
  rows: (TrafficBytes & { day?: string; node_id?: string; name?: string | null })[];
}

/** GET /nodes/{id}/traffic (admin). */
export interface NodeTrafficView {
  from: string;
  to: string;
  timezone: string;
  daily_since: string | null;
  total: TrafficBytes;
  days: TrafficNodeDay[];
  top_users: (TrafficBytes & { user_id: string; email: string | null })[];
}

/** GET /traffic/summary (admin): fleet per day + top nodes. */
export interface TrafficSummaryView {
  from: string;
  to: string;
  timezone: string;
  total: TrafficBytes;
  days: TrafficNodeDay[];
  top_nodes: (TrafficBytes & { node_id: string; name: string | null })[];
}

const DAY_MS = 86_400_000;

function parseDay(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fmtDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today in the (default) site time zone. */
export function siteToday(now: Date = new Date()): string {
  return DAY_FORMAT.format(now);
}

/** The query string for the last `days` site days (today included). */
export function lastDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = siteToday(now);
  return { from: fmtDay(parseDay(to) - (days - 1) * DAY_MS), to };
}

/** Every day of [from, to] (at most 400), with the rows' bytes or zeros. */
export function fillDays<T extends TrafficDay>(rows: T[], from: string, to: string): TrafficDay[] {
  const by = new Map(rows.map((r) => [r.day, r]));
  const out: TrafficDay[] = [];
  const end = parseDay(to);
  for (let t = parseDay(from), i = 0; t <= end && i < 400; t += DAY_MS, i += 1) {
    const day = fmtDay(t);
    const r = by.get(day);
    out.push({
      day,
      up_bytes: r?.up_bytes ?? 0,
      down_bytes: r?.down_bytes ?? 0,
      billed_bytes: r?.billed_bytes ?? 0,
    });
  }
  return out;
}
