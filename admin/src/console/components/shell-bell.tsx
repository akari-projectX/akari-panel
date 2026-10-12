// The alert bell's popover (v2 shell-bell): the rules firing now — severity
// dot, server, kind, value, how long, acknowledged — each a link to the
// alert in the alert center; "一切正常" when nothing fires. Its own chunk,
// loaded when the bell opens (the alert kind names live with the nodes code).
import { useQuery } from "@tanstack/react-query";
import { BellOff, Check } from "lucide-react";
import { Link } from "react-router";
import { get, qs } from "../../shared/api";
import { ago } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { Badge, Dot } from "../../shared/ui/badge";
import { ErrorState, Skeleton } from "../../shared/ui/states";
import { alertKindName } from "../pages/node-common";

type Firing = {
  id: number;
  server_name: string;
  kind: string;
  value: string;
  fired_at: string;
  acked_at: string | null;
};

/**
 * The panel has no severity field: these kinds mean users cannot connect
 * (or a config did not apply), the others are early warnings.
 */
const CRITICAL = new Set(["offline", "entrance_down", "traffic_quota", "last_error"]);

export function BellPanel({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const lang = useLang();
  const q = useQuery({
    queryKey: ["alerts", "firing", "bell"],
    queryFn: () => get<{ alerts: Firing[]; firing: number }>(`/alerts${qs({ status: "firing", limit: 20 })}`),
    refetchInterval: 30_000,
  });
  const rows = q.data?.alerts ?? [];
  return (
    <div className="w-[min(380px,calc(100vw-24px))]">
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <span className="text-headline font-semibold">{tr("正在告警", "Firing now")}</span>
        {q.data && (
          <span className="tnum rounded-full bg-destructive-soft px-1.5 text-footnote font-semibold text-destructive">
            {q.data.firing}
          </span>
        )}
        <Link to="/alerts" onClick={onClose} className="ml-auto text-footnote font-medium text-primary hover:underline">
          {tr("告警页", "Alert center")}
        </Link>
      </div>
      {q.isPending ? (
        <div className="grid gap-2 border-t border-separator p-3.5" role="status" aria-label={tr("加载中", "Loading")}>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : q.isError && !q.data ? (
        <div className="border-t border-separator">
          <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1 border-t border-separator px-4 pt-4 pb-6 text-center">
          <BellOff className="size-6 text-faint" aria-hidden="true" />
          <div className="text-body font-medium">{tr("一切正常", "All clear")}</div>
          <div className="text-footnote text-muted-foreground">{tr("没有正在告警的规则", "No rule is firing")}</div>
        </div>
      ) : (
        <ul className="scroll-thin max-h-80 divide-y divide-separator overflow-y-auto border-t border-separator">
          {rows.map((a) => {
            const critical = CRITICAL.has(a.kind);
            return (
              <li key={a.id}>
                <Link
                  to={`/alerts?open=${a.id}`}
                  onClick={onClose}
                  className="flex gap-3 px-3.5 py-2.5 transition-colors hover:bg-accent"
                >
                  <span className="pt-1.5">
                    <Dot tone={critical ? "danger" : "warning"} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-body font-semibold">{a.server_name}</span>
                      <span className="shrink-0 text-footnote text-muted-foreground">{alertKindName(a.kind, tr)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-footnote text-muted-foreground">
                      {a.value ? `${a.value} · ` : ""}
                      {tr("开始于", "since")} {ago(a.fired_at, lang)}
                    </span>
                  </span>
                  <span className="shrink-0 pt-0.5">
                    {a.acked_at ? (
                      <Badge tone="neutral">
                        <Check className="size-3" aria-hidden="true" />
                        {tr("已确认", "Acknowledged")}
                      </Badge>
                    ) : (
                      <Badge tone={critical ? "danger" : "warning"}>
                        {critical ? tr("严重", "Critical") : tr("警告", "Warning")}
                      </Badge>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center justify-between border-t border-separator px-3.5 py-2 text-footnote text-faint">
        <span>{tr("每 30 秒评估一次", "Evaluated every 30 s")}</span>
        <Link to="/alerts/outbox" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          {tr("通知记录", "Deliveries")}
        </Link>
      </div>
    </div>
  );
}
