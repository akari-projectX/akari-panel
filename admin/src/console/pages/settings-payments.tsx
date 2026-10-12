// 系统设置 → 收款与返利：支付方式 (SET-19, W24/R40) and 邀请返利 (FIN-05,
// moved here from the finance page). Payment methods: "添加" opens a kind
// chooser, then the editor dialog (a form from the kind's schema; secrets
// write-only, keys readable from a file that never leaves the browser);
// order (arrows) and enabled go through the save bar; test per method;
// delete in the danger zone (typed name). Keys and accounts are the owner's
// (R47): other admins see the section read-only.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CreditCard, GripVertical, Lock, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { del, get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { centsToYuanText, parseYuan } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Group, Tile } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Select, Switch, SwitchField, Textarea, secretInputProps } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { MenuItem, RowMenu } from "../../shared/ui/menu";
import { EmptyState } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { settled, useAction } from "../data";
import { CopyButton, Mono, useErrText } from "../kit";
import { useMe } from "../session";
import { fresh } from "./settings-data";
import { PAY_TILE_DEFAULT, PAY_TILES } from "./settings-ia";
import {
  DangerZone,
  FieldRow,
  InfoRow,
  Loaded,
  SwitchRow,
  Warnings,
  intError,
  intOf,
  useDraft,
  useSavePart,
} from "./settings-kit";

// ---------------------------------------------------------------------------
// 支付方式
// ---------------------------------------------------------------------------

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
type Payments = { kinds: Kind[]; methods: Method[]; warnings: string[] };

/** The non-secret config as stored (a PUT without secrets keeps them). */
function keptConfig(kind: Kind | undefined, m: Method): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of kind?.schema ?? []) if (!f.secret && f.name in m.config) out[f.name] = m.config[f.name] ?? null;
  return out;
}

export function PaymentsSection() {
  const q = useQuery({
    queryKey: ["settings", "payments"],
    queryFn: () => get<Payments>("/settings/payments"),
  });
  return <Loaded q={q}>{(p) => <PaymentList p={p} />}</Loaded>;
}

function PaymentList({ p }: { p: Payments }) {
  const tr = useTr();
  const me = useMe();
  const owner = me.is_owner;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const [choosing, setChoosing] = useState(false);
  const [editing, setEditing] = useState<{ kind: Kind; method: Method | null } | null>(null);
  const kindOf = (id: string) => p.kinds.find((k) => k.id === id);
  const sorted = [...p.methods].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  const f = useDraft({
    order: sorted.map((m) => m.id),
    enabled: Object.fromEntries(sorted.map((m) => [m.id, m.enabled])) as Record<string, boolean>,
  });
  const v = f.value!;
  const byId = new Map(p.methods.map((m) => [m.id, m]));
  const order = [
    ...v.order.filter((id) => byId.has(id)),
    ...sorted.map((m) => m.id).filter((id) => !v.order.includes(id)),
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
      const off = order.filter((id) => byId.get(id)!.enabled && v.enabled[id] === false).map((id) => byId.get(id)!);
      if (off.length) {
        const ok = await confirm({
          title: tr(
            `停用 ${off.map((m) => m.display_name).join("、")}？`,
            `Disable ${off.map((m) => m.display_name).join(", ")}?`,
          ),
          impact: tr(
            "不能再用它下单；未付款订单的通知与对账也会停止",
            "No new orders with it; notices and reconciliation of unpaid orders stop",
          ),
          tone: "warning",
          confirmLabel: tr("停用并保存", "Disable and save"),
        });
        if (!ok) return false;
      }
      const r = await run(
        async () => {
          const cur = fresh(qc, ["settings", "payments"], p);
          for (const [i, id] of order.entries()) {
            const m = cur.methods.find((x) => x.id === id);
            if (!m) continue;
            const enabled = v.enabled[id] ?? m.enabled;
            const sort = f.isEdited("order") ? (i + 1) * 10 : m.sort;
            if (enabled === m.enabled && sort === m.sort) continue;
            await put(`/settings/payments/${m.id}`, {
              version: m.version,
              display_name: m.display_name,
              icon: m.icon,
              sort,
              enabled,
              config: keptConfig(kindOf(m.kind), m),
            });
          }
          return true;
        },
        { ok: tr("支付方式已保存", "Payment methods saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  const nextSort = (Math.max(0, ...p.methods.map((m) => m.sort)) || 0) + 10;
  const [dragging, setDragging] = useState<string | null>(null);
  const dropOn = (target: string) => {
    if (!dragging || dragging === target) return;
    const n = order.filter((x) => x !== dragging);
    n.splice(n.indexOf(target) + (order.indexOf(dragging) < order.indexOf(target) ? 1 : 0), 0, dragging);
    f.set("order", n);
  };
  const notify = p.methods.filter((m) => m.notify_url);
  return (
    <>
      <Warnings items={p.warnings} />
      <Group
        title={tr("收款渠道", "Payment channels")}
        footer={
          owner
            ? tr(
                "拖动（或用 ↑↓ 键）调整门户里的显示顺序；启停与顺序在保存栏保存。",
                "Drag (or use ↑↓) to set the order on the portal; enabling and order are saved in the save bar.",
              )
            : tr(
                "新建、删除、启停、排序以及密钥与账号只有所有者能改；你可以查看与测试。",
                "Only the owner creates, deletes, enables, orders and changes keys and accounts; you can view and test.",
              )
        }
      >
        {order.length === 0 && (
          <EmptyState
            icon={CreditCard}
            title={tr("还没有支付方式", "No payment methods yet")}
            description={tr("添加一个支付方式后，用户才能在线付款。", "Users can pay online once a method is added.")}
          />
        )}
        {order.map((id, i) => {
          const m = byId.get(id)!;
          const on = v.enabled[id] ?? m.enabled;
          return (
            <PaymentRow
              key={id}
              m={m}
              on={on}
              owner={owner}
              first={i === 0}
              last={i === order.length - 1}
              dragging={dragging === id}
              onDrag={(x) => setDragging(x ? id : null)}
              onDrop={() => dropOn(id)}
              onMove={(dir) => move(i, dir)}
              onToggle={(x) => f.set("enabled", { ...v.enabled, [id]: x })}
              onEdit={() => {
                const k = kindOf(m.kind);
                if (k) setEditing({ kind: k, method: m });
              }}
            />
          );
        })}
        {owner && (
          <div className="px-4 py-2.5">
            <Button size="sm" variant="soft" icon={Plus} onClick={() => setChoosing(true)}>
              {tr("添加渠道", "Add a channel")}
              <Lock className="!size-3 opacity-70" aria-hidden="true" />
            </Button>
          </div>
        )}
      </Group>
      {notify.length > 0 && (
        <Group
          title={tr("支付通知地址", "Payment notice URLs")}
          footer={tr(
            "填到支付平台的「授权回调 / 异步通知地址」。地址里含后台前缀，不要公开。",
            "Enter it as the platform's callback / notify URL. It contains the console prefix: keep it private.",
          )}
        >
          {notify.map((m) => (
            <InfoRow
              key={m.id}
              label={<span className="block font-mono text-footnote break-all">{m.notify_url}</span>}
              description={notify.length > 1 ? m.display_name : undefined}
            >
              <CopyButton text={m.notify_url!} />
            </InfoRow>
          ))}
        </Group>
      )}
      {owner && p.methods.length > 0 && (
        <DangerZone>
          {p.methods.map((m) => (
            <InfoRow
              key={m.id}
              label={
                <span className="flex items-center gap-1.5">
                  {tr(`删除「${m.display_name}」`, `Delete "${m.display_name}"`)}
                  <Lock className="size-3 text-faint" aria-label={tr("仅所有者", "Owner only")} />
                </span>
              }
              description={tr(
                "只能删除从未被订单使用过的支付方式；用过的请停用。",
                "Only methods no order ever used can be deleted; disable used ones instead.",
              )}
            >
              <Button
                size="sm"
                variant="destructive-soft"
                icon={Trash2}
                aria-label={tr(`删除 ${m.display_name}`, `Delete ${m.display_name}`)}
                onClick={() =>
                  void confirm({
                    title: tr(`删除支付方式 ${m.display_name}？`, `Delete the payment method ${m.display_name}?`),
                    impact: tr(
                      "用户不能再选择它；它的密钥一并删除",
                      "Users can no longer pick it; its keys are deleted",
                    ),
                    typeToConfirm: m.display_name,
                    confirmLabel: tr("删除", "Delete"),
                    action: () => del(`/settings/payments/${m.id}`),
                  })
                }
              >
                {tr("删除", "Delete")}
              </Button>
            </InfoRow>
          ))}
        </DangerZone>
      )}
      {choosing && (
        <KindChooser
          kinds={p.kinds}
          onClose={() => setChoosing(false)}
          onPick={(k) => {
            setChoosing(false);
            setEditing({ kind: k, method: null });
          }}
        />
      )}
      {editing && (
        <MethodDialog
          kind={editing.kind}
          method={editing.method}
          owner={owner}
          nextSort={nextSort}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** The coloured tile of a payment kind (system-settings style; colours are tile data like the IA's). */
function KindTile({ kind, size = 32 }: { kind: string; size?: number }) {
  const t = PAY_TILES[kind];
  return (
    <Tile color={t?.tint ?? PAY_TILE_DEFAULT} size={size}>
      {t ? <span className="text-callout font-bold not-italic">{t.glyph}</span> : <CreditCard />}
    </Tile>
  );
}

function PaymentRow({
  m,
  on,
  owner,
  first,
  last,
  dragging,
  onDrag,
  onDrop,
  onMove,
  onToggle,
  onEdit,
}: {
  m: Method;
  on: boolean;
  owner: boolean;
  first: boolean;
  last: boolean;
  dragging: boolean;
  onDrag: (on: boolean) => void;
  onDrop: () => void;
  onMove: (dir: -1 | 1) => void;
  onToggle: (v: boolean) => void;
  onEdit: () => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const errText = useErrText();
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    try {
      const r = await post<{ ok: boolean; message: string; sub_code: string | null }>(
        `/settings/payments/${m.id}/test`,
      );
      toast({
        tone: r.ok ? "success" : "error",
        title: r.ok ? tr("连接正常", "Connection works") : tr("连接测试失败", "The connection test failed"),
        description: r.sub_code ? `${r.message}（${r.sub_code}）` : r.message,
      });
    } catch (e) {
      toast({ tone: "error", title: errText(e) });
    } finally {
      setTesting(false);
    }
  };
  const app = typeof m.config.app_id === "string" && m.config.app_id ? m.config.app_id : null;
  return (
    <div
      className={cn("px-4 py-3 transition-opacity", dragging && "opacity-50")}
      data-method={m.display_name}
      draggable={owner}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDrag(true);
      }}
      onDragEnd={() => onDrag(false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {owner && (
          <button
            type="button"
            className="-ml-1 inline-flex size-6 cursor-grab items-center justify-center rounded-sm text-faint hover:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing pointer-coarse:hidden"
            aria-label={tr(`调整顺序 ${m.display_name}（↑↓）`, `Reorder ${m.display_name} (↑↓)`)}
            title={tr("拖动或用 ↑↓ 键调整顺序", "Drag or press ↑↓ to reorder")}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" && !first) {
                e.preventDefault();
                onMove(-1);
              } else if (e.key === "ArrowDown" && !last) {
                e.preventDefault();
                onMove(1);
              }
            }}
          >
            <GripVertical className="size-4" aria-hidden="true" />
          </button>
        )}
        <KindTile kind={m.kind} />
        <div className="min-w-0 flex-1 basis-40">
          <div className="text-body font-semibold">{m.display_name}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-footnote text-muted-foreground">
            <span className="truncate">
              {m.kind_label}
              {app && tr(` · 应用 ${app.slice(0, 7)}…`, ` · app ${app.slice(0, 7)}…`)}
            </span>
            {m.config.environment === "sandbox" && <Badge tone="info">{tr("沙箱", "Sandbox")}</Badge>}
          </div>
        </div>
        <Badge tone={!m.enabled ? "outline" : m.active ? "success" : "warning"} dot={m.enabled}>
          {!m.enabled ? tr("停用", "Off") : m.active ? tr("启用", "On") : tr("不可用", "Unusable")}
        </Badge>
        <Button
          size="sm"
          variant="outline"
          loading={testing}
          aria-label={tr(`测试连接 ${m.display_name}`, `Test ${m.display_name}`)}
          onClick={() => void test()}
        >
          {tr("测试", "Test")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onEdit}
          aria-label={tr(`编辑 ${m.display_name}`, `Edit ${m.display_name}`)}
        >
          {owner ? tr("编辑", "Edit") : tr("查看", "View")}
        </Button>
        {owner && (
          <span className="pointer-fine:hidden">
            <RowMenu label={tr(`调整顺序 ${m.display_name}`, `Reorder ${m.display_name}`)}>
              {() => (
                <>
                  <MenuItem icon={ArrowUp} disabled={first} onClick={() => onMove(-1)}>
                    {tr("上移", "Move up")}
                  </MenuItem>
                  <MenuItem icon={ArrowDown} disabled={last} onClick={() => onMove(1)}>
                    {tr("下移", "Move down")}
                  </MenuItem>
                </>
              )}
            </RowMenu>
          </span>
        )}
        <Switch
          label={tr(`启用 ${m.display_name}`, `Enable ${m.display_name}`)}
          checked={on}
          disabled={!owner}
          onChange={onToggle}
        />
      </div>
      {m.warnings.length > 0 && (
        <p className="mt-1.5 text-footnote text-warning sm:pl-[4.25rem]">{m.warnings.join("；")}</p>
      )}
    </div>
  );
}

function KindChooser({ kinds, onClose, onPick }: { kinds: Kind[]; onClose: () => void; onPick: (k: Kind) => void }) {
  const tr = useTr();
  return (
    <Dialog
      open
      size="sm"
      icon={CreditCard}
      onClose={onClose}
      title={tr("添加支付方式", "Add a payment method")}
      description={tr("选择渠道类型。", "Choose the kind of channel.")}
      footer={<Button onClick={onClose}>{tr("取消", "Cancel")}</Button>}
    >
      <div className="grid gap-2">
        {kinds.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => onPick(k)}
            className="flex min-h-12 items-center gap-3 rounded-xl bg-window px-4 py-2.5 text-left text-body font-medium ring-1 ring-border transition-colors ring-inset hover:bg-accent"
          >
            <CreditCard className="size-4 text-primary" aria-hidden="true" />
            {k.label}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function MethodDialog({
  kind,
  method,
  owner,
  nextSort,
  onClose,
}: {
  kind: Kind;
  method: Method | null;
  owner: boolean;
  nextSort: number;
  onClose: () => void;
}) {
  const tr = useTr();
  const [name, setName] = useState(method?.display_name ?? kind.label);
  const [enabled, setEnabled] = useState(method?.enabled ?? false);
  const [shown, setShown] = useState(false);
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
  const [run, busy] = useAction();
  const cfg = method?.config ?? {};
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const errors: Record<string, string> = {};
  if (!name.trim()) errors.__name = tr("请填写名称", "Enter a name");
  for (const f of kind.schema) {
    const raw = (values[f.name] ?? "").trim();
    const isSet = !!cfg[`${f.name}_set`];
    if (f.type === "number" && raw && !/^\d+$/.test(raw)) errors[f.name] = tr("请输入整数", "Enter a whole number");
    else if (f.required && !raw && f.type !== "bool" && !(f.secret && isSet)) errors[f.name] = tr("必填", "Required");
  }
  const save = async () => {
    setShown(true);
    if (Object.keys(errors).length) return;
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
    const body = { display_name: name.trim(), sort: method?.sort ?? nextSort, enabled, config };
    const r = await run(
      () =>
        method
          ? put(`/settings/payments/${method.id}`, { ...body, version: method.version, icon: method.icon })
          : post("/settings/payments", { ...body, kind: kind.id }),
      { ok: tr("支付方式已保存", "Payment method saved") },
    );
    if (r !== undefined) onClose();
  };
  const ro = !owner;
  return (
    <Dialog
      open
      size="lg"
      icon={CreditCard}
      onClose={onClose}
      title={
        method
          ? tr(`编辑 ${method.display_name}`, `Edit ${method.display_name}`)
          : tr(`添加 ${kind.label}`, `Add ${kind.label}`)
      }
      description={ro ? tr("仅所有者可修改", "Owner only") : kind.label}
      onSubmit={ro ? undefined : () => void save()}
      footer={
        ro ? (
          <Button onClick={onClose}>{tr("关闭", "Close")}</Button>
        ) : (
          <>
            {shown && Object.keys(errors).length > 0 && (
              <span className="mr-auto text-footnote text-destructive">
                {tr(`${Object.keys(errors).length} 处需要修正`, `${Object.keys(errors).length} to fix`)}
              </span>
            )}
            <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
            <Button type="submit" variant="primary" loading={busy}>
              {tr("保存", "Save")}
            </Button>
          </>
        )
      }
    >
      <fieldset disabled={ro} className="grid gap-3.5">
        <Field label={tr("名称（用户可见）", "Name (shown to users)")} error={shown ? errors.__name : undefined}>
          <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <SwitchField label={tr("启用", "Enabled")} checked={enabled} onChange={setEnabled} disabled={ro} />
        {kind.schema.map((f) => {
          const fp =
            f.name === "app_private_key"
              ? (cfg.app_key_fingerprint as string | undefined)
              : (cfg[`${f.name}_fingerprint`] as string | undefined);
          const isSet = !!cfg[`${f.name}_set`];
          const err = shown ? errors[f.name] : undefined;
          if (f.type === "bool")
            return (
              <SwitchField
                key={f.name}
                label={f.label}
                checked={values[f.name] === "true"}
                onChange={(v) => set(f.name, String(v))}
                disabled={ro}
              />
            );
          if (f.type === "select")
            return (
              <Field key={f.name} label={f.label} error={err}>
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
                error={err}
                hint={
                  isSet || fp
                    ? tr(
                        `已设置${fp ? `（指纹 ${fp.slice(0, 16)}…）` : ""}；留空 = 不修改`,
                        `Set${fp ? ` (fingerprint ${fp.slice(0, 16)}…)` : ""}; empty = keep`,
                      )
                    : tr(
                        "粘贴 PEM，或从文件读取（文件不离开浏览器）",
                        "Paste the PEM or read it from a file (it never leaves the browser)",
                      )
                }
              >
                <Textarea
                  rows={4}
                  className="font-mono"
                  spellCheck={false}
                  value={values[f.name]}
                  onChange={(e) => set(f.name, e.target.value)}
                  placeholder="-----BEGIN …"
                />
                {!ro && (
                  <input
                    type="file"
                    aria-label={tr(`从文件读取 ${f.label}`, `Read ${f.label} from a file`)}
                    className="mt-1 text-footnote"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) set(f.name, await file.text());
                    }}
                  />
                )}
              </Field>
            );
          return (
            <Field
              key={f.name}
              label={f.label}
              error={err}
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
              <Textarea rows={3} readOnly className="font-mono" value={cfg.app_public_key} />
              <CopyButton text={cfg.app_public_key} />
            </div>
          </Field>
        )}
        {method?.notify_url && (
          <div className="text-body">
            {tr("异步通知地址：", "Notify URL: ")}
            <Mono>{method.notify_url}</Mono>
          </div>
        )}
      </fieldset>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 邀请返利
// ---------------------------------------------------------------------------

type Commission = {
  enabled: boolean;
  rate_percent: number;
  first_order_only: boolean;
  hold_days: number;
  min_withdrawal_cents: number;
  usdt_chains: string[];
  usdt_rate_cents: number | null;
};

const CHAINS: [string, string][] = [
  ["trc20", "TRC20 (Tron)"],
  ["plasma", "Plasma"],
  ["polygon", "Polygon"],
  ["arbitrum", "Arbitrum One"],
  ["solana", "Solana"],
  ["xlayer", "X Layer"],
  ["ton", "TON"],
];

export function CommissionSection() {
  const q = useQuery({ queryKey: ["commission-settings"], queryFn: () => get<Commission>("/commission-settings") });
  return <Loaded q={q}>{(c) => <CommissionForm c={c} />}</Loaded>;
}

function CommissionForm({ c }: { c: Commission }) {
  const tr = useTr();
  const [run] = useAction();
  // Commissions only come from invitees who signed up through an invite link:
  // with registration closed there are none, however the switch below is set.
  const signup = useQuery({
    queryKey: ["settings", "signup"],
    queryFn: () => get<{ register_enabled: boolean }>("/settings/signup"),
  });
  const f = useDraft({
    enabled: c.enabled,
    rate: String(c.rate_percent),
    first: c.first_order_only,
    hold: String(c.hold_days),
    min: centsToYuanText(c.min_withdrawal_cents),
    chains: c.usdt_chains,
    usdt: centsToYuanText(c.usdt_rate_cents),
  });
  const v = f.value!;
  const rateError = f.isEdited("rate") ? intError(v.rate, 0, 100, tr) : undefined;
  const holdError = f.isEdited("hold") ? intError(v.hold, 0, 365, tr) : undefined;
  const minCents = parseYuan(v.min);
  const minError =
    f.isEdited("min") && (minCents === null || minCents < 1)
      ? tr("请输入金额（元），至少 0.01", "Enter an amount in yuan, at least 0.01")
      : undefined;
  const usdtCents = v.usdt.trim() ? parseYuan(v.usdt) : null;
  const usdtError =
    f.isEdited("usdt") && v.usdt.trim() && (usdtCents === null || usdtCents < 1)
      ? tr("请输入金额（元），或留空", "Enter an amount in yuan, or leave empty")
      : undefined;
  useSavePart({
    count: f.edited.length,
    errors: [rateError, holdError, minError, usdtError].filter(Boolean).length,
    discard: f.reset,
    save: async () => {
      const r = await run(
        () =>
          put("/commission-settings", {
            enabled: v.enabled,
            rate_percent: intOf(v.rate),
            first_order_only: v.first,
            hold_days: intOf(v.hold),
            min_withdrawal_cents: parseYuan(v.min),
            usdt_chains: CHAINS.map(([id]) => id).filter((id) => v.chains.includes(id)),
            usdt_rate_cents: v.usdt.trim() ? parseYuan(v.usdt) : null,
          }),
        { ok: tr("邀请返利设置已保存", "Commission settings saved") },
      );
      if (r === undefined) return false;
      await settled();
      f.reset();
      return true;
    },
  });
  return (
    <>
      {signup.data && !signup.data.register_enabled && (
        <Callout tone="warning" title={tr("注册未开放", "Registration is closed")}>
          {tr(
            "门户的邀请链接要在「注册与邀请」打开「开放注册」后才能使用；关闭注册期间不会有新的被邀请人，也就不会产生返利。",
            "Portal invite links only work once registration is open (Sign-up and invites); while it is closed there are no new invitees, so no commissions.",
          )}
        </Callout>
      )}
      <Group
        title={tr("返利", "Commissions")}
        footer={tr(
          "被邀请人每笔实付（不含余额、优惠券与抵扣部分）按比例给邀请人记返利，冻结期满后计入余额；冻结期内退款则撤销。",
          "Each paid order of an invitee (excluding balance, coupons and credit) earns the inviter the rate; it is credited after the hold period and cancelled by a refund within it.",
        )}
      >
        <SwitchRow
          label={tr("开启邀请返利", "Invite commissions on")}
          checked={v.enabled}
          onChange={(x) => f.set("enabled", x)}
        />
        <FieldRow
          label={tr("返利比例（%）", "Rate (%)")}
          description={tr("0–100 的整数", "A whole number 0–100")}
          error={rateError}
        >
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              className="tnum text-right sm:w-24"
              value={v.rate}
              onChange={(e) => f.set("rate", e.target.value)}
            />
          )}
        </FieldRow>
        <SwitchRow
          label={tr("只算首单", "First order only")}
          description={tr("每个被邀请人只有第一笔付款产生返利", "Only an invitee's first payment earns a commission")}
          checked={v.first}
          onChange={(x) => f.set("first", x)}
        />
        <FieldRow label={tr("冻结天数", "Hold days")} description={tr("0–365 天", "0–365 days")} error={holdError}>
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              className="tnum text-right sm:w-24"
              value={v.hold}
              onChange={(e) => f.set("hold", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Group
        title={tr("提现（USDT）", "Withdrawals (USDT)")}
        footer={tr(
          "提现只支持 USDT：用户选择网络并填写地址，管理员在交易所手动打款后回填交易哈希。",
          "Withdrawals are USDT only: users pick a network and address; admins pay by hand and record the transaction hash.",
        )}
      >
        <FieldRow label={tr("最低提现（元）", "Minimum withdrawal (yuan)")} error={minError}>
          {(a) => (
            <Input
              {...a}
              inputMode="decimal"
              className="tnum text-right sm:w-28"
              value={v.min}
              onChange={(e) => f.set("min", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow
          label={tr("参考汇率（元/USDT）", "Reference rate (yuan per USDT)")}
          description={tr("可空，仅用于显示", "Optional, display only")}
          error={usdtError}
        >
          {(a) => (
            <Input
              {...a}
              inputMode="decimal"
              className="tnum text-right sm:w-28"
              value={v.usdt}
              onChange={(e) => f.set("usdt", e.target.value)}
            />
          )}
        </FieldRow>
        <div className="px-4 py-2.5">
          <div className="mb-2 text-body font-medium">{tr("可选 USDT 网络", "USDT networks offered")}</div>
          <div className="flex flex-wrap gap-2">
            {CHAINS.map(([id, name]) => (
              <label
                key={id}
                className="flex min-h-9 items-center gap-2 rounded-lg bg-window px-2.5 text-body ring-1 ring-border ring-inset"
              >
                <Checkbox
                  checked={v.chains.includes(id)}
                  label={name}
                  onChange={(on) => f.set("chains", on ? [...v.chains, id] : v.chains.filter((x) => x !== id))}
                />
                {name}
              </label>
            ))}
          </div>
        </div>
      </Group>
    </>
  );
}
