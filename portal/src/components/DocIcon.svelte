<script lang="ts">
  import type { DocIconSpec } from '$lib/doc-icons';

  /* 文档分类 / 设备的图标（lib/doc-icons）：品牌标是实心 SVG（v1.4.0 platform-icon），其余是 lucide 线性图标 */
  let { spec, size, strokeWidth = 1.75, class: cls = '' }: { spec: DocIconSpec; size: number; strokeWidth?: number; class?: string } = $props();
</script>

{#if 'path' in spec}
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" class="shrink-0 {cls}"><path d={spec.path} /></svg>
{:else}
  <spec.icon {size} {strokeWidth} aria-hidden="true" class={cls} />
{/if}
