// The routing editor's logic: input recognition, conflicts, the test box,
// the one sentence and the client groups (sub::groups' rules).
import { expect, test } from "vitest";
import type { Routing } from "../pages/settings-data";
import {
  cidr,
  clientGroups,
  conflicts,
  dnsServerOk,
  hostOf,
  missingEntrances,
  resolve,
  ruleSetLinks,
  suggest,
  summary,
  templateError,
  type Catalog,
  type RuleSetCheck,
} from "./routing-model";

const tr = (zh: string) => zh;

const CAT: Catalog = {
  categories: [
    { id: "ads", name: "广告与跟踪", geosite: ["category-ads-all"], geoip: [] },
    { id: "private", name: "局域网 / 路由器", geosite: ["private"], geoip: ["private"] },
    { id: "cn", name: "中国大陆网站", geosite: ["cn"], geoip: [] },
    { id: "netflix", name: "Netflix", geosite: ["netflix"], geoip: [] },
  ],
  services: [{ key: "netflix", name: "Netflix", emoji: "🎬", categories: ["netflix"] }],
  entrances: [
    { id: "e1", name: "直连", node: "东京 01", region: "JP", tags: ["解锁"], enabled: true },
    { id: "e2", name: "IPLC", node: "香港 01", region: "HK", tags: [], enabled: true },
    { id: "e3", name: "直连", node: "首尔", region: "KR", tags: [], enabled: false },
  ],
  regions: ["JP", "HK", "KR"],
  tags: ["解锁"],
  rule_sets: [],
};

function routing(p: Partial<Routing> = {}): Routing {
  return {
    mode: "rules",
    block: [{ type: "category", value: "ads" }],
    direct: [
      { type: "category", value: "private" },
      { type: "category", value: "cn" },
    ],
    services: [
      {
        key: "netflix",
        name: "Netflix",
        emoji: "🎬",
        items: [{ type: "category", value: "netflix" }],
        primary: "e1",
        backups: [{ region: "HK" }],
      },
    ],
    rest: null,
    tag_groups: [],
    dns: { mode: "recommended", fakeip: true, cn: [], intl: [] },
    ...p,
  };
}

test("input recognition", () => {
  const types = (s: string) => suggest(s, CAT, tr).map((o) => o.item && `${o.item.type}:${o.item.value}`);
  expect(types("https://www.Example.com/path")).toEqual([
    "domain_suffix:example.com",
    "domain:www.example.com",
    "rule_set:https://www.Example.com/path",
  ]);
  expect(types("www.example.com")).toEqual(["domain_suffix:example.com", "domain:www.example.com"]);
  expect(types("1.2.3.0/24")).toEqual(["ip_cidr:1.2.3.0/24"]);
  expect(types("8.8.8.8")).toEqual(["ip_cidr:8.8.8.8/32"]);
  expect(types("奈飞")).toEqual(["category:netflix"]);
  expect(types("netflix")).toEqual(["category:netflix", "domain_keyword:netflix"]);
  expect(types("geosite:Netflix")).toEqual(["geosite:netflix"]);
  expect(types("https://x.example/Claude.yaml")).toEqual(["rule_set:https://x.example/Claude.yaml"]);
  expect(suggest("http://x.example/a.list", CAT, tr)[0].item).toBeNull();
  expect(cidr("300.1.1.1")).toBeNull();
  expect(cidr("2001:db8::/32")).toBe("2001:db8::/32");
  expect(hostOf("https://WWW.Netflix.com:443/title/1")).toBe("www.netflix.com");
});

test("conflicts: a later copy never matches", () => {
  const r = routing({ direct: [{ type: "category", value: "ads" }] });
  const d = conflicts(r, tr);
  expect([...d.entries()]).toEqual([["1|category:ads", "拦截"]]);
});

test("the test box: first match wins; categories by name only; rule-set samples", () => {
  const r = routing({
    direct: [
      { type: "category", value: "private" },
      { type: "domain_suffix", value: "example.org" },
    ],
  });
  expect(resolve("192.168.1.1", r, CAT, {}, tr)).toMatchObject({ to: "direct" });
  expect(resolve("www.example.org", r, CAT, {}, tr)).toMatchObject({
    to: "direct",
    hit: { why: "example.org 及子域名" },
  });
  const nf = resolve("www.netflix.com", r, CAT, {}, tr);
  expect(nf).toMatchObject({ to: "service", hit: { guess: true } });
  expect(nf?.to === "service" && nf.chain).toEqual([{ entrance: "e1" }, { region: "HK" }]);
  // Ads have no recognisable name: nothing is guessed.
  expect(resolve("doubleclick.net", r, CAT, {}, tr)).toMatchObject({ to: "default" });
  const url = "https://x.example/ai.yaml";
  const check: RuleSetCheck = {
    url,
    id: "x",
    clash_format: "yaml",
    counts: {
      total: 3,
      domain: 0,
      domain_suffix: 1,
      domain_keyword: 0,
      ip_cidr: 1,
      unsupported: 1,
      unsupported_types: { "PROCESS-NAME": 1 },
      invalid: 0,
    },
    kept: 2,
    sample: [
      { type: "domain_suffix", value: "claude.ai" },
      { type: "ip_cidr", value: "160.79.104.0/23" },
    ],
    stored: null,
  };
  const withSet = routing({ block: [{ type: "rule_set", value: url }] });
  expect(resolve("claude.ai", withSet, CAT, {}, tr)).toMatchObject({ to: "default" });
  expect(resolve("api.claude.ai", withSet, CAT, { [url]: check }, tr)).toMatchObject({ to: "block" });
  expect(resolve("160.79.105.9", withSet, CAT, { [url]: check }, tr)).toMatchObject({ to: "block" });
  // Global: the LAN direct, the rest via the default proxy.
  const g = routing({ mode: "global", rest: { region: "JP" } });
  expect(resolve("10.1.2.3", g, CAT, {}, tr)).toMatchObject({ to: "direct" });
  expect(resolve("www.netflix.com", g, CAT, {}, tr)).toMatchObject({ to: "default", chain: [{ region: "JP" }] });
});

test("one sentence", () => {
  const s = summary(routing(), CAT, tr, "zh").join("；");
  expect(s).toBe(
    "拦截 广告与跟踪；局域网 / 路由器、中国大陆网站 直连；Netflix 走 东京 01 · 直连（备用 1）；其余走 全部节点（自动选最快）；DNS：国内网站与线路地址用国内 DNS，其余经代理用国外 DNS（Fake-IP）",
  );
  expect(
    summary(routing({ mode: "global", dns: { mode: "client", fakeip: true, cn: [], intl: [] } }), CAT, tr, "zh"),
  ).toEqual(["全局代理：局域网直连，其余全部走 全部节点（自动选最快）", "DNS 用客户端自己的设置"]);
});

test("client groups follow sub::groups", () => {
  const g = clientGroups(routing({ tag_groups: ["解锁"], rest: { tag: "解锁" } }), CAT, tr);
  expect(g.map((x) => x.name)).toEqual(["🚀 默认代理", "🎬 Netflix", "🌐 JP", "🌐 HK", "🏷 解锁", "♻️ 全部节点"]);
  expect(g[0]).toMatchObject({ current: "🏷 解锁", members: ["🏷 解锁", "🌐 JP", "🌐 HK", "♻️ 全部节点"], lines: 2 });
  expect(g[1]).toMatchObject({
    current: "♻️ Netflix 推荐",
    failover: ["东京 01 · 直连", "🌐 HK"],
    members: ["♻️ Netflix 推荐", "东京 01 · 直连", "🌐 HK", "🌐 JP", "♻️ 全部节点", "直连"],
  });
  // A chain with nothing usable points at the default proxy.
  const none = clientGroups(
    routing({ services: [{ ...routing().services[0], primary: "e3", backups: [{ region: "KR" }] }] }),
    CAT,
    tr,
  );
  expect(none[1]).toMatchObject({ current: "🚀 默认代理" });
  // Global mode: no service groups.
  expect(clientGroups(routing({ mode: "global" }), CAT, tr).map((x) => x.name)).not.toContain("🎬 Netflix");
});

test("validation", () => {
  expect(missingEntrances(routing({ rest: { entrance: "gone" } }), CAT)).toEqual(new Set(["gone"]));
  expect(
    ruleSetLinks(
      routing({
        block: [{ type: "rule_set", value: "https://a/x" }],
        direct: [{ type: "rule_set", value: "https://a/x" }],
      }),
    ),
  ).toEqual(["https://a/x"]);
  for (const ok of [
    "223.5.5.5",
    "udp://1.1.1.1:53",
    "tls://dns.google",
    "https://doh.pub/dns-query",
    "https://[2606:4700::1111]/dns-query",
    "2400:3200::1",
  ])
    expect(dnsServerOk(ok), ok).toBe(true);
  for (const bad of ["udp://dns.google", "ftp://x", "https://a b", "tls://1.1.1.1/x", ""])
    expect(dnsServerOk(bad), bad).toBe(false);
  expect(templateError("https://m.example/{kind}/{name}.list", tr)).toBeUndefined();
  expect(templateError("https://m.example/x.list", tr)).toBeDefined();
  expect(templateError("", tr)).toBeUndefined();
});
