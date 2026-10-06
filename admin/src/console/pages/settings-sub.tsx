// 系统设置 → 订阅 (SET-10…12): the site-wide subscription path (D11: the
// old one dies at once; optional mail to every user), the routing template
// of the Clash / sing-box subscriptions (W30), rule-list URLs, and the
// format / one-click import switches (PR ② §5).
import { useEffect, useState } from "react";
import { put } from "../../shared/api";
import { useTr, type Tr } from "../../shared/i18n";
import { useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Input,
  Select,
  Skeleton,
} from "../../shared/ui/primitives";
import { Mono, useErrText, useRun } from "../kit";
import { useSettings, type Rule } from "./settings";
import { useAccess } from "./settings-access";

const RULE_TYPES = ["geosite", "geoip", "domain", "domain_suffix", "domain_keyword", "ip_cidr"];
const ACTIONS = ["direct", "proxy", "reject"];
const FORMATS = ["clash", "sing-box", "links"];
const CLIENTS = ["clash", "stash", "shadowrocket", "sing-box", "hiddify"];

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

function randomPath(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
}

export function SubscriptionTab() {
  return (
    <div className="space-y-4">
      <SubPath />
      <RoutingRules />
      <Switches />
    </div>
  );
}

function SubPath() {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrText();
  const q = useAccess();
  const [path, setPath] = useState("");
  const [notify, setNotify] = useState(true);
  const a = q.data;
  if (!a) return <Skeleton className="h-32" />;
  const apply = async () => {
    const box: { job?: unknown } = {};
    const ok = await confirm({
      title: tr("应用新的订阅路径？", "Apply the new subscription path?"),
      impact: tr("所有用户的旧订阅链接立即失效", "Every user's old subscription link stops working at once"),
      description: tr(`/${a.sub_path}/… → /${path.trim()}/…`, `/${a.sub_path}/… → /${path.trim()}/…`),
      details: notify ? (
        <p className="text-[13px] text-muted-foreground">
          {tr("将邮件通知所有用户新链接。", "Every user will be mailed the new link.")}
        </p>
      ) : undefined,
      typeToConfirm: tr("旧链接全部失效", "old links stop"),
      action: async () => {
        const r = await put<{ notify_job: unknown }>("/settings/access/sub-path", {
          version: a.version,
          sub_path: path.trim(),
          confirm: true,
          notify_users: notify,
        });
        box.job = r.notify_job;
      },
    });
    if (ok) {
      toast({
        tone: "success",
        title: tr("订阅路径已更新（写入审计）", "Subscription path changed (audited)"),
        description: box.job
          ? tr("邮件通知任务已创建（用户 → 批量任务）", "Notice job created (Users → batch jobs)")
          : undefined,
      });
      setPath("");
      void q.refetch();
    }
  };
  return (
    <Card>
      <CardHeader
        title={tr("订阅路径（D11）", "Subscription path (D11)")}
        description={tr(
          "全站共用的随机路径；修改后旧路径立即失效。",
          "One random path for the site; a change kills the old path at once.",
        )}
      />
      <CardBody className="space-y-3 text-[13px]">
        <p>
          {tr("当前：", "Current: ")}
          <Mono>/{a.sub_path}/&lt;token&gt;</Mono>
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={tr("新路径（4–64 位字母、数字、- 或 _）", "New path (4–64 of A-Z a-z 0-9 - _)")}>
            <Input className="w-64" value={path} onChange={(e) => setPath(e.target.value)} />
          </Field>
          <Button onClick={() => setPath(randomPath())}>{tr("随机生成", "Random")}</Button>
          <label className="flex items-center gap-2 pb-2">
            <Checkbox
              checked={notify}
              onChange={setNotify}
              label={tr("邮件通知所有用户新链接", "Mail every user the new link")}
            />
            {tr("邮件通知所有用户新链接（已验证邮箱）", "Mail every user (verified address) the new link")}
          </label>
          <Button
            variant="destructive-soft"
            disabled={path.trim().length < 4}
            onClick={() => void apply().catch((e) => toast({ tone: "error", title: errText(e) }))}
          >
            {tr("应用新路径", "Apply")}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function RoutingRules() {
  const tr = useTr();
  const s = useSettings();
  const d = s.data;
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [clash, setClash] = useState<string | null>(null);
  const [singbox, setSingbox] = useState<string | null>(null);
  useEffect(() => {
    if (d && !rules) setRules(d.subscription.rules.effective);
  }, [d, rules]);
  const [run, busy] = useRun();
  if (!d || !rules) return <Skeleton className="h-64" />;
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rules.length) return;
    const n = [...rules];
    [n[i], n[j]] = [n[j], n[i]];
    setRules(n);
  };
  const save = (body: Record<string, unknown>) =>
    run(() => put("/settings/subscription", { version: d.version, ...body }), {
      ok: tr("订阅设置已保存", "Subscription settings saved"),
      invalidate: [["settings"]],
    }).then((r) => {
      if (r !== undefined) {
        setRules(null);
        setClash(null);
        setSingbox(null);
      }
    });
  return (
    <Card>
      <CardHeader
        title={tr("分流规则模板（W30）", "Routing template (W30)")}
        description={tr(
          "Clash 用 rule-providers，sing-box 用 rule_set；按顺序匹配，其余走代理。",
          "Clash uses rule-providers, sing-box rule_set; in order, everything else via the proxy.",
        )}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setRules(d.subscription.rules.default)}>
            {tr("恢复默认", "Default")}
          </Button>
        }
      />
      <CardBody className="space-y-2">
        {rules.map((r, i) => (
          <div key={i} data-rule={i} className="flex flex-wrap items-center gap-2">
            <span className="w-6 text-xs text-muted-foreground">{i + 1}</span>
            <Select
              aria-label={tr("类型", "Type")}
              className="w-40 [&_select]:h-8"
              value={r.type}
              onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
            >
              {RULE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Input
              aria-label={tr("值", "Value")}
              className="h-8 w-44"
              value={r.value}
              onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
            <Select
              aria-label={tr("动作", "Action")}
              className="w-28 [&_select]:h-8"
              value={r.action}
              onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)))}
            >
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {actionName(a, tr)}
                </option>
              ))}
            </Select>
            <Button
              size="icon-sm"
              variant="ghost"
              icon="arrowUp"
              aria-label={tr("上移", "Up")}
              onClick={() => move(i, -1)}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              icon="arrowDown"
              aria-label={tr("下移", "Down")}
              onClick={() => move(i, 1)}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              icon="trash"
              aria-label={tr("删除规则", "Remove rule")}
              onClick={() => setRules(rules.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        <Button
          size="sm"
          icon="plus"
          disabled={rules.length >= 64}
          onClick={() => setRules([...rules, { type: "geosite", value: "", action: "proxy" }])}
        >
          {tr("添加规则", "Add rule")}
        </Button>
        <div className="grid gap-3 pt-3 sm:grid-cols-2">
          <Field
            label={tr(
              "Clash 规则集 URL 模板（{kind} {name}，留空 = 默认）",
              "Clash rule-set URL template ({kind} {name}; empty = default)",
            )}
          >
            <Input
              value={clash ?? d.subscription.rule_set_clash_url.value ?? ""}
              placeholder={d.subscription.rule_set_clash_url.default}
              onChange={(e) => setClash(e.target.value)}
            />
          </Field>
          <Field
            label={tr("sing-box 规则集 URL 模板（留空 = 默认）", "sing-box rule-set URL template (empty = default)")}
          >
            <Input
              value={singbox ?? d.subscription.rule_set_singbox_url.value ?? ""}
              placeholder={d.subscription.rule_set_singbox_url.default}
              onChange={(e) => setSingbox(e.target.value)}
            />
          </Field>
        </div>
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={() =>
            void save({
              rules,
              ...(clash !== null ? { rule_set_clash_url: clash.trim() || null } : {}),
              ...(singbox !== null ? { rule_set_singbox_url: singbox.trim() || null } : {}),
            })
          }
        >
          {tr("保存分流规则", "Save routing")}
        </Button>
      </CardBody>
    </Card>
  );
}

function Switches() {
  const tr = useTr();
  const s = useSettings();
  const [run, busy] = useRun();
  const d = s.data;
  if (!d) return null;
  const formats = d.subscription.formats.effective;
  const clients = d.subscription.import_clients.effective;
  const set = (body: Record<string, unknown>) =>
    void run(() => put("/settings/subscription", { version: d.version, ...body }), {
      ok: tr("已保存", "Saved"),
      invalidate: [["settings"]],
    });
  return (
    <Card>
      <CardHeader
        title={tr("格式与一键导入", "Formats and one-click import")}
        description={tr(
          "关闭的格式一律返回统一 404；新格式对自定义过的站点默认关闭。",
          "A disabled format answers the uniform 404; new formats start off on customised sites.",
        )}
      />
      <CardBody className="space-y-4 text-[13px]">
        <fieldset>
          <legend className="mb-1.5 font-medium">{tr("订阅格式", "Subscription formats")}</legend>
          <div className="flex flex-wrap gap-3">
            {FORMATS.map((f) => (
              <label key={f} className="flex items-center gap-1.5">
                <Checkbox
                  checked={formats.includes(f)}
                  disabled={busy}
                  label={formatName(f, tr)}
                  onChange={(on) => set({ formats: on ? [...formats, f] : formats.filter((x) => x !== f) })}
                />
                {formatName(f, tr)}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 font-medium">{tr("门户一键导入按钮", "Portal one-click import buttons")}</legend>
          <div className="flex flex-wrap gap-3">
            {CLIENTS.map((c) => (
              <label key={c} className="flex items-center gap-1.5">
                <Checkbox
                  checked={clients.includes(c)}
                  disabled={busy}
                  label={clientName(c)}
                  onChange={(on) => set({ import_clients: on ? [...clients, c] : clients.filter((x) => x !== c) })}
                />
                {clientName(c)}
              </label>
            ))}
          </div>
        </fieldset>
      </CardBody>
    </Card>
  );
}
