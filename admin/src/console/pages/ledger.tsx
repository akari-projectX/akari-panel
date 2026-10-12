// The money pages' list (orders, coupons, finance), ported from the
// confirmed orders draft (design/admin-redesign-2026-10 prototype
// pages/orders.tsx): one card with a toolbar (search with an icon, a
// segmented status filter, selects, a column chooser), a plain table with
// hairline rows (amounts right-aligned and bold, status chips) and on a
// phone a two-sided list (what / who / number · time on the left, amount
// and status on the right). Rows keep the hooks the e2e helpers use:
// `[data-row]` on the row (table row or list item) and, on a phone, a
// `role="button"` inside it when the row opens something.
import { Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../shared/cn";
import { useTr, type Tr } from "../../shared/i18n";
import { dateOnly, dateTime, siteToday } from "../../shared/format";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Checkbox, Input } from "../../shared/ui/form";
import { Popover } from "../../shared/ui/menu";
import { ErrorState, Skeleton } from "../../shared/ui/states";

export type LedgerColumn<T> = {
  key: string;
  header: ReactNode;
  /** Plain text for the column chooser (defaults to the header when a string). */
  label?: string;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  className?: string;
  /** Hidden until the admin turns it on in the column chooser (remembered). */
  optional?: boolean;
};

/** The phone list item: left = title / sub / meta, right = amount over status. */
export type PhoneItem = {
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  amount?: ReactNode;
  status?: ReactNode;
  /** Buttons under the item (outside the row's own button). */
  actions?: ReactNode;
};

function readCols(key: string): string[] | null {
  try {
    const v = localStorage.getItem(`akari.admin.cols.${key}`);
    return v ? (JSON.parse(v) as string[]) : null;
  } catch {
    return null;
  }
}

function writeCols(key: string, cols: string[]) {
  try {
    localStorage.setItem(`akari.admin.cols.${key}`, JSON.stringify(cols));
  } catch {
    /* storage blocked */
  }
}

/**
 * Optional columns: the visible set (remembered per table, same storage as
 * the shared DataTable) and the chooser button for the toolbar (null when
 * the table has no optional column).
 */
export function useColumns<T>(storageKey: string, columns: LedgerColumn<T>[]): [LedgerColumn<T>[], ReactNode] {
  const tr = useTr();
  const optional = columns.filter((c) => c.optional);
  const [on, setOn] = useState<Set<string>>(() => {
    const saved = readCols(storageKey);
    return new Set(saved ? saved.filter((k) => optional.some((c) => c.key === k)) : []);
  });
  const shown = useMemo(() => columns.filter((c) => !c.optional || on.has(c.key)), [columns, on]);
  if (!optional.length) return [shown, null];
  const name = tr("显示的列", "Visible columns");
  const chooser = (
    <Popover
      label={name}
      className="w-56"
      trigger={<Button variant="ghost" size="icon" icon={SlidersHorizontal} aria-label={name} title={name} />}
    >
      <div className="px-2 pt-1 pb-1.5 text-caption font-semibold text-faint">{name}</div>
      {optional.map((c) => {
        const text = c.label ?? (typeof c.header === "string" ? c.header : c.key);
        return (
          <label
            key={c.key}
            className="flex h-8 items-center gap-2.5 rounded-[7px] px-2 text-body hover:bg-accent pointer-coarse:h-11"
          >
            <Checkbox
              checked={on.has(c.key)}
              label={text}
              onChange={() => {
                const n = new Set(on);
                if (n.has(c.key)) n.delete(c.key);
                else n.add(c.key);
                setOn(n);
                writeCols(storageKey, [...n]);
              }}
            />
            {text}
          </label>
        );
      })}
    </Popover>
  );
  return [shown, chooser];
}

/** The toolbar's search box: a magnifier inside the field. */
export function SearchField({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cn("relative min-w-0 flex-1 basis-60", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 z-[1] size-4 -translate-y-1/2 text-faint"
        aria-hidden="true"
      />
      <Input type="search" className="pl-8" {...props} />
    </div>
  );
}

/** A segmented filter that scrolls sideways on a phone instead of wrapping. */
export function ScrollX({ children }: { children: ReactNode }) {
  return <div className="max-w-full overflow-x-auto [scrollbar-width:none]">{children}</div>;
}

/** "今天 14:03" / "10-11 01:10" / "2025-12-31 23:59" (site time zone); the full time on hover. */
export function shortTime(iso: string | null | undefined, tr: Tr): string {
  if (!iso) return "—";
  const full = dateTime(iso);
  const day = dateOnly(iso);
  const today = siteToday();
  if (day === today) return `${tr("今天", "Today")} ${full.slice(11)}`;
  if (day.slice(0, 4) === today.slice(0, 4)) return full.slice(5);
  return full;
}

export function When({ iso }: { iso: string | null | undefined }) {
  const tr = useTr();
  return (
    <span className="tnum" title={dateTime(iso)}>
      {shortTime(iso, tr)}
    </span>
  );
}

export function LedgerTable<T extends { id: string }>({
  label,
  rows,
  columns,
  phone,
  toolbar,
  footer,
  loading,
  error,
  onRetry,
  empty,
  onRowClick,
  activeId,
  rowProps,
  className,
}: {
  label: string;
  rows: T[];
  columns: LedgerColumn<T>[];
  phone: (row: T) => PhoneItem;
  toolbar?: ReactNode;
  footer?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Shown when there are no rows (the page tells "nothing yet" from "nothing matches"). */
  empty: ReactNode;
  onRowClick?: (row: T) => void;
  activeId?: string | null;
  rowProps?: (row: T) => Record<string, string | undefined>;
  className?: string;
}) {
  const body =
    error && !loading ? (
      <ErrorState error={error} onRetry={onRetry} />
    ) : !loading && rows.length === 0 ? (
      empty
    ) : (
      <>
        <div className="scroll-thin overflow-x-auto max-md:hidden" role="region" aria-label={label}>
          <table className="w-full text-body">
            <thead>
              <tr className="text-left text-footnote text-muted-foreground [&>th]:h-9 [&>th]:px-3 [&>th]:font-medium [&>th]:whitespace-nowrap [&>th:first-child]:pl-4 [&>th:last-child]:pr-4">
                {columns.map((c) => (
                  <th key={c.key} className={cn(c.align === "right" && "text-right")}>
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-separator border-t border-separator">
              {loading
                ? Array.from({ length: 6 }, (_, i) => (
                    <tr key={i} className="h-11 [&>td]:px-3 [&>td:first-child]:pl-4 [&>td:last-child]:pr-4">
                      {columns.map((c, j) => (
                        <td key={c.key}>
                          <Skeleton
                            className={cn("h-4", j === 0 ? "w-36" : "w-16", c.align === "right" && "ml-auto")}
                          />
                        </td>
                      ))}
                    </tr>
                  ))
                : rows.map((r) => (
                    <tr
                      key={r.id}
                      data-row={r.id}
                      {...rowProps?.(r)}
                      tabIndex={onRowClick ? 0 : undefined}
                      onClick={() => onRowClick?.(r)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && e.target === e.currentTarget) onRowClick?.(r);
                      }}
                      aria-current={activeId === r.id || undefined}
                      className={cn(
                        "h-11 transition-colors [&>td]:px-3 [&>td:first-child]:pl-4 [&>td:last-child]:pr-4",
                        onRowClick &&
                          "cursor-pointer hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                        activeId === r.id && "bg-primary-soft hover:bg-primary-soft",
                      )}
                    >
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={cn("py-1.5 align-middle", c.align === "right" && "tnum text-right", c.className)}
                        >
                          {c.cell(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        <ul className="divide-y divide-separator md:hidden" aria-label={label}>
          {loading
            ? Array.from({ length: 5 }, (_, i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-3">
                  <div className="grid flex-1 gap-1.5">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-44" />
                    <Skeleton className="h-3 w-36" />
                  </div>
                  <Skeleton className="h-4 w-14" />
                </li>
              ))
            : rows.map((r) => {
                const p = phone(r);
                const inner = (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-body font-medium">
                        {p.title}
                      </div>
                      {p.sub && <div className="mt-0.5 truncate text-footnote text-muted-foreground">{p.sub}</div>}
                      {p.meta && <div className="mt-0.5 truncate text-caption text-faint">{p.meta}</div>}
                    </div>
                    {(p.amount !== undefined || p.status) && (
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        {p.amount !== undefined && <span className="tnum text-body font-semibold">{p.amount}</span>}
                        {p.status}
                      </div>
                    )}
                  </>
                );
                return (
                  <li
                    key={r.id}
                    data-row={r.id}
                    {...rowProps?.(r)}
                    aria-current={activeId === r.id || undefined}
                    className={cn(
                      "px-4 py-3",
                      onRowClick && "active:bg-accent",
                      activeId === r.id && "bg-primary-soft",
                    )}
                  >
                    {onRowClick ? (
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => onRowClick(r)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(r);
                        }}
                        className="flex cursor-pointer items-start gap-3 focus-visible:outline-none"
                      >
                        {inner}
                      </div>
                    ) : (
                      <div className="flex items-start gap-3">{inner}</div>
                    )}
                    {p.actions && <div className="mt-2 flex flex-wrap justify-end gap-1.5">{p.actions}</div>}
                  </li>
                );
              })}
        </ul>
      </>
    );
  return (
    <Card className={cn("overflow-hidden", className)}>
      {toolbar && <div className="flex flex-wrap items-center gap-2 border-b border-separator p-3">{toolbar}</div>}
      {body}
      {footer && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-separator px-4 py-2.5 text-footnote text-muted-foreground">
          {footer}
        </div>
      )}
    </Card>
  );
}
