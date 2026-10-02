// W11: Clash Verge-style latency badge (portal and console). Thresholds:
// < 200 ms green, < 500 ms amber, else red; a failed test (timeout) grey.
import { useT } from "../i18n";

export type LatencyLevel = "good" | "fair" | "bad" | "timeout" | "unknown" | "na";

export function latencyLevel(ms: number | null | undefined, failed: boolean): LatencyLevel {
  if (ms != null) {
    if (ms < 200) return "good";
    if (ms < 500) return "fair";
    return "bad";
  }
  return failed ? "timeout" : "unknown";
}

const CLS: Record<LatencyLevel, string> = {
  good: "bg-emerald-600 text-white",
  fair: "bg-amber-500 text-white",
  bad: "bg-red-600 text-white",
  timeout: "bg-muted text-muted-foreground",
  unknown: "border border-border text-muted-foreground",
  na: "border border-border text-muted-foreground",
};

export function LatencyBadge({
  ms,
  failed = false,
  na = false,
  title,
}: {
  ms: number | null | undefined;
  failed?: boolean;
  na?: boolean;
  title?: string;
}) {
  const t = useT();
  const level: LatencyLevel = na ? "na" : latencyLevel(ms, failed);
  const text =
    level === "na"
      ? t("latency.na")
      : ms != null
        ? t("latency.ms", { ms })
        : level === "timeout"
          ? t("latency.timeout")
          : t("latency.unknown");
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${CLS[level]}`}
      data-level={level}
      title={title}
    >
      {text}
    </span>
  );
}
