// Shared bits of 内容 · 公告 and 内容 · 知识库 (v2 support-ui): the
// server-rendered preview hook (POST /content/preview, the portal's own
// sanitizer), the 中 / EN fill chips of a list row and the fact rows of a
// small dialog.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSyncExternalStore, type ReactNode } from "react";
import { post } from "../../shared/api";
import { cn } from "../../shared/cn";
import { useTr } from "../../shared/i18n";
import { useDebounced } from "../kit";
import { PreviewPane } from "./kit";

/** The preview pane for a Markdown draft (debounced; the last render stays while the next one renders). */
export function MarkdownPreview({
  title,
  markdown,
  label,
  loading,
  className,
}: {
  title: string;
  markdown: string;
  label: ReactNode;
  /** The body is still loading (shows "rendering"). */
  loading?: boolean;
  className?: string;
}) {
  const md = useDebounced(markdown, 400);
  const q = useQuery({
    queryKey: ["content-preview", md],
    queryFn: () => post<{ html: string }>("/content/preview", { markdown: md }),
    enabled: md.trim().length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const empty = !md.trim();
  const state =
    loading || (!empty && (q.isFetching || md !== markdown)) ? "rendering" : !empty && q.isError ? "error" : "ok";
  return (
    <div data-testid="preview" className={cn("flex min-h-0 flex-col", className)}>
      <PreviewPane
        className="h-full"
        title={title.trim()}
        html={empty ? "" : (q.data?.html ?? "")}
        state={state}
        label={label}
        onRetry={() => void q.refetch()}
      />
    </div>
  );
}

/** "中" / "EN" chip: struck through when that language is not filled in. */
export function LangChip({ on, children }: { on: boolean; children: ReactNode }) {
  const tr = useTr();
  return (
    <span
      className={cn(
        "inline-flex h-4 items-center rounded px-1 text-micro font-semibold",
        on
          ? "bg-secondary text-muted-foreground"
          : "text-faint line-through decoration-faint/60 ring-1 ring-separator ring-inset",
      )}
      title={on ? tr("已填写", "Filled in") : tr("未填写", "Not filled in")}
    >
      {children}
      <span className="sr-only">{on ? tr("（已填写）", " (filled in)") : tr("（未填写）", " (not filled in)")}</span>
    </span>
  );
}

/** One label → value row of a fact list (dialogs). */
export function Fact({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-body">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}

/** A media query as state. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}
