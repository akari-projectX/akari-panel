// DNS management (pure parts): the shapes of the /dns API, the record form
// draft and its request body, validation, and small helpers. The server
// validates everything again (src/dns/records.rs); this only keeps the form
// honest before a request is sent.
import type { Tr } from "../shared/i18n";

export const TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA", "NS"] as const;
export type RType = (typeof TYPES)[number];
/** Types Cloudflare can proxy (orange cloud). */
export const PROXIABLE: readonly string[] = ["A", "AAAA", "CNAME"];
export const TTL_AUTO = 1;
export const TTLS = [1, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 43200, 86400];
const COMMENT_MAX = 100;
/** Records per page (Cloudflare pages; the backend allows 5-100). */
export const PER_PAGE = 50;

export type DnsAccount = {
  id: string;
  name: string;
  token_set: boolean;
  fingerprint: string;
  version: number;
  created_at: string;
  updated_at: string;
};
export type DnsZone = {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  account_id: string;
  account_name: string;
  can_edit: boolean | null;
};
export type DnsFailure = { code: string; message: string; params: Record<string, unknown> };
export type ZoneError = DnsFailure & { account_id: string; account_name: string };
export type Use = { kind: string; label: string };
export type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean | null;
  proxiable: boolean | null;
  ttl: number;
  comment: string | null;
  priority: number | null;
  data: Record<string, unknown> | null;
  zone_name: string | null;
  modified_on: string | null;
  uses: Use[];
};
export type PageInfo = { page: number; per_page: number; total_count: number; total_pages: number };
type BatchResult = { id: string; name: string | null; ok: boolean } & Partial<DnsFailure>;
export type BatchAnswer = { ok: number; failed: number; results: BatchResult[] };
export type TestAnswer =
  | { ok: true; zones: number; editable: number; read_only: number; unknown: number; sample: string[] }
  | ({ ok: false } & DnsFailure);

export const zoneKey = (accountId: string, zoneId: string) => `${accountId}:${zoneId}`;
export function parseZoneKey(key: string | null): { account: string; zone: string } | null {
  const m = /^([0-9a-f-]{36}):([0-9a-f]{32})$/.exec(key ?? "");
  return m ? { account: m[1], zone: m[2] } : null;
}
export const recordsPath = (account: string, zone: string) => `/dns/accounts/${account}/zones/${zone}/records`;

export function isIPv4(s: string): boolean {
  const p = s.split(".");
  return p.length === 4 && p.every((x) => /^(0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255);
}
export function isIPv6(s: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(":")) return false;
  try {
    return new URL(`http://[${s}]/`).hostname !== "";
  } catch {
    return false;
  }
}

type Srv = {
  service: string;
  proto: string;
  name: string;
  priority: string;
  weight: string;
  port: string;
  target: string;
};
type Caa = { flags: string; tag: string; value: string };
export type Draft = {
  type: RType;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  comment: string;
  priority: string;
  srv: Srv;
  caa: Caa;
};

const text = (v: unknown, d = "") => (typeof v === "string" || typeof v === "number" ? String(v) : d);

/** `_sip._tcp.example.com` → service `_sip`, proto `_tcp`, name `example.com`. */
function srvFromName(name: string): Pick<Srv, "service" | "proto" | "name"> {
  const [service = "", proto = "", ...rest] = name.split(".");
  return { service, proto, name: rest.join(".") };
}

export function draftOf(r?: DnsRecord, zone?: string): Draft {
  const type = (TYPES as readonly string[]).includes(r?.type ?? "") ? (r?.type as RType) : "A";
  const d = r?.data ?? {};
  const fromName = srvFromName(r?.name ?? "");
  return {
    type,
    name: r?.name ?? "",
    content: type === "SRV" || type === "CAA" ? "" : (r?.content ?? ""),
    ttl: r?.ttl ?? TTL_AUTO,
    proxied: r?.proxied ?? false,
    comment: r?.comment ?? "",
    priority: text(r?.priority, "10"),
    srv: {
      service: text(d.service, fromName.service),
      proto: text(d.proto, fromName.proto),
      name: text(d.name, fromName.name || zone || ""),
      priority: text(d.priority, "10"),
      weight: text(d.weight, "5"),
      port: text(d.port),
      target: text(d.target),
    },
    caa: { flags: text(d.flags, "0"), tag: text(d.tag, "issue"), value: text(d.value) },
  };
}

const int = (s: string) => (/^\d{1,5}$/.test(s.trim()) ? Number(s.trim()) : NaN);

export type DraftErrors = Partial<
  Record<"name" | "content" | "comment" | "priority" | "port" | "target" | "value", string>
>;

export function draftErrors(d: Draft, tr: Tr): DraftErrors {
  const e: DraftErrors = {};
  const name = d.name.trim();
  if (!name || name.length > 255 || /\s/.test(name)) e.name = tr("填写名称（不含空格）", "Enter a name (no spaces)");
  if (d.comment.length > COMMENT_MAX) e.comment = tr(`最多 ${COMMENT_MAX} 个字符`, `At most ${COMMENT_MAX} characters`);
  const c = d.content.trim();
  switch (d.type) {
    case "A":
      if (!isIPv4(c)) e.content = tr("请输入 IPv4 地址", "Enter an IPv4 address");
      break;
    case "AAAA":
      if (!isIPv6(c)) e.content = tr("请输入 IPv6 地址", "Enter an IPv6 address");
      break;
    case "SRV": {
      if (!(int(d.srv.port) >= 0 && int(d.srv.port) <= 65535)) e.port = tr("端口 0-65535", "Port 0-65535");
      if (!d.srv.target.trim()) e.target = tr("填写目标主机", "Enter the target host");
      for (const k of ["priority", "weight"] as const)
        if (!(int(d.srv[k]) >= 0 && int(d.srv[k]) <= 65535))
          e.priority = tr("优先级与权重 0-65535", "Priority and weight 0-65535");
      break;
    }
    case "CAA":
      if (!d.caa.value.trim() || !d.caa.tag.trim()) e.value = tr("填写标记与值", "Enter the tag and the value");
      break;
    default:
      if (!c || c.length > 2048)
        e.content = tr("填写内容（最多 2048 个字符）", "Enter the content (at most 2048 characters)");
  }
  if (d.type === "MX" && !(int(d.priority) >= 0 && int(d.priority) <= 65535))
    e.priority = tr("优先级 0-65535", "Priority 0-65535");
  return e;
}

/** The request body of create / update. */
export function bodyOf(d: Draft, confirm = false): Record<string, unknown> {
  const proxied = PROXIABLE.includes(d.type) && d.proxied;
  const body: Record<string, unknown> = {
    type: d.type,
    name: d.name.trim(),
    ttl: proxied ? TTL_AUTO : d.ttl,
    comment: d.comment.trim(),
    confirm,
  };
  if (PROXIABLE.includes(d.type)) body.proxied = proxied;
  if (d.type === "SRV") {
    const s = d.srv;
    body.data = {
      service: s.service.trim(),
      proto: s.proto.trim(),
      name: s.name.trim(),
      priority: int(s.priority),
      weight: int(s.weight),
      port: int(s.port),
      target: s.target.trim(),
    };
  } else if (d.type === "CAA") {
    body.data = { flags: int(d.caa.flags) || 0, tag: d.caa.tag.trim(), value: d.caa.value.trim() };
  } else {
    body.content = d.content.trim();
    if (d.type === "MX") body.priority = int(d.priority);
  }
  return body;
}

/** The content column: the value, or the structured data in one line. */
export function contentText(r: DnsRecord): string {
  const d = r.data;
  if (r.type === "SRV" && d) return `${text(d.priority)} ${text(d.weight)} ${text(d.port)} ${text(d.target)}`;
  if (r.type === "CAA" && d) return `${text(d.flags)} ${text(d.tag)} "${text(d.value)}"`;
  if (r.type === "MX" && r.priority !== null) return `${r.priority} ${r.content}`;
  return r.content;
}

export function ttlText(ttl: number, tr: Tr): string {
  if (ttl <= TTL_AUTO) return tr("自动", "Auto");
  if (ttl < 120) return tr(`${ttl} 秒`, `${ttl} s`);
  if (ttl < 7200) return tr(`${Math.round(ttl / 60)} 分钟`, `${Math.round(ttl / 60)} min`);
  if (ttl < 86400) return tr(`${Math.round(ttl / 3600)} 小时`, `${Math.round(ttl / 3600)} h`);
  return tr("1 天", "1 day");
}

/** What the panel itself uses a record for (`uses[].kind`). */
export function kindName(kind: string, tr: Tr): string {
  const names: Record<string, [string, string]> = {
    main: ["主域名", "Main domain"],
    sub: ["订阅域名", "Subscription domain"],
    node: ["节点通信域名", "Node domain"],
    passkey: ["通行密钥中心域名", "Passkey centre"],
    server: ["服务器证书域名", "Server certificate domain"],
    entrance: ["入口连接地址", "Entrance address"],
  };
  const n = names[kind];
  return n ? tr(n[0], n[1]) : kind;
}

/** `params.impact` of `dns.confirm_required`. */
export function impactOf(params: Record<string, unknown>): { name: string; uses: Use[] }[] {
  const raw = params.impact;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((i) => {
    if (typeof i !== "object" || i === null) return [];
    const o = i as { name?: unknown; uses?: unknown };
    const uses = Array.isArray(o.uses)
      ? o.uses.flatMap((u) => (u && typeof u === "object" && typeof (u as Use).label === "string" ? [u as Use] : []))
      : [];
    return typeof o.name === "string" ? [{ name: o.name, uses }] : [];
  });
}
