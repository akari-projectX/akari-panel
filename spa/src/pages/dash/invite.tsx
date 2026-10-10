import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Gift, Plus, Share2, Trash2, Wallet } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/panels';
import { Input } from '@/components/ui/input';
import { PageTitle, Section, StatRow } from '@/components/flat';
import { Empty, LoadError, Loading } from '@/components/data-state';
import StatusTag from '@/components/status-tag';
import { useCopy } from '@/hooks/use-copy';
import { inviteApi, portalUrl, type CommissionStatus } from '@/api';
import { useApi, usePending } from '@/hooks/use-api';
import { K } from '@/lib/cache';
import { useErrorText } from '@/lib/errors';
import { formatDate, formatMoney, type StatusTone } from '@/lib/format';
import { R } from '@/lib/routes';
import { useT, useTp } from '@/i18n';

const C_STATUS: Record<CommissionStatus, { text: string; tone: StatusTone }> = {
  pending: { text: '冻结中', tone: 'warning' },
  credited: { text: '已入账', tone: 'success' },
  reversed: { text: '已追回', tone: 'neutral' },
};

/** 邀请链接：面板给的 link_base（以 ?invite= 结尾）+ 邀请码；没有时用门户自己的注册页 */
function inviteLink(code: string, linkBase: string | null): string {
  return `${linkBase ?? portalUrl(`${R.register}?invite=`)}${encodeURIComponent(code)}`;
}

/**
 * 邀请：邀请码（面板 /me/invite-codes，有上限、可删除）与返佣（/me/invite）。
 * 佣金入账就进账户余额（单一余额），没有「佣金转余额」这一步；可提现的部分去钱包申请。
 * 明细里只显示被邀请人的非个人标签，不显示对方邮箱。
 */
export default function Invite() {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const codes = useApi(() => inviteApi.codes(), [], { key: K.inviteCodes });
  const invite = useApi(() => inviteApi.get(), [], { key: K.invite });
  const [copied, copyText] = useCopy<string>();
  const [creating, runCreate] = usePending();
  const [deleting, runDelete] = usePending();
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const c = codes.data;
  const primary = c?.codes[0];
  const link = primary ? inviteLink(primary.code, c?.link_base ?? null) : '';
  const i = invite.data;

  /*
   * 返佣条款单独成块：关闭注册时邀请链接用不了，但返佣开关是另一回事，
   * 照样显示比例与条款，免得看起来像「返佣已关闭」。
   */
  const rebateCard = (
    <div className="rounded-[14px] border border-border p-6">
      <div className="text-[13px] text-muted-foreground">{tr('返佣比例')}</div>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="tnum text-[40px] leading-none font-medium tracking-[-0.035em]">{i?.enabled ? i.rate_percent : 0}</span>
        <span className="text-[18px] font-medium text-muted-foreground">%</span>
      </div>
      {i && (
        <ul className="mt-4 space-y-1.5 border-t border-border pt-4 text-[12.5px] leading-[1.8] text-muted-foreground">
          {!i.enabled && <li>{tr('站点暂未开启邀请返佣。')}</li>}
          {i.enabled && <li>{i.first_order_only ? tr('只返被邀请人的首单') : tr('被邀请人的每一笔订单都返')}</li>}
          {i.enabled && <li>{tp('佣金冻结 {n} 天后入账（期间退款会撤销）', { n: i.hold_days })}</li>}
          {i.min_withdrawal_cents > 0 && <li>{tp('最低提现 {v}', { v: formatMoney(i.min_withdrawal_cents) })}</li>}
        </ul>
      )}
    </div>
  );

  const copy = async (key: string, text: string, what: string) => {
    if (await copyText(text, key)) toast.success(tp('{what}已复制', { what: tr(what) }));
  };

  const create = () => runCreate(async () => {
    try {
      await inviteApi.createCode();
      codes.reload();
      toast.success(tr('邀请码已生成'));
    } catch (e) {
      toast.error(errText(e));
    }
  });

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
    <>
      <PageTitle
        title={tr('邀请')}
        sub={tr('把链接发给需要的人。对方付费后，你按比例拿佣金，过了冻结期自动进入账户余额，可以抵扣订单或申请提现。')}
      />

      <Section title={<><Share2 className="size-4 text-brand" />{tr('你的邀请链接')}</>}>
        {codes.loading && !c ? <Loading />
          : codes.error && !c ? <LoadError error={codes.error} onRetry={codes.reload} />
          : c && !c.register_enabled ? (
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
              <p className="max-w-[62ch] text-[13.5px] leading-[1.9] text-muted-foreground">
                {tr('站点现在关闭了注册，邀请链接暂时用不了。重新开放注册后这里会恢复。')}
              </p>
              {rebateCard}
            </div>
          ) : c && (
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div>
                {primary ? (
                  <div className="flex flex-col gap-2.5 sm:flex-row">
                    <Input aria-label={tr('邀请链接')} readOnly value={link} className="h-11 font-mono text-[13px]" />
                    <Button className="h-11 shrink-0 px-5" onClick={() => copy('link', link, '邀请链接')}>
                      {copied === 'link' ? <Check /> : <Copy />}{copied === 'link' ? tr('已复制') : tr('复制链接')}
                    </Button>
                  </div>
                ) : (
                  <Empty
                    title="还没有邀请码"
                    desc="生成一个之后就可以把链接发给别人了。"
                    action={
                      <Button size="sm" disabled={creating} onClick={create}>
                        <Plus className="size-3.5" />{creating ? tr('生成中') : tr('生成邀请码')}
                      </Button>
                    }
                  />
                )}

                {c.codes.length > 0 && (
                  <div className="mt-6">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[12.5px] tracking-[.05em] text-muted-foreground">
                        {tp('邀请码 {n} / {max}', { n: c.codes.length, max: c.limit })}
                        {c.single_use && ` · ${tr('每个码只能用一次')}`}
                      </span>
                      <Button variant="link" size="sm" disabled={creating || c.codes.length >= c.limit} onClick={create}>
                        <Plus />{tr('再生成一个')}
                      </Button>
                    </div>
                    {c.codes.map((x) => (
                      <div key={x.code} className="flex items-center justify-between gap-4 border-b border-border py-2.5 text-[13.5px] last:border-b-0">
                        <span className="flex min-w-0 items-center gap-3">
                          <code className="truncate">{x.code}</code>
                          <span className="shrink-0 text-[12px] text-muted-foreground">{tp('已用 {n} 次', { n: x.uses })}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <Button variant="ghost" size="sm" onClick={() => copy(x.code, inviteLink(x.code, c.link_base), '邀请链接')}>
                            {copied === x.code ? <Check /> : <Copy />}{tr('复制链接')}
                          </Button>
                          <ConfirmDialog
                            trigger={
                              <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setPendingDelete(x.code)}>
                                <Trash2 />{tr('删除')}
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
                )}
              </div>

              {rebateCard}
            </div>
          )}
      </Section>

      <Section title={<><Wallet className="size-4 text-brand" />{tr('收益概览')}</>}>
        {invite.loading && !i ? <Loading rows={1} />
          : invite.error && !i ? <LoadError error={invite.error} onRetry={invite.reload} />
          : i && (
            <>
              <StatRow
                items={[
                  { k: tr('已邀请'), v: i.invited_count, suffix: tr(' 人'), x: tr('通过你的链接完成注册') },
                  { k: tr('冻结中'), v: formatMoney(i.pending_cents), x: tr('过了冻结期自动入账') },
                  { k: tr('已入账'), v: formatMoney(i.credited_cents), x: tr('已进入账户余额') },
                  { k: tr('可提现'), v: formatMoney(i.withdrawable_cents), x: tp('账户余额 {v}', { v: formatMoney(i.balance_cents) }) },
                ]}
              />
              <div className="mt-8">
                <Button asChild variant="outline" className="h-11 px-6"><Link to={R.wallet}><Wallet />{tr('去钱包提现')}</Link></Button>
                {i.reversed_cents > 0 && (
                  <p className="mt-3 text-[12.5px] text-muted-foreground">
                    {tp('另有 {v} 因订单退款被追回。已提现的部分会从余额里扣，余额不够时记为负数，从之后的佣金里抵扣。', { v: formatMoney(i.reversed_cents) })}
                  </p>
                )}
              </div>
            </>
          )}
      </Section>

      <Section title={<><Gift className="size-4 text-brand" />{tr('返佣明细')}</>} desc={i?.commissions.length ? tp('共 {n} 条', { n: i.commissions.length }) : undefined}>
        {!i ? null : i.commissions.length === 0 ? <Empty title="还没有返佣记录" desc="被你邀请的人完成付费后，明细会出现在这里。" />
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-[14px]">
                <thead>
                  <tr className="border-b border-border text-[12.5px] text-muted-foreground">
                    <th className="py-3 text-left font-normal">{tr('日期')}</th>
                    <th className="py-3 text-left font-normal">{tr('被邀请人')}</th>
                    <th className="py-3 text-right font-normal">{tr('订单金额')}</th>
                    <th className="py-3 text-right font-normal">{tr('佣金')}</th>
                    <th className="py-3 pl-6 text-left font-normal">{tr('状态')}</th>
                  </tr>
                </thead>
                <tbody>
                  {i.commissions.map((x) => (
                    <tr key={x.id} className="border-b border-border last:border-b-0">
                      <td className="tnum py-3.5 whitespace-nowrap text-muted-foreground">{formatDate(x.created_at)}</td>
                      <td className="py-3.5 font-mono text-[13px]">{x.invitee_label}</td>
                      <td className="tnum py-3.5 text-right text-muted-foreground">{formatMoney(x.base_cents)}</td>
                      <td className="tnum py-3.5 text-right font-medium">
                        {formatMoney(x.amount_cents)} <span className="text-[12px] font-normal text-muted-foreground">({x.rate_percent}%)</span>
                      </td>
                      <td className="py-3.5 pl-6">
                        <StatusTag {...C_STATUS[x.status]} />
                        {x.status === 'pending' && (
                          <Badge variant="secondary" className="ml-2 rounded-full font-normal">{tp('{d} 入账', { d: formatDate(x.available_at) })}</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Section>
    </>
  );
}
