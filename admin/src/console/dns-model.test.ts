import { describe, expect, it } from "vitest";
import { trFor } from "../shared/i18n";
import {
  bodyOf,
  contentText,
  draftErrors,
  draftOf,
  impactOf,
  isIPv4,
  isIPv6,
  parseZoneKey,
  ttlText,
  type DnsRecord,
} from "./dns-model";

const tr = trFor("en");
const rec = (o: Partial<DnsRecord>): DnsRecord => ({
  id: "a".repeat(32),
  type: "A",
  name: "www.example.test",
  content: "192.0.2.1",
  proxied: false,
  proxiable: true,
  ttl: 300,
  comment: null,
  priority: null,
  data: null,
  zone_name: "example.test",
  modified_on: null,
  uses: [],
  ...o,
});

describe("dns model", () => {
  it("recognises addresses", () => {
    expect(isIPv4("192.0.2.1")).toBe(true);
    expect(isIPv4("256.0.0.1")).toBe(false);
    expect(isIPv4("1.2.3")).toBe(false);
    expect(isIPv6("2001:db8::1")).toBe(true);
    expect(isIPv6("192.0.2.1")).toBe(false);
    expect(isIPv6("zz::1")).toBe(false);
  });
  it("validates per type", () => {
    const d = draftOf(undefined, "x.test");
    expect(draftErrors({ ...d, name: "www", content: "192.0.2.1" }, tr)).toEqual({});
    expect(draftErrors({ ...d, name: "www", content: "2001:db8::1" }, tr).content).toBeTruthy();
    expect(draftErrors({ ...d, type: "AAAA", name: "w", content: "2001:db8::1" }, tr)).toEqual({});
    expect(draftErrors({ ...d, name: "a b", content: "192.0.2.1" }, tr).name).toBeTruthy();
    expect(
      draftErrors({ ...d, type: "MX", name: "m", content: "mail.x.test", priority: "x" }, tr).priority,
    ).toBeTruthy();
  });
  it("builds bodies; proxied is always automatic TTL", () => {
    const d = { ...draftOf(rec({ proxied: true, ttl: 300 })), proxied: true };
    const b = bodyOf(d, true);
    expect(b).toMatchObject({ type: "A", proxied: true, ttl: 1, confirm: true, content: "192.0.2.1" });
    const txt = bodyOf({ ...d, type: "TXT", content: "v=spf1 -all", proxied: true });
    expect(txt.proxied).toBeUndefined();
  });
  it("SRV and CAA go in data", () => {
    const srv = draftOf(
      rec({ type: "SRV", name: "_sip._tcp.x.test", data: { priority: 1, weight: 5, port: 5060, target: "s.x.test" } }),
    );
    expect(srv.srv.service).toBe("_sip");
    expect(bodyOf(srv).data).toMatchObject({ port: 5060, service: "_sip", name: "x.test" });
    expect(bodyOf(srv).content).toBeUndefined();
    const caa = draftOf(rec({ type: "CAA", data: { flags: 0, tag: "issue", value: "letsencrypt.org" } }));
    expect(bodyOf(caa).data).toEqual({ flags: 0, tag: "issue", value: "letsencrypt.org" });
    expect(contentText(rec({ type: "MX", priority: 10, content: "m.x.test" }))).toBe("10 m.x.test");
  });
  it("parses zone keys, impacts and ttls", () => {
    const acc = "11111111-1111-4111-8111-111111111111";
    expect(parseZoneKey(`${acc}:${"b".repeat(32)}`)).toEqual({ account: acc, zone: "b".repeat(32) });
    expect(parseZoneKey("x")).toBeNull();
    expect(impactOf({ impact: [{ name: "a.test", uses: [{ kind: "main", label: "主域名" }] }, 5] })).toHaveLength(1);
    expect(impactOf({})).toEqual([]);
    expect(ttlText(1, tr)).toBe("Auto");
    expect(ttlText(300, tr)).toBe("5 min");
  });
});
