// Form controls. Fields validate as the operator types or leaves them; the
// error sits under the field and is wired to the control (aria-invalid +
// aria-describedby through FieldContext), not only in a form-level line.
// Selects stay native <select> (keyboard, phones, e2e selectOption) styled
// as a macOS pop-up button.
import { Check, ChevronsUpDown, CircleAlert, Minus } from "lucide-react";
import { Checkbox as RCheckbox, Switch as RSwitch } from "radix-ui";
import {
  createContext,
  useContext,
  useId,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "../cn";

type FieldCtx = { errorId?: string; hintId?: string; invalid: boolean };
const FieldContext = createContext<FieldCtx | null>(null);

/** aria-* for the control inside a Field (explicit props win). */
function useFieldAria(props: { "aria-invalid"?: unknown; "aria-describedby"?: string }) {
  const f = useContext(FieldContext);
  if (!f) return {};
  return {
    "aria-invalid": (props["aria-invalid"] as boolean | undefined) ?? (f.invalid || undefined),
    "aria-describedby": props["aria-describedby"] ?? (f.errorId || f.hintId),
  };
}

const control =
  "w-full min-w-0 rounded-md bg-card px-2.5 text-body text-foreground shadow-[0_0_0_0.5px_var(--input),0_0.5px_1px_rgb(0_0_0/0.04)] placeholder:text-faint transition-shadow duration-(--dur-hover) outline-none focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--primary),0_0_0_4px_var(--ring)] aria-invalid:shadow-[0_0_0_1px_var(--destructive),0_0_0_4px_var(--destructive-soft)] disabled:opacity-50 read-only:bg-window";

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const aria = useFieldAria(props);
  return <input ref={ref} className={cn(control, "h-8 pointer-coarse:h-10", className)} {...aria} {...props} />;
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

export function Textarea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  const aria = useFieldAria(props);
  return <textarea ref={ref} className={cn(control, "min-h-20 py-2 leading-5", className)} {...aria} {...props} />;
}

/** Native select styled as a macOS pop-up button (double chevron). */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const aria = useFieldAria(props);
  return (
    <div className={cn("relative min-w-0", className)}>
      <select
        className={cn(control, "h-8 cursor-default appearance-none pr-8 pointer-coarse:h-10")}
        {...aria}
        {...props}
      >
        {children}
      </select>
      <ChevronsUpDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-faint"
      />
    </div>
  );
}

/**
 * A labelled field: label above, hint or error below. The error is linked to
 * the control (aria-invalid, aria-describedby). `group` = several controls
 * (segmented buttons, radios): a labelled group instead of a <label>.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  group,
  required,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  group?: boolean;
  required?: boolean;
}) {
  const id = useId();
  const errorId = error ? `${id}-err` : undefined;
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const foot = error ? (
    <span id={errorId} className="flex items-center gap-1 text-footnote text-destructive">
      <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      {error}
    </span>
  ) : (
    hint && (
      <span id={hintId} className="block text-footnote text-faint">
        {hint}
      </span>
    )
  );
  const title = (
    <span id={`${id}-label`} className="block text-footnote font-medium text-muted-foreground">
      {label}
      {required && (
        <span className="ml-0.5 text-destructive" aria-hidden="true">
          *
        </span>
      )}
    </span>
  );
  return (
    <FieldContext.Provider value={{ errorId, hintId, invalid: !!error }}>
      {group ? (
        <div role="group" aria-labelledby={`${id}-label`} className={cn("grid content-start gap-1.5", className)}>
          {title}
          {children}
          {foot}
        </div>
      ) : (
        <label className={cn("grid content-start gap-1.5", className)}>
          {title}
          {children}
          {foot}
        </label>
      )}
    </FieldContext.Provider>
  );
}

/** macOS switch (role=switch). `label` names it when there is no visible label. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
  className,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={(v) => onChange?.(v)}
      aria-label={label}
      disabled={disabled}
      className={cn(
        "peer hit-44 inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full bg-[color-mix(in_srgb,var(--foreground)_16%,transparent)] p-[2px] transition-colors duration-(--dur-hover) focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 data-[state=checked]:bg-primary",
        className,
      )}
    >
      <RSwitch.Thumb className="block size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25),0_0_0_0.5px_rgb(0_0_0/0.04)] transition-transform duration-(--dur-fast) ease-(--ease-spring) data-[state=checked]:translate-x-4" />
    </RSwitch.Root>
  );
}

/**
 * A switch with its label and description in one row: the whole row is the
 * label (a click on the text toggles), the text names the switch.
 */
export function SwitchField({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start justify-between gap-4 py-1", className)}>
      <label htmlFor={id} className="min-w-0 flex-1 cursor-default">
        <span className="block text-body font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-footnote text-muted-foreground">{description}</span>}
      </label>
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange?: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <RCheckbox.Root
      id={id}
      checked={indeterminate ? "indeterminate" : checked}
      onCheckedChange={() => onChange?.(!checked)}
      // A clickable row around the box must not see its clicks.
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      disabled={disabled}
      className="peer hit-44 inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-card shadow-[0_0_0_0.5px_var(--input),0_0.5px_1px_rgb(0_0_0/0.06)] transition-colors focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:shadow-none data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground"
    >
      <RCheckbox.Indicator className="pointer-events-none flex items-center justify-center">
        {indeterminate ? (
          <Minus className="size-3 stroke-[3]" aria-hidden="true" />
        ) : (
          <Check className="size-3 stroke-[3]" aria-hidden="true" />
        )}
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

/** Segmented control (macOS): filters, ranges, view switches. Toggle buttons (aria-pressed). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  className,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; count?: number }[];
  size?: "sm" | "md";
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-0.5 overflow-x-auto rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] p-0.5 [scrollbar-width:none]",
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-(--dur-hover)",
              size === "sm" ? "h-6 text-footnote pointer-coarse:h-8" : "h-7 text-body pointer-coarse:h-9",
              on
                ? "bg-segment-active text-foreground shadow-[0_0_0_0.5px_rgb(0_0_0/0.06),0_1px_3px_rgb(0_0_0/0.1)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
            {o.count !== undefined && <span className="tnum text-caption text-faint">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Kbd({
  children,
  className,
  ...props
}: { children: ReactNode; className?: string } & Omit<HTMLAttributes<HTMLElement>, "children" | "className">) {
  return (
    <kbd
      {...props}
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-secondary px-1 font-sans text-caption font-medium text-muted-foreground shadow-[inset_0_-0.5px_0_var(--input)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere (shortcut hints). */
export const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
