// 系统设置 (SET-*): one tab per area, the tab is the URL
// (/settings/<tab>). This file: the tab shell and 站点与域名 (site name,
// time zone, D8 domain lists with preferred names, DNS checks, removal
// impact, per-user subscription domains, Cloudflare trust, gRPC
// certificate names, obsolete panel.toml keys).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ComponentType } from "react";
import { get, post, put } from "../../shared/api";
import { adminBase } from "../../shared/base";
import { dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Icon } from "../../shared/ui/icons";
import { useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Switch,
} from "../../shared/ui/primitives";
import { FormError, useErrText, useRun } from "../kit";
import { navigate, useRoute } from "../router";
import { SecurityTab } from "./settings-access";
import { MailTab, TemplatesTab } from "./settings-mail";
import { BlockRulesTab, BrandingTab, CleanupTab, NodesTab } from "./settings-misc";
import { PaymentsTab } from "./settings-payments";
import { SignupTab } from "./settings-signup";
import { SubscriptionTab } from "./settings-sub";

export type DomainEntry = { domain: string; display: string; preferred: boolean };
export type SettingsView = {
  version: number;
  main: { domains: DomainEntry[]; effective: string | null };
  sub: { domains: DomainEntry[]; effective: string | null };
  node: { domains: DomainEntry[]; panel_addr: string | null; server_name: string | null; default_port: number };
  sub_domain_per_user: boolean;
  trust_cloudflare: { value: boolean | null; effective: boolean };
  server_names: {
    name: string;
    display: string;
    source: string;
    first_used_at: string;
    current: boolean;
    locked: string | null;
    nodes: { id: string; name: string; reason: string }[];
  }[];
  certificate_names: string[];
  host_gate: boolean;
  site_name: string | null;
  timezone: { value: string | null; effective: string; default: string };
  obsolete_config_keys: string[];
  warnings: string[];
  probe: {
    interval_secs: { value: number | null; effective: number; default: number };
    urls: { value: string[] | null; effective: string[]; default: string[] };
    panel_tcp: { value: boolean | null; effective: boolean; default: boolean };
    manual_cooldown_secs: number;
  };
  node_ops: {
    install_tls_pin: string | null;
    install_fallback_url: string | null;
    install_fallback_effective: string | null;
    install_fallback_default: string;
    acme_directory_url: string | null;
    acme_email: string | null;
    remove_mode: { value: string | null; effective: string };
  };
  security: {
    audit_retention_days: { value: number | null; effective: number; default: number };
    traffic_daily_retention_days: { value: number | null; effective: number; default: number };
    cloudflare_ranges: string[] | null;
    cloudflare_ranges_shipped: number;
    extra_release_keys: string[] | null;
    release_keys: { id: string; label: string; official: boolean }[];
  };
  subscription: {
    rules: { value: Rule[] | null; effective: Rule[]; default: Rule[] };
    rule_set_clash_url: { value: string | null; effective: string; default: string };
    rule_set_singbox_url: { value: string | null; effective: string; default: string };
    formats: { value: string[] | null; effective: string[] };
    import_clients: { value: string[] | null; effective: string[] };
  };
};
export type Rule = { type: string; value: string; action: string };

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsView>("/settings") });
}

type Tab = { id: string; zh: string; en: string; tag?: string; Comp: ComponentType };
const TABS: Tab[] = [
  { id: "site", zh: "站点与域名", en: "Site and domains", tag: "D8", Comp: SiteTab },
  { id: "security", zh: "后台与登录安全", en: "Console and sign-in", tag: "D4/D7", Comp: SecurityTab },
  { id: "subscription", zh: "订阅", en: "Subscriptions", tag: "D11/W30", Comp: SubscriptionTab },
  { id: "signup", zh: "注册与人机验证", en: "Sign-up and bots", tag: "W27", Comp: SignupTab },
  { id: "mail", zh: "邮件", en: "Mail", tag: "W31", Comp: MailTab },
  { id: "templates", zh: "邮件模板", en: "Mail templates", Comp: TemplatesTab },
  { id: "payments", zh: "支付", en: "Payments", Comp: PaymentsTab },
  { id: "nodes", zh: "节点通信与测速", en: "Nodes and probes", Comp: NodesTab },
  { id: "block", zh: "审计规则", en: "Block rules", tag: "W29", Comp: BlockRulesTab },
  { id: "cleanup", zh: "账号清理", en: "Account cleanup", tag: "D10", Comp: CleanupTab },
  { id: "branding", zh: "品牌", en: "Branding", Comp: BrandingTab },
];

export function SettingsPage() {
  const tr = useTr();
  const { sub } = useRoute();
  const tab = TABS.find((t) => t.id === sub[0]) ?? TABS[0];
  const s = useSettings();
  return (
    <>
      <PageHeader title={tr("系统设置", "Settings")} />
      {(s.data?.obsolete_config_keys.length ?? 0) > 0 && (
        <div className="mb-4">
          <Callout tone="warning" title={tr("panel.toml 中有已废弃的键", "panel.toml has obsolete keys")}>
            {tr("这些设置已移到这里，请从 panel.toml 删除：", "These moved here; delete them from panel.toml: ")}
            <code>{s.data?.obsolete_config_keys.join(", ")}</code>
          </Callout>
        </div>
      )}
      <div className="flex flex-col gap-4 lg:flex-row">
        <nav
          aria-label={tr("设置分类", "Settings sections")}
          className="scroll-thin -mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 lg:mx-0 lg:w-56 lg:flex-col lg:px-0"
        >
          {TABS.map((t) => (
            <a
              key={t.id}
              href={`${adminBase}/settings/${t.id}`}
              aria-current={t.id === tab.id ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/settings/${t.id}`);
              }}
              className={`flex shrink-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-[13px] ${t.id === tab.id ? "bg-sidebar-accent font-medium" : "text-muted-foreground hover:bg-muted"}`}
            >
              {tr(t.zh, t.en)}
              {t.tag && <span className="hidden text-[10px] text-muted-foreground lg:inline">{t.tag}</span>}
            </a>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <tab.Comp />
        </div>
      </div>
    </>
  );
}

const KIND_NAME = (k: "main" | "sub" | "node", tr: Tr) =>
  ({
    main: tr("主域名", "Main domains"),
    sub: tr("订阅域名", "Subscription domains"),
    node: tr("节点通信域名", "Node communication domains"),
  })[k];

type Lists = { main: string[]; sub: string[]; node: string[] };
type Impact = {
  removed: {
    kind: string;
    domain: string;
    preferred: boolean;
    places: { what: string; count: number; detail?: string }[];
  }[];
};

function placeText(p: { what: string; count: number; detail?: string }, tr: Tr) {
  switch (p.what) {
    case "portal_console":
      return tr("门户、后台与管理接口不再在此域名上提供", "The portal, console and admin API stop answering on it");
    case "links":
      return p.count
        ? tr("邮件、安装与支付链接改用下一个主域名", "Mail, install and payment links move to the next main domain")
        : tr(
            "没有剩下的主域名：邮件 / 安装 / 支付链接不可用",
            "No main domain left: mail / install / payment links stop",
          );
    case "pending_orders":
      return tr(`${p.count} 个待付订单的支付回调`, `Payment notices of ${p.count} pending orders`);
    case "install_links":
      return tr(`${p.count} 个未使用的安装链接`, `${p.count} unused install links`);
    case "subscription_links":
      return tr(`${p.count} 个用户的订阅链接`, `Subscription links of ${p.count} users`);
    case "nodes":
      return tr(
        `${p.count} 台已注册服务器连接此域名（继续工作）`,
        `${p.count} enrolled servers dial it (they keep working)`,
      );
    default:
      return `${p.what}: ${p.count}${p.detail ? ` (${p.detail})` : ""}`;
  }
}

function SiteTab() {
  const tr = useTr();
  const errText = useErrText();
  const toast = useToast();
  const confirm = useConfirm();
  const s = useSettings();
  const [siteName, setSiteName] = useState<string | null>(null);
  const [tz, setTz] = useState<string | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [perUser, setPerUser] = useState<boolean | null>(null);
  const [trust, setTrust] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [run, busy] = useRun();
  const d = s.data;
  useEffect(() => {
    if (d && !lists)
      setLists({
        main: d.main.domains.map((x) => x.domain),
        sub: d.sub.domains.map((x) => x.domain),
        node: d.node.domains.map((x) => x.domain),
      });
  }, [d, lists]);
  if (!d || !lists) return s.error ? <FormError error={s.error} /> : <Skeleton className="h-96" />;

  const saveSite = () =>
    run(
      () =>
        put("/settings/site", {
          version: d.version,
          site_name: siteName ?? d.site_name,
          timezone: tz ?? d.timezone.value,
        }),
      {
        ok: tr("站点设置已保存", "Site settings saved"),
        invalidate: [["settings"]],
      },
    ).then((r) => {
      if (r !== undefined) {
        setSiteName(null);
        setTz(null);
      }
    });

  const dns = async (kind: string, domain: string) => {
    setChecks((c) => ({ ...c, [`${kind}:${domain}`]: tr("检测中…", "Checking…") }));
    try {
      const v = await post<{ level: string; message: string; addresses: { ip: string; cloudflare?: boolean }[] }>(
        "/settings/dns-check",
        { kind, domain },
      );
      setChecks((c) => ({ ...c, [`${kind}:${domain}`]: `${v.level === "ok" ? "✓" : "⚠"} ${v.message}` }));
    } catch (e) {
      setChecks((c) => ({ ...c, [`${kind}:${domain}`]: errText(e) }));
    }
  };

  const saveDomains = async (force = false, hostChange = false) => {
    const body = {
      version: d.version,
      main_domains: lists.main.filter((x) => x.trim()),
      sub_domains: lists.sub.filter((x) => x.trim()),
      node_domains: lists.node.filter((x) => x.trim()),
      sub_domain_per_user: perUser ?? d.sub_domain_per_user,
      trust_cloudflare: trust === null ? d.trust_cloudflare.value : trust === "" ? null : trust === "true",
      force_node_cloudflare: force,
      confirm_host_change: hostChange,
      confirm_removal: false,
    };
    let impact: Impact;
    try {
      impact = await post<Impact>("/settings/domains/impact", {
        main_domains: body.main_domains,
        sub_domains: body.sub_domains,
        node_domains: body.node_domains,
        sub_domain_per_user: body.sub_domain_per_user,
      });
    } catch (e) {
      return toast({ tone: "error", title: errText(e) });
    }
    if (impact.removed.length) {
      const names = impact.removed.map((r) => r.domain).join(", ");
      const ok = await confirm({
        title: tr(`删除域名 ${names}？`, `Remove ${names}?`),
        impact: tr("以下地方会受影响", "These places are affected"),
        details: (
          <ul className="space-y-2 text-[13px]">
            {impact.removed.map((r) => (
              <li key={`${r.kind}:${r.domain}`}>
                <b>{r.domain}</b> <Badge>{KIND_NAME(r.kind as "main", tr)}</Badge>
                <ul className="ml-4 list-disc text-muted-foreground">
                  {r.places.map((p) => (
                    <li key={p.what}>{placeText(p, tr)}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ),
        typeToConfirm: impact.removed[0].domain,
      });
      if (!ok) return;
      body.confirm_removal = true;
    }
    try {
      await put("/settings", body);
      toast({ tone: "success", title: tr("域名设置已保存", "Domains saved") });
      // Re-read first: the form re-initialises from the fresh values.
      await s.refetch();
      setLists(null);
      setPerUser(null);
      setTrust(null);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "settings.node_domain_cloudflare") {
        if (
          await confirm({
            title: tr("节点域名解析到 Cloudflare", "The node domain resolves to Cloudflare"),
            description: errText(e),
            tone: "warning",
            confirmLabel: tr("仍然保存", "Save anyway"),
          })
        )
          await saveDomains(true, hostChange);
      } else if (code === "settings.host_gate") {
        if (
          await confirm({
            title: tr("当前地址将被拒绝", "This address will be refused"),
            description: errText(e),
            tone: "warning",
            confirmLabel: tr("确认保存", "Save"),
          })
        )
          await saveDomains(force, true);
      } else toast({ tone: "error", title: errText(e) });
    }
  };

  const list = (kind: keyof Lists) => (
    <div className="space-y-2">
      <div className="text-[13px] font-medium">{KIND_NAME(kind, tr)}</div>
      {lists[kind].map((v, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label={tr("设为首选", "Make preferred")}
            title={tr("首选", "Preferred")}
            disabled={i === 0}
            onClick={() => setLists({ ...lists, [kind]: [v, ...lists[kind].filter((_, j) => j !== i)] })}
            className={i === 0 ? "text-warning" : "text-muted-foreground hover:text-warning"}
          >
            <Icon name="star" size={16} fill={i === 0 ? "currentColor" : "none"} />
          </button>
          <Input
            aria-label={`${KIND_NAME(kind, tr)} ${i + 1}`}
            className="h-8 w-full sm:w-72"
            value={v}
            onChange={(e) => setLists({ ...lists, [kind]: lists[kind].map((x, j) => (j === i ? e.target.value : x)) })}
          />
          <Button size="sm" variant="ghost" onClick={() => void dns(kind, v)} disabled={!v.trim()}>
            {tr("DNS 检测", "Check DNS")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            aria-label={tr("移除", "Remove")}
            disabled={i === 0 && lists[kind].length > 1}
            title={
              i === 0 && lists[kind].length > 1
                ? tr("首选域名不能直接删：先把另一个设为首选", "Make another one preferred first")
                : undefined
            }
            onClick={() => setLists({ ...lists, [kind]: lists[kind].filter((_, j) => j !== i) })}
          />
          {checks[`${kind}:${v}`] && (
            <span role="status" className="w-full text-xs text-muted-foreground">
              {checks[`${kind}:${v}`]}
            </span>
          )}
        </div>
      ))}
      <Button size="sm" icon="plus" onClick={() => setLists({ ...lists, [kind]: [...lists[kind], ""] })}>
        {tr("添加", "Add")}
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={tr("站点", "Site")} />
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("站点名称", "Site name")}>
              <Input
                value={siteName ?? d.site_name ?? ""}
                placeholder="Akari"
                onChange={(e) => setSiteName(e.target.value)}
              />
            </Field>
            <Field
              label={tr("站点时区（IANA 名称）", "Site time zone (IANA name)")}
              hint={tr(
                "决定流量明细与审计规则统计的日、套餐月重置、仪表盘与 CSV 的日；从下一次写入起生效。",
                "Sets the day of traffic history and block counts, monthly resets, the dashboard and CSV days; applies from the next write.",
              )}
            >
              <Input
                value={tz ?? d.timezone.value ?? ""}
                placeholder={d.timezone.default}
                list="tz-list"
                onChange={(e) => setTz(e.target.value)}
              />
              <datalist id="tz-list">
                {[
                  "Asia/Shanghai",
                  "Asia/Hong_Kong",
                  "Asia/Tokyo",
                  "Asia/Singapore",
                  "UTC",
                  "Europe/London",
                  "America/New_York",
                  "America/Los_Angeles",
                ].map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
          </div>
          <Button className="mt-3" variant="primary" size="sm" loading={busy} onClick={() => void saveSite()}>
            {tr("保存", "Save")}
          </Button>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title={tr("域名（D8）", "Domains (D8)")}
          description={tr(
            "每类第一个（星标）是首选。主域名提供门户、后台、安装链接与支付回调；订阅域名只提供订阅；节点通信域名只给 agent 的 gRPC（必须灰色云朵，证书域名只增不减）。",
            "The first (starred) of each kind is preferred. Main: portal, console, install and payment links; subscription: subscriptions only; node: the agents' gRPC only (DNS only, never proxied; certificate names only grow).",
          )}
        />
        <CardBody className="space-y-5">
          {list("main")}
          {list("sub")}
          <label className="flex items-center gap-2 text-[13px]">
            <Switch
              checked={perUser ?? d.sub_domain_per_user}
              onChange={setPerUser}
              label={tr("每个用户随机分配订阅域名", "Random subscription domain per user")}
            />
            {tr(
              "每个用户随机分配一个订阅域名（默认关）",
              "Give each user a random subscription domain (off by default)",
            )}
          </label>
          {list("node")}
          <Field label={tr("信任 Cloudflare（读取 CF-Connecting-IP）", "Trust Cloudflare (CF-Connecting-IP)")}>
            <Select
              value={trust ?? (d.trust_cloudflare.value === null ? "" : String(d.trust_cloudflare.value))}
              onChange={(e) => setTrust(e.target.value)}
            >
              <option value="">
                {tr(
                  `默认（${d.trust_cloudflare.effective ? "开" : "关"}）`,
                  `Default (${d.trust_cloudflare.effective ? "on" : "off"})`,
                )}
              </option>
              <option value="true">{tr("开启", "On")}</option>
              <option value="false">{tr("关闭", "Off")}</option>
            </Select>
          </Field>
          {d.warnings.length > 0 && (
            <Callout tone="warning">
              <ul className="list-disc pl-4">
                {d.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
          <Button variant="primary" size="sm" onClick={() => void saveDomains()}>
            {tr("保存域名", "Save domains")}
          </Button>
        </CardBody>
      </Card>
      <ServerNames d={d} />
    </div>
  );
}

function ServerNames({ d }: { d: SettingsView }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const s = useSettings();
  if (!d.server_names.length) return null;
  return (
    <Card>
      <CardHeader
        title={tr("节点通信证书域名", "gRPC certificate names")}
        description={tr(
          "面板 gRPC 证书包含的名字（只增不减；不再使用的可以移除）。",
          "Names in the panel's gRPC certificate (they only grow; unused ones can be removed).",
        )}
      />
      <ul className="divide-y divide-border">
        {d.server_names.map((n) => (
          <li key={n.name} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[13px] sm:px-5">
            <span className="font-mono">{n.display}</span>
            {n.current && <Badge tone="success">{tr("当前", "current")}</Badge>}
            <span className="text-xs text-muted-foreground">
              {n.source} · {dateTime(n.first_used_at)}
              {n.nodes.length ? tr(` · ${n.nodes.length} 台服务器在用`, ` · used by ${n.nodes.length} servers`) : ""}
            </span>
            {!n.locked && (
              <Button
                size="sm"
                variant="destructive-soft"
                className="ml-auto"
                onClick={async () => {
                  const ok = await confirm({
                    title: tr(`移除证书域名 ${n.display}？`, `Remove ${n.display}?`),
                    impact: n.nodes.length
                      ? tr(`${n.nodes.length} 台服务器仍在使用它`, `${n.nodes.length} servers still use it`)
                      : undefined,
                    details: n.nodes.length ? (
                      <ul className="list-disc pl-5 text-[13px]">
                        {n.nodes.map((x) => (
                          <li key={x.id}>
                            {x.name}（{x.reason}）
                          </li>
                        ))}
                      </ul>
                    ) : undefined,
                    action: () => post("/settings/server-names/remove", { name: n.name, confirm: true }),
                  });
                  if (ok) {
                    toast({ tone: "success", title: tr("已移除", "Removed") });
                    void s.refetch();
                  }
                }}
              >
                {tr("移除", "Remove")}
              </Button>
            )}
            {n.locked && <span className="ml-auto text-xs text-muted-foreground">{n.locked}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
