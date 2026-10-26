<script lang="ts">
  import { boot, holdBoot } from '$lib/boot.svelte';
  import { chunkLoaded, loadPage, loadedPage } from '$lib/lazy';
  import type { Component } from 'svelte';
  import type { Page, PageModule, PageProps } from '$lib/pages';
  import DashSkeleton from './DashSkeleton.svelte';
  import ErrorScreen from './ErrorScreen.svelte';
  import PageLoading from './PageLoading.svelte';

  /*
   * 一页：按需下载页面分包（重试 / 新版本自动重新加载见 lib/lazy.ts），下载期间拖住启动画面。
   * 下载过的分包同步渲染，不闪加载态。App 用 {#key 地址} 包着它：换页 = 新实例。
   */
  let { page, params, leaving = false }: { page: Page; params: Record<string, string>; leaving?: boolean } = $props();

  // svelte-ignore state_referenced_locally
  /* 刷新后的第一页：启动画面盖着它，收起时的淡出就是入场，不再播 .page 的淡入（它会拖慢 LCP 的计时，而且白播） */
  // svelte-ignore state_referenced_locally
  const first = !boot.out;
  // svelte-ignore state_referenced_locally
  let mod = $state<PageModule | undefined>(loadedPage(page.load));
  let failed = $state(false);
  const View = $derived(mod?.default as Component<PageProps> | undefined);

  $effect(() => {
    if (mod) { chunkLoaded(); return; }
    const release = holdBoot();
    loadPage(page.load).then(
      (m) => { mod = m; chunkLoaded(); },
      () => { failed = true; },
    ).finally(release);
  });
</script>

{#if View}
  <div class="page" class:out={leaving} class:first>
    <View title={page.title} {params} />
  </div>
{:else if failed}
  <ErrorScreen kind="chunk" />
{:else if page.layout === 'dash'}
  <DashSkeleton />
{:else}
  <PageLoading />
{/if}
