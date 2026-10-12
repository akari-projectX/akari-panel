import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

/*
 * 复选框（Radix）。站内的勾选都用它，不用原生 checkbox：外形与开关、输入框一致，
 * 放在 <label> 里时整行可点（注销弹窗的「我已了解」）。tone=danger 勾上是红色。
 */
function Checkbox({
  className, tone = "brand", ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & { tone?: "brand" | "danger" }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer grid size-[18px] shrink-0 place-items-center rounded-[5px] border border-input bg-card outline-none transition-colors",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
        tone === "danger"
          ? "data-[state=checked]:border-red-600 data-[state=checked]:bg-red-600"
          : "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="pop-in text-white">
        <CheckIcon className="size-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
