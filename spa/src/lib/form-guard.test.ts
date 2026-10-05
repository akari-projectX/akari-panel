import { afterEach, describe, expect, it, vi } from "vitest";

import { login, requestReset } from "./api";

type Call = { url: string; body: unknown };

function mockFetch(guard: unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const body = url.endsWith("/options")
        ? { register: false, invite_required: false, email_domains: [], reset: true, guard }
        : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

describe("formGuard (W27)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts the form token after the minimum submit time, honeypot empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const calls = mockFetch({ form_token: "tok-1", form_min_secs: 2, honeypot: true, turnstile: null });
    const done = login({ email: "a@example.com", password: "pw" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["options"]);
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(calls[1].body).toEqual({
      email: "a@example.com",
      password: "pw",
      guard: { form_token: "tok-1", website: "" },
    });
    // The token is reused while fresh (no second options call, no wait).
    await requestReset({ email: "a@example.com" });
    expect(calls.length).toBe(3);
    expect((calls[2].body as { guard: unknown }).guard).toEqual({ form_token: "tok-1", website: "" });
  });
});
