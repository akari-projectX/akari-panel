import { useState } from "react";

import { post, subscriptionUrl, type Me } from "../lib/api";
import { humanBytes } from "../lib/utils";
import { Button } from "../components/ui/button";
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
      <SubscriptionCard />
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
