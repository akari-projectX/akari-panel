// An entrance (NOD-15…19, NOD-22/23; v2 proposal §4, prototype
// components/nodes-entrance.tsx) in one centred dialog with one save and
// three tabs on ?etab=: 连接 (connection, relay path, egress allowlist,
// node groups = who can use it, enabled, sort, probe state), 倍率与时段 (the
// D9 base multiplier, rules, overlaps, a 7×24 heat map where dragging over
// cells creates a rule — 24×7 on a phone) and 流量与记录 (the entrance's own
// raw / billed traffic and its multiplier history from the audit log). Only
// changed fields are sent, with the version the form was opened at: a
// version conflict shows what changed and blocks saving. The new-relay
// dialog is the same form in create mode.
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowRightLeft,
  CircleAlert,
  Clock,
  Plus,
  Radar,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError, del, get, patch, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { ago, bytes, dateTime, daysBefore, siteToday } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { LineChart, timeLabels } from "../../shared/ui/line-chart";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Select, Switch } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { ErrorState, LoadingBlock } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";
import { useToast } from "../../shared/ui/toast";
import { Timeline } from "../components/kit";
import { GroupChips } from "../components/inputs";
import { WhitelistState, entranceLatency, protocolName, whitelistOf } from "../components/nodes-bits";
import { useAction } from "../data";
import { entryAsEgress } from "../egress";
import { useConfirmFree } from "../kit";
import { heatmap, hhmm, overlaps, parseHhmm, parseRate, rateAt, segments, type Rule } from "../rates";
import { useQS } from "../router";
import { holdersOf, usePlanList } from "../servers";
import { useCrumb, useSite } from "../session";
import type { EntranceView, NodeGroup, ServerNode, ServerView } from "../types";
import {
  ChipInput,
  FixCount,
  PORT,
  TagsField,
  addrValues,
  chips,
  isIpOrCidr,
  num,
  shown,
  tagValues,
  type Chips,
  type NumRule,
} from "./node-common";

const WEEKDAYS: [string, string][] = [
  ["一", "Mon"],
  ["二", "Tue"],
  ["三", "Wed"],
  ["四", "Thu"],
  ["五", "Fri"],
  ["六", "Sat"],
  ["日", "Sun"],
];

/** A rule while editing: "HH:MM" times ("00:00" as an end = midnight), weekdays 1 = Monday. */
type RuleForm = { weekdays: number[]; start: string; end: string; rate: string };

function ruleError(r: RuleForm, tr: Tr): string | undefined {
  const s = parseHhmm(r.start);
  const e = parseHhmm(r.end);
  if (r.weekdays.length === 0) return tr("至少选一天", "Pick at least one day");
  if (s === null || e === null) return tr("请填写开始与结束时间", "Enter the start and end times");
  if (s % 1440 === e % 1440) return tr("开始与结束不能相同", "Start and end must differ");
  if (!r.rate.trim()) return tr("倍率不能为空", "Enter a multiplier");
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

function rulesOf(e: EntranceView | null): RuleForm[] {
  return (e?.rate_rules ?? []).map((r) => ({
    weekdays: r.weekdays,
    start: hhmm(r.start),
    end: hhmm(r.end % 1440),
    rate: String(r.rate),
  }));
}

const dayName = (d: number, tr: Tr) => tr(`周${WEEKDAYS[d - 1][0]}`, WEEKDAYS[d - 1][1]);

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

function formOf(e: EntranceView | null): Form {
  return {
    name: e?.name ?? "",
    host: e?.connect_host ?? "",
    port: e?.connect_port ? String(e.connect_port) : "",
    rate: e ? String(e.rate) : "1",
    enabled: e?.enabled ?? true,
    sort: String(e?.sort ?? 0),
    tags: chips(e?.tags ?? []),
    groups: e?.group_ids ?? [],
    listen: e?.listen_port ? String(e.listen_port) : "",
    cidrs: chips(e?.source_cidrs ?? []),
  };
}

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
    rate: !f.rate.trim()
      ? tr("倍率不能留空（留空不会当作 0x，也不会发送）", "Enter a multiplier (empty is never 0x and is not sent)")
      : parseRate(f.rate) === null
        ? tr("倍率须为 0–100，最多 3 位小数", "Multiplier: 0–100, at most 3 decimals")
        : undefined,
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

function usePhone(): boolean {
  const q = "(max-width: 639px)";
  const [phone, setPhone] = useState(() => typeof matchMedia !== "undefined" && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia(q);
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

/* ---------- The egress allowlist ---------- */

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
          "连接地址也在出口列表里：落地机看到的是中转机的出口 IP，不是用户连接的地址。请在最后一跳机器上用 curl -4 ifconfig.me 确认。",
          "The dial address is listed as an egress: the landing node sees the relay's egress IP, not the address users dial. Check with curl -4 ifconfig.me on the last hop.",
        )
      : undefined);
  return (
    <Field
      group
      label={tr("中转机出口 IP / CIDR", "Relay egress IPs / CIDRs")}
      required
      hint={tr(
        "填中转机连向落地机时的最后一跳出口（在该机器上执行 curl -4 ifconfig.me）。落地机只接受这些来源；隔离主要靠独立凭据，白名单是附加防护。",
        "The last hop's egress towards the landing node (run curl -4 ifconfig.me on it). The node only accepts these sources; isolation rests on separate credentials, the allowlist is extra.",
      )}
      error={shownError}
    >
      <ChipInput
        value={value}
        onChange={onChange}
        label={tr("添加出口 IP / CIDR", "Add an egress IP / CIDR")}
        placeholder={tr("回车添加，如 198.51.100.17", "Enter to add, e.g. 198.51.100.17")}
        split={/[\s,，]+/}
        invalid={(v) => !isIpOrCidr(v)}
        mono
        chipTone="neutral"
        error={!!shownError}
      />
    </Field>
  );
}

/* ---------- Heat map ---------- */

const cellText = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2))));

/** How many valid rules cover some minute of hour `h` on day `d` (0 = Monday). */
function coverCount(rules: Rule[], d: number, h: number): number {
  const a = d * 1440 + h * 60;
  return rules.filter((r) => segments(r).some(([s, e]) => s < a + 60 && e > a)).length;
}

function Heatmap({
  base,
  rules,
  now,
  onCreate,
}: {
  base: number;
  rules: Rule[];
  now: { wd: number; hour: number };
  onCreate: (r: RuleForm) => void;
}) {
  const tr = useTr();
  const phone = usePhone();
  const grid = heatmap(base, rules);
  const max = Math.max(base, ...grid.flat(), 0.001);
  const [sel, setSel] = useState<{ d0: number; h0: number; d1: number; h1: number } | null>(null);
  const [rate, setRate] = useState("2");
  const drag = useRef(false);
  const range = sel && {
    d0: Math.min(sel.d0, sel.d1),
    d1: Math.max(sel.d0, sel.d1),
    h0: Math.min(sel.h0, sel.h1),
    h1: Math.max(sel.h0, sel.h1),
  };
  const inSel = (d: number, h: number) => !!range && d >= range.d0 && d <= range.d1 && h >= range.h0 && h <= range.h1;
  const rateOk = parseRate(rate) !== null;
  const cell = (d: number, h: number) => {
    const v = grid[d][h];
    const n = coverCount(rules, d, h);
    return (
      <button
        type="button"
        key={`${d}-${h}`}
        onPointerDown={(e) => {
          e.preventDefault();
          drag.current = true;
          setSel({ d0: d, h0: h, d1: d, h1: h });
        }}
        onPointerEnter={() => drag.current && setSel((s) => (s ? { ...s, d1: d, h1: h } : s))}
        onPointerUp={() => (drag.current = false)}
        onClick={(e) => e.detail === 0 && setSel({ d0: d, h0: h, d1: d, h1: h })}
        title={`${dayName(d + 1, tr)} ${h}:00–${h + 1}:00 · ${cellText(v)}x${n > 1 ? tr("（规则重叠，取最高）", " (overlap; the highest)") : ""}`}
        aria-label={`${dayName(d + 1, tr)} ${h}:00 ${cellText(v)}x`}
        className={cn(
          "tnum relative flex h-7 touch-none items-center justify-center rounded-[4px] text-caption font-medium select-none",
          v < 1 ? "bg-success-soft text-success" : "text-foreground",
          n > 1 && "ring-1 ring-warning ring-inset",
          d === now.wd && h === now.hour && "ring-2 ring-foreground ring-inset",
          inSel(d, h) && "ring-2 ring-primary ring-inset",
        )}
        style={
          v < 1
            ? undefined
            : {
                background: `color-mix(in srgb, var(--chart-1) ${Math.round((v / max) * 50) + 4}%, var(--window))`,
              }
        }
      >
        {v === base && n === 0 ? <span className="text-faint">{cellText(v)}</span> : cellText(v)}
      </button>
    );
  };
  const create = () => {
    if (!range || !rateOk) return;
    onCreate({
      weekdays: Array.from({ length: range.d1 - range.d0 + 1 }, (_, i) => range.d0 + i + 1),
      start: hhmm(range.h0 * 60),
      end: range.h1 === 23 ? "00:00" : hhmm((range.h1 + 1) * 60),
      rate,
    });
    setSel(null);
  };
  return (
    <div className="grid gap-2" onPointerLeave={() => (drag.current = false)}>
      <div role="group" aria-label={tr("一周 7×24 倍率热力图", "Week heat map 7×24")}>
        {phone ? (
          <div className="grid grid-cols-[28px_repeat(7,minmax(0,1fr))] gap-[3px]">
            <span />
            {WEEKDAYS.map((w) => (
              <span key={w[0]} className="text-center text-caption text-muted-foreground">
                {tr(w[0], w[1].slice(0, 2))}
              </span>
            ))}
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="contents">
                <span className="tnum self-center text-right text-caption text-faint">{h}</span>
                {WEEKDAYS.map((_, d) => cell(d, h))}
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-[24px_repeat(24,minmax(0,1fr))] gap-[3px]">
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="tnum text-center text-caption text-faint">
                {h}
              </span>
            ))}
            {WEEKDAYS.map((w, d) => (
              <div key={w[0]} className="contents">
                <span className="self-center text-caption text-muted-foreground">{tr(w[0], w[1].slice(0, 2))}</span>
                {Array.from({ length: 24 }, (_, h) => cell(d, h))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-caption text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-3 rounded-[3px] ring-2 ring-foreground ring-inset" aria-hidden="true" />
          {tr("此刻", "Now")}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-3 rounded-[3px] ring-1 ring-warning ring-inset" aria-hidden="true" />
          {tr("规则重叠（取最高）", "Overlap (the highest)")}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-3 rounded-[3px] bg-success-soft" aria-hidden="true" />
          {tr("低于 1x", "Below 1x")}
        </span>
        <span>
          {tr("灰色数字 = 基础倍率 · 拖选格子可直接生成规则", "Grey = the base · drag over cells to create a rule")}
        </span>
      </div>
      {range && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary-soft px-3 py-2 text-footnote">
          <span className="font-medium text-primary">
            {tr("已选", "Selected")}{" "}
            {Array.from({ length: range.d1 - range.d0 + 1 }, (_, i) => dayName(range.d0 + i + 1, tr)).join(
              tr("、", ", "),
            )}{" "}
            {hhmm(range.h0 * 60)}–{range.h1 === 23 ? "24:00" : hhmm((range.h1 + 1) * 60)}
          </span>
          <span className="text-muted-foreground">{tr("设为", "at")}</span>
          <Input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            inputMode="decimal"
            className="tnum h-7 w-16"
            aria-label={tr("新规则倍率", "New rule multiplier")}
            aria-invalid={!rateOk}
          />
          <span className="text-muted-foreground">x</span>
          <Button size="sm" variant="primary" disabled={!rateOk} onClick={create}>
            {tr("生成规则", "Create rule")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSel(null)}>
            {tr("取消", "Cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------- The form (edit and create) ---------- */

type Tab = "connect" | "rate" | "traffic";

function EntranceForm({
  entrance: e,
  node,
  server,
  groups,
  picker,
  onClose,
}: {
  /** null = a new relay on `node`. */
  entrance: EntranceView | null;
  node: ServerNode | undefined;
  server: ServerView | undefined;
  groups: NodeGroup[];
  /** Create mode from the page header: the landing node select. */
  picker?: ReactNode;
  onClose: () => void;
}) {
  const tr = useTr();
  const lang = useLang();
  const site = useSite();
  const confirm = useConfirm();
  const toast = useToast();
  const confirmFree = useConfirmFree();
  const nameRate = useNameRate();
  const plans = usePlanList();
  const [qs, patchQs] = useQS();
  const create = e === null;
  const relay = create || e.kind === "relay";
  useCrumb(e?.name ?? null);
  // The entrance as the form was opened (or last saved): the baseline of
  // what changed and the version sent back. `e` itself follows the 10 s
  // poll, so diffing against it would resend fields another admin changed.
  const [opened, setOpened] = useState(e);
  const [f, setF] = useState(() => formOf(e));
  const [rules, setRules] = useState<RuleForm[]>(() => rulesOf(e));
  const [savedRules, setSavedRules] = useState<RuleForm[]>(() => rulesOf(e));
  const [localTab, setLocalTab] = useState<Tab>("connect");
  const tabs: Tab[] = create ? ["connect", "rate"] : ["connect", "rate", "traffic"];
  const tab: Tab = create ? localTab : (tabs.find((t) => t === qs.get("etab")) ?? "connect");
  const setTab = (t: Tab) => (create ? setLocalTab(t) : patchQs({ etab: t === "connect" ? null : t }, true));
  const [tried, setTried] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [run, busy] = useAction();

  const errors = formErrors(f, relay, tr);
  const ruleErrors = rules.map((r) => ruleError(r, tr));
  const connBad = [errors.name, errors.host, errors.port, errors.listen, errors.cidrs, errors.sort, errors.tags].filter(
    Boolean,
  ).length;
  const rateBad = (errors.rate ? 1 : 0) + ruleErrors.filter(Boolean).length;
  const rate = parseRate(f.rate);
  const body = rate === null || connBad ? null : formBody(f, rate, relay);
  const was = formBody(formOf(opened), opened?.rate ?? 1, relay);
  const changedBody: Record<string, unknown> = {};
  if (body)
    for (const [k, v] of Object.entries(body)) if (JSON.stringify(v) !== JSON.stringify(was[k])) changedBody[k] = v;
  const o = formOf(opened);
  const rulesDirty = JSON.stringify(rules) !== JSON.stringify(savedRules);
  const changed = [
    f.name !== o.name && tr("名称", "name"),
    JSON.stringify(f.tags.items) !== JSON.stringify(o.tags.items) && tr("标签", "tags"),
    f.host !== o.host && tr("连接地址", "dial host"),
    f.port !== o.port && tr("端口", "port"),
    f.listen !== o.listen && tr("监听端口", "listen port"),
    JSON.stringify(f.cidrs.items) !== JSON.stringify(o.cidrs.items) && tr("出口白名单", "allowlist"),
    f.rate !== o.rate && tr("基础倍率", "base multiplier"),
    rulesDirty && tr("时段规则", "time rules"),
    [...f.groups].sort().join() !== [...o.groups].sort().join() && tr("节点组", "node groups"),
    f.enabled !== o.enabled && tr("启用", "enabled"),
    f.sort !== o.sort && tr("排序", "sort"),
  ].filter(Boolean) as string[];
  const dirty = changed.length > 0 || f.tags.draft !== "" || f.cidrs.draft !== "";

  const valid = rules.map(toRule).filter((r): r is Rule => r !== null);
  const ov = overlaps(valid);
  const overlapIdx = new Set(ov.flatMap((x) => [x.a, x.b]));
  const validIdx = rules.map((r) => toRule(r) !== null);
  const base = rate ?? opened?.rate ?? 1;
  const now = siteNow(site.timezone);
  const nowRate = rateAt(base, valid, now.wd * 1440 + now.hour * 60 + now.minute);
  const holders = plans.data
    ? plans.data.filter((p) => p.group_ids.some((g) => f.groups.includes(g))).reduce((n, p) => n + p.active_users, 0)
    : null;
  const cidrLive = f.cidrs.items.some((c) => !isIpOrCidr(c)) ? errors.cidrs : undefined;
  const liveBad = tried ? connBad + rateBad + (node ? 0 : 1) : cidrLive ? 1 : 0;
  const lineName = `${f.name.trim() || "—"}${tagValues(f.tags).length ? ` ${tagValues(f.tags).join(" ")}` : ""}${
    nameRate ? ` ${rate ?? "?"}x` : ""
  }`;
  // What another admin changed since this form opened (the polled entrance vs the baseline).
  const theirs =
    e && opened && e.version !== opened.version
      ? ([
          e.name !== opened.name && `${tr("名称", "name")} ${opened.name} → ${e.name}`,
          e.rate !== opened.rate && `${tr("基础倍率", "base")} ${opened.rate}x → ${e.rate}x`,
          (e.connect_host ?? "") !== (opened.connect_host ?? "") && tr("连接地址", "dial host"),
          e.connect_port !== opened.connect_port && tr("端口", "port"),
          e.enabled !== opened.enabled && tr("启用", "enabled"),
          [...e.group_ids].sort().join() !== [...opened.group_ids].sort().join() && tr("节点组", "node groups"),
          JSON.stringify(e.rate_rules) !== JSON.stringify(opened.rate_rules) && tr("时段规则", "time rules"),
        ].filter(Boolean) as string[])
      : [];

  const saveRules = async (id: string) => {
    const r = await run(() =>
      put<{ warnings: string[] }>(`/entrances/${id}/rate-rules`, {
        rules: rules.map((x) => ({ weekdays: x.weekdays, start: x.start, end: x.end, rate: parseRate(x.rate) })),
      }),
    );
    if (r) {
      setSavedRules(rules);
      if (r.warnings.length)
        toast({ tone: "info", title: tr("时段规则已保存", "Rules saved"), description: r.warnings.join("\n") });
    }
    return !!r;
  };

  const save = async () => {
    setTried(true);
    if (conflict) return;
    if (connBad || !node) return setTab("connect");
    if (rateBad) return setTab("rate");
    if (rate === null || !body) return;
    if (create) {
      if (rate === 0 && !(await confirmFree(f.name.trim()))) return;
      const r = await run(
        () =>
          post<EntranceView>(`/nodes/${node.id}/entrances`, {
            name: body.name,
            connect_host: body.connect_host,
            connect_port: body.connect_port,
            listen_port: body.listen_port,
            source_cidrs: body.source_cidrs,
            rate,
            tags: body.tags,
            group_ids: f.groups,
            sort: body.sort,
            enabled: f.enabled,
          }),
        {
          ok: tr("已添加中转入口", "Relay entrance added"),
          okDetail: tr(
            "落地机已派生入站并下发白名单（约 2 秒）",
            "The node derives the inbound and applies the allowlist (about 2 s)",
          ),
        },
      );
      if (!r) return;
      if (rules.length && r.id && !(await saveRules(r.id))) return;
      return onClose();
    }
    if (!dirty) return toast({ tone: "info", title: tr("没有改动", "Nothing changed") });
    if (Object.keys(changedBody).length > 0) {
      if (changedBody.rate === 0 && !(await confirmFree(e.name))) return;
      if (changedBody.enabled === false) {
        const ok = await confirm({
          title: tr(`停用入口「${e.name}」？`, `Disable "${e.name}"?`),
          description: tr(
            "用户会失去这个入口（从节点移除，订阅里不再出现）；入口的设置保留。",
            "Users lose this entrance (removed from the node and from subscriptions); its settings are kept.",
          ),
          tone: "warning",
        });
        if (!ok) return;
      }
      // Only what changed since the form was opened, with the version it was
      // opened at: a stale form never restores old values (409 instead).
      const saved = await run(async () => {
        try {
          return await patch<EntranceView>(`/entrances/${e.id}`, { ...changedBody, version: opened!.version });
        } catch (err) {
          if (err instanceof ApiError && err.code === "entrance.version_conflict") {
            setConflict(true);
            return null;
          }
          throw err;
        }
      });
      if (!saved) return;
      setOpened(saved);
      setF(formOf(saved));
    }
    if (rulesDirty && !(await saveRules(e.id))) return;
    toast({
      tone: "success",
      title: tr("已保存入口", "Entrance saved"),
      description:
        changedBody.rate === undefined
          ? tr(`只发送了改动：${changed.join(tr("、", ", "))}`, `Sent only the changes: ${changed.join(", ")}`)
          : tr(
              `倍率 ${opened!.rate}x → ${rate}x：从下一次结算起生效，不追溯；改动后 30 秒内按两者中较低的倍率结算。`,
              `Multiplier ${opened!.rate}x → ${rate}x: from the next settlement on, not retroactive; for 30 s the lower of the two applies.`,
            ),
    });
    onClose();
  };

  const remove = async () => {
    if (!e) return;
    // The entrance's billed traffic of the last 30 days (its own rows, never the node's).
    const to = siteToday();
    const billed = await get<{ days: { billed_bytes: number }[] }>(
      `/entrances/${e.id}/traffic?from=${daysBefore(to, 29)}&to=${to}`,
    )
      .then((t) => t.days.reduce((n, d) => n + d.billed_bytes, 0))
      .catch(() => null);
    const names = e.group_ids
      .map((g) => groups.find((x) => x.id === g)?.name)
      .filter(Boolean)
      .join(tr("、", ", "));
    const users = plans.data ? holdersOf([e.id], groups, plans.data) : null;
    const ok = await confirm({
      title: tr(`删除入口「${e.name}」？`, `Delete entrance "${e.name}"?`),
      description: tr(
        "该入口的派生入站与来源白名单会从落地节点上移除，订阅里对应线路立即消失。落地节点本身和其他入口不受影响。",
        "Its derived inbound and source allowlist leave the landing node and its line leaves subscriptions at once. The node and its other entrances are not affected.",
      ),
      impacts: [
        ...(users === null
          ? []
          : [
              {
                label: tr("可使用该入口的用户（按套餐估算）", "Users who can use it (from the plans)"),
                value: tr(`${users.toLocaleString()} 人`, users.toLocaleString()),
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
  const probe = e && server && node && !relay ? entranceLatency(server, node, e) : undefined;
  const nodeLine = node
    ? `${protocolName(node.protocol, tr)}${node.transport ? ` · ${node.transport}` : ""}${node.port ? ` · :${node.port}` : ""}`
    : "";

  return (
    <Dialog
      open
      size="lg"
      icon={relay ? ArrowRightLeft : ShieldCheck}
      onClose={onClose}
      onSubmit={save}
      dirty={dirty}
      title={
        create
          ? node
            ? tr(`添加中转入口 · ${node.name}`, `Add relay entrance · ${node.name}`)
            : tr("添加中转入口", "Add relay entrance")
          : e.name
      }
      description={
        create ? (
          node && server ? (
            tr(
              `在 ${server.name} / ${node.name}（${nodeLine}）前面加一台中转机`,
              `Put a relay in front of ${server.name} / ${node.name} (${nodeLine})`,
            )
          ) : (
            tr("选择落地节点，再填写中转机", "Pick the landing node, then the relay")
          )
        ) : (
          <>
            {relay ? tr("中转入口", "Relay entrance") : tr("直连入口", "Direct entrance")} · {server?.name} /{" "}
            {node?.name} · {tr(`订阅中显示为「${lineName}」`, `In subscriptions: "${lineName}"`)}
          </>
        )
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          label={tr("入口", "Entrance")}
          tabs={[
            { value: "connect" as Tab, label: tr("连接", "Connection") },
            { value: "rate" as Tab, label: tr("倍率与时段", "Multipliers"), count: rules.length || undefined },
            ...(create ? [] : [{ value: "traffic" as Tab, label: tr("流量与记录", "Traffic and history") }]),
          ]}
        />
      }
      footer={
        <>
          {!create && relay && (
            <Button variant="destructive-soft" icon={Trash2} onClick={remove} className="max-sm:px-2.5">
              <span className="max-sm:sr-only">{tr("删除入口", "Delete entrance")}</span>
            </Button>
          )}
          <div className="min-w-0 flex-1 truncate text-right text-footnote text-muted-foreground">
            {conflict ? (
              <span className="font-medium text-destructive">
                {tr("已被他人修改，不能保存", "Changed by someone else; cannot save")}
              </span>
            ) : liveBad > 0 ? (
              <FixCount n={liveBad} />
            ) : !create && changed.length ? (
              tr(`改动：${changed.join(tr("、", ", "))}`, `Changed: ${changed.join(", ")}`)
            ) : null}
          </div>
          <Button className="max-sm:hidden" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={conflict || (!create && !dirty)}>
            {create ? tr("添加入口", "Add entrance") : tr("保存", "Save")}
          </Button>
        </>
      }
    >
      {conflict && (
        <Banner
          tone="danger"
          icon={<CircleAlert />}
          title={tr("此入口已被他人修改。", "Someone else changed this entrance.")}
          className="mb-4"
          action={
            <Button size="sm" variant="outline" onClick={onClose}>
              {tr("关闭后重新打开", "Close and reopen")}
            </Button>
          }
        >
          {theirs.length
            ? tr(
                `最新版本改了：${theirs.join(tr("、", ", "))}（版本 ${opened?.version} → ${e?.version}）。为避免覆盖，你的修改不会保存；请关闭后重新打开再改。`,
                `The latest version changed: ${theirs.join(", ")} (version ${opened?.version} → ${e?.version}). Your edits are not saved to avoid overwriting them; close and reopen to edit.`,
              )
            : tr(
                "为避免覆盖，你的修改不会保存；请关闭后重新打开再改。",
                "Your edits are not saved to avoid overwriting them; close and reopen to edit.",
              )}
        </Banner>
      )}
      {!create && e.hidden_since && (
        <Banner
          tone="danger"
          icon={<Radar />}
          className="mb-4"
          title={tr("探测失败，已从订阅隐藏。", "Probe failing; hidden from subscriptions.")}
        >
          {tr(
            `自 ${dateTime(e.hidden_since)}，连续失败 ${e.health_failures} 次。已发告警，恢复后自动显示。先检查中转机到落地机 ${server?.tls_domain ?? server?.name ?? ""} 的 ${e.listen_port ?? "?"} 端口是否放行。`,
            `Since ${dateTime(e.hidden_since)}, ${e.health_failures} failures in a row. Alerted; it comes back automatically. Check the relay can reach ${server?.tls_domain ?? server?.name ?? "the node"} on port ${e.listen_port ?? "?"}.`,
          )}
        </Banner>
      )}
      {tab === "connect" && (
        <div className="grid gap-5">
          {picker}
          {relay && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-window px-3.5 py-2.5 text-footnote ring-1 ring-border ring-inset">
              <span className="text-muted-foreground">{tr("用户", "Users")}</span>
              <ArrowRight className="size-3.5 text-faint" aria-hidden="true" />
              <span className="font-mono font-medium">
                {f.host.trim() || tr("中转机", "relay")}:{f.port.trim() || "?"}
              </span>
              <ArrowRight className="size-3.5 text-chart-2" aria-hidden="true" />
              <span className="rounded bg-[color-mix(in_srgb,var(--chart-2)_14%,transparent)] px-1.5 text-chart-2">
                {tr("中转机转发", "relay forwards")}
              </span>
              <ArrowRight className="size-3.5 text-chart-2" aria-hidden="true" />
              <span className="font-mono font-medium">
                {server?.tls_domain ?? tr("落地机", "node")}:{f.listen.trim() || "?"}
              </span>
              <ArrowRight className="size-3.5 text-faint" aria-hidden="true" />
              <span className="text-muted-foreground">{node?.name ?? "—"}</span>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={tr("入口名称", "Entrance name")}
              required
              error={tried ? errors.name : undefined}
              hint={tr("订阅线路名与门户线路列表都用它", "Used in subscription line names and the portal")}
            >
              <Input
                value={f.name}
                onChange={(x) => setF({ ...f, name: x.target.value })}
                placeholder={relay ? tr("如 广州 → 香港 IPLC", "e.g. Guangzhou → HK IPLC") : undefined}
                data-autofocus={create || undefined}
              />
            </Field>
            <TagsField value={f.tags} onChange={(v) => setF({ ...f, tags: v })} />
            <Field
              label={tr("连接地址", "Dial host")}
              required={relay}
              error={tried ? errors.host : undefined}
              hint={
                relay
                  ? tr("中转机的域名或 IP（用户连到这里）", "The relay's domain or IP (users connect here)")
                  : server?.tls_domain
                    ? tr(
                        `留空 = 服务器 TLS 域名（${server.tls_domain}）`,
                        `Empty = the server's TLS domain (${server.tls_domain})`,
                      )
                    : tr("留空 = 服务器 TLS 域名", "Empty = the server's TLS domain")
              }
            >
              <Input
                value={f.host}
                className="font-mono"
                placeholder={relay ? "relay.example.net" : (server?.tls_domain ?? "")}
                onChange={(x) => setF({ ...f, host: x.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label={tr("端口", "Port")}
                required={relay}
                error={shown(f.port, errors.port, tried)}
                hint={relay ? undefined : tr("留空 = 入站端口", "Empty = inbound's")}
              >
                <Input
                  inputMode="numeric"
                  className="tnum"
                  value={f.port}
                  placeholder={relay ? "" : String(node?.port ?? "")}
                  onChange={(x) => setF({ ...f, port: x.target.value })}
                />
              </Field>
              {relay && (
                <Field
                  label={tr("落地监听端口", "Landing listen port")}
                  required
                  error={shown(f.listen, errors.listen, tried)}
                  hint={tr("中转机转发到这里", "The relay forwards here")}
                >
                  <Input
                    inputMode="numeric"
                    className="tnum"
                    value={f.listen}
                    onChange={(x) => setF({ ...f, listen: x.target.value })}
                  />
                </Field>
              )}
            </div>
          </div>
          {relay && (
            <div className="grid gap-2">
              <EgressField
                host={f.host}
                value={f.cidrs}
                onChange={(v) => setF({ ...f, cidrs: v })}
                error={tried ? errors.cidrs : cidrLive}
              />
              {!create && server && <WhitelistState w={whitelistOf(server)} />}
            </div>
          )}
          <Field
            group
            label={tr("节点组", "Node groups")}
            hint={
              f.groups.length === 0
                ? tr("不在任何节点组里：没有用户能用这个入口。", "In no node group: nobody can use this entrance.")
                : holders !== null
                  ? tr(
                      `能使用这个入口的套餐由节点组决定（按当前套餐约 ${holders.toLocaleString()} 名用户）`,
                      `Plans reach it through node groups (about ${holders.toLocaleString()} users from current plans)`,
                    )
                  : tr("能使用这个入口的套餐由节点组决定", "Plans reach it through node groups")
            }
          >
            <GroupChips
              groups={groups}
              value={f.groups}
              onChange={(g) => setF({ ...f, groups: g })}
              manageTo="/plans/groups"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <div className="flex items-center justify-between gap-3 rounded-xl bg-window px-4 py-3 ring-1 ring-border ring-inset">
              <div>
                <div className="text-body font-medium">{tr("启用入口", "Entrance enabled")}</div>
                <div className="text-footnote text-muted-foreground">
                  {relay
                    ? tr(
                        "关闭后不下发、订阅中隐藏；派生入站与白名单设置保留",
                        "Off: not served, left out of subscriptions; settings kept",
                      )
                    : tr(
                        "关闭后订阅中隐藏；节点本身不受影响",
                        "Off: left out of subscriptions; the node is not affected",
                      )}
                </div>
              </div>
              <Switch
                checked={f.enabled}
                onChange={(v) => setF({ ...f, enabled: v })}
                label={tr("启用入口", "Entrance enabled")}
              />
            </div>
            <Field
              label={tr("排序", "Sort")}
              hint={tr("越小越靠前", "Smaller first")}
              error={shown(f.sort, errors.sort, tried)}
            >
              <Input
                inputMode="numeric"
                className="tnum"
                value={f.sort}
                onChange={(x) => setF({ ...f, sort: x.target.value })}
              />
            </Field>
          </div>
          {!create && relay && e.health_at && !e.hidden_since && (
            <div
              className={cn(
                "flex items-center gap-3 rounded-xl px-4 py-2.5 text-footnote",
                e.health_ok ? "bg-success-soft" : "bg-warning-soft",
              )}
            >
              <Radar
                className={cn("size-4 shrink-0", e.health_ok ? "text-success" : "text-warning")}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                {e.health_ok
                  ? tr(
                      `TCP 探测：面板 → ${opened?.connect_host ?? ""}:${opened?.connect_port ?? ""} 正常（${ago(e.health_at, lang)}）`,
                      `TCP probe: panel → ${opened?.connect_host ?? ""}:${opened?.connect_port ?? ""} ok (${ago(e.health_at, lang)})`,
                    )
                  : tr(
                      `TCP 探测失败 ${e.health_failures} 次（最近 ${ago(e.health_at, lang)}），连续 3 次后从订阅隐藏`,
                      `TCP probe failed ${e.health_failures} times (last ${ago(e.health_at, lang)}); hidden after 3 in a row`,
                    )}
              </span>
            </div>
          )}
          {probe && (
            <div
              className={cn(
                "flex items-center gap-3 rounded-xl px-4 py-2.5 text-footnote",
                probe.delay_ms !== null ? "bg-success-soft" : "bg-warning-soft",
              )}
            >
              <Radar
                className={cn("size-4 shrink-0", probe.delay_ms !== null ? "text-success" : "text-warning")}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                {probe.delay_ms !== null
                  ? tr(
                      `TCP 测速：面板 → 本入口 ${probe.delay_ms} ms（${ago(probe.measured_at, lang)}）`,
                      `TCP test: panel → this entrance ${probe.delay_ms} ms (${ago(probe.measured_at, lang)})`,
                    )
                  : tr(
                      `TCP 测速失败（${ago(probe.measured_at, lang)}）`,
                      `TCP test failed (${ago(probe.measured_at, lang)})`,
                    )}
              </span>
            </div>
          )}
        </div>
      )}
      {tab === "rate" && (
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            <Field
              label={tr("基础倍率", "Base multiplier")}
              required
              error={shown(f.rate, errors.rate, true)}
              hint={
                rate === 0 ? (
                  <span className="text-warning">
                    {tr("0x = 免费，保存时需要确认", "0x = free; you confirm on save")}
                  </span>
                ) : nameRate ? (
                  tr(
                    "已开启「订阅线路名显示倍率」：改倍率会改变线路名，客户端刷新订阅后可能切换线路。",
                    "Multipliers in line names is on: a change renames the line; clients may switch lines after a refresh.",
                  )
                ) : (
                  tr("没有规则命中时使用；0 = 免费", "Used outside every rule; 0 = free")
                )
              }
            >
              <div className="relative">
                <Input
                  inputMode="decimal"
                  className="tnum pr-7"
                  value={f.rate}
                  onChange={(x) => setF({ ...f, rate: x.target.value })}
                />
                <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-footnote text-faint">
                  x
                </span>
              </div>
            </Field>
            <div className="flex flex-wrap items-end gap-3 rounded-xl bg-window px-4 py-3 ring-1 ring-border ring-inset">
              <div className="min-w-0 flex-1">
                <div className="text-footnote text-muted-foreground">
                  {tr(
                    `此刻生效 · ${dayName(now.wd + 1, tr)} ${hhmm(now.hour * 60 + now.minute)}（${site.timezone}）`,
                    `Now · ${dayName(now.wd + 1, tr)} ${hhmm(now.hour * 60 + now.minute)} (${site.timezone})`,
                  )}
                </div>
                <div className="tnum text-title2 font-semibold">{errors.rate ? "—" : `${nowRate}x`}</div>
              </div>
              {ov.length > 0 && (
                <Badge tone="warning" className="whitespace-normal">
                  <TriangleAlert aria-hidden="true" />
                  {tr("有规则重叠，重叠处取最高", "Rules overlap; the highest applies")}
                </Badge>
              )}
            </div>
          </div>
          <p className="-mt-2 flex items-start gap-1.5 text-footnote text-muted-foreground">
            <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {tr(
              "改倍率从下一次结算起生效，不追溯已产生的流量；保存后 30 秒内节点按新旧两者中较低的倍率计。",
              "A new multiplier applies from the next settlement, never retroactively; for 30 s after saving the lower of old and new applies.",
            )}
          </p>
          <section className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-body font-semibold">
                {tr("时段规则", "Time rules")} <span className="tnum font-normal text-faint">{rules.length}</span>
              </h4>
              <span className="text-footnote text-faint">
                {tr(
                  `站点时区 ${site.timezone} · 结束 00:00 表示 24:00，早于开始 = 跨午夜`,
                  `Site time zone ${site.timezone} · an end of 00:00 is 24:00; before the start crosses midnight`,
                )}
              </span>
            </div>
            {rules.length === 0 && (
              <p className="rounded-xl bg-window px-4 py-3 text-footnote text-muted-foreground ring-1 ring-border ring-inset">
                {tr("没有时段规则，全天按基础倍率。", "No time rules; the base applies all day.")}
              </p>
            )}
            <ul className="grid gap-3">
              {rules.map((r, i) => {
                const err = ruleErrors[i];
                const showErr = err && (tried || r.start === "" || r.end === "" || !r.rate.trim());
                const overlap = validIdx[i] && overlapIdx.has(validPos(validIdx, i));
                return (
                  <li
                    key={i}
                    data-rule={i}
                    className={cn(
                      "rounded-xl p-3 ring-1 ring-inset",
                      showErr
                        ? "bg-destructive-soft ring-[color-mix(in_srgb,var(--destructive)_30%,transparent)]"
                        : overlap
                          ? "bg-warning-soft ring-[color-mix(in_srgb,var(--warning)_30%,transparent)]"
                          : "bg-card ring-border",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="tnum text-footnote font-semibold text-muted-foreground">
                        {tr(`规则 ${i + 1}`, `Rule ${i + 1}`)}
                      </span>
                      <div
                        className="flex gap-1"
                        role="group"
                        aria-label={tr(`规则 ${i + 1} 星期`, `Rule ${i + 1} days`)}
                      >
                        {WEEKDAYS.map((w, d) => {
                          const on = r.weekdays.includes(d + 1);
                          return (
                            <button
                              key={d}
                              type="button"
                              aria-pressed={on}
                              aria-label={tr(
                                `规则 ${i + 1} ${dayName(d + 1, tr)}`,
                                `Rule ${i + 1} ${dayName(d + 1, tr)}`,
                              )}
                              onClick={() =>
                                setRule(i, {
                                  weekdays: on ? r.weekdays.filter((x) => x !== d + 1) : [...r.weekdays, d + 1].sort(),
                                })
                              }
                              className={cn(
                                "hit-44 inline-flex size-7 items-center justify-center rounded-full text-footnote font-medium transition-colors",
                                on ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
                              )}
                            >
                              {lang === "zh" ? w[0] : w[1].slice(0, 2)}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
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
                        {r.end === "00:00" && (
                          <span className="text-caption text-faint">{tr("即 24:00", "= 24:00")}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Input
                          aria-label={tr(`规则 ${i + 1} 倍率`, `Rule ${i + 1} multiplier`)}
                          inputMode="decimal"
                          className="tnum w-16"
                          value={r.rate}
                          aria-invalid={!!showErr}
                          onChange={(x) => setRule(i, { rate: x.target.value })}
                        />
                        <span className="text-muted-foreground">x</span>
                      </div>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        icon={X}
                        className="ml-auto"
                        aria-label={tr(`删除规则 ${i + 1}`, `Remove rule ${i + 1}`)}
                        onClick={() => setRules(rules.filter((_, j) => j !== i))}
                      />
                    </div>
                    {showErr && (
                      <p className="mt-2 flex items-center gap-1 text-footnote text-destructive" role="alert">
                        <CircleAlert className="size-3.5" aria-hidden="true" />
                        {err}
                      </p>
                    )}
                    {!showErr && overlap && (
                      <p className="mt-2 flex items-center gap-1 text-footnote text-warning">
                        <TriangleAlert className="size-3.5" aria-hidden="true" />
                        {tr(
                          "与其他规则在部分时段重叠，重叠处取最高倍率",
                          "Overlaps another rule in part; the highest applies there",
                        )}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            <Button
              variant="soft"
              icon={Plus}
              className="justify-self-start"
              disabled={rules.length >= 24}
              onClick={() =>
                setRules([...rules, { weekdays: [1, 2, 3, 4, 5], start: "20:00", end: "00:00", rate: "2" }])
              }
            >
              {tr("添加时段规则", "Add a time rule")}
            </Button>
          </section>
          <section className="grid gap-2">
            <h4 className="text-body font-semibold">{tr("一周倍率", "The week")}</h4>
            <Heatmap base={base} rules={valid} now={now} onCreate={(r) => setRules([...rules, r])} />
          </section>
        </div>
      )}
      {tab === "traffic" && e && <EntranceHistory id={e.id} />}
    </Dialog>
  );
}

/** Position of rule `i` among the valid rules (overlaps() indexes the valid list). */
function validPos(validIdx: boolean[], i: number): number {
  let n = -1;
  for (let j = 0; j <= i; j++) if (validIdx[j]) n++;
  return validIdx[i] ? n : -1;
}

/* ---------- 流量与记录 ---------- */

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
  if (q.isError)
    return (
      <ErrorState
        compact
        title={tr("入口流量加载失败", "Could not load the entrance's traffic")}
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  if (q.isPending) return <LoadingBlock rows={6} />;
  const all: string[] = [];
  for (let i = 29; i >= 0; i--) all.push(daysBefore(to, i));
  const by = new Map(q.data.days.map((r) => [r.day, r]));
  const times = all.map((d) => `${d}T12:00:00Z`);
  const raw = q.data.days.reduce((a, r) => a + r.up_bytes + r.down_bytes, 0);
  const billed = q.data.days.reduce((a, r) => a + r.billed_bytes, 0);
  const rules = (r: { rate: number }[] | null) =>
    r && r.length ? r.map((x) => `${x.rate}x`).join(" / ") : tr("无规则", "no rules");
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-3 gap-2">
        {[
          [tr("30 天原始", "Raw, 30 days"), bytes(raw)],
          [tr("30 天计费", "Billed, 30 days"), bytes(billed)],
          [tr("平均倍率", "Mean multiplier"), raw > 0 ? `${(billed / raw).toFixed(2)}x` : "—"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl bg-window px-3 py-2.5 ring-1 ring-border ring-inset">
            <div className="text-footnote text-muted-foreground">{k}</div>
            <div className="tnum text-headline font-semibold">{v}</div>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 text-footnote text-muted-foreground">
          {tr("只统计本入口，不与同节点其他入口相加", "This entrance only, never summed with the node's others")}
        </div>
        <LineChart
          title={tr("入口每日原始 / 计费（站点时区）", "Entrance raw / billed per day (site days)")}
          times={times}
          {...timeLabels(times)}
          height={180}
          legend="total"
          format={bytes}
          series={[
            {
              label: tr("原始", "Raw"),
              values: all.map((d) => (by.get(d) ? by.get(d)!.up_bytes + by.get(d)!.down_bytes : 0)),
              slot: 1,
            },
            {
              label: tr("计费", "Billed"),
              values: all.map((d) => by.get(d)?.billed_bytes ?? 0),
              slot: 4,
              dashed: true,
            },
          ]}
        />
      </div>
      <details className="rounded-xl ring-1 ring-border ring-inset">
        <summary className="flex min-h-11 cursor-default items-center px-4 text-body font-medium">
          {tr("每日明细", "Per day")} <span className="ml-1 text-faint">{tr("30 天", "30 days")}</span>
        </summary>
        {q.data.days.length === 0 ? (
          <p className="border-t border-separator px-4 py-3 text-body text-muted-foreground">
            {tr("这段时间没有流量。", "No traffic in this period.")}
          </p>
        ) : (
          <div className="max-h-56 overflow-y-auto border-t border-separator">
            <table className="w-full text-body" aria-label={tr("每日流量", "Daily traffic")}>
              <thead className="sticky top-0 bg-card">
                <tr className="text-footnote text-muted-foreground">
                  <th className="h-8 px-4 text-left font-medium">{tr("日期", "Day")}</th>
                  <th className="px-4 text-right font-medium">{tr("原始", "Raw")}</th>
                  <th className="px-4 text-right font-medium">{tr("计费", "Billed")}</th>
                </tr>
              </thead>
              <tbody>
                {[...q.data.days].reverse().map((d) => (
                  <tr key={d.day} className="border-t border-separator">
                    <td className="tnum h-9 px-4">{d.day}</td>
                    <td className="tnum px-4 text-right">{bytes(d.up_bytes + d.down_bytes)}</td>
                    <td className="tnum px-4 text-right font-medium">{bytes(d.billed_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
      <section>
        <h4 className="mb-3 text-body font-semibold">{tr("倍率变更记录", "Multiplier history")}</h4>
        {q.data.rate_changes.length === 0 ? (
          <p className="text-body text-muted-foreground">
            {tr("审计日志里没有倍率变更", "No multiplier changes in the audit log")}
          </p>
        ) : (
          <Timeline
            items={q.data.rate_changes.map((c) => ({
              title:
                c.action === "entrance.rate_rules.set" ? (
                  <>
                    {tr("时段规则：", "Time rules: ")}
                    <span className="text-muted-foreground line-through decoration-faint">
                      {rules(c.rules_before)}
                    </span>{" "}
                    → {rules(c.rules_after)}
                  </>
                ) : c.action === "entrance.create" ? (
                  tr(`创建入口 ${c.rate_after}x`, `Created at ${c.rate_after}x`)
                ) : (
                  <>
                    {tr("基础倍率：", "Base: ")}
                    <span className="text-muted-foreground line-through decoration-faint">{c.rate_before}x</span> →{" "}
                    {c.rate_after}x
                  </>
                ),
              time: dateTime(c.at),
              body: (
                <>
                  {c.actor_email ?? c.actor_label} ·{" "}
                  <Link to="/audit" className="text-primary hover:underline">
                    {tr("审计", "Audit")}
                  </Link>
                </>
              ),
              tone: c.action === "entrance.create" ? "neutral" : "info",
            }))}
          />
        )}
      </section>
    </div>
  );
}

/* ---------- Exports ---------- */

export function EntranceDialog({
  entrance,
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
  return <EntranceForm entrance={entrance} node={node} server={server} groups={groups} onClose={onClose} />;
}

/** A new relay entrance: on a given node (its menu), or with a landing-node select (page header). */
export function RelayDialog({
  target,
  servers,
  groups,
  onClose,
}: {
  target?: { n: ServerNode; s: ServerView };
  servers: ServerView[];
  groups: NodeGroup[];
  onClose: () => void;
}) {
  const tr = useTr();
  const choices = servers.filter((s) => !s.deleting_at).flatMap((s) => s.nodes.map((n) => ({ s, n })));
  const [nodeId, setNodeId] = useState(target?.n.id ?? choices[0]?.n.id ?? "");
  const pick = target ?? choices.find((c) => c.n.id === nodeId);
  return (
    <EntranceForm
      entrance={null}
      node={pick?.n}
      server={pick?.s}
      groups={groups}
      onClose={onClose}
      picker={
        target ? undefined : (
          <Field
            label={tr("落地节点", "Landing node")}
            required
            error={choices.length === 0 ? tr("先添加一个落地节点", "Add a landing node first") : undefined}
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
        )
      }
    />
  );
}
