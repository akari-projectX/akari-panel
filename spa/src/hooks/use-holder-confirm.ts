import { useState } from 'react';
import { passkeyApi, type HolderProof, type LoginMethods } from '@/api';
import { webauthnSupported } from '@/api/webauthn';

/**
 * 危险操作（注销、换邮箱）前确认是本人：当前密码，或本账户的通行密钥。
 * 面板只认它自己的判断（`passkey::confirm_holder`）：只用通行密钥的账户（`password_login=false`）
 * 必须用通行密钥；能用密码的账户有当前通行密钥时也可以改用它。这里只是照着同一个判断给对应的输入。
 */
export type HolderMode = 'password' | 'passkey';

export function useHolderConfirm(methods: LoginMethods | undefined) {
  const canPasskey = !!methods?.available && webauthnSupported() && methods.passkeys.some((k) => k.current);
  const canPassword = methods?.password_login ?? true;
  const [chosen, setChosen] = useState<HolderMode | null>(null);
  const mode: HolderMode = !canPassword && canPasskey ? 'passkey' : chosen === 'passkey' && canPasskey ? 'passkey' : 'password';
  const [password, setPassword] = useState('');
  return {
    mode,
    /** 只能用通行密钥、但这个浏览器 / 站点用不了：提交不了，提示原因 */
    stuck: !canPassword && !canPasskey,
    switchable: canPassword && canPasskey,
    setMode: setChosen,
    password,
    setPassword,
    ready: mode === 'passkey' || password.length > 0,
    reset: () => setPassword(''),
    /** 提交前调用：通行密钥模式下这里会弹出系统的验证 */
    proof: async (): Promise<HolderProof> => (mode === 'passkey' ? passkeyApi.confirm() : { password }),
  };
}

export type HolderConfirmState = ReturnType<typeof useHolderConfirm>;
