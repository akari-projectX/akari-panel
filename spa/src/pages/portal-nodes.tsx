// W11: the user's node list in the portal (zh/en): name, tags, region,
// online/offline, multiplier and latency. No addresses or machine metrics
// (GET /me/nodes returns none).
import { useQuery } from "@tanstack/react-query";

import { LatencyBadge } from "../components/latency-badge";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { useT } from "../i18n";
import { get, type MyNodeStatus } from "../lib/api";
import { errorText } from "../lib/errors";

export function NodesCard() {
  const t = useT();
  const q = useQuery({
    queryKey: ["my-nodes"],
    queryFn: () => get<MyNodeStatus[]>("/me/nodes"),
    refetchInterval: 60_000,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("nodes.title")}</h2>
        </CardTitle>
        <CardDescription>{t("nodes.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isPending ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : q.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t("nodes.loadFailed", { message: errorText(q.error, t) })}
          </p>
        ) : q.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("nodes.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("nodes.colName")}</TableHead>
                <TableHead>{t("nodes.colStatus")}</TableHead>
                <TableHead title={t("nodes.rateHint")}>{t("nodes.colRate")}</TableHead>
                <TableHead>{t("nodes.colLatency")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((n, i) => (
                <TableRow key={`${n.name}-${i}`}>
                  <TableCell>
                    <span className="font-medium">{n.name}</span>
                    {n.region && <span className="ml-2 text-xs text-muted-foreground">{n.region}</span>}
                    {n.tags.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {n.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {n.online ? (
                      <Badge variant="success">{t("nodes.online")}</Badge>
                    ) : (
                      <Badge variant="outline">{t("nodes.offline")}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{t("nodes.rate", { rate: n.rate })}</TableCell>
                  <TableCell>
                    <LatencyBadge
                      ms={n.latency_ms}
                      failed={n.latency_status === "timeout"}
                      title={n.latency_measured_at ? new Date(n.latency_measured_at).toLocaleString() : undefined}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
