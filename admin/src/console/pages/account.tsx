// 我的账户 (ACC-*; v2 account-*): only "how do I sign in". Left: the
// identity card (avatar, email, owner badge, passkey count, whether password
// sign-in is allowed) with sign-out and the "everyone off now" server
// command; on a phone it moves below. Right: passkeys as device cards (add
// with a busy button and a dashed "waiting for the device" card, rename in
// place that stays open with the reason on failure, delete with an impact
// list and the typed name, the last one warns "password only"), the
// passkey-only switch behind a confirmation that lists the devices, the
// recovery command and an "I know" checkbox, and the password change
// (current + new + again, strength bar, field errors, "N to fix").
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Crown,
  Fingerprint,
  KeyRound,
  LogOut,
  Pencil,
  Plus,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, del, get, logout, patch, post, put } from "../../shared/api";
import { loadPage, signedOutUrl } from "../../shared/base";
import { cn } from "../../shared/cn";
import { dateOnly, dateTime } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { createCredential, passkeysSupported } from "../../shared/passkey";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Switch } from "../../shared/ui/form";
import { Callout, PageHeader } from "../../shared/ui/layout";
import { RowMenu, MenuItem, MenuSeparator } from "../../shared/ui/menu";
import { ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { FixCount, IconBadge, Spin } from "../components/kit";
import { useAction } from "../data";
import { useErrText } from "../kit";
import { useMe } from "../session";

type Key = { id: string; name: string; created_at: string; last_used_at: string | null; current: boolean };
type Passkeys = {
  available: boolean;
  rp_id: string | null;
  passkeys: Key[];
  password_set: boolean;
  password_login_disabled: boolean;
  password_login: boolean;
  max: number;
};

/** A default name for a new passkey: browser · system (renamed in place afterwards). */
function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? /iPad/.test(ua)
      ? "iPad"
      : "iPhone"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return [os, browser].filter(Boolean).join(" · ") || "Passkey";
}

export function AccountPage() {
  const tr = useTr();
  const q = useQuery({ queryKey: ["passkeys"], queryFn: () => get<Passkeys>("/me/passkeys") });
  return (
    <>
      <PageHeader
        title={tr("我的账户", "My account")}
        description={
          <>
            {tr("只影响你自己怎么登录。全站的登录策略在 ", "Only how you sign in. The site-wide sign-in policy is in ")}
            <Link to="/settings/login" className="text-primary hover:underline">
              {tr("系统设置 › 登录与人机验证", "Settings › Sign-in & verification")}
            </Link>
            {tr("。", ".")}
          </>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <IdentityCard data={q.data} />
        <div className="grid gap-6">
          <PasskeysSection q={q} />
          <PasskeyOnlyCard data={q.data} />
          <PasswordCard off={q.data ? !q.data.password_login : false} />
        </div>
      </div>
    </>
  );
}

function IdentityCard({ data }: { data?: Passkeys }) {
  const tr = useTr();
  const me = useMe();
  const [leaving, setLeaving] = useState(false);
  const usable = data?.passkeys.filter((p) => p.current).length;
  return (
    <Card className="overflow-hidden max-lg:order-last lg:sticky lg:top-20">
      <div className="flex flex-col items-center px-5 pt-6 pb-5 text-center">
        <span
          aria-hidden="true"
          className="inline-flex size-16 items-center justify-center rounded-full bg-linear-to-b from-[color-mix(in_srgb,var(--primary),white_32%)] to-primary text-title2 font-semibold text-primary-foreground uppercase"
        >
          {me.email.slice(0, 1)}
        </span>
        <div className="mt-3 max-w-full truncate text-headline font-semibold">{me.email}</div>
        <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5">
          {me.is_owner ? (
            <Badge tone="warning">
              <Crown aria-hidden="true" />
              {tr("所有者", "Owner")}
            </Badge>
          ) : (
            <Badge tone="neutral">{tr("管理员", "Admin")}</Badge>
          )}
          <span className="text-footnote text-faint">
            {me.email_verified ? tr("邮箱已验证", "Email verified") : tr("邮箱未验证", "Email not verified")}
          </span>
        </div>
      </div>
      <dl className="divide-y divide-separator border-t border-separator text-body">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <dt className="text-muted-foreground">{tr("通行密钥", "Passkeys")}</dt>
          <dd className="tnum font-medium">{usable === undefined ? "—" : tr(`${usable} 个`, String(usable))}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <dt className="text-muted-foreground">{tr("密码登录", "Password sign-in")}</dt>
          <dd className="font-medium">
            {!data ? (
              "—"
            ) : data.password_login ? (
              tr("允许", "Allowed")
            ) : (
              <span className="text-muted-foreground">{tr("已关闭", "Off")}</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="border-t border-separator p-3">
        <Button
          variant="outline"
          className="w-full"
          icon={LogOut}
          loading={leaving}
          onClick={async () => {
            setLeaving(true);
            await logout().catch(() => undefined);
            loadPage(signedOutUrl);
          }}
        >
          {tr("退出登录", "Sign out")}
        </Button>
        <p className="mt-2.5 px-1 text-footnote text-faint">
          {tr(
            "要让所有人立即掉线（例如怀疑会话被盗），在服务器上运行 ",
            "To sign everyone out at once (e.g. a stolen session), run ",
          )}
          <code className="font-mono text-muted-foreground">akari secrets rotate-jwt</code>
          {tr("。", " on the server.")}
        </p>
      </div>
    </Card>
  );
}

function PasskeysSection({ q }: { q: ReturnType<typeof useQuery<Passkeys>> }) {
  const tr = useTr();
  const toast = useToast();
  const errText = useErrText();
  const [adding, setAdding] = useState(false);
  const d = q.data;
  const full = !!d && d.passkeys.length >= d.max;
  const canAdd = !!d?.available && passkeysSupported() && !full;
  const add = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const { state, options } = await post<{ state: string; options: Record<string, unknown> }>(
        "/me/passkeys/options",
      );
      const credential = await createCredential(options);
      await post("/me/passkeys", { state, credential, name: deviceName() });
      toast({ tone: "success", title: tr("通行密钥已添加", "Passkey added") });
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
  return (
    <section data-passkeys aria-labelledby="passkeys-title">
      <div className="mb-2.5 flex flex-wrap items-end gap-3 px-1">
        <div className="min-w-0 flex-1 basis-64">
          <h2 id="passkeys-title" className="text-headline font-semibold">
            {tr("通行密钥", "Passkeys")}
          </h2>
          <p className="mt-0.5 text-footnote text-muted-foreground">
            {tr(
              "用指纹、面容或安全密钥登录。建议至少两个：一个常用设备，一个备用。",
              "Sign in with fingerprint, face or a security key. Keep at least two: an everyday device and a spare.",
            )}
          </p>
        </div>
        {d?.available && (
          <Button variant="primary" disabled={adding || !canAdd} onClick={() => void add()}>
            {adding ? <Spin /> : <Plus aria-hidden="true" />}
            {adding ? tr("等待设备确认…", "Waiting for the device…") : tr("添加通行密钥", "Add passkey")}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label={tr("加载中", "Loading")}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[132px] rounded-xl" />
          ))}
        </div>
      ) : q.isError && !d ? (
        <Card>
          <ErrorState
            title={tr("通行密钥列表加载失败", "Passkeys failed to load")}
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        </Card>
      ) : d ? (
        <div className="grid gap-3">
          {!d.available && (
            <Callout tone="warning">
              {tr(
                "通行密钥需要 https 主域名（系统设置 › 域名与证书），当前不可用。",
                "Passkeys need an https main domain (Settings › Domains & certificates); unavailable now.",
              )}
            </Callout>
          )}
          {d.available && !passkeysSupported() && (
            <Callout tone="warning">
              {tr("这个浏览器不支持通行密钥。", "This browser does not support passkeys.")}
            </Callout>
          )}
          {full && (
            <p className="px-1 text-footnote text-muted-foreground">
              {tr(`最多 ${d.max} 个通行密钥；先删除一个再添加。`, `At most ${d.max} passkeys; delete one first.`)}
            </p>
          )}
          {d.passkeys.length === 0 && !adding ? (
            <Card className="flex flex-col items-center gap-1 px-4 py-8 text-center">
              <Fingerprint className="size-6 text-faint" aria-hidden="true" />
              <div className="text-body font-medium">{tr("还没有通行密钥。", "No passkeys yet.")}</div>
              <div className="text-footnote text-muted-foreground">
                {tr("添加一个，下次一步登录。", "Add one to sign in in one step next time.")}
              </div>
            </Card>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {d.passkeys.map((k) => (
                <KeyCard key={k.id} k={k} usable={usable.length} />
              ))}
              {adding && (
                <li className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-primary/50 bg-primary-soft/40 p-4 text-center">
                  <Fingerprint className="size-6 animate-pulse text-primary" aria-hidden="true" />
                  <div className="text-body font-medium">{tr("正在等待这台设备确认", "Waiting for this device")}</div>
                  <div className="text-footnote text-muted-foreground">
                    {tr(
                      "在浏览器窗口里验证指纹或插入安全密钥",
                      "Confirm in the browser’s window: fingerprint, face or a security key",
                    )}
                  </div>
                </li>
              )}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function KeyCard({ k, usable }: { k: Key; usable: number }) {
  const tr = useTr();
  const errText = useErrText();
  const confirm = useConfirm();
  const toast = useToast();
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const editing = name !== null;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const last = k.current && usable === 1;
  const save = async () => {
    if (name === null || !name.trim() || saving) return;
    setSaving(true);
    setFailed(null);
    try {
      await patch(`/me/passkeys/${k.id}`, { name: name.trim() });
      toast({ tone: "success", title: tr("已改名", "Renamed") });
      setName(null);
    } catch (e) {
      // Stays open with what was typed and the reason.
      setFailed(errText(e));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: tr(`删除通行密钥「${k.name}」？`, `Delete passkey “${k.name}”?`),
      description: last
        ? tr(
            "这是你最后一个可用的通行密钥。删除后只能用密码登录（「只用通行密钥登录」随之失效）。",
            "This is your last usable passkey: afterwards you sign in with the password (passkey-only stops applying).",
          )
        : tr("这台设备将不能再登录你的账户。", "That device can no longer sign in to your account."),
      impacts: [
        {
          label: tr("剩余通行密钥", "Passkeys left"),
          value: tr(
            `${Math.max(0, usable - (k.current ? 1 : 0))} 个`,
            String(Math.max(0, usable - (k.current ? 1 : 0))),
          ),
        },
        { label: tr("最后使用", "Last used"), value: k.last_used_at ? dateTime(k.last_used_at) : tr("从未", "Never") },
        ...(last
          ? [
              {
                label: tr("登录方式", "Sign-in"),
                value: <span className="text-warning">{tr("只剩密码", "Password only")}</span>,
              },
            ]
          : []),
        { label: tr("当前会话", "This session"), value: tr("不受影响", "Not affected") },
      ],
      typeToConfirm: k.name,
      confirmLabel: tr("删除", "Delete"),
      action: () => del(`/me/passkeys/${k.id}`),
    });
    if (ok) toast({ tone: "success", title: tr(`已删除「${k.name}」`, `Deleted “${k.name}”`) });
  };
  return (
    <li className={cn("flex min-h-[132px] flex-col rounded-xl bg-card p-4 shadow-card", !k.current && "opacity-70")}>
      <div className="flex items-start gap-3">
        <IconBadge icon={KeyRound} tone="neutral" />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              noValidate
              className="grid gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Input
                aria-label={tr("名称", "Name")}
                value={name}
                maxLength={64}
                ref={input}
                aria-invalid={!!failed || undefined}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setName(null);
                    setFailed(null);
                  }
                }}
              />
              {failed && (
                <p className="text-footnote text-destructive" role="alert">
                  {tr(
                    `保存失败：${failed}。你的修改还在，可以再试一次。`,
                    `Not saved: ${failed}. Your text is kept; try again.`,
                  )}
                </p>
              )}
              <div className="flex gap-1.5">
                <Button size="sm" variant="primary" type="submit" icon={Check} loading={saving} disabled={!name.trim()}>
                  {tr("保存", "Save")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={X}
                  disabled={saving}
                  onClick={() => {
                    setName(null);
                    setFailed(null);
                  }}
                >
                  {tr("取消", "Cancel")}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div className="truncate text-body font-semibold">{k.name}</div>
              {!k.current && (
                <Badge tone="outline" className="mt-1">
                  {tr("属于旧域名", "For an old domain")}
                </Badge>
              )}
            </>
          )}
        </div>
        {!editing && (
          <RowMenu label={tr(`${k.name} 的操作`, `Actions for ${k.name}`)}>
            {() => (
              <>
                <MenuItem icon={Pencil} onClick={() => setName(k.name)}>
                  {tr("改名", "Rename")}
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={Trash2} danger onClick={() => void remove()}>
                  {tr("删除…", "Delete…")}
                </MenuItem>
              </>
            )}
          </RowMenu>
        )}
      </div>
      {!editing && (
        <dl className="mt-auto grid grid-cols-2 gap-2 pt-4 text-footnote">
          <div>
            <dt className="text-faint">{tr("添加于", "Added")}</dt>
            <dd className="tnum mt-0.5 font-medium">{dateOnly(k.created_at)}</dd>
          </div>
          <div>
            <dt className="text-faint">{tr("最后使用", "Last used")}</dt>
            <dd className="tnum mt-0.5 font-medium">
              {k.last_used_at ? dateTime(k.last_used_at) : tr("从未", "Never")}
            </dd>
          </div>
        </dl>
      )}
    </li>
  );
}

function PasskeyOnlyCard({ data }: { data?: Passkeys }) {
  const tr = useTr();
  const [run, busy] = useAction();
  const [asking, setAsking] = useState(false);
  const [ack, setAck] = useState(false);
  if (!data) return null;
  const usable = data.passkeys.filter((p) => p.current);
  const only = !data.password_login;
  const turn = (on: boolean) =>
    run(() => put("/me/password-login", { enabled: !on }), {
      ok: on
        ? tr("已改为只用通行密钥登录", "Passkey sign-in only from now on")
        : tr("已允许密码登录", "Password sign-in allowed"),
    });
  return (
    <>
      <Card className="flex items-start gap-3.5 p-4">
        <IconBadge icon={ShieldCheck} tone={only ? "success" : "neutral"} />
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold">{tr("只用通行密钥登录", "Passkey sign-in only")}</div>
          <p className="mt-0.5 text-footnote text-muted-foreground">
            {tr(
              "开启后，这个账户不能再用密码登录，被盗的密码也无法登录后台。至少需要一个通行密钥才能开启；开启前会再确认一次。",
              "Afterwards this account cannot sign in with its password, so a stolen password is useless. Needs at least one passkey; you confirm once more first.",
            )}
          </p>
          {!only && usable.length === 0 && (
            <p className="mt-1.5 text-footnote text-muted-foreground">
              {tr("先添加一个通行密钥才能开启。", "Add a passkey first.")}
            </p>
          )}
          {!only && usable.length === 1 && (
            <p className="mt-1.5 text-footnote text-warning">
              {tr(
                "你只有 1 个通行密钥。建议先添加一个备用的再开启。",
                "You have only 1 passkey. Add a spare one before turning this on.",
              )}
            </p>
          )}
        </div>
        <Switch
          label={tr("只用通行密钥登录", "Passkey sign-in only")}
          checked={only}
          disabled={busy || (!only && usable.length === 0)}
          onChange={(v) => {
            if (v) {
              setAck(false);
              setAsking(true);
            } else void turn(false);
          }}
        />
      </Card>
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        size="sm"
        icon={ShieldCheck}
        title={tr("只用通行密钥登录？", "Passkey sign-in only?")}
        description={tr("开启后立即生效，当前会话不受影响。", "Takes effect at once; this session stays.")}
        dirty={false}
        footer={
          <div className="flex w-full flex-col gap-3">
            <label className="flex items-start gap-2 text-footnote">
              <span className="pt-px">
                <Checkbox
                  checked={ack}
                  onChange={setAck}
                  label={tr(
                    `我知道丢失全部 ${usable.length} 个通行密钥时，需要在服务器上恢复`,
                    `I know that losing all ${usable.length} passkeys needs a recovery on the server`,
                  )}
                />
              </span>
              <span>
                {tr(
                  `我知道丢失全部 ${usable.length} 个通行密钥时，需要在服务器上恢复`,
                  `I know that losing all ${usable.length} passkeys needs a recovery on the server`,
                )}
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsking(false)}>
                {tr("取消", "Cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={!ack}
                loading={busy}
                onClick={async () => {
                  const r = await turn(true);
                  if (r !== undefined) setAsking(false);
                }}
              >
                {tr("开启", "Turn on")}
              </Button>
            </div>
          </div>
        }
      >
        <div className="grid gap-3 text-body">
          <div>
            <div className="mb-1.5 text-footnote font-medium text-muted-foreground">
              {tr(
                `之后只有这 ${usable.length} 个设备能登录你的账户`,
                `Afterwards only these ${usable.length} devices can sign in`,
              )}
            </div>
            <ul className="divide-y divide-separator rounded-lg ring-1 ring-border ring-inset">
              {usable.map((k) => (
                <li key={k.id} className="flex items-center gap-2.5 px-3 py-2">
                  <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{k.name}</span>
                  <span className="text-footnote text-faint">
                    {tr("最后使用", "last used")} {k.last_used_at ? dateOnly(k.last_used_at) : tr("从未", "never")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg bg-window p-3 text-footnote text-muted-foreground ring-1 ring-border ring-inset">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
              <Terminal className="size-3.5" aria-hidden="true" />
              {tr("全部丢失时怎么办", "If you lose them all")}
            </div>
            {tr("在服务器上运行 ", "Run ")}
            <code className="font-mono text-foreground">akari admin reset-login</code>
            {tr(
              "，会为你的账户恢复密码登录。后台本身无法替你恢复。",
              " on the server: it restores password sign-in for your account. The console itself cannot.",
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}

function strength(p: string): number {
  let s = 0;
  if (p.length >= 10) s++;
  if (p.length >= 14) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
  return s;
}

function PasswordCard({ off }: { off: boolean }) {
  const tr = useTr();
  const errText = useErrText();
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wrongCur, setWrongCur] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const s = strength(next);
  const errs = {
    cur: wrongCur ?? (!cur ? tr("请输入当前密码", "Enter the current password") : null),
    next: next.length < 8 ? tr("至少 8 个字符", "At least 8 characters") : null,
    again: again !== next ? tr("两次输入的新密码不一致", "The new passwords do not match") : null,
  };
  const shown = {
    cur: tried || wrongCur ? errs.cur : null,
    next: tried || (next.length > 0 && next.length < 8 && again.length > 0) ? errs.next : null,
    again: tried || (again.length > 0 && again.length >= next.length) ? errs.again : null,
  };
  const n = Object.values(shown).filter(Boolean).length;
  const levels = [
    tr("太弱", "Too weak"),
    tr("弱", "Weak"),
    tr("一般", "Fair"),
    tr("强", "Strong"),
    tr("很强", "Very strong"),
  ];
  return (
    <Card className={cn("p-4", off && "opacity-75")}>
      <div className="mb-3 flex items-start gap-3.5">
        <IconBadge icon={KeyRound} tone="neutral" />
        <div className="min-w-0 flex-1">
          <h2 className="text-body font-semibold">{tr("修改密码", "Change password")}</h2>
          <p className="mt-0.5 text-footnote text-muted-foreground">
            {off
              ? tr(
                  "密码登录已关闭。修改密码不会恢复密码登录。",
                  "Password sign-in is off. Changing the password does not turn it back on.",
                )
              : tr(
                  "修改后其他设备上的会话会退出，本会话保留。",
                  "Other sessions end after the change; this one stays.",
                )}
          </p>
        </div>
      </div>
      <form
        noValidate
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          setFailed(null);
          if (!cur || next.length < 8 || again !== next || busy) return;
          setBusy(true);
          try {
            await post("/me/password", { current_password: cur, new_password: next });
            toast({ tone: "success", title: tr("密码已修改", "Password changed") });
            setCur("");
            setNext("");
            setAgain("");
            setTried(false);
          } catch (err) {
            if (err instanceof ApiError && (err.code === "account.invalid_password" || err.status === 401))
              setWrongCur(tr("当前密码不正确", "The current password is wrong"));
            else setFailed(errText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={tr("当前密码", "Current password")} error={shown.cur ?? undefined}>
          <Input
            type="password"
            autoComplete="current-password"
            value={cur}
            onChange={(e) => {
              setCur(e.target.value);
              setWrongCur(null);
            }}
          />
        </Field>
        <Field
          label={tr("新密码", "New password")}
          error={shown.next ?? undefined}
          hint={!shown.next && next ? levels[s] : tr("至少 8 个字符", "At least 8 characters")}
        >
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <div className="mt-1.5 flex gap-1" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={cn(
                  "h-1 flex-1 rounded-full",
                  i < s ? (s <= 1 ? "bg-destructive" : s === 2 ? "bg-warning" : "bg-success") : "bg-secondary",
                )}
              />
            ))}
          </div>
        </Field>
        <Field label={tr("再输一次新密码", "New password again")} error={shown.again ?? undefined}>
          <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        {failed && (
          <p role="alert" className="text-footnote text-destructive sm:col-span-3">
            {failed}
          </p>
        )}
        <div className="flex items-center justify-end gap-3 sm:col-span-3">
          {tried && <FixCount n={n} />}
          <Button type="submit" variant="primary" loading={busy}>
            {tr("修改密码", "Change password")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
