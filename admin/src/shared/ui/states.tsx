// The three data states, one component each (audit common issue 4):
// loading (skeleton), empty (never had data vs. nothing matches the filter)
// and error (mapped message + code + retry).
import { CircleAlert, RefreshCw, Search, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { errorCode, errorText } from "../errors";
import { useLang, useTr } from "../i18n";
import { Button } from "./button";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} aria-hidden="true" />;
}

/** A block placeholder while a section loads (announced once). */
export function LoadingBlock({ rows = 3, className }: { rows?: number; className?: string }) {
  const tr = useTr();
  return (
    <div role="status" aria-label={tr("加载中", "Loading")} className={cn("grid gap-2.5 py-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i % 3 === 2 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/**
 * Empty state: a line icon in a soft primary tile, one sentence on why it is
 * empty and the next step. Pass `filtered` when filters are on (then the
 * action clears them) — the two cases read differently.
 */
export function EmptyState({
  icon: Icon = Search,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      <div className="relative mb-4" aria-hidden="true">
        <div className="absolute -inset-3 rounded-[22px] bg-primary-soft opacity-50 blur-md" />
        <div className="relative inline-flex size-14 items-center justify-center rounded-[16px] bg-card text-primary shadow-raised">
          <Icon className="size-7 stroke-[1.6]" />
        </div>
      </div>
      <div className="text-headline font-semibold">{title}</div>
      {description && <p className="mt-1 max-w-sm text-body text-muted-foreground">{description}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  onRetry,
  error,
  detail,
  className,
  compact,
}: {
  onRetry?: () => void;
  error?: unknown;
  detail?: string;
  className?: string;
  compact?: boolean;
}) {
  const tr = useTr();
  const lang = useLang();
  const code = error ? errorCode(error) : "";
  return (
    <div className={cn("flex flex-col items-center px-6 text-center", compact ? "py-6" : "py-12", className)}>
      <div className="mb-3 inline-flex size-11 items-center justify-center rounded-full bg-destructive-soft text-destructive">
        <CircleAlert className="size-5" aria-hidden="true" />
      </div>
      <div className="text-headline font-semibold">{tr("加载失败", "Failed to load")}</div>
      <div className="mt-1 max-w-sm text-body text-muted-foreground">
        {detail ?? (error ? errorText(error, lang) : tr("可以稍后重试。", "Try again shortly."))}
        {code && <div className="mt-1 font-mono text-caption">{code}</div>}
      </div>
      {onRetry && (
        <Button className="mt-4" size="sm" variant="outline" icon={RefreshCw} onClick={onRetry}>
          {tr("重试", "Retry")}
        </Button>
      )}
    </div>
  );
}
