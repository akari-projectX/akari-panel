// 我的账户 (ACC-*; audit §5.16): the signed-in admin's address and role,
// password change (with "confirm new password"), passkeys (add with a busy
// button, rename that stays open on failure, delete with a warning on the
// last one) and the passkey-only switch behind an anti-lockout
// confirmation, sign out.
import { useQuery } from "@tanstack/react-query";
import { Fingerprint, KeyRound, LogOut, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, del, get, logout, patch, post, put } from "../../shared/api";
import { loadPage, loginBase } from "../../shared/base";
import { dateTime } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { createCredential, passkeysSupported } from "../../shared/passkey";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardBody, CardHeader } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Field, Input, SwitchField } from "../../shared/ui/form";
import { Callout, KV, PageHeader } from "../../shared/ui/layout";
import { ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { useErrText } from "../kit";
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
  const [signingOut, setSigningOut] = useState(false);
  return (
    <>
      <PageHeader title={tr("我的账户", "My account")} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={tr("账户", "Account")} />
          <CardBody>
            <KV
              items={[
                [
                  tr("邮箱", "Email"),
                  <span key="e" className="break-all">
                    {me.email}
                  </span>,
                ],
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
              icon={LogOut}
              variant="destructive-soft"
              loading={signingOut}
              onClick={async () => {
                setSigningOut(true);
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
  const [again, setAgain] = useState("");
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const errs = {
    cur: !cur ? tr("请输入当前密码", "Enter the current password") : null,
    next: next.length < 8 ? tr("至少 8 位", "At least 8 characters") : null,
    again: again !== next ? tr("两次输入的新密码不一致", "The new passwords do not match") : null,
  };
  const bad = Object.values(errs).filter(Boolean).length;
  return (
    <Card>
      <CardHeader
        title={tr("修改密码", "Change password")}
        description={tr("其他设备上的会话会结束，本会话保留。", "Other sessions end; this one stays.")}
      />
      <CardBody>
        <form
          className="grid gap-3"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setTried(true);
            if (bad) return;
            const r = await run(() => post("/me/password", { current_password: cur, new_password: next }), {
              ok: tr("密码已修改", "Password changed"),
            });
            if (r !== undefined) {
              setCur("");
              setNext("");
              setAgain("");
              setTried(false);
            }
          }}
        >
          <Field label={tr("当前密码", "Current password")} error={(tried && errs.cur) || undefined}>
            <Input
              type="password"
              autoComplete="current-password"
              value={cur}
              onChange={(e) => setCur(e.target.value)}
            />
          </Field>
          <Field
            label={tr("新密码（至少 8 位）", "New password (8+)")}
            error={((tried || next.length > 0) && next.length < 8 && errs.next) || undefined}
          >
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field
            label={tr("确认新密码", "Confirm new password")}
            error={((tried || (again.length > 0 && again.length >= next.length)) && errs.again) || undefined}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" loading={busy}>
              {tr("保存", "Save")}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

type Key = Passkeys["passkeys"][number];

function PasskeyRow({ p, last }: { p: Key; last: boolean }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const [name, setName] = useState<string | null>(null);
  const [rename, renaming] = useAction();
  const input = useRef<HTMLInputElement>(null);
  const editing = name !== null;
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const save = async () => {
    if (name === null || !name.trim()) return;
    const r = await rename(() => patch(`/me/passkeys/${p.id}`, { name: name.trim() }), { ok: tr("已改名", "Renamed") });
    // A failure keeps the editor open with what was typed.
    if (r !== undefined) setName(null);
  };
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-body">
      {name !== null ? (
        <form
          className="flex w-full flex-wrap items-center gap-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            aria-label={tr("名称", "Name")}
            className="min-w-0 flex-1 sm:max-w-64"
            value={name}
            maxLength={64}
            ref={input}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setName(null);
            }}
          />
          <Button type="submit" size="sm" variant="primary" loading={renaming} disabled={!name.trim()}>
            {tr("保存", "Save")}
          </Button>
          <Button size="sm" variant="ghost" disabled={renaming} onClick={() => setName(null)}>
            {tr("取消", "Cancel")}
          </Button>
        </form>
      ) : (
        <>
          <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium break-all">{p.name}</span>
          {!p.current && <Badge tone="outline">{tr("属于旧域名", "for an old domain")}</Badge>}
          <span className="basis-full text-footnote text-muted-foreground sm:basis-auto">
            {tr("添加于", "added")} {dateTime(p.created_at)} · {tr("最后使用", "last used")} {dateTime(p.last_used_at)}
          </span>
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setName(p.name)}>
              {tr("改名", "Rename")}
            </Button>
            <Button
              size="sm"
              variant="destructive-soft"
              icon={Trash2}
              onClick={async () => {
                const ok = await confirm({
                  title: tr(`删除通行密钥 ${p.name}？`, `Delete passkey ${p.name}?`),
                  description: tr(
                    "这台设备将不能再用通行密钥登录后台。",
                    "That device can no longer sign in to the console with a passkey.",
                  ),
                  impact: last
                    ? tr(
                        "这是你最后一个可用的通行密钥：删除后只能用密码登录（「只用通行密钥登录」随之失效）。",
                        "This is your last usable passkey: afterwards you sign in with the password (passkey-only stops applying).",
                      )
                    : undefined,
                  typeToConfirm: p.name,
                  confirmLabel: tr("删除", "Delete"),
                  action: () => del(`/me/passkeys/${p.id}`),
                });
                if (ok) toast({ tone: "success", title: tr("通行密钥已删除", "Passkey deleted") });
              }}
            >
              {tr("删除", "Delete")}
            </Button>
          </span>
        </>
      )}
    </li>
  );
}

function PasskeysCard() {
  const tr = useTr();
  const errText = useErrText();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ["passkeys"], queryFn: () => get<Passkeys>("/me/passkeys") });
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [setOnly, switching] = useAction();
  const d = q.data;
  const add = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const { state, options } = await post<{ state: string; options: Record<string, unknown> }>(
        "/me/passkeys/options",
      );
      const credential = await createCredential(options);
      await post("/me/passkeys", { state, credential, name: name.trim() || navigator.platform || "passkey" });
      toast({ tone: "success", title: tr("通行密钥已添加", "Passkey added") });
      setName("");
    } catch (e) {
      toast({
        tone: "error",
        title:
          e instanceof ApiError
            ? errText(e)
            : tr("未完成（已取消或设备不支持）", "Not added (cancelled or unsupported)"),
      });
    } finally {
      setAdding(false);
    }
  };
  const usable = d?.passkeys.filter((p) => p.current) ?? [];
  const onlyPasskeys = async (on: boolean) => {
    if (on) {
      const ok = await confirm({
        title: tr("只用通行密钥登录？", "Passkey sign-in only?"),
        description: tr(
          "开启后，这个账户不能再用密码登录后台。如果通行密钥所在的设备全部丢失，只能在服务器上运行 akari admin reset-login <邮箱> 恢复密码登录。",
          "Afterwards this account cannot sign in with its password. If every device holding a passkey is lost, only `akari admin reset-login <email>` on the server restores password sign-in.",
        ),
        impact: tr(
          `你现在有 ${usable.length} 个可用的通行密钥${usable.length < 2 ? "；建议先在另一台设备上再添加一个" : ""}`,
          `You have ${usable.length} usable passkey(s)${usable.length < 2 ? "; consider adding one on another device first" : ""}`,
        ),
        tone: "warning",
        confirmLabel: tr("确认开启", "Turn on"),
      });
      if (!ok) return;
    }
    await setOnly(() => put("/me/password-login", { enabled: !on }), { ok: tr("已保存", "Saved") });
  };
  return (
    <Card data-passkeys>
      <CardHeader
        title={tr("通行密钥", "Passkeys")}
        description={tr("用指纹、面容或安全密钥登录后台。", "Sign in with fingerprint, face or a security key.")}
      />
      <CardBody className="grid gap-3">
        {q.isPending ? (
          <div className="grid gap-2" role="status" aria-label={tr("加载中", "Loading")}>
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : q.isError && !d ? (
          <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
        ) : d ? (
          <>
            {!d.available && (
              <Callout tone="warning">
                {tr(
                  "通行密钥需要 https 主域名（系统设置 → 通用 → 域名与证书），当前不可用。",
                  "Passkeys need an https main domain (Settings → General → Domains); unavailable now.",
                )}
              </Callout>
            )}
            {d.available && !passkeysSupported() && (
              <Callout tone="warning">
                {tr("这个浏览器不支持通行密钥。", "This browser does not support passkeys.")}
              </Callout>
            )}
            <ul className="divide-y divide-separator overflow-hidden rounded-lg bg-window">
              {d.passkeys.length === 0 && (
                <li className="px-4 py-3 text-body text-muted-foreground">
                  {tr("还没有通行密钥。", "No passkeys yet.")}
                </li>
              )}
              {d.passkeys.map((p) => (
                <PasskeyRow key={p.id} p={p} last={p.current && usable.length === 1} />
              ))}
            </ul>
            {d.available && (
              <form
                className="flex flex-wrap items-end gap-2"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void add();
                }}
              >
                <Field
                  label={tr("新通行密钥名称", "New passkey name")}
                  className="min-w-0 flex-1 sm:max-w-64"
                  hint={d.passkeys.length >= d.max ? tr(`最多 ${d.max} 个`, `At most ${d.max}`) : undefined}
                >
                  <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="MacBook" />
                </Field>
                <Button
                  type="submit"
                  icon={Fingerprint}
                  loading={adding}
                  disabled={!passkeysSupported() || d.passkeys.length >= d.max}
                >
                  {tr("添加通行密钥", "Add passkey")}
                </Button>
              </form>
            )}
            <div className="border-t border-separator pt-3">
              <SwitchField
                checked={!d.password_login}
                disabled={switching || (usable.length === 0 && d.password_login)}
                onChange={(v) => void onlyPasskeys(v)}
                label={tr("只用通行密钥登录", "Passkey sign-in only")}
                description={
                  usable.length === 0 && d.password_login
                    ? tr("先添加一个通行密钥才能开启。", "Add a passkey first.")
                    : tr(
                        "关闭这个账户的密码登录；丢失全部通行密钥时用 akari admin reset-login 恢复。",
                        "Turns password sign-in off for this account; akari admin reset-login recovers it.",
                      )
                }
              />
            </div>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
