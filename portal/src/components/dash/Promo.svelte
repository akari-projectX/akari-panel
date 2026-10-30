<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import { contentApi } from '@/api';
  import { K } from '@/lib/cache';
  import { Copied } from '$lib/copy.svelte';
  import { i18n, t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';

  /*
   * 仪表盘的活动位（外观 A，右栏，接入配置与教程之间）：站长在后台「内容 › 活动」配置，面板每次只给一个
   * （排序最大、其次最先结束）。标签 + 倒计时「还剩 N 天 HH:MM:SS」、大号折扣字样、标题、一句说明、
   * 虚线框里的优惠码 + 复制（券可用时才有）、去商店（或站长填的按钮）。没有活动就整块不画；倒计时到 0 收起。
   * 倒计时按面板时钟（`now` 与本机时钟的差），每秒走一次，只在页面可见时走（后台标签页不走）。
   */
  const promo = resource(() => ({ key: K.promotion, fetch: () => contentApi.promotion() }));
  const p = $derived(promo.data?.promotion ?? null);
  /* 面板时钟 − 本机时钟：取到数据那一刻算一次 */
  const skew = $derived(promo.data ? new Date(promo.data.now).getTime() - Date.now() : 0);
  let tick = $state(Date.now());
  const left = $derived(p ? Math.max(0, new Date(p.ends_at).getTime() - (tick + skew)) : 0);

  $effect(() => {
    if (!p) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const run = () => {
      clearInterval(timer);
      timer = undefined;
      tick = Date.now();
      if (document.visibilityState === 'visible') timer = setInterval(() => { tick = Date.now(); }, 1000);
    };
    run();
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  });

  const en = $derived(i18n.locale === 'en');
  const title = $derived(p ? (en && p.title_en) || p.title_zh : '');
  const line = $derived(p ? (en && p.line_en) || p.line_zh : '');
  const external = $derived(p ? /^https?:\/\//i.test(p.cta_url) : false);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = $derived.by(() => {
    const s = Math.floor(left / 1000);
    return { d: Math.floor(s / 86400), hms: `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` };
  });
  const copied = new Copied<'code'>();
</script>

{#if p && left > 0}
  <section class="dsec slot" aria-labelledby="h-promo" data-testid="promo">
    <div class="slot-h">
      <span class="slot-tag" id="h-promo">{t('限时活动')}</span>
      <span class="slot-cd tnum" role="timer" aria-label={tp('距活动结束还有 {d} 天 {t}', { d: clock.d, t: clock.hms })}>
        {#if clock.d > 0}{tp('还剩 {d} 天', { d: clock.d })}{' '}{/if}<b>{clock.hms}</b>
      </span>
    </div>
    <div class="slot-b">
      {#if p.badge}<div class="slot-big">{p.badge}</div>{/if}
      <div class="slot-t">
        <h3>{title}</h3>
        <p>{line}</p>
        <div class="slot-acts">
          {#if p.code}
            <span class="slot-code">
              <span>{t('优惠码')}</span>
              <code>{p.code}</code>
              <button type="button" class="slot-copy" onclick={() => copied.copy(p.code ?? '', 'code')}>
                {#if copied.which === 'code'}<Check size={13} strokeWidth={2} aria-hidden="true" />{t('已复制')}{:else}<Copy size={13} strokeWidth={1.75} aria-hidden="true" />{t('复制')}{/if}
              </button>
            </span>
          {/if}
          {#if external}
            <a class="slot-go" href={p.cta_url} target="_blank" rel="noopener noreferrer">{p.cta_label ?? t('去商店')} →</a>
          {:else}
            <a class="slot-go" href={p.cta_url}>{p.cta_label ?? t('去商店')} →</a>
          {/if}
        </div>
      </div>
    </div>
  </section>
{/if}
