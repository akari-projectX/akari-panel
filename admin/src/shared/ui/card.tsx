import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

/** Content surface: white on the grey window, a 0.5px ring instead of a border. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl bg-card text-card-foreground shadow-card", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  actions,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start gap-3 px-4 pt-3.5 pb-2", className)}>
      {icon}
      <div className="min-w-0 flex-1">
        <h3 className="text-headline font-semibold tracking-[-0.01em]">{title}</h3>
        {description && <p className="mt-0.5 text-footnote text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** System-settings style group: rounded list, hairline separators, label left / control right. */
export function Group({
  title,
  footer,
  children,
  className,
}: {
  title?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("grid gap-1.5", className)}>
      {title && <h3 className="px-1 text-footnote font-semibold text-muted-foreground">{title}</h3>}
      <div className="divide-y divide-separator overflow-hidden rounded-xl bg-card shadow-card">{children}</div>
      {footer && <p className="px-1 text-footnote text-faint">{footer}</p>}
    </section>
  );
}

/** A settings row: label + description on the left, the control on the right (stacks on a phone). */
export function Row({
  label,
  description,
  children,
  icon,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5", className)}>
      {icon}
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-body font-medium">{label}</div>
        {description && <div className="mt-0.5 text-footnote text-muted-foreground">{description}</div>}
      </div>
      {children && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** System-settings style coloured icon tile (white line icon on a gradient square). */
export function Tile({ color, children, size = 22 }: { color: string; children: ReactNode; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-[6px] text-white shadow-[inset_0_0.5px_0_rgb(255_255_255/0.35)] [&_svg]:size-[62%] [&_svg]:stroke-[2.2]"
      style={{
        background: `linear-gradient(180deg, color-mix(in srgb, ${color}, white 14%), ${color})`,
        width: size,
        height: size,
      }}
    >
      {children}
    </span>
  );
}
