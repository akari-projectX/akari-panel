// 我的账户 (ACC-*): the signed-in admin's address and role, password
// change, passkeys (add, rename, delete) and the passkey-only switch, sign
// out.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, del, get, logout, patch, post, put } from "../../shared/api";
import { loadPage, loginBase } from "../../shared/base";
import { dateTime } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { createCredential, passkeysSupported } from "../../shared/passkey";
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
  KV,
  PageHeader,
  Switch,
} from "../../shared/ui/primitives";
import { useErrText, useRun } from "../kit";
import { useMe } from "../session";

type Passkeys = {
  available: boolean;
  rp_id: string | null;
  passkeys: { id: string; name: string; created_at: string; last_used_at: string | null; current: boolean }[];
  password_set: boolean;
  password_login_disabled: boolean;
  password_login: boolean;
  max: number;
};

export function AccountPage() {
  const tr = useTr();
  const me = useMe();
  return (
    <>
      <PageHeader title={tr("我的账户", "My account")} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={tr("账户", "Account")} />
          <CardBody>
            <KV
              items={[
                [tr("邮箱", "Email"), me.email],
                [
                  tr("角色", "Role"),
                  me.is_owner ? (
                    <Badge key="o" tone="primary">
                      {tr("所有者", "Owner")}
                    </Badge>
                  ) : (
                    tr("管理员", "Admin")
                  ),
                ],
                [tr("邮箱已验证", "Email verified"), me.email_verified ? tr("是", "yes") : tr("否", "no")],
              ]}
            />
            <Button
              className="mt-4"
              icon="logout"
              variant="destructive-soft"
              onClick={async () => {
                await logout().catch(() => undefined);
                loadPage(loginBase);
              }}
            >
              {tr("退出登录", "Sign out")}
            </Button>
          </CardBody>
        </Card>
        <PasswordCard />
        <div className="xl:col-span-2">
          <PasskeysCard />
        </div>
      </div>
    </>
  );
}

function PasswordCard() {
  const tr = useTr();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [run, busy] = useRun();
  return (
    <Card>
      <CardHeader
        title={tr("修改密码", "Change password")}
        description={tr("其他设备上的会话会结束，本会话保留。", "Other sessions end; this one stays.")}
      />
      <CardBody>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => post("/me/password", { current_password: cur, new_password: next }), {
              ok: tr("密码已修改", "Password changed"),
            });
            if (r !== undefined) {
              setCur("");
              setNext("");
            }
          }}
        >
          <Field label={tr("当前密码", "Current password")}>
            <Input
              type="password"
              autoComplete="current-password"
              value={cur}
              onChange={(e) => setCur(e.target.value)}
            />
          </Field>
          <Field label={tr("新密码（至少 8 位）", "New password (8+)")}>
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={!cur || next.length < 8}>
            {tr("保存", "Save")}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function PasskeysCard() {
  const tr = useTr();
  const errText = useErrText();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ["me", "passkeys"], queryFn: () => get<Passkeys>("/me/passkeys") });
  const [name, setName] = useState("");
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [run, busy] = useRun();
  const d = q.data;
  const add = async () => {
    try {
      const { state, options } = await post<{ state: string; options: Record<string, unknown> }>(
        "/me/passkeys/options",
      );
      const credential = await createCredential(options);
      await post("/me/passkeys", { state, credential, name: name.trim() || navigator.platform || "passkey" });
      toast({ tone: "success", title: tr("通行密钥已添加", "Passkey added") });
      setName("");
      void q.refetch();
    } catch (e) {
      toast({
        tone: "error",
        title:
          e instanceof ApiError
            ? errText(e)
            : tr("未完成（已取消或设备不支持）", "Not added (cancelled or unsupported)"),
      });
    }
  };
  return (
    <Card>
      <CardHeader
        title={tr("通行密钥", "Passkeys")}
        description={tr("用指纹、面容或安全密钥登录后台。", "Sign in with fingerprint, face or a security key.")}
      />
      <CardBody className="space-y-3 text-[13px]">
        {d && !d.available && (
          <Callout tone="warning">
            {tr(
              "通行密钥需要 https 主域名（系统设置 → 站点与域名），当前不可用。",
              "Passkeys need an https main domain (Settings → Site and domains); unavailable now.",
            )}
          </Callout>
        )}
        {d && d.available && !passkeysSupported() && (
          <Callout tone="warning">
            {tr("这个浏览器不支持通行密钥。", "This browser does not support passkeys.")}
          </Callout>
        )}
        <ul className="divide-y divide-border rounded-md border border-border">
          {d?.passkeys.length === 0 && (
            <li className="px-3 py-2 text-muted-foreground">{tr("还没有通行密钥。", "No passkeys yet.")}</li>
          )}
          {d?.passkeys.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              {rename?.id === p.id ? (
                <>
                  <Input
                    aria-label={tr("名称", "Name")}
                    className="h-8 w-48"
                    value={rename.name}
                    onChange={(e) => setRename({ ...rename, name: e.target.value })}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy}
                    onClick={() =>
                      void run(() => patch(`/me/passkeys/${p.id}`, { name: rename.name.trim() }), {
                        ok: tr("已改名", "Renamed"),
                        invalidate: [["me", "passkeys"]],
                      }).then(() => setRename(null))
                    }
                  >
                    {tr("保存", "Save")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRename(null)}>
                    {tr("取消", "Cancel")}
                  </Button>
                </>
              ) : (
                <>
                  <span className="font-medium">{p.name}</span>
                  {!p.current && <Badge tone="outline">{tr("属于旧域名", "for an old domain")}</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {tr("添加于", "added")} {dateTime(p.created_at)} · {tr("最后使用", "last used")}{" "}
                    {dateTime(p.last_used_at)}
                  </span>
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setRename({ id: p.id, name: p.name })}>
                      {tr("改名", "Rename")}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive-soft"
                      onClick={async () => {
                        const ok = await confirm({
                          title: tr(`删除通行密钥 ${p.name}？`, `Delete passkey ${p.name}?`),
                          action: () => del(`/me/passkeys/${p.id}`),
                        });
                        if (ok) void q.refetch();
                      }}
                    >
                      {tr("删除", "Delete")}
                    </Button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
        {d?.available && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={tr("新通行密钥名称", "New passkey name")}>
              <Input className="w-56" value={name} onChange={(e) => setName(e.target.value)} placeholder="MacBook" />
            </Field>
            <Button icon="fingerprint" onClick={add} disabled={!passkeysSupported() || d.passkeys.length >= d.max}>
              {tr("添加通行密钥", "Add passkey")}
            </Button>
          </div>
        )}
        {d && (
          <label className="flex items-center gap-2 border-t border-border pt-3">
            <Switch
              checked={!d.password_login}
              label={tr("只用通行密钥登录", "Passkey sign-in only")}
              disabled={!d.passkeys.some((p) => p.current) && d.password_login}
              onChange={(v) =>
                void run(() => put("/me/password-login", { enabled: !v }), {
                  ok: tr("已保存", "Saved"),
                  invalidate: [["me", "passkeys"]],
                })
              }
            />
            {tr(
              "只用通行密钥登录（关闭此账户的密码登录；需要至少一个通行密钥）",
              "Passkey sign-in only (turns password sign-in off; needs a passkey)",
            )}
          </label>
        )}
      </CardBody>
    </Card>
  );
}
