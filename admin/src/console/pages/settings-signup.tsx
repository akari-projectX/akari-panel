// 系统设置 → 注册与人机验证 (SET-13, SET-14): registration (D1: email
// verification and invite codes are independent switches, both off by
// default), domain allow-list, trial plan, password reset; Turnstile keys
// with per-form switches, honeypot and minimum submit time (W27).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { get, put } from "../../shared/api";
import { useTr } from "../../shared/i18n";
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Select,
  Skeleton,
  Switch,
} from "../../shared/ui/primitives";
import { FormError, useRun } from "../kit";
import { usePlans } from "./users";
import { authBody, useAuthSettings, type AuthSettings } from "./settings-access";

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
  mail_enabled: boolean;
  public_origin: string | null;
  warnings: string[];
};

export function SignupTab() {
  return (
    <div className="space-y-4">
      <SignupCard />
      <BotCard />
    </div>
  );
}

function SignupCard() {
  const tr = useTr();
  const q = useQuery({ queryKey: ["settings", "signup"], queryFn: () => get<Signup>("/settings/signup") });
  const plans = usePlans();
  const [f, setF] = useState<(Signup & { domains: string }) | null>(null);
  useEffect(() => {
    if (q.data && !f) setF({ ...q.data, domains: q.data.email_domains.join(", ") });
  }, [q.data, f]);
  const [run, busy] = useRun();
  if (!f) return q.error ? <FormError error={q.error} /> : <Skeleton className="h-64" />;
  const save = () =>
    run(
      () =>
        put<Signup>("/settings/signup", {
          version: f.version,
          register_enabled: f.register_enabled,
          invite_required: f.invite_required,
          invite_single_use: f.invite_single_use,
          invite_codes_per_user: Number(f.invite_codes_per_user) || 0,
          email_domains: f.domains.split(/[\s,]+/).filter(Boolean),
          trial_plan_id: f.trial_plan_id || null,
          trial_days: Number(f.trial_days) || 0,
          reset_enabled: f.reset_enabled,
          email_verify: f.email_verify,
        }),
      { ok: tr("注册设置已保存", "Sign-up settings saved"), invalidate: [["settings", "signup"]] },
    ).then((r) => r && setF({ ...r, domains: r.email_domains.join(", ") }));
  const sw = (
    k: "register_enabled" | "email_verify" | "invite_required" | "invite_single_use" | "reset_enabled",
    label: string,
  ) => (
    <label className="flex items-center gap-2 text-[13px]">
      <Switch checked={f[k]} onChange={(v) => setF({ ...f, [k]: v })} label={label} />
      {label}
    </label>
  );
  return (
    <Card>
      <CardHeader title={tr("注册与找回密码", "Sign-up and password reset")} />
      <CardBody className="space-y-3">
        {sw("register_enabled", tr("开放注册", "Open registration"))}
        {sw(
          "email_verify",
          tr("注册需要验证邮箱（需要邮件发送）", "Registration needs email verification (needs mail)"),
        )}
        {sw("invite_required", tr("注册需要邀请码", "Registration needs an invite code"))}
        {sw("invite_single_use", tr("邀请码只能用一次", "Invite codes are single use"))}
        {sw("reset_enabled", tr("允许找回密码（需要邮件与主域名）", "Password reset (needs mail and a main domain)"))}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("每个用户最多的邀请码数量", "Invite codes per user")}>
            <Input
              inputMode="numeric"
              value={f.invite_codes_per_user}
              onChange={(e) => setF({ ...f, invite_codes_per_user: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field
            label={tr(
              "邮箱域名白名单（逗号分隔，留空 = 不限）",
              "Email domain allow-list (comma separated; empty = any)",
            )}
          >
            <Input value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} />
          </Field>
          <Field label={tr("试用套餐", "Trial plan")}>
            <Select
              value={f.trial_plan_id ?? ""}
              onChange={(e) => setF({ ...f, trial_plan_id: e.target.value || null })}
            >
              <option value="">{tr("不赠送", "None")}</option>
              {(plans.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr("试用天数", "Trial days")}>
            <Input
              inputMode="numeric"
              value={f.trial_days}
              onChange={(e) => setF({ ...f, trial_days: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>
        {f.warnings.length > 0 && (
          <Callout tone="warning">
            <ul className="list-disc pl-4">
              {f.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        )}
        <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
          {tr("保存", "Save")}
        </Button>
      </CardBody>
    </Card>
  );
}

function BotCard() {
  const tr = useTr();
  const q = useAuthSettings();
  const [f, setF] = useState<AuthSettings | null>(null);
  const [secret, setSecret] = useState("");
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const [run, busy] = useRun();
  if (!f) return <Skeleton className="h-48" />;
  const save = () =>
    run(() => put("/settings/auth", authBody(f, secret.trim() ? { turnstile_secret: secret.trim() } : {})), {
      ok: tr("人机验证设置已保存", "Bot protection saved"),
      invalidate: [["settings", "auth"]],
    }).then((r) => r !== undefined && setSecret(""));
  const sw = (k: "turnstile_login" | "turnstile_register" | "turnstile_reset" | "honeypot", label: string) => (
    <label className="flex items-center gap-2 text-[13px]">
      <Switch checked={f[k]} onChange={(v) => setF({ ...f, [k]: v })} label={label} />
      {label}
    </label>
  );
  return (
    <Card>
      <CardHeader
        title={tr("人机验证（W27）", "Bot protection (W27)")}
        description={tr(
          "命中蜜罐或提交过快时，回答与普通失败相同（只计数）。被锁在外面：akari settings unset turnstile。",
          "A trapped submission gets the ordinary failure (counted only). Locked out: akari settings unset turnstile.",
        )}
      />
      <CardBody className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("Turnstile 站点密钥", "Turnstile site key")}>
            <Input
              value={f.turnstile_site_key ?? ""}
              onChange={(e) => setF({ ...f, turnstile_site_key: e.target.value })}
            />
          </Field>
          <Field
            label={tr("Turnstile 密钥（只写）", "Turnstile secret (write-only)")}
            hint={f.turnstile_secret_set ? tr("已保存；留空 = 不修改", "Saved; empty = keep") : undefined}
          >
            <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
        </div>
        {sw("turnstile_login", tr("登录使用 Turnstile", "Turnstile on sign-in"))}
        {sw("turnstile_register", tr("注册使用 Turnstile", "Turnstile on registration"))}
        {sw("turnstile_reset", tr("找回密码使用 Turnstile", "Turnstile on password reset"))}
        {sw("honeypot", tr("蜜罐字段", "Honeypot field"))}
        <Field label={tr("最短提交时间（秒，0 = 关闭）", "Minimum submit time (s, 0 = off)")}>
          <Input
            className="w-32"
            inputMode="numeric"
            value={f.min_submit_secs}
            onChange={(e) => setF({ ...f, min_submit_secs: Number(e.target.value) || 0 })}
          />
        </Field>
        {f.warnings.length > 0 && (
          <Callout tone="warning">
            <ul className="list-disc pl-4">
              {f.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        )}
        <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
          {tr("保存", "Save")}
        </Button>
      </CardBody>
    </Card>
  );
}
