// 设置积木（2026-10 改版；v2 kit：设置分区之外，套餐 / 优惠券等编辑弹窗也用
// useDraft + SRow；页面级"唯一保存栏"用 SectionForm + useSavePart）：
// - 保存栏：每个分区只有一种保存方式。分区里的每一块表单（SavePart）登记
//   "改了几项、有几处错误、怎么保存、怎么放弃"，页面底部的保存栏汇总并依次
//   保存（危险的修改在各自的 save 里确认）。
// - useDraft：表单 = 服务器的值 + 只记改动的补丁，所以重新获取（窗口回到
//   前台、别处的写入）不会冲掉正在编辑的内容；补丁里与服务器相同的键自动
//   去掉，"未保存的修改"数就是补丁的键数。数字框保存原始字符串，保存前校验。
// - 行：标签与说明在左、控件在右（手机上叠放），错误写在字段下面并关联到
//   控件（aria-invalid / aria-describedby）。
import type { UseQueryResult } from "@tanstack/react-query";
import { CircleAlert, Lock, Search, TriangleAlert } from "lucide-react";
import { useBlocker } from "react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "../../shared/cn";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { useConfirm } from "../../shared/ui/confirm";
import { Input, Kbd, MOD_KEY, Switch } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { useToast } from "../../shared/ui/toast";
import { useErrText } from "../kit";
import { useMe } from "../session";
import { Popover } from "../../shared/ui/menu";
import { ErrorState, LoadingBlock } from "../../shared/ui/states";

// ---------------------------------------------------------------------------
// The save bar registry
// ---------------------------------------------------------------------------

export type SavePart = {
  /** Unsaved changes in this part. */
  count: number;
  /** Fields that must be fixed before saving. */
  errors: number;
  /** Save (confirming what is dangerous). false = cancelled or failed: stop. */
  save: () => Promise<boolean>;
  discard: () => void;
};

export type SaveRegistry = {
  set: (id: string, part: { current: SavePart }) => void;
  remove: (id: string) => void;
  bump: () => void;
};

export const SaveContext = createContext<SaveRegistry | null>(null);

/** Register a form part with the section's save bar. */
export function useSavePart(part: SavePart): void {
  const reg = useContext(SaveContext);
  const id = useId();
  const ref = useRef(part);
  ref.current = part;
  useEffect(() => {
    if (!reg) return;
    reg.set(id, ref);
    return () => reg.remove(id);
  }, [reg, id]);
  useEffect(() => {
    reg?.bump();
  }, [reg, part.count, part.errors]);
}

/**
 * One save scope (a settings section, or any page with the same "one save
 * bar" rule): collects the `useSavePart` parts inside, shows the floating
 * SaveBar while anything is edited (N 项未保存的修改 · N 处需要修正 · 放弃 ·
 * 保存 ⌘S), saves the parts in order (each confirms its dangerous changes),
 * and guards leaving (in-app navigation and the browser) with unsaved edits.
 */
export function SectionForm({ children }: { children: ReactNode }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrText();
  const parts = useRef(new Map<string, { current: SavePart }>());
  const [, setTick] = useState(0);
  const registry = useMemo<SaveRegistry>(
    () => ({
      set: (id, part) => {
        parts.current.set(id, part);
        setTick((t) => t + 1);
      },
      remove: (id) => {
        parts.current.delete(id);
        setTick((t) => t + 1);
      },
      bump: () => setTick((t) => t + 1),
    }),
    [],
  );
  const all = [...parts.current.values()].map((p) => p.current);
  const count = all.reduce((n, p) => n + p.count, 0);
  const errors = all.reduce((n, p) => n + (p.count > 0 ? p.errors : 0), 0);
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);
  dirty.current = count > 0;

  // A save asked for while one runs (⌘S pressed again right after an edit) is
  // not dropped: it runs once the first has finished, with the latest values.
  const busy = useRef(false);
  const again = useRef(false);
  const save = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    const list = [...parts.current.values()].map((p) => p.current);
    if (list.some((p) => p.count > 0 && p.errors > 0)) return;
    busy.current = true;
    setSaving(true);
    let ok = true;
    try {
      for (const p of list)
        if (p.count > 0 && !(await p.save())) {
          ok = false;
          break;
        }
    } catch (e) {
      ok = false;
      toast({ tone: "error", title: errText(e) });
    } finally {
      busy.current = false;
      setSaving(false);
    }
    if (again.current) {
      again.current = false;
      // After the re-render, so the parts carry the values typed meanwhile.
      if (ok) setTimeout(() => dirty.current && void saveRef.current(), 0);
    }
  }, [toast, errText]);
  const discard = () => {
    for (const p of parts.current.values()) p.current.discard();
  };

  // ⌘/Ctrl+S saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty.current) void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leaving with unsaved changes asks (another section, another page, the browser).
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void confirm({
      title: tr("放弃未保存的修改？", "Discard unsaved changes?"),
      description: tr(
        `这个分区还有 ${count} 项修改没有保存，离开后不会保存。`,
        `${count} changes in this section are not saved; they are lost if you leave.`,
      ),
      confirmLabel: tr("放弃修改", "Discard"),
      tone: "warning",
    }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state]);
  useEffect(() => {
    if (count === 0) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [count]);

  // The bar floats over the bottom of the window, aligned with the section's column.
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; width: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || count === 0) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setPlace((p) => (p && p.left === r.left && p.width === r.width ? p : { left: r.left, width: r.width }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [count]);

  return (
    <SaveContext.Provider value={registry}>
      <div ref={box} className="pb-24">
        {children}
      </div>
      {count > 0 && (
        <SaveBar
          count={count}
          errors={errors}
          saving={saving}
          onDiscard={discard}
          onSave={() => void save()}
          style={place ? { left: place.left, width: place.width } : undefined}
        />
      )}
    </SaveContext.Provider>
  );
}

/**
 * The floating save bar (presentational; SectionForm drives it). Fixed over
 * the bottom of the window (above the phone tab bar); `style` aligns it with
 * the content column.
 */
export function SaveBar({
  count,
  errors,
  saving,
  onDiscard,
  onSave,
  style,
}: {
  count: number;
  errors: number;
  saving?: boolean;
  onDiscard: () => void;
  onSave: () => void;
  style?: CSSProperties;
}) {
  const tr = useTr();
  return (
    <div
      role="region"
      aria-label={tr("保存栏", "Save bar")}
      style={style}
      data-savebar
      className="glass fixed inset-x-3 bottom-[calc(60px+env(safe-area-inset-bottom))] z-20 flex items-center gap-3 rounded-2xl bg-popover px-4 py-2.5 shadow-pop animate-in fade-in-0 slide-in-from-bottom-2 lg:bottom-5"
    >
      <span
        className={cn("size-2 shrink-0 rounded-full", errors > 0 ? "bg-destructive" : "bg-warning")}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 text-body" role="status">
        <span className="font-medium">
          {tr(`${count} 项未保存的修改`, `${count} unsaved ${count === 1 ? "change" : "changes"}`)}
        </span>
        {errors > 0 && (
          <span className="ml-2 text-destructive max-sm:ml-0 max-sm:block">
            {tr(`· ${errors} 处需要修正`, `· ${errors} to fix`)}
          </span>
        )}
      </span>
      <Button variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>
        {tr("放弃", "Discard")}
      </Button>
      <Button variant="primary" size="sm" loading={saving} disabled={errors > 0} onClick={onSave}>
        {tr("保存", "Save")}
        <span aria-hidden="true" className="max-sm:hidden">
          <Kbd className="bg-white/20 text-white">{MOD_KEY === "⌘" ? "⌘S" : "Ctrl S"}</Kbd>
        </span>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export type Draft<T> = {
  /** Server values with the edits on top (undefined while loading). */
  value: T | undefined;
  set: <K extends keyof T>(k: K, v: T[K]) => void;
  /** Keys edited (and different from the server). */
  edited: (keyof T)[];
  isEdited: (k: keyof T) => boolean;
  reset: () => void;
};

export function useDraft<T extends object>(base: T | undefined): Draft<T> {
  const [patch, setPatch] = useState<Partial<T>>({});
  const baseRef = useRef(base);
  baseRef.current = base;
  const set = useCallback(<K extends keyof T>(k: K, v: T[K]) => {
    setPatch((p) => {
      const n = { ...p };
      if (baseRef.current && same(baseRef.current[k], v)) delete n[k];
      else n[k] = v;
      return n;
    });
  }, []);
  const edited = base ? (Object.keys(patch) as (keyof T)[]).filter((k) => !same(base[k], patch[k])) : [];
  return {
    value: base ? { ...base, ...patch } : undefined,
    set,
    edited,
    isEdited: (k) => edited.includes(k),
    reset: useCallback(() => setPatch({}), []),
  };
}

// ---------------------------------------------------------------------------
// Validation (numbers stay strings while editing; NaN is never sent)
// ---------------------------------------------------------------------------

const INT = /^-?\d+$/;

/** Error text of an integer field in [min, max] (`blank` = what an empty field means, if allowed). */
export function intError(raw: string, min: number, max: number, tr: Tr, blankOk = false): string | undefined {
  const t = raw.trim();
  if (t === "") return blankOk ? undefined : tr("必填", "Required");
  if (!INT.test(t)) return tr("请输入整数", "Enter a whole number");
  const n = Number(t);
  if (n < min || n > max) return tr(`请输入 ${min}–${max} 的整数`, `Enter a whole number from ${min} to ${max}`);
  return undefined;
}

/** v2 name: integer in [min, max]; `blank` = what an empty field means (then blank is allowed). */
export function intErr(raw: string, min: number, max: number, tr: Tr, blank?: string): string | undefined {
  const e = intError(raw, min, max, tr, blank !== undefined);
  return e && blank && raw.trim() !== "" ? tr(`${e}，留空 = ${blank}`, `${e}; blank = ${blank}`) : e;
}

/** The integer of a validated field (null = blank). */
export function intOf(raw: string): number | null {
  const t = raw.trim();
  return t === "" ? null : Number(t);
}

/** A number as the text of a field (null = blank). */
export const numText = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** Non-empty lines of a text area, trimmed. */
export const lines = (t: string) =>
  t
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z][a-z0-9-]{0,62}$/i;
const LOCALHOST = /^([a-z0-9-]+\.)*localhost(:\d{1,5})?$/i;

/** Error text of a host name (a full domain with a dot and a top-level domain; *.localhost allowed). */
export function domainError(raw: string, tr: Tr): string | undefined {
  const v = raw.trim();
  if (!v) return tr("请输入域名", "Enter a domain");
  if (/^https?:\/\//i.test(v) || v.includes("/"))
    return tr("只填域名，不要带 http:// 或路径", "Just the host name, without http:// or a path");
  if (LOCALHOST.test(v)) return undefined;
  const host = v.replace(/:\d{1,5}$/, "");
  if (!DOMAIN.test(host))
    return tr(
      `「${v}」不是完整域名：需要至少一个点和有效的顶级域，例如 portal.example.com`,
      `"${v}" is not a full domain: it needs a dot and a top-level domain, e.g. portal.example.com`,
    );
  return undefined;
}

/** Error text of an http(s) URL field (blank allowed when `blankOk`). */
export function urlError(raw: string, tr: Tr, blankOk = true): string | undefined {
  const v = raw.trim();
  if (!v) return blankOk ? undefined : tr("必填", "Required");
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
  } catch {
    return tr("请输入以 https:// 开头的完整地址", "Enter a full address starting with https://");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Aria wiring a control in a FieldRow takes. */
export type FieldAria = {
  id: string;
  "aria-labelledby": string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

/**
 * A labelled row: label and description on the left, the control on the
 * right (stacked on a phone, or always with `stack` for wide controls). The
 * control is named by the label only (getByLabel(label)), described by the
 * error or the description.
 */
export function FieldRow({
  label,
  description,
  error,
  stack,
  children,
  className,
  changed,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  stack?: boolean;
  children: (a: FieldAria) => ReactNode;
  className?: string;
  /** v2: blue bar on the left while the value differs from the saved one. */
  changed?: boolean;
}) {
  const id = useId();
  const aria: FieldAria = {
    id,
    "aria-labelledby": `${id}-l`,
    "aria-describedby": error ? `${id}-e` : description ? `${id}-d` : undefined,
    ...(error ? { "aria-invalid": true as const } : {}),
  };
  return (
    <div className={cn("relative px-4 py-2.5", className)}>
      {changed && <ChangedBar />}
      <div
        className={cn(
          "flex flex-wrap gap-x-4 gap-y-2",
          stack ? "flex-col" : "items-center justify-between max-sm:flex-col max-sm:items-stretch",
        )}
      >
        <div className={cn("min-w-0", !stack && "sm:flex-1 sm:basis-56")}>
          <label id={`${id}-l`} htmlFor={id} className="block text-body font-medium">
            {label}
          </label>
          {description && (
            <div id={`${id}-d`} className="mt-0.5 text-footnote text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        <div className={cn("min-w-0", stack ? "w-full" : "w-full sm:w-auto sm:max-w-[60%] sm:shrink-0")}>
          {children(aria)}
        </div>
      </div>
      {error && (
        <p id={`${id}-e`} className={cn("mt-1 text-footnote text-destructive", !stack && "sm:text-right")}>
          {error}
        </p>
      )}
    </div>
  );
}

/** A switch row: the label names the switch; a click on the text toggles it. */
export function SwitchRow({
  label,
  name,
  description,
  checked,
  onChange,
  disabled,
  children,
  changed,
}: {
  changed?: boolean;
  label: string;
  /** The switch's accessible name when the label alone is ambiguous. */
  name?: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Shown under the row (a warning that belongs to it). */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="relative px-4 py-2.5">
      {changed && <ChangedBar />}
      <div className="flex min-h-7 items-center gap-4">
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="block text-body font-medium">
            {label}
          </label>
          {description && <div className="mt-0.5 text-footnote text-muted-foreground">{description}</div>}
        </div>
        <Switch id={id} label={name ?? label} checked={checked} onChange={onChange} disabled={disabled} />
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** A read-only line in a group (label left, value right). */
export function InfoRow({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-body font-medium">{label}</div>
        {description && <div className="mt-0.5 text-footnote text-muted-foreground">{description}</div>}
      </div>
      {children && <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** The separate, red-outlined area at the bottom of a section. */
export function DangerZone({ children }: { children: ReactNode }) {
  const tr = useTr();
  return (
    <section className="grid gap-1.5" aria-label={tr("危险操作", "Danger zone")}>
      <h3 className="flex items-center gap-1.5 px-1 text-footnote font-semibold text-destructive">
        <TriangleAlert className="size-3.5" aria-hidden="true" />
        {tr("危险操作", "Danger zone")}
      </h3>
      <div className="divide-y divide-separator overflow-hidden rounded-xl bg-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--destructive)_32%,transparent)]">
        {children}
      </div>
    </section>
  );
}

/** "Only the owner may change this" (R47). */
export function OwnerBadge() {
  const tr = useTr();
  return (
    <Badge tone="neutral">
      <Lock aria-hidden="true" />
      {tr("仅所有者可修改", "Owner only")}
    </Badge>
  );
}

/** The warnings a settings endpoint returns, as one callout list. */
export function Warnings({ items }: { items: string[] | undefined }) {
  if (!items?.length) return null;
  return (
    <div className="flex gap-2.5 rounded-xl bg-warning-soft px-4 py-3 text-body">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <ul className="grid gap-1">
        {items.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

/** A query's three states: skeleton, error with retry, the content. */
export function Loaded<T>({
  q,
  children,
  rows = 6,
}: {
  q: Pick<UseQueryResult<T>, "data" | "error" | "refetch">;
  children: (d: T) => ReactNode;
  rows?: number;
}) {
  if (q.data !== undefined) return <>{children(q.data)}</>;
  if (q.error)
    return (
      <div className="rounded-xl bg-card shadow-card">
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      </div>
    );
  return (
    <div className="rounded-xl bg-card px-4 py-2 shadow-card">
      <LoadingBlock rows={rows} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time zone picker (searchable)
// ---------------------------------------------------------------------------

function timeZones(): string[] {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {
    list = [];
  }
  const extra = ["UTC", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Singapore", "Europe/London"];
  return [...new Set([...extra.filter((z) => !list.includes(z)), ...list])];
}

/** The site time zone: a button that opens a searchable list ("" = the default). */
export function TimeZonePicker({
  value,
  defaultZone,
  onChange,
  aria,
  disabled,
}: {
  value: string;
  defaultZone: string;
  onChange: (z: string) => void;
  aria: FieldAria;
  disabled?: boolean;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const all = useMemo(timeZones, []);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/\s+/g, "_");
    return (t ? all.filter((z) => z.toLowerCase().includes(t)) : all).slice(0, 80);
  }, [all, q]);
  const pick = (z: string) => {
    onChange(z);
    setOpen(false);
    setQ("");
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={tr("选择时区", "Choose a time zone")}
      className="w-[min(320px,calc(100vw-24px))]"
      trigger={
        <Button
          variant="outline"
          className="w-full justify-between font-normal sm:min-w-56"
          disabled={disabled}
          {...aria}
        >
          <span className="truncate">{value || tr(`默认（${defaultZone}）`, `Default (${defaultZone})`)}</span>
        </Button>
      }
    >
      <div className="relative mb-1.5">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint"
          aria-hidden="true"
        />
        <Input
          data-nodirty
          aria-label={tr("搜索时区", "Search time zones")}
          placeholder={tr("搜索，如 Tokyo", "Search, e.g. Tokyo")}
          className="pl-8"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) {
              e.preventDefault();
              pick(hits[0]);
            }
          }}
        />
      </div>
      <div role="listbox" aria-label={tr("时区", "Time zones")} className="scroll-thin max-h-64 overflow-y-auto">
        {!q && (
          <button
            type="button"
            role="option"
            aria-selected={value === ""}
            onClick={() => pick("")}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-body hover:bg-accent aria-selected:font-semibold"
          >
            {tr(`默认（${defaultZone}）`, `Default (${defaultZone})`)}
          </button>
        )}
        {hits.map((z) => (
          <button
            key={z}
            type="button"
            role="option"
            aria-selected={value === z}
            onClick={() => pick(z)}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-body hover:bg-accent aria-selected:font-semibold aria-selected:text-primary"
          >
            {z}
          </button>
        ))}
        {hits.length === 0 && (
          <p className="px-2 py-3 text-footnote text-muted-foreground">
            {tr("没有匹配的时区", "No matching time zone")}
          </p>
        )}
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const WIDE = "(min-width: 1024px)";

/** ≥1024px: the group navigation next to the section; below it the list → detail flow. */
export function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(WIDE);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

// ---------------------------------------------------------------------------
// v2 rows and blocks
// ---------------------------------------------------------------------------

/** The blue bar on the left of an edited row (and "已修改" for screen readers). */
function ChangedBar() {
  const tr = useTr();
  return (
    <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" data-changed>
      <span className="sr-only">{tr("已修改", "Edited")}</span>
    </span>
  );
}

/**
 * A settings-style row (v2 SRow): label + description left, controls right,
 * the error underneath; `changed` = blue bar on the left, `locked` = lock
 * after the label (owner only), `wide` = the controls take a full line on a
 * phone. For a labelled single control prefer `FieldRow` (aria wiring);
 * SRow is for rows with several controls or a custom one.
 */
export function SRow({
  label,
  description,
  children,
  changed,
  error,
  locked,
  wide,
  icon,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  changed?: boolean;
  error?: ReactNode;
  locked?: boolean;
  wide?: boolean;
  icon?: ReactNode;
  className?: string;
}) {
  const tr = useTr();
  return (
    <div className={cn("relative flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5", className)}>
      {changed && <ChangedBar />}
      <div className={cn("flex min-w-0 flex-1 items-center gap-3", wide && "max-sm:basis-full")}>
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-body font-medium">
            {label}
            {locked && (
              <Lock className="size-3 text-faint" role="img" aria-label={tr("仅所有者可修改", "Owner only")} />
            )}
          </div>
          {description && <div className="mt-0.5 text-footnote text-muted-foreground">{description}</div>}
        </div>
      </div>
      {children && (
        <div className={cn("flex shrink-0 items-center gap-2", wide && "max-sm:w-full max-sm:[&>*]:flex-1")}>
          {children}
        </div>
      )}
      {error && (
        <p
          className="flex basis-full items-center justify-end gap-1 text-footnote text-destructive max-sm:justify-start"
          role="alert"
        >
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

/** A row inside DangerZone: label + consequence, the action (if any) on the right. */
export function DangerRow({
  label,
  description,
  action,
  locked,
}: {
  label: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  locked?: boolean;
}) {
  const tr = useTr();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex items-center gap-1.5 text-body font-medium">
          {label}
          {locked && <Lock className="size-3 text-faint" role="img" aria-label={tr("仅所有者可修改", "Owner only")} />}
        </div>
        {description && <div className="mt-0.5 text-footnote text-muted-foreground">{description}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/** Whether the signed-in admin is the owner (R47: owner-only sections are read-only otherwise). */
export function useOwner(): boolean {
  return useMe().is_owner;
}

/** "Only the owner may change this" banner at the top of a read-only section. */
export function OwnerNotice({ what }: { what?: string }) {
  const tr = useTr();
  return (
    <Banner tone="info" icon={<Lock />} title={tr("仅所有者可修改", "Owner only")}>
      {tr(
        `你以管理员身份登录，${what ?? "这个分区"}对你只读。需要修改时请联系所有者。`,
        `You are signed in as an admin: ${what ?? "this section"} is read-only for you. Ask the owner to change it.`,
      )}
    </Banner>
  );
}

/** A grey read-only value in place of a control (locked rows). */
export function ReadValue({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-8 items-center rounded-md bg-window px-2.5 text-body text-muted-foreground ring-1 ring-border ring-inset",
        mono && "font-mono text-footnote",
      )}
    >
      {children}
    </span>
  );
}

/** A titled block without the group frame (free layout inside a section). */
export function Panel({
  title,
  footer,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  footer?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("grid gap-1.5", className)}>
      {(title || action) && (
        <div className="flex items-end gap-2 px-1">
          <h3 className="flex-1 text-footnote font-semibold text-muted-foreground">{title}</h3>
          {action}
        </div>
      )}
      {children}
      {footer && <p className="px-1 text-footnote text-faint">{footer}</p>}
    </section>
  );
}
