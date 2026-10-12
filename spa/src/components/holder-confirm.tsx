import { Fingerprint, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sk } from '@/components/loading';
import TextField from '@/components/text-field';
import type { HolderConfirmState } from '@/hooks/use-holder-confirm';
import { useT } from '@/i18n';

/**
 * 确认是本人的输入：密码框，或「提交时用通行密钥验证」，见 hooks/use-holder-confirm。
 * 登录方式还没取到时显示占位；取不到（/me/passkeys 出错）时说明并给「重试」——
 * 不能默认给一个密码框：只用通行密钥的账户会看到一个永远通不过的密码框。
 * error：服务端说密码不对时由调用方给，画在密码框下面并聚焦它（id 由调用方给）。
 */
export default function HolderConfirm({ h, id, label, error, onInput }: {
  h: HolderConfirmState; id: string; label?: string; error?: string; onInput?: () => void;
}) {
  const tr = useT();
  if (h.unknown === 'loading') {
    return <div aria-busy className="space-y-2"><Sk className="h-[13px] w-24" /><Sk className="h-10 w-full rounded-lg" d={0.04} /></div>;
  }
  if (h.unknown === 'error') {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3 text-[13px] leading-[1.7]">
        <span>{tr('无法确定验证方式，请重试。')}</span>
        <Button type="button" size="sm" variant="outline" onClick={h.retry}><RotateCw className="size-3.5" />{tr('重试')}</Button>
      </div>
    );
  }
  if (h.stuck) {
    return (
      <p role="alert" className="text-[12.5px] leading-[1.7] text-danger">
        {tr('这个账户只能用通行密钥确认，但当前浏览器或站点用不了通行密钥。请换用支持通行密钥的浏览器。')}
      </p>
    );
  }
  if (h.mode === 'passkey') {
    return (
      <div className="flex items-start gap-3 rounded-xl bg-muted/60 px-4 py-3.5 text-[13px] leading-[1.7]">
        <Fingerprint className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div>{tr('提交时用通行密钥验证身份（Face ID、指纹或锁屏密码）。')}</div>
          {h.switchable && (
            <button type="button" className="mt-1 text-[12.5px] text-brand underline-offset-4 hover:underline" onClick={() => h.setMode('password')}>
              {tr('改用密码验证')}
            </button>
          )}
          {error && <p role="alert" className="state-in mt-1.5 text-[12.5px] text-danger">{error}</p>}
        </div>
      </div>
    );
  }
  return (
    <TextField
      id={id} type="password" autoComplete="current-password"
      label={label ?? tr('当前密码')}
      hint={h.switchable && (
        <button type="button" className="text-[12.5px] text-brand underline-offset-4 hover:underline" onClick={() => h.setMode('passkey')}>
          {tr('改用通行密钥验证')}
        </button>
      )}
      error={error}
      value={h.password}
      onChange={(e) => h.setPassword(e.target.value)}
      onInput={onInput}
    />
  );
}
