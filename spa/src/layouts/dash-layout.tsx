import { lazy, Suspense, useEffect, useMemo, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  BookOpen, CreditCard, Headphones, LayoutDashboard, Megaphone, Settings, Share2, ShoppingBag, TrendingUp, Wallet, Wifi,
} from 'lucide-react';
import { DashMenu, type MenuLink } from '@/components/mobile-menu';
import UserMenu from '@/components/user-menu';
import { useAccountLine, useAttention } from '@/lib/account-line';
import SiteFooter from '@/components/site-footer';
import ErrorBoundary from '@/components/error-boundary';
import { DashSkeleton } from '@/components/loading';
import FrozenOutlet from '@/components/frozen-outlet';
import PageTransition from '@/components/page-transition';
import { LocaleToggle, ThemeToggle } from '@/components/prefs';
import { Logo } from '@/components/logo';
import NavMore, { NavIndicator, type MoreItem } from '@/components/nav-more';
import { useT, useTp } from '@/i18n';
import { prefetchDash, whenIdle } from '@/lib/prefetch';
import { useAuth } from '@/lib/auth';
import { allowed, R } from '@/lib/routes';

/* 登录后的通行密钥引导用到弹窗组件，只有登录答复里带了 passkey_prompt 才加载 */
const PasskeyPrompt = lazy(() => import('@/components/passkey-prompt'));

/**
 * 顶部只留四项加「更多」：低频的收进「更多」。
 * 每一项按账户范围显示（lib/routes 的 PAGE_SCOPES）：过期 / 流量用完的账户看不到节点、流量、邀请，
 * 被封禁的只剩仪表盘（封禁说明）和工单，管理员只有仪表盘（提示去后台地址）。
 */
const PRIMARY = [
  { to: R.dashboard, label: '仪表盘', icon: LayoutDashboard },
  { to: R.shop, label: '商店', icon: ShoppingBag },
  { to: R.help, label: '文档', icon: BookOpen },
  { to: R.invite, label: '邀请', icon: Share2 },
];

/**
 * 折起来的几项 = 目录的后半段。
 * 顺序按「离服务由近到远」：服务在怎么跑（节点、使用明细）→ 站里发生了什么（公告、工单）→ 我的账号（钱包、订单、设置）。
 * meta 那一列是「点进去之前就该知道的数字」。
 */
const MORE = [
  { to: R.nodes, label: '节点状态', desc: '当前可用线路与倍率', icon: Wifi },
  { to: R.traffic, label: '使用明细', desc: '上下行走势与每日用量', icon: TrendingUp },
  /* 公告是喇叭、工单是耳机：和仪表盘顶上那两条提醒用同一个图标 */
  { to: R.announcements, label: '公告与动态', desc: '节点变更与维护计划', icon: Megaphone },
  { to: R.tickets, label: '工单', desc: '提交问题并跟进处理', icon: Headphones },
  { to: R.wallet, label: '钱包', desc: '余额、流水与提现', icon: Wallet },
  { to: R.orders, label: '我的订单', desc: '消费记录与支付状态', icon: CreditCard },
  { to: R.account, label: '设置', desc: '账号、邮箱、密码与通行密钥', icon: Settings },
];

export function DashHeader() {
  const loc = useLocation();
  const tr = useT();
  const tp = useTp();
  const { scope } = useAuth();

  /* 待支付订单、待处理工单、工单的新回复；拉不到就让这些位置空着，不挡路 */
  const att = useAttention(true);
  const navRef = useRef<HTMLElement>(null);
  const line = useAccountLine();
  const usage = line.usage;
  const primary = useMemo(() => PRIMARY.filter((n) => allowed(n.to, scope)), [scope]);
  const moreItems = useMemo(() => MORE.filter((n) => allowed(n.to, scope)), [scope]);

  /* meta 里带单位（笔 / 张 / GB），语序随语言变，所以在组件里用 tp 组装 */
  const meta = useMemo<Record<string, string | undefined>>(() => ({
    [R.traffic]: line.has ? tp('{a} / {b} GB', { a: usage.used.toFixed(1), b: Math.round(usage.total) }) : undefined,
    [R.tickets]: att.openTickets ? tp('{n} 张未关闭', { n: att.openTickets }) : undefined,
    [R.orders]: att.orders ? tp('{n} 笔待支付', { n: att.orders }) : undefined,
  }), [tp, att.openTickets, att.orders, usage.used, usage.total, line.has]);

  const more: MoreItem[] = useMemo(() => moreItems.map((m) => ({ ...m, meta: meta[m.to] })), [meta, moreItems]);

  /* 窄屏卡片：两组，全部带图标；需要你处理的（新回复、待支付）数字前面加一个圆点 */
  const groups: MenuLink[][] = useMemo(() => [
    primary,
    moreItems.map((m) => ({
      ...m,
      meta: meta[m.to],
      attention: (m.to === R.tickets && att.replied > 0) || (m.to === R.orders && att.orders > 0),
    })),
  ].filter((g) => g.length > 0), [primary, moreItems, meta, att.replied, att.orders]);

  /* 底色 95% 不透明，模糊只给一档：sticky 页头上的大半径 backdrop-filter 每次滚动都要重新模糊下面整条内容，是中低端机滚动掉帧的主因 */
  return (
    <header className="sticky top-0 z-30 h-16 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="page-wrap flex h-full items-center gap-8">
        {/* 用户中心里点 logo 回仪表盘 */}
        <Link to={R.dashboard} className="shrink-0"><Logo /></Link>

        <nav ref={navRef} className="relative hidden flex-1 items-center gap-7 lg:flex">
          {primary.map((n) => (
            <Link key={n.to} to={n.to} className="topnav-link" data-active={loc.pathname === n.to}>
              {tr(n.label)}
            </Link>
          ))}
          {more.length > 0 && <NavMore items={more} active={loc.pathname} />}
          <NavIndicator nav={navRef} active={loc.pathname} />
        </nav>
        <div className="flex-1 lg:hidden" />

        {/* 宽屏：明暗、语言、名字（下面一根线）；窄屏：只有一个两根线的按钮，其余都在它弹出的卡片里 */}
        <div className="flex shrink-0 items-center gap-0.5">
          <ThemeToggle className="hidden lg:inline-flex" />
          <LocaleToggle className="hidden lg:flex" />
          <UserMenu attention={att} className="hidden lg:flex" />
          <DashMenu groups={groups} active={loc.pathname} attention={att} className="-mr-2.5 lg:hidden" />
        </div>
      </div>
    </header>
  );
}

export default function DashLayout() {
  const loc = useLocation();
  const { scope, passkeyPrompt } = useAuth();
  useEffect(() => whenIdle(() => prefetchDash(scope)), [scope]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <DashHeader />
      <main className="page-wrap flex-1 pb-14">
        {/* 旧页面淡出 → 回到页首 → 新页面上浮淡入，和站点页同一套，见 PageTransition */}
        <PageTransition id={loc.pathname}>
          <ErrorBoundary>
            <FrozenOutlet fallback={<DashSkeleton />} />
          </ErrorBoundary>
        </PageTransition>
      </main>

      <SiteFooter />
      {passkeyPrompt && <Suspense fallback={null}><PasskeyPrompt /></Suspense>}
    </div>
  );
}
