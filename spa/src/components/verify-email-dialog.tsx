import { useEffect, useState } from 'react';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FlowDialog, FlowFooter } from '@/components/ui/panels';
import { meApi } from '@/api';
import { usePending } from '@/hooks/use-api';
import { useAuth } from '@/lib/auth';
import { useErrorText } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { useT, useTp } from '@/i18n';

/** 重发验证码前要等的秒数（面板另有按地址的发信限速） */
const RESEND_SECS = 60;

/**
 * 验证当前邮箱（仪表盘提醒条的「去验证」）：就在当前页弹出，发码 → 填码 → 完成。
 * 账户自己当前的地址不动登录名，面板不要求密码；验证通过后 `/me` 刷新，提醒条随之消失。
 * 换成别的地址在设置页「更换邮箱」里做。
 */
export default function VerifyEmailDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const { me, refresh } = useAuth();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(0);
  const [busy, run] = usePending();

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  /* 关掉再打开：从头来（倒计时保留，防止连点重发） */
  const change = (o: boolean) => {
    if (!o) { setSent(false); setCode(''); }
    onOpenChange(o);
  };

  if (!me) return null;
  const email = me.email;

  const send = () => run(async () => {
    try {
      await meApi.emailCode(email);
      setSent(true);
      setWait(RESEND_SECS);
      toast.success(tr('验证码已发出'), { description: tp('请查收 {e} 的邮件', { e: email }) });
    } catch (err) {
      toast.error(errText(err));
    }
  });

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      try {
        await meApi.emailVerify(code.trim());
        await refresh();
        change(false);
        toast.success(tr('邮箱已验证'), { description: tr('到期提醒、收据和找回密码都会发到这个地址。') });
      } catch (err) {
        toast.error(errText(err));
      }
    });
  };

  return (
    <FlowDialog
      open={open} onOpenChange={change}
      icon={<MailCheck />}
      title={tr('验证邮箱')}
      description={tp('验证码会发到 {e}，10 分钟内有效。', { e: email })}
    >
      <form id="verify-email" onSubmit={verify} className="space-y-2">
        <Label htmlFor="verify-email-code">{tr('邮箱验证码')}</Label>
        <div className="flex gap-2">
          <Input
            id="verify-email-code" className="h-10 flex-1" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={code} onChange={(e) => setCode(e.target.value)} placeholder={tr('六位数字')} disabled={!sent}
          />
          <Button type="button" variant="outline" className="h-10 shrink-0" disabled={busy || wait > 0} onClick={send}>
            {wait > 0 ? tp('{n} 秒后重发', { n: wait }) : sent ? tr('重新发送') : tr('发送验证码')}
          </Button>
        </div>
        {sent && <p className="text-[12.5px] text-muted-foreground">{tr('没收到？看看垃圾邮件，或稍后重新发送。')}</p>}
      </form>
      <FlowFooter>
        <Button variant="outline" onClick={() => change(false)}>{tr('取消')}</Button>
        <Button type="submit" form="verify-email" disabled={busy || !sent || code.trim().length !== 6}>
          {busy && sent ? tr('提交中') : tr('完成验证')}
        </Button>
      </FlowFooter>
    </FlowDialog>
  );
}
