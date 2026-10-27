<script lang="ts">
  import type { Me, Offer, OfferAction, ShopPlan } from '@/api';
  import { planSummary } from '@/lib/content-text';
  import { formatBytes, periodText, yuan } from '@/lib/format';
  import { ACTION_TEXT, REFUSAL_TEXT, headline, planRefusal, preselect } from '@/lib/shop';
  import { t, tp } from '$lib/i18n.svelte';

  /*
   * 套餐卡片（用户确认的样稿 design/shop-cards-2026-10 + portal-v2 shop.html）：
   * 卡片上**没有**周期切换，周期只在确认订单里选。每张卡 = 名称 + 状态（当前套餐 / 已售罄 / 仅续费 / 推荐 / 仅剩 N 个名额）
   * + 一行简介（说明开头的段落）→ 大字「¥x /月 起」（@/lib/shop 的 headline：各周期按月折算的最低价，只是标价换个说法）
   * +「N 种周期可选 · 年付省 x%」→ 三格规格（流量 / 重置 / 速率）→ 功能清单（说明的其余部分，纯文本）→ 一个按钮 + 一行说明。
   * 按钮的动作 = preselect（流量用完的当前套餐 = 重置包）；买不了的按钮置灰并写原因。当前套餐卡与「推荐」套餐卡用主按钮（2026-10-22 裁决）。
   */
  let { plans, me, onbuy }: {
    plans: ShopPlan[];
    me: Pick<Me, 'expired' | 'quota_exhausted'> | undefined;
    onbuy: (plan: ShopPlan, offer: Offer, resetOnly: boolean) => void;
  } = $props();

  /** 按钮下面的一行说明（新购没有） */
  const ACTION_NOTE: Partial<Record<OfferAction, string>> = {
    renew: '从到期日顺延',
    switch: '旧套餐剩余价值自动抵扣',
    reset: '不改变套餐与到期时间',
  };

  const reset = (p: ShopPlan['period']) => {
    if (p === 'monthly') return t('每月');
    const m = /^days-(\d+)$/.exec(p);
    return m ? tp('每 {n} 天', { n: m[1] }) : t('不重置');
  };

  function view(pl: ShopPlan) {
    const act = preselect(pl, me ?? { expired: false, quota_exhausted: false });
    const refusal = planRefusal(pl);
    const tag = pl.current ? { text: t('当前套餐'), kind: 'is-brand' }
      : pl.sold_out ? { text: t('已售罄'), kind: 'is-warn' }
      : refusal === 'renewal_only' ? { text: t('仅续费'), kind: 'is-warn' }
      : pl.recommended ? { text: t('推荐'), kind: 'is-rec' }
      : pl.remaining != null ? { text: tp('仅剩 {n} 个名额', { n: pl.remaining }), kind: 'is-warn' }
      : null;
    return { act, refusal, tag, h: headline(pl), ...planSummary(pl.description), off: !!refusal && !pl.current };
  }
</script>

<div class="plan-cols" data-count={Math.min(plans.length, 6)}>
  {#each plans as pl (pl.plan_id)}
    {@const v = view(pl)}
    {@const note = v.act?.action ? ACTION_NOTE[v.act.action] : undefined}
    <article class={['plan-card', pl.current && 'is-current', v.off && 'is-off']} aria-label={pl.name}>
      <div class="plan-card-body">
        <header class="plan-head">
          <h3>{pl.name}</h3>
          {#if v.tag}<span class={['plan-tag', v.tag.kind]}>{v.tag.text}</span>{/if}
        </header>
        <p class="plan-sum">{v.summary}</p>

        <!-- 价格：按月折算的最低价（或唯一 / 最便宜那一档的标价） -->
        <div class="plan-price" data-testid="plan-price">
          {#if v.h}
            <span class="y">¥</span><span class="n">{yuan(v.h.cents)}</span>
            <span class="u">{v.h.per === 'month' ? t('/月') : `/ ${periodText(v.h.per.period, v.h.per.days, t, tp)}`}{v.h.from ? ` ${t('起')}` : ''}</span>
          {:else}
            <span class="n none">—</span>
          {/if}
        </div>
        <div class="plan-per">
          {#if v.h}{v.h.only ? periodText(v.h.only.period, v.h.only.days, t, tp) : tp('{n} 种周期可选', { n: v.h.count })}{/if}
          {#if v.h?.save}{' · '}<b>{tp('{p}省 {n}%', { p: periodText(v.h.save.offer.period, v.h.save.offer.days, t, tp), n: v.h.save.percent })}</b>{/if}
        </div>

        <!-- 规格：三格，每张卡对齐着比 -->
        <dl class="plan-specs">
          <div><dd>{pl.traffic_quota_bytes != null ? formatBytes(pl.traffic_quota_bytes) : t('不限')}</dd><dt>{t('流量')}</dt></div>
          <div><dd>{pl.traffic_quota_bytes != null ? reset(pl.period) : '—'}</dd><dt>{t('重置')}</dt></div>
          <div><dd>{pl.speed_limit_mbps ? `${pl.speed_limit_mbps} Mbps` : t('不限速')}</dd><dt>{t('速率')}</dt></div>
        </dl>

        {#if v.rest.length > 0}
          <div class="plan-rich">
            {#each v.rest as b, i (i)}
              {#if b.kind === 'ul'}
                <ul>{#each b.items as it, j (j)}<li>{it}</li>{/each}</ul>
              {:else}
                <p>{#each b.lines as l, j (j)}<span>{#if j > 0}<br />{/if}{l}</span>{/each}</p>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <div class="plan-cta">
        {#if v.act?.action}
          {@const act = v.act}
          <button type="button" class={['btn', 'btn-block', (pl.current || pl.recommended) && 'pri']} onclick={() => onbuy(pl, act, act.action === 'reset')}>
            {t(ACTION_TEXT[act.action!])}
          </button>
        {:else}
          <button type="button" class="btn btn-block" disabled>{t(REFUSAL_TEXT[v.refusal ?? 'not_for_sale'])}</button>
        {/if}
        <p>{note ? t(note) : ''}</p>
      </div>
    </article>
  {/each}
</div>
