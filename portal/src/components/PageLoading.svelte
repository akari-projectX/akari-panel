<script lang="ts">
  import { holdBoot } from '$lib/boot.svelte';
  import { t } from '$lib/i18n.svelte';
  import Spinner from './Spinner.svelte';

  /* 整页：只有一盏灯，配一行会自己出现的解释（三秒之内加载完就永远不会看到这句）。拖住启动画面：占位在，说明页面结构都还没有 */
  $effect(() => holdBoot());
</script>

<div class="page-loading load-in" aria-busy="true">
  <Spinner size={28} tone="muted" label />
  <p class="load-hint">{t('正在载入，网络较慢时会久一点')}</p>
</div>
