import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  del,
  get,
  post,
  putBinary,
  type CreateRollout,
  type NodeSummary,
  type ReleaseView,
  type RolloutDetail,
  type RolloutView,
} from "../lib/api";
import { humanBytes } from "../lib/utils";
import { ErrorText, TableNote } from "../components/status";
import { useT } from "../i18n";
import { errorText } from "../lib/errors";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

// Admin console (Chinese only).
const ROLLOUT_STATUS: Record<string, string> = {
  running: "进行中",
  paused: "已暂停",
  halted: "已熔断",
  aborted: "已中止",
  completed: "已完成",
};
const NODE_STATUS: Record<string, string> = {
  pending: "等待",
  offered: "已下发",
  updating: "更新中",
  healthy: "健康",
  failed: "失败",
  skipped: "跳过",
};

/** "10, 50, 100" -> [10, 50, 100]; null when malformed. */
export function parseWaves(text: string): number[] | null {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 100)) return null;
  for (let i = 1; i < nums.length; i++) if (nums[i] <= nums[i - 1]) return null;
  if (nums[nums.length - 1] !== 100) return null;
  return nums;
}

// M6: signed agent releases (the panel relays them; agents verify the
// signature under their pinned release keys) and staged rollouts.
export function AdminUpdates() {
  return (
    <div className="space-y-6">
      <Rollouts />
      <Releases />
    </div>
  );
}

function Releases() {
  const t = useT();
  const qc = useQueryClient();
  const releases = useQuery({ queryKey: ["releases"], queryFn: () => get<ReleaseView[]>("/agent-releases") });
  const [manifest, setManifest] = useState<File | null>(null);
  const [sig, setSig] = useState<File | null>(null);
  const [binary, setBinary] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!manifest || !sig || !binary) return;
    setBusy(true);
    setError(null);
    try {
      const created = await post<ReleaseView>("/agent-releases", {
        manifest: await manifest.text(),
        sig: JSON.parse(await sig.text()),
      });
      await putBinary<ReleaseView>(`/agent-releases/${created.id}/binary`, binary);
      setManifest(null);
      setSig(null);
      setBinary(null);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ["releases"] });
    }
  }

  async function remove(r: ReleaseView) {
    if (!window.confirm(`删除发布 ${r.version}（${r.os}/${r.arch}）？`)) return;
    const id = r.id;
    setError(null);
    try {
      await del(`/agent-releases/${id}`);
    } catch (err) {
      setError(errorText(err, t));
    }
    await qc.invalidateQueries({ queryKey: ["releases"] });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Agent 发布</h2>
        </CardTitle>
        <CardDescription>
          从 agent 的 GitHub Release 上传三个文件：二进制、<code>.manifest.json</code> 与 <code>.manifest.sig</code>。
          面板先用 <code>updates.release_keys</code> 校验签名，agent 再用编译进自身的公钥校验一次。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="rel-manifest">清单（manifest）</Label>
            <Input
              id="rel-manifest"
              type="file"
              accept=".json"
              onChange={(e) => setManifest(e.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <Label htmlFor="rel-sig">签名</Label>
            <Input id="rel-sig" type="file" accept=".sig" onChange={(e) => setSig(e.target.files?.[0] ?? null)} />
          </div>
          <div>
            <Label htmlFor="rel-bin">二进制</Label>
            <Input id="rel-bin" type="file" onChange={(e) => setBinary(e.target.files?.[0] ?? null)} />
          </div>
          <div className="flex items-end">
            <Button disabled={busy || !manifest || !sig || !binary} onClick={upload}>
              {busy ? "上传中…" : "上传"}
            </Button>
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>版本</TableHead>
              <TableHead>平台</TableHead>
              <TableHead>大小</TableHead>
              <TableHead>SHA-256</TableHead>
              <TableHead>公钥</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {releases.isPending && <TableNote colSpan={7}>加载中…</TableNote>}
            {releases.isSuccess && releases.data.length === 0 && (
              <TableNote colSpan={7}>还没有上传任何发布。</TableNote>
            )}
            {(releases.data ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  {r.version}
                  {r.rollback && (
                    <Badge variant="secondary" className="ml-2">
                      回滚
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {r.os}/{r.arch}
                </TableCell>
                <TableCell>{humanBytes(r.size)}</TableCell>
                <TableCell className="font-mono text-xs" title={r.sha256}>
                  {r.sha256.slice(0, 16)}…
                </TableCell>
                <TableCell className="font-mono text-xs">{r.key_id}</TableCell>
                <TableCell>{r.complete ? "就绪" : "缺少二进制"}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => remove(r)}>
                    删除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Rollouts() {
  const t = useT();
  const qc = useQueryClient();
  const rollouts = useQuery({
    queryKey: ["rollouts"],
    queryFn: () => get<RolloutView[]>("/rollouts"),
    refetchInterval: 5000,
  });
  const releases = useQuery({ queryKey: ["releases"], queryFn: () => get<ReleaseView[]>("/agent-releases") });
  const nodes = useQuery({ queryKey: ["nodes", "summary"], queryFn: () => get<NodeSummary[]>("/nodes?view=summary") });
  const versions = [...new Set((releases.data ?? []).filter((r) => r.complete).map((r) => r.version))];
  const [version, setVersion] = useState("");
  const [percentage, setPercentage] = useState("100");
  const [waves, setWaves] = useState("10, 50, 100");
  const [timeout, setTimeoutSecs] = useState("600");
  const [ratio, setRatio] = useState("0.2");
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    const w = parseWaves(waves);
    if (!w) {
      setError("分批（waves）须为递增且以 100 结尾的百分比，例如 10, 50, 100");
      return;
    }
    const body: CreateRollout = {
      version: version || versions[0] || "",
      percentage: Number(percentage),
      waves: w,
      health_timeout_secs: Number(timeout),
      max_failure_ratio: Number(ratio),
    };
    if (selected.length > 0) body.node_ids = selected;
    try {
      await post<RolloutView>("/rollouts", body);
      setSelected([]);
    } catch (err) {
      setError(errorText(err, t));
    }
    await qc.invalidateQueries({ queryKey: ["rollouts"] });
  }

  async function act(id: string, action: "pause" | "resume" | "abort") {
    if (action === "abort" && !window.confirm("中止这次灰度更新？未更新的节点将保持当前版本。")) return;
    setError(null);
    try {
      await post<RolloutView>(`/rollouts/${id}/${action}`, {});
    } catch (err) {
      setError(errorText(err, t));
    }
    await qc.invalidateQueries({ queryKey: ["rollouts"] });
    await qc.invalidateQueries({ queryKey: ["rollout", id] });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>灰度更新</h1>
        </CardTitle>
        <CardDescription>
          分批（waves）是所选节点按固定随机顺序的累计百分比。节点在超时时间内以新版本重新连接并确认配置即为健康； 失败数
          / 已完成数超过比例时自动熔断。协议版本低于 3 的 agent 会被跳过。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-6">
          <div>
            <Label htmlFor="ro-version">版本</Label>
            <select
              id="ro-version"
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              value={version || versions[0] || ""}
              onChange={(e) => setVersion(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ro-pct">覆盖比例（%）</Label>
            <Input id="ro-pct" value={percentage} onChange={(e) => setPercentage(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ro-waves">分批（waves）</Label>
            <Input id="ro-waves" value={waves} onChange={(e) => setWaves(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ro-timeout">健康超时（秒）</Label>
            <Input id="ro-timeout" value={timeout} onChange={(e) => setTimeoutSecs(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ro-ratio">最大失败比例</Label>
            <Input id="ro-ratio" value={ratio} onChange={(e) => setRatio(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button disabled={versions.length === 0} onClick={create}>
              开始更新
            </Button>
          </div>
        </div>
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            仅限这些节点（{selected.length === 0 ? "全部已注册节点" : `已选 ${selected.length} 个`}）
          </summary>
          <div className="mt-2 flex flex-wrap gap-3">
            {(nodes.data ?? [])
              .filter((n) => n.enrolled && !n.deleting_at)
              .map((n) => (
                <label key={n.id} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(n.id)}
                    onChange={(e) =>
                      setSelected((s) => (e.target.checked ? [...s, n.id] : s.filter((x) => x !== n.id)))
                    }
                  />
                  {n.name} <span className="text-xs text-muted-foreground">{n.agent_version ?? "—"}</span>
                </label>
              ))}
          </div>
        </details>
        <ErrorText>{error}</ErrorText>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>版本</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>批次</TableHead>
              <TableHead>节点</TableHead>
              <TableHead>开始</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rollouts.isPending && <TableNote colSpan={6}>加载中…</TableNote>}
            {rollouts.isSuccess && rollouts.data.length === 0 && <TableNote colSpan={6}>还没有灰度更新。</TableNote>}
            {(rollouts.data ?? []).map((r) => (
              <RolloutRow
                key={r.id}
                r={r}
                open={open === r.id}
                onToggle={() => setOpen(open === r.id ? null : r.id)}
                onAction={(a) => act(r.id, a)}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function RolloutRow({
  r,
  open,
  onToggle,
  onAction,
}: {
  r: RolloutView;
  open: boolean;
  onToggle: () => void;
  onAction: (a: "pause" | "resume" | "abort") => void;
}) {
  const detail = useQuery({
    queryKey: ["rollout", r.id],
    queryFn: () => get<RolloutDetail>(`/rollouts/${r.id}`),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });
  const counts = Object.entries(r.counts)
    .map(([k, v]) => `${NODE_STATUS[k] ?? k} ${v}`)
    .join(" · ");
  const isOpen = r.status === "running" || r.status === "paused" || r.status === "halted";
  return (
    <>
      <TableRow>
        <TableCell>
          <button
            type="button"
            aria-expanded={open}
            className="rounded underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onToggle}
          >
            {r.version}
          </button>
        </TableCell>
        <TableCell>
          <Badge variant={r.status === "halted" ? "destructive" : "secondary"}>
            {ROLLOUT_STATUS[r.status] ?? r.status}
          </Badge>
          {r.halted_reason && <div className="text-xs text-destructive">{r.halted_reason}</div>}
        </TableCell>
        <TableCell>
          {r.current_wave + 1}/{r.waves.length} ({r.waves.join(", ")}%)
        </TableCell>
        <TableCell className="text-sm">{counts || "—"}</TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {new Date(r.created_at).toLocaleString("zh-CN")} · {r.created_by}
        </TableCell>
        <TableCell className="space-x-1 text-right">
          {r.status === "running" && (
            <Button variant="ghost" size="sm" onClick={() => onAction("pause")}>
              暂停
            </Button>
          )}
          {r.status === "paused" && (
            <Button variant="ghost" size="sm" onClick={() => onAction("resume")}>
              继续
            </Button>
          )}
          {isOpen && (
            <Button variant="ghost" size="sm" onClick={() => onAction("abort")}>
              中止
            </Button>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={6}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>节点</TableHead>
                  <TableHead>批次</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>原版本</TableHead>
                  <TableHead>当前版本</TableHead>
                  <TableHead>详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(detail.data?.nodes ?? []).map((n) => (
                  <TableRow key={n.node_id}>
                    <TableCell>{n.name}</TableCell>
                    <TableCell>{n.wave + 1}</TableCell>
                    <TableCell className={n.status === "failed" ? "text-destructive" : undefined}>
                      {NODE_STATUS[n.status] ?? n.status}
                    </TableCell>
                    <TableCell>{n.from_version ?? "—"}</TableCell>
                    <TableCell>{n.agent_version ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{n.detail ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
