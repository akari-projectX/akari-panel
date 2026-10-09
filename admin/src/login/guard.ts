// The sign-in page's guard settings across refetches of /auth/options.
import type { AuthOptions } from "./app";

/** A held form token older than this is replaced on the next refetch (the panel accepts it for 24 h). */
export const TOKEN_REFRESH_MS = 6 * 3600_000;

const withoutToken = (o: AuthOptions) =>
  JSON.stringify({ ...o, guard: o.guard && { ...o.guard, form_token: o.guard.form_token ? 1 : null } });
const guardWithoutToken = (o: AuthOptions) =>
  JSON.stringify(o.guard && { ...o.guard, form_token: o.guard.form_token ? 1 : null });

/**
 * The options to keep after a refetch. The form token is not single-use (the panel only checks
 * its age), so a held token that is still fresh is kept while the guard settings are unchanged:
 * a background refetch must not restart the minimum-submit wait. Nothing changed but the token
 * = the current object (no re-render); other fields changed = the new options with the held
 * token; guard settings changed (e.g. the minimum time 0 → 2 s) or an old token = the new ones.
 */
export function mergeOptions(cur: AuthOptions | null, next: AuthOptions, heldMs: number): AuthOptions {
  if (!cur?.guard?.form_token || !next.guard || heldMs > TOKEN_REFRESH_MS) return next;
  if (guardWithoutToken(cur) !== guardWithoutToken(next)) return next;
  if (withoutToken(cur) === withoutToken(next)) return cur;
  return { ...next, guard: { ...next.guard, form_token: cur.guard.form_token } };
}
