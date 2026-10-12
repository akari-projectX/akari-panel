// Nodes area (v2 proposal §4): small blocks the fleet overview, the server
// page and the dialogs share — load bars, entrance kind icons, probe /
// subscription / allowlist states, the multiplier cell — and the derived
// facts they read from `GET /servers` (per-entrance panel TCP latency, the
// rate in Mbps, certificate days, the region of a server's nodes).
import { ArrowRightLeft, CircleAlert, CircleOff, Clock, EyeOff, Radio, ShieldCheck, TriangleAlert } from "lucide-react";
import { cn } from "../../shared/cn";
import { ago } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Badge, Dot } from "../../shared/ui/badge";
import { overlaps } from "../rates";
import type { EntranceView, ServerNode, ServerView } from "../types";

/** A latency result of the server (`GET /servers` `latency`, nodestat.rs). */
export type LatencyRow = {
  source: string;
  target: string;
  delay_ms: number | null;
  error: string | null;
  measured_at: string;
};

export function latencyRows(s: ServerView): LatencyRow[] {
  return Array.isArray(s.latency) ? (s.latency as LatencyRow[]) : [];
}

/** The panel's TCP test of one entrance (target "<node> / <entrance>", nodestat::target_name). */
export function entranceLatency(s: ServerView, n: ServerNode, e: EntranceView): LatencyRow | undefined {
  const target = `${n.name} / ${e.name}`;
  return latencyRows(s).find((l) => l.source === "panel" && l.target === target);
}

/** Bytes per second as a link rate ("182 Mbps", "1.24 Gbps"). */
export function mbps(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined) return "—";
  const m = (bytesPerSec * 8) / 1e6;
  if (m >= 1000) return `${(m / 1000).toFixed(2)} Gbps`;
  return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)} Mbps`;
}

/** Whole days until the agent certificate expires (null = unknown). */
export function certDays(s: ServerView): number | null {
  return s.cert_not_after ? Math.floor((Date.parse(s.cert_not_after) - Date.now()) / 86_400_000) : null;
}

/** The regions of a server's nodes ("香港", "日本 / 大阪"), or null. */
export function regionOf(s: ServerView): string | null {
  const r = [...new Set(s.nodes.map((n) => n.region?.trim()).filter(Boolean))];
  return r.length ? r.join(" / ") : null;
}

export function entranceCount(s: ServerView): number {
  return s.nodes.reduce((a, n) => a + n.entrances.length, 0);
}

export function memPct(s: ServerView): number | null {
  const hb = s.heartbeat;
  if (!hb?.mem_total_bytes || hb.mem_used_bytes == null) return null;
  return Math.round((hb.mem_used_bytes / hb.mem_total_bytes) * 100);
}

const PROTOCOLS: Record<string, string> = {
  vless: "VLESS",
  vmess: "VMess",
  trojan: "Trojan",
  shadowsocks: "SS2022",
  hysteria: "Hysteria 2",
};

export function protocolName(p: string | null | undefined, tr: Tr): string {
  return p ? (PROTOCOLS[p] ?? p) : tr("无入站", "no inbound");
}

const TRANSPORTS: Record<string, string> = {
  tcp: "TCP",
  raw: "TCP",
  ws: "WebSocket",
  grpc: "gRPC",
  xhttp: "XHTTP",
  httpupgrade: "HTTPUpgrade",
  kcp: "mKCP",
};

/** "VLESS · REALITY · TCP · :443" (protocol, security, transport, port). */
export function inboundLine(n: ServerNode, tr: Tr): string {
  if (!n.protocol) return tr("无入站", "no inbound");
  const transport = n.protocol === "hysteria" ? "QUIC" : n.transport ? (TRANSPORTS[n.transport] ?? n.transport) : "TCP";
  const security = n.security && n.security !== "none" ? n.security.toUpperCase() : null;
  return [protocolName(n.protocol, tr), security, transport, n.port ? `:${n.port}` : null].filter(Boolean).join(" · ");
}

/** A 4px load bar with its label and percent (CPU / memory); ≥75 amber, ≥90 red. */
export function MiniBar({ label, value }: { label: string; value: number | null }) {
  const tone =
    value === null
      ? ""
      : value >= 90
        ? "bg-destructive"
        : value >= 75
          ? "bg-warning"
          : "bg-[color-mix(in_srgb,var(--foreground)_42%,transparent)]";
  return (
    <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
      <span className="w-7 shrink-0">{label}</span>
      <span
        className="h-1 w-12 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]"
        aria-hidden="true"
      >
        {value !== null && (
          <span className={cn("block h-full rounded-full", tone)} style={{ width: `${Math.max(3, value)}%` }} />
        )}
      </span>
      <span className="tnum w-8 text-right font-medium text-foreground">{value === null ? "—" : `${value}%`}</span>
    </div>
  );
}

/** Direct (blue shield) or relay (orange arrows) on a tinted square. */
export function KindIcon({ kind, className }: { kind: EntranceView["kind"]; className?: string }) {
  const tr = useTr();
  const relay = kind === "relay";
  const Icon = relay ? ArrowRightLeft : ShieldCheck;
  return (
    <span
      title={relay ? tr("中转入口", "Relay entrance") : tr("直连入口", "Direct entrance")}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-[7px]",
        relay
          ? "bg-[color-mix(in_srgb,var(--chart-2)_14%,transparent)] text-chart-2"
          : "bg-[color-mix(in_srgb,var(--chart-1)_12%,transparent)] text-chart-1",
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{relay ? tr("中转入口", "Relay entrance") : tr("直连入口", "Direct entrance")}</span>
    </span>
  );
}

/** The probe column: a failing relay (health check), else the panel's TCP latency. */
export function Probe({ e, latency }: { e: EntranceView; latency?: LatencyRow }) {
  const tr = useTr();
  const lang = useLang();
  if (e.kind === "relay" && e.health_ok === false) {
    const since = e.hidden_since ?? e.health_at;
    return (
      <span className="inline-flex items-center gap-1.5 text-footnote font-medium text-destructive">
        <Dot tone="danger" />
        {tr(`失败 ${ago(since, lang)}`, `Failing ${ago(since, lang)}`)}
      </span>
    );
  }
  if (latency && latency.delay_ms !== null) {
    const slow = latency.delay_ms > 150;
    return (
      <span
        className={cn(
          "tnum inline-flex items-center gap-1.5 text-footnote",
          slow ? "text-warning" : "text-muted-foreground",
        )}
        title={tr(
          `面板 TCP 测速 · ${ago(latency.measured_at, lang)}`,
          `Panel TCP test · ${ago(latency.measured_at, lang)}`,
        )}
      >
        <Dot tone={slow ? "warning" : "success"} />
        {latency.delay_ms} ms
      </span>
    );
  }
  if (latency)
    return (
      <span
        className="inline-flex items-center gap-1.5 text-footnote text-destructive"
        title={latency.error ?? undefined}
      >
        <Dot tone="danger" />
        {tr("测速失败", "Test failed")}
      </span>
    );
  if (e.kind === "relay" && e.health_ok)
    return (
      <span className="inline-flex items-center gap-1.5 text-footnote text-muted-foreground">
        <Dot tone="success" />
        {tr("正常", "OK")}
      </span>
    );
  return <span className="text-footnote text-faint">{tr("未测", "Not tested")}</span>;
}

/** In subscriptions / hidden (probe failing or the server over quota) / disabled. */
export function SubState({ e, server }: { e: EntranceView; server: ServerView }) {
  const tr = useTr();
  if (!e.enabled)
    return (
      <Badge tone="outline">
        <CircleOff className="size-3" aria-hidden="true" />
        {tr("已停用", "Disabled")}
      </Badge>
    );
  if (e.hidden_since || server.traffic_quota.exceeded_at)
    return (
      <Badge
        tone={e.hidden_since ? "danger" : "warning"}
        title={e.hidden_since ? tr("探测失败", "Probe failing") : tr("服务器额度用尽", "Server over quota")}
      >
        <EyeOff className="size-3" aria-hidden="true" />
        {tr("已隐藏", "Hidden")}
      </Badge>
    );
  return (
    <Badge tone="success">
      <Radio className="size-3" aria-hidden="true" />
      {tr("订阅中", "Listed")}
    </Badge>
  );
}

export type Whitelist = "applied" | "pending" | "failed";

/** The relay source allowlist as the server's agent reports it (R44 heartbeat `source_filter`). */
export function whitelistOf(s: ServerView): Whitelist | null {
  const f = s.heartbeat?.source_filter as { applied?: boolean; error?: string | null } | null | undefined;
  if (!f) return null;
  if (f.applied) return "applied";
  return f.error?.startsWith("pending:") ? "pending" : "failed";
}

export function WhitelistState({ w }: { w: Whitelist | null }) {
  const tr = useTr();
  if (!w) return null;
  if (w === "applied")
    return (
      <span className="inline-flex items-center gap-1 text-caption text-success">
        <ShieldCheck className="size-3" aria-hidden="true" />
        {tr("白名单已应用", "Allowlist applied")}
      </span>
    );
  if (w === "pending")
    return (
      <span className="inline-flex items-center gap-1 text-caption text-warning">
        <Clock className="size-3" aria-hidden="true" />
        {tr("白名单待应用", "Allowlist pending")}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-caption text-destructive">
      <CircleAlert className="size-3" aria-hidden="true" />
      {tr("白名单下发失败", "Allowlist failed")}
    </span>
  );
}

/** "1.5x" plus a "时段 2" pill (amber with a triangle when the rules overlap). */
export function RateCell({ e }: { e: EntranceView }) {
  const tr = useTr();
  const n = e.rate_rules.length;
  const ov = n > 0 && overlaps(e.rate_rules).length > 0;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="tnum text-body font-semibold">{`${Number(e.rate.toFixed(3))}x`}</span>
      {n > 0 && (
        <span
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full px-1.5 text-caption font-medium",
            ov ? "bg-warning-soft text-warning" : "bg-secondary text-muted-foreground",
          )}
          title={
            ov
              ? tr("时段规则有重叠（取最高）", "Time windows overlap (the highest applies)")
              : tr(`当前 ${e.rate_now}x`, `Now ${e.rate_now}x`)
          }
        >
          {ov ? (
            <TriangleAlert className="size-3" aria-hidden="true" />
          ) : (
            <Clock className="size-3" aria-hidden="true" />
          )}
          {tr(`时段 ${n}`, `${n} windows`)}
        </span>
      )}
    </span>
  );
}
