<script lang="ts">
  import LogOut from '@lucide/svelte/icons/log-out';
  import { passkeyApi } from '@/api';
  import { K } from '@/lib/cache';
  import Passkeys from './Passkeys.svelte';
  import { signOut } from '$lib/auth.svelte';
  import { Pending } from '$lib/forms.svelte';
  import { t } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';

  /*
   * 设置 · 登录与安全：密码（修改 / 设置第一个密码）、通行密钥、
   * 只用通行密钥登录、退出所有设备（= 面板的 /auth/logout：作废这个账户的全部会话，包括这一个；先确认）。
   * 登录方式还没取到时不猜「已设置」：先占位，出结果再决定是「修改」还是「设置」。对话框第一次打开时才下载。
   */
  const methods = resource(() => ({ key: K.passkeys, fetch: () => passkeyApi.list() }));
  const m = $derived(methods.data);

  let pwdOpen = $state(false);
  let pwdLoaded = $state(false);
  let leaveOpen = $state(false);
  let leaveLoaded = $state(false);
  const leaving = new Pending();

  function signOutAll() {
    void leaving.run(async () => {
      await signOut();
      leaveOpen = false;
    });
  }
</script>

<section id="security" class="sec" aria-labelledby="h-security">
  <div class="sec-head"><div><h2 id="h-security" class="sec-title">{t('登录与安全')}</h2></div></div>

  <div class="set-row">
    <div class="set-l">
      <div class="set-t">{t('密码')}</div>
      {#if m}<p class="set-d">{m.password_set ? t('修改后，其他设备需要重新登录。') : t('这个账号还没有密码，只能用通行密钥登录。')}</p>{/if}
    </div>
    <div class="set-r">
      {#if !m}
        {#if methods.error}
          <span class="muted">{t('暂时取不到登录方式')}</span>
        {:else}
          <span class="sk" aria-busy="true" aria-label={t('加载中')}></span>
        {/if}
      {:else}
        <span class="val" class:muted={!m.password_set}>{m.password_set ? t('已设置') : t('未设置')}</span>
        <button type="button" class={m.password_set ? 'btn' : 'btn pri'} onclick={() => { pwdLoaded = true; pwdOpen = true; }}>
          {m.password_set ? t('修改') : t('设置密码')}
        </button>
      {/if}
    </div>
  </div>

  <Passkeys {methods} />

  <div class="set-row">
    <div class="set-l">
      <div class="set-t">{t('退出所有设备')}</div>
      <p class="set-d">{t('结束这个账户在所有设备上的登录，包括这一台。')}</p>
    </div>
    <div class="set-r">
      <button type="button" class="btn" onclick={() => { leaveLoaded = true; leaveOpen = true; }}>
        <LogOut size={14} strokeWidth={1.75} aria-hidden="true" />{t('全部退出')}
      </button>
    </div>
  </div>
</section>

{#if pwdLoaded && m}
  {#await import('./PasswordDialog.svelte') then P}<P.default bind:open={pwdOpen} first={!m.password_set} ondone={methods.reload} />{/await}
{/if}
{#if leaveLoaded}
  {#await import('../ui/ConfirmDialog.svelte') then C}
    <C.default
      bind:open={leaveOpen}
      tone="warn"
      title={t('退出所有设备？')}
      consequences={[t('所有设备上的登录立即结束，包括这一台'), t('订阅链接不受影响，客户端照常连接')]}
      confirmLabel={leaving.busy ? t('退出中') : t('全部退出')}
      pending={leaving.busy}
      onconfirm={signOutAll}
    />
  {/await}
{/if}

<style>
  .sk { display: inline-block; width: 96px; height: 13px; border-radius: 4px; background: var(--secondary); }
</style>
