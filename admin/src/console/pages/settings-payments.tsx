// 系统设置 → 支付 (SET-19, W24/R40): payment methods (kind, enabled /
// unusable / disabled, sandbox, order), a form generated from the kind's
// schema (secrets write-only: empty = keep, keys readable from a file that
// never leaves the browser), the derived app public key, the async notify
// URL, test connection, enable / disable, delete (unused only), and the
// "allow original-route refunds" switch. Keys and accounts: owner only (R47).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { del, get, post, put } from "../../shared/api";
import { useTr } from "../../shared/i18n";
import { Drawer, useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Field,
  Input,
  secretInputProps,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from "../../shared/ui/primitives";
import { CopyButton, FormError, Mono, useErrText, useRun } from "../kit";

type FieldSpec = {
  name: string;
  label: string;
  type: "select" | "text" | "number" | "key" | "bool";
  required?: boolean;
  secret?: boolean;
  default?: number | string | boolean;
  options?: { value: string; label: string }[];
};
type Kind = { id: string; label: string; schema: FieldSpec[] };
type Method = {
  id: string;
  kind: string;
  kind_label: string;
  display_name: string;
  icon: string | null;
  sort: number;
  enabled: boolean;
  version: number;
  config: Record<string, unknown>;
  notify_url: string | null;
  active: boolean;
  warnings: string[];
};

function keptConfig(kind: Kind | undefined, m: Method): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of kind?.schema ?? []) if (!f.secret && f.name in m.config) out[f.name] = m.config[f.name] ?? null;
  return out;
}

export function PaymentsTab() {
  const tr = useTr();
  const errText = useErrText();
  const confirm = useConfirm();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["settings", "payments"],
    queryFn: () => get<{ kinds: Kind[]; methods: Method[]; warnings: string[] }>("/settings/payments"),
  });
  const [editing, setEditing] = useState<{ kind: Kind; method: Method | null } | null>(null);
  const [newKind, setNewKind] = useState("");
  const [run] = useRun();
  if (!q.data) return q.error ? <FormError error={q.error} /> : <Skeleton className="h-48" />;
  const d = q.data;
  const kindOf = (id: string) => d.kinds.find((k) => k.id === id);
  return (
    <div className="space-y-4">
      {d.warnings.length > 0 && (
        <Callout tone="warning">
          <ul className="list-disc pl-4">
            {d.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
      <Card>
        <CardHeader
          title={tr("支付方式", "Payment methods")}
          actions={
            <div className="flex gap-2">
              <Select
                aria-label={tr("类型", "Kind")}
                className="w-40 [&_select]:h-8"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value)}
              >
                <option value="">{tr("选择类型…", "Choose a kind…")}</option>
                {d.kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                icon="plus"
                disabled={!newKind}
                onClick={() => {
                  const k = kindOf(newKind);
                  if (k) setEditing({ kind: k, method: null });
                }}
              >
                {tr("添加支付方式", "Add method")}
              </Button>
            </div>
          }
        />
        <ul className="divide-y divide-border">
          {d.methods.length === 0 && (
            <li className="px-5 py-4 text-[13px] text-muted-foreground">
              {tr("还没有支付方式。", "No payment methods yet.")}
            </li>
          )}
          {d.methods.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-[13px] sm:px-5">
              <span className="font-medium">{m.display_name}</span>
              <Badge tone="outline">{m.kind_label}</Badge>
              <Badge tone={!m.enabled ? "neutral" : m.active ? "success" : "warning"}>
                {!m.enabled ? tr("已停用", "Disabled") : m.active ? tr("可用", "Active") : tr("不可用", "Unusable")}
              </Badge>
              {m.config.environment === "sandbox" && <Badge tone="info">{tr("沙箱", "Sandbox")}</Badge>}
              <span className="text-xs text-muted-foreground">{tr(`排序 ${m.sort}`, `sort ${m.sort}`)}</span>
              <span className="ml-auto flex flex-wrap gap-1">
                <Button
                  size="sm"
                  onClick={async () => {
                    try {
                      const r = await post<{ ok: boolean; message: string; sub_code: string | null }>(
                        `/settings/payments/${m.id}/test`,
                      );
                      toast({
                        tone: r.ok ? "success" : "error",
                        title: r.sub_code ? `${r.message}（${r.sub_code}）` : r.message,
                      });
                    } catch (e) {
                      toast({ tone: "error", title: errText(e) });
                    }
                  }}
                >
                  {tr("测试连接", "Test")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    const k = kindOf(m.kind);
                    if (k) setEditing({ kind: k, method: m });
                  }}
                >
                  {tr("编辑", "Edit")}
                </Button>
                <Button
                  size="sm"
                  onClick={async () => {
                    const on = !m.enabled;
                    const ok = await confirm({
                      title: on
                        ? tr(`启用 ${m.display_name}？`, `Enable ${m.display_name}?`)
                        : tr(`停用 ${m.display_name}？`, `Disable ${m.display_name}?`),
                      description: on
                        ? tr("启用后用户下单时可以选择它。", "Users can pick it when ordering.")
                        : tr(
                            "停用后不能再用它下单，未付款订单的通知与对账也会停止。",
                            "No new orders with it; notices and reconciliation of unpaid orders stop.",
                          ),
                      tone: on ? "default" : "warning",
                    });
                    if (ok)
                      await run(
                        () =>
                          put(`/settings/payments/${m.id}`, {
                            version: m.version,
                            display_name: m.display_name,
                            icon: m.icon,
                            sort: m.sort,
                            enabled: on,
                            config: keptConfig(kindOf(m.kind), m),
                          }),
                        { ok: tr("已保存", "Saved"), invalidate: [["settings", "payments"]] },
                      );
                  }}
                >
                  {m.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
                </Button>
                <Button
                  size="sm"
                  variant="destructive-soft"
                  onClick={async () => {
                    const ok = await confirm({
                      title: tr(`删除 ${m.display_name}？`, `Delete ${m.display_name}?`),
                      description: tr(
                        "只能删除从未被订单使用过的支付方式。",
                        "Only methods no order ever used can be deleted.",
                      ),
                      typeToConfirm: m.display_name,
                      action: () => del(`/settings/payments/${m.id}`),
                    });
                    if (ok)
                      void run(async () => undefined, {
                        ok: tr("已删除", "Deleted"),
                        invalidate: [["settings", "payments"]],
                      });
                  }}
                >
                  {tr("删除", "Delete")}
                </Button>
              </span>
              {m.warnings.length > 0 && <span className="w-full text-xs text-warning">{m.warnings.join("；")}</span>}
            </li>
          ))}
        </ul>
      </Card>
      {editing && <MethodDrawer kind={editing.kind} method={editing.method} onClose={() => setEditing(null)} />}
    </div>
  );
}

function MethodDrawer({ kind, method, onClose }: { kind: Kind; method: Method | null; onClose: () => void }) {
  const tr = useTr();
  const [name, setName] = useState(method?.display_name ?? kind.label);
  const [sort, setSort] = useState(String(method?.sort ?? 0));
  const [enabled, setEnabled] = useState(method?.enabled ?? false);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of kind.schema) {
      if (f.secret) v[f.name] = "";
      else {
        const cur = method?.config[f.name];
        v[f.name] =
          cur == null
            ? f.default != null
              ? String(f.default)
              : f.type === "select"
                ? (f.options?.[0]?.value ?? "")
                : ""
            : String(cur);
      }
    }
    return v;
  });
  const [run, busy] = useRun();
  const cfg = method?.config ?? {};
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const save = async () => {
    const config: Record<string, unknown> = {};
    for (const f of kind.schema) {
      const raw = (values[f.name] ?? "").trim();
      if (f.secret && !raw) continue;
      config[f.name] =
        f.type === "number"
          ? raw === ""
            ? null
            : Number(raw)
          : f.type === "bool"
            ? raw === "true"
            : raw === ""
              ? null
              : raw;
    }
    const body = { display_name: name.trim(), sort: Number(sort) || 0, enabled, config };
    const r = await run(
      () =>
        method
          ? put(`/settings/payments/${method.id}`, { ...body, version: method.version, icon: method.icon })
          : post("/settings/payments", { ...body, kind: kind.id }),
      { ok: tr("支付方式已保存", "Payment method saved"), invalidate: [["settings", "payments"]] },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Drawer
      open
      onClose={onClose}
      width="sm:max-w-2xl"
      title={
        method
          ? tr(`编辑 ${method.display_name}`, `Edit ${method.display_name}`)
          : tr(`添加 ${kind.label}`, `Add ${kind.label}`)
      }
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("名称（用户可见）", "Name (shown to users)")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={tr("排序（小的在前）", "Sort (lower first)")}>
            <Input inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <Switch checked={enabled} onChange={setEnabled} label={tr("启用", "Enabled")} />
          {tr("启用", "Enabled")}
        </label>
        {kind.schema.map((f) => {
          const fp =
            f.name === "app_private_key"
              ? (cfg.app_key_fingerprint as string | undefined)
              : (cfg[`${f.name}_fingerprint`] as string | undefined);
          const isSet = !!cfg[`${f.name}_set`];
          if (f.type === "bool")
            return (
              <label key={f.name} className="flex items-center gap-2 text-[13px]">
                <Switch checked={values[f.name] === "true"} onChange={(v) => set(f.name, String(v))} label={f.label} />
                {f.label}
              </label>
            );
          if (f.type === "select")
            return (
              <Field key={f.name} label={f.label}>
                <Select value={values[f.name]} onChange={(e) => set(f.name, e.target.value)}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
            );
          if (f.type === "key")
            return (
              <Field
                key={f.name}
                label={f.label}
                hint={
                  isSet
                    ? tr(
                        `已设置${fp ? `（指纹 ${fp.slice(0, 16)}…）` : ""}；留空 = 不修改`,
                        `Set${fp ? ` (fingerprint ${fp.slice(0, 16)}…)` : ""}; empty = keep`,
                      )
                    : fp
                      ? tr(`当前指纹 ${fp.slice(0, 16)}…`, `Fingerprint ${fp.slice(0, 16)}…`)
                      : undefined
                }
              >
                <Textarea
                  rows={4}
                  value={values[f.name]}
                  onChange={(e) => set(f.name, e.target.value)}
                  placeholder="-----BEGIN …"
                />
                <input
                  type="file"
                  aria-label={tr(`从文件读取 ${f.label}`, `Read ${f.label} from a file`)}
                  className="mt-1 text-xs"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) set(f.name, await file.text());
                  }}
                />
              </Field>
            );
          return (
            <Field
              key={f.name}
              label={f.label}
              hint={f.secret && isSet ? tr("已设置；留空 = 不修改", "Set; empty = keep") : undefined}
            >
              <Input
                {...(f.secret ? secretInputProps : { type: "text", autoComplete: "off" })}
                inputMode={f.type === "number" ? "numeric" : undefined}
                value={values[f.name]}
                onChange={(e) => set(f.name, e.target.value)}
              />
            </Field>
          );
        })}
        {typeof cfg.app_public_key === "string" && (
          <Field label={tr("应用公钥（上传到支付宝开放平台）", "App public key (upload to the Alipay console)")}>
            <div className="flex items-start gap-2">
              <Textarea rows={3} readOnly value={cfg.app_public_key} />
              <CopyButton text={cfg.app_public_key} />
            </div>
          </Field>
        )}
        {method?.notify_url && (
          <p className="text-[13px]">
            {tr("异步通知地址：", "Notify URL: ")}
            <Mono>{method.notify_url}</Mono>
          </p>
        )}
      </div>
    </Drawer>
  );
}
