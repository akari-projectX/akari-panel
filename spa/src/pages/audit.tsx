import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorText, TableNote } from "../components/status";
import { get, type AuditEntry, type AuditPage } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { fmtDateTime, TZ_LABEL } from "../lib/datetime";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const PAGE = 50;

/** Chinese names of the audited actions (W21, audit M6); unknown ones show their code. */
export const ACTION_ZH: Record<string, string> = {
  "auth.login": "登录",
  "auth.login_failed": "登录失败",
  "user.create": "新建用户",
  "user.update": "修改用户",
  "user.delete": "删除用户",
  "user.register": "自助注册",
  "user.revoke_sessions": "吊销会话",
  "user.password.change": "修改密码",
  "user.password.reset": "找回密码",
  "user.email.change": "更换邮箱",
  "user.sub_token.rotate": "重新生成订阅令牌",
  "user.totp.enable": "开启两步验证",
  "user.totp.reset": "重置两步验证",
  "user.totp.recovery_codes": "重新生成恢复码",
  "user.plan.set": "分配套餐",
  "user.plan.update": "修改用户套餐",
  "user.plan.cancel": "取消套餐",
  "user.plan.expire": "套餐到期",
  "user.traffic.reset": "流量重置",
  "plan.create": "新建套餐",
  "plan.update": "修改套餐",
  "plan.delete": "删除套餐",
  "plan.price.set": "设置套餐价格",
  "group.create": "新建节点组",
  "group.update": "修改节点组",
  "group.delete": "删除节点组",
  "node.create": "新建节点",
  "node.update": "修改节点",
  "node.delete": "删除节点",
  "node.enroll": "节点注册",
  "node.enroll_token": "生成安装命令 / 注册令牌",
  "node.set_inbounds": "修改入站",
  "node.assign": "手动分配节点",
  "node.unassign": "取消分配节点",
  "node.groups.set": "修改节点所属组",
  "node.probe": "立即测速",
  "node.cert.renew": "agent 证书续期",
  "node.cert.rotated": "agent 证书轮换",
  "node.alert_rules.set": "修改节点告警规则",
  "order.create": "创建订单",
  "order.paid": "订单付款",
  "order.cancel": "取消订单",
  "order.expire": "订单过期",
  "order.refund": "订单退款",
  "order.fulfil.retry": "重试开通",
  "order.payment.rejected": "拒绝付款通知",
  "coupon.create": "新建优惠券",
  "coupon.update": "修改优惠券",
  "coupon.delete": "删除优惠券",
  "balance.commission": "返利入账",
  "balance.admin_adjust": "人工调整余额",
  "balance.order_payment": "余额支付",
  "balance.refund_to_balance": "退款到余额",
  "balance.withdrawal": "提现扣款",
  "balance.withdrawal_reversal": "提现退回",
  "commission.create": "生成返利",
  "commission.reverse": "撤销返利",
  "commission.settings.update": "修改返利设置",
  "withdrawal.approved": "提现已打款",
  "withdrawal.rejected": "拒绝提现",
  "withdrawal.cancelled": "撤销提现",
  "invite.create": "新建邀请码",
  "invite.delete": "删除邀请码",
  "ticket.create": "新建工单",
  "ticket.reply": "回复工单",
  "ticket.close": "关闭工单",
  "ticket.reopen": "重新打开工单",
  "ticket.assign": "分配工单",
  "alerts.ack": "确认告警",
  "alerts.settings.update": "修改告警设置",
  "alerts.test": "测试告警通道",
  "alerts.notification.retry": "重试告警通知",
  "agent_release.create": "上传发布清单",
  "agent_release.upload": "上传 agent 程序",
  "agent_release.delete": "删除发布",
  "rollout.create": "创建灰度更新",
  "rollout.pause": "暂停灰度更新",
  "rollout.resume": "继续灰度更新",
  "rollout.abort": "中止灰度更新",
  "rollout.wave": "灰度更新下一批",
  "rollout.halt": "灰度更新自动暂停",
  "rollout.complete": "灰度更新完成",
  "settings.update": "修改域名设置",
  "settings.probe.update": "修改测速设置",
  "settings.site.update": "修改站点名称",
  "settings.server_name.remove": "移除证书域名",
  "settings.signup.update": "修改注册设置",
  "settings.mail.update": "修改邮件设置",
  "settings.mail.test": "发送测试邮件",
  "mail.retry": "重试失败邮件",
  "secrets.rotate_prefix": "轮换路径前缀",
  "secrets.rotate_jwt": "轮换会话密钥",
};

const TARGET_ZH: Record<string, string> = {
  user: "用户",
  node: "节点",
  plan: "套餐",
  group: "节点组",
  order: "订单",
  coupon: "优惠券",
  withdrawal: "提现",
  commission: "返利",
  ticket: "工单",
  settings: "设置",
  rollout: "灰度更新",
  agent_release: "发布",
  alert: "告警",
  invite: "邀请码",
  mail: "邮件",
};

/** Field names in the diff (unknown fields show their key). */
const FIELD_ZH: Record<string, string> = {
  login: "账号",
  role: "角色",
  enabled: "启用",
  email: "邮箱",
  password: "密码",
  sub_token: "订阅令牌",
  traffic_limit_bytes: "流量上限",
  traffic_used_bytes: "已用流量",
  expires_at: "到期时间",
  disabled_reason: "停用原因",
  name: "名称",
  description: "说明",
  period: "重置周期",
  traffic_quota_bytes: "流量额度",
  speed_limit_mbps: "限速（Mbps）",
  capacity: "库存",
  on_sale: "上架",
  prices: "价格",
  group_ids: "节点组",
  node_ids: "节点",
  plan_id: "套餐",
  server_addr: "公网地址",
  region: "地区",
  tls_domain: "节点域名",
  inbounds: "入站",
  main_domain: "主域名",
  sub_domain: "订阅域名",
  node_domain: "节点通信域名",
  trust_cloudflare: "信任 Cloudflare",
  site_name: "站点名称",
  amount_cents: "金额（分）",
  status: "状态",
  reason: "原因",
};

function show(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "（空）";
  if (v === "changed") return "（已更改）";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface FieldChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

/**
 * The field-level changes of an entry: for an update only the fields whose
 * values differ; for a create (no before) / delete (no after) every field.
 */
export function auditDiff(before: unknown, after: unknown): FieldChange[] {
  if (!isObject(before) && !isObject(after)) {
    if (before == null && after == null) return [];
    return [{ field: "", label: "值", before: show(before ?? undefined), after: show(after ?? undefined) }];
  }
  const b = isObject(before) ? before : {};
  const a = isObject(after) ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const out: FieldChange[] = [];
  for (const k of keys) {
    const changed = JSON.stringify(b[k]) !== JSON.stringify(a[k]) || a[k] === "changed";
    if (isObject(before) && isObject(after) && !changed) continue;
    out.push({
      field: k,
      label: FIELD_ZH[k] ?? k,
      before: isObject(before) ? show(b[k]) : "—",
      after: isObject(after) ? show(a[k]) : "—",
    });
  }
  return out;
}

function query(before: number | null, actor: string, action: string): string {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (before != null) p.set("before", String(before));
  if (actor) p.set("actor", actor);
  if (action) p.set("action", action);
  return `/audit?${p.toString()}`;
}

function Changes({ e }: { e: AuditEntry }) {
  const rows = auditDiff(e.before, e.after);
  if (rows.length === 0) return <span className="text-muted-foreground">—</span>;
  const list = (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map((r) => (
        <div key={r.field || "value"} className="contents">
          <dt className="whitespace-nowrap text-muted-foreground">{r.label}</dt>
          <dd className="min-w-0 break-all">
            {e.before != null && e.after != null ? (
              <>
                <span className="text-muted-foreground line-through decoration-muted-foreground/50">{r.before}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only">改为</span>
                <span>{r.after}</span>
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
  if (rows.length <= 6) return list;
  return (
    <details>
      <summary className="cursor-pointer text-xs">{rows.length} 个字段</summary>
      <div className="mt-1">{list}</div>
    </details>
  );
}

// Admin audit log (Chinese only): newest first, keyset pagination.
export function AdminAudit() {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [filter, setFilter] = useState({ actor: "", action: "" });
  const pages = useInfiniteQuery({
    queryKey: ["audit", filter],
    queryFn: ({ pageParam }) => get<AuditPage>(query(pageParam, filter.actor, filter.action)),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before,
  });
  const entries = (pages.data?.pages ?? []).flatMap((p) => p.entries);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>审计日志</h1>
        </CardTitle>
        <CardDescription>所有管理操作、登录与密钥轮换。秘密内容从不记录，只记录“已更改”。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          aria-label="筛选审计日志"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ actor: actor.trim(), action: action.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="audit-actor">操作者</Label>
            <Input
              id="audit-actor"
              placeholder="账号，或 cli / system"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-action">操作</Label>
            <Input
              id="audit-action"
              list="audit-actions"
              placeholder="如 user.update，或前缀 user."
              value={action}
              onChange={(e) => setAction(e.target.value)}
            />
            <datalist id="audit-actions">
              {Object.entries(ACTION_ZH).map(([code, zh]) => (
                <option key={code} value={code}>
                  {zh}
                </option>
              ))}
            </datalist>
          </div>
          <Button type="submit" variant="outline">
            筛选
          </Button>
        </form>
        {pages.isError && <ErrorText>{adminErrorText(pages.error)}</ErrorText>}
        <Table label="审计记录">
          <TableHeader>
            <TableRow>
              <TableHead>时间（{TZ_LABEL}）</TableHead>
              <TableHead>操作者</TableHead>
              <TableHead>地址</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>对象</TableHead>
              <TableHead>变更</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pages.isPending && <TableNote colSpan={6}>加载中…</TableNote>}
            {pages.isSuccess && entries.length === 0 && <TableNote colSpan={6}>没有符合条件的记录。</TableNote>}
            {entries.map((e) => (
              <TableRow key={e.id} className="align-top">
                <TableCell className="whitespace-nowrap align-top text-muted-foreground">
                  {fmtDateTime(e.at, true)}
                </TableCell>
                <TableCell className="whitespace-nowrap align-top font-medium">{e.actor_login}</TableCell>
                <TableCell className="whitespace-nowrap align-top text-muted-foreground">{e.ip ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap align-top">
                  {ACTION_ZH[e.action] ?? e.action}
                  {ACTION_ZH[e.action] && <span className="block text-xs text-muted-foreground">{e.action}</span>}
                </TableCell>
                <TableCell className="align-top text-xs text-muted-foreground">
                  {e.target_type ? (
                    <>
                      {TARGET_ZH[e.target_type] ?? e.target_type}
                      {e.target_id && <span className="block max-w-48 truncate font-mono">{e.target_id}</span>}
                    </>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="min-w-64 max-w-xl align-top">
                  <Changes e={e} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {pages.hasNextPage && (
          <Button variant="outline" size="sm" onClick={() => pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
            加载更早的记录
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
