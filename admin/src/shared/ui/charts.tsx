// Time-series charts (recharts; only in the chunks of the pages that draw
// them: dashboard, user traffic, node / entrance / server monitoring).
// Conventions (proposal §1): fixed 8-slot categorical palette, the colour
// follows the entity (direct = slot 1, relay = slot 2; never reassigned by a
// filter); 2px lines, area fill 16% → 0, bars ≤18px with 4px top corners;
// horizontal grid only, one Y axis; hover / tap shows a crosshair and a
// frosted tooltip with tabular numbers. The values are also in a visually
// hidden table (screen readers, keyboard) and the legend shows totals or the
// hovered values (touch screens see numbers without hovering).
import { useId, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "../cn";
import { dateOnly, dateTime } from "../format";
import { useTr } from "../i18n";

export type Series = {
  label: string;
  values: (number | null)[];
  /** Palette slot 1–8 (index.css --chart-n). */
  slot: number;
};

/** The y-axis top: max value rounded up to a "nice" number (>= minMax). */
export function niceMax(values: number[], minMax = 1): number {
  const m = Math.max(minMax, ...values.filter((v) => Number.isFinite(v)));
  const p = 10 ** Math.floor(Math.log10(m));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= m) return f * p;
  return 10 * p;
}

const color = (slot: number) => `var(--chart-${slot})`;
const axis = { fill: "var(--chart-axis)", fontSize: 11 };

function Tip({
  active,
  payload,
  label,
  format,
  labelFormat,
}: {
  active?: boolean;
  payload?: readonly { dataKey?: unknown; name?: unknown; value?: unknown; color?: string }[];
  label?: unknown;
  format: (v: number) => string;
  labelFormat: (l: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass min-w-36 rounded-lg bg-popover px-3 py-2 text-footnote shadow-pop">
      <div className="mb-1 font-medium text-muted-foreground">{labelFormat(String(label))}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: p.color }} aria-hidden="true" />
          <span className="text-muted-foreground">{String(p.name)}</span>
          <span className="tnum ml-auto pl-3 font-semibold text-foreground">
            {p.value == null ? "—" : format(Number(p.value))}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Area / line / bar trend over time. `times` label the x axis
 * (`axisLabel` formats them); `format` formats values everywhere.
 */
export function TrendChart({
  title,
  times,
  series,
  format,
  axisLabel = (t) => t,
  tipLabel,
  max,
  kind = "area",
  height = 176,
  className,
  legend = "total",
  hideCaption,
}: {
  title: string;
  times: string[];
  series: Series[];
  format: (v: number) => string;
  axisLabel?: (t: string) => string;
  tipLabel?: (t: string) => string;
  /** Fixed y-axis top (e.g. 100 for percent); default: nice max of the data. */
  max?: number;
  kind?: "area" | "bar";
  height?: number;
  className?: string;
  /** Legend numbers: the series totals, or the latest value. */
  legend?: "total" | "latest" | "none";
  /**
   * The title and legend live in the card header (stat.tsx `Legend`): the
   * caption stays for screen readers only.
   */
  hideCaption?: boolean;
}) {
  const tr = useTr();
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const data = times.map((t, i) => {
    const row: Record<string, number | string | null> = { t };
    series.forEach((s, j) => (row[`s${j}`] = s.values[i] ?? null));
    return row;
  });
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const top = max ?? niceMax(all);
  const legendValue = (s: Series) => {
    if (hover != null) return s.values[hover];
    const vals = s.values.filter((v): v is number => v != null);
    if (legend === "total") return vals.reduce((a, b) => a + b, 0);
    if (legend === "latest") return vals.at(-1) ?? null;
    return null;
  };
  const common = {
    data,
    margin: { top: 6, right: 4, bottom: 0, left: 0 },
    onMouseMove: (s: { activeTooltipIndex?: number | string | null }) =>
      setHover(s.activeTooltipIndex == null ? null : Number(s.activeTooltipIndex)),
    onMouseLeave: () => setHover(null),
  };
  const grid = <CartesianGrid vertical={false} stroke="var(--chart-grid)" />;
  const x = (
    <XAxis
      dataKey="t"
      tickFormatter={axisLabel}
      tick={axis}
      tickLine={false}
      axisLine={false}
      minTickGap={18}
      interval="preserveStartEnd"
    />
  );
  const y = (
    <YAxis
      domain={[0, top]}
      tickFormatter={(v: number) => format(v)}
      tick={axis}
      tickLine={false}
      axisLine={false}
      width={58}
      tickCount={4}
    />
  );
  const tip = (
    <Tooltip
      cursor={kind === "bar" ? { fill: "var(--accent)" } : { stroke: "var(--chart-axis)", strokeDasharray: "3 3" }}
      content={(p) => (
        <Tip
          active={p.active}
          payload={p.payload}
          label={p.label}
          format={format}
          labelFormat={tipLabel ?? axisLabel}
        />
      )}
      isAnimationActive={false}
    />
  );
  return (
    <figure className={cn("grid gap-2", className)}>
      <figcaption className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", hideCaption && "sr-only")}>
        <span className="text-body font-medium">{title}</span>
        {legend !== "none" &&
          series.map((s) => {
            const v = legendValue(s);
            return (
              <span key={s.label} className="inline-flex items-center gap-1.5 text-footnote text-muted-foreground">
                <span className="h-[3px] w-3 rounded-full" style={{ background: color(s.slot) }} aria-hidden="true" />
                {s.label}
                {v != null && <span className="tnum font-medium text-foreground">{format(v)}</span>}
              </span>
            );
          })}
      </figcaption>
      {times.length === 0 ? (
        <p className="py-8 text-center text-body text-muted-foreground">{tr("暂无数据", "No data")}</p>
      ) : (
        <div style={{ height }} aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            {kind === "bar" ? (
              <BarChart {...common} barCategoryGap="28%">
                {grid}
                {x}
                {y}
                {tip}
                {series.map((s, j) => (
                  <Bar
                    key={s.label}
                    dataKey={`s${j}`}
                    name={s.label}
                    fill={color(s.slot)}
                    maxBarSize={18}
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            ) : (
              <AreaChart {...common}>
                <defs>
                  {series.map((s, j) => (
                    <linearGradient key={j} id={`${id}-g${j}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color(s.slot)} stopOpacity={0.16} />
                      <stop offset="100%" stopColor={color(s.slot)} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                {grid}
                {x}
                {y}
                {tip}
                {series.map((s, j) => (
                  <Area
                    key={s.label}
                    type="monotone"
                    dataKey={`s${j}`}
                    name={s.label}
                    stroke={color(s.slot)}
                    strokeWidth={2}
                    fill={`url(#${id}-g${j})`}
                    connectNulls={false}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
      {times.length > 0 && (
        <table className="sr-only">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th>{tr("时间", "Time")}</th>
              {series.map((s) => (
                <th key={s.label}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {times.map((t, i) => (
              <tr key={t}>
                <td>{(tipLabel ?? axisLabel)(t)}</td>
                {series.map((s) => (
                  <td key={s.label}>{s.values[i] == null ? "—" : format(s.values[i] as number)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
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
