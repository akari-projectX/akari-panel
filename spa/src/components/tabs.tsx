import { useId, useRef, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { ScrollFade } from "./ui/table";

// Tabs (WAI-ARIA tab pattern, automatic activation): arrows/Home/End move
// between tabs, the selected one is the only tab stop. `children` is the
// selected tab's panel. Used by 系统设置 (W21, M11).
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string;
  tabs: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  children: ReactNode;
}) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === value);
    const to = (n: number) => {
      e.preventDefault();
      const t = tabs[(n + tabs.length) % tabs.length];
      onChange(t.id);
      list.current?.querySelector<HTMLButtonElement>(`[data-tab="${t.id}"]`)?.focus();
    };
    if (e.key === "ArrowRight") to(i + 1);
    else if (e.key === "ArrowLeft") to(i - 1);
    else if (e.key === "Home") to(0);
    else if (e.key === "End") to(tabs.length - 1);
  };
  return (
    <div className="space-y-6">
      <ScrollFade>
        <div
          ref={list}
          role="tablist"
          aria-label={label}
          className="flex w-max min-w-full gap-1 border-b border-border"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab={t.id}
              id={`${base}-${t.id}`}
              aria-selected={value === t.id}
              aria-controls={`${base}-${t.id}-panel`}
              tabIndex={value === t.id ? 0 : -1}
              onClick={() => onChange(t.id)}
              onKeyDown={onKey}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                value === t.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </ScrollFade>
      <div role="tabpanel" id={`${base}-${value}-panel`} aria-labelledby={`${base}-${value}`}>
        {children}
      </div>
    </div>
  );
}
