import type { CSSProperties, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, type LucideIcon } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { LocaleSwitch, ThemeSwitch } from '@/components/prefs';
import { useAccountLine } from '@/lib/account-line';
import { useAuth } from '@/lib/auth';
import { R } from '@/lib/routes';
import { toast } from '@/lib/toast';
import { useErrorText } from '@/lib/errors';
import { useT, useTp } from '@/i18n';
import { cn } from '@/lib/utils';

/*
 * 页头弹出的那张卡片：手机上的菜单、桌面上点名字弹出的账号菜单，是同一个东西。
 * 宽 292px，挂在按钮右下方——和原来的账号下拉一样大，不铺满整屏，背后的页面照常看得见。
 * 这里是它的零件：顶边那根线、账号那一行、带图标的行、语言与明暗。
 * 外壳的类名与相关的 hook 在 lib/account-line。
 */

/** 卡片顶边那根细线：就是按钮下面那根线放大后的样子，打开时从左边画到对应的值 */
export function CardLine({ value, tone }: { value: number; tone?: 'warn' }) {
  return (
    <div aria-hidden className="card-line" data-tone={tone} style={{ '--v': `${value}%` } as CSSProperties}>
      <b />
    </div>
  );
}

/** 账号那一行：剩余流量 · 剩余天数，右边「续费」 */
export function AccountHeader() {
  const tr = useT();
  const tp = useTp();
  const nav = useNavigate();
  const a = useAccountLine();
  const sub = [a.email, a.plan, a.has ? tp('共 {n} GB', { n: Math.round(a.usage.total) }) : null].filter(Boolean).join(' · ');

  return (
    <div className="flex items-start justify-between gap-2.5 px-3.5 pt-3 pb-2.5">
      <div className="min-w-0">
        <div className="truncate text-[13px] text-muted-foreground">
          {a.has ? (
            <>
              <b className={cn('tnum mr-[3px] text-[18px] font-medium tracking-[-0.02em]', a.tone ? 'text-[#f59e0b]' : 'text-foreground')}>
                {a.usage.left.toFixed(1)}
              </b>
              {tr('GB 剩余')}
              {/* 不过期的套餐没有「剩余天数」，这时什么都不说 */}
              {a.days !== null && <><span className="mx-1.5 opacity-60">·</span>{tp('还有 {n} 天', { n: a.days })}</>}
            </>
          ) : (
            <b className="text-[14.5px] font-medium text-foreground">{a.plan ?? tr('还没有套餐')}</b>
          )}
        </div>
        <div className="mt-px truncate text-[11.5px] text-muted-foreground">{sub}</div>
      </div>
      <DropdownMenuItem
        onSelect={() => nav(R.shop)}
        className="mt-0.5 shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[13px] font-medium text-brand focus:bg-brand/10 focus:text-brand"
      >
        {a.plan ? tr('续费') : tr('购买')}
      </DropdownMenuItem>
    </div>
  );
}

/** 卡片里的一行：图标、名字，右边可以挂一个实时数字 */
export function MenuRow({
  icon: Icon, label, meta, attention = false, active = false, read = false, strong = false, trailing, variant, onSelect,
}: {
  icon: LucideIcon;
  label: ReactNode;
  meta?: ReactNode;
  /** 需要你处理：数字前面加一个品牌色圆点 */
  attention?: boolean;
  /** 当前页 / 正在读的那一节：铺浅底，图标和文字变蓝 */
  active?: boolean;
  /** 读过的那几节：变灰 */
  read?: boolean;
  strong?: boolean;
  trailing?: ReactNode;
  variant?: 'destructive';
  onSelect?: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      variant={variant}
      data-active={active || undefined}
      className={cn(
        'h-9 cursor-pointer gap-2.5 rounded-[9px] px-2.5 text-[14px]',
        variant !== 'destructive' && '[&_svg]:text-muted-foreground',
        /* 菜单项聚焦（悬停也算）时 shadcn 会把里面的字和图标都改成默认色，当前项要留住蓝色 */
        active && 'bg-muted text-brand focus:text-brand focus:**:text-brand [&_svg]:text-brand',
        read && !active && 'text-muted-foreground',
        strong && 'font-medium',
      )}
    >
      <Icon />
      <span className="min-w-0 truncate">{label}</span>
      {meta && (
        <span className="tnum ml-auto flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-foreground">
          {attention && <i aria-hidden className="size-[5px] rounded-full bg-brand" />}
          {meta}
        </span>
      )}
      {trailing}
    </DropdownMenuItem>
  );
}

export function MenuSep({ className }: { className?: string }) {
  return <DropdownMenuSeparator className={cn('mx-0 my-1', className)} />;
}

/** 语言与明暗：两枚小开关放在一行 */
export function PrefsRow() {
  return (
    <div className="flex items-center gap-2 px-3.5 py-2">
      <LocaleSwitch />
      <ThemeSwitch />
    </div>
  );
}

/**
 * 菜单最底下的「退出登录」：用户菜单与手机菜单共用，退出后回登录页。
 * 面板的退出会结束这个账户的**所有**会话，菜单里写明白，免得以为只退了这一台。
 */
export function SignOutRow() {
  const tr = useT();
  const nav = useNavigate();
  const errText = useErrorText();
  const { signOut } = useAuth();
  const out = () => {
    signOut()
      .then(() => toast.success(tr('已退出'), { description: tr('所有设备上的登录都已结束') }))
      .catch((e) => toast.error(errText(e)))
      .finally(() => nav(R.login, { replace: true }));
  };
  return (
    <div className="p-1.5">
      <MenuRow
        icon={LogOut} variant="destructive" label={tr('退出登录')}
        meta={<span className="font-normal text-muted-foreground">{tr('所有设备')}</span>}
        onSelect={out}
      />
    </div>
  );
}
