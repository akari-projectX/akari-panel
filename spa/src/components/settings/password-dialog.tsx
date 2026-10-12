import { useState } from 'react';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FlowDialog, FlowFooter } from '@/components/ui/panels';
import TextField from '@/components/text-field';
import { meApi, passkeyApi } from '@/api';
import { isUserCancel } from '@/api/webauthn';
import { usePending } from '@/hooks/use-api';
import { useErrorText } from '@/lib/errors';
import { fieldOf, useFieldErrors } from '@/lib/form-errors';
import { toast } from '@/lib/toast';
import { useT } from '@/i18n';

const MIN = 8;

/**
 * 修改密码 / 设置第一个密码（用通行密钥注册、还没有密码的账户：先用通行密钥确认是本人）。
 * 「至少 8 位」是常驻的帮助文字，确认框离开时就比对；错误画在字段下面并聚焦，不弹浏览器气泡。
 * 改密码后面板结束其它会话，当前这个保留。
 */
export default function PasswordDialog({ open, onOpenChange, first, onDone }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** 账户还没有密码：设置第一个密码 */
  first: boolean;
  onDone: () => void;
}) {
  const tr = useT();
  const errText = useErrorText();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, run] = usePending();
  const f = useFieldErrors(['current', 'next', 'again'] as const);

  const close = (o: boolean) => {
    if (busy) return;
    if (!o) { setCurrent(''); setNext(''); setAgain(''); f.clear(); }
    onOpenChange(o);
  };

  const mismatch = () => again.length > 0 && again !== next;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.check({
      current: !first && !current && tr('请输入当前密码'),
      next: !next ? tr('请输入新密码') : next.length < MIN ? tr('新密码至少 8 位') : undefined,
      again: !again ? tr('请再次输入新密码') : again !== next ? tr('两次输入的新密码不一致') : undefined,
    })) return;
    run(async () => {
      try {
        if (first) {
          await meApi.setFirstPassword(next, await passkeyApi.confirm());
          toast.success(tr('密码已设置'), { description: tr('以后可以用邮箱和密码登录') });
        } else {
          await meApi.changePassword(current, next);
          toast.success(tr('密码已更新'), { description: tr('其他设备上的登录已经结束') });
        }
        onDone();
        close(false);
      } catch (err) {
        if (isUserCancel(err)) return;
        const k = fieldOf(err, {
          'account.invalid_password': 'current', 'account.password_required': 'current',
          'account.password_too_short': 'next', 'account.password_too_long': 'next',
        } as const);
        if (k) f.set(first && k === 'current' ? 'next' : k, errText(err));
        else toast.error(errText(err));
      }
    });
  };

  return (
    <FlowDialog
      open={open} onOpenChange={close} icon={<Lock />}
      title={first ? tr('设置密码') : tr('修改密码')}
      description={first
        ? tr('这个账号还没有密码，只能用通行密钥登录。设置密码需要先用通行密钥确认是你本人。')
        : tr('密码更新后，其他设备需要重新登录')}
    >
      <form id="password-form" noValidate onSubmit={submit} className="space-y-4">
        {!first && (
          <TextField
            {...f.field('current', 'current-password')}
            label={tr('当前密码')} type="password" autoComplete="current-password"
            value={current} onChange={(e) => setCurrent(e.target.value)}
          />
        )}
        <TextField
          {...f.field('next', 'new-password')}
          label={tr('新密码')} type="password" autoComplete="new-password" help={tr('至少 8 位')}
          value={next} onChange={(e) => setNext(e.target.value)}
        />
        <TextField
          {...f.field('again', 'confirm-password')}
          label={tr('确认新密码')} type="password" autoComplete="new-password"
          value={again} onChange={(e) => setAgain(e.target.value)}
          onBlur={() => { if (mismatch()) f.set('again', tr('两次输入的新密码不一致'), false); }}
        />
      </form>
      <FlowFooter>
        <Button variant="outline" disabled={busy} onClick={() => close(false)}>{tr('取消')}</Button>
        <Button type="submit" form="password-form" disabled={busy}>
          {busy ? tr('提交中') : first ? tr('用通行密钥确认并设置') : tr('更新密码')}
        </Button>
      </FlowFooter>
    </FlowDialog>
  );
}
