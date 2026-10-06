// W20 (B1): the subscription URL in each format and the one-click import
// links of common clients. Pure functions (unit-tested); the URL itself
// comes from GET /me (`sub_url`, absolute or root-relative on this origin).

/** Formats the panel serves (`?format=`; "auto" = by the client's User-Agent). */
export type SubFormat = "auto" | "clash" | "sing-box" | "links";

export const SUB_FORMATS: SubFormat[] = ["auto", "clash", "sing-box", "links"];

/** The subscription URL with an explicit format (none for "auto"). */
export function withFormat(url: string, format: SubFormat): string {
  if (format === "auto") return url;
  return `${url}${url.includes("?") ? "&" : "?"}format=${format}`;
}

/**
 * URL-safe base64 without padding of a UTF-8 string (Shadowrocket's
 * `sub://` form: standard base64's `+`, `/` and `=` would be read as URL
 * syntax by the deep link, W30).
 */
function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface ImportLink {
  id: string;
  /** Client name (a proper noun, not translated). */
  name: string;
  href: string;
}

/**
 * One-click import deep links. `name` labels the profile in the client.
 * Each uses the format the client understands (W30, verified against the
 * clients' documented schemes): Clash Verge / FlClash / Mihomo Party /
 * Clash Meta for Android and Stash take Clash (with the routing rules);
 * sing-box apps the sing-box profile; Shadowrocket base64 share links.
 * Hiddify gets the plain URL: a query in its `hiddify://import/` link is
 * not reliably kept, and the panel recognises its User-Agent (share links,
 * Hiddify applies its own routing).
 */
export function importLinks(url: string, name: string): ImportLink[] {
  const enc = encodeURIComponent;
  const clash = withFormat(url, "clash");
  const singbox = withFormat(url, "sing-box");
  return [
    {
      id: "clash",
      name: "Clash Verge / mihomo",
      href: `clash://install-config?url=${enc(clash)}&name=${enc(name)}`,
    },
    {
      id: "shadowrocket",
      name: "Shadowrocket",
      href: `shadowrocket://add/sub://${base64Url(withFormat(url, "links"))}?remark=${enc(name)}`,
    },
    {
      id: "sing-box",
      name: "sing-box",
      href: `sing-box://import-remote-profile?url=${enc(singbox)}#${enc(name)}`,
    },
    { id: "stash", name: "Stash", href: `stash://install-config?url=${enc(clash)}&name=${enc(name)}` },
    { id: "hiddify", name: "Hiddify", href: `hiddify://import/${url}#${enc(name)}` },
  ];
}
