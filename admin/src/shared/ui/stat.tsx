// Dashboard-style building blocks (2026-10 design): KPI cards with a trend
// chip and an optional sparkline, the chart legend for card headers, soft
// icon tiles and the "row with an icon tile, a count and a chevron" used by
// lists that lead somewhere. No chart library here (first-screen safe).
import { ArrowDownRight, ArrowUpRight, ChevronRight, Minus, type LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";
import { Sparkline } from "./ring";

export type SoftTone = "primary" | "success" | "warning" | "danger" | "info" | "neutral";

const soft: Record<SoftTone, string> = {
  primary: "bg-primary-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-destructive-soft text-destructive",
  info: "bg-info-soft text-info",
  neutral: "bg-secondary text-muted-foreground",
};

/**
 * A small pill next to a KPI label: a direction arrow (up / down / flat)
 * and a short figure ("12.4%", "2 异常"). The tone says good or bad, the
 * arrow says which way; `label` is the full sentence for screen readers.
 */
export function TrendChip({
  dir,
  tone,
  children,
  label,
  className,
}: {
  dir?: "up" | "down" | "flat";
  tone?: SoftTone;
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : dir === "flat" ? Minus : null;
  const t = tone ?? (dir === "up" ? "success" : dir === "down" ? "danger" : "neutral");
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
      className={cn(
        "tnum inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-caption font-semibold whitespace-nowrap",
        soft[t],
        className,
      )}
    >
      {Icon && <Icon className="size-3" aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * KPI card: label (with an optional chip on the right), a big tabular
 * figure, one line of detail, and an optional sparkline at the bottom
 * (`spark`: the series, `sparkSlot`: its chart colour) or any `footer`.
 */
export function KpiCard({
  label,
  value,
  foot,
  chip,
  spark,
  sparkSlot = 1,
  footer,
  tone,
  className,
  ...props
}: {
  label: ReactNode;
  value: ReactNode;
  foot?: ReactNode;
  chip?: ReactNode;
  spark?: number[];
  sparkSlot?: number;
  footer?: ReactNode;
  /** Colours the figure (a negative net, servers offline). */
  tone?: "danger" | "warning";
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div className={cn("flex min-w-0 flex-col rounded-xl bg-card p-4 pb-3 shadow-card", className)} {...props}>
      <div className="flex items-center justify-between gap-2 text-footnote font-medium text-muted-foreground">
        <span className="min-w-0 truncate">{label}</span>
        {chip}
      </div>
      <div
        className={cn(
          "tnum mt-1.5 truncate text-title2 font-semibold tracking-[-0.025em] sm:text-title1",
          tone === "danger" && "text-destructive",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </div>
      {foot && <div className="mt-0.5 truncate text-footnote text-muted-foreground">{foot}</div>}
      {spark && spark.length > 1 && (
        <div className="-mx-1 mt-auto pt-2">
          <Sparkline data={spark} slot={sparkSlot} />
        </div>
      )}
      {footer && <div className="mt-auto pt-2">{footer}</div>}
    </div>
  );
}

/** A line icon on a soft tinted rounded square (lists that lead somewhere, KPI icons). */
export function IconTile({
  icon: Icon,
  tone = "neutral",
  size = "md",
  className,
}: {
  icon: LucideIcon;
  tone?: SoftTone;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        size === "sm" ? "size-6 rounded-md" : size === "lg" ? "size-9 rounded-[10px]" : "size-7 rounded-lg",
        soft[tone],
        className,
      )}
    >
      <Icon className={size === "lg" ? "size-[18px]" : "size-4"} />
    </span>
  );
}

/**
 * The inside of a row that leads to a list: icon tile, label, a count and
 * a chevron. Wrap it in the link or button (the caller owns navigation):
 * `<Link className={actionRowClass}><ActionRow …/></Link>`.
 */
export function ActionRow({
  icon,
  tone,
  label,
  count,
  detail,
}: {
  icon: LucideIcon;
  tone?: SoftTone;
  label: ReactNode;
  count?: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <>
      <IconTile icon={icon} tone={tone} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body">{label}</span>
        {detail && <span className="block truncate text-footnote text-muted-foreground">{detail}</span>}
      </span>
      {count != null && <span className="tnum text-body font-semibold">{count}</span>}
      <ChevronRight
        className="size-4 shrink-0 text-faint transition-transform duration-(--dur-hover) group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </>
  );
}

/** Classes for the link / button around an `ActionRow`. */
export const actionRowClass =
  "group flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors duration-(--dur-hover) hover:bg-accent focus-visible:bg-accent";

/**
 * A chart legend for a card header: a short line in the series colour
 * (`slot` = --chart-n), the name and an optional figure.
 */
export function Legend({
  items,
  className,
}: {
  items: { label: ReactNode; slot: number; value?: ReactNode }[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote text-muted-foreground", className)}>
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <span
            className="h-[3px] w-3 rounded-full"
            style={{ background: `var(--chart-${it.slot})` }}
            aria-hidden="true"
          />
          {it.label}
          {it.value != null && <span className="tnum font-semibold text-foreground">{it.value}</span>}
        </span>
      ))}
    </div>
  );
}
