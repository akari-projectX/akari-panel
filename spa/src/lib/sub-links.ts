// W20 (B1): the subscription URL in each format and the one-click import
// links of common clients. Pure functions (unit-tested); the URL itself
// comes from GET /me (`sub_url`, or the token on this origin).

/** Formats the panel serves (`?format=`; "auto" = by the client's User-Agent). */
export type SubFormat = "auto" | "clash" | "sing-box" | "links";

export const SUB_FORMATS: SubFormat[] = ["auto", "clash", "sing-box", "links"];

/** The subscription URL with an explicit format (none for "auto"). */
export function withFormat(url: string, format: SubFormat): string {
  if (format === "auto") return url;
  return `${url}${url.includes("?") ? "&" : "?"}format=${format}`;
}

/** Standard base64 of a UTF-8 string (Shadowrocket's `sub://` form). */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface ImportLink {
  id: string;
  /** Client name (a proper noun, not translated). */
  name: string;
  href: string;
}

/**
 * One-click import deep links. `name` labels the profile in the client.
 * Each uses the format the client understands, so it does not depend on
 * the client's User-Agent being recognised.
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
      href: `shadowrocket://add/sub://${base64(withFormat(url, "links"))}?remark=${enc(name)}`,
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
