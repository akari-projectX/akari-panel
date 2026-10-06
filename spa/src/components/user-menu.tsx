import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ChevronDown, CreditCard, LayoutDashboard, Settings } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AccountHeader, CardLine, MenuRow, MenuSep, SignOutRow } from '@/components/account-card';
import { CARD, useAccountLine, type Attention } from '@/lib/account-line';
import { useT, useTp } from '@/i18n';
import { R } from '@/lib/routes';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * 宽屏右上角的账号入口：你的名字，名字下面一根细线——长度是剩余流量，
 * 和窄屏页头那两根线里下面那根是同一个意思（见 menu-lines）。
 * 点开的卡片和窄屏菜单是同一个组件（见 account-card），只是没有导航：宽屏上导航都摆在顶栏。
 *
 * 账号没有昵称，邮箱 @ 前那段就是这里能显示的「名字」。
 */
export default function UserMenu({
  site = false, onDark = false, attention, className,
}: {
  /** 在落地页等站点页面上：第一项是「进入用户中心」 */
  site?: boolean;
  /** 落地页首屏是深色的，名字和线换成白色 */
  onDark?: boolean;
  attention: Attention | null;
  className?: string;
}) {
  const tr = useT();
  const tp = useTp();
  const nav = useNavigate();
  const a = useAccountLine();
  const name = a.email.split('@')[0] || tr('我的账号');
  const orders = attention?.orders ?? 0;
  const { scope } = useAuth();
  const shop = scope === 'full' || scope === 'renewal';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={tr('账户菜单')}
          data-dark={onDark || undefined}
          data-tone={a.tone}
          style={{ '--v': `${a.value}%` } as CSSProperties}
          className={cn(
            'acct ml-1 flex h-10 cursor-pointer items-center gap-1.5 rounded-full pr-2.5 pl-3.5 text-sm font-medium transition-colors',
            /*
             * 深色首屏上字是白的：悬停、展开都换成半透明白底。
             * 用默认的 bg-muted 在浅色模式下几乎是白的，展开后就成了白底白字。
             */
            onDark ? 'text-slate-200 hover:bg-white/10 hover:text-white data-[state=open]:bg-white/15' : 'hover:bg-muted data-[state=open]:bg-muted',
            className,
          )}
        >
          <span className="acct-name max-w-[140px] truncate">{name}</span>
          {attention?.dot && <span aria-hidden className={cn('size-1 shrink-0 rounded-full', onDark ? 'bg-[#4a9dff]' : 'bg-brand')} />}
          <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className={CARD}>
        <CardLine value={a.value} tone={a.tone} />
        <AccountHeader />
        <MenuSep className="mt-0" />
        <div className="p-1.5">
          {site && (
            <MenuRow
              icon={LayoutDashboard} strong label={tr('进入用户中心')}
              trailing={<ArrowRight className="ml-auto text-brand!" />}
              onSelect={() => nav(R.dashboard)}
            />
          )}
          {shop && (
            <MenuRow
              icon={CreditCard} label={tr('我的订单')} onSelect={() => nav(R.orders)}
              meta={orders > 0 ? tp('{n} 笔待支付', { n: orders }) : undefined} attention={orders > 0}
            />
          )}
          {shop && <MenuRow icon={Settings} label={tr('设置')} onSelect={() => nav(R.account)} />}
        </div>
        <MenuSep className="mb-0" />
        <SignOutRow />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
