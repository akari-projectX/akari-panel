<!--
  默认 Logo：L3「光轨 · 圆润小写」akari，品牌蓝的 i 点（design/portal-v2-2026-10/logo/akari-wordmark-*.svg）。
  内联 SVG，颜色来自令牌（--logo-ink / --logo-dot），随明暗切换；站长上传了 Logo 时不用它（Logo.svelte）。
-->
<script lang="ts">
  let { class: cls = '' }: { class?: string } = $props();
</script>

<svg class="wordmark {cls}" viewBox="-11 -11 314 122" aria-hidden="true" focusable="false">
  <g fill="none" stroke-width="15" stroke-linecap="round" stroke-linejoin="round">
    <path d="M52,40 V100" /><circle cx="26" cy="70" r="26" />
    <g transform="translate(82,0)"><path d="M0,0 V100" /><path d="M46,40 L0,74" /><path d="M20,59 L48,100" /></g>
    <g transform="translate(154,0)"><path d="M52,40 V100" /><circle cx="26" cy="70" r="26" /></g>
    <path transform="translate(234,0)" d="M0,100 V68 A28,28 0 0 1 36,42" />
    <path transform="translate(292,0)" d="M0,46 V100" />
  </g>
  <circle class="wordmark-dot" cx="292" cy="18" r="9.5" />
</svg>
