// LineChart for the pages that show it inside a detail (user traffic, server
// and entrance monitoring): recharts (~110 KB gz, the `charts` chunk) loads
// when the chart first renders instead of with the page's chunk, so opening
// the users / nodes pages does not download and evaluate it (perf, §3).
import { lazy, Suspense, type ComponentProps } from "react";
import type { LineChart as Eager } from "./charts";
import { dateOnly, dateTime } from "../format";
import { Skeleton } from "./states";

const Chart = lazy(() => import("./charts").then((m) => ({ default: m.LineChart })));

export function LineChart(props: ComponentProps<typeof Eager>) {
  return (
    <Suspense fallback={<Skeleton className={props.className} style={{ height: props.height ?? 200 }} />}>
      <Chart {...props} />
    </Suspense>
  );
}

/** Axis and tooltip labels for ISO times in the site time zone: "10-02" over days, else "14:05". */
export function timeLabels(times: string[]): { axisLabel: (t: string) => string; tipLabel: (t: string) => string } {
  const n = times.length;
  const days = n > 0 && Date.parse(times[n - 1]) - Date.parse(times[0]) > 2 * 86_400_000;
  return {
    axisLabel: (t) => (days ? dateOnly(t).slice(5) : dateTime(t).slice(11, 16)),
    tipLabel: (t) => (days ? dateOnly(t) : dateTime(t)),
  };
}
