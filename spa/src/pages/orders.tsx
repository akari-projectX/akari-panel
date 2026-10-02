// R18-3: the user's order history (last 50); a pending order can be
// reopened to finish paying.
import { useQuery } from "@tanstack/react-query";

import { useLocale, useT } from "../i18n";
import { get } from "../lib/api";
import { STATUS_KEY, periodLabel, yuan, type MyOrder } from "../lib/billing";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

export function MyOrders({ onContinue }: { onContinue: (id: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const orders = useQuery({ queryKey: ["my-orders"], queryFn: () => get<MyOrder[]>("/me/orders") });
  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString(locale === "zh" ? "zh-CN" : "en") : "—");
  const rows = orders.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("billing.ordersTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("billing.ordersEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("billing.colCreated")}</TableHead>
                  <TableHead>{t("billing.colPlan")}</TableHead>
                  <TableHead>{t("billing.colPeriod")}</TableHead>
                  <TableHead>{t("billing.colAmount")}</TableHead>
                  <TableHead>{t("billing.colStatus")}</TableHead>
                  <TableHead>{t("billing.colPaid")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>{fmt(o.created_at)}</TableCell>
                    <TableCell>{o.plan_name}</TableCell>
                    <TableCell>{periodLabel(t, o.period, o.period_days)}</TableCell>
                    <TableCell>¥{yuan(o.amount_cents)}</TableCell>
                    <TableCell>
                      <Badge variant={o.status === "paid" ? "default" : "secondary"}>{t(STATUS_KEY[o.status])}</Badge>
                      {o.refunded_at && (
                        <Badge variant="secondary" className="ml-1">
                          {t("billing.refunded")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{fmt(o.paid_at)}</TableCell>
                    <TableCell>
                      {o.status === "pending" && (
                        <Button size="sm" variant="outline" onClick={() => onContinue(o.id)}>
                          {t("billing.continuePay")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
