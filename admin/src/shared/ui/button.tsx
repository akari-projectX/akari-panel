// Buttons (shadcn style on radix-ui, copied — R23: nothing is imported from
// the portal). macOS look: solid primary, light-grey secondary, outline on
// cards; a slight press scale. On touch screens every size grows to a
// 40px+ target (the icon sizes also get a 44px hit area).
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, Ref } from "react";
import { cn } from "../cn";

export const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[background-color,color,box-shadow,scale,filter] duration-(--dur-hover) active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25),0_1px_2px_rgb(0_0_0/0.12)] hover:brightness-110",
        secondary: "bg-secondary text-foreground hover:bg-[color-mix(in_srgb,var(--secondary),var(--foreground)_6%)]",
        outline: "bg-card text-foreground shadow-card hover:bg-accent",
        ghost: "text-foreground hover:bg-accent",
        soft: "bg-primary-soft text-primary hover:bg-[color-mix(in_srgb,var(--primary-soft),var(--primary)_8%)]",
        destructive:
          "bg-destructive text-white shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25),0_1px_2px_rgb(0_0_0/0.12)] hover:brightness-110 dark:text-[#1a0606]",
        "destructive-soft": "bg-destructive-soft text-destructive hover:brightness-95",
        link: "h-auto px-0 text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        sm: "h-7 rounded-sm px-2.5 text-footnote pointer-coarse:h-9 [&_svg]:size-3.5",
        md: "h-8 rounded-md px-3 text-body pointer-coarse:h-10 [&_svg]:size-4",
        lg: "h-10 rounded-[11px] px-4 text-callout [&_svg]:size-4",
        icon: "hit-44 size-8 rounded-md pointer-coarse:size-10 [&_svg]:size-4",
        "icon-sm": "hit-44 size-7 rounded-sm pointer-coarse:size-9 [&_svg]:size-3.5",
        pill: "h-8 rounded-full px-3.5 text-body pointer-coarse:h-10 [&_svg]:size-4",
      },
    },
    compoundVariants: [{ variant: "link", className: "h-auto px-0 pointer-coarse:h-auto" }],
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    icon?: LucideIcon;
    /** Spinner instead of the icon; the button is disabled meanwhile. */
    loading?: boolean;
    asChild?: boolean;
    ref?: Ref<HTMLButtonElement>;
  };

export function Button({
  className,
  variant,
  size,
  icon: Icon,
  loading,
  disabled,
  children,
  asChild,
  type = "button",
  ...props
}: ButtonProps) {
  if (asChild)
    return (
      <Slot.Root className={cn(buttonVariants({ variant, size }), className)} {...props}>
        {children}
      </Slot.Root>
    );
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : Icon && <Icon aria-hidden="true" />}
      {children}
    </button>
  );
}

/** A link that looks like a button (downloads, external pages, in-app links). */
export function ButtonLink({
  className,
  variant,
  size,
  icon: Icon,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & VariantProps<typeof buttonVariants> & { icon?: LucideIcon }) {
  return (
    <a className={cn(buttonVariants({ variant, size }), className)} {...props}>
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </a>
  );
}
