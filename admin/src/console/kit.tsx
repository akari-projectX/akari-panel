// Small page helpers shared by the console's views (writes go through
// data.ts `useAction`).
import { Copy } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { errorCode, errorText } from "../shared/errors";
import { copyText } from "../shared/format";
import { useLang, useTr } from "../shared/i18n";
import { Button } from "../shared/ui/button";
import { useConfirm } from "../shared/ui/confirm";
import { useToast } from "../shared/ui/toast";

/** Error text in the current language. */
export function useErrText() {
  const lang = useLang();
  return useCallback((e: unknown) => errorText(e, lang), [lang]);
}

/** A server error shown in place (mapped text + code). */
export function FormError({ error }: { error: unknown }) {
  const t = useErrText();
  if (!error) return null;
  return (
    <p role="alert" className="text-body text-destructive">
      {t(error)} <span className="font-mono text-caption opacity-70">{errorCode(error)}</span>
    </p>
  );
}

export function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const tr = useTr();
  const toast = useToast();
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={Copy}
      onClick={async () =>
        toast(
          (await copyText(text))
            ? { tone: "success", title: tr("已复制", "Copied") }
            : { tone: "error", title: tr("复制失败，请手动复制", "Copy failed; copy it by hand") },
        )
      }
    >
      {label ?? tr("复制", "Copy")}
    </Button>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-footnote break-all">{children}</code>;
}

/** Saving 0x makes the entrance free: ask first (never reached from an empty field). */
export function useConfirmFree() {
  const tr = useTr();
  const confirm = useConfirm();
  return (name: string) =>
    confirm({
      title: tr(`把 ${name} 设为 0x（免费）？`, `Make ${name} 0x (free)?`),
      description: tr(
        "0x 入口的流量不计入用户已用流量。确认要免费吗？",
        "Traffic on a 0x entrance is not counted against users' quota. Make it free?",
      ),
      tone: "warning",
    });
}
