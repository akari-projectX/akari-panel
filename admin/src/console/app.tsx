// The console root (the router's root route): loads the session and the
// site facts, then renders the shell around the current page's route.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Outlet, ScrollRestoration } from "react-router";
import { ApiError, get, logout, setUnauthorizedHandler, type Me } from "../shared/api";
import { loadPage, loginBase, loginUrl, prefixBase } from "../shared/base";
import { setTimeZone } from "../shared/format";
import { useTr } from "../shared/i18n";
import { ErrorState, Skeleton } from "../shared/ui/states";
import { ALL_NAV, MORE } from "./nav";
import { useRoute } from "./router";
import { MeContext, SiteContext, type Site } from "./session";
import { Shell } from "./shell";

type SettingsHead = {
  site_name: string | null;
  timezone: { effective: string };
};
type Branding = { favicon_url: string | null; logo_url: string | null };

export function ConsoleApp() {
  const tr = useTr();
  const route = useRoute();
  useEffect(() => {
    setUnauthorizedHandler(() => loadPage(loginUrl()));
    return () => setUnauthorizedHandler(null);
  }, []);
  const me = useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/me"), staleTime: 60_000 });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => get<SettingsHead>("/settings"),
    enabled: me.data?.role === "admin",
  });
  const branding = useQuery({
    queryKey: ["settings", "branding"],
    queryFn: () => get<Branding>("/settings/branding"),
    enabled: me.data?.role === "admin",
    staleTime: 60_000,
  });

  useEffect(() => {
    if (me.data && me.data.role !== "admin") void logout().finally(() => loadPage(loginBase));
  }, [me.data]);

  const site: Site = useMemo(() => {
    const tz = settings.data?.timezone.effective ?? "Asia/Shanghai";
    setTimeZone(tz);
    return {
      siteName: settings.data?.site_name || "Akari",
      timezone: tz,
      logoUrl: branding.data?.logo_url ? `${prefixBase}/${branding.data.logo_url}` : null,
    };
  }, [settings.data, branding.data?.logo_url]);

  const page = [...ALL_NAV, MORE].find((n) => n.id === route.page) ?? ALL_NAV[0];
  useEffect(() => {
    const fav = branding.data?.favicon_url;
    if (!fav) return;
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = `${prefixBase}/${fav}`;
    document.head.appendChild(link);
    return () => link.remove();
  }, [branding.data?.favicon_url]);

  if (me.isError && !(me.error instanceof ApiError && me.error.status === 401))
    return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  if (!me.data || me.data.role !== "admin" || !settings.data) return <BootSkeleton label={tr("加载中", "Loading")} />;

  return (
    <MeContext.Provider value={me.data}>
      <SiteContext.Provider value={site}>
        <Shell page={page.id}>
          <Outlet />
        </Shell>
        <ScrollRestoration />
      </SiteContext.Provider>
    </MeContext.Provider>
  );
}

export function BootSkeleton({ label }: { label: string }) {
  return (
    <div className="min-h-dvh bg-window" role="status" aria-label={label}>
      <div className="fixed inset-y-2 left-2 hidden w-[232px] rounded-[18px] bg-(--glass-sidebar) lg:block" />
      <div className="grid gap-4 p-4 sm:p-6 lg:ml-[248px] lg:p-8">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
