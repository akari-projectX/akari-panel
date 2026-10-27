<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Fingerprint from '@lucide/svelte/icons/fingerprint';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { passkeyApi, type LoginMethods, type PasskeyItem } from '@/api';
  import { isUserCancel, webauthnSupported } from '@/api/webauthn';
  import { formatDate, formatDateTime } from '@/lib/format';
  import { defaultPasskeyName } from '@/lib/passkey-name';
  import Menu from '../ui/Menu.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { toast } from '$lib/toast.svelte';

  /*
   * 通行密钥：头部（名称、说明、「添加」）始终完整，加载 / 出错只替换下面的列表。
   *   · 每行：名称 + 「添加于 · 最近使用」；宽屏行尾两个图标按钮，窄屏收进「⋯」菜单。
   *   · 重命名就地编辑：「保存」「取消」，空名称不能保存并说明。
   *   · 删除先确认：写明设备里那一份要自己删；删的是最后一个当前可用的密钥、又开着「只用通行密钥」时，说明它会随之失效。
   *   · 属于旧域名的行（站点换过主域名 / 通行密钥中心域名）置灰并说明已不能在本站登录，只能删除。
   *   · 添加按钮不会凭空消失：到上限、浏览器不支持时置灰并说明原因。
   * 之后是「只用通行密钥登录」：开关紧贴说明；打开前确认，关掉直接生效；关掉密码登录前必须有一个当前可用的通行密钥（面板 409）。
   */
  let { methods }: { methods: Resource<LoginMethods> } = $props();

  const m = $derived(methods.data);
  const supported = webauthnSupported();
  const items = $derived(m?.passkeys ?? []);
  const current = $derived(items.filter((k) => k.current).length);
  const full = $derived(!!m && items.length >= m.max);

  const adding = new Pending();
  const busy = new Pending();
  let editing = $state<{ id: string; name: string; error?: string } | null>(null);
  let removing = $state<PasskeyItem | null>(null);
  let removeOpen = $state(false);
  let removeError = $state<string | null>(null);
  let confirmLoaded = $state(false);

  function add() {
    void adding.run(async () => {
      try {
        await passkeyApi.add(defaultPasskeyName());
        methods.reload();
        toast.success(t('通行密钥已添加'), { description: t('以后可以直接用它登录') });
      } catch (e) {
        if (!isUserCancel(e)) toast.error(errorText(e));
      }
    });
  }

  function saveName(e: SubmitEvent) {
    e.preventDefault();
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { editing = { ...editing, error: t('名称不能为空') }; return; }
    const id = editing.id;
    void busy.run(async () => {
      try {
        await passkeyApi.rename(id, name);
        editing = null;
        methods.reload();
      } catch (err) {
        if (editing) editing = { ...editing, error: errorText(err) };
      }
    });
  }

  function askRemove(k: PasskeyItem) {
    removeError = null;
    removing = k;
    confirmLoaded = true;
    removeOpen = true;
  }

  function remove() {
    void busy.run(async () => {
      if (!removing) return;
      removeError = null;
      try {
        await passkeyApi.remove(removing.id);
        removeOpen = false;
        methods.reload();
        toast.success(t('通行密钥已删除'), { description: t('设备里保存的那一份需要在设备上自行删除') });
      } catch (e) {
        removeError = errorText(e);
      }
    });
  }

  const lastCurrent = $derived(!!removing?.current && current === 1 && !!m?.password_login_disabled);

  /* 「只用通行密钥登录」 */
  const only = new Pending();
  let asking = $state(false);
  let onlyError = $state<string | null>(null);
  let onlyLoaded = $state(false);

  function setOnly(on: boolean) {
    void only.run(async () => {
      onlyError = null;
      try {
        methods.set(await passkeyApi.setPasswordLogin(!on));
        asking = false;
        toast.success(on ? t('已改为只用通行密钥登录') : t('已恢复密码登录'));
      } catch (e) {
        if (on) onlyError = errorText(e);
        else toast.error(errorText(e));
      }
    });
  }

  function toggleOnly() {
    if (!m) return;
    if (m.password_login_disabled) setOnly(false);
    else { onlyError = null; onlyLoaded = true; asking = true; }
  }
</script>

<div class="set-row stack">
  <div class="pk-head">
    <div class="set-l">
      <div class="set-t">{t('通行密钥')}</div>
      <p class="set-d">
        {!m ? t('用 Face ID、指纹或 Windows Hello 登录，不用输密码。')
          : m.available ? tp('用 Face ID、指纹或 Windows Hello 登录，不用输密码。每个账户最多 {n} 个。', { n: m.max })
          : t('本站暂不支持通行密钥（需要 https 主域名）。')}
      </p>
    </div>
    {#if !m || m.available}
      <div class="add">
        <button type="button" class="btn pri add-b" disabled={!m || adding.busy || full || !supported} onclick={add}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />{adding.busy ? t('等待设备验证…') : t('添加通行密钥')}
        </button>
        {#if m && full}<span class="why">{tp('已达上限 {n} 个', { n: m.max })}</span>{/if}
        {#if m && !supported}<span class="why">{t('当前浏览器不支持通行密钥，请换用新版 Safari、Chrome 或 Edge。')}</span>{/if}
      </div>
    {/if}
  </div>

  <div class="pk-list">
    {#if methods.loading && !m}
      <div class="lines" aria-busy="true" aria-label={t('加载中')}><i></i><i></i></div>
    {:else if methods.error && !m}
      <div class="load-error" role="alert">
        <p>{errorText(methods.error)}</p>
        <button type="button" class="btn sm" onclick={methods.reload}>{t('重试')}</button>
      </div>
    {:else if items.length === 0}
      <p class="none">{t('还没有通行密钥。添加后，登录页点「使用通行密钥登录」就能直接进来。')}</p>
    {:else}
      <ul>
        {#each items as k (k.id)}
          <li class:old={!k.current}>
            <span class="fp"><Fingerprint size={16} strokeWidth={1.75} aria-hidden="true" /></span>
            <div class="mid">
              {#if editing?.id === k.id}
                <form novalidate onsubmit={saveName} class="rename">
                  <div class="rename-row">
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                      class="input" aria-label={t('通行密钥名称')} maxlength={64} autofocus value={editing.name}
                      aria-invalid={editing.error ? true : undefined} aria-describedby={editing.error ? `pk-name-${k.id}` : undefined}
                      oninput={(e) => { editing = { id: k.id, name: e.currentTarget.value }; }}
                      onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); editing = null; } }}
                    />
                    <button type="submit" class="btn pri sm" disabled={busy.busy || !editing.name.trim()}>{t('保存')}</button>
                    <button type="button" class="btn ghost sm" onclick={() => (editing = null)}>{t('取消')}</button>
                  </div>
                  {#if editing.error}<p id="pk-name-{k.id}" role="alert" class="field-msg bad">{editing.error}</p>{/if}
                </form>
              {:else}
                <div class="nm"><span>{k.name}</span>{#if !k.current}<em>{t('属于旧域名')}</em>{/if}</div>
                {#if k.current}
                  <p class="when">
                    <span>{tp('添加于 {d}', { d: formatDate(k.created_at) })}</span>
                    <span>{k.last_used_at ? tp('最近使用 {d}', { d: formatDateTime(k.last_used_at) }) : t('还没用它登录过')}</span>
                  </p>
                {:else}
                  <p class="when">{t('站点换过域名，这个通行密钥已不能在本站登录，可以删除。')}</p>
                {/if}
              {/if}
            </div>
            {#if editing?.id !== k.id}
              <div class="acts">
                {#if k.current}
                  <button type="button" class="iconbtn" aria-label={tp('重命名 {n}', { n: k.name })} title={t('重命名')} onclick={() => (editing = { id: k.id, name: k.name })}>
                    <Pencil size={15} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                {/if}
                <button type="button" class="iconbtn del" aria-label={tp('删除 {n}', { n: k.name })} title={t('删除')} disabled={busy.busy} onclick={() => askRemove(k)}>
                  <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
              <div class="m-acts">
                <Menu
                  class="iconbtn"
                  align="end"
                  label={tp('{n} 的操作', { n: k.name })}
                  items={[
                    ...(k.current ? [{ id: 'rename', label: t('重命名'), onselect: () => (editing = { id: k.id, name: k.name }) }] : []),
                    { id: 'delete', label: t('删除'), onselect: () => askRemove(k) },
                  ]}
                ><Ellipsis size={16} strokeWidth={1.75} aria-hidden="true" /></Menu>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

{#if m && m.available && m.password_set}
  <div class="set-row">
    <div class="set-l">
      <div class="set-t" id="passkey-only-label">{t('只用通行密钥登录')}</div>
      <p class="set-d">
        {current === 0 ? t('先添加一个通行密钥，才能关闭密码登录。')
          : !m.password_login && !m.password_login_disabled ? t('站点要求这个账户只用通行密钥登录。')
          : t('打开后不能再用密码登录。通行密钥全部丢失时，需要联系管理员恢复。')}
      </p>
    </div>
    <div class="set-r">
      <button
        type="button" id="passkey-only" class="switch" role="switch" aria-checked={m.password_login_disabled} aria-labelledby="passkey-only-label"
        data-state={m.password_login_disabled ? 'checked' : 'unchecked'} disabled={only.busy || current === 0} onclick={toggleOnly}
      ><span class="switch-thumb"></span></button>
    </div>
  </div>
{/if}

{#if confirmLoaded}
  {#await import('../ui/ConfirmDialog.svelte') then C}
    <C.default
      bind:open={removeOpen}
      tone="danger"
      title={removing ? tp('删除通行密钥「{n}」？', { n: removing.name }) : ''}
      consequences={[
        t('以后不能再用它登录本站'),
        t('设备里保存的那一份需要在设备上自行删除'),
        ...(lastCurrent ? [t('这是最后一个可用的通行密钥：「只用通行密钥登录」会随之失效，恢复为可以用密码登录')] : []),
      ]}
      confirmLabel={busy.busy ? t('删除中') : t('删除')}
      pending={busy.busy}
      error={removeError}
      onconfirm={remove}
    />
  {/await}
{/if}
{#if onlyLoaded}
  {#await import('../ui/ConfirmDialog.svelte') then C}
    <C.default
      bind:open={asking}
      tone="warn"
      title={t('只用通行密钥登录？')}
      consequences={[t('密码登录随即关闭，登录页只能用通行密钥'), t('通行密钥全部丢失时，需要联系管理员恢复'), t('随时可以在这里改回来')]}
      confirmLabel={only.busy ? t('提交中') : t('确认开启')}
      pending={only.busy}
      error={onlyError}
      onconfirm={() => setOnly(true)}
    />
  {/await}
{/if}

<style>
  .pk-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 24px; }
  .pk-head .set-l { max-width: 52ch; }
  .add-b { height: 36px; }
  .add { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .why { max-width: 28ch; font-size: 12px; color: var(--muted); text-align: right; }
  .pk-list { margin-top: 16px; }
  .none { font-size: 13px; color: var(--muted); }
  ul { list-style: none; border-top: 1px solid var(--line); }
  li { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  li .fp { display: grid; flex: none; place-items: center; width: 32px; height: 32px; margin-top: 2px; border-radius: var(--radius); background: var(--hover); color: var(--fg); }
  li.old .fp, li.old .nm span { opacity: .6; }
  li:last-child { border-bottom: 0; }
  .mid { flex: 1; min-width: 0; }
  .nm { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 14px; font-weight: var(--fw-strong); color: var(--fg); }
  .nm span { overflow-wrap: anywhere; }
  .nm em { font-style: normal; font-size: 12px; font-weight: var(--fw-regular); color: var(--muted); }
  .when { display: flex; flex-wrap: wrap; gap: 0 10px; margin-top: 2px; font-size: 12.5px; line-height: 1.6; color: var(--muted); }
  .when span { white-space: nowrap; }
  .old .when { color: var(--muted); }
  .rename-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .rename-row .input { flex: 1; max-width: 260px; height: 34px; }
  .rename-row .btn { height: 34px; }
  .acts { display: flex; flex: none; gap: 2px; }
  .del:hover { color: var(--danger); }
  .m-acts { display: none; flex: none; }
  @media (max-width: 720px) {
    .m-acts { display: block; }
    .acts { display: none; }
    .add { align-items: flex-start; }
    .why { text-align: left; }
  }
</style>
