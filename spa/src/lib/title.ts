import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { useT } from "../i18n";
import { authOptions } from "./api";

/**
 * The site name shown in titles: 系统设置 → 站点名称 (W21), published by
 * the public `/auth/options`; the product name until it loads or when the
 * panel is older. Same query key as the login page's options (one request).
 */
export function useSiteName(): string {
  const fallback = useT()("common.appName");
  const options = useQuery({ queryKey: ["auth-options"], queryFn: authOptions, retry: false, staleTime: 60_000 });
  return options.data?.site_name || fallback;
}

/** `document.title` = "<view> · <site>" while the calling view is shown (audit Minor 12). */
export function useDocumentTitle(view: string): void {
  const t = useT();
  const site = useSiteName();
  useEffect(() => {
    document.title = view ? t("common.pageTitle", { view, site }) : site;
  }, [view, site, t]);
}
