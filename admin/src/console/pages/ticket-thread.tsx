// One ticket of the inbox (TKT-02, TKT-03): the conversation (header with
// subject, user, category, priority, status and the 15-second auto refresh
// countdown; user bubbles left, staff bubbles right, the linked order /
// node as chips, a "新回复" divider when polling brings a new message, the
// newest message scrolled into view) and the reply box (quick replies,
// ⌘/Ctrl+Enter, 回复并关闭 and 回复 each with their own spinner). The context
// (user card, recent orders, assignee with an explicit 分配, category,
// priority, created, close / reopen) is a column from 1280px, else the
// header's ⓘ dialog (full screen on phones).
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  CircleCheck,
  Info,
  MessageSquareText,
  Receipt,
  RotateCcw,
  Send,
  Server,
  UserCheck,
  UserRound,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { bytes, dateOnly, dateTime, pct, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog } from "../../shared/ui/dialog";
import { Kbd, MOD_KEY, Select, Textarea } from "../../shared/ui/form";
import { Menu, MenuItem, MenuLabel } from "../../shared/ui/menu";
import { Meter } from "../../shared/ui/meter";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import { Avatar } from "../components/kit";
import { OrdStatus, UserStatus } from "../components/status";
import { useAction } from "../data";
import { navigate } from "../router";
import { useCrumb, useMe } from "../session";
import { catName, minutesSince, prioName, waitText, type Admin, type Ticket } from "./tickets";

type Message = {
  id: number;
  staff: boolean;
  author_label?: string;
  author_email?: string | null;
  body: string;
  created_at: string;
};
type TicketDetail = Ticket & { user_enabled: boolean; thread: Message[] };
/** The fields of `GET /users/{id}` the context card shows. */
type UserCard = {
  id: string;
  email: string;
  role: string;
  enabled: boolean;
  disabled_reason: string | null;
  expires_at: string | null;
  plan_id: string | null;
  plan_name: string | null;
  erased: boolean;
  balance_cents: number;
  traffic_used_bytes: number;
  traffic_limit_bytes: number | null;
  subscription: { traffic_used_bytes: number; traffic_total_bytes: number | null; expires_at: string | null } | null;
};
type RecentOrder = {
  id: string;
  out_trade_no: string;
  plan_name: string;
  amount_cents: number;
  status: string;
  fulfilled_at: string | null;
  refunded_at: string | null;
  created_at: string;
};

const POLL_SECS = 15;

/** Client-side quick replies (inserted into the box, editable before sending). */
function quickReplies(tr: Tr) {
  return [
    {
      label: tr("已处理，请更新订阅", "Fixed: update the subscription"),
      body: tr(
        "您好，已经处理好了。请在客户端里更新一次订阅，如仍有问题请直接回复本工单。",
        "Hi, this is fixed now. Please update the subscription in your client once; if anything is still wrong, just reply to this ticket.",
      ),
    },
    {
      label: tr("请提供订单号", "Ask for the order number"),
      body: tr(
        "您好，请提供付款截图和订单号（门户「订单」页可以看到），我们马上核对。",
        "Hi, please send a screenshot of the payment and the order number (shown on the Orders page of the portal) and we will check it right away.",
      ),
    },
    {
      label: tr("节点维护中", "Node under maintenance"),
      body: tr(
        "您好，该节点正在维护，恢复后会自动可用。期间请先使用同地区的其他节点。",
        "Hi, this node is under maintenance and will be back automatically. Meanwhile please use another node in the same region.",
      ),
    },
    {
      label: tr("邮件收不到", "Email not arriving"),
      body: tr(
        "您好，请检查垃圾邮件箱，并把本站的发件地址加入联系人后重新发送。",
        "Hi, please check your spam folder and add our sender address to your contacts, then send it again.",
      ),
    },
  ];
}

export function TicketThread({ id, admins, phone }: { id: string; admins: Admin[]; phone?: boolean }) {
  const tr = useTr();
  const me = useMe();
  const q = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => get<TicketDetail>(`/tickets/${id}`),
    refetchInterval: POLL_SECS * 1000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const t = q.data;
  useCrumb(t?.subject);
  const [info, setInfo] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  // "新回复": messages that arrive by polling (not this operator's own replies).
  const seen = useRef<number | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const count = t?.thread.length ?? 0;
  useEffect(() => {
    if (!t) return;
    if (seen.current === null) seen.current = count;
    else if (count > seen.current) {
      const added = t.thread.slice(seen.current);
      const from = seen.current;
      if (added.some((m) => !m.staff || m.author_email !== me.email)) setFresh((f) => f ?? from);
      seen.current = count;
    }
  }, [t, count, me.email]);
  // The newest message in view: on open and whenever one arrives.
  useEffect(() => {
    if (count) end.current?.scrollIntoView({ block: "end" });
  }, [count]);

  const back = (
    <Button
      variant="ghost"
      size="icon"
      icon={ArrowLeft}
      aria-label={tr("返回工单列表", "Back to the tickets")}
      onClick={() => navigate(`/tickets${location.search}`)}
      className="-ml-2 shrink-0"
    />
  );

  if (q.isError && !t) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className={cn("flex flex-col", phone ? "-mx-4 -mt-4 min-h-[60dvh] bg-window" : "bg-window/50")}>
        {phone && <div className="flex h-12 items-center bg-card px-4">{back}</div>}
        <div className="flex flex-1 items-center justify-center p-6">
          {missing ? (
            <EmptyState
              icon={MessageSquareText}
              title={tr("找不到这条工单", "Ticket not found")}
              description={tr("它可能已被删除，或链接有误。", "It may have been deleted, or the link is wrong.")}
            />
          ) : (
            <ErrorState
              title={tr("会话加载失败", "The conversation did not load")}
              error={q.error}
              onRetry={() => void q.refetch()}
            />
          )}
        </div>
      </div>
    );
  }

  const closed = t?.status === "closed";
  const [prio, prioTone] = t ? prioName(t.priority, tr) : ["", "neutral" as const];
  const header = (
    <div className="flex shrink-0 items-start gap-2 border-b border-separator px-4 py-3 sm:px-6">
      {phone && back}
      <div className="min-w-0 flex-1">
        {t ? (
          <>
            <h2 className="text-headline font-semibold break-words max-sm:text-callout">{t.subject}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-muted-foreground">
              <Link
                to={`/users?open=${t.user_id}`}
                className="max-w-full truncate font-medium text-foreground hover:text-primary hover:underline"
              >
                {t.user_email}
              </Link>
              {!t.user_enabled && <Badge tone="danger">{tr("已停用/封禁", "Disabled/banned")}</Badge>}
              <Badge tone="outline">{catName(t.category, tr)}</Badge>
              <Badge tone={prioTone}>{prio}</Badge>
              {closed ? (
                <Badge tone="neutral">{tr("已关闭", "Closed")}</Badge>
              ) : t.status === "open" && t.waiting_since ? (
                <Badge tone={minutesSince(t.waiting_since) >= 120 ? "danger" : "warning"} dot>
                  {tr(`等待回复 ${waitText(t.waiting_since, tr)}`, `Waiting ${waitText(t.waiting_since, tr)}`)}
                </Badge>
              ) : (
                <Badge tone="success" dot>
                  {tr("已回复", "Answered")}
                </Badge>
              )}
            </div>
          </>
        ) : (
          <div className="grid gap-2 py-1">
            <Skeleton className="h-4 w-60 max-w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
        )}
      </div>
      <Poll updatedAt={q.dataUpdatedAt} failed={q.isError && !!t} />
      <Button
        variant="ghost"
        size="icon"
        icon={Info}
        className="shrink-0 xl:hidden"
        aria-label={tr("用户与工单信息", "User and ticket info")}
        disabled={!t}
        onClick={() => setInfo(true)}
      />
    </div>
  );

  const body = !t ? (
    <ThreadSkeleton />
  ) : (
    <ol className="grid gap-4 px-4 py-5 sm:px-6" aria-label={tr("会话", "Conversation")}>
      {t.thread.map((m, i) => (
        <li key={m.id}>
          {fresh !== null && i === fresh && (
            <div className="mb-4 flex items-center gap-3 text-caption font-semibold text-primary" role="status">
              <span className="h-px flex-1 bg-primary/40" />
              {tr("新回复 · 刚刚自动取回", "New reply · just fetched")}
              <span className="h-px flex-1 bg-primary/40" />
            </div>
          )}
          <Bubble m={m} t={t} first={i === 0} fresh={fresh !== null && i >= fresh} />
        </li>
      ))}
      {closed && (
        <li className="flex justify-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-footnote text-muted-foreground">
            <CircleCheck className="size-3.5" aria-hidden="true" />
            {t.closed_by === "user"
              ? tr("用户关闭了工单", "The user closed the ticket")
              : tr("客服关闭了工单", "Staff closed the ticket")}
            {t.closed_at && ` · ${dateTime(t.closed_at)}`}
          </span>
        </li>
      )}
      <div ref={end} />
    </ol>
  );

  const ctx = t ? <Context t={t} admins={admins} /> : null;
  const infoDialog = t && (
    <Dialog
      open={info}
      onClose={() => setInfo(false)}
      title={tr("用户与工单", "User and ticket")}
      description={t.user_email}
      icon={UserRound}
    >
      <div className="-mx-5 -my-4">{ctx}</div>
    </Dialog>
  );

  if (phone)
    return (
      <div className="-mx-4 -mt-4 flex min-h-[calc(100dvh-48px-64px)] flex-col bg-window">
        <div className="bg-card">{header}</div>
        <div className="flex-1 pb-[150px]">{body}</div>
        {t && (
          <div className="fixed inset-x-0 bottom-[calc(52px+env(safe-area-inset-bottom))] z-20 border-t border-separator bg-card">
            <Composer t={t} compact />
          </div>
        )}
        {infoDialog}
      </div>
    );

  return (
    <div className="grid min-h-0 xl:grid-cols-[minmax(0,1fr)_288px]">
      <section className="flex min-h-0 flex-col" aria-label={t?.subject ?? tr("工单", "Ticket")}>
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto bg-window/60">{body}</div>
        {t && (
          <div className="shrink-0 border-t border-separator">
            <Composer t={t} />
          </div>
        )}
      </section>
      <aside
        className="hidden min-h-0 overflow-y-auto border-l border-separator xl:block"
        aria-label={tr("用户与工单", "User and ticket")}
      >
        {ctx ?? <ThreadSkeleton />}
      </aside>
      {infoDialog}
    </div>
  );
}

/** "自动刷新 · N 秒" — counts down to the next poll. */
function Poll({ updatedAt, failed }: { updatedAt: number; failed: boolean }) {
  const tr = useTr();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  const left = updatedAt ? Math.max(0, POLL_SECS - Math.floor((now - updatedAt) / 1000)) : POLL_SECS;
  return (
    <span
      className={cn(
        "mt-0.5 hidden shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-caption whitespace-nowrap sm:inline-flex",
        failed ? "bg-warning-soft text-warning" : "bg-secondary text-muted-foreground",
      )}
      title={tr(`每 ${POLL_SECS} 秒取一次新回复`, `New replies are fetched every ${POLL_SECS} s`)}
    >
      <span className={cn("size-1.5 rounded-full", failed ? "bg-warning" : "bg-success")} aria-hidden="true" />
      {failed
        ? tr("刷新失败，显示上次的数据", "Refresh failed; showing the last data")
        : tr(`自动刷新 · ${left} 秒`, `Auto refresh · ${left}s`)}
    </span>
  );
}

function Bubble({ m, t, first, fresh }: { m: Message; t: TicketDetail; first: boolean; fresh: boolean }) {
  const tr = useTr();
  const me = useMe();
  const staff = m.staff;
  const who = staff ? (m.author_email ?? m.author_label ?? tr("客服", "Staff")) : t.user_email;
  const name = staff
    ? m.author_email === me.email
      ? tr("我", "Me")
      : who.split("@")[0]
    : first
      ? t.user_email
      : tr("用户", "User");
  return (
    <div className={cn("flex gap-2.5", staff && "flex-row-reverse")}>
      <Avatar name={who} size={28} className="mt-5" />
      <div className={cn("flex max-w-[min(560px,82%)] min-w-0 flex-col", staff && "items-end")}>
        <div className={cn("mb-1 flex items-baseline gap-2 text-footnote", staff && "flex-row-reverse")}>
          <span className="truncate font-semibold">{name}</span>
          {staff && <span className="text-faint">{tr("客服", "Staff")}</span>}
          <span className="tnum shrink-0 text-faint">{dateTime(m.created_at)}</span>
        </div>
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2.5 text-body break-words whitespace-pre-wrap",
            staff ? "rounded-tr-md bg-primary text-primary-foreground" : "rounded-tl-md bg-card shadow-card",
            fresh && "ring-2 ring-primary/40",
          )}
        >
          {m.body}
        </div>
        {first && (t.order_id || t.node_id) && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {t.order_id && (
              <Link
                to={`/orders?open=${t.order_id}`}
                className="inline-flex h-6 items-center gap-1 rounded-full bg-card px-2 text-footnote font-medium shadow-card hover:text-primary pointer-coarse:h-9"
              >
                <Receipt className="size-3.5 text-faint" aria-hidden="true" />
                <span className="sr-only">{tr("关联订单", "Linked order")} </span>
                <span className="font-mono">{t.order_no ?? t.order_id.slice(0, 8)}</span>
                <ArrowUpRight className="size-3 text-faint" aria-hidden="true" />
              </Link>
            )}
            {t.node_id && (
              <Link
                to={`/nodes?open=node:${t.node_id}`}
                className="inline-flex h-6 items-center gap-1 rounded-full bg-card px-2 text-footnote font-medium shadow-card hover:text-primary pointer-coarse:h-9"
              >
                <Server className="size-3.5 text-faint" aria-hidden="true" />
                <span className="sr-only">{tr("关联节点", "Linked node")} </span>
                {t.node_name ?? tr("已删除的节点", "Deleted node")}
                <ArrowUpRight className="size-3 text-faint" aria-hidden="true" />
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ t, compact }: { t: TicketDetail; compact?: boolean }) {
  const tr = useTr();
  const [text, setText] = useState("");
  const [reply, replyBusy] = useAction();
  const [replyClose, replyCloseBusy] = useAction();
  const [reopen, reopenBusy] = useAction();
  const busy = replyBusy || replyCloseBusy;
  const body = text.trim();
  const send = async (close: boolean) => {
    if (!body || busy) return;
    const r = await (close ? replyClose : reply)(() => post(`/tickets/${t.id}/replies`, { message: body, close }), {
      ok: close ? tr("已回复并关闭", "Replied and closed") : tr("已回复", "Replied"),
    });
    if (r !== undefined) setText("");
  };
  if (t.status === "closed")
    return (
      <div className={cn("flex flex-wrap items-center gap-2 bg-card", compact ? "p-2.5" : "px-4 py-3 sm:px-6")}>
        <p className="min-w-0 flex-1 text-footnote text-muted-foreground">
          {tr("工单已关闭。重新打开后才能回复。", "The ticket is closed. Reopen it to reply.")}
        </p>
        <Button
          icon={RotateCcw}
          loading={reopenBusy}
          onClick={() => void reopen(() => post(`/tickets/${t.id}/reopen`), { ok: tr("已重新打开", "Reopened") })}
        >
          {tr("重新打开", "Reopen")}
        </Button>
      </div>
    );
  return (
    <div className={cn("bg-card", compact ? "p-2.5" : "px-4 pt-3 pb-3 sm:px-6")}>
      <div className="rounded-xl bg-card shadow-[0_0_0_0.5px_var(--input)] focus-within:shadow-[0_0_0_1px_var(--primary),0_0_0_4px_var(--ring)]">
        <Textarea
          aria-label={tr("回复", "Reply")}
          value={text}
          maxLength={5000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void send(false);
            }
          }}
          readOnly={busy}
          placeholder={tr(`回复 ${t.user_email.split("@")[0]}…`, `Reply to ${t.user_email.split("@")[0]}…`)}
          className={cn("resize-none bg-transparent shadow-none", compact ? "min-h-11" : "min-h-19")}
        />
        <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
          <Menu
            align="start"
            label={tr("快捷回复", "Quick replies")}
            className="w-80 max-w-[calc(100vw-24px)]"
            trigger={
              <Button variant="ghost" size="sm" icon={Zap} disabled={busy}>
                {tr("快捷回复", "Quick replies")}
              </Button>
            }
          >
            <MenuLabel>{tr("插入后可以再改", "Editable after inserting")}</MenuLabel>
            {quickReplies(tr).map((r) => (
              <MenuItem key={r.label} onClick={() => setText((s) => (s.trim() ? `${s}\n\n` : "") + r.body)}>
                {r.label}
              </MenuItem>
            ))}
          </Menu>
          <span className="ml-auto hidden items-center gap-1 text-caption text-faint sm:flex">
            <Kbd>{MOD_KEY}</Kbd>
            <Kbd>Enter</Kbd> {tr("回复", "reply")}
          </span>
          <Button
            size="sm"
            icon={CircleCheck}
            loading={replyCloseBusy}
            disabled={!body || replyBusy}
            className={cn(compact && "ml-auto")}
            onClick={() => void send(true)}
          >
            {tr("回复并关闭", "Reply and close")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={Send}
            loading={replyBusy}
            disabled={!body || replyCloseBusy}
            onClick={() => void send(false)}
          >
            {tr("回复", "Reply")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Context({ t, admins }: { t: TicketDetail; admins: Admin[] }) {
  const tr = useTr();
  const me = useMe();
  const user = useQuery({ queryKey: ["user", t.user_id], queryFn: () => get<UserCard>(`/users/${t.user_id}`) });
  const orders = useQuery({
    queryKey: ["orders", "user", t.user_email, "recent"],
    queryFn: () => get<RecentOrder[]>(`/orders?email=${encodeURIComponent(t.user_email)}&limit=3`),
  });
  const [pick, setPick] = useState<string | null>(null);
  const [assign, assignBusy] = useAction();
  const [toggle, toggleBusy] = useAction();
  const current = t.assignee_id ?? "";
  const chosen = pick ?? current;
  const changed = pick !== null && pick !== current;
  const u = user.data;
  const used = u?.subscription?.traffic_used_bytes ?? u?.traffic_used_bytes ?? 0;
  const total = u?.subscription ? u.subscription.traffic_total_bytes : (u?.traffic_limit_bytes ?? null);
  const [prio, prioTone] = prioName(t.priority, tr);
  // data-nodirty: picking an assignee in the ⓘ dialog is not an unsaved edit (分配 applies it).
  return (
    <div className="divide-y divide-separator" data-nodirty>
      <section className="p-4" aria-label={tr("用户", "User")}>
        {user.isPending ? (
          <div className="grid gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : user.isError ? (
          <ErrorState compact error={user.error} onRetry={() => void user.refetch()} />
        ) : u ? (
          <>
            <div className="flex items-center gap-2.5">
              <Avatar name={u.email} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-semibold">{u.email}</div>
                <div className="mt-0.5">
                  <UserStatus user={u} />
                </div>
              </div>
            </div>
            <dl className="mt-3.5 grid grid-cols-2 gap-x-3 gap-y-2.5 text-body">
              <div className="min-w-0">
                <dt className="text-footnote text-muted-foreground">{tr("套餐", "Plan")}</dt>
                <dd className="truncate font-medium">{u.plan_name ?? tr("无套餐", "No plan")}</dd>
              </div>
              <div>
                <dt className="text-footnote text-muted-foreground">{tr("到期", "Expires")}</dt>
                <dd className="tnum font-medium">{u.expires_at ? dateOnly(u.expires_at) : "—"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="flex justify-between gap-2 text-footnote text-muted-foreground">
                  <span>{tr("本周期流量", "This period's traffic")}</span>
                  <span className="tnum">
                    {bytes(used)} / {total === null ? tr("不限", "unlimited") : bytes(total)}
                  </span>
                </dt>
                {total !== null && (
                  <dd className="mt-1.5">
                    <Meter value={pct(used, total)} label={tr("本周期流量", "This period's traffic")} />
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-footnote text-muted-foreground">{tr("余额", "Balance")}</dt>
                <dd className="tnum font-medium">{yuan(u.balance_cents)}</dd>
              </div>
            </dl>
            <Button asChild variant="outline" size="sm" className="mt-3.5 w-full">
              <Link to={`/users?open=${u.id}`}>
                <UserRound aria-hidden="true" />
                {tr("打开用户详情", "Open the user")}
              </Link>
            </Button>
          </>
        ) : null}
      </section>

      <section className="py-3" aria-label={tr("最近订单", "Recent orders")}>
        <h3 className="mb-1 px-4 text-footnote font-semibold text-muted-foreground">
          {tr("最近订单", "Recent orders")}
        </h3>
        {orders.isPending ? (
          <div className="grid gap-2 px-4 py-1">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : orders.isError ? (
          <ErrorState compact error={orders.error} onRetry={() => void orders.refetch()} />
        ) : !orders.data?.length ? (
          <p className="px-4 py-1 text-footnote text-faint">{tr("还没有订单", "No orders yet")}</p>
        ) : (
          orders.data.slice(0, 3).map((o) => (
            <Link
              key={o.id}
              to={`/orders?open=${o.id}`}
              className="flex items-center gap-2 px-4 py-1.5 hover:bg-accent pointer-coarse:py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-footnote">{o.out_trade_no}</span>
                <span className="block truncate text-caption text-faint">
                  {o.plan_name} · {dateOnly(o.created_at)}
                </span>
              </span>
              <span className="flex flex-col items-end gap-0.5">
                <span className="tnum text-footnote font-medium">{yuan(o.amount_cents)}</span>
                <OrdStatus order={o} />
              </span>
            </Link>
          ))
        )}
      </section>

      <section className="grid gap-3 p-4" aria-label={tr("处理", "Handling")}>
        <h3 className="text-footnote font-semibold text-muted-foreground">{tr("处理", "Handling")}</h3>
        <div className="grid gap-1.5">
          <label htmlFor={`assignee-${t.id}`} className="text-footnote text-muted-foreground">
            {tr("负责人", "Assignee")}
          </label>
          <div className="flex gap-1.5">
            <Select
              id={`assignee-${t.id}`}
              className="min-w-0 flex-1"
              value={chosen}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">{tr("未分配", "Unassigned")}</option>
              {admins.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                  {a.id === me.id ? tr("（我）", " (me)") : ""}
                </option>
              ))}
            </Select>
            <Button
              variant={changed ? "primary" : "secondary"}
              icon={UserCheck}
              loading={assignBusy}
              disabled={!changed}
              onClick={async () => {
                const r = await assign(() => put(`/tickets/${t.id}/assignee`, { assignee_id: chosen || null }), {
                  ok: chosen ? tr("已分配", "Assigned") : tr("已取消分配", "Unassigned"),
                });
                if (r !== undefined) setPick(null);
              }}
            >
              {tr("分配", "Assign")}
            </Button>
          </div>
          {changed && (
            <span className="text-footnote text-faint">
              {tr("点「分配」后生效。", "Takes effect when you press Assign.")}
            </span>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-y-2 text-body">
          <dt className="text-muted-foreground">{tr("分类", "Category")}</dt>
          <dd className="text-right font-medium">{catName(t.category, tr)}</dd>
          <dt className="text-muted-foreground">{tr("优先级", "Priority")}</dt>
          <dd className="text-right">
            <Badge tone={prioTone}>{prio}</Badge>
          </dd>
          <dt className="text-muted-foreground">{tr("创建", "Created")}</dt>
          <dd className="tnum text-right font-medium">{dateTime(t.created_at)}</dd>
          <dt className="text-muted-foreground">{tr("消息", "Messages")}</dt>
          <dd className="tnum text-right font-medium">{t.messages}</dd>
        </dl>
        {t.status === "closed" ? (
          <Button
            className="w-full"
            icon={RotateCcw}
            loading={toggleBusy}
            onClick={() => void toggle(() => post(`/tickets/${t.id}/reopen`), { ok: tr("已重新打开", "Reopened") })}
          >
            {tr("重新打开", "Reopen")}
          </Button>
        ) : (
          <Button
            className="w-full"
            icon={CircleCheck}
            loading={toggleBusy}
            onClick={() => void toggle(() => post(`/tickets/${t.id}/close`), { ok: tr("已关闭", "Closed") })}
          >
            {tr("关闭工单", "Close ticket")}
          </Button>
        )}
      </section>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="grid gap-5 px-6 py-5" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className={cn("flex gap-2.5", i === 1 && "flex-row-reverse")}>
          <Skeleton className="size-7 rounded-full" />
          <div className="grid w-[55%] gap-1.5">
            <Skeleton className={cn("h-2.5 w-28", i === 1 && "justify-self-end")} />
            <Skeleton className="h-16 rounded-2xl" />
          </div>
        </div>
      ))}
    </div>
  );
}
