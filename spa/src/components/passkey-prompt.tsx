import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FlowDialog, FlowFooter } from '@/components/ui/panels';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { passkeyApi } from '@/api';
import { isUserCancel, webauthnSupported } from '@/api/webauthn';
import { usePending } from '@/hooks/use-api';
import { useAuth } from '@/lib/auth';
import { useErrorText } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { useT } from '@/i18n';
import { defaultPasskeyName } from '@/lib/passkey-name';

/**
 * 密码登录后的通行密钥引导（面板登录答复里的 passkey_prompt：站点开了引导、这个账户还没有通行密钥）。
 * 一次登录只问一次；可以勾选「以后只用通行密钥」（面板 disable_password），丢失后由管理员 reset-login 恢复。
 */
export default function PasskeyPrompt() {
  const tr = useT();
  const errText = useErrorText();
  const { passkeyPrompt, dismissPasskeyPrompt } = useAuth();
  const [only, setOnly] = useState(false);
  const [busy, run] = usePending();
  const open = passkeyPrompt && webauthnSupported();

  const add = () => run(async () => {
    try {
      await passkeyApi.add(defaultPasskeyName(), only);
      dismissPasskeyPrompt();
      toast.success(tr('通行密钥已添加'), {
        description: only ? tr('以后这个账户只能用通行密钥登录') : tr('下次可以直接用它登录'),
      });
    } catch (e) {
      if (!isUserCancel(e)) toast.error(errText(e));
    }
  });

  return (
    <FlowDialog
      open={open} onOpenChange={(o) => { if (!o) dismissPasskeyPrompt(); }}
      icon={<KeyRound />}
      title={tr('给这台设备添加通行密钥？')}
      description={tr('下次用 Face ID、指纹或锁屏密码登录，不用再输密码。')}
    >
      <div className="flex items-start justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3.5">
        <div>
          <Label htmlFor="pk-only" className="text-[13.5px] font-medium">{tr('以后只用通行密钥登录')}</Label>
          <p className="mt-1 text-[12.5px] leading-[1.7] text-muted-foreground">
            {tr('打开后这个账户不能再用密码登录。通行密钥全部丢失时，需要联系管理员恢复。')}
          </p>
        </div>
        <Switch id="pk-only" checked={only} onCheckedChange={setOnly} />
      </div>
      <FlowFooter>
        <Button variant="outline" onClick={dismissPasskeyPrompt}>{tr('以后再说')}</Button>
        <Button disabled={busy} onClick={add}>
          <KeyRound />{busy ? tr('等待设备验证…') : tr('添加通行密钥')}
        </Button>
      </FlowFooter>
    </FlowDialog>
  );
}
