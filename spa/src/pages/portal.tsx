import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { describePeriod, get, post, subscriptionUrl, type Me, type MyPlan } from "../lib/api";
import { humanBytes } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { TwoFactorCard } from "./two-factor";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";

export function Portal({ me }: { me: Me }) {
  const limit = me.traffic_limit_bytes;
  const used = me.traffic_used_bytes;
  const pct = limit != null && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Your usage overview.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Traffic used</p>
              <p className="text-lg font-semibold">{humanBytes(used)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Traffic limit</p>
              <p className="text-lg font-semibold">{limit != null ? humanBytes(limit) : "—"}</p>
            </div>
          </div>
          {limit != null && limit > 0 && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {me.expires_at
              ? `Expires ${new Date(me.expires_at).toLocaleDateString()}`
              : "No expiry set"}
          </p>
        </CardContent>
      </Card>
      <PlanCard />
      <SubscriptionCard />
      <PasswordCard />
      <TwoFactorCard />
    </div>
  );
}

// The server keeps only a hash of the subscription token, so the link can
// only be shown when a new one is made (which also retires the old link).
function SubscriptionCard() {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function regenerate() {
    if (!window.confirm("Make a new subscription link? The current link stops working immediately.")) return;
    setError(null);
    setBusy(true);
    try {
      const res = await post<{ sub_token: string }>("/me/sub-token", {});
      setUrl(subscriptionUrl(res.sub_token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscription link</CardTitle>
        <CardDescription>
          Lost your link, or think someone else has it? Make a new one; the old one stops working.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {url && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Shown once — copy it into your client now:</p>
            <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">{url}</pre>
          </div>
        )}
        <Button variant="outline" onClick={regenerate} disabled={busy}>
          New subscription link
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString() : "—");

// The active plan, its period, and the nodes it gives access to (names and
// regions only).
export function PlanCard() {
  const q = useQuery({ queryKey: ["my-plan"], queryFn: () => get<MyPlan>("/me/plan") });
  if (q.isPending) return null;
  if (q.isError) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p role="alert" className="text-sm text-destructive">
            Could not load your plan: {q.error.message}
          </p>
        </CardContent>
      </Card>
    );
  }
  const { plan, nodes } = q.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan</CardTitle>
        <CardDescription>{plan ? plan.name : "You have no active plan."}</CardDescription>
      </CardHeader>
      {plan && (
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Quota</dt>
              <dd className="font-medium">
                {plan.traffic_quota_bytes != null ? humanBytes(plan.traffic_quota_bytes) : "Unlimited"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Traffic reset</dt>
              <dd className="font-medium">{describePeriod(plan.period)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Next reset</dt>
              <dd className="font-medium">{date(plan.next_reset_at)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Plan expires</dt>
              <dd className="font-medium">{plan.expires_at ? date(plan.expires_at) : "Never"}</dd>
            </div>
            {plan.speed_limit_mbps != null && (
              <div>
                <dt className="text-muted-foreground">Speed</dt>
                <dd className="font-medium">up to {plan.speed_limit_mbps} Mbps</dd>
              </div>
            )}
          </dl>
          <div>
            <p className="mb-2 text-sm text-muted-foreground">Nodes</p>
            {nodes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No nodes available yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {nodes.map((n) => (
                  <li key={n.name}>
                    <Badge variant="secondary">
                      {n.name}
                      {n.region ? ` · ${n.region}` : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// Change your own password (the current one is required). Other sessions
// end; this one continues.
export function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) return setMsg({ ok: false, text: "The new passwords do not match" });
    if (next.length < 8) return setMsg({ ok: false, text: "At least 8 characters" });
    setBusy(true);
    try {
      await post("/me/password", { current_password: current, new_password: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ ok: true, text: "Password changed. Your other sessions were signed out." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Change failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={submit} aria-label="Change password">
          <div className="space-y-1.5">
            <Label htmlFor="pw-current">Current password</Label>
            <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-new">New password</Label>
            <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-confirm">Repeat new password</Label>
            <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
          <Button type="submit" disabled={busy}>
            Change password
          </Button>
        </form>
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={`mt-3 text-sm ${msg.ok ? "text-emerald-600" : "text-destructive"}`}>
            {msg.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
