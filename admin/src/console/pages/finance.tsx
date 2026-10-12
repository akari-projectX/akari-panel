// 资金 (FIN-*): withdrawals (USDT only: chain, address, memo; approve with
// the USDT paid and the transaction hash, or reject back to the balance),
// balances (search anyone, manual adjustment) and commissions. The invite
// programme settings moved to 系统设置 → 收款与返利 → 邀请返利.
// The list endpoints take only a `limit` (no cursor): lists grow by
// "load more" up to the server's 500 and say so when they hit it, never
// cut silently (audit §5.7). Filters live in the URL.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  HandCoins,
  SearchX,
  Undo2,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { get, post, qs } from "../../shared/api";
import { yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented } from "../../shared/ui/form";
import { Callout, PageHeader } from "../../shared/ui/layout";
import { EmptyState } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";
import { useAction } from "../data";
import { CopyButton, Mono, useDebounced } from "../kit";
import { navigate, setQuery, useRoute } from "../router";
import { LedgerTable, ScrollX, SearchField, When, shortTime, useColumns } from "./ledger";
import { AdjustBalanceDialog } from "./user-detail";

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

/** First page and step of the growing lists; the server's cap. */
const STEP = 100;
const SERVER_MAX = 500;

/** A transaction hash as the server accepts it (commission.rs `txid_ok`). */
export const TXID_RE = /^[A-Za-z0-9_+/=-]{8,128}$/;
/** A USDT amount: positive, at most 6 decimals. */
export const USDT_RE = /^\d+(\.\d{1,6})?$/;

function wStatus(s: string, tr: Tr): [string, "warning" | "success" | "danger" | "neutral"] {
  return (
    (
      {
        pending: [tr("待审核", "Pending"), "warning"],
        approved: [tr("已打款", "Paid"), "success"],
        rejected: [tr("已拒绝", "Rejected"), "danger"],
        cancelled: [tr("用户撤销", "Cancelled"), "neutral"],
      } as Record<string, [string, "warning" | "success" | "danger" | "neutral"]>
    )[s] ?? [tr("未知状态", "Unknown"), "neutral"]
  );
}

/** A search box whose (debounced) value is the URL's `email`. */
function useEmailParam(): [string, string, (v: string) => void] {
  const { query } = useRoute();
  const email = query.get("email") ?? "";
  const [text, setText] = useState(email);
  const d = useDebounced(text.trim(), 400);
  const applied = useRef(d);
  useEffect(() => {
    if (d === applied.current) return;
    applied.current = d;
    setQuery({ email: d || null });
  }, [d]);
  return [email, text, setText];
}

/** "N in total", or "N loaded" + load more, or the server cap reached. */
function GrowFooter({
  count,
  limit,
  fetching,
  onMore,
}: {
  count: number;
  limit: number;
  fetching: boolean;
  onMore: () => void;
}) {
  const tr = useTr();
  if (count === 0) return null;
  if (count < limit) return <span className="tnum">{tr(`共 ${count} 条`, `${count} in total`)}</span>;
  if (limit < SERVER_MAX)
    return (
      <>
        <span className="tnum">{tr(`已加载 ${count} 条`, `${count} loaded`)}</span>
        <Button size="sm" variant="ghost" loading={fetching} onClick={onMore}>
          {tr("加载更多", "Load more")}
        </Button>
      </>
    );
  return (
    <span>
      {tr(
        `只显示最新的 ${count} 条，更早的请用状态或邮箱筛选查看。`,
        `Only the newest ${count} are shown; filter by status or email for older ones.`,
      )}
    </span>
  );
}

export function FinancePage() {
  const tr = useTr();
  const { sub } = useRoute();
  // Old links to the settings tab go to their new place.
  useEffect(() => {
    if (sub[0] === "settings") navigate("/settings/commission", true);
  }, [sub]);
  const tab = ["balances", "commissions"].includes(sub[0]) ? sub[0] : "withdrawals";
  const pending = usePendingWithdrawals();
  return (
    <>
      <PageHeader
        title={tr("资金", "Finance")}
        description={
          pending ? (
            <span className="tnum">
              {tr(
                `${pending} 笔提现待审核 · 用户余额与邀请返利记录`,
                `${pending} withdrawals to review · balances and invite commissions`,
              )}
            </span>
          ) : (
            tr("提现审核、用户余额与邀请返利记录。", "Withdrawals, balances and invite commissions.")
          )
        }
      />
      <div className="mb-4">
        <Tabs
          label={tr("资金", "Finance")}
          value={tab}
          onChange={(v) => navigate(v === "withdrawals" ? "/finance" : `/finance/${v}`)}
          tabs={[
            { value: "withdrawals", label: tr("提现审核", "Withdrawals"), count: pending || undefined },
            { value: "balances", label: tr("用户余额", "Balances") },
            { value: "commissions", label: tr("返利记录", "Commissions") },
          ]}
        />
      </div>
      {tab === "withdrawals" && <Withdrawals />}
      {tab === "balances" && <Balances />}
      {tab === "commissions" && <Commissions />}
    </>
  );
}

/** Pending withdrawals from the dashboard counters (same query key: one request, refreshed by writes). */
function usePendingWithdrawals(): number {
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => get<{ pending: { withdrawals: number } }>("/dashboard"),
  });
  return q.data?.pending.withdrawals ?? 0;
}

const W_ICON: Record<string, LucideIcon> = {
  pending: Clock,
  approved: CircleCheck,
  rejected: CircleX,
  cancelled: Undo2,
};

function WithdrawalChip({ status }: { status: string }) {
  const tr = useTr();
  const [t, tone] = wStatus(status, tr);
  const Icon = W_ICON[status] ?? CircleDashed;
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t}
    </Badge>
  );
}

/** The withdrawal list's paid column: amount, the full hash on hover, copy. */
function Payout({ w }: { w: Withdrawal }) {
  const tr = useTr();
  if (!w.txid) return <span className="text-muted-foreground">{w.note ?? "—"}</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="tnum">{w.usdt_amount} USDT</span>
      <span title={w.txid} className="max-w-40 truncate font-mono text-footnote text-muted-foreground">
        {w.txid}
      </span>
      <CopyButton text={w.txid} label={tr("复制哈希", "Copy hash")} />
    </span>
  );
}

function Withdrawals() {
  const tr = useTr();
  const { query } = useRoute();
  const status = query.get("status") ?? "pending";
  const [email, text, setText] = useEmailParam();
  const [limit, setLimit] = useState(STEP);
  const q = useQuery({
    queryKey: ["withdrawals", status, email, limit],
    queryFn: () => get<Withdrawal[]>(`/withdrawals${qs({ status: status === "all" ? "" : status, email, limit })}`),
    placeholderData: keepPreviousData,
  });
  const settings = useQuery({
    queryKey: ["commission-settings"],
    queryFn: () => get<{ usdt_rate_cents: number | null }>("/commission-settings"),
  });
  const pending = usePendingWithdrawals();
  const [deciding, setDeciding] = useState<{ w: Withdrawal; approve: boolean } | null>(null);
  const rate = settings.data?.usdt_rate_cents;
  const rows = q.data ?? [];
  const approx = (w: Withdrawal) => (rate ? `≈ ${(w.amount_cents / rate).toFixed(2)} USDT` : null);
  const decide = (w: Withdrawal) =>
    w.status === "pending" ? (
      <span className="inline-flex gap-1">
        <Button size="sm" variant="primary" onClick={(e) => (e.stopPropagation(), setDeciding({ w, approve: true }))}>
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
    ) : null;
  const [columns, chooser] = useColumns<Withdrawal>("withdrawals", [
    {
      key: "user",
      header: tr("用户", "User"),
      className: "max-w-56 truncate",
      cell: (w) => w.user_email ?? <span className="text-muted-foreground">{w.user_label}</span>,
    },
    {
      key: "chain",
      header: tr("网络", "Network"),
      className: "whitespace-nowrap text-muted-foreground",
      cell: (w) => chainName(w.chain),
    },
    {
      key: "address",
      header: tr("地址", "Address"),
      cell: (w) => (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="font-mono text-footnote break-all">{w.address}</span>
          {w.memo && <Badge tone="outline">Memo {w.memo}</Badge>}
        </span>
      ),
    },
    { key: "status", header: tr("状态", "Status"), cell: (w) => <WithdrawalChip status={w.status} /> },
    { key: "paid", header: tr("实付 / 交易哈希", "Paid / tx hash"), cell: (w) => <Payout w={w} /> },
    {
      key: "amount",
      header: tr("申请金额", "Amount"),
      align: "right",
      className: "whitespace-nowrap",
      cell: (w) => (
        <span className="inline-flex flex-col items-end">
          <span className="font-semibold">{yuan(w.amount_cents)}</span>
          {approx(w) && <span className="text-caption text-muted-foreground">{approx(w)}</span>}
        </span>
      ),
    },
    {
      key: "created",
      header: tr("申请时间", "Requested"),
      align: "right",
      className: "whitespace-nowrap text-muted-foreground",
      cell: (w) => <When iso={w.created_at} />,
    },
    {
      key: "act",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      align: "right",
      className: "whitespace-nowrap",
      cell: decide,
    },
  ]);
  const filtered = !!email || !["all", "pending"].includes(status);
  const clear = () => {
    setText("");
    setQuery({ status: "all", email: null });
  };
  return (
    <>
      <LedgerTable
        label={tr("提现", "Withdrawals")}
        rows={rows}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        phone={(w) => ({
          title: w.user_email ?? w.user_label,
          sub: (
            <>
              {chainName(w.chain)} · <span className="font-mono">{w.address}</span>
              {w.memo && ` · Memo ${w.memo}`}
            </>
          ),
          meta: (
            <>
              {shortTime(w.created_at, tr)}
              {approx(w) && ` · ${approx(w)}`}
            </>
          ),
          amount: yuan(w.amount_cents),
          status: <WithdrawalChip status={w.status} />,
          actions: w.status === "pending" ? decide(w) : w.txid || w.note ? <Payout w={w} /> : undefined,
        })}
        empty={
          filtered ? (
            <EmptyState
              icon={SearchX}
              title={tr("没有符合条件的提现", "No withdrawals match")}
              description={
                email
                  ? tr(
                      `没有邮箱为「${email}」的用户的提现（精确匹配）。检查拼写，或清除筛选。`,
                      `No withdrawal by “${email}” (exact match). Check the spelling, or clear the filters.`,
                    )
                  : tr("当前筛选下没有提现。清除筛选查看全部。", "None under these filters. Clear them to see all.")
              }
              action={<Button onClick={clear}>{tr("清除筛选", "Clear filters")}</Button>}
            />
          ) : (
            <EmptyState
              icon={Wallet}
              title={
                status === "pending"
                  ? tr("没有待审核的提现", "No withdrawals to review")
                  : tr("还没有提现申请", "No withdrawal requests yet")
              }
              description={tr(
                "用户在门户申请把返利提现为 USDT 后会出现在这里。",
                "Requests appear here when users withdraw commissions as USDT in the portal.",
              )}
              action={
                status === "pending" ? (
                  <Button onClick={() => setQuery({ status: "all" })}>{tr("查看全部提现", "Show all")}</Button>
                ) : undefined
              }
            />
          )
        }
        toolbar={
          <>
            <SearchField
              aria-label={tr("用户邮箱（精确）", "User email (exact)")}
              placeholder={tr("用户邮箱（精确）", "User email (exact)")}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <ScrollX>
              <Segmented
                label={tr("提现状态", "Withdrawal status")}
                value={status}
                onChange={(v) => {
                  setLimit(STEP);
                  setQuery({ status: v });
                }}
                options={[
                  { value: "pending", label: tr("待审核", "Pending"), count: pending || undefined },
                  { value: "approved", label: tr("已打款", "Paid") },
                  { value: "rejected", label: tr("已拒绝", "Rejected") },
                  { value: "cancelled", label: tr("用户撤销", "Cancelled") },
                  { value: "all", label: tr("全部", "All") },
                ]}
              />
            </ScrollX>
            {chooser}
          </>
        }
        footer={
          <GrowFooter
            count={rows.length}
            limit={limit}
            fetching={q.isFetching}
            onMore={() => setLimit((l) => Math.min(SERVER_MAX, l + STEP))}
          />
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
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const on = (k: string) => tried || shown.has(k);
  const blur = (k: string) => () => setShown((s) => new Set(s).add(k));
  const usdtErr =
    !USDT_RE.test(usdt.trim()) || Number(usdt) <= 0
      ? tr("请输入大于 0 的金额，最多 6 位小数", "A positive amount, at most 6 decimals")
      : undefined;
  const txidErr = !txid.trim()
    ? tr("请填写交易哈希", "Enter the transaction hash")
    : !TXID_RE.test(txid.trim())
      ? tr("格式不对：8–128 位字母、数字或 + / = - _，不含空格", "8–128 letters, digits or + / = - _, no spaces")
      : undefined;
  const noteErr = !approve && !note.trim() ? tr("请填写拒绝原因", "Enter a reason") : undefined;
  const submit = async () => {
    setTried(true);
    if (approve ? usdtErr || txidErr : noteErr) return;
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
      },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      tone={approve ? "default" : "danger"}
      title={approve ? tr("通过提现", "Approve withdrawal") : tr("拒绝提现", "Reject withdrawal")}
      description={`${w.user_email ?? w.user_label} · ${yuan(w.amount_cents)} · ${chainName(w.chain)}`}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant={approve ? "primary" : "destructive"} loading={busy}>
            {approve ? tr("确认已打款", "Confirm paid") : tr("拒绝", "Reject")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {approve ? (
          <>
            <Callout tone="info">
              {tr(
                "先在交易所或钱包向下面的地址打款，再回填实付 USDT 与交易哈希。",
                "Pay to the address below from your exchange or wallet first, then record the USDT sent and the hash.",
              )}
            </Callout>
            <div className="grid gap-1.5">
              <span className="text-footnote font-medium text-muted-foreground">
                {tr(`收款地址（${chainName(w.chain)}）`, `Address (${chainName(w.chain)})`)}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Mono>{w.address}</Mono>
                <CopyButton text={w.address} />
              </div>
              {w.memo && (
                <div className="flex flex-wrap items-center gap-2 text-body">
                  Memo <Mono>{w.memo}</Mono>
                  <CopyButton text={w.memo} />
                </div>
              )}
            </div>
            <Field label={tr("实付 USDT", "USDT paid")} error={on("usdt") ? usdtErr : undefined}>
              <Input inputMode="decimal" value={usdt} onChange={(e) => setUsdt(e.target.value)} onBlur={blur("usdt")} />
            </Field>
            <Field label={tr("交易哈希（txid）", "Transaction hash (txid)")} error={on("txid") ? txidErr : undefined}>
              <Input
                value={txid}
                onChange={(e) => setTxid(e.target.value)}
                onBlur={blur("txid")}
                autoComplete="off"
                spellCheck={false}
                data-autofocus
              />
            </Field>
          </>
        ) : (
          <Callout tone="warning">
            {tr(
              "拒绝后申请金额退回用户余额，原因会显示给用户。",
              "The amount goes back to the balance; the user sees the reason.",
            )}
          </Callout>
        )}
        <Field
          label={
            approve ? tr("备注（可选）", "Note (optional)") : tr("拒绝原因（用户可见）", "Reason (shown to the user)")
          }
          error={on("note") ? noteErr : undefined}
        >
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={blur("note")}
            maxLength={200}
            data-autofocus={approve ? undefined : true}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function Balances() {
  const tr = useTr();
  const [email, text, setText] = useEmailParam();
  const [limit, setLimit] = useState(STEP);
  const q = useQuery({
    queryKey: ["balances", email, limit],
    queryFn: () => get<BalanceRow[]>(`/balances${qs({ email, limit })}`),
    placeholderData: keepPreviousData,
  });
  const [adjust, setAdjust] = useState<BalanceRow | null>(null);
  const rows = (q.data ?? []).map((b) => ({ ...b, id: b.user_id }));
  type Row = BalanceRow & { id: string };
  const adjustButton = (b: Row) => (
    <Button size="sm" onClick={(e) => (e.stopPropagation(), setAdjust(b))}>
      {tr("调整", "Adjust")}
    </Button>
  );
  const [columns, chooser] = useColumns<Row>("balances", [
    { key: "email", header: tr("用户", "User"), className: "max-w-72 truncate", cell: (b) => b.email },
    {
      key: "updated",
      header: tr("最近变动", "Last change"),
      optional: true,
      className: "whitespace-nowrap text-muted-foreground",
      cell: (b) => <When iso={b.updated_at} />,
    },
    {
      key: "balance",
      header: tr("余额", "Balance"),
      align: "right",
      cell: (b) => <span className="font-semibold">{yuan(b.balance_cents)}</span>,
    },
    {
      key: "act",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      align: "right",
      className: "w-24",
      cell: adjustButton,
    },
  ]);
  return (
    <>
      <LedgerTable
        label={tr("余额", "Balances")}
        rows={rows}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        onRowClick={(b) => navigate(`/users?open=${b.user_id}`)}
        phone={(b) => ({
          title: <span className="truncate">{b.email}</span>,
          meta: b.updated_at
            ? tr(`最近变动 ${shortTime(b.updated_at, tr)}`, `Changed ${shortTime(b.updated_at, tr)}`)
            : undefined,
          amount: yuan(b.balance_cents),
          actions: adjustButton(b),
        })}
        empty={
          email ? (
            <EmptyState
              icon={SearchX}
              title={tr("没有找到这个用户", "No such user")}
              description={tr(
                `没有邮箱为「${email}」的账户（精确匹配）。检查拼写，或清除搜索。`,
                `No account with the address “${email}” (exact match). Check the spelling, or clear the search.`,
              )}
              action={<Button onClick={() => setText("")}>{tr("清除搜索", "Clear the search")}</Button>}
            />
          ) : (
            <EmptyState
              icon={Wallet}
              title={tr("还没有人有余额", "Nobody holds a balance yet")}
              description={tr(
                "用上面的搜索按邮箱找到任何用户，即可调整其余额。",
                "Search any user by email above to adjust their balance.",
              )}
            />
          )
        }
        toolbar={
          <>
            <SearchField
              aria-label={tr("按邮箱查找任意用户", "Find anyone by email")}
              placeholder={tr("按邮箱查找任意用户（精确）", "Find anyone by email (exact)")}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {chooser}
          </>
        }
        footer={
          <GrowFooter
            count={rows.length}
            limit={limit}
            fetching={q.isFetching}
            onMore={() => setLimit((l) => Math.min(SERVER_MAX, l + STEP))}
          />
        }
      />
      {adjust && <AdjustBalanceDialog id={adjust.user_id} email={adjust.email} onClose={() => setAdjust(null)} />}
    </>
  );
}

type CStatus = "" | "pending" | "credited" | "reversed";

const C_CHIP: Record<string, ["warning" | "success" | "danger", LucideIcon]> = {
  pending: ["warning", Clock],
  credited: ["success", CircleCheck],
  reversed: ["danger", Undo2],
};

function Commissions() {
  const tr = useTr();
  const { query } = useRoute();
  const raw = query.get("status") ?? "";
  const status = (["pending", "credited", "reversed"].includes(raw) ? raw : "") as CStatus;
  const [email, text, setText] = useEmailParam();
  const [limit, setLimit] = useState(STEP);
  const q = useQuery({
    queryKey: ["commissions", status, email, limit],
    queryFn: () => get<Commission[]>(`/commissions${qs({ status, email, limit })}`),
    placeholderData: keepPreviousData,
  });
  const rows = q.data ?? [];
  const cText = (s: string) =>
    ({ pending: tr("冻结中", "Held"), credited: tr("已入账", "Credited"), reversed: tr("已撤销", "Reversed") })[s] ??
    tr("未知状态", "Unknown");
  const chip = (c: Commission) => {
    const [tone, Icon] = C_CHIP[c.status] ?? ["warning", CircleDashed];
    return (
      <span className="inline-flex flex-wrap justify-end gap-1">
        <Badge tone={tone}>
          <Icon aria-hidden="true" />
          {cText(c.status)}
        </Badge>
        {c.clawback_cents ? (
          <Badge tone="danger">{tr(`追回 ${yuan(c.clawback_cents)}`, `clawback ${yuan(c.clawback_cents)}`)}</Badge>
        ) : null}
      </span>
    );
  };
  const orderLink = (c: Commission) => (
    <Link
      to={`/orders?no=${encodeURIComponent(c.out_trade_no)}`}
      onClick={(e) => e.stopPropagation()}
      className="font-mono text-footnote text-primary underline-offset-4 hover:underline"
    >
      {c.out_trade_no}
    </Link>
  );
  const [columns, chooser] = useColumns<Commission>("commissions", [
    {
      key: "inviter",
      header: tr("邀请人", "Inviter"),
      className: "max-w-56 truncate",
      cell: (c) => c.inviter_email ?? c.inviter_label,
    },
    {
      key: "invitee",
      header: tr("被邀请人", "Invitee"),
      className: "max-w-56 truncate text-muted-foreground",
      cell: (c) => c.invitee_email ?? c.invitee_label,
    },
    { key: "order", header: tr("订单", "Order"), className: "whitespace-nowrap", cell: orderLink },
    { key: "status", header: tr("状态", "Status"), cell: chip },
    {
      key: "available",
      header: tr("可入账时间", "Available"),
      optional: true,
      className: "whitespace-nowrap text-muted-foreground",
      cell: (c) => <When iso={c.available_at} />,
    },
    {
      key: "amount",
      header: tr("返利", "Commission"),
      align: "right",
      className: "whitespace-nowrap",
      cell: (c) => (
        <span className="inline-flex flex-col items-end">
          <span className="font-semibold">{yuan(c.amount_cents)}</span>
          <span className="text-caption text-muted-foreground">
            {c.rate_percent}% × {yuan(c.base_cents)}
          </span>
        </span>
      ),
    },
    {
      key: "created",
      header: tr("时间", "Created"),
      align: "right",
      className: "whitespace-nowrap text-muted-foreground",
      cell: (c) => <When iso={c.created_at} />,
    },
  ]);
  const filtered = !!(status || email);
  const clear = () => {
    setText("");
    setQuery({ status: null, email: null });
  };
  return (
    <div className="grid gap-3">
      <Callout tone="info">
        {tr("返利比例、冻结天数、USDT 网络等设置已移到 ", "The commission rate, hold days and USDT networks moved to ")}
        <Link to="/settings/commission" className="font-medium text-primary underline-offset-4 hover:underline">
          {tr("系统设置 → 邀请返利", "Settings → Invite commissions")}
        </Link>
        {tr("。", ".")}
      </Callout>
      <LedgerTable
        label={tr("返利记录", "Commissions")}
        rows={rows}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        phone={(c) => ({
          title: <span className="truncate">{c.inviter_email ?? c.inviter_label}</span>,
          sub: tr(
            `邀请 ${c.invitee_email ?? c.invitee_label} · ${c.rate_percent}% × ${yuan(c.base_cents)}`,
            `invited ${c.invitee_email ?? c.invitee_label} · ${c.rate_percent}% × ${yuan(c.base_cents)}`,
          ),
          meta: (
            <>
              {orderLink(c)} · {shortTime(c.created_at, tr)}
            </>
          ),
          amount: yuan(c.amount_cents),
          status: chip(c),
        })}
        empty={
          filtered ? (
            <EmptyState
              icon={SearchX}
              title={tr("没有符合条件的返利", "No commissions match")}
              description={
                email
                  ? tr(
                      `没有邀请人邮箱为「${email}」的返利（精确匹配）。检查拼写，或清除筛选。`,
                      `No commission for the inviter “${email}” (exact match). Check the spelling, or clear the filters.`,
                    )
                  : tr("当前筛选下没有返利。清除筛选查看全部。", "None under these filters. Clear them to see all.")
              }
              action={<Button onClick={clear}>{tr("清除筛选", "Clear filters")}</Button>}
            />
          ) : (
            <EmptyState
              icon={HandCoins}
              title={tr("还没有返利", "No commissions yet")}
              description={tr(
                "被邀请的用户付款后，邀请人的返利会出现在这里。",
                "A commission appears here when an invited user pays.",
              )}
            />
          )
        }
        toolbar={
          <>
            <SearchField
              aria-label={tr("邀请人邮箱", "Inviter email")}
              placeholder={tr("邀请人邮箱（精确）", "Inviter email (exact)")}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <ScrollX>
              <Segmented
                label={tr("返利状态", "Commission status")}
                value={status}
                onChange={(v) => {
                  setLimit(STEP);
                  setQuery({ status: v || null });
                }}
                options={[
                  { value: "", label: tr("全部", "All") },
                  { value: "pending", label: tr("冻结中", "Held") },
                  { value: "credited", label: tr("已入账", "Credited") },
                  { value: "reversed", label: tr("已撤销", "Reversed") },
                ]}
              />
            </ScrollX>
            {chooser}
          </>
        }
        footer={
          <GrowFooter
            count={rows.length}
            limit={limit}
            fetching={q.isFetching}
            onMore={() => setLimit((l) => Math.min(SERVER_MAX, l + STEP))}
          />
        }
      />
    </div>
  );
}
