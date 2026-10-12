import { useEffect, useSyncExternalStore } from "react"
import { useTheme } from "@/lib/theme"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { toasterMounted } from "@/lib/toast"

/* 和 sonner 自己的手机断点（600px）一致 */
const NARROW = "(max-width: 600px)"
const subscribeNarrow = (f: () => void) => {
  const mq = window.matchMedia(NARROW)
  mq.addEventListener("change", f)
  return () => mq.removeEventListener("change", f)
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme()
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false)
  /* 挂上之后 lib/toast 才放行排队的提示；sonner 自己的订阅在子组件的 effect 里，先于这里执行 */
  useEffect(() => { toasterMounted() }, [])

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      /*
       * 桌面在右下角：右上角正好压住页头的账户菜单。手机在顶部居中（sonner 的 mobileOffset），让出刘海的安全区；
       * 弹窗开着时它在遮罩之上（z-index 比弹窗高），不会被盖住也不挡弹窗的按钮。
       */
      position={narrow ? "top-center" : "bottom-right"}
      offset={24}
      mobileOffset={{ top: "calc(env(safe-area-inset-top) + 12px)", left: 12, right: 12 }}
      gap={10}
      duration={3200}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" />,
        info: <InfoIcon className="size-4 text-brand" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" />,
        error: <OctagonXIcon className="size-4 text-danger" />,
        loading: <Loader2Icon className="size-4 animate-spin text-brand" />,
      }}
      style={
        {
          // 与站点同一套字体栈，避免 sonner 默认字体与全站不一致
          fontFamily: "var(--font-sans)",
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "0.875rem",
          "--width": "356px",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "cn-toast group !font-sans !items-start !gap-3 !rounded-[14px] " +
            "!border-border/70 !bg-popover !px-3.5 !py-3 " +
            "!shadow-[0_12px_32px_-12px_rgba(13,21,38,.18),0_1px_3px_rgba(13,21,38,.06)] " +
            "dark:!shadow-[0_12px_32px_-10px_rgba(0,0,0,.6)]",
          icon:
            "!mt-px !mr-0 !size-6 !shrink-0 !items-center !justify-center !rounded-full " +
            "group-data-[type=success]:!bg-emerald-500/10 group-data-[type=info]:!bg-brand/10 " +
            "group-data-[type=warning]:!bg-amber-500/12 group-data-[type=error]:!bg-red-500/10 " +
            "group-data-[type=loading]:!bg-brand/10",
          content: "!gap-0.5",
          title: "!text-[13.5px] !font-medium !leading-[1.5] !tracking-[-0.01em] !text-foreground",
          description:
            "!text-[12.5px] !leading-[1.6] !text-muted-foreground group-data-[type=success]:!text-muted-foreground",
          actionButton:
            "!h-7 !rounded-lg !bg-brand !px-2.5 !text-[12.5px] !font-medium !text-white dark:!text-primary-foreground",
          cancelButton:
            "!h-7 !rounded-lg !bg-muted !px-2.5 !text-[12.5px] !font-medium !text-muted-foreground",
          closeButton: "!rounded-md !border-border !bg-popover",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
