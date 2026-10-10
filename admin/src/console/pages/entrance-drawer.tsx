// An entrance (NOD-15…19, NOD-22/23): direct or relay settings, node
// groups, the D9 time-window multipliers (rules, overlap warnings, 7×24
// heatmap, the multiplier now), relay health, delete, its daily traffic and
// multiplier history; and the new-relay dialog.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { del, get, patch, post, put } from "../../shared/api";
import { ago, bytes, dateTime, daysBefore, rateText, siteToday } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { LineChart } from "../../shared/ui/line-chart";
import { Dialog, Drawer, useConfirm, useToast } from "../../shared/ui/overlays";
import { Badge, Button, Callout, Field, Input, KV, Switch, Textarea } from "../../shared/ui/primitives";
import { FormError, SectionTitle, useConfirmFree, useRun } from "../kit";
import { entryAsEgress } from "../egress";
import { heatmap, hhmm, overlaps, parseHhmm, parseRate, rateAt, type Rule } from "../rates";
import { useSite } from "../session";
import type { EntranceView, NodeGroup, ServerNode, ServerView } from "../types";
import { GroupPicker, splitTags, TagsField } from "./node-dialogs";
import { entranceState, healthText } from "./nodes";
import { useSettings } from "./settings";

const WEEKDAYS: [string, string][] = [
  ["一", "Mon"],
  ["二", "Tue"],
  ["三", "Wed"],
  ["四", "Thu"],
  ["五", "Fri"],
  ["六", "Sat"],
  ["日", "Sun"],
];

type RuleForm = { weekdays: number[]; start: string; end: string; rate: string };

function toRule(r: RuleForm): Rule | null {
  const s = parseHhmm(r.start);
  const e = parseHhmm(r.end);
  const rate = Number(r.rate);
  if (s === null || e === null || !Number.isFinite(rate) || r.weekdays.length === 0) return null;
  return { weekdays: r.weekdays, start: s % 1440, end: e % 1440, rate };
}

function weekdayText(d: number, tr: Tr) {
  return tr(`周${WEEKDAYS[d - 1][0]}`, WEEKDAYS[d - 1][1]);
}

const RATE_REQUIRED: [string, string] = [
  "请填写倍率：0–100，最多 3 位小数（留空不会当作 0）",
  "Enter a multiplier: 0–100, at most 3 decimals (empty is not 0)",
];

/** The relay egress field (edit drawer and new-relay dialog). */
function EgressField({ host, value, onChange }: { host: string; value: string; onChange: (v: string) => void }) {
  const tr = useTr();
  return (
    <Field
      label={tr("中转机出口 IP / CIDR（每行一个）", "Relay egress IPs / CIDRs (one per line)")}
      hint={tr(
        "填最后一跳（转发到本节点的那台机器）的出口 IP：在该机器上运行 curl -4 ifconfig.me 查看。不是连接地址；多跳中转只填最后一跳。只接受这些地址的新连接，隔离主要靠独立凭据，白名单是附加防护。",
        "Enter the egress IP of the last hop (the machine that forwards to this node): run curl -4 ifconfig.me on it. Not the dial address; for a multi-hop relay only the last hop. Only these addresses may open connections; isolation rests on separate credentials, the allowlist is extra.",
      )}
      error={
        entryAsEgress(host, value)
          ? tr(
              "连接地址也在出口列表里：中转机的入口 IP 通常不是它的出口 IP，填错会让中转不通。请在最后一跳机器上用 curl -4 ifconfig.me 确认。",
              "The dial address is listed as an egress: a relay's entry IP is usually not its egress IP, and a wrong one breaks the relay. Check with curl -4 ifconfig.me on the last hop.",
            )
          : undefined
      }
      className="sm:col-span-2"
    >
      <Textarea rows={3} value={value} onChange={(x) => onChange(x.target.value)} placeholder="203.0.113.7" />
    </Field>
  );
}

/** What the entrance form sends for an entrance (the PATCH field shapes). */
function formBody(
  f: {
    name: string;
    host: string;
    port: string;
    rate: number;
    enabled: boolean;
    sort: string;
    tags: string;
    groups: string[];
    listen: string;
    cidrs: string;
  },
  relay: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: f.name.trim(),
    rate: f.rate,
    enabled: f.enabled,
    sort: Number(f.sort) || 0,
    tags: splitTags(f.tags),
    group_ids: [...f.groups].sort(),
  };
  if (relay) {
    body.connect_host = f.host.trim();
    body.connect_port = Number(f.port);
    body.listen_port = Number(f.listen);
    body.source_cidrs = f.cidrs.split(/[\s,]+/).filter(Boolean);
  } else {
    body.connect_host = f.host.trim() || null;
    body.connect_port = f.port.trim() ? Number(f.port) : null;
  }
  return body;
}

function formOf(e: EntranceView) {
  return {
    name: e.name,
    host: e.connect_host ?? "",
    port: e.connect_port ? String(e.connect_port) : "",
    rate: String(e.rate),
    enabled: e.enabled,
    sort: String(e.sort),
    tags: e.tags.join(", "),
    groups: e.group_ids,
    listen: e.listen_port ? String(e.listen_port) : "",
    cidrs: e.source_cidrs.join("\n"),
  };
}

export function EntranceDrawer({
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
  const nameRate = useSettings().data?.subscription.name_rate === true;
  const relay = e.kind === "relay";
  // The entrance as the form was opened (or last saved): the baseline of
  // what changed and the version sent back. `e` itself follows the 10 s
  // poll, so diffing against it would resend fields another admin changed.
  const [opened, setOpened] = useState(e);
  const [f, setF] = useState(() => formOf(e));
  const [rules, setRules] = useState<RuleForm[]>(
    e.rate_rules.map((r) => ({
      weekdays: r.weekdays,
      start: hhmm(r.start),
      end: r.end === 0 ? "24:00" : hhmm(r.end),
      rate: String(r.rate),
    })),
  );
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const [runRules, busyRules] = useRun();
  const parsed = rules.map(toRule);
  const valid = parsed.filter((r): r is Rule => r !== null);
  const ov = overlaps(valid);
  const base = Number(f.rate) || 0;
  const grid = heatmap(base, valid);
  const now = new Date();
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: site.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
    local.find((p) => p.type === "weekday")?.value ?? "Mon",
  );
  const hour = Number(local.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(local.find((p) => p.type === "minute")?.value ?? 0);
  const nowRate = rateAt(base, valid, wd * 1440 + hour * 60 + minute);
  const max = Math.max(base, ...valid.map((r) => r.rate), 0.001);
  const [h, ht] = healthText(e, tr, lang);
  const [st, stt] = entranceState(e, tr);

  const save = async () => {
    setError(null);
    const rate = parseRate(f.rate);
    if (rate === null) return setError(new Error(tr(...RATE_REQUIRED)));
    // Only what changed since the form was opened, with the version it was
    // opened at: a stale form never restores old values (409 instead).
    const now = formBody({ ...f, rate }, relay);
    const was = formBody({ ...formOf(opened), rate: opened.rate }, relay);
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(now)) if (JSON.stringify(v) !== JSON.stringify(was[k])) body[k] = v;
    if (Object.keys(body).length === 0) return toast({ tone: "info", title: tr("没有改动", "Nothing changed") });
    body.version = opened.version;
    if (body.rate === 0 && !(await confirmFree(e.name))) return;
    if (body.enabled === false) {
      const ok = await confirm({
        title: tr("停用入口？", "Disable the entrance?"),
        description: tr("用户会失去这个入口（从节点移除）。", "Users lose this entrance (removed from the node)."),
        tone: "warning",
      });
      if (!ok) return;
    }
    const saved = await run(() => patch<EntranceView>(`/entrances/${e.id}`, body), {
      ok: tr("入口已保存", "Entrance saved"),
      okDetail:
        body.rate === undefined
          ? undefined
          : tr(
              `倍率 ${opened.rate}x → ${rate}x：从下一次结算起生效，不追溯；改动后 30 秒内按两者中较低的倍率结算。`,
              `Multiplier ${opened.rate}x → ${rate}x: from the next settlement on, not retroactive; for 30 s the lower of the two applies.`,
            ),
      invalidate: [["servers"], ["node-groups"], ["traffic", "entrance", e.id]],
    });
    if (saved) setOpened(saved);
  };
  const saveRules = async () => {
    if (parsed.some((r) => r === null))
      return setError(
        new Error(
          tr("规则不完整：星期、HH:MM 时间与倍率都要填写", "Incomplete rule: weekdays, HH:MM times and a multiplier"),
        ),
      );
    setError(null);
    const r = await runRules(
      () =>
        put<{ warnings: string[] }>(`/entrances/${e.id}/rate-rules`, {
          rules: rules.map((x) => ({ weekdays: x.weekdays, start: x.start, end: x.end, rate: Number(x.rate) })),
        }),
      { invalidate: [["servers"]] },
    );
    if (r)
      toast({
        tone: r.warnings.length ? "info" : "success",
        title: tr("时段规则已保存（写入审计）", "Rules saved (audited)"),
        description: r.warnings.join("\n") || undefined,
      });
  };
  const remove = async () => {
    const ok = await confirm({
      title: tr(`删除中转入口 ${e.name}？`, `Delete relay ${e.name}?`),
      impact: tr("可以用这个入口的用户会失去它", "Users of this entrance lose it"),
      typeToConfirm: e.name,
      action: () => del(`/entrances/${e.id}`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("入口已删除", "Entrance deleted") });
      void run(async () => undefined, { invalidate: [["servers"]] });
      onClose();
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="sm:max-w-2xl"
      title={`${node.display_name || node.name} · ${e.name}`}
      subtitle={
        <span className="flex flex-wrap gap-1.5">
          <Badge tone={relay ? "info" : "outline"}>
            {relay ? tr("中转入口", "Relay entrance") : tr("直连入口", "Direct entrance")}
          </Badge>
          <Badge tone={stt}>{st}</Badge>
          <Badge tone={ht}>{h}</Badge>
          <Badge tone="primary">
            {tr("当前倍率", "Now")} {rateText(Math.round(e.rate_now * 1000))}
          </Badge>
        </span>
      }
      footer={
        relay ? (
          <Button variant="destructive-soft" icon="trash" onClick={remove}>
            {tr("删除中转入口", "Delete relay")}
          </Button>
        ) : undefined
      }
    >
      {e.hidden_since && (
        <div className="mb-3">
          <Callout tone="danger" title={tr("探测失败，已从订阅隐藏", "Probe failing; hidden from subscriptions")}>
            {tr(
              `自 ${dateTime(e.hidden_since)}，连续失败 ${e.health_failures} 次（${e.health_error ?? ""}）。已发告警，恢复后自动显示。`,
              `Since ${dateTime(e.hidden_since)}, ${e.health_failures} failures in a row (${e.health_error ?? ""}). Alerted; it comes back automatically.`,
            )}
          </Callout>
        </div>
      )}
      <SectionTitle>{tr("入口", "Entrance")}</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr("名称（订阅里显示）", "Name (in subscriptions)")}>
          <Input value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} />
        </Field>
        <div className="flex items-end gap-2 pb-2 text-[13px]">
          <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label={tr("启用", "Enabled")} />
          {tr("启用", "Enabled")}
        </div>
        <Field
          label={
            relay
              ? tr("连接地址（中转机）", "Dial host (the relay)")
              : tr("连接地址（留空 = 服务器域名）", "Dial host (empty = server domain)")
          }
        >
          <Input
            value={f.host}
            placeholder={relay ? "" : (server.tls_domain ?? "")}
            onChange={(x) => setF({ ...f, host: x.target.value })}
          />
        </Field>
        <Field
          label={
            relay ? tr("连接端口", "Dial port") : tr("连接端口（留空 = 入站端口）", "Dial port (empty = inbound's)")
          }
        >
          <Input
            inputMode="numeric"
            value={f.port}
            placeholder={relay ? "" : String(node.port ?? "")}
            onChange={(x) => setF({ ...f, port: x.target.value })}
          />
        </Field>
        {relay && (
          <>
            <Field label={tr("监听端口（节点上的派生入站）", "Listen port (derived inbound on the node)")}>
              <Input inputMode="numeric" value={f.listen} onChange={(x) => setF({ ...f, listen: x.target.value })} />
            </Field>
            <EgressField host={f.host} value={f.cidrs} onChange={(v) => setF({ ...f, cidrs: v })} />
          </>
        )}
        <Field
          label={tr("基础倍率（0–100）", "Base multiplier (0–100)")}
          hint={
            nameRate
              ? tr(
                  "已开启「订阅线路名显示倍率」：改倍率会改变线路名，客户端刷新订阅后可能切换线路。",
                  "Multipliers in line names is on: a change renames the line; clients may switch lines after a refresh.",
                )
              : undefined
          }
        >
          <Input
            inputMode="decimal"
            value={f.rate}
            aria-invalid={parseRate(f.rate) === null}
            onChange={(x) => setF({ ...f, rate: x.target.value })}
          />
        </Field>
        <Field label={tr("排序", "Sort")}>
          <Input inputMode="numeric" value={f.sort} onChange={(x) => setF({ ...f, sort: x.target.value })} />
        </Field>
        <TagsField value={f.tags} onChange={(v) => setF({ ...f, tags: v })} />
        <div className="sm:col-span-2">
          <GroupPicker groups={groups} value={f.groups} onChange={(g) => setF({ ...f, groups: g })} />
          <p className="mt-1 text-xs text-muted-foreground">
            {tr("权限：套餐 → 节点组 → 入口。", "Access: plan → node group → entrance.")}
          </p>
        </div>
      </div>
      <div className="mt-3">
        <Button size="sm" variant="primary" loading={busy} onClick={save}>
          {tr("保存入口", "Save entrance")}
        </Button>
      </div>
      {relay && e.health_at && (
        <KV
          className="mt-3"
          items={[
            [
              tr("上次探测", "Last probe"),
              `${dateTime(e.health_at)} · ${e.health_ok ? tr("成功", "ok") : (e.health_error ?? tr("失败", "failed"))}`,
            ],
          ]}
        />
      )}

      <SectionTitle
        actions={
          <Button
            size="sm"
            icon="plus"
            onClick={() => setRules([...rules, { weekdays: [1, 2, 3, 4, 5], start: "20:00", end: "24:00", rate: "2" }])}
            disabled={rules.length >= 24}
          >
            {tr("添加规则", "Add rule")}
          </Button>
        }
      >
        {tr(`时段倍率（${site.timezone}）`, `Time-window multipliers (${site.timezone})`)}
      </SectionTitle>
      <p className="mb-2 text-xs text-muted-foreground">
        {tr(
          "规则外按基础倍率；结束早于开始 = 跨午夜；重叠时取最高。",
          "Outside every rule the base applies; an end before the start crosses midnight; overlaps take the highest.",
        )}
      </p>
      <ul className="space-y-2">
        {rules.map((r, i) => {
          const bad = parsed[i] === null;
          const inOverlap = ov.some((o) => o.a === i || o.b === i);
          return (
            <li
              key={i}
              data-rule={i}
              className={`rounded-md border p-2.5 ${inOverlap ? "border-warning bg-warning-soft/40" : bad ? "border-destructive" : "border-border"}`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-muted-foreground">{tr(`规则 ${i + 1}`, `Rule ${i + 1}`)}</span>
                {WEEKDAYS.map((_, d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={r.weekdays.includes(d + 1)}
                    onClick={() =>
                      setRules(
                        rules.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                weekdays: x.weekdays.includes(d + 1)
                                  ? x.weekdays.filter((w) => w !== d + 1)
                                  : [...x.weekdays, d + 1].sort(),
                              }
                            : x,
                        ),
                      )
                    }
                    className={`h-7 min-w-8 rounded-md border px-1.5 text-xs ${r.weekdays.includes(d + 1) ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                  >
                    {weekdayText(d + 1, tr)}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input
                  aria-label={tr("开始", "Start")}
                  className="w-20"
                  value={r.start}
                  onChange={(x) => setRules(rules.map((y, j) => (j === i ? { ...y, start: x.target.value } : y)))}
                />
                –
                <Input
                  aria-label={tr("结束", "End")}
                  className="w-20"
                  value={r.end}
                  onChange={(x) => setRules(rules.map((y, j) => (j === i ? { ...y, end: x.target.value } : y)))}
                />
                ×
                <Input
                  aria-label={tr("倍率", "Multiplier")}
                  inputMode="decimal"
                  className="w-20"
                  value={r.rate}
                  onChange={(x) => setRules(rules.map((y, j) => (j === i ? { ...y, rate: x.target.value } : y)))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={tr("删除规则", "Remove rule")}
                  onClick={() => setRules(rules.filter((_, j) => j !== i))}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {ov.length > 0 && (
        <div className="mt-2" role="status">
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
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant="primary" loading={busyRules} onClick={saveRules}>
          {tr("保存时段规则", "Save rules")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {tr("按当前编辑的倍率，此刻是", "With these rules it is now")} <b>{nowRate}x</b>
        </span>
      </div>
      <FormError error={error} />
      <div className="scroll-thin mt-4 overflow-x-auto">
        <table className="text-[10px]" aria-label={tr("一周 7×24 倍率热力图", "Week heatmap 7×24")}>
          <tbody>
            {grid.map((row, d) => (
              <tr key={d}>
                <th className="pr-1.5 text-right font-normal text-muted-foreground">{weekdayText(d + 1, tr)}</th>
                {row.map((v, hIdx) => (
                  <td key={hIdx} className="p-px">
                    <div
                      title={`${weekdayText(d + 1, tr)} ${hIdx}:00 · ${v}x`}
                      className={`h-4 w-4 rounded-sm ${d === wd && hIdx === hour ? "ring-2 ring-foreground" : ""}`}
                      style={{
                        backgroundColor: `color-mix(in oklch, var(--chart-1) ${Math.round((v / max) * 85) + 10}%, transparent)`,
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td />
              {Array.from({ length: 24 }, (_, i) => (
                <td key={i} className="text-center text-muted-foreground">
                  {i % 6 === 0 ? i : ""}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {tr(`最后探测 ${ago(e.health_at, lang)}`, `Last probe ${ago(e.health_at, lang)}`)}
      </p>
      <EntranceHistory id={e.id} />
    </Drawer>
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
  const all: string[] = [];
  for (let i = 29; i >= 0; i--) all.push(daysBefore(to, i));
  const by = new Map((q.data?.days ?? []).map((r) => [r.day, r]));
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
      <LineChart
        title={tr("每日原始 / 计费（站点时区）", "Daily raw / billed (site days)")}
        times={all.map((d) => `${d}T12:00:00Z`)}
        format={bytes}
        series={[
          {
            label: tr("原始", "Raw"),
            values: all.map((d) => (by.get(d)?.up_bytes ?? 0) + (by.get(d)?.down_bytes ?? 0)),
            stroke: "stroke-sky-500",
            swatch: "bg-sky-500",
          },
          {
            label: tr("计费", "Billed"),
            values: all.map((d) => by.get(d)?.billed_bytes ?? 0),
            stroke: "stroke-amber-500",
            swatch: "bg-amber-500",
          },
        ]}
      />
      {(q.data?.days.length ?? 0) > 0 && (
        <ul
          className="mt-2 max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border text-[13px]"
          aria-label={tr("每日流量", "Daily traffic")}
        >
          {[...(q.data?.days ?? [])].reverse().map((d) => (
            <li key={d.day} className="flex justify-between px-3 py-1.5">
              <span className="tabular-nums">{d.day}</span>
              <span className="tabular-nums text-muted-foreground">
                {tr("原始", "raw")} {bytes(d.up_bytes + d.down_bytes)} · {tr("计费", "billed")} {bytes(d.billed_bytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <SectionTitle>{tr("倍率变更记录", "Multiplier history")}</SectionTitle>
      {(q.data?.rate_changes.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground">
          {tr("审计日志里没有倍率变更", "No multiplier changes in the audit log")}
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-md border border-border text-[13px]"
          aria-label={tr("倍率变更记录", "Multiplier history")}
        >
          {q.data?.rate_changes.map((c, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-x-3 px-3 py-1.5">
              <span>{what(c)}</span>
              <span className="text-xs text-muted-foreground">
                {dateTime(c.at)} · {c.actor_email ?? c.actor_label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function RelayDialog({ node, groups, onClose }: { node: ServerNode; groups: NodeGroup[]; onClose: () => void }) {
  const tr = useTr();
  const [f, setF] = useState({
    name: "",
    host: "",
    port: "",
    listen: "",
    cidrs: "",
    rate: "1",
    tags: "",
    groups: [] as string[],
  });
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const confirmFree = useConfirmFree();
  const submit = async () => {
    const rate = parseRate(f.rate);
    if (!f.name.trim() || !f.host.trim() || !f.port || !f.listen || !f.cidrs.trim())
      return setError(new Error(tr("请填写全部必填项", "Fill in every required field")));
    if (rate === null) return setError(new Error(tr(...RATE_REQUIRED)));
    if (rate === 0 && !(await confirmFree(f.name.trim()))) return;
    setError(null);
    const r = await run(
      () =>
        post(`/nodes/${node.id}/entrances`, {
          name: f.name.trim(),
          connect_host: f.host.trim(),
          connect_port: Number(f.port),
          listen_port: Number(f.listen),
          source_cidrs: f.cidrs.split(/[\s,]+/).filter(Boolean),
          rate,
          tags: splitTags(f.tags),
          group_ids: f.groups,
        }),
      { ok: tr("中转入口已添加", "Relay entrance added"), invalidate: [["servers"], ["node-groups"]] },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={tr(
        `添加中转入口 · ${node.display_name || node.name}`,
        `Add relay entrance · ${node.display_name || node.name}`,
      )}
      description={tr(
        "外部中转转发到节点上的派生入站（同协议同参数、独立凭据），只接受中转机出口的新连接。",
        "An external relay forwards to a derived inbound on the node (same protocol, own credentials) that only accepts the relay's egress.",
      )}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr("名称", "Name")}>
          <Input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder={tr("例如 IPLC", "e.g. IPLC")}
          />
        </Field>
        <Field label={tr("倍率", "Multiplier")}>
          <Input inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
        </Field>
        <Field label={tr("连接地址（中转机）", "Dial host (the relay)")}>
          <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
        </Field>
        <Field label={tr("连接端口", "Dial port")}>
          <Input inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />
        </Field>
        <Field label={tr("监听端口（节点上）", "Listen port (on the node)")}>
          <Input inputMode="numeric" value={f.listen} onChange={(e) => setF({ ...f, listen: e.target.value })} />
        </Field>
        <EgressField host={f.host} value={f.cidrs} onChange={(v) => setF({ ...f, cidrs: v })} />
        <TagsField value={f.tags} onChange={(v) => setF({ ...f, tags: v })} />
        <div className="sm:col-span-2">
          <GroupPicker groups={groups} value={f.groups} onChange={(g) => setF({ ...f, groups: g })} />
        </div>
        <div className="sm:col-span-2">
          <FormError error={error} />
        </div>
      </div>
    </Dialog>
  );
}
