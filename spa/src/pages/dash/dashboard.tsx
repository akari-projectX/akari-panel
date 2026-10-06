import { lazy, Suspense, useMemo, useState } from 'react';
import { DUR, NUDGE, stagger, useEnter } from '@/lib/motion';
import { Ban, BookOpen, ChevronRight, Headphones, Megaphone, ShieldCheck, TrendingUp, Wifi, Zap } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { PageTitle, PaneHead, Pager, Row, Section, Split, StatRow } from '@/components/flat';
import { Empty, LoadError, Loading } from '@/components/data-state';
import Subscribe from '@/components/subscribe';
import AnnouncementDialog, { PinBadge } from '@/components/announcement-dialog';
import { useAnnouncementText } from '@/lib/announcement';
import Flag from '@/components/flag';
import ResetSubscription from '@/components/reset-subscription';
import OpenOrderNotice from '@/components/pending-order';
import NodeTags from '@/components/node-tags';
import DocCategoryIcon from '@/components/doc-category-icon';
import { useOpenOrder } from '@/hooks/use-open-order';
import { contentApi, meApi, ticketApi, walletApi, type Announcement, type MyNode } from '@/api';
import { useApi } from '@/hooks/use-api';
import { K } from '@/lib/cache';
import { useAuth } from '@/lib/auth';
import { nodeCC, nodeKey, nodeRate, nodeSuspended, nodeUp, rateTone, stripFlag } from '@/lib/node';
import { addDays, daysLeft, formatDate, formatDateTime, formatMoney, formatRate, fromNow, siteToday, toGB, trafficUsage } from '@/lib/format';
import { trafficDays } from '@/lib/traffic';
import { summarize } from '@/lib/content-text';
import { docCategories } from '@/lib/doc-categories';
import { R } from '@/lib/routes';
import { mySubUrl } from '@/lib/sub-links';
import { cn } from '@/lib/utils';
import { useLocale, useT, useTp } from '@/i18n';

/* 流量图要用图表库（109 kB gzip），单独按需加载，别让整个仪表盘等它，见 week-chart.tsx */
const WeekChart = lazy(() => import('./week-chart'));

/**
 * 仪表盘按账户范围变形（lib/auth 的 Scope）：
 *   · admin   —— 只说「请使用后台地址」，不给链接（D4：前台不出现后台地址）；
 *   · banned  —— 封禁说明（管理员写给用户的原因）+ 工单入口，别的都看不了；
 *   · renewal —— 已过期 / 流量用完：没有订阅、节点、流量走势（面板拒绝），其余照常；
 *   · full    —— 全部。
 */
export default function Dashboard() {
  const { scope } = useAuth();
  if (scope === 'admin') return <AdminNotice />;
  if (scope === 'banned') return <BannedNotice />;
  return <Overview full={scope === 'full'} />;
}

function AdminNotice() {
  const tr = useT();
  return (
    <>
      <PageTitle title={tr('管理员账户')} />
      <Section>
        <div className="flex max-w-[62ch] items-start gap-4">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" />
          <div className="space-y-2 text-[14px] leading-[1.9] text-muted-foreground">
            <p className="font-medium text-foreground">{tr('这是管理员账户，用户门户里没有它的内容。')}</p>
            <p>{tr('请使用后台地址登录管理后台。后台地址只有管理员知道，这里不会显示。')}</p>
          </div>
        </div>
      </Section>
    </>
  );
}

function BannedNotice() {
  const tr = useT();
  const tp = useTp();
  const { me } = useAuth();
  return (
    <>
      <PageTitle title={tr('账户已被封禁')} sub={tr('封禁期间不能使用订阅和节点，也不能购买。')} />
      <Section>
        <div className="flex max-w-[66ch] items-start gap-4">
          <Ban className="mt-0.5 size-5 shrink-0 text-danger" />
          <div className="min-w-0 space-y-3 text-[14px] leading-[1.9]">
            {me?.banned_at && <p className="text-muted-foreground">{tp('封禁时间 {t}', { t: formatDateTime(me.banned_at) })}</p>}
            <div>
              <div className="text-[13px] text-muted-foreground">{tr('原因')}</div>
              <p className="mt-1 whitespace-pre-wrap">{me?.ban_reason || tr('管理员没有填写原因。')}</p>
            </div>
            <p className="text-muted-foreground">{tr('如有异议，可以提交工单联系管理员。')}</p>
            <Button asChild><Link to={R.tickets}><Headphones />{tr('提交或查看工单')}</Link></Button>
          </div>
        </div>
      </Section>
    </>
  );
}

function Overview({ full }: { full: boolean }) {
  const enter = useEnter();
  const tr = useT();
  const tp = useTp();
  const nav = useNavigate();
  const { locale } = useLocale();
  const { me, plan } = useAuth();
  const annText = useAnnouncementText();
  const [notice, setNotice] = useState<Announcement | null>(null);

  const announcements = useApi(() => contentApi.announcements(), [], { key: K.announcements });
  const openNotice = (a: Announcement | undefined) => {
    if (!a) return;
    setNotice(a);
    if (!a.read) {
      contentApi.markRead(a.id).catch(() => {});
      const d = announcements.data;
      if (d) announcements.setData({ unread: Math.max(0, d.unread - 1), announcements: d.announcements.map((x) => (x.id === a.id ? { ...x, read: true } : x)) });
    }
  };

  /* 近 7 天（全站时区的日历日，今天算一天）；续费范围的账户面板不给流量记录 */
  const to = siteToday();
  const from = addDays(to, -6);
  const traffic = useApi(() => meApi.traffic(from, to), [from, to], { key: K.traffic(from, to), enabled: full });
  const nodes = useApi(() => meApi.nodes(), [], { key: K.nodes, enabled: full });
  const balance = useApi(() => walletApi.balance({ limit: 1 }), [], { key: K.balance });
  const openOrder = useOpenOrder();
  const docs = useApi(() => contentApi.help(), [], { key: K.help() });
  const tickets = useApi(() => ticketApi.list(), [], { key: K.tickets });

  const week = useMemo(() => trafficDays(traffic.data), [traffic.data]);
  const totalDown = week.reduce((n, d) => n + d.down, 0);
  const totalUp = week.reduce((n, d) => n + d.up, 0);

  /* 能连的排前面（延迟低的在上），暂停 / 离线的沉底——也列出来，用户才知道哪条线路暂时用不了 */
  const list = useMemo(() => {
    const all = nodes.data ?? [];
    const lat = (n: MyNode) => n.latency_ms ?? Number.POSITIVE_INFINITY;
    return [...all.filter(nodeUp).sort((a, b) => lat(a) - lat(b)), ...all.filter((n) => !nodeUp(n))];
  }, [nodes.data]);
  const onlineCount = list.filter(nodeUp).length;
  const [nodePage, setNodePage] = useState(1);
  const pageSize = 5;
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const page = Math.min(nodePage, pages);
  const paged = list.slice((page - 1) * pageSize, page * pageSize);
  const regions = useMemo(() => [...new Set(list.map(nodeCC).filter((c): c is string => !!c))], [list]);
  const avgLatency = useMemo(() => {
    const xs = list.filter(nodeUp).map((n) => n.latency_ms).filter((x): x is number => x != null);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  }, [list]);

  const hasPlan = !!plan?.plan;
  const usage = trafficUsage(plan?.traffic_used_bytes ?? me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? null);
  const expiresAt = plan?.expires_at ?? me?.expires_at ?? null;
  const left = daysLeft(expiresAt);
  const ann = announcements.data?.announcements ?? [];
  /* 顶上那一条：最新一条没读过的公告（置顶的优先，面板已经排好） */
  const latest = ann.find((a) => !a.read);
  const latestText = latest ? annText(latest) : null;
  const brief = useMemo(() => (latestText ? summarize(latestText.html, 80) : ''), [latestText]);

  const categories = useMemo(() => docCategories(docs.data, locale, tr('其他')), [docs.data, locale, tr]);
  const featured = categories[0];
  const openCategory = (name: string) => nav(`${R.help}?cat=${encodeURIComponent(name)}`);
  const replied = useMemo(() => (tickets.data ?? []).filter((t) => t.unread && t.status !== 'closed'), [tickets.data]);
  /* 没有套餐时面板照样给令牌，但链接里没有节点：不显示，引导去商店 */
  const subUrl = hasPlan ? mySubUrl(me) : null;

  return (
    <>
      <PageTitle title={tr('仪表盘')} sub={tr('你的账号状态、流量走势与订阅信息一览。')} />

      {/* 顶上的提醒条，按急迫程度排：没付完的订单 → 客服回复了工单 → 最新公告 */}
      {(openOrder.order || replied.length > 0 || latest) && (
        <div className="mt-5 flex flex-col gap-3">
          {openOrder.order && <OpenOrderNotice order={openOrder.order} onChanged={openOrder.reload} />}

          {replied.length > 0 && (
            <div className="notice">
              <Headphones className="size-4 shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-medium">{tr('管理员已回复你的工单')}</div>
                <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
                  {replied[0].subject}
                  {replied.length > 1 && <> {tp('等 {n} 张', { n: replied.length })}</>}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => nav(R.ticket(replied[0].id))}>{tr('查看回复')}</Button>
            </div>
          )}

          {latest && latestText && (
            <div className="notice">
              <Megaphone className="size-4 shrink-0 text-brand" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-medium">{latestText.title}</div>
                {brief && <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{brief}</div>}
              </div>
              <Button size="sm" variant="outline" onClick={() => openNotice(latest)}>{tr('查看详情')}</Button>
            </div>
          )}
        </div>
      )}

      <Section>
        <StatRow
          items={[
            hasPlan && !usage.unlimited
              ? {
                  k: tr('剩余流量'), v: usage.left, decimals: 1, suffix: ' GB',
                  x: (
                    <div className="space-y-2">
                      {/* 进度条跟着「剩余」走：满格是没怎么用，见底是快用完；不到一成转红提醒 */}
                      <Progress
                        value={usage.leftPct}
                        className={cn('h-1', usage.leftPct < 10 && '[&_[data-slot=progress-indicator]]:bg-destructive')}
                      />
                      <div>{tp('共 {t} GB，已用 {u} GB', { t: +usage.total.toFixed(1), u: +usage.used.toFixed(1) })}</div>
                    </div>
                  ),
                }
              : {
                  k: tr('已用流量'), v: usage.used, decimals: 1, suffix: ' GB',
                  x: hasPlan ? tr('套餐不限流量') : tr('购买套餐后可用'),
                },
            full
              ? {
                  k: tr('可用线路'), v: onlineCount, suffix: tr(' 条'),
                  x: nodes.data ? tp('共 {n} 条线路在订阅内', { n: nodes.data.length }) : tr('正在获取线路列表'),
                }
              : { k: tr('可用线路'), v: 0, suffix: tr(' 条'), x: tr('续费后恢复') },
            {
              k: tr('套餐剩余'), v: !hasPlan ? '—' : left === null ? tr('长期') : left, suffix: hasPlan && left !== null ? tr(' 天') : '',
              x: expiresAt ? tp('到期 {d}', { d: formatDate(expiresAt) }) : hasPlan ? tr('无到期时间') : tr('还没有套餐'),
            },
            {
              /* 单一余额：佣金入账就进余额（佣金追回后可以是负数），可提现的是其中一部分 */
              k: tr('账户余额'), v: balance.data ? formatMoney(balance.data.balance_cents) : '—',
              x: balance.data ? tp('其中可提现 {v}', { v: formatMoney(balance.data.withdrawable_cents) }) : tr('下单时可以抵扣'),
            },
          ]}
        />
      </Section>

      {/* ── 流量走势（续费范围没有） ── */}
      {full && (
        <Section
          title={<><TrendingUp className="size-4 text-brand" />{tr('近 7 日流量趋势')}</>}
          desc={
            <span className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <span className="flex items-baseline gap-1.5">
                <i className="size-2 translate-y-[-1px] rounded-full bg-brand" />
                {tr('下行')} <b className="tnum">{totalDown.toFixed(1)}</b>
                <span className="text-[13px] font-normal text-muted-foreground">GB</span>
              </span>
              <span className="flex items-baseline gap-1.5">
                <i className="size-2 translate-y-[-1px] rounded-full bg-brand-light" />
                {tr('上行')} <b className="tnum">{totalUp.toFixed(1)}</b>
                <span className="text-[13px] font-normal text-muted-foreground">GB</span>
              </span>
            </span>
          }
          extra={traffic.data && (
            <span className="text-[12.5px] text-muted-foreground">
              {tr('计费')} <b className="tnum font-normal text-foreground">{toGB(traffic.data.total.billed_bytes).toFixed(1)}</b> GB
            </span>
          )}
        >
          {traffic.loading && !traffic.data ? <Loading block={256} />
            : traffic.error && !traffic.data ? <LoadError error={traffic.error} onRetry={traffic.reload} />
            : totalDown + totalUp === 0 ? <Empty title="近 7 天还没有流量记录" desc="连上节点跑一会儿，这里就会有走势了。" />
            : (
              <Suspense fallback={<Loading block={256} />}>
                <WeekChart week={week} />
              </Suspense>
            )}
        </Section>
      )}

      {/* ── 订阅 + 公告 ── */}
      <Section>
        <Split
          left={
            <>
              <PaneHead
                title={<><Wifi className="size-4 text-brand" />{tr('接入配置')}</>}
                desc={tr('一个链接，导入任意客户端')}
                extra={full && hasPlan && <ResetSubscription />}
              />
              {subUrl ? <Subscribe />
                : !full ? (
                  <Empty
                    title="订阅已暂停"
                    desc="续费或购买流量重置包后，订阅链接会恢复。"
                    action={<Button size="sm" onClick={() => nav(R.shop)}>{tr('去商店')}</Button>}
                  />
                ) : me?.sub_legacy ? (
                  <Empty
                    title="旧格式的订阅链接"
                    desc="你现在用的订阅链接还能用，但这里显示不出来。重置一次就会换成新的链接（旧链接随即失效）。"
                    action={<ResetSubscription />}
                  />
                ) : (
                  <Empty
                    title="还没有可用的订阅"
                    desc="购买套餐后，订阅链接会出现在这里。"
                    action={<Button size="sm" onClick={() => nav(R.shop)}>{tr('去选套餐')}</Button>}
                  />
                )}
            </>
          }
          right={
            <>
              <PaneHead
                title={<><Megaphone className="size-4 text-brand" />{tr('公告与动态')}</>}
                desc={tr('节点变更、维护与活动通知')}
                extra={<Button variant="link" size="sm" asChild><Link to={R.announcements}>{tr('全部公告')}</Link></Button>}
              />
              {announcements.loading && !announcements.data ? <Loading />
                : announcements.error && !announcements.data ? <LoadError error={announcements.error} onRetry={announcements.reload} />
                : ann.length === 0 ? <Empty title="暂时没有公告" />
                : ann.slice(0, 3).map((a, i) => {
                  const t = annText(a);
                  return (
                    <Row
                      key={a.id} index={i} onClick={() => openNotice(a)}
                      title={
                        <span className="flex min-w-0 items-center gap-2">
                          <PinBadge a={a} />
                          <span className={cn('truncate', !a.read && 'font-medium')}>{t.title}</span>
                        </span>
                      }
                      desc={<span className="line-clamp-1">{summarize(t.html, 60)}</span>}
                      extra={<span className="tnum text-[12.5px] text-muted-foreground">{fromNow(a.created_at, tp)}</span>}
                    />
                  );
                })}
            </>
          }
        />
      </Section>

      {/* ── 文档 + 节点 ── */}
      <Section>
        <Split
          left={
            <>
              <PaneHead
                title={<><BookOpen className="size-4 text-brand" />{tr('使用文档')}</>}
                desc={categories.length ? tp('{n} 个分类', { n: categories.length }) : tr('接入步骤与常见问题')}
                extra={<Button variant="link" size="sm" asChild><Link to={R.help}>{tr('全部文档')}</Link></Button>}
              />

              {docs.loading && !docs.data ? <Loading rows={2} />
                : docs.error && !docs.data ? <LoadError error={docs.error} onRetry={docs.reload} />
                : !featured ? <Empty title="站点还没有发布文档" desc="站长在后台的「知识库」里发布文章后，这里就会有入口。" />
                : (
                  <>
                    <button
                      onClick={() => openCategory(featured.name)}
                      {...enter()}
                      className="group/f w-full rounded-2xl bg-muted/60 p-4 text-left transition-colors hover:bg-muted"
                    >
                      <div className="flex items-center gap-3.5">
                        <DocCategoryIcon name={featured.name} platform={featured.platform} className="size-7 shrink-0 text-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[15px] font-medium">{featured.name}</span>
                            {featured.mine && (
                              <span className="shrink-0 rounded-full bg-brand/10 px-1.5 py-px text-[11px] font-medium text-brand-ink">
                                {tr('当前设备')}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 truncate text-[12.5px] text-muted-foreground">
                            {tp('{n} 篇', { n: featured.articles.length })}
                            {featured.mine && featured.platform && <> · {tr(featured.platform.client)}</>}
                          </div>
                        </div>
                        <span className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-brand">
                          {tr('查看教程')}
                          <ChevronRight className="size-3.5 transition-transform duration-(--dur-fast) group-hover/f:translate-x-0.5" />
                        </span>
                      </div>

                      <ol className="mt-3.5 space-y-1.5 border-t border-border/70 pt-3">
                        {featured.articles.slice(0, 3).map((a, i) => (
                          <li key={a.id} className="flex min-w-0 items-baseline gap-2 text-[12.5px] text-muted-foreground">
                            <span className="tnum shrink-0 text-muted-foreground">{i + 1}</span>
                            <span className="truncate">{a.title}</span>
                          </li>
                        ))}
                        {featured.articles.length > 3 && (
                          <li className="pl-4 text-[12px] text-muted-foreground">{tp('还有 {n} 篇', { n: featured.articles.length - 3 })}</li>
                        )}
                      </ol>
                    </button>

                    {categories.length > 1 && (
                      <div className="mt-5">
                        <div className="mb-2.5 text-[12.5px] tracking-[.05em] text-muted-foreground">{tr('其他分类')}</div>
                        <div className="grid grid-cols-3 gap-1.5">
                          {categories.slice(1, 7).map((c, i) => (
                            <button
                              key={c.name}
                              onClick={() => openCategory(c.name)}
                              {...enter({ delay: stagger(i, 0.08), y: NUDGE, duration: DUR.fast })}
                              className="group/t flex min-w-0 flex-col items-center gap-2 rounded-xl px-2 py-3.5 transition-[background-color,translate] hover:-translate-y-0.5 hover:bg-muted/70"
                            >
                              <DocCategoryIcon name={c.name} platform={c.platform} className="size-5 text-muted-foreground" />
                              <span className="w-full truncate text-center text-[12.5px] font-medium">{c.name}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
            </>
          }
          right={full ? (
            <>
              <PaneHead
                title={<><Zap className="size-4 text-brand" />{tr('订阅内的线路')}</>}
                desc={nodes.data ? tp('{on} 条可用，共 {n} 条', { on: onlineCount, n: nodes.data.length }) : tr('订阅可用的线路')}
                extra={<Button variant="link" size="sm" asChild><Link to={R.nodes}>{tr('全部线路')}</Link></Button>}
              />
              {nodes.loading && !nodes.data ? <Loading />
                : nodes.error && !nodes.data ? <LoadError error={nodes.error} onRetry={nodes.reload} />
                : list.length === 0 ? <Empty title="订阅里还没有可用线路" desc="套餐生效后线路会自动出现。" />
                : (
                  <>
                    <NodeSummary nodes={list} online={onlineCount} avgLatency={avgLatency} regions={regions} />
                    {paged.map((n, i) => {
                      const cc = nodeCC(n);
                      const up = nodeUp(n);
                      const rate = nodeRate(n);
                      return (
                        <Row
                          key={nodeKey(n)} index={(page - 1) * pageSize + i + 1} className={cn(!up && 'is-off')}
                          avatar={cc
                            ? <Flag cc={cc} className="h-[15px] w-[22px]" />
                            : <span className="inline-block h-[15px] w-[22px] shrink-0 rounded-[3px] bg-muted" />}
                          title={
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              {stripFlag(n.name)}<NodeTags tags={n.tags} />
                            </span>
                          }
                          desc={
                            <span className="flex items-center gap-1.5">
                              <span className={cn('size-1.5 shrink-0 rounded-full', up ? 'bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129/.16)]' : 'bg-muted-foreground/50')} />
                              {n.entrance}
                              {up && n.latency_ms != null && ` · ${n.latency_ms} ms`}
                            </span>
                          }
                          extra={up
                            ? <Badge variant="secondary" className={cn('rounded-full', rateTone(rate))}>×{formatRate(rate)}</Badge>
                            : (
                              <Badge variant="secondary" className="gap-1.5 rounded-full bg-muted font-normal text-muted-foreground">
                                <i className="size-1.5 rounded-full bg-muted-foreground/60" />
                                {tr(nodeSuspended(n) ? '已暂停' : '离线')}
                              </Badge>
                            )}
                        />
                      );
                    })}
                    <Pager
                      page={page} pages={pages} onChange={setNodePage}
                      meta={tp('第 {a} / {b} 页 · 共 {n} 条线路', { a: page, b: pages, n: list.length })}
                    />
                  </>
                )}
            </>
          ) : (
            <>
              <PaneHead title={<><Zap className="size-4 text-brand" />{tr('订阅内的线路')}</>} desc={tr('订阅可用的线路')} />
              <Empty title="线路暂不可用" desc="续费或购买流量重置包后，线路会自动恢复。" />
            </>
          )}
        />
      </Section>

      <AnnouncementDialog item={notice} onClose={() => setNotice(null)} />
    </>
  );
}

/**
 * 线路区块顶上的三个汇总：可用几条（每条一格，可用的点亮）、平均延迟、覆盖几个地区。
 * 线路太多时逐格画不下，改成一根比例条；没有测速结果时平均延迟写横杠。
 */
function NodeSummary({ nodes, online, avgLatency, regions }: {
  nodes: MyNode[]; online: number; avgLatency: number | null; regions: string[];
}) {
  const tr = useT();
  const num = 'tnum text-[26px] leading-[1.02] font-medium tracking-[-0.038em] whitespace-nowrap sm:text-[30px]';
  const flags = regions.slice(0, 6);
  return (
    <div className="grid grid-cols-3 gap-4.5 border-b border-border pb-5.5 sm:gap-9">
      <div className="min-w-0">
        <div className={num}>{online}<span className="stat-unit">/ {nodes.length}</span></div>
        <div className="mt-2 text-[13px] text-muted-foreground">{tr('可用')}</div>
        {nodes.length <= 24 ? (
          <div className="mt-3 flex gap-[3px]">
            {nodes.map((n) => (
              <i key={nodeKey(n)} className={cn('h-1.5 flex-1 rounded-[2px]', nodeUp(n) ? 'bg-brand' : 'bg-border')} />
            ))}
          </div>
        ) : <Progress value={nodes.length ? (online / nodes.length) * 100 : 0} className="mt-3 h-1.5" />}
      </div>
      <div className="min-w-0">
        <div className={num}>{avgLatency ?? '—'}{avgLatency != null && <span className="stat-unit">ms</span>}</div>
        <div className="mt-2 text-[13px] text-muted-foreground">{tr('平均延迟')}</div>
      </div>
      <div className="min-w-0">
        <div className={num}>{regions.length}<span className="stat-unit">{tr('地区')}</span></div>
        <div className="mt-2 text-[13px] text-muted-foreground">{tr('覆盖')}</div>
        <div className="mt-3 flex flex-wrap items-center gap-1">
          {flags.map((cc) => <Flag key={cc} cc={cc} className="h-3 w-[18px] rounded-[2px]" />)}
          {regions.length > flags.length && (
            <span className="tnum text-[11.5px] leading-3 text-muted-foreground">+{regions.length - flags.length}</span>
          )}
        </div>
      </div>
    </div>
  );
}
