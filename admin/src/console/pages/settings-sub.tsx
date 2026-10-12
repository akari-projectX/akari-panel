// 系统设置 → 订阅：订阅链接与格式 (SET-10 path, SET-12 formats and import
// buttons, SET-26 multipliers in line names) and 分流规则 (SET-11). Turning
// a format off and multipliers on are confirmed on save; a new subscription
// path is a danger-zone action (every old link dies; typed confirmation;
// optional mail to every user).
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Shuffle, Trash2 } from "lucide-react";
import { useState } from "react";
import { put } from "../../shared/api";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Select } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { Mono } from "../kit";
import { fresh, useAccess, useSettings, type Rule, type SettingsView } from "./settings-data";
import {
  DangerZone,
  FieldRow,
  InfoRow,
  Loaded,
  SwitchRow,
  urlError,
  useDraft,
  useSavePart,
} from "../components/settings-kit";

const RULE_TYPES = ["geosite", "geoip", "domain", "domain_suffix", "domain_keyword", "ip_cidr"];
const ACTIONS = ["direct", "proxy", "reject"];
const FORMATS = ["clash", "sing-box", "links"];
const CLIENTS = ["clash", "stash", "shadowrocket", "sing-box", "hiddify"];

function ruleTypeName(t: string, tr: Tr) {
  return (
    (
      {
        geosite: tr("GeoSite 分类", "GeoSite category"),
        geoip: tr("GeoIP 国家/地区", "GeoIP country"),
        domain: tr("完整域名", "Full domain"),
        domain_suffix: tr("域名后缀", "Domain suffix"),
        domain_keyword: tr("域名关键字", "Domain keyword"),
        ip_cidr: tr("IP 段", "IP range"),
      } as Record<string, string>
    )[t] ?? t
  );
}
function actionName(a: string, tr: Tr) {
  return (
    (
      { direct: tr("直连", "Direct"), proxy: tr("代理", "Proxy"), reject: tr("拒绝", "Reject") } as Record<
        string,
        string
      >
    )[a] ?? a
  );
}
function formatName(f: string, tr: Tr) {
  return (
    (
      {
        clash: "Clash / mihomo",
        "sing-box": "sing-box",
        links: tr("通用链接（v2rayN、Shadowrocket…）", "Share links (v2rayN, Shadowrocket…)"),
      } as Record<string, string>
    )[f] ?? f
  );
}
function clientName(c: string) {
  return (
    (
      {
        clash: "Clash Verge / mihomo",
        stash: "Stash",
        shadowrocket: "Shadowrocket",
        "sing-box": "sing-box",
        hiddify: "Hiddify",
      } as Record<string, string>
    )[c] ?? c
  );
}

// ---------------------------------------------------------------------------
// 订阅链接与格式
// ---------------------------------------------------------------------------

export function SubscriptionSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <SubscriptionForm d={d} />}</Loaded>;
}

function SubscriptionForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const f = useDraft({
    formats: d.subscription.formats.effective,
    clients: d.subscription.import_clients.effective,
    name_rate: d.subscription.name_rate,
  });
  const v = f.value!;
  const toggle = (k: "formats" | "clients", id: string, on: boolean) =>
    f.set(k, on ? [...v[k].filter((x) => x !== id), id] : v[k].filter((x) => x !== id));
  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      const off = d.subscription.formats.effective.filter((x) => !v.formats.includes(x));
      if (off.length) {
        const ok = await confirm({
          title: tr(
            `关闭订阅格式 ${off.map((x) => formatName(x, tr)).join("、")}？`,
            `Turn off ${off.map((x) => formatName(x, tr)).join(", ")}?`,
          ),
          impact: tr(
            "使用这种格式的客户端下次刷新订阅时会失败（统一 404）",
            "Clients on this format fail on their next refresh (the uniform 404)",
          ),
          tone: "warning",
          confirmLabel: tr("关闭并保存", "Turn off and save"),
        });
        if (!ok) return false;
      }
      if (v.name_rate && !d.subscription.name_rate) {
        const ok = await confirm({
          title: tr("在订阅线路名里显示倍率？", "Show multipliers in subscription line names?"),
          description: tr(
            "之后每次修改入口的基础倍率都会改变该线路的名字；客户端刷新订阅后会丢失用户选中的线路，可能回落到第一条（直连）。时段倍率不会显示。",
            "Every change of an entrance's base multiplier then renames its line; after a subscription refresh clients lose the user's selected line and may fall back to the first (direct). Time-window multipliers are never shown.",
          ),
          tone: "warning",
          confirmLabel: tr("开启并保存", "Turn on and save"),
        });
        if (!ok) return false;
      }
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/subscription", {
            version: cur.version,
            ...(f.isEdited("formats") ? { formats: FORMATS.filter((x) => v.formats.includes(x)) } : {}),
            ...(f.isEdited("clients") ? { import_clients: CLIENTS.filter((x) => v.clients.includes(x)) } : {}),
            ...(f.isEdited("name_rate") ? { name_rate: v.name_rate } : {}),
          }),
        { ok: tr("订阅设置已保存", "Subscription settings saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Group
        title={tr("订阅格式", "Subscription formats")}
        footer={tr(
          "关闭的格式一律返回统一的 404；以后新增的格式在自定义过的站点上默认关闭。",
          "A disabled format answers the uniform 404; new formats start off on customised sites.",
        )}
      >
        {FORMATS.map((x) => (
          <SwitchRow
            key={x}
            label={formatName(x, tr)}
            name={tr(`订阅格式 ${formatName(x, tr)}`, `Format ${formatName(x, tr)}`)}
            checked={v.formats.includes(x)}
            onChange={(on) => toggle("formats", x, on)}
          />
        ))}
      </Group>
      <Group
        title={tr("门户一键导入按钮", "Portal one-click import buttons")}
        footer={tr("门户订阅页显示哪些客户端的导入按钮。", "Which clients get an import button on the portal.")}
      >
        {CLIENTS.map((x) => (
          <SwitchRow
            key={x}
            label={clientName(x)}
            name={tr(`一键导入 ${clientName(x)}`, `Import ${clientName(x)}`)}
            checked={v.clients.includes(x)}
            onChange={(on) => toggle("clients", x, on)}
          />
        ))}
      </Group>
      <Group
        title={tr("线路名", "Line names")}
        footer={tr(
          "默认关闭：线路名不随倍率变化，客户端记住的选择不会丢。开启后只显示入口的基础倍率（1x 不显示），不显示时段倍率。",
          "Off by default: names never change with the multiplier, so clients keep the selection. When on, names show the entrance's base multiplier (not 1x), never a time-window one.",
        )}
      >
        <SwitchRow
          label={tr("订阅线路名显示倍率", "Multipliers in line names")}
          checked={v.name_rate}
          onChange={(x) => f.set("name_rate", x)}
        >
          {d.subscription.name_rate && (
            <Callout tone="warning">
              {tr(
                "已开启：修改入口倍率会改变线路名，用户刷新订阅后客户端可能切换到其他线路。",
                "On: changing an entrance's multiplier renames its line; after a refresh clients may switch to another line.",
              )}
            </Callout>
          )}
        </SwitchRow>
      </Group>
      <SubPath />
    </>
  );
}

function randomPath(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
}

/** SET-10: the site-wide subscription path; a change kills every old link at once. */
function SubPath() {
  const tr = useTr();
  const q = useAccess();
  const [open, setOpen] = useState(false);
  return (
    <DangerZone>
      <InfoRow
        label={tr("订阅路径", "Subscription path")}
        description={
          <>
            {tr("全站共用的随机路径，当前：", "One random path for the site, now: ")}
            {q.data ? <Mono>{`/${q.data.sub_path}/<token>`}</Mono> : "…"}
            <br />
            {tr("更换后所有用户的旧订阅链接立即失效。", "Changing it kills every user's old link at once.")}
          </>
        }
      >
        <Button size="sm" variant="destructive-soft" disabled={!q.data} onClick={() => setOpen(true)}>
          {tr("更换订阅路径…", "Change the path…")}
        </Button>
      </InfoRow>
      {open && q.data && (
        <SubPathDialog current={q.data.sub_path} version={q.data.version} onClose={() => setOpen(false)} />
      )}
    </DangerZone>
  );
}

function SubPathDialog({ current, version, onClose }: { current: string; version: number; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const [path, setPath] = useState("");
  const [notify, setNotify] = useState(true);
  const [shown, setShown] = useState(false);
  const p = path.trim();
  const error = !/^[A-Za-z0-9_-]{4,64}$/.test(p)
    ? tr("4–64 位字母、数字、- 或 _", "4–64 of A–Z a–z 0–9 - _")
    : p === current
      ? tr("与当前路径相同", "Same as the current path")
      : undefined;
  const submit = async () => {
    setShown(true);
    if (error) return;
    const box: { job?: unknown } = {};
    const ok = await confirm({
      title: tr("应用新的订阅路径？", "Apply the new subscription path?"),
      impact: tr("所有用户的旧订阅链接立即失效", "Every user's old subscription link stops working at once"),
      description: `/${current}/… → /${p}/…`,
      details: notify ? (
        <p className="text-body text-muted-foreground">
          {tr("将邮件通知所有用户新链接（已验证邮箱）。", "Every user (verified address) will be mailed the new link.")}
        </p>
      ) : undefined,
      typeToConfirm: tr("旧链接全部失效", "old links stop"),
      confirmLabel: tr("确认更换", "Change"),
      action: async () => {
        const r = await put<{ notify_job: unknown }>("/settings/access/sub-path", {
          version,
          sub_path: p,
          confirm: true,
          notify_users: notify,
        });
        box.job = r.notify_job;
      },
    });
    if (!ok) return;
    toast({
      tone: "success",
      title: tr("订阅路径已更新（写入审计）", "Subscription path changed (audited)"),
      description: box.job
        ? tr("邮件通知任务已创建（用户 → 批量任务）", "Notice job created (Users → batch jobs)")
        : undefined,
    });
    onClose();
  };
  return (
    <Dialog
      open
      size="sm"
      tone="danger"
      onClose={onClose}
      title={tr("更换订阅路径", "Change the subscription path")}
      description={tr(`当前：/${current}/<token>`, `Current: /${current}/<token>`)}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="destructive">
            {tr("应用新路径", "Apply")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field
          label={tr("新路径（4–64 位字母、数字、- 或 _）", "New path (4–64 of A-Z a-z 0-9 - _)")}
          error={shown ? error : undefined}
        >
          <div className="flex gap-2">
            <Input
              data-autofocus
              className="font-mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onBlur={() => setShown(true)}
            />
            <Button icon={Shuffle} onClick={() => setPath(randomPath())}>
              {tr("随机生成", "Random")}
            </Button>
          </div>
        </Field>
        <label className="flex items-center gap-2.5 text-body">
          <Checkbox
            checked={notify}
            onChange={setNotify}
            label={tr("邮件通知所有用户新链接", "Mail every user the new link")}
          />
          {tr("邮件通知所有用户新链接（已验证邮箱）", "Mail every user (verified address) the new link")}
        </label>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 分流规则
// ---------------------------------------------------------------------------

export function RoutingSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <RoutingForm d={d} />}</Loaded>;
}

function RoutingForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const f = useDraft({
    rules: d.subscription.rules.effective,
    clash: d.subscription.rule_set_clash_url.value ?? "",
    singbox: d.subscription.rule_set_singbox_url.value ?? "",
  });
  const v = f.value!;
  const rules = v.rules;
  const ruleErrors = rules.map((r) => (r.value.trim() ? undefined : tr("请填写值", "Enter a value")));
  const clashError = urlError(v.clash.replace(/\{(kind|name)\}/g, "x"), tr);
  const singboxError = urlError(v.singbox.replace(/\{(kind|name)\}/g, "x"), tr);
  const setRules = (n: Rule[]) => f.set("rules", n);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rules.length) return;
    const n = [...rules];
    [n[i], n[j]] = [n[j], n[i]];
    setRules(n);
  };
  useSavePart({
    count: f.edited.length,
    errors: ruleErrors.filter(Boolean).length + (clashError ? 1 : 0) + (singboxError ? 1 : 0),
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/subscription", {
            version: cur.version,
            rules: rules.map((x) => ({ ...x, value: x.value.trim() })),
            rule_set_clash_url: v.clash.trim() || null,
            rule_set_singbox_url: v.singbox.trim() || null,
          }),
        { ok: tr("分流规则已保存", "Routing saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Group
        title={tr("规则（按顺序匹配，其余走代理）", "Rules (matched in order; the rest goes via the proxy)")}
        footer={tr(
          "Clash 用 rule-providers，sing-box 用 rule_set。最多 64 条。",
          "Clash uses rule-providers, sing-box rule_set. Up to 64 rules.",
        )}
      >
        {rules.map((r, i) => (
          <div key={i} data-rule={i} className="px-4 py-2">
            <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[1.5rem_minmax(0,11rem)_minmax(0,1fr)_minmax(0,7rem)_auto]">
              <span className="tnum text-footnote text-faint">{i + 1}</span>
              <Select
                aria-label={tr("类型", "Type")}
                value={r.type}
                onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
              >
                {RULE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ruleTypeName(t, tr)}
                  </option>
                ))}
              </Select>
              <div className="col-span-2 col-start-2 row-start-2 sm:col-span-1 sm:col-start-auto sm:row-start-auto">
                <Input
                  aria-label={tr("值", "Value")}
                  aria-invalid={ruleErrors[i] ? true : undefined}
                  className="font-mono"
                  value={r.value}
                  onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
              </div>
              <Select
                aria-label={tr("动作", "Action")}
                className="col-start-2 row-start-3 sm:col-start-auto sm:row-start-auto"
                value={r.action}
                onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)))}
              >
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {actionName(a, tr)}
                  </option>
                ))}
              </Select>
              <div className="col-start-3 row-start-1 flex gap-0.5 sm:col-start-auto sm:row-start-auto">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon={ArrowUp}
                  aria-label={tr("上移", "Up")}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon={ArrowDown}
                  aria-label={tr("下移", "Down")}
                  disabled={i === rules.length - 1}
                  onClick={() => move(i, 1)}
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon={Trash2}
                  aria-label={tr("删除规则", "Remove rule")}
                  onClick={() => setRules(rules.filter((_, j) => j !== i))}
                />
              </div>
            </div>
            {ruleErrors[i] && <p className="mt-1 pl-8 text-footnote text-destructive">{ruleErrors[i]}</p>}
          </div>
        ))}
        <div className="px-4 py-2.5">
          <Button
            size="sm"
            variant="soft"
            icon={Plus}
            disabled={rules.length >= 64}
            onClick={() => setRules([...rules, { type: "geosite", value: "", action: "proxy" }])}
          >
            {tr("添加规则", "Add rule")}
          </Button>
        </div>
      </Group>
      <Group
        title={tr("规则集地址", "Rule-set URLs")}
        footer={tr(
          "模板里的 {kind} 与 {name} 会被替换；留空 = 默认地址。",
          "{kind} and {name} are filled in; empty = the default.",
        )}
      >
        <FieldRow
          label={tr("Clash 规则集 URL 模板", "Clash rule-set URL template")}
          description={<span className="font-mono break-all">{d.subscription.rule_set_clash_url.default}</span>}
          error={clashError}
          stack
        >
          {(a) => (
            <Input {...a} className="font-mono" value={v.clash} onChange={(e) => f.set("clash", e.target.value)} />
          )}
        </FieldRow>
        <FieldRow
          label={tr("sing-box 规则集 URL 模板", "sing-box rule-set URL template")}
          description={<span className="font-mono break-all">{d.subscription.rule_set_singbox_url.default}</span>}
          error={singboxError}
          stack
        >
          {(a) => (
            <Input {...a} className="font-mono" value={v.singbox} onChange={(e) => f.set("singbox", e.target.value)} />
          )}
        </FieldRow>
      </Group>
      <DangerZone>
        <InfoRow
          label={tr("恢复默认规则", "Restore the default rules")}
          description={tr(
            `换回内置的 ${d.subscription.rules.default.length} 条规则（广告拦截、国内直连、国外代理），在保存栏保存后生效。`,
            `Back to the ${d.subscription.rules.default.length} built-in rules (ads blocked, domestic direct, the rest proxied); applies once saved.`,
          )}
        >
          {f.isEdited("rules") && <Badge tone="info">{tr("未保存", "Unsaved")}</Badge>}
          <Button
            size="sm"
            variant="destructive-soft"
            onClick={() =>
              void confirm({
                title: tr("恢复默认分流规则？", "Restore the default routing rules?"),
                description: tr(
                  "当前的规则会被替换（保存前可以放弃）。",
                  "The current rules are replaced (you can still discard before saving).",
                ),
                tone: "warning",
                confirmLabel: tr("恢复默认", "Restore"),
              }).then((ok) => ok && setRules(d.subscription.rules.default))
            }
          >
            {tr("恢复默认", "Restore defaults")}
          </Button>
        </InfoRow>
      </DangerZone>
    </>
  );
}
