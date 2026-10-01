import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { del, get, patch, post, put, type PlanView, type UserView } from "../lib/api";
import { humanBytes } from "../lib/utils";
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

export function AdminUsers() {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => get<UserView[]>("/users") });
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
  const [planFor, setPlanFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subToken, setSubToken] = useState<{ login: string; token: string } | null>(null);
  const [enrollCode, setEnrollCode] = useState<{ login: string; code: string } | null>(null);

  async function regenerate(u: UserView) {
    setError(null);
    try {
      const res = await post<{ sub_token: string }>(`/users/${u.id}/sub-token`, undefined);
      setSubToken({ login: u.login, token: res.sub_token });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Token failed");
    }
  }

  async function resetTotp(u: UserView) {
    if (
      !window.confirm(
        `Reset two-factor authentication of "${u.login}"? Their sessions end` +
          (u.role === "admin" ? " and they must enroll again at the next login." : "."),
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await del<{ totp_enrollment_code: string | null }>(`/users/${u.id}/totp`);
      if (res?.totp_enrollment_code) {
        setEnrollCode({ login: u.login, code: res.totp_enrollment_code });
      }
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    }
  }

  async function toggle(u: UserView) {
    setError(null);
    try {
      await patch(`/users/${u.id}`, { enabled: !u.enabled });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function remove(u: UserView) {
    setError(null);
    try {
      await del(`/users/${u.id}`);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  return (
    <div className="space-y-6">
      <CreateUser
        onSubToken={(login, token) => setSubToken({ login, token })}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {enrollCode && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              2FA enrollment code for <span className="font-medium">{enrollCode.login}</span> — shown
              once, valid 24 h. Hand it over on a separate channel; it is required to set up the
              authenticator again:
            </p>
            <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-sm tracking-wider">
              {enrollCode.code}
            </pre>
          </CardContent>
        </Card>
      )}
      {subToken && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Subscription token for <span className="font-medium">{subToken.login}</span> — shown
              once, store it now:
            </p>
            <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-xs">{subToken.token}</pre>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>Accounts, roles and traffic usage.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Login</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Traffic</TableHead>
                <TableHead>Resets</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>2FA</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(users.data ?? []).map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.login}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{u.role}</Badge>
                  </TableCell>
                  <TableCell>
                    {u.plan_name ? <Badge variant="secondary">{u.plan_name}</Badge> : <span className="text-muted-foreground">—</span>}
                    {planFor === u.id && (
                      <UserPlanForm
                        user={u}
                        plans={plans.data ?? []}
                        onDone={() => setPlanFor(null)}
                        onError={setError}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    {humanBytes(u.traffic_used_bytes)}
                    {u.traffic_limit_bytes != null && ` / ${humanBytes(u.traffic_limit_bytes)}`}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.next_reset_at ? new Date(u.next_reset_at).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.expires_at ? new Date(u.expires_at).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    {u.enabled ? (
                      <Badge variant="success">enabled</Badge>
                    ) : (
                      <Badge variant="destructive">
                        {u.disabled_reason ? `disabled (${u.disabled_reason})` : "disabled"}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {u.totp_enabled ? (
                      <Badge variant="success">on</Badge>
                    ) : (
                      <Badge variant={u.role === "admin" ? "destructive" : "secondary"}>off</Badge>
                    )}
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    {u.role === "user" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPlanFor(planFor === u.id ? null : u.id)}
                      >
                        Plan
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => regenerate(u)}>
                      Sub token
                    </Button>
                    {u.totp_enabled ? (
                      <Button variant="outline" size="sm" onClick={() => resetTotp(u)}>
                        Reset 2FA
                      </Button>
                    ) : (
                      u.role === "admin" && (
                        // An admin without 2FA (e.g. promoted, or the code
                        // expired) needs a fresh one-time enrollment code.
                        <Button variant="outline" size="sm" onClick={() => resetTotp(u)}>
                          2FA code
                        </Button>
                      )
                    )}
                    <Button variant="outline" size="sm" onClick={() => toggle(u)}>
                      {u.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => remove(u)}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function CreateUser({
  onSubToken,
}: {
  onSubToken: (login: string, token: string) => void;
}) {
  const queryClient = useQueryClient();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [limitGb, setLimitGb] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    const body: Record<string, unknown> = { login, password };
    const gb = Number(limitGb);
    if (Number.isFinite(gb) && gb > 0) body.traffic_limit_bytes = Math.round(gb * 1024 ** 3);
    try {
      const u = await post<UserView & { sub_token: string }>("/users", body);
      setCreated(`created ${u.login} (sub token below)`);
      onSubToken(u.login, u.sub_token);
      setLogin("");
      setPassword("");
      setLimitGb("");
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New user</CardTitle>
        <CardDescription>Traffic limit is optional (GiB).</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="nu-login">Login</Label>
            <Input id="nu-login" value={login} onChange={(e) => setLogin(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-password">Password</Label>
            <Input
              id="nu-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-limit">Limit (GiB)</Label>
            <Input
              id="nu-limit"
              type="number"
              min="0"
              value={limitGb}
              onChange={(e) => setLimitGb(e.target.value)}
            />
          </div>
          <Button type="submit">Create</Button>
        </form>
        {(error || created) && (
          <p className={`mt-3 text-sm ${error ? "text-destructive" : "text-emerald-600"}`}>
            {error ?? created}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Assign / change / cancel a user's plan. Assigning replaces the active
// plan; the user's node access, quota and expiry follow the plan.
export function UserPlanForm({
  user,
  plans,
  onDone,
  onError,
}: {
  user: UserView;
  plans: PlanView[];
  onDone: () => void;
  onError: (e: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const offered = plans.filter((p) => p.enabled || p.id === user.plan_id);
  const [planId, setPlanId] = useState(user.plan_id ?? offered[0]?.id ?? "");
  const [expires, setExpires] = useState("");
  const [resetTraffic, setResetTraffic] = useState(false);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["users"] }),
      queryClient.invalidateQueries({ queryKey: ["plans"] }),
    ]);
    onDone();
  }

  async function assign(e: React.FormEvent) {
    e.preventDefault();
    onError(null);
    const body: Record<string, unknown> = { plan_id: planId };
    if (expires) body.expires_at = new Date(`${expires}T00:00:00Z`).toISOString();
    if (resetTraffic) body.reset_traffic = true;
    try {
      await put(`/users/${user.id}/plan`, body);
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Assign failed");
    }
  }

  async function cancel() {
    if (!window.confirm(`Cancel the plan of "${user.login}"? Their plan nodes are removed.`)) return;
    onError(null);
    try {
      await del(`/users/${user.id}/plan`);
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  return (
    <form className="mt-2 space-y-2" onSubmit={assign} aria-label={`Plan of ${user.login}`}>
      <select
        aria-label="Plan"
        className="h-9 rounded-lg border border-border bg-card px-2 text-sm"
        value={planId}
        onChange={(e) => setPlanId(e.target.value)}
      >
        {offered.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="space-y-1">
        <Label htmlFor={`up-exp-${user.id}`}>Expires (UTC date, optional)</Label>
        <Input id={`up-exp-${user.id}`} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </div>
      <label className="flex items-center gap-1.5 text-sm">
        <input type="checkbox" checked={resetTraffic} onChange={(e) => setResetTraffic(e.target.checked)} />
        Reset usage
      </label>
      <div className="space-x-2">
        <Button type="submit" size="sm" disabled={!planId}>
          {user.plan_id ? "Change plan" : "Assign plan"}
        </Button>
        {user.plan_id && (
          <Button type="button" variant="destructive" size="sm" onClick={cancel}>
            Cancel plan
          </Button>
        )}
      </div>
    </form>
  );
}
