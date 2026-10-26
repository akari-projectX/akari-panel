// 系统设置 → 域名与证书 (v2, SET-02…05, SET-09 Cloudflare ranges, SET-27):
// three list cards (main / subscription / node communication) with a count
// and "+ 添加" in the title; each row shows the preferred star, the DNS and
// Cloudflare state (checked from the panel when the page opens and again
// from the row menu) and, for the preferred main domain, the days left on
// the certificate the proxy serves (`/system/status`; per-domain certificate
// dates do not exist). Domains are added in a dialog (purpose, inline format
// errors, a live DNS check, "make preferred"); removal only marks the row
// (undoable) and the save bar lists the impact (typed confirmation). The
// node card carries the gRPC certificate names (removal applies at once,
// confirmed with the servers that still use it). The danger zone holds the
// passkey centre: a dialog for the new name, then the typed confirmation on
// save.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleX,
  Cloud,
  Copy,
  Globe,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Star,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { MenuItem, MenuSeparator, RowMenu } from "../../shared/ui/menu";
import { useToast } from "../../shared/ui/toast";
import { RadioCards } from "../components/inputs";
import { Spin } from "../components/kit";
import {
  DangerRow,
  DangerZone,
  FieldRow,
  Loaded,
  OwnerOnly,
  Panel,
  SRow,
  SwitchRow,
  Warnings,
  domainError,
  lines,
  useDraft,
  useSavePart,
} from "../components/settings-kit";
import { settled, useAction } from "../data";
import { useErrText } from "../kit";
import { fresh, type SettingsView, useSettings } from "./settings-data";

type Kind = "main" | "sub" | "node";
const KINDS: Kind[] = ["main", "sub", "node"];

const kindName = (k: Kind, tr: Tr) =>
  ({
    main: tr("主域名", "Main domains"),
    sub: tr("订阅域名", "Subscription domains"),
    node: tr("节点通信域名", "Node communication domains"),
  })[k];
const kindOne = (k: Kind, tr: Tr) =>
  ({
    main: tr("主域名", "main domain"),
    sub: tr("订阅域名", "subscription domain"),
    node: tr("节点通信域名", "node domain"),
  })[k];

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
            "没有剩下的主域名：邮件、安装与支付链接不可用",
            "No main domain left: mail, install and payment links stop",
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
      return tr(`其他影响：${p.count}`, `Other: ${p.count}`);
  }
}

/** `POST /settings/dns-check`: how the panel resolves a name. */
type DnsCheck = { domain: string; addresses: { ip: string; cloudflare: boolean }[]; level: string; message: string };
type Check = { state: "busy" } | { state: "done"; r: DnsCheck } | { state: "failed"; text: string };

const dnsOk = (r: DnsCheck) => r.addresses.length > 0 && r.level !== "block";
const cfState = (r: DnsCheck): "proxied" | "dns" | null =>
  r.addresses.length === 0 ? null : r.addresses.some((a) => a.cloudflare) ? "proxied" : "dns";

/** The panel's answer in the operator's language (the server's message is Chinese only). */
function checkText(kind: Kind, r: DnsCheck, tr: Tr): string {
  const ips = r.addresses.map((a) => a.ip).join(", ");
  if (!r.addresses.length)
    return tr(
      r.message,
      `${r.domain} does not resolve from the panel. A record added just now may not be live yet; saving is not affected.`,
    );
  const cf = cfState(r) === "proxied";
  if (kind === "node")
    return cf
      ? tr(
          r.message,
          `${r.domain} resolves to Cloudflare (${ips}): the proxy (orange cloud) is on. Agents talk gRPC with mutual TLS to the panel and cannot connect through it; switch the record to DNS only.`,
        )
      : tr(r.message, `${r.domain} resolves to ${ips}, not proxied by Cloudflare: fine for node communication.`);
  if (kind === "sub")
    return cf
      ? tr(r.message, `${r.domain} resolves to Cloudflare (${ips}), proxied.`)
      : tr(
          r.message,
          `${r.domain} resolves to ${ips}, not proxied by Cloudflare. Ignore this if you do not use Cloudflare for subscriptions.`,
        );
  return tr(r.message, `${r.domain} resolves to ${ips}${cf ? " (proxied by Cloudflare)" : ""}.`);
}

type DomainForm = { main: string[]; sub: string[]; node: string[]; perUser: boolean; trust: string };

const domainBase = (d: SettingsView): DomainForm => ({
  main: d.main.domains.map((x) => x.domain),
  sub: d.sub.domains.map((x) => x.domain),
  node: d.node.domains.map((x) => x.domain),
  perUser: d.sub_domain_per_user,
  trust: d.trust_cloudflare.value === null ? "" : String(d.trust_cloudflare.value),
});

type StatusS = { caddy?: { configured: boolean; host: string | null; cert_expires_at: string | null } };

const daysUntil = (iso: string) => Math.floor((Date.parse(iso) - Date.now()) / 86_400_000);

export function DomainsSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <Domains d={d} />}</Loaded>;
}

function Domains({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrText();
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [adding, setAdding] = useState<Kind | null>(null);
  const f = useDraft(domainBase(d));
  const v = f.value!;
  const base = domainBase(d);
  const status = useQuery({
    queryKey: ["system-status"],
    queryFn: () => get<StatusS>("/system/status"),
    staleTime: 60_000,
  }).data;
  const certAt = status?.caddy?.configured ? status.caddy.cert_expires_at : null;
  const certDays = certAt ? daysUntil(certAt) : null;

  const dns = async (kind: Kind, domain: string) => {
    const key = `${kind}:${domain}`;
    setChecks((c) => ({ ...c, [key]: { state: "busy" } }));
    try {
      const r = await post<DnsCheck>("/settings/dns-check", { kind, domain });
      setChecks((c) => ({ ...c, [key]: { state: "done", r } }));
    } catch (e) {
      setChecks((c) => ({ ...c, [key]: { state: "failed", text: errText(e) } }));
    }
  };

  // Check every saved name once when the page opens (the panel resolves them).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    for (const k of KINDS) for (const dom of base[k]) void dns(k, dom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const putDomains = async (force: boolean, hostChange: boolean, removal: boolean): Promise<boolean> => {
    const cur = fresh(qc, ["settings"], d);
    try {
      await put("/settings", {
        version: cur.version,
        main_domains: v.main,
        sub_domains: v.sub,
        node_domains: v.node,
        sub_domain_per_user: v.perUser,
        trust_cloudflare: v.trust === "" ? null : v.trust === "true",
        force_node_cloudflare: force,
        confirm_host_change: hostChange,
        confirm_removal: removal,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "settings.node_domain_cloudflare") {
        const ok = await confirm({
          title: tr("节点通信域名解析到了 Cloudflare", "The node domain resolves to Cloudflare"),
          description: errText(e),
          tone: "warning",
          confirmLabel: tr("仍然保存", "Save anyway"),
        });
        return ok ? putDomains(true, hostChange, removal) : false;
      }
      if (code === "settings.host_gate") {
        const ok = await confirm({
          title: tr("当前地址将被拒绝", "This address will be refused"),
          description: errText(e),
          tone: "warning",
          confirmLabel: tr("确认保存", "Save"),
        });
        return ok ? putDomains(force, true, removal) : false;
      }
      toast({ tone: "error", title: errText(e) });
      return false;
    }
    return true;
  };

  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      let removal = false;
      if (f.isEdited("main") || f.isEdited("sub") || f.isEdited("node") || f.isEdited("perUser")) {
        let impact: Impact;
        try {
          impact = await post<Impact>("/settings/domains/impact", {
            main_domains: v.main,
            sub_domains: v.sub,
            node_domains: v.node,
            sub_domain_per_user: v.perUser,
          });
        } catch (e) {
          toast({ tone: "error", title: errText(e) });
          return false;
        }
        if (impact.removed.length) {
          const names = impact.removed.map((r) => r.domain).join(tr("、", ", "));
          const ok = await confirm({
            title: tr(`移除域名 ${names}？`, `Remove ${names}?`),
            description: tr(
              "保存后这些域名上的请求一律被拒绝，已经发出去的链接随之失效。",
              "Once saved, every request on these names is refused and links already sent out stop working.",
            ),
            impact: tr("以下地方会受影响", "These places are affected"),
            details: (
              <ul className="grid gap-2 text-body">
                {impact.removed.map((r) => (
                  <li key={`${r.kind}:${r.domain}`}>
                    <span className="font-mono font-medium">{r.domain}</span>{" "}
                    <Badge>{kindName(r.kind as Kind, tr)}</Badge>
                    <ul className="mt-1 ml-4 list-disc text-muted-foreground">
                      {r.places.map((p) => (
                        <li key={p.what}>{placeText(p, tr)}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ),
            typeToConfirm: impact.removed[0].domain,
            confirmLabel: tr("移除并保存", "Remove and save"),
          });
          if (!ok) return false;
          removal = true;
        }
      }
      if (!(await putDomains(false, false, removal))) return false;
      await settled();
      toast({ tone: "success", title: tr("域名设置已保存", "Domains saved") });
      f.saved();
      return true;
    },
  });

  /** What a domain serves ("用于 …"). */
  const usedFor = (kind: Kind, dom: string, preferred: boolean): string => {
    if (kind === "main")
      return preferred
        ? tr("门户、后台、邮件与安装链接", "the portal, console, mail and install links")
        : tr("门户与后台", "the portal and console");
    if (kind === "sub")
      return preferred || v.perUser
        ? tr("订阅链接", "subscription links")
        : tr("备用，不出现在链接里", "a spare, not in links");
    const n = d.server_names.find((x) => x.name === dom || x.display === dom || x.name.split(":")[0] === dom)?.nodes
      .length;
    return n
      ? tr(`${n} 台服务器`, `${n} servers`)
      : preferred
        ? tr("新安装的服务器", "newly installed servers")
        : tr("备用", "a spare");
  };

  const hints: Record<Kind, string> = {
    main: tr(
      "门户、后台、安装链接与支付回调使用的域名。首选域名用于邮件链接与安装命令。",
      "Serves the portal, console, install links and payment notices. The preferred one is used in mail links and install commands.",
    ),
    sub: tr(
      "订阅链接只在这些域名上可用（没有时使用主域名）。",
      "Subscription links work on these only (the main domain when empty).",
    ),
    node: tr(
      "agent 通过它连接面板。必须是「仅 DNS」（Cloudflare 灰色云朵），证书域名只增不减。",
      "Agents dial the panel through it. It must be DNS only (never proxied); certificate names only grow.",
    ),
  };

  const card = (kind: Kind) => {
    const items = v[kind];
    // Removed (still saved) names stay listed, struck through, until the save.
    const gone = base[kind].filter((x) => !items.includes(x));
    return (
      <Panel
        key={kind}
        title={
          <>
            {kindName(kind, tr)} <span className="tnum text-faint">{items.length}</span>
          </>
        }
        action={
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            className="-mb-1 text-primary"
            aria-label={tr(`添加${kindOne(kind, tr)}`, `Add a ${kindOne(kind, tr)}`)}
            onClick={() => setAdding(kind)}
          >
            {tr("添加", "Add")}
          </Button>
        }
        footer={hints[kind]}
      >
        <Card className="divide-y divide-separator overflow-hidden">
          {items.length === 0 && gone.length === 0 && (
            <p className="px-4 py-3 text-body text-muted-foreground">
              {kind === "node"
                ? tr("未设置：不能生成安装命令。", "Not set: no install command can be made.")
                : kind === "sub"
                  ? tr("未设置：订阅链接使用主域名。", "Not set: subscription links use the main domain.")
                  : tr(
                      "未设置：门户与后台在任何地址上都可访问。",
                      "Not set: the portal and console answer on any address.",
                    )}
            </p>
          )}
          {items.map((dom, i) => (
            <DomainRow
              key={dom}
              kind={kind}
              dom={dom}
              preferred={i === 0}
              added={!base[kind].includes(dom)}
              check={checks[`${kind}:${dom}`]}
              certDays={kind === "main" && i === 0 && dom === base.main[0] ? certDays : null}
              usedFor={usedFor(kind, dom, i === 0)}
              lockedRemove={i === 0 && items.length > 1}
              onPreferred={() => f.set(kind, [dom, ...items.filter((_, j) => j !== i)])}
              onCheck={() => void dns(kind, dom)}
              onRemove={() =>
                f.set(
                  kind,
                  items.filter((_, j) => j !== i),
                )
              }
            />
          ))}
          {gone.map((dom) => (
            <DomainRow key={`gone:${dom}`} kind={kind} dom={dom} removed onUndo={() => f.set(kind, [...items, dom])} />
          ))}
          {kind === "sub" && (
            <SwitchRow
              label={tr("每个用户随机分配订阅域名", "Random subscription domain per user")}
              description={tr(
                "从上面的列表里给每个用户固定挑一个；某个域名被封时只影响一部分用户",
                "Pins one of the list to each user; a blocked name then affects only some users",
              )}
              changed={f.isEdited("perUser")}
              checked={v.perUser}
              onChange={(x) => f.set("perUser", x)}
            />
          )}
          {kind === "node" && <ServerNames d={d} />}
        </Card>
      </Panel>
    );
  };

  const preferredMain = base.main[0];
  return (
    <OwnerOnly what={tr("域名设置", "the domain settings")}>
      {certDays !== null && certDays <= 14 && (
        <Banner
          tone="danger"
          icon={<ShieldCheck />}
          title={
            certDays < 0
              ? tr(
                  `${status?.caddy?.host ?? preferredMain} 的证书已过期。`,
                  `The certificate of ${status?.caddy?.host ?? preferredMain} has expired.`,
                )
              : tr(
                  `${status?.caddy?.host ?? preferredMain} 的证书 ${certDays} 天后到期。`,
                  `The certificate of ${status?.caddy?.host ?? preferredMain} expires in ${certDays} days.`,
                )
          }
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/status">{tr("查看系统状态", "System status")}</Link>
            </Button>
          }
        >
          {tr(
            `到期时间 ${dateTime(certAt!)}。证书由反向代理自动续期，请检查它的日志与 80/443 端口。`,
            `Expires ${dateTime(certAt!)}. The reverse proxy renews it; check its log and ports 80/443.`,
          )}
        </Banner>
      )}
      <Warnings items={d.warnings} />
      {KINDS.map(card)}
      <CloudflareGroup d={d} trust={v.trust} setTrust={(x) => f.set("trust", x)} trustChanged={f.isEdited("trust")} />
      <PasskeyCentre d={d} />
      {adding && (
        <AddDomainDialog
          initial={adding}
          taken={[...v.main, ...v.sub, ...v.node]}
          onClose={() => setAdding(null)}
          onAdd={(kind, dom, preferred) => {
            const list = v[kind];
            f.set(kind, preferred ? [dom, ...list] : [...list, dom]);
            void dns(kind, dom);
            setAdding(null);
          }}
        />
      )}
    </OwnerOnly>
  );
}

function DomainRow({
  kind,
  dom,
  preferred,
  added,
  removed,
  check,
  certDays,
  usedFor,
  lockedRemove,
  onPreferred,
  onCheck,
  onRemove,
  onUndo,
}: {
  kind: Kind;
  dom: string;
  preferred?: boolean;
  added?: boolean;
  removed?: boolean;
  check?: Check;
  certDays?: number | null;
  usedFor?: string;
  lockedRemove?: boolean;
  onPreferred?: () => void;
  onCheck?: () => void;
  onRemove?: () => void;
  onUndo?: () => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const r = check?.state === "done" ? check.r : null;
  const cf = r ? cfState(r) : null;
  const note =
    check?.state === "failed" ? check.text : r && (r.level !== "ok" || !dnsOk(r)) ? checkText(kind, r, tr) : null;
  return (
    <div className={cn("relative grid gap-1 px-4 py-2.5", removed && "bg-destructive-soft/40")} data-domain={dom}>
      {(removed || added) && (
        <span
          className={cn("absolute inset-y-2 left-0 w-[3px] rounded-r-full", removed ? "bg-destructive" : "bg-primary")}
          data-changed
        />
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span
          className={cn(
            "min-w-0 font-mono text-body font-semibold break-all max-sm:basis-full",
            removed && "text-muted-foreground line-through",
          )}
        >
          {dom}
        </span>
        {preferred && (
          <Badge tone="primary">
            <Star className="fill-current" aria-hidden="true" />
            {tr("首选", "Preferred")}
          </Badge>
        )}
        {added && <Badge tone="primary">{tr("新添加", "New")}</Badge>}
        {removed && <Badge tone="danger">{tr("保存时移除", "Removed on save")}</Badge>}
        <span className="flex-1" />
        {!removed && (
          <>
            {check?.state === "busy" ? (
              <Badge>
                <Spin />
                {tr("检测中", "Checking")}
              </Badge>
            ) : check?.state === "failed" ? (
              <Badge tone="warning">
                <TriangleAlert aria-hidden="true" />
                {tr("未能检测", "Not checked")}
              </Badge>
            ) : r ? (
              !r.addresses.length ? (
                <Badge tone="danger">
                  <CircleX aria-hidden="true" />
                  {tr("无解析", "No DNS")}
                </Badge>
              ) : r.level === "ok" ? (
                <Badge tone="success">
                  <CircleCheck aria-hidden="true" />
                  {tr("DNS 正常", "DNS ok")}
                </Badge>
              ) : (
                <Badge tone={r.level === "block" ? "danger" : "warning"}>
                  <TriangleAlert aria-hidden="true" />
                  {tr("DNS 需确认", "Check DNS")}
                </Badge>
              )
            ) : null}
            {cf && (
              <Badge
                tone={cf === "proxied" ? (kind === "node" ? "danger" : "warning") : "neutral"}
                title={
                  cf === "proxied"
                    ? tr("Cloudflare 代理（橙色云朵）", "Proxied by Cloudflare (orange cloud)")
                    : tr("未经过 Cloudflare 代理", "Not proxied by Cloudflare")
                }
              >
                <Cloud className={cf === "proxied" ? "fill-current" : ""} aria-hidden="true" />
                {cf === "proxied" ? tr("CF 代理", "CF proxied") : tr("仅 DNS", "DNS only")}
              </Badge>
            )}
            {certDays !== null && certDays !== undefined && (
              <Badge tone={certDays <= 14 ? "danger" : certDays <= 30 ? "warning" : "success"}>
                <ShieldCheck aria-hidden="true" />
                {tr(`证书 ${certDays} 天`, `Certificate ${certDays} d`)}
              </Badge>
            )}
          </>
        )}
        {removed ? (
          <Button
            size="sm"
            variant="ghost"
            icon={Undo2}
            aria-label={tr(`撤销移除 ${dom}`, `Undo removing ${dom}`)}
            onClick={onUndo}
          >
            {tr("撤销", "Undo")}
          </Button>
        ) : (
          <RowMenu label={tr(`更多操作 ${dom}`, `More for ${dom}`)}>
            {() => (
              <>
                <MenuItem icon={Star} disabled={preferred} onClick={onPreferred}>
                  {tr("设为首选", "Make preferred")}
                </MenuItem>
                <MenuItem icon={RefreshCw} onClick={onCheck}>
                  {tr("重新检测 DNS", "Check DNS again")}
                </MenuItem>
                <MenuItem
                  icon={Copy}
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(dom)
                      .then(() => toast({ tone: "success", title: tr("已复制", "Copied") }))
                  }
                >
                  {tr("复制域名", "Copy the domain")}
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={X} danger disabled={lockedRemove} onClick={onRemove}>
                  {lockedRemove ? tr("首选不能移除", "The preferred one stays") : tr("移除…", "Remove…")}
                </MenuItem>
              </>
            )}
          </RowMenu>
        )}
      </div>
      {!removed && (
        <div className="flex flex-wrap gap-x-3 text-footnote text-muted-foreground">
          {usedFor && <span>{tr(`用于 ${usedFor}`, `Serves ${usedFor}`)}</span>}
          {note && (
            <span role="status" className={r?.level === "block" ? "text-destructive" : "text-warning"}>
              {note}
            </span>
          )}
          {r && !note && (
            <span role="status" className="sr-only">
              {checkText(kind, r, tr)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** "添加域名": purpose, the name (format checked while typing), a live DNS check, make preferred. */
function AddDomainDialog({
  initial,
  taken,
  onClose,
  onAdd,
}: {
  initial: Kind;
  taken: string[];
  onClose: () => void;
  onAdd: (kind: Kind, dom: string, preferred: boolean) => void;
}) {
  const tr = useTr();
  const errText = useErrText();
  const [kind, setKind] = useState<Kind>(initial);
  const [host, setHost] = useState("");
  const [preferred, setPreferred] = useState(false);
  const [live, setLive] = useState<Check | null>(null);
  const dom = host.trim().toLowerCase();
  const error = !dom
    ? undefined
    : (domainError(dom, tr) ?? (taken.includes(dom) ? tr("这个域名已经在列表里", "Already listed") : undefined));
  const ok = !!dom && !error;

  // Check the name from the panel once it is well formed (debounced).
  useEffect(() => {
    if (!ok) {
      setLive(null);
      return;
    }
    let gone = false;
    setLive({ state: "busy" });
    const t = window.setTimeout(() => {
      post<DnsCheck>("/settings/dns-check", { kind, domain: dom })
        .then((r) => !gone && setLive({ state: "done", r }))
        .catch((e: unknown) => !gone && setLive({ state: "failed", text: errText(e) }));
    }, 500);
    return () => {
      gone = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dom, kind, ok]);

  const r = live?.state === "done" ? live.r : null;
  const cf = r ? cfState(r) : null;
  const line = (good: boolean | null, text: string) => (
    <div className="flex items-start gap-2 text-body">
      {good === null ? (
        <Spin className="mt-0.5" />
      ) : good ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      )}
      <span className="min-w-0">{text}</span>
    </div>
  );
  const prefHint = {
    main: tr("邮件链接与安装命令会改用它", "Mail links and install commands will use it"),
    sub: tr("新生成的订阅链接用它", "New subscription links use it"),
    node: tr("新安装的服务器用它", "Newly installed servers use it"),
  }[kind];
  return (
    <Dialog
      open
      size="md"
      icon={Globe}
      onClose={onClose}
      title={tr("添加域名", "Add a domain")}
      description={tr(
        "添加后在保存栏里保存才生效；主域名与订阅域名的证书在保存后自动申请。",
        "It takes effect once saved in the save bar; certificates for main and subscription domains are requested after the save.",
      )}
      onSubmit={() => ok && onAdd(kind, dom, preferred)}
      footer={
        <>
          {error && <span className="text-footnote text-destructive">{tr("1 处需要修正", "1 thing to fix")}</span>}
          <div className="flex-1" />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok}>
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field group label={tr("用途", "Purpose")}>
          <RadioCards<Kind>
            value={kind}
            onChange={setKind}
            cols={3}
            label={tr("用途", "Purpose")}
            items={[
              { value: "main", title: tr("主域名", "Main domain"), desc: tr("门户与后台", "Portal and console") },
              {
                value: "sub",
                title: tr("订阅域名", "Subscription"),
                desc: tr("只开放订阅链接", "Subscription links only"),
              },
              {
                value: "node",
                title: tr("节点通信", "Node communication"),
                desc: tr("agent 连接面板", "Agents dial the panel"),
              },
            ]}
          />
        </Field>
        <Field
          label={tr("域名", "Domain")}
          error={error}
          hint={tr("不带 https:// 和路径。", "Without https:// or a path.")}
        >
          <Input
            data-autofocus
            className="font-mono"
            placeholder={
              kind === "sub" ? "sub.example.com" : kind === "node" ? "edge.example.com" : "portal.example.com"
            }
            autoCapitalize="off"
            spellCheck={false}
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        {ok && live && (
          <div className="grid gap-2 rounded-lg bg-window p-3 ring-1 ring-border ring-inset" aria-live="polite">
            <div className="text-footnote font-semibold text-muted-foreground">{tr("即时检测", "Live check")}</div>
            {live.state === "busy" && line(null, tr("从面板解析…", "Resolving from the panel…"))}
            {live.state === "failed" && line(false, live.text)}
            {r &&
              (r.addresses.length
                ? line(
                    true,
                    tr(
                      `解析到 ${r.addresses.map((a) => a.ip).join(", ")}`,
                      `Resolves to ${r.addresses.map((a) => a.ip).join(", ")}`,
                    ),
                  )
                : line(false, checkText(kind, r, tr)))}
            {r &&
              cf &&
              (kind === "node"
                ? line(
                    cf === "dns",
                    cf === "dns"
                      ? tr(
                          "未经过 Cloudflare 代理（节点通信必须仅 DNS）",
                          "Not proxied by Cloudflare (node communication must be DNS only)",
                        )
                      : tr(
                          "经过了 Cloudflare 代理：agent 将无法连接，请改为仅 DNS",
                          "Proxied by Cloudflare: agents cannot connect; switch it to DNS only",
                        ),
                  )
                : kind === "sub"
                  ? line(
                      cf === "proxied",
                      cf === "proxied"
                        ? tr("经过 Cloudflare 代理", "Proxied by Cloudflare")
                        : tr(
                            "没有经过 Cloudflare 代理（不用 Cloudflare 可忽略）",
                            "Not proxied by Cloudflare (ignore if you do not use it)",
                          ),
                    )
                  : line(
                      true,
                      cf === "proxied"
                        ? tr("经过 Cloudflare 代理", "Proxied by Cloudflare")
                        : tr("未经过 Cloudflare 代理", "Not proxied by Cloudflare"),
                    ))}
          </div>
        )}
        <label className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-body">
          <Checkbox checked={preferred} onChange={setPreferred} />
          {tr(`设为${kindOne(kind, tr)}的首选`, `Make it the preferred ${kindOne(kind, tr)}`)}
          <span className="text-footnote text-faint">{prefHint}</span>
        </label>
      </div>
    </Dialog>
  );
}

function CloudflareGroup({
  d,
  trust,
  setTrust,
  trustChanged,
}: {
  d: SettingsView;
  trust: string;
  setTrust: (v: string) => void;
  trustChanged: boolean;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const [editing, setEditing] = useState(false);
  const f = useDraft({ ranges: (d.security.cloudflare_ranges ?? []).join("\n") });
  const ranges = lines(f.value!.ranges);
  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/security", {
            version: cur.version,
            audit_retention_days: cur.security.audit_retention_days.value,
            traffic_daily_retention_days: cur.security.traffic_daily_retention_days.value,
            cloudflare_ranges: ranges.length ? ranges : null,
            extra_release_keys: cur.security.extra_release_keys,
          }),
        { ok: tr("Cloudflare 网段已保存", "Cloudflare ranges saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  return (
    <Group
      title="Cloudflare"
      footer={tr(
        "节点通信域名不能走 Cloudflare 代理：mTLS 会被 Cloudflare 终止。",
        "Node communication domains cannot be proxied by Cloudflare: it would terminate the mutual TLS.",
      )}
    >
      <FieldRow
        label={tr("信任 Cloudflare（读取 CF-Connecting-IP）", "Trust Cloudflare (CF-Connecting-IP)")}
        description={tr(
          "只对来自下面网段的请求读取 CF-Connecting-IP；关闭时审计和限流看到的都是 Cloudflare 的地址",
          "CF-Connecting-IP is read only from the ranges below; when off, the audit and rate limits see Cloudflare's addresses",
        )}
        changed={trustChanged}
      >
        {(a) => (
          <Select {...a} className="sm:w-44" value={trust} onChange={(e) => setTrust(e.target.value)}>
            <option value="">
              {tr(
                `默认（${d.trust_cloudflare.effective ? tr("开", "on") : tr("关", "off")}）`,
                `Default (${d.trust_cloudflare.effective ? "on" : "off"})`,
              )}
            </option>
            <option value="true">{tr("开启", "On")}</option>
            <option value="false">{tr("关闭", "Off")}</option>
          </Select>
        )}
      </FieldRow>
      <SRow
        label={tr("Cloudflare 网段", "Cloudflare ranges")}
        changed={f.isEdited("ranges")}
        description={
          ranges.length
            ? tr(
                `自定义 ${ranges.length} 段：${ranges.slice(0, 2).join(tr("、", ", "))}${ranges.length > 2 ? tr(" 等", "…") : ""}`,
                `${ranges.length} custom: ${ranges.slice(0, 2).join(", ")}${ranges.length > 2 ? "…" : ""}`,
              )
            : tr(
                `使用内置的 ${d.security.cloudflare_ranges_shipped} 段`,
                `The ${d.security.cloudflare_ranges_shipped} shipped ranges`,
              )
        }
      >
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          {tr("编辑网段", "Edit ranges")}
        </Button>
      </SRow>
      {editing && (
        <RangesDialog
          value={f.value!.ranges}
          shipped={d.security.cloudflare_ranges_shipped}
          onClose={() => setEditing(false)}
          onDone={(t) => {
            f.set("ranges", lines(t).join("\n"));
            setEditing(false);
          }}
        />
      )}
    </Group>
  );
}

function RangesDialog({
  value,
  shipped,
  onClose,
  onDone,
}: {
  value: string;
  shipped: number;
  onClose: () => void;
  onDone: (t: string) => void;
}) {
  const tr = useTr();
  const [t, setT] = useState(value);
  return (
    <Dialog
      open
      icon={Cloud}
      tone="warning"
      onClose={onClose}
      title={tr("Cloudflare 网段", "Cloudflare ranges")}
      description={tr(
        `每行一个 CIDR；留空 = 使用内置的 ${shipped} 段。只有来自这些网段的请求才读取 CF-Connecting-IP。`,
        `One CIDR per line; empty = the ${shipped} shipped ones. CF-Connecting-IP is read only from these ranges.`,
      )}
      onSubmit={() => onDone(t)}
      footer={
        <>
          <span className="text-footnote text-faint">
            {tr("点「完成」后修改进入保存栏。", "After Done, the change waits in the save bar.")}
          </span>
          <div className="flex-1" />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary">
            {tr("完成", "Done")}
          </Button>
        </>
      }
    >
      <Field label={tr("网段（每行一个）", "Ranges (one per line)")}>
        <Textarea
          data-autofocus
          rows={12}
          className="font-mono text-footnote"
          value={t}
          onChange={(e) => setT(e.target.value)}
        />
      </Field>
    </Dialog>
  );
}

/** SET-05: the names in the panel's gRPC certificate, as chips inside the node card. */
function ServerNames({ d }: { d: SettingsView }) {
  const tr = useTr();
  const confirm = useConfirm();
  if (!d.server_names.length) return null;
  return (
    <div className="px-4 py-2.5">
      <div className="text-body font-medium">{tr("节点通信证书域名", "gRPC certificate names")}</div>
      <div className="mt-0.5 text-footnote text-muted-foreground">
        {tr(
          "面板为 agent 连接签发的证书包含这些名称。只增不减：移除立即生效，先确认没有服务器在用。",
          "The certificate agents see contains these names. They only grow: removal applies at once, so check no server still uses it.",
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {d.server_names.map((n) => (
          <li
            key={n.name}
            className="inline-flex min-h-6 items-center gap-1 rounded-full bg-secondary py-0.5 pr-1 pl-2.5 font-mono text-footnote"
            title={tr(
              `${n.source === "config" ? tr("来自旧配置", "From the old config") : tr("已使用", "Used")} · 首次使用 ${dateTime(n.first_used_at)}${n.nodes.length ? tr(` · ${n.nodes.length} 台服务器在用`, "") : ""}`,
              `${n.source === "config" ? "From the old config" : "Used"} · first used ${dateTime(n.first_used_at)}${n.nodes.length ? ` · used by ${n.nodes.length} servers` : ""}`,
            )}
          >
            {n.display}
            {n.current && (
              <Badge tone="success" className="font-sans">
                {tr("当前", "Current")}
              </Badge>
            )}
            {n.nodes.length > 0 && (
              <span className="font-sans text-faint">{tr(`${n.nodes.length} 台`, `${n.nodes.length}`)}</span>
            )}
            {n.locked ? (
              <span className="w-1" />
            ) : (
              <button
                type="button"
                aria-label={tr(`移除证书域名 ${n.display}`, `Remove ${n.display}`)}
                className="hit-44 inline-flex size-4 items-center justify-center rounded-full text-faint hover:bg-destructive-soft hover:text-destructive"
                onClick={() =>
                  void confirm({
                    title: tr(`从节点证书移除 ${n.display}？`, `Remove ${n.display} from the node certificate?`),
                    description: tr(
                      "立即生效（不经过保存栏）。仍用这个名称连接面板的服务器会在下次重连时失败。",
                      "Applies at once (not through the save bar). Servers still dialling this name fail on their next reconnect.",
                    ),
                    impacts: [
                      {
                        label: tr("仍在用它的服务器", "Servers still using it"),
                        value: n.nodes.length ? n.nodes.map((x) => x.name).join(tr("、", ", ")) : tr("无", "None"),
                      },
                    ],
                    typeToConfirm: n.nodes.length ? n.display : undefined,
                    confirmLabel: tr("移除", "Remove"),
                    action: () => post("/settings/server-names/remove", { name: n.name, confirm: true }),
                  })
                }
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Passkeys = { passkeys: { current: boolean }[] };

/** SET-27: the passkey centre (WebAuthn RP ID); changing it voids every bound passkey. */
function PasskeyCentre({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const [editing, setEditing] = useState(false);
  const mine = useQuery({ queryKey: ["me", "passkeys"], queryFn: () => get<Passkeys>("/me/passkeys") });
  const f = useDraft({ domain: d.passkey.domain ?? "" });
  const next = f.value!.domain;
  const own = mine.data?.passkeys.filter((p) => p.current).length;
  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      if (d.passkey.domain !== null) {
        const ok = await confirm({
          title: next
            ? tr(`把中心域名改为 ${next}？`, `Change the passkey centre to ${next}?`)
            : tr("清除通行密钥中心域名？", "Clear the passkey centre?"),
          description: tr(
            "保存后立即生效，无法撤销。所有用户下次登录时需要用密码登录并重新绑定通行密钥。",
            "Applies at once and cannot be undone. Everyone signs in with a password next time and binds a passkey again.",
          ),
          impacts: [
            {
              label: tr("失效的通行密钥", "Passkeys voided"),
              value: tr("全部账户的通行密钥", "Every account's passkeys"),
            },
            ...(own !== undefined ? [{ label: tr("其中你自己的", "Yours among them"), value: own }] : []),
            {
              label: tr("恢复办法", "Recovery"),
              value: <code className="font-mono text-footnote">akari admin reset-login</code>,
            },
          ],
          typeToConfirm: next || tr("清除", "clear"),
          confirmLabel: tr("更换并使全部通行密钥失效", "Change and void every passkey"),
        });
        if (!ok) return false;
      }
      const cur = fresh(qc, ["settings"], d);
      const r = await run(() => put("/settings/passkey-domain", { version: cur.version, domain: next || null }), {
        ok: tr("通行密钥中心域名已保存", "Passkey centre saved"),
      });
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  const p = d.passkey;
  return (
    <>
      <DangerZone>
        <div className="relative">
          {f.isEdited("domain") && (
            <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" data-changed />
          )}
          <DangerRow
            label={tr("通行密钥中心域名", "Passkey centre")}
            description={
              f.isEdited("domain") ? (
                tr(
                  `将改为 ${next || tr("（清除）", "(cleared)")}，保存时确认。`,
                  `Becomes ${next || "(cleared)"}; confirmed on save.`,
                )
              ) : p.domain ? (
                <>
                  RP ID <code className="font-mono">{p.rp_id ?? "—"}</code> · {tr("中心", "centre")}{" "}
                  <code className="font-mono">{p.domain}</code> ·{" "}
                  {tr(
                    `关联来源 ${p.related_origins.length} 个（注册域 ${p.labels}/${p.label_limit}）`,
                    `${p.related_origins.length} related origins (${p.labels}/${p.label_limit} registrable domains)`,
                  )}
                  {own !== undefined && tr(` · 你有 ${own} 个通行密钥`, ` · you have ${own} passkeys`)}
                  {tr("。更换会让全部通行密钥失效。", ". Changing it voids every passkey.")}
                </>
              ) : (
                tr(
                  "未设置：以首选主域名为准（多个主域名时只有首选的能用通行密钥）。设置后所有主域名共用同一套通行密钥。",
                  "Not set: the preferred main domain is the RP (with several main domains only it can use passkeys). Once set, every main domain shares one set of passkeys.",
                )
              )
            }
            action={
              <Button size="sm" variant="destructive-soft" onClick={() => setEditing(true)}>
                {p.domain ? tr("更换…", "Change…") : tr("设置…", "Set…")}
              </Button>
            }
          />
        </div>
        <DangerRow
          label={tr("移除域名", "Removing a domain")}
          description={tr(
            "在上面的列表里用「⋯ → 移除」标记，保存时会列出影响并要求输入域名确认。首选域名不能直接移除：先把其他域名设为首选。",
            "Mark it with ⋯ → Remove in the lists above; saving lists the impact and asks you to type the domain. The preferred one cannot be removed: make another one preferred first.",
          )}
        />
      </DangerZone>
      {editing && (
        <CentreDialog
          value={next}
          current={p.domain}
          onClose={() => setEditing(false)}
          onDone={(x) => {
            f.set("domain", x);
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

/** Step 1 of changing the passkey centre: the new name (step 2 = the typed confirmation on save). */
function CentreDialog({
  value,
  current,
  onClose,
  onDone,
}: {
  value: string;
  current: string | null;
  onClose: () => void;
  onDone: (v: string) => void;
}) {
  const tr = useTr();
  const [t, setT] = useState(value);
  const dom = t.trim().toLowerCase();
  const error = dom
    ? (domainError(dom, tr) ?? (dom === current ? tr("与当前相同", "Same as now") : undefined))
    : undefined;
  return (
    <Dialog
      open
      size="md"
      tone="danger"
      icon={KeyRound}
      onClose={onClose}
      title={tr("通行密钥中心域名", "Passkey centre")}
      description={tr(
        "通行密钥（WebAuthn）绑定在这个域名上。只在域名彻底弃用时才更换。留空 = 清除。",
        "Passkeys (WebAuthn) are bound to this domain. Change it only when the domain is retired for good. Empty = clear.",
      )}
      onSubmit={() => !error && onDone(dom)}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="destructive" disabled={!!error}>
            {tr("继续…", "Continue…")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {current && (
          <Banner
            tone="danger"
            icon={<TriangleAlert />}
            title={tr("所有通行密钥都会失效。", "Every passkey stops working.")}
          >
            {tr(
              "包括你自己的。开启了「只用通行密钥登录」的账户将无法登录，只能在服务器上执行 akari admin reset-login <邮箱> 恢复。保存时还要再确认一次。",
              "Yours too. Passkey-only accounts cannot sign in until recovered on the server with akari admin reset-login <email>. Saving asks once more.",
            )}
          </Banner>
        )}
        <Field
          label={tr("新的中心域名", "New centre domain")}
          error={error}
          hint={tr(
            "单独的域名，只提供 /.well-known/webauthn；不能与主域名、订阅域名或节点通信域名重复。",
            "A domain of its own serving only /.well-known/webauthn; it cannot be a main, subscription or node domain.",
          )}
        >
          <Input
            data-autofocus
            className="font-mono"
            placeholder="passkey.example.com"
            autoCapitalize="off"
            spellCheck={false}
            value={t}
            onChange={(e) => setT(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
