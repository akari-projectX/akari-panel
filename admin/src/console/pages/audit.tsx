// 审计日志 (AUD-*): keyset list filtered by actor label and action (prefix
// with a trailing "."), action names in both languages, field-level diff.
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { get, qs } from "../../shared/api";
import { dateTime } from "../../shared/format";
import { useLang, useTr, type Lang, type Tr } from "../../shared/i18n";
import { Button, Input, PageHeader } from "../../shared/ui/primitives";
import { DataTable, type Column } from "../../shared/ui/table";
import { useDebounced } from "../kit";

type Entry = {
  id: number;
  at: string;
  actor_id: string | null;
  actor_label: string;
  actor_email: string | null;
  ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before: unknown;
  after: unknown;
};

/** Action names [zh, en]; unknown actions show their code. */
export const ACTIONS: Record<string, [string, string]> = {
  "auth.login": ["登录", "Signed in"],
  "auth.login_failed": ["登录失败", "Sign-in failed"],
  "user.create": ["新建用户", "User created"],
  "user.update": ["修改用户", "User changed"],
  "user.delete": ["删除用户", "User deleted"],
  "user.erase": ["注销账户", "Account erased"],
  "users.bulk_delete": ["批量删除用户", "Users deleted in bulk"],
  "user.register": ["自助注册", "Signed up"],
  "user.revoke_sessions": ["踢下线", "Signed out everywhere"],
  "user.password.change": ["修改密码", "Password changed"],
  "user.password.reset": ["找回密码", "Password reset"],
  "user.email.change": ["更换邮箱", "Email changed"],
  "user.email.verify": ["标记邮箱已验证", "Email marked verified"],
  "user.sub_token.rotate": ["重置订阅令牌", "Subscription token reset"],
  "user.sub_token.issue": ["签发订阅令牌", "Subscription token issued"],
  "user.sub_token.read": ["查看订阅链接", "Subscription link read"],
  "user.credentials.rotate": ["更换节点凭据", "Credentials rotated"],
  "user.plan.set": ["分配套餐", "Plan assigned"],
  "user.plan.renew": ["续期 / 延长套餐", "Plan renewed / extended"],
  "user.plan.cancel": ["取消套餐", "Plan cancelled"],
  "user.plan.refund": ["退款撤销套餐", "Plan undone by refund"],
  "user.plan.expire": ["套餐到期", "Plan expired"],
  "user.traffic.reset": ["重置流量", "Traffic reset"],
  "user.ban": ["封禁用户", "User banned"],
  "user.unban": ["解除封禁", "Ban lifted"],
  "user.owner.transfer": ["转让所有者", "Ownership transferred"],
  "user.login_method.reset": ["重置登录方式", "Sign-in methods reset"],
  "user.passkey.add": ["添加通行密钥", "Passkey added"],
  "user.passkey.rename": ["通行密钥改名", "Passkey renamed"],
  "user.passkey.delete": ["删除通行密钥", "Passkey deleted"],
  "user.password_login.set": ["修改密码登录开关", "Password sign-in switched"],
  "user.batch.create": ["创建批量任务", "Batch job created"],
  "user.batch.cancel": ["取消批量任务", "Batch job cancelled"],
  "user.mail.send": ["发送通知邮件", "Notice mailed"],
  "plan.create": ["新建套餐", "Plan created"],
  "plan.update": ["修改套餐", "Plan changed"],
  "plan.delete": ["删除套餐", "Plan deleted"],
  "plan.price.set": ["设置套餐价格", "Plan prices set"],
  "group.create": ["新建节点组", "Node group created"],
  "group.update": ["修改节点组", "Node group changed"],
  "group.delete": ["删除节点组", "Node group deleted"],
  "server.create": ["新建服务器", "Server created"],
  "server.update": ["修改服务器", "Server changed"],
  "server.delete": ["删除服务器", "Server deleted"],
  "server.enroll": ["服务器注册", "Server enrolled"],
  "server.enroll_token": ["生成安装命令 / 注册令牌", "Install command / token issued"],
  "server.probe": ["立即测速", "Probe requested"],
  "server.cert.renew": ["agent 证书续期", "Agent certificate renewed"],
  "server.cert.rotated": ["agent 证书轮换", "Agent certificate rotated"],
  "server.alert_rules.set": ["修改服务器告警规则", "Server alert rules set"],
  "server.traffic_quota.reset": ["流量额度周期重置", "Traffic quota reset"],
  "node.create": ["新建节点", "Node created"],
  "node.update": ["修改节点", "Node changed"],
  "node.delete": ["删除节点", "Node deleted"],
  "node.set_inbound": ["修改入站", "Inbound changed"],
  "node.block_rules.set": ["切换节点审计规则", "Node block rules switched"],
  "entrance.create": ["新建中转入口", "Relay entrance created"],
  "entrance.update": ["修改入口", "Entrance changed"],
  "entrance.delete": ["删除中转入口", "Relay entrance deleted"],
  "entrance.rate_rules.set": ["设置时段倍率", "Time-window multipliers set"],
  "block_rule.create": ["新建审计规则", "Block rule created"],
  "block_rule.update": ["修改审计规则", "Block rule changed"],
  "block_rule.delete": ["删除审计规则", "Block rule deleted"],
  "order.create": ["创建订单", "Order created"],
  "order.paid": ["订单付款", "Order paid"],
  "order.cancel": ["取消订单", "Order cancelled"],
  "order.expire": ["订单过期", "Order expired"],
  "order.refund": ["订单退款", "Order refunded"],
  "order.refund.request": ["发起原路退款", "Original-route refund requested"],
  "order.refund.failed": ["原路退款失败", "Original-route refund failed"],
  "order.fulfil.retry": ["重试开通", "Fulfilment retried"],
  "order.payment.rejected": ["拒绝付款通知", "Payment notice rejected"],
  "payment_method.create": ["添加支付方式", "Payment method added"],
  "payment_method.update": ["修改支付方式", "Payment method changed"],
  "payment_method.delete": ["删除支付方式", "Payment method deleted"],
  "coupon.create": ["新建优惠券", "Coupon created"],
  "coupon.update": ["修改优惠券", "Coupon changed"],
  "coupon.delete": ["删除优惠券", "Coupon deleted"],
  "coupon.batch.create": ["批量生成优惠码", "Codes generated"],
  "coupon.batch.revoke": ["作废优惠码批次", "Code batch revoked"],
  "export.users": ["导出用户 CSV", "Users exported"],
  "export.orders": ["导出订单 CSV", "Orders exported"],
  "export.traffic": ["导出流量 CSV", "Traffic exported"],
  "export.coupon_batch": ["导出优惠码 CSV", "Codes exported"],
  "balance.commission": ["返利入账", "Commission credited"],
  "balance.admin_adjust": ["人工调整余额", "Balance adjusted"],
  "balance.order_payment": ["余额支付", "Paid from balance"],
  "balance.refund_to_balance": ["退款到余额", "Refunded to balance"],
  "balance.withdrawal": ["提现扣款", "Withdrawal debited"],
  "balance.withdrawal_reversal": ["提现退回", "Withdrawal returned"],
  "balance.commission_clawback": ["返利追回", "Commission clawed back"],
  "commission.create": ["生成返利", "Commission created"],
  "commission.reverse": ["撤销返利", "Commission reversed"],
  "commission.clawback": ["追回返利", "Commission clawback"],
  "commission.settings.update": ["修改返利设置", "Invite settings changed"],
  "withdrawal.request": ["申请提现", "Withdrawal requested"],
  "withdrawal.approved": ["提现已打款", "Withdrawal paid"],
  "withdrawal.rejected": ["拒绝提现", "Withdrawal rejected"],
  "withdrawal.cancelled": ["撤销提现", "Withdrawal cancelled"],
  "invite.create": ["新建邀请码", "Invite code created"],
  "invite.delete": ["删除邀请码", "Invite code deleted"],
  "ticket.create": ["新建工单", "Ticket opened"],
  "ticket.reply": ["回复工单", "Ticket replied"],
  "ticket.close": ["关闭工单", "Ticket closed"],
  "ticket.reopen": ["重新打开工单", "Ticket reopened"],
  "ticket.assign": ["分配工单", "Ticket assigned"],
  "alerts.ack": ["确认告警", "Alert acknowledged"],
  "alerts.settings.update": ["修改告警设置", "Alert settings changed"],
  "alerts.test": ["测试告警通道", "Alert channel tested"],
  "alerts.notification.retry": ["重试告警通知", "Alert delivery retried"],
  "agent_release.create": ["上传发布清单", "Release manifest uploaded"],
  "agent_release.upload": ["上传 agent 程序", "Agent binary uploaded"],
  "agent_release.delete": ["删除发布", "Release deleted"],
  "agent_update.check": ["检查 agent 更新", "Agent update check"],
  "agent_update.settings.update": ["修改更新检查设置", "Update check settings changed"],
  "rollout.create": ["创建灰度更新", "Rollout created"],
  "rollout.pause": ["暂停灰度更新", "Rollout paused"],
  "rollout.resume": ["继续灰度更新", "Rollout resumed"],
  "rollout.abort": ["中止灰度更新", "Rollout aborted"],
  "rollout.wave": ["灰度更新下一批", "Rollout next wave"],
  "rollout.halt": ["灰度更新自动停止", "Rollout halted"],
  "rollout.complete": ["灰度更新完成", "Rollout completed"],
  "settings.update": ["修改域名设置", "Domain settings changed"],
  "settings.import": ["导入旧配置", "Old configuration imported"],
  "settings.access.import": ["导入后台前缀", "Admin prefix imported"],
  "settings.admin_prefix.rotate": ["轮换后台前缀", "Admin prefix rotated"],
  "settings.admin_allowlist.update": ["修改后台 IP 白名单", "Admin allowlist changed"],
  "settings.sub_path.update": ["修改订阅路径", "Subscription path changed"],
  "settings.sub_path.generate": ["生成订阅路径", "Subscription path generated"],
  "settings.subscription.update": ["修改订阅设置", "Subscription settings changed"],
  "settings.auth.update": ["修改登录与人机验证设置", "Sign-in protection changed"],
  "settings.cleanup.update": ["修改账号清理设置", "Cleanup settings changed"],
  "settings.nodes.update": ["修改节点通信设置", "Node settings changed"],
  "settings.security.update": ["修改安全设置", "Security settings changed"],
  "settings.probe.update": ["修改测速设置", "Probe settings changed"],
  "settings.site.update": ["修改站点设置", "Site settings changed"],
  "settings.branding.update": ["修改品牌设置", "Branding changed"],
  "settings.branding.logo": ["修改 Logo", "Logo changed"],
  "settings.branding.favicon": ["修改网站图标", "Favicon changed"],
  "settings.mail_template.update": ["修改邮件模板", "Mail template changed"],
  "settings.mail_template.reset": ["恢复默认邮件模板", "Mail template reset"],
  "settings.server_name.remove": ["移除证书域名", "Certificate name removed"],
  "settings.signup.update": ["修改注册设置", "Sign-up settings changed"],
  "settings.mail.update": ["修改邮件设置", "Mail settings changed"],
  "settings.mail.test": ["测试发信", "Test mail"],
  "announcement.create": ["新建公告", "Announcement created"],
  "announcement.update": ["修改公告", "Announcement changed"],
  "announcement.delete": ["删除公告", "Announcement deleted"],
  "announcement.mail": ["邮件通知公告", "Announcement mailed"],
  "kb.category.create": ["新建帮助分类", "Help category created"],
  "kb.category.update": ["修改帮助分类", "Help category changed"],
  "kb.category.delete": ["删除帮助分类", "Help category deleted"],
  "kb.article.create": ["新建帮助文章", "Help article created"],
  "kb.article.update": ["修改帮助文章", "Help article changed"],
  "kb.article.delete": ["删除帮助文章", "Help article deleted"],
  "mail.retry": ["重试失败邮件", "Mail retried"],
  "secrets.rotate_prefix": ["轮换路径前缀", "Prefix rotated"],
  "secrets.rotate_jwt": ["轮换会话密钥", "Session key rotated"],
};

export function actionName(a: string, lang: Lang): string {
  const n = ACTIONS[a];
  return n ? (lang === "en" ? n[1] : n[0]) : a;
}

function show(v: unknown, tr: Tr): string {
  if (v === undefined) return "—";
  if (v === null) return tr("（空）", "(empty)");
  if (v === "changed") return tr("（已更改）", "(changed)");
  if (typeof v === "boolean") return v ? tr("是", "yes") : tr("否", "no");
  if (typeof v === "string" || typeof v === "number") return String(v);
  return JSON.stringify(v);
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Field-level changes: an update's differing fields; every field of a create / delete. */
export function auditDiff(before: unknown, after: unknown, tr: Tr): { field: string; before: string; after: string }[] {
  if (!isObj(before) && !isObj(after))
    return before == null && after == null
      ? []
      : [{ field: "", before: show(before ?? undefined, tr), after: show(after ?? undefined, tr) }];
  const b = isObj(before) ? before : {};
  const a = isObj(after) ? after : {};
  const out: { field: string; before: string; after: string }[] = [];
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const changed = JSON.stringify(b[k]) !== JSON.stringify(a[k]) || a[k] === "changed";
    if (isObj(before) && isObj(after) && !changed) continue;
    out.push({ field: k, before: isObj(before) ? show(b[k], tr) : "—", after: isObj(after) ? show(a[k], tr) : "—" });
  }
  return out;
}

function Changes({ e }: { e: Entry }) {
  const tr = useTr();
  const rows = auditDiff(e.before, e.after, tr);
  if (!rows.length) return <span className="text-muted-foreground">—</span>;
  const list = (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {rows.map((r) => (
        <div key={r.field || "v"} className="contents">
          <dt className="whitespace-nowrap font-mono text-muted-foreground">{r.field || tr("值", "value")}</dt>
          <dd className="min-w-0 break-all">
            {e.before != null && e.after != null ? (
              <>
                <span className="text-muted-foreground line-through">{r.before}</span> → <span>{r.after}</span>
              </>
            ) : e.after != null ? (
              r.after
            ) : (
              r.before
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
  return rows.length <= 4 ? (
    list
  ) : (
    <details>
      <summary className="cursor-pointer text-xs">{tr(`${rows.length} 个字段`, `${rows.length} fields`)}</summary>
      <div className="mt-1">{list}</div>
    </details>
  );
}

export function AuditPage() {
  const tr = useTr();
  const lang = useLang();
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const da = useDebounced(actor.trim(), 400);
  const dx = useDebounced(action.trim(), 400);
  const q = useInfiniteQuery({
    queryKey: ["audit", da, dx],
    queryFn: ({ pageParam }) =>
      get<{ entries: Entry[]; next_before: number | null }>(
        `/audit${qs({ limit: 50, before: pageParam, actor: da, action: dx })}`,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
  });
  const rows = (q.data?.pages.flatMap((p) => p.entries) ?? []).map((e) => ({ ...e, id: String(e.id), raw: e }));
  const columns: Column<(typeof rows)[number]>[] = [
    { key: "at", header: tr("时间", "Time"), cell: (e) => <span className="whitespace-nowrap">{dateTime(e.at)}</span> },
    {
      key: "actor",
      header: tr("操作者", "Actor"),
      cell: (e) => (
        <span className="flex flex-col">
          <span>{e.actor_email ?? e.actor_label}</span>
          {e.actor_email && <span className="font-mono text-[11px] text-muted-foreground">{e.actor_label}</span>}
        </span>
      ),
    },
    {
      key: "action",
      header: tr("操作", "Action"),
      fixed: true,
      mobile: "title",
      cell: (e) => <span title={e.action}>{actionName(e.action, lang)}</span>,
    },
    {
      key: "target",
      header: tr("对象", "Target"),
      cell: (e) =>
        e.target_type ? (
          <span className="font-mono text-xs">
            {e.target_type}
            {e.target_id ? ` ${e.target_id.slice(0, 8)}` : ""}
          </span>
        ) : (
          "—"
        ),
    },
    { key: "changes", header: tr("变更", "Changes"), cell: (e) => <Changes e={e.raw} /> },
    { key: "ip", header: "IP", optional: true, cell: (e) => e.ip ?? "—" },
  ];
  return (
    <>
      <PageHeader
        title={tr("审计日志", "Audit log")}
        description={tr(
          "所有管理操作与系统动作；保留天数在系统设置 → 安全。",
          "Every admin and system action; retention under Settings → Security.",
        )}
      />
      <DataTable
        label={tr("审计日志", "Audit log")}
        storageKey="audit"
        rows={rows}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        toolbar={
          <>
            <Input
              aria-label={tr("操作者标签", "Actor label")}
              placeholder={tr("操作者标签（如 u-1a2b3c4d、cli、system）", "Actor label (u-1a2b3c4d, cli, system)")}
              className="h-8 w-full sm:w-64"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            />
            <Input
              aria-label={tr("操作", "Action")}
              placeholder={tr("操作（如 user. 或 user.ban）", "Action (user. or user.ban)")}
              className="h-8 w-full sm:w-56"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              list="audit-actions"
            />
            <datalist id="audit-actions">
              {Object.keys(ACTIONS).map((a) => (
                <option key={a} value={a}>
                  {actionName(a, lang)}
                </option>
              ))}
            </datalist>
          </>
        }
        footer={
          q.hasNextPage ? (
            <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {tr("加载更早", "Load older")}
            </Button>
          ) : (
            <span />
          )
        }
      />
    </>
  );
}
