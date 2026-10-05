// 节点实时状态（W11）：列表中的状态列、节点详情页（机器状态、历史曲线、
// 延迟、立即测速）。后台只做中文。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { LatencyBadge } from "../components/latency-badge";
import { LineChart } from "../components/line-chart";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { TableCell, TableHead } from "../components/ui/table";
import {
  ApiError,
  directEntrance,
  get,
  post,
  type LatencyResult,
  type NodeMetricsView,
  type NodeStatus,
  type NodeSummary,
  type NodeView,
} from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { fmtDateTime, fmtTime } from "../lib/datetime";
import { NodeTraffic } from "./admin-traffic";
import { humanBytes } from "../lib/utils";

/** Bytes per second, decimal bits like speed tests ("12.3 Mbps"). */
export function humanRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0 bps";
  const bits = bytesPerSec * 8;
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let v = bits;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** W23: what a value the agent could not read shows as (never 0). */
export const UNKNOWN = "未知";

export function pct(used: number | null, total: number | null): string {
  if (used == null || total == null) return UNKNOWN;
  return total > 0 ? `${Math.round((used / total) * 100)}%` : "—";
}

/** A value the agent may not have been able to read (null = 未知). */
export function known<T>(v: T | null | undefined, f: (v: T) => string): string {
  return v == null ? UNKNOWN : f(v);
}

/** The agent's url-test result to show: the first URL that answered, else the first tried. */
export function agentLatency(results: LatencyResult[]): LatencyResult | null {
  const agent = results.filter((r) => r.source === "agent");
  return agent.find((r) => r.delay_ms != null) ?? agent[0] ?? null;
}

function latencyTitle(r: LatencyResult): string {
  const when = fmtDateTime(r.measured_at);
  return `${r.source === "agent" ? "节点出口测速" : "面板 TCP 连接"} ${r.target}（${when}）${r.error ? `：${r.error}` : ""}`;
}

/** Header cells of the live columns (node list). */
export function NodeLiveHeads() {
  return (
    <>
      <TableHead>CPU / 内存</TableHead>
      <TableHead>↑ / ↓</TableHead>
      <TableHead>在线用户</TableHead>
      <TableHead>延迟</TableHead>
    </>
  );
}

/** The live cells of one node (heartbeat ~15 s, list refreshed every 5 s). */
/** Live columns of one list row (W17: the summary view carries the best agent result). */
export function NodeLiveCells({ n }: { n: Pick<NodeSummary, "online" | "heartbeat" | "latency"> }) {
  const hb = n.online ? n.heartbeat : null;
  const m = hb?.metrics;
  const lat = n.latency;
  return (
    <>
      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
        {hb ? (
          <>
            {known(hb.cpu_percent, (v) => `${v.toFixed(0)}%`)}
            <span className="mx-1">/</span>
            {pct(hb.mem_used_bytes, hb.mem_total_bytes)}
          </>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {m ? (
          <>
            ↑ {known(m.net_tx_bytes_per_sec, humanRate)}
            <span className="block">↓ {known(m.net_rx_bytes_per_sec, humanRate)}</span>
          </>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">{m ? m.online_users : "—"}</TableCell>
      <TableCell>
        <LatencyBadge
          ms={lat?.delay_ms}
          failed={!!lat && lat.delay_ms == null}
          title={lat ? latencyTitle(lat) : "尚未测速"}
        />
      </TableCell>
    </>
  );
}

const RANGES = [
  { id: "1h", label: "1 小时" },
  { id: "6h", label: "6 小时" },
  { id: "24h", label: "24 小时" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
  { id: "90d", label: "90 天" },
] as const;

function uptime(secs: number | undefined): string {
  if (secs == null) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
      {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
}

/** 节点详情：实时状态、历史曲线、延迟与「立即测速」。 */
export function NodeDetail({ node, onClose }: { node: NodeView; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<string>("24h");
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const status = useQuery({
    queryKey: ["node-status", node.id],
    queryFn: () => get<NodeStatus>(`/nodes/${node.id}/status`),
    refetchInterval: 5000,
  });
  const metrics = useQuery({
    queryKey: ["node-metrics", node.id, range],
    queryFn: () => get<NodeMetricsView>(`/nodes/${node.id}/metrics?range=${range}`),
    refetchInterval: 60_000,
  });

  async function probe() {
    setProbeMsg(null);
    try {
      await post(`/nodes/${node.id}/probe`, {});
      setProbeMsg({ ok: true, text: "已发起测速，结果稍后显示（节点出口约数秒，面板 TCP 约 15 秒内）" });
      await queryClient.invalidateQueries({ queryKey: ["node-status", node.id] });
    } catch (err) {
      setProbeMsg({
        ok: false,
        text:
          err instanceof ApiError && err.status === 429 ? "刚刚测过，请稍后再试" : adminErrorText(err, "测速请求失败"),
      });
    }
  }

  const s = status.data;
  const hb = s?.online ? s.heartbeat : null;
  const m = hb?.metrics;
  const pts = metrics.data?.points ?? [];
  const times = pts.map((p) => p.t);
  const agent = (s?.latency ?? []).filter((r) => r.source === "agent");
  const panel = (s?.latency ?? []).filter((r) => r.source === "panel");
  const name = node.display_name ?? node.name;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>
            <h2>节点详情「{name}」</h2>
          </CardTitle>
          <CardDescription>
            {s ? (s.online ? "在线" : "离线") : "加载中…"}
            {s?.last_seen_at && ` · 最后在线 ${fmtDateTime(s.last_seen_at)}`}
            {hb && ` · 心跳 ${fmtTime(hb.ts, true)}`}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          返回列表
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {status.isError && (
          <p role="alert" className="text-sm text-destructive">
            {adminErrorText(status.error, "状态加载失败")}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <Stat
            label="CPU"
            value={hb ? known(hb.cpu_percent, (v) => `${v.toFixed(1)}%`) : "—"}
            sub={
              m &&
              `负载 ${[m.load1, m.load5, m.load15].map((l) => known(l, (v) => v.toFixed(2))).join(" / ")} · ${known(m.cpu_count, (v) => `${v} 核`)}`
            }
          />
          <Stat
            label="内存"
            value={
              hb
                ? hb.mem_used_bytes == null || hb.mem_total_bytes == null
                  ? UNKNOWN
                  : `${humanBytes(hb.mem_used_bytes)} / ${humanBytes(hb.mem_total_bytes)}`
                : "—"
            }
            sub={
              m &&
              (m.swap_total_bytes == null
                ? `交换 ${UNKNOWN}`
                : m.swap_total_bytes > 0 &&
                  `交换 ${known(m.swap_used_bytes, humanBytes)} / ${humanBytes(m.swap_total_bytes)}`)
            }
          />
          <Stat
            label="磁盘（/）"
            value={
              m
                ? m.disk_used_bytes == null || m.disk_total_bytes == null
                  ? UNKNOWN
                  : m.disk_total_bytes > 0
                    ? `${humanBytes(m.disk_used_bytes)} / ${humanBytes(m.disk_total_bytes)}`
                    : "—"
                : "—"
            }
            sub={m && !!m.disk_total_bytes && pct(m.disk_used_bytes, m.disk_total_bytes)}
          />
          <Stat
            label={`网络${m?.net_interface ? `（${m.net_interface}）` : ""}`}
            value={
              m ? `↑ ${known(m.net_tx_bytes_per_sec, humanRate)} · ↓ ${known(m.net_rx_bytes_per_sec, humanRate)}` : "—"
            }
            sub={
              m &&
              `开机以来 ↑ ${known(m.net_tx_bytes_total, humanBytes)} · ↓ ${known(m.net_rx_bytes_total, humanBytes)}`
            }
          />
          <Stat label="在线用户" value={m ? m.online_users : "—"} sub={hb && `代理连接 ${hb.connections}`} />
          <Stat
            label="TCP / UDP 套接字"
            value={m ? `${known(m.tcp_sockets, String)} / ${known(m.udp_sockets, String)}` : "—"}
          />
          <Stat
            label="Agent"
            value={node.agent_version ?? "—"}
            sub={
              hb && `运行 ${uptime(hb.uptime_seconds)}${m ? ` · 内存 ${known(m.process_rss_bytes, humanBytes)}` : ""}`
            }
          />
          <Stat label="Xray" value={m?.xray_version || node.core_version || "—"} />
          <Stat
            label="流量（实际 / 计费）"
            value={s ? `${humanBytes(s.traffic_raw_bytes)} / ${humanBytes(s.traffic_billed_bytes)}` : "—"}
            sub={`直连倍率 ${directEntrance(node)?.rate ?? 1}x`}
          />
        </dl>
        {node.online && !m && (
          <p className="text-sm text-muted-foreground">
            该节点的 agent 版本较旧，未上报机器详细状态（升级 agent 后可见）。
          </p>
        )}
        {hb && (hb.cpu_percent == null || hb.mem_total_bytes == null || m?.load1 == null) && m && (
          <p className="text-sm text-muted-foreground">
            「{UNKNOWN}」= agent 读不到该值（不是 0）。多为节点上的 systemd 单元过旧（隐藏了
            /proc）：在节点上重新运行一次安装命令（重装命令）即可。
          </p>
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-medium">延迟</p>
            <Button size="sm" variant="outline" onClick={probe}>
              立即测速
            </Button>
            {probeMsg && (
              <span
                role={probeMsg.ok ? "status" : "alert"}
                className={`text-sm ${probeMsg.ok ? "text-emerald-700" : "text-destructive"}`}
              >
                {probeMsg.text}
              </span>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">节点出口（HTTP 测速，同 Clash url-test）</p>
              {agent.length === 0 ? (
                <p className="text-sm text-muted-foreground">尚无结果{node.online ? "" : "（节点离线）"}</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {agent.map((r) => (
                    <li key={r.target} className="flex items-center gap-2">
                      <LatencyBadge ms={r.delay_ms} failed={r.delay_ms == null} title={latencyTitle(r)} />
                      <span className="break-all text-muted-foreground">{r.target}</span>
                    </li>
                  ))}
                  <li className="text-xs text-muted-foreground">测于 {fmtDateTime(agent[0].measured_at)}</li>
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">面板到各入站（TCP 连接，按连接地址/端口）</p>
              {panel.length === 0 ? (
                <p className="text-sm text-muted-foreground">尚无结果</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {panel.map((r) => (
                    <li key={r.target} className="flex items-center gap-2">
                      <LatencyBadge
                        ms={r.delay_ms}
                        failed={r.delay_ms == null}
                        na={r.error === "udp"}
                        title={latencyTitle(r)}
                      />
                      <span className="text-muted-foreground">
                        {r.target}
                        {r.error && r.error !== "udp" && `（${r.error}）`}
                        {r.error === "udp" && "（UDP 协议，无法用 TCP 测）"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="时间范围">
            <p className="mr-2 text-sm font-medium">历史</p>
            {RANGES.map((r) => (
              <Button
                key={r.id}
                size="sm"
                variant={range === r.id ? "default" : "outline"}
                aria-pressed={range === r.id}
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </Button>
            ))}
          </div>
          {metrics.isError && (
            <p role="alert" className="text-sm text-destructive">
              {adminErrorText(metrics.error, "历史数据加载失败")}
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <LineChart
              title="CPU"
              times={times}
              max={100}
              format={(v) => `${v.toFixed(0)}%`}
              series={[
                { label: "平均", values: pts.map((p) => p.cpu), stroke: "stroke-sky-500", swatch: "bg-sky-500" },
                { label: "峰值", values: pts.map((p) => p.cpu_max), stroke: "stroke-rose-400", swatch: "bg-rose-400" },
              ]}
            />
            <LineChart
              title="内存"
              times={times}
              max={100}
              format={(v) => `${v.toFixed(0)}%`}
              series={[
                {
                  label: "已用",
                  values: pts.map((p) =>
                    p.mem_total != null && p.mem_used != null && p.mem_total > 0
                      ? (p.mem_used / p.mem_total) * 100
                      : null,
                  ),
                  stroke: "stroke-violet-500",
                  swatch: "bg-violet-500",
                },
              ]}
            />
            <LineChart
              title="网络"
              times={times}
              format={humanRate}
              series={[
                {
                  label: "↑ 上行",
                  values: pts.map((p) => p.tx_bps),
                  stroke: "stroke-emerald-500",
                  swatch: "bg-emerald-500",
                },
                { label: "↓ 下行", values: pts.map((p) => p.rx_bps), stroke: "stroke-sky-500", swatch: "bg-sky-500" },
              ]}
            />
            <LineChart
              title="在线用户 / 连接"
              times={times}
              format={(v) => v.toFixed(0)}
              series={[
                {
                  label: "在线用户",
                  values: pts.map((p) => p.users),
                  stroke: "stroke-amber-500",
                  swatch: "bg-amber-500",
                },
                { label: "连接", values: pts.map((p) => p.conns), stroke: "stroke-slate-400", swatch: "bg-slate-400" },
              ]}
            />
          </div>
        </div>
        <NodeTraffic nodeId={node.id} />
      </CardContent>
    </Card>
  );
}
