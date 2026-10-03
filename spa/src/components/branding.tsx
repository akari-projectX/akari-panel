// Ops: site branding in both bundles — the logo next to the site name, the
// favicon, and the footer (text, links, terms / privacy). Everything comes
// from the public /auth/options (`branding`); nothing renders while it
// loads or when the panel is older.
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { useT } from "../i18n";
import { authOptions, brandUrl, type Branding } from "../lib/api";
import { useSiteName } from "../lib/title";

export function useBranding(): Branding | null {
  const options = useQuery({ queryKey: ["auth-options"], queryFn: authOptions, retry: false, staleTime: 60_000 });
  return options.data?.branding ?? null;
}

/** Point <link rel="icon"> at the uploaded favicon (when there is one). */
export function useFavicon(): void {
  const favicon = useBranding()?.favicon_url;
  useEffect(() => {
    if (!favicon) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    link.href = brandUrl(favicon);
  }, [favicon]);
}

/** Logo (if uploaded) + site name. */
export function SiteMark({ className = "" }: { className?: string }) {
  const t = useT();
  const site = useSiteName();
  const logo = useBranding()?.logo_url;
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-semibold tracking-tight ${className}`}>
      {logo && <img src={brandUrl(logo)} alt={t("brand.logoAlt", { site })} className="h-7 w-auto max-w-[8rem]" />}
      <span>{site}</span>
    </span>
  );
}

const linkClass = "underline underline-offset-4 hover:text-foreground";

/** Footer: text, links, terms / privacy. Nothing when none is set. */
export function SiteFooter({ className = "" }: { className?: string }) {
  const t = useT();
  const b = useBranding();
  if (!b) return null;
  const links = [
    ...b.footer_links,
    ...(b.tos_url ? [{ label: t("brand.tos"), url: b.tos_url }] : []),
    ...(b.privacy_url ? [{ label: t("brand.privacy"), url: b.privacy_url }] : []),
  ];
  if (!b.footer_text && links.length === 0) return null;
  return (
    <footer className={`border-t border-border px-4 py-6 text-center text-xs text-muted-foreground ${className}`}>
      {b.footer_text && <p className="whitespace-pre-line">{b.footer_text}</p>}
      {links.length > 0 && (
        <nav aria-label={t("brand.footerNav")} className="mt-2">
          <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
            {links.map((l, i) => (
              <li key={`${i}-${l.url}`}>
                <a
                  className={linkClass}
                  href={l.url}
                  {...(l.url.startsWith("/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </footer>
  );
}
