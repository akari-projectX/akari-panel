// Small dependency-free SVG gauges (no chart library in the chunks that
// only need these).
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

/** A tiny trend line for KPI cards (decorative; the number is next to it). */
export function Sparkline({ data, className, slot = 1 }: { data: number[]; className?: string; slot?: number }) {
  if (data.length < 2) return null;
  const w = 120;
  const h = 36;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 3 - ((v - min) / (max - min || 1)) * (h - 6)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const color = `var(--chart-${slot})`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-9 w-full", className)}
      aria-hidden="true"
    >
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
