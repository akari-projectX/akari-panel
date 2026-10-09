import { describe, expect, it } from "vitest";
import type { AuthOptions } from "./app";
import { TOKEN_REFRESH_MS, mergeOptions } from "./guard";

const opts = (form_token: string | null, form_min_secs: number, site_name = "A"): AuthOptions => ({
  site_name,
  branding: null,
  passkey: false,
  guard: { form_token, form_min_secs, honeypot: true, turnstile: null },
});

describe("mergeOptions", () => {
  it("keeps the held token (and the object) when only the token changed: no new wait", () => {
    const cur = opts("held", 2);
    expect(mergeOptions(cur, opts("new", 2), 30_000)).toBe(cur);
  });
  it("keeps the held token when other fields changed", () => {
    const m = mergeOptions(opts("held", 2), opts("new", 2, "B"), 30_000);
    expect(m.site_name).toBe("B");
    expect(m.guard?.form_token).toBe("held");
  });
  it("adopts the new token when the guard settings changed (0 → 2 s) or the held one is old", () => {
    expect(mergeOptions(opts(null, 0), opts("new", 2), 30_000).guard?.form_token).toBe("new");
    expect(mergeOptions(opts("held", 2), opts("new", 3), 30_000).guard?.form_min_secs).toBe(3);
    expect(mergeOptions(opts("held", 2), opts("new", 2), TOKEN_REFRESH_MS + 1).guard?.form_token).toBe("new");
    expect(mergeOptions(null, opts("new", 2), 0).guard?.form_token).toBe("new");
  });
});
