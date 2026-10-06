// The signed-in admin and the site facts every page needs (time zone,
// site name), loaded once by the shell.
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { get, type Me } from "../shared/api";

export type Site = { siteName: string; timezone: string };

export const MeContext = createContext<Me | null>(null);
export const SiteContext = createContext<Site>({ siteName: "Akari", timezone: "Asia/Shanghai" });

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
