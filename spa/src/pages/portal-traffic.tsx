// W22: the user's traffic history in the portal (zh/en): daily bars and a
// per-node breakdown. GET /me/traffic returns the caller's own rows only,
// node names only (no ids); hidden or deleted nodes come as one unnamed row.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { BarChart } from "../components/bar-chart";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { useT } from "../i18n";
import { get } from "../lib/api";
import { errorText } from "../lib/errors";
import { fillDays, lastDays, type MyTraffic } from "../lib/traffic";
import { humanBytes } from "../lib/utils";

export const TRAFFIC_RANGES = [7, 30, 90] as const;

export function TrafficCard() {
  const t = useT();
  const [days, setDays] = useState<number>(30);
  const { from, to } = lastDays(days);
  const q = useQuery({
    queryKey: ["my-traffic", from, to],
    queryFn: () => get<MyTraffic>(`/me/traffic?from=${from}&to=${to}`),
    refetchInterval: 60_000,
  });
  const filled = q.data ? fillDays(q.data.days, q.data.from, q.data.to) : [];
  const any = (q.data?.days.length ?? 0) > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("traffic.title")}</h2>
        </CardTitle>
        <CardDescription>{t("traffic.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("traffic.range")}>
          {TRAFFIC_RANGES.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === days ? "default" : "outline"}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
            >
              {t("traffic.lastDays", { days: d })}
            </Button>
          ))}
        </div>
        {q.isPending ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : q.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t("traffic.loadFailed", { message: errorText(q.error, t) })}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">{t("traffic.upload")}</p>
                <p className="font-semibold tabular-nums">{humanBytes(q.data.total.up_bytes)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">{t("traffic.download")}</p>
                <p className="font-semibold tabular-nums">{humanBytes(q.data.total.down_bytes)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">{t("traffic.billed")}</p>
                <p className="font-semibold tabular-nums">{humanBytes(q.data.total.billed_bytes)}</p>
              </div>
            </div>
            {any ? (
              <BarChart
                title={t("traffic.daily")}
                labels={filled.map((d) => d.day.slice(5))}
                series={[
                  {
                    label: t("traffic.download"),
                    values: filled.map((d) => d.down_bytes),
                    fill: "fill-sky-500",
                    swatch: "bg-sky-500",
                  },
                  {
                    label: t("traffic.upload"),
                    values: filled.map((d) => d.up_bytes),
                    fill: "fill-emerald-500",
                    swatch: "bg-emerald-500",
                  },
                ]}
                format={humanBytes}
                empty={t("traffic.empty")}
                describe={t("traffic.chartSummary", {
                  from: q.data.from,
                  to: q.data.to,
                  total: humanBytes(q.data.total.up_bytes + q.data.total.down_bytes),
                })}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("traffic.empty")}</p>
            )}
            {q.data.nodes.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("traffic.colNode")}</TableHead>
                    <TableHead className="text-right">{t("traffic.upload")}</TableHead>
                    <TableHead className="text-right">{t("traffic.download")}</TableHead>
                    <TableHead className="text-right">{t("traffic.billed")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.nodes.map((n, i) => (
                    <TableRow key={`${n.name ?? ""}-${i}`}>
                      <TableCell className="font-medium">{n.name ?? t("traffic.otherNodes")}</TableCell>
                      <TableCell className="text-right tabular-nums">{humanBytes(n.up_bytes)}</TableCell>
                      <TableCell className="text-right tabular-nums">{humanBytes(n.down_bytes)}</TableCell>
                      <TableCell className="text-right tabular-nums">{humanBytes(n.billed_bytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="text-xs text-muted-foreground">{t("traffic.note")}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
