// 系统设置 → 概览 (v2, proposal-v2 §5 "概览"): what needs the operator now
// ("需要注意": a problem, its cause and a "去修复" button each), then the
// eight groups with every section's key values in its row (abnormal values
// coloured), then the last three settings changes (audit log). The same
// data marks the navigation: an amber dot on sections with something to fix
// and the count next to "概览".
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleAlert, History, Info, Lock, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { get } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, Tile } from "../../shared/ui/card";
import { ErrorState, Skeleton } from "../../shared/ui/states";
import { SECONDARY } from "../data";
import { useAccess, useAuthSettings, useSettings } from "./settings-data";
import { SECTIONS, SETTINGS_IA, type Section, type SectionId } from "./settings-ia";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type SignupS = {
  register_enabled: boolean;
  email_verify: boolean;
  invite_required: boolean;
  user_invites: boolean;
  trial_plan_id: string | null;
  trial_days: number;
};
type CleanupS = { auto: boolean; after_days: number; due_delete: number };
type PaymentsS = {
  methods: { id: string; display_name: string; enabled: boolean; active: boolean; sort: number; warnings: string[] }[];
};
type CommissionS = { enabled: boolean; rate_percent: number; first_order_only: boolean; hold_days: number };
export type MailS = {
  enabled: boolean;
  provider: string;
  dead_letters: number;
  pending: number;
  notify_order_paid: boolean;
  notify_expiry_days: number;
  notify_expired: boolean;
  notify_quota: boolean;
  notify_refund: boolean;
  notify_ban: boolean;
  notify_plan_change: boolean;
  notify_withdrawal: boolean;
  notify_commission: boolean;
  warnings: string[];
  /** Settled in the last 24 hours (sent / given up). */
  sent_24h?: number;
  dead_24h?: number;
  /** The newest dead letter's error and time. */
  last_dead_error?: string | null;
  last_dead_at?: string | null;
  /** Mails sent in the last 30 days per kind. */
  sent_30d?: Record<string, number>;
};
type AlertsS = { enabled: boolean; telegram_enabled: boolean; webhook_enabled: boolean; email_enabled: boolean };
type BlockS = { nodes_enabled: number; rules: { enabled: boolean }[] };
type UpdatesS = { source_url: string | null; auto_check: boolean };
type BrandingS = {
  logo_url: string | null;
  favicon_url: string | null;
  footer_links: unknown[];
  tos_url: string | null;
  privacy_url: string | null;
  client_downloads: { platform: string }[];
};
type StatusS = { caddy?: { configured: boolean; host: string | null; cert_expires_at: string | null } };
type Tpl = { kind: string; custom: boolean };

const q = <T,>(key: unknown[], path: string, enabled = true) => ({
  queryKey: key,
  queryFn: () => get<T>(path),
  enabled,
});

/**
 * GET /settings/overview: every part is that section's own GET response
 * (`mail_templates` cut to kind/locale/custom). One round trip instead of a
 * dozen (a phone on a slow network paid one latency per request).
 */
type OverviewAll = {
  settings: unknown;
  signup: unknown;
  auth: unknown;
  cleanup: unknown;
  access: unknown;
  payments: unknown;
  commission: unknown;
  mail: unknown;
  mail_templates: Tpl[];
  alerts: unknown;
  block_rules: unknown;
  agent_updates: unknown;
  branding: unknown;
};

/** Summary part → the query key its section reads (the cache is seeded with it). */
const PARTS: [Exclude<keyof OverviewAll, "mail_templates">, unknown[]][] = [
  ["settings", ["settings"]],
  ["signup", ["settings", "signup"]],
  ["auth", ["settings", "auth"]],
  ["cleanup", ["settings", "cleanup"]],
  ["access", ["settings", "access"]],
  ["payments", ["settings", "payments"]],
  ["commission", ["commission-settings"]],
  ["mail", ["settings", "mail"]],
  ["alerts", ["alerts", "settings"]],
  ["block_rules", ["block-rules"]],
  ["agent_updates", ["agent-updates"]],
  ["branding", ["settings", "branding"]],
];

/** The summary query; its result seeds every section's cache. */
const overviewQuery = (qc: QueryClient) => ({
  queryKey: ["settings", "overview"],
  queryFn: async () => {
    const o = await get<OverviewAll>("/settings/overview");
    for (const [part, key] of PARTS) qc.setQueryData(key, o[part]);
    return o;
  },
});

/** The overview's data ahead of a visit (pages.ts). */
export function prefetchData(qc: QueryClient): void {
  void qc.prefetchQuery(overviewQuery(qc));
}

/** Whole days until an instant (negative = past). */
export function daysUntil(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export type Kv = { k: string; v: string; tone?: "danger" | "warning" };
export type Attn = {
  key: string;
  tone: "danger" | "warning" | "info";
  section: SectionId;
  title: string;
  body?: string;
  to: string;
  cta?: string;
};

/**
 * Everything the overview shows, from the sections' own endpoints. Each
 * query is shared with its section (same keys), so opening a section after
 * the overview is instant.
 */
export function useOverview() {
  const tr = useTr();
  const qc = useQueryClient();
  // One request seeds every section's cache; the per-section queries below
  // then start fresh (no requests) and follow their own invalidations. If
  // the summary fails they fetch on their own.
  const all = useQuery(overviewQuery(qc));
  const on = all.isSuccess || all.isError;
  const st = useSettings(on);
  const signup = useQuery(q<SignupS>(["settings", "signup"], "/settings/signup", on)).data;
  const auth = useAuthSettings(on).data;
  const cleanup = useQuery(q<CleanupS>(["settings", "cleanup"], "/settings/cleanup", on)).data;
  const access = useAccess(on).data;
  const pay = useQuery(q<PaymentsS>(["settings", "payments"], "/settings/payments", on)).data;
  const com = useQuery(q<CommissionS>(["commission-settings"], "/commission-settings", on)).data;
  const mail = useQuery(q<MailS>(["settings", "mail"], "/settings/mail", on)).data;
  const tplFull = useQuery(q<Tpl[]>(["mail-templates"], "/settings/mail-templates", all.isError)).data;
  const tpl = all.data?.mail_templates ?? tplFull;
  const alerts = useQuery(q<AlertsS>(["alerts", "settings"], "/alerts/settings", on)).data;
  const block = useQuery(q<BlockS>(["block-rules"], "/block-rules", on)).data;
  const upd = useQuery(q<UpdatesS>(["agent-updates"], "/agent-updates", on)).data;
  const brand = useQuery(q<BrandingS>(["settings", "branding"], "/settings/branding", on)).data;
  // The main domain's served certificate (system status probes it through the
  // proxy, the slowest call here): a detail, the overview is ready without it.
  const status = useQuery({
    ...q<StatusS>(["system-status"], "/system/status"),
    staleTime: 60_000,
    meta: SECONDARY,
  }).data;
  const d = st.data;
  const sum: Partial<Record<SectionId, Kv[]>> = {};
  const attn: Attn[] = [];
  const cert = status?.caddy?.cert_expires_at ? daysUntil(status.caddy.cert_expires_at) : null;
  const certTone: Kv["tone"] = cert === null ? undefined : cert <= 14 ? "danger" : cert <= 30 ? "warning" : undefined;

  if (d) {
    sum.site = [
      { k: tr("名称", "Name"), v: d.site_name || "Akari" },
      { k: tr("时区", "Time zone"), v: d.timezone.effective },
    ];
    sum.domains = [
      { k: tr("主", "Main"), v: String(d.main.domains.length), tone: d.main.domains.length ? undefined : "warning" },
      { k: tr("订阅", "Sub"), v: String(d.sub.domains.length) },
      ...(cert !== null ? [{ k: tr("证书", "Certificate"), v: tr(`${cert} 天`, `${cert} d`), tone: certTone }] : []),
    ];
    sum.subscription = [
      ...(d.subscription.own_client_only
        ? [{ k: tr("客户端", "Clients"), v: tr("仅自研客户端", "Own client only") }]
        : [
            { k: tr("格式", "Formats"), v: `${d.subscription.formats.effective.length} / 5` },
            { k: tr("一键导入", "Import"), v: `${d.subscription.import_clients.effective.length} / 7` },
          ]),
      { k: tr("倍率", "Multiplier"), v: d.subscription.name_rate ? tr("显示", "Shown") : tr("不显示", "Hidden") },
    ];
    sum["sub-templates"] = [{ k: tr("客户端", "Clients"), v: "4" }];
    const o = d.node_ops;
    sum.install = [
      { k: tr("钉扎", "Pin"), v: o.install_tls_pin ? tr("开", "On") : tr("关", "Off") },
      { k: "ACME", v: o.acme_directory_url ? hostOf(o.acme_directory_url) : "Let's Encrypt" },
    ];
    sum.probe = [
      {
        k: tr("间隔", "Every"),
        v: tr(
          `${Math.round(d.probe.interval_secs.effective / 60)} 分钟`,
          `${Math.round(d.probe.interval_secs.effective / 60)} min`,
        ),
      },
      { k: tr("地址", "URLs"), v: String(d.probe.urls.effective.length) },
      { k: "TCP", v: d.probe.panel_tcp.effective ? tr("开", "On") : tr("关", "Off") },
    ];
    const days = (n: { effective: number }) =>
      n.effective === 0 ? tr("永久", "forever") : tr(`${n.effective} 天`, `${n.effective} d`);
    sum.retention = [
      { k: tr("审计", "Audit"), v: days(d.security.audit_retention_days) },
      { k: tr("明细", "History"), v: days(d.security.traffic_daily_retention_days) },
    ];
    sum.updates = [
      ...(upd
        ? [
            { k: tr("源", "Source"), v: upd.source_url ? tr("自定义", "Custom") : tr("官方", "Official") },
            { k: tr("自动检查", "Auto check"), v: upd.auto_check ? tr("开", "On") : tr("关", "Off") },
          ]
        : []),
      { k: tr("公钥", "Keys"), v: String(d.security.release_keys.length) },
    ];
    for (const w of d.warnings)
      attn.push({
        key: `w:${w}`,
        tone: "info",
        section: "domains",
        title: w,
        to: "/settings/domains",
        cta: tr("查看", "View"),
      });
  }
  if (cert !== null && certTone)
    attn.unshift({
      key: "cert",
      tone: certTone,
      section: "domains",
      title:
        cert < 0
          ? tr(`主域名的证书已过期`, `The main domain's certificate has expired`)
          : tr(`主域名的证书 ${cert} 天后到期`, `The main domain's certificate expires in ${cert} days`),
      body: tr(
        `${status?.caddy?.host ?? ""} · 证书由反向代理（Caddy）签发与续期，请检查它的续期日志。`,
        `${status?.caddy?.host ?? ""} · the reverse proxy (Caddy) issues and renews it; check its renewal log.`,
      ),
      to: "/settings/domains",
      cta: tr("查看域名", "View domains"),
    });
  if (brand) {
    sum.brand = [
      { k: "Logo", v: brand.logo_url ? tr("已上传", "Uploaded") : tr("默认", "Default") },
      { k: tr("页脚", "Footer"), v: tr(`${brand.footer_links.length} 个链接`, `${brand.footer_links.length} links`) },
    ];
    sum.links = [
      { k: tr("条款", "Terms"), v: brand.tos_url ? tr("已设置", "Set") : tr("门户自带", "Built-in") },
      {
        k: tr("客户端", "Clients"),
        v: tr(
          `${new Set(brand.client_downloads.map((x) => x.platform)).size} 个平台`,
          `${new Set(brand.client_downloads.map((x) => x.platform)).size} platforms`,
        ),
      },
    ];
  }
  if (signup)
    sum.signup = [
      { k: tr("注册", "Sign-up"), v: signup.register_enabled ? tr("开放", "Open") : tr("关闭", "Closed") },
      {
        k: tr("邀请码", "Invites"),
        v: !signup.user_invites
          ? tr("用户邀请已关闭", "User invites off")
          : signup.invite_required
            ? tr("需要", "Required")
            : tr("不需要", "Optional"),
      },
      {
        k: tr("试用", "Trial"),
        v: signup.trial_plan_id ? tr(`${signup.trial_days} 天`, `${signup.trial_days} d`) : tr("无", "None"),
      },
    ];
  if (auth) {
    const forms = [auth.turnstile_login, auth.turnstile_register, auth.turnstile_reset].filter(Boolean).length;
    sum.login = [
      { k: "Turnstile", v: forms ? tr(`${forms} 个表单`, `${forms} forms`) : tr("关闭", "Off") },
      {
        k: tr("管理员", "Admins"),
        v: auth.passkey_only_admins ? tr("仅通行密钥", "Passkey only") : tr("密码 + 通行密钥", "Password + passkey"),
      },
    ];
  }
  if (cleanup)
    sum.cleanup = [
      { k: tr("自动清理", "Auto"), v: cleanup.auto ? tr("开启", "On") : tr("关闭", "Off") },
      { k: tr("天数", "Days"), v: String(cleanup.after_days) },
      ...(cleanup.auto ? [{ k: tr("待删除", "Due"), v: String(cleanup.due_delete) }] : []),
    ];
  if (access)
    sum.access = [
      { k: tr("前缀", "Prefix"), v: tr("已隐藏", "Masked") },
      {
        k: tr("白名单", "Allowlist"),
        v: access.admin_allow_cidrs.length
          ? tr(`${access.admin_allow_cidrs.length} 条`, `${access.admin_allow_cidrs.length}`)
          : tr("不限", "Any"),
      },
    ];
  if (pay) {
    const on = pay.methods.filter((m) => m.enabled);
    const bad = on.filter((m) => !m.active);
    sum.payments = [
      { k: tr("启用", "On"), v: `${on.length} / ${pay.methods.length}`, tone: on.length ? undefined : "warning" },
      ...(bad.length ? [{ k: tr("不可用", "Unusable"), v: String(bad.length), tone: "danger" as const }] : []),
    ];
    for (const m of bad)
      attn.push({
        key: `pay:${m.id}`,
        tone: "warning",
        section: "payments",
        title: tr(`${m.display_name} 不可用`, `${m.display_name} is unusable`),
        body: m.warnings.join(tr("；", "; ")) || tr("门户已自动隐藏此渠道。", "The portal hides it."),
        to: "/settings/payments",
        cta: tr("检查渠道", "Check it"),
      });
  }
  if (com)
    sum.commission = com.enabled
      ? [
          { k: tr("比例", "Rate"), v: `${com.rate_percent}%` },
          { k: tr("冻结", "Hold"), v: tr(`${com.hold_days} 天`, `${com.hold_days} d`) },
          ...(com.first_order_only ? [{ k: tr("仅首单", "First order"), v: tr("是", "Yes") }] : []),
        ]
      : [{ k: tr("返利", "Commissions"), v: tr("关闭", "Off") }];
  if (mail) {
    const failed = mail.dead_24h ?? 0;
    sum.mail = mail.enabled
      ? [
          { k: tr("通道", "Via"), v: mail.provider === "resend" ? "Resend" : "SMTP" },
          ...(mail.sent_24h !== undefined
            ? [{ k: tr("24 小时", "24 h"), v: tr(`${mail.sent_24h} 封`, `${mail.sent_24h}`) }]
            : []),
          ...(failed ? [{ k: tr("失败", "Failed"), v: String(failed), tone: "danger" as const }] : []),
        ]
      : [{ k: tr("发信", "Mail"), v: tr("未启用", "Off"), tone: "warning" }];
    if (failed)
      attn.push({
        key: "mail",
        tone: "warning",
        section: "mail",
        title: tr(`发信通道近 24 小时有 ${failed} 封失败`, `${failed} mails failed in the last 24 hours`),
        body: mail.last_dead_error ?? undefined,
        to: "/settings/mail?diagnose=1",
        cta: tr("诊断", "Diagnose"),
      });
    for (const w of mail.warnings)
      attn.push({
        key: `m:${w}`,
        tone: "warning",
        section: "mail",
        title: w,
        to: "/settings/mail",
        cta: tr("查看", "View"),
      });
    const on = [
      mail.notify_order_paid,
      mail.notify_expiry_days > 0,
      mail.notify_expired,
      mail.notify_quota,
      mail.notify_refund,
      mail.notify_ban,
      mail.notify_plan_change,
      mail.notify_withdrawal,
      mail.notify_commission,
    ];
    sum.notices = [{ k: tr("开启", "On"), v: `${on.filter(Boolean).length} / ${on.length}` }];
  }
  if (tpl) {
    const kinds = new Set(tpl.map((t) => t.kind)).size;
    const custom = new Set(tpl.filter((t) => t.custom).map((t) => t.kind)).size;
    sum.templates = [
      { k: tr("种类", "Kinds"), v: String(kinds) },
      { k: tr("已自定义", "Customised"), v: String(custom) },
    ];
  }
  if (alerts) {
    const ch = [alerts.telegram_enabled, alerts.webhook_enabled, alerts.email_enabled].filter(Boolean).length;
    sum.alerts = alerts.enabled
      ? [{ k: tr("通道", "Channels"), v: `${ch} / 3`, tone: ch ? undefined : "warning" }]
      : [{ k: tr("告警", "Alerts"), v: tr("关闭", "Off"), tone: "warning" }];
  }
  if (block)
    sum.block = [
      { k: tr("规则集", "Rule sets"), v: String(block.rules.filter((r) => r.enabled).length) },
      { k: tr("节点", "Nodes"), v: String(block.nodes_enabled) },
    ];
  if (auth?.warnings.length)
    for (const w of auth.warnings)
      attn.push({
        key: `a:${w}`,
        tone: "warning",
        section: "login",
        title: w,
        to: "/settings/login",
        cta: tr("查看", "View"),
      });
  sum.account = [{ k: tr("位置", "Where"), v: tr("我的账户", "My account") }];
  return {
    sum,
    attn,
    // A failed background refetch keeps what is shown (e.g. right after the admin prefix moved).
    error: d ? null : all.isError ? (st.error ?? all.error) : null,
    refetch: () => void (all.isError ? st.refetch() : all.refetch()),
    loading: !d && !(all.isError && st.error),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Sections with something to fix (the navigation's amber dot). */
export const flagged = (attn: Attn[], id: SectionId) => attn.some((a) => a.section === id && a.tone !== "info");

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const TONE_ICON = {
  danger: <CircleAlert className="size-4 text-destructive" aria-hidden="true" />,
  warning: <TriangleAlert className="size-4 text-warning" aria-hidden="true" />,
  info: <Info className="size-4 text-info" aria-hidden="true" />,
};

export function Attention({ items }: { items: Attn[]; compact?: boolean }) {
  const tr = useTr();
  if (items.length === 0) return null;
  const danger = items.filter((a) => a.tone === "danger").length;
  const warning = items.filter((a) => a.tone === "warning").length;
  return (
    <Card className="overflow-hidden" role="region" aria-label={tr("需要注意", "Needs attention")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-separator px-4 py-2.5">
        <h2 className="flex-1 text-headline font-semibold">{tr("需要注意", "Needs attention")}</h2>
        {danger > 0 && <Badge tone="danger">{tr(`${danger} 项紧急`, `${danger} urgent`)}</Badge>}
        {warning > 0 && <Badge tone="warning">{tr(`${warning} 项警告`, `${warning} warnings`)}</Badge>}
      </div>
      <ul className="divide-y divide-separator">
        {items.map((a) => (
          <li key={a.key} className="flex items-start gap-x-3 px-4 py-3">
            <span className="mt-0.5">{TONE_ICON[a.tone]}</span>
            <div className="min-w-0 flex-1">
              <div className="text-body font-semibold break-words">{a.title}</div>
              {a.body && <div className="mt-0.5 text-footnote break-words text-muted-foreground">{a.body}</div>}
            </div>
            {a.cta && (
              <Button asChild size="sm" variant={a.tone === "danger" ? "primary" : "outline"} className="shrink-0">
                <Link to={a.to}>{a.cta}</Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Summary({ items, className }: { items?: Kv[]; className?: string }) {
  if (!items) return <Skeleton className={cn("mt-1 h-3 w-40", className)} />;
  return (
    <span className={cn("flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5 text-footnote", className)}>
      {items.map((x) => (
        <span key={x.k} className="whitespace-nowrap">
          <span className="text-faint">{x.k} </span>
          <span
            className={cn(
              "font-medium tabular-nums",
              x.tone === "danger"
                ? "text-destructive"
                : x.tone === "warning"
                  ? "text-warning"
                  : "text-muted-foreground",
            )}
          >
            {x.v}
          </span>
        </span>
      ))}
    </span>
  );
}

export const hrefOf = (s: Section) => s.href ?? `/settings/${s.id}`;

type AuditEntry = {
  id: number;
  at: string;
  actor_label: string;
  actor_email: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/** The section an audit action belongs to (the first whose action matches). */
function sectionOfAction(action: string): Section | undefined {
  return SECTIONS.find((s) => s.audit && (s.audit.endsWith(".") ? action.startsWith(s.audit) : action === s.audit));
}

function changedCount(e: AuditEntry): number {
  const a = e.after ?? {};
  const b = e.before ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => k !== "version" && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  ).length;
}

function changeText(e: AuditEntry, tr: Tr): string {
  if (e.action.endsWith(".rotate") || e.action.endsWith(".generate")) return tr("轮换", "Rotated");
  if (e.action.endsWith(".reset")) return tr("恢复默认", "Restored the default");
  if (e.action.endsWith(".remove") || e.action.endsWith(".delete")) return tr("移除", "Removed");
  if (e.action.endsWith(".test")) return tr("测试", "Tested");
  const n = changedCount(e);
  return n ? tr(`修改了 ${n} 项`, `${n} ${n === 1 ? "value" : "values"} changed`) : tr("保存", "Saved");
}

/** The last change of a section (its header) — `null` while none is known. */
export function useLastEdit(action: string | undefined) {
  return useQuery({
    queryKey: ["audit", "last", action],
    queryFn: () => get<{ entries: AuditEntry[] }>(`/audit?limit=1&action=${encodeURIComponent(action ?? "")}`),
    enabled: !!action,
    staleTime: 30_000,
    meta: SECONDARY,
  }).data?.entries[0];
}

function RecentChanges() {
  const tr = useTr();
  const r = useQuery({
    queryKey: ["audit", "recent-settings"],
    queryFn: () => get<{ entries: AuditEntry[] }>("/audit?limit=3&action=settings."),
    staleTime: 30_000,
    meta: SECONDARY,
  });
  const list = r.data?.entries ?? [];
  if (r.isError || (r.data && list.length === 0)) return null;
  return (
    <section className="grid gap-1.5">
      <h3 className="flex items-center gap-1.5 px-1 text-footnote font-semibold text-muted-foreground">
        <History className="size-3.5" aria-hidden="true" />
        {tr("最近修改", "Recent changes")}
      </h3>
      <Card className="divide-y divide-separator">
        {!r.data && (
          <div className="px-4 py-3">
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
        {list.map((e) => {
          const s = sectionOfAction(e.action);
          return (
            <Link
              key={e.id}
              to={`/audit?action=${encodeURIComponent(e.action)}&entry=${e.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-body hover:bg-accent/60"
            >
              <span className="w-32 shrink-0 text-footnote text-faint tabular-nums">{dateTime(e.at)}</span>
              <span className="font-medium">{s ? tr(s.zh, s.en) : tr("系统设置", "Settings")}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{changeText(e, tr)}</span>
              <span className="text-footnote text-faint">{e.actor_email ?? e.actor_label}</span>
            </Link>
          );
        })}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The overview (desktop) and the phone index
// ---------------------------------------------------------------------------

export function Overview({ data }: { data: ReturnType<typeof useOverview> }) {
  const tr = useTr();
  if (data.error)
    return (
      <Card>
        <ErrorState error={data.error} onRetry={() => void data.refetch()} />
      </Card>
    );
  return (
    <div className="grid gap-6">
      <header className="pt-1">
        <h2 className="text-title2 font-bold tracking-[-0.02em]">{tr("概览", "Overview")}</h2>
        <p className="mt-1 text-body text-muted-foreground">
          {tr(
            `${SETTINGS_IA.length} 组 ${SECTIONS.length} 个分区。`,
            `${SETTINGS_IA.length} groups, ${SECTIONS.length} sections. `,
          )}
          <Lock className="inline size-3" aria-label={tr("锁", "A lock")} />{" "}
          {tr(
            "只有所有者能修改；每个分区底部的保存栏一次保存该分区的全部修改。",
            "marks what only the owner can change; each section's save bar saves all its changes at once.",
          )}
        </p>
      </header>
      <Attention items={data.attn} />
      <div className="grid gap-5 xl:grid-cols-2">
        {SETTINGS_IA.map((g) => (
          <section key={g.zh} className="grid content-start gap-1.5">
            <h3 className="px-1 text-footnote font-semibold text-muted-foreground">{tr(g.zh, g.en)}</h3>
            <div className="divide-y divide-separator overflow-hidden rounded-xl bg-card shadow-card">
              {g.sections.map((s) => (
                <Link
                  key={s.id}
                  to={hrefOf(s)}
                  className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/60"
                >
                  <Tile color={s.tint} size={28}>
                    <s.icon />
                  </Tile>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-body font-semibold">
                      {tr(s.zh, s.en)}
                      {s.owner && (
                        <Lock className="size-3 text-faint" aria-label={tr("仅所有者可修改", "Owner only")} />
                      )}
                    </div>
                    <Summary items={data.sum[s.id]} className="mt-0.5" />
                  </div>
                  <ChevronRight
                    className="size-4 text-faint transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
      <RecentChanges />
    </div>
  );
}

export function PhoneGroups({ data }: { data: ReturnType<typeof useOverview> }) {
  const tr = useTr();
  if (data.error)
    return (
      <Card>
        <ErrorState error={data.error} onRetry={() => void data.refetch()} />
      </Card>
    );
  return (
    <div className="grid gap-5">
      <Attention items={data.attn} compact />
      <nav aria-label={tr("设置分类", "Settings sections")} className="grid gap-5">
        {SETTINGS_IA.map((g) => (
          <section key={g.zh} className="grid gap-1.5">
            <h3 className="px-4 text-footnote font-semibold text-muted-foreground">{tr(g.zh, g.en)}</h3>
            <div className="divide-y divide-separator overflow-hidden rounded-xl bg-card shadow-card">
              {g.sections.map((s) => (
                <Link key={s.id} to={hrefOf(s)} className="flex min-h-14 items-center gap-3 px-4 py-2 active:bg-accent">
                  <Tile color={s.tint} size={30}>
                    <s.icon />
                  </Tile>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-callout font-medium">
                      {tr(s.zh, s.en)}
                      {s.owner && (
                        <Lock className="size-3 text-faint" aria-label={tr("仅所有者可修改", "Owner only")} />
                      )}
                    </div>
                    <Summary items={data.sum[s.id]} className="flex-nowrap overflow-hidden" />
                  </div>
                  <ChevronRight className="size-4 text-faint" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </section>
        ))}
      </nav>
    </div>
  );
}
