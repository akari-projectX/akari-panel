// "Recently opened" for the command palette: objects the admin opened (a
// user, a ticket, a server, a settings section…), newest first, at most 6,
// kept in this browser only (localStorage `akari.admin.recent`). The shell
// records an entry whenever a page names the object it shows (useCrumb).

const KEY = "akari.admin.recent";
const MAX = 6;

/** `page` is the navigation id (its label is translated when shown). */
export type Recent = { label: string; page: string; to: string };

export function readRecent(): Recent[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v)
      ? v
          .filter(
            (r): r is Recent =>
              !!r &&
              typeof r.label === "string" &&
              typeof r.page === "string" &&
              typeof r.to === "string" &&
              r.to.startsWith("/"),
          )
          .slice(0, MAX)
      : [];
  } catch {
    return [];
  }
}

export function pushRecent(r: Recent): void {
  try {
    const rest = readRecent().filter((x) => x.to !== r.to && !(x.page === r.page && x.label === r.label));
    localStorage.setItem(KEY, JSON.stringify([r, ...rest].slice(0, MAX)));
  } catch {
    /* storage blocked */
  }
}
