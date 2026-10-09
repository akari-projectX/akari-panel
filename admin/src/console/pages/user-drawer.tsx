// One account (USR-05…23): the drawer with the current subscription (D12)
// and its plan actions, ban (W28-c), role / password / sessions,
// subscription link, email verification, sign-in methods (W27), owner
// transfer (R47), balance, traffic and deletion with its impact (中-7);
// and the new-user dialog.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { del, get, patch, post, put } from "../../shared/api";
import { bytes, dateOnly, dateTime, daysBefore, parseYuan, pct, rateText, siteToday, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { LineChart } from "../../shared/ui/line-chart";
import { Dialog, Drawer, MenuItem, RowMenu, useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  Field,
  Input,
  KV,
  Progress,
  Segmented,
  Select,
  Skeleton,
  usageTone,
} from "../../shared/ui/primitives";
import { QrCode } from "../../shared/ui/qr-code";
import { CopyButton, FormError, Mono, SectionTitle, useRun } from "../kit";
import { resetLabel, periodLabel } from "../terms";
import { useMe } from "../session";
import type { PlanView } from "../types";
import { EMPTY_TERM, TermFields, termBody, type TermForm } from "./term-fields";
import { userStatus, type UserRow } from "./users";

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
type Ban = {
  reason: string | null;
  banned_at: string | null;
  banned_by_id: string | null;
  banned_by_email: string | null;
};
type Detail = UserRow & { subscription: Subscription | null; ban: Ban | null };
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
type Ledger = {
  balance_cents: number;
  withdrawable_cents: number;
  entries: {
    id: number;
    kind: string;
    amount_cents: number;
    balance_after_cents: number;
    out_trade_no: string | null;
    reason: string | null;
    created_at: string;
    actor_label: string;
  }[];
};

/** Absolute subscription URL (the server may answer a root-relative one, D11). */
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

export function UserDrawer({ id, plans, onClose }: { id: string; plans: PlanView[]; onClose: () => void }) {
  const tr = useTr();
  const me = useMe();
  const confirm = useConfirm();
  const toast = useToast();
  const [run] = useRun();
  const q = useQuery({ queryKey: ["users", "detail", id], queryFn: () => get<Detail>(`/users/${id}`) });
  const [dialog, setDialog] = useState<null | "plan" | "renew" | "ban" | "password" | "balance" | "sub">(null);
  const u = q.data;
  const inv = [["users"], ["dashboard"]];
  const isAdmin = u?.role === "admin";
  const otherAdmin = isAdmin && u?.id !== me.id;
  const ownerOnly = otherAdmin && !me.is_owner;

  const act = async (opts: Parameters<typeof confirm>[0], fn: () => Promise<unknown>, ok: string) => {
    if (!(await confirm({ ...opts, action: fn }))) return;
    toast({ tone: "success", title: ok });
    void q.refetch();
  };

  const deleteUser = async () => {
    if (!u) return;
    let im: Impact;
    try {
      im = await get<Impact>(`/users/${id}/delete-impact`);
    } catch {
      return;
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
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
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
      void run(async () => undefined, { invalidate: inv });
      onClose();
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="sm:max-w-2xl"
      title={u?.email ?? tr("用户", "User")}
      subtitle={
        u && (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={userStatus(u, tr).tone} dot>
              {userStatus(u, tr).label}
            </Badge>
            {u.is_owner && <Badge tone="primary">{tr("所有者", "Owner")}</Badge>}
            {isAdmin && <Badge tone="outline">{tr("管理员", "Admin")}</Badge>}
            <span className="font-mono">{u.id}</span>
          </span>
        )
      }
      actions={
        u &&
        !u.erased && (
          <RowMenu label={tr("更多操作", "More actions")}>
            {(close) => (
              <>
                <MenuItem icon="key" disabled={ownerOnly} onClick={() => (close(), setDialog("password"))}>
                  {tr("设置新密码", "Set a new password")}
                </MenuItem>
                <MenuItem
                  icon="logout"
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
                {!u.email_verified && (
                  <MenuItem
                    icon="mail"
                    disabled={ownerOnly}
                    onClick={() => {
                      close();
                      void act(
                        { title: tr("标记邮箱已验证？", "Mark the address verified?"), tone: "default" },
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
                    icon="users"
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
                    icon="star"
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
                  <MenuItem icon="trash" danger disabled={ownerOnly} onClick={() => (close(), void deleteUser())}>
                    {tr("删除账户", "Delete account")}
                  </MenuItem>
                )}
              </>
            )}
          </RowMenu>
        )
      }
    >
      {q.isPending && <Skeleton className="h-64" />}
      <FormError error={q.error} />
      {u && (
        <>
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
            <div className="mb-4">
              <Callout tone="danger" title={tr("已封禁", "Banned")}>
                <p>{u.ban.reason}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {dateTime(u.ban.banned_at)} · {u.ban.banned_by_email ?? tr("系统", "system")}
                </p>
                {!u.erased && (
                  <Button
                    className="mt-2"
                    size="sm"
                    onClick={() =>
                      void act(
                        { title: tr("解除封禁？", "Lift the ban?"), tone: "default" },
                        () => post(`/users/${id}/unban`),
                        tr("已解除封禁", "Ban lifted"),
                      )
                    }
                  >
                    {tr("解除封禁", "Unban")}
                  </Button>
                )}
              </Callout>
            </div>
          )}

          {!isAdmin && !u.erased && (
            <SubscriptionCard
              user={u}
              onAssign={() => setDialog("plan")}
              onRenew={() => setDialog("renew")}
              refetch={() => void q.refetch()}
            />
          )}

          <SectionTitle>{tr("账户", "Account")}</SectionTitle>
          <KV
            items={[
              [
                tr("邮箱", "Email"),
                <span key="e">
                  {u.email} {u.email_verified ? "" : tr("（未验证）", "(unverified)")}
                </span>,
              ],
              [tr("注册时间", "Signed up"), dateTime(u.created_at)],
              [tr("最后登录", "Last sign-in"), u.last_login_at ? dateTime(u.last_login_at) : tr("从未", "never")],
              [tr("余额", "Balance"), yuan(u.balance_cents)],
            ]}
          />
          {!u.erased && (
            <div className="mt-3 flex flex-wrap gap-2">
              {!isAdmin && (
                <>
                  <Button size="sm" icon="link" onClick={() => setDialog("sub")}>
                    {tr("订阅链接", "Subscription link")}
                  </Button>
                  <Button
                    size="sm"
                    icon="refresh"
                    onClick={() =>
                      void act(
                        {
                          title: tr("重置订阅？", "Reset the subscription?"),
                          description: tr(
                            "生成新链接并更换全部入口凭据：旧链接和已导入的客户端全部失效，在线连接断开。",
                            "New link and new credentials on every entrance: the old link and every imported client stop working; live connections are cut.",
                          ),
                          tone: "danger",
                        },
                        () => post(`/users/${id}/sub-token`),
                        tr("订阅已重置", "Subscription reset"),
                      )
                    }
                  >
                    {tr("重置订阅", "Reset subscription")}
                  </Button>
                </>
              )}
              {!u.ban && !u.is_owner && u.id !== me.id && (
                <Button
                  size="sm"
                  variant="destructive-soft"
                  icon="ban"
                  disabled={ownerOnly}
                  onClick={() => setDialog("ban")}
                >
                  {tr("封禁", "Ban")}
                </Button>
              )}
              <Button size="sm" icon="wallet" onClick={() => setDialog("balance")}>
                {tr("调整余额", "Adjust balance")}
              </Button>
            </div>
          )}

          <LoginMethods id={id} disabled={ownerOnly || u.erased} />
          {!isAdmin && <PlanHistoryList id={id} />}
          <BalanceLedger id={id} />
          {!isAdmin && <UserTraffic id={id} />}
        </>
      )}
      {u && dialog === "plan" && (
        <AssignPlanDialog
          id={id}
          plans={plans}
          current={u.subscription}
          onClose={() => setDialog(null)}
          onDone={() => void q.refetch()}
        />
      )}
      {u && dialog === "renew" && u.subscription && (
        <RenewDialog id={id} sub={u.subscription} onClose={() => setDialog(null)} onDone={() => void q.refetch()} />
      )}
      {u && dialog === "ban" && (
        <BanDialog id={id} email={u.email} onClose={() => setDialog(null)} onDone={() => void q.refetch()} />
      )}
      {u && dialog === "password" && <PasswordDialog id={id} onClose={() => setDialog(null)} />}
      {u && dialog === "balance" && (
        <AdjustBalanceDialog id={id} email={u.email} onClose={() => setDialog(null)} onDone={() => void q.refetch()} />
      )}
      {u && dialog === "sub" && <SubLinkDialog id={id} onClose={() => setDialog(null)} />}
    </Drawer>
  );
}

function SubscriptionCard({
  user,
  onAssign,
  onRenew,
  refetch,
}: {
  user: Detail;
  onAssign: () => void;
  onRenew: () => void;
  refetch: () => void;
}) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const s = user.subscription;
  const id = user.id;
  const act = async (opts: Parameters<typeof confirm>[0], fn: () => Promise<unknown>, ok: string) => {
    if (await confirm({ ...opts, action: fn })) {
      toast({ tone: "success", title: ok });
      refetch();
    }
  };
  return (
    <Card className="mb-2">
      <CardBody>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{tr("当前订阅", "Current subscription")}</h3>
          {s && (
            <Badge tone={s.status === "active" ? "success" : "danger"} dot>
              {subStatusText(s.status, tr)}
            </Badge>
          )}
        </div>
        {!s ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground">
            {tr("没有生效的套餐。", "No active plan.")}
            <Button size="sm" variant="primary" onClick={onAssign}>
              {tr("分配套餐", "Assign a plan")}
            </Button>
          </div>
        ) : (
          <>
            <KV
              items={[
                [tr("套餐", "Plan"), s.plan_name],
                [tr("时长", "Term"), periodLabel(s.period, tr, s.period_days)],
                [tr("开始", "Started"), dateTime(s.starts_at)],
                [tr("到期", "Expires"), s.expires_at ? dateTime(s.expires_at) : tr("永久", "never")],
                [tr("重置", "Reset"), resetLabel(s.reset_period, tr)],
                [tr("上次重置", "Last reset"), dateTime(s.last_reset_at)],
                [tr("下次重置", "Next reset"), s.next_reset_at ? `${dateTime(s.next_reset_at)} (${s.timezone})` : "—"],
                [
                  tr("限速", "Speed limit"),
                  s.speed_limit_mbps ? `${s.speed_limit_mbps} Mbps` : tr("不限", "unlimited"),
                ],
              ]}
            />
            <div className="mt-3">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{tr("已用 / 总流量", "Used / total")}</span>
                <span className="tabular-nums">
                  {bytes(s.traffic_used_bytes)} /{" "}
                  {s.traffic_total_bytes === null ? tr("不限", "unlimited") : bytes(s.traffic_total_bytes)}
                </span>
              </div>
              {s.traffic_total_bytes !== null && (
                <Progress
                  className="mt-1"
                  value={pct(s.traffic_used_bytes, s.traffic_total_bytes)}
                  tone={usageTone(pct(s.traffic_used_bytes, s.traffic_total_bytes))}
                />
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="sm"
                icon="refresh"
                onClick={() =>
                  void act(
                    {
                      title: tr("重置套餐流量？", "Reset the plan traffic?"),
                      description: tr(
                        "已用流量清零（重置周期不变）；因超流量停用的账户会自动恢复，封禁的不会。写入审计。",
                        "Used traffic goes to zero (schedule unchanged); an account suspended for its quota is re-enabled, a banned one is not. Audited.",
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
              <Button size="sm" icon="calendar" onClick={onRenew}>
                {tr("续期 / 延长", "Renew / extend")}
              </Button>
              <Button size="sm" icon="layers" onClick={onAssign}>
                {tr("更换套餐", "Change plan")}
              </Button>
              <Button
                size="sm"
                variant="destructive-soft"
                onClick={() =>
                  void act(
                    {
                      title: tr("取消套餐？", "Cancel the plan?"),
                      description: tr(
                        "订阅立即结束，用户失去全部入口。",
                        "The subscription ends now; the user loses every entrance.",
                      ),
                    },
                    () => del(`/users/${id}/plan`),
                    tr("套餐已取消", "Plan cancelled"),
                  )
                }
              >
                {tr("取消套餐", "Cancel plan")}
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function AssignPlanDialog({
  id,
  plans,
  current,
  onClose,
  onDone,
}: {
  id: string;
  plans: PlanView[];
  current: Subscription | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const tr = useTr();
  const [form, setForm] = useState<TermForm>({ ...EMPTY_TERM, planId: current?.plan_id ?? "" });
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const submit = async () => {
    const b = termBody(form, tr);
    if (typeof b === "string") return setError(new Error(b));
    const r = await run(() => put(`/users/${id}/plan`, b), {
      ok: tr("套餐已分配", "Plan assigned"),
      invalidate: [["users"]],
    });
    if (r !== undefined) {
      onDone();
      onClose();
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={current ? tr("更换套餐", "Change plan") : tr("分配套餐", "Assign a plan")}
      description={tr(
        "从现在开始计算，已用流量清零；到期时间由时长计算（D12）。",
        "Starts now with zero usage; the expiry follows from the term (D12).",
      )}
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
      <div className="mt-3">
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

function RenewDialog({
  id,
  sub,
  onClose,
  onDone,
}: {
  id: string;
  sub: Subscription;
  onClose: () => void;
  onDone: () => void;
}) {
  const tr = useTr();
  const onetime = sub.period === "onetime";
  const [mode, setMode] = useState<"term" | "extend">("term");
  const [form, setForm] = useState<TermForm>({
    ...EMPTY_TERM,
    period: sub.period,
    days: sub.period_days ? String(sub.period_days) : "",
  });
  const [days, setDays] = useState("30");
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const submit = async () => {
    let body: Record<string, unknown>;
    if (mode === "extend") {
      const n = Number(days);
      if (!/^\d{1,4}$/.test(days.trim()) || n < 1 || n > 3650)
        return setError(new Error(tr("天数须为 1–3650 的整数", "Days must be 1–3650")));
      body = { extend_days: n };
    } else {
      const b = termBody(form, tr, false);
      if (typeof b === "string") return setError(new Error(b));
      body = { period: b.period, ...(b.days ? { days: b.days } : {}) };
    }
    const r = await run(() => patch(`/users/${id}/plan`, body), {
      ok: tr("已续期", "Renewed"),
      invalidate: [["users"]],
    });
    if (r !== undefined) {
      onDone();
      onClose();
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr("续期 / 延长", "Renew / extend")}
      description={tr(
        `从到期时间（或现在）起算。当前到期：${dateTime(sub.expires_at)}`,
        `From the expiry (or now). Expires: ${dateTime(sub.expires_at)}`,
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
            onChange={setMode}
            options={[
              { value: "term", label: tr("续期一个时长", "One more term") },
              { value: "extend", label: tr("延长 N 天", "Extend N days") },
            ]}
          />
        )}
        {mode === "term" ? (
          <TermFields form={form} onChange={setForm} plans={[]} withPlan={false} />
        ) : (
          <Field label={tr("延长天数", "Days")}>
            <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        )}
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

function BanDialog({
  id,
  email,
  onClose,
  onDone,
}: {
  id: string;
  email: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const tr = useTr();
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState("abuse");
  const [run, busy] = useRun();
  const presets: Record<string, string> = {
    abuse: tr("违反服务条款（滥用）", "Terms of service violation (abuse)"),
    share: tr("账号共享 / 转售", "Account sharing / resale"),
    payment: tr("支付争议", "Payment dispute"),
    other: "",
  };
  const text = [presets[kind], reason.trim()].filter(Boolean).join(tr("：", ": "));
  const submit = async () => {
    if (!text) return;
    const r = await run(() => post(`/users/${id}/ban`, { reason: text }), {
      ok: tr("已封禁，已踢下线", "Banned and signed out"),
      invalidate: [["users"]],
    });
    if (r !== undefined) {
      onDone();
      onClose();
    }
  };
  return (
    <Dialog
      open
      tone="danger"
      icon="ban"
      onClose={onClose}
      title={tr(`封禁 ${email}`, `Ban ${email}`)}
      description={tr(
        "立即踢下线，所有节点断开该用户，订阅返回 404；门户里只能看到封禁原因和工单。写入审计。",
        "Signed out at once, dropped from every node, the subscription answers 404; the portal shows only the reason and tickets. Audited.",
      )}
      onSubmit={submit}
      footer={
        <>
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
        <Field label={tr("补充说明（会显示给用户）", "Note (shown to the user)")}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} />
        </Field>
      </div>
    </Dialog>
  );
}

function PasswordDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const [pw, setPw] = useState("");
  const [run, busy] = useRun();
  const submit = async () => {
    const r = await run(() => patch(`/users/${id}`, { password: pw }), {
      ok: tr("密码已修改，该账户的会话已结束", "Password set; the account's sessions ended"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr("设置新密码", "Set a new password")}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={pw.length < 8}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <Field label={tr("新密码（至少 8 位）", "New password (8+ characters)")}>
        <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </Field>
    </Dialog>
  );
}

export function AdjustBalanceDialog({
  id,
  email,
  onClose,
  onDone,
}: {
  id: string;
  email: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const tr = useTr();
  const [dir, setDir] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const submit = async () => {
    const c = parseYuan(amount);
    if (c === null || c <= 0)
      return setError(new Error(tr("金额无效（元，最多两位小数）", "Invalid amount (yuan, 2 decimals)")));
    if (!reason.trim()) return setError(new Error(tr("请填写原因", "Enter a reason")));
    const r = await run(
      () => post(`/users/${id}/balance`, { amount_cents: dir === "credit" ? c : -c, reason: reason.trim() }),
      {
        ok: tr("余额已调整", "Balance adjusted"),
        invalidate: [["balance"], ["users"], ["balances"]],
      },
    );
    if (r !== undefined) {
      onDone?.();
      onClose();
    }
  };
  return (
    <Dialog
      open
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
        <Field label={tr("金额（元）", "Amount (yuan)")}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label={tr("原因（必填，写入审计）", "Reason (required, audited)")}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

function SubLinkDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["users", "sub", id],
    queryFn: () =>
      get<{ sub_token: string | null; sub_url: string | null; legacy: boolean }>(`/users/${id}/subscription`),
    gcTime: 0,
  });
  const url = q.data?.sub_url ? absoluteUrl(q.data.sub_url) : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr("订阅链接", "Subscription link")}
      description={tr("每次读取都写入审计。", "Every read is audited.")}
      footer={<Button onClick={onClose}>{tr("关闭", "Close")}</Button>}
    >
      <FormError error={q.error} />
      {q.data?.legacy && (
        <Callout tone="warning">
          {tr(
            "该链接是旧版本生成的，只存了哈希，无法显示；重置订阅后可查看新链接。",
            "This link predates storable links; reset the subscription to get a showable one.",
          )}
        </Callout>
      )}
      {url && (
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <Mono>{url}</Mono>
            <CopyButton text={url} />
          </div>
          <div className="flex justify-center">
            <QrCode text={url} label={tr("订阅链接二维码", "Subscription QR code")} />
          </div>
        </div>
      )}
    </Dialog>
  );
}

function LoginMethods({ id, disabled }: { id: string; disabled: boolean }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const q = useQuery({ queryKey: ["users", "passkeys", id], queryFn: () => get<Passkeys>(`/users/${id}/passkeys`) });
  const d = q.data;
  return (
    <>
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
                    "删除该账户的全部通行密钥并恢复密码登录（丢失设备时使用）。写入审计。",
                    "Deletes every passkey of the account and turns password sign-in back on (lost device). Audited.",
                  ),
                  action: () => post(`/users/${id}/login-method/reset`),
                });
                if (ok) {
                  toast({ tone: "success", title: tr("登录方式已重置", "Sign-in methods reset") });
                  void q.refetch();
                }
              }}
            >
              {tr("重置登录方式", "Reset sign-in")}
            </Button>
          )
        }
      >
        {tr("登录方式", "Sign-in methods")}
      </SectionTitle>
      {d && (
        <div className="text-[13px]">
          <p className="text-muted-foreground">
            {d.password_login
              ? tr("可以用密码登录。", "Password sign-in works.")
              : tr("仅通行密钥登录。", "Passkey sign-in only.")}{" "}
            {d.password_login_disabled && tr("账户已选择只用通行密钥登录。", "The account chose passkey-only sign-in.")}{" "}
            {!d.available &&
              tr("（通行密钥需要 https 主域名，当前不可用）", "(passkeys need an https main domain; unavailable)")}
          </p>
          {d.passkeys.length > 0 && (
            <ul className="mt-2 divide-y divide-border rounded-md border border-border">
              {d.passkeys.map((p) => (
                <li key={p.id} className="flex justify-between px-3 py-2">
                  <span>{p.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {tr("最后使用", "last used")} {dateTime(p.last_used_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

function PlanHistoryList({ id }: { id: string }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["users", "plan", id],
    queryFn: () => get<{ active: PlanHistory | null; history: PlanHistory[] }>(`/users/${id}/plan`),
  });
  const rows = q.data?.history ?? [];
  if (!rows.length) return null;
  return (
    <>
      <SectionTitle>{tr("套餐历史", "Plan history")}</SectionTitle>
      <ul className="divide-y divide-border rounded-md border border-border text-[13px]">
        {rows.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="font-medium">{h.plan_name}</span>
            <Badge>{h.status}</Badge>
            <span className="text-xs text-muted-foreground">
              {periodLabel(h.period, tr, h.period_days)} · {dateOnly(h.starts_at)} →{" "}
              {dateOnly(h.ended_at ?? h.expires_at)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function BalanceLedger({ id }: { id: string }) {
  const tr = useTr();
  const q = useQuery({ queryKey: ["balance", id], queryFn: () => get<Ledger>(`/users/${id}/balance?limit=20`) });
  const d = q.data;
  if (!d || (d.entries.length === 0 && d.balance_cents === 0)) return null;
  return (
    <>
      <SectionTitle>
        {tr("余额明细", "Balance ledger")} · {yuan(d.balance_cents)}
      </SectionTitle>
      <ul className="divide-y divide-border rounded-md border border-border text-[13px]">
        {d.entries.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className={e.amount_cents < 0 ? "text-destructive" : "text-success"}>
              {e.amount_cents > 0 ? "+" : ""}
              {yuan(e.amount_cents)}
            </span>
            <Badge>{e.kind}</Badge>
            <span className="flex-1 truncate text-muted-foreground">{e.reason ?? e.out_trade_no ?? ""}</span>
            <span className="text-xs text-muted-foreground">{dateTime(e.created_at)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

type DayRow = { day: string; up_bytes: number; down_bytes: number; billed_bytes: number };
// USR-23: per entrance (R43), so a direct 1x and a relay 10x of one node are never summed.
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
  return (
    <>
      <SectionTitle
        actions={
          <Segmented
            size="sm"
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
      <LineChart
        title={tr("每日流量（站点时区）", "Daily traffic (site days)")}
        times={all.map((d) => `${d}T12:00:00Z`)}
        format={bytes}
        series={[
          {
            label: tr("下载", "Down"),
            values: all.map((d) => by.get(d)?.down_bytes ?? 0),
            stroke: "stroke-sky-500",
            swatch: "bg-sky-500",
          },
          {
            label: tr("上传", "Up"),
            values: all.map((d) => by.get(d)?.up_bytes ?? 0),
            stroke: "stroke-emerald-500",
            swatch: "bg-emerald-500",
          },
          {
            label: tr("计费", "Billed"),
            values: all.map((d) => by.get(d)?.billed_bytes ?? 0),
            stroke: "stroke-amber-500",
            swatch: "bg-amber-500",
          },
        ]}
      />
      {(entrances.data?.rows.length ?? 0) > 0 && (
        <ul
          className="mt-3 divide-y divide-border rounded-md border border-border text-[13px]"
          aria-label={tr("按入口", "By entrance")}
        >
          {entrances.data?.rows.map((n) => (
            <li key={n.entrance_id} className="flex flex-wrap justify-between gap-x-3 px-3 py-2">
              <span>
                {n.node ?? tr("已删除的节点", "Deleted node")} · {n.entrance ?? tr("已删除的入口", "Deleted entrance")}
                {n.kind && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {n.kind === "relay" ? tr("中转", "relay") : tr("直连", "direct")}
                    {n.rate_now !== null && ` · ${tr("当前", "now")} ${rateText(Math.round(n.rate_now * 1000))}`}
                  </span>
                )}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {tr("原始", "raw")} {bytes(n.up_bytes + n.down_bytes)} · {tr("计费", "billed")} {bytes(n.billed_bytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function CreateUserDialog({ plans, onClose }: { plans: PlanView[]; onClose: () => void }) {
  const tr = useTr();
  const me = useMe();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [term, setTerm] = useState<TermForm>(EMPTY_TERM);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ email: string; sub_url: string | null } | null>(null);
  const [run, busy] = useRun();
  const submit = async () => {
    let plan: Record<string, unknown> | undefined;
    if (role === "user" && term.planId) {
      const b = termBody(term, tr);
      if (typeof b === "string") return setError(new Error(b));
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
      { ok: tr("用户已创建", "User created"), invalidate: [["users"], ["dashboard"]] },
    );
    if (r) setCreated(r);
  };
  if (created)
    return (
      <Dialog
        open
        onClose={onClose}
        title={tr("用户已创建", "User created")}
        description={created.email}
        footer={<Button onClick={onClose}>{tr("完成", "Done")}</Button>}
      >
        {created.sub_url ? (
          <div className="flex items-start gap-2">
            <Mono>{absoluteUrl(created.sub_url)}</Mono>
            <CopyButton text={absoluteUrl(created.sub_url)} />
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            {tr("之后可在用户详情里查看订阅链接。", "The subscription link is in the user's detail.")}
          </p>
        )}
      </Dialog>
    );
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={tr("新建用户", "New user")}
      description={tr(
        "管理员创建的邮箱视为已验证。只能分配套餐 + 时长（D12）。",
        "Addresses created by an admin count as verified. Plans are assigned as plan + term only (D12).",
      )}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!email.trim() || password.length < 8}>
            {tr("创建", "Create")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("邮箱", "Email")}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={tr("初始密码（至少 8 位）", "Initial password (8+)")}>
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
        <FormError error={error} />
      </div>
    </Dialog>
  );
}
