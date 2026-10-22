// 系统设置 → 收款与返利 (v2): 支付方式 (SET-19, W24/R40) and 邀请返利
// (FIN-05, moved here from the finance page).
// Payment methods are an ordered list of cards (= the portal's order): ↑↓ /
// drag, the kind's glyph tile, name + state (启用 / 不可用 with the reason /
// 停用) + sandbox, the kind and account, this month's collected money and
// orders, 测试 / 编辑 / the enable switch. Order and enabling go through the
// save bar (disabling confirms with this month's money); any admin may
// reorder, enable, disable and rename (R47), keys and accounts are the
// owner's: locked fields are grey read-only values with a lock. "添加渠道"
// = a kind chooser (radio cards; the built-in balance channel shown as not
// selectable) → the schema-built editor (secrets write-only, keys readable
// from a file that never leaves the browser, numbers checked while typing,
// 测试连接 in the footer, "N 处需要修正"). Delete in the danger zone: one
// select + 删除…; methods used by orders say why they cannot be deleted.
// Commissions: a live example ("被邀请用户付 ¥108.00 → 邀请人得 …"), unit
// inputs, the USDT networks as checkable chips.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CircleAlert,
  CreditCard,
  FlaskConical,
  GripVertical,
  Lock,
  Pencil,
  Plus,
  Trash2,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { del, get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { centsToYuanText, parseYuan, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, Group, Tile } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Select, Switch, SwitchField, Textarea, secretInputProps } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { MenuItem, RowMenu } from "../../shared/ui/menu";
import { EmptyState } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { RadioCards, UnitInput } from "../components/inputs";
import { CopyText } from "../components/kit";
import {
  DangerRow,
  DangerZone,
  FieldRow,
  Loaded,
  OwnerNotice,
  Panel,
  ReadValue,
  SRow,
  SwitchRow,
  Warnings,
  intError,
  intOf,
  useDraft,
  useOwner,
  useSavePart,
} from "../components/settings-kit";
import { settled, useAction } from "../data";
import { CopyButton, useErrText } from "../kit";
import { fresh } from "./settings-data";
import { PAY_TILE_DEFAULT, PAY_TILES } from "./settings-ia";

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
  /** This site-calendar month: paid orders' channel money and count (refunds not deducted). */
  month_cents?: number;
  month_count?: number;
  /** Any order ever used it (then it cannot be deleted). */
  used?: boolean;
};
type Payments = { kinds: Kind[]; methods: Method[]; warnings: string[] };

/** English names of the server's (Chinese) schema labels and kinds. */
const FIELD_EN: Record<string, string> = {
  environment: "Environment",
  gateway_url: "Gateway URL (custom only)",
  app_id: "APPID",
  seller_id: "Seller PID (optional, 2088…)",
  app_private_key: "App private key",
  alipay_public_key: "Alipay public key",
  order_timeout_minutes: "Order lifetime (minutes, 5–120)",
  refund_original: "Allow refunds to the original payment (from the console straight back to Alipay)",
  api_url: "Interface address (e.g. https://pay.example.com/)",
  pid: "Merchant ID (pid)",
  key: "Merchant key",
  channel: "Channel",
  api_mode: "Order mode",
  product_name: "Product name (optional, default “Akari - plan name”)",
};
const OPTION_EN: Record<string, string> = {
  production: "Production",
  sandbox: "Sandbox",
  custom: "Custom gateway",
  alipay: "Alipay",
  wxpay: "WeChat Pay",
  qqpay: "QQ Wallet",
  mapi: "API (mapi.php; the payment page when refused)",
  submit: "Payment page (submit.php)",
};
const KIND_EN: Record<string, string> = { alipay_f2f: "Alipay face-to-face", epay: "EPay" };
const KIND_DESC = (id: string, tr: Tr) =>
  ({
    alipay_f2f: tr(
      "支付宝当面付（扫码）：公钥模式 RSA2，支持沙箱与原路退款",
      "Alipay face-to-face (QR): public-key RSA2, sandbox and refunds to the original payment",
    ),
    epay: tr(
      "易支付（MD5 接口）：一个支付方式对应一个商户的一个渠道；不支持原路退款",
      "EPay (MD5 interface): one method = one merchant's channel; no refunds to the original payment",
    ),
  })[id];
/** The portal name an EPay method suggests for its channel (until the admin edits the name). */
const EPAY_NAME: Record<string, [string, string]> = {
  alipay: ["支付宝（易支付）", "Alipay (EPay)"],
  wxpay: ["微信支付（易支付）", "WeChat Pay (EPay)"],
  qqpay: ["QQ 钱包（易支付）", "QQ Wallet (EPay)"],
};
const fieldLabel = (f: FieldSpec, tr: Tr) => tr(f.label, FIELD_EN[f.name] ?? f.label);
const kindLabel = (id: string, label: string, tr: Tr) => tr(label, KIND_EN[id] ?? label);

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
  const owner = useOwner();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const [choosing, setChoosing] = useState(false);
  const [editing, setEditing] = useState<{ kind: Kind; method: Method | null; fromChooser?: boolean } | null>(null);
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
  const baseOrder = sorted.map((m) => m.id);
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
        const left = order.filter((id) => (v.enabled[id] ?? byId.get(id)!.enabled) && byId.get(id)!.active).length;
        const ok = await confirm({
          title: tr(
            `停用「${off.map((m) => m.display_name).join(tr("、", ", "))}」？`,
            `Disable ${off.map((m) => `"${m.display_name}"`).join(", ")}?`,
          ),
          description: tr(
            "门户的付款页不再显示它，不能再用它下单；它的未付款订单的通知与对账也会停止。",
            "The portal's payment page no longer offers it and no new orders use it; notices and reconciliation of its unpaid orders stop.",
          ),
          impacts: [
            ...off.map((m) => ({
              label: tr(`本月经「${m.display_name}」收款`, `Collected through "${m.display_name}" this month`),
              value: tr(
                `${yuan(m.month_cents ?? 0)} · ${m.month_count ?? 0} 笔`,
                `${yuan(m.month_cents ?? 0)} · ${m.month_count ?? 0} orders`,
              ),
            })),
            { label: tr("保存后可用的渠道", "Usable channels after saving"), value: left },
          ],
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
      f.saved();
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
      {!owner && (
        <OwnerNotice
          what={tr("新建、删除渠道和修改密钥与账号", "creating and deleting channels and changing keys and accounts")}
        />
      )}
      <Warnings items={p.warnings} />
      <Panel
        title={tr("收款渠道 · 按门户里的显示顺序", "Payment channels · in the portal's order")}
        action={
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            className="-mb-1 text-primary"
            disabled={!owner}
            onClick={() => setChoosing(true)}
          >
            {tr("添加渠道", "Add a channel")}
            {!owner && <Lock className="!size-3" aria-hidden="true" />}
          </Button>
        }
        footer={tr(
          "启停、排序与改名任何管理员都能做（启停与排序走保存栏）；密钥、账号与新建删除只有所有者能做。",
          "Any admin may enable, disable, reorder and rename (enabling and order through the save bar); keys, accounts, creating and deleting are the owner's.",
        )}
      >
        {order.length === 0 ? (
          <Card>
            <EmptyState
              icon={CreditCard}
              title={tr("还没有支付方式", "No payment methods yet")}
              description={tr("添加一个支付方式后，用户才能在线付款。", "Users can pay online once a method is added.")}
            />
          </Card>
        ) : (
          <div className="grid gap-2">
            {order.map((id, i) => {
              const m = byId.get(id)!;
              const on = v.enabled[id] ?? m.enabled;
              return (
                <PaymentCard
                  key={id}
                  m={m}
                  on={on}
                  changed={baseOrder.indexOf(id) !== i || on !== m.enabled}
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
          </div>
        )}
      </Panel>
      {notify.length > 0 && (
        <Group
          title={tr("支付通知地址", "Payment notice URLs")}
          footer={tr(
            "填到支付平台的「授权回调 / 异步通知地址」。地址里的域名是首选主域名；地址含后台前缀，不要公开。",
            "Enter it as the platform's callback / notify URL. Its domain is the preferred main domain; it contains the console prefix: keep it private.",
          )}
        >
          {notify.map((m) => (
            <SRow key={m.id} label={m.display_name} wide>
              <CopyText
                value={m.notify_url!}
                className="max-w-full sm:max-w-md"
                label={tr(`${m.display_name} 的通知地址`, `the notice URL of ${m.display_name}`)}
              />
            </SRow>
          ))}
        </Group>
      )}
      {p.methods.length > 0 && <DeleteMethod methods={sorted} owner={owner} />}
      {choosing && (
        <KindChooser
          kinds={p.kinds}
          onClose={() => setChoosing(false)}
          onPick={(k) => {
            setChoosing(false);
            setEditing({ kind: k, method: null, fromChooser: true });
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
          onBack={
            editing.fromChooser
              ? () => {
                  setEditing(null);
                  setChoosing(true);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

/** Danger zone: pick a method, 删除… (only methods no order ever used). */
function DeleteMethod({ methods, owner }: { methods: Method[]; owner: boolean }) {
  const tr = useTr();
  const confirm = useConfirm();
  const [id, setId] = useState(methods.find((m) => !m.used)?.id ?? methods[0].id);
  const m = methods.find((x) => x.id === id) ?? methods[0];
  return (
    <DangerZone>
      <DangerRow
        label={tr("删除收款渠道", "Delete a payment channel")}
        locked={!owner}
        description={tr(
          "只能删除从未被订单使用过的渠道；用过的请停用。历史订单保留渠道名称。",
          "Only channels no order ever used can be deleted; disable used ones instead. Past orders keep the channel's name.",
        )}
        action={
          <>
            <Select
              aria-label={tr("要删除的渠道", "Channel to delete")}
              className="w-44"
              value={m.id}
              disabled={!owner}
              onChange={(e) => setId(e.target.value)}
            >
              {methods.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.display_name}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="destructive-soft"
              icon={Trash2}
              disabled={!owner || !!m.used}
              onClick={() =>
                void confirm({
                  title: tr(`删除渠道「${m.display_name}」？`, `Delete the channel "${m.display_name}"?`),
                  description: tr(
                    "删除后无法恢复，它的密钥一并删除；再添加需要重新填写账号与密钥。",
                    "This cannot be undone and deletes its keys; adding it again means entering the account and keys anew.",
                  ),
                  impacts: [
                    { label: tr("使用过它的订单", "Orders that used it"), value: 0 },
                    {
                      label: tr("当前状态", "Now"),
                      value: m.enabled ? tr("启用", "On") : tr("停用", "Off"),
                    },
                  ],
                  typeToConfirm: m.display_name,
                  confirmLabel: tr("删除渠道", "Delete the channel"),
                  action: () => del(`/settings/payments/${m.id}`),
                })
              }
            >
              {tr("删除…", "Delete…")}
            </Button>
          </>
        }
      />
      {m.used && (
        <p className="px-4 pb-3 text-footnote text-muted-foreground">
          {tr(
            `「${m.display_name}」已被订单使用，不能删除，可以停用。`,
            `"${m.display_name}" has been used by orders: it cannot be deleted, disable it instead.`,
          )}
        </p>
      )}
    </DangerZone>
  );
}

/** The coloured tile of a payment kind (system-settings style; colours are tile data like the IA's). */
function KindTile({ kind, size = 36 }: { kind: string; size?: number }) {
  const t = PAY_TILES[kind];
  return (
    <Tile color={t?.tint ?? PAY_TILE_DEFAULT} size={size}>
      {t ? <span className="text-callout font-bold not-italic">{t.glyph}</span> : <CreditCard />}
    </Tile>
  );
}

function PaymentCard({
  m,
  on,
  changed,
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
  changed: boolean;
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
  const owner = useOwner();
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
        description: r.sub_code ? `${r.message}${tr(`（${r.sub_code}）`, ` (${r.sub_code})`)}` : r.message,
      });
    } catch (e) {
      toast({ tone: "error", title: errText(e) });
    } finally {
      setTesting(false);
    }
  };
  const app = typeof m.config.app_id === "string" && m.config.app_id ? m.config.app_id : null;
  const pid = typeof m.config.pid === "string" && m.config.pid ? m.config.pid : null;
  const unusable = on && m.enabled && !m.active;
  return (
    <Card
      className={cn(
        "relative flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 transition-opacity",
        !on && "opacity-75",
        dragging && "opacity-50",
      )}
      data-method={m.display_name}
      draggable
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
      {changed && (
        <span className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-primary" data-changed>
          <span className="sr-only">{tr("已修改", "Edited")}</span>
        </span>
      )}
      <div className="flex flex-col items-center pointer-coarse:hidden">
        <button
          type="button"
          aria-label={tr(`上移 ${m.display_name}`, `Move ${m.display_name} up`)}
          disabled={first}
          onClick={() => onMove(-1)}
          className="rounded-sm text-faint hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none disabled:opacity-30"
        >
          <ArrowUp className="size-3.5" aria-hidden="true" />
        </button>
        <span
          className="cursor-grab text-faint active:cursor-grabbing"
          title={tr("拖动调整顺序", "Drag to reorder")}
          aria-hidden="true"
        >
          <GripVertical className="size-3.5" />
        </span>
        <button
          type="button"
          aria-label={tr(`下移 ${m.display_name}`, `Move ${m.display_name} down`)}
          disabled={last}
          onClick={() => onMove(1)}
          className="rounded-sm text-faint hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none disabled:opacity-30"
        >
          <ArrowDown className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <KindTile kind={m.kind} />
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex flex-wrap items-center gap-1.5 text-body font-semibold">
          {m.display_name}
          {!on ? (
            <Badge tone="outline">{tr("停用", "Off")}</Badge>
          ) : unusable ? (
            <Badge tone="warning">
              <CircleAlert aria-hidden="true" />
              {tr("不可用", "Unusable")}
            </Badge>
          ) : (
            <Badge tone="success" dot>
              {tr("启用", "On")}
            </Badge>
          )}
          {m.config.environment === "sandbox" && <Badge tone="info">{tr("沙箱", "Sandbox")}</Badge>}
        </div>
        <div className="mt-0.5 truncate text-footnote text-muted-foreground">
          {kindLabel(m.kind, m.kind_label, tr)}
          {app && tr(` · 应用 ${app}`, ` · app ${app}`)}
          {pid && tr(` · 商户 ${pid}`, ` · merchant ${pid}`)}
        </div>
        {m.warnings.length > 0 && (
          <div className="mt-0.5 text-footnote text-warning">{m.warnings.join(tr("；", "; "))}</div>
        )}
      </div>
      <div className="text-right max-md:hidden">
        <div className="text-caption text-faint">{tr("本月", "This month")}</div>
        <div className="tnum text-footnote font-medium">
          {yuan(m.month_cents ?? 0)}
          <span className="font-normal text-faint">
            {tr(` · ${m.month_count ?? 0} 笔`, ` · ${m.month_count ?? 0} orders`)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 max-sm:w-full max-sm:justify-end">
        <Button
          size="sm"
          variant="ghost"
          icon={FlaskConical}
          loading={testing}
          aria-label={tr(`测试连接 ${m.display_name}`, `Test ${m.display_name}`)}
          onClick={() => void test()}
        >
          {tr("测试", "Test")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          icon={Pencil}
          onClick={onEdit}
          aria-label={tr(`编辑 ${m.display_name}`, `Edit ${m.display_name}`)}
        >
          {tr("编辑", "Edit")}
        </Button>
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
        <Switch label={tr(`启用 ${m.display_name}`, `Enable ${m.display_name}`)} checked={on} onChange={onToggle} />
      </div>
      {!owner && <span className="sr-only">{tr("密钥与账号仅所有者可修改", "Keys and account: owner only")}</span>}
    </Card>
  );
}

/** Step 1 of adding: the kind (radio cards; the built-in balance channel is listed, not selectable). */
function KindChooser({ kinds, onClose, onPick }: { kinds: Kind[]; onClose: () => void; onPick: (k: Kind) => void }) {
  const tr = useTr();
  const [k, setK] = useState(kinds[0]?.id ?? "");
  const kind = kinds.find((x) => x.id === k);
  return (
    <Dialog
      open
      size="md"
      icon={Wallet}
      onClose={onClose}
      title={tr("添加支付方式", "Add a payment method")}
      description={tr(
        "先选类型，下一步按类型填写账号与密钥。",
        "Choose the kind first; the next step asks for its account and keys.",
      )}
      onSubmit={() => kind && onPick(kind)}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!kind}>
            {tr("下一步", "Next")}
          </Button>
        </>
      }
    >
      <RadioCards<string>
        value={k}
        onChange={setK}
        cols={1}
        label={tr("渠道类型", "Kind")}
        items={[
          ...kinds.map((x) => ({
            value: x.id,
            title: kindLabel(x.id, x.label, tr),
            desc: KIND_DESC(x.id, tr),
            icon: <KindTile kind={x.id} size={20} />,
          })),
          {
            value: "__balance",
            title: tr("余额", "Balance"),
            desc: undefined,
            icon: <Wallet />,
            disabled: tr(
              "内置渠道，已存在：用户用账户余额付款",
              "Built in, always there: users pay from their balance",
            ),
          },
        ]}
      />
    </Dialog>
  );
}

function MethodDialog({
  kind,
  method,
  owner,
  nextSort,
  onClose,
  onBack,
}: {
  kind: Kind;
  method: Method | null;
  owner: boolean;
  nextSort: number;
  onClose: () => void;
  onBack?: () => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const errText = useErrText();
  const epayName = (channel: string) => {
    const n = EPAY_NAME[channel];
    return n ? tr(n[0], n[1]) : kindLabel(kind.id, kind.label, tr);
  };
  const [name, setName] = useState(
    method?.display_name ?? (kind.id === "epay" ? epayName("alipay") : kindLabel(kind.id, kind.label, tr)),
  );
  // A new EPay method's name follows its channel until the admin types one.
  const [nameEdited, setNameEdited] = useState(!!method);
  const [enabled, setEnabled] = useState(method?.enabled ?? false);
  const [shown, setShown] = useState(false);
  const [testing, setTesting] = useState(false);
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
  const set = (k: string, v: string) => {
    setValues((s) => ({ ...s, [k]: v }));
    if (kind.id === "epay" && k === "channel" && !nameEdited) setName(epayName(v));
  };
  // Number errors show while typing; missing required values once a save was tried.
  const errors: Record<string, string> = {};
  if (!name.trim()) errors.__name = tr("请填写名称", "Enter a name");
  if (owner)
    for (const f of kind.schema) {
      const raw = (values[f.name] ?? "").trim();
      const isSet = !!cfg[`${f.name}_set`];
      if (f.type === "number" && raw && !/^\d+$/.test(raw)) errors[f.name] = tr("请输入整数", "Enter a whole number");
      else if (shown && f.required && !raw && f.type !== "bool" && !(f.secret && isSet))
        errors[f.name] = tr("必填", "Required");
    }
  const nErr = Object.keys(errors).length;
  const save = async () => {
    setShown(true);
    const missing = owner
      ? kind.schema.some(
          (f) =>
            f.required && f.type !== "bool" && !(values[f.name] ?? "").trim() && !(f.secret && cfg[`${f.name}_set`]),
        )
      : false;
    if (nErr || missing) return;
    let config: Record<string, unknown> = {};
    if (owner)
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
    else if (method) config = keptConfig(kind, method);
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
  const test = async () => {
    if (!method) return;
    setTesting(true);
    try {
      const r = await post<{ ok: boolean; message: string; sub_code: string | null }>(
        `/settings/payments/${method.id}/test`,
      );
      toast({
        tone: r.ok ? "success" : "error",
        title: r.ok ? tr("连接正常", "Connection works") : tr("连接测试失败", "The connection test failed"),
        description: tr(`用已保存的配置测试：${r.message}`, `Tested with the saved configuration: ${r.message}`),
      });
    } catch (e) {
      toast({ tone: "error", title: errText(e) });
    } finally {
      setTesting(false);
    }
  };
  const lockedLabel = (f: FieldSpec) => (
    <span className="inline-flex items-center gap-1">
      {fieldLabel(f, tr)}
      <Lock className="size-3 text-faint" role="img" aria-label={tr("仅所有者", "Owner only")} />
    </span>
  );
  return (
    <Dialog
      open
      size="lg"
      icon={CreditCard}
      onClose={onClose}
      title={
        method
          ? tr(`编辑 ${method.display_name}`, `Edit ${method.display_name}`)
          : tr(`添加 ${kind.label}`, `Add ${kindLabel(kind.id, kind.label, tr)}`)
      }
      description={KIND_DESC(kind.id, tr) ?? kindLabel(kind.id, kind.label, tr)}
      onSubmit={() => void save()}
      footer={
        <>
          {onBack && (
            <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>
              {tr("换类型", "Other kind")}
            </Button>
          )}
          {method && (
            <Button variant="outline" icon={FlaskConical} loading={testing} onClick={() => void test()}>
              {tr("测试连接", "Test the connection")}
            </Button>
          )}
          <div className="flex-1" />
          {nErr > 0 && (
            <span className="text-footnote text-destructive max-sm:hidden">
              {tr(`${nErr} 处需要修正`, `${nErr} to fix`)}
            </span>
          )}
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={nErr > 0}>
            {method ? tr("保存", "Save") : tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        {!owner && <OwnerNotice what={tr("密钥与账号", "keys and the account")} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("名称（用户可见）", "Name (shown to users)")} error={errors.__name}>
            <Input
              data-autofocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
            />
          </Field>
          <SwitchField label={tr("启用", "Enabled")} checked={enabled} onChange={setEnabled} />
        </div>
        <div className="grid gap-4 border-t border-separator pt-4 sm:grid-cols-2">
          {kind.schema.map((f) => {
            const fp =
              f.name === "app_private_key"
                ? (cfg.app_key_fingerprint as string | undefined)
                : (cfg[`${f.name}_fingerprint`] as string | undefined);
            const isSet = !!cfg[`${f.name}_set`];
            const err = errors[f.name];
            if (!owner) {
              const shownValue =
                f.secret || f.type === "key"
                  ? isSet || fp || values[f.name]
                    ? tr("已设置 ••••••••", "Set ••••••••")
                    : "—"
                  : f.type === "select"
                    ? (() => {
                        const o = f.options?.find((x) => x.value === values[f.name]);
                        return o ? tr(o.label, OPTION_EN[o.value] ?? o.label) : values[f.name] || "—";
                      })()
                    : f.type === "bool"
                      ? values[f.name] === "true"
                        ? tr("开", "On")
                        : tr("关", "Off")
                      : values[f.name] || "—";
              return (
                <Field
                  key={f.name}
                  group
                  label={lockedLabel(f)}
                  hint={tr("仅所有者可修改", "Owner only")}
                  className={cn((f.type === "key" || f.type === "bool") && "sm:col-span-2")}
                >
                  <ReadValue mono={f.type === "text" || f.type === "key"}>{shownValue}</ReadValue>
                </Field>
              );
            }
            if (f.type === "bool")
              return (
                <div key={f.name} className="sm:col-span-2">
                  <SwitchField
                    label={fieldLabel(f, tr)}
                    checked={values[f.name] === "true"}
                    onChange={(v) => set(f.name, String(v))}
                  />
                </div>
              );
            if (f.type === "select")
              return (
                <Field key={f.name} label={fieldLabel(f, tr)} error={err}>
                  <Select value={values[f.name]} onChange={(e) => set(f.name, e.target.value)}>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {tr(o.label, OPTION_EN[o.value] ?? o.label)}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            if (f.type === "key")
              return (
                <Field
                  key={f.name}
                  label={fieldLabel(f, tr)}
                  error={err}
                  className="sm:col-span-2"
                  hint={
                    isSet || fp
                      ? tr(
                          `已设置${fp ? tr(`（指纹 ${fp.slice(0, 16)}…）`, ` (fingerprint ${fp.slice(0, 16)}…)`) : ""}；留空 = 不修改`,
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
                    className="font-mono text-footnote"
                    spellCheck={false}
                    value={values[f.name]}
                    onChange={(e) => set(f.name, e.target.value)}
                    placeholder={isSet || fp ? tr("••••（已设置）", "•••• (set)") : "-----BEGIN …"}
                  />
                  <input
                    type="file"
                    aria-label={tr(`从文件读取 ${f.label}`, `Read ${fieldLabel(f, tr)} from a file`)}
                    className="mt-1 text-footnote"
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
                label={fieldLabel(f, tr)}
                error={err}
                hint={f.secret && isSet ? tr("已设置；留空 = 不修改", "Set; empty = keep") : undefined}
              >
                <Input
                  {...(f.secret ? secretInputProps : { type: "text", autoComplete: "off" })}
                  inputMode={f.type === "number" ? "numeric" : undefined}
                  className={cn(f.type === "number" && "tnum", f.type === "text" && "font-mono text-footnote")}
                  value={values[f.name]}
                  onChange={(e) => set(f.name, e.target.value)}
                />
              </Field>
            );
          })}
        </div>
        {typeof cfg.app_public_key === "string" && (
          <div className="grid gap-1.5 border-t border-separator pt-4">
            <Field label={tr("应用公钥（上传到支付宝开放平台）", "App public key (upload to the Alipay console)")}>
              <div className="flex items-start gap-2">
                <Textarea rows={3} readOnly className="font-mono text-footnote" value={cfg.app_public_key} />
                <CopyButton text={cfg.app_public_key} />
              </div>
            </Field>
          </div>
        )}
        {method?.notify_url && (
          <div className="grid gap-1 text-body">
            <span className="text-footnote font-medium text-muted-foreground">{tr("异步通知地址", "Notify URL")}</span>
            <CopyText value={method.notify_url} label={tr("通知地址", "the notify URL")} />
          </div>
        )}
      </div>
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

/** The example order of the live preview (¥108.00). */
const EXAMPLE_CENTS = 10_800;

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
  const rateError = intError(v.rate, 0, 100, tr);
  const holdError = intError(v.hold, 0, 365, tr);
  const minCents = parseYuan(v.min);
  const minError =
    minCents === null || minCents < 1
      ? tr("请输入金额（元），至少 0.01，最多两位小数", "Enter an amount in yuan, at least 0.01, two decimals at most")
      : undefined;
  const usdtCents = v.usdt.trim() ? parseYuan(v.usdt) : null;
  const usdtError =
    v.usdt.trim() && (usdtCents === null || usdtCents < 1)
      ? tr("请输入金额（元，最多两位小数），或留空", "Enter an amount in yuan (two decimals at most), or leave empty")
      : undefined;
  const chainsError =
    v.enabled && v.chains.length === 0
      ? tr(
          "开启返利时至少选一个网络，否则用户无法提现",
          "Pick at least one network while commissions are on, or nobody can withdraw",
        )
      : undefined;
  const errors = [rateError, holdError, minError, usdtError, chainsError].filter(Boolean).length;
  useSavePart({
    count: f.edited.length,
    errors,
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
      f.saved();
      return true;
    },
  });
  const rate = rateError ? null : intOf(v.rate);
  const earn = rate === null ? null : Math.floor((EXAMPLE_CENTS * rate) / 100);
  const hold = holdError ? "?" : v.hold.trim();
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
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3" aria-live="polite">
        <div className="min-w-0 flex-1">
          <div className="text-caption text-faint">{tr("按当前填写的值", "With the values as entered")}</div>
          <div className="mt-0.5 text-body">
            {!v.enabled ? (
              tr("邀请返利已关闭：不产生新的返利。", "Commissions are off: no new ones are earned.")
            ) : (
              <>
                {tr("被邀请用户付 ", "An invitee pays ")}
                <b className="tnum">{yuan(EXAMPLE_CENTS)}</b>
                {tr(" → 邀请人得 ", " → the inviter earns ")}
                <b className="tnum text-primary">{earn === null ? "—" : yuan(earn)}</b>
                {v.first ? tr("（仅首单）", " (first order only)") : tr("（每一单）", " (every order)")}
                {tr(`，${hold} 天后可提现`, `, withdrawable after ${hold} days`)}
              </>
            )}
          </div>
        </div>
        <Button asChild size="sm" variant="ghost">
          <Link to="/finance/commissions">{tr("返利记录", "Commission records")}</Link>
        </Button>
      </Card>
      <Group
        title={tr("返利", "Commissions")}
        footer={tr(
          "被邀请人每笔实付（不含余额、优惠券与抵扣部分）按比例给邀请人记返利，冻结期满后计入余额；冻结期内退款则撤销。",
          "Each paid order of an invitee (excluding balance, coupons and credit) earns the inviter the rate; it is credited after the hold period and cancelled by a refund within it.",
        )}
      >
        <SwitchRow
          label={tr("开启邀请返利", "Invite commissions on")}
          description={tr(
            "关闭后不再产生新返利，已有的不受影响",
            "When off no new commissions are earned; existing ones stay",
          )}
          changed={f.isEdited("enabled")}
          checked={v.enabled}
          onChange={(x) => f.set("enabled", x)}
        />
        <FieldRow
          label={tr("返利比例（%）", "Rate (%)")}
          description={tr("按实付金额计算，0–100 的整数", "Of the amount paid, a whole number 0–100")}
          error={rateError}
          changed={f.isEdited("rate")}
        >
          {(a) => (
            <UnitInput
              {...a}
              unit="%"
              invalid={!!rateError}
              value={v.rate}
              onChange={(e) => f.set("rate", e.target.value)}
            />
          )}
        </FieldRow>
        <SwitchRow
          label={tr("只算首单", "First order only")}
          description={tr("每个被邀请人只有第一笔付款产生返利", "Only an invitee's first payment earns a commission")}
          changed={f.isEdited("first")}
          checked={v.first}
          onChange={(x) => f.set("first", x)}
        />
        <FieldRow
          label={tr("冻结天数", "Hold days")}
          description={tr(
            "期间订单退款则返利自动撤销，0–365 天",
            "A refund within it cancels the commission, 0–365 days",
          )}
          error={holdError}
          changed={f.isEdited("hold")}
        >
          {(a) => (
            <UnitInput
              {...a}
              unit={tr("天", "d")}
              invalid={!!holdError}
              value={v.hold}
              onChange={(e) => f.set("hold", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Group
        title={tr("提现（USDT）", "Withdrawals (USDT)")}
        footer={tr(
          "提现申请在「资金 › 提现」里审核：用户选择网络并填写地址，管理员在交易所手动打款后回填交易哈希。参考汇率只用于在门户显示折合 USDT。",
          "Withdrawals are reviewed in Finance › Withdrawals: users pick a network and address; admins pay by hand and record the transaction hash. The reference rate only shows the USDT equivalent on the portal.",
        )}
      >
        <FieldRow
          label={tr("最低提现（元）", "Minimum withdrawal (yuan)")}
          error={minError}
          changed={f.isEdited("min")}
        >
          {(a) => (
            <UnitInput
              {...a}
              inputMode="decimal"
              unit="¥"
              invalid={!!minError}
              value={v.min}
              onChange={(e) => f.set("min", e.target.value)}
            />
          )}
        </FieldRow>
        <div className="relative px-4 py-3">
          {f.isEdited("chains") && (
            <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" data-changed />
          )}
          <div className="text-body font-medium">{tr("可选的 USDT 网络", "USDT networks offered")}</div>
          <div className="mt-0.5 text-footnote text-muted-foreground">
            {tr(
              "用户提现时选择，收款地址按网络校验格式",
              "Users pick one when withdrawing; addresses are checked per network",
            )}
          </div>
          <div
            className="mt-2.5 flex flex-wrap gap-2"
            role="group"
            aria-label={tr("可选的 USDT 网络", "USDT networks offered")}
          >
            {CHAINS.map(([id, name]) => {
              const on = v.chains.includes(id);
              return (
                <label
                  key={id}
                  className={cn(
                    "flex min-h-8 items-center gap-2 rounded-full pr-3 pl-2 text-body shadow-[0_0_0_0.5px_var(--input)]",
                    on && "bg-primary-soft shadow-[0_0_0_1px_var(--primary)]",
                  )}
                >
                  <Checkbox
                    checked={on}
                    label={name}
                    onChange={(x) => f.set("chains", x ? [...v.chains, id] : v.chains.filter((y) => y !== id))}
                  />
                  {name}
                  {id === "plasma" && <span className="text-caption text-faint">{tr("免手续费", "no fee")}</span>}
                </label>
              );
            })}
          </div>
          {chainsError && (
            <p className="mt-1.5 text-footnote text-destructive" role="alert">
              {chainsError}
            </p>
          )}
        </div>
        <FieldRow
          label={tr("参考汇率（元/USDT）", "Reference rate (yuan per USDT)")}
          description={tr("1 USDT = ¥，可空，仅用于显示", "1 USDT = ¥, optional, display only")}
          error={usdtError}
          changed={f.isEdited("usdt")}
        >
          {(a) => (
            <UnitInput
              {...a}
              inputMode="decimal"
              unit="¥"
              invalid={!!usdtError}
              value={v.usdt}
              onChange={(e) => f.set("usdt", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
    </>
  );
}
