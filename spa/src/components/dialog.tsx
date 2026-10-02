// A modal dialog (W20): centred on desktop, a bottom sheet on phones.
// Shared by the portal and the admin console (W21): no copy of its own,
// callers pass the title and content. Focus moves into the dialog (the
// element marked `data-autofocus`, else the panel), Tab stays inside, Escape
// and the backdrop close it, and focus returns to where it was. No portal:
// it renders in place with `fixed` positioning, which works under the CSP
// and in tests.
import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "../lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Optional text under the title (aria-describedby). */
  description?: ReactNode;
  children?: ReactNode;
  /** "alertdialog" for confirmations. */
  role?: "dialog" | "alertdialog";
  className?: string;
}

export function Dialog({ open, onClose, title, description, children, role = "dialog", className }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el;
    first?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === head || document.activeElement === el)) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      {/* The backdrop is a pointer convenience; keyboard users have Escape and the buttons. */}
      <div aria-hidden="true" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "relative max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card p-5 text-card-foreground shadow-xl outline-none",
          "pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-w-md sm:rounded-2xl sm:pb-5",
          className,
        )}
      >
        <h2 id={titleId} className="pr-8 text-lg font-semibold">
          {title}
        </h2>
        {description && (
          <div id={descId} className="mt-1 text-sm text-muted-foreground">
            {description}
          </div>
        )}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
