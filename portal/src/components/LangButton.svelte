<script lang="ts">
  import { changeLocale } from '$lib/prefs';
  import { i18n, preloadEN, t } from '$lib/i18n.svelte';

  let { class: cls = '' }: { class?: string } = $props();

  /* 中文界面显示 EN、英文界面显示「中」：按钮的名字用目标语言写，看不懂当前语言的人也认得出 */
  const toEn = $derived(i18n.locale !== 'en');
</script>

<button
  type="button"
  class="iconbtn {cls}"
  lang={toEn ? 'en' : 'zh-CN'}
  aria-label={toEn ? 'Switch to English' : t('切换到中文')}
  onpointerenter={preloadEN}
  onfocus={preloadEN}
  onclick={() => changeLocale(toEn ? 'en' : 'zh-CN')}
>{toEn ? 'EN' : '中'}</button>
