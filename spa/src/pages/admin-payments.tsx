// W24 / R40 系统设置 → 支付：支付方式列表（可插拔的支付渠道，目前只有支付宝当面付）。
// 后台只有中文。类型手工镜像 src/billing/methods.rs 的 list/MethodView 与
// src/billing/provider.rs 的 schema / TestOutcome。密钥永不下发：表单里留空 = 不修改。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { del, get, post, put } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { fmtDateTime } from "../lib/datetime";
import { copyText } from "../lib/utils";

export interface FieldSpec {
  name: string;
  label: string;
  type: "select" | "text" | "number" | "key" | "bool";
  required?: boolean;
  secret?: boolean;
  default?: number | string | boolean;
  options?: { value: string; label: string }[];
}

export interface KindView {
  id: string;
  label: string;
  schema: FieldSpec[];
}

export interface MethodView {
  id: string;
  kind: string;
  kind_label: string;
  display_name: string;
  icon: string | null;
  sort: number;
  enabled: boolean;
  version: number;
  // The kind's view: non-secret values, `<secret>_set`, fingerprints.
  config: Record<string, unknown>;
  notify_url: string | null;
  active: boolean;
  warnings: string[];
}

export interface PaymentsList {
  kinds: KindView[];
  methods: MethodView[];
  warnings: string[];
}

export interface TestOutcome {
  ok: boolean;
  result: string;
  message: string;
  code: string | null;
  sub_code: string | null;
}

const KEY = ["settings-payments"];

/** The form values of a method (strings; secrets empty = keep). */
type Values = Record<string, string>;

function initialValues(kind: KindView, m: MethodView | null): Values {
  const v: Values = {};
  for (const f of kind.schema) {
    if (f.secret) {
      v[f.name] = "";
      continue;
    }
    const cur = m?.config[f.name];
    v[f.name] =
      cur == null
        ? f.default != null
          ? String(f.default)
          : f.type === "select"
            ? (f.options?.[0]?.value ?? "")
            : ""
        : String(cur);
  }
  return v;
}

/** The `config` object to send: numbers as numbers, empty secrets omitted (= keep). */
export function configBody(kind: KindView, values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of kind.schema) {
    const raw = (values[f.name] ?? "").trim();
    if (f.secret && !raw) continue;
    if (f.type === "number") out[f.name] = raw === "" ? null : Number(raw);
    else if (f.type === "bool") out[f.name] = raw === "true";
    else out[f.name] = raw === "" ? null : raw;
  }
  return out;
}

/** 系统设置 → 支付. */
export function PaymentSettings() {
  const q = useQuery({ queryKey: KEY, queryFn: () => get<PaymentsList>("/settings/payments") });
  const [editing, setEditing] = useState<{ kind: string; method: MethodView | null } | null>(null);
  const [newKind, setNewKind] = useState("");
  if (q.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (q.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {adminErrorText(q.error, "加载支付设置失败")}
      </p>
    );
  const data = q.data;
  const kindOf = (id: string) => data.kinds.find((k) => k.id === id);
  const editKind = editing ? kindOf(editing.kind) : undefined;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>支付方式</h2>
          </CardTitle>
          <CardDescription>
            用户下单时可选择已启用的支付方式（只有一个时不再询问）。可以添加多个同类型的方式（例如两个支付宝商户）。
            配置只保存在数据库中，密钥加密保存、界面不显示；修改后所有面板实例立即生效。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.warnings.length > 0 && <Warnings items={data.warnings} />}
          {data.methods.length === 0 && <p className="text-sm text-muted-foreground">还没有支付方式。</p>}
          <ul className="divide-y divide-border">
            {data.methods.map((m) => (
              <MethodRow key={m.id} m={m} onEdit={() => setEditing({ kind: m.kind, method: m })} />
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="pay-new-kind">添加支付方式</Label>
              <select
                id="pay-new-kind"
                className="h-9 rounded-lg border border-border bg-transparent px-3 text-sm"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value)}
              >
                <option value="">选择类型…</option>
                {data.kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <Button
              variant="outline"
              disabled={!newKind}
              onClick={() => {
                setEditing({ kind: newKind, method: null });
                setNewKind("");
              }}
            >
              添加
            </Button>
          </div>
        </CardContent>
      </Card>
      {editing && editKind && (
        <MethodForm
          key={editing.method ? `${editing.method.id}-${editing.method.version}` : `new-${editing.kind}`}
          kind={editKind}
          method={editing.method}
          onDone={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function Warnings({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      {items.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}

function MethodRow({ m, onEdit }: { m: MethodView; onEdit: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const on = !m.enabled;
    const ok = await confirm({
      title: on ? `启用「${m.display_name}」？` : `停用「${m.display_name}」？`,
      message: on
        ? "启用后用户下单时可以选择该支付方式。"
        : "停用后用户不能再用它下单，未付款订单的异步通知与对账也会停止（已付款订单不受影响）。",
      confirmLabel: on ? "启用" : "停用",
      destructive: !on,
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      // Same values, only `enabled` flips (secrets absent = keep).
      await put(`/settings/payments/${m.id}`, {
        version: m.version,
        display_name: m.display_name,
        icon: m.icon,
        sort: m.sort,
        enabled: on,
        config: keptConfig(m),
      });
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      setMsg({ ok: false, text: adminErrorText(err, on ? "启用失败" : "停用失败") });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<TestOutcome>(`/settings/payments/${m.id}/test`, {});
      setMsg({ ok: r.ok, text: r.sub_code ? `${r.message}（${r.sub_code}）` : r.message });
    } catch (err) {
      setMsg({ ok: false, text: adminErrorText(err, "测试失败") });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `删除「${m.display_name}」？`,
      message: "只有从未被订单使用的支付方式可以删除；已使用的请改为停用。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      await del(`/settings/payments/${m.id}`);
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      setMsg({ ok: false, text: adminErrorText(err, "删除失败") });
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 py-3" data-testid={`pay-method-${m.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{m.display_name}</span>
          <Badge variant="secondary">{m.kind_label}</Badge>
          {m.enabled ? (
            m.active ? (
              <Badge>已启用</Badge>
            ) : (
              <Badge variant="destructive">已启用但不可用</Badge>
            )
          ) : (
            <Badge variant="outline">已停用</Badge>
          )}
          {m.config.environment === "sandbox" && <Badge variant="outline">沙箱</Badge>}
          <span className="text-xs text-muted-foreground">排序 {m.sort}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
            编辑
          </Button>
          <Button size="sm" variant="outline" onClick={() => void test()} disabled={busy}>
            测试连接
          </Button>
          <Button size="sm" variant="outline" onClick={() => void toggle()} disabled={busy}>
            {m.enabled ? "停用" : "启用"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={busy}>
            删除
          </Button>
        </div>
      </div>
      {m.warnings.length > 0 && <Warnings items={m.warnings} />}
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-emerald-700" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </li>
  );
}

/** A method's stored non-secret values as a config body (enable/disable keeps everything). */
function keptConfig(m: MethodView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["environment", "gateway_url", "app_id", "seller_id", "order_timeout_minutes"]) {
    if (k in m.config) out[k] = m.config[k] ?? null;
  }
  return out;
}

function MethodForm({ kind, method, onDone }: { kind: KindView; method: MethodView | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(method?.display_name ?? kind.label);
  const [sort, setSort] = useState(String(method?.sort ?? 0));
  const [enabled, setEnabled] = useState(method?.enabled ?? false);
  const [values, setValues] = useState<Values>(() => initialValues(kind, method));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const cfg = method?.config ?? {};
  const isCustom = values.environment === "custom";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const s = Number(sort);
    if (!Number.isInteger(s)) return setError("排序须为整数");
    const config = configBody(kind, values);
    if (!isCustom) config.gateway_url = null;
    setBusy(true);
    try {
      const body = {
        display_name: name.trim(),
        sort: s,
        enabled,
        config,
      };
      if (method) await put(`/settings/payments/${method.id}`, { ...body, version: method.version, icon: method.icon });
      else await post("/settings/payments", { ...body, kind: kind.id });
      await qc.invalidateQueries({ queryKey: KEY });
      onDone();
    } catch (err) {
      setError(adminErrorText(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{method ? `编辑「${method.display_name}」` : `添加${kind.label}`}</h2>
        </CardTitle>
        <CardDescription>
          {kind.id === "alipay_f2f" && (
            <>
              在支付宝开放平台创建应用并开通「当面付」；用支付宝密钥工具生成 RSA2
              密钥，把下方显示的「应用公钥」上传到开放平台，
              再把开放平台给出的「支付宝公钥」粘贴到这里。沙箱应用请选择「沙箱」环境。
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={save} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pm-name">名称（用户可见）</Label>
              <Input id="pm-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pm-sort">排序（小的在前）</Label>
              <Input
                id="pm-sort"
                type="number"
                className="w-32"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              />
            </div>
          </div>
          {kind.schema.map((f) => {
            if (f.name === "gateway_url" && !isCustom) return null;
            const id = `pm-${f.name}`;
            if (f.type === "bool")
              return (
                <label key={f.name} className="flex items-center gap-2 text-sm">
                  <input
                    id={id}
                    type="checkbox"
                    checked={values[f.name] === "true"}
                    onChange={(e) => set(f.name, e.target.checked ? "true" : "false")}
                  />
                  {f.label}
                </label>
              );
            if (f.type === "select")
              return (
                <div key={f.name} className="space-y-1.5">
                  <Label htmlFor={id}>{f.label}</Label>
                  <select
                    id={id}
                    className="h-9 rounded-lg border border-border bg-transparent px-3 text-sm"
                    value={values[f.name]}
                    onChange={(e) => set(f.name, e.target.value)}
                  >
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            if (f.type === "key")
              return (
                <KeyField
                  key={f.name}
                  id={id}
                  spec={f}
                  value={values[f.name] ?? ""}
                  onChange={(v) => set(f.name, v)}
                  isSet={Boolean(cfg[`${f.name}_set`])}
                  fingerprint={
                    f.secret
                      ? (cfg.app_key_fingerprint as string | undefined)
                      : (cfg[`${f.name}_fingerprint`] as string | undefined)
                  }
                />
              );
            return (
              <div key={f.name} className="space-y-1.5">
                <Label htmlFor={id}>{f.label}</Label>
                <Input
                  id={id}
                  type={f.type === "number" ? "number" : "text"}
                  className={f.type === "number" ? "w-32" : ""}
                  value={values[f.name]}
                  onChange={(e) => set(f.name, e.target.value)}
                  spellCheck={false}
                />
              </div>
            );
          })}
          {typeof cfg.app_public_key === "string" && (
            <div className="space-y-1.5">
              <Label htmlFor="pm-app-pub">应用公钥（上传到支付宝开放平台）</Label>
              <div className="flex gap-2">
                <textarea
                  id="pm-app-pub"
                  readOnly
                  className="min-h-16 w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs"
                  value={cfg.app_public_key}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copyText(cfg.app_public_key as string)}
                >
                  复制
                </Button>
              </div>
            </div>
          )}
          {typeof cfg.alipay_public_key_prev_until === "string" && (
            <p className="text-xs text-muted-foreground">
              已更换支付宝公钥：旧公钥签名的通知在 {fmtDateTime(cfg.alipay_public_key_prev_until)}{" "}
              之前仍被接受（支付宝会重试约 25 小时，避免换钥期间的付款丢失）。
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="pm-notify">异步通知地址</Label>
            <Input
              id="pm-notify"
              readOnly
              className="bg-muted font-mono text-xs"
              value={method?.notify_url ?? "保存后生成"}
            />
            <p className="text-xs text-muted-foreground">
              由「系统设置 →
              站点」的主域名生成，每笔订单下单时自动传给支付宝，无需在支付宝后台填写；更换主域名后新订单自动使用新地址。
              地址含面板的访问前缀，请勿公开。
            </p>
          </div>
          <label htmlFor="pm-enabled" className="flex items-center gap-2 text-sm">
            <input id="pm-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            启用（用户下单时可选）
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
            <Button type="button" variant="outline" onClick={onDone}>
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** A key field: paste PEM / base64 or load a file (read locally, never uploaded as a file). */
function KeyField(props: {
  id: string;
  spec: FieldSpec;
  value: string;
  onChange: (v: string) => void;
  isSet: boolean;
  fingerprint?: string;
}) {
  const { id, spec, value, onChange, isSet, fingerprint } = props;
  async function load(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 16 * 1024) return;
    onChange(await f.text());
    e.target.value = "";
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{spec.label}</Label>
      {spec.secret && isSet && (
        <p className="text-xs text-emerald-700">
          已设置{fingerprint ? `（公钥指纹 ${fingerprint.slice(0, 16)}…）` : ""}；留空则不修改。
        </p>
      )}
      {!spec.secret && fingerprint && (
        <p className="text-xs text-muted-foreground">当前指纹 {fingerprint.slice(0, 16)}…</p>
      )}
      <textarea
        id={id}
        className="min-h-20 w-full rounded-lg border border-border bg-transparent px-3 py-2 font-mono text-xs"
        value={value}
        placeholder={spec.secret ? "粘贴 PEM 或 base64（只在服务器加密保存）" : "粘贴 PEM 或 base64"}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      <input
        type="file"
        aria-label={`从文件读取${spec.label}`}
        accept=".pem,.txt,.key"
        className="text-xs"
        onChange={(e) => void load(e)}
      />
    </div>
  );
}
