// D4: everything of the admin app lives under the secret admin prefix:
// the sign-in page `/{prefix}/app`, the console `/{prefix}/admin/...`, the
// API `/{prefix}/api/v1`, auth `/{prefix}/auth`. Nothing is baked in: the
// prefix is the first path segment of the current location.
export const prefix: string = location.pathname.split("/")[1] ?? "";
export const prefixBase = `/${prefix}`;
export const loginBase = `${prefixBase}/app`;
export const adminBase = `${prefixBase}/admin`;
export const apiBase = `${prefixBase}/api/v1`;
export const authBase = `${prefixBase}/auth`;

/** Full-page navigation (login page <-> console are different bundles). */
export function loadPage(url: string): void {
  location.assign(url);
}

/** The sign-in URL that returns to `path` (a console path) afterwards. */
export function loginUrl(path: string = location.pathname + location.search): string {
  return path.startsWith(adminBase) && path !== adminBase ? `${loginBase}?next=${encodeURIComponent(path)}` : loginBase;
}

/** Where the sign-in page sends an admin: `next` when it is a console path. */
export function afterLogin(search: string): string {
  const next = new URLSearchParams(search).get("next");
  return next && next.startsWith(`${adminBase}/`) && !next.includes("//") ? next : adminBase;
}
