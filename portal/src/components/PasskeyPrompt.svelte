<script lang="ts">
  import KeyRound from '@lucide/svelte/icons/key-round';
  import { passkeyApi } from '@/api';
  import { isUserCancel } from '@/api/webauthn';
  import { defaultPasskeyName } from '@/lib/passkey-name';
  import Dialog from './ui/Dialog.svelte';
  import Switch from './ui/Switch.svelte';
  import { auth, dismissPasskeyPrompt } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t } from '$lib/i18n.svelte';
  import { toast } from '$lib/toast.svelte';

  /*
   * 通行密钥引导，两种来源（auth.passkeyPrompt）：
   *   · 'login'  —— 密码登录后（面板登录答复里的 passkey_prompt：站点开了引导、这个账户还没有通行密钥）；
   *     可以打开「以后只用通行密钥登录」（面板 disable_password），丢失后由管理员 reset-login 恢复；
   *   · 'signup' —— 用密码注册成功后第一次进仪表盘：一句安全提醒，只有「下次一定」与「添加」。
   * 一次登录 / 注册只问一次。
   * DashLayout 只在 auth.passkeyPrompt 且浏览器支持通行密钥时挂它（按需加载，含 bits-ui）。
   */
  const signup = auth.passkeyPrompt === 'signup';
  let only = $state(false);
  const busy = new Pending();

  const add = () => busy.run(async () => {
    try {
      await passkeyApi.add(defaultPasskeyName(), only);
      dismissPasskeyPrompt();
      toast.success(t('通行密钥已添加'), {
        description: only ? t('以后这个账户只能用通行密钥登录') : t('下次可以直接用它登录'),
      });
    } catch (e) {
      if (!isUserCancel(e)) toast.error(errorText(e));
    }
  });
</script>

<Dialog
  open
  onOpenChange={(o) => { if (!o) dismissPasskeyPrompt(); }}
  title={signup ? t('添加通行密钥') : t('给这台设备添加通行密钥？')}
  description={signup ? t('为了保证您的账户安全，请添加通行密钥。') : t('下次用 Face ID、指纹或锁屏密码登录，不用再输密码。')}
>
  {#snippet icon()}<KeyRound class="dlg-icon" size={20} strokeWidth={1.5} aria-hidden="true" />{/snippet}
  {#if !signup}
  <div class="setting">
    <div>
      <label for="pk-only">{t('以后只用通行密钥登录')}</label>
      <p>{t('打开后这个账户不能再用密码登录。通行密钥全部丢失时，需要联系管理员恢复。')}</p>
    </div>
    <Switch id="pk-only" bind:checked={only} />
  </div>
  {/if}
  {#snippet footer()}
    <button type="button" class="btn" onclick={dismissPasskeyPrompt}>{signup ? t('下次一定') : t('以后再说')}</button>
    <button type="button" class="btn pri" disabled={busy.busy} onclick={add}>
      <KeyRound class="i" size={16} strokeWidth={1.75} aria-hidden="true" />{busy.busy ? t('等待设备验证…') : signup ? t('添加') : t('添加通行密钥')}
    </button>
  {/snippet}
</Dialog>
