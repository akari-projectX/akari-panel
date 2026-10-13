import { Tabs as T } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../cn";

/**
 * Underline tabs (page sections, dialog sections): a tablist with arrow-key
 * navigation; the caller renders the active panel. Scrolls sideways on a
 * phone instead of wrapping.
 */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode; count?: number }[];
  className?: string;
  label?: string;
}) {
  return (
    <T.Root value={value} onValueChange={(v) => onChange(v as T)} activationMode="manual">
      <T.List
        aria-label={label}
        className={cn("-mb-px flex gap-5 overflow-x-auto border-b border-separator [scrollbar-width:none]", className)}
      >
        {tabs.map((t) => (
          <T.Trigger
            key={t.value}
            value={t.value}
            className="relative flex h-10 shrink-0 items-center gap-1.5 text-body font-medium text-muted-foreground transition-colors duration-(--dur-hover) after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity hover:text-foreground focus-visible:text-primary focus-visible:outline-none data-[state=active]:text-foreground data-[state=active]:after:opacity-100"
          >
            {t.label}
            {t.count !== undefined && (
              <span className="tnum rounded-full bg-secondary px-1.5 text-caption text-muted-foreground">
                {t.count}
              </span>
            )}
          </T.Trigger>
        ))}
      </T.List>
    </T.Root>
  );
}
