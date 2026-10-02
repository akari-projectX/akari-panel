// W22: a small dependency-free SVG stacked bar chart (CSP-safe: no inline
// script, no CDN; only React event handlers). One bar per label; each bar
// stacks the series' values bottom-up. All text comes from the caller (i18n).
import { useId, useState } from "react";

import { niceMax } from "./line-chart";

export interface BarSeries {
  label: string;
  values: number[];
  /** Tailwind fill class, e.g. "fill-sky-500". */
  fill: string;
  /** Tailwind bg class for the legend swatch, e.g. "bg-sky-500". */
  swatch: string;
}

const W = 600;
const H = 160;
const PAD_T = 8;

/** Bar geometry: x and width of bar i of n (gap = 20% of a slot, min 1px). */
export function barBox(i: number, n: number): { x: number; w: number } {
  const slot = W / Math.max(1, n);
  const gap = Math.max(1, slot * 0.2);
  return { x: i * slot + gap / 2, w: Math.max(1, slot - gap) };
}

export function BarChart({
  title,
  labels,
  series,
  format,
  empty,
  describe,
}: {
  title: string;
  /** One label per bar (shown at the ends and on hover). */
  labels: string[];
  series: BarSeries[];
  format: (v: number) => string;
  /** Shown instead of the chart when there are no bars. */
  empty: string;
  /** Accessible summary of the chart (e.g. the total). */
  describe: string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const top = niceMax(totals);
  const y = (v: number) => (v / top) * (H - PAD_T);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / Math.max(1, r.width);
    setHover(Math.max(0, Math.min(n - 1, Math.floor(frac * n))));
  };
  return (
    <figure className="space-y-1" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="flex flex-wrap items-center gap-3 text-sm font-medium">
        {title}
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
            <span className={`inline-block h-2 w-3 rounded-sm ${s.swatch}`} aria-hidden="true" />
            {s.label}
            {hover != null && `: ${format(s.values[hover] ?? 0)}`}
          </span>
        ))}
      </figcaption>
      {n === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="h-40 w-full rounded-lg border border-border bg-card"
            role="img"
            aria-label={describe}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {[0.25, 0.5, 0.75].map((f) => (
              <line
                key={f}
                x1={0}
                x2={W}
                y1={PAD_T + f * (H - PAD_T)}
                y2={PAD_T + f * (H - PAD_T)}
                className="stroke-border"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {labels.map((label, i) => {
              const { x, w } = barBox(i, n);
              let base = H;
              return (
                <g key={label} opacity={hover == null || hover === i ? 1 : 0.6}>
                  {series.map((s) => {
                    const h = y(s.values[i] ?? 0);
                    base -= h;
                    return h > 0 ? <rect key={s.label} x={x} y={base} width={w} height={h} className={s.fill} /> : null;
                  })}
                </g>
              );
            })}
          </svg>
          <span className="absolute left-1 top-0.5 text-[10px] text-muted-foreground">{format(top)}</span>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{labels[0]}</span>
            {hover != null && (
              <span>
                {labels[hover]} · {format(totals[hover])}
              </span>
            )}
            <span>{labels[n - 1]}</span>
          </div>
        </div>
      )}
    </figure>
  );
}
