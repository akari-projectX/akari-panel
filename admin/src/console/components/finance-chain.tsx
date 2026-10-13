// 资金 · 链上收款 (C2, FIN-06): the USDT on-chain transfers the watcher saw
// and each on-chain method's watcher state (`GET /payments/chain-transfers`).
// Unmatched transfers (no order, a second payment, ambiguous) are never
// credited by themselves: the admin assigns one to an unpaid order of the
// same method (`…/assign`, the order is paid through the one payment path;
// a transfer less than the order's exact amount needs a second, explicit
// confirmation) or ignores it (`…/ignore`, handled outside the panel). Both
// need a reason and are audited. Filters (status, method) live in the URL.
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Ban, Coins, Link2, Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { get, post, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateTime, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented, Select, Textarea } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { EmptyState, ErrorState, SkeletonRows } from "../../shared/ui/states";
import { useAction } from "../data";
import { useQS } from "../router";
import { CopyText } from "./kit";
import { networkName, TxLink, usdt } from "./payments-chain";

export { usdt } from "./payments-chain";

export type ChainTransfer = {
  id: number;
  method_id: string;
  method_name: string | null;
  chain: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: string | null;
  confirmations: number | null;
  from_address: string;
  amount_units: number;
  amount: string;
  status: "pending" | "credited" | "unmatched" | "assigned" | "ignored" | "dropped";
  reason: string | null;
  order_id: string | null;
  out_trade_no: string | null;
  order_amount_cents: number | null;
  order_expected_units: number | null;
  note: string | null;
  seen_at: string;
  confirmed_at: string | null;
  resolved_at: string | null;
  resolved_by_email: string | null;
};

export type ChainWatcher = {
  method_id: string;
  display_name: string;
  enabled: boolean;
  chain: string | null;
  next_block: number | null;
  head: number | null;
  head_at: string | null;
  last_error: string | null;
  failing_since: string | null;
  pending: number;
  unmatched: number;
};

type Listing = { transfers: ChainTransfer[]; watchers: ChainWatcher[] };

const PAGE = 100;

function statusOf(t: ChainTransfer, tr: Tr): [string, Tone] {
  switch (t.status) {
    case "pending":
      return [tr("确认中", "Confirming"), "info"];
    case "credited":
      return [tr("已入账", "Credited"), "success"];
    case "assigned":
      return [tr("已指定订单", "Assigned"), "success"];
    case "ignored":
      return [tr("已忽略", "Ignored"), "neutral"];
    case "dropped":
      return [tr("已失效", "Dropped"), "neutral"];
    default:
      return [tr("未匹配", "Unmatched"), "warning"];
  }
}

function reasonText(r: string | null, tr: Tr): string | null {
  switch (r) {
    case "no_order":
      return tr(
        "没有金额相符的订单（如少付了尾数、金额不对或在保留期外）",
        "No order with this exact amount (last digits left out, a wrong amount, or outside the window)",
      );
    case "order_paid":
      return tr("订单已付过款（重复付款）", "The order was already paid (a second payment)");
    case "ambiguous":
      return tr("多个订单的金额相同，无法自动判断", "Several orders have this amount; the panel cannot tell which");
    case "reverted":
      return tr("交易执行失败", "The transaction failed");
    case "missing":
      return tr("交易已不在链上（重组）", "The transaction left the chain (reorg)");
    default:
      return null;
  }
}

type Filter = "unmatched" | "pending" | "all";
const FILTERS: Filter[] = ["unmatched", "pending", "all"];

export function ChainTransfers() {
  const tr = useTr();
  const [query, patch] = useQS();
  const raw = query.get("status") ?? "";
  const filter: Filter = (FILTERS as string[]).includes(raw) ? (raw as Filter) : "unmatched";
  const method = query.get("method") ?? "";
  const [assign, setAssign] = useState<ChainTransfer | null>(null);
  const [ignore, setIgnore] = useState<ChainTransfer | null>(null);
  const q = useInfiniteQuery({
    queryKey: ["chain-transfers", filter, method],
    queryFn: ({ pageParam }) =>
      get<Listing>(
        `/payments/chain-transfers${qs({
          status: filter === "all" ? undefined : filter,
          method_id: method || undefined,
          before: pageParam,
          limit: PAGE,
        })}`,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) =>
      last.transfers.length === PAGE ? last.transfers[last.transfers.length - 1].id : undefined,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const watchers = q.data?.pages[0]?.watchers ?? [];
  const rows = q.data?.pages.flatMap((p) => p.transfers) ?? [];
  const shown = method ? watchers.filter((w) => w.method_id === method) : watchers;
  const unmatched = shown.reduce((n, w) => n + w.unmatched, 0);
  const pending = shown.reduce((n, w) => n + w.pending, 0);

  return (
    <div className="grid grid-cols-1 gap-4">
      {watchers
        .filter((w) => w.failing_since)
        .map((w) => (
          <Banner key={w.method_id} tone="danger" icon={<AlertTriangle />} title={w.display_name}>
            {tr("读取链上数据失败（自 ", "Reading the chain fails (since ")}
            {dateTime(w.failing_since!)}
            {tr("）；恢复后会从断点继续，不会漏掉转账：", "); it resumes where it stopped, no transfer is missed: ")}
            <span className="font-mono">{w.last_error}</span>
          </Banner>
        ))}
      {watchers.length > 0 && (
        <Card className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2" aria-label={tr("监听状态", "Watchers")}>
          {watchers.map((w) => (
            <WatcherCard key={w.method_id} w={w} />
          ))}
        </Card>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Filter>
          label={tr("状态", "Status")}
          value={filter}
          onChange={(v) => patch({ status: v === "unmatched" ? null : v })}
          options={[
            { value: "unmatched", label: tr("未匹配", "Unmatched"), count: unmatched || undefined },
            { value: "pending", label: tr("确认中", "Confirming"), count: pending || undefined },
            { value: "all", label: tr("全部", "All") },
          ]}
        />
        {watchers.length > 1 && (
          <Select
            aria-label={tr("收款方式", "Payment method")}
            className="w-auto"
            value={method}
            onChange={(e) => patch({ method: e.target.value || null })}
          >
            <option value="">{tr("全部收款方式", "All methods")}</option>
            {watchers.map((w) => (
              <option key={w.method_id} value={w.method_id}>
                {w.display_name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isPending ? (
        <SkeletonRows rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Coins}
          title={
            filter === "unmatched"
              ? tr("没有未匹配的转账", "No unmatched transfers")
              : filter === "pending"
                ? tr("没有确认中的转账", "No transfers confirming")
                : tr("还没有链上转账", "No on-chain transfers yet")
          }
          description={
            watchers.length === 0
              ? tr(
                  "先在 系统设置 → 支付方式 添加「USDT 链上收款」。",
                  "Add a “USDT on-chain” method in Settings → Payment methods first.",
                )
              : tr(
                  "金额与订单一致的转账达到确认数后会自动入账；对不上的才会出现在「未匹配」里。",
                  "Transfers matching an order's exact amount are credited by themselves once confirmed; only the rest show up as unmatched.",
                )
          }
        />
      ) : (
        <Card className="divide-y divide-separator" data-testid="chain-transfers">
          {rows.map((t) => (
            <TransferRow key={t.id} t={t} onAssign={() => setAssign(t)} onIgnore={() => setIgnore(t)} />
          ))}
          {q.hasNextPage && (
            <div className="p-3 text-center">
              <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                {tr("加载更多", "Load more")}
              </Button>
            </div>
          )}
        </Card>
      )}
      {assign && <AssignDialog t={assign} onClose={() => setAssign(null)} />}
      {ignore && <IgnoreDialog t={ignore} onClose={() => setIgnore(null)} />}
    </div>
  );
}

function WatcherCard({ w }: { w: ChainWatcher }) {
  const tr = useTr();
  const behind = w.head != null && w.next_block != null ? Math.max(0, w.head - w.next_block + 1) : null;
  return (
    <div className="flex min-w-0 items-start gap-3 text-body" data-watcher={w.method_id}>
      <Coins
        className={cn("mt-0.5 size-4 shrink-0", w.failing_since ? "text-destructive" : "text-muted-foreground")}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 font-medium">
          <span className="truncate">{w.display_name}</span>
          <span className="text-footnote font-normal text-muted-foreground">{networkName(w.chain)}</span>
          {!w.enabled && <Badge tone="neutral">{tr("已停用", "Disabled")}</Badge>}
          {w.unmatched > 0 && <Badge tone="warning">{tr(`${w.unmatched} 笔未匹配`, `${w.unmatched} unmatched`)}</Badge>}
          {w.pending > 0 && <Badge tone="info">{tr(`${w.pending} 笔确认中`, `${w.pending} confirming`)}</Badge>}
        </div>
        <div className="mt-0.5 text-footnote text-muted-foreground tnum">
          {w.head != null
            ? tr(`最新区块 ${w.head.toLocaleString()}`, `Head ${w.head.toLocaleString()}`)
            : tr("尚未读到区块", "No block read yet")}
          {w.next_block != null &&
            tr(
              ` · 已读到 ${(w.next_block - 1).toLocaleString()}`,
              ` · read up to ${(w.next_block - 1).toLocaleString()}`,
            )}
          {behind != null &&
            behind > 0 &&
            tr(`（落后 ${behind} 块，含未确认的尾部）`, ` (${behind} behind, incl. the unconfirmed tail)`)}
          {w.head_at ? ` · ${dateTime(w.head_at)}` : ""}
        </div>
        {w.last_error && !w.failing_since && (
          <div className="mt-0.5 truncate text-footnote text-warning" title={w.last_error}>
            {tr("上次错误：", "Last error: ")}
            <span className="font-mono">{w.last_error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TransferRow({ t, onAssign, onIgnore }: { t: ChainTransfer; onAssign: () => void; onIgnore: () => void }) {
  const tr = useTr();
  const [label, tone] = statusOf(t, tr);
  const why = reasonText(t.reason, tr);
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4" data-transfer={t.id}>
      <div className="min-w-0 flex-1 basis-72">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-headline tnum">{t.amount}</span>
          <span className="text-footnote text-muted-foreground">USDT · {networkName(t.chain)}</span>
          <Badge tone={tone}>{label}</Badge>
          {t.status === "pending" && t.confirmations != null && (
            <span className="text-footnote text-muted-foreground tnum">
              {tr(`${t.confirmations} 个确认`, `${t.confirmations} confirmations`)}
            </span>
          )}
        </div>
        {why && <div className="mt-1 text-footnote text-muted-foreground">{why}</div>}
        <div className="mt-1.5 grid grid-cols-1 gap-0.5 text-footnote text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">{tr("交易", "Tx")}</span>
            <CopyText
              value={t.tx_hash}
              display={`${t.tx_hash.slice(0, 14)}…${t.tx_hash.slice(-6)}`}
              label={tr("交易哈希", "the transaction hash")}
            />
            <TxLink chain={t.chain} hash={t.tx_hash} />
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">{tr("来自", "From")}</span>
            <CopyText value={t.from_address} label={tr("来源地址", "the sender address")} />
          </span>
          <span className="tnum">
            {t.block_time
              ? tr(`区块时间 ${dateTime(t.block_time)}`, `Block time ${dateTime(t.block_time)}`)
              : tr(`看到于 ${dateTime(t.seen_at)}`, `Seen ${dateTime(t.seen_at)}`)}
            {` · #${t.block_number.toLocaleString()}`}
            {t.method_name ? ` · ${t.method_name}` : ""}
          </span>
          {t.out_trade_no && t.order_id && (
            <span>
              {tr("订单 ", "Order ")}
              <Link to={`/orders?open=${t.order_id}`} className="font-mono text-primary hover:underline">
                {t.out_trade_no}
              </Link>
              {t.order_expected_units != null &&
                tr(`（应付 ${usdt(t.order_expected_units)} USDT）`, ` (asks for ${usdt(t.order_expected_units)} USDT)`)}
            </span>
          )}
          {t.note && (
            <span>
              {tr("处理说明：", "Note: ")}
              {t.note}
              {t.resolved_by_email ? ` · ${t.resolved_by_email}` : ""}
              {t.resolved_at ? ` · ${dateTime(t.resolved_at)}` : ""}
            </span>
          )}
        </div>
      </div>
      {t.status === "unmatched" && (
        <div className="flex gap-2">
          <Button size="sm" icon={Link2} onClick={onAssign}>
            {tr("指派", "Assign")}
          </Button>
          <Button size="sm" variant="ghost" icon={Ban} onClick={onIgnore}>
            {tr("忽略", "Ignore")}
          </Button>
        </div>
      )}
    </div>
  );
}

type Candidate = {
  id: string;
  out_trade_no: string;
  status: string;
  user_email: string | null;
  plan_name: string;
  amount_cents: number;
  created_at: string;
  amount_units: number;
  reserved_until: string;
};

type FoundOrder = {
  id: string;
  out_trade_no: string;
  status: string;
  amount_cents: number;
  payment_method_id: string | null;
  user_email: string | null;
  plan_name: string;
  created_at: string;
  chain: { amount_units: number; reserved_until: string } | null;
};

function orderStatusText(s: string, tr: Tr): string {
  return s === "pending"
    ? tr("待支付", "Pending")
    : s === "expired"
      ? tr("已过期", "Expired")
      : s === "cancelled"
        ? tr("已取消", "Cancelled")
        : s;
}

/**
 * Assign: pick one of the method's unpaid orders (closest amount first) or
 * find one by its number; both amounts side by side; a shortfall asks a
 * second time; a reason is required.
 */
function AssignDialog({ t, onClose }: { t: ChainTransfer; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const cands = useQuery({
    queryKey: ["chain-transfers", "candidates", t.id],
    queryFn: () => get<{ orders: Candidate[] }>(`/payments/chain-transfers/${t.id}/candidates`),
  });
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [otn, setOtn] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const [run, busy] = useAction();

  const find = async () => {
    const no = otn.trim();
    setLookupError(null);
    if (!no) return;
    setFinding(true);
    try {
      const rows = await get<FoundOrder[]>(`/orders${qs({ out_trade_no: no, limit: 1 })}`);
      const o = rows[0];
      if (!o) setLookupError(tr("找不到这个订单号", "No order with this number"));
      else if (o.payment_method_id !== t.method_id || !o.chain)
        setLookupError(
          tr(
            "这个订单不是用这笔转账的收款方式下的，不能指派（转账只能付同一收款方式的订单）",
            "This order uses another payment method; a transfer can only pay an order of its own method",
          ),
        );
      else if (o.status === "paid") setLookupError(tr("这个订单已付款", "This order is already paid"));
      else
        setPicked({
          id: o.id,
          out_trade_no: o.out_trade_no,
          status: o.status,
          user_email: o.user_email,
          plan_name: o.plan_name,
          amount_cents: o.amount_cents,
          created_at: o.created_at,
          amount_units: o.chain.amount_units,
          reserved_until: o.chain.reserved_until,
        });
    } catch {
      setLookupError(tr("查询失败，请重试", "The lookup failed; try again"));
    } finally {
      setFinding(false);
    }
  };

  const diff = picked ? t.amount_units - picked.amount_units : 0;
  const short = picked != null && diff < 0;
  const reasonError = shown && !reason.trim() ? tr("请填写原因", "Enter a reason") : undefined;

  const submit = async () => {
    setShown(true);
    if (!picked || !reason.trim()) return;
    if (short) {
      const ok = await confirm({
        tone: "warning",
        title: tr("转账少于订单应付金额", "The transfer is less than the order asks for"),
        description: tr(
          "这笔转账比订单应付的精确金额少。确认你已核实（例如工单里的付款截图），仍为该订单付款并开通。",
          "This transfer is less than the order's exact amount. Confirm you have checked it (e.g. the payer's proof in a ticket) and pay the order anyway.",
        ),
        impacts: [
          { label: tr("订单应付", "The order asks for"), value: `${usdt(picked.amount_units)} USDT` },
          { label: tr("这笔转账", "This transfer"), value: `${t.amount} USDT` },
          { label: tr("少付", "Short by"), value: `${usdt(-diff)} USDT` },
        ],
        confirmLabel: tr("仍然付款", "Pay anyway"),
      });
      if (!ok) return;
    }
    const r = await run(
      () =>
        post(`/payments/chain-transfers/${t.id}/assign`, {
          order_id: picked.id,
          reason: reason.trim(),
          confirm_short: short,
        }),
      { ok: tr("已为订单付款", "The order is paid") },
    );
    if (r !== undefined) onClose();
  };

  const list = cands.data?.orders ?? [];
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      icon={Link2}
      title={tr("把转账指派给订单", "Assign the transfer to an order")}
      description={`${t.amount} USDT · ${networkName(t.chain)} · ${t.method_name ?? ""}`}
      dirty={!!picked || !!reason}
      onSubmit={submit}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!picked}>
            {tr("为订单付款", "Pay the order")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field
          group
          label={tr(
            "同一收款方式下未付款的订单（金额最接近的在前）",
            "Unpaid orders of the same method (closest amount first)",
          )}
        >
          {cands.isPending ? (
            <SkeletonRows rows={2} />
          ) : cands.isError ? (
            <ErrorState error={cands.error} onRetry={() => cands.refetch()} />
          ) : list.length === 0 ? (
            <p className="text-footnote text-muted-foreground">
              {tr(
                "最近 7 天没有未付款的订单；可以按订单号查找。",
                "No unpaid order in the last 7 days; find one by its number.",
              )}
            </p>
          ) : (
            <div role="radiogroup" aria-label={tr("候选订单", "Candidate orders")} className="grid grid-cols-1 gap-1.5">
              {list.map((o) => {
                const d = t.amount_units - o.amount_units;
                return (
                  <label
                    key={o.id}
                    data-candidate={o.out_trade_no}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 ring-1 ring-border ring-inset hover:bg-accent",
                      picked?.id === o.id && "bg-primary-soft ring-primary",
                    )}
                  >
                    <input
                      type="radio"
                      name="chain-candidate"
                      className="mt-1"
                      checked={picked?.id === o.id}
                      onChange={() => setPicked(o)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2">
                        <span className="font-mono text-footnote">{o.out_trade_no}</span>
                        <Badge tone="neutral">{orderStatusText(o.status, tr)}</Badge>
                      </span>
                      <span className="block truncate text-footnote text-muted-foreground">
                        {o.plan_name} · {o.user_email ?? "—"} · {dateTime(o.created_at)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-mono text-footnote tnum">
                      {usdt(o.amount_units)}
                      <span className={cn("block", d < 0 ? "text-warning" : "text-muted-foreground")}>
                        {d === 0 ? tr("金额相同", "same") : `${d > 0 ? "+" : ""}${usdt(d)}`}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </Field>
        <Field label={tr("或按订单号查找", "Or find it by number")} error={lookupError ?? undefined}>
          <div className="flex gap-2">
            <Input
              className="font-mono text-footnote"
              value={otn}
              onChange={(e) => setOtn(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void find();
                }
              }}
              placeholder="AK2026…"
            />
            <Button icon={Search} onClick={() => void find()} loading={finding}>
              {tr("查找", "Find")}
            </Button>
          </div>
        </Field>
        {picked && (
          <div className="grid gap-1 rounded-lg bg-secondary p-3 text-body" data-testid="assign-compare">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{tr("订单", "Order")}</span>
              <span className="min-w-0 truncate">
                <span className="font-mono text-footnote">{picked.out_trade_no}</span> · {picked.plan_name} ·{" "}
                {yuan(picked.amount_cents)}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{tr("订单应付", "The order asks for")}</span>
              <span className="font-mono tnum">{usdt(picked.amount_units)} USDT</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{tr("这笔转账", "This transfer")}</span>
              <span className={cn("font-mono tnum", short && "text-warning")}>{t.amount} USDT</span>
            </div>
            {diff !== 0 && (
              <div className={cn("text-footnote", short ? "text-warning" : "text-muted-foreground")}>
                {short
                  ? tr(
                      `少付 ${usdt(-diff)} USDT：付款前会再确认一次`,
                      `Short by ${usdt(-diff)} USDT: you will be asked to confirm`,
                    )
                  : tr(
                      `多付 ${usdt(diff)} USDT（多出的部分不会退回余额）`,
                      `Over by ${usdt(diff)} USDT (the excess is not credited anywhere)`,
                    )}
              </div>
            )}
          </div>
        )}
        <Field
          label={tr("原因（记入审计与订单）", "Reason (kept in the audit log and on the order)")}
          error={reasonError}
        >
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function IgnoreDialog({ t, onClose }: { t: ChainTransfer; onClose: () => void }) {
  const tr = useTr();
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const [run, busy] = useAction();
  const submit = async () => {
    setShown(true);
    if (!reason.trim()) return;
    const r = await run(() => post(`/payments/chain-transfers/${t.id}/ignore`, { reason: reason.trim() }), {
      ok: tr("已忽略", "Ignored"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      icon={Ban}
      title={tr("忽略这笔转账", "Ignore this transfer")}
      description={`${t.amount} USDT · ${networkName(t.chain)}`}
      dirty={!!reason}
      onSubmit={submit}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="destructive" loading={busy}>
            {tr("忽略", "Ignore")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3">
        <p className="text-body text-muted-foreground">
          {tr(
            "忽略后这笔钱不会给任何订单入账，也不能再指派。只在已经在面板外处理（如原路退回）时使用。",
            "Once ignored, this money pays no order and cannot be assigned later. Use it only when it was handled outside the panel (e.g. sent back).",
          )}
        </p>
        <Field
          label={tr("原因（如：已在链外退回）", "Reason (e.g. sent back outside the panel)")}
          error={shown && !reason.trim() ? tr("请填写原因", "Enter a reason") : undefined}
        >
          <Textarea data-autofocus rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
