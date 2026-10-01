import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { del, describePeriod, get, patch, post, type GroupView, type NodeView, type PlanView } from "../lib/api";
import { GIB, humanBytes } from "../lib/utils";
import { ErrorText, TableNote } from "../components/status";
import { useT } from "../i18n";
import { errorText } from "../lib/errors";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

// Plans grant node groups; a user's nodes are the members of their plan's
// groups (credentials are issued and revoked by the panel). Admin console:
// Chinese only.
export function AdminPlans() {
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => get<GroupView[]>("/node-groups") });
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => get<NodeView[]>("/nodes") });
  return (
    <div className="space-y-6">
      <PlansCard plans={plans.data} loading={plans.isPending} groups={groups.data ?? []} />
      <GroupsCard groups={groups.data} loading={groups.isPending} nodes={nodes.data ?? []} />
    </div>
  );
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["groups"] }),
      queryClient.invalidateQueries({ queryKey: ["plans"] }),
      queryClient.invalidateQueries({ queryKey: ["users"] }),
    ]);
  };
}

function Checklist({
  label,
  items,
  selected,
  onChange,
}: {
  label: string;
  items: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">还没有{label}。</p>;
  return (
    <fieldset className="flex flex-wrap gap-3">
      <legend className="sr-only">{label}</legend>
      {items.map((it) => (
        <label key={it.id} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(it.id)}
            onChange={(e) => onChange(e.target.checked ? [...selected, it.id] : selected.filter((x) => x !== it.id))}
          />
          {it.name}
        </label>
      ))}
    </fieldset>
  );
}

// "monthly" | "none" | "days-N" from the form controls.
export function periodValue(kind: string, days: string): string | null {
  if (kind === "monthly" || kind === "none") return kind;
  const n = Number(days);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? `days-${n}` : null;
}

// GiB text -> bytes; "" = unlimited (null); undefined = invalid.
export function quotaBytes(gib: string): number | null | undefined {
  if (gib.trim() === "") return null;
  const n = Number(gib);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * GIB) : undefined;
}

function PlansCard({ plans = [], loading, groups }: { plans?: PlanView[]; loading: boolean; groups: GroupView[] }) {
  const t = useT();
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("");
  const [kind, setKind] = useState("monthly");
  const [days, setDays] = useState("30");
  const [speed, setSpeed] = useState("");
  const [seats, setSeats] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const period = periodValue(kind, days);
    const traffic = quotaBytes(quota);
    if (period == null) return setError("天数须为 1–3650 的整数");
    if (traffic === undefined) return setError("流量额度须为数字（GiB）");
    const body: Record<string, unknown> = {
      name,
      period,
      traffic_quota_bytes: traffic,
      group_ids: groupIds,
    };
    if (speed.trim() !== "") body.speed_limit_mbps = Number(speed);
    if (seats.trim() !== "") body.device_seats = Number(seats);
    try {
      await post<PlanView>("/plans", body);
      setName("");
      setQuota("");
      setSpeed("");
      setSeats("");
      setGroupIds([]);
      await invalidate();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  async function toggle(p: PlanView) {
    setError(null);
    try {
      await patch(`/plans/${p.id}`, { enabled: !p.enabled });
      await invalidate();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  async function remove(p: PlanView) {
    if (!window.confirm(`删除套餐「${p.name}」？`)) return;
    setError(null);
    try {
      await del(`/plans/${p.id}`);
      await invalidate();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>套餐</h1>
        </CardTitle>
        <CardDescription>
          流量额度、重置周期，以及套餐授予的节点组。速率只作为提示展示给用户（不限速）；设备数为席位绑定预留（暂不生效）。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="space-y-3" onSubmit={create} aria-label="新建套餐">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="np-name">名称</Label>
              <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-quota">流量额度（GiB，留空不限）</Label>
              <Input
                id="np-quota"
                type="number"
                min="0"
                step="any"
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-period">流量重置</Label>
              <select
                id="np-period"
                className="h-9 rounded-lg border border-border bg-card px-2 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="monthly">每月</option>
                <option value="days">每 N 天</option>
                <option value="none">不重置</option>
              </select>
            </div>
            {kind === "days" && (
              <div className="space-y-1.5">
                <Label htmlFor="np-days">天数</Label>
                <Input
                  id="np-days"
                  type="number"
                  min="1"
                  max="3650"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="np-speed">速率提示（Mbps）</Label>
              <Input id="np-speed" type="number" min="1" value={speed} onChange={(e) => setSpeed(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-seats">设备数</Label>
              <Input id="np-seats" type="number" min="0" value={seats} onChange={(e) => setSeats(e.target.value)} />
            </div>
          </div>
          <Checklist label="节点组" items={groups} selected={groupIds} onChange={setGroupIds} />
          <Button type="submit">创建套餐</Button>
        </form>
        <ErrorText>{error}</ErrorText>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>套餐</TableHead>
              <TableHead>流量额度</TableHead>
              <TableHead>重置</TableHead>
              <TableHead>节点组</TableHead>
              <TableHead>用户数</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableNote colSpan={7}>加载中…</TableNote>}
            {!loading && plans.length === 0 && <TableNote colSpan={7}>还没有套餐。</TableNote>}
            {plans.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">
                  {p.name}
                  {editing === p.id && (
                    <EditPlan plan={p} groups={groups} onDone={() => setEditing(null)} onError={setError} />
                  )}
                </TableCell>
                <TableCell>{p.traffic_quota_bytes != null ? humanBytes(p.traffic_quota_bytes) : "不限"}</TableCell>
                <TableCell>{describePeriod(p.period, t)}</TableCell>
                <TableCell className="space-x-1">
                  {p.group_ids.map((g) => (
                    <Badge key={g} variant="secondary">
                      {groupName(g)}
                    </Badge>
                  ))}
                </TableCell>
                <TableCell>{p.active_users}</TableCell>
                <TableCell>
                  {p.enabled ? <Badge variant="success">在售</Badge> : <Badge variant="secondary">已下架</Badge>}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button variant="outline" size="sm" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                    编辑
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggle(p)}>
                    {p.enabled ? "下架" : "上架"}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(p)}>
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

function EditPlan({
  plan,
  groups,
  onDone,
  onError,
}: {
  plan: PlanView;
  groups: GroupView[];
  onDone: () => void;
  onError: (e: string | null) => void;
}) {
  const t = useT();
  const invalidate = useInvalidate();
  const [quota, setQuota] = useState(plan.traffic_quota_bytes != null ? String(plan.traffic_quota_bytes / GIB) : "");
  const [groupIds, setGroupIds] = useState<string[]>(plan.group_ids);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    onError(null);
    const traffic = quotaBytes(quota);
    if (traffic === undefined) return onError("流量额度须为数字（GiB）");
    try {
      await patch(`/plans/${plan.id}`, { traffic_quota_bytes: traffic, group_ids: groupIds });
      await invalidate();
      onDone();
    } catch (err) {
      onError(errorText(err, t));
    }
  }

  return (
    <form className="mt-2 space-y-2" onSubmit={save} aria-label={`编辑 ${plan.name}`}>
      <div className="space-y-1.5">
        <Label htmlFor={`ep-quota-${plan.id}`}>流量额度（GiB，留空不限）</Label>
        <Input
          id={`ep-quota-${plan.id}`}
          type="number"
          min="0"
          step="any"
          value={quota}
          onChange={(e) => setQuota(e.target.value)}
        />
      </div>
      <Checklist label="节点组" items={groups} selected={groupIds} onChange={setGroupIds} />
      <Button type="submit" size="sm">
        保存
      </Button>
    </form>
  );
}

function GroupsCard({ groups = [], loading, nodes }: { groups?: GroupView[]; loading: boolean; nodes: NodeView[] }) {
  const t = useT();
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [members, setMembers] = useState<string[]>([]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await post<GroupView>("/node-groups", { name, description });
      setName("");
      setDescription("");
      await invalidate();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  async function saveMembers(g: GroupView) {
    setError(null);
    try {
      await patch(`/node-groups/${g.id}`, { node_ids: members });
      setEditing(null);
      await invalidate();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  async function remove(g: GroupView) {
    if (!window.confirm(`删除节点组「${g.name}」？授予该组的套餐会失去其中的节点。`)) return;
    setError(null);
    try {
      await del(`/node-groups/${g.id}`);
      await invalidate();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>节点组</h2>
        </CardTitle>
        <CardDescription>一个节点可以属于任意多个组；套餐通过节点组授予节点。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={create} aria-label="新建节点组">
          <div className="space-y-1.5">
            <Label htmlFor="ng-name">名称</Label>
            <Input id="ng-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ng-desc">说明</Label>
            <Input id="ng-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <Button type="submit">创建节点组</Button>
        </form>
        <ErrorText>{error}</ErrorText>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>节点组</TableHead>
              <TableHead>节点</TableHead>
              <TableHead>套餐数</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableNote colSpan={4}>加载中…</TableNote>}
            {!loading && groups.length === 0 && <TableNote colSpan={4}>还没有节点组。</TableNote>}
            {groups.map((g) => (
              <TableRow key={g.id}>
                <TableCell>
                  <p className="font-medium">{g.name}</p>
                  {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
                </TableCell>
                <TableCell className="space-y-2">
                  {editing === g.id ? (
                    <>
                      <Checklist label="节点" items={nodes} selected={members} onChange={setMembers} />
                      <Button size="sm" onClick={() => saveMembers(g)}>
                        保存成员
                      </Button>
                    </>
                  ) : (
                    <div className="space-x-1">
                      {g.node_ids.map((n) => (
                        <Badge key={n} variant="secondary">
                          {nodeName(n)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>{g.plan_ids.length}</TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setMembers(g.node_ids);
                      setEditing(editing === g.id ? null : g.id);
                    }}
                  >
                    成员
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(g)}>
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
