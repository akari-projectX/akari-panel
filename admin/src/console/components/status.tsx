// v2 kit: status chips (proposal-v2 §7.1 status.tsx). Colour always comes
// with words and an icon. Each chip has a pure `…State()` that derives the
// state from the API row (same precedence as the server's filters), so lists,
// filters and counts agree with the chip.
import {
  Ban,
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CircleOff,
  CircleX,
  Clock,
  Gauge,
  Hourglass,
  LoaderCircle,
  RotateCcw,
  TimerOff,
  Trash2,
  TriangleAlert,
  Undo2,
  UserX,
  type LucideIcon,
} from "lucide-react";
import type { Tr } from "../../shared/i18n";
import { useTr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import type { ServerView } from "../types";

type Chip = { label: string; tone: Tone; icon?: LucideIcon };

function StatusChip({ chip, className }: { chip: Chip; className?: string }) {
  const Icon = chip.icon;
  return (
    <Badge tone={chip.tone} dot={!Icon} className={className}>
      {Icon && <Icon aria-hidden="true" />}
      {chip.label}
    </Badge>
  );
}

/* ---------- Orders ---------- */

export type OrdState =
  | "pending"
  | "completed"
  | "unfulfilled"
  | "refunding"
  | "refund_unrecorded"
  | "partial_refund"
  | "refunded"
  | "expired"
  | "cancelled";

export type OrderLike = {
  status: string;
  amount_cents?: number;
  fulfilled_at?: string | null;
  refunded_at?: string | null;
  refund_cents?: number | null;
  refund_request?: { state: string; cents?: number } | null;
};

/**
 * The provider already refunded the order but the panel could not record it
 * (refund request state `confirmed`): the amount it confirmed, else null.
 * Only a record-only refund of exactly that amount is accepted.
 */
export function confirmedRefundCents(o: OrderLike): number | null {
  const r = o.refund_request;
  return r?.state === "confirmed" && !o.refunded_at ? (r.cents ?? 0) : null;
}

/**
 * One state for the whole order, the most pressing first: refund in
 * progress, refunded (partly when less than the amount came back), paid but
 * not fulfilled, completed; else the order's own status.
 */
export function orderState(o: OrderLike): OrdState {
  if (o.refund_request?.state === "pending") return "refunding";
  if (confirmedRefundCents(o) !== null) return "refund_unrecorded";
  if (o.refunded_at)
    return o.amount_cents != null && o.refund_cents != null && o.refund_cents < o.amount_cents
      ? "partial_refund"
      : "refunded";
  if (o.status === "paid") return o.fulfilled_at === null ? "unfulfilled" : "completed";
  if (o.status === "pending") return "pending";
  if (o.status === "expired") return "expired";
  return "cancelled";
}

function ordChip(s: OrdState, tr: Tr): Chip {
  return {
    pending: { label: tr("待支付", "Pending"), tone: "info", icon: Clock },
    completed: { label: tr("已完成", "Completed"), tone: "success", icon: CircleCheck },
    unfulfilled: { label: tr("未开通", "Not fulfilled"), tone: "danger", icon: CircleX },
    refunding: { label: tr("退款中", "Refunding"), tone: "warning", icon: LoaderCircle },
    refund_unrecorded: { label: tr("待登记退款", "Record the refund"), tone: "warning", icon: Undo2 },
    partial_refund: { label: tr("部分退款", "Partly refunded"), tone: "warning", icon: Undo2 },
    refunded: { label: tr("已退款", "Refunded"), tone: "neutral", icon: Undo2 },
    expired: { label: tr("已过期", "Expired"), tone: "outline", icon: TimerOff },
    cancelled: { label: tr("已取消", "Cancelled"), tone: "outline", icon: CircleDashed },
  }[s] as Chip;
}

/** Order status chip (v2 OrdStatus): pass the row, or a state you derived. */
export function OrdStatus({ order, state, className }: { order?: OrderLike; state?: OrdState; className?: string }) {
  const tr = useTr();
  const s = state ?? (order ? orderState(order) : "cancelled");
  return <StatusChip chip={ordChip(s, tr)} className={className} />;
}

/* ---------- Users ---------- */

export type UserState = "active" | "expired" | "exhausted" | "banned" | "none" | "deleted";

export type UserLike = {
  role: string;
  enabled: boolean;
  disabled_reason?: string | null;
  expires_at?: string | null;
  plan_id?: string | null;
  erased?: boolean;
};

/** Same precedence as the server's status filter: erased > banned > over quota > expired > no plan > active. */
function userState(u: UserLike, now = Date.now()): UserState {
  if (u.erased) return "deleted";
  if (!u.enabled && u.disabled_reason !== "quota") return "banned";
  if (!u.enabled) return "exhausted";
  if (u.role === "user" && u.expires_at && Date.parse(u.expires_at) <= now) return "expired";
  if (u.role === "user" && !u.plan_id) return "none";
  return "active";
}

function userChip(s: UserState, tr: Tr): Chip {
  return {
    active: { label: tr("正常", "Active"), tone: "success" },
    expired: { label: tr("已到期", "Expired"), tone: "warning", icon: Clock },
    exhausted: { label: tr("流量用尽", "Over quota"), tone: "warning", icon: Gauge },
    banned: { label: tr("已封禁", "Banned"), tone: "danger", icon: Ban },
    none: { label: tr("无套餐", "No plan"), tone: "outline", icon: RotateCcw },
    deleted: { label: tr("已注销", "Erased"), tone: "neutral", icon: UserX },
  }[s] as Chip;
}

/** User status chip (v2 UserStatus incl. 已注销). */
export function UserStatus({ user, state, className }: { user?: UserLike; state?: UserState; className?: string }) {
  const tr = useTr();
  const s = state ?? (user ? userState(user) : "active");
  return <StatusChip chip={userChip(s, tr)} className={className} />;
}

/* ---------- Coupons ---------- */

export type CouponState = "live" | "scheduled" | "expired" | "disabled" | "exhausted";

export type CouponLike = {
  enabled: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  max_uses?: number | null;
  used?: number;
};

export function couponState(c: CouponLike, now = Date.now()): CouponState {
  if (!c.enabled) return "disabled";
  if (c.ends_at && Date.parse(c.ends_at) <= now) return "expired";
  if (c.max_uses != null && (c.used ?? 0) >= c.max_uses) return "exhausted";
  if (c.starts_at && Date.parse(c.starts_at) > now) return "scheduled";
  return "live";
}

function couponChip(s: CouponState, tr: Tr): Chip {
  return {
    live: { label: tr("生效中", "Live"), tone: "success" },
    scheduled: { label: tr("未开始", "Scheduled"), tone: "info", icon: CalendarClock },
    expired: { label: tr("已过期", "Expired"), tone: "outline", icon: Hourglass },
    disabled: { label: tr("已停用", "Disabled"), tone: "neutral", icon: CircleOff },
    exhausted: { label: tr("已用完", "Used up"), tone: "warning", icon: Ban },
  }[s] as Chip;
}

export function CouponStatus({
  coupon,
  state,
  className,
}: {
  coupon?: CouponLike;
  state?: CouponState;
  className?: string;
}) {
  const tr = useTr();
  const s = state ?? (coupon ? couponState(coupon) : "live");
  return <StatusChip chip={couponChip(s, tr)} className={className} />;
}

/* ---------- Servers ---------- */

export type ServerState = "online" | "offline" | "quota" | "pending" | "deleting";

/** Same order as servers.ts `serverState`: deleting > not installed > over quota > online > offline. */
export function serverStateOf(
  s: Pick<ServerView, "deleting_at" | "enrolled" | "online" | "traffic_quota">,
): ServerState {
  if (s.deleting_at) return "deleting";
  if (!s.enrolled) return "pending";
  if (s.traffic_quota.exceeded_at) return "quota";
  return s.online ? "online" : "offline";
}

function serverChip(s: ServerState, tr: Tr): Chip {
  return {
    online: { label: tr("在线", "Online"), tone: "success" },
    offline: { label: tr("离线", "Offline"), tone: "danger" },
    quota: { label: tr("额度用尽", "Over quota"), tone: "warning", icon: TriangleAlert },
    pending: { label: tr("等待安装", "Not installed"), tone: "outline", icon: Hourglass },
    deleting: { label: tr("删除中", "Deleting"), tone: "neutral", icon: Trash2 },
  }[s] as Chip;
}

export function ServerStatus({
  server,
  state,
  className,
}: {
  server?: Pick<ServerView, "deleting_at" | "enrolled" | "online" | "traffic_quota">;
  state?: ServerState;
  className?: string;
}) {
  const tr = useTr();
  const s = state ?? (server ? serverStateOf(server) : "offline");
  return <StatusChip chip={serverChip(s, tr)} className={className} />;
}
