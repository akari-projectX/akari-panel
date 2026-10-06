import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Fingerprint, KeyRound, Lock, Mail, Pencil, Plus, ShieldCheck, Trash2, TriangleAlert, UserX } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/panels';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageTitle, Row, Section } from '@/components/flat';
import { Empty, LoadError, Loading } from '@/components/data-state';
import ResetSubscription from '@/components/reset-subscription';
import Subscribe from '@/components/subscribe';
import { accountApi, meApi, passkeyApi, type LoginMethods } from '@/api';
import { isUserCancel, webauthnSupported } from '@/api/webauthn';
import { useApi, usePending, type ApiState } from '@/hooks/use-api';
import { K } from '@/lib/cache';
import { useAuth } from '@/lib/auth';
import { useErrorText } from '@/lib/errors';
import { formatBytes, formatDate, formatDateTime, formatMoney, formatSpeed, resetPeriodText } from '@/lib/format';
import { defaultPasskeyName } from '@/lib/passkey-name';
import { R } from '@/lib/routes';
import { mySubUrl } from '@/lib/sub-links';
import { LOCALES, useLocale, useT, useTp } from '@/i18n';
import { cn } from '@/lib/utils';

/** 「名称 … 值」的两列清单；窄屏回到一列 */
function InfoGrid({ rows }: { rows: [string, React.ReactNode][] }) {
  const tr = useT();
  return (
    <div className="grid gap-x-12 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-6 border-b border-border py-3 text-sm">
          <span className="shrink-0 text-muted-foreground">{tr(k)}</span>
          <span className="min-w-0 truncate text-right">{v}</span>
        </div>
      ))}
    </div>
  );
}

/* ───────────────── 账号 ───────────────── */

function Account() {
  const tr = useT();
  const tp = useTp();
  const { me, plan } = useAuth();
  const { locale, setLocale } = useLocale();
  const p = plan?.plan;

  return (
    <>
      <Section title={tr('账号信息')} desc={tr('这些信息只用于账单与通知，不会对外公开')}>
        <div className="mb-6.5">
          <div className="text-lg font-medium">{me?.email.split('@')[0]}</div>
          <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-muted-foreground">
            {me?.email}
            {me?.email_verified
              ? <Badge variant="secondary" className="rounded-full bg-emerald-500/12 text-success">{tr('已验证')}</Badge>
              : <Badge variant="secondary" className="rounded-full bg-amber-500/12 text-warning">{tr('未验证')}</Badge>}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="secondary" className="rounded-full bg-brand/10 text-brand-ink">{p?.name ?? tr('未订阅')}</Badge>
          </div>
        </div>
      </Section>

      <EmailSection />

      {p && (
        <Section title={tr('当前套餐')} desc={tr('套餐内容由站点设定，如需变更请到商店')}>
          <InfoGrid rows={[
            ['套餐名称', p.name],
            ['流量', p.traffic_quota_bytes != null ? formatBytes(p.traffic_quota_bytes) : tr('不限流量')],
            ['重置周期', resetPeriodText(p.period, tr, tp)],
            ['速率', tr(formatSpeed(p.speed_limit_mbps))],
            ['到期时间', plan?.expires_at ? formatDateTime(plan.expires_at) : tr('长期有效')],
            ['下次重置', p.next_reset_at ? formatDateTime(p.next_reset_at) : tr('不重置')],
          ]} />
        </Section>
      )}

      <Section title={tr('界面语言')} desc={tr('同时决定发给你的邮件用哪种语言')}>
        <div className="max-w-[240px]">
          <Label htmlFor="settings-locale" className="sr-only">{tr('界面语言')}</Label>
          <Select value={locale} onValueChange={(v) => setLocale(v as typeof locale)}>
            <SelectTrigger id="settings-locale" className="h-10 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {LOCALES.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </Section>

      <DeleteAccount />
    </>
  );
}

/**
 * 绑定 / 更换邮箱：当前密码 + 新地址 → 验证码发到新地址 → 填码。验证通过后新地址就是登录名（D1）。
 * 地址已被占用时面板的答复和成功一样（不泄露哪些地址注册过），验证那一步才会失败。
 */
function EmailSection() {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const { me, refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, run] = usePending();
  const { hash } = useLocation();

  /* 未验证邮箱的提醒条点「去验证」会带 #email 过来：滚到这一块 */
  useEffect(() => {
    if (hash === '#email') document.getElementById('email')?.scrollIntoView({ behavior: 'smooth' });
  }, [hash]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      try {
        await meApi.emailCode(email.trim(), password);
        setSentTo(email.trim());
        setPassword('');
        toast.success(tr('验证码已发出'), { description: tp('请查收 {e} 的邮件', { e: email.trim() }) });
      } catch (err) {
        toast.error(errText(err));
      }
    });
  };

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      try {
        const r = await meApi.emailVerify(code.trim());
        setSentTo(null);
        setCode('');
        setEmail('');
        await refresh();
        toast.success(tr('邮箱已验证'), { description: tp('以后用 {e} 登录', { e: r.email }) });
      } catch (err) {
        toast.error(errText(err));
      }
    });
  };

  const unverified = me && !me.email_verified;

  return (
    <div id="email">
      <Section
        title={<><Mail className="size-4 text-brand" />{unverified ? tr('验证邮箱') : tr('更换邮箱')}</>}
        desc={unverified
          ? tr('到期提醒、流量提醒、付款收据和找回密码都只发到已验证的邮箱。可以验证现在这个地址，也可以换一个。')
          : tr('新地址验证通过后就是你的登录名。')}
      >
        {sentTo ? (
          <form onSubmit={verify} className="max-w-115 space-y-4">
            <p className="text-[13px] text-muted-foreground">{tp('验证码已发到 {e}，30 分钟内有效。', { e: sentTo })}</p>
            <div className="space-y-2">
              <Label htmlFor="email-code">{tr('邮箱验证码')}</Label>
              <Input
                id="email-code" className="h-10" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required
                value={code} onChange={(e) => setCode(e.target.value)} placeholder={tr('六位数字')}
              />
            </div>
            <div className="flex gap-2">
              <Button className="h-10" disabled={busy}>{busy ? tr('提交中') : tr('验证')}</Button>
              <Button type="button" variant="ghost" className="h-10" onClick={() => setSentTo(null)}>{tr('换个地址')}</Button>
            </div>
          </form>
        ) : (
          <form onSubmit={send} className="max-w-115 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email-new">{tr('邮箱地址')}</Label>
              <Input
                id="email-new" type="email" className="h-10" autoComplete="email" required
                value={email} onChange={(e) => setEmail(e.target.value)} placeholder={unverified ? me?.email : 'you@example.com'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email-password">{tr('当前密码')}</Label>
              <Input
                id="email-password" type="password" className="h-10" autoComplete="current-password" required
                value={password} onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button className="h-10" disabled={busy}>{busy ? tr('发送中') : tr('发送验证码')}</Button>
          </form>
        )}
      </Section>
    </div>
  );
}

/**
 * 自助注销：删除个人数据；有财务记录的账户匿名化保留（面板 erase.rs）。
 * 先给影响摘要（余额、待审提现、待付订单、当前套餐）。有待支付订单或待审核提现时面板拒绝（409），
 * 这里直接说清楚要先处理哪一样，不让人点了再碰壁。密码确认：只用通行密钥登录的账户不需要。
 */
function DeleteAccount() {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const nav = useNavigate();
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const impact = useApi(() => accountApi.deleteImpact(), [], { enabled: open });
  const methods = useApi(() => passkeyApi.list(), [], { key: K.passkeys, enabled: open });
  const [password, setPassword] = useState('');
  const [busy, run] = usePending();
  /* 面板只在这个账户还能用密码登录时要密码（与登录策略同一个判断） */
  const needPassword = methods.data?.password_login ?? true;

  const remove = () => run(async () => {
    try {
      await accountApi.deleteAccount(needPassword ? password : undefined);
      /* 面板已清掉会话 cookie；本地状态照常收尾 */
      await signOut().catch(() => {});
      toast.success(tr('账户已注销'));
      nav(R.login, { replace: true });
    } catch (e) {
      toast.error(errText(e));
    }
  });

  const d = impact.data;
  const blocked = !!d && (d.pending_orders > 0 || d.pending_withdrawals > 0);
  return (
    <Section title={<><UserX className="size-4 text-danger" />{tr('注销账户')}</>} desc={tr('删除你的个人数据。付款与退款记录按法规匿名保留。注销后不能恢复。')}>
      {!open ? (
        <Button variant="outline" className="h-10 text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
          {tr('我要注销账户')}
        </Button>
      ) : impact.loading && !d ? <Loading rows={2} />
        : impact.error && !d ? <LoadError error={impact.error} onRetry={impact.reload} />
        : d && (
          <div className="max-w-115 space-y-4">
            <ul className="space-y-1.5 rounded-xl bg-red-500/[.06] px-4 py-3.5 text-[13px] leading-[1.8]">
              {d.plan && <li>{tp('套餐「{p}」立即失效，剩余时长作废', { p: d.plan.name })}</li>}
              {d.balance_cents !== 0 && <li>{tp('账户余额 {v} 作废', { v: formatMoney(d.balance_cents) })}</li>}
              {d.unfulfilled_orders > 0 && <li>{tp('{n} 笔已付款但未开通的订单不再处理', { n: d.unfulfilled_orders })}</li>}
              <li>{tr('订阅链接、通行密钥、工单全部删除')}</li>
              <li>{d.anonymized ? tr('账户有付款记录：财务记录匿名保留，其余个人数据删除') : tr('账户会被整个删除')}</li>
            </ul>
            {blocked && (
              <ul role="alert" className="space-y-1.5 rounded-xl border border-amber-500/30 bg-amber-500/[.07] px-4 py-3 text-[13px] leading-[1.8]">
                {d.pending_orders > 0 && <li>{tp('还有 {n} 笔待支付订单：请先在订单页取消', { n: d.pending_orders })}</li>}
                {d.pending_withdrawals > 0 && <li>{tp('还有 {n} 笔待审核的提现（{v}）：请先在钱包页撤回', { n: d.pending_withdrawals, v: formatMoney(d.pending_withdrawal_cents) })}</li>}
              </ul>
            )}
            {needPassword && (
              <div className="space-y-2">
                <Label htmlFor="delete-password">{tr('输入当前密码确认')}</Label>
                <Input id="delete-password" type="password" className="h-10" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
            <ConfirmDialog
              trigger={<Button className="h-10 bg-red-600 text-white hover:bg-red-700" disabled={busy || blocked || (needPassword && !password)}>{tr('注销账户')}</Button>}
              tone="danger"
              icon={<TriangleAlert />}
              title={tr('确定注销账户？')}
              consequences={[tr('个人数据立即删除'), tr('所有设备立即断线并退出登录'), tr('此操作不可撤销')]}
              confirmLabel={tr('确认注销')}
              pending={busy}
              onConfirm={remove}
            />
          </div>
        )}
    </Section>
  );
}

/* ───────────────── 安全 ───────────────── */

function Security() {
  const tr = useT();
  const errText = useErrorText();
  const { me } = useAuth();
  const methods = useApi(() => passkeyApi.list(), [], { key: K.passkeys });
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, run] = usePending();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPwd !== confirm) { toast.error(tr('两次输入的新密码不一致')); return; }
    run(async () => {
      try {
        await meApi.changePassword(oldPwd, newPwd);
        setOldPwd(''); setNewPwd(''); setConfirm('');
        /* 面板会结束其它会话，当前这个保留 */
        toast.success(tr('密码已更新'), { description: tr('其他设备上的登录已经结束') });
      } catch (err) {
        toast.error(errText(err));
      }
    });
  };

  /* 没有密码的账户（password_set=false）不显示改密码 */
  const passwordSet = methods.data?.password_set ?? true;

  return (
    <>
      {passwordSet && (
        <Section
          title={<><Lock className="size-4 text-brand" />{tr('修改密码')}</>}
          desc={tr('密码更新后，其他设备需要重新登录')}
        >
          <form className="max-w-115 space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="current-password">{tr('当前密码')}</Label>
              <Input id="current-password" type="password" className="h-10" autoComplete="current-password" required
                     value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} placeholder={tr('请输入当前密码')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">{tr('新密码')}</Label>
              <Input id="new-password" type="password" className="h-10" autoComplete="new-password" required minLength={8}
                     value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder={tr('至少 8 位')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">{tr('确认新密码')}</Label>
              <Input id="confirm-password" type="password" className="h-10" autoComplete="new-password" required minLength={8}
                     value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={tr('再次输入新密码')} />
            </div>
            <Button className="h-10" disabled={saving}>{saving ? tr('提交中') : tr('更新密码')}</Button>
          </form>
        </Section>
      )}

      <Passkeys methods={methods} />

      {me?.role === 'user' && mySubUrl(me) && (
        <Section
          title={<><KeyRound className="size-4 text-brand" />{tr('订阅与密钥')}</>}
          desc={tr('一个链接，导入任意客户端')}
          extra={<ResetSubscription />}
        >
          <Subscribe />
        </Section>
      )}

      <Section title={<><ShieldCheck className="size-4 text-brand" />{tr('安全提示')}</>}>
        <p className="max-w-[62ch] text-[13.5px] leading-[1.9] text-muted-foreground">
          {tr('订阅链接等同于你的账号凭证，任何拿到它的人都能使用你的流量。不要发到公开的群组或论坛；一旦外泄，重置订阅换一条新的即可——旧链接和所有设备上的连接会立即失效。')}
        </p>
      </Section>
    </>
  );
}

/* ───────────────── 通行密钥 ───────────────── */

function Passkeys({ methods }: { methods: ApiState<LoginMethods> }) {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const [adding, runAdd] = usePending();
  const [busy, runBusy] = usePending();
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const m = methods.data;
  if (methods.loading && !m) return <Section title={tr('通行密钥')}><Loading rows={2} /></Section>;
  if (methods.error && !m) return <Section title={tr('通行密钥')}><LoadError error={methods.error} onRetry={methods.reload} /></Section>;
  if (!m) return null;
  const items = m.passkeys;
  const current = items.filter((k) => k.current).length;
  const supported = webauthnSupported();

  const add = () => runAdd(async () => {
    try {
      await passkeyApi.add(defaultPasskeyName());
      methods.reload();
      toast.success(tr('通行密钥已添加'), { description: tr('以后可以直接用它登录') });
    } catch (e) {
      if (!isUserCancel(e)) toast.error(errText(e));
    }
  });

  const saveName = () => runBusy(async () => {
    if (!editing) return;
    try {
      await passkeyApi.rename(editing.id, editing.name.trim());
      setEditing(null);
      methods.reload();
    } catch (e) {
      toast.error(errText(e));
    }
  });

  const remove = (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      setTimeout(() => setConfirming((v) => (v === id ? null : v)), 3000);
      return;
    }
    runBusy(async () => {
      try {
        await passkeyApi.remove(id);
        setConfirming(null);
        methods.reload();
        toast.success(tr('通行密钥已删除'), { description: tr('设备里保存的那一份需要在设备上自行删除') });
      } catch (e) {
        toast.error(errText(e));
      }
    });
  };

  /* 账户自己的「只用通行密钥」：关掉密码登录前必须有一个当前可用的通行密钥（面板 409 account.passkey_required） */
  const setOnly = (only: boolean) => runBusy(async () => {
    try {
      methods.setData(await passkeyApi.setPasswordLogin(!only));
      toast.success(only ? tr('已改为只用通行密钥登录') : tr('已恢复密码登录'));
    } catch (e) {
      toast.error(errText(e));
    }
  });

  return (
    <Section
      title={<><Fingerprint className="size-4 text-brand" />{tr('通行密钥')}</>}
      desc={m.available
        ? tp('用 Face ID、指纹或 Windows Hello 登录，不用输密码。每个账户最多 {n} 个。', { n: m.max })
        : tr('本站暂不支持通行密钥（需要 https 主域名）。')}
      extra={m.available && supported && (
        <Button className="h-9" disabled={adding || items.length >= m.max} onClick={add}>
          <Plus />{adding ? tr('等待设备验证…') : tr('添加通行密钥')}
        </Button>
      )}
    >
      {m.available && !supported && (
        <p className="mb-4 text-[12.5px] text-muted-foreground">{tr('当前浏览器不支持通行密钥，请换用新版 Safari、Chrome 或 Edge。')}</p>
      )}
      {items.length === 0 ? (
        <Empty title="还没有通行密钥" desc="添加后，登录页点「使用通行密钥登录」就能直接进来。" />
      ) : items.map((k, i) => (
        <Row
          key={k.id} index={i}
          avatar={<div className="grid size-10 shrink-0 place-items-center text-muted-foreground"><KeyRound className="size-4.5" /></div>}
          title={editing?.id === k.id ? (
            <form onSubmit={(e) => { e.preventDefault(); saveName(); }} className="flex max-w-[280px] gap-2">
              <Input
                aria-label={tr('重命名')} autoFocus maxLength={64} value={editing.name} className="h-8"
                onChange={(e) => setEditing({ id: k.id, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
              />
              <Button type="submit" size="sm" className="h-8" disabled={busy}>{tr('保存')}</Button>
            </form>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              {k.name}
              {/* 主域名换过：旧域名下绑的通行密钥在这里登录不了 */}
              {!k.current && <Badge variant="secondary" className="rounded-full bg-muted text-muted-foreground">{tr('属于旧域名')}</Badge>}
            </span>
          )}
          desc={[
            tp('添加于 {d}', { d: formatDate(k.created_at) }),
            k.last_used_at ? tp('最近使用 {d}', { d: formatDateTime(k.last_used_at) }) : tr('还没用它登录过'),
          ].join(' · ')}
          extra={editing?.id === k.id ? undefined : (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing({ id: k.id, name: k.name })}>
                <Pencil />{tr('重命名')}
              </Button>
              <Button
                variant="ghost" size="sm" disabled={busy} onClick={() => remove(k.id)}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 />{confirming === k.id ? tr('确认删除') : tr('删除')}
              </Button>
            </div>
          )}
        />
      ))}

      {m.available && m.password_set && (
        <div className={cn('mt-6 flex items-start justify-between gap-6 rounded-xl bg-muted/60 px-4 py-3.5', current === 0 && 'opacity-60')}>
          <div>
            <Label htmlFor="passkey-only" className="text-[13.5px] font-medium">{tr('只用通行密钥登录')}</Label>
            <p className="mt-1 max-w-[60ch] text-[12.5px] leading-[1.7] text-muted-foreground">
              {current === 0
                ? tr('先添加一个通行密钥，才能关闭密码登录。')
                : !m.password_login && !m.password_login_disabled
                  ? tr('站点要求这个账户只用通行密钥登录。')
                  : tr('打开后不能再用密码登录。通行密钥全部丢失时，需要联系管理员恢复。')}
            </p>
          </div>
          <Switch
            id="passkey-only"
            checked={m.password_login_disabled}
            disabled={busy || current === 0}
            onCheckedChange={setOnly}
          />
        </div>
      )}
    </Section>
  );
}

export default function Settings() {
  const tr = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'security' ? 'security' : 'account';
  const setTab = (t: string) => setParams(t === 'account' ? {} : { tab: t }, { replace: true });
  return (
    <>
      <PageTitle title={tr('设置')} sub={tr('账号、邮箱、密码与通行密钥。')} />
      <Tabs value={tab} onValueChange={setTab} className="mt-8">
        <div className="scroll-row">
          <TabsList className="h-10 min-w-max">
            <TabsTrigger value="account" className="px-3 sm:px-5">{tr('账号信息')}</TabsTrigger>
            <TabsTrigger value="security" className="px-3 sm:px-5">{tr('安全设置')}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="account"><Account /></TabsContent>
        <TabsContent value="security"><Security /></TabsContent>
      </Tabs>
    </>
  );
}
