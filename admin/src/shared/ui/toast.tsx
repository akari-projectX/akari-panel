// Toasts (sonner): bottom right on a desktop, at the top on a phone (the
// bottom there holds the tab bar, save bars, composers and sheet buttons). Errors stay longer. The close button is translated and has a
// 44px target.
import { Toaster as Sonner, toast as sonner } from "sonner";
import { useCallback, useSyncExternalStore } from "react";
import { useTr } from "../i18n";

export type ToastInput = { tone: "success" | "error" | "info"; title: string; description?: string };

/** Show a toast. Stable across renders. */
export function useToast(): (t: ToastInput) => void {
  return useCallback((t: ToastInput) => {
    const opts = { description: t.description, duration: t.tone === "error" ? 8000 : 4500 };
    if (t.tone === "success") sonner.success(t.title, opts);
    else if (t.tone === "error") sonner.error(t.title, opts);
    else sonner.info(t.title, opts);
  }, []);
}

const PHONE = "(max-width: 639px)";
const subscribe = (cb: () => void) => {
  const m = window.matchMedia?.(PHONE);
  m?.addEventListener?.("change", cb);
  return () => m?.removeEventListener?.("change", cb);
};
const isPhone = () => !!window.matchMedia?.(PHONE).matches;

export function Toaster() {
  const tr = useTr();
  const phone = useSyncExternalStore(subscribe, isPhone, () => false);
  return (
    <Sonner
      position={phone ? "top-center" : "bottom-right"}
      gap={8}
      offset={16}
      mobileOffset={{ top: "calc(56px + env(safe-area-inset-top))", left: 12, right: 12 }}
      closeButton
      containerAriaLabel={tr("通知", "Notifications")}
      toastOptions={{
        closeButtonAriaLabel: tr("关闭通知", "Dismiss"),
        classNames: {
          toast:
            "glass !bg-popover !text-foreground !rounded-xl !shadow-pop !border-0 !text-body !font-sans !px-3.5 !py-3 !gap-2.5",
          title: "!font-medium",
          description: "!text-muted-foreground !text-footnote",
          success: "[&_[data-icon]]:!text-success",
          error: "[&_[data-icon]]:!text-destructive",
          info: "[&_[data-icon]]:!text-info",
          closeButton: "hit-44 !bg-card !text-muted-foreground !border-border",
        },
      }}
    />
  );
}
