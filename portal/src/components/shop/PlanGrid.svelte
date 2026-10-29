<script lang="ts">
  import type { Me, Offer, OfferAction, ShopPlan } from '@/api';
  import { planSummary } from '@/lib/content-text';
  import { formatBytes, periodText, yuan } from '@/lib/format';
  import { ACTION_TEXT, REFUSAL_TEXT, headline, planRefusal, preselect } from '@/lib/shop';
  import { t, tp } from '$lib/i18n.svelte';

  /*
   * 套餐表（design/portal-polish-2026-10）：共用细线的格子，每行三格（平板两格、手机一格）。
   * 格子上**没有**周期切换，周期只在确认订单里选。每格 = 名称 + 状态（当前套餐 / 已售罄 / 仅续费 / 推荐 / 仅剩 N 个名额）
   * + 一行简介（说明开头的段落）→ 等宽大字「¥x /月 起」（@/lib/shop 的 headline：各周期按月折算的最低价，只是标价换个说法）
   * +「N 种周期可选 · 年付省 x%」→ 一个按钮 + 一行说明 → 规格（流量 + 重置周期、速率）→ 功能清单（说明的其余部分，纯文本）。
   * 按钮的动作 = preselect（流量用完的当前套餐 = 重置包）；买不了的按钮置灰并写原因。只有当前套餐用实底按钮。
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

  /* 最后一行不满时补的空格：三列与两列各一份，CSS 按宽度只显示其中一份（一两个套餐时列数 = 套餐数，不用补） */
  const n = $derived(plans.length);
  const fill3 = $derived(n >= 3 ? (3 - (n % 3)) % 3 : 0);
  const fill2 = $derived(n >= 3 ? n % 2 : 0);
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

        <div class="plan-cta">
          {#if v.act?.action}
            {@const act = v.act}
            <button type="button" class={['btn', 'btn-block', pl.current && 'ink']} onclick={() => onbuy(pl, act, act.action === 'reset')}>
              {t(ACTION_TEXT[act.action!])}
            </button>
          {:else}
            <button type="button" class="btn btn-block" disabled>{t(REFUSAL_TEXT[v.refusal ?? 'not_for_sale'])}</button>
          {/if}
          <p>{note ? t(note) : ''}</p>
        </div>

        <!-- 规格：流量（右边是重置周期）、速率，每格对齐着比 -->
        <dl class="plan-specs">
          <div><dt>{t('流量')}</dt><dd>{pl.traffic_quota_bytes != null ? formatBytes(pl.traffic_quota_bytes) : t('不限')}</dd>{#if pl.traffic_quota_bytes != null}<dd>{reset(pl.period)}</dd>{/if}</div>
          <div><dt>{t('速率')}</dt><dd>{pl.speed_limit_mbps ? `${pl.speed_limit_mbps} Mbps` : t('不限速')}</dd></div>
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
    </article>
  {/each}
  {#each { length: fill3 } as _, i (i)}<div class="fill f3" aria-hidden="true"></div>{/each}
  {#each { length: fill2 } as _, i (i)}<div class="fill f2" aria-hidden="true"></div>{/each}
</div>
