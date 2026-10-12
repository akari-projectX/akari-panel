// Confirmations (alertdialog). Destructive ones state the impact (`impact`,
// or a list in `impacts` with counts from the backend preview) and, for
// deletions, require typing a phrase (`typeToConfirm`). Focus starts on
// Cancel (or on the phrase box), so Enter never fires the dangerous action
// by accident. `confirm()` resolves true on confirm; with `action` the
// dialog runs it (spinner, the error shown in place) and resolves after it
// succeeded. Esc closes only this layer, never the dialog underneath.
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { AlertDialog as A } from "radix-ui";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { cn } from "../cn";
import { errorText } from "../errors";
import { useLang, useTr } from "../i18n";
import { Button } from "./button";
import { Input, Kbd } from "./form";

export type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  /** One highlighted impact line ("3 users lose access"). */
  impact?: ReactNode;
  /** An impact list (label → value), e.g. counts from a preview endpoint. */
  impacts?: { label: ReactNode; value: ReactNode }[];
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

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback<ConfirmFn>((o) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })), []);
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        pending={pending}
        onDone={(ok) => {
          pending?.resolve(ok);
          setPending(null);
        }}
      />
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ pending, onDone }: { pending: Pending | null; onDone: (ok: boolean) => void }) {
  const tr = useTr();
  const lang = useLang();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Pending | null>(pending);
  useEffect(() => {
    setTyped("");
    setError(null);
    setBusy(false);
    if (pending) setShown(pending);
  }, [pending]);
  const p = pending ?? shown;
  if (!p) return null;
  const tone = p.tone ?? "danger";
  const blocked = p.typeToConfirm !== undefined && typed.trim() !== p.typeToConfirm;
  const run = async () => {
    if (blocked || busy || !pending) return;
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
  const Icon = tone === "default" ? Info : TriangleAlert;
  return (
    <A.Root open={!!pending} onOpenChange={(o) => !o && !busy && onDone(false)}>
      <A.Portal>
        <A.Overlay
          data-slot="alert-dialog-overlay"
          className="fixed inset-0 z-50 bg-(--scrim) backdrop-blur-[2px] data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <A.Content
          data-slot="alert-dialog-content"
          onOpenAutoFocus={(e) => {
            const box = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[data-autofocus]");
            if (box) {
              e.preventDefault();
              box.focus();
            }
          }}
          className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-card p-5 shadow-dialog data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97]"
        >
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <div className="flex gap-3.5">
              <span
                className={cn(
                  "inline-flex size-10 shrink-0 items-center justify-center rounded-full",
                  tone === "danger"
                    ? "bg-destructive-soft text-destructive"
                    : tone === "warning"
                      ? "bg-warning-soft text-warning"
                      : "bg-primary-soft text-primary",
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <A.Title className="text-title3 font-semibold tracking-[-0.015em]">{p.title}</A.Title>
                {p.description ? (
                  <A.Description asChild>
                    <div className="mt-1 text-body text-muted-foreground">{p.description}</div>
                  </A.Description>
                ) : (
                  <A.Description className="sr-only">{p.title}</A.Description>
                )}
              </div>
            </div>
            <div className="mt-4 grid gap-3">
              {p.impact && (
                <div
                  className={cn(
                    "rounded-lg px-3 py-2 text-body font-medium",
                    tone === "danger" ? "bg-destructive-soft text-destructive" : "bg-warning-soft text-warning",
                  )}
                >
                  {p.impact}
                </div>
              )}
              {p.impacts && p.impacts.length > 0 && (
                <dl className="divide-y divide-separator rounded-lg bg-window ring-1 ring-border ring-inset">
                  {p.impacts.map((it, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-body">
                      <dt className="text-muted-foreground">{it.label}</dt>
                      <dd className="tnum font-medium">{it.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {p.details}
              {p.typeToConfirm !== undefined && (
                <label className="grid gap-1.5 text-footnote text-muted-foreground">
                  <span>
                    {tr("输入", "Type")}{" "}
                    <code className="rounded bg-secondary px-1 py-0.5 font-mono text-foreground">
                      {p.typeToConfirm}
                    </code>{" "}
                    {tr("以确认", "to confirm")}
                  </span>
                  <Input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={p.typeToConfirm}
                    aria-label={tr("确认文字", "Confirmation text")}
                    autoComplete="off"
                    spellCheck={false}
                    data-autofocus
                  />
                </label>
              )}
              {error && (
                <p role="alert" className="flex items-start gap-1.5 text-body text-destructive">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {error}
                </p>
              )}
            </div>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <A.Cancel asChild>
                <Button variant="secondary" disabled={busy} aria-keyshortcuts="Escape">
                  {tr("取消", "Cancel")}
                  <Kbd className="ml-1 bg-transparent max-sm:hidden" aria-hidden="true">
                    Esc
                  </Kbd>
                </Button>
              </A.Cancel>
              <Button
                type="submit"
                variant={tone === "danger" ? "destructive" : "primary"}
                disabled={blocked}
                loading={busy}
              >
                {p.confirmLabel ?? tr("确认", "Confirm")}
              </Button>
            </div>
          </form>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
