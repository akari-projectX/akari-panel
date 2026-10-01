import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  del,
  get,
  post,
  putBinary,
  type CreateRollout,
  type NodeView,
  type ReleaseView,
  type RolloutDetail,
  type RolloutView,
} from "../lib/api";
import { humanBytes } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

const errText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

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
      setError(errText(err, "upload failed"));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ["releases"] });
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await del(`/agent-releases/${id}`);
    } catch (err) {
      setError(errText(err, "delete failed"));
    }
    await qc.invalidateQueries({ queryKey: ["releases"] });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent releases</CardTitle>
        <CardDescription>
          Upload a release from the agent's GitHub release: the binary, its <code>.manifest.json</code> and{" "}
          <code>.manifest.sig</code>. The panel checks the signature against <code>updates.release_keys</code>;
          agents check it again against the keys compiled into them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="rel-manifest">Manifest</Label>
            <Input id="rel-manifest" type="file" accept=".json" onChange={(e) => setManifest(e.target.files?.[0] ?? null)} />
          </div>
          <div>
            <Label htmlFor="rel-sig">Signature</Label>
            <Input id="rel-sig" type="file" accept=".sig" onChange={(e) => setSig(e.target.files?.[0] ?? null)} />
          </div>
          <div>
            <Label htmlFor="rel-bin">Binary</Label>
            <Input id="rel-bin" type="file" onChange={(e) => setBinary(e.target.files?.[0] ?? null)} />
          </div>
          <div className="flex items-end">
            <Button disabled={busy || !manifest || !sig || !binary} onClick={upload}>
              {busy ? "Uploading…" : "Upload"}
            </Button>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>SHA-256</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(releases.data ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  {r.version}
                  {r.rollback && <Badge variant="secondary" className="ml-2">rollback</Badge>}
                </TableCell>
                <TableCell>
                  {r.os}/{r.arch}
                </TableCell>
                <TableCell>{humanBytes(r.size)}</TableCell>
                <TableCell className="font-mono text-xs" title={r.sha256}>
                  {r.sha256.slice(0, 16)}…
                </TableCell>
                <TableCell className="font-mono text-xs">{r.key_id}</TableCell>
                <TableCell>{r.complete ? "ready" : "binary missing"}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => remove(r.id)}>
                    Delete
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
  const qc = useQueryClient();
  const rollouts = useQuery({
    queryKey: ["rollouts"],
    queryFn: () => get<RolloutView[]>("/rollouts"),
    refetchInterval: 5000,
  });
  const releases = useQuery({ queryKey: ["releases"], queryFn: () => get<ReleaseView[]>("/agent-releases") });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => get<NodeView[]>("/nodes") });
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
      setError("waves: ascending percentages ending at 100, e.g. 10, 50, 100");
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
      setError(errText(err, "create failed"));
    }
    await qc.invalidateQueries({ queryKey: ["rollouts"] });
  }

  async function act(id: string, action: "pause" | "resume" | "abort") {
    setError(null);
    try {
      await post<RolloutView>(`/rollouts/${id}/${action}`, {});
    } catch (err) {
      setError(errText(err, `${action} failed`));
    }
    await qc.invalidateQueries({ queryKey: ["rollouts"] });
    await qc.invalidateQueries({ queryKey: ["rollout", id] });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rollouts</CardTitle>
        <CardDescription>
          Waves are cumulative shares of the selected nodes, in a fixed random order. A node is healthy once it
          reconnects with the new version and acknowledges its configuration within the timeout; the rollout halts
          when failed / finished exceeds the ratio. Agents older than protocol 3 are skipped.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-6">
          <div>
            <Label htmlFor="ro-version">Version</Label>
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
            <Label htmlFor="ro-pct">Percentage</Label>
            <Input id="ro-pct" value={percentage} onChange={(e) => setPercentage(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ro-waves">Waves</Label>
            <Input id="ro-waves" value={waves} onChange={(e) => setWaves(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ro-timeout">Health timeout (s)</Label>
            <Input id="ro-timeout" value={timeout} onChange={(e) => setTimeoutSecs(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ro-ratio">Max failure ratio</Label>
            <Input id="ro-ratio" value={ratio} onChange={(e) => setRatio(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button disabled={versions.length === 0} onClick={create}>
              Start rollout
            </Button>
          </div>
        </div>
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Only these nodes ({selected.length === 0 ? "all enrolled" : selected.length})
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
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Wave</TableHead>
              <TableHead>Nodes</TableHead>
              <TableHead>Started</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
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
    .map(([k, v]) => `${v} ${k}`)
    .join(" · ");
  const isOpen = r.status === "running" || r.status === "paused" || r.status === "halted";
  return (
    <>
      <TableRow>
        <TableCell>
          <button className="underline-offset-2 hover:underline" onClick={onToggle}>
            {r.version}
          </button>
        </TableCell>
        <TableCell>
          <Badge variant={r.status === "halted" ? "destructive" : "secondary"}>{r.status}</Badge>
          {r.halted_reason && <div className="text-xs text-destructive">{r.halted_reason}</div>}
        </TableCell>
        <TableCell>
          {r.current_wave + 1}/{r.waves.length} ({r.waves.join(", ")}%)
        </TableCell>
        <TableCell className="text-sm">{counts || "—"}</TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {new Date(r.created_at).toLocaleString()} by {r.created_by}
        </TableCell>
        <TableCell className="space-x-1 text-right">
          {r.status === "running" && (
            <Button variant="ghost" size="sm" onClick={() => onAction("pause")}>
              Pause
            </Button>
          )}
          {r.status === "paused" && (
            <Button variant="ghost" size="sm" onClick={() => onAction("resume")}>
              Resume
            </Button>
          )}
          {isOpen && (
            <Button variant="ghost" size="sm" onClick={() => onAction("abort")}>
              Abort
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
                  <TableHead>Node</TableHead>
                  <TableHead>Wave</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Now</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(detail.data?.nodes ?? []).map((n) => (
                  <TableRow key={n.node_id}>
                    <TableCell>{n.name}</TableCell>
                    <TableCell>{n.wave + 1}</TableCell>
                    <TableCell className={n.status === "failed" ? "text-destructive" : undefined}>{n.status}</TableCell>
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
