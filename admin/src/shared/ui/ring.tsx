// Small dependency-free SVG gauges (no chart library in the chunks that
// only need these).
import { useId, type ReactNode } from "react";
import { cn } from "../cn";

export function Ring({
  value,
  size = 56,
  tone = "primary",
  label,
}: {
  value: number;
  size?: number;
  tone?: "primary" | "warning" | "danger" | "success";
  label?: string;
}) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const color = {
    primary: "var(--chart-1)",
    warning: "var(--warning)",
    danger: "var(--destructive)",
    success: "var(--success)",
  }[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" role="img" aria-label={label}>
      <circle cx="28" cy="28" r={r} fill="none" stroke="var(--muted)" strokeWidth="6" />
      <circle
        cx="28"
        cy="28"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${(value / 100) * c} ${c}`}
        transform="rotate(-90 28 28)"
        className="transition-[stroke-dasharray] duration-(--dur-base)"
      />
      <text x="28" y="32" textAnchor="middle" fontSize="12" fontWeight="600" fill="currentColor" className="tnum">
        {value}%
      </text>
    </svg>
  );
}

/**
 * A tiny trend line for KPI cards (decorative; the number is next to it):
 * a 1.75px smooth line over a fill fading from 18% to 0, scaled to the
 * data's own min…max like the design's sparklines. Pure SVG (no chart
 * library on the first screen).
 */
export function Sparkline({ data, className, slot = 1 }: { data: number[]; className?: string; slot?: number }) {
  const id = useId().replace(/:/g, "");
  if (data.length < 2) return null;
  const w = 120;
  const h = 36;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 3 - ((v - min) / (max - min || 1)) * (h - 6)]);
  // Monotone-ish curve: horizontal control points halfway between samples.
  const d = pts
    .map((p, i) => {
      if (!i) return `M${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      const q = pts[i - 1];
      const mx = ((q[0] + p[0]) / 2).toFixed(1);
      return `C${mx},${q[1].toFixed(1)} ${mx},${p[1].toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    })
    .join(" ");
  const color = `var(--chart-${slot})`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-9 w-full", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={`url(#${id}-f)`} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Ring gauge with a label and a detail line (v2 Gauge: system status,
 * server monitoring). Primary below 80, amber from 80, red from 95.
 * `value` null = no reading (a dash, grey ring).
 */
export function Gauge({
  value,
  label,
  detail,
  size = 64,
}: {
  value: number | null;
  label: ReactNode;
  detail?: ReactNode;
  size?: number;
}) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const tone = v >= 95 ? "var(--destructive)" : v >= 80 ? "var(--warning)" : "var(--primary)";
  return (
    <div className="flex min-w-0 flex-col items-center text-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="color-mix(in srgb, var(--foreground) 8%, transparent)"
            strokeWidth={6}
          />
          {value != null && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={tone}
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray={`${(c * v) / 100} ${c}`}
              className="transition-[stroke-dasharray] duration-(--dur-base)"
            />
          )}
        </svg>
        <span className="tnum absolute inset-0 flex items-center justify-center text-callout font-semibold">
          {value == null ? (
            "—"
          ) : (
            <>
              {Math.round(v)}
              <span className="text-caption text-faint">%</span>
            </>
          )}
        </span>
      </div>
      <div className="mt-1.5 text-footnote font-medium">{label}</div>
      {detail && <div className="tnum max-w-full truncate text-caption text-muted-foreground">{detail}</div>}
    </div>
  );
}

/** v2 name of the KPI sparkline. */
export const Spark = Sparkline;
