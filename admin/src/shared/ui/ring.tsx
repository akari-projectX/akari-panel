// Small dependency-free SVG gauges (no chart library in the chunks that
// only need these).
import { type ReactNode } from "react";

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
