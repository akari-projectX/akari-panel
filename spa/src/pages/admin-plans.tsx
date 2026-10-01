import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  del,
  describePeriod,
  get,
  patch,
  post,
  type GroupView,
  type NodeView,
  type PlanView,
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

const GIB = 1024 ** 3;

const errText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

// Plans grant node groups; a user's nodes are the members of their plan's
// groups (credentials are issued and revoked by the panel).
export function AdminPlans() {
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => get<GroupView[]>("/node-groups") });
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => get<NodeView[]>("/nodes") });
  return (
    <div className="space-y-6">
      <PlansCard plans={plans.data ?? []} groups={groups.data ?? []} />
      <GroupsCard groups={groups.data ?? []} nodes={nodes.data ?? []} />
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
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No {label} yet.</p>;
  return (
    <fieldset className="flex flex-wrap gap-3">
      <legend className="sr-only">{label}</legend>
      {items.map((it) => (
        <label key={it.id} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(it.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, it.id] : selected.filter((x) => x !== it.id))
            }
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

function PlansCard({ plans, groups }: { plans: PlanView[]; groups: GroupView[] }) {
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
    if (period == null) return setError("Days must be 1-3650");
    if (traffic === undefined) return setError("Quota must be a number of GiB");
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
      setError(errText(err, "Create failed"));
    }
  }

  async function toggle(p: PlanView) {
    setError(null);
    try {
      await patch(`/plans/${p.id}`, { enabled: !p.enabled });
      await invalidate();
    } catch (err) {
      setError(errText(err, "Update failed"));
    }
  }

  async function remove(p: PlanView) {
    if (!window.confirm(`Delete plan "${p.name}"?`)) return;
    setError(null);
    try {
      await del(`/plans/${p.id}`);
      await invalidate();
    } catch (err) {
      setError(errText(err, "Delete failed"));
    }
  }

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plans</CardTitle>
        <CardDescription>
          Traffic quota, reset period and the node groups a plan grants. Speed is a hint shown to
          users (not enforced); device seats are reserved for seat binding (not enforced).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="space-y-3" onSubmit={create} aria-label="New plan">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="np-name">Name</Label>
              <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-quota">Quota (GiB, empty = unlimited)</Label>
              <Input id="np-quota" type="number" min="0" step="any" value={quota} onChange={(e) => setQuota(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-period">Reset</Label>
              <select
                id="np-period"
                className="h-9 rounded-lg border border-border bg-card px-2 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="monthly">Monthly</option>
                <option value="days">Every N days</option>
                <option value="none">Never</option>
              </select>
            </div>
            {kind === "days" && (
              <div className="space-y-1.5">
                <Label htmlFor="np-days">Days</Label>
                <Input id="np-days" type="number" min="1" max="3650" value={days} onChange={(e) => setDays(e.target.value)} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="np-speed">Speed hint (Mbps)</Label>
              <Input id="np-speed" type="number" min="1" value={speed} onChange={(e) => setSpeed(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-seats">Device seats</Label>
              <Input id="np-seats" type="number" min="0" value={seats} onChange={(e) => setSeats(e.target.value)} />
            </div>
          </div>
          <Checklist label="node groups" items={groups} selected={groupIds} onChange={setGroupIds} />
          <Button type="submit">Create plan</Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead>Quota</TableHead>
              <TableHead>Reset</TableHead>
              <TableHead>Groups</TableHead>
              <TableHead>Users</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">
                  {p.name}
                  {editing === p.id && (
                    <EditPlan plan={p} groups={groups} onDone={() => setEditing(null)} onError={setError} />
                  )}
                </TableCell>
                <TableCell>{p.traffic_quota_bytes != null ? humanBytes(p.traffic_quota_bytes) : "unlimited"}</TableCell>
                <TableCell>{describePeriod(p.period)}</TableCell>
                <TableCell className="space-x-1">
                  {p.group_ids.map((g) => (
                    <Badge key={g} variant="secondary">
                      {groupName(g)}
                    </Badge>
                  ))}
                </TableCell>
                <TableCell>{p.active_users}</TableCell>
                <TableCell>
                  {p.enabled ? <Badge variant="success">offered</Badge> : <Badge variant="secondary">retired</Badge>}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button variant="outline" size="sm" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggle(p)}>
                    {p.enabled ? "Retire" : "Offer"}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(p)}>
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
  const invalidate = useInvalidate();
  const [quota, setQuota] = useState(
    plan.traffic_quota_bytes != null ? String(plan.traffic_quota_bytes / GIB) : "",
  );
  const [groupIds, setGroupIds] = useState<string[]>(plan.group_ids);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    onError(null);
    const traffic = quotaBytes(quota);
    if (traffic === undefined) return onError("Quota must be a number of GiB");
    try {
      await patch(`/plans/${plan.id}`, { traffic_quota_bytes: traffic, group_ids: groupIds });
      await invalidate();
      onDone();
    } catch (err) {
      onError(errText(err, "Update failed"));
    }
  }

  return (
    <form className="mt-2 space-y-2" onSubmit={save} aria-label={`Edit ${plan.name}`}>
      <div className="space-y-1.5">
        <Label htmlFor={`ep-quota-${plan.id}`}>Quota (GiB)</Label>
        <Input id={`ep-quota-${plan.id}`} type="number" min="0" step="any" value={quota} onChange={(e) => setQuota(e.target.value)} />
      </div>
      <Checklist label="node groups" items={groups} selected={groupIds} onChange={setGroupIds} />
      <Button type="submit" size="sm">
        Save
      </Button>
    </form>
  );
}

function GroupsCard({ groups, nodes }: { groups: GroupView[]; nodes: NodeView[] }) {
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
      setError(errText(err, "Create failed"));
    }
  }

  async function saveMembers(g: GroupView) {
    setError(null);
    try {
      await patch(`/node-groups/${g.id}`, { node_ids: members });
      setEditing(null);
      await invalidate();
    } catch (err) {
      setError(errText(err, "Update failed"));
    }
  }

  async function remove(g: GroupView) {
    if (!window.confirm(`Delete group "${g.name}"? Plans granting it lose its nodes.`)) return;
    setError(null);
    try {
      await del(`/node-groups/${g.id}`);
      await invalidate();
    } catch (err) {
      setError(errText(err, "Delete failed"));
    }
  }

  const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Node groups</CardTitle>
        <CardDescription>A node can be in any number of groups.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={create} aria-label="New group">
          <div className="space-y-1.5">
            <Label htmlFor="ng-name">Name</Label>
            <Input id="ng-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ng-desc">Description</Label>
            <Input id="ng-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <Button type="submit">Create group</Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Group</TableHead>
              <TableHead>Nodes</TableHead>
              <TableHead>Plans</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <TableRow key={g.id}>
                <TableCell>
                  <p className="font-medium">{g.name}</p>
                  {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
                </TableCell>
                <TableCell className="space-y-2">
                  {editing === g.id ? (
                    <>
                      <Checklist label="nodes" items={nodes} selected={members} onChange={setMembers} />
                      <Button size="sm" onClick={() => saveMembers(g)}>
                        Save nodes
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
                    Nodes
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(g)}>
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
