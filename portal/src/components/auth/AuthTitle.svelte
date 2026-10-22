<script lang="ts">
  import type { Snippet } from 'svelte';

  /* 没有「登录 / 注册」标签的那几页（找回、重设密码、暂停注册、注销结果）：标题 + 一行真实信息 */
  let { title, lead, icon }: { title: string; lead?: string; icon?: Snippet } = $props();
</script>

<div class="auth-head">
  {@render icon?.()}
  <h1>{title}</h1>
  {#if lead}<p class="lead">{lead}</p>{/if}
</div>
