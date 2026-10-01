import { LOCALES, setLocale, useLocale, useT } from "./core";
import type { Locale } from "./types";

const LABEL: Record<Locale, string> = { zh: "中文", en: "English" };

/** Language picker for the user-facing surfaces (choice persisted). */
export function LocaleSwitch() {
  const locale = useLocale();
  const t = useT();
  return (
    <div role="group" aria-label={t("common.language")} className="inline-flex rounded-lg border border-border p-0.5 text-xs">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l === "zh" ? "zh-CN" : "en"}
          aria-pressed={locale === l}
          onClick={() => setLocale(l)}
          className={`rounded-md px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            locale === l ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {LABEL[l]}
        </button>
      ))}
    </div>
  );
}
