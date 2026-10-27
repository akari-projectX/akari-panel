// Coupons (CPN-*): API types, the rule sentences shared by the list, the
// preview and the detail ("新用户首单 8 折 · 满 ¥30 可用 · 仅年付"), the
// validity text ("还剩 19 天 · 至 10月31日"), the code pill, the ticket
// preview and the multi-select chips (proposal-v2 §3, prototype
// pages/coupons.tsx + coupons-dialogs.tsx).
import { TicketPercent } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../shared/cn";
import { dateOnly, siteToday, yuan } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { periodLabel } from "../terms";
import type { PlanView } from "../types";
import type { CouponState } from "./status";

export type Coupon = {
  id: string;
  code: string;
  name: string;
  kind: "percent" | "fixed";
  value: number;
  plan_ids: string[] | null;
  periods: string[] | null;
  min_amount_cents: number;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  per_user_limit: number | null;
  new_users_only: boolean;
  enabled: boolean;
  used: number;
  redeemed: number;
  /** Redemptions (paid orders) in the last 7 days. */
  redeemed_7d: number;
  /** Discount of the redeemed orders, in fen. */
  discount_cents_total: number;
  created_at: string;
};

export type Redemption = {
  order_id: string;
  out_trade_no: string;
  user_label: string;
  user_email: string | null;
  status: "reserved" | "redeemed" | "released" | string;
  over_limit: boolean;
  discount_cents: number;
  order_status: string;
  plan_name: string;
  period: string;
  created_at: string;
};

type BatchTemplate = {
  kind: "percent" | "fixed";
  value: number;
  plan_ids: string[] | null;
  periods: string[] | null;
  min_amount_cents: number;
  ends_at: string | null;
  max_uses: number | null;
  per_user_limit: number | null;
  new_users_only: boolean;
  length: number;
};

export type Batch = {
  id: string;
  name: string;
  prefix: string;
  count: number;
  template: BatchTemplate;
  actor_label: string;
  created_at: string;
  revoked_at: string | null;
  /** Codes still in the table. */
  codes: number;
  /** Uses counted over all codes. */
  used: number;
  redeemed: number;
  /** Codes with at least one use. */
  codes_used: number;
};

/** Total / per-user limits: 1..this (coupons.rs MAX_LIMIT); empty = unlimited. */
export const MAX_LIMIT = 100_000_000;
/** Fixed discounts and minimums: at most this many fen (catalog.rs MAX_PRICE_CENTS). */
export const MAX_PRICE_YUAN = 1_000_000;
/** The unambiguous alphabet of generated codes (coupon_batches.rs ALPHABET). */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomCode(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => ALPHABET[b & 31]).join("");
}

export const batchLabel = (b: Pick<Batch, "name" | "prefix">, tr: Tr) =>
  b.name || b.prefix || tr("未命名批次", "Unnamed batch");

/** "8 折" / "立减 ¥8.00" / "免费" (percent = share of the list price taken off). */
export function discountLabel(kind: "percent" | "fixed", value: number, tr: Tr): string {
  if (kind === "fixed") return tr(`立减 ${yuan(value)}`, `${yuan(value)} off`);
  if (value >= 100) return tr("免费", "Free");
  return tr(`${(100 - value) / 10} 折`, `${value}% off`);
}

/** Whole yuan when there are no fen ("¥30"), else two decimals. */
function yuanShort(cents: number): string {
  return cents % 100 ? yuan(cents) : `¥${(cents / 100).toLocaleString("en")}`;
}

type Rules = {
  kind: "percent" | "fixed";
  value: number;
  min_amount_cents: number;
  plan_ids: string[] | null;
  periods: string[] | null;
  new_users_only: boolean;
};

/** The rule sentence parts: discount, minimum, plans, periods. */
export function ruleParts(c: Rules, plans: PlanView[] | undefined, tr: Tr): string[] {
  const planName = (id: string) => plans?.find((p) => p.id === id)?.name ?? tr("已删除的套餐", "deleted plan");
  return [
    (c.new_users_only ? tr("新用户首单 ", "New customers: ") : "") + discountLabel(c.kind, c.value, tr),
    c.min_amount_cents ? tr(`满 ${yuanShort(c.min_amount_cents)} 可用`, `over ${yuanShort(c.min_amount_cents)}`) : null,
    c.plan_ids?.length
      ? tr(`仅${c.plan_ids.map(planName).join(tr("、", ", "))}`, `only ${c.plan_ids.map(planName).join(", ")}`)
      : null,
    c.periods?.length
      ? tr(
          `仅${c.periods.map((p) => periodLabel(p, tr)).join("/")}`,
          `only ${c.periods.map((p) => periodLabel(p, tr)).join("/")}`,
        )
      : null,
  ].filter((x): x is string => !!x);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "10月31日" / "Oct 31" of a site day (YYYY-MM-DD). */
export function mdOf(day: string, tr: Tr): string {
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  if (!m || !d) return "—";
  return tr(`${m}月${d}日`, `${MONTHS[m - 1]} ${d}`);
}

/** Site days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(b) - t(a)) / 86_400_000);
}

/** Validity as a sentence and a sub-line; `warn` = live and ending within 3 days. */
export function windowText(
  c: Pick<Coupon, "starts_at" | "ends_at" | "created_at">,
  s: CouponState,
  tr: Tr,
): { t: string; sub: string; warn?: boolean } {
  const today = siteToday();
  const start = c.starts_at ? dateOnly(c.starts_at) : null;
  const end = c.ends_at ? dateOnly(c.ends_at) : null;
  if (s === "scheduled" && start) {
    const n = daysBetween(today, start);
    return {
      t:
        n <= 0
          ? tr("今天开始", "Starts today")
          : n === 1
            ? tr("明天开始", "Starts tomorrow")
            : tr(`${n} 天后开始`, `Starts in ${n} days`),
      sub: end ? `${mdOf(start, tr)} – ${mdOf(end, tr)}` : tr(`${mdOf(start, tr)} 起长期`, `from ${mdOf(start, tr)}`),
    };
  }
  if (!end) {
    const from = start ?? dateOnly(c.created_at);
    return { t: tr("长期有效", "No end date"), sub: tr(`${mdOf(from, tr)} 起`, `since ${mdOf(from, tr)}`) };
  }
  if (c.ends_at && Date.parse(c.ends_at) <= Date.now())
    return { t: tr("已过期", "Expired"), sub: tr(`${mdOf(end, tr)} 结束`, `ended ${mdOf(end, tr)}`) };
  const left = daysBetween(today, end);
  return {
    t: left <= 0 ? tr("今天结束", "Ends today") : tr(`还剩 ${left} 天`, `${left} days left`),
    sub: tr(`至 ${mdOf(end, tr)}`, `until ${mdOf(end, tr)}`),
    warn: left <= 3 && s === "live",
  };
}

/** The pink monospace code pill (AUTUMN20). */
export function CodePill({ code, className }: { code: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--chart-5)_12%,transparent)] px-2 py-0.5 font-mono text-footnote font-semibold tracking-wide text-[color-mix(in_srgb,var(--chart-5),var(--foreground)_35%)]",
        className,
      )}
    >
      <TicketPercent className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{code}</span>
    </span>
  );
}

/** The ticket preview: big discount left, rules right, the code strip below. */
export function CouponTicket({
  code,
  name,
  kind,
  value,
  rules,
  window,
  uses,
  valid,
}: {
  code: string;
  name: string;
  kind: "percent" | "fixed";
  value: number | null;
  rules: string[];
  window: string;
  uses: string;
  valid: boolean;
}) {
  const tr = useTr();
  const lang = useLang();
  let big: ReactNode = "—";
  if (value != null)
    big =
      kind === "percent" ? (
        value >= 100 ? (
          tr("免费", "Free")
        ) : lang === "en" ? (
          <>
            {value}
            <span className="ml-0.5 text-title3">%</span>
          </>
        ) : (
          <>
            {(100 - value) / 10}
            <span className="ml-0.5 text-title3">{tr("折", "%")}</span>
          </>
        )
      ) : (
        <>
          <span className="text-title3">¥</span>
          {(value / 100).toFixed(value % 100 ? 2 : 0)}
        </>
      );
  return (
    <div
      aria-label={tr("优惠券预览", "Coupon preview")}
      role="img"
      className="relative overflow-hidden rounded-2xl bg-[linear-gradient(135deg,var(--chart-5),var(--chart-7))] text-white shadow-raised"
    >
      <div className="flex">
        <div className="flex w-[42%] flex-col justify-center px-4 py-5">
          <div className="text-caption font-medium opacity-80">
            {kind === "percent" ? tr("折扣", "Discount") : tr("立减", "Off")}
          </div>
          <div className="tnum mt-0.5 text-title1 leading-none font-bold tracking-[-0.02em]">{big}</div>
        </div>
        <div className="relative border-l-2 border-dashed border-white/40">
          <span className="absolute -top-2 -left-[9px] size-4 rounded-full bg-card" />
          <span className="absolute -bottom-2 -left-[9px] size-4 rounded-full bg-card" />
        </div>
        <div className="min-w-0 flex-1 px-4 py-4">
          <div className="truncate text-body font-semibold">{name || tr("未命名优惠券", "Unnamed coupon")}</div>
          <div className="mt-1 text-footnote leading-5 opacity-90">
            {rules.length > 1 ? rules.slice(1).join(" · ") : tr("全部套餐与周期可用", "Every plan and period")}
          </div>
          <div className="mt-2 text-caption opacity-75">
            {window} · {uses}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between bg-(--scrim) px-4 py-2">
        <span className={cn("truncate font-mono text-callout font-semibold tracking-[0.12em]", !valid && "opacity-60")}>
          {code || tr("代码", "CODE")}
        </span>
        <TicketPercent className="size-4 shrink-0 opacity-70" aria-hidden="true" />
      </div>
    </div>
  );
}

/** "全部" chip + toggle chips (plans, periods); [] = all. */
export function MultiChips<T extends string>({
  all,
  value,
  onChange,
  items,
  label,
}: {
  all: string;
  value: T[];
  onChange: (v: T[]) => void;
  items: { value: T; label: string }[];
  label: string;
}) {
  const chip = (on: boolean) =>
    cn(
      "hit-44 inline-flex h-8 items-center rounded-full px-3 text-body font-medium transition-colors",
      on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground",
    );
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      <button
        type="button"
        aria-pressed={value.length === 0}
        className={chip(value.length === 0)}
        onClick={() => onChange([])}
      >
        {all}
      </button>
      {items.map((it) => {
        const on = value.includes(it.value);
        return (
          <button
            type="button"
            key={it.value}
            aria-pressed={on}
            className={chip(on)}
            onClick={() => onChange(on ? value.filter((v) => v !== it.value) : [...value, it.value])}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
