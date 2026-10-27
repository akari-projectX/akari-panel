// v2 kit: composite blocks shared by every console page (2026-10 redesign
// v2, proposal-v2 §7.2; ported from prototype/src/components/kit.tsx and the
// area files, merged and deduplicated). Real data in, bilingual copy via
// tr(), colours via tokens only. Base controls live in shared/ui/*; form
// helpers in ./inputs.tsx; status chips in ./status.tsx; settings rows and
// the save bar in ./settings-kit.tsx (see admin/CLAUDE.md "v2 kit").
import {
  ArrowRightLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  LoaderCircle,
  Mail,
  RotateCw,
  Search,
  Send,
  TriangleAlert,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router";
import { cn } from "../../shared/cn";
import { copyText, dateOnly, dateTime, siteToday } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { Button, type ButtonProps } from "../../shared/ui/button";
import { Input, Kbd } from "../../shared/ui/form";
import { useToast } from "../../shared/ui/toast";

export type KitTone = "primary" | "success" | "warning" | "danger" | "info" | "neutral";

const soft: Record<KitTone, string> = {
  primary: "bg-primary-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-destructive-soft text-destructive",
  info: "bg-info-soft text-info",
  neutral: "bg-secondary text-muted-foreground",
};

/* ---------- Search ---------- */

/**
 * Search box: magnifier left, clear button right (or a shortcut hint).
 * `shortcut` ("/") also focuses the box when pressed outside a field.
 * Marked data-nodirty (typing here is not an unsaved edit in a dialog).
 */
export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  className,
  shortcut,
  autofocus,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Accessible name (also the placeholder when none is given). */
  label: string;
  placeholder?: string;
  className?: string;
  shortcut?: string;
  /** Focus when a dialog opens (Dialog focuses `[data-autofocus]`). */
  autofocus?: boolean;
}) {
  const tr = useTr();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!shortcut) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== shortcut || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [shortcut]);
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint"
        aria-hidden="true"
      />
      <Input
        ref={ref}
        type="search"
        data-nodirty
        aria-label={label}
        value={value}
        data-autofocus={autofocus || undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder ?? label}
        className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
          aria-label={tr("清除搜索", "Clear search")}
          className="hit-44 absolute top-1/2 right-2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-full bg-faint/50 text-card"
        >
          <X className="size-3 stroke-[3]" aria-hidden="true" />
        </button>
      ) : (
        shortcut && (
          <Kbd className="absolute top-1/2 right-1.5 -translate-y-1/2 max-sm:hidden" aria-hidden="true">
            {shortcut}
          </Kbd>
        )
      )}
    </div>
  );
}

/* ---------- Numbers ---------- */

export type StatItem = {
  label: ReactNode;
  value: ReactNode;
  foot?: ReactNode;
  tone?: "danger" | "warning" | "success" | "primary";
  /** Makes the cell a filter button. */
  onClick?: () => void;
  active?: boolean;
};

/**
 * A horizontal strip of figures in one card (hairline-separated; 2 columns
 * on a phone) — half the height of four KPI cards. Cells with `onClick` are
 * filter buttons (`active` = the filter is on).
 */
export function StatStrip({ items, className }: { items: StatItem[]; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 overflow-hidden rounded-xl bg-card shadow-card sm:flex sm:divide-x sm:divide-separator",
        className,
      )}
    >
      {items.map((it, i) => {
        const body = (
          <>
            <div className="truncate text-footnote font-medium text-muted-foreground">{it.label}</div>
            <div
              className={cn(
                "tnum mt-0.5 truncate text-title2 font-semibold tracking-[-0.02em]",
                it.tone === "danger" && "text-destructive",
                it.tone === "warning" && "text-warning",
                it.tone === "success" && "text-success",
                it.tone === "primary" && "text-primary",
              )}
            >
              {it.value}
            </div>
            {it.foot && <div className="truncate text-footnote text-faint">{it.foot}</div>}
          </>
        );
        const cls = cn(
          "min-w-0 flex-1 px-4 py-3 text-left max-sm:border-separator max-sm:[&:nth-child(even)]:border-l max-sm:[&:nth-child(n+3)]:border-t",
          it.onClick && "transition-colors hover:bg-accent",
          it.active && "bg-primary-soft/60",
        );
        return it.onClick ? (
          <button key={i} type="button" aria-pressed={!!it.active} onClick={it.onClick} className={cls}>
            {body}
          </button>
        ) : (
          <div key={i} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Relative date of an expiry ("12 天后", "3 天前", "今天到期"): red under 3
 * days, amber up to 7, the date and time on hover. Days are site days.
 */
export function RelDays({ date, className }: { date: string | null | undefined; className?: string }) {
  const tr = useTr();
  if (!date) return <span className={cn("text-faint", className)}>—</span>;
  const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const d = Math.round((day(dateOnly(date)) - day(siteToday())) / 86_400_000);
  const text =
    d === 0
      ? tr("今天到期", "Today")
      : d === 1
        ? tr("明天", "Tomorrow")
        : d > 0
          ? tr(`${d} 天后`, `in ${d} days`)
          : tr(`${-d} 天前`, `${-d} days ago`);
  return (
    <span
      title={dateTime(date)}
      className={cn(
        "tnum",
        d < 3 ? "font-medium text-destructive" : d <= 7 ? "font-medium text-warning" : "text-muted-foreground",
        className,
      )}
    >
      {text}
    </span>
  );
}

/* ---------- Values ---------- */

/**
 * A monospace value with a copy button (subscription links, hashes, install
 * commands). `block` = a full-width boxed line.
 */
export function CopyText({
  value,
  display,
  className,
  block,
  label,
}: {
  value: string;
  display?: ReactNode;
  className?: string;
  block?: boolean;
  /** What is copied, for the button's name ("复制订阅链接"). */
  label?: string;
}) {
  const tr = useTr();
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <span
      className={cn(
        "group inline-flex min-w-0 items-center gap-1.5",
        block && "flex w-full rounded-md bg-window px-2.5 py-1.5 ring-1 ring-border ring-inset",
        className,
      )}
    >
      <span className={cn("min-w-0 truncate font-mono text-footnote", block && "flex-1")} title={value}>
        {display ?? value}
      </span>
      <button
        type="button"
        aria-label={label ? tr(`复制${label}`, `Copy ${label}`) : tr("复制", "Copy")}
        onClick={async () => {
          if (await copyText(value)) {
            setDone(true);
            toast({ tone: "success", title: tr("已复制", "Copied") });
            setTimeout(() => setDone(false), 1200);
          } else toast({ tone: "error", title: tr("复制失败，请手动复制", "Copy failed; copy it by hand") });
        }}
        className="hit-44 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
      >
        {done ? (
          <Check className="size-3.5 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </span>
  );
}

const HUES = ["--chart-1", "--chart-3", "--chart-7", "--chart-5", "--chart-2", "--chart-6", "--chart-4", "--chart-8"];

/** Avatar: the first letter of an address/name on a stable colour hashed from it (chart tokens). */
export function Avatar({ name, size = 28, className }: { name: string; size?: number; className?: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const c = `var(${HUES[h % HUES.length]})`;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white uppercase",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `linear-gradient(180deg, color-mix(in srgb, ${c}, white 18%), ${c})`,
      }}
    >
      {name.replace(/[^a-z0-9一-鿿]/gi, "")[0] ?? "?"}
    </span>
  );
}

/**
 * A soft tinted icon block (dialog headers, card leads; merges the v2
 * IconBadge / IconBox / IconTile). `round` = circle; sizes 36 / 40 px.
 */
export function IconBadge({
  icon: Icon,
  children,
  tone = "primary",
  round,
  size = "md",
  className,
}: {
  icon?: LucideIcon;
  children?: ReactNode;
  tone?: KitTone;
  round?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        size === "sm" ? "size-9 [&_svg]:size-[18px]" : "size-10 [&_svg]:size-5",
        round ? "rounded-full" : size === "sm" ? "rounded-[10px]" : "rounded-[11px]",
        soft[tone],
        className,
      )}
    >
      {Icon ? <Icon /> : children}
    </span>
  );
}

/** Alert channel icon: Telegram / Webhook / mail on a tinted square (chart tokens). */
export function ChannelIcon({ ch, size = 24 }: { ch: "telegram" | "webhook" | "email"; size?: number }) {
  const tr = useTr();
  const m = {
    telegram: { name: "Telegram", icon: Send, color: "var(--chart-1)" },
    webhook: { name: "Webhook", icon: Webhook, color: "var(--chart-7)" },
    email: { name: tr("邮件", "Email"), icon: Mail, color: "var(--chart-2)" },
  }[ch];
  return (
    <span
      role="img"
      aria-label={m.name}
      title={m.name}
      className="inline-flex shrink-0 items-center justify-center rounded-[7px] text-white"
      style={{ width: size, height: size, background: m.color }}
    >
      <m.icon className="size-[58%] stroke-[2.2]" aria-hidden="true" />
    </span>
  );
}

/**
 * An entrance as a small chip: direct (slot 1, plain) or relay (slot 2,
 * with the ⇄ icon), with an optional rate text ("×1.5"). `muted` = disabled.
 */
export function EntranceChip({
  name,
  kind,
  rate,
  muted,
}: {
  name: ReactNode;
  kind: "direct" | "relay" | string;
  rate?: ReactNode;
  muted?: boolean;
}) {
  const tr = useTr();
  const relay = kind === "relay";
  return (
    <span
      title={relay ? tr("中转入口", "Relay entrance") : tr("直连入口", "Direct entrance")}
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1 rounded-md px-1.5 text-footnote",
        relay
          ? "bg-[color-mix(in_srgb,var(--chart-2)_13%,transparent)] text-chart-2"
          : "bg-[color-mix(in_srgb,var(--chart-1)_11%,transparent)] text-chart-1",
        muted && "opacity-60",
      )}
    >
      {relay && <ArrowRightLeft className="size-3 shrink-0" aria-hidden="true" />}
      <span className="truncate">{name}</span>
      {rate != null && rate !== "" && <span className="opacity-70">{rate}</span>}
    </span>
  );
}

/* ---------- Structure ---------- */

export type TimelineItem = {
  title: ReactNode;
  time: ReactNode;
  body?: ReactNode;
  tone?: "success" | "warning" | "danger" | "info" | "neutral";
};

/** Timeline (payment events, alert history, ticket activity, audit): line + dots coloured by outcome. */
export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  const c = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    info: "bg-info",
    neutral: "bg-faint",
  };
  return (
    <ol
      className={cn(
        "relative grid gap-4 pl-5 before:absolute before:top-1.5 before:bottom-1.5 before:left-[5px] before:w-px before:bg-separator",
        className,
      )}
    >
      {items.map((it, i) => (
        <li key={i} className="relative">
          <span
            className={cn(
              "absolute top-1 -left-5 size-[11px] rounded-full ring-[3px] ring-card",
              c[it.tone ?? "neutral"],
            )}
            aria-hidden="true"
          />
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-body font-medium">{it.title}</span>
            <span className="tnum text-footnote text-faint">{it.time}</span>
          </div>
          {it.body && <div className="mt-1 text-footnote text-muted-foreground">{it.body}</div>}
        </li>
      ))}
    </ol>
  );
}

export type StepState = "done" | "active" | "todo" | "failed";

/**
 * Vertical progress list (mail diagnosis, batch job phases): ✓ done,
 * pulsing active, grey todo, red failed with its detail open.
 */
export function Steps({
  items,
}: {
  items: { label: ReactNode; state: StepState; detail?: ReactNode; ms?: ReactNode }[];
}) {
  const tr = useTr();
  const sr = {
    done: tr("已完成", "done"),
    active: tr("进行中", "running"),
    todo: tr("未开始", "to do"),
    failed: tr("失败", "failed"),
  };
  return (
    <ol className="grid gap-0.5">
      {items.map((it, i) => (
        <li key={i} className={cn("rounded-lg px-2.5 py-2", it.state === "failed" && "bg-destructive-soft")}>
          <div className="flex items-center gap-2.5 text-body">
            <span
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-caption font-semibold",
                it.state === "done" && "bg-success text-white",
                it.state === "active" && "animate-pulse bg-primary text-primary-foreground",
                it.state === "todo" && "bg-secondary text-faint",
                it.state === "failed" && "bg-destructive text-white",
              )}
              aria-hidden="true"
            >
              {it.state === "done" ? (
                <Check className="size-3 stroke-[3]" />
              ) : it.state === "failed" ? (
                <X className="size-3 stroke-[3]" />
              ) : (
                i + 1
              )}
            </span>
            <span className={cn("flex-1 font-medium", it.state === "todo" && "text-faint")}>
              {it.label}
              <span className="sr-only"> ({sr[it.state]})</span>
            </span>
            {it.ms && <span className="tnum text-footnote text-faint">{it.ms}</span>}
          </div>
          {it.detail && <div className="mt-1 pl-7.5 text-footnote text-muted-foreground">{it.detail}</div>}
        </li>
      ))}
    </ol>
  );
}

/**
 * Horizontal step bar for wizards (manual order, new node, batch actions):
 * finished steps are links back when `onJump` is given.
 */
export function Stepper({
  steps,
  current,
  onJump,
  className,
}: {
  steps: ReactNode[];
  current: number;
  onJump?: (i: number) => void;
  className?: string;
}) {
  return (
    <ol className={cn("flex items-center gap-2 py-2.5", className)}>
      {steps.map((s, i) => {
        const done = i < current;
        const on = i === current;
        return (
          <li key={i} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none">
            <button
              type="button"
              disabled={!done || !onJump}
              onClick={() => onJump?.(i)}
              aria-current={on ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-full text-body font-medium",
                on ? "text-foreground" : done ? "text-primary" : "text-faint",
              )}
            >
              <span
                className={cn(
                  "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-caption font-semibold",
                  on
                    ? "bg-primary text-primary-foreground"
                    : done
                      ? "bg-primary-soft text-primary"
                      : "bg-secondary text-faint",
                )}
                aria-hidden="true"
              >
                {done ? <Check className="size-3 stroke-[3]" /> : i + 1}
              </span>
              <span className={cn("truncate", !on && "max-sm:sr-only")}>{s}</span>
            </button>
            {i < steps.length - 1 && (
              <span className={cn("h-px min-w-3 flex-1", done ? "bg-primary/40" : "bg-separator")} aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Page-level tabs bound to sub-routes (/orders · /coupons/batches …):
 * NavLinks with the underline style and an optional count.
 */
export function PageTabs({
  items,
  trailing,
  label,
  className,
  segmented,
}: {
  items: { to: string; label: ReactNode; count?: ReactNode; end?: boolean }[];
  trailing?: ReactNode;
  label?: string;
  className?: string;
  /** A segmented control (v2 finance) instead of underline tabs. */
  segmented?: boolean;
}) {
  if (segmented)
    return (
      <nav aria-label={label} className={cn("mb-4 flex flex-wrap items-center gap-2", className)}>
        <div className="flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-secondary p-0.5 [scrollbar-width:none]">
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) =>
                cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-callout font-medium transition-colors",
                  isActive ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {it.label}
              {it.count !== undefined && it.count !== null && (
                <span className="tnum text-footnote text-muted-foreground">{it.count}</span>
              )}
            </NavLink>
          ))}
        </div>
        {trailing && <div className="ml-auto shrink-0">{trailing}</div>}
      </nav>
    );
  return (
    <nav
      aria-label={label}
      className={cn(
        "mb-4 flex items-center gap-1 overflow-x-auto border-b border-separator [scrollbar-width:none]",
        className,
      )}
    >
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end={it.end}
          className={({ isActive }) =>
            cn(
              "relative -mb-px inline-flex h-10 shrink-0 items-center gap-1.5 px-2 text-callout font-medium transition-colors after:absolute after:inset-x-1 after:bottom-0 after:h-[2px] after:rounded-full after:bg-primary",
              isActive
                ? "text-foreground after:opacity-100"
                : "text-muted-foreground after:opacity-0 hover:text-foreground",
            )
          }
        >
          {it.label}
          {it.count !== undefined && it.count !== null && (
            <span className="tnum rounded-full bg-secondary px-1.5 text-footnote text-muted-foreground">
              {it.count}
            </span>
          )}
        </NavLink>
      ))}
      {trailing && <div className="ml-auto shrink-0 pb-1.5">{trailing}</div>}
    </nav>
  );
}

/**
 * Floating bulk-action bar (rises from the bottom once rows are ticked;
 * stays visible while scrolling): "已选 3 个 · 选择全部匹配的 2,400 个".
 */
export function SelectionBar({
  count,
  total,
  allMatching,
  onAll,
  onClear,
  children,
}: {
  count: number;
  total?: number;
  allMatching?: boolean;
  onAll?: () => void;
  onClear: () => void;
  children: ReactNode;
}) {
  const tr = useTr();
  if (!count && !allMatching) return null;
  const n = (allMatching ? total : count) ?? count;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+64px)] z-40 flex justify-center px-3 lg:bottom-6 lg:pl-[248px]">
      <div
        data-floatbar
        role="region"
        aria-label={tr("批量操作", "Bulk actions")}
        className="glass pointer-events-auto flex max-w-full animate-in items-center gap-2 overflow-x-auto rounded-2xl bg-popover p-1.5 pl-2 shadow-dialog fade-in-0 slide-in-from-bottom-3 [scrollbar-width:none]"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full"
          icon={X}
          onClick={onClear}
          aria-label={tr("清除选择", "Clear selection")}
        />
        <span className="text-body font-semibold whitespace-nowrap" role="status">
          {allMatching
            ? tr(`全部匹配的 ${n.toLocaleString()} 个`, `All ${n.toLocaleString()} matching`)
            : tr(`已选 ${n.toLocaleString()} 个`, `${n.toLocaleString()} selected`)}
        </span>
        {total !== undefined && !allMatching && onAll && total > count && (
          <button type="button" onClick={onAll} className="text-body whitespace-nowrap text-primary hover:underline">
            {tr(`选择全部匹配的 ${total.toLocaleString()} 个`, `Select all ${total.toLocaleString()} matching`)}
          </button>
        )}
        <span className="mx-1 h-5 w-px shrink-0 bg-separator" aria-hidden="true" />
        <div className="flex items-center gap-1">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Dialog helpers ---------- */

/** "N 处需要修正" next to a disabled submit button. */
export function FixCount({ n }: { n: number }) {
  const tr = useTr();
  if (!n) return null;
  return (
    <span className="flex items-center gap-1 text-footnote font-medium text-destructive" role="status">
      <CircleAlert className="size-3.5" aria-hidden="true" />
      {tr(`${n} 处需要修正`, `${n} to fix`)}
    </span>
  );
}

/** Impact list inside an ordinary dialog (same look as the confirmations' list). */
export function ImpactList({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={cn("divide-y divide-separator rounded-lg bg-window ring-1 ring-border ring-inset", className)}>
      {items.map((it, i) => (
        <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-body">
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className="tnum text-right font-medium">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The spinner inside a button (prefer Button `loading`). */
export function Spin({ className }: { className?: string }) {
  return <LoaderCircle className={cn("animate-spin", className)} aria-hidden="true" />;
}

/**
 * A button that runs its own async action with its own spinner (never one
 * busy for several buttons). `onClick` returns a promise (typically
 * `run(...)` of its own `useAction()`); `done` = label shown for 1.5 s after
 * it resolved with something other than undefined.
 */
export function AsyncButton({
  onClick,
  done,
  children,
  ...props
}: Omit<ButtonProps, "onClick" | "loading"> & {
  onClick: () => Promise<unknown> | unknown;
  done?: ReactNode;
}) {
  const [st, setSt] = useState<"idle" | "busy" | "done">("idle");
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  return (
    <Button
      {...props}
      loading={st === "busy"}
      disabled={props.disabled || st === "done"}
      onClick={async (e) => {
        e.stopPropagation();
        setSt("busy");
        let r: unknown;
        try {
          r = await onClick();
        } catch {
          r = undefined;
        }
        if (!live.current) return;
        if (done && r !== undefined) {
          setSt("done");
          setTimeout(() => live.current && setSt("idle"), 1500);
        } else setSt("idle");
      }}
    >
      {st === "done" ? done : children}
    </Button>
  );
}

/* ---------- Errors and warnings ---------- */

/** One sentence in the operator's language + the raw text collapsible (error codes, agent warnings, payment events). */
export function RawError({ message, raw, className }: { message: ReactNode; raw: string; className?: string }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("min-w-0 text-footnote", className)}>
      <div className="text-foreground/85">{message}</div>
      {raw && (
        <>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mt-0.5 inline-flex items-center gap-0.5 text-faint hover:text-muted-foreground"
            aria-expanded={open}
          >
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden="true" />
            {open ? tr("收起原文", "Hide raw text") : tr("原始错误", "Raw error")}
          </button>
          {open && (
            <pre className="mt-1 rounded-md bg-window px-2 py-1.5 font-mono text-caption break-all whitespace-pre-wrap text-muted-foreground ring-1 ring-border ring-inset">
              {raw}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/** A warning / last error: title, one-line explanation, the raw text collapsible, an optional action. */
export function WarningItem({
  tone = "warning",
  title,
  desc,
  raw,
  at,
  action,
}: {
  tone?: "warning" | "danger";
  title: ReactNode;
  desc?: ReactNode;
  raw?: string;
  at?: ReactNode;
  action?: ReactNode;
}) {
  const tr = useTr();
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl px-3.5 py-3",
        tone === "danger" ? "bg-destructive-soft" : "bg-warning-soft",
      )}
    >
      {tone === "danger" ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      ) : (
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-body font-semibold">{title}</span>
          {at && <span className="tnum text-footnote text-faint">{at}</span>}
        </div>
        {desc && <p className="mt-0.5 text-footnote text-foreground/75">{desc}</p>}
        {raw && (
          <details className="mt-1 text-footnote">
            <summary className="cursor-default text-muted-foreground">{tr("查看原文", "Show raw text")}</summary>
            <pre className="mt-1 overflow-x-auto rounded-md bg-card/70 p-2 font-mono text-caption break-all whitespace-pre-wrap text-muted-foreground">
              {raw}
            </pre>
          </details>
        )}
      </div>
      {action}
    </div>
  );
}

/* ---------- Polling ---------- */

/**
 * "30 秒前更新 · 每 30 秒自动刷新" with a breathing dot and a refresh
 * button; `stale` (the last refresh failed, old data shown) turns it amber.
 * Feed it a query: `updatedAt={q.dataUpdatedAt} stale={q.isError && !!q.data}
 * onRefresh={() => q.refetch()}`.
 */
export function Fresh({
  updatedAt,
  stale,
  every,
  onRefresh,
  className,
}: {
  /** ms since epoch of the data shown (0 = never). */
  updatedAt: number;
  stale?: boolean;
  /** Auto-refresh period in seconds (shown on wide screens). */
  every?: number;
  onRefresh?: () => Promise<unknown> | unknown;
  className?: string;
}) {
  const tr = useTr();
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);
  const s = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000)) : null;
  const ago =
    s === null
      ? "—"
      : s < 10
        ? tr("刚刚", "just now")
        : s < 60
          ? tr(`${s} 秒前`, `${s}s ago`)
          : s < 3600
            ? tr(`${Math.floor(s / 60)} 分钟前`, `${Math.floor(s / 60)} min ago`)
            : tr(`${Math.floor(s / 3600)} 小时前`, `${Math.floor(s / 3600)} h ago`);
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full pr-1 pl-3 text-footnote",
        stale
          ? "bg-warning-soft text-warning"
          : "bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] text-muted-foreground",
        className,
      )}
    >
      <span className="relative inline-flex size-2" aria-hidden="true">
        {!stale && <span className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:hidden" />}
        <span className={cn("relative size-2 rounded-full", stale ? "bg-warning" : "bg-success")} />
      </span>
      <span className="whitespace-nowrap" role="status">
        {stale ? (
          tr(`刷新失败 · 显示 ${ago}的数据`, `Refresh failed · showing data from ${ago}`)
        ) : (
          <>
            {tr(`${ago}更新`, `Updated ${ago}`)}
            {every && <span className="max-sm:hidden">{tr(` · 每 ${every} 秒自动刷新`, ` · every ${every}s`)}</span>}
          </>
        )}
      </span>
      {onRefresh && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 rounded-full"
          aria-label={tr("立即刷新", "Refresh now")}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRefresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          <RotateCw className={cn("size-3.5", busy && "animate-spin")} aria-hidden="true" />
        </Button>
      )}
    </span>
  );
}

/* ---------- Server-rendered preview ---------- */

/**
 * Server-rendered preview (announcements, help articles, mail templates,
 * plan descriptions): `html` is the panel's sanitized render (same renderer
 * as the portal). rendering = thin progress bar, previous render kept;
 * error = one sentence + Retry; nothing yet = `empty`.
 */
export function PreviewPane({
  title,
  tag,
  html,
  state = "ok",
  label,
  onRetry,
  empty,
  className,
}: {
  title?: string;
  /** A chip shown before the title (the announcement's tag). */
  tag?: ReactNode;
  html: string;
  state?: "ok" | "rendering" | "error";
  label?: ReactNode;
  onRetry?: () => void;
  empty?: ReactNode;
  className?: string;
}) {
  const tr = useTr();
  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-col overflow-hidden rounded-xl bg-window ring-1 ring-border ring-inset",
        className,
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-separator px-3 text-footnote text-muted-foreground">
        <span className="font-medium">{label ?? tr("门户预览", "Portal preview")}</span>
        <span className="ml-auto flex items-center gap-1.5" role="status">
          {state === "rendering" && (
            <>
              <Spin className="size-3.5" />
              {tr("渲染中…", "Rendering…")}
            </>
          )}
          {state === "ok" && (html || title) && <span className="text-faint">{tr("已与服务器同步", "In sync")}</span>}
          {state === "error" && <span className="text-destructive">{tr("渲染失败", "Render failed")}</span>}
        </span>
      </div>
      {state === "rendering" && (
        <div className="absolute inset-x-0 top-9 h-0.5 animate-pulse bg-primary/60" aria-hidden="true" />
      )}
      <div
        className={cn(
          "scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3.5 text-body",
          state === "rendering" && "opacity-55",
        )}
      >
        {state === "error" ? (
          <div className="flex flex-col items-center py-8 text-center">
            <span className="mb-2 inline-flex size-9 items-center justify-center rounded-full bg-destructive-soft text-destructive">
              <CircleAlert className="size-4" aria-hidden="true" />
            </span>
            <div className="text-body font-semibold">{tr("预览暂时无法渲染", "The preview could not be rendered")}</div>
            <div className="mt-0.5 text-footnote text-muted-foreground">
              {tr("编辑内容不受影响。", "Your edits are not affected.")}
            </div>
            {onRetry && (
              <Button variant="outline" size="sm" className="mt-3" icon={RotateCw} onClick={onRetry}>
                {tr("重试", "Retry")}
              </Button>
            )}
          </div>
        ) : html || title ? (
          <article>
            {title && (
              <h2 className="mb-2 flex items-center gap-2 text-title3 font-semibold tracking-[-0.015em]">
                {tag}
                <span className="min-w-0 break-words">{title}</span>
              </h2>
            )}
            {html ? (
              <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <p className="text-faint">{tr("（正文为空）", "(empty)")}</p>
            )}
          </article>
        ) : (
          <div className="py-10 text-center text-footnote text-faint">
            {empty ?? tr("输入正文后在这里看到门户里的效果", "Type the text to see it as the portal shows it")}
          </div>
        )}
      </div>
    </div>
  );
}
