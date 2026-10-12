// The one dialog (2026-10 redesign: details, editors and "new" forms are
// centred dialogs; the W33-a side drawers are gone).
// - Desktop: centred, four widths (440/560/780/980); fixed header (icon,
//   title, one line, close), optional tab row, body scrolls on its own,
//   fixed footer (danger actions left with `mr-auto`, primary right).
// - Phone (<640px): full screen, slides up from the bottom.
// - Keyboard: Esc closes only the topmost layer (Radix layer stack, shared
//   with the confirmations and menus); Enter submits when `onSubmit` is
//   given; focus is trapped and returns to the trigger; on open only a
//   control marked `data-autofocus` is focused (else the dialog itself), so
//   arrow keys never change a select by accident.
// - Unsaved changes: once a field inside was edited (or `dirty` is set),
//   Esc, a click on the scrim and the close button ask before discarding.
//   Controls that are not part of the form (search boxes) opt out with
//   `data-nodirty`. Footer buttons call `onClose` themselves (explicit).
import { X, type LucideIcon } from "lucide-react";
import { AlertDialog as A, Dialog as D } from "radix-ui";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { cn } from "../cn";
import { useTr } from "../i18n";
import { Button } from "./button";

const widths = {
  sm: "sm:max-w-[440px]",
  md: "sm:max-w-[560px]",
  lg: "sm:max-w-[780px]",
  xl: "sm:max-w-[980px]",
} as const;
export type DialogSize = keyof typeof widths;

const toneTile = {
  default: "bg-primary-soft text-primary",
  danger: "bg-destructive-soft text-destructive",
  warning: "bg-warning-soft text-warning",
} as const;

/** Toasts sit above every layer: clicking one is not "outside" a dialog. */
function fromToast(e: Event): boolean {
  const t = e.target as Element | null;
  return !!t?.closest?.("[data-sonner-toaster]");
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  tone = "default",
  size = "md",
  wide,
  actions,
  tabs,
  footer,
  children,
  onSubmit,
  dirty,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  tone?: keyof typeof toneTile;
  size?: DialogSize;
  /** Legacy: `wide` = size "lg". */
  wide?: boolean;
  /** Extra header buttons (left of the close button). */
  actions?: ReactNode;
  /** A tab row under the header (wide detail dialogs). */
  tabs?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /** Makes the dialog a form: Enter submits. */
  onSubmit?: () => void;
  /** Unsaved changes (default: any edit inside since it opened). */
  dirty?: boolean;
  className?: string;
}) {
  const tr = useTr();
  const edited = useRef(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (open) edited.current = false;
  }, [open]);
  const request = useCallback(() => {
    if (dirty ?? edited.current) setAsking(true);
    else onClose();
  }, [dirty, onClose]);
  const markEdited = (e: FormEvent) => {
    const t = e.target as Element;
    if (!t.closest("[data-nodirty]")) edited.current = true;
  };
  const Body = onSubmit ? "form" : "div";
  return (
    <D.Root open={open} onOpenChange={(o) => !o && request()}>
      <D.Portal>
        <D.Overlay
          data-slot="dialog-overlay"
          className="fixed inset-0 z-50 bg-(--scrim) backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <D.Content
          data-slot="dialog-content"
          {...(description ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={(e) => {
            const root = e.currentTarget as HTMLElement | null;
            const el = root?.querySelector<HTMLElement>("[data-autofocus]");
            e.preventDefault();
            (el ?? root)?.focus();
          }}
          onPointerDownOutside={(e) => {
            if (fromToast(e)) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (fromToast(e)) e.preventDefault();
          }}
          tabIndex={-1}
          className={cn(
            "fixed z-50 flex flex-col bg-card text-foreground outline-none",
            "inset-0 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[min(88vh,900px)] sm:w-[calc(100vw-48px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:shadow-dialog",
            widths[wide ? "lg" : size],
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 sm:data-[state=closed]:zoom-out-[0.98] sm:data-[state=open]:zoom-in-[0.97] max-sm:data-[state=open]:slide-in-from-bottom-6",
            className,
          )}
        >
          <Body
            className="flex min-h-0 flex-1 flex-col"
            noValidate={onSubmit ? true : undefined}
            onInput={markEdited}
            onChange={markEdited}
            onSubmit={
              onSubmit
                ? (e: FormEvent) => {
                    e.preventDefault();
                    onSubmit();
                  }
                : undefined
            }
          >
            <header className="flex shrink-0 items-start gap-3 border-b border-separator px-5 pt-[max(env(safe-area-inset-top),16px)] pb-3.5 sm:pt-4">
              {Icon && (
                <span
                  className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-full", toneTile[tone])}
                >
                  <Icon className="size-[18px]" aria-hidden="true" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <D.Title className="truncate text-title3 font-semibold tracking-[-0.015em]">{title}</D.Title>
                {description ? (
                  <D.Description asChild>
                    <div className="mt-0.5 text-footnote text-muted-foreground">{description}</div>
                  </D.Description>
                ) : null}
              </div>
              {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
              <button
                type="button"
                onClick={request}
                aria-label={tr("关闭", "Close")}
                className="hit-44 -mr-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </header>
            {tabs && <div className="shrink-0 px-5">{tabs}</div>}
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
            {footer && (
              <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-separator bg-[color-mix(in_srgb,var(--window),var(--card)_40%)] px-5 py-3 pb-[max(env(safe-area-inset-bottom),12px)] sm:rounded-b-2xl sm:pb-3">
                {footer}
              </footer>
            )}
          </Body>
          <DiscardConfirm
            open={asking}
            onKeep={() => setAsking(false)}
            onDiscard={() => {
              setAsking(false);
              onClose();
            }}
          />
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** "Discard unsaved changes?" — focus on Keep editing (the safe choice). */
function DiscardConfirm({ open, onKeep, onDiscard }: { open: boolean; onKeep: () => void; onDiscard: () => void }) {
  const tr = useTr();
  return (
    <A.Root open={open} onOpenChange={(o) => !o && onKeep()}>
      <A.Portal>
        <A.Overlay
          data-slot="alert-dialog-overlay"
          className="fixed inset-0 z-50 bg-(--scrim) data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <A.Content
          data-slot="alert-dialog-content"
          className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-32px)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card p-5 shadow-dialog data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97]"
        >
          <A.Title className="text-title3 font-semibold">
            {tr("放弃未保存的修改？", "Discard unsaved changes?")}
          </A.Title>
          <A.Description className="mt-1 text-body text-muted-foreground">
            {tr("关闭后，刚才填写的内容不会保存。", "What you entered will not be saved.")}
          </A.Description>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <A.Cancel asChild>
              <Button variant="secondary">{tr("继续编辑", "Keep editing")}</Button>
            </A.Cancel>
            <A.Action asChild>
              <Button variant="destructive" onClick={onDiscard}>
                {tr("放弃修改", "Discard")}
              </Button>
            </A.Action>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
