import { useCallback, useSyncExternalStore } from "react";

// Light / dark: `.dark` on <html>; localStorage, else the OS preference.
// Applied from the bundle (no inline script: CSP script-src 'self'). One
// store for the whole page, so every toggle (toolbar, menu, "More") agrees.
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

const listeners = new Set<() => void>();

export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle("dark", t === "dark");
  listeners.forEach((l) => l());
}

function current(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function setTheme(t: Theme): void {
  applyTheme(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage blocked */
  }
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    current,
    () => "light" as Theme,
  );
  const toggle = useCallback(() => setTheme(current() === "dark" ? "light" : "dark"), []);
  return [theme, toggle];
}
