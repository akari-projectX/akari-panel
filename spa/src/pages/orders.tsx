// R18-3: the user's order history (last 50); a pending order can be
// reopened to finish paying.
import { useQuery } from "@tanstack/react-query";

import { get } from "../lib/api";
import { yuan, type MyOrder } from "../lib/billing";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { useBillingT } from "./billing-i18n";

export function MyOrders({ onContinue }: { onContinue: (id: string) => void }) {
  const { t, locale } = useBillingT();
  const orders = useQuery({ queryKey: ["my-orders"], queryFn: () => get<MyOrder[]>("/me/orders") });
  const fmt = (s: string | null) =>
    s ? new Date(s).toLocaleString(locale === "zh" ? "zh-CN" : "en") : "—";
  const rows = orders.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("ordersTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("ordersEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colCreated")}</TableHead>
                  <TableHead>{t("colPlan")}</TableHead>
                  <TableHead>{t("colAmount")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead>{t("colPaid")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>{fmt(o.created_at)}</TableCell>
                    <TableCell>{o.plan_name}</TableCell>
                    <TableCell>¥{yuan(o.amount_cents)}</TableCell>
                    <TableCell>
                      <Badge variant={o.status === "paid" ? "default" : "secondary"}>{t(`status_${o.status}`)}</Badge>
                    </TableCell>
                    <TableCell>{fmt(o.paid_at)}</TableCell>
                    <TableCell>
                      {o.status === "pending" && (
                        <Button size="sm" variant="outline" onClick={() => onContinue(o.id)}>
                          {t("continuePay")}
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
