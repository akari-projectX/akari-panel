import { useState } from 'react';
import { Check, Copy, Plus, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/panels';
import { Input } from '@/components/ui/input';
import { Row } from '@/components/flat';
import { Empty, LoadError, Loading } from '@/components/data-state';
import StatusTag from '@/components/status-tag';
import { useCopy } from '@/hooks/use-copy';
import { usePending } from '@/hooks/use-api';
import { inviteApi, portalUrl, type CommissionStatus, type InviteCodes, type MyInvite } from '@/api';
import { useErrorText } from '@/lib/errors';
import { formatDate, formatMoney, type StatusTone } from '@/lib/format';
import { R } from '@/lib/routes';
import { useT, useTp } from '@/i18n';

/*
 * 钱包与邀请页（pages/dash/wallet）里邀请的两块：
 *   · InviteLinkPane —— 概览右栏：邀请链接 + 复制、返佣条款一行；
 *   · InviteDetails  —— 「邀请返佣」分页：收益数字、邀请码管理、返佣明细。
 * 佣金入账就进账户余额（单一余额），可提现的部分在同一页左栏申请。明细里只显示被邀请人的非个人标签，不显示对方邮箱。
 */

const C_STATUS: Record<CommissionStatus, { text: string; tone: StatusTone }> = {
  pending: { text: '冻结中', tone: 'warning' },
  credited: { text: '已入账', tone: 'success' },
  reversed: { text: '已追回', tone: 'neutral' },
};

/** 邀请链接：面板给的 link_base（以 ?invite= 结尾）+ 邀请码；没有时用门户自己的注册页 */
function inviteLink(code: string, linkBase: string | null): string {
  return `${linkBase ?? portalUrl(`${R.register}?invite=`)}${encodeURIComponent(code)}`;
}

type Api<T> = { data: T | undefined; loading: boolean; error: Error | undefined; reload: () => void };

/** 返佣条款，一行：「返佣 20% · 每一笔订单 · 冻结 7 天后入账」；没开返佣时说明 */
function terms(i: MyInvite, tr: (s: string) => string, tp: (s: string, v: Record<string, string | number>) => string): string {
  if (!i.enabled) return tr('站点暂未开启邀请返佣。');
  return [
    tp('返佣 {n}%', { n: i.rate_percent }),
    i.first_order_only ? tr('只返被邀请人的首单') : tr('被邀请人的每一笔订单都返'),
    tp('冻结 {n} 天后入账', { n: i.hold_days }),
  ].join(' · ');
}

export function InviteLinkPane({ codes, invite, onCreate, creating }: {
  codes: Api<InviteCodes>; invite: Api<MyInvite>; onCreate: () => void; creating: boolean;
}) {
  const tr = useT();
  const tp = useTp();
  const [copied, copy] = useCopy<string>();
  const c = codes.data;
  const primary = c?.codes[0];
  const link = primary ? inviteLink(primary.code, c?.link_base ?? null) : '';

  return (
    <>
      {codes.loading && !c ? <Loading rows={1} />
        : codes.error && !c ? <LoadError error={codes.error} onRetry={codes.reload} />
        : c && !c.register_enabled ? (
          <p className="text-[13.5px] leading-[1.8] text-muted-foreground">{tr('站点现在关闭了注册，邀请链接暂时用不了。重新开放注册后这里会恢复。')}</p>
        ) : c && primary ? (
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <Input aria-label={tr('邀请链接')} readOnly value={link} className="h-10 font-mono text-[13px]" onFocus={(e) => e.currentTarget.select()} />
            <Button
              className="h-10 shrink-0 px-4"
              onClick={async () => { if (await copy(link, 'link')) toast.success(tp('{what}已复制', { what: tr('邀请链接') })); }}
            >
              {copied === 'link' ? <Check className="pop-in" /> : <Copy />}{copied === 'link' ? tr('已复制') : tr('复制链接')}
            </Button>
          </div>
        ) : c && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13.5px] text-muted-foreground">{tr('还没有邀请码，生成一个就有邀请链接了。')}</span>
            <Button size="sm" disabled={creating} onClick={onCreate}><Plus className="size-3.5" />{creating ? tr('生成中') : tr('生成邀请码')}</Button>
          </div>
        )}
      {invite.data && <p className="mt-3 text-[12.5px] leading-[1.7] text-muted-foreground">{terms(invite.data, tr, tp)}</p>}
    </>
  );
}

export function InviteDetails({ codes, invite, onCreate, creating }: {
  codes: Api<InviteCodes>; invite: Api<MyInvite>; onCreate: () => void; creating: boolean;
}) {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const [copied, copyText] = useCopy<string>();
  const [deleting, runDelete] = usePending();
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const c = codes.data;
  const i = invite.data;
  const create = onCreate;

  const remove = (code: string) => runDelete(async () => {
    try {
      await inviteApi.deleteCode(code);
      setPendingDelete(null);
      codes.reload();
      toast.success(tr('邀请码已删除'));
    } catch (e) {
      toast.error(errText(e));
    }
  });

  return (
    <div className="space-y-12">
      {/* 收益：四个数，不放大 */}
      {invite.loading && !i ? <Loading rows={1} />
        : invite.error && !i ? <LoadError error={invite.error} onRetry={invite.reload} />
        : i && (
          <div>
            <dl className="mini-stats">
              <div><dt>{tr('已邀请')}</dt><dd>{tp('{n} 人', { n: i.invited_count })}</dd></div>
              <div><dt>{tr('冻结中')}</dt><dd>{formatMoney(i.pending_cents)}</dd></div>
              <div><dt>{tr('已入账')}</dt><dd>{formatMoney(i.credited_cents)}</dd></div>
              <div><dt>{tr('已追回')}</dt><dd>{formatMoney(i.reversed_cents)}</dd></div>
            </dl>
            {i.reversed_cents > 0 && (
              <p className="mt-3 max-w-[72ch] text-[12.5px] leading-[1.7] text-muted-foreground">
                {tr('被追回的佣金因订单退款从余额里扣回，余额不够时差额记为欠款，从之后入账的佣金里抵扣（余额不会变成负数）。')}
              </p>
            )}
          </div>
        )}

      {/* 邀请码 */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-4">
          <h3 className="sub-title">
            {c ? tp('邀请码 {n} / {max}', { n: c.codes.length, max: c.limit }) : tr('邀请码')}
            {c?.single_use && <span className="ml-2 font-normal text-muted-foreground">{tr('每个码只能用一次')}</span>}
          </h3>
          {c && c.register_enabled && (
            <Button variant="outline" size="sm" disabled={creating || c.codes.length >= c.limit} onClick={create}>
              <Plus />{creating ? tr('生成中') : tr('生成邀请码')}
            </Button>
          )}
        </div>
        {codes.loading && !c ? <Loading rows={1} />
          : codes.error && !c ? <LoadError error={codes.error} onRetry={codes.reload} />
          : c && c.codes.length === 0 ? <Empty title="还没有邀请码" desc="生成一个之后就可以把链接发给别人了。" className="py-10" />
          : c && c.codes.map((x) => (
            <div key={x.code} className="flex items-center justify-between gap-4 border-b border-border py-2.5 text-[13.5px] last:border-b-0">
              <span className="flex min-w-0 items-center gap-3">
                <code className="truncate">{x.code}</code>
                <span className="shrink-0 text-[12px] text-muted-foreground">{tp('已用 {n} 次', { n: x.uses })}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost" size="sm" aria-label={tr('复制链接')}
                  onClick={async () => { if (await copyText(inviteLink(x.code, c.link_base), x.code)) toast.success(tp('{what}已复制', { what: tr('邀请链接') })); }}
                >
                  {copied === x.code ? <Check className="pop-in" /> : <Copy />}<span className="hidden sm:inline">{tr('复制链接')}</span>
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button variant="ghost" size="sm" aria-label={tr('删除')} className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setPendingDelete(x.code)}>
                      <Trash2 /><span className="hidden sm:inline">{tr('删除')}</span>
                    </Button>
                  }
                  tone="danger"
                  icon={<Trash2 />}
                  title={tp('删除邀请码 {c}？', { c: x.code })}
                  consequences={[tr('用这个码的链接立即失效'), tr('已经通过它注册的人不受影响，佣金照常计算')]}
                  confirmLabel={tr('删除')}
                  pending={deleting && pendingDelete === x.code}
                  onConfirm={() => remove(x.code)}
                />
              </span>
            </div>
          ))}
      </div>

      {/* 返佣明细 */}
      <div>
        <h3 className="sub-title mb-2">{i?.commissions.length ? tp('返佣明细 · 共 {n} 条', { n: i.commissions.length }) : tr('返佣明细')}</h3>
        {invite.loading && !i ? <Loading rows={2} />
          : !i ? null
          : i.commissions.length === 0 ? <Empty title="还没有返佣记录" desc="被你邀请的人完成付费后，明细会出现在这里。" className="py-10" />
          : (
            <>
              <div className="md:hidden">
                {i.commissions.map((x, n) => (
                  <Row
                    key={x.id} index={n}
                    title={x.invitee_label}
                    desc={
                      <>
                        <span className="tnum">{formatDate(x.created_at)}</span>
                        {' · '}{tp('订单 {v}', { v: formatMoney(x.base_cents) })}
                        {x.status === 'pending' && <> · <span className="whitespace-nowrap">{tp('{d} 入账', { d: formatDate(x.available_at) })}</span></>}
                      </>
                    }
                    extra={
                      <span className="flex flex-col items-end gap-1.5">
                        <span className="tnum font-medium">{formatMoney(x.amount_cents)}</span>
                        <StatusTag {...C_STATUS[x.status]} />
                      </span>
                    }
                  />
                ))}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[620px] text-[14px]">
                  <thead>
                    <tr className="border-b border-border text-[12.5px] text-muted-foreground">
                      <th className="py-3 text-left font-medium">{tr('日期')}</th>
                      <th className="py-3 text-left font-medium">{tr('被邀请人')}</th>
                      <th className="py-3 text-right font-medium">{tr('订单金额')}</th>
                      <th className="py-3 text-right font-medium">{tr('佣金')}</th>
                      <th className="py-3 pl-6 text-left font-medium">{tr('状态')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {i.commissions.map((x) => (
                      <tr key={x.id} className="border-b border-border last:border-b-0">
                        <td className="tnum py-3.5 whitespace-nowrap text-muted-foreground">{formatDate(x.created_at)}</td>
                        <td className="py-3.5">{x.invitee_label}</td>
                        <td className="tnum py-3.5 text-right text-muted-foreground">{formatMoney(x.base_cents)}</td>
                        <td className="tnum py-3.5 text-right font-medium">
                          {formatMoney(x.amount_cents)} <span className="text-[12px] font-normal text-muted-foreground">({x.rate_percent}%)</span>
                        </td>
                        <td className="py-3.5 pl-6 whitespace-nowrap">
                          <StatusTag {...C_STATUS[x.status]} />
                          {x.status === 'pending' && <span className="ml-2 text-[12.5px] text-muted-foreground">{tp('{d} 入账', { d: formatDate(x.available_at) })}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </div>
    </div>
  );
}
