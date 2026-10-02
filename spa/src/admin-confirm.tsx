// The console's confirmations (W21): one W20 ConfirmDialog (components/
// confirm-dialog.tsx, `useConfirm`) mounted at the console root and shared
// through context, so every admin view can `await confirm({...})` without
// rendering its own dialog element. Without the provider (single-page unit
// tests) it falls back to window.confirm, which tests answer with a spy.
import { createContext, useCallback, useContext, type ReactNode } from "react";

import { useConfirm, type ConfirmOptions } from "./components/confirm-dialog";

export interface AdminConfirmOptions extends Omit<ConfirmOptions, "title"> {
  title: string;
  /** Alias of `body` (the explanation under the title). */
  message?: ReactNode;
}

type Confirm = (o: AdminConfirmOptions) => Promise<boolean>;

const fallback: Confirm = (o) => {
  const text = o.message ?? o.body;
  return Promise.resolve(window.confirm(typeof text === "string" ? `${o.title}\n\n${text}` : o.title));
};

const Ctx = createContext<Confirm>(fallback);

export function AdminConfirmProvider({ children }: { children: ReactNode }) {
  const [confirm, dialog] = useConfirm();
  const ask = useCallback<Confirm>(({ message, ...o }) => confirm({ ...o, body: o.body ?? message }), [confirm]);
  return (
    <Ctx.Provider value={ask}>
      {children}
      {dialog}
    </Ctx.Provider>
  );
}

/** `await confirm({ title, message, confirmLabel, destructive })` → true when confirmed. */
export function useAdminConfirm(): Confirm {
  return useContext(Ctx);
}
