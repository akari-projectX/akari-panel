import { describe, expect, it } from "vitest";
import { affected } from "./data";

describe("affected", () => {
  it("refetches nothing after read-only POSTs", () => {
    for (const p of ["/settings/dns-check", "/plans/abc/impact", "/users/batch/preview", "/content/preview"]) {
      const f = affected(p);
      expect(f).not.toBe("all");
      if (f !== "all") expect(["settings", "plans", "users", "nodes"].some(f)).toBe(false);
    }
  });
  it("refetches the entity after real writes", () => {
    const f = affected("/settings/site");
    expect(f !== "all" && f("settings")).toBe(true);
    const g = affected("/plans/abc");
    expect(g !== "all" && g("plans")).toBe(true);
  });
});
