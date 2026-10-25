<script lang="ts">
  import { holdBoot } from '$lib/boot.svelte';

  /*
   * 用户中心的整页骨架（v1.4.0 DashSkeleton）：标题 + 指标条 + 若干行。
   * hold = false：页面已经出来、只是在等数据；那种等待最多拖一秒多，不该当成结构缺失一直拖住启动画面。
   */
  let { hold = true }: { hold?: boolean } = $props();
  $effect(() => (hold ? holdBoot() : undefined));
</script>

<div class="dsk load-in" aria-busy="true">
  <span class="sk" style="height:30px;width:190px"></span>
  <span class="sk" style="height:15px;width:min(340px,70%);margin-top:14px"></span>
  <div class="dsk-stats">
    {#each [0, 1, 2, 3] as i (i)}
      <div><span class="sk" style="height:26px;width:86px"></span><span class="sk" style="height:12px;width:62px"></span></div>
    {/each}
  </div>
  <div class="dsk-rows">
    {#each [0, 1, 2, 3, 4] as i (i)}
      <div class="dsk-row">
        <span class="sk" style="height:32px;width:32px;border-radius:9999px;flex:none"></span>
        <div><span class="sk" style="height:14px;width:{52 - i * 6}%"></span><span class="sk" style="height:11px;width:{72 - i * 5}%"></span></div>
        <span class="sk dsk-end" style="height:14px;width:68px"></span>
      </div>
    {/each}
  </div>
</div>
