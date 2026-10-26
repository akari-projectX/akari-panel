<script lang="ts">
  import '../styles/pages/dashboard.css';
  import Banned from '../components/dash/Banned.svelte';
  import Overview from '../components/dash/Overview.svelte';
  import { scope } from '$lib/auth.svelte';

  /*
   * 仪表盘按账户范围变形（与 React 门户 pages/dash/dashboard.tsx 相同）：
   *   · banned  —— 封禁说明（管理员写给用户的原因）+ 工单入口，别的都看不了；
   *   · renewal —— 已过期 / 流量用完：没有订阅、线路、流量走势（面板拒绝），其余照常；
   *   · full    —— 全部。
   */
</script>

{#if scope() === 'banned'}
  <Banned />
{:else}
  <Overview full={scope() === 'full'} />
{/if}
