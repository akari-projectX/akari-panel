// W15 系统设置 → 注册 / 邮件（后台，仅中文）。类型手工镜像 src/signup/mod.rs
// 的 SignupView 与 src/mail/mod.rs 的 SmtpView / OutboxRow。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { ApiError, get, post, put, type PlanView } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { fmtDateTime } from "../lib/datetime";

export interface SignupView {
  version: number;
  register_enabled: boolean;
  invite_required: boolean;
  invite_single_use: boolean;
  invite_codes_per_user: number;
  email_domains: string[];
  trial_plan_id: string | null;
  trial_days: number;
  reset_enabled: boolean;
  // W24: null = 自动（已启用邮件发送时验证）。
  email_verify: boolean;
  mail_enabled: boolean;
  public_origin: string | null;
  warnings: string[];
}

export type Security = "starttls" | "tls" | "none";

export interface SmtpView {
  version: number;
  enabled: boolean;
  host: string | null;
  port: number;
  security: Security;
  username: string | null;
  password_set: boolean;
  from_addr: string | null;
  from_name: string | null;
  notify_order_paid: boolean;
  notify_expiry_days: number;
  notify_expired: boolean;
  notify_quota: boolean;
  dead_letters: number;
  pending: number;
  warnings: string[];
}

export interface OutboxRow {
  id: number;
  kind: string;
  to_addr: string;
  subject: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string;
  settled_at: string | null;
  retryable: boolean;
}

export const KIND_LABEL: Record<string, string> = {
  register_code: "注册验证码",
  register_exists: "已注册提醒",
  email_code: "邮箱验证码",
  password_reset: "重置密码",
  order_paid: "支付回执",
  expiry_soon: "到期提醒",
  expired: "已到期",
  quota_80: "流量 80%",
  quota_100: "流量用完",
  test: "测试邮件",
  ticket_reply: "工单回复",
  ticket_new: "新工单",
  node_alert: "节点告警",
};

/** One domain per line or comma; "@" prefixes allowed (the server normalises). */
export function parseDomains(text: string): string[] {
  return text
    .split(/[\s,，]+/)
    .map((d) => d.trim())
    .filter(Boolean);
}

const errText = (err: unknown, context: string) => adminErrorText(err, context);

function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      {items.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}

function Check(props: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={props.id} className="flex items-center gap-2 text-sm">
        <input
          id={props.id}
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        {props.label}
      </label>
      {props.hint && <p className="pl-6 text-xs text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

/** 系统设置 → 注册 / 邮件 / 失败邮件 (W21: one tab each; all three without `part`). */
export function MailSettings({ part }: { part?: "signup" | "mail" | "failed" }) {
  const showSignup = part == null || part === "signup";
  const showSmtp = part == null || part === "mail";
  const showFailed = part == null || part === "failed";
  const signup = useQuery({
    queryKey: ["settings-signup"],
    queryFn: () => get<SignupView>("/settings/signup"),
    enabled: showSignup,
  });
  const smtp = useQuery({ queryKey: ["settings-mail"], queryFn: () => get<SmtpView>("/settings/mail") });
  // The version each form last saved (its success note shows while that is current).
  const [savedVersion, setSavedVersion] = useState<{ signup?: number; smtp?: number }>({});
  return (
    <>
      {showSignup && signup.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errText(signup.error, "加载注册设置失败")}
        </p>
      )}
      {/* key：保存（或他人修改）后表单回到服务器的值；「已保存」提示放在这里，重新挂载后仍然显示 */}
      {showSignup && signup.data && (
        <SignupForm
          key={`signup-${signup.data.version}`}
          data={signup.data}
          saved={savedVersion.signup === signup.data.version}
          onSaved={(v) => setSavedVersion((s) => ({ ...s, signup: v }))}
        />
      )}
      {smtp.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errText(smtp.error, "加载邮件设置失败")}
        </p>
      )}
      {showSmtp && smtp.data && (
        <SmtpForm
          key={`smtp-${smtp.data.version}`}
          data={smtp.data}
          saved={savedVersion.smtp === smtp.data.version}
          onSaved={(v) => setSavedVersion((s) => ({ ...s, smtp: v }))}
        />
      )}
      {showFailed && smtp.data && <DeadLetters count={smtp.data.dead_letters} />}
    </>
  );
}

interface FormProps<T> {
  data: T;
  saved: boolean;
  onSaved: (version: number) => void;
}

function SignupForm({ data, saved, onSaved }: FormProps<SignupView>) {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
  const [register, setRegister] = useState(data.register_enabled);
  const [inviteRequired, setInviteRequired] = useState(data.invite_required);
  const [singleUse, setSingleUse] = useState(data.invite_single_use);
  const [perUser, setPerUser] = useState(String(data.invite_codes_per_user));
  const [domains, setDomains] = useState(data.email_domains.join("\n"));
  const [trialPlan, setTrialPlan] = useState(data.trial_plan_id ?? "");
  const [trialDays, setTrialDays] = useState(String(data.trial_days));
  const [reset, setReset] = useState(data.reset_enabled);
  const [verify, setVerify] = useState(data.email_verify);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const n = Number(perUser);
    const days = Number(trialDays);
    if (!Number.isInteger(n) || n < 0 || n > 100) return setError("每人邀请码数量须为 0–100 的整数");
    if (!Number.isInteger(days) || days < 1 || days > 3650) return setError("试用天数须为 1–3650 的整数");
    setBusy(true);
    try {
      const res = await put<SignupView>("/settings/signup", {
        version: data.version,
        register_enabled: register,
        invite_required: inviteRequired,
        invite_single_use: singleUse,
        invite_codes_per_user: n,
        email_domains: parseDomains(domains),
        trial_plan_id: trialPlan || null,
        trial_days: days,
        reset_enabled: reset,
        email_verify: verify,
      });
      onSaved(res.version);
      qc.setQueryData(["settings-signup"], res);
    } catch (err) {
      setError(errText(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>注册</h2>
        </CardTitle>
        <CardDescription>
          开放用户自助注册与通过邮件找回密码，两者默认关闭。未配置邮件发送时也可以开放注册（邮箱 + 密码，不验证邮箱）；
          找回密码需要邮件发送，链接使用主域名{data.public_origin ? `（${data.public_origin}）` : "（尚未设置）"}。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={save} noValidate>
          <Warnings items={data.warnings} />
          <Check
            id="su-register"
            label="开放注册"
            checked={register}
            onChange={setRegister}
            hint="登录页显示「注册」。新用户的账号即邮箱，注册后可直接登录。"
          />
          <div className="space-y-3 pl-6">
            <Check
              id="su-verify"
              label="注册需要邮箱验证"
              checked={verify}
              onChange={setVerify}
              hint="开启后注册须填写邮件验证码（需要邮件发送）。关闭时用户直接以邮箱 + 密码注册，邮箱为「未验证」状态（不能用于找回密码，可在账户页验证，管理员也可标记为已验证）；防滥用由内置人机校验与按 IP / 邮箱的频率限制负责。"
            />
            <Check
              id="su-invite"
              label="必须使用邀请码"
              checked={inviteRequired}
              onChange={setInviteRequired}
              hint="用户在门户中生成邀请码并分享链接。"
            />
            <Check id="su-single" label="每个邀请码只能使用一次" checked={singleUse} onChange={setSingleUse} />
            <div className="space-y-1.5">
              <Label htmlFor="su-per-user">每个用户最多的邀请码数量</Label>
              <Input
                id="su-per-user"
                type="number"
                min={0}
                max={100}
                className="w-32"
                value={perUser}
                onChange={(e) => setPerUser(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="su-domains">邮箱域名白名单</Label>
              <textarea
                id="su-domains"
                className="min-h-16 w-full rounded-lg border border-border bg-transparent px-3 py-2 font-mono text-sm"
                value={domains}
                placeholder="留空 = 不限制；每行一个，如 gmail.com"
                onChange={(e) => setDomains(e.target.value)}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">列出的域名及其子域名可以注册（最多 100 个）。</p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="su-trial">试用套餐</Label>
                <select
                  id="su-trial"
                  className="h-9 rounded-lg border border-border bg-transparent px-3 text-sm"
                  value={trialPlan}
                  onChange={(e) => setTrialPlan(e.target.value)}
                >
                  <option value="">不赠送</option>
                  {(plans.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.enabled ? "" : "（已停用）"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-trial-days">试用天数</Label>
                <Input
                  id="su-trial-days"
                  type="number"
                  min={1}
                  max={3650}
                  className="w-28"
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                />
              </div>
            </div>
          </div>
          <Check
            id="su-reset"
            label="允许通过邮件找回密码"
            checked={reset}
            onChange={setReset}
            hint="登录页显示「忘记密码」。重置链接只发往已验证的邮箱，30 分钟内有效；重置后该账号所有会话失效。"
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {saved && <p className="text-sm text-emerald-700">已保存。</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存注册设置"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

const SECURITY_PORT: Record<Security, number> = { starttls: 587, tls: 465, none: 25 };

function SmtpForm({ data, saved, onSaved }: FormProps<SmtpView>) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(data.enabled);
  const [host, setHost] = useState(data.host ?? "");
  const [port, setPort] = useState(String(data.port));
  const [security, setSecurity] = useState<Security>(data.security);
  const [username, setUsername] = useState(data.username ?? "");
  const [password, setPassword] = useState("");
  const [fromAddr, setFromAddr] = useState(data.from_addr ?? "");
  const [fromName, setFromName] = useState(data.from_name ?? "");
  const [paid, setPaid] = useState(data.notify_order_paid);
  const [expiryDays, setExpiryDays] = useState(String(data.notify_expiry_days));
  const [expired, setExpired] = useState(data.notify_expired);
  const [quota, setQuota] = useState(data.notify_quota);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  function changeSecurity(s: Security) {
    // Follow the conventional port when it was the previous default.
    if (Number(port) === SECURITY_PORT[security]) setPort(String(SECURITY_PORT[s]));
    setSecurity(s);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const p = Number(port);
    const days = Number(expiryDays);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setError("端口须为 1–65535");
    if (!Number.isInteger(days) || days < 0 || days > 30) return setError("到期提醒天数须为 0–30 的整数");
    if (security === "none" && username.trim())
      return setError("未加密连接不能使用用户名和密码，请选择 STARTTLS 或 SSL/TLS");
    const body: Record<string, unknown> = {
      version: data.version,
      enabled,
      host: host.trim() || null,
      port: p,
      security,
      username: username.trim() || null,
      from_addr: fromAddr.trim() || null,
      from_name: fromName.trim() || null,
      notify_order_paid: paid,
      notify_expiry_days: days,
      notify_expired: expired,
      notify_quota: quota,
    };
    // Absent = keep the stored password.
    if (password) body.password = password;
    setBusy(true);
    try {
      const res = await put<SmtpView>("/settings/mail", body);
      onSaved(res.version);
      qc.setQueryData(["settings-mail"], res);
      await qc.invalidateQueries({ queryKey: ["settings-signup"] });
    } catch (err) {
      setError(errText(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTestMsg(null);
    setTesting(true);
    try {
      await post("/settings/mail/test", { to: testTo.trim() });
      setTestMsg({ ok: true, text: `测试邮件已发出，请检查 ${testTo.trim()} 的收件箱。` });
    } catch (err) {
      // 502 = the SMTP server's own answer: show it verbatim.
      const text =
        err instanceof ApiError && err.status === 502 ? `发送失败：${err.message}` : errText(err, "发送失败");
      setTestMsg({ ok: false, text });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>邮件</h2>
        </CardTitle>
        <CardDescription>
          SMTP 发信设置。邮件先进入发件队列，由后台发送并自动重试（不会拖慢用户请求）；多次失败的进入「失败邮件」。
          密码加密保存，界面不显示。
          {data.pending > 0 ? ` 当前排队 ${data.pending} 封。` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form className="space-y-5" onSubmit={save} noValidate>
          <Warnings items={data.warnings} />
          <Check id="smtp-enabled" label="启用邮件发送" checked={enabled} onChange={setEnabled} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-host">SMTP 服务器</Label>
              <Input
                id="smtp-host"
                value={host}
                placeholder="smtp.example.com"
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <div className="flex gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="smtp-security">加密方式</Label>
                <select
                  id="smtp-security"
                  className="h-9 rounded-lg border border-border bg-transparent px-3 text-sm"
                  value={security}
                  onChange={(e) => changeSecurity(e.target.value as Security)}
                >
                  <option value="starttls">STARTTLS（587）</option>
                  <option value="tls">SSL/TLS（465）</option>
                  <option value="none">不加密（仅本机/内网）</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-port">端口</Label>
                <Input
                  id="smtp-port"
                  type="number"
                  min={1}
                  max={65535}
                  className="w-24"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-user">用户名</Label>
              <Input
                id="smtp-user"
                autoComplete="off"
                value={username}
                placeholder="留空 = 不认证"
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-password">密码</Label>
              <Input
                id="smtp-password"
                type="password"
                autoComplete="new-password"
                value={password}
                placeholder={data.password_set ? "已保存，留空不修改" : "未设置"}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-from">发件地址</Label>
              <Input
                id="smtp-from"
                type="email"
                value={fromAddr}
                placeholder="noreply@example.com"
                onChange={(e) => setFromAddr(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-name">发件人名称</Label>
              <Input
                id="smtp-name"
                value={fromName}
                maxLength={64}
                placeholder="Akari（也用作邮件里的站点名称）"
                onChange={(e) => setFromName(e.target.value)}
              />
            </div>
          </div>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">通知邮件（发往已验证的邮箱）</legend>
            <Check id="smtp-paid" label="支付成功回执" checked={paid} onChange={setPaid} />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Label htmlFor="smtp-expiry-days">到期前</Label>
              <Input
                id="smtp-expiry-days"
                type="number"
                min={0}
                max={30}
                className="w-20"
                value={expiryDays}
                onChange={(e) => setExpiryDays(e.target.value)}
              />
              <span>天发送到期提醒（0 = 不提醒）</span>
            </div>
            <Check id="smtp-expired" label="套餐到期通知" checked={expired} onChange={setExpired} />
            <Check
              id="smtp-quota"
              label="流量提醒（用到 80% 与用完时，每个周期各一次）"
              checked={quota}
              onChange={setQuota}
            />
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {saved && <p className="text-sm text-emerald-700">已保存。</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存邮件设置"}
          </Button>
        </form>
        <div className="space-y-2 border-t border-border pt-4">
          <Label htmlFor="smtp-test-to">发送测试邮件（使用已保存的设置）</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="smtp-test-to"
              type="email"
              className="max-w-xs"
              value={testTo}
              placeholder="收件地址"
              onChange={(e) => setTestTo(e.target.value)}
            />
            <Button variant="outline" disabled={testing || !testTo.trim()} onClick={() => void sendTest()}>
              {testing ? "发送中…" : "发送测试邮件"}
            </Button>
          </div>
          {testMsg && (
            <p
              role={testMsg.ok ? "status" : "alert"}
              className={`text-sm ${testMsg.ok ? "text-emerald-700" : "text-destructive"}`}
            >
              {testMsg.text}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DeadLetters({ count }: { count: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const rows = useQuery({
    queryKey: ["mail-outbox", "dead"],
    queryFn: () => get<OutboxRow[]>("/mail/outbox?status=dead"),
    enabled: open,
  });
  const [error, setError] = useState<string | null>(null);

  async function retry(id: number) {
    setError(null);
    try {
      await post(`/mail/outbox/${id}/retry`, {});
      await qc.invalidateQueries({ queryKey: ["mail-outbox"] });
      await qc.invalidateQueries({ queryKey: ["settings-mail"] });
    } catch (err) {
      setError(errText(err, "重试失败"));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>失败邮件 {count > 0 && <Badge variant="destructive">{count}</Badge>}</h2>
        </CardTitle>
        <CardDescription>
          被服务器拒绝或多次重试仍失败的邮件。验证码与重置链接过期后不再发送，也不能重试（正文已清除）。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!open ? (
          <Button variant="outline" onClick={() => setOpen(true)}>
            查看失败邮件
          </Button>
        ) : rows.isPending ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : rows.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errText(rows.error, "加载失败")}
          </p>
        ) : rows.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有失败的邮件。</p>
        ) : (
          <Table label="失败邮件列表">
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>收件人</TableHead>
                <TableHead>次数</TableHead>
                <TableHead>原因</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {fmtDateTime(r.settled_at ?? r.created_at)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{KIND_LABEL[r.kind] ?? r.kind}</TableCell>
                  <TableCell className="text-xs">{r.to_addr}</TableCell>
                  <TableCell>{r.attempts}</TableCell>
                  <TableCell className="max-w-xs break-all text-xs">{r.last_error ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {r.retryable && (
                      <Button size="sm" variant="outline" onClick={() => void retry(r.id)}>
                        重试
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
