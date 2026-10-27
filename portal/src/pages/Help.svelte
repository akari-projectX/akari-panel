<script lang="ts">
  import Article from '../components/help/Article.svelte';
  import DocList from '../components/help/DocList.svelte';
  import { loc } from '$lib/router.svelte';

  /*
   * 文档（使用手册）：?id= 时是一篇文章（换文章 = 新实例：滚回页首、重新取数、记已读），否则是列表。
   */
  const id = $derived(new URLSearchParams(loc.search).get('id'));
</script>

{#if id}
  {#key id}<Article {id} />{/key}
{:else}
  <DocList />
{/if}
