// DataTable: selection + bulk bar ("selected" vs. "all N matching"),
// column chooser (remembered per table), skeleton / empty / error states,
// phone card layout (with select-all and the current row highlighted),
// window-scrolled virtual rows for long lists, and a pager with page size
// and jump-to-page.
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight, Columns3, Inbox, SearchX, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../cn";
import { useTr } from "../i18n";
import { Button } from "./button";
import { Checkbox, Select } from "./form";
import { Popover } from "./menu";
import { EmptyState, ErrorState, Skeleton } from "./states";

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

/** Rows beyond which the table renders only what is on screen. */
const VIRTUAL_FROM = 120;
/** Estimated row height: table row on a desktop, card on a phone (md breakpoint). */
const rowHeight = () => (typeof matchMedia !== "undefined" && matchMedia("(max-width: 767px)").matches ? 74 : 46);

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
  filtered,
  onClearFilters,
  footer,
  activeId,
  storageKey,
  label,
  rowProps,
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
  /** A custom empty state (else: "nothing yet", or "nothing matches" when `filtered`). */
  empty?: ReactNode;
  /** Filters or a search are active: the empty state says so and offers to clear them. */
  filtered?: boolean;
  onClearFilters?: () => void;
  footer?: ReactNode;
  activeId?: string | null;
  storageKey?: string;
  label: string;
  /** Extra attributes per row (e.g. data-* hooks). */
  rowProps?: (row: T) => Record<string, string | undefined>;
}) {
  const tr = useTr();
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(readCols(storageKey) ?? columns.filter((c) => !c.optional).map((c) => c.key)),
  );
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
  const togglePage = () => onSelectedChange?.(allSelected ? new Set() : new Set([...sel, ...rows.map((r) => r.id)]));
  const title = columns.find((c) => c.mobile === "title") ?? columns[0];
  const metas = cols.filter((c) => c !== title && c.mobile !== "hide");
  const card = (r: T) => (
    <div className="min-w-0 flex-1">
      <div className="text-callout font-medium">{title.cell(r)}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-footnote text-muted-foreground">
        {metas.map((c) => (
          <span key={c.key} className="flex min-w-0 items-center gap-1">
            {c.cell(r)}
          </span>
        ))}
      </div>
    </div>
  );
  const choosable = columns.filter((c) => !c.fixed);
  const showToolbar = toolbar !== undefined || choosable.length > 0;

  // Long lists: only the rows on screen are in the DOM (the page scrolls).
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const virtual = !loading && rows.length > VIRTUAL_FROM;
  useLayoutEffect(() => {
    if (virtual && listRef.current) setMargin(listRef.current.getBoundingClientRect().top + window.scrollY);
  }, [virtual, rows.length]);
  const v = useWindowVirtualizer({
    count: virtual ? rows.length : 0,
    estimateSize: rowHeight,
    overscan: 12,
    scrollMargin: margin,
  });
  const items = virtual ? v.getVirtualItems() : [];
  const shown = virtual ? items.map((i) => rows[i.index]) : rows;
  const padTop = virtual && items.length ? items[0].start - margin : 0;
  const padBottom = virtual && items.length ? v.getTotalSize() - (items[items.length - 1].end - margin) : 0;

  const emptyState =
    empty ??
    (filtered ? (
      <EmptyState
        icon={SearchX}
        title={tr("没有匹配的记录", "No matching records")}
        description={tr("调整或清除筛选条件后再看。", "Adjust or clear the filters.")}
        action={
          onClearFilters && (
            <Button size="sm" variant="outline" onClick={onClearFilters}>
              {tr("清除筛选", "Clear filters")}
            </Button>
          )
        }
      />
    ) : (
      <EmptyState icon={Inbox} title={tr("暂无记录", "Nothing here yet")} />
    ));

  return (
    <div className="overflow-hidden rounded-xl bg-card shadow-card">
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2 border-b border-separator px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {choosable.length > 0 && (
            <Popover
              label={tr("显示的列", "Visible columns")}
              className="w-56"
              trigger={
                <Button size="sm" variant="ghost" icon={Columns3} aria-label={tr("显示的列", "Visible columns")}>
                  <span className="hidden sm:inline">{tr("列", "Columns")}</span>
                </Button>
              }
            >
              <div className="px-2 pt-1 pb-1.5 text-caption font-semibold text-faint">
                {tr("显示的列", "Visible columns")}
              </div>
              {choosable.map((c) => (
                <label
                  key={c.key}
                  className="flex h-8 items-center gap-2.5 rounded-[7px] px-2 text-body hover:bg-accent pointer-coarse:h-11"
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
                  {c.label ?? c.header}
                </label>
              ))}
            </Popover>
          )}
        </div>
      )}

      {selectable && sel.size > 0 && (
        <div
          data-testid="bulk-bar"
          className="anim-in flex flex-wrap items-center gap-2 border-b border-separator bg-primary-soft px-3 py-2 text-body"
        >
          <span className="font-medium">{tr(`已选 ${sel.size} 项`, `${sel.size} selected`)}</span>
          <Button size="sm" variant="link" onClick={() => onSelectedChange?.(new Set())}>
            {tr("清除", "Clear")}
          </Button>
          <div className="ml-auto flex flex-wrap gap-2">{bulkActions?.(sel.size)}</div>
        </div>
      )}

      {error && !loading ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : !loading && rows.length === 0 ? (
        emptyState
      ) : (
        <div ref={listRef}>
          <div className="scroll-thin hidden overflow-x-auto md:block" role="region" aria-label={label}>
            <table className="w-full text-body">
              <thead>
                <tr className="border-b border-separator bg-window text-left text-footnote text-muted-foreground">
                  {selectable && (
                    <th className="w-10 px-3 py-2">
                      <Checkbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        label={tr("全选本页", "Select page")}
                        onChange={togglePage}
                      />
                    </th>
                  )}
                  {cols.map((c) => (
                    <th
                      key={c.key}
                      className={cn(
                        "px-3 py-2 font-medium whitespace-nowrap",
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
                {padTop > 0 && (
                  <tr aria-hidden="true">
                    <td style={{ height: padTop }} colSpan={cols.length + (selectable ? 1 : 0)} />
                  </tr>
                )}
                {loading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i} className="border-b border-separator last:border-0">
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
                  : shown.map((r) => (
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
                          "h-11 border-b border-separator transition-colors last:border-0",
                          onRowClick &&
                            "cursor-pointer hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                          (sel.has(r.id) || activeId === r.id) && "bg-primary-soft hover:bg-primary-soft",
                        )}
                      >
                        {selectable && (
                          <td className="px-3 py-2">
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
                            className={cn(
                              "px-3 py-2 align-middle",
                              c.align === "right" && "tnum text-right",
                              c.className,
                            )}
                          >
                            {c.cell(r)}
                          </td>
                        ))}
                      </tr>
                    ))}
                {padBottom > 0 && (
                  <tr aria-hidden="true">
                    <td style={{ height: padBottom }} colSpan={cols.length + (selectable ? 1 : 0)} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="md:hidden">
            {selectable && !loading && rows.length > 0 && (
              <label className="flex h-11 items-center gap-3 border-b border-separator bg-window px-3 text-footnote text-muted-foreground">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  label={tr("全选本页", "Select page")}
                  onChange={togglePage}
                />
                {tr("全选本页", "Select page")}
              </label>
            )}
            <ul className="divide-y divide-separator" aria-label={label}>
              {padTop > 0 && <li aria-hidden="true" style={{ height: padTop }} />}
              {loading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <li key={i} className="grid gap-2 px-3 py-3">
                      <Skeleton className="h-4 w-44" />
                      <Skeleton className="h-3 w-64" />
                    </li>
                  ))
                : shown.map((r) => (
                    <li
                      key={r.id}
                      data-row={r.id}
                      {...rowProps?.(r)}
                      aria-current={activeId === r.id || undefined}
                      className={cn("flex gap-3 px-3 py-3", (sel.has(r.id) || activeId === r.id) && "bg-primary-soft")}
                    >
                      {selectable && (
                        <div className="pt-0.5">
                          <Checkbox
                            checked={sel.has(r.id)}
                            onChange={() => toggle(r.id)}
                            label={tr("选择", "Select")}
                          />
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
                          className="flex min-w-0 flex-1 cursor-pointer gap-3 active:opacity-70"
                        >
                          {card(r)}
                          <ChevronRight className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden="true" />
                        </div>
                      ) : (
                        <div className="flex min-w-0 flex-1 gap-3">{card(r)}</div>
                      )}
                    </li>
                  ))}
              {padBottom > 0 && <li aria-hidden="true" style={{ height: padBottom }} />}
            </ul>
          </div>
        </div>
      )}
      {footer && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-separator px-3 py-2 text-footnote text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}

export const PAGE_SIZES = [20, 50, 100, 200];

/** Pager: total, page n / m with jump, page size (when `onLimit` is given). */
export function Pager({
  total,
  offset,
  limit,
  onOffset,
  onLimit,
  totalLabel,
}: {
  total: number;
  offset: number;
  limit: number;
  onOffset: (o: number) => void;
  onLimit?: (l: number) => void;
  /** Override the "N total" text (e.g. "N loaded"). */
  totalLabel?: ReactNode;
}) {
  const tr = useTr();
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.floor(offset / limit) + 1;
  return (
    <>
      <span className="tnum">
        {totalLabel ?? tr(`共 ${total.toLocaleString()} 条`, `${total.toLocaleString()} total`)}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {onLimit && (
          <Select
            aria-label={tr("每页条数", "Rows per page")}
            value={String(limit)}
            onChange={(e) => onLimit(Number(e.target.value))}
            className="w-28"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {tr(`每页 ${n} 条`, `${n} / page`)}
              </option>
            ))}
          </Select>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          icon={ChevronLeft}
          disabled={page <= 1}
          aria-label={tr("上一页", "Previous page")}
          onClick={() => onOffset(Math.max(0, offset - limit))}
        />
        {pages > 2 ? (
          <Select
            aria-label={tr("跳到第几页", "Go to page")}
            value={String(page)}
            onChange={(e) => onOffset((Number(e.target.value) - 1) * limit)}
            className="w-24"
          >
            {Array.from({ length: Math.min(pages, 500) }, (_, i) => (
              <option key={i} value={i + 1}>
                {i + 1} / {pages}
              </option>
            ))}
          </Select>
        ) : (
          <span className="tnum px-1">
            {page} / {pages}
          </span>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          icon={ChevronRight}
          disabled={page >= pages}
          aria-label={tr("下一页", "Next page")}
          onClick={() => onOffset(offset + limit)}
        />
      </div>
    </>
  );
}

/** Small removable filter chip for table toolbars (44px clear target on touch). */
export function FilterChip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  const tr = useTr();
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-full bg-secondary pr-1 pl-2.5 text-footnote pointer-coarse:h-9">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
      <button
        type="button"
        onClick={onClear}
        className="hit-44 ml-0.5 inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={tr(`清除筛选：${label}`, `Clear filter: ${label}`)}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}
