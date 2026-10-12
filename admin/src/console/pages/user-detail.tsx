// One account (USR-06…23), v2: an xl dialog whose header carries the
// avatar, address, status and marks, `#id · 注册 · 最后登录 · 最后使用`, and a
// fact strip visible on every tab (plan + expiry, this period's traffic,
// balance incl. withdrawable, sign-in methods; each cell jumps to its tab).
// Tabs (?tab=): 概览 (ban / over-quota banners, the subscription card with
// renew / extend / cancel, the plan history timeline, the subscription link
// card (masked until 显示: reading is audited) and the account card), 流量
// (daily chart + per entrance), 账单 (orders + balance ledger + manual
// adjustment), 账户与安全 (role, password, email verification, sessions,
// passkeys, the danger zone). The footer holds the frequent actions (ban /
// unban, reset traffic, renew or assign) and ⋯ 更多 the rarer ones. The
// sub-dialogs live in components/people-detail-dialogs.tsx. Every write
// goes through the API client, so the list and this detail refetch on
// their own (data.ts).
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Ban,
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Crown,
  Eye,
  Fingerprint,
  KeyRound,
  Layers,
  LogOut,
  Mail,
  MailCheck,
  MoreHorizontal,
  Plus,
  QrCode as QrIcon,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { del, get, patch, post } from "../../shared/api";
import { cn } from "../../shared/cn";
import { ago, bytes, dateOnly, dateTime, daysBefore, pct, rateText, siteToday, yuan } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, Group, Row } from "../../shared/ui/card";
import { LineChart } from "../../shared/ui/line-chart";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Segmented } from "../../shared/ui/form";
import { Banner, KV, SectionTitle } from "../../shared/ui/layout";
import { Menu, MenuItem, MenuSeparator } from "../../shared/ui/menu";
import { Meter, usageTone } from "../../shared/ui/meter";
import { QrCode } from "../../shared/ui/qr-code";
import { ErrorState, SkeletonRows } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";
import { useToast } from "../../shared/ui/toast";
import { Avatar, CopyText, RelDays, Timeline } from "../components/kit";
import {
  absoluteUrl,
  BanDialog,
  ChangePlanDialog,
  ExtendPopover,
  PasswordDialog,
  SendMailDialog,
  type Detail,
  type Subscription,
} from "../components/people-detail-dialogs";
import { UserStatus } from "../components/status";
import { useErrText } from "../kit";
import { navigate } from "../router";
import { useCrumb, useMe } from "../session";
import { periodLabel, resetLabel } from "../terms";
import type { PlanView } from "../types";
import { UserMarks } from "./users";

export { AdjustBalanceDialog, CreateUserDialog, absoluteUrl } from "../components/people-detail-dialogs";
import { AdjustBalanceDialog } from "../components/people-detail-dialogs";

type PlanHistory = {
  id: string;
  plan_name: string;
  status: string;
  period: string;
  period_days: number | null;
  starts_at: string;
  expires_at: string | null;
  ended_at: string | null;
};
type Passkeys = {
  available: boolean;
  passkeys: { id: string; name: string; created_at: string; last_used_at: string | null }[];
  password_set: boolean;
  password_login_disabled: boolean;
  password_login: boolean;
};
type Impact = {
  email: string;
  balance_cents: number;
  withdrawable_cents: number;
  pending_withdrawals: number;
  pending_withdrawal_cents: number;
  pending_orders: number;
  unfulfilled_orders: number;
  plan: { name: string; expires_at: string | null } | null;
  anonymized: boolean;
};
type LedgerEntry = {
  id: number;
  kind: string;
  amount_cents: number;
  balance_after_cents: number;
  out_trade_no: string | null;
  reason: string | null;
  created_at: string;
  actor_label: string;
};
type Ledger = { balance_cents: number; withdrawable_cents: number; entries: LedgerEntry[] };
type UserOrder = {
  id: string;
  out_trade_no: string;
  plan_name: string;
  period: string;
  period_days: number | null;
  amount_cents: number;
  list_price_cents: number;
  status: string;
  fulfilled_at: string | null;
  refunded_at: string | null;
  created_at: string;
};

type Tab = "overview" | "traffic" | "billing" | "security";
type Sub = null | "plan" | "ban" | "password" | "balance" | "mail";

export function subStatusText(s: Subscription["status"], tr: Tr): string {
  return {
    active: tr("正常", "Active"),
    expired: tr("已到期", "Expired"),
    over_quota: tr("流量用尽（已停用）", "Over quota (suspended)"),
    banned: tr("已封禁", "Banned"),
  }[s];
}

function planStatus(s: string, tr: Tr): [string, "success" | "neutral" | "warning"] {
  switch (s) {
    case "active":
      return [tr("生效中", "Active"), "success"];
    case "replaced":
      return [tr("已更换", "Replaced"), "neutral"];
    case "cancelled":
      return [tr("已取消", "Cancelled"), "warning"];
    case "expired":
      return [tr("已到期", "Expired"), "neutral"];
    default:
      return [tr("未知", "Unknown"), "neutral"];
  }
}

export function ledgerKind(k: string, tr: Tr): string {
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

function orderStatus(o: UserOrder, tr: Tr): [string, Tone] {
  if (o.refunded_at) return [tr("已退款", "Refunded"), "neutral"];
  switch (o.status) {
    case "pending":
      return [tr("待付款", "Pending"), "info"];
    case "paid":
      return o.fulfilled_at ? [tr("已完成", "Completed"), "success"] : [tr("开通失败", "Not fulfilled"), "danger"];
    case "expired":
      return [tr("已过期", "Expired"), "outline"];
    case "cancelled":
      return [tr("已取消", "Cancelled"), "outline"];
    default:
      return [tr("未知", "Unknown"), "neutral"];
  }
}

const TABS: Tab[] = ["overview", "traffic", "billing", "security"];
/** Old links: ?tab=orders / ?tab=account. */
const ALIAS: Record<string, Tab> = { orders: "billing", account: "security" };

function useOrders(email: string | undefined) {
  return useQuery({
    queryKey: ["orders", "user", email],
    queryFn: () => get<UserOrder[]>(`/orders?email=${encodeURIComponent(email ?? "")}&limit=20`),
    enabled: !!email,
  });
}

export function UserDetail({
  id,
  plans,
  tab: tabParam,
  onTab,
  onClose,
}: {
  id: string;
  plans: PlanView[];
  tab: string;
  onTab: (t: Tab) => void;
  onClose: () => void;
}) {
  const tr = useTr();
  const me = useMe();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrText();
  const lang = useLang();
  const q = useQuery({ queryKey: ["user", id], queryFn: () => get<Detail>(`/users/${id}`) });
  const [sub, setSub] = useState<Sub>(null);
  const [deleting, setDeleting] = useState(false);
  const u = q.data;
  useCrumb(u?.email);
  const avatarName = u && !u.email_pending ? u.email : "?";
  const erased = !!u?.erased;
  const avatarIcon = useMemo(
    () =>
      function UserAvatar() {
        return <Avatar name={avatarName} size={40} className={erased ? "opacity-40 grayscale" : undefined} />;
      } as unknown as LucideIcon,
    [avatarName, erased],
  );
  const orders = useOrders(u && !u.email_pending ? u.email : undefined);
  const isAdmin = u?.role === "admin";
  const otherAdmin = isAdmin && u?.id !== me.id;
  const ownerOnly = !!otherAdmin && !me.is_owner;
  const live = !!u && !u.erased;
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : (ALIAS[tabParam] ?? "overview");
  const current = u?.subscription ?? null;
  const self = u?.id === me.id;
  const canBan = live && !u.is_owner && !self && !isAdmin;

  /** Confirm, run, toast; the list and this detail refetch by themselves. */
  const act = async (opts: Parameters<typeof confirm>[0], fn: () => Promise<unknown>, ok: string) => {
    if (await confirm({ ...opts, action: fn })) toast({ tone: "success", title: ok });
  };

  const unban = () =>
    u &&
    void act(
      {
        title: tr("解除封禁？", "Lift the ban?"),
        description: tr(
          "账户恢复正常：可以登录，订阅恢复可用（套餐仍需有效）。写入审计。",
          "The account works again: sign-in and the subscription (with a valid plan). Audited.",
        ),
        impacts: u.ban
          ? [
              { label: tr("封禁原因", "Reason"), value: u.ban.reason ?? "—" },
              {
                label: tr("封禁于", "Banned"),
                value: `${dateTime(u.ban.banned_at)} · ${u.ban.banned_by_email ?? tr("系统", "system")}`,
              },
            ]
          : undefined,
        tone: "default",
        confirmLabel: tr("解除封禁", "Unban"),
      },
      () => post(`/users/${id}/unban`),
      tr("已解除封禁", "Ban lifted"),
    );

  const resetTraffic = () =>
    current &&
    void act(
      {
        title: tr("重置套餐流量？", "Reset the plan traffic?"),
        impacts: [
          {
            label: tr("本周期已用", "Used this period"),
            value: `${bytes(current.traffic_used_bytes)} → 0`,
          },
          { label: tr("到期日", "Expiry"), value: tr("不变", "unchanged") },
          {
            label: tr("超流量停用", "Over-quota suspension"),
            value: tr("立即恢复（封禁不受影响）", "lifted now (a ban stays)"),
          },
        ],
        tone: "warning",
        confirmLabel: tr("重置流量", "Reset traffic"),
      },
      () => post(`/users/${id}/plan/reset-traffic`, { confirm: true }),
      tr("流量已重置", "Traffic reset"),
    );

  const renew = () =>
    current &&
    void act(
      {
        title: tr("续期一个周期？", "Renew one term?"),
        description: tr(
          "从到期日（已到期则从现在）起再加一个相同的时长，写入审计。不生成订单。",
          "Adds the same term from the expiry (or now when expired). Audited; no order is made.",
        ),
        impacts: [
          { label: tr("时长", "Term"), value: periodLabel(current.period, tr, current.period_days) },
          { label: tr("当前到期", "Expires now"), value: current.expires_at ? dateOnly(current.expires_at) : "—" },
        ],
        tone: "default",
        confirmLabel: tr("续期", "Renew"),
      },
      () =>
        patch(`/users/${id}/plan`, {
          period: current.period,
          ...(current.period === "days" && current.period_days ? { days: current.period_days } : {}),
        }),
      tr("已续期一个周期", "Renewed one term"),
    );

  const resetSub = () =>
    u &&
    void act(
      {
        title: tr("重置订阅？", "Reset the subscription?"),
        description: tr(
          "生成新的订阅链接，并更换该用户在每个入口上的凭据。",
          "A new subscription link and new credentials on every entrance.",
        ),
        impacts: [
          { label: tr("旧链接", "Old link"), value: tr("立即失效", "stops now") },
          { label: tr("已导入的客户端", "Imported clients"), value: tr("需要重新导入", "must import again") },
          { label: tr("在线连接", "Live connections"), value: tr("全部断开", "all cut") },
        ],
        typeToConfirm: u.email,
        confirmLabel: tr("重置订阅", "Reset subscription"),
      },
      () => post(`/users/${id}/sub-token`),
      tr("订阅已重置", "Subscription reset"),
    );

  const cancelPlan = () =>
    u &&
    current &&
    void act(
      {
        title: tr("取消套餐？", "Cancel the plan?"),
        description: tr(
          "订阅立即结束，不会自动退款；需要退款请到订单页对相应订单操作。写入审计。",
          "The subscription ends now with no automatic refund (refund the order on the orders page). Audited.",
        ),
        impacts: [
          { label: tr("套餐", "Plan"), value: current.plan_name },
          {
            label: tr("剩余", "Left"),
            value: current.expires_at ? <RelDays date={current.expires_at} /> : tr("不过期", "never expires"),
          },
          { label: tr("入口与在线连接", "Entrances, connections"), value: tr("立即失去、断开", "lost, cut now") },
        ],
        typeToConfirm: u.email,
        confirmLabel: tr("取消套餐", "Cancel plan"),
      },
      () => del(`/users/${id}/plan`),
      tr("套餐已取消", "Plan cancelled"),
    );

  const kick = () =>
    void act(
      {
        title: tr("踢下线？", "Sign out everywhere?"),
        description: tr(
          "该账户的全部会话立即失效，所有设备需要重新登录。",
          "Every session ends now; every device must sign in again.",
        ),
        tone: "warning",
        confirmLabel: tr("踢下线", "Sign out"),
      },
      () => post(`/users/${id}/revoke-sessions`),
      tr("已踢下线", "Signed out everywhere"),
    );

  const verify = () =>
    void act(
      {
        title: tr("标记邮箱已验证？", "Mark the address verified?"),
        description: tr(
          "该地址之后会收到系统邮件，也可用于找回密码。",
          "The address then receives mail and can reset the password.",
        ),
        tone: "default",
        confirmLabel: tr("标记已验证", "Mark verified"),
      },
      () => post(`/users/${id}/email/verify`),
      tr("已标记为已验证", "Marked verified"),
    );

  const setRole = (to: "user" | "admin") =>
    void act(
      {
        title: to === "user" ? tr("降为普通用户？", "Demote to user?") : tr("设为管理员？", "Make admin?"),
        description:
          to === "user"
            ? tr("该账户将失去后台访问。", "The account loses console access.")
            : tr(
                "管理员不是代理用户：不会下发到节点，订阅失效。只有所有者可以设管理员。",
                "Admins are not proxy users (no nodes, no subscription). Only the owner makes admins.",
              ),
        tone: "warning",
        confirmLabel: to === "user" ? tr("降为普通用户", "Demote") : tr("设为管理员", "Make admin"),
      },
      () => patch(`/users/${id}`, { role: to }),
      to === "user" ? tr("已降为普通用户", "Demoted to user") : tr("已设为管理员", "Made admin"),
    );

  const transfer = () =>
    u &&
    void act(
      {
        title: tr(`把所有者转让给 ${u.email}？`, `Transfer the ownership to ${u.email}?`),
        description: tr(
          "转让后你将成为普通管理员，不能再管理其他管理员、后台前缀与支付密钥。",
          "You become an ordinary admin: no more managing admins, the admin prefix or payment keys.",
        ),
        impacts: [
          { label: tr("新所有者", "New owner"), value: u.email },
          { label: tr("你", "You"), value: tr("变为管理员", "become an admin") },
        ],
        typeToConfirm: u.email,
        confirmLabel: tr("转让所有者", "Transfer ownership"),
      },
      () => post(`/users/${id}/owner`, { confirm: true }),
      tr("所有者已转让", "Ownership transferred"),
    );

  const deleteUser = async () => {
    if (!u) return;
    let im: Impact;
    setDeleting(true);
    try {
      im = await get<Impact>(`/users/${id}/delete-impact`);
    } catch (e) {
      toast({ tone: "error", title: errText(e) });
      return;
    } finally {
      setDeleting(false);
    }
    const ok = await confirm({
      title: tr(`删除账户 ${u.email}？`, `Delete ${u.email}?`),
      description: im.anonymized
        ? tr(
            "该账户有财务记录：将匿名化保留订单与流水，个人数据删除。不可撤销。",
            "Has finance records: kept anonymized with its orders and ledger, personal data deleted. Cannot be undone.",
          )
        : tr("账户与其全部数据将被永久删除，不可撤销。", "The account and all its data are deleted for good."),
      impacts: [
        {
          label: tr("余额", "Balance"),
          value: tr(
            `余额 ${yuan(im.balance_cents)}（可提现 ${yuan(im.withdrawable_cents)}）`,
            `${yuan(im.balance_cents)} (${yuan(im.withdrawable_cents)} withdrawable)`,
          ),
        },
        {
          label: tr("待审提现", "Pending withdrawals"),
          value: tr(
            `${im.pending_withdrawals} 笔 · ${yuan(im.pending_withdrawal_cents)}`,
            `${im.pending_withdrawals} · ${yuan(im.pending_withdrawal_cents)}`,
          ),
        },
        {
          label: tr("待付 / 未开通订单", "Pending / unfulfilled orders"),
          value: `${im.pending_orders} / ${im.unfulfilled_orders}`,
        },
        {
          label: tr("有效套餐", "Active plan"),
          value: im.plan
            ? `${im.plan.name}${im.plan.expires_at ? ` · ${dateOnly(im.plan.expires_at)}` : ""}`
            : tr("无", "none"),
        },
        {
          label: tr("处理方式", "Outcome"),
          value: im.anonymized ? tr("匿名化保留", "kept anonymized") : tr("彻底删除", "deleted"),
        },
      ],
      typeToConfirm: u.email,
      confirmLabel: tr("永久删除", "Delete"),
      action: () => del(`/users/${id}?confirm=true`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("账户已删除", "Account deleted") });
      onClose();
    }
  };

  const nOrders = orders.data?.length;
  const tabs = [
    { value: "overview" as const, label: tr("概览", "Overview") },
    { value: "traffic" as const, label: tr("流量", "Traffic") },
    {
      value: "billing" as const,
      label: tr("账单", "Billing"),
      count: nOrders !== undefined && nOrders > 0 ? nOrders : undefined,
    },
    { value: "security" as const, label: tr("账户与安全", "Account & security") },
  ];

  const roleLock: string | null = !u
    ? null
    : u.is_owner
      ? tr(
          "所有者的角色不能在这里修改；请先把所有者转让给其他管理员。",
          "The owner's role cannot change here; transfer the ownership first.",
        )
      : !me.is_owner
        ? tr("只有所有者可以修改管理员角色。", "Only the owner changes admin roles.")
        : self
          ? tr("不能修改自己的角色。", "You cannot change your own role.")
          : current
            ? tr(
                "该用户持有套餐，需先取消套餐才能设为管理员。",
                "The user holds a plan; cancel it before making them an admin.",
              )
            : null;

  const footer = !u ? undefined : !live ? (
    <span className="text-footnote text-muted-foreground">
      {tr(
        "账户已注销：个人数据已删除，订单与余额流水以匿名方式保留。不能再修改。",
        "Erased account: personal data is gone, orders and ledger are kept anonymized. It cannot be changed.",
      )}
    </span>
  ) : (
    <>
      <Menu
        align="start"
        label={tr("更多操作", "More actions")}
        trigger={
          <Button variant="ghost" icon={MoreHorizontal} aria-label={tr("更多操作", "More actions")}>
            <span className="max-sm:hidden">{tr("更多", "More")}</span>
          </Button>
        }
      >
        <MenuItem icon={LogOut} disabled={ownerOnly} onClick={kick}>
          {tr("踢下线（结束全部会话）", "Sign out everywhere")}
        </MenuItem>
        {!isAdmin && (
          <MenuItem icon={RotateCcw} onClick={resetSub}>
            {tr("重置订阅链接…", "Reset the subscription link…")}
          </MenuItem>
        )}
        {u.email_verified && !u.email_pending && (
          <MenuItem icon={Mail} onClick={() => setSub("mail")}>
            {tr("发送邮件", "Send email")}
          </MenuItem>
        )}
        <MenuSeparator />
        {isAdmin ? (
          <MenuItem icon={Crown} disabled={!me.is_owner || u.is_owner || self || !u.enabled} onClick={transfer}>
            {tr("转让所有者…", "Transfer ownership…")}
            {!me.is_owner && tr("（仅所有者）", " (owner only)")}
          </MenuItem>
        ) : (
          <MenuItem icon={ShieldCheck} disabled={!!roleLock} onClick={() => setRole("admin")}>
            {tr("设为管理员", "Make admin")}
            {!me.is_owner
              ? tr("（仅所有者）", " (owner only)")
              : current
                ? tr("（需先取消套餐）", " (cancel the plan first)")
                : ""}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          icon={Trash2}
          danger
          disabled={u.is_owner || self || ownerOnly || deleting}
          onClick={() => void deleteUser()}
        >
          {tr("删除账户…", "Delete account…")}
        </MenuItem>
      </Menu>
      <span className="flex-1" />
      {canBan &&
        (u.ban ? (
          <Button variant="outline" icon={ShieldOff} onClick={unban}>
            {tr("解除封禁", "Unban")}
          </Button>
        ) : (
          <Button variant="destructive-soft" icon={Ban} aria-label={tr("封禁", "Ban")} onClick={() => setSub("ban")}>
            <span className="max-sm:hidden">{tr("封禁", "Ban")}</span>
          </Button>
        ))}
      {!isAdmin &&
        (current ? (
          <>
            <Button variant="outline" icon={RefreshCcw} onClick={resetTraffic}>
              {tr("重置流量", "Reset traffic")}
            </Button>
            <Button
              variant="primary"
              icon={CalendarPlus}
              disabled={current.period === "onetime"}
              title={
                current.period === "onetime" ? tr("一次性套餐不能续期", "One-time plans cannot be renewed") : undefined
              }
              onClick={renew}
            >
              {tr("续期", "Renew")}
            </Button>
          </>
        ) : (
          <Button variant="primary" icon={Plus} onClick={() => setSub("plan")}>
            {tr("分配套餐", "Assign a plan")}
          </Button>
        ))}
    </>
  );

  return (
    <>
      <Dialog
        open
        size="xl"
        dirty={false}
        onClose={onClose}
        icon={avatarIcon}
        title={
          u ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className={cn("truncate", u.erased && "line-through decoration-faint")}>
                {u.email_pending ? tr("（待绑定邮箱）", "(email pending)") : u.email}
              </span>
              <span className="hidden items-center gap-1.5 sm:inline-flex">
                <UserStatus user={u} />
                <UserMarks u={u} />
              </span>
            </span>
          ) : (
            tr("用户", "User")
          )
        }
        description={
          u && (
            <span className="tnum flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span>#{u.id.slice(0, 8)}</span>·
              <span>{tr(`注册 ${dateOnly(u.created_at)}`, `Signed up ${dateOnly(u.created_at)}`)}</span>·
              <span>
                {u.last_login_at
                  ? tr(`最后登录 ${ago(u.last_login_at, lang)}`, `Last sign-in ${ago(u.last_login_at, lang)}`)
                  : tr("从未登录", "Never signed in")}
              </span>
              {!isAdmin && (
                <>
                  ·
                  <span>
                    {u.last_traffic_day
                      ? tr(`最后使用 ${u.last_traffic_day}`, `Last used ${u.last_traffic_day}`)
                      : tr("从未使用", "Never used")}
                  </span>
                </>
              )}
              <span className="inline-flex items-center gap-1.5 sm:hidden">
                <UserStatus user={u} />
                <UserMarks u={u} compact />
              </span>
            </span>
          )
        }
        tabs={
          <>
            <Facts user={u} loading={q.isPending} onTab={onTab} />
            {u && <Tabs label={tr("用户详情", "User detail")} value={tab} onChange={(t) => onTab(t)} tabs={tabs} />}
          </>
        }
        footer={footer}
      >
        <div className="sm:min-h-[min(56vh,520px)]">
          {q.isPending ? (
            <SkeletonRows rows={8} />
          ) : q.error ? (
            <ErrorState
              title={tr("用户详情加载失败", "The user could not be loaded")}
              error={q.error}
              onRetry={() => void q.refetch()}
            />
          ) : (
            u && (
              <>
                {tab === "overview" && (
                  <Overview
                    user={u}
                    live={live}
                    isAdmin={isAdmin}
                    ownerOnly={ownerOnly}
                    onPlan={() => setSub("plan")}
                    onUnban={canBan ? unban : undefined}
                    onResetTraffic={resetTraffic}
                    onRenew={renew}
                    onCancel={cancelPlan}
                    onResetSub={resetSub}
                  />
                )}
                {tab === "traffic" && <UserTraffic id={id} />}
                {tab === "billing" && (
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
                    <UserOrders email={u.email_pending ? null : u.email} />
                    <BalanceLedger id={id} onAdjust={live ? () => setSub("balance") : undefined} />
                  </div>
                )}
                {tab === "security" && (
                  <Security
                    user={u}
                    live={live}
                    ownerOnly={ownerOnly}
                    roleLock={roleLock}
                    onRole={setRole}
                    onPassword={() => setSub("password")}
                    onVerify={verify}
                    onKick={kick}
                    onTransfer={transfer}
                    onDelete={() => void deleteUser()}
                    canDelete={!u.is_owner && !self && !ownerOnly}
                  />
                )}
              </>
            )
          )}
        </div>
      </Dialog>
      {u && sub === "plan" && (
        <ChangePlanDialog id={id} email={u.email} plans={plans} current={u.subscription} onClose={() => setSub(null)} />
      )}
      {u && sub === "ban" && <BanDialog id={id} email={u.email} onClose={() => setSub(null)} />}
      {u && sub === "password" && <PasswordDialog id={id} email={u.email} onClose={() => setSub(null)} />}
      {u && sub === "balance" && (
        <AdjustBalanceDialog id={id} email={u.email} balanceCents={u.balance_cents} onClose={() => setSub(null)} />
      )}
      {u && sub === "mail" && <SendMailDialog id={id} email={u.email} onClose={() => setSub(null)} />}
    </>
  );
}

/** The four facts pinned under the header (every tab); each cell opens its tab. */
function Facts({ user: u, loading, onTab }: { user: Detail | undefined; loading: boolean; onTab: (t: Tab) => void }) {
  const tr = useTr();
  const pk = useQuery({
    queryKey: ["user", u?.id, "passkeys"],
    queryFn: () => get<Passkeys>(`/users/${u?.id}/passkeys`),
    enabled: !!u && !u.erased,
  });
  const bal = useQuery({
    queryKey: ["balance", u?.id, "summary"],
    queryFn: () => get<Ledger>(`/users/${u?.id}/balance?limit=1`),
    enabled: !!u && !u.erased && u.role === "user",
  });
  if (loading || !u)
    return (
      <div className="flex gap-2 px-5 py-3" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-11 flex-1 animate-pulse rounded-lg bg-secondary" />
        ))}
      </div>
    );
  const s = u.subscription;
  const p = s ? pct(s.traffic_used_bytes, s.traffic_total_bytes) : 0;
  const cell =
    "min-w-0 flex-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none max-sm:min-w-[44%] max-sm:py-2";
  const passkeys = pk.data?.passkeys.length ?? u.passkeys;
  return (
    <div
      role="group"
      aria-label={tr("概要", "Summary")}
      className="flex overflow-x-auto px-3 py-1.5 [scrollbar-width:none] sm:divide-x sm:divide-separator sm:px-3"
    >
      <button type="button" className={cell} onClick={() => onTab("overview")}>
        <div className="text-caption font-medium text-muted-foreground">{tr("套餐", "Plan")}</div>
        <div className="truncate text-body font-semibold">
          {s ? s.plan_name : <span className="font-normal text-faint">{tr("无套餐", "No plan")}</span>}
        </div>
        <div className="truncate text-footnote text-muted-foreground">
          {s ? (
            s.expires_at ? (
              <>
                {tr("到期", "Expires")} {dateOnly(s.expires_at).slice(5)} · <RelDays date={s.expires_at} />
              </>
            ) : (
              tr("不过期", "Never expires")
            )
          ) : (
            "—"
          )}
        </div>
      </button>
      <button type="button" className={cell} onClick={() => onTab("traffic")}>
        <div className="text-caption font-medium text-muted-foreground">{tr("本周期流量", "This period")}</div>
        {s ? (
          <>
            <div className="tnum truncate text-body font-semibold">
              {bytes(s.traffic_used_bytes)}{" "}
              <span className="font-normal text-muted-foreground">
                / {s.traffic_total_bytes === null ? tr("不限", "unlimited") : bytes(s.traffic_total_bytes)}
              </span>
            </div>
            {s.traffic_total_bytes !== null && (
              <div className="mt-1 flex items-center gap-2">
                <Meter value={p} tone={usageTone(p)} className="flex-1" />
                <span className="tnum text-caption text-muted-foreground">{p.toFixed(0)}%</span>
              </div>
            )}
          </>
        ) : (
          <div className="text-body text-faint">—</div>
        )}
      </button>
      <button type="button" className={cell} onClick={() => onTab("billing")}>
        <div className="text-caption font-medium text-muted-foreground">{tr("余额", "Balance")}</div>
        <div className="tnum truncate text-body font-semibold">{yuan(u.balance_cents)}</div>
        <div className="tnum truncate text-footnote text-muted-foreground">
          {tr("可提现", "Withdrawable")} {bal.data ? yuan(bal.data.withdrawable_cents) : "—"}
        </div>
      </button>
      <button type="button" className={cell} onClick={() => onTab("security")}>
        <div className="text-caption font-medium text-muted-foreground">{tr("登录方式", "Sign-in")}</div>
        <div className="truncate text-body font-semibold">
          {passkeys ? tr(`${passkeys} 个通行密钥`, `${passkeys} passkeys`) : tr("仅密码", "Password only")}
        </div>
        <div className="truncate text-footnote text-muted-foreground">
          {pk.data && !pk.data.password_login
            ? tr("只允许通行密钥", "Passkeys only")
            : passkeys
              ? tr("密码 + 通行密钥", "Password + passkeys")
              : tr("可以添加通行密钥", "No passkey yet")}
        </div>
      </button>
    </div>
  );
}

function Overview({
  user: u,
  live,
  isAdmin,
  ownerOnly,
  onPlan,
  onUnban,
  onResetTraffic,
  onRenew,
  onCancel,
  onResetSub,
}: {
  user: Detail;
  live: boolean;
  isAdmin: boolean;
  ownerOnly: boolean;
  onPlan: () => void;
  onUnban?: () => void;
  onResetTraffic: () => void;
  onRenew: () => void;
  onCancel: () => void;
  onResetSub: () => void;
}) {
  const tr = useTr();
  const s = u.subscription;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
      <div className="grid content-start gap-4">
        {u.erased && (
          <Banner tone="info" title={tr("已注销", "Erased")}>
            {tr(
              "该账户已注销（有财务记录，匿名化保留）。不能再修改。",
              "This account was erased (kept anonymized for its finance records); it cannot be changed.",
            )}
          </Banner>
        )}
        {ownerOnly && (
          <Banner tone="info">
            {tr(
              "这是另一位管理员的账户：只有所有者可以修改它。",
              "Another admin's account: only the owner can change it.",
            )}
          </Banner>
        )}
        {u.ban && (
          <Banner
            tone="danger"
            icon={<Ban />}
            title={tr("已封禁", "Banned")}
            action={
              onUnban && (
                <Button size="sm" variant="outline" onClick={onUnban}>
                  {tr("解除封禁", "Unban")}
                </Button>
              )
            }
          >
            <span className="break-words">{u.ban.reason}</span> · {dateTime(u.ban.banned_at)} ·{" "}
            {u.ban.banned_by_email ?? tr("系统", "system")}
            {tr("。订阅已停止服务，用户登录后看到这条原因。", ". The subscription stops; the user sees this reason.")}
          </Banner>
        )}
        {s?.status === "over_quota" && !u.ban && (
          <Banner
            tone="warning"
            title={tr("流量已用尽", "Traffic used up")}
            action={
              live && (
                <Button size="sm" variant="outline" onClick={onResetTraffic}>
                  {tr("重置流量", "Reset traffic")}
                </Button>
              )
            }
          >
            {tr(
              "节点已停止为该用户转发；重置后立即恢复。",
              "Nodes stopped serving this user; a reset brings it back now.",
            )}
          </Banner>
        )}
        {!isAdmin && !u.erased && (
          <SubscriptionCard user={u} live={live} onPlan={onPlan} onRenew={onRenew} onCancel={onCancel} />
        )}
        {isAdmin && (
          <Card className="px-4 py-4">
            <div className="text-headline font-semibold">{tr("没有套餐", "No plan")}</div>
            <div className="text-footnote text-muted-foreground">
              {tr("管理员账户不能持有套餐。", "Admin accounts cannot hold a plan.")}
            </div>
          </Card>
        )}
        {!isAdmin && <PlanHistoryList id={u.id} />}
      </div>
      <div className="grid content-start gap-4">
        {!isAdmin && live && <SubLinkCard id={u.id} onReset={onResetSub} />}
        <AccountCard user={u} />
      </div>
    </div>
  );
}

function SubscriptionCard({
  user,
  live,
  onPlan,
  onRenew,
  onCancel,
}: {
  user: Detail;
  live: boolean;
  onPlan: () => void;
  onRenew: () => void;
  onCancel: () => void;
}) {
  const tr = useTr();
  const s = user.subscription;
  if (!s)
    return (
      <Card className="flex flex-wrap items-center gap-3 px-4 py-4">
        <div className="min-w-0 flex-1">
          <div className="text-headline font-semibold">{tr("没有套餐", "No plan")}</div>
          <div className="text-footnote text-muted-foreground">
            {tr("分配后从现在开始计算周期，流量从 0 开始。", "Assigned plans start now with zero traffic.")}
          </div>
        </div>
        {live && (
          <Button size="sm" variant="primary" icon={Plus} onClick={onPlan}>
            {tr("分配套餐", "Assign a plan")}
          </Button>
        )}
      </Card>
    );
  const p = pct(s.traffic_used_bytes, s.traffic_total_bytes);
  const onetime = s.period === "onetime";
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 bg-[linear-gradient(135deg,var(--primary-soft),transparent_70%)] px-4 pt-3.5 pb-3">
        <div className="min-w-0 flex-1">
          <div className="text-footnote font-medium text-muted-foreground">
            {tr("当前订阅", "Current subscription")}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-title3 font-semibold">
            <span className="break-all">{s.plan_name}</span>
            <span className="text-body font-normal text-muted-foreground">
              {periodLabel(s.period, tr, s.period_days)}
            </span>
            {s.status !== "active" && (
              <Badge tone={s.status === "banned" ? "danger" : "warning"} dot>
                {subStatusText(s.status, tr)}
              </Badge>
            )}
          </div>
        </div>
        {live && (
          <Button size="sm" variant="outline" icon={Layers} onClick={onPlan}>
            {tr("更换套餐", "Change plan")}
          </Button>
        )}
      </div>
      <div className="px-4 pt-1 pb-3">
        {s.traffic_total_bytes !== null && (
          <div className="mb-3 flex items-center gap-3">
            <Meter value={p} tone={usageTone(p)} className="h-2 flex-1" label={tr("流量用量", "Traffic used")} />
            <span className="tnum text-footnote font-semibold">
              {bytes(s.traffic_used_bytes)} / {bytes(s.traffic_total_bytes)} · {p.toFixed(1)}%
            </span>
          </div>
        )}
        <KV
          cols={3}
          items={[
            { k: tr("开始", "Started"), v: dateTime(s.starts_at) },
            {
              k: tr("到期", "Expires"),
              v: s.expires_at ? (
                <>
                  {dateOnly(s.expires_at)} · <RelDays date={s.expires_at} />
                </>
              ) : (
                tr("不过期", "never")
              ),
            },
            { k: tr("重置方式", "Reset"), v: resetLabel(s.reset_period, tr) },
            { k: tr("上次重置", "Last reset"), v: s.last_reset_at ? dateTime(s.last_reset_at) : "—" },
            {
              k: tr("下次重置", "Next reset"),
              v: s.next_reset_at ? (
                <>
                  {dateTime(s.next_reset_at).slice(5)} · <RelDays date={s.next_reset_at} />
                </>
              ) : (
                "—"
              ),
            },
            {
              k: tr("限速", "Speed limit"),
              v: s.speed_limit_mbps ? `${s.speed_limit_mbps} Mbps` : tr("不限速", "unlimited"),
            },
            ...(s.traffic_total_bytes === null
              ? [{ k: tr("已用流量", "Used"), v: `${bytes(s.traffic_used_bytes)} / ${tr("不限", "unlimited")}` }]
              : []),
          ]}
        />
      </div>
      {live && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-separator px-3 py-2">
          <Button size="sm" variant="ghost" icon={CalendarPlus} disabled={onetime} onClick={onRenew}>
            {tr("续期一个周期", "Renew one term")}
          </Button>
          {!onetime && s.expires_at && <ExtendPopover id={user.id} sub={s} />}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={CircleOff} className="text-destructive" onClick={onCancel}>
            {tr("取消套餐", "Cancel plan")}
          </Button>
        </div>
      )}
      {onetime && (
        <p className="border-t border-separator px-4 py-2 text-footnote text-faint">
          {tr(
            "一次性套餐没有周期，不能续期或延长天数；可以重置流量或更换套餐。",
            "One-time plans have no term: they cannot be renewed or extended; reset the traffic or change the plan.",
          )}
        </p>
      )}
    </Card>
  );
}

/** Masked until 显示 (each read is audited); then the link, a copy button and a QR code. */
function SubLinkCard({ id, onReset }: { id: string; onReset: () => void }) {
  const tr = useTr();
  const [shown, setShown] = useState(false);
  const q = useQuery({
    queryKey: ["user", id, "sub-link"],
    queryFn: () =>
      get<{ sub_token: string | null; sub_url: string | null; legacy: boolean }>(`/users/${id}/subscription`),
    enabled: shown,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const url = q.data?.sub_url ? absoluteUrl(q.data.sub_url) : null;
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <QrIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="flex-1 text-headline font-semibold">{tr("订阅链接", "Subscription link")}</h3>
        <Button size="sm" variant="ghost" icon={RotateCcw} className="text-destructive" onClick={onReset}>
          {tr("重置", "Reset")}
        </Button>
      </div>
      {!shown ? (
        <>
          <div className="flex items-center gap-3 rounded-lg bg-window px-3 py-3 ring-1 ring-border ring-inset">
            <span className="min-w-0 flex-1 truncate font-mono text-footnote text-faint">••••••••••••••••••••</span>
            <Button size="sm" variant="soft" icon={Eye} onClick={() => setShown(true)}>
              {tr("显示", "Show")}
            </Button>
          </div>
          <p className="mt-2 text-footnote text-faint">
            {tr("查看链接与二维码会写入审计日志。", "Viewing the link and QR code is audited.")}
          </p>
        </>
      ) : q.isPending ? (
        <div className="grid gap-3" aria-busy="true">
          <div className="h-8 animate-pulse rounded-md bg-secondary" />
          <div className="flex items-center gap-3">
            <div className="size-28 animate-pulse rounded-lg bg-secondary" />
            <span className="text-footnote text-muted-foreground">{tr("正在读取订阅链接…", "Reading the link…")}</span>
          </div>
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : q.data?.legacy ? (
        <Banner tone="warning">
          {tr(
            "该链接是旧版本生成的，只存了哈希，无法显示；重置订阅后可查看新链接。",
            "This link predates storable links; reset the subscription to get a showable one.",
          )}
        </Banner>
      ) : url ? (
        <div className="grid gap-3">
          <CopyText block value={url} label={tr("订阅链接", "Subscription link")} />
          <div className="flex items-center gap-3">
            <QrCode text={url} label={tr("订阅链接二维码", "Subscription QR code")} />
            <p className="text-footnote text-muted-foreground">
              {tr("用客户端扫码导入。此次查看已写入审计日志。", "Scan it with a client. This view was audited.")}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-body text-muted-foreground">
          {tr("该账户还没有订阅链接。", "This account has no subscription link yet.")}
        </p>
      )}
    </Card>
  );
}

function AccountCard({ user: u }: { user: Detail }) {
  const tr = useTr();
  return (
    <Card className="p-4">
      <h3 className="mb-3 text-headline font-semibold">{tr("账户", "Account")}</h3>
      <KV
        cols={2}
        items={[
          {
            k: tr("注册方式", "Signed up with"),
            v: u.signup_method === "passkey" ? tr("通行密钥", "Passkey") : tr("邮箱 + 密码", "Email + password"),
          },
          {
            k: tr("邮箱", "Email"),
            v: u.email_pending ? (
              <Badge tone="warning">{tr("待绑定邮箱", "Email pending")}</Badge>
            ) : u.email_verified ? (
              <Badge tone="success">
                <MailCheck aria-hidden="true" />
                {tr("已验证", "Verified")}
              </Badge>
            ) : (
              <Badge tone="warning">{tr("未验证", "Unverified")}</Badge>
            ),
          },
          {
            k: tr("邀请人", "Invited by"),
            v: u.inviter_email ? (
              <button
                type="button"
                className="break-all text-left text-primary hover:underline"
                onClick={() => navigate(`/users?q=${encodeURIComponent(u.inviter_email ?? "")}`)}
              >
                {u.inviter_email}
              </button>
            ) : (
              "—"
            ),
            span: 2,
          },
          { k: tr("用户 ID", "User ID"), v: <CopyText value={u.id} />, span: 2 },
          { k: tr("余额", "Balance"), v: yuan(u.balance_cents) },
          {
            k: tr("最后使用", "Last used"),
            v: u.last_traffic_day ?? tr("从未", "never"),
          },
        ]}
      />
    </Card>
  );
}

function PlanHistoryList({ id }: { id: string }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["user", id, "plans"],
    queryFn: () => get<{ active: PlanHistory | null; history: PlanHistory[] }>(`/users/${id}/plan`),
  });
  const rows = q.data?.history ?? [];
  return (
    <section>
      <SectionTitle count={q.data ? rows.length : undefined}>{tr("套餐历史", "Plan history")}</SectionTitle>
      <Card className="p-4">
        {q.isPending ? (
          <SkeletonRows rows={3} />
        ) : q.error ? (
          <ErrorState
            title={tr("套餐历史加载失败", "The plan history could not be loaded")}
            error={q.error}
            onRetry={() => void q.refetch()}
            compact
          />
        ) : rows.length === 0 ? (
          <p className="text-body text-muted-foreground">{tr("还没有分配过套餐。", "No plan yet.")}</p>
        ) : (
          <Timeline
            items={rows.map((h) => {
              const [label, tone] = planStatus(h.status, tr);
              return {
                title: `${h.plan_name} · ${label}`,
                time: dateOnly(h.starts_at),
                body: `${periodLabel(h.period, tr, h.period_days)} · ${dateOnly(h.starts_at)} → ${
                  h.ended_at || h.expires_at ? dateOnly(h.ended_at ?? h.expires_at) : tr("不过期", "never")
                }`,
                tone,
              };
            })}
          />
        )}
      </Card>
    </section>
  );
}

const LEDGER_PAGE = 20;

function BalanceLedger({ id, onAdjust }: { id: string; onAdjust?: () => void }) {
  const tr = useTr();
  const q = useInfiniteQuery({
    queryKey: ["balance", id, "ledger"],
    queryFn: ({ pageParam }) =>
      get<Ledger>(`/users/${id}/balance?limit=${LEDGER_PAGE}${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.entries.length === LEDGER_PAGE ? last.entries[last.entries.length - 1].id : undefined,
  });
  const first = q.data?.pages[0];
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <section className="min-w-0">
      <SectionTitle
        action={
          onAdjust && (
            <Button size="sm" variant="soft" icon={Wallet} onClick={onAdjust}>
              {tr("人工调整余额", "Adjust balance")}
            </Button>
          )
        }
      >
        {tr("余额明细", "Balance ledger")}
      </SectionTitle>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <SkeletonRows rows={4} />
        ) : q.error && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
        ) : (
          <>
            <div className="flex items-baseline gap-6 border-b border-separator px-4 py-3">
              <div>
                <div className="text-footnote text-muted-foreground">{tr("当前余额", "Balance")}</div>
                <div className="tnum text-title3 font-semibold">{yuan(first?.balance_cents ?? 0)}</div>
              </div>
              <div>
                <div className="text-footnote text-muted-foreground">{tr("其中可提现", "Withdrawable")}</div>
                <div className="tnum text-headline font-semibold">{yuan(first?.withdrawable_cents ?? 0)}</div>
              </div>
            </div>
            {entries.length === 0 ? (
              <p className="px-4 py-4 text-body text-muted-foreground">
                {tr("暂无余额变动。", "No balance movements yet.")}
              </p>
            ) : (
              <ul className="divide-y divide-separator">
                {entries.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-body">
                        <span className="font-medium">{ledgerKind(e.kind, tr)}</span>
                        {e.actor_label && <span className="truncate text-footnote text-faint">· {e.actor_label}</span>}
                      </div>
                      <div className="truncate text-footnote text-faint">
                        {dateTime(e.created_at)}
                        {(e.reason ?? e.out_trade_no) && <> · {e.reason ?? e.out_trade_no}</>}
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className={cn(
                          "tnum text-body font-semibold",
                          e.amount_cents > 0 ? "text-success" : "text-foreground",
                        )}
                      >
                        {e.amount_cents > 0 ? "+" : ""}
                        {yuan(e.amount_cents)}
                      </div>
                      <div className="tnum text-caption text-faint">
                        {tr(`余额 ${yuan(e.balance_after_cents)}`, `→ ${yuan(e.balance_after_cents)}`)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {q.error && (
              <p role="alert" className="px-4 pt-2 text-footnote text-destructive">
                {tr("加载更多失败，可以重试。", "Loading more failed; try again.")}
              </p>
            )}
            {entries.length > 0 && (
              <div className="border-t border-separator px-4 py-2 text-center">
                {q.hasNextPage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={ChevronDown}
                    loading={q.isFetchingNextPage}
                    onClick={() => void q.fetchNextPage()}
                  >
                    {tr("加载更多", "Load more")}
                  </Button>
                ) : (
                  <span className="text-footnote text-faint">
                    {tr(`已全部加载 · 共 ${entries.length} 条`, `All loaded · ${entries.length}`)}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </Card>
    </section>
  );
}

function UserOrders({ email }: { email: string | null }) {
  const tr = useTr();
  const q = useOrders(email ?? undefined);
  const rows = q.data ?? [];
  return (
    <section className="min-w-0">
      <SectionTitle
        count={q.data ? (rows.length >= 20 ? "20+" : rows.length) : undefined}
        action={
          email &&
          rows.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={ChevronRight}
              onClick={() => navigate(`/orders?email=${encodeURIComponent(email)}`)}
            >
              {tr("在订单页查看", "Open in orders")}
            </Button>
          )
        }
      >
        {tr("订单", "Orders")}
      </SectionTitle>
      <Card className="overflow-hidden">
        {!email ? (
          <p className="px-4 py-4 text-body text-muted-foreground">{tr("该用户还没有订单。", "No orders yet.")}</p>
        ) : q.isPending ? (
          <SkeletonRows rows={3} />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
        ) : rows.length === 0 ? (
          <p className="px-4 py-4 text-body text-muted-foreground">{tr("该用户还没有订单。", "No orders yet.")}</p>
        ) : (
          <ul className="divide-y divide-separator">
            {rows.map((o) => {
              const [label, tone] = orderStatus(o, tr);
              const struck = !!o.refunded_at || o.status === "cancelled" || o.status === "expired";
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/orders?open=${o.id}`)}
                    className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body font-medium">
                        {o.plan_name} · {periodLabel(o.period, tr, o.period_days)}
                      </div>
                      <div className="tnum truncate text-footnote text-faint">
                        {o.out_trade_no} · {dateTime(o.created_at)}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span
                        className={cn(
                          "tnum text-body font-semibold",
                          struck && "text-muted-foreground line-through decoration-faint",
                        )}
                      >
                        {yuan(o.amount_cents)}
                      </span>
                      <Badge tone={tone}>{label}</Badge>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}

function Security({
  user: u,
  live,
  ownerOnly,
  roleLock,
  onRole,
  onPassword,
  onVerify,
  onKick,
  onTransfer,
  onDelete,
  canDelete,
}: {
  user: Detail;
  live: boolean;
  ownerOnly: boolean;
  roleLock: string | null;
  onRole: (r: "user" | "admin") => void;
  onPassword: () => void;
  onVerify: () => void;
  onKick: () => void;
  onTransfer: () => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const tr = useTr();
  const me = useMe();
  const isAdmin = u.role === "admin";
  const locked = !live || ownerOnly;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid content-start gap-5">
        <Group
          title={tr("角色", "Role")}
          footer={
            roleLock ??
            tr(
              "管理员可以进入后台；只有所有者能任免管理员、修改支付设置。",
              "Admins use the console; only the owner appoints admins and changes payment settings.",
            )
          }
        >
          <Row
            label={tr("账户角色", "Role")}
            description={u.is_owner ? tr("所有者（唯一）", "Owner (the one)") : undefined}
          >
            <Segmented
              label={tr("账户角色", "Role")}
              value={isAdmin ? "admin" : "user"}
              onChange={(v) => !roleLock && !locked && v !== (isAdmin ? "admin" : "user") && onRole(v)}
              options={[
                { value: "user", label: tr("普通用户", "User") },
                { value: "admin", label: tr("管理员", "Admin") },
              ]}
            />
          </Row>
        </Group>
        <Group title={tr("登录与会话", "Sign-in and sessions")}>
          <Row
            label={tr("密码", "Password")}
            description={tr(
              "设置新密码后，该账户的全部会话立即结束",
              "A new password ends every session of the account",
            )}
          >
            <Button size="sm" variant="secondary" icon={KeyRound} disabled={locked} onClick={onPassword}>
              {tr("设置新密码", "Set a new password")}
            </Button>
          </Row>
          <Row
            label={tr("邮箱验证", "Email verification")}
            description={
              u.email_pending
                ? tr("用户还没有绑定邮箱", "The user has not bound an address yet")
                : u.email_verified
                  ? tr("已验证", "Verified")
                  : tr(
                      "用户还没有点击验证邮件；确认邮箱属实后可手动标记",
                      "Not verified yet; mark it when you know it is theirs",
                    )
            }
          >
            {u.email_verified ? (
              <Badge tone="success">
                <MailCheck aria-hidden="true" />
                {tr("已验证", "Verified")}
              </Badge>
            ) : (
              !u.email_pending && (
                <Button size="sm" variant="secondary" icon={MailCheck} disabled={locked} onClick={onVerify}>
                  {tr("标记已验证", "Mark verified")}
                </Button>
              )
            )}
          </Row>
          <Row
            label={tr("结束全部会话", "End every session")}
            description={tr("踢下线：所有设备需要重新登录", "Sign out everywhere: every device must sign in again")}
          >
            <Button size="sm" variant="secondary" icon={LogOut} disabled={locked} onClick={onKick}>
              {tr("踢下线", "Sign out")}
            </Button>
          </Row>
        </Group>
      </div>
      <div className="grid content-start gap-5">
        <LoginMethods id={u.id} disabled={locked} />
        <section className="grid gap-1.5">
          <h3 className="px-1 text-footnote font-semibold text-destructive">{tr("危险操作", "Danger zone")}</h3>
          <div className="divide-y divide-separator overflow-hidden rounded-xl bg-card shadow-[0_0_0_0.5px_var(--destructive)]">
            <Row
              label={tr("转让所有者", "Transfer ownership")}
              description={
                isAdmin
                  ? me.is_owner
                    ? tr("把所有者身份转给此管理员，你将变为管理员", "Make this admin the owner; you become an admin")
                    : tr("只有所有者可以操作", "Owner only")
                  : tr("目标必须是启用中的管理员", "The target must be an enabled admin")
              }
            >
              <Button
                size="sm"
                variant="secondary"
                icon={Crown}
                disabled={!isAdmin || !me.is_owner || u.is_owner || u.id === me.id || !u.enabled || !live}
                onClick={onTransfer}
              >
                {tr("转让", "Transfer")}
              </Button>
            </Row>
            <Row
              label={tr("删除账户", "Delete account")}
              description={tr(
                "先查看影响（余额、待审提现、未完成订单），再输入邮箱确认",
                "Shows the impact first (balance, pending withdrawals, open orders), then asks for the address",
              )}
            >
              <Button
                size="sm"
                variant="destructive-soft"
                icon={Trash2}
                disabled={!canDelete || !live}
                onClick={onDelete}
              >
                {tr("删除…", "Delete…")}
              </Button>
            </Row>
          </div>
        </section>
      </div>
    </div>
  );
}

function LoginMethods({ id, disabled }: { id: string; disabled: boolean }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const q = useQuery({ queryKey: ["user", id, "passkeys"], queryFn: () => get<Passkeys>(`/users/${id}/passkeys`) });
  const d = q.data;
  const n = d?.passkeys.length ?? 0;
  const reset = async () => {
    if (!d) return;
    const ok = await confirm({
      title: tr("重置登录方式？", "Reset sign-in methods?"),
      description: tr(
        "恢复密码登录（丢失设备时使用）。写入审计。",
        "Turns password sign-in back on (lost device). Audited.",
      ),
      impacts: [
        { label: tr("删除的通行密钥", "Passkeys deleted"), value: tr(`${n} 个`, String(n)) },
        { label: tr("密码登录", "Password sign-in"), value: tr("恢复", "back on") },
      ],
      tone: n > 0 ? "danger" : "warning",
      typeToConfirm: n > 0 ? tr(`删除 ${n} 个通行密钥`, `delete ${n} passkeys`) : undefined,
      confirmLabel:
        n > 0 ? tr(`删除 ${n} 个通行密钥`, `Delete ${n} passkeys`) : tr("恢复密码登录", "Restore password sign-in"),
      action: () => post(`/users/${id}/login-method/reset`),
    });
    if (ok) toast({ tone: "success", title: tr("登录方式已重置", "Sign-in methods reset") });
  };
  return (
    <Group
      title={tr("通行密钥", "Passkeys")}
      footer={
        d &&
        (d.password_login
          ? tr("用户可以用密码或下面任一通行密钥登录。", "The user signs in with the password or any passkey below.")
          : tr(
              "此账户只允许通行密钥登录。用户丢失设备时，用「重置登录方式」恢复密码登录。",
              "Passkeys only. When the user loses the device, “Reset sign-in methods” brings the password back.",
            )) +
          (d.password_login_disabled
            ? tr("账户已选择只用通行密钥登录。", " The account chose passkey-only sign-in.")
            : "") +
          (d.available
            ? ""
            : tr("（通行密钥需要 https 主域名，当前不可用）", " (passkeys need an https main domain; unavailable)"))
      }
    >
      {q.isPending ? (
        <SkeletonRows rows={2} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : (
        d && (
          <>
            {d.passkeys.map((k) => (
              <Row
                key={k.id}
                icon={<Fingerprint className="size-4 text-muted-foreground" aria-hidden="true" />}
                label={k.name}
                description={`${tr(`添加于 ${dateOnly(k.created_at)}`, `Added ${dateOnly(k.created_at)}`)} · ${
                  k.last_used_at
                    ? tr(`最近使用 ${dateTime(k.last_used_at)}`, `last used ${dateTime(k.last_used_at)}`)
                    : tr("最近使用 从未", "never used")
                }`}
              />
            ))}
            {n === 0 && (
              <Row
                label={tr("没有通行密钥", "No passkeys")}
                description={tr("用户登录后可在账户页添加", "The user can add one on their account page")}
              />
            )}
            <Row
              label={tr("重置登录方式", "Reset sign-in methods")}
              description={tr(
                `删除全部 ${n} 个通行密钥，恢复密码登录`,
                `Deletes all ${n} passkeys and turns password sign-in back on`,
              )}
            >
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || (n === 0 && !d.password_login_disabled)}
                onClick={() => void reset()}
              >
                {tr("重置", "Reset")}
              </Button>
            </Row>
          </>
        )
      )}
    </Group>
  );
}

type DayRow = { day: string; up_bytes: number; down_bytes: number; billed_bytes: number };
// USR-23: per entrance, so a direct 1x and a relay 10x of one node are never summed.
type EntranceRow = {
  entrance_id: string;
  node_id: string;
  entrance: string | null;
  kind: "direct" | "relay" | null;
  node: string | null;
  rate_now: number | null;
  up_bytes: number;
  down_bytes: number;
  billed_bytes: number;
};

export function UserTraffic({ id }: { id: string }) {
  const tr = useTr();
  const [range, setRange] = useState<"7" | "30">("30");
  const to = siteToday();
  const from = daysBefore(to, Number(range) - 1);
  const days = useQuery({
    queryKey: ["traffic", "user", id, range],
    queryFn: () => get<{ rows: DayRow[] }>(`/users/${id}/traffic?from=${from}&to=${to}&group=day`),
  });
  const entrances = useQuery({
    queryKey: ["traffic", "user-entrances", id, range],
    queryFn: () => get<{ rows: EntranceRow[] }>(`/users/${id}/traffic?from=${from}&to=${to}&group=entrance`),
  });
  const all: string[] = [];
  for (let i = Number(range) - 1; i >= 0; i--) all.push(daysBefore(to, i));
  const by = new Map((days.data?.rows ?? []).map((r) => [r.day, r]));
  const rows = [...(entrances.data?.rows ?? [])].sort((a, b) => b.billed_bytes - a.billed_bytes);
  const totalRaw = Math.max(
    1,
    rows.reduce((s, r) => s + r.up_bytes + r.down_bytes, 0),
  );
  const title = tr("每日流量（站点时区）", "Daily traffic (site days)");
  const kindBadge = (k: EntranceRow["kind"]) =>
    k && (
      <Badge tone={k === "relay" ? "warning" : "primary"}>
        {k === "relay" ? tr("中转", "relay") : tr("直连", "direct")}
      </Badge>
    );
  const name = (n: EntranceRow) =>
    `${n.node ?? tr("已删除的节点", "Deleted node")} · ${n.entrance ?? tr("已删除的入口", "Deleted entrance")}`;
  return (
    <div className="grid gap-4">
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h3 className="text-headline font-semibold">{tr("流量明细", "Traffic history")}</h3>
          <Segmented
            size="sm"
            className="ml-auto"
            label={tr("时间范围", "Range")}
            value={range}
            onChange={setRange}
            options={[
              { value: "7", label: tr("7 天", "7d") },
              { value: "30", label: tr("30 天", "30d") },
            ]}
          />
        </div>
        {days.isPending ? (
          <SkeletonRows rows={4} />
        ) : days.error ? (
          <ErrorState error={days.error} onRetry={() => void days.refetch()} compact />
        ) : (
          <div role="img" aria-label={title}>
            <LineChart
              title={title}
              legend="total"
              times={all}
              axisLabel={(d) => d.slice(5)}
              format={bytes}
              series={[
                { label: tr("下载", "Down"), values: all.map((d) => by.get(d)?.down_bytes ?? 0), slot: 1, area: true },
                { label: tr("上传", "Up"), values: all.map((d) => by.get(d)?.up_bytes ?? 0), slot: 2 },
                {
                  label: tr("计费（× 倍率）", "Billed (× rate)"),
                  values: all.map((d) => by.get(d)?.billed_bytes ?? 0),
                  slot: 3,
                  dashed: true,
                },
              ]}
            />
          </div>
        )}
      </Card>
      <section>
        <SectionTitle
          count={entrances.data ? rows.length : undefined}
          action={
            <span className="text-footnote text-faint">
              {tr(`近 ${range} 天 · 按入口`, `Last ${range} days · by entrance`)}
            </span>
          }
        >
          {tr("按入口", "By entrance")}
        </SectionTitle>
        <Card className="overflow-hidden">
          {entrances.isPending ? (
            <SkeletonRows rows={3} />
          ) : entrances.error ? (
            <ErrorState error={entrances.error} onRetry={() => void entrances.refetch()} compact />
          ) : rows.length === 0 ? (
            <p className="px-4 py-4 text-body text-muted-foreground">
              {tr("这段时间没有流量。", "No traffic in this range.")}
            </p>
          ) : (
            <ul className="divide-y divide-separator" aria-label={tr("按入口", "By entrance")}>
              {rows.map((n) => {
                const raw = n.up_bytes + n.down_bytes;
                const share = (raw / totalRaw) * 100;
                return (
                  <li
                    key={n.entrance_id}
                    className="grid gap-1 px-4 py-2.5 md:grid-cols-[minmax(0,1fr)_auto_7rem_7rem_7rem_9rem] md:items-center md:gap-3"
                  >
                    <span className="min-w-0 truncate text-body font-medium">{name(n)}</span>
                    <span className="flex items-center gap-2 text-footnote text-muted-foreground">
                      {kindBadge(n.kind)}
                      {n.rate_now !== null && (
                        <span className="tnum">
                          {tr("当前", "now")} {rateText(Math.round(n.rate_now * 1000))}
                        </span>
                      )}
                    </span>
                    <span className="tnum text-footnote text-muted-foreground md:text-right">
                      {tr("原始", "raw")} {bytes(raw)}
                    </span>
                    <span className="tnum text-body font-semibold md:text-right">
                      <span className="text-footnote font-normal text-muted-foreground">{tr("计费", "billed")} </span>
                      {bytes(n.billed_bytes)}
                    </span>
                    <span className="flex items-center gap-2 md:col-span-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                        <span
                          className={cn("block h-full rounded-full", n.kind === "relay" ? "bg-chart-2" : "bg-chart-1")}
                          style={{ width: `${share}%` }}
                        />
                      </span>
                      <span className="tnum w-10 text-right text-footnote text-muted-foreground">
                        {share.toFixed(0)}%
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <p className="mt-2 px-1 text-footnote text-faint">
          {tr(
            "计费流量 = 原始流量 × 入口倍率（按结算时的倍率）；倍率在节点页的入口设置里修改，只影响之后的流量。",
            "Billed = raw × the entrance rate at settlement; rates are set on the node's entrances and only affect later traffic.",
          )}
        </p>
      </section>
    </div>
  );
}
