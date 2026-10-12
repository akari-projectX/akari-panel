import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";

/** Page header: large title, one line of explanation, the main actions on the right (wrap under on a phone). */
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
    <header className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="text-title2 font-bold tracking-[-0.02em] sm:text-title1">{title}</h1>
        {description && <p className="mt-1 text-body text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      {children}
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

/** Key → value list (two columns; values right-aligned on a phone). */
export function KV({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 text-right break-words sm:text-left">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Row with a title/description on the left and a control on the right (stacks on a phone). */
export function SettingRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-body font-medium">{title}</div>
        {description && <div className="mt-0.5 text-footnote text-muted-foreground">{description}</div>}
      </div>
      <div className="max-w-full shrink-0">{children}</div>
    </div>
  );
}

/** Section title inside a dialog or card. */
export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mt-5 mb-2 flex items-center justify-between gap-2 first:mt-0">
      <h3 className="text-footnote font-semibold text-muted-foreground">{children}</h3>
      {actions}
    </div>
  );
}
