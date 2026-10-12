// An entrance (NOD-15…19, NOD-22/23) in one centred dialog with one save:
// connection (direct or relay settings, tags and egress addresses as chips
// checked as they are added), the D9 time-window multipliers (base, rules
// with time inputs, overlap warnings, a 7×24 heat map with its values, the
// multiplier now), who can see it (node groups → users, estimated from the
// plans), and its traffic and multiplier history; delete for relays with
// the impact listed. Plus the new-relay dialog (from a node, or from the
// page header with a node picker).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { del, get, patch, post, put } from "../../shared/api";
import { bytes, dateTime, daysBefore, rateText, siteToday } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { holdersOf, usePlanList } from "../servers";
import { TrendChart, timeLabels } from "../../shared/ui/charts";
import { SectionTitle, useConfirmFree } from "../kit";
import { useAction } from "../data";
import { entryAsEgress } from "../egress";
import { heatmap, hhmm, overlaps, parseHhmm, parseRate, rateAt, type Rule } from "../rates";
import { useCrumb, useSite } from "../session";
import type { EntranceView, NodeGroup, ServerNode, ServerView } from "../types";
import {
  ChipInput,
  FixCount,
  GroupPicker,
  PORT,
  TagsField,
  addrValues,
  chips,
  entranceState,
  healthText,
  isIpOrCidr,
  num,
  shown,
  tagValues,
  type Chips,
  type NumRule,
} from "./node-common";
import { ArrowRightLeft, Plus, Radar, ShieldCheck, Trash2, TriangleAlert, X } from "lucide-react";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Select, SwitchField } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { ErrorState, LoadingBlock } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";
import { useToast } from "../../shared/ui/toast";
import { cn } from "../../shared/cn";

const WEEKDAYS: [string, string][] = [
  ["一", "Mon"],
  ["二", "Tue"],
  ["三", "Wed"],
  ["四", "Thu"],
  ["五", "Fri"],
  ["六", "Sat"],
  ["日", "Sun"],
];

/** A rule while editing: times from <input type="time"> ("00:00" as an end = midnight). */
type RuleForm = { weekdays: number[]; start: string; end: string; rate: string };

function ruleError(r: RuleForm, tr: Tr): string | undefined {
  const s = parseHhmm(r.start);
  const e = parseHhmm(r.end);
  if (r.weekdays.length === 0) return tr("至少选一天", "Pick at least one day");
  if (s === null || e === null) return tr("请填写开始与结束时间", "Enter the start and end times");
  if (s % 1440 === e % 1440) return tr("开始与结束不能相同", "Start and end must differ");
  if (parseRate(r.rate) === null) return tr("倍率须为 0–100，最多 3 位小数", "Multiplier: 0–100, at most 3 decimals");
  return undefined;
}

function toRule(r: RuleForm): Rule | null {
  const s = parseHhmm(r.start);
  const e = parseHhmm(r.end);
  const rate = parseRate(r.rate);
  if (s === null || e === null || rate === null || r.weekdays.length === 0 || s % 1440 === e % 1440) return null;
  return { weekdays: r.weekdays, start: s % 1440, end: e % 1440, rate };
}

function rulesOf(e: EntranceView): RuleForm[] {
  return e.rate_rules.map((r) => ({
    weekdays: r.weekdays,
    start: hhmm(r.start),
    end: hhmm(r.end % 1440),
    rate: String(r.rate),
  }));
}

function weekdayText(d: number, tr: Tr) {
  return tr(`周${WEEKDAYS[d - 1][0]}`, WEEKDAYS[d - 1][1]);
}

const RATE_REQUIRED: [string, string] = [
  "请填写倍率：0–100，最多 3 位小数（留空不会当作 0）",
  "Enter a multiplier: 0–100, at most 3 decimals (empty is not 0)",
];

/** The relay egress field (edit dialog and new-relay dialog): chips, each checked as it is added. */
function EgressField({
  host,
  value,
  onChange,
  error,
}: {
  host: string;
  value: Chips;
  onChange: (v: Chips) => void;
  error?: string;
}) {
  const tr = useTr();
  const shownError =
    error ??
    (entryAsEgress(host, addrValues(value).join(" "))
      ? tr(
          "连接地址也在出口列表里：中转机的入口 IP 通常不是它的出口 IP，填错会让中转不通。请在最后一跳机器上用 curl -4 ifconfig.me 确认。",
          "The dial address is listed as an egress: a relay's entry IP is usually not its egress IP, and a wrong one breaks the relay. Check with curl -4 ifconfig.me on the last hop.",
        )
      : undefined);
  return (
    <Field
      group
      label={tr("中转机出口 IP / CIDR", "Relay egress IPs / CIDRs")}
      required
      hint={tr(
        "填最后一跳（转发到本节点的那台机器）的出口 IP：在该机器上执行 curl -4 ifconfig.me。不是连接地址；多跳中转只填最后一跳。隔离主要靠独立凭据，白名单是附加防护。",
        "The egress IP of the last hop (the machine that forwards to this node): run curl -4 ifconfig.me on it. Not the dial address; for a multi-hop relay only the last hop. Isolation rests on separate credentials; the allowlist is extra.",
      )}
      error={shownError}
      className="sm:col-span-2"
    >
      <ChipInput
        value={value}
        onChange={onChange}
        label={tr("添加出口 IP / CIDR", "Add an egress IP / CIDR")}
        placeholder={tr("回车添加", "Enter to add")}
        split={/[\s,，]+/}
        invalid={(v) => !isIpOrCidr(v)}
        mono
        chipTone="neutral"
        error={!!shownError}
      />
    </Field>
  );
}

type Form = {
  name: string;
  host: string;
  port: string;
  rate: string;
  enabled: boolean;
  sort: string;
  tags: Chips;
  groups: string[];
  listen: string;
  cidrs: Chips;
};

const SORT: NumRule = { min: -2_147_483_648, max: 2_147_483_647, int: true };

function formOf(e: EntranceView): Form {
  return {
    name: e.name,
    host: e.connect_host ?? "",
    port: e.connect_port ? String(e.connect_port) : "",
    rate: String(e.rate),
    enabled: e.enabled,
    sort: String(e.sort),
    tags: chips(e.tags),
    groups: e.group_ids,
    listen: e.listen_port ? String(e.listen_port) : "",
    cidrs: chips(e.source_cidrs),
  };
}

/** Field errors of the connection form (undefined = fine). */
function formErrors(f: Form, relay: boolean, tr: Tr) {
  const cidrs = addrValues(f.cidrs);
  const badCidr = cidrs.find((c) => !isIpOrCidr(c));
  return {
    name: !f.name.trim() ? tr("请填写名称", "Enter a name") : undefined,
    host: relay && !f.host.trim() ? tr("请填写中转机的地址", "Enter the relay's address") : undefined,
    port: num(f.port, { ...PORT, optional: !relay }, tr)[1],
    listen: relay ? num(f.listen, PORT, tr)[1] : undefined,
    cidrs: !relay
      ? undefined
      : badCidr !== undefined
        ? tr(`「${badCidr}」不是有效的 IP 地址或 CIDR`, `"${badCidr}" is not a valid IP address or CIDR`)
        : cidrs.length === 0
          ? tr("至少填一个出口 IP 或 CIDR", "Enter at least one egress IP or CIDR")
          : undefined,
    sort: num(f.sort, SORT, tr)[1],
    tags: tagValues(f.tags).length > 8 ? "tags" : undefined,
    rate: parseRate(f.rate) === null ? tr(...RATE_REQUIRED) : undefined,
  };
}

/** What the form sends (the PATCH field shapes); only valid forms get here. */
function formBody(f: Form, rate: number, relay: boolean): Record<string, unknown> {
  const n = (t: string) => (t.trim() ? Number(t.trim()) : null);
  const body: Record<string, unknown> = {
    name: f.name.trim(),
    rate,
    enabled: f.enabled,
    sort: n(f.sort) ?? 0,
    tags: tagValues(f.tags),
    group_ids: [...f.groups].sort(),
  };
  if (relay) {
    body.connect_host = f.host.trim();
    body.connect_port = n(f.port);
    body.listen_port = n(f.listen);
    body.source_cidrs = addrValues(f.cidrs);
  } else {
    body.connect_host = f.host.trim() || null;
    body.connect_port = n(f.port);
  }
  return body;
}

function useNameRate(): boolean {
  // The same cache entry as the settings page (["settings"]), without importing it.
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => get<{ subscription?: { name_rate?: boolean } }>("/settings"),
  });
  return q.data?.subscription?.name_rate === true;
}

/** Weekday (0 = Monday) and hour/minute now in the site's time zone. */
function siteNow(tz: string): { wd: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get1 = (t: string) => parts.find((p) => p.type === t)?.value;
  return {
    wd: Math.max(0, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get1("weekday") ?? "Mon")),
    hour: Number(get1("hour") ?? 0),
    minute: Number(get1("minute") ?? 0),
  };
}

type Tab = "conn" | "rate" | "access" | "history";

export function EntranceDialog({
  entrance: e,
  node,
  server,
  groups,
  onClose,
}: {
  entrance: EntranceView;
  node: ServerNode;
  server: ServerView;
  groups: NodeGroup[];
  onClose: () => void;
}) {
  const tr = useTr();
  const lang = useLang();
  const site = useSite();
  const confirm = useConfirm();
  const toast = useToast();
  const confirmFree = useConfirmFree();
  const nameRate = useNameRate();
  const relay = e.kind === "relay";
  useCrumb(e.name);
  // The entrance as the form was opened (or last saved): the baseline of
  // what changed and the version sent back. `e` itself follows the 10 s
  // poll, so diffing against it would resend fields another admin changed.
  const [opened, setOpened] = useState(e);
  const [f, setF] = useState(() => formOf(e));
  const [rules, setRules] = useState<RuleForm[]>(() => rulesOf(e));
  const [savedRules, setSavedRules] = useState<RuleForm[]>(() => rulesOf(e));
  const [tab, setTab] = useState<Tab>("conn");
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const [runRules, busyRules] = useAction();

  const errors = formErrors(f, relay, tr);
  const ruleErrors = rules.map((r) => ruleError(r, tr));
  const connBad = [errors.name, errors.host, errors.port, errors.listen, errors.cidrs, errors.sort, errors.tags].filter(
    Boolean,
  ).length;
  const rateBad = (errors.rate ? 1 : 0) + ruleErrors.filter(Boolean).length;
  const rate = parseRate(f.rate);
  const body = rate === null || connBad ? null : formBody(f, rate, relay);
  const was = formBody(formOf(opened), opened.rate, relay);
  const changed: Record<string, unknown> = {};
  if (body) for (const [k, v] of Object.entries(body)) if (JSON.stringify(v) !== JSON.stringify(was[k])) changed[k] = v;
  const formDirty = JSON.stringify(f) !== JSON.stringify(formOf(opened));
  const rulesDirty = JSON.stringify(rules) !== JSON.stringify(savedRules);

  const valid = rules.map(toRule).filter((r): r is Rule => r !== null);
  const ov = overlaps(valid);
  const base = rate ?? opened.rate;
  const grid = heatmap(base, valid);
  const now = siteNow(site.timezone);
  const nowRate = rateAt(base, valid, now.wd * 1440 + now.hour * 60 + now.minute);
  const max = Math.max(base, ...valid.map((r) => r.rate), 0.001);
  const [h, ht] = healthText(e, tr, lang);
  const [st, stt] = entranceState(e, tr);
  const plans = usePlanList();
  const holders = plans.data ? holdersOf([e.id], groups, plans.data) : null;
  const groupNames = (ids: string[]) =>
    ids
      .map((g) => groups.find((x) => x.id === g)?.name)
      .filter(Boolean)
      .join("、");
  // Egress chips are checked as they are added (the design's inline error); the rest once saved.
  const cidrLive = f.cidrs.items.some((c) => !isIpOrCidr(c)) ? errors.cidrs : undefined;
  const liveBad = tried ? connBad + rateBad : cidrLive ? 1 : 0;

  const save = async () => {
    setTried(true);
    if (connBad) return setTab("conn");
    if (rateBad) return setTab("rate");
    if (!formDirty && !rulesDirty) return toast({ tone: "info", title: tr("没有改动", "Nothing changed") });
    if (Object.keys(changed).length > 0) {
      if (changed.rate === 0 && !(await confirmFree(e.name))) return;
      if (changed.enabled === false) {
        const ok = await confirm({
          title: tr(`停用入口 ${e.name}？`, `Disable ${e.name}?`),
          description: tr(
            "用户会失去这个入口（从节点移除，订阅里不再出现）。",
            "Users lose this entrance (removed from the node and from subscriptions).",
          ),
          tone: "warning",
        });
        if (!ok) return;
      }
      // Only what changed since the form was opened, with the version it was
      // opened at: a stale form never restores old values (409 instead).
      const saved = await run(
        () => patch<EntranceView>(`/entrances/${e.id}`, { ...changed, version: opened.version }),
        {
          ok: tr("入口已保存", "Entrance saved"),
          okDetail:
            changed.rate === undefined
              ? undefined
              : tr(
                  `倍率 ${opened.rate}x → ${rate}x：从下一次结算起生效，不追溯；改动后 30 秒内按两者中较低的倍率结算。`,
                  `Multiplier ${opened.rate}x → ${rate}x: from the next settlement on, not retroactive; for 30 s the lower of the two applies.`,
                ),
        },
      );
      if (!saved) return;
      setOpened(saved);
      setF(formOf(saved));
    } else if (formDirty) setF(formOf(opened));
    if (rulesDirty) {
      const r = await runRules(() =>
        put<{ warnings: string[] }>(`/entrances/${e.id}/rate-rules`, {
          rules: rules.map((x) => ({
            weekdays: x.weekdays,
            start: x.start,
            end: x.end,
            rate: parseRate(x.rate),
          })),
        }),
      );
      if (r) {
        setSavedRules(rules);
        toast({
          tone: r.warnings.length ? "info" : "success",
          title: tr("时段规则已保存（写入审计）", "Rules saved (audited)"),
          description: r.warnings.join("\n") || undefined,
        });
      }
    }
  };
  const remove = async () => {
    // The entrance's billed traffic of the last 30 days (its own rows, never the node's).
    const to = siteToday();
    const billed = await get<{ days: { billed_bytes: number }[] }>(
      `/entrances/${e.id}/traffic?from=${daysBefore(to, 29)}&to=${to}`,
    )
      .then((t) => t.days.reduce((n, d) => n + d.billed_bytes, 0))
      .catch(() => null);
    const names = groupNames(opened.group_ids);
    const ok = await confirm({
      title: tr(`删除中转入口「${e.name}」？`, `Delete relay entrance "${e.name}"?`),
      description: tr(
        "该入口的派生入站与来源白名单会从落地节点上移除，订阅里对应线路立即消失。落地节点本身和直连入口不受影响。",
        "Its derived inbound and source allowlist leave the landing node and its line leaves subscriptions at once. The landing node and its direct entrance are not affected.",
      ),
      impacts: [
        ...(holders === null
          ? []
          : [
              {
                label: tr("可使用该入口的用户（按套餐估算）", "Users who can use it (from the plans)"),
                value: tr(`${holders.toLocaleString()} 人`, holders.toLocaleString()),
              },
            ]),
        { label: tr("所属节点组", "Node groups"), value: names || tr("无", "none") },
        ...(billed === null ? [] : [{ label: tr("近 30 天计费流量", "Billed, last 30 days"), value: bytes(billed) }]),
      ],
      typeToConfirm: e.name,
      confirmLabel: tr("删除入口", "Delete entrance"),
      action: () => del(`/entrances/${e.id}`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("入口已删除", "Entrance deleted") });
      onClose();
    }
  };
  const setRule = (i: number, p: Partial<RuleForm>) => setRules(rules.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const KindIcon = relay ? ArrowRightLeft : ShieldCheck;
  const proto = [node.protocol?.toUpperCase(), node.port ? `:${node.port}` : null].filter(Boolean).join(" · ");

  return (
    <Dialog
      open
      size="lg"
      icon={KindIcon}
      onClose={onClose}
      onSubmit={save}
      dirty={formDirty || rulesDirty}
      title={tr(`编辑入口 · ${e.name}`, `Edit entrance · ${e.name}`)}
      description={
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span>
            {server.name} → {node.display_name || node.name}
            {proto ? tr(`（${proto}）`, ` (${proto})`) : ""}
          </span>
          <span aria-hidden="true">·</span>
          <span>{relay ? tr("中转入口", "Relay entrance") : tr("直连入口", "Direct entrance")}</span>
          <span aria-hidden="true">·</span>
          <span className="tnum">
            {tr("当前倍率", "Now")} {rateText(Math.round(e.rate_now * 1000))}
          </span>
          <Badge tone={stt === "danger" ? "outline" : stt}>{st}</Badge>
        </span>
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          label={tr("入口", "Entrance")}
          tabs={[
            { value: "conn", label: tr("连接", "Connection") },
            { value: "rate", label: tr("倍率与时段", "Multipliers"), count: rules.length || undefined },
            { value: "access", label: tr("可见范围", "Visibility") },
            { value: "history", label: tr("流量与记录", "Traffic and history") },
          ]}
        />
      }
      footer={
        <>
          {relay && (
            <Button variant="destructive-soft" icon={Trash2} onClick={remove} className="mr-auto">
              {tr("删除入口", "Delete entrance")}
            </Button>
          )}
          {liveBad > 0 ? (
            <FixCount n={liveBad} />
          ) : (
            (formDirty || rulesDirty) && (
              <span className="mr-auto text-footnote text-muted-foreground max-sm:hidden sm:mr-1">
                {tr("有未保存的修改", "Unsaved changes")}
              </span>
            )
          )}
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy || busyRules}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      {e.hidden_since && (
        <Callout
          className="mb-4"
          tone="danger"
          title={tr("探测失败，已从订阅隐藏", "Probe failing; hidden from subscriptions")}
        >
          {tr(
            `自 ${dateTime(e.hidden_since)}，连续失败 ${e.health_failures} 次。已发告警，恢复后自动显示。`,
            `Since ${dateTime(e.hidden_since)}, ${e.health_failures} failures in a row. Alerted; it comes back automatically.`,
          )}
          {e.health_error && (
            <details className="mt-1">
              <summary className="cursor-pointer text-footnote text-muted-foreground">
                {tr("探测错误", "Probe error")}
              </summary>
              <p className="font-mono text-caption break-all">{e.health_error}</p>
            </details>
          )}
        </Callout>
      )}
      {tab === "conn" && (
        <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
          <Field
            label={tr("入口名称", "Entrance name")}
            required
            error={tried ? errors.name : undefined}
            hint={tr("订阅里的线路名，倍率会自动附加", "The line name in subscriptions; the multiplier is appended")}
          >
            <Input value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} />
          </Field>
          <TagsField value={f.tags} onChange={(v) => setF({ ...f, tags: v })} />
          <Field
            label={
              relay
                ? tr("连接地址", "Dial host")
                : tr("连接地址（留空 = 服务器域名）", "Dial host (empty = server domain)")
            }
            required={relay}
            error={tried ? errors.host : undefined}
            hint={
              relay
                ? tr("中转机的域名或 IP（用户连接到这里）", "The relay's domain or IP (users connect here)")
                : undefined
            }
          >
            <Input
              value={f.host}
              className="font-mono"
              placeholder={relay ? "" : (server.tls_domain ?? "")}
              onChange={(x) => setF({ ...f, host: x.target.value })}
            />
          </Field>
          <Field
            label={relay ? tr("端口", "Port") : tr("连接端口（留空 = 入站端口）", "Dial port (empty = inbound's)")}
            required={relay}
            error={shown(f.port, errors.port, tried)}
          >
            <Input
              inputMode="numeric"
              className="tnum"
              value={f.port}
              placeholder={relay ? "" : String(node.port ?? "")}
              onChange={(x) => setF({ ...f, port: x.target.value })}
            />
          </Field>
          {relay && (
            <>
              <EgressField
                host={f.host}
                value={f.cidrs}
                onChange={(v) => setF({ ...f, cidrs: v })}
                error={tried ? errors.cidrs : cidrLive}
              />
              <Field
                label={tr("监听端口（节点上的派生入站）", "Listen port (derived inbound on the node)")}
                required
                error={shown(f.listen, errors.listen, tried)}
              >
                <Input
                  inputMode="numeric"
                  className="tnum"
                  value={f.listen}
                  onChange={(x) => setF({ ...f, listen: x.target.value })}
                />
              </Field>
            </>
          )}
          <Field label={tr("排序", "Sort")} error={shown(f.sort, errors.sort, tried)}>
            <Input
              inputMode="numeric"
              className="tnum"
              value={f.sort}
              onChange={(x) => setF({ ...f, sort: x.target.value })}
            />
          </Field>
          <SwitchField
            className="rounded-xl bg-window px-4 py-3 ring-1 ring-border ring-inset sm:col-span-2"
            checked={f.enabled}
            onChange={(v) => setF({ ...f, enabled: v })}
            label={tr("启用入口", "Entrance enabled")}
            description={tr(
              "关闭后不下发、订阅中隐藏；入口的设置保留。",
              "A disabled entrance is not served and leaves subscriptions; its settings are kept.",
            )}
          />
          {relay && e.health_at && (
            <div
              className={cn(
                "flex items-center gap-3 rounded-xl px-4 py-2.5 text-footnote sm:col-span-2",
                e.health_ok ? "bg-success-soft" : "bg-destructive-soft",
              )}
            >
              <Radar
                className={cn("size-4 shrink-0", e.health_ok ? "text-success" : "text-destructive")}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                {tr(
                  `健康检查：面板 → ${opened.connect_host ?? ""}:${opened.connect_port ?? ""} TCP ${e.health_ok ? "正常" : "失败"}（${h}）`,
                  `Health check: panel → ${opened.connect_host ?? ""}:${opened.connect_port ?? ""} TCP ${e.health_ok ? "ok" : "failed"} (${h})`,
                )}
              </span>
              <Badge tone={ht} className="max-sm:hidden">
                {dateTime(e.health_at)}
              </Badge>
            </div>
          )}
        </div>
      )}
      {tab === "rate" && (
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            <Field
              label={tr("基础倍率（0–100）", "Base multiplier (0–100)")}
              required
              error={shown(f.rate, errors.rate, tried)}
              hint={
                nameRate
                  ? tr(
                      "已开启「订阅线路名显示倍率」：改倍率会改变线路名，客户端刷新订阅后可能切换线路。",
                      "Multipliers in line names is on: a change renames the line; clients may switch lines after a refresh.",
                    )
                  : tr("0 = 免费，需二次确认", "0 = free; you confirm before it is saved")
              }
            >
              <Input
                inputMode="decimal"
                className="tnum"
                value={f.rate}
                onChange={(x) => setF({ ...f, rate: x.target.value })}
              />
            </Field>
            <div className="flex flex-wrap items-end gap-3 rounded-xl bg-window px-4 py-3 ring-1 ring-border ring-inset">
              <div className="min-w-0 flex-1">
                <div className="text-footnote text-muted-foreground">
                  {tr(
                    `此刻生效（${weekdayText(now.wd + 1, tr)} ${hhmm(now.hour * 60 + now.minute)}，${site.timezone}，按当前编辑的规则）`,
                    `Now (${weekdayText(now.wd + 1, tr)} ${hhmm(now.hour * 60 + now.minute)}, ${site.timezone}, with these rules)`,
                  )}
                </div>
                <div className="tnum text-title2 font-semibold">{nowRate}x</div>
              </div>
              {ov.length > 0 && (
                <Badge tone="warning" className="whitespace-normal">
                  <TriangleAlert aria-hidden="true" />
                  {tr(`${ov.length} 处时段重叠，取最高`, `${ov.length} overlaps; the highest applies`)}
                </Badge>
              )}
            </div>
          </div>
          <div className="grid gap-2">
            <SectionTitle
              actions={
                <Button
                  size="sm"
                  variant="soft"
                  icon={Plus}
                  onClick={() =>
                    setRules([...rules, { weekdays: [1, 2, 3, 4, 5], start: "20:00", end: "00:00", rate: "2" }])
                  }
                  disabled={rules.length >= 24}
                >
                  {tr("添加规则", "Add rule")}
                </Button>
              }
            >
              {tr(`时段倍率（${site.timezone}）`, `Time-window multipliers (${site.timezone})`)}
            </SectionTitle>
            <p className="text-footnote text-muted-foreground">
              {tr(
                "规则外按基础倍率；结束早于开始 = 跨午夜，结束 00:00 = 当天 24:00；重叠时取最高。",
                "Outside every rule the base applies; an end before the start crosses midnight, an end of 00:00 is 24:00; overlaps take the highest.",
              )}
            </p>
            {rules.length === 0 && (
              <p className="text-body text-muted-foreground">{tr("没有时段规则。", "No time-window rules.")}</p>
            )}
            <ul className="grid gap-2">
              {rules.map((r, i) => {
                const err = ruleErrors[i];
                const inOverlap = ov.some((o) => o.a === i || o.b === i);
                return (
                  <li
                    key={i}
                    data-rule={i}
                    className={cn(
                      "rounded-xl p-3 ring-1 ring-inset",
                      inOverlap
                        ? "bg-warning-soft ring-[color-mix(in_srgb,var(--warning)_30%,transparent)]"
                        : tried && err
                          ? "bg-card ring-destructive"
                          : "bg-card ring-border",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="tnum text-footnote font-semibold text-muted-foreground">
                        {tr(`规则 ${i + 1}`, `Rule ${i + 1}`)}
                      </span>
                      <div className="flex gap-1">
                        {WEEKDAYS.map((_, d) => {
                          const on = r.weekdays.includes(d + 1);
                          return (
                            <button
                              key={d}
                              type="button"
                              aria-pressed={on}
                              aria-label={tr(
                                `规则 ${i + 1} ${weekdayText(d + 1, tr)}`,
                                `Rule ${i + 1} ${weekdayText(d + 1, tr)}`,
                              )}
                              onClick={() =>
                                setRule(i, {
                                  weekdays: on ? r.weekdays.filter((w) => w !== d + 1) : [...r.weekdays, d + 1].sort(),
                                })
                              }
                              className={cn(
                                "hit-44 inline-flex size-7 items-center justify-center rounded-full text-footnote font-medium transition-colors",
                                on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
                              )}
                            >
                              {lang === "zh" ? WEEKDAYS[d][0] : WEEKDAYS[d][1].slice(0, 2)}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          type="time"
                          step={60}
                          aria-label={tr(`规则 ${i + 1} 开始`, `Rule ${i + 1} start`)}
                          className="tnum w-28"
                          value={r.start}
                          onChange={(x) => setRule(i, { start: x.target.value })}
                        />
                        <span className="text-muted-foreground">{tr("至", "to")}</span>
                        <Input
                          type="time"
                          step={60}
                          aria-label={tr(`规则 ${i + 1} 结束`, `Rule ${i + 1} end`)}
                          className="tnum w-28"
                          value={r.end}
                          onChange={(x) => setRule(i, { end: x.target.value })}
                        />
                        <Input
                          aria-label={tr(`规则 ${i + 1} 倍率`, `Rule ${i + 1} multiplier`)}
                          inputMode="decimal"
                          className="tnum w-16"
                          value={r.rate}
                          onChange={(x) => setRule(i, { rate: x.target.value })}
                        />
                        <span className="text-muted-foreground">x</span>
                      </div>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        icon={X}
                        className="ml-auto"
                        aria-label={tr("删除规则", "Remove rule")}
                        onClick={() => setRules(rules.filter((_, j) => j !== i))}
                      />
                    </div>
                    {(tried || r.start === "" || r.end === "") && err && (
                      <p className="mt-1.5 text-footnote text-destructive">{err}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          {ov.length > 0 && (
            <div role="status">
              <Callout tone="warning">
                {ov.map((o) => (
                  <div key={`${o.a}-${o.b}`}>
                    {tr(
                      `规则 ${o.a + 1} 与规则 ${o.b + 1} 在${weekdayText(Math.floor(o.at / 1440) + 1, tr)} ${hhmm(o.at % 1440)} 起重叠，取最高 ${o.rate}x`,
                      `Rules ${o.a + 1} and ${o.b + 1} overlap from ${weekdayText(Math.floor(o.at / 1440) + 1, tr)} ${hhmm(o.at % 1440)}; the highest ${o.rate}x applies`,
                    )}
                  </div>
                ))}
              </Callout>
            </div>
          )}
          <Heatmap grid={grid} max={max} now={now} />
        </div>
      )}
      {tab === "access" && (
        <div className="grid gap-4">
          <GroupPicker groups={groups} value={f.groups} onChange={(g) => setF({ ...f, groups: g })} />
          <div className="rounded-xl bg-window px-4 py-3 text-body ring-1 ring-border ring-inset">
            {f.groups.length === 0 ? (
              <span className="text-muted-foreground">
                {tr("不在任何节点组里：没有用户能用这个入口。", "In no node group: nobody can use this entrance.")}
              </span>
            ) : (
              <span>
                {tr(`节点组：${groupNames(f.groups)}`, `Node groups: ${groupNames(f.groups)}`)}
                {holders !== null && sameGroups(f.groups, opened.group_ids) && (
                  <span className="text-muted-foreground">
                    {tr(
                      ` → 约 ${holders.toLocaleString()} 名用户可用（按套餐当前的节点组估算）`,
                      ` → about ${holders.toLocaleString()} users (estimated from the plans' current groups)`,
                    )}
                  </span>
                )}
              </span>
            )}
          </div>
          <p className="text-footnote text-muted-foreground">
            {tr(
              "权限只来自 套餐 → 节点组 → 入口；改动保存后立即生效。",
              "Access comes only from plan → node group → entrance; a change applies once saved.",
            )}
          </p>
        </div>
      )}
      {tab === "history" && <EntranceHistory id={e.id} />}
    </Dialog>
  );
}

const sameGroups = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

/** 7 × 24 multipliers, each cell with its value (not only a tooltip); this hour outlined. */
function Heatmap({ grid, max, now }: { grid: number[][]; max: number; now: { wd: number; hour: number } }) {
  const tr = useTr();
  const text = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(v * 10 === Math.round(v * 10) ? 1 : 2));
  return (
    <div className="scroll-thin overflow-x-auto">
      <table
        className="border-separate border-spacing-0.5 text-caption"
        aria-label={tr("一周 7×24 倍率热力图", "Week heatmap 7×24")}
      >
        <thead>
          <tr>
            <th className="sr-only">{tr("星期", "Day")}</th>
            {Array.from({ length: 24 }, (_, i) => (
              <th key={i} scope="col" className="tnum font-normal text-muted-foreground">
                {i}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, d) => (
            <tr key={d}>
              <th scope="row" className="pr-1.5 text-right font-normal whitespace-nowrap text-muted-foreground">
                {weekdayText(d + 1, tr)}
              </th>
              {row.map((v, hIdx) => (
                <td
                  key={hIdx}
                  title={`${weekdayText(d + 1, tr)} ${hIdx}:00 · ${v}x`}
                  className={cn(
                    "tnum h-7 min-w-7 rounded-[5px] px-0.5 text-center text-foreground",
                    d === now.wd && hIdx === now.hour && "ring-2 ring-foreground ring-inset",
                  )}
                  style={{
                    backgroundColor: `color-mix(in oklch, var(--chart-1) ${Math.round((v / max) * 50) + 6}%, transparent)`,
                  }}
                >
                  {text(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type RateChange = {
  at: string;
  actor_label: string;
  actor_email: string | null;
  action: "entrance.create" | "entrance.update" | "entrance.rate_rules.set";
  rate_before: number | null;
  rate_after: number | null;
  rules_before: { rate: number }[] | null;
  rules_after: { rate: number }[] | null;
};

// NOD-22/23: the entrance's own daily raw / billed (never summed with the
// node's other entrances) and its multiplier changes from the audit log.
function EntranceHistory({ id }: { id: string }) {
  const tr = useTr();
  const to = siteToday();
  const from = daysBefore(to, 29);
  const q = useQuery({
    queryKey: ["traffic", "entrance", id],
    queryFn: () =>
      get<{
        days: { day: string; up_bytes: number; down_bytes: number; billed_bytes: number }[];
        rate_changes: RateChange[];
      }>(`/entrances/${id}/traffic?from=${from}&to=${to}`),
  });
  if (q.isError) return <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isPending) return <LoadingBlock rows={6} />;
  const all: string[] = [];
  for (let i = 29; i >= 0; i--) all.push(daysBefore(to, i));
  const by = new Map(q.data.days.map((r) => [r.day, r]));
  const times = all.map((d) => `${d}T12:00:00Z`);
  const rules = (r: { rate: number }[] | null) =>
    r && r.length ? r.map((x) => `${x.rate}x`).join(" / ") : tr("无规则", "no rules");
  const what = (c: RateChange) =>
    c.action === "entrance.rate_rules.set"
      ? tr(
          `时段规则 ${rules(c.rules_before)} → ${rules(c.rules_after)}`,
          `Rules ${rules(c.rules_before)} → ${rules(c.rules_after)}`,
        )
      : c.action === "entrance.create"
        ? tr(`创建 ${c.rate_after}x`, `Created at ${c.rate_after}x`)
        : `${c.rate_before}x → ${c.rate_after}x`;
  return (
    <>
      <SectionTitle>{tr("入口流量（近 30 天）", "Entrance traffic (30 days)")}</SectionTitle>
      <TrendChart
        title={tr("每日原始 / 计费（站点时区）", "Daily raw / billed (site days)")}
        times={times}
        {...timeLabels(times)}
        format={bytes}
        series={[
          {
            label: tr("原始", "Raw"),
            values: all.map((d) => (by.get(d)?.up_bytes ?? 0) + (by.get(d)?.down_bytes ?? 0)),
            slot: 1,
          },
          { label: tr("计费", "Billed"), values: all.map((d) => by.get(d)?.billed_bytes ?? 0), slot: 4 },
        ]}
      />
      {q.data.days.length > 0 && (
        <ul
          className="mt-2 max-h-48 divide-y divide-separator overflow-y-auto rounded-lg text-body ring-1 ring-border ring-inset"
          aria-label={tr("每日流量", "Daily traffic")}
        >
          {[...q.data.days].reverse().map((d) => (
            <li key={d.day} className="flex flex-wrap justify-between gap-x-3 px-3 py-2">
              <span className="tnum">{d.day}</span>
              <span className="tnum text-muted-foreground">
                {tr("原始", "raw")} {bytes(d.up_bytes + d.down_bytes)} · {tr("计费", "billed")} {bytes(d.billed_bytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <SectionTitle>{tr("倍率变更记录", "Multiplier history")}</SectionTitle>
      {q.data.rate_changes.length === 0 ? (
        <p className="text-body text-muted-foreground">
          {tr("审计日志里没有倍率变更", "No multiplier changes in the audit log")}
        </p>
      ) : (
        <ul
          className="divide-y divide-separator rounded-lg text-body ring-1 ring-border ring-inset"
          aria-label={tr("倍率变更记录", "Multiplier history")}
        >
          {q.data.rate_changes.map((c, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-x-3 px-3 py-2">
              <span>{what(c)}</span>
              <span className="text-footnote text-muted-foreground">
                {dateTime(c.at)} · {c.actor_email ?? c.actor_label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function RelayDialog({
  node: given,
  servers,
  groups,
  onClose,
}: {
  /** The landing node (from its row menu); else picked from `servers` (page header). */
  node?: ServerNode;
  servers?: ServerView[];
  groups: NodeGroup[];
  onClose: () => void;
}) {
  const tr = useTr();
  const choices = (servers ?? []).filter((s) => !s.deleting_at).flatMap((s) => s.nodes.map((n) => ({ s, n })));
  const [nodeId, setNodeId] = useState(given?.id ?? choices[0]?.n.id ?? "");
  const node = given ?? choices.find((c) => c.n.id === nodeId)?.n;
  const [f, setF] = useState<Form>({
    name: "",
    host: "",
    port: "",
    listen: "",
    cidrs: chips([]),
    rate: "1",
    tags: chips([]),
    groups: [],
    enabled: true,
    sort: "0",
  });
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const confirmFree = useConfirmFree();
  const errors = formErrors(f, true, tr);
  const cidrLive = f.cidrs.items.some((c) => !isIpOrCidr(c)) ? errors.cidrs : undefined;
  const bad = Object.values(errors).filter(Boolean).length + (node ? 0 : 1);
  const submit = async () => {
    setTried(true);
    const rate = parseRate(f.rate);
    if (bad || rate === null || !node) return;
    if (rate === 0 && !(await confirmFree(f.name.trim()))) return;
    const b = formBody(f, rate, true);
    const r = await run(
      () =>
        post(`/nodes/${node.id}/entrances`, {
          name: b.name,
          connect_host: b.connect_host,
          connect_port: b.connect_port,
          listen_port: b.listen_port,
          source_cidrs: b.source_cidrs,
          rate,
          tags: b.tags,
          group_ids: f.groups,
        }),
      { ok: tr("中转入口已添加", "Relay entrance added") },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="lg"
      icon={ArrowRightLeft}
      onClose={onClose}
      title={
        given
          ? tr(
              `添加中转入口 · ${given.display_name || given.name}`,
              `Add relay entrance · ${given.display_name || given.name}`,
            )
          : tr("添加中转入口", "Add relay entrance")
      }
      description={tr(
        "外部中转转发到节点上的派生入站（同协议同参数、独立凭据），只接受中转机出口的新连接。",
        "An external relay forwards to a derived inbound on the node (same protocol, own credentials) that only accepts the relay's egress.",
      )}
      onSubmit={submit}
      footer={
        <>
          <FixCount n={tried ? bad : cidrLive ? 1 : 0} />
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
        {!given && (
          <Field
            label={tr("落地节点", "Landing node")}
            required
            className="sm:col-span-2"
            error={tried && !node ? tr("先添加一个落地节点", "Add a landing node first") : undefined}
          >
            <Select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
              {choices.map(({ s, n }) => (
                <option key={n.id} value={n.id}>
                  {s.name} / {n.display_name || n.name}
                  {n.protocol ? ` (${n.protocol}${n.port ? ` :${n.port}` : ""})` : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={tr("名称", "Name")} required error={tried ? errors.name : undefined}>
          <Input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder={tr("例如 广州 → 香港 IPLC", "e.g. Guangzhou → HK IPLC")}
          />
        </Field>
        <Field label={tr("倍率", "Multiplier")} required error={shown(f.rate, errors.rate, tried)}>
          <Input
            inputMode="decimal"
            className="tnum"
            value={f.rate}
            onChange={(e) => setF({ ...f, rate: e.target.value })}
          />
        </Field>
        <Field
          label={tr("连接地址（中转机）", "Dial host (the relay)")}
          required
          error={tried ? errors.host : undefined}
          hint={tr("用户连接到这里", "Users connect here")}
        >
          <Input className="font-mono" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
        </Field>
        <Field label={tr("连接端口", "Dial port")} required error={shown(f.port, errors.port, tried)}>
          <Input
            inputMode="numeric"
            className="tnum"
            value={f.port}
            onChange={(e) => setF({ ...f, port: e.target.value })}
          />
        </Field>
        <EgressField
          host={f.host}
          value={f.cidrs}
          onChange={(v) => setF({ ...f, cidrs: v })}
          error={tried ? errors.cidrs : cidrLive}
        />
        <Field
          label={tr("监听端口（节点上）", "Listen port (on the node)")}
          required
          error={shown(f.listen, errors.listen, tried)}
        >
          <Input
            inputMode="numeric"
            className="tnum"
            value={f.listen}
            onChange={(e) => setF({ ...f, listen: e.target.value })}
          />
        </Field>
        <TagsField value={f.tags} onChange={(v) => setF({ ...f, tags: v })} />
        <div className="sm:col-span-2">
          <GroupPicker groups={groups} value={f.groups} onChange={(g) => setF({ ...f, groups: g })} />
        </div>
      </div>
    </Dialog>
  );
}
