// v2 kit: form inputs and validators shared by the console's editors
// (proposal-v2 §7.2). Numbers stay raw strings while editing and are
// validated field by field (`numErr` / `intErr`): an invalid entry is an
// error, never "unlimited", and NaN is never sent. Use inside `Field` (from
// shared/ui/form) so errors are wired to the control.
import { CircleCheck, Dices, Eye, EyeOff } from "lucide-react";
import { useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../shared/cn";
import { useTr, type Tr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { Field, Input } from "../../shared/ui/form";

export { intErr, intError, intOf, numText } from "./settings-kit";

/**
 * Error text of a number typed as a string (undefined = valid).
 * `allowEmpty`: blank is valid (the caller decides what blank means, e.g.
 * "unlimited"); `int`: whole numbers; `money`: at most two decimals.
 */
export function numErr(
  raw: string,
  tr: Tr,
  o: { min?: number; max?: number; int?: boolean; allowEmpty?: boolean; money?: boolean } = {},
): string | undefined {
  const s = raw.trim();
  if (!s) return o.allowEmpty ? undefined : tr("必填", "Required");
  const ok = o.money ? /^\d+(\.\d{1,2})?$/.test(s) : o.int ? /^\d+$/.test(s) : /^\d+(\.\d+)?$/.test(s);
  if (!ok)
    return o.money
      ? tr("请输入金额，最多两位小数", "Enter an amount with at most two decimals")
      : o.int
        ? tr("请输入整数", "Enter a whole number")
        : tr("请输入数字", "Enter a number");
  const n = Number(s);
  if (o.min != null && n < o.min) return tr(`不能小于 ${o.min}`, `Must be at least ${o.min}`);
  if (o.max != null && n > o.max)
    return tr(`不能大于 ${o.max.toLocaleString("zh-CN")}`, `Must be at most ${o.max.toLocaleString("en")}`);
  return undefined;
}

/**
 * An input with a prefix ("¥") and/or a suffix ("GB", "Mbps", "次") drawn
 * inside the box. Takes every input prop (aria wiring from Field applies).
 */
export function AffixInput({
  prefix,
  suffix,
  className,
  inputClassName,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  prefix?: ReactNode;
  suffix?: ReactNode;
  inputClassName?: string;
}) {
  const long = typeof suffix === "string" && suffix.length > 2;
  return (
    <div className={cn("relative min-w-0", className)}>
      {prefix && (
        <span
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-body text-faint"
          aria-hidden="true"
        >
          {prefix}
        </span>
      )}
      <Input
        inputMode="decimal"
        className={cn(
          "tnum",
          prefix ? "pl-6" : undefined,
          suffix ? (long ? "pr-14" : "pr-10") : undefined,
          inputClassName,
        )}
        {...props}
      />
      {suffix && (
        <span
          className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-footnote text-faint"
          aria-hidden="true"
        >
          {suffix}
        </span>
      )}
    </div>
  );
}

/** A narrow right-aligned number box with a unit (settings rows, thresholds). */
export function UnitInput({
  unit,
  className,
  invalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { unit?: string; invalid?: boolean }) {
  return (
    <AffixInput
      suffix={unit}
      inputMode="numeric"
      className={cn("w-28", className)}
      inputClassName="text-right"
      aria-invalid={invalid || props["aria-invalid"] || undefined}
      {...props}
    />
  );
}

/**
 * Radio cards (refund destination, billing mode, protocol template): one
 * line of explanation more than a select; use for ≤ 4 options. `disabled`
 * replaces the description with the reason.
 */
export function RadioCards<T extends string>({
  value,
  onChange,
  items,
  cols = 3,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; title: ReactNode; desc?: ReactNode; icon?: ReactNode; disabled?: ReactNode }[];
  cols?: 1 | 2 | 3 | 4;
  label?: string;
}) {
  const grid = { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" }[cols];
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid gap-2", grid)}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={!!it.disabled}
            onClick={() => onChange(it.value)}
            className={cn(
              "relative flex min-h-11 items-start gap-2.5 rounded-lg bg-card p-3 text-left shadow-[0_0_0_0.5px_var(--input)] transition-shadow disabled:opacity-55",
              on && "shadow-[0_0_0_1.5px_var(--primary),0_0_0_4px_var(--ring)]",
            )}
          >
            {it.icon && (
              <span
                className={cn("mt-px [&_svg]:size-4", on ? "text-primary" : "text-muted-foreground")}
                aria-hidden="true"
              >
                {it.icon}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-body font-semibold">{it.title}</span>
              {(it.disabled || it.desc) && (
                <span className="mt-0.5 block text-footnote text-muted-foreground">{it.disabled || it.desc}</span>
              )}
            </span>
            <span
              className={cn(
                "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full shadow-[0_0_0_1px_var(--input)]",
                on && "bg-primary shadow-none",
              )}
              aria-hidden="true"
            >
              {on && <span className="size-1.5 rounded-full bg-primary-foreground" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A selectable small card (a period's price, a plan); put several in a `role="radiogroup"`. */
export function ChoiceChip({
  on,
  onClick,
  title,
  sub,
  disabled,
  className,
}: {
  on: boolean;
  onClick: () => void;
  title: ReactNode;
  sub?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-11 flex-col items-start justify-center rounded-lg bg-card px-3 py-2 text-left shadow-[0_0_0_0.5px_var(--input)] transition-shadow disabled:opacity-45",
        on && "shadow-[0_0_0_1.5px_var(--primary),0_0_0_4px_var(--ring)]",
        className,
      )}
    >
      <span className="text-body font-semibold">{title}</span>
      {sub && <span className="tnum text-footnote text-muted-foreground">{sub}</span>}
    </button>
  );
}

/**
 * 中文 / English tabs with a fill dot each: green = filled, red = required
 * and empty, hollow = optional and empty.
 */
export function LangTabs({
  value,
  onChange,
  items,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: string; filled: boolean; required?: boolean }[];
  label?: string;
}) {
  const tr = useTr();
  return (
    <div
      role="tablist"
      aria-label={label ?? tr("语言", "Language")}
      className="inline-flex gap-0.5 rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] p-0.5"
    >
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-body font-medium pointer-coarse:h-9",
            value === it.value
              ? "bg-segment-active shadow-[0_1px_3px_rgb(0_0_0/0.1)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {it.label}
          <span
            className={cn(
              "size-1.5 rounded-full",
              it.filled ? "bg-success" : it.required ? "bg-destructive" : "ring-1 ring-faint",
            )}
            aria-hidden="true"
          />
          <span className="sr-only">
            {it.filled
              ? tr("（已填写）", " (filled)")
              : it.required
                ? tr("（必填，未填写）", " (required, empty)")
                : tr("（未填写）", " (empty)")}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Node-group multi-select as toggle chips (entrance editor, plan editor),
 * with an optional link to the group management page.
 */
export function GroupChips({
  groups,
  value,
  onChange,
  manageTo,
  disabled,
}: {
  groups: { id: string; name: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  /** Console path of the group management page ("/plans/groups"). */
  manageTo?: string;
  disabled?: boolean;
}) {
  const tr = useTr();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {groups.map((g) => {
        const on = value.includes(g.id);
        return (
          <button
            key={g.id}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((x) => x !== g.id) : [...value, g.id])}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-full px-3 text-body font-medium transition-colors disabled:opacity-50 pointer-coarse:h-10",
              on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground",
            )}
          >
            {on && <CircleCheck className="size-3.5" aria-hidden="true" />}
            {g.name}
          </button>
        );
      })}
      {groups.length === 0 && (
        <span className="text-footnote text-faint">{tr("还没有节点组", "No node groups yet")}</span>
      )}
      {manageTo && (
        <Link to={manageTo} className="ml-1 text-footnote font-medium text-primary hover:underline">
          {tr("管理节点组", "Manage groups")}
        </Link>
      )}
    </div>
  );
}

/** 0–4: length, mixed case, digits, symbols. */
export function passwordStrength(p: string): number {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(4, s);
}

/** A random 16-character password in groups of four ("Tq7k-mPz3-Hn8w-Rb2x"), from the CSPRNG. */
export function generatePassword(): string {
  const a = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint32Array(16));
  return Array.from(r, (v, i) => (i % 5 === 4 ? "-" : a[v % a.length])).join("");
}

/**
 * Password field (new user, change password, my account): show / hide,
 * generate, a strength bar; the error under the field. Password managers
 * are told not to fill it (it is someone else's password).
 */
export function PasswordField({
  value,
  onChange,
  error,
  label,
  hint,
  required = true,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: ReactNode;
  label?: string;
  hint?: ReactNode;
  required?: boolean;
}) {
  const tr = useTr();
  const [show, setShow] = useState(false);
  const s = passwordStrength(value);
  const tone = ["bg-destructive", "bg-destructive", "bg-warning", "bg-success", "bg-success"][s];
  const words = [
    tr("很弱", "Very weak"),
    tr("弱", "Weak"),
    tr("一般", "Fair"),
    tr("强", "Strong"),
    tr("很强", "Very strong"),
  ];
  return (
    <Field
      label={label ?? tr("密码", "Password")}
      required={required}
      error={error}
      hint={
        hint ??
        tr(
          "至少 8 位。生成的密码请通过安全渠道告诉用户。",
          "At least 8 characters. Share a generated password over a safe channel.",
        )
      }
    >
      <div className="grid gap-2">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Input
              type={show ? "text" : "password"}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="pr-9 font-mono"
              autoComplete="new-password"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
            />
            <button
              type="button"
              onClick={() => setShow(!show)}
              aria-label={show ? tr("隐藏密码", "Hide password") : tr("显示密码", "Show password")}
              className="absolute inset-y-0 right-0 grid w-10 place-items-center text-faint hover:text-foreground"
            >
              {show ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
            </button>
          </div>
          <Button
            variant="secondary"
            icon={Dices}
            onClick={() => {
              onChange(generatePassword());
              setShow(true);
            }}
          >
            {tr("生成", "Generate")}
          </Button>
        </div>
        {value && (
          <div className="flex items-center gap-2">
            <div className="grid flex-1 grid-cols-4 gap-1" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={cn("h-1 rounded-full", i < s ? tone : "bg-secondary")} />
              ))}
            </div>
            <span className="min-w-10 text-right text-footnote text-muted-foreground">
              <span className="sr-only">{tr("强度：", "Strength: ")}</span>
              {words[s]}
            </span>
          </div>
        )}
      </div>
    </Field>
  );
}
