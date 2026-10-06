import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import { errorText } from "../errors";
import { useLang, useTr } from "../i18n";
import { Icon, type IconName } from "./icons";
import { Button, Input } from "./primitives";

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
}

/** Focus the first field (or the panel) on open; give focus back on close. */
function useFocusIn(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus], input:not([type=hidden]), select, textarea");
    (first ?? el)?.focus();
    return () => before?.focus?.();
  }, [open]);
  return ref;
}

/* ---------- Drawer (details) ---------- */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  actions,
  footer,
  width = "sm:max-w-xl",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  width?: string;
  children: ReactNode;
}) {
  const tr = useTr();
  const id = useId();
  useEscape(open, onClose);
  const ref = useFocusIn(open);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className={cn(
          "anim-drawer absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-card shadow-pop outline-none",
          width,
        )}
      >
        <header className="flex items-start gap-3 border-b border-border px-4 py-4 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 id={id} className="truncate text-base font-semibold">
              {title}
            </h2>
            {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
          </div>
          {actions}
          <Button variant="ghost" size="icon-sm" icon="x" aria-label={tr("关闭", "Close")} onClick={onClose} />
        </header>
        <div className="scroll-thin flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer && (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3 sm:px-5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/* ---------- Dialog ---------- */
export function Dialog({
  open,
  onClose,
  title,
  description,
  icon,
  tone = "default",
  footer,
  children,
  wide,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  tone?: "default" | "danger" | "warning";
  footer?: ReactNode;
  children?: ReactNode;
  wide?: boolean;
  /** Makes the dialog a form: Enter submits. */
  onSubmit?: () => void;
}) {
  const id = useId();
  useEscape(open, onClose);
  const ref = useFocusIn(open);
  if (!open) return null;
  const iconStyle =
    tone === "danger"
      ? "bg-destructive-soft text-destructive"
      : tone === "warning"
        ? "bg-warning-soft text-warning"
        : "bg-primary-soft text-primary";
  const body = (
    <>
      <div className="flex gap-3 px-5 pt-5">
        {icon && (
          <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", iconStyle)}>
            <Icon name={icon} size={18} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {description && <div className="mt-1 text-[13px] text-muted-foreground">{description}</div>}
        </div>
      </div>
      {children && <div className="scroll-thin max-h-[65vh] overflow-y-auto px-5 pt-4">{children}</div>}
      <div className="mt-5 flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
        {footer}
      </div>
    </>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className={cn(
          "anim-in relative max-h-full w-full rounded-t-xl border border-border bg-popover shadow-pop outline-none sm:rounded-xl",
          wide ? "sm:max-w-2xl" : "sm:max-w-md",
        )}
      >
        {onSubmit ? (
          <form
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </div>
  );
}

/* ---------- Confirm ----------
 * Destructive confirmations state the affected count (`impact`); with
 * `typeToConfirm` the admin must also type the phrase. `confirm()` resolves
 * true on confirm; with `action` the dialog runs it (spinner, error shown
 * in place) and resolves after it succeeded.
 */
export type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  impact?: ReactNode;
  details?: ReactNode;
  confirmLabel?: string;
  tone?: "danger" | "warning" | "default";
  typeToConfirm?: string;
  action?: () => Promise<unknown>;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn>(async () => false);
export const useConfirm = () => useContext(ConfirmContext);

function ConfirmDialog({ pending, onDone }: { pending: Pending | null; onDone: (ok: boolean) => void }) {
  const tr = useTr();
  const lang = useLang();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTyped("");
    setError(null);
    setBusy(false);
  }, [pending]);
  if (!pending) return null;
  const tone = pending.tone ?? "danger";
  const blocked = pending.typeToConfirm !== undefined && typed.trim() !== pending.typeToConfirm;
  const run = async () => {
    if (blocked || busy) return;
    if (!pending.action) return onDone(true);
    setBusy(true);
    setError(null);
    try {
      await pending.action();
      onDone(true);
    } catch (e) {
      setError(errorText(e, lang));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => !busy && onDone(false)}
      title={pending.title}
      description={pending.description}
      icon={tone === "default" ? "info" : "alert"}
      tone={tone}
      onSubmit={run}
      footer={
        <>
          <Button onClick={() => onDone(false)} disabled={busy}>
            {tr("取消", "Cancel")}
          </Button>
          <Button
            type="submit"
            variant={tone === "danger" ? "destructive" : "primary"}
            disabled={blocked}
            loading={busy}
          >
            {pending.confirmLabel ?? tr("确认", "Confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {pending.impact && (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-sm font-medium",
              tone === "danger"
                ? "border-destructive/30 bg-destructive-soft text-destructive"
                : "border-warning/40 bg-warning-soft text-warning",
            )}
          >
            {pending.impact}
          </div>
        )}
        {pending.details}
        {pending.typeToConfirm !== undefined && (
          <label className="block space-y-1.5">
            <span className="text-[13px] text-muted-foreground">
              {tr("二次确认：请输入", "Second confirmation: type")}{" "}
              <code className="rounded bg-muted px-1 font-mono text-foreground">{pending.typeToConfirm}</code>
            </span>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={pending.typeToConfirm}
              aria-label={tr("确认文字", "Confirmation text")}
              data-autofocus
            />
          </label>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/* ---------- Toast ---------- */
type ToastItem = { id: number; tone: "success" | "error" | "info"; title: string; description?: string };
type ToastFn = (t: Omit<ToastItem, "id">) => void;
const ToastContext = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastContext);

export function Providers({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback<ToastFn>((t) => {
    const id = ++seq.current;
    setToasts((xs) => [...xs.slice(-3), { ...t, id }]);
    window.setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.tone === "error" ? 8000 : 4500);
  }, []);
  const confirm = useCallback<ConfirmFn>((o) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })), []);
  return (
    <ConfirmContext.Provider value={confirm}>
      <ToastContext.Provider value={push}>
        {children}
        <ConfirmDialog
          pending={pending}
          onDone={(ok) => {
            pending?.resolve(ok);
            setPending(null);
          }}
        />
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
        >
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} onDismiss={() => setToasts((xs) => xs.filter((x) => x.id !== t.id))} />
          ))}
        </div>
      </ToastContext.Provider>
    </ConfirmContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const icon: IconName = toast.tone === "success" ? "check" : toast.tone === "error" ? "alert" : "info";
  const color =
    toast.tone === "success"
      ? "text-success bg-success-soft"
      : toast.tone === "error"
        ? "text-destructive bg-destructive-soft"
        : "text-info bg-info-soft";
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      data-toast={toast.tone}
      className="anim-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-border bg-popover p-3 shadow-pop"
    >
      <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", color)}>
        <Icon name={icon} size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{toast.title}</div>
        {toast.description && <div className="mt-0.5 text-xs text-muted-foreground">{toast.description}</div>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-muted-foreground hover:text-foreground"
        aria-label="close"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

/* ---------- Popover / menu ---------- */
export function Popover({
  open,
  onClose,
  children,
  align = "right",
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden="true" />
      <div
        role="menu"
        className={cn(
          "anim-in absolute top-full z-40 mt-1 min-w-48 rounded-lg border border-border bg-popover p-1 shadow-pop",
          align === "right" ? "right-0" : "left-0",
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  disabled,
}: {
  icon?: IconName;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-muted disabled:opacity-50",
        danger && "text-destructive hover:bg-destructive-soft",
      )}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
}

/** A "⋯" button with a menu of actions. */
export function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    // A clickable row around the menu must not see its clicks.
    <div
      className="relative"
      role="presentation"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Button variant="ghost" size="icon-sm" icon="more" aria-label={label} onClick={() => setOpen((v) => !v)} />
      <Popover open={open} onClose={close}>
        {children(close)}
      </Popover>
    </div>
  );
}
