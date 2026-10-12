// An order's status as a word and a badge tone (orders page, dashboard).
import type { Tr } from "../../shared/i18n";
import { useTr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";

export function orderStatusText(s: string, tr: Tr): [string, Tone] {
  switch (s) {
    case "paid":
      return [tr("已付款", "Paid"), "success"];
    case "pending":
      return [tr("待付款", "Pending"), "info"];
    case "expired":
      return [tr("已过期", "Expired"), "neutral"];
    case "cancelled":
      return [tr("已取消", "Cancelled"), "neutral"];
    default:
      return [s, "neutral"];
  }
}

export function OrderStatus({ status }: { status: string }) {
  const tr = useTr();
  const [t, tone] = orderStatusText(status, tr);
  return <Badge tone={tone}>{t}</Badge>;
}
