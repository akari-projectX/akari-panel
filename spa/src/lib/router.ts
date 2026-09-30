import { useEffect, useState } from "react";

// Minimal history routing: enough for a console, no dependency churn.
export function usePath(): string {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const onChange = () => setPath(location.pathname);
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return path;
}

export function navigate(to: string): void {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
