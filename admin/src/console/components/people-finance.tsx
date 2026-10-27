// 资金 · 提现审核 (FIN-01, FIN-02; proposal-v2 §2, prototype
// pages/finance-withdrawals.tsx): a review queue. Left the list (status +
// email filter in the URL, pending oldest first, waiting time), right the
// review panel (amount → USDT reference, address and memo to copy, the
// approve form with per-chain hash checks, the reject panel, the user's
// balance and earlier withdrawals). On narrow screens the list opens the
// same panel in a full-screen dialog. Shared bits of the finance page
// (summary, chain badge, search-in-URL, media query) live here too.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, Ban, Check, CheckCheck, ChevronRight, Clock, Inbox, SearchX, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router";
import { get, post, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateOnly, dateTime, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented, Select, Textarea } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { EmptyState, ErrorState, SkeletonRows } from "../../shared/ui/states";
import { useAction } from "../data";
import { useDebounced } from "../kit";
import { setQuery, useQS } from "../router";
import { Avatar, CopyText, FixCount, SearchField } from "./kit";

/* ---------- data ---------- */

export type Withdrawal = {
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

/** `GET /finance/summary`: the header strip and the status counts. */
export type FinanceSummary = {
  withdrawals: {
    pending: number;
    pending_cents: number;
    oldest_pending_at: string | null;
    approved: number;
    rejected: number;
    cancelled: number;
  };
  balances: { users: number; total_cents: number };
  commissions: { pending: number; pending_cents: number; credited: number; reversed: number; month_cents: number };
};

/** Root "withdrawals": every write to withdrawals, users (balance) and orders refetches it. */
export function useFinanceSummary() {
  return useQuery({ queryKey: ["withdrawals", "summary"], queryFn: () => get<FinanceSummary>("/finance/summary") });
}

export type CommissionSettings = {
  enabled: boolean;
  rate_percent: number;
  first_order_only: boolean;
  hold_days: number;
  min_withdrawal_cents: number;
  usdt_chains: string[];
  usdt_rate_cents: number | null;
};

export function useCommissionSettings() {
  return useQuery({
    queryKey: ["commission-settings"],
    queryFn: () => get<CommissionSettings>("/commission-settings"),
  });
}

/** The server's cap on every finance list (`limit` ≤ 500, no cursor). */
export const SERVER_MAX = 500;

/* ---------- small helpers ---------- */

/** A media query as state (narrow screens get list → full-screen dialog). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}

/**
 * A search box bound (debounced) to a query parameter; typing replaces the
 * history entry and closes an open record at once. Follows outside changes (clear
 * filters, Back).
 */
export function useSearchParam(key: string): [string, string, (v: string) => void] {
  const [query] = useQS();
  const value = query.get(key) ?? "";
  const [text, setText] = useState(value);
  const d = useDebounced(text.trim(), 300);
  const written = useRef(value);
  useEffect(() => {
    if (d === written.current) return;
    written.current = d;
    setQuery({ [key]: d || null }, true);
  }, [d, key]);
  useEffect(() => {
    if (value === written.current) return;
    written.current = value;
    setText(value);
  }, [value]);
  // Typing closes the open record at once — not when the debounced term
  // lands, which would close a record opened right after typing.
  const type = (v: string) => {
    setText(v);
    if (query.get("open")) setQuery({ open: null }, true);
  };
  return [value, text, type];
}

/** "3 小时" / "2 天 4 小时" since `iso`; `long` = a day or more. */
export function waited(iso: string, tr: Tr): { text: string; long: boolean } {
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 60) return { text: tr(`${min} 分钟`, `${min} min`), long: false };
  const h = Math.floor(min / 60);
  if (h < 24) return { text: tr(`${h} 小时`, `${h} h`), long: false };
  const d = Math.floor(h / 24);
  return { text: tr(`${d} 天 ${h % 24} 小时`, `${d} d ${h % 24} h`), long: true };
}

/** "10-12 14:03" in the site time zone. */
export const shortTime = (iso: string) => dateTime(iso).slice(5);

/* ---------- chains ---------- */

const CHAINS: Record<string, { label: string; name: string; tone: Tone }> = {
  trc20: { label: "TRC20", name: "Tron (TRC20)", tone: "danger" },
  plasma: { label: "Plasma", name: "Plasma", tone: "primary" },
  polygon: { label: "Polygon", name: "Polygon PoS", tone: "info" },
  arbitrum: { label: "Arbitrum", name: "Arbitrum One", tone: "info" },
  solana: { label: "Solana", name: "Solana (SPL)", tone: "success" },
  xlayer: { label: "X Layer", name: "X Layer", tone: "neutral" },
  ton: { label: "TON", name: "TON (Jetton)", tone: "info" },
};
const EVM = new Set(["plasma", "polygon", "arbitrum", "xlayer"]);

function ChainBadge({ chain }: { chain: string }) {
  const c = CHAINS[chain];
  return (
    <Badge tone={c?.tone ?? "neutral"} className="font-mono">
      {c?.label ?? chain}
    </Badge>
  );
}

/** What the server accepts (commission.rs `txid_ok`). */
const TXID_RE = /^[A-Za-z0-9_+/=-]{8,128}$/;
const USDT_RE = /^\d+(\.\d{1,6})?$/;

/**
 * The hash check: the server's shape always; TRC20 and the EVM chains also
 * their exact form (64 hex, without / with 0x). Solana and TON only get a
 * hint (several valid encodings).
 */
function hashCheck(chain: string, raw: string, tr: Tr): { error?: string; hint: string } {
  const t = raw.trim();
  const hint =
    chain === "trc20"
      ? tr("64 位十六进制，不带 0x", "64 hex characters, no 0x")
      : EVM.has(chain)
        ? tr("0x + 64 位十六进制", "0x + 64 hex characters")
        : chain === "solana"
          ? tr("Base58 交易签名（约 88 位）", "Base58 signature (about 88 characters)")
          : tr("交易哈希（hex 或 base64）", "Transaction hash (hex or base64)");
  if (!t) return { error: tr("请粘贴链上交易哈希", "Paste the transaction hash"), hint };
  if (!TXID_RE.test(t))
    return {
      error: tr("格式不对：8–128 位字母、数字或 + / = - _，不含空格", "8–128 letters, digits or + / = - _, no spaces"),
      hint,
    };
  if (chain === "trc20" && !/^[0-9a-fA-F]{64}$/.test(t))
    return { error: tr(`TRC20 交易哈希应为 ${hint}`, `A TRC20 hash is ${hint}`), hint };
  if (EVM.has(chain) && !/^0x[0-9a-fA-F]{64}$/.test(t))
    return {
      error: tr(`${CHAINS[chain].label} 交易哈希应为 ${hint}`, `A ${CHAINS[chain].label} hash is ${hint}`),
      hint,
    };
  return { hint };
}

/* ---------- status ---------- */

type WStatusLabel = { zh: string; en: string; tone: Tone; icon: typeof Clock };
const W_STATUS: Record<string, WStatusLabel> = {
  pending: { zh: "待审核", en: "Pending", tone: "warning", icon: Clock },
  approved: { zh: "已打款", en: "Paid", tone: "success", icon: Check },
  rejected: { zh: "已拒绝", en: "Rejected", tone: "neutral", icon: Undo2 },
  cancelled: { zh: "用户撤销", en: "Cancelled", tone: "neutral", icon: X },
};
const W_UNKNOWN: WStatusLabel = { zh: "未知状态", en: "Unknown", tone: "neutral", icon: Clock };

function WithdrawalBadge({ status }: { status: string }) {
  const tr = useTr();
  const { zh, en, tone, icon: Icon } = W_STATUS[status] ?? W_UNKNOWN;
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {tr(zh, en)}
    </Badge>
  );
}

type WStatus = "pending" | "approved" | "rejected" | "cancelled" | "all";
const W_STATUSES: WStatus[] = ["pending", "approved", "rejected", "cancelled", "all"];
const STEP = 50;

const who = (w: Withdrawal) => w.user_email ?? w.user_label;
const usdtRef = (cents: number, rate: number | null | undefined) => (rate ? (cents / rate).toFixed(2) : null);

/* ---------- queue ---------- */

export function WithdrawalsQueue({ summary }: { summary: FinanceSummary | undefined }) {
  const tr = useTr();
  const wide = useMedia("(min-width: 1024px)");
  const [query, patch] = useQS();
  const raw = query.get("status") ?? "pending";
  const status = (W_STATUSES as string[]).includes(raw) ? (raw as WStatus) : "pending";
  const [email, text, setText] = useSearchParam("email");
  const [limit, setLimit] = useState(STEP);
  // The pending queue is read whole (oldest first; it is short) up to the cap.
  const asked = status === "pending" ? SERVER_MAX : limit;
  const q = useQuery({
    queryKey: ["withdrawals", status, email, asked],
    queryFn: () =>
      get<Withdrawal[]>(`/withdrawals${qs({ status: status === "all" ? "" : status, email, limit: asked })}`),
    placeholderData: keepPreviousData,
  });
  const settings = useCommissionSettings();
  const rate = settings.data?.usdt_rate_cents ?? null;
  const rows = status === "pending" ? [...(q.data ?? [])].reverse() : (q.data ?? []);
  const openId = query.get("open") ?? (wide ? (rows[0]?.id ?? null) : null);
  const cur = rows.find((w) => w.id === openId) ?? null;
  const s = summary?.withdrawals;
  const total = email
    ? null
    : s
      ? status === "all"
        ? s.pending + s.approved + s.rejected + s.cancelled
        : s[status]
      : null;
  const pick = (id: string | null) => patch({ open: id }, true);
  const next = (doneId: string) => {
    const i = rows.findIndex((w) => w.id === doneId);
    const after =
      rows.slice(i + 1).find((w) => w.status === "pending") ??
      rows.find((w) => w.status === "pending" && w.id !== doneId);
    pick(wide && after ? after.id : null);
  };
  const clear = () => {
    setText("");
    patch({ email: null, open: null, status: null });
  };

  const footer = (() => {
    if (rows.length === 0) return null;
    if (rows.length >= SERVER_MAX)
      return (
        <span className="text-warning">
          {tr(
            `已加载服务端上限 ${SERVER_MAX} 条。更早的记录请用邮箱或状态缩小范围。`,
            `Loaded the server's limit of ${SERVER_MAX}. Narrow by email or status for older ones.`,
          )}
        </span>
      );
    if (rows.length < asked)
      return <span className="tnum">{tr(`已全部加载 · ${rows.length} 条`, `All ${rows.length} loaded`)}</span>;
    return (
      <Button
        size="sm"
        variant="ghost"
        loading={q.isFetching}
        onClick={() => setLimit((l) => Math.min(SERVER_MAX, l + STEP))}
      >
        {total !== null
          ? tr(`加载更多（已加载 ${rows.length} / ${total}）`, `Load more (${rows.length} of ${total})`)
          : tr(`加载更多（已加载 ${rows.length}）`, `Load more (${rows.length} loaded)`)}
      </Button>
    );
  })();

  const body = q.isPending ? (
    <SkeletonRows rows={8} height={60} />
  ) : q.isError && !q.data ? (
    <ErrorState
      error={q.error}
      title={tr("提现记录加载失败", "Could not load withdrawals")}
      onRetry={() => void q.refetch()}
    />
  ) : rows.length === 0 ? (
    email ? (
      <EmptyState
        icon={SearchX}
        title={tr("没有匹配的提现", "No withdrawals match")}
        description={tr(
          `没有邮箱为「${email}」的用户的提现（完整邮箱匹配）。`,
          `No withdrawal by “${email}” (whole address).`,
        )}
        action={
          <Button variant="outline" icon={X} onClick={clear}>
            {tr("清除筛选", "Clear filters")}
          </Button>
        }
      />
    ) : status === "pending" ? (
      <EmptyState
        icon={CheckCheck}
        title={tr("没有待审提现", "Nothing to review")}
        description={tr(
          "新的提现申请会出现在这里，侧栏和仪表盘会显示数量。",
          "New requests appear here; the sidebar and the dashboard show the count.",
        )}
        action={
          <Button variant="outline" onClick={() => patch({ status: "approved", open: null })}>
            {tr("查看已打款", "Show paid")}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={Inbox}
        title={tr("没有这种状态的提现", "No withdrawals in this state")}
        description={tr(
          "用户在门户把可提现余额提现到 USDT 地址后，会出现在这里。",
          "Requests appear when users withdraw to a USDT address in the portal.",
        )}
        action={
          status !== "all" ? (
            <Button variant="outline" onClick={() => patch({ status: "all", open: null })}>
              {tr("查看全部", "Show all")}
            </Button>
          ) : undefined
        }
      />
    )
  ) : (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ul className="divide-y divide-separator" aria-label={tr("提现", "Withdrawals")}>
        {rows.map((w) => (
          <QueueRow
            key={w.id}
            w={w}
            rate={rate}
            selected={wide && w.id === openId}
            chevron={!wide}
            onOpen={() => pick(w.id)}
          />
        ))}
      </ul>
      <div className="border-t border-separator px-3 py-2.5 text-center text-footnote text-muted-foreground">
        {footer}
      </div>
    </div>
  );

  const list = (
    <Card
      className={cn(
        "flex min-w-0 flex-col overflow-hidden",
        wide && rows.length > 0 && "lg:h-[calc(100dvh-300px)] lg:min-h-[520px]",
      )}
    >
      <div className="grid gap-2 border-b border-separator p-3">
        <Segmented
          size="sm"
          label={tr("提现状态", "Withdrawal status")}
          value={status}
          onChange={(v) => {
            setLimit(STEP);
            patch({ status: v === "pending" ? null : v, open: null });
          }}
          options={[
            { value: "pending", label: tr("待审核", "Pending"), count: s?.pending || undefined },
            { value: "approved", label: tr("已打款", "Paid") },
            { value: "rejected", label: tr("已拒绝", "Rejected") },
            { value: "cancelled", label: tr("用户撤销", "Cancelled") },
            { value: "all", label: tr("全部", "All") },
          ]}
        />
        <SearchField
          value={text}
          onChange={setText}
          label={tr("按用户邮箱筛选", "Filter by user email")}
          placeholder={tr("按用户邮箱筛选（完整邮箱）", "Filter by user email (whole address)")}
        />
      </div>
      {body}
    </Card>
  );

  if (!wide)
    return (
      <>
        {list}
        <Dialog
          open={!!cur}
          onClose={() => pick(null)}
          size="lg"
          icon={Clock}
          title={cur ? `${yuan(cur.amount_cents)} · ${CHAINS[cur.chain]?.label ?? cur.chain}` : ""}
          description={cur ? who(cur) : undefined}
        >
          {cur && <Review key={cur.id} w={cur} rate={rate} bare onDone={() => next(cur.id)} />}
        </Dialog>
      </>
    );
  if (rows.length === 0 || (q.isError && !q.data) || q.isPending) return list;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
      {list}
      <div className="min-w-0">
        {cur ? (
          <Review key={cur.id} w={cur} rate={rate} onDone={() => next(cur.id)} />
        ) : (
          <Card className="grid h-full min-h-80 place-items-center">
            <EmptyState
              icon={Inbox}
              title={tr("选择一笔提现", "Pick a withdrawal")}
              description={tr("在左侧选择后在这里审核。", "Pick one on the left to review it here.")}
            />
          </Card>
        )}
      </div>
    </div>
  );
}

function QueueRow({
  w,
  rate,
  selected,
  chevron,
  onOpen,
}: {
  w: Withdrawal;
  rate: number | null;
  selected: boolean;
  chevron: boolean;
  onOpen: () => void;
}) {
  const tr = useTr();
  const wait = waited(w.created_at, tr);
  const ref = usdtRef(w.amount_cents, rate);
  return (
    <li data-row>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected || undefined}
        className={cn(
          "flex min-h-14 w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-accent",
          selected && "bg-primary-soft/70 hover:bg-primary-soft",
        )}
      >
        <Avatar name={who(w)} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium">{who(w)}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-footnote text-muted-foreground">
            <ChainBadge chain={w.chain} />
            {w.status === "pending" ? (
              <span className={cn("tnum truncate", wait.long && "font-medium text-warning")}>
                {tr(`等待 ${wait.text}`, `waiting ${wait.text}`)}
              </span>
            ) : w.status === "approved" && w.txid ? (
              <span className="truncate font-mono" title={w.txid}>
                {w.txid.slice(0, 8)}…{w.txid.slice(-6)}
              </span>
            ) : (
              <span className="truncate">{w.note ?? tr("用户撤销", "Cancelled by the user")}</span>
            )}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className="tnum text-body font-semibold">{yuan(w.amount_cents)}</span>
          {w.usdt_amount ? (
            <span className="tnum text-footnote text-faint">{w.usdt_amount.replace(/\.?0+$/, "")} USDT</span>
          ) : (
            ref && <span className="tnum text-footnote text-faint">≈ {ref} USDT</span>
          )}
        </span>
        {chevron && <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden="true" />}
      </button>
    </li>
  );
}

/* ---------- review panel ---------- */

type UserBrief = {
  id: string;
  enabled: boolean;
  disabled_reason: string | null;
  erased: boolean;
  created_at: string;
  ban?: { reason: string; banned_at: string } | null;
};
type BalanceBrief = { balance_cents: number; withdrawable_cents: number };

const REASONS: [string, string][] = [
  ["地址与链不匹配", "The address does not match the network"],
  ["地址无效或是合约地址", "Invalid or contract address"],
  ["账户存在风险，暂不处理", "Account under review"],
  ["其他", "Other"],
];

function Labelled({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-footnote font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Review({ w, rate, bare, onDone }: { w: Withdrawal; rate: number | null; bare?: boolean; onDone: () => void }) {
  const tr = useTr();
  const uid = w.user_id;
  const user = useQuery({
    queryKey: ["user", uid],
    queryFn: () => get<UserBrief>(`/users/${uid}`),
    enabled: !!uid,
  });
  const bal = useQuery({
    queryKey: ["balance", uid, "summary"],
    queryFn: () => get<BalanceBrief>(`/users/${uid}/balance?limit=1`),
    enabled: !!uid,
  });
  const prevQ = useQuery({
    queryKey: ["withdrawals", "of", w.user_email],
    queryFn: () => get<Withdrawal[]>(`/withdrawals${qs({ email: w.user_email, limit: 6 })}`),
    enabled: !!w.user_email,
  });
  const prev = (prevQ.data ?? []).filter((x) => x.id !== w.id).slice(0, 4);
  const ref = usdtRef(w.amount_cents, rate);
  const banned = !!user.data && !user.data.enabled && user.data.disabled_reason === "admin" && !user.data.erased;
  const wait = waited(w.created_at, tr);
  const [rejecting, setRejecting] = useState(false);
  const Shell = bare ? "div" : Card;

  return (
    <Shell className={cn("overflow-hidden", bare && "-mx-5 -my-4")}>
      <div className="flex flex-wrap items-start gap-3 border-b border-separator px-4 py-3.5 max-lg:hidden">
        <Avatar name={who(w)} size={36} />
        <div className="min-w-0 flex-1">
          {uid ? (
            <Link
              to={`/users?open=${uid}&tab=billing`}
              className="block truncate text-headline font-semibold hover:text-primary hover:underline"
            >
              {who(w)}
            </Link>
          ) : (
            <span className="block truncate text-headline font-semibold">{who(w)}</span>
          )}
          <div className="tnum text-footnote text-muted-foreground">
            #{w.id.slice(0, 8)} · {tr(`申请于 ${dateTime(w.created_at)}`, `requested ${dateTime(w.created_at)}`)}
            {w.status === "pending" && <> · {tr(`已等待 ${wait.text}`, `waiting ${wait.text}`)}</>}
          </div>
        </div>
        <WithdrawalBadge status={w.status} />
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_240px]">
        <div className="grid min-w-0 content-start gap-4">
          {bare && (
            <div className="flex flex-wrap items-center gap-2 text-footnote text-muted-foreground">
              <WithdrawalBadge status={w.status} />
              <span className="tnum">
                {tr(`申请于 ${dateTime(w.created_at)}`, `requested ${dateTime(w.created_at)}`)}
              </span>
              {uid && (
                <Link to={`/users?open=${uid}&tab=billing`} className="text-primary hover:underline">
                  {tr("用户详情", "User details")}
                </Link>
              )}
            </div>
          )}
          {banned && w.status === "pending" && (
            <Banner tone="danger" icon={<Ban />} title={tr("该用户已被封禁", "This user is banned")}>
              {user.data?.ban?.reason ? `${user.data.ban.reason}${tr("。", ". ")}` : ""}
              {tr("通常应拒绝并退回，或先在用户详情里核实。", "Usually reject it, or check the user's details first.")}
            </Banner>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-window px-4 py-3 ring-1 ring-border ring-inset">
            <div>
              <div className="text-footnote text-muted-foreground">{tr("申请金额", "Amount")}</div>
              <div className="tnum text-title2 font-semibold tracking-[-0.02em]">{yuan(w.amount_cents)}</div>
            </div>
            {ref && (
              <>
                <ArrowRight className="size-4 text-faint" aria-hidden="true" />
                <div>
                  <div className="text-footnote text-muted-foreground">
                    {tr(`参考 USDT（汇率 ${yuan(rate)}）`, `USDT reference (rate ${yuan(rate)})`)}
                  </div>
                  <div className="tnum text-title2 font-semibold tracking-[-0.02em] text-primary">{ref}</div>
                </div>
              </>
            )}
            <div className="ml-auto text-right">
              <ChainBadge chain={w.chain} />
              <div className="mt-0.5 text-footnote text-faint">{CHAINS[w.chain]?.name ?? w.chain}</div>
            </div>
          </div>

          <div className="grid gap-2">
            <Labelled label={tr("收款地址", "Address")}>
              <CopyText block value={w.address} label={tr("收款地址", "address")} />
            </Labelled>
            {w.memo && (
              <Labelled label={tr("Memo / 标签（必须一起填写）", "Memo / tag (must be filled in too)")}>
                <CopyText block value={w.memo} label="Memo" />
              </Labelled>
            )}
          </div>

          {w.status === "pending" &&
            (rejecting ? (
              <RejectPanel w={w} balance={bal.data?.balance_cents} onBack={() => setRejecting(false)} onDone={onDone} />
            ) : (
              <ApproveForm w={w} reference={ref} onReject={() => setRejecting(true)} onDone={onDone} />
            ))}

          {w.status === "approved" && (
            <dl className="grid gap-3 rounded-xl p-3 ring-1 ring-border ring-inset">
              <div>
                <dt className="text-footnote text-muted-foreground">{tr("实付", "Paid")}</dt>
                <dd className="tnum text-headline font-semibold">{w.usdt_amount ?? "—"} USDT</dd>
              </div>
              {w.txid && (
                <div>
                  <dt className="text-footnote text-muted-foreground">
                    {tr("交易哈希（完整，可复制）", "Transaction hash")}
                  </dt>
                  <dd>
                    <CopyText block value={w.txid} label={tr("哈希", "hash")} />
                  </dd>
                </div>
              )}
              {w.note && (
                <div className="text-body">
                  <span className="text-muted-foreground">{tr("备注 ", "Note ")}</span>
                  {w.note}
                </div>
              )}
              <div className="text-footnote text-faint">
                {w.decided_by ?? "—"} · {dateTime(w.decided_at)}
              </div>
            </dl>
          )}
          {(w.status === "rejected" || w.status === "cancelled") && (
            <div className="rounded-xl p-3 ring-1 ring-border ring-inset">
              <div className="text-footnote text-muted-foreground">
                {w.status === "rejected" ? tr("拒绝原因", "Reason") : tr("用户已撤销", "Cancelled by the user")}
              </div>
              {w.note && <div className="text-body font-medium">{w.note}</div>}
              <div className="mt-1 text-footnote text-faint">
                {tr("已退回余额", "Returned to the balance")}
                {w.decided_by && ` · ${w.decided_by}`} · {dateTime(w.decided_at)}
              </div>
            </div>
          )}
        </div>

        <aside className="grid content-start gap-3">
          <div className="rounded-xl bg-window p-3 ring-1 ring-border ring-inset">
            <div className="mb-2 text-footnote font-semibold text-muted-foreground">{tr("用户", "User")}</div>
            {uid ? (
              <dl className="grid gap-1.5 text-body">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{tr("当前余额", "Balance")}</dt>
                  <dd className="tnum font-medium">{bal.data ? yuan(bal.data.balance_cents) : "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{tr("可提现", "Withdrawable")}</dt>
                  <dd className="tnum font-medium">{bal.data ? yuan(bal.data.withdrawable_cents) : "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{tr("注册", "Joined")}</dt>
                  <dd className="tnum">{user.data ? dateOnly(user.data.created_at) : "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{tr("状态", "Status")}</dt>
                  <dd>
                    {!user.data ? (
                      "—"
                    ) : user.data.erased ? (
                      <Badge tone="outline">{tr("已注销", "Erased")}</Badge>
                    ) : banned ? (
                      <Badge tone="danger">{tr("已封禁", "Banned")}</Badge>
                    ) : (
                      tr("正常", "Active")
                    )}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-footnote text-faint">{tr("账户已删除。", "The account is gone.")}</p>
            )}
            {uid && (
              <Link
                to={`/users?open=${uid}&tab=billing`}
                className="mt-2 inline-block text-footnote text-primary hover:underline"
              >
                {tr("余额明细 →", "Balance history →")}
              </Link>
            )}
          </div>
          {w.user_email && (
            <div>
              <div className="mb-1.5 px-1 text-footnote font-semibold text-muted-foreground">
                {tr("此前的提现", "Earlier withdrawals")}
              </div>
              {prevQ.isPending ? (
                <SkeletonRows rows={2} height={36} avatar={false} />
              ) : prev.length ? (
                <ul className="divide-y divide-separator rounded-xl ring-1 ring-border ring-inset">
                  {prev.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 text-footnote">
                      <span className="tnum text-muted-foreground">{dateOnly(p.created_at).slice(5)}</span>
                      <span className="tnum font-medium">{yuan(p.amount_cents)}</span>
                      <WithdrawalBadge status={p.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-1 text-footnote text-warning">
                  {tr(
                    "这是该用户第一次提现 — 请仔细核对地址。",
                    "The user's first withdrawal — check the address carefully.",
                  )}
                </p>
              )}
            </div>
          )}
        </aside>
      </div>
    </Shell>
  );
}

function ApproveForm({
  w,
  reference,
  onReject,
  onDone,
}: {
  w: Withdrawal;
  reference: string | null;
  onReject: () => void;
  onDone: () => void;
}) {
  const tr = useTr();
  const [paid, setPaid] = useState(reference ?? "");
  const [tx, setTx] = useState("");
  const [note, setNote] = useState("");
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const on = (k: string) => tried || shown.has(k);
  const blur = (k: string) => () => setShown((s) => new Set(s).add(k));
  const paidErr =
    !USDT_RE.test(paid.trim()) || Number(paid) <= 0
      ? tr("请输入实际打款的 USDT 数量（大于 0，最多 6 位小数）", "Enter the USDT sent (above 0, at most 6 decimals)")
      : undefined;
  const ref = reference ? Number(reference) : null;
  const paidWarn =
    !paidErr && ref && Math.abs(Number(paid) - ref) > ref * 0.05
      ? tr(
          `与参考金额 ${reference} USDT 相差超过 5%，请核对`,
          `More than 5% off the reference ${reference} USDT; check it`,
        )
      : undefined;
  const hash = hashCheck(w.chain, tx, tr);
  const errs = [on("paid") ? paidErr : undefined, on("tx") ? hash.error : undefined].filter(Boolean).length;
  const submit = async () => {
    setTried(true);
    if (paidErr || hash.error) return;
    const r = await run(
      () =>
        post(`/withdrawals/${w.id}/approve`, {
          usdt_amount: paid.trim(),
          txid: tx.trim(),
          note: note.trim() || undefined,
        }),
      { ok: tr("已标记为已打款", "Marked paid") },
    );
    if (r !== undefined) onDone();
  };
  return (
    <form
      className="grid gap-3 rounded-xl p-3 ring-1 ring-border ring-inset"
      aria-label={tr("确认已打款", "Confirm paid")}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="text-body font-semibold">{tr("确认已打款", "Confirm paid")}</div>
      <p className="text-footnote text-muted-foreground">
        {tr(
          "先在交易所或钱包向上面的地址打款，再回填实付 USDT 与交易哈希。",
          "Pay to the address above from your exchange or wallet first, then record the USDT sent and the hash.",
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
        <Field label={tr("实付 USDT", "USDT paid")} required error={on("paid") ? paidErr : undefined}>
          <Input
            value={paid}
            onChange={(e) => setPaid(e.target.value)}
            onBlur={blur("paid")}
            inputMode="decimal"
            className="tnum"
          />
        </Field>
        <Field
          label={tr("交易哈希", "Transaction hash")}
          required
          error={on("tx") ? hash.error : undefined}
          hint={hash.hint}
        >
          <Input
            value={tx}
            onChange={(e) => setTx(e.target.value)}
            onBlur={blur("tx")}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            data-autofocus
          />
        </Field>
      </div>
      {paidWarn && <p className="text-footnote text-warning">{paidWarn}</p>}
      <Field label={tr("备注（可选，用户可见）", "Note (optional, shown to the user)")}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" className="text-destructive" icon={Ban} onClick={onReject}>
          {tr("拒绝…", "Reject…")}
        </Button>
        <div className="flex-1" />
        <FixCount n={errs} />
        <Button type="submit" variant="primary" icon={Check} loading={busy}>
          {tr("确认已打款", "Confirm paid")}
        </Button>
      </div>
    </form>
  );
}

function RejectPanel({
  w,
  balance,
  onBack,
  onDone,
}: {
  w: Withdrawal;
  balance: number | undefined;
  onBack: () => void;
  onDone: () => void;
}) {
  const tr = useTr();
  const [reason, setReason] = useState(0);
  const [extra, setExtra] = useState("");
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const other = reason === REASONS.length - 1;
  const err = other && !extra.trim() ? tr("选了「其他」，请写说明", "“Other” needs a note") : undefined;
  const text = other
    ? extra.trim()
    : `${tr(...REASONS[reason])}${extra.trim() ? `${tr("：", ": ")}${extra.trim()}` : ""}`;
  const submit = async () => {
    setTried(true);
    if (err) return;
    const r = await run(() => post(`/withdrawals/${w.id}/reject`, { reason: text.slice(0, 200) }), {
      ok: tr("已拒绝，金额退回余额", "Rejected; the amount is back in the balance"),
    });
    if (r !== undefined) onDone();
  };
  return (
    <div
      role="group"
      aria-label={tr("拒绝这笔提现", "Reject this withdrawal")}
      className="grid gap-3 rounded-xl bg-destructive-soft/40 p-3 ring-1 ring-destructive/30 ring-inset"
    >
      <div className="text-body font-semibold text-destructive">{tr("拒绝这笔提现", "Reject this withdrawal")}</div>
      <Field label={tr("原因（用户可见）", "Reason (shown to the user)")} required>
        <Select value={reason} onChange={(e) => setReason(Number(e.target.value))}>
          {REASONS.map((r, i) => (
            <option key={i} value={i}>
              {tr(...r)}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={other ? tr("说明（必填）", "Note (required)") : tr("补充说明（可选）", "More detail (optional)")}
        error={tried || extra ? err : undefined}
      >
        <Textarea value={extra} onChange={(e) => setExtra(e.target.value)} maxLength={160} className="min-h-16" />
      </Field>
      <p className="text-footnote text-muted-foreground">
        <span className="tnum font-medium text-foreground">{yuan(w.amount_cents)}</span>
        {balance !== undefined
          ? tr(
              ` 将退回该用户的余额（${yuan(balance)} → ${yuan(balance + w.amount_cents)}）。`,
              ` goes back to the user's balance (${yuan(balance)} → ${yuan(balance + w.amount_cents)}).`,
            )
          : tr(" 将退回该用户的余额。", " goes back to the user's balance.")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          {tr("返回", "Back")}
        </Button>
        <div className="flex-1" />
        <FixCount n={tried && err ? 1 : 0} />
        <Button variant="destructive" loading={busy} onClick={() => void submit()}>
          {tr("拒绝并退回", "Reject and return")}
        </Button>
      </div>
    </div>
  );
}
