<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { MyBalance, MyNode } from '@/api';
  import { daysLeft, formatDate, formatMoney, formatSpeed, trafficUsage } from '@/lib/format';
  import type { TrafficDay } from '@/lib/traffic';
  import { auth } from '$lib/auth.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';

  /*
   * 仪表盘首屏（外观 A · A3 左栏上半）：一行小字（页标题「仪表盘」· 问候 · 套餐 · 状态）、一句大字（本期还剩多少、几天后到期）、
   * 两把尺（流量用了几成；本期过了几天）、一句判断（照近 7 天的速度何时用完）、操作（续费 / 买重置包）、四个小事实（套餐到期、在线线路、余额、速率）。
   * 数字只来自面板：/me、/me/plan、近 7 天流量（计费字节）、线路、余额。算不出来的部分（无限流量、没有周期）就不画。
   */
  let { week, nodes, balance, full, notices }: {
    /** 提醒（Notices）：画在页标题那行与大字之间 */
    notices?: Snippet;
    week: TrafficDay[];
    nodes: MyNode[] | undefined;
    balance: MyBalance | undefined;
    full: boolean;
  } = $props();

  const DAY = 86_400_000;
  const me = $derived(auth.me);
  const plan = $derived(auth.plan);
  const hasPlan = $derived(!!plan?.plan);
  const usage = $derived(trafficUsage(plan?.traffic_used_bytes ?? me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? null));
  const limited = $derived(hasPlan && !usage.unlimited && usage.total > 0);
  const expiresAt = $derived(plan?.expires_at ?? me?.expires_at ?? null);
  const left = $derived(daysLeft(expiresAt));
  const now = Date.now();

  /* 本期：从上次重置（没有就从开通）到下次重置（没有就到到期） */
  const period = $derived.by(() => {
    const p = plan?.plan;
    if (!p) return null;
    const start = Date.parse(p.last_reset_at ?? p.starts_at);
    const endAt = p.next_reset_at ?? p.expires_at;
    const end = endAt ? Date.parse(endAt) : Number.NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const total = Math.max(1, Math.round((end - start) / DAY));
    const passed = Math.min(total, Math.max(0, Math.ceil((now - start) / DAY)));
    return { start, end, total, passed, reset: !!p.next_reset_at };
  });

  /* 照近 7 天每天的平均计费流量，剩下的还能用多久；只在会在本期结束前用完时提醒 */
  const verdict = $derived.by(() => {
    if (!limited || !period || !full || me?.quota_exhausted) return null;
    const billed = week.reduce((n, d) => n + d.billedBytes, 0);
    if (week.length === 0 || billed <= 0) return null;
    const perDay = billed / week.length;
    const leftBytes = Math.max(0, (plan?.traffic_limit_bytes ?? 0) - (plan?.traffic_used_bytes ?? 0));
    const out = now + (leftBytes / perDay) * DAY;
    if (out >= period.end) return { ok: true as const };
    return { ok: false as const, date: formatDate(new Date(out)), early: Math.max(1, Math.round((period.end - out) / DAY)), reset: period.reset };
  });

  const greeting = $derived.by(() => {
    const h = new Date().getHours();
    return h < 5 ? t('夜深了') : h < 12 ? t('早上好') : h < 18 ? t('下午好') : t('晚上好');
  });
  const state = $derived(me?.expired ? t('已过期') : me?.quota_exhausted ? t('流量已用完') : hasPlan ? t('生效中') : null);

  /* 句子里的数字要加粗：先取整句的译文，再按 {占位符} 切开（语序跟着译文走） */
  type Part = { text: string; em: boolean };
  function rich(key: string, vars: Record<string, string>): Part[] {
    return t(key).split(/(\{\w+\})/).filter(Boolean).map((s) => {
      const m = /^\{(\w+)\}$/.exec(s);
      return m && m[1] in vars ? { text: vars[m[1]], em: true } : { text: s, em: false };
    });
  }

  const gb = (n: number) => `${+n.toFixed(1)} GB`;
  const days = $derived(left === null ? '' : tp('{n} 天', { n: left }));
  const lede = $derived.by((): Part[] => {
    if (me?.expired) return rich('套餐已到期，续费后立即恢复。', {});
    if (me?.quota_exhausted) return rich('本期流量已用完，续费或买重置包后恢复。', {});
    if (!hasPlan) return rich('还没有套餐，选一个就能开始用。', {});
    if (!limited) {
      return left === null
        ? rich('本期已用 {u}，套餐长期有效。', { u: gb(usage.used) })
        : rich('本期已用 {u}，套餐 {d}后到期。', { u: gb(usage.used), d: days });
    }
    return left === null
      ? rich('本期还剩 {l}，套餐长期有效。', { l: gb(usage.left) })
      : rich('本期还剩 {l}，套餐 {d}后到期。', { l: gb(usage.left), d: days });
  });

  const usedPct = $derived(limited ? Math.min(100, Math.max(0, Math.round(100 - usage.leftPct))) : 0);
  const timePct = $derived(period ? Math.round((period.passed / period.total) * 100) : 0);
  const low = $derived(limited && usage.leftPct < 10);
  const online = $derived((nodes ?? []).filter((n) => n.status === 'online').length);
  /* 尺上的刻度：每 5% 一格，每 25% 一道长的 */
  const TICKS = 21;
</script>

<div class="hs">
  <div class="hs-eye"><h1>{t('仪表盘')}</h1><span>· {greeting}</span>{#if plan?.plan}<span>· {plan.plan.name}</span>{/if}{#if state}<span class={['hs-state', (me?.expired || me?.quota_exhausted) && 'warn']}>· {state}</span>{/if}</div>
  {#if notices}<div class="page-notices dnotes" data-page-notices>{@render notices()}</div>{/if}
  <p class="hs-lede">{#each lede as p, i (i)}{#if p.em}<em class="tnum">{p.text}</em>{:else}{p.text}{/if}{/each}</p>

  {#if limited || period}
    <div class="hs-rulers">
      {#if limited}
        <div class="ruler">
          <span class="ruler-n">{t('流量')}</span>
          <div class={['track', low && 'low']} role="meter" aria-label={t('剩余流量')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.leftPct)}
            aria-valuetext={tp('剩余 {l} / {t} GB · 已用 {u}', { l: +usage.left.toFixed(1), t: +usage.total.toFixed(1), u: +usage.used.toFixed(1) })}>
            <i class="track-base"></i>
            <span class="track-ticks" aria-hidden="true">{#each { length: TICKS } as _, k (k)}<i></i>{/each}</span>
            <i class="track-fill" style:width="{usedPct}%"></i>
            <i class="track-pin" style:left="{usedPct}%"></i>
          </div>
          <span class="ruler-r tnum">{usedPct}% <span>{t('已用')}</span></span>
        </div>
      {/if}
      {#if period}
        <div class="ruler">
          <span class="ruler-n">{t('时间')}</span>
          <div class="track time" aria-hidden="true">
            <i class="track-base"></i>
            <span class="track-ticks">{#each { length: TICKS } as _, k (k)}<i></i>{/each}</span>
            <i class="track-fill" style:width="{timePct}%"></i>
            <i class="track-pin" style:left="{timePct}%"></i>
          </div>
          <span class="ruler-r tnum">{period.passed} / {period.total} <span>{t('天')}</span></span>
        </div>
      {/if}
    </div>
  {/if}

  {#if verdict}
    <p class="hs-verdict">
      {#if verdict.ok}{t('照近 7 天的速度，本期流量够用。')}
      {:else}{#each rich(verdict.reset ? '照近 7 天的速度，约 {d} 用完，比重置早 {n} 天。' : '照近 7 天的速度，约 {d} 用完，比到期早 {n} 天。', { d: verdict.date, n: String(verdict.early) }) as p, i (i)}{#if p.em}<b>{p.text}</b>{:else}{p.text}{/if}{/each}{/if}
    </p>
  {/if}

  <div class="hs-acts">
    <a class="btn pri" href={R.shop}>{hasPlan ? t('续费') : t('去选套餐')}</a>
    {#if hasPlan && (me?.quota_exhausted || low)}<a class="btn" href={R.shop}>{t('买重置包')}</a>{/if}
  </div>

  <dl class="hs-facts">
    <div><dt>{t('套餐到期')}</dt><dd>{#if !hasPlan}—{:else if left === null}{t('长期')}{:else}{tp('{n} 天', { n: left })}{/if}{#if expiresAt}<small class="tnum">{formatDate(expiresAt)}</small>{/if}</dd></div>
    <div><dt>{t('在线线路')}</dt><dd>{#if !full}<small>{t('续费后恢复')}</small>{:else if nodes}{online} / {nodes.length}{:else}—{/if}</dd></div>
    <div><dt>{t('余额')}</dt><dd>{balance ? formatMoney(balance.balance_cents) : '—'}{#if balance}<small>{tp('可提现 {v}', { v: formatMoney(balance.withdrawable_cents) })}</small>{/if}</dd></div>
    <div><dt>{t('速率')}</dt><dd>{plan?.plan ? t(formatSpeed(plan.plan.speed_limit_mbps)) : '—'}</dd></div>
  </dl>
</div>
