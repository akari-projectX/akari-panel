// 审计日志 (AUD-*; v2 audit-*, a readable timeline): entries grouped by
// site day, each one sentence — who (avatar, or a robot for system / cli /
// agent), what (the action's name), on which object (a chip linking to the
// user / order / server…); below it the action chip (red for dangerous
// ones), how many fields changed and the IP. Filters are compact pills,
// all in the URL: 操作者 (?actor=, an email is resolved to the account's
// label; the loaded actors are offered), 动作 (?action=, exact or a prefix
// ending in "."), 日期 (?from=&to=, site days, applied to the loaded
// entries; older pages load on demand). The detail (?open=) shows the
// sentence, the field-level diff and the request facts. No CSV export and
// no client (user agent) column: the API has neither.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Bot,
  CalendarDays,
  ChevronDown,
  ExternalLink,
  FileText,
  Globe,
  History,
  Layers,
  LifeBuoy,
  Receipt,
  Rocket,
  Server,
  Settings,
  Shapes,
  Tag,
  Ticket,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { get, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateOnly, dateTime, daysBefore, siteTimeZone, siteToday } from "../../shared/format";
import { useLang, useTr, type Lang, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Dialog } from "../../shared/ui/dialog";
import { Input } from "../../shared/ui/form";
import { Callout, KV, PageHeader } from "../../shared/ui/layout";
import { Popover } from "../../shared/ui/menu";
import { EmptyState, ErrorState, SkeletonRows } from "../../shared/ui/states";
import { Avatar } from "../components/kit";
import { dayLabel } from "../components/ops-bits";
import { useQS } from "../router";

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

/** Target types → names. */
function targetName(t: string, tr: Tr): string {
  const names: Record<string, [string, string]> = {
    user: ["用户", "User"],
    order: ["订单", "Order"],
    server: ["服务器", "Server"],
    node: ["节点", "Node"],
    entrance: ["入口", "Entrance"],
    plan: ["套餐", "Plan"],
    group: ["节点组", "Node group"],
    coupon: ["优惠券", "Coupon"],
    ticket: ["工单", "Ticket"],
    announcement: ["公告", "Announcement"],
    kb_article: ["帮助文章", "Article"],
    kb_category: ["帮助分类", "Category"],
    settings: ["系统设置", "Settings"],
    payment_method: ["支付方式", "Payment method"],
    rollout: ["灰度", "Rollout"],
    agent_release: ["发布", "Release"],
    block_rule: ["出站拦截规则", "Block rule"],
    withdrawal: ["提现", "Withdrawal"],
    invite: ["邀请码", "Invite code"],
    alert: ["告警", "Alert"],
  };
  const n = names[t];
  return n ? tr(n[0], n[1]) : t;
}

/** Console link of an audited object (null: no page shows it by id). */
function targetHref(t: string | null, id: string | null): string | null {
  if (!t || !id) return null;
  switch (t) {
    case "user":
      return `/users?open=${id}`;
    case "order":
      return `/orders?open=${id}`;
    case "server":
      return `/nodes?open=server:${id}`;
    case "node":
      return `/nodes?open=node:${id}`;
    case "ticket":
      return `/tickets/${id}`;
    case "announcement":
      return `/content/announcements?open=${id}`;
    case "kb_article":
      return `/content/kb?open=${id}`;
    case "rollout":
      return `/updates?open=${id}`;
    default:
      return null;
  }
}

const TARGET_ICON: Record<string, LucideIcon> = {
  user: User,
  order: Receipt,
  server: Server,
  node: Globe,
  entrance: Globe,
  ticket: LifeBuoy,
  plan: Layers,
  group: Layers,
  settings: Settings,
  agent_release: Rocket,
  rollout: Rocket,
  coupon: Ticket,
};

/** Labels of actors that are not people. */
const AUTO = new Set(["system", "cli", "agent", "anonymous"]);
const isAuto = (e: Entry) => AUTO.has(e.actor_label) || (!e.actor_id && !e.actor_email);
function actorText(e: Entry, tr: Tr): string {
  if (e.actor_email) return e.actor_email;
  switch (e.actor_label) {
    case "system":
      return tr("系统", "System");
    case "cli":
      return tr("命令行", "Command line");
    case "agent":
      return "agent";
    case "anonymous":
      return tr("未登录的请求", "Anonymous request");
    default:
      return e.actor_label;
  }
}
const DANGER =
  /\.(delete|ban|erase|abort|revoke|rotate_prefix|rotate_jwt|refund)$|^users\.bulk_delete$|admin_prefix\.rotate/;

function ActorMark({ e, size = 30 }: { e: Entry; size?: number }) {
  const tr = useTr();
  if (isAuto(e))
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <Bot className="size-[55%]" />
      </span>
    );
  return <Avatar name={actorText(e, tr)} size={size} />;
}

function ObjChip({ e }: { e: Entry }) {
  const tr = useTr();
  if (!e.target_type) return null;
  const Icon = TARGET_ICON[e.target_type] ?? FileText;
  const href = targetHref(e.target_type, e.target_id);
  const inner = (
    <>
      <Icon className="size-3 shrink-0 text-faint" aria-hidden="true" />
      <span className="truncate">
        {targetName(e.target_type, tr)}
        {e.target_id && <span className="ml-1 font-mono text-footnote">{e.target_id.slice(0, 8)}</span>}
      </span>
    </>
  );
  const cls =
    "inline-flex max-w-full items-center gap-1 rounded-md bg-secondary px-1.5 py-px align-baseline text-body font-medium";
  return href ? (
    <Link to={href} onClick={(ev) => ev.stopPropagation()} className={cn(cls, "text-primary hover:bg-primary-soft")}>
      {inner}
    </Link>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

function Sentence({ e }: { e: Entry }) {
  const tr = useTr();
  const lang = useLang();
  return (
    <span className="leading-6">
      <b className="font-semibold break-all">{actorText(e, tr)}</b> {actionName(e.action, lang)} <ObjChip e={e} />
    </span>
  );
}

/** A filter pill: opens its popover; × clears it (a separate button). */
function Pill({
  label,
  value,
  icon: Icon,
  onClear,
  children,
  open,
  onOpenChange,
}: {
  label: string;
  value: string | null;
  icon: LucideIcon;
  onClear: () => void;
  children: ReactNode;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const tr = useTr();
  return (
    <span
      className={cn(
        "inline-flex h-8 shrink-0 items-center rounded-full text-body font-medium transition-colors pointer-coarse:h-10",
        value ? "bg-primary-soft text-primary" : "bg-card text-foreground/85 shadow-card hover:bg-accent",
      )}
    >
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        align="start"
        label={label}
        className="w-72"
        trigger={
          <button
            type="button"
            aria-label={value ? `${label}${tr("：", ": ")}${value}` : label}
            className={cn(
              "inline-flex h-full items-center gap-1.5 rounded-full pl-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
              value ? "pr-1" : "pr-2",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            <span className={cn(value && "text-primary/75")}>{label}</span>
            {value ? (
              <span className="max-w-40 truncate">{value}</span>
            ) : (
              <ChevronDown className="size-3.5 text-faint" aria-hidden="true" />
            )}
          </button>
        }
      >
        {children}
      </Popover>
      {value && (
        <button
          type="button"
          aria-label={tr(`清除${label}筛选`, `Clear the ${label} filter`)}
          onClick={onClear}
          className="hit-44 mr-1.5 inline-flex size-5 items-center justify-center rounded-full hover:bg-primary/15"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/** u-<first 8 hex of the id>: the label the audit log keeps for an account. */
const labelOf = (id: string) => `u-${id.replace(/-/g, "").slice(0, 8)}`;

/** An actor filter: an email → that account's label (null while resolving, "" = no such account). */
function useActorLabel(actor: string): { label: string | null; missing: boolean } {
  const email = actor.includes("@") ? actor.toLowerCase() : "";
  const q = useQuery({
    queryKey: ["users", "audit-actor", email],
    queryFn: () => get<{ users: { id: string; email: string }[] }>(`/users${qs({ q: email, limit: 20 })}`),
    enabled: !!email,
    staleTime: 60_000,
  });
  if (!email) return { label: actor, missing: false };
  if (!q.data) return { label: q.isError ? actor : null, missing: false };
  const u = q.data.users.find((x) => x.email.toLowerCase() === email);
  return u ? { label: labelOf(u.id), missing: false } : { label: "", missing: true };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Pages loaded on their own while a date range hides everything loaded so far. */
const AUTO_PAGES = 20;

export function AuditPage() {
  const tr = useTr();
  const lang = useLang();
  const [query, patch] = useQS();
  const actor = query.get("actor") ?? "";
  const action = query.get("action") ?? "";
  const from = DAY_RE.test(query.get("from") ?? "") ? (query.get("from") as string) : "";
  const to = DAY_RE.test(query.get("to") ?? "") ? (query.get("to") as string) : "";
  const open = query.get("open") ?? query.get("entry");
  const who = useActorLabel(actor);
  const q = useInfiniteQuery({
    queryKey: ["audit", who.label, action],
    queryFn: ({ pageParam }) =>
      get<{ entries: Entry[]; next_before: number | null }>(
        `/audit${qs({ limit: 50, before: pageParam, actor: who.label ?? "", action })}`,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
    enabled: who.label !== null && !who.missing,
  });
  const loaded = useMemo(() => q.data?.pages.flatMap((p) => p.entries) ?? [], [q.data]);
  const rows = loaded.filter((e) => {
    const d = dateOnly(e.at);
    return (!from || d >= from) && (!to || d <= to);
  });
  const oldest = loaded.length ? dateOnly(loaded[loaded.length - 1].at) : null;
  // Older pages can still hold entries of the range until the oldest loaded day is before `from`.
  const moreInRange = q.hasNextPage && (!from || (oldest !== null && oldest >= from));
  const pages = q.data?.pages.length ?? 0;
  useEffect(() => {
    if ((from || to) && rows.length < 20 && moreInRange && !q.isFetching && pages < AUTO_PAGES) void q.fetchNextPage();
  }, [from, to, rows.length, moreInRange, q, pages]);
  const filtered = !!(actor || action || from || to);
  const clear = () => patch({ actor: null, action: null, from: null, to: null });
  const current = open ? loaded.find((e) => String(e.id) === open) : undefined;
  const days = useMemo(() => {
    const g = new Map<string, Entry[]>();
    for (const e of rows) {
      const d = dateOnly(e.at);
      g.set(d, [...(g.get(d) ?? []), e]);
    }
    return [...g.entries()];
  }, [rows]);
  // Filter pickers.
  const [pick, setPick] = useState<"" | "actor" | "action" | "date">("");
  const [actorQ, setActorQ] = useState("");
  const [actionQ, setActionQ] = useState("");
  const seenActors = useMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of loaded) m.set(e.actor_email ?? e.actor_label, e);
    return [...m.entries()];
  }, [loaded]);
  const people = seenActors.filter(([, e]) => !isAuto(e));
  const autos = seenActors.filter(([, e]) => isAuto(e));
  const matchQ = (k: string) => !actorQ.trim() || k.toLowerCase().includes(actorQ.trim().toLowerCase());
  const actionList = Object.keys(ACTIONS).filter((a) => {
    const t = actionQ.trim().toLowerCase();
    return !t || a.includes(t) || actionName(a, lang).toLowerCase().includes(t);
  });
  const today = siteToday();
  const presets: [string, string, string][] = [
    [tr("今天", "Today"), today, today],
    [tr("近 7 天", "7 days"), daysBefore(today, 6), today],
    [tr("近 30 天", "30 days"), daysBefore(today, 29), today],
  ];
  const dateValue =
    from || to ? (from === to ? from : `${from || tr("最早", "start")} – ${to || tr("今天", "today")}`) : null;
  const setActor = (v: string | null) => {
    patch({ actor: v || null });
    setPick("");
  };
  const setAction = (v: string | null) => {
    patch({ action: v || null });
    setPick("");
  };
  const loadMore = (from || to ? moreInRange : q.hasNextPage) && (
    <Button
      variant="outline"
      className="justify-self-center"
      loading={q.isFetchingNextPage}
      onClick={() => void q.fetchNextPage()}
    >
      {tr("加载更早的记录", "Load older entries")}
    </Button>
  );
  return (
    <>
      <PageHeader
        title={tr("审计日志", "Audit log")}
        description={tr(
          "谁在什么时候改了什么；记录只读，按 系统设置 → 数据保留 的天数自动清理",
          "Who changed what, when; read-only, cleaned up after Settings → Data retention",
        )}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label={tr("筛选", "Filters")}>
        <Pill
          label={tr("操作者", "Actor")}
          value={actor || null}
          icon={User}
          onClear={() => setActor(null)}
          open={pick === "actor"}
          onOpenChange={(o) => setPick(o ? "actor" : "")}
        >
          <form
            className="p-1 pb-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (actorQ.trim()) setActor(actorQ.trim());
            }}
          >
            <Input
              value={actorQ}
              onChange={(e) => setActorQ(e.target.value)}
              aria-label={tr("操作者邮箱或标签", "Actor email or label")}
              placeholder={tr("输入邮箱或标签，回车筛选", "Email or label, Enter to filter")}
              className="h-8"
              data-nodirty
            />
          </form>
          <div className="max-h-64 overflow-y-auto">
            {people.filter(([k]) => matchQ(k)).length > 0 && (
              <div className="px-2.5 pt-1.5 pb-1 text-caption font-semibold text-faint">{tr("管理员", "Admins")}</div>
            )}
            {people
              .filter(([k]) => matchQ(k))
              .map(([k, e]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setActor(e.actor_email ?? e.actor_label)}
                  className="flex h-8 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-body hover:bg-accent pointer-coarse:h-11"
                >
                  <Avatar name={k} size={18} />
                  <span className="truncate">{k}</span>
                </button>
              ))}
            <div className="px-2.5 pt-1.5 pb-1 text-caption font-semibold text-faint">
              {tr("自动执行", "Automatic")}
            </div>
            {(autos.length ? autos.map(([k]) => k) : ["system", "cli"]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setActor(k)}
                className="flex h-8 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-body hover:bg-accent pointer-coarse:h-11"
              >
                <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
                {k === "system"
                  ? tr("系统（定时任务）", "System (periodic jobs)")
                  : k === "cli"
                    ? tr("命令行", "Command line")
                    : k}
              </button>
            ))}
          </div>
        </Pill>
        <Pill
          label={tr("动作", "Action")}
          value={action ? (ACTIONS[action] ? actionName(action, lang) : action) : null}
          icon={Shapes}
          onClear={() => setAction(null)}
          open={pick === "action"}
          onOpenChange={(o) => setPick(o ? "action" : "")}
        >
          <form
            className="p-1 pb-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (actionQ.trim()) setAction(actionQ.trim());
            }}
          >
            <Input
              value={actionQ}
              onChange={(e) => setActionQ(e.target.value)}
              aria-label={tr("动作代码或前缀", "Action code or prefix")}
              placeholder={tr("名称、代码或前缀（如 user.），回车筛选", "Name, code or prefix (user.), Enter")}
              className="h-8"
              data-nodirty
            />
          </form>
          <div className="max-h-72 overflow-y-auto">
            {actionList.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAction(a)}
                className="flex min-h-8 w-full items-center gap-2 rounded-[7px] px-2.5 py-1 text-left text-body hover:bg-accent pointer-coarse:min-h-11"
              >
                <span className="min-w-0 flex-1 truncate">{actionName(a, lang)}</span>
                <span className="shrink-0 font-mono text-caption text-faint">{a}</span>
              </button>
            ))}
          </div>
        </Pill>
        <Pill
          label={tr("日期", "Date")}
          value={dateValue}
          icon={CalendarDays}
          onClear={() => patch({ from: null, to: null })}
          open={pick === "date"}
          onOpenChange={(o) => setPick(o ? "date" : "")}
        >
          <div className="p-1.5">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {presets.map(([l, f, t]) => (
                <Button
                  key={l}
                  size="sm"
                  variant={from === f && to === t ? "soft" : "secondary"}
                  onClick={() => {
                    patch({ from: f, to: t });
                    setPick("");
                  }}
                >
                  {l}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-footnote text-muted-foreground">
                {tr("从", "From")}
                <Input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => patch({ from: e.target.value || null }, true)}
                  data-nodirty
                />
              </label>
              <label className="grid gap-1 text-footnote text-muted-foreground">
                {tr("到", "To")}
                <Input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => patch({ to: e.target.value || null }, true)}
                  data-nodirty
                />
              </label>
            </div>
            <p className="mt-2 text-caption text-faint">
              {tr(`按站点时区 ${siteTimeZone()} 的自然日`, `Calendar days in the site time zone ${siteTimeZone()}`)}
            </p>
          </div>
        </Pill>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clear}>
            {tr("清除全部", "Clear all")}
          </Button>
        )}
        <span className="ml-auto text-footnote text-faint max-sm:basis-full" role="status">
          {from || to ? (
            <>
              {tr(`已加载的 ${loaded.length} 条里匹配 `, `${loaded.length} loaded, `)}
              <b className="tnum text-foreground">{rows.length}</b>
              {tr(" 条", " in the date range")}
            </>
          ) : (
            tr(`已加载最近 ${loaded.length} 条`, `${loaded.length} latest loaded`)
          )}
        </span>
      </div>
      {who.missing && (
        <div className="mb-3">
          <Callout tone="warning">{tr(`没有邮箱为 ${actor} 的账户。`, `No account has the address ${actor}.`)}</Callout>
        </div>
      )}
      {!who.missing && (q.isPending || who.label === null) ? (
        <Card>
          <SkeletonRows rows={8} height={60} />
        </Card>
      ) : q.isError && loaded.length === 0 ? (
        <Card>
          <ErrorState
            title={tr("审计日志加载失败", "The audit log did not load")}
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        </Card>
      ) : rows.length === 0 && !filtered ? (
        <Card>
          <EmptyState
            icon={History}
            title={tr("还没有审计记录", "No audit entries yet")}
            description={tr(
              "管理员的操作、系统的自动处理都会记在这里。",
              "Admin actions and the system's own changes are recorded here.",
            )}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileText}
            title={tr("没有匹配的记录", "No matching entries")}
            description={
              from || to
                ? tr(
                    "日期筛选只作用在已加载的记录上。更早的记录可能有匹配。",
                    "The date filter applies to the loaded entries; older ones may match.",
                  )
                : undefined
            }
            action={
              <>
                <Button variant="outline" onClick={clear}>
                  {tr("清除筛选", "Clear filters")}
                </Button>
                {q.hasNextPage && (
                  <Button variant="soft" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                    {tr("加载更早再找", "Load older and look again")}
                  </Button>
                )}
              </>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-5">
          {days.map(([day, evs]) => (
            <section key={day}>
              <div className="mb-2 flex items-baseline gap-2 px-1">
                <h2 className="text-headline font-semibold">{dayLabel(day, tr, lang)}</h2>
                <span className="tnum text-footnote text-faint">
                  {day} · {tr(`${evs.length} 条`, `${evs.length}`)}
                </span>
              </div>
              <Card className="overflow-hidden">
                <ol className="relative">
                  {evs.map((e, i) => {
                    const n = auditDiff(e.before, e.after, tr).length;
                    const openIt = () => patch({ open: String(e.id), entry: null });
                    return (
                      <li key={e.id} className="relative" data-row data-entry={e.id}>
                        {i < evs.length - 1 && (
                          <span className="absolute top-11 bottom-0 left-[30px] w-px bg-separator" aria-hidden="true" />
                        )}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={openIt}
                          onKeyDown={(k) => k.key === "Enter" && k.target === k.currentTarget && openIt()}
                          className="flex cursor-default items-start gap-3 px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                        >
                          <span className="relative z-[1] pt-0.5">
                            <ActorMark e={e} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="text-body">
                              <Sentence e={e} />
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-muted-foreground">
                              <Badge tone={DANGER.test(e.action) ? "danger" : isAuto(e) ? "neutral" : "outline"}>
                                <Tag aria-hidden="true" />
                                {actionName(e.action, lang)}
                              </Badge>
                              {n > 0 && <span>{tr(`${n} 个字段变更`, `${n} field(s) changed`)}</span>}
                              {e.ip && <span className="font-mono text-caption text-faint max-sm:hidden">{e.ip}</span>}
                            </div>
                          </div>
                          <span className="tnum shrink-0 pt-0.5 text-footnote text-muted-foreground">
                            {dateTime(e.at).slice(11, 16)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Card>
            </section>
          ))}
          {loadMore}
        </div>
      )}
      {open && (
        <EntryDialog e={current} loading={q.isPending} onClose={() => patch({ open: null, entry: null }, true)} />
      )}
    </>
  );
}

function EntryDialog({ e, loading, onClose }: { e: Entry | undefined; loading: boolean; onClose: () => void }) {
  const tr = useTr();
  const lang = useLang();
  const rows = e ? auditDiff(e.before, e.after, tr) : [];
  const href = e ? targetHref(e.target_type, e.target_id) : null;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={Tag}
      title={e ? actionName(e.action, lang) : tr("审计记录", "Audit entry")}
      description={e ? tr(`记录 #${e.id} · ${dateTime(e.at)}`, `Entry #${e.id} · ${dateTime(e.at)}`) : undefined}
      footer={
        <>
          <span className="mr-auto text-footnote text-faint max-sm:hidden">
            {tr("审计记录只读，不能修改或删除", "Audit entries are read-only")}
          </span>
          {href && (
            <Button variant="secondary" icon={ExternalLink} asChild>
              <Link to={href}>{tr("打开对象", "Open the object")}</Link>
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            {tr("关闭", "Close")}
          </Button>
        </>
      }
    >
      {!e ? (
        loading ? (
          <SkeletonRows rows={4} />
        ) : (
          <Callout tone="info">{tr("这条记录不在已加载的列表里。", "This entry is not in the loaded list.")}</Callout>
        )
      ) : (
        <>
          <div className="mb-4 flex items-start gap-3 rounded-lg bg-window px-3.5 py-3 text-callout ring-1 ring-border ring-inset">
            <ActorMark e={e} size={28} />
            <Sentence e={e} />
          </div>
          <h4 className="mb-2 text-footnote font-semibold text-muted-foreground">{tr("变更", "Changes")}</h4>
          {rows.length ? (
            <div className="overflow-hidden rounded-lg ring-1 ring-border ring-inset">
              <div className="grid grid-cols-[minmax(80px,0.6fr)_1fr_1fr] border-b border-separator bg-window px-3 py-1.5 text-footnote text-muted-foreground max-sm:hidden">
                <span>{tr("字段", "Field")}</span>
                <span>{tr("之前", "Before")}</span>
                <span>{tr("之后", "After")}</span>
              </div>
              {rows.map((d) => (
                <div
                  key={d.field || "v"}
                  className="grid grid-cols-1 gap-1 border-b border-separator px-3 py-2 last:border-0 sm:grid-cols-[minmax(80px,0.6fr)_1fr_1fr] sm:gap-3"
                >
                  <span className="font-mono text-footnote font-medium break-all text-muted-foreground sm:pt-0.5">
                    {d.field || tr("值", "value")}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 sm:contents">
                    <span className="min-w-0">
                      {d.before !== "—" ? (
                        <span className="inline-block rounded bg-destructive-soft px-1.5 py-0.5 text-body break-all text-destructive">
                          <span className="mr-1 font-mono text-caption" aria-hidden="true">
                            −
                          </span>
                          <span className="line-through decoration-destructive/40">{d.before}</span>
                        </span>
                      ) : (
                        <span className="text-footnote text-faint">{tr("（无）", "(none)")}</span>
                      )}
                    </span>
                    <span className="text-faint sm:hidden" aria-hidden="true">
                      →
                    </span>
                    <span className="min-w-0">
                      {d.after !== "—" ? (
                        <span className="inline-block rounded bg-success-soft px-1.5 py-0.5 text-body break-all text-success">
                          <span className="mr-1 font-mono text-caption" aria-hidden="true">
                            +
                          </span>
                          {d.after}
                        </span>
                      ) : (
                        <span className="text-footnote text-faint">{tr("（已删除）", "(removed)")}</span>
                      )}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-lg bg-window px-3 py-2.5 text-footnote text-muted-foreground ring-1 ring-border ring-inset">
              {tr("这个动作没有字段级的变更记录。", "No field-level changes recorded for this action.")}
            </p>
          )}
          <h4 className="mt-5 mb-2 text-footnote font-semibold text-muted-foreground">{tr("请求", "Request")}</h4>
          <KV
            cols={3}
            items={[
              {
                k: tr("时间", "Time"),
                v: tr(`${dateTime(e.at)}（${siteTimeZone()}）`, `${dateTime(e.at)} (${siteTimeZone()})`),
                span: 2,
              },
              { k: tr("动作代码", "Action code"), v: e.action, mono: true },
              {
                k: tr("操作者", "Actor"),
                v: isAuto(e)
                  ? tr(`${actorText(e, tr)}（自动执行）`, `${actorText(e, tr)} (automatic)`)
                  : `${actorText(e, tr)}${e.actor_email ? ` · ${e.actor_label}` : ""}`,
              },
              { k: "IP", v: e.ip ?? tr("—（内部任务）", "— (internal)"), mono: !!e.ip },
              {
                k: tr("对象", "Object"),
                v: e.target_type ? (
                  <span className="break-all">
                    {targetName(e.target_type, tr)} <span className="font-mono text-footnote">{e.target_id}</span>
                  </span>
                ) : (
                  "—"
                ),
              },
            ]}
          />
        </>
      )}
    </Dialog>
  );
}
