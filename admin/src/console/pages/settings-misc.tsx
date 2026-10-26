// 系统设置 → 节点：安装与证书 (SET-20), 测速与健康检查 (SET-21), 出站拦截规则
// (SET-22, formerly 审计规则; rule sets are created and edited in a dialog,
// switches and order go through the save bar) and 更新源与验签 (UPD-01's
// source and automatic check, the extra release keys of SET-09). Turning the
// panel TCP probe off and adding or removing release keys are confirmed on
// save.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, BadgeCheck, Ban, KeyRound, Pencil, Plus, Trash2, Undo2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { del, get, patch, post, put } from "../../shared/api";
import { dateTime } from "../../shared/format";
import { cn } from "../../shared/cn";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Select, Switch, Textarea } from "../../shared/ui/form";
import { EmptyState } from "../../shared/ui/states";
import { settled, useAction } from "../data";
import { RadioCards, UnitInput } from "../components/inputs";
import { StatStrip } from "../components/kit";
import { fresh, useSettings, type SettingsView } from "./settings-data";
import {
  FieldRow,
  Loaded,
  OwnerOnly,
  Panel,
  SRow,
  SwitchRow,
  intError,
  intOf,
  lines,
  urlError,
  useDraft,
  useSavePart,
} from "../components/settings-kit";

// ---------------------------------------------------------------------------
// 安装与证书
// ---------------------------------------------------------------------------

export function InstallSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <InstallForm d={d} />}</Loaded>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function InstallForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const o = d.node_ops;
  const f = useDraft({
    pin: o.install_tls_pin ?? "",
    fallback: o.install_fallback_url ?? "",
    noFallback: o.install_fallback_url === "",
    acmeCustom: !!o.acme_directory_url,
    acmeUrl: o.acme_directory_url ?? "",
    acmeEmail: o.acme_email ?? "",
    remove: o.remove_mode.value ?? "",
  });
  const v = f.value!;
  const pinError =
    v.pin.trim() && !/^sha256\/\/[A-Za-z0-9+/=]{20,}$/.test(v.pin.trim())
      ? tr("格式为 sha256//<base64>", "Format: sha256//<base64>")
      : undefined;
  const fallbackError = v.noFallback ? undefined : urlError(v.fallback.replace("{arch}", "amd64"), tr);
  const acmeError = v.acmeCustom
    ? v.acmeUrl.trim()
      ? urlError(v.acmeUrl, tr)
      : tr("请填写目录地址", "Enter the directory URL")
    : undefined;
  const emailError =
    v.acmeEmail.trim() && !EMAIL.test(v.acmeEmail.trim()) ? tr("邮箱格式不对", "Not an email address") : undefined;
  useSavePart({
    count: f.edited.length,
    errors: [pinError, fallbackError, acmeError, emailError].filter(Boolean).length,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/nodes", {
            version: cur.version,
            install_tls_pin: v.pin.trim() || null,
            install_fallback_url: v.noFallback ? null : v.fallback.trim() || null,
            install_fallback_disabled: v.noFallback,
            acme_directory_url: v.acmeCustom ? v.acmeUrl.trim() || null : null,
            acme_email: v.acmeEmail.trim() || null,
            remove_mode: v.remove || null,
          }),
        { ok: tr("安装与证书设置已保存", "Install settings saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  return (
    <>
      <Group
        title={tr("安装命令", "Install command")}
        footer={tr(
          `agent 连接面板的地址：${d.node.panel_addr ?? tr("（未设置节点通信域名）", "(no node domain set)")}`,
          `Agents dial: ${d.node.panel_addr ?? "(no node domain set)"}`,
        )}
      >
        <FieldRow
          label={tr("安装命令公钥钉扎", "Install TLS pin")}
          description={tr(
            "面板证书不是公共 CA 签发时，安装命令用它校验面板（sha256//…）；留空 = 自动探测",
            "When the panel's certificate is not from a public CA the install command checks it with this pin (sha256//…); empty = probe",
          )}
          error={pinError}
          changed={f.isEdited("pin")}
          stack
        >
          {(a) => <Input {...a} className="font-mono" value={v.pin} onChange={(e) => f.set("pin", e.target.value)} />}
        </FieldRow>
        <SwitchRow
          label={tr("不使用备用下载", "No fallback download")}
          description={tr("面板下载失败时不再尝试备用地址", "Never try the fallback when the panel download fails")}
          checked={v.noFallback}
          onChange={(x) => f.set("noFallback", x)}
          changed={f.isEdited("noFallback")}
        />
        {!v.noFallback && (
          <FieldRow
            label={tr("备用下载地址", "Fallback download URL")}
            description={tr(
              `含 {arch}；留空 = 默认 ${o.install_fallback_default}`,
              `With {arch}; empty = ${o.install_fallback_default}`,
            )}
            error={fallbackError}
            changed={f.isEdited("fallback")}
            stack
          >
            {(a) => (
              <Input
                {...a}
                className="font-mono"
                value={v.fallback}
                onChange={(e) => f.set("fallback", e.target.value)}
              />
            )}
          </FieldRow>
        )}
      </Group>
      <Group
        title={tr("节点 TLS 证书（ACME）", "Node TLS certificates (ACME)")}
        footer={tr(
          "设置了节点域名的节点由 agent 自己申请与续期证书。",
          "Nodes with a node domain get and renew their certificates by ACME on the agent.",
        )}
      >
        <SRow label={tr("ACME 目录", "ACME directory")} changed={f.isEdited("acmeCustom")}>
          <Select
            aria-label={tr("ACME 目录", "ACME directory")}
            className="w-48"
            value={v.acmeCustom ? "custom" : "le"}
            onChange={(e) => f.set("acmeCustom", e.target.value === "custom")}
          >
            <option value="le">Let&apos;s Encrypt</option>
            <option value="custom">{tr("自定义…", "Custom…")}</option>
          </Select>
        </SRow>
        {v.acmeCustom && (
          <FieldRow label={tr("目录地址", "Directory URL")} error={acmeError} changed={f.isEdited("acmeUrl")}>
            {(a) => (
              <Input
                {...a}
                className="font-mono text-footnote sm:w-72"
                placeholder="https://acme.example.com/directory"
                value={v.acmeUrl}
                onChange={(e) => f.set("acmeUrl", e.target.value)}
              />
            )}
          </FieldRow>
        )}
        <FieldRow
          label={tr("ACME 邮箱（可选）", "ACME email (optional)")}
          description={tr("证书机构的到期提醒发到这里", "The CA's expiry notices go here")}
          error={emailError}
          changed={f.isEdited("acmeEmail")}
        >
          {(a) => (
            <Input
              {...a}
              type="email"
              className="sm:w-72"
              value={v.acmeEmail}
              onChange={(e) => f.set("acmeEmail", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Panel
        title={tr("撤权方式", "How access is removed")}
        footer={tr(
          "删除用户、取消套餐或更换凭据时节点怎样断开对方。",
          "How nodes cut a user off when they are deleted, lose their plan or get new credentials.",
        )}
      >
        <RadioCards
          label={tr("撤权方式", "How access is removed")}
          value={v.remove}
          onChange={(x) => f.set("remove", x)}
          cols={3}
          items={[
            {
              value: "",
              title: tr(
                `默认（${o.remove_mode.effective === "rebuild" ? tr("重建", "rebuild") : tr("按用户", "per user")}）`,
                `Default (${o.remove_mode.effective === "rebuild" ? "rebuild" : "per user"})`,
              ),
              desc: tr("跟随内置默认值", "Follows the built-in default"),
            },
            {
              value: "gate",
              title: tr("按用户撤权（推荐）", "Per user (recommended)"),
              desc: tr("只断开被撤权的用户，其他连接不受影响", "Only the removed user is cut off"),
            },
            {
              value: "rebuild",
              title: tr("重建", "Rebuild"),
              desc: tr(
                "每次撤权都重建节点配置并断开节点上的所有连接；只给不支持按用户撤权的旧环境",
                "Every removal rebuilds the node and drops every connection; only for old setups",
              ),
            },
          ]}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------
// 测速与健康检查
// ---------------------------------------------------------------------------

export function ProbeSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <ProbeForm d={d} />}</Loaded>;
}

function ProbeForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const p = d.probe;
  const f = useDraft({
    interval: p.interval_secs.value === null ? "" : String(Math.round(p.interval_secs.value / 60)),
    tcp: p.panel_tcp.value === null ? "" : String(p.panel_tcp.value),
    urls: p.urls.value ?? [],
  });
  const v = f.value!;
  const intervalError = f.isEdited("interval") ? intError(v.interval, 10, 10080, tr, true) : undefined;
  const urls = v.urls.map((u) => u.trim()).filter(Boolean);
  const urlErrors = v.urls.map((u) =>
    u.trim() ? urlError(u, tr, false) : tr("请填写地址或移除这一行", "Enter a URL or remove the line"),
  );
  const tcpOn = (t: string) => (t === "" ? p.panel_tcp.default : t === "true");
  useSavePart({
    count: f.edited.length,
    errors: (intervalError ? 1 : 0) + urlErrors.filter(Boolean).length,
    discard: f.reset,
    save: async () => {
      if (p.panel_tcp.effective && !tcpOn(v.tcp)) {
        const ok = await confirm({
          title: tr("关闭面板 TCP 测速？", "Turn the panel TCP probe off?"),
          description: tr(
            "它同时是中转入口的健康检查。关闭后，中转入口在后端故障时不会再被自动从订阅里隐藏，用户会连到坏的线路上；当前被隐藏的入口会重新出现在订阅里。",
            "It is also the relay health check. Once off, a relay whose backend fails is no longer hidden, so users reach a broken line; relays hidden now come back to subscriptions.",
          ),
          impact: tr(
            "中转入口不会再被自动检查和隐藏：连不通的中转入口会继续留在订阅里",
            "Relay entrances are no longer checked and hidden: an unreachable relay stays in subscriptions",
          ),
          tone: "warning",
          confirmLabel: tr("关闭并保存", "Turn off and save"),
        });
        if (!ok) return false;
      }
      const cur = fresh(qc, ["settings"], d);
      const minutes = intOf(v.interval);
      const r = await run(
        () =>
          put("/settings/probe", {
            version: cur.version,
            interval_secs: minutes === null ? null : minutes * 60,
            urls: urls.length ? urls : null,
            panel_tcp: v.tcp === "" ? null : v.tcp === "true",
          }),
        { ok: tr("测速设置已保存", "Probe settings saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  const shownUrls = v.urls.length ? v.urls : [];
  return (
    <>
      <Group
        title={tr("节点测速", "Node probes")}
        footer={tr(
          "agent 按间隔访问测速地址，结果显示在节点页与门户的节点列表。",
          "Agents fetch the probe URLs at the interval; results show on the nodes page and the portal.",
        )}
      >
        <FieldRow
          label={tr("测速间隔（分钟）", "Probe interval (minutes)")}
          description={tr(
            `10–10080 分钟；留空 = 默认 ${p.interval_secs.default / 60}。间隔越短，节点流量开销越大`,
            `10–10080 minutes; empty = ${p.interval_secs.default / 60}. Shorter costs the nodes more traffic`,
          )}
          error={intervalError}
          changed={f.isEdited("interval")}
        >
          {(a) => (
            <UnitInput
              {...a}
              unit={tr("分钟", "min")}
              invalid={!!intervalError}
              className="w-32"
              placeholder={String(p.interval_secs.default / 60)}
              value={v.interval}
              onChange={(e) => f.set("interval", e.target.value)}
            />
          )}
        </FieldRow>
        <div className="relative px-4 py-3">
          {f.isEdited("urls") && (
            <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" data-changed>
              <span className="sr-only">{tr("已修改", "Edited")}</span>
            </span>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium">
                {tr("测速地址", "Probe URLs")}{" "}
                <span className="font-normal text-faint tabular-nums">{shownUrls.length} / 4</span>
              </div>
              <div className="mt-0.5 text-footnote text-muted-foreground">
                {tr(
                  `节点依次请求；返回 204 或 200 的轻量地址最好。不填 = 默认（${p.urls.default.join(tr("、", ", "))}）`,
                  `Fetched in turn; a light URL answering 204 or 200 is best. None = the default (${p.urls.default.join(", ")})`,
                )}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={Plus}
              disabled={shownUrls.length >= 4}
              onClick={() => f.set("urls", [...v.urls, ""])}
            >
              {tr("添加地址", "Add a URL")}
            </Button>
          </div>
          <div className="mt-2 grid gap-2">
            {shownUrls.map((u, i) => (
              <div key={i} className="grid gap-1">
                <div className="flex gap-2">
                  <Input
                    aria-label={tr(`测速地址 ${i + 1}`, `Probe URL ${i + 1}`)}
                    aria-invalid={urlErrors[i] ? true : undefined}
                    className="font-mono text-footnote"
                    placeholder="https://www.gstatic.com/generate_204"
                    value={u}
                    onChange={(e) =>
                      f.set(
                        "urls",
                        v.urls.map((x, j) => (j === i ? e.target.value : x)),
                      )
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    icon={X}
                    aria-label={tr(`移除测速地址 ${i + 1}`, `Remove probe URL ${i + 1}`)}
                    onClick={() =>
                      f.set(
                        "urls",
                        v.urls.filter((_, j) => j !== i),
                      )
                    }
                  />
                </div>
                {urlErrors[i] && <p className="text-footnote text-destructive">{urlErrors[i]}</p>}
              </div>
            ))}
          </div>
        </div>
      </Group>
      <Group
        title={tr("面板探测", "Panel probe")}
        footer={tr("关闭会在保存时确认。", "Turning it off is confirmed on save.")}
      >
        <SwitchRow
          label={tr("面板 TCP 测速", "Panel TCP probe")}
          description={tr(
            "面板定期 TCP 连接每个入口。它同时决定中转入口的健康：连续失败的中转入口从订阅中隐藏，恢复后自动放回",
            "The panel opens a TCP connection to every entrance. It also decides relay health: a relay that keeps failing is hidden from subscriptions and comes back once it answers",
          )}
          checked={tcpOn(v.tcp)}
          onChange={(x) => f.set("tcp", x === p.panel_tcp.default && p.panel_tcp.value === null ? "" : String(x))}
          changed={f.isEdited("tcp")}
        />
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// 出站拦截规则
// ---------------------------------------------------------------------------

type BlockRule = {
  id: number;
  kind: string;
  builtin_key: string | null;
  name: string;
  pattern: string | null;
  entries: number;
  enabled: boolean;
  sort: number;
  hits_7d: number;
};
type BlockRules = { lists_version: string; nodes_enabled: number; rules: BlockRule[] };

function kindName(k: string, tr: Tr) {
  return (
    (
      {
        domain: tr("域名", "Domains"),
        ip: "IP",
        protocol: tr("协议", "Protocols"),
        builtin: tr("内置", "Built-in"),
      } as Record<string, string>
    )[k] ?? tr("其他", "Other")
  );
}

export function BlockSection() {
  const q = useQuery({ queryKey: ["block-rules"], queryFn: () => get<BlockRules>("/block-rules") });
  return <Loaded q={q}>{(b) => <BlockList b={b} />}</Loaded>;
}

function BlockList({ b }: { b: BlockRules }) {
  const tr = useTr();
  const [run] = useAction();
  const [editing, setEditing] = useState<BlockRule | "new" | null>(null);
  const sorted = [...b.rules].sort((x, y) => x.sort - y.sort || x.id - y.id);
  const f = useDraft({
    order: sorted.map((r) => r.id),
    enabled: Object.fromEntries(sorted.map((r) => [String(r.id), r.enabled])) as Record<string, boolean>,
  });
  const v = f.value!;
  const byId = new Map(b.rules.map((r) => [r.id, r]));
  // A rule created meanwhile is appended; a deleted one dropped.
  const order = [
    ...v.order.filter((id) => byId.has(id)),
    ...sorted.map((r) => r.id).filter((id) => !v.order.includes(id)),
  ];
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const n = [...order];
    [n[i], n[j]] = [n[j], n[i]];
    f.set("order", n);
  };
  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      const r = await run(
        async () => {
          for (const [i, id] of order.entries()) {
            const rule = byId.get(id);
            if (!rule) continue;
            const body: Record<string, unknown> = {};
            const on = v.enabled[String(id)] ?? rule.enabled;
            if (on !== rule.enabled) body.enabled = on;
            if (f.isEdited("order") && rule.sort !== (i + 1) * 10) body.sort = (i + 1) * 10;
            if (Object.keys(body).length) await patch(`/block-rules/${id}`, body);
          }
          return true;
        },
        { ok: tr("拦截规则已保存", "Block rules saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  const hits = b.rules.reduce((n, r) => n + r.hits_7d, 0);
  const builtin = b.rules.filter((r) => r.builtin_key).length;
  return (
    <>
      <StatStrip
        items={[
          {
            label: tr("近 7 天拦截", "Blocked in 7 days"),
            value: hits.toLocaleString(),
            foot: tr("只计数，不记录访问明细", "Counts only, never browsing"),
          },
          {
            label: tr("规则集", "Rule sets"),
            value: b.rules.length,
            foot: tr(
              `内置 ${builtin} · 自定义 ${b.rules.length - builtin}`,
              `${builtin} built-in · ${b.rules.length - builtin} custom`,
            ),
          },
          {
            label: tr("启用拦截的节点", "Nodes blocking"),
            value: b.nodes_enabled,
            foot: (
              <Link to="/nodes" className="text-primary hover:underline">
                {tr("在节点页按节点开关", "Switched per node on the nodes page")}
              </Link>
            ),
          },
        ]}
      />
      <Panel
        title={tr("规则集", "Rule sets")}
        action={
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            className="-mb-1 text-primary"
            onClick={() => setEditing("new")}
          >
            {tr("新建自定义规则", "New custom rule")}
          </Button>
        }
        footer={tr(
          `这里的开关是全局开关：关闭后所有节点都不再使用该规则集；顺序与开关走保存栏。规则变化热更新，不断线。内置列表版本 ${b.lists_version}（v2fly，MIT）。`,
          `These are global switches: off = no node uses the set; order and switches go through the save bar. Changes apply live without dropping connections. Built-in lists ${b.lists_version} (v2fly, MIT).`,
        )}
      >
        {order.length === 0 ? (
          <Card>
            <EmptyState
              title={tr("还没有规则集", "No rule sets yet")}
              description={tr("新建一个自定义规则集开始拦截。", "Create a custom rule set to start blocking.")}
            />
          </Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {order.map((id, i) => {
              const r = byId.get(id)!;
              const on = v.enabled[String(id)] ?? r.enabled;
              const changed = on !== r.enabled || (f.isEdited("order") && sorted.findIndex((x) => x.id === id) !== i);
              return (
                <Card key={id} className={cn("relative grid gap-3 p-4", !on && "opacity-70")} data-rule-set={r.name}>
                  {changed && (
                    <span className="absolute top-3 left-0 h-6 w-[3px] rounded-r-full bg-primary" data-changed>
                      <span className="sr-only">{tr("已修改", "Edited")}</span>
                    </span>
                  )}
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "inline-flex size-9 shrink-0 items-center justify-center rounded-[10px]",
                        r.builtin_key ? "bg-secondary text-muted-foreground" : "bg-destructive-soft text-destructive",
                      )}
                      aria-hidden="true"
                    >
                      <Ban className="size-4.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-body font-semibold">
                        {r.name}
                        {r.builtin_key ? (
                          <Badge tone="neutral">{tr("内置", "Built-in")}</Badge>
                        ) : (
                          <Badge tone="primary">{kindName(r.kind, tr)}</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 text-footnote text-muted-foreground">
                        {r.builtin_key
                          ? tr(
                              "内置规则集随版本更新，只能开关与排序。",
                              "Built in and updated with releases: switch and order only.",
                            )
                          : tr("自定义规则集", "A custom rule set")}
                      </div>
                    </div>
                    <Switch
                      label={r.name}
                      checked={on}
                      onChange={(x) => f.set("enabled", { ...v.enabled, [String(id)]: x })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-footnote">
                    <div>
                      <div className="text-faint">{tr("条目", "Entries")}</div>
                      <div className="font-semibold tabular-nums">{tr(`${r.entries} 条`, `${r.entries}`)}</div>
                    </div>
                    <div>
                      <div className="text-faint">{tr("近 7 天拦截", "Blocked in 7 days")}</div>
                      <div className="font-semibold tabular-nums">
                        {tr(`${r.hits_7d.toLocaleString()} 次`, r.hits_7d.toLocaleString())}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 border-t border-separator pt-2.5">
                    <span className="flex-1 text-footnote text-muted-foreground tabular-nums">
                      {tr(`第 ${i + 1} 位`, `Position ${i + 1}`)}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      icon={ArrowUp}
                      aria-label={tr(`上移 ${r.name}`, `Move ${r.name} up`)}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      icon={ArrowDown}
                      aria-label={tr(`下移 ${r.name}`, `Move ${r.name} down`)}
                      disabled={i === order.length - 1}
                      onClick={() => move(i, 1)}
                    />
                    {!r.builtin_key && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Pencil}
                        aria-label={tr(`编辑 ${r.name}`, `Edit ${r.name}`)}
                        onClick={() => setEditing(r)}
                      >
                        {tr("编辑", "Edit")}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Panel>
      {editing && <RuleDialog rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RuleDialog({ rule, onClose }: { rule: BlockRule | null; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const [kind, setKind] = useState(rule?.kind ?? "domain");
  const [name, setName] = useState(rule?.name ?? "");
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [shown, setShown] = useState(false);
  const [run, busy] = useAction();
  const nameError = name.trim() ? undefined : tr("请填写名称", "Enter a name");
  const patternError = lines(pattern).length ? undefined : tr("至少一条", "At least one entry");
  const submit = async () => {
    setShown(true);
    if (nameError || patternError) return;
    const r = await run(
      () =>
        rule
          ? patch(`/block-rules/${rule.id}`, { name: name.trim(), pattern })
          : post("/block-rules", { kind, name: name.trim(), pattern }),
      { ok: tr("规则已保存", "Rule saved") },
    );
    if (r !== undefined) onClose();
  };
  const remove = async () => {
    if (!rule) return;
    const ok = await confirm({
      title: tr(`删除规则集 ${rule.name}？`, `Delete the rule set ${rule.name}?`),
      impact: tr(
        `开启拦截的节点不再拦截这 ${rule.entries} 条，近 7 天拦截 ${rule.hits_7d} 次`,
        `Nodes stop blocking its ${rule.entries} entries (${rule.hits_7d} blocks in 7 days)`,
      ),
      typeToConfirm: rule.name,
      confirmLabel: tr("删除", "Delete"),
      action: () => del(`/block-rules/${rule.id}`),
    });
    if (ok) {
      await settled();
      onClose();
    }
  };
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={rule ? tr("编辑规则", "Edit rule") : tr("新建自定义规则", "New custom rule")}
      onSubmit={() => void submit()}
      footer={
        <>
          {rule && (
            <Button variant="destructive-soft" className="mr-auto" icon={Trash2} onClick={() => void remove()}>
              {tr("删除规则集", "Delete rule set")}
            </Button>
          )}
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("名称", "Name")} error={shown ? nameError : undefined}>
            <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={tr("类型", "Kind")}>
            <Select value={kind} disabled={!!rule} onChange={(e) => setKind(e.target.value)}>
              <option value="domain">
                {tr("域名（domain: / full: / keyword:）", "Domains (domain: / full: / keyword:)")}
              </option>
              <option value="ip">{tr("IP / 网段", "IPs / networks")}</option>
              <option value="protocol">{tr("协议（如 bittorrent）", "Protocols (e.g. bittorrent)")}</option>
            </Select>
          </Field>
        </div>
        <Field
          label={tr("内容（每行一条）", "Entries (one per line)")}
          hint={tr("最多 1000 行。", "Up to 1000 lines.")}
          error={shown ? patternError : undefined}
        >
          <Textarea rows={10} className="font-mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 更新源与验签
// ---------------------------------------------------------------------------

type UpdateStatus = {
  version: number;
  last_check?: { at: string; ok: boolean; version: string | null; message: string | null } | null;
  source_url: string | null;
  default_source_url: string;
  auto_check: boolean;
  next_auto_check_at: string | null;
  keys_configured: boolean;
};

export function UpdatesSection() {
  const q = useQuery({ queryKey: ["agent-updates"], queryFn: () => get<UpdateStatus>("/agent-updates") });
  const s = useSettings();
  return (
    <>
      <Loaded q={q} rows={3}>
        {(u) => <SourceForm u={u} />}
      </Loaded>
      <Loaded q={s} rows={3}>
        {(d) => <KeysForm d={d} />}
      </Loaded>
    </>
  );
}

function SourceForm({ u }: { u: UpdateStatus }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const f = useDraft({ source: u.source_url ?? "", auto: u.auto_check });
  const v = f.value!;
  const sourceError = urlError(v.source, tr);
  useSavePart({
    count: f.edited.length,
    errors: sourceError ? 1 : 0,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["agent-updates"], u);
      const r = await run(
        () =>
          put("/agent-updates/settings", {
            version: cur.version,
            source_url: v.source.trim() || null,
            auto_check: v.auto,
          }),
        { ok: tr("更新源设置已保存", "Update source saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  return (
    <Group
      title={tr("发布源", "Release source")}
      footer={
        <>
          {tr("检查更新、上传与灰度在", "Checking, uploads and rollouts are on the")}{" "}
          <Link to="/updates" className="text-primary hover:underline">
            {tr("更新页", "Updates page")}
          </Link>
          {tr(
            "。自动检查只下载并校验新版本，从不自动开始灰度。",
            ". Automatic checks only download and verify; they never start a rollout.",
          )}
        </>
      }
    >
      <FieldRow
        label={tr("发布源（GitHub 最新发布 API，留空 = 官方）", "Source (GitHub latest-release API; empty = official)")}
        description={<span className="font-mono break-all">{u.default_source_url}</span>}
        error={sourceError}
        changed={f.isEdited("source")}
        stack
      >
        {(a) => (
          <Input
            {...a}
            className="font-mono"
            placeholder={u.default_source_url}
            value={v.source}
            onChange={(e) => f.set("source", e.target.value)}
          />
        )}
      </FieldRow>
      <SwitchRow
        label={tr("自动检查（每 6 小时）", "Check automatically (every 6 h)")}
        description={
          u.auto_check && u.next_auto_check_at
            ? tr(`下次检查 ${dateTime(u.next_auto_check_at)}`, `Next check ${dateTime(u.next_auto_check_at)}`)
            : tr("默认关", "Off by default")
        }
        checked={v.auto}
        onChange={(x) => f.set("auto", x)}
        changed={f.isEdited("auto")}
      />
      <SRow
        label={tr("上次检查", "Last check")}
        description={
          u.last_check
            ? `${dateTime(u.last_check.at)} · ${
                u.last_check.ok
                  ? u.last_check.version
                    ? tr(`最新 ${u.last_check.version}`, `latest ${u.last_check.version}`)
                    : tr("成功", "OK")
                  : tr("失败", "failed")
              }`
            : tr("还没有检查过", "Never checked")
        }
      >
        <Button asChild size="sm" variant="outline">
          <Link to="/updates">{tr("去更新页", "Open Updates")}</Link>
        </Button>
      </SRow>
    </Group>
  );
}

/** A key line: "<base64> [label]". */
const keyParts = (line: string) => {
  const [key, ...rest] = line.trim().split(/\s+/);
  return { key, label: rest.join(" ") };
};

function KeysForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const [adding, setAdding] = useState(false);
  const f = useDraft({ keys: d.security.extra_release_keys ?? [] });
  const keys = f.value!.keys;
  const official = d.security.release_keys.filter((k) => k.official);
  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      const before = d.security.extra_release_keys ?? [];
      const added = keys.filter((k) => !before.includes(k)).length;
      const removed = before.filter((k) => !keys.includes(k)).length;
      const ok = await confirm({
        title: tr("修改信任的发布公钥？", "Change the trusted release keys?"),
        impacts: [
          { label: tr("新增", "Added"), value: added },
          { label: tr("移除", "Removed"), value: removed },
          ...(removed
            ? [
                {
                  label: tr("由被移除公钥签名的新发布", "New releases signed by a removed key"),
                  value: tr("不能再上传或检查", "can no longer be uploaded or checked"),
                },
              ]
            : []),
        ],
        description: tr(
          "面板用这些公钥（加上内置的官方公钥）校验 agent 发布；节点上的 agent 只信任编译进它的公钥。删除公钥后，用它签名的新发布不能再上传或检查。",
          "The panel verifies agent releases with these keys plus the built-in official ones; agents only trust the keys compiled into them. After a removal, new releases signed with it can no longer be uploaded or checked.",
        ),
        tone: "warning",
        confirmLabel: tr("确认保存", "Save"),
      });
      if (!ok) return false;
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/security", {
            version: cur.version,
            audit_retention_days: cur.security.audit_retention_days.value,
            traffic_daily_retention_days: cur.security.traffic_daily_retention_days.value,
            cloudflare_ranges: cur.security.cloudflare_ranges,
            extra_release_keys: keys.length ? keys : null,
          }),
        { ok: tr("发布公钥已保存", "Release keys saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  const saved = d.security.extra_release_keys ?? [];
  const removed = saved.filter((k) => !keys.includes(k));
  const rows = [
    ...saved.map((line) => ({ line, gone: removed.includes(line), fresh: false })),
    ...keys.filter((k) => !saved.includes(k)).map((line) => ({ line, gone: false, fresh: true })),
  ];
  return (
    <OwnerOnly what={tr("发布公钥", "the release keys")}>
      <Panel
        title={tr("验签公钥", "Signing keys")}
        action={
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            className="-mb-1 text-primary"
            disabled={keys.length >= 16}
            onClick={() => setAdding(true)}
          >
            {tr("添加公钥", "Add a key")}
          </Button>
        }
        footer={tr(
          "自建发布时加入你自己的签名公钥（最多 16 个）。增删在保存时确认。节点上的 agent 只信任编译进它的公钥。",
          "Add your own signing keys for self-built releases (up to 16). Changes are confirmed on save. Agents only trust the keys compiled into them.",
        )}
      >
        <div className="divide-y divide-separator overflow-hidden rounded-xl bg-card shadow-card">
          {official.map((k) => (
            <div key={k.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className="inline-flex size-8 items-center justify-center rounded-[9px] bg-success-soft text-success"
                aria-hidden="true"
              >
                <BadgeCheck className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-body font-semibold">
                  {k.label || tr("官方发布公钥", "Official release key")}
                  <Badge tone="neutral">{tr("内置官方", "Official")}</Badge>
                </div>
                <code className="font-mono text-footnote break-all text-muted-foreground">{k.id}</code>
              </div>
            </div>
          ))}
          {rows.map(({ line, gone, fresh: isNew }) => {
            const k = keyParts(line);
            return (
              <div
                key={line}
                className={cn("relative flex items-center gap-3 px-4 py-3", gone && "bg-destructive-soft/40")}
              >
                {(gone || isNew) && (
                  <span
                    className={cn(
                      "absolute inset-y-2 left-0 w-[3px] rounded-r-full",
                      gone ? "bg-destructive" : "bg-primary",
                    )}
                    data-changed
                  >
                    <span className="sr-only">{tr("已修改", "Edited")}</span>
                  </span>
                )}
                <span
                  className="inline-flex size-8 items-center justify-center rounded-[9px] bg-secondary text-muted-foreground"
                  aria-hidden="true"
                >
                  <KeyRound className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "flex flex-wrap items-center gap-1.5 text-body font-semibold",
                      gone && "text-muted-foreground line-through",
                    )}
                  >
                    {k.label || tr("额外公钥", "Extra key")}
                    {isNew && <Badge tone="primary">{tr("新添加", "New")}</Badge>}
                    {gone && <Badge tone="danger">{tr("保存时移除", "Removed on save")}</Badge>}
                  </div>
                  <code className="font-mono text-footnote text-muted-foreground" title={k.key}>
                    ed25519:{k.key.length > 16 ? `${k.key.slice(0, 4)}…${k.key.slice(-6)}` : k.key}
                  </code>
                </div>
                {gone ? (
                  <Button size="sm" variant="ghost" icon={Undo2} onClick={() => f.set("keys", [...keys, line])}>
                    {tr("撤销", "Undo")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    aria-label={tr(
                      `删除公钥 ${k.label || k.key.slice(0, 12)}`,
                      `Remove key ${k.label || k.key.slice(0, 12)}`,
                    )}
                    onClick={() =>
                      f.set(
                        "keys",
                        keys.filter((x) => x !== line),
                      )
                    }
                  >
                    {tr("移除", "Remove")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
      {adding && (
        <AddKey
          taken={keys.map((x) => keyParts(x).key)}
          onClose={() => setAdding(false)}
          onAdd={(line) => {
            f.set("keys", [...keys, line]);
            setAdding(false);
          }}
        />
      )}
    </OwnerOnly>
  );
}

function AddKey({ taken, onClose, onAdd }: { taken: string[]; onClose: () => void; onAdd: (line: string) => void }) {
  const tr = useTr();
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState(false);
  const k = key.trim();
  const error = !/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(k)
    ? tr("请粘贴 base64 编码的 Ed25519 公钥", "Paste a base64 Ed25519 public key")
    : taken.includes(k)
      ? tr("这个公钥已经在列表里了", "Already listed")
      : undefined;
  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      title={tr("添加发布公钥", "Add a release key")}
      description={tr("添加后在保存栏保存才生效。", "It takes effect once saved in the save bar.")}
      onSubmit={() => {
        setShown(true);
        if (!error) onAdd(label.trim() ? `${k} ${label.trim().replace(/\s+/g, "-")}` : k);
      }}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary">
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label={tr("公钥（base64）", "Key (base64)")} error={shown ? error : undefined}>
          <Input
            data-autofocus
            className="font-mono"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <Field label={tr("标签（可选）", "Label (optional)")}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
