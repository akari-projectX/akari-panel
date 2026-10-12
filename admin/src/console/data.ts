// The console's data layer (2026-10 redesign, audit §5.1 / common issue 1:
// "lists do not refresh after a write"). react-query holds every read; two
// rules keep what is on screen current without a reload:
//   1. Every successful write — whatever issued it (useAction, a confirm
//      dialog's action, a direct post()) — goes through the API client's
//      write listener: the entities the API path touches are invalidated
//      and the ones on screen refetch (ENTITIES below). Query keys start
//      with their entity (["users", …], ["user", id], ["orders", …]); a key
//      whose root no entity claims is refetched after every write, so a
//      forgotten mapping costs a request, never a stale screen.
//   2. Queries refetch when the window regains focus.
// `useAction` runs a write with feedback (success toast, mapped error
// toast) and resolves after the refetches it caused have landed, so a form
// that re-initialises from its query sees the saved values.
import { QueryClient, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { setWriteListener } from "../shared/api";
import { errorCode, errorText } from "../shared/errors";
import { useLang } from "../shared/i18n";
import { useToast } from "../shared/ui/toast";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: true, staleTime: 5_000 },
    },
  });
}

/**
 * `meta` for a query whose data is a detail of its page (a count in a
 * subtitle, "last changed", a probe): the page's main[data-ready] (shell.tsx)
 * does not wait for it. The page still shows it when it arrives.
 */
export const SECONDARY = { secondary: true } as const;

/** Counters and summaries many writes move. */
const GLOBAL = ["dashboard", "admin-badges", "system-status"];
const USERS = ["users", "user", "balances", "balance", "batch-jobs", "traffic", "commissions", "withdrawals"];
const ORDERS = ["orders", "order", "coupons", "coupon", "coupon-batches", "balances", "balance", "commissions"];
const NODES = [
  "servers",
  "server",
  "nodes",
  "node",
  "entrances",
  "entrance",
  "node-groups",
  "rate-rules",
  "block-rules",
  "alerts",
  "traffic",
  "agent-updates",
  "inbound-templates",
];
const PLANS = ["plans", "plan", "plan-prices", "node-groups", "users", "user"];
const FINANCE = ["withdrawals", "commissions", "commission-settings", "balances", "balance", "users", "user"];
const CONTENT = ["announcements", "kb"];
const SETTINGS = ["settings", "outbox", "mail-templates", "me", "admins", "commission-settings", "alert-settings"];
const RELEASES = ["releases", "rollouts", "agent-updates", "servers", "server", "nodes"];

/** API path's first segment → the query-key roots a write there can change. */
const ENTITIES: Record<string, string[]> = {
  users: [...USERS, ...ORDERS, ...PLANS],
  orders: [...ORDERS, ...USERS],
  coupons: ORDERS,
  "coupon-batches": ORDERS,
  withdrawals: FINANCE,
  commissions: FINANCE,
  "commission-settings": FINANCE,
  balances: FINANCE,
  tickets: ["tickets", "ticket"],
  announcements: CONTENT,
  kb: CONTENT,
  content: CONTENT,
  servers: [...NODES, ...PLANS],
  nodes: [...NODES, ...PLANS],
  entrances: [...NODES, ...PLANS],
  "node-groups": [...NODES, ...PLANS],
  "inbound-templates": NODES,
  "rate-rules": NODES,
  "block-rules": [...NODES, ...SETTINGS],
  plans: [...PLANS, ...ORDERS],
  alerts: ["alerts", "alert-settings", "servers", "nodes"],
  "agent-releases": RELEASES,
  rollouts: RELEASES,
  "agent-updates": RELEASES,
  settings: [...SETTINGS, "servers", "nodes", "plans"],
  mail: SETTINGS,
  me: ["me", "passkeys", "account"],
  logout: [],
  passkey: ["me", "passkeys"],
};
const CLAIMED = new Set(Object.values(ENTITIES).flat().concat(GLOBAL));
/** Searches and previews: never refetched by a write (they are asked for). */
const PASSIVE = new Set(["palette", "delete-preview", "mail-template-preview", "content-preview", "refund-preview"]);

/**
 * POSTs that only compute an answer (checks, previews, impact counts) and
 * change nothing: they refetch nothing (the settings pages run DNS checks on
 * open; each used to refetch every settings query).
 */
const READ_ONLY_POSTS = [
  /^\/settings\/dns-check$/,
  /^\/settings\/domains\/impact$/,
  /^\/settings\/mail-templates\/preview$/,
  /^\/inbound-templates\/check-(dest|domain)$/,
  /^\/content\/preview$/,
  /^\/plans\/[^/]+\/impact$/,
  /^\/users\/(batch|delete)\/preview$/,
];

/** Query-key roots to refetch after a write to `path` (exported for tests). */
export function affected(path: string): ((root: string) => boolean) | "all" {
  if (READ_ONLY_POSTS.some((r) => r.test(path))) return () => false;
  const seg = path.split("/").filter(Boolean)[0] ?? "";
  const roots = ENTITIES[seg];
  if (!roots) return "all";
  const set = new Set([...roots, ...GLOBAL]);
  return (root) => !PASSIVE.has(root) && (set.has(root) || !CLAIMED.has(root));
}

const inFlight = new Set<Promise<unknown>>();

/** Wire rule 1 to a client (once, at start-up). */
export function invalidateOnWrite(qc: QueryClient): void {
  setWriteListener((_method, path) => {
    const hit = affected(path);
    const p = qc.invalidateQueries({
      predicate: (q) => {
        const root = String(q.queryKey[0] ?? "");
        return hit === "all" ? !PASSIVE.has(root) : hit(root);
      },
    });
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  });
}

/** Resolves when the refetches caused by the writes so far have landed. */
export async function settled(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}

export type ActionOptions = {
  /** Success toast title. */
  ok?: string;
  okDetail?: string;
  /** Extra keys to refetch (beyond what the write's entity covers). */
  invalidate?: QueryKey[];
  errorPrefix?: string;
};

/**
 * Run a write with feedback: success toast (after the affected queries
 * refetched), or the mapped server error as an error toast. Resolves to the
 * result, or undefined on failure. Each call site owns its `busy` — use one
 * `useAction()` per button so two buttons never spin together.
 */
export function useAction() {
  const toast = useToast();
  const lang = useLang();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T>(fn: () => Promise<T>, opts: ActionOptions = {}): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        await Promise.all([settled(), ...(opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k }))]);
        if (opts.ok) toast({ tone: "success", title: opts.ok, description: opts.okDetail });
        return r;
      } catch (e) {
        const text = errorText(e, lang);
        toast({
          tone: "error",
          title: opts.errorPrefix ? `${opts.errorPrefix}${lang === "en" ? ": " : "："}${text}` : text,
          description: errorCode(e) || undefined,
        });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast, lang, qc],
  );
  return [run, busy] as const;
}
