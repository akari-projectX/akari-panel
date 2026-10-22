<script lang="ts">
  /* 转圈（按钮里、加载中）：颜色跟随文字 */
  let { size = 14 }: { size?: number } = $props();
</script>

<span class="spin" style:width="{size}px" style:height="{size}px" aria-hidden="true"></span>
