import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { ApiError, get, logout, setUnauthorizedHandler, type Me } from "../shared/api";
import { loadPage, loginBase, loginUrl, prefixBase } from "../shared/base";
import { setTimeZone } from "../shared/format";
import { useTr } from "../shared/i18n";
import { ErrorState, Skeleton } from "../shared/ui/primitives";
import { ALL_NAV } from "./nav";
import { PAGES } from "./pages/index";
import { useRoute } from "./router";
import { MeContext, SiteContext, type Site } from "./session";
import { Shell } from "./shell";

type SettingsHead = {
  site_name: string | null;
  timezone: { effective: string };
};
type Branding = { favicon_url: string | null };

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
    return { siteName: settings.data?.site_name || "Akari", timezone: tz };
  }, [settings.data]);

  const page = ALL_NAV.find((n) => n.id === route.page) ?? ALL_NAV[0];
  useEffect(() => {
    document.title = `${tr(page.zh, page.en)} · ${site.siteName} ${tr("管理后台", "admin")}`;
  }, [page, site.siteName, tr]);
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
  if (!me.data || me.data.role !== "admin" || !settings.data)
    return (
      <div className="space-y-3 p-6" role="status" aria-label={tr("加载中", "Loading")}>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );

  const Page = PAGES[page.id];
  return (
    <MeContext.Provider value={me.data}>
      <SiteContext.Provider value={site}>
        <Shell page={page.id}>
          <Page key={page.id} />
        </Shell>
      </SiteContext.Provider>
    </MeContext.Provider>
  );
}
