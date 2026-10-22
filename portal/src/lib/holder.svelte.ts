import { passkeyApi, type HolderProof, type LoginMethods } from '@/api';
import { webauthnSupported } from '@/api/webauthn';
import type { Resource } from './resource.svelte';

/**
 * 危险操作（注销、换邮箱）前确认是本人：当前密码，或本账户的通行密钥（与 React 门户 hooks/use-holder-confirm.ts 相同）。
 * 面板只认它自己的判断（`passkey::confirm_holder`）：只用通行密钥的账户（`password_login=false`）必须用通行密钥；
 * 能用密码的账户有当前通行密钥时也可以改用它。这里只是照着同一个判断给对应的输入（components/settings/HolderConfirm）。
 * 登录方式（`/me/passkeys`）还没取到或取不到时 unknown = loading / error：不猜，提交不了。
 */
export type HolderMode = 'password' | 'passkey';

export class Holder {
  chosen = $state<HolderMode | null>(null);
  password = $state('');
  #methods: Resource<LoginMethods>;

  constructor(methods: Resource<LoginMethods>) {
    this.#methods = methods;
  }

  get unknown(): 'loading' | 'error' | null {
    const r = this.#methods;
    return r.data ? null : r.error ? 'error' : 'loading';
  }

  get #canPasskey() {
    const m = this.#methods.data;
    return !!m?.available && webauthnSupported() && m.passkeys.some((k) => k.current);
  }

  get #canPassword() {
    return this.#methods.data?.password_login ?? false;
  }

  get mode(): HolderMode {
    if (!this.#canPassword && this.#canPasskey) return 'passkey';
    return this.chosen === 'passkey' && this.#canPasskey ? 'passkey' : 'password';
  }

  /** 只能用通行密钥、但这个浏览器 / 站点用不了：提交不了，提示原因 */
  get stuck() {
    return !this.unknown && !this.#canPassword && !this.#canPasskey;
  }

  get switchable() {
    return this.#canPassword && this.#canPasskey;
  }

  /** 能提交（密码模式下空密码由调用方的内联校验报出来） */
  get usable() {
    return !this.unknown && !this.stuck;
  }

  retry = () => this.#methods.reload();
  reset = () => { this.password = ''; };

  /** 提交前调用：通行密钥模式下这里会弹出系统的验证 */
  proof = async (): Promise<HolderProof> => (this.mode === 'passkey' ? passkeyApi.confirm() : { password: this.password });
}
