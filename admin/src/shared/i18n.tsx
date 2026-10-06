// Two languages, Chinese first (W33-b). Every UI string is written as
// `tr("中文", "English")` at its use site, so the two can never drift apart
// (the type requires both); server errors go through errors.ts.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "zh" | "en";
export type Tr = (zh: string, en: string) => string;

const KEY = "akari.admin.lang";

function initialLang(): Lang {
  try {
    const s = localStorage.getItem(KEY);
    if (s === "zh" || s === "en") return s;
  } catch {
    /* storage blocked */
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

type Ctx = { lang: Lang; setLang: (l: Lang) => void };
const LangContext = createContext<Ctx>({ lang: "zh", setLang: () => {} });

export function LangProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => initial ?? initialLang());
  useEffect(() => {
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {
      /* storage blocked */
    }
  }, []);
  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext).lang;
}

export function useSetLang(): (l: Lang) => void {
  return useContext(LangContext).setLang;
}

export function trFor(lang: Lang): Tr {
  return (zh, en) => (lang === "en" ? en : zh);
}

/** `tr("中文", "English")`. */
export function useTr(): Tr {
  const lang = useLang();
  return useCallback<Tr>((zh, en) => (lang === "en" ? en : zh), [lang]);
}
