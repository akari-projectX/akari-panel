// One account (USR-05…23): a wide dialog with tabs — 概览 (the current
// subscription and its plan actions, account summary, plan history),
// 流量 (daily chart + per entrance), 订单 (orders, balance ledger,
// balance adjustment), 账户与安全 (subscription link, reset, sign-in
// methods) — and a footer with the frequent actions (ban/unban, reset
// traffic, renew). Rarer account actions (password, sessions, role, owner
// transfer, delete) are in the header's 更多操作 menu. Every write goes
// through the API client, so the list and this detail refetch on their
// own (data.ts). Also the new-user dialog and the balance adjustment
// (reused by the finance page).
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { del, get, patch, post, put } from "../../shared/api";
import {
  ago,
  bytes,
  dateOnly,
  dateTime,
  daysBefore,
  parseYuan,
  pct,
  rateText,
  siteToday,
  yuan,
} from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { TrendChart, timeLabels } from "../../shared/ui/charts";
import { QrCode } from "../../shared/ui/qr-code";
import { CopyButton, Mono, SectionTitle, useErrText } from "../kit";
import { useAction } from "../data";
import { navigate } from "../router";
import { resetLabel, periodLabel } from "../terms";
import { useCrumb, useMe } from "../session";
import type { PlanView } from "../types";
import { EMPTY_TERM, TermFields, termBody, type TermForm } from "./term-fields";
import { userStatus, type UserRow } from "./users";
import {
  Ban,
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Layers,
  LinkIcon,
  LogOut,
  Mail,
  RefreshCw,
  Star,
  Trash2,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented, Select } from "../../shared/ui/form";
import { Callout, KV } from "../../shared/ui/layout";
import { MenuItem, RowMenu } from "../../shared/ui/menu";
import { Meter, usageTone } from "../../shared/ui/meter";
import { ErrorState, LoadingBlock } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";
import { useToast } from "../../shared/ui/toast";

type Subscription = {
  user_plan_id: string;
  plan_id: string;
  plan_name: string;
  period: string;
  period_days: number | null;
  starts_at: string;
  expires_at: string | null;
  traffic_used_bytes: number;
  traffic_total_bytes: number | null;
  reset_period: string;
  last_reset_at: string | null;
  next_reset_at: string | null;
  timezone: string;
  speed_limit_mbps: number | null;
  status: "active" | "expired" | "over_quota" | "banned";
};
type BanInfo = {
  reason: string | null;
  banned_at: string | null;
  banned_by_id: string | null;
  banned_by_email: string | null;
};
type Detail = UserRow & { subscription: Subscription | null; ban: BanInfo | null };
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

type Tab = "overview" | "traffic" | "orders" | "account";
type Sub = null | "plan" | "renew" | "ban" | "password" | "balance" | "sub";

/** Absolute subscription URL (the server may answer a root-relative one). */
export function absoluteUrl(u: string): string {
  return u.startsWith("/") ? `${location.origin}${u}` : u;
}

export function subStatusText(s: Subscription["status"], tr: Tr): string {
  return {
    active: tr("正常", "Active"),
    expired: tr("已到期", "Expired"),
    over_quota: tr("流量用尽（已停用）", "Over quota (suspended)"),
    banned: tr("已封禁", "Banned"),
  }[s];
}

function planStatus(s: string, tr: Tr): [string, Tone] {
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

function ledgerKind(k: string, tr: Tr): string {
  switch (k) {
    case "commission":
      return tr("邀请返利", "Commission");
    case "admin_adjust":
      return tr("人工调整", "Admin adjustment");
    case "order_payment":
      return tr("订单支付", "Order payment");
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
      return o.fulfilled_at ? [tr("已付款", "Paid"), "success"] : [tr("已付款未开通", "Paid, not fulfilled"), "danger"];
    case "expired":
      return [tr("已过期", "Expired"), "neutral"];
    case "cancelled":
      return [tr("已取消", "Cancelled"), "neutral"];
    default:
      return [tr("未知", "Unknown"), "neutral"];
  }
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
  const isAdmin = u?.role === "admin";
  const otherAdmin = isAdmin && u?.id !== me.id;
  const ownerOnly = !!otherAdmin && !me.is_owner;
  const live = !!u && !u.erased;
  const tabs: { value: Tab; label: string }[] = [
    { value: "overview", label: tr("概览", "Overview") },
    ...(isAdmin
      ? []
      : ([
          { value: "traffic", label: tr("流量", "Traffic") },
          { value: "orders", label: tr("订单", "Orders") },
        ] as const)),
    { value: "account", label: tr("账户与安全", "Account & security") },
  ];
  const tab: Tab = tabs.some((t) => t.value === tabParam) ? (tabParam as Tab) : "overview";

  /** Confirm, run, toast; the list and this detail refetch by themselves. */
  const act = async (opts: Parameters<typeof confirm>[0], fn: () => Promise<unknown>, ok: string) => {
    if (await confirm({ ...opts, action: fn })) toast({ tone: "success", title: ok });
  };

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
    const lines: string[] = [];
    if (im.balance_cents > 0)
      lines.push(
        tr(
          `余额 ${yuan(im.balance_cents)}（可提现 ${yuan(im.withdrawable_cents)}）`,
          `Balance ${yuan(im.balance_cents)} (${yuan(im.withdrawable_cents)} withdrawable)`,
        ),
      );
    if (im.pending_withdrawals > 0)
      lines.push(
        tr(
          `${im.pending_withdrawals} 笔待审提现（${yuan(im.pending_withdrawal_cents)}）`,
          `${im.pending_withdrawals} pending withdrawals (${yuan(im.pending_withdrawal_cents)})`,
        ),
      );
    if (im.pending_orders > 0)
      lines.push(tr(`${im.pending_orders} 笔待付款订单`, `${im.pending_orders} pending orders`));
    if (im.unfulfilled_orders > 0)
      lines.push(
        tr(`${im.unfulfilled_orders} 笔已付款未开通的订单`, `${im.unfulfilled_orders} paid, unfulfilled orders`),
      );
    if (im.plan)
      lines.push(
        tr(
          `生效中的套餐「${im.plan.name}」（到期 ${dateOnly(im.plan.expires_at)}）`,
          `Active plan "${im.plan.name}" (expires ${dateOnly(im.plan.expires_at)})`,
        ),
      );
    const ok = await confirm({
      title: tr(`删除账户 ${u.email}？`, `Delete ${u.email}?`),
      impact: im.anonymized
        ? tr(
            "该账户有财务记录：将匿名化保留，个人数据删除",
            "Has finance records: kept anonymized, personal data deleted",
          )
        : tr("账户与其全部数据将被永久删除", "The account and all its data are deleted for good"),
      details: lines.length ? (
        <ul className="list-disc space-y-1 pl-5 text-body text-muted-foreground">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : undefined,
      typeToConfirm: u.email,
      confirmLabel: tr("永久删除", "Delete"),
      action: () => del(`/users/${id}?confirm=true`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("账户已删除", "Account deleted") });
      onClose();
    }
  };

  const status = u ? userStatus(u, tr) : null;
  const current = u?.subscription ?? null;
  const canBan = live && !u.is_owner && u.id !== me.id;

  const footer = live ? (
    <>
      {canBan &&
        (u.ban ? (
          <Button
            className="mr-auto"
            icon={Ban}
            disabled={ownerOnly}
            onClick={() =>
              void act(
                {
                  title: tr("解除封禁？", "Lift the ban?"),
                  description: tr(
                    "账户恢复正常：可以登录、订阅恢复可用（套餐仍需有效）。写入审计。",
                    "The account works again: sign-in and the subscription (with a valid plan). Audited.",
                  ),
                  tone: "default",
                },
                () => post(`/users/${id}/unban`),
                tr("已解除封禁", "Ban lifted"),
              )
            }
          >
            {tr("解除封禁", "Unban")}
          </Button>
        ) : (
          <Button
            className="mr-auto"
            variant="destructive-soft"
            icon={Ban}
            disabled={ownerOnly}
            onClick={() => setSub("ban")}
          >
            {tr("封禁", "Ban")}
          </Button>
        ))}
      {!isAdmin &&
        (current ? (
          <>
            <Button
              variant="outline"
              icon={RefreshCw}
              onClick={() =>
                void act(
                  {
                    title: tr("重置套餐流量？", "Reset the plan traffic?"),
                    description: tr(
                      "已用流量清零（重置周期不变）；因超流量停用的账户会自动恢复，封禁的不会。写入审计。",
                      "Used traffic goes to zero (schedule unchanged); an account suspended for its quota is re-enabled, a banned one is not. Audited.",
                    ),
                    impact: tr(
                      `已用 ${bytes(current.traffic_used_bytes)} 将清零`,
                      `${bytes(current.traffic_used_bytes)} used goes to zero`,
                    ),
                    tone: "warning",
                  },
                  () => post(`/users/${id}/plan/reset-traffic`, { confirm: true }),
                  tr("流量已重置", "Traffic reset"),
                )
              }
            >
              {tr("重置流量", "Reset traffic")}
            </Button>
            <Button variant="primary" icon={CalendarPlus} onClick={() => setSub("renew")}>
              {tr("续期", "Renew")}
            </Button>
          </>
        ) : (
          <Button variant="primary" icon={Layers} onClick={() => setSub("plan")}>
            {tr("分配套餐", "Assign a plan")}
          </Button>
        ))}
    </>
  ) : undefined;

  return (
    <>
      <Dialog
        open
        size="xl"
        dirty={false}
        onClose={onClose}
        title={u?.email ?? tr("用户", "User")}
        description={
          u &&
          status && (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <Badge tone={status.tone} dot>
                {status.label}
              </Badge>
              {u.is_owner && <Badge tone="primary">{tr("所有者", "Owner")}</Badge>}
              {isAdmin && <Badge tone="outline">{tr("管理员", "Admin")}</Badge>}
              <span>
                {tr(`注册于 ${dateOnly(u.created_at)}`, `Signed up ${dateOnly(u.created_at)}`)} ·{" "}
                {u.last_login_at
                  ? tr(`最后登录 ${ago(u.last_login_at, lang)}`, `Last sign-in ${ago(u.last_login_at, lang)}`)
                  : tr("从未登录", "Never signed in")}
              </span>
            </span>
          )
        }
        actions={
          live && (
            <RowMenu label={tr("更多操作", "More actions")}>
              {(close) => (
                <>
                  <MenuItem icon={KeyRound} disabled={ownerOnly} onClick={() => (close(), setSub("password"))}>
                    {tr("设置新密码", "Set a new password")}
                  </MenuItem>
                  <MenuItem
                    icon={LogOut}
                    disabled={ownerOnly}
                    onClick={() => {
                      close();
                      void act(
                        {
                          title: tr("踢下线？", "Sign out everywhere?"),
                          description: tr("该账户的全部会话立即失效。", "Every session of the account ends now."),
                          tone: "warning",
                        },
                        () => post(`/users/${id}/revoke-sessions`),
                        tr("已踢下线", "Signed out everywhere"),
                      );
                    }}
                  >
                    {tr("踢下线（结束全部会话）", "Sign out everywhere")}
                  </MenuItem>
                  {!u.email_verified && !u.email_pending && (
                    <MenuItem
                      icon={Mail}
                      disabled={ownerOnly}
                      onClick={() => {
                        close();
                        void act(
                          {
                            title: tr("标记邮箱已验证？", "Mark the address verified?"),
                            description: tr(
                              "该地址之后会收到系统邮件，也可用于找回密码。",
                              "The address then receives mail and can reset the password.",
                            ),
                            tone: "default",
                          },
                          () => post(`/users/${id}/email/verify`),
                          tr("已标记为已验证", "Marked verified"),
                        );
                      }}
                    >
                      {tr("标记邮箱已验证", "Mark email verified")}
                    </MenuItem>
                  )}
                  {me.is_owner && u.id !== me.id && (
                    <MenuItem
                      icon={Users}
                      onClick={() => {
                        close();
                        const to = isAdmin ? "user" : "admin";
                        void act(
                          {
                            title: isAdmin
                              ? tr("降级为普通用户？", "Demote to user?")
                              : tr("设为管理员？", "Make admin?"),
                            description: isAdmin
                              ? tr("该账户将失去后台访问。", "The account loses console access.")
                              : tr(
                                  "管理员不是代理用户：不会下发到节点，订阅失效。只有所有者可以设管理员。",
                                  "Admins are not proxy users (no nodes, no subscription). Only the owner makes admins.",
                                ),
                            tone: "warning",
                          },
                          () => patch(`/users/${id}`, { role: to }),
                          tr("角色已修改", "Role changed"),
                        );
                      }}
                    >
                      {isAdmin ? tr("降级为普通用户", "Demote to user") : tr("设为管理员", "Make admin")}
                    </MenuItem>
                  )}
                  {me.is_owner && isAdmin && u.enabled && u.id !== me.id && (
                    <MenuItem
                      icon={Star}
                      onClick={() => {
                        close();
                        void act(
                          {
                            title: tr(`把所有者转让给 ${u.email}？`, `Transfer the ownership to ${u.email}?`),
                            description: tr(
                              "转让后你将成为普通管理员，不能再管理其他管理员、后台前缀与支付密钥。",
                              "You become an ordinary admin: no more managing admins, the admin prefix or payment keys.",
                            ),
                            typeToConfirm: u.email,
                          },
                          () => post(`/users/${id}/owner`, { confirm: true }),
                          tr("所有者已转让", "Ownership transferred"),
                        );
                      }}
                    >
                      {tr("转让所有者", "Transfer ownership")}
                    </MenuItem>
                  )}
                  {!u.is_owner && u.id !== me.id && (
                    <MenuItem
                      icon={Trash2}
                      danger
                      disabled={ownerOnly || deleting}
                      onClick={() => (close(), void deleteUser())}
                    >
                      {tr("删除账户", "Delete account")}
                    </MenuItem>
                  )}
                </>
              )}
            </RowMenu>
          )
        }
        tabs={u && <Tabs label={tr("用户详情", "User detail")} value={tab} onChange={(t) => onTab(t)} tabs={tabs} />}
        footer={footer}
      >
        {q.isPending ? (
          <LoadingBlock rows={8} />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          u && (
            <div className="space-y-4">
              {u.erased && (
                <Callout tone="info">
                  {tr(
                    "该账户已注销（有财务记录，匿名化保留）。不能再修改。",
                    "This account was erased (kept anonymized for its finance records); it cannot be changed.",
                  )}
                </Callout>
              )}
              {ownerOnly && (
                <Callout tone="info">
                  {tr(
                    "这是另一位管理员的账户：只有所有者可以修改它。",
                    "Another admin's account: only the owner can change it.",
                  )}
                </Callout>
              )}
              {u.ban && (
                <Callout tone="danger" title={tr("已封禁", "Banned")}>
                  <p className="break-words">{u.ban.reason}</p>
                  <p className="mt-1 text-footnote text-muted-foreground">
                    {dateTime(u.ban.banned_at)} · {u.ban.banned_by_email ?? tr("系统", "system")}
                  </p>
                </Callout>
              )}
              {tab === "overview" && (
                <Overview user={u} onAssign={() => setSub("plan")} live={live} isAdmin={isAdmin} />
              )}
              {tab === "traffic" && <UserTraffic id={id} />}
              {tab === "orders" && (
                <>
                  <UserOrders email={u.email} />
                  <BalanceLedger id={id} onAdjust={live ? () => setSub("balance") : undefined} />
                </>
              )}
              {tab === "account" && (
                <AccountTab
                  user={u}
                  isAdmin={isAdmin}
                  live={live}
                  ownerOnly={ownerOnly}
                  onSubLink={() => setSub("sub")}
                  onReset={() =>
                    void act(
                      {
                        title: tr("重置订阅？", "Reset the subscription?"),
                        description: tr(
                          "生成新的订阅链接，并更换该用户在每个入口上的凭据。",
                          "A new subscription link and new credentials on every entrance.",
                        ),
                        impact: tr(
                          "旧链接和所有已导入的客户端立即失效，在线连接全部断开；用户需要重新导入。",
                          "The old link and every imported client stop working now and live connections are cut; the user must import again.",
                        ),
                        typeToConfirm: u.email,
                        confirmLabel: tr("重置订阅", "Reset subscription"),
                      },
                      () => post(`/users/${id}/sub-token`),
                      tr("订阅已重置", "Subscription reset"),
                    )
                  }
                />
              )}
            </div>
          )
        )}
      </Dialog>
      {u && sub === "plan" && (
        <AssignPlanDialog id={id} plans={plans} current={u.subscription} onClose={() => setSub(null)} />
      )}
      {u && sub === "renew" && u.subscription && (
        <RenewDialog id={id} sub={u.subscription} onClose={() => setSub(null)} />
      )}
      {u && sub === "ban" && <BanDialog id={id} email={u.email} onClose={() => setSub(null)} />}
      {u && sub === "password" && <PasswordDialog id={id} onClose={() => setSub(null)} />}
      {u && sub === "balance" && (
        <AdjustBalanceDialog id={id} email={u.email} balanceCents={u.balance_cents} onClose={() => setSub(null)} />
      )}
      {u && sub === "sub" && <SubLinkDialog id={id} onClose={() => setSub(null)} />}
    </>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-caption font-medium text-muted-foreground">{label}</div>
      <div className="tnum mt-0.5 text-body font-semibold break-words">{children}</div>
    </div>
  );
}

function Overview({
  user: u,
  onAssign,
  live,
  isAdmin,
}: {
  user: Detail;
  onAssign: () => void;
  live: boolean;
  isAdmin: boolean;
}) {
  const tr = useTr();
  const lang = useLang();
  return (
    <>
      {!isAdmin && !u.erased && <SubscriptionCard user={u} onAssign={onAssign} live={live} />}
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        <section>
          <SectionTitle>{tr("账户", "Account")}</SectionTitle>
          <dl className="divide-y divide-separator text-body">
            {(
              [
                [tr("余额", "Balance"), <span className="tnum">{yuan(u.balance_cents)}</span>],
                [
                  tr("邮箱", "Email"),
                  u.email_pending ? (
                    <Badge tone="warning">{tr("待绑定邮箱", "Email pending")}</Badge>
                  ) : u.email_verified ? (
                    <Badge tone="success">{tr("已验证", "Verified")}</Badge>
                  ) : (
                    <Badge tone="warning">{tr("未验证", "Unverified")}</Badge>
                  ),
                ],
                [
                  tr("注册方式", "Signed up with"),
                  u.signup_method === "passkey" ? tr("通行密钥", "Passkey") : tr("邮箱 + 密码", "Email + password"),
                ],
                [tr("通行密钥", "Passkeys"), tr(`${u.passkeys} 个`, String(u.passkeys))],
                [
                  tr("最后登录", "Last sign-in"),
                  u.last_login_at ? (
                    <span title={dateTime(u.last_login_at)}>{ago(u.last_login_at, lang)}</span>
                  ) : (
                    tr("从未", "never")
                  ),
                ],
              ] as [string, ReactNode][]
            ).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 py-2">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="min-w-0 text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        {!isAdmin && <PlanHistoryList id={u.id} />}
      </div>
    </>
  );
}

function SubscriptionCard({ user, onAssign, live }: { user: Detail; onAssign: () => void; live: boolean }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const s = user.subscription;
  const id = user.id;
  if (!s)
    return (
      <section className="rounded-xl bg-window p-4 ring-1 ring-border ring-inset">
        <div className="text-footnote font-medium text-muted-foreground">{tr("当前订阅", "Current subscription")}</div>
        <p className="mt-1 text-body text-muted-foreground">
          {tr("没有生效的套餐。", "No active plan.")}{" "}
          {live && (
            <Button size="sm" variant="link" onClick={onAssign}>
              {tr("现在分配一个", "Assign one now")}
            </Button>
          )}
        </p>
      </section>
    );
  const p = pct(s.traffic_used_bytes, s.traffic_total_bytes);
  const left = s.expires_at ? Math.ceil((Date.parse(s.expires_at) - Date.now()) / 86400_000) : null;
  const cancel = async () => {
    const ok = await confirm({
      title: tr("取消套餐？", "Cancel the plan?"),
      description: tr(
        "订阅立即结束，不会自动退款；需要退款请到订单页对相应订单操作。写入审计。",
        "The subscription ends now with no automatic refund (refund the order on the orders page). Audited.",
      ),
      impact: tr(
        `「${s.plan_name}」立即结束${left !== null && left > 0 ? `（还剩 ${left} 天）` : ""}：用户失去全部入口，在线连接断开`,
        `"${s.plan_name}" ends now${left !== null && left > 0 ? ` (${left} days left)` : ""}: the user loses every entrance and is disconnected`,
      ),
      typeToConfirm: user.email,
      confirmLabel: tr("取消套餐", "Cancel plan"),
      action: () => del(`/users/${id}/plan`),
    });
    if (ok) toast({ tone: "success", title: tr("套餐已取消", "Plan cancelled") });
  };
  return (
    <section className="rounded-xl bg-[linear-gradient(135deg,var(--primary-soft),transparent_70%)] p-4 ring-1 ring-border ring-inset">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-footnote font-medium text-muted-foreground">
            {tr("当前订阅", "Current subscription")}
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-title3 font-semibold break-all">{s.plan_name}</span>
            <span className="text-body text-muted-foreground">
              {periodLabel(s.period, tr, s.period_days)} · {resetLabel(s.reset_period, tr)}
            </span>
            <Badge tone={s.status === "active" ? "success" : "danger"} dot>
              {subStatusText(s.status, tr)}
            </Badge>
          </div>
        </div>
        {live && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" icon={Layers} onClick={onAssign}>
              {tr("更换套餐", "Change plan")}
            </Button>
            <Button size="sm" variant="destructive-soft" onClick={() => void cancel()}>
              {tr("取消套餐", "Cancel plan")}
            </Button>
          </div>
        )}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Stat label={tr("已用 / 总流量", "Used / total")}>
          {bytes(s.traffic_used_bytes)}
          <span className="font-normal text-muted-foreground">
            {" "}
            / {s.traffic_total_bytes === null ? tr("不限", "unlimited") : bytes(s.traffic_total_bytes)}
          </span>
        </Stat>
        <Stat label={tr("到期", "Expires")}>{s.expires_at ? dateTime(s.expires_at) : tr("永久", "never")}</Stat>
        <Stat label={tr("下次重置", "Next reset")}>{s.next_reset_at ? dateTime(s.next_reset_at) : "—"}</Stat>
        <Stat label={tr("限速", "Speed limit")}>
          {s.speed_limit_mbps ? `${s.speed_limit_mbps} Mbps` : tr("不限", "unlimited")}
        </Stat>
      </div>
      {s.traffic_total_bytes !== null && (
        <div className="mt-3 flex items-center gap-3">
          <Meter value={p} tone={usageTone(p)} className="h-2 flex-1" label={tr("流量用量", "Traffic used")} />
          <span className="tnum text-footnote font-semibold">{p.toFixed(1)}%</span>
        </div>
      )}
      <KV
        className="mt-3 text-footnote"
        items={[
          [tr("开始", "Started"), dateTime(s.starts_at)],
          [tr("上次重置", "Last reset"), dateTime(s.last_reset_at)],
          [tr("重置时区", "Reset time zone"), s.timezone],
        ]}
      />
    </section>
  );
}

function AssignPlanDialog({
  id,
  plans,
  current,
  onClose,
}: {
  id: string;
  plans: PlanView[];
  current: Subscription | null;
  onClose: () => void;
}) {
  const tr = useTr();
  const [form, setForm] = useState<TermForm>({ ...EMPTY_TERM, planId: current?.plan_id ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [run, busy] = useAction();
  const submit = async () => {
    const b = termBody(form, tr);
    if (typeof b === "string") return setError(b);
    setError(null);
    const r = await run(() => put(`/users/${id}/plan`, b), { ok: tr("套餐已分配", "Plan assigned") });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      icon={Layers}
      onClose={onClose}
      title={current ? tr("更换套餐", "Change plan") : tr("分配套餐", "Assign a plan")}
      description={
        current
          ? tr(
              `替换当前的「${current.plan_name}」：从现在开始计算，已用流量清零。`,
              `Replaces "${current.plan_name}": starts now with zero usage.`,
            )
          : tr("从现在开始计算，到期时间由时长决定。", "Starts now; the expiry follows from the term.")
      }
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("确认分配", "Assign")}
          </Button>
        </>
      }
    >
      <TermFields form={form} onChange={setForm} plans={plans} />
      {error && (
        <p role="alert" className="mt-3 text-footnote text-destructive">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function RenewDialog({ id, sub, onClose }: { id: string; sub: Subscription; onClose: () => void }) {
  const tr = useTr();
  const onetime = sub.period === "onetime";
  const [mode, setMode] = useState<"term" | "extend">("term");
  const [form, setForm] = useState<TermForm>({
    ...EMPTY_TERM,
    period: sub.period,
    days: sub.period_days ? String(sub.period_days) : "",
  });
  const [days, setDays] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const [run, busy] = useAction();
  const submit = async () => {
    let body: Record<string, unknown>;
    if (mode === "extend") {
      const n = Number(days.trim());
      if (!/^\d{1,4}$/.test(days.trim()) || n < 1 || n > 3650)
        return setError(tr("天数须为 1–3650 的整数", "Days must be a whole number 1–3650"));
      body = { extend_days: n };
    } else {
      const b = termBody(form, tr, false);
      if (typeof b === "string") return setError(b);
      body = { period: b.period, ...(b.days ? { days: b.days } : {}) };
    }
    setError(null);
    const r = await run(() => patch(`/users/${id}/plan`, body), { ok: tr("已续期", "Renewed") });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      icon={CalendarPlus}
      onClose={onClose}
      title={tr("续期 / 延长", "Renew / extend")}
      description={tr(
        `从到期时间（已到期则从现在）起算。当前到期：${sub.expires_at ? dateTime(sub.expires_at) : "永久"}`,
        `From the expiry (or now when expired). Expires: ${sub.expires_at ? dateTime(sub.expires_at) : "never"}`,
      )}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("确认", "Confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!onetime && (
          <Segmented
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
            options={[
              { value: "term", label: tr("续期一个时长", "One more term") },
              { value: "extend", label: tr("延长 N 天", "Extend N days") },
            ]}
          />
        )}
        {mode === "term" ? (
          <>
            <TermFields form={form} onChange={setForm} plans={[]} withPlan={false} />
            {error && (
              <p role="alert" className="text-footnote text-destructive">
                {error}
              </p>
            )}
          </>
        ) : (
          <Field label={tr("延长天数", "Days")} error={error ?? undefined}>
            <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} data-autofocus />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function BanDialog({ id, email, onClose }: { id: string; email: string; onClose: () => void }) {
  const tr = useTr();
  const [note, setNote] = useState("");
  const [kind, setKind] = useState("abuse");
  const [run, busy] = useAction();
  const presets: Record<string, string> = {
    abuse: tr("违反服务条款（滥用）", "Terms of service violation (abuse)"),
    share: tr("账号共享 / 转售", "Account sharing / resale"),
    payment: tr("支付争议", "Payment dispute"),
    other: "",
  };
  const text = [presets[kind], note.trim()].filter(Boolean).join(tr("：", ": "));
  const needNote = kind === "other" && !note.trim();
  const submit = async () => {
    if (!text) return;
    const r = await run(() => post(`/users/${id}/ban`, { reason: text }), {
      ok: tr("已封禁，已踢下线", "Banned and signed out"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      tone="danger"
      icon={Ban}
      onClose={onClose}
      title={tr(`封禁 ${email}`, `Ban ${email}`)}
      description={tr(
        "立即踢下线，所有节点断开该用户，订阅返回 404；门户里只能看到封禁原因和工单。写入审计。",
        "Signed out at once, dropped from every node, the subscription answers 404; the portal shows only the reason and tickets. Audited.",
      )}
      onSubmit={submit}
      footer={
        <>
          {needNote && (
            <span className="mr-auto text-footnote text-muted-foreground">
              {tr("选「其他」时要先写说明", "“Other” needs a note first")}
            </span>
          )}
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="destructive" loading={busy} disabled={!text}>
            {tr("封禁", "Ban")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={tr("原因", "Reason")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="abuse">{presets.abuse}</option>
            <option value="share">{presets.share}</option>
            <option value="payment">{presets.payment}</option>
            <option value="other">{tr("其他（只写说明）", "Other (note only)")}</option>
          </Select>
        </Field>
        <Field
          label={tr("补充说明（会显示给用户）", "Note (shown to the user)")}
          error={
            needNote
              ? tr("选择「其他」时必须填写说明，用户会看到这段文字。", "“Other” needs a note; the user sees it.")
              : undefined
          }
          hint={tr(`用户将看到：${text || "—"}`, `The user sees: ${text || "—"}`)}
        >
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} />
        </Field>
      </div>
    </Dialog>
  );
}

function PasswordDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const [pw, setPw] = useState("");
  const [touched, setTouched] = useState(false);
  const [run, busy] = useAction();
  const bad = pw.length < 8 ? tr("至少 8 位", "At least 8 characters") : null;
  const submit = async () => {
    setTouched(true);
    if (bad) return;
    const r = await run(() => patch(`/users/${id}`, { password: pw }), {
      ok: tr("密码已修改，该账户的会话已结束", "Password set; the account's sessions ended"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="sm"
      icon={KeyRound}
      onClose={onClose}
      title={tr("设置新密码", "Set a new password")}
      description={tr("保存后该账户的全部会话结束。", "Every session of the account ends.")}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <Field label={tr("新密码（至少 8 位）", "New password (8+ characters)")} error={touched ? bad : undefined}>
        <Input
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onBlur={() => pw && setTouched(true)}
          data-autofocus
        />
      </Field>
    </Dialog>
  );
}

/**
 * Credit or debit a balance with a reason; previews the resulting balance.
 * `balanceCents` when the caller knows it, else it is read.
 */
export function AdjustBalanceDialog({
  id,
  email,
  balanceCents,
  onClose,
  onDone,
}: {
  id: string;
  email: string;
  balanceCents?: number;
  onClose: () => void;
  onDone?: () => void;
}) {
  const tr = useTr();
  const [dir, setDir] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState({ amount: false, reason: false });
  const [run, busy] = useAction();
  const current = useQuery({
    queryKey: ["balance", id, "summary"],
    queryFn: () => get<Ledger>(`/users/${id}/balance?limit=1`),
    enabled: balanceCents === undefined,
  });
  const before = balanceCents ?? current.data?.balance_cents;
  const c = amount.trim() ? parseYuan(amount) : null;
  const signed = c === null ? null : dir === "credit" ? c : -c;
  const after = before !== undefined && signed !== null ? before + signed : null;
  const amountError = !amount.trim()
    ? tr("请填写金额", "Enter an amount")
    : c === null || c <= 0
      ? tr("金额无效（元，最多两位小数）", "Invalid amount (yuan, 2 decimals)")
      : after !== null && after < 0
        ? tr(`扣减后余额不能为负（当前 ${yuan(before)}）`, `The balance cannot go below 0 (now ${yuan(before)})`)
        : null;
  const reasonError = reason.trim() ? null : tr("请填写原因", "Enter a reason");
  const submit = async () => {
    setTouched({ amount: true, reason: true });
    if (amountError || reasonError || signed === null) return;
    const r = await run(() => post(`/users/${id}/balance`, { amount_cents: signed, reason: reason.trim() }), {
      ok: tr("余额已调整", "Balance adjusted"),
    });
    if (r !== undefined) {
      onDone?.();
      onClose();
    }
  };
  return (
    <Dialog
      open
      icon={Wallet}
      onClose={onClose}
      title={tr("调整余额", "Adjust balance")}
      description={email}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("确认调整", "Adjust")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Segmented
          value={dir}
          onChange={setDir}
          options={[
            { value: "credit", label: tr("增加", "Credit") },
            { value: "debit", label: tr("扣减", "Debit") },
          ]}
        />
        <Field label={tr("金额（元）", "Amount (yuan)")} error={touched.amount ? amountError : undefined}>
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={() => amount && setTouched((t) => ({ ...t, amount: true }))}
            data-autofocus
          />
        </Field>
        <Field
          label={tr("原因（必填，写入审计）", "Reason (required, audited)")}
          error={touched.reason ? reasonError : undefined}
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
        <div className="flex items-center justify-between rounded-lg bg-window px-3 py-2 text-body ring-1 ring-border ring-inset">
          <span className="text-muted-foreground">{tr("调整后余额", "Balance after")}</span>
          <span className="tnum font-medium">
            {before === undefined ? (
              current.error ? (
                tr("读取失败", "Unavailable")
              ) : (
                "…"
              )
            ) : (
              <>
                {yuan(before)}
                {after !== null && !amountError && (
                  <>
                    {" → "}
                    <span className={signed !== null && signed < 0 ? "text-destructive" : "text-success"}>
                      {yuan(after)}
                    </span>
                  </>
                )}
              </>
            )}
          </span>
        </div>
      </div>
    </Dialog>
  );
}

function SubLinkDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["user", id, "sub-link"],
    queryFn: () =>
      get<{ sub_token: string | null; sub_url: string | null; legacy: boolean }>(`/users/${id}/subscription`),
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const url = q.data?.sub_url ? absoluteUrl(q.data.sub_url) : null;
  return (
    <Dialog
      open
      icon={LinkIcon}
      onClose={onClose}
      title={tr("订阅链接", "Subscription link")}
      description={tr("每次读取都写入审计。", "Every read is audited.")}
      footer={<Button onClick={onClose}>{tr("关闭", "Close")}</Button>}
    >
      {q.isPending ? (
        <LoadingBlock rows={4} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : q.data?.legacy ? (
        <Callout tone="warning">
          {tr(
            "该链接是旧版本生成的，只存了哈希，无法显示；重置订阅后可查看新链接。",
            "This link predates storable links; reset the subscription to get a showable one.",
          )}
        </Callout>
      ) : url ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <Mono>{url}</Mono>
            <CopyButton text={url} />
          </div>
          <div className="flex justify-center">
            <QrCode text={url} label={tr("订阅链接二维码", "Subscription QR code")} />
          </div>
        </div>
      ) : (
        <p className="text-body text-muted-foreground">
          {tr("该账户还没有订阅链接。", "This account has no subscription link yet.")}
        </p>
      )}
    </Dialog>
  );
}

function AccountTab({
  user: u,
  isAdmin,
  live,
  ownerOnly,
  onSubLink,
  onReset,
}: {
  user: Detail;
  isAdmin: boolean;
  live: boolean;
  ownerOnly: boolean;
  onSubLink: () => void;
  onReset: () => void;
}) {
  const tr = useTr();
  return (
    <>
      <section>
        <SectionTitle>{tr("账户", "Account")}</SectionTitle>
        <KV
          items={[
            [
              tr("邮箱", "Email"),
              <span key="e" className="break-all">
                {u.email_pending ? tr("（待绑定）", "(pending)") : u.email}
                {!u.email_verified && !u.email_pending && tr("（未验证）", " (unverified)")}
              </span>,
            ],
            [
              tr("用户 ID", "User ID"),
              <span key="i" className="inline-flex flex-wrap items-center gap-1">
                <Mono>{u.id}</Mono>
                <CopyButton text={u.id} />
              </span>,
            ],
            [tr("角色", "Role"), u.role === "admin" ? tr("管理员", "Admin") : tr("用户", "User")],
            [tr("注册时间", "Signed up"), dateTime(u.created_at)],
            [tr("最后登录", "Last sign-in"), u.last_login_at ? dateTime(u.last_login_at) : tr("从未", "never")],
          ]}
        />
      </section>
      {!isAdmin && live && (
        <section>
          <SectionTitle>{tr("订阅", "Subscription")}</SectionTitle>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={LinkIcon} onClick={onSubLink}>
              {tr("订阅链接", "Subscription link")}
            </Button>
            <Button size="sm" variant="destructive-soft" icon={RefreshCw} onClick={onReset}>
              {tr("重置订阅", "Reset subscription")}
            </Button>
          </div>
        </section>
      )}
      <LoginMethods id={u.id} disabled={ownerOnly || !live} />
    </>
  );
}

function LoginMethods({ id, disabled }: { id: string; disabled: boolean }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const q = useQuery({ queryKey: ["user", id, "passkeys"], queryFn: () => get<Passkeys>(`/users/${id}/passkeys`) });
  const d = q.data;
  return (
    <section>
      <SectionTitle
        actions={
          d &&
          !disabled &&
          (d.passkeys.length > 0 || d.password_login_disabled) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const ok = await confirm({
                  title: tr("重置登录方式？", "Reset sign-in methods?"),
                  description: tr(
                    "恢复密码登录（丢失设备时使用）。写入审计。",
                    "Turns password sign-in back on (lost device). Audited.",
                  ),
                  impact:
                    d.passkeys.length > 0
                      ? tr(
                          `将删除该账户的全部 ${d.passkeys.length} 个通行密钥`,
                          `All ${d.passkeys.length} passkeys of the account are deleted`,
                        )
                      : tr(
                          "没有通行密钥会被删除，只恢复密码登录",
                          "No passkey is deleted; password sign-in comes back",
                        ),
                  tone: d.passkeys.length > 0 ? "danger" : "warning",
                  action: () => post(`/users/${id}/login-method/reset`),
                });
                if (ok) toast({ tone: "success", title: tr("登录方式已重置", "Sign-in methods reset") });
              }}
            >
              {tr("重置登录方式", "Reset sign-in")}
            </Button>
          )
        }
      >
        {tr("登录方式", "Sign-in methods")}
      </SectionTitle>
      {q.isPending ? (
        <LoadingBlock rows={2} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : (
        d && (
          <div className="text-body">
            <p className="text-muted-foreground">
              {d.password_login
                ? tr("可以用密码登录。", "Password sign-in works.")
                : tr("仅通行密钥登录。", "Passkey sign-in only.")}{" "}
              {d.password_login_disabled &&
                tr("账户已选择只用通行密钥登录。", "The account chose passkey-only sign-in.")}{" "}
              {!d.available &&
                tr("（通行密钥需要 https 主域名，当前不可用）", "(passkeys need an https main domain; unavailable)")}
            </p>
            {d.passkeys.length > 0 ? (
              <ul className="mt-2 divide-y divide-separator rounded-lg ring-1 ring-border ring-inset">
                {d.passkeys.map((p) => (
                  <li key={p.id} className="flex flex-wrap justify-between gap-x-3 px-3 py-2">
                    <span className="min-w-0 break-all">{p.name}</span>
                    <span className="text-footnote text-muted-foreground">
                      {tr("最后使用", "last used")} {p.last_used_at ? dateTime(p.last_used_at) : tr("从未", "never")}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-footnote text-faint">{tr("没有通行密钥。", "No passkeys.")}</p>
            )}
          </div>
        )
      )}
    </section>
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
      <SectionTitle>{tr("套餐历史", "Plan history")}</SectionTitle>
      {q.isPending ? (
        <LoadingBlock rows={3} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : rows.length === 0 ? (
        <p className="py-2 text-body text-muted-foreground">{tr("还没有分配过套餐。", "No plan yet.")}</p>
      ) : (
        <ul className="divide-y divide-separator text-body">
          {rows.map((h) => {
            const [label, tone] = planStatus(h.status, tr);
            return (
              <li key={h.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
                <span className="min-w-0 font-medium break-all">{h.plan_name}</span>
                <Badge tone={tone}>{label}</Badge>
                <span className="w-full text-footnote text-muted-foreground">
                  {periodLabel(h.period, tr, h.period_days)} · {dateOnly(h.starts_at)} →{" "}
                  {h.ended_at || h.expires_at ? dateOnly(h.ended_at ?? h.expires_at) : tr("永久", "never")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
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
    <section>
      <SectionTitle
        actions={
          onAdjust && (
            <Button size="sm" variant="outline" icon={Wallet} onClick={onAdjust}>
              {tr("调整余额", "Adjust balance")}
            </Button>
          )
        }
      >
        {tr("余额明细", "Balance ledger")}
        {first &&
          tr(
            ` · 余额 ${yuan(first.balance_cents)}（可提现 ${yuan(first.withdrawable_cents)}）`,
            ` · ${yuan(first.balance_cents)} (${yuan(first.withdrawable_cents)} withdrawable)`,
          )}
      </SectionTitle>
      {q.isPending ? (
        <LoadingBlock rows={3} />
      ) : q.error && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : entries.length === 0 ? (
        <p className="py-2 text-body text-muted-foreground">{tr("暂无余额变动。", "No balance movements yet.")}</p>
      ) : (
        <>
          <ul className="divide-y divide-separator rounded-lg text-body ring-1 ring-border ring-inset">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
                <span className={`tnum font-medium ${e.amount_cents < 0 ? "text-destructive" : "text-success"}`}>
                  {e.amount_cents > 0 ? "+" : ""}
                  {yuan(e.amount_cents)}
                </span>
                <Badge>{ledgerKind(e.kind, tr)}</Badge>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {e.reason ?? e.out_trade_no ?? ""}
                </span>
                <span className="tnum text-footnote text-muted-foreground">
                  {tr(`余额 ${yuan(e.balance_after_cents)}`, `→ ${yuan(e.balance_after_cents)}`)} ·{" "}
                  {dateTime(e.created_at)}
                </span>
              </li>
            ))}
          </ul>
          {q.error && (
            <p role="alert" className="mt-2 text-footnote text-destructive">
              {tr("加载更多失败，可以重试。", "Loading more failed; try again.")}
            </p>
          )}
          {q.hasNextPage && (
            <Button
              className="mt-2"
              size="sm"
              variant="ghost"
              icon={ChevronDown}
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {tr("加载更多", "Load more")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function UserOrders({ email }: { email: string }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["orders", "user", email],
    queryFn: () => get<UserOrder[]>(`/orders?email=${encodeURIComponent(email)}&limit=20`),
  });
  const rows = q.data ?? [];
  return (
    <section>
      <SectionTitle
        actions={
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
        {tr("订单（最近 20 笔）", "Orders (latest 20)")}
      </SectionTitle>
      {q.isPending ? (
        <LoadingBlock rows={3} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : rows.length === 0 ? (
        <p className="py-2 text-body text-muted-foreground">{tr("该用户还没有订单。", "No orders yet.")}</p>
      ) : (
        <ul className="divide-y divide-separator rounded-lg text-body ring-1 ring-border ring-inset">
          {rows.map((o) => {
            const [label, tone] = orderStatus(o, tr);
            return (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/orders?open=${o.id}`)}
                  className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <span className="min-w-0 font-medium break-all">{o.plan_name}</span>
                  <span className="text-footnote text-muted-foreground">
                    {periodLabel(o.period, tr, o.period_days)}
                  </span>
                  <Badge tone={tone} dot>
                    {label}
                  </Badge>
                  <span className="tnum ml-auto font-medium">{yuan(o.amount_cents)}</span>
                  <span className="tnum w-full text-footnote text-muted-foreground">
                    {o.out_trade_no} · {dateTime(o.created_at)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
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
  const [range, setRange] = useState<"7" | "30" | "90">("30");
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
  const rows = entrances.data?.rows ?? [];
  const top = Math.max(1, ...rows.map((r) => r.billed_bytes));
  return (
    <section>
      <SectionTitle
        actions={
          <Segmented
            size="sm"
            label={tr("时间范围", "Range")}
            value={range}
            onChange={setRange}
            options={[
              { value: "7", label: tr("7 天", "7d") },
              { value: "30", label: tr("30 天", "30d") },
              { value: "90", label: tr("90 天", "90d") },
            ]}
          />
        }
      >
        {tr("流量明细", "Traffic history")}
      </SectionTitle>
      {days.isPending ? (
        <LoadingBlock rows={5} />
      ) : days.error ? (
        <ErrorState error={days.error} onRetry={() => void days.refetch()} compact />
      ) : (
        <TrendChart
          title={tr("每日流量（站点时区）", "Daily traffic (site days)")}
          times={all.map((d) => `${d}T12:00:00Z`)}
          {...timeLabels(all.map((d) => `${d}T12:00:00Z`))}
          format={bytes}
          series={[
            { label: tr("下载", "Down"), values: all.map((d) => by.get(d)?.down_bytes ?? 0), slot: 1 },
            { label: tr("上传", "Up"), values: all.map((d) => by.get(d)?.up_bytes ?? 0), slot: 3 },
            { label: tr("计费", "Billed"), values: all.map((d) => by.get(d)?.billed_bytes ?? 0), slot: 4 },
          ]}
        />
      )}
      <SectionTitle>{tr("按入口", "By entrance")}</SectionTitle>
      {entrances.isPending ? (
        <LoadingBlock rows={3} />
      ) : entrances.error ? (
        <ErrorState error={entrances.error} onRetry={() => void entrances.refetch()} compact />
      ) : rows.length === 0 ? (
        <p className="py-2 text-body text-muted-foreground">{tr("这段时间没有流量。", "No traffic in this range.")}</p>
      ) : (
        <ul className="grid gap-2.5 text-body" aria-label={tr("按入口", "By entrance")}>
          {rows.map((n) => (
            <li key={n.entrance_id} className="grid gap-1">
              <div className="flex flex-wrap justify-between gap-x-3">
                <span className="min-w-0">
                  {n.node ?? tr("已删除的节点", "Deleted node")} ·{" "}
                  {n.entrance ?? tr("已删除的入口", "Deleted entrance")}
                  {n.kind && (
                    <span className="ml-1.5 text-footnote text-muted-foreground">
                      {n.kind === "relay" ? tr("中转", "relay") : tr("直连", "direct")}
                      {n.rate_now !== null && ` · ${tr("当前", "now")} ${rateText(Math.round(n.rate_now * 1000))}`}
                    </span>
                  )}
                </span>
                <span className="tnum text-footnote text-muted-foreground">
                  {tr("原始", "raw")} {bytes(n.up_bytes + n.down_bytes)} · {tr("计费", "billed")}{" "}
                  {bytes(n.billed_bytes)}
                </span>
              </div>
              <Meter value={(n.billed_bytes / top) * 100} tone="primary" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CreateUserDialog({ plans, onClose }: { plans: PlanView[]; onClose: () => void }) {
  const tr = useTr();
  const me = useMe();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [term, setTerm] = useState<TermForm>(EMPTY_TERM);
  const [touched, setTouched] = useState({ email: false, password: false, submit: false });
  const [created, setCreated] = useState<{ email: string; sub_url: string | null } | null>(null);
  const [run, busy] = useAction();
  const emailError = !email.trim()
    ? tr("请填写邮箱", "Enter the email")
    : !EMAIL_RE.test(email.trim())
      ? tr("邮箱格式不正确，例如 name@example.com", "Not an email address, e.g. name@example.com")
      : null;
  const passwordError =
    password.length < 8
      ? tr("至少 8 位", "At least 8 characters")
      : password.length > 128
        ? tr("最多 128 位", "At most 128 characters")
        : null;
  const termError = role === "user" && term.planId ? termBody(term, tr) : null;
  const termText = typeof termError === "string" ? termError : null;
  const problems = [emailError, passwordError, termText].filter(Boolean).length;
  const submit = async () => {
    setTouched({ email: true, password: true, submit: true });
    if (problems) return;
    let plan: Record<string, unknown> | undefined;
    if (role === "user" && term.planId) {
      const b = termBody(term, tr);
      if (typeof b === "string") return;
      plan = b;
    }
    const r = await run(
      () =>
        post<{ email: string; sub_url: string | null }>("/users", {
          email: email.trim(),
          password,
          role,
          ...(plan ? { plan } : {}),
        }),
      { ok: tr("用户已创建", "User created") },
    );
    if (r) setCreated(r);
  };
  if (created)
    return (
      <Dialog
        open
        icon={UserPlus}
        onClose={onClose}
        title={tr("用户已创建", "User created")}
        description={created.email}
        footer={
          <Button variant="primary" onClick={onClose}>
            {tr("完成", "Done")}
          </Button>
        }
      >
        {created.sub_url ? (
          <div className="space-y-2">
            <p className="text-footnote text-muted-foreground">{tr("订阅链接", "Subscription link")}</p>
            <div className="flex items-start gap-2">
              <Mono>{absoluteUrl(created.sub_url)}</Mono>
              <CopyButton text={absoluteUrl(created.sub_url)} />
            </div>
          </div>
        ) : (
          <p className="text-body text-muted-foreground">
            {tr("之后可在用户详情里查看订阅链接。", "The subscription link is in the user's detail.")}
          </p>
        )}
      </Dialog>
    );
  return (
    <Dialog
      open
      size="lg"
      icon={UserPlus}
      onClose={onClose}
      title={tr("新建用户", "New user")}
      description={tr(
        "管理员创建的邮箱视为已验证。套餐按「套餐 + 时长」分配。",
        "Addresses created by an admin count as verified. A plan is assigned as plan + term.",
      )}
      onSubmit={submit}
      footer={
        <>
          {touched.submit && problems > 0 && (
            <span role="status" className="mr-auto text-footnote text-destructive">
              {tr(`${problems} 处需要修正`, `${problems} to fix`)}
            </span>
          )}
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("创建", "Create")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("邮箱", "Email")} error={touched.email ? emailError : undefined} required>
            <Input
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => email && setTouched((t) => ({ ...t, email: true }))}
              data-autofocus
            />
          </Field>
          <Field
            label={tr("初始密码（至少 8 位）", "Initial password (8+)")}
            error={touched.password ? passwordError : undefined}
            required
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => password && setTouched((t) => ({ ...t, password: true }))}
            />
          </Field>
        </div>
        <Field
          label={tr("角色", "Role")}
          hint={!me.is_owner ? tr("只有所有者可以创建管理员。", "Only the owner creates admins.") : undefined}
        >
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="user">{tr("用户", "User")}</option>
            <option value="admin" disabled={!me.is_owner}>
              {tr("管理员", "Admin")}
            </option>
          </Select>
        </Field>
        {role === "user" && <TermFields form={term} onChange={setTerm} plans={plans} allowNone />}
        {touched.submit && termText && (
          <p role="alert" className="text-footnote text-destructive">
            {termText}
          </p>
        )}
      </div>
    </Dialog>
  );
}
