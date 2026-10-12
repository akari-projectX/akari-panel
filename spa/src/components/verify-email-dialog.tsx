import { useState } from 'react';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FlowDialog, FlowFooter } from '@/components/ui/panels';
import TextField from '@/components/text-field';
import { useResend } from '@/hooks/use-resend';
import { meApi } from '@/api';
import { usePending } from '@/hooks/use-api';
import { useAuth } from '@/lib/auth';
import { useErrorText } from '@/lib/errors';
import { digits, fieldOf, isCode, useFieldErrors } from '@/lib/form-errors';
import { toast } from '@/lib/toast';
import { useT, useTp } from '@/i18n';

/**
 * 验证当前邮箱（仪表盘提醒条、设置页「验证」）：就在当前页弹出。
 * 第一步只有一个主按钮「发送验证码」；发出后切到填码（带重发倒计时）。邮箱单独一行、可以断开，手机上不会被挤成三行。
 * 账户自己当前的地址不动登录名，面板不要求密码；验证通过后 `/me` 刷新，提醒条随之消失。
 */
export default function VerifyEmailDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const { me, refresh } = useAuth();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const resend = useResend();
  const [busy, run] = usePending();
  const f = useFieldErrors(['code'] as const);

  /* 关掉再打开：从头来（倒计时保留，防止连点重发） */
  const change = (o: boolean) => {
    if (!o) { setSent(false); setCode(''); f.clear(); }
    onOpenChange(o);
  };

  if (!me) return null;
  const email = me.email;

  const send = () => run(async () => {
    try {
      await meApi.emailCode(email);
      setSent(true);
      resend.start();
    } catch (err) {
      toast.error(errText(err));
    }
  });

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.check({ code: !isCode(code) && tr('请输入 6 位数字验证码') })) return;
    run(async () => {
      try {
        await meApi.emailVerify(code.trim());
        await refresh();
        change(false);
        toast.success(tr('邮箱已验证'), { description: tr('到期提醒、收据和找回密码都会发到这个地址。') });
      } catch (err) {
        if (fieldOf(err, { 'signup.invalid_code': 'code' } as const)) f.set('code', errText(err));
        else toast.error(errText(err));
      }
    });
  };

  return (
    <FlowDialog open={open} onOpenChange={change} icon={<MailCheck />} title={tr('验证邮箱')}>
      <div className="rounded-xl bg-muted/60 px-4 py-3 text-[13px] leading-[1.7]">
        <div className="text-muted-foreground">{sent ? tr('验证码已发到') : tr('验证码会发到')}</div>
        <b className="font-medium break-all">{email}</b>
      </div>
      {sent && (
        <form id="verify-email" noValidate onSubmit={verify}>
          <TextField
            {...f.field('code', 'verify-email-code')}
            label={tr('邮箱验证码')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
            value={code} onChange={(e) => setCode(digits(e.target.value))} placeholder={tr('六位数字')}
            help={tr('10 分钟内有效。没收到？看看垃圾邮件，或稍后重新发送。')}
            hint={
              <button
                type="button" disabled={busy || resend.left > 0} onClick={send}
                className="text-[12.5px] text-brand underline-offset-4 hover:underline disabled:text-muted-foreground disabled:no-underline"
              >
                {resend.left > 0 ? tp('{n} 秒后重发', { n: resend.left }) : tr('重新发送')}
              </button>
            }
          />
        </form>
      )}
      <FlowFooter>
        <Button variant="outline" onClick={() => change(false)}>{tr('取消')}</Button>
        {sent ? (
          <Button type="submit" form="verify-email" disabled={busy}>{busy ? tr('提交中') : tr('完成验证')}</Button>
        ) : (
          <Button onClick={send} disabled={busy || resend.left > 0}>
            {resend.left > 0 ? tp('{n} 秒后重发', { n: resend.left }) : tr('发送验证码')}
          </Button>
        )}
      </FlowFooter>
    </FlowDialog>
  );
}
