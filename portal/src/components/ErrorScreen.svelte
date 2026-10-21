<script lang="ts">
  import { auth } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';

  /*
   * 整页的错误：找不到页面（404）、页面分包没下完（新版本上线后自动重新加载过一次仍失败）、
   * 连不上面板（不知道登没登录：给「重试」，不送去登录页）。文案与 React 门户相同（共用词典）。
   */
  type Kind = 'notfound' | 'chunk' | 'failed';
  let { kind, onretry }: { kind: Kind; onretry?: () => void } = $props();

  const COPY: Record<Kind, { code: string; title: string; desc: string }> = {
    notfound: { code: '404', title: '这片海图上没有这一页', desc: '地址可能拼错了，或者这个页面已经被移走。下面几个入口是常去的地方。' },
    chunk: { code: '—', title: '这一页没能下载完', desc: '要么是网络断在了半路，要么是我们刚发布了新版本。刷新一次就会取到完整的文件。' },
    failed: { code: '—', title: '这一块没能加载出来', desc: '请稍后重试。' },
  };
  const c = $derived(COPY[kind]);
  /* 找不到页面时给几个常去的地方 */
  const places = $derived(auth.me
    ? [{ to: R.dashboard, label: '仪表盘' }, { to: R.shop, label: '商店' }, { to: R.help, label: '文档' }]
    : [{ to: R.login, label: '登录' }, { to: R.register, label: '注册' }]);
</script>

<div class="err">
  <div class="code" aria-hidden="true">{c.code}</div>
  <h1>{t(c.title)}</h1>
  <p>{t(c.desc)}</p>
  <div class="acts">
    {#if kind === 'notfound'}
      <a class="btn pri" href="/">{t('回首页')}</a>
      <button type="button" class="btn" onclick={() => history.back()}>{t('返回上一页')}</button>
    {:else if kind === 'chunk'}
      <button type="button" class="btn pri" onclick={() => location.reload()}>{t('刷新页面')}</button>
    {:else}
      <button type="button" class="btn pri" onclick={onretry}>{t('重试')}</button>
    {/if}
  </div>
  {#if kind === 'notfound'}
    <nav class="places" aria-label={t('常去的地方')}>
      {#each places as p (p.to)}<a class="link" href={p.to}>{t(p.label)}</a>{/each}
    </nav>
  {/if}
</div>
