<script lang="ts">
  import AR from '../assets/flags/AR.svg';
  import AU from '../assets/flags/AU.svg';
  import BR from '../assets/flags/BR.svg';
  import CA from '../assets/flags/CA.svg';
  import CN from '../assets/flags/CN.svg';
  import DE from '../assets/flags/DE.svg';
  import FR from '../assets/flags/FR.svg';
  import GB from '../assets/flags/GB.svg';
  import HK from '../assets/flags/HK.svg';
  import ID from '../assets/flags/ID.svg';
  import IN from '../assets/flags/IN.svg';
  import JP from '../assets/flags/JP.svg';
  import KR from '../assets/flags/KR.svg';
  import MO from '../assets/flags/MO.svg';
  import MY from '../assets/flags/MY.svg';
  import NL from '../assets/flags/NL.svg';
  import PH from '../assets/flags/PH.svg';
  import RU from '../assets/flags/RU.svg';
  import SG from '../assets/flags/SG.svg';
  import TH from '../assets/flags/TH.svg';
  import TR from '../assets/flags/TR.svg';
  import TW from '../assets/flags/TW.svg';
  import US from '../assets/flags/US.svg';
  import VN from '../assets/flags/VN.svg';
  import ZA from '../assets/flags/ZA.svg';

  /*
   * 国旗图标（v1.4.0 components/flag）。用 SVG 而非 emoji：Windows 系统字体不含 regional indicator 组合字形，emoji 国旗会退化成 "HK" 字母对。
   * 只按名字逐个引入用得到的那些旗（与 lib/node.ts 的关键词表对应）；查不到的回退成一个占位方块，不猜。
   */
  let { cc, w = 20, h = 13 }: { cc: string; w?: number; h?: number } = $props();
  const FLAGS: Record<string, string> = { AR, AU, BR, CA, CN, DE, FR, GB, HK, ID, IN, JP, KR, MO, MY, NL, PH, RU, SG, TH, TR, TW, US, VN, ZA };
  const src = $derived(FLAGS[cc.toUpperCase()]);
</script>

{#if src}
  <img class="flag" {src} alt="" title={cc} width={w} height={h} />
{:else}
  <span class="flag ph" style:width="{w}px" style:height="{h}px"></span>
{/if}
