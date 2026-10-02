// W22 (admin, Chinese): traffic history of one user (daily chart + per-node
// table) and of one node (daily chart + top users). Mirrors
// GET /users/{id}/traffic and GET /nodes/{id}/traffic (src/trafficlog.rs).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { LineChart } from "../components/line-chart";
import { ErrorText, TableNote } from "../components/status";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { get } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { fillDays, lastDays, type NodeTrafficView, type TrafficDay, type UserTrafficView } from "../lib/traffic";
import { humanBytes } from "../lib/utils";

const RANGES = [7, 30, 90] as const;

function RangeButtons({ days, onChange, label }: { days: number; onChange: (d: number) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {RANGES.map((d) => (
        <Button
          key={d}
          size="sm"
          variant={d === days ? "default" : "outline"}
          aria-pressed={d === days}
          onClick={() => onChange(d)}
        >
          近 {d} 天
        </Button>
      ))}
    </div>
  );
}

/** Daily up / down / billed lines over every day of the range (gaps = 0). */
function DailyChart({ rows, from, to }: { rows: TrafficDay[]; from: string; to: string }) {
  const filled = fillDays(rows, from, to);
  return (
    <LineChart
      title="每日流量（UTC 日期）"
      times={filled.map((d) => `${d.day}T00:00:00Z`)}
      series={[
        { label: "下载", values: filled.map((d) => d.down_bytes), stroke: "stroke-sky-500", swatch: "bg-sky-500" },
        {
          label: "上传",
          values: filled.map((d) => d.up_bytes),
          stroke: "stroke-emerald-500",
          swatch: "bg-emerald-500",
        },
        {
          label: "计费",
          values: filled.map((d) => d.billed_bytes),
          stroke: "stroke-amber-500",
          swatch: "bg-amber-500",
        },
      ]}
      format={humanBytes}
    />
  );
}

function Totals({ t }: { t: { up_bytes: number; down_bytes: number; billed_bytes: number } }) {
  return (
    <p className="text-sm tabular-nums text-muted-foreground">
      合计：上传 {humanBytes(t.up_bytes)} · 下载 {humanBytes(t.down_bytes)} · 计费 {humanBytes(t.billed_bytes)}
    </p>
  );
}

/** A user's history (用户管理 → 管理). */
export function UserTraffic({ userId, login }: { userId: string; login: string }) {
  const [days, setDays] = useState(30);
  const { from, to } = lastDays(days);
  const daily = useQuery({
    queryKey: ["user-traffic", userId, "day", from, to],
    queryFn: () => get<UserTrafficView>(`/users/${userId}/traffic?group=day&from=${from}&to=${to}`),
  });
  const nodes = useQuery({
    queryKey: ["user-traffic", userId, "node", from, to],
    queryFn: () => get<UserTrafficView>(`/users/${userId}/traffic?group=node&from=${from}&to=${to}`),
  });
  return (
    <section aria-label={`${login} 的流量明细`} className="space-y-3">
      <h3 className="text-sm font-medium">流量明细</h3>
      <RangeButtons days={days} onChange={setDays} label="流量明细时间范围" />
      {daily.isError && <ErrorText>{adminErrorText(daily.error, "流量明细加载失败")}</ErrorText>}
      {daily.data && (
        <>
          <Totals t={daily.data.total} />
          <DailyChart
            rows={daily.data.rows.flatMap((r) => (r.day ? [{ ...r, day: r.day }] : []))}
            from={daily.data.from}
            to={daily.data.to}
          />
        </>
      )}
      {nodes.isError && <ErrorText>{adminErrorText(nodes.error, "按节点统计加载失败")}</ErrorText>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>节点</TableHead>
            <TableHead className="text-right">上传</TableHead>
            <TableHead className="text-right">下载</TableHead>
            <TableHead className="text-right">计费</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.isPending && <TableNote colSpan={4}>加载中…</TableNote>}
          {nodes.isSuccess && nodes.data.rows.length === 0 && <TableNote colSpan={4}>这段时间没有流量。</TableNote>}
          {(nodes.data?.rows ?? []).map((r) => (
            <TableRow key={r.node_id}>
              <TableCell className="font-medium">{r.name ?? "已删除的节点"}</TableCell>
              <TableCell className="text-right tabular-nums">{humanBytes(r.up_bytes)}</TableCell>
              <TableCell className="text-right tabular-nums">{humanBytes(r.down_bytes)}</TableCell>
              <TableCell className="text-right tabular-nums">{humanBytes(r.billed_bytes)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/** A node's history (节点详情). */
export function NodeTraffic({ nodeId }: { nodeId: string }) {
  const [days, setDays] = useState(30);
  const { from, to } = lastDays(days);
  const q = useQuery({
    queryKey: ["node-traffic", nodeId, from, to],
    queryFn: () => get<NodeTrafficView>(`/nodes/${nodeId}/traffic?from=${from}&to=${to}&limit=20`),
    refetchInterval: 60_000,
  });
  return (
    <section aria-label="节点流量" className="space-y-3">
      <h3 className="text-sm font-medium">节点流量</h3>
      <RangeButtons days={days} onChange={setDays} label="节点流量时间范围" />
      {q.isError && <ErrorText>{adminErrorText(q.error, "节点流量加载失败")}</ErrorText>}
      {q.data && (
        <>
          <Totals t={q.data.total} />
          <DailyChart rows={q.data.days} from={q.data.from} to={q.data.to} />
        </>
      )}
      <h4 className="text-sm font-medium">用量最高的用户</h4>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>用户</TableHead>
            <TableHead className="text-right">上传</TableHead>
            <TableHead className="text-right">下载</TableHead>
            <TableHead className="text-right">计费</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.isPending && <TableNote colSpan={4}>加载中…</TableNote>}
          {q.isSuccess && q.data.top_users.length === 0 && <TableNote colSpan={4}>这段时间没有流量。</TableNote>}
          {(q.data?.top_users ?? []).map((u) => (
            <TableRow key={u.user_id}>
              <TableCell className="font-medium">{u.login ?? "已删除的用户"}</TableCell>
              <TableCell className="text-right tabular-nums">{humanBytes(u.up_bytes)}</TableCell>
              <TableCell className="text-right tabular-nums">{humanBytes(u.down_bytes)}</TableCell>
              <TableCell className="text-right tabular-nums">{humanBytes(u.billed_bytes)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
