import { useEffect } from "react";

import { useT } from "../i18n";

/**
 * The site name shown in titles. W21 makes it a setting; until then the
 * product name (one hook, so only this function changes).
 */
export function useSiteName(): string {
  return useT()("common.appName");
}

/** `document.title` = "<view> · <site>" while the calling view is shown (audit Minor 12). */
export function useDocumentTitle(view: string): void {
  const t = useT();
  const site = useSiteName();
  useEffect(() => {
    document.title = view ? t("common.pageTitle", { view, site }) : site;
  }, [view, site, t]);
}
