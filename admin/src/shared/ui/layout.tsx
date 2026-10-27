import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";

/** Page header: large title, one line of explanation, the main actions on the right; `children` below. */
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    // Title on its own line; the actions sit at the right, beside the title
    // and its line on a desktop, beside the line on a phone (never on a row
    // of their own unless they do not fit).
    <header className="mb-5 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-4 gap-y-1">
      <h1
        className={cn(
          "text-title2 font-bold tracking-[-0.02em] sm:text-title1",
          actions && description ? "col-span-2 sm:col-span-1" : "",
        )}
      >
        {title}
      </h1>
      {description && <p className="col-start-1 text-body text-muted-foreground">{description}</p>}
      {actions && (
        <div
          className={cn(
            "col-start-2 flex max-w-[60vw] flex-wrap items-center justify-end gap-2 self-end sm:max-w-none",
            description ? "row-start-2 sm:row-span-2 sm:row-start-1" : "row-start-1",
          )}
        >
          {actions}
        </div>
      )}
      {children && <div className="col-span-2 mt-2">{children}</div>}
    </header>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const styles = {
    info: "bg-info-soft [&>svg]:text-info",
    warning: "bg-warning-soft [&>svg]:text-warning",
    danger: "bg-destructive-soft [&>svg]:text-destructive",
    success: "bg-success-soft [&>svg]:text-success",
  }[tone];
  const Icon =
    tone === "success" ? CircleCheck : tone === "info" ? Info : tone === "danger" ? CircleAlert : TriangleAlert;
  return (
    <div className={cn("flex gap-2.5 rounded-lg px-3 py-2.5 text-body", styles, className)}>
      <Icon className="mt-px size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 text-foreground/90">
        {title && <div className="font-medium text-foreground">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export type KVItem = { k: ReactNode; v: ReactNode; mono?: boolean; span?: 2 | 3 };

/**
 * Key → value facts. Tuples (`[k, v][]`): a two-column list (values
 * right-aligned on a phone). Objects (`{k, v, mono?, span?}[]`, v2): a grid,
 * small grey label over the value, `cols` 2–4 (2 on a phone).
 */
export function KV({
  items,
  cols = 3,
  className,
}: {
  items: [ReactNode, ReactNode][] | KVItem[];
  cols?: 2 | 3 | 4;
  className?: string;
}) {
  if (items.length > 0 && !Array.isArray(items[0])) {
    const g = { 2: "grid-cols-2", 3: "grid-cols-2 sm:grid-cols-3", 4: "grid-cols-2 sm:grid-cols-4" }[cols];
    return (
      <dl className={cn("grid gap-x-4 gap-y-3", g, className)}>
        {(items as KVItem[]).map((it, i) => (
          <div key={i} className={cn("min-w-0", it.span === 2 && "col-span-2", it.span === 3 && "col-span-full")}>
            <dt className="text-footnote text-muted-foreground">{it.k}</dt>
            <dd className={cn("mt-0.5 truncate text-body font-medium", it.mono && "font-mono text-footnote")}>
              {it.v}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={cn("grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body", className)}>
      {(items as [ReactNode, ReactNode][]).map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 text-right break-words sm:text-left">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Section title. Default: the small grey heading inside a dialog or card.
 * `page` (v2): a headline outside the cards, with an optional count pill
 * and links/buttons on the right (`action`).
 */
export function SectionTitle({
  children,
  actions,
  action,
  count,
  page,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  action?: ReactNode;
  count?: ReactNode;
  page?: boolean;
  className?: string;
}) {
  const right = action ?? actions;
  const pill = count !== undefined && count !== null && (
    <span className="tnum rounded-full bg-secondary px-1.5 text-footnote font-medium text-muted-foreground">
      {count}
    </span>
  );
  if (page)
    return (
      <div className={cn("mb-2 flex items-center gap-2 px-1", className)}>
        <h2 className="text-headline font-semibold tracking-[-0.01em]">{children}</h2>
        {pill}
        {right && <div className="ml-auto flex items-center gap-1">{right}</div>}
      </div>
    );
  return (
    <div className={cn("mt-5 mb-2 flex items-center justify-between gap-2 first:mt-0", className)}>
      <h3 className="flex items-center gap-2 text-footnote font-semibold text-muted-foreground">
        {children}
        {pill}
      </h3>
      {right}
    </div>
  );
}

/**
 * A one-line notice inside a page (v2 Banner): tinted strip, optional icon,
 * a bold lead-in, the text and one action on the right. Use `Callout` for
 * longer explanations.
 */
export function Banner({
  tone = "info",
  icon,
  title,
  children,
  action,
  className,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const t = {
    info: "bg-info-soft text-info",
    warning: "bg-warning-soft text-warning",
    danger: "bg-destructive-soft text-destructive",
    success: "bg-success-soft text-success",
  }[tone];
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3.5 py-2.5", t, className)}>
      {icon && (
        <span className="[&_svg]:size-4" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1 text-body">
        {title && <span className="font-semibold">{title} </span>}
        <span className="text-foreground/80">{children}</span>
      </div>
      {action}
    </div>
  );
}
