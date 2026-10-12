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
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "../cn";
import { bytes, dateOnly, dateTime, yuan } from "../format";
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

// ---------------------------------------------------------------------------
// v2: LineChart (several lines, the first ones optionally as areas) and
// MetricChart (the dashboard's one big chart, switched by metric).
// ---------------------------------------------------------------------------

export type LineSeries = Series & {
  /** Dashed line (billed vs raw, a limit). */
  dashed?: boolean;
  /** Draw as a filled area instead of a line. */
  area?: boolean;
};

/** Visually hidden data table under a chart (screen readers, keyboard). */
function SrTable({
  title,
  times,
  cols,
}: {
  title: string;
  times: string[];
  cols: { label: string; values: (string | null)[] }[];
}) {
  const tr = useTr();
  return (
    <table className="sr-only">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th>{tr("时间", "Time")}</th>
          {cols.map((c) => (
            <th key={c.label}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {times.map((t, i) => (
          <tr key={t}>
            <td>{t}</td>
            {cols.map((c) => (
              <td key={c.label}>{c.values[i] ?? "—"}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Lines over time with one Y axis (merges the v2 nodes LinesChart and the
 * user UsageChart): CPU / memory %, up / down rates, raw / billed traffic,
 * a user's daily download (area) / upload / billed (dashed). Same series
 * shape as TrendChart (`slot` = --chart-n) plus `dashed` / `area`.
 */
export function LineChart({
  title,
  times,
  series,
  format,
  axisLabel = (t) => t,
  tipLabel,
  max,
  height = 200,
  className,
  legend = "none",
  hideCaption,
}: {
  title: string;
  times: string[];
  series: LineSeries[];
  format: (v: number) => string;
  axisLabel?: (t: string) => string;
  tipLabel?: (t: string) => string;
  max?: number;
  height?: number;
  className?: string;
  legend?: "total" | "latest" | "none";
  hideCaption?: boolean;
}) {
  const tr = useTr();
  const id = useId().replace(/:/g, "");
  const data = times.map((t, i) => {
    const row: Record<string, number | string | null> = { t };
    series.forEach((s, j) => (row[`s${j}`] = s.values[i] ?? null));
    return row;
  });
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const top = max ?? niceMax(all);
  const legendValue = (s: Series) => {
    const vals = s.values.filter((v): v is number => v != null);
    if (legend === "total") return vals.reduce((a, b) => a + b, 0);
    if (legend === "latest") return vals.at(-1) ?? null;
    return null;
  };
  return (
    <figure className={cn("grid gap-2", className)}>
      <figcaption className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", hideCaption && "sr-only")}>
        <span className="text-body font-medium">{title}</span>
        {series.map((s) => {
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
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                {series.map((s, j) => (
                  <linearGradient key={j} id={`${id}-g${j}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color(s.slot)} stopOpacity={0.16} />
                    <stop offset="100%" stopColor={color(s.slot)} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis
                dataKey="t"
                tickFormatter={axisLabel}
                tick={axis}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[0, top]}
                tickFormatter={(v: number) => format(v)}
                tick={axis}
                tickLine={false}
                axisLine={false}
                width={58}
                tickCount={4}
              />
              <Tooltip
                cursor={{ stroke: "var(--chart-axis)", strokeDasharray: "3 3" }}
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
              {series.map((s, j) =>
                s.area ? (
                  <Area
                    key={s.label}
                    type="monotone"
                    dataKey={`s${j}`}
                    name={s.label}
                    stroke={color(s.slot)}
                    strokeWidth={2}
                    strokeDasharray={s.dashed ? "4 3" : undefined}
                    fill={`url(#${id}-g${j})`}
                    connectNulls={false}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
                    isAnimationActive={false}
                  />
                ) : (
                  <Line
                    key={s.label}
                    type="monotone"
                    dataKey={`s${j}`}
                    name={s.label}
                    stroke={color(s.slot)}
                    strokeWidth={2}
                    strokeDasharray={s.dashed ? "4 3" : undefined}
                    connectNulls={false}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
                    isAnimationActive={false}
                  />
                ),
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      {times.length > 0 && (
        <SrTable
          title={title}
          times={times.map(tipLabel ?? axisLabel)}
          cols={series.map((s) => ({ label: s.label, values: s.values.map((v) => (v == null ? null : format(v))) }))}
        />
      )}
    </figure>
  );
}

export type Metric = "net" | "orders" | "signups" | "traffic";

/**
 * One day of the dashboard series (GET /dashboard `series`): money in cents,
 * traffic in bytes split by entrance kind (or one `traffic_bytes` total).
 */
export type MetricDay = {
  day: string;
  revenue_cents?: number;
  gross_cents?: number;
  refunds_cents?: number;
  orders?: number;
  signups?: number;
  direct_bytes?: number;
  relay_bytes?: number;
  other_bytes?: number;
  traffic_bytes?: number;
};

const compactYuan = (cents: number) => {
  const y = cents / 100;
  return Math.abs(y) >= 1000 ? `¥${(y / 1000).toFixed(1)}k` : `¥${Math.round(y)}`;
};

/**
 * The dashboard's metric-switchable chart (v2 MetricChart). net: bars of
 * net revenue (negative days red), the tooltip breaks it into collected /
 * refunded (by refund day) / net; orders, signups: bars; traffic: an area,
 * stacked 直连 (slot 1) / 中转 (slot 2) / 其他 (slot 3, deleted entrances)
 * when the split is given. `axisLabel` formats the day on the axis
 * ("10-02"), `tipLabel` in the tooltip.
 */
export function MetricChart({
  data,
  metric,
  height = 260,
  axisLabel = (d) => d.slice(5),
  tipLabel = (d) => d,
  className,
}: {
  data: MetricDay[];
  metric: Metric;
  height?: number;
  axisLabel?: (day: string) => string;
  tipLabel?: (day: string) => string;
  className?: string;
}) {
  const tr = useTr();
  const id = useId().replace(/:/g, "");
  const split = data.some((d) => d.direct_bytes != null || d.relay_bytes != null);
  const hasOther = data.some((d) => (d.other_bytes ?? 0) > 0);
  const rows = data.map((d) => ({
    ...d,
    net: d.revenue_cents ?? 0,
    traffic: d.traffic_bytes ?? (d.direct_bytes ?? 0) + (d.relay_bytes ?? 0) + (d.other_bytes ?? 0),
  }));
  const fmt =
    metric === "net"
      ? yuan
      : metric === "traffic"
        ? bytes
        : (v: number) => (metric === "orders" ? tr(`${v} 笔`, `${v}`) : tr(`${v} 人`, `${v}`));
  const titles: Record<Metric, string> = {
    net: tr("净营收", "Net revenue"),
    orders: tr("订单", "Orders"),
    signups: tr("注册", "Sign-ups"),
    traffic: tr("全网流量", "Traffic"),
  };
  type Row = (typeof rows)[number];
  const tip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: readonly { payload?: Row }[];
    label?: unknown;
  }) => {
    const r = payload?.[0]?.payload;
    if (!active || !r) return null;
    const line = (k: string, v: string, strong?: boolean, danger?: boolean) => (
      <div key={k} className="flex items-center gap-3">
        <span className="flex-1 text-muted-foreground">{k}</span>
        <span
          className={cn(
            "tnum",
            strong ? "font-semibold text-foreground" : "text-foreground/85",
            danger && "text-destructive",
          )}
        >
          {v}
        </span>
      </div>
    );
    return (
      <div className="glass min-w-44 rounded-lg bg-popover px-3 py-2 text-footnote shadow-pop">
        <div className="mb-1 font-medium text-muted-foreground">{tipLabel(String(label))}</div>
        {metric === "net" && (
          <>
            {line(tr("渠道实收", "Collected"), yuan(r.gross_cents ?? 0))}
            {line(
              tr("渠道退款（按退款日）", "Refunded (by refund day)"),
              r.refunds_cents ? `−${yuan(r.refunds_cents)}` : yuan(0),
            )}
            <div className="my-1 h-px bg-separator" />
            {line(tr("净营收", "Net revenue"), yuan(r.net), true, r.net < 0)}
          </>
        )}
        {metric === "orders" && line(titles.orders, fmt(r.orders ?? 0), true)}
        {metric === "signups" && line(titles.signups, fmt(r.signups ?? 0), true)}
        {metric === "traffic" &&
          (split ? (
            <>
              {line(tr("直连", "Direct"), bytes(r.direct_bytes ?? 0))}
              {line(tr("中转", "Relay"), bytes(r.relay_bytes ?? 0))}
              {hasOther && line(tr("其他", "Other"), bytes(r.other_bytes ?? 0))}
              <div className="my-1 h-px bg-separator" />
              {line(tr("合计", "Total"), bytes(r.traffic), true)}
            </>
          ) : (
            line(titles.traffic, bytes(r.traffic), true)
          ))}
      </div>
    );
  };
  const grid = <CartesianGrid vertical={false} stroke="var(--chart-grid)" />;
  const x = (
    <XAxis
      dataKey="day"
      tickFormatter={axisLabel}
      tick={axis}
      tickLine={false}
      axisLine={false}
      interval="preserveStartEnd"
      minTickGap={20}
    />
  );
  const tooltip = (cursor: object) => (
    <Tooltip
      cursor={cursor}
      content={(p) => tip({ active: p.active, payload: p.payload as readonly { payload?: Row }[], label: p.label })}
      isAnimationActive={false}
    />
  );
  const areas = split
    ? [
        { key: "direct_bytes", label: tr("直连", "Direct"), slot: 1 },
        { key: "relay_bytes", label: tr("中转", "Relay"), slot: 2 },
        ...(hasOther ? [{ key: "other_bytes", label: tr("其他", "Other"), slot: 3 }] : []),
      ]
    : [{ key: "traffic", label: titles.traffic, slot: 1 }];
  return (
    <figure className={cn("grid", className)}>
      <figcaption className="sr-only">{titles[metric]}</figcaption>
      {data.length === 0 ? (
        <p className="py-8 text-center text-body text-muted-foreground">{tr("暂无数据", "No data")}</p>
      ) : (
        <div style={{ height }} aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            {metric === "traffic" ? (
              <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  {areas.map((a) => (
                    <linearGradient key={a.key} id={`${id}-${a.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color(a.slot)} stopOpacity={0.16} />
                      <stop offset="100%" stopColor={color(a.slot)} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                {grid}
                {x}
                <YAxis
                  tick={axis}
                  tickLine={false}
                  axisLine={false}
                  width={58}
                  tickCount={5}
                  tickFormatter={(v: number) => bytes(v)}
                />
                {tooltip({ stroke: "var(--chart-axis)", strokeDasharray: "3 3" })}
                {areas.map((a) => (
                  <Area
                    key={a.key}
                    dataKey={a.key}
                    name={a.label}
                    type="monotone"
                    stackId={split ? "t" : undefined}
                    stroke={color(a.slot)}
                    strokeWidth={2}
                    fill={`url(#${id}-${a.key})`}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            ) : (
              <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="28%">
                {grid}
                {x}
                <YAxis
                  tick={axis}
                  tickLine={false}
                  axisLine={false}
                  width={metric === "net" ? 52 : 36}
                  tickCount={4}
                  allowDecimals={false}
                  tickFormatter={(v: number) => (metric === "net" ? compactYuan(v) : String(v))}
                />
                <ReferenceLine y={0} stroke="var(--chart-grid)" />
                {tooltip({ fill: "var(--accent)" })}
                <Bar
                  dataKey={metric}
                  name={titles[metric]}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={18}
                  isAnimationActive={false}
                >
                  {rows.map((r, i) => (
                    <Cell key={i} fill={metric === "net" && r.net < 0 ? "var(--destructive)" : color(1)} />
                  ))}
                </Bar>
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
      {data.length > 0 && (
        <SrTable
          title={titles[metric]}
          times={rows.map((r) => tipLabel(r.day))}
          cols={
            metric === "traffic"
              ? areas.map((a) => ({
                  label: a.label,
                  values: rows.map((r) => bytes((r as unknown as Record<string, number>)[a.key] ?? 0)),
                }))
              : [
                  {
                    label: titles[metric],
                    values: rows.map((r) => fmt((r as unknown as Record<string, number>)[metric] ?? 0)),
                  },
                ]
          }
        />
      )}
    </figure>
  );
}
