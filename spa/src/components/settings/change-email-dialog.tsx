import { useState } from 'react';
import { useResend } from '@/hooks/use-resend';
import { Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FlowDialog, FlowFooter } from '@/components/ui/panels';
import TextField from '@/components/text-field';
import HolderConfirm from '@/components/holder-confirm';
import { useHolderConfirm } from '@/hooks/use-holder-confirm';
import { meApi, passkeyApi } from '@/api';
import { isUserCancel } from '@/api/webauthn';
import { useApi, usePending } from '@/hooks/use-api';
import { useAuth } from '@/lib/auth';
import { K } from '@/lib/cache';
import { useErrorText } from '@/lib/errors';
import { digits, fieldOf, isCode, isEmail, useFieldErrors } from '@/lib/form-errors';
import { toast } from '@/lib/toast';
import { useT, useTp } from '@/i18n';

/**
 * 更换邮箱（两步）：① 新地址 + 确认是本人（当前密码，只用通行密钥的账户用通行密钥）→ 发码；
 * ② 填发到新地址的验证码（带重发倒计时，可以退回第一步改地址）。验证通过后新地址就是登录名（D1）。
 * 地址已被占用时面板的答复和成功一样（不泄露哪些地址注册过），验证那一步才会失败。
 * 站点没开发信时不出现这个入口（`/auth/options` 的 mail，设置页判断）。
 */
export default function ChangeEmailDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const { me, refresh } = useAuth();
  const methods = useApi(() => passkeyApi.list(), [], { key: K.passkeys, enabled: open });
  const holder = useHolderConfirm(methods);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const resend = useResend();
  const [busy, run] = usePending();
  const f = useFieldErrors(['email', 'password', 'code'] as const);
  f.register('password', 'change-email-password');

  const close = (o: boolean) => {
    if (busy) return;
    if (!o) { setEmail(''); setCode(''); setSentTo(null); holder.reset(); f.clear(); }
    onOpenChange(o);
  };

  const send = (e?: React.FormEvent) => {
    e?.preventDefault();
    const to = (sentTo ?? email).trim();
    if (!f.check({
      email: !to ? tr('请输入新邮箱地址') : !isEmail(to) ? tr('请输入有效的邮箱地址')
        : to.toLowerCase() === me?.email.toLowerCase() ? tr('这就是你现在的邮箱') : undefined,
      password: holder.mode === 'password' && !holder.password && tr('请输入当前密码'),
    })) return;
    run(async () => {
      try {
        await meApi.emailCode(to, await holder.proof());
        setSentTo(to);
        setCode('');
        resend.start();
      } catch (err) {
        if (isUserCancel(err)) return;
        const k = fieldOf(err, {
          'signup.invalid_email': 'email', 'signup.domain_not_allowed': 'email', 'account.email_unchanged': 'email',
          'account.invalid_password': 'password', 'account.password_required': 'password', 'account.passkey_failed': 'password',
        } as const);
        if (k) f.set(sentTo ? 'code' : k, errText(err));
        else toast.error(errText(err));
      }
    });
  };

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.check({ code: !isCode(code) && tr('请输入 6 位数字验证码') })) return;
    run(async () => {
      try {
        const r = await meApi.emailVerify(code.trim());
        await refresh();
        close(false);
        toast.success(tr('邮箱已更换'), { description: tp('以后用 {e} 登录', { e: r.email }) });
      } catch (err) {
        if (fieldOf(err, { 'signup.invalid_code': 'code' } as const)) f.set('code', errText(err));
        else toast.error(errText(err));
      }
    });
  };

  return (
    <FlowDialog
      open={open} onOpenChange={close} icon={<Mail />} title={tr('更换邮箱')}
      description={sentTo ? tp('第 {n} 步，共 2 步', { n: 2 }) : tp('第 {n} 步，共 2 步', { n: 1 })}
    >
      {sentTo ? (
        <form id="change-email" noValidate onSubmit={verify} className="space-y-4">
          <div className="rounded-xl bg-muted/60 px-4 py-3 text-[13px] leading-[1.7]">
            <div className="text-muted-foreground">{tr('验证码已发到')}</div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <b className="font-medium break-all">{sentTo}</b>
              <button
                type="button" className="text-[12.5px] text-brand underline-offset-4 hover:underline"
                onClick={() => { setEmail(sentTo); setSentTo(null); f.clear(); }}
              >
                {tr('修改')}
              </button>
            </div>
          </div>
          <TextField
            {...f.field('code', 'change-email-code')}
            label={tr('邮箱验证码')} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={code} onChange={(e) => setCode(digits(e.target.value))} placeholder={tr('六位数字')}
            help={tr('10 分钟内有效。没收到？看看垃圾邮件，或稍后重新发送。')}
            hint={
              <button
                type="button" disabled={busy || resend.left > 0} onClick={() => send()}
                className="text-[12.5px] text-brand underline-offset-4 hover:underline disabled:text-muted-foreground disabled:no-underline"
              >
                {resend.left > 0 ? tp('{n} 秒后重发', { n: resend.left }) : tr('重新发送')}
              </button>
            }
          />
        </form>
      ) : (
        <form id="change-email" noValidate onSubmit={send} className="space-y-4">
          <TextField
            {...f.field('email', 'change-email-new')}
            label={tr('新邮箱地址')} type="email" autoComplete="email" placeholder="you@example.com"
            value={email} onChange={(e) => setEmail(e.target.value)}
            help={tr('新地址验证通过后就是你的登录名，到期提醒、收据和找回密码也改发到新地址。')}
          />
          <HolderConfirm h={holder} id="change-email-password" error={f.errors.password} onInput={() => f.dismiss('password')} />
        </form>
      )}
      <FlowFooter>
        <Button variant="outline" disabled={busy} onClick={() => close(false)}>{tr('取消')}</Button>
        <Button type="submit" form="change-email" disabled={busy || !holder.usable}>
          {busy ? tr('提交中') : sentTo ? tr('确认更换') : tr('发送验证码')}
        </Button>
      </FlowFooter>
    </FlowDialog>
  );
}
