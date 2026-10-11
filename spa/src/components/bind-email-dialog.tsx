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
import { useSite } from '@/lib/site';
import { toast } from '@/lib/toast';
import { useT, useTp } from '@/i18n';

/** 重发验证码前要等的秒数（面板另有按地址的发信限速） */
const RESEND_SECS = 60;

/**
 * 用通行密钥注册之后的第一步：绑定邮箱。账户在这之前只有一个会话，除了这里什么接口都用不了
 * （面板答 403 account.email_required），所以这个弹窗**不可关闭**（没有关闭按钮，遮罩和 Esc 都不起作用）。
 * 站点要求验证邮箱（「注册需要验证邮箱」开着）就发验证码，否则直接绑定；密码选填，可以跳过，以后在设置页设置。
 * 24 小时内没完成，账户会被自动清理。
 */
export default function BindEmailDialog() {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const site = useSite();
  const { refresh, signOut } = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pwd, setPwd] = useState('');
  const [sent, setSent] = useState(false);
  const [wait, setWait] = useState(0);
  const [busy, run] = usePending();

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const verify = site.emailVerify;
  const domains = site.emailDomains;

  const send = () => run(async () => {
    if (!email.trim()) { toast.error(tr('请先填写邮箱')); return; }
    try {
      await meApi.emailBindCode(email.trim());
      setSent(true);
      setWait(RESEND_SECS);
      toast.success(tr('如果这个邮箱可以使用，验证码已经发出'), { description: tr('请查收邮件，也看看垃圾邮件箱') });
    } catch (err) {
      toast.error(errText(err));
    }
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      try {
        await meApi.emailBind({
          ...(verify ? { code: code.trim() } : { email: email.trim() }),
          ...(pwd ? { password: pwd } : {}),
        });
        await refresh();
        toast.success(tr('邮箱已绑定'), { description: tr('以后用这个邮箱登录，到期提醒和收据也会发到这里。') });
      } catch (err) {
        toast.error(errText(err));
      }
    });
  };

  const ready = verify ? sent && code.trim().length === 6 : email.trim().length > 0;

  return (
    <FlowDialog
      open onOpenChange={() => { /* 不可关闭 */ }} dismissible={false}
      icon={<MailCheck />}
      title={tr('绑定邮箱')}
      description={tr('账号已创建。请先绑定一个邮箱：它是你的登录名，用来接收提醒和找回账号。完成之前其他功能都不能使用。')}
    >
      <form id="bind-email" onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="bind-email-addr">{tr('邮箱')}</Label>
          <Input
            id="bind-email-addr" type="email" className="h-10" autoComplete="email" placeholder="you@example.com"
            value={email} onChange={(e) => setEmail(e.target.value)} disabled={verify && sent}
          />
          {domains.length > 0 && (
            <p className="text-[12px] text-muted-foreground">
              {tr('仅限')} {domains.slice(0, 3).join(' / ')}{domains.length > 3 ? ' …' : ''}
            </p>
          )}
        </div>

        {verify && (
          <div className="space-y-2">
            <Label htmlFor="bind-email-code">{tr('邮箱验证码')}</Label>
            <div className="flex gap-2">
              <Input
                id="bind-email-code" className="h-10 flex-1" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                value={code} onChange={(e) => setCode(e.target.value)} placeholder={tr('六位数字')} disabled={!sent}
              />
              <Button type="button" variant="outline" className="h-10 shrink-0" disabled={busy || wait > 0} onClick={send}>
                {wait > 0 ? tp('{n} 秒后重发', { n: wait }) : sent ? tr('重新发送') : tr('发送验证码')}
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="bind-email-pwd">{tr('密码')}（{tr('选填')}）</Label>
          <Input
            id="bind-email-pwd" type="password" className="h-10" autoComplete="new-password" minLength={8}
            value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder={tr('可以先跳过，以后在设置页设置')}
          />
        </div>
      </form>
      <FlowFooter>
        <Button variant="ghost" disabled={busy} onClick={() => { void signOut(); }}>{tr('退出登录')}</Button>
        <Button type="submit" form="bind-email" disabled={busy || !ready}>
          {busy ? tr('提交中') : tr('完成绑定')}
        </Button>
      </FlowFooter>
    </FlowDialog>
  );
}
