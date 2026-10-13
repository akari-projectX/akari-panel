// An order's status as a chip with an icon (orders page, order dialog,
// dashboard), as in the confirmed orders draft: 已付款 green check,
// 待付款 blue clock, 已退款 grey undo, 未开通 red cross, closed ones outlined.
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  LoaderCircle,
  TimerOff,
  Undo2,
  type LucideIcon,
} from "lucide-react";
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
      return [tr("已过期", "Expired"), "outline"];
    case "cancelled":
      return [tr("已取消", "Cancelled"), "outline"];
    default:
      return [tr("未知状态", "Unknown"), "neutral"];
  }
}

const ICONS: Record<string, LucideIcon> = {
  paid: CircleCheck,
  pending: Clock,
  expired: TimerOff,
  cancelled: CircleDashed,
};

function Chip({ text, tone, icon: Icon }: { text: string; tone: Tone; icon: LucideIcon }) {
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {text}
    </Badge>
  );
}

/** The order's own status (paid / pending / expired / cancelled). */
export function OrderStatus({ status }: { status: string }) {
  const tr = useTr();
  const [t, tone] = orderStatusText(status, tr);
  return <Chip text={t} tone={tone} icon={ICONS[status] ?? CircleDashed} />;
}

type OrderLike = {
  status: string;
  fulfilled_at: string | null;
  refunded_at: string | null;
  refund_request: { state: string } | null;
};

/** Paid, not fulfilled and not refunded: needs the operator. */
export const needsAttention = (o: OrderLike) => o.status === "paid" && !o.fulfilled_at && !o.refunded_at;

/**
 * One chip for the whole state, the most pressing first: refunded, refund
 * in progress, paid but not fulfilled, else the order's status.
 */
export function OrderChip({ order: o }: { order: OrderLike }) {
  const tr = useTr();
  if (o.refunded_at) return <Chip text={tr("已退款", "Refunded")} tone="neutral" icon={Undo2} />;
  if (o.refund_request?.state === "pending")
    return <Chip text={tr("退款处理中", "Refund pending")} tone="info" icon={LoaderCircle} />;
  if (needsAttention(o)) return <Chip text={tr("未开通", "Not fulfilled")} tone="danger" icon={CircleX} />;
  return <OrderStatus status={o.status} />;
}
