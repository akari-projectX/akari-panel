import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { R } from '@/lib/routes';
import { useT } from '@/i18n';

const NUDGE_KEY = 'akari.verify-nudge';

/**
 * 用户中心顶上的提醒条，每一页都显示：
 *   · 续费范围（已过期 / 流量用完）：节点和订阅被面板停了，只剩续费能做——直接给「去续费」；
 *   · 邮箱未验证（中-8）：到期、流量、收据这些邮件只发到已验证的地址。可以关掉，本次会话不再出现。
 * 封禁和管理员不在这里：仪表盘整页就是说明。
 */
export default function AccountBanners() {
  const tr = useT();
  const nav = useNavigate();
  const { me, scope } = useAuth();
  const [hidden, setHidden] = useState(() => {
    try { return sessionStorage.getItem(NUDGE_KEY) === '1'; } catch { return false; }
  });
  if (!me || scope === 'banned') return null;

  const hide = () => {
    setHidden(true);
    try { sessionStorage.setItem(NUDGE_KEY, '1'); } catch { /* 隐私模式 */ }
  };

  return (
    <div className="flex flex-col gap-3 pt-5 empty:hidden">
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
            <Button size="sm" variant="outline" onClick={() => nav(`${R.account}#email`)}>{tr('去验证')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
