// Ops area pieces (dashboard, system status, alerts, updates, audit): alert
// kind names and icons, the sentence for a mail server's raw error, waiting
// times and the small "settings live elsewhere" link (v2 ops-bits.tsx).
import {
  Activity,
  Cpu,
  FileWarning,
  Gauge,
  HardDrive,
  KeyRound,
  MemoryStick,
  ServerOff,
  ShieldAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { daysBefore, siteToday } from "../../shared/format";
import { trFor, type Lang, type Tr } from "../../shared/i18n";

/** Alert kind → name (same words as the server page's alert rules). */
export function alertKindName(k: string, tr: Tr): string {
  return (
    (
      {
        offline: tr("服务器离线", "Server offline"),
        cpu: tr("CPU 过高", "High CPU"),
        memory: tr("内存过高", "High memory"),
        disk: tr("磁盘将满", "Disk filling up"),
        latency: tr("测速全部失败", "Every probe fails"),
        cert: tr("服务器证书即将到期", "Server certificate expiring"),
        agent_cert: tr("Agent 证书即将到期", "Agent certificate expiring"),
        last_error: tr("配置应用失败", "Apply failed"),
        entrance_down: tr("中转入口不可用", "Relay entrance down"),
        traffic_quota: tr("流量额度已用完", "Traffic quota used up"),
      } as Record<string, string>
    )[k] ?? k
  );
}

export const ALERT_KIND_ICON: Record<string, LucideIcon> = {
  offline: ServerOff,
  cpu: Cpu,
  memory: MemoryStick,
  disk: HardDrive,
  latency: Activity,
  cert: ShieldAlert,
  agent_cert: KeyRound,
  last_error: FileWarning,
  entrance_down: Unplug,
  traffic_quota: Gauge,
};

/** Critical kinds (the server or its traffic is down); the rest are warnings. */
export const alertSevere = (k: string) => k === "offline" || k === "entrance_down" || k === "traffic_quota";

/**
 * One sentence for a mail server's raw answer (SMTP reply code, timeouts,
 * authentication, TLS); the raw text stays available next to it.
 */
export function mailReason(raw: string | null | undefined, tr: Tr): string {
  if (!raw) return tr("发送失败", "Sending failed");
  const code = /\b([45]\d\d)\b/.exec(raw)?.[1];
  if (/auth|535|534|530/i.test(raw) && (!code || code.startsWith("53")))
    return tr("发信账号认证失败", "The mail account failed to authenticate");
  if (code?.startsWith("5")) return tr(`收件服务器拒收（${code}）`, `Rejected by the receiving server (${code})`);
  if (code?.startsWith("4")) return tr(`收件服务器暂时拒绝（${code}）`, `Temporarily refused (${code})`);
  if (/timed? ?out|timeout/i.test(raw)) return tr("连接超时", "Timed out");
  if (/tls|certificate|handshake/i.test(raw)) return tr("TLS 握手失败", "TLS handshake failed");
  if (/dns|resolve|lookup/i.test(raw)) return tr("域名解析失败", "DNS lookup failed");
  if (/refused|connect|unreachable/i.test(raw)) return tr("无法连接发信服务器", "Could not reach the mail server");
  return tr("发送失败", "Sending failed");
}

/** "2 小时 14 分" / "12 分钟" / "3 天 4 小时" since `iso` (or between two times). */
export function waitText(iso: string | null | undefined, lang: Lang, until?: string | null): string {
  if (!iso) return "—";
  const end = until ? new Date(until).getTime() : Date.now();
  const m = Math.max(0, Math.floor((end - new Date(iso).getTime()) / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  const tr = trFor(lang);
  if (d) return tr(`${d} 天 ${h} 小时`, `${d}d ${h}h`);
  if (h) return tr(`${h} 小时 ${mm} 分`, `${h}h ${mm}m`);
  return m < 1 ? tr("不到 1 分钟", "<1 min") : tr(`${mm} 分钟`, `${mm} min`);
}

/** Day header label for a site day (YYYY-MM-DD): 今天 / 昨天 / 10 月 10 日 周六. */
export function dayLabel(day: string, tr: Tr, lang: Lang): string {
  const today = siteToday();
  if (day === today) return tr("今天", "Today");
  if (day === daysBefore(today, 1)) return tr("昨天", "Yesterday");
  const d = new Date(`${day}T12:00:00Z`);
  return lang === "en"
    ? d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    : `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${WEEKDAYS[d.getUTCDay()][0]}`;
}

/** Short weekday names, Sunday first (`tr(...WEEKDAYS[d.getUTCDay()])`). */
export const WEEKDAYS: [string, string][] = [
  ["周日", "Sun"],
  ["周一", "Mon"],
  ["周二", "Tue"],
  ["周三", "Wed"],
  ["周四", "Thu"],
  ["周五", "Fri"],
  ["周六", "Sat"],
];
