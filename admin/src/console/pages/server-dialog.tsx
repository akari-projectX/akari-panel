// Server status (NOD-08): machine state from the last heartbeat, latency
// results (panel TCP + agent probes), "立即测速", the metrics history and
// the raw / billed traffic of its nodes. A centred dialog named after the
// server; each request has its own loading / error-with-retry state.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { get, post } from "../../shared/api";
import { ago, bytes, dateTime, duration, pct } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { TrendChart, timeLabels } from "../../shared/ui/charts";
import { SectionTitle } from "../kit";
import { useAction } from "../data";
import { serverState } from "../servers";
import { useCrumb } from "../session";
import type { Heartbeat, ServerView } from "../types";
import { ApplyError, WarningList } from "./node-common";
import { Server, Zap } from "lucide-react";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog } from "../../shared/ui/dialog";
import { Segmented } from "../../shared/ui/form";
import { KV } from "../../shared/ui/layout";
import { ErrorState, LoadingBlock } from "../../shared/ui/states";

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

export function ServerDialog({
  id,
  server,
  onClose,
}: {
  id: string;
  /** From the servers list (name, warnings); undefined while it loads. */
  server: ServerView | undefined;
  onClose: () => void;
}) {
  const tr = useTr();
  const lang = useLang();
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const [run, busy] = useAction();
  useCrumb(server?.name ?? null);
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
  const [state, tone] = server ? serverState(server, tr) : [null, "neutral" as const];
  const unknown = tr("未知", "unknown");
  return (
    <Dialog
      open
      size="lg"
      icon={Server}
      onClose={onClose}
      title={server ? tr(`服务器 · ${server.name}`, `Server · ${server.name}`) : tr("服务器", "Server")}
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          {state && <Badge tone={tone}>{state}</Badge>}
          {server?.agent_version && <span>agent {server.agent_version}</span>}
          {server?.tls_domain && <span className="font-mono">{server.tls_domain}</span>}
        </span>
      }
      footer={
        <>
          <Button
            icon={Zap}
            loading={busy}
            className="mr-auto"
            onClick={() =>
              void run(() => post(`/servers/${id}/probe`), {
                ok: tr("已请求测速，稍后刷新", "Probe requested; refresh shortly"),
              })
            }
          >
            {tr("立即测速", "Probe now")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {tr("完成", "Done")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {server?.last_error && <ApplyError error={server.last_error} at={server.last_error_at} />}
        {server && <WarningList warnings={server.warnings} />}
      </div>
      <SectionTitle>{tr("机器状态", "Machine")}</SectionTitle>
      {st.isError ? (
        <ErrorState compact error={st.error} onRetry={() => void st.refetch()} />
      ) : !s ? (
        <LoadingBlock rows={6} />
      ) : (
        <KV
          items={[
            [tr("最后心跳", "Last heartbeat"), hb ? `${dateTime(hb.ts)} (${ago(hb.ts, lang)})` : "—"],
            ["CPU", hb?.cpu_percent != null ? `${hb.cpu_percent.toFixed(1)}%` : unknown],
            [
              tr("内存", "Memory"),
              hb?.mem_total_bytes
                ? `${bytes(hb.mem_used_bytes)} / ${bytes(hb.mem_total_bytes)} (${pct(hb.mem_used_bytes ?? 0, hb.mem_total_bytes)}%)`
                : unknown,
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
      )}
      <SectionTitle>{tr("延迟", "Latency")}</SectionTitle>
      {s &&
        (s.latency.length === 0 ? (
          <p className="text-body text-muted-foreground">{tr("还没有测速结果。", "No results yet.")}</p>
        ) : (
          <ul className="divide-y divide-separator rounded-lg text-body ring-1 ring-border ring-inset">
            {s.latency.map((l) => (
              <li key={`${l.source}-${l.target}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
                <Badge tone="outline">
                  {l.source === "panel"
                    ? tr("面板 TCP", "panel TCP")
                    : l.source === "agent"
                      ? tr("agent 测速", "agent probe")
                      : l.source}
                </Badge>
                <span className="min-w-0 flex-1 truncate">{l.target}</span>
                {l.delay_ms != null ? (
                  <Badge tone={l.delay_ms < 200 ? "success" : l.delay_ms < 500 ? "warning" : "danger"}>
                    {l.delay_ms} ms
                  </Badge>
                ) : (
                  <Badge tone="danger">{l.error ? tr("失败", "failed") : tr("超时", "timeout")}</Badge>
                )}
                <span className="text-footnote text-muted-foreground">{ago(l.measured_at, lang)}</span>
                {l.delay_ms == null && l.error && (
                  <span className="w-full font-mono text-caption break-all text-muted-foreground">{l.error}</span>
                )}
              </li>
            ))}
          </ul>
        ))}
      <SectionTitle
        actions={
          <Segmented
            size="sm"
            label={tr("时间范围", "Range")}
            value={range}
            onChange={setRange}
            options={RANGES.map((r) => ({ value: r, label: r }))}
          />
        }
      >
        {tr("历史", "History")}
      </SectionTitle>
      {m.isError ? (
        <ErrorState compact error={m.error} onRetry={() => void m.refetch()} />
      ) : m.isPending ? (
        <LoadingBlock rows={6} />
      ) : pts.length === 0 ? (
        <p className="text-body text-muted-foreground">
          {tr("这段时间没有机器状态记录。", "No machine records in this range.")}
        </p>
      ) : (
        <div className="space-y-4">
          <TrendChart
            title="CPU %"
            times={times}
            {...timeLabels(times)}
            max={100}
            format={(v) => `${v.toFixed(0)}%`}
            series={[{ label: "CPU", values: pts.map((p) => p.cpu), slot: 1 }]}
          />
          <TrendChart
            title={tr("内存", "Memory")}
            times={times}
            {...timeLabels(times)}
            format={bytes}
            series={[{ label: tr("已用", "used"), values: pts.map((p) => p.mem_used), slot: 7 }]}
          />
          <TrendChart
            title={tr("网络", "Network")}
            times={times}
            {...timeLabels(times)}
            format={(v) => `${bytes(v)}/s`}
            series={[
              { label: tr("下行 ↓", "Down ↓"), values: pts.map((p) => p.rx_bps), slot: 1 },
              { label: tr("上行 ↑", "Up ↑"), values: pts.map((p) => p.tx_bps), slot: 3 },
            ]}
          />
          <TrendChart
            title={tr("在线用户", "Online users")}
            times={times}
            {...timeLabels(times)}
            format={(v) => v.toFixed(0)}
            series={[{ label: tr("用户", "users"), values: pts.map((p) => p.users), slot: 4 }]}
          />
        </div>
      )}
    </Dialog>
  );
}
