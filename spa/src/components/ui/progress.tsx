import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const normalized = typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : 0

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={normalized}
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - normalized}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
