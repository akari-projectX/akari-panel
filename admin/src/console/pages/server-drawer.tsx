// Server status (NOD-08): machine state from the last heartbeat, latency
// results (panel TCP + agent probes), "立即测速", the metrics history and
// the raw / billed traffic of its nodes.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { get, post } from "../../shared/api";
import { ago, bytes, dateTime, duration, pct } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { LineChart } from "../../shared/ui/line-chart";
import { Drawer } from "../../shared/ui/overlays";
import { Badge, Button, KV, Segmented, Skeleton } from "../../shared/ui/primitives";
import { FormError, SectionTitle, useRun } from "../kit";
import type { Heartbeat } from "../types";

type Latency = { source: string; target: string; delay_ms: number | null; error: string | null; measured_at: string };
type Status = {
  status: string;
  online: boolean;
  last_seen_at: string | null;
  heartbeat: Heartbeat | null;
  latency: Latency[];
  traffic_raw_bytes: number;
  traffic_billed_bytes: number;
  probe_requested_at: string | null;
};
type Point = {
  t: string;
  cpu: number | null;
  mem_used: number | null;
  mem_total: number | null;
  rx_bps: number | null;
  tx_bps: number | null;
  users: number;
  conns: number | null;
};

const RANGES = ["1h", "6h", "24h", "7d", "30d", "90d"] as const;

export function ServerDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const lang = useLang();
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const [run, busy] = useRun();
  const st = useQuery({
    queryKey: ["servers", id, "status"],
    queryFn: () => get<Status>(`/servers/${id}/status`),
    refetchInterval: 10_000,
  });
  const m = useQuery({
    queryKey: ["servers", id, "metrics", range],
    queryFn: () => get<{ points: Point[] }>(`/servers/${id}/metrics?range=${range}`),
  });
  const s = st.data;
  const hb = s?.heartbeat;
  const pts = m.data?.points ?? [];
  const times = pts.map((p) => p.t);
  return (
    <Drawer
      open
      onClose={onClose}
      width="sm:max-w-3xl"
      title={tr("服务器状态", "Server status")}
      subtitle={
        s && (
          <Badge tone={s.online ? "success" : "danger"}>
            {s.online ? tr("在线", "Online") : tr("离线", "Offline")}
          </Badge>
        )
      }
    >
      {st.isPending && <Skeleton className="h-64" />}
      <FormError error={st.error} />
      {s && (
        <>
          <KV
            items={[
              [tr("最后心跳", "Last heartbeat"), hb ? `${dateTime(hb.ts)} (${ago(hb.ts, lang)})` : "—"],
              ["CPU", hb?.cpu_percent != null ? `${hb.cpu_percent.toFixed(1)}%` : tr("未知", "unknown")],
              [
                tr("内存", "Memory"),
                hb?.mem_total_bytes
                  ? `${bytes(hb.mem_used_bytes)} / ${bytes(hb.mem_total_bytes)} (${pct(hb.mem_used_bytes ?? 0, hb.mem_total_bytes)}%)`
                  : tr("未知", "unknown"),
              ],
              [
                tr("负载", "Load"),
                hb?.metrics
                  ? `${hb.metrics.load1 ?? "?"} / ${hb.metrics.load5 ?? "?"} / ${hb.metrics.load15 ?? "?"}`
                  : "—",
              ],
              [
                tr("磁盘", "Disk"),
                hb?.metrics?.disk_total_bytes
                  ? `${bytes(hb.metrics.disk_used_bytes)} / ${bytes(hb.metrics.disk_total_bytes)}`
                  : "—",
              ],
              [
                tr("网络", "Network"),
                hb?.metrics
                  ? `↓ ${bytes(hb.metrics.net_rx_bytes_per_sec)}/s ↑ ${bytes(hb.metrics.net_tx_bytes_per_sec)}/s (${hb.metrics.net_interface})`
                  : "—",
              ],
              [
                tr("在线用户 / 连接", "Online users / connections"),
                hb ? `${hb.metrics?.online_users ?? "?"} / ${hb.connections}` : "—",
              ],
              [tr("运行时间", "Uptime"), duration(hb?.uptime_seconds ?? null, lang)],
              [
                tr("节点流量（原始 / 计费）", "Node traffic (raw / billed)"),
                `${bytes(s.traffic_raw_bytes)} / ${bytes(s.traffic_billed_bytes)}`,
              ],
            ]}
          />
          <SectionTitle
            actions={
              <Button
                size="sm"
                icon="zap"
                loading={busy}
                onClick={() =>
                  void run(() => post(`/servers/${id}/probe`), {
                    ok: tr("已请求测速，稍后刷新", "Probe requested; refresh shortly"),
                    invalidate: [["servers", id, "status"]],
                  })
                }
              >
                {tr("立即测速", "Probe now")}
              </Button>
            }
          >
            {tr("延迟", "Latency")}
          </SectionTitle>
          {s.latency.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{tr("还没有测速结果。", "No results yet.")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border text-[13px]">
              {s.latency.map((l) => (
                <li key={`${l.source}-${l.target}`} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                  <Badge tone="outline">{l.source === "panel" ? tr("面板 TCP", "panel TCP") : l.source}</Badge>
                  <span className="flex-1 truncate">{l.target}</span>
                  {l.delay_ms != null ? (
                    <Badge tone={l.delay_ms < 200 ? "success" : l.delay_ms < 500 ? "warning" : "danger"}>
                      {l.delay_ms} ms
                    </Badge>
                  ) : (
                    <Badge tone="danger">{l.error ?? tr("超时", "timeout")}</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">{ago(l.measured_at, lang)}</span>
                </li>
              ))}
            </ul>
          )}
          <SectionTitle
            actions={
              <Segmented
                size="sm"
                value={range}
                onChange={setRange}
                options={RANGES.map((r) => ({ value: r, label: r }))}
              />
            }
          >
            {tr("历史", "History")}
          </SectionTitle>
          {m.isPending ? (
            <Skeleton className="h-40" />
          ) : (
            <div className="space-y-4">
              <LineChart
                title="CPU %"
                times={times}
                max={100}
                format={(v) => `${v.toFixed(0)}%`}
                series={[
                  { label: "CPU", values: pts.map((p) => p.cpu), stroke: "stroke-sky-500", swatch: "bg-sky-500" },
                ]}
              />
              <LineChart
                title={tr("内存", "Memory")}
                times={times}
                format={bytes}
                series={[
                  {
                    label: tr("已用", "used"),
                    values: pts.map((p) => p.mem_used),
                    stroke: "stroke-violet-500",
                    swatch: "bg-violet-500",
                  },
                ]}
              />
              <LineChart
                title={tr("网络", "Network")}
                times={times}
                format={(v) => `${bytes(v)}/s`}
                series={[
                  { label: "↓", values: pts.map((p) => p.rx_bps), stroke: "stroke-sky-500", swatch: "bg-sky-500" },
                  {
                    label: "↑",
                    values: pts.map((p) => p.tx_bps),
                    stroke: "stroke-emerald-500",
                    swatch: "bg-emerald-500",
                  },
                ]}
              />
              <LineChart
                title={tr("在线用户", "Online users")}
                times={times}
                format={(v) => v.toFixed(0)}
                series={[
                  {
                    label: tr("用户", "users"),
                    values: pts.map((p) => p.users),
                    stroke: "stroke-amber-500",
                    swatch: "bg-amber-500",
                  },
                ]}
              />
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
