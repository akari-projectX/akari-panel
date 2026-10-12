import { useState } from 'react';
import { passkeyApi, type HolderProof, type LoginMethods } from '@/api';
import { webauthnSupported } from '@/api/webauthn';
import type { ApiState } from '@/hooks/use-api';

/**
 * 危险操作（注销、换邮箱）前确认是本人：当前密码，或本账户的通行密钥。
 * 面板只认它自己的判断（`passkey::confirm_holder`）：只用通行密钥的账户（`password_login=false`）
 * 必须用通行密钥；能用密码的账户有当前通行密钥时也可以改用它。这里只是照着同一个判断给对应的输入。
 * 登录方式（`/me/passkeys`）还没取到或取不到时 unknown = loading / error：不猜，提交不了。
 */
export type HolderMode = 'password' | 'passkey';

export function useHolderConfirm(state: Pick<ApiState<LoginMethods>, 'data' | 'loading' | 'error' | 'reload'>) {
  const methods = state.data;
  const unknown: 'loading' | 'error' | null = methods ? null : state.error ? 'error' : 'loading';
  const canPasskey = !!methods?.available && webauthnSupported() && methods.passkeys.some((k) => k.current);
  const canPassword = methods?.password_login ?? false;
  const [chosen, setChosen] = useState<HolderMode | null>(null);
  const mode: HolderMode = !canPassword && canPasskey ? 'passkey' : chosen === 'passkey' && canPasskey ? 'passkey' : 'password';
  const [password, setPassword] = useState('');
  return {
    mode,
    unknown,
    retry: state.reload,
    /** 只能用通行密钥、但这个浏览器 / 站点用不了：提交不了，提示原因 */
    stuck: !unknown && !canPassword && !canPasskey,
    switchable: canPassword && canPasskey,
    setMode: setChosen,
    password,
    setPassword,
    /** 能提交（密码模式下空密码由调用方的内联校验报出来） */
    usable: !unknown && !(!canPassword && !canPasskey),
    reset: () => setPassword(''),
    /** 提交前调用：通行密钥模式下这里会弹出系统的验证 */
    proof: async (): Promise<HolderProof> => (mode === 'passkey' ? passkeyApi.confirm() : { password }),
  };
}

export type HolderConfirmState = ReturnType<typeof useHolderConfirm>;
