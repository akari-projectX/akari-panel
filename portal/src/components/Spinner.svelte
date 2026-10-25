<script lang="ts">
  /*
   * 活动指示器（v1.4.0 的 Spinner：苹果那只，12 根锥形短棒，亮度依次衰减；见 app.css .spinner）。
   * 按钮里 / 文字旁（默认，14px）颜色跟随文字；tone="muted" 是整页加载用的辅助灰。label：独立出现时给读屏一个名字。
   */
  import { t } from '$lib/i18n.svelte';

  let { size = 14, tone = 'current', label = false }: { size?: number; tone?: 'current' | 'muted'; label?: boolean } = $props();
  const SPOKES = Array.from({ length: 12 }, (_, i) => i);
</script>

<span
  class="spinner"
  style:--spin-size="{size}px"
  style:--spin-color={tone === 'current' ? 'currentColor' : undefined}
  role={label ? 'status' : undefined}
  aria-label={label ? t('加载中') : undefined}
  aria-hidden={label ? undefined : 'true'}
>{#each SPOKES as i (i)}<i style:--i={i}></i>{/each}</span>
