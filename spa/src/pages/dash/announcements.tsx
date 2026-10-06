import { useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import AnnouncementDialog, { PinBadge } from '@/components/announcement-dialog';
import { useAnnouncementText } from '@/lib/announcement';
import { PageTitle, Section } from '@/components/flat';
import { Empty, LoadError, Loading } from '@/components/data-state';
import { summarize } from '@/lib/content-text';
import { contentApi, type Announcement } from '@/api';
import { useApi } from '@/hooks/use-api';
import { K } from '@/lib/cache';
import { fromNow, siteParts, siteTimeZone } from '@/lib/format';
import { DUR, NUDGE, stagger, useEnter } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useLocale, useT, useTp } from '@/i18n';

/* 发布不满这么久的标「新」（毫秒） */
const NEW_WITHIN = 7 * 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 公告与动态：时间轴。
 *
 * 面板一次给全部（置顶的在前），按界面语言取中 / 英文；已读由面板记（POST /me/announcements/{id}/read），
 * 换设备也一致。最新一条放大成头条，其余按月分组（全站时区）挂在一条竖线上；没读过的圆点是品牌蓝、标题加粗。
 */
export default function Announcements() {
  const tr = useT();
  const tp = useTp();
  const { locale } = useLocale();
  const [detail, setDetail] = useState<Announcement | null>(null);

  const res = useApi(() => contentApi.announcements(), [], { key: K.announcements });
  const data = useMemo(() => res.data?.announcements ?? [], [res.data]);
  const unread = res.data?.unread ?? 0;

  const featured = data[0];
  const months = useMemo(() => {
    const out: { key: string; items: Announcement[] }[] = [];
    for (const n of data.slice(1)) {
      const d = siteParts(n.created_at);
      const key = `${d.year} · ${pad(d.month)}`;
      if (out[out.length - 1]?.key !== key) out.push({ key, items: [] });
      out[out.length - 1].items.push(n);
    }
    return out;
  }, [data]);

  const weekday = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: siteTimeZone() }), [locale]);
  const open = (n: Announcement) => {
    setDetail(n);
    if (n.read || !res.data) return;
    contentApi.markRead(n.id).catch(() => {});
    res.setData({
      unread: Math.max(0, res.data.unread - 1),
      announcements: res.data.announcements.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
    });
  };

  return (
    <>
      <PageTitle
        title={tr('公告与动态')}
        sub={tr('节点变更、维护计划与活动通知。没看过的会标出来。')}
        extra={data.length > 0 && (
          <span className="text-[13px] text-muted-foreground">
            {unread > 0 && <><b className="font-medium text-brand">{unread}</b> {tr('条未读')} · </>}
            {tp('共 {n} 条', { n: data.length })}
          </span>
        )}
      />

      <Section>
        {res.loading && !res.data ? <Loading />
          : res.error && !res.data ? <LoadError error={res.error} onRetry={res.reload} />
          : data.length === 0 ? <Empty title="暂时没有公告" desc="站点发布公告后会出现在这里。" />
          : (
            <>
              {featured && (
                <Featured n={featured} weekday={weekday.format(new Date(featured.created_at))} onOpen={() => open(featured)} />
              )}
              {months.map((m, gi) => (
                <div key={m.key}>
                  <div className="flex items-center gap-3.5 pt-7.5 pb-2.5">
                    <span className="tnum text-[13px] font-medium tracking-[.06em]">{m.key}</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  {m.items.map((n, i) => (
                    <TimelineItem
                      key={n.id} n={n} index={gi * 4 + i}
                      weekday={weekday.format(new Date(n.created_at))}
                      joins={i < m.items.length - 1}
                      onOpen={() => open(n)}
                    />
                  ))}
                </div>
              ))}
            </>
          )}
      </Section>

      <AnnouncementDialog item={detail} onClose={() => setDetail(null)} />
    </>
  );
}

/** 头条：最新的一条。桌面左边一大块日期，手机上日期缩成一行放在标题上面 */
function Featured({ n, weekday, onOpen }: { n: Announcement; weekday: string; onOpen: () => void }) {
  const tr = useT();
  const tp = useTp();
  const enter = useEnter();
  const text = useAnnouncementText()(n);
  const d = siteParts(n.created_at);
  /* 挂载时取一次「现在」：渲染里直接调 Date.now()，每次重渲染结果都可能不同 */
  const [now] = useState(() => Date.now());
  const fresh = now - new Date(n.created_at).getTime() < NEW_WITHIN;
  return (
    <div
      {...enter({ y: NUDGE, duration: DUR.fast })}
      className="grid gap-3.5 border-b border-border pb-9 md:grid-cols-[140px_minmax(0,1fr)] md:gap-10 md:pb-11"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 md:flex-col md:items-start">
        <span className="flex items-center gap-2 text-[12.5px] font-medium tracking-[.055em] text-brand">
          <i className="h-px w-2.5 bg-brand" />{tr('最新')}
        </span>
        <span className="tnum text-[34px] leading-[1.02] font-medium tracking-[-0.038em] md:mt-3.5 md:text-[56px]">
          {pad(d.month)}.{pad(d.day)}
        </span>
        <span className="text-[13px] text-muted-foreground md:mt-2">{weekday} · {fromNow(n.created_at, tp)}</span>
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <PinBadge a={n} />
          {!n.read && fresh && <Badge className="rounded-full bg-brand text-white dark:text-primary-foreground">{tr('新')}</Badge>}
        </div>
        <h2 className="mt-3.5 text-[22px] leading-[1.3] font-medium tracking-[-0.028em] md:text-[26px] md:font-semibold">{text.title}</h2>
        <p className="mt-3 max-w-[640px] text-[15px] leading-[1.85] text-body">{summarize(text.html, 140)}</p>
        <button
          type="button" onClick={onOpen}
          className="mt-4 inline-flex cursor-pointer items-center gap-1.5 text-[14px] font-medium text-brand hover:underline"
        >
          {tr('阅读全文')}<ArrowRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * 时间轴上的一条。竖线绝对定位：上端接在圆点下方，下端伸到下一条的圆点——同一个月里连成一根，
 * 月份之间断开（joins）。伸出去的距离 = 本条下内边距 + 下一条上内边距 + 圆点的上边距，两种屏宽各算一次。
 */
function TimelineItem({ n, index, weekday, joins, onOpen }: {
  n: Announcement; index: number; weekday: string; joins: boolean; onOpen: () => void;
}) {
  const enter = useEnter();
  const text = useAnnouncementText()(n);
  const unread = !n.read;
  const d = siteParts(n.created_at);
  return (
    <button
      type="button" onClick={onOpen}
      {...enter({ delay: stagger(index), y: NUDGE, duration: DUR.fast })}
      className="group -mx-3.5 grid w-[calc(100%+28px)] cursor-pointer grid-cols-[44px_14px_minmax(0,1fr)] gap-2.5 rounded-xl px-3.5 py-3.5 text-left transition-colors hover:bg-muted/60 md:grid-cols-[140px_20px_minmax(0,1fr)_24px] md:gap-5 md:py-4.5"
    >
      <div className="text-right md:flex md:items-baseline md:gap-2.5 md:text-left">
        <div className="tnum text-[22px] leading-none font-medium tracking-[-0.03em] md:text-[28px]">{pad(d.day)}</div>
        <div className="mt-1 text-[11.5px] text-muted-foreground md:mt-0 md:text-[13px]">{weekday}</div>
      </div>
      <div className="relative flex flex-col items-center">
        <i className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full md:mt-[9px]',
          unread ? 'bg-brand shadow-[0_0_0_4px_rgb(22_119_255/.14)]' : 'bg-muted-foreground/30',
        )} />
        <i className={cn(
          'absolute top-[22px] left-[calc(50%-0.5px)] w-px bg-border md:top-[27px]',
          joins ? '-bottom-[34px] md:-bottom-[45px]' : 'bottom-0',
        )} />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <PinBadge a={n} />
          <span className={cn('text-[15px] leading-[1.5] tracking-normal', unread ? 'font-medium' : 'font-normal')}>
            {text.title}
          </span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-[1.7] text-muted-foreground md:text-[13.5px] md:leading-[1.75]">
          {summarize(text.html, 90)}
        </p>
      </div>
      <ArrowRight className="mt-1 hidden size-4 text-faint transition-colors group-hover:text-brand md:block" />
    </button>
  );
}
