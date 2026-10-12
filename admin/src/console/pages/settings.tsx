// 系统设置 (SET-*, 2026-10 redesign, proposal §3): sections grouped by
// domain, one URL each (`/settings` = overview, `/settings/<section>`; the
// old `/settings/<tab>` paths redirect). Desktop: the group navigation with
// search (labels, descriptions, old names) next to the section; phone: the
// group list, then the section with "‹ 系统设置". Every section saves one
// way: the bottom save bar (N unsaved changes · discard · save, ⌘/Ctrl+S;
// disabled while fields need fixing); leaving with unsaved changes asks.
import { ChevronLeft, ChevronRight, CloudCog, ExternalLink, Lock, Search, TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ComponentType, type ReactNode } from "react";
import { Link, Navigate } from "react-router";
import { cn } from "../../shared/cn";
import { get } from "../../shared/api";
import { useTr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { Tile } from "../../shared/ui/card";
import { Input } from "../../shared/ui/form";
import { useRoute } from "../router";
import { useCrumb } from "../session";
import { AccessSection, RetentionSection } from "./settings-access";
import { useAccess, useAuthSettings, useSettings } from "./settings-data";
import { DomainsSection, SiteSection } from "./settings-general";
import { MOVED_OUT, OLD_IDS, OVERVIEW_TINT, SECTIONS, SETTINGS_IA, type Section, type SectionId } from "./settings-ia";
import { OwnerBadge, SectionForm, useWide } from "../components/settings-kit";
import { AlertsSection, MailSection, NoticesSection, TemplatesSection } from "./settings-mail";
import { BlockSection, InstallSection, ProbeSection, UpdatesSection } from "./settings-misc";
import { CommissionSection, PaymentsSection } from "./settings-payments";
import { CleanupSection, LoginSection, SignupSection } from "./settings-signup";
import { RoutingSection, SubscriptionSection } from "./settings-sub";

export { useSettings, type DomainEntry, type Rule, type SettingsView } from "./settings-data";

const BODIES: Record<Exclude<SectionId, "account">, ComponentType> = {
  site: SiteSection,
  domains: DomainsSection,
  signup: SignupSection,
  login: LoginSection,
  cleanup: CleanupSection,
  subscription: SubscriptionSection,
  routing: RoutingSection,
  install: InstallSection,
  probe: ProbeSection,
  block: BlockSection,
  updates: UpdatesSection,
  payments: PaymentsSection,
  commission: CommissionSection,
  mail: MailSection,
  templates: TemplatesSection,
  notices: NoticesSection,
  alerts: AlertsSection,
  access: AccessSection,
  retention: RetentionSection,
};

const hrefOf = (s: Section) => s.href ?? `/settings/${s.id}`;

export function SettingsPage() {
  const { sub, query } = useRoute();
  const wide = useWide();
  const id = sub[0];
  // Old addresses: the tab ids of the previous layout, and the outbox (now on the status page).
  if (id === "mail" && query.has("outbox"))
    return <Navigate to={`/status?mail=${query.get("outbox") || "dead"}`} replace />;
  if (id && OLD_IDS[id]) return <Navigate to={`/settings/${OLD_IDS[id]}`} replace />;
  const cur = id ? SECTIONS.find((s) => s.id === id) : undefined;
  if (id && !cur) return <Navigate to="/settings" replace />;
  if (cur?.href) return <Navigate to={cur.href} replace />;
  if (!wide) return cur ? <SectionPage key={cur.id} s={cur} /> : <PhoneIndex />;
  return (
    <div className="grid grid-cols-[232px_minmax(0,1fr)] gap-6 xl:gap-8">
      <SettingsNav current={cur?.id} />
      <div className="min-w-0">{cur ? <SectionPage key={cur.id} s={cur} /> : <Overview />}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function useSearch() {
  const tr = useTr();
  const [q, setQ] = useState("");
  const t = q.trim().toLowerCase();
  const match = useCallback(
    (s: { zh: string; en: string; keywords: string; desc?: [string, string]; from?: [string, string] }) =>
      !t ||
      `${s.zh} ${s.en} ${s.keywords} ${s.desc?.join(" ") ?? ""} ${s.from?.join(" ") ?? ""}`.toLowerCase().includes(t),
    [t],
  );
  const box = (phone?: boolean) => (
    <div className={cn("relative", phone ? "mb-4" : "mb-3")}>
      <Search
        className={cn(
          "pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-faint",
          phone ? "left-3" : "left-2.5",
        )}
        aria-hidden="true"
      />
      <Input
        type="search"
        data-nodirty
        aria-label={tr("搜索设置", "Search settings")}
        placeholder={tr("搜索设置", "Search settings")}
        className={
          phone
            ? "h-10 rounded-[11px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] pl-9 shadow-none"
            : "rounded-full pl-8"
        }
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
    </div>
  );
  const moved = t ? MOVED_OUT.filter(match) : [];
  return { q: t, match, box, moved };
}

function Moved({ items }: { items: typeof MOVED_OUT }) {
  const tr = useTr();
  return (
    <>
      {items.map((m) => (
        <Link
          key={m.to}
          to={m.to}
          className="flex min-h-9 items-center gap-2.5 rounded-[9px] px-2 py-1 text-body hover:bg-accent"
        >
          <ExternalLink className="size-4 text-faint" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{tr(m.zh, m.en)}</span>
            <span className="block text-footnote text-muted-foreground">{tr(...m.where)}</span>
          </span>
        </Link>
      ))}
    </>
  );
}

function OwnerLock({ on }: { on?: boolean }) {
  const tr = useTr();
  return (
    <Lock
      className={cn("size-3 shrink-0", on ? "text-primary-foreground/80" : "text-faint")}
      aria-label={tr("仅所有者可修改", "Owner only")}
    />
  );
}

function DangerMark() {
  const tr = useTr();
  return <TriangleAlert className="size-3 shrink-0 text-warning" aria-label={tr("含危险操作", "Has a danger zone")} />;
}

// ---------------------------------------------------------------------------
// Desktop navigation and overview
// ---------------------------------------------------------------------------

function SettingsNav({ current }: { current?: SectionId }) {
  const tr = useTr();
  const search = useSearch();
  const item = (on: boolean) =>
    cn(
      "flex h-8 items-center gap-2.5 rounded-[9px] px-2 text-body font-medium transition-colors",
      on ? "bg-primary text-primary-foreground" : "hover:bg-accent",
    );
  const groups = SETTINGS_IA.map((g) => ({ ...g, sections: g.sections.filter(search.match) })).filter(
    (g) => g.sections.length > 0,
  );
  return (
    <aside className="sticky top-[76px] max-h-[calc(100dvh-100px)] self-start overflow-y-auto pr-1 pb-6">
      <h1 className="mb-3 text-title2 font-bold tracking-[-0.02em]">{tr("系统设置", "Settings")}</h1>
      {search.box()}
      <nav aria-label={tr("设置分类", "Settings sections")}>
        {!search.q && (
          <Link to="/settings" aria-current={!current ? "page" : undefined} className={cn(item(!current), "mb-2")}>
            <Tile color={OVERVIEW_TINT}>
              <CloudCog />
            </Tile>
            {tr("概览", "Overview")}
          </Link>
        )}
        {groups.map((g) => (
          <div key={g.zh} className="mt-3">
            <div className="px-2 pb-1 text-caption font-semibold text-faint">{tr(g.zh, g.en)}</div>
            {g.sections.map((s) => (
              <Link
                key={s.id}
                to={hrefOf(s)}
                aria-current={current === s.id ? "page" : undefined}
                className={item(current === s.id)}
              >
                <Tile color={s.tint}>
                  <s.icon />
                </Tile>
                <span className="flex-1 truncate">{tr(s.zh, s.en)}</span>
                {s.owner && <OwnerLock on={current === s.id} />}
                {s.href && <ChevronRight className="size-3.5 text-faint" aria-hidden="true" />}
              </Link>
            ))}
          </div>
        ))}
        {search.moved.length > 0 && (
          <div className="mt-3">
            <div className="px-2 pb-1 text-caption font-semibold text-faint">{tr("已移出设置", "Moved elsewhere")}</div>
            <Moved items={search.moved} />
          </div>
        )}
        {search.q && groups.length === 0 && search.moved.length === 0 && (
          <p className="px-2 py-3 text-footnote text-muted-foreground">
            {tr("没有匹配的设置", "No matching settings")}
          </p>
        )}
      </nav>
    </aside>
  );
}

type Notice = { key: string; text: ReactNode; to: string };

/**
 * "需要注意": what needs the operator now — obsolete panel.toml keys (SET-25),
 * the standing warnings of /settings (domains, passkey centre) and mail that
 * could not be delivered. One strip, one "查看" (the first item's place).
 */
function Attention({ mail }: { mail?: { dead_letters: number } }) {
  const tr = useTr();
  const s = useSettings();
  const d = s.data;
  const items: Notice[] = [];
  if (d?.obsolete_config_keys.length)
    items.push({
      key: "obsolete",
      to: "/settings",
      text: (
        <>
          {tr("panel.toml 中有已废弃的键", "panel.toml has obsolete keys")}{" "}
          <code className="font-mono break-all">{d.obsolete_config_keys.join(", ")}</code>
          {tr(
            "，这些设置已经搬到系统设置里，请从文件中删除",
            "; these settings live here now, delete them from the file",
          )}
        </>
      ),
    });
  for (const w of d?.warnings ?? []) items.push({ key: w, to: "/settings/domains", text: w });
  if (mail?.dead_letters)
    items.push({
      key: "mail",
      to: "/status?mail=dead",
      text: tr(`发信通道有 ${mail.dead_letters} 封邮件发送失败`, `${mail.dead_letters} mails could not be delivered`),
    });
  if (items.length === 0) return null;
  const go = items.find((i) => i.to !== "/settings")?.to;
  return (
    <section
      aria-label={tr("需要注意", "Needs attention")}
      className="grid gap-3 rounded-xl bg-warning-soft px-4 py-3 text-body sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
    >
      <TriangleAlert className="size-4 text-warning max-sm:hidden" aria-hidden="true" />
      <p>
        <b className="font-semibold">
          {tr(
            `需要注意 ${items.length} 项：`,
            `${items.length} ${items.length === 1 ? "thing needs" : "things need"} attention: `,
          )}
        </b>
        {items.map((i, n) => (
          <span key={i.key}>
            {n > 0 && tr("；", "; ")}
            {i.text}
          </span>
        ))}
        {tr("。", ".")}
      </p>
      {go && (
        <Button asChild size="sm" variant="outline" className="justify-self-start">
          <Link to={go}>{tr("查看", "View")}</Link>
        </Button>
      )}
    </section>
  );
}

// --- One-line summaries (real values; the section's description until they load) ---

type Num3 = { value: number | null; effective: number };
type SignupS = { register_enabled: boolean; email_verify: boolean; invite_required: boolean };
type CleanupS = { auto: boolean; after_days: number };
type PaymentsS = { methods: { display_name: string; enabled: boolean; sort: number }[] };
type CommissionS = { enabled: boolean; rate_percent: number; first_order_only: boolean };
type MailS = {
  enabled: boolean;
  provider: string;
  dead_letters: number;
  notify_order_paid: boolean;
  notify_expiry_days: number;
  notify_expired: boolean;
  notify_quota: boolean;
  notify_refund: boolean;
};
type AlertsS = { enabled: boolean; telegram_enabled: boolean; webhook_enabled: boolean; email_enabled: boolean };
type BlockS = { nodes_enabled: number; rules: { enabled: boolean }[] };
type UpdatesS = { source_url: string | null; auto_check: boolean };

function useSummaries(): { sum: Partial<Record<SectionId, string>>; mail?: MailS } {
  const tr = useTr();
  const q = <T,>(key: unknown[], path: string) => ({ queryKey: key, queryFn: () => get<T>(path) });
  const st = useSettings().data;
  const signup = useQuery(q<SignupS>(["settings", "signup"], "/settings/signup")).data;
  const auth = useAuthSettings().data;
  const cleanup = useQuery(q<CleanupS>(["settings", "cleanup"], "/settings/cleanup")).data;
  const access = useAccess().data;
  const pay = useQuery(q<PaymentsS>(["settings", "payments"], "/settings/payments")).data;
  const com = useQuery(q<CommissionS>(["commission-settings"], "/commission-settings")).data;
  const mail = useQuery(q<MailS>(["settings", "mail"], "/settings/mail")).data;
  const tpl = useQuery(q<{ kind: string; custom: boolean }[]>(["mail-templates"], "/settings/mail-templates")).data;
  const alerts = useQuery(q<AlertsS>(["alerts", "settings"], "/alerts/settings")).data;
  const block = useQuery(q<BlockS>(["block-rules"], "/block-rules")).data;
  const upd = useQuery(q<UpdatesS>(["agent-updates"], "/agent-updates")).data;
  const sep = " · ";
  const days = (n: Num3) => (n.effective === 0 ? tr("永久", "forever") : tr(`${n.effective} 天`, `${n.effective} d`));
  const sum: Partial<Record<SectionId, string>> = {};
  if (st) {
    sum.site = [st.site_name || "Akari", st.timezone.effective].join(sep);
    sum.domains = tr(
      `主 ${st.main.domains.length} · 订阅 ${st.sub.domains.length} · 节点 ${st.node.domains.length}`,
      `Main ${st.main.domains.length} · subscription ${st.sub.domains.length} · node ${st.node.domains.length}`,
    );
    sum.subscription = tr(
      `${st.subscription.formats.effective.length} 种格式 · ${st.subscription.import_clients.effective.length} 个一键导入`,
      `${st.subscription.formats.effective.length} formats · ${st.subscription.import_clients.effective.length} import buttons`,
    );
    sum.routing = [
      st.subscription.rules.value === null ? tr("默认模板", "Default template") : tr("自定义", "Custom"),
      tr(`${st.subscription.rules.effective.length} 条`, `${st.subscription.rules.effective.length} rules`),
    ].join(sep);
    const o = st.node_ops;
    sum.install = [
      o.install_tls_pin ? tr("公钥钉扎", "Pinned key") : tr("自动探测证书", "Certificate probed"),
      o.acme_directory_url
        ? tr(`ACME ${hostOf(o.acme_directory_url)}`, `ACME ${hostOf(o.acme_directory_url)}`)
        : "ACME Let's Encrypt",
    ].join(sep);
    const mins = Math.round(st.probe.interval_secs.effective / 60);
    sum.probe = [
      tr(`每 ${mins} 分钟`, `Every ${mins} min`),
      st.probe.panel_tcp.effective ? tr("TCP 测速", "TCP probe") : tr("不做 TCP 测速", "No TCP probe"),
    ].join(sep);
    sum.retention = tr(
      `审计 ${days(st.security.audit_retention_days)} · 明细 ${days(st.security.traffic_daily_retention_days)}`,
      `Audit ${days(st.security.audit_retention_days)} · history ${days(st.security.traffic_daily_retention_days)}`,
    );
  }
  if (signup)
    sum.signup = [
      signup.register_enabled ? tr("开放注册", "Open") : tr("不开放注册", "Closed"),
      signup.email_verify ? tr("需验证邮箱", "Email verified") : tr("不验证邮箱", "No verification"),
      ...(signup.invite_required ? [tr("需邀请码", "Invite only")] : []),
    ].join(sep);
  if (auth) {
    const forms = [auth.turnstile_login, auth.turnstile_register, auth.turnstile_reset].filter(Boolean).length;
    sum.login = [
      forms
        ? tr(`Turnstile 已开 · ${forms} 个表单`, `Turnstile on · ${forms} forms`)
        : tr("Turnstile 未开", "Turnstile off"),
      ...(auth.passkey_only_admins ? [tr("管理员仅通行密钥", "Admins passkey only")] : []),
    ].join(sep);
  }
  if (cleanup)
    sum.cleanup = cleanup.auto
      ? tr(`开启 · 注册超过 ${cleanup.after_days} 天`, `On · after ${cleanup.after_days} days`)
      : tr("关闭", "Off");
  if (access)
    sum.access = [
      tr("前缀已隐藏", "Prefix masked"),
      access.admin_allow_cidrs.length
        ? tr(`白名单 ${access.admin_allow_cidrs.length} 条`, `${access.admin_allow_cidrs.length} allowed`)
        : tr("不限 IP", "Any address"),
    ].join(sep);
  if (pay) {
    const on = [...pay.methods].filter((m) => m.enabled).sort((a, b) => a.sort - b.sort);
    sum.payments = on.length ? on.map((m) => m.display_name).join(sep) : tr("没有启用的渠道", "No channel on");
  }
  if (com)
    sum.commission = com.enabled
      ? [`${com.rate_percent}%`, ...(com.first_order_only ? [tr("仅首单", "First order only")] : [])].join(sep)
      : tr("关闭", "Off");
  if (mail) {
    sum.mail = mail.enabled
      ? [
          mail.provider === "resend" ? "Resend" : "SMTP",
          mail.dead_letters ? tr(`${mail.dead_letters} 封失败`, `${mail.dead_letters} failed`) : tr("正常", "Healthy"),
        ].join(sep)
      : tr("未启用", "Off");
    const on = [
      mail.notify_order_paid,
      mail.notify_expiry_days > 0,
      mail.notify_expired,
      mail.notify_quota,
      mail.notify_refund,
    ];
    sum.notices = tr(
      `${on.filter(Boolean).length} / ${on.length} 开启`,
      `${on.filter(Boolean).length} of ${on.length} on`,
    );
  }
  if (tpl) {
    const kinds = new Set(tpl.map((t) => t.kind)).size;
    const custom = new Set(tpl.filter((t) => t.custom).map((t) => t.kind)).size;
    sum.templates = tr(`${kinds} 种 · ${custom} 种已自定义`, `${kinds} kinds · ${custom} customised`);
  }
  if (alerts) {
    const ch = [
      alerts.telegram_enabled && "Telegram",
      alerts.webhook_enabled && "Webhook",
      alerts.email_enabled && tr("邮件", "Email"),
    ].filter(Boolean);
    sum.alerts = !alerts.enabled
      ? tr("告警关闭", "Alerts off")
      : ch.length
        ? ch.join(sep)
        : tr("没有通知通道", "No channel");
  }
  if (block)
    sum.block = tr(
      `${block.rules.filter((r) => r.enabled).length} 个规则集 · ${block.nodes_enabled} 个节点启用`,
      `${block.rules.filter((r) => r.enabled).length} rule sets · on ${block.nodes_enabled} nodes`,
    );
  if (upd)
    sum.updates = [
      upd.source_url ? tr("自定义源", "Custom source") : tr("官方源", "Official source"),
      upd.auto_check ? tr("自动检查", "Auto check") : tr("手动检查", "Manual check"),
    ].join(sep);
  return { sum, mail };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Overview() {
  const tr = useTr();
  useCrumb(tr("概览", "Overview"));
  const { sum, mail } = useSummaries();
  return (
    <div className="grid gap-6">
      <div className="pt-1">
        <h2 className="text-title2 font-bold tracking-[-0.02em]">{tr("概览", "Overview")}</h2>
        <p className="mt-1 text-body text-muted-foreground">
          {tr(
            `${SETTINGS_IA.length} 组 ${SECTIONS.length} 个分区。带`,
            `${SETTINGS_IA.length} groups, ${SECTIONS.length} sections. Those with`,
          )}{" "}
          <Lock className="inline size-3" aria-label={tr("锁", "a lock")} />{" "}
          {tr("的只有所有者能修改；带", "only the owner can change; those with")}{" "}
          <TriangleAlert className="inline size-3 text-warning" aria-label={tr("警告", "a warning sign")} />{" "}
          {tr(
            "的分区含有影响全站的危险操作，单独放在分区底部的「危险操作」里。",
            "hold site-wide dangerous actions, kept apart in the section's danger zone.",
          )}
        </p>
      </div>
      <Attention mail={mail} />
      {SETTINGS_IA.map((g) => (
        <section key={g.zh}>
          <h3 className="mb-2 px-1 text-footnote font-semibold text-muted-foreground">{tr(g.zh, g.en)}</h3>
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {g.sections.map((s) => (
              <Link
                key={s.id}
                to={hrefOf(s)}
                title={tr(`原位置：${s.from[0]}`, `Formerly: ${s.from[1]}`)}
                className="group flex items-center gap-3 rounded-xl bg-card p-3.5 shadow-card transition-shadow hover:shadow-raised"
              >
                <Tile color={s.tint} size={32}>
                  <s.icon />
                </Tile>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-body font-semibold">
                    {tr(s.zh, s.en)}
                    {s.owner && <OwnerLock />}
                    {s.danger && <DangerMark />}
                  </div>
                  <div className="truncate text-footnote text-muted-foreground">{sum[s.id] ?? tr(...s.desc)}</div>
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
      <MovedFrom />
    </div>
  );
}

/** "从哪里搬来": where each section lived before the redesign (collapsed). */
function MovedFrom() {
  const tr = useTr();
  return (
    <details className="group rounded-xl bg-card shadow-card">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-body font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 text-faint transition-transform group-open:rotate-90" aria-hidden="true" />
        {tr("找不到以前的设置？每个分区是从哪里搬来的", "Looking for an old setting? Where each section came from")}
      </summary>
      <ul className="divide-y divide-separator border-t border-separator">
        {SECTIONS.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2">
            <Tile color={s.tint}>
              <s.icon />
            </Tile>
            <Link to={hrefOf(s)} className="min-w-32 text-body font-medium hover:text-primary">
              {tr(s.zh, s.en)}
            </Link>
            <span className="min-w-0 flex-1 basis-48 text-footnote text-muted-foreground">
              {tr(`原位置：${s.from[0]}`, `Formerly: ${s.from[1]}`)}
            </span>
          </li>
        ))}
        {MOVED_OUT.map((m) => (
          <li key={m.to} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2">
            <ExternalLink className="size-4 text-faint" aria-hidden="true" />
            <Link to={m.to} className="min-w-32 text-body font-medium hover:text-primary">
              {tr(m.zh, m.en)}
            </Link>
            <span className="min-w-0 flex-1 basis-48 text-footnote text-muted-foreground">{tr(...m.where)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Phone: the group list
// ---------------------------------------------------------------------------

function PhoneIndex() {
  const tr = useTr();
  const search = useSearch();
  const { sum, mail } = useSummaries();
  const groups = SETTINGS_IA.map((g) => ({ ...g, sections: g.sections.filter(search.match) })).filter(
    (g) => g.sections.length > 0,
  );
  return (
    <>
      <h1 className="mb-3 text-title1 font-bold tracking-[-0.02em]">{tr("系统设置", "Settings")}</h1>
      {search.box(true)}
      {!search.q && (
        <div className="mb-5 empty:hidden">
          <Attention mail={mail} />
        </div>
      )}
      <nav aria-label={tr("设置分类", "Settings sections")} className="grid gap-5">
        {groups.map((g) => (
          <section key={g.zh} className="grid gap-1.5">
            <h2 className="px-4 text-footnote font-semibold text-muted-foreground">{tr(g.zh, g.en)}</h2>
            <div className="divide-y divide-separator overflow-hidden rounded-xl bg-card shadow-card">
              {g.sections.map((s) => (
                <Link key={s.id} to={hrefOf(s)} className="flex min-h-12 items-center gap-3 px-4 py-2 active:bg-accent">
                  <Tile color={s.tint} size={28}>
                    <s.icon />
                  </Tile>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-callout font-medium">
                      {tr(s.zh, s.en)}
                      {s.owner && <OwnerLock />}
                    </div>
                    <div className="truncate text-footnote text-muted-foreground">{sum[s.id] ?? tr(...s.desc)}</div>
                  </div>
                  <ChevronRight className="size-4 text-faint" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </section>
        ))}
        {search.moved.length > 0 && (
          <section className="grid gap-1.5">
            <h2 className="px-4 text-footnote font-semibold text-muted-foreground">
              {tr("已移出设置", "Moved elsewhere")}
            </h2>
            <div className="rounded-xl bg-card p-1.5 shadow-card">
              <Moved items={search.moved} />
            </div>
          </section>
        )}
        {search.q && groups.length === 0 && search.moved.length === 0 && (
          <p className="px-4 text-footnote text-muted-foreground">{tr("没有匹配的设置", "No matching settings")}</p>
        )}
      </nav>
    </>
  );
}

// ---------------------------------------------------------------------------
// A section: header, body, the save bar and the leave guard
// ---------------------------------------------------------------------------

function SectionPage({ s }: { s: Section }) {
  const tr = useTr();
  const wide = useWide();
  const Body = BODIES[s.id as Exclude<SectionId, "account">];
  useCrumb(tr(s.zh, s.en));
  return (
    <SectionForm>
      {!wide && (
        <Link
          to="/settings"
          className="-ml-1 mb-2 inline-flex min-h-11 items-center text-callout text-primary"
          aria-label={tr("返回系统设置", "Back to Settings")}
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
          {tr("系统设置", "Settings")}
        </Link>
      )}
      <header className="mb-5 flex items-start gap-3 pt-1">
        <Tile color={s.tint} size={36}>
          <s.icon />
        </Tile>
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-title2 font-bold tracking-[-0.02em]">
            {tr(s.zh, s.en)}
            {s.owner && <OwnerBadge />}
          </h2>
          <p className="mt-0.5 text-body text-muted-foreground">{tr(...s.desc)}</p>
        </div>
      </header>
      <div className="grid gap-6">
        <Body />
      </div>
    </SectionForm>
  );
}
