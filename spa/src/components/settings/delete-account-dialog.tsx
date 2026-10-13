import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FlowDialog, FlowFooter } from '@/components/ui/panels';
import { LoadError, Loading } from '@/components/data-state';
import HolderConfirm from '@/components/holder-confirm';
import { useHolderConfirm } from '@/hooks/use-holder-confirm';
import { accountApi, passkeyApi } from '@/api';
import { isUserCancel } from '@/api/webauthn';
import { useApi, usePending } from '@/hooks/use-api';
import { useAuth } from '@/lib/auth';
import { K } from '@/lib/cache';
import { useErrorText } from '@/lib/errors';
import { fieldOf, useFieldErrors } from '@/lib/form-errors';
import { formatMoney } from '@/lib/format';
import { R } from '@/lib/routes';
import { toast } from '@/lib/toast';
import { useT, useTp } from '@/i18n';

/**
 * 自助注销：删除个人数据；有财务记录的账户匿名化保留（面板 erase.rs）。
 * 先列出会失去什么（`GET /me/delete-impact`）；其中有可提现的钱时单独提醒「先去钱包提现」。
 * 有待支付订单或待审核提现时面板拒绝（409）：这里直接说要先处理哪一样、给出去处的链接，不出现注销按钮（只有「知道了」）。
 * 要确认是本人（当前密码，只用通行密钥的账户用通行密钥，面板校验）并勾选「不可恢复」才能提交；
 * 密码不对时错误画在密码框下面并聚焦它。成功后面板清掉会话，这里退出登录并到结果页。
 */
export default function DeleteAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const nav = useNavigate();
  const { signOut } = useAuth();
  const impact = useApi(() => accountApi.deleteImpact(), [open], { enabled: open });
  const methods = useApi(() => passkeyApi.list(), [], { key: K.passkeys, enabled: open });
  const holder = useHolderConfirm(methods);
  const [ack, setAck] = useState(false);
  const [busy, run] = usePending();
  const f = useFieldErrors(['password', 'ack'] as const);
  f.register('password', 'delete-password');
  f.register('ack', 'delete-ack');

  const close = (o: boolean) => {
    if (busy) return;
    if (!o) { setAck(false); holder.reset(); f.clear(); }
    onOpenChange(o);
  };

  const d = impact.data;
  const blocked = !!d && (d.pending_orders > 0 || d.pending_withdrawals > 0);

  const remove = (e: React.FormEvent) => {
    e.preventDefault();
    if (!d || blocked) return;
    if (!f.check({
      password: holder.mode === 'password' && !holder.password && tr('请输入当前密码'),
      ack: !ack && tr('请先勾选确认'),
    })) return;
    run(async () => {
      try {
        await accountApi.deleteAccount(await holder.proof());
        /* 面板已清掉会话 cookie：先离开受保护的页面，再收尾本地登录态 */
        nav(R.deleted, { replace: true, state: { anonymized: d.anonymized } });
        await signOut().catch(() => {});
      } catch (err) {
        if (isUserCancel(err)) return;
        if (fieldOf(err, { 'account.invalid_password': 'password', 'account.password_required': 'password', 'account.passkey_failed': 'password' } as const)) {
          holder.reset();
          f.set('password', errText(err));
        } else {
          toast.error(errText(err));
          impact.reload();
        }
      }
    });
  };

  const lose: string[] = d ? [
    ...(d.plan ? [tp('套餐「{p}」立即失效，剩余时长作废', { p: d.plan.name })] : []),
    ...(d.balance_cents !== 0 ? [tp('账户余额 {v} 作废，不能再提现', { v: formatMoney(d.balance_cents) })] : []),
    ...(d.pending_commission_cents > 0 ? [tp('{n} 笔还在冻结期的邀请返利（{v}）不再入账', { n: d.pending_commissions, v: formatMoney(d.pending_commission_cents) })] : []),
    ...(d.invitees > 0 ? [tp('你邀请的 {n} 位用户之后的消费不再给你返利', { n: d.invitees })] : []),
    ...(d.unfulfilled_orders > 0 ? [tp('{n} 笔已付款但未开通的订单不再处理', { n: d.unfulfilled_orders })] : []),
    tr('订阅链接、通行密钥、工单、流量明细全部删除，所有设备立即断线'),
    d.anonymized ? tr('账户有付款记录：财务记录匿名保留，其余个人数据删除') : tr('账户会被整个删除'),
  ] : [];

  const go = (to: string) => { close(false); nav(to); };

  return (
    <FlowDialog open={open} onOpenChange={close} tone="danger" icon={<TriangleAlert />} title={tr('注销账户')} description={tr('这是不可恢复的操作，请先看清会失去什么。')}>
      {impact.loading && !d ? <Loading rows={3} />
        : impact.error && !d ? <LoadError error={impact.error} onRetry={impact.reload} />
        : d && (
          <form id="delete-account" noValidate onSubmit={remove} className="space-y-5 pb-2">
            <div role="note" className="rounded-xl bg-muted/60 px-4 py-3.5">
              <div className="text-[13.5px] font-medium">{tr('注销后你将失去')}</div>
              <ul className="mt-2 space-y-1.5 text-[13px] leading-[1.7]">
                {lose.map((l) => (
                  <li key={l} className="flex gap-2.5">
                    <span aria-hidden className="mt-[8px] size-1.5 shrink-0 rounded-full bg-red-500" />
                    <span>{l}</span>
                  </li>
                ))}
              </ul>
            </div>
            {d.withdrawable_cents > 0 && !blocked && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[.07] px-4 py-3 text-[13px] leading-[1.7]">
                <span>{tp('其中 {v} 可以先提现', { v: formatMoney(d.withdrawable_cents) })}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => go(R.walletTab('ledger'))}>{tr('去钱包')}<ArrowRight className="size-3.5" /></Button>
              </div>
            )}
            {blocked ? (
              <ul role="alert" className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[.07] px-4 py-3 text-[13px] leading-[1.7]">
                <li className="font-medium">{tr('还不能注销，请先处理：')}</li>
                {d.pending_orders > 0 && (
                  <li className="flex flex-wrap items-center justify-between gap-2">
                    <span>{tp('还有 {n} 笔待支付订单：请先在订单页取消', { n: d.pending_orders })}</span>
                    <Link to={R.orders} onClick={() => close(false)} className="text-brand underline-offset-4 hover:underline">{tr('去订单页')}</Link>
                  </li>
                )}
                {d.pending_withdrawals > 0 && (
                  <li className="flex flex-wrap items-center justify-between gap-2">
                    <span>{tp('还有 {n} 笔待审核的提现（{v}）：请先在钱包页撤回', { n: d.pending_withdrawals, v: formatMoney(d.pending_withdrawal_cents) })}</span>
                    <Link to={R.walletTab('ledger')} onClick={() => close(false)} className="text-brand underline-offset-4 hover:underline">{tr('去钱包')}</Link>
                  </li>
                )}
              </ul>
            ) : (
              <>
                <HolderConfirm h={holder} id="delete-password" label={tr('输入当前密码确认')} error={f.errors.password} onInput={() => f.dismiss('password')} />
                <label htmlFor="delete-ack" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-1 text-[13px] leading-[1.6]">
                  <Checkbox
                    id="delete-ack" tone="danger" checked={ack}
                    aria-invalid={f.errors.ack ? true : undefined}
                    aria-describedby={f.errors.ack ? 'delete-ack-msg' : undefined}
                    onCheckedChange={(v) => { setAck(v === true); f.dismiss('ack'); }}
                  />
                  <span>{tr('我已了解：注销后账户和上面这些内容都不可恢复')}</span>
                </label>
                {f.errors.ack && <p id="delete-ack-msg" role="alert" className="state-in -mt-3 text-[12.5px] text-danger">{f.errors.ack}</p>}
              </>
            )}
          </form>
        )}
      <FlowFooter>
        {blocked ? (
          <Button onClick={() => close(false)}>{tr('知道了')}</Button>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={() => close(false)}>{tr('取消')}</Button>
            <Button type="submit" form="delete-account" className="bg-red-600 text-white hover:bg-red-700" disabled={busy || !d || !holder.usable}>
              {busy ? tr('注销中') : tr('永久注销')}
            </Button>
          </>
        )}
      </FlowFooter>
    </FlowDialog>
  );
}
