// 系统设置 → 用户与登录：注册与邀请 (SET-13, SET-28 passkey sign-up), 登录与
// 人机验证 (SET-08, SET-14) and 账号清理 (SET-23). Registration: email
// verification and invite codes are independent switches, both off by
// default. "Admins: passkey sign-in only" and "automatic cleanup" sit in the
// danger zone and are confirmed on save (the cleanup estimate is counted for
// the values being edited, not the saved ones).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { get, put, qs } from "../../shared/api";
import { dateTime, daysBefore, siteToday } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Input, SecretInput, Select } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { useAction } from "../data";
import { useDebounced } from "../kit";
import { fresh, useAuthSettings, type AuthSettings } from "./settings-data";
import {
  DangerZone,
  FieldRow,
  InfoRow,
  Loaded,
  SwitchRow,
  Warnings,
  intError,
  intOf,
  useDraft,
  useSavePart,
} from "./settings-kit";

// ---------------------------------------------------------------------------
// 注册与邀请
// ---------------------------------------------------------------------------

type Signup = {
  version: number;
  register_enabled: boolean;
  invite_required: boolean;
  invite_single_use: boolean;
  invite_codes_per_user: number;
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
    domains: s.email_domains.join(", "),
    invite_required: s.invite_required,
    invite_single_use: s.invite_single_use,
    codes: String(s.invite_codes_per_user),
    trial_plan_id: s.trial_plan_id ?? "",
    trial_days: String(s.trial_days),
    reset_enabled: s.reset_enabled,
  });
  const v = f.value!;
  const codesError = f.isEdited("codes")
    ? intError(v.codes, 0, 100, tr) && tr("请输入 0–100 的整数（0 = 不能生成）", "Enter 0–100 (0 = none)")
    : undefined;
  const daysError = f.isEdited("trial_days") ? intError(v.trial_days, 1, 3650, tr) : undefined;
  useSavePart({
    count: f.edited.length,
    errors: (codesError ? 1 : 0) + (daysError ? 1 : 0),
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
            invite_codes_per_user: intOf(v.codes),
            email_domains: v.domains.split(/[\s,]+/).filter(Boolean),
            trial_plan_id: v.trial_plan_id || null,
            trial_days: intOf(v.trial_days),
            reset_enabled: v.reset_enabled,
            email_verify: v.email_verify,
            passkey_register: v.passkey_register,
          }),
        { ok: tr("注册设置已保存", "Sign-up settings saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Warnings items={s.warnings} />
      <Group title={tr("注册", "Registration")}>
        <SwitchRow
          label={tr("开放注册", "Open registration")}
          description={tr("关闭后门户注册页只显示「暂不开放注册」", "When off the portal says registration is closed")}
          checked={v.register_enabled}
          onChange={(x) => f.set("register_enabled", x)}
        />
        <SwitchRow
          label={tr("注册需要验证邮箱", "Registration needs email verification")}
          description={tr(
            "需要发信通道；关闭时改用工作量证明防刷",
            "Needs the mail transport; when off a proof of work stops scripted sign-ups",
          )}
          checked={v.email_verify}
          onChange={(x) => f.set("email_verify", x)}
        />
        <SwitchRow
          label={tr("允许用通行密钥注册", "Allow registering with a passkey")}
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
        <FieldRow
          label={tr("邮箱域名白名单", "Email domain allow-list")}
          description={tr("逗号分隔，如 example.com；留空 = 不限制", "Comma separated, e.g. example.com; empty = any")}
        >
          {(a) => (
            <Input {...a} className="sm:w-64" value={v.domains} onChange={(e) => f.set("domains", e.target.value)} />
          )}
        </FieldRow>
      </Group>
      <Group
        title={tr("邀请", "Invites")}
        footer={tr(
          "返利比例在「收款与返利 → 邀请返利」。",
          "Commission rates live in Payments and commissions → Invite commissions.",
        )}
      >
        <SwitchRow
          label={tr("注册需要邀请码", "Registration needs an invite code")}
          checked={v.invite_required}
          onChange={(x) => f.set("invite_required", x)}
        />
        <SwitchRow
          label={tr("邀请码只能使用一次", "Invite codes are single use")}
          checked={v.invite_single_use}
          onChange={(x) => f.set("invite_single_use", x)}
        />
        <FieldRow
          label={tr("每个用户最多的邀请码数量", "Invite codes per user")}
          description={tr("0–100，0 = 不能生成", "0–100, 0 = none")}
          error={codesError}
        >
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              className="tnum text-right sm:w-24"
              value={v.codes}
              onChange={(e) => f.set("codes", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Group title={tr("试用", "Trial")}>
        <FieldRow
          label={tr("试用套餐", "Trial plan")}
          description={tr("新用户注册（并验证邮箱）后自动开通", "Granted after sign-up (and verification)")}
        >
          {(a) => (
            <Select
              {...a}
              className="sm:w-48"
              value={v.trial_plan_id}
              onChange={(e) => f.set("trial_plan_id", e.target.value)}
            >
              <option value="">{tr("不赠送", "None")}</option>
              {(plans.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </FieldRow>
        <FieldRow label={tr("试用天数", "Trial days")} description={tr("1–3650 天", "1–3650 days")} error={daysError}>
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              className="tnum text-right sm:w-24"
              value={v.trial_days}
              onChange={(e) => f.set("trial_days", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Group title={tr("找回密码", "Password reset")}>
        <SwitchRow
          label={tr("允许找回密码", "Allow password reset")}
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
  useSavePart({
    count: f.edited.length,
    errors: minError ? 1 : 0,
    discard: f.reset,
    save: async () => {
      if (v.passkey_only_admins && !a.passkey_only_admins) {
        const ok = await confirm({
          title: tr("管理员只能用通行密钥登录？", "Admins: passkey sign-in only?"),
          impact: tr(
            "有当前域名通行密钥的管理员不能再用密码登录后台",
            "Admins with a passkey for this domain can no longer sign in with a password",
          ),
          description: (
            <>
              {tr(
                "没有通行密钥的管理员仍可用密码，不会被锁在外面。丢失通行密钥时在服务器上执行：",
                "Admins without a passkey keep their password. Lost a passkey? On the server run: ",
              )}
              <code className="font-mono text-foreground">akari admin reset-login &lt;邮箱&gt;</code>
            </>
          ),
          tone: "warning",
          confirmLabel: tr("确认开启", "Turn on"),
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
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Warnings items={a.warnings} />
      <Group
        title={tr("登录方式", "Sign-in")}
        footer={tr(
          "没有当前域名通行密钥的账户仍可用密码登录，不会被锁在外面。",
          "Accounts without a passkey for the current domain keep their password; nobody is locked out.",
        )}
      >
        <SwitchRow
          label={tr("密码登录后引导绑定通行密钥", "Prompt for a passkey after a password sign-in")}
          checked={v.passkey_prompt}
          onChange={(x) => f.set("passkey_prompt", x)}
        />
        <SwitchRow
          label={tr("用户只能用通行密钥登录", "Users: passkey sign-in only")}
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
        <FieldRow label={tr("Turnstile 站点密钥", "Turnstile site key")}>
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
              ? tr("已保存；留空 = 不修改", "Saved; empty = keep")
              : tr("还没有保存密钥", "No secret saved yet")
          }
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
        <SwitchRow
          label={tr("登录使用 Turnstile", "Turnstile on sign-in")}
          checked={v.turnstile_login}
          onChange={(x) => f.set("turnstile_login", x)}
        />
        <SwitchRow
          label={tr("注册使用 Turnstile", "Turnstile on registration")}
          checked={v.turnstile_register}
          onChange={(x) => f.set("turnstile_register", x)}
        />
        <SwitchRow
          label={tr("找回密码使用 Turnstile", "Turnstile on password reset")}
          checked={v.turnstile_reset}
          onChange={(x) => f.set("turnstile_reset", x)}
        />
      </Group>
      <Group
        title={tr("表单陷阱", "Form traps")}
        footer={tr(
          "命中蜜罐或提交过快时，回答与普通失败相同（只计数）。",
          "A trapped submission gets the ordinary failure (counted only).",
        )}
      >
        <SwitchRow
          label={tr("蜜罐字段", "Honeypot field")}
          checked={v.honeypot}
          onChange={(x) => f.set("honeypot", x)}
        />
        <FieldRow
          label={tr("最短提交时间（秒，0 = 关闭）", "Minimum submit time (s, 0 = off)")}
          description={tr("0–60 秒", "0–60 seconds")}
          error={minError}
        >
          {(x) => (
            <Input
              {...x}
              inputMode="numeric"
              className="tnum text-right sm:w-24"
              value={v.min}
              onChange={(e) => f.set("min", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <DangerZone>
        <SwitchRow
          label={tr("管理员只能用通行密钥登录", "Admins: passkey sign-in only")}
          description={tr(
            "打开后有通行密钥的管理员不能再用密码登录后台。丢失通行密钥只能在服务器上执行 akari admin reset-login 恢复。",
            "Admins with a passkey can no longer sign in with a password. A lost passkey is recovered on the server with akari admin reset-login.",
          )}
          checked={v.passkey_only_admins}
          onChange={(x) => f.set("passkey_only_admins", x)}
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

/** Never-used accounts signed up and not signed in for `days` (the users list's count). */
function useEstimate(days: number | null) {
  const d = useDebounced(days, 400);
  const before = d === null ? "" : daysBefore(siteToday(), d);
  return useQuery({
    queryKey: ["users", "cleanup-estimate", before],
    queryFn: () =>
      get<{ total: number }>(
        `/users${qs({ never_used: "true", registered_before: before, last_login_before: before, limit: 1 })}`,
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
          typeToConfirm: tr("自动删除", "auto delete"),
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
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Group
        title={tr("条件", "Criteria")}
        footer={tr(
          "「从未使用」：注册超过 N 天且从没有过套餐、付款、流量、余额与工单；管理员与有财务记录的账号永远不算。",
          '"Never used": signed up more than N days ago, never a plan, payment, traffic, balance or ticket; admins and accounts with finance records never count.',
        )}
      >
        <FieldRow
          label={tr("注册超过 N 天", "Signed up more than N days ago")}
          description={tr("1–3650 天，且这段时间没有登录", "1–3650 days, without a sign-in since")}
          error={afterError}
        >
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              className="tnum text-right sm:w-24"
              value={v.after}
              onChange={(e) => f.set("after", e.target.value)}
            />
          )}
        </FieldRow>
        <InfoRow
          label={tr("现在符合条件的账号", "Accounts that match now")}
          description={tr("按上面正在填写的天数实时估算", "Estimated for the days being edited")}
        >
          <span className="tnum text-body font-semibold" data-cleanup-estimate>
            {days === null ? "—" : est.isPending ? "…" : (n ?? "—")}
          </span>
          {before && (
            <Button asChild size="sm" variant="outline">
              <Link to={`/users?never_used=1&registered_before=${before}&last_login_before=${before}`}>
                {tr("在用户列表中查看", "Show in the user list")}
              </Link>
            </Button>
          )}
        </InfoRow>
      </Group>
      <Group title={tr("提醒", "Warning")}>
        <SwitchRow
          label={tr("删除前发邮件提醒", "Warn by mail first")}
          description={tr("用户登录一次即保留账号", "Signing in once keeps the account")}
          checked={v.warn}
          onChange={(x) => f.set("warn", x)}
        />
        <FieldRow
          label={tr("提醒后等待天数", "Days after the warning")}
          description={tr("1–90 天", "1–90 days")}
          error={warnError}
        >
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              disabled={!v.warn}
              className="tnum text-right sm:w-24"
              value={v.warn_days}
              onChange={(e) => f.set("warn_days", e.target.value)}
            />
          )}
        </FieldRow>
        <InfoRow label={tr("上次运行", "Last run")}>
          <span className="text-body text-muted-foreground">
            {c.last_run_at
              ? tr(
                  `${dateTime(c.last_run_at)}：删除 ${c.last_deleted}，提醒 ${c.last_warned}`,
                  `${dateTime(c.last_run_at)}: ${c.last_deleted} deleted, ${c.last_warned} warned`,
                )
              : tr("从未运行", "Never")}
          </span>
        </InfoRow>
      </Group>
      <DangerZone>
        <SwitchRow
          label={tr("自动清理", "Automatic cleanup")}
          description={tr(
            "每小时删除一次符合条件的账号（默认关）。开启时确认将删除的数量。",
            "Deletes matching accounts hourly (off by default). Turning it on confirms how many go.",
          )}
          checked={v.auto}
          onChange={(x) => f.set("auto", x)}
        />
      </DangerZone>
    </>
  );
}
