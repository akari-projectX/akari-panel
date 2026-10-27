// 资金 (FIN-*; proposal-v2 §2, prototype pages/finance.tsx): a money desk.
// Header stat strip (pending withdrawals, balances, this month's
// commissions; each cell opens its sub-page) + page tabs: 提现审核 (the
// review queue, components/people-finance.tsx), 余额 (find anyone, last
// movement, ledger dialog with manual adjustment), 返利 (a day-grouped
// ledger). Routes /finance/withdrawals (default), /finance/balances,
// /finance/commissions.
// The list endpoints take only a `limit` (≤ 500, no cursor): lists grow by
// "load more" up to the cap and say so when they reach it.
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, Coins, Gift, HandCoins, SearchX, Settings2, Wallet, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { get, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateOnly, dateTime, siteToday, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Dialog } from "../../shared/ui/dialog";
import { Segmented } from "../../shared/ui/form";
import { Banner, PageHeader } from "../../shared/ui/layout";
import { EmptyState, ErrorState, SkeletonRows } from "../../shared/ui/states";
import { Avatar, PageTabs, SearchField, StatStrip } from "../components/kit";
import {
  SERVER_MAX,
  WithdrawalsQueue,
  shortTime,
  useCommissionSettings,
  useFinanceSummary,
  useMedia,
  useSearchParam,
  waited,
} from "../components/people-finance";
import { WEEKDAYS } from "../components/ops-bits";
import { navigate, useQS, useRoute } from "../router";
import { AdjustBalanceDialog } from "./user-detail";

const SUBS = ["withdrawals", "balances", "commissions"] as const;
type Sub = (typeof SUBS)[number];
const STEP = 50;

export function FinancePage() {
  const tr = useTr();
  const { sub, query } = useRoute();
  const search = query.toString();
  const tab = (SUBS as readonly string[]).includes(sub[0] ?? "") ? (sub[0] as Sub) : null;
  // /finance → /finance/withdrawals (keeping the query).
  useEffect(() => {
    if (!tab) navigate(`/finance/withdrawals${search ? `?${search}` : ""}`, true);
  }, [tab, search]);
  const summary = useFinanceSummary();
  const s = summary.data;
  const pending = s?.withdrawals.pending ?? 0;
  const oldest = s?.withdrawals.oldest_pending_at;
  return (
    <>
      <PageHeader
        title={tr("资金", "Finance")}
        description={tr("提现审核、用户余额与邀请返利", "Withdrawals, balances and invite commissions")}
        actions={
          <Button variant="ghost" asChild>
            <Link to="/settings/commission">
              <Settings2 aria-hidden="true" />
              {tr("返利规则", "Commission rules")}
            </Link>
          </Button>
        }
      />
      <StatStrip
        className={cn("mb-4", tab === "withdrawals" && "max-sm:hidden")}
        items={[
          {
            label: tr("待审提现", "Withdrawals to review"),
            value: s ? tr(`${pending} 笔`, `${pending}`) : "—",
            foot: s
              ? `${yuan(s.withdrawals.pending_cents)}${
                  oldest ? tr(` · 最久等待 ${waited(oldest, tr).text}`, ` · oldest ${waited(oldest, tr).text}`) : ""
                }`
              : undefined,
            tone: pending ? "warning" : undefined,
            onClick: () => navigate("/finance/withdrawals"),
            active: tab === "withdrawals",
          },
          {
            label: tr("用户余额合计", "Balances in total"),
            value: s ? yuan(s.balances.total_cents) : "—",
            foot: s ? tr(`${s.balances.users} 个用户有余额`, `${s.balances.users} users hold a balance`) : undefined,
            onClick: () => navigate("/finance/balances"),
            active: tab === "balances",
          },
          {
            label: tr("本月返利", "Commissions this month"),
            value: s ? yuan(s.commissions.month_cents) : "—",
            foot: s
              ? tr(`冻结中 ${yuan(s.commissions.pending_cents)}`, `held ${yuan(s.commissions.pending_cents)}`)
              : undefined,
            onClick: () => navigate("/finance/commissions"),
            active: tab === "commissions",
          },
        ]}
      />
      <PageTabs
        segmented
        label={tr("资金", "Finance")}
        items={[
          { to: "/finance/withdrawals", label: tr("提现审核", "Withdrawals"), count: pending || undefined },
          { to: "/finance/balances", label: tr("余额", "Balances") },
          { to: "/finance/commissions", label: tr("返利", "Commissions") },
        ]}
      />
      {tab === "withdrawals" && <WithdrawalsQueue summary={s} />}
      {tab === "balances" && <Balances />}
      {tab === "commissions" && <Commissions />}
    </>
  );
}

/* ---------- 余额 ---------- */

type BalanceRow = {
  user_id: string;
  email: string;
  balance_cents: number;
  updated_at?: string;
  withdrawable_cents?: number;
  last_kind?: string | null;
  last_amount_cents?: number | null;
  last_at?: string | null;
};

function ledgerKind(k: string, tr: Tr): string {
  switch (k) {
    case "commission":
      return tr("邀请返利", "Commission");
    case "admin_adjust":
      return tr("人工调整", "Admin adjustment");
    case "order_payment":
      return tr("购买扣款", "Order payment");
    case "refund_to_balance":
      return tr("退款到余额", "Refund to balance");
    case "withdrawal":
      return tr("提现", "Withdrawal");
    case "withdrawal_reversal":
      return tr("提现退回", "Withdrawal returned");
    case "commission_clawback":
      return tr("返利追回", "Commission clawback");
    default:
      return tr("其他", "Other");
  }
}

function Signed({ cents, className }: { cents: number; className?: string }) {
  return (
    <span className={cn("tnum", cents > 0 && "text-success", className)}>
      {cents > 0 ? "+" : "−"}
      {yuan(Math.abs(cents))}
    </span>
  );
}

function Balances() {
  const tr = useTr();
  const wide = useMedia("(min-width: 640px)");
  const [query, patch] = useQS();
  const [email, text, setText] = useSearchParam("q");
  const [limit, setLimit] = useState(STEP);
  const q = useQuery({
    queryKey: ["balances", email, limit],
    queryFn: () => get<BalanceRow[]>(`/balances${qs({ email, limit })}`),
    placeholderData: keepPreviousData,
  });
  const rows = q.data ?? [];
  const openId = query.get("open");
  const open = rows.find((r) => r.user_id === openId);
  const clear = () => {
    setText("");
    patch({ q: null, open: null });
  };
  return (
    <>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-separator p-3">
          <SearchField
            value={text}
            onChange={setText}
            label={tr("按邮箱查找任意用户", "Find anyone by email")}
            placeholder={tr(
              "按邮箱查找任意用户（完整邮箱，包括余额为 0 的）",
              "Find anyone by email (whole address, any balance)",
            )}
            className="flex-1 basis-64"
          />
          {!q.isPending && !q.isError && (
            <span className="tnum text-footnote text-muted-foreground">
              {email
                ? tr(`匹配 ${rows.length} 个`, `${rows.length} match`)
                : tr(`${rows.length} 个用户有余额`, `${rows.length} users hold a balance`)}
            </span>
          )}
        </div>
        {q.isPending ? (
          <SkeletonRows rows={8} height={52} />
        ) : q.isError && !q.data ? (
          <ErrorState
            error={q.error}
            title={tr("余额列表加载失败", "Could not load balances")}
            onRetry={() => void q.refetch()}
          />
        ) : rows.length === 0 ? (
          email ? (
            <EmptyState
              icon={SearchX}
              title={tr("没有找到这个邮箱", "No such address")}
              description={tr(
                `没有邮箱为「${email}」的账户（完整邮箱匹配）。确认拼写；已注销的账户不会出现在这里。`,
                `No account with “${email}” (whole address). Check the spelling; erased accounts are not listed.`,
              )}
              action={
                <Button variant="outline" icon={X} onClick={clear}>
                  {tr("清除", "Clear")}
                </Button>
              }
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
        ) : (
          <>
            {wide && (
              <div className="grid h-8 grid-cols-[minmax(0,1fr)_110px_110px_minmax(0,220px)_64px] items-center gap-3 border-b border-separator px-4 text-footnote font-medium text-muted-foreground">
                <span>{tr("用户", "User")}</span>
                <span className="text-right">{tr("余额 ↓", "Balance ↓")}</span>
                <span className="text-right">{tr("其中可提现", "Withdrawable")}</span>
                <span className="pl-3">{tr("最近一笔", "Last movement")}</span>
                <span />
              </div>
            )}
            <ul className="divide-y divide-separator" aria-label={tr("余额", "Balances")}>
              {rows.map((b) => (
                <li key={b.user_id} data-row>
                  <button
                    type="button"
                    onClick={() => patch({ open: b.user_id })}
                    className={cn(
                      "w-full text-left transition-colors hover:bg-accent",
                      wide
                        ? "grid min-h-12 grid-cols-[minmax(0,1fr)_110px_110px_minmax(0,220px)_64px] items-center gap-3 px-4 py-1.5"
                        : "flex min-h-14 items-center gap-3 px-4 py-2.5",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={b.email} size={28} />
                      <span className="min-w-0">
                        <span className="block truncate text-body font-medium">{b.email}</span>
                        {!wide && b.withdrawable_cents !== undefined && (
                          <span className="tnum block text-footnote text-muted-foreground">
                            {tr(`可提现 ${yuan(b.withdrawable_cents)}`, `withdrawable ${yuan(b.withdrawable_cents)}`)}
                          </span>
                        )}
                      </span>
                    </span>
                    {wide ? (
                      <>
                        <span className="tnum text-right text-body font-semibold">{yuan(b.balance_cents)}</span>
                        <span className="tnum text-right text-body text-muted-foreground">
                          {b.withdrawable_cents ? yuan(b.withdrawable_cents) : "—"}
                        </span>
                        <span className="truncate pl-3 text-body text-muted-foreground">
                          {b.last_kind && b.last_amount_cents !== null && b.last_amount_cents !== undefined ? (
                            <>
                              {ledgerKind(b.last_kind, tr)} <Signed cents={b.last_amount_cents} />
                              <span className="tnum text-footnote text-faint"> · {dateOnly(b.last_at).slice(5)}</span>
                            </>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </span>
                        <span className="text-right text-footnote text-primary">{tr("明细 →", "Ledger →")}</span>
                      </>
                    ) : (
                      <>
                        <span className="ml-auto tnum text-body font-semibold">{yuan(b.balance_cents)}</span>
                        <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden="true" />
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <GrowFooter
              count={rows.length}
              limit={limit}
              fetching={q.isFetching}
              onMore={() => setLimit((l) => Math.min(SERVER_MAX, l + STEP))}
            />
          </>
        )}
      </Card>
      {openId && <LedgerDialog id={openId} email={open?.email} onClose={() => patch({ open: null })} />}
    </>
  );
}

/** "All N loaded", or load more, or the server cap reached. */
function GrowFooter({
  count,
  limit,
  fetching,
  onMore,
  unit,
}: {
  count: number;
  limit: number;
  fetching: boolean;
  onMore: () => void;
  unit?: [string, string];
}) {
  const tr = useTr();
  const [zh, en] = unit ?? ["条", ""];
  return (
    <div className="border-t border-separator px-3 py-2 text-center text-footnote text-muted-foreground">
      {count < limit ? (
        <span className="tnum">{tr(`已全部加载 · ${count} ${zh}`, `All ${count}${en} loaded`)}</span>
      ) : count >= SERVER_MAX ? (
        <span className="text-warning">
          {tr(
            `已加载服务端上限 ${SERVER_MAX} 条。更早的记录请用邮箱或状态缩小范围。`,
            `Loaded the server's limit of ${SERVER_MAX}. Narrow by email or status for older ones.`,
          )}
        </span>
      ) : (
        <Button size="sm" variant="ghost" loading={fetching} onClick={onMore}>
          {tr(`加载更多（已加载 ${count}）`, `Load more (${count} loaded)`)}
        </Button>
      )}
    </div>
  );
}

type Entry = {
  id: number;
  kind: string;
  amount_cents: number;
  balance_after_cents: number;
  out_trade_no: string | null;
  reason: string | null;
  actor_label?: string | null;
  created_at: string;
};
type Ledger = { email: string; balance_cents: number; withdrawable_cents: number; entries: Entry[] };
const PAGE = 20;

function LedgerDialog({ id, email, onClose }: { id: string; email?: string; onClose: () => void }) {
  const tr = useTr();
  const [adjust, setAdjust] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["balance", id, "ledger"],
    queryFn: ({ pageParam }) => get<Ledger>(`/users/${id}/balance${qs({ limit: PAGE, before: pageParam })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.entries.length === PAGE ? last.entries[last.entries.length - 1].id : undefined),
  });
  const head = q.data?.pages[0];
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const who = head?.email ?? email ?? "";
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        size="md"
        icon={Wallet}
        title={tr("余额明细", "Balance history")}
        description={who || undefined}
        footer={
          <>
            <Button variant="ghost" asChild>
              <Link to={`/users?open=${id}&tab=billing`}>
                {tr("用户详情", "User details")}
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </Button>
            <div className="flex-1" />
            <Button variant="primary" icon={Coins} disabled={!head} onClick={() => setAdjust(true)}>
              {tr("人工调整", "Adjust")}
            </Button>
          </>
        }
      >
        {q.isPending ? (
          <SkeletonRows rows={5} height={48} avatar={false} />
        ) : q.isError && !q.data ? (
          <ErrorState
            compact
            error={q.error}
            title={tr("明细加载失败", "Could not load the history")}
            onRetry={() => void q.refetch()}
          />
        ) : (
          <>
            <div className="mb-3 flex gap-6">
              <div>
                <div className="text-footnote text-muted-foreground">{tr("当前余额", "Balance")}</div>
                <div className="tnum text-title2 font-semibold">{yuan(head?.balance_cents)}</div>
              </div>
              <div>
                <div className="text-footnote text-muted-foreground">{tr("其中可提现", "Withdrawable")}</div>
                <div className="tnum text-title2 font-semibold text-muted-foreground">
                  {yuan(head?.withdrawable_cents)}
                </div>
              </div>
            </div>
            {entries.length === 0 ? (
              <p className="py-6 text-center text-body text-muted-foreground">
                {tr("还没有余额变动。", "No movements yet.")}
              </p>
            ) : (
              <ul className="-mx-5 divide-y divide-separator border-y border-separator">
                {entries.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-body font-medium">
                        {ledgerKind(r.kind, tr)}
                        {r.actor_label && (
                          <span className="text-footnote font-normal text-faint"> · {r.actor_label}</span>
                        )}
                      </div>
                      <div className="truncate text-footnote text-faint">
                        {dateTime(r.created_at)}
                        {r.out_trade_no && ` · ${r.out_trade_no}`}
                        {r.reason && ` · ${r.reason}`}
                      </div>
                    </div>
                    <div className="text-right">
                      <Signed cents={r.amount_cents} className="text-body font-semibold" />
                      <div className="tnum text-caption text-faint">
                        {tr(`余额 ${yuan(r.balance_after_cents)}`, `balance ${yuan(r.balance_after_cents)}`)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="pt-2 text-center">
              {q.hasNextPage ? (
                <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                  {tr("加载更多", "Load more")}
                </Button>
              ) : (
                entries.length > 0 && <span className="text-footnote text-faint">{tr("已全部加载", "All loaded")}</span>
              )}
            </div>
          </>
        )}
      </Dialog>
      {adjust && head && (
        <AdjustBalanceDialog id={id} email={who} balanceCents={head.balance_cents} onClose={() => setAdjust(false)} />
      )}
    </>
  );
}

/* ---------- 返利 ---------- */

type Commission = {
  id: string;
  order_id: string;
  out_trade_no: string;
  inviter_id: string | null;
  inviter_label: string;
  inviter_email: string | null;
  invitee_id: string | null;
  invitee_label: string;
  invitee_email: string | null;
  base_cents: number;
  rate_percent: number;
  amount_cents: number;
  status: string;
  available_at: string;
  reverse_reason: string | null;
  clawback_cents: number | null;
  created_at: string;
};
type CStatus = "" | "pending" | "credited" | "reversed";
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayTitle(day: string, tr: Tr): [string, string] {
  const [y, m, d] = day.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const title = day === siteToday() ? tr("今天", "Today") : tr(`${m} 月 ${d} 日`, `${MONTH_EN[m - 1]} ${d}`);
  return [title, tr(...WEEKDAYS[wd])];
}

function CommissionBadge({ c }: { c: Commission }) {
  const tr = useTr();
  if (c.status === "pending")
    return (
      <Badge tone="warning">
        {tr(`冻结至 ${dateOnly(c.available_at).slice(5)}`, `held until ${dateOnly(c.available_at).slice(5)}`)}
      </Badge>
    );
  if (c.status === "reversed")
    return (
      <Badge tone="neutral" title={c.reverse_reason ?? undefined} className="max-w-56 truncate">
        {tr("已撤销", "Reversed")}
        {c.reverse_reason ? ` · ${c.reverse_reason}` : ""}
      </Badge>
    );
  if (c.status === "credited")
    return (
      <span className="inline-flex flex-wrap justify-end gap-1">
        <Badge tone="success">{tr("已入账", "Credited")}</Badge>
        {c.clawback_cents ? (
          <Badge tone="danger">{tr(`追回 ${yuan(c.clawback_cents)}`, `clawback ${yuan(c.clawback_cents)}`)}</Badge>
        ) : null}
      </span>
    );
  return <Badge>{tr("未知状态", "Unknown")}</Badge>;
}

function Commissions() {
  const tr = useTr();
  const [query, patch] = useQS();
  const raw = query.get("status") ?? "";
  const status = (["pending", "credited", "reversed"].includes(raw) ? raw : "") as CStatus;
  const [email, text, setText] = useSearchParam("email");
  const [limit, setLimit] = useState(STEP);
  const q = useQuery({
    queryKey: ["commissions", status, email, limit],
    queryFn: () => get<Commission[]>(`/commissions${qs({ status, email, limit })}`),
    placeholderData: keepPreviousData,
  });
  const settings = useCommissionSettings();
  const summary = useFinanceSummary().data?.commissions;
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const groups = useMemo(() => {
    const m = new Map<string, Commission[]>();
    for (const r of rows) {
      const d = dateOnly(r.created_at);
      m.set(d, [...(m.get(d) ?? []), r]);
    }
    return [...m.entries()];
  }, [rows]);
  const cs = settings.data;
  const rule = !cs
    ? null
    : !cs.enabled
      ? tr("邀请返利未开启。", "Invite commissions are off.")
      : tr(
          `比例 ${cs.rate_percent}%${cs.first_order_only ? tr(" · 仅首单", " · first order only") : ""} · 冻结 ${cs.hold_days} 天后可提现 · 最低提现 ${yuan(cs.min_withdrawal_cents)}`,
          `${cs.rate_percent}%${cs.first_order_only ? " · first order only" : ""} · held ${cs.hold_days} days · minimum withdrawal ${yuan(cs.min_withdrawal_cents)}`,
        );
  const clear = () => {
    setText("");
    patch({ status: null, email: null });
  };
  return (
    <div className="grid gap-4">
      <Banner
        tone="info"
        icon={<Gift />}
        title={tr("返利规则", "Commission rules")}
        action={
          <Button size="sm" variant="outline" asChild>
            <Link to="/settings/commission">
              {tr("去设置", "Settings")}
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </Button>
        }
      >
        {rule ?? "…"} {tr("规则在 系统设置 → 邀请返利。", "Set in Settings → Invite commissions.")}
      </Banner>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-separator p-3">
          <Segmented
            size="sm"
            label={tr("返利状态", "Commission status")}
            value={status}
            onChange={(v) => {
              setLimit(STEP);
              patch({ status: v || null });
            }}
            options={[
              { value: "", label: tr("全部", "All") },
              { value: "pending", label: tr("冻结中", "Held"), count: summary?.pending },
              { value: "credited", label: tr("已入账", "Credited"), count: summary?.credited },
              { value: "reversed", label: tr("已撤销", "Reversed"), count: summary?.reversed },
            ]}
          />
          <SearchField
            value={text}
            onChange={setText}
            label={tr("邀请人邮箱", "Inviter email")}
            placeholder={tr("邀请人邮箱（完整邮箱）", "Inviter email (whole address)")}
            className="flex-1 basis-56"
          />
        </div>
        {q.isPending ? (
          <SkeletonRows rows={8} height={52} />
        ) : q.isError && !q.data ? (
          <ErrorState
            error={q.error}
            title={tr("返利记录加载失败", "Could not load commissions")}
            onRetry={() => void q.refetch()}
          />
        ) : rows.length === 0 ? (
          status || email ? (
            <EmptyState
              icon={SearchX}
              title={tr("没有匹配的返利", "No commissions match")}
              description={
                email
                  ? tr(
                      `没有邀请人邮箱为「${email}」的返利（完整邮箱匹配）。`,
                      `No commission for the inviter “${email}” (whole address).`,
                    )
                  : tr("当前筛选下没有返利。", "None under these filters.")
              }
              action={
                <Button variant="outline" icon={X} onClick={clear}>
                  {tr("清除筛选", "Clear filters")}
                </Button>
              }
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
        ) : (
          <>
            {groups.map(([day, list]) => {
              const sum = list.filter((c) => c.status !== "reversed").reduce((n, c) => n + c.amount_cents, 0);
              const [title, wd] = dayTitle(day, tr);
              return (
                <section key={day} aria-label={title}>
                  <div className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-separator bg-window/90 px-4 py-1.5 text-footnote backdrop-blur">
                    <span className="font-semibold text-foreground">{title}</span>
                    <span className="text-muted-foreground">{wd}</span>
                    <span className="tnum ml-auto text-muted-foreground">
                      {tr(`${list.length} 笔`, `${list.length}`)} ·{" "}
                      <span className="font-semibold text-foreground">{yuan(sum)}</span>
                    </span>
                  </div>
                  <ul className="divide-y divide-separator">
                    {list.map((c) => (
                      <CommissionRow key={c.id} c={c} />
                    ))}
                  </ul>
                </section>
              );
            })}
            <GrowFooter
              count={rows.length}
              limit={limit}
              fetching={q.isFetching}
              unit={["笔", ""]}
              onMore={() => setLimit((l) => Math.min(SERVER_MAX, l + STEP))}
            />
          </>
        )}
      </Card>
    </div>
  );
}

function CommissionRow({ c }: { c: Commission }) {
  const tr = useTr();
  const inviter = c.inviter_email ?? c.inviter_label;
  return (
    <li data-row className="flex min-h-14 items-center gap-3 px-4 py-2">
      <span className="tnum w-11 shrink-0 text-footnote text-faint">{shortTime(c.created_at).slice(6)}</span>
      <div className="min-w-0 flex-1">
        {c.inviter_id ? (
          <Link
            to={`/users?open=${c.inviter_id}&tab=billing`}
            className="block truncate text-body font-medium hover:text-primary hover:underline"
          >
            {inviter}
          </Link>
        ) : (
          <span className="block truncate text-body font-medium">{inviter}</span>
        )}
        <div className="truncate text-footnote text-muted-foreground">
          {tr("邀请 ", "invited ")}
          {c.invitee_email ?? c.invitee_label} ·{" "}
          <Link to={`/orders?open=${c.order_id}`} className="tnum font-mono hover:text-primary hover:underline">
            {c.out_trade_no}
          </Link>{" "}
          · {tr(`订单 ${yuan(c.base_cents)} × ${c.rate_percent}%`, `order ${yuan(c.base_cents)} × ${c.rate_percent}%`)}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span
          className={cn(
            "tnum text-body font-semibold",
            c.status === "reversed" && "text-muted-foreground line-through decoration-faint",
          )}
        >
          +{yuan(c.amount_cents)}
        </span>
        <CommissionBadge c={c} />
      </div>
    </li>
  );
}
