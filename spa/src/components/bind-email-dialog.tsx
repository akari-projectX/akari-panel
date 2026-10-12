import { useState } from 'react';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FlowDialog, FlowFooter } from '@/components/ui/panels';
import TextField from '@/components/text-field';
import { meApi } from '@/api';
import { usePending } from '@/hooks/use-api';
import { useResend } from '@/hooks/use-resend';
import { useAuth } from '@/lib/auth';
import { useErrorText } from '@/lib/errors';
import { digits, fieldOf, isCode, isEmail, useFieldErrors } from '@/lib/form-errors';
import { useSite } from '@/lib/site';
import { toast } from '@/lib/toast';
import { useT, useTp } from '@/i18n';

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
  const resend = useResend();
  const [busy, run] = usePending();
  const f = useFieldErrors(['email', 'code', 'pwd'] as const);

  const verify = site.emailVerify;
  const domains = site.emailDomains;
  const FIELD_CODES = {
    'signup.invalid_email': 'email', 'signup.domain_not_allowed': 'email', 'signup.unavailable': 'email',
    'signup.invalid_code': 'code', 'account.bind_no_code': 'code',
    'account.password_too_short': 'pwd', 'account.password_too_long': 'pwd',
  } as const;
  const showError = (err: unknown) => {
    const k = fieldOf(err, FIELD_CODES);
    if (k) f.set(k, errText(err));
    else toast.error(errText(err));
  };
  const emailError = () => (!email.trim() ? tr('请输入邮箱') : !isEmail(email) ? tr('请输入有效的邮箱地址') : undefined);

  const send = () => {
    if (!f.check({ email: emailError() })) return;
    run(async () => {
      try {
        await meApi.emailBindCode(email.trim());
        setSent(true);
        resend.start();
        toast.success(tr('如果这个邮箱可以使用，验证码已经发出'), { description: tr('请查收邮件，也看看垃圾邮件箱') });
      } catch (err) {
        showError(err);
      }
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.check({
      email: !verify ? emailError() : undefined,
      code: verify && (!sent ? tr('请先发送验证码') : !isCode(code) ? tr('请输入 6 位数字验证码') : undefined),
      pwd: pwd && pwd.length < 8 && tr('密码至少 8 位'),
    })) return;
    run(async () => {
      try {
        await meApi.emailBind({
          ...(verify ? { code: code.trim() } : { email: email.trim() }),
          ...(pwd ? { password: pwd } : {}),
        });
        await refresh();
        toast.success(tr('邮箱已绑定'), { description: tr('以后用这个邮箱登录，到期提醒和收据也会发到这里。') });
      } catch (err) {
        showError(err);
      }
    });
  };

  return (
    <FlowDialog
      open onOpenChange={() => { /* 不可关闭 */ }} dismissible={false}
      icon={<MailCheck />}
      title={tr('绑定邮箱')}
      description={tr('账号已创建。请先绑定一个邮箱：它是你的登录名，用来接收提醒和找回账号。完成之前其他功能都不能使用。')}
    >
      <form id="bind-email" noValidate onSubmit={submit} className="space-y-4">
        <TextField
          {...f.field('email', 'bind-email-addr')}
          label={tr('邮箱')} type="email" autoComplete="email" placeholder="you@example.com"
          value={email} onChange={(e) => setEmail(e.target.value)} disabled={verify && sent}
          help={domains.length > 0 ? `${tr('仅限')} ${domains.slice(0, 3).join(' / ')}${domains.length > 3 ? ' …' : ''}` : undefined}
        />

        {verify && (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <TextField
                {...f.field('code', 'bind-email-code')}
                label={tr('邮箱验证码')} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                value={code} onChange={(e) => setCode(digits(e.target.value))} placeholder={tr('六位数字')}
              />
            </div>
            <Button type="button" variant="outline" className="mt-[28px] h-10 shrink-0" disabled={busy || resend.left > 0} onClick={send}>
              {resend.left > 0 ? tp('{n} 秒后重发', { n: resend.left }) : sent ? tr('重新发送') : tr('发送验证码')}
            </Button>
          </div>
        )}

        <TextField
          {...f.field('pwd', 'bind-email-pwd')}
          label={`${tr('密码')}（${tr('选填')}）`} type="password" autoComplete="new-password"
          value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder={tr('可以先跳过，以后在设置页设置')}
          help={tr('至少 8 位')}
        />
      </form>
      <FlowFooter>
        <Button variant="ghost" disabled={busy} onClick={() => { void signOut(); }}>{tr('退出登录')}</Button>
        <Button type="submit" form="bind-email" disabled={busy}>
          {busy ? tr('提交中') : tr('完成绑定')}
        </Button>
      </FlowFooter>
    </FlowDialog>
  );
}
