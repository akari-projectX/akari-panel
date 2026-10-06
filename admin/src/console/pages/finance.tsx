// 资金 (FIN-*): withdrawals (R46 USDT: chain, address, memo; approve with
// the USDT paid and the transaction hash, or reject back to the balance),
// balances (search anyone, ledger, manual adjustment), commissions, and the
// invite programme settings (chains, reference rate).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { get, post, put, qs } from "../../shared/api";
import { centsToYuanText, dateTime, parseYuan, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Dialog } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  Tabs,
} from "../../shared/ui/primitives";
import { DataTable, type Column } from "../../shared/ui/table";
import { CopyButton, FormError, Mono, useDebounced, useRun } from "../kit";
import { navigate, setQuery, useRoute } from "../router";
import { AdjustBalanceDialog } from "./user-drawer";

type Withdrawal = {
  id: string;
  user_id: string | null;
  user_label: string;
  user_email: string | null;
  amount_cents: number;
  chain: string;
  address: string;
  memo: string | null;
  status: string;
  usdt_amount: string | null;
  txid: string | null;
  note: string | null;
  decided_at: string | null;
  decided_by: string | null;
  created_at: string;
};
type Commission = {
  id: string;
  out_trade_no: string;
  inviter_label: string;
  inviter_email: string | null;
  invitee_label: string;
  invitee_email: string | null;
  base_cents: number;
  rate_percent: number;
  amount_cents: number;
  status: string;
  available_at: string;
  clawback_cents: number | null;
  created_at: string;
};
type Settings = {
  enabled: boolean;
  rate_percent: number;
  first_order_only: boolean;
  hold_days: number;
  min_withdrawal_cents: number;
  usdt_chains: string[];
  usdt_rate_cents: number | null;
};
type BalanceRow = {
  user_id: string;
  email: string;
  balance_cents: number;
  withdrawable_cents?: number;
  updated_at?: string;
};

export const CHAINS: [string, string][] = [
  ["trc20", "TRC20 (Tron)"],
  ["plasma", "Plasma"],
  ["polygon", "Polygon"],
  ["arbitrum", "Arbitrum One"],
  ["solana", "Solana"],
  ["xlayer", "X Layer"],
  ["ton", "TON"],
];
const chainName = (c: string) => CHAINS.find(([id]) => id === c)?.[1] ?? c;

function wStatus(s: string, tr: Tr) {
  return (
    (
      {
        pending: [tr("待审核", "Pending"), "warning"],
        approved: [tr("已打款", "Paid"), "success"],
        rejected: [tr("已拒绝", "Rejected"), "danger"],
        cancelled: [tr("用户撤销", "Cancelled"), "neutral"],
      } as Record<string, [string, "warning" | "success" | "danger" | "neutral"]>
    )[s] ?? [s, "neutral"]
  );
}

export function FinancePage() {
  const tr = useTr();
  const { sub } = useRoute();
  const tab = ["balances", "commissions", "settings"].includes(sub[0]) ? sub[0] : "withdrawals";
  return (
    <>
      <PageHeader title={tr("资金", "Finance")} />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={(v) => navigate(v === "withdrawals" ? "/finance" : `/finance/${v}`)}
          tabs={[
            { value: "withdrawals", label: tr("提现审核", "Withdrawals") },
            { value: "balances", label: tr("用户余额", "Balances") },
            { value: "commissions", label: tr("返利记录", "Commissions") },
            { value: "settings", label: tr("邀请返利设置", "Invite settings") },
          ]}
        />
      </div>
      {tab === "withdrawals" && <Withdrawals />}
      {tab === "balances" && <Balances />}
      {tab === "commissions" && <Commissions />}
      {tab === "settings" && <InviteSettings />}
    </>
  );
}

function Withdrawals() {
  const tr = useTr();
  const { query } = useRoute();
  const status = query.get("status") ?? "pending";
  const [email, setEmail] = useState("");
  const de = useDebounced(email, 400);
  const q = useQuery({
    queryKey: ["withdrawals", status, de],
    queryFn: () =>
      get<Withdrawal[]>(`/withdrawals${qs({ status: status === "all" ? "" : status, email: de, limit: 200 })}`),
  });
  const settings = useQuery({
    queryKey: ["commission-settings"],
    queryFn: () => get<Settings>("/commission-settings"),
  });
  const [deciding, setDeciding] = useState<{ w: Withdrawal; approve: boolean } | null>(null);
  const rate = settings.data?.usdt_rate_cents;
  const columns: Column<Withdrawal>[] = [
    {
      key: "user",
      header: tr("用户", "User"),
      fixed: true,
      mobile: "title",
      cell: (w) => w.user_email ?? w.user_label,
    },
    {
      key: "amount",
      header: tr("金额", "Amount"),
      cell: (w) => (
        <span className="tabular-nums">
          {yuan(w.amount_cents)}
          {rate ? (
            <span className="ml-1 text-xs text-muted-foreground">≈ {(w.amount_cents / rate).toFixed(2)} USDT</span>
          ) : null}
        </span>
      ),
    },
    { key: "chain", header: tr("网络", "Network"), cell: (w) => chainName(w.chain) },
    {
      key: "address",
      header: tr("地址", "Address"),
      cell: (w) => (
        <span className="flex items-center gap-1">
          <Mono>{w.address}</Mono>
          {w.memo && <Badge tone="outline">Memo {w.memo}</Badge>}
        </span>
      ),
    },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (w) => {
        const [t, tone] = wStatus(w.status, tr);
        return <Badge tone={tone}>{t}</Badge>;
      },
    },
    {
      key: "paid",
      header: tr("实付 / 交易哈希", "Paid / tx"),
      optional: true,
      cell: (w) => (w.txid ? `${w.usdt_amount} USDT · ${w.txid.slice(0, 12)}…` : (w.note ?? "—")),
    },
    { key: "created", header: tr("申请时间", "Requested"), cell: (w) => dateTime(w.created_at) },
    {
      key: "act",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      fixed: true,
      cell: (w) =>
        w.status === "pending" ? (
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="primary"
              onClick={(e) => (e.stopPropagation(), setDeciding({ w, approve: true }))}
            >
              {tr("通过", "Approve")}
            </Button>
            <Button
              size="sm"
              variant="destructive-soft"
              onClick={(e) => (e.stopPropagation(), setDeciding({ w, approve: false }))}
            >
              {tr("拒绝", "Reject")}
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <>
      <DataTable
        label={tr("提现", "Withdrawals")}
        storageKey="withdrawals"
        rows={q.data ?? []}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        toolbar={
          <>
            <Select
              aria-label={tr("状态", "Status")}
              className="w-36 [&_select]:h-8"
              value={status}
              onChange={(e) => setQuery({ status: e.target.value })}
            >
              <option value="pending">{tr("待审核", "Pending")}</option>
              <option value="approved">{tr("已打款", "Paid")}</option>
              <option value="rejected">{tr("已拒绝", "Rejected")}</option>
              <option value="cancelled">{tr("用户撤销", "Cancelled")}</option>
              <option value="all">{tr("全部", "All")}</option>
            </Select>
            <Input
              type="search"
              aria-label={tr("用户邮箱（精确）", "User email (exact)")}
              placeholder={tr("用户邮箱（精确）", "User email (exact)")}
              className="h-8 w-full sm:w-56"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </>
        }
      />
      {deciding && (
        <DecideDialog w={deciding.w} approve={deciding.approve} rate={rate ?? null} onClose={() => setDeciding(null)} />
      )}
    </>
  );
}

function DecideDialog({
  w,
  approve,
  rate,
  onClose,
}: {
  w: Withdrawal;
  approve: boolean;
  rate: number | null;
  onClose: () => void;
}) {
  const tr = useTr();
  const [usdt, setUsdt] = useState(rate ? (w.amount_cents / rate).toFixed(2) : "");
  const [txid, setTxid] = useState("");
  const [note, setNote] = useState("");
  const [run, busy] = useRun();
  const submit = async () => {
    const r = await run(
      () =>
        approve
          ? post(`/withdrawals/${w.id}/approve`, {
              usdt_amount: usdt.trim(),
              txid: txid.trim(),
              note: note.trim() || undefined,
            })
          : post(`/withdrawals/${w.id}/reject`, { reason: note.trim() }),
      {
        ok: approve
          ? tr("已标记为已打款", "Marked paid")
          : tr("已拒绝，金额退回余额", "Rejected; the amount is back in the balance"),
        invalidate: [["withdrawals"], ["dashboard"]],
      },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      tone={approve ? "default" : "danger"}
      title={approve ? tr("通过提现", "Approve withdrawal") : tr("拒绝提现", "Reject withdrawal")}
      description={`${w.user_email ?? w.user_label} · ${yuan(w.amount_cents)} · ${chainName(w.chain)}`}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button
            type="submit"
            variant={approve ? "primary" : "destructive"}
            loading={busy}
            disabled={approve ? !usdt.trim() || !txid.trim() : !note.trim()}
          >
            {approve ? tr("确认已打款", "Confirm paid") : tr("拒绝", "Reject")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {approve && (
          <>
            <div className="flex items-start gap-2 text-[13px]">
              <Mono>{w.address}</Mono>
              <CopyButton text={w.address} />
            </div>
            {w.memo && (
              <p className="text-[13px]">
                Memo: <Mono>{w.memo}</Mono>
              </p>
            )}
            <Field label={tr("实付 USDT", "USDT paid")}>
              <Input inputMode="decimal" value={usdt} onChange={(e) => setUsdt(e.target.value)} />
            </Field>
            <Field label={tr("交易哈希（txid）", "Transaction hash (txid)")}>
              <Input value={txid} onChange={(e) => setTxid(e.target.value)} />
            </Field>
          </>
        )}
        <Field
          label={
            approve ? tr("备注（可选）", "Note (optional)") : tr("拒绝原因（用户可见）", "Reason (shown to the user)")
          }
        >
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
      </div>
    </Dialog>
  );
}

function Balances() {
  const tr = useTr();
  const [email, setEmail] = useState("");
  const de = useDebounced(email, 400);
  const q = useQuery({ queryKey: ["balances", de], queryFn: () => get<BalanceRow[]>(`/balances${qs({ email: de })}`) });
  const [adjust, setAdjust] = useState<BalanceRow | null>(null);
  const columns: Column<BalanceRow & { id: string }>[] = [
    { key: "email", header: tr("用户", "User"), fixed: true, mobile: "title", cell: (b) => b.email },
    {
      key: "balance",
      header: tr("余额", "Balance"),
      align: "right",
      cell: (b) => <span className="tabular-nums">{yuan(b.balance_cents)}</span>,
    },
    {
      key: "withdrawable",
      header: tr("可提现", "Withdrawable"),
      align: "right",
      cell: (b) => (b.withdrawable_cents === undefined ? "—" : yuan(b.withdrawable_cents)),
    },
    {
      key: "act",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      fixed: true,
      cell: (b) => (
        <span className="flex gap-1">
          <Button size="sm" onClick={(e) => (e.stopPropagation(), setAdjust(b))}>
            {tr("调整", "Adjust")}
          </Button>
        </span>
      ),
    },
  ];
  return (
    <>
      <DataTable
        label={tr("余额", "Balances")}
        rows={(q.data ?? []).map((b) => ({ ...b, id: b.user_id }))}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        onRowClick={(b) => navigate(`/users?open=${b.user_id}`)}
        toolbar={
          <Input
            type="search"
            aria-label={tr("按邮箱查找任意用户", "Find anyone by email")}
            placeholder={tr("按邮箱查找任意用户（精确）", "Find anyone by email (exact)")}
            className="h-8 w-full sm:w-72"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        }
      />
      {adjust && <AdjustBalanceDialog id={adjust.user_id} email={adjust.email} onClose={() => setAdjust(null)} />}
    </>
  );
}

function Commissions() {
  const tr = useTr();
  const [status, setStatus] = useState("");
  const [email, setEmail] = useState("");
  const de = useDebounced(email, 400);
  const q = useQuery({
    queryKey: ["commissions", status, de],
    queryFn: () => get<Commission[]>(`/commissions${qs({ status, email: de, limit: 200 })}`),
  });
  const columns: Column<Commission>[] = [
    {
      key: "inviter",
      header: tr("邀请人", "Inviter"),
      fixed: true,
      mobile: "title",
      cell: (c) => c.inviter_email ?? c.inviter_label,
    },
    { key: "invitee", header: tr("被邀请人", "Invitee"), cell: (c) => c.invitee_email ?? c.invitee_label },
    {
      key: "order",
      header: tr("订单", "Order"),
      cell: (c) => <span className="font-mono text-xs">{c.out_trade_no}</span>,
    },
    {
      key: "amount",
      header: tr("返利", "Commission"),
      cell: (c) => `${yuan(c.amount_cents)} (${c.rate_percent}% × ${yuan(c.base_cents)})`,
    },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (c) => (
        <span className="flex gap-1">
          <Badge tone={c.status === "credited" ? "success" : c.status === "reversed" ? "danger" : "warning"}>
            {{ pending: tr("冻结中", "Held"), credited: tr("已入账", "Credited"), reversed: tr("已撤销", "Reversed") }[
              c.status
            ] ?? c.status}
          </Badge>
          {c.clawback_cents ? (
            <Badge tone="danger">{tr(`追回 ${yuan(c.clawback_cents)}`, `clawback ${yuan(c.clawback_cents)}`)}</Badge>
          ) : null}
        </span>
      ),
    },
    { key: "available", header: tr("可入账时间", "Available"), optional: true, cell: (c) => dateTime(c.available_at) },
    { key: "created", header: tr("时间", "Created"), cell: (c) => dateTime(c.created_at) },
  ];
  return (
    <DataTable
      label={tr("返利记录", "Commissions")}
      storageKey="commissions"
      rows={q.data ?? []}
      columns={columns}
      loading={q.isPending}
      error={q.error}
      toolbar={
        <>
          <Select
            aria-label={tr("状态", "Status")}
            className="w-32 [&_select]:h-8"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{tr("全部", "All")}</option>
            <option value="pending">{tr("冻结中", "Held")}</option>
            <option value="credited">{tr("已入账", "Credited")}</option>
            <option value="reversed">{tr("已撤销", "Reversed")}</option>
          </Select>
          <Input
            type="search"
            aria-label={tr("邀请人邮箱", "Inviter email")}
            placeholder={tr("邀请人邮箱（精确）", "Inviter email (exact)")}
            className="h-8 w-full sm:w-56"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </>
      }
    />
  );
}

function InviteSettings() {
  const tr = useTr();
  const q = useQuery({ queryKey: ["commission-settings"], queryFn: () => get<Settings>("/commission-settings") });
  const [f, setF] = useState<
    (Omit<Settings, "min_withdrawal_cents" | "usdt_rate_cents"> & { min: string; rate: string }) | null
  >(null);
  useEffect(() => {
    if (q.data && !f)
      setF({
        ...q.data,
        min: centsToYuanText(q.data.min_withdrawal_cents),
        rate: centsToYuanText(q.data.usdt_rate_cents),
      });
  }, [q.data, f]);
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  if (!f) return q.error ? <FormError error={q.error} /> : <Skeleton className="h-64" />;
  const save = async () => {
    const min = parseYuan(f.min || "0");
    const rate = f.rate.trim() ? parseYuan(f.rate) : null;
    if (min === null || (f.rate.trim() && rate === null))
      return setError(new Error(tr("金额无效（元）", "Invalid amount (yuan)")));
    setError(null);
    await run(
      () =>
        put("/commission-settings", {
          enabled: f.enabled,
          rate_percent: Number(f.rate_percent),
          first_order_only: f.first_order_only,
          hold_days: Number(f.hold_days),
          min_withdrawal_cents: min,
          usdt_chains: f.usdt_chains,
          usdt_rate_cents: rate,
        }),
      { ok: tr("设置已保存", "Settings saved"), invalidate: [["commission-settings"]] },
    );
  };
  return (
    <Card>
      <CardHeader
        title={tr("邀请返利设置", "Invite programme")}
        description={tr(
          "提现只支持 USDT（R46）：用户选择网络并填写地址，管理员手动打款后回填交易哈希。",
          "Withdrawals are USDT only (R46): users pick a network and address; admins pay by hand and record the hash.",
        )}
      />
      <CardBody>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
            <Switch
              checked={f.enabled}
              onChange={(v) => setF({ ...f, enabled: v })}
              label={tr("开启邀请返利", "Invite commissions on")}
            />
            {tr("开启邀请返利", "Invite commissions on")}
          </label>
          <Field label={tr("返利比例（%）", "Rate (%)")}>
            <Input
              inputMode="numeric"
              value={String(f.rate_percent)}
              onChange={(e) => setF({ ...f, rate_percent: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label={tr("冻结天数", "Hold days")}>
            <Input
              inputMode="numeric"
              value={String(f.hold_days)}
              onChange={(e) => setF({ ...f, hold_days: Number(e.target.value) || 0 })}
            />
          </Field>
          <label className="flex items-center gap-2 text-[13px]">
            <Switch
              checked={f.first_order_only}
              onChange={(v) => setF({ ...f, first_order_only: v })}
              label={tr("只算首单", "First order only")}
            />
            {tr("只算首单", "First order only")}
          </label>
          <Field label={tr("最低提现（元）", "Minimum withdrawal (yuan)")}>
            <Input inputMode="decimal" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} />
          </Field>
          <Field label={tr("参考汇率（元/USDT，可空，仅显示）", "Reference rate (yuan per USDT; display only)")}>
            <Input inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-[13px] font-medium">{tr("可选 USDT 网络", "USDT networks offered")}</legend>
            <div className="flex flex-wrap gap-2">
              {CHAINS.map(([id, name]) => (
                <label
                  key={id}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[13px]"
                >
                  <Checkbox
                    checked={f.usdt_chains.includes(id)}
                    label={name}
                    onChange={(on) =>
                      setF({ ...f, usdt_chains: on ? [...f.usdt_chains, id] : f.usdt_chains.filter((x) => x !== id) })
                    }
                  />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="mt-4 space-y-2">
          <FormError error={error} />
          <Button variant="primary" loading={busy} onClick={save}>
            {tr("保存", "Save")}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
