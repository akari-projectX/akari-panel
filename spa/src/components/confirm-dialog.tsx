// Confirmation dialog (W20, audit Minor 10): replaces window.confirm, whose
// buttons follow the browser's language (English OK/Cancel on phones) and
// cannot say what the action does. Shared with the admin console (W21):
// labels default to common.confirm / common.cancel, which the console's
// FixedLocale renders in Chinese.
//
//   const [confirm, confirmDialog] = useConfirm();
//   if (!(await confirm({ title, body, confirmLabel, destructive: true }))) return;
//   …
//   return <>{…}{confirmDialog}</>;
import { useCallback, useRef, useState, type ReactNode } from "react";

import { useT } from "../i18n";
import { Button } from "./ui/button";
import { Dialog } from "./dialog";

export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** Red confirm button (deleting, resetting, invalidating). */
  destructive?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
  busy,
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <Dialog open={open} onClose={onCancel} title={title} description={body} role="alertdialog">
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel} data-autofocus>
          {cancelLabel ?? t("common.cancel")}
        </Button>
        <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm} disabled={busy}>
          {confirmLabel ?? t("common.confirm")}
        </Button>
      </div>
    </Dialog>
  );
}

/** A promise-returning confirm() and the dialog element to render. */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => {
    resolver.current?.(false);
    setOptions(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOptions(null);
  };
  const element = (
    <ConfirmDialog
      open={options != null}
      title={options?.title ?? ""}
      body={options?.body}
      confirmLabel={options?.confirmLabel}
      cancelLabel={options?.cancelLabel}
      destructive={options?.destructive}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
  return [confirm, element];
}
