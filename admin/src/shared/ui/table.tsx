import { useMemo, useState, type ReactNode } from "react";
import { cn } from "../cn";
import { useTr } from "../i18n";
import { Icon } from "./icons";
import { Popover } from "./overlays";
import { Button, Checkbox, EmptyState, ErrorState, Skeleton } from "./primitives";

export type Column<T> = {
  key: string;
  header: ReactNode;
  /** Plain text for the column chooser (defaults to header when a string). */
  label?: string;
  cell: (row: T) => ReactNode;
  /** Hidden by default; the admin can enable it in the column chooser. */
  optional?: boolean;
  /** Cannot be hidden. */
  fixed?: boolean;
  align?: "left" | "right";
  className?: string;
  /** Phone card layout: the title column, or hidden there. */
  mobile?: "title" | "hide";
};

function readCols(key: string | undefined): string[] | null {
  if (!key) return null;
  try {
    const v = localStorage.getItem(`akari.admin.cols.${key}`);
    return v ? (JSON.parse(v) as string[]) : null;
  } catch {
    return null;
  }
}

function writeCols(key: string | undefined, cols: string[]) {
  if (!key) return;
  try {
    localStorage.setItem(`akari.admin.cols.${key}`, JSON.stringify(cols));
  } catch {
    /* storage blocked */
  }
}

/*
 * DataTable: selection + bulk bar, column chooser (remembered per table),
 * skeleton / empty / error states. Below `md` rows render as cards.
 */
export function DataTable<T extends { id: string }>({
  rows,
  columns,
  loading,
  error,
  onRetry,
  selectable,
  selected,
  onSelectedChange,
  onRowClick,
  bulkActions,
  toolbar,
  empty,
  footer,
  activeId,
  storageKey,
  label,
}: {
  rows: T[];
  columns: Column<T>[];
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
  onRowClick?: (row: T) => void;
  bulkActions?: (count: number) => ReactNode;
  toolbar?: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
  activeId?: string | null;
  storageKey?: string;
  label: string;
}) {
  const tr = useTr();
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(readCols(storageKey) ?? columns.filter((c) => !c.optional).map((c) => c.key)),
  );
  const [chooser, setChooser] = useState(false);
  const cols = useMemo(() => columns.filter((c) => c.fixed || visible.has(c.key)), [columns, visible]);
  const sel = selected ?? new Set<string>();
  const allSelected = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const someSelected = !allSelected && rows.some((r) => sel.has(r.id));
  const toggle = (id: string) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    onSelectedChange?.(n);
  };
  const title = columns.find((c) => c.mobile === "title") ?? columns[0];
  const metas = cols.filter((c) => c !== title && c.mobile !== "hide");
  const card = (r: T) => (
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium">{title.cell(r)}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        {metas.map((c) => (
          <span key={c.key} className="flex items-center gap-1">
            {c.cell(r)}
          </span>
        ))}
      </div>
    </div>
  );
  const showToolbar = toolbar !== undefined || columns.some((c) => !c.fixed);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {columns.some((c) => !c.fixed) && (
            <div className="relative">
              <Button
                size="sm"
                variant="ghost"
                icon="columns"
                onClick={() => setChooser((v) => !v)}
                aria-label={tr("显示的列", "Visible columns")}
              >
                <span className="hidden sm:inline">{tr("列", "Columns")}</span>
              </Button>
              <Popover open={chooser} onClose={() => setChooser(false)}>
                <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {tr("显示的列", "Visible columns")}
                </div>
                {columns
                  .filter((c) => !c.fixed)
                  .map((c) => (
                    <div
                      key={c.key}
                      className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-muted"
                    >
                      <Checkbox
                        checked={visible.has(c.key)}
                        label={c.label ?? (typeof c.header === "string" ? c.header : c.key)}
                        onChange={() => {
                          const n = new Set(visible);
                          if (n.has(c.key)) n.delete(c.key);
                          else n.add(c.key);
                          setVisible(n);
                          writeCols(storageKey, [...n]);
                        }}
                      />
                      {c.header}
                    </div>
                  ))}
              </Popover>
            </div>
          )}
        </div>
      )}

      {selectable && sel.size > 0 && (
        <div
          data-testid="bulk-bar"
          className="anim-in flex flex-wrap items-center gap-2 border-b border-border bg-primary-soft/60 px-3 py-2 text-[13px]"
        >
          <span className="font-medium">{tr(`已选 ${sel.size} 项`, `${sel.size} selected`)}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => onSelectedChange?.(new Set())}>
            {tr("清除", "Clear")}
          </button>
          <div className="ml-auto flex flex-wrap gap-2">{bulkActions?.(sel.size)}</div>
        </div>
      )}

      {error && !loading ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : !loading && rows.length === 0 ? (
        (empty ?? (
          <EmptyState
            title={tr("没有匹配的记录", "No matching records")}
            description={tr("调整筛选条件后重试。", "Adjust the filters and try again.")}
          />
        ))
      ) : (
        <>
          <div className="scroll-thin hidden overflow-x-auto md:block" role="region" aria-label={label}>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border bg-subtle text-left text-xs text-muted-foreground">
                  {selectable && (
                    <th className="w-10 px-3 py-2">
                      <Checkbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        label={tr("全选本页", "Select page")}
                        onChange={() =>
                          onSelectedChange?.(allSelected ? new Set() : new Set([...sel, ...rows.map((r) => r.id)]))
                        }
                      />
                    </th>
                  )}
                  {cols.map((c) => (
                    <th
                      key={c.key}
                      className={cn(
                        "whitespace-nowrap px-3 py-2 font-medium",
                        c.align === "right" && "text-right",
                        c.className,
                      )}
                    >
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        {selectable && (
                          <td className="px-3 py-3">
                            <Skeleton className="h-4 w-4" />
                          </td>
                        )}
                        {cols.map((c, j) => (
                          <td key={c.key} className="px-3 py-3">
                            <Skeleton className={cn("h-4", j === 0 ? "w-40" : "w-20")} />
                          </td>
                        ))}
                      </tr>
                    ))
                  : rows.map((r) => (
                      <tr
                        key={r.id}
                        data-row={r.id}
                        tabIndex={onRowClick ? 0 : undefined}
                        onClick={() => onRowClick?.(r)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && e.target === e.currentTarget) onRowClick?.(r);
                        }}
                        className={cn(
                          "border-b border-border transition-colors last:border-0",
                          onRowClick && "cursor-pointer hover:bg-subtle",
                          (sel.has(r.id) || activeId === r.id) && "bg-primary-soft/40",
                        )}
                      >
                        {selectable && (
                          <td className="px-3 py-2.5">
                            <Checkbox
                              checked={sel.has(r.id)}
                              onChange={() => toggle(r.id)}
                              label={tr("选择", "Select")}
                            />
                          </td>
                        )}
                        {cols.map((c) => (
                          <td
                            key={c.key}
                            className={cn("px-3 py-2.5 align-middle", c.align === "right" && "text-right", c.className)}
                          >
                            {c.cell(r)}
                          </td>
                        ))}
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border md:hidden" aria-label={label}>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <li key={i} className="space-y-2 px-3 py-3">
                    <Skeleton className="h-4 w-44" />
                    <Skeleton className="h-3 w-64" />
                  </li>
                ))
              : rows.map((r) => (
                  <li
                    key={r.id}
                    data-row={r.id}
                    className={cn("flex gap-3 px-3 py-3", sel.has(r.id) && "bg-primary-soft/40")}
                  >
                    {selectable && (
                      <div className="pt-0.5">
                        <Checkbox checked={sel.has(r.id)} onChange={() => toggle(r.id)} label={tr("选择", "Select")} />
                      </div>
                    )}
                    {onRowClick ? (
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => onRowClick(r)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(r);
                        }}
                        className="flex min-w-0 flex-1 cursor-pointer gap-3 active:bg-subtle"
                      >
                        {card(r)}
                        <Icon name="chevronRight" size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                      </div>
                    ) : (
                      <div className="flex min-w-0 flex-1 gap-3">{card(r)}</div>
                    )}
                  </li>
                ))}
          </ul>
        </>
      )}
      {footer && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}

export function Pager({
  total,
  offset,
  limit,
  onOffset,
}: {
  total: number;
  offset: number;
  limit: number;
  onOffset: (o: number) => void;
}) {
  const tr = useTr();
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.floor(offset / limit) + 1;
  return (
    <>
      <span>{tr(`共 ${total.toLocaleString()} 条`, `${total.toLocaleString()} total`)}</span>
      <div className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          icon="chevronLeft"
          disabled={page <= 1}
          aria-label={tr("上一页", "Previous page")}
          onClick={() => onOffset(Math.max(0, offset - limit))}
        />
        <span className="px-1">
          {page} / {pages}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          icon="chevronRight"
          disabled={page >= pages}
          aria-label={tr("下一页", "Next page")}
          onClick={() => onOffset(offset + limit)}
        />
      </div>
    </>
  );
}

/** Small removable filter chip for table toolbars. */
export function FilterChip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  const tr = useTr();
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-subtle pl-2.5 pr-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
      <button
        type="button"
        onClick={onClear}
        className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={tr(`清除筛选：${label}`, `Clear filter: ${label}`)}
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}
