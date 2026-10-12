// The signed-in admin and the site facts every page needs (time zone,
// site name, logo), loaded once by the shell; the page breadcrumb.
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import { get, type Me } from "../shared/api";

export type Site = { siteName: string; timezone: string; logoUrl: string | null };

export const MeContext = createContext<Me | null>(null);
export const SiteContext = createContext<Site>({ siteName: "Akari", timezone: "Asia/Shanghai", logoUrl: null });

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside the console");
  return me;
}

export function useSite(): Site {
  return useContext(SiteContext);
}

export type Badges = { tickets_open: number; tickets_unread: number; alerts_firing: number };

export function useBadges() {
  return useQuery({
    queryKey: ["admin-badges"],
    queryFn: () => get<Badges>("/admin-badges"),
    refetchInterval: 30_000,
  });
}

/** The breadcrumb below the page (a settings section, an open record…), set by the page. */
export const CrumbContext = createContext<(c: string | null) => void>(() => {});

/** Show `label` after the page name in the toolbar breadcrumb while mounted. */
export function useCrumb(label: string | null | undefined): void {
  const set = useContext(CrumbContext);
  useEffect(() => {
    set(label ?? null);
    return () => set(null);
  }, [label, set]);
}

/**
 * True once the open page is ready (`main[data-ready]`): heavy extras that
 * are not the page's data (the dashboard chart, i.e. recharts) mount only
 * then, so loading and running their code does not hold up the first screen.
 */
export function useAfterReady(): boolean {
  const [ok, setOk] = useState(() => !!document.querySelector("main[data-ready]"));
  useEffect(() => {
    if (ok) return;
    const check = () => {
      if (document.querySelector("main[data-ready]")) setOk(true);
    };
    const obs = new MutationObserver(check);
    obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-ready"], childList: true });
    check();
    return () => obs.disconnect();
  }, [ok]);
  return ok;
}
