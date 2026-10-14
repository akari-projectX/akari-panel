// 系统设置 → 用户与登录：注册与邀请 (SET-13, SET-28 passkey sign-up), 登录与
// 人机验证 (SET-08, SET-14) and 账号清理 (SET-23). Registration: email
// verification and invite codes are independent switches, both off by
// default. "Admins: passkey sign-in only" and "automatic cleanup" sit in the
// danger zone and are confirmed on save (the cleanup estimate is counted for
// the values being edited, not the saved ones).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { get, put, qs } from "../../shared/api";
import { dateTime, daysBefore, siteToday } from "../../shared/format";
import { cn } from "../../shared/cn";
import { useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Checkbox, Input, SecretInput, Select, Switch } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { useAction } from "../data";
import { useDebounced } from "../kit";
import { UnitInput } from "../components/inputs";
import { Timeline } from "../components/kit";
import { fresh, useAuthSettings, type AuthSettings } from "./settings-data";
import {
  DangerRow,
  DangerZone,
  FieldRow,
  Panel,
  SRow,
  domainError,
  Loaded,
  SwitchRow,
  Warnings,
  intError,
  intOf,
  useDraft,
  useSavePart,
} from "../components/settings-kit";

// ---------------------------------------------------------------------------
// 注册与邀请
// ---------------------------------------------------------------------------

type Signup = {
  version: number;
  register_enabled: boolean;
  invite_required: boolean;
  invite_single_use: boolean;
  email_domains: string[];
  trial_plan_id: string | null;
  trial_days: number;
  reset_enabled: boolean;
  email_verify: boolean;
  passkey_register: boolean;
  passkey_available: boolean;
  mail_enabled: boolean;
  public_origin: string | null;
  warnings: string[];
};

type Plan = { id: string; name: string };

export function SignupSection() {
  const q = useQuery({ queryKey: ["settings", "signup"], queryFn: () => get<Signup>("/settings/signup") });
  return <Loaded q={q}>{(s) => <SignupForm s={s} />}</Loaded>;
}

function SignupForm({ s }: { s: Signup }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<Plan[]>("/plans") });
  const f = useDraft({
    register_enabled: s.register_enabled,
    email_verify: s.email_verify,
    passkey_register: s.passkey_register,
    domains: s.email_domains,
    invite_required: s.invite_required,
    invite_single_use: s.invite_single_use,
    trial_plan_id: s.trial_plan_id ?? "",
    trial_days: String(s.trial_days),
    reset_enabled: s.reset_enabled,
  });
  const v = f.value!;
  const domainList = v.domains;
  const daysError = v.trial_plan_id && f.isEdited("trial_days") ? intError(v.trial_days, 1, 3650, tr) : undefined;
  useSavePart({
    count: f.edited.length,
    errors: daysError ? 1 : 0,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings", "signup"], s);
      const r = await run(
        () =>
          put<Signup>("/settings/signup", {
            version: cur.version,
            register_enabled: v.register_enabled,
            invite_required: v.invite_required,
            invite_single_use: v.invite_single_use,
            email_domains: v.domains,
            trial_plan_id: v.trial_plan_id || null,
            trial_days: intOf(v.trial_days),
            reset_enabled: v.reset_enabled,
            email_verify: v.email_verify,
            passkey_register: v.passkey_register,
          }),
        { ok: tr("注册设置已保存", "Sign-up settings saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  return (
    <>
      <Warnings items={s.warnings} />
      <Group title={tr("注册", "Registration")}>
        <SwitchRow
          label={tr("开放注册", "Open registration")}
          changed={f.isEdited("register_enabled")}
          description={tr("关闭后门户注册页只显示「暂不开放注册」", "When off the portal says registration is closed")}
          checked={v.register_enabled}
          onChange={(x) => f.set("register_enabled", x)}
        />
        <SwitchRow
          label={tr("注册需要验证邮箱", "Registration needs email verification")}
          changed={f.isEdited("email_verify")}
          description={tr(
            "需要发信通道；关闭时改用工作量证明防刷",
            "Needs the mail transport; when off a proof of work stops scripted sign-ups",
          )}
          checked={v.email_verify}
          onChange={(x) => f.set("email_verify", x)}
        />
        <SwitchRow
          label={tr("允许用通行密钥注册", "Allow registering with a passkey")}
          changed={f.isEdited("passkey_register")}
          description={tr(
            "先建账户，进入门户后必须绑定邮箱；24 小时内未绑定自动删除",
            "The account is created first and must bind an email in the portal; unbound ones are removed after 24 hours",
          )}
          checked={v.passkey_register}
          onChange={(x) => f.set("passkey_register", x)}
        >
          {!s.passkey_available && v.passkey_register && (
            <Callout tone="warning">
              {tr(
                "通行密钥当前不可用：需要 https 主域名或通行密钥中心域名（域名与证书）。",
                "Passkeys are not available: set an https main domain or the passkey centre (Domains and certificates).",
              )}
            </Callout>
          )}
        </SwitchRow>
        <SRow
          label={tr("允许注册的邮箱域名", "Allowed email domains")}
          description={
            domainList.length
              ? tr(
                  `只有这 ${domainList.length} 个域名的邮箱能注册。回车添加，留空 = 不限制`,
                  `Only these ${domainList.length} domains may sign up. Enter adds; empty = any`,
                )
              : tr("不限制任何邮箱域名", "Any email domain")
          }
          changed={f.isEdited("domains")}
          wide
        >
          <DomainChips value={domainList} onChange={(x) => f.set("domains", x)} />
        </SRow>
      </Group>
      <Group
        title={tr("邀请", "Invites")}
        footer={
          <>
            {tr("返利比例在 ", "Commission rates: ")}
            <Link to="/settings/commission" className="text-primary hover:underline">
              {tr("收款与返利 › 邀请返利", "Payments and commissions › Invite commissions")}
            </Link>
            {tr("。", ".")}
          </>
        }
      >
        <SwitchRow
          label={tr("注册需要邀请码", "Registration needs an invite code")}
          changed={f.isEdited("invite_required")}
          checked={v.invite_required}
          onChange={(x) => f.set("invite_required", x)}
        />
        <SwitchRow
          label={tr("邀请码只能使用一次", "Invite codes are single use")}
          description={tr(
            "每个用户只有一个固定的邀请码，开启后每人只能邀请一人",
            "Each user has one fixed code, so each user can invite only one person",
          )}
          changed={f.isEdited("invite_single_use")}
          checked={v.invite_single_use}
          onChange={(x) => f.set("invite_single_use", x)}
        />
      </Group>
      <Group title={tr("试用", "Trial")}>
        <FieldRow
          label={tr("试用套餐", "Trial plan")}
          description={tr(
            "新用户注册（并验证邮箱）后自动开通，每个账户只领一次",
            "Granted after sign-up (and verification), once per account",
          )}
          changed={f.isEdited("trial_plan_id")}
        >
          {(a) => (
            <Select
              {...a}
              className="sm:w-48"
              value={v.trial_plan_id}
              onChange={(e) => f.set("trial_plan_id", e.target.value)}
            >
              <option value="">{tr("不提供", "None")}</option>
              {(plans.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </FieldRow>
        {v.trial_plan_id && (
          <FieldRow
            label={tr("试用天数", "Trial days")}
            description={tr("1–3650 天", "1–3650 days")}
            error={daysError}
            changed={f.isEdited("trial_days")}
          >
            {(a) => (
              <UnitInput
                {...a}
                unit={tr("天", "d")}
                invalid={!!daysError}
                value={v.trial_days}
                onChange={(e) => f.set("trial_days", e.target.value)}
              />
            )}
          </FieldRow>
        )}
      </Group>
      <Group title={tr("找回密码", "Password reset")}>
        <SwitchRow
          label={tr("允许找回密码", "Allow password reset")}
          changed={f.isEdited("reset_enabled")}
          description={tr(
            "通过邮件重置密码；需要发信通道与主域名",
            "By mail; needs the mail transport and a main domain",
          )}
          checked={v.reset_enabled}
          onChange={(x) => f.set("reset_enabled", x)}
        />
      </Group>
    </>
  );
}

/** Email domains as chips: Enter or a comma adds, × removes; checked like a domain. */
function DomainChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const tr = useTr();
  const [t, setT] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const add = () => {
    const d = t.trim().replace(/^@/, "").toLowerCase();
    if (!d) return;
    const e = domainError(d, tr);
    if (e) return setErr(e);
    if (!value.includes(d)) onChange([...value, d]);
    setT("");
    setErr(undefined);
  };
  return (
    <div className="grid w-80 gap-1 max-sm:w-full">
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md bg-card px-1.5 py-1 shadow-[0_0_0_0.5px_var(--input)]">
        {value.map((x) => (
          <span
            key={x}
            className="inline-flex h-6 items-center gap-1 rounded-full bg-secondary pr-1 pl-2 font-mono text-footnote"
          >
            {x}
            <button
              type="button"
              aria-label={tr(`移除 ${x}`, `Remove ${x}`)}
              onClick={() => onChange(value.filter((y) => y !== x))}
              className="inline-flex size-4 items-center justify-center rounded-full text-faint hover:text-foreground pointer-coarse:size-6"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          aria-label={tr("添加邮箱域名", "Add an email domain")}
          aria-invalid={err ? true : undefined}
          value={t}
          onChange={(e) => {
            setT(e.target.value);
            setErr(undefined);
          }}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !t && value.length) onChange(value.slice(0, -1));
          }}
          placeholder={value.length ? "" : tr("example.com，回车添加", "example.com, Enter to add")}
          className="h-6 min-w-24 flex-1 bg-transparent px-1 text-body outline-none placeholder:text-faint"
        />
      </div>
      {err && <p className="text-footnote text-destructive">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 登录与人机验证
// ---------------------------------------------------------------------------

/** The PUT body of /settings/auth (secret absent = keep). */
function authBody(a: AuthSettings, m: Partial<AuthSettings>, secret: string): Record<string, unknown> {
  const x = { ...a, ...m };
  return {
    version: a.version,
    turnstile_site_key: x.turnstile_site_key?.trim() || null,
    turnstile_login: x.turnstile_login,
    turnstile_register: x.turnstile_register,
    turnstile_reset: x.turnstile_reset,
    honeypot: x.honeypot,
    min_submit_secs: x.min_submit_secs,
    passkey_only_admins: x.passkey_only_admins,
    passkey_only_users: x.passkey_only_users,
    passkey_prompt: x.passkey_prompt,
    ...(secret.trim() ? { turnstile_secret: secret.trim() } : {}),
  };
}

export function LoginSection() {
  const q = useAuthSettings();
  return <Loaded q={q}>{(a) => <LoginForm a={a} />}</Loaded>;
}

function LoginForm({ a }: { a: AuthSettings }) {
  const tr = useTr();
  useQuery({ queryKey: ["passkeys"], queryFn: () => get<{ passkeys: { current: boolean }[] }>("/me/passkeys") });
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const f = useDraft({
    passkey_prompt: a.passkey_prompt,
    passkey_only_users: a.passkey_only_users,
    passkey_only_admins: a.passkey_only_admins,
    site_key: a.turnstile_site_key ?? "",
    secret: "",
    turnstile_login: a.turnstile_login,
    turnstile_register: a.turnstile_register,
    turnstile_reset: a.turnstile_reset,
    honeypot: a.honeypot,
    min: String(a.min_submit_secs),
  });
  const v = f.value!;
  const minError = f.isEdited("min") ? intError(v.min, 0, 60, tr) : undefined;
  const anyForm = v.turnstile_login || v.turnstile_register || v.turnstile_reset;
  const siteKeyError =
    anyForm && !v.site_key.trim() && f.edited.length
      ? tr("已选择需要验证的表单，站点密钥不能为空", "Forms are ticked: the site key is required")
      : undefined;
  useSavePart({
    count: f.edited.length,
    errors: (minError ? 1 : 0) + (siteKeyError ? 1 : 0),
    discard: f.reset,
    save: async () => {
      if (v.passkey_only_admins && !a.passkey_only_admins) {
        const mine = (qc.getQueryData<{ passkeys: { current: boolean }[] }>(["passkeys"])?.passkeys ?? []).filter(
          (p) => p.current,
        ).length;
        const ok = await confirm({
          title: tr("管理员只能用通行密钥登录？", "Admins: passkey sign-in only?"),
          description: tr(
            "保存后有当前域名通行密钥的管理员不能再用密码登录后台；没有通行密钥的管理员仍可用密码，不会被锁在外面。",
            "Admins with a passkey for this domain can no longer sign in with a password; admins without one keep their password and are not locked out.",
          ),
          impacts: [
            { label: tr("你的通行密钥", "Your passkeys"), value: tr(`${mine} 个`, `${mine}`) },
            {
              label: tr("丢失通行密钥时", "If a passkey is lost"),
              value: (
                <code className="font-mono text-footnote">
                  {tr("akari admin reset-login <邮箱>", "akari admin reset-login <email>")}
                </code>
              ),
            },
          ],
          typeToConfirm: tr("只用通行密钥", "passkeys only"),
          tone: "warning",
          confirmLabel: tr("关闭管理员密码登录", "Turn off admin passwords"),
        });
        if (!ok) return false;
      }
      const cur = fresh(qc, ["settings", "auth"], a);
      const r = await run(
        () =>
          put(
            "/settings/auth",
            authBody(
              cur,
              {
                passkey_prompt: v.passkey_prompt,
                passkey_only_users: v.passkey_only_users,
                passkey_only_admins: v.passkey_only_admins,
                turnstile_site_key: v.site_key,
                turnstile_login: v.turnstile_login,
                turnstile_register: v.turnstile_register,
                turnstile_reset: v.turnstile_reset,
                honeypot: v.honeypot,
                min_submit_secs: intOf(v.min) ?? 0,
              },
              v.secret,
            ),
          ),
        { ok: tr("登录与人机验证设置已保存", "Sign-in settings saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  return (
    <>
      <Warnings items={a.warnings} />
      <Group
        title={tr("用户登录方式", "How users sign in")}
        footer={tr(
          "没有当前域名通行密钥的账户仍可用密码登录，不会被锁在外面。",
          "Accounts without a passkey for the current domain keep their password; nobody is locked out.",
        )}
      >
        <SwitchRow
          label={tr("密码登录后引导绑定通行密钥", "Prompt for a passkey after a password sign-in")}
          changed={f.isEdited("passkey_prompt")}
          checked={v.passkey_prompt}
          onChange={(x) => f.set("passkey_prompt", x)}
        />
        <SwitchRow
          label={tr("用户只能用通行密钥登录", "Users: passkey sign-in only")}
          changed={f.isEdited("passkey_only_users")}
          description={tr(
            "有通行密钥的门户用户不能再用密码登录",
            "Portal users with a passkey can no longer sign in with a password",
          )}
          checked={v.passkey_only_users}
          onChange={(x) => f.set("passkey_only_users", x)}
        />
      </Group>
      <Group
        title={tr("人机验证（Cloudflare Turnstile）", "Bot protection (Cloudflare Turnstile)")}
        footer={tr(
          "建议在 Cloudflare 把组件模式设为「托管」或「隐形」：平时不显示，只有需要人工确认时才出现。被锁在外面时在服务器上执行 akari settings unset turnstile。",
          "Set the widget mode to Managed or Invisible in Cloudflare: hidden until an interaction is needed. Locked out? On the server: akari settings unset turnstile.",
        )}
      >
        <FieldRow label={tr("Turnstile 站点密钥", "Turnstile site key")} changed={f.isEdited("site_key")}>
          {(x) => (
            <Input
              {...x}
              className="font-mono sm:w-64"
              autoComplete="off"
              spellCheck={false}
              value={v.site_key}
              onChange={(e) => f.set("site_key", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow
          label={tr("Turnstile 密钥（只写）", "Turnstile secret (write-only)")}
          description={
            a.turnstile_secret_set
              ? tr("已设置 · 留空表示不修改", "Set · empty = keep")
              : tr("还没有保存密钥", "No secret saved yet")
          }
          changed={f.isEdited("secret")}
        >
          {(x) => (
            <SecretInput
              {...x}
              className="sm:w-64"
              value={v.secret}
              onChange={(e) => f.set("secret", e.target.value)}
            />
          )}
        </FieldRow>
        <div className="relative px-4 py-3">
          {(f.isEdited("turnstile_login") || f.isEdited("turnstile_register") || f.isEdited("turnstile_reset")) && (
            <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" data-changed>
              <span className="sr-only">{tr("已修改", "Edited")}</span>
            </span>
          )}
          <div className="text-body font-medium" id="turnstile-forms">
            {tr("需要人机验证的表单", "Forms with a bot check")}
          </div>
          <div className="mt-0.5 text-footnote text-muted-foreground">
            {tr(
              "全部不勾 = 关闭 Turnstile；登录同时用于门户与后台",
              "None ticked = Turnstile off; sign-in covers the portal and the console",
            )}
          </div>
          <div className="mt-2.5 grid gap-2 sm:grid-cols-3" role="group" aria-labelledby="turnstile-forms">
            {(
              [
                [
                  "turnstile_login",
                  tr("登录使用 Turnstile", "Turnstile on sign-in"),
                  tr("门户与后台登录", "Portal and console sign-in"),
                ],
                [
                  "turnstile_register",
                  tr("注册使用 Turnstile", "Turnstile on registration"),
                  tr("注册", "Registration"),
                ],
                [
                  "turnstile_reset",
                  tr("找回密码使用 Turnstile", "Turnstile on password reset"),
                  tr("找回密码", "Password reset"),
                ],
              ] as const
            ).map(([k, name, text]) => (
              <label
                key={k}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-body shadow-[0_0_0_0.5px_var(--input)] sm:min-h-9",
                  v[k] && "bg-primary-soft shadow-[0_0_0_1px_var(--primary)]",
                )}
              >
                <Checkbox label={name} checked={v[k]} onChange={(x) => f.set(k, x)} />
                {text}
              </label>
            ))}
          </div>
          {siteKeyError && <p className="mt-1.5 text-footnote text-destructive">{siteKeyError}</p>}
        </div>
      </Group>
      <Group
        title={tr("防机器人", "Bot traps")}
        footer={tr(
          "这两项对所有公开表单生效，不依赖 Turnstile。命中时回答与普通失败相同（只计数）。",
          "Both apply to every public form, without Turnstile. A trapped submission gets the ordinary failure (counted only).",
        )}
      >
        <SwitchRow
          label={tr("蜜罐字段", "Honeypot field")}
          changed={f.isEdited("honeypot")}
          checked={v.honeypot}
          onChange={(x) => f.set("honeypot", x)}
        />
        <FieldRow
          label={tr("最短提交时间（秒，0 = 关闭）", "Minimum submit time (s, 0 = off)")}
          description={tr(
            "打开页面后少于这个时间就提交，视为机器人；0–60 秒",
            "Submitted sooner than this after opening = a bot; 0–60 seconds",
          )}
          error={minError}
          changed={f.isEdited("min")}
        >
          {(x) => (
            <UnitInput
              {...x}
              unit={tr("秒", "s")}
              invalid={!!minError}
              value={v.min}
              onChange={(e) => f.set("min", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <DangerZone>
        <DangerRow
          label={tr("管理员只能用通行密钥登录", "Admins: passkey sign-in only")}
          description={
            <>
              {tr(
                "后台的密码登录关闭（对有通行密钥的管理员）。丢失通行密钥只能在服务器上执行 ",
                "Admins with a passkey can no longer use a password. A lost passkey is recovered on the server with ",
              )}
              <code className="font-mono">akari admin reset-login</code>
              {tr(" 恢复。保存时确认。", ". Confirmed on save.")}
            </>
          }
          action={
            <Switch
              label={tr("管理员只能用通行密钥登录", "Admins: passkey sign-in only")}
              checked={v.passkey_only_admins}
              onChange={(x) => f.set("passkey_only_admins", x)}
            />
          }
        />
      </DangerZone>
    </>
  );
}

// ---------------------------------------------------------------------------
// 账号清理
// ---------------------------------------------------------------------------

type Cleanup = {
  version: number;
  auto: boolean;
  after_days: number;
  warn: boolean;
  warn_days: number;
  last_run_at: string | null;
  last_deleted: number;
  last_warned: number;
  due_warn: number;
  due_delete: number;
};

export function CleanupSection() {
  const q = useQuery({ queryKey: ["settings", "cleanup"], queryFn: () => get<Cleanup>("/settings/cleanup") });
  return <Loaded q={q}>{(c) => <CleanupForm c={c} />}</Loaded>;
}

/**
 * Never-used accounts signed up and not signed in for `days` (the users
 * list's count), and those signed up before `older` days (the age split).
 */
function useEstimate(days: number | null, older?: number) {
  const d = useDebounced(days, 400);
  const before = d === null ? "" : daysBefore(siteToday(), d);
  const reg = d === null ? "" : daysBefore(siteToday(), Math.max(d, older ?? d));
  return useQuery({
    queryKey: ["users", "cleanup-estimate", before, reg],
    queryFn: () =>
      get<{ total: number }>(
        `/users${qs({ never_used: "true", registered_before: reg, last_login_before: before, limit: 1 })}`,
      ),
    enabled: d !== null,
  });
}

function CleanupForm({ c }: { c: Cleanup }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const f = useDraft({ auto: c.auto, after: String(c.after_days), warn: c.warn, warn_days: String(c.warn_days) });
  const v = f.value!;
  const afterError = f.isEdited("after") ? intError(v.after, 1, 3650, tr) : undefined;
  const warnError = f.isEdited("warn_days") ? intError(v.warn_days, 1, 90, tr) : undefined;
  const days = afterError ? null : intOf(v.after);
  const est = useEstimate(days);
  const n = est.data?.total;
  const n30 = useEstimate(days, 30).data?.total;
  const n90 = useEstimate(days, 90).data?.total;
  const before = days === null ? null : daysBefore(siteToday(), days);
  useSavePart({
    count: f.edited.length,
    errors: (afterError ? 1 : 0) + (warnError ? 1 : 0),
    discard: f.reset,
    save: async () => {
      if (v.auto && (!c.auto || f.isEdited("after") || f.isEdited("warn"))) {
        const ok = await confirm({
          title: c.auto
            ? tr("修改自动清理条件？", "Change the automatic cleanup?")
            : tr("开启自动删除账号？", "Turn on automatic deletion?"),
          impact: v.warn
            ? tr(
                `首次运行将给约 ${n ?? "?"} 个账户发提醒邮件，${intOf(v.warn_days)} 天后仍未登录的会被删除`,
                `The first run mails about ${n ?? "?"} accounts; those still not signed in after ${intOf(v.warn_days)} days are deleted`,
              )
            : tr(`首次运行将删除约 ${n ?? "?"} 个账户`, `The first run deletes about ${n ?? "?"} accounts`),
          description: tr(
            "每小时运行一次。只删除从未使用过的账号（没有套餐、付款、流量、余额与工单），删除方式与自助注销相同，不能撤销。",
            "Runs hourly. Only never-used accounts (no plan, payment, traffic, balance or ticket) are deleted, like a self-deletion; it cannot be undone.",
          ),
          impacts: [
            {
              label: tr("首次运行将处理", "The first run handles"),
              value: tr(`约 ${n ?? "?"} 个账户`, `about ${n ?? "?"} accounts`),
            },
            {
              label: tr("条件", "Criteria"),
              value: tr(`注册满 ${intOf(v.after)} 天且从未使用`, `signed up ${intOf(v.after)}+ days ago, never used`),
            },
            {
              label: tr("提醒邮件", "Warning mail"),
              value: v.warn
                ? tr(`先提醒，等 ${intOf(v.warn_days)} 天`, `first, then ${intOf(v.warn_days)} days`)
                : tr("不提醒", "none"),
            },
          ],
          typeToConfirm: tr("开启自动清理", "turn on cleanup"),
          confirmLabel: tr("开启并保存", "Turn on and save"),
        });
        if (!ok) return false;
      }
      const cur = fresh(qc, ["settings", "cleanup"], c);
      const r = await run(
        () =>
          put("/settings/cleanup", {
            version: cur.version,
            auto: v.auto,
            after_days: intOf(v.after),
            warn: v.warn,
            warn_days: intOf(v.warn_days),
          }),
        { ok: tr("清理设置已保存", "Cleanup settings saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  const segs =
    days === null
      ? []
      : [
          ...(days < 30
            ? [
                {
                  k: tr(`注册满 ${days}–30 天`, `${days}–30 days`),
                  v: n !== undefined && n30 !== undefined ? n - n30 : undefined,
                },
              ]
            : []),
          ...(days < 90
            ? [
                {
                  k: tr(`${Math.max(days, 30)}–90 天`, `${Math.max(days, 30)}–90 days`),
                  v: n30 !== undefined && n90 !== undefined ? n30 - n90 : undefined,
                },
              ]
            : []),
          { k: tr(`${Math.max(days, 90)} 天以上`, `Over ${Math.max(days, 90)} days`), v: n90 },
        ];
  return (
    <>
      <Card className="overflow-hidden">
        <div className="grid gap-4 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <div className="text-footnote font-medium text-muted-foreground">
              {tr("按当前填写的值", "For the values being edited")}
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              <span className="text-title1 font-bold tracking-[-0.02em] tabular-nums" data-cleanup-estimate>
                {days === null ? "—" : est.isPending ? "…" : (n ?? "—")}
              </span>
              <span className="text-body text-muted-foreground">{tr("个账户符合", "accounts match")}</span>
              {f.isEdited("after") && <Badge tone="primary">{tr("按未保存的值", "Unsaved values")}</Badge>}
            </div>
            <div className="mt-1 text-footnote text-muted-foreground">
              {tr(
                `注册满 ${v.after || "?"} 天且期间没有登录，从没有过套餐、付款、流量、余额与工单`,
                `Signed up over ${v.after || "?"} days ago without a sign-in since; never a plan, payment, traffic, balance or ticket`,
              )}
            </div>
          </div>
          {before && (
            <Button asChild variant="outline">
              <Link to={`/users?never_used=1&registered_before=${before}&last_login_before=${before}`}>
                {tr("在用户列表中查看", "Show in the user list")}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          )}
        </div>
        {segs.length > 1 && (
          <div
            className="grid divide-x divide-separator border-t border-separator text-center"
            style={{ gridTemplateColumns: `repeat(${segs.length}, minmax(0, 1fr))` }}
          >
            {segs.map((x) => (
              <div key={x.k} className="py-2">
                <div className="text-headline font-semibold tabular-nums">{x.v ?? "…"}</div>
                <div className="text-caption text-faint">{x.k}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Group
        title={tr("规则", "Rules")}
        footer={tr(
          "管理员与有财务记录的账号永远不算「从未使用」。",
          "Admins and accounts with finance records never count as never used.",
        )}
      >
        <FieldRow
          label={tr("注册超过 N 天", "Signed up more than N days ago")}
          description={tr("1–3650 天，且这段时间没有登录", "1–3650 days, without a sign-in since")}
          error={afterError}
          changed={f.isEdited("after")}
        >
          {(a) => (
            <UnitInput
              {...a}
              unit={tr("天", "d")}
              invalid={!!afterError}
              value={v.after}
              onChange={(e) => f.set("after", e.target.value)}
            />
          )}
        </FieldRow>
        <SwitchRow
          label={tr("删除前发邮件提醒", "Warn by mail first")}
          description={tr("用户登录一次即保留账号", "Signing in once keeps the account")}
          checked={v.warn}
          onChange={(x) => f.set("warn", x)}
          changed={f.isEdited("warn")}
        />
        {v.warn && (
          <FieldRow
            label={tr("提醒后等待天数", "Days after the warning")}
            description={tr("1–90 天；期间登录过就不删", "1–90 days; a sign-in meanwhile keeps it")}
            error={warnError}
            changed={f.isEdited("warn_days")}
          >
            {(a) => (
              <UnitInput
                {...a}
                unit={tr("天", "d")}
                invalid={!!warnError}
                value={v.warn_days}
                onChange={(e) => f.set("warn_days", e.target.value)}
              />
            )}
          </FieldRow>
        )}
      </Group>
      <Panel
        title={tr("最近运行", "Last run")}
        footer={tr(
          "每小时运行一次。自动清理关闭时不提醒也不删除。",
          "Runs hourly. With automatic cleanup off nothing is mailed or deleted.",
        )}
      >
        <Card className="px-4 py-3">
          {c.last_run_at ? (
            <Timeline
              items={[
                {
                  title: tr(
                    `已删除 ${c.last_deleted} 个，提醒 ${c.last_warned} 个`,
                    `${c.last_deleted} deleted, ${c.last_warned} warned`,
                  ),
                  time: dateTime(c.last_run_at),
                  tone: c.last_deleted ? "warning" : "neutral",
                  body: c.auto
                    ? tr(
                        `下次运行待处理：提醒 ${c.due_warn} 个、删除 ${c.due_delete} 个`,
                        `Due next run: ${c.due_warn} to warn, ${c.due_delete} to delete`,
                      )
                    : undefined,
                },
              ]}
            />
          ) : (
            <p className="text-body text-muted-foreground">{tr("从未运行", "Never")}</p>
          )}
        </Card>
      </Panel>
      <DangerZone>
        <DangerRow
          label={
            <>
              {tr("自动清理", "Automatic cleanup")}{" "}
              {v.auto ? (
                <Badge tone="danger">{tr("开启", "On")}</Badge>
              ) : (
                <Badge tone="outline">{tr("关闭", "Off")}</Badge>
              )}
            </>
          }
          description={tr(
            "开启后每小时运行，符合条件的账户会被删除（先提醒则等待期满后删除），不可恢复。保存时确认。",
            "Runs hourly; matching accounts are deleted (after the warning period, if warned) and cannot be restored. Confirmed on save.",
          )}
          action={
            <Switch label={tr("自动清理", "Automatic cleanup")} checked={v.auto} onChange={(x) => f.set("auto", x)} />
          }
        />
      </DangerZone>
    </>
  );
}
