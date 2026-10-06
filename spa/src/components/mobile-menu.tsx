import { Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import MenuLines from '@/components/menu-lines';
import { AccountHeader, CardLine, MenuRow, MenuSep, PrefsRow, SignOutRow } from '@/components/account-card';
import { CARD, useAccountLine, useIntroOnce, useLinesLabel, type Attention } from '@/lib/account-line';
import { useT } from '@/i18n';

/*
 * 窄屏（< lg）的页头菜单：一个按钮（两根线，见 menu-lines），一张卡片（见 account-card）。
 *
 * 以前这里是头像 + 汉堡两个按钮：头像弹一张桌面式的下拉，汉堡铺一整屏大字，
 * 两边还都有「我的订单 / 设置」。现在合成一个入口、一张卡片，
 * 和桌面上点名字弹出的是同一个组件，只是多了导航。
 *
 * 卡片挂在按钮右下方、离页头底边 8px：按钮 44px 高、居中在页头里，
 * 所以偏移量 = (页头高 − 44) / 2 + 8。
 */
const offsetFor = (headerHeight: number) => (headerHeight - 44) / 2 + 8;

export type MenuLink = { to: string; label: string; icon: LucideIcon; meta?: string; attention?: boolean };

/** 用户中心 */
export function DashMenu({
  groups, active, attention, className,
}: { groups: MenuLink[][]; active: string; attention: Attention; className?: string }) {
  const tr = useT();
  const nav = useNavigate();
  const a = useAccountLine();
  const intro = useIntroOnce(a.value > 0);
  const label = useLinesLabel(attention);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MenuLines value={a.value} tone={a.tone} dot={attention.dot} intro={intro} aria-label={label} className={className} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={offsetFor(64)} collisionPadding={10} className={CARD}>
        <CardLine value={a.value} tone={a.tone} />
        <AccountHeader />
        <MenuSep className="mt-0" />
        {groups.map((g, i) => (
          <Fragment key={i}>
            <div className="p-1.5">
              {g.map((l) => (
                <MenuRow
                  key={l.to} icon={l.icon} label={tr(l.label)} meta={l.meta} attention={l.attention}
                  active={active === l.to} onSelect={() => nav(l.to)}
                />
              ))}
            </div>
            <MenuSep />
          </Fragment>
        ))}
        <PrefsRow />
        <MenuSep className="mb-0" />
        <SignOutRow />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
