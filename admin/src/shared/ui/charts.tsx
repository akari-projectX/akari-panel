import { cn } from "../cn";

/* Dependency-free SVG charts (W33-b may swap in a chart lib). */
export function Sparkline({
  data,
  className,
  color = "var(--chart-1)",
}: {
  data: number[];
  className?: string;
  color?: string;
}) {
  const w = 120;
  const h = 36;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 3 - ((v - min) / (max - min || 1)) * (h - 6)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-9 w-full", className)}
      aria-hidden="true"
    >
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Bars({
  data,
  labels,
  unit,
  className,
}: {
  data: number[];
  labels: string[];
  unit: string;
  className?: string;
}) {
  const max = Math.max(...data) * 1.1;
  return (
    <div className={cn("flex h-44 items-end gap-1.5 sm:gap-2", className)}>
      {data.map((v, i) => (
        <div key={i} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
          <div className="relative flex w-full flex-1 items-end">
            <div
              className="w-full rounded-t bg-chart-1/80 transition-colors group-hover:bg-chart-1"
              style={{ height: `${(v / max) * 100}%` }}
            />
            <div className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[11px] text-background group-hover:block">
              {v} {unit}
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground">{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}

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
      />
      <text x="28" y="32" textAnchor="middle" fontSize="12" fontWeight="600" fill="currentColor">
        {value}%
      </text>
    </svg>
  );
}
