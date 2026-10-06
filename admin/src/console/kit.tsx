// Small page helpers shared by the console's views.
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { errorCode, errorText } from "../shared/errors";
import { useLang, useTr } from "../shared/i18n";
import { useToast } from "../shared/ui/overlays";
import { Icon } from "../shared/ui/icons";
import { Badge, Button, type Tone } from "../shared/ui/primitives";
import { copyText } from "../shared/format";

/**
 * Run a mutation with feedback: success toast (and invalidation), or the
 * server error as an error toast. Resolves to the result, or undefined on
 * failure.
 */
export function useRun() {
  const toast = useToast();
  const lang = useLang();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(
      fn: () => Promise<T>,
      opts: { ok?: string; okDetail?: string; invalidate?: QueryKey[]; errorPrefix?: string } = {},
    ): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        // Awaited: forms that re-initialise from the query after a save read the fresh values.
        await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
        if (opts.ok) toast({ tone: "success", title: opts.ok, description: opts.okDetail });
        return r;
      } catch (e) {
        const text = errorText(e, lang);
        toast({
          tone: "error",
          title: opts.errorPrefix ? `${opts.errorPrefix}：${text}` : text,
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

/** Error text in the current language. */
export function useErrText() {
  const lang = useLang();
  return useCallback((e: unknown) => errorText(e, lang), [lang]);
}

export function FormError({ error }: { error: unknown }) {
  const t = useErrText();
  if (!error) return null;
  return (
    <p role="alert" className="text-[13px] text-destructive">
      {t(error)} <span className="font-mono text-[11px] opacity-70">{errorCode(error)}</span>
    </p>
  );
}

export function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const tr = useTr();
  const toast = useToast();
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="copy"
      onClick={async () =>
        toast(
          (await copyText(text))
            ? { tone: "success", title: tr("已复制", "Copied") }
            : { tone: "error", title: tr("复制失败，请手动复制", "Copy failed; copy it by hand") },
        )
      }
    >
      {label ?? tr("复制", "Copy")}
    </Button>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">{children}</code>;
}

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge tone={tone} dot>
      {children}
    </Badge>
  );
}

/** Section title inside a drawer. */
export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-2 mt-5 flex items-center justify-between gap-2 first:mt-0">
      <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
      {actions}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "danger" | "warning" | "success";
  icon?: import("../shared/ui/icons").IconName;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-card">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon && <Icon name={icon} size={14} />}
        {label}
      </div>
      <div
        className={
          "mt-1.5 text-2xl font-semibold tabular-nums " +
          (tone === "danger"
            ? "text-destructive"
            : tone === "warning"
              ? "text-warning"
              : tone === "success"
                ? "text-success"
                : "")
        }
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
