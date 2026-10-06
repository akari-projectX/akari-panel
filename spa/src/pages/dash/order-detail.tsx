import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowLeft, Check, Clock, Copy, ExternalLink, FileText, Undo2, Wallet, XCircle } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { PageTitle, Section } from '@/components/flat';
import { LoadError } from '@/components/data-state';
import { DashSkeleton } from '@/components/loading';
import StatusTag from '@/components/status-tag';
import { useCopy } from '@/hooks/use-copy';
import { orderApi, type MyOrder, type RefundEffect, type RefundRoute } from '@/api';
import { useApi, usePending } from '@/hooks/use-api';
import { K } from '@/lib/cache';
import { useAuth } from '@/lib/auth';
import { useErrorText } from '@/lib/errors';
import { ORDER_ACTION, formatDate, formatDateTime, formatMoney, formatTime, orderState, periodText } from '@/lib/format';
import { R } from '@/lib/routes';
import { cn, safeUrl } from '@/lib/utils';
import { useT, useTp } from '@/i18n';

/**
 * 支付宝当面付返回的是 https://qr.alipay.com/… 的二维码链接。
 * 手机上让人拿这台手机去扫这台手机屏幕上的码是做不到的——把它包进支付宝的唤起地址，
 * 点一下就直接打开支付宝 App 的付款页（saId=10000007 是支付宝「扫一扫」，qrcode 参数就是码的内容）。
 * 这一层完全在前台做，后端不用改。
 */
const isAlipayQr = (url: string) => /^https:\/\/qr\.alipay\.com\//i.test(url);
const alipayScheme = (url: string) => `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent(url)}`;
const IS_MOBILE = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent);
/* 微信内置浏览器会屏蔽 alipays:// 唤起，只能让用户换到系统浏览器 */
const IN_WECHAT = typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent);

/**
 * 订单详情与付款。待支付时显示支付宝二维码（或跳转类支付的收银台按钮），并每 3 秒查一次状态——
 * 面板查订单时会主动去支付宝问（有节流），所以用户付完这一页自己会变。
 * 想换支付方式：取消这一单、回商店重新下单（面板的订单在创建时就定了支付方式）。
 */
export default function OrderDetail() {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const nav = useNavigate();
  const { id = '' } = useParams<{ id: string }>();
  const { refresh: refreshAuth } = useAuth();

  const order = useApi(() => orderApi.get(id), [id], { key: K.order(id) });
  const data = order.data;
  const pending = data?.status === 'pending';
  const qr = pending ? data?.qr_code ?? null : null;
  const payUrl = pending && data?.pay_url && safeUrl(data.pay_url) ? data.pay_url : null;
  const alipayJump = !!qr && IS_MOBILE && isAlipayQr(qr);
  const [cancelling, runCancel] = usePending();
  const [copiedNo, copyText] = useCopy(1600);


  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [pending]);

  /*
   * 待支付就盯着状态：用户是在支付宝 App / 另一个标签页里付的，付完不会有人回来告诉这一页。
   * 「不再待支付」不等于付成功了：超时没付面板会关掉订单（expired）。上一次没回来就不发下一次。
   */
  useEffect(() => {
    if (!pending || !id) return;
    let alive = true;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const o = await orderApi.get(id);
        if (!alive || o.status === 'pending') return;
        clearInterval(timer);
        order.setData(o);
        if (o.status === 'paid') {
          toast.success(o.fulfilled ? tr('支付成功，套餐已生效') : tr('已收到付款'));
          void refreshAuth();
        } else if (o.status === 'expired') {
          toast.error(tr('订单已超时关闭'), { description: tr('超过支付时限仍未收到付款。如果已经扣款，请提交工单处理') });
        }
      } catch { /* 轮询失败不打扰用户，下一轮再试 */ } finally {
        busy = false;
      }
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, id]);

  const cancel = () => runCancel(async () => {
    try {
      order.setData(await orderApi.cancel(id));
      toast.success(tr('订单已取消'));
    } catch (e) {
      toast.error(errText(e));
      order.reload();
    }
  });

  if (order.loading && !data) return <DashSkeleton hold={false} />;
  if (order.error && !data) return <LoadError error={order.error} onRetry={order.reload} className="py-32" />;
  if (!data) return null;

  const minutesLeft = Math.max(0, Math.ceil((new Date(data.expires_at).getTime() - now) / 60000));
  const state = orderState(data);
  const closed = data.status === 'expired' || data.status === 'cancelled';
  const unfulfilled = data.status === 'paid' && !data.fulfilled && !data.refunded_at;

  /* 金额构成：只列出真正发生了的那几项 */
  const lines: [string, number, boolean?][] = [
    ['价格', data.list_price_cents],
    ['优惠码', -data.discount_cents, !data.discount_cents],
    ['旧套餐折算抵扣', -data.credit_cents, !data.credit_cents],
    ['余额抵扣', -data.balance_cents, !data.balance_cents],
  ];

  const info: [string, React.ReactNode][] = [
    ['订单号', (
      <span key="no" className="inline-flex items-center gap-1.5">
        <code className="text-[12.5px]">{data.out_trade_no}</code>
        <button
          type="button" aria-label={tr('复制订单号')} onClick={() => copyText(data.out_trade_no)}
          className="text-muted-foreground transition-colors hover:text-brand"
        >
          {copiedNo !== null ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
      </span>
    )],
    ['订单类型', tr(ORDER_ACTION[data.action])],
    ['购买时长', periodText(data.period, data.period_days, tr, tp)],
    ['下单时间', formatDateTime(data.created_at)],
    ...(data.coupon_code ? [['优惠码', <code key="c" className="text-[12.5px]">{data.coupon_code}</code>] as [string, React.ReactNode]] : []),
    ...(data.payment_method_name ? [['支付方式', data.payment_method_name] as [string, React.ReactNode]] : []),
    ...(data.paid_at ? [['支付时间', formatDateTime(data.paid_at)] as [string, React.ReactNode]] : []),
    ...(data.refunded_at ? [['退款时间', formatDateTime(data.refunded_at)] as [string, React.ReactNode]] : []),
    ...(data.refund_route ? [['退款方式', tr(REFUND_ROUTE[data.refund_route])] as [string, React.ReactNode]] : []),
  ];

  /* 进度：下单 → 付款 → 生效。关闭的订单第二步停在「已关闭」；退款 / 没能开通的第三步标出来 */
  const steps: { label: string; time?: string; state: 'done' | 'current' | 'todo' | 'failed' }[] = [
    { label: '提交订单', time: formatDateTime(data.created_at), state: 'done' },
    closed
      ? { label: data.status === 'expired' ? '已超时' : '已取消', state: 'failed' }
      : { label: '完成支付', time: data.paid_at ? formatDateTime(data.paid_at) : undefined, state: pending ? 'current' : 'done' },
    data.refunded_at
      ? { label: '已退款', time: formatDateTime(data.refunded_at), state: 'failed' }
      : unfulfilled
        ? { label: '已退回余额', state: 'failed' }
        : { label: '套餐生效', state: data.fulfilled ? 'done' : 'todo' },
  ];

  return (
    <>
      <PageTitle
        title={tr('订单详情')}
        sub={tp('{p} · {n}', { p: data.plan_name, n: data.out_trade_no })}
        extra={
          <Button variant="outline" className="h-9" asChild>
            <Link to={R.orders}><ArrowLeft className="size-3.5" />{tr('返回订单列表')}</Link>
          </Button>
        }
      />

      {/* ── 进度条：一眼看出这笔订单走到哪一步 ── */}
      <Section>
        <ol className="grid grid-cols-3 gap-3">
          {steps.map((st, i) => (
            <li key={st.label} className="relative">
              {/* 与下一步之间的连线 */}
              {i < steps.length - 1 && (
                <span
                  aria-hidden
                  data-on={st.state === 'done' && steps[i + 1].state !== 'todo'}
                  className={cn('absolute top-[13px] -right-1 left-10 h-px data-[on=true]:top-[12.5px] data-[on=true]:h-[2px]',
                    st.state === 'done' && steps[i + 1].state !== 'todo' ? 'bg-emerald-500/70' : 'bg-border')}
                />
              )}
              <span className={cn('relative grid size-[27px] place-items-center rounded-full text-[12px] font-medium',
                st.state === 'done' && 'bg-emerald-500/12 text-success',
                st.state === 'current' && 'bg-brand text-white dark:text-primary-foreground',
                st.state === 'failed' && 'bg-muted text-muted-foreground',
                st.state === 'todo' && 'border border-border text-muted-foreground')}
              >
                {st.state === 'done' ? <Check className="size-3.5" strokeWidth={2.6} />
                  : st.state === 'failed' ? <XCircle className="size-3.5" />
                  : i + 1}
              </span>
              <div className={cn('mt-3 text-[13.5px] font-medium', st.state === 'todo' && 'text-muted-foreground')}>
                {tr(st.label)}
              </div>
              <div className="tnum mt-0.5 text-[12px] text-muted-foreground">
                {st.time ?? (st.state === 'current' && pending ? tr('等待付款') : ' ')}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {(data.refunded_at || data.refund_pending || unfulfilled) && (
        <div role="status" className="notice mt-6">
          {data.refunded_at || data.refund_pending ? <Undo2 className="size-4 shrink-0 text-brand" /> : <Wallet className="size-4 shrink-0 text-warning" />}
          <div className="min-w-0 flex-1 text-[13.5px] leading-[1.8]">
            {data.refunded_at ? (
              <>
                <div className="font-medium">{tp('这笔订单已于 {d} 退款', { d: formatDate(data.refunded_at) })}</div>
                <RefundLines o={data} />
              </>
            ) : data.refund_pending ? (
              <>
                <div className="font-medium">{tr('退款处理中')}</div>
                <div className="text-muted-foreground">{tr('已向支付渠道发起原路退款，渠道确认后款项按原支付方式退回，通常几分钟到几个工作日。')}</div>
              </>
            ) : (
              <>
                <div className="font-medium">{tr('付款成功，但套餐没能开通')}</div>
                <div className="text-muted-foreground">
                  {tr('付款时套餐已售罄、已下架，或你已经换了别的套餐。款项会退回账户余额，可以用来重新下单或申请提现；有疑问请提交工单。')}
                </div>
              </>
            )}
          </div>
          {(data.refund_balance_cents ?? 0) > 0 && (
            <Button size="sm" variant="outline" onClick={() => nav(R.wallet)}>{tr('查看钱包')}</Button>
          )}
        </div>
      )}

      <div className="grid gap-x-14 border-t border-border lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {/* ── 待支付：二维码 / 收银台 ── */}
          {pending && (qr || payUrl) && (
            <Section
              title={payUrl && !qr ? tr('前往收银台') : alipayJump ? tr('支付宝付款') : tr('扫码支付')}
              desc={tr('支付完成后本页会自动更新，无需手动刷新')}
            >
              <div className="flex flex-col items-center gap-4 py-2">
                {payUrl && !qr && (
                  <Button asChild className="h-12 gap-2 rounded-xl px-6 text-[15px]">
                    <a href={payUrl}><ExternalLink className="size-4" />{tr('去付款')}</a>
                  </Button>
                )}
                {qr && (
                  <>
                {/*
                      手机 + 支付宝当面付：主操作是「打开支付宝」，二维码退居其次（给另一台手机扫）。
                      不在拿到链接后自动跳：没装支付宝时系统会弹「地址无效」，
                      而且支付请求是异步回来的，那时已不算用户手势，不少浏览器会直接拦下。
                    */}
                    {alipayJump && (
                      <div className="flex w-full max-w-[320px] flex-col items-center gap-2.5">
                        {IN_WECHAT ? (
                          <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-[13px] leading-[1.8] text-warning">
                            {tr('微信里无法打开支付宝。请点右上角「…」，选择「在浏览器打开」后再付款。')}
                          </p>
                        ) : (
                          <>
                            <Button asChild className="h-12 w-full gap-2 rounded-xl bg-[#1677ff] text-[15px] text-white hover:bg-[#1677ff]/90">
                              <a href={alipayScheme(qr)}><Wallet className="size-4" />{tr('打开支付宝付款')}</a>
                            </Button>
                            {/* 唤起失败（部分安卓浏览器不认 alipays://）时的退路：支付宝官方的二维码页会再引导打开 App */}
                            <a href={qr} className="text-[12.5px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                              {tr('没有自动打开？点这里再试一次')}
                            </a>
                          </>
                        )}
                        <div className="mt-2 flex w-full items-center gap-3 text-[12px] text-muted-foreground">
                          <span className="h-px flex-1 bg-border" />{tr('或用另一台设备扫码')}<span className="h-px flex-1 bg-border" />
                        </div>
                      </div>
                    )}
                    <div className="rounded-2xl bg-white p-4">
                      <QRCodeSVG value={qr} size={alipayJump ? 148 : 188} level="M" fgColor="#0d1526" bgColor="#ffffff" marginSize={0} />
                    </div>
                    {!alipayJump && (
                      <p className="text-[12.5px] text-muted-foreground">
                        {isAlipayQr(qr) ? tr('打开支付宝，扫描上方二维码完成付款') : tr('用对应 App 扫描上方二维码完成付款')}
                      </p>
                    )}
                  </>
                )}
                <p className="text-[12px] text-muted-foreground">{tr('想换一种支付方式：取消这一单，回商店重新下单。')}</p>
              </div>
            </Section>
          )}
          {pending && !qr && !payUrl && (
            <Section title={tr('等待付款')}>
              <p className="text-[13px] text-muted-foreground">{tr('这笔订单没有在线付款方式，请提交工单联系客服完成付款。')}</p>
            </Section>
          )}

          {/* ── 订单信息 ── */}
          <Section title={<><FileText className="size-4 text-brand" />{tr('订单信息')}</>}>
            <div className="grid gap-x-10 sm:grid-cols-2">
              {info.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-6 border-b border-border py-3 text-sm">
                  <span className="shrink-0 text-muted-foreground">{tr(k)}</span>
                  <span className="min-w-0 truncate text-right">{v}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>

        {/* ── 金额单：宽屏钉在右侧，跟着滚动 ── */}
        <aside className="pb-10 lg:pt-11">
          <div className="rounded-[14px] border border-border p-6 lg:sticky lg:top-24">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium">{tr('金额明细')}</span>
              <StatusTag {...state} />
            </div>

            <div className="mt-4">
              {lines.filter(([, , hide]) => !hide).map(([k, v]) => (
                <div key={k} className="flex justify-between py-1.5 text-[13px]">
                  <span className="text-muted-foreground">{tr(k)}</span>
                  <span className="tnum">{v < 0 ? `−${formatMoney(-v)}` : formatMoney(v)}</span>
                </div>
              ))}
            </div>

            <Separator className="my-4" />
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] text-muted-foreground">{pending ? tr('应付金额') : tr('实付金额')}</span>
              <span className="tnum text-[28px] leading-none font-medium tracking-[-0.03em] text-brand">{formatMoney(data.amount_cents)}</span>
            </div>

            {pending ? (
              <>
                <p className="mt-4 flex items-start gap-1.5 text-[12px] leading-[1.7] text-muted-foreground">
                  <Clock className="mt-0.5 size-3.5 shrink-0" />
                  {minutesLeft > 0
                    ? tp('请在 {t} 前完成支付（还剩 {m} 分钟），超时订单会自动关闭', { t: formatTime(data.expires_at), m: minutesLeft })
                    : tr('订单即将超时关闭，请尽快完成支付')}
                </p>
                <Button variant="ghost" className="mt-4 h-9 w-full text-muted-foreground" disabled={cancelling} onClick={cancel}>
                  <XCircle className="size-3.5" />{tr('取消订单')}
                </Button>
              </>
            ) : (
              <>
                <p className="mt-4 text-[12.5px] leading-[1.8] text-muted-foreground">
                  {closed ? tr('这笔订单已关闭，可以重新选购套餐。')
                    : data.refunded_at ? tr('这笔订单已退款。')
                    : unfulfilled ? tr('款项已退回账户余额。')
                    : tr('订单已完成。')}
                </p>
                <div className="mt-5 grid grid-cols-2 gap-2">
                  <Button className="h-10" onClick={() => nav(R.dashboard)}>{tr('回到仪表盘')}</Button>
                  <Button variant="outline" className="h-10" onClick={() => nav(R.shop)}>{tr('继续选购')}</Button>
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

const REFUND_ROUTE: Record<RefundRoute, string> = {
  original: '原路退回',
  balance: '退到余额',
  manual: '支付渠道退款',
};

const REFUND_EFFECT: Record<RefundEffect, string> = {
  none: '套餐不受影响（只退款）。',
  cancel: '这笔订单开通的套餐已同时结束。',
  rollback: '这笔续费增加的时长已同时收回。',
  restore: '已恢复为换套餐之前的套餐。',
};

/**
 * 退款去向（三种：原路退回支付渠道、退到账户余额、站长在支付渠道后台退款后登记）与对套餐的影响（P1）。
 * 金额按订单记录的两部分显示：退回余额的、经支付渠道退回的。
 */
function RefundLines({ o }: { o: MyOrder }) {
  const tr = useT();
  const tp = useTp();
  const toBalance = o.refund_balance_cents ?? 0;
  const external = o.refund_external_cents ?? 0;
  return (
    <ul className="text-muted-foreground">
      {external > 0 && (
        <li>
          {o.refund_route === 'original'
            ? o.payment_method_name
              ? tp('{v} 已原路退回到 {m}。', { v: formatMoney(external), m: o.payment_method_name })
              : tp('{v} 已原路退回。', { v: formatMoney(external) })
            : tp('{v} 已通过支付渠道退回。', { v: formatMoney(external) })}
        </li>
      )}
      {toBalance > 0 && <li>{tp('{v} 已退回账户余额。', { v: formatMoney(toBalance) })}</li>}
      {o.refund_effect && <li>{tr(REFUND_EFFECT[o.refund_effect])}</li>}
    </ul>
  );
}
