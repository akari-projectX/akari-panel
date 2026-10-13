import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/panels';
import { Sk } from '@/components/loading';
import { PageTitle, Section } from '@/components/flat';
import { LocaleSwitch, ThemeSwitch } from '@/components/prefs';
import ResetSubscription from '@/components/reset-subscription';
import VerifyEmailDialog from '@/components/verify-email-dialog';
import ChangeEmailDialog from '@/components/settings/change-email-dialog';
import DeleteAccountDialog from '@/components/settings/delete-account-dialog';
import PasswordDialog from '@/components/settings/password-dialog';
import { PasskeyList, PasskeyOnly } from '@/components/settings/passkeys';
import { SettingRow, SettingsNav } from '@/components/settings/setting-row';
import { LogOut } from 'lucide-react';
import { passkeyApi } from '@/api';
import { useApi, usePending } from '@/hooks/use-api';
import { useHashScroll } from '@/hooks/use-hash-scroll';
import { useAuth } from '@/lib/auth';
import { K } from '@/lib/cache';
import { formatDate } from '@/lib/format';
import { R } from '@/lib/routes';
import { useSite } from '@/lib/site';
import { mySubUrl } from '@/lib/sub-links';
import { useT, useTp } from '@/i18n';

/*
 * 设置（2026-10-12 用户裁决，design/portal-settings-audit-2026-10）：单页 + 分区导航，不再分两个页签。
 * 只放「可以改的东西」：套餐详情与订阅导入都在仪表盘，这里只有一行摘要与「重置」。
 *
 *   #account       账户：邮箱（验证 / 更换）、套餐一行摘要
 *   #security      登录与安全：密码、通行密钥、只用通行密钥、退出所有设备
 *   #subscription  订阅链接：状态 + 重置（旧格式链接也能重置；续费范围说明续费后可用）
 *   #preferences   偏好：界面语言（= 邮件语言，主动切换时才同步）、明暗（含跟随系统）
 *   #danger        危险操作：注销账户
 *
 * 旧链接 /account?tab=security 换成 #security（锚点）。
 */

/* ───────────────── 账户 ───────────────── */

function AccountPart() {
  const tr = useT();
  const tp = useTp();
  const site = useSite();
  const { me, plan, scope } = useAuth();
  const [verifying, setVerifying] = useState(false);
  const [changing, setChanging] = useState(false);
  const p = plan?.plan;

  return (
    <Section id="account" title={tr('账户')}>
      <SettingRow
        title={tr('邮箱')}
        desc={site.mail ? tr('登录名，也是到期提醒、收据和找回密码的收件地址。') : tr('站点没有开启邮件发送，暂时不能验证或更换邮箱。')}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 text-[14px] break-all">{me?.email}</span>
          {me?.email_verified
            ? <Badge variant="secondary" className="rounded-full bg-emerald-500/12 text-success">{tr('已验证')}</Badge>
            : <Badge variant="secondary" className="rounded-full bg-amber-500/12 text-warning">{tr('未验证')}</Badge>}
        </div>
        {site.mail && (
          <div className="flex gap-2">
            {!me?.email_verified && <Button className="h-9" onClick={() => setVerifying(true)}>{tr('验证')}</Button>}
            <Button variant="outline" className="h-9" onClick={() => setChanging(true)}>{tr('更换')}</Button>
          </div>
        )}
        <VerifyEmailDialog open={verifying} onOpenChange={setVerifying} />
        <ChangeEmailDialog open={changing} onOpenChange={setChanging} />
      </SettingRow>

      <SettingRow title={tr('套餐')} desc={tr('流量、速率与订阅导入都在仪表盘。')}>
        {p ? (
          <span className="min-w-0 text-[14px]" title={p.name}>
            {plan?.expires_at
              ? tp('{p} · {d} 到期', { p: p.name, d: formatDate(plan.expires_at) })
              : tp('{p} · 长期有效', { p: p.name })}
          </span>
        ) : (
          <span className="text-[14px] text-muted-foreground">{tr('未订阅')}</span>
        )}
        <div className="flex gap-2">
          {p && scope === 'full' && <Button variant="outline" className="h-9" asChild><Link to={R.dashboard}>{tr('查看')}</Link></Button>}
          <Button variant={p ? 'outline' : 'default'} className="h-9" asChild>
            <Link to={R.shop}>{p ? tr('续费') : tr('去商店')}</Link>
          </Button>
        </div>
      </SettingRow>
    </Section>
  );
}

/* ───────────────── 登录与安全 ───────────────── */

function SecurityPart() {
  const tr = useT();
  const nav = useNavigate();
  const { signOut } = useAuth();
  const methods = useApi(() => passkeyApi.list(), [], { key: K.passkeys });
  const [pwdOpen, setPwdOpen] = useState(false);
  const [leaving, run] = usePending();
  const m = methods.data;

  /* 退出所有设备 = 面板的 /auth/logout（作废这个账户的全部会话，包括这一个） */
  const signOutAll = () => run(async () => {
    await signOut().catch(() => {});
    nav(R.login, { replace: true });
  });

  return (
    <Section id="security" title={tr('登录与安全')}>
      <SettingRow
        title={tr('密码')}
        desc={!m ? undefined : m.password_set ? tr('修改后，其他设备需要重新登录。') : tr('这个账号还没有密码，只能用通行密钥登录。')}
      >
        {/* 登录方式还没取到时不猜「已设置」：先占位，出结果再决定是「修改」还是「设置」 */}
        {!m ? (
          methods.error
            ? <span className="text-[13px] text-muted-foreground">{tr('暂时取不到登录方式')}</span>
            : <Sk className="h-[13px] w-24" />
        ) : (
          <>
            <span className="text-[14px]">{m.password_set ? tr('已设置') : <span className="text-muted-foreground">{tr('未设置')}</span>}</span>
            <Button variant={m.password_set ? 'outline' : 'default'} className="h-9" onClick={() => setPwdOpen(true)}>
              {m.password_set ? tr('修改') : tr('设置密码')}
            </Button>
            <PasswordDialog open={pwdOpen} onOpenChange={setPwdOpen} first={!m.password_set} onDone={methods.reload} />
          </>
        )}
      </SettingRow>

      <PasskeyList methods={methods} />
      <PasskeyOnly methods={methods} />

      <SettingRow title={tr('退出所有设备')} desc={tr('结束这个账户在所有设备上的登录，包括这一台。')}>

        <ConfirmDialog
          trigger={<Button variant="outline" className="h-9"><LogOut />{tr('全部退出')}</Button>}
          tone="warning"
          icon={<LogOut />}
          title={tr('退出所有设备？')}
          consequences={[tr('所有设备上的登录立即结束，包括这一台'), tr('订阅链接不受影响，客户端照常连接')]}
          confirmLabel={leaving ? tr('退出中') : tr('全部退出')}
          pending={leaving}
          onConfirm={signOutAll}
        />
      </SettingRow>
    </Section>
  );
}

/* ───────────────── 订阅链接 ───────────────── */

function SubscriptionPart() {
  const tr = useT();
  const { me, scope } = useAuth();
  const url = me ? mySubUrl(me) : null;
  const state = scope !== 'full' ? 'paused'
    : me?.sub_own_client ? 'own'
    : url ? 'ok' : me?.sub_legacy ? 'legacy' : 'none';
  return (
    <Section id="subscription" title={tr('订阅链接')}>
      <SettingRow
        title={tr('订阅链接')}
        desc={tr('等同于账号凭证：拿到它的人能用你的流量。一旦外泄就重置，旧链接与所有设备上的连接立即失效。')}
      >
        <span className="text-[14px]">
          {state === 'ok' ? tr('正常')
            : state === 'own' ? tr('仅限 Akari 客户端（登录账户获取）')
            : state === 'legacy' ? tr('旧格式链接，重置后可查看')
            : state === 'paused' ? <span className="text-muted-foreground">{tr('续费后可用')}</span>
            : <span className="text-muted-foreground">{tr('购买套餐后可用')}</span>}
        </span>
        <div className="flex gap-2">
          {(state === 'ok' || state === 'legacy' || state === 'own') && <ResetSubscription look="button" />}
          {(state === 'ok' || state === 'own') && <Button variant="outline" className="h-9" asChild><Link to={`${R.dashboard}#subscribe`}>{state === 'own' ? tr('下载客户端') : tr('去导入')}</Link></Button>}
          {(state === 'paused' || state === 'none') && <Button className="h-9" asChild><Link to={R.shop}>{tr('去商店')}</Link></Button>}
        </div>
      </SettingRow>
    </Section>
  );
}

/* ───────────────── 偏好 ───────────────── */

function PreferencesPart() {
  const tr = useT();
  return (
    <Section id="preferences" title={tr('偏好')}>
      <SettingRow title={tr('界面语言')} desc={tr('邮件也用这门语言：在这里或页头切换时一起改。')}>

        <LocaleSwitch />
      </SettingRow>
      <SettingRow title={tr('明暗')} desc={tr('浅色、深色，或跟随系统（默认）。')}>

        <ThemeSwitch />
      </SettingRow>
    </Section>
  );
}

/* ───────────────── 危险操作 ───────────────── */

function DangerPart() {
  const tr = useT();
  const [open, setOpen] = useState(false);
  return (
    <Section id="danger" title={tr('危险操作')} className="settings-danger">
      <SettingRow title={tr('注销账户')} desc={tr('删除你的个人数据。付款与退款记录按法规匿名保留。注销后不能恢复。')}>

        <Button variant="outline" className="h-9 text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
          {tr('注销账户…')}
        </Button>
        <DeleteAccountDialog open={open} onOpenChange={setOpen} />
      </SettingRow>
    </Section>
  );
}

export default function Settings() {
  const tr = useT();
  const nav = useNavigate();
  const [params] = useSearchParams();
  /* 旧链接：?tab=security → #security */
  const legacyTab = params.get('tab');
  useEffect(() => {
    if (legacyTab === 'security') nav({ search: '', hash: 'security' }, { replace: true });
  }, [legacyTab, nav]);
  useHashScroll(!legacyTab);

  const parts = useMemo(() => [
    { id: 'account', label: tr('账户') },
    { id: 'security', label: tr('登录与安全') },
    { id: 'subscription', label: tr('订阅链接') },
    { id: 'preferences', label: tr('偏好') },
    { id: 'danger', label: tr('危险操作') },
  ], [tr]);

  return (
    <>
      <PageTitle title={tr('设置')} sub={tr('账户、登录与安全、订阅链接、语言与明暗。')} />
      <div className="settings-page">
        <SettingsNav parts={parts} />
        <div className="min-w-0">
          <AccountPart />
          <SecurityPart />
          <SubscriptionPart />
          <PreferencesPart />
          <DangerPart />
        </div>
      </div>
    </>
  );
}
