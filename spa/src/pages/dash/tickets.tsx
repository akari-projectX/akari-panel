import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Headphones, LifeBuoy, MessageCircle, Plus, Send, UserRound } from 'lucide-react';
import { DUR, NUDGE, stagger, useEnter } from '@/lib/motion';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FlowDialog, FlowFooter, ReadingDialog } from '@/components/ui/panels';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageTitle, Row, Section, StatRow } from '@/components/flat';
import { Empty, LoadError, Loading } from '@/components/data-state';
import StatusTag from '@/components/status-tag';
import type { StatusTone } from '@/lib/format';
import {
  TICKET_CATEGORIES, TICKET_MAX_BODY, TICKET_MAX_SUBJECT, TICKET_PRIORITIES, orderApi, ticketApi,
  type TicketCategory, type TicketPriority, type TicketRow, type TicketStatus,
} from '@/api';
import { useApi, usePending } from '@/hooks/use-api';
import { useAuth } from '@/lib/auth';
import { K } from '@/lib/cache';
import { useErrorText } from '@/lib/errors';
import { formatDateTime, fromNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useT, useTp } from '@/i18n';

const PRIORITY: Record<TicketPriority, { text: string; cls: string; hint: string }> = {
  low: { text: '低', cls: 'bg-muted text-muted-foreground', hint: '咨询、建议，不着急' },
  normal: { text: '普通', cls: 'bg-brand/10 text-brand-ink', hint: '部分节点或功能异常' },
  high: { text: '高', cls: 'bg-amber-500/12 text-warning', hint: '无法正常使用' },
  urgent: { text: '紧急', cls: 'bg-red-500/10 text-danger', hint: '完全不能用、涉及付款' },
};

const CATEGORY: Record<TicketCategory, string> = {
  general: '一般问题',
  billing: '账单与付款',
  technical: '连接与技术',
  account: '账户',
  other: '其他',
};

/** 面板的三种状态：open（等客服）/ answered（客服回了，等你）/ closed */
const STATE: Record<TicketStatus, { text: string; tone: StatusTone }> = {
  open: { text: '待处理', tone: 'info' },
  answered: { text: '已回复', tone: 'success' },
  closed: { text: '已关闭', tone: 'neutral' },
};

/**
 * 工单。客服的新回复由面板记未读（列表的 unread，打开详情即已读），换设备也一致。
 * 被封禁的账户也能用（这是他们唯一的申诉渠道）。限制：每小时 5 张、最多 5 张未关闭、标题 120 字、正文 5000 字。
 */
export default function Tickets() {
  const enter = useEnter();
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const { scope } = useAuth();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<TicketRow | null>(null);
  /* 关闭时 current 先变成 null、弹窗后退场：退场期间接着显示刚才那张 */
  const [shown, setShown] = useState<TicketRow | null>(null);
  if (current && current !== shown) setShown(current);

  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<TicketCategory>('general');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [orderId, setOrderId] = useState('none');
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('');
  const [creating, runCreate] = usePending();
  const [replying, runReply] = usePending();
  const [closing, runClose] = usePending();

  const tickets = useApi(() => ticketApi.list(), [], { key: K.tickets });
  const list = tickets.data ?? [];
  /* 关联订单：封禁账户看不了订单 */
  const orders = useApi(() => orderApi.list(), [], { key: K.orders, enabled: open && scope !== 'banned' });

  const detail = useApi(
    () => ticketApi.get(current!.id),
    [current?.id],
    { enabled: !!current, key: current ? K.ticket(current.id) : undefined },
  );

  /* 仪表盘「客服回复了」的提醒带着 ?id= 过来：列表到了就直接打开那一张，并把参数去掉 */
  const [sp, setSp] = useSearchParams();
  const wanted = sp.get('id') ?? '';
  const [handledId, setHandledId] = useState('');
  if (wanted && tickets.data && handledId !== wanted) {
    setHandledId(wanted);
    const hit = tickets.data.find((x) => x.id === wanted);
    if (hit) { setReply(''); setCurrent(hit); }
  }
  useEffect(() => {
    if (wanted && handledId === wanted) setSp((p) => { p.delete('id'); return p; }, { replace: true });
  }, [wanted, handledId, setSp]);

  /* 打开详情时面板就把回复标成已读了：详情一到，列表里的未读点也去掉 */
  const reloadList = tickets.reload;
  const loadedId = detail.data?.id;
  useEffect(() => { if (loadedId) reloadList(); }, [loadedId, reloadList]);

  const waiting = list.filter((t) => t.status === 'open');
  const replied = list.filter((t) => t.status === 'answered');
  const closedCount = list.filter((t) => t.status === 'closed').length;

  const create = () => runCreate(async () => {
    try {
      const r = await ticketApi.create({
        subject: subject.trim(), category, priority, message: message.trim(),
        ...(orderId !== 'none' ? { order_id: orderId } : {}),
      });
      toast.success(tr('工单已提交'), { description: tr('客服回复后这一页会显示新消息') });
      setOpen(false);
      setSubject('');
      setMessage('');
      setOrderId('none');
      /* 新工单直接打开：取一遍列表，找到它 */
      const list = await ticketApi.list();
      tickets.setData(list);
      const hit = list.find((t) => t.id === r.id);
      if (hit) { setReply(''); setCurrent(hit); }
    } catch (e) {
      toast.error(errText(e));
    }
  });

  const send = () => runReply(async () => {
    if (!current || !reply.trim()) return;
    try {
      await ticketApi.reply(current.id, reply.trim());
      setReply('');
      detail.reload();
      tickets.reload();
    } catch (e) {
      toast.error(errText(e));
    }
  });

  const close = () => runClose(async () => {
    if (!current) return;
    try {
      await ticketApi.close(current.id);
      toast.success(tr('工单已关闭'));
      setCurrent(null);
      tickets.reload();
    } catch (e) {
      toast.error(errText(e));
    }
  });

  const thread = current ?? shown;
  const status = (current && detail.data?.status) || thread?.status;
  const closed = status === 'closed';

  return (
    <>
      <PageTitle title={tr('工单')} sub={tr('遇到问题在这里提交，客服的回复也会出现在同一条对话里。')} />

      <Section>
        <StatRow
          items={[
            {
              k: tr('全部工单'), v: list.length, suffix: tr(' 张'),
              x: list[0] ? tp('最近更新 {t}', { t: fromNow(list[0].updated_at, tp) }) : tr('还没有提交过工单'),
            },
            { k: tr('等待客服'), v: waiting.length, suffix: tr(' 张'), x: tr('已提交，等待处理') },
            { k: tr('已回复'), v: replied.length, suffix: tr(' 张'), x: tr('等待你的确认') },
            { k: tr('已关闭'), v: closedCount, suffix: tr(' 张'), x: tr('问题已经了结') },
          ]}
        />
      </Section>

      <Section
        title={<><Headphones className="size-4 text-brand" />{tr('我的工单')}</>}
        desc={tr('点击任意工单查看完整对话')}
        extra={<Button className="h-9" onClick={() => setOpen(true)}><Plus />{tr('提交工单')}</Button>}
      >
        {tickets.loading && !tickets.data ? <Loading />
          : tickets.error && !tickets.data ? <LoadError error={tickets.error} onRetry={tickets.reload} />
          : list.length === 0 ? <Empty title="还没有工单" desc="遇到问题时点右上角提交，我们会在这里回复。" />
          : list.map((t, i) => (
            <Row
              key={t.id} index={i} onClick={() => { setReply(''); setCurrent(t); }}
              /* 不套底色方块：与相邻列表的国旗、公告标签一样，图标本身就是这一列 */
              avatar={
                <span className="relative">
                  <MessageCircle className="size-4.5 shrink-0 text-faint transition-colors group-hover:text-brand" />
                  {/* 客服回了、还没看：图标右上角一个品牌色圆点 */}
                  {t.unread && t.status !== 'closed' && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-brand ring-2 ring-background" />}
                </span>
              }
              title={t.subject}
              desc={`${tr(CATEGORY[t.category])} · ${tp('更新于 {d}', { d: formatDateTime(t.updated_at) })}`}
              extra={
                <>
                  <Badge variant="secondary" className={cn('rounded-full', PRIORITY[t.priority].cls)}>
                    {tp('{level}优先级', { level: tr(PRIORITY[t.priority].text) })}
                  </Badge>
                  <StatusTag {...STATE[t.status]} />
                </>
              }
            />
          ))}
      </Section>

      {/* ── 提交工单：流程类弹窗，底部小结栏写着还能写多少字 ── */}
      <FlowDialog
        open={open} onOpenChange={setOpen}
        icon={<LifeBuoy />}
        title={tr('提交新工单')}
        description={tr('把现象、时间和用的客户端写清楚，能省掉一轮来回')}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ticket-subject">{tr('问题标题')}</Label>
            <Input
              id="ticket-subject" value={subject} maxLength={TICKET_MAX_SUBJECT} onChange={(e) => setSubject(e.target.value)}
              placeholder={tr('例如：香港节点无法连接')}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ticket-category">{tr('分类')}</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as TicketCategory)}>
                <SelectTrigger id="ticket-category" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TICKET_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{tr(CATEGORY[c])}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {scope !== 'banned' && (
              <div className="space-y-2">
                <Label htmlFor="ticket-order">{tr('关联订单')}</Label>
                <Select value={orderId} onValueChange={setOrderId}>
                  <SelectTrigger id="ticket-order" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{tr('不关联')}</SelectItem>
                    {(orders.data ?? []).slice(0, 20).map((o) => (
                      <SelectItem key={o.id} value={o.id}>{o.plan_name} · {o.out_trade_no}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium">{tr('优先级')}</legend>
            {/* 四档并排点选，比下拉少一步；选中的那一档说明它意味着什么 */}
            <div className="grid grid-cols-4 gap-2">
              {TICKET_PRIORITIES.map((v) => (
                <label
                  key={v}
                  className={cn('grid h-10 cursor-pointer place-items-center rounded-xl border text-[13px] font-medium transition-colors',
                    priority === v ? 'border-brand bg-brand/5 text-brand' : 'border-border hover:bg-muted/50')}
                >
                  <input type="radio" name="ticket-priority" value={v} checked={priority === v} onChange={() => setPriority(v)} className="sr-only" />
                  {tr(PRIORITY[v].text)}
                </label>
              ))}
            </div>
            <p className="text-[12px] text-muted-foreground">{tr(PRIORITY[priority].hint)}</p>
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="ticket-message">{tr('详细描述')}</Label>
            <Textarea
              id="ticket-message" rows={6} maxLength={TICKET_MAX_BODY} className="resize-none"
              value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder={tr('请描述问题现象、出现时间、使用的节点与客户端版本，以便我们更快定位。')}
            />
          </div>
        </div>
        <FlowFooter summary={<span className="tnum">{tp('还能写 {n} 字', { n: TICKET_MAX_BODY - message.length })}</span>}>
          <Button variant="outline" onClick={() => setOpen(false)}>{tr('取消')}</Button>
          <Button disabled={creating || !subject.trim() || !message.trim()} onClick={create}>
            {creating ? tr('提交中') : tr('提交工单')}
          </Button>
        </FlowFooter>
      </FlowDialog>

      {/* ── 工单对话：阅读类弹窗。头部是编号、优先级、状态，回复框贴在底部不动 ── */}
      <ReadingDialog
        open={!!current}
        onOpenChange={(o) => !o && setCurrent(null)}
        meta={thread && (
          <>
            <span>{tr(CATEGORY[thread.category])}</span>
            <Badge variant="secondary" className={cn('rounded-full', PRIORITY[thread.priority].cls)}>
              {tp('{level}优先级', { level: tr(PRIORITY[thread.priority].text) })}
            </Badge>
            {status && <StatusTag {...STATE[status]} />}
            <span className="tnum">{formatDateTime(thread.created_at)}</span>
          </>
        )}
        title={thread?.subject ?? ''}
        footer={closed ? (
          <p className="text-[12.5px] leading-[1.7] text-muted-foreground">
            {tr('这张工单已关闭，如果问题再次出现，请新开一张。')}
          </p>
        ) : (
          <div className="space-y-2.5">
            <Label htmlFor="ticket-reply" className="sr-only">{tr('回复此工单…')}</Label>
            <Textarea
              id="ticket-reply" rows={2} placeholder={tr('回复此工单…')} className="max-h-40 min-h-[64px] resize-none"
              value={reply} onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
            />
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={closing} onClick={close}>
                {tr('问题已解决，关闭工单')}
              </Button>
              <span className="ml-auto hidden text-[11.5px] text-muted-foreground sm:inline">Ctrl + Enter</span>
              <Button disabled={replying || !reply.trim()} onClick={send}>
                <Send />{replying ? tr('发送中') : tr('发送')}
              </Button>
            </div>
          </div>
        )}
      >
        {/* 客服在左、用户在右，气泡尖角朝向各自一侧 */}
        <div className="space-y-5">
          {detail.loading && !detail.data ? <Loading rows={2} />
            : detail.error && !detail.data ? <LoadError error={detail.error} onRetry={detail.reload} />
            : (
              <>
              {detail.data?.order_no && (
                <p className="text-[12.5px] text-muted-foreground">{tp('关联订单 {n}', { n: detail.data.order_no })}</p>
              )}
              {(detail.data?.messages ?? []).map((m, i) => {
              /* 客服只显示为「客服」，面板不透露是哪一位 */
              const mine = !m.staff;
              return (
                <div
                  key={m.id}
                  {...enter({ delay: stagger(i), y: NUDGE, duration: DUR.fast })}
                  className={cn('flex gap-2.5', mine ? 'flex-row-reverse' : 'flex-row')}
                >
                  <div className={cn(
                    'grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-medium',
                    mine ? 'bg-gradient-to-br from-brand to-brand-light text-white'
                         : 'bg-emerald-500/12 text-success',
                  )}>
                    {mine ? <UserRound className="size-3.5" strokeWidth={2.2} /> : <Headphones className="size-3.5" />}
                  </div>

                  <div className={cn('flex min-w-0 max-w-[80%] flex-col', mine ? 'items-end' : 'items-start')}>
                    <div className={cn('flex items-baseline gap-2', mine && 'flex-row-reverse')}>
                      <b className="text-[12.5px]">{mine ? tr('我') : tr('客服')}</b>
                      <span className="tnum text-[11.5px] text-muted-foreground">{formatDateTime(m.created_at)}</span>
                    </div>
                    <div className={cn(
                      'mt-1.5 px-3.5 py-2.5 text-[14px] leading-[1.8] whitespace-pre-wrap',
                      mine ? 'rounded-2xl rounded-tr-md bg-brand text-white dark:text-primary-foreground'
                           : 'rounded-2xl rounded-tl-md bg-muted text-body',
                    )}>
                      {m.body}
                    </div>
                  </div>
                </div>
              );
            })}
              </>
            )}
        </div>
      </ReadingDialog>
    </>
  );
}
