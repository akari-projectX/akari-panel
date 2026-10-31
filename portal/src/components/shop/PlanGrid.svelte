<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import type { Me, Offer, OfferAction, ShopPlan } from '@/api';
  import { formatBytes, periodText, yuan } from '@/lib/format';
  import { ACTION_TEXT, REFUSAL_TEXT, headline, planRefusal, preselect } from '@/lib/shop';
  import RichHtml from '../RichHtml.svelte';
  import { t, tp } from '$lib/i18n.svelte';

  /*
   * 套餐列（外观 A，细线分隔、不画卡片；1 个套餐时横排一整行，功能清单在右）：
   * **没有**周期切换，周期只在确认订单里选。每张卡 = 名称 + 状态（当前套餐 / 已售罄 / 仅续费 / 推荐 / 仅剩 N 个名额）
   * + 一行简介（说明开头的段落，面板渲染好的 summary_html）→ 大字「¥x /月 起」（@/lib/shop 的 headline：各周期按月折算的最低价，只是标价换个说法）
   * +「N 种周期可选 · 年付省 x%」→ 三格规格（流量 / 重置 / 速率）→ 功能清单（说明的其余部分 details_html：套餐说明是 Markdown，由面板 src/markdown.rs 渲染并清洗，经 RichHtml 插入）→ 一个按钮（胶囊，靠左）+ 旁边一行说明。
   * 按钮的动作 = preselect（流量用完的当前套餐 = 重置包）；买不了的按钮置灰并写原因。当前套餐卡与「推荐」套餐卡用主按钮（2026-10-22 裁决）。
   */
  let { plans, me, onbuy, buyIntent }: {
    plans: ShopPlan[];
    me: Pick<Me, 'expired' | 'quota_exhausted'> | undefined;
    onbuy: (plan: ShopPlan, offer: Offer, resetOnly: boolean) => void;
    /** 购买按钮上的意图预载（确认订单对话框的分包，lib/dialogs） */
    buyIntent?: Attachment<HTMLElement>;
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
    return { act, refusal, tag, h: headline(pl), off: !!refusal && !pl.current };
  }
</script>

<div class="plan-cols" data-count={Math.min(plans.length, 6)}>
  {#each plans as pl (pl.plan_id)}
    {@const v = view(pl)}
    {@const note = v.act?.action ? ACTION_NOTE[v.act.action] : undefined}
    <article class={['plan-card', pl.current && 'is-current', !pl.current && pl.recommended && !v.off && 'is-rec', v.off && 'is-off']} aria-label={pl.name}>
      <div class="plan-card-body">
        <header class="plan-head">
          <h3>{pl.name}</h3>
          {#if v.tag}<span class={['plan-tag', v.tag.kind]}>{v.tag.text}</span>{/if}
        </header>
        <div class="plan-sum"><RichHtml html={pl.summary_html} /></div>

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
          <!-- 只有一档且价格旁已写着它（/ 一次性（365 天）之类）时不再重复 -->
          {#if v.h}{v.h.only ? (v.h.per === 'month' ? periodText(v.h.only.period, v.h.only.days, t, tp) : '') : tp('{n} 种周期可选', { n: v.h.count })}{/if}
          {#if v.h?.save}{' · '}<b>{tp('{p}省 {n}%', { p: periodText(v.h.save.offer.period, v.h.save.offer.days, t, tp), n: v.h.save.percent })}</b>{/if}
        </div>

        <!-- 规格：三格，每张卡对齐着比 -->
        <dl class="plan-specs">
          <div><dd>{pl.traffic_quota_bytes != null ? formatBytes(pl.traffic_quota_bytes) : t('不限')}</dd><dt>{t('流量')}</dt></div>
          <div><dd>{pl.traffic_quota_bytes != null ? reset(pl.period) : '—'}</dd><dt>{t('重置')}</dt></div>
          <div><dd>{pl.speed_limit_mbps ? `${pl.speed_limit_mbps} Mbps` : t('不限速')}</dd><dt>{t('速率')}</dt></div>
        </dl>

      </div>

      {#if pl.details_html}
        <div class="plan-rich"><RichHtml html={pl.details_html} /></div>
      {/if}

      <div class="plan-cta">
        {#if v.act?.action}
          {@const act = v.act}
          <button type="button" class={['btn', (pl.current || pl.recommended) && 'pri']} {@attach buyIntent} onclick={() => onbuy(pl, act, act.action === 'reset')}>
            {t(ACTION_TEXT[act.action!])}
          </button>
        {:else}
          <button type="button" class="btn" disabled>{t(REFUSAL_TEXT[v.refusal ?? 'not_for_sale'])}</button>
        {/if}
        {#if note}<p>{t(note)}</p>{/if}
      </div>
    </article>
  {/each}
</div>
