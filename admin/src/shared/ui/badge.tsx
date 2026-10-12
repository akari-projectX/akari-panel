import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

/** Status pill: soft background, strong text; colour always comes with words (never colour alone). */
const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-px text-footnote font-medium [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-secondary text-muted-foreground",
        primary: "bg-primary-soft text-primary",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-destructive-soft text-destructive",
        info: "bg-info-soft text-info",
        outline: "text-muted-foreground ring-1 ring-inset ring-border",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type Tone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export function Badge({
  tone,
  dot,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** A coloured status dot with a soft halo (always next to a text label). */
export function Dot({
  tone,
  className,
}: {
  tone: "success" | "warning" | "danger" | "neutral" | "info";
  className?: string;
}) {
  const c = {
    success: "bg-success shadow-[0_0_0_3px_var(--success-soft)]",
    warning: "bg-warning shadow-[0_0_0_3px_var(--warning-soft)]",
    danger: "bg-destructive shadow-[0_0_0_3px_var(--destructive-soft)]",
    info: "bg-info shadow-[0_0_0_3px_var(--info-soft)]",
    neutral: "bg-faint",
  }[tone];
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", c, className)} aria-hidden="true" />;
}
