// W11: a small dependency-free SVG line chart (CSP-safe: no inline script,
// no CDN; only React event handlers). Values may be null (gaps).
import { useId, useState } from "react";
import { fmtDate, fmtDateTime, fmtTime } from "../lib/datetime";

export interface Series {
  label: string;
  values: (number | null)[];
  /** Tailwind stroke class, e.g. "stroke-sky-500". */
  stroke: string;
  /** Tailwind text/bg class for the legend swatch, e.g. "bg-sky-500". */
  swatch: string;
}

const W = 600;
const H = 160;
const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 8;
const PAD_B = 4;

/** The y-axis top: max value rounded up to a "nice" number (>= minMax). */
export function niceMax(values: number[], minMax = 1): number {
  const m = Math.max(minMax, ...values.filter((v) => Number.isFinite(v)));
  const p = 10 ** Math.floor(Math.log10(m));
  for (const f of [1, 2, 2.5, 5, 10]) {
    if (f * p >= m) return f * p;
  }
  return 10 * p;
}

/** SVG path for one series (moves across null gaps). */
export function pathOf(values: (number | null)[], max: number): string {
  const n = values.length;
  if (n === 0 || max <= 0) return "";
  const x = (i: number) => PAD_L + (n === 1 ? (W - PAD_L - PAD_R) / 2 : (i * (W - PAD_L - PAD_R)) / (n - 1));
  const y = (v: number) => PAD_T + (1 - Math.min(v, max) / max) * (H - PAD_T - PAD_B);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function LineChart({
  title,
  times,
  series,
  format,
  max,
}: {
  title: string;
  times: string[];
  series: Series[];
  format: (v: number) => string;
  /** Fixed y-axis top (e.g. 100 for percent); default: nice max of the data. */
  max?: number;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const top = max ?? niceMax(all);
  const n = times.length;
  // Axis labels in Beijing time (W21, M7): "10-02" over days, else "14:05".
  const axisLabel = (t: string): string =>
    n > 0 && Date.parse(times[n - 1]) - Date.parse(times[0]) > 2 * 86_400_000 ? fmtDate(t).slice(5) : fmtTime(t);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / Math.max(1, r.width);
    setHover(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))));
  };
  const hx = hover == null ? 0 : PAD_L + (n === 1 ? 0 : (hover * (W - PAD_L - PAD_R)) / (n - 1));
  return (
    <figure className="space-y-1" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="flex flex-wrap items-center gap-3 text-sm font-medium">
        {title}
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
            <span className={`inline-block h-2 w-3 rounded-sm ${s.swatch}`} aria-hidden="true" />
            {s.label}
            {hover != null && s.values[hover] != null && `：${format(s.values[hover] as number)}`}
          </span>
        ))}
      </figcaption>
      {n === 0 ? (
        <p className="text-sm text-muted-foreground">暂无数据</p>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="h-40 w-full rounded-lg border border-border bg-card"
            role="img"
            aria-label={`${title}：最高 ${format(Math.max(0, ...all))}`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {[0.25, 0.5, 0.75].map((f) => (
              <line
                key={f}
                x1={0}
                x2={W}
                y1={PAD_T + f * (H - PAD_T - PAD_B)}
                y2={PAD_T + f * (H - PAD_T - PAD_B)}
                className="stroke-border"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {series.map((s) => (
              <path
                key={s.label}
                d={pathOf(s.values, top)}
                fill="none"
                className={s.stroke}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hover != null && (
              <line
                x1={hx}
                x2={hx}
                y1={0}
                y2={H}
                className="stroke-muted-foreground"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          <span className="absolute left-1 top-0.5 text-[10px] text-muted-foreground">{format(top)}</span>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{axisLabel(times[0])}</span>
            {hover != null && <span>{fmtDateTime(times[hover])}</span>}
            <span>{axisLabel(times[n - 1])}</span>
          </div>
        </div>
      )}
    </figure>
  );
}
