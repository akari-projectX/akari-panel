// 系统设置 → 后台与登录安全 (SET-06…09): the console address (masked,
// shown on demand), prefix rotation and the IP allowlist (owner only, D4 /
// R47), the passkey policies (D7), and 安全 (retention, Cloudflare ranges,
// extra release keys).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { get, post, put } from "../../shared/api";
import { loadPage } from "../../shared/base";
import { useTr } from "../../shared/i18n";
import { useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Skeleton,
  Switch,
  Textarea,
} from "../../shared/ui/primitives";
import { CopyButton, FormError, Mono, useErrText, useRun } from "../kit";
import { useMe } from "../session";
import { useSettings } from "./settings";

type Access = {
  version: number;
  admin_prefix: string;
  admin_url: string | null;
  admin_allow_cidrs: string[];
  your_ip: string | null;
  sub_path: string;
};
export type AuthSettings = {
  version: number;
  turnstile_site_key: string | null;
  turnstile_secret_set: boolean;
  turnstile_login: boolean;
  turnstile_register: boolean;
  turnstile_reset: boolean;
  honeypot: boolean;
  min_submit_secs: number;
  passkey_only_admins: boolean;
  passkey_only_users: boolean;
  passkey_prompt: boolean;
  warnings: string[];
};

export function useAccess() {
  return useQuery({ queryKey: ["settings", "access"], queryFn: () => get<Access>("/settings/access") });
}
export function useAuthSettings() {
  return useQuery({ queryKey: ["settings", "auth"], queryFn: () => get<AuthSettings>("/settings/auth") });
}

/** The PUT body of 登录与人机验证 (secret absent = keep). */
export function authBody(
  a: AuthSettings,
  patch: Partial<AuthSettings> & { turnstile_secret?: string },
): Record<string, unknown> {
  const m = { ...a, ...patch };
  const body: Record<string, unknown> = {
    version: m.version,
    turnstile_site_key: m.turnstile_site_key || null,
    turnstile_login: m.turnstile_login,
    turnstile_register: m.turnstile_register,
    turnstile_reset: m.turnstile_reset,
    honeypot: m.honeypot,
    min_submit_secs: m.min_submit_secs,
    passkey_only_admins: m.passkey_only_admins,
    passkey_only_users: m.passkey_only_users,
    passkey_prompt: m.passkey_prompt,
  };
  if (patch.turnstile_secret !== undefined) body.turnstile_secret = patch.turnstile_secret;
  return body;
}

export function SecurityTab() {
  return (
    <div className="space-y-4">
      <AccessCard />
      <PasskeyPolicy />
      <SecurityValues />
    </div>
  );
}

function AccessCard() {
  const tr = useTr();
  const me = useMe();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrText();
  const q = useAccess();
  const [shown, setShown] = useState(false);
  const [custom, setCustom] = useState("");
  const [allow, setAllow] = useState<string | null>(null);
  const [run, busy] = useRun();
  const a = q.data;
  if (!a) return q.error ? <FormError error={q.error} /> : <Skeleton className="h-48" />;
  const url = a.admin_url ?? `${location.origin}/${a.admin_prefix}/admin`;
  const masked = url.replace(
    a.admin_prefix,
    `${a.admin_prefix.slice(0, 3)}${"•".repeat(Math.max(4, a.admin_prefix.length - 5))}${a.admin_prefix.slice(-2)}`,
  );
  const rotate = async () => {
    const next = custom.trim();
    const box: { v?: Access } = {};
    const ok = await confirm({
      title: tr("轮换后台前缀？", "Rotate the admin prefix?"),
      impact: tr(
        "旧地址立即失效（所有实例），新地址只显示一次",
        "The old address dies at once on every instance; the new one is shown once",
      ),
      description: tr(`当前：${url}`, `Current: ${url}`),
      typeToConfirm: tr("轮换", "rotate"),
      action: async () => {
        box.v = await post<Access>("/settings/access/admin-prefix", {
          version: a.version,
          confirm: true,
          admin_prefix: next || undefined,
        });
      },
    });
    const r = box.v;
    if (!ok || !r) return;
    const newUrl = r.admin_url ?? `${location.origin}/${r.admin_prefix}/admin`;
    await confirm({
      title: tr("新的后台地址", "The new console address"),
      tone: "default",
      details: (
        <div className="flex items-start gap-2 text-[13px]">
          <Mono>{newUrl}</Mono>
          <CopyButton text={newUrl} />
        </div>
      ),
      description: tr("请保存好这个地址；点确认后跳转到新地址。", "Keep this address; confirm to go there."),
      confirmLabel: tr("前往新地址", "Go to it"),
    });
    loadPage(`/${r.admin_prefix}/admin/settings/security`);
  };
  const saveAllow = async () => {
    const list = (allow ?? "").split(/[\s,]+/).filter(Boolean);
    const ok = await confirm({
      title: list.length
        ? tr(`只允许 ${list.length} 个地址/网段访问后台？`, `Allow only ${list.length} addresses / networks?`)
        : tr("取消 IP 白名单（任意地址可访问后台前缀）？", "Remove the allowlist (any address)?"),
      description: tr(
        `你的地址：${a.your_ip ?? "?"}。被锁在外面时在服务器上运行：akari settings unset admin-allow`,
        `Your address: ${a.your_ip ?? "?"}. Locked out? On the server: akari settings unset admin-allow`,
      ),
      tone: "warning",
    });
    if (!ok) return;
    const r = await run(() => put("/settings/access/admin-allow", { version: a.version, admin_allow_cidrs: list }), {
      ok: tr("白名单已保存", "Allowlist saved"),
      invalidate: [["settings", "access"]],
    });
    if (r !== undefined) setAllow(null);
  };
  return (
    <Card>
      <CardHeader
        title={tr("后台地址（D4）", "Console address (D4)")}
        description={tr(
          "全站唯一的秘密前缀；门户不会链接到这里。只有所有者可以轮换与设置白名单。",
          "The site's only secret prefix; the portal never links here. Only the owner rotates it or sets the allowlist.",
        )}
      />
      <CardBody className="space-y-4 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <Mono>{shown ? url : masked}</Mono>
          <Button size="sm" variant="ghost" icon={shown ? "eyeOff" : "eye"} onClick={() => setShown((v) => !v)}>
            {shown ? tr("隐藏", "Hide") : tr("显示", "Show")}
          </Button>
          <CopyButton text={url} />
        </div>
        {!me.is_owner && (
          <Callout tone="info">
            {tr("只有所有者可以轮换前缀与修改白名单。", "Only the owner rotates the prefix or edits the allowlist.")}
          </Callout>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Field label={tr("新前缀（留空 = 随机生成）", "New prefix (empty = random)")}>
            <Input
              className="w-64"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              disabled={!me.is_owner}
            />
          </Field>
          <Button
            variant="destructive-soft"
            disabled={!me.is_owner}
            onClick={() => void rotate().catch((e) => toast({ tone: "error", title: errText(e) }))}
          >
            {tr("轮换前缀", "Rotate prefix")}
          </Button>
        </div>
        <Field
          label={tr(
            "后台 IP 白名单（每行一个地址或 CIDR；留空 = 任意地址）",
            "Admin IP allowlist (one address / CIDR per line; empty = any)",
          )}
          hint={tr(
            `你的地址：${a.your_ip ?? "?"}（保存时必须包含它）`,
            `Your address: ${a.your_ip ?? "?"} (must be included)`,
          )}
        >
          <Textarea
            rows={3}
            value={allow ?? a.admin_allow_cidrs.join("\n")}
            onChange={(e) => setAllow(e.target.value)}
            disabled={!me.is_owner}
          />
        </Field>
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={!me.is_owner || allow === null}
          onClick={() => void saveAllow()}
        >
          {tr("保存白名单", "Save allowlist")}
        </Button>
      </CardBody>
    </Card>
  );
}

function PasskeyPolicy() {
  const tr = useTr();
  const q = useAuthSettings();
  const [run, busy] = useRun();
  const a = q.data;
  if (!a) return <Skeleton className="h-32" />;
  const set = (patch: Partial<AuthSettings>) =>
    void run(() => put("/settings/auth", authBody(a, patch)), {
      ok: tr("已保存", "Saved"),
      invalidate: [["settings", "auth"]],
    });
  return (
    <Card>
      <CardHeader
        title={tr("登录方式（D7 通行密钥）", "Sign-in (D7 passkeys)")}
        description={tr(
          "没有当前域名的通行密钥的账户仍可用密码，不会被锁在外面。丢失设备：akari admin reset-login <邮箱>。",
          "Accounts without a passkey for the current domain keep their password, nobody is locked out. Lost device: akari admin reset-login <email>.",
        )}
      />
      <CardBody className="space-y-3 text-[13px]">
        {(
          [
            ["passkey_prompt", tr("密码登录后引导绑定通行密钥", "Prompt for a passkey after a password sign-in")],
            ["passkey_only_admins", tr("管理员仅允许通行密钥登录", "Admins: passkey sign-in only")],
            ["passkey_only_users", tr("用户仅允许通行密钥登录", "Users: passkey sign-in only")],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="flex items-center gap-2">
            <Switch checked={a[k]} disabled={busy} onChange={(v) => set({ [k]: v })} label={label} />
            {label}
          </label>
        ))}
        {a.warnings.length > 0 && (
          <Callout tone="warning">
            <ul className="list-disc pl-4">
              {a.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        )}
      </CardBody>
    </Card>
  );
}

function SecurityValues() {
  const tr = useTr();
  const s = useSettings();
  const d = s.data;
  const [f, setF] = useState<{ audit: string; traffic: string; ranges: string; keys: string } | null>(null);
  useEffect(() => {
    if (d && !f)
      setF({
        audit: d.security.audit_retention_days.value === null ? "" : String(d.security.audit_retention_days.value),
        traffic:
          d.security.traffic_daily_retention_days.value === null
            ? ""
            : String(d.security.traffic_daily_retention_days.value),
        ranges: (d.security.cloudflare_ranges ?? []).join("\n"),
        keys: (d.security.extra_release_keys ?? []).join("\n"),
      });
  }, [d, f]);
  const [run, busy] = useRun();
  if (!d || !f) return <Skeleton className="h-48" />;
  const lines = (t: string) =>
    t
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  const save = () =>
    run(
      () =>
        put("/settings/security", {
          version: d.version,
          audit_retention_days: f.audit.trim() ? Number(f.audit) : null,
          traffic_daily_retention_days: f.traffic.trim() ? Number(f.traffic) : null,
          cloudflare_ranges: lines(f.ranges).length ? lines(f.ranges) : null,
          extra_release_keys: lines(f.keys).length ? lines(f.keys) : null,
        }),
      { ok: tr("安全设置已保存", "Security settings saved"), invalidate: [["settings"]] },
    ).then((r) => r !== undefined && setF(null));
  return (
    <Card>
      <CardHeader title={tr("安全与数据保留", "Security and retention")} />
      <CardBody className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={tr(
              `审计日志保留天数（0 = 永久，默认 ${d.security.audit_retention_days.default}）`,
              `Audit retention days (0 = forever, default ${d.security.audit_retention_days.default})`,
            )}
          >
            <Input inputMode="numeric" value={f.audit} onChange={(e) => setF({ ...f, audit: e.target.value })} />
          </Field>
          <Field
            label={tr(
              `流量明细保留天数（0 = 永久，默认 ${d.security.traffic_daily_retention_days.default}）`,
              `Traffic history retention (0 = forever, default ${d.security.traffic_daily_retention_days.default})`,
            )}
          >
            <Input inputMode="numeric" value={f.traffic} onChange={(e) => setF({ ...f, traffic: e.target.value })} />
          </Field>
        </div>
        <Field
          label={tr(
            `Cloudflare 网段（每行一个；留空 = 内置 ${d.security.cloudflare_ranges_shipped} 条）`,
            `Cloudflare ranges (one per line; empty = the ${d.security.cloudflare_ranges_shipped} shipped)`,
          )}
        >
          <Textarea rows={3} value={f.ranges} onChange={(e) => setF({ ...f, ranges: e.target.value })} />
        </Field>
        <Field
          label={tr(
            '额外信任的发布公钥（每行 "<base64> [标签]"）',
            'Extra release keys (one "<base64> [label]" per line)',
          )}
        >
          <Textarea rows={3} value={f.keys} onChange={(e) => setF({ ...f, keys: e.target.value })} />
        </Field>
        <div className="flex flex-wrap gap-1.5 text-xs">
          {d.security.release_keys.map((k) => (
            <Badge key={k.id} tone={k.official ? "primary" : "outline"}>
              {k.label || k.id}
              {k.official ? tr("（内置官方）", " (official)") : ""}
            </Badge>
          ))}
        </div>
        <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
          {tr("保存", "Save")}
        </Button>
      </CardBody>
    </Card>
  );
}
