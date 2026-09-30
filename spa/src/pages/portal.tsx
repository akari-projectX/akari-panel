import type { Me } from "../lib/api";
import { humanBytes } from "../lib/utils";
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
    </div>
  );
}
