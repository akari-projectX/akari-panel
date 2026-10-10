import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import VerifyEmailDialog from '@/components/verify-email-dialog';
import { useAuth } from '@/lib/auth';
import { R } from '@/lib/routes';
import { useT } from '@/i18n';

const NUDGE_KEY = 'akari.verify-nudge';

/**
 * 页面提醒区：每一页都在页面标题下方（PageTitle 自带；没有 PageTitle 的页面在自己的标题下放一个），
 * 账户提醒（`account`，只有仪表盘开）在前，页面自己的提醒（未付订单、工单回复、公告…）在后，同一种样式与间距。
 * 账户提醒只读登录态与 sessionStorage，渲染是同步的：切页时随页面一起过渡，不会先空后出现。
 */
export function PageNotices({ children, account = false }: { children?: ReactNode; account?: boolean }) {
  return (
    <div data-page-notices className="mt-5 flex flex-col gap-3 empty:hidden">
      {account && <AccountBanners />}
      {children}
    </div>
  );
}

/**
 * 账户提醒条，只在仪表盘显示（其他页面不打扰）：
 *   · 续费范围（已过期 / 流量用完）：节点和订阅被面板停了，只剩续费能做——直接给「去续费」；
 *   · 邮箱未验证（中-8）：到期、流量、收据这些邮件只发到已验证的地址。「去验证」就在当前页弹出验证码弹窗；
 *     可以关掉，本次会话不再出现。
 * 封禁和管理员不在这里：仪表盘整页就是说明。
 */
export default function AccountBanners() {
  const tr = useT();
  const nav = useNavigate();
  const { me, scope } = useAuth();
  const [verifying, setVerifying] = useState(false);
  const [hidden, setHidden] = useState(() => {
    try { return sessionStorage.getItem(NUDGE_KEY) === '1'; } catch { return false; }
  });
  if (!me || scope === 'banned') return null;

  const hide = () => {
    setHidden(true);
    try { sessionStorage.setItem(NUDGE_KEY, '1'); } catch { /* 隐私模式 */ }
  };

  return (
    <>
      {scope === 'renewal' && (
        <div role="status" className="notice">
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] font-medium">
              {me.quota_exhausted ? tr('本期流量已用完，服务已暂停') : tr('套餐已到期，服务已暂停')}
            </div>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground">
              {me.quota_exhausted
                ? tr('购买流量重置包或续费后立即恢复；订阅链接和节点在恢复前不可用。')
                : tr('续费后立即恢复；订阅链接和节点在恢复前不可用。')}
            </div>
          </div>
          <Button size="sm" onClick={() => nav(R.shop)}>{me.quota_exhausted ? tr('去恢复') : tr('去续费')}</Button>
        </div>
      )}
      {!me.email_verified && !hidden && (
        <div role="status" className="notice">
          <Mail className="size-4 shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] font-medium">{tr('邮箱还没有验证')}</div>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground">
              {tr('到期提醒、流量提醒和付款收据只发到已验证的邮箱，找回密码也需要它。')}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={hide}>{tr('稍后')}</Button>
            <Button size="sm" variant="outline" onClick={() => setVerifying(true)}>{tr('去验证')}</Button>
          </div>
        </div>
      )}
      {/* 在当前页验证；验证通过后 /me 刷新，这条提醒随之消失 */}
      <VerifyEmailDialog open={verifying} onOpenChange={setVerifying} />
    </>
  );
}
