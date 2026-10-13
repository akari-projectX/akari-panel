// 分流规则编辑器的纯逻辑（路由 PR 3，SET-11）：输入自动识别、条目名称、
// 冲突、"这个网站会走哪？"、效果一句话、客户端分组预览、校验。全部按
// 运营者正在编辑的 `sub::routing::Config` 与目录 `GET
// /settings/subscription/catalog` 计算，不造数据：内置分类没有完整列表
// （客户端自己下载），测试框只按分类名推测并写明；远程规则集按检查接口
// 返回的样例匹配。分组规则与 `src/sub/groups.rs` 一致。
import type { Tr } from "../../shared/i18n";
import type { LineRef, Routing, RoutingItem } from "../pages/settings-data";

export type ItemType =
  "category" | "geosite" | "geoip" | "domain" | "domain_suffix" | "domain_keyword" | "ip_cidr" | "rule_set";

export type Service = Routing["services"][number];

export type Counts = {
  total: number;
  domain: number;
  domain_suffix: number;
  domain_keyword: number;
  ip_cidr: number;
  unsupported: number;
  unsupported_types: Record<string, number>;
  invalid: number;
};

/** The panel's stored copy of a remote rule-set (`sub::rulesets::Status`). */
export type RuleSetStatus = {
  url: string;
  id: string;
  counts: Counts | null;
  kept: number | null;
  fetched_at: string | null;
  checked_at: string;
  last_error: string | null;
  failing_since: string | null;
};

/** `POST /settings/subscription/rule-set/check`. */
export type RuleSetCheck = {
  url: string;
  id: string;
  clash_format: "yaml" | "text";
  counts: Counts;
  kept: number;
  sample: { type: "domain" | "domain_suffix" | "domain_keyword" | "ip_cidr"; value: string }[];
  stored: RuleSetStatus | null;
};

export type CatalogEntrance = {
  id: string;
  name: string;
  node: string;
  region: string | null;
  tags: string[];
  enabled: boolean;
};

/** `GET /settings/subscription/catalog`. */
export type Catalog = {
  categories: { id: string; name: string; geosite: string[]; geoip: string[] }[];
  services: { key: string; name: string; emoji: string; categories: string[] }[];
  entrances: CatalogEntrance[];
  regions: string[];
  tags: string[];
  rule_sets: RuleSetStatus[];
};

// Limits (`sub::routing` / `sub::dns`).
export const MAX_ITEMS = 64;
export const MAX_SERVICES = 32;
export const MAX_BACKUPS = 8;
export const MAX_TAG_GROUPS = 16;
export const MAX_RULE_SETS = 32;
export const MAX_DNS = 8;
export const MAX_NAME = 32;

// The group names clients see (`sub::groups`), in every UI language.
export const DEFAULT_GROUP = "🚀 默认代理"; // i18n-ok: a subscription group name
export const ALL_GROUP = "♻️ 全部节点"; // i18n-ok: a subscription group name
export const regionGroup = (r: string) => `🌐 ${r}`;
export const tagGroup = (t: string) => `🏷 ${t}`;
export const recommendedGroup = (name: string) => `♻️ ${name} 推荐`; // i18n-ok: a subscription group name
export const serviceGroup = (s: Pick<Service, "emoji" | "name">) => (s.emoji ? `${s.emoji} ${s.name}` : s.name);

/** English names of the built-in categories (the catalog's names are Chinese). */
const CATEGORY_EN: Record<string, string> = {
  ads: "Ads and trackers",
  private: "LAN / router",
  cn: "Mainland China sites",
  cnip: "Mainland China IPs",
  ai: "AI services (ChatGPT / Claude / Gemini)",
};
/** The common services whose catalog name is Chinese: [zh, en]. */
const SERVICE_EN: Record<string, [string, string]> = { ai: ["AI 服务", "AI services"] };

/** Extra words the input recognises a category by (search aliases, both languages). */
const ALIASES: Record<string, string[]> = {
  ads: ["广告", "去广告", "跟踪", "ad", "ads", "tracker"], // i18n-ok: search aliases
  private: ["局域网", "内网", "路由器", "lan", "private", "local"], // i18n-ok: search aliases
  cn: ["国内", "大陆", "中国", "china", "cn"], // i18n-ok: search aliases
  cnip: ["国内ip", "大陆ip", "中国ip", "china ip", "geoip"], // i18n-ok: search aliases
  netflix: ["奈飞", "网飞", "nf"], // i18n-ok: search aliases
  google: ["谷歌"], // i18n-ok: search aliases
  youtube: ["油管", "yt"], // i18n-ok: search aliases
  telegram: ["电报", "tg"], // i18n-ok: search aliases
  ai: ["chatgpt", "openai", "claude", "gemini", "人工智能"], // i18n-ok: search aliases
  disney: ["迪士尼"], // i18n-ok: search aliases
  spotify: ["音乐", "music"], // i18n-ok: search aliases
  tiktok: ["抖音国际"], // i18n-ok: search aliases
  apple: ["苹果", "icloud"], // i18n-ok: search aliases
  microsoft: ["微软", "office", "outlook", "bing"], // i18n-ok: search aliases
  steam: ["游戏", "game"], // i18n-ok: search aliases
  github: ["git"],
  twitter: ["推特", "x"], // i18n-ok: search aliases
};

export function categoryName(c: { id: string; name: string } | undefined, id: string, tr: Tr): string {
  if (!c) return id;
  return tr(c.name, CATEGORY_EN[c.id] ?? c.name);
}

/** A service's name in the UI language (custom names stay as typed). */
export function serviceName(s: Pick<Service, "key" | "name">, tr: Tr): string {
  const t = SERVICE_EN[s.key];
  return t && t[0] === s.name ? tr(t[0], t[1]) : s.name;
}

// ---------------------------------------------------------------------------
// Input recognition
// ---------------------------------------------------------------------------

export type Suggestion = {
  /** Which list the option is shown under. */
  group: "detected" | "category" | "rule_set" | "keyword";
  label: string;
  hint: string;
  /** null = an explanation only (not selectable). */
  item: RoutingItem | null;
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOST = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,62}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,62}[a-z0-9_])?)+$/;
const LIST = /^[a-z0-9._!@-]{1,64}$/;

function ipv4(v: string): number | null {
  const m = IPV4.exec(v);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

/** A normalised CIDR (`1.2.3.4` → `1.2.3.4/32`) or null. */
export function cidr(v: string): string | null {
  const t = v.trim().toLowerCase();
  const [addr, bits, extra] = t.split("/");
  if (extra !== undefined) return null;
  if (ipv4(addr) !== null) {
    if (bits === undefined) return `${addr}/32`;
    return /^\d{1,2}$/.test(bits) && Number(bits) <= 32 ? `${addr}/${Number(bits)}` : null;
  }
  if (addr.includes(":") && /^[0-9a-f:.]+$/.test(addr) && (addr.match(/::/g) ?? []).length <= 1) {
    if (bits === undefined) return `${addr}/128`;
    return /^\d{1,3}$/.test(bits) && Number(bits) <= 128 ? `${addr}/${Number(bits)}` : null;
  }
  return null;
}

/** A remote rule-set link the panel accepts (`routing::rule_set_url`). */
export function ruleSetUrl(v: string): boolean {
  return (
    v.length <= 512 &&
    v.length > 11 &&
    (v.startsWith("https://") || v.startsWith("http://127.0.0.1:")) &&
    !/[\s"'\\#]/.test(v)
  );
}

/** The file name of a link ("…/Claude.yaml" → "Claude"). */
export function linkName(url: string): string {
  const path = url.split(/[?#]/)[0];
  let file = path.split("/").filter(Boolean).pop() ?? url;
  try {
    file = decodeURIComponent(file);
  } catch {
    /* keep it */
  }
  return file.replace(/\.(ya?ml|list|txt)$/i, "") || file;
}

/** A host from what was typed (a URL, `*.x`, a path). */
export function hostOf(raw: string): string {
  let t = raw.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(t)) {
    try {
      t = new URL(t).hostname;
    } catch {
      /* not a URL */
    }
  }
  t = t.replace(/\/.*$/, "").replace(/^\*\./, "").replace(/^\+\./, "").replace(/\.$/, "");
  if (!t.includes(":") || /^\[/.test(t)) t = t.replace(/^\[(.*)\](:\d+)?$/, "$1").replace(/:\d+$/, "");
  return t;
}

function domainOptions(host: string, tr: Tr): Suggestion[] {
  const d = host.replace(/^www\./, "");
  return [
    {
      group: "detected",
      label: tr(`${d} 及子域名`, `${d} and subdomains`),
      hint: tr("域名后缀", "domain suffix"),
      item: { type: "domain_suffix", value: d },
    },
    {
      group: "detected",
      label: tr(`仅 ${host}`, `${host} only`),
      hint: tr("精确域名", "exact domain"),
      item: { type: "domain", value: host },
    },
  ];
}

/** What one typed line can become (the input's suggestion list). */
export function suggest(raw: string, catalog: Catalog | undefined, tr: Tr): Suggestion[] {
  const t = raw.trim();
  if (!t) return [];
  const out: Suggestion[] = [];
  if (/^https?:\/\//i.test(t)) {
    // A link to a list is a rule-set; a page's address may mean its site.
    const list = /\.(ya?ml|list|txt)$/i.test(t.split(/[?#]/)[0]);
    const host = hostOf(t);
    if (!list && HOST.test(host) && ipv4(host) === null) out.push(...domainOptions(host, tr));
    out.push(
      ruleSetUrl(t)
        ? {
            group: "rule_set",
            label: tr(`导入规则集 ${linkName(t)}`, `Import the rule-set ${linkName(t)}`),
            hint: tr("下载并校验", "download and check"),
            item: { type: "rule_set", value: t },
          }
        : {
            group: "rule_set",
            label: /^http:/i.test(t)
              ? tr("规则集只支持 https 链接", "Rule-sets must be https links")
              : tr("链接里不能有空格、引号或 #", "No spaces, quotes or # in a link"),
            hint: "",
            item: null,
          },
    );
    return out;
  }
  const raw2 = /^(geosite|geoip):(.+)$/i.exec(t);
  if (raw2) {
    const name = raw2[2].trim().toLowerCase();
    if (LIST.test(name))
      out.push({
        group: "detected",
        label: `${raw2[1].toLowerCase()}:${name}`,
        hint: raw2[1].toLowerCase() === "geosite" ? tr("GeoSite 列表", "GeoSite list") : tr("GeoIP 列表", "GeoIP list"),
        item: { type: raw2[1].toLowerCase(), value: name },
      });
    return out;
  }
  const host = hostOf(t);
  const ip = cidr(t.replace(/\s+/g, ""));
  if (ip)
    out.push({
      group: "detected",
      label: tr(`IP 段 ${ip}`, `IP range ${ip}`),
      hint: "IP-CIDR",
      item: { type: "ip_cidr", value: ip },
    });
  else if (HOST.test(host) && ipv4(host) === null) out.push(...domainOptions(host, tr));
  const q = t.toLowerCase();
  if (catalog) {
    const hits = catalog.categories.filter((c) => {
      const words = [c.id, c.name.toLowerCase(), (CATEGORY_EN[c.id] ?? "").toLowerCase(), ...(ALIASES[c.id] ?? [])];
      const lists = [...c.geosite.map((g) => `geosite:${g}`), ...c.geoip.map((g) => `geoip:${g}`)];
      return words.some((w) => w && (w.includes(q) || (w.length > 1 && q === w))) || lists.some((l) => l.includes(q));
    });
    for (const c of hits.slice(0, 6))
      out.push({
        group: "category",
        label: categoryName(c, c.id, tr),
        hint: categoryRaw(c),
        item: { type: "category", value: c.id },
      });
  }
  if (!ip && !q.includes(".") && /^[a-z0-9-]{2,64}$/.test(q))
    out.push({
      group: "keyword",
      label: tr(`网址包含「${q}」`, `Address contains "${q}"`),
      hint: tr("关键词", "keyword"),
      item: { type: "domain_keyword", value: q },
    });
  // Shown grouped: what it was detected as first, then the categories.
  const order = { detected: 0, rule_set: 1, category: 2, keyword: 3 };
  return out.sort((a, b) => order[a.group] - order[b.group]);
}

export function categoryRaw(c: { geosite: string[]; geoip: string[] }): string {
  return [...c.geosite.map((g) => `geosite:${g}`), ...c.geoip.map((g) => `geoip:${g}`)].join(" + ");
}

// ---------------------------------------------------------------------------
// Items: names, keys, kinds
// ---------------------------------------------------------------------------

export const itemKey = (it: RoutingItem) => `${it.type}:${it.value}`;

/** The domain kinds a domain item cycles through (后缀 → 精确 → 关键词). */
export const DOMAIN_CYCLE: Record<string, ItemType> = {
  domain_suffix: "domain",
  domain: "domain_keyword",
  domain_keyword: "domain_suffix",
};

export function kindName(type: string, tr: Tr): string {
  return (
    (
      {
        category: tr("分类", "Category"),
        geosite: "GeoSite",
        geoip: "GeoIP",
        domain: tr("精确域名", "Exact domain"),
        domain_suffix: tr("域名后缀", "Domain suffix"),
        domain_keyword: tr("关键词", "Keyword"),
        ip_cidr: tr("IP 段", "IP range"),
        rule_set: tr("远程规则集", "Remote rule-set"),
      } as Record<string, string>
    )[type] ?? type
  );
}

/** What an item reads as (name) and its raw form (the rule clients get). */
export function itemLabel(it: RoutingItem, catalog: Catalog | undefined, tr: Tr): { name: string; raw: string } {
  switch (it.type) {
    case "category": {
      const c = catalog?.categories.find((x) => x.id === it.value);
      return { name: categoryName(c, it.value, tr), raw: c ? categoryRaw(c) : it.value };
    }
    case "geosite":
    case "geoip":
      return { name: `${it.type}:${it.value}`, raw: it.type === "geosite" ? "GEOSITE" : "GEOIP" };
    case "domain":
      return { name: tr(`仅 ${it.value}`, `${it.value} only`), raw: "DOMAIN" };
    case "domain_suffix":
      return { name: tr(`${it.value} 及子域名`, `${it.value} and subdomains`), raw: "DOMAIN-SUFFIX" };
    case "domain_keyword":
      return { name: tr(`网址包含「${it.value}」`, `Address contains "${it.value}"`), raw: "DOMAIN-KEYWORD" };
    case "ip_cidr":
      return { name: it.value, raw: "IP-CIDR" };
    case "rule_set":
      return { name: linkName(it.value), raw: it.value };
    default:
      return { name: it.value, raw: it.type };
  }
}

/** A section of the routing, in priority order. */
export type SectionRef = { kind: "block" } | { kind: "direct" } | { kind: "service"; index: number };

export function sectionItems(r: Routing, s: SectionRef): RoutingItem[] {
  if (s.kind === "block") return r.block;
  if (s.kind === "direct") return r.direct;
  return r.services[s.index]?.items ?? [];
}

export function withItems(r: Routing, s: SectionRef, items: RoutingItem[]): Routing {
  if (s.kind === "block") return { ...r, block: items };
  if (s.kind === "direct") return { ...r, direct: items };
  return { ...r, services: r.services.map((x, i) => (i === s.index ? { ...x, items } : x)) };
}

export function sectionsOf(r: Routing): SectionRef[] {
  return [
    { kind: "block" },
    { kind: "direct" },
    ...r.services.map((_, index) => ({ kind: "service" as const, index })),
  ];
}

export function sectionTitle(r: Routing, s: SectionRef, tr: Tr): string {
  if (s.kind === "block") return tr("拦截", "Blocked");
  if (s.kind === "direct") return tr("直连", "Direct");
  const v = r.services[s.index];
  return v ? serviceName(v, tr) : "";
}

/**
 * Items that appear in an earlier section too: the later copy never
 * matches (clients stop at the first rule). Key = section index + item key
 * → the earlier section's title.
 */
export function conflicts(r: Routing, tr: Tr): Map<string, string> {
  const seen = new Map<string, string>();
  const dup = new Map<string, string>();
  sectionsOf(r).forEach((s, si) => {
    for (const it of sectionItems(r, s)) {
      const k = itemKey(it);
      const first = seen.get(k);
      if (first !== undefined) dup.set(`${si}|${k}`, first);
      else seen.set(k, sectionTitle(r, s, tr));
    }
  });
  return dup;
}

/** Every distinct remote rule-set link (`Config::rule_set_urls`). */
export function ruleSetLinks(r: Routing): string[] {
  const out: string[] = [];
  for (const s of sectionsOf(r))
    for (const it of sectionItems(r, s)) if (it.type === "rule_set" && !out.includes(it.value)) out.push(it.value);
  return out;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export function refKey(r: LineRef | null): string {
  if (!r) return "all";
  if ("entrance" in r) return `e:${r.entrance}`;
  if ("region" in r) return `r:${r.region}`;
  return `t:${r.tag}`;
}

export function refOf(key: string): LineRef | null {
  const [k, ...rest] = key.split(":");
  const v = rest.join(":");
  if (k === "e") return { entrance: v };
  if (k === "r") return { region: v };
  if (k === "t") return { tag: v };
  return null;
}

export function entranceName(e: CatalogEntrance): string {
  return e.node === e.name ? e.name : `${e.node} · ${e.name}`;
}

/** A line reference as the operator reads it (missing = the entrance was deleted). */
export function refName(r: LineRef | null, catalog: Catalog | undefined, tr: Tr): { name: string; missing: boolean } {
  if (!r) return { name: tr("全部节点（自动选最快）", "All lines (fastest)"), missing: false };
  if ("entrance" in r) {
    const e = catalog?.entrances.find((x) => x.id === r.entrance);
    if (!e) return { name: tr("已删除的线路", "Deleted line"), missing: !!catalog };
    return { name: entranceName(e), missing: false };
  }
  if ("region" in r) return { name: regionGroup(r.region), missing: false };
  return { name: tagGroup(r.tag), missing: false };
}

/** A service's failover chain: the primary, then the backups. */
export function chainOf(s: Service): LineRef[] {
  return [...(s.primary ? [{ entrance: s.primary }] : []), ...s.backups];
}

/** The entrance ids the routing names that the catalog does not have. */
export function missingEntrances(r: Routing, catalog: Catalog | undefined): Set<string> {
  const out = new Set<string>();
  if (!catalog) return out;
  const has = (id: string) => catalog.entrances.some((e) => e.id === id);
  for (const s of r.services) for (const x of chainOf(s)) if ("entrance" in x && !has(x.entrance)) out.add(x.entrance);
  if (r.rest && "entrance" in r.rest && !has(r.rest.entrance)) out.add(r.rest.entrance);
  return out;
}

// ---------------------------------------------------------------------------
// "Where does this site go?"
// ---------------------------------------------------------------------------

function ipIn(ip: string, range: string): boolean {
  const [base, bitsRaw] = range.split("/");
  const a = ipv4(ip);
  const b = ipv4(base);
  if (a === null || b === null) {
    if (!ip.includes(":") || !base.includes(":")) return false;
    // IPv6: compare the prefix by hextets (enough for a test box).
    const exp = (v: string) => {
      const [h, t] = v.split("::");
      const hs = h ? h.split(":") : [];
      const ts = t !== undefined && t ? t.split(":") : [];
      const fill = t !== undefined ? Array(8 - hs.length - ts.length).fill("0") : [];
      return [...hs, ...fill, ...ts].map((x) => parseInt(x || "0", 16));
    };
    const x = exp(ip);
    const y = exp(base);
    let bits = Number(bitsRaw ?? 128);
    for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
      const m = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
      if ((x[i] & m) !== (y[i] & m)) return false;
    }
    return true;
  }
  const bits = Number(bitsRaw ?? 32);
  const m = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & m) >>> 0 === (b & m) >>> 0;
}

/** RFC 1918 / loopback / link-local / ULA: what `private` covers for certain. */
const PRIVATE = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

function isPrivate(host: string, ip: boolean): boolean {
  if (ip) return PRIVATE.some((r) => ipIn(host, r));
  return host === "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".localhost");
}

export type Hit = {
  /** What decided it, for "why". */
  why: string;
  /** Inferred from a category's name, not its list (the client's list decides). */
  guess?: boolean;
  /** Matched against the check's sample only. */
  sample?: boolean;
};

function matchItem(
  it: RoutingItem,
  host: string,
  ip: boolean,
  catalog: Catalog | undefined,
  checks: Record<string, RuleSetCheck | undefined>,
  tr: Tr,
): Hit | null {
  const labels = host.split(".");
  const suffix = (v: string) => host === v || host.endsWith(`.${v}`);
  switch (it.type) {
    case "domain":
      return !ip && host === it.value ? { why: tr(`域名 ${it.value}`, `the domain ${it.value}`) } : null;
    case "domain_suffix":
      return !ip && suffix(it.value) ? { why: tr(`${it.value} 及子域名`, `${it.value} and its subdomains`) } : null;
    case "domain_keyword":
      return !ip && host.includes(it.value) ? { why: tr(`包含「${it.value}」`, `contains "${it.value}"`) } : null;
    case "ip_cidr":
      return ip && ipIn(host, it.value) ? { why: tr(`IP 段 ${it.value}`, `the range ${it.value}`) } : null;
    case "rule_set": {
      const c = checks[it.value];
      if (!c) return null;
      const name = linkName(it.value);
      for (const r of c.sample) {
        const hit =
          r.type === "ip_cidr"
            ? ip && ipIn(host, r.value)
            : !ip &&
              (r.type === "domain"
                ? host === r.value
                : r.type === "domain_suffix"
                  ? r.value.startsWith(".")
                    ? host.endsWith(r.value)
                    : suffix(r.value)
                  : host.includes(r.value));
        if (hit)
          return {
            why: tr(`规则集「${name}」的 ${r.value}`, `${r.value} in the rule-set "${name}"`),
            sample: c.sample.length < c.kept,
          };
      }
      return null;
    }
    case "category":
    case "geosite":
    case "geoip": {
      const c =
        it.type === "category"
          ? catalog?.categories.find((x) => x.id === it.value)
          : {
              id: "",
              name: it.value,
              geosite: it.type === "geosite" ? [it.value] : [],
              geoip: it.type === "geoip" ? [it.value] : [],
            };
      if (!c) return null;
      const label = it.type === "category" ? categoryName(c, it.value, tr) : `${it.type}:${it.value}`;
      // Certain: the private lists cover the private ranges and local names.
      if ((c.geosite.includes("private") || c.geoip.includes("private")) && isPrivate(host, ip))
        return { why: tr(`分类「${label}」`, `the category "${label}"`) };
      // A guess by the list's name: "netflix" in netflix.com, ".cn" for cn.
      if (!ip && c.geosite.some((g) => /^[a-z0-9-]+$/.test(g) && !g.startsWith("category-") && labels.includes(g)))
        return { why: tr(`分类「${label}」`, `the category "${label}"`), guess: true };
      return null;
    }
    default:
      return null;
  }
}

export type Verdict =
  | { to: "block"; hit: Hit; section: string }
  | { to: "direct"; hit: Hit | null; section: string }
  | { to: "service"; hit: Hit; service: Service; chain: LineRef[]; fallback: boolean }
  | { to: "default"; hit: null; chain: (LineRef | null)[]; global: boolean };

/** Where a typed address goes with this routing (first match wins, like the client). */
export function resolve(
  query: string,
  r: Routing,
  catalog: Catalog | undefined,
  checks: Record<string, RuleSetCheck | undefined>,
  tr: Tr,
): Verdict | null {
  const host = hostOf(query);
  if (!host) return null;
  const ip = ipv4(host) !== null || (host.includes(":") && /^[0-9a-f:.]+$/.test(host));
  if (r.mode === "global") {
    if (isPrivate(host, ip))
      return {
        to: "direct",
        hit: { why: tr("全局代理：局域网直连", "Global proxy: the LAN goes direct") },
        section: "",
      };
    return { to: "default", hit: null, chain: [r.rest], global: true };
  }
  for (const s of sectionsOf(r)) {
    for (const it of sectionItems(r, s)) {
      const hit = matchItem(it, host, ip, catalog, checks, tr);
      if (!hit) continue;
      if (s.kind === "block") return { to: "block", hit, section: tr("拦截", "Blocked") };
      if (s.kind === "direct") return { to: "direct", hit, section: tr("直连", "Direct") };
      const svc = r.services[s.index];
      const chain = chainOf(svc);
      return { to: "service", hit, service: svc, chain, fallback: chain.length === 0 };
    }
  }
  return { to: "default", hit: null, chain: [r.rest], global: false };
}

// ---------------------------------------------------------------------------
// One sentence
// ---------------------------------------------------------------------------

/** The routing in one sentence (parts; the UI bolds the names). */
export function summary(r: Routing, catalog: Catalog | undefined, tr: Tr, lang: "zh" | "en"): string[] {
  const sep = lang === "en" ? ", " : "、";
  const list = (items: RoutingItem[]) => items.map((i) => itemLabel(i, catalog, tr).name).join(sep);
  const rest = refName(r.rest, catalog, tr).name;
  const fake = !(r.dns.mode === "custom" && !r.dns.fakeip);
  const dns =
    r.dns.mode === "client"
      ? tr("DNS 用客户端自己的设置", "DNS is left to the client")
      : fake
        ? tr(
            "DNS：国内网站与线路地址用国内 DNS，其余经代理用国外 DNS（Fake-IP）",
            "DNS: domestic sites and the lines' addresses via domestic DNS, the rest via foreign DNS through the proxy (Fake-IP)",
          )
        : tr(
            "DNS：国内网站与线路地址用国内 DNS，其余经代理用国外 DNS",
            "DNS: domestic sites and the lines' addresses via domestic DNS, the rest via foreign DNS through the proxy",
          );
  if (r.mode === "global")
    return [
      tr(`全局代理：局域网直连，其余全部走 ${rest}`, `Global proxy: the LAN goes direct, everything else via ${rest}`),
      dns,
    ];
  const parts: string[] = [];
  if (r.block.length) parts.push(tr(`拦截 ${list(r.block)}`, `block ${list(r.block)}`));
  if (r.direct.length) parts.push(tr(`${list(r.direct)} 直连`, `${list(r.direct)} direct`));
  for (const s of r.services) {
    const chain = chainOf(s);
    const name = serviceName(s, tr);
    if (!chain.length) parts.push(tr(`${name} 走默认代理`, `${name} via the default proxy`));
    else {
      const first = refName(chain[0], catalog, tr).name;
      parts.push(
        chain.length > 1
          ? tr(`${name} 走 ${first}（备用 ${chain.length - 1}）`, `${name} via ${first} (${chain.length - 1} backup)`)
          : tr(`${name} 走 ${first}`, `${name} via ${first}`),
      );
    }
  }
  parts.push(tr(`其余走 ${rest}`, `the rest via ${rest}`));
  parts.push(dns);
  return parts;
}

// ---------------------------------------------------------------------------
// The client's groups (`sub::groups::plan`, for a user granted every enabled line)
// ---------------------------------------------------------------------------

export type PreviewGroup = {
  name: string;
  kind: "select" | "url-test";
  /** The preselected member (select groups). */
  current?: string;
  members: string[];
  /** Lines folded into "+N 条线路". */
  lines?: number;
  /** The hidden fallback group's chain. */
  failover?: string[];
};

export function clientGroups(r: Routing, catalog: Catalog | undefined, tr: Tr): PreviewGroup[] {
  const lines = (catalog?.entrances ?? []).filter((e) => e.enabled);
  const regions: string[] = [];
  for (const e of lines) {
    const reg = e.region?.trim();
    if (reg && !regions.includes(reg)) regions.push(reg);
  }
  const tagKeys = [...r.tag_groups];
  for (const x of [...r.services.flatMap((s) => s.backups), ...(r.rest ? [r.rest] : [])])
    if ("tag" in x && !tagKeys.includes(x.tag)) tagKeys.push(x.tag);
  const tags = tagKeys.filter((t) => lines.some((e) => e.tags.includes(t)));
  const name = (x: LineRef): string | null => {
    if ("entrance" in x) {
      const e = lines.find((l) => l.id === x.entrance);
      return e ? entranceName(e) : null;
    }
    if ("region" in x) return regions.includes(x.region) ? regionGroup(x.region) : null;
    return tags.includes(x.tag) ? tagGroup(x.tag) : null;
  };
  const regionNames = regions.map(regionGroup);
  const tagNames = tags.map(tagGroup);
  const uniq = (v: string[]) => v.filter((x, i) => v.indexOf(x) === i);
  const restName = (r.rest && name(r.rest)) || ALL_GROUP;
  const out: PreviewGroup[] = [
    {
      name: DEFAULT_GROUP,
      kind: "select",
      current: restName,
      members: uniq([restName, ...regionNames, ...tagNames, ALL_GROUP]),
      lines: lines.length,
    },
  ];
  if (r.mode === "rules")
    for (const s of r.services) {
      const chain = uniq(
        chainOf(s)
          .map(name)
          .filter((x): x is string => !!x),
      );
      const direct = tr("直连", "DIRECT");
      if (chain.length) {
        const rec = recommendedGroup(s.name);
        out.push({
          name: serviceGroup(s),
          kind: "select",
          current: rec,
          members: uniq([rec, ...chain, ...regionNames, ALL_GROUP, direct]),
          failover: chain,
        });
      } else
        out.push({
          name: serviceGroup(s),
          kind: "select",
          current: DEFAULT_GROUP,
          members: uniq([DEFAULT_GROUP, ...regionNames, ALL_GROUP, direct]),
        });
    }
  for (const reg of regions)
    out.push({
      name: regionGroup(reg),
      kind: "url-test",
      members: lines.filter((e) => e.region?.trim() === reg).map(entranceName),
    });
  for (const t of tags)
    out.push({
      name: tagGroup(t),
      kind: "url-test",
      members: lines.filter((e) => e.tags.includes(t)).map(entranceName),
    });
  out.push({ name: ALL_GROUP, kind: "url-test", members: [], lines: lines.length });
  return out;
}

// ---------------------------------------------------------------------------
// Validation (the server's rules, so the save bar can say "N 处需要修正")
// ---------------------------------------------------------------------------

/** A DNS server (`sub::dns::server`): an IP, or udp://IP, tls://host, https://host[/path]. */
export function dnsServerOk(v: string): boolean {
  const t = v.trim();
  if (!t || t.length > 256 || /[\s"'\\,]/.test(t)) return false;
  if (ipv4(t) !== null || (t.includes(":") && !t.includes("/") && /^[0-9a-f:.]+$/i.test(t))) return true;
  const m = /^(udp|tls|https):\/\/([^/]+)(\/.*)?$/i.exec(t);
  if (!m) return false;
  const scheme = m[1].toLowerCase();
  const path = m[3] ?? "";
  if (path && (scheme !== "https" || !/^[A-Za-z0-9/._~-]+$/.test(path))) return false;
  let host = m[2];
  let port: string | undefined;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(host);
  if (v6) {
    host = v6[1];
    port = v6[2];
  } else if (host.includes(":")) {
    const i = host.lastIndexOf(":");
    port = host.slice(i + 1);
    host = host.slice(0, i);
    if (!/^\d+$/.test(port)) return false;
  }
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return false;
  const isIp = ipv4(host) !== null || !!v6;
  if (!isIp && (scheme === "udp" || !HOST.test(host.toLowerCase()))) return false;
  return true;
}

/** A service name (`printable_name`): 1–32 characters, no commas or quotes, no edge spaces. */
export function serviceNameError(name: string, others: string[], tr: Tr): string | undefined {
  const n = [...name].length;
  if (!name.trim()) return tr("请填写名称", "Enter a name");
  if (n > MAX_NAME) return tr(`最多 ${MAX_NAME} 个字`, `At most ${MAX_NAME} characters`);
  if (/[,"\\]/.test(name)) return tr("不能包含逗号或引号", "No commas or quotes");
  if (others.includes(name.trim())) return tr("已有同名的服务", "A service already has this name");
  return undefined;
}

/** A rule list URL template (`routing::url_template`): https with {name}. */
export function templateError(raw: string, tr: Tr): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (!v.includes("{name}"))
    return tr("地址里需要包含 {name}，可含 {kind}", "The address needs {name} (and may have {kind})");
  if (!(v.startsWith("https://") || v.startsWith("http://127.0.0.1")) || /[\s"']/.test(v) || v.length > 512)
    return tr("请输入以 https:// 开头的完整地址", "Enter a full address starting with https://");
  return undefined;
}
