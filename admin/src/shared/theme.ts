import { useCallback, useEffect, useState } from "react";

// Light / dark: `.dark` on <html>; localStorage, else the OS preference.
// Applied from the bundle (no inline script: CSP script-src 'self').
const KEY = "akari.admin.theme";
export type Theme = "light" | "dark";

export function initialTheme(): Theme {
  try {
    const s = localStorage.getItem(KEY);
    if (s === "dark" || s === "light") return s;
  } catch {
    /* storage blocked */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle("dark", t === "dark");
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* storage blocked */
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}
