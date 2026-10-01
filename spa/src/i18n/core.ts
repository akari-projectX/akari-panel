// Tiny dependency-free i18n for the user-facing surfaces (login, portal,
// purchase). The admin console is Chinese only and pins "zh" with
// <FixedLocale> (shared cards such as the 2FA card then render Chinese).
//
//   const t = useT();  t("login.title");  t("portal.expires", { date })
//   const locale = useLocale();  setLocale("en");  <LocaleSwitch />
//
// Locale: the stored choice (localStorage "akari.locale"), else the
// browser's languages (zh* -> zh, else en). <html lang> follows the
// visible locale. See spa/CLAUDE.md "i18n" for adding a namespace.
import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";

import { en } from "./en";
import type { Locale, MessageKey, Messages, TFunction, Vars } from "./types";
import { zh } from "./zh";

export const LOCALES: readonly Locale[] = ["zh", "en"];
const STORAGE_KEY = "akari.locale";
const DICTS: Record<Locale, Messages> = { zh, en };
const HTML_LANG: Record<Locale, string> = { zh: "zh-CN", en: "en" };

function stored(): Locale | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "zh" || v === "en" ? v : null;
  } catch {
    return null;
  }
}

/** The browser's preferred locale among ours. */
export function detectLocale(languages: readonly string[] = navigator.languages ?? [navigator.language]): Locale {
  for (const l of languages) {
    const tag = l.toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

let current: Locale = stored() ?? detectLocale();
const listeners = new Set<() => void>();

export function setLocale(locale: Locale): void {
  current = locale;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Private mode / blocked storage: the choice lasts for this page only.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// A pinned locale (admin console) wins over the user's choice.
const Fixed = createContext<Locale | null>(null);

export function FixedLocale({ locale, children }: { locale: Locale; children: ReactNode }) {
  return createElement(Fixed.Provider, { value: locale }, children);
}

/** The locale in effect here (pinned or chosen). */
export function useLocale(): Locale {
  const chosen = useSyncExternalStore(subscribe, () => current);
  return useContext(Fixed) ?? chosen;
}

/** Keep <html lang> in sync with the visible locale (mount once per surface). */
export function useHtmlLang(locale: Locale): void {
  useEffect(() => {
    document.documentElement.lang = HTML_LANG[locale];
  }, [locale]);
}

function lookup(dict: Messages, key: MessageKey): string {
  const [ns, name] = key.split(".") as [keyof Messages, string];
  const group = dict[ns] as Record<string, string> | undefined;
  return group?.[name] ?? key;
}

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const text = lookup(DICTS[locale], key);
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function useT(): TFunction {
  const locale = useLocale();
  return (key, vars) => translate(locale, key, vars);
}
