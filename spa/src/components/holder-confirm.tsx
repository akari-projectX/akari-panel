import { Fingerprint } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { HolderConfirmState } from '@/hooks/use-holder-confirm';
import { useT } from '@/i18n';

/** 确认是本人的输入：密码框，或「提交时用通行密钥验证」，见 hooks/use-holder-confirm */
export default function HolderConfirm({ h, id, label }: { h: HolderConfirmState; id: string; label?: string }) {
  const tr = useT();
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
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label ?? tr('当前密码')}</Label>
        {h.switchable && (
          <button type="button" className="text-[12.5px] text-brand underline-offset-4 hover:underline" onClick={() => h.setMode('passkey')}>
            {tr('改用通行密钥验证')}
          </button>
        )}
      </div>
      <Input
        id={id} type="password" className="h-10" autoComplete="current-password"
        value={h.password} onChange={(e) => h.setPassword(e.target.value)}
      />
    </div>
  );
}
