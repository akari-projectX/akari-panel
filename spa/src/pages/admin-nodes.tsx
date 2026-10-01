import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  del,
  get,
  patch,
  post,
  put,
  type GeneratedAccount,
  type NodeEnrollment,
  type NodeView,
} from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export function AdminNodes() {
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => get<NodeView[]>("/nodes") });
  const [selected, setSelected] = useState<string | null>(null);

  const node = (nodes.data ?? []).find((n) => n.id === selected) ?? null;
  const [error, setError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<NodeEnrollment | null>(null);

  // A new one-time enrollment token (expired token, lost agent state).
  // Once the agent enrolls with it the node's older certificates stop
  // working.
  async function newToken(n: NodeView) {
    setError(null);
    if (
      n.enrolled &&
      !window.confirm(
        `Issue a new enrollment token for "${n.name}"? When an agent enrolls with it, the current certificate stops working.`,
      )
    ) {
      return;
    }
    try {
      setEnrollment(await post<NodeEnrollment>(`/nodes/${n.id}/enroll-token`, undefined));
      await nodes.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Token failed");
    }
  }

  // Deletion revokes the node's certificate for good: the agent is pushed
  // the empty state, then the node disappears (a reinstall needs a new
  // bootstrap file).
  async function remove(n: NodeView) {
    setError(null);
    if (
      !window.confirm(
        `Delete node "${n.name}"? Its agent stops serving and its certificate is revoked permanently.`,
      )
    ) {
      return;
    }
    try {
      await del(`/nodes/${n.id}`);
      if (selected === n.id) setSelected(null);
      await nodes.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <div className="space-y-6">
      <CreateNode
        onCreated={async (e) => {
          setEnrollment(e);
          await nodes.refetch();
        }}
      />
      {enrollment && (
        <BootstrapCard enrollment={enrollment} onClose={() => setEnrollment(null)} />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Nodes</CardTitle>
          <CardDescription>Agents connect outbound; select one to configure.</CardDescription>
        </CardHeader>
        <CardContent>
          {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Core</TableHead>
                <TableHead>Versions</TableHead>
                <TableHead>Certificate</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(nodes.data ?? []).map((n) => (
                <TableRow key={n.id}>
                  <TableCell className="font-medium">{n.name}</TableCell>
                  <TableCell>
                    {n.deleting_at ? (
                      <Badge variant="destructive">deleting</Badge>
                    ) : !n.enabled ? (
                      <Badge variant="secondary">disabled</Badge>
                    ) : n.status === "online" ? (
                      <Badge variant="success">online</Badge>
                    ) : !n.enrolled ? (
                      <Badge variant="outline">awaiting enrollment</Badge>
                    ) : (
                      <Badge variant="outline">{n.status}</Badge>
                    )}
                    {n.warnings.length > 0 && (
                      <span
                        className="ml-2 text-xs font-medium text-amber-600"
                        title={n.warnings.join("\n")}
                      >
                        {n.warnings.length} warning{n.warnings.length > 1 ? "s" : ""}
                      </span>
                    )}
                    {n.last_error && (
                      <span
                        className="ml-2 text-xs font-medium text-destructive"
                        title={n.last_error}
                      >
                        apply failed
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{n.agent_version ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{n.core_version ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    cfg {n.config_version} · usr {n.user_version}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {n.cert_not_after
                      ? `until ${new Date(n.cert_not_after).toLocaleDateString()}`
                      : n.enroll_token_expires_at
                        ? `token until ${new Date(n.enroll_token_expires_at).toLocaleString()}`
                        : n.enrolled
                          ? "—"
                          : "token expired"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {n.last_seen_at ? new Date(n.last_seen_at).toLocaleTimeString() : "—"}
                    {n.heartbeat && (
                      <span className="block text-xs">
                        {n.heartbeat.connections} conn
                        {n.heartbeat.uptime_seconds != null &&
                          ` · up ${Math.floor(n.heartbeat.uptime_seconds / 3600)} h`}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelected(n.id === selected ? null : n.id)}
                    >
                      {n.id === selected ? "Close" : "Configure"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!n.deleting_at}
                      onClick={async () => {
                        await patch(`/nodes/${n.id}`, { enabled: !n.enabled });
                        await nodes.refetch();
                      }}
                    >
                      {n.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!n.deleting_at}
                      onClick={() => newToken(n)}
                    >
                      Enrollment token
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={!!n.deleting_at}
                      onClick={() => remove(n)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {node && <NodeEditor node={node} />}
    </div>
  );
}

function CreateNode({ onCreated }: { onCreated: (e: NodeEnrollment) => Promise<void> }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await post<NodeEnrollment>("/nodes", { name: name.trim() });
      setName("");
      await onCreated(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New node</CardTitle>
        <CardDescription>
          Creates the node with a one-time enrollment token. The agent generates its own key; the
          bootstrap file holds no private key.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="nn-name">Name</Label>
            <Input id="nn-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <Button type="submit">Create</Button>
        </form>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// The bootstrap file: shown once (the panel keeps only the token's hash).
function BootstrapCard({
  enrollment,
  onClose,
}: {
  enrollment: NodeEnrollment;
  onClose: () => void;
}) {
  function download() {
    const url = URL.createObjectURL(new Blob([enrollment.bootstrap], { type: "application/toml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${enrollment.name}-bootstrap.toml`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bootstrap file for {enrollment.name}</CardTitle>
        <CardDescription>
          Shown once. The enrollment token is single use and expires{" "}
          {new Date(enrollment.expires_at).toLocaleString()}. Install it as{" "}
          <code>/etc/akari-agent/bootstrap.toml</code> (mode 0600) on the node.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
          {enrollment.bootstrap}
        </pre>
        <div className="flex gap-2">
          <Button onClick={download}>Download</Button>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NodeEditor({ node }: { node: NodeView }) {
  const queryClient = useQueryClient();
  const [inbounds, setInbounds] = useState(() => JSON.stringify(node.xray_inbounds, null, 2));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [userId, setUserId] = useState("");
  const [serverAddr, setServerAddr] = useState(node.server_addr ?? "");
  const [region, setRegion] = useState(node.region ?? "");
  const [addrSaved, setAddrSaved] = useState(false);
  const [inboundTag, setInboundTag] = useState(node.xray_inbounds[0]?.tag ?? "");
  const [protocol, setProtocol] = useState("vless");
  const [account, setAccount] = useState<GeneratedAccount | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  async function saveServerAddr(e: React.FormEvent) {
    e.preventDefault();
    setAddrSaved(false);
    try {
      await patch(`/nodes/${node.id}`, {
        server_addr: serverAddr.trim() || null,
        region: region.trim() || null,
      });
      setAddrSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["nodes"] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function saveInbounds(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);
    try {
      const parsed = JSON.parse(inbounds) as unknown;
      await put(`/nodes/${node.id}/inbounds`, { inbounds: parsed });
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["nodes"] });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Invalid JSON");
    }
  }

  async function assign(e: React.FormEvent, userId: string) {
    e.preventDefault();
    setAssignError(null);
    try {
      const acc = await post<GeneratedAccount>(
        `/users/${userId}/nodes/${node.id}`,
        { inbound_tag: inboundTag, protocol },
      );
      setAccount(acc);
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : "Assign failed");
    }
  }

  async function unassign(e: React.FormEvent, userId: string) {
    e.preventDefault();
    setAssignError(null);
    setAccount(null);
    try {
      await del(`/users/${userId}/nodes/${node.id}`);
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : "Unassign failed");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configure “{node.name}”</CardTitle>
        <CardDescription>
          Inbounds are pushed to the agent as a full snapshot; users re-apply without restarts.
        </CardDescription>
        {node.last_error && (
          <p role="alert" className="mt-2 break-all text-sm text-destructive">
            Last apply failed
            {node.failed_config_version !== null &&
              ` (cfg ${node.failed_config_version} · usr ${node.failed_user_version})`}
            {node.last_error_at && ` at ${new Date(node.last_error_at).toLocaleString()}`}:{" "}
            {node.last_error}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        <form className="flex flex-wrap items-end gap-3" onSubmit={saveServerAddr}>
          <div className="space-y-1.5">
            <Label htmlFor="saddr">Public server address</Label>
            <Input
              id="saddr"
              className="w-72"
              value={serverAddr}
              onChange={(e) => setServerAddr(e.target.value)}
              placeholder="node.example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="region">Region (shown to users)</Label>
            <Input
              id="region"
              className="w-48"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="Tokyo"
            />
          </div>
          <Button variant="outline" type="submit">
            Save address
          </Button>
          {addrSaved && <span className="text-sm text-emerald-600">saved</span>}
        </form>

        <form className="space-y-3" onSubmit={saveInbounds}>
          <Label htmlFor="inbounds">Xray inbounds JSON</Label>
          <textarea
            id="inbounds"
            className="h-64 w-full rounded-lg border border-border bg-card p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={inbounds}
            onChange={(e) => setInbounds(e.target.value)}
            spellCheck={false}
          />
          <div className="flex items-center gap-3">
            <Button type="submit">Push inbounds</Button>
            {saved && <span className="text-sm text-emerald-600">pushed</span>}
            {saveError && <span className="text-sm text-destructive">{saveError}</span>}
          </div>
        </form>

        <div className="rounded-lg border border-border p-4">
          <p className="mb-1 text-sm font-medium">Manual override: issue an account for a user on this node</p>
          <p className="mb-3 text-xs text-muted-foreground">
            Normally access comes from the user&apos;s plan (Plans → node groups). A manual
            assignment pins this user&apos;s access on this node regardless of their plan;
            removing it hands the node back to the plan.
          </p>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => assign(e, userId)}>
            <div className="space-y-1.5">
              <Label htmlFor="uid">User ID</Label>
              <Input
                id="uid"
                className="w-72 font-mono text-xs"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="user uuid"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="itag">Inbound</Label>
              <select
                id="itag"
                className="h-9 rounded-lg border border-border bg-card px-3 text-sm"
                value={inboundTag}
                onChange={(e) => setInboundTag(e.target.value)}
              >
                {node.xray_inbounds.map((i) => (
                  <option key={i.tag} value={i.tag}>
                    {i.tag}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proto">Protocol</Label>
              <select
                id="proto"
                className="h-9 rounded-lg border border-border bg-card px-3 text-sm"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
              >
                <option value="vless">vless</option>
                <option value="vmess">vmess</option>
                <option value="trojan">trojan</option>
              </select>
            </div>
            <Button type="submit">Generate &amp; assign</Button>
          </form>
          {assignError && <p className="mt-2 text-sm text-destructive">{assignError}</p>}
          {account && (
            <pre className="mt-3 overflow-auto rounded-lg bg-muted p-3 text-xs">
              {JSON.stringify(account, null, 2)}
            </pre>
          )}
          <div className="mt-3">
            <form className="flex items-end gap-3" onSubmit={(e) => unassign(e, userId)}>
              <Button variant="outline" size="sm" type="submit">
                Remove user from node
              </Button>
            </form>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
