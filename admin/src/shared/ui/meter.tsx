import { cn } from "../cn";

export type MeterTone = "primary" | "warning" | "danger" | "success";

/** Usage bar: yellow from 80%, red at 100% (always shown next to the number). */
export function Meter({
  value,
  tone,
  className,
  label,
}: {
  value: number;
  tone?: MeterTone;
  className?: string;
  label?: string;
}) {
  const t = tone ?? usageTone(value);
  const color = { primary: "bg-primary", warning: "bg-warning", danger: "bg-destructive", success: "bg-success" }[t];
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]",
        className,
      )}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-(--dur-base)", color)}
        style={{ width: `${v > 0 ? Math.max(2, v) : 0}%` }}
      />
    </div>
  );
}

export function usageTone(p: number): MeterTone {
  return p >= 100 ? "danger" : p >= 80 ? "warning" : "primary";
}
