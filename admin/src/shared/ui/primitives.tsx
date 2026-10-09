import { cva, type VariantProps } from "class-variance-authority";
import { useId } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "../cn";
import { errorCode, errorText } from "../errors";
import { useLang, useTr } from "../i18n";
import { Icon, type IconName } from "./icons";

/* ---------- Button ---------- */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 select-none",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-card",
        secondary: "bg-card text-foreground border border-border hover:bg-muted shadow-card",
        ghost: "text-foreground hover:bg-muted",
        soft: "bg-primary-soft text-primary hover:bg-primary-soft/70",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-card",
        "destructive-soft": "text-destructive hover:bg-destructive-soft",
        link: "text-primary underline-offset-4 hover:underline px-0 h-auto",
      },
      size: {
        sm: "h-8 px-2.5 text-[13px]",
        md: "h-9 px-3.5",
        lg: "h-10 px-4",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  icon,
  loading,
  disabled,
  children,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { icon?: IconName; loading?: boolean }) {
  const s = size === "sm" || size === "icon-sm" ? 14 : 16;
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Icon name="refresh" size={s} className="animate-spin" /> : icon && <Icon name={icon} size={s} />}
      {children}
    </button>
  );
}

/* ---------- Badge ---------- */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-muted-foreground",
        primary: "bg-primary-soft text-primary",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-destructive-soft text-destructive",
        info: "bg-info-soft text-info",
        outline: "border border-border text-muted-foreground",
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
}: {
  tone?: Tone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn(badgeVariants({ tone }), className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/* ---------- Card ---------- */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-lg border border-border bg-card text-card-foreground shadow-card", className)}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5",
        className,
      )}
    >
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-4 py-4 sm:px-5", className)}>{children}</div>;
}

/* ---------- Form controls ---------- */
const control =
  "h-9 w-full rounded-md border border-input bg-card px-3 text-sm placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/20 disabled:opacity-60";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, className)} {...props} />;
}

/**
 * Attributes of a write-only secret field (API keys, SMTP password, Turnstile
 * secret…). Browsers ignore autocomplete="off" on password inputs and would
 * fill the admin's saved console password in, which a save then stores as
 * the secret; "new-password" plus the password managers' opt-outs keep the
 * field empty unless the operator types into it.
 */
export const secretInputProps = {
  type: "password",
  autoComplete: "new-password",
  spellCheck: false,
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

export function SecretInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "autoComplete">) {
  return <Input {...secretInputProps} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "h-auto min-h-20 py-2 font-mono text-[13px]", className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn("relative", className)}>
      <select className={cn(control, "appearance-none pr-8")} {...props}>
        {children}
      </select>
      <Icon
        name="chevronDown"
        size={14}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  group,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Several controls (segmented buttons, radios): a labelled group, not a <label>. */
  group?: boolean;
}) {
  const id = useId();
  const foot = error ? (
    <span className="block text-xs text-destructive">{error}</span>
  ) : (
    hint && <span className="block text-xs text-muted-foreground">{hint}</span>
  );
  if (group)
    return (
      <div role="group" aria-labelledby={id} className={cn("block space-y-1.5", className)}>
        <span id={id} className="block text-[13px] font-medium">
          {label}
        </span>
        {children}
        {foot}
      </div>
    );
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="text-[13px] font-medium">{label}</span>
      {children}
      {foot}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange?: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      disabled={disabled}
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange?.(!checked);
      }}
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked || indeterminate ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card",
      )}
    >
      {/* The mark is never the click target: inside a <label>, Chromium treats a
          click on an SVG descendant as outside the control and re-dispatches it
          to the button, so a checked box clicked on its tick toggled twice. */}
      {indeterminate ? (
        <span className="pointer-events-none h-0.5 w-2 rounded bg-current" />
      ) : (
        checked && <Icon name="check" size={12} strokeWidth={3} className="pointer-events-none" />
      )}
    </button>
  );
}

/** Row with a title/description on the left and a control on the right (settings pages). */
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
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/* ---------- Segmented / Tabs ---------- */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2.5 font-medium transition-colors",
            size === "sm" ? "h-6 text-xs" : "h-7 text-[13px]",
            value === o.value ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode; count?: number }[];
}) {
  return (
    <div role="tablist" className="scroll-thin -mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            value === t.value
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ---------- Progress ---------- */
export function Progress({
  value,
  tone = "primary",
  className,
}: {
  value: number;
  tone?: "primary" | "warning" | "danger" | "success";
  className?: string;
}) {
  const color = { primary: "bg-primary", warning: "bg-warning", danger: "bg-destructive", success: "bg-success" }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function usageTone(p: number): "primary" | "warning" | "danger" {
  return p >= 100 ? "danger" : p >= 80 ? "warning" : "primary";
}

/* ---------- Loading / empty / error ---------- */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} />;
}

export function EmptyState({
  icon = "search",
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon name={icon} size={20} />
      </div>
      <div className="text-sm font-semibold">{title}</div>
      {description && <div className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ onRetry, error, detail }: { onRetry?: () => void; error?: unknown; detail?: string }) {
  const tr = useTr();
  const lang = useLang();
  const code = error ? errorCode(error) : "";
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-destructive-soft text-destructive">
        <Icon name="alert" size={20} />
      </div>
      <div className="text-sm font-semibold">{tr("加载失败", "Failed to load")}</div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">
        {detail ?? (error ? errorText(error, lang) : tr("可以稍后重试。", "Try again shortly."))}
        {code && <div className="mt-1 font-mono text-[11px]">{code}</div>}
      </div>
      {onRetry && (
        <Button className="mt-4" size="sm" icon="refresh" onClick={onRetry}>
          {tr("重试", "Retry")}
        </Button>
      )}
    </div>
  );
}

/* ---------- Misc ---------- */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </kbd>
  );
}

export function Dot({ tone }: { tone: "success" | "danger" | "warning" | "neutral" | "info" }) {
  const c = {
    success: "bg-success",
    danger: "bg-destructive",
    warning: "bg-warning",
    neutral: "bg-muted-foreground/50",
    info: "bg-info",
  }[tone];
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", c)} />;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  title?: ReactNode;
  children: ReactNode;
}) {
  const styles = {
    info: "border-info/30 bg-info-soft text-info",
    warning: "border-warning/40 bg-warning-soft text-warning",
    danger: "border-destructive/30 bg-destructive-soft text-destructive",
    success: "border-success/30 bg-success-soft text-success",
  }[tone];
  const icon: IconName = tone === "success" ? "check" : tone === "info" ? "info" : "alert";
  return (
    <div className={cn("flex gap-2.5 rounded-md border px-3 py-2.5 text-[13px]", styles)}>
      <Icon name={icon} size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 text-foreground/90">
        {title && <div className="font-medium text-foreground">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export function KV({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 text-right sm:text-left">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
