<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import type { Me, Offer, OfferAction, ShopPlan } from '@/api';
  import { planSummary } from '@/lib/content-text';
  import { formatBytes, periodText, yuan } from '@/lib/format';
  import { ACTION_TEXT, REFUSAL_TEXT, headline, planRefusal, preselect } from '@/lib/shop';
  import { t, tp } from '$lib/i18n.svelte';

  /*
   * 套餐卡片（用户确认的样稿 design/shop-cards-2026-10 + portal-v2 shop.html；行为同 React 门户 components/plan-grid.tsx）：
   * 卡片上**没有**周期切换，周期只在确认订单里选。每张卡 = 名称 + 状态（当前套餐 / 已售罄 / 仅续费 / 推荐 / 仅剩 N 个名额）
   * + 一行简介（说明开头的段落）→ 大字「¥x /月 起」（@/lib/shop 的 headline：各周期按月折算的最低价，只是标价换个说法）
   * +「N 种周期可选 · 年付省 x%」→ 三格规格（流量 / 重置 / 速率）→ 功能清单（说明的其余部分，纯文本）→ 一个按钮 + 一行说明。
   * 按钮的动作 = preselect（流量用完的当前套餐 = 重置包）；买不了的按钮置灰并写原因。只有当前套餐卡用主按钮（样稿 notes.md）。
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
    const tag = pl.current ? { text: t('当前套餐'), kind: 'mark' }
      : pl.sold_out ? { text: t('已售罄'), kind: 'mark warn' }
      : refusal === 'renewal_only' ? { text: t('仅续费'), kind: 'mark warn' }
      : pl.recommended ? { text: t('推荐'), kind: 'tg c-blue' }
      : pl.remaining != null ? { text: tp('仅剩 {n} 个名额', { n: pl.remaining }), kind: 'mark warn' }
      : null;
    return { act, refusal, tag, h: headline(pl), ...planSummary(pl.description), off: !!refusal && !pl.current };
  }
</script>

<div class="plans" data-count={Math.min(plans.length, 6)}>
  {#each plans as pl (pl.plan_id)}
    {@const v = view(pl)}
    {@const note = v.act?.action ? ACTION_NOTE[v.act.action] : undefined}
    <article class={['plan', pl.current && 'current', v.off && 'off']} aria-label={pl.name}>
      <div class="body">
        <div class="hd">
          <h3>{pl.name}</h3>
          {#if v.tag}<span class={['tag', v.tag.kind]}>{v.tag.text}</span>{/if}
        </div>
        <p class="desc">{v.summary}</p>

        <div class="price" data-testid="plan-price">
          {#if v.h}
            <span class="y">¥</span><span class="n">{yuan(v.h.cents)}</span>
            <span class="u">{v.h.per === 'month' ? t('/月') : `/ ${periodText(v.h.per.period, v.h.per.days, t, tp)}`}{v.h.from ? ` ${t('起')}` : ''}</span>
          {:else}
            <span class="n none">—</span>
          {/if}
        </div>
        <p class="periods">
          {#if v.h}{v.h.only ? periodText(v.h.only.period, v.h.only.days, t, tp) : tp('{n} 种周期可选', { n: v.h.count })}{/if}
          {#if v.h?.save} · <b>{tp('{p}省 {n}%', { p: periodText(v.h.save.offer.period, v.h.save.offer.days, t, tp), n: v.h.save.percent })}</b>{/if}
        </p>

        <dl class="specs">
          <div><dt>{t('流量')}</dt><dd>{pl.traffic_quota_bytes != null ? formatBytes(pl.traffic_quota_bytes) : t('不限')}</dd></div>
          <div><dt>{t('重置')}</dt><dd>{pl.traffic_quota_bytes != null ? reset(pl.period) : '—'}</dd></div>
          <div><dt>{t('速率')}</dt><dd>{pl.speed_limit_mbps ? `${pl.speed_limit_mbps} Mbps` : t('不限速')}</dd></div>
        </dl>

        {#each v.rest as b, i (i)}
          {#if b.kind === 'ul'}
            <ul class="feats">
              {#each b.items as it, j (j)}<li><Check size={15} strokeWidth={2} aria-hidden="true" />{it}</li>{/each}
            </ul>
          {:else}
            <p class="para">{#each b.lines as l, j (j)}{#if j > 0}<br />{/if}{l}{/each}</p>
          {/if}
        {/each}
      </div>

      <div class="cta">
        {#if v.act?.action}
          {@const act = v.act}
          <button type="button" class={['btn', 'btn-block', pl.current && 'pri']} onclick={() => onbuy(pl, act, act.action === 'reset')}>
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

<style>
  /* 列数随套餐数：1 个最宽 420px，2 个两栏，4 个在宽屏四栏，其余三栏；平板两栏，手机一栏 */
  .plans { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
  .plans[data-count='1'] { grid-template-columns: minmax(0, 420px); }
  .plans[data-count='2'] { grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 900px; }
  @media (min-width: 1200px) { .plans[data-count='4'] { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  .plan { position: relative; display: flex; flex-direction: column; padding: 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
  .plan.current { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
  .plan.off > .body { opacity: .62; }
  .body { flex: 1; }
  .hd { display: flex; align-items: center; gap: 8px; min-height: 24px; }
  h3 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 600; color: var(--fg); }
  .tag { flex: none; }
  .mark { font-size: 12px; font-weight: 500; color: var(--brand); white-space: nowrap; }
  .mark.warn { color: var(--warn); }
  .tg { margin-left: auto; }
  .desc { min-height: 21px; margin-top: 2px; font-size: 13px; color: var(--muted); }
  .price { display: flex; align-items: baseline; gap: 2px; margin-top: 20px; color: var(--fg); font-variant-numeric: tabular-nums; }
  .price .y { font-size: 18px; font-weight: 600; }
  .price .n { font-size: 36px; line-height: 40px; font-weight: 600; letter-spacing: -.02em; }
  .price .n.none { color: var(--faint); }
  .price .u { margin-left: 4px; font-size: 13px; color: var(--muted); }
  .periods { min-height: 20px; margin-top: 6px; font-size: 12.5px; color: var(--muted); }
  .periods b { font-weight: 500; color: var(--ok); white-space: nowrap; }
  .specs { display: grid; grid-template-columns: repeat(3, 1fr); margin: 20px 0 16px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .specs div { padding: 12px 0; text-align: center; }
  .specs div + div { border-left: 1px solid var(--line); }
  .specs dt { font-size: 12px; color: var(--faint); }
  .specs dd { margin-top: 2px; font-size: 15px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .feats { display: grid; gap: 8px; margin: 0 0 16px; padding: 0; list-style: none; font-size: 13.5px; color: var(--body); }
  .feats li { display: flex; align-items: flex-start; gap: 8px; }
  .feats :global(svg) { flex: none; margin-top: 3px; color: var(--ok); }
  .para { margin: 0 0 16px; font-size: 13px; line-height: 1.7; color: var(--muted); }
  .cta { margin-top: 8px; }
  .cta .btn { height: 40px; }
  .cta p { min-height: 18px; margin-top: 8px; font-size: 12.5px; color: var(--faint); text-align: center; }

  @media (max-width: 1080px) {
    .plans, .plans[data-count='4'] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 720px) {
    .plans, .plans[data-count] { grid-template-columns: minmax(0, 1fr); max-width: none; }
    .plan { padding: 20px; }
  }
</style>
