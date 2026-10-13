// 系统设置 → 订阅 → 分流规则（SET-11，路由 PR 3；交互按定稿样稿
// design/routing-mock，视觉用 v2 kit）：先选模式（规则分流 / 全局代理），
// 按去向分区（拦截 → 直连 → 各服务 → 其余走默认代理），每个分区一个自动
// 识别的输入框（网址 / IP 段 / 分类 / https 规则集链接，规则集添加时由面板
// 下载检查并显示条数）；服务 = 首选线路 + 有序备用（入口、地区组、标签组）、
// 可排序、从常用目录或自定义添加；冲突提示；"这个网站会走哪？"、效果一句
// 话、"用户在 Clash 里看到的"分组预览（都在浏览器里按同一份草稿算）；DNS
// 三档；高级 = 标签组与规则库地址。整份分流一次保存（统一保存栏），服务端
// 错误码落到对应的条目 / 服务 / DNS；"恢复推荐设置"确认后进入草稿。
// 懒加载：只有打开这个分区才下载本文件。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  ChevronDown,
  ChevronUp,
  Compass,
  Globe2,
  House,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError, get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { useLang, useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Segmented, Textarea } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { useAction } from "../data";
import { useErrText } from "../kit";
import {
  ClientPreview,
  EditedBar,
  ItemList,
  LinesEditor,
  RefSelect,
  RouteChips,
  SectionTile,
  Summary,
  TestBox,
  type CheckState,
} from "../components/routing-editor";
import {
  MAX_DNS,
  MAX_RULE_SETS,
  MAX_SERVICES,
  MAX_TAG_GROUPS,
  chainOf,
  conflicts,
  dnsServerOk,
  entranceName,
  itemKey,
  missingEntrances,
  refKey,
  refOf,
  ruleSetLinks,
  sectionsOf,
  serviceName,
  serviceNameError,
  templateError,
  withItems,
  type Catalog,
  type RuleSetCheck,
  type SectionRef,
  type Service,
} from "../components/routing-model";
import {
  DangerRow,
  DangerZone,
  FieldRow,
  Loaded,
  SRow,
  SwitchRow,
  useSavePart,
  type FieldAria,
} from "../components/settings-kit";
import { fresh, useSettings, type Routing, type RoutingItem, type SettingsView } from "./settings-data";

type Draft = { routing: Routing; clash: string; singbox: string };

/** Key-order independent JSON (the server's and the editor's objects compare equal). */
function canon(x: unknown): string {
  return JSON.stringify(x, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
const eq = (a: unknown, b: unknown) => canon(a) === canon(b);

/** How many parts differ (the save bar's "N 项未保存的修改"). */
function diffCount(a: Draft, b: Draft): number {
  let n = 0;
  for (const k of ["mode", "block", "direct", "rest", "tag_groups", "dns"] as const)
    if (!eq(a.routing[k], b.routing[k])) n++;
  if (
    !eq(
      a.routing.services.map((s) => s.key),
      b.routing.services.map((s) => s.key),
    )
  )
    n++;
  for (const s of a.routing.services) {
    const o = b.routing.services.find((x) => x.key === s.key);
    if (o && !eq(s, o)) n++;
  }
  if (a.clash.trim() !== b.clash.trim()) n++;
  if (a.singbox.trim() !== b.singbox.trim()) n++;
  return n;
}

export default function RoutingSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <RoutingForm d={d} />}</Loaded>;
}

function useCatalog() {
  return useQuery({
    queryKey: ["settings", "sub-catalog"],
    queryFn: () => get<Catalog>("/settings/subscription/catalog"),
  });
}

function RoutingForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const lang = useLang();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errText = useErrText();
  const [run] = useAction();
  const catalogQ = useCatalog();
  const catalog = catalogQ.data;
  const base = useMemo<Draft>(
    () => ({
      routing: d.subscription.routing.effective,
      clash: d.subscription.rule_set_clash_url.value ?? "",
      singbox: d.subscription.rule_set_singbox_url.value ?? "",
    }),
    [d],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [srvErr, setSrvErr] = useState<ApiError | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [advanced, setAdvanced] = useState(false);
  const [custom, setCustom] = useState(false);
  const [checks, setChecks] = useState<Record<string, CheckState | undefined>>({});
  const v = draft ?? base;
  const r = v.routing;
  const edit = (f: (x: Draft) => Draft) => {
    setSrvErr(null);
    setDraft((p) => f(p ?? base));
  };
  const setR = (f: (x: Routing) => Routing) => edit((x) => ({ ...x, routing: f(x.routing) }));
  const count = draft ? diffCount(draft, base) : 0;

  const runCheck = async (url: string) => {
    setChecks((c) => ({ ...c, [url]: { state: "checking" } }));
    try {
      const data = await post<RuleSetCheck>("/settings/subscription/rule-set/check", { url });
      setChecks((c) => ({ ...c, [url]: { state: "ok", data } }));
    } catch (e) {
      setChecks((c) => ({
        ...c,
        [url]: { state: "error", text: errText(e), code: e instanceof ApiError ? e.code : "" },
      }));
    }
  };
  const storedOf = (url: string) => catalog?.rule_sets.find((x) => x.url === url);

  // Client-side checks (the server's rules), counted in the save bar.
  const missing = missingEntrances(r, catalog);
  const dnsErr = (list: string[], which: "cn" | "intl") => {
    if (r.dns.mode !== "custom") return undefined;
    if (!list.length)
      return which === "cn"
        ? tr("请至少填写一个国内 DNS", "Enter at least one domestic server")
        : tr("请至少填写一个国外 DNS", "Enter at least one foreign server");
    if (list.length > MAX_DNS) return tr(`最多 ${MAX_DNS} 个`, `At most ${MAX_DNS}`);
    const bad = list.find((x) => !dnsServerOk(x));
    return bad
      ? tr(
          `不是有效的 DNS 服务器：${bad}（填 IP，或 udp://、tls://、https:// 地址）`,
          `Not a DNS server: ${bad} (an IP, or a udp://, tls:// or https:// address)`,
        )
      : undefined;
  };
  const cnErr = dnsErr(r.dns.cn, "cn");
  const intlErr = dnsErr(r.dns.intl, "intl");
  const clashErr = templateError(v.clash, tr);
  const singErr = templateError(v.singbox, tr);
  const links = ruleSetLinks(r);
  const tooManyLinks = links.length > MAX_RULE_SETS;
  const errors =
    missing.size +
    (cnErr ? 1 : 0) +
    (intlErr ? 1 : 0) +
    (clashErr ? 1 : 0) +
    (singErr ? 1 : 0) +
    (tooManyLinks ? 1 : 0);

  // Where the server's error belongs.
  const p = srvErr?.params ?? {};
  const code = srvErr?.code ?? "";
  const srvText = srvErr ? errText(srvErr) : "";
  const itemErr = (sec: SectionRef, index: number, it: RoutingItem): string | undefined => {
    if (!srvErr) return undefined;
    if (code.startsWith("settings.sub_rule_set_") && it.type === "rule_set" && p.url === it.value) return srvText;
    if (code === "settings.sub_rule_invalid" && Number(p.index) === index + 1) {
      const name = sec.kind === "service" ? r.services[sec.index]?.name : sec.kind;
      if (p.section === name) return srvText;
    }
    return undefined;
  };
  const serviceErr = (i: number, s: Service): string | undefined => {
    if (code === "settings.sub_service_invalid" && Number(p.index) === i + 1) return srvText;
    if (code === "settings.sub_service_duplicate" && p.name === s.name) return srvText;
    if (code === "settings.sub_rules_too_many" && p.section === s.name) return srvText;
    return undefined;
  };
  const dnsSrv = code.startsWith("settings.sub_dns_") ? srvText : undefined;

  useSavePart({
    count,
    errors,
    discard: () => {
      setDraft(null);
      setSrvErr(null);
    },
    save: async () => {
      const cur = fresh(qc, ["settings"], d);
      let failed: unknown = null;
      const res = await run(
        () =>
          put("/settings/subscription", {
            version: cur.version,
            routing: r,
            ...(v.clash.trim() !== base.clash.trim() ? { rule_set_clash_url: v.clash.trim() || null } : {}),
            ...(v.singbox.trim() !== base.singbox.trim() ? { rule_set_singbox_url: v.singbox.trim() || null } : {}),
          }).catch((e: unknown) => {
            failed = e;
            throw e;
          }),
        { ok: tr("分流规则已保存", "Routing saved") },
      );
      if (res === undefined) {
        if (failed instanceof ApiError) setSrvErr(failed);
        return false;
      }
      setDraft(null);
      return true;
    },
  });

  const dup = conflicts(r, tr);
  const secs = sectionsOf(r);
  const baseItems = (s: SectionRef) =>
    s.kind === "block"
      ? base.routing.block
      : s.kind === "direct"
        ? base.routing.direct
        : base.routing.services.find((x) => x.key === r.services[s.index]?.key)?.items;
  const list = (s: SectionRef, si: number, title: string) => {
    const items = s.kind === "block" ? r.block : s.kind === "direct" ? r.direct : r.services[s.index].items;
    return (
      <ItemList
        title={title}
        items={items}
        catalog={catalog}
        checks={checks}
        stored={storedOf}
        conflictOf={(it) => dup.get(`${si}|${itemKey(it)}`)}
        errorOf={(i, it) => itemErr(s, i, it)}
        onCheck={(u) => void runCheck(u)}
        onChange={(n, added) => {
          setR((x) => withItems(x, s, n));
          if (added?.type === "rule_set" && !checks[added.value]) void runCheck(added.value);
        }}
      />
    );
  };
  const setService = (i: number, s: Service) =>
    setR((x) => ({ ...x, services: x.services.map((y, j) => (j === i ? s : y)) }));
  const moveService = (i: number, dir: -1 | 1) =>
    setR((x) => {
      const n = [...x.services];
      [n[i], n[i + dir]] = [n[i + dir], n[i]];
      return { ...x, services: n };
    });
  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const addService = (s: Service) => {
    setR((x) => ({ ...x, services: [...x.services, s] }));
    setOpen((o) => new Set(o).add(s.key));
  };
  const unused = (catalog?.services ?? []).filter((c) => !r.services.some((s) => s.key === c.key));
  const global = r.mode === "global";

  const editor = (
    <Card className="divide-y divide-separator overflow-visible" data-routing-editor>
      <div className={cn("divide-y divide-separator", global && "opacity-50")} inert={global || undefined}>
        {secs.map((s, si) => {
          if (s.kind !== "service") {
            const block = s.kind === "block";
            const title = block ? tr("拦截", "Blocked") : tr("直连", "Direct");
            return (
              <section key={s.kind} aria-label={title} className="relative grid gap-2 px-4 py-3">
                {!eq(baseItems(s), block ? r.block : r.direct) && <EditedBar />}
                <div className="flex min-h-9 items-center gap-3">
                  <SectionTile tone={block ? "danger" : "success"}>{block ? <Ban /> : <House />}</SectionTile>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-body font-semibold">
                      {block ? tr("拦截", "Blocked") : tr("直连（不走代理）", "Direct (no proxy)")}
                    </h3>
                    <p className="text-footnote text-muted-foreground">
                      {block
                        ? tr("直接拒绝连接", "Connections are refused")
                        : tr("局域网、国内网站等", "The LAN, domestic sites and the like")}
                    </p>
                  </div>
                </div>
                {list(s, si, title)}
              </section>
            );
          }
          const svc = r.services[s.index];
          const name = serviceName(svc, tr);
          const isOpen = open.has(svc.key);
          const before = base.routing.services.find((x) => x.key === svc.key);
          const sErr = serviceErr(s.index, svc);
          return (
            <section
              key={svc.key}
              aria-label={name}
              data-service={svc.key}
              className={cn("relative grid gap-2 px-4 py-3", sErr && "bg-destructive-soft/40")}
            >
              {!eq(before, svc) && <EditedBar />}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
                  <SectionTile tone="primary">{svc.emoji || <Compass />}</SectionTile>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-body font-semibold">{name}</h3>
                    <div className="flex flex-wrap items-center gap-1 text-footnote text-muted-foreground">
                      {tr("走", "via")}
                      <RouteChips chain={chainOf(svc)} catalog={catalog} />
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    icon={ChevronUp}
                    aria-label={tr(`上移 ${name}`, `Move ${name} up`)}
                    title={tr("上移（优先）", "Up (earlier)")}
                    disabled={s.index === 0}
                    onClick={() => moveService(s.index, -1)}
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    icon={ChevronDown}
                    aria-label={tr(`下移 ${name}`, `Move ${name} down`)}
                    disabled={s.index === r.services.length - 1}
                    onClick={() => moveService(s.index, 1)}
                  />
                  <Button
                    size="sm"
                    variant={isOpen ? "soft" : "secondary"}
                    aria-expanded={isOpen}
                    aria-label={tr(`${name} 的线路`, `${name}: lines`)}
                    onClick={() => toggle(svc.key)}
                  >
                    {isOpen ? tr("收起", "Done") : tr("选择线路", "Lines")}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    icon={Trash2}
                    className="text-faint hover:text-destructive"
                    aria-label={tr(`删除服务 ${name}`, `Remove the service ${name}`)}
                    onClick={() =>
                      void confirm({
                        title: tr(`删除「${name}」分流？`, `Remove the "${name}" service?`),
                        description: tr(
                          "它的网站会改走默认代理；客户端里的这个分组随之消失。保存后才生效。",
                          "Its sites go via the default proxy and the client group disappears. Applies when saved.",
                        ),
                        tone: "warning",
                        confirmLabel: tr("删除", "Remove"),
                      }).then(
                        (ok) => ok && setR((x) => ({ ...x, services: x.services.filter((_, j) => j !== s.index) })),
                      )
                    }
                  />
                </div>
              </div>
              {sErr && (
                <p className="text-footnote text-destructive" role="alert">
                  {sErr}
                </p>
              )}
              {isOpen && <LinesEditor service={svc} catalog={catalog} onChange={(n) => setService(s.index, n)} />}
              {list(s, si, name)}
            </section>
          );
        })}
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
          <span className="mr-1 text-footnote text-muted-foreground">{tr("添加服务分流：", "Add a service:")}</span>
          {unused.map((c) => (
            <Button
              key={c.key}
              size="sm"
              variant="outline"
              disabled={r.services.length >= MAX_SERVICES}
              onClick={() =>
                addService({
                  key: c.key,
                  name: c.name,
                  emoji: c.emoji,
                  items: c.categories.map((x) => ({ type: "category", value: x })),
                  primary: null,
                  backups: [],
                })
              }
            >
              {c.emoji} {serviceName(c, tr)}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            className="text-primary"
            disabled={r.services.length >= MAX_SERVICES}
            onClick={() => setCustom(true)}
          >
            {tr("自定义服务…", "Custom service…")}
          </Button>
        </div>
      </div>
      <section
        aria-label={tr("其余全部", "Everything else")}
        className="relative flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
      >
        {!eq(base.routing.rest, r.rest) && <EditedBar />}
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <SectionTile tone="neutral">
            <Globe2 />
          </SectionTile>
          <div className="min-w-0 flex-1">
            <h3 className="text-body font-semibold">
              {tr("其余全部 → 默认代理", "Everything else → the default proxy")}
            </h3>
            <p className="text-footnote text-muted-foreground">
              {tr(
                "上面都没命中的流量（全局模式下是局域网以外的全部）；用户在客户端里也能切换",
                "Whatever nothing above matched (in global mode: all but the LAN); users can switch it in the client",
              )}
            </p>
          </div>
        </div>
        <RefSelect
          label={tr("默认代理", "Default proxy")}
          value={refKey(r.rest)}
          catalog={catalog}
          withAll
          className="w-full sm:w-64"
          onChange={(k) => setR((x) => ({ ...x, rest: refOf(k) }))}
        />
        {r.rest && "entrance" in r.rest && missing.has(r.rest.entrance) && (
          <p className="basis-full text-footnote text-destructive" role="alert">
            {tr("这条线路已被删除，请重新选择", "This line was deleted: pick another")}
          </p>
        )}
      </section>
    </Card>
  );

  const dnsMode = r.dns.mode;
  const defDns = d.subscription.routing.default.dns;
  const dnsCard = (
    <Group
      title={tr("DNS（域名解析）", "DNS")}
      footer={tr(
        "国内网站与线路（节点）本身的地址用国内 DNS，必须不经代理也能用；其余网站经代理按分流规则查询，避免被污染。",
        "Domestic sites and the lines' own addresses use the domestic servers (they must work without the proxy); other sites are resolved through the proxy by the routing rules, so answers are not poisoned.",
      )}
    >
      <SRow
        label={tr("订阅里的 DNS", "DNS in subscriptions")}
        description={tr("决定客户端用哪个 DNS 查网址", "Which servers the clients resolve names with")}
        changed={!eq(base.routing.dns, r.dns)}
        error={dnsSrv}
        wide
      >
        <Segmented
          label={tr("DNS 下发", "DNS mode")}
          value={dnsMode}
          onChange={(m) =>
            setR((x) => ({
              ...x,
              dns:
                m === "custom" && !x.dns.cn.length && !x.dns.intl.length
                  ? { ...x.dns, mode: m, cn: defDns.cn, intl: defDns.intl }
                  : { ...x.dns, mode: m },
            }))
          }
          options={[
            { value: "recommended", label: tr("推荐（下发）", "Recommended") },
            { value: "client", label: tr("不下发", "Client's own") },
            { value: "custom", label: tr("自定义", "Custom") },
          ]}
        />
      </SRow>
      {dnsMode === "client" && (
        <div className="px-4 py-2.5 text-footnote text-muted-foreground">
          {tr(
            "订阅里不带 DNS 设置，由用户客户端自己的 DNS 设置决定（如 Clash Verge 的「DNS 覆写」）。分流规则照常生效，但国外网站可能被 DNS 污染。",
            "Subscriptions carry no DNS settings: the client's own decide (e.g. Clash Verge's DNS override). Routing still applies, but foreign names may be poisoned.",
          )}
        </div>
      )}
      {dnsMode === "recommended" && (
        <div className="grid gap-2 px-4 py-2.5 text-footnote">
          {(
            [
              [tr("国内 DNS", "Domestic DNS"), defDns.cn],
              [tr("国外 DNS（经代理）", "Foreign DNS (through the proxy)"), defDns.intl],
            ] as const
          ).map(([k, vals]) => (
            <div key={k} className="flex flex-wrap items-center gap-1.5">
              <span className="w-36 text-muted-foreground">{k}</span>
              {vals.map((x) => (
                <code
                  key={x}
                  className="rounded-md bg-window px-1.5 py-px font-mono text-caption ring-1 ring-border ring-inset"
                >
                  {x}
                </code>
              ))}
            </div>
          ))}
          <p className="text-faint">
            {tr(
              "Fake-IP 开启。推荐设置不可编辑；要改请切到「自定义」。",
              "Fake-IP on. The recommended servers are fixed; switch to Custom to change them.",
            )}
          </p>
        </div>
      )}
      {dnsMode === "custom" && (
        <>
          <FieldRow
            stack
            label={tr("国内 DNS", "Domestic DNS")}
            description={tr(
              "每行一个：IP，或 udp://、tls://、https:// 地址。解析国内网站与线路本身的地址（proxy-server-nameserver、nameserver-policy、default-nameserver）。",
              "One per line: an IP, or a udp://, tls:// or https:// address. Resolves domestic sites and the lines' own addresses (proxy-server-nameserver, nameserver-policy, default-nameserver).",
            )}
            error={cnErr}
          >
            {(a) => (
              <ServerList
                aria={a}
                value={r.dns.cn}
                onChange={(l) => setR((x) => ({ ...x, dns: { ...x.dns, cn: l } }))}
              />
            )}
          </FieldRow>
          <FieldRow
            stack
            label={tr("国外 DNS", "Foreign DNS")}
            description={tr(
              "每行一个。解析其余网站，经代理查询（nameserver + respect-rules）。",
              "One per line. Resolves everything else through the proxy (nameserver + respect-rules).",
            )}
            error={intlErr}
          >
            {(a) => (
              <ServerList
                aria={a}
                value={r.dns.intl}
                onChange={(l) => setR((x) => ({ ...x, dns: { ...x.dns, intl: l } }))}
              />
            )}
          </FieldRow>
          <SwitchRow
            label={tr("使用 Fake-IP", "Use Fake-IP")}
            description={tr(
              "推荐：打开网页更快；少数局域网 / 游戏场景可关闭",
              "Recommended: pages open faster; turn it off for some LAN or gaming setups",
            )}
            checked={r.dns.fakeip}
            onChange={(on) => setR((x) => ({ ...x, dns: { ...x.dns, fakeip: on } }))}
          />
        </>
      )}
    </Group>
  );

  const enabledLines = (catalog?.entrances ?? []).filter((e) => e.enabled);
  const tagChoices = [...(catalog?.tags ?? []), ...r.tag_groups.filter((t) => !(catalog?.tags ?? []).includes(t))];
  const advancedBlock = (
    <section className="grid gap-3" aria-label={tr("高级", "Advanced")}>
      <button
        type="button"
        aria-expanded={advanced}
        onClick={() => setAdvanced(!advanced)}
        className="hit-44 inline-flex w-fit items-center gap-1 px-1 text-footnote font-semibold text-muted-foreground hover:text-foreground"
      >
        {advanced ? (
          <ChevronUp className="size-3.5" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-3.5" aria-hidden="true" />
        )}
        {tr("高级：线路分组、规则库地址", "Advanced: line groups, rule list URLs")}
        {(!eq(base.routing.tag_groups, r.tag_groups) || v.clash !== base.clash || v.singbox !== base.singbox) && (
          <Badge tone="primary">{tr("已修改", "Edited")}</Badge>
        )}
        {(clashErr || singErr) && <Badge tone="danger">{tr("需要修正", "Needs fixing")}</Badge>}
      </button>
      {advanced && (
        <>
          <Group
            title={tr("线路分组", "Line groups")}
            footer={tr(
              "地区组按入口所在节点的地区自动生成（组内自动选延迟最低的）；勾选的标签再各生成一组。每个用户只看到自己套餐里有线路的组。",
              "Region groups come from the nodes' regions (each picks its fastest line); each ticked tag gets a group too. Users only see groups with lines in their plan.",
            )}
          >
            <SRow
              label={tr("地区组", "Region groups")}
              description={
                catalog?.regions.length
                  ? tr("自动生成，不用设置", "Automatic")
                  : tr("节点还没有填地区（节点设置里填写）", "No node has a region yet (set it on the node)")
              }
            >
              <span className="flex flex-wrap justify-end gap-1">
                {(catalog?.regions ?? []).map((reg) => (
                  <Badge key={reg} tone="outline">
                    {`🌐 ${reg}`} · {enabledLines.filter((e) => e.region?.trim() === reg).length}
                  </Badge>
                ))}
              </span>
            </SRow>
            <div className="relative grid gap-2 px-4 py-2.5">
              {!eq(base.routing.tag_groups, r.tag_groups) && <EditedBar />}
              <div>
                <div className="text-body font-medium">{tr("标签组", "Tag groups")}</div>
                <div className="mt-0.5 text-footnote text-muted-foreground">
                  {tr(
                    `按入口标签生成分组（如「解锁」= 能看 Netflix 的线路），最多 ${MAX_TAG_GROUPS} 个`,
                    `A group per entrance tag (e.g. lines that unlock Netflix), at most ${MAX_TAG_GROUPS}`,
                  )}
                </div>
              </div>
              {tagChoices.length ? (
                <div className="grid gap-1.5">
                  {tagChoices.map((t) => {
                    const on = r.tag_groups.includes(t);
                    const members = enabledLines.filter((e) => e.tags.includes(t)).map(entranceName);
                    return (
                      <label key={t} className="flex min-w-0 items-start gap-2.5">
                        <span className="mt-0.5">
                          <Checkbox
                            checked={on}
                            label={tr(`标签组 ${t}`, `Tag group ${t}`)}
                            disabled={!on && r.tag_groups.length >= MAX_TAG_GROUPS}
                            onChange={(x) =>
                              setR((y) => ({
                                ...y,
                                tag_groups: x ? [...y.tag_groups, t] : y.tag_groups.filter((z) => z !== t),
                              }))
                            }
                          />
                        </span>
                        <span className="min-w-0 text-body">
                          {`🏷 ${t}`}
                          <span className="ml-1.5 text-footnote text-muted-foreground">
                            {members.length
                              ? members.join(lang === "en" ? ", " : "、")
                              : tr("（没有启用的线路）", "(no enabled lines)")}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="text-footnote text-faint">
                  {tr("入口还没有标签（入口设置里填写）", "No entrance has a tag yet (set it on the entrance)")}
                </p>
              )}
            </div>
          </Group>
          <Group
            title={tr("规则库下载地址", "Rule list URLs")}
            footer={tr(
              "内置分类的清单由用户的客户端自己下载。国内访问 jsDelivr 不稳时可换镜像；须含 {name}，可含 {kind}（geosite / geoip）；留空 = 默认地址。",
              "Clients download the built-in categories' lists themselves. Use a mirror when jsDelivr is unreliable; must contain {name}, may contain {kind} (geosite / geoip); empty = the default.",
            )}
          >
            <FieldRow
              stack
              label={tr("Clash（文本列表）", "Clash (text lists)")}
              description={<span className="font-mono break-all">{d.subscription.rule_set_clash_url.default}</span>}
              error={clashErr}
              changed={v.clash.trim() !== base.clash.trim()}
            >
              {(a) => (
                <Input
                  {...a}
                  className="font-mono text-footnote"
                  value={v.clash}
                  onChange={(e) => edit((x) => ({ ...x, clash: e.target.value }))}
                />
              )}
            </FieldRow>
            <FieldRow
              stack
              label={tr("sing-box（.srs）", "sing-box (.srs)")}
              description={<span className="font-mono break-all">{d.subscription.rule_set_singbox_url.default}</span>}
              error={singErr}
              changed={v.singbox.trim() !== base.singbox.trim()}
            >
              {(a) => (
                <Input
                  {...a}
                  className="font-mono text-footnote"
                  value={v.singbox}
                  onChange={(e) => edit((x) => ({ ...x, singbox: e.target.value }))}
                />
              )}
            </FieldRow>
          </Group>
        </>
      )}
    </section>
  );

  return (
    <div className="@container grid gap-6">
      {srvErr && (
        <Banner tone="danger" icon={<TriangleAlert />} title={tr("没有保存", "Not saved")}>
          {srvText}
        </Banner>
      )}
      {tooManyLinks && (
        <Banner tone="danger" icon={<TriangleAlert />}>
          {tr(
            `远程规则集最多 ${MAX_RULE_SETS} 个（现在 ${links.length} 个）`,
            `At most ${MAX_RULE_SETS} remote rule-sets (now ${links.length})`,
          )}
        </Banner>
      )}
      {missing.size > 0 && (
        <Banner tone="danger" icon={<TriangleAlert />}>
          {tr(
            `${missing.size} 条选中的线路已被删除，请在服务的「选择线路」里重新选择`,
            `${missing.size} selected lines were deleted: pick others in the services' lines`,
          )}
        </Banner>
      )}
      <div className="grid gap-6 @min-[52rem]:grid-cols-[minmax(0,1fr)_17rem] @min-[52rem]:items-start">
        <div className="grid min-w-0 gap-6 @min-[52rem]:col-start-1 @min-[52rem]:row-start-1">
          <Group>
            <SRow
              label={tr("模式", "Mode")}
              description={tr(
                "决定用户导入 Clash / sing-box 订阅后，每个网站走哪条线路。按去向分组，从上到下优先。",
                "Where each site goes once users import a Clash / sing-box subscription. Grouped by destination, first match wins.",
              )}
              changed={base.routing.mode !== r.mode}
              wide
            >
              <Segmented
                label={tr("模式", "Mode")}
                value={r.mode}
                onChange={(m) => setR((x) => ({ ...x, mode: m }))}
                options={[
                  { value: "rules", label: tr("规则分流（推荐）", "Rules (recommended)") },
                  { value: "global", label: tr("全局代理", "Global proxy") },
                ]}
              />
            </SRow>
          </Group>
          {global && (
            <Banner tone="info">
              {tr(
                "全局代理：除局域网外，全部流量走「默认代理」。下面的分流设置保留但暂不生效。",
                "Global proxy: everything but the LAN goes via the default proxy. The routing below is kept but not used.",
              )}
            </Banner>
          )}
          {editor}
        </div>
        {/* Next to the editor on a wide screen; right under it on a narrow one. */}
        <aside
          className="grid gap-4 @min-[52rem]:sticky @min-[52rem]:top-4 @min-[52rem]:col-start-2 @min-[52rem]:row-span-2 @min-[52rem]:row-start-1"
          aria-label={tr("测试与效果", "Test and summary")}
        >
          <TestBox routing={r} catalog={catalog} checks={checks} />
          <Summary routing={r} catalog={catalog} />
        </aside>
        <div className="grid min-w-0 gap-6 @min-[52rem]:col-start-1 @min-[52rem]:row-start-2">
          {dnsCard}
          {advancedBlock}
          <section className="grid gap-1.5" aria-label={tr("用户在 Clash 里看到的", "What users see in Clash")}>
            <h3 className="px-1 text-footnote font-semibold text-muted-foreground">
              {tr("用户在 Clash 里看到的", "What users see in Clash")}
            </h3>
            <p className="px-1 text-footnote text-faint">
              {tr(
                "Clash Verge 的「代理」页大致如此（按全部启用的线路计算）。实际分组按每个用户的套餐生成：只含他能用的线路，首选 / 备用不可用时跳过；线路名以订阅为准。",
                "Roughly Clash Verge's proxies page (computed over every enabled line). Real groups are per user: only the lines their plan grants, unusable primaries / backups skipped; line names as in the subscription.",
              )}
            </p>
            <ClientPreview routing={r} catalog={catalog} />
          </section>
        </div>
      </div>
      <Banner tone="info">
        {tr(
          "修改只影响之后生成的订阅；用户下次刷新订阅时生效。",
          "Changes apply to subscriptions generated afterwards: users get them on their next refresh.",
        )}
      </Banner>
      <DangerZone>
        <DangerRow
          label={tr("恢复推荐设置", "Restore the recommended routing")}
          description={tr(
            "用内置推荐（拦截广告、局域网与国内直连、5 个常用服务、推荐 DNS、默认规则库地址）替换整份分流。进入保存栏，保存前可以放弃。",
            "Replaces the whole routing with the built-in one (ads blocked, LAN and domestic direct, 5 common services, recommended DNS, the default rule list URLs). It goes into the save bar; you can still discard.",
          )}
          action={
            <Button
              size="sm"
              variant="destructive-soft"
              icon={RotateCcw}
              onClick={() =>
                void confirm({
                  title: tr("恢复推荐设置？", "Restore the recommended routing?"),
                  description: tr(
                    "当前的分区、服务、线路与 DNS 会被替换（服务的首选与备用会清空）。恢复后仍需在保存栏点「保存」才生效。",
                    "The current sections, services, lines and DNS are replaced (the services' lines are cleared). Save in the save bar to apply.",
                  ),
                  impacts: [
                    {
                      label: tr("服务分流", "Services"),
                      value: `${r.services.length} → ${d.subscription.routing.default.services.length}`,
                    },
                    {
                      label: tr("拦截 + 直连条目", "Blocked + direct items"),
                      value: `${r.block.length + r.direct.length} → ${d.subscription.routing.default.block.length + d.subscription.routing.default.direct.length}`,
                    },
                  ],
                  tone: "warning",
                  confirmLabel: tr("恢复推荐设置", "Restore"),
                }).then((ok) => ok && edit(() => ({ routing: d.subscription.routing.default, clash: "", singbox: "" })))
              }
            >
              {tr("恢复推荐设置", "Restore")}
            </Button>
          }
        />
      </DangerZone>
      {custom && (
        <CustomService
          taken={r.services.map((s) => s.name)}
          keys={r.services.map((s) => s.key)}
          onClose={() => setCustom(false)}
          onAdd={(s) => {
            addService(s);
            setCustom(false);
          }}
        />
      )}
    </div>
  );
}

const serverList = (raw: string) =>
  raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

/** One server per line: the typed text stays as typed (blank lines while typing), the list is what is saved. */
function ServerList({ aria, value, onChange }: { aria: FieldAria; value: string[]; onChange: (l: string[]) => void }) {
  const [raw, setRaw] = useState(value.join("\n"));
  // A change from elsewhere (discard, restore) replaces the text.
  if (!eq(serverList(raw), value)) setRaw(value.join("\n"));
  return (
    <Textarea
      {...aria}
      rows={2}
      className="font-mono text-footnote"
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(serverList(e.target.value));
      }}
    />
  );
}

function CustomService({
  taken,
  keys,
  onClose,
  onAdd,
}: {
  taken: string[];
  keys: string[];
  onClose: () => void;
  onAdd: (s: Service) => void;
}) {
  const tr = useTr();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("⭐");
  const [shown, setShown] = useState(false);
  const err = serviceNameError(name, taken, tr);
  const emojiErr =
    [...emoji.trim()].length > 8 || /[\s,"\\]/.test(emoji.trim())
      ? tr("最多 8 个字符，不含空格", "At most 8 characters, no spaces")
      : undefined;
  const submit = () => {
    setShown(true);
    if (err || emojiErr) return;
    let key = `custom-${Date.now().toString(36)}`;
    while (keys.includes(key)) key += "x";
    onAdd({ key, name: name.trim(), emoji: emoji.trim(), items: [], primary: null, backups: [] });
  };
  return (
    <Dialog
      open
      size="sm"
      icon={Plus}
      onClose={onClose}
      title={tr("自定义服务", "Custom service")}
      description={tr(
        "客户端里显示为一个分组（例如「游戏加速」）。名字保存后不要常改：客户端按组名记住用户的选择。",
        "Shown as a group in clients (e.g. \"Gaming\"). Avoid renaming it later: clients remember the user's choice by the group's name.",
      )}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary">
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={tr("名称", "Name")} error={shown ? err : undefined}>
          <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setShown(true)} />
        </Field>
        <Field label={tr("图标（emoji，可留空）", "Icon (an emoji, optional)")} error={emojiErr}>
          <Input value={emoji} onChange={(e) => setEmoji(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
